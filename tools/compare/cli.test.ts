/**
 * Task 10: CLI and orchestration report tests.
 *
 * Covers:
 * - strict CLI argument parsing and refusal of unknown arguments
 * - help flag output
 * - scenario and transport selection
 * - Markdown report rendering from comparison results
 * - delta suppression for non-comparable / blocked arms
 * - Markdown table escaping and formatting
 */

import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { parseClientArgs } from "./client.ts";
import {
	type ComparisonSummary,
	escapeMarkdown,
	isPerSessionSaturated,
	REPORT_CONFIG,
	renderMarkdownReport,
} from "./render-report.ts";
import { parseCampaignArgs } from "./run-campaign.ts";
import { parseServerArgs } from "./server.ts";

describe("Task 10: Server CLI argument parsing", () => {
	it("parses valid server arguments", () => {
		const args = parseServerArgs([
			"--transport",
			"wt",
			"--scenario",
			"chat-fanout",
			"--port",
			"4433",
			"--bind",
			"10.99.0.2",
			"--run-id",
			"run-srv-1",
			"--tls-cert",
			"cert.pem",
			"--tls-key",
			"key.pem",
		]);

		expect(args.transport).toBe("wt");
		expect(args.scenario).toBe("chat-fanout");
		expect(args.port).toBe(4433);
		expect(args.bind).toBe("10.99.0.2");
		expect(args.runId).toBe("run-srv-1");
		expect(args.tlsCert).toBe("cert.pem");
		expect(args.tlsKey).toBe("key.pem");
	});

	it("rejects unknown arguments", () => {
		expect(() => parseServerArgs(["--unknown-flag", "val"])).toThrow(
			/unknown/i,
		);
	});

	it("rejects loopback bind address in strict comparison mode", () => {
		expect(() =>
			parseServerArgs([
				"--transport",
				"wt",
				"--scenario",
				"chat-fanout",
				"--bind",
				"127.0.0.1",
				"--port",
				"4433",
			]),
		).toThrow(/loopback/i);
	});
});

describe("Task 10: Client CLI argument parsing", () => {
	it("parses valid client arguments", () => {
		const args = parseClientArgs([
			"--transport",
			"ws",
			"--scenario",
			"ticker-fanout",
			"--server-url",
			"https://10.99.0.2:4433",
			"--run-id",
			"run-cli-1",
			"--output",
			"evidence.json",
			"--tls-ca",
			"ca.pem",
			"--tls-sni",
			"wt-compare.local",
		]);

		expect(args.transport).toBe("ws");
		expect(args.scenario).toBe("ticker-fanout");
		expect(args.serverUrl).toBe("https://10.99.0.2:4433");
		expect(args.runId).toBe("run-cli-1");
		expect(args.output).toBe("evidence.json");
	});

	it("rejects loopback server URL", () => {
		expect(() =>
			parseClientArgs([
				"--transport",
				"ws",
				"--scenario",
				"chat-fanout",
				"--server-url",
				"https://127.0.0.1:4433",
			]),
		).toThrow(/loopback/i);
	});

	it("rejects unknown client arguments", () => {
		expect(() => parseClientArgs(["--bogus"])).toThrow(/unknown/i);
	});
});

