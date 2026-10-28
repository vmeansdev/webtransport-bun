import { describe, expect, test } from "bun:test";

import { __TESTING__ } from "../../packages/webtransport/src/index.ts";
import {
	ARM_BATCH_SIZES,
	armFailures,
	BASELINE_BATCH_SIZE,
	buildArtifact,
	CALLBACK_ARM_NAME,
	diagnosticsFailures,
	evaluateGate,
	GATE_BATCH_SIZE,
	generatorArmName,
	identityFailures,
	MIN_GENERATOR_RATE,
	MIN_MEDIAN_SPEEDUP,
	makeRng,
	median,
	minimum,
	PRODUCTION_ITERATOR,
	parseDiagnosticsRequest,
	SAMPLE_COUNT,
	shuffled,
	summarizeArm,
} from "./datagram-delivery-floor.ts";

const GATE_ARM = generatorArmName(GATE_BATCH_SIZE);
const BASELINE_ARM = generatorArmName(BASELINE_BATCH_SIZE);

/** Seven samples that all sit at `rate`, so a test moves exactly one number. */
function flatSamples(rate: number): number[] {
	return Array.from({ length: SAMPLE_COUNT }, () => rate);
}

function arms(options: {
	gate?: number[];
	baseline?: number[];
	callback?: number[];
}) {
	return [
		summarizeArm(
			BASELINE_ARM,
			BASELINE_BATCH_SIZE,
			options.baseline ?? flatSamples(30_000),
		),
		summarizeArm(
			GATE_ARM,
			GATE_BATCH_SIZE,
			options.gate ?? flatSamples(200_000),
		),
		summarizeArm(
			CALLBACK_ARM_NAME,
			GATE_BATCH_SIZE,
			options.callback ?? flatSamples(250_000),
		),
	];
}

describe("the arm under measurement", () => {
	test("is the shipped generator itself, not a copy of it", () => {
		expect(PRODUCTION_ITERATOR).toBe(
			__TESTING__.createIncomingDatagramIteratorForTests,
		);
	});

	test("measures the intended default batch size against a batch of one", () => {
		expect(GATE_BATCH_SIZE).toBe(64);
		expect(BASELINE_BATCH_SIZE).toBe(1);
		expect(ARM_BATCH_SIZES).toEqual([1, 16, 64, 256]);
	});

	test("this process resolved diagnostics off, so the plain loop is bound", () => {
		expect(__TESTING__.datagramBatchConfigForTests().diagnosticsEnabled).toBe(
			false,
		);
	});
});

describe("diagnostics-mode refusal", () => {
	test("parses the requested state without treating absence as enabled", () => {
		expect(parseDiagnosticsRequest(undefined)).toBe(false);
		expect(parseDiagnosticsRequest("")).toBe(false);
		expect(parseDiagnosticsRequest("0")).toBe(false);
		expect(parseDiagnosticsRequest("true")).toBe(false);
		expect(parseDiagnosticsRequest("1")).toBe(true);
	});

	test("refuses when the environment asks for the instrumented twin", () => {
		expect(diagnosticsFailures({ requested: true, resolved: false })).toEqual([
			expect.stringContaining("WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS"),
		]);
	});

	test("refuses when the library resolved the instrumented twin", () => {
		expect(
			diagnosticsFailures({ requested: false, resolved: true }).length,
		).toBe(1);
	});

	test("accepts only the branch-free production loop", () => {
		expect(diagnosticsFailures({ requested: false, resolved: false })).toEqual(
			[],
		);
	});
});

describe("identity refusal", () => {
	test("accepts a clean tree whose HEAD is the candidate", () => {
		expect(
			identityFailures({ head: "abc", candidate: "abc", dirty: false }),
		).toEqual([]);
	});

	test("refuses a dirty tree", () => {
		expect(
			identityFailures({ head: "abc", candidate: "abc", dirty: true }),
		).toEqual([expect.stringContaining("dirty")]);
	});

	test("refuses a HEAD that is not the candidate", () => {
		expect(
			identityFailures({ head: "abc", candidate: "def", dirty: false }),
		).toEqual([expect.stringContaining("does not match candidate")]);
	});

	test("refuses when HEAD could not be read at all", () => {
		expect(
			identityFailures({ head: "", candidate: "", dirty: false }).length,
		).toBe(1);
	});
});

