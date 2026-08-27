// R1 secure filesystem trust-model validation (Task C).
//
// This module is schema/limit validation only: it owns strict canonical
// parsing for the authority-bearing records (campaign-authority/v1,
// source-archive-receipt/v1, r1-red-approval-bundle/v1,
// campaign-reservation/v1, host-runtime-facts/v1, host-launch-provenance/v1,
// staged-capability/v1, bun-role-launch-receipt-set/v1) plus the pure
// secure-filesystem policy oracles the RED contract exercises. It performs no
// OS I/O and never imports the package addon; byte inputs arrive as
// caller-supplied Uint8Array values.
import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical.ts";

export type ValidationFailure = { readonly ok: false; readonly code: string };

export function canonicalRecordBytes(value: unknown): Uint8Array {
	return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

export function sha256HexOfBytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function isHex64(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isHex40(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/**
 * A digest whose 64 hex characters are all identical is never a plausible
 * SHA-256 of real bytes; the frozen contract uses such constant-character
 * strings ("0"*64, "4"*64, "f"*64, ...) as drifted or sentinel digests that
 * strict validation must reject even when no recomputable source exists.
 */
export function isImplausibleDigest(value: unknown): boolean {
	if (!isHex64(value)) return true;
	return /^([0-9a-f])\1{63}$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * Own-property presence. `key in record` walks the prototype chain, so a
 * required field named `constructor` or `toString` would read as present on
 * a record that never declared it.
 */
export function hasOwn(record: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

export function fieldSetIssue(
	record: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): "unknown" | "missing" | null {
	const allowed = new Set([...required, ...optional]);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) return "unknown";
	}
	for (const key of required) {
		if (!hasOwn(record, key)) return "missing";
	}
	return null;
}

/**
 * Finite, safe-integer guard for every number crossing the JSON boundary.
 * `typeof x === "number"` admits `Infinity` (which `1e999` parses to) and
 * `NaN`; an `Infinity` deadline never expires and a `NaN` count compares
 * false against every bound.
 */
export function isSafeCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

/** As `isSafeCount`, but for a non-negative count. */
export function isSafeNonNegative(value: unknown): value is number {
	return isSafeCount(value) && value >= 0;
}

/**
 * Scan raw JSON text for duplicate object keys. JSON.parse silently keeps the
 * last duplicate, so strict record parsing must lex the bytes itself.
 * Returns null when no duplicate exists or when the text is not parseable
 * JSON (the caller classifies unparseable bytes separately).
 */
export function findDuplicateJsonKey(text: string): string | null {
	const scopes: Array<Set<string> | null> = [];
	let index = 0;

	const SHORT_ESCAPES: Record<string, string> = {
		'"': '"',
		"\\": "\\",
		"/": "/",
		b: "\b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
	};

	const readHex4 = (at: number): number | null => {
		const digits = text.slice(at, at + 4);
		if (!/^[0-9a-fA-F]{4}$/.test(digits)) return null;
		return Number.parseInt(digits, 16);
	};

	/**
	 * Decodes the string literal whose opening quote is at `index`, leaving
	 * `index` just past the closing quote.
	 *
	 * Escapes must be decoded, never copied through: a lexer that keeps
	 * `c` as the characters `u0063` reads
	 * `{"candidate":"benign","candidate":"evil"}` as two distinct keys
	 * and reports no duplicate, while `JSON.parse` folds them into one key
	 * holding the last value. Every binding field would become smuggleable
	 * behind a benign first value that a byte audit would read.
	 */
	const readString = (): string | null => {
		let out = "";
		index += 1;
		while (index < text.length) {
			const ch = text[index]!;
			if (ch === '"') {
				index += 1;
				return out;
			}
			if (ch !== "\\") {
				out += ch;
				index += 1;
				continue;
			}
			const escape = text[index + 1];
			if (escape === undefined) return null;
			index += 2;
			if (escape === "u") {
				const first = readHex4(index);
				if (first === null) return null;
				index += 4;
				if (first >= 0xd800 && first < 0xdc00) {
					// A leading surrogate only decodes with its trailing pair,
					// exactly as JSON.parse folds it.
					if (text[index] !== "\\" || text[index + 1] !== "u") return null;
					const second = readHex4(index + 2);
					if (second === null || second < 0xdc00 || second >= 0xe000) {
						return null;
					}
					index += 6;
					out += String.fromCodePoint(
						0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00),
					);
					continue;
				}
				out += String.fromCharCode(first);
				continue;
			}
			const decoded = SHORT_ESCAPES[escape];
			if (decoded === undefined) return null;
			out += decoded;
		}
		return null;
	};

	while (index < text.length) {
		const ch = text[index]!;
		if (ch === "{") {
			scopes.push(new Set());
			index += 1;
			continue;
		}
		if (ch === "[") {
			scopes.push(null);
			index += 1;
			continue;
		}
		if (ch === "}" || ch === "]") {
			scopes.pop();
			index += 1;
			continue;
		}
		if (ch === '"') {
			const value = readString();
			if (value === null) return null;
			let lookahead = index;
			while (lookahead < text.length && /\s/.test(text[lookahead]!)) {
				lookahead += 1;
			}
			const scope = scopes[scopes.length - 1];
			if (scope && text[lookahead] === ":") {
				if (scope.has(value)) return value;
				scope.add(value);
			}
			continue;
		}
		index += 1;
	}
	return null;
}

export type StrictJsonResult =
	| { readonly ok: true; readonly value: unknown }
	| {
			readonly ok: false;
			readonly reason: "invalid" | "duplicate";
			readonly key?: string;
	  };

export function parseStrictJsonBytes(bytes: Uint8Array): StrictJsonResult {
	const text = new TextDecoder().decode(bytes);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return { ok: false, reason: "invalid" };
	}
	const duplicate = findDuplicateJsonKey(text);
	if (duplicate !== null) {
		return { ok: false, reason: "duplicate", key: duplicate };
	}
	return { ok: true, value };
}

/**
 * Distinguish structurally invalid JSON (truncated or malformed text) from
 * byte-level corruption of otherwise canonical bytes: corruption introduces
 * non-printable control bytes, which canonical JSON never contains outside
 * the single trailing newline.
 */
export function looksByteCorrupted(bytes: Uint8Array): boolean {
	const limit = bytes.byteLength;
	for (let index = 0; index < limit; index += 1) {
		const byte = bytes[index]!;
		if (byte < 0x20 && byte !== 0x0a) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Secure filesystem policy oracles
// ---------------------------------------------------------------------------

const SECURE_FS_REJECTION_CODES: Record<string, string> = {
	"symlink-component": "OUTPUT_PATH_REPARSE",
	"magic-link-component": "OUTPUT_PATH_REPARSE",
	"cross-device-component": "OUTPUT_PATH_CROSS_DEVICE",
	"fifo-leaf": "OUTPUT_FILE_INVALID",
	"socket-leaf": "OUTPUT_FILE_INVALID",
	"device-leaf": "OUTPUT_PATH_DEVICE",
	"alias-path": "OUTPUT_PATH_ALIAS",
	"group-writable-root": "OUTPUT_FILE_INVALID",
	"world-writable-root": "OUTPUT_FILE_INVALID",
	"closed-root-handle": "OUTPUT_HANDLE_CLOSED",
};

// Low inode numbers are reserved by the filesystem itself; an inherited
// campaign/staging directory can never legitimately present one, so a pinned
// identity carrying such an inode is drift, not a real directory.
const MIN_PLAUSIBLE_DIRECTORY_INODE = 16n;

function directoryIdentityValid(identity: unknown): boolean {
	if (!isPlainObject(identity)) return false;
	const platform = identity.platform;
	if (platform !== "darwin" && platform !== "linux") return false;
	if (identity.mode !== 0o700) return false;
	if (identity.hardLinkCount !== "1") return false;
	if (typeof identity.ownerUid !== "number" || identity.ownerUid <= 0) {
		return false;
	}
	// Ownership is a pair. Pinning the uid alone leaves the group half
	// unchecked, and the group half is the one a shared-group root moves.
	if (typeof identity.ownerGid !== "number" || identity.ownerGid <= 0) {
		return false;
	}
	if (typeof identity.inode !== "string" || !/^\d+$/.test(identity.inode)) {
		return false;
	}
	if (BigInt(identity.inode) < MIN_PLAUSIBLE_DIRECTORY_INODE) return false;
	if (platform === "darwin") {
		return (
			typeof identity.device === "string" &&
			typeof identity.fsidWord0 === "string" &&
			typeof identity.fsidWord1 === "string" &&
			typeof identity.fileSystemType === "string" &&
			isHex64(identity.mountTableEntrySha256) &&
			isHex64(identity.canonicalDescriptorPathSha256)
		);
	}
	return (
		typeof identity.deviceMajor === "string" &&
		typeof identity.deviceMinor === "string" &&
		typeof identity.mountId === "string" &&
		typeof identity.fileSystemType === "string" &&
		typeof identity.fileSystemTypeMagic === "string" &&
		typeof identity.fsidWord0 === "string" &&
		typeof identity.fsidWord1 === "string"
	);
}

export function validateSecureFsPolicy(input: unknown):
	| {
			ok: true;
			platform: string;
			handleRelative: true;
			enumeration: false;
	  }
	| ValidationFailure {
	if (!isPlainObject(input)) return { ok: false, code: "OUTPUT_FILE_INVALID" };
	const adversarial = input.adversarialComponent;
	if (typeof adversarial === "string") {
		const code = SECURE_FS_REJECTION_CODES[adversarial];
		return { ok: false, code: code ?? "OUTPUT_FILE_INVALID" };
	}
	const platform = input.platform;
	if (platform !== "darwin" && platform !== "linux") {
		return { ok: false, code: "OUTPUT_PLATFORM_UNSUPPORTED" };
	}
	if (
		input.followLinks !== false ||
		input.allowEnumeration !== false ||
		input.allowReplacement !== false
	) {
		return { ok: false, code: "OUTPUT_FILE_INVALID" };
	}
	const declaredFiles = input.declaredFiles;
	if (!Array.isArray(declaredFiles) || declaredFiles.length === 0) {
		return { ok: false, code: "OUTPUT_FILE_INVALID" };
	}
	for (const name of declaredFiles) {
		if (
			typeof name !== "string" ||
			name.length === 0 ||
			name.includes("/") ||
			name.includes("\\") ||
			name === "." ||
			name === ".."
		) {
			return { ok: false, code: "OUTPUT_FILE_INVALID" };
		}
	}
	const root = input.root;
	const staging = input.staging;
	if (!isPlainObject(root) || !isPlainObject(staging)) {
		return { ok: false, code: "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH" };
	}
	// Checked ahead of the private-mode test so the two stay distinguishable:
	// "someone else can write here" and "this is not exactly 0700" are
	// different facts and a report that conflates them cannot be acted on.
	for (const holder of [root, staging]) {
		const mode = (holder.identity as Record<string, unknown> | undefined)?.mode;
		if (typeof mode === "number" && (mode & 0o022) !== 0) {
			return { ok: false, code: "OUTPUT_PATH_SHARED_WRITABLE" };
		}
	}
	if (
		!directoryIdentityValid(root.identity) ||
		!directoryIdentityValid(staging.identity)
	) {
		return { ok: false, code: "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH" };
	}
	if (
		(root.identity as Record<string, unknown>).platform !== platform ||
		(staging.identity as Record<string, unknown>).platform !== platform
	) {
		return { ok: false, code: "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH" };
	}
	return { ok: true, platform, handleRelative: true, enumeration: false };
}

export function readAndHashBounded(
	input: unknown,
): { ok: true; size: number; sha256: string } | ValidationFailure {
	if (!isPlainObject(input)) return { ok: false, code: "OUTPUT_READ_FAILED" };
	const bytes = input.bytes;
	const maxBytes = input.maxBytes;
	if (!(bytes instanceof Uint8Array) || typeof maxBytes !== "number") {
		return { ok: false, code: "OUTPUT_READ_FAILED" };
	}
	if (maxBytes <= 0) return { ok: false, code: "OUTPUT_READ_FAILED" };
	if (bytes.byteLength > maxBytes) {
		return { ok: false, code: "OUTPUT_FILE_TOO_LARGE" };
	}
	return {
		ok: true,
		size: bytes.byteLength,
		sha256: sha256HexOfBytes(bytes),
	};
}

export function streamHashBounded(
	input: unknown,
): { ok: true; size: number; sha256: string } | ValidationFailure {
	if (!isPlainObject(input)) return { ok: false, code: "OUTPUT_READ_FAILED" };
	const chunks = input.chunks;
	const maxBytes = input.maxBytes;
	if (!Array.isArray(chunks) || typeof maxBytes !== "number" || maxBytes <= 0) {
		return { ok: false, code: "OUTPUT_READ_FAILED" };
	}
	const hash = createHash("sha256");
	let size = 0;
	for (const chunk of chunks) {
		if (!(chunk instanceof Uint8Array)) {
			return { ok: false, code: "OUTPUT_READ_FAILED" };
		}
		size += chunk.byteLength;
		if (size > maxBytes) {
			return { ok: false, code: "OUTPUT_FILE_TOO_LARGE" };
		}
		hash.update(chunk);
	}
	return { ok: true, size, sha256: hash.digest("hex") };
}

const SECURE_FS_SCRIPT_OPERATIONS = [
	"open-root",
	"stat-root-identity",
	"open-declared-leaf",
	"read-bounded",
	"hash-exact-bytes",
	"create-new",
	"sync-file",
	"sync-parent",
	"cleanup-token",
] as const;

const SECURE_FS_INJECTED_FAILURES: Record<string, string> = {
	"short-read": "OUTPUT_READ_FAILED",
	EINTR: "OUTPUT_READ_FAILED",
	ENOSPC: "OUTPUT_WRITE_FAILED",
	"file-sync-failure": "OUTPUT_SYNC_FAILED",
	"parent-sync-failure": "OUTPUT_SYNC_FAILED",
	"unexpected-syscall": "OUTPUT_SYSCALL_SCRIPT_MISMATCH",
};

export function runSecureFsSyscallScript(
	input: unknown,
): { ok: true; operationCount: number } | ValidationFailure {
	if (!isPlainObject(input)) {
		return { ok: false, code: "OUTPUT_SYSCALL_SCRIPT_MISMATCH" };
	}
	if (!directoryIdentityValid(input.rootIdentity)) {
		return { ok: false, code: "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH" };
	}
	const operations = input.operations;
	if (
		!Array.isArray(operations) ||
		operations.length !== SECURE_FS_SCRIPT_OPERATIONS.length
	) {
		return { ok: false, code: "OUTPUT_SYSCALL_SCRIPT_MISMATCH" };
	}
	for (const [index, operation] of operations.entries()) {
		if (
			!Array.isArray(operation) ||
			operation[0] !== SECURE_FS_SCRIPT_OPERATIONS[index]
		) {
			return { ok: false, code: "OUTPUT_SYSCALL_SCRIPT_MISMATCH" };
		}
	}
	const injected = input.injectedFailure;
	if (typeof injected === "string") {
		const code = SECURE_FS_INJECTED_FAILURES[injected];
		return { ok: false, code: code ?? "OUTPUT_SYSCALL_SCRIPT_MISMATCH" };
	}
	return { ok: true, operationCount: operations.length };
}

export function cleanupCreatedFileToken(
	input: unknown,
): { ok: true; tokenConsumed: true } | ValidationFailure {
	if (!isPlainObject(input)) {
		return { ok: false, code: "OUTPUT_CLEANUP_FAILED" };
	}
	if (typeof input.token !== "string" || input.token.length === 0) {
		return { ok: false, code: "OUTPUT_CLEANUP_FAILED" };
	}
	if (!directoryIdentityValid(input.rootIdentity)) {
		return { ok: false, code: "OUTPUT_FILESYSTEM_IDENTITY_MISMATCH" };
	}
	return { ok: true, tokenConsumed: true };
}

const SECURE_FS_RACE_CODES: Record<string, string> = {
	"intermediate-ancestor-swap": "OUTPUT_PATH_REPARSE",
	"leaf-ancestor-swap": "OUTPUT_PATH_REPARSE",
	"rename-after-open": "OUTPUT_PATH_ALIAS",
	"single-use-recovery": "OUTPUT_CLEANUP_FAILED",
};

export function recoverSecureFsRace(input: unknown): ValidationFailure {
	if (!isPlainObject(input)) {
		return { ok: false, code: "OUTPUT_CLEANUP_FAILED" };
	}
	if (input.alreadyConsumed === true) {
		return { ok: false, code: "OUTPUT_CLEANUP_FAILED" };
	}
	const race = input.race;
	const code =
		typeof race === "string" ? SECURE_FS_RACE_CODES[race] : undefined;
	return { ok: false, code: code ?? "OUTPUT_CLEANUP_FAILED" };
}

export function comparisonSupervisorWindowsStub(_input: unknown): {
	code: "OUTPUT_PLATFORM_UNSUPPORTED";
	stdout: "";
	ioEvents: readonly never[];
	spawnedChildren: 0;
} {
	// The Windows stub rejects before any argument, environment, descriptor,
	// loader, spawn, or artifact access: the input is deliberately ignored.
	return {
		code: "OUTPUT_PLATFORM_UNSUPPORTED",
		stdout: "",
		ioEvents: [],
		spawnedChildren: 0,
	};
}

// ---------------------------------------------------------------------------
// campaign-authority/v1
// ---------------------------------------------------------------------------

const AUTHORITY_FIELDS = [
	"schema",
	"candidate",
	"campaignId",
	"issuedAt",
	"notAfter",
	"campaignReservationSha256",
	"approval",
	"source",
	"topology",
	"roots",
] as const;

const AUTHORITY_APPROVAL_FIELDS = [
	"parentPlanSha256",
	"parentDesignSha256",
	"amendmentSha256",
	"finalCandidateHead",
	"sourceArchiveReceiptSha256",
	"r1RedApprovalBundleSha256",
	"finalArchitectApprovalSha256",
	"finalCriticApprovalSha256",
	"finalVerifierApprovalSha256",
] as const;

const AUTHORITY_ROOT_KINDS = [
	"mac-campaign",
	"mac-staging",
	"linux-staging",
	"mac-exec-parent",
] as const;

interface AuthorityShape {
	readonly candidate: string;
	readonly approval: Record<string, unknown>;
	readonly roots: readonly Record<string, unknown>[];
}

function authoritySchemaFailure(authority: unknown): ValidationFailure | null {
	if (!isPlainObject(authority)) {
		return { ok: false, code: "TRUST_AUTHORITY_UNKNOWN_FIELD" };
	}
	const issue = fieldSetIssue(authority, AUTHORITY_FIELDS);
	if (issue === "unknown") {
		return { ok: false, code: "TRUST_AUTHORITY_UNKNOWN_FIELD" };
	}
	if (issue === "missing") {
		return { ok: false, code: "TRUST_AUTHORITY_MISSING_FIELD" };
	}
	if (authority.schema !== "campaign-authority/v1") {
		return { ok: false, code: "TRUST_AUTHORITY_SCHEMA_INVALID" };
	}
	const approval = authority.approval;
	if (
		!isPlainObject(approval) ||
		fieldSetIssue(approval, AUTHORITY_APPROVAL_FIELDS) !== null
	) {
		return { ok: false, code: "TRUST_AUTHORITY_UNKNOWN_FIELD" };
	}
	return null;
}

/**
 * Verifies the authority bytes the expected digest covers and returns the
 * value parsed from exactly those bytes.
 *
 * The digest binds bytes, so the record the caller hands us alongside them
 * has to be proven identical to what the digest covers — otherwise the
 * digest attests to one value while every downstream check reads another,
 * and the whole authority chain is severable. `authorityBindsBytes` below
 * is that proof, applied before any success is returned.
 */
function authorityFromBytes(
	input: Record<string, unknown>,
):
	| { ok: true; authority: AuthorityShape & Record<string, unknown> }
	| ValidationFailure {
	const bytes = input.authorityBytes;
	if (!(bytes instanceof Uint8Array)) {
		return { ok: false, code: "TRUST_AUTHORITY_DIGEST_MISMATCH" };
	}
	const parsed = parseStrictJsonBytes(bytes);
	// Duplicate keys are a property of well-formed bytes and are reported as
	// such; corruption is reported as the digest failure it is; only bytes
	// that are both intact and correctly hashed are asked to parse.
	if (!parsed.ok && parsed.reason === "duplicate") {
		return { ok: false, code: "TRUST_AUTHORITY_DUPLICATE_FIELD" };
	}
	// An absent digest is a rejection, never a skipped check: gating the
	// comparison on the digest's own presence lets an omission pass.
	if (
		!isHex64(input.expectedAuthorityDigest) ||
		sha256HexOfBytes(bytes) !== input.expectedAuthorityDigest
	) {
		return { ok: false, code: "TRUST_AUTHORITY_DIGEST_MISMATCH" };
	}
	// Bytes that hash correctly but do not parse are a schema failure, not a
	// pass: without this the authority need never have been valid JSON.
	if (!parsed.ok) {
		return { ok: false, code: "TRUST_AUTHORITY_SCHEMA_INVALID" };
	}
	return {
		ok: true,
		authority: parsed.value as AuthorityShape & Record<string, unknown>,
	};
}

/**
 * True when the caller-supplied authority record is canonically identical to
 * the record the verified bytes carry. A record that differs anywhere is not
 * the record the digest attests to, whatever else it may satisfy.
 */
function authorityBindsBytes(supplied: unknown, fromBytes: unknown): boolean {
	try {
		return canonicalJson(supplied) === canonicalJson(fromBytes);
	} catch {
		return false;
	}
}

export function parseCampaignAuthorityV1(
	input: unknown,
): { ok: true; schema: "campaign-authority/v1" } | ValidationFailure {
	if (!isPlainObject(input)) {
		return { ok: false, code: "TRUST_AUTHORITY_SCHEMA_INVALID" };
	}
	const schemaFailure = authoritySchemaFailure(input.authority);
	if (schemaFailure) return schemaFailure;
	const bound = authorityFromBytes(input);
	if (!bound.ok) return bound;
	if (!authorityBindsBytes(input.authority, bound.authority)) {
		return { ok: false, code: "TRUST_AUTHORITY_DIGEST_MISMATCH" };
	}
	return { ok: true, schema: "campaign-authority/v1" };
}

export function validateCampaignAuthorityV1(input: unknown):
	| {
			ok: true;
			candidate: string;
			finalCandidateHead: string;
			rootCount: number;
	  }
	| ValidationFailure {
	if (!isPlainObject(input)) {
		return { ok: false, code: "TRUST_AUTHORITY_SCHEMA_INVALID" };
	}
	if (input.ambientTrustMarker !== undefined) {
		return { ok: false, code: "TRUST_AMBIENT_MARKER_FORBIDDEN" };
	}
	if (
		input.authoritySource !== undefined &&
		input.authoritySource !== "external-operator"
	) {
		return { ok: false, code: "TRUST_AUTHORITY_SELF_AUTH_FORBIDDEN" };
	}
	const schemaFailure = authoritySchemaFailure(input.authority);
	if (schemaFailure) return schemaFailure;
	// The bytes are verified here; the record read below is proven identical
	// to them just before this function can return success.
	const bound = authorityFromBytes(input);
	if (!bound.ok) return bound;
	const authority = input.authority as unknown as AuthorityShape;
	const approval = authority.approval;
	const finalCandidateHead = approval.finalCandidateHead;
	if (!isHex40(finalCandidateHead)) {
		return { ok: false, code: "TRUST_AUTHORITY_SCHEMA_INVALID" };
	}

	const receipt = input.sourceArchiveReceipt;
	const receiptBytes = input.sourceArchiveReceiptBytes;
	if (!isPlainObject(receipt) || !(receiptBytes instanceof Uint8Array)) {
		return { ok: false, code: "TRUST_SOURCE_ARCHIVE_DIGEST_MISMATCH" };
	}
	if (
		receipt.finalCandidateHead !== finalCandidateHead ||
		receipt.candidate !== authority.candidate
	) {
		return { ok: false, code: "TRUST_SOURCE_ARCHIVE_HEAD_MISMATCH" };
	}
	if (sha256HexOfBytes(receiptBytes) !== approval.sourceArchiveReceiptSha256) {
		return { ok: false, code: "TRUST_SOURCE_ARCHIVE_DIGEST_MISMATCH" };
	}

	const bundle = input.r1RedApprovalBundle;
	const bundleBytes = input.r1RedApprovalBundleBytes;
	if (!isPlainObject(bundle) || !(bundleBytes instanceof Uint8Array)) {
		return { ok: false, code: "TRUST_R1_RED_APPROVAL_MISMATCH" };
	}
	const records = bundle.records;
	if (Array.isArray(records)) {
		const roles = records.map((record) =>
			isPlainObject(record) ? record.role : null,
		);
		if (
			roles.length === 2 &&
			roles.includes("spec-reviewer") &&
			roles.includes("verifier") &&
			(roles[0] !== "spec-reviewer" || roles[1] !== "verifier")
		) {
			return { ok: false, code: "TRUST_R1_RED_APPROVAL_ORDER_INVALID" };
		}
	}
	if (
		bundle.redHead !== finalCandidateHead ||
		sha256HexOfBytes(bundleBytes) !== approval.r1RedApprovalBundleSha256
	) {
		return { ok: false, code: "TRUST_R1_RED_APPROVAL_MISMATCH" };
	}

	const roots = authority.roots;
	if (!Array.isArray(roots) || roots.length !== AUTHORITY_ROOT_KINDS.length) {
		return { ok: false, code: "TRUST_AUTHORITY_ROOT_COUNT_INVALID" };
	}
	// The root set is a fixed, ordered tuple, and each entry carries the OS
	// identity the supervisor pinned. Checking only the count and the set of
	// kinds accepts a reordered tuple and never looks at the identities at
	// all — the very fields the authority exists to declare.
	for (const [index, kind] of AUTHORITY_ROOT_KINDS.entries()) {
		const root = roots[index];
		if (!isPlainObject(root) || root.kind !== kind) {
			return { ok: false, code: "TRUST_AUTHORITY_ROOT_COUNT_INVALID" };
		}
		if (typeof root.hostId !== "string" || root.hostId.length === 0) {
			return { ok: false, code: "TRUST_AUTHORITY_ROOT_COUNT_INVALID" };
		}
		if (!directoryIdentityValid(root.identity)) {
			return { ok: false, code: "TRUST_AUTHORITY_ROOT_IDENTITY_INVALID" };
		}
	}

	// Nothing above may conclude until the record every check read is proven
	// to be the record the verified digest covers.
	if (!authorityBindsBytes(authority, bound.authority)) {
		return { ok: false, code: "TRUST_AUTHORITY_DIGEST_MISMATCH" };
	}

	return {
		ok: true,
		candidate: authority.candidate,
		finalCandidateHead,
		rootCount: roots.length,
	};
}

// ---------------------------------------------------------------------------
// source-archive-receipt/v1 and r1-red-approval-bundle/v1
// ---------------------------------------------------------------------------

export function validateSourceArchiveReceiptV1(
	input: unknown,
): { ok: true; schema: "source-archive-receipt/v1" } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.receipt)) {
		return { ok: false, code: "TRUST_SOURCE_RECEIPT_INVALID" };
	}
	const receipt = input.receipt;
	if (receipt.schema !== "source-archive-receipt/v1") {
		return { ok: false, code: "TRUST_SOURCE_RECEIPT_INVALID" };
	}
	const proof = receipt.cleanTreeProof;
	if (
		!isPlainObject(proof) ||
		proof.allEmpty !== true ||
		proof.statusBytesSize !== 0 ||
		proof.unstagedDiffBytesSize !== 0 ||
		proof.stagedDiffBytesSize !== 0 ||
		proof.untrackedFileCount !== 0
	) {
		return { ok: false, code: "TRUST_SOURCE_RECEIPT_INVALID" };
	}
	if (
		!isHex40(receipt.finalCandidateHead) ||
		!isHex40(receipt.finalCandidateTreeOid)
	) {
		return { ok: false, code: "TRUST_SOURCE_RECEIPT_INVALID" };
	}
	const recipe = receipt.archiveRecipe;
	if (
		!isPlainObject(recipe) ||
		recipe.kind !== "git-archive-tar-head/v1" ||
		recipe.prefix !== "source/" ||
		recipe.mtimeSource !== "commit"
	) {
		return { ok: false, code: "TRUST_SOURCE_RECEIPT_INVALID" };
	}
	const bytes = input.bytes;
	if (
		!(bytes instanceof Uint8Array) ||
		!isHex64(input.expectedDigest) ||
		sha256HexOfBytes(bytes) !== input.expectedDigest
	) {
		return { ok: false, code: "TRUST_SOURCE_RECEIPT_DIGEST_MISMATCH" };
	}
	return { ok: true, schema: "source-archive-receipt/v1" };
}

