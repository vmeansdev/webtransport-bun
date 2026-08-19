/**
 * Every clause and falsifier driven against the signature it exists to reject.
 *
 * G3b's V1 lived only in a hand derivation until the run it should have caught
 * was already stamped. Nothing in G9 is allowed to be in that position: each
 * rule below is fed the shape it is supposed to fire on, and the shape it is
 * supposed to ignore.
 */

import { describe, expect, test } from "bun:test";
import {
	type AcceptFacts,
	type BaseHealthFacts,
	type CompletenessFacts,
	clauseC1,
	clauseC2,
	clauseC3,
	clauseC4,
	clauseC5,
	clauseC6,
	clauseLimiter,
	falsifierBaseTier,
	falsifierExchangeReality,
	falsifierFloor,
	falsifierGenerator,
	falsifierKernelTaps,
	falsifierLittleGenerator,
	falsifierLittleServer,
	falsifierMaxSessions,
	falsifierPacing,
	falsifierSpanConsistency,
	type HandshakeFacts,
	type HistogramFacts,
	type LeakFacts,
	licensedRung,
	MIN_SAMPLES_FOR_P99,
	RATE_LIMIT_ENTRY_BOUND,
	rollUp,
	type TeardownFacts,
} from "./g9-classify.ts";
import {
	BASE_SESSIONS,
	handshakeBarMs,
	limiterExpectedAdmits,
	scheduleLagBoundMs,
	undividedSetupBudgetMs,
} from "./g9-plan.ts";

const ms = (n: number) => n * 1e6;

function hist(p99Ms: number, count = 10_000): HistogramFacts {
	return {
		count,
		p50Ns: ms(p99Ms / 3),
		p99Ns: ms(p99Ms),
		maxNs: ms(p99Ms * 2),
		negativeSamples: 0,
	};
}

/* -------------------------------------------------------------------------- */

describe("histogram validity", () => {
	test("a thin histogram cannot carry a p99", () => {
		const c3 = clauseC3({
			connect: hist(10, MIN_SAMPLES_FOR_P99 - 1),
			serverPartialSpanP99Ns: null,
			arrivalLagP99Ns: null,
		});
		expect(c3.verdict).toBe("INCOMPLETE");
	});

	test("one negative sample distrusts the whole histogram", () => {
		const h = hist(10);
		h.negativeSamples = 1;
		const c3 = clauseC3({
			connect: h,
			serverPartialSpanP99Ns: null,
			arrivalLagP99Ns: null,
		});
		expect(c3.verdict).toBe("INCOMPLETE");
		expect(c3.reasons.join(" ")).toContain("not on one clock");
	});
});

describe("C1 completeness", () => {
	const ok: CompletenessFacts = {
		cellId: "L-600",
		repeatsPresent: 2,
		repeatsRequired: 2,
		exitCodes: [0, 0],
		hostCpuPctMedian: 210,
		incompleteBuckets: [],
	};

	test("passes on a clean cell", () => {
		expect(clauseC1(ok).verdict).toBe("PASS");
	});

	test("a saturated host is NO-VERDICT, not a miss", () => {
		// 90% of 400 on a 4 vCPU box.
		const r = clauseC1({ ...ok, hostCpuPctMedian: 361 });
		expect(r.verdict).toBe("INCOMPLETE");
		expect(r.reasons.join(" ")).toContain("saturated");
	});

	test("an unreadable host CPU is INCOMPLETE, never assumed clean", () => {
		expect(clauseC1({ ...ok, hostCpuPctMedian: null }).verdict).toBe(
			"INCOMPLETE",
		);
	});

	test("a missing repeat is INCOMPLETE", () => {
		expect(clauseC1({ ...ok, repeatsPresent: 1 }).verdict).toBe("INCOMPLETE");
	});
});

