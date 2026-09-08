/**
 * §6 report rules: attestation labels, the incomplete-attestation caveat, the
 * exact `serverAggregate` label, the sealed-index diagnostic source, and the
 * canonical fanout language.
 */
import { describe, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintPhaseAAttestationFixture } from "../cohort-fixture-signing.ts";
import { FANOUT_COHORT_CELL_IDS, type RunArtifact } from "../evidence.ts";
import {
	armAccountingFromArtifact,
	CLAIM_BOUNDARY_SENTENCE,
	classifyArmAttestation,
	canonicalFanoutLanguage,
	INCOMPLETE_ATTESTATION_CAVEAT,
	main,
	purposeLabel,
	renderArmAccounting,
	SERVER_AGGREGATE_LABEL,
} from "./render-campaign-report.ts";

const CANDIDATE = "a".repeat(40);

/** A sealed artifact reduced to the fields the report reads. */
function seal(partial: {
	readonly p50?: number;
	readonly attested?: boolean;
	readonly cohort?: boolean;
}): unknown {
	return {
		metrics: { percentiles: { p50: partial.p50 ?? 1.5 } },
		attestationEvidence:
			partial.attested === false
				? null
				: {
						schema: "arm-attestation-evidence/v2",
						executionSha256: "b".repeat(64),
						serverObservationEvidence: { schema: "server-observation/v1" },
						cohortObservationEvidence: partial.cohort
							? { schema: "cohort-observation-evidence/v1" }
							: null,
					},
		cohortEvidenceExport: partial.cohort
			? {
					schema: "mac-cohort-evidence-exported-ack/v1",
					cohortObservationEvidenceSha256: "c".repeat(64),
				}
			: null,
	};
}

function campaignRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const dir = join(root, "campaign");
	mkdirSync(dir);
	return dir;
}

function writeIndex(dir: string, index: unknown): void {
	writeFileSync(join(dir, "campaign-index.json"), `${JSON.stringify(index)}\n`);
}

