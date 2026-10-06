/**
 * The sharded G6 arms — raid hotspot and reconnect storm on the sharded
 * deployment (plan docs/superpowers/plans/2026-10-06-g6-sharded-arms.md r6,
 * work items 1–3). Everything the scan conductor needs that is not process
 * plumbing lives here, pure, so it is tested without hosts:
 *
 *   - the arm configuration (SCAN_ARM and its registered shape),
 *   - every generator argv the arms add (realm extras, publisher, raid
 *     subscriber, the generator-loopback forwarder, the V-F floor, the V-S
 *     sink),
 *   - the facts the conductor records beside the merged reports (per-shard
 *     session counts client vs server, raid placement, sever skew, V-R,
 *     storm-window steering deltas). Facts, never verdicts: grading is the
 *     next work item's.
 *
 * The steady arm adds nothing: every function here returns "no change" for it.
 */
import { evenShare } from "./g6-client-merge.ts";
import type { LatencyHistogramJson } from "./latency-histogram.ts";

export type ScanArm = "steady" | "hotspot" | "storm";

/** Registered shapes (gate-g6-mmo §1.7/§1.8 + plan r6). */
export const ARMS_REGISTERED = Object.freeze({
	hotspotSteadySeconds: 120,
	stormSteadySeconds: 60,
	stormReconnectDelayMs: 1000,
	stormWindowSeconds: 120,
	postStormSeconds: 60,
	raidMembers: 40,
	raidPublisherHz: 20,
	/** Opening-DCID length (plan §1); 11 only for the negative control. */
	dcidLen: 20,
	/** V-F: G6_FLOOR_SESSIONS in g6-evaluate.ts. */
	floorSessions: 20,
	floorSeconds: 10,
	/** V-S: 1.5 × 800/s through the generator-loopback forwarder. */
	sinkSeconds: 20,
	sinkTargetPps: 1200,
});

export type ArmsConfig = {
	arm: ScanArm;
	shards: number;
	raidTargetSlot: number;
	raidDcidLen: number;
	stormCohort: number;
	steadySeconds: number;
	stormWindowSeconds: number;
	postStormSeconds: number;
	stormReconnectDelayMs: number;
	loopbackPort: number;
	/** Any duration differs from the registered one (rehearsal only). */
	durationsOverridden: boolean;
};

