/**
 * G11's clauses and falsifiers, exercised before the dispatch they adjudicate.
 *
 * Each falsifier is run against the exact signature it exists to reject, so
 * that none of them is discovered — after a run — to have been unmeetable, or
 * uncomputed, or quietly true on every input. That is G3b's bill, and this file
 * is how it is paid.
 */

import { describe, expect, test } from "bun:test";
import {
	type CouplingCellFacts,
	clausesForExchangeCell,
	clausesForTunnelCell,
	type ExchangeCellFacts,
	FAIRNESS_SPREAD_BAR,
	falsifiersForExchangeCell,
	falsifiersForTunnelCell,
	floorReportIsUsable,
	knobProvenanceHolds,
	meanBytesPerCrossing,
	readCouplingArm,
	readCouplingEnd,
	rollUpExchangeArm,
	rollUpTunnelGate,
	SCHEDULER_LAG_P99_BAR_MS,
	type StreamEnd,
	type TunnelCellFacts,
} from "./g11-classify.ts";
import {
	FRAME_BYTES,
	SHIPPED_QUEUED_BYTES_GLOBAL,
	SHIPPED_QUEUED_BYTES_PER_SESSION,
	TUNNEL_GATE_RUNG,
	tunnelRung,
} from "./g11-plan.ts";

const SESSIONS = TUNNEL_GATE_RUNG;
const WINDOW_SEC = 60;
const PER_DIRECTION_BYTES =
	tunnelRung(SESSIONS).bytesPerSecPerDirectionPerTunnel * SESSIONS * WINDOW_SEC;
const PER_SESSION_BYTES = PER_DIRECTION_BYTES / SESSIONS;

/** A cell that passes everything, so each test can break exactly one thing. */
function healthyCell(over: Partial<TunnelCellFacts> = {}): TunnelCellFacts {
	const perSession = Array.from({ length: SESSIONS }, () => PER_SESSION_BYTES);
	const frames = PER_DIRECTION_BYTES / FRAME_BYTES;
	return {
		cell: "T-100",
		sessions: SESSIONS,
		repeat: 1,
		knobBytes: 0,
		windowSec: WINDOW_SEC,
		runId: "run-1",
		host: "bench-1",
		offeredBytes: { up: PER_DIRECTION_BYTES, down: PER_DIRECTION_BYTES },
		deliveredBytes: { up: PER_DIRECTION_BYTES, down: PER_DIRECTION_BYTES },
		writtenBytes: { up: PER_DIRECTION_BYTES, down: PER_DIRECTION_BYTES },
		perSessionDeliveredBytes: { up: [...perSession], down: [...perSession] },
		oneWayP99Ms: { up: 4.1, down: 5.2 },
		oneWaySamples: { up: frames, down: frames },
		negativeSamples: { up: 0, down: 0 },
		streamErrors: 0,
		streamResets: 0,
		backpressureTimeouts: 0,
		streamsClosedBothHalves: SESSIONS,
		floor: {
			runId: "run-1",
			host: "bench-1",
			drivingSessions: SESSIONS,
			schedulerLagP99Ms: 1.2,
			schedulerLagMaxMs: 9.4,
			writeSettleP99Ms: 0.4,
			writeSettleMaxMs: 31.5,
		},
		hostCpuMedianPctOfBox: 58,
		clientCpuPctOfOneCore: 140,
		clientCpuCeilingPctOfOneCore: 400,
		serverCpuPctOfOneCore: 165,
		serverRssMb: 120,
		crossings: {
			server: {
				dataCrossings: frames,
				batchedCrossings: 0,
				terminalCrossings: SESSIONS,
				bytes: PER_DIRECTION_BYTES,
				maxBatchBytes: FRAME_BYTES,
			},
			client: {
				dataCrossings: frames,
				batchedCrossings: 0,
				terminalCrossings: SESSIONS,
				bytes: PER_DIRECTION_BYTES,
				maxBatchBytes: FRAME_BYTES,
			},
		},
		harnessServerReadCrossings: frames,
		serverSocketDrops: 0,
		rateLimitedCount: 0,
		limitExceededCount: 0,
		settled: true,
		deadlineBreached: false,
		maxQueuedBytesPerSession: SHIPPED_QUEUED_BYTES_PER_SESSION,
		maxQueuedBytesGlobal: SHIPPED_QUEUED_BYTES_GLOBAL,
		...over,
	};
}

