import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { VerifiedBoundFreeze } from "./g6-c32-freeze.ts";
import { verifyBoundFreeze } from "./g6-c32-freeze.ts";
import {
	canonicalArtifactSha256,
	canonicalJson,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";

export type CapacityHostReviewContext = Readonly<{
	runId: string;
	semanticFreezeAuthoritySha256: string;
	hostBindingArtifactSha256: string;
	dispatchFreezeArtifactSha256: string;
	boundAt: string;
}>;

export type CapacityHostReviewRecord = Readonly<{
	schema: "g6-capacity-host-review/1";
	context: CapacityHostReviewContext;
	role: "architect" | "critic";
	verdict: "APPROVE";
	unconditional: true;
	reviewedAt: string;
	afterArchitectArtifactSha256: string | null;
	reviewNoteSha256: string;
}>;

export type CapacityHostReviews = Readonly<{
	context: CapacityHostReviewContext;
	architect: CapacityHostReviewRecord;
	critic: CapacityHostReviewRecord;
}>;

export type ValidateCapacityHostReviewsInput = Readonly<{
	context: CapacityHostReviewContext;
	architect: unknown;
	critic: unknown;
	architectNote: string;
	criticNote: string;
	now: string;
}>;

export type VerifyCapacityHostReviewsInput = Readonly<{
	reviewRoot: string;
	context: CapacityHostReviewContext;
	now: string;
	read?: (absolutePath: string) => Buffer;
}>;

export type RunCapacityHostReviewCliDependencies = Readonly<{
	now?: () => string;
	read?: (absolutePath: string) => Buffer;
}>;

const SCHEMA = "g6-capacity-host-review/1" as const;
const MAX_REVIEW_JSON_BYTES = 64 * 1024;
const MAX_REVIEW_NOTE_BYTES = 1024 * 1024;

function fail(message: string): never {
	throw new Error(`g6-capacity-host-review: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...keys].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		fail(`${label} has missing or unknown fields`);
	}
}

function requireSha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
		fail(`${label} must be a SHA-256 digest`);
	}
	return value;
}

function requireText(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		fail(`${label} must be nonempty text`);
	}
	return value;
}

function requireMaxBytes(
	bytes: Buffer,
	maxBytes: number,
	label: string,
): Buffer {
	if (bytes.byteLength > maxBytes) {
		fail(`${label} is too large; limit is ${maxBytes} bytes`);
	}
	return bytes;
}

function decodeExactUtf8(bytes: Buffer, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		fail(`${label} must be valid UTF-8`);
	}
}

function millis(value: string, label: string): number {
	return Date.parse(validateRfc3339Millis(value, label));
}

function requireAbsoluteRoot(path: string, label: string): string {
	if (!isAbsolute(path)) fail(`${label} must be an absolute path`);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch {
		fail(`${label} does not exist: ${path}`);
	}
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		fail(`${label} must be a non-symlink directory`);
	}
	return realpathSync(path);
}

function ensureBelowRoot(
	root: string,
	absolutePath: string,
	label: string,
): string {
	const resolved = resolve(absolutePath);
	const below = relative(root, resolved);
	if (
		below === "" ||
		below === ".." ||
		below.startsWith(`..${sep}`) ||
		isAbsolute(below)
	) {
		fail(`${label} must remain below the review root`);
	}
	return resolved;
}

function ensureNoSymlinkPath(
	root: string,
	absolutePath: string,
	label: string,
): void {
	const rel = relative(root, absolutePath).split(sep);
	let current = root;
	for (const part of rel) {
		current = join(current, part);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(current);
		} catch {
			fail(`${label} does not exist: ${absolutePath}`);
		}
		if (stat.isSymbolicLink()) {
			fail(`${label} must not traverse a symlink`);
		}
	}
}

function strictReadAbsolute(
	root: string,
	absolutePath: string,
	maxBytes: number,
): Buffer {
	const resolved = ensureBelowRoot(root, absolutePath, "review file");
	ensureNoSymlinkPath(root, resolved, "review file");
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(resolved);
	} catch {
		fail(`review file does not exist: ${resolved}`);
	}
	if (!stat.isFile()) fail(`review file must be a regular file: ${resolved}`);
	if (stat.size > maxBytes) {
		fail(`review file is too large; limit is ${maxBytes} bytes`);
	}
	return readFileSync(resolved);
}

function readReviewFile(
	reviewRoot: string,
	relativePath: string,
	read: (absolutePath: string) => Buffer | undefined,
	maxBytes: number,
): Buffer {
	const absolutePath = ensureBelowRoot(
		reviewRoot,
		resolve(reviewRoot, relativePath),
		"review file",
	);
	ensureNoSymlinkPath(reviewRoot, absolutePath, "review file");
	const bytes = read(absolutePath);
	if (!Buffer.isBuffer(bytes)) {
		fail(`review file reader must return a Buffer for ${absolutePath}`);
	}
	return requireMaxBytes(bytes, maxBytes, "review file");
}

function validateContext(value: unknown): CapacityHostReviewContext {
	if (!isRecord(value)) fail("context must be an object");
	requireExactKeys(
		value,
		[
			"runId",
			"semanticFreezeAuthoritySha256",
			"hostBindingArtifactSha256",
			"dispatchFreezeArtifactSha256",
			"boundAt",
		],
		"context",
	);
	return {
		runId: requireText(value.runId, "context.runId"),
		semanticFreezeAuthoritySha256: requireSha256(
			value.semanticFreezeAuthoritySha256,
			"context.semanticFreezeAuthoritySha256",
		),
		hostBindingArtifactSha256: requireSha256(
			value.hostBindingArtifactSha256,
			"context.hostBindingArtifactSha256",
		),
		dispatchFreezeArtifactSha256: requireSha256(
			value.dispatchFreezeArtifactSha256,
			"context.dispatchFreezeArtifactSha256",
		),
		boundAt: validateRfc3339Millis(value.boundAt, "context.boundAt"),
	};
}

function validateReviewRecord(
	value: unknown,
	label: string,
	context: CapacityHostReviewContext,
	now: string,
	expectedRole: "architect" | "critic",
	architectSha256?: string,
): CapacityHostReviewRecord {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(
		value,
		[
			"schema",
			"context",
			"role",
			"verdict",
			"unconditional",
			"reviewedAt",
			"afterArchitectArtifactSha256",
			"reviewNoteSha256",
		],
		label,
	);
	if (value.schema !== SCHEMA) fail(`${label}.schema must be ${SCHEMA}`);
	const recordContext = validateContext(value.context);
	if (canonicalJson(recordContext) !== canonicalJson(context)) {
		fail(`${label}.context does not match the exact host-review context`);
	}
	if (value.verdict !== "APPROVE") fail(`${label}.verdict must be APPROVE`);
	if (value.unconditional !== true) fail(`${label}.unconditional must be true`);
	if (value.role !== expectedRole) {
		fail(`${label}.role must be ${expectedRole}`);
	}
	const reviewedAt = validateRfc3339Millis(
		value.reviewedAt,
		`${label}.reviewedAt`,
	);
	if (
		millis(reviewedAt, `${label}.reviewedAt`) <
		millis(context.boundAt, "context.boundAt")
	) {
		fail(`${label}.reviewedAt must not precede context.boundAt`);
	}
	if (millis(reviewedAt, `${label}.reviewedAt`) > millis(now, "now")) {
		fail(`${label}.reviewedAt must not be in the future`);
	}
	const reviewNoteSha256 = requireSha256(
		value.reviewNoteSha256,
		`${label}.reviewNoteSha256`,
	);
	let afterArchitectArtifactSha256: string | null;
	if (value.role === "architect") {
		if (value.afterArchitectArtifactSha256 !== null) {
			fail(`${label}.afterArchitectArtifactSha256 must be null for architect`);
		}
		afterArchitectArtifactSha256 = null;
	} else {
		if (architectSha256 === undefined) {
			fail("critic review requires the architect review artifact");
		}
		afterArchitectArtifactSha256 = requireSha256(
			value.afterArchitectArtifactSha256,
			`${label}.afterArchitectArtifactSha256`,
		);
		if (afterArchitectArtifactSha256 !== architectSha256) {
			fail(
				"critic review must chain after the exact architect review artifact",
			);
		}
	}
	return {
		schema: SCHEMA,
		context,
		role: expectedRole,
		verdict: "APPROVE",
		unconditional: true,
		reviewedAt,
		afterArchitectArtifactSha256,
		reviewNoteSha256,
	};
}

export function contextFromBound(
	verified: Omit<VerifiedBoundFreeze, "shellEnvironment">,
): CapacityHostReviewContext {
	return {
		runId: verified.runId,
		semanticFreezeAuthoritySha256: verified.semanticFreeze.authoritySha256,
		hostBindingArtifactSha256: canonicalArtifactSha256(verified.hostBinding),
		dispatchFreezeArtifactSha256: canonicalArtifactSha256(
			verified.dispatchFreeze,
		),
		boundAt: verified.dispatchFreeze.envelope.recordedAt,
	};
}

export function validateCapacityHostReviews(
	input: ValidateCapacityHostReviewsInput,
): CapacityHostReviews {
	const context = validateContext(input.context);
	const architectNoteSha256 = requireSha256(
		sha256Bytes(input.architectNote, "architectNote"),
		"architectNote hash",
	);
	const architect = validateReviewRecord(
		input.architect,
		"architect",
		context,
		input.now,
		"architect",
	);
	if (architect.reviewNoteSha256 !== architectNoteSha256) {
		fail("architect review note digest does not match the exact note bytes");
	}
	if (architect.afterArchitectArtifactSha256 !== null) {
		fail("architect review must not chain after another architect review");
	}
	const criticNoteSha256 = requireSha256(
		sha256Bytes(input.criticNote, "criticNote"),
		"criticNote hash",
	);
	const critic = validateReviewRecord(
		input.critic,
		"critic",
		context,
		input.now,
		"critic",
		canonicalArtifactSha256(architect),
	);
	if (critic.reviewNoteSha256 !== criticNoteSha256) {
		fail("critic review note digest does not match the exact note bytes");
	}
	if (
		millis(critic.reviewedAt, "critic.reviewedAt") <=
		millis(architect.reviewedAt, "architect.reviewedAt")
	) {
		fail("critic review must be strictly after the architect review");
	}
	return { context, architect, critic };
}

function sha256Bytes(text: string, label: string): string {
	const bytes = requireText(text, label);
	return createHash("sha256").update(bytes).digest("hex");
}

function parseReviewJson(bytes: Buffer, label: string): unknown {
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8")) as unknown;
	} catch (error) {
		fail(`${label} is not valid JSON: ${String(error)}`);
	}
	return value;
}

export function verifyCapacityHostReviews(
	input: VerifyCapacityHostReviewsInput,
): CapacityHostReviews {
	const reviewRoot = requireAbsoluteRoot(input.reviewRoot, "reviewRoot");
	const read =
		input.read ??
		((absolutePath: string) =>
			strictReadAbsolute(reviewRoot, absolutePath, MAX_REVIEW_JSON_BYTES));
	const architectJson = parseReviewJson(
		readReviewFile(reviewRoot, "architect.json", read, MAX_REVIEW_JSON_BYTES),
		"architect.json",
	);
	const criticJson = parseReviewJson(
		readReviewFile(reviewRoot, "critic.json", read, MAX_REVIEW_JSON_BYTES),
		"critic.json",
	);
	const architectNote = readReviewFile(
		reviewRoot,
		"architect.md",
		read,
		MAX_REVIEW_NOTE_BYTES,
	);
	const criticNote = readReviewFile(
		reviewRoot,
		"critic.md",
		read,
		MAX_REVIEW_NOTE_BYTES,
	);
	return validateCapacityHostReviews({
		context: input.context,
		architect: architectJson,
		critic: criticJson,
		architectNote: decodeExactUtf8(architectNote, "architect.md"),
		criticNote: decodeExactUtf8(criticNote, "critic.md"),
		now: input.now,
	});
}

export function runCapacityHostReviewCli(
	args: readonly string[],
	overrides: RunCapacityHostReviewCliDependencies = {},
): CapacityHostReviews {
	if (args[0] !== "verify") {
		fail(`mode must be verify; got ${args[0] ?? "<missing>"}`);
	}
	const values: Record<string, string> = {};
	for (let index = 1; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (
			(option !== "--bound-root" &&
				option !== "--review-root" &&
				option !== "--repository") ||
			!value ||
			value.startsWith("--")
		) {
			fail(`invalid verify option ${option ?? "<missing>"}`);
		}
		if (values[option]) fail(`verify option ${option} was repeated`);
		values[option] = value;
	}
	const boundRoot = values["--bound-root"];
	const reviewRoot = values["--review-root"];
	const repositoryPath = values["--repository"];
	if (!boundRoot) fail("required option --bound-root is missing");
	if (!reviewRoot) fail("required option --review-root is missing");
	if (!repositoryPath) fail("required option --repository is missing");
	const verified = verifyBoundFreeze(boundRoot, {
		repositoryPath,
		expectedStatus: "BOUND",
	});
	const result = verifyCapacityHostReviews({
		reviewRoot,
		context: contextFromBound(verified),
		now: overrides.now?.() ?? new Date().toISOString(),
		read: overrides.read,
	});
	return result;
}

if (import.meta.main) {
	try {
		runCapacityHostReviewCli(process.argv.slice(2));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exitCode = 1;
	}
}
