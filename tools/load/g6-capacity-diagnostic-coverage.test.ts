import { expect, test } from "bun:test";
import captured from "./fixtures/g6-native-boundaries-a0-1.json";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import { validateNative as attributionNative } from "./g6-c32-send-path-evaluate.ts";
import {
	nativeShardFixture,
	workGradeFixture,
	workProbeFixture,
	workProfileFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import type { WorkProfile } from "./g6-c32-work-profile.ts";
import {
	coverageSpans,
	validateCapacityDiagnosticCoverage,
	validateNative,
} from "./g6-capacity-diagnostic-coverage.ts";
import { validateCapacityDiagnosticCoverage as finalCoverage } from "./g6-capacity-goal-adapters.ts";
import type { ArmsRawShape } from "./g6-capacity-raw-work.ts";
import { linuxProbeFixtureText } from "./g6-linux-probe-fixture.ts";
import { parseLinuxProbeJsonl } from "./g6-sharded-diagnostic.ts";

function fixture(detailedProbe = true) {
	const input = workGradeFixture({
		profile: { ...workProfileFixture, shards: 1, detailedProbe },
	});
	return { ...input, probeText: input.probe };
}

function capturedInput() {
	const udpSendBatch = captured.profile.udpSendBatch;
	if (udpSendBatch !== 0 && udpSendBatch !== 64)
		throw Error("invalid captured batch profile");
	return {
		diagnostic: structuredClone(captured.diagnostic),
		profile: {
			...workProfileFixture,
			...captured.profile,
			udpSendBatch,
			detailedProbe: false,
		} satisfies WorkProfile,
		producer: captured.nativeProducerSha256,
	};
}

test("captured real producer includes a separate idle stop observation", () => {
	const input = capturedInput();
	expect(captured.provenance.rawSha256).toBe(
		"269e9b8b106b9b6e5f4bd74bdc227d17fc5f029655d504d544c12cfd214f2be2",
	);
	expect(
		Object.keys(
			requireDefined(input.diagnostic.sendPathDiagnostics.shards[0]).boundaries,
		),
	).toEqual(["unarmed", "connect", "steady", "drain", "idle", "stop"]);
	expect(
		validateNative(input.diagnostic, input.profile, input.producer),
	).toHaveLength(1);
});

test.each([
	"missing",
	"unknown",
	"phase",
	"finalized",
	"before-idle",
	"after-final",
] as const)("captured producer rejects invalid stop observation: %s", (defect) => {
	const baseline = JSON.stringify(captured);
	const input = capturedInput();
	const shard = requireDefined(input.diagnostic.sendPathDiagnostics.shards[0]);
	switch (defect) {
		case "missing":
			Reflect.deleteProperty(shard.boundaries, "stop");
			break;
		case "unknown":
			Object.assign(shard.boundaries, { unknown: shard.boundaries.stop });
			break;
		case "phase":
			shard.boundaries.stop.phase = "drain";
			break;
		case "finalized":
			shard.boundaries.stop.finalized = true;
			break;
		case "before-idle":
			shard.boundaries.stop.monoNs = String(
				BigInt(shard.boundaries.idle.monoNs) - 1n,
			);
			break;
		case "after-final":
			shard.boundaries.stop.monoNs = String(BigInt(shard.final.monoNs) + 1n);
			break;
	}
	expect(() =>
		validateNative(input.diagnostic, input.profile, input.producer),
	).toThrow();
	expect(JSON.stringify(captured)).toBe(baseline);
});

test("stop ordering permits equal timestamps without weakening actual phase transitions", () => {
	const input = capturedInput();
	const shard = requireDefined(input.diagnostic.sendPathDiagnostics.shards[0]);
	shard.boundaries.stop = structuredClone(shard.boundaries.idle);
	expect(() =>
		validateNative(input.diagnostic, input.profile, input.producer),
	).not.toThrow();
	shard.final.monoNs = shard.boundaries.stop.monoNs;
	expect(() =>
		validateNative(input.diagnostic, input.profile, input.producer),
	).not.toThrow();
	shard.boundaries.drain.monoNs = shard.boundaries.steady.monoNs;
	expect(() =>
		validateNative(input.diagnostic, input.profile, input.producer),
	).toThrow();
});

test("shared coverage preserves exact online/final function identity", () => {
	expect(finalCoverage).toBe(validateCapacityDiagnosticCoverage);
	expect(attributionNative).toBe(validateNative);
	for (const detailedProbe of [false, true])
		expect(() =>
			validateCapacityDiagnosticCoverage(fixture(detailedProbe)),
		).not.toThrow();
});

test("shared coverage returns its validated native and probe data for one-pass raw reuse", () => {
	for (const detailedProbe of [false, true]) {
		const input = fixture(detailedProbe);
		const parsed = validateCapacityDiagnosticCoverage(input);
		expect(parsed).toBeDefined();
		expect(parsed.native).toHaveLength(1);
		expect(parsed.native[0]).toBe(
			requireDefined(input.diagnostic.sendPathDiagnostics.shards[0]).final,
		);
		if (detailedProbe) {
			expect(parsed.probe?.producerSha256).toBe(input.probeProducerSha256);
			expect(parsed.probe?.phaseCoverage.steady).toEqual({
				queueSamples: 12000,
				schedSamples: 2400,
			});
		} else expect(parsed.probe).toBeNull();
	}
});

test("shared coverage rejects reversed native boundaries and absent or censored observations", () => {
	for (const defect of ["reversed", "absent", "censored"] as const) {
		const input = fixture();
		const shards = input.diagnostic.sendPathDiagnostics.shards;
		if (defect === "reversed")
			requireDefined(shards[0]).boundaries.drain.monoNs = "1";
		else
			for (const shard of shards)
				for (const component of shard.final.components)
					for (const phase of component.phases)
						for (const interval of phase.intervals) {
							if (defect === "censored") interval.histogram.censored = 1;
							else {
								interval.histogram.count = 0;
								interval.histogram.buckets.fill(0);
							}
						}
		expect(() => validateCapacityDiagnosticCoverage(input)).toThrow();
	}
});

test("shared coverage rejects internally valid 50ms probe phases", () => {
	const input = fixture();
	input.probeText = workProbeFixture(input.operation.startedAt, 1, 50);
	expect(() =>
		parseLinuxProbeJsonl(requireDefined(input.probeText)),
	).not.toThrow();
	expect(() => validateCapacityDiagnosticCoverage(input)).toThrow(
		/rated workload/,
	);
});

test.each([
	"start",
	"end",
] as const)("shared coverage rejects internally valid paired samples that miss the steady %s", (edge) => {
	const input = fixture();
	const rows = requireDefined(input.probeText)
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const originalSummary = requireDefined(rows.at(-1));
	const steady = BigInt(originalSummary.phaseBoundaries.steady.monotonicNs);
	const drain = BigInt(originalSummary.phaseBoundaries.drain.monotonicNs);
	const removed = { queue: 0, sched: 0 };
	const retained = rows.filter((row) => {
		for (const kind of ["queue", "sched"] as const)
			if (
				row.phase === "steady" &&
				row.schema === `g6-c32-linux-probe-${kind}/2` &&
				(edge === "start"
					? BigInt(row.monotonicNs) < steady + 100_000_000n
					: BigInt(row.monotonicNs) > drain - 100_000_000n)
			) {
				removed[kind]++;
				return false;
			}
		return true;
	});
	expect(removed).toEqual({ queue: 10, sched: 2 });
	const summary = requireDefined(retained.at(-1));
	for (const kind of ["queue", "sched"] as const) {
		summary[`${kind}Samples`] -= removed[kind];
		summary.phaseCoverage.steady[`${kind}Samples`] -= removed[kind];
	}
	input.probeText = linuxProbeFixtureText(retained);
	expect(() =>
		parseLinuxProbeJsonl(requireDefined(input.probeText)),
	).not.toThrow();
	expect(() => validateCapacityDiagnosticCoverage(input)).toThrow(
		/samples do not span/,
	);
});

test("shared coverage binds probe source and operation timing independently", () => {
	const input = fixture();
	expect(() =>
		validateCapacityDiagnosticCoverage({
			...input,
			probeProducerSha256: "e".repeat(64),
		}),
	).toThrow(/source/);
	input.operation.startedAt = new Date(
		Date.parse(input.operation.startedAt) + 1000,
	).toISOString();
	expect(() => validateCapacityDiagnosticCoverage(input)).toThrow(/escaped/);
});

test("shared coverage needs a full successful operation even when probe is off", () => {
	const input = fixture(false);
	input.operation.durationMonotonicNs = "50000000";
	expect(() => validateCapacityDiagnosticCoverage(input)).toThrow(/operation/);
});

const HOTSPOT: ArmsRawShape = {
	arm: "hotspot",
	cohort: 0,
	raidTargetSlot: 0,
	steadySeconds: 120,
	drainToIdleMs: null,
};
const STORM: ArmsRawShape = {
	arm: "storm",
	cohort: 1000,
	raidTargetSlot: 0,
	steadySeconds: 60,
	drainToIdleMs: 182_000,
};

test("coverage spans per kind: steady path and hotspot unchanged, storm 60 s + 182 s", () => {
	expect(coverageSpans(null)).toEqual({
		steadyMs: 120_000,
		drainToIdleMs: null,
	});
	expect(coverageSpans(HOTSPOT)).toEqual({
		steadyMs: 120_000,
		drainToIdleMs: null,
	});
	expect(coverageSpans(STORM)).toEqual({
		steadyMs: 60_000,
		drainToIdleMs: 182_000,
	});
});

test("native coverage takes the kind's spans; the steady-path default is unchanged", () => {
	const input = fixture(false);
	const args = [input.diagnostic, input.profile, "c".repeat(64)] as const;
	expect(validateNative(...args)).toHaveLength(1);
	expect(validateNative(...args, HOTSPOT)).toHaveLength(1);
	expect(() => validateNative(...args, STORM)).toThrow(
		"native steady phase does not span the rated window",
	);
	// Storm-shaped native phases: 60 s steady, then the 182 s storm drain.
	const shard = requireDefined(input.diagnostic.sendPathDiagnostics.shards[0]);
	input.diagnostic.sendPathDiagnostics.shards[0] = nativeShardFixture(
		shard.serverId,
		shard.pid,
		input.profile.udpSendBatch,
		[1n, 100_000_000n, 150_000_000n, 60_150_000_000n, 242_150_000_000n],
	);
	expect(validateNative(...args, STORM)).toHaveLength(1);
	expect(() => validateNative(...args)).toThrow(
		"native steady phase does not span the rated window",
	);
	expect(() =>
		validateNative(...args, { ...STORM, drainToIdleMs: 100_000 }),
	).toThrow("native drain phase does not span the registered storm");
});

test("the Linux probe storm drain span is checked too (latent twin)", () => {
	const input = fixture(true);
	expect(
		validateCapacityDiagnosticCoverage({ ...input, arms: HOTSPOT }).probe,
	).not.toBeNull();
	// Native steady 120 s and a 182 s storm drain, so the native check passes
	// and the probe's short drain->idle is what fails.
	const shard = requireDefined(input.diagnostic.sendPathDiagnostics.shards[0]);
	input.diagnostic.sendPathDiagnostics.shards[0] = nativeShardFixture(
		shard.serverId,
		shard.pid,
		input.profile.udpSendBatch,
		[1n, 100_000_000n, 150_000_000n, 120_150_000_000n, 302_150_000_000n],
	);
	expect(() =>
		validateCapacityDiagnosticCoverage({
			...input,
			arms: { ...STORM, steadySeconds: 120 },
		}),
	).toThrow("Linux drain phase does not cover the registered storm");
});
