/**
 * G6's clause rules and validity falsifiers, as pure functions over plain
 * records.
 *
 * This file exists because of G3b. Its registered falsifier V1 was a run-level
 * check the gate agent owed by hand: `classified.json` carried no field for it,
 * the run's own classifier said PASS, and a reader taking that PASS at face
 * value would have stamped a gate the registration itself declared invalid. The
 * defect that voided the run — percentiles computed over positive samples only,
 * with an arm-dependent negative fraction — was invisible in every summary
 * field and had to be dug out of the raw buckets.
 *
 * So: every clause in `docs/research/preregistrations/gate-g6-mmo.md` §2, §3 and
 * §5, and every falsifier in §7, is a function here, each one returns *all* of
 * its failing reasons rather than the first, and `tools/load/g6-classify.test.ts`
 * feeds each one the signature that must make it fire — off the runner, in a
 * unit test, before any dispatch.
 *
 * Nothing here decides a verdict on its own. The gate agent recomputes every
 * clause from the raw artifact; these functions are what the artifact's own
 * booleans are checked *against*.
 */

import { ingestRealityVerdict } from "./egress-fanout.ts";
import type { PreflightVerdict } from "../offbox/preflight-lib.ts";
import {
	DELIVERY_FLOOR,
	EMITTED_FRACTION_FLOOR,
	floorLagCeilingMs,
	HISTOGRAM_SKEW_FRACTION,
	hotspotOneWayBudgetMs,
	LITTLE_BAND,
	OFFERED_RATIO_FLOOR,
	rttBudgetMs,
	SERVER_OBSERVED_FLOOR,
	SINK_DELIVERY_FLOOR,
	SINK_HEADROOM_FACTOR,
	STAGE_RESIDUAL_FRACTION,
} from "./g6-plan.ts";

export type Verdict = "PASS" | "MISS" | "INCOMPLETE" | "N/A";

export type ClauseResult = {
	id: string;
	verdict: Verdict;
	/** Every failing condition, in registered order. Empty on PASS. */
	reasons: string[];
	/** The values the verdict rests on, for the stamp to quote. */
	observed: Record<string, number | string | boolean | null>;
};

function pass(
	id: string,
	observed: ClauseResult["observed"],
	reasons: string[],
	incompleteWhen = false,
): ClauseResult {
	if (incompleteWhen) return { id, verdict: "INCOMPLETE", reasons, observed };
	return {
		id,
		verdict: reasons.length === 0 ? "PASS" : "MISS",
		reasons,
		observed,
	};
}

/* -------------------------------------------------------------------------- */
/* Histograms — the two things G3b proved a summary field will not tell you    */
/* -------------------------------------------------------------------------- */

export type HistogramFacts = {
	name: string;
	/** Samples the emitted buckets actually contain. */
	count: number;
	/** Producer-declared bucket count, checked independently of the raw sum. */
	declaredCount: number;
	/** The producer's running counter. A gap means the snapshot raced recording. */
	recordedTotal: number;
	/** Samples that came out negative. On a single clock this must be zero. */
	negative: number;
	p99Ns: number | null;
	/**
	 * What the run's own counters say should have been sampled on this path.
	 * `null` when no such counter exists, which is itself worth stating.
	 */
	expectedSamples: number | null;
	/** Datagrams on this path that carried no readable stamp. */
	unstamped: number;
};

/**
 * V-N and V-K and V-D, together, because they are three ways of asking whether
 * the percentile describes the population it claims to.
 *
 * V-N: a negative round trip on one clock is impossible. Not "conditioned out",
 * not "ranked as ≤ 0" — impossible, so its presence means the instrument is
 * wrong and the run is invalid. G3b had to re-derive its percentiles two ways
 * because its metric legitimately went negative; G6's cannot.
 *
 * V-K: `recordedTotal - count` is the producer's own evidence that the snapshot
 * was taken while it was still recording. A percentile reader handed a rank its
 * buckets cannot reach walks off the end and reports the maximum.
 *
 * V-D: the sample count has to equal the path-specific stamped-sample
 * denominator. Any unstamped receive makes that population unclassifiable; it
 * may not be subtracted from a different class's denominator. G1 checked this
 * ("sample count equals steadySent exactly at every rung") and it is the
 * cheapest defence against a percentile computed over a survivorship subset.
 */
