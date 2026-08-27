/**
 * Drives the R1 fixture digest-convergence loop to a fixed point.
 *
 * `verify-r1-fixture-hashes.ts` walks the fixture's interlocking digest DAG
 * (authority -> capability -> lock -> attestation -> descriptors -> manifest
 * -> bundle expectations) and reports every stale literal as an old -> new
 * hex pair. Realigning one layer dirties the next, so a RED cycle has
 * historically meant 6-14 hand passes of sed over a 5,761-line fixture. This
 * driver runs that loop mechanically: verify, apply, verify, until the
 * verifier says CLEAN or a guard fires.
 *
 * Risk-1 of the campaign is "never hand-substitute a digest". This is that
 * rule mechanised: the driver never computes, derives, or invents a digest of
 * its own. Every value it writes is a `computed` field the verifier produced
 * from the fixture's own bytes, copied verbatim. If the verifier reports a
 * mismatch the driver cannot explain as a whole-token digest substitution, it
 * refuses to touch the file at all rather than half-applying.
 *
 * Dry-run is the DEFAULT and `--apply` is required to write. The argument:
 * this tool exists to edit a frozen artifact mid-freeze. Convergence is
 * always a deliberate act inside a RED cycle, so the cost of the extra word
 * is one word per cycle; the cost of an unintended apply -- a stray
 * invocation, a gauntlet step wired up wrong, a shell-history recall on the
 * wrong branch -- is a silently rewritten frozen fixture that still passes
 * its own verifier. Defaults should fail toward "nothing happened".
 *
 * Exit codes (each distinct, for a gauntlet to consume):
 *   0  fixture is CLEAN (converged, or already clean -- the idempotent case)
 *   2  dry-run: replacements are pending, nothing was written
 *   3  iteration cap exceeded without converging
 *   4  oscillation: a fixture state repeated, the DAG is not converging
 *   5  ambiguous replacement: refused (missing, conflicting, or clobbering)
 *   6  unfixable mismatch: structural or non-digest, a human must look
 *   7  the verifier could not be run or its output could not be parsed
 *
 * Usage:
 *   bun scripts/converge-r1-fixture-hashes.ts            # dry-run
 *   bun scripts/converge-r1-fixture-hashes.ts --apply
 *   bun scripts/converge-r1-fixture-hashes.ts --apply --max-iterations 40
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXIT = {
	CLEAN: 0,
	DRY_RUN_PENDING: 2,
	CAP_EXCEEDED: 3,
	OSCILLATION: 4,
	AMBIGUOUS: 5,
	UNFIXABLE: 6,
	VERIFIER_ERROR: 7,
} as const;

export interface VerifierCheck {
	label: string;
	frozen: string;
	computed: string;
	ok: boolean;
}

export interface VerifierReport {
	clean: boolean;
	mismatches: number;
	checks: VerifierCheck[];
	structural: string[];
}

export interface Replacement {
	old: string;
	next: string;
	occurrences: number;
	labels: string[];
}

/** Labels are legion (one stale link can be 3,000 descriptor rows); name a few. */
export const summarizeLabels = (labels: string[]): string => {
	const head = labels.slice(0, 3).join(", ");
	return labels.length > 3 ? `${head}, +${labels.length - 3} more` : head;
};

export type Plan =
	| { ok: true; replacements: Replacement[]; deferred: Replacement[] }
	| { ok: false; code: number; reasons: string[] };

const DIGEST = /^[0-9a-f]{64}$/;
// Whole-token: a 64-hex run that is not part of a longer hex run. Lookarounds
// keep the match exact, so a digest can never be replaced inside a longer
// literal and a shorter prefix can never match.
const DIGEST_TOKEN = /(?<![0-9a-fA-F])[0-9a-f]{64}(?![0-9a-fA-F])/g;

export const sha256 = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

export const countDigestTokens = (source: string): Map<string, number> => {
	const counts = new Map<string, number>();
	for (const match of source.matchAll(DIGEST_TOKEN)) {
		const token = match[0];
		counts.set(token, (counts.get(token) ?? 0) + 1);
	}
	return counts;
};

