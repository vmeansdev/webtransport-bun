import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectWasm,
	createWasmServer,
	normalizeWasmEndpointOptions,
	serveOverUdp,
} from "../src/backend.js";
import type { TicketStoreHost } from "../src/backend-wasm.js";
import { MemoryTicketStoreHost } from "../src/backend-wasm.js";
import {
	FileTicketStoreHost,
	IndexedDBTicketStoreHost,
} from "../src/ticket-store-hosts.js";
import { InMemoryRelay, type UdpTransport } from "../src/wasm-relay.js";
import { installFakeIndexedDB } from "./helpers/indexeddb-double.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

async function withDeadline<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${label} timed out after ${ms}ms`)),
					ms,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/** Ticket host whose `put()` the test releases or fails on demand. */
class ControlledTicketStoreHost implements TicketStoreHost {
	readonly puts: Array<{ key: string; ticket: Uint8Array }> = [];
	failPut: Error | null = null;
	private readonly stored = new Map<string, Uint8Array>();
	private release: (() => void) | null = null;

	async get(key: string): Promise<Uint8Array | null> {
		return this.stored.get(key) ?? null;
	}

	async take(key: string): Promise<Uint8Array | null> {
		const value = this.stored.get(key) ?? null;
		this.stored.delete(key);
		return value;
	}

	put(key: string, ticket: Uint8Array): Promise<void> {
		this.puts.push({ key, ticket });
		if (this.failPut) return Promise.reject(this.failPut);
		return new Promise<void>((resolve) => {
			this.release = () => {
				this.stored.set(key, ticket);
				resolve();
			};
		});
	}

	/** Let the pending `put()` complete. */
	releasePut(): void {
		const release = this.release;
		this.release = null;
		release?.();
	}
}

/** A transport whose `close()` calls the manager makes are counted. */
function countingTransportCloses(): { count: number; transport: UdpTransport } {
	const state = {
		count: 0,
		transport: {
			send: () => {},
			onPacket: () => {},
			close: () => {
				state.count += 1;
			},
		} satisfies UdpTransport,
	};
	return state;
}

/** Connect a pinned 0-RTT client and pump until the server has minted an NST. */
async function connectWithTicketStore(
	ticketStore: TicketStoreHost,
	serverPort: number,
	clientPort: number,
) {
	const relay = new InMemoryRelay();
	const { manager: server, certHashBase64 } = await serveOverUdp(
		wasm,
		(localAddress, localPort) =>
			Promise.resolve(
				relay.endpoint({ address: localAddress, port: localPort }),
			),
		{
			localAddress: "127.0.0.1",
			localPort: serverPort,
			enable0Rtt: true,
			onSession: () => {},
		},
	);
	const { session, manager } = await connectWasm(
		wasm,
		relay.endpoint({ address: "127.0.0.1", port: clientPort }),
		"localhost",
		`127.0.0.1:${clientPort}`,
		`127.0.0.1:${serverPort}`,
		{ enable0Rtt: true, certHashBase64, ticketStore },
	);
	await withDeadline(session.ready, 5_000, "persistence.ready");
	for (let i = 0; i < 100; i++) {
		server.endpoint.pump();
		manager.endpoint.pump();
		await Bun.sleep(5);
	}
	session.close();
	return { session, manager, server };
}

describe("wasm 0-RTT product surface", () => {
	test("MemoryTicketStoreHost take-once rejects replay", async () => {
		const store = new MemoryTicketStoreHost();
		await store.put("k", new Uint8Array([1, 2, 3]));
		const first = await store.take("k");
		expect(first).toEqual(new Uint8Array([1, 2, 3]));
		expect(await store.take("k")).toBeNull();
		expect(await store.get("k")).toBeNull();
	});

	test("MemoryTicketStoreHost hands concurrent takers one ticket", async () => {
		const store = new MemoryTicketStoreHost();
		await store.put("k", new Uint8Array([1, 2, 3]));
		const results = await Promise.all([store.take("k"), store.take("k")]);
		expect(results.filter((r) => r !== null)).toEqual([
			new Uint8Array([1, 2, 3]),
		]);
		expect(await store.get("k")).toBeNull();
	});

	test("FileTicketStoreHost hands concurrent takers one ticket", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wt-tickets-"));
		try {
			const store = new FileTicketStoreHost(dir);
			await store.put("localhost", new Uint8Array([9, 9]));
			const results = await Promise.all([
				store.take("localhost"),
				store.take("localhost"),
			]);
			expect(results.filter((r) => r !== null)).toEqual([
				new Uint8Array([9, 9]),
			]);
			expect(await store.get("localhost")).toBeNull();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("IndexedDBTicketStoreHost hands concurrent takers one ticket", async () => {
		const idb = installFakeIndexedDB();
		try {
			const store = new IndexedDBTicketStoreHost("wt-take-test");
			await store.put("localhost", new Uint8Array([4, 5, 6]));
			// Both takers start before either resolves: a get() that commits before
			// its delete lets the second taker replay the same ticket.
			const results = await Promise.all([
				store.take("localhost"),
				store.take("localhost"),
			]);
			expect(results.filter((r) => r !== null)).toEqual([
				new Uint8Array([4, 5, 6]),
			]);
			expect(await store.get("localhost")).toBeNull();
			expect(idb.raw("wt-take-test").size).toBe(0);
		} finally {
			idb.restore();
		}
	});

	test("IndexedDBTicketStoreHost round-trips a ticket before it is taken", async () => {
		const idb = installFakeIndexedDB();
		try {
			const store = new IndexedDBTicketStoreHost("wt-roundtrip-test");
			expect(await store.get("localhost")).toBeNull();
			await store.put("localhost", new Uint8Array([7]));
			expect(await store.get("localhost")).toEqual(new Uint8Array([7]));
			expect(await store.take("localhost")).toEqual(new Uint8Array([7]));
			expect(await store.take("localhost")).toBeNull();
		} finally {
			idb.restore();
		}
	});

	test("Chromium-safe defaults omit enable0Rtt and QPACK fields", () => {
		const n = normalizeWasmEndpointOptions({});
		expect(n.enable0Rtt).toBeUndefined();
		expect(n.shareProcess0RttTicketStore).toBeUndefined();
		expect(n.qpackMaxTableCapacity).toBeUndefined();
		expect(n.enableDynamicQpack).toBeUndefined();
	});

	test.skipIf(!wasmAvailable)(
		"enable0Rtt false never reports has0Rtt",
		async () => {
			const relay = new InMemoryRelay();
			const server = createWasmServer(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 4433 }),
				() => {},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				{ enable0Rtt: false },
			);
			const { session, manager } = await connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 5544 }),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				{ enable0Rtt: false },
			);
			await withDeadline(session.ready, 5_000, "session.ready");
			expect(manager.endpoint.enable0Rtt()).toBe(false);
			expect(session.has0Rtt).toBe(false);
			expect(session.accepted0Rtt).toBe(false);
			manager.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"enable0Rtt + shareProcess0RttTicketStore yields has0Rtt on reconnect",
		async () => {
			const relay = new InMemoryRelay();
			const shared = {
				enable0Rtt: true,
				shareProcess0RttTicketStore: true,
			} as const;
			const server = createWasmServer(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 4433 }),
				(s) => {
					s.onDatagram((d) => {
						void s.sendDatagram(d);
					});
				},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				shared,
			);
			expect(server.endpoint.enable0Rtt()).toBe(true);

			const first = await connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 5544 }),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				shared,
			);
			await withDeadline(first.session.ready, 5_000, "first.ready");
			expect(first.manager.endpoint.enable0Rtt()).toBe(true);
			// Process-shared OnceLock may already hold tickets from earlier suite
			// tests; cold-start has0Rtt===false is not guaranteed in full runs.
			const firstHad0Rtt = first.session.has0Rtt;
			// Flush NewSessionTicket into the shared store (Rust poll_transmits NST rounds).
			for (let i = 0; i < 100; i++) {
				server.endpoint.pump();
				first.manager.endpoint.pump();
				await Bun.sleep(5);
			}
			first.session.close();
			first.manager.close();

			const second = await connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 5545 }),
				"localhost",
				"127.0.0.1:5545",
				"127.0.0.1:4433",
				shared,
			);
			await withDeadline(second.session.ready, 5_000, "second.ready");
			expect(second.manager.endpoint.enable0Rtt()).toBe(true);
			expect(second.session.has0Rtt).toBe(true);
			// Cold or warm first connect: second must still resume.
			expect(typeof firstHad0Rtt).toBe("boolean");
			second.manager.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"pinned client + MemoryTicketStoreHost hydrate yields has0Rtt without shareProcess",
		async () => {
			const relay = new InMemoryRelay();
			const ticketStore = new MemoryTicketStoreHost();
			const { manager: server, certHashBase64 } = await serveOverUdp(
				wasm,
				(localAddress, localPort) =>
					Promise.resolve(
						relay.endpoint({ address: localAddress, port: localPort }),
					),
				{
					localAddress: "127.0.0.1",
					localPort: 4433,
					enable0Rtt: true,
					onSession: (s) => {
						s.onDatagram((d) => {
							void s.sendDatagram(d);
						});
					},
				},
			);
			expect(server.endpoint.enable0Rtt()).toBe(true);

			const first = await connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 5544 }),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				{
					enable0Rtt: true,
					certHashBase64,
					ticketStore,
				},
			);
			await withDeadline(first.session.ready, 5_000, "pinned.first.ready");
			expect(first.session.has0Rtt).toBe(false);
			for (let i = 0; i < 100; i++) {
				server.endpoint.pump();
				first.manager.endpoint.pump();
				await Bun.sleep(5);
			}
			const dumped = await first.manager.dumpTicketsToHost("localhost");
			expect(dumped).toBe(true);
			first.session.close();
			first.manager.close();

			const second = await connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 5545 }),
				"localhost",
				"127.0.0.1:5545",
				"127.0.0.1:4433",
				{
					enable0Rtt: true,
					certHashBase64,
					ticketStore,
				},
			);
			await withDeadline(second.session.ready, 5_000, "pinned.second.ready");
			expect(second.manager.endpoint.enable0Rtt()).toBe(true);
			expect(second.session.has0Rtt).toBe(true);
			second.manager.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"manager.close() resolves only after ticket persistence completes",
		async () => {
			const store = new ControlledTicketStoreHost();
			const client = await connectWithTicketStore(store, 4436, 5548);
			const closes = countingTransportCloses();
			client.manager.ownTransport(closes.transport);

			let settled = false;
			const closed = client.manager.close().then(() => {
				settled = true;
			});
			// Teardown is synchronous even while persistence is outstanding.
			expect(closes.count).toBe(1);
			expect(client.manager.resourceSnapshot().hostReservationsActive).toBe(0);
			await Bun.sleep(20);
			expect(settled).toBe(false);
			expect(store.puts).toHaveLength(1);

			store.releasePut();
			await withDeadline(closed, 5_000, "close after persistence");
			expect(settled).toBe(true);
			expect(await store.get("localhost")).not.toBeNull();

			// A second close must not re-release the transport.
			await client.manager.close();
			expect(closes.count).toBe(1);
			client.server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"manager.close() surfaces ticket persistence failure without skipping teardown",
		async () => {
			const store = new ControlledTicketStoreHost();
			store.failPut = new Error("ticket store offline");
			const client = await connectWithTicketStore(store, 4437, 5549);
			const reported: unknown[] = [];
			client.manager.onCallbackError = (error) => reported.push(error);
			const closes = countingTransportCloses();
			client.manager.ownTransport(closes.transport);

			await expect(client.manager.close()).rejects.toThrow(
				"ticket store offline",
			);
			expect(reported).toHaveLength(1);
			expect(client.manager.takeResourceError()).toContain(
				"ticket store offline",
			);
			expect(closes.count).toBe(1);
			expect(client.manager.resourceSnapshot().hostReservationsActive).toBe(0);
			client.server.close();
		},
	);
});
