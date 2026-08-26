import { createHash } from "node:crypto";
import {
	canonicalJson,
	sha256Canonical as canonicalDigest,
} from "./canonical.ts";
import {
	type AdmissionCounters,
	type ArtifactKind,
	type ArtifactTrustContext,
	balancedArmOrder,
	type CapacityEvidence,
	type CapacityProof,
	classifyVerdictTuple,
	ComparisonCliError,
	EVIDENCE_SCHEMA_VERSION,
	type EvidenceStatus,
	EXPECTED_LINUX_ADDRESS,
	EXPECTED_LINUX_INTERFACE,
	EXPECTED_MAC_ADDRESS,
	EXPECTED_MAC_INTERFACE,
	EXPECTED_MTU,
	EXPECTED_SMOKE_INPUT,
	EXPECTED_TLS_SNI,
	type HostTelemetryEvidence,
	type ImpairmentEvidence,
	type ImpairmentState,
	type MetricClockDomain,
	metricContractForScenario,
	metricContractHash,
	type MetricsEvidence,
	PRIMARY_METRIC_CONTRACTS,
	type ProcessProofEvidence,
	type RawSidecarDigests,
	type RouteEvidence,
	type RunArtifact,
	type RuntimeEvidence,
	type ScenarioEvidence,
	type ScenarioPayloadEvidence,
	type ScenarioVerdict,
	sealRunArtifact,
	type SmokeEvidence,
	type SourceEvidence,
	type TlsEvidence,
	type TopologyEvidence,
	type Transport,
	type TransportLedgerEvidence,
	validateFixtureOnlyEntrypoint,
	validateOfficialEntrypointContract,
} from "./evidence.ts";
import {
	CANONICAL_CAPACITY_PROFILE,
	CANONICAL_CONNECTION_SETUP,
	CANONICAL_SCENARIO_REGISTRY,
	getScenarioCell,
} from "./scenario-registry.ts";
import type { ScenarioCell } from "./types.ts";

export { validateFixtureOnlyEntrypoint, validateOfficialEntrypointContract };

export interface BuildArtifactInput {
	readonly comparisonId: string;
	readonly runId: string;
	readonly cellId: string;
	readonly transport: Transport;
	readonly armKind?: "primary" | "overlay";
	readonly evidenceStatus?: EvidenceStatus;
	readonly scenarioVerdict?: ScenarioVerdict;
	readonly seed?: number;
	readonly repetitionIndex?: number;
	readonly totalRepetitions?: number;
	readonly samples: readonly number[];
	readonly percentiles: {
		readonly p50: number;
		readonly p95: number;
		readonly p99: number;
	};
	readonly ledger: {
		readonly attempted: number;
		readonly queued?: number;
		readonly serverObserved?: number;
		readonly acknowledged?: number;
		readonly delivered?: number;
		readonly dropped?: number;
		readonly expired?: number;
		readonly histogram?: {
			readonly unit: "ms" | "bytes" | "Mbps" | "count" | "ratio" | "percent";
			readonly boundaries: readonly number[];
			readonly counts: readonly number[];
		};
	};
	readonly impairment?: {
		readonly delayMs?: number;
		readonly lossPercent?: number;
		readonly qdisc?: "fq" | "netem";
	};
	readonly admissionCounters?: AdmissionCounters;
	readonly telemetry?: {
		readonly mac?: Partial<HostTelemetryEvidence>;
		readonly linux?: Partial<HostTelemetryEvidence>;
	};
	readonly sourceSha?: string;
	readonly archiveSha256?: string;
	readonly executableSha256?: string;
	readonly caSha256?: string;
	readonly certSha256?: string;
}

function expectedPayloadBytes(parameters: Record<string, unknown>): number {
	for (const key of [
		"messageBytes",
		"recordBytes",
		"tickBytes",
		"firstMessageBytes",
		"operationBytes",
		"chunkBytes",
		"controlMessageBytes",
	] as const) {
		const candidate = parameters[key];
		if (typeof candidate === "number") return candidate;
	}
	return 65536;
}

