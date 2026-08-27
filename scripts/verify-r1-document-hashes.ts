/**
 * Task A maintenance tool (not part of the RED bundle): the missing producer
 * for the three governing-document digests.
 *
 * `R1_AUTHORITY_APPROVAL` and the three `R1_EXACT_APPROVAL_RECORDS` freeze
 * `parentPlanSha256`, `parentDesignSha256` and `amendmentSha256` as literal
 * hex. Unlike every other digest in the fixture these are **not** derived from
 * fixture bytes — they are the real on-disk sha256 of three markdown documents,
 * and `verify-r1-fixture-hashes.ts` never opens a file, so nothing in the tree
 * could tell you they had gone stale. Editing any of the three documents
 * therefore forced a hand-substituted digest at `R1_CAMPAIGN_AUTHORITY`, the
 * widest-fanout node in the DAG — the exact operation the campaign's risk 1
 * forbids. This script is that operation made mechanical: it hashes each
 * document from disk, finds every frozen site textually, and prints the
 * old→new pairs.
 *
 * It reports; it never writes. `converge-r1-fixture-hashes.ts` is the only
 * applier, and this script emits that driver's exact `--json` contract
 * (`{clean, mismatches, checks[{label,frozen,computed,ok}], structural[]}`) so
 * the driver can consume it unchanged:
 *
 *   for f in tools/compare/r1-fixtures.ts tools/compare/r1-authority-red.test.ts; do
 *     R1_DOCUMENT_HASHES_ONLY="$f" bun scripts/converge-r1-fixture-hashes.ts \
 *       --apply --verifier scripts/verify-r1-document-hashes.ts --fixture "$f"
 *   done
 *
 * The driver rewrites one file per run and spawns the verifier with no extra
 * arguments, so the scope is passed by environment: `R1_DOCUMENT_HASHES_ONLY`
 * (or `--only <source>` when running this script by hand) restricts the report
 * to one source. Unscoped, a driver run would realign the fixture's four sites
 * and then abort on the fifth, which lives in the frozen test it is not
 * rewriting. Run it once per source; the second run leaves the first alone.
 *
 * Site counts are **declared, not discovered**. A verifier that only checks
 * the sites it happens to find cannot notice a site that was deleted or
 * renamed, and would go green on a fixture that had quietly stopped carrying
 * the binding at all. A count that no longer matches is `structural`: no
 * substitution fixes it and a human must look.
 *
 * Scope is the two TypeScript files that carry live digests. The `.rs`
 * occurrences of these field names are schema key lists and `"f".repeat(64)`
 * placeholders, not document hashes.
 *
 * Exits 1 while any mismatch remains.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DocumentBinding {
	/** The frozen field name, as it is spelled at every site. */
	field: string;
	/** Repo-relative path of the document whose bytes the field pins. */
	document: string;
	/** Repo-relative source path -> the number of sites it must carry. */
	sites: Record<string, number>;
}

export const FIXTURES = "tools/compare/r1-fixtures.ts";
export const AUTHORITY_TEST = "tools/compare/r1-authority-red.test.ts";

/**
 * Four fixture sites each (`R1_AUTHORITY_APPROVAL` plus the architect, critic
 * and verifier approval records) and one assertion site inside the frozen
 * `r1-authority-red.test.ts`.
 */
export const DOCUMENT_BINDINGS: readonly DocumentBinding[] = Object.freeze([
	{
		field: "parentPlanSha256",
		document: "docs/superpowers/plans/2026-08-22-ws-wt-scenario-comparison.md",
		sites: { [FIXTURES]: 4, [AUTHORITY_TEST]: 1 },
	},
	{
		field: "parentDesignSha256",
		document:
			"docs/superpowers/specs/2026-08-22-ws-wt-scenario-comparison-design.md",
		sites: { [FIXTURES]: 4, [AUTHORITY_TEST]: 1 },
	},
	{
		field: "amendmentSha256",
		document:
			"docs/superpowers/plans/2026-08-24-ws-wt-r1-secure-filesystem-amendment.md",
		sites: { [FIXTURES]: 4, [AUTHORITY_TEST]: 1 },
	},
]);

export interface Check {
	label: string;
	frozen: string;
	computed: string;
	ok: boolean;
}

export interface Report {
	schema: "r1-document-hashes/1";
	clean: boolean;
	mismatches: number;
	checks: Check[];
	structural: string[];
}

export interface Site {
	field: string;
	line: number;
	digest: string;
}

/**
 * Matches both spellings a frozen digest is written in: the object-literal
 * `field:\n\t"<hex>"` of the fixture and the `record.field ===\n\t"<hex>"`
 * assertion of the frozen test. The value is routinely wrapped onto its own
 * line by the formatter, so the separator must tolerate newlines.
 */
const siteRegex = (fields: readonly string[]): RegExp =>
	new RegExp(
		`\\b(${fields.join("|")})\\b\\s*(?::|===)\\s*"([0-9a-f]{64})"`,
		"g",
	);

