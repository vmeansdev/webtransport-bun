/**
 * Gate G10's clauses (§3) and validity falsifiers (§7), as pure functions over
 * plain records.
 *
 * They live apart from the harness for the reason G3b paid for: a falsifier that
 * only exists inside a 120-second arm on a Linux runner cannot be shown to fire,
 * and G3b's V1 lived in a hand derivation until it was too late to matter. Here
 * every rule is a function, so `g10-classify.test.ts` can feed it the exact
 * signature it was written to reject and assert that it rejects it.
 *
 * **This module is not the verdict.** The pre-registration §10 requires the gate
 * agent to recompute every clause from the raw artifact. What this gives is a
 * second, tested computation to disagree with.
 */

import {
	ARM_LAG_SPREAD_LIMIT,
	broadcastSerializationMs,
	DELIVERY_FLOOR,
	EMITTED_FRACTION_FLOOR,
	expectedLoopLagTicks,
	GIGABIT,
	HISTOGRAM_SKEW_FRACTION,
	JS_STALL_BUDGET_MS,
	LOOP_LAG_MIN_TICK_FRACTION,
	MAX_EXCLUDED_MESSAGE_FRACTION,
	MESSAGE_COMPLETENESS_FLOOR,
	MESSAGE_PAYLOAD_BYTES,
	MIRROR_STALL_UNDERPRICING_FACTOR,
	mirrorStallFloorMs,
	OFFERED_RATIO_FLOOR,
	PER_SUBSCRIBER_COHORT_FLOOR,
	probeFloorLagCeilingMs,
	RTT_BOUND_MS,
	SINK_DELIVERY_FLOOR,
	STAGE_RESIDUAL_FRACTION,
	SUBSCRIBERS,
	sinkPrecheckPps,
	spreadBoundMs,
	spreadClauseApplies,
	sinkDrainCeilingMs,
	VERDICT_ARM,
} from "./g10-plan";

/* -------------------------------------------------------------------------- */
/* Shared shapes                                                              */
/* -------------------------------------------------------------------------- */

export type ClauseId = "C1" | "C2a" | "C2b" | "C3" | "C4" | "C5" | "C6" | "C7";

/**
 * A clause outcome. `not-applicable` is a first-class result, not a missing
 * value: §1.6 registers R = 20's spread clause as unsatisfiable by arithmetic
 * before any run, and a gate that reported that as a miss would be scoring the
 * cable rather than the product.
 *
 * `no-verdict-force` is the other first-class result: V-SP, V-X and V-A each
 * strip force from a named statement without invalidating the run, and the
 * artifact has to carry that distinction rather than collapse it into `fail`.
 */
export type ClauseStatus =
	| "pass"
	| "fail"
	| "not-applicable"
	| "no-verdict-force";

export type ClauseResult = {
	id: ClauseId;
	status: ClauseStatus;
	/** The number the clause read. */
	observed: number | null;
	/** The number it was read against, when there is one. */
	bound: number | null;
	/** Registered, human-readable reason. Always present. */
	reason: string;
};

export type ArmId = "A1" | "A2" | "A3";

/* -------------------------------------------------------------------------- */
/* C1 — fan-out completion spread                                             */
/* -------------------------------------------------------------------------- */

export type SpreadFacts = {
	rate: number;
	subscribers: number;
	/** p99 of per-message spread, over messages that passed the guard. */
	spreadP99Ms: number | null;
	/** Messages the emitter issued in the window. */
	messagesIssued: number;
	/** Messages whose completeness cleared MESSAGE_COMPLETENESS_FLOOR. */
	messagesComplete: number;
	payloadBytes?: number;
	linkBitsPerSec?: number;
};

/**
 * The share of the window's messages the completeness guard threw away.
 *
 * This exists because an incomplete broadcast has a *narrower* spread than a
 * complete one — a delivery failure would otherwise read as a latency success.
 */
export function excludedMessageFraction(facts: SpreadFacts): number {
	if (facts.messagesIssued <= 0) return 1;
	const excluded = facts.messagesIssued - facts.messagesComplete;
	return Math.max(0, excluded) / facts.messagesIssued;
}

/** Whether a single message's completeness lets its spread into the p99. */
export function messageCountsForSpread(
	received: number,
	subscribers = SUBSCRIBERS,
): boolean {
	if (subscribers <= 0) return false;
	return received / subscribers >= MESSAGE_COMPLETENESS_FLOOR;
}

/** V-X. Too much of the window was thrown away for the p99 to speak for it. */
export function completenessFalsifierFires(facts: SpreadFacts): boolean {
	return excludedMessageFraction(facts) > MAX_EXCLUDED_MESSAGE_FRACTION;
}

