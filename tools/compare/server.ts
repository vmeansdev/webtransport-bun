/**
 * Task 10: Server CLI entry point (Linux side), and the echo peer behind it.
 *
 * A3 Phase-A attested bulk cells keep the registry's completion-based
 * `bulk-one-way/physical` topology (linux-to-mac / server-opened-uni) and
 * emit `BulkSourceCompletionV1` nested in the attested snapshot frame.
 *
 * Usage:
 *   bun tools/compare/server.ts --transport <ws|wt> --scenario <id> --port <port> --bind <ip> --tls-cert <cert> --tls-key <key>
 *
 * Strict argument parsing. Rejects loopback addresses in measurement mode.
 *
 * The peer is what makes the client's `receivedAtMs` mean anything: it hands
 * each message straight back on the delivery kind it arrived on, so a client
 * sample is a round trip through two adapters and the wire between them rather
 * than a locally computed number. Like the driver, it never reads which
 * transport it is running on.
 */

import {
	type DeliveryKind,
	type ServerHandle,
	type Session,
	systemTransportClock,
	type TransportAdapter,
	type TransportClock,
} from "./adapters/transport.ts";
import {
	type BinaryMessageServerSession,
	createWebSocketAdapter,
	startBinaryMessageServer,
} from "./adapters/ws.ts";
import {
	createWebTransportAdapter,
	LengthPrefixedFrameReader,
	type LengthPrefixedWriter,
	nodeWritableFrameWriter,
	productionWtAdapterOptions,
	webWritableFrameWriter,
	type WtServerHandle,
} from "./adapters/wt.ts";
import {
	CHILD_PIPE_CONTROL_MAX_BYTES,
	CHILD_PIPE_REFUSAL_CODES,
	type ChildPipeRefusalCode,
	buildChildPipeRefusal,
	buildServerReady,
	buildServerStopped,
	buildServerWarmupReady,
	createServerChildLifecycle,
	decodeChildPipeFrame,
	decodeServerChildFrame,
	encodeChildPipeFrame,
	parseServerBindExecution,
	RoleChildFrameReader,
	type ServerBindExecutionV1,
	type ServerChildLifecycle,
	stepServerChildLifecycle,
} from "./child-pipe-protocol.ts";
import { COHORT_CONNECTION_RATE_PER_SECOND } from "./cohort-protocol.ts";
import {
	parseMacReceiptSignature,
	type ProtocolResult,
	verifyMacReceiptSignature,
} from "./cross-supervisor-protocol.ts";
import {
	closeSync,
	fstatSync,
	read as nodeFsRead,
	write as nodeFsWrite,
} from "node:fs";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import {
	canonicalRecordBytes,
	parseStrictJsonBytes,
	sha256HexOfBytes,
} from "./secure-fs.ts";
import {
	FanoutLinuxAuthority,
	type FanoutLinuxLoopObserverV1,
	type FanoutRelay,
	type RelayClock,
	type RelaySessionSink,
} from "./scenarios/fanout-relay.ts";
import { FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES } from "./scenarios/fanout-wire.ts";
import {
	SCENARIO_IDS,
	type BulkParameters,
	type ScenarioCell,
	type ScenarioId,
} from "./types.ts";

/**
 * What this process is: an echo peer, the bulk source, or the Linux side of a
 * Phase B fanout cohort. The mode is explicit rather than inferred from the
 * scenario because the cohort mode serves a relay built from a Mac-signed
 * grant, and there is no scenario id that could imply that authorisation.
 */
export type ServerMode = "echo" | "bulk-source" | "fanout-cohort";

export const SERVER_MODES: readonly ServerMode[] = [
	"echo",
	"bulk-source",
	"fanout-cohort",
];

export interface ServerArgs {
	readonly transport: "ws" | "wt";
	readonly scenario: ScenarioId;
	readonly mode: ServerMode;
	readonly port: number;
	readonly bind: string;
	readonly runId: string;
	readonly tlsCert?: string;
	readonly tlsKey?: string;
	readonly help?: boolean;
}

const LOOPBACK_IPS = ["127.0.0.1", "::1", "localhost", "0.0.0.0"];

/**
 * The exact argv a staged server launch record carries for `transport`.
 *
 * The record is minted at stage time and then bound by the Mac-signed execution
 * receipt, so its argv cannot be adjusted at run time to match whatever the
 * parser happens to accept. This is the one definition of that argv, exported
 * so the stager and the parser cannot drift apart: a test parses this and the
 * stager writes it.
 */
export function stagedServerLaunchArgv(
	transport: "ws" | "wt",
	mode: ServerMode,
): readonly string[] {
	return ["server.ts", `--transport=${transport}`, `--mode=${mode}`];
}

export function parseServerArgs(argv: readonly string[]): ServerArgs {
	let transport: "ws" | "wt" = "wt";
	let scenario: ScenarioId = "chat-fanout";
	let mode: ServerMode | undefined;
	let port = 4433;
	let bind = "10.99.0.2";
	let runId = `run-srv-${Date.now()}`;
	let tlsCert: string | undefined;
	let tlsKey: string | undefined;
	let help = false;

	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i]!;
		// `--flag=value` and `--flag value` are the same flag. The staged launch
		// record uses the joined form, so a parser that only understood the
		// split form would refuse the very argv the campaign signs.
		const split = raw.indexOf("=");
		const joined = raw.startsWith("--") && split > 2;
		const arg = joined ? raw.slice(0, split) : raw;
		const take = (): string | undefined =>
			joined ? raw.slice(split + 1) : argv[++i];

		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--transport") {
			const val = take();
			if (val !== "ws" && val !== "wt") {
				throw new Error(`Invalid --transport: ${val}; expected 'ws' or 'wt'`);
			}
			transport = val;
		} else if (arg === "--scenario") {
			const val = take() as ScenarioId;
			if (!SCENARIO_IDS.includes(val)) {
				throw new Error(`Invalid --scenario: ${val}`);
			}
			scenario = val;
		} else if (arg === "--mode") {
			const val = take() as ServerMode;
			if (!SERVER_MODES.includes(val)) {
				throw new Error(`Invalid --mode: ${val}`);
			}
			mode = val;
		} else if (arg === "--port") {
			const val = parseInt(take() ?? "", 10);
			if (isNaN(val) || val <= 0 || val > 65535) {
				throw new Error(`Invalid --port: ${val}`);
			}
			port = val;
		} else if (arg === "--bind") {
			bind = take() ?? "";
			if (!bind) throw new Error("Missing value for --bind");
		} else if (arg === "--run-id") {
			runId = take() ?? "";
			if (!runId) throw new Error("Missing value for --run-id");
		} else if (arg === "--tls-cert") {
			tlsCert = take();
		} else if (arg === "--tls-key") {
			tlsKey = take();
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (LOOPBACK_IPS.includes(bind)) {
		throw new Error(
			`Refusing loopback bind address '${bind}'; all comparison runs must use physical cable (10.99.0.2)`,
		);
	}

	return {
		transport,
		scenario,
		// Without an explicit mode the process behaves exactly as it did before
		// the mode existed: bulk-one-way is the source, everything else echoes.
		mode: mode ?? (scenario === "bulk-one-way" ? "bulk-source" : "echo"),
		port,
		bind,
		runId,
		tlsCert,
		tlsKey,
		help,
	};
}

export function printServerHelp(): void {
	console.log(`
WebTransport vs WebSocket Comparison Server

Usage:
  bun tools/compare/server.ts [options]

Options:
  --transport <ws|wt>      Transport to use (default: wt)
  --scenario <id>          Scenario ID (default: chat-fanout)
  --mode <mode>            echo | bulk-source | fanout-cohort
                           (default: bulk-source for bulk-one-way, else echo)
  --port <port>            Port to listen on (default: 4433)
  --bind <ip>              IP address to bind to (default: 10.99.0.2)
  --run-id <id>            Run ID for evidence attribution
  --tls-cert <file>        Path to TLS certificate PEM
  --tls-key <file>         Path to TLS private key PEM
  --help, -h               Show this help message
`);
}

/** What the peer did for one session, so a caller can assert on it. */
export interface EchoedSession {
	readonly echoed: number;
	readonly stopped: "peer-closed" | "limit-reached";
}

/**
 * Echo every message this session sends back to it.
 *
 * `messageLimit` bounds the loop so a test can drive it to completion; a
 * production run states the count the client will send. The kind a message came
 * in on is the kind it goes back out on — a datagram leg is never quietly
 * upgraded to a reliable one on the return path, which would have made the
 * client's measured latency a different thing on each arm.
 */
export async function echoSession(input: {
	readonly session: Session;
	readonly deliveryKind: DeliveryKind;
	readonly messageLimit: number;
	readonly clock: TransportClock;
	readonly perMessageTimeoutMs: number;
}): Promise<EchoedSession> {
	let echoed = 0;
	while (echoed < input.messageLimit) {
		let message: Awaited<ReturnType<Session["receiveMessage"]>>;
		try {
			message = await input.session.receiveMessage(
				input.deliveryKind,
				input.clock.nowMs() + input.perMessageTimeoutMs,
			);
		} catch {
			return { echoed, stopped: "peer-closed" };
		}
		await input.session.sendMessage(
			input.deliveryKind,
			message,
			input.clock.nowMs() + input.perMessageTimeoutMs,
		);
		echoed++;
	}
	return { echoed, stopped: "limit-reached" };
}

/** Accept sessions on a started server and echo each one in turn. */
export async function runEchoPeer(input: {
	readonly server: ServerHandle;
	readonly deliveryKind: DeliveryKind;
	readonly sessionCount: number;
	readonly messageLimit: number;
	readonly clock: TransportClock;
	readonly acceptTimeoutMs: number;
	readonly perMessageTimeoutMs: number;
}): Promise<readonly EchoedSession[]> {
	const results: EchoedSession[] = [];
	for (let index = 0; index < input.sessionCount; index++) {
		const session = await input.server.acceptSession(
			input.clock.nowMs() + input.acceptTimeoutMs,
		);
		results.push(
			await echoSession({
				session,
				deliveryKind: input.deliveryKind,
				messageLimit: input.messageLimit,
				clock: input.clock,
				perMessageTimeoutMs: input.perMessageTimeoutMs,
			}),
		);
	}
	return results;
}

