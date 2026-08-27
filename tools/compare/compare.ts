import { canonicalJson } from "./canonical.ts";
import {
	ARM_TIER,
	ARM_WIRE,
	type ArmTransport,
	type ArtifactBytes,
	type ArtifactRejection,
	type ArtifactRejectionCode,
	type ArtifactTrustContext,
	addRejection,
	artifactByteSha256,
	assertRankedPairing,
	assertWithinTransportPairing,
	type EvidenceStatus,
	metricContractForScenario,
	type RunArtifact,
	resolveRankPercentile,
	type ScenarioVerdict,
	sealRunArtifact,
	type Transport,
} from "./evidence.ts";
import {
	armUnitsFor,
	CANONICAL_SCENARIO_REGISTRY,
} from "./scenario-registry.ts";
import {
	trustContextForArtifact,
	verifyRunArtifact,
	verifyRunArtifactObject,
} from "./verify-artifact.ts";

export * from "./evidence.ts";
export { trustContextForArtifact };

export interface ArmComparisonResult {
	readonly visible: boolean;
	readonly evidenceStatus: EvidenceStatus;
	readonly rejections: readonly ArtifactRejection[];
	readonly artifact?: RunArtifact;
}

export interface ComparisonDelta {
	readonly metric: string;
	readonly unit: string;
	readonly ws: number;
	readonly wt: number;
	readonly absolute: number;
	readonly relative: number | null;
}

export interface CompareOptions {
	readonly ws?: ArtifactTrustContext;
	readonly wt?: ArtifactTrustContext;
}

export type ComputedDelta = ComparisonDelta | "not computed";
export type Ranking = "ws" | "wt" | "tie" | "not computed";

export interface ComparisonResult {
	readonly evidenceStatus: EvidenceStatus;
	readonly scenarioVerdict: ScenarioVerdict;
	readonly ws: ArmComparisonResult;
	readonly wt: ArmComparisonResult;
	readonly delta: ComputedDelta;
	readonly ranking: Ranking;
	readonly rejections: readonly ArtifactRejection[];
}

const MISSING_ARM_REJECTIONS: Readonly<
	Record<ArmTransport, ArtifactRejection>
> = {
	ws: {
		code: "WS_ARM_NOT_MEASURED",
		reason: "WS arm was not measured for this canonical run",
	},
	wt: {
		code: "WT_ARM_NOT_MEASURED",
		reason: "WT arm was not measured for this canonical run",
	},
	"ws-worker": {
		code: "WS_WORKER_ARM_NOT_MEASURED",
		reason: "ws-worker arm was not measured for this canonical run",
	},
	"wt-stream-sink": {
		code: "WT_STREAM_SINK_ARM_NOT_MEASURED",
		reason: "wt-stream-sink arm was not measured for this canonical run",
	},
};

/**
 * A ranked pairing.  The constructor is module-private and there is no exported
 * function anywhere that takes two artifacts and returns a pair, which is the
 * only way to make a cross-tier ranking unrepresentable rather than merely
 * discouraged: a caller cannot build the thing it would need to publish one.
 * The tier and wire predicate is not re-spelled here — it is imported.
 */
interface RankedPair {
	readonly kind: "ranked";
	readonly a: ArmTransport;
	readonly b: ArmTransport;
}

/**
 * A within-transport report.  It carries no ranking-typed field at all, so a
 * within-transport pair cannot become a ranking by assignment either.
 */
interface WithinTransportPair {
	readonly kind: "within-transport";
	readonly mainLoop: ArmTransport;
	readonly offLoop: ArmTransport;
}

function rankedPair(a: ArmTransport, b: ArmTransport): RankedPair {
	assertRankedPairing(a, b);
	return { kind: "ranked", a, b };
}

function withinTransportPair(
	mainLoop: ArmTransport,
	offLoop: ArmTransport,
): WithinTransportPair {
	assertWithinTransportPairing(mainLoop, offLoop);
	return { kind: "within-transport", mainLoop, offLoop };
}

function admissionCounterShape(
	counters: RunArtifact["capacity"]["admissionCounters"],
): unknown {
	return {
		schemaVersion: counters.schemaVersion,
		handshakes: Object.keys(counters.handshakes).sort(),
		sessions: Object.keys(counters.sessions).sort(),
		streams: Object.keys(counters.streams).sort(),
		datagrams: Object.keys(counters.datagrams).sort(),
	};
}

