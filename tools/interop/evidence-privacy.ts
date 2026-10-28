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
