/**
 * Render campaign report from promoted flats and/or sealed campaign-index.
 *
 * Usage (legacy flats):
 *   bun tools/compare/bin/render-campaign-report.ts <campaignId> [candidate]
 *
 * Usage (focused/pilot diagnostic, zero flats):
 *   bun tools/compare/bin/render-campaign-report.ts \
 *     --source=sealed-index --allow-non-promotable \
 *     --candidate=... --campaign-id=... \
 *     --campaign-root=... --output=.../diagnostic-report.md
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { compareRunArtifacts, trustContextForArtifact } from "../compare.ts";
import { metricContractForScenario, type RunArtifact } from "../evidence.ts";
import {
	escapeMarkdown,
	renderMarkdownReport,
	type CellComparison,
	type ComparisonSummary,
} from "../render-report.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "../scenario-registry.ts";

function parseFlag(argv: readonly string[], name: string): string | undefined {
	const prefix = `--${name}=`;
	for (const arg of argv) {
		if (arg.startsWith(prefix)) return arg.slice(prefix.length);
	}
	return undefined;
}

function hasFlag(argv: readonly string[], name: string): boolean {
	return argv.includes(`--${name}`);
}

type IndexEntry = {
	readonly cellId?: string;
	readonly armId?: string;
	readonly transport?: string;
	readonly status?: string;
	readonly promotable?: boolean;
	readonly sealedPath?: string | null;
	readonly primaryMetricP50?: number | null;
	readonly repetitionIndex?: number;
};

type CampaignIndex = {
	readonly campaignId?: string;
	readonly candidate?: string;
	readonly executionPurpose?: string;
	readonly stage?: string;
	readonly cells?: readonly string[];
	readonly entries?: readonly IndexEntry[];
};

function renderSealedIndexDiagnostic(args: {
	readonly dir: string;
	readonly campaignId: string;
	readonly candidate: string;
	readonly outputPath: string;
	readonly allowNonPromotable: boolean;
}): number {
	const indexPath = join(args.dir, "campaign-index.json");
	if (!existsSync(indexPath)) {
		process.stderr.write(`sealed-index render missing ${indexPath}\n`);
		return 1;
	}
	let index: CampaignIndex;
	try {
		index = JSON.parse(readFileSync(indexPath, "utf8")) as CampaignIndex;
	} catch (error) {
		process.stderr.write(`sealed-index parse failed: ${String(error)}\n`);
		return 1;
	}
	const entries = Array.isArray(index.entries) ? index.entries : [];
	const rows: string[] = [];
	for (const entry of entries) {
		const cellId = String(entry.cellId ?? "");
		const armId = String(entry.armId ?? "");
		const transport = String(entry.transport ?? "");
		const status = String(entry.status ?? "");
		const promotable = entry.promotable === true;
		if (!args.allowNonPromotable && !promotable && status === "PASS") {
			continue;
		}
		let p50: string | number = entry.primaryMetricP50 ?? "-";
		const sealedRel = entry.sealedPath;
		if (typeof sealedRel === "string" && sealedRel.length > 0) {
			const sealedAbs = resolve(args.dir, sealedRel);
			if (existsSync(sealedAbs)) {
				try {
					const art = JSON.parse(
						readFileSync(sealedAbs, "utf8"),
					) as RunArtifact;
					p50 = art.metrics?.percentiles?.p50 ?? p50;
				} catch {
					// keep index p50
				}
			}
		}
		rows.push(
			`| \`${escapeMarkdown(cellId)}\` | \`${escapeMarkdown(armId)}\` | ${escapeMarkdown(transport)} | ${escapeMarkdown(status)} | ${promotable} | ${escapeMarkdown(String(sealedRel ?? ""))} | ${p50} |`,
		);
	}
	const purpose = String(index.executionPurpose ?? "unknown");
	const stage = String(index.stage ?? "unknown");
	const purposeBanner =
		purpose === "focused"
			? "NON-PROMOTABLE FOCUSED EVIDENCE"
			: purpose === "pilot"
				? "NON-PROMOTABLE PILOT EVIDENCE"
				: "NON-PROMOTABLE DIAGNOSTIC EVIDENCE";
	const md = [
		`# Diagnostic campaign report`,
		``,
		purposeBanner,
		``,
		`- Campaign ID: \`${escapeMarkdown(args.campaignId)}\``,
		`- Candidate: \`${escapeMarkdown(args.candidate)}\``,
		`- Execution purpose: \`${escapeMarkdown(purpose)}\``,
		`- Index stage: \`${escapeMarkdown(stage)}\``,
		`- Flats: none required (sealed-index diagnostic; allowNonPromotable=${args.allowNonPromotable})`,
		`- serverAggregate: transparency-only / non-claim`,
		``,
		`## Indexed measured arms`,
		``,
		`| Cell | Arm | Transport | Status | Promotable | Sealed path | p50 |`,
		`| :--- | :--- | :---: | :---: | :---: | :--- | ---: |`,
		...rows,
		``,
		`Source: \`campaign-index.json\` sealed paths under this campaign root. No promoted flats.`,
		``,
	].join("\n");
	writeFileSync(args.outputPath, md);
	process.stdout.write(
		`wrote ${args.outputPath} (${md.length} bytes) sealedIndexEntries=${entries.length}\n`,
	);
	return 0;
}

function renderFromFlats(args: {
	readonly dir: string;
	readonly campaignId: string;
	readonly outputPath: string;
}): number {
	const cellIdsFromFlats = new Set<string>();
	for (const name of readdirSync(args.dir)) {
		const match = /^(.*)-ws\.json$/.exec(name);
		if (match === null) continue;
		const safe = match[1]!;
		if (!existsSync(join(args.dir, `${safe}-wt.json`))) continue;
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(c) => c.cellId.replace(/[/:]/g, "_") === safe,
		);
		if (cell !== undefined) cellIdsFromFlats.add(cell.cellId);
	}

	let cells = [...cellIdsFromFlats].sort();
	const indexPath = join(args.dir, "campaign-index.json");
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
						existsSync(join(args.dir, `${safe}-ws.json`)) &&
						existsSync(join(args.dir, `${safe}-wt.json`))
					);
				});
				if (indexed.length > 0) cells = indexed;
			}
		} catch {
			// keep flat discovery
		}
	}

	if (cells.length === 0) {
		process.stderr.write(`no promoted primary pairs under ${args.dir}\n`);
		return 1;
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
				const entries = Array.isArray(index.entries)
					? index.entries.length
					: "?";
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
		const wsPath = join(args.dir, `${prefix}-ws.json`);
		const wtPath = join(args.dir, `${prefix}-wt.json`);
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
		campaignId: args.campaignId,
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

	writeFileSync(args.outputPath, md);
	process.stdout.write(
		`wrote ${args.outputPath} (${md.length} bytes) formalComparable=${comparable}/${cells.length}\n`,
	);
	return 0;
}

const argv = process.argv.slice(2);
const source = parseFlag(argv, "source") ?? "flats";
const allowNonPromotable = hasFlag(argv, "allow-non-promotable");
const outputFlag = parseFlag(argv, "output");
const campaignRootFlag = parseFlag(argv, "campaign-root");
const candidateFlag = parseFlag(argv, "candidate");
const campaignIdFlag = parseFlag(argv, "campaign-id");

const positional = argv.filter((a) => !a.startsWith("--"));
const campaignId = campaignIdFlag ?? positional[0];
const candidate = candidateFlag ?? positional[1] ?? "ws-wt-r0";

if (campaignId === undefined || campaignId.length === 0) {
	process.stderr.write(
		"usage: render-campaign-report.ts <campaignId> [candidate]\n" +
			"   or: --source=sealed-index --allow-non-promotable --campaign-id=... --candidate=... --campaign-root=... --output=...\n",
	);
	process.exit(2);
}

const dir =
	campaignRootFlag ??
	join(".release-evidence/transport-comparison", candidate, campaignId);
if (!existsSync(dir)) {
	process.stderr.write(`campaign root missing: ${dir}\n`);
	process.exit(1);
}

const outputPath =
	outputFlag ??
	join(dir, source === "sealed-index" ? "diagnostic-report.md" : "report.md");
if (outputFlag) {
	const parent = dirname(outputPath);
	if (!existsSync(parent)) {
		process.stderr.write(`output parent missing: ${parent}\n`);
		process.exit(1);
	}
}

let code: number;
if (source === "sealed-index") {
	code = renderSealedIndexDiagnostic({
		dir,
		campaignId,
		candidate,
		outputPath,
		allowNonPromotable,
	});
} else {
	code = renderFromFlats({ dir, campaignId, outputPath });
	// Focused/pilot may still invoke positional argv with EXPECTED_FLATS=0.
	// Prefer sealed-index diagnostic over failing a valid zero-flat campaign.
	if (code !== 0 && existsSync(join(dir, "campaign-index.json"))) {
		let purpose: string | undefined;
		try {
			const idx = JSON.parse(
				readFileSync(join(dir, "campaign-index.json"), "utf8"),
			) as CampaignIndex;
			purpose =
				typeof idx.executionPurpose === "string"
					? idx.executionPurpose
					: undefined;
		} catch {
			purpose = undefined;
		}
		if (allowNonPromotable || purpose === "focused" || purpose === "pilot") {
			code = renderSealedIndexDiagnostic({
				dir,
				campaignId,
				candidate,
				outputPath: outputFlag ?? join(dir, "diagnostic-report.md"),
				allowNonPromotable: true,
			});
		}
	}
}
process.exit(code);
