import { describe, expect, test } from "bun:test";
import { connectWasm } from "../src/backend.js";
import { BunUdpTransport } from "../src/bun-udp.js";
import { DirectSocketsUdpTransport } from "../src/direct-sockets.js";
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

	test("rejects out-of-range ports", async () => {
		const relay = new InMemoryRelay();
		for (const port of [-1, 65536, 1.5]) {
			await expect(
				createServer({
					port,
					tls: { allowSelfSigned: true },
					wasm: wasmAvailable ? wasm : ({} as never),
					bind: async () => relay.a,
					onSession: () => {},
				}),
			).rejects.toThrow(/port must be an integer|E_INVALID_ARGUMENT/);
		}
	});

	test("port 0 without a transport-reported localPort fails loudly", async () => {
		const relay = new InMemoryRelay();
		await expect(
			createServer({
				port: 0,
				tls: { allowSelfSigned: true },
				wasm: wasmAvailable ? wasm : ({} as never),
				// InMemoryRelay endpoints do not report a bound port.
				bind: async () => relay.a,
				onSession: () => {},
			}),
		).rejects.toThrow(/did not report a bound localPort/);
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
		"port 0 over Bun UDP: address.port is the real bound port and serves traffic",
		async () => {
			const server = await createServer({
				host: "127.0.0.1",
				port: 0,
				tls: { allowSelfSigned: true, commonName: "localhost" },
				wasm,
				bind: (host, port) => BunUdpTransport.bind(host, port),
				onSession: (session) => {
					session.onDatagram((d) => {
						void session.sendDatagram(d);
					});
				},
			});

			expect(server.address.port).toBeGreaterThan(0);
			expect(server.address.port).toBeLessThanOrEqual(65535);

			const clientUdp = await BunUdpTransport.connect(
				"127.0.0.1",
				server.address.port,
			);
			const { session: client, manager: clientMgr } = await connectWasm(
				wasm,
				clientUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${server.address.port}`,
				{ certHashBase64: server.certHashBase64 },
			);

			let dgram: Uint8Array | null = null;
			client.onDatagram((d) => {
				dgram = d.slice();
			});
			await client.sendDatagram(new TextEncoder().encode("ephemeral"));

			await withTimeout(
				(async () => {
					while (dgram === null) await Bun.sleep(5);
				})(),
				5000,
				"ephemeral-port datagram echo",
			);
			expect(new TextDecoder().decode(dgram as unknown as Uint8Array)).toBe(
				"ephemeral",
			);

			clientMgr.close();
			clientUdp.close();
			await server.close();
		},
	);

	test("Direct Sockets bind(0) omits localPort and surfaces openInfo.localPort", async () => {
		const seen: Array<Record<string, unknown>> = [];
		const prior = (globalThis as { UDPSocket?: unknown }).UDPSocket;
		// Mirrors WICG semantics: an explicit localPort of 0 is a TypeError, and
		// omitting it lets the OS pick a port reported on `opened`.
		(globalThis as { UDPSocket?: unknown }).UDPSocket = class {
			opened: Promise<{
				readable: ReadableStream<never>;
				writable: WritableStream<never>;
				localAddress?: string;
				localPort?: number;
			}>;
			constructor(options: Record<string, unknown>) {
				seen.push(options);
				if (options.localPort === 0) {
					throw new TypeError("localPort must be greater than zero");
				}
				this.opened = Promise.resolve({
					readable: new ReadableStream<never>(),
					writable: new WritableStream<never>(),
					localAddress: "127.0.0.1",
					localPort: options.localPort === undefined ? 51234 : 4433,
				});
			}
			async close(): Promise<void> {}
		};
		try {
			const ephemeral = await DirectSocketsUdpTransport.bind("127.0.0.1", 0);
			expect(seen.at(-1)).toEqual({ localAddress: "127.0.0.1" });
			expect(ephemeral.localPort).toBe(51234);
			await ephemeral.close();

			const fixed = await DirectSocketsUdpTransport.bind("127.0.0.1", 4433);
			expect(seen.at(-1)).toEqual({
				localAddress: "127.0.0.1",
				localPort: 4433,
			});
			expect(fixed.localPort).toBe(4433);
			await fixed.close();
		} finally {
			if (prior === undefined)
				(globalThis as { UDPSocket?: unknown }).UDPSocket = undefined;
			else (globalThis as { UDPSocket?: unknown }).UDPSocket = prior;
		}
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

	test.skipIf(!wasmAvailable)(
		"SNI upsert/remove edit the map incrementally while traffic flows",
		async () => {
			const gen = (cn: string) =>
				JSON.parse(
					wasm.wt_generate_cert(cn, 14, Math.floor(Date.now() / 1000) - 3600),
				) as { certPem: string; keyPem: string; hashBase64: string };

			const server = await createServer({
				host: "127.0.0.1",
				port: 0,
				tls: {
					allowSelfSigned: true,
					commonName: "localhost",
					sni: (() => {
						const seed = gen("seed.example");
						return [
							{
								serverName: "seed.example",
								certPem: seed.certPem,
								keyPem: seed.keyPem,
							},
						];
					})(),
					unknownSniPolicy: "default",
				},
				wasm,
				bind: (host, port) => BunUdpTransport.bind(host, port),
				onSession: (session) => {
					session.onDatagram((d) => {
						void session.sendDatagram(d);
					});
				},
			});
			const pinnedHash = server.certHashBase64;

			const clientUdp = await BunUdpTransport.connect(
				"127.0.0.1",
				server.address.port,
			);
			const { session: client, manager: clientMgr } = await connectWasm(
				wasm,
				clientUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${server.address.port}`,
				{ certHashBase64: pinnedHash },
			);

			let echoes = 0;
			client.onDatagram(() => {
				echoes += 1;
			});

			const SENDS = 40;
			const traffic = (async () => {
				for (let n = 0; n < SENDS; n++) {
					await client.sendDatagram(new TextEncoder().encode(`load-${n}`));
					await Bun.sleep(2);
				}
			})();

			// Rotate the SNI map incrementally while the echo loop is mid-flight;
			// the sleeps keep the edits genuinely interleaved with the traffic
			// rather than collapsing into one microtask drain.
			const rotation = (async () => {
				for (const name of ["a.example", "b.example", "c.example"]) {
					const cert = gen(name);
					await server.upsertSniCert({
						serverName: name,
						certPem: cert.certPem,
						keyPem: cert.keyPem,
					});
					await Bun.sleep(10);
				}
			})();

			await Promise.all([traffic, rotation]);
			expect(server.tlsSnapshot().sniNames).toEqual([
				"seed.example",
				"a.example",
				"b.example",
				"c.example",
			]);

			// Re-upserting replaces in place rather than appending a duplicate.
			const replacement = gen("b.example");
			await server.upsertSniCert({
				serverName: "B.Example",
				certPem: replacement.certPem,
				keyPem: replacement.keyPem,
			});
			expect(server.tlsSnapshot().sniNames).toEqual([
				"seed.example",
				"a.example",
				"b.example",
				"c.example",
			]);

			await server.removeSniCert("a.example");
			await server.removeSniCert("never-added.example"); // no-op
			expect(server.tlsSnapshot().sniNames).toEqual([
				"seed.example",
				"b.example",
				"c.example",
			]);

			// None of the SNI edits disturbed the default cert clients pinned.
			expect(server.certHashBase64).toBe(pinnedHash);

			// The session kept echoing throughout the rotation.
			await withTimeout(
				(async () => {
					while (echoes < SENDS) await Bun.sleep(5);
				})(),
				5000,
				"echo traffic across SNI rotation",
			);

			// ...and still echoes once the rotation has settled.
			const before = echoes;
			await client.sendDatagram(new TextEncoder().encode("post-rotation"));
			await withTimeout(
				(async () => {
					while (echoes <= before) await Bun.sleep(5);
				})(),
				5000,
				"post-rotation echo",
			);

			clientMgr.close();
			clientUdp.close();
			await server.close();
		},
		// Generates four P-256 certs in wasm on top of a live handshake.
		20_000,
	);

	test.skipIf(!wasmAvailable)(
		"invalid SNI edits fail closed and leave the live map untouched",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4437 };
			const seed = JSON.parse(
				wasm.wt_generate_cert(
					"keep.example",
					14,
					Math.floor(Date.now() / 1000) - 3600,
				),
			) as { certPem: string; keyPem: string };

			const server = await createServer({
				host: "127.0.0.1",
				port: 4437,
				tls: {
					allowSelfSigned: true,
					sni: [
						{
							serverName: "keep.example",
							certPem: seed.certPem,
							keyPem: seed.keyPem,
						},
					],
				},
				wasm,
				bind: async () => relay.endpoint(serverAddr),
				onSession: () => {},
			});

			await expect(
				server.upsertSniCert({
					serverName: "bad.example",
					certPem: "not-a-cert",
					keyPem: "not-a-key",
				}),
			).rejects.toThrow(/E_TLS/);
			expect(server.tlsSnapshot().sniNames).toEqual(["keep.example"]);

			await expect(
				server.updateTls({
					sniRemove: ["keep.example"],
					sniUpsert: [
						{
							serverName: "also-bad.example",
							certPem: "nope",
							keyPem: "nope",
						},
					],
				}),
			).rejects.toThrow(/E_TLS/);
			// The batch was rejected wholesale — the removal did not land either.
			expect(server.tlsSnapshot().sniNames).toEqual(["keep.example"]);

			await server.close();
		},
	);
});