function fired(facts: TunnelCellFacts): string[] {
	return falsifiersForTunnelCell(facts)
		.filter((f) => f.fired)
		.map((f) => f.id);
}

function failedClauses(facts: TunnelCellFacts): string[] {
	return clausesForTunnelCell(facts)
		.filter((c) => !c.pass)
		.map((c) => c.id);
}

describe("the healthy cell is healthy, or nothing else means anything", () => {
	test("no falsifier fires and no clause fails", () => {
		expect(fired(healthyCell())).toEqual([]);
		expect(failedClauses(healthyCell())).toEqual([]);
	});

	test("two healthy repeats roll up to PASS", () => {
		const roll = rollUpTunnelGate([
			healthyCell({ repeat: 1 }),
			healthyCell({ repeat: 2 }),
		]);
		expect(roll.verdict).toBe("PASS");
	});

	test("no repeats is INCOMPLETE, not PASS", () => {
		expect(rollUpTunnelGate([]).verdict).toBe("INCOMPLETE");
	});
});

describe("each falsifier rejects the signature it exists for (§4)", () => {
	test("V-G — a generator that cannot stamp inside the bar", () => {
		const facts = healthyCell();
		facts.floor.schedulerLagP99Ms = SCHEDULER_LAG_P99_BAR_MS + 0.1;
		expect(fired(facts)).toContain("V-G");
	});

	test("V-G2 — a floor borrowed from another run, host, or an idle cell", () => {
		expect(
			fired(healthyCell({ floor: { ...healthyCell().floor, runId: "run-0" } })),
		).toContain("V-G2");
		expect(
			fired(healthyCell({ floor: { ...healthyCell().floor, host: "mac" } })),
		).toContain("V-G2");
		expect(
			fired(
				healthyCell({
					floor: { ...healthyCell().floor, drivingSessions: 0 },
				}),
			),
		).toContain("V-G2");
	});

	test("V-P — a burst that overshot the virtual clock", () => {
		const facts = healthyCell();
		facts.offeredBytes.up = PER_DIRECTION_BYTES * 1.5;
		expect(fired(facts)).toContain("V-P/up");
	});

	test("V-P — and an under-offer that never reached the pace", () => {
		const facts = healthyCell();
		facts.offeredBytes.down = PER_DIRECTION_BYTES * 0.8;
		expect(fired(facts)).toContain("V-P/down");
	});

	test("V-N — a negative sample on a single clock is an instrument fault", () => {
		const facts = healthyCell();
		facts.negativeSamples.down = 1;
		expect(fired(facts)).toContain("V-N/down");
	});

	test("V-S — a saturated host", () => {
		expect(fired(healthyCell({ hostCpuMedianPctOfBox: 94 }))).toContain("V-S");
	});

	test("V-S2 — a pinned generator that also missed its offer", () => {
		const facts = healthyCell({
			clientCpuPctOfOneCore: 400,
			clientCpuCeilingPctOfOneCore: 400,
		});
		facts.offeredBytes.up = PER_DIRECTION_BYTES * 0.9;
		expect(fired(facts)).toContain("V-S2");
	});

	test("V-S2 — but not when the generator is pinned and still met the offer", () => {
		const facts = healthyCell({
			clientCpuPctOfOneCore: 400,
			clientCpuCeilingPctOfOneCore: 400,
		});
		expect(fired(facts)).not.toContain("V-S2");
	});

	test("V-C — a lost crossing between the two layers", () => {
		const facts = healthyCell();
		facts.harnessServerReadCrossings = Math.floor(
			facts.crossings.server.dataCrossings * 0.9,
		);
		expect(fired(facts)).toContain("V-C");
	});

	test("V-K — a knob-off cell that batched anyway", () => {
		const facts = healthyCell();
		facts.crossings.server.batchedCrossings = 10;
		expect(fired(facts)).toContain("V-K");
	});

	test("V-K — a knob-on cell that did not batch on the client end", () => {
		const facts = healthyCell({ knobBytes: 65_536 });
		facts.crossings.server.batchedCrossings =
			facts.crossings.server.dataCrossings;
		if (facts.crossings.client) facts.crossings.client.batchedCrossings = 0;
		expect(fired(facts)).toContain("V-K");
		expect(knobProvenanceHolds(facts)).toBe(false);
	});

	test("V-K — a reference-generator cell has no client end to grade", () => {
		// Amendment 3: Arm T's generator has no addon, so `null` is the honest
		// value. It must not be read as "an addon ran and batched nothing".
		const facts = healthyCell();
		facts.crossings.client = null;
		expect(fired(facts)).not.toContain("V-K");
		const knobOn = healthyCell({ knobBytes: 65_536 });
		knobOn.crossings.client = null;
		knobOn.crossings.server.batchedCrossings =
			knobOn.crossings.server.dataCrossings;
		expect(fired(knobOn)).not.toContain("V-K");
		expect(
			falsifiersForTunnelCell(knobOn).find((f) => f.id === "V-K")?.detail,
		).toContain("no addon on this end");
	});

	test("V-K — a knob-on cell that batched on both ends passes", () => {
		const facts = healthyCell({ knobBytes: 65_536 });
		for (const end of [facts.crossings.server, facts.crossings.client]) {
			if (!end) continue;
			end.batchedCrossings = end.dataCrossings;
			end.maxBatchBytes = 65_536;
		}
		expect(fired(facts)).not.toContain("V-K");
	});

	test("V-L — an arm that measured the limiter", () => {
		expect(fired(healthyCell({ rateLimitedCount: 3 }))).toContain("V-L");
		expect(fired(healthyCell({ limitExceededCount: 1 }))).toContain("V-L");
	});

	test("V-D — counters read while the server was still receiving", () => {
		expect(fired(healthyCell({ settled: false }))).toContain("V-D");
	});

	test("V-W — a killed generator's cell is refused even though it settled", () => {
		// The trap this exists for: killing the child stops every counter at once,
		// so the settle barrier quiesces immediately and V-D stays silent on a
		// window that was cut in half.
		const truncated = healthyCell({ deadlineBreached: true, settled: true });
		expect(fired(truncated)).toContain("V-W");
		expect(fired(truncated)).not.toContain("V-D");
		expect(rollUpTunnelGate([truncated]).verdict).toBe("INVALID");
		expect(fired(healthyCell())).not.toContain("V-W");
	});

	test("V-B — a drop tap that was never read is not a zero", () => {
		expect(fired(healthyCell({ serverSocketDrops: null }))).toContain("V-B");
		expect(fired(healthyCell({ serverSocketDrops: 0 }))).not.toContain("V-B");
	});
});

