/**
 * Construction and read-path semantics of the two off-loop arms.
 *
 * These are wrapper tests, not transport tests: the base adapter is a scripted
 * stand-in, because what the two wrappers claim is about *where* the bytes are
 * read, and a real socket would only make that harder to observe. The wire
 * itself is already covered by `ws.test.ts` and `wt.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { ARM_SHEDDING_POLICY, ARM_WIRE } from "../evidence.ts";
import type { WireMessage } from "../wire.ts";
import { createSinkWorker, runSinkPump } from "./sink-worker.ts";
import type {
	BidiChannel,
	ClientConfig,
	ReceiveChannel,
	SendChannel,
	SendObservation,
	ServerConfig,
	ServerHandle,
	Session,
	SubmittedCapacityProfile,
	TransportAdapter,
	TransportClock,
	TransportKind,
	TransportMetrics,
} from "./transport.ts";
import { systemTransportClock, WebSocketTransportError } from "./transport.ts";
import { createWsWorkerAdapter } from "./ws-worker.ts";
import { createWtStreamSinkAdapter } from "./wt-stream-sink.ts";

const EMPTY_PROFILE: SubmittedCapacityProfile = Object.freeze({
	profile: {} as SubmittedCapacityProfile["profile"],
	bytes: "{}",
	hash: "0".repeat(64),
});

function zeroMetrics(): TransportMetrics {
	return {
		sessionsActive: 0,
		handshakesInFlight: 0,
		handshakesAttempted: 0,
		handshakesAccepted: 0,
		handshakesRejected: 0,
		streamOpenAttempts: 0,
		streamOpenAccepted: 0,
		streamOpenRejected: 0,
		datagramAttempts: 0,
		datagramAccepted: 0,
		datagramRejected: 0,
		tokenBucketRejected: 0,
		attempted: 0,
		queued: 0,
		serverObserved: 0,
		acknowledged: 0,
		delivered: 0,
		refused: 0,
		dropped: 3,
		timedOut: 0,
		sessionsOpened: 1,
		sessionsClosed: 0,
		streamsOpened: 0,
		streamsAccepted: 0,
		streamsClosed: 0,
		active: true,
		queueBytes: 0,
		queueBytesPeak: 0,
		receiveQueueItems: 2,
		receiveQueueBytes: 64,
		// A deliberately implausible reading, so a wrapper that forwards the
		// base session's loop instead of publishing its reader's is obvious.
		loopUtilization: { busyMs: 999_999, windowMs: 1 },
		harnessOverheadBytes: 0,
	};
}

function messageOf(sequence: number, bytes: number): WireMessage {
	return {
		runId: "run",
		sessionId: "run-s1",
		sequence,
		expiresAtMs: Number.MAX_SAFE_INTEGER,
		payload: new Uint8Array(bytes),
	};
}

interface ScriptedBase {
	adapter: TransportAdapter;
	readonly startServerCalls: ServerConfig[];
	readonly connectCalls: ClientConfig[];
	closed: boolean;
}

/**
 * A base adapter whose reads are a script.
 *
 * `readDelayMs` is real elapsed time, because the reader's busy accounting is
 * measured off the same clock the leg reads and a zero-cost read would make
 * `busyMs` indistinguishable from an unmeasured one.
 */
