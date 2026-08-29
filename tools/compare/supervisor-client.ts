// R1 supervisor-client contracts (Task C): the official publication order,
// the official-I/O allowlist surface, and the runtime I/O spy harness the
// entrypoint RED contract exercises. Pure validation: no OS I/O.
import { createHash } from "node:crypto";

import { isSafeNonNegative, type ValidationFailure } from "./secure-fs.ts";

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export const OFFICIAL_PUBLICATION_ORDER = [
	"authority",
	"campaign-lock",
	"staged-capability",
	"staged-metadata-receipts",
	"manifest",
	"verifier-result",
	"report",
] as const;

export function validateOfficialPublicationOrder(
	input: unknown,
):
	| { ok: true; stepCount: number; reservedOutputCount: number }
	| ValidationFailure {
	if (!isPlainObject(input) || !Array.isArray(input.steps)) {
		return { ok: false, code: "OUTPUT_PUBLICATION_ORDER_INVALID" };
	}
	const steps = input.steps;
	if (new Set(steps).size !== steps.length) {
		return { ok: false, code: "OUTPUT_PUBLICATION_ORDER_DUPLICATE" };
	}
	if (
		steps.length !== OFFICIAL_PUBLICATION_ORDER.length ||
		OFFICIAL_PUBLICATION_ORDER.some((step, index) => steps[index] !== step)
	) {
		return { ok: false, code: "OUTPUT_PUBLICATION_ORDER_INVALID" };
	}
	const reservedOutputs = Array.isArray(input.reservedOutputs)
		? input.reservedOutputs
		: [];
	if (reservedOutputs.length === 0) {
		return { ok: false, code: "OUTPUT_PUBLICATION_ORDER_INVALID" };
	}
	const reserved = new Set(reservedOutputs.map((name) => String(name)));
	const manifestSelectedPaths = Array.isArray(input.manifestSelectedPaths)
		? input.manifestSelectedPaths
		: [];
	for (const path of manifestSelectedPaths) {
		const basename = String(path).split("/").at(-1) ?? "";
		if (reserved.has(basename)) {
			return { ok: false, code: "MANIFEST_RESERVED_OUTPUT_SELECTED" };
		}
	}
	return {
		ok: true,
		stepCount: steps.length,
		reservedOutputCount: reserved.size,
	};
}

const OFFICIAL_CHILD_ROOTS = [
	"tools/compare/run-campaign.ts",
	"tools/compare/artifact-builder.ts",
	"tools/compare/verify-artifact.ts",
	"tools/compare/render-report.ts",
] as const;

function rootsValid(roots: unknown): roots is readonly string[] {
	return (
		Array.isArray(roots) &&
		roots.length === OFFICIAL_CHILD_ROOTS.length &&
		OFFICIAL_CHILD_ROOTS.every((root) => roots.includes(root))
	);
}

export function validateOfficialIoAllowlist(
	input: unknown,
): { ok: true; rootCount: number } | ValidationFailure {
	if (!isPlainObject(input) || !rootsValid(input.roots)) {
		return { ok: false, code: "OUTPUT_OFFICIAL_IO_BYPASS" };
	}
	const forbiddenSurfaces = input.forbiddenSurfaces;
	if (!Array.isArray(forbiddenSurfaces) || forbiddenSurfaces.length === 0) {
		return { ok: false, code: "OUTPUT_OFFICIAL_IO_BYPASS" };
	}
	if (input.fixtureOnly !== true) {
		return { ok: false, code: "TRUST_FIXTURE_ONLY_REQUIRED" };
	}
	return { ok: true, rootCount: input.roots.length };
}

