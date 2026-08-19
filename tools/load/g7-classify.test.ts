import { describe, expect, test } from "bun:test";
import {
	type BulkCellSummary,
	type BulkRepeatFacts,
	evaluateL1,
	type LatencySamples,
	negativeFraction,
	percentileMs,
	rollUp,
	summariseBulkCell,
	summariseTokenCell,
	type TokenCellSummary,
	type TokenRepeatFacts,
	v2bOriginator,
	v2Overshoot,
	v3Negative,
	v4Ledger,
	v5Stamp,
	v6Quiescence,
	v7Saturation,
} from "./g7-classify.ts";
import { emptySamples, G7Histogram } from "./g7-histogram.ts";
import type { BulkCellName, TokenCellName } from "./g7-plan.ts";

function samplesOf(values: number[]): LatencySamples {
	const h = new G7Histogram();
	for (const v of values) h.record(v);
	return h.snapshot();
}

const cleanBulk = (over: Partial<BulkRepeatFacts> = {}): BulkRepeatFacts => ({
	cell: "B-64k",
	repeat: 1,
	bucket: "paced-cell",
	incomplete: false,
	hostCpuPctMedian: 50,
	sinkCpuPctMedian: 60,
	rateLimitedDelta: 0,
	limitExceededDelta: 0,
	sessionsErr: 0,
	exitCode: 0,
	streamBatchBytesEnv: 0,
	clientRcvbufErrors: 0,
	serverSndbufErrors: 0,
	writeWindowSec: 63,
	childDriveSec: 66,
	windowSec: 60,
	writeBytes: 65536,
	paceBytesPerSec: 156_250_000,
	offeredBytesPerSecWriteWindow: 156_250_000,
	deliveredBytesPerSecWriteWindow: 156_250_000,
	deliveredBytesPerSecNominal: 164_062_500,
	serverBytesWritten: 65536 * 150_000,
	sinkBytesRead: 65536 * 150_000,
	writeCalls: 150_000,
	writeSettles: 150_000,
	streamsOpened: 16,
	streamsAccepted: 16,
	streamsFinished: 16,
	serverStreamErrors: 0,
	sinkStreamErrors: 0,
	pacerLateness: samplesOf([0.1, 0.2, 0.3]),
	writeSettle: samplesOf([0.05, 0.06, 0.07]),
	writeIntervalMs: 6.71,
	serverCpuMs: 60_000,
	wireBytesSent: 65536 * 150_000 * 1.03,
	explicitWindowFieldsSet: false,
	queuedBytesPerStream: 262144,
	queuedBytesPerSession: 2097152,
	...over,
});

const cleanToken = (
	over: Partial<TokenRepeatFacts> = {},
): TokenRepeatFacts => ({
	cell: "T-1k",
	repeat: 1,
	bucket: "token-cell",
	incomplete: false,
	hostCpuPctMedian: 45,
	sinkCpuPctMedian: 40,
	rateLimitedDelta: 0,
	limitExceededDelta: 0,
	sessionsErr: 0,
	exitCode: 0,
	streamBatchBytesEnv: 0,
	clientRcvbufErrors: 0,
	serverSndbufErrors: 0,
	writeWindowSec: 62,
	childDriveSec: 70,
	windowSec: 60,
	sessions: 1000,
	writeBytes: 40,
	writesIssued: 1_500_000,
	writesReceived: 1_500_000,
	writeSettles: 1_500_000,
	stampsDecoded: 1_500_000,
	stampsUndecodable: 0,
	sequenceGaps: 0,
	outOfOrder: 0,
	streamsOpened: 1000,
	streamsAccepted: 1000,
	streamsFinished: 1000,
	serverStreamErrors: 0,
	sinkStreamErrors: 0,
	oneWay: samplesOf([1, 2, 3, 4]),
	pacerLateness: samplesOf([0.5, 0.6]),
	writeSettle: samplesOf([0.02, 0.03]),
	intervalMs: 40,
	serverCpuMs: 40_000,
	...over,
});

