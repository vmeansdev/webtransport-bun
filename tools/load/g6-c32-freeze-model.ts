import { createHash } from "node:crypto";

export type ClockSource = "offrunner" | "server" | "generator" | "provider";

export type RecordEnvelope = {
	recordedAt: string;
	sequence: number;
	runId: string;
	phase: string;
	operationId: string;
	clockSource: ClockSource;
};

export type AuthorityRecord<S extends string, A> = {
	schema: S;
	envelope: RecordEnvelope;
	authoritySha256: string;
	authority: A;
};

export type ArtifactIdentity = {
	path: string;
	sha256: string;
};

export type SemanticFreezeAuthority = {
	candidate: { commit: string; tree: string };
	plan: ArtifactIdentity;
	controller: ArtifactIdentity;
	freezeGenerator: ArtifactIdentity & { schemaVersion: string };
	templates: {
		registration: ArtifactIdentity;
		runbook: ArtifactIdentity;
	};
	campaignInputs: ArtifactIdentity[];
	gateCatalog: ArtifactIdentity;
};

export type ReviewReceiptAuthority = {
	semanticFreezeAuthoritySha256: string;
	role: "architect" | "critic";
	verdict: "APPROVE";
	unconditional: true;
	afterArchitectReceiptArtifactSha256: string | null;
};

export type SemanticApprovalAuthority = {
	semanticFreezeAuthoritySha256: string;
	architect: {
		verdict: "APPROVE";
		unconditional: true;
		receiptPath: string;
		receiptArtifactSha256: string;
	};
	critic: {
		verdict: "APPROVE";
		unconditional: true;
		receiptPath: string;
		receiptArtifactSha256: string;
		afterArchitectReceiptArtifactSha256: string;
	};
};

export type SemanticFreezeRecord = AuthorityRecord<
	"g6-c32-semantic-freeze/1",
	SemanticFreezeAuthority
>;
export type ReviewReceiptRecord = AuthorityRecord<
	"g6-c32-review-receipt/1",
	ReviewReceiptAuthority
>;
export type SemanticApprovalRecord = AuthorityRecord<
	"g6-c32-semantic-approval/1",
	SemanticApprovalAuthority
>;

export type OperationReceipt = {
	schema: "g6-c32-operation-receipt/1";
	envelope: RecordEnvelope;
	startedAt: string;
	finishedAt: string;
	durationMonotonicNs: string;
	attempt: number;
	action: {
		command: string;
		args: string[];
		cwd: string;
		environmentKeys: string[];
	};
	status: {
		outcome: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
		exitCode: number | null;
		signal: string | null;
	};
	stdoutPath: string;
	stderrPath: string;
	remoteTiming: null | {
		requestStartedAt: string;
		responseFinishedAt: string;
		observationAt: string | null;
	};
};

const CLOCK_SOURCES = new Set<ClockSource>([
	"offrunner",
	"server",
	"generator",
	"provider",
]);
const HASH_RE = /^[0-9a-f]{64}$/;
const RFC3339_MILLIS_RE =
	/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

type JsonScalar = null | boolean | number | string;
type CanonicalValue =
	| JsonScalar
	| CanonicalValue[]
	| { [key: string]: CanonicalValue };