function intEnv(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	if (!/^\d+$/.test(raw))
		throw Error(`g6-sharded-arms: ${name} must be an integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max)
		throw Error(`g6-sharded-arms: ${name} must be ${min}..${max}, got ${raw}`);
	return value;
}

export function resolveArmsConfig(
	env: Record<string, string | undefined>,
	input: { shards: number; sessions: number; activeSessions: number },
): ArmsConfig {
	const arm = (env.SCAN_ARM ?? "steady") as ScanArm;
	if (!["steady", "hotspot", "storm"].includes(arm))
		throw Error("g6-sharded-arms: SCAN_ARM must be steady, hotspot or storm");
	if (arm !== "steady" && input.activeSessions !== input.sessions)
		throw Error(
			"g6-sharded-arms: hotspot and storm cells run requested == active (no passive tail)",
		);
	const steadyDefault =
		arm === "storm"
			? ARMS_REGISTERED.stormSteadySeconds
			: ARMS_REGISTERED.hotspotSteadySeconds;
	const steadySeconds = intEnv(
		env,
		"SCAN_ARMS_STEADY_SECONDS",
		steadyDefault,
		1,
		600,
	);
	const stormWindowSeconds = intEnv(
		env,
		"SCAN_STORM_WINDOW_SECONDS",
		ARMS_REGISTERED.stormWindowSeconds,
		1,
		600,
	);
	const postStormSeconds = intEnv(
		env,
		"SCAN_POST_STORM_SECONDS",
		ARMS_REGISTERED.postStormSeconds,
		1,
		600,
	);
	const stormCohort =
		arm === "storm"
			? intEnv(env, "SCAN_STORM_COHORT", 0, 1, input.sessions)
			: 0;
	if (arm === "storm" && env.SCAN_STORM_COHORT === undefined)
		throw Error("g6-sharded-arms: a storm cell requires SCAN_STORM_COHORT");
	return {
		arm,
		shards: input.shards,
		raidTargetSlot: intEnv(
			env,
			"SCAN_RAID_TARGET_SLOT",
			0,
			0,
			input.shards - 1,
		),
		raidDcidLen: intEnv(
			env,
			"SCAN_RAID_DCID_LEN",
			ARMS_REGISTERED.dcidLen,
			8,
			20,
		),
		stormCohort,
		steadySeconds,
		stormWindowSeconds,
		postStormSeconds,
		stormReconnectDelayMs: ARMS_REGISTERED.stormReconnectDelayMs,
		loopbackPort: intEnv(env, "SCAN_LOOPBACK_PORT", 4499, 1024, 65535),
		durationsOverridden:
			steadySeconds !== steadyDefault ||
			stormWindowSeconds !== ARMS_REGISTERED.stormWindowSeconds ||
			postStormSeconds !== ARMS_REGISTERED.postStormSeconds,
	};
}

/** Barrier parties: the realm processes, plus publisher and subscriber. */
export function armsBarrierParties(cfg: ArmsConfig, realmProcesses: number) {
	return realmProcesses + (cfg.arm === "hotspot" ? 2 : 0);
}

export type BarrierSpec = {
	id: string;
	dir: string;
	timeoutMs: number;
};

function barrierArgs(
	cfg: ArmsConfig,
	realmProcesses: number,
	barrier: BarrierSpec,
	party: string,
): string[] {
	return [
		"--phase-barrier-id",
		barrier.id,
		"--phase-barrier-dir",
		barrier.dir,
		"--phase-barrier-party",
		party,
		"--phase-barrier-parties",
		String(armsBarrierParties(cfg, realmProcesses)),
		"--phase-barrier-timeout-ms",
		String(barrier.timeoutMs),
	];
}

/**
 * Appended after the steady realm argv (mmo-client takes the last value of a
 * repeated flag), so the realm keeps its registered steady shape and only
 * gains the arm's flags. Empty for the steady arm.
 */
export function realmArmsArgs(
	cfg: ArmsConfig,
	input: { realmProcesses: number; index: number; barrier: BarrierSpec },
): string[] {
	if (cfg.arm === "steady") return [];
	const common = [
		"--shard-count",
		String(cfg.shards),
		"--steady-secs",
		String(cfg.steadySeconds),
		...barrierArgs(
			cfg,
			input.realmProcesses,
			input.barrier,
			`client-${input.index}`,
		),
	];
	if (cfg.arm === "hotspot")
		return [...common, "--raid-membership", "explicit"];
	return [
		...common,
		// Cohort split by global session index g = local × P + index: the
		// process's share is exactly evenShare, its first `share` locals.
		"--storm-cohort",
		String(evenShare(cfg.stormCohort, input.realmProcesses, input.index)),
		"--storm-timeline",
		"anchored",
		"--storm-reconnect-delay-ms",
		String(cfg.stormReconnectDelayMs),
		"--storm-window-secs",
		String(cfg.stormWindowSeconds),
		"--post-storm-secs",
		String(cfg.postStormSeconds),
		// Zero = no permit pool (gate-g6-mmo §1.8).
		"--storm-concurrency",
		"0",
	];
}

export type RaidRole = "publisher" | "raid-subscriber";

/**
 * The hotspot's raid processes, both placed on slot K by their own opening
 * DCIDs. Each gets its own registered source port after the realm's range.
 */
export function raidProcessArgs(
	cfg: ArmsConfig,
	role: RaidRole,
	input: {
		realmProcesses: number;
		barrier: BarrierSpec;
		drainMs: number;
		idleSeconds: number;
		payloadBytes: number;
		preregistrationSha256: string;
		startedAt: string;
		connectTimeoutSeconds: number;
		fixedSourcePortBase: number | null;
	},
): string[] {
	if (cfg.arm !== "hotspot") throw Error("raid processes run in hotspot cells");
	return [
		"--role",
		role,
		"--sessions",
		role === "publisher" ? "1" : String(ARMS_REGISTERED.raidMembers),
		...(role === "publisher"
			? [
					"--send-interval-ms",
					String(Math.round(1000 / ARMS_REGISTERED.raidPublisherHz)),
					"--payload-bytes",
					String(input.payloadBytes),
				]
			: []),
		"--steady-secs",
		String(cfg.steadySeconds),
		"--drain-ms",
		String(input.drainMs),
		"--idle-secs",
		String(input.idleSeconds),
		"--endpoints",
		"1",
		...(input.fixedSourcePortBase === null
			? []
			: ["--fixed-source-port-base", String(input.fixedSourcePortBase)]),
		"--connect-timeout-secs",
		String(input.connectTimeoutSeconds),
		"--preregistration-sha256",
		input.preregistrationSha256,
		"--started-at",
		input.startedAt,
		"--shard-count",
		String(cfg.shards),
		"--target-shard",
		String(cfg.raidTargetSlot),
		...(cfg.raidDcidLen === ARMS_REGISTERED.dcidLen
			? []
			: ["--dcid-len", String(cfg.raidDcidLen)]),
		"--raid-membership",
		"explicit",
		...barrierArgs(cfg, input.realmProcesses, input.barrier, role),
	];
}

/** The raid processes' fixed source ports: right after the realm's range. */
export function raidSourcePortBase(
	fixedSourcePortBase: number | null,
	realmEndpoints: number,
	role: RaidRole,
): number | null {
	if (fixedSourcePortBase === null) return null;
	return fixedSourcePortBase + realmEndpoints + (role === "publisher" ? 0 : 1);
}

/** Watchdog seconds for the generator processes of a cell (1.5× its phases). */
export function armsDeadlineSec(
	cfg: ArmsConfig,
	input: {
		connectTimeoutSeconds: number;
		drainMs: number;
		idleSeconds: number;
	},
): number {
	const storm =
		cfg.arm === "storm"
			? Math.ceil(cfg.stormReconnectDelayMs / 1000) +
				cfg.stormWindowSeconds +
				cfg.postStormSeconds
			: 0;
	return Math.ceil(
		1.5 *
			(input.connectTimeoutSeconds +
				cfg.steadySeconds +
				Math.ceil(input.drainMs / 1000) +
				storm +
				input.idleSeconds),
	);
}

/* ------------------------------------------------------------------------ */
/* Generator-loopback pre-checks (V-F every cell, V-S hotspot cells)         */
/* ------------------------------------------------------------------------ */

export type PrecheckPlan = {
	dir: string;
	readyPath: string;
	certPath: string;
	keyPath: string;
	/** g6-server argv (after the entry script's `--`). */
	forwarder: string[];
	floor: string[];
	sink: { subscriber: string[]; publisher: string[] } | null;
};

export function precheckPlan(
	cfg: ArmsConfig,
	input: {
		id: string;
		barrierDir: string;
		preregistrationSha256: string;
		startedAt: string;
		moveIntervalMs: number;
		actionEvery: number;
		payloadBytes: number;
		drainMs: number;
	},
): PrecheckPlan | null {
	if (cfg.arm === "steady") return null;
	if (!/^[A-Za-z0-9._-]+$/.test(input.id))
		throw Error("g6-sharded-arms: precheck id must be [A-Za-z0-9._-]");
	const dir = `/tmp/g6-arms-precheck-${input.id}`;
	const url = `https://127.0.0.1:${cfg.loopbackPort}`;
	const identity = [
		"--preregistration-sha256",
		input.preregistrationSha256,
		"--started-at",
		input.startedAt,
	];
	const common = [
		"--bind-default",
		"--url",
		url,
		"--endpoints",
		"1",
		"--drain-ms",
		String(input.drainMs),
		"--idle-secs",
		"1",
		"--connect-timeout-secs",
		"30",
		...identity,
	];
	const sinkBarrier = (party: string) => [
		"--phase-barrier-id",
		`${input.id}-sink`,
		"--phase-barrier-dir",
		input.barrierDir,
		"--phase-barrier-party",
		party,
		"--phase-barrier-parties",
		"2",
		"--phase-barrier-timeout-ms",
		"30000",
	];
	return {
		dir,
		readyPath: `${dir}/forwarder-ready.json`,
		certPath: `${dir}/cert.pem`,
		keyPath: `${dir}/key.pem`,
		forwarder: [
			"--port",
			String(cfg.loopbackPort),
			"--sessions",
			"64",
			"--cert-pem",
			`${dir}/cert.pem`,
			"--key-pem",
			`${dir}/key.pem`,
			// Stopped by the fan-out once the checks are done; the long
			// duration is only an upper bound.
			"--duration-secs",
			"900",
			"--idle-secs",
			"0",
			"--drain-ms",
			"0",
			"--ready-path",
			`${dir}/forwarder-ready.json`,
		],
		floor: [
			"--role",
			"realm",
			"--sessions",
			String(ARMS_REGISTERED.floorSessions),
			"--active-sessions",
			String(ARMS_REGISTERED.floorSessions),
			"--send-interval-ms",
			String(input.moveIntervalMs),
			"--action-every",
			String(input.actionEvery),
			"--payload-bytes",
			String(input.payloadBytes),
			"--steady-secs",
			String(ARMS_REGISTERED.floorSeconds),
			"--connect-concurrency",
			String(ARMS_REGISTERED.floorSessions),
			...common,
		],
		sink:
			cfg.arm === "hotspot"
				? {
						subscriber: [
							"--role",
							"raid-subscriber",
							"--sessions",
							String(ARMS_REGISTERED.raidMembers),
							"--raid-membership",
							"explicit",
							"--steady-secs",
							String(ARMS_REGISTERED.sinkSeconds),
							...common,
							...sinkBarrier("raid-subscriber"),
						],
						publisher: [
							"--role",
							"publisher",
							"--sessions",
							"1",
							// 40 members × 30/s = 1,200/s through the forwarder.
							"--send-interval-us",
							String(
								Math.round(
									(1_000_000 * ARMS_REGISTERED.raidMembers) /
										ARMS_REGISTERED.sinkTargetPps,
								),
							),
							"--payload-bytes",
							String(input.payloadBytes),
							"--steady-secs",
							String(ARMS_REGISTERED.sinkSeconds),
							...common,
							...sinkBarrier("publisher"),
						],
					}
				: null,
	};
}

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec | null =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Rec)
		: null;
