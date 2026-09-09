// R1 staged trust capability loader (Task C). Pure record validation: bytes
// arrive through an injected reader, never through ambient filesystem access.
import {
	findDuplicateJsonKey,
	hasOwn,
	isHex64,
	isImplausibleDigest,
	isSafeCount,
	sha256HexOfBytes,
	type ValidationFailure,
} from "./secure-fs.ts";

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

const CAPABILITY_FIELDS = [
	"schemaVersion",
	"candidateId",
	"campaignId",
	"locator",
	"stagingId",
	"stagingRootIdentity",
	"lockDigestSha256",
	"archiveSha256",
	"stagedArchiveSha256",
	"issuedAtMs",
	"notAfterMs",
	"fixtureOnly",
	"hostSubmissions",
] as const;

const OS_IDENTITY_FIELDS = [
	"system",
	"release",
	"architecture",
	"identitySha256",
] as const;

const HOST_SUBMISSION_FIELDS = [
	"hostId",
	"platform",
	"lockDigestSha256",
	"archiveSha256",
	"stagedArchiveSha256",
	"stagingRootIdentity",
	"osIdentity",
] as const;

function fieldSetIssue(
	record: Rec,
	allowedKeys: readonly string[],
): "unknown" | "missing" | null {
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(record)) {
		if (!allowed.has(key)) return "unknown";
	}
	for (const key of allowedKeys) {
		if (!hasOwn(record, key)) return "missing";
	}
	return null;
}

function unsafeLocator(locator: unknown): boolean {
	if (typeof locator !== "string" || locator.length === 0) return true;
	if (locator.startsWith("/") || locator.includes("\\")) return true;
	return locator
		.split("/")
		.some(
			(component) =>
				component === ".." || component === "." || component === "",
		);
}

function hostIdMatchesPlatform(hostId: unknown, platform: unknown): boolean {
	if (typeof hostId !== "string" || typeof platform !== "string") return false;
	if (platform.startsWith("darwin")) return hostId.startsWith("mac-");
	if (platform.startsWith("linux")) return hostId.startsWith("linux-");
	return false;
}

function osIdentityMatchesPlatform(
	osIdentity: unknown,
	platform: unknown,
): boolean {
	if (!isPlainObject(osIdentity) || typeof platform !== "string") return false;
	// Unknown-field rejection is total: a nested object is as good a
	// smuggling channel as the record that contains it.
	if (fieldSetIssue(osIdentity, OS_IDENTITY_FIELDS) !== null) return false;
	if (isImplausibleDigest(osIdentity.identitySha256)) return false;
	if (platform.startsWith("darwin")) {
		return (
			osIdentity.system === "Darwin" && osIdentity.architecture === "arm64"
		);
	}
	if (platform.startsWith("linux")) {
		return (
			osIdentity.system === "Linux" && osIdentity.architecture === "x86_64"
		);
	}
	return false;
}

export function rejectAmbientOrArtifactTrust(input: unknown): {
	ok: false;
	codes: readonly string[];
} {
	const codes: string[] = [];
	if (isPlainObject(input) && input.ambientTrustMarker !== undefined) {
		codes.push("TRUST_MARKER_ENV_FORBIDDEN");
	}
	if (isPlainObject(input) && input.artifactContainedTrust !== undefined) {
		codes.push("TRUST_ARTIFACT_SELF_AUTH_FORBIDDEN");
	}
	if (codes.length === 0) {
		codes.push("TRUST_AMBIENT_MARKER_FORBIDDEN");
	}
	return { ok: false, codes };
}