describe("C2 sustained accept rate", () => {
	const ok: AcceptFacts = {
		offeredRatePerSec: 600,
		steadySec: 120,
		serverAcceptsInSteadyWindow: 72_000,
		limitExceededDelta: 0,
		rateLimitedDelta: 0,
	};

	test("passes when the server accepted what was offered", () => {
		expect(clauseC2(ok).verdict).toBe("PASS");
	});

	test("the 1% band is exactly where the edge is", () => {
		expect(
			clauseC2({ ...ok, serverAcceptsInSteadyWindow: 71_280 }).verdict,
		).toBe("PASS");
		expect(
			clauseC2({ ...ok, serverAcceptsInSteadyWindow: 71_279 }).verdict,
		).toBe("MISS");
	});

	test("a limiter engaging below its derived boundary is a MISS, deliberately not INCOMPLETE", () => {
		const r = clauseC2({ ...ok, rateLimitedDelta: 3 });
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("47% of its aggregate ceiling");
	});

	test("the admission gate refusing is likewise a MISS with the counter named", () => {
		const r = clauseC2({ ...ok, limitExceededDelta: 11 });
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("limitExceeded");
	});
});

describe("C3 handshake tail", () => {
	const base: HandshakeFacts = {
		connect: hist(120),
		serverPartialSpanP99Ns: ms(30),
		arrivalLagP99Ns: ms(0.4),
	};

	test("passes under the 300 ms bar", () => {
		const r = clauseC3(base);
		expect(r.verdict).toBe("PASS");
		expect(r.observed.barMs).toBe(300);
	});

	test("misses over it", () => {
		expect(clauseC3({ ...base, connect: hist(301) }).verdict).toBe("MISS");
	});

	test("a miss inside the undivided budget is flagged, and is still a miss", () => {
		const r = clauseC3({ ...base, connect: hist(400) });
		expect(r.verdict).toBe("MISS");
		expect(r.flags?.undividedBudgetWouldPass).toBe(true);
		expect(r.observed.undividedBudgetMs).toBe(undividedSetupBudgetMs());
	});

	test("a miss beyond the undivided budget is not flagged", () => {
		const r = clauseC3({ ...base, connect: hist(700) });
		expect(r.flags?.undividedBudgetWouldPass).toBe(false);
	});

	test("a pass is never flagged", () => {
		expect(clauseC3(base).flags?.undividedBudgetWouldPass).toBe(false);
	});

	test("the cert/TLS share is recorded as the difference between the two spans", () => {
		const r = clauseC3(base);
		expect(r.observed.handshakeShareOutsideServerSpanMs).toBeCloseTo(90, 6);
	});

	test("the generator's lag is published and never subtracted from the bar", () => {
		// A connect p99 one hair over the bar stays a miss however small the lag.
		const r = clauseC3({
			...base,
			connect: hist(handshakeBarMs() + 1),
			arrivalLagP99Ns: ms(50),
		});
		expect(r.verdict).toBe("MISS");
		expect(r.observed.arrivalLagP99Ms).toBe(50);
	});
});

describe("C4 base health", () => {
	const ok: BaseHealthFacts = {
		baseSessions: BASE_SESSIONS,
		rtt: hist(12),
		clientEnqueued: 240_000,
		serverRx: 239_800,
		sessionsLost: 0,
	};

	test("passes a healthy base", () => {
		expect(clauseC4(ok).verdict).toBe("PASS");
	});

	test("misses over the 40 ms bar", () => {
		expect(clauseC4({ ...ok, rtt: hist(41) }).verdict).toBe("MISS");
	});

	test("misses under the delivery floor", () => {
		expect(clauseC4({ ...ok, serverRx: 238_000 }).verdict).toBe("MISS");
	});

	test("one lost base session is a miss", () => {
		expect(clauseC4({ ...ok, sessionsLost: 1 }).verdict).toBe("MISS");
	});

	test("a cell with no base is out of scope, not a pass", () => {
		expect(clauseC4(null).verdict).toBe("INCOMPLETE");
		expect(clauseC4({ ...ok, baseSessions: 0 }).verdict).toBe("INCOMPLETE");
	});
});