function scriptedBase(options: {
	readonly kind: TransportKind;
	readonly messages?: readonly WireMessage[];
	readonly chunks?: readonly (Uint8Array | null)[];
	readonly failWith?: Error;
	readonly readDelayMs?: number;
}): ScriptedBase {
	const startServerCalls: ServerConfig[] = [];
	const connectCalls: ClientConfig[] = [];
	const state: ScriptedBase = {
		startServerCalls,
		connectCalls,
		closed: false,
		adapter: undefined as unknown as TransportAdapter,
	};
	const readDelayMs = options.readDelayMs ?? 0;
	const pending = [...(options.messages ?? [])];
	const pendingChunks = [...(options.chunks ?? [])];

	const delay = async (): Promise<void> => {
		if (readDelayMs <= 0) return;
		await new Promise<void>((resolve) => setTimeout(resolve, readDelayMs));
	};

	const receiveChannel = (): ReceiveChannel => ({
		channelId: 1,
		async read(): Promise<Uint8Array | null> {
			await delay();
			if (pendingChunks.length === 0) {
				if (options.failWith !== undefined) throw options.failWith;
				return null;
			}
			return pendingChunks.shift() ?? null;
		},
		async cancel(): Promise<void> {},
	});

	const session: Session = {
		role: "publisher",
		async sendMessage(): Promise<SendObservation> {
			return {
				status: 1,
				bytes: 0,
				deliveryKind: "reliable-message",
				attempted: true,
				queued: true,
				serverObserved: false,
				acknowledged: false,
				delivered: false,
			};
		},
		async receiveMessage(): Promise<WireMessage> {
			await delay();
			const next = pending.shift();
			if (next === undefined) {
				throw (
					options.failWith ??
					new WebSocketTransportError("E_SESSION_CLOSED", "script exhausted")
				);
			}
			return next;
		},
		async sendText(): Promise<SendObservation> {
			return await session.sendMessage("reliable-message", messageOf(0, 0), 0);
		},
		async openUni(): Promise<SendChannel> {
			return {
				channelId: 2,
				async write(): Promise<SendObservation> {
					return await session.sendMessage(
						"reliable-message",
						messageOf(0, 0),
						0,
					);
				},
				async end(): Promise<void> {},
			};
		},
		async acceptUni(): Promise<ReceiveChannel> {
			return receiveChannel();
		},
		async openBidi(): Promise<BidiChannel> {
			const receive = receiveChannel();
			return {
				channelId: receive.channelId,
				write: () =>
					session.sendMessage("reliable-message", messageOf(0, 0), 0),
				end: async () => {},
				read: (deadlineMs) => receive.read(deadlineMs),
				cancel: (deadlineMs) => receive.cancel(deadlineMs),
			};
		},
		async acceptBidi(): Promise<BidiChannel> {
			return await session.openBidi(0);
		},
		async close(): Promise<void> {
			state.closed = true;
		},
		snapshot: () => zeroMetrics(),
	};

	state.adapter = {
		kind: options.kind,
		submittedCapacityProfile: EMPTY_PROFILE,
		async startServer(config: ServerConfig): Promise<ServerHandle> {
			startServerCalls.push(config);
			return {
				async acceptSession(): Promise<Session> {
					return session;
				},
				async stop(): Promise<void> {},
				snapshot: () => ({
					...zeroMetrics(),
					serverLoopUtilization: { busyMs: 0, windowMs: 1 },
				}),
			};
		},
		async connect(config: ClientConfig): Promise<Session> {
			connectCalls.push(config);
			return session;
		},
	};
	return state;
}

const CLIENT_CONFIG: ClientConfig = Object.freeze({
	url: "wss://example.invalid:4433",
	role: "publisher",
	deadlineMs: 1_000,
});

describe("read-path adapter construction", () => {
	test("each wrapper keeps the wire its arm identity declares", async () => {
		const ws = createWsWorkerAdapter(scriptedBase({ kind: "ws" }).adapter);
		const wt = createWtStreamSinkAdapter(scriptedBase({ kind: "wt" }).adapter);
		expect(ws.kind).toBe(ARM_WIRE["ws-worker"]);
		expect(ws.armTransport).toBe("ws-worker");
		expect(wt.kind).toBe(ARM_WIRE["wt-stream-sink"]);
		expect(wt.armTransport).toBe("wt-stream-sink");
	});

	test("a wrapper refuses a base riding the wrong wire", () => {
		expect(() =>
			createWsWorkerAdapter(scriptedBase({ kind: "wt" }).adapter),
		).toThrow(RangeError);
		expect(() =>
			createWtStreamSinkAdapter(scriptedBase({ kind: "ws" }).adapter),
		).toThrow(RangeError);
	});

	test("the server side is the base's, byte for byte", async () => {
		const base = scriptedBase({ kind: "ws" });
		const adapter = createWsWorkerAdapter(base.adapter);
		const config: ServerConfig = { port: 4433, role: "subscriber" };
		await adapter.startServer(config);
		expect(base.startServerCalls).toEqual([config]);
		expect(adapter.submittedCapacityProfile).toBe(
			base.adapter.submittedCapacityProfile,
		);
	});

	test("an unused wrapper reports no queues rather than a queue of zeros", () => {
		const adapter = createWsWorkerAdapter(scriptedBase({ kind: "ws" }).adapter);
		expect(adapter.readPathDiagnostics()).toEqual([]);
	});
});