export function loadStagedTrustCapability(
	input: unknown,
): { ok: true; hostCount: number; capability: Rec } | ValidationFailure {
	if (!isPlainObject(input)) {
		return { ok: false, code: "TRUST_CAPABILITY_READ_FAILED" };
	}
	if (input.ambientTrustMarker !== undefined) {
		return { ok: false, code: "TRUST_AMBIENT_MARKER_FORBIDDEN" };
	}
	if (unsafeLocator(input.locator)) {
		return { ok: false, code: "TRUST_CAPABILITY_LOCATOR_UNSAFE" };
	}
	const readBytes = input.readBytes;
	if (typeof readBytes !== "function") {
		return { ok: false, code: "TRUST_CAPABILITY_READ_FAILED" };
	}
	let bytes: unknown;
	try {
		bytes = readBytes();
	} catch {
		return { ok: false, code: "TRUST_CAPABILITY_READ_FAILED" };
	}
	if (!(bytes instanceof Uint8Array)) {
		return { ok: false, code: "TRUST_CAPABILITY_READ_FAILED" };
	}
	if (
		!isHex64(input.expectedCapabilityDigest) ||
		sha256HexOfBytes(bytes) !== input.expectedCapabilityDigest
	) {
		return { ok: false, code: "TRUST_CAPABILITY_DIGEST_MISMATCH" };
	}
	const text = new TextDecoder().decode(bytes);
	let capability: unknown;
	try {
		capability = JSON.parse(text);
	} catch {
		return { ok: false, code: "TRUST_CAPABILITY_MALFORMED" };
	}
	if (findDuplicateJsonKey(text) !== null) {
		return { ok: false, code: "TRUST_CAPABILITY_DUPLICATE_FIELD" };
	}
	if (!isPlainObject(capability)) {
		return { ok: false, code: "TRUST_CAPABILITY_MALFORMED" };
	}
	const issue = fieldSetIssue(capability, CAPABILITY_FIELDS);
	if (issue === "unknown") {
		return { ok: false, code: "TRUST_CAPABILITY_UNKNOWN_FIELD" };
	}
	if (issue === "missing") {
		return { ok: false, code: "TRUST_CAPABILITY_MALFORMED" };
	}
	if (capability.fixtureOnly !== false) {
		return { ok: false, code: "TRUST_CAPABILITY_FIXTURE_ONLY_FORBIDDEN" };
	}
	if (capability.candidateId !== input.expectedCandidateId) {
		return { ok: false, code: "TRUST_CAPABILITY_CANDIDATE_MISMATCH" };
	}
	if (capability.campaignId !== input.expectedCampaignId) {
		return { ok: false, code: "TRUST_CAPABILITY_CAMPAIGN_MISMATCH" };
	}
	if (capability.lockDigestSha256 !== input.expectedLockDigest) {
		return { ok: false, code: "TRUST_CAPABILITY_LOCK_DIGEST_MISMATCH" };
	}
	if (capability.archiveSha256 !== input.expectedArchiveDigest) {
		return { ok: false, code: "TRUST_CAPABILITY_ARCHIVE_DIGEST_MISMATCH" };
	}
	if (isImplausibleDigest(capability.stagedArchiveSha256)) {
		return { ok: false, code: "TRUST_CAPABILITY_STAGED_ARCHIVE_MISMATCH" };
	}

	// The staging identifiers are derived from the campaign identity; drifted
	// values cannot re-bind the capability to another staging root.
	const campaignId = String(capability.campaignId);
	const campaignDate = campaignId.match(/\d{4}-\d{2}-\d{2}/)?.[0];
	if (
		campaignDate === undefined ||
		capability.stagingId !== `staging-${campaignDate}-r1`
	) {
		return { ok: false, code: "TRUST_CAPABILITY_STAGING_ID_MISMATCH" };
	}
	if (
		capability.stagingRootIdentity !== `official/staging/root/${campaignId}`
	) {
		return { ok: false, code: "TRUST_CAPABILITY_ROOT_IDENTITY_MISMATCH" };
	}

	const nowMs = input.nowMs;
	const issuedAtMs = capability.issuedAtMs;
	const notAfterMs = capability.notAfterMs;
	// `typeof x === "number"` admits Infinity (which `1e999` parses to) and
	// NaN: an Infinity `notAfterMs` is a capability that never expires, and a
	// NaN one compares false against every bound.
	if (
		!isSafeCount(nowMs) ||
		!isSafeCount(issuedAtMs) ||
		!isSafeCount(notAfterMs) ||
		issuedAtMs >= notAfterMs
	) {
		return { ok: false, code: "TRUST_CAPABILITY_MALFORMED" };
	}
	if (nowMs < issuedAtMs) {
		return { ok: false, code: "TRUST_CAPABILITY_NOT_YET_VALID" };
	}
	if (nowMs > notAfterMs) {
		return { ok: false, code: "TRUST_CAPABILITY_EXPIRED" };
	}

	const hostSubmissions = capability.hostSubmissions;
	if (!Array.isArray(hostSubmissions)) {
		return { ok: false, code: "TRUST_CAPABILITY_MALFORMED" };
	}
	const hostIds = new Set<unknown>();
	for (const host of hostSubmissions) {
		if (!isPlainObject(host)) {
			return { ok: false, code: "TRUST_CAPABILITY_MALFORMED" };
		}
		if (hostIds.has(host.hostId)) {
			return { ok: false, code: "TRUST_CAPABILITY_HOST_SUBMISSION_DUPLICATE" };
		}
		hostIds.add(host.hostId);
	}
	for (const host of hostSubmissions as Rec[]) {
		if (fieldSetIssue(host, HOST_SUBMISSION_FIELDS) !== null) {
			return { ok: false, code: "TRUST_CAPABILITY_MALFORMED" };
		}
		if (!hostIdMatchesPlatform(host.hostId, host.platform)) {
			return { ok: false, code: "TRUST_CAPABILITY_HOST_ID_INVALID" };
		}
		if (host.lockDigestSha256 !== capability.lockDigestSha256) {
			return { ok: false, code: "TRUST_CAPABILITY_HOST_LOCK_DIGEST_MISMATCH" };
		}
		if (host.archiveSha256 !== capability.archiveSha256) {
			return {
				ok: false,
				code: "TRUST_CAPABILITY_HOST_ARCHIVE_DIGEST_MISMATCH",
			};
		}
		if (host.stagedArchiveSha256 !== capability.stagedArchiveSha256) {
			return {
				ok: false,
				code: "TRUST_CAPABILITY_HOST_STAGED_ARCHIVE_DIGEST_MISMATCH",
			};
		}
		if (host.stagingRootIdentity !== capability.stagingRootIdentity) {
			return {
				ok: false,
				code: "TRUST_CAPABILITY_HOST_STAGING_IDENTITY_MISMATCH",
			};
		}
		if (!osIdentityMatchesPlatform(host.osIdentity, host.platform)) {
			return { ok: false, code: "TRUST_CAPABILITY_HOST_OS_IDENTITY_MISMATCH" };
		}
	}
	if (hostIds.size !== 2) {
		return { ok: false, code: "TRUST_CAPABILITY_HOST_COUNT_INVALID" };
	}

	return { ok: true, hostCount: hostIds.size, capability };
}