describe("percentiles rank their non-positive samples (the G3b defect)", () => {
	test("negatives count in the denominator and rank at the bottom", () => {
		// 8 samples: 4 non-positive, then 2, 4, 8, 16 ms.
		const s = samplesOf([-5, -1, 0, -3, 2, 4, 8, 16]);
		expect(percentileMs(s, 0.5)).toBe(0);
		// Positive-only conditioning would have returned ~4 ms here; ranking the
		// negatives moves the median to zero, which is the honest order statistic.
		expect(negativeFraction(s)).toBeCloseTo(0.5, 10);
	});

	test("an empty distribution is null, never a passing zero", () => {
		expect(percentileMs(emptySamples(), 0.99)).toBeNull();
	});

	test("the p99 of a clean distribution lands in the tail", () => {
		const values = Array.from({ length: 1000 }, (_, i) => (i < 985 ? 1 : 40));
		const p99 = percentileMs(samplesOf(values), 0.99);
		expect(p99).not.toBeNull();
		expect(p99 as number).toBeGreaterThan(30);
	});
});

describe("falsifiers fire on the signature each exists to reject", () => {
	test("V2 fires on an overshoot the pacer cannot produce", () => {
		expect(
			v2Overshoot({
				offeredBytesPerSecWriteWindow: 156_250_000 * 1.03,
				paceBytesPerSec: 156_250_000,
			}).fired,
		).toBe(true);
		expect(
			v2Overshoot({
				offeredBytesPerSecWriteWindow: 156_250_000 * 1.0004,
				paceBytesPerSec: 156_250_000,
			}).fired,
		).toBe(false);
	});

	test("V2 treats a missing offer counter as INVALID, not as a zero", () => {
		const v = v2Overshoot({
			offeredBytesPerSecWriteWindow: null,
			paceBytesPerSec: 156_250_000,
		});
		expect(v.fired).toBe(true);
		expect(v.effect).toBe("INVALID");
	});

	test("V2b separates an originator-bound shortfall from a product shortfall", () => {
		const originatorBound = v2bOriginator({
			offeredBytesPerSecWriteWindow: 156_250_000 * 0.7,
			paceBytesPerSec: 156_250_000,
			pacerLateness: samplesOf([20, 30, 40]),
			writeSettle: samplesOf([0.1, 0.2, 0.3]),
			writeIntervalMs: 6.71,
		});
		expect(originatorBound.fired).toBe(true);
		expect(originatorBound.detail).toContain("ORIGINATOR-BOUND");

		const productShortfall = v2bOriginator({
			offeredBytesPerSecWriteWindow: 156_250_000 * 0.7,
			paceBytesPerSec: 156_250_000,
			pacerLateness: samplesOf([0.1, 0.2, 0.3]),
			writeSettle: samplesOf([0.05]),
			writeIntervalMs: 6.71,
		});
		expect(productShortfall.fired).toBe(false);
	});

	test("V2b refuses to excuse a shortfall the write path itself produced", () => {
		// Lateness is large, but the write call accounts for most of it: the
		// event loop was late because the product was slow. That is a MISS.
		const v = v2bOriginator({
			offeredBytesPerSecWriteWindow: 156_250_000 * 0.6,
			paceBytesPerSec: 156_250_000,
			pacerLateness: samplesOf([30, 30, 30]),
			writeSettle: samplesOf([25, 25, 25]),
			writeIntervalMs: 6.71,
		});
		expect(v.fired).toBe(false);
		expect(v.detail).toContain("PRODUCT-BOUND");
	});

	test("V2b cannot attribute lateness it has no settle instrument for", () => {
		const v = v2bOriginator({
			offeredBytesPerSecWriteWindow: 156_250_000 * 0.6,
			paceBytesPerSec: 156_250_000,
			pacerLateness: samplesOf([30, 30, 30]),
			writeSettle: emptySamples(),
			writeIntervalMs: 6.71,
		});
		expect(v.fired).toBe(true);
		expect(v.detail).toContain("cannot be attributed");
	});

	test("V2b never fires when the offer was met — the rule is one-sided", () => {
		expect(
			v2bOriginator({
				offeredBytesPerSecWriteWindow: 156_250_000,
				paceBytesPerSec: 156_250_000,
				pacerLateness: samplesOf([500, 600]),
				writeSettle: samplesOf([0.1]),
				writeIntervalMs: 6.71,
			}).fired,
		).toBe(false);
	});

	test("V3 fires on a broken clock domain", () => {
		const many = Array.from({ length: 1000 }, (_, i) => (i < 5 ? -1 : 3));
		expect(v3Negative(samplesOf(many)).fired).toBe(true);
		const few = Array.from({ length: 10000 }, (_, i) => (i < 5 ? -1 : 3));
		expect(v3Negative(samplesOf(few)).fired).toBe(false);
	});

	test("V4 fires on every way the ledger can fail to close", () => {
		const base = {
			serverBytesWritten: 1000,
			sinkBytesRead: 1000,
			writeCalls: 10,
			writeSettles: 10,
			writeBytes: 100,
			streamsOpened: 4,
			streamsAccepted: 4,
			streamsFinished: 4,
		};
		expect(v4Ledger(base).fired).toBe(false);
		expect(v4Ledger({ ...base, sinkBytesRead: 999 }).fired).toBe(true);
		expect(v4Ledger({ ...base, writeSettles: 9 }).fired).toBe(true);
		expect(v4Ledger({ ...base, streamsFinished: 3 }).fired).toBe(true);
		expect(v4Ledger({ ...base, writeCalls: 11 }).fired).toBe(true);
	});

	test("V5 refuses an unstamped payload contract and an empty one", () => {
		expect(v5Stamp({ stampsDecoded: 990, writesReceived: 1000 }).fired).toBe(
			false,
		);
		expect(v5Stamp({ stampsDecoded: 980, writesReceived: 1000 }).fired).toBe(
			true,
		);
		expect(v5Stamp({ stampsDecoded: 0, writesReceived: 0 }).fired).toBe(true);
	});

	test("V6 refuses a cell that ran with the receive-side batch knob on", () => {
		const v = v6Quiescence({
			...cleanBulk({ streamBatchBytesEnv: 65536 }),
		});
		expect(v.fired).toBe(true);
		expect(v.detail).toContain("no G7 cell may run with it on");
	});

	test("V7 makes saturation a NO-VERDICT and never a MISS", () => {
		const v = v7Saturation(cleanBulk({ hostCpuPctMedian: 91 }));
		expect(v.fired).toBe(true);
		expect(v.effect).toBe("NO-VERDICT");
		expect(v7Saturation(cleanBulk({ hostCpuPctMedian: null })).fired).toBe(
			true,
		);
	});
});

