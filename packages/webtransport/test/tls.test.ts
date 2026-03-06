/**
 * TLS contract tests (P0.3): client caPem/serverName handling and invalid caPem rejection.
 */
import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";
import { generateLocalhostCert } from "./helpers/certs.js";
import { nextPort } from "./helpers/network.js";

const generatedCert = generateLocalhostCert();

process.once("exit", () => {
	generatedCert?.cleanup();
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
});
