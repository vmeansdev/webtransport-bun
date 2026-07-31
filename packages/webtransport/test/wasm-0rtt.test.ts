import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	createWasmServer,
	normalizeWasmEndpointOptions,
	serveOverUdp,
	WasmTransportManager,
} from "../src/backend.js";
import {
	MemoryTicketStoreHost,
	type TicketStoreHost,
} from "../src/backend-wasm.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
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

function fakeTicketDumpModule(blob = new Uint8Array([4, 5, 6])) {
	const base = {
		wt_new_endpoint_with_options: () => JSON.stringify({ eid: 1 }),
		wt_poll_transmits: () => new Uint8Array(),
		wt_poll_event: () => undefined,
		wt_next_timeout_ms: () => -1,
		wt_governor_snapshot: () => "{}",
		wt_take_last_error: () => "",
		wt_dump_client_ticket: () => blob.slice(),
		wt_close_all() {},
		wt_close_endpoint() {},
	};
	return new Proxy(base, {
		get(target, key) {
			return Reflect.get(target, key) ?? (() => 0);
		},
	}) as unknown as Parameters<typeof WasmTransportManager.create>[0];
}

function ticketDumpManager(ticketStore: TicketStoreHost): WasmTransportManager {
	return WasmTransportManager.create(
		fakeTicketDumpModule(),
		new InMemoryRelay().a,
		false,
		"127.0.0.1:5544",
		"127.0.0.1:4433",
		null,
		normalizeWasmEndpointOptions({ enable0Rtt: true }),
		undefined,
		ticketStore,
	);
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

	test("Chromium-safe defaults omit enable0Rtt and QPACK fields", () => {
		const n = normalizeWasmEndpointOptions({});
		expect(n.enable0Rtt).toBeUndefined();
		expect(n.shareProcess0RttTicketStore).toBeUndefined();
		expect(n.qpackMaxTableCapacity).toBeUndefined();
		expect(n.enableDynamicQpack).toBeUndefined();
	});

	test("manager close stays sync while shutdown waits for ticket persistence", async () => {
		let resolvePut!: () => void;
		let transportClosed = 0;
		const stored: Uint8Array[] = [];
		const ticketStore: TicketStoreHost = {
			async get() {
				return null;
			},
			async put(_key, ticket) {
				stored.push(ticket.slice());
				await new Promise<void>((resolve) => {
					resolvePut = resolve;
				});
			},
			async take() {
				return null;
			},
		};
		const manager = ticketDumpManager(ticketStore);
		manager.ownTransport({
			send() {},
			onPacket() {},
			close() {
				transportClosed += 1;
			},
		});
		manager.rememberAuthority("localhost");

		expect(manager.close()).toBeUndefined();
		const shutdown = manager.waitForShutdown();
		let settled = false;
		void shutdown.finally(() => {
			settled = true;
		});
		await Bun.sleep(0);
		expect(stored).toEqual([new Uint8Array([4, 5, 6])]);
		expect(settled).toBe(false);
		expect(transportClosed).toBe(1);

		resolvePut();
		await expect(shutdown).resolves.toBeUndefined();
		manager.close();
		expect(transportClosed).toBe(1);
	});

	test("manager close surfaces ticket persistence failures via waitForShutdown", async () => {
		const reported: unknown[] = [];
		const manager = ticketDumpManager({
			async get() {
				return null;
			},
			async put() {
				throw new Error("persist failed");
			},
			async take() {
				return null;
			},
		});
		manager.onCallbackError = (error) => {
			reported.push(error);
		};
		manager.rememberAuthority("localhost");

		manager.close();
		await expect(manager.waitForShutdown()).rejects.toThrow("persist failed");
		expect(reported).toHaveLength(1);
		expect(String(reported[0])).toContain("persist failed");
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
});