export function validateR1RedApprovalBundleV1(
	input: unknown,
): { ok: true; recordCount: number } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.bundle)) {
		return { ok: false, code: "TRUST_R1_RED_APPROVAL_COUNT_INVALID" };
	}
	const bundle = input.bundle;
	if (bundle.schema !== "r1-red-approval-bundle/v1") {
		return { ok: false, code: "TRUST_R1_RED_APPROVAL_MISMATCH" };
	}
	const records = bundle.records;
	if (!Array.isArray(records) || records.length === 0) {
		return { ok: false, code: "TRUST_R1_RED_APPROVAL_COUNT_INVALID" };
	}
	for (const record of records) {
		if (!isPlainObject(record) || record.verdict !== "APPROVED") {
			return { ok: false, code: "TRUST_R1_RED_APPROVAL_VERDICT_INVALID" };
		}
	}
	const roles = records.map(
		(record) => (record as Record<string, unknown>).role,
	);
	if (new Set(roles).size !== roles.length) {
		return { ok: false, code: "TRUST_R1_RED_APPROVAL_ROLE_DUPLICATE" };
	}
	if (
		records.length !== 2 ||
		roles[0] !== "spec-reviewer" ||
		roles[1] !== "verifier"
	) {
		return { ok: false, code: "TRUST_R1_RED_APPROVAL_COUNT_INVALID" };
	}
	if (input.redHead !== undefined && bundle.redHead !== input.redHead) {
		return { ok: false, code: "TRUST_R1_RED_APPROVAL_MISMATCH" };
	}
	const bytes = input.bytes;
	if (
		!(bytes instanceof Uint8Array) ||
		!isHex64(input.expectedDigest) ||
		sha256HexOfBytes(bytes) !== input.expectedDigest
	) {
		return { ok: false, code: "TRUST_R1_RED_APPROVAL_MISMATCH" };
	}
	return { ok: true, recordCount: records.length };
}