/** Chunk count for a bulk transfer of `bytes` in pieces of at most `chunkBytes`. */
export function bulkChunkSchedule(
	bytes: number,
	chunkBytes: number,
): { chunkCount: number } {
	if (
		!Number.isFinite(bytes) ||
		bytes <= 0 ||
		!Number.isFinite(chunkBytes) ||
		chunkBytes <= 0
	) {
		throw new RangeError(
			`bulkChunkSchedule: bytes and chunkBytes must be finite positive; got bytes=${bytes} chunkBytes=${chunkBytes}`,
		);
	}
	return { chunkCount: Math.ceil(bytes / chunkBytes) };
}

/**
 * Accept one session and act as the bulk-one-way source: open a uni channel,
 * write `ceil(bytes / chunkBytes)` pattern-filled chunks (sequence starting at
 * 1, matching `generateBulkPayload` / `executeBulkOneWay`), then end the channel.
 */
export async function runBulkSourcePeer(input: {
	readonly server: ServerHandle;
	readonly bytes: number;
	readonly chunkBytes: number;
	readonly clock: TransportClock;
	readonly acceptTimeoutMs: number;
	readonly writeTimeoutMs: number;
}): Promise<{ readonly chunksWritten: number; readonly bytesWritten: number }> {
	const { chunkCount } = bulkChunkSchedule(input.bytes, input.chunkBytes);
	const session = await input.server.acceptSession(
		input.clock.nowMs() + input.acceptTimeoutMs,
	);
	const channel = await session.openUni(
		input.clock.nowMs() + input.writeTimeoutMs,
	);

	let remaining = input.bytes;
	let bytesWritten = 0;
	for (let sequence = 1; sequence <= chunkCount; sequence++) {
		const size = Math.min(input.chunkBytes, remaining);
		const chunk = new Uint8Array(size);
		chunk.fill(sequence & 0xff);
		await channel.write(chunk, input.clock.nowMs() + input.writeTimeoutMs);
		remaining -= size;
		bytesWritten += size;
	}
	await channel.end(input.clock.nowMs() + input.writeTimeoutMs);

	return { chunksWritten: chunkCount, bytesWritten };
}

// ---------------------------------------------------------------------------
// Fanout relay peer (WS mapping, plan §4.2)
//
// The echo peer above answers one session at a time; the fanout relay is the
// opposite shape -- every publisher and subscriber of a cohort is connected at
// once and the relay decides what crosses between them. This binds the
// transport-agnostic engine to real WebSocket sockets and does nothing else:
// admission, ordinals, queues, barriers and counters all stay in the engine.
// Nothing in the Phase A seal path calls it.
// ---------------------------------------------------------------------------

/** Everything a caller can learn about one relay session over WS. */
export interface FanoutRelayWsSessionEvent {
	readonly sessionId: string;
	readonly session: BinaryMessageServerSession;
}

/** What the relay did with one inbound message, in arrival order per session. */
export interface FanoutRelayWsInboundEvent {
	readonly sessionId: string;
	readonly result: ProtocolResult<true>;
}

export interface FanoutRelayWsPeerOptions {
	readonly relay: FanoutRelay;
	readonly hostname?: string;
	/** `0` binds an ephemeral port; read the bound one back from the peer. */
	readonly port?: number;
	readonly tls?: Parameters<typeof startBinaryMessageServer>[0]["tls"];
	readonly onSession?: (event: FanoutRelayWsSessionEvent) => void;
	readonly onInbound?: (event: FanoutRelayWsInboundEvent) => void;
	readonly onSessionClosed?: (event: { readonly sessionId: string }) => void;
	/**
	 * The wall time one turn of relay work took, in fractional milliseconds.
	 *
	 * This is the same reading the Phase-A sink worker takes around its own
	 * handler (`adapters/sink-worker.ts:227`): the loop is busy while it is
	 * inside the relay, and idle otherwise. It is reported per span rather than
	 * accumulated here because the peer has no business owning a measurement --
	 * `createCohortServerLoopObserver` sums it, and only the authority decides
	 * when a sum becomes a number on a frame.
	 */
	readonly onRelayWork?: (elapsedMs: number) => void;
}

export interface FanoutRelayWsPeer {
	readonly port: number;
	readonly url: string;
	/** The socket the relay writes this session through, for a caller that must gate it. */
	sessionFor(sessionId: string): BinaryMessageServerSession | undefined;
	stop(): Promise<void>;
}

/**
 * Run `relay` behind a WebSocket listener, one binary message per frame.
 *
 * A socket is a relay session from the instant it opens, before it has proved
 * which role it is: the engine's admission rules are what decide that, and
 * they need a session to refuse on. Inbound bytes go to the engine verbatim,
 * and the pump runs after every message and every drain, which is what turns a
 * `would-block` into a retry rather than a lost delivery.
 */
export function serveFanoutRelayOverWebSocket(
	options: FanoutRelayWsPeerOptions,
): FanoutRelayWsPeer {
	const relay = options.relay;
	if (relay.config.transport !== "ws") {
		throw new Error(
			`serveFanoutRelayOverWebSocket requires a ws relay; got ${relay.config.transport}`,
		);
	}
	const sessionIdBySocketId = new Map<number, string>();
	const socketBySessionId = new Map<string, BinaryMessageServerSession>();
	const timed = <T>(work: () => T): T => {
		if (options.onRelayWork === undefined) return work();
		const startedAt = performance.now();
		try {
			return work();
		} finally {
			options.onRelayWork(performance.now() - startedAt);
		}
	};

	const server = startBinaryMessageServer({
		hostname: options.hostname ?? "127.0.0.1",
		port: options.port ?? 0,
		...(options.tls ? { tls: options.tls } : {}),
		handlers: {
			onOpen: (session) => {
				const sink: RelaySessionSink = {
					trySend: (bytes) => session.send(bytes),
					close: (reason) => {
						session.close(reason);
					},
				};
				const sessionId = timed(() => relay.openSession(sink));
				sessionIdBySocketId.set(session.id, sessionId);
				socketBySessionId.set(sessionId, session);
				options.onSession?.({ sessionId, session });
			},
			onMessage: (session, bytes) => {
				const sessionId = sessionIdBySocketId.get(session.id);
				if (sessionId === undefined) return;
				const result = timed(() => {
					const inbound = relay.handleInboundBytes(sessionId, bytes);
					relay.pump();
					return inbound;
				});
				options.onInbound?.({ sessionId, result });
			},
			onDrain: () => {
				timed(() => relay.pump());
			},
			onClose: (session) => {
				const sessionId = sessionIdBySocketId.get(session.id);
				if (sessionId === undefined) return;
				sessionIdBySocketId.delete(session.id);
				socketBySessionId.delete(sessionId);
				timed(() => relay.closeSession(sessionId, "peer disconnected"));
				options.onSessionClosed?.({ sessionId });
			},
		},
	});

	const host = options.hostname ?? "127.0.0.1";
	return {
		port: server.port,
		url: `${options.tls ? "wss" : "ws"}://${host}:${server.port}/fanout`,
		sessionFor: (sessionId) => socketBySessionId.get(sessionId),
		stop: async () => {
			// The listener is released synchronously. Bun's `stop` promise waits
			// for connections to drain and never settles once the server has
			// closed a socket itself -- which the relay does on every shutdown --
			// so awaiting it would hang instead of releasing the port.
			const drained = server.stop(true);
			if (drained instanceof Promise) drained.catch(() => {});
		},
	};
}

// ---------------------------------------------------------------------------
// Fanout relay peer (WT mapping, plan §4.2 / §4.3)
//
// Same engine, same sink contract, different channel mapping:
// `wt-publisher-bidi-subscriber-control-bidi-server-uni`. Every role holds one
// control bidi stream, and the server opens exactly one uni stream per
// subscriber for delivery. Both carry `u32be length || frame`. Which channel a
// frame belongs on is decided by the frame itself, so the engine never learns
// there are two of them. Nothing in the Phase A seal path calls it.
// ---------------------------------------------------------------------------

/** The parts of a native WT server session this peer drives. */
interface FanoutWtNativeServerSession {
	readonly id: string;
	readonly closed: Promise<unknown>;
	close(info?: unknown): void;
	readonly incomingBidirectionalStreams: ReadableStream<{
		readable: ReadableStream<Uint8Array>;
		writable: Parameters<typeof webWritableFrameWriter>[0];
	}>;
	createUnidirectionalStream(
		options?: unknown,
	): Promise<Parameters<typeof nodeWritableFrameWriter>[0]>;
}

/** What a caller can do to one relay session's WT streams. */
export interface FanoutRelayWtSession {
	/** Frames handed to this session's streams, control and delivery together. */
	readonly sentMessages: number;
	readonly closed: boolean;
	readonly paused: boolean;
	/**
	 * Stop writing to this peer. Every send answers `would-block` until
	 * `resume()`, which is how a server declines to feed a peer it has decided
	 * is not keeping up, rather than buffering without bound on its behalf.
	 */
	pause(): void;
	resume(): void;
	close(reason?: string): void;
}

export interface FanoutRelayWtSessionEvent {
	readonly sessionId: string;
	readonly session: FanoutRelayWtSession;
}

/** What the relay did with one inbound frame, in arrival order per session. */
export interface FanoutRelayWtInboundEvent {
	readonly sessionId: string;
	readonly result: ProtocolResult<true>;
}

