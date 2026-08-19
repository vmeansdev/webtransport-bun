/**
 * G9's clauses and falsifiers, as pure functions over facts.
 *
 * Nothing here reads a file, spawns a process or knows what a run is. The
 * conductor collects facts; this module decides. The separation is ticket 26's
 * lesson taken literally — G3b's classifier carried no field for the check that
 * ended up invalidating the run, and nobody could see that until it was too
 * late, because the classifier was only ever exercised by running the gate.
 *
 * Every function here is unit-tested **against the signature it exists to
 * reject**, not merely against a happy path:
 *
 *  * the retracted accept rate (`acceptsPerSec x meanConnectSec ~ pool`) — V-L;
 *  * a completion-driven arrival loop wearing a rate label — V-P;
 *  * a server-side partial span reported as larger than the full span it sits
 *    inside — V-C;
 *  * a cycle counted complete with no server-side stream accept — V-S;
 *  * a kernel tap that never read, booked as a zero — V-K;
 *  * an arm that was really measuring `max_sessions` — V-M;
 *  * and `rollUp` stamping INVALID over a set of clauses that all computed PASS.
 */

import {
	baseRttBarMs,
	cycleLifetimeCeilingSec,
	generatorAbortCeiling,
	handshakeBarMs,
	LIMITER_BAND,
	limiterExpectedAdmits,
	SHIPPED_MAX_HANDSHAKES_IN_FLIGHT,
	SHIPPED_MAX_SESSIONS,
	undividedSetupBudgetMs,
} from "./g9-plan.ts";

export type Verdict = "PASS" | "MISS" | "INCOMPLETE";

export type ClauseResult = {
	id: string;
	verdict: Verdict;
	reasons: string[];
	observed: Record<string, unknown>;
	/** Set by clauses that carry a legible secondary reading (see C3). */
	flags?: Record<string, boolean>;
};

/** C2's under-offer tolerance: the pacer's residual, rounded against the gate. */
export const ACCEPT_RATE_BAND = 0.99;
/** C4's delivery floor for the base cohort. */
export const BASE_DELIVERY_FLOOR = 0.995;
/** V-L's Little's-law band, both readings. */
export const LITTLE_BAND = 0.1;
/** V-P's two-sided band on the arrival count. */
export const PACER_BAND_LOW = 0.98;
export const PACER_BAND_HIGH = 1.02;
/** V-G's generator-saturation bar, as a percent of the generator's own cores. */
export const GENERATOR_CPU_BAR_PCT = 90;
/** C1's host-saturation bar, percent-of-one-core on a 4 vCPU box. */
export const HOST_CPU_BAR_PCT = 90;
/** C5 part 5: drift under one session extrapolated across the graded window. */
export const REGISTRY_DRIFT_SESSIONS = 1.0;
/**
 * C5's bound on `nativeRateLimitEntries`: 64 endpoints across five maps, plus
 * the base's own, plus a 1.6x margin. Bounded and **not zero** — P4 says why.
 */
export const RATE_LIMIT_ENTRY_BOUND = 512;

function pass(
	id: string,
	observed: Record<string, unknown>,
	reasons: string[],
	incomplete = false,
	flags?: Record<string, boolean>,
): ClauseResult {
	const verdict: Verdict = incomplete
		? "INCOMPLETE"
		: reasons.length > 0
			? "MISS"
			: "PASS";
	return flags
		? { id, verdict, reasons, observed, flags }
		: { id, verdict, reasons, observed };
}

/* -------------------------------------------------------------------------- */
/* Histogram validity — shared by every latency clause                        */
/* -------------------------------------------------------------------------- */

export type HistogramFacts = {
	count: number;
	p50Ns: number | null;
	p99Ns: number | null;
	maxNs: number | null;
	/** Samples whose computed span was negative. One is enough to distrust all. */
	negativeSamples: number;
};

/**
 * A percentile is only a percentile if enough samples sit above it. 100 is the
 * floor at which a p99 rests on more than a single observation.
 */
export const MIN_SAMPLES_FOR_P99 = 100;

export function histogramValidity(h: HistogramFacts): {
	usable: boolean;
	reasons: string[];
} {
	const reasons: string[] = [];
	if (h.count < MIN_SAMPLES_FOR_P99) {
		reasons.push(
			`histogram holds ${h.count} samples, under the ${MIN_SAMPLES_FOR_P99} a p99 needs`,
		);
	}
	if (h.negativeSamples > 0) {
		reasons.push(
			`${h.negativeSamples} negative sample(s) — the two stamps are not on one clock`,
		);
	}
	if (h.p99Ns === null) reasons.push("no p99");
	return { usable: reasons.length === 0, reasons };
}

/* -------------------------------------------------------------------------- */
/* C1 — completeness                                                          */
/* -------------------------------------------------------------------------- */

export type CompletenessFacts = {
	cellId: string;
	repeatsPresent: number;
	repeatsRequired: number;
	exitCodes: number[];
	hostCpuPctMedian: number | null;
	/** Ids of every falsifier that put this cell in an INCOMPLETE bucket. */
	incompleteBuckets: string[];
};