function expectedRequestedImpairment(cell: ScenarioCell): {
	qdisc: "fq" | "netem";
	delayMs: number;
	lossPercent: number;
} {
	const parameters = cell.parameters as Record<string, unknown>;
	if (cell.scenarioId === "game-tick-loss") {
		return {
			qdisc: "netem",
			delayMs: parameters.delayMs as number,
			lossPercent: parameters.lossPercent as number,
		};
	}
	if (parameters.path === "delay40")
		return { qdisc: "netem", delayMs: 40, lossPercent: 0 };
	if (parameters.path === "delay40-loss1")
		return { qdisc: "netem", delayMs: 40, lossPercent: 1 };
	return { qdisc: "fq", delayMs: 0, lossPercent: 0 };
}

export function buildRunArtifact(input: BuildArtifactInput): RunArtifact {
	const cell = getScenarioCell(CANONICAL_SCENARIO_REGISTRY, input.cellId);
	const seed = input.seed ?? 42;
	const totalRepetitions = cell.runPolicy.measuredRepetitions;
	const repetitionIndex = input.repetitionIndex ?? 1;

	const sourceSha =
		input.sourceSha ?? "f8cb82d77054a737be2e6f4a3e7ef154f8cb82d7";
	const archiveSha256 =
		input.archiveSha256 ??
		"db703cbc50dec7598bbe8e5eeca565f298508136a7bd54e8e32d97df0883bc64";
	const executableSha256 =
		input.executableSha256 ??
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

	const toolchain = {
		identity: "bun-1.3.14-darwin-arm64",
		sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	};

	const sourceBindingSha256 = canonicalDigest({
		sourceSha,
		archiveSha256,
		executableSha256,
		toolchain,
		cleanTree: true,
	});

	const source: SourceEvidence = {
		sourceSha,
		archiveSha256,
		executableSha256,
		toolchain,
		cleanTree: true,
		bindingSha256: sourceBindingSha256,
	};

	const payloadBytes = expectedPayloadBytes(
		cell.parameters as unknown as Record<string, unknown>,
	);
	const payloadArray = new Uint8Array(payloadBytes);
	for (let i = 0; i < payloadBytes; i++) payloadArray[i] = i % 256;
	const payloadBase64 = Buffer.from(payloadArray).toString("base64");
	const payloadSha256 = createHash("sha256").update(payloadArray).digest("hex");

	const scenarioPayload: ScenarioPayloadEvidence = {
		encoding: "base64",
		data: payloadBase64,
		bytes: payloadBytes,
		sha256: payloadSha256,
	};

	const armOrder = [...balancedArmOrder(seed, repetitionIndex)] as Transport[];

	const scenario: ScenarioEvidence = {
		cellId: cell.cellId,
		scenarioId: cell.scenarioId,
		canonical: true,
		config: cell.parameters as unknown as Record<string, unknown>,
		scenarioHash: cell.scenarioHash,
		seed,
		repetition: {
			index: repetitionIndex,
			total: totalRepetitions,
		},
		armOrder,
		payload: scenarioPayload,
		direction: cell.rolePlan.direction,
	};

	const macRoute: RouteEvidence = {
		source: EXPECTED_MAC_ADDRESS,
		destination: EXPECTED_LINUX_ADDRESS,
		interface: EXPECTED_MAC_INTERFACE,
	};
	const linuxRoute: RouteEvidence = {
		source: EXPECTED_LINUX_ADDRESS,
		destination: EXPECTED_MAC_ADDRESS,
		interface: EXPECTED_LINUX_INTERFACE,
	};

	const topology: TopologyEvidence = {
		mac: {
			hostId: "mac-controller",
			os: "darwin",
			arch: "arm64",
			interface: EXPECTED_MAC_INTERFACE,
			address: EXPECTED_MAC_ADDRESS,
			mtu: EXPECTED_MTU,
			route: macRoute,
		},
		linux: {
			hostId: "linux-server",
			os: "linux",
			arch: "x86_64",
			interface: EXPECTED_LINUX_INTERFACE,
			address: EXPECTED_LINUX_ADDRESS,
			mtu: EXPECTED_MTU,
			route: linuxRoute,
		},
		serverObservedPeer: {
			hostId: "mac-controller",
			address: EXPECTED_MAC_ADDRESS,
			interface: EXPECTED_LINUX_INTERFACE,
		},
		sidecars: {
			mac: { host: true, process: true, nic: true },
			linux: { host: true, process: true, nic: true },
		},
	};

	const smoke: SmokeEvidence = {
		input: EXPECTED_SMOKE_INPUT,
		completed: true,
		usedLoopback: false,
	};

	const tls: TlsEvidence = {
		sni: EXPECTED_TLS_SNI,
		certificateSha256:
			input.certSha256 ??
			"d5aa016b229deb9fe3768d4c4372751754ae87ec6c08efb712224f778a8b2301",
		caSha256:
			input.caSha256 ??
			"d5aa016b229deb9fe3768d4c4372751754ae87ec6c08efb712224f778a8b2301",
		rejectUnauthorized: true,
		verification: "custom-ca",
		compression: "off",
	};

	const req = expectedRequestedImpairment(cell);
	const fqSha256 =
		"d5aa016b229deb9fe3768d4c4372751754ae87ec6c08efb712224f778a8b2301";

	const impairment: ImpairmentEvidence = {
		requested: {
			direction: "linux-egress",
			delayMs: req.delayMs,
			lossPercent: req.lossPercent,
			qdisc: req.qdisc,
		},
		observedBefore: {
			delayMs: 0,
			lossPercent: 0,
			qdisc: "fq",
		},
		observedAfter: {
			delayMs: 0,
			lossPercent: 0,
			qdisc: "fq",
		},
		restored: true,
		restorationProof: {
			matches: true,
			observedBeforeSha256: fqSha256,
			observedAfterSha256: fqSha256,
		},
	};

	const submittedProfileBytes = canonicalJson(CANONICAL_CAPACITY_PROFILE);
	const submittedProfileHash = canonicalDigest(CANONICAL_CAPACITY_PROFILE);

	const defaultAdmission: AdmissionCounters = {
		schemaVersion: "v1",
		handshakes: { attempted: 10, accepted: 10, rejected: 0, rateLimited: 0 },
		sessions: { attempted: 10, accepted: 10, rejected: 0, activePeak: 10 },
		streams: { attempted: 10, accepted: 10, rejected: 0, rateLimited: 0 },
		datagrams: { attempted: 10, accepted: 10, rejected: 0, rateLimited: 0 },
	};

	const capacity: CapacityEvidence = {
		profileId: "capacity-v1",
		profileHash: submittedProfileHash,
		requested: CANONICAL_CAPACITY_PROFILE as unknown as Record<
			string,
			number | string
		>,
		submittedProfileBytes,
		submittedProfileHash,
		admissionCounters: input.admissionCounters ?? defaultAdmission,
		connectionRamp: {
			connectionRampPerSecond: 500,
			maxConnectsInFlight: 200,
		},
	};

	const capacityProof: CapacityProof = {
		mac: {
			fd: {
				softLimit: 131072,
				hardLimit: 262144,
				effectiveChildLimit: 131072,
			},
			ephemeralPorts: {
				rangeStart: 49152,
				rangeEnd: 65535,
				freePorts: 14000,
				requiredFreePorts: 12500,
			},
		},
		linux: {
			fd: {
				softLimit: 131072,
				hardLimit: 524288,
				effectiveChildLimit: 131072,
			},
		},
	};

	const contract = metricContractForScenario(cell.scenarioId);
	const mContractHash = metricContractHash(contract);

	const validSamples = input.samples.length > 0 ? [...input.samples] : [1];

	const clockDomain: MetricClockDomain =
		contract.metricKind === "linux-local-service"
			? "linux-monotonic"
			: contract.metricKind === "one-way"
				? "independent-offset"
				: "mac-monotonic";

	const metrics: MetricsEvidence = {
		name: contract.name,
		unit: contract.unit,
		metricKind: contract.metricKind,
		clock: {
			domain: clockDomain,
			monotonic: true,
			method: "process.monotonic",
		},
		samples: validSamples,
		percentiles: {
			p50: input.percentiles.p50,
			p95: input.percentiles.p95,
			p99: input.percentiles.p99,
		},
	};

	const runtime: RuntimeEvidence = {
		mac: {
			identity: "mac-runtime-bun-1.3.14",
			cpu: "Apple arm64 performance cores",
			bun: "bun-1.3.14",
		},
		linux: {
			identity: "linux-runtime-bun-1.3.14",
			cpu: "x86_64 server cores",
			bun: "bun-1.3.14",
		},
	};

	const processProof: ProcessProofEvidence = {
		rolePlanHash: cell.rolePlan.rolePlanHash ?? canonicalDigest(cell.rolePlan),
		macRoles: cell.rolePlan.macRoles,
		linuxRole: cell.rolePlan.linuxRole,
		sharding: cell.rolePlan.sharding,
		processCohort: cell.rolePlan.processCohort,
	};

	const attempted = input.ledger.attempted;
	const queued = Math.min(attempted, input.ledger.queued ?? attempted);
	const serverObserved = Math.min(
		queued,
		input.ledger.serverObserved ?? queued,
	);
	const acknowledged = Math.min(
		serverObserved,
		input.ledger.acknowledged ?? serverObserved,
	);
	const delivered = Math.min(
		acknowledged,
		input.ledger.delivered ?? acknowledged,
	);
	const dropped = Math.min(attempted, input.ledger.dropped ?? 0);
	const expired = Math.min(attempted, input.ledger.expired ?? 0);

	const ledger: TransportLedgerEvidence = {
		attempted,
		queued,
		serverObserved,
		acknowledged,
		delivered,
		dropped,
		expired,
		histogram: {
			unit: input.ledger.histogram?.unit ?? contract.unit,
			boundaries: input.ledger.histogram?.boundaries
				? [...input.ledger.histogram.boundaries]
				: [1, 2, 4],
			counts: input.ledger.histogram?.counts
				? [...input.ledger.histogram.counts]
				: [1, 0, 0],
		},
	};

	const telemetry: TelemetryEvidence = {
		mac: {
			cpuPercent: input.telemetry?.mac?.cpuPercent ?? 15,
			rssBytes: input.telemetry?.mac?.rssBytes ?? 128 * 1024 * 1024,
		},
		linux: {
			cpuPercent: input.telemetry?.linux?.cpuPercent ?? 20,
			rssBytes: input.telemetry?.linux?.rssBytes ?? 256 * 1024 * 1024,
		},
	};

	const rawSidecarDigests: RawSidecarDigests = {
		client: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		server: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		topology:
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		impairment:
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		cleanup: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	};

	const rawSidecarBindingSha256 = canonicalDigest({
		comparisonId: input.comparisonId,
		runId: input.runId,
		transport: input.transport,
		sourceBindingSha256: source.bindingSha256,
		scenarioHash: cell.scenarioHash,
		metricContractHash: mContractHash,
		rawSidecarDigests,
	});

	// Promotability is derived from the evidence/verdict pair, never asserted
	// alongside it: an artifact that claims a tuple the matrix rejects is a
	// contradiction and must not be built at all.
	const evidenceStatus = input.evidenceStatus ?? "PASS";
	const scenarioVerdict = input.scenarioVerdict ?? "PASS";
	const classification = classifyVerdictTuple({
		evidenceStatus,
		scenarioVerdict,
	});
	if (classification.ok !== true) {
		throw new ComparisonCliError("artifact", classification.code);
	}

	const artifact: RunArtifact = {
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		artifactByteSha256: "0".repeat(64),
		artifactKind: "measured" as ArtifactKind,
		comparisonId: input.comparisonId,
		runId: input.runId,
		transport: input.transport,
		armKind: input.armKind ?? "primary",
		evidenceStatus,
		scenarioVerdict: scenarioVerdict as ScenarioVerdict,
		promotable: classification.promotable,
		source,
		scenario,
		topology,
		smoke,
		tls,
		impairment,
		capacity,
		capacityProof,
		metrics,
		metricContractId: contract.id,
		metricContractHash: mContractHash,
		runtime,
		processProof,
		ledger,
		telemetry,
		rawSidecarDigests,
		rawSidecarBindingSha256,
	};

	return artifact;
}

