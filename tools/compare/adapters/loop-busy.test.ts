/**
 * `busyMs` means the same thing on both transports.
 *
 * The campaign attests one number per measured arm -- the JavaScript
 * event-loop time the server spent on the session's transport work
 * (`SESSION_LOOP_BUSY_MS_DEFINITION`) -- and ranks a WS arm against a WT arm
 * with it. Until the send path was charged, that number counted only the
 * inbound handler, so the Phase-A bulk cell, in which the server writes 100 MB
 * and reads almost nothing, reported `busyMs=1` on WS and `busyMs=0` on WT for
 * identical work. These tests hold the fixed shape:
 *
 *  - a send-only arm reports a positive busy time on BOTH transports, and the
 *    reading grows with the number of writes, so it tracks work rather than
 *    merely being non-zero;
 *  - a receive-only arm is unchanged in meaning: with only the ingest seam
 *    priced, both arms report exactly the injected ingest cost;
 *  - the same scripted workload through both adapters satisfies the definition
 *    on both: ingest charges, egress charges, and the two share one
 *    accumulator;
 *  - conservation and monotonicity survive: the server aggregate is the
 *    completed sum plus the live sum, a close transfers a session exactly
 *    once, and the reading never goes backwards.
 *
 * The two deterministic seams are what make this exact without wall time.
 * `noteBusySlice` prices one ingest slice and `noteEgressSlice` prices one
 * egress slice; a test that defines only one of them measures only that half.
 */
import { describe, expect, test } from "bun:test";
import { type Readable, Writable } from "node:stream";
import { encodeWireMessage, type WireMessage } from "../wire.ts";
import type {
	ServerHandle,
	ServerWebSocketLike,
	Session,
	TransportClock,
	WebSocketServerRuntime,
	WebSocketServerRuntimeOptions,
} from "./transport.ts";
import {
	encodeHandshakeFrame,
	encodeWebSocketFrame,
	WebSocketAdapter,
} from "./ws.ts";
import {
	createWebTransportAdapter,
	type FakeWtClientSession,
	type FakeWtServerSession,
	type WtClientFactory,
	type WtServerFactory,
} from "./wt.ts";

// ---------------------------------------------------------------------------
// A clock that prices the two halves of the loop apart
// ---------------------------------------------------------------------------

interface PricedClock extends TransportClock {
	/** Start charging the seams. Setup work before this is free. */
	arm(): void;
	readonly ingestSlices: () => number;
	readonly egressSlices: () => number;
}

function pricedClock(options: {
	readonly ingestMs?: number;
	readonly egressMs?: number;
}): PricedClock {
	let now = 1_000;
	let armed = false;
	let ingestSlices = 0;
	let egressSlices = 0;
	const clock: PricedClock = {
		nowMs: () => now,
		sleep: async (ms: number) => {
			now += ms;
		},
		arm: () => {
			armed = true;
		},
		ingestSlices: () => ingestSlices,
		egressSlices: () => egressSlices,
	};
	if (options.ingestMs !== undefined) {
		clock.noteBusySlice = () => {
			if (!armed) return;
			ingestSlices += 1;
			now += options.ingestMs as number;
		};
	}
	if (options.egressMs !== undefined) {
		clock.noteEgressSlice = () => {
			if (!armed) return;
			egressSlices += 1;
			now += options.egressMs as number;
		};
	}
	return clock;
}

function message(sequence: number): WireMessage {
	return {
		runId: "run-1",
		sessionId: "session-1",
		sequence,
		expiresAtMs: 10_000,
		payload: Uint8Array.from([1, 2, 3, 4]),
	};
}

// ---------------------------------------------------------------------------
// WS fakes
// ---------------------------------------------------------------------------

type Listener = (...args: unknown[]) => void;

class BusyServerSocket implements ServerWebSocketLike {
	readonly sent: Array<string | Uint8Array> = [];
	readonly listeners = new Map<string, Set<Listener>>();
	readonly remoteAddress = "10.99.0.1";
	readyState = 1 as const;
	data: { readonly role?: string } = {};

