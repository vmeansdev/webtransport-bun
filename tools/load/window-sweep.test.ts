import { describe, expect, test } from "bun:test";
import {
	assertWindowMathMirror,
	DEFAULT_MAX_SESSIONS,
	evaluateWindowSweep,
	type WindowRungFacts,
	type WindowRungRole,
	windowMath,
} from "./window-sweep.ts";

/**
 * Arm W's rules were fixed in Amendment 2 before any dispatch, and on a macOS
 * workstation every real step classifies INCOMPLETE by construction — so the
 * knee rule, the retention falsifier and both STOP conditions would otherwise
 * only ever execute on the runner, inside the one run they are supposed to
 * adjudicate. These exercise them against synthetic rungs instead.
 */

function rung(
	over: Partial<WindowRungFacts> & { rung: string },
): WindowRungFacts {
	const perStream = over.math?.perStream ?? 256 * 1024;
	return {
		role: "ladder" as WindowRungRole,
		math: windowMath(perStream, perStream * 8, 4),
		bucket: "window-plateau",
		incomplete: false,
		deliveredMbps: 1000,
		rssMbBaseline: 100,
		rssMbPeak: 150,
		...over,
	};
}

function ladder(
	shape: Array<{ perStream: number; mbps: number; bucket?: string }>,
): WindowRungFacts[] {
	return shape.map((s, i) =>
		rung({
			rung: `W${i + 1}`,
			math: windowMath(s.perStream, s.perStream * 8, 4),
			deliveredMbps: s.mbps,
			bucket: s.bucket ?? (i === 0 ? "window-plateau" : "window-scaling"),
		}),
	);
}

describe("windowMath", () => {
	test("mirrors transport_memory.rs at the shipped defaults", () => {
		expect(() => assertWindowMathMirror()).not.toThrow();
	});

	test("advertises receive + send + datagram channel per session", () => {
		const m = windowMath(256 * 1024, 2 * 1024 * 1024, 4);
		expect(m.streamReceiveWindow).toBe(262144);
		expect(m.receiveWindow).toBe(2 * 1024 * 1024);
		expect(m.sendWindow).toBe(2 * 1024 * 1024);
		expect(m.datagramChannelCapacity).toBe(1748);
		expect(m.perSessionWorstCaseBytes).toBe(2 * 2 * 1024 * 1024 + 1748 * 1200);
		expect(m.atArmSessionsBytes).toBe(m.perSessionWorstCaseBytes * 4);
		expect(m.atMaxSessionsBytes).toBe(
			m.perSessionWorstCaseBytes * DEFAULT_MAX_SESSIONS,
		);
		expect(m.insideShippedPerSessionBudget).toBe(true);
	});

	test("clamps the datagram channel at its ceiling, so the top rungs do not grow it", () => {
		const small = windowMath(2 * 1024 * 1024, 16 * 1024 * 1024, 4);
		const large = windowMath(16 * 1024 * 1024, 128 * 1024 * 1024, 4);
		expect(small.datagramChannelCapacity).toBe(2048);
		expect(large.datagramChannelCapacity).toBe(2048);
		// The growth above the clamp is windows only, which is what the sweep says.
		expect(
			large.perSessionWorstCaseBytes - small.perSessionWorstCaseBytes,
		).toBe(2 * (128 - 16) * 1024 * 1024);
	});

	test("a raised per-session governor leaves the shipped budget", () => {
		expect(
			windowMath(16 * 1024 * 1024, 64 * 1024 * 1024, 4)
				.insideShippedPerSessionBudget,
		).toBe(false);
	});

	test("the stream window floors the session window when it is larger", () => {
		const m = windowMath(4 * 1024 * 1024, 1024, 1);
		expect(m.receiveWindow).toBe(4 * 1024 * 1024);
		expect(m.sendWindow).toBe(4 * 1024 * 1024);
	});
});