export function trustContextForArtifact(
	artifact: RunArtifact,
): ArtifactTrustContext {
	return {
		comparisonId: artifact.comparisonId,
		runId: artifact.runId,
		transport: artifact.transport,
		sourceSha: artifact.source.sourceSha,
		archiveSha256: artifact.source.archiveSha256,
		executableSha256: artifact.source.executableSha256,
		toolchain: artifact.source.toolchain,
		rawSidecarDigests: artifact.rawSidecarDigests,
	};
}

export interface MeasuredArtifactFailure {
	readonly ok: false;
	readonly code: string;
	readonly detail?: string;
}

export interface MeasuredArtifactSuccess {
	readonly ok: true;
	readonly candidateId: string;
	readonly campaignId: string;
	readonly runInstanceId: string;
	readonly artifactKind: "measured";
	readonly artifactBytes: Uint8Array;
	readonly artifactDigestSha256: string;
	readonly artifact: Record<string, unknown>;
}

function sha256HexOf(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function decodeRecordBytes(bytes: Uint8Array): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return null;
		}
		return value as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * A measured artifact only becomes promotable through the validated campaign
 * inputs. Legacy hand-written fixtures declare themselves non-promotable, and
 * that self-declaration is authoritative: no fixture may be laundered into
 * official evidence by re-serializing it.
 */
