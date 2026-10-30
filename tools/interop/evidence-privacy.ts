/**
 * Whole-document privacy rules for release evidence.
 *
 * Evidence documents are published, so nothing host-identifying may survive in
 * them: no absolute filesystem paths, no home/temporary directories, and no
 * credential-shaped keys or values. The rules here are deliberately independent
 * of any particular document schema so that Playwright interop reports and the
 * functional-readiness record can share one walk.
 *
 * Diagnostics report a JSON pointer only. A rejected value is never echoed --
 * the whole point of the check is that the value must not be reproduced.
 */

import { gunzipSync } from "node:zlib";

/** Credential-shaped key names. Kept narrower than the interop environment
 * allowlist because structural report keys legitimately contain words such as
 * `path`, `user`, and `home`. */
const SECRET_KEY_PATTERN =
	/(token|api[_-]?key|secret|password|passwd|passphrase|credential|private[_-]?key|access[_-]?key|session[_-]?key|bearer|cookie|ssh|auth[_-]?sock)/i;

/** Environment keys are held to a stricter standard: anything resembling
 * inherited shell state is rejected outright. */
export const ENV_SECRET_KEY_PATTERN =
	/(token|api[_-]?key|secret|password|passwd|credential|auth|ssh|home|path|shell|user|codex|vscode|brew|java|gopath|goroot|tmpdir|pwd|oldpwd|socket)/i;

const SECRET_VALUE_PATTERN =
	/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----)|(?:^|\b)(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:\b|$)/;

/** Absolute POSIX path, Windows drive path, or UNC share at the start of a
 * value. */
export const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** Host-identifying path fragments anywhere inside a value, which catches
 * command strings and messages that embed a path rather than being one. */
