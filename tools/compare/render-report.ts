/**
 * Render a comparison report from externally trusted, verified artifacts.
 *
 * R0 keeps official report generation quarantined until R1 supplies a
 * validated staged trust boundary for campaign filesystem I/O. Historical
 * `./evidence` output and checked-in numeric reports are not a source of
 * comparison truth.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	RELAY_FRAME_DECODE_CHARGE_CORRECTION_NOTE,
	SESSION_LOOP_BUSY_MS_REPORT_NOTE,
} from "./adapters/transport.ts";
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

/**
 * Immutable report-owned knobs. The saturation threshold is fixed here so a
 * measurement run cannot calibrate away a caveated arm; the configured value
 * is rendered in report provenance so the deliverable names its own rule.
 */
export const REPORT_CONFIG = {
	loopUtilizationSaturationThreshold: 0.3,
} as const;

/** Syntax-only parse of the report CLI. It takes no positional locator. */
export function parseReportArgs(argv: readonly string[]): StagedTrustArgs {
	return parseStagedTrustArgv("report", argv);
}

export type LoopUtilizationScopes = {
	readonly perSession: { readonly busyMs: number; readonly windowMs: number };
	readonly serverAggregate: {
		readonly busyMs: number;
		readonly windowMs: number;
	};
};

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
	/**
	 * Per-arm two-scope loop utilization copied from the joined
	 * `RunArtifact.loopUtilization`. The renderer reads these fields —
	 * not a side channel — so a saturated arm can be caveated from the
	 * same summary that produces the numeric ranking.
	 */
	readonly wsLoopUtilization?: LoopUtilizationScopes;
	readonly wtLoopUtilization?: LoopUtilizationScopes;
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
	readonly headerNote?: string;
}

/** Escape characters with Markdown table meaning. */
export function escapeMarkdown(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function utilizationRatio(scope: {
	readonly busyMs: number;
	readonly windowMs: number;
}): number {
	return scope.busyMs / scope.windowMs;
}

function formatUtilizationPercent(scope: {
	readonly busyMs: number;
	readonly windowMs: number;
}): string {
	return `${(100 * utilizationRatio(scope)).toFixed(0)}%`;
}

/**
 * Strict `>` against the configured threshold: equality at 0.3 is not
 * saturated. Only `perSession` may trigger the caveat; `serverAggregate`
 * is shown for transparency and never caveats the ranking.
 */
export function isPerSessionSaturated(
	perSession: { readonly busyMs: number; readonly windowMs: number },
	threshold: number = REPORT_CONFIG.loopUtilizationSaturationThreshold,
): boolean {
	return utilizationRatio(perSession) > threshold;
}

function formatArmLoopUtilization(
	arm: "WS" | "WT",
	scopes: LoopUtilizationScopes | undefined,
): string {
	if (scopes === undefined) return `${arm}: -`;
	return `${arm} ps=${formatUtilizationPercent(scopes.perSession)}/agg=${formatUtilizationPercent(scopes.serverAggregate)}`;
}

function saturationCaveats(comparison: CellComparison): string[] {
	const caveats: string[] = [];
	const threshold = REPORT_CONFIG.loopUtilizationSaturationThreshold;
	const arms: Array<{
		readonly label: "WS" | "WT";
		readonly scopes: LoopUtilizationScopes | undefined;
	}> = [
		{ label: "WS", scopes: comparison.wsLoopUtilization },
		{ label: "WT", scopes: comparison.wtLoopUtilization },
	];
	for (const arm of arms) {
		if (arm.scopes === undefined) continue;
		if (!isPerSessionSaturated(arm.scopes.perSession, threshold)) continue;
		const percent = formatUtilizationPercent(arm.scopes.perSession);
		caveats.push(
			`${arm.label} per-session receive-loop utilization ${percent}; protocol attribution is caveated`,
		);
	}
	return caveats;
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
	];
	if (summary.headerNote !== undefined && summary.headerNote.length > 0) {
		lines.push(`> **Note**: ${escapeMarkdown(summary.headerNote)}`);
	}
	lines.push(
		"",
		"Only externally trusted, source-bound artifacts are eligible for a numeric comparison. Missing, incompatible, synthetic, or quarantined inputs remain typed rows and do not produce a delta.",
		"",
		"`serverAggregate` loop utilization is reported for transparency and is **unobserved** / non-claim for saturation ranking when busyMs is a placeholder.",
		"",
		"## Summary Table",
		"",
		"| Scenario | Status | Primary Metric | WS | WT | Delta (%) | Winner | Loop Utilization | Notes |",
		"| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :--- | :--- |",
	);

	for (const comparison of summary.comparisons) {
		const scenario = escapeMarkdown(comparison.cellId);
		const loopCell = escapeMarkdown(
			`${formatArmLoopUtilization("WS", comparison.wsLoopUtilization)}; ${formatArmLoopUtilization("WT", comparison.wtLoopUtilization)}`,
		);
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
			const caveats = saturationCaveats(comparison);
			const notes =
				caveats.length === 0 ? "-" : escapeMarkdown(caveats.join("; "));
			lines.push(
				`| \`${scenario}\` | **COMPATIBLE** | ${metric} | ${ws} | ${wt} | ${delta} | ${comparison.winner?.toUpperCase() ?? "-"} | ${loopCell} | ${notes} |`,
			);
		} else {
			lines.push(
				`| \`${scenario}\` | *INCOMPATIBLE* | - | - | - | - | - | ${loopCell} | ${escapeMarkdown(comparison.rejectionReason ?? "quarantined or missing evidence")} |`,
			);
		}
	}

	const thresholdPercent = (
		100 * REPORT_CONFIG.loopUtilizationSaturationThreshold
	).toFixed(0);
	lines.push(
		"",
		"## Provenance",
		"",
		"- Numeric values are copied from verified run artifacts; this report does not contain a fallback baseline.",
		"- A comparison is withheld unless both transport arms pass the evidence and external-trust quarantine gates.",
		`- Loop-utilization saturation caveat fires when per-session busyMs/windowMs exceeds ${REPORT_CONFIG.loopUtilizationSaturationThreshold} (${thresholdPercent}%); server-aggregate utilization is shown for transparency and never triggers the caveat.`,
		`- ${SESSION_LOOP_BUSY_MS_REPORT_NOTE}`,
		`- ${RELAY_FRAME_DECODE_CHARGE_CORRECTION_NOTE}`,
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
	/** When set, only these cellIds are ranked (Phase-4 gate subset). */
	readonly cells?: readonly string[];
	/** Optional report header caveat (Phase-4 / unobserved loopUtil). */
	readonly headerNote?: string;
}