export function histogramValidity(h: HistogramFacts): {
	valid: boolean;
	reasons: string[];
} {
	const reasons: string[] = [];
	if (h.negative > 0) {
		reasons.push(
			`V-N ${h.name}: ${h.negative} negative sample(s) on a single-clock measurement`,
		);
	}
	if (h.count !== h.declaredCount) {
		reasons.push(
			`V-K ${h.name}: raw bucket total ${h.count} differs from declared count ${h.declaredCount}`,
		);
	}
	const skew = h.recordedTotal - h.count;
	if (skew < 0) {
		reasons.push(
			`V-K ${h.name}: recordedTotal ${h.recordedTotal} is below bucketed count ${h.count}`,
		);
	} else if (skew > HISTOGRAM_SKEW_FRACTION * Math.max(h.count, 1)) {
		reasons.push(
			`V-K ${h.name}: recordedTotal ${h.recordedTotal} exceeds bucketed count ${h.count} by ${skew} (> ${HISTOGRAM_SKEW_FRACTION * 100}%)`,
		);
	}
	if (h.unstamped > 0) {
		reasons.push(
			`V-D ${h.name}: ${h.unstamped} unstamped receive(s) make the latency population unclassifiable`,
		);
	}
	if (h.expectedSamples !== null) {
		if (h.count !== h.expectedSamples) {
			reasons.push(
				`V-D ${h.name}: ${h.count} samples against ${h.expectedSamples} expected stamped samples`,
			);
		}
	}
	return { valid: reasons.length === 0, reasons };
}

/* -------------------------------------------------------------------------- */
/* Arm 1 — steady realm (§2)                                                   */
/* -------------------------------------------------------------------------- */

export type SteadyArmFacts = {
	sessions: number;
	/** C1 */
	clientEnqueuedUpstream: number;
	serverRxUpstream: number;
	/** C2, per class. `serverIssued` counts completed sends, never intentions. */
	snapshotServerIssued: number;
	snapshotClientReceived: number;
	ackServerIssued: number;
	ackClientReceived: number;
	/** C3 */
	rtt: HistogramFacts;
	/** C4 */
	sessionsLost: number;
	sessionsActiveAtEnd: number;
	/** C5 — a tap that did not read is null, never 0. */
	ledger: {
		clientEnqueued: number;
		clientWireTx: number | null;
		kernelDropsSocket: number | null;
		kernelRcvbufErrors: number | null;
		serverObserved: number | null;
		jsDelivered: number;
		nativeDropped: number | null;
		nativeSkippedQueueFull: number | null;
	};
	/** C6 */
	emitter: {
		snapshotDue: number;
		snapshotIssued: number;
		ackDue: number;
		ackIssued: number;
		sendEventsSkipped: number;
		sendErrors: number;
		batchPartialCompletions: number;
	};
};

export function clauseC1(f: SteadyArmFacts): ClauseResult {
	const ratio =
		f.clientEnqueuedUpstream > 0
			? f.serverRxUpstream / f.clientEnqueuedUpstream
			: null;
	const reasons: string[] = [];
	if (ratio === null) reasons.push("C1: no upstream datagrams were enqueued");
	else if (ratio < DELIVERY_FLOOR) {
		reasons.push(
			`C1: upstream delivery ${ratio.toFixed(5)} < ${DELIVERY_FLOOR}`,
		);
	}
	return pass("C1", { ratio, floor: DELIVERY_FLOOR }, reasons, ratio === null);
}