/**
 * C1. Note the order: applicability first, then the falsifier, then the
 * comparison. A rung whose bound the wire already forbids never reaches the
 * comparison, so it cannot be recorded as a miss.
 */
export function evaluateSpreadClause(
	facts: SpreadFacts,
	spreadFloorFalsifierFired = false,
): ClauseResult {
	const payload = facts.payloadBytes ?? MESSAGE_PAYLOAD_BYTES;
	const link = facts.linkBitsPerSec ?? GIGABIT;
	const bound = spreadBoundMs(facts.rate);
	const floor = broadcastSerializationMs(facts.subscribers, payload, link);

	if (!spreadClauseApplies(facts.rate, facts.subscribers, payload, link)) {
		return {
			id: "C1",
			status: "not-applicable",
			observed: facts.spreadP99Ms,
			bound,
			reason:
				`rate ${facts.rate}/s gives a ${(1000 / facts.rate).toFixed(2)} ms ` +
				`period but the path needs ${bound.toFixed(2)} ms to serialize ` +
				`${facts.subscribers} copies with the sink margin; published as a ` +
				"characterization (prereg §1.6, Amendment 4)",
		};
	}
	if (completenessFalsifierFires(facts)) {
		return {
			id: "C1",
			status: "no-verdict-force",
			observed: facts.spreadP99Ms,
			bound,
			reason:
				`V-X: ${(excludedMessageFraction(facts) * 100).toFixed(2)}% of ` +
				"messages excluded by the completeness guard",
		};
	}
	if (spreadFloorFalsifierFired) {
		return {
			id: "C1",
			status: "no-verdict-force",
			observed: facts.spreadP99Ms,
			bound,
			reason: "V-SP: the Mac's sink drain floor was not established",
		};
	}
	if (facts.spreadP99Ms === null) {
		return {
			id: "C1",
			status: "no-verdict-force",
			observed: null,
			bound,
			reason: "no spread percentile in the artifact",
		};
	}
	const pass = facts.spreadP99Ms <= bound;
	return {
		id: "C1",
		status: pass ? "pass" : "fail",
		observed: facts.spreadP99Ms,
		bound,
		reason: `spread p99 ${facts.spreadP99Ms.toFixed(2)} ms vs ${bound.toFixed(2)} ms; wire floor ${floor.toFixed(2)} ms`,
	};
}

/* -------------------------------------------------------------------------- */
/* C2 — delivery                                                              */
/* -------------------------------------------------------------------------- */

export type DeliveryFacts = {
	/** Broadcast copies any subscriber received. */
	received: number;
	/** Messages the emitter issued. */
	messagesIssued: number;
	subscribers: number;
	/** Subscribers whose own delivery ratio cleared DELIVERY_FLOOR. */
	subscribersMeetingFloor: number;
	/** The single worst subscriber's ratio — disclosed either way (§C2b). */
	worstSubscriberRatio: number | null;
};

export function fleetDeliveryRatio(facts: DeliveryFacts): number | null {
	const expected = facts.messagesIssued * facts.subscribers;
	if (expected <= 0) return null;
	return facts.received / expected;
}

/** C2a. */
export function evaluateFleetDelivery(facts: DeliveryFacts): ClauseResult {
	const ratio = fleetDeliveryRatio(facts);
	if (ratio === null) {
		return {
			id: "C2a",
			status: "no-verdict-force",
			observed: null,
			bound: DELIVERY_FLOOR,
			reason: "no messages issued; the denominator is zero",
		};
	}
	return {
		id: "C2a",
		status: ratio >= DELIVERY_FLOOR ? "pass" : "fail",
		observed: ratio,
		bound: DELIVERY_FLOOR,
		reason: `fleet delivery ${ratio.toFixed(6)} vs ${DELIVERY_FLOOR}`,
	};
}

/**
 * C2b. The clause a fleet ratio hides: not "the feed dropped 0.2%" but "these
 * forty subscribers are systematically behind".
 */
export function evaluatePerSubscriberDelivery(
	facts: DeliveryFacts,
): ClauseResult {
	if (facts.subscribers <= 0) {
		return {
			id: "C2b",
			status: "no-verdict-force",
			observed: null,
			bound: PER_SUBSCRIBER_COHORT_FLOOR,
			reason: "no subscribers",
		};
	}
	const cohort = facts.subscribersMeetingFloor / facts.subscribers;
	const worst =
		facts.worstSubscriberRatio === null
			? "worst subscriber not reported"
			: `worst subscriber ${facts.worstSubscriberRatio.toFixed(6)}`;
	return {
		id: "C2b",
		status: cohort >= PER_SUBSCRIBER_COHORT_FLOOR ? "pass" : "fail",
		observed: cohort,
		bound: PER_SUBSCRIBER_COHORT_FLOOR,
		reason: `${(cohort * 100).toFixed(2)}% of subscribers cleared ${DELIVERY_FLOOR}; ${worst}`,
	};
}