/**
 * A five-stage funnel whose every stage is the same number.
 *
 * The funnel exists to separate admission from delivery, so a run in which
 * nothing was queued late, nothing went unobserved and nothing was lost is
 * possible in principle — but only for both arms at once, on the same
 * scenario, over the same wire. One arm reporting a lossless funnel while the
 * other reports a real one is the signature of a ledger that was written
 * rather than measured.
 */
function funnelIsDegenerate(ledger: RunArtifact["ledger"]): boolean {
	return (
		ledger.attempted > 0 &&
		ledger.queued === ledger.attempted &&
		ledger.serverObserved === ledger.attempted &&
		ledger.acknowledged === ledger.attempted &&
		ledger.delivered === ledger.attempted
	);
}

/** True when some stage of the funnel lost something to the stage before it. */
function funnelHasLoss(ledger: RunArtifact["ledger"]): boolean {
	return (
		ledger.queued < ledger.attempted ||
		ledger.serverObserved < ledger.queued ||
		ledger.acknowledged < ledger.serverObserved ||
		ledger.delivered < ledger.acknowledged
	);
}

function ledgerShape(ledger: RunArtifact["ledger"]): unknown {
	return {
		histogram: {
			unit: ledger.histogram.unit,
			boundaries: ledger.histogram.boundaries,
			counts: ledger.histogram.counts.length,
		},
	};
}

/**
 * The default histogram every arm and every scenario emitted was
 * `boundaries:[1,2,4], counts:[1,0,0]`, and the comparator compared only the
 * boundaries and the counts' length — so identical fabricated defaults always
 * matched.  Requiring the counts to sum to the sample count is one predicate
 * and it alone would have caught that.
 */
function histogramCountsMatchSamples(artifact: RunArtifact): boolean {
	const total = artifact.ledger.histogram.counts.reduce(
		(sum, count) => sum + count,
		0,
	);
	return total === artifact.metrics.samples.length;
}

function verifyArm(
	input: ArtifactBytes | undefined,
	expectedTransport: Transport,
	verificationContext?: ArtifactTrustContext,
): ArmComparisonResult {
	if (input === undefined) {
		return {
			visible: false,
			evidenceStatus: "BLOCKED",
			rejections: [MISSING_ARM_REJECTIONS[expectedTransport]],
		};
	}
	const verification = verifyRunArtifact(input, verificationContext);
	const rejections = [...verification.rejections];
	if (verification.artifactKind === "test-fixture")
		addRejection(
			rejections,
			"ARTIFACT_FIXTURE_NOT_PROMOTABLE",
			"test-fixture artifacts are visible evidence but cannot be compared",
			"$.artifactKind",
		);
	if (
		verification.artifact &&
		verification.artifact.transport !== expectedTransport
	) {
		addRejection(
			rejections,
			"TRANSPORT_INVALID",
			`expected ${expectedTransport} artifact`,
			"$.transport",
		);
	}
	const eligible =
		verification.artifact !== undefined &&
		verification.evidenceStatus === "PASS" &&
		rejections.length === 0;
	const evidenceStatus =
		verification.artifact !== undefined && rejections.length > 0
			? "FAIL"
			: verification.evidenceStatus;
	return {
		visible: eligible,
		evidenceStatus: eligible ? "PASS" : evidenceStatus,
		rejections,
		artifact: eligible ? verification.artifact : undefined,
	};
}

function compareField(
	ws: RunArtifact,
	wt: RunArtifact,
	key: keyof RunArtifact,
	code: ArtifactRejectionCode,
	rejections: ArtifactRejection[],
	reason: string,
): void {
	if (canonicalJson(ws[key]) !== canonicalJson(wt[key]))
		addRejection(rejections, code, reason, `$.${String(key)}`);
}

