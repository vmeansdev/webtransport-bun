/**
 * B2 relay tests (plan §4.1-§4.5).
 *
 * Every test body runs unchanged against every registered transport binding.
 * A binding supplies only three things: how a role connects, how a congested
 * transport is simulated, and how to let pending I/O settle. The relay engine,
 * the fixtures, and the assertions are shared, so adding the real `ws` and `wt`
 * bindings to `RELAY_BINDINGS` runs all ten tests over those transports without
 * touching a single assertion.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	type BinaryMessageClient,
	type BinaryMessageServerSession,
	connectBinaryMessageClient,
} from "./adapters/ws.ts";
import {
	type FakeWtClientSession,
	LengthPrefixedFrameReader,
	productionWtAdapterOptions,
} from "./adapters/wt.ts";
import {
	COHORT_DRAIN_DEADLINE_MS,
	RELAY_DELIVERY_FAILURE_CODE,
	SUBSCRIBER_SHARD_MODULUS,
	WARMUP_MESSAGES_PER_PUBLISHER,
} from "./cohort-protocol.ts";
import type {
	Base64,
	NsString,
	ProtocolResult,
	Sha256Hex,
} from "./cross-supervisor-protocol.ts";
import {
	buildFanoutCohortFixture,
	createManualRelayClock,
	type FanoutCohortFixture,
	FanoutRelay,
	type FanoutRelayCaps,
	type FanoutRelayConfig,
	fanoutFixtureDigest,
	fanoutFrameCodecFor,
	fanoutPayload,
	fanoutRoleId,
	type ManualRelayClock,
	RELAY_CONTROL_BACKLOG_MAX_ITEMS,
	RELAY_SUBSCRIBER_QUEUE_MAX_ITEMS,
	RELAY_WRITE_DEADLINE_MS,
	type RelaySendOutcome,
	type RelaySessionSink,
} from "./scenarios/fanout-relay.ts";
import {
	decodeFanoutWsMessage,
	decodeFanoutWtStream,
	encodeFanoutWsMessage,
	encodeFanoutWtFrame,
	FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
	FANOUT_WT_LENGTH_PREFIX_BYTES,
	type FanoutAckV1,
	type FanoutDataV1,
	type FanoutWireV1,
} from "./scenarios/fanout-wire.ts";
import {
	type FanoutRelayWsSessionEvent,
	type FanoutRelayWtSession,
	type FanoutRelayWtSessionEvent,
	serveFanoutRelayOverWebSocket,
	serveFanoutRelayOverWebTransport,
} from "./server.ts";

// ---------------------------------------------------------------------------
// The binding seam
// ---------------------------------------------------------------------------

interface RelayPeer {
	readonly role: "publisher" | "subscriber";
	readonly roleId: string;
	send(frame: FanoutWireV1): Promise<ProtocolResult<true>>;
	received(): readonly FanoutWireV1[];
	/** Make the transport report backpressure for every subsequent write. */
	block(): void;
	unblock(): Promise<void>;
	/** Hard disconnect: the relay learns of it on its next write attempt. */
	drop(): Promise<void>;
}

interface RelayHarness {
	readonly relay: FanoutRelay;
	readonly clock: ManualRelayClock;
	readonly fixture: FanoutCohortFixture;
	connect(role: "publisher" | "subscriber", roleId: string): Promise<RelayPeer>;
	settle(): Promise<void>;
	advanceMs(deltaMs: number): Promise<void>;
	close(): Promise<void>;
}

interface RelayHarnessOptions {
	readonly publisherCount: number;
	readonly subscriberCount: number;
	readonly caps?: Partial<FanoutRelayCaps>;
	readonly windowCount?: 10 | 30;
	readonly messageBytes?: 100 | 128;
}

interface RelayBinding {
	readonly name: string;
	readonly transport: "ws" | "wt";
	open(options: RelayHarnessOptions): Promise<RelayHarness>;
}

// ---------------------------------------------------------------------------
// The in-process binding
// ---------------------------------------------------------------------------

const COHORT_ID = "b2-relay";
const LINUX_CLOCK_ID = "linux-monotonic-b2";

function relayConfig(
	transport: "ws" | "wt",
	fixture: FanoutCohortFixture,
	clock: ManualRelayClock,
	options: RelayHarnessOptions,
): FanoutRelayConfig {
	return {
		transport,
		cohortId: fixture.cohortId,
		cohortGrantSha256: fanoutFixtureDigest(`${COHORT_ID}:grant`),
		cohortWarmupEpochSha256: fanoutFixtureDigest(`${COHORT_ID}:warmup-epoch`),
		warmupNonce: fanoutFixtureDigest(`${COHORT_ID}:warmup-nonce`),
		cohortStartBarrierSha256: fanoutFixtureDigest(`${COHORT_ID}:barrier`),
		roleTokenCommitmentRootSha256: fixture.roleTokenCommitmentRootSha256,
		roleTokenCommitmentCount: fixture.roleTokenCommitmentCount,
		publishers: fixture.publishers,
		subscriberShards: fixture.subscriberShards,
		expectedSubscriberIds: fixture.expectedSubscriberIds,
		windowCount: options.windowCount ?? 10,
		messageBytes: options.messageBytes ?? 100,
		linuxClockId: LINUX_CLOCK_ID,
		clock,
		caps: options.caps,
	};
}

/**
 * A loopback transport: `trySend` hands the encoded frame straight to the peer's
 * inbox unless the peer is blocked (backpressure) or dropped (closed). It is
 * the same contract a real socket adapter implements, minus the socket.
 */
const IN_PROCESS_BINDING: RelayBinding = {
	name: "in-process",
	transport: "ws",
	open: async (options) => {
		const fixture = buildFanoutCohortFixture({
			cohortId: COHORT_ID,
			publisherCount: options.publisherCount,
			subscriberCount: options.subscriberCount,
		});
		const clock = createManualRelayClock();
		const config = relayConfig("ws", fixture, clock, options);
		const relay = new FanoutRelay(config);
		const codec = fanoutFrameCodecFor(config.transport);

		const connect = async (
			role: "publisher" | "subscriber",
			roleId: string,
		): Promise<RelayPeer> => {
			const inbox: FanoutWireV1[] = [];
			let blocked = false;
			let dropped = false;
			const sink: RelaySessionSink = {
				trySend: (bytes): RelaySendOutcome => {
					if (dropped) return "closed";
					if (blocked) return "would-block";
					const decoded = codec.decode(bytes);
					if (!decoded.ok) throw new Error(`peer decode: ${decoded.code}`);
					inbox.push(decoded.value);
					return "accepted";
				},
				close: () => {
					dropped = true;
				},
			};
			const sessionId = relay.openSession(sink);
			return {
				role,
				roleId,
				send: async (frame) =>
					relay.handleInboundBytes(sessionId, mustEncode(codec, frame)),
				received: () => [...inbox],
				block: () => {
					blocked = true;
				},
				unblock: async () => {
					blocked = false;
					relay.pump();
				},
				drop: async () => {
					dropped = true;
					relay.closeSession(sessionId, "peer dropped");
				},
			};
		};

		return {
			relay,
			clock,
			fixture,
			connect,
			settle: async () => {
				relay.pump();
			},
			advanceMs: async (deltaMs) => {
				clock.advanceMs(deltaMs);
			},
			close: async () => {
				relay.shutdown();
			},
		};
	},
};

// ---------------------------------------------------------------------------
// The real-WebSocket binding
// ---------------------------------------------------------------------------

/**
 * Every socket-backed harness this file has stood up, so a test that ends
 * without calling `close()` still gives its listener back. A leaked `Bun.serve`
 * or WT listener keeps the test process alive after the last assertion.
 */