const HOST_PATH_ANYWHERE_PATTERN =
	/(?:\/(?:Users|home|private|tmp|Volumes|root)\/|\/var\/folders\/|(?:^|[\s"'=(;,])[A-Za-z]:[\\/]|\\\\[^\\/\s]+\\|%USERPROFILE%|%TEMP%|\$HOME\b|\$TMPDIR\b|(?:^|\s)~\/)/i;

/** Any embedded multi-segment absolute POSIX path, regardless of its root.
 * The named-root list above documents the common cases, but a self-hosted or
 * containerized runner rooted at /opt, /srv, /builds, /workspace, … must not
 * slip through just because its root is not enumerated. URL paths do not match:
 * the character before a scheme's `//` is `:`, which is deliberately absent
 * from the prefix class. Single-segment values (`/`, `/cert-hash`) stay legal
 * for the public-value allowlist. */
const EMBEDDED_ABSOLUTE_PATH_PATTERN =
	/(?:^|[\s"'=(;,])\/(?:[A-Za-z0-9._+-]+\/)+[A-Za-z0-9._+-]+/;

/**
 * Genuinely public protocol values that are path-shaped. Kept as exact strings
 * so the exemption cannot widen into a subtree escape hatch.
 */
const PUBLIC_VALUE_ALLOWLIST: ReadonlySet<string> = new Set([
	"/",
	"/cert-hash",
	"/close-events",
	"/execution-identity",
]);

export const REDACTED_VALUE = "[redacted-host-path]";
export const REPO_ROOT_PLACEHOLDER = "<repo>";

export interface PrivacyViolation {
	/** RFC 6901 pointer to the offending location. Never carries a value. */
	readonly pointer: string;
	readonly reason: string;
}

function escapePointerToken(token: string): string {
	return token.replaceAll("~", "~0").replaceAll("/", "~1");
}

function isSecretKey(key: string): boolean {
	return SECRET_KEY_PATTERN.test(key);
}

/** Why a string is unsafe to publish, or `undefined` when it is safe. */
export function unsafeStringReason(value: string): string | undefined {
	if (PUBLIC_VALUE_ALLOWLIST.has(value)) return undefined;
	if (SECRET_VALUE_PATTERN.test(value)) return "credential-shaped value";
	if (ABSOLUTE_PATH_PATTERN.test(value)) return "absolute host path";
	if (HOST_PATH_ANYWHERE_PATTERN.test(value))
		return "home or temporary directory path";
	if (EMBEDDED_ABSOLUTE_PATH_PATTERN.test(value))
		return "embedded absolute path";
	return undefined;
}

/**
 * Walk the entire document and collect every privacy violation, in document
 * order. Objects, arrays, and every nesting depth are covered; there is no
 * schema knowledge here at all.
 */
export function findPrivacyViolations(document: unknown): PrivacyViolation[] {
	const violations: PrivacyViolation[] = [];

	const visit = (node: unknown, pointer: string): void => {
		if (typeof node === "string") {
			const reason = unsafeStringReason(node);
			if (reason) violations.push({ pointer: pointer || "/", reason });
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((entry, index) => {
				visit(entry, `${pointer}/${index}`);
			});
			return;
		}
		if (node === null || typeof node !== "object") return;
		for (const [key, entry] of Object.entries(node)) {
			// A path-shaped key would leak the host through the pointer itself,
			// so it is reported against the parent with the key withheld.
			const keyPathReason = unsafeStringReason(key);
			if (keyPathReason) {
				violations.push({
					pointer: `${pointer || "/"} (property name)`,
					reason: `property name is a ${keyPathReason}`,
				});
				continue;
			}
			const childPointer = `${pointer}/${escapePointerToken(key)}`;
			if (isSecretKey(key)) {
				violations.push({
					pointer: childPointer,
					reason: "credential-shaped property name",
				});
				continue;
			}
			visit(entry, childPointer);
		}
	};

	visit(document, "");
	return violations;
}

function sanitizeString(value: string, repoRoot: string): string {
	// Reroot unconditionally: gating the replacement on the value first being
	// classified unsafe meant a repo path under an unrecognized root (/opt,
	// /srv, …) was published verbatim. Rerooting a safe value is a no-op —
	// an absolute repoRoot cannot occur inside a value that classified safe.
	const rerooted =
		repoRoot.length > 0
			? value.replaceAll(repoRoot, REPO_ROOT_PLACEHOLDER)
			: value;
	if (unsafeStringReason(rerooted) === undefined) return rerooted;
	return REDACTED_VALUE;
}

/**
 * Produce a publishable copy of a document: paths under `repoRoot` become
 * `<repo>`-relative, anything else host-identifying is replaced with a fixed
 * marker, and credential-shaped properties are dropped entirely.
 *
 * This is the primary redactor. `findPrivacyViolations` is the backstop that
 * proves it did its job. The result is deliberately `unknown`: dropping keys
 * means the output does not satisfy the input's type.
 */
export function sanitizeEvidenceDocument(
	document: unknown,
	repoRoot = "",
): unknown {
	const normalizedRoot = repoRoot.replace(/[/\\]+$/, "");

	const visit = (node: unknown): unknown => {
		if (typeof node === "string") return sanitizeString(node, normalizedRoot);
		if (Array.isArray(node)) return node.map(visit);
		if (node === null || typeof node !== "object") return node;
		// Null prototype: assigning a JSON-sourced "__proto__" member through a
		// plain object literal hits the prototype setter and silently drops the
		// entry instead of copying it.
		const result: Record<string, unknown> = Object.create(null);
		for (const [key, entry] of Object.entries(node)) {
			if (isSecretKey(key) || unsafeStringReason(key) !== undefined) continue;
			result[key] = visit(entry);
		}
		return result;
	};

	return visit(document);
}

/**
 * Uppercase environment-variable-shaped name (`HOME`, `GITHUB_TOKEN`, …).
 */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** `KEY=value` or `export KEY=value` at the start of a log line. */
const ENV_ASSIGNMENT_PATTERN =
	/^\s*(?:export\s+|declare\s+-x\s+|set\s+)?([A-Z][A-Z0-9_]*)=/;

/**
 * Variables that identify the host, the operator, or the CI runner even when
 * their value looks harmless. Matched as whole names or `PREFIX_*` families.
 */
const HOST_IDENTITY_ENV_PATTERN =
	/^(?:HOSTNAME|HOST|COMPUTERNAME|USER|USERNAME|LOGNAME|USERDOMAIN|USERPROFILE|HOME|HOMEPATH|HOMEDRIVE|PATH|PWD|OLDPWD|SHELL|TMPDIR|TEMP|TMP|LANG|TERM|DISPLAY|MAIL|XDG_[A-Z0-9_]+|RUNNER_[A-Z0-9_]+|GITHUB_[A-Z0-9_]+|ACTIONS_[A-Z0-9_]+|ImageOS|ImageVersion|AGENT_[A-Z0-9_]+|BUILD_[A-Z0-9_]+|SYSTEM_[A-Z0-9_]+|CI_[A-Z0-9_]+|SSH_[A-Z0-9_]+|AWS_[A-Z0-9_]+|AZURE_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|NPM_CONFIG_[A-Z0-9_]+|LOKALISE_[A-Z0-9_]+)$/;

/**
 * Environment-shaped names that may legitimately appear in published evidence:
 * the documented interop/runtime knobs. Everything else that looks like an
 * environment variable counts toward the structural env-dump rule.
 */
const PUBLISHABLE_ENV_NAME_PATTERN =
	/^(?:WT_[A-Z0-9_]+|WEBTRANSPORT_[A-Z0-9_]+|SOAK_[A-Z0-9_]+|LOAD_SCALE_[A-Z0-9_]+|FUZZ_SMOKE_[A-Z0-9_]+)$/;

/** An object or log with this many non-publishable environment-shaped names
 * is an environment dump, whatever the names are. */
const ENV_DUMP_STRUCTURE_THRESHOLD = 3;

function envNameReason(name: string): string | undefined {
	if (PUBLISHABLE_ENV_NAME_PATTERN.test(name)) return undefined;
	if (HOST_IDENTITY_ENV_PATTERN.test(name)) return "environment dump";
	if (ENV_NAME_PATTERN.test(name) && ENV_SECRET_KEY_PATTERN.test(name))
		return "environment dump";
	return undefined;
}

/** Why a free-text line is unsafe to publish, or `undefined` when it is safe.
 *
 * Unlike `unsafeStringReason`, a line is not treated as a single value: a log
 * line that merely starts with `/` (a comment, a rate such as `/s`) is fine;
 * only an embedded multi-segment absolute path, a home/temp directory
 * reference, a credential-shaped value, or a host-identifying environment
 * assignment is refused. */
export function unsafeTextLineReason(line: string): string | undefined {
	if (SECRET_VALUE_PATTERN.test(line)) return "credential-shaped value";
	const assignment = ENV_ASSIGNMENT_PATTERN.exec(line)?.[1];
	if (assignment && envNameReason(assignment)) return "environment dump";
	if (HOST_PATH_ANYWHERE_PATTERN.test(line))
		return "home or temporary directory path";
	if (EMBEDDED_ABSOLUTE_PATH_PATTERN.test(line))
		return "embedded absolute path";
	return undefined;
}

export interface TextPrivacyViolation {
	/** 1-based line number. Never carries the line itself. */
	readonly line: number;
	readonly reason: string;
}

/** Scan free text (logs, CSV, Markdown) line by line, plus the structural
 * env-dump rule across the whole text. */
export function findTextPrivacyViolations(
	text: string,
): TextPrivacyViolation[] {
	const violations: TextPrivacyViolation[] = [];
	const envLines: number[] = [];
	text.split(/\r?\n/).forEach((line, index) => {
		const reason = unsafeTextLineReason(line);
		if (reason) violations.push({ line: index + 1, reason });
		const assignment = ENV_ASSIGNMENT_PATTERN.exec(line)?.[1];
		if (assignment && !PUBLISHABLE_ENV_NAME_PATTERN.test(assignment))
			envLines.push(index + 1);
	});
	if (envLines.length >= ENV_DUMP_STRUCTURE_THRESHOLD) {
		violations.push({
			line: envLines[0] as number,
			reason: "environment dump",
		});
	}
	return violations;
}

/**
 * Environment dumps inside a JSON document, by name and by structure:
 * any member named like a host-identifying or credential-bearing variable
 * (`HOME`, `RUNNER_NAME`, `GITHUB_TOKEN`, …), and any object carrying several
 * environment-shaped names that are not documented runtime knobs.
 */
export function findEnvironmentDumpViolations(
	document: unknown,
): PrivacyViolation[] {
	const violations: PrivacyViolation[] = [];
	const visit = (node: unknown, pointer: string): void => {
		if (Array.isArray(node)) {
			node.forEach((entry, index) => {
				visit(entry, `${pointer}/${index}`);
			});
			return;
		}
		if (node === null || typeof node !== "object") return;
		let envShaped = 0;
		for (const [key, entry] of Object.entries(node)) {
			const childPointer = `${pointer}/${escapePointerToken(key)}`;
			if (
				(ENV_NAME_PATTERN.test(key) && key.includes("_")) ||
				HOST_IDENTITY_ENV_PATTERN.test(key)
			) {
				if (!PUBLISHABLE_ENV_NAME_PATTERN.test(key)) envShaped += 1;
			}
			if (envNameReason(key)) {
				violations.push({ pointer: childPointer, reason: "environment dump" });
				continue;
			}
			visit(entry, childPointer);
		}
		if (envShaped >= ENV_DUMP_STRUCTURE_THRESHOLD)
			violations.push({ pointer: pointer || "/", reason: "environment dump" });
	};
	visit(document, "");
	return violations;
}

/**
 * Literal identifiers (an operator's login, a machine's hostname) that must
 * not appear anywhere in published text. Matching is case-insensitive and on
 * word boundaries so a short login does not match inside unrelated words.
 */
export function containsForbiddenLiteral(
	text: string,
	literals: readonly string[],
): boolean {
	for (const literal of literals) {
		if (literal.length < 3) continue;
		const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (
			new RegExp(`(?:^|[^A-Za-z0-9])${escaped}(?:$|[^A-Za-z0-9])`, "i").test(
				text,
			)
		)
			return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Encoded payloads. A token or an environment dump does not stop being a leak
// because it was base64-, hex-, or percent-encoded, or gzipped and then
// encoded. Every encoded-looking run above a size threshold is decoded and
// the result is scanned again with the same rules, recursively but bounded.

/** Shortest encoded run that is decoded and rescanned. */
export const ENCODED_PAYLOAD_MIN_LENGTH = 16;
const MAX_DECODE_DEPTH = 4;
const MAX_DECODED_BYTES = 1024 * 1024;

const BASE64_RUN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const HEX_RUN = /(?:[0-9A-Fa-f]{2}){8,}/g;

function isGzip(bytes: Uint8Array): boolean {
	return bytes.length >= 18 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Text worth rescanning: valid UTF-8 and overwhelmingly printable. Random
 * bytes (hashes, certificate fingerprints, nonces) decode to neither. */
function printableText(bytes: Uint8Array): string | undefined {
	if (bytes.length === 0) return undefined;
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return undefined;
	}
	let printable = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code === 9 || code === 10 || code === 13 || code >= 32) printable += 1;
	}
	return printable / [...text].length >= 0.9 ? text : undefined;
}

function decodeBase64(run: string): Uint8Array | undefined {
	const normalized = run
		.replaceAll("-", "+")
		.replaceAll("_", "/")
		.replace(/=+$/, "");
	if (normalized.length % 4 === 1) return undefined;
	try {
		return new Uint8Array(Buffer.from(normalized, "base64"));
	} catch {
		return undefined;
	}
}

/** Marker for compressed content that could not be fully inflated within
 * the bound; it cannot be proven clean, so it is refused. */
const UNSCANNABLE = "\u0000unscannable-compressed-payload";

function gunzipBounded(bytes: Uint8Array): Uint8Array | undefined {
	try {
		return new Uint8Array(
			gunzipSync(bytes, { maxOutputLength: MAX_DECODED_BYTES }),
		);
	} catch {
		return undefined;
	}
}

/** Decoded payloads embedded in `text` that deserve a rescan. */
function decodedCandidates(text: string): string[] {
	const out: string[] = [];
	const consider = (bytes: Uint8Array | undefined) => {
		if (!bytes || bytes.length === 0) return;
		let raw: Uint8Array | undefined = bytes;
		if (isGzip(bytes) && bytes[2] === 0x08) {
			raw = gunzipBounded(bytes);
			if (!raw) {
				out.push(UNSCANNABLE);
				return;
			}
		}
		const decoded = printableText(raw);
		if (decoded !== undefined) out.push(decoded);
	};
	for (const match of text.matchAll(BASE64_RUN)) {
		consider(decodeBase64(match[0]));
	}
	for (const match of text.matchAll(HEX_RUN)) {
		consider(new Uint8Array(Buffer.from(match[0], "hex")));
	}
	for (const token of text.split(/\s+/)) {
		if (token.length < ENCODED_PAYLOAD_MIN_LENGTH) continue;
		if (!/%[0-9A-Fa-f]{2}/.test(token)) continue;
		try {
			const decoded = decodeURIComponent(token.replaceAll("+", " "));
			if (decoded !== token) out.push(decoded);
		} catch {
			// malformed escapes: nothing decodable to rescan
		}
	}
	return out;
}

function decodedTextReason(
	text: string,
	forbiddenLiterals: readonly string[],
): string | undefined {
	if (text === UNSCANNABLE) return "compressed content that cannot be scanned";
	if (containsForbiddenLiteral(text, forbiddenLiterals))
		return "forbidden identifier";
	try {
		const document = JSON.parse(text) as unknown;
		if (document !== null && typeof document === "object") {
			const violation =
				findPrivacyViolations(document)[0] ??
				findEnvironmentDumpViolations(document)[0];
			if (violation) return violation.reason;
		}
	} catch {
		// not JSON; fall through to the line rules
	}
	return findTextPrivacyViolations(text)[0]?.reason;
}

/**
 * Why `text` hides an unsafe payload behind an encoding, or `undefined`.
 * Base64/base64url (optionally gzip inside), hex, and percent-encoding are
 * decoded and rescanned up to `MAX_DECODE_DEPTH` levels deep.
 */
export function encodedPayloadReason(
	text: string,
	forbiddenLiterals: readonly string[] = [],
	depth = 0,
): string | undefined {
	if (depth >= MAX_DECODE_DEPTH || text.length < ENCODED_PAYLOAD_MIN_LENGTH)
		return undefined;
	for (const decoded of decodedCandidates(text)) {
		const reason = decodedTextReason(decoded, forbiddenLiterals);
		if (reason) return `encoded payload hides ${reason}`;
		const nested = encodedPayloadReason(decoded, forbiddenLiterals, depth + 1);
		if (nested) return nested;
	}
	return undefined;
}

/** Every string (values and property names) in a JSON document whose encoded
 * content is unsafe. Diagnostics carry pointers only. */
export function findEncodedPayloadViolations(
	document: unknown,
	forbiddenLiterals: readonly string[] = [],
): PrivacyViolation[] {
	const violations: PrivacyViolation[] = [];
	const visit = (node: unknown, pointer: string): void => {
		if (typeof node === "string") {
			const reason = encodedPayloadReason(node, forbiddenLiterals);
			if (reason) violations.push({ pointer: pointer || "/", reason });
			return;
		}
		if (Array.isArray(node)) {
			node.forEach((entry, index) => {
				visit(entry, `${pointer}/${index}`);
			});
			return;
		}
		if (node === null || typeof node !== "object") return;
		for (const [key, entry] of Object.entries(node)) {
			const childPointer = `${pointer}/${escapePointerToken(key)}`;
			const keyReason = encodedPayloadReason(key, forbiddenLiterals);
			if (keyReason) {
				violations.push({
					pointer: `${pointer || "/"} (property name)`,
					reason: keyReason,
				});
				continue;
			}
			visit(entry, childPointer);
		}
	};
	visit(document, "");
	return violations;
}
