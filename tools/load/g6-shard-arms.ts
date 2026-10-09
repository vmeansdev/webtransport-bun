/**
 * Shard-side state for the sharded G6 arms (plan
 * docs/superpowers/plans/2026-10-06-g6-sharded-arms.md r6, work item 2):
 * the storm's server-clock sever instant, the accept and admission series a
 * storm cell reads per shard, and the raid membership echo a hotspot cell
 * validates placement with (V-P).
 *
 * Pure and clock-injected so it is tested without a server; g6-shard-server.ts
 * only wires it to the addon's metrics and its stdio protocol.
 */
import type { EmitterPhase } from "./g6-artifact.ts";

/** Phases a shard accepts on stdin. The steady-path set is the first four. */
export const SHARD_STEADY_PHASES = [
	"connect",
	"steady",
	"drain",
	"idle",
] as const;
export const SHARD_ARMS_PHASES = ["sever", "storm", "post-storm"] as const;
export type ShardArmsPhase = (typeof SHARD_ARMS_PHASES)[number];
export type ShardPhase = (typeof SHARD_STEADY_PHASES)[number] | ShardArmsPhase;

export function isShardPhase(value: unknown): value is ShardPhase {
	return (
		(SHARD_STEADY_PHASES as readonly unknown[]).includes(value) ||
		(SHARD_ARMS_PHASES as readonly unknown[]).includes(value)
	);
}

export function isArmsPhase(value: unknown): value is ShardArmsPhase {
	return (SHARD_ARMS_PHASES as readonly unknown[]).includes(value);
}

/**
 * The emitter phase a shard phase maps to. "sever" is not an emitter phase:
 * the realm is receive-only between the sever and the storm window, exactly
 * as during the drain grace that precedes it, so the emitter stays where it
 * was (drain) and only the sever instant moves.
 */
export function emitterPhaseFor(
	phase: ShardPhase,
	current: EmitterPhase,
): EmitterPhase {
	return phase === "sever" ? current : phase;
}

/** One admission sample, taken once a second from sever to stop. */
export type StormSample = {
	tMs: number;
	sessionsActive: number | null;
	handshakesInFlight: number | null;
	limitExceededCount: number | null;
	rateLimitedCount: number | null;
};

export const STORM_SAMPLE_INTERVAL_MS = 1000;
/** A storm cell lasts < 10 minutes; anything past this is a runaway. */
export const STORM_SAMPLES_MAX = 900;

function metricNumber(metrics: Record<string, unknown>, key: string) {
	const value = metrics[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function stormSample(
	tMs: number,
	metrics: Record<string, unknown>,
): StormSample {
	return {
		tMs,
		sessionsActive: metricNumber(metrics, "sessionsActive"),
		handshakesInFlight: metricNumber(metrics, "handshakesInFlight"),
		limitExceededCount: metricNumber(metrics, "limitExceededCount"),
		rateLimitedCount: metricNumber(metrics, "rateLimitedCount"),
	};
}

/** Accepts per wall second, keyed by the server's own clock. */
export function acceptSeriesPerSecond(
	acceptMs: readonly number[],
): { tMs: number; accepts: number }[] {
	const buckets = new Map<number, number>();
	for (const t of acceptMs) {
		const key = Math.floor(t / 1000) * 1000;
		buckets.set(key, (buckets.get(key) ?? 0) + 1);
	}
	return [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([tMs, accepts]) => ({ tMs, accepts }));
}

export type ShardArmsState = {
	severAtMs: number | null;
	raidMemberTokens: number[];
	stormSamples: StormSample[];
};

export function freshShardArmsState(): ShardArmsState {
	return { severAtMs: null, raidMemberTokens: [], stormSamples: [] };
}

/** Validate and apply one phase message's arms fields. */
export function applyArmsPhase(
	state: ShardArmsState,
	message: { phase: ShardPhase; severAtMs?: unknown },
): void {
	if (message.phase === "sever") {
		if (state.severAtMs !== null)
			throw Error("g6-shard-server: duplicate sever");
		if (
			typeof message.severAtMs !== "number" ||
			!Number.isSafeInteger(message.severAtMs) ||
			message.severAtMs <= 0
		)
			throw Error("g6-shard-server: sever requires a server-clock severAtMs");
		state.severAtMs = message.severAtMs;
	} else if (isArmsPhase(message.phase) && state.severAtMs === null) {
		throw Error(`g6-shard-server: ${message.phase} before sever`);
	}
}

export function recordStormSample(
	state: ShardArmsState,
	sample: StormSample,
): void {
	if (state.stormSamples.length < STORM_SAMPLES_MAX)
		state.stormSamples.push(sample);
}

/**
 * The arms echo carried beside every boundary snapshot. `full` (the stop
 * boundary) adds the raw post-sever accept instants and the admission
 * series; the other boundaries carry counts only.
 */
/**
 * Shard-side H4 / V-I inputs (gate-g6-mmo §7 ingest reality, plan r6 "cadence
 * on shard K's publisher arrivals"): the raw steady+drain publisher arrival
 * gaps on this shard's own clock, its stamped/ingested counts and the
 * ingest-to-forward dwell. Raw facts only; the grader computes the cadence.
 */
export type ShardHotspotRaw = {
	publisherArrivalsSteadyDrain: number;
	publisherStampedSteadyDrain: number;
	publisherGapsSteadyDrainNs: readonly number[];
	ingestToForwardSteadyDrain: unknown;
};

export function armsEcho(input: {
	state: ShardArmsState;
	acceptSeries: readonly number[];
	sessionKinds: { player: number; raid: number; publisher: number };
	full: boolean;
	hotspot?: ShardHotspotRaw;
}) {
	const { state, acceptSeries } = input;
	const severAtMs = state.severAtMs;
	const afterSever =
		severAtMs === null ? [] : acceptSeries.filter((t) => t > severAtMs);
	return {
		severAtMs,
		sessionKinds: input.sessionKinds,
		raidMembers: {
			count: state.raidMemberTokens.length,
			tokens: [...state.raidMemberTokens].sort((a, b) => a - b),
		},
		acceptsTotal: acceptSeries.length,
		acceptsAfterSever: afterSever.length,
		...(input.full
			? {
					acceptMsAfterSever: afterSever,
					acceptSeriesPerSecond: acceptSeriesPerSecond(acceptSeries),
					stormSamples: state.stormSamples,
					...(input.hotspot === undefined
						? {}
						: {
								hotspot: {
									...input.hotspot,
									publisherGapsSteadyDrainNs: [
										...input.hotspot.publisherGapsSteadyDrainNs,
									],
								},
							}),
				}
			: {}),
	};
}
