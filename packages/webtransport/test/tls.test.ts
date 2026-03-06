/**
 * TLS contract tests (P0.3): client caPem/serverName handling and invalid caPem rejection.
 */
import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";
import {
	generateCertForNames,
	generateLocalhostCert,
} from "./helpers/certs.js";
import { nextPort } from "./helpers/network.js";

const generatedCert = generateLocalhostCert();
const generatedWildcardDefaultCert = generateCertForNames([
	"default.test",
	"127.0.0.1",
]);
const generatedWildcardCert = generateCertForNames(["*.example.test"]);
const generatedWildcardExactCert = generateCertForNames(["api.example.test"]);

process.once("exit", () => {
	generatedCert?.cleanup();
	generatedWildcardDefaultCert?.cleanup();
	generatedWildcardCert?.cleanup();
	generatedWildcardExactCert?.cleanup();
});

async function connectWithRetry(
	url: string,
	opts: Parameters<typeof connect>[1],
	timeoutMs = 6000,
): Promise<Awaited<ReturnType<typeof connect>>> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			return await connect(url, opts);
		} catch (err) {
			lastErr = err;
			await Bun.sleep(100);
		}
	}
	throw lastErr ?? new Error("connectWithRetry: timed out");
}

describe("TLS contract (P0.3)", () => {
	it("connect with serverName override uses host for SNI (connect-path smoke)", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true, serverName: "localhost" },
		});
		try {
			expect(client.id).toBeDefined();
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("connect with serverName and caPem passes strict SNI/cert verification (when certs available)", async () => {
		if (!generatedCert) return;
		const port = nextPort(24460, 2000);

		const server = createServer({
			port,
			tls: { certPem: generatedCert.certPem, keyPem: generatedCert.keyPem },
			onSession: () => {},
		});

		try {
			const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: generatedCert.certPem, serverName: "localhost" },
			});
			expect(client.id).toBeDefined();
			client.close();
		} finally {
			await server.close();
		}
	}, 20000);

	it("connect with caPem accepts option and is used for verification", async () => {
		if (!generatedCert) {
			return;
		}
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: generatedCert.certPem, keyPem: generatedCert.keyPem },
			onSession: () => {},
		});
		try {
			const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: generatedCert.certPem, serverName: "localhost" },
			});
			expect(client.id).toBeDefined();
			client.close();
		} finally {
			await server.close();
		}
	}, 20000);

	it("connect with caPem containing no valid cert rejects with E_TLS", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});

		try {
			await expect(
				connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: {
						caPem: "-----BEGIN NOT-A-CERT-----\nxxx\n-----END NOT-A-CERT-----",
					},
				}),
			).rejects.toThrow(/E_TLS/);
		} finally {
			await server.close();
		}
	}, 15000);

	it("connect with malformed certificate PEM in caPem rejects with invalid CA PEM error", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});

		try {
			await expect(
				connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: {
						caPem:
							"-----BEGIN CERTIFICATE-----\n!!not-base64!!\n-----END CERTIFICATE-----",
					},
				}),
			).rejects.toThrow(/E_TLS: invalid CA PEM/);
		} finally {
			await server.close();
		}
	}, 15000);

	it("connect with parseable-but-invalid certificate in caPem rejects with no accepted certificates error", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});

		try {
			// Valid PEM framing + base64 payload, but payload is not a valid X.509 cert.
			await expect(
				connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: {
						caPem:
							"-----BEGIN CERTIFICATE-----\nAQIDBAUGBwgJCgsMDQ4PEA==\n-----END CERTIFICATE-----",
					},
				}),
			).rejects.toThrow(
				/E_TLS: CA PEM parsed but no certificates were accepted/,
			);
		} finally {
			await server.close();
		}
	}, 15000);

	it("server.updateCert rotates identity and keeps server available", async () => {
		if (!generatedCert) return;
		const port = nextPort(24460, 2000);
		const nextCert = generateLocalhostCert();
		if (!nextCert) {
			throw new Error("failed to generate next certificate");
		}
		let serverSession: any = null;
		let resolveReady!: () => void;
		const ready = new Promise<void>((r) => {
			resolveReady = r;
		});
		const server = createServer({
			port,
			tls: { certPem: generatedCert.certPem, keyPem: generatedCert.keyPem },
			onSession: async (s) => {
				serverSession = s;
				resolveReady();
				const iter = s.incomingDatagrams()[Symbol.asyncIterator]();
				while (true) {
					const next = await Promise.race([
						iter.next(),
						Bun.sleep(5000).then(() => ({ done: true, value: undefined })),
					]);
					if (next.done) break;
					const datagram = next.value;
					if (!datagram) break;
					await s.sendDatagram(datagram);
				}
			},
		});

		try {
			const before = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: generatedCert.certPem, serverName: "localhost" },
			});
			await Promise.race([
				ready,
				Bun.sleep(3000).then(() => {
					throw new Error("timeout waiting for pre-rotation session");
				}),
			]);

			await server.updateCert({
				certPem: nextCert.certPem,
				keyPem: nextCert.keyPem,
			});

			await before.sendDatagram(new Uint8Array([1, 2, 3, 4]));
			const iter = before.incomingDatagrams()[Symbol.asyncIterator]();
			const echoed = await Promise.race([
				iter.next(),
				Bun.sleep(3000).then(() => {
					throw new Error("timeout waiting for echoed datagram after rotation");
				}),
			]);
			expect(echoed.done).toBe(false);
			expect(Array.from(echoed.value ?? [])).toEqual([1, 2, 3, 4]);

			await expect(
				connectWithRetry(
					`https://127.0.0.1:${port}`,
					{
						tls: { caPem: generatedCert.certPem, serverName: "localhost" },
					},
					1500,
				),
			).rejects.toThrow(/(E_TLS|invalid peer certificate|BadSignature)/);

			const after = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: nextCert.certPem, serverName: "localhost" },
			});
			expect(after.id).toBeDefined();
			after.close();
			before.close();
		} finally {
			nextCert.cleanup();
			await server.close();
		}
	}, 25000);

	it("server.updateCert failure leaves current identity and live sessions intact", async () => {
		if (!generatedCert) return;
		const port = nextPort(24460, 2000);
		let resolveReady!: () => void;
		const ready = new Promise<void>((r) => {
			resolveReady = r;
		});
		const server = createServer({
			port,
			tls: {
				certPem: generatedCert.certPem,
				keyPem: generatedCert.keyPem,
			},
			onSession: async (s) => {
				resolveReady();
				const iter = s.incomingDatagrams()[Symbol.asyncIterator]();
				while (true) {
					const next = await Promise.race([
						iter.next(),
						Bun.sleep(5000).then(() => ({ done: true, value: undefined })),
					]);
					if (next.done) break;
					const datagram = next.value;
					if (!datagram) break;
					await s.sendDatagram(datagram);
				}
			},
		});

		try {
			const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: generatedCert.certPem, serverName: "localhost" },
			});
			await Promise.race([
				ready,
				Bun.sleep(3000).then(() => {
					throw new Error("timeout waiting for initial session");
				}),
			]);
			await expect(
				server.updateCert({
					certPem:
						"-----BEGIN CERTIFICATE-----\n!!not-base64!!\n-----END CERTIFICATE-----",
					keyPem:
						"-----BEGIN PRIVATE KEY-----\n!!not-base64!!\n-----END PRIVATE KEY-----",
				}),
			).rejects.toThrow(/E_INTERNAL: certificate rotation failed/);

			await client.sendDatagram(new Uint8Array([7, 8, 9]));
			const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
			const echoed = await Promise.race([
				iter.next(),
				Bun.sleep(3000).then(() => {
					throw new Error(
						"timeout waiting for echoed datagram after failed rotation",
					);
				}),
			]);
			expect(echoed.done).toBe(false);
			expect(Array.from(echoed.value ?? [])).toEqual([7, 8, 9]);

			const after = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: generatedCert.certPem, serverName: "localhost" },
			});
			expect(after.id).toBeDefined();
			after.close();
			client.close();
		} finally {
			await server.close();
		}
	}, 25000);

	it("server.updateCert does not close sessions owned by another server instance", async () => {
		const portA = nextPort(24760, 2000);
		const portB = nextPort(25060, 2000);
		const serverA = createServer({
			port: portA,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});

		let serverBSession: any = null;
		let resolveServerBReady!: () => void;
		const serverBReady = new Promise<void>((r) => {
			resolveServerBReady = r;
		});
		const serverB = createServer({
			port: portB,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				serverBSession = s;
				resolveServerBReady();
				for await (const _ of s.incomingDatagrams()) {
				}
			},
		});

		const clientB = await connectWithRetry(`https://127.0.0.1:${portB}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await Promise.race([
				serverBReady,
				Bun.sleep(2000).then(() => {
					throw new Error("timeout waiting for server B session");
				}),
			]);
			await serverA.updateCert({
				certPem: generatedCert?.certPem ?? "",
				keyPem: generatedCert?.keyPem ?? "",
			});
			await expect(
				serverBSession.sendDatagram(new Uint8Array(64)),
			).resolves.toBe(undefined);
		} finally {
			clientB.close();
			await serverB.close();
			await serverA.close();
		}
	}, 25000);

	it("server selects hostname-specific certificates from tls.sni", async () => {
		const defaultCert = generateCertForNames(["default.test", "127.0.0.1"]);
		const apiCert = generateCertForNames(["api.test"]);
		if (!defaultCert || !apiCert) {
			throw new Error("failed to generate SNI certificates");
		}
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: {
				certPem: defaultCert.certPem,
				keyPem: defaultCert.keyPem,
				sni: [
					{
						serverName: "api.test",
						certPem: apiCert.certPem,
						keyPem: apiCert.keyPem,
					},
				],
			},
			onSession: () => {},
		});
		try {
			const apiClient = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: apiCert.certPem, serverName: "api.test" },
			});
			apiClient.close();
			const metrics = server.metricsSnapshot();
			expect(metrics.sniCertSelections).toBeGreaterThanOrEqual(1);
		} finally {
			await server.close();
			apiCert.cleanup();
			defaultCert.cleanup();
		}
	}, 20000);

	it("wildcard SNI matches a single subdomain label and exact hostnames take precedence", async () => {
		const defaultCert = generatedWildcardDefaultCert;
		const wildcardCert = generatedWildcardCert;
		const exactCert = generatedWildcardExactCert;
		if (!defaultCert || !wildcardCert || !exactCert) {
			throw new Error("failed to generate wildcard certificates");
		}
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: {
				certPem: defaultCert.certPem,
				keyPem: defaultCert.keyPem,
				sni: [
					{
						serverName: "*.example.test",
						certPem: wildcardCert.certPem,
						keyPem: wildcardCert.keyPem,
					},
					{
						serverName: "api.example.test",
						certPem: exactCert.certPem,
						keyPem: exactCert.keyPem,
					},
				],
			},
			onSession: () => {},
		});
		try {
			const wildcardClient = await connectWithRetry(
				`https://127.0.0.1:${port}`,
				{
					tls: {
						caPem: wildcardCert.certPem,
						serverName: "www.example.test",
					},
				},
			);
			wildcardClient.close();

			const exactClient = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: {
					caPem: exactCert.certPem,
					serverName: "api.example.test",
				},
			});
			exactClient.close();

			await expect(
				connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: {
						caPem: wildcardCert.certPem,
						serverName: "api.dev.example.test",
					},
				}),
			).rejects.toThrow(/E_TLS|certificate|peer/i);
		} finally {
			await server.close();
		}
	}, 25000);

	it("rejects invalid wildcard server names in tls.sni", () => {
		if (!generatedCert) return;
		expect(() =>
			createServer({
				port: nextPort(24460, 2000),
				tls: {
					certPem: generatedCert.certPem,
					keyPem: generatedCert.keyPem,
					sni: [
						{
							serverName: "api.*.example.test",
							certPem: generatedCert.certPem,
							keyPem: generatedCert.keyPem,
						},
					],
				},
				onSession: () => {},
			}),
		).toThrow(/E_TLS: .*wildcard serverName/);
	});

	it("rejects duplicate SNI names after normalization with both original inputs in the error", () => {
		if (!generatedCert) return;
		expect(() =>
			createServer({
				port: nextPort(24460, 2000),
				tls: {
					certPem: generatedCert.certPem,
					keyPem: generatedCert.keyPem,
					sni: [
						{
							serverName: "bücher.example.test",
							certPem: generatedCert.certPem,
							keyPem: generatedCert.keyPem,
						},
						{
							serverName: "xn--bcher-kva.example.test",
							certPem: generatedCert.certPem,
							keyPem: generatedCert.keyPem,
						},
					],
				},
				onSession: () => {},
			}),
		).toThrow(
			/E_TLS: .*duplicate serverName entry after normalization: "xn--bcher-kva\.example\.test" conflicts with "bücher\.example\.test" as "xn--bcher-kva\.example\.test"/,
		);
	});

	it("unknown SNI rejects by default", async () => {
		const defaultCert = generateCertForNames(["default.test", "127.0.0.1"]);
		const apiCert = generateCertForNames(["api.test"]);
		const unknownCert = generateCertForNames(["unknown.test"]);
		if (!defaultCert || !apiCert || !unknownCert) {
			throw new Error("failed to generate certificates");
		}
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: {
				certPem: defaultCert.certPem,
				keyPem: defaultCert.keyPem,
				sni: [
					{
						serverName: "api.test",
						certPem: apiCert.certPem,
						keyPem: apiCert.keyPem,
					},
				],
			},
			onSession: () => {},
		});
		try {
			await expect(
				connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { caPem: unknownCert.certPem, serverName: "unknown.test" },
				}),
			).rejects.toThrow(/E_TLS|certificate|peer/i);
			const metrics = server.metricsSnapshot();
			expect(metrics.unknownSniRejectedCount).toBeGreaterThanOrEqual(1);
		} finally {
			await server.close();
			apiCert.cleanup();
			unknownCert.cleanup();
			defaultCert.cleanup();
		}
	}, 20000);

	it("unknown SNI can fall back to the default certificate", async () => {
		const defaultCert = generateCertForNames([
			"fallback.test",
			"unmatched.test",
			"127.0.0.1",
		]);
		if (!defaultCert) {
			throw new Error("failed to generate fallback certificate");
		}
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: {
				certPem: defaultCert.certPem,
				keyPem: defaultCert.keyPem,
				unknownSniPolicy: "default",
			},
			onSession: () => {},
		});
		try {
			const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: defaultCert.certPem, serverName: "unmatched.test" },
			});
			client.close();
			const metrics = server.metricsSnapshot();
			expect(metrics.defaultCertSelections).toBeGreaterThanOrEqual(1);
		} finally {
			await server.close();
			defaultCert.cleanup();
		}
	}, 20000);

	it("incremental SNI TLS management supports upsert, replace, remove, policy updates, and snapshots", async () => {
		const defaultCert = generateCertForNames([
			"default.test",
			"unmatched.test",
			"127.0.0.1",
		]);
		const apiOne = generateCertForNames(["api.one.test"]);
		const apiOneNext = generateCertForNames(["api.one.test"]);
		const apiTwo = generateCertForNames(["api.two.test"]);
		if (!defaultCert || !apiOne || !apiOneNext || !apiTwo) {
			throw new Error("failed to generate incremental SNI certificates");
		}
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: {
				certPem: defaultCert.certPem,
				keyPem: defaultCert.keyPem,
			},
			onSession: () => {},
		});
		try {
			expect(server.tlsSnapshot()).toEqual({
				sniServerNames: [],
				unknownSniPolicy: "reject",
			});

			await server.upsertSniCert({
				serverName: "API.ONE.TEST",
				certPem: apiOne.certPem,
				keyPem: apiOne.keyPem,
			});
			expect(server.tlsSnapshot()).toEqual({
				sniServerNames: ["api.one.test"],
				unknownSniPolicy: "reject",
			});

			const first = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: apiOne.certPem, serverName: "api.one.test" },
			});
			first.close();

			await server.upsertSniCert({
				serverName: "api.one.test",
				certPem: apiOneNext.certPem,
				keyPem: apiOneNext.keyPem,
			});

			await expect(
				connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { caPem: apiOne.certPem, serverName: "api.one.test" },
				}),
			).rejects.toThrow(/E_TLS|certificate|peer/i);

			const updated = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: apiOneNext.certPem, serverName: "api.one.test" },
			});
			updated.close();

			await server.setUnknownSniPolicy("default");
			expect(server.tlsSnapshot()).toEqual({
				sniServerNames: ["api.one.test"],
				unknownSniPolicy: "default",
			});

			const fallback = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: defaultCert.certPem, serverName: "unmatched.test" },
			});
			fallback.close();

			await server.replaceSniCerts([
				{
					serverName: "api.two.test",
					certPem: apiTwo.certPem,
					keyPem: apiTwo.keyPem,
				},
			]);
			expect(server.tlsSnapshot()).toEqual({
				sniServerNames: ["api.two.test"],
				unknownSniPolicy: "default",
			});

			await expect(
				connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { caPem: apiOneNext.certPem, serverName: "api.one.test" },
				}),
			).rejects.toThrow(/E_TLS|certificate|peer/i);

			const second = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: apiTwo.certPem, serverName: "api.two.test" },
			});
			second.close();

			await server.removeSniCert("api.two.test");
			expect(server.tlsSnapshot()).toEqual({
				sniServerNames: [],
				unknownSniPolicy: "default",
			});

			await expect(server.removeSniCert("api.two.test")).rejects.toThrow(
				/E_INTERNAL: tls rotation failed: unknown serverName entry/,
			);

			const postRemovalFallback = await connectWithRetry(
				`https://127.0.0.1:${port}`,
				{
					tls: { caPem: defaultCert.certPem, serverName: "unmatched.test" },
				},
			);
			postRemovalFallback.close();

			const metrics = server.metricsSnapshot();
			expect(metrics.sniCertSelections).toBeGreaterThanOrEqual(3);
			expect(metrics.defaultCertSelections).toBeGreaterThanOrEqual(2);
		} finally {
			await server.close();
			defaultCert.cleanup();
			apiOne.cleanup();
			apiOneNext.cleanup();
			apiTwo.cleanup();
		}
	}, 30000);

	it("incremental SNI APIs reject the dev self-signed fallback until a default cert is installed", async () => {
		const apiCert = generateCertForNames(["api.dev.test"]);
		if (!apiCert) {
			throw new Error("failed to generate dev SNI certificate");
		}
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			await expect(
				server.upsertSniCert({
					serverName: "api.dev.test",
					certPem: apiCert.certPem,
					keyPem: apiCert.keyPem,
				}),
			).rejects.toThrow(
				/E_INTERNAL: tls rotation failed: SNI management requires a non-empty default certPem\/keyPem/,
			);
			await expect(server.setUnknownSniPolicy("default")).rejects.toThrow(
				/E_INTERNAL: tls rotation failed: SNI management requires a non-empty default certPem\/keyPem/,
			);
			await expect(server.replaceSniCerts([])).rejects.toThrow(
				/E_INTERNAL: tls rotation failed: SNI management requires a non-empty default certPem\/keyPem/,
			);
		} finally {
			await server.close();
			apiCert.cleanup();
		}
	}, 20000);

	it("replaceSniCerts rejects duplicate normalized names with both original inputs in the error", async () => {
		if (!generatedCert) return;
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: {
				certPem: generatedCert.certPem,
				keyPem: generatedCert.keyPem,
			},
			onSession: () => {},
		});
		try {
			await expect(
				server.replaceSniCerts([
					{
						serverName: "bücher.example.test",
						certPem: generatedCert.certPem,
						keyPem: generatedCert.keyPem,
					},
					{
						serverName: "xn--bcher-kva.example.test",
						certPem: generatedCert.certPem,
						keyPem: generatedCert.keyPem,
					},
				]),
			).rejects.toThrow(
				/E_INTERNAL: tls rotation failed: duplicate serverName entry after normalization: "xn--bcher-kva\.example\.test" conflicts with "bücher\.example\.test" as "xn--bcher-kva\.example\.test"/,
			);
		} finally {
			await server.close();
		}
	}, 20000);

	it("server.updateTls atomically replaces SNI certificates and unknown-SNI policy", async () => {
		const initialDefault = generateCertForNames(["initial.test", "127.0.0.1"]);
		const initialApi = generateCertForNames(["api.initial.test"]);
		const nextDefault = generateCertForNames([
			"next.test",
			"unmatched.test",
			"127.0.0.1",
		]);
		const nextApi = generateCertForNames(["api.next.test"]);
		if (!initialDefault || !initialApi || !nextDefault || !nextApi) {
			throw new Error("failed to generate updateTls certificates");
		}
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: {
				certPem: initialDefault.certPem,
				keyPem: initialDefault.keyPem,
				sni: [
					{
						serverName: "api.initial.test",
						certPem: initialApi.certPem,
						keyPem: initialApi.keyPem,
					},
				],
			},
			onSession: () => {},
		});
		try {
			const before = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: initialApi.certPem, serverName: "api.initial.test" },
			});
			before.close();
			await server.updateTls({
				certPem: nextDefault.certPem,
				keyPem: nextDefault.keyPem,
				unknownSniPolicy: "default",
				sni: [
					{
						serverName: "api.next.test",
						certPem: nextApi.certPem,
						keyPem: nextApi.keyPem,
					},
				],
			});
			const after = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: nextApi.certPem, serverName: "api.next.test" },
			});
			after.close();
			const fallback = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { caPem: nextDefault.certPem, serverName: "unmatched.test" },
			});
			fallback.close();
			await expect(
				connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { caPem: initialApi.certPem, serverName: "api.initial.test" },
				}),
			).rejects.toThrow(/E_TLS|certificate|peer/i);
		} finally {
			await server.close();
			initialDefault.cleanup();
			initialApi.cleanup();
			nextDefault.cleanup();
			nextApi.cleanup();
		}
	}, 30000);
});
