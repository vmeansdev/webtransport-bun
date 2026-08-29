/**
 * Tests for the leg-to-arm mapper.
 *
 * Phase 2.4 Commit 2 lands `measuredLegToArm` as a pure sync
 * join: the campaign loop's async `measureArm` calls it once
 * it has read the leg, the server snapshot, and the supervisor
 * context. These tests pin the mapper's contract:
 *
 * - the join is structural (every required field surfaces, no
 *   field is invented),
 * - missing inputs are typed refusals, not silent defaults,
 * - non-finite loop utilization values fail closed,
 * - the supervisor's fields pass through unmodified (the mapper
 *   does not "improve" them).
 *
 * The tests are deterministic: no real clock, no I/O, no process.
 * The mapper is a pure function and the tests treat it as one.
 */
import { describe, expect, it } from "bun:test";

import {
	type ArmMeasureInput,
	type ArmMeasureSupervisorContext,
	measuredLegToArm,
} from "./arm-measure.ts";
import { R1_FIXTURE_TOOLCHAINS } from "./r1-fixtures.ts";
import {
	MEASUREMENT_GRANT_SCHEMA,
	type MeasurementGrantV1,
} from "./evidence.ts";
import type { MeasuredLeg } from "./client.ts";
import type { ServerSnapshotRecord } from "./server-snapshot-protocol.ts";
import { SERVER_SNAPSHOT_SCHEMA } from "./server-snapshot-protocol.ts";

const FIXED_NOW = 1_700_000_000_000;

function sampleLeg(overrides: Partial<MeasuredLeg> = {}): MeasuredLeg {
	return {
		sampleUnit: "ms",
		samples: [1, 2, 3, 4],
		percentiles: { p1: 1, p50: 2, p95: 3.5, p99: 3.9 },
		ledger: {
			attempted: 4,
			queued: 0,
			serverObserved: 4,
			acknowledged: 4,
			delivered: 4,
			dropped: 0,
			expired: 0,
			harnessOverheadBytes: 0,
			histogram: {
				unit: "ms",
				boundaries: [1, 2, 4],
				counts: [1, 2, 1],
			},
		},
		admissionCounters: {
			handshakesInFlight: 0,
			handshakesAttempted: 1,
			handshakesAccepted: 1,
			handshakesRejected: 0,
			datagramsAccepted: 0,
			datagramsRejected: 0,
			tokenBucketRejected: 0,
		},
		provenance: {
			attestation: "att-token-1",
			driverRunId: "run-1",
			clockMethod: "performance.timeOrigin+performance.now",
			sampleCount: 4,
			firstSampleAtMs: FIXED_NOW,
			lastSampleAtMs: FIXED_NOW + 4,
		},
		loopUtilization: { busyMs: 2, windowMs: 4 },
		roundTrips: [],
		...overrides,
	} as MeasuredLeg;
}

function sampleSnapshot(
	overrides: Partial<ServerSnapshotRecord> = {},
): ServerSnapshotRecord {
	return {
		schema: SERVER_SNAPSHOT_SCHEMA,
		campaignId: "camp-1",
		runId: "run-1",
		executionIndex: 1,
		transport: "ws",
		legId: "leg-1",
		sequence: 1,
		capturedAtMs: FIXED_NOW,
		loopUtilization: { busyMs: 3, windowMs: 5 },
		...overrides,
	};
}

function sampleGrant(
	overrides: Partial<MeasurementGrantV1> = {},
): MeasurementGrantV1 {
	return {
		schema: MEASUREMENT_GRANT_SCHEMA,
		campaignId: "camp-1",
		candidate: "arm-measure-candidate",
		declaredMessageBytes: 1_024,
		declaredMessageCount: 4_096,
		executionIndex: 1,
		issuedAt: FIXED_NOW,
		nonceSha256: "0".repeat(64),
		notAfter: FIXED_NOW + 15 * 60 * 1_000,
		runId: "run-1",
		transport: "ws",
		...overrides,
	};
}