export function clauseC1(f: CompletenessFacts): ClauseResult {
	const reasons: string[] = [];
	let incomplete = false;
	if (f.repeatsPresent < f.repeatsRequired) {
		reasons.push(
			`C1: ${f.repeatsPresent} of ${f.repeatsRequired} repeats present`,
		);
		incomplete = true;
	}
	for (const [i, code] of f.exitCodes.entries()) {
		if (code !== 0) {
			reasons.push(`C1: repeat ${i + 1} exited ${code}`);
			incomplete = true;
		}
	}
	if (f.hostCpuPctMedian === null) {
		reasons.push("C1: host CPU unreadable — cannot rule out saturation");
		incomplete = true;
	} else if (f.hostCpuPctMedian >= HOST_CPU_BAR_PCT * 4) {
		// percent-of-one-core on a 4 vCPU box: the bar is 90% of 400.
		reasons.push(
			`C1: host CPU median ${f.hostCpuPctMedian.toFixed(1)} >= ${HOST_CPU_BAR_PCT}% of 400 — saturated, so NO-VERDICT rather than a miss`,
		);
		incomplete = true;
	}
	if (f.incompleteBuckets.length > 0) {
		reasons.push(`C1: incomplete buckets ${f.incompleteBuckets.join(", ")}`);
		incomplete = true;
	}
	return pass("C1", { ...f }, reasons, incomplete);
}

/* -------------------------------------------------------------------------- */
/* C2 — sustained accept rate, read at the server and nowhere else            */
/* -------------------------------------------------------------------------- */

export type AcceptFacts = {
	offeredRatePerSec: number;
	steadySec: number;
	/**
	 * `onSession` completions the **server** timestamped inside the graded
	 * window. The client's arrival pacing never enters this clause (K1).
	 */
	serverAcceptsInSteadyWindow: number;
	limitExceededDelta: number;
	rateLimitedDelta: number;
};

export function clauseC2(f: AcceptFacts): ClauseResult {
	const reasons: string[] = [];
	const achieved =
		f.steadySec > 0 ? f.serverAcceptsInSteadyWindow / f.steadySec : null;
	const bar = ACCEPT_RATE_BAND * f.offeredRatePerSec;
	if (achieved === null) {
		reasons.push("C2: no graded window");
	} else if (achieved < bar) {
		reasons.push(
			`C2: server accepted ${achieved.toFixed(2)}/s against an offer of ${f.offeredRatePerSec}/s (bar ${bar.toFixed(2)})`,
		);
	}
	// A limiter engaging below its derived boundary is a finding about the
	// product, so this is a MISS and deliberately not an INCOMPLETE.
	if (f.limitExceededDelta !== 0) {
		reasons.push(
			`C2: limitExceeded rose by ${f.limitExceededDelta} — the admission gate refused, which the derivation says it should not have at this rate`,
		);
	}
	if (f.rateLimitedDelta !== 0) {
		reasons.push(
			`C2: rateLimited rose by ${f.rateLimitedDelta} — a token bucket engaged at 47% of its aggregate ceiling`,
		);
	}
	return pass(
		"C2",
		{
			achievedPerSec: achieved,
			offeredPerSec: f.offeredRatePerSec,
			barPerSec: bar,
			limitExceededDelta: f.limitExceededDelta,
			rateLimitedDelta: f.rateLimitedDelta,
		},
		reasons,
		achieved === null,
	);
}

/* -------------------------------------------------------------------------- */
/* C3 — handshake tail, full span, client clock                               */
/* -------------------------------------------------------------------------- */

export type HandshakeFacts = {
	/** Arrival handoff -> session usable. Stamped before any await (K16). */
	connect: HistogramFacts;
	/** The shipped partial-span histogram. Decomposition only — carries no bar. */
	serverPartialSpanP99Ns: number | null;
	/** The generator's own lag. Published beside, never subtracted (G1's rule). */
	arrivalLagP99Ns: number | null;
};

export function clauseC3(f: HandshakeFacts): ClauseResult {
	const reasons: string[] = [];
	const validity = histogramValidity(f.connect);
	if (!validity.usable) {
		return {
			id: "C3",
			verdict: "INCOMPLETE",
			reasons: validity.reasons.map((r) => `C3: ${r}`),
			observed: { count: f.connect.count },
		};
	}
	const p99Ms = (f.connect.p99Ns as number) / 1e6;
	const bar = handshakeBarMs();
	if (p99Ms > bar) {
		reasons.push(`C3: connect p99 ${p99Ms.toFixed(3)} ms > ${bar} ms`);
	}
	const undivided = undividedSetupBudgetMs();
	const serverMs =
		f.serverPartialSpanP99Ns === null ? null : f.serverPartialSpanP99Ns / 1e6;
	return pass(
		"C3",
		{
			connectP99Ms: p99Ms,
			barMs: bar,
			undividedBudgetMs: undivided,
			serverPartialSpanP99Ms: serverMs,
			// The recorded cert/TLS lever: what the full span holds that the
			// server's partial span does not. Recorded, never pulled.
			handshakeShareOutsideServerSpanMs:
				serverMs === null ? null : p99Ms - serverMs,
			arrivalLagP99Ms:
				f.arrivalLagP99Ns === null ? null : f.arrivalLagP99Ns / 1e6,
		},
		reasons,
		false,
		{ undividedBudgetWouldPass: p99Ms > bar && p99Ms <= undivided },
	);
}