export interface FanoutRelayWtPeerOptions {
	readonly relay: FanoutRelay;
	readonly hostname?: string;
	/** `0` binds an ephemeral port; read the bound one back from the peer. */
	readonly port?: number;
	/** Empty PEMs ask the native server for a self-signed development identity. */
	readonly tls?: { readonly certPem?: string; readonly keyPem?: string };
	readonly onSession?: (event: FanoutRelayWtSessionEvent) => void;
	readonly onInbound?: (event: FanoutRelayWtInboundEvent) => void;
	readonly onSessionClosed?: (event: { readonly sessionId: string }) => void;
	/** See `FanoutRelayWsPeerOptions.onRelayWork`: one span of relay work. */
	readonly onRelayWork?: (elapsedMs: number) => void;
}

export interface FanoutRelayWtPeer {
	readonly port: number;
	readonly url: string;
	sessionFor(sessionId: string): FanoutRelayWtSession | undefined;
	stop(): Promise<void>;
}

/** How long a closing session waits for its streams to flush before resetting. */
const WT_SESSION_FLUSH_DEADLINE_MS = 2_000;

/** Delivery rides the server-opened uni stream; everything else is control. */
function isRelayDeliveryFrame(frame: {
	kind: string;
	direction?: string;
}): boolean {
	return (
		(frame.kind === "data" || frame.kind === "warmup-data") &&
		frame.direction === "relay-to-subscriber"
	);
}

/**
 * The WT listener's admission for one registered cohort (amendment C5).
 *
 * Every role session of a cohort arrives from one client host -- the Mac --
 * so the native per-IP and per-/24 session counters (`crates/native/src/
 * rate_limit.rs:149-197`, charged at `lib.rs:900-918` before the global
 * `maxSessions` check) must each admit the whole registered session count, and
 * the global cap is that same count: chat 10k is 10,010 sessions. The
 * handshake token bucket starts full at `handshakesBurst` and refills at
 * `handshakesPerSec` (`rate_limit.rs:240-265`), so the burst is the cohort and
 * the refill is the registered ramp, 500 connections a second. Nothing here
 * touches the package's stream/datagram/byte defaults: `createServer` merges
 * these four keys over `DEFAULT_RATE_LIMITS` and `DEFAULT_LIMITS`
 * (`packages/webtransport/src/index.ts:2403-2406`).
 */
export function cohortWtListenerAdmission(cohort: {
	readonly publisherCount: number;
	readonly subscriberCount: number;
}): {
	readonly maxSessions: number;
	readonly handshakesPerSec: number;
	readonly handshakesBurst: number;
	readonly handshakesBurstPerPrefix: number;
} {
	if (
		!Number.isSafeInteger(cohort.publisherCount) ||
		cohort.publisherCount < 1 ||
		!Number.isSafeInteger(cohort.subscriberCount) ||
		cohort.subscriberCount < 1
	) {
		throw new RangeError(
			`a cohort listener needs positive publisher and subscriber counts, not ${cohort.publisherCount}/${cohort.subscriberCount}`,
		);
	}
	const sessions = cohort.publisherCount + cohort.subscriberCount;
	return {
		maxSessions: sessions,
		handshakesPerSec: COHORT_CONNECTION_RATE_PER_SECOND,
		handshakesBurst: sessions,
		handshakesBurstPerPrefix: sessions,
	};
}

/**
 * Run `relay` behind a native WebTransport listener.
 *
 * A WT session is a relay session from the instant it is established, before it
 * has proved which role it is or opened its control stream: the engine's
 * admission rules are what decide that, and they need a session to refuse on.
 * The delivery stream is opened when -- and only when -- a registration is
 * admitted as a subscriber, so a publisher never costs a uni stream and a
 * subscriber's first delivery never waits on one.
 */
export async function serveFanoutRelayOverWebTransport(
	options: FanoutRelayWtPeerOptions,
): Promise<FanoutRelayWtPeer> {
	const relay = options.relay;
	if (relay.config.transport !== "wt") {
		throw new Error(
			`serveFanoutRelayOverWebTransport requires a wt relay; got ${relay.config.transport}`,
		);
	}
	// The same busy accounting the ws peer keeps: the loop is busy while it is
	// inside the relay. See `FanoutRelayWsPeerOptions.onRelayWork`.
	const timed = <T>(work: () => T): T => {
		if (options.onRelayWork === undefined) return work();
		const startedAt = performance.now();
		try {
			return work();
		} finally {
			options.onRelayWork(performance.now() - startedAt);
		}
	};
	const host = options.hostname ?? "127.0.0.1";
	const sessionsById = new Map<string, FanoutRelayWtSession>();

	const { serverFactory } = await productionWtAdapterOptions();
	const admission = cohortWtListenerAdmission({
		publisherCount: relay.config.publishers.length,
		subscriberCount: relay.config.expectedSubscriberIds.length,
	});
	const handle = serverFactory({
		host,
		port: options.port ?? 0,
		limits: { maxSessions: admission.maxSessions },
		rateLimits: {
			handshakesPerSec: admission.handshakesPerSec,
			handshakesBurst: admission.handshakesBurst,
			handshakesBurstPerPrefix: admission.handshakesBurstPerPrefix,
		},
		tls: {
			certPem: options.tls?.certPem ?? "",
			keyPem: options.tls?.keyPem ?? "",
		},
	}) as WtServerHandle & {
		onSession(callback: (session: unknown) => void): void;
	};

	handle.onSession((raw) => {
		const native = raw as FanoutWtNativeServerSession;
		let control: LengthPrefixedWriter | null = null;
		let delivery: LengthPrefixedWriter | null = null;
		let deliveryRequested = false;
		let paused = false;
		let closed = false;

		const openDeliveryStream = (): void => {
			if (deliveryRequested || closed) return;
			deliveryRequested = true;
			native
				.createUnidirectionalStream()
				.then((writable) => {
					if (closed) return;
					delivery = nodeWritableFrameWriter(writable, () => {
						timed(() => relay.pump());
					});
					timed(() => relay.pump());
				})
				.catch(() => {
					// The session went away before the stream opened; the engine
					// charges the queued deliveries when it observes the close.
					deliveryRequested = false;
				});
		};

		const sink: RelaySessionSink = {
			trySend: (bytes) => {
				if (closed) return "closed";
				if (paused) return "would-block";
				const decoded = relay.codec.decode(bytes);
				if (!decoded.ok) {
					throw new Error(
						`relay produced an undecodable frame: ${decoded.code}`,
					);
				}
				if (isRelayDeliveryFrame(decoded.value)) {
					if (delivery === null) {
						openDeliveryStream();
						return "would-block";
					}
					return delivery.trySend(bytes);
				}
				if (control === null) return "would-block";
				return control.trySend(bytes);
			},
			close: (reason) => {
				session.close(reason);
			},
		};

		const sessionId = timed(() => relay.openSession(sink));
		const session: FanoutRelayWtSession = {
			get sentMessages() {
				return (control?.sentFrames ?? 0) + (delivery?.sentFrames ?? 0);
			},
			get closed() {
				return closed;
			},
			get paused() {
				return paused;
			},
			pause: () => {
				paused = true;
			},
			resume: () => {
				paused = false;
			},
			close: () => {
				if (closed) return;
				closed = true;
				const writers = [control, delivery].filter(
					(writer): writer is LengthPrefixedWriter => writer !== null,
				);
				for (const writer of writers) writer.close();
				// A refusal or an end marker is written and the session is torn
				// down in the same breath. Closing the QUIC session first would
				// reset both streams under frames the engine has already counted
				// as sent, so the peer would never see them; the deadline is here
				// so a stream that never finishes cannot hold the session open.
				void Promise.race([
					Promise.all(writers.map((writer) => writer.flushed())),
					new Promise((resolve) =>
						setTimeout(resolve, WT_SESSION_FLUSH_DEADLINE_MS),
					),
				]).then(() => {
					try {
						native.close();
					} catch {
						// The session was already gone; it is closed either way.
					}
				});
			},
		};
		sessionsById.set(sessionId, session);
		options.onSession?.({ sessionId, session });

		void native.closed
			.then(() => {
				closed = true;
				sessionsById.delete(sessionId);
				timed(() => relay.closeSession(sessionId, "peer disconnected"));
				options.onSessionClosed?.({ sessionId });
			})
			.catch(() => {});

		// The control stream is the first bidi the role opens; a reliable stream
		// may split or coalesce writes anywhere, so frames are reassembled before
		// any of them reaches the engine.
		void (async () => {
			const streams = native.incomingBidirectionalStreams.getReader();
			const opened = await streams.read();
			if (opened.done || opened.value === undefined) return;
			control = webWritableFrameWriter(opened.value.writable, () => {
				timed(() => relay.pump());
			});
			timed(() => relay.pump());

			const inbound = opened.value.readable.getReader();
			const frames = new LengthPrefixedFrameReader(
				FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
			);
			for (;;) {
				const chunk = await inbound.read();
				if (chunk.done || chunk.value === undefined) return;
				for (const bytes of frames.push(chunk.value)) {
					const result = timed(() => {
						const inbound = relay.handleInboundBytes(sessionId, bytes);
						relay.pump();
						return inbound;
					});
					if (result.ok) {
						const decoded = relay.codec.decode(bytes);
						if (
							decoded.ok &&
							decoded.value.kind === "register" &&
							decoded.value.role === "subscriber"
						) {
							openDeliveryStream();
						}
					}
					options.onInbound?.({ sessionId, result });
				}
			}
		})().catch(() => {
			// A read that fails is a peer that went away; `closed` reports it.
		});
	});

	return {
		port: handle.address.port,
		url: `https://${host}:${handle.address.port}`,
		sessionFor: (sessionId) => sessionsById.get(sessionId),
		stop: async () => {
			await handle.close();
		},
	};
}

// ---------------------------------------------------------------------------
// Linux-authoritative cohort peer (B3, non-production integration entrypoint)
//
// The two peers above take a relay and serve it. This one takes the authority
// that owns a relay and refuses to bind a socket at all until a Mac-signed
// cohort grant has been verified and the server has been marked ready under it.
// Putting the check here as well as in `startServer` is the point: binding the
// listener is the execution point, and an unauthorised cohort must not reach a
// socket through any path, including a caller that built a relay by hand.
// ---------------------------------------------------------------------------

