import { describe, expect, test, beforeEach } from "bun:test";
import {
	chmodSync,
	mkdtempSync,
	lstatSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__resetWasmClientPoolForTests,
	connectWasm,
	createWasmServer,
	FileTicketStoreHost,
	MemoryTicketStoreHost,
	normalizeWasmEndpointOptions,
	toWasmServerSession,
	wasmClientPoolMetricsSnapshot,
} from "../src/backend.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";
import { wasmCaFingerprint, wasmPoolKey } from "../src/wasm-endpoint-pool.js";

// Soft-skip when pkg is absent (local `bun test packages/`). With
// WEBTRANSPORT_REQUIRE_WASM=1 the helper throws at import time instead.
const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

describe("wasm parity epic helpers", () => {
	beforeEach(() => {
		__resetWasmClientPoolForTests();
	});

	test("MemoryTicketStoreHost take-once", async () => {
		const store = new MemoryTicketStoreHost();
		await store.put("a", new Uint8Array([1, 2, 3]));
		const once = await store.take("a");
		expect(once).toEqual(new Uint8Array([1, 2, 3]));
		expect(await store.take("a")).toBeNull();
	});

	test("FileTicketStoreHost round-trip", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wt-tickets-"));
		try {
			const store = new FileTicketStoreHost(dir);
			await store.put("auth", new Uint8Array([9, 8, 7]));
			expect(await store.get("auth")).toEqual(new Uint8Array([9, 8, 7]));
			expect(await store.take("auth")).toEqual(new Uint8Array([9, 8, 7]));
			expect(await store.get("auth")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("FileTicketStoreHost protects POSIX permissions and rejects symlinks", async () => {
		if (process.platform === "win32") return;
		const parent = mkdtempSync(join(tmpdir(), "wt-tickets-parent-"));
		const dir = join(parent, "private");
		const previousUmask = process.umask(0);
		try {
			const store = new FileTicketStoreHost(dir);
			expect(lstatSync(dir).mode & 0o777).toBe(0o700);
			await store.put("secure", new Uint8Array([1, 2, 3]));
			const ticketPath = join(dir, "c2VjdXJl.ticket");
			expect(lstatSync(ticketPath).mode & 0o777).toBe(0o600);

			chmodSync(ticketPath, 0o644);
			await expect(store.get("secure")).resolves.toEqual(
				new Uint8Array([1, 2, 3]),
			);
			expect(lstatSync(ticketPath).mode & 0o777).toBe(0o600);

			const target = join(dir, "target");
			await Bun.write(target, new Uint8Array([9]));
			const symlinkKey = "symlink";
			try {
				symlinkSync(
					target,
					join(
						dir,
						`${Buffer.from(symlinkKey, "utf8").toString("base64url")}.ticket`,
					),
				);
			} catch {
				return;
			}
			await expect(store.get(symlinkKey)).rejects.toThrow(/symlink/i);
		} finally {
			process.umask(previousUmask);
			rmSync(parent, { recursive: true, force: true });
		}
	});

	test("wasm pool metrics start empty", () => {
		const snap = wasmClientPoolMetricsSnapshot();
		expect(snap.size).toBe(0);
		expect(snap.hits + snap.misses).toBe(0);
	});

	test("wasm pool identities include exact TLS trust material", async () => {
		const base = {
			scheme: "https",
			host: "example.test",
			port: 443,
			serverName: "example.test",
		};
		const caA = await wasmCaFingerprint("ca-a");
		const caB = await wasmCaFingerprint("ca-b");
		expect(wasmPoolKey({ ...base, tlsFingerprint: `ca:${caA}` })).toBe(
			wasmPoolKey({ ...base, tlsFingerprint: `ca:${caA}` }),
		);
		expect(wasmPoolKey({ ...base, tlsFingerprint: `ca:${caA}` })).not.toBe(
			wasmPoolKey({ ...base, tlsFingerprint: `ca:${caB}` }),
		);
		expect(wasmPoolKey({ ...base, tlsFingerprint: "accept-any" })).not.toBe(
			wasmPoolKey({ ...base, tlsFingerprint: "cert:hash" }),
		);
		expect(wasmPoolKey({ ...base, tlsFingerprint: "accept-any" })).not.toBe(
			wasmPoolKey({ ...base, tlsFingerprint: `ca:${caA}` }),
		);
	});

	test("toWasmServerSession wraps session shape", () => {
		const fake = {
			ready: Promise.resolve(),
			closed: Promise.resolve({ code: 0, reason: "" }),
			maxDatagramSize: 1200,
			sessionId: 1n,
			sendDatagram: async () => {},
			onDatagram: () => {},
			createBidirectionalStream: () => ({}),
			createUnidirectionalStream: () => ({}),
			onIncomingStream: () => {},
			connectionStats: () => ({
				bytesSent: 1,
				bytesReceived: 2,
				packetsSent: 1,
				packetsReceived: 1,
				datagrams: {
					droppedIncoming: 0,
					expiredIncoming: 0,
					expiredOutgoing: 0,
					lostOutgoing: 0,
				},
			}),
			metricsSnapshot: () => ({
				datagramsIn: 4,
				datagramsOut: 5,
				streamsActive: 2,
				queuedBytes: 3,
			}),
			close: () => {},
		};
		const ss = toWasmServerSession(fake as never);
		expect(ss.maxDatagramSize).toBe(1200);
		expect(ss.metricsSnapshot()).toEqual({
			datagramsIn: 4,
			datagramsOut: 5,
			streamsActive: 2,
			queuedBytes: 3,
		});
		expect(ss.unwrap()).toBe(fake as never);
	});

	test.skipIf(!wasmAvailable)(
		"allowPooling reuses the endpoint manager across compatible connects",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4801 };
			const client1Addr = { address: "127.0.0.1", port: 5801 };
			const client2Addr = { address: "127.0.0.1", port: 5802 };
			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				() => {},
				"127.0.0.1:4801",
				"127.0.0.1:5801",
				normalizeWasmEndpointOptions({}),
			);
			try {
				expect(wasmClientPoolMetricsSnapshot()).toEqual({
					hits: 0,
					misses: 0,
					evictions: 0,
					size: 0,
				});

				const first = await connectWasm(
					wasm,
					relay.endpoint(client1Addr),
					"pool.example",
					"127.0.0.1:5801",
					"127.0.0.1:4801",
					{ allowPooling: true },
				);
				const afterFirst = wasmClientPoolMetricsSnapshot();
				expect(afterFirst).toEqual({
					hits: 0,
					misses: 1,
					evictions: 0,
					size: 1,
				});

				// Same scheme/host/port/SNI/mode: a second connect should hit the
				// pool and reuse `first.manager`'s endpoint instead of opening a
				// fresh UDP transport.
				const second = await connectWasm(
					wasm,
					relay.endpoint(client2Addr),
					"pool.example",
					"127.0.0.1:5801",
					"127.0.0.1:4801",
					{ allowPooling: true },
				);
				const afterSecond = wasmClientPoolMetricsSnapshot();
				expect(afterSecond).toEqual({
					hits: 1,
					misses: 1,
					evictions: 0,
					size: 1,
				});
				expect(second.manager).toBe(first.manager);
				expect(second.session).not.toBe(first.session);

				first.manager.close();
			} finally {
				server.close();
			}
		},
	);

	test.skipIf(!wasmAvailable)(
		"manager and session metricsSnapshot() move with real datagram traffic",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4811 };
			const clientAddr = { address: "127.0.0.1", port: 5811 };
			let serverSession: {
				sendDatagram: (data: Uint8Array) => Promise<void>;
			} | null = null;
			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				(session) => {
					serverSession = session;
					session.onDatagram((data) => {
						void session.sendDatagram(data); // echo
					});
				},
				"127.0.0.1:4811",
				"127.0.0.1:5811",
				normalizeWasmEndpointOptions({}),
			);
			try {
				const { session, manager } = await connectWasm(
					wasm,
					relay.endpoint(clientAddr),
					"metrics.example",
					"127.0.0.1:5811",
					"127.0.0.1:4811",
					{},
				);

				const beforeManager = manager.metricsSnapshot();
				const beforeSession = session.metricsSnapshot();
				expect(beforeManager.sessionsActive).toBe(1);
				expect(beforeManager.datagramsOut).toBe(0);
				expect(beforeSession.datagramsOut).toBe(0);

				let echoed: Uint8Array | null = null;
				session.onDatagram((data) => {
					echoed = data.slice();
				});
				await session.sendDatagram(new TextEncoder().encode("hello"));

				const deadline = Date.now() + 3000;
				while (echoed === null && Date.now() < deadline) {
					await Bun.sleep(5);
				}
				expect(echoed).not.toBeNull();

				const afterManager = manager.metricsSnapshot();
				const afterSession = session.metricsSnapshot();
				expect(afterManager.datagramsOut).toBe(beforeManager.datagramsOut + 1);
				expect(afterManager.datagramsIn).toBe(beforeManager.datagramsIn + 1);
				expect(afterSession.datagramsOut).toBe(beforeSession.datagramsOut + 1);
				expect(afterSession.datagramsIn).toBe(beforeSession.datagramsIn + 1);
				expect(afterManager.nowMs).toBeGreaterThanOrEqual(beforeManager.nowMs);

				expect(serverSession).not.toBeNull();
				manager.close();
			} finally {
				server.close();
			}
		},
	);

	test.skipIf(!wasmAvailable)(
		"session queuedBytes tracks retained payloads, not cumulative traffic",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4812 };
			const clientAddr = { address: "127.0.0.1", port: 5812 };
			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				(session) => {
					session.onDatagram((data) => {
						void session.sendDatagram(data); // echo
					});
				},
				"127.0.0.1:4812",
				"127.0.0.1:5812",
				normalizeWasmEndpointOptions({}),
			);
			try {
				const { session, manager } = await connectWasm(
					wasm,
					relay.endpoint(clientAddr),
					"queued.example",
					"127.0.0.1:5812",
					"127.0.0.1:4812",
					{},
				);

				expect(session.metricsSnapshot().queuedBytes).toBe(0);

				// No onDatagram handler yet, so every echo is retained by the
				// session's inbound queue and holds a host reservation.
				const payload = new Uint8Array(512).fill(7);
				const sent = 4;
				for (let i = 0; i < sent; i++) await session.sendDatagram(payload);

				const queuedDeadline = Date.now() + 3000;
				while (
					session.metricsSnapshot().datagramsIn < sent &&
					Date.now() < queuedDeadline
				) {
					await Bun.sleep(5);
				}
				const stalled = session.metricsSnapshot();
				expect(stalled.datagramsIn).toBe(sent);
				expect(stalled.queuedBytes).toBeGreaterThanOrEqual(
					sent * payload.byteLength,
				);

				// Draining the queue must return the retained-byte count to zero
				// even though cumulative traffic keeps growing.
				let delivered = 0;
				session.onDatagram(() => {
					delivered += 1;
				});
				expect(delivered).toBe(sent);
				expect(session.metricsSnapshot().queuedBytes).toBe(0);

				const stats = session.connectionStats();
				expect(stats.bytesSent).toBeGreaterThan(0);
				expect(stats.bytesReceived).toBeGreaterThan(0);

				// Closing with payloads still queued releases them exactly once.
				const drained = session.metricsSnapshot().queuedBytes;
				expect(drained).toBe(0);
				session.close();
				expect(session.metricsSnapshot().queuedBytes).toBe(0);
				expect(manager.resourceSnapshot().hostReservationsActive).toBe(0);

				manager.close();
			} finally {
				server.close();
			}
		},
	);
});