const IO_SPY_BYPASS_CODES: Record<string, string> = {
	"node:fs": "OUTPUT_OFFICIAL_IO_BYPASS",
	"node:fs/promises": "OUTPUT_OFFICIAL_IO_BYPASS",
	"node:path": "OUTPUT_OFFICIAL_IO_BYPASS",
	"node:child_process": "OUTPUT_OFFICIAL_IO_BYPASS",
	"node:module": "OUTPUT_OFFICIAL_IO_BYPASS",
	"Bun.file": "OUTPUT_OFFICIAL_IO_BYPASS",
	"Bun.write": "OUTPUT_OFFICIAL_IO_BYPASS",
	"Bun.spawn": "OUTPUT_OFFICIAL_IO_BYPASS",
	readOfficialComparisonFile: "OUTPUT_OFFICIAL_IO_BYPASS",
	writeOfficialComparisonFile: "OUTPUT_OFFICIAL_IO_BYPASS",
	readdirSync: "OUTPUT_DIRECTORY_ENUMERATION_FORBIDDEN",
	glob: "OUTPUT_DIRECTORY_ENUMERATION_FORBIDDEN",
	measureCellArm: "OUTPUT_SYNTHETIC_EXECUTOR_FORBIDDEN",
	"pathname-addon-fallback": "OUTPUT_ADDON_FALLBACK_FORBIDDEN",
	"dynamic-import": "OUTPUT_DYNAMIC_IMPORT_FORBIDDEN",
};

export function runOfficialEntrypointIoSpies(
	input: unknown,
):
	| { ok: true; filesystemCalls: number; networkCalls: number }
	| ValidationFailure {
	if (!isPlainObject(input) || !rootsValid(input.roots)) {
		return { ok: false, code: "OUTPUT_OFFICIAL_IO_BYPASS" };
	}
	if (input.fixtureOnly !== true) {
		return { ok: false, code: "TRUST_FIXTURE_ONLY_REQUIRED" };
	}
	const injected = input.injectedBypass;
	if (injected !== undefined) {
		const code =
			typeof injected === "string" ? IO_SPY_BYPASS_CODES[injected] : undefined;
		return { ok: false, code: code ?? "OUTPUT_OFFICIAL_IO_BYPASS" };
	}
	return { ok: true, filesystemCalls: 0, networkCalls: 0 };
}

// ---------------------------------------------------------------------------
// Typed child-side frame definitions and the bounded frame codec.
// Wire layout mirrors the Rust `secure_fs::supervisor::frame` module:
//   4-byte BE canonical-header length (max 64 KiB)
//   canonical SupervisorFrameV1 JSON header
//   8-byte BE payload length (bounded by frame kind)
//   payload bytes
//   32-byte SHA-256 of the exact payload bytes
// ---------------------------------------------------------------------------

export interface ComparisonSupervisorInputV1 {
	readonly schema: "comparison-supervisor-input/v1";
	readonly candidate: string;
	readonly campaignId: string;
	readonly authoritySha256: string;
	readonly lockSha256: string;
	readonly capabilitySha256: string;
	readonly manifestSha256: string;
	readonly roleTupleOracleSha256: string;
	readonly roleReceiptSetSha256: string;
	readonly physicalObservationSha256: string;
	/**
	 * The per-host toolchain observation this supervisor is expected to
	 * produce. The supervisor reads its own Bun binary and writes a record
	 * whose sha256 is this value; if the supervisor's read disagrees, the
	 * supervisor fails closed.
	 */
	readonly toolchainSha256: string;
	readonly expectedProcessCount: number;
	readonly expectedDescriptorCount: number;
	readonly hostIds: readonly string[];
	readonly measurement: Record<string, unknown>;
	readonly operation: string;
}

export interface ComparisonSupervisorOutputV1 {
	readonly schema: "comparison-supervisor-output/v1";
	readonly candidate: string;
	readonly campaignId: string;
	readonly authoritySha256: string;
	readonly lockSha256: string;
	readonly capabilitySha256: string;
	readonly manifestSha256: string;
	readonly verifierResultSha256: string;
	readonly reportSha256: string;
	readonly physicalObservationSha256: string;
	/**
	 * The per-host supervisor-measured toolchain observation this
	 * supervisor emitted, hashed to its canonical bytes. Each supervisor
	 * reports its own host's toolchain; the controller assembles the
	 * two-host set on the admission-receipt channel.
	 */
	readonly toolchainSha256: string;
	readonly roleReceiptSetSha256: string;
	readonly status: string;
	readonly comparisonRowCount: number;
	readonly promotable: boolean;
	readonly publicationOrder: readonly string[];
	readonly operation: string;
}