const num = (value: unknown): number | null =>
	typeof value === "number" && Number.isFinite(value) ? value : null;

/** V-S facts from the sink's two mmo-client reports (no verdict). */
export function sinkFacts(subscriber: unknown, publisher: unknown) {
	const sub = rec(rec(rec(subscriber)?.windows)?.steadyDrain);
	const pub = rec(rec(rec(publisher)?.windows)?.steady);
	const sent = num(pub?.sent);
	const received = num(sub?.rxRaid);
	const expected = sent === null ? null : sent * ARMS_REGISTERED.raidMembers;
	return {
		kind: "g6-sharded-sink-precheck",
		seconds: ARMS_REGISTERED.sinkSeconds,
		subscribers: ARMS_REGISTERED.raidMembers,
		targetPps: ARMS_REGISTERED.sinkTargetPps,
		publisherSent: sent,
		expectedDeliveries: expected,
		subscriberReceived: received,
		offeredPps:
			expected === null ? null : expected / ARMS_REGISTERED.sinkSeconds,
		deliveryRatio:
			expected === null || received === null || expected === 0
				? null
				: received / expected,
		subscriberSessionsOk: num(rec(subscriber)?.sessionsOk),
		publisherSessionsOk: num(rec(publisher)?.sessionsOk),
	};
}