export interface FanoutCohortPeerOptions {
	readonly authority: FanoutLinuxAuthority;
	readonly hostname?: string;
	/** `0` binds an ephemeral port; read the bound one back from the peer. */
	readonly port?: number;
	readonly wsTls?: FanoutRelayWsPeerOptions["tls"];
	readonly wtTls?: FanoutRelayWtPeerOptions["tls"];
	readonly onSession?: (event: { readonly sessionId: string }) => void;
	readonly onInbound?: (event: {
		readonly sessionId: string;
		readonly result: ProtocolResult<true>;
	}) => void;
	readonly onSessionClosed?: (event: { readonly sessionId: string }) => void;
	/** See `FanoutRelayWsPeerOptions.onRelayWork`: one span of relay work. */
	readonly onRelayWork?: (elapsedMs: number) => void;
}

export interface FanoutCohortPeer {
	readonly transport: "ws" | "wt";
	readonly port: number;
	readonly url: string;
	stop(): Promise<void>;
}

/**
 * Serve the relay a verified cohort grant produced, over whichever transport
 * that grant named. The transport is not a parameter: taking it from the signed
 * grant is what stops a cohort admitted for one wire from being measured on the
 * other.
 */
export async function serveFanoutCohortRelay(
	options: FanoutCohortPeerOptions,
): Promise<ProtocolResult<FanoutCohortPeer>> {
	// `relayForServe` is the whole gate: no relay exists until a verified grant
	// has produced one, so an unauthorised cohort has nothing to bind a socket to.
	const relayResult = options.authority.relayForServe();
	if (!relayResult.ok) return relayResult;
	const relay = relayResult.value;
	const shared = {
		relay,
		...(options.hostname === undefined ? {} : { hostname: options.hostname }),
		...(options.port === undefined ? {} : { port: options.port }),
		...(options.onRelayWork ? { onRelayWork: options.onRelayWork } : {}),
		...(options.onSession
			? {
					onSession: (event: { readonly sessionId: string }) =>
						options.onSession?.({ sessionId: event.sessionId }),
				}
			: {}),
		...(options.onInbound ? { onInbound: options.onInbound } : {}),
		...(options.onSessionClosed
			? { onSessionClosed: options.onSessionClosed }
			: {}),
	};
	if (relay.config.transport === "ws") {
		const peer = serveFanoutRelayOverWebSocket({
			...shared,
			...(options.wsTls ? { tls: options.wsTls } : {}),
		});
		return {
			ok: true,
			value: {
				transport: "ws",
				port: peer.port,
				url: peer.url,
				stop: () => peer.stop(),
			},
		};
	}
	const peer = await serveFanoutRelayOverWebTransport({
		...shared,
		...(options.wtTls ? { tls: options.wtTls } : {}),
	});
	return {
		ok: true,
		value: {
			transport: "wt",
			port: peer.port,
			url: peer.url,
			stop: () => peer.stop(),
		},
	};
}

/**
 * The server loop's busy-time observer, and the only implementation of
 * `FanoutLinuxLoopObserverV1` in this tree.
 *
 * It is here rather than in `scenarios/fanout-relay.ts` because busy time is a
 * property of the *loop*, and the loop belongs to whoever serves the sockets:
 * the relay engine is a pure state machine that never learns how long a caller
 * spent inside it. The two transport peers above report each span of relay work
 * through `onRelayWork`, and this sums them.
 *
 * The reading is the same one Phase A takes -- wall time spent inside the
 * handler (`adapters/sink-worker.ts:227`), not process CPU -- so the two phases
 * mean the same thing by `busyMs`. Spans are summed as fractional milliseconds
 * and floored only at the read, because a per-message span is routinely well
 * under a millisecond and flooring each one would report zero for a loop that
 * was never idle.
 *
 * Whole non-negative milliseconds, monotonic by construction: the accumulator
 * only grows and `Math.floor` is monotone. The rig re-derives
 * `finalBusyMs - baselineBusyMs` and reads all three with `as_u64`
 * (`crates/native/src/secure_fs.rs:16826-16831`, `:12112-12117`), so a
 * fractional or shrinking reading would be refused there; it cannot arise here.
 *
 * There is deliberately no fallback: a child built without this observer does
 * not report a zero baseline, it refuses at `readBusyMs`
 * (`scenarios/fanout-relay.ts:2497`).
 */
export interface CohortServerLoopObserver extends FanoutLinuxLoopObserverV1 {
	/** One span of relay work, in fractional milliseconds. */
	record(elapsedMs: number): void;
}

export function createCohortServerLoopObserver(): CohortServerLoopObserver {
	let totalMs = 0;
	return {
		record: (elapsedMs) => {
			// A negative or non-finite span is a broken clock, not work.
			if (Number.isFinite(elapsedMs) && elapsedMs > 0) totalMs += elapsedMs;
		},
		busyMs: () => Math.floor(totalMs),
	};
}

/**
 * The server child's clock: wall time for the Mac's validity windows, and the
 * monotonic Linux clock for every `*AtLinuxNs` stamp on a §3.4 frame.
 *
 * The split is not a convenience. `notAfterMs` on a Mac-signed grant, epoch or
 * barrier is an epoch millisecond and can only be compared against one; the ns
 * stamps are differenced against each other on this host alone
 * (`loopUtilizationSnapshot` subtracts the barrier acceptance from the final
 * snapshot), and a wall clock that stepped between them would produce a
 * negative window. `linuxClockId` is what names which clock the ns readings are
 * on, and it comes from the staged environment rather than from here.
 */
export function createCohortServerClock(): RelayClock {
	return {
		nowMs: () => Date.now(),
		nowNs: () => `${process.hrtime.bigint()}`,
	} as RelayClock;
}

// ---------------------------------------------------------------------------
// Phase B fanout cohort mode: the stage-time half of the server child's inputs
// ---------------------------------------------------------------------------

/**
 * The environment names the staged launch record's `allowedEnvironment` carries
 * for the cohort mode.
 *
 * Only stage-time constants are here, and that split is the point. The staged
 * record is minted once, before any execution exists, and its
 * `allowedEnvironment` is a list of name/value pairs bound by the Mac-signed
 * execution receipt -- so anything that differs per execution (the execution
 * digest, the rig's acceptance digest, the cohort grant and its Mac signature)
 * *cannot* be an environment variable without either breaking that binding or
 * making the record per-execution. Those arrive over the child control pipe.
 */
export const FANOUT_COHORT_SERVER_ENV_NAMES = [
	"WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64",
	"WS_WT_COHORT_LINUX_CLOCK_ID",
	"WS_WT_COHORT_RECEIPT_VALIDITY_MS",
	// The staged TLS identity (amendment C4). The rig supervisor reads the two
	// staged leaves through its pinned staging root, checks them against the
	// launch record's `tlsCertificateSha256` / `tlsPrivateKeySha256`, and hands
	// this child their content under these three names. There is no argv or
	// file fallback in cohort mode: a child that could serve a certificate the
	// record did not bind would be serving an identity nobody staged.
	"WS_WT_TLS_CERT_CONTENT",
	"WS_WT_TLS_KEY_CONTENT",
	"WS_WT_TLS_SERVER_NAME",
] as const;

export interface FanoutCohortServerEnvironmentV1 {
	/** The one Mac key this server will accept a cohort grant from. */
	readonly stagedMacPublicRaw32: Uint8Array;
	readonly linuxClockId: string;
	readonly receiptValidityMs: number;
	/** The staged TLS identity, as the rig delivered it. */
	readonly tls: {
		readonly certPem: string;
		readonly keyPem: string;
		readonly serverName: string;
	};
}

/**
 * Read the cohort mode's stage-time inputs, refusing anything missing or
 * malformed. There is deliberately no default for any of them: a server that
 * fell back to an empty Mac key would accept a grant nobody signed.
 */