function compatibilityRejections(
	ws: RunArtifact,
	wt: RunArtifact,
): ArtifactRejection[] {
	const rejections: ArtifactRejection[] = [];
	if (ws.comparisonId !== wt.comparisonId)
		addRejection(
			rejections,
			"COMPARISON_ID_MISMATCH",
			"WS and WT comparison IDs differ",
			"$.comparisonId",
		);
	if (ws.runId !== wt.runId)
		addRejection(
			rejections,
			"RUN_ID_MISMATCH",
			"WS and WT run IDs differ",
			"$.runId",
		);
	if (ws.source.sourceSha !== wt.source.sourceSha)
		addRejection(
			rejections,
			"SOURCE_SHA_MISMATCH",
			"WS and WT source SHA differs",
			"$.source.sourceSha",
		);
	if (ws.source.archiveSha256 !== wt.source.archiveSha256)
		addRejection(
			rejections,
			"SOURCE_ARCHIVE_DIGEST_MISMATCH",
			"WS and WT source archive digest differs",
			"$.source.archiveSha256",
		);
	if (ws.source.executableSha256 !== wt.source.executableSha256)
		addRejection(
			rejections,
			"EXECUTABLE_DIGEST_MISMATCH",
			"WS and WT executable digest differs",
			"$.source.executableSha256",
		);
	if (canonicalJson(ws.source.toolchain) !== canonicalJson(wt.source.toolchain))
		addRejection(
			rejections,
			"TOOLCHAIN_DIGEST_MISMATCH",
			"WS and WT toolchain identity differs",
			"$.source.toolchain",
		);
	if (
		ws.source.cleanTree !== wt.source.cleanTree ||
		ws.source.bindingSha256 !== wt.source.bindingSha256
	)
		addRejection(
			rejections,
			"SOURCE_UNBOUND",
			"WS and WT source binding differs",
			"$.source",
		);
	if (ws.artifactKind !== "measured" || wt.artifactKind !== "measured")
		addRejection(
			rejections,
			"ARTIFACT_FIXTURE_NOT_PROMOTABLE",
			"only measured artifacts can participate in a comparison",
			"$.artifactKind",
		);
	if (
		ws.scenario.cellId !== wt.scenario.cellId ||
		ws.scenario.scenarioId !== wt.scenario.scenarioId
	)
		addRejection(
			rejections,
			"SCENARIO_BINDING_MISMATCH",
			"WS and WT scenario cell differs",
			"$.scenario",
		);
	if (ws.scenario.scenarioHash !== wt.scenario.scenarioHash)
		addRejection(
			rejections,
			"SCENARIO_BINDING_MISMATCH",
			"WS and WT scenario hash differs",
			"$.scenario.scenarioHash",
		);
	if (canonicalJson(ws.scenario.config) !== canonicalJson(wt.scenario.config))
		addRejection(
			rejections,
			"SCENARIO_BINDING_MISMATCH",
			"WS and WT canonical scenario config differs",
			"$.scenario.config",
		);
	if (ws.scenario.seed !== wt.scenario.seed)
		addRejection(
			rejections,
			"SCENARIO_BINDING_MISMATCH",
			"WS and WT scenario seed differs",
			"$.scenario.seed",
		);
	if (
		canonicalJson(ws.scenario.repetition) !==
		canonicalJson(wt.scenario.repetition)
	)
		addRejection(
			rejections,
			"SCENARIO_BINDING_MISMATCH",
			"WS and WT repetition differs",
			"$.scenario.repetition",
		);
	if (
		canonicalJson(ws.scenario.armOrder) !== canonicalJson(wt.scenario.armOrder)
	)
		addRejection(
			rejections,
			"SCENARIO_BINDING_MISMATCH",
			"WS and WT arm order differs",
			"$.scenario.armOrder",
		);
	if (canonicalJson(ws.scenario.payload) !== canonicalJson(wt.scenario.payload))
		addRejection(
			rejections,
			"SCENARIO_PAYLOAD_MISMATCH",
			"WS and WT payload differs",
			"$.scenario.payload",
		);
	if (ws.scenario.direction !== wt.scenario.direction)
		addRejection(
			rejections,
			"SCENARIO_DIRECTION_MISMATCH",
			"WS and WT application direction differs",
			"$.scenario.direction",
		);
	compareField(
		ws,
		wt,
		"topology",
		"TOPOLOGY_ROUTE_MISMATCH",
		rejections,
		"WS and WT topology proof differs",
	);
	compareField(
		ws,
		wt,
		"smoke",
		"SMOKE_INPUT_INVALID",
		rejections,
		"WS and WT smoke input differs",
	);
	if (ws.tls.sni !== wt.tls.sni)
		addRejection(
			rejections,
			"TLS_SNI_MISMATCH",
			"WS and WT TLS SNI differs",
			"$.tls.sni",
		);
	if (ws.tls.certificateSha256 !== wt.tls.certificateSha256)
		addRejection(
			rejections,
			"TLS_CERTIFICATE_MISMATCH",
			"WS and WT certificate fingerprint differs",
			"$.tls.certificateSha256",
		);
	if (ws.tls.caSha256 !== wt.tls.caSha256)
		addRejection(
			rejections,
			"TLS_CONFIGURATION_INVALID",
			"WS and WT trust identity differs",
			"$.tls.caSha256",
		);
	if (
		ws.tls.rejectUnauthorized !== wt.tls.rejectUnauthorized ||
		ws.tls.verification !== wt.tls.verification
	)
		addRejection(
			rejections,
			"TLS_CONFIGURATION_INVALID",
			"WS and WT TLS verification mode differs",
			"$.tls",
		);
	if (ws.tls.compression !== wt.tls.compression)
		addRejection(
			rejections,
			"TLS_COMPRESSION_ENABLED",
			"WS and WT compression mode differs",
			"$.tls.compression",
		);
	if (
		canonicalJson(ws.impairment.requested) !==
		canonicalJson(wt.impairment.requested)
	)
		addRejection(
			rejections,
			"IMPAIRMENT_REQUESTED_INVALID",
			"WS and WT requested impairment differs",
			"$.impairment.requested",
		);
	if (
		canonicalJson(ws.impairment.observedBefore) !==
		canonicalJson(wt.impairment.observedBefore)
	)
		addRejection(
			rejections,
			"IMPAIRMENT_OBSERVED_INVALID",
			"WS and WT pre-run impairment differs",
			"$.impairment.observedBefore",
		);
	if (
		canonicalJson(ws.impairment.observedAfter) !==
			canonicalJson(wt.impairment.observedAfter) ||
		ws.impairment.restored !== wt.impairment.restored ||
		canonicalJson(ws.impairment.restorationProof) !==
			canonicalJson(wt.impairment.restorationProof)
	)
		addRejection(
			rejections,
			"IMPAIRMENT_RESTORATION_INVALID",
			"WS and WT restoration proof differs",
			"$.impairment",
		);
	if (ws.capacity.profileId !== wt.capacity.profileId)
		addRejection(
			rejections,
			"CAPACITY_PROFILE_ID_MISMATCH",
			"WS and WT capacity profile ID differs",
			"$.capacity.profileId",
		);
	if (ws.capacity.profileHash !== wt.capacity.profileHash)
		addRejection(
			rejections,
			"CAPACITY_PROFILE_HASH_MISMATCH",
			"WS and WT capacity profile hash differs",
			"$.capacity.profileHash",
		);
	if (
		canonicalJson(ws.capacity.requested) !==
		canonicalJson(wt.capacity.requested)
	)
		addRejection(
			rejections,
			"CAPACITY_PROFILE_VALUES_MISMATCH",
			"WS and WT requested capacity differs",
			"$.capacity.requested",
		);
	if (ws.capacity.submittedProfileBytes !== wt.capacity.submittedProfileBytes)
		addRejection(
			rejections,
			"CAPACITY_SUBMITTED_BYTES_MISMATCH",
			"WS and WT submitted profile bytes differ",
			"$.capacity.submittedProfileBytes",
		);
	if (ws.capacity.submittedProfileHash !== wt.capacity.submittedProfileHash)
		addRejection(
			rejections,
			"CAPACITY_SUBMITTED_HASH_MISMATCH",
			"WS and WT submitted profile hash differs",
			"$.capacity.submittedProfileHash",
		);
	if (
		canonicalJson(admissionCounterShape(ws.capacity.admissionCounters)) !==
		canonicalJson(admissionCounterShape(wt.capacity.admissionCounters))
	)
		addRejection(
			rejections,
			"CAPACITY_ADMISSION_COUNTER_INVALID",
			"WS and WT admission-counter schema/shape differs",
			"$.capacity.admissionCounters",
		);
	if (
		canonicalJson(ws.capacity.connectionRamp) !==
		canonicalJson(wt.capacity.connectionRamp)
	)
		addRejection(
			rejections,
			"CAPACITY_CONNECTION_RAMP_MISMATCH",
			"WS and WT connection ramp differs",
			"$.capacity.connectionRamp",
		);
	if (canonicalJson(ws.capacityProof) !== canonicalJson(wt.capacityProof))
		addRejection(
			rejections,
			"CAPACITY_FD_PROOF_MISSING",
			"WS and WT capacity proofs differ",
			"$.capacityProof",
		);
	if (
		ws.metrics.name !== wt.metrics.name ||
		ws.metrics.unit !== wt.metrics.unit
	)
		addRejection(
			rejections,
			"METRICS_UNIT_INVALID",
			"WS and WT metric unit/name differs",
			"$.metrics",
		);
	if (
		ws.metrics.metricKind !== wt.metrics.metricKind ||
		canonicalJson(ws.metrics.clock) !== canonicalJson(wt.metrics.clock)
	)
		addRejection(
			rejections,
			"CLOCK_PROVENANCE_MISMATCH",
			"WS and WT metric clock provenance differs",
			"$.metrics.clock",
		);
	if (
		ws.metricContractId !== wt.metricContractId ||
		ws.metricContractHash !== wt.metricContractHash
	)
		addRejection(
			rejections,
			"METRICS_CONTRACT_INVALID",
			"WS and WT primary metric contracts differ",
			"$.metricContractHash",
		);
	if (
		canonicalJson({
			mac: {
				cpu: ws.runtime.mac.cpu,
				bun: ws.runtime.mac.bun,
				identity: ws.runtime.mac.identity,
			},
			linux: {
				cpu: ws.runtime.linux.cpu,
				bun: ws.runtime.linux.bun,
				identity: ws.runtime.linux.identity,
			},
		}) !==
		canonicalJson({
			mac: {
				cpu: wt.runtime.mac.cpu,
				bun: wt.runtime.mac.bun,
				identity: wt.runtime.mac.identity,
			},
			linux: {
				cpu: wt.runtime.linux.cpu,
				bun: wt.runtime.linux.bun,
				identity: wt.runtime.linux.identity,
			},
		})
	)
		addRejection(
			rejections,
			"EVIDENCE_RUNTIME_INVALID",
			"WS and WT runtime identity differs",
			"$.runtime",
		);
	if (canonicalJson(ws.processProof) !== canonicalJson(wt.processProof))
		addRejection(
			rejections,
			"EVIDENCE_PROCESS_PROOF_INVALID",
			"WS and WT process-role/cohort/shard proof differs",
			"$.processProof",
		);
	if (
		canonicalJson(ledgerShape(ws.ledger)) !==
		canonicalJson(ledgerShape(wt.ledger))
	)
		addRejection(
			rejections,
			"EVIDENCE_LEDGER_INVALID",
			"WS and WT ledger histogram bucket boundaries or schema differs",
			"$.ledger.histogram",
		);
	for (const [degenerate, measured, label] of [
		[ws, wt, "ws"],
		[wt, ws, "wt"],
	] as const) {
		if (
			funnelIsDegenerate(degenerate.ledger) &&
			funnelHasLoss(measured.ledger)
		) {
			addRejection(
				rejections,
				"LEDGER_FUNNEL_DEGENERATE",
				`the ${label} arm reports an all-equal delivery funnel while its pair reports a lossy one`,
				"$.ledger",
			);
		}
	}
	if (
		canonicalJson(ws.rawSidecarDigests) !== canonicalJson(wt.rawSidecarDigests)
	)
		addRejection(
			rejections,
			"RAW_SIDECAR_DIGEST_MISMATCH",
			"WS and WT raw sidecar digests differ",
			"$.rawSidecarDigests",
		);
	// A saturator applied at one operating point on one arm and another on the
	// other manufactures the result it is meant to test.  Unequal saturation is
	// an incompatibility, never a worse score.
	if (ws.scenario.saturatePct !== wt.scenario.saturatePct)
		addRejection(
			rejections,
			"COMPARISON_INCOMPATIBLE",
			"paired arms were saturated at different operating points",
			"$.scenario.saturatePct",
		);
	// Percentiles interpolated from different sample counts are not the same
	// statistic, whatever their values say.
	if (ws.metrics.samples.length !== wt.metrics.samples.length)
		addRejection(
			rejections,
			"METRICS_SAMPLE_COUNT_INCOMPATIBLE",
			"paired arms have different sample counts",
			"$.metrics.samples",
		);
	for (const [artifact, side] of [
		[ws, "ws"],
		[wt, "wt"],
	] as const)
		if (!histogramCountsMatchSamples(artifact))
			addRejection(
				rejections,
				"EVIDENCE_LEDGER_INVALID",
				`${side} histogram counts do not sum to its sample count`,
				"$.ledger.histogram.counts",
			);
	return rejections;
}