/** V-F facts from the floor's mmo-client report (the grader re-derives). */
export function floorFacts(report: unknown) {
	const root = rec(report);
	const lag = rec(rec(rec(root?.windows)?.steady)?.scheduleLag);
	return {
		kind: "g6-sharded-floor",
		sessionsRequested: num(root?.sessionsRequested),
		sessionsOk: num(root?.sessionsOk),
		sessionsErr: num(root?.sessionsErr),
		drivingSessions: num(root?.activeWorkloadSessions),
		steadySec: num(rec(root?.config)?.steadySec),
		scheduleLagCount: num(lag?.count),
		scheduleLagMaxNs: num(lag?.maxNs),
	};
}

/* ------------------------------------------------------------------------ */
/* Facts beside the merged reports                                          */
/* ------------------------------------------------------------------------ */

export type ShardCounts = Record<string, number>;

/** Sum `{serverId: n}` maps; null when any part is missing. */
export function sumShardCounts(
	parts: readonly (ShardCounts | null | undefined)[],
): ShardCounts | null {
	const out: ShardCounts = {};
	for (const part of parts) {
		if (part === null || part === undefined) return null;
		for (const [key, value] of Object.entries(part))
			out[key] = (out[key] ?? 0) + value;
	}
	return out;
}

export function compareShardCounts(
	client: ShardCounts | null,
	server: ShardCounts | null,
	shards: number,
) {
	const mismatches: {
		serverId: number;
		client: number | null;
		server: number | null;
	}[] = [];
	for (let id = 1; id <= shards; id += 1) {
		const c = client?.[String(id)] ?? null;
		const s = server?.[String(id)] ?? null;
		if (c === null || s === null || c !== s)
			mismatches.push({ serverId: id, client: c, server: s });
	}
	return { client, server, equal: mismatches.length === 0, mismatches };
}