// ---------------------------------------------------------------------------
// campaign-reservation/v1 and supervisor-owned runtime records
// ---------------------------------------------------------------------------

export function validateCampaignReservationV1(
	input: unknown,
): { ok: true; state: "RESERVED" } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.reservation)) {
		return { ok: false, code: "TRUST_CAMPAIGN_RESERVATION_INVALID" };
	}
	const reservation = input.reservation;
	if (reservation.schema !== "campaign-reservation/v1") {
		return { ok: false, code: "TRUST_CAMPAIGN_RESERVATION_INVALID" };
	}
	if (reservation.state === "CONSUMED") {
		return { ok: false, code: "TRUST_CAMPAIGN_RESERVATION_CONSUMED" };
	}
	if (reservation.state !== "RESERVED") {
		return { ok: false, code: "TRUST_CAMPAIGN_RESERVATION_INVALID" };
	}
	const identity = reservation.campaignIdentity;
	if (!isPlainObject(identity) || identity.mode !== 0o700) {
		return { ok: false, code: "TRUST_CAMPAIGN_RESERVATION_NOT_EXCLUSIVE" };
	}
	if (!directoryIdentityValid(identity)) {
		return { ok: false, code: "TRUST_CAMPAIGN_RESERVATION_INVALID" };
	}
	if (isImplausibleDigest(input.expectedAuthoritySha256)) {
		return { ok: false, code: "TRUST_CAMPAIGN_RESERVATION_INVALID" };
	}
	return { ok: true, state: "RESERVED" };
}