export interface ComparisonSupervisorErrorV1 {
	readonly schema: "comparison-supervisor-error/v1";
	readonly code: string;
	readonly operation: string;
	readonly osCode: number | null;
}

export const MAX_FRAME_HEADER_BYTES = 65_536;
export const MAX_FRAME_CHUNK_BYTES = 1_048_576;
export const MAX_SESSION_FRAMES = 4_096;

export type FrameErrorCode =
	| "FRAME_HEADER_TOO_LARGE"
	| "FRAME_HEADER_EMPTY"
	| "FRAME_PAYLOAD_TOO_LARGE"
	| "FRAME_DIGEST_MISMATCH"
	| "FRAME_TRUNCATED"
	| "FRAME_TRAILING_BYTES"
	| "FRAME_SESSION_LIMIT"
	| "FRAME_PAYLOAD_BOUND_INVALID";

export interface DecodedSupervisorFrame {
	readonly header: Uint8Array;
	readonly payload: Uint8Array;
}

type FrameResult<T> =
	| { ok: true; value: T }
	| { ok: false; code: FrameErrorCode };

/**
 * Charges the per-session frame budget the amendment fixes at 4,096 frames.
 * The constant was exported but nothing enforced it, so a session could run
 * unbounded; this mirrors the Rust `SessionFrameBudget`.
 */
export class SupervisorSessionFrameBudget {
	#used = 0;

	get used(): number {
		return this.#used;
	}

	charge(): { ok: true; used: number } | { ok: false; code: FrameErrorCode } {
		const next = this.#used + 1;
		if (next > MAX_SESSION_FRAMES) {
			return { ok: false, code: "FRAME_SESSION_LIMIT" };
		}
		this.#used = next;
		return { ok: true, used: next };
	}
}

function frameSha256(payload: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(payload).digest());
}

export function encodeSupervisorFrame(
	header: Uint8Array,
	payload: Uint8Array,
	payloadBound: number,
): FrameResult<Uint8Array> {
	if (!isSafeNonNegative(payloadBound)) {
		return { ok: false, code: "FRAME_PAYLOAD_BOUND_INVALID" };
	}
	if (header.byteLength === 0) {
		return { ok: false, code: "FRAME_HEADER_EMPTY" };
	}
	if (header.byteLength > MAX_FRAME_HEADER_BYTES) {
		return { ok: false, code: "FRAME_HEADER_TOO_LARGE" };
	}
	if (payload.byteLength > payloadBound) {
		return { ok: false, code: "FRAME_PAYLOAD_TOO_LARGE" };
	}
	const out = new Uint8Array(
		4 + header.byteLength + 8 + payload.byteLength + 32,
	);
	const view = new DataView(out.buffer);
	view.setUint32(0, header.byteLength, false);
	out.set(header, 4);
	let offset = 4 + header.byteLength;
	view.setBigUint64(offset, BigInt(payload.byteLength), false);
	offset += 8;
	out.set(payload, offset);
	offset += payload.byteLength;
	out.set(frameSha256(payload), offset);
	return { ok: true, value: out };
}