/* -------------------------------------------------------------------------- */
/* C4 — the base does not pay for the churn                                   */
/* -------------------------------------------------------------------------- */

export type BaseHealthFacts = {
	/** Sessions established before the churn tier's first arrival. Server-side. */
	baseSessions: number;
	rtt: HistogramFacts;
	clientEnqueued: number;
	serverRx: number;
	sessionsLost: number;
};

export function clauseC4(f: BaseHealthFacts | null): ClauseResult {
	if (f === null || f.baseSessions === 0) {
		// `C-only` and `LIM` carry no base. Out of scope by construction — not a
		// pass and not a miss, exactly as G6 treats a whole-realm sever.
		return {
			id: "C4",
			verdict: "INCOMPLETE",
			reasons: ["C4 does not apply: this cell carries no base tier"],
			observed: { baseSessions: f?.baseSessions ?? 0 },
		};
	}
	const validity = histogramValidity(f.rtt);
	const reasons: string[] = [];
	let incomplete = false;
	if (!validity.usable) {
		reasons.push(...validity.reasons.map((r) => `C4: ${r}`));
		incomplete = true;
	} else {
		const p99Ms = (f.rtt.p99Ns as number) / 1e6;
		const bar = baseRttBarMs();
		if (p99Ms > bar) {
			reasons.push(`C4: base RTT p99 ${p99Ms.toFixed(3)} ms > ${bar} ms`);
		}
	}
	if (f.clientEnqueued <= 0) {
		reasons.push("C4: the base offered nothing");
		incomplete = true;
	} else {
		const delivery = f.serverRx / f.clientEnqueued;
		if (delivery < BASE_DELIVERY_FLOOR) {
			reasons.push(
				`C4: base delivery ${delivery.toFixed(5)} < ${BASE_DELIVERY_FLOOR}`,
			);
		}
	}
	if (f.sessionsLost !== 0) {
		reasons.push(`C4: ${f.sessionsLost} base session(s) lost`);
	}
	return pass(
		"C4",
		{
			baseSessions: f.baseSessions,
			p99Ms: f.rtt.p99Ns === null ? null : f.rtt.p99Ns / 1e6,
			barMs: baseRttBarMs(),
			delivery: f.clientEnqueued > 0 ? f.serverRx / f.clientEnqueued : null,
			sessionsLost: f.sessionsLost,
		},
		reasons,
		incomplete,
	);
}

/* -------------------------------------------------------------------------- */
/* C5 — zero leaked sessions and handles                                      */
/* -------------------------------------------------------------------------- */

export type LeakFacts = {
	/** Every `onSession` completion this server saw, whole run. */
	acceptsTotal: number;
	/** Measured at the end of the quiet settle window. */
	sessionsActiveAtSettleEnd: number;
	closedByIdle: number;
	closedByReap: number;
	closedOther: number;
	/** `sessionsClosedByIdle` accrued over the churn window alone. */
	closedByIdleDuringChurn: number;
	nativeAsyncOpsPending: number | null;
	nativeBidiHandlesLive: number | null;
	nativeUniSendHandlesLive: number | null;
	nativeUniRecvHandlesLive: number | null;
	nativeSessionRegistryEntries: number | null;
	nativeRateLimitEntries: number | null;
	baseSessions: number;
	/**
	 * Least-squares slope of the registry series over the graded window, in
	 * sessions per second.
	 */
	registrySlopePerSec: number | null;
	steadySec: number;
};

function requireCounter(
	reasons: string[],
	label: string,
	value: number | null,
	expected: number,
): boolean {
	if (value === null) {
		// A counter that could not be read is never booked as its expected value.
		reasons.push(`C5: ${label} unreadable — not booked as ${expected}`);
		return false;
	}
	if (value !== expected)
		reasons.push(`C5: ${label} is ${value}, expected ${expected}`);
	return true;
}