describe("ws-worker read path", () => {
	test("messages arrive in order through the queue", async () => {
		const base = scriptedBase({
			kind: "ws",
			messages: [messageOf(1, 16), messageOf(2, 16), messageOf(3, 16)],
		});
		const session = await createWsWorkerAdapter(base.adapter).connect(
			CLIENT_CONFIG,
		);
		const deadlineMs = systemTransportClock.nowMs() + 2_000;
		const received: number[] = [];
		for (let index = 0; index < 3; index += 1) {
			const message = await session.receiveMessage(
				"reliable-message",
				deadlineMs,
			);
			received.push(message.sequence);
		}
		expect(received).toEqual([1, 2, 3]);
		await session.close(deadlineMs);
		expect(base.closed).toBe(true);
	});

	test("snapshot publishes the reader's loop, not the base session's", async () => {
		const base = scriptedBase({
			kind: "ws",
			messages: [messageOf(1, 16), messageOf(2, 16)],
			readDelayMs: 5,
		});
		const adapter = createWsWorkerAdapter(base.adapter);
		const session = await adapter.connect(CLIENT_CONFIG);
		const deadlineMs = systemTransportClock.nowMs() + 2_000;
		await session.receiveMessage("reliable-message", deadlineMs);
		await session.receiveMessage("reliable-message", deadlineMs);
		const metrics = session.snapshot();
		expect(metrics.loopUtilization.busyMs).toBeGreaterThan(0);
		expect(metrics.loopUtilization.busyMs).toBeLessThan(
			zeroMetrics().loopUtilization.busyMs,
		);
		// Queue drops are added to the base count, never substituted for it.
		expect(metrics.dropped).toBeGreaterThanOrEqual(zeroMetrics().dropped);
		const diagnostics = adapter.readPathDiagnostics();
		expect(diagnostics.length).toBeGreaterThan(0);
		expect(diagnostics[0]?.armTransport).toBe("ws-worker");
		expect(diagnostics[0]?.overflowPolicy).toBe("drop-and-count");
		expect(diagnostics[0]?.taken).toBe(2);
	});

	test("the reader's failure reaches the consumer with its own code", async () => {
		const base = scriptedBase({
			kind: "ws",
			messages: [],
			failWith: new WebSocketTransportError("E_SESSION_CLOSED", "peer gone"),
		});
		const session = await createWsWorkerAdapter(base.adapter).connect(
			CLIENT_CONFIG,
		);
		const deadlineMs = systemTransportClock.nowMs() + 2_000;
		const error = await session
			.receiveMessage("reliable-message", deadlineMs)
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);
		expect(error).toBeInstanceOf(WebSocketTransportError);
		expect((error as WebSocketTransportError).code).toBe("E_SESSION_CLOSED");
	});

	test("a channel's end of stream is delivered as a record", async () => {
		const base = scriptedBase({
			kind: "ws",
			chunks: [new Uint8Array(8), null],
		});
		const session = await createWsWorkerAdapter(base.adapter).connect(
			CLIENT_CONFIG,
		);
		const deadlineMs = systemTransportClock.nowMs() + 2_000;
		const channel = await session.acceptUni(deadlineMs);
		expect((await channel.read(deadlineMs))?.byteLength).toBe(8);
		expect(await channel.read(deadlineMs)).toBeNull();
	});
});

describe("wt-stream-sink read path", () => {
	test("without a native seam the sink states the facade path it ran", async () => {
		const base = scriptedBase({ kind: "wt", messages: [messageOf(1, 16)] });
		const adapter = createWtStreamSinkAdapter(base.adapter);
		const session = await adapter.connect(CLIENT_CONFIG);
		await session.receiveMessage(
			"reliable-message",
			systemTransportClock.nowMs() + 2_000,
		);
		const diagnostics = adapter.sinkDiagnostics();
		expect(diagnostics.configuredMode).toBe("facade-park");
		expect(diagnostics.sinkMode).toBe("facade-park");
		expect(diagnostics.nativeSinksOpened).toBe(0);
		expect(diagnostics.queues[0]?.overflowPolicy).toBe("park");
	});

	test("a native seam that opens nothing is not rounded up to a native read", async () => {
		const base = scriptedBase({ kind: "wt", chunks: [null] });
		const adapter = createWtStreamSinkAdapter(base.adapter, {
			nativeHandleFor: () => undefined,
			openReadSink: () => {
				throw new Error("must not be reached without a handle");
			},
		});
		const session = await adapter.connect(CLIENT_CONFIG);
		await session.acceptUni(systemTransportClock.nowMs() + 2_000);
		const diagnostics = adapter.sinkDiagnostics();
		expect(diagnostics.configuredMode).toBe("native-read-sink");
		expect(diagnostics.sinkMode).toBe("facade-park");
		expect(diagnostics.nativeSinksOpened).toBe(0);
	});

	test("a native sink that actually opens is reported as one and is closed", async () => {
		let closed = 0;
		const base = scriptedBase({ kind: "wt", chunks: [null] });
		const adapter = createWtStreamSinkAdapter(base.adapter, {
			nativeHandleFor: () => ({ handle: true }),
			openReadSink: () => ({
				stats: () => ({ records: 0, bytesIn: 0 }),
				close: async () => {
					closed += 1;
				},
			}),
		});
		const deadlineMs = systemTransportClock.nowMs() + 2_000;
		const session = await adapter.connect(CLIENT_CONFIG);
		await session.acceptUni(deadlineMs);
		expect(adapter.sinkDiagnostics().sinkMode).toBe("native-read-sink");
		expect(adapter.sinkDiagnostics().nativeSinksOpened).toBe(1);
		await session.close(deadlineMs);
		expect(closed).toBe(1);
	});

	test("the sink adds no drop term, because a parking reader sheds nothing", async () => {
		const base = scriptedBase({ kind: "wt", messages: [messageOf(1, 16)] });
		const session = await createWtStreamSinkAdapter(base.adapter).connect(
			CLIENT_CONFIG,
		);
		await session.receiveMessage(
			"reliable-message",
			systemTransportClock.nowMs() + 2_000,
		);
		expect(session.snapshot().dropped).toBe(zeroMetrics().dropped);
	});
});