export function clauseC2(f: SteadyArmFacts): ClauseResult {
	const snapshot =
		f.snapshotServerIssued > 0
			? f.snapshotClientReceived / f.snapshotServerIssued
			: null;
	const ack =
		f.ackServerIssued > 0 ? f.ackClientReceived / f.ackServerIssued : null;
	const reasons: string[] = [];
	// Both classes separately and on purpose: one aggregate ratio lets 75,000
	// snapshots hide a failing ack path, and the ack path is where the gate's
	// latency clause lives.
	if (snapshot === null) reasons.push("C2: no snapshot datagrams were issued");
	else if (snapshot < DELIVERY_FLOOR) {
		reasons.push(
			`C2 snapshot: delivery ${snapshot.toFixed(5)} < ${DELIVERY_FLOOR}`,
		);
	}
	if (ack === null) reasons.push("C2: no ack datagrams were issued");
	else if (ack < DELIVERY_FLOOR) {
		reasons.push(`C2 ack: delivery ${ack.toFixed(5)} < ${DELIVERY_FLOOR}`);
	}
	return pass(
		"C2",
		{ snapshot, ack, floor: DELIVERY_FLOOR },
		reasons,
		snapshot === null || ack === null,
	);
}

export function clauseC3(f: SteadyArmFacts): ClauseResult {
	const p99Ms = f.rtt.p99Ns === null ? null : f.rtt.p99Ns / 1e6;
	const budget = rttBudgetMs();
	const reasons: string[] = [];
	if (p99Ms === null) reasons.push("C3: no RTT samples");
	// Raw p99, nothing subtracted. The Mac's floor is a *precondition* (V-F),
	// reported beside this number and never taken off it — G1's rule.
	else if (p99Ms > budget) {
		reasons.push(`C3: ack RTT p99 ${p99Ms.toFixed(3)} ms > ${budget} ms`);
	}
	return pass("C3", { p99Ms, budgetMs: budget }, reasons, p99Ms === null);
}

export function clauseC4(f: SteadyArmFacts): ClauseResult {
	const reasons: string[] = [];
	if (f.sessionsLost !== 0) {
		reasons.push(`C4: ${f.sessionsLost} session(s) lost during the arm`);
	}
	if (f.sessionsActiveAtEnd !== f.sessions) {
		reasons.push(
			`C4: ${f.sessionsActiveAtEnd} sessions active at arm end, expected ${f.sessions}`,
		);
	}
	return pass(
		"C4",
		{
			sessionsLost: f.sessionsLost,
			sessionsActiveAtEnd: f.sessionsActiveAtEnd,
			expected: f.sessions,
		},
		reasons,
	);
}

export function clauseC5(f: SteadyArmFacts): ClauseResult {
	const L = f.ledger;
	const tolerance = STAGE_RESIDUAL_FRACTION * L.clientEnqueued;
	const reasons: string[] = [];
	const observed: ClauseResult["observed"] = { tolerance };

	// A tap that did not read is null, never zero. G1's registered branch: if
	// both kernel sources are absent the clause is INCOMPLETE, because "we saw
	// no drops" and "we could not look" are different statements.
	const kernelAbsent =
		L.kernelDropsSocket === null && L.kernelRcvbufErrors === null;

	if (L.clientWireTx === null) {
		observed.residualIngress = null;
	} else {
		const residual = L.clientEnqueued - L.clientWireTx;
		observed.residualIngress = residual;
		if (Math.abs(residual) > tolerance) {
			reasons.push(
				`C5a ingress residual ${residual} exceeds ${tolerance.toFixed(1)}`,
			);
		}
	}

	const kernelDrops = L.kernelDropsSocket ?? L.kernelRcvbufErrors;
	if (
		L.clientWireTx !== null &&
		kernelDrops !== null &&
		L.serverObserved !== null
	) {
		const kernelDelivered = L.clientWireTx - kernelDrops;
		const residual = kernelDelivered - L.serverObserved;
		observed.kernelDelivered = kernelDelivered;
		observed.residualKernel = residual;
		if (Math.abs(residual) > tolerance) {
			reasons.push(
				`C5a kernel residual ${residual} exceeds ${tolerance.toFixed(1)}`,
			);
		}
		const seen =
			kernelDelivered > 0 ? L.serverObserved / kernelDelivered : null;
		observed.serverObservedRatio = seen;
		if (seen !== null && seen < SERVER_OBSERVED_FLOOR) {
			reasons.push(
				`C5b serverObserved/kernelDelivered ${seen.toFixed(5)} < ${SERVER_OBSERVED_FLOOR}`,
			);
		}
	}

	if (L.serverObserved !== null) {
		const residual =
			L.serverObserved -
			L.jsDelivered -
			(L.nativeDropped ?? 0) -
			(L.nativeSkippedQueueFull ?? 0);
		observed.residualNative = residual;
		if (Math.abs(residual) > tolerance) {
			reasons.push(
				`C5a native residual ${residual} exceeds ${tolerance.toFixed(1)}`,
			);
		}
	}

	if (kernelAbsent) {
		reasons.push("C5: neither kernel drop source read — INCOMPLETE, not zero");
	}
	return pass("C5", observed, reasons, kernelAbsent);
}

