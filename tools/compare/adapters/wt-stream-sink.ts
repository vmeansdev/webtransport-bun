/**
 * The `wt-stream-sink` arm: the WT wire, read through a parking sink.
 *
 * Like `ws-worker`, this is a wrapper over the primary adapter and not a
 * second WebTransport implementation: the arm's claim is that only the read
 * path differs from the `wt` primary it shadows, and a second protocol would
 * make the pair incomparable.
 *
 * What separates it from `ws-worker` is the overflow behaviour, and that is
 * derived rather than authored: `ARM_SHEDDING_POLICY["wt-stream-sink"]` is
 * `"wire-throttle"`, so `sink-worker.ts` parks the reader when the queue is
 * full instead of dropping. A parked reader stops draining the session, the
 * sender's QUIC flow control notices, and nothing is shed to keep a queue
 * depth looking healthy. That is the property the sink arm exists to measure.
 *
 * ## Native `openReadSink` on this branch
 *
 * The product ships `openReadSink` (see `packages/webtransport/src/sink.ts`),
 * but it takes a *native* recv handle and hands back a `SharedArrayBuffer`
 * plus a descriptor for a consuming worker to read with `SinkReader`. The
 * comparison harness talks to WT through the `Session` / `ReceiveChannel`
 * facade in `adapters/transport.ts`, which deliberately exposes no native
 * handle -- both arms have to see the same surface or the comparison is
 * measuring the facade rather than the transport. So there is no honest way to
 * reach the native ring from here today.
 *
 * Rather than pretend otherwise, the native path is a declared injection
 * point: a caller that *can* resolve a native handle supplies `nativeHandleFor`
 * and `openReadSink`, and the adapter reports `sinkMode: "native-read-sink"`.
 * With neither supplied, the adapter runs the documented best-effort path --
 * the same parking off-loop reader, over the facade -- and reports
 * `sinkMode: "facade-park"`. `sinkDiagnostics()` states which one ran, so a
 * sealed leg records what actually happened instead of inheriting the stronger
 * claim by association.
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

export const WT_STREAM_SINK_ARM_TRANSPORT = "wt-stream-sink" as const;

/** Default per-read bound for the reader when no consumer deadline is pending. */
export const WT_STREAM_SINK_DEFAULT_READ_TIMEOUT_MS = 5_000;

/**
 * Which read path actually ran.
 *
 * `"native-read-sink"` means the product's `openReadSink` opened a native ring
 * on a real handle. `"facade-park"` means the documented best-effort path: the
 * parking off-loop reader over the comparison facade.
 */
export type WtStreamSinkMode = "native-read-sink" | "facade-park";

/** The subset of the product sink handle this adapter needs. */
export interface NativeReadSinkHandle {
	stats(): { readonly records: number; readonly bytesIn: number };
	close(): Promise<void>;
}

export interface WtStreamSinkAdapterOptions {
	readonly clock?: TransportClock;
	readonly maxQueuedItems?: number;
	readonly maxQueuedBytes?: number;
	readonly readTimeoutMs?: number;
	/**
	 * Resolve the native recv handle behind a comparison receive channel.
	 *
	 * Returns undefined when the channel has no native handle to offer, which
	 * is every channel the WT adapter produces on this branch.
	 */
	readonly nativeHandleFor?: (channel: ReceiveChannel) => unknown;
	/** The product's `openReadSink`, injected so this module imports no package. */
	readonly openReadSink?: (handle: unknown) => NativeReadSinkHandle;
}

export interface WtStreamSinkDiagnostics {
	readonly armTransport: "wt-stream-sink";
	/** What the injected seams make possible. */
	readonly configuredMode: WtStreamSinkMode;
	/** What actually ran. */
	readonly sinkMode: WtStreamSinkMode;
	readonly nativeSinksOpened: number;
	readonly queues: readonly SinkWorkerStats[];
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
	readonly nativeHandleFor: ((channel: ReceiveChannel) => unknown) | undefined;
	readonly openReadSink:
		| ((handle: unknown) => NativeReadSinkHandle)
		| undefined;
	readonly collect: (worker: SinkWorker<unknown>) => void;
	readonly noteNativeSink: () => void;
}