function bulkMap(
	entries: [BulkCellName, BulkRepeatFacts[]][],
): Map<BulkCellName, BulkCellSummary> {
	return new Map(
		entries.map(([cell, reps]) => [cell, summariseBulkCell(cell, reps)]),
	);
}

function tokenMap(
	entries: [TokenCellName, TokenRepeatFacts[]][],
): Map<TokenCellName, TokenCellSummary> {
	return new Map(
		entries.map(([cell, reps]) => [cell, summariseTokenCell(cell, reps)]),
	);
}

describe("clauses", () => {
	test("a clean run passes every clause", () => {
		const v = rollUp(
			bulkMap([["B-64k", [cleanBulk(), cleanBulk({ repeat: 2 })]]]),
			tokenMap([["T-1k", [cleanToken(), cleanToken({ repeat: 2 })]]]),
		);
		expect(v.verdict).toBe("PASS");
		expect(v.runValid).toBe(true);
	});

	test("C2 binds on the drive denominator, not the flattering one", () => {
		// 0.98 Gbps over the drive window, 1.03 Gbps over the nominal one.
		const facts = cleanBulk({
			deliveredBytesPerSecWriteWindow: 122_500_000,
			deliveredBytesPerSecNominal: 128_750_000,
			sinkBytesRead: 65536 * 150_000,
			serverBytesWritten: 65536 * 150_000,
		});
		const v = rollUp(
			bulkMap([["B-64k", [facts, { ...facts, repeat: 2 }]]]),
			tokenMap([["T-1k", [cleanToken(), cleanToken({ repeat: 2 })]]]),
		);
		const c2 = v.clauses.find((c) => c.id === "C2");
		expect(c2?.verdict).toBe("MISS");
		expect(v.verdict).toBe("MISS");
	});

	test("C4 never reads an unmeasured drop counter as a zero", () => {
		const v = rollUp(
			bulkMap([
				[
					"B-64k",
					[
						cleanBulk({ clientRcvbufErrors: null }),
						cleanBulk({ repeat: 2, clientRcvbufErrors: null }),
					],
				],
			]),
			tokenMap([["T-1k", [cleanToken(), cleanToken({ repeat: 2 })]]]),
		);
		expect(v.clauses.find((c) => c.id === "C4")?.verdict).toBe("NOT-EVALUATED");
		expect(v.verdict).toBe("INCOMPLETE");
	});

	test("drops flag the cell as a lower bound and are disclosed per repeat", () => {
		const summary = summariseBulkCell("B-4k", [
			cleanBulk({ cell: "B-4k", clientRcvbufErrors: 12 }),
			cleanBulk({ cell: "B-4k", repeat: 2, clientRcvbufErrors: 0 }),
		]);
		expect(summary.deliveredIsLowerBound).toBe(true);
		expect(summary.dropDisclosure).toHaveLength(2);
		expect(summary.dropDisclosure[0]?.clientRcvbufErrors).toBe(12);
	});

	test("C7 is the raw p99 with the pacer's own lateness beside it, never subtracted", () => {
		const late = new G7Histogram();
		for (let i = 0; i < 1000; i += 1) late.record(i < 985 ? 2 : 30);
		const v = rollUp(
			bulkMap([["B-64k", [cleanBulk(), cleanBulk({ repeat: 2 })]]]),
			tokenMap([
				[
					"T-1k",
					[
						cleanToken({ oneWay: late.snapshot() }),
						cleanToken({ repeat: 2, oneWay: late.snapshot() }),
					],
				],
			]),
		);
		const c7 = v.clauses.find((c) => c.id === "C7");
		expect(c7?.verdict).toBe("MISS");
		expect(c7?.detail).toContain("never subtracted");
	});

	test("C6 fails when the arm did not run on the shipped governors", () => {
		const raised = cleanBulk({
			explicitWindowFieldsSet: true,
			queuedBytesPerSession: 64 * 1024 * 1024,
		});
		const v = rollUp(
			bulkMap([["B-64k", [raised, { ...raised, repeat: 2 }]]]),
			tokenMap([["T-1k", [cleanToken(), cleanToken({ repeat: 2 })]]]),
		);
		expect(v.clauses.find((c) => c.id === "C6")?.verdict).toBe("MISS");
	});
});