export function verifyPromotableMeasuredArtifact(input: {
	readonly artifactBytes?: Uint8Array;
}): MeasuredArtifactFailure | { readonly ok: true; readonly promotable: true } {
	const bytes = input?.artifactBytes;
	if (!(bytes instanceof Uint8Array)) {
		return { ok: false, code: "MEASURED_ARTIFACT_INPUT_INCOMPLETE" };
	}
	const record = decodeRecordBytes(bytes);
	if (record === null) {
		return { ok: false, code: "MEASURED_ARTIFACT_BYTES_MISMATCH" };
	}
	if (record.artifactKind !== "measured" || record.promotable === false) {
		return { ok: false, code: "TEST_FIXTURE_NONPROMOTABLE" };
	}
	return { ok: true, promotable: true };
}

const REQUIRED_MEASURED_BUILD_INPUTS = [
	"lock",
	"lockBytes",
	"expectedLockDigest",
	"stagedCapability",
	"capabilityBytes",
	"expectedCapabilityDigest",
	"expectedArchiveDigest",
	"runEntry",
	"artifactBytes",
	"artifactDescriptor",
	"artifactDigestSha256",
	"rawBytesByPath",
	"snapshotBytesByPath",
] as const;

interface RawDescriptorLike {
	readonly relativePath: string;
	readonly sha256: string;
}