/**
 * Turns a verifier report into an exact, whole-token, globally unambiguous
 * substitution plan -- or refuses. Refusal beats partial application: a
 * half-applied pass leaves the fixture in a state neither the old nor the new
 * DAG explains, and the next verify run reports it as ordinary drift.
 */
export const planReplacements = (
	report: VerifierReport,
	source: string,
): Plan => {
	const reasons: string[] = [];

	// (1) Structural drift (array length, twin type asymmetry) is not a digest
	// substitution at all. Nothing this driver does can fix it.
	if (report.structural.length > 0) {
		return {
			ok: false,
			code: EXIT.UNFIXABLE,
			reasons: report.structural.map(
				(entry) => `structural mismatch: ${entry}`,
			),
		};
	}

	const failing = report.checks.filter((check) => !check.ok);
	if (failing.length === 0) return { ok: true, replacements: [], deferred: [] };

	// (2) The twin walk compares every string field, not only digests. A
	// mismatched host name or timestamp is a real finding that a human must
	// resolve -- the driver must not paper over it with a substitution.
	const nonDigest = failing.filter(
		(check) => !DIGEST.test(check.frozen) || !DIGEST.test(check.computed),
	);
	if (nonDigest.length > 0) {
		return {
			ok: false,
			code: EXIT.UNFIXABLE,
			reasons: nonDigest.map(
				(check) =>
					`non-digest mismatch at ${check.label}: ${JSON.stringify(check.frozen)} -> ${JSON.stringify(check.computed)}`,
			),
		};
	}

	// (3) One stale value must have exactly one destination. Two destinations
	// means the same literal is serving two different roles, and a global
	// substitution cannot satisfy both.
	const byOld = new Map<string, Replacement>();
	for (const check of failing) {
		const existing = byOld.get(check.frozen);
		if (!existing) {
			byOld.set(check.frozen, {
				old: check.frozen,
				next: check.computed,
				occurrences: 0,
				labels: [check.label],
			});
			continue;
		}
		if (existing.next !== check.computed) {
			reasons.push(
				`conflicting targets for ${check.frozen}: ${existing.next} (${existing.labels[0]}) vs ${check.computed} (${check.label})`,
			);
			continue;
		}
		if (!existing.labels.includes(check.label))
			existing.labels.push(check.label);
	}

	// (4) A stale value that is ALSO the correct value of some passing check
	// cannot be replaced globally without clobbering that correct location.
	// This is the case oscillation would otherwise surface a dozen iterations
	// later; catching it here names the collision instead.
	const correct = new Map<string, string>();
	for (const check of report.checks) {
		if (check.ok) correct.set(check.computed, check.label);
	}
	for (const replacement of byOld.values()) {
		const holder = correct.get(replacement.old);
		if (holder !== undefined) {
			reasons.push(
				`digest ${replacement.old} is stale at ${summarizeLabels(replacement.labels)} but correct at ${holder}; a global substitution would clobber it`,
			);
		}
	}

	// Any ambiguity forfeits the entire pass. Applying "the ones that are fine"
	// is exactly the silent partial application that would corrupt a freeze.
	if (reasons.length > 0) return { ok: false, code: EXIT.AMBIGUOUS, reasons };

	// (5) Split by whether the stale value exists in the file as a whole token.
	// Not every reported value is a literal: parts of the DAG are computed at
	// import time (a descriptor digest derived from bytes, say), so their stale
	// side has no token to rewrite and they correct themselves once their
	// inputs do. Those are deferred to the next iteration -- never skipped
	// silently -- and the loop's oscillation and cap guards backstop the case
	// where they never resolve.
	const counts = countDigestTokens(source);
	const replacements: Replacement[] = [];
	const deferred: Replacement[] = [];
	for (const replacement of byOld.values()) {
		const occurrences = counts.get(replacement.old) ?? 0;
		if (occurrences === 0) {
			deferred.push(replacement);
			continue;
		}
		replacement.occurrences = occurrences;
		replacements.push(replacement);
	}

	// Nothing to apply but mismatches remain: the loop cannot make progress,
	// so stop here rather than burning the cap.
	if (replacements.length === 0) {
		return {
			ok: false,
			code: EXIT.AMBIGUOUS,
			reasons: deferred.map(
				(entry) =>
					`stale digest ${entry.old} (${summarizeLabels(entry.labels)}) does not appear in the fixture, and no other reported digest does either`,
			),
		};
	}

	return { ok: true, replacements, deferred };
};

