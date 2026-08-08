import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Reporter } from "@playwright/test/reporter";
import {
	findPrivacyViolations,
	sanitizeEvidenceDocument,
} from "./evidence-privacy.ts";

const interopDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(interopDir, "..", "..");

/**
 * Redacts the JSON reporter's output before it can become release evidence.
 * Playwright's JSON report embeds `rootDir`, `configFile`, `outputDir`, and the
 * web server `cwd` as absolute host paths, none of which are publishable.
 *
 * `onExit` runs after every other reporter has finished writing, so the file is
 * complete by the time it is rewritten. The verifier stays the backstop: if
 * anything survives redaction the run is failed rather than silently published.
 */
export default class EvidenceSanitizer implements Reporter {
	private readonly outputFile: string;

	constructor(options: { outputFile?: string } = {}) {
		const configured = options.outputFile ?? "interop-evidence.json";
		this.outputFile = isAbsolute(configured)
			? configured
			: resolve(interopDir, configured);
	}

	async onExit(): Promise<void> {
		if (!existsSync(this.outputFile)) return;
		const sanitized = sanitizeEvidenceDocument(
			JSON.parse(readFileSync(this.outputFile, "utf8")),
			repoRoot,
		);
		writeFileSync(this.outputFile, `${JSON.stringify(sanitized, null, 2)}\n`);

		const violations = findPrivacyViolations(sanitized);
		if (violations.length === 0) return;
		console.error(
			`evidence sanitizer: ${violations.length} privacy violation(s) survived redaction: ${violations
				.slice(0, 5)
				.map((violation) => `${violation.pointer} (${violation.reason})`)
				.join("; ")}`,
		);
		process.exitCode = 1;
	}
}

/**
 * One-shot redaction for evidence produced before the reporter existed. The
 * repository root must be given explicitly when the file was generated from a
 * different checkout (a git worktree, another machine) than the current one.
 */
export function sanitizeEvidenceFile(path: string, root = repoRoot): number {
	const sanitized = sanitizeEvidenceDocument(
		JSON.parse(readFileSync(path, "utf8")),
		root,
	);
	writeFileSync(path, `${JSON.stringify(sanitized, null, 2)}\n`);
	return findPrivacyViolations(sanitized).length;
}

if (import.meta.main) {
	const argv = Bun.argv.slice(2);
	let root = repoRoot;
	const paths: string[] = [];
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--repo-root") {
			index += 1;
			root = argv[index] as string;
		} else paths.push(arg);
	}
	if (paths.length === 0) {
		console.error(
			"usage: bun run evidence-sanitizer.ts [--repo-root <path>] <json> [...]",
		);
		process.exit(2);
	}
	let remaining = 0;
	for (const path of paths) remaining += sanitizeEvidenceFile(path, root);
	console.log(`sanitized ${paths.length} file(s); ${remaining} violation(s)`);
	if (remaining > 0) process.exit(1);
}
