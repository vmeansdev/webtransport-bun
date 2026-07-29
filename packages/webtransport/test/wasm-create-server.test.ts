import { describe, expect, test } from "bun:test";
import { connectWasm } from "../src/backend.js";
import { createServer, createIwaServer } from "../src/wasm-create-server.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";
import { withTimeout } from "./helpers/harness.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

describe("wasm createServer plug-and-play", () => {
	test("rejects without UDPSocket when bind is not injected", async () => {
		await expect(
			createServer({
				port: 4433,
				tls: { allowSelfSigned: true },
				wasm: wasmAvailable ? wasm : ({} as never),
				onSession: () => {},
			}),
		).rejects.toThrow(/UDPSocket unavailable|E_UNSUPPORTED_ARGUMENT/);
	});

	test("rejects port 0", async () => {
		const relay = new InMemoryRelay();
		await expect(
			createServer({
				port: 0,
				tls: { allowSelfSigned: true },
				wasm: wasmAvailable ? wasm : ({} as never),
				bind: async () => relay.a,
				onSession: () => {},
			}),
		).rejects.toThrow(/port must be an integer|E_INVALID_ARGUMENT/);
	});

	test("rejects empty PEM without allowSelfSigned", async () => {
		const relay = new InMemoryRelay();
		await expect(
			createServer({
				port: 4433,
				tls: {},
				wasm: wasmAvailable ? wasm : ({} as never),
				bind: async () => relay.a,
				onSession: () => {},
			}),
		).rejects.toThrow(/certPem\/keyPem required|E_TLS/);
	});

	test("createIwaServer is an alias of createServer", () => {
		expect(createIwaServer).toBe(createServer);
	});

	test.skipIf(!wasmAvailable)(
		"injectable bind: datagram echo + live certHashBase64",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4433 };
			const clientAddr = { address: "127.0.0.1", port: 5544 };

			const server = await createServer({
				host: "127.0.0.1",
				port: 4433,
				tls: { allowSelfSigned: true, commonName: "localhost" },
				wasm,
				bind: async () => relay.endpoint(serverAddr),
				onSession: (session) => {
					session.onDatagram((d) => {
						void session.sendDatagram(d);
					});
				},
			});

			expect(server.certHashBase64.length).toBeGreaterThan(10);
			expect(server.address).toEqual({ host: "127.0.0.1", port: 4433 });
			expect(server.tlsSnapshot().defaultCertHashBase64).toBe(
				server.certHashBase64,
			);

			const { session: client, manager: clientMgr } = await connectWasm(
				wasm,
				relay.endpoint(clientAddr),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				{ certHashBase64: server.certHashBase64 },
			);

			let dgram: Uint8Array | null = null;
			client.onDatagram((d) => {
				dgram = d.slice();
			});
			await client.sendDatagram(new TextEncoder().encode("pnp-dg"));

			await withTimeout(
				(async () => {
					while (dgram === null) await Bun.sleep(5);
				})(),
				3000,
				"datagram echo",
			);

			expect(new TextDecoder().decode(dgram as unknown as Uint8Array)).toBe(
				"pnp-dg",
			);

			clientMgr.close();
			await server.close();
			await server.close(); // idempotent
		},
	);

	test.skipIf(!wasmAvailable)(
		"PEM path: atomic cert at construction; hash matches tlsSnapshot",
		async () => {
			const generated = JSON.parse(
				wasm.wt_generate_cert(
					"pnp.example",
					14,
					Math.floor(Date.now() / 1000) - 3600,
				),
			) as {
				certPem: string;
				keyPem: string;
				hashBase64: string;
				error?: string;
			};
			expect(generated.error).toBeUndefined();

			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4435 };

			const server = await createServer({
				host: "127.0.0.1",
				port: 4435,
				tls: {
					certPem: generated.certPem,
					keyPem: generated.keyPem,
				},
				wasm,
				bind: async () => relay.endpoint(serverAddr),
				onSession: () => {},
			});

			expect(server.certHashBase64).toBe(generated.hashBase64);
			expect(server.tlsSnapshot().defaultCertHashBase64).toBe(
				generated.hashBase64,
			);

			const rotated = JSON.parse(
				wasm.wt_generate_cert(
					"rotated.example",
					14,
					Math.floor(Date.now() / 1000) - 3600,
				),
			) as { certPem: string; keyPem: string; hashBase64: string };

			await server.updateCert({
				certPem: rotated.certPem,
				keyPem: rotated.keyPem,
			});
			expect(server.certHashBase64).toBe(rotated.hashBase64);

			await server.close();
		},
	);
});
