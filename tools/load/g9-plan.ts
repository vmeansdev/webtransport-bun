/**
 * G9's scenario and configuration arithmetic, mechanized.
 *
 * Every rate, bound and ceiling in `docs/research/preregistrations/gate-g9-churn.md`
 * §1 is derived here from two kinds of constant — the *scenario* (a
 * connection-UX budget, a base population, an exchange size) and the *shipped
 * configuration* read out of the tree at the base SHA — rather than transcribed
 * as a magic number.
 *
 * The reasons are this effort's, learned the hard way:
 *
 *  * A threshold that exists only as prose in a pre-registration cannot be
 *    checked against the harness that offers it. G2's 15,000/s rung was an
 *    interpolation nobody had measured; G3's bound and its instrument
 *    disagreed. Here the conductor asks this module for its rates and the
 *    classifier asks it for its bounds, so the two cannot drift apart.
 *  * Mechanizing arithmetic is what exposes errors in prose. G6 found a wrong
 *    AoI constant that way, before it dispatched.
 *  * A reader who disputes a bound changes one constant and sees exactly which
 *    numbers move.
 *
 * Nothing here reads a measurement. Its unit tests pin the values the
 * registration states in prose.
 */

/* -------------------------------------------------------------------------- */
/* The shipped configuration — quoted, with its source, never guessed          */
/* -------------------------------------------------------------------------- */

/**
 * `crates/native/src/limits.rs:34` — concurrent handshakes admitted. A 201st is
 * refused outright and increments `limitExceededCount` (`lib.rs:824`).
 */
export const SHIPPED_MAX_HANDSHAKES_IN_FLIGHT = 200;

/** `crates/native/src/limits.rs:33` — the concurrency budget everything shares. */
export const SHIPPED_MAX_SESSIONS = 2000;

/** `crates/native/src/rate_limit.rs:28` — token bucket rate, per (server, peer IP). */
export const SHIPPED_HANDSHAKES_PER_SEC_PER_IP = 20;
/** `crates/native/src/rate_limit.rs:29` — that bucket's burst. */
export const SHIPPED_HANDSHAKES_BURST_PER_IP = 40;
/** `crates/native/src/rate_limit.rs:30` — stream-open bucket, per (server, peer IP). */
export const SHIPPED_STREAMS_PER_SEC_PER_IP = 200;

/** `crates/native/src/limits.rs:47` — a session with no traffic ends here. */
export const SHIPPED_IDLE_TIMEOUT_SEC = 60;

/* -------------------------------------------------------------------------- */
/* Scenario constants — the workload, not the rig                              */
/* -------------------------------------------------------------------------- */

/** Distinct source endpoints the generator offers from (§1.6a). */
export const SOURCE_ENDPOINTS = 64;

/** Long-lived sessions the churn arrives on top of (§1.3). */
export const BASE_SESSIONS = 200;
/** Base upstream cadence per session (§1.3). */
export const BASE_PPS_PER_SESSION = 10;
/** Base payload, stamp included (§1.3). */
export const BASE_PAYLOAD_BYTES = 200;

/** The request/response the short-lived session exists to carry (§1.2). */
export const EXCHANGE_REQUEST_BYTES = 256;
export const EXCHANGE_RESPONSE_BYTES = 1024;

/**
 * Independent cumulative-deadline arrival clocks (§1.7).
 *
 * 32, not the original 8: the same-day floor arm (2026-08-21, gate cadence,
 * spawned over ssh exactly as the run spawns) measured the Mac's schedule-lag
 * p99 at 4.612 ms — the original S=8 selection used K11's 871 µs *mean*, and
 * the prereg itself said the p99 "must be measured on the day". Applying the
 * page's own one-sided selection rule to the measured p99 instead of the
 * mean: S is the smallest power of two whose gate-rung per-shard interval
 * exceeds 10× the p99 — S=32 gives 53.33/4.612 = 11.6 and clears it, S=16
 * gives 26.67/4.612 = 5.8 and does not. Maintainer-ruled pre-dispatch
 * (pass-completion map, 2026-08-22); V-F's bound stays derived, not typed.
 */
export const ARRIVAL_SHARDS = 32;

/**
 * Fraction of `max_sessions` held back from the churn tier so a rung is never
 * measuring the session cap (§1.6c).
 */
export const CONCURRENCY_HEADROOM_FRACTION = 0.2;

/** Windows, in seconds (§1.8). */
export const RAMP_SEC = 30;
export const STEADY_SEC = 120;
export const SETTLE_SEC = 30;
/** `LIM`'s shorter window — it checks a configuration, not a capability (§2.3). */
export const LIMITER_CELL_WINDOW_SEC = 60;

/* -------------------------------------------------------------------------- */
/* §1.4 — the handshake bar, worked out rather than asserted                   */
/* -------------------------------------------------------------------------- */