export function compareRunArtifacts(
	wsInput: ArtifactBytes | undefined,
	wtInput: ArtifactBytes | undefined,
	options: CompareOptions = {},
): ComparisonResult {
	const ws = verifyArm(wsInput, "ws", options.ws);
	const wt = verifyArm(wtInput, "wt", options.wt);
	const rejections: ArtifactRejection[] = [...ws.rejections];
	for (const rejection of wt.rejections) rejections.push(rejection);
	if (!ws.artifact || !wt.artifact) {
		return {
			evidenceStatus:
				rejections.length === 0 && wtInput === undefined
					? "BLOCKED"
					: ws.evidenceStatus === "FAIL" || wt.evidenceStatus === "FAIL"
						? "FAIL"
						: "BLOCKED",
			scenarioVerdict: "NO_VERDICT",
			ws,
			wt,
			delta: "not computed",
			ranking: "not computed",
			rejections,
		};
	}
	const compatibility = compatibilityRejections(ws.artifact, wt.artifact);
	for (const rejection of compatibility) rejections.push(rejection);
	if (compatibility.length > 0 || rejections.length > 0) {
		const blockedWt: ArmComparisonResult =
			compatibility.length > 0
				? {
						...wt,
						visible: false,
						evidenceStatus: "BLOCKED",
						rejections: [...wt.rejections, ...compatibility],
					}
				: wt;
		return {
			evidenceStatus: "BLOCKED",
			scenarioVerdict: "NO_VERDICT",
			ws,
			wt: blockedWt,
			delta: "not computed",
			ranking: "not computed",
			rejections,
		};
	}
	const contract = metricContractForScenario(ws.artifact.scenario.scenarioId);
	// Ranking at a fixed p50 reads a cell's median whatever its contract says
	// it is ranked at, and reading a positional percentile would rank a
	// higher-is-better metric at its *best* intervals.  The contract resolves
	// its own end of the distribution.
	const rankKey = (
		contract === undefined ? "p50" : `p${resolveRankPercentile(contract)}`
	) as "p1" | "p50" | "p99";
	const wsValue = ws.artifact.metrics.percentiles[rankKey];
	const wtValue = wt.artifact.metrics.percentiles[rankKey];
	const absolute = wtValue - wsValue;
	const relative = wsValue === 0 ? null : absolute / wsValue;
	if (
		contract === undefined ||
		!Number.isFinite(absolute) ||
		(relative !== null && !Number.isFinite(relative))
	) {
		const arithmeticRejection: ArtifactRejection = {
			code: "METRICS_ARITHMETIC_INVALID",
			reason: "metric delta arithmetic is not finite or lacks a contract",
			path: `$.metrics.percentiles.${rankKey}`,
		};
		return {
			evidenceStatus: "BLOCKED",
			scenarioVerdict: "NO_VERDICT",
			ws,
			wt,
			delta: "not computed",
			ranking: "not computed",
			rejections: [...rejections, arithmeticRejection],
		};
	}
	const delta: ComparisonDelta = {
		metric: contract.name,
		unit: ws.artifact.metrics.unit,
		ws: wsValue,
		wt: wtValue,
		absolute,
		relative,
	};
	return {
		evidenceStatus: "PASS",
		scenarioVerdict:
			ws.artifact.scenarioVerdict === "MISS" ||
			wt.artifact.scenarioVerdict === "MISS"
				? "MISS"
				: "PASS",
		ws,
		wt,
		delta,
		ranking:
			wsValue === wtValue
				? "tie"
				: contract.direction === "higher"
					? wsValue > wtValue
						? "ws"
						: "wt"
					: wsValue < wtValue
						? "ws"
						: "wt",
		rejections: [],
	};
}