/* -------------------------------------------------------------------------- */
/* C3 — probe RTT                                                             */
/* -------------------------------------------------------------------------- */

export type RttFacts = {
	rttP99Ms: number | null;
	/** Server dwell, reported beside the clause and never subtracted from it. */
	holdP99Ms: number | null;
};

export function evaluateRtt(facts: RttFacts): ClauseResult {
	if (facts.rttP99Ms === null) {
		return {
			id: "C3",
			status: "no-verdict-force",
			observed: null,
			bound: RTT_BOUND_MS,
			reason: "no RTT percentile in the artifact",
		};
	}
	const dwell =
		facts.holdP99Ms === null
			? "dwell not reported"
			: `server dwell p99 ${facts.holdP99Ms.toFixed(3)} ms (not subtracted)`;
	return {
		id: "C3",
		status: facts.rttP99Ms <= RTT_BOUND_MS ? "pass" : "fail",
		observed: facts.rttP99Ms,
		bound: RTT_BOUND_MS,
		reason: `raw RTT p99 ${facts.rttP99Ms.toFixed(3)} ms vs ${RTT_BOUND_MS} ms; ${dwell}`,
	};
}

/* -------------------------------------------------------------------------- */
/* C4 — the fleet is still the fleet                                          */
/* -------------------------------------------------------------------------- */

export type LivenessFacts = {
	sessionsActiveAtEnd: number;
	subscribers: number;
	sessionsLost: number;
};

export function evaluateLiveness(facts: LivenessFacts): ClauseResult {
	const ok =
		facts.sessionsActiveAtEnd === facts.subscribers && facts.sessionsLost === 0;
	return {
		id: "C4",
		status: ok ? "pass" : "fail",
		observed: facts.sessionsActiveAtEnd,
		bound: facts.subscribers,
		reason: `${facts.sessionsActiveAtEnd}/${facts.subscribers} active at arm end, ${facts.sessionsLost} lost`,
	};
}

/* -------------------------------------------------------------------------- */
/* C5 — the stage ledger closes                                               */
/* -------------------------------------------------------------------------- */

export type LedgerFacts = {
	broadcastsIssued: number;
	subscribers: number;
	sendAttempts: number;
	sendOk: number;
	sendWouldBlock: number;
	sendErrors: number;
};

export function ledgerResiduals(facts: LedgerFacts): {
	expectedResidual: number;
	outcomeResidual: number;
	tolerance: number;
} {
	const expected = facts.broadcastsIssued * facts.subscribers;
	const outcomes = facts.sendOk + facts.sendWouldBlock + facts.sendErrors;
	return {
		expectedResidual: Math.abs(facts.sendAttempts - expected),
		outcomeResidual: Math.abs(facts.sendAttempts - outcomes),
		tolerance: STAGE_RESIDUAL_FRACTION * facts.sendAttempts,
	};
}

export function evaluateLedger(facts: LedgerFacts): ClauseResult {
	const { expectedResidual, outcomeResidual, tolerance } =
		ledgerResiduals(facts);
	const worst = Math.max(expectedResidual, outcomeResidual);
	return {
		id: "C5",
		status: worst <= tolerance ? "pass" : "fail",
		observed: worst,
		bound: tolerance,
		reason:
			`attempts-vs-expected ${expectedResidual}, attempts-vs-outcomes ` +
			`${outcomeResidual}, tolerance ${tolerance.toFixed(1)}`,
	};
}

/* -------------------------------------------------------------------------- */
/* C6 — the emitter sourced the load                                          */
/* -------------------------------------------------------------------------- */

export type EmitterFacts = {
	emitted: number;
	messagesIssued: number;
	subscribers: number;
	/**
	 * Lag measured at the scheduler handoff — deadline to the instant the pass
	 * *begins*. Never measured across `await send(...)`; that was G3's defect 1.
	 */
	handoffLagP99Ms: number | null;
	sendEventsSkipped: number;
	sendErrors: number;
	rate: number;
};

export function emittedFraction(facts: EmitterFacts): number | null {
	const expected = facts.messagesIssued * facts.subscribers;
	if (expected <= 0) return null;
	return facts.emitted / expected;
}