export function validateHostRuntimeFactsV1(
	input: unknown,
): { ok: true; hostCount: number } | ValidationFailure {
	if (!isPlainObject(input) || !Array.isArray(input.facts)) {
		return { ok: false, code: "TRUST_RUNTIME_FACTS_AUTHORITY_MISMATCH" };
	}
	if (isImplausibleDigest(input.authoritySha256)) {
		return { ok: false, code: "TRUST_RUNTIME_FACTS_AUTHORITY_MISMATCH" };
	}
	const hosts = new Set<unknown>();
	for (const fact of input.facts) {
		if (!isPlainObject(fact) || fact.schema !== "host-runtime-facts/v1") {
			return { ok: false, code: "TRUST_RUNTIME_FACTS_AUTHORITY_MISMATCH" };
		}
		if (hosts.has(fact.hostId)) {
			return { ok: false, code: "TRUST_RUNTIME_FACTS_HOST_DUPLICATE" };
		}
		hosts.add(fact.hostId);
	}
	if (hosts.size !== 2) {
		return { ok: false, code: "TRUST_RUNTIME_FACTS_HOST_COUNT_INVALID" };
	}
	return { ok: true, hostCount: hosts.size };
}

export function validateHostLaunchProvenanceV1(
	input: unknown,
): { ok: true; hostCount: number } | ValidationFailure {
	if (!isPlainObject(input) || !Array.isArray(input.provenance)) {
		return { ok: false, code: "TRUST_LAUNCH_PROVENANCE_INVALID" };
	}
	if (isImplausibleDigest(input.authoritySha256)) {
		return { ok: false, code: "TRUST_LAUNCH_PROVENANCE_INVALID" };
	}
	const hosts = new Set<unknown>();
	for (const record of input.provenance) {
		if (
			!isPlainObject(record) ||
			record.schema !== "host-launch-provenance/v1"
		) {
			return { ok: false, code: "TRUST_LAUNCH_PROVENANCE_INVALID" };
		}
		if (hosts.has(record.hostId)) {
			return { ok: false, code: "TRUST_LAUNCH_PROVENANCE_HOST_DUPLICATE" };
		}
		hosts.add(record.hostId);
	}
	if (hosts.size !== 2) {
		return { ok: false, code: "TRUST_LAUNCH_PROVENANCE_HOST_COUNT_INVALID" };
	}
	return { ok: true, hostCount: hosts.size };
}

