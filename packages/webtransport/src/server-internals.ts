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