	send(data: string | ArrayBuffer | ArrayBufferView): number {
		this.sent.push(typeof data === "string" ? data : new Uint8Array(1));
		return typeof data === "string" ? data.length : 1;
	}

	close(): void {
		this.readyState = 3 as 1;
	}

	addEventListener(type: string, listener: EventListener): void {
		const set = this.listeners.get(type) ?? new Set<Listener>();
		set.add(listener as unknown as Listener);
		this.listeners.set(type, set);
	}

	removeEventListener(type: string, listener: EventListener): void {
		this.listeners.get(type)?.delete(listener as unknown as Listener);
	}
}

class BusyServerRuntime implements WebSocketServerRuntime {
	readonly sockets: BusyServerSocket[] = [];
	constructor(readonly options: WebSocketServerRuntimeOptions) {}
	stop(): void {}
	open(): BusyServerSocket {
		const socket = new BusyServerSocket();
		this.sockets.push(socket);
		this.options.websocket.open?.(socket);
		return socket;
	}
	receive(socket: BusyServerSocket, data: Uint8Array): void {
		this.options.websocket.message(socket, data);
	}
}

async function openWsArm(clock: TransportClock): Promise<{
	readonly server: ServerHandle;
	readonly session: Session;
	readonly deliver: (frame: Uint8Array) => void;
}> {
	const holder: { current?: BusyServerRuntime } = {};
	const adapter = new WebSocketAdapter({
		clock,
		serverFactory: (options) => {
			const runtime = new BusyServerRuntime(options);
			holder.current = runtime;
			return runtime;
		},
	});
	const server = await adapter.startServer({
		port: 4433,
		role: "publisher",
		tls: { cert: "cert", key: "key", serverName: "wt-compare.local" },
	});
	const runtime = holder.current;
	if (!runtime) throw new Error("ws runtime was not created");
	const socket = runtime.open();
	runtime.receive(socket, encodeHandshakeFrame("publisher"));
	const session = await server.acceptSession(far(clock));
	return {
		server,
		session,
		deliver: (frame) => runtime.receive(socket, frame),
	};
}

// ---------------------------------------------------------------------------
// WT fakes
// ---------------------------------------------------------------------------

function collectingWritable(into: Uint8Array[]): Writable {
	return new Writable({
		write(chunk: Buffer, _enc, cb) {
			into.push(new Uint8Array(chunk));
			cb();
		},
		final(cb) {
			cb();
		},
	});
}

function emptyReadableStream<T>(): ReadableStream<T> {
	return {
		getReader: () => ({
			read: async () => ({ done: true, value: undefined }),
			cancel: async () => {},
			releaseLock: () => {},
		}),
	} as unknown as ReadableStream<T>;
}

function busyWtServerSession(datagrams: Uint8Array[]): FakeWtServerSession {
	const written: Uint8Array[] = [];
	return {
		id: "busy-wt-server",
		peer: { ip: "10.99.0.1", port: 12345 },
		has0Rtt: false,
		accepted0Rtt: false,
		handshakeConfirmed: true,
		ready: Promise.resolve(),
		closed: new Promise(() => {}),
		draining: new Promise(() => {}),
		close: () => {},
		drain: () => {},
		sendDatagram: async () => {},
		sendDatagramBatch: async (items: readonly Uint8Array[]) => ({
			sent: items.length,
		}),
		incomingDatagrams: async function* () {
			for (const d of datagrams) yield d;
		},
		incomingBidirectionalStreams: emptyReadableStream(),
		incomingUnidirectionalStreams: emptyReadableStream<Readable>(),
		createBidirectionalStream: async () => collectingWritable(written),
		createUnidirectionalStream: async () => collectingWritable(written),
		metricsSnapshot: () => ({ sessionsOpened: 1, sessionsClosed: 0 }),
		goAway: () => {},
	} as unknown as FakeWtServerSession;
}