function fail(path: string, message: string): never {
	throw new Error(`g6-c32-freeze: ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(
	value: unknown,
	path: string,
	ancestors: WeakSet<object>,
): CanonicalValue {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail(path, "number must be finite");
		return value;
	}
	if (typeof value !== "object") {
		fail(path, `unsupported ${typeof value} value`);
	}
	if (ancestors.has(value)) fail(path, "cyclic value");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const ownKeys = Reflect.ownKeys(value).filter((key) => key !== "length");
			if (
				ownKeys.length !== value.length ||
				ownKeys.some(
					(key, index) => typeof key !== "string" || key !== String(index),
				)
			) {
				fail(path, "arrays must be dense and have no extra properties");
			}
			return value.map((entry, index) =>
				canonicalize(entry, `${path}[${index}]`, ancestors),
			);
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			fail(path, "objects must have a plain prototype");
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			fail(path, "symbol keys are not supported");
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const output: Record<string, CanonicalValue> = {};
		for (const key of Object.keys(descriptors).sort()) {
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				fail(`${path}.${key}`, "properties must be enumerable data values");
			}
			output[key] = canonicalize(descriptor.value, `${path}.${key}`, ancestors);
		}
		return output;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return `${JSON.stringify(canonicalize(value, "$", new WeakSet()), null, 2)}\n`;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function canonicalAuthoritySha256(authority: unknown): string {
	return sha256(canonicalJson(authority));
}

export function canonicalArtifactSha256(record: unknown): string {
	return sha256(canonicalJson(record));
}

function requireExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	path: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, i) => key !== wanted[i])
	) {
		fail(path, `expected keys ${wanted.join(",")}; got ${actual.join(",")}`);
	}
}

function requireNonemptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		fail(path, "must be a nonempty string");
	}
	if (value.includes("\0")) fail(path, "must not contain NUL");
	return value;
}

function requireSha256(value: unknown, path: string): string {
	if (typeof value !== "string" || !HASH_RE.test(value)) {
		fail(path, "must be 64 lowercase hexadecimal characters");
	}
	return value;
}

function requireGitSha1(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
		fail(path, "must be a 40-character lowercase Git object ID");
	}
	return value;
}

function requirePortablePath(value: unknown, path: string): string {
	const checked = requireNonemptyString(value, path);
	if (
		checked.startsWith("/") ||
		checked.includes("\\") ||
		checked
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	) {
		fail(path, "must be a portable repository-relative path");
	}
	return checked;
}

function requireCommandValue(value: unknown, path: string): string {
	const checked = requireNonemptyString(value, path);
	if (checked.includes("\n") || checked.includes("\r")) {
		fail(path, "must be a single-line value");
	}
	return checked;
}

function requireStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) fail(path, "must be an array");
	return value.map((entry, index) => {
		if (typeof entry !== "string" || entry.includes("\0")) {
			fail(`${path}[${index}]`, "must be a NUL-free string");
		}
		return entry;
	});
}

function validateArtifactIdentity(
	value: unknown,
	path: string,
): ArtifactIdentity {
	if (!isRecord(value)) fail(path, "must be an object");
	requireExactKeys(value, ["path", "sha256"], path);
	return {
		path: requirePortablePath(value.path, `${path}.path`),
		sha256: requireSha256(value.sha256, `${path}.sha256`),
	};
}

function validateAuthorityRecord<S extends string, A>(
	value: unknown,
	schema: S,
	validateAuthority: (authority: unknown) => A,
): AuthorityRecord<S, A> {
	if (!isRecord(value)) fail(schema, "record must be an object");
	requireExactKeys(
		value,
		["schema", "envelope", "authoritySha256", "authority"],
		schema,
	);
	if (value.schema !== schema) fail("schema", `must equal ${schema}`);
	const envelope = validateEnvelope(value.envelope);
	const authority = validateAuthority(value.authority);
	const authoritySha256 = requireSha256(
		value.authoritySha256,
		"authoritySha256",
	);
	const computed = canonicalAuthoritySha256(authority);
	if (authoritySha256 !== computed) {
		fail("authoritySha256", `digest mismatch; computed ${computed}`);
	}
	return { schema, envelope, authoritySha256, authority };
}

function validateSemanticFreezeAuthority(
	value: unknown,
): SemanticFreezeAuthority {
	if (!isRecord(value)) fail("authority", "must be an object");
	requireExactKeys(
		value,
		[
			"candidate",
			"plan",
			"controller",
			"freezeGenerator",
			"templates",
			"campaignInputs",
			"gateCatalog",
		],
		"authority",
	);
	if (!isRecord(value.candidate))
		fail("authority.candidate", "must be an object");
	requireExactKeys(value.candidate, ["commit", "tree"], "authority.candidate");
	if (!isRecord(value.freezeGenerator)) {
		fail("authority.freezeGenerator", "must be an object");
	}
	requireExactKeys(
		value.freezeGenerator,
		["path", "sha256", "schemaVersion"],
		"authority.freezeGenerator",
	);
	if (!isRecord(value.templates))
		fail("authority.templates", "must be an object");
	requireExactKeys(
		value.templates,
		["registration", "runbook"],
		"authority.templates",
	);
	if (
		!Array.isArray(value.campaignInputs) ||
		value.campaignInputs.length === 0
	) {
		fail("authority.campaignInputs", "must be a nonempty array");
	}
	const campaignInputs = value.campaignInputs.map((entry, index) =>
		validateArtifactIdentity(entry, `authority.campaignInputs[${index}]`),
	);
	const paths = new Set(campaignInputs.map((entry) => entry.path));
	if (paths.size !== campaignInputs.length) {
		fail("authority.campaignInputs", "paths must be unique");
	}
	return {
		candidate: {
			commit: requireGitSha1(
				value.candidate.commit,
				"authority.candidate.commit",
			),
			tree: requireGitSha1(value.candidate.tree, "authority.candidate.tree"),
		},
		plan: validateArtifactIdentity(value.plan, "authority.plan"),
		controller: validateArtifactIdentity(
			value.controller,
			"authority.controller",
		),
		freezeGenerator: {
			path: requirePortablePath(
				value.freezeGenerator.path,
				"authority.freezeGenerator.path",
			),
			sha256: requireSha256(
				value.freezeGenerator.sha256,
				"authority.freezeGenerator.sha256",
			),
			schemaVersion: requireNonemptyString(
				value.freezeGenerator.schemaVersion,
				"authority.freezeGenerator.schemaVersion",
			),
		},
		templates: {
			registration: validateArtifactIdentity(
				value.templates.registration,
				"authority.templates.registration",
			),
			runbook: validateArtifactIdentity(
				value.templates.runbook,
				"authority.templates.runbook",
			),
		},
		campaignInputs,
		gateCatalog: validateArtifactIdentity(
			value.gateCatalog,
			"authority.gateCatalog",
		),
	};
}

function validateReviewAuthority(value: unknown): ReviewReceiptAuthority {
	if (!isRecord(value)) fail("authority", "must be an object");
	requireExactKeys(
		value,
		[
			"semanticFreezeAuthoritySha256",
			"role",
			"verdict",
			"unconditional",
			"afterArchitectReceiptArtifactSha256",
		],
		"authority",
	);
	if (value.role !== "architect" && value.role !== "critic") {
		fail("authority.role", "must be architect or critic");
	}
	if (value.verdict !== "APPROVE") {
		fail("authority.verdict", "must be APPROVE");
	}
	if (value.unconditional !== true) {
		fail("authority.unconditional", "must be true");
	}
	let afterArchitectReceiptArtifactSha256: string | null;
	if (value.role === "architect") {
		if (value.afterArchitectReceiptArtifactSha256 !== null) {
			fail(
				"authority.afterArchitectReceiptArtifactSha256",
				"must be null for Architect",
			);
		}
		afterArchitectReceiptArtifactSha256 = null;
	} else {
		afterArchitectReceiptArtifactSha256 = requireSha256(
			value.afterArchitectReceiptArtifactSha256,
			"authority.afterArchitectReceiptArtifactSha256",
		);
	}
	return {
		semanticFreezeAuthoritySha256: requireSha256(
			value.semanticFreezeAuthoritySha256,
			"authority.semanticFreezeAuthoritySha256",
		),
		role: value.role,
		verdict: "APPROVE",
		unconditional: true,
		afterArchitectReceiptArtifactSha256,
	};
}

function validateApprovalParty(
	value: unknown,
	path: string,
	critic: boolean,
):
	| SemanticApprovalAuthority["architect"]
	| SemanticApprovalAuthority["critic"] {
	if (!isRecord(value)) fail(path, "must be an object");
	const keys = [
		"verdict",
		"unconditional",
		"receiptPath",
		"receiptArtifactSha256",
	];
	if (critic) keys.push("afterArchitectReceiptArtifactSha256");
	requireExactKeys(value, keys, path);
	if (value.verdict !== "APPROVE") fail(`${path}.verdict`, "must be APPROVE");
	if (value.unconditional !== true)
		fail(`${path}.unconditional`, "must be true");
	const base = {
		verdict: "APPROVE" as const,
		unconditional: true as const,
		receiptPath: requirePortablePath(value.receiptPath, `${path}.receiptPath`),
		receiptArtifactSha256: requireSha256(
			value.receiptArtifactSha256,
			`${path}.receiptArtifactSha256`,
		),
	};
	if (!critic) return base;
	return {
		...base,
		afterArchitectReceiptArtifactSha256: requireSha256(
			value.afterArchitectReceiptArtifactSha256,
			`${path}.afterArchitectReceiptArtifactSha256`,
		),
	};
}

function validateSemanticApprovalAuthority(
	value: unknown,
): SemanticApprovalAuthority {
	if (!isRecord(value)) fail("authority", "must be an object");
	requireExactKeys(
		value,
		["semanticFreezeAuthoritySha256", "architect", "critic"],
		"authority",
	);
	return {
		semanticFreezeAuthoritySha256: requireSha256(
			value.semanticFreezeAuthoritySha256,
			"authority.semanticFreezeAuthoritySha256",
		),
		architect: validateApprovalParty(
			value.architect,
			"authority.architect",
			false,
		) as SemanticApprovalAuthority["architect"],
		critic: validateApprovalParty(
			value.critic,
			"authority.critic",
			true,
		) as SemanticApprovalAuthority["critic"],
	};
}

function validateOperationAction(value: unknown): OperationReceipt["action"] {
	if (!isRecord(value)) fail("action", "must be an object");
	requireExactKeys(
		value,
		["command", "args", "cwd", "environmentKeys"],
		"action",
	);
	const cwd = requireCommandValue(value.cwd, "action.cwd");
	if (
		cwd !== "." &&
		(cwd.startsWith("/") ||
			cwd.includes("\\") ||
			cwd
				.split("/")
				.some((part) => part === "" || part === "." || part === ".."))
	) {
		fail("action.cwd", "must be '.' or a portable repository-relative path");
	}
	const environmentKeys = requireStringArray(
		value.environmentKeys,
		"action.environmentKeys",
	);
	if (
		new Set(environmentKeys).size !== environmentKeys.length ||
		environmentKeys.some((key) => !/^[A-Z_][A-Z0-9_]*$/.test(key))
	) {
		fail("action.environmentKeys", "must be unique environment names");
	}
	return {
		command: requireCommandValue(value.command, "action.command"),
		args: requireStringArray(value.args, "action.args"),
		cwd,
		environmentKeys,
	};
}

function validateOperationStatus(value: unknown): OperationReceipt["status"] {
	if (!isRecord(value)) fail("status", "must be an object");
	requireExactKeys(value, ["outcome", "exitCode", "signal"], "status");
	if (
		value.outcome !== "SUCCEEDED" &&
		value.outcome !== "FAILED" &&
		value.outcome !== "TIMED_OUT" &&
		value.outcome !== "CANCELLED"
	) {
		fail("status.outcome", "is not recognized");
	}
	if (
		value.exitCode !== null &&
		(!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0)
	) {
		fail("status.exitCode", "must be null or a nonnegative safe integer");
	}
	if (value.signal !== null && typeof value.signal !== "string") {
		fail("status.signal", "must be null or a string");
	}
	if (value.outcome === "SUCCEEDED" && value.exitCode !== 0) {
		fail("status.exitCode", "must be zero for SUCCEEDED");
	}
	if (value.outcome !== "SUCCEEDED" && value.exitCode === 0) {
		fail("status.exitCode", "must not be zero for a non-success outcome");
	}
	return {
		outcome: value.outcome,
		exitCode: value.exitCode as number | null,
		signal: value.signal as string | null,
	};
}

function validateRemoteTiming(
	value: unknown,
): OperationReceipt["remoteTiming"] {
	if (value === null) return null;
	if (!isRecord(value)) fail("remoteTiming", "must be null or an object");
	requireExactKeys(
		value,
		["requestStartedAt", "responseFinishedAt", "observationAt"],
		"remoteTiming",
	);
	const requestStartedAt = validateRfc3339Millis(
		value.requestStartedAt,
		"remoteTiming.requestStartedAt",
	);
	const responseFinishedAt = validateRfc3339Millis(
		value.responseFinishedAt,
		"remoteTiming.responseFinishedAt",
	);
	if (Date.parse(responseFinishedAt) < Date.parse(requestStartedAt)) {
		fail("remoteTiming", "response must not precede request");
	}
	return {
		requestStartedAt,
		responseFinishedAt,
		observationAt:
			value.observationAt === null
				? null
				: validateRfc3339Millis(
						value.observationAt,
						"remoteTiming.observationAt",
					),
	};
}

export function validateRfc3339Millis(value: unknown, path: string): string {
	if (typeof value !== "string" || !RFC3339_MILLIS_RE.test(value)) {
		fail(path, "must be RFC 3339 UTC with millisecond precision");
	}
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		fail(path, "must be a real UTC instant");
	}
	return value;
}

export function validateEnvelope(value: unknown): RecordEnvelope {
	if (!isRecord(value)) fail("envelope", "must be an object");
	requireExactKeys(
		value,
		["recordedAt", "sequence", "runId", "phase", "operationId", "clockSource"],
		"envelope",
	);
	const sequence = value.sequence;
	if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
		fail("envelope.sequence", "must be a positive safe integer");
	}
	if (!CLOCK_SOURCES.has(value.clockSource as ClockSource)) {
		fail("envelope.clockSource", "is not recognized");
	}
	return {
		recordedAt: validateRfc3339Millis(value.recordedAt, "envelope.recordedAt"),
		sequence: sequence as number,
		runId: requireNonemptyString(value.runId, "envelope.runId"),
		phase: requireNonemptyString(value.phase, "envelope.phase"),
		operationId: requireNonemptyString(
			value.operationId,
			"envelope.operationId",
		),
		clockSource: value.clockSource as ClockSource,
	};
}

export function makeAuthorityRecord<S extends string, A>(
	schema: S,
	envelope: RecordEnvelope,
	authority: A,
): AuthorityRecord<S, A> {
	requireNonemptyString(schema, "schema");
	const checkedEnvelope = validateEnvelope(envelope);
	const authoritySha256 = canonicalAuthoritySha256(authority);
	if (!HASH_RE.test(authoritySha256)) fail("authoritySha256", "is malformed");
	return {
		schema,
		envelope: checkedEnvelope,
		authoritySha256,
		authority,
	};
}

export function validateSemanticFreezeRecord(
	value: unknown,
): SemanticFreezeRecord {
	return validateAuthorityRecord(
		value,
		"g6-c32-semantic-freeze/1",
		validateSemanticFreezeAuthority,
	);
}

export function validateReviewReceipt(value: unknown): ReviewReceiptRecord {
	return validateAuthorityRecord(
		value,
		"g6-c32-review-receipt/1",
		validateReviewAuthority,
	);
}

export function validateSemanticApprovalRecord(
	value: unknown,
): SemanticApprovalRecord {
	return validateAuthorityRecord(
		value,
		"g6-c32-semantic-approval/1",
		validateSemanticApprovalAuthority,
	);
}

export function validateOperationReceipt(value: unknown): OperationReceipt {
	if (!isRecord(value)) fail("operationReceipt", "must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"envelope",
			"startedAt",
			"finishedAt",
			"durationMonotonicNs",
			"attempt",
			"action",
			"status",
			"stdoutPath",
			"stderrPath",
			"remoteTiming",
		],
		"operationReceipt",
	);
	if (value.schema !== "g6-c32-operation-receipt/1") {
		fail("schema", "must equal g6-c32-operation-receipt/1");
	}
	const startedAt = validateRfc3339Millis(value.startedAt, "startedAt");
	const finishedAt = validateRfc3339Millis(value.finishedAt, "finishedAt");
	if (Date.parse(finishedAt) < Date.parse(startedAt)) {
		fail("finishedAt", "must not precede startedAt");
	}
	if (
		typeof value.durationMonotonicNs !== "string" ||
		!/^(?:0|[1-9]\d*)$/.test(value.durationMonotonicNs)
	) {
		fail("durationMonotonicNs", "must be a nonnegative decimal integer string");
	}
	if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
		fail("attempt", "must be a positive safe integer");
	}
	return {
		schema: "g6-c32-operation-receipt/1",
		envelope: validateEnvelope(value.envelope),
		startedAt,
		finishedAt,
		durationMonotonicNs: value.durationMonotonicNs,
		attempt: value.attempt as number,
		action: validateOperationAction(value.action),
		status: validateOperationStatus(value.status),
		stdoutPath: requirePortablePath(value.stdoutPath, "stdoutPath"),
		stderrPath: requirePortablePath(value.stderrPath, "stderrPath"),
		remoteTiming: validateRemoteTiming(value.remoteTiming),
	};
}

export function validateRecordSequence(
	values: readonly unknown[],
): RecordEnvelope[] {
	const envelopes = values.map((value) => validateEnvelope(value));
	for (let index = 1; index < envelopes.length; index += 1) {
		const previous = envelopes[index - 1];
		const current = envelopes[index];
		if (!previous || !current || current.sequence <= previous.sequence) {
			fail(`envelopes[${index}].sequence`, "must strictly increase");
		}
		if (current.runId !== previous.runId) {
			fail(`envelopes[${index}].runId`, "must remain constant within a stream");
		}
	}
	return envelopes;
}

export function validateDeadline(
	requestedAt: unknown,
	deadline: unknown,
): string {
	const requested = validateRfc3339Millis(requestedAt, "requestedAt");
	const checkedDeadline = validateRfc3339Millis(deadline, "deadline");
	if (Date.parse(checkedDeadline) <= Date.parse(requested)) {
		fail("deadline", "must be later than requestedAt");
	}
	return checkedDeadline;
}

export function shellQuote(value: string): string {
	if (typeof value !== "string" || value.includes("\0")) {
		fail("shellValue", "must be a NUL-free string");
	}
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}
