import { describe, expect, test } from "bun:test";
import {
	parseNativeSendPath,
	readNativeSendPath,
} from "./g6-native-send-path.ts";

export function nativeFixture(finalized = false) {
	const names = ["unarmed", "connect", "steady", "drain", "idle"];
	return {
		schema: "g6-native-send-path/1",
		enabled: true,
		finalized,
		phase: "idle",
		monoNs: "10000",
		phaseOrder: names,
		bucketUpperBoundsNs: Array.from({ length: 31 }, (_, i) => 1000 * 2 ** i),
		errors: 0,
		components: [
			{
				kind: "reflector",
				createdNs: "1",
				createdPhase: "connect",
				phase: "idle",
				errors: 0,
				cuts: ["steady", "drain", "idle"].map((phase, i) => ({
					phase,
					beginNs: String(10 + i * 10),
					endNs: String(11 + i * 10),
				})),
				phases: names.slice(1).map((phase) => ({
					phase,
					intervals: [
						"reflectQueueWait",
						"reflectSendCall",
						"ringFull",
						"flusherEagain",
						"udpQueueWait",
					].map((name) => ({
						name,
						histogram: {
							count: 0,
							buckets: Array(32).fill(0) as number[],
							crossedPhase: 0,
							outstanding: 0,
							censored: 0,
							rejected: 0,
							overflow: 0,
						},
					})),
				})),
				gauges: [
					"reflectReservedSlots",
					"udpPendingPackets",
					"udpPendingBytes",
					"waiterRegistrations",
				].map((name) => ({
					name,
					gauge: { current: 0, phase: 4, phaseHighWater: [0, 0, 0, 0, 0] },
				})),
			},
		],
	};
}

describe("native send-path raw validation", () => {
	test("validates complete structure without deltaing histograms or erasing old-origin completion", () => {
		const raw = nativeFixture(true);
		const hist = raw.components[0]!.phases[0]!.intervals[0]!.histogram;
		hist.count = 1;
		hist.buckets[13] = 1;
		hist.crossedPhase = 1;
		const got = parseNativeSendPath(raw, {
			enabled: true,
			phase: "idle",
			finalized: true,
		});
		expect(JSON.stringify(got)).toEqual(JSON.stringify(raw));
	});
	const invalidMutations: Array<(x: ReturnType<typeof nativeFixture>) => void> =
		[
			(x: ReturnType<typeof nativeFixture>) => {
				x.schema = "unknown";
			},
			(x) => {
				x.errors = 1;
			},
			(x) => {
				x.components[0]!.errors = 1;
			},
			(x) => {
				x.components[0]!.cuts[0]!.beginNs = "10001";
			},
			(x) => {
				x.components[0]!.cuts[0]!.phase = "connect";
			},
			(x) => {
				x.components[0]!.createdPhase = "idle";
			},
			(x) => {
				x.components[0]!.phases[0]!.intervals[0]!.histogram.count = 1;
			},
			(x) => {
				x.components[0]!.phases[0]!.intervals[0]!.histogram.buckets[0] = -1;
			},
			(x) => {
				x.components[0]!.phases[0]!.intervals[0]!.histogram.outstanding = 1;
			},
			(x) => {
				x.components[0]!.gauges[0]!.gauge.current = 1;
			},
			(x) => {
				x.components[0]!.gauges[0]!.gauge.phaseHighWater[0] = 2;
			},
			(x) => {
				x.components[0]!.gauges[0]!.gauge.phase = 3;
			},
		];
	test.each(
		invalidMutations,
	)("rejects malformed, racing, forged or unclosed evidence", (mutate) => {
		const raw = nativeFixture(true);
		mutate(raw);
		expect(() =>
			parseNativeSendPath(raw, {
				enabled: true,
				phase: "idle",
				finalized: true,
			}),
		).toThrow();
	});
	test("absence is not explicit off; off cannot carry armed counters", () => {
		expect(() => parseNativeSendPath(undefined, { enabled: false })).toThrow();
		const raw = nativeFixture();
		raw.enabled = false;
		expect(() => parseNativeSendPath(raw, { enabled: false })).toThrow();
	});
	test("requires snapshot phase and finality, not just a schema tag", () => {
		expect(() =>
			parseNativeSendPath(nativeFixture(), { enabled: true, finalized: true }),
		).toThrow();
		expect(() =>
			parseNativeSendPath(nativeFixture(), { enabled: true, phase: "steady" }),
		).toThrow();
	});
	test("bounded controller retries only busy/quiescence and never hides another error", async () => {
		let time = 0,
			calls = 0;
		const deps = {
			nowMs: () => time,
			sleepMs: async (n: number) => {
				time += n;
			},
			timeoutMs: 5,
		};
		const got = await readNativeSendPath(
			() => {
				if (calls++ === 0)
					throw Error(
						"E_INTERNAL native diagnostic cut busy; retry within the boundary deadline",
					);
				return JSON.stringify(nativeFixture(true));
			},
			"closed",
			true,
			deps,
		);
		expect(got.finalized).toBe(true);
		expect(calls).toBe(2);
		await expect(
			readNativeSendPath(
				() => {
					throw Error("native diagnostic cut busy");
				},
				"closed",
				true,
				deps,
			),
		).rejects.toThrow("deadline");
		await expect(
			readNativeSendPath(
				() => {
					throw Error("unknown native diagnostic phase");
				},
				"closed",
				true,
				deps,
			),
		).rejects.toThrow("unknown native diagnostic phase");
		await expect(
			readNativeSendPath(undefined, "closed", false, deps),
		).rejects.toThrow("missing");
	});
});