export function clauseC5(f: LeakFacts): ClauseResult {
	const reasons: string[] = [];
	let readable = true;

	// 1. The ledger closes, exactly.
	const accountedFor = f.closedByIdle + f.closedByReap + f.closedOther;
	const shouldBeClosed = f.acceptsTotal - f.sessionsActiveAtSettleEnd;
	if (accountedFor !== shouldBeClosed) {
		reasons.push(
			`C5: ledger does not close — ${f.acceptsTotal} accepted - ${f.sessionsActiveAtSettleEnd} still active = ${shouldBeClosed}, but only ${accountedFor} accounted for (idle ${f.closedByIdle} + reap ${f.closedByReap} + other ${f.closedOther})`,
		);
	}

	// 2, 3, 4.
	readable =
		requireCounter(
			reasons,
			"nativeAsyncOpsPending",
			f.nativeAsyncOpsPending,
			0,
		) && readable;
	readable =
		requireCounter(
			reasons,
			"nativeBidiHandlesLive",
			f.nativeBidiHandlesLive,
			0,
		) && readable;
	readable =
		requireCounter(
			reasons,
			"nativeUniSendHandlesLive",
			f.nativeUniSendHandlesLive,
			0,
		) && readable;
	readable =
		requireCounter(
			reasons,
			"nativeUniRecvHandlesLive",
			f.nativeUniRecvHandlesLive,
			0,
		) && readable;
	readable =
		requireCounter(
			reasons,
			"nativeSessionRegistryEntries",
			f.nativeSessionRegistryEntries,
			f.baseSessions,
		) && readable;
	if (f.sessionsActiveAtSettleEnd !== f.baseSessions) {
		reasons.push(
			`C5: ${f.sessionsActiveAtSettleEnd} sessions active after settle, expected the ${f.baseSessions} base sessions`,
		);
	}

	// A churn session that reached the idle timeout was abandoned, not closed.
	if (f.closedByIdleDuringChurn !== 0) {
		reasons.push(
			`C5: ${f.closedByIdleDuringChurn} churn session(s) ended on the 60 s idle timeout — abandoned, not closed`,
		);
	}

	// The rate-limiter maps are bounded, not zeroed. P4 registered why.
	if (f.nativeRateLimitEntries === null) {
		reasons.push("C5: nativeRateLimitEntries unreadable — not booked as 0");
		readable = false;
	} else if (f.nativeRateLimitEntries > RATE_LIMIT_ENTRY_BOUND) {
		reasons.push(
			`C5: nativeRateLimitEntries ${f.nativeRateLimitEntries} > ${RATE_LIMIT_ENTRY_BOUND}`,
		);
	}

	// 5. No drift while the arm ran.
	if (f.registrySlopePerSec === null) {
		reasons.push("C5: registry series absent — drift not evaluated");
		readable = false;
	} else {
		const drift = Math.max(0, f.registrySlopePerSec) * f.steadySec;
		if (drift >= REGISTRY_DRIFT_SESSIONS) {
			reasons.push(
				`C5: registry drifted ${drift.toFixed(3)} sessions across the graded window`,
			);
		}
	}

	return pass(
		"C5",
		{
			ledgerAccountedFor: accountedFor,
			ledgerShouldBeClosed: shouldBeClosed,
			asyncOpsPending: f.nativeAsyncOpsPending,
			registryEntries: f.nativeSessionRegistryEntries,
			rateLimitEntries: f.nativeRateLimitEntries,
			rateLimitEntryBound: RATE_LIMIT_ENTRY_BOUND,
			registryDriftSessions:
				f.registrySlopePerSec === null
					? null
					: Math.max(0, f.registrySlopePerSec) * f.steadySec,
		},
		reasons,
		!readable,
	);
}

/* -------------------------------------------------------------------------- */
/* C6 — teardown health                                                       */
/* -------------------------------------------------------------------------- */

export type TeardownFacts = {
	cyclesCompleted: number;
	clientCloseErrors: number;
	serverStreamErrors: number;
	serverStreamsAccepted: number;
	serverStreamsCompleted: number;
};

export function clauseC6(f: TeardownFacts): ClauseResult {
	const reasons: string[] = [];
	if (f.clientCloseErrors !== 0) {
		reasons.push(`C6: ${f.clientCloseErrors} client close error(s)`);
	}
	if (f.serverStreamErrors !== 0) {
		reasons.push(`C6: ${f.serverStreamErrors} server stream error(s)`);
	}
	if (f.serverStreamsAccepted !== f.cyclesCompleted) {
		reasons.push(
			`C6: ${f.serverStreamsAccepted} streams accepted against ${f.cyclesCompleted} completed cycles`,
		);
	}
	if (f.serverStreamsCompleted !== f.cyclesCompleted) {
		reasons.push(
			`C6: ${f.serverStreamsCompleted} streams completed against ${f.cyclesCompleted} completed cycles`,
		);
	}
	return pass("C6", { ...f }, reasons);
}

export function gateClauses(input: {
	completeness: CompletenessFacts;
	accept: AcceptFacts;
	handshake: HandshakeFacts;
	base: BaseHealthFacts | null;
	leak: LeakFacts;
	teardown: TeardownFacts;
}): ClauseResult[] {
	return [
		clauseC1(input.completeness),
		clauseC2(input.accept),
		clauseC3(input.handshake),
		clauseC4(input.base),
		clauseC5(input.leak),
		clauseC6(input.teardown),
	];
}

