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
import {
	FANOUT_COHORT_CELL_IDS,
	metricContractForScenario,
	requiresCohortObservationEvidence,
	type ArmKind,
	type RunArtifact,
} from "../evidence.ts";
import {
	CANONICAL_FANOUT_CELL_COUNT,
	CANONICAL_FANOUT_MEASURED_SEAL_COUNT,
} from "../output-policy.ts";
import {
	escapeMarkdown,
	renderMarkdownReport,
	type CellComparison,
	type ComparisonSummary,
} from "../render-report.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "../scenario-registry.ts";

/**
 * §6 report rule 2, verbatim.
 *
 * `serverAggregate` sums the receive loop's work across the whole
 * baseline-to-capture window, so on a multi-session arm it legitimately
 * exceeds one window of wall time. It is published so the number is not
 * hidden, and it is labeled so nobody reads it as a saturation claim. The
 * string is exported because the report is not the only consumer that has to
 * say it identically.
 */
export const SERVER_AGGREGATE_LABEL =
	"aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window";

/** §6 report rule 1: one unattested primary arm caveats the whole document. */
export const INCOMPLETE_ATTESTATION_CAVEAT =
	"INCOMPLETE ATTESTATION: this report includes at least one primary arm with no complete attestation evidence. No ranking or capacity statement in it is attested.";

export type ArmAttestationLabel = "attested" | "unattested" | "not-applicable";

const PURPOSE_LABEL: Readonly<Record<string, string>> = Object.freeze({
	focused: "focused probe",
	pilot: "workload pilot",
	canonical: "canonical campaign",
});

export function purposeLabel(purpose: string | undefined): string {
	return PURPOSE_LABEL[purpose ?? ""] ?? "unknown purpose";
}

/**
 * What this arm's evidence actually proves, asked structurally.
 *
 * Only a primary arm makes an attested claim: the read-path and overlay arms
 * share the wire but carry no receipt graph of their own, so they are
 * `not-applicable` rather than being counted as failures. A primary arm is
 * `attested` only when the artifact carries the v2 receipt graph *and*, on one
 * of the six cohort cells, the cohort export and its receipt. Anything else --
 * an entry with no seal, a seal with no attestation, a fanout arm whose cohort
 * evidence is absent -- is `unattested`, which is the state that caveats the
 * document.
 */
export function classifyArmAttestation(input: {
	readonly cellId: string;
	readonly armKind: ArmKind;
	readonly artifact: RunArtifact | undefined;
}): ArmAttestationLabel {
	if (input.armKind !== "primary") return "not-applicable";
	const attestation = input.artifact?.attestationEvidence as
		| {
				readonly schema?: string;
				readonly serverObservationEvidence?: unknown;
				readonly cohortObservationEvidence?: unknown;
		  }
		| undefined;
	if (
		attestation?.schema !== "arm-attestation-evidence/v2" ||
		attestation.serverObservationEvidence === null ||
		attestation.serverObservationEvidence === undefined
	) {
		return "unattested";
	}
	if (requiresCohortObservationEvidence(input.cellId, input.armKind)) {
		const cohort = attestation.cohortObservationEvidence;
		if (cohort === null || cohort === undefined) return "unattested";
		if (
			input.artifact?.cohortEvidenceExport === null ||
			input.artifact?.cohortEvidenceExport === undefined
		) {
			return "unattested";
		}
	}
	return "attested";
}

/**
 * §6 report rule 4: the canonical fanout language is earned by 60 fresh
 * measured PASS seals and six paired promotions, or it is not said.
 */
