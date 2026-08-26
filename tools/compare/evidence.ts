import { createHash } from "node:crypto";

import { canonicalJson, sha256Canonical } from "./canonical.ts";

export const EVIDENCE_SCHEMA_VERSION = "v1" as const;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_STRING_LENGTH = 4096;
export const MAX_SUPPORTED_PAYLOAD_BYTES = 1_048_576;
export const MAX_PAYLOAD_BASE64_LENGTH =
	4 * Math.ceil(MAX_SUPPORTED_PAYLOAD_BYTES / 3);
export const MAX_ARTIFACT_KEYS = 256;
export const MAX_ARTIFACT_DEPTH = 32;
export const MAX_ARTIFACT_SAMPLES = 100_000;
export const MAX_ARTIFACT_NODES = 200_000;
export const MAX_ARTIFACT_EDGES = 400_000;
export const MAX_ARTIFACT_KEY_BYTES = 256 * 1024;
export const MAX_ARTIFACT_STRING_BYTES = 4 * 1024 * 1024;
export const MAX_REPORTED_REJECTIONS = 128;
export const MIN_EFFECTIVE_CHILD_NOFILE = 65_536;
export const EXPECTED_MAC_ADDRESS = "10.99.0.1";
export const EXPECTED_LINUX_ADDRESS = "10.99.0.2";
export const EXPECTED_MAC_INTERFACE = "en8";
export const EXPECTED_LINUX_INTERFACE = "eno1";
export const EXPECTED_MTU = 1500;
export const EXPECTED_TLS_SNI = "wt-compare.local";
export const EXPECTED_SMOKE_INPUT = "https://10.99.0.2:4433";

export type EvidenceStatus = "PASS" | "FAIL" | "BLOCKED";
export type ScenarioVerdict = "PASS" | "MISS" | "NO_VERDICT";
export type Transport = "ws" | "wt";
export type ArtifactKind = "measured" | "test-fixture";
export type MetricUnit =
	| "ms"
	| "bytes"
	| "Mbps"
	| "count"
	| "ratio"
	| "percent";
export type MetricKind =
	| "mac-local-end-to-end"
	| "linux-local-service"
	| "one-way";
export type MetricClockDomain =
	| "mac-monotonic"
	| "linux-monotonic"
	| "independent-offset";
export type MetricDirection = "higher" | "lower";

export interface MetricContract {
	readonly id: string;
	readonly name: string;
	readonly unit: MetricUnit;
	readonly metricKind: MetricKind;
	readonly direction: MetricDirection;
	readonly minimum: number;
	readonly maximum?: number;
}

/**
 * Task 3 owns the primary metric vocabulary.  Keeping this table local to the
 * verifier prevents a producer from renaming a metric while retaining the
 * wrong clock or ranking semantics.
 */
export const PRIMARY_METRIC_CONTRACTS: Readonly<
	Record<string, MetricContract>
> = Object.freeze({
	"chat-fanout": {
		id: "chat-fanout.primary.v1",
		name: "delivered-messages-per-second",
		unit: "count",
		metricKind: "mac-local-end-to-end",
		direction: "higher",
		minimum: 0,
	},
	"ticker-fanout": {
		id: "ticker-fanout.primary.v1",
		name: "delivered-updates-per-second",
		unit: "count",
		metricKind: "linux-local-service",
		direction: "higher",
		minimum: 0,
	},
	"game-tick-loss": {
		id: "game-tick-loss.primary.v1",
		name: "delivery-percent",
		unit: "percent",
		metricKind: "mac-local-end-to-end",
		direction: "higher",
		minimum: 0,
		maximum: 100,
	},
	"reconnect-storm": {
		id: "reconnect-storm.primary.v1",
		name: "recovery-time-ms",
		unit: "ms",
		metricKind: "mac-local-end-to-end",
		direction: "lower",
		minimum: 0,
	},
	"handshake-matrix": {
		id: "handshake-matrix.primary.v1",
		name: "first-message-latency-ms",
		unit: "ms",
		metricKind: "mac-local-end-to-end",
		direction: "lower",
		minimum: 0,
	},
	"connection-memory": {
		id: "connection-memory.primary.v1",
		name: "rss-bytes-per-connection",
		unit: "bytes",
		metricKind: "mac-local-end-to-end",
		direction: "lower",
		minimum: 0,
	},
	"crdt-sync": {
		id: "crdt-sync.primary.v1",
		name: "applied-unique-ops-per-second",
		unit: "count",
		metricKind: "mac-local-end-to-end",
		direction: "higher",
		minimum: 0,
	},
	"ai-token-stream": {
		id: "ai-token-stream.primary.v1",
		name: "inter-token-latency-ms",
		unit: "ms",
		metricKind: "mac-local-end-to-end",
		direction: "lower",
		minimum: 0,
	},
	"bulk-one-way": {
		id: "bulk-one-way.primary.v1",
		name: "application-throughput-mbps",
		unit: "Mbps",
		metricKind: "mac-local-end-to-end",
		direction: "higher",
		minimum: 0,
	},
	"tail-under-cross-traffic": {
		id: "tail-under-cross-traffic.primary.v1",
		name: "control-latency-ms",
		unit: "ms",
		metricKind: "mac-local-end-to-end",
		direction: "lower",
		minimum: 0,
	},
});