function sampleContext(
	overrides: Partial<ArmMeasureSupervisorContext> = {},
): ArmMeasureSupervisorContext {
	return {
		toolchains: R1_FIXTURE_TOOLCHAINS,
		telemetry: {
			mac: { cpuPercent: 12, rssBytes: 100 * 1024 * 1024 },
			linux: { cpuPercent: 14, rssBytes: 200 * 1024 * 1024 },
		},
		grant: sampleGrant(),
		admission: new TextEncoder().encode("admission-bytes"),
		...overrides,
	};
}

const SAMPLE_EXECUTION = {
	campaignId: "camp-1",
	runId: "run-1",
	executionIndex: 1,
	transport: "ws" as const,
};

function sampleInput(
	overrides: Partial<ArmMeasureInput> = {},
): ArmMeasureInput {
	return {
		leg: sampleLeg(),
		serverSnapshot: sampleSnapshot(),
		supervisorContext: sampleContext(),
		execution: SAMPLE_EXECUTION,
		...overrides,
	};
}

describe("arm-measure: measuredLegToArm", () => {
	it("joins leg, serverSnapshot, supervisorContext, and execution into an ArmMeasurement", () => {
		const input = sampleInput();
		const result = measuredLegToArm(input);
		expect(result.sampleUnit).toBe("ms");
		expect(result.toolchains).toBe(input.supervisorContext.toolchains);
		expect(result.telemetry).toBe(input.supervisorContext.telemetry);
		expect(result.grant).toBe(input.supervisorContext.grant);
		expect(result.admission).toBe(input.supervisorContext.admission);
		// The per-session loop utilization is sourced from the leg;
		// the server aggregate is read off the snapshot but not yet
		// published on this field (Commit 3 splits the scopes).
		expect(result.loopUtilization).toEqual({
			busyMs: input.leg.loopUtilization.busyMs,
			windowMs: input.leg.loopUtilization.windowMs,
		});
		expect(result.samples).toEqual(input.leg.samples);
		expect(result.percentiles).toEqual(input.leg.percentiles);
		expect(result.admissionCounters).toBe(input.leg.admissionCounters);
		expect(result.provenance).toBe(input.leg.provenance);
	});

	it("passes supervisor fields through unmodified (no substitute, no copy)", () => {
		const context = sampleContext();
		const input = sampleInput({ supervisorContext: context });
		const result = measuredLegToArm(input);
		// Identity, not deep equality: the mapper is the join, not
		// the validator. Re-using the supervisor's object means a
		// downstream check can identify its source.
		expect(result.toolchains).toBe(context.toolchains);
		expect(result.telemetry).toBe(context.telemetry);
		expect(result.grant).toBe(context.grant);
		expect(result.admission).toBe(context.admission);
	});

	it("refuses a missing leg", () => {
		const input = sampleInput();
		// biome-ignore lint/performance/noDelete: intentional typed refusal
		delete (input as { leg?: MeasuredLeg }).leg;
		expect(() => measuredLegToArm(input)).toThrow(/leg is required/);
	});

	it("refuses a missing serverSnapshot", () => {
		const input = sampleInput();
		// biome-ignore lint/performance/noDelete: intentional typed refusal
		delete (input as { serverSnapshot?: ServerSnapshotRecord }).serverSnapshot;
		expect(() => measuredLegToArm(input)).toThrow(/serverSnapshot is required/);
	});

	it("refuses a missing supervisorContext", () => {
		const input = sampleInput();
		// biome-ignore lint/performance/noDelete: intentional typed refusal
		delete (input as { supervisorContext?: ArmMeasureSupervisorContext })
			.supervisorContext;
		expect(() => measuredLegToArm(input)).toThrow(
			/supervisorContext is required/,
		);
	});

	it("refuses a missing grant in the supervisor context", () => {
		const context = sampleContext();
		// biome-ignore lint/performance/noDelete: intentional typed refusal
		delete (context as { grant?: MeasurementGrantV1 }).grant;
		const input = sampleInput({ supervisorContext: context });
		expect(() => measuredLegToArm(input)).toThrow(/supervisorContext.grant/);
	});

	it("refuses a missing admission in the supervisor context", () => {
		const context = sampleContext();
		// biome-ignore lint/performance/noDelete: intentional typed refusal
		delete (context as { admission?: Uint8Array }).admission;
		const input = sampleInput({ supervisorContext: context });
		expect(() => measuredLegToArm(input)).toThrow(
			/supervisorContext.admission/,
		);
	});

	it("refuses a missing toolchains in the supervisor context", () => {
		const context = sampleContext();
		// biome-ignore lint/performance/noDelete: intentional typed refusal
		delete (context as { toolchains?: unknown }).toolchains;
		const input = sampleInput({ supervisorContext: context });
		expect(() => measuredLegToArm(input)).toThrow(
			/supervisorContext.toolchains/,
		);
	});

	it("refuses a missing telemetry in the supervisor context", () => {
		const context = sampleContext();
		// biome-ignore lint/performance/noDelete: intentional typed refusal
		delete (context as { telemetry?: unknown }).telemetry;
		const input = sampleInput({ supervisorContext: context });
		expect(() => measuredLegToArm(input)).toThrow(
			/supervisorContext.telemetry/,
		);
	});

	it("refuses a leg without loop utilization", () => {
		const leg = sampleLeg();
		// biome-ignore lint/performance/noDelete: intentional typed refusal
		delete (leg as { loopUtilization?: { busyMs: number; windowMs: number } })
			.loopUtilization;
		const input = sampleInput({ leg });
		expect(() => measuredLegToArm(input)).toThrow(/leg.loopUtilization/);
	});

	it("refuses a leg with non-finite busyMs", () => {
		const leg = sampleLeg({
			loopUtilization: { busyMs: Number.NaN, windowMs: 4 },
		});
		const input = sampleInput({ leg });
		expect(() => measuredLegToArm(input)).toThrow(/busyMs must be finite/);
	});

	it("refuses a leg with non-positive windowMs", () => {
		const leg = sampleLeg({
			loopUtilization: { busyMs: 1, windowMs: 0 },
		});
		const input = sampleInput({ leg });
		expect(() => measuredLegToArm(input)).toThrow(
			/windowMs must be a finite positive number/,
		);
	});

	it("refuses a server snapshot with non-finite busyMs", () => {
		const snapshot = sampleSnapshot({
			loopUtilization: { busyMs: Number.POSITIVE_INFINITY, windowMs: 5 },
		});
		const input = sampleInput({ serverSnapshot: snapshot });
		expect(() => measuredLegToArm(input)).toThrow(
			/serverSnapshot.loopUtilization.busyMs/,
		);
	});

	it("refuses a server snapshot with non-positive windowMs", () => {
		const snapshot = sampleSnapshot({
			loopUtilization: { busyMs: 3, windowMs: -1 },
		});
		const input = sampleInput({ serverSnapshot: snapshot });
		expect(() => measuredLegToArm(input)).toThrow(
			/windowMs must be a finite positive number/,
		);
	});

	it("is a pure synchronous function (no I/O, no clock, no process state)", () => {
		// The deviation plan's contract: the mapper is sync because
		// every input is in hand by the time the producer calls it.
		// Confirm by running it twice with the same input and
		// checking the outputs are structurally equal.
		const input = sampleInput();
		const first = measuredLegToArm(input);
		const second = measuredLegToArm(input);
		expect(first).toEqual(second);
	});

	it("threads the campaign's execution key through to the produced arm", () => {
		const input = sampleInput({
			execution: {
				campaignId: "camp-other",
				runId: "run-other",
				executionIndex: 7,
				transport: "wt",
			},
		});
		const result = measuredLegToArm(input);
		expect((result as { execution?: unknown }).execution).toEqual({
			campaignId: "camp-other",
			runId: "run-other",
			executionIndex: 7,
			transport: "wt",
		});
	});
});
