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

import { inflateRawSync, constants as zlibConstants } from "node:zlib";

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
	/(?:\/(?:Users|home|private|tmp|Volumes|root)\/|\/var\/folders\/|%USERPROFILE%|%TEMP%|\$HOME\b|\$TMPDIR\b|(?:^|\s)~\/)/i;

/** Where a path can begin: after anything that cannot itself be part of a
 * path (`cache:`, `x=`, `(`, a quote, a space, the start), except the
 * `<repo>` placeholder the scrubber reroots the checkout to. */
const PATH_BOUNDARY = String.raw`(?<![A-Za-z0-9._~+\-/\\])(?<!<repo>)`;

/** A Windows drive path (`C:\…`, `c:/…`) or a UNC share (`\\host\share`)
 * after any non-path boundary. A URI scheme cannot match: its letters are
 * preceded by more letters, and its `:` by a letter, never a boundary. */
const EMBEDDED_WINDOWS_PATH_PATTERN = new RegExp(
	String.raw`${PATH_BOUNDARY}(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])`,
);

/** `file:` URIs name host paths; every other scheme is a URL. */
const FILE_URI_PATTERN = /\bfile:\/\//i;

/** Any embedded multi-segment absolute POSIX path, regardless of its root,
 * after any non-path boundary (`cache:/opt/…`, `x=/opt/…`, `(/home/…`). The
 * named-root list above documents the common cases, but a self-hosted or
 * containerized runner rooted at /opt, /srv, /builds, /workspace, … must not
 * slip through just because its root is not enumerated. URL paths do not
 * match: a scheme's `//` has an empty first segment, and a URL path's `/`
 * follows its host, a path character. Single-segment values (`/`,
 * `/cert-hash`) stay legal for the public-value allowlist. */
const EMBEDDED_ABSOLUTE_PATH_PATTERN = new RegExp(
	String.raw`${PATH_BOUNDARY}\/(?:[^\s/\\"'<>|]+\/)+[^\s/\\"'<>|]+`,
);

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
	if (FILE_URI_PATTERN.test(value)) return "file URI (a host path)";
	if (EMBEDDED_WINDOWS_PATH_PATTERN.test(value))
		return "embedded Windows drive or UNC path";
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

/** An `NAME=value` assignment of a host-identity or secret-shaped variable
 * anywhere in a string (line starts, after spaces, separators or quotes), so
 * an environment dump folded into one string value is found too. */