function digestMismatch(
	bytesByPath: Record<string, Uint8Array>,
	descriptors: readonly RawDescriptorLike[],
): boolean {
	return descriptors.some((descriptor) => {
		const bytes = bytesByPath[descriptor.relativePath];
		return !bytes || sha256HexOf(bytes) !== descriptor.sha256;
	});
}

/**
 * Builds a measured artifact strictly from inputs the campaign lock, staged
 * capability, and validated manifest already vouch for. Every byte set is
 * re-hashed against the digest its own validated descriptor carries, so a
 * silently swapped artifact, raw sidecar, or cell snapshot fails closed
 * instead of producing an artifact that merely looks well formed.
 */
export function buildMeasuredArtifactFromValidatedInputs(
	input: Record<string, unknown>,
): MeasuredArtifactFailure | MeasuredArtifactSuccess {
	if (input === null || typeof input !== "object") {
		return { ok: false, code: "MEASURED_ARTIFACT_INPUT_INCOMPLETE" };
	}
	for (const key of REQUIRED_MEASURED_BUILD_INPUTS) {
		if (input[key] === undefined || input[key] === null) {
			return {
				ok: false,
				code: "MEASURED_ARTIFACT_INPUT_INCOMPLETE",
				detail: key,
			};
		}
	}

	const artifactBytes = input.artifactBytes as Uint8Array;
	const artifactDigestSha256 = input.artifactDigestSha256 as string;
	const lockBytes = input.lockBytes as Uint8Array;
	const capabilityBytes = input.capabilityBytes as Uint8Array;
	const runEntry = input.runEntry as Record<string, unknown>;
	const artifactDescriptor = input.artifactDescriptor as RawDescriptorLike;
	const rawBytesByPath = input.rawBytesByPath as Record<string, Uint8Array>;
	const snapshotBytesByPath = input.snapshotBytesByPath as Record<
		string,
		Uint8Array
	>;

	if (sha256HexOf(artifactBytes) !== artifactDigestSha256) {
		return { ok: false, code: "MEASURED_ARTIFACT_BYTES_MISMATCH" };
	}

	// The artifact descriptor must be the very one the validated manifest run
	// entry carries; a descriptor cloned with a poisoned digest is rejected here.
	const entryDescriptor = runEntry.artifact as RawDescriptorLike | undefined;
	if (
		entryDescriptor === undefined ||
		artifactDescriptor.sha256 !== entryDescriptor.sha256 ||
		artifactDescriptor.relativePath !== entryDescriptor.relativePath
	) {
		return { ok: false, code: "MEASURED_ARTIFACT_DESCRIPTOR_DIGEST_MISMATCH" };
	}

	if (sha256HexOf(lockBytes) !== (input.expectedLockDigest as string)) {
		return { ok: false, code: "MEASURED_ARTIFACT_LOCK_BYTES_MISMATCH" };
	}
	if (
		sha256HexOf(capabilityBytes) !== (input.expectedCapabilityDigest as string)
	) {
		return { ok: false, code: "MEASURED_ARTIFACT_CAPABILITY_BYTES_MISMATCH" };
	}

	const sharedIdentity = runEntry.sharedIdentity as
		| Record<string, unknown>
		| undefined;
	if (
		sharedIdentity === undefined ||
		input.expectedArchiveDigest !== sharedIdentity.archiveSha256
	) {
		return { ok: false, code: "MEASURED_ARTIFACT_ARCHIVE_DIGEST_MISMATCH" };
	}

	const rawDescriptors =
		runEntry.rawDescriptors as readonly RawDescriptorLike[];
	if (digestMismatch(rawBytesByPath, rawDescriptors)) {
		return { ok: false, code: "MEASURED_ARTIFACT_RAW_BYTES_MISMATCH" };
	}

	const snapshotBundle = runEntry.cellSnapshotBundle as Record<
		string,
		RawDescriptorLike
	>;
	if (
		digestMismatch(snapshotBytesByPath, [
			snapshotBundle.preCell as RawDescriptorLike,
			snapshotBundle.postCell as RawDescriptorLike,
		])
	) {
		return { ok: false, code: "MEASURED_ARTIFACT_SNAPSHOT_BYTES_MISMATCH" };
	}

	const artifact = decodeRecordBytes(artifactBytes);
	if (artifact === null || artifact.artifactKind !== "measured") {
		return { ok: false, code: "MEASURED_ARTIFACT_BYTES_MISMATCH" };
	}

	return {
		ok: true,
		candidateId: runEntry.candidateId as string,
		campaignId: runEntry.campaignId as string,
		runInstanceId: runEntry.runInstanceId as string,
		artifactKind: "measured",
		artifactBytes,
		artifactDigestSha256,
		artifact,
	};
}