/** Nielsen's 1.0 s limit: flow of thought still uninterrupted. */
export const INTERACTION_BUDGET_MS = 1000;
/** Typical regional internet path RTT the transport does not control. */
export const INTERNET_RTT_MS = 60;
/** One RAIL response budget. Used twice: client crypto, and server app work. */
export const RAIL_RESPONSE_MS = 100;
/**
 * Round trips a WebTransport request/response session cannot avoid: the
 * QUIC/TLS 1.3 handshake, the WebTransport CONNECT exchange, and the
 * request/response itself.
 */
export const UNAVOIDABLE_ROUND_TRIPS = 3;
/**
 * A p99 bar derived from a typical-case budget needs a tail margin for the part
 * of the distribution the derivation does not describe. Ticket 26 established
 * the form and the factor.
 */
export const TAIL_MARGIN_DIVISOR = 2;
/**
 * `packages/webtransport/src/index.ts:901` documents a p99 target of 300 ms for
 * the shipped (partial-span) handshake histogram. Authored before this effort;
 * used as an independent convergence check in §1.4, never as the derivation.
 */
export const SHIPPED_DOCUMENTED_HANDSHAKE_TARGET_MS = 300;

/**
 * The transport's undivided share of session setup. Reported as a diagnostic on
 * every rung; **not** a bar (§1.4).
 */
export function undividedSetupBudgetMs(): number {
	return (
		INTERACTION_BUDGET_MS -
		UNAVOIDABLE_ROUND_TRIPS * INTERNET_RTT_MS -
		RAIL_RESPONSE_MS -
		RAIL_RESPONSE_MS
	);
}

/** The undivided budget with its tail margin, floored to a whole 10 ms. */
export function derivedHandshakeBarMs(): number {
	return Math.floor(undividedSetupBudgetMs() / TAIL_MARGIN_DIVISOR / 10) * 10;
}

/**
 * C3's registered bar: the tighter of the derivation and the shipped documented
 * target, so the gate is never more lenient than either source (§1.4).
 */
export function handshakeBarMs(): number {
	return Math.min(
		derivedHandshakeBarMs(),
		SHIPPED_DOCUMENTED_HANDSHAKE_TARGET_MS,
	);
}

/* -------------------------------------------------------------------------- */
/* §1.5 — the base bar                                                         */
/* -------------------------------------------------------------------------- */

/** C4's bar: a user-visible update budget, less the path the transport does not own. */
export function baseRttBarMs(): number {
	return Math.floor((RAIL_RESPONSE_MS - INTERNET_RTT_MS) / 10) * 10;
}

/* -------------------------------------------------------------------------- */
/* §1.6 — the three configuration ceilings, and the ladder they produce        */
/* -------------------------------------------------------------------------- */

/**
 * (a) The per-source token bucket, aggregated over the endpoint pool. Sustained,
 * so the burst term does not appear.
 */
export function tokenBucketCeilingPerSec(
	endpoints: number = SOURCE_ENDPOINTS,
): number {
	return endpoints * SHIPPED_HANDSHAKES_PER_SEC_PER_IP;
}

/**
 * (b) The admission gate at the registered bar. Little's law at the gate — and
 * here it is the *server's* mechanism rather than a generator artifact, which is
 * the distinction the V-L falsifier makes operational.
 */
export function admissionCeilingPerSec(
	barMs: number = handshakeBarMs(),
): number {
	return SHIPPED_MAX_HANDSHAKES_IN_FLIGHT / (barMs / 1000);
}

/** (c) Concurrent sessions the churn tier may hold (§1.6c). */
export function churnConcurrencyBudget(
	base: number = BASE_SESSIONS,
	maxSessions: number = SHIPPED_MAX_SESSIONS,
): number {
	return Math.floor(
		maxSessions - base - maxSessions * CONCURRENCY_HEADROOM_FRACTION,
	);
}

/**
 * The gate rung: the binding ceiling of (a) and (b), rounded **down** to a whole
 * 100 so the registered offer is never richer than its derivation.
 */
export function gateRungPerSec(): number {
	return (
		Math.floor(
			Math.min(tokenBucketCeilingPerSec(), admissionCeilingPerSec()) / 100,
		) * 100
	);
}

/** The registered ladder: the gate rung, halved down three times (§1.6). */
export function ladder(): number[] {
	const gate = gateRungPerSec();
	return [gate / 8, gate / 4, gate / 2, gate];
}

/**
 * The cycle-lifetime ceiling at a rung. Above it the arm is measuring
 * `max_sessions` rather than churn, and V-M fires (§1.6c, §7).
 */
export function cycleLifetimeCeilingSec(ratePerSec: number): number {
	return churnConcurrencyBudget() / ratePerSec;
}

/**
 * The generator's safety abort, in in-flight cycles. Four times the concurrency
 * budget — it never delays an arrival, it ends the rung (§3.1).
 */
export function generatorAbortCeiling(): number {
	return 4 * churnConcurrencyBudget();
}