/**
 * Applies the whole plan in one pass, so the result cannot depend on pair
 * order: a token is rewritten according to its value BEFORE the pass, which
 * is the value the verifier reported on. A chained pair (X->Y alongside Y->Z)
 * is therefore well defined rather than a cascade.
 */
export const applyReplacements = (
	source: string,
	replacements: Replacement[],
): { text: string; applied: Map<string, number> } => {
	const table = new Map(replacements.map((entry) => [entry.old, entry.next]));
	const applied = new Map<string, number>();
	const text = source.replace(DIGEST_TOKEN, (token) => {
		const next = table.get(token);
		if (next === undefined) return token;
		applied.set(token, (applied.get(token) ?? 0) + 1);
		return next;
	});
	return { text, applied };
};

/** Every planned occurrence must have been rewritten -- N appearances, N edits. */
export const auditApplication = (
	replacements: Replacement[],
	applied: Map<string, number>,
): string[] =>
	replacements
		.filter((entry) => (applied.get(entry.old) ?? 0) !== entry.occurrences)
		.map(
			(entry) =>
				`expected ${entry.occurrences} replacement(s) of ${entry.old}, applied ${applied.get(entry.old) ?? 0}`,
		);

/**
 * Tracks the fixture states this run has produced. A state that recurs means
 * the DAG is cycling rather than converging, and a human must look.
 */
export const makeStateGuard = (): { record: (hash: string) => boolean } => {
	const seen = new Set<string>();
	return {
		record: (hash: string): boolean => {
			if (seen.has(hash)) return false;
			seen.add(hash);
			return true;
		},
	};
};

export const parseReport = (stdout: string): VerifierReport => {
	const parsed: unknown = JSON.parse(stdout);
	if (!parsed || typeof parsed !== "object") {
		throw new Error("verifier JSON is not an object");
	}
	const record = parsed as Record<string, unknown>;
	if (!Array.isArray(record.checks) || !Array.isArray(record.structural)) {
		throw new Error("verifier JSON is missing checks/structural");
	}
	return {
		clean: record.clean === true,
		mismatches: typeof record.mismatches === "number" ? record.mismatches : 0,
		checks: record.checks as VerifierCheck[],
		structural: record.structural as string[],
	};
};

interface Options {
	apply: boolean;
	maxIterations: number;
	fixture: string;
	verifier: string;
	log: string;
	quiet: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

const stamp = (): string =>
	new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");

const parseArgs = (argv: string[]): Options => {
	const value = (flag: string): string | undefined => {
		const index = argv.indexOf(flag);
		if (index === -1) return undefined;
		const next = argv[index + 1];
		if (next === undefined || next.startsWith("--")) {
			throw new Error(`${flag} needs a value`);
		}
		return next;
	};
	const maxRaw = value("--max-iterations");
	const maxIterations = maxRaw === undefined ? 25 : Number.parseInt(maxRaw, 10);
	if (!Number.isInteger(maxIterations) || maxIterations < 1) {
		throw new Error("--max-iterations must be a positive integer");
	}
	return {
		apply: argv.includes("--apply"),
		maxIterations,
		fixture: resolve(
			value("--fixture") ?? join(ROOT, "tools", "compare", "r1-fixtures.ts"),
		),
		verifier: resolve(
			value("--verifier") ??
				join(ROOT, "scripts", "verify-r1-fixture-hashes.ts"),
		),
		log: resolve(
			value("--log") ??
				join(ROOT, ".scratch", "converge-r1-fixture-hashes", `${stamp()}.log`),
		),
		quiet: argv.includes("--quiet"),
	};
};

const runVerifier = async (
	verifier: string,
): Promise<{ report: VerifierReport; exitCode: number }> => {
	const child = Bun.spawn(["bun", verifier, "--json"], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	try {
		return { report: parseReport(stdout), exitCode };
	} catch (error) {
		throw new Error(
			`verifier output was not parseable (exit ${exitCode}): ${String(error)}\n${stderr.slice(0, 2000)}`,
		);
	}
};

const main = async (): Promise<number> => {
	let options: Options;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`converge: ${String(error)}`);
		return EXIT.VERIFIER_ERROR;
	}

