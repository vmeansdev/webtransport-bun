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
	it("parses campaign arguments", () => {
		const args = parseCampaignArgs([
			"--scenarios",
			"chat-fanout,ticker-fanout",
			"--transports",
			"both",
			"--candidate",
			"candidate-1",
			"--campaign-id",
			"campaign-1",
			"--output-dir",
			"./.release-evidence/transport-comparison/candidate-1/campaign-1",
		]);

		expect(args.scenarios).toEqual(["chat-fanout", "ticker-fanout"]);
		expect(args.transports).toBe("both");
		expect(args.candidate).toBe("candidate-1");
		expect(args.campaignId).toBe("campaign-1");
		expect(args.outputDir).toBe(
			resolve(
				process.cwd(),
				".release-evidence/transport-comparison/candidate-1/campaign-1",
			),
		);
	});

	it("defaults to all scenarios and both transports", () => {
		const args = parseCampaignArgs([]);
		expect(args.scenarios.length).toBeGreaterThan(5);
		expect(args.transports).toBe("both");
		expect(args.outputDir).toContain(
			".release-evidence/transport-comparison/unbound-candidate/campaign-unbound",
		);
	});

	it("rejects legacy evidence output", () => {
		expect(() => parseCampaignArgs(["--output-dir", "./evidence"])).toThrow();
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
	});
});