describe("each clause fails on its own signature (§5)", () => {
	test("C3 — a reliable stream that did not deliver every byte", () => {
		const facts = healthyCell();
		facts.deliveredBytes.up = PER_DIRECTION_BYTES - FRAME_BYTES;
		expect(failedClauses(facts)).toContain("C3");
	});

	test("C4 — a cross-direction budget stall surfaces here first (K17)", () => {
		expect(failedClauses(healthyCell({ backpressureTimeouts: 1 }))).toContain(
			"C4",
		);
		expect(failedClauses(healthyCell({ streamErrors: 1 }))).toContain("C4");
		expect(failedClauses(healthyCell({ streamResets: 1 }))).toContain("C4");
		expect(
			failedClauses(healthyCell({ streamsClosedBothHalves: SESSIONS - 1 })),
		).toContain("C4");
	});

	test("C5 — one starved session fails fairness even at a healthy aggregate", () => {
		const facts = healthyCell();
		// Move a tenth of one session's bytes onto another: the aggregate is
		// untouched, which is exactly the failure an aggregate clause misses.
		facts.perSessionDeliveredBytes.up[0] = PER_SESSION_BYTES * 0.9;
		facts.perSessionDeliveredBytes.up[1] = PER_SESSION_BYTES * 1.1;
		expect(failedClauses(facts)).toContain("C5");
		expect(1.1 / 0.9).toBeGreaterThan(FAIRNESS_SPREAD_BAR);
	});

	test("C5 — a per-session vector that does not cover every session", () => {
		const facts = healthyCell();
		facts.perSessionDeliveredBytes.down =
			facts.perSessionDeliveredBytes.down.slice(1);
		expect(failedClauses(facts)).toContain("C5");
	});

	test("C6/C7 — the raw p99, with nothing subtracted", () => {
		const overBound = healthyCell();
		overBound.oneWayP99Ms.up = 25.4;
		expect(failedClauses(overBound)).toContain("C6");
		// And a large floor does not rescue it: the clause reads the raw value.
		overBound.floor.schedulerLagP99Ms = 4.9;
		expect(failedClauses(overBound)).toContain("C6");
	});

	test("C6/C7 — a direction with no samples cannot pass by vacuity", () => {
		const facts = healthyCell();
		facts.oneWaySamples.down = 0;
		facts.oneWayP99Ms.down = 0;
		expect(failedClauses(facts)).toContain("C7");
	});

	test("C8 — a config outside the shipped governors", () => {
		expect(
			failedClauses(
				healthyCell({ maxQueuedBytesPerSession: 64 * 1024 * 1024 }),
			),
		).toContain("C8");
	});

	test("C9 — the crossing disclosure grades nothing, by construction", () => {
		const facts = healthyCell();
		facts.crossings.server.bytes = 1;
		const c9 = clausesForTunnelCell(facts).find((c) => c.id === "C9");
		expect(c9?.pass).toBe(true);
		expect(c9?.detail).toContain("DISCLOSURE ONLY");
	});

	test("mean bytes per crossing is zero-safe", () => {
		expect(
			meanBytesPerCrossing({
				dataCrossings: 0,
				batchedCrossings: 0,
				terminalCrossings: 0,
				bytes: 0,
				maxBatchBytes: 0,
			}),
		).toBe(0);
	});
});