export function clauseC6(f: SteadyArmFacts): ClauseResult {
	const e = f.emitter;
	const snapshotFraction =
		e.snapshotDue > 0 ? e.snapshotIssued / e.snapshotDue : null;
	const ackFraction = e.ackDue > 0 ? e.ackIssued / e.ackDue : null;
	const reasons: string[] = [];
	if (snapshotFraction === null) reasons.push("C6: no snapshot sends were due");
	else if (snapshotFraction < EMITTED_FRACTION_FLOOR) {
		reasons.push(
			`C6 snapshot: emitted fraction ${snapshotFraction.toFixed(4)} < ${EMITTED_FRACTION_FLOOR}`,
		);
	}
	if (ackFraction === null) reasons.push("C6: no acks were due");
	else if (ackFraction < EMITTED_FRACTION_FLOOR) {
		reasons.push(
			`C6 ack: emitted fraction ${ackFraction.toFixed(4)} < ${EMITTED_FRACTION_FLOOR}`,
		);
	}
	if (e.sendEventsSkipped !== 0) {
		reasons.push(`C6: ${e.sendEventsSkipped} send event(s) skipped`);
	}
	if (e.sendErrors !== 0) reasons.push(`C6: ${e.sendErrors} send error(s)`);
	// A batch that reported `sent < requested` is a partial completion. It is a
	// real outcome of the landed envelope, it is counted, and it fails C6 —
	// silently dropping the remainder is how an emitter looks honest while
	// sourcing less than the arm registered.
	if (e.batchPartialCompletions !== 0) {
		reasons.push(
			`C6: ${e.batchPartialCompletions} batch call(s) completed partially`,
		);
	}
	return pass(
		"C6",
		{ snapshotFraction, ackFraction, floor: EMITTED_FRACTION_FLOOR },
		reasons,
		snapshotFraction === null || ackFraction === null,
	);
}

export function steadyArmClauses(f: SteadyArmFacts): ClauseResult[] {
	return [
		clauseC1(f),
		clauseC2(f),
		clauseC3(f),
		clauseC4(f),
		clauseC5(f),
		clauseC6(f),
	];
}

/* -------------------------------------------------------------------------- */
/* Arm 2 — raid hotspot (§3)                                                   */
/* -------------------------------------------------------------------------- */

export type HotspotFacts = {
	subscribers: number;
	oneWay: HistogramFacts;
	ingested: number;
	forwarded: number;
	subscriberReceived: number;
	/** H4 inputs, ticket 14's falsifier verbatim. */
	/**
	 * p50 of publisher-send → subscriber-receive, **on the subscribers' own
	 * clock**. Amendment 2 of the registration: ticket 14's rule read
	 * "publisher-send → first forward issued", which on-box was one clock and
	 * off-box spans two hosts and cannot be differenced at all. The subscriber's
	 * one-way covers the same question strictly more strongly — it contains two
	 * cable traversals — and is measurable.
	 */
	pathP50Ns: number;
	/**
	 * Server-internal arrival → first-forward dwell. Disclosure only: it is one
	 * process on one clock and is *expected* to be µs-scale, so feeding it to the
	 * µs-signature rule would fire the falsifier on every valid run.
	 */
	serverForwardDwellP50Ns: number;
	frameGapFraction: number;
	datagramsPerTick: number;
	publisherStamped: number;
};

