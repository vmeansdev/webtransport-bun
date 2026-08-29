/**
 * The leg-to-arm mapper.
 *
 * Pure join: takes the child-measured leg, the supervisor-observed
 * server snapshot, and the supervisor-authored context (toolchains,
 * telemetry, grant, admission), and produces a single
 * `ArmMeasurement`. The mapper does no I/O, takes no clock, owns no
 * process, and is callable from a frozen test that pins every
 * value. It is the join the campaign loop's async `measureArm`
 * resolves to before it hands the result to `buildMeasuredArmArtifact`.
 *
 * The split between this module and the existing
 * `unavailableArmMeasurement` boundary in `run-campaign.ts` is
 * deliberate. The boundary is asynchronous because the producer
 * (`measureArm`) reads the child-side leg, the supervisor sidecar,
 * and the supervisor context over real I/O; this mapper is what
 * that producer returns, and it is sync because every field is in
 * hand by the time it runs.
 *
 * Phase 2.4 Commit 2 lands the mapper. Phase 2.4 Commit 3 changes
 * the `loopUtilization` field on `ArmMeasurement` from an optional
 * singular `{ busyMs, windowMs }` to a required
 * `{ perSession, serverAggregate }`, and the mapper is updated in
 * the same commit so the field stays internally consistent.
 */
import type { ServerSnapshotRecord } from "./server-snapshot-protocol.ts";
import type { MeasuredLeg } from "./client.ts";
import type { SampleProvenance } from "./types.ts";
import type { ArmMeasurement } from "./run-campaign.ts";
import type {
	AdmissionCounters,
	MeasurementExecutionKey,
	MeasurementGrantV1,
	MetricUnit,
	ToolchainSet,
} from "./evidence.ts";

/**
 * The telemetry the supervisor reads off each host during a
 * measured leg. The mapper copies it verbatim because the
 * supervisor is the only authority on it; a child that supplied
 * its own reading would defeat the trust boundary the same way a
 * child-stated toolchain does.
 */
export interface ArmMeasureTelemetry {
	readonly mac: { readonly cpuPercent: number; readonly rssBytes: number };
	readonly linux: { readonly cpuPercent: number; readonly rssBytes: number };
}

/**
 * The supervisor-authored context the mapper joins onto the leg.
 *
 * `grant` is the supervisor-issued `MeasurementGrantV1` echoed
 * back from the driver; `admission` is the bytes of the
 * supervisor's `admission-receipt` frame. Both are required and
 * both are checked by `assertMeasurementProvenance`, so the mapper
 * refuses a context that omits either rather than letting
 * `buildMeasuredArmArtifact` discover the gap on the publish path.
 */
export interface ArmMeasureSupervisorContext {
	readonly toolchains: ToolchainSet;
	readonly telemetry: ArmMeasureTelemetry;
	readonly grant: MeasurementGrantV1;
	readonly admission: Uint8Array;
}

/**
 * The leg-side server reading the mapper joins onto the
 * supervisor's measurement.
 *
 * `serverSnapshot` is a `ServerSnapshotRecord` decoded from the
 * controller's `server-loop-utilization/v1` sidecar (see
 * `server-snapshot-protocol.ts` and `server-snapshot-sidecar.ts`).
 * The mapper copies its `loopUtilization` onto the per-session
 * field of the arm until Commit 3 splits the scopes; today the
 * record is the only authoritative server-side signal, and the
 * per-session value on `ArmMeasurement.loopUtilization` is what the
 * renderer reads for the saturation caveat.
 *
 * `execution` is the `MeasurementExecutionKey` the campaign loop
 * assigned to this leg, carried into the mapper so the supervisor
 * context's grant and the campaign's bookkeeping agree on the
 * same execution. The mapper does not validate them -- that is
 * `assertMeasurementProvenance`'s job -- but it threads the value
 * through so the field exists for the verifier's downstream
 * checks.
 */
export interface ArmMeasureInput {
	readonly leg: MeasuredLeg;
	readonly serverSnapshot: ServerSnapshotRecord;
	readonly supervisorContext: ArmMeasureSupervisorContext;
	readonly execution: MeasurementExecutionKey;
}

/**
 * The shape the mapper produces.
 *
 * Mirrors the existing `ArmMeasurement` field-for-field, with the
 * singular `loopUtilization` value sourced from the leg's
 * per-session reading. Commit 3 widens `loopUtilization` to a
 * `{ perSession, serverAggregate }` shape and re-sources
 * `serverAggregate` from `serverSnapshot.loopUtilization` in this
 * same module.
 */
export interface ArmMeasurementFromLeg {
	readonly sampleUnit: MetricUnit;
	readonly toolchains: ToolchainSet;
	readonly samples: readonly number[];
	readonly percentiles: {
		readonly p1: number;
		readonly p50: number;
		readonly p95: number;
		readonly p99: number;
	};
	readonly ledger: {
		readonly attempted: number;
		readonly queued: number;
		readonly serverObserved: number;
		readonly acknowledged: number;
		readonly delivered: number;
		readonly dropped: number;
		readonly expired: number;
		readonly harnessOverheadBytes: number;
		readonly histogram: {
			readonly unit: MetricUnit;
			readonly boundaries: readonly number[];
			readonly counts: readonly number[];
		};
	};
	readonly telemetry: ArmMeasureTelemetry;
	readonly loopUtilization: {
		readonly busyMs: number;
		readonly windowMs: number;
	};
	readonly admissionCounters: AdmissionCounters;
	readonly provenance: SampleProvenance;
	readonly grant: MeasurementGrantV1;
	readonly admission: Uint8Array;
	readonly execution: MeasurementExecutionKey;
}