export function evaluateEmitterHonesty(facts: EmitterFacts): ClauseResult {
	const fraction = emittedFraction(facts);
	if (fraction === null) {
		return {
			id: "C6",
			status: "no-verdict-force",
			observed: null,
			bound: EMITTED_FRACTION_FLOOR,
			reason: "no messages issued",
		};
	}
	const period = 1000 / facts.rate;
	const lagOk =
		facts.handoffLagP99Ms === null ? false : facts.handoffLagP99Ms < period;
	const pass = fraction >= EMITTED_FRACTION_FLOOR && lagOk;
	return {
		id: "C6",
		status: pass ? "pass" : "fail",
		observed: fraction,
		bound: EMITTED_FRACTION_FLOOR,
		reason:
			`emitted ${fraction.toFixed(4)} of expected; handoff lag p99 ` +
			`${facts.handoffLagP99Ms === null ? "absent" : facts.handoffLagP99Ms.toFixed(3)} ms ` +
			`vs the ${period.toFixed(1)} ms period; skipped ${facts.sendEventsSkipped}, ` +
			`errors ${facts.sendErrors}`,
	};
}

/* -------------------------------------------------------------------------- */
/* C7 — the JS-thread stall                                                   */
/* -------------------------------------------------------------------------- */

export type StallFacts = {
	arm: ArmId;
	/**
	 * p99 of the longest uninterrupted span the emitter held the JS thread per
	 * broadcast — A1's whole pass, A2's worst chunk, A3's one mirror call.
	 */
	passStallP99Ms: number | null;
	/** §6.6b's independent sampler, reported beside the clause, never for it. */
	loopLagP99Ms: number | null;
};

/**
 * C7. The bound is M1's own: the mirror's 10,000-target cap was derived from a
 * 1 ms JS-thread stall budget, so the gate holds the product to the sentence its
 * own cap comment makes.
 *
 * Note what this function will not do: it takes no per-arm bound. A1 is expected
 * to fail this clause at 3.3 ms (prereg P9) and giving A1 a softer bound would
 * turn a registered arithmetic consequence into a scoring convenience. §3.0
 * handles A1's failure where it belongs — in which arm carries the verdict.
 */
export function evaluateStall(facts: StallFacts): ClauseResult {
	const beside =
		facts.loopLagP99Ms === null
			? "loop lag not reported"
			: `loop lag p99 ${facts.loopLagP99Ms.toFixed(3)} ms (disclosure, not the clause)`;
	if (facts.passStallP99Ms === null) {
		return {
			id: "C7",
			status: "no-verdict-force",
			observed: null,
			bound: JS_STALL_BUDGET_MS,
			reason: `no pass-stall percentile for ${facts.arm}; ${beside}`,
		};
	}
	return {
		id: "C7",
		status: facts.passStallP99Ms <= JS_STALL_BUDGET_MS ? "pass" : "fail",
		observed: facts.passStallP99Ms,
		bound: JS_STALL_BUDGET_MS,
		reason:
			`${facts.arm} pass stall p99 ${facts.passStallP99Ms.toFixed(3)} ms vs ` +
			`the ${JS_STALL_BUDGET_MS} ms budget M1's cap was derived from; ${beside}`,
	};
}

export type MirrorStallStatement = {
	status: "measured" | "not-run";
	observedMs: number | null;
	/** The microbench floor — a lower bound, because the addon has no mutex. */
	floorMs: number;
	/** observed ÷ floor. P8 registers ≥ 2. */
	ratio: number | null;
	predictionHeld: boolean | null;
	reason: string;
};

/**
 * §9 P8, scored. The claim is about the *microbench*, not the product: a
 * fan-out addon with no connection mutex in it cannot price a call whose cost is
 * mutexes, so the landed mirror should stall by at least twice its floor.
 *
 * A ratio below 2 falsifies P8 and is the more interesting outcome — it would
 * mean the mutex is nearly free at this target count, which is a real finding
 * about `wtransport`'s locking and belongs to ticket 34, not to this gate.
 */
export function scoreMirrorStallPrediction(
	stall: StallFacts | undefined,
	subscribers = SUBSCRIBERS,
): MirrorStallStatement {
	const floorMs = mirrorStallFloorMs(subscribers);
	if (!stall || stall.arm !== "A3" || stall.passStallP99Ms === null) {
		return {
			status: "not-run",
			observedMs: null,
			floorMs,
			ratio: null,
			predictionHeld: null,
			reason:
				"the mirror arm did not run, or reported no pass-stall percentile",
		};
	}
	const ratio = stall.passStallP99Ms / floorMs;
	return {
		status: "measured",
		observedMs: stall.passStallP99Ms,
		floorMs,
		ratio,
		predictionHeld: ratio >= MIRROR_STALL_UNDERPRICING_FACTOR,
		reason:
			`A3 stalled ${stall.passStallP99Ms.toFixed(3)} ms against a ` +
			`${floorMs.toFixed(3)} ms mutex-free microbench floor (${ratio.toFixed(2)}x; ` +
			`P8 registered >= ${MIRROR_STALL_UNDERPRICING_FACTOR}x)`,
	};
}