export type ArtifactRejectionCode =
	| "ARTIFACT_BYTES_INVALID"
	| "ARTIFACT_BYTES_TOO_LARGE"
	| "ARTIFACT_BYTE_DIGEST_MISSING"
	| "ARTIFACT_BYTE_DIGEST_INVALID"
	| "ARTIFACT_BYTE_DIGEST_MISMATCH"
	| "SCHEMA_ROOT_INVALID"
	| "SCHEMA_UNKNOWN_FIELD"
	| "SCHEMA_OWN_FIELD_REQUIRED"
	| "SCHEMA_INVALID_FIELD"
	| "SCHEMA_RESOURCE_LIMIT"
	| "REJECTIONS_CAPPED"
	| "TRUST_CONTEXT_MISSING"
	| "TRUST_CONTEXT_INVALID"
	| "TRUST_ANCHOR_MISMATCH"
	| "ARTIFACT_KIND_INVALID"
	| "ARTIFACT_FIXTURE_NOT_PROMOTABLE"
	| "SOURCE_UNBOUND"
	| "SOURCE_SHA_INVALID"
	| "SOURCE_SHA_MISMATCH"
	| "SOURCE_ARCHIVE_DIGEST_INVALID"
	| "SOURCE_ARCHIVE_DIGEST_MISMATCH"
	| "EXECUTABLE_DIGEST_INVALID"
	| "EXECUTABLE_DIGEST_MISMATCH"
	| "TOOLCHAIN_DIGEST_INVALID"
	| "TOOLCHAIN_DIGEST_MISMATCH"
	| "RAW_SIDECAR_DIGEST_INVALID"
	| "RAW_SIDECAR_DIGEST_MISMATCH"
	| "RUN_ID_INVALID"
	| "RUN_ID_MISMATCH"
	| "COMPARISON_ID_INVALID"
	| "COMPARISON_ID_MISMATCH"
	| "TRANSPORT_INVALID"
	| "TOPOLOGY_LOOPBACK"
	| "TOPOLOGY_UNSPECIFIED"
	| "TOPOLOGY_MISSING_LINUX"
	| "TOPOLOGY_SAME_HOST"
	| "TOPOLOGY_OS_MISMATCH"
	| "TOPOLOGY_ARCH_MISMATCH"
	| "TOPOLOGY_INTERFACE_MISMATCH"
	| "TOPOLOGY_ADDRESS_MISMATCH"
	| "TOPOLOGY_ROUTE_MISMATCH"
	| "TOPOLOGY_MTU_MISMATCH"
	| "TOPOLOGY_PEER_MISSING"
	| "TOPOLOGY_PEER_MISMATCH"
	| "TOPOLOGY_SIDECAR_MISSING"
	| "SMOKE_INPUT_INVALID"
	| "SCENARIO_ID_INVALID"
	| "SCENARIO_NON_CANONICAL"
	| "SCENARIO_CONFIG_MISMATCH"
	| "SCENARIO_HASH_INVALID"
	| "SCENARIO_HASH_MISMATCH"
	| "SCENARIO_SEED_INVALID"
	| "SCENARIO_REPETITION_INVALID"
	| "SCENARIO_ARM_ORDER_INVALID"
	| "SCENARIO_PAYLOAD_INVALID"
	| "SCENARIO_PAYLOAD_MISMATCH"
	| "SCENARIO_DIRECTION_INVALID"
	| "SCENARIO_DIRECTION_MISMATCH"
	| "TLS_CONFIGURATION_INVALID"
	| "TLS_SNI_MISMATCH"
	| "TLS_CERTIFICATE_DIGEST_INVALID"
	| "TLS_CERTIFICATE_MISMATCH"
	| "TLS_CA_DIGEST_INVALID"
	| "TLS_COMPRESSION_ENABLED"
	| "IMPAIRMENT_REQUESTED_INVALID"
	| "IMPAIRMENT_OBSERVED_INVALID"
	| "IMPAIRMENT_RESTORATION_INVALID"
	| "CAPACITY_PROFILE_ID_MISMATCH"
	| "CAPACITY_PROFILE_HASH_INVALID"
	| "CAPACITY_PROFILE_HASH_MISMATCH"
	| "CAPACITY_PROFILE_VALUES_MISMATCH"
	| "CAPACITY_SUBMITTED_BYTES_MISMATCH"
	| "CAPACITY_SUBMITTED_HASH_INVALID"
	| "CAPACITY_SUBMITTED_HASH_MISMATCH"
	| "CAPACITY_ADMISSION_SCHEMA_MISMATCH"
	| "CAPACITY_ADMISSION_COUNTER_INVALID"
	| "CAPACITY_CONNECTION_RAMP_MISMATCH"
	| "CAPACITY_FD_PROOF_MISSING"
	| "CAPACITY_EFFECTIVE_LIMIT_TOO_LOW"
	| "CAPACITY_EPHEMERAL_PORT_PROOF_INVALID"
	| "METRICS_UNIT_INVALID"
	| "METRICS_SAMPLES_EMPTY"
	| "METRICS_SAMPLE_INVALID"
	| "METRICS_SAMPLES_SPARSE"
	| "METRICS_PERCENTILES_INVALID"
	| "METRICS_CONTRACT_INVALID"
	| "METRICS_ARITHMETIC_INVALID"
	| "CLOCK_PROVENANCE_INVALID"
	| "CLOCK_PROVENANCE_MISMATCH"
	| "EVIDENCE_RUNTIME_INVALID"
	| "EVIDENCE_PROCESS_PROOF_INVALID"
	| "EVIDENCE_LEDGER_INVALID"
	| "EVIDENCE_TELEMETRY_INVALID"
	| "STATUS_CONTRADICTION"
	| "COMPARISON_INCOMPATIBLE"
	| "SCENARIO_BINDING_MISMATCH"
	| "WS_ARM_NOT_MEASURED"
	| "WT_ARM_NOT_MEASURED";

export interface ArtifactRejection {
	readonly code: ArtifactRejectionCode;
	readonly reason: string;
	readonly path?: string;
}

export interface SourceEvidence {
	sourceSha: string;
	archiveSha256: string;
	executableSha256: string;
	toolchain: {
		identity: string;
		sha256: string;
	};
	cleanTree: boolean;
	bindingSha256: string;
}

export interface ScenarioPayloadEvidence {
	encoding: "base64";
	data: string;
	bytes: number;
	sha256: string;
}

export interface ScenarioEvidence {
	cellId: string;
	scenarioId: string;
	canonical: boolean;
	config: Record<string, unknown>;
	scenarioHash: string;
	seed: number;
	repetition: {
		index: number;
		total: number;
	};
	armOrder: Transport[];
	payload: ScenarioPayloadEvidence;
	direction: string;
}

export interface RouteEvidence {
	source: string;
	destination: string;
	interface: string;
}

export interface HostEvidence {
	hostId: string;
	os: "darwin" | "linux";
	arch: "arm64" | "x86_64";
	interface: string;
	address: string;
	mtu: number;
	route: RouteEvidence;
}

export interface ObservedPeerEvidence {
	hostId: string;
	address: string;
	interface: string;
}

export interface TopologyEvidence {
	mac: HostEvidence;
	linux: HostEvidence;
	serverObservedPeer: ObservedPeerEvidence;
	// The nested form makes absence of one sidecar explicit and testable.
	sidecars: {
		mac: { host: boolean; process: boolean; nic: boolean };
		linux: { host: boolean; process: boolean; nic: boolean };
	};
}

export interface SmokeEvidence {
	input: string;
	completed: boolean;
	usedLoopback: boolean;
}

