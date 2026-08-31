/**
 * Sealed-index diagnostic render (focused/pilot: zero flats).
 */
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("render-campaign-report sealed-index", () => {
	it("diagnostic_render_without_flats_writes_index_table", async () => {
		const root = mkdtempSync(join(tmpdir(), "render-sealed-"));
		const out = join(root, "campaign");
		mkdirSync(out);
		writeFileSync(
			join(out, "campaign-index.json"),
			`${JSON.stringify({
				schema: "campaign-index/v2",
				campaignId: "focused-probe",
				candidate: "a".repeat(40),
				executionPurpose: "focused",
				stage: "full",
				cells: ["bulk-one-way/physical"],
				entries: [
					{
						cellId: "bulk-one-way/physical",
						armId: "bulk-one-way/physical/ws",
						transport: "ws",
						status: "PASS",
						promotable: false,
						sealedPath: "arms/ws.sealed.json",
						primaryMetricP50: 1.25,
						repetitionIndex: 1,
					},
					{
						cellId: "bulk-one-way/physical",
						armId: "bulk-one-way/physical/wt",
						transport: "wt",
						status: "PASS",
						promotable: false,
						sealedPath: "arms/wt.sealed.json",
						primaryMetricP50: 2.5,
						repetitionIndex: 1,
					},
				],
			})}\n`,
		);
		const report = join(out, "diagnostic-report.md");
		const proc = Bun.spawn(
			[
				process.execPath,
				"tools/compare/bin/render-campaign-report.ts",
				"--source=sealed-index",
				"--allow-non-promotable",
				`--candidate=${"a".repeat(40)}`,
				"--campaign-id=focused-probe",
				`--campaign-root=${out}`,
				`--output=${report}`,
			],
			{ cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
		);
		const code = await proc.exited;
		expect(code).toBe(0);
		const md = readFileSync(report, "utf8");
		expect(md).toContain("Diagnostic campaign report");
		expect(md).toContain("bulk-one-way/physical/ws");
		expect(md).toContain("Promotable");
		expect(md).toContain("Flats: none required");
	});
});