export function decodeSupervisorFrame(
	input: Uint8Array,
	payloadBound: number,
): FrameResult<{ frame: DecodedSupervisorFrame; consumed: number }> {
	// `BigInt(payloadBound)` throws on a non-integer or non-finite bound.
	// A codec that reports every other malformed input as a typed code must
	// not turn one caller mistake into an exception.
	if (!isSafeNonNegative(payloadBound)) {
		return { ok: false, code: "FRAME_PAYLOAD_BOUND_INVALID" };
	}
	if (input.byteLength < 4) return { ok: false, code: "FRAME_TRUNCATED" };
	const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
	const headerLength = view.getUint32(0, false);
	if (headerLength === 0) return { ok: false, code: "FRAME_HEADER_EMPTY" };
	if (headerLength > MAX_FRAME_HEADER_BYTES) {
		return { ok: false, code: "FRAME_HEADER_TOO_LARGE" };
	}
	let offset = 4;
	if (input.byteLength < offset + headerLength + 8) {
		return { ok: false, code: "FRAME_TRUNCATED" };
	}
	const header = input.slice(offset, offset + headerLength);
	offset += headerLength;
	const payloadLength = view.getBigUint64(offset, false);
	offset += 8;
	if (payloadLength > BigInt(payloadBound)) {
		return { ok: false, code: "FRAME_PAYLOAD_TOO_LARGE" };
	}
	const payloadBytes = Number(payloadLength);
	if (input.byteLength < offset + payloadBytes + 32) {
		return { ok: false, code: "FRAME_TRUNCATED" };
	}
	const payload = input.slice(offset, offset + payloadBytes);
	offset += payloadBytes;
	const digest = input.slice(offset, offset + 32);
	offset += 32;
	const expected = frameSha256(payload);
	for (let index = 0; index < 32; index += 1) {
		if (digest[index] !== expected[index]) {
			return { ok: false, code: "FRAME_DIGEST_MISMATCH" };
		}
	}
	return { ok: true, value: { frame: { header, payload }, consumed: offset } };
}

export function decodeSingleSupervisorFrame(
	input: Uint8Array,
	payloadBound: number,
): FrameResult<DecodedSupervisorFrame> {
	const decoded = decodeSupervisorFrame(input, payloadBound);
	if (!decoded.ok) return decoded;
	if (decoded.value.consumed !== input.byteLength) {
		return { ok: false, code: "FRAME_TRAILING_BYTES" };
	}
	return { ok: true, value: decoded.value.frame };
}

// ---------------------------------------------------------------------------
// The measurement grant
//
// The record itself lives in `evidence.ts` and is re-exported here, which is a
// placement forced by architecture rather than taste. The grant has to be
// readable by the campaign and the artifact builder, and those are official
// roots: an import edge from a root into this module drags this module's whole
// subtree -- `secure-fs.ts`, `supervisor-protocol.ts` and through it
// `topology.ts` -- into the official-root reachability set, which
// `check-official-io` refuses and is right to. `evidence.ts` is already inside
// that set, so the record is defined there and named here.
//
// The binding copy of the *rules* is `secure_fs::measurement` in the Rust
// supervisor, because that is the one process the thing being measured cannot
// call. What either TypeScript copy can ask is narrower: which execution a
// grant names, and whether this process has already spent it. Only the
// supervisor holds the set of grants it issued.
// ---------------------------------------------------------------------------

export type {
	MeasurementExecutionKey,
	MeasurementGrantV1,
	SupervisorAdmissionReceiptV1,
} from "./evidence.ts";
export {
	MEASUREMENT_ADMISSION_SCHEMA,
	MEASUREMENT_GRANT_SCHEMA,
	MEASUREMENT_UNADMITTED,
	measurementGrantBytes,
	measurementGrantExecution,
	measurementGrantSha256,
	parseMeasurementGrant,
	parseSupervisorAdmissionReceipt,
	sameMeasurementExecution,
	sha256HexOfBytes,
	validateMeasurementGrantBinding,
	validateSupervisorAdmission,
} from "./evidence.ts";
export {
	OBSERVED_TOOLCHAIN_SET_SCHEMA,
	OBSERVED_CAPABILITY_SET_SCHEMA,
	OBSERVED_LOCK_SET_SCHEMA,
	OBSERVED_MANIFEST_SET_SCHEMA,
	type ObservedToolchainSetV1,
	type ObservedCapabilitySetV1,
	type ObservedLockSetV1,
	type ObservedManifestSetV1,
	observedToolchainSetBytes,
	observedToolchainSetSha256,
	observedCapabilitySetBytes,
	observedCapabilitySetSha256,
	observedLockSetBytes,
	observedLockSetSha256,
	observedManifestSetBytes,
	observedManifestSetSha256,
	validateObservedToolchainSetV1,
	validateObservedCapabilitySetV1,
	validateObservedLockSetV1,
	validateObservedManifestSetV1,
} from "./supervisor-protocol.ts";
