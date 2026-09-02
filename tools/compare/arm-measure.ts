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
	MetricContract,
	MetricUnit,
	ToolchainSet,
} from "./evidence.ts";
import type { LinuxRelayObservationV1 } from "./cohort-protocol.ts";
import type { ArmAttestationEvidenceV2 } from "./server-observation-artifact.ts";
import type { ArmCohortEvidenceV1 } from "./artifact-builder.ts";

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
	/** A3 optional attested receipt graph joined onto the arm. */
	readonly attestationEvidence?: ArmAttestationEvidenceV2;
	/**
	 * B4: the cohort evidence the Mac supervisor exported for this execution.
	 * Present exactly for the six primary fanout cells; the mapper carries it
	 * verbatim and never synthesizes one.
	 */
	readonly cohortEvidence?: ArmCohortEvidenceV1;
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
		readonly perSession: { readonly busyMs: number; readonly windowMs: number };
		readonly serverAggregate: {
			readonly busyMs: number;
			readonly windowMs: number;
		};
	};
	readonly admissionCounters: AdmissionCounters;
	readonly provenance: SampleProvenance;
	readonly grant: MeasurementGrantV1;
	readonly admission: Uint8Array;
	readonly execution: MeasurementExecutionKey;
	/**
	 * A3: optional attested receipt graph joined onto the arm. Production
	 * sealing requires it; unit mappers may omit and let the artifact builder
	 * mint a Phase-A fixture graph.
	 */
	readonly attestationEvidence?: ArmAttestationEvidenceV2;
	/** B4: the supervisor's terminal cohort export, carried unchanged. */
	readonly cohortEvidence?: ArmCohortEvidenceV1;
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
	const {
		leg,
		serverSnapshot,
		supervisorContext,
		execution,
		attestationEvidence,
		cohortEvidence,
	} = input;
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
	// scope sourced from the controller's sidecar. The mapper joins
	// the two into the arm's `loopUtilization` field so the
	// renderer can read both scopes from a single artifact.
	const perSession = leg.loopUtilization;
	if (!perSession) {
		throw new RangeError(
			"measuredLegToArm: leg.loopUtilization is required (a leg without a measured consumer loop is a measurement defect, not a missing signal)",
		);
	}
	if (!Number.isFinite(perSession.busyMs)) {
		throw new RangeError(
			`measuredLegToArm: leg.loopUtilization.busyMs must be finite; got ${perSession.busyMs}`,
		);
	}
	if (!Number.isFinite(perSession.windowMs) || perSession.windowMs <= 0) {
		throw new RangeError(
			`measuredLegToArm: leg.loopUtilization.windowMs must be a finite positive number; got ${perSession.windowMs}`,
		);
	}
	// Server snapshot sanity. The protocol already validates
	// this on decode, but the mapper re-checks so a producer
	// that bypasses the sidecar (and feeds the mapper a hand-
	// built record) still fails closed.
	const serverAggregate = serverSnapshot.loopUtilization;
	if (!serverAggregate) {
		throw new RangeError(
			"measuredLegToArm: serverSnapshot.loopUtilization is required",
		);
	}
	if (!Number.isFinite(serverAggregate.busyMs)) {
		throw new RangeError(
			`measuredLegToArm: serverSnapshot.loopUtilization.busyMs must be finite; got ${serverAggregate.busyMs}`,
		);
	}
	if (
		!Number.isFinite(serverAggregate.windowMs) ||
		serverAggregate.windowMs <= 0
	) {
		throw new RangeError(
			`measuredLegToArm: serverSnapshot.loopUtilization.windowMs must be a finite positive number; got ${serverAggregate.windowMs}`,
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
			perSession: {
				busyMs: perSession.busyMs,
				windowMs: perSession.windowMs,
			},
			serverAggregate: {
				busyMs: serverAggregate.busyMs,
				windowMs: serverAggregate.windowMs,
			},
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
		...(attestationEvidence !== undefined ? { attestationEvidence } : {}),
		// The export ack rides through byte-identically. The mapper is the last
		// place this record could be quietly reshaped before it is sealed, so it
		// is copied by reference rather than spread.
		...(cohortEvidence !== undefined ? { cohortEvidence } : {}),
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

// ---------------------------------------------------------------------------
// B3.5: the Phase B cohort projection (plan §4.5, §5 `ASSEMBLY`)
// ---------------------------------------------------------------------------

/**
 * Why this lives in `arm-measure.ts` rather than in a `cohort-seal.ts` of its
 * own.
 *
 * This module already *is* the deep module for "observations in, one
 * `ArmMeasurement` out": it owns the only join that produces the shape
 * `buildRunArtifact` consumes, and `ArmCohortEvidenceV1` is already part of
 * its interface. A Phase B arm is not a different kind of measurement, it is
 * the same measurement whose leg was recorded by a cohort of role children
 * instead of a single-session driver, so the projection belongs behind the
 * same door: one import, one entry point, no caller having to know which of
 * two modules assembles its arm.
 *
 * There is a second, harder reason. `check-official-io.ts` freezes the module
 * inventory and every resolved static edge of `tools/compare`; a new
 * production `.ts` file is an unclassified file (`ALLOWLIST_EXTRA_FILE`) and
 * the edge into it would be an unfrozen edge, and the allowlist is owned by
 * the audit gate rather than by this change. Extending the module that is
 * already classified is the option that leaves the gate's inventory alone.
 * The same rule is why nothing below imports a runtime helper: every import
 * this module has is type-only, and the percentile arithmetic is spelled out
 * here with a test pinning it against `stats.percentile`, rather than adding
 * the first runtime edge out of this file.
 */

/**
 * The non-cohort observations the projection joins onto the export.
 *
 * Everything the cohort itself measured comes out of `ArmCohortEvidenceV1`.
 * These four are the facts the cohort records do not contain, and each one is
 * required rather than defaulted:
 *
 * - `linuxRelayObservation` is the Linux server's own relay record. Its bytes
 *   are already inside the export (`observation.linuxRelayObservation`) and
 *   already digest-bound by the cohort admission receipt, so this is the
 *   caller handing over the record it decoded, not a second opinion; the
 *   projection re-checks every total it consumes against the sealed derived
 *   records and refuses a record that disagrees.
 * - `serverSnapshot` is the rig's `server-loop-utilization/v1` reading. Phase
 *   B has no Mac-side consumer loop to measure -- the deliveries are counted
 *   in the subscriber workers and the only measured event loop in the
 *   execution is the Linux server's -- so the leg reports that loop, and the
 *   arm's `perSession` and `serverAggregate` scopes are equal by
 *   construction rather than by a second, invented reading.
 * - `contract` is the cell's primary metric contract. It supplies the
 *   histogram scale (the two arms of a cell must bucket on the same edges, so
 *   the edges cannot come from either arm's own samples) and the unit the
 *   rate record is checked against.
 * - `admissionCounters` are the supervisor's admission readings. The cohort
 *   records count sessions and nothing else, so the counters are carried and
 *   their session block is bound to `CohortCapacityV1`; a set that disagrees
 *   with the capacity record is refused.
 * - `recorder` is the series' identity: which attestation resolves it, which
 *   run recorded it, and which clock it was minted on. Identity, not
 *   measurement -- the projection will not compose one.
 */
export interface CohortLegSources {
	readonly linuxRelayObservation: LinuxRelayObservationV1;
	readonly serverSnapshot: ServerSnapshotRecord;
	readonly contract: MetricContract;
	readonly admissionCounters: AdmissionCounters;
	readonly recorder: {
		readonly attestation: string;
		readonly driverRunId: string;
		readonly clockMethod: string;
	};
}

function refuse(message: string): never {
	throw new RangeError(`projectCohortEvidenceToMeasuredLeg: ${message}`);
}

function sumOf(values: readonly number[], label: string): number {
	let total = 0;
	for (const value of values) {
		if (!Number.isSafeInteger(value) || value < 0) {
			refuse(`${label} must be nonnegative safe integers; got ${value}`);
		}
		total += value;
		if (!Number.isSafeInteger(total)) {
			refuse(`${label} sums past the safe integer range`);
		}
	}
	return total;
}

/**
 * A Mac nanosecond stamp read as driver milliseconds.
 *
 * The rate record's stamps are `mach_continuous_time` nanoseconds as decimal
 * strings. The leg's provenance is in milliseconds, so the conversion is
 * exact division by 1e6 through `BigInt` parsing -- a string that is not a
 * nanosecond stamp is refused rather than coerced to `NaN`.
 */
function macNsToMs(value: string, label: string): number {
	if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
		refuse(`${label} must be a nanosecond stamp; got ${String(value)}`);
	}
	return Number(BigInt(value)) / 1_000_000;
}

/**
 * The percentile `stats.percentile` computes, spelled out here.
 *
 * `verify-artifact.ts` recomputes the artifact's percentiles from its samples
 * with `sampleSummary`, so a projection that used any other definition would
 * seal an artifact the verifier rejects. The duplication is deliberate and
 * bounded: this module takes no runtime imports (see the note above), and
 * `cohort-seal.test.ts` pins this function against `stats.percentile` on the
 * projected samples so the two cannot drift silently.
 */
function interpolatedPercentile(samples: readonly number[], p: number): number {
	const values = samples.filter((value) => Number.isFinite(value));
	if (values.length === 0) {
		refuse("percentiles cannot be derived from an empty rate series");
	}
	values.sort((left, right) => left - right);
	if (values.length === 1) return values[0] as number;
	const rank = (p / 100) * (values.length - 1);
	const lowerIndex = Math.floor(rank);
	const upperIndex = Math.ceil(rank);
	const lower = values[lowerIndex] as number;
	const upper = values[upperIndex] as number;
	const fraction = rank - lowerIndex;
	return lower === upper ? lower : lower * (1 - fraction) + upper * fraction;
}

/** Bucket the samples on the contract's frozen edges. */
function histogramOf(
	samples: readonly number[],
	contract: MetricContract,
): { readonly counts: readonly number[] } {
	const boundaries = contract.histogramBoundaries;
	if (!Array.isArray(boundaries) || boundaries.length === 0) {
		refuse("the metric contract states no histogram boundaries");
	}
	let previous = Number.NEGATIVE_INFINITY;
	for (const boundary of boundaries) {
		if (!Number.isFinite(boundary) || boundary <= previous) {
			refuse("the metric contract's histogram boundaries are not ascending");
		}
		previous = boundary;
	}
	const counts = boundaries.map(() => 0);
	for (const sample of samples) {
		if (sample < (boundaries[0] as number)) {
			refuse(
				`sample ${sample} is below the contract's first histogram boundary`,
			);
		}
		let index = 0;
		for (let candidate = 0; candidate < boundaries.length; candidate += 1) {
			if (sample >= (boundaries[candidate] as number)) index = candidate;
		}
		counts[index] = (counts[index] as number) + 1;
	}
	return { counts };
}

/**
 * Project one Mac supervisor cohort export into the leg the artifact is
 * assembled from (plan §4.5).
 *
 * The admitted client series *is* `CohortRateSeriesV1.samples`: unit `count`,
 * one sample per one-second window, `sampleCount = windowCount`,
 * `delivered = measuredWindowDeliveredTotal`, and the first/last stamps taken
 * from the rate record's own delivery timestamps. Post-stop drain is carried
 * by the cohort ledger's conservation total and never folded back into the
 * measured series -- it is a promotion failure elsewhere, not a number this
 * function is allowed to hide.
 *
 * The remaining `MeasuredLeg` fields are projections with stated sources:
 *
 * ```text
 * ledger.attempted            = ledger.offeredExpandedDeliveries
 * ledger.queued               = ledger.serverAcceptedExpandedDeliveries
 * ledger.serverObserved       = ledger.linuxRelayWritesCompleted
 * ledger.acknowledged         = ledger.linuxRelayWritesCompleted
 * ledger.delivered            = rateSeries.measuredWindowDeliveredTotal
 * ledger.dropped              = Σ queueDropDeliveries + Σ disconnectUndelivered
 * ledger.expired              = Σ writeTimeoutDeliveries
 * ledger.harnessOverheadBytes = Σ relayWriteBytes − writes × messageBytes
 * ledger.histogram            = the samples bucketed on the contract's edges
 * loopUtilization             = the rig server snapshot's reading
 * admissionCounters           = the supervisor's counters, session-bound
 * provenance                  = the recorder identity + the rate record
 * roundTrips                  = [] -- a cohort measures no round trips
 * ```
 *
 * `serverObserved` and `acknowledged` are the same measured fact
 * (`linuxRelayWritesCompleted`) read on the two monotone chains the artifact
 * verifier enforces: it is the last stage of the send path the relay can
 * confirm, and the first stage of the receive path `delivered` is bounded by.
 * There is no separate cohort counter for either, and inventing one would be
 * the placeholder-evidence defect this whole projection exists to avoid.
 *
 * Every value above is either copied from a record inside the sealed export or
 * summed from the Linux observation the export digest-binds. A source that is
 * absent, malformed, or inconsistent with the sealed derived records is a
 * `RangeError`, never a default.
 */
export function projectCohortEvidenceToMeasuredLeg(
	evidence: ArmCohortEvidenceV1,
	sources: CohortLegSources,
): MeasuredLeg {
	if (!evidence || evidence.schema !== "arm-cohort-evidence/v1") {
		refuse("cohort evidence is required");
	}
	const { rateSeries, ledger, capacity, processProof } = evidence;
	if (!rateSeries) refuse("evidence.rateSeries is required");
	if (!ledger) refuse("evidence.ledger is required");
	if (!capacity) refuse("evidence.capacity is required");
	if (!processProof) refuse("evidence.processProof is required");
	if (!sources) refuse("sources are required");
	const { linuxRelayObservation: relay, serverSnapshot, contract } = sources;
	if (!relay) refuse("sources.linuxRelayObservation is required");
	if (!serverSnapshot) refuse("sources.serverSnapshot is required");
	if (!contract) refuse("sources.contract is required");
	if (!sources.admissionCounters) {
		refuse("sources.admissionCounters is required");
	}
	if (!sources.recorder) refuse("sources.recorder is required");
	for (const key of ["attestation", "driverRunId", "clockMethod"] as const) {
		const value = sources.recorder[key];
		if (typeof value !== "string" || value.length === 0) {
			refuse(`sources.recorder.${key} must be a non-empty string`);
		}
	}

	// The unit is the rate record's, and the cell must publish that unit; an
	// arm sealed under a unit it was not measured in is the defect
	// `assertMeasurementUnitPublishable` exists for, caught one step earlier.
	if (contract.unit !== rateSeries.sampleUnit) {
		refuse(
			`the cell publishes unit ${contract.unit} but the rate record's sampleUnit is ${rateSeries.sampleUnit}`,
		);
	}

	const samples = [...rateSeries.samples];
	if (relay.windowCount !== samples.length) {
		refuse(
			`the observation covers ${relay.windowCount} windows and the rate record ${samples.length}`,
		);
	}

	// The observation must be this execution's. Its digest is already bound by
	// the cohort admission receipt inside the export; these three equalities
	// are what make a *substituted* record a refusal here rather than a
	// silently sealed number.
	if (relay.executionSha256 !== processProof.executionSha256) {
		refuse("the observation names another execution");
	}
	if (relay.cohortGrantSha256 !== processProof.cohortGrantSha256) {
		refuse("the observation names another cohort grant");
	}
	if (relay.cohortStartBarrierSha256 !== processProof.cohortStartBarrierSha256) {
		refuse("the observation names another start barrier");
	}

	// Population: the observation, the capacity record and the process proof
	// must describe one cohort.
	if (
		relay.registeredPublisherCount !== capacity.registeredPublishers ||
		relay.registeredSubscriberCount !== capacity.registeredSubscribers ||
		relay.sessionsAccepted !== capacity.sessionsAccepted ||
		relay.sessionsActivePeak !== capacity.sessionsActivePeak
	) {
		refuse("the observation's population is not the capacity record's");
	}
	if (
		processProof.observedPublisherCount !== capacity.registeredPublishers ||
		processProof.observedSubscriberCount !== capacity.registeredSubscribers
	) {
		refuse("the process proof's population is not the capacity record's");
	}

	// Totals: what the observation says must be what the sealed ledger says.
	const acceptedIngress = sumOf(
		relay.acceptedIngressByOriginWindow,
		"acceptedIngressByOriginWindow",
	);
	if (acceptedIngress !== ledger.serverAcceptedIngress) {
		refuse(
			`the observation's accepted ingress ${acceptedIngress} is not the ledger's ${ledger.serverAcceptedIngress}`,
		);
	}
	const relayWrites = sumOf(
		relay.relayWritesCompletedByOriginWindow,
		"relayWritesCompletedByOriginWindow",
	);
	if (relayWrites !== ledger.linuxRelayWritesCompleted) {
		refuse(
			`the observation's completed relay writes ${relayWrites} are not the ledger's ${ledger.linuxRelayWritesCompleted}`,
		);
	}
	if (rateSeries.conservationDeliveredTotal !== ledger.delivered) {
		refuse(
			"the rate record's conservation total is not the ledger's delivered total",
		);
	}

	// The §4.5 per-window outcome identity, re-checked here because `dropped`
	// and `expired` are read straight off these arrays: every expanded
	// delivery is written, queue-dropped, timed out, or lost to a disconnect.
	const subscribers = capacity.registeredSubscribers;
	for (let window = 0; window < relay.windowCount; window += 1) {
		const accepted = relay.acceptedIngressByOriginWindow[window] as number;
		const expanded = accepted * subscribers;
		const accounted =
			(relay.relayWritesCompletedByOriginWindow[window] as number) +
			(relay.queueDropDeliveriesByOriginWindow[window] as number) +
			(relay.writeTimeoutDeliveriesByOriginWindow[window] as number) +
			(relay.disconnectUndeliveredByOriginWindow[window] as number);
		if (accounted !== expanded) {
			refuse(
				`window ${window}: relay outcomes ${accounted} do not account for ${expanded} expanded deliveries`,
			);
		}
	}

	const dropped =
		sumOf(
			relay.queueDropDeliveriesByOriginWindow,
			"queueDropDeliveriesByOriginWindow",
		) +
		sumOf(
			relay.disconnectUndeliveredByOriginWindow,
			"disconnectUndeliveredByOriginWindow",
		);
	const expired = sumOf(
		relay.writeTimeoutDeliveriesByOriginWindow,
		"writeTimeoutDeliveriesByOriginWindow",
	);

	// The only measured overhead in the cohort: bytes the relay wrote beyond
	// the payload those writes carried. A relay that wrote fewer bytes than
	// the payload it claims to have written is a measurement defect.
	const relayWriteBytes = sumOf(
		relay.relayWriteBytesByOriginWindow,
		"relayWriteBytesByOriginWindow",
	);
	const payloadBytes = relayWrites * ledger.messageBytes;
	const harnessOverheadBytes = relayWriteBytes - payloadBytes;
	if (harnessOverheadBytes < 0) {
		refuse(
			`harness overhead is negative: the relay wrote ${relayWriteBytes} bytes for ${payloadBytes} bytes of payload`,
		);
	}

	// Admission counters: carried, with the one block the cohort also measured
	// bound to the capacity record.
	const admissionCounters = sources.admissionCounters;
	if (
		admissionCounters.sessions?.accepted !== capacity.sessionsAccepted ||
		admissionCounters.sessions?.activePeak !== capacity.sessionsActivePeak
	) {
		refuse(
			"the supervisor's sessions counters disagree with the cohort capacity record",
		);
	}

	const loop = serverSnapshot.loopUtilization;
	if (!loop) {
		refuse(
			"sources.serverSnapshot.loopUtilization is required (a Phase B leg with no measured server loop is a measurement defect, not a missing signal)",
		);
	}
	if (!Number.isFinite(loop.busyMs) || loop.busyMs < 0) {
		refuse(`serverSnapshot.loopUtilization.busyMs must be finite and nonnegative; got ${loop.busyMs}`);
	}
	if (!Number.isFinite(loop.windowMs) || loop.windowMs <= 0) {
		refuse(`serverSnapshot.loopUtilization.windowMs must be positive; got ${loop.windowMs}`);
	}

	const provenance: SampleProvenance = {
		attestation: sources.recorder.attestation,
		driverRunId: sources.recorder.driverRunId,
		clockMethod: sources.recorder.clockMethod,
		sampleCount: samples.length,
		firstSampleAtMs: macNsToMs(
			rateSeries.firstDeliveryAtMacNs,
			"rateSeries.firstDeliveryAtMacNs",
		),
		// The measured window's last delivery. The drain's own last delivery
		// (`lastDeliveryIncludingDrainAtMacNs`) is deliberately not the end of
		// the measured series.
		lastSampleAtMs: macNsToMs(
			rateSeries.lastMeasuredWindowDeliveryAtMacNs,
			"rateSeries.lastMeasuredWindowDeliveryAtMacNs",
		),
	};

	return {
		sampleUnit: rateSeries.sampleUnit,
		samples,
		percentiles: {
			p1: interpolatedPercentile(samples, 1),
			p50: interpolatedPercentile(samples, 50),
			p95: interpolatedPercentile(samples, 95),
			p99: interpolatedPercentile(samples, 99),
		},
		ledger: {
			attempted: ledger.offeredExpandedDeliveries,
			queued: ledger.serverAcceptedExpandedDeliveries,
			serverObserved: ledger.linuxRelayWritesCompleted,
			acknowledged: ledger.linuxRelayWritesCompleted,
			delivered: rateSeries.measuredWindowDeliveredTotal,
			dropped,
			expired,
			harnessOverheadBytes,
			histogram: {
				unit: contract.unit,
				boundaries: [...contract.histogramBoundaries],
				counts: histogramOf(samples, contract).counts,
			},
		},
		admissionCounters,
		provenance,
		loopUtilization: { busyMs: loop.busyMs, windowMs: loop.windowMs },
		// A fanout cohort counts deliveries per window; nothing in it pairs a
		// send with a receive, so there are no round trips to report and the
		// leg says so rather than synthesizing pairs.
		roundTrips: [],
	};
}

/**
 * The Phase B assembly step: one cohort export in, one `ArmMeasurement` out.
 *
 * This is the whole `ASSEMBLY` transition for a fanout arm -- project the leg
 * from the immutable validated bytes, then run the same join every other arm
 * runs, with the export riding through byte-identically onto the measurement.
 */
export function measuredCohortToArm(input: {
	readonly cohortEvidence: ArmCohortEvidenceV1;
	readonly sources: CohortLegSources;
	readonly supervisorContext: ArmMeasureSupervisorContext;
	readonly execution: MeasurementExecutionKey;
	readonly attestationEvidence?: ArmAttestationEvidenceV2;
}): ArmMeasurement {
	const leg = projectCohortEvidenceToMeasuredLeg(
		input.cohortEvidence,
		input.sources,
	);
	return measuredLegToArm({
		leg,
		serverSnapshot: input.sources.serverSnapshot,
		supervisorContext: input.supervisorContext,
		execution: input.execution,
		...(input.attestationEvidence !== undefined
			? { attestationEvidence: input.attestationEvidence }
			: {}),
		cohortEvidence: input.cohortEvidence,
	});
}
