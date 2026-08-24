/**
 * Render a comparison report from externally trusted, verified artifacts.
 *
 * Reports are generated next to the campaign artifacts under
 * `.release-evidence/transport-comparison/<candidate>/<campaign-id>/`.
 * Historical `./evidence` output and checked-in numeric reports are not a
 * source of comparison truth.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { compareRunArtifacts, trustContextForArtifact } from "./compare.ts";
import { metricContractForScenario, type RunArtifact } from "./evidence.ts";
import {
	checkPromotionQuarantine,
	readOfficialComparisonFile,
	resolveOfficialComparisonOutputDir,
	resolveOfficialComparisonOutputFile,
	writeOfficialComparisonFile,
} from "./output-policy.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";

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

function campaignIdentity(): { candidate: string; campaignId: string } {
	return {
		candidate:
			process.env.WEBTRANSPORT_COMPARISON_CANDIDATE ?? "unbound-candidate",
		campaignId:
			process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN ?? "campaign-unbound",
	};
}

export function generateReport(
	evidenceDir?: string,
	outputFile?: string,
): void {
	const { candidate, campaignId } = campaignIdentity();
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

	if (!existsSync(officialDir))
		throw new Error(`Evidence directory '${officialDir}' does not exist.`);

	const files = readdirSync(officialDir).filter(
		(file) => file.endsWith(".json") && file !== "manifest.json",
	);
	const externalTrustBound =
		process.env.WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND;
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
		const overlayFile = `${cellPrefix}-ws-lossy-overlay.json`;
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
		generateReport(process.argv[2], process.argv[3]);
	} catch (error: unknown) {
		console.error(`[report] Error: ${(error as Error).message}`);
		process.exit(1);
	}
}