describe("Task 10: Campaign CLI argument parsing", () => {
	const trustArgs = [
		"--candidate",
		"candidate-1",
		"--campaign-id",
		"campaign-1",
		"--staged-capability",
		"official/staging/capabilities/campaign-r1.cap",
		"--capability-digest",
		"a".repeat(64),
		"--lock-digest",
		"b".repeat(64),
		"--archive-digest",
		"c".repeat(64),
	];

	it("parses campaign arguments", () => {
		const args = parseCampaignArgs([
			"--scenarios",
			"chat-fanout,ticker-fanout",
			"--transports",
			"both",
			...trustArgs,
			"--output-dir",
			"./.release-evidence/transport-comparison/candidate-1/campaign-1",
		]);

		expect(args.scenarios).toEqual(["chat-fanout", "ticker-fanout"]);
		expect(args.transports).toBe("both");
		expect(args.candidate).toBe("candidate-1");
		expect(args.campaignId).toBe("campaign-1");
		expect(args.stagedCapabilityPath).toBe(
			"official/staging/capabilities/campaign-r1.cap",
		);
		expect(args.outputDir).toBe(
			resolve(
				process.cwd(),
				".release-evidence/transport-comparison/candidate-1/campaign-1",
			),
		);
	});

	it("defaults to all scenarios and both transports", () => {
		const args = parseCampaignArgs(trustArgs);
		expect(args.scenarios.length).toBeGreaterThan(5);
		expect(args.transports).toBe("both");
		expect(args.outputDir).toContain(
			".release-evidence/transport-comparison/candidate-1/campaign-1",
		);
	});

	it("refuses to bind trust from the environment", () => {
		expect(() => parseCampaignArgs([])).toThrow(
			/CAMPAIGN_ARG_MISSING_CANDIDATE/,
		);
	});

	it("rejects legacy evidence output", () => {
		expect(() =>
			parseCampaignArgs([...trustArgs, "--output-dir", "./evidence"]),
		).toThrow();
	});
});

describe("Task 10: Report rendering", () => {
	it("escapes markdown special characters", () => {
		expect(escapeMarkdown("hello | world")).toBe("hello \\| world");
		expect(escapeMarkdown("<tag>")).toBe("&lt;tag&gt;");
	});

	it("renders markdown comparison summary table", () => {
		const summary: ComparisonSummary = {
			campaignId: "campaign-1",
			generatedAt: new Date().toISOString(),
			totalCells: 2,
			comparableCells: 1,
			rejectedCells: 1,
			comparisons: [
				{
					cellId: "chat-fanout/subscribers-1000",
					scenarioId: "chat-fanout",
					status: "COMPATIBLE",
					primaryMetricName: "delivered-messages-per-second",
					metricUnit: "count",
					metricDirection: "higher",
					wsValue: 9500,
					wtValue: 10000,
					deltaPercent: 5.26,
					winner: "wt",
					wsLoopUtilization: {
						perSession: { busyMs: 10, windowMs: 100 },
						serverAggregate: { busyMs: 20, windowMs: 100 },
					},
					wtLoopUtilization: {
						perSession: { busyMs: 5, windowMs: 100 },
						serverAggregate: { busyMs: 8, windowMs: 100 },
					},
				},
				{
					cellId: "reconnect-storm/cold-full",
					scenarioId: "reconnect-storm",
					status: "INCOMPATIBLE",
					rejectionReason: "missing WT run evidence",
				},
			],
		};

		const md = renderMarkdownReport(summary);
		expect(md).toContain("# WebTransport vs WebSocket Comparison Report");
		expect(md).toContain("chat-fanout");
		expect(md).toContain("COMPATIBLE");
		expect(md).toContain("5.26%");
		expect(md).toContain("INCOMPATIBLE");
		expect(md).toContain("missing WT run evidence");
		expect(md).toContain("Loop Utilization");
		expect(md).toContain("WS ps=10%/agg=20%");
		expect(md).toContain("WT ps=5%/agg=8%");
		expect(md).toContain(
			`Loop-utilization saturation caveat fires when per-session busyMs/windowMs exceeds ${REPORT_CONFIG.loopUtilizationSaturationThreshold}`,
		);
	});
});