/* -------------------------------------------------------------------------- */
/* §7 — the validity falsifiers                                               */
/* -------------------------------------------------------------------------- */

export type FalsifierId =
	| "V-C"
	| "V-M"
	| "V-S"
	| "V-SP"
	| "V-F"
	| "V-N"
	| "V-K"
	| "V-D"
	| "V-X"
	| "V-G"
	| "V-A"
	| "V-L"
	| "V-W";

/** The four that strip force from a named statement instead of killing the run. */
export const SOFT_FALSIFIERS: ReadonlySet<FalsifierId> = new Set<FalsifierId>([
	"V-SP",
	"V-X",
	"V-A",
	"V-L",
]);

export function invalidatesRun(id: FalsifierId): boolean {
	return !SOFT_FALSIFIERS.has(id);
}

export type PrecheckFacts = {
	/** ISO date of the artifact, and of the run. Must match — "same calendar day". */
	artifactDate: string | null;
	runDate: string;
	host: string | null;
	expectedHost: string;
};

function sameDayOnExpectedHost(facts: PrecheckFacts): string | null {
	if (facts.artifactDate === null) return "no artifact";
	if (facts.artifactDate !== facts.runDate) {
		return `artifact dated ${facts.artifactDate}, run ${facts.runDate}`;
	}
	if (facts.host !== facts.expectedHost) {
		return `artifact from host ${facts.host ?? "unknown"}, expected ${facts.expectedHost}`;
	}
	return null;
}

/** V-C. Ticket 29's STOP: no green same-day pre-flight, no run. */
export function cableFalsifier(
	facts: PrecheckFacts & { requirementsMet: Record<string, boolean> },
): { fires: boolean; reason: string } {
	const stale = sameDayOnExpectedHost(facts);
	if (stale) return { fires: true, reason: `V-C: ${stale}` };
	const failed = Object.entries(facts.requirementsMet)
		.filter(([, ok]) => !ok)
		.map(([name]) => name);
	if (failed.length > 0) {
		return {
			fires: true,
			reason: `V-C: requirement(s) failed: ${failed.join(", ")}`,
		};
	}
	return {
		fires: false,
		reason: "V-C: same-day pre-flight satisfies R-down and R-up",
	};
}

/** V-M. G1 proved 10k sessions on the runner; the Mac holding 10k is unproven. */
export function macSessionFalsifier(
	facts: PrecheckFacts & { sessionsEstablished: number; sessionsHeld: number },
	required = SUBSCRIBERS,
): { fires: boolean; reason: string } {
	const stale = sameDayOnExpectedHost(facts);
	if (stale) return { fires: true, reason: `V-M: ${stale}` };
	if (facts.sessionsEstablished < required || facts.sessionsHeld < required) {
		return {
			fires: true,
			reason: `V-M: Mac established ${facts.sessionsEstablished} and held ${facts.sessionsHeld} of ${required}`,
		};
	}
	return { fires: false, reason: `V-M: Mac held ${required} sessions` };
}

/** V-S. K12: nothing prior predicts the Mac's sink capability, in either direction. */
export function sinkFalsifier(
	facts: PrecheckFacts & {
		offeredPps: number;
		deliveryRatio: number | null;
		rate: number;
	},
): { fires: boolean; reason: string } {
	const stale = sameDayOnExpectedHost(facts);
	if (stale) return { fires: true, reason: `V-S: ${stale}` };
	const required = sinkPrecheckPps(facts.rate);
	if (facts.offeredPps < required) {
		return {
			fires: true,
			reason: `V-S: pre-check drove ${facts.offeredPps} pps, needs ${required}`,
		};
	}
	if (
		facts.deliveryRatio === null ||
		facts.deliveryRatio < SINK_DELIVERY_FLOOR
	) {
		return {
			fires: true,
			reason: `V-S: sink delivered ${facts.deliveryRatio ?? "nothing"} at ${required} pps, floor ${SINK_DELIVERY_FLOOR}`,
		};
	}
	return { fires: false, reason: `V-S: sink held ${required} pps` };
}