export function clauseH1(f: HotspotFacts): ClauseResult {
	const p99Ms = f.oneWay.p99Ns === null ? null : f.oneWay.p99Ns / 1e6;
	const budget = hotspotOneWayBudgetMs();
	const reasons: string[] = [];
	if (p99Ms === null) reasons.push("H1: no one-way samples");
	else if (p99Ms > budget) {
		reasons.push(
			`H1: publisher→subscriber p99 ${p99Ms.toFixed(3)} ms > ${budget} ms`,
		);
	}
	return pass("H1", { p99Ms, budgetMs: budget }, reasons, p99Ms === null);
}

export function clauseH2(f: HotspotFacts): ClauseResult {
	const expected = f.ingested * f.subscribers;
	const ratio = expected > 0 ? f.subscriberReceived / expected : null;
	const reasons: string[] = [];
	if (ratio === null) reasons.push("H2: nothing was ingested to forward");
	else if (ratio < DELIVERY_FLOOR) {
		reasons.push(
			`H2: forward delivery ${ratio.toFixed(5)} < ${DELIVERY_FLOOR}`,
		);
	}
	return pass(
		"H2",
		{ ratio, expected, floor: DELIVERY_FLOOR },
		reasons,
		ratio === null,
	);
}

/** H3 keeps the concurrent steady realm's delivery and RTT obligations intact. */
export function clauseH3(f: SteadyArmFacts): ClauseResult {
	const c1 = clauseC1(f);
	const c3 = clauseC3(f);
	const reasons = [
		...c1.reasons.map((reason) => `H3/${reason}`),
		...c3.reasons.map((reason) => `H3/${reason}`),
	];
	const incomplete = c1.verdict === "INCOMPLETE" || c3.verdict === "INCOMPLETE";
	return pass(
		"H3",
		{
			upstreamRatio: c1.observed.ratio ?? null,
			upstreamFloor: c1.observed.floor ?? null,
			rttP99Ms: c3.observed.p99Ms ?? null,
			rttBudgetMs: c3.observed.budgetMs ?? null,
		},
		reasons,
		incomplete,
	);
}

/**
 * H4 / V-I. Ticket 14's ingest-reality falsifier, reused rather than
 * reimplemented: the retracted fan-out run reported a 9–31 µs ingest-to-forward
 * lag while the ladder beside it read milliseconds, which is what a path that
 * never contained a network looks like. G6's publisher is on the other side of a
 * cable, so this must not fire — which is exactly why it is registered.
 */
export function falsifierIngestReality(f: HotspotFacts): FalsifierResult {
	const verdict = ingestRealityVerdict({
		ingestToForwardP50Ns: f.pathP50Ns,
		frameGapFraction: f.frameGapFraction,
		datagramsPerTick: f.datagramsPerTick,
		publisherStamped: f.publisherStamped,
		ingested: f.ingested,
	});
	return {
		id: "V-I",
		fired: !verdict.real,
		reasons: verdict.reasons.map(
			(r) =>
				`V-I ${r} (cadence band ${verdict.band.low.toFixed(3)}–${verdict.band.high.toFixed(3)}, observed ${f.frameGapFraction.toFixed(3)})`,
		),
		scope: "run",
	};
}

/* -------------------------------------------------------------------------- */
/* Arm 3 — reconnect storm (§5)                                                */
/* -------------------------------------------------------------------------- */

export type StormFacts = {
	cohort: number;
	realmSessions: number;
	/** S-C1: survivors only, from per-session accounting. */
	survivors: {
		sessions: number;
		rtt: HistogramFacts;
		clientEnqueuedUpstream: number;
		serverRxUpstream: number;
		sessionsLost: number;
	} | null;
	/** S-C2 */
	reAcceptedInWindow: number;
	sessionsActiveAtWindowClose: number;
	limitExceededDelta: number;
	rateLimitedDelta: number;
	stormWindowSec: number;
};

