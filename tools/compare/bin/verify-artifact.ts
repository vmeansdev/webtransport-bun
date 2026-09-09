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
	readSigningLeafPairFlags,
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

/**
 * Split `--mac-public-key=` / `--rig-public-key=` off the argv before the
 * staged-trust parse, which fails closed on any `--*` it does not know. The
 * flag names and their reading are `verify-campaign-index`'s, through the one
 * `readSigningLeafPairFlags`; the pair is optional here, and a run without it
 * says so for every cohort flat instead of failing them silently.
 */
export function splitSigningLeafFlags(argv: readonly string[]): {
	readonly forwarded: string[];
	readonly macPublicKeyPath?: string;
	readonly rigPublicKeyPath?: string;
} {
	const forwarded: string[] = [];
	let macPublicKeyPath: string | undefined;
	let rigPublicKeyPath: string | undefined;
	for (const arg of argv) {
		if (arg.startsWith("--mac-public-key=")) {
			macPublicKeyPath = arg.slice("--mac-public-key=".length);
		} else if (arg.startsWith("--rig-public-key=")) {
			rigPublicKeyPath = arg.slice("--rig-public-key=".length);
		} else {
			forwarded.push(arg);
		}
	}
	return {
		forwarded,
		...(macPublicKeyPath !== undefined ? { macPublicKeyPath } : {}),
		...(rigPublicKeyPath !== undefined ? { rigPublicKeyPath } : {}),
	};
}

export function main(argv: readonly string[]): number {
	// The package script runs this root with --fixture-only. That flag used to be
	// consumed as the evidence directory, so `bun run compare:verify` resolved an
	// official directory literally named "--fixture-only"; it is now parsed, and
	// a fixture invocation reads no official evidence at all.
	const split = splitSigningLeafFlags(argv);
	let parsedArgs: ReturnType<typeof parseVerifyArgs>;
	try {
		parsedArgs = parseVerifyArgs(split.forwarded);
	} catch (error: unknown) {
		console.error(`[verify] Error: ${comparisonErrorCode(error)}`);
		return 1;
	}
	const leafFlags = readSigningLeafPairFlags(split);
	if (!leafFlags.ok) {
		console.error(`[verify] Error: ${leafFlags.code}: ${leafFlags.message}`);
		return 1;
	}
	const leaves = leafFlags.value;
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
	let cohortUnverified = 0;

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

		// A cohort flat's export receipt and issuer graphs verify only under
		// the two staged leaves; without them the verifier refuses the receipt
		// (`COHORT_EXPORT_RECEIPT_INVALID`), which is not a verdict on the seal.
		const isCohortFlat =
			parsed.cohortEvidenceExport !== null &&
			parsed.cohortEvidenceExport !== undefined;
		if (isCohortFlat && leaves === null) {
			console.log(
				`[UNVERIFIED] ${file} -> cohort flat verified without the issuer graphs: no --mac-public-key/--rig-public-key supplied, so its export receipt and issuer signatures were not checked`,
			);
			cohortUnverified++;
			continue;
		}
		const trustCtx = {
			...trustContextForArtifact(parsed),
			...(leaves ?? {}),
		};
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
		`VERIFICATION SUMMARY: ${passed}/${files.length} passed, ${failed} failed${
			cohortUnverified > 0
				? `, ${cohortUnverified} cohort flat${cohortUnverified === 1 ? "" : "s"} unverified (issuer graphs need --mac-public-key and --rig-public-key)`
				: ""
		}.`,
	);
	console.log(
		`===============================================================`,
	);
	return failed > 0 || cohortUnverified > 0 ? 1 : 0;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