export interface ArmArtifactInput {
	readonly armTransport: ArmTransport;
	readonly input: ArtifactBytes | undefined;
	readonly trust?: ArtifactTrustContext;
}

export interface RankedComparison {
	readonly tier: "main-loop" | "off-loop";
	readonly a: ArmTransport;
	readonly b: ArmTransport;
	readonly result: ComparisonResult;
}

/**
 * A within-transport report has no ranking field, and that is the point: the
 * two tiers of one wire answer a consumption-strategy question, and there is no
 * shape here into which a ranking could be written.
 */
export interface WithinTransportReport {
	readonly mainLoop: ArmTransport;
	readonly offLoop: ArmTransport;
}

export interface CellComparison {
	readonly cellId: string;
	readonly rankedComparisons: readonly RankedComparison[];
	readonly withinTransportReports: readonly WithinTransportReport[];
	readonly rejections: readonly ArtifactRejection[];
}

/**
 * The only exported entry point that compares a cell's arms.  It is N-ary
 * because a cell now carries two, three or four of them, and it derives every
 * pairing from `ARM_TIER` and `ARM_WIRE` through the module-private
 * constructors — so a caller cannot ask for a cross-tier ranking, and cannot
 * construct one to hand back either.
 *
 * The arm set is bound: a campaign that declares four arms and submits two is
 * `ARM_COUNT_MISMATCH`, not a two-arm comparison that quietly succeeds.
 */