/**
 * P3's threshold: the full-span latency at which `handshakesInFlight` reaches
 * the shipped admission gate at a given rate.
 */
export function admissionSaturationLatencyMs(ratePerSec: number): number {
	return (SHIPPED_MAX_HANDSHAKES_IN_FLIGHT / ratePerSec) * 1000;
}

/* -------------------------------------------------------------------------- */
/* §1.7 — arrival shards                                                       */
/* -------------------------------------------------------------------------- */

/** Interval one shard owes between its own arrivals, at a rung. */
export function shardIntervalMs(
	ratePerSec: number,
	shards: number = ARRIVAL_SHARDS,
): number {
	return 1000 / (ratePerSec / shards);
}

/**
 * V-F's bound: the generator's schedule-lag p99 must be an order of magnitude
 * under one shard interval at the gate rung. Derived, not typed in.
 */
export function scheduleLagBoundMs(): number {
	return shardIntervalMs(gateRungPerSec()) / 10;
}

/**
 * The residual a cumulative-deadline clock leaves over a step: one shard
 * interval, as a fraction of the graded window (§3 property 2).
 */
export function pacerResidualFraction(
	ratePerSec: number = gateRungPerSec(),
	steadySec: number = STEADY_SEC,
): number {
	return shardIntervalMs(ratePerSec) / 1000 / steadySec;
}

/* -------------------------------------------------------------------------- */
/* §2 — the cells                                                              */
/* -------------------------------------------------------------------------- */

export type CellRole = "ladder" | "gate" | "disclosure" | "config-fidelity";

export type Cell = {
	id: string;
	churnRatePerSec: number;
	baseSessions: number;
	/** 1 means the generator offers everything from a single source IP. */
	sourceEndpoints: number;
	windowSec: number;
	repeats: number;
	role: CellRole;
};

export function cells(): Cell[] {
	const rungs = ladder();
	const gate = gateRungPerSec();
	const out: Cell[] = rungs.map((r) => ({
		id: `L-${r}`,
		churnRatePerSec: r,
		baseSessions: BASE_SESSIONS,
		sourceEndpoints: SOURCE_ENDPOINTS,
		windowSec: STEADY_SEC,
		repeats: r === gate ? 2 : 1,
		role: r === gate ? "gate" : "ladder",
	}));
	out.push({
		id: "B-only",
		churnRatePerSec: 0,
		baseSessions: BASE_SESSIONS,
		sourceEndpoints: SOURCE_ENDPOINTS,
		windowSec: STEADY_SEC,
		repeats: 1,
		role: "disclosure",
	});
	out.push({
		id: "C-only",
		churnRatePerSec: gate,
		baseSessions: 0,
		sourceEndpoints: SOURCE_ENDPOINTS,
		windowSec: STEADY_SEC,
		repeats: 1,
		role: "disclosure",
	});
	out.push({
		id: "LIM",
		churnRatePerSec: gate,
		baseSessions: 0,
		sourceEndpoints: 1,
		windowSec: LIMITER_CELL_WINDOW_SEC,
		repeats: 1,
		role: "config-fidelity",
	});
	return out;
}

/**
 * The gate cell's id, derived rather than typed, so it can never name a cell the
 * ladder does not contain. A unit test pins it to the string the registration
 * prints.
 */
export function gateCellId(): string {
	return `L-${gateRungPerSec()}`;
}

/**
 * §2.3's arithmetic: what the shipped token bucket admits over `LIM`'s window
 * when a single source IP offers far more than it. Burst first, then rate.
 */
export function limiterExpectedAdmits(
	windowSec: number = LIMITER_CELL_WINDOW_SEC,
): number {
	return (
		SHIPPED_HANDSHAKES_BURST_PER_IP +
		SHIPPED_HANDSHAKES_PER_SEC_PER_IP * windowSec
	);
}

/** `LIM`'s registered ±5% band. */
export const LIMITER_BAND = 0.05;

/* -------------------------------------------------------------------------- */
/* Aggregate shape, for the artifact and for the reader                        */
/* -------------------------------------------------------------------------- */

/** Base aggregate datagrams/s in one direction (§1.3). */
export function baseAggregatePps(base: number = BASE_SESSIONS): number {
	return base * BASE_PPS_PER_SESSION;
}

/** Bytes/s the exchange contributes at a rung, both directions (§1.2). */
export function exchangeBytesPerSec(ratePerSec: number): number {
	return ratePerSec * (EXCHANGE_REQUEST_BYTES + EXCHANGE_RESPONSE_BYTES);
}

/** Stream opens per second per source IP at a rung — checked against K23. */
export function streamOpensPerSecPerIp(
	ratePerSec: number,
	endpoints: number = SOURCE_ENDPOINTS,
): number {
	return ratePerSec / endpoints;
}

/** Sessions/day the gate rung represents, for the licensing sentence (§1.6). */
export function sessionsPerDay(ratePerSec: number): number {
	return ratePerSec * 86_400;
}
