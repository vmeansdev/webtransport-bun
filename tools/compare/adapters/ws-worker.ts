/**
 * The `ws-worker` arm: the WS wire, read off the leg's loop.
 *
 * This is a wrapper, not a second WebSocket implementation. The wire, the
 * envelope, the admission controller and every byte budget are the ones
 * `adapters/ws.ts` already applies, because the whole claim of the arm is that
 * only the *read path* differs from the `ws` primary it shadows. A second
 * protocol here would make the two arms incomparable, which is the one thing
 * the comparison cannot survive.
 *
 * What the wrapper changes is where the inbound bytes are pulled. The base
 * session's reads run in a pump that is its own scheduling unit, and the leg
 * takes records out of a bounded queue instead of awaiting the socket. That is
 * the honest content of "off-loop" in a single-process harness: there is no
 * worker thread, because `node:worker_threads` is a forbidden import on a
 * role-child module and a real thread would need a second copy of the
 * envelope codec on the far side of a structured clone. The arm's declared
 * `readPathThreadModel` still comes from `ARM_READ_PATH` in `evidence.ts` and
 * is not restated here.
 *
 * What the wrapper does not change is the loop reading. Because the reads run
 * on this loop, the session's `busyMs` is the base session's meter and the
 * wrapper publishes it unchanged; the queue depth and the queue's own drops
 * are added to the base counts rather than substituted for them.
 */
import { ARM_WIRE } from "../evidence.ts";
import {
	createSinkWorker,
	runSinkPump,
	type SinkWorker,
	type SinkWorkerStats,
} from "./sink-worker.ts";
import type {
	BidiChannel,
	ChannelConfig,
	ClientConfig,
	DeliveryKind,
	ReceiveChannel,
	SendChannel,
	ServerConfig,
	ServerHandle,
	Session,
	SubmittedCapacityProfile,
	TransportAdapter,
	TransportClock,
	TransportMetrics,
} from "./transport.ts";
import { systemTransportClock, WebSocketTransportError } from "./transport.ts";

export const WS_WORKER_ARM_TRANSPORT = "ws-worker" as const;

/** Default per-read bound for the pump when no consumer deadline is pending. */
export const WS_WORKER_DEFAULT_READ_TIMEOUT_MS = 5_000;

export interface WsWorkerAdapterOptions {
	readonly clock?: TransportClock;
	readonly maxQueuedItems?: number;
	readonly maxQueuedBytes?: number;
	readonly readTimeoutMs?: number;
}

/**
 * A `TransportAdapter` that names the read-path arm it measures.
 *
 * The extra members are read by the campaign controller so the arm's queue
 * accounting reaches the artifact as an observation rather than as a claim
 * the controller composes on its own.
 */
export interface ReadPathTransportAdapter extends TransportAdapter {
	readonly armTransport: "ws-worker" | "wt-stream-sink";
	readPathDiagnostics(): readonly SinkWorkerStats[];
}

type WireMessageOf = Awaited<ReturnType<Session["receiveMessage"]>>;

interface PumpedQueue<T> {
	readonly worker: SinkWorker<T>;
	running: boolean;
}

interface WrapContext {
	readonly clock: TransportClock;
	readonly maxQueuedItems: number | undefined;
	readonly maxQueuedBytes: number | undefined;
	readonly readTimeoutMs: number;
	readonly collect: (worker: SinkWorker<unknown>) => void;
}

function newQueue<T>(context: WrapContext): PumpedQueue<T> {
	const worker = createSinkWorker<T>({
		armTransport: WS_WORKER_ARM_TRANSPORT,
		nowMs: () => context.clock.nowMs(),
		sleep: (milliseconds) => context.clock.sleep(milliseconds),
		...(context.maxQueuedItems !== undefined
			? { maxQueuedItems: context.maxQueuedItems }
			: {}),
		...(context.maxQueuedBytes !== undefined
			? { maxQueuedBytes: context.maxQueuedBytes }
			: {}),
	});
	context.collect(worker as SinkWorker<unknown>);
	return { worker, running: false };
}

/**
 * Take one record from the queue, or report why none arrived.
 *
 * A reader failure is rethrown verbatim so the leg sees the code the base
 * adapter produced -- `E_SESSION_CLOSED` stays `E_SESSION_CLOSED` and does not
 * become a timeout just because it crossed a queue on the way.
 */