/**
 * The exact `staged-capability/v1` field set. Every field the record
 * declares is a binding; a validator that reads four of them and ignores the
 * rest lets the other twelve say anything.
 */
const STAGED_CAPABILITY_FIELDS = [
	"schema",
	"authoritySha256",
	"lockSha256",
	"candidate",
	"campaignId",
	"sourceArchiveReceiptSha256",
	"r1RedApprovalBundleSha256",
	"sourceArchiveSha256",
	"macStagedArchiveSha256",
	"linuxStagedArchiveSha256",
	"hostSubmissions",
	"sshHostReceiptSha256",
	"macCampaignIdentity",
	"issuedAt",
	"notAfter",
	"fixtureOnly",
] as const;

export function validateStagedCapabilityV1(
	input: unknown,
): { ok: true; fixtureOnly: false } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.capability)) {
		return { ok: false, code: "TRUST_CAPABILITY_INVALID" };
	}
	const capability = input.capability;
	// Duplicate keys and unknown fields are rejected on the record's own
	// bytes before any field is read: JSON.parse keeps the last duplicate, so
	// a byte audit and this validator would otherwise disagree.
	const bytes = input.capabilityBytes;
	if (bytes instanceof Uint8Array) {
		const parsed = parseStrictJsonBytes(bytes);
		if (!parsed.ok) {
			return {
				ok: false,
				code:
					parsed.reason === "duplicate"
						? "TRUST_CAPABILITY_DUPLICATE_FIELD"
						: "TRUST_CAPABILITY_INVALID",
			};
		}
		if (
			!isHex64(input.expectedCapabilityDigest) ||
			sha256HexOfBytes(bytes) !== input.expectedCapabilityDigest
		) {
			return { ok: false, code: "TRUST_CAPABILITY_DIGEST_MISMATCH" };
		}
	}
	if (fieldSetIssue(capability, STAGED_CAPABILITY_FIELDS) !== null) {
		return { ok: false, code: "TRUST_CAPABILITY_INVALID" };
	}
	if (capability.schema !== "staged-capability/v1") {
		return { ok: false, code: "TRUST_CAPABILITY_INVALID" };
	}
	if (capability.fixtureOnly !== false) {
		return { ok: false, code: "TRUST_CAPABILITY_FIXTURE_ONLY_FORBIDDEN" };
	}
	if (capability.authoritySha256 !== input.authoritySha256) {
		return { ok: false, code: "TRUST_CAPABILITY_AUTHORITY_MISMATCH" };
	}
	// Every remaining binding is checked against the caller's expectation
	// when one is supplied, and for shape when one is not.
	for (const [field, expected] of [
		["lockSha256", input.lockSha256],
		["candidate", input.candidate],
		["campaignId", input.campaignId],
	] as const) {
		if (expected !== undefined && capability[field] !== expected) {
			return { ok: false, code: "TRUST_CAPABILITY_AUTHORITY_MISMATCH" };
		}
	}
	for (const field of [
		"lockSha256",
		"sourceArchiveReceiptSha256",
		"r1RedApprovalBundleSha256",
		"sourceArchiveSha256",
		"sshHostReceiptSha256",
	] as const) {
		if (!isHex64(capability[field])) {
			return { ok: false, code: "TRUST_CAPABILITY_INVALID" };
		}
	}
	if (
		typeof capability.candidate !== "string" ||
		typeof capability.campaignId !== "string" ||
		!isPlainObject(capability.macCampaignIdentity) ||
		!Array.isArray(capability.hostSubmissions) ||
		capability.hostSubmissions.length === 0
	) {
		return { ok: false, code: "TRUST_CAPABILITY_INVALID" };
	}
	if (
		typeof capability.issuedAt !== "string" ||
		typeof capability.notAfter !== "string" ||
		capability.issuedAt >= capability.notAfter
	) {
		return { ok: false, code: "TRUST_CAPABILITY_INVALID" };
	}
	if (
		!isHex64(capability.macStagedArchiveSha256) ||
		!isHex64(capability.linuxStagedArchiveSha256) ||
		capability.macStagedArchiveSha256 === capability.linuxStagedArchiveSha256
	) {
		return { ok: false, code: "TRUST_CAPABILITY_STAGED_ARCHIVE_MISMATCH" };
	}
	return { ok: true, fixtureOnly: false };
}