describe("roll-up validity precedes every clause", () => {
	test("INVALID is stamped over a set of clauses that all computed PASS", () => {
		// Everything is clean except the clock domain on the token arm.
		const broken = Array.from({ length: 1000 }, (_, i) => (i < 20 ? -1 : 2));
		const v = rollUp(
			bulkMap([["B-64k", [cleanBulk(), cleanBulk({ repeat: 2 })]]]),
			tokenMap([
				[
					"T-1k",
					[
						cleanToken({ oneWay: samplesOf(broken) }),
						cleanToken({ repeat: 2, oneWay: samplesOf(broken) }),
					],
				],
			]),
		);
		expect(v.verdict).toBe("INVALID");
		expect(v.runValid).toBe(false);
		// The precise reading G3b's classifier would have permitted: every
		// substantive clause computed PASS. Only C1 — which reads cell status
		// rather than a measurement — reflects the problem, and a reader who
		// skipped it would have stamped a gate.
		expect(
			v.clauses.filter((c) => c.id !== "C1" && c.verdict === "MISS"),
		).toHaveLength(0);
		expect(v.clauses.filter((c) => c.verdict === "PASS").length).toBe(7);
		expect(v.clauses.find((c) => c.id === "C1")?.verdict).toBe("MISS");
		expect(v.headline).toContain("whatever the clauses computed");
	});

	test("saturation is NO-VERDICT, ahead of any clause reading", () => {
		const v = rollUp(
			bulkMap([
				[
					"B-64k",
					[
						cleanBulk({ hostCpuPctMedian: 95 }),
						cleanBulk({ repeat: 2, hostCpuPctMedian: 95 }),
					],
				],
			]),
			tokenMap([["T-1k", [cleanToken(), cleanToken({ repeat: 2 })]]]),
		);
		expect(v.verdict).toBe("NO-VERDICT");
	});

	test("a missing gate cell is INCOMPLETE, never a pass on what remains", () => {
		const v = rollUp(
			bulkMap([["B-64k", [cleanBulk(), cleanBulk({ repeat: 2 })]]]),
			tokenMap([]),
		);
		expect(v.verdict).toBe("INCOMPLETE");
	});

	test("a sink that saturated makes the run INCOMPLETE, not a capacity number", () => {
		const v = rollUp(
			bulkMap([
				[
					"B-64k",
					[
						cleanBulk({ sinkCpuPctMedian: 97 }),
						cleanBulk({ repeat: 2, sinkCpuPctMedian: 97 }),
					],
				],
			]),
			tokenMap([["T-1k", [cleanToken(), cleanToken({ repeat: 2 })]]]),
		);
		expect(v.verdict).toBe("INCOMPLETE");
	});

	test("a scout cell's falsifier never touches the verdict", () => {
		const v = rollUp(
			bulkMap([
				["B-64k", [cleanBulk(), cleanBulk({ repeat: 2 })]],
				[
					"B-1k",
					[
						cleanBulk({ cell: "B-1k", hostCpuPctMedian: 99 }),
						cleanBulk({ cell: "B-1k", repeat: 2, hostCpuPctMedian: 99 }),
					],
				],
			]),
			tokenMap([["T-1k", [cleanToken(), cleanToken({ repeat: 2 })]]]),
		);
		expect(v.verdict).toBe("PASS");
	});
});