describe("C5 leaked sessions and handles", () => {
	const clean: LeakFacts = {
		acceptsTotal: 72_400,
		sessionsActiveAtSettleEnd: BASE_SESSIONS,
		closedByIdle: 0,
		closedByReap: 0,
		closedOther: 72_200,
		closedByIdleDuringChurn: 0,
		nativeAsyncOpsPendingAfterClose: 0,
		nativeAsyncOpsPendingAtSettle: 78,
		nativeBidiHandlesLive: 0,
		nativeUniSendHandlesLive: 0,
		nativeUniRecvHandlesLive: 0,
		nativeSessionRegistryEntries: BASE_SESSIONS,
		nativeRateLimitEntries: 324,
		baseCohortAliveAtSettle: BASE_SESSIONS,
		registrySlopePerSec: 0.001,
		steadySec: 120,
	};

	test("passes when the ledger closes and nothing is live", () => {
		expect(clauseC5(clean).verdict).toBe("PASS");
	});

	test("a ledger that does not close is a miss, even by one session", () => {
		const r = clauseC5({ ...clean, closedOther: 72_199 });
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("ledger does not close");
	});

	test("one unsettled N-API op AFTER close is a miss — ticket 03's instrument", () => {
		expect(
			clauseC5({ ...clean, nativeAsyncOpsPendingAfterClose: 1 }).verdict,
		).toBe("MISS");
	});

	test("pending ops at the settle sample are the LIVE base tier, and never a bar", () => {
		// The local smoke read 78 on a perfectly clean cell: 39 live base
		// sessions each holding an in-flight read future. A zero bar here would
		// have been unmeetable by construction.
		expect(
			clauseC5({ ...clean, nativeAsyncOpsPendingAtSettle: 4_000 }).verdict,
		).toBe("PASS");
	});

	test("one live bidi handle is a miss, which is why the exchange is a stream", () => {
		expect(clauseC5({ ...clean, nativeBidiHandlesLive: 1 }).verdict).toBe(
			"MISS",
		);
	});

	test("a churn session reaped by the idle timeout is abandonment, not tidiness", () => {
		const r = clauseC5({ ...clean, closedByIdleDuringChurn: 4 });
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("abandoned, not closed");
	});

	test("rate-limiter entries are bounded and NOT expected to be zero (P4)", () => {
		expect(clauseC5({ ...clean, nativeRateLimitEntries: 0 }).verdict).toBe(
			"PASS",
		);
		expect(
			clauseC5({ ...clean, nativeRateLimitEntries: RATE_LIMIT_ENTRY_BOUND })
				.verdict,
		).toBe("PASS");
		expect(
			clauseC5({
				...clean,
				nativeRateLimitEntries: RATE_LIMIT_ENTRY_BOUND + 1,
			}).verdict,
		).toBe("MISS");
	});

	test("an unreadable counter is INCOMPLETE and is never booked as its expected value", () => {
		const r = clauseC5({ ...clean, nativeAsyncOpsPendingAfterClose: null });
		expect(r.verdict).toBe("INCOMPLETE");
		expect(r.reasons.join(" ")).toContain("not booked as 0");
	});

	test("registry drift under one session across the window passes; at one it does not", () => {
		expect(clauseC5({ ...clean, registrySlopePerSec: 0.008 }).verdict).toBe(
			"PASS",
		);
		expect(clauseC5({ ...clean, registrySlopePerSec: 1 / 120 }).verdict).toBe(
			"MISS",
		);
	});

	test("negative drift is not a leak and is clamped, not counted", () => {
		expect(clauseC5({ ...clean, registrySlopePerSec: -5 }).verdict).toBe(
			"PASS",
		);
	});

	test("the registry disagreeing with the active count is a miss", () => {
		expect(
			clauseC5({ ...clean, nativeSessionRegistryEntries: BASE_SESSIONS + 3 })
				.verdict,
		).toBe("MISS");
	});

	test("a churn session still registered after the settle is a miss", () => {
		const r = clauseC5({
			...clean,
			sessionsActiveAtSettleEnd: BASE_SESSIONS + 2,
			nativeSessionRegistryEntries: BASE_SESSIONS + 2,
			closedOther: 72_198,
		});
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("churn session(s) still registered");
	});

	test("a base tier that fell short is NOT a leak — the registry follows the server", () => {
		// The generator established 39 of its 200. C5 compares the registry to
		// what the server holds, so it passes; V-B is what makes the cell
		// INCOMPLETE.
		expect(
			clauseC5({
				...clean,
				sessionsActiveAtSettleEnd: 39,
				nativeSessionRegistryEntries: 39,
				baseCohortAliveAtSettle: 39,
				closedOther: 72_361,
			}).verdict,
		).toBe("PASS");
	});
});

