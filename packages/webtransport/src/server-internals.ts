/**
 * Server surfaces deliberately kept OFF the 1.0 public contract.
 *
 * One mechanism for every excluded surface: `createServer` registers a
 * {@link ServerInternals} object for each server it returns, and the only way
 * to reach it is `__TESTING__.serverInternals(server)` on the root module —
 * the one tolerated non-public export, explicitly unstable (docs/SPEC.md,
 * "Semver rules"). Nothing here is covered by semver: it may be reshaped or
 * removed in any release. The intended callers are this repository's tests
 * and the measurement harnesses under tools/; applications must not use it.
 *
 * What lives here, and why it is not public:
 * - the native datagram reflector (`setDatagramReflector`) and its metrics —
 *   a capacity-campaign instrument, excluded from 1.0;
 * - the transport-campaign getters (`server*()`), which echo unsupported
 *   tuning knobs back so a harness can refuse a shard that did not get the
 *   value it asked for;
 * - the diagnostic readouts (`__sendPathDiagnostics`, `__pacerStats*`);
 * - counters in {@link InternalMetricsSnapshot} that only mean something to
 *   that campaign. The public `metricsSnapshot()` strips them at runtime, so
 *   they are absent in fact, not merely absent from the type.
 */

import type { DatagramReflectorRule } from "./datagram-reflector.js";
// Type-only: erased at runtime, so no import cycle with index.ts.
import type { MetricsSnapshot } from "./index.js";
import type { HistogramSnapshot } from "./types.js";

/** Campaign-only server counters, never on the public `MetricsSnapshot`. */
export type InternalServerMetrics = {
	/** Datagrams the per-server reflector matched. */
	datagramReflectHits?: number;
	/** Reflected replies the transport accepted. */
	datagramReflectSent?: number;
	/** Reflected replies dropped because the sender queue was full. */
	datagramReflectQueueFull?: number;
	/** Reflected replies the transport refused; dropped, never retried. */
	datagramReflectSendErrors?: number;
	datagramReflectSendErrorsByReason?: {
		notConnected: number;
		unsupportedByPeer: number;
		tooLarge: number;
	};
	/** Receive-to-reflection duration. Present when any observation. */
	datagramReflectHold?: HistogramSnapshot | null;
	datagramReflectRingBypassMarked?: number;
	datagramReflectRingBypassRefreshed?: number;
	datagramReflectRingBypassRefused?: number;
	datagramReflectRingBypassExpired?: number;
	datagramReflectRingBypassed?: number;
	datagramReflectRingDirectBlocked?: number;
	datagramReflectRingDirectErrors?: number;
	datagramReflectRingGsoFallback?: number;
	/** Process-wide. Cross-connection UDP send batching
	 * (`WEBTRANSPORT_NATIVE_UDP_SEND_BATCH`): sendmmsg calls, datagrams sent
	 * through them, datagrams sent one at a time instead, WouldBlocks handed
	 * to a driver because the ring was full, datagrams dropped because the
	 * flusher was gone or a fallback WouldBlocked, congestion drops admitted
	 * by EAGAIN drop mode, send errors, largest batch flushed. All zero while
	 * batching is off. */
	udpSendBatchCalls?: number;
	udpSendBatchMessages?: number;
	udpSendBatchFallback?: number;
	udpSendBatchBlocked?: number;
	udpSendBatchDropped?: number;
	udpSendBatchCongestionDropped?: number;
	udpSendBatchErrors?: number;
	udpSendBatchMaxBatch?: number;
	/** Per-connection datagram pump tasks of the wtransport fork's driver. */
	datagramPumpsSpawned?: number;
	datagramPumpsLive?: number;
	/**
	 * Connections that were live when this snapshot was taken and therefore
	 * contributed to the `quic*` sums below.
	 */
	quicSessions?: number;
	/**
	 * quinn transport counters summed over those live connections. A boundary
	 * sample, not a lifetime total — a closed session's counters go with it —
	 * so two snapshots may only be differenced across a window whose session
	 * set is stable. They separate socket-to-quinn loss
	 * (`quicUdpDatagramsReceived` short of what the peer sent) from
	 * quinn-to-application loss (`quicDatagramFramesReceived` short of what the
	 * app counted).
	 */
	quicUdpDatagramsReceived?: number;
	quicUdpDatagramsSent?: number;
	quicDatagramFramesReceived?: number;
	quicDatagramFramesSent?: number;
	quicPacketsSent?: number;
	quicPacketsLost?: number;
};