export function parseFanoutCohortServerEnvironment(env: {
	readonly [name: string]: string | undefined;
}): ProtocolResult<FanoutCohortServerEnvironmentV1> {
	const missing = FANOUT_COHORT_SERVER_ENV_NAMES.filter(
		(name) => (env[name] ?? "").length === 0,
	);
	if (missing.length > 0) {
		return {
			ok: false,
			code: "COHORT_NOT_READY",
			message: `fanout cohort mode requires ${missing.join(", ")}`,
		};
	}
	const keyBase64 = env.WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64 as string;
	let stagedMacPublicRaw32: Uint8Array;
	try {
		stagedMacPublicRaw32 = Uint8Array.from(Buffer.from(keyBase64, "base64"));
	} catch {
		return {
			ok: false,
			code: "COHORT_NOT_READY",
			message: "staged Mac public key is not base64",
		};
	}
	if (stagedMacPublicRaw32.byteLength !== 32) {
		return {
			ok: false,
			code: "COHORT_NOT_READY",
			message: `staged Mac public key is ${stagedMacPublicRaw32.byteLength} bytes, not 32`,
		};
	}
	const validityMs = Number.parseInt(
		env.WS_WT_COHORT_RECEIPT_VALIDITY_MS as string,
		10,
	);
	if (!Number.isSafeInteger(validityMs) || validityMs <= 0) {
		return {
			ok: false,
			code: "COHORT_NOT_READY",
			message: "receipt validity must be a positive integer of milliseconds",
		};
	}
	const certPem = env.WS_WT_TLS_CERT_CONTENT as string;
	const keyPem = env.WS_WT_TLS_KEY_CONTENT as string;
	if (
		!certPem.includes("-----BEGIN CERTIFICATE-----") ||
		!keyPem.includes("-----BEGIN") ||
		!keyPem.includes("PRIVATE KEY-----")
	) {
		return {
			ok: false,
			code: "COHORT_NOT_READY",
			message:
				"staged TLS identity is not a PEM certificate and a PEM private key",
		};
	}
	return {
		ok: true,
		value: {
			stagedMacPublicRaw32,
			linuxClockId: env.WS_WT_COHORT_LINUX_CLOCK_ID as string,
			receiptValidityMs: validityMs,
			tls: {
				certPem,
				keyPem,
				serverName: env.WS_WT_TLS_SERVER_NAME as string,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Phase B fanout cohort mode: the server child's control pipe
// ---------------------------------------------------------------------------

/**
 * §3.4: "FD 3 is supervisor->child read-only in the child; FD 4 is
 * child->supervisor write-only in the child."
 */
export const FANOUT_COHORT_CONTROL_READ_FD = 3;
export const FANOUT_COHORT_CONTROL_WRITE_FD = 4;

/** What a verified `server-bind-execution/v1` authorises this child to bind. */
export interface CohortBindDecisionV1 {
	readonly executionSha256: string;
	readonly rigExecutionAcceptanceSha256: string;
	readonly cohortGrantSha256: string;
	/** The wire the signed grant named; never one the caller chose. */
	readonly transport: "ws" | "wt";
	/**
	 * The grant and its signature as records, from the one decode that verified
	 * them.
	 *
	 * `FanoutLinuxAuthority.acceptCohortGrant` needs the records, not the
	 * digests, and it re-verifies the signature itself -- which is the point:
	 * the two checks are independent. What must not happen is a *second decode*
	 * of the same base64 in the bind listener, because two readers of one byte
	 * string are two chances to disagree about what it said. So the bytes are
	 * parsed once, here, and the records travel.
	 */
	readonly grantRecord: unknown;
	readonly grantSignatureRecord: unknown;
}

function strictBase64(text: string): Uint8Array | null {
	const bytes = Uint8Array.from(Buffer.from(text, "base64"));
	// `Buffer.from` never throws; it stops at the first byte it cannot use, so
	// the only way to tell a truncated or mistyped encoding from a real one is
	// to re-encode and compare.
	if (Buffer.from(bytes).toString("base64") !== text) return null;
	return bytes;
}

/**
 * Decide whether this child may bind a listener for the cohort the rig named.
 *
 * §4.2 requires the grant to be verified against the **staged** Mac public key
 * before a listener exists. The signature record the frame carries names a
 * signing key digest, and that digest is *checked* against the staged key —
 * it never selects one. A child that let the record choose its own verifier
 * would accept a grant signed by whoever wrote the frame.
 */
export function decideCohortBind(args: {
	readonly bind: ServerBindExecutionV1;
	readonly stagedMacPublicRaw32: Uint8Array;
}): ProtocolResult<CohortBindDecisionV1> {
	const { bind } = args;
	if (
		bind.cohortGrantBase64 === null ||
		bind.cohortGrantSignatureBase64 === null
	) {
		// `parseServerBindExecution` already refuses the half-null pairing, so
		// this is the Phase-A bind shape. In cohort mode there is no cohort to
		// serve, and a listener without a grant is exactly what §4.2 forbids.
		return {
			ok: false,
			code: "COHORT_NOT_READY",
			message: "server-bind-execution/v1 carries no cohort grant",
		};
	}
	const grantBytes = strictBase64(bind.cohortGrantBase64);
	if (grantBytes === null) {
		return { ok: false, code: "COHORT_PROTOCOL", message: "grant not base64" };
	}
	const signatureBytes = strictBase64(bind.cohortGrantSignatureBase64);
	if (signatureBytes === null) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: "grant signature not base64",
		};
	}
	const signatureJson = parseStrictJsonBytes(signatureBytes);
	if (!signatureJson.ok) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: `grant signature record: ${signatureJson.reason}`,
		};
	}
	const signature = parseMacReceiptSignature(signatureJson.value);
	if (!signature.ok) return signature;
	if (signature.value.signedSchema !== "cohort-grant/v1") {
		return {
			ok: false,
			code: "MAC_GRANT_SIGNATURE_INVALID",
			message: `signature covers ${signature.value.signedSchema}`,
		};
	}
	const verified = verifyMacReceiptSignature({
		stagedMacPublicRaw32: args.stagedMacPublicRaw32,
		signedBytes: grantBytes,
		signature: signature.value,
	});
	if (!verified.ok) return verified;
	const grantJson = parseStrictJsonBytes(grantBytes);
	if (!grantJson.ok) {
		return {
			ok: false,
			code: "COHORT_PROTOCOL",
			message: `cohort grant: ${grantJson.reason}`,
		};
	}
	const grant = grantJson.value as Record<string, unknown>;
	// Deliberately narrow: this decides whether a *listener* may exist, and the
	// three things that decision turns on are that the Mac signed these bytes,
	// that they name this execution, and which wire they name. The rig
	// supervisor has already run `CohortGrantV1::parse_signed` over the same
	// bytes and refuses to spawn this child otherwise.
	//
	// The full §4.1 codec does run in this process, one step later: a cohort
	// relay is built out of the grant's publishers, shards, commitment root,
	// window count and message size, so `FanoutLinuxAuthority.acceptCohortGrant`
	// (`scenarios/fanout-relay.ts:2522`) parses all of it before
	// `serveFanoutCohortRelay` has anything to serve. The reason that is a
	// second opinion rather than a split-brain is that the one reading the two
	// codecs used to disagree on is now pinned equal on both sides: TS refuses
	// unless `lastSubscriberIndexExclusive === grantSubscriberCount`
	// (`cohort-protocol.ts:361`) and Rust runs
	// `expect_count(entry, "lastSubscriberIndexExclusive", subscriber_count)`
	// (`crates/native/src/secure_fs.rs:12556`).
	//
	// What stays true is the ordering: the narrow check gates the socket, the
	// full codec gates the relay, and a grant that fails either never reaches
	// a peer.
	if (grant.schema !== "cohort-grant/v1") {
		return { ok: false, code: "COHORT_PROTOCOL", message: "grant schema" };
	}
	// The frame and the signed record must name one execution. They are two
	// different statements about which execution this is, and only the signed
	// one is authenticated -- so a disagreement is the frame lying, not a
	// detail to reconcile.
	if (grant.executionSha256 !== bind.executionSha256) {
		return {
			ok: false,
			code: "EXECUTION_MISMATCH",
			message: "the grant names a different execution than the bind frame",
		};
	}
	if (grant.transport !== "ws" && grant.transport !== "wt") {
		return { ok: false, code: "COHORT_PROTOCOL", message: "grant transport" };
	}
	return {
		ok: true,
		value: {
			executionSha256: bind.executionSha256,
			rigExecutionAcceptanceSha256: bind.rigExecutionAcceptanceSha256,
			cohortGrantSha256: sha256HexOfBytes(grantBytes),
			transport: grant.transport,
			grantRecord: grantJson.value,
			grantSignatureRecord: signature.value,
		},
	};
}

/** The two halves of the child's control pipe, injectable so tests can drive it. */
export interface CohortControlPipeIo {
	/** One read; `null` is EOF. */
	readonly read: () => Promise<Uint8Array | null>;
	readonly write: (bytes: Uint8Array) => Promise<void>;
	readonly close?: () => void;
}

/** What the child does once the rig has authorised the bind. */
export interface CohortServerBinding {
	readonly listeningAddress: string;
	readonly childPid: number;
	readonly childPgid: number;
	readonly childInstanceNonce: string;
	/**
	 * The authority whose relay this binding serves.
	 *
	 * It is optional because a binding is allowed to be a bare listener, and a
	 * bare listener can honestly answer exactly two §5 transitions: the bind and
	 * the warmup epoch, neither of which reports a relay counter. Everything
	 * after them -- the drain, the baseline, the barrier, the capture -- is a
	 * statement about traffic, and a child with no relay has none to state. So
	 * the absence is not a default that stands in for a measurement: it is the
	 * point at which the loop stops and the rig reads EOF, which is the same
	 * refusal this entrypoint made before it could serve a cohort at all.
	 *
	 * The production path always supplies one (`import.meta.main` below).
	 */
	readonly authority?: FanoutLinuxAuthority;
	readonly stop: () => Promise<void> | void;
}

export interface FanoutCohortChildResultV1 {
	readonly decision: CohortBindDecisionV1;
	readonly binding: CohortServerBinding;
	readonly warmupEpochSha256: string;
	/** How many of §5's seven C->R frames the child actually wrote. */
	readonly framesAnswered: number;
}

/** Plan §3.5: any child control write/ack. */
const CHILD_CONTROL_DEADLINE_MS = 5_000;
/** Plan §3.5: the ack grace a declared phase gets on top of its own length. */
const CHILD_ACK_GRACE_MS = 1_000;
/** Plan §3.5: graceful child teardown. */
const CHILD_TEARDOWN_DEADLINE_MS = 10_000;
/** How often the child re-asks the relay whether the cohort is complete. */
const COHORT_ADMISSION_POLL_MS = 20;

/**
 * A frame's own refusal code where the codec produced one, and the transition's
 * code otherwise.
 *
 * The §3.4 refusal set is closed. `decodeServerChildFrame` and
 * `stepServerChildLifecycle` already answer in it -- `FRAME_INVALID`,
 * `SEQUENCE_INVALID`, `STATE_INVALID` -- and those are the most informative
 * codes available, so they pass through. The authority answers in the §7 set
 * (`COHORT_NOT_READY`, `WARMUP_PROTOCOL`, `RELAY_DELIVERY`, ...), which is a
 * different closed set with no member-for-member mapping; naming a §3.4 code
 * that happened to look similar would be a translation this side is not
 * entitled to make. Those collapse to the transition's own code, and the
 * authority's own code and message go to stderr where they are still readable.
 */