describe("evaluateWindowSweep knee rule", () => {
	test("names the smallest rung within 5% of the best, not the fastest one", () => {
		const rungs = [
			...ladder([
				{ perStream: 262144, mbps: 500 },
				{ perStream: 524288, mbps: 900 },
				{ perStream: 1048576, mbps: 980, bucket: "window-plateau" },
				{ perStream: 2097152, mbps: 1000, bucket: "window-plateau" },
			]),
		];
		const out = evaluateWindowSweep(rungs);
		expect(out.knee?.rung).toBe("W3");
		expect(out.knee?.perStream).toBe(1048576);
		// No falsifier rung here, so the memory half is withheld — and the knee,
		// which is a throughput statement, is unaffected by that.
		expect(out.stops.join(" ")).toContain("W-STOP-B");
		expect(out.stops.join(" ")).not.toContain("W-STOP-A");
	});

	test("refuses a knee when the top rung is still scaling, and says how far it got", () => {
		const rungs = ladder([
			{ perStream: 262144, mbps: 400 },
			{ perStream: 524288, mbps: 600 },
			{ perStream: 1048576, mbps: 900 },
			{ perStream: 2097152, mbps: 1400 },
		]);
		const out = evaluateWindowSweep(rungs);
		expect(out.knee).toBeNull();
		expect(out.kneeNote).toContain("did not bracket the knee");
		expect(out.kneeNote).toContain("2097152");
	});

	test("W-STOP-A fires below three complete rungs and yields no knee", () => {
		const rungs = ladder([
			{ perStream: 262144, mbps: 500 },
			{ perStream: 524288, mbps: 900 },
			{ perStream: 1048576, mbps: 980 },
		]);
		// biome-ignore lint/style/noNonNullAssertion: fixed-length synthetic ladder
		rungs[1]!.incomplete = true;
		// biome-ignore lint/style/noNonNullAssertion: fixed-length synthetic ladder
		rungs[1]!.bucket = "generator-saturated";
		const out = evaluateWindowSweep(rungs);
		expect(out.knee).toBeNull();
		expect(out.stops.join(" ")).toContain("W-STOP-A");
		expect(out.kneeNote).toContain("W-STOP-A");
	});

	test("the tie-in and the falsifier never compete for the knee", () => {
		const rungs = [
			...ladder([
				{ perStream: 262144, mbps: 500 },
				{ perStream: 524288, mbps: 980, bucket: "window-plateau" },
				{ perStream: 1048576, mbps: 1000, bucket: "window-plateau" },
			]),
			rung({
				rung: "W-a6",
				role: "tie-in",
				math: windowMath(16 * 1024 * 1024, 64 * 1024 * 1024, 4),
				deliveredMbps: 5000,
			}),
			rung({
				rung: "W-repeat",
				role: "retention-falsifier",
				deliveredMbps: 500,
				rssMbPeak: 150,
			}),
		];
		const out = evaluateWindowSweep(rungs);
		expect(out.knee?.rung).toBe("W2");
		// Both still appear in the curve; they are excluded from comparison only.
		expect(out.curve.map((c) => c.rung)).toContain("W-a6");
		expect(out.curve.map((c) => c.rung)).toContain("W-repeat");
	});
});

describe("evaluateWindowSweep retention falsifier", () => {
	const base = () =>
		ladder([
			{ perStream: 262144, mbps: 500 },
			{ perStream: 524288, mbps: 980, bucket: "window-plateau" },
			{ perStream: 1048576, mbps: 1000, bucket: "window-plateau" },
		]);

	test("CLEAN when the replayed first rung comes back within 20%", () => {
		const out = evaluateWindowSweep([
			...base(),
			rung({
				rung: "W-repeat",
				role: "retention-falsifier",
				rssMbBaseline: 120,
				rssMbPeak: 170,
			}),
		]);
		expect(out.memoryRetention).toBe("CLEAN");
		expect(out.rssDeltasReportable).toBe(true);
		expect(out.curve[0]?.observedRssMbDelta).toBe(50);
		expect(out.stops).toEqual([]);
	});

	test("CONTAMINATED when it stays up, and then no delta is quoted anywhere", () => {
		const out = evaluateWindowSweep([
			...base(),
			rung({
				rung: "W-repeat",
				role: "retention-falsifier",
				rssMbBaseline: 700,
				rssMbPeak: 800,
			}),
		]);
		expect(out.memoryRetention).toBe("CONTAMINATED");
		expect(out.stops.join(" ")).toContain("W-STOP-B");
		for (const row of out.curve) expect(row.observedRssMbDelta).toBeNull();
		// The advertised figures survive: they never depended on RSS.
		expect(out.curve[0]?.advertisedWorstCasePerSessionBytes).toBeGreaterThan(0);
		// A knee is still derivable; only the observed delta is withheld.
		expect(out.knee?.rung).toBe("W2");
		expect(out.knee?.observedRssMbDelta).toBeNull();
	});

	test("UNKNOWN, and W-STOP-B, when the falsifier rung is missing or incomplete", () => {
		expect(evaluateWindowSweep(base()).memoryRetention).toBe("UNKNOWN");
		const withIncomplete = evaluateWindowSweep([
			...base(),
			rung({
				rung: "W-repeat",
				role: "retention-falsifier",
				incomplete: true,
				bucket: "instrumentation-missing",
				rssMbPeak: 150,
			}),
		]);
		expect(withIncomplete.memoryRetention).toBe("UNKNOWN");
		expect(withIncomplete.stops.join(" ")).toContain("W-STOP-B");
	});
});