/* -------------------------------------------------------------------------- */
/* §2.3 — LIM, a configuration-fidelity statement and nothing else            */
/* -------------------------------------------------------------------------- */

export type LimiterFacts = {
	windowSec: number;
	serverAcceptsInWindow: number;
	rateLimitedDelta: number;
	limitExceededDelta: number;
};

export function clauseLimiter(f: LimiterFacts): ClauseResult {
	const expected = limiterExpectedAdmits(f.windowSec);
	const low = expected * (1 - LIMITER_BAND);
	const high = expected * (1 + LIMITER_BAND);
	const reasons: string[] = [];
	if (f.serverAcceptsInWindow < low || f.serverAcceptsInWindow > high) {
		reasons.push(
			`LIM: ${f.serverAcceptsInWindow} admitted, outside the configured bucket's [${low}, ${high}]`,
		);
	}
	if (f.rateLimitedDelta <= 0) {
		reasons.push(
			"LIM: rateLimited never rose — the token bucket did not engage, so nothing was measured",
		);
	}
	if (f.limitExceededDelta !== 0) {
		// The concurrency cap firing means a different mechanism answered than
		// the one this cell was built to check.
		return {
			id: "LIM",
			verdict: "INCOMPLETE",
			reasons: [
				`LIM: limitExceeded rose by ${f.limitExceededDelta} — the concurrency cap answered, not the token bucket`,
			],
			observed: { ...f, expected },
		};
	}
	return pass("LIM", { ...f, expected, band: [low, high] }, reasons);
}

/* -------------------------------------------------------------------------- */
/* §7 falsifiers                                                              */
/* -------------------------------------------------------------------------- */

export type FalsifierResult = {
	id: string;
	fired: boolean;
	reasons: string[];
	observed: Record<string, unknown>;
	/**
	 * `run` voids the whole dispatch. `cell` puts one cell in an INCOMPLETE
	 * bucket. `characterization` strips verdict force without voiding anything.
	 * `finding` fires without penalty — it is a result, not a fault.
	 */
	scope: "run" | "cell" | "characterization" | "finding";
};

/**
 * V-P. The arrival clock must be a cumulative-deadline clock (§3).
 *
 * The load-bearing reading is the first one: **the arrival count must be
 * explainable by the wall clock alone.** That is a complete test, and it is
 * worth saying why, because the obvious second rule is wrong and this module
 * shipped it briefly before a unit test caught it.
 *
 * Under a permit pool of size P with mean cycle L, throughput is `P / L` and
 * in-flight is pinned at P. Under clock pacing at R, throughput is R whatever L
 * does. So a pool that *binds* necessarily misses the clock band, and a pool
 * that does not bind is not an artifact — there is nothing else to detect.
 *
 * "Arrivals track completions" is **not** a pool signature: at steady state an
 * honest run has arrivals ≈ completions too, because that is what steady state
 * means. That rule would have fired on every healthy gate cell.
 *
 * The two remaining readings therefore do not stand alone. `poolBound` is a
 * *mechanism annotation* on a shortfall the clock band already caught — it says
 * which mechanism took the arm — and the serialization reading catches the
 * degenerate case plus any accounting bug where `arrivalsIssued` was computed
 * rather than counted.
 */
export function falsifierPacing(input: {
	arrivalsIssued: number;
	offeredRatePerSec: number;
	steadySec: number;
	cyclesCompleted: number;
	meanCycleSec: number | null;
	inFlightHighWater: number;
}): FalsifierResult {
	const reasons: string[] = [];
	const due = input.offeredRatePerSec * input.steadySec;
	if (due > 0) {
		const ratio = input.arrivalsIssued / due;
		if (ratio < PACER_BAND_LOW) {
			reasons.push(
				`V-P: ${input.arrivalsIssued} arrivals against ${due} due (${(ratio * 100).toFixed(2)}%) — the clock was blocked, so the rate label is a completion rate`,
			);
		}
		if (ratio > PACER_BAND_HIGH) {
			reasons.push(
				`V-P: ${input.arrivalsIssued} arrivals against ${due} due (${(ratio * 100).toFixed(2)}%) — a cumulative-deadline clock cannot run ahead, so this was not one`,
			);
		}
	}
	// The expected steady concurrency. Below one there is nothing for either
	// remaining reading to distinguish, and they stand down rather than guess.
	const expectedInFlight =
		input.meanCycleSec === null
			? null
			: input.meanCycleSec * input.offeredRatePerSec;

	// Mechanism annotation on a shortfall: was the arm pool-bound? Little's law
	// on the *generator's* in-flight population — if the achieved rate is better
	// explained by `inFlight / cycle` than by the clock, something capped
	// concurrency. It only speaks when the clock band already fired, because on
	// a healthy arm the two explanations coincide and it would say nothing.
	const achievedPerSec =
		input.steadySec > 0 ? input.arrivalsIssued / input.steadySec : null;
	let poolBound = false;
	if (
		reasons.length > 0 &&
		achievedPerSec !== null &&
		achievedPerSec > 0 &&
		input.meanCycleSec !== null &&
		input.meanCycleSec > 0 &&
		input.inFlightHighWater > 1
	) {
		const littleRate = input.inFlightHighWater / input.meanCycleSec;
		const explainedByPool =
			Math.abs(achievedPerSec - littleRate) / achievedPerSec < 0.05;
		const explainedByClock =
			Math.abs(achievedPerSec - input.offeredRatePerSec) /
				input.offeredRatePerSec <
			0.05;
		if (explainedByPool && !explainedByClock) {
			poolBound = true;
			reasons.push(
				`V-P: the achieved ${achievedPerSec.toFixed(1)}/s equals inFlight/cycle (${input.inFlightHighWater}/${input.meanCycleSec.toFixed(3)} = ${littleRate.toFixed(1)}/s) and not the ${input.offeredRatePerSec}/s clock — concurrency was capped somewhere, which is the permit-pool mechanism`,
			);
		}
	}

	// The degenerate case, and the guard against an `arrivalsIssued` that was
	// computed from the schedule rather than counted at the handoff.
	if (
		expectedInFlight !== null &&
		expectedInFlight > 1 &&
		input.inFlightHighWater <= 1
	) {
		reasons.push(
			`V-P: in-flight high water ${input.inFlightHighWater} while ${expectedInFlight.toFixed(1)} was expected — arrivals were serialized on completion`,
		);
	}

	return {
		id: "V-P",
		fired: reasons.length > 0,
		reasons,
		observed: { due, expectedInFlight, achievedPerSec, poolBound, ...input },
		scope: "run",
	};
}

