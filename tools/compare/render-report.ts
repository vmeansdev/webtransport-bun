/**
 * Render a comparison report from externally trusted, verified artifacts.
 *
 * R0 keeps official report generation quarantined until R1 supplies a
 * validated staged trust boundary for campaign filesystem I/O. Historical
 * `./evidence` output and checked-in numeric reports are not a source of
 * comparison truth.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { compareRunArtifacts, trustContextForArtifact } from "./compare.ts";
import {
	assertSupportedPlatform,
	ComparisonCliError,
	comparisonErrorCode,
	metricContractForScenario,
	parseRecoveryMode,
	parseStagedTrustArgv,
	type RunArtifact,
	type StagedTrustArgs,
	validateFixtureOnlyEntrypoint,
	validateOfficialEntrypointContract,
} from "./evidence.ts";
import {
	assertOfficialComparisonIoAvailable,
	checkPromotionQuarantine,
	readOfficialComparisonFile,
	resolveOfficialComparisonOutputDir,
	resolveOfficialComparisonOutputFile,
	writeOfficialComparisonFile,
} from "./output-policy.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";

export {
	parseRecoveryMode,
	validateFixtureOnlyEntrypoint,
	validateOfficialEntrypointContract,
};

/** Syntax-only parse of the report CLI. It takes no positional locator. */
export function parseReportArgs(argv: readonly string[]): StagedTrustArgs {
	return parseStagedTrustArgv("report", argv);
}

export interface CellComparison {
	readonly cellId: string;
	readonly scenarioId: string;
	readonly status: "COMPATIBLE" | "INCOMPATIBLE";
	readonly primaryMetricName?: string;
	readonly metricUnit?: string;
	readonly metricDirection?: "higher" | "lower";
	readonly wsValue?: number;
	readonly wtValue?: number;
	readonly deltaPercent?: number;
	readonly winner?: "ws" | "wt" | "tie";
	readonly rejectionReason?: string;
	readonly wsArtifact?: RunArtifact;
	readonly wtArtifact?: RunArtifact;
	readonly overlayArtifact?: RunArtifact;
}

export interface ComparisonSummary {
	readonly campaignId: string;
	readonly generatedAt: string;
	readonly totalCells: number;
	readonly comparableCells: number;
	readonly rejectedCells: number;
	readonly comparisons: readonly CellComparison[];
}