function captureStdio(): {
	readonly out: string[];
	readonly err: string[];
	readonly restore: () => void;
} {
	const out: string[] = [];
	const err: string[] = [];
	const originalOut = process.stdout.write.bind(process.stdout);
	const originalErr = process.stderr.write.bind(process.stderr);
	(process.stdout as { write: unknown }).write = ((chunk: string) => {
		out.push(String(chunk));
		return true;
	}) as typeof process.stdout.write;
	(process.stderr as { write: unknown }).write = ((chunk: string) => {
		err.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	return {
		out,
		err,
		restore: () => {
			(process.stdout as { write: unknown }).write = originalOut;
			(process.stderr as { write: unknown }).write = originalErr;
		},
	};
}

function runMain(argv: readonly string[]): {
	readonly code: number;
	readonly out: string;
	readonly err: string;
} {
	const io = captureStdio();
	let code: number;
	try {
		code = main(argv);
	} finally {
		io.restore();
	}
	return { code, out: io.out.join(""), err: io.err.join("") };
}

describe("render-campaign-report attestation labels", () => {
	it("labels_a_primary_arm_with_a_complete_v2_graph_attested", () => {
		expect(
			classifyArmAttestation({
				cellId: "bulk-one-way/physical",
				armKind: "primary",
				artifact: seal({}) as RunArtifact,
			}),
		).toBe("attested");
	});

	it("labels_a_primary_arm_with_no_attestation_graph_unattested", () => {
		expect(
			classifyArmAttestation({
				cellId: "bulk-one-way/physical",
				armKind: "primary",
				artifact: seal({ attested: false }) as RunArtifact,
			}),
		).toBe("unattested");
	});

	it("labels_a_primary_arm_with_no_seal_at_all_unattested", () => {
		expect(
			classifyArmAttestation({
				cellId: "bulk-one-way/physical",
				armKind: "primary",
				artifact: undefined,
			}),
		).toBe("unattested");
	});

	it("labels_a_fanout_primary_without_cohort_evidence_unattested", () => {
		expect(
			classifyArmAttestation({
				cellId: FANOUT_COHORT_CELL_IDS[0]!,
				armKind: "primary",
				artifact: seal({ cohort: false }) as RunArtifact,
			}),
		).toBe("unattested");
	});

	it("labels_a_fanout_primary_with_cohort_evidence_attested", () => {
		expect(
			classifyArmAttestation({
				cellId: FANOUT_COHORT_CELL_IDS[0]!,
				armKind: "primary",
				artifact: seal({ cohort: true }) as RunArtifact,
			}),
		).toBe("attested");
	});

	it("labels_read_path_and_overlay_arms_not_applicable", () => {
		for (const armKind of ["read-path", "overlay"] as const) {
			expect(
				classifyArmAttestation({
					cellId: FANOUT_COHORT_CELL_IDS[0]!,
					armKind,
					artifact: undefined,
				}),
			).toBe("not-applicable");
		}
	});
});

describe("render-campaign-report section 6 strings", () => {
	it("server_aggregate_label_is_the_exact_section_6_string", () => {
		expect(SERVER_AGGREGATE_LABEL).toBe(
			"aggregate receive-loop work over Linux baseline-to-capture window; transparency only; may exceed 1x window",
		);
	});

	it("purpose_labels_name_the_focused_probe_pilot_and_canonical_campaign", () => {
		expect(purposeLabel("focused")).toBe("focused probe");
		expect(purposeLabel("pilot")).toBe("workload pilot");
		expect(purposeLabel("canonical")).toBe("canonical campaign");
		expect(purposeLabel(undefined)).toBe("unknown purpose");
	});

	it("canonical_fanout_language_requires_sixty_seals_and_six_pairs", () => {
		expect(
			canonicalFanoutLanguage({
				executionPurpose: "canonical",
				measuredPassSeals: 60,
				pairedPromotions: 6,
			}),
		).toContain("Canonical fanout result");
	});

	it("canonical_fanout_language_is_withheld_at_fifty_nine_seals", () => {
		const text = canonicalFanoutLanguage({
			executionPurpose: "canonical",
			measuredPassSeals: 59,
			pairedPromotions: 6,
		});
		expect(text).toContain("NOT A CANONICAL FANOUT RESULT");
		expect(text).toContain("59/60");
	});

	it("canonical_fanout_language_is_withheld_at_five_pairs", () => {
		const text = canonicalFanoutLanguage({
			executionPurpose: "canonical",
			measuredPassSeals: 60,
			pairedPromotions: 5,
		});
		expect(text).toContain("NOT A CANONICAL FANOUT RESULT");
		expect(text).toContain("5/6");
	});

	it("canonical_fanout_language_is_withheld_for_focused_and_pilot", () => {
		for (const purpose of ["focused", "pilot"]) {
			expect(
				canonicalFanoutLanguage({
					executionPurpose: purpose,
					measuredPassSeals: 60,
					pairedPromotions: 6,
				}),
			).toContain("NOT A CANONICAL FANOUT RESULT");
		}
	});
});

describe("render-campaign-report sealed-index", () => {
	it("diagnostic_render_without_flats_writes_index_table", () => {
		const dir = campaignRoot("render-sealed-");
		writeIndex(dir, {
			schema: "campaign-index/v2",
			campaignId: "focused-probe",
			candidate: CANDIDATE,
			executionPurpose: "focused",
			stage: "full",
			cells: ["bulk-one-way/physical"],
			entries: [
				{
					cellId: "bulk-one-way/physical",
					armId: "bulk-one-way/physical/ws",
					transport: "ws",
					armKind: "primary",
					status: "PASS",
					promotable: false,
					repetitionKind: "measured",
					sealedPath: "arms/ws.sealed.json",
					primaryMetricP50: 1.25,
					repetitionIndex: 1,
				},
				{
					cellId: "bulk-one-way/physical",
					armId: "bulk-one-way/physical/wt",
					transport: "wt",
					armKind: "primary",
					status: "PASS",
					promotable: false,
					repetitionKind: "measured",
					sealedPath: "arms/wt.sealed.json",
					primaryMetricP50: 2.5,
					repetitionIndex: 1,
				},
			],
		});
		mkdirSync(join(dir, "arms"));
		writeFileSync(
			join(dir, "arms", "ws.sealed.json"),
			JSON.stringify(seal({ p50: 1.25 })),
		);
		writeFileSync(
			join(dir, "arms", "wt.sealed.json"),
			JSON.stringify(seal({ p50: 2.5 })),
		);
		const report = join(dir, "diagnostic-report.md");
		const { code } = runMain([
			"--source=sealed-index",
			"--allow-non-promotable",
			`--candidate=${CANDIDATE}`,
			"--campaign-id=focused-probe",
			`--campaign-root=${dir}`,
			`--output=${report}`,
		]);
		expect(code).toBe(0);
		const md = readFileSync(report, "utf8");
		expect(md).toContain("Diagnostic campaign report");
		expect(md).toContain("bulk-one-way/physical/ws");
		expect(md).toContain("Promotable");
		expect(md).toContain("Flats: none required");
		// Every arm is labeled, and both of these carry a complete graph.
		expect(md).toContain("Attestation");
		expect(md).toContain("attested");
		expect(md).not.toContain(INCOMPLETE_ATTESTATION_CAVEAT);
		expect(md).toContain(SERVER_AGGREGATE_LABEL);
		expect(md).toContain("focused probe");
		expect(md).toContain("NOT A CANONICAL FANOUT RESULT");
	});

	it("an_included_unattested_primary_forces_the_top_level_caveat", () => {
		const dir = campaignRoot("render-caveat-");
		writeIndex(dir, {
			schema: "campaign-index/v2",
			campaignId: "focused-probe",
			candidate: CANDIDATE,
			executionPurpose: "focused",
			stage: "full",
			cells: [FANOUT_COHORT_CELL_IDS[0]!],
			entries: [
				{
					cellId: FANOUT_COHORT_CELL_IDS[0]!,
					armId: `${FANOUT_COHORT_CELL_IDS[0]!}/ws`,
					transport: "ws",
					armKind: "primary",
					status: "PASS",
					promotable: false,
					repetitionKind: "measured",
					// A fanout primary whose seal carries no cohort evidence.
					sealedPath: "arms/ws.sealed.json",
					primaryMetricP50: 3,
					repetitionIndex: 1,
				},
			],
		});
		mkdirSync(join(dir, "arms"));
		writeFileSync(
			join(dir, "arms", "ws.sealed.json"),
			JSON.stringify(seal({ cohort: false })),
		);
		const report = join(dir, "diagnostic-report.md");
		const { code } = runMain([
			"--source=sealed-index",
			"--allow-non-promotable",
			`--candidate=${CANDIDATE}`,
			"--campaign-id=focused-probe",
			`--campaign-root=${dir}`,
			`--output=${report}`,
		]);
		expect(code).toBe(0);
		const md = readFileSync(report, "utf8");
		expect(md).toContain(INCOMPLETE_ATTESTATION_CAVEAT);
		expect(md).toContain("unattested");
		// The caveat is a top-level statement, not a footnote.
		expect(md.indexOf(INCOMPLETE_ATTESTATION_CAVEAT)).toBeLessThan(
			md.indexOf("## Indexed measured arms"),
		);
	});

	it("a_read_path_arm_is_labeled_not_applicable_and_raises_no_caveat", () => {
		const dir = campaignRoot("render-readpath-");
		writeIndex(dir, {
			schema: "campaign-index/v2",
			campaignId: "focused-probe",
			candidate: CANDIDATE,
			executionPurpose: "pilot",
			stage: "full",
			cells: [FANOUT_COHORT_CELL_IDS[0]!],
			entries: [
				{
					cellId: FANOUT_COHORT_CELL_IDS[0]!,
					armId: `${FANOUT_COHORT_CELL_IDS[0]!}/ws-worker`,
					transport: "ws",
					armKind: "read-path",
					status: "PASS",
					promotable: false,
					repetitionKind: "measured",
					sealedPath: null,
					primaryMetricP50: 4,
					repetitionIndex: 1,
				},
			],
		});
		const report = join(dir, "diagnostic-report.md");
		const { code } = runMain([
			"--source=sealed-index",
			"--allow-non-promotable",
			`--candidate=${CANDIDATE}`,
			"--campaign-id=focused-probe",
			`--campaign-root=${dir}`,
			`--output=${report}`,
		]);
		expect(code).toBe(0);
		const md = readFileSync(report, "utf8");
		expect(md).toContain("not-applicable");
		expect(md).not.toContain(INCOMPLETE_ATTESTATION_CAVEAT);
		expect(md).toContain("workload pilot");
	});

	it("sealed_index_source_creates_no_flats", () => {
		const dir = campaignRoot("render-noflats-");
		writeIndex(dir, {
			schema: "campaign-index/v2",
			campaignId: "focused-probe",
			candidate: CANDIDATE,
			executionPurpose: "focused",
			stage: "full",
			cells: ["bulk-one-way/physical"],
			entries: [],
		});
		const report = join(dir, "diagnostic-report.md");
		const { code } = runMain([
			"--source=sealed-index",
			"--allow-non-promotable",
			`--candidate=${CANDIDATE}`,
			"--campaign-id=focused-probe",
			`--campaign-root=${dir}`,
			`--output=${report}`,
		]);
		expect(code).toBe(0);
		const jsonFiles = readdirSync(dir).filter(
			(name) => name.endsWith(".json") && name !== "campaign-index.json",
		);
		expect(jsonFiles).toEqual([]);
	});
});

describe("render-campaign-report argv", () => {
	it("command_level_run_rejects_an_unknown_source", () => {
		const { code, err } = runMain([
			"--source=guesswork",
			"--campaign-id=x",
			"--campaign-root=/tmp",
		]);
		expect(code).toBe(2);
		expect(err).toContain("unknown --source=guesswork");
	});

	it("command_level_run_without_a_campaign_id_exits_2", () => {
		const { code, err } = runMain([]);
		expect(code).toBe(2);
		expect(err).toContain("usage: render-campaign-report.ts");
	});

	it("command_level_run_with_a_missing_campaign_root_exits_1", () => {
		const { code, err } = runMain([
			"--campaign-id=x",
			`--campaign-root=${join(tmpdir(), "render-absent-root-does-not-exist")}`,
		]);
		expect(code).toBe(1);
		expect(err).toContain("campaign root missing");
	});

	it("command_level_run_with_a_missing_output_parent_exits_1", () => {
		const dir = campaignRoot("render-badout-");
		writeIndex(dir, { schema: "campaign-index/v2", entries: [] });
		const { code, err } = runMain([
			"--source=sealed-index",
			"--campaign-id=x",
			`--campaign-root=${dir}`,
			`--output=${join(dir, "nope", "report.md")}`,
		]);
		expect(code).toBe(1);
		expect(err).toContain("output parent missing");
	});

	it("command_level_positional_argv_still_names_campaign_and_candidate", () => {
		const dir = campaignRoot("render-positional-");
		writeIndex(dir, {
			schema: "campaign-index/v2",
			campaignId: "positional-campaign",
			candidate: CANDIDATE,
			executionPurpose: "focused",
			stage: "full",
			cells: [],
			entries: [],
		});
		const report = join(dir, "diagnostic-report.md");
		const { code } = runMain([
			"positional-campaign",
			CANDIDATE,
			`--campaign-root=${dir}`,
			`--output=${report}`,
			"--allow-non-promotable",
		]);
		// No flats exist, so the flats renderer fails and the focused index
		// falls through to the sealed-index diagnostic rather than failing a
		// valid zero-flat campaign.
		expect(code).toBe(0);
		expect(readFileSync(report, "utf8")).toContain(
			"Diagnostic campaign report",
		);
	});
});

describe("render-campaign-report promoted flats", () => {
	/** A flat with just enough shape for the renderer's own reads. */
	function flat(partial: {
		readonly p50: number;
		readonly cohort?: boolean;
		readonly attested?: boolean;
	}): string {
		return JSON.stringify({
			...(seal(partial) as Record<string, unknown>),
			comparisonId: "promoted-campaign",
			runId: "run-1",
			transport: "ws",
			source: {
				sourceSha: CANDIDATE,
				archiveSha256: "d".repeat(64),
				executableSha256: "e".repeat(64),
				toolchains: {},
			},
			rawSidecarDigests: {},
			metrics: {
				percentiles: { p50: partial.p50 },
				samples: [partial.p50],
			},
		});
	}

	function promotedRoot(prefix: string, opts: { readonly cohort: boolean }) {
		const dir = campaignRoot(prefix);
		const cellId = FANOUT_COHORT_CELL_IDS[0]!;
		const safe = cellId.replace(/[/:]/g, "_");
		writeFileSync(join(dir, `${safe}-ws.json`), flat({ p50: 1, ...opts }));
		writeFileSync(join(dir, `${safe}-wt.json`), flat({ p50: 2, ...opts }));
		writeIndex(dir, {
			schema: "campaign-index/v2",
			campaignId: "promoted-campaign",
			candidate: CANDIDATE,
			executionPurpose: "canonical",
			stage: "full",
			cells: [cellId],
			entries: [],
		});
		return { dir, cellId };
	}

	it("promoted_report_heads_one_section_per_arm_with_its_attestation_label", () => {
		const { dir } = promotedRoot("render-promoted-", { cohort: true });
		const report = join(dir, "campaign-report.md");
		const { code } = runMain([
			"--campaign-id=promoted-campaign",
			`--candidate=${CANDIDATE}`,
			`--campaign-root=${dir}`,
			`--output=${report}`,
		]);
		expect(code).toBe(0);
		const md = readFileSync(report, "utf8");
		// The frozen run wrapper counts exactly these headings.
		expect(md).toMatch(/^### WS attested arm/m);
		expect(md).toMatch(/^### WT attested arm/m);
		expect(md).not.toContain(INCOMPLETE_ATTESTATION_CAVEAT);
		expect(md).toContain(SERVER_AGGREGATE_LABEL);
	});

	it("promoted_report_with_an_unattested_primary_carries_the_top_level_caveat", () => {
		const { dir } = promotedRoot("render-promoted-bad-", { cohort: false });
		const report = join(dir, "campaign-report.md");
		const { code } = runMain([
			"--campaign-id=promoted-campaign",
			`--candidate=${CANDIDATE}`,
			`--campaign-root=${dir}`,
			`--output=${report}`,
		]);
		expect(code).toBe(0);
		const md = readFileSync(report, "utf8");
		expect(md).toMatch(/^### WS unattested arm/m);
		expect(md).toContain(INCOMPLETE_ATTESTATION_CAVEAT);
		// The caveat leads the document.
		expect(md.indexOf(INCOMPLETE_ATTESTATION_CAVEAT)).toBeLessThan(100);
	});

	it("promoted_report_withholds_canonical_fanout_language_below_six_pairs", () => {
		const { dir } = promotedRoot("render-promoted-one-", { cohort: true });
		const report = join(dir, "campaign-report.md");
		runMain([
			"--campaign-id=promoted-campaign",
			`--candidate=${CANDIDATE}`,
			`--campaign-root=${dir}`,
			`--output=${report}`,
		]);
		const md = readFileSync(report, "utf8");
		expect(md).toContain("NOT A CANONICAL FANOUT RESULT");
		expect(md).toContain("1/6 paired promotions");
	});
});

describe("render-campaign-report per-arm accounting (amendment D6)", () => {
	it("prints_the_three_attested_figures_with_their_window_shares_and_the_claim_boundary", () => {
		const fx = mintPhaseAAttestationFixture({
			busyMs: 250,
			spanMs: 1_000,
			serverChildCpu: { processMs: 700, mainThreadMs: 310, windowMs: 1_000 },
		});
		const accounting = armAccountingFromArtifact({
			cellId: "bulk-one-way/physical",
			armKind: "primary",
			artifact: {
				...(seal({}) as Record<string, unknown>),
				transport: "ws",
				attestationEvidence: fx.attestation,
			} as unknown as RunArtifact,
		});
		expect(accounting.topology).toBeNull();
		expect(accounting.totals).toBeNull();
		expect(accounting.busy).toEqual({ busyMs: 250, windowMs: 1_000 });
		expect(accounting.cpu).toEqual({
			processMs: 700,
			mainThreadMs: 310,
			windowMs: 1_000,
		});
		const lines = renderArmAccounting(accounting);
		expect(lines).toEqual([
			"- busyMs (relay timed spans on the server child's JS thread): 250 ms (25.0% of the 1000 ms window)",
			"- Server-child main-thread CPU (rig-read utime+stime): 310 ms (31.0% of the 1000 ms window)",
			"- Server-child process CPU (rig-read utime+stime): 700 ms (70.0% of the 1000 ms window)",
			`- ${CLAIM_BOUNDARY_SENTENCE}`,
		]);
	});

	it("a_seal_without_the_signed_records_prints_the_figures_as_not_attested", () => {
		const accounting = armAccountingFromArtifact({
			cellId: "bulk-one-way/physical",
			armKind: "primary",
			artifact: seal({}) as RunArtifact,
		});
		expect(accounting.busy).toBeNull();
		expect(accounting.cpu).toBeNull();
		const lines = renderArmAccounting(accounting);
		expect(lines[0]).toContain("busyMs");
		expect(lines[0]).toContain("not attested");
		expect(lines[1]).toContain("main-thread CPU");
		expect(lines[1]).toContain("not attested");
		expect(lines[2]).toContain("process CPU");
		expect(lines[2]).toContain("not attested");
		expect(lines[3]).toBe(`- ${CLAIM_BOUNDARY_SENTENCE}`);
	});

	it("the_diagnostic_report_heads_every_measured_arm_with_its_accounting_and_keeps_its_label", () => {
		const dir = campaignRoot("render-accounting-");
		const fx = mintPhaseAAttestationFixture({
			busyMs: 250,
			spanMs: 1_000,
			serverChildCpu: { processMs: 700, mainThreadMs: 310, windowMs: 1_000 },
		});
		writeIndex(dir, {
			schema: "campaign-index/v2",
			campaignId: "fanout-pilot-r1",
			candidate: CANDIDATE,
			executionPurpose: "pilot",
			stage: "full",
			cells: ["bulk-one-way/physical"],
			entries: [
				{
					cellId: "bulk-one-way/physical",
					armId: "bulk-one-way/physical/ws",
					transport: "ws",
					armKind: "primary",
					status: "PASS",
					promotable: false,
					repetitionKind: "measured",
					sealedPath: "arms/ws.sealed.json",
					primaryMetricP50: 1.25,
					repetitionIndex: 1,
				},
			],
		});
		mkdirSync(join(dir, "arms"));
		writeFileSync(
			join(dir, "arms", "ws.sealed.json"),
			JSON.stringify({
				...(seal({ p50: 1.25 }) as Record<string, unknown>),
				transport: "ws",
				attestationEvidence: fx.attestation,
			}),
		);
		const report = join(dir, "diagnostic-report.md");
		const { code } = runMain([
			"--source=sealed-index",
			"--allow-non-promotable",
			`--candidate=${CANDIDATE}`,
			"--campaign-id=fanout-pilot-r1",
			`--campaign-root=${dir}`,
			`--output=${report}`,
		]);
		expect(code).toBe(0);
		const md = readFileSync(report, "utf8");
		expect(md.startsWith("# Diagnostic campaign report")).toBe(true);
		expect(md).toContain("NON-PROMOTABLE PILOT EVIDENCE");
		expect(md).toContain("## Per-arm accounting");
		expect(md).toContain("### `bulk-one-way/physical/ws` (ws, attested)");
		expect(md).toContain(
			"busyMs (relay timed spans on the server child's JS thread): 250 ms (25.0% of the 1000 ms window)",
		);
		expect(md).toContain(
			"Server-child main-thread CPU (rig-read utime+stime): 310 ms (31.0% of the 1000 ms window)",
		);
		expect(md).toContain(
			"Server-child process CPU (rig-read utime+stime): 700 ms (70.0% of the 1000 ms window)",
		);
		expect(md).toContain(CLAIM_BOUNDARY_SENTENCE);
	});
});