export interface TlsEvidence {
	sni: string;
	certificateSha256: string;
	caSha256: string;
	rejectUnauthorized: boolean;
	verification: "custom-ca";
	compression: "off" | "permessage-deflate";
}

export interface ImpairmentState {
	qdisc: "fq" | "netem";
	delayMs: number;
	lossPercent: number;
}

export interface ImpairmentEvidence {
	requested: ImpairmentState & { direction: "linux-egress" };
	observedBefore: ImpairmentState;
	observedAfter: ImpairmentState;
	restored: boolean;
	restorationProof: {
		observedBeforeSha256: string;
		observedAfterSha256: string;
		matches: boolean;
	};
}

export interface AdmissionCounters {
	schemaVersion: "v1";
	handshakes: {
		attempted: number;
		accepted: number;
		rejected: number;
		rateLimited: number;
	};
	sessions: {
		attempted: number;
		accepted: number;
		rejected: number;
		activePeak: number;
	};
	streams: {
		attempted: number;
		accepted: number;
		rejected: number;
		rateLimited: number;
	};
	datagrams: {
		attempted: number;
		accepted: number;
		rejected: number;
		rateLimited: number;
	};
}

export interface CapacityEvidence {
	profileId: string;
	profileHash: string;
	requested: Record<string, number | string>;
	submittedProfileBytes: string;
	submittedProfileHash: string;
	admissionCounters: AdmissionCounters;
	connectionRamp: {
		connectionRampPerSecond: number;
		maxConnectsInFlight: number;
	};
}

export interface CapacityProof {
	mac: {
		fd: {
			softLimit: number;
			hardLimit: number;
			effectiveChildLimit: number;
		};
		ephemeralPorts: {
			rangeStart: number;
			rangeEnd: number;
			freePorts: number;
			requiredFreePorts: number;
		};
	};
	linux: {
		fd: {
			softLimit: number;
			hardLimit: number;
			effectiveChildLimit: number;
		};
	};
}

export interface MetricsEvidence {
	name: string;
	unit: MetricUnit;
	metricKind: MetricKind;
	clock: {
		domain: MetricClockDomain;
		monotonic: boolean;
		method: string;
		offsetMs?: number;
		uncertaintyMs?: number;
	};
	samples: number[];
	percentiles: {
		p50: number;
		p95: number;
		p99: number;
	};
}

export interface RuntimeEvidence {
	mac: { cpu: string; bun: string; identity: string };
	linux: { cpu: string; bun: string; identity: string };
}

export interface ProcessProofEvidence {
	rolePlanHash: string;
	macRoles: ReadonlyArray<{
		role: string;
		count: number;
		processModel: string;
	}>;
	linuxRole: string;
	sharding: {
		role: string;
		workerCount: number;
		strategy: string;
		shards: ReadonlyArray<{
			workerIndex: number;
			clientIds: ReadonlyArray<number>;
		}>;
	};
	processCohort: {
		kind: string;
		processes: number;
		primeBeforeMeasurement: boolean;
		measuredCycles: number;
	};
}

export interface TransportLedgerEvidence {
	attempted: number;
	queued: number;
	serverObserved: number;
	acknowledged: number;
	delivered: number;
	expired: number;
	dropped: number;
	histogram: {
		unit: MetricUnit;
		boundaries: number[];
		counts: number[];
	};
}

export interface HostTelemetryEvidence {
	cpuPercent: number;
	rssBytes: number;
}

export interface TelemetryEvidence {
	mac: HostTelemetryEvidence;
	linux: HostTelemetryEvidence;
}

export interface RawSidecarDigests {
	client: string;
	server: string;
	topology: string;
	impairment: string;
	cleanup: string;
}

export interface RunArtifact {
	schemaVersion: "v1";
	artifactByteSha256: string;
	artifactKind: ArtifactKind;
	comparisonId: string;
	runId: string;
	transport: Transport;
	/**
	 * A lossy game overlay rides the WS transport of the primary arm it shadows,
	 * so the arm kind — not the transport — is what separates the two. Delta and
	 * ranking sets exclude `"overlay"`, which they can only do if an overlay is
	 * representable here in the first place.
	 */
	armKind: "primary" | "overlay";
	evidenceStatus: EvidenceStatus;
	scenarioVerdict: ScenarioVerdict;
	promotable: boolean;
	source: SourceEvidence;
	scenario: ScenarioEvidence;
	topology: TopologyEvidence;
	smoke: SmokeEvidence;
	tls: TlsEvidence;
	impairment: ImpairmentEvidence;
	capacity: CapacityEvidence;
	capacityProof: CapacityProof;
	metrics: MetricsEvidence;
	metricContractId: string;
	metricContractHash: string;
	runtime: RuntimeEvidence;
	processProof: ProcessProofEvidence;
	ledger: TransportLedgerEvidence;
	telemetry: TelemetryEvidence;
	rawSidecarDigests: RawSidecarDigests;
	rawSidecarBindingSha256: string;
}

export interface ArtifactTrustContext {
	readonly comparisonId: string;
	readonly runId: string;
	readonly transport: Transport;
	readonly sourceSha: string;
	readonly archiveSha256: string;
	readonly executableSha256: string;
	readonly toolchain: { readonly identity: string; readonly sha256: string };
	readonly rawSidecarDigests: RawSidecarDigests;
	readonly artifactByteSha256?: string;
}

export interface ArtifactVerification {
	evidenceStatus: EvidenceStatus;
	readonly rejections: readonly ArtifactRejection[];
	readonly artifact?: RunArtifact;
	readonly artifactByteSha256?: string;
	readonly artifactKind?: ArtifactKind;
}

export type ArtifactBytes = ArrayBufferView | ArrayBuffer | string;

export function metricContractForScenario(
	scenarioId: unknown,
): MetricContract | undefined {
	return typeof scenarioId === "string"
		? PRIMARY_METRIC_CONTRACTS[scenarioId]
		: undefined;
}

export function metricContractHash(contract: MetricContract): string {
	return sha256Canonical(contract);
}

export function balancedArmOrder(
	seed: number,
	repetitionIndex: number,
): readonly [Transport, Transport, Transport, Transport] {
	const parity =
		Number.parseInt(
			sha256Bytes(textEncoder.encode(`${seed}:${repetitionIndex}`))[0] ?? "0",
			16,
		) & 1;
	return parity === 0 ? ["ws", "wt", "wt", "ws"] : ["wt", "ws", "ws", "wt"];
}