/**
 * V-SP as amended (Amendment 4). Without it the Mac's own receive-order
 * dispersion is indistinguishable from the server's fan-out, and the spread is
 * this gate's headline metric. The measurement is the burst probe
 * (`tools/offbox/burst-probe.ts`): the sender blasts the gate's impulse through
 * the real NIC and reports how long emission took; the sink reports how long
 * the drain took. A sink at wire pace attributes the day's spread to the
 * server+path; completeness is disclosed beside it, never bounded — the raw
 * probe has no transport, so its loss is the path's, not the sink's.
 */
export function spreadFloorFalsifier(
	facts: PrecheckFacts & {
		burstDrainP99Ms: number | null;
		burstEmitMaxMs: number | null;
		burstCompletenessMin: number | null;
	},
): { fires: boolean; reason: string } {
	const stale = sameDayOnExpectedHost(facts);
	if (stale) return { fires: true, reason: `V-SP: ${stale}` };
	if (facts.burstDrainP99Ms === null || facts.burstEmitMaxMs === null) {
		return { fires: true, reason: "V-SP: no same-day burst-probe artifact" };
	}
	const ceiling = sinkDrainCeilingMs(facts.burstEmitMaxMs);
	const completeness =
		facts.burstCompletenessMin === null
			? "undisclosed"
			: facts.burstCompletenessMin.toFixed(3);
	if (facts.burstDrainP99Ms > ceiling) {
		return {
			fires: true,
			reason:
				`V-SP: sink drain p99 ${facts.burstDrainP99Ms.toFixed(2)} ms vs ` +
				`${ceiling.toFixed(2)} ms (1.2 × emission max ${facts.burstEmitMaxMs.toFixed(2)} ms)`,
		};
	}
	return {
		fires: false,
		reason:
			`V-SP: sink at wire pace — drain p99 ${facts.burstDrainP99Ms.toFixed(2)} ms ≤ ` +
			`1.2 × emission max ${facts.burstEmitMaxMs.toFixed(2)} ms; ` +
			`completeness min ${completeness}, disclosed`,
	};
}

/** V-F. K11: a 40.6 ms lag maximum on an idle Mac is larger than the whole bound. */
export function probeFloorFalsifier(
	facts: PrecheckFacts & {
		scheduleLagP99Ms: number | null;
		scheduleLagMaxMs: number | null;
		drivingSessions: number;
	},
): { fires: boolean; reason: string } {
	const stale = sameDayOnExpectedHost(facts);
	if (stale) return { fires: true, reason: `V-F: ${stale}` };
	if (facts.drivingSessions <= 0) {
		return { fires: true, reason: "V-F: floor arm drove no sessions" };
	}
	const ceiling = probeFloorLagCeilingMs();
	if (facts.scheduleLagP99Ms === null || facts.scheduleLagP99Ms > ceiling) {
		return {
			fires: true,
			reason: `V-F: scheduleLag p99 ${facts.scheduleLagP99Ms ?? "absent"} ms vs ${ceiling} ms`,
		};
	}
	return {
		fires: false,
		reason:
			`V-F: scheduleLag p99 ${facts.scheduleLagP99Ms.toFixed(3)} ms ` +
			`(max ${facts.scheduleLagMaxMs === null ? "unreported" : facts.scheduleLagMaxMs.toFixed(3)} ms, disclosed)`,
	};
}

export type HistogramFacts = {
	name: string;
	count: number;
	recordedTotal: number;
	negative: number;
	/** What the run's own counters say was delivered on this path. */
	deliveredOnPath: number;
	/** Delivered datagrams that carried no decodable stamp. */
	unstamped: number;
};

/** V-N. Both ends of every measurement here are on one clock. */
export function negativeFalsifier(hists: HistogramFacts[]): {
	fires: boolean;
	reason: string;
} {
	const bad = hists.filter((h) => h.negative > 0);
	return bad.length > 0
		? {
				fires: true,
				reason: `V-N: negative samples in ${bad.map((h) => `${h.name}=${h.negative}`).join(", ")}`,
			}
		: { fires: false, reason: "V-N: no negative samples" };
}

/** V-K. G3b's second defect: percentiles over subsets of differing size. */
export function skewFalsifier(hists: HistogramFacts[]): {
	fires: boolean;
	reason: string;
} {
	const bad = hists.filter(
		(h) => h.recordedTotal - h.count > HISTOGRAM_SKEW_FRACTION * h.count,
	);
	return bad.length > 0
		? {
				fires: true,
				reason: `V-K: skew in ${bad.map((h) => `${h.name} ${h.recordedTotal}/${h.count}`).join(", ")}`,
			}
		: { fires: false, reason: "V-K: every histogram recorded what it counted" };
}