describe("C6 teardown", () => {
	const ok: TeardownFacts = {
		cyclesCompleted: 72_000,
		clientCloseErrors: 0,
		serverStreamErrors: 0,
		serverStreamsAccepted: 72_000,
		serverStreamsCompleted: 72_000,
	};

	test("passes when every cycle's stream opened and finished", () => {
		expect(clauseC6(ok).verdict).toBe("PASS");
	});

	test("a stream accepted but never completed is a miss", () => {
		expect(clauseC6({ ...ok, serverStreamsCompleted: 71_999 }).verdict).toBe(
			"MISS",
		);
	});

	test("one close error is a miss", () => {
		expect(clauseC6({ ...ok, clientCloseErrors: 1 }).verdict).toBe("MISS");
	});
});

describe("LIM configuration fidelity", () => {
	test("the shipped bucket's own arithmetic passes", () => {
		const r = clauseLimiter({
			windowSec: 60,
			serverAcceptsInWindow: limiterExpectedAdmits(60),
			rateLimitedDelta: 34_000,
			limitExceededDelta: 0,
		});
		expect(r.verdict).toBe("PASS");
		expect(r.observed.expected).toBe(1240);
	});

	test("admitting far more than configured is a miss", () => {
		expect(
			clauseLimiter({
				windowSec: 60,
				serverAcceptsInWindow: 36_000,
				rateLimitedDelta: 10,
				limitExceededDelta: 0,
			}).verdict,
		).toBe("MISS");
	});

	test("a bucket that never engaged measured nothing", () => {
		const r = clauseLimiter({
			windowSec: 60,
			serverAcceptsInWindow: 1240,
			rateLimitedDelta: 0,
			limitExceededDelta: 0,
		});
		expect(r.verdict).toBe("MISS");
		expect(r.reasons.join(" ")).toContain("did not engage");
	});

	test("the concurrency cap answering instead is INCOMPLETE — a different mechanism", () => {
		const r = clauseLimiter({
			windowSec: 60,
			serverAcceptsInWindow: 1240,
			rateLimitedDelta: 100,
			limitExceededDelta: 7,
		});
		expect(r.verdict).toBe("INCOMPLETE");
		expect(r.reasons.join(" ")).toContain("concurrency cap answered");
	});
});

/* -------------------------------------------------------------------------- */
/* Falsifiers                                                                 */
/* -------------------------------------------------------------------------- */

describe("V-P — the arrival clock", () => {
	const honest = {
		arrivalsIssued: 72_000,
		offeredRatePerSec: 600,
		steadySec: 120,
		cyclesCompleted: 71_940,
		meanCycleSec: 0.4,
		inFlightHighWater: 310,
	};

	test("a cumulative-deadline clock does not fire it", () => {
		expect(falsifierPacing(honest).fired).toBe(false);
	});

	test("arrivals tracking completions is steady state, NOT a pool — it must not fire", () => {
		// The rule this module briefly shipped fired here, on a perfectly honest
		// arm. At steady state arrivals and completions are equal by definition.
		expect(
			falsifierPacing({ ...honest, cyclesCompleted: honest.arrivalsIssued })
				.fired,
		).toBe(false);
	});

	test("a real pool fires it, and the annotation names the mechanism", () => {
		// A pool of 100 permits with a 0.4 s cycle throughputs 250/s, not 600/s,
		// and pins in-flight at 100. Both facts are what a pool looks like.
		const r = falsifierPacing({
			arrivalsIssued: 30_000,
			offeredRatePerSec: 600,
			steadySec: 120,
			cyclesCompleted: 30_000,
			meanCycleSec: 0.4,
			inFlightHighWater: 100,
		});
		expect(r.fired).toBe(true);
		expect(r.observed.poolBound).toBe(true);
		expect(r.reasons.join(" ")).toContain("permit-pool mechanism");
		expect(r.scope).toBe("run");
	});

	test("the annotation stays silent when the clock was met — it never fires alone", () => {
		const r = falsifierPacing({ ...honest, inFlightHighWater: 240 });
		expect(r.fired).toBe(false);
		expect(r.observed.poolBound).toBe(false);
	});

	test("a serialized loop fires it — one in flight where hundreds were due", () => {
		const r = falsifierPacing({ ...honest, inFlightHighWater: 1 });
		expect(r.fired).toBe(true);
		expect(r.reasons.join(" ")).toContain("serialized on completion");
	});

	test("running ahead of the clock fires it — the pacer cannot overshoot", () => {
		expect(falsifierPacing({ ...honest, arrivalsIssued: 80_000 }).fired).toBe(
			true,
		);
	});

	test("a blocked clock fires it, and says the rate label is a completion rate", () => {
		const r = falsifierPacing({ ...honest, arrivalsIssued: 60_000 });
		expect(r.fired).toBe(true);
		expect(r.reasons.join(" ")).toContain("completion rate");
	});

	test("at a rung where under one cycle is in flight the two completion rules stand down", () => {
		// Nothing distinguishes a pool from an empty pipeline here, so the rule
		// must not claim to.
		const r = falsifierPacing({
			arrivalsIssued: 1200,
			offeredRatePerSec: 10,
			steadySec: 120,
			cyclesCompleted: 1200,
			meanCycleSec: 0.05,
			inFlightHighWater: 1,
		});
		expect(r.fired).toBe(false);
	});
});