const OPEN_SOCKET_HARNESSES: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const teardown of OPEN_SOCKET_HARNESSES.splice(0)) await teardown();
});

/** One turn of the event loop, which is what lets loopback bytes land. */
function tick(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

const WS_SETTLE_DEADLINE_MS = 10_000;

async function waitUntil(
	predicate: () => boolean,
	description: string,
): Promise<void> {
	const deadlineMs = Date.now() + WS_SETTLE_DEADLINE_MS;
	while (!predicate()) {
		if (Date.now() > deadlineMs)
			throw new Error(`timed out waiting: ${description}`);
		await tick();
	}
}

/** What the harness knows about one connected role. */
interface WsPeerState {
	readonly sessionId: string;
	readonly session: BinaryMessageServerSession;
	readonly inbox: FanoutWireV1[];
}

/**
 * The same ten tests over real sockets: one binary WebSocket message per
 * logical frame (§4.2), a `Bun.serve` listener on an ephemeral loopback port,
 * and a `WebSocket` client per role.
 *
 * Two things are out of band because a socket cannot carry them. `send`
 * resolves with what the relay itself answered for that exact message -- the
 * relay is in this process, so the server peer reports each inbound result in
 * arrival order and the client claims its own by ordinal, which a per-socket
 * FIFO makes exact. And `block()` pauses the server's writes to that peer
 * rather than trying to congest loopback: the relay still sees `would-block`
 * from a real socket session, which is the outcome the bound under test is
 * about.
 */
const WS_BINDING: RelayBinding = {
	name: "ws",
	transport: "ws",
	open: async (options) => {
		const fixture = buildFanoutCohortFixture({
			cohortId: COHORT_ID,
			publisherCount: options.publisherCount,
			subscriberCount: options.subscriberCount,
		});
		const clock = createManualRelayClock();
		const config = relayConfig("ws", fixture, clock, options);
		const relay = new FanoutRelay(config);
		const codec = fanoutFrameCodecFor(config.transport);

		const openedSessions: FanoutRelayWsSessionEvent[] = [];
		const inboundBySessionId = new Map<string, ProtocolResult<true>[]>();
		const closedSessionIds = new Set<string>();
		const states: WsPeerState[] = [];

		const peer = serveFanoutRelayOverWebSocket({
			relay,
			hostname: "127.0.0.1",
			port: 0,
			onSession: (event) => {
				openedSessions.push(event);
			},
			onInbound: ({ sessionId, result }) => {
				const results = inboundBySessionId.get(sessionId) ?? [];
				results.push(result);
				inboundBySessionId.set(sessionId, results);
			},
			onSessionClosed: ({ sessionId }) => {
				closedSessionIds.add(sessionId);
			},
		});

		const clients: BinaryMessageClient[] = [];
		let stopped = false;
		const stopServer = async (): Promise<void> => {
			if (stopped) return;
			stopped = true;
			for (const client of clients) client.close();
			await peer.stop();
		};
		OPEN_SOCKET_HARNESSES.push(stopServer);

		/**
		 * Quiescence: every message the relay handed to a socket has been seen by
		 * the peer that socket belongs to, twice in a row. Counting accepted
		 * sends rather than attempted ones is what keeps a paused session from
		 * making the harness wait for bytes the relay never wrote.
		 */
		const settle = async (): Promise<void> => {
			const deadlineMs = Date.now() + WS_SETTLE_DEADLINE_MS;
			let stable = 0;
			while (Date.now() < deadlineMs) {
				relay.pump();
				await tick();
				let sent = 0;
				let received = 0;
				for (const state of states) {
					sent += state.session.sentMessages;
					received += state.inbox.length;
				}
				if (sent !== received) {
					stable = 0;
					continue;
				}
				stable += 1;
				if (stable >= 2) return;
			}
			throw new Error("ws relay harness did not reach quiescence");
		};

		const connect = async (
			role: "publisher" | "subscriber",
			roleId: string,
		): Promise<RelayPeer> => {
			const inbox: FanoutWireV1[] = [];
			const client = await connectBinaryMessageClient({
				url: peer.url,
				onMessage: (bytes) => {
					const decoded = codec.decode(bytes);
					if (!decoded.ok) throw new Error(`peer decode: ${decoded.code}`);
					inbox.push(decoded.value);
				},
			});
			clients.push(client);
			await waitUntil(
				() => openedSessions.length > 0,
				`relay session for ${roleId}`,
			);
			const opened = openedSessions.shift() as FanoutRelayWsSessionEvent;
			const state: WsPeerState = {
				sessionId: opened.sessionId,
				session: opened.session,
				inbox,
			};
			states.push(state);

			return {
				role,
				roleId,
				send: async (frame) => {
					const before = (inboundBySessionId.get(state.sessionId) ?? []).length;
					client.send(mustEncode(codec, frame));
					await waitUntil(
						() =>
							(inboundBySessionId.get(state.sessionId) ?? []).length > before,
						`relay result for ${roleId} frame ${before}`,
					);
					const results = inboundBySessionId.get(
						state.sessionId,
					) as ProtocolResult<true>[];
					const result = results[before] as ProtocolResult<true>;
					await settle();
					return result;
				},
				received: () => [...inbox],
				block: () => {
					state.session.pause();
				},
				unblock: async () => {
					state.session.resume();
					relay.pump();
					await settle();
				},
				drop: async () => {
					client.close();
					await waitUntil(
						() => closedSessionIds.has(state.sessionId),
						`relay to observe ${roleId} disconnect`,
					);
				},
			};
		};

		return {
			relay,
			clock,
			fixture,
			connect,
			settle,
			advanceMs: async (deltaMs) => {
				clock.advanceMs(deltaMs);
			},
			close: async () => {
				relay.shutdown();
				await stopServer();
			},
		};
	},
};

// ---------------------------------------------------------------------------
// The real-WebTransport binding
// ---------------------------------------------------------------------------

/** The part of a Node readable stream the WT client half reads through. */
interface NodeReadableLike {
	on(event: "data", listener: (chunk: Uint8Array) => void): unknown;
}

/**
 * QUIC over loopback settles across more event-loop turns than an in-process
 * socket does, so the WT harness wants a longer run of quiet ticks before it
 * calls a cohort quiescent.
 */
const WT_SETTLE_STABLE_TICKS = 4;

/** What the harness knows about one connected role over WT. */
interface WtPeerState {
	readonly sessionId: string;
	readonly session: FanoutRelayWtSession;
	readonly inbox: FanoutWireV1[];
}

/**
 * The same ten tests over real QUIC. The mapping is §4.3's
 * `wt-publisher-bidi-subscriber-control-bidi-server-uni`: each role opens one
 * control bidi stream, the server opens one uni stream per subscriber, and both
 * carry `u32be length || frame`.
 *
 * The out-of-band pieces are the WS binding's, for the same reasons. `send`
 * resolves with what the relay answered for that exact frame, claimed by
 * ordinal on a per-stream FIFO; `block()` pauses the server's writes to that
 * peer rather than trying to congest loopback, so the relay still sees
 * `would-block` from a real session. Delivery and control are separate streams,
 * so the inbox merges them -- no assertion here depends on the order of a data
 * frame relative to an ack, only on the order within each channel, which the
 * streams themselves guarantee.
 */
const WT_BINDING: RelayBinding = {
	name: "wt",
	transport: "wt",
	open: async (options) => {
		const fixture = buildFanoutCohortFixture({
			cohortId: COHORT_ID,
			publisherCount: options.publisherCount,
			subscriberCount: options.subscriberCount,
		});
		const clock = createManualRelayClock();
		const config = relayConfig("wt", fixture, clock, options);
		const relay = new FanoutRelay(config);
		const codec = fanoutFrameCodecFor(config.transport);

		const openedSessions: FanoutRelayWtSessionEvent[] = [];
		const inboundBySessionId = new Map<string, ProtocolResult<true>[]>();
		const closedSessionIds = new Set<string>();
		const states: WtPeerState[] = [];

		const peer = await serveFanoutRelayOverWebTransport({
			relay,
			hostname: "127.0.0.1",
			port: 0,
			onSession: (event) => {
				openedSessions.push(event);
			},
			onInbound: ({ sessionId, result }) => {
				const results = inboundBySessionId.get(sessionId) ?? [];
				results.push(result);
				inboundBySessionId.set(sessionId, results);
			},
			onSessionClosed: ({ sessionId }) => {
				closedSessionIds.add(sessionId);
			},
		});

		const { clientFactory } = await productionWtAdapterOptions();
		const clients: FakeWtClientSession[] = [];
		let stopped = false;
		const stopServer = async (): Promise<void> => {
			if (stopped) return;
			stopped = true;
			for (const client of clients) {
				try {
					client.close();
				} catch {
					// Already gone; the listener is what must come back.
				}
			}
			await peer.stop();
		};
		OPEN_SOCKET_HARNESSES.push(stopServer);

		/** The WS binding's quiescence rule, over two channels instead of one. */
		const settle = async (): Promise<void> => {
			const deadlineMs = Date.now() + WS_SETTLE_DEADLINE_MS;
			let stable = 0;
			while (Date.now() < deadlineMs) {
				relay.pump();
				await tick();
				let sent = 0;
				let received = 0;
				for (const state of states) {
					sent += state.session.sentMessages;
					received += state.inbox.length;
				}
				if (sent !== received) {
					stable = 0;
					continue;
				}
				stable += 1;
				if (stable >= WT_SETTLE_STABLE_TICKS) return;
			}
			throw new Error("wt relay harness did not reach quiescence");
		};

		const connect = async (
			role: "publisher" | "subscriber",
			roleId: string,
		): Promise<RelayPeer> => {
			const inbox: FanoutWireV1[] = [];
			const readInto = (stream: NodeReadableLike): void => {
				const frames = new LengthPrefixedFrameReader(
					FANOUT_CONTROL_FRAME_MAX_DECODED_BYTES,
				);
				stream.on("data", (chunk: Uint8Array) => {
					for (const bytes of frames.push(chunk)) {
						const decoded = codec.decode(bytes);
						if (!decoded.ok) throw new Error(`peer decode: ${decoded.code}`);
						inbox.push(decoded.value);
					}
				});
			};

			const client = await clientFactory(peer.url, {
				tls: { insecureSkipVerify: true },
			});
			clients.push(client);
			await client.ready;
			const control =
				(await client.createBidirectionalStream()) as unknown as NodeReadableLike & {
					write(chunk: Uint8Array): boolean;
				};
			readInto(control);
			void (async () => {
				for await (const uni of client.incomingUnidirectionalStreams()) {
					readInto(uni as unknown as NodeReadableLike);
				}
			})().catch(() => {
				// The session ended; whatever it had already delivered stands.
			});

			await waitUntil(
				() => openedSessions.length > 0,
				`relay session for ${roleId}`,
			);
			const opened = openedSessions.shift() as FanoutRelayWtSessionEvent;
			const state: WtPeerState = {
				sessionId: opened.sessionId,
				session: opened.session,
				inbox,
			};
			states.push(state);

			return {
				role,
				roleId,
				send: async (frame) => {
					const before = (inboundBySessionId.get(state.sessionId) ?? []).length;
					control.write(mustEncode(codec, frame));
					await waitUntil(
						() =>
							(inboundBySessionId.get(state.sessionId) ?? []).length > before,
						`relay result for ${roleId} frame ${before}`,
					);
					const results = inboundBySessionId.get(
						state.sessionId,
					) as ProtocolResult<true>[];
					const result = results[before] as ProtocolResult<true>;
					await settle();
					return result;
				},
				received: () => [...inbox],
				block: () => {
					state.session.pause();
				},
				unblock: async () => {
					state.session.resume();
					relay.pump();
					await settle();
				},
				drop: async () => {
					client.close();
					await waitUntil(
						() => closedSessionIds.has(state.sessionId),
						`relay to observe ${roleId} disconnect`,
					);
				},
			};
		};

		return {
			relay,
			clock,
			fixture,
			connect,
			settle,
			advanceMs: async (deltaMs) => {
				clock.advanceMs(deltaMs);
			},
			close: async () => {
				relay.shutdown();
				await stopServer();
			},
		};
	},
};

/**
 * The registered bindings. Every test below runs over all of them unchanged.
 */
const RELAY_BINDINGS: readonly RelayBinding[] = [
	IN_PROCESS_BINDING,
	WS_BINDING,
	WT_BINDING,
];

/** The socket binding for the transport `binding` does not speak. */
function crossTransportCounterpart(binding: RelayBinding): RelayBinding {
	return binding.transport === "wt" ? WS_BINDING : WT_BINDING;
}

// ---------------------------------------------------------------------------
// Shared frame builders and cohort choreography
// ---------------------------------------------------------------------------

function mustEncode(
	codec: ReturnType<typeof fanoutFrameCodecFor>,
	frame: FanoutWireV1,
): Uint8Array {
	const encoded = codec.encode(frame);
	if (!encoded.ok) throw new Error(`encode ${frame.kind}: ${encoded.code}`);
	return encoded.value;
}

function grantDigest(): Sha256Hex {
	return fanoutFixtureDigest(`${COHORT_ID}:grant`);
}
function warmupEpochDigest(): Sha256Hex {
	return fanoutFixtureDigest(`${COHORT_ID}:warmup-epoch`);
}
function warmupNonce(): Sha256Hex {
	return fanoutFixtureDigest(`${COHORT_ID}:warmup-nonce`);
}
function barrierDigest(): Sha256Hex {
	return fanoutFixtureDigest(`${COHORT_ID}:barrier`);
}

function registerFrame(
	harness: RelayHarness,
	role: "publisher" | "subscriber",
	roleId: string,
	overrides: Partial<Record<string, unknown>> = {},
): FanoutWireV1 {
	const fixture = harness.fixture;
	return {
		schema: "fanout-wire/v1",
		kind: "register",
		cohortGrantSha256: grantDigest(),
		transport: harness.relay.config.transport,
		role,
		childId: fixture.childIdByRoleId.get(roleId) as string,
		roleId,
		workerIndex: fixture.workerIndexByRoleId.get(roleId) ?? null,
		tokenBase64: fixture.tokenBase64ByRoleId.get(roleId) as Base64,
		tokenSha256: fixture.tokenSha256ByRoleId.get(roleId) as Sha256Hex,
		tokenCommitmentIndex: fixture.commitmentIndexByRoleId.get(roleId) as number,
		tokenMerkleProofSha256: [
			...(fixture.proofByRoleId.get(roleId) as readonly Sha256Hex[]),
		],
		...overrides,
	} as FanoutWireV1;
}

function warmupDataFrame(publisherId: string, sequence: number): FanoutWireV1 {
	const payload = fanoutPayload(100, `warmup:${publisherId}:${sequence}`);
	return {
		schema: "fanout-wire/v1",
		kind: "warmup-data",
		direction: "publisher-to-relay",
		cohortGrantSha256: grantDigest(),
		cohortWarmupEpochSha256: warmupEpochDigest(),
		warmupNonce: warmupNonce(),
		publisherId,
		publisherSequence: sequence,
		subscriberId: null,
		linuxAcceptedOrdinal: null,
		payloadBase64: payload.payloadBase64,
		payloadSha256: payload.payloadSha256,
		payloadBytes: 100,
	};
}

function warmupEndFrame(
	publisherId: string,
	finalSequence: number,
): FanoutWireV1 {
	return {
		schema: "fanout-wire/v1",
		kind: "warmup-end",
		cohortGrantSha256: grantDigest(),
		cohortWarmupEpochSha256: warmupEpochDigest(),
		warmupNonce: warmupNonce(),
		role: "publisher",
		roleId: publisherId,
		finalPublisherSequence: finalSequence,
		reason: "publisher-warmup-complete",
	};
}

function dataFrame(
	publisherId: string,
	sequence: number,
	windowIndex = 0,
): FanoutDataV1 {
	const payload = fanoutPayload(100, `measured:${publisherId}:${sequence}`);
	return {
		schema: "fanout-wire/v1",
		kind: "data",
		direction: "publisher-to-relay",
		cohortGrantSha256: grantDigest(),
		cohortStartBarrierSha256: barrierDigest(),
		windowIndex,
		publisherId,
		publisherSequence: sequence,
		subscriberId: null,
		linuxAcceptedOrdinal: null,
		payloadBase64: payload.payloadBase64,
		payloadSha256: payload.payloadSha256,
		payloadBytes: 100,
	};
}

function endFrame(publisherId: string, finalSequence: number): FanoutWireV1 {
	return {
		schema: "fanout-wire/v1",
		kind: "end",
		cohortGrantSha256: grantDigest(),
		cohortStartBarrierSha256: barrierDigest(),
		role: "publisher",
		roleId: publisherId,
		finalWindowIndex: 0,
		finalPublisherSequence: finalSequence,
		reason: "publisher-complete",
	};
}

/** The authenticated rig acceptance the relay requires before measured traffic. */
function barrierAcceptance(overrides: Record<string, unknown> = {}) {
	return {
		schema: "rig-barrier-acceptance/v1",
		executionSha256: fanoutFixtureDigest(`${COHORT_ID}:execution`),
		cohortGrantSha256: grantDigest(),
		cohortStartBarrierSha256: barrierDigest(),
		cohortStartBarrierSignatureSha256: fanoutFixtureDigest(
			`${COHORT_ID}:barrier-sig`,
		),
		rigMeasureStartAckSha256: fanoutFixtureDigest(
			`${COHORT_ID}:measure-start-ack`,
		),
		serverStartBarrierAcceptedSha256: fanoutFixtureDigest(
			`${COHORT_ID}:server-barrier`,
		),
		rigSupervisorInstanceNonce: fanoutFixtureDigest(`${COHORT_ID}:rig-nonce`),
		signingPublicKeySha256: fanoutFixtureDigest(`${COHORT_ID}:rig-key`),
		receiptSequence: 1,
		acceptedAtLinuxNs: "1000000000" as NsString,
		linuxClockId: LINUX_CLOCK_ID,
		issuedAtMs: 1_000,
		notAfterMs: 600_000,
		...overrides,
	};
}

interface Cohort {
	readonly harness: RelayHarness;
	readonly publishers: readonly RelayPeer[];
	readonly subscribers: readonly RelayPeer[];
}

/** Connect and register every role, then close registration. */
async function connectCohort(
	binding: RelayBinding,
	options: RelayHarnessOptions,
	connectSubscriberCount = options.subscriberCount,
): Promise<Cohort> {
	const harness = await binding.open(options);
	const publishers: RelayPeer[] = [];
	const subscribers: RelayPeer[] = [];
	for (let index = 0; index < options.publisherCount; index += 1) {
		const roleId = fanoutRoleId("publisher", index);
		const peer = await harness.connect("publisher", roleId);
		expect(
			(await peer.send(registerFrame(harness, "publisher", roleId))).ok,
		).toBe(true);
		publishers.push(peer);
	}
	for (let index = 0; index < connectSubscriberCount; index += 1) {
		const roleId = fanoutRoleId("subscriber", index);
		const peer = await harness.connect("subscriber", roleId);
		expect(
			(await peer.send(registerFrame(harness, "subscriber", roleId))).ok,
		).toBe(true);
		subscribers.push(peer);
	}
	await harness.settle();
	expect(harness.relay.closeRegistration().ok).toBe(true);
	return { harness, publishers, subscribers };
}

/** The full non-vacuous warmup epoch: ten paced frames per publisher, then drain. */
async function runWarmup(cohort: Cohort): Promise<void> {
	for (const publisher of cohort.publishers) {
		for (
			let sequence = 0;
			sequence < WARMUP_MESSAGES_PER_PUBLISHER;
			sequence += 1
		) {
			const sent = await publisher.send(
				warmupDataFrame(publisher.roleId, sequence),
			);
			expect(sent.ok).toBe(true);
		}
		const ended = await publisher.send(
			warmupEndFrame(publisher.roleId, WARMUP_MESSAGES_PER_PUBLISHER - 1),
		);
		expect(ended.ok).toBe(true);
	}
	await cohort.harness.settle();
}

/** Warmup, drain, and arm the measured window behind the authenticated barrier. */
async function armMeasured(cohort: Cohort): Promise<void> {
	await runWarmup(cohort);
	const drained = cohort.harness.relay.drainWarmup();
	expect(drained.ok).toBe(true);
	const armed = cohort.harness.relay.acceptLinuxBarrier(
		barrierAcceptance() as never,
	);
	expect(armed.ok).toBe(true);
}

function dataFramesOf(peer: RelayPeer): FanoutDataV1[] {
	return peer
		.received()
		.filter((frame): frame is FanoutDataV1 => frame.kind === "data");
}

function acksOf(peer: RelayPeer): FanoutAckV1[] {
	return peer
		.received()
		.filter((frame): frame is FanoutAckV1 => frame.kind === "ack");
}

function faultKinds(relay: FanoutRelay): string[] {
	return relay.promotionFaults().map((fault) => fault.kind);
}

// ---------------------------------------------------------------------------
// Cross-transport equivalence
// ---------------------------------------------------------------------------

/**
 * Everything about a cohort that must not depend on which mapping carried it.
 *
 * Session IDs, ports and byte counts are deliberately absent: they are
 * transport facts. What is here is what the artifact would be built from --
 * accepted ordinals, ack dispositions, per-subscriber delivery sets, and the
 * origin-window counters -- so two transports that disagree anywhere in it
 * disagree about the measurement itself.
 */
interface RelayObservation {
	readonly ackDispositions: readonly string[];
	readonly acceptedOrdinals: readonly (number | null)[];
	readonly deliveriesBySubscriber: Record<
		string,
		readonly { ordinal: number | null; sequence: number; digest: string }[]
	>;
	readonly subscriberEndReasons: Record<string, readonly string[]>;
	readonly acceptedIngressByOriginWindow: readonly number[];
	readonly relayWritesCompletedByOriginWindow: readonly number[];
	readonly duplicateIngressByOriginWindow: readonly number[];
	readonly reorderedIngressByOriginWindow: readonly number[];
	readonly registeredSubscriberIds: readonly string[];
	readonly publisherEndCount: number;
	readonly subscriberEndCount: number;
	readonly warmupIngress: number;
	readonly warmupDeliveries: number;
	readonly promotable: boolean;
}

/**
 * One publisher, two subscribers, a full warmup epoch, three measured frames
 * and an end marker: the smallest script that exercises registration, warmup
 * drain, the measured barrier, fanout to every subscriber, and both end
 * markers. Run identically over both mappings.
 */
async function observeEquivalenceScript(
	binding: RelayBinding,
): Promise<RelayObservation> {
	const cohort = await connectCohort(binding, {
		publisherCount: 1,
		subscriberCount: 2,
	});
	await armMeasured(cohort);
	const publisher = cohort.publishers[0] as RelayPeer;
	for (let sequence = 0; sequence < 3; sequence += 1) {
		expect(
			(await publisher.send(dataFrame(publisher.roleId, sequence))).ok,
		).toBe(true);
	}
	expect((await publisher.send(endFrame(publisher.roleId, 2))).ok).toBe(true);
	await cohort.harness.settle();

	// Shut down before reading: the relay's own end markers are part of what
	// the two mappings must agree on, and they are only written on drain.
	expect(cohort.harness.relay.stopMeasurement().ok).toBe(true);
	expect(cohort.harness.relay.shutdown().ok).toBe(true);
	await cohort.harness.settle();

	const acks = acksOf(publisher);
	const deliveriesBySubscriber: RelayObservation["deliveriesBySubscriber"] = {};
	const subscriberEndReasons: RelayObservation["subscriberEndReasons"] = {};
	for (const subscriber of cohort.subscribers) {
		deliveriesBySubscriber[subscriber.roleId] = dataFramesOf(subscriber).map(
			(frame) => ({
				ordinal: frame.linuxAcceptedOrdinal,
				sequence: frame.publisherSequence,
				digest: frame.payloadSha256,
			}),
		);
		subscriberEndReasons[subscriber.roleId] = subscriber
			.received()
			.filter((frame) => frame.kind === "end" || frame.kind === "warmup-end")
			.map((frame) =>
				frame.kind === "end" || frame.kind === "warmup-end"
					? frame.reason
					: "unreachable",
			);
	}
	const counters = cohort.harness.relay.counters();
	const observation: RelayObservation = {
		ackDispositions: acks.map((ack) => ack.disposition),
		acceptedOrdinals: acks.map((ack) => ack.linuxAcceptedOrdinal),
		deliveriesBySubscriber,
		subscriberEndReasons,
		acceptedIngressByOriginWindow: [...counters.acceptedIngressByOriginWindow],
		relayWritesCompletedByOriginWindow: [
			...counters.relayWritesCompletedByOriginWindow,
		],
		duplicateIngressByOriginWindow: [
			...counters.duplicateIngressByOriginWindow,
		],
		reorderedIngressByOriginWindow: [
			...counters.reorderedIngressByOriginWindow,
		],
		registeredSubscriberIds: [...counters.registeredSubscriberIds],
		publisherEndCount: counters.publisherEndCount,
		subscriberEndCount: counters.subscriberEndCount,
		warmupIngress: counters.warmupIngress,
		warmupDeliveries: counters.warmupDeliveries,
		promotable: cohort.harness.relay.isPromotable(),
	};
	await cohort.harness.close();
	return observation;
}

// ---------------------------------------------------------------------------
// The ten B2 tests, once per binding
// ---------------------------------------------------------------------------

for (const binding of RELAY_BINDINGS) {
	describe(`fanout relay over ${binding.name}`, () => {
		test("mini_cohort_1_publisher_2_subscribers_ordered", async () => {
			const cohort = await connectCohort(binding, {
				publisherCount: 1,
				subscriberCount: 2,
			});
			await armMeasured(cohort);
			const publisher = cohort.publishers[0] as RelayPeer;
			const messageCount = 5;
			for (let sequence = 0; sequence < messageCount; sequence += 1) {
				const sent = await publisher.send(
					dataFrame(publisher.roleId, sequence),
				);
				expect(sent.ok).toBe(true);
			}
			await cohort.harness.settle();

			// Every accepted ingress is acknowledged once, with contiguous Linux
			// ordinals the publisher never authored.
			const accepted = acksOf(publisher).filter(
				(ack) => ack.disposition === "accepted",
			);
			expect(accepted.length).toBe(messageCount);
			expect(accepted.map((ack) => ack.linuxAcceptedOrdinal)).toEqual([
				0, 1, 2, 3, 4,
			]);

			for (const subscriber of cohort.subscribers) {
				const delivered = dataFramesOf(subscriber);
				expect(delivered.length).toBe(messageCount);
				expect(delivered.map((frame) => frame.linuxAcceptedOrdinal)).toEqual([
					0, 1, 2, 3, 4,
				]);
				expect(delivered.map((frame) => frame.publisherSequence)).toEqual([
					0, 1, 2, 3, 4,
				]);
				expect(new Set(delivered.map((frame) => frame.subscriberId))).toEqual(
					new Set([subscriber.roleId]),
				);
				expect(
					delivered.every((frame) => frame.direction === "relay-to-subscriber"),
				).toBe(true);
			}

			const counters = cohort.harness.relay.counters();
			expect(counters.acceptedIngressByOriginWindow[0]).toBe(messageCount);
			expect(counters.relayWritesCompletedByOriginWindow[0]).toBe(
				messageCount * 2,
			);
			expect(counters.registeredSubscriberIds).toEqual([
				fanoutRoleId("subscriber", 0),
				fanoutRoleId("subscriber", 1),
			]);
			expect(cohort.harness.relay.isPromotable()).toBe(true);
			await cohort.harness.close();
		});

		test("registration_rejects_wrong_token_role_shard_and_replay", async () => {
			const harness = await binding.open({
				publisherCount: 1,
				subscriberCount: 2,
			});
			const publisherId = fanoutRoleId("publisher", 0);
			const subscriberId = fanoutRoleId("subscriber", 0);

			// A token that is not the one committed for this role.
			const wrongToken = await harness.connect("subscriber", subscriberId);
			const foreign = registerFrame(harness, "subscriber", subscriberId, {
				tokenBase64: harness.fixture.tokenBase64ByRoleId.get(
					fanoutRoleId("subscriber", 1),
				),
				tokenSha256: harness.fixture.tokenSha256ByRoleId.get(
					fanoutRoleId("subscriber", 1),
				),
			});
			expect((await wrongToken.send(foreign)).ok).toBe(false);
			expect(refusalCode(wrongToken)).toBe("UNKNOWN_TOKEN");

			// A role ID the grant never issued.
			const wrongRole = await harness.connect(
				"publisher",
				fanoutRoleId("publisher", 1),
			);
			const ungranted = registerFrame(harness, "publisher", publisherId, {
				roleId: fanoutRoleId("publisher", 1),
			});
			expect((await wrongRole.send(ungranted)).ok).toBe(false);
			expect(refusalCode(wrongRole)).toBe("WRONG_ROLE");

			// A subscriber claiming a shard that is not its residue.
			const wrongShard = await harness.connect("subscriber", subscriberId);
			const otherWorker = (0 + 1) % SUBSCRIBER_SHARD_MODULUS;
			expect(
				(
					await wrongShard.send(
						registerFrame(harness, "subscriber", subscriberId, {
							workerIndex: otherWorker,
							childId: `subscriber-worker-${otherWorker}`,
						}),
					)
				).ok,
			).toBe(false);
			expect(refusalCode(wrongShard)).toBe("WRONG_SHARD");

			// Another cohort's grant digest.
			const wrongCohort = await harness.connect("publisher", publisherId);
			expect(
				(
					await wrongCohort.send(
						registerFrame(harness, "publisher", publisherId, {
							cohortGrantSha256: fanoutFixtureDigest("some-other-cohort"),
						}),
					)
				).ok,
			).toBe(false);
			expect(refusalCode(wrongCohort)).toBe("WRONG_COHORT");

			// A first honest registration, then the same token again on a live
			// session (duplicate role) and on a fresh session (spent token).
			const first = await harness.connect("publisher", publisherId);
			expect(
				(await first.send(registerFrame(harness, "publisher", publisherId))).ok,
			).toBe(true);
			const duplicate = await harness.connect("publisher", publisherId);
			expect(
				(await duplicate.send(registerFrame(harness, "publisher", publisherId)))
					.ok,
			).toBe(false);
			expect(refusalCode(duplicate)).toBe("DUPLICATE_ROLE");

			await first.drop();
			const replay = await harness.connect("publisher", publisherId);
			expect(
				(await replay.send(registerFrame(harness, "publisher", publisherId)))
					.ok,
			).toBe(false);
			expect(refusalCode(replay)).toBe("TOKEN_REPLAY");

			// Registration closes; a late honest registration is refused too.
			expect(harness.relay.closeRegistration().ok).toBe(true);
			const late = await harness.connect(
				"subscriber",
				fanoutRoleId("subscriber", 1),
			);
			expect(
				(
					await late.send(
						registerFrame(harness, "subscriber", fanoutRoleId("subscriber", 1)),
					)
				).ok,
			).toBe(false);
			expect(refusalCode(late)).toBe("REGISTRATION_CLOSED");
			await harness.close();
		});

		test("relay_rejects_measured_traffic_before_linux_barrier_acceptance", async () => {
			const cohort = await connectCohort(binding, {
				publisherCount: 1,
				subscriberCount: 2,
			});
			const publisher = cohort.publishers[0] as RelayPeer;

			// Before the warmup drain the relay is not even in a measured phase.
			const early = await publisher.send(dataFrame(publisher.roleId, 0));
			expect(early.ok).toBe(false);

			await runWarmup(cohort);
			expect(cohort.harness.relay.drainWarmup().ok).toBe(true);
			expect(cohort.harness.relay.phase).toBe("warmup-drained");

			// Drained but unarmed: measured traffic is still refused, and the ack
			// says the measurement window is closed rather than acknowledging it.
			const preBarrier = await publisher.send(dataFrame(publisher.roleId, 0));
			expect(preBarrier.ok).toBe(false);
			await cohort.harness.settle();
			// Both the pre-warmup frame and the drained-but-unarmed frame are
			// closed the same way; neither is ever acknowledged.
			const closed = acksOf(publisher).filter(
				(ack) => ack.disposition === "closed",
			);
			expect(closed.length).toBe(2);
			expect(closed.map((ack) => ack.code)).toEqual([
				"MEASUREMENT_WINDOW_CLOSED",
				"MEASUREMENT_WINDOW_CLOSED",
			]);
			expect(
				acksOf(publisher).filter((ack) => ack.disposition === "accepted"),
			).toEqual([]);
			expect(
				cohort.harness.relay.counters().acceptedIngressByOriginWindow[0],
			).toBe(0);
			for (const subscriber of cohort.subscribers) {
				expect(dataFramesOf(subscriber).length).toBe(0);
			}
			expect(cohort.harness.relay.isPromotable()).toBe(false);

			// A barrier acceptance for a different barrier does not arm it either.
			const foreign = cohort.harness.relay.acceptLinuxBarrier(
				barrierAcceptance({
					cohortStartBarrierSha256: fanoutFixtureDigest("another-barrier"),
				}) as never,
			);
			expect(foreign.ok).toBe(false);
			expect(cohort.harness.relay.phase).toBe("warmup-drained");

			// The exact acceptance arms it, and the same frame is now admitted.
			expect(
				cohort.harness.relay.acceptLinuxBarrier(barrierAcceptance() as never)
					.ok,
			).toBe(true);
			expect((await publisher.send(dataFrame(publisher.roleId, 0))).ok).toBe(
				true,
			);
			await cohort.harness.settle();
			expect(
				cohort.harness.relay.counters().acceptedIngressByOriginWindow[0],
			).toBe(1);
			await cohort.harness.close();
		});

		test("warmup_drain_resets_measured_counters", async () => {
			const cohort = await connectCohort(binding, {
				publisherCount: 1,
				subscriberCount: 2,
			});
			await runWarmup(cohort);

			const beforeDrain = cohort.harness.relay.counters();
			expect(beforeDrain.warmupIngress).toBe(WARMUP_MESSAGES_PER_PUBLISHER);
			expect(beforeDrain.warmupDeliveries).toBe(
				WARMUP_MESSAGES_PER_PUBLISHER * 2,
			);
			for (const subscriber of cohort.subscribers) {
				const warmupData = subscriber
					.received()
					.filter((frame) => frame.kind === "warmup-data");
				expect(warmupData.length).toBe(WARMUP_MESSAGES_PER_PUBLISHER);
			}

			const drained = cohort.harness.relay.drainWarmup();
			expect(drained.ok).toBe(true);
			if (!drained.ok) throw new Error("unreachable");
			expect(drained.value.warmupQueuesEmpty).toBe(true);
			expect(drained.value.measuredCountersReset).toBe(true);
			expect(drained.value.warmupIngress).toBe(WARMUP_MESSAGES_PER_PUBLISHER);
			expect(drained.value.warmupDeliveries).toBe(
				WARMUP_MESSAGES_PER_PUBLISHER * 2,
			);

			// Every measured counter is zero and the warmup totals survive only in
			// the warmup authority.
			const afterDrain = cohort.harness.relay.counters();
			for (const window of afterDrain.acceptedIngressByOriginWindow)
				expect(window).toBe(0);
			for (const window of afterDrain.relayWritesCompletedByOriginWindow) {
				expect(window).toBe(0);
			}
			for (const window of afterDrain.duplicateIngressByOriginWindow)
				expect(window).toBe(0);
			expect(afterDrain.queuedItems).toBe(0);
			expect(afterDrain.warmupIngress).toBe(WARMUP_MESSAGES_PER_PUBLISHER);
			expect(afterDrain.warmupDeliveries).toBe(
				WARMUP_MESSAGES_PER_PUBLISHER * 2,
			);

			// Each subscriber saw exactly one relay-warmup-drained marker.
			await cohort.harness.settle();
			for (const subscriber of cohort.subscribers) {
				const markers = subscriber
					.received()
					.filter(
						(frame) =>
							frame.kind === "warmup-end" &&
							frame.reason === "relay-warmup-drained",
					);
				expect(markers.length).toBe(1);
			}

			// The accepted-ordinal sequence restarts at zero for measured traffic:
			// a warmup ordinal can never be reused as a measured one.
			expect(
				cohort.harness.relay.acceptLinuxBarrier(barrierAcceptance() as never)
					.ok,
			).toBe(true);
			const publisher = cohort.publishers[0] as RelayPeer;
			expect((await publisher.send(dataFrame(publisher.roleId, 0))).ok).toBe(
				true,
			);
			await cohort.harness.settle();
			const firstAccepted = acksOf(publisher).find(
				(ack) => ack.disposition === "accepted" && ack.kind === "ack",
			);
			expect(firstAccepted?.linuxAcceptedOrdinal).toBe(0);
			await cohort.harness.close();
		});

		test("relay_slow_subscriber_is_bounded_failure", async () => {
			const cohort = await connectCohort(binding, {
				publisherCount: 1,
				subscriberCount: 2,
			});
			await armMeasured(cohort);
			const publisher = cohort.publishers[0] as RelayPeer;
			const slow = cohort.subscribers[1] as RelayPeer;
			const fast = cohort.subscribers[0] as RelayPeer;
			slow.block();

			const overrun = RELAY_SUBSCRIBER_QUEUE_MAX_ITEMS + 5;
			for (let sequence = 0; sequence < overrun; sequence += 1) {
				await publisher.send(dataFrame(publisher.roleId, sequence));
			}
			await cohort.harness.settle();

			// The slow subscriber never buffers past its cap, is closed, and the
			// deliveries it could not take are counted, not silently forgotten.
			// The tight bound with one blocked and one draining subscriber: the
			// blocked queue caps at its own limit and the draining one holds at
			// most the item being written.
			const counters = cohort.harness.relay.counters();
			expect(counters.queueItemsPeak).toBeLessThanOrEqual(
				RELAY_SUBSCRIBER_QUEUE_MAX_ITEMS + 1,
			);
			expect(counters.queuedItems).toBe(0);
			expect(counters.queueDropDeliveriesByOriginWindow[0]).toBeGreaterThan(0);
			expect(faultKinds(cohort.harness.relay)).toContain(
				"subscriber-queue-full",
			);
			expect(cohort.harness.relay.isPromotable()).toBe(false);
			expect(dataFramesOf(slow).length).toBe(0);
			expect(dataFramesOf(fast).length).toBeGreaterThan(0);

			// Once the required fanout set can no longer be satisfied, admission
			// closes with the exact cause instead of acknowledging more ingress.
			await publisher.send(dataFrame(publisher.roleId, overrun));
			await cohort.harness.settle();
			const closed = acksOf(publisher).filter(
				(ack) => ack.disposition === "closed",
			);
			expect(closed.length).toBeGreaterThan(0);
			expect(closed[closed.length - 1]?.code).toBe("SUBSCRIBER_QUEUE_FULL");
			await cohort.harness.close();
		});

		test("relay_global_queue_and_write_caps_hold", async () => {
			const globalQueueMaxItems = 8;
			const cohort = await connectCohort(binding, {
				publisherCount: 1,
				subscriberCount: 2,
				caps: { globalQueueMaxItems, maxConcurrentWrites: 1 },
			});
			await armMeasured(cohort);
			const publisher = cohort.publishers[0] as RelayPeer;
			for (const subscriber of cohort.subscribers) subscriber.block();

			// Four admissions fill the global queue at an expansion of two; the
			// fifth is refused at the ingress boundary rather than queued.
			for (let sequence = 0; sequence < 4; sequence += 1) {
				expect(
					(await publisher.send(dataFrame(publisher.roleId, sequence))).ok,
				).toBe(true);
			}
			expect(cohort.harness.relay.counters().queuedItems).toBe(
				globalQueueMaxItems,
			);
			const overflow = await publisher.send(dataFrame(publisher.roleId, 4));
			expect(overflow.ok).toBe(false);
			await cohort.harness.settle();

			const counters = cohort.harness.relay.counters();
			expect(counters.queuedItems).toBeLessThanOrEqual(globalQueueMaxItems);
			expect(counters.queueItemsPeak).toBeLessThanOrEqual(globalQueueMaxItems);
			expect(counters.concurrentWritesPeak).toBeLessThanOrEqual(1);
			expect(counters.acceptedIngressByOriginWindow[0]).toBe(4);
			const closed = acksOf(publisher).filter(
				(ack) => ack.disposition === "closed",
			);
			expect(closed[closed.length - 1]?.code).toBe("RELAY_INGRESS_QUEUE_FULL");
			expect(faultKinds(cohort.harness.relay)).toContain("global-queue-full");

			// The write deadline is the other bound: a delivery that has sat past
			// it is a timeout, not an unbounded wait.
			await cohort.harness.advanceMs(RELAY_WRITE_DEADLINE_MS + 1);
			await cohort.harness.settle();
			const timedOut = cohort.harness.relay.counters();
			expect(timedOut.writeTimeoutDeliveriesByOriginWindow[0]).toBeGreaterThan(
				0,
			);
			expect(faultKinds(cohort.harness.relay)).toContain("write-timeout");
			expect(RELAY_CONTROL_BACKLOG_MAX_ITEMS).toBeGreaterThan(0);
			await cohort.harness.close();
		});

		test("relay_duplicate_and_reorder_fail_promotion", async () => {
			const cohort = await connectCohort(binding, {
				publisherCount: 1,
				subscriberCount: 2,
			});
			await armMeasured(cohort);
			const publisher = cohort.publishers[0] as RelayPeer;
			expect((await publisher.send(dataFrame(publisher.roleId, 0))).ok).toBe(
				true,
			);
			expect((await publisher.send(dataFrame(publisher.roleId, 1))).ok).toBe(
				true,
			);

			const duplicate = await publisher.send(dataFrame(publisher.roleId, 1));
			expect(duplicate.ok).toBe(false);
			if (duplicate.ok) throw new Error("unreachable");
			expect(duplicate.code).toBe(RELAY_DELIVERY_FAILURE_CODE);

			const reordered = await publisher.send(dataFrame(publisher.roleId, 5));
			expect(reordered.ok).toBe(false);
			await cohort.harness.settle();

			const acks = acksOf(publisher);
			expect(acks.filter((ack) => ack.disposition === "duplicate").length).toBe(
				1,
			);
			expect(acks.filter((ack) => ack.disposition === "reordered").length).toBe(
				1,
			);
			expect(acks.find((ack) => ack.disposition === "duplicate")?.code).toBe(
				"DUPLICATE_PUBLISHER_SEQUENCE",
			);
			expect(acks.find((ack) => ack.disposition === "reordered")?.code).toBe(
				"REORDERED_PUBLISHER_SEQUENCE",
			);
			// Neither disposition may fabricate an accepted ordinal.
			for (const ack of acks) {
				if (ack.disposition === "accepted") continue;
				expect(ack.linuxAcceptedOrdinal).toBeNull();
				expect(ack.linuxAcceptedAtNs).toBeNull();
			}

			const counters = cohort.harness.relay.counters();
			expect(counters.duplicateIngressByOriginWindow[0]).toBe(1);
			expect(counters.reorderedIngressByOriginWindow[0]).toBe(1);
			expect(counters.acceptedIngressByOriginWindow[0]).toBe(2);
			expect(faultKinds(cohort.harness.relay)).toContain("duplicate-ingress");
			expect(faultKinds(cohort.harness.relay)).toContain("reordered-ingress");
			expect(cohort.harness.relay.isPromotable()).toBe(false);
			await cohort.harness.close();
		});

		test("relay_partial_connect_and_disconnect_are_counted", async () => {
			// Two subscribers are expected; only one ever registers.
			const cohort = await connectCohort(
				binding,
				{ publisherCount: 1, subscriberCount: 2 },
				1,
			);
			const partial = cohort.harness.relay.counters();
			expect(partial.missingSubscriberRegistrations).toBe(1);
			expect(partial.registeredSubscriberIds).toEqual([
				fanoutRoleId("subscriber", 0),
			]);
			expect(faultKinds(cohort.harness.relay)).toContain("partial-connect");
			expect(cohort.harness.relay.isPromotable()).toBe(false);

			await armMeasured(cohort);
			const publisher = cohort.publishers[0] as RelayPeer;
			const subscriber = cohort.subscribers[0] as RelayPeer;

			// A delivery is queued and then the session vanishes: the record is
			// charged as undelivered to its own origin window.
			subscriber.block();
			expect((await publisher.send(dataFrame(publisher.roleId, 0))).ok).toBe(
				true,
			);
			expect(cohort.harness.relay.counters().queuedItems).toBe(1);
			await subscriber.drop();
			await cohort.harness.settle();

			const counters = cohort.harness.relay.counters();
			expect(counters.disconnectUndeliveredByOriginWindow[0]).toBe(1);
			expect(counters.subscriberDisconnects).toBe(1);
			expect(counters.registeredSubscriberIds).toEqual([]);
			expect(counters.sessionsAccepted).toBe(2);
			expect(counters.subscriberSessionsActivePeak).toBe(1);
			expect(faultKinds(cohort.harness.relay)).toContain(
				"disconnect-undelivered",
			);
			await cohort.harness.close();
		});

		test("relay_end_markers_and_bounded_shutdown", async () => {
			const cohort = await connectCohort(binding, {
				publisherCount: 1,
				subscriberCount: 2,
			});
			await armMeasured(cohort);
			const publisher = cohort.publishers[0] as RelayPeer;
			for (let sequence = 0; sequence < 3; sequence += 1) {
				expect(
					(await publisher.send(dataFrame(publisher.roleId, sequence))).ok,
				).toBe(true);
			}
			expect((await publisher.send(endFrame(publisher.roleId, 2))).ok).toBe(
				true,
			);
			expect(cohort.harness.relay.counters().publisherEndCount).toBe(1);

			// A second end marker from the same publisher is a fault, not a
			// second count.
			const second = await publisher.send(endFrame(publisher.roleId, 2));
			expect(second.ok).toBe(false);
			expect(cohort.harness.relay.counters().publisherEndCount).toBe(1);
			expect(faultKinds(cohort.harness.relay)).toContain(
				"duplicate-end-marker",
			);

			expect(cohort.harness.relay.stopMeasurement().ok).toBe(true);
			const shutdown = cohort.harness.relay.shutdown();
			expect(shutdown.ok).toBe(true);
			if (!shutdown.ok) throw new Error("unreachable");
			expect(shutdown.value.allSessionsClosed).toBe(true);
			expect(shutdown.value.queuedItemsAtClose).toBe(0);
			expect(shutdown.value.subscriberEndCount).toBe(2);
			expect(shutdown.value.drainDurationMs).toBeLessThanOrEqual(
				COHORT_DRAIN_DEADLINE_MS,
			);
			expect(shutdown.value.reapedSessionCount).toBe(3);
			expect(cohort.harness.relay.phase).toBe("closed");

			// Each subscriber saw exactly one relay-drained end marker, and the
			// relay state is reaped: a second shutdown reaps nothing further.
			await cohort.harness.settle();
			for (const subscriber of cohort.subscribers) {
				const markers = subscriber
					.received()
					.filter(
						(frame) => frame.kind === "end" && frame.reason === "relay-drained",
					);
				expect(markers.length).toBe(1);
			}
			const again = cohort.harness.relay.shutdown();
			expect(again.ok).toBe(true);
			if (!again.ok) throw new Error("unreachable");
			expect(again.value.reapedSessionCount).toBe(0);
			expect(cohort.harness.relay.counters().registeredSubscriberIds).toEqual(
				[],
			);

			// A relay that cannot drain inside its deadline refuses instead of
			// waiting forever.
			const stuck = await connectCohort(binding, {
				publisherCount: 1,
				subscriberCount: 2,
				caps: { drainDeadlineMs: 0 },
			});
			await armMeasured(stuck);
			for (const subscriber of stuck.subscribers) subscriber.block();
			const stuckPublisher = stuck.publishers[0] as RelayPeer;
			expect(
				(await stuckPublisher.send(dataFrame(stuckPublisher.roleId, 0))).ok,
			).toBe(true);
			await stuck.harness.advanceMs(1);
			const refused = stuck.harness.relay.shutdown();
			expect(refused.ok).toBe(false);
			if (refused.ok) throw new Error("unreachable");
			expect(refused.code).toBe(RELAY_DELIVERY_FAILURE_CODE);
			// The deadline is the reason, not an incidental stall: a shutdown that
			// gave up for any other cause would not name it.
			expect(refused.message).toContain("did not drain within");
		});

		test("ws_and_wt_wire_mapping_are_equivalent", async () => {
			// The claim under test: the same logical frame sequence, carried by
			// this binding and by the socket binding for the other transport,
			// produces the identical relay observation. Both halves are run for
			// real -- neither side is a recorded expectation.
			const counterpart = crossTransportCounterpart(binding);
			const mine = await observeEquivalenceScript(binding);
			const theirs = await observeEquivalenceScript(counterpart);
			expect(mine).toEqual(theirs);

			// Non-vacuity: the script actually delivered something to compare.
			expect(mine.ackDispositions).toEqual([
				"accepted",
				"accepted",
				"accepted",
			]);
			expect(mine.acceptedOrdinals).toEqual([0, 1, 2]);
			const subscriberIds = Object.keys(mine.deliveriesBySubscriber);
			expect(subscriberIds.length).toBe(2);
			for (const subscriberId of subscriberIds) {
				expect(mine.deliveriesBySubscriber[subscriberId]).toEqual([
					{ ordinal: 0, sequence: 0, digest: expect.any(String) },
					{ ordinal: 1, sequence: 1, digest: expect.any(String) },
					{ ordinal: 2, sequence: 2, digest: expect.any(String) },
				]);
				expect(mine.subscriberEndReasons[subscriberId]).toEqual([
					"relay-warmup-drained",
					"relay-drained",
				]);
			}
			expect(mine.subscriberEndCount).toBe(2);

			const cohort = await connectCohort(binding, {
				publisherCount: 1,
				subscriberCount: 2,
			});
			await armMeasured(cohort);
			const publisher = cohort.publishers[0] as RelayPeer;
			expect((await publisher.send(dataFrame(publisher.roleId, 0))).ok).toBe(
				true,
			);
			expect((await publisher.send(endFrame(publisher.roleId, 0))).ok).toBe(
				true,
			);
			await cohort.harness.settle();

			// Every frame this cohort actually produced, on both mappings.
			const frames: FanoutWireV1[] = [
				...publisher.received(),
				...(cohort.subscribers[0] as RelayPeer).received(),
				...(cohort.subscribers[1] as RelayPeer).received(),
				dataFrame(publisher.roleId, 0),
			];
			expect(frames.length).toBeGreaterThan(0);

			for (const frame of frames) {
				const ws = encodeFanoutWsMessage(frame);
				const wt = encodeFanoutWtFrame(frame);
				expect(ws.ok).toBe(true);
				expect(wt.ok).toBe(true);
				if (!ws.ok || !wt.ok) throw new Error("unreachable");

				// WT is exactly `u32be length || the WS message bytes`.
				expect(wt.value.byteLength).toBe(
					ws.value.byteLength + FANOUT_WT_LENGTH_PREFIX_BYTES,
				);
				const view = new DataView(
					wt.value.buffer,
					wt.value.byteOffset,
					wt.value.byteLength,
				);
				expect(view.getUint32(0, false)).toBe(ws.value.byteLength);
				expect([...wt.value.subarray(FANOUT_WT_LENGTH_PREFIX_BYTES)]).toEqual([
					...ws.value,
				]);

				// Both mappings decode back to the identical logical frame.
				const fromWs = decodeFanoutWsMessage(ws.value);
				const fromWt = decodeFanoutWtStream(wt.value);
				expect(fromWs.ok).toBe(true);
				expect(fromWt.ok).toBe(true);
				if (!fromWs.ok || !fromWt.ok) throw new Error("unreachable");
				expect(fromWt.value.length).toBe(1);
				expect(fromWt.value[0]).toEqual(fromWs.value);
				expect(fromWs.value).toEqual(frame);

				// And so do the codecs the relay itself selects per transport.
				const wsCodec = fanoutFrameCodecFor("ws");
				const wtCodec = fanoutFrameCodecFor("wt");
				const wsRound = wsCodec.decode(mustEncode(wsCodec, frame));
				const wtRound = wtCodec.decode(mustEncode(wtCodec, frame));
				expect(wsRound.ok).toBe(true);
				expect(wtRound.ok).toBe(true);
				if (!wsRound.ok || !wtRound.ok) throw new Error("unreachable");
				expect(wsRound.value).toEqual(wtRound.value);
			}
			await cohort.harness.close();
		});
	});
}

function refusalCode(peer: RelayPeer): string | undefined {
	const refusals = peer.received().filter((frame) => frame.kind === "refuse");
	const last = refusals[refusals.length - 1];
	return last !== undefined && last.kind === "refuse" ? last.code : undefined;
}