describe("roll-up ordering — G3b's lesson, stated as a test", () => {
	test("a fired falsifier stamps INVALID over clauses that all computed PASS", () => {
		const facts = healthyCell({ settled: false });
		expect(failedClauses(facts)).toEqual([]);
		const roll = rollUpTunnelGate([facts]);
		expect(roll.verdict).toBe("INVALID");
		expect(roll.reason).toContain("V-D");
		// The clauses are still recorded, and they still say PASS. The verdict
		// does not: that separation is the point.
		expect(roll.clauses["T-100#1"]?.every((c) => c.pass)).toBe(true);
	});

	test("saturation is INCOMPLETE, not INVALID and not a miss", () => {
		const roll = rollUpTunnelGate([healthyCell({ hostCpuMedianPctOfBox: 95 })]);
		expect(roll.verdict).toBe("INCOMPLETE");
	});

	test("a real falsifier outranks a saturation STOP", () => {
		const roll = rollUpTunnelGate([
			healthyCell({ hostCpuMedianPctOfBox: 95, settled: false }),
		]);
		expect(roll.verdict).toBe("INVALID");
	});

	test("one bad repeat is enough to lose the gate", () => {
		const bad = healthyCell({ repeat: 2 });
		bad.oneWayP99Ms.down = 40;
		expect(rollUpTunnelGate([healthyCell({ repeat: 1 }), bad]).verdict).toBe(
			"MISS",
		);
	});
});

// --- Arm X ------------------------------------------------------------------