describe("V-L — the two Little's-law readings", () => {
	test("the retraction's own numbers fire the generator reading", () => {
		// 625 accepts/s x 0.8 s mean = 500, the generator's permit pool.
		const r = falsifierLittleGenerator({
			acceptRatePerSec: 625,
			clientMeanConnectSec: 0.8,
			connectConcurrency: 500,
		});
		expect(r.fired).toBe(true);
		expect(r.scope).toBe("characterization");
		expect(r.reasons.join(" ")).toContain("measuring itself");
	});

	test("no pool means the rule cannot fire — the registered configuration", () => {
		expect(
			falsifierLittleGenerator({
				acceptRatePerSec: 625,
				clientMeanConnectSec: 0.8,
				connectConcurrency: null,
			}).fired,
		).toBe(false);
	});

	test("the server reading is a FINDING, not a fault, and names the shipped gate", () => {
		// 600/s x 0.333 s = 200 = max_handshakes_in_flight.
		const r = falsifierLittleServer({
			acceptRatePerSec: 600,
			serverMeanHandshakeSpanSec: 0.3333,
		});
		expect(r.fired).toBe(true);
		expect(r.scope).toBe("finding");
		expect(r.reasons.join(" ")).toContain("admissionGateBinding");
	});

	test("a run comfortably inside the gate does not raise the finding", () => {
		expect(
			falsifierLittleServer({
				acceptRatePerSec: 300,
				serverMeanHandshakeSpanSec: 0.05,
			}).fired,
		).toBe(false);
	});

	test("a finding never voids anything, however loudly it fires", () => {
		const v = rollUp(
			[
				clauseC6({
					cyclesCompleted: 1,
					clientCloseErrors: 0,
					serverStreamErrors: 0,
					serverStreamsAccepted: 1,
					serverStreamsCompleted: 1,
				}),
			],
			[
				falsifierLittleServer({
					acceptRatePerSec: 600,
					serverMeanHandshakeSpanSec: 0.3333,
				}),
			],
		);
		expect(v.verdict).toBe("PASS");
	});
});

describe("V-F — the generator floor", () => {
	const day = "2026-08-19T10:00:00.000Z";
	const ok = {
		scheduleLagP99Ms: 0.4,
		scheduleLagMaxMs: 8.2,
		boundMs: scheduleLagBoundMs(),
		floorArmDateIso: day,
		runDateIso: day,
		generatorHostMatches: true,
		drivingSessions: 20,
	};

	test("a clean same-day floor does not fire", () => {
		expect(falsifierFloor(ok).fired).toBe(false);
	});

	test("a lag p99 over one tenth of a shard interval fires", () => {
		expect(falsifierFloor({ ...ok, scheduleLagP99Ms: 1.4 }).fired).toBe(true);
	});

	test("yesterday's floor is refused", () => {
		expect(
			falsifierFloor({ ...ok, floorArmDateIso: "2026-08-18T22:00:00.000Z" })
				.fired,
		).toBe(true);
	});

	test("another host's floor is refused", () => {
		expect(falsifierFloor({ ...ok, generatorHostMatches: false }).fired).toBe(
			true,
		);
	});

	test("a floor arm that drove nothing measured nothing", () => {
		expect(falsifierFloor({ ...ok, drivingSessions: 0 }).fired).toBe(true);
	});

	test("no floor at all is refused rather than assumed clean", () => {
		expect(falsifierFloor({ ...ok, scheduleLagP99Ms: null }).fired).toBe(true);
	});
});