const HEX_40 = /^[0-9a-f]{40}$/;
const HEX_64 = /^[0-9a-f]{64}$/;
const BASE64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: true,
});
const objectHasOwn = Object.hasOwn;
const objectPrototype = Object.prototype;
const arrayBufferIsView = ArrayBuffer.isView;
const uint8ArrayConstructor = Uint8Array;
const uint8ArraySet = Uint8Array.prototype.set;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(
	ArrayBuffer.prototype,
	"byteLength",
)?.get;
const sharedArrayBufferByteLengthGetter =
	typeof SharedArrayBuffer === "undefined"
		? undefined
		: Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength")
				?.get;
const dataViewBufferGetter = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"buffer",
)?.get;
const dataViewByteOffsetGetter = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"byteOffset",
)?.get;
const dataViewByteLengthGetter = Object.getOwnPropertyDescriptor(
	DataView.prototype,
	"byteLength",
)?.get;
const typedArrayBufferGetter = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"buffer",
)?.get;

// The source above intentionally uses captured intrinsic accessors.  Bun's
// typed-array prototype has the getter on a parent prototype; the fallback is
// only for engines that expose it directly.
const viewBufferGetter =
	typedArrayBufferGetter ??
	Object.getOwnPropertyDescriptor(Uint8Array.prototype, "buffer")?.get;
const viewByteOffsetGetter =
	Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(Uint8Array.prototype),
		"byteOffset",
	)?.get ??
	Object.getOwnPropertyDescriptor(Uint8Array.prototype, "byteOffset")?.get;
const viewByteLengthGetter =
	Object.getOwnPropertyDescriptor(
		Object.getPrototypeOf(Uint8Array.prototype),
		"byteLength",
	)?.get ??
	Object.getOwnPropertyDescriptor(Uint8Array.prototype, "byteLength")?.get;

function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function invalid(message: string): never {
	throw new TypeError(message);
}

function ownDescriptorValue(
	owner: object,
	descriptor: PropertyDescriptor,
): unknown {
	if (objectHasOwn(descriptor, "value")) return descriptor.value;
	const getter = descriptor.get;
	if (typeof getter !== "function") invalid("accessor field has no getter");
	return getter.call(owner);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === objectPrototype || prototype === null;
}

interface SnapshotContext {
	readonly seen: WeakSet<object>;
	nodes: number;
	edges: number;
	keyBytes: number;
	stringBytes: number;
	outputBytes: number;
}

function newSnapshotContext(): SnapshotContext {
	return {
		seen: new WeakSet<object>(),
		nodes: 0,
		edges: 0,
		keyBytes: 0,
		stringBytes: 0,
		outputBytes: 0,
	};
}

function snapshotStringLimit(path: string): number {
	return path === "$.scenario.payload.data"
		? MAX_PAYLOAD_BASE64_LENGTH
		: MAX_ARTIFACT_STRING_LENGTH;
}

function snapshotValue(
	value: unknown,
	path: string,
	depth: number,
	context: SnapshotContext,
): unknown {
	if (depth > MAX_ARTIFACT_DEPTH)
		invalid(`${path} exceeds maximum nesting depth`);
	if (value === null) {
		context.outputBytes += 4;
		return null;
	}
	if (typeof value === "string") {
		const maximumLength = snapshotStringLimit(path);
		const stringBytes = textEncoder.encode(value).byteLength;
		if (value.length > maximumLength || stringBytes > MAX_ARTIFACT_STRING_BYTES)
			invalid(`${path} string is too long`);
		context.stringBytes += stringBytes;
		context.outputBytes += stringBytes + 2;
		if (context.stringBytes > MAX_ARTIFACT_STRING_BYTES)
			invalid(`${path} exceeds the string byte budget`);
		return value;
	}
	if (typeof value === "boolean") {
		context.outputBytes += value ? 4 : 5;
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalid(`${path} must be finite`);
		context.outputBytes += 24;
		return value;
	}
	if (typeof value !== "object") invalid(`${path} has unsupported type`);
	if (context.seen.has(value))
		invalid(`${path} contains a cycle or repeated shared reference`);
	context.seen.add(value);
	context.nodes += 1;
	if (context.nodes > MAX_ARTIFACT_NODES)
		invalid(`${path} exceeds the node budget`);

	if (Array.isArray(value)) {
		let descriptors: Record<string, PropertyDescriptor>;
		try {
			descriptors = Object.getOwnPropertyDescriptors(value) as Record<
				string,
				PropertyDescriptor
			>;
		} catch {
			invalid(`${path} cannot be snapshotted`);
		}
		const lengthDescriptor = descriptors.length;
		if (!lengthDescriptor) invalid(`${path} array length must be own`);
		const rawLength = ownDescriptorValue(value, lengthDescriptor);
		if (
			typeof rawLength !== "number" ||
			!Number.isSafeInteger(rawLength) ||
			rawLength < 0 ||
			rawLength > MAX_ARTIFACT_SAMPLES
		)
			invalid(`${path} array length is invalid`);
		const length = rawLength as number;
		context.edges += length;
		if (context.edges > MAX_ARTIFACT_EDGES)
			invalid(`${path} exceeds the edge budget`);
		for (const key of Reflect.ownKeys(descriptors)) {
			if (key === "length") continue;
			if (typeof key !== "string" || !/^\d+$/.test(key))
				invalid(`${path} has an unexpected array property`);
			const index = Number(key);
			if (
				!Number.isSafeInteger(index) ||
				index < 0 ||
				index >= length ||
				String(index) !== key
			)
				invalid(`${path} has an invalid array index`);
		}
		const output: unknown[] = [];
		context.outputBytes += 2;
		for (let index = 0; index < length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (!descriptor) invalid(`${path} is sparse at index ${index}`);
			output.push(
				snapshotValue(
					ownDescriptorValue(value, descriptor),
					`${path}[${index}]`,
					depth + 1,
					context,
				),
			);
		}
		return output;
	}

	if (!isPlainObject(value)) invalid(`${path} must be a plain object`);
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
	} catch {
		invalid(`${path} cannot be snapshotted`);
	}
	const keys = Reflect.ownKeys(descriptors);
	if (keys.length > MAX_ARTIFACT_KEYS) invalid(`${path} has too many fields`);
	const output: Record<string, unknown> = Object.create(null) as Record<
		string,
		unknown
	>;
	context.outputBytes += 2;
	for (const key of keys) {
		if (typeof key !== "string") invalid(`${path} has a symbol field`);
		const keyBytes = textEncoder.encode(key).byteLength;
		if (
			key.length > MAX_ARTIFACT_STRING_LENGTH ||
			keyBytes > MAX_ARTIFACT_STRING_LENGTH
		)
			invalid(`${path}.${key} key is too long`);
		context.keyBytes += keyBytes;
		context.outputBytes += keyBytes + 4;
		if (context.keyBytes > MAX_ARTIFACT_KEY_BYTES)
			invalid(`${path} exceeds the key byte budget`);
		const descriptor = descriptors[key];
		if (!descriptor) invalid(`${path}.${key} descriptor is missing`);
		const propertyValue = ownDescriptorValue(value, descriptor);
		// JSON has no undefined value. Treat an explicitly undefined field as
		// absent so the schema layer can emit the stable missing-own-field code.
		if (propertyValue === undefined) continue;
		context.edges += 1;
		if (context.edges > MAX_ARTIFACT_EDGES)
			invalid(`${path} exceeds the edge budget`);
		output[key] = snapshotValue(
			propertyValue,
			`${path}.${key}`,
			depth + 1,
			context,
		);
	}
	return output;
}

