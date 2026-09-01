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
import type { ProtocolResult } from "./cross-supervisor-protocol.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import type {
	FanoutRelay,
	RelaySessionSink,
} from "./scenarios/fanout-relay.ts";
import { FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES } from "./scenarios/fanout-wire.ts";
import {
	SCENARIO_IDS,
	type BulkParameters,
	type ScenarioCell,
	type ScenarioId,
} from "./types.ts";

export interface ServerArgs {
	readonly transport: "ws" | "wt";
	readonly scenario: ScenarioId;
	readonly port: number;
	readonly bind: string;
	readonly runId: string;
	readonly tlsCert?: string;
	readonly tlsKey?: string;
	readonly help?: boolean;
}

const LOOPBACK_IPS = ["127.0.0.1", "::1", "localhost", "0.0.0.0"];

export function parseServerArgs(argv: readonly string[]): ServerArgs {
	let transport: "ws" | "wt" = "wt";
	let scenario: ScenarioId = "chat-fanout";
	let port = 4433;
	let bind = "10.99.0.2";
	let runId = `run-srv-${Date.now()}`;
	let tlsCert: string | undefined;
	let tlsKey: string | undefined;
	let help = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--transport") {
			const val = argv[++i];
			if (val !== "ws" && val !== "wt") {
				throw new Error(`Invalid --transport: ${val}; expected 'ws' or 'wt'`);
			}
			transport = val;
		} else if (arg === "--scenario") {
			const val = argv[++i] as ScenarioId;
			if (!SCENARIO_IDS.includes(val)) {
				throw new Error(`Invalid --scenario: ${val}`);
			}
			scenario = val;
		} else if (arg === "--port") {
			const val = parseInt(argv[++i] ?? "", 10);
			if (isNaN(val) || val <= 0 || val > 65535) {
				throw new Error(`Invalid --port: ${val}`);
			}
			port = val;
		} else if (arg === "--bind") {
			bind = argv[++i] ?? "";
			if (!bind) throw new Error("Missing value for --bind");
		} else if (arg === "--run-id") {
			runId = argv[++i] ?? "";
			if (!runId) throw new Error("Missing value for --run-id");
		} else if (arg === "--tls-cert") {
			tlsCert = argv[++i];
		} else if (arg === "--tls-key") {
			tlsKey = argv[++i];
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
				const sessionId = relay.openSession(sink);
				sessionIdBySocketId.set(session.id, sessionId);
				socketBySessionId.set(sessionId, session);
				options.onSession?.({ sessionId, session });
			},
			onMessage: (session, bytes) => {
				const sessionId = sessionIdBySocketId.get(session.id);
				if (sessionId === undefined) return;
				const result = relay.handleInboundBytes(sessionId, bytes);
				relay.pump();
				options.onInbound?.({ sessionId, result });
			},
			onDrain: () => {
				relay.pump();
			},
			onClose: (session) => {
				const sessionId = sessionIdBySocketId.get(session.id);
				if (sessionId === undefined) return;
				sessionIdBySocketId.delete(session.id);
				socketBySessionId.delete(sessionId);
				relay.closeSession(sessionId, "peer disconnected");
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
	const host = options.hostname ?? "127.0.0.1";
	const sessionsById = new Map<string, FanoutRelayWtSession>();

	const { serverFactory } = await productionWtAdapterOptions();
	const handle = serverFactory({
		host,
		port: options.port ?? 0,
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
						relay.pump();
					});
					relay.pump();
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

		const sessionId = relay.openSession(sink);
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
				relay.closeSession(sessionId, "peer disconnected");
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
				relay.pump();
			});
			relay.pump();

			const inbound = opened.value.readable.getReader();
			const frames = new LengthPrefixedFrameReader(
				FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
			);
			for (;;) {
				const chunk = await inbound.read();
				if (chunk.done || chunk.value === undefined) return;
				for (const bytes of frames.push(chunk.value)) {
					const result = relay.handleInboundBytes(sessionId, bytes);
					relay.pump();
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
		if (args.scenario === "bulk-one-way") {
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
