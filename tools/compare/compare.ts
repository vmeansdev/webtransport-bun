import { canonicalJson } from "./canonical.ts";
import {
	type ArtifactBytes,
	type ArtifactRejection,
	type ArtifactRejectionCode,
	addRejection,
	artifactByteSha256,
	type EvidenceStatus,
	type RunArtifact,
	type ScenarioVerdict,
	sealRunArtifact,
	type Transport,
} from "./evidence.ts";
import {
	verifyRunArtifact,
	verifyRunArtifactObject,
} from "./verify-artifact.ts";

export * from "./evidence.ts";

export interface ArmComparisonResult {
	readonly visible: boolean;
	readonly evidenceStatus: EvidenceStatus;
	readonly rejections: readonly ArtifactRejection[];
	readonly artifact?: RunArtifact;
}

export interface ComparisonDelta {
	readonly metric: "p50";
	readonly unit: string;
	readonly ws: number;
	readonly wt: number;
	readonly absolute: number;
	readonly relative: number;
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

const MISSING_ARM_REJECTIONS: Readonly<Record<Transport, ArtifactRejection>> = {
	ws: {
		code: "WS_ARM_NOT_MEASURED",
		reason: "WS arm was not measured for this canonical run",
	},
	wt: {
		code: "WT_ARM_NOT_MEASURED",
		reason: "WT arm was not measured for this canonical run",
	},
};

function verifyArm(
	input: ArtifactBytes | undefined,
	expectedTransport: Transport,
): ArmComparisonResult {
	if (input === undefined) {
		return {
			visible: false,
			evidenceStatus: "BLOCKED",
			rejections: [MISSING_ARM_REJECTIONS[expectedTransport]],
		};
	}
	const verification = verifyRunArtifact(input);
	const rejections = [...verification.rejections];
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
		canonicalJson(ws.capacity.admissionCounters) !==
		canonicalJson(wt.capacity.admissionCounters)
	)
		addRejection(
			rejections,
			"CAPACITY_ADMISSION_COUNTER_INVALID",
			"WS and WT admission-counter schema/counters differ",
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
	return rejections;
}

export function compareRunArtifacts(
	wsInput: ArtifactBytes | undefined,
	wtInput: ArtifactBytes | undefined,
): ComparisonResult {
	const ws = verifyArm(wsInput, "ws");
	const wt = verifyArm(wtInput, "wt");
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
	const wsValue = ws.artifact.metrics.percentiles.p50;
	const wtValue = wt.artifact.metrics.percentiles.p50;
	const absolute = wtValue - wsValue;
	const relative = wsValue === 0 ? 0 : absolute / wsValue;
	const delta: ComparisonDelta = {
		metric: "p50",
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
		ranking: wsValue === wtValue ? "tie" : wsValue < wtValue ? "ws" : "wt",
		rejections: [],
	};
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
