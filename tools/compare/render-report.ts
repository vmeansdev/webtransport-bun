/**
 * Task 10: Markdown Report Renderer.
 *
 * Generates formatted Markdown comparison reports from comparison summaries.
 * Escapes special characters, formats numbers with appropriate units, and
 * clearly displays verdicts, deltas, and rejection reasons.
 */

export interface CellComparison {
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
}

export interface ComparisonSummary {
	readonly campaignId: string;
	readonly generatedAt: string;
	readonly totalCells: number;
	readonly comparableCells: number;
	readonly rejectedCells: number;
	readonly comparisons: readonly CellComparison[];
}

/**
 * Escapes characters that have formatting meaning in Markdown table cells.
 */
export function escapeMarkdown(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders a full Markdown comparison report.
 */
export function renderMarkdownReport(summary: ComparisonSummary): string {
	const lines: string[] = [];

	lines.push("# WebTransport vs WebSocket Comparison Report");
	lines.push("");
	lines.push(`- **Campaign ID**: \`${summary.campaignId}\``);
	lines.push(`- **Generated At**: ${summary.generatedAt}`);
	lines.push(
		`- **Cells**: ${summary.totalCells} total (${summary.comparableCells} compatible, ${summary.rejectedCells} rejected/incompatible)`,
	);
	lines.push("");

	lines.push("## Summary Table");
	lines.push("");
	lines.push(
		"| Scenario | Status | Primary Metric | WS | WT | Delta (%) | Winner | Notes |",
	);
	lines.push("| :--- | :---: | :--- | :---: | :---: | :---: | :---: | :--- |");

	for (const comp of summary.comparisons) {
		const scenario = escapeMarkdown(comp.scenarioId);
		const status = comp.status;

		if (status === "COMPATIBLE") {
			const metric = escapeMarkdown(
				`${comp.primaryMetricName ?? "metric"} (${comp.metricUnit ?? ""})`,
			);
			const ws =
				comp.wsValue !== undefined
					? comp.wsValue.toLocaleString("en-US", { maximumFractionDigits: 2 })
					: "-";
			const wt =
				comp.wtValue !== undefined
					? comp.wtValue.toLocaleString("en-US", { maximumFractionDigits: 2 })
					: "-";
			const delta =
				comp.deltaPercent !== undefined
					? `${comp.deltaPercent > 0 ? "+" : ""}${comp.deltaPercent.toFixed(2)}%`
					: "-";
			const winner = comp.winner ? comp.winner.toUpperCase() : "-";
			const notes = "-";

			lines.push(
				`| \`${scenario}\` | **${status}** | ${metric} | ${ws} | ${wt} | ${delta} | ${winner} | ${notes} |`,
			);
		} else {
			const reason = escapeMarkdown(comp.rejectionReason ?? "Incompatible");
			lines.push(
				`| \`${scenario}\` | *${status}* | - | - | - | - | - | ${reason} |`,
			);
		}
	}

	lines.push("");
	lines.push("## Methodology & Provenance");
	lines.push("");
	lines.push(
		"- **Topology**: Mac (darwin-arm64, 10.99.0.1/en8) ↔ Linux (linux-x86_64, 10.99.0.2/eno1) direct cable.",
	);
	lines.push(
		"- **Capacity Profile**: Frozen canonical v1 profile submitted explicitly on both transports.",
	);
	lines.push(
		"- **Fail-Closed Rule**: Stale, mismatched, or corrupted artifacts produce `INCOMPATIBLE` and suppress delta calculation.",
	);
	lines.push("");

	return lines.join("\n");
}