function healthyExchange(
	over: Partial<ExchangeCellFacts> = {},
): ExchangeCellFacts {
	const attempted = 2000 * 30;
	return {
		cell: "X-1000",
		sessions: 1000,
		windowSec: 30,
		runId: "run-1",
		host: "bench-1",
		attemptedExchanges: attempted,
		completedExchanges: attempted,
		serverAcceptedStreams: attempted,
		clientOpenedStreams: attempted,
		peakConcurrentBidiPerSession: 3,
		exchangeRttP99Ms: 12.5,
		rttSamples: attempted,
		negativeSamples: 0,
		floor: {
			runId: "run-1",
			host: "bench-1",
			drivingSessions: 1000,
			schedulerLagP99Ms: 2.1,
			schedulerLagMaxMs: 14,
			writeSettleP99Ms: null,
			writeSettleMaxMs: null,
		},
		hostCpuMedianPctOfBox: 61,
		rateLimitedCount: 0,
		limitExceededCount: 0,
		settled: true,
		deadlineBreached: false,
		...over,
	};
}

describe("Arm X — the acceptance path", () => {
	test("a healthy exchange cell passes", () => {
		expect(rollUpExchangeArm(healthyExchange()).verdict).toBe("PASS");
	});

	test("V-A — accepts inferred from client pacing rather than observed", () => {
		const facts = healthyExchange({ serverAcceptedStreams: 40_000 });
		expect(
			falsifiersForExchangeCell(facts)
				.filter((f) => f.fired)
				.map((f) => f.id),
		).toContain("V-A");
		expect(rollUpExchangeArm(facts).verdict).toBe("INVALID");
	});

	test("V-X2 — an arm that measured the shipped per-session stream cap", () => {
		const facts = healthyExchange({ peakConcurrentBidiPerSession: 200 });
		expect(rollUpExchangeArm(facts).verdict).toBe("INVALID");
	});

	test("V-W — a killed generator's exchange cell is refused", () => {
		const facts = healthyExchange({ deadlineBreached: true, settled: true });
		expect(
			falsifiersForExchangeCell(facts)
				.filter((f) => f.fired)
				.map((f) => f.id),
		).toEqual(["V-W"]);
		expect(rollUpExchangeArm(facts).verdict).toBe("INVALID");
	});

	test("X1 — incomplete exchanges below the bar", () => {
		const facts = healthyExchange({ completedExchanges: 59_000 });
		expect(
			clausesForExchangeCell(facts)
				.filter((c) => !c.pass)
				.map((c) => c.id),
		).toContain("X1");
	});

	test("X2 — the round-trip bound is 50 ms, unhalved", () => {
		const facts = healthyExchange({ exchangeRttP99Ms: 50.1 });
		expect(
			clausesForExchangeCell(facts)
				.filter((c) => !c.pass)
				.map((c) => c.id),
		).toContain("X2");
		expect(
			clausesForExchangeCell(healthyExchange({ exchangeRttP99Ms: 49.9 }))
				.filter((c) => !c.pass)
				.map((c) => c.id),
		).not.toContain("X2");
	});
});

// --- Arm D ------------------------------------------------------------------

function couplingCell(
	end: StreamEnd,
	fraction: number,
	over: Partial<CouplingCellFacts> = {},
): CouplingCellFacts {
	return {
		cell: `D-${Math.round(fraction * 100)}-${end}`,
		end,
		backlogFraction: fraction,
		downstreamWriteP99Ms: 0.4,
		backpressureTimeouts: 0,
		streamErrors: 0,
		peakSessionQueuedBytes: 4096,
		deadlineBreached: false,
		...over,
	};
}

/** The flat, uncoupled pair of cells for one end. */
function quietEnd(end: StreamEnd): CouplingCellFacts[] {
	return [
		couplingCell(end, 0),
		couplingCell(end, 0.25, { downstreamWriteP99Ms: 0.42 }),
		couplingCell(end, 0.95, { downstreamWriteP99Ms: 0.55 }),
	];
}