/** Every key of {@link InternalServerMetrics}; the public snapshot drops these. */
export const INTERNAL_METRIC_KEYS: readonly (keyof InternalServerMetrics)[] = [
	"datagramReflectHits",
	"datagramReflectSent",
	"datagramReflectQueueFull",
	"datagramReflectSendErrors",
	"datagramReflectSendErrorsByReason",
	"datagramReflectHold",
	"datagramReflectRingBypassMarked",
	"datagramReflectRingBypassRefreshed",
	"datagramReflectRingBypassRefused",
	"datagramReflectRingBypassExpired",
	"datagramReflectRingBypassed",
	"datagramReflectRingDirectBlocked",
	"datagramReflectRingDirectErrors",
	"datagramReflectRingGsoFallback",
	"udpSendBatchCalls",
	"udpSendBatchMessages",
	"udpSendBatchFallback",
	"udpSendBatchBlocked",
	"udpSendBatchDropped",
	"udpSendBatchCongestionDropped",
	"udpSendBatchErrors",
	"udpSendBatchMaxBatch",
	"datagramPumpsSpawned",
	"datagramPumpsLive",
	"quicSessions",
	"quicUdpDatagramsReceived",
	"quicUdpDatagramsSent",
	"quicDatagramFramesReceived",
	"quicDatagramFramesSent",
	"quicPacketsSent",
	"quicPacketsLost",
];

/** A full native snapshot: the public fields plus the internal ones. */
export type InternalMetricsSnapshot = MetricsSnapshot & InternalServerMetrics;

/** What `__TESTING__.serverInternals(server)` hands back. Unstable. */
export interface ServerInternals {
	/**
	 * Install, replace, or clear (`null`) this server's datagram reflector: a
	 * matched datagram is answered in native with a rewritten copy of its first
	 * bytes and never reaches `incomingDatagrams()`. Native-only.
	 */
	setDatagramReflector(rule: DatagramReflectorRule | null): void;
	/** Native reflector direct-lane mode
	 * (`WEBTRANSPORT_NATIVE_REFLECT_RING_BYPASS`): "off" | "on". */
	serverReflectRingBypass(): string;
	/**
	 * Effective Tokio worker count of the native server runtime in this
	 * process. 2 unless `WEBTRANSPORT_NATIVE_SERVER_WORKERS` overrode it before
	 * the addon built its runtime.
	 */
	serverWorkerThreads(): number;
	/** Endpoint-driver placement the addon resolved: "shared" | "dedicated". */
	serverRecvRuntime(): string;
	/** ACK cadence requested of the client the addon resolved: "default" | "relaxed". */
	serverAckCadence(): string;
	/** Requested UDP server send buffer bytes the addon resolved; 0 = default bind path. */
	serverUdpSendBufferBytes(): number;
	/** Cross-connection UDP send batch size the addon resolved
	 * (`WEBTRANSPORT_NATIVE_UDP_SEND_BATCH`); 0 = off, one sendmsg per transmit. */
	serverUdpSendBatch(): number;
	/** wtransport driver datagram read path in this process: "pump" (default,
	 * dedicated per-connection task) | "legacy" (`WTRANSPORT_DATAGRAM_PUMP=0`). */
	serverDatagramDriver(): string;
	/** Linux sendmmsg EAGAIN policy: "wait" | "drop". */
	serverUdpSendEagainMode(): string;
	/**
	 * Windowed egress-pacer counters for bench tooling. **Absent** (not
	 * `"{}"`) on addons built without the pacer accessors, so a caller can tell
	 * a stale addon from a live addon whose pacer is simply off — the latter
	 * returns `"{}"`.
	 */
	__pacerStatsSnapshot?(): number;
	__pacerStatsJson?(token?: number): string;
	/** Process-wide send-path phase banks; absent on older addons. */
	__sendPathDiagnostics?(phase?: string): string;
	/**
	 * Test seam: feed native server-session events (`session`,
	 * `session_closed`) through the exact handler the addon's TSFN calls, so a
	 * test can deliver an accept at a chosen point of the close sequence.
	 */
	deliverSessionEventsForTests(
		events: {
			name: string;
			id?: string;
			peerIp?: string;
			peerPort?: number;
			code?: number;
			reason?: string;
		}[],
	): void;
	/** Test seam: sessions holding a `closed` resolver not yet settled. */
	ownedSessionCountForTests(): number;
	/** The unfiltered native snapshot, internal counters included. */
	metricsSnapshot(): InternalMetricsSnapshot;
}

const REGISTRY = new WeakMap<object, ServerInternals>();

/** Called by `createServer` once per server it returns. */
export function registerServerInternals(
	server: object,
	internals: ServerInternals,
): void {
	REGISTRY.set(server, internals);
}

/**
 * The internals of a server the root `createServer` returned. Throws for
 * anything else, so a harness handed the wrong object fails loudly instead of
 * reading `undefined` as "feature off".
 */
export function serverInternals(server: object): ServerInternals {
	const internals = REGISTRY.get(server);
	if (internals === undefined) {
		throw new TypeError(
			"serverInternals: not a server returned by the root createServer()",
		);
	}
	return internals;
}

/** A copy of `snapshot` without the internal counters. */
export function withoutInternalMetrics<T extends object>(snapshot: T): T {
	const out = { ...snapshot } as Record<string, unknown>;
	for (const key of INTERNAL_METRIC_KEYS) delete out[key];
	return out as T;
}