describe("aggregation", () => {
	test("median is the middle order statistic, not the mean", () => {
		expect(median([1, 2, 3, 4, 100])).toBe(3);
	});

	test("median does not disturb the caller's array", () => {
		const samples = [5, 1, 3];
		median(samples);
		expect(samples).toEqual([5, 1, 3]);
	});

	test("median of an even count averages the two middles", () => {
		expect(median([1, 2, 3, 4])).toBe(2.5);
	});

	test("minimum reports the worst sample", () => {
		expect(minimum([9, 2, 7])).toBe(2);
	});

	test("summarizing keeps every individual sample", () => {
		const arm = summarizeArm(GATE_ARM, 64, [7, 1, 5, 3, 9, 2, 8]);
		expect(arm.samples).toEqual([7, 1, 5, 3, 9, 2, 8]);
		expect(arm.median).toBe(5);
		expect(arm.min).toBe(1);
	});
});

describe("sample validation fails closed", () => {
	test("accepts exactly the required sample count", () => {
		expect(armFailures(summarizeArm(GATE_ARM, 64, flatSamples(1)))).toEqual([]);
	});

	test("refuses too few samples", () => {
		expect(
			armFailures(summarizeArm(GATE_ARM, 64, flatSamples(1).slice(1))).length,
		).toBe(1);
	});

	test("refuses too many samples", () => {
		expect(
			armFailures(summarizeArm(GATE_ARM, 64, [...flatSamples(1), 1])).length,
		).toBe(1);
	});

	test("refuses a non-finite sample", () => {
		const samples = flatSamples(1);
		samples[2] = Number.POSITIVE_INFINITY;
		expect(armFailures(summarizeArm(GATE_ARM, 64, samples))).toEqual([
			expect.stringContaining("non-finite"),
		]);
	});

	test("refuses a NaN sample", () => {
		const samples = flatSamples(1);
		samples[0] = Number.NaN;
		expect(armFailures(summarizeArm(GATE_ARM, 64, samples)).length).toBe(1);
	});

	test("refuses a non-positive sample, which cannot be a rate", () => {
		const samples = flatSamples(1);
		samples[6] = 0;
		expect(armFailures(summarizeArm(GATE_ARM, 64, samples)).length).toBe(1);
	});
});

describe("gate condition 1 — minimum rate at the default batch size", () => {
	test("passes when the worst sample sits exactly on the floor", () => {
		const samples = flatSamples(200_000);
		samples[4] = MIN_GENERATOR_RATE;
		const gate = evaluateGate(arms({ gate: samples }));
		expect(gate.conditions[0]?.pass).toBe(true);
		expect(gate.conditions[0]?.measured).toBe(MIN_GENERATOR_RATE);
	});

	test("fails when the worst sample sits just below the floor", () => {
		const samples = flatSamples(200_000);
		samples[4] = MIN_GENERATOR_RATE - 1;
		const gate = evaluateGate(arms({ gate: samples }));
		expect(gate.conditions[0]?.pass).toBe(false);
		expect(gate.failures.length).toBe(1);
	});

	test("a fast median cannot rescue one slow sample", () => {
		const samples = flatSamples(5_000_000);
		samples[0] = MIN_GENERATOR_RATE - 0.5;
		expect(evaluateGate(arms({ gate: samples })).conditions[0]?.pass).toBe(
			false,
		);
	});
});

describe("gate condition 2 — median speedup over batch=1", () => {
	test("passes at exactly the required ratio", () => {
		const gate = evaluateGate(
			arms({
				baseline: flatSamples(100_000),
				gate: flatSamples(100_000 * MIN_MEDIAN_SPEEDUP),
			}),
		);
		expect(gate.conditions[1]?.measured).toBe(MIN_MEDIAN_SPEEDUP);
		expect(gate.conditions[1]?.pass).toBe(true);
	});

	test("fails just below the required ratio", () => {
		const gate = evaluateGate(
			arms({
				baseline: flatSamples(100_000),
				gate: flatSamples(199_999),
			}),
		);
		expect(gate.conditions[1]?.pass).toBe(false);
		expect(gate.failures.length).toBe(1);
	});

	test("clearing the absolute floor does not imply clearing the ratio", () => {
		const gate = evaluateGate(
			arms({
				baseline: flatSamples(1_000_000),
				gate: flatSamples(1_500_000),
			}),
		);
		expect(gate.conditions[0]?.pass).toBe(true);
		expect(gate.conditions[1]?.pass).toBe(false);
	});
});