async function openWtArm(
	clock: TransportClock,
	datagrams: Uint8Array[] = [],
): Promise<{ readonly server: ServerHandle; readonly session: Session }> {
	const serverSession = busyWtServerSession(datagrams);
	const serverFactory: WtServerFactory = (options) =>
		({
			address: { host: "10.99.0.2", port: options.port ?? 4433 },
			congestionControl: "default",
			close: async () => {},
			metricsSnapshot: () => ({}),
			tlsSnapshot: () => ({ sni: [] }),
			goAway: () => {},
			onSession(cb: (s: FakeWtServerSession) => void) {
				cb(serverSession);
			},
		}) as unknown as ReturnType<WtServerFactory>;
	const clientFactory: WtClientFactory = async () =>
		({}) as unknown as FakeWtClientSession;
	const adapter = createWebTransportAdapter({
		serverFactory,
		clientFactory,
		clock,
	});
	const server = await adapter.startServer({
		port: 4433,
		tls: { cert: "cert", key: "key" },
	});
	const session = await server.acceptSession(far(clock));
	return { server, session };
}

// ---------------------------------------------------------------------------
// The scripted workloads, written once and run through both adapters
// ---------------------------------------------------------------------------

/**
 * A deadline far enough out that no wait in either adapter can reach it.
 * It has to be finite: WS refuses an infinite one on every bounded wait.
 */
function far(clock: TransportClock): number {
	return clock.nowMs() + 1_000_000;
}

/** Open a uni channel, write `chunks` chunks, end it. The server never reads. */
async function sendOnlyArm(
	session: Session,
	clock: TransportClock,
	chunks: number,
): Promise<void> {
	const channel = await session.openUni(far(clock));
	const payload = new Uint8Array(64);
	payload.fill(9);
	for (let index = 0; index < chunks; index++) {
		await channel.write(payload, far(clock));
	}
	await channel.end(far(clock));
}

const ARMS = [
	{
		transport: "ws" as const,
		open: async (clock: TransportClock, datagrams: Uint8Array[]) => {
			const arm = await openWsArm(clock);
			return {
				server: arm.server,
				session: arm.session,
				feedInbound: () => {
					for (const bytes of datagrams) {
						arm.deliver(
							encodeWebSocketFrame({
								kind: "message",
								deliveryKind: "datagram",
								payload: bytes,
							}),
						);
					}
				},
			};
		},
	},
	{
		transport: "wt" as const,
		open: async (clock: TransportClock, datagrams: Uint8Array[]) => {
			const arm = await openWtArm(clock, datagrams);
			return {
				server: arm.server,
				session: arm.session,
				feedInbound: async () => {
					for (let index = 0; index < datagrams.length; index++) {
						await arm.session.receiveMessage("datagram", far(clock));
					}
				},
			};
		},
	},
];