/**
 * V-L, generator reading. This is K1's exact shape: `acceptRate x mean accept
 * latency ~ pool` at every rung was Little's law on the generator's own connect
 * semaphore. G9 runs with no pool at all, so `connectConcurrency === null` is
 * the registered configuration and cannot fire this — but "it cannot happen
 * here" is what the retraction thought too.
 */
export function falsifierLittleGenerator(input: {
	acceptRatePerSec: number | null;
	clientMeanConnectSec: number | null;
	connectConcurrency: number | null;
}): FalsifierResult {
	const reasons: string[] = [];
	const { acceptRatePerSec, clientMeanConnectSec, connectConcurrency } = input;
	let product: number | null = null;
	if (
		connectConcurrency !== null &&
		acceptRatePerSec !== null &&
		clientMeanConnectSec !== null
	) {
		product = acceptRatePerSec * clientMeanConnectSec;
		if (
			product >= (1 - LITTLE_BAND) * connectConcurrency &&
			product <= (1 + LITTLE_BAND) * connectConcurrency
		) {
			reasons.push(
				`V-L: acceptRate x meanConnect = ${product.toFixed(1)} sits within +/-${LITTLE_BAND * 100}% of the ${connectConcurrency}-permit pool — this is the generator measuring itself, not a server rate`,
			);
		}
	}
	return {
		id: "V-L-generator",
		fired: reasons.length > 0,
		reasons,
		observed: { product, ...input },
		scope: "characterization",
	};
}

/**
 * V-L, server reading — **the same arithmetic landing on a different
 * population, and it is a finding rather than a fault.** If
 * `acceptRate x serverHandshakeSpan` sits at `max_handshakes_in_flight`, the
 * shipped admission gate is what bounds the rate, which is exactly what §1.6b
 * derived before the run. The two readings are distinguished by *which*
 * population the product lands on, and the classifier reports both so a reader
 * cannot mistake one for the other.
 */
export function falsifierLittleServer(input: {
	acceptRatePerSec: number | null;
	serverMeanHandshakeSpanSec: number | null;
}): FalsifierResult {
	const reasons: string[] = [];
	let product: number | null = null;
	if (
		input.acceptRatePerSec !== null &&
		input.serverMeanHandshakeSpanSec !== null
	) {
		product = input.acceptRatePerSec * input.serverMeanHandshakeSpanSec;
		const gate = SHIPPED_MAX_HANDSHAKES_IN_FLIGHT;
		if (
			product >= (1 - LITTLE_BAND) * gate &&
			product <= (1 + LITTLE_BAND) * gate
		) {
			reasons.push(
				`admissionGateBinding: acceptRate x serverHandshakeSpan = ${product.toFixed(1)} sits at the shipped ${gate}-handshake admission gate — the server's own mechanism, as derived, not a generator artifact`,
			);
		}
	}
	return {
		id: "V-L-server",
		fired: reasons.length > 0,
		reasons,
		observed: { product, admissionGate: SHIPPED_MAX_HANDSHAKES_IN_FLIGHT },
		scope: "finding",
	};
}

/**
 * V-F. The generator's own floor, measured on the actual generator host, on the
 * day. A precondition and not a footnote: K11 saw a 40.6 ms schedule-lag maximum
 * on an idle Mac, and the clause it would contaminate is a 300 ms p99.
 */