	const logLines: string[] = [];
	const emit = (line: string): void => {
		logLines.push(line);
		if (!options.quiet) console.log(line);
	};
	const flush = (): void => {
		mkdirSync(dirname(options.log), { recursive: true });
		writeFileSync(options.log, `${logLines.join("\n")}\n`);
		if (!options.quiet) console.log(`log: ${options.log}`);
	};

	emit(`converge-r1-fixture-hashes ${new Date().toISOString()}`);
	emit(`mode: ${options.apply ? "apply" : "dry-run"}`);
	emit(`fixture: ${options.fixture}`);
	emit(`verifier: ${options.verifier}`);
	emit(`max-iterations: ${options.maxIterations}`);

	const states = makeStateGuard();
	states.record(sha256(readFileSync(options.fixture, "utf8")));

	for (let iteration = 1; iteration <= options.maxIterations; iteration += 1) {
		let report: VerifierReport;
		try {
			({ report } = await runVerifier(options.verifier));
		} catch (error) {
			emit(`iteration ${iteration}: verifier error: ${String(error)}`);
			flush();
			return EXIT.VERIFIER_ERROR;
		}

		const source = readFileSync(options.fixture, "utf8");
		const before = sha256(source);
		if (report.clean) {
			emit(
				`iteration ${iteration}: verdict CLEAN, fixture ${before}, no edits needed`,
			);
			emit(`converged after ${iteration - 1} applied iteration(s)`);
			flush();
			return EXIT.CLEAN;
		}

		const plan = planReplacements(report, source);
		if (!plan.ok) {
			emit(`iteration ${iteration}: verdict ${report.mismatches} mismatches`);
			for (const reason of plan.reasons) emit(`  REFUSED: ${reason}`);
			emit(`aborting without writing; fixture unchanged at ${before}`);
			flush();
			return plan.code;
		}

		const pairs = plan.replacements.length;
		const edits = plan.replacements.reduce(
			(sum, entry) => sum + entry.occurrences,
			0,
		);
		emit(
			`iteration ${iteration}: verdict ${report.mismatches} mismatches, ${pairs} distinct digest(s), ${edits} occurrence(s), fixture ${before}`,
		);
		for (const entry of plan.deferred) {
			emit(
				`  DEFERRED ${entry.old} -> ${entry.next} (no literal in the fixture; ${summarizeLabels(entry.labels)})`,
			);
		}
		for (const entry of plan.replacements) {
			emit(
				`  ${entry.old} -> ${entry.next} x${entry.occurrences} (${summarizeLabels(entry.labels)})`,
			);
		}

		if (!options.apply) {
			emit("dry-run: nothing written");
			flush();
			return EXIT.DRY_RUN_PENDING;
		}

		const { text, applied } = applyReplacements(source, plan.replacements);
		const audit = auditApplication(plan.replacements, applied);
		if (audit.length > 0) {
			for (const reason of audit) emit(`  REFUSED: ${reason}`);
			emit(`aborting without writing; fixture unchanged at ${before}`);
			flush();
			return EXIT.AMBIGUOUS;
		}

		writeFileSync(options.fixture, text);
		const after = sha256(text);
		emit(`iteration ${iteration}: fixture ${before} -> ${after}`);
		if (!states.record(after)) {
			emit(
				`OSCILLATION: fixture state ${after} has already occurred in this run`,
			);
			flush();
			return EXIT.OSCILLATION;
		}
	}

	emit(`cap of ${options.maxIterations} iteration(s) exceeded without CLEAN`);
	flush();
	return EXIT.CAP_EXCEEDED;
};

if (import.meta.main) {
	process.exit(await main());
}