const ENV_ASSIGNMENT_ANYWHERE_PATTERN =
	/(?:^|[\s;,&|"'`(])(?:export\s+|declare\s+-x\s+|set\s+)?([A-Z][A-Z0-9_]*)=/gm;

function envAssignmentReason(text: string): string | undefined {
	for (const match of text.matchAll(ENV_ASSIGNMENT_ANYWHERE_PATTERN))
		if (envNameReason(match[1] as string)) return "environment dump";
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
	if (envAssignmentReason(line)) return "environment dump";
	if (HOST_PATH_ANYWHERE_PATTERN.test(line))
		return "home or temporary directory path";
	if (FILE_URI_PATTERN.test(line)) return "file URI (a host path)";
	if (EMBEDDED_WINDOWS_PATH_PATTERN.test(line))
		return "embedded Windows drive or UNC path";
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
		if (typeof node === "string") {
			const reason = envAssignmentReason(node);
			if (reason) violations.push({ pointer: pointer || "/", reason });
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

/** Shortest encoded run (after joining whitespace-wrapped chunks) that is
 * decoded and rescanned. */
export const ENCODED_PAYLOAD_MIN_LENGTH = 16;
/** Decoding layers followed; anything still decodable below this is refused,
 * never accepted. */
export const MAX_DECODE_DEPTH = 4;
const MAX_DECODED_BYTES = 1024 * 1024;
/** Shortest printable run extracted from decoded bytes for rescanning. */
const MIN_PRINTABLE_RUN = 8;
/** A printable run this long is rescanned wherever it appears in decoded
 * noise; a shorter one only when it is at least half of what was decoded.
 * Decoding ordinary text (identifiers, symbol names) yields noise with
 * occasional short printable runs; those are not payloads, and rescanning
 * them would only produce false refusals. Inflated content is real data and
 * is always rescanned down to MIN_PRINTABLE_RUN. */
const FREE_STANDING_RUN = 24;

/** Base64/base64url text, possibly wrapped or chunked by whitespace. Hex is a
 * subset of this alphabet and gets its own pass. */
const BASE64_GROUP = /[A-Za-z0-9+/_=-]+(?:\s+[A-Za-z0-9+/_=-]+)*/g;
/** Chunks split by any run of other characters (`TE9L!QUxJ`, `TE9L!!QUxJ`,
 * `TE9L.,:QUxJ`, `TE9L - - QUxJ`): permissive decoders such as
 * Buffer.from(…, "base64") skip every non-alphabet character, so the scanner
 * rejoins the chunks the same way, however many separators lie between. */
const BASE64_PUNCTUATED_GROUP =
	/[A-Za-z0-9+/_=-]+(?:[^A-Za-z0-9+/_=-]+[A-Za-z0-9+/_=-]+)+/g;
const HEX_GROUP = /[0-9A-Fa-f]+(?:\s+[0-9A-Fa-f]+)*/g;

/** Archive and compression formats that are not inflated here: finding one
 * inside an encoded payload means the payload cannot be proven clean. */
const OPAQUE_MAGICS: readonly (readonly number[])[] = [
	[0x50, 0x4b, 0x03, 0x04], // zip
	[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00], // xz
	[0x28, 0xb5, 0x2f, 0xfd], // zstd
	[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
	[0x31, 0x41, 0x59, 0x26, 0x53, 0x59], // bzip2 block
];

function indexOfBytes(
	haystack: Uint8Array,
	needle: readonly number[],
	from = 0,
): number {
	outer: for (let i = from; i + needle.length <= haystack.length; i += 1) {
		for (let j = 0; j < needle.length; j += 1)
			if (haystack[i + j] !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

/** Printable ASCII runs (with tab/newline) inside arbitrary bytes, like
 * `strings`: the plaintext of an aligned encoded payload survives intact even
 * when the bytes around it are noise from neighbouring text. */
function printableRuns(bytes: Uint8Array, fromNoise = true): string[] {
	const runs: string[] = [];
	let start = -1;
	const flush = (end: number) => {
		const length = end - start;
		if (
			start >= 0 &&
			length >= MIN_PRINTABLE_RUN &&
			(!fromNoise || length >= FREE_STANDING_RUN || length * 2 >= bytes.length)
		)
			runs.push(Buffer.from(bytes.subarray(start, end)).toString("latin1"));
		start = -1;
	};
	for (let i = 0; i < bytes.length; i += 1) {
		const b = bytes[i] as number;
		const printable =
			(b >= 0x20 && b <= 0x7e) || b === 9 || b === 10 || b === 13;
		if (printable) {
			if (start < 0) start = i;
		} else flush(i);
	}
	flush(bytes.length);
	return runs;
}

/** Inflate a gzip member starting at `offset`, ignoring what follows it.
 * `undefined` when the bytes are not a deflate stream (random data that
 * happens to contain the gzip magic); a truncated stream yields what it
 * inflates to; output beyond the bound throws. */
function inflateGzipAt(
	bytes: Uint8Array,
	offset: number,
): Uint8Array | undefined {
	const flags = bytes[offset + 3] as number;
	if ((flags & 0xe0) !== 0) return undefined;
	let cursor = offset + 10;
	if (flags & 0x04) {
		const extra =
			(bytes[cursor] as number) | ((bytes[cursor + 1] as number) << 8);
		cursor += 2 + extra;
	}
	if (flags & 0x08) while (cursor < bytes.length && bytes[cursor++] !== 0) {}
	if (flags & 0x10) while (cursor < bytes.length && bytes[cursor++] !== 0) {}
	if (flags & 0x02) cursor += 2;
	if (cursor >= bytes.length) return undefined;
	try {
		return new Uint8Array(
			inflateRawSync(bytes.subarray(cursor), {
				finishFlush: zlibConstants.Z_SYNC_FLUSH,
				maxOutputLength: MAX_DECODED_BYTES,
			}),
		);
	} catch (error) {
		if (
			error instanceof RangeError ||
			(error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE"
		)
			throw new CompressedTooLarge();
		return undefined;
	}
}

class CompressedTooLarge extends Error {}

function containsGzip(bytes: Uint8Array): boolean {
	for (
		let at = indexOfBytes(bytes, [0x1f, 0x8b, 0x08]);
		at >= 0;
		at = indexOfBytes(bytes, [0x1f, 0x8b, 0x08], at + 1)
	) {
		try {
			const inflated = inflateGzipAt(bytes, at);
			if (inflated && inflated.length > 0) return true;
		} catch {
			return true;
		}
	}
	return false;
}

type Probe = { forbiddenLiterals: readonly string[]; depth: number };

/** Inspect decoded bytes: compressed streams are inflated and inspected,
 * opaque archives are refused, printable runs are rescanned as text. */
function inspectDecodedBytes(
	bytes: Uint8Array,
	probe: Probe,
	fromNoise = true,
): string | undefined {
	if (bytes.length === 0) return undefined;
	for (const magic of OPAQUE_MAGICS)
		if (indexOfBytes(bytes, magic) >= 0)
			return "an archive that cannot be scanned";
	for (
		let at = indexOfBytes(bytes, [0x1f, 0x8b, 0x08]);
		at >= 0;
		at = indexOfBytes(bytes, [0x1f, 0x8b, 0x08], at + 1)
	) {
		let inflated: Uint8Array | undefined;
		try {
			inflated = inflateGzipAt(bytes, at);
		} catch {
			return "compressed content too large to scan";
		}
		if (!inflated || inflated.length === 0) continue;
		if (probe.depth + 1 >= MAX_DECODE_DEPTH)
			return "encoded content nested too deep to scan";
		const reason = inspectDecodedBytes(
			inflated,
			{ ...probe, depth: probe.depth + 1 },
			false,
		);
		if (reason) return reason;
	}
	for (const run of printableRuns(bytes, fromNoise)) {
		const reason = decodedTextReason(run, probe.forbiddenLiterals);
		if (reason) return reason;
		const nested = encodedReason(run, { ...probe, depth: probe.depth + 1 });
		if (nested) return nested;
	}
	return undefined;
}

function base64Candidates(text: string): Uint8Array[] {
	const out: Uint8Array[] = [];
	const groups = [
		...[...text.matchAll(BASE64_GROUP)].map((m) => m[0]),
		...[...text.matchAll(BASE64_PUNCTUATED_GROUP)].map((m) =>
			m[0].replace(/[^A-Za-z0-9+/_=-]/g, " "),
		),
	];
	for (const group of groups) {
		const match = [group] as const;
		const compact = match[0].replace(/\s+/g, "");
		if (compact.length < ENCODED_PAYLOAD_MIN_LENGTH) continue;
		// The whole group (wrapped or chunked encodings, rejoined) and each
		// whitespace-separated token on its own (an encoding next to words).
		const tokens = match[0]
			.split(/\s+/)
			.filter((token) => token.length >= ENCODED_PAYLOAD_MIN_LENGTH);
		const pieces =
			tokens.length > 1 || tokens[0] !== compact
				? [compact, ...tokens]
				: [compact];
		for (const segment of pieces.flatMap((piece) => piece.split(/=+/))) {
			if (segment.length < MIN_PRINTABLE_RUN) continue;
			const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
			// Every alignment: the payload need not start where the group does.
			for (let offset = 0; offset < 4; offset += 1) {
				const aligned = normalized.slice(offset);
				const usable = aligned.slice(0, aligned.length - (aligned.length % 4));
				if (usable.length >= 8)
					out.push(new Uint8Array(Buffer.from(usable, "base64")));
			}
		}
	}
	return out;
}

function hexCandidates(text: string): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (const match of text.matchAll(HEX_GROUP)) {
		const compact = match[0].replace(/\s+/g, "");
		if (compact.length < ENCODED_PAYLOAD_MIN_LENGTH) continue;
		for (let offset = 0; offset < 2; offset += 1) {
			const aligned = compact.slice(offset);
			out.push(
				new Uint8Array(
					Buffer.from(
						aligned.slice(0, aligned.length - (aligned.length % 2)),
						"hex",
					),
				),
			);
		}
	}
	return out;
}

function percentCandidates(text: string): string[] {
	if (!/%[0-9A-Fa-f]{2}/.test(text)) return [];
	const decode = (value: string) =>
		value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		);
	return [decode(text), decode(text.replace(/\s+/g, ""))];
}

function encodedReason(text: string, probe: Probe): string | undefined {
	if (text.length < ENCODED_PAYLOAD_MIN_LENGTH) return undefined;
	// Escaped line breaks wrap encodings just like real ones.
	const normalized = text.replace(/\\[nrt]/g, " ");
	const binary = [
		...base64Candidates(normalized),
		...hexCandidates(normalized),
	];
	const textual = percentCandidates(normalized);
	if (probe.depth >= MAX_DECODE_DEPTH) {
		// Fail closed: anything still decoding to readable or compressed
		// content at the depth limit is refused, not waved through.
		const decodable =
			binary.some(
				(bytes) => printableRuns(bytes).length > 0 || containsGzip(bytes),
			) || textual.some((decoded) => decoded !== normalized);
		return decodable ? "encoded content nested too deep to scan" : undefined;
	}
	for (const bytes of binary) {
		const reason = inspectDecodedBytes(bytes, probe);
		if (reason) return reason;
	}
	for (const decoded of textual) {
		if (decoded === normalized) continue;
		const reason = decodedTextReason(decoded, probe.forbiddenLiterals);
		if (reason) return reason;
		const nested = encodedReason(decoded, { ...probe, depth: probe.depth + 1 });
		if (nested) return nested;
	}
	return undefined;
}

function decodedTextReason(
	text: string,
	forbiddenLiterals: readonly string[],
): string | undefined {
	if (containsForbiddenLiteral(text, forbiddenLiterals))
		return "forbidden identifier";
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const document = JSON.parse(trimmed) as unknown;
			if (document !== null && typeof document === "object") {
				const violation =
					findPrivacyViolations(document)[0] ??
					findEnvironmentDumpViolations(document)[0];
				if (violation) return violation.reason;
			}
		} catch {
			// not JSON; fall through to the line rules
		}
	}
	return findTextPrivacyViolations(text)[0]?.reason;
}

/**
 * Why `text` hides an unsafe payload behind an encoding, or `undefined`.
 * Base64/base64url (whitespace-wrapped or chunked, any alignment), hex,
 * percent-encoding, and gzip found inside them are decoded and rescanned up
 * to `MAX_DECODE_DEPTH` layers; deeper nesting and opaque archives are
 * refused.
 */
export function encodedPayloadReason(
	text: string,
	forbiddenLiterals: readonly string[] = [],
): string | undefined {
	const reason = encodedReason(text, { forbiddenLiterals, depth: 0 });
	return reason ? `encoded payload hides ${reason}` : undefined;
}

/** Every string (values and property names) in a JSON document whose encoded
 * content is unsafe, plus all strings joined (an encoding can be split across
 * array elements or fields). Diagnostics carry pointers only. */
export function findEncodedPayloadViolations(
	document: unknown,
	forbiddenLiterals: readonly string[] = [],
): PrivacyViolation[] {
	const violations: PrivacyViolation[] = [];
	const strings: string[] = [];
	const visit = (node: unknown, pointer: string): void => {
		if (typeof node === "string") {
			strings.push(node);
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
			strings.push(key);
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
	if (violations.length === 0) {
		const joined = encodedPayloadReason(strings.join("\n"), forbiddenLiterals);
		if (joined)
			violations.push({ pointer: "/ (strings joined)", reason: joined });
	}
	return violations;
}

/**
 * Playwright's JSON report records `config.metadata` (and each project's
 * copy): on CI that includes `gitCommit` (author and committer names and
 * e-mail addresses, the commit subject and body) and `ci` links. None of it
 * is evidence and the author identity is personal data, so a report keeps
 * only `actualWorkers` there. Applied at the generation boundary
 * (evidence-sanitizer.ts); the release evidence content schema refuses
 * anything else.
 */
export function pruneReportMetadata(document: unknown): unknown {
	if (document === null || typeof document !== "object") return document;
	const config = (document as { config?: unknown }).config;
	if (config === null || typeof config !== "object") return document;
	const prune = (holder: Record<string, unknown>) => {
		const metadata = holder.metadata;
		if (metadata === null || typeof metadata !== "object") return;
		const workers = (metadata as { actualWorkers?: unknown }).actualWorkers;
		holder.metadata =
			typeof workers === "number" ? { actualWorkers: workers } : {};
	};
	prune(config as Record<string, unknown>);
	const projects = (config as { projects?: unknown }).projects;
	if (Array.isArray(projects))
		for (const project of projects)
			if (project !== null && typeof project === "object")
				prune(project as Record<string, unknown>);
	return document;
}