/** Snapshot an untrusted value through one shared, bounded traversal. */
export function snapshotEvidenceValue(
	value: unknown,
	path = "$",
	depth = 0,
): unknown {
	const context = newSnapshotContext();
	const snapshot = snapshotValue(value, path, depth, context);
	try {
		if (
			textEncoder.encode(canonicalJson(snapshot)).byteLength >
			MAX_ARTIFACT_BYTES
		)
			invalid("snapshot canonical output exceeds the artifact byte budget");
	} catch {
		invalid("snapshot canonical output is invalid");
	}
	if (context.outputBytes > MAX_ARTIFACT_BYTES)
		invalid("snapshot output exceeds the artifact byte budget");
	return snapshot;
}

function bytesFromInput(input: ArtifactBytes): Uint8Array {
	if (typeof input === "string") {
		const bytes = textEncoder.encode(input);
		if (bytes.byteLength > MAX_ARTIFACT_BYTES)
			throw new RangeError("artifact bytes are too large");
		return bytes;
	}
	const backingByteLength = (value: unknown): number | undefined => {
		for (const getter of [
			arrayBufferByteLengthGetter,
			sharedArrayBufferByteLengthGetter,
		]) {
			if (!getter) continue;
			try {
				return getter.call(value) as number;
			} catch {
				// Try the other backing brand, if available.
			}
		}
		return undefined;
	};
	const isArrayBufferValue = (value: unknown): boolean => {
		return backingByteLength(value) !== undefined;
	};
	const copyView = (
		buffer: unknown,
		byteOffset: number,
		byteLength: number,
	): Uint8Array => {
		if (
			!Number.isSafeInteger(byteOffset) ||
			!Number.isSafeInteger(byteLength) ||
			byteOffset < 0 ||
			byteLength < 0
		)
			invalid("artifact byte view has an invalid range");
		const output = new uint8ArrayConstructor(byteLength);
		const source = new uint8ArrayConstructor(
			buffer as ArrayBufferLike,
			byteOffset,
			byteLength,
		);
		uint8ArraySet.call(output, source);
		return output;
	};
	if (isArrayBufferValue(input)) {
		const byteLength = backingByteLength(input);
		if (
			byteLength === undefined ||
			!Number.isSafeInteger(byteLength) ||
			byteLength < 0
		)
			invalid("artifact ArrayBuffer has an invalid length");
		if (byteLength > MAX_ARTIFACT_BYTES)
			throw new RangeError("artifact bytes are too large");
		return copyView(input, 0, byteLength);
	}
	if (!arrayBufferIsView(input))
		invalid("artifact input must be UTF-8 text or bytes");
	let buffer: unknown;
	let offset: number | undefined;
	let length: number | undefined;
	let isDataView = false;
	try {
		length = dataViewByteLengthGetter?.call(input) as number | undefined;
		isDataView = length !== undefined;
	} catch {
		// The DataView brand check failed; try the captured TypedArray accessors.
	}
	try {
		if (isDataView) {
			buffer = dataViewBufferGetter?.call(input);
			offset = dataViewByteOffsetGetter?.call(input) as number | undefined;
		} else {
			buffer = viewBufferGetter?.call(input);
			offset = viewByteOffsetGetter?.call(input) as number | undefined;
			length = viewByteLengthGetter?.call(input) as number | undefined;
		}
	} catch {
		invalid("artifact byte view is unsupported");
	}
	if (
		!buffer ||
		offset === undefined ||
		length === undefined ||
		!Number.isSafeInteger(offset) ||
		!Number.isSafeInteger(length)
	) {
		invalid("artifact byte view is unsupported");
	}
	const backingLength = backingByteLength(buffer);
	if (
		backingLength === undefined ||
		!Number.isSafeInteger(backingLength) ||
		offset + length > backingLength
	)
		invalid("artifact byte view has an invalid range");
	if (length > MAX_ARTIFACT_BYTES)
		throw new RangeError("artifact bytes are too large");
	return copyView(buffer, offset, length);
}

export function artifactInputBytes(input: ArtifactBytes): Uint8Array {
	return bytesFromInput(input);
}

function skipWhitespace(text: string, index: number): number {
	while (index < text.length && /\s/.test(text[index] ?? "")) index += 1;
	return index;
}

/** Locate an exact top-level string property value in JSON text. */
interface TopLevelStringValue {
	readonly start: number;
	readonly end: number;
	readonly value: string;
	readonly count: number;
}

/** Return the first duplicate JSON object key, if the byte text contains one. */
export function findDuplicateJsonKey(text: string): string | undefined {
	type ObjectFrame = { readonly kind: "object"; readonly keys: Set<string> };
	type Frame = ObjectFrame | { readonly kind: "array" };
	const frames: Frame[] = [];
	let index = 0;
	while (index < text.length) {
		const character = text[index];
		if (character === '"') {
			const start = index;
			index += 1;
			let escaped = false;
			while (index < text.length) {
				const current = text[index];
				if (escaped) {
					escaped = false;
					index += 1;
					continue;
				}
				if (current === "\\") {
					escaped = true;
					index += 1;
					continue;
				}
				if (current === '"') break;
				index += 1;
			}
			if (index >= text.length) return undefined;
			const endQuote = index;
			const after = skipWhitespace(text, index + 1);
			const frame = frames[frames.length - 1];
			if (frame?.kind === "object" && text[after] === ":") {
				let key: unknown;
				try {
					key = JSON.parse(text.slice(start, endQuote + 1));
				} catch {
					return undefined;
				}
				if (typeof key === "string") {
					if (frame.keys.has(key)) return key;
					frame.keys.add(key);
				}
			}
			index = endQuote + 1;
			continue;
		}
		if (character === "{") frames.push({ kind: "object", keys: new Set() });
		else if (character === "[") frames.push({ kind: "array" });
		else if (character === "}" || character === "]") frames.pop();
		index += 1;
	}
	return undefined;
}

