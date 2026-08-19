import { describe, expect, test } from "bun:test";
import {
	coResidentDrops,
	discloseCoResidentDrops,
	evaluateGateG5,
	GATE_BATCH_BYTES,
	type GateCellName,
	type GateRepeatFacts,
	gateIntegrityBucket,
	parseUdpSocketRows,
	SHIPPED_QUEUED_BYTES_PER_SESSION,
	SHIPPED_QUEUED_BYTES_PER_STREAM,
	summarizeServerSockets,
} from "./gate-g5.ts";

/**
 * G5's rules were fixed in docs/research/preregistrations/gate-g5-bulk.md before
 * this harness existed, and on a macOS workstation every real step classifies
 * INCOMPLETE by construction — so the six clauses, both STOP conditions, the A6
 * re-run and the drop attribution would otherwise only ever execute inside the
 * one run they are supposed to adjudicate. These exercise them against synthetic
 * cells and synthetic procfs text instead.
 */

function repeat(over: Partial<GateRepeatFacts> = {}): GateRepeatFacts {
	return {
		cell: "G-batch",
		repeat: 1,
		bucket: "window-plateau",
		incomplete: false,
		deliveredMbps: 1100,
		packageMeanBytesPerCrossing: 20000,
		harnessMeanBytesPerCrossing: 20000,
		crossingsPerSecond: 7000,
		maxBatchBytes: GATE_BATCH_BYTES,
		batchedCrossings: 400000,
		serverSocketDrops: 0,
		coResidentDrops: 0,
		coResidentDropVerdict: "IMMATERIAL",
		serverSocketRxQueueBytesAtEnd: 0,
		queuedBytesPerStream: SHIPPED_QUEUED_BYTES_PER_STREAM,
		queuedBytesPerSession: SHIPPED_QUEUED_BYTES_PER_SESSION,
		explicitWindowFieldsSet: false,
		insideShippedPerSessionBudget: true,
		batchBytesConfigured: GATE_BATCH_BYTES,
		serverCpuMsPerGbit: 900,
		rssMbPeak: 400,
		...over,
	};
}

/** Two repeats of each of the four cells, all clearing every clause. */
function passingRun(
	tweak: Partial<Record<GateCellName, Partial<GateRepeatFacts>>> = {},
): GateRepeatFacts[] {
	const base: Record<GateCellName, Partial<GateRepeatFacts>> = {
		"G-control": {
			deliveredMbps: 780,
			packageMeanBytesPerCrossing: 4000,
			harnessMeanBytesPerCrossing: 4000,
			maxBatchBytes: 4096,
			batchedCrossings: 0,
			batchBytesConfigured: 0,
		},
		"G-batch": {},
		"G-window-ref": {
			deliveredMbps: 1030,
			packageMeanBytesPerCrossing: 4000,
			harnessMeanBytesPerCrossing: 4000,
			queuedBytesPerStream: 16 * 1024 * 1024,
			queuedBytesPerSession: 64 * 1024 * 1024,
			insideShippedPerSessionBudget: false,
			batchBytesConfigured: 0,
		},
		"G-window-batch": {
			deliveredMbps: 1120,
			queuedBytesPerStream: 16 * 1024 * 1024,
			queuedBytesPerSession: 64 * 1024 * 1024,
			insideShippedPerSessionBudget: false,
		},
	};
	const cells = Object.keys(base) as GateCellName[];
	return cells.flatMap((cell) =>
		[1, 2].map((n) =>
			repeat({ cell, repeat: n, ...base[cell], ...(tweak[cell] ?? {}) }),
		),
	);
}

