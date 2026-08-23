import { createHash } from "node:crypto";

import { canonicalJson, sha256Canonical } from "./canonical.ts";

export const EVIDENCE_SCHEMA_VERSION = "v1" as const;
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
export const MAX_ARTIFACT_STRING_LENGTH = 4096;
export const MAX_ARTIFACT_KEYS = 256;
export const MAX_ARTIFACT_DEPTH = 32;
export const MAX_ARTIFACT_SAMPLES = 100_000;
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
export type MetricUnit =
	| "ms"
	| "bytes"
	| "Mbps"
	| "count"
	| "ratio"
	| "percent";

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
	samples: number[];
	percentiles: {
		p50: number;
		p95: number;
		p99: number;
	};
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
	comparisonId: string;
	runId: string;
	transport: Transport;
	armKind: "primary";
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
	rawSidecarDigests: RawSidecarDigests;
	rawSidecarBindingSha256: string;
}

export interface ArtifactVerification {
	evidenceStatus: EvidenceStatus;
	readonly rejections: readonly ArtifactRejection[];
	readonly artifact?: RunArtifact;
	readonly artifactByteSha256?: string;
}

export type ArtifactBytes = ArrayBufferView | ArrayBuffer | string;

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

/**
 * Snapshot an untrusted object exactly once per own property.  Verification
 * never keeps a reference to a caller-owned object, so getters and prototype
 * mutation cannot create a time-of-check/time-of-use gap.
 */
export function snapshotEvidenceValue(
	value: unknown,
	path = "$",
	depth = 0,
): unknown {
	if (depth > MAX_ARTIFACT_DEPTH)
		invalid(`${path} exceeds maximum nesting depth`);
	if (value === null) return null;
	if (typeof value === "string") {
		if (value.length > MAX_ARTIFACT_STRING_LENGTH)
			invalid(`${path} string is too long`);
		return value;
	}
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) invalid(`${path} must be finite`);
		return value;
	}
	if (typeof value !== "object") invalid(`${path} has unsupported type`);

	if (Array.isArray(value)) {
		const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
			string,
			PropertyDescriptor
		>;
		const lengthDescriptor = descriptors.length;
		if (!lengthDescriptor) invalid(`${path} array length must be own`);
		const rawLength = ownDescriptorValue(value, lengthDescriptor);
		if (
			typeof rawLength !== "number" ||
			!Number.isSafeInteger(rawLength) ||
			rawLength < 0 ||
			rawLength > MAX_ARTIFACT_SAMPLES
		) {
			invalid(`${path} array length is invalid`);
		}
		const length = rawLength as number;
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
			) {
				invalid(`${path} has an invalid array index`);
			}
		}
		const output: unknown[] = [];
		for (let index = 0; index < length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (!descriptor) invalid(`${path} is sparse at index ${index}`);
			output.push(
				snapshotEvidenceValue(
					ownDescriptorValue(value, descriptor),
					`${path}[${index}]`,
					depth + 1,
				),
			);
		}
		return output;
	}

	if (!isPlainObject(value)) invalid(`${path} must be a plain object`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(descriptors);
	if (keys.length > MAX_ARTIFACT_KEYS) invalid(`${path} has too many fields`);
	const output: Record<string, unknown> = Object.create(null) as Record<
		string,
		unknown
	>;
	for (const key of keys) {
		if (typeof key !== "string") invalid(`${path} has a symbol field`);
		const descriptor = descriptors[key];
		if (!descriptor) invalid(`${path}.${key} descriptor is missing`);
		const propertyValue = ownDescriptorValue(value, descriptor);
		// JSON has no undefined value.  Treat an explicitly undefined field as
		// absent so the schema layer can emit the stable missing-own-field code.
		if (propertyValue === undefined) continue;
		output[key] = snapshotEvidenceValue(
			propertyValue,
			`${path}.${key}`,
			depth + 1,
		);
	}
	return output;
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
					if (text[after] === '"' && located === undefined) {
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
								const value: unknown = JSON.parse(
									text.slice(after, valueIndex + 1),
								);
								if (typeof value === "string")
									located = { start: valueStart, end: valueIndex, value };
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

export function isBase64(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= MAX_ARTIFACT_STRING_LENGTH &&
		BASE64.test(value)
	);
}

export function addRejection(
	rejections: ArtifactRejection[],
	code: ArtifactRejectionCode,
	reason: string,
	path?: string,
): void {
	if (
		rejections.some(
			(rejection) => rejection.code === code && rejection.path === path,
		)
	)
		return;
	rejections.push(
		path === undefined ? { code, reason } : { code, reason, path },
	);
}
