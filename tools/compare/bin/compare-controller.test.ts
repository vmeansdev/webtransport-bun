/**
 * Tests for the two-host controller.
 *
 * These pin the rig-config defaults that the live rig actually uses
 * (Mac `en13`, Linux `hermes-admin` user, `ubuntu-vm-hermes` SSH
 * key) so the controller cannot silently drift back to the plan's
 * stale values (`en8`, `bench`, `id_ed25519`). See
 * `docs/superpowers/plans/deviations/phase-3.5-rig-config-correction.md`.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MeasuredLeg } from "../client.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "../scenario-registry.ts";
import type { CampaignIndex, SealArm } from "./compare-controller.ts";
import {
	buildDryRunReport,
	buildNetemCommands,
	buildProductionClientArgv,
	buildSshArgv,
	campaignIndexKey,
	canonicalSealArmCount,
	DEFAULT_SSH_IDENTITY,
	defaultRigEndpoints,
	grantDeclarationsFromCell,
	impairmentForCell,
	isPromotableFlatArm,
	measurementSeriesFromLeg,
	PHASE4_GATE_CELLS,
	parseControllerArgs,
	parseLinuxRoute,
	parseMacRoute,
	resolveStagedAuthorityDigest,
	resumableEntries,
	sealArmSchedule,
	sealArmSlotId,
	sealArmsForCell,
	sealRunIdForArm,
	selectMedianPassRep,
	selectPairedMedianPassRep,
	serverUrlForTransport,
	validateDeadline,
	validateEndpoints,
} from "./compare-controller.ts";

describe("two-host controller: rig-config defaults", () => {
	it("defaultRigEndpoints returns en13 (not en8) and hermes-admin (not bench)", () => {
		const e = defaultRigEndpoints();
		expect(e.mac.interface).toBe("en13");
		expect(e.mac.address).toBe("10.99.0.1");
		expect(e.linux.interface).toBe("eno1");
		expect(e.linux.address).toBe("10.99.0.2");
		expect(e.linux.user).toBe("hermes-admin");
	});

	it("DEFAULT_SSH_IDENTITY is the ubuntu-vm-hermes key, not id_ed25519", () => {
		expect(DEFAULT_SSH_IDENTITY).toBe("~/.ssh/ubuntu-vm-hermes");
		expect(DEFAULT_SSH_IDENTITY).not.toContain("id_ed25519");
	});

	it("buildSshArgv uses the default identity and the user from the endpoint", () => {
		const argv = buildSshArgv(
			{ interface: "eno1", address: "10.99.0.2", user: "hermes-admin" },
			"echo ready",
		);
		const idx = argv.indexOf("-i");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe(DEFAULT_SSH_IDENTITY);
		expect(argv).toContain("hermes-admin@10.99.0.2");
		expect(argv).toContain("echo ready");
		// No id_ed25519 should appear in the SSH argv.
		expect(argv.some((a) => a.includes("id_ed25519"))).toBe(false);
	});

	it("buildSshArgv uses the user from the endpoint, not a hardcoded value", () => {
		const argv = buildSshArgv(
			{ interface: "eno1", address: "10.99.0.2", user: "alice" },
			"uptime",
		);
		expect(argv).toContain("alice@10.99.0.2");
	});
});

describe("two-host controller: dry-run report with the live rig defaults", () => {
	it("buildDryRunReport produces a valid report for the live rig", () => {
		const result = buildDryRunReport({
			cell: "ticker",
			repetitions: 1,
			arms: ["ws", "wt"],
			candidate: "ws-wt-r0",
			campaignId: "campaign-r0",
			endpoints: defaultRigEndpoints(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Mac route: en13, valid
		expect(result.report.routes.mac.valid).toBe(true);
		expect(result.report.routes.mac.interface).toBe("en13");
		// Linux route: eno1, valid
		expect(result.report.routes.linux.valid).toBe(true);
		expect(result.report.routes.linux.interface).toBe("eno1");
		// SSH argv includes the correct identity
		expect(result.report.sshArgv).toContain(DEFAULT_SSH_IDENTITY);
		expect(result.report.sshArgv).toContain("hermes-admin@10.99.0.2");
		// Netem targets eno1
		expect(result.report.netemApply).toContain("eno1");
		// All seven deadlines are valid
		expect(result.report.deadlines.length).toBe(7);
		for (const d of result.report.deadlines) {
			expect(d.ok).toBe(true);
		}
		// Evidence path is under the policy root
		expect(result.report.evidencePath).toContain(".release-evidence");
	});
});

describe("two-host controller: pure-helper invariants", () => {
	it("parseMacRoute accepts the live direct-cable format", () => {
		const r = parseMacRoute(
			"destination: 10.99.0.2  interface: en13",
			"10.99.0.2",
		);
		expect(r.valid).toBe(true);
		expect(r.interface).toBe("en13");
	});

	it("parseMacRoute rejects a via route", () => {
		const r = parseMacRoute(
			"destination: 10.99.0.2  interface: en13  via: 192.168.1.1",
			"10.99.0.2",
		);
		expect(r.valid).toBe(false);
	});

	it("parseLinuxRoute accepts a direct-cable dev route", () => {
		// Live `ip route get 10.99.0.1` on the Linux bench returns
		// "10.99.0.1 dev eno1 src 10.99.0.2 uid 0 cache" — no "via".
		const r = parseLinuxRoute(
			"10.99.0.1 dev eno1 src 10.99.0.2 uid 0 cache",
			"10.99.0.1",
		);
		expect(r.valid).toBe(true);
		expect(r.interface).toBe("eno1");
	});

	it("parseLinuxRoute rejects a via-suffixed route (routed, not direct cable)", () => {
		// Routed: gateway via some other interface. The rig must
		// never be on a routed path.
		const r = parseLinuxRoute(
			"10.99.0.1 via 192.168.1.1 dev eth0",
			"10.99.0.1",
		);
		expect(r.valid).toBe(false);
	});

	it("parseLinuxRoute rejects a dev route to a different destination", () => {
		const r = parseLinuxRoute(
			"192.168.1.5 dev eno1 src 10.99.0.2",
			"10.99.0.1",
		);
		expect(r.valid).toBe(false);
	});

	it("buildNetemCommands targets the requested interface", () => {
		const cmds = buildNetemCommands("eno1", 50, 10);
		expect(cmds.apply).toContain("eno1");
		expect(cmds.apply).toContain("netem");
		expect(cmds.apply).toContain("50ms");
		expect(cmds.apply).toContain("10ms");
		expect(cmds.restore).toContain("del");
		expect(cmds.restore).toContain("eno1");
	});

	it("validateDeadline rejects windows over 5 minutes", () => {
		const v = validateDeadline({ label: "x", windowMs: 6 * 60 * 1000 });
		expect(v.ok).toBe(false);
	});

	it("validateDeadline rejects non-positive windows", () => {
		const v = validateDeadline({ label: "x", windowMs: 0 });
		expect(v.ok).toBe(false);
	});

	it("validateEndpoints rejects same-interface config", () => {
		const v = validateEndpoints({
			mac: { interface: "en13", address: "10.99.0.1" },
			linux: { interface: "en13", address: "10.99.0.2", user: "x" },
		});
		expect(v.ok).toBe(false);
	});

	it("validateEndpoints rejects missing linux user", () => {
		const v = validateEndpoints({
			mac: { interface: "en13", address: "10.99.0.1" },
			linux: { interface: "eno1", address: "10.99.0.2", user: "" },
		});
		expect(v.ok).toBe(false);
	});
});

describe("two-host controller: SSH identity path on the live host", () => {
	it("the default identity is a tilde-relative path under .ssh/", () => {
		// We do not assert the file's existence (the file is
		// host-specific) — we assert the controller's baked-in path
		// is the one the rig actually uses.
		expect(DEFAULT_SSH_IDENTITY.startsWith("~/")).toBe(true);
		expect(DEFAULT_SSH_IDENTITY.endsWith("/ubuntu-vm-hermes")).toBe(true);
		// Homedir-expanded form is what `ssh -i` would receive.
		const expanded = `${homedir()}${DEFAULT_SSH_IDENTITY.slice(1)}`;
		expect(expanded).toBe(`${homedir()}/.ssh/ubuntu-vm-hermes`);
	});
});

// ---------------------------------------------------------------------------
// Two-host controller: production-client argv (Phase 3.6.2)
// ---------------------------------------------------------------------------

describe("two-host controller: production-client argv", () => {
	it("invokes the production client, not the harness bypass", () => {
		const argv = buildProductionClientArgv({
			linuxAddress: "10.99.0.2",
			serverPort: 4433,
			cell: "ticker-fanout",
			runId: "ws-wt-r0-campaign-r0-ticker-fanout-1788000000000",
			repIndex: 1,
			outputPath:
				"/repo/.release-evidence/transport-comparison/ws-wt-r0/campaign-r0/run-1/rep-1.json",
		});
		// The harness bypass is `scripts/rig-measure-client.ts`; the
		// production client is `tools/compare/client.ts`. The argv must
		// not contain the harness path.
		expect(argv.some((a) => a.includes("rig-measure-client"))).toBe(false);
		expect(argv).toContain("tools/compare/client.ts");
	});

	it("pins --transport ws so the same WS adapter envelope runs on the rig", () => {
		const argv = buildProductionClientArgv({
			linuxAddress: "10.99.0.2",
			serverPort: 4433,
			cell: "ticker-fanout",
			runId: "run-1",
			repIndex: 1,
			outputPath: "/tmp/out.json",
		});
		expect(argv).toContain("--transport");
		expect(argv[argv.indexOf("--transport") + 1]).toBe("ws");
	});

	it("uses wss:// with the rig address and port", () => {
		const argv = buildProductionClientArgv({
			linuxAddress: "10.99.0.2",
			serverPort: 4433,
			cell: "ticker-fanout",
			runId: "run-1",
			repIndex: 1,
			outputPath: "/tmp/out.json",
		});
		const idx = argv.indexOf("--server-url");
		expect(argv[idx + 1]).toBe("wss://10.99.0.2:4433");
	});

	it("uses --tls-sni gravvene-dev-home (matches the rig-side serverName)", () => {
		const argv = buildProductionClientArgv({
			linuxAddress: "10.99.0.2",
			serverPort: 4433,
			cell: "ticker-fanout",
			runId: "run-1",
			repIndex: 1,
			outputPath: "/tmp/out.json",
		});
		const idx = argv.indexOf("--tls-sni");
		expect(argv[idx + 1]).toBe("gravvene-dev-home");
	});

	it("names each rep separately in the run-id (rep-N suffix)", () => {
		const argv1 = buildProductionClientArgv({
			linuxAddress: "10.99.0.2",
			serverPort: 4433,
			cell: "ticker-fanout",
			runId: "run-1",
			repIndex: 1,
			outputPath: "/tmp/rep-1.json",
		});
		const argv5 = buildProductionClientArgv({
			linuxAddress: "10.99.0.2",
			serverPort: 4433,
			cell: "ticker-fanout",
			runId: "run-1",
			repIndex: 5,
			outputPath: "/tmp/rep-5.json",
		});
		const idx1 = argv1.indexOf("--run-id");
		expect(argv1[idx1 + 1]).toBe("run-1-rep-1");
		const idx5 = argv5.indexOf("--run-id");
		expect(argv5[idx5 + 1]).toBe("run-1-rep-5");
	});

	it("writes the per-rep output path so each rep produces its own artifact", () => {
		const argv = buildProductionClientArgv({
			linuxAddress: "10.99.0.2",
			serverPort: 4433,
			cell: "ticker-fanout",
			runId: "run-1",
			repIndex: 3,
			outputPath:
				"/repo/.release-evidence/transport-comparison/ws-wt-r0/campaign-r0/run-1/rep-3.json",
		});
		const idx = argv.indexOf("--output");
		expect(argv[idx + 1]).toBe(
			"/repo/.release-evidence/transport-comparison/ws-wt-r0/campaign-r0/run-1/rep-3.json",
		);
	});
});

describe("two-host controller: seal helpers", () => {
	it("serverUrlForTransport uses wss for ws and https for wt", () => {
		expect(serverUrlForTransport("ws", "10.99.0.2", 4433)).toBe(
			"wss://10.99.0.2:4433",
		);
		expect(serverUrlForTransport("wt", "10.99.0.2", 4433)).toBe(
			"https://10.99.0.2:4433",
		);
	});

	it("grantDeclarationsFromCell matches bulk and ticker executor math", () => {
		const bulk = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(c) => c.cellId === "bulk-one-way/physical",
		)!;
		const ticker = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(c) => c.cellId === "ticker-fanout/rate-10000",
		)!;
		expect(grantDeclarationsFromCell(bulk)).toEqual({
			declaredMessageCount: Math.ceil((100 * 1024 * 1024) / (64 * 1024)),
			declaredMessageBytes: 64 * 1024,
		});
		expect(grantDeclarationsFromCell(ticker)).toEqual({
			declaredMessageCount: 100_000,
			declaredMessageBytes: 100,
		});
	});

	it("impairmentForCell is none for Phase-4 physical cells", () => {
		const bulk = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(c) => c.cellId === "bulk-one-way/physical",
		)!;
		const ticker = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(c) => c.cellId === "ticker-fanout/rate-10000",
		)!;
		expect(impairmentForCell(bulk)).toEqual({ kind: "none" });
		expect(impairmentForCell(ticker)).toEqual({ kind: "none" });
	});

	it("impairmentForCell applies netem for delay40-loss1", () => {
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(c) => c.cellId === "bulk-one-way/delay40-loss1",
		)!;
		expect(impairmentForCell(cell)).toEqual({
			kind: "netem",
			delayMs: 40,
			jitterMs: 0,
			lossPercent: 1,
		});
	});

	it("selectMedianPassRep picks floor((n-1)/2) after p50/rep sort", () => {
		const pick = selectMedianPassRep([
			{ rep: 1, status: "PASS", primaryMetricP50: 30, sealedPath: "a" },
			{ rep: 2, status: "PASS", primaryMetricP50: 10, sealedPath: "b" },
			{ rep: 3, status: "PASS", primaryMetricP50: 20, sealedPath: "c" },
			{ rep: 4, status: "FAIL" },
		]);
		// sorted p50: 10,20,30 → floor(2/2)=1 → index 1 → p50 20
		expect(pick).toEqual({ rep: 3, sealedPath: "c" });
	});

	it("selectPairedMedianPassRep requires a shared PASS rep for runId pairing", () => {
		const ws = [
			{ rep: 1, status: "PASS", primaryMetricP50: 100, sealedPath: "ws1" },
			{ rep: 2, status: "FAIL", primaryMetricP50: 50, sealedPath: "ws2" },
			{ rep: 3, status: "PASS", primaryMetricP50: 200, sealedPath: "ws3" },
		];
		const wt = [
			{ rep: 1, status: "PASS", primaryMetricP50: 90, sealedPath: "wt1" },
			{ rep: 2, status: "PASS", primaryMetricP50: 10, sealedPath: "wt2" },
			{ rep: 3, status: "PASS", primaryMetricP50: 110, sealedPath: "wt3" },
		];
		// Common PASS: rep1 mean=95, rep3 mean=155 → median of 2 → floor(0.5)=0 → rep1
		expect(selectPairedMedianPassRep(ws, wt)).toEqual({
			rep: 1,
			wsSealedPath: "ws1",
			wtSealedPath: "wt1",
		});
		expect(
			selectPairedMedianPassRep(
				[{ rep: 1, status: "PASS", primaryMetricP50: 1, sealedPath: "ws1" }],
				[{ rep: 2, status: "PASS", primaryMetricP50: 1, sealedPath: "wt2" }],
			),
		).toBeUndefined();
	});

	it("buildProductionClientArgv honors transport for wt https URL", () => {
		const argv = buildProductionClientArgv({
			linuxAddress: "10.99.0.2",
			serverPort: 4433,
			cell: "bulk-one-way",
			runId: "run-1",
			repIndex: 1,
			outputPath: "/tmp/out.json",
			transport: "wt",
		});
		expect(argv[argv.indexOf("--transport") + 1]).toBe("wt");
		expect(argv[argv.indexOf("--server-url") + 1]).toBe(
			"https://10.99.0.2:4433",
		);
	});

	it("parseControllerArgs --phase4 selects gate cells and focused reps=1", () => {
		const parsed = parseControllerArgs([
			"--phase4",
			"--execution-purpose=focused",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.spec.cells).toEqual([...PHASE4_GATE_CELLS]);
		expect(parsed.spec.repetitions).toBe(1);
		expect(parsed.spec.stage).toBe("phase4");
		expect(parsed.spec.executionPurpose).toBe("focused");
	});

	it("purpose_parser_requires_execution_purpose_and_reps_coupling", () => {
		expect(parseControllerArgs(["--cell=ticker-fanout"]).ok).toBe(false);
		expect(
			parseControllerArgs([
				"--cell=ticker-fanout",
				"--execution-purpose=focused",
				"--reps=2",
			]).ok,
		).toBe(false);
		expect(
			parseControllerArgs([
				"--cell=ticker-fanout",
				"--execution-purpose=canonical",
				"--reps=5",
			]).ok,
		).toBe(true);
	});

	it("parses campaign-timeout-ms and write-terminal-record", () => {
		const parsed = parseControllerArgs([
			"--cell=bulk-one-way/physical",
			"--execution-purpose=focused",
			"--campaign-timeout-ms=3600000",
			"--write-terminal-record=/tmp/controller-terminal.json",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.spec.campaignTimeoutMs).toBe(3600000);
		expect(parsed.spec.writeTerminalRecordPath).toBe(
			"/tmp/controller-terminal.json",
		);
	});

	it("rejects invalid campaign-timeout-ms and empty write-terminal-record", () => {
		expect(
			parseControllerArgs([
				"--cell=bulk-one-way/physical",
				"--execution-purpose=focused",
				"--campaign-timeout-ms=0",
			]).ok,
		).toBe(false);
		expect(
			parseControllerArgs([
				"--cell=bulk-one-way/physical",
				"--execution-purpose=focused",
				"--write-terminal-record=",
			]).ok,
		).toBe(false);
	});

	it("resolveStagedAuthorityDigest prefers stage-receipt.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "wt-stage-auth-"));
		const live =
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		writeFileSync(
			join(dir, "stage-receipt.json"),
			JSON.stringify({ authoritySha256: live }),
		);
		expect(resolveStagedAuthorityDigest(dir)).toBe(live);
	});
});

describe("two-host controller: --staged-dir", () => {
	it("parses --staged-dir into RunSpec.stagedDir", () => {
		const parsed = parseControllerArgs([
			"--cell=bulk-one-way",
			"--staged-dir=/tmp/ws-wt-staged",
			"--execution-purpose=focused",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.spec.cell).toBe("bulk-one-way");
		expect(parsed.spec.stagedDir).toBe("/tmp/ws-wt-staged");
	});

	it("omits stagedDir when the flag is absent", () => {
		const parsed = parseControllerArgs([
			"--cell=ticker-fanout",
			"--execution-purpose=focused",
		]);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.spec.stagedDir).toBeUndefined();
	});

	it("refuses an empty --staged-dir value", () => {
		const parsed = parseControllerArgs([
			"--staged-dir=",
			"--execution-purpose=focused",
		]);
		expect(parsed.ok).toBe(false);
	});
});

describe("two-host controller: measurementSeriesFromLeg", () => {
	function baseLeg(overrides: Partial<MeasuredLeg> = {}): MeasuredLeg {
		return {
			sampleUnit: "Mbps",
			samples: [12.5, 13],
			percentiles: { p1: 12.5, p50: 12.75, p95: 13, p99: 13 },
			ledger: {
				attempted: 2,
				queued: 2,
				serverObserved: 2,
				acknowledged: 2,
				delivered: 100,
				dropped: 0,
				expired: 0,
				harnessOverheadBytes: 0,
				histogram: { unit: "Mbps", boundaries: [], counts: [] },
			},
			admissionCounters: {
				schemaVersion: "v1",
				handshakes: {
					attempted: 1,
					accepted: 1,
					rejected: 0,
					rateLimited: 0,
				},
				sessions: {
					attempted: 1,
					accepted: 1,
					rejected: 0,
					activePeak: 1,
				},
				streams: {
					attempted: 0,
					accepted: 0,
					rejected: 0,
					rateLimited: 0,
				},
				datagrams: {
					attempted: 0,
					accepted: 0,
					rejected: 0,
					rateLimited: 0,
				},
			},
			provenance: {
				attestation: "att-1",
				driverRunId: "run-1",
				clockMethod: "performance.timeOrigin+performance.now",
				sampleCount: 2,
				firstSampleAtMs: 1_000,
				lastSampleAtMs: 2_000,
			},
			loopUtilization: { busyMs: 10, windowMs: 1_000 },
			roundTrips: [
				{
					sequence: 1,
					sentAtMs: 1_000,
					receivedAtMs: 1_010,
					latencyMs: 10,
				},
			],
			deliveredBytes: 65536,
			...overrides,
		};
	}

	it("projects a Mbps leg with empty roundTrips and deliveredBytes", () => {
		const series = measurementSeriesFromLeg(baseLeg());
		expect(series.sampleUnit).toBe("Mbps");
		expect(series.samples).toEqual([12.5, 13]);
		expect(series.roundTrips).toEqual([]);
		expect(series.ledger.delivered).toBe(100);
		expect(series.deliveredBytes).toBe(65536);
		expect(series.provenance).toEqual({
			sampleCount: 2,
			firstSampleAtMs: 1_000,
			lastSampleAtMs: 2_000,
		});
	});

	it("projects a count rate leg with empty roundTrips and sampleUnit", () => {
		const series = measurementSeriesFromLeg(
			baseLeg({
				sampleUnit: "count",
				deliveredBytes: undefined,
				samples: [5_000],
				ledger: {
					attempted: 5_000,
					queued: 5_000,
					serverObserved: 5_000,
					acknowledged: 5_000,
					delivered: 5_000,
					dropped: 0,
					expired: 0,
					harnessOverheadBytes: 0,
					histogram: { unit: "count", boundaries: [], counts: [] },
				},
				provenance: {
					attestation: "att-rate",
					driverRunId: "run-1",
					clockMethod: "performance.timeOrigin+performance.now",
					sampleCount: 1,
					firstSampleAtMs: 1_000,
					lastSampleAtMs: 2_000,
				},
			}),
		);
		expect(series.sampleUnit).toBe("count");
		expect(series.samples).toEqual([5_000]);
		expect(series.roundTrips).toEqual([]);
		expect(series.ledger.delivered).toBe(5_000);
		expect(series.deliveredBytes).toBeUndefined();
	});

	it("projects a percent leg with empty roundTrips and sampleUnit", () => {
		const series = measurementSeriesFromLeg(
			baseLeg({
				sampleUnit: "percent",
				deliveredBytes: undefined,
				samples: [98.5],
				percentiles: { p1: 98.5, p50: 98.5, p95: 98.5, p99: 98.5 },
				roundTrips: [
					{
						sequence: 1,
						sentAtMs: 1_000,
						receivedAtMs: 1_010,
						latencyMs: 10,
					},
				],
				ledger: {
					attempted: 600,
					queued: 600,
					serverObserved: 594,
					acknowledged: 594,
					delivered: 591,
					dropped: 6,
					expired: 3,
					harnessOverheadBytes: 0,
					histogram: { unit: "percent", boundaries: [], counts: [] },
				},
				provenance: {
					attestation: "att-percent",
					driverRunId: "run-1",
					clockMethod: "performance.timeOrigin+performance.now",
					sampleCount: 1,
					firstSampleAtMs: 1_000,
					lastSampleAtMs: 1_000,
				},
			}),
		);
		expect(series.sampleUnit).toBe("percent");
		expect(series.samples).toEqual([98.5]);
		expect(series.roundTrips).toEqual([]);
		expect(series.ledger.delivered).toBe(591);
		expect(series.deliveredBytes).toBeUndefined();
	});

	it("keeps round trips for an ms latency leg", () => {
		const series = measurementSeriesFromLeg(
			baseLeg({
				sampleUnit: "ms",
				deliveredBytes: undefined,
				ledger: {
					attempted: 1,
					queued: 1,
					serverObserved: 1,
					acknowledged: 1,
					delivered: 1,
					dropped: 0,
					expired: 0,
					harnessOverheadBytes: 0,
					histogram: { unit: "ms", boundaries: [], counts: [] },
				},
			}),
		);
		expect(series.sampleUnit).toBe("ms");
		expect(series.roundTrips).toHaveLength(1);
		expect(series.deliveredBytes).toBeUndefined();
	});
});

describe("two-host controller: seal arm scheduling", () => {
	const cellById = (cellId: string) => {
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) => candidate.cellId === cellId,
		);
		if (cell === undefined) throw new Error(`no such cell: ${cellId}`);
		return cell;
	};

	it("schedules every arm the frozen registry declares, and no other", () => {
		expect(canonicalSealArmCount()).toBe(112);
		const kinds = new Map<string, number>();
		for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
			for (const arm of sealArmsForCell(cell)) {
				const key = `${arm.armKind}|${arm.transport}|${arm.armTransport ?? "-"}`;
				kinds.set(key, (kinds.get(key) ?? 0) + 1);
			}
		}
		expect(Object.fromEntries(kinds)).toEqual({
			"primary|ws|ws": 35,
			"primary|wt|wt": 35,
			"read-path|ws|ws-worker": 21,
			"read-path|wt|wt-stream-sink": 9,
			"overlay|ws|-": 12,
		});
	});

	it("gives every arm a tier, and the tier follows the arm kind", () => {
		const tiers = new Set<string>();
		for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
			for (const arm of sealArmsForCell(cell)) {
				tiers.add(`${arm.armKind}|${arm.tier}`);
			}
		}
		expect([...tiers].sort()).toEqual([
			"overlay|overlay",
			"primary|main-loop",
			"read-path|off-loop",
		]);
	});

	it("carries the registry's arm transport onto the scheduled arm", () => {
		const arms = sealArmsForCell(cellById("ticker-fanout/rate-10000"));
		const byId = new Map(arms.map((arm) => [arm.armId, arm]));
		expect(byId.get("ticker-fanout/rate-10000/ws-worker")).toMatchObject({
			armKind: "read-path",
			transport: "ws",
			armTransport: "ws-worker",
		});
		expect(byId.get("ticker-fanout/rate-10000/wt-stream-sink")).toMatchObject({
			armKind: "read-path",
			transport: "wt",
			armTransport: "wt-stream-sink",
		});
		// The overlay declares no arm transport at all, and the artifact must
		// not invent one for it.
		const overlay = sealArmsForCell(
			cellById("game-tick-loss/tick-20-loss-1-delay-20"),
		).find((arm) => arm.armKind === "overlay");
		expect(overlay?.armTransport).toBeUndefined();
		expect(overlay?.transport).toBe("ws");
	});

	it("puts the overlay on game-tick-loss cells only", () => {
		for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
			const overlays = sealArmsForCell(cell).filter(
				(arm) => arm.armKind === "overlay",
			);
			if (cell.scenarioId === "game-tick-loss") {
				expect(overlays).toHaveLength(1);
			} else {
				expect(overlays).toHaveLength(0);
			}
		}
	});

	it("narrows by wire and by arm kind without narrowing the other", () => {
		const cell = cellById("ticker-fanout/rate-10000");
		expect(
			sealArmsForCell(cell, ["ws"]).every((arm) => arm.transport === "ws"),
		).toBe(true);
		expect(sealArmsForCell(cell, ["ws", "wt"], ["primary"])).toHaveLength(2);
		expect(sealArmsForCell(cell, ["wt"], ["read-path"])).toHaveLength(1);
	});

	it("orders the schedule cell-major, then arm, then rep", () => {
		const cells = [
			cellById("ticker-fanout/rate-10000"),
			cellById("bulk-one-way/physical"),
		];
		const slots = sealArmSchedule({ cells, repetitions: 2 });
		expect(slots).toHaveLength(
			(sealArmsForCell(cells[0]!).length + sealArmsForCell(cells[1]!).length) *
				2,
		);
		expect(
			slots.slice(0, 4).map((slot) => `${slot.arm.armId}#${slot.repIndex}`),
		).toEqual([
			"ticker-fanout/rate-10000/ws#1",
			"ticker-fanout/rate-10000/ws#2",
			"ticker-fanout/rate-10000/wt#1",
			"ticker-fanout/rate-10000/wt#2",
		]);
	});

	it("shares a run id inside a pairing cohort and never across one", () => {
		const cell = cellById("ticker-fanout/rate-10000");
		const arms = new Map(
			sealArmsForCell(cell).map((arm) => [sealArmSlotId(arm), arm]),
		);
		const runIdOf = (slot: string, rep: number) =>
			sealRunIdForArm("pair", arms.get(slot) as SealArm, rep);
		// A cohort is a ranked pair: same tier, opposite wires. The two
		// primaries are one, and the two off-loop arms are the other, so each
		// cohort shares an id and pairs the way the gate expects.
		expect(runIdOf("ws", 1)).toBe(runIdOf("wt", 1));
		expect(runIdOf("ws-worker", 1)).toBe(runIdOf("wt-stream-sink", 1));
		// Across cohorts and across reps the ids differ, or two arms on the
		// same wire would contend for one grant.
		const distinct = new Set([
			runIdOf("ws", 1),
			runIdOf("ws", 2),
			runIdOf("ws-worker", 1),
			runIdOf("ws-worker", 2),
		]);
		expect(distinct.size).toBe(4);
	});

	it("gives the game overlay a run id no arm on its wire shares", () => {
		const cell = cellById("game-tick-loss/tick-20-loss-1-delay-20");
		const arms = new Map(
			sealArmsForCell(cell).map((arm) => [sealArmSlotId(arm), arm]),
		);
		const runIdOf = (slot: string) =>
			sealRunIdForArm("pair", arms.get(slot) as SealArm, 1);
		expect(runIdOf("ws-overlay")).not.toBe(runIdOf("ws"));
		expect(runIdOf("ws-overlay")).not.toBe(runIdOf("ws-worker"));
	});

	it("promotes flats for the primary pair only", () => {
		const cell = cellById("game-tick-loss/tick-20-loss-1-delay-20");
		const promotable = sealArmsForCell(cell)
			.filter(isPromotableFlatArm)
			.map(sealArmSlotId)
			.sort();
		expect(promotable).toEqual(["ws", "wt"]);
	});

	it("resumes the PASS entries whose seals are still on disk, and nothing else", () => {
		const entry = (
			overrides: Partial<CampaignIndex["entries"][number]>,
		): CampaignIndex["entries"][number] => ({
			cellId: "ticker-fanout/rate-10000",
			armId: "ticker-fanout/rate-10000/ws",
			transport: "ws",
			armKind: "primary",
			rep: 1,
			impairment: "none",
			status: "PASS",
			sealedPath: import.meta.path,
			...overrides,
		});
		const index: CampaignIndex = {
			schema: "campaign-index/v1",
			campaignRunId: "campaign-r0",
			stage: "full",
			candidate: "ws-wt-r0",
			cells: ["ticker-fanout/rate-10000"],
			arms: ["ws", "wt"],
			armKinds: ["primary", "read-path", "overlay"],
			reps: 1,
			scheduledArms: 4,
			entries: [
				entry({}),
				entry({
					armId: "ticker-fanout/rate-10000/ws-worker",
					armKind: "read-path",
					armTransport: "ws-worker",
				}),
				entry({ armId: "ticker-fanout/rate-10000/wt", status: "FAIL" }),
				entry({
					armId: "ticker-fanout/rate-10000/wt-stream-sink",
					sealedPath: "/nonexistent/rep-1.sealed.json",
				}),
			],
		};
		const carried = resumableEntries(index);
		expect([...carried.keys()].sort()).toEqual(
			[
				campaignIndexKey({
					cellId: "ticker-fanout/rate-10000",
					armId: "ticker-fanout/rate-10000/ws",
					rep: 1,
				}),
				campaignIndexKey({
					cellId: "ticker-fanout/rate-10000",
					armId: "ticker-fanout/rate-10000/ws-worker",
					rep: 1,
				}),
			].sort(),
		);
		expect(resumableEntries(undefined).size).toBe(0);
	});

	it("parses the arm-kind and resume flags", () => {
		const narrowed = parseControllerArgs([
			"--arm-kinds=primary,overlay",
			"--execution-purpose=focused",
		]);
		expect(narrowed.ok).toBe(true);
		if (narrowed.ok) {
			expect(narrowed.spec.armKinds).toEqual(["primary", "overlay"]);
			expect(narrowed.spec.resume).toBeUndefined();
		}
		const resumed = parseControllerArgs([
			"--resume",
			"--execution-purpose=focused",
		]);
		expect(resumed.ok).toBe(true);
		if (resumed.ok) {
			expect(resumed.spec.resume).toBe(true);
			expect(resumed.spec.armKinds).toBeUndefined();
		}
		const rejected = parseControllerArgs([
			"--arm-kinds=read-path,sidecar",
			"--execution-purpose=focused",
		]);
		expect(rejected.ok).toBe(false);
	});
});
