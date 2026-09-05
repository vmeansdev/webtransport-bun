import { expect, test } from "bun:test";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import { validateNative as attributionNative } from "./g6-c32-send-path-evaluate.ts";
import {
	workGradeFixture,
	workProbeFixture,
	workProfileFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import {
	validateCapacityDiagnosticCoverage,
	validateNative,
} from "./g6-capacity-diagnostic-coverage.ts";
import { validateCapacityDiagnosticCoverage as finalCoverage } from "./g6-capacity-goal-adapters.ts";
import { linuxProbeFixtureText } from "./g6-linux-probe-fixture.ts";
import { parseLinuxProbeJsonl } from "./g6-sharded-diagnostic.ts";

function fixture(detailedProbe = true) {
	const input = workGradeFixture({
		profile: { ...workProfileFixture, shards: 1, detailedProbe },
	});
	return { ...input, probeText: input.probe };
}

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