export function falsifierFloor(input: {
	scheduleLagP99Ms: number | null;
	scheduleLagMaxMs: number | null;
	boundMs: number;
	floorArmDateIso: string | null;
	runDateIso: string;
	generatorHostMatches: boolean;
	drivingSessions: number;
}): FalsifierResult {
	const reasons: string[] = [];
	if (input.scheduleLagP99Ms === null) {
		reasons.push("V-F: no floor arm — the generator's floor is unmeasured");
	} else if (input.scheduleLagP99Ms > input.boundMs) {
		reasons.push(
			`V-F: generator scheduleLag p99 ${input.scheduleLagP99Ms.toFixed(3)} ms > ${input.boundMs.toFixed(3)} ms`,
		);
	}
	if (input.floorArmDateIso === null) {
		reasons.push("V-F: floor report carries no date");
	} else if (
		input.floorArmDateIso.slice(0, 10) !== input.runDateIso.slice(0, 10)
	) {
		reasons.push(
			`V-F: floor report is from ${input.floorArmDateIso.slice(0, 10)}, the run from ${input.runDateIso.slice(0, 10)}`,
		);
	}
	if (!input.generatorHostMatches) {
		reasons.push(
			"V-F: floor report is from a different host than the generator",
		);
	}
	if (input.drivingSessions <= 0) {
		reasons.push("V-F: floor arm drove nothing, so it measured nothing");
	}
	return {
		id: "V-F",
		fired: reasons.length > 0,
		reasons,
		observed: { ...input },
		scope: "cell",
	};
}

/** V-G. A co-resident generator that binds is INCOMPLETE, never a MISS. */
export function falsifierGenerator(input: {
	clientCpuPctOfOwnCores: number | null;
}): FalsifierResult {
	const reasons: string[] = [];
	if (input.clientCpuPctOfOwnCores === null) {
		reasons.push(
			"V-G: generator CPU unreadable — saturation cannot be ruled out",
		);
	} else if (input.clientCpuPctOfOwnCores >= GENERATOR_CPU_BAR_PCT) {
		reasons.push(
			`V-G: generator CPU ${input.clientCpuPctOfOwnCores.toFixed(1)}% of its own cores >= ${GENERATOR_CPU_BAR_PCT}%`,
		);
	}
	return {
		id: "V-G",
		fired: reasons.length > 0,
		reasons,
		observed: { ...input },
		scope: "cell",
	};
}

/**
 * V-M. Above the cycle-lifetime ceiling the arm is measuring `max_sessions`
 * rather than churn (§1.6c), which is a rig statement and not a product one.
 */
export function falsifierMaxSessions(input: {
	meanCycleSec: number | null;
	offeredRatePerSec: number;
	sessionsActivePeak: number | null;
}): FalsifierResult {
	const reasons: string[] = [];
	const ceiling = cycleLifetimeCeilingSec(input.offeredRatePerSec);
	if (input.meanCycleSec === null) {
		reasons.push("V-M: cycle lifetime unmeasured");
	} else if (input.meanCycleSec > ceiling) {
		reasons.push(
			`V-M: mean cycle ${input.meanCycleSec.toFixed(3)} s > the ${ceiling.toFixed(3)} s ceiling at ${input.offeredRatePerSec}/s — the arm is measuring max_sessions`,
		);
	}
	if (
		input.sessionsActivePeak !== null &&
		input.sessionsActivePeak >= SHIPPED_MAX_SESSIONS
	) {
		reasons.push(
			`V-M: sessionsActive peaked at ${input.sessionsActivePeak}, the shipped max_sessions`,
		);
	}
	return {
		id: "V-M",
		fired: reasons.length > 0,
		reasons,
		observed: { ceilingSec: ceiling, ...input },
		scope: "cell",
	};
}

/**
 * V-C. The server's partial span (K25) is *contained in* the client's full span,
 * so it cannot exceed it. If it does, one of the two instruments is wrong and
 * neither may be read.
 */
export function falsifierSpanConsistency(input: {
	serverPartialSpanP99Ns: number | null;
	clientFullSpanP99Ns: number | null;
}): FalsifierResult {
	const reasons: string[] = [];
	const { serverPartialSpanP99Ns, clientFullSpanP99Ns } = input;
	if (serverPartialSpanP99Ns !== null && clientFullSpanP99Ns !== null) {
		if (serverPartialSpanP99Ns > clientFullSpanP99Ns) {
			reasons.push(
				`V-C: the server's partial span p99 (${(serverPartialSpanP99Ns / 1e6).toFixed(3)} ms) exceeds the full span it sits inside (${(clientFullSpanP99Ns / 1e6).toFixed(3)} ms) — a clock or instrument fault`,
			);
		}
	}
	return {
		id: "V-C",
		fired: reasons.length > 0,
		reasons,
		observed: { ...input },
		scope: "cell",
	};
}

/**
 * V-S. Prove the path contains a network rather than inferring it — G4's lesson,
 * where an in-process publisher produced a 9-31 us "ingest" path. A cycle
 * counted complete with no server-side stream accept never crossed anything.
 */