async function takeOrThrow<T>(
	queue: PumpedQueue<T>,
	deadlineMs: number,
	what: string,
): Promise<T> {
	const record = await queue.worker.waitForRecord(deadlineMs);
	if (record !== undefined) return record;
	const failure = queue.worker.takeReaderFailure();
	if (failure !== undefined) throw failure;
	throw new WebSocketTransportError(
		"E_BACKPRESSURE_TIMEOUT",
		`ws-worker: ${what} produced no record before the deadline`,
	);
}

function wrapSession(base: Session, context: WrapContext): Session {
	const messageQueues = new Map<DeliveryKind, PumpedQueue<WireMessageOf>>();
	const readerWorkers: SinkWorker<unknown>[] = [];
	// The pump reads at least as far out as the consumer is prepared to wait,
	// so a long-deadline leg does not have its reader time out underneath it.
	let latestConsumerDeadlineMs = 0;

	const track = (worker: SinkWorker<unknown>): void => {
		readerWorkers.push(worker);
		context.collect(worker);
	};

	const trackingContext: WrapContext = { ...context, collect: track };

	const pumpDeadline = (proposedMs: number): number =>
		Math.max(proposedMs, latestConsumerDeadlineMs);

	const ensureMessagePump = (
		kind: DeliveryKind,
	): PumpedQueue<WireMessageOf> => {
		let queue = messageQueues.get(kind);
		if (queue === undefined) {
			queue = newQueue<WireMessageOf>(trackingContext);
			messageQueues.set(kind, queue);
		}
		if (queue.running) return queue;
		const started = queue;
		started.running = true;
		void runSinkPump<WireMessageOf>({
			worker: started.worker,
			nowMs: () => context.clock.nowMs(),
			sleep: (milliseconds) => context.clock.sleep(milliseconds),
			readTimeoutMs: context.readTimeoutMs,
			read: async (deadlineMs) => {
				const message = await base.receiveMessage(
					kind,
					pumpDeadline(deadlineMs),
				);
				return { value: message, bytes: message.payload.byteLength };
			},
		}).finally(() => {
			started.running = false;
		});
		return started;
	};

	const wrapReceive = (channel: ReceiveChannel): ReceiveChannel => {
		const queue = newQueue<Uint8Array | null>(trackingContext);
		let ended = false;
		const ensureChannelPump = (): void => {
			if (queue.running || ended) return;
			queue.running = true;
			// End of stream is both a record and the last one: the leg has to
			// observe the null to know the channel finished, and the reader has
			// to stop after handing it over rather than reading a closed
			// channel forever.
			let readerSawEnd = false;
			void runSinkPump<Uint8Array | null>({
				worker: queue.worker,
				nowMs: () => context.clock.nowMs(),
				sleep: (milliseconds) => context.clock.sleep(milliseconds),
				readTimeoutMs: context.readTimeoutMs,
				read: async (deadlineMs) => {
					if (readerSawEnd) return null;
					const chunk = await channel.read(pumpDeadline(deadlineMs));
					if (chunk === null) readerSawEnd = true;
					return { value: chunk, bytes: chunk?.byteLength ?? 0 };
				},
			}).finally(() => {
				queue.running = false;
			});
		};
		return {
			channelId: channel.channelId,
			async read(deadlineMs: number): Promise<Uint8Array | null> {
				if (ended) return null;
				latestConsumerDeadlineMs = Math.max(
					latestConsumerDeadlineMs,
					deadlineMs,
				);
				ensureChannelPump();
				const chunk = await takeOrThrow(queue, deadlineMs, "channel read");
				if (chunk === null) ended = true;
				return chunk;
			},
			async cancel(deadlineMs: number): Promise<void> {
				ended = true;
				queue.worker.close();
				await channel.cancel(deadlineMs);
			},
		};
	};

	const wrapBidi = (channel: BidiChannel): BidiChannel => {
		const receive = wrapReceive(channel);
		return {
			channelId: channel.channelId,
			write: (bytes, deadlineMs) => channel.write(bytes, deadlineMs),
			end: (deadlineMs) => channel.end(deadlineMs),
			read: (deadlineMs) => receive.read(deadlineMs),
			cancel: (deadlineMs) => receive.cancel(deadlineMs),
		};
	};

	return {
		get role(): string {
			return base.role;
		},

		sendMessage: (kind, message, deadlineMs) =>
			base.sendMessage(kind, message, deadlineMs),

		async receiveMessage(
			kind: DeliveryKind,
			deadlineMs: number,
		): Promise<WireMessageOf> {
			latestConsumerDeadlineMs = Math.max(latestConsumerDeadlineMs, deadlineMs);
			const queue = ensureMessagePump(kind);
			return await takeOrThrow(queue, deadlineMs, `${kind} receive`);
		},

		sendText: (text, deadlineMs) => base.sendText(text, deadlineMs),

		openUni: (deadlineMs: number, config?: ChannelConfig) =>
			base.openUni(deadlineMs, config) as Promise<SendChannel>,

		async acceptUni(deadlineMs: number): Promise<ReceiveChannel> {
			return wrapReceive(await base.acceptUni(deadlineMs));
		},

		async openBidi(
			deadlineMs: number,
			config?: ChannelConfig,
		): Promise<BidiChannel> {
			return wrapBidi(await base.openBidi(deadlineMs, config));
		},

		async acceptBidi(deadlineMs: number): Promise<BidiChannel> {
			return wrapBidi(await base.acceptBidi(deadlineMs));
		},

		async close(deadlineMs: number): Promise<void> {
			for (const worker of readerWorkers) worker.close();
			await base.close(deadlineMs);
		},

		snapshot(): TransportMetrics {
			const metrics = base.snapshot();
			if (readerWorkers.length === 0) return metrics;
			let queuedItems = 0;
			let queuedBytes = 0;
			let droppedByQueue = 0;
			for (const worker of readerWorkers) {
				const stats = worker.stats();
				queuedItems += stats.queuedItems;
				queuedBytes += stats.queuedBytes;
				droppedByQueue += stats.dropped;
			}
			// `loopUtilization` is the base session's, untouched. The reads
			// this arm moves into their own scheduling unit still run on this
			// loop, and the base session's meter is what charges them, with
			// the suspension paused out. The figure the wrapper used to
			// publish instead was the wall time across `await read()` --
			// exactly the suspension `SESSION_LOOP_BUSY_MS_DEFINITION`
			// excludes -- so it overstated a parked reader and understated a
			// busy one.
			return {
				...metrics,
				dropped: metrics.dropped + droppedByQueue,
				receiveQueueItems: metrics.receiveQueueItems + queuedItems,
				receiveQueueBytes: metrics.receiveQueueBytes + queuedBytes,
			};
		},
	};
}