describe("V-B — the base tier has to exist before anything can be said about it", () => {
	test("a base tier that reached its population does not fire", () => {
		expect(
			falsifierBaseTier({
				configuredBaseSessions: 200,
				serverObservedBaseCohort: 200,
			}).fired,
		).toBe(false);
	});

	test("the local smoke's collapsed pool fires it, as INCOMPLETE and not a miss", () => {
		const r = falsifierBaseTier({
			configuredBaseSessions: 200,
			serverObservedBaseCohort: 70,
		});
		expect(r.fired).toBe(true);
		expect(r.scope).toBe("cell");
		expect(r.reasons.join(" ")).toContain("never reached its population");
	});

	test("a cell that carries no base cannot fire it", () => {
		expect(
			falsifierBaseTier({
				configuredBaseSessions: 0,
				serverObservedBaseCohort: 0,
			}).fired,
		).toBe(false);
	});
});

describe("V-G, V-M, V-C, V-S, V-K", () => {
	test("V-G: a bound generator is INCOMPLETE, never a miss", () => {
		const r = falsifierGenerator({ clientCpuPctOfOwnCores: 96 });
		expect(r.fired).toBe(true);
		expect(r.scope).toBe("cell");
	});

	test("V-G: unreadable generator CPU cannot rule saturation out", () => {
		expect(falsifierGenerator({ clientCpuPctOfOwnCores: null }).fired).toBe(
			true,
		);
	});

	test("V-M: a cycle longer than the ceiling means the arm measured max_sessions", () => {
		const r = falsifierMaxSessions({
			meanCycleSec: 3.0,
			offeredRatePerSec: 600,
			sessionsActivePeak: 1500,
		});
		expect(r.fired).toBe(true);
		expect(r.reasons.join(" ")).toContain("measuring max_sessions");
	});

	test("V-M: touching max_sessions fires independently of the mean", () => {
		expect(
			falsifierMaxSessions({
				meanCycleSec: 0.3,
				offeredRatePerSec: 600,
				sessionsActivePeak: 2000,
			}).fired,
		).toBe(true);
	});

	test("V-M: a short cycle well inside the budget does not fire", () => {
		expect(
			falsifierMaxSessions({
				meanCycleSec: 0.4,
				offeredRatePerSec: 600,
				sessionsActivePeak: 420,
			}).fired,
		).toBe(false);
	});

	test("V-C: a partial span larger than the full span it sits inside is impossible", () => {
		const r = falsifierSpanConsistency({
			serverPartialSpanP99Ns: ms(200),
			clientFullSpanP99Ns: ms(120),
		});
		expect(r.fired).toBe(true);
		expect(r.scope).toBe("cell");
	});

	test("V-C: the ordinary containment does not fire", () => {
		expect(
			falsifierSpanConsistency({
				serverPartialSpanP99Ns: ms(30),
				clientFullSpanP99Ns: ms(120),
			}).fired,
		).toBe(false);
	});

	test("V-S: a cycle counted complete with no server-side stream never crossed a network", () => {
		const r = falsifierExchangeReality({
			clientRequestBytesSent: 18_432_000,
			serverRequestBytesRead: 18_432_000,
			cyclesCompleted: 72_000,
			serverStreamsAccepted: 71_000,
		});
		expect(r.fired).toBe(true);
		expect(r.scope).toBe("run");
	});

	test("V-S: a byte mismatch fires too", () => {
		expect(
			falsifierExchangeReality({
				clientRequestBytesSent: 18_432_000,
				serverRequestBytesRead: 18_000_000,
				cyclesCompleted: 72_000,
				serverStreamsAccepted: 72_000,
			}).fired,
		).toBe(true);
	});

	test("V-K: a tap that never read but carries a number voids the run", () => {
		const r = falsifierKernelTaps([
			{ name: "serverSocketDrops", read: false, value: 0 },
		]);
		expect(r.fired).toBe(true);
		expect(r.scope).toBe("run");
	});

	test("V-K: a tap that never read and carries null is honest", () => {
		expect(
			falsifierKernelTaps([
				{ name: "serverSocketDrops", read: false, value: null },
			]).fired,
		).toBe(false);
	});
});