export const collectSites = (
	source: string,
	fields: readonly string[],
): Site[] => {
	if (fields.length === 0) return [];
	const sites: Site[] = [];
	for (const match of source.matchAll(siteRegex(fields))) {
		const digest = match[2] as string;
		// The line of the LITERAL, not of the field name: the formatter wraps
		// long values onto their own line, and the campaign's documents cite
		// these sites by the line the hex sits on.
		const at = match.index + match[0].lastIndexOf(digest);
		sites.push({
			field: match[1] as string,
			line: source.slice(0, at).split("\n").length,
			digest,
		});
	}
	return sites;
};

export interface ReportInput {
	/** Repo-relative document path -> its sha256, or null if unreadable. */
	documents: Map<string, string | null>;
	/** Repo-relative source path -> its text. */
	sources: Map<string, string>;
	/** Restrict the report to one source, for a scoped convergence run. */
	only?: string;
	bindings?: readonly DocumentBinding[];
}

export const buildReport = ({
	documents,
	sources,
	only,
	bindings = DOCUMENT_BINDINGS,
}: ReportInput): Report => {
	const checks: Check[] = [];
	const structural: string[] = [];

	const fieldsBySource = new Map<string, string[]>();
	for (const binding of bindings) {
		for (const source of Object.keys(binding.sites)) {
			if (only !== undefined && source !== only) continue;
			const fields = fieldsBySource.get(source) ?? [];
			fields.push(binding.field);
			fieldsBySource.set(source, fields);
		}
	}

	const sitesBySource = new Map<string, Site[]>();
	for (const [source, fields] of fieldsBySource) {
		const text = sources.get(source);
		if (text === undefined) {
			structural.push(`${source}: source not readable`);
			continue;
		}
		sitesBySource.set(source, collectSites(text, fields));
	}

	for (const binding of bindings) {
		const computed = documents.get(binding.document);
		if (computed === undefined || computed === null) {
			// Only surface a missing document if some in-scope source wants it;
			// a `--only` run must not fail on a binding it is not checking.
			const inScope = Object.keys(binding.sites).some(
				(source) => only === undefined || source === only,
			);
			if (inScope) {
				structural.push(
					`${binding.document}: document not readable, cannot produce ${binding.field}`,
				);
			}
			continue;
		}
		for (const [source, expected] of Object.entries(binding.sites)) {
			if (only !== undefined && source !== only) continue;
			const found = (sitesBySource.get(source) ?? []).filter(
				(site) => site.field === binding.field,
			);
			if (found.length !== expected) {
				structural.push(
					`${source}: found ${found.length} ${binding.field} site(s), expected ${expected}`,
				);
				continue;
			}
			for (const site of found) {
				checks.push({
					label: `${source}:${site.line} ${binding.field}`,
					frozen: site.digest,
					computed,
					ok: site.digest === computed,
				});
			}
		}
	}

	const mismatches =
		checks.filter((check) => !check.ok).length + structural.length;
	return {
		schema: "r1-document-hashes/1",
		clean: mismatches === 0,
		mismatches,
		checks,
		structural,
	};
};

export const sha256 = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const readOrNull = (path: string): Uint8Array | null => {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
};

export const ONLY_ENV = "R1_DOCUMENT_HASHES_ONLY";

export const resolveOnly = (
	argv: string[],
	env: Record<string, string | undefined>,
): { only?: string; error?: string } => {
	const index = argv.indexOf("--only");
	if (index === -1) {
		const fromEnv = env[ONLY_ENV];
		return fromEnv ? { only: fromEnv } : {};
	}
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) {
		return { error: "--only needs a source path" };
	}
	return { only: value };
};

export const runCli = (
	argv: string[],
	env: Record<string, string | undefined> = process.env,
): number => {
	const asJson = argv.includes("--json");
	const { only, error } = resolveOnly(argv, env);
	if (error !== undefined) {
		console.error(`verify-r1-document-hashes: ${error}`);
		return 1;
	}

	const documents = new Map<string, string | null>();
	const sources = new Map<string, string>();
	for (const binding of DOCUMENT_BINDINGS) {
		const bytes = readOrNull(join(ROOT, binding.document));
		documents.set(binding.document, bytes === null ? null : sha256(bytes));
		for (const source of Object.keys(binding.sites)) {
			if (sources.has(source)) continue;
			const text = readOrNull(join(ROOT, source));
			if (text !== null) sources.set(source, new TextDecoder().decode(text));
		}
	}

	const report = buildReport({ documents, sources, only });
	if (asJson) {
		console.log(JSON.stringify(report));
	} else {
		for (const entry of report.structural) console.log(`FIX ${entry}`);
		for (const check of report.checks) {
			if (!check.ok) {
				console.log(`FIX ${check.label}: ${check.frozen} -> ${check.computed}`);
			}
		}
		console.log(
			report.clean
				? "document hashes: CLEAN"
				: `${report.mismatches} mismatches`,
		);
	}
	return report.clean ? 0 : 1;
};

if (import.meta.main) {
	process.exit(runCli(process.argv.slice(2)));
}
