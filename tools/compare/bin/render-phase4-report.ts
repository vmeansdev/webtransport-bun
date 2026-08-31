/**
 * Phase-4 gate report from sealed flat arm pairs.
 *
 * Prefer formal `compareRunArtifacts` when pairing rules pass; otherwise emit
 * an honest sealed-metrics table (p50 side-by-side) and name the blockers
 * (runId / sample-count) instead of inventing a delta.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareRunArtifacts, trustContextForArtifact } from "../compare.ts";
import { metricContractForScenario, type RunArtifact } from "../evidence.ts";
import {
	escapeMarkdown,
	renderMarkdownReport,
	type CellComparison,
	type ComparisonSummary,
} from "../render-report.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "../scenario-registry.ts";

const campaignId = process.argv[2] ?? "campaign-r0-phase4-1788048504635";
const candidate = process.argv[3] ?? "ws-wt-r0";
const cells = (
	process.argv[4] ?? "bulk-one-way/physical,ticker-fanout/rate-10000"
).split(",");

const dir = join(
	".release-evidence/transport-comparison",
	candidate,
	campaignId,
);

const comparisons: CellComparison[] = [];
let comparable = 0;
let rejected = 0;
const sealedRows: string[] = [];

for (const cellId of cells) {
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(c) => c.cellId === cellId,
	);
	if (cell === undefined) {
		throw new Error(`unknown cell ${cellId}`);
	}
	const prefix = cellId.replace(/[/:]/g, "_");
	const wsPath = join(dir, `${prefix}-ws.json`);
	const wtPath = join(dir, `${prefix}-wt.json`);
	const wsArtifact = JSON.parse(readFileSync(wsPath, "utf8")) as RunArtifact;
	const wtArtifact = JSON.parse(readFileSync(wtPath, "utf8")) as RunArtifact;
	const wsFile = new Uint8Array(readFileSync(wsPath));
	const wtFile = new Uint8Array(readFileSync(wtPath));
	const contract = metricContractForScenario(cell.scenarioId);
	const wsP50 = wsArtifact.metrics?.percentiles?.p50;
	const wtP50 = wtArtifact.metrics?.percentiles?.p50;
	sealedRows.push(
		`| \`${escapeMarkdown(cellId)}\` | ${escapeMarkdown(contract?.unit ?? "?")} | ${wsP50 ?? "-"} | ${wtP50 ?? "-"} | ${wsArtifact.metrics?.samples?.length ?? "-"} | ${wtArtifact.metrics?.samples?.length ?? "-"} |`,
	);

	const result = compareRunArtifacts(wsFile, wtFile, {
		ws: trustContextForArtifact(wsArtifact),
		wt: trustContextForArtifact(wtArtifact),
	});
	if (result.evidenceStatus === "PASS" && result.delta !== "not computed") {
		const delta = result.delta;
		if (contract === undefined) {
			comparisons.push({
				cellId,
				scenarioId: cell.scenarioId,
				status: "INCOMPATIBLE",
				rejectionReason: "Missing primary metric contract",
			});
			rejected++;
			continue;
		}
		comparisons.push({
			cellId,
			scenarioId: cell.scenarioId,
			status: "COMPATIBLE",
			primaryMetricName: delta.metric,
			metricUnit: delta.unit,
			metricDirection: contract.direction,
			wsValue: delta.ws,
			wtValue: delta.wt,
			deltaPercent: delta.relative === null ? undefined : delta.relative * 100,
			winner: result.ranking === "not computed" ? undefined : result.ranking,
			wsLoopUtilization: wsArtifact.loopUtilization,
			wtLoopUtilization: wtArtifact.loopUtilization,
			wsArtifact,
			wtArtifact,
		});
		comparable++;
	} else {
		const blockers: string[] = [];
		const wtSide = (
			result as {
				wt?: { rejections?: readonly { code: string; reason: string }[] };
			}
		).wt;
		const wsSide = (
			result as {
				ws?: { rejections?: readonly { code: string; reason: string }[] };
			}
		).ws;
		for (const side of [wsSide, wtSide]) {
			for (const r of side?.rejections ?? []) {
				blockers.push(`${r.code}: ${r.reason}`);
			}
		}
		comparisons.push({
			cellId,
			scenarioId: cell.scenarioId,
			status: "INCOMPATIBLE",
			rejectionReason:
				blockers.length > 0
					? blockers.join("; ")
					: `compare evidenceStatus=${String(result.evidenceStatus)}`,
			wsLoopUtilization: wsArtifact.loopUtilization,
			wtLoopUtilization: wtArtifact.loopUtilization,
		});
		rejected++;
	}
}

const summary: ComparisonSummary = {
	campaignId,
	generatedAt: new Date().toISOString(),
	totalCells: cells.length,
	comparableCells: comparable,
	rejectedCells: rejected,
	comparisons,
	headerNote:
		"Phase-4 gate subset (not a failed full 35-cell matrix). serverAggregate loop utilization unobserved / non-claim. Formal pair deltas require matching runId + sample counts; sealed p50 table below is the honest measured view when compare is blocked.",
};
let md = renderMarkdownReport(summary);
md += [
	"",
	"## Sealed primary metrics (honest measured view)",
	"",
	"| Cell | Unit | WS p50 | WT p50 | WS samples | WT samples |",
	"| :--- | :---: | ---: | ---: | ---: | ---: |",
	...sealedRows,
	"",
	"Source: median-promoted `*-ws.json` / `*-wt.json` under this campaign root; see `campaign-index.json` for per-rep PASS/FAIL.",
	"",
].join("\n");

const out = join(dir, "report.md");
writeFileSync(out, md);
process.stdout.write(
	`wrote ${out} (${md.length} bytes) formalComparable=${comparable}/${cells.length}\n`,
);