export function clauseSC1(f: StormFacts): ClauseResult {
	if (f.survivors === null) {
		// S2 severs the whole realm: there are no survivors, so the clause does
		// not apply. Not a pass, not a miss — it is out of scope by construction.
		return {
			id: "S-C1",
			verdict: "N/A",
			reasons: ["S-C1 does not apply: the whole realm was severed"],
			observed: { cohort: f.cohort, realmSessions: f.realmSessions },
		};
	}
	const s = f.survivors;
	const p99Ms = s.rtt.p99Ns === null ? null : s.rtt.p99Ns / 1e6;
	const budget = rttBudgetMs();
	const delivery =
		s.clientEnqueuedUpstream > 0
			? s.serverRxUpstream / s.clientEnqueuedUpstream
			: null;
	const reasons: string[] = [];
	if (p99Ms === null) reasons.push("S-C1: no survivor RTT samples");
	else if (p99Ms > budget) {
		reasons.push(
			`S-C1: survivor RTT p99 ${p99Ms.toFixed(3)} ms > ${budget} ms`,
		);
	}
	if (delivery === null) reasons.push("S-C1: survivors offered nothing");
	else if (delivery < DELIVERY_FLOOR) {
		reasons.push(
			`S-C1: survivor upstream delivery ${delivery.toFixed(5)} < ${DELIVERY_FLOOR}`,
		);
	}
	if (s.sessionsLost !== 0) {
		reasons.push(`S-C1: ${s.sessionsLost} survivor session(s) lost`);
	}
	return pass(
		"S-C1",
		{ p99Ms, budgetMs: budget, delivery, survivors: s.sessions },
		reasons,
		p99Ms === null || delivery === null,
	);
}

export function clauseSC2(f: StormFacts): ClauseResult {
	const reasons: string[] = [];
	if (f.reAcceptedInWindow < f.cohort) {
		reasons.push(
			`S-C2: ${f.reAcceptedInWindow} of ${f.cohort} severed sessions re-accepted inside the ${f.stormWindowSec}s window`,
		);
	}
	if (f.sessionsActiveAtWindowClose !== f.realmSessions) {
		reasons.push(
			`S-C2: ${f.sessionsActiveAtWindowClose} sessions active at window close, expected ${f.realmSessions}`,
		);
	}
	if (f.limitExceededDelta !== 0) {
		reasons.push(`S-C2: limitExceeded rose by ${f.limitExceededDelta}`);
	}
	if (f.rateLimitedDelta !== 0) {
		reasons.push(`S-C2: rateLimited rose by ${f.rateLimitedDelta}`);
	}
	return pass(
		"S-C2",
		{
			reAccepted: f.reAcceptedInWindow,
			cohort: f.cohort,
			activeAtClose: f.sessionsActiveAtWindowClose,
		},
		reasons,
	);
}

/* -------------------------------------------------------------------------- */
/* §7 falsifiers                                                               */
/* -------------------------------------------------------------------------- */

export type FalsifierResult = {
	id: string;
	fired: boolean;
	reasons: string[];
	/** V-L is the one falsifier that strips verdict force without voiding arms. */
	scope: "run" | "characterization";
};

/**
 * V-L. The retracted accept-rate figures (449–700 accepts/s) were
 * `acceptsPerSec × mean accept latency ≈ 500` — Little's law on the generator's
 * own connect semaphore, at every rung. G6's storm arm removes the semaphore by
 * construction (connect concurrency = cohort size), so this must not fire; it is
 * registered anyway because "it cannot happen" is what the retraction thought
 * too.
 *
 * `connectConcurrency === null` means the generator ran with no permit pool,
 * which is the registered configuration and cannot be Little's-law'd.
 */