function childRefusalCodeFor(
	code: string,
	fallback: ChildPipeRefusalCode,
): ChildPipeRefusalCode {
	return (CHILD_PIPE_REFUSAL_CODES as readonly string[]).includes(code)
		? (code as ChildPipeRefusalCode)
		: fallback;
}

/** One base64 field on a §3.4 frame, as the exact bytes and the record in them. */
function recordFromFrameBase64(
	value: unknown,
	what: string,
): ProtocolResult<{ readonly bytes: Uint8Array; readonly record: unknown }> {
	if (typeof value !== "string") {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: `${what} is not a string`,
		};
	}
	const bytes = strictBase64(value);
	if (bytes === null) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: `${what} is not base64`,
		};
	}
	const json = parseStrictJsonBytes(bytes);
	if (!json.ok) {
		return {
			ok: false,
			code: "FRAME_INVALID",
			message: `${what}: ${json.reason}`,
		};
	}
	return { ok: true, value: { bytes, record: json.value } };
}

/**
 * Drive the server child through §5, from `server-bind-execution/v1` to
 * `server-teardown/v1`, over the real §3.4 codec.
 *
 * Seven frames each way in one frozen order, with an independent sequence per
 * direction: `createServerChildLifecycle` owns both, so a skipped, repeated or
 * out-of-state frame is refused by the same state machine the rig's own reader
 * uses rather than by an order this function reimplemented.
 *
 * Every answer is read off the relay the bind produced. Nothing here computes a
 * counter, a timestamp or a busy reading: the authority does, from what it
 * observed, and this function's whole job is to decide which question to ask it
 * and to put the answer on the wire unmodified.
 *
 * A failure after the bind is a `child-pipe-refusal/v1` and then silence --
 * terminal in both directions, per §3.4. A failure *before* the bind is
 * silence alone: until the grant verifies against the staged Mac key there is
 * no authenticated execution digest, and a refusal frame naming the digest the
 * unverified frame happened to carry would be this child vouching for it.
 */