/** V-D. The same defect, stated as an equality the artifact must satisfy. */
export function denominatorFalsifier(hists: HistogramFacts[]): {
	fires: boolean;
	reason: string;
} {
	const bad = hists.filter((h) => h.count !== h.deliveredOnPath - h.unstamped);
	return bad.length > 0
		? {
				fires: true,
				reason: `V-D: ${bad.map((h) => `${h.name} count=${h.count} vs delivered-unstamped=${h.deliveredOnPath - h.unstamped}`).join(", ")}`,
			}
		: { fires: false, reason: "V-D: every percentile spans its own path" };
}

/** V-G. The Mac is a new generator host. */
export function generatorFalsifier(offeredRatios: number[]): {
	fires: boolean;
	reason: string;
} {
	const worst = offeredRatios.length === 0 ? null : Math.min(...offeredRatios);
	if (worst === null) return { fires: true, reason: "V-G: no offered ratios" };
	return worst < OFFERED_RATIO_FLOOR
		? { fires: true, reason: `V-G: worst offeredRatio ${worst.toFixed(4)}` }
		: { fires: false, reason: `V-G: worst offeredRatio ${worst.toFixed(4)}` };
}

/**
 * V-A. K5, exactly: G3b's arms were incomparable because their scheduler lag
 * differed 2.28–3.85×. Firing strips force from arm *comparisons* only; every
 * per-arm absolute clause stands.
 */
export function armComparabilityFalsifier(
	perArm: Array<{
		arm: ArmId;
		probeLagP99Ms: number | null;
		emitterLagP99Ms: number | null;
	}>,
): { fires: boolean; reason: string; spread: number | null } {
	const spreadOf = (values: Array<number | null>): number | null => {
		const present = values.filter((v): v is number => v !== null && v > 0);
		if (present.length < 2) return null;
		return Math.max(...present) / Math.min(...present);
	};
	const probe = spreadOf(perArm.map((a) => a.probeLagP99Ms));
	const emitter = spreadOf(perArm.map((a) => a.emitterLagP99Ms));
	const worst = Math.max(probe ?? 0, emitter ?? 0);
	if (perArm.length < 2) {
		return {
			fires: false,
			reason: "V-A: fewer than two arms; nothing compared",
			spread: null,
		};
	}
	if (probe === null && emitter === null) {
		return {
			fires: true,
			reason: "V-A: no lag percentiles to compare arms with",
			spread: null,
		};
	}
	return worst > ARM_LAG_SPREAD_LIMIT
		? {
				fires: true,
				reason: `V-A: lag p99 spread ${worst.toFixed(2)}x across arms (limit ${ARM_LAG_SPREAD_LIMIT}x)`,
				spread: worst,
			}
		: {
				fires: false,
				reason: `V-A: lag p99 spread ${worst.toFixed(2)}x across arms`,
				spread: worst,
			};
}

/**
 * V-L. The loop-lag sampler's own liveness.
 *
 * A sampler that was starved out reports percentiles over the ticks it happened
 * to get — the same self-selection defect V-D exists for, one level down. Soft,
 * because it strips force from a *disclosure*: C7 reads `passStallNs`, a
 * different instrument, and is untouched by this.
 */
/**
 * V-W. The subscriber fleet outlived the rung's pre-registered deadline and the
 * conductor killed it (ticket 01's formula: drive + stagger + settle + margin).
 *
 * This is a hard falsifier for the reason it is easy to get wrong: killing the
 * fleet quiesces the server instantly, so every settle-shaped check passes on a
 * window that was cut short. A rung that fires V-W is not a slow rung, it is
 * not a rung with a caveat, and it is never a number.
 */
export function deadlineFalsifier(breached: boolean): {
	fires: boolean;
	reason: string;
} {
	return breached
		? {
				fires: true,
				reason:
					"V-W: the subscriber fleet was killed at its deadline, so this rung's window is truncated and every counter under it is partial",
			}
		: { fires: false, reason: "V-W: the fleet exited inside its deadline" };
}

export function loopLagSamplerFalsifier(facts: {
	ticksRecorded: number;
	windowSeconds: number;
}): { fires: boolean; reason: string } {
	const expected = expectedLoopLagTicks(facts.windowSeconds);
	if (expected <= 0) {
		return { fires: true, reason: "V-L: the window implies no sampler ticks" };
	}
	const fraction = facts.ticksRecorded / expected;
	return fraction < LOOP_LAG_MIN_TICK_FRACTION
		? {
				fires: true,
				reason: `V-L: sampler recorded ${facts.ticksRecorded}/${expected} ticks (${(fraction * 100).toFixed(1)}%)`,
			}
		: {
				fires: false,
				reason: `V-L: sampler recorded ${facts.ticksRecorded}/${expected} ticks`,
			};
}