describe("sink worker", () => {
	const clock: TransportClock = systemTransportClock;

	test("the overflow policy is derived from the arm, never authored", () => {
		const worker = createSinkWorker<number>({
			armTransport: "ws-worker",
			nowMs: () => clock.nowMs(),
			sleep: (ms) => clock.sleep(ms),
		});
		expect(worker.sheddingPolicy).toBe(ARM_SHEDDING_POLICY["ws-worker"]);
		expect(worker.overflowPolicy).toBe("drop-and-count");
		const sink = createSinkWorker<number>({
			armTransport: "wt-stream-sink",
			nowMs: () => clock.nowMs(),
			sleep: (ms) => clock.sleep(ms),
		});
		expect(sink.sheddingPolicy).toBe(ARM_SHEDDING_POLICY["wt-stream-sink"]);
		expect(sink.overflowPolicy).toBe("park");
	});

	test("a full drop-and-count queue sheds and says how much", () => {
		const worker = createSinkWorker<number>({
			armTransport: "ws-worker",
			nowMs: () => clock.nowMs(),
			sleep: (ms) => clock.sleep(ms),
			maxQueuedItems: 2,
		});
		expect(worker.offer(1, 4)).toBe(true);
		expect(worker.offer(2, 4)).toBe(true);
		expect(worker.offer(3, 4)).toBe(false);
		const stats = worker.stats();
		expect(stats.offered).toBe(3);
		expect(stats.accepted).toBe(2);
		expect(stats.dropped).toBe(1);
		expect(stats.queuedBytesPeak).toBe(8);
	});

	test("an unknown arm is refused at construction", () => {
		expect(() =>
			createSinkWorker<number>({
				armTransport: "ws-sink" as never,
				nowMs: () => clock.nowMs(),
				sleep: (ms) => clock.sleep(ms),
			}),
		).toThrow(RangeError);
	});

	test("the pump does not run its first read on the caller's turn", async () => {
		const worker = createSinkWorker<number>({
			armTransport: "ws-worker",
			nowMs: () => clock.nowMs(),
			sleep: (ms) => clock.sleep(ms),
		});
		let reads = 0;
		const pump = runSinkPump<number>({
			worker,
			nowMs: () => clock.nowMs(),
			sleep: (ms) => clock.sleep(ms),
			readTimeoutMs: 100,
			read: async () => {
				reads += 1;
				return reads === 1 ? { value: reads, bytes: 4 } : null;
			},
		});
		// The synchronous part of `runSinkPump` must be the detach and nothing
		// else; a read here would be the main-loop read the arm exists not to be.
		expect(reads).toBe(0);
		await pump;
		expect(reads).toBe(2);
		expect(worker.stats().accepted).toBe(1);
	});

	test("a deadline that passes with no record resolves undefined", async () => {
		const worker = createSinkWorker<number>({
			armTransport: "ws-worker",
			nowMs: () => clock.nowMs(),
			sleep: (ms) => clock.sleep(ms),
		});
		const record = await worker.waitForRecord(clock.nowMs() + 10);
		expect(record).toBeUndefined();
	});

	test("a stopped reader is reported rather than waited out", async () => {
		const worker = createSinkWorker<number>({
			armTransport: "ws-worker",
			nowMs: () => clock.nowMs(),
			sleep: (ms) => clock.sleep(ms),
		});
		const cause = new WebSocketTransportError("E_SESSION_CLOSED", "gone");
		worker.failReader(cause);
		const startedAtMs = clock.nowMs();
		expect(await worker.waitForRecord(clock.nowMs() + 5_000)).toBeUndefined();
		expect(clock.nowMs() - startedAtMs).toBeLessThan(1_000);
		expect(worker.takeReaderFailure()).toBe(cause);
		expect(worker.takeReaderFailure()).toBeUndefined();
	});
});