export function falsifierExchangeReality(input: {
	clientRequestBytesSent: number;
	serverRequestBytesRead: number;
	cyclesCompleted: number;
	serverStreamsAccepted: number;
}): FalsifierResult {
	const reasons: string[] = [];
	if (input.clientRequestBytesSent !== input.serverRequestBytesRead) {
		reasons.push(
			`V-S: client sent ${input.clientRequestBytesSent} request bytes, server read ${input.serverRequestBytesRead}`,
		);
	}
	if (input.serverStreamsAccepted < input.cyclesCompleted) {
		reasons.push(
			`V-S: ${input.cyclesCompleted} cycles counted complete but only ${input.serverStreamsAccepted} streams reached the server`,
		);
	}
	return {
		id: "V-S",
		fired: reasons.length > 0,
		reasons,
		observed: { ...input },
		scope: "run",
	};
}

/**
 * V-K. "We saw no drops" and "we could not look" are different statements. A tap
 * that returned null and was then written into the artifact as a zero voids the
 * run, because every drop-shaped clause downstream would read clean.
 */
export function falsifierKernelTaps(
	taps: { name: string; read: boolean; value: number | null }[],
): FalsifierResult {
	const reasons: string[] = [];
	for (const t of taps) {
		if (!t.read && t.value !== null) {
			reasons.push(
				`V-K: tap ${t.name} could not be read but carries the value ${t.value}`,
			);
		}
	}
	return {
		id: "V-K",
		fired: reasons.length > 0,
		reasons,
		observed: { taps },
		scope: "run",
	};
}

/* -------------------------------------------------------------------------- */
/* Roll-up                                                                    */
/* -------------------------------------------------------------------------- */

export type RunVerdict = {
	verdict: "PASS" | "MISS" | "NO-VERDICT" | "INVALID";
	/** True when a characterization-scope falsifier stripped verdict force. */
	characterizationOnly: boolean;
	reasons: string[];
	clauses: ClauseResult[];
	falsifiers: FalsifierResult[];
};

/**
 * The strongest outcome present wins, and a falsifier outranks every clause.
 * Unit-tested to stamp INVALID over a set of clauses that all computed PASS —
 * which is the exact reading G3b's classifier would have permitted.
 */
export function rollUp(
	clauses: ClauseResult[],
	falsifiers: FalsifierResult[],
): RunVerdict {
	const reasons: string[] = [];
	const fired = falsifiers.filter((v) => v.fired);
	for (const v of fired) reasons.push(...v.reasons);

	const invalid = fired.some((v) => v.scope === "run");
	const cellIncomplete = fired.some((v) => v.scope === "cell");
	const characterizationOnly = fired.some(
		(v) => v.scope === "characterization",
	);

	let verdict: RunVerdict["verdict"];
	if (invalid) {
		verdict = "INVALID";
	} else if (
		cellIncomplete ||
		clauses.some((c) => c.verdict === "INCOMPLETE")
	) {
		verdict = "NO-VERDICT";
	} else if (clauses.some((c) => c.verdict === "MISS")) {
		verdict = "MISS";
	} else {
		verdict = "PASS";
	}
	for (const c of clauses) {
		if (c.verdict !== "PASS") reasons.push(...c.reasons);
	}
	return { verdict, characterizationOnly, reasons, clauses, falsifiers };
}

/* -------------------------------------------------------------------------- */
/* §2.1 — lower-rung licensing, decided before the run                        */
/* -------------------------------------------------------------------------- */

export type RungOutcome = {
	ratePerSec: number;
	verdict: RunVerdict["verdict"];
};

/**
 * What the ladder licenses, registered in §2.1 so it cannot be promoted into a
 * headline after the top rung disappoints. The highest rung that PASSED is the
 * whole licence; a rung that was never run licenses nothing, and no rate between
 * two rungs is ever licensed (K5's lesson — interpolation is not measurement).
 *
 * A leak is not a capacity question: if no rung cleared C5 the ladder licenses
 * nothing at all, whatever the rates did.
 */
export function licensedRung(
	rungs: RungOutcome[],
	anyRungClearedLeakClause: boolean,
): { ratePerSec: number | null; reason: string } {
	if (!anyRungClearedLeakClause) {
		return {
			ratePerSec: null,
			reason:
				"no rung cleared C5 — a leak is not a capacity question, so the ladder licenses nothing",
		};
	}
	const passed = rungs
		.filter((r) => r.verdict === "PASS")
		.map((r) => r.ratePerSec)
		.sort((a, b) => b - a);
	if (passed.length === 0) {
		return { ratePerSec: null, reason: "no rung passed" };
	}
	return {
		ratePerSec: passed[0] as number,
		reason: `highest passing rung; no rate above or between rungs is licensed`,
	};
}

/** The abort ceiling the generator carries, re-exported so the harness cannot invent its own. */
export { generatorAbortCeiling };