export async function runFanoutCohortServerChild(args: {
	readonly io: CohortControlPipeIo;
	readonly stagedMacPublicRaw32: Uint8Array;
	/** Binds a listener; called only after the grant verified. */
	readonly bindListener: (
		decision: CohortBindDecisionV1,
	) => Promise<CohortServerBinding>;
}): Promise<ProtocolResult<FanoutCohortChildResultV1>> {
	const reader = new RoleChildFrameReader(CHILD_PIPE_CONTROL_MAX_BYTES);
	const pending: Uint8Array[] = [];
	const lifecycle: ServerChildLifecycle = createServerChildLifecycle();

	/** One read, bounded by `deadlineMs` from now. */
	const readBounded = async (
		deadlineMs: number,
	): Promise<Uint8Array | null | "deadline"> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<"deadline">((resolve) => {
			timer = setTimeout(() => resolve("deadline"), deadlineMs);
			// A pending deadline must not be what keeps the process alive.
			(timer as { unref?: () => void }).unref?.();
		});
		try {
			return await Promise.race([args.io.read(), expiry]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	};

	const receive = async (
		deadlineMs: number,
		onDeadline: ChildPipeRefusalCode,
	): Promise<ProtocolResult<Record<string, unknown>>> => {
		for (;;) {
			const framed = pending.shift();
			if (framed !== undefined) {
				const decoded = decodeServerChildFrame(framed);
				if (!decoded.ok) return decoded;
				const stepped = stepServerChildLifecycle(lifecycle, "rigToChild", {
					schema: decoded.value.schema as string,
					sequence: decoded.value.sequence as number,
				});
				if (!stepped.ok) return stepped;
				return { ok: true, value: decoded.value };
			}
			const chunk = await readBounded(deadlineMs);
			if (chunk === "deadline") {
				return {
					ok: false,
					code: onDeadline,
					message: "control pipe deadline",
				};
			}
			if (chunk === null) {
				return { ok: false, code: "UNEXPECTED_EOF", message: "control pipe" };
			}
			const pushed = reader.push(chunk);
			if (!pushed.ok) return pushed;
			pending.push(...pushed.value);
		}
	};

	const send = async (
		payload: Record<string, unknown> & { schema: string },
	): Promise<ProtocolResult<true>> => {
		const stepped = stepServerChildLifecycle(lifecycle, "childToRig", {
			schema: payload.schema,
			sequence: payload.sequence as number,
		});
		if (!stepped.ok) return stepped;
		const framed = encodeChildPipeFrame(payload, CHILD_PIPE_CONTROL_MAX_BYTES);
		if (!framed.ok) return framed;
		await args.io.write(framed.value);
		return { ok: true, value: true };
	};

	const first = await receive(
		CHILD_CONTROL_DEADLINE_MS,
		"BIND_DEADLINE_EXCEEDED",
	);
	if (!first.ok) return first;
	const bind = parseServerBindExecution(first.value);
	if (!bind.ok) return bind;
	const decision = decideCohortBind({
		bind: bind.value,
		stagedMacPublicRaw32: args.stagedMacPublicRaw32,
	});
	if (!decision.ok) return decision;

	// Only now does a listener exist.
	const binding = await args.bindListener(decision.value);
	const executionSha256 = decision.value.executionSha256;
	let framesAnswered = 0;

	/**
	 * Answer a failed transition with the one frame §3.4 has for it, then stop.
	 *
	 * The refusal is written before the result is returned so the rig reads a
	 * typed code rather than the EOF a caller's own error handling would leave.
	 */
	const refuse = async (
		failure: { readonly code: string; readonly message?: string },
		fallback: ChildPipeRefusalCode,
	): Promise<ProtocolResult<never>> => {
		const code = childRefusalCodeFor(failure.code, fallback);
		console.error(
			`[fanout-cohort] refusing: ${failure.code}${failure.message ? `: ${failure.message}` : ""} -> ${code}`,
		);
		const refusal = buildChildPipeRefusal({
			sequence: lifecycle.childToRig.sequence,
			executionSha256,
			code,
		});
		if (refusal.ok) {
			await send(
				refusal.value as unknown as Record<string, unknown> & {
					schema: string;
				},
			);
		}
		return { ok: false, code, message: failure.message ?? failure.code };
	};

	/** Every R->C frame names the execution this child was bound to, or it lies. */
	const sameExecution = (frame: Record<string, unknown>): boolean =>
		frame.executionSha256 === executionSha256;

	const authority = binding.authority;

	// -- C->R 0: server-ready ------------------------------------------------
	let readyFrame: Record<string, unknown> & { schema: string };
	if (authority === undefined) {
		const built = buildServerReady({
			sequence: lifecycle.childToRig.sequence,
			executionSha256,
			childPid: binding.childPid,
			childPgid: binding.childPgid,
			childInstanceNonce: binding.childInstanceNonce,
			cohortGrantSha256: decision.value.cohortGrantSha256,
			listeningAddress: binding.listeningAddress,
		});
		if (!built.ok) return built;
		readyFrame = built.value as unknown as Record<string, unknown> & {
			schema: string;
		};
	} else {
		// The authority states the child's identity because it was constructed
		// with it; a second statement of the same pid from the binding could
		// disagree with the one the relay observation carries.
		const built = authority.serverReady({
			sequence: lifecycle.childToRig.sequence,
			listeningAddress: binding.listeningAddress,
		});
		if (!built.ok) return await refuse(built, "CHILD_LIFECYCLE");
		readyFrame = built.value.frame as unknown as Record<string, unknown> & {
			schema: string;
		};
	}
	const ready = await send(readyFrame);
	if (!ready.ok) return ready;
	framesAnswered += 1;

	// -- R->C 1 / C->R 1: the warmup epoch -----------------------------------
	const grant = authority?.grant ?? null;
	const readinessDeadlineMs =
		grant === null ? CHILD_CONTROL_DEADLINE_MS : grant.readinessDeadlineMs;
	const second = await receive(readinessDeadlineMs, "READY_DEADLINE_EXCEEDED");
	if (!second.ok) return await refuse(second, "READY_DEADLINE_EXCEEDED");
	if (!sameExecution(second.value)) {
		return await refuse(
			{ code: "EXECUTION_MISMATCH", message: "warmup start" },
			"EXECUTION_MISMATCH",
		);
	}
	const epoch = recordFromFrameBase64(
		second.value.cohortWarmupEpochBase64,
		"warmup epoch",
	);
	if (!epoch.ok) return await refuse(epoch, "FRAME_INVALID");
	// The digest is over the epoch's *exact* bytes as they arrived. Re-encoding
	// the parsed record would name a record this child minted, not the one the
	// rig signed and is about to compare against.
	const warmupEpochSha256 = sha256HexOfBytes(epoch.value.bytes);
	if (authority !== undefined) {
		// §5 RAMP_AND_READY: the cohort came up on the wire, peer by peer, and
		// this is the point at which the child asserts it is complete and exact
		// (`scenarios/fanout-relay.ts:2842`). The rig only sends warmup-start
		// once the Mac's permit schedule has released every ordinal, so the wait
		// is for sockets already in flight, not for a cohort that has not begun.
		const admissionDeadline = Date.now() + readinessDeadlineMs;
		let admitted = authority.admitWireRegisteredCohort();
		while (!admitted.ok && Date.now() < admissionDeadline) {
			await new Promise((resolve) =>
				setTimeout(resolve, COHORT_ADMISSION_POLL_MS),
			);
			admitted = authority.admitWireRegisteredCohort();
		}
		if (!admitted.ok) return await refuse(admitted, "READY_DEADLINE_EXCEEDED");
		const signature = recordFromFrameBase64(
			second.value.cohortWarmupEpochSignatureBase64,
			"warmup epoch signature",
		);
		if (!signature.ok) return await refuse(signature, "FRAME_INVALID");
		const opened = authority.acceptWarmupEpoch({
			epoch: epoch.value.record,
			signature: signature.value.record,
			nowMs: Date.now(),
		});
		if (!opened.ok) return await refuse(opened, "CHILD_LIFECYCLE");
		if (opened.value.cohortWarmupEpochSha256 !== warmupEpochSha256) {
			return await refuse(
				{ code: "COHORT_MISMATCH", message: "warmup epoch digest" },
				"COHORT_MISMATCH",
			);
		}
	}
	const warmupReady = buildServerWarmupReady({
		sequence: lifecycle.childToRig.sequence,
		executionSha256,
		cohortWarmupEpochSha256: warmupEpochSha256,
	});
	if (!warmupReady.ok) return await refuse(warmupReady, "CHILD_LIFECYCLE");
	const sentWarmupReady = await send(
		warmupReady.value as unknown as Record<string, unknown> & {
			schema: string;
		},
	);
	if (!sentWarmupReady.ok) return sentWarmupReady;
	framesAnswered += 1;

	if (authority === undefined || grant === null) {
		// A bare listener has said everything it can say honestly. Returning
		// closes the control pipe, which the rig reads as EOF and refuses.
		return {
			ok: true,
			value: {
				decision: decision.value,
				binding,
				warmupEpochSha256,
				framesAnswered,
			},
		};
	}

	// -- R->C 2 / C->R 2: drain and reset ------------------------------------
	const third = await receive(
		grant.inRepetitionWarmupMs + CHILD_ACK_GRACE_MS,
		"WARMUP_DEADLINE_EXCEEDED",
	);
	if (!third.ok) return await refuse(third, "WARMUP_DEADLINE_EXCEEDED");
	if (!sameExecution(third.value)) {
		return await refuse(
			{ code: "EXECUTION_MISMATCH", message: "warmup drain" },
			"EXECUTION_MISMATCH",
		);
	}
	if (third.value.cohortWarmupEpochSha256 !== warmupEpochSha256) {
		return await refuse(
			{ code: "COHORT_MISMATCH", message: "drain names another warmup epoch" },
			"COHORT_MISMATCH",
		);
	}
	// The wire has to be proven against the signed epoch *before* the drain,
	// because the drain resets the counters the proof reads.
	const proven = authority.runWarmupWire();
	if (!proven.ok) return await refuse(proven, "CHILD_LIFECYCLE");
	const drained = authority.drainWarmup({
		sequence: lifecycle.childToRig.sequence,
		roleWarmupCompletionManifestSha256: third.value
			.roleWarmupCompletionManifestSha256 as string,
	});
	if (!drained.ok) return await refuse(drained, "CHILD_LIFECYCLE");
	const sentDrained = await send(
		drained.value.frame as unknown as Record<string, unknown> & {
			schema: string;
		},
	);
	if (!sentDrained.ok) return sentDrained;
	framesAnswered += 1;

	// -- R->C 3 / C->R 3: the Linux baseline ---------------------------------
	const fourth = await receive(
		CHILD_CONTROL_DEADLINE_MS,
		"MEASURE_DEADLINE_EXCEEDED",
	);
	if (!fourth.ok) return await refuse(fourth, "MEASURE_DEADLINE_EXCEEDED");
	if (!sameExecution(fourth.value)) {
		return await refuse(
			{ code: "EXECUTION_MISMATCH", message: "measure start" },
			"EXECUTION_MISMATCH",
		);
	}
	const baseline = authority.measureStartAck({
		sequence: lifecycle.childToRig.sequence,
	});
	if (!baseline.ok) return await refuse(baseline, "CHILD_LIFECYCLE");
	const sentBaseline = await send(
		baseline.value.frame as unknown as Record<string, unknown> & {
			schema: string;
		},
	);
	if (!sentBaseline.ok) return sentBaseline;
	framesAnswered += 1;

	// -- R->C 4 / C->R 4: the start barrier ----------------------------------
	const fifth = await receive(
		CHILD_CONTROL_DEADLINE_MS,
		"MEASURE_DEADLINE_EXCEEDED",
	);
	if (!fifth.ok) return await refuse(fifth, "MEASURE_DEADLINE_EXCEEDED");
	if (!sameExecution(fifth.value)) {
		return await refuse(
			{ code: "EXECUTION_MISMATCH", message: "start barrier" },
			"EXECUTION_MISMATCH",
		);
	}
	const barrier = recordFromFrameBase64(
		fifth.value.cohortStartBarrierBase64,
		"start barrier",
	);
	if (!barrier.ok) return await refuse(barrier, "FRAME_INVALID");
	const barrierSignature = recordFromFrameBase64(
		fifth.value.cohortStartBarrierSignatureBase64,
		"start barrier signature",
	);
	if (!barrierSignature.ok) {
		return await refuse(barrierSignature, "FRAME_INVALID");
	}
	const accepted = authority.acceptStartBarrier({
		barrier: barrier.value.record,
		signature: barrierSignature.value.record,
		sequence: lifecycle.childToRig.sequence,
		nowMs: Date.now(),
	});
	if (!accepted.ok) return await refuse(accepted, "CHILD_LIFECYCLE");
	const sentAccepted = await send(
		accepted.value.frame as unknown as Record<string, unknown> & {
			schema: string;
		},
	);
	if (!sentAccepted.ok) return sentAccepted;
	framesAnswered += 1;

	// -- R->C 5 / C->R 5: stop and capture -----------------------------------
	// The measured window is the rig's to close, so the child waits out the
	// declared duration plus the stop grace and the drain (plan §3.5).
	const sixth = await receive(
		grant.measuredDurationMs + CHILD_ACK_GRACE_MS + grant.drainDeadlineMs,
		"DRAIN_DEADLINE_EXCEEDED",
	);
	if (!sixth.ok) return await refuse(sixth, "DRAIN_DEADLINE_EXCEEDED");
	if (!sameExecution(sixth.value)) {
		return await refuse(
			{ code: "EXECUTION_MISMATCH", message: "stop and capture" },
			"EXECUTION_MISMATCH",
		);
	}
	const window = authority.runMeasuredWindow();
	if (!window.ok) return await refuse(window, "CHILD_LIFECYCLE");
	const capture = authority.captureAck({
		sequence: lifecycle.childToRig.sequence,
	});
	if (!capture.ok) return await refuse(capture, "CHILD_LIFECYCLE");
	const sentCapture = await send(
		capture.value.frame as unknown as Record<string, unknown> & {
			schema: string;
		},
	);
	if (!sentCapture.ok) return sentCapture;
	framesAnswered += 1;

	// -- R->C 6 / C->R 6: teardown -------------------------------------------
	const seventh = await receive(
		CHILD_TEARDOWN_DEADLINE_MS,
		"TEARDOWN_DEADLINE_EXCEEDED",
	);
	if (!seventh.ok) return await refuse(seventh, "TEARDOWN_DEADLINE_EXCEEDED");
	if (!sameExecution(seventh.value)) {
		return await refuse(
			{ code: "EXECUTION_MISMATCH", message: "teardown" },
			"EXECUTION_MISMATCH",
		);
	}
	// The listener is released before the ack, so `allSessionsClosed` is a
	// statement about a server that has already stopped rather than a promise.
	await binding.stop();
	const stopped = buildServerStopped({
		sequence: lifecycle.childToRig.sequence,
		executionSha256,
		exitCode: 0,
	});
	if (!stopped.ok) return await refuse(stopped, "CHILD_LIFECYCLE");
	const sentStopped = await send(
		stopped.value as unknown as Record<string, unknown> & { schema: string },
	);
	if (!sentStopped.ok) return sentStopped;
	framesAnswered += 1;

	return {
		ok: true,
		value: {
			decision: decision.value,
			binding,
			warmupEpochSha256,
			framesAnswered,
		},
	};
}

/**
 * The production control pipe: FD 3 in, FD 4 out.
 *
 * `node:fs` rather than `Bun.file`, matching the only other pipe reader in
 * this tree (`MacRoleChildControlChannel` in remote-supervisor.ts). Both are
 * on `forbiddenCalls`/`forbiddenImports`; a role child that is handed two
 * descriptors has no other way to read them, and the alternative is a cohort
 * mode that cannot receive its own grant.
 */
export function createFanoutCohortControlPipeIo(): CohortControlPipeIo {
	let closed = false;
	// §3.4: the child is handed exactly two control descriptors and every
	// unused pipe end is closed before exec. Checking them here turns "this
	// process was not spawned by a rig supervisor" into one named refusal
	// instead of whichever errno the first read happens to raise.
	for (const [fd, role] of [
		[FANOUT_COHORT_CONTROL_READ_FD, "supervisor->child read"],
		[FANOUT_COHORT_CONTROL_WRITE_FD, "child->supervisor write"],
	] as const) {
		let isPipe = false;
		try {
			isPipe = fstatSync(fd).isFIFO();
		} catch {
			isPipe = false;
		}
		if (!isPipe) {
			throw new Error(
				`[fanout-cohort] UNEXPECTED_FD: FD ${fd} (${role}) is not a control pipe; ` +
					"this entrypoint runs only as a rig-supervisor server child",
			);
		}
	}
	return {
		read: () =>
			new Promise<Uint8Array | null>((resolve, reject) => {
				const buffer = Buffer.allocUnsafe(CHILD_PIPE_CONTROL_MAX_BYTES);
				nodeFsRead(
					FANOUT_COHORT_CONTROL_READ_FD,
					buffer,
					0,
					buffer.byteLength,
					null,
					(error, read) => {
						if (error) {
							const code = (error as NodeJS.ErrnoException).code;
							// The rig closing its write end is EOF, not a fault.
							if (code === "EOF" || code === "EBADF") resolve(null);
							else reject(error);
							return;
						}
						resolve(
							read === 0 ? null : new Uint8Array(buffer.subarray(0, read)),
						);
					},
				);
			}),
		write: (bytes) =>
			new Promise<void>((resolve, reject) => {
				let written = 0;
				const step = (): void => {
					nodeFsWrite(
						FANOUT_COHORT_CONTROL_WRITE_FD,
						bytes,
						written,
						bytes.byteLength - written,
						null,
						(error, count) => {
							if (error) {
								reject(error);
								return;
							}
							written += count;
							if (written >= bytes.byteLength) resolve();
							else step();
						},
					);
				};
				step();
			}),
		close: () => {
			if (closed) return;
			closed = true;
			for (const fd of [
				FANOUT_COHORT_CONTROL_READ_FD,
				FANOUT_COHORT_CONTROL_WRITE_FD,
			]) {
				try {
					closeSync(fd);
				} catch {
					// A descriptor the parent already closed is not an error here.
				}
			}
		},
	};
}

/** The peer's adapter, chosen the same way and for the same reason as the client's. */
export async function adapterForTransport(
	transport: "ws" | "wt",
): Promise<TransportAdapter> {
	if (transport === "ws") return createWebSocketAdapter();
	return createWebTransportAdapter(await productionWtAdapterOptions());
}

/**
 * Resolve the registry cell the echo peer must match the client against.
 * Scenario CLI args are scenario ids (`game-tick-loss`); the registry keys
 * cells by cellId (`game-tick-loss/tick-20-...`).
 */
export function cellForServerScenario(scenario: ScenarioId): ScenarioCell {
	const exact = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(cell) => cell.scenarioId === scenario,
	);
	if (exact !== undefined) return exact;
	const prefixed = CANONICAL_SCENARIO_REGISTRY.cells.find((cell) =>
		cell.cellId.startsWith(`${scenario}/`),
	);
	if (prefixed !== undefined) return prefixed;
	throw new Error(`No registry cell for scenario ${scenario}`);
}