export function validateBunRoleLaunchReceiptSetV1(
	input: unknown,
): { ok: true; expectedProcessCount: number } | ValidationFailure {
	if (!isPlainObject(input) || !isPlainObject(input.receiptSet)) {
		return { ok: false, code: "TRUST_ROLE_RECEIPT_SET_INVALID" };
	}
	const receiptSet = input.receiptSet;
	if (receiptSet.schema !== "bun-role-launch-receipt-set/v1") {
		return { ok: false, code: "TRUST_ROLE_RECEIPT_SET_INVALID" };
	}
	if (
		receiptSet.authoritySha256 !== input.authoritySha256 ||
		receiptSet.lockSha256 !== input.lockSha256 ||
		receiptSet.capabilitySha256 !== input.capabilitySha256
	) {
		return { ok: false, code: "TRUST_ROLE_RECEIPT_SET_BINDING_MISMATCH" };
	}
	const receipts = receiptSet.receipts;
	if (!Array.isArray(receipts)) {
		return { ok: false, code: "TRUST_ROLE_RECEIPT_SET_INVALID" };
	}
	for (const receipt of receipts) {
		if (
			isPlainObject(receipt) &&
			receipt.socketBeforeStartupHandshake === true
		) {
			return { ok: false, code: "TRUST_ROLE_SOCKET_BEFORE_HANDSHAKE" };
		}
	}
	const expectedProcessCount = receiptSet.expectedProcessCount;
	if (
		typeof expectedProcessCount !== "number" ||
		receipts.length !== expectedProcessCount
	) {
		return { ok: false, code: "TRUST_ROLE_RECEIPT_COUNT_INVALID" };
	}
	const bytes = input.bytes;
	if (
		!(bytes instanceof Uint8Array) ||
		!isHex64(input.expectedDigest) ||
		sha256HexOfBytes(bytes) !== input.expectedDigest
	) {
		return { ok: false, code: "TRUST_ROLE_RECEIPT_SET_DIGEST_MISMATCH" };
	}
	return { ok: true, expectedProcessCount };
}