export function canonicalFanoutLanguage(input: {
	readonly executionPurpose: string | undefined;
	readonly measuredPassSeals: number;
	readonly pairedPromotions: number;
}): string {
	if (
		input.executionPurpose === "canonical" &&
		input.measuredPassSeals === CANONICAL_FANOUT_MEASURED_SEAL_COUNT &&
		input.pairedPromotions === CANONICAL_FANOUT_CELL_COUNT
	) {
		return `Canonical fanout result: all ${CANONICAL_FANOUT_CELL_COUNT} primary fanout cells promoted as WS/WT pairs from ${CANONICAL_FANOUT_MEASURED_SEAL_COUNT} fresh measured PASS seals.`;
	}
	return `NOT A CANONICAL FANOUT RESULT: ${input.pairedPromotions}/${CANONICAL_FANOUT_CELL_COUNT} paired promotions from ${input.measuredPassSeals}/${CANONICAL_FANOUT_MEASURED_SEAL_COUNT} measured PASS seals.`;
}

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
	readonly armKind?: string;
	readonly status?: string;
	readonly promotable?: boolean;
	readonly sealedPath?: string | null;
	readonly primaryMetricP50?: number | null;
	readonly repetitionIndex?: number;
	readonly repetitionKind?: string;
	readonly executionPurpose?: string;
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
	let unattestedPrimaries = 0;
	let measuredPassSeals = 0;
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
		// §6 rule 3: sealed rep paths are read recursively from the index. The
		// artifact is the authority for its own numbers; the index p50 is only
		// the fallback when the seal is unreadable.
		let artifact: RunArtifact | undefined;
		if (typeof sealedRel === "string" && sealedRel.length > 0) {
			const sealedAbs = resolve(args.dir, sealedRel);
			if (existsSync(sealedAbs)) {
				try {
					artifact = JSON.parse(readFileSync(sealedAbs, "utf8")) as RunArtifact;
					p50 = artifact.metrics?.percentiles?.p50 ?? p50;
				} catch {
					artifact = undefined;
				}
			}
		}
		const armKind = (entry.armKind ?? "primary") as ArmKind;
		const attestation = classifyArmAttestation({ cellId, armKind, artifact });
		if (attestation === "unattested") unattestedPrimaries += 1;
		if (
			armKind === "primary" &&
			status === "PASS" &&
			entry.repetitionKind === "measured" &&
			typeof sealedRel === "string" &&
			sealedRel.length > 0 &&
			FANOUT_COHORT_CELL_IDS.includes(cellId)
		) {
			measuredPassSeals += 1;
		}
		rows.push(
			`| \`${escapeMarkdown(cellId)}\` | \`${escapeMarkdown(armId)}\` | ${escapeMarkdown(transport)} | ${escapeMarkdown(status)} | ${promotable} | ${attestation} | ${escapeMarkdown(String(sealedRel ?? ""))} | ${p50} |`,
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
		...(unattestedPrimaries > 0
			? [
					`> ${INCOMPLETE_ATTESTATION_CAVEAT} (${unattestedPrimaries} unattested primary arm${unattestedPrimaries === 1 ? "" : "s"})`,
					``,
				]
			: []),
		`- Campaign ID: \`${escapeMarkdown(args.campaignId)}\``,
		`- Candidate: \`${escapeMarkdown(args.candidate)}\``,
		`- Execution purpose: \`${escapeMarkdown(purpose)}\` (${purposeLabel(purpose)})`,
		`- Index stage: \`${escapeMarkdown(stage)}\``,
		`- Flats: none required (sealed-index diagnostic; allowNonPromotable=${args.allowNonPromotable})`,
		`- serverAggregate: ${SERVER_AGGREGATE_LABEL}`,
		``,
		canonicalFanoutLanguage({
			executionPurpose: purpose,
			measuredPassSeals,
			// A sealed-index diagnostic reads no flats by construction, so it
			// never has a paired promotion to report.
			pairedPromotions: 0,
		}),
		``,
		`## Indexed measured arms`,
		``,
		`| Cell | Arm | Transport | Status | Promotable | Attestation | Sealed path | p50 |`,
		`| :--- | :--- | :---: | :---: | :---: | :---: | :--- | ---: |`,
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
	const armSections: string[] = [];
	let unattestedPrimaries = 0;
	let pairedFanoutPromotions = 0;
	let measuredFanoutPassSeals = 0;
	let indexPurpose: string | undefined;
	let stageNote = "Full sealed campaign report.";
	try {
		if (existsSync(indexPath)) {
			const index = JSON.parse(readFileSync(indexPath, "utf8")) as CampaignIndex;
			if (index.stage === "phase4") {
				stageNote = "Phase-4 gate subset (not a failed full 35-cell matrix).";
			} else if (index.stage === "full") {
				const entries = Array.isArray(index.entries)
					? index.entries.length
					: "?";
				stageNote = `Full matrix campaign index entries=${String(entries)}.`;
			}
			indexPurpose =
				typeof index.executionPurpose === "string"
					? index.executionPurpose
					: undefined;
			for (const entry of index.entries ?? []) {
				if (
					(entry.armKind ?? "primary") === "primary" &&
					entry.status === "PASS" &&
					entry.repetitionKind === "measured" &&
					typeof entry.sealedPath === "string" &&
					entry.sealedPath.length > 0 &&
					FANOUT_COHORT_CELL_IDS.includes(String(entry.cellId ?? ""))
				) {
					measuredFanoutPassSeals += 1;
				}
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
		// §6 rule 1: label both arms of the pair, and remember whether either
		// one leaves the document uncaveated.
		const wsAttestation = classifyArmAttestation({
			cellId,
			armKind: "primary",
			artifact: wsArtifact,
		});
		const wtAttestation = classifyArmAttestation({
			cellId,
			armKind: "primary",
			artifact: wtArtifact,
		});
		if (wsAttestation === "unattested") unattestedPrimaries += 1;
		if (wtAttestation === "unattested") unattestedPrimaries += 1;
		if (FANOUT_COHORT_CELL_IDS.includes(cellId)) pairedFanoutPromotions += 1;
		// One section per promoted arm, headed by the label itself. A reader
		// scanning headings sees the attestation state without reading a table,
		// and the frozen run wrapper counts these headings to prove that every
		// promoted arm in a canonical campaign is attested.
		for (const [wire, label, artifact] of [
			["WS", wsAttestation, wsArtifact],
			["WT", wtAttestation, wtArtifact],
		] as const) {
			armSections.push(
				`### ${wire} ${label} arm — \`${escapeMarkdown(cellId)}\``,
				"",
				`- p50: ${artifact.metrics?.percentiles?.p50 ?? "-"} ${contract?.unit ?? "?"}`,
				`- serverAggregate: ${SERVER_AGGREGATE_LABEL}`,
				"",
			);
		}
		sealedRows.push(
			`| \`${escapeMarkdown(cellId)}\` | ${escapeMarkdown(contract?.unit ?? "?")} | ${wsP50 ?? "-"} | ${wtP50 ?? "-"} | ${wsArtifact.metrics?.samples?.length ?? "-"} | ${wtArtifact.metrics?.samples?.length ?? "-"} | ${wsAttestation} | ${wtAttestation} |`,
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
				deltaPercent:
					delta.relative === null ? undefined : delta.relative * 100,
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
		campaignId: args.campaignId,
		generatedAt: new Date().toISOString(),
		totalCells: cells.length,
		comparableCells: comparable,
		rejectedCells: rejected,
		comparisons,
		headerNote:
			`${stageNote} Execution purpose: ${purposeLabel(indexPurpose)}. ` +
			`serverAggregate: ${SERVER_AGGREGATE_LABEL}. ` +
			`Sealed p50 table below is the honest measured view when formal compare is blocked.`,
	};
	let md = renderMarkdownReport(summary);
	// The caveat is a top-level statement about the whole document, so it goes
	// above the per-cell tables rather than in a footnote nobody reads.
	if (unattestedPrimaries > 0) {
		md = `> ${INCOMPLETE_ATTESTATION_CAVEAT} (${unattestedPrimaries} unattested primary arm${unattestedPrimaries === 1 ? "" : "s"})\n\n${md}`;
	}
	md += [
		"",
		"## Sealed primary metrics (honest measured view)",
		"",
		"| Cell | Unit | WS p50 | WT p50 | WS samples | WT samples | WS attestation | WT attestation |",
		"| :--- | :---: | ---: | ---: | ---: | ---: | :---: | :---: |",
		...sealedRows,
		"",
		"## Per-arm attestation",
		"",
		...armSections,
		canonicalFanoutLanguage({
			executionPurpose: indexPurpose,
			measuredPassSeals: measuredFanoutPassSeals,
			pairedPromotions: pairedFanoutPromotions,
		}),
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

export const RENDER_CAMPAIGN_REPORT_USAGE =
	"usage: render-campaign-report.ts <campaignId> [candidate]\n" +
	"   or: --source=sealed-index --allow-non-promotable --campaign-id=... --candidate=... --campaign-root=... --output=...\n";

/**
 * The documented argv contract, exported so a test can execute it directly.
 *
 * `--source` accepts exactly `flats` and `sealed-index`; an unknown source is
 * a refusal rather than a silent fall back to flats, because falling back
 * would turn a request for the non-promotable diagnostic view into a report
 * that reads as promoted.
 */
export function main(argv: readonly string[]): number {
	const source = parseFlag(argv, "source") ?? "flats";
	if (source !== "flats" && source !== "sealed-index") {
		process.stderr.write(`unknown --source=${source}\n`);
		return 2;
	}
	const allowNonPromotable = hasFlag(argv, "allow-non-promotable");
	const outputFlag = parseFlag(argv, "output");
	const campaignRootFlag = parseFlag(argv, "campaign-root");
	const candidateFlag = parseFlag(argv, "candidate");
	const campaignIdFlag = parseFlag(argv, "campaign-id");

	const positional = argv.filter((a) => !a.startsWith("--"));
	const campaignId = campaignIdFlag ?? positional[0];
	const candidate = candidateFlag ?? positional[1] ?? "ws-wt-r0";

	if (campaignId === undefined || campaignId.length === 0) {
		process.stderr.write(RENDER_CAMPAIGN_REPORT_USAGE);
		return 2;
	}

	const dir =
		campaignRootFlag ??
		join(".release-evidence/transport-comparison", candidate, campaignId);
	if (!existsSync(dir)) {
		process.stderr.write(`campaign root missing: ${dir}\n`);
		return 1;
	}

	const outputPath =
		outputFlag ??
		join(dir, source === "sealed-index" ? "diagnostic-report.md" : "report.md");
	if (outputFlag) {
		const parent = dirname(outputPath);
		if (!existsSync(parent)) {
			process.stderr.write(`output parent missing: ${parent}\n`);
			return 1;
		}
	}

	if (source === "sealed-index") {
		// §6 rule 3: the diagnostic reads sealed rep paths and writes exactly one
		// markdown file. It has no promotion path and cannot create a flat.
		return renderSealedIndexDiagnostic({
			dir,
			campaignId,
			candidate,
			outputPath,
			allowNonPromotable,
		});
	}
	let code = renderFromFlats({ dir, campaignId, outputPath });
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
	return code;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