describe("L1, the lever-scout reading", () => {
	const withCpu = (cell: BulkCellName, cpuMs: number) =>
		[
			cell,
			[
				cleanBulk({ cell, serverCpuMs: cpuMs }),
				cleanBulk({ cell, repeat: 2, serverCpuMs: cpuMs }),
			],
		] as [BulkCellName, BulkRepeatFacts[]];

	test("licenses a design question when crossings cost enough", () => {
		const r = evaluateL1(
			bulkMap([withCpu("B-64k", 60_000), withCpu("B-4k", 150_000)]),
		);
		expect(r.verdict).toBe("LEVER-LICENSED");
		expect(r.ratio).toBeCloseTo(2.5, 5);
		expect(r.detail).toContain("never a build order");
	});

	test("refutes the lever when crossings are cheap", () => {
		const r = evaluateL1(
			bulkMap([withCpu("B-64k", 60_000), withCpu("B-4k", 70_000)]),
		);
		expect(r.verdict).toBe("LEVER-REFUTED");
	});

	test("refuses to read a lever off an unusable cell", () => {
		const map = bulkMap([
			withCpu("B-64k", 60_000),
			[
				"B-4k",
				[
					cleanBulk({ cell: "B-4k", serverCpuMs: 150_000, exitCode: 1 }),
					cleanBulk({
						cell: "B-4k",
						repeat: 2,
						serverCpuMs: 150_000,
						exitCode: 1,
					}),
				],
			],
		]);
		expect(evaluateL1(map).verdict).toBe("NOT-MEASURABLE");
	});
});