/* -------------------------------------------------------------------------- */
/* §3.0 — which arm carries the verdict                                       */
/* -------------------------------------------------------------------------- */

export type ArmClauses = { arm: ArmId; clauses: ClauseResult[] };

export type GateVerdict = {
	verdict: "pass" | "fail" | "no-verdict";
	/** Always A2 — §3.0, and there is no parameter for choosing another. */
	arm: ArmId;
	failed: ClauseId[];
	reason: string;
};

/**
 * §3.0. The gate's verdict is the clause set at the gate rung on A2.
 *
 * A1's results are a characterization of an emitter no production server should
 * write — it is 3.4x over M1's stall budget by arithmetic before the run — and
 * A3's are the lever's statement. Both are published; neither decides. The
 * function takes no arm parameter for the same reason `leverStatement` takes no
 * baseline parameter: the choice was registered, so the code should not offer it.
 *
 * `not-applicable` never fails a gate (R = 20's spread clause is unsatisfiable by
 * arithmetic, §1.6) and neither does `no-verdict-force` — but a run with any
 * force-stripped clause on the verdict arm reports `no-verdict` rather than
 * quietly passing on the clauses that survived.
 */
export function gateVerdict(arms: ArmClauses[]): GateVerdict {
	const verdictArm = arms.find((a) => a.arm === VERDICT_ARM);
	if (!verdictArm) {
		return {
			verdict: "no-verdict",
			arm: VERDICT_ARM,
			failed: [],
			reason: `the verdict arm ${VERDICT_ARM} did not run`,
		};
	}
	const failed = verdictArm.clauses
		.filter((c) => c.status === "fail")
		.map((c) => c.id);
	const stripped = verdictArm.clauses
		.filter((c) => c.status === "no-verdict-force")
		.map((c) => c.id);
	if (failed.length > 0) {
		return {
			verdict: "fail",
			arm: VERDICT_ARM,
			failed,
			reason: `${VERDICT_ARM} missed ${failed.join(", ")}`,
		};
	}
	if (stripped.length > 0) {
		return {
			verdict: "no-verdict",
			arm: VERDICT_ARM,
			failed: [],
			reason: `${VERDICT_ARM} carries force-stripped clause(s): ${stripped.join(", ")}`,
		};
	}
	return {
		verdict: "pass",
		arm: VERDICT_ARM,
		failed: [],
		reason: `${VERDICT_ARM} cleared every applicable clause`,
	};
}

/* -------------------------------------------------------------------------- */
/* §2.4 — the anti-inflation rule, as an equation the code enforces           */
/* -------------------------------------------------------------------------- */

export type ArmSpread = { arm: ArmId; spreadP99Ms: number | null };

export type LeverStatement = {
	status: "measured" | "not-run" | "no-verdict-force" | "unavailable";
	/** A3 − A2, in ms. Positive means the mirror was faster. */
	gainMs: number | null;
	comparand: "A2";
	reason: string;
};

/**
 * The lever's value is `A3 − A2`, never `A3 − A1`, and never against the retired
 * per-target promise path. A2 is what a production server would otherwise ship,
 * so A2 is the only honest comparand; quoting the mirror against the promise
 * path would credit it with a saving the landed tree already banked (K16).
 *
 * The function refuses to compute anything else — there is no parameter for
 * choosing the baseline.
 */
export function leverStatement(
	arms: ArmSpread[],
	armComparabilityFired = false,
): LeverStatement {
	const a2 = arms.find((a) => a.arm === "A2");
	const a3 = arms.find((a) => a.arm === "A3");
	if (!a3) {
		return {
			status: "not-run",
			gainMs: null,
			comparand: "A2",
			reason:
				"the mirror arm did not run; the gate ran with two arms (prereg §2.3)",
		};
	}
	if (!a2 || a2.spreadP99Ms === null || a3.spreadP99Ms === null) {
		return {
			status: "unavailable",
			gainMs: null,
			comparand: "A2",
			reason: "A2 or A3 has no spread percentile",
		};
	}
	const gain = a2.spreadP99Ms - a3.spreadP99Ms;
	if (armComparabilityFired) {
		return {
			status: "no-verdict-force",
			gainMs: gain,
			comparand: "A2",
			reason: "V-A fired; the arms are not comparable",
		};
	}
	return {
		status: "measured",
		gainMs: gain,
		comparand: "A2",
		reason: `A2 ${a2.spreadP99Ms.toFixed(2)} ms − A3 ${a3.spreadP99Ms.toFixed(2)} ms`,
	};
}