describe("busyMs means the same thing on both transports", () => {
	for (const arm of ARMS) {
		test(`${arm.transport}_send_only_arm_reports_positive_busy_ms`, async () => {
			const clock = pricedClock({ egressMs: 3 });
			const opened = await arm.open(clock, []);
			clock.arm();
			await sendOnlyArm(opened.session, clock, 4);
			const snapshot = opened.server.snapshot().serverLoopUtilization;
			expect(clock.egressSlices()).toBeGreaterThan(0);
			expect(snapshot.busyMs).toBeGreaterThan(0);
			expect(snapshot.windowMs).toBeGreaterThan(0);
		});

		test(`${arm.transport}_send_only_busy_ms_grows_with_the_writes`, async () => {
			const readingFor = async (chunks: number): Promise<number> => {
				const clock = pricedClock({ egressMs: 3 });
				const opened = await arm.open(clock, []);
				clock.arm();
				await sendOnlyArm(opened.session, clock, chunks);
				return opened.server.snapshot().serverLoopUtilization.busyMs;
			};
			const few = await readingFor(2);
			const many = await readingFor(10);
			expect(few).toBeGreaterThan(0);
			expect(many).toBeGreaterThan(few);
		});

		test(`${arm.transport}_receive_only_arm_is_unchanged_in_meaning`, async () => {
			// Only the ingest seam is priced, so this reads exactly what it
			// read before the send path started charging: one 65 ms slice per
			// inbound message and nothing else.
			const clock = pricedClock({ ingestMs: 65 });
			const inbound = [encodeWireMessage(message(1))];
			const opened = await arm.open(clock, inbound);
			clock.arm();
			await opened.feedInbound();
			expect(clock.ingestSlices()).toBe(1);
			expect(opened.server.snapshot().serverLoopUtilization.busyMs).toBe(65);
		});

		test(`${arm.transport}_close_transfers_the_session_exactly_once`, async () => {
			const clock = pricedClock({ egressMs: 3 });
			const opened = await arm.open(clock, []);
			clock.arm();
			await sendOnlyArm(opened.session, clock, 3);
			const live = opened.server.snapshot().serverLoopUtilization.busyMs;
			expect(live).toBeGreaterThan(0);
			await opened.session.close(far(clock));
			const afterClose = opened.server.snapshot().serverLoopUtilization.busyMs;
			expect(afterClose).toBeGreaterThanOrEqual(live);
			await opened.session.close(far(clock));
			await opened.session.close(far(clock));
			expect(opened.server.snapshot().serverLoopUtilization.busyMs).toBe(
				afterClose,
			);
		});

		test(`${arm.transport}_busy_ms_never_goes_backwards`, async () => {
			const clock = pricedClock({ ingestMs: 5, egressMs: 3 });
			const inbound = [encodeWireMessage(message(1))];
			const opened = await arm.open(clock, inbound);
			clock.arm();
			const readings: number[] = [
				opened.server.snapshot().serverLoopUtilization.busyMs,
			];
			await sendOnlyArm(opened.session, clock, 2);
			readings.push(opened.server.snapshot().serverLoopUtilization.busyMs);
			await opened.feedInbound();
			readings.push(opened.server.snapshot().serverLoopUtilization.busyMs);
			await opened.session.close(far(clock));
			readings.push(opened.server.snapshot().serverLoopUtilization.busyMs);
			for (let index = 1; index < readings.length; index++) {
				const previous = readings[index - 1] ?? 0;
				expect(readings[index] ?? -1).toBeGreaterThanOrEqual(previous);
			}
			// `finalBusyMs >= baselineBusyMs` -- what the child asserts before
			// it states a frame, and what the rig re-derives from it.
			const first = readings[0] ?? 0;
			expect(readings.at(-1) ?? -1).toBeGreaterThanOrEqual(first);
		});
	}

	test("the same scripted workload satisfies the definition on both arms", async () => {
		// One script, two adapters: write, then receive. Both halves must
		// charge on both transports, and both halves must land in the same
		// accumulator -- which is the whole of `SESSION_LOOP_BUSY_MS_DEFINITION`
		// and the property that was false before the send path charged.
		const readings = new Map<
			string,
			{ readonly egressOnly: number; readonly both: number }
		>();
		for (const arm of ARMS) {
			const inbound = [encodeWireMessage(message(1))];

			const egressClock = pricedClock({ egressMs: 7 });
			const egressArm = await arm.open(egressClock, []);
			egressClock.arm();
			await sendOnlyArm(egressArm.session, egressClock, 3);
			const egressOnly =
				egressArm.server.snapshot().serverLoopUtilization.busyMs;

			const bothClock = pricedClock({ ingestMs: 11, egressMs: 7 });
			const bothArm = await arm.open(bothClock, inbound);
			bothClock.arm();
			await sendOnlyArm(bothArm.session, bothClock, 3);
			await bothArm.feedInbound();
			const both = bothArm.server.snapshot().serverLoopUtilization.busyMs;

			readings.set(arm.transport, { egressOnly, both });
		}

		for (const transport of ["ws", "wt"] as const) {
			const reading = readings.get(transport);
			if (!reading) throw new Error(`no reading for ${transport}`);
			// Egress alone produces a reading: a session that only sends is
			// not a session that did nothing.
			expect(reading.egressOnly).toBeGreaterThan(0);
			// And ingest adds to the same accumulator rather than a second one.
			expect(reading.both).toBeGreaterThan(reading.egressOnly);
		}
	});
});