/** Escape characters with Markdown table meaning. */
export function escapeMarkdown(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render only values present in the supplied summary.  No historical or
 * synthetic measurements are embedded in this renderer.
 */
export function renderMarkdownReport(summary: ComparisonSummary): string {
	const lines: string[] = [
		"# WebTransport vs WebSocket Comparison Report",
		"",
		`> **Campaign ID**: \`${escapeMarkdown(summary.campaignId)}\` | **Generated**: ${summary.generatedAt}`,
		`> **Comparison status**: ${summary.comparableCells}/${summary.totalCells} cells comparable; ${summary.rejectedCells} rejected or quarantined`,
		"",
		"Only externally trusted, source-bound artifacts are eligible for a numeric comparison. Missing, incompatible, synthetic, or quarantined inputs remain typed rows and do not produce a delta.",
		"",
		"## Summary Table",
		"",
		"| Scenario | Status | Primary Metric | WS | WT | Delta (%) | Winner | Notes |",
		"| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :--- |",
	];

	for (const comparison of summary.comparisons) {
		const scenario = escapeMarkdown(comparison.cellId);
		if (comparison.status === "COMPATIBLE") {
			const metric = escapeMarkdown(
				`${comparison.primaryMetricName ?? "metric"} (${comparison.metricUnit ?? ""})`,
			);
			const ws =
				comparison.wsValue === undefined
					? "-"
					: comparison.wsValue.toLocaleString("en-US", {
							maximumFractionDigits: 2,
						});
			const wt =
				comparison.wtValue === undefined
					? "-"
					: comparison.wtValue.toLocaleString("en-US", {
							maximumFractionDigits: 2,
						});
			const delta =
				comparison.deltaPercent === undefined
					? "-"
					: `${comparison.deltaPercent > 0 ? "+" : ""}${comparison.deltaPercent.toFixed(2)}%`;
			lines.push(
				`| \`${scenario}\` | **COMPATIBLE** | ${metric} | ${ws} | ${wt} | ${delta} | ${comparison.winner?.toUpperCase() ?? "-"} | - |`,
			);
		} else {
			lines.push(
				`| \`${scenario}\` | *INCOMPATIBLE* | - | - | - | - | - | ${escapeMarkdown(comparison.rejectionReason ?? "quarantined or missing evidence")} |`,
			);
		}
	}

	lines.push(
		"",
		"## Provenance",
		"",
		"- Numeric values are copied from verified run artifacts; this report does not contain a fallback baseline.",
		"- A comparison is withheld unless both transport arms pass the evidence and external-trust quarantine gates.",
		"- Generated output belongs under the ignored `.release-evidence/transport-comparison/` tree.",
		"",
	);
	return lines.join("\n");
}

/**
 * The identity the report is rendered under. It is stated by the caller, and
 * there is no ambient fallback: an unnamed candidate used to select which
 * official directory got read and written, which made the environment — not the
 * operator — the thing that decided where official output lives.
 */
export interface ReportIdentity {
	readonly candidate: string;
	readonly campaignId: string;
	readonly evidenceDir?: string;
	readonly outputFile?: string;
	readonly externalTrustBound?: string;
}

export function generateReport(identity?: ReportIdentity): void {
	// The gate belongs on the entry point, not only on the argument parser: an
	// in-process caller that assembles a `ReportIdentity` itself never goes
	// through the parser and would otherwise read and write official evidence on
	// an unreviewed host.
	assertSupportedPlatform("report", process.platform);
	assertOfficialComparisonIoAvailable();
	if (identity === undefined || !identity.candidate || !identity.campaignId) {
		throw new ComparisonCliError("report", "REPORT_IDENTITY_UNBOUND");
	}
	const { candidate, campaignId, evidenceDir, outputFile } = identity;
	const officialDir = resolveOfficialComparisonOutputDir({
		candidate,
		campaignId,
		outputDir: evidenceDir,
	});
	const reportPath = resolveOfficialComparisonOutputFile({
		candidate,
		campaignId,
		outputFile,
	});

	// A typed code, not a message quoting the resolved official path: an
	// in-process caller that prints `error.message` would otherwise publish that
	// path, and only the root's catch was collapsing it.
	if (!existsSync(officialDir))
		throw new ComparisonCliError("report", "REPORT_EVIDENCE_DIR_MISSING");

	const files = readdirSync(officialDir).filter(
		(file) => file.endsWith(".json") && file !== "manifest.json",
	);
	// An unset bound leaves every artifact quarantined, which is the right answer
	// when nobody has stated one — an ambient variable is not a trust boundary.
	const externalTrustBound = identity.externalTrustBound;
	const artifactMap = new Map<string, RunArtifact>();
	for (const file of files) {
		const artifactPath = resolveOfficialComparisonOutputFile({
			candidate,
			campaignId,
			outputDir: officialDir,
			outputFile: join(officialDir, file),
		});
		const bytes = readOfficialComparisonFile(artifactPath);
		const artifact = JSON.parse(new TextDecoder().decode(bytes)) as RunArtifact;
		const quarantine = checkPromotionQuarantine({
			artifact,
			externalTrustBound,
			expectedComparisonId: campaignId,
		});
		if (quarantine.promotable) artifactMap.set(file, artifact);
	}

	const comparisons: CellComparison[] = [];
	let comparableCount = 0;
	let rejectedCount = 0;

	for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
		const cellPrefix = cell.cellId.replace(/[/:]/g, "_");
		const wsFile = `${cellPrefix}-ws.json`;
		const wtFile = `${cellPrefix}-wt.json`;
		const overlayFile = `${cellPrefix}-ws-overlay.json`;
		const wsArtifact = artifactMap.get(wsFile);
		const wtArtifact = artifactMap.get(wtFile);
		const overlayArtifact = artifactMap.get(overlayFile);

		if (!wsArtifact || !wtArtifact) {
			comparisons.push({
				cellId: cell.cellId,
				scenarioId: cell.scenarioId,
				status: "INCOMPATIBLE",
				rejectionReason: "Missing or quarantined WS or WT evidence artifact",
			});
			rejectedCount++;
			continue;
		}

		const wsPath = resolveOfficialComparisonOutputFile({
			candidate,
			campaignId,
			outputDir: officialDir,
			outputFile: join(officialDir, wsFile),
		});
		const wtPath = resolveOfficialComparisonOutputFile({
			candidate,
			campaignId,
			outputDir: officialDir,
			outputFile: join(officialDir, wtFile),
		});
		const wsBytes = readOfficialComparisonFile(wsPath);
		const wtBytes = readOfficialComparisonFile(wtPath);
		const result = compareRunArtifacts(wsBytes, wtBytes, {
			ws: trustContextForArtifact(wsArtifact),
			wt: trustContextForArtifact(wtArtifact),
		});

		if (result.evidenceStatus === "PASS" && result.delta !== "not computed") {
			const delta = result.delta;
			const contract = metricContractForScenario(cell.scenarioId);
			if (contract === undefined) {
				comparisons.push({
					cellId: cell.cellId,
					scenarioId: cell.scenarioId,
					status: "INCOMPATIBLE",
					rejectionReason: "Missing primary metric contract",
				});
				rejectedCount++;
				continue;
			}
			comparisons.push({
				cellId: cell.cellId,
				scenarioId: cell.scenarioId,
				status: "COMPATIBLE",
				primaryMetricName: delta.metric,
				metricUnit: delta.unit,
				metricDirection: contract.direction,
				wsValue: delta.ws,
				wtValue: delta.wt,
				deltaPercent:
					delta.relative === null ? undefined : delta.relative * 100,
				winner: result.ranking === "not computed" ? undefined : result.ranking,
				wsArtifact,
				wtArtifact,
				overlayArtifact,
			});
			comparableCount++;
		} else {
			comparisons.push({
				cellId: cell.cellId,
				scenarioId: cell.scenarioId,
				status: "INCOMPATIBLE",
				rejectionReason: result.rejections
					.map((rejection) => rejection.code)
					.join("; "),
			});
			rejectedCount++;
		}
	}

	const summary: ComparisonSummary = {
		campaignId,
		generatedAt: new Date().toISOString(),
		totalCells: CANONICAL_SCENARIO_REGISTRY.cells.length,
		comparableCells: comparableCount,
		rejectedCells: rejectedCount,
		comparisons,
	};
	const markdown = renderMarkdownReport(summary);
	writeOfficialComparisonFile(reportPath, markdown);
	console.log(
		`[report] Generated Markdown report at '${reportPath}' (${markdown.length} bytes, ${summary.comparableCells}/${summary.totalCells} cells comparable).`,
	);
}

if (import.meta.main) {
	try {
		// The package script runs this root with --fixture-only. That flag used to
		// be consumed as an output path, so `bun run compare:report` resolved an
		// official directory literally named "--fixture-only"; it is now parsed.
		const args = parseReportArgs(process.argv.slice(2));
		if (args.fixtureOnly) {
			console.log(
				"[report] fixture-only: no official evidence is read or written. Run the supervisor for an official report.",
			);
			process.exit(0);
		}
		generateReport({
			candidate: args.candidateId,
			campaignId: args.campaignId,
			evidenceDir: args.positionals[0],
			outputFile: args.positionals[1],
		});
	} catch (error: unknown) {
		console.error(`[report] Error: ${comparisonErrorCode(error)}`);
		process.exit(1);
	}
}