/**
 * Wrap a WS adapter into the `ws-worker` read-path arm.
 *
 * Refuses a non-WS base: `ARM_WIRE["ws-worker"]` is `"ws"`, and an arm that
 * rides a wire its identity does not declare is refused downstream by
 * `armIdentityIssue`. Failing here names the mistake at construction instead.
 */
export function createWsWorkerAdapter(
	base: TransportAdapter,
	options: WsWorkerAdapterOptions = {},
): ReadPathTransportAdapter {
	const wire = ARM_WIRE[WS_WORKER_ARM_TRANSPORT];
	if (base.kind !== wire) {
		throw new RangeError(
			`createWsWorkerAdapter: ws-worker rides the ${wire} wire; got base adapter kind ${base.kind}`,
		);
	}
	const clock = options.clock ?? systemTransportClock;
	const workers: SinkWorker<unknown>[] = [];
	const context: WrapContext = {
		clock,
		maxQueuedItems: options.maxQueuedItems,
		maxQueuedBytes: options.maxQueuedBytes,
		readTimeoutMs: options.readTimeoutMs ?? WS_WORKER_DEFAULT_READ_TIMEOUT_MS,
		collect: (worker) => {
			workers.push(worker);
		},
	};
	return {
		kind: wire,
		armTransport: WS_WORKER_ARM_TRANSPORT,

		get submittedCapacityProfile(): SubmittedCapacityProfile {
			return base.submittedCapacityProfile;
		},

		startServer(config: ServerConfig): Promise<ServerHandle> {
			// The arm is a client-side read path. The server is the same server
			// the `ws` primary measures against, byte for byte.
			return base.startServer(config);
		},

		async connect(config: ClientConfig): Promise<Session> {
			return wrapSession(await base.connect(config), context);
		},

		readPathDiagnostics(): readonly SinkWorkerStats[] {
			return workers.map((worker) => worker.stats());
		},
	};
}
