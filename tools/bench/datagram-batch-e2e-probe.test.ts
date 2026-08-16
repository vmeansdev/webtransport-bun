import { describe, expect, test } from "bun:test";
import {
	ARMS,
	type ArmRun,
	REPS,
	SATURATION_CEILING,
	summarizeProbe,
} from "./datagram-batch-e2e-probe.ts";
import { MIN_MEDIAN_SPEEDUP } from "./datagram-delivery-floor.ts";

/** One run with only the fields the verdict logic reads made interesting. */
function run(
	arm: number,
	round: number,
	receivedPerSec: number,
	saturationRatio = 0.6,
): ArmRun {
	return {
		arm,
		round,
		receivedPerSec,
		offeredPerSec: receivedPerSec / (saturationRatio || 1),
		received: 0,
		receivedBytes: 0,
		clientSent: 0,
		clientSendErrors: 0,
		sessionsOk: 1,
		sessionsErr: 0,
		windowMs: 20_000,
		saturationRatio,
		serverCpuCores: 1,
		batchDiagnostics: null,
	};
}

/** A full set of runs: REPS per arm, legacy at `legacy`, batched at `batched`. */
function runs(legacy: number, batched: number, saturation = 0.6): ArmRun[] {
	const out: ArmRun[] = [];
	for (let round = 1; round <= REPS; round += 1) {
		out.push(run(0, round, legacy, saturation));
		out.push(run(64, round, batched, saturation));
	}
	return out;
}

describe("the probe's shape", () => {
	test("compares the legacy path against the intended default", () => {
		expect(ARMS).toEqual([0, 64]);
	});
});

describe("verdict: proceed / stop, both sides of the reference ratio", () => {
	test("proceeds at exactly the reference ratio", () => {
		const summary = summarizeProbe(runs(50_000, 50_000 * MIN_MEDIAN_SPEEDUP));
		expect(summary.ratio).toBe(MIN_MEDIAN_SPEEDUP);
		expect(summary.verdict).toBe("proceed");
	});

	test("stops just below the reference ratio", () => {
		const summary = summarizeProbe(runs(50_000, 99_999));
		expect(summary.verdict).toBe("stop");
	});

	test("stops on a ratio near 1, which is the real-world shape", () => {
		const summary = summarizeProbe(runs(49_481, 57_936));
		expect(summary.ratio).toBeCloseTo(1.1709, 3);
		expect(summary.verdict).toBe("stop");
	});
});

describe("verdict: inconclusive protects against measuring the sender", () => {
	test("a legacy arm at exactly the saturation ceiling is inconclusive", () => {
		const summary = summarizeProbe(runs(50_000, 200_000, SATURATION_CEILING));
		expect(summary.verdict).toBe("inconclusive");
		expect(summary.rationale).toContain("offered load");
	});

	test("just below the ceiling the measurement stands", () => {
		const summary = summarizeProbe(
			runs(50_000, 200_000, SATURATION_CEILING - 0.001),
		);
		expect(summary.verdict).toBe("proceed");
	});

	test("a spectacular ratio cannot rescue an unsaturated receiver", () => {
		const summary = summarizeProbe(runs(50_000, 5_000_000, 0.99));
		expect(summary.verdict).toBe("inconclusive");
	});

	test("only the LEGACY arm's saturation gates the comparison", () => {
		// The batched arm receiving all it was offered is expected once it is
		// fast enough; it is the legacy arm that must be driven past capacity.
		const mixed = [
			...Array.from({ length: REPS }, (_, i) => run(0, i + 1, 50_000, 0.6)),
			...Array.from({ length: REPS }, (_, i) => run(64, i + 1, 100_000, 0.99)),
		];
		expect(summarizeProbe(mixed).verdict).toBe("proceed");
	});

	test("a non-finite rate is inconclusive, never a stop", () => {
		const bad = runs(50_000, 100_000);
		bad[2] = run(0, 2, Number.NaN);
		expect(summarizeProbe(bad).verdict).toBe("inconclusive");
	});

	test("a missing run is inconclusive, never a stop", () => {
		expect(summarizeProbe(runs(50_000, 100_000).slice(1)).verdict).toBe(
			"inconclusive",
		);
	});

	test("no runs at all is inconclusive", () => {
		expect(summarizeProbe([]).verdict).toBe("inconclusive");
	});
});

describe("aggregation reports the worst case, not just the middle", () => {
	test("keeps every run and reports median, min and worst saturation", () => {
		const summary = summarizeProbe([
			run(0, 1, 40_000, 0.5),
			run(0, 2, 50_000, 0.8),
			run(0, 3, 60_000, 0.6),
			run(64, 1, 70_000, 0.4),
			run(64, 2, 80_000, 0.4),
			run(64, 3, 90_000, 0.4),
		]);
		const legacy = summary.byArm[0];
		expect(legacy?.runs.length).toBe(3);
		expect(legacy?.medianReceivedPerSec).toBe(50_000);
		expect(legacy?.minReceivedPerSec).toBe(40_000);
		expect(legacy?.maxSaturationRatio).toBe(0.8);
	});
});