export function falsifierLittle(input: {
	acceptRatePerSec: number | null;
	meanAcceptLatencySec: number | null;
	connectConcurrency: number | null;
}): FalsifierResult {
	const reasons: string[] = [];
	const { acceptRatePerSec, meanAcceptLatencySec, connectConcurrency } = input;
	if (
		connectConcurrency !== null &&
		acceptRatePerSec !== null &&
		meanAcceptLatencySec !== null
	) {
		const productN = acceptRatePerSec * meanAcceptLatencySec;
		const low = (1 - LITTLE_BAND) * connectConcurrency;
		const high = (1 + LITTLE_BAND) * connectConcurrency;
		if (productN >= low && productN <= high) {
			reasons.push(
				`V-L: acceptRate × meanAcceptLatency = ${productN.toFixed(1)} sits within ±${LITTLE_BAND * 100}% of the ${connectConcurrency}-permit pool — this is the generator, not the server`,
			);
		}
	}
	return {
		id: "V-L",
		fired: reasons.length > 0,
		reasons,
		scope: "characterization",
	};
}

/**
 * V-F. The Mac's same-day floor arm. Ticket 29 measured 871 µs mean with a
 * 40.6 ms maximum on an *idle* box — a maximum inside the same order as the
 * whole 50 ms bound — so this is a precondition and not a footnote. Evaluated on
 * p99; the maximum is carried in `observed` for the stamp to disclose.
 */
export function falsifierFloor(input: {
	scheduleLagP99Ms: number | null;
	scheduleLagMaxMs: number | null;
	floorArmDateIso: string | null;
	runDateIso: string;
	generatorHostMatches: boolean;
	drivingSessions: number;
}): FalsifierResult {
	const reasons: string[] = [];
	const ceiling = floorLagCeilingMs();
	if (input.floorArmDateIso === null) {
		reasons.push("V-F: no floor arm was taken");
	} else if (
		input.floorArmDateIso.slice(0, 10) !== input.runDateIso.slice(0, 10)
	) {
		reasons.push(
			`V-F: floor arm ran ${input.floorArmDateIso.slice(0, 10)}, gate ran ${input.runDateIso.slice(0, 10)} — same-day rule`,
		);
	}
	if (!input.generatorHostMatches) {
		reasons.push("V-F: the floor was not measured on the generator host");
	}
	if (input.drivingSessions <= 0) {
		reasons.push("V-F: the floor was taken over zero driving sessions");
	}
	if (input.scheduleLagP99Ms === null) {
		reasons.push("V-F: the floor arm produced no schedule-lag percentile");
	} else if (input.scheduleLagP99Ms > ceiling) {
		reasons.push(
			`V-F: floor scheduleLag p99 ${input.scheduleLagP99Ms.toFixed(3)} ms > ${ceiling} ms`,
		);
	}
	return { id: "V-F", fired: reasons.length > 0, reasons, scope: "run" };
}

/**
 * V-S. The sink pre-check, measured on Mac loopback because the cable cannot
 * carry 1.5× the arm's downstream rate — 1.5 × 77,500 pps is above the wire.
 *
 * A pre-check whose own originator saturated says nothing about the sink: a
 * starved generator offering less load looks exactly like a healthy sink. That
 * case fires the falsifier rather than passing it (ticket 14's rule, kept).
 */
export function falsifierSink(input: {
	armDownstreamPps: number;
	precheckOfferedPps: number | null;
	precheckDeliveryRatio: number | null;
	precheckOriginatorSaturated: boolean;
}): FalsifierResult {
	const reasons: string[] = [];
	const required = SINK_HEADROOM_FACTOR * input.armDownstreamPps;
	if (
		input.precheckOfferedPps === null ||
		input.precheckDeliveryRatio === null
	) {
		reasons.push("V-S: no sink pre-check on record");
	} else {
		if (input.precheckOriginatorSaturated) {
			reasons.push(
				"V-S: the pre-check's own originator saturated, so it says nothing about the sink",
			);
		}
		if (input.precheckOfferedPps < required) {
			reasons.push(
				`V-S: pre-check drove ${Math.round(input.precheckOfferedPps)} pps, needs ${Math.round(required)} (${SINK_HEADROOM_FACTOR}× the arm)`,
			);
		}
		if (input.precheckDeliveryRatio < SINK_DELIVERY_FLOOR) {
			reasons.push(
				`V-S: pre-check delivery ${input.precheckDeliveryRatio.toFixed(5)} < ${SINK_DELIVERY_FLOOR}`,
			);
		}
	}
	return { id: "V-S", fired: reasons.length > 0, reasons, scope: "run" };
}