describe("procfs drop attribution", () => {
	const PROC_NET_UDP = [
		"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops",
		" 3175: 0100007F:1151 00000000:0000 07 00000000:00001000 00:00000000 00000000  1000        0 51811 2 0000000000000000 42",
		" 3176: 0100007F:C350 00000000:0000 07 00000000:00000000 00:00000000 00000000  1000        0 51812 2 0000000000000000 7",
	].join("\n");

	test("matches the server port and reads the drops column", () => {
		// 0x1151 = 4433, the harness's Arm A/G port.
		const rows = parseUdpSocketRows(PROC_NET_UDP, 4433);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.drops).toBe(42);
		expect(rows[0]?.rxQueueBytes).toBe(0x1000);
	});

	test("a port with no socket yields no rows, which is not a zero", () => {
		expect(parseUdpSocketRows(PROC_NET_UDP, 4444)).toHaveLength(0);
		expect(
			gateIntegrityBucket({
				crossing: {
					packageMeanBytesPerCrossing: 20000,
					harnessMeanBytesPerCrossing: 20000,
				},
				serverSocketsFound: 0,
			}),
		).toBe("server-socket-drops-unmeasurable");
	});

	test("a truncated row is skipped rather than counted as zero drops", () => {
		const truncated = ["header", " 3175: 0100007F:1151 00000000:0000 07"].join(
			"\n",
		);
		expect(parseUdpSocketRows(truncated, 4433)).toHaveLength(0);
	});

	test("v4 and v6 sockets on one port sum", () => {
		const v6 = [
			"header",
			" 3177: 00000000000000000000000000000000:1151 00000000000000000000000000000000:0000 07 00000000:00000200 00:00000000 00000000  1000        0 51813 2 0000000000000000 5",
		].join("\n");
		const rows = [
			...parseUdpSocketRows(PROC_NET_UDP, 4433),
			...parseUdpSocketRows(v6, 4433),
		];
		expect(summarizeServerSockets(rows)).toEqual({
			drops: 47,
			rxQueueBytes: 0x1200,
			sockets: 2,
		});
	});

	test("co-resident share is the host delta minus the server's own, floored", () => {
		expect(coResidentDrops(100, 40)).toBe(60);
		// Sampling skew must not produce a negative drop count.
		expect(coResidentDrops(10, 40)).toBe(0);
	});

	test("disclosure grades against socket-layer receives, and refuses to grade without them", () => {
		expect(discloseCoResidentDrops(2000, 1_000_000).verdict).toBe("MATERIAL");
		expect(discloseCoResidentDrops(500, 1_000_000).verdict).toBe("IMMATERIAL");
		expect(discloseCoResidentDrops(5, 0).verdict).toBe("UNGRADED");
		expect(discloseCoResidentDrops(0, 0).verdict).toBe("IMMATERIAL");
	});
});

describe("Arm G integrity buckets", () => {
	test("instruments within 1% pass", () => {
		expect(
			gateIntegrityBucket({
				crossing: {
					packageMeanBytesPerCrossing: 20000,
					harnessMeanBytesPerCrossing: 20150,
				},
				serverSocketsFound: 1,
			}),
		).toBeNull();
	});

	test("instruments disagreeing by more than 1% are not a measurement", () => {
		expect(
			gateIntegrityBucket({
				crossing: {
					packageMeanBytesPerCrossing: 20000,
					harnessMeanBytesPerCrossing: 18000,
				},
				serverSocketsFound: 1,
			}),
		).toBe("crossing-instrument-disagreement");
	});

	test("a missing instrument is a disagreement, never a pass", () => {
		expect(
			gateIntegrityBucket({
				crossing: {
					packageMeanBytesPerCrossing: null,
					harnessMeanBytesPerCrossing: 20000,
				},
				serverSocketsFound: 1,
			}),
		).toBe("crossing-instrument-disagreement");
	});
});