describe("Phase 2.4 Commit 5: loop-utilization column and saturation caveat", () => {
	const baseCompatible = {
		cellId: "chat-fanout/subscribers-1000",
		scenarioId: "chat-fanout",
		status: "COMPATIBLE" as const,
		primaryMetricName: "delivered-messages-per-second",
		metricUnit: "count",
		metricDirection: "higher" as const,
		wsValue: 1,
		wtValue: 1,
		deltaPercent: 0,
		winner: "tie" as const,
	};

	it("treats the configured threshold boundary as not saturated (strict >)", () => {
		// Equality at 0.3 is not saturated; the next representable
		// value above it is. The threshold lives on REPORT_CONFIG
		// so a measurement run cannot calibrate it away.
		expect(REPORT_CONFIG.loopUtilizationSaturationThreshold).toBe(0.3);
		const threshold = REPORT_CONFIG.loopUtilizationSaturationThreshold;
		expect(
			isPerSessionSaturated({
				busyMs: threshold,
				windowMs: 1,
			}),
		).toBe(false);
		expect(
			isPerSessionSaturated({
				busyMs: threshold + Number.EPSILON,
				windowMs: 1,
			}),
		).toBe(true);
		expect(
			isPerSessionSaturated({
				busyMs: 31,
				windowMs: 100,
			}),
		).toBe(true);
	});

	it("renders both arms' perSession and serverAggregate in the Loop Utilization column", () => {
		const md = renderMarkdownReport({
			campaignId: "phase-2.4-commit-5",
			generatedAt: "2026-08-29T00:00:00.000Z",
			totalCells: 1,
			comparableCells: 1,
			rejectedCells: 0,
			comparisons: [
				{
					...baseCompatible,
					wsLoopUtilization: {
						perSession: { busyMs: 12, windowMs: 100 },
						serverAggregate: { busyMs: 40, windowMs: 100 },
					},
					wtLoopUtilization: {
						perSession: { busyMs: 8, windowMs: 100 },
						serverAggregate: { busyMs: 15, windowMs: 100 },
					},
				},
			],
		});
		expect(md).toContain("| Loop Utilization |");
		expect(md).toContain("WS ps=12%/agg=40%");
		expect(md).toContain("WT ps=8%/agg=15%");
		expect(md).not.toContain("protocol attribution is caveated");
	});

	it("fires the saturated caveat only on perSession, never on serverAggregate alone", () => {
		// Wrong-scope: serverAggregate above the threshold must not
		// caveat the ranking when perSession stays at or below it.
		const md = renderMarkdownReport({
			campaignId: "phase-2.4-commit-5-wrong-scope",
			generatedAt: "2026-08-29T00:00:00.000Z",
			totalCells: 1,
			comparableCells: 1,
			rejectedCells: 0,
			comparisons: [
				{
					...baseCompatible,
					wsLoopUtilization: {
						perSession: { busyMs: 10, windowMs: 100 },
						serverAggregate: { busyMs: 90, windowMs: 100 },
					},
					wtLoopUtilization: {
						perSession: { busyMs: 34, windowMs: 100 },
						serverAggregate: { busyMs: 5, windowMs: 100 },
					},
				},
			],
		});
		expect(md).toContain(
			"WT per-session receive-loop utilization 34%; protocol attribution is caveated",
		);
		expect(md).not.toContain("WS per-session receive-loop utilization");
		expect(md).toContain("WS ps=10%/agg=90%");
		expect(md).toContain("WT ps=34%/agg=5%");
		// High serverAggregate alone must not produce a Notes caveat —
		// only the WT per-session line above is present.
		const notesMatch = md.match(/\|\s*WT per-session[^|]+\|/);
		expect(notesMatch?.[0] ?? "").not.toContain("WS");
	});

	it("renders a dash for a missing per-arm loopUtilization without inventing zeros", () => {
		const md = renderMarkdownReport({
			campaignId: "phase-2.4-commit-5-missing",
			generatedAt: "2026-08-29T00:00:00.000Z",
			totalCells: 1,
			comparableCells: 1,
			rejectedCells: 0,
			comparisons: [
				{
					...baseCompatible,
					wtLoopUtilization: {
						perSession: { busyMs: 1, windowMs: 100 },
						serverAggregate: { busyMs: 1, windowMs: 100 },
					},
				},
			],
		});
		expect(md).toContain("WS: -");
		expect(md).toContain("WT ps=1%/agg=1%");
		expect(md).not.toContain("protocol attribution is caveated");
	});
});