export function compareCell(
	cellId: string,
	arms: readonly ArmArtifactInput[],
): CellComparison {
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidate) => candidate.cellId === cellId,
	);
	const rejections: ArtifactRejection[] = [];
	if (!cell) {
		addRejection(
			rejections,
			"SCENARIO_ID_INVALID",
			`unknown canonical scenario cell ${cellId}`,
			"$.scenario.cellId",
		);
		return {
			cellId,
			rankedComparisons: [],
			withinTransportReports: [],
			rejections,
		};
	}
	const expected = armUnitsFor(cell).flatMap((unit) =>
		unit === "ws+ws-overlay" ? (["ws"] as const) : ([unit] as const),
	);
	const supplied = new Map<ArmTransport, ArmArtifactInput>();
	for (const arm of arms) supplied.set(arm.armTransport, arm);
	if (supplied.size !== arms.length || supplied.size !== expected.length) {
		addRejection(
			rejections,
			"ARM_COUNT_MISMATCH",
			`${cellId} declares ${expected.length} arms and ${supplied.size} were submitted`,
			"$.armId",
		);
	}
	for (const arm of expected) {
		if (supplied.get(arm)?.input === undefined) {
			rejections.push(MISSING_ARM_REJECTIONS[arm]);
		}
	}
	const present = expected.filter(
		(arm) => supplied.get(arm)?.input !== undefined,
	);
	const rankedComparisons: RankedComparison[] = [];
	const withinTransportReports: WithinTransportReport[] = [];
	for (const [a, b] of [
		["ws", "wt"],
		["ws-worker", "wt-stream-sink"],
	] as const) {
		if (!present.includes(a) || !present.includes(b)) continue;
		const pair = rankedPair(a, b);
		rankedComparisons.push({
			tier: ARM_TIER[pair.a],
			a: pair.a,
			b: pair.b,
			result: compareRunArtifacts(
				supplied.get(pair.a)?.input,
				supplied.get(pair.b)?.input,
				{
					ws: supplied.get(pair.a)?.trust,
					wt: supplied.get(pair.b)?.trust,
				},
			),
		});
	}
	for (const [mainLoop, offLoop] of [
		["ws", "ws-worker"],
		["wt", "wt-stream-sink"],
	] as const) {
		if (!present.includes(mainLoop) || !present.includes(offLoop)) continue;
		const pair = withinTransportPair(mainLoop, offLoop);
		withinTransportReports.push({
			mainLoop: pair.mainLoop,
			offLoop: pair.offLoop,
		});
	}
	return { cellId, rankedComparisons, withinTransportReports, rejections };
}

// Kept as a named alias for CLI/report callers that describe this operation as
// verification rather than comparison.
export const compareEvidence = compareRunArtifacts;

export {
	artifactByteSha256,
	sealRunArtifact,
	verifyRunArtifact,
	verifyRunArtifactObject,
};