/** V-G. The Mac is a new generator host at a rate nobody has driven from it. */
export function falsifierGenerator(input: {
	offeredRatioByRung: { sessions: number; offeredRatio: number | null }[];
}): FalsifierResult {
	const reasons: string[] = [];
	for (const rung of input.offeredRatioByRung) {
		if (rung.offeredRatio === null) {
			reasons.push(`V-G: rung ${rung.sessions} reported no offered ratio`);
		} else if (rung.offeredRatio < OFFERED_RATIO_FLOOR) {
			reasons.push(
				`V-G: rung ${rung.sessions} offered ${rung.offeredRatio.toFixed(5)} < ${OFFERED_RATIO_FLOOR}`,
			);
		}
	}
	return { id: "V-G", fired: reasons.length > 0, reasons, scope: "run" };
}

export function falsifierCablePreflight(input: {
	results: { name: "R-down" | "R-up"; verdict: PreflightVerdict }[];
}): FalsifierResult {
	const reasons = input.results.flatMap(({ name, verdict }) =>
		verdict.valid
			? []
			: verdict.reasons.map((reason) => `V-C ${name}: ${reason}`),
	);
	return { id: "V-C", fired: reasons.length > 0, reasons, scope: "run" };
}

/**
 * V-N / V-K / V-D over every histogram the gate reads, as one run-level check.
 * Individually they are `histogramValidity`; collected here so the run cannot
 * pass with one histogram nobody looked at.
 */
export function falsifierHistograms(
	histograms: HistogramFacts[],
): FalsifierResult {
	const reasons = histograms.flatMap((h) => histogramValidity(h).reasons);
	return {
		id: "V-N/V-K/V-D",
		fired: reasons.length > 0,
		reasons,
		scope: "run",
	};
}

/* -------------------------------------------------------------------------- */
/* Run-level roll-up                                                           */
/* -------------------------------------------------------------------------- */

export type RunVerdict = {
	/** INVALID beats everything: an invalid run stamps no gate result at all. */
	valid: boolean;
	invalidReasons: string[];
	/** Falsifiers that only strip verdict force from the characterization. */
	characterizationOnlyReasons: string[];
	gate: Exclude<Verdict, "N/A"> | "INVALID";
	clauses: ClauseResult[];
};

/**
 * The roll-up, written so a reader cannot take a clause PASS at face value while
 * a run-level falsifier is firing — the exact failure mode G3b's V1 exposed.
 *
 * Order is deliberate: validity first, and if the run is invalid the gate field
 * says INVALID rather than reporting whatever the clauses happened to compute.
 * The clause results are still returned, because publishing them without verdict
 * force is what G3b did and is better than withholding them.
 */
export function rollUp(
	clauses: ClauseResult[],
	falsifiers: FalsifierResult[],
): RunVerdict {
	const runLevel = falsifiers.filter((f) => f.fired && f.scope === "run");
	const charLevel = falsifiers.filter(
		(f) => f.fired && f.scope === "characterization",
	);
	const invalidReasons = runLevel.flatMap((f) => f.reasons);
	if (invalidReasons.length > 0) {
		return {
			valid: false,
			invalidReasons,
			characterizationOnlyReasons: charLevel.flatMap((f) => f.reasons),
			gate: "INVALID",
			clauses,
		};
	}
	const anyMiss = clauses.some((c) => c.verdict === "MISS");
	const anyIncomplete = clauses.some((c) => c.verdict === "INCOMPLETE");
	return {
		valid: true,
		invalidReasons: [],
		characterizationOnlyReasons: charLevel.flatMap((f) => f.reasons),
		// A miss outranks an incomplete: a clause that measured and failed is a
		// result, and hiding it behind another clause's missing tap would be the
		// massaging the effort's rules forbid.
		gate: anyMiss ? "MISS" : anyIncomplete ? "INCOMPLETE" : "PASS",
		clauses,
	};
}