/**
 * The evidence directory, or a typed refusal that does not name it.
 *
 * A typed code, not a message quoting the resolved official path: an in-process
 * caller that prints `error.message` would otherwise publish that path, and
 * only the root's catch was collapsing it. The existence check is a parameter
 * so this is provable without staging a filesystem — the verify root's
 * `requireExistingEvidenceDir` is the same shape for the same reason.
 */
export function requireExistingReportEvidenceDir(
	dir: string,
	exists: (path: string) => boolean,
): string {
	if (!exists(dir)) {
		throw new ComparisonCliError("report", "REPORT_EVIDENCE_DIR_MISSING");
	}
	return dir;
}

const CAMPAIGN_MANIFEST_FILE = "manifest.json";

/**
 * The artifact leaf names a campaign manifest publishes. Each must be a plain
 * `.json` leaf (no separators, no traversal) and none may be the manifest
 * itself; anything else is not a published artifact name and refuses the
 * report rather than being skipped.
 */
export function readPublishedArtifactNames(
	manifestBytes: Uint8Array,
): string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
	} catch {
		throw new ComparisonCliError("report", "REPORT_MANIFEST_INVALID");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!Array.isArray((parsed as { artifacts?: unknown }).artifacts)
	) {
		throw new ComparisonCliError("report", "REPORT_MANIFEST_INVALID");
	}
	const names = (parsed as { artifacts: unknown[] }).artifacts;
	const result: string[] = [];
	for (const name of names) {
		if (
			typeof name !== "string" ||
			!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name) ||
			name === CAMPAIGN_MANIFEST_FILE ||
			result.includes(name)
		) {
			throw new ComparisonCliError("report", "REPORT_MANIFEST_INVALID");
		}
		result.push(name);
	}
	return result;
}

export function generateReport(identity?: ReportIdentity): void {
	// The gate belongs on the entry point, not only on the argument parser: an
	// in-process caller that assembles a `ReportIdentity` itself never goes
	// through the parser and would otherwise read and write official evidence on
	// an unreviewed host.
	assertSupportedPlatform("report", process.platform);
	assertOfficialComparisonIoAvailable({
		cwd: identity?.evidenceDir ? process.cwd() : undefined,
		candidate: identity?.candidate,
		campaignId: identity?.campaignId,
	});
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

	requireExistingReportEvidenceDir(officialDir, existsSync);

	// The campaign manifest names the artifacts it published; the report reads
	// exactly those. Enumerating the directory instead would let a file nobody
	// published — dropped in, left over, renamed — become report evidence.
	const files = readPublishedArtifactNames(
		readOfficialComparisonFile(
			resolveOfficialComparisonOutputFile({
				candidate,
				campaignId,
				outputDir: officialDir,
				outputFile: join(officialDir, CAMPAIGN_MANIFEST_FILE),
			}),
		),
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

	const cellFilter =
		identity.cells !== undefined && identity.cells.length > 0
			? new Set(identity.cells)
			: undefined;
	const reportCells = CANONICAL_SCENARIO_REGISTRY.cells.filter((cell) =>
		cellFilter === undefined ? true : cellFilter.has(cell.cellId),
	);

	for (const cell of reportCells) {
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
				wsLoopUtilization: wsArtifact.loopUtilization,
				wtLoopUtilization: wtArtifact.loopUtilization,
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
				wsLoopUtilization: wsArtifact.loopUtilization,
				wtLoopUtilization: wtArtifact.loopUtilization,
			});
			rejectedCount++;
		}
	}

	const summary: ComparisonSummary = {
		campaignId,
		generatedAt: new Date().toISOString(),
		totalCells: reportCells.length,
		comparableCells: comparableCount,
		rejectedCells: rejectedCount,
		comparisons,
		...(identity.headerNote !== undefined
			? { headerNote: identity.headerNote }
			: {}),
	};
	const markdown = renderMarkdownReport(summary);
	writeOfficialComparisonFile(reportPath, markdown);
	console.log(
		`[report] Generated Markdown report at '${reportPath}' (${markdown.length} bytes, ${summary.comparableCells}/${summary.totalCells} cells comparable).`,
	);
}