/* -------------------------------------------------------------------------- */
/* Roll-up and licensing                                                      */
/* -------------------------------------------------------------------------- */

describe("rollUp", () => {
	const allPass = [
		clauseC6({
			cyclesCompleted: 10,
			clientCloseErrors: 0,
			serverStreamErrors: 0,
			serverStreamsAccepted: 10,
			serverStreamsCompleted: 10,
		}),
	];

	test("clean clauses and no falsifier is a PASS", () => {
		expect(rollUp(allPass, []).verdict).toBe("PASS");
	});

	test("a run-scope falsifier stamps INVALID OVER clauses that all computed PASS", () => {
		// The exact reading G3b's classifier would have permitted.
		expect(allPass.every((c) => c.verdict === "PASS")).toBe(true);
		const v = rollUp(allPass, [
			falsifierPacing({
				arrivalsIssued: 30_000,
				offeredRatePerSec: 600,
				steadySec: 120,
				cyclesCompleted: 30_000,
				meanCycleSec: 0.4,
				inFlightHighWater: 100,
			}),
		]);
		expect(v.verdict).toBe("INVALID");
	});

	test("a cell-scope falsifier is NO-VERDICT, not a miss", () => {
		expect(
			rollUp(allPass, [falsifierGenerator({ clientCpuPctOfOwnCores: 99 })])
				.verdict,
		).toBe("NO-VERDICT");
	});

	test("a characterization falsifier strips verdict force without voiding", () => {
		const v = rollUp(allPass, [
			falsifierLittleGenerator({
				acceptRatePerSec: 625,
				clientMeanConnectSec: 0.8,
				connectConcurrency: 500,
			}),
		]);
		expect(v.verdict).toBe("PASS");
		expect(v.characterizationOnly).toBe(true);
	});

	test("INVALID outranks a clause miss", () => {
		const missing = clauseC6({
			cyclesCompleted: 10,
			clientCloseErrors: 4,
			serverStreamErrors: 0,
			serverStreamsAccepted: 10,
			serverStreamsCompleted: 10,
		});
		const v = rollUp(
			[missing],
			[
				falsifierKernelTaps([
					{ name: "serverSocketDrops", read: false, value: 0 },
				]),
			],
		);
		expect(v.verdict).toBe("INVALID");
	});
});

describe("§2.1 lower-rung licensing, decided before the run", () => {
	test("the highest passing rung is the whole licence", () => {
		const r = licensedRung(
			[
				{ ratePerSec: 75, verdict: "PASS" },
				{ ratePerSec: 150, verdict: "PASS" },
				{ ratePerSec: 300, verdict: "PASS" },
				{ ratePerSec: 600, verdict: "MISS" },
			],
			true,
		);
		expect(r.ratePerSec).toBe(300);
	});

	test("no rate above or between rungs is ever licensed", () => {
		const r = licensedRung(
			[
				{ ratePerSec: 300, verdict: "PASS" },
				{ ratePerSec: 600, verdict: "MISS" },
			],
			true,
		);
		expect(r.reason).toContain("no rate above or between rungs");
	});

	test("a leak licenses nothing, whatever the rates did", () => {
		const r = licensedRung(
			[
				{ ratePerSec: 300, verdict: "PASS" },
				{ ratePerSec: 600, verdict: "PASS" },
			],
			false,
		);
		expect(r.ratePerSec).toBeNull();
		expect(r.reason).toContain("not a capacity question");
	});

	test("an INVALID rung licenses nothing even when it is the only one", () => {
		expect(
			licensedRung([{ ratePerSec: 600, verdict: "INVALID" }], true).ratePerSec,
		).toBeNull();
	});
});