describe("gate G5 verdict", () => {
	test("the pre-registered passing shape passes, and names no failed clause", () => {
		const r = evaluateGateG5(passingRun());
		expect(r.verdict).toBe("PASS");
		expect(r.failedClauses).toEqual([]);
		expect(r.clauses).toHaveLength(6);
		expect(r.stops).toEqual([]);
	});

	test("below 1 Gbps is a MISS on clause 2 alone", () => {
		const r = evaluateGateG5(passingRun({ "G-batch": { deliveredMbps: 940 } }));
		expect(r.verdict).toBe("MISS");
		expect(r.failedClauses.map((f) => f.split(" ")[0])).toEqual(["2", "5"]);
	});

	test("a crossing mean pinned at the 4 KiB read cap misses clause 4", () => {
		const r = evaluateGateG5(
			passingRun({
				"G-batch": {
					packageMeanBytesPerCrossing: 4090,
					harnessMeanBytesPerCrossing: 4090,
					maxBatchBytes: 4096,
				},
			}),
		);
		expect(r.verdict).toBe("MISS");
		expect(r.failedClauses.join(" ")).toContain("4 crossing");
		// The artifact must already say which mechanism it was.
		expect(r.clauses[3]?.detail).toContain("maxBatchBytes 4096");
	});

	test("clearing 1 Gbps but falling short of the raised-window control misses clause 5", () => {
		const r = evaluateGateG5(
			passingRun({
				"G-batch": { deliveredMbps: 1010 },
				"G-window-ref": { deliveredMbps: 1300 },
			}),
		);
		expect(r.verdict).toBe("MISS");
		expect(r.failedClauses.map((f) => f.split(" ")[0])).toEqual(["5"]);
	});

	test("a raised-window gate cell fails clause 3 even if it clears the bar", () => {
		const r = evaluateGateG5(
			passingRun({
				"G-batch": {
					deliveredMbps: 1400,
					queuedBytesPerStream: 16 * 1024 * 1024,
					queuedBytesPerSession: 64 * 1024 * 1024,
					insideShippedPerSessionBudget: false,
				},
			}),
		);
		expect(r.verdict).toBe("MISS");
		expect(r.failedClauses.join(" ")).toContain("3 inside shipped budgets");
	});

	test("an explicit window field set on the gate cell fails clause 3", () => {
		const r = evaluateGateG5(
			passingRun({ "G-batch": { explicitWindowFieldsSet: true } }),
		);
		expect(r.failedClauses.join(" ")).toContain("3 inside shipped budgets");
	});

	test("a server-side rcvbuf drop in the control fails clause 6", () => {
		const r = evaluateGateG5(
			passingRun({ "G-control": { serverSocketDrops: 3 } }),
		);
		expect(r.verdict).toBe("MISS");
		expect(r.failedClauses.join(" ")).toContain("6 server-side rcvbuf drops");
	});

	test("an unmeasurable drop count in the control is not a zero", () => {
		const r = evaluateGateG5(
			passingRun({ "G-control": { serverSocketDrops: null } }),
		);
		expect(r.failedClauses.join(" ")).toContain("not measurable");
	});

	test("an INCOMPLETE repeat makes its cell unusable and fires G-STOP-A", () => {
		const facts = passingRun();
		const target = facts.find(
			(f) => f.cell === "G-window-batch" && f.repeat === 2,
		);
		if (target) {
			target.incomplete = true;
			target.bucket = "generator-saturated";
		}
		const r = evaluateGateG5(facts);
		expect(r.verdict).toBe("NO-VERDICT");
		expect(r.stops.join(" ")).toContain("G-STOP-A");
		expect(r.stops.join(" ")).toContain("generator-saturated");
	});

	test("an INCOMPLETE repeat is never silently dropped from its cell's median", () => {
		const facts = passingRun();
		for (const f of facts) {
			if (f.cell === "G-batch" && f.repeat === 2) {
				f.incomplete = true;
				f.bucket = "host-saturated";
				f.deliveredMbps = 200;
			}
		}
		const r = evaluateGateG5(facts);
		const batch = r.cells.find((c) => c.cell === "G-batch");
		expect(batch?.usable).toBe(false);
		expect(batch?.deliveredGbpsSamples).toEqual([1.1, 0.2]);
		expect(r.clauses[1]?.pass).toBe(false);
	});

	test("G-STOP-B suppresses the crossing claim rather than failing it quietly", () => {
		const facts = passingRun();
		for (const f of facts) {
			if (f.cell === "G-batch" && f.repeat === 1) {
				f.bucket = "crossing-instrument-disagreement";
				f.incomplete = true;
			}
		}
		const r = evaluateGateG5(facts);
		expect(r.verdict).toBe("NO-VERDICT");
		expect(r.stops.join(" ")).toContain("G-STOP-B");
		expect(r.clauses[3]?.detail).toContain("no crossing claim");
	});

	test("the A6 falsifier is re-run at both knob settings and is not a gate clause", () => {
		// Raised windows beat shipped by 32% knob-off, and by only 2% knob-on.
		const r = evaluateGateG5(
			passingRun({ "G-window-batch": { deliveredMbps: 1122 } }),
		);
		expect(r.a6AtChosenDefault.verdict).toBe("WINDOW-BOUND");
		expect(r.a6AtKnobOn.verdict).toBe("WINDOWS-NOT-BINDING");
		// WINDOW-BOUND is a disclosure; the gate still passes on its own clauses.
		expect(r.verdict).toBe("PASS");
	});

	test("the lever's own effect is reported and carries no threshold", () => {
		const r = evaluateGateG5(passingRun());
		expect(r.derived.leverEffectBatchOverControl).toBeCloseTo(1.1 / 0.78, 3);
		expect(r.clauses.some((c) => c.name.includes("lever"))).toBe(false);
	});

	test("a cell with no repeats at all is unusable, not vacuously usable", () => {
		const facts = passingRun().filter((f) => f.cell !== "G-window-ref");
		const r = evaluateGateG5(facts);
		expect(r.verdict).toBe("NO-VERDICT");
		expect(r.cells.find((c) => c.cell === "G-window-ref")?.usable).toBe(false);
	});
});
