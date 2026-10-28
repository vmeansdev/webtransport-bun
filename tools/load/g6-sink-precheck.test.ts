/**
 * The G6 sink pre-check, pinned before the producer exists (Task 1).
 *
 * The gate's V-S falsifier already refuses a run whose pre-check is missing,
 * under-driven, starved, or lossy. What it cannot verify is the pre-check's
 * own arithmetic: a producer that records its target as its floor — or its
 * floor as its offer — would pass V-S with a number that was never measured.
 *
 * This suite pins the producer's contract off the runner, before Task 2
 * writes the producer: the registered rate and its derived bitrate, the
 * payload, the exact saturation boundary, the requirement derived from
 * `g6-plan.ts` (the producer's floor is the evaluator's floor, never
 * re-typed), and an artifact that keeps required, target, and observed in
 * separate fields so a reader cannot mistake the target for the floor.
 *
 * Red by construction: `./g6-sink-precheck.ts` does not exist yet.
 *
 * Source of truth: the frozen plan's Task 1 pinned list
 * (docs/superpowers/plans/2026-08-23-g6-marginful-preflight.md @ e28c236)
 * and the approved spec (2026-08-22-g6-marginful-preflight-design.md @
 * f8a9de6). Not derived from any quarantined pre-approval material.
 */

import { describe, expect, test } from "bun:test";
import { armShape, gateRung, SINK_HEADROOM_FACTOR } from "./g6-plan.ts";
import {
	buildSinkPrecheckArtifact,
	originatorSaturated,
	SINK_PRECHECK_PAYLOAD_BYTES,
	SINK_PRECHECK_SATURATION_BOUNDARY_PPS,
	SINK_PRECHECK_TARGET_BPS,
	SINK_PRECHECK_TARGET_PPS,
	sinkPrecheckRequirement,
} from "./g6-sink-precheck.ts";

/**
 * The observed facts a completed pre-check run would hand the artifact
 * builder. The values are the registered run shape, not pinned contract:
 * the contract is what `buildSinkPrecheckArtifact` does with them. The
 * baseline is self-consistent like a real run: 120,000 pps × 30 s of
 * offered packets, a 0.99997 delivery ratio, an unreadable jitter tap.
 */
type PrecheckObs = Parameters<typeof buildSinkPrecheckArtifact>[0];

function precheckObs(over: Partial<PrecheckObs> = {}): PrecheckObs {
	return {
		offeredPps: 120_000,
		deliveryRatio: 0.99997,
		sentPackets: 3_600_000,
		lostPackets: 108,
		jitterMs: null,
		seconds: 30,
		rawEndSum: {},
		host: "probe-host",
		dateIso: "2026-08-23T12:00:00Z",
		...over,
	};
}

describe("sink pre-check — constants", () => {
	test("the registered rate, bitrate, payload, and saturation boundary", () => {
		expect(SINK_PRECHECK_TARGET_PPS).toBe(120_000);
		expect(SINK_PRECHECK_TARGET_BPS).toBe(192_000_000);
		expect(SINK_PRECHECK_PAYLOAD_BYTES).toBe(200);
		// The exact integer boundary stated by the design: 98% of 120,000.
		expect(SINK_PRECHECK_SATURATION_BOUNDARY_PPS).toBe(117_600);
		// 120,000 pps × 200 B × 8 bits: the bitrate is the rate's derivation.
		expect(SINK_PRECHECK_TARGET_BPS).toBe(
			SINK_PRECHECK_TARGET_PPS * SINK_PRECHECK_PAYLOAD_BYTES * 8,
		);
	});
});

describe("sink pre-check — requirement derivation", () => {
	test("the producer's floor is the evaluator's floor, derived never typed", () => {
		const r = sinkPrecheckRequirement();
		expect(r).toEqual({
			armDownstreamPps: 77_500,
			headroomFactor: 1.5,
			requiredPps: 116_250,
		});
		// Every field is a `g6-plan.ts` value, not a re-typed number:
		expect(r.armDownstreamPps).toBe(
			armShape(gateRung()).downstreamAggregatePps,
		);
		expect(r.headroomFactor).toBe(SINK_HEADROOM_FACTOR);
		expect(r.requiredPps).toBe(
			SINK_HEADROOM_FACTOR * armShape(gateRung()).downstreamAggregatePps,
		);
	});
});

describe("sink pre-check — saturation boundary", () => {
	test("the boundary is 0.98 × targetPps, stated as the exact integer", () => {
		// Spec: offeredPps < 0.98 × targetPps is the saturating side. The
		// boundary is the design's exact integer 117,600 — never a runtime
		// multiplication.
		expect(SINK_PRECHECK_SATURATION_BOUNDARY_PPS).toBe(117_600);
		expect(originatorSaturated(117_599.999)).toBe(true);
		expect(originatorSaturated(117_600)).toBe(false);
		expect(originatorSaturated(120_000)).toBe(false);
	});
});

describe("sink pre-check — artifact", () => {
	test("required, target, and observed live in separate fields", () => {
		// A real run: the offer landed under the target but above the floor,
		// and the delivery ratio cleared the bar.
		const artifact = buildSinkPrecheckArtifact(
			precheckObs({ offeredPps: 119_831.5, sentPackets: 3_594_945 }),
		);
		expect(artifact.requiredPps).toBe(116_250);
		expect(artifact.targetPps).toBe(120_000);
		expect(artifact.targetBps).toBe(192_000_000);
		expect(artifact.precheckOfferedPps).toBe(119_831.5);
		expect(artifact.precheckDeliveryRatio).toBe(0.99997);
		expect(artifact.precheckOriginatorSaturated).toBe(false);
	});

	test("the margins between the recorded constants and the floor are positive", () => {
		// 117,600 > 116,250 and 120,000 > 116,250: the margin between the
		// saturation boundary and the floor is recorded, not implicit.
		const artifact = buildSinkPrecheckArtifact(precheckObs());
		expect(Number(artifact.targetPps) > Number(artifact.requiredPps)).toBe(
			true,
		);
		expect(
			Number(artifact.saturationBoundaryPps) > Number(artifact.requiredPps),
		).toBe(true);
	});

	test("a saturating observed offer propagates to precheckOriginatorSaturated", () => {
		// 100,000 is below the 117,600 boundary: a starved generator must be
		// recorded as saturated, not read as a healthy 100k.
		const artifact = buildSinkPrecheckArtifact(
			precheckObs({
				offeredPps: 100_000,
				sentPackets: 3_000_000,
				lostPackets: 90,
			}),
		);
		expect(artifact.precheckOriginatorSaturated).toBe(true);
	});

	test("kind is stable and the instrument string names the target, not the floor", () => {
		const artifact = buildSinkPrecheckArtifact(precheckObs());
		expect(artifact.kind).toBe("g6-sink-precheck");
		const instrument = String(artifact.instrument);
		expect(instrument).toContain("120000 pps");
		expect(instrument).toContain("192.0 Mbit/s");
	});
});