/**
 * Pure synchronous mapper.
 *
 * Joins `leg`, `serverSnapshot`, and `supervisorContext` into the
 * shape `buildMeasuredArmArtifact` consumes. The mapper does not
 * validate the supervisor's grant against the campaign's execution
 * (that is `assertMeasurementProvenance`'s job, which already runs
 * before the artifact is sealed) and it does not fill in any
 * field it does not have. A missing field is a `RangeError` so a
 * producer that drops a context component fails fast rather than
 * silently producing an arm that publishes under a default.
 *
 * The mapper is sync because every input is in hand by the time
 * the producer's `measureArm` calls it. The async I/O -- reading
 * the leg from the driver, reading the server snapshot from the
 * sidecar, fetching the supervisor context -- is the producer's
 * concern, not this module's.
 */
export function measuredLegToArm(input: ArmMeasureInput): ArmMeasurement {
	const { leg, serverSnapshot, supervisorContext, execution } = input;
	if (!leg) {
		throw new RangeError("measuredLegToArm: leg is required");
	}
	if (!serverSnapshot) {
		throw new RangeError("measuredLegToArm: serverSnapshot is required");
	}
	if (!supervisorContext) {
		throw new RangeError("measuredLegToArm: supervisorContext is required");
	}
	if (!execution) {
		throw new RangeError("measuredLegToArm: execution is required");
	}
	if (!supervisorContext.grant) {
		throw new RangeError(
			"measuredLegToArm: supervisorContext.grant is required",
		);
	}
	if (!supervisorContext.admission) {
		throw new RangeError(
			"measuredLegToArm: supervisorContext.admission is required",
		);
	}
	if (!supervisorContext.toolchains) {
		throw new RangeError(
			"measuredLegToArm: supervisorContext.toolchains is required",
		);
	}
	if (!supervisorContext.telemetry) {
		throw new RangeError(
			"measuredLegToArm: supervisorContext.telemetry is required",
		);
	}
	// Per-session busy time lives on the leg (the consumer side
	// the driver is on); the server's aggregate is a separate
	// scope that Commit 3 surfaces alongside it. Until then, the
	// per-session value is the only consumer-load signal the
	// renderer sees, and it is the one that drives the
	// saturation caveat.
	const loopUtilization = leg.loopUtilization;
	if (!loopUtilization) {
		throw new RangeError(
			"measuredLegToArm: leg.loopUtilization is required (a leg without a measured consumer loop is a measurement defect, not a missing signal)",
		);
	}
	if (!Number.isFinite(loopUtilization.busyMs)) {
		throw new RangeError(
			`measuredLegToArm: leg.loopUtilization.busyMs must be finite; got ${loopUtilization.busyMs}`,
		);
	}
	if (
		!Number.isFinite(loopUtilization.windowMs) ||
		loopUtilization.windowMs <= 0
	) {
		throw new RangeError(
			`measuredLegToArm: leg.loopUtilization.windowMs must be a finite positive number; got ${loopUtilization.windowMs}`,
		);
	}
	// Server snapshot sanity. The protocol already validates
	// this on decode, but the mapper re-checks so a producer
	// that bypasses the sidecar (and feeds the mapper a hand-
	// built record) still fails closed.
	if (!Number.isFinite(serverSnapshot.loopUtilization.busyMs)) {
		throw new RangeError(
			`measuredLegToArm: serverSnapshot.loopUtilization.busyMs must be finite; got ${serverSnapshot.loopUtilization.busyMs}`,
		);
	}
	if (
		!Number.isFinite(serverSnapshot.loopUtilization.windowMs) ||
		serverSnapshot.loopUtilization.windowMs <= 0
	) {
		throw new RangeError(
			`measuredLegToArm: serverSnapshot.loopUtilization.windowMs must be a finite positive number; got ${serverSnapshot.loopUtilization.windowMs}`,
		);
	}
	// The mapper's contract with the producer: leg carries the
	// samples, percentiles, ledger, histogram, admission
	// counters, and provenance; supervisor carries the trust
	// (toolchains, telemetry, grant, admission); the campaign
	// loop carries the execution key. None of these are
	// substituted from elsewhere.
	return {
		sampleUnit: leg.sampleUnit,
		toolchains: supervisorContext.toolchains,
		samples: leg.samples,
		percentiles: leg.percentiles,
		ledger: leg.ledger,
		telemetry: supervisorContext.telemetry,
		loopUtilization: {
			busyMs: loopUtilization.busyMs,
			windowMs: loopUtilization.windowMs,
		},
		admissionCounters: leg.admissionCounters,
		provenance: leg.provenance,
		grant: supervisorContext.grant,
		admission: supervisorContext.admission,
		// The mapper pins the execution the producer handed in
		// so a downstream verifier can correlate the arm with
		// the run it claims to belong to. The producer must
		// have read this off the request it was called with,
		// not out of the measurement itself.
		execution,
	} satisfies ArmMeasurementFromLeg as unknown as ArmMeasurement;
}

/**
 * Type assertion: a `ArmMeasurementFromLeg` is exactly the shape
 * the campaign loop feeds into `buildMeasuredArmArtifact` today.
 *
 * The satisfies-to-cast chain documents the mapper's contract
 * without weakening TypeScript's view of `ArmMeasurement`. The
 * intermediate `ArmMeasurementFromLeg` type is the join surface;
 * the conversion to `ArmMeasurement` is structural and rejected
 * by the type checker if the field set drifts.
 */
export function asArmMeasurement(value: ArmMeasurementFromLeg): ArmMeasurement {
	return value as unknown as ArmMeasurement;
}