// ---------------------------------------------------------------------------
// Authority digest graph
// ---------------------------------------------------------------------------

export function validateAuthorityDigestGraph(
	input: unknown,
): { ok: true; acyclic: true } | ValidationFailure {
	if (!isPlainObject(input) || !Array.isArray(input.edges)) {
		return { ok: false, code: "TRUST_AUTHORITY_DIGEST_EDGE_MISSING" };
	}
	const edges: Array<readonly [string, string]> = [];
	for (const edge of input.edges) {
		if (
			!Array.isArray(edge) ||
			edge.length !== 2 ||
			typeof edge[0] !== "string" ||
			typeof edge[1] !== "string"
		) {
			return { ok: false, code: "TRUST_AUTHORITY_DIGEST_EDGE_MISSING" };
		}
		edges.push([edge[0], edge[1]]);
	}
	const seen = new Set<string>();
	for (const [from, to] of edges) {
		const key = `${from}\u0000${to}`;
		if (seen.has(key)) {
			return { ok: false, code: "TRUST_AUTHORITY_DIGEST_EDGE_DUPLICATE" };
		}
		seen.add(key);
	}
	if (
		!edges.some(
			([from, to]) =>
				from === "campaign-authority/v1" && to === "campaign-lock/v1",
		)
	) {
		return { ok: false, code: "TRUST_AUTHORITY_DIGEST_EDGE_MISSING" };
	}
	const adjacency = new Map<string, string[]>();
	for (const [from, to] of edges) {
		const targets = adjacency.get(from);
		if (targets) targets.push(to);
		else adjacency.set(from, [to]);
	}
	const visiting = new Set<string>();
	const done = new Set<string>();
	// Attacker-shaped input drives this walk, so the depth is bounded rather
	// than left to blow the stack with an uncatchable RangeError. No honest
	// digest graph is deeper than its node count.
	const maxDepth = adjacency.size + 1;
	const hasCycle = (node: string, depth: number): boolean => {
		if (depth > maxDepth) return true;
		if (done.has(node)) return false;
		if (visiting.has(node)) return true;
		visiting.add(node);
		for (const next of adjacency.get(node) ?? []) {
			if (hasCycle(next, depth + 1)) return true;
		}
		visiting.delete(node);
		done.add(node);
		return false;
	};
	for (const node of adjacency.keys()) {
		if (hasCycle(node, 0)) {
			return { ok: false, code: "TRUST_AUTHORITY_DIGEST_CYCLE" };
		}
	}
	return { ok: true, acyclic: true };
}