function findTopLevelStringValue(
	text: string,
	field: string,
): TopLevelStringValue | undefined {
	let index = 0;
	let depth = 0;
	let count = 0;
	let located: Omit<TopLevelStringValue, "count"> | undefined;
	while (index < text.length) {
		const character = text[index];
		if (character === '"') {
			const start = index;
			index += 1;
			let escaped = false;
			while (index < text.length) {
				const current = text[index];
				if (escaped) {
					escaped = false;
					index += 1;
					continue;
				}
				if (current === "\\") {
					escaped = true;
					index += 1;
					continue;
				}
				if (current === '"') break;
				index += 1;
			}
			if (index >= text.length) return undefined;
			const endQuote = index;
			let after = skipWhitespace(text, index + 1);
			if (depth === 1 && text[after] === ":") {
				const keyText = text.slice(start, endQuote + 1);
				let key: unknown;
				try {
					key = JSON.parse(keyText);
				} catch {
					return undefined;
				}
				after = skipWhitespace(text, after + 1);
				if (key === field) {
					count += 1;
					// The self-digest field is intentionally stricter than ordinary
					// JSON: only an unescaped literal key and value are maskable.
					if (
						keyText === `"${field}"` &&
						text[after] === '"' &&
						located === undefined
					) {
						const valueStart = after + 1;
						let valueIndex = valueStart;
						let valueEscaped = false;
						while (valueIndex < text.length) {
							const current = text[valueIndex];
							if (valueEscaped) {
								valueEscaped = false;
								valueIndex += 1;
								continue;
							}
							if (current === "\\") {
								valueEscaped = true;
								valueIndex += 1;
								continue;
							}
							if (current === '"') {
								const value = text.slice(valueStart, valueIndex);
								if (value.length === 64 && HEX_64.test(value))
									located = {
										start: valueStart,
										end: valueIndex,
										value,
									};
								break;
							}
							valueIndex += 1;
						}
					}
				}
			}
			index = endQuote + 1;
			continue;
		}
		if (character === "{") depth += 1;
		else if (character === "}") depth = Math.max(0, depth - 1);
		else if (character === "[") depth += 1;
		else if (character === "]") depth = Math.max(0, depth - 1);
		index += 1;
	}
	return located === undefined
		? count === 0
			? undefined
			: { start: -1, end: -1, value: "", count }
		: { ...located, count };
}

/**
 * Compute the digest over the exact supplied bytes with only the fixed-width
 * digest value replaced by 64 zeroes.  This is deliberately not a hash of a
 * parsed/re-serialized object, and avoids a self-referential fixed point.
 */
export function artifactByteSha256(input: ArtifactBytes): string {
	const bytes = bytesFromInput(input);
	let text: string;
	try {
		text = fatalTextDecoder.decode(bytes);
	} catch {
		throw new TypeError("artifact bytes are not valid UTF-8");
	}
	const encoded = textEncoder.encode(text);
	if (encoded.byteLength !== bytes.byteLength)
		throw new TypeError("artifact bytes cannot be normalized");
	for (let index = 0; index < bytes.length; index += 1) {
		if (bytes[index] !== encoded[index])
			throw new TypeError("artifact bytes cannot be normalized");
	}
	try {
		const parsed: unknown = JSON.parse(text);
		void parsed;
	} catch {
		throw new TypeError("artifact bytes are not valid JSON");
	}
	const duplicateKey = findDuplicateJsonKey(text);
	if (duplicateKey !== undefined)
		throw new TypeError(`artifact JSON contains duplicate key ${duplicateKey}`);
	const located = findTopLevelStringValue(text, "artifactByteSha256");
	if (
		!located ||
		located.count !== 1 ||
		located.start < 0 ||
		located.value.length !== 64 ||
		!HEX_64.test(located.value)
	) {
		throw new TypeError(
			"artifactByteSha256 must be one 64-character lowercase hexadecimal string",
		);
	}
	const maskedText = `${text.slice(0, located.start)}${"0".repeat(64)}${text.slice(located.end)}`;
	return sha256Bytes(textEncoder.encode(maskedText));
}

export function sealRunArtifact(input: unknown): Uint8Array {
	const snapshot = snapshotEvidenceValue(input) as Record<string, unknown>;
	const withoutDigest = { ...snapshot, artifactByteSha256: "0".repeat(64) };
	const masked = textEncoder.encode(canonicalJson(withoutDigest));
	const digest = sha256Bytes(masked);
	const sealed = { ...snapshot, artifactByteSha256: digest };
	return textEncoder.encode(canonicalJson(sealed));
}

export function canonicalDigest(value: unknown): string {
	return sha256Canonical(value);
}

export function isSha256(value: unknown): value is string {
	return typeof value === "string" && HEX_64.test(value);
}

export function isSha1(value: unknown): value is string {
	return typeof value === "string" && HEX_40.test(value);
}

export function isBase64(
	value: unknown,
	maximumLength = MAX_ARTIFACT_STRING_LENGTH,
): value is string {
	return (
		typeof value === "string" &&
		value.length <= maximumLength &&
		BASE64.test(value)
	);
}

export function addRejection(
	rejections: ArtifactRejection[],
	code: ArtifactRejectionCode,
	reason: string,
	path?: string,
): void {
	const state = rejectionStates.get(rejections) ?? {
		keys: new Set<string>(),
		capped: false,
	};
	if (!rejectionStates.has(rejections)) {
		for (const rejection of rejections)
			state.keys.add(`${rejection.code}\u0000${rejection.path ?? ""}`);
		rejectionStates.set(rejections, state);
	}
	const key = `${code}\u0000${path ?? ""}`;
	if (state.keys.has(key)) return;
	if (rejections.length >= MAX_REPORTED_REJECTIONS) {
		if (!state.capped) {
			state.capped = true;
			state.keys.add("REJECTIONS_CAPPED\u0000$");
			rejections.push({
				code: "REJECTIONS_CAPPED",
				reason: "additional evidence rejections were capped",
				path: "$",
			});
		}
		return;
	}
	state.keys.add(key);
	rejections.push(
		path === undefined ? { code, reason } : { code, reason, path },
	);
}