describe("the diagnostic arms are not alternate ways to pass", () => {
	test("a spectacular callback arm cannot rescue a failing gate", () => {
		const gate = evaluateGate([
			...arms({ gate: flatSamples(10_000), callback: flatSamples(9_000_000) }),
			summarizeArm(generatorArmName(256), 256, flatSamples(9_000_000)),
		]);
		expect(gate.failures.length).toBe(2);
	});

	test("a missing gate arm is a refusal, not a skip", () => {
		const gate = evaluateGate([
			summarizeArm(BASELINE_ARM, 1, flatSamples(30_000)),
		]);
		expect(gate.failures.length).toBe(2);
		// Both, individually: a condition that cannot be computed must refuse,
		// not fall through to true because its inputs were missing.
		expect(gate.conditions[0]?.pass).toBe(false);
		expect(gate.conditions[1]?.pass).toBe(false);
		expect(gate.conditions[1]?.measured).toBe(null);
	});
});

describe("arm ordering", () => {
	test("the shuffle is seeded, so a recorded run is reproducible", () => {
		const input = ["a", "b", "c", "d", "e"];
		expect(shuffled(input, makeRng(7))).toEqual(shuffled(input, makeRng(7)));
	});

	test("the shuffle does not disturb the caller's array", () => {
		const input = ["a", "b", "c", "d", "e"];
		shuffled(input, makeRng(3));
		expect(input).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("the shuffle is a permutation, never a resample", () => {
		const input = ["a", "b", "c", "d", "e"];
		for (let seed = 0; seed < 50; seed += 1) {
			expect([...shuffled(input, makeRng(seed))].sort()).toEqual([...input]);
		}
	});

	test("different seeds do produce different orders", () => {
		const input = ["a", "b", "c", "d", "e"];
		const orders = new Set(
			Array.from({ length: 30 }, (_, seed) =>
				shuffled(input, makeRng(seed)).join(""),
			),
		);
		expect(orders.size).toBeGreaterThan(1);
	});
});

describe("the artifact", () => {
	const identity = {
		head: "abc",
		candidate: "abc",
		candidateBinding: "external" as const,
		dirty: false,
		bunVersion: "1.3.14",
		platform: "darwin/arm64",
		machine: "test",
		command: "bun run bench:h7-floor",
	};

	test("is a pass only when nothing refused and both conditions hold", () => {
		const artifact = buildArtifact({
			identity,
			diagnostics: { requested: false, resolved: false },
			arms: arms({}),
			rounds: [],
			shuffleSeed: 1,
		});
		expect(artifact.status).toBe("pass");
		expect(artifact.failures).toEqual([]);
		expect(artifact.gate.every((c) => c.pass)).toBe(true);
	});

	test("records every sample, the medians and the minimums", () => {
		const artifact = buildArtifact({
			identity,
			diagnostics: { requested: false, resolved: false },
			arms: arms({}),
			rounds: [],
			shuffleSeed: 1,
		});
		const gateArm = artifact.arms.find((a) => a.name === GATE_ARM);
		expect(gateArm?.samples.length).toBe(SAMPLE_COUNT);
		expect(gateArm?.median).toBe(200_000);
		expect(gateArm?.min).toBe(200_000);
	});

	test("records identity, command and both diagnostics states", () => {
		const artifact = buildArtifact({
			identity,
			diagnostics: { requested: false, resolved: false },
			arms: arms({}),
			rounds: [],
			shuffleSeed: 1,
		});
		expect(artifact.head).toBe("abc");
		expect(artifact.dirty).toBe(false);
		expect(artifact.bunVersion).toBe("1.3.14");
		expect(artifact.command).toBe("bun run bench:h7-floor");
		expect(artifact.diagnostics).toEqual({ requested: false, resolved: false });
	});

	test("a dirty tree fails the artifact even with perfect numbers", () => {
		const artifact = buildArtifact({
			identity: { ...identity, dirty: true },
			diagnostics: { requested: false, resolved: false },
			arms: arms({}),
			rounds: [],
			shuffleSeed: 1,
		});
		expect(artifact.status).toBe("fail");
		expect(artifact.gate.every((c) => c.pass)).toBe(true);
	});

	test("diagnostics enabled fails the artifact even with perfect numbers", () => {
		const artifact = buildArtifact({
			identity,
			diagnostics: { requested: true, resolved: true },
			arms: arms({}),
			rounds: [],
			shuffleSeed: 1,
		});
		expect(artifact.status).toBe("fail");
	});

	test("a bad sample count fails the artifact", () => {
		const artifact = buildArtifact({
			identity,
			diagnostics: { requested: false, resolved: false },
			arms: [
				summarizeArm(BASELINE_ARM, 1, flatSamples(30_000)),
				summarizeArm(GATE_ARM, 64, [200_000, 200_000]),
			],
			rounds: [],
			shuffleSeed: 1,
		});
		expect(artifact.status).toBe("fail");
	});
});