/**
 * Delivery kind the echo peer listens on.
 *
 * Kept in lockstep with `resolveSealLegPlan` in compare-controller: only
 * `game-tick-loss` (latest-state / percent) uses datagrams. A reliable-only
 * peer against a datagram client seals an honest-looking 0% delivery leg.
 */
export function echoDeliveryKindForScenario(
	scenario: ScenarioId,
): DeliveryKind {
	const cell = cellForServerScenario(scenario);
	return cell.parameters.scenarioId === "game-tick-loss"
		? "datagram"
		: "reliable-message";
}

// Entrypoint when invoked directly via CLI
if (import.meta.main) {
	try {
		const args = parseServerArgs(process.argv.slice(2));
		if (args.help) {
			printServerHelp();
			process.exit(0);
		}
		console.log(
			`[server] Starting ${args.transport.toUpperCase()} server for scenario ${args.scenario} on ${args.bind}:${args.port}...`,
		);
		if (args.mode === "fanout-cohort") {
			// Stage-time inputs first: a server that cannot name the Mac key it
			// trusts must not reach a listener at all.
			const environment = parseFanoutCohortServerEnvironment(process.env);
			if (!environment.ok) {
				throw new Error(
					`[fanout-cohort] ${environment.code}: ${environment.message}`,
				);
			}
			// The per-execution half -- execution digest, rig acceptance digest,
			// the cohort grant and the Mac signature over its exact bytes --
			// arrives on the control pipe, one frame, and is verified against the
			// staged key above before any listener exists.
			const io = createFanoutCohortControlPipeIo();
			// One observer and one clock for the life of the process. They are
			// built here rather than inside the bind listener because the busy
			// baseline and the final reading must be two reads of the *same*
			// accumulator, and a per-bind observer would restart it.
			const loop = createCohortServerLoopObserver();
			const clock = createCohortServerClock();
			const outcome = await runFanoutCohortServerChild({
				io,
				stagedMacPublicRaw32: environment.value.stagedMacPublicRaw32,
				bindListener: async (decision) => {
					const childInstanceNonce = sha256HexOfBytes(
						canonicalRecordBytes({
							schema: "server-child-instance-nonce/v1",
							executionSha256: decision.executionSha256,
							cohortGrantSha256: decision.cohortGrantSha256,
							childPid: process.pid,
						}),
					);
					// §2.1: the authority is constructed without a key. Under the
					// §1.1 ruling the rig supervisor is the sole Linux signer and
					// this child is an observer, so there is no `rig` identity to
					// give it and nothing here can mint a `rig-*` record.
					const authority = new FanoutLinuxAuthority({
						transport: decision.transport,
						executionSha256: decision.executionSha256,
						stagedMacPublicRaw32: environment.value.stagedMacPublicRaw32,
						serverIdentity: {
							// The rig spawned this child into its own process group,
							// so the leader's pid is the group id. The rig checks both
							// against what it observed at the fork; this child is
							// stating them, not deciding them.
							serverChildPid: process.pid,
							serverChildPgid: process.pid,
							serverChildInstanceNonce: childInstanceNonce,
						},
						linuxClockId: environment.value.linuxClockId,
						clock,
						receiptValidityMs: environment.value.receiptValidityMs,
						loop,
					});
					// The authority verifies the grant a second time, against the
					// same staged key, over the records `decideCohortBind` already
					// parsed. Two independent checks of one signature is the point;
					// two independent *decodes* of one base64 string is not, which
					// is why the records travel on the decision.
					const accepted = authority.acceptCohortGrant({
						grant: decision.grantRecord,
						signature: decision.grantSignatureRecord,
						nowMs: clock.nowMs(),
					});
					if (!accepted.ok) {
						throw new Error(
							`[fanout-cohort] ${accepted.code}: ${accepted.message ?? "grant refused"}`,
						);
					}
					const started = authority.startServer();
					if (!started.ok) {
						throw new Error(
							`[fanout-cohort] ${started.code}: ${started.message ?? "server not ready"}`,
						);
					}
					// The transport is the signed grant's, taken from the relay
					// `serveFanoutCohortRelay` was handed rather than from argv.
					const served = await serveFanoutCohortRelay({
						authority,
						// The pre-cohort entrypoint let `Bun.serve` bind every
						// interface, and the role children reach this listener over
						// the measurement cable. Binding only loopback here would be
						// a narrowing, not a fix; `args.bind` still names what
						// `server-ready/v1` reports.
						hostname: "0.0.0.0",
						port: args.port,
						onRelayWork: (elapsedMs) => loop.record(elapsedMs),
						// The identity the rig delivered from the staged leaves the
						// launch record binds; never argv paths, never a default.
						wsTls: {
							cert: environment.value.tls.certPem,
							key: environment.value.tls.keyPem,
							serverName: environment.value.tls.serverName,
						},
						wtTls: {
							certPem: environment.value.tls.certPem,
							keyPem: environment.value.tls.keyPem,
						},
					});
					if (!served.ok) {
						throw new Error(
							`[fanout-cohort] ${served.code}: ${served.message ?? "no relay"}`,
						);
					}
					const peer = served.value;
					return {
						listeningAddress: `${args.bind}:${peer.port}`,
						childPid: process.pid,
						childPgid: process.pid,
						childInstanceNonce,
						authority,
						stop: () => peer.stop(),
					};
				},
			});
			if (!outcome.ok) {
				// The refusal frame is already on FD 4; this is the exit status.
				io.close?.();
				console.error(
					`[fanout-cohort] ${outcome.code}: ${outcome.message ?? "refused"}`,
				);
				process.exit(1);
			}
			console.log(
				`[fanout-cohort] ${outcome.value.framesAnswered} frames answered for execution ${outcome.value.decision.executionSha256}`,
			);
			io.close?.();
			process.exit(0);
		}
		const adapter = await adapterForTransport(args.transport);
		// `WS_WT_TLS_CERT_CONTENT` / `WS_WT_TLS_KEY_CONTENT` are set by
		// the controller when it has the cert/key as PEM content (rather
		// than a file path). Bun.serve's `tls.cert`/`tls.key` expect
		// content, not paths; the env-var path lets the controller pass
		// the content without forcing the server to read files.
		const certFromEnv = process.env.WS_WT_TLS_CERT_CONTENT;
		const keyFromEnv = process.env.WS_WT_TLS_KEY_CONTENT;
		const server = await adapter.startServer({
			port: args.port,
			tls: {
				...(certFromEnv
					? { cert: certFromEnv }
					: args.tlsCert
						? { cert: args.tlsCert }
						: {}),
				...(keyFromEnv
					? { key: keyFromEnv }
					: args.tlsKey
						? { key: args.tlsKey }
						: {}),
				serverName: process.env.WS_WT_TLS_SERVER_NAME ?? "wt-compare.local",
			},
		} as Parameters<TransportAdapter["startServer"]>[0]);
		if (args.mode === "bulk-source") {
			const bulkCell =
				CANONICAL_SCENARIO_REGISTRY.cells.find(
					(cell) => cell.cellId === "bulk-one-way/physical",
				) ??
				CANONICAL_SCENARIO_REGISTRY.cells.find(
					(cell) => cell.scenarioId === "bulk-one-way",
				);
			if (bulkCell === undefined) {
				throw new Error(
					"No bulk-one-way cell found in CANONICAL_SCENARIO_REGISTRY",
				);
			}
			const bulk = bulkCell.parameters as BulkParameters;
			const result = await runBulkSourcePeer({
				server,
				bytes: bulk.bytes,
				chunkBytes: bulk.chunkBytes,
				clock: systemTransportClock,
				acceptTimeoutMs: 60_000,
				writeTimeoutMs: 60_000,
			});
			console.log(
				`[server] bulk-one-way source wrote ${result.chunksWritten} chunks / ${result.bytesWritten} bytes`,
			);
		} else {
			const deliveryKind = echoDeliveryKindForScenario(args.scenario);
			console.log(`[server] echo peer deliveryKind=${deliveryKind}`);
			await runEchoPeer({
				server,
				deliveryKind,
				sessionCount: 1,
				messageLimit: Number.POSITIVE_INFINITY,
				clock: systemTransportClock,
				acceptTimeoutMs: 60_000,
				perMessageTimeoutMs: 5_000,
			});
		}
	} catch (err: unknown) {
		console.error(`[server] Error: ${(err as Error).message}`);
		process.exit(1);
	}
}