const rejectionStates = new WeakMap<
	ArtifactRejection[],
	{ readonly keys: Set<string>; capped: boolean }
>();

/**
 * Official entrypoint trust contract.
 *
 * The four official child roots are the only Bun programs the comparison
 * supervisor ever launches, and it launches them by pre-opened descriptor.
 * The helpers below are shared by all four roots so the contract has one
 * definition rather than four that can drift apart.
 */
export const OFFICIAL_CHILD_ROOTS = Object.freeze([
	"tools/compare/run-campaign.ts",
	"tools/compare/artifact-builder.ts",
	"tools/compare/verify-artifact.ts",
	"tools/compare/render-report.ts",
] as const);

export const RECOVERY_MODES = Object.freeze([
	"verify-existing",
	"report-existing",
] as const);

export type RecoveryMode = (typeof RECOVERY_MODES)[number];

export interface EntrypointContractFailure {
	readonly ok: false;
	readonly code: string;
	readonly detail?: string;
}

/**
 * A typed CLI failure. The supervisor maps `code` onto a process exit status,
 * and the recorded stdout/stderr plus child accounting prove the rejection
 * happened before any output, child process, or official write.
 */
export class ComparisonCliError extends Error {
	readonly code: string;
	readonly stdout: string;
	readonly stderr: string;
	readonly spawnedChildren: number;
	readonly pgidDrained: boolean;

	constructor(role: string, code: string) {
		super(code);
		this.name = "ComparisonCliError";
		this.code = code;
		this.stdout = "";
		// The frozen contract records the diagnostic with an escaped line
		// terminator, so the recorded value ends in a literal "\n" sequence.
		this.stderr = `[${role}] Error: ${code}\\n`;
		this.spawnedChildren = 0;
		this.pgidDrained = true;
	}
}

/**
 * Rejects any platform the supervisor cannot open official descriptors on.
 * Windows has no reviewed official-I/O path, so it is refused before argument
 * validation and long before any filesystem or network work.
 */
export function assertSupportedPlatform(role: string, platform: string): void {
	if (platform !== "darwin" && platform !== "linux") {
		throw new ComparisonCliError(role, "OUTPUT_PLATFORM_UNSUPPORTED");
	}
}

export function validateOfficialEntrypointContract(input: {
	readonly roots?: readonly string[];
	readonly fixtureOnly?: boolean;
	readonly authority?: unknown;
}): EntrypointContractFailure | { readonly ok: true; readonly rootCount: 4 } {
	const roots = input?.roots;
	if (
		!Array.isArray(roots) ||
		roots.length !== OFFICIAL_CHILD_ROOTS.length ||
		roots.some((root, index) => root !== OFFICIAL_CHILD_ROOTS[index])
	) {
		return { ok: false, code: "ENTRYPOINT_ROOT_SET_MISMATCH" };
	}
	if (input.fixtureOnly !== true && input.authority === undefined) {
		return { ok: false, code: "TRUST_AUTHORITY_ABSENT" };
	}
	return { ok: true, rootCount: 4 };
}

/**
 * Guards the fixture-only package scripts. They are developer conveniences and
 * can never bootstrap official authority, so an official capability, an
 * inherited descriptor, or a path locator is refused before any I/O.
 */
export function validateFixtureOnlyEntrypoint(input: {
	readonly fixtureOnly?: boolean;
	readonly authoritySha256?: string;
	readonly authorityFd?: number;
	readonly rootPath?: string;
}):
	| EntrypointContractFailure
	| { readonly ok: true; readonly fixtureOnly: true } {
	if (input?.fixtureOnly !== true) {
		return { ok: false, code: "TRUST_FIXTURE_ONLY_REQUIRED" };
	}
	if (input.authorityFd !== undefined) {
		return { ok: false, code: "TRUST_OFFICIAL_HANDLE_FORBIDDEN" };
	}
	if (input.authoritySha256 !== undefined) {
		return { ok: false, code: "TRUST_OFFICIAL_CAPABILITY_FORBIDDEN" };
	}
	if (input.rootPath !== undefined) {
		return { ok: false, code: "TRUST_PATH_LOCATOR_FORBIDDEN" };
	}
	return { ok: true, fixtureOnly: true };
}

/**
 * Recovery modes are the deliberate non-fixture path: the operator relaunches
 * the supervisor to verify or report over evidence a prior campaign published.
 */
export function parseRecoveryMode(input: {
	readonly mode?: string;
	readonly fixtureOnly?: boolean;
}):
	| EntrypointContractFailure
	| { readonly ok: true; readonly mode: RecoveryMode } {
	const mode = input?.mode;
	if (
		typeof mode !== "string" ||
		!RECOVERY_MODES.includes(mode as RecoveryMode)
	) {
		return { ok: false, code: "RECOVERY_MODE_UNSUPPORTED" };
	}
	if (input.fixtureOnly === true) {
		return { ok: false, code: "TRUST_FIXTURE_ONLY_RECOVERY_FORBIDDEN" };
	}
	return { ok: true, mode: mode as RecoveryMode };
}

/**
 * The staged-trust argument set shared by the campaign, verifier, and report
 * roots. Each root states the same six inputs, so the validation lives here
 * once and only the surrounding flag syntax differs per root.
 */
export interface StagedTrustArgs {
	readonly candidateId: string;
	readonly campaignId: string;
	readonly stagedCapabilityPath: string;
	readonly capabilityDigestSha256: string;
	readonly lockDigestSha256: string;
	readonly archiveDigestSha256: string;
	readonly fixtureOnly: boolean;
	readonly positionals: readonly string[];
}

export interface StagedTrustDraft {
	candidateId?: string;
	campaignId?: string;
	stagedCapabilityPath?: string;
	capabilityDigestSha256?: string;
	lockDigestSha256?: string;
	archiveDigestSha256?: string;
}

const HEX64_DIGEST = /^[0-9a-f]{64}$/u;

/**
 * Rejects an incomplete or malformed staged-trust argument set. Digests are
 * checked only for shape here; proving they match real bytes is the staged
 * capability loader's job, which reads through an injected reader.
 */