/**
 * Raid placement (V-P, hotspot): server-reported raid members on shard K are
 * exactly the 40 subscriber tokens and the publisher; no other shard holds any.
 */
export function raidPlacementFacts(
	cfg: ArmsConfig,
	echoes: readonly {
		serverId: number;
		raidTokens: readonly number[];
		publisherSessions: number;
	}[],
) {
	const target = cfg.raidTargetSlot + 1;
	const onTarget = echoes.find((echo) => echo.serverId === target) ?? null;
	const elsewhere = echoes.filter(
		(echo) =>
			echo.serverId !== target &&
			(echo.raidTokens.length > 0 || echo.publisherSessions > 0),
	);
	const expectedTokens = Array.from(
		{ length: ARMS_REGISTERED.raidMembers },
		(_, i) => i + 1,
	);
	const tokens = [...(onTarget?.raidTokens ?? [])].sort((a, b) => a - b);
	return {
		targetSlot: cfg.raidTargetSlot,
		targetServerId: target,
		membersOnTarget: tokens.length,
		publishersOnTarget: onTarget?.publisherSessions ?? 0,
		tokensExact: JSON.stringify(tokens) === JSON.stringify(expectedTokens),
		shardsHoldingOtherRaidParties: elsewhere.map((echo) => ({
			serverId: echo.serverId,
			members: echo.raidTokens.length,
			publishers: echo.publisherSessions,
		})),
		placed:
			tokens.length === ARMS_REGISTERED.raidMembers &&
			JSON.stringify(tokens) === JSON.stringify(expectedTokens) &&
			(onTarget?.publisherSessions ?? 0) === 1 &&
			elsewhere.length === 0,
	};
}

/** max − min of the processes' instants (steady-entry skew, V-T sever skew). */
export function skewMs(instants: readonly (number | null | undefined)[]) {
	const values = instants.filter(
		(value): value is number => typeof value === "number",
	);
	if (values.length === 0 || values.length !== instants.length) return null;
	return Math.max(...values) - Math.min(...values);
}

/** Storm-window steering delta (V-W inputs) from two steer_stats sums. */
export function steeringDelta(
	start: { steered: number; fallback: number } | null,
	end: { steered: number; fallback: number } | null,
) {
	if (start === null || end === null) return null;
	const steered = end.steered - start.steered;
	const fallback = end.fallback - start.fallback;
	return {
		steered,
		fallback,
		fallbackFraction:
			steered + fallback > 0 ? fallback / (steered + fallback) : null,
	};
}

export function histogramMaxNs(h: unknown): number | null {
	const json = rec(h) as Partial<LatencyHistogramJson> | null;
	if (json === null || typeof json.count !== "number" || json.count === 0)
		return null;
	return typeof json.maxNs === "number" ? json.maxNs : null;
}