function newQueue<T>(context: WrapContext): PumpedQueue<T> {
	const worker = createSinkWorker<T>({
		armTransport: WT_STREAM_SINK_ARM_TRANSPORT,
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
		`wt-stream-sink: ${what} produced no record before the deadline`,
	);
}

function wrapSession(base: Session, context: WrapContext): Session {
	const messageQueues = new Map<DeliveryKind, PumpedQueue<WireMessageOf>>();
	const readerWorkers: SinkWorker<unknown>[] = [];
	const nativeSinks: NativeReadSinkHandle[] = [];
	const sessionOpenedAtMs = context.clock.nowMs();
	let latestConsumerDeadlineMs = 0;

	const trackingContext: WrapContext = {
		...context,
		collect: (worker) => {
			readerWorkers.push(worker);
			context.collect(worker);
		},
	};

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

	/**
	 * Open the product sink on a channel when the caller gave us a way to.
	 *
	 * Both seams have to be present and the handle has to be real; anything
	 * less falls back to the facade path rather than half-claiming a native
	 * read.
	 */
	const tryNativeSink = (
		channel: ReceiveChannel,
	): NativeReadSinkHandle | undefined => {
		const resolve = context.nativeHandleFor;
		const open = context.openReadSink;
		if (resolve === undefined || open === undefined) return undefined;
		const handle = resolve(channel);
		if (handle === undefined || handle === null) return undefined;
		const sink = open(handle);
		nativeSinks.push(sink);
		context.noteNativeSink();
		return sink;
	};

	const wrapReceive = (channel: ReceiveChannel): ReceiveChannel => {
		tryNativeSink(channel);
		const queue = newQueue<Uint8Array | null>(trackingContext);
		let ended = false;
		const ensureChannelPump = (): void => {
			if (queue.running || ended) return;
			queue.running = true;
			// End of stream is both a record and the last one: the leg observes
			// the null to know the channel finished, and the reader stops after
			// handing it over instead of reading a closed channel forever.
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
			for (const sink of nativeSinks) await sink.close();
			await base.close(deadlineMs);
		},

		snapshot(): TransportMetrics {
			const metrics = base.snapshot();
			if (readerWorkers.length === 0) return metrics;
			let busyMs = 0;
			let queuedItems = 0;
			let queuedBytes = 0;
			for (const worker of readerWorkers) {
				const stats = worker.stats();
				busyMs += stats.busyMs;
				queuedItems += stats.queuedItems;
				queuedBytes += stats.queuedBytes;
			}
			// No drop term: a parking reader does not shed, so there is nothing
			// to add to the base session's dropped count. A sink arm reporting
			// queue drops would be reporting a policy it does not run.
			return {
				...metrics,
				receiveQueueItems: metrics.receiveQueueItems + queuedItems,
				receiveQueueBytes: metrics.receiveQueueBytes + queuedBytes,
				loopUtilization: {
					busyMs,
					windowMs: Math.max(0, context.clock.nowMs() - sessionOpenedAtMs),
				},
			};
		},
	};
}

export interface WtStreamSinkAdapter extends TransportAdapter {
	readonly armTransport: "wt-stream-sink";
	readPathDiagnostics(): readonly SinkWorkerStats[];
	sinkDiagnostics(): WtStreamSinkDiagnostics;
}

/**
 * Wrap a WT adapter into the `wt-stream-sink` read-path arm.
 *
 * Refuses a non-WT base for the same reason `createWsWorkerAdapter` refuses a
 * non-WS one: `ARM_WIRE["wt-stream-sink"]` is `"wt"`, and an arm riding a wire
 * its identity does not declare is refused downstream anyway.
 */
export function createWtStreamSinkAdapter(
	base: TransportAdapter,
	options: WtStreamSinkAdapterOptions = {},
): WtStreamSinkAdapter {
	const wire = ARM_WIRE[WT_STREAM_SINK_ARM_TRANSPORT];
	if (base.kind !== wire) {
		throw new RangeError(
			`createWtStreamSinkAdapter: wt-stream-sink rides the ${wire} wire; got base adapter kind ${base.kind}`,
		);
	}
	const clock = options.clock ?? systemTransportClock;
	const workers: SinkWorker<unknown>[] = [];
	let nativeSinksOpened = 0;
	const context: WrapContext = {
		clock,
		maxQueuedItems: options.maxQueuedItems,
		maxQueuedBytes: options.maxQueuedBytes,
		readTimeoutMs:
			options.readTimeoutMs ?? WT_STREAM_SINK_DEFAULT_READ_TIMEOUT_MS,
		nativeHandleFor: options.nativeHandleFor,
		openReadSink: options.openReadSink,
		collect: (worker) => {
			workers.push(worker);
		},
		noteNativeSink: () => {
			nativeSinksOpened += 1;
		},
	};
	const declaredMode: WtStreamSinkMode =
		options.nativeHandleFor !== undefined && options.openReadSink !== undefined
			? "native-read-sink"
			: "facade-park";
	return {
		kind: wire,
		armTransport: WT_STREAM_SINK_ARM_TRANSPORT,

		get submittedCapacityProfile(): SubmittedCapacityProfile {
			return base.submittedCapacityProfile;
		},

		startServer(config: ServerConfig): Promise<ServerHandle> {
			return base.startServer(config);
		},

		async connect(config: ClientConfig): Promise<Session> {
			return wrapSession(await base.connect(config), context);
		},

		readPathDiagnostics(): readonly SinkWorkerStats[] {
			return workers.map((worker) => worker.stats());
		},

		sinkDiagnostics(): WtStreamSinkDiagnostics {
			// `configuredMode` is what the injected seams allow; `sinkMode` is
			// what ran. They differ whenever a native path was wired up and no
			// channel could produce a handle for it, and that difference is
			// exactly the thing a sealed leg must not round up.
			return {
				armTransport: WT_STREAM_SINK_ARM_TRANSPORT,
				configuredMode: declaredMode,
				sinkMode: nativeSinksOpened > 0 ? "native-read-sink" : "facade-park",
				nativeSinksOpened,
				queues: workers.map((worker) => worker.stats()),
			};
		},
	};
}