export function validateStagedTrustArgs(
	role: string,
	draft: StagedTrustDraft,
): void {
	for (const [value, code] of [
		[draft.candidateId, "CAMPAIGN_ARG_MISSING_CANDIDATE"],
		[draft.campaignId, "CAMPAIGN_ARG_MISSING_CAMPAIGN"],
		[draft.stagedCapabilityPath, "CAMPAIGN_ARG_MISSING_STAGED_CAPABILITY"],
		[draft.capabilityDigestSha256, "CAMPAIGN_ARG_MISSING_CAPABILITY_DIGEST"],
		[draft.lockDigestSha256, "CAMPAIGN_ARG_MISSING_LOCK_DIGEST"],
		[draft.archiveDigestSha256, "CAMPAIGN_ARG_MISSING_ARCHIVE_DIGEST"],
	] as const) {
		if (!value) throw new ComparisonCliError(role, code);
	}
	for (const [value, code] of [
		[draft.capabilityDigestSha256, "CAMPAIGN_ARG_INVALID_CAPABILITY_DIGEST"],
		[draft.lockDigestSha256, "CAMPAIGN_ARG_INVALID_LOCK_DIGEST"],
		[draft.archiveDigestSha256, "CAMPAIGN_ARG_INVALID_ARCHIVE_DIGEST"],
	] as const) {
		if (!HEX64_DIGEST.test(value!)) {
			throw new ComparisonCliError(role, code);
		}
	}
}

/**
 * Parses the staged-trust flags shared by the verifier and report roots.
 * Parsing is syntax only: a locator is accepted as a string here and is not
 * opened, resolved, or trusted until the capability loader validates it.
 */
export function parseStagedTrustArgv(
	role: string,
	argv: readonly string[],
): StagedTrustArgs {
	const draft: StagedTrustDraft = {};
	const positionals: string[] = [];
	let fixtureOnly = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--fixture-only") {
			fixtureOnly = true;
		} else if (arg === "--platform") {
			assertSupportedPlatform(role, argv[++i] ?? "");
		} else if (arg === "--candidate") {
			draft.candidateId = argv[++i] ?? "";
		} else if (arg === "--campaign-id") {
			draft.campaignId = argv[++i] ?? "";
		} else if (arg === "--staged-capability") {
			draft.stagedCapabilityPath = argv[++i] ?? "";
		} else if (arg === "--capability-digest") {
			draft.capabilityDigestSha256 = argv[++i] ?? "";
		} else if (arg === "--lock-digest") {
			draft.lockDigestSha256 = argv[++i] ?? "";
		} else if (arg === "--archive-digest") {
			draft.archiveDigestSha256 = argv[++i] ?? "";
		} else if (arg.startsWith("--")) {
			throw new ComparisonCliError(role, "CAMPAIGN_ARG_UNKNOWN");
		} else {
			positionals.push(arg);
		}
	}

	if (fixtureOnly) {
		// The fixture-only package scripts cannot carry official authority, and
		// the refusal lands before any filesystem or network work.
		const gate = validateFixtureOnlyEntrypoint({
			fixtureOnly: true,
			authoritySha256: draft.capabilityDigestSha256 ?? draft.lockDigestSha256,
			rootPath: draft.stagedCapabilityPath ?? positionals[0],
		});
		if (!gate.ok) throw new ComparisonCliError(role, gate.code);
		return {
			candidateId: draft.candidateId ?? "fixture-candidate",
			campaignId: draft.campaignId ?? "fixture-campaign",
			stagedCapabilityPath: "",
			capabilityDigestSha256: "",
			lockDigestSha256: "",
			archiveDigestSha256: "",
			fixtureOnly: true,
			positionals,
		};
	}

	validateStagedTrustArgs(role, draft);
	return {
		fixtureOnly: false,
		candidateId: draft.candidateId!,
		campaignId: draft.campaignId!,
		stagedCapabilityPath: draft.stagedCapabilityPath!,
		capabilityDigestSha256: draft.capabilityDigestSha256!,
		lockDigestSha256: draft.lockDigestSha256!,
		archiveDigestSha256: draft.archiveDigestSha256!,
		positionals,
	};
}

export type EvidenceStatusValue = "PASS" | "FAIL" | "BLOCKED";
export type ScenarioVerdictValue = "PASS" | "MISS" | "NO_VERDICT";

export interface VerdictClassification {
	readonly ok: true;
	readonly evidenceStatus: EvidenceStatusValue;
	readonly scenarioVerdict: ScenarioVerdictValue;
	readonly promotable: boolean;
	readonly numericDataVisible: boolean;
}

/**
 * The only self-consistent evidence/verdict pairs, and what each one licenses.
 *
 * A valid MISS keeps its numbers visible — the measurement happened and the
 * target was simply not met — but it is never promotable. Every other pairing
 * is a contradiction: evidence that failed or was blocked cannot yield a
 * scenario verdict, and evidence that passed must yield one.
 */
const VERDICT_MATRIX: readonly {
	readonly evidenceStatus: EvidenceStatusValue;
	readonly scenarioVerdict: ScenarioVerdictValue;
	readonly promotable: boolean;
	readonly numericDataVisible: boolean;
}[] = [
	{
		evidenceStatus: "PASS",
		scenarioVerdict: "PASS",
		promotable: true,
		numericDataVisible: true,
	},
	{
		evidenceStatus: "PASS",
		scenarioVerdict: "MISS",
		promotable: false,
		numericDataVisible: true,
	},
	{
		evidenceStatus: "FAIL",
		scenarioVerdict: "NO_VERDICT",
		promotable: false,
		numericDataVisible: false,
	},
	{
		evidenceStatus: "BLOCKED",
		scenarioVerdict: "NO_VERDICT",
		promotable: false,
		numericDataVisible: false,
	},
];

export function classifyVerdictTuple(input: {
	readonly evidenceStatus?: string;
	readonly scenarioVerdict?: string;
}): VerdictClassification | { readonly ok: false; readonly code: string } {
	const match = VERDICT_MATRIX.find(
		(row) =>
			row.evidenceStatus === input?.evidenceStatus &&
			row.scenarioVerdict === input?.scenarioVerdict,
	);
	if (match === undefined) {
		return { ok: false, code: "VERDICT_TUPLE_CONTRADICTION" };
	}
	return { ok: true, ...match };
}

/** SHA-256 of raw bytes, hex encoded. */
export function sha256HexOfBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}
