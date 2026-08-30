/**
 * Render report.md for a sealed campaign root from promoted primary flats.
 *
 * Usage:
 *   bun tools/compare/bin/render-campaign-report.ts <campaignId> [candidate]
 *
 * Discovers `{cellSafe}-ws.json` / `{cellSafe}-wt.json` under the official
 * root. Prefer formal `compareRunArtifacts` when pairing rules pass; otherwise
 * emit an honest sealed p50 table and name the blockers.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

const campaignId = process.argv[2];
const candidate = process.argv[3] ?? "ws-wt-r0";
if (campaignId === undefined || campaignId.length === 0) {
	process.stderr.write(
		"usage: render-campaign-report.ts <campaignId> [candidate]\n",
	);
	process.exit(2);
}

const dir = join(
	".release-evidence/transport-comparison",
	candidate,
	campaignId,
);
if (!existsSync(dir)) {
	process.stderr.write(`campaign root missing: ${dir}\n`);
	process.exit(1);
}

const cellIdsFromFlats = new Set<string>();
for (const name of readdirSync(dir)) {
	const match = /^(.*)-ws\.json$/.exec(name);
	if (match === null) continue;
	const safe = match[1]!;
	if (!existsSync(join(dir, `${safe}-wt.json`))) continue;
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(c) => c.cellId.replace(/[/:]/g, "_") === safe,
	);
	if (cell !== undefined) cellIdsFromFlats.add(cell.cellId);
}

let cells = [...cellIdsFromFlats].sort();
const indexPath = join(dir, "campaign-index.json");
if (existsSync(indexPath)) {
	try {
		const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
			cells?: unknown;
			stage?: unknown;
		};
		if (
			Array.isArray(index.cells) &&
			index.cells.every((c) => typeof c === "string")
		) {
			const indexed = (index.cells as string[]).filter((cellId) => {
				const safe = cellId.replace(/[/:]/g, "_");
				return (
					existsSync(join(dir, `${safe}-ws.json`)) &&
					existsSync(join(dir, `${safe}-wt.json`))
				);
			});
			if (indexed.length > 0) cells = indexed;
		}
	} catch {
		// keep flat discovery
	}
}

if (cells.length === 0) {
	process.stderr.write(`no promoted primary pairs under ${dir}\n`);
	process.exit(1);
}

const comparisons: CellComparison[] = [];
let comparable = 0;
let rejected = 0;
const sealedRows: string[] = [];
let stageNote = "Full sealed campaign report.";
try {
	if (existsSync(indexPath)) {
		const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
			stage?: unknown;
			entries?: unknown;
		};
		if (index.stage === "phase4") {
			stageNote = "Phase-4 gate subset (not a failed full 35-cell matrix).";
		} else if (index.stage === "full") {
			const entries = Array.isArray(index.entries) ? index.entries.length : "?";
			stageNote = `Full matrix campaign index entries=${String(entries)}.`;
		}
	}
} catch {
	// keep default note
}

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
			deltaPercent: delta.deltaPercent,
			winner: delta.winner,
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
	headerNote: `${stageNote} serverAggregate loop utilization unobserved / non-claim. Sealed p50 table below is the honest measured view when formal compare is blocked.`,
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