describe("Arm D, per end — D-P1' against D-F1' (Amendment 2)", () => {
	test("a backpressure timeout at the top fraction reads as coupling", () => {
		expect(
			readCouplingEnd([
				couplingCell("client-opened", 0),
				couplingCell("client-opened", 0.95, { backpressureTimeouts: 4 }),
			]).reading,
		).toBe("COUPLING-OBSERVED");
	});

	test("a latency blow-up alone is enough to read as coupling", () => {
		expect(
			readCouplingEnd([
				couplingCell("client-opened", 0),
				couplingCell("client-opened", 0.95, { downstreamWriteP99Ms: 3.2 }),
			]).reading,
		).toBe("COUPLING-OBSERVED");
	});

	test("flat latency and no timeouts refutes coupling for that end", () => {
		expect(readCouplingEnd(quietEnd("server-accepted")).reading).toBe(
			"COUPLING-REFUTED",
		);
	});

	test("a deadline-breached cell makes its end indeterminate, not coupled", () => {
		// Reading a truncated load cell against a full control would report the
		// missing half of the window as an absence of coupling.
		expect(
			readCouplingEnd([
				couplingCell("client-opened", 0),
				couplingCell("client-opened", 0.95, { deadlineBreached: true }),
			]).reading,
		).toBe("INDETERMINATE");
		expect(
			readCouplingArm([
				couplingCell("client-opened", 0),
				couplingCell("client-opened", 0.95, {
					backpressureTimeouts: 2,
					deadlineBreached: true,
				}),
				...quietEnd("server-accepted"),
			]).verdictFreeReading,
		).toBe("INDETERMINATE");
	});

	test("a missing control cell is indeterminate, never a reading", () => {
		expect(readCouplingEnd([couplingCell("client-opened", 0.95)]).reading).toBe(
			"INDETERMINATE",
		);
		expect(readCouplingEnd([]).reading).toBe("INDETERMINATE");
	});
});

describe("Arm D, the pair reading — every outcome is named in advance", () => {
	test("D-P1' held: coupling on the client-opened end only", () => {
		const reading = readCouplingArm([
			couplingCell("client-opened", 0),
			couplingCell("client-opened", 0.95, { backpressureTimeouts: 2 }),
			...quietEnd("server-accepted"),
		]);
		expect(reading.verdictFreeReading).toBe("PATH-ASYMMETRY-HELD");
	});

	test("the more interesting refutation: coupling on the server-accepted end only", () => {
		const reading = readCouplingArm([
			...quietEnd("client-opened"),
			couplingCell("server-accepted", 0),
			couplingCell("server-accepted", 0.95, { downstreamWriteP99Ms: 9 }),
		]);
		expect(reading.verdictFreeReading).toBe("PATH-ASYMMETRY-REFUTED");
	});

	test("no coupling anywhere refutes the K17 reading outright", () => {
		const reading = readCouplingArm([
			...quietEnd("client-opened"),
			...quietEnd("server-accepted"),
		]);
		expect(reading.verdictFreeReading).toBe("COUPLING-ABSENT");
	});

	test("coupling on both ends is its own named outcome, not the prediction", () => {
		const reading = readCouplingArm([
			couplingCell("client-opened", 0),
			couplingCell("client-opened", 0.95, { backpressureTimeouts: 1 }),
			couplingCell("server-accepted", 0),
			couplingCell("server-accepted", 0.95, { backpressureTimeouts: 1 }),
		]);
		expect(reading.verdictFreeReading).toBe("COUPLING-BOTH-ENDS");
	});

	test("one end missing its control makes the pair indeterminate", () => {
		const reading = readCouplingArm([...quietEnd("client-opened")]);
		expect(reading.verdictFreeReading).toBe("INDETERMINATE");
	});
});

describe("the floor gate is shared and behaves the same on both arms", () => {
	test("same run, same host, non-zero driving sessions", () => {
		const floor = healthyCell().floor;
		expect(
			floorReportIsUsable(floor, { runId: "run-1", host: "bench-1" }),
		).toBe(true);
		expect(
			floorReportIsUsable(floor, { runId: "run-2", host: "bench-1" }),
		).toBe(false);
	});
});
