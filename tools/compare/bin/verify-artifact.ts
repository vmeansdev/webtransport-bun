/**
 * CLI entry for the verify root (`bun run compare:verify`).
 *
 * `../verify-artifact.ts` is an official child module with no entry block of
 * its own. This wrapper reads the campaign manifest's published artifact
 * names and verifies exactly those files; it never enumerates the directory.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { comparisonErrorCode, type RunArtifact } from "../evidence.ts";
import {
	assertOfficialComparisonIoAvailable,
	checkPromotionQuarantine,
	readOfficialComparisonFile,
	resolveOfficialComparisonOutputDir,
	resolveOfficialComparisonOutputFile,
} from "../output-policy.ts";
import { readPublishedArtifactNames } from "../render-report.ts";
import {
	parseVerifyArgs,
	requireExistingEvidenceDir,
	trustContextForArtifact,
	verifyRunArtifact,
} from "../verify-artifact.ts";

const CAMPAIGN_MANIFEST_FILE = "manifest.json";

export function main(argv: readonly string[]): number {
	// The package script runs this root with --fixture-only. That flag used to be
	// consumed as the evidence directory, so `bun run compare:verify` resolved an
	// official directory literally named "--fixture-only"; it is now parsed, and
	// a fixture invocation reads no official evidence at all.
	let parsedArgs: ReturnType<typeof parseVerifyArgs>;
	try {
		parsedArgs = parseVerifyArgs(argv);
	} catch (error: unknown) {
		console.error(`[verify] Error: ${comparisonErrorCode(error)}`);
		return 1;
	}
	if (parsedArgs.fixtureOnly) {
		console.log(
			"[verify] fixture-only: no official evidence is read. Run the supervisor for an official verification.",
		);
		return 0;
	}

	try {
		assertOfficialComparisonIoAvailable();
	} catch (error: unknown) {
		console.error(`[verify] Error: ${comparisonErrorCode(error)}`);
		return 1;
	}

	const candidate = parsedArgs.candidateId;
	const campaignId = parsedArgs.campaignId;
	let dir: string;
	let files: string[];
	try {
		dir = resolveOfficialComparisonOutputDir({
			candidate,
			campaignId,
			outputDir: parsedArgs.positionals[0],
		});
		requireExistingEvidenceDir(dir, existsSync);
		files = readPublishedArtifactNames(
			readOfficialComparisonFile(
				resolveOfficialComparisonOutputFile({
					candidate,
					campaignId,
					outputDir: dir,
					outputFile: join(dir, CAMPAIGN_MANIFEST_FILE),
				}),
			),
		);
	} catch (error: unknown) {
		console.error(`[verify] Error: ${comparisonErrorCode(error)}`);
		return 1;
	}

	if (files.length === 0) {
		console.log(`[verify] No evidence artifacts published in '${dir}'.`);
		return 0;
	}

	console.log(
		`===============================================================`,
	);
	console.log(`VERIFYING ${files.length} EVIDENCE ARTIFACTS IN '${dir}'`);
	console.log(
		`===============================================================`,
	);

	let passed = 0;
	let failed = 0;

	for (const file of files) {
		const filePath = resolveOfficialComparisonOutputFile({
			candidate,
			campaignId,
			outputDir: dir,
			outputFile: join(dir, file),
		});
		const bytes = readOfficialComparisonFile(filePath);
		let parsed: RunArtifact;
		try {
			parsed = JSON.parse(new TextDecoder().decode(bytes)) as RunArtifact;
		} catch {
			console.log(`[FAIL] ${file} -> Invalid JSON`);
			failed++;
			continue;
		}

		const trustCtx = trustContextForArtifact(parsed);
		const result = verifyRunArtifact(bytes, trustCtx);
		// No CLI flag binds an external trust boundary on this root, and an ambient
		// variable is not one either, so every artifact stays quarantined until the
		// supervisor states a bound.
		const quarantine = checkPromotionQuarantine({
			artifact: parsed,
			externalTrustBound: undefined,
			expectedComparisonId: campaignId,
		});

		if (result.evidenceStatus === "PASS" && quarantine.promotable) {
			console.log(`[PASS] ${file} (${bytes.byteLength} bytes)`);
			passed++;
		} else {
			console.log(
				`[${result.evidenceStatus === "PASS" ? "QUARANTINED" : "FAIL"}] ${file} -> ${[
					...result.rejections.map((r) => `${r.code}: ${r.reason}`),
					...quarantine.reasons.map((r) => `${r.code}: ${r.reason}`),
				].join("; ")}`,
			);
			failed++;
		}
	}

	console.log(
		`===============================================================`,
	);
	console.log(
		`VERIFICATION SUMMARY: ${passed}/${files.length} passed, ${failed} failed.`,
	);
	console.log(
		`===============================================================`,
	);
	return failed > 0 ? 1 : 0;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
