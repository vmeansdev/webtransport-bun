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
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { MeasuredLeg } from "../client.ts";
import {
	cohortCellCardinality,
	STAGED_SERVER_TLS_CERTIFICATE_LEAF,
	stagedServerLaunchRecordProfile,
} from "../cohort-protocol.ts";
import { FANOUT_EXPANDED_DECLARATION_BY_CELL_ID } from "../cross-supervisor-protocol.ts";
import {
	FANOUT_COHORT_CELL_BY_ID,
	FANOUT_COHORT_CELL_IDS,
} from "../evidence.ts";
import type { PromotionGateRefusalCode } from "../output-policy.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "../scenario-registry.ts";
import type {
	CampaignIndex,
	CampaignIndexEntry,
	SealArm,
} from "./compare-controller.ts";
import {
	buildDryRunReport,
	buildNetemCommands,
	buildProductionClientArgv,
	buildSshArgv,
	campaignIndexKey,
	canonicalSealArmCount,
	DEFAULT_SSH_IDENTITY,
	defaultRigEndpoints,
	dispatchArmRepetition,
	grantDeclarationsFromCell,
	impairmentForCell,
	isPromotableFlatArm,
	measurementSeriesFromLeg,
	PHASE4_GATE_CELLS,
	parseControllerArgs,
	parseLinuxRoute,
	parseMacRoute,
	promoteCampaignFlats,
	resolveStagedAuthorityDigest,
	resumableEntries,
	sealArmSchedule,
	sealArmSlotId,
	sealArmsForCell,
	sealGrantDeclarationForArm,
	sealOrStopRepetition,
	sealRunIdForArm,
	serverUrlForTransport,
	teardownCohortArmLease,
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
			executionPurpose: "focused",
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

	// This is the *leg* declaration -- what one executor run transfers -- and not
	// the declaration a fanout arm's grant is opened under. `ticker-fanout` reads
	// 100,000x100 here; the seal path asks `sealGrantDeclarationForArm`, which
	// states the §4.1 expansion 10,000,000x100 for the same cell.
	it("grantDeclarationsFromCell returns the unexpanded leg declaration for bulk and ticker", () => {
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

	it("fanout_declaration_table_matches_seal_path", () => {
		const cellIds = Object.keys(FANOUT_EXPANDED_DECLARATION_BY_CELL_ID);
		expect(cellIds.sort()).toEqual([...FANOUT_COHORT_CELL_IDS].sort());
		for (const cellId of cellIds) {
			const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
				(c) => c.cellId === cellId,
			);
			expect(cell).toBeDefined();
			const seal = sealGrantDeclarationForArm({
				cell: cell!,
				armKind: "primary",
			});
			expect(seal.grantDeclaration).toBe("fanout-expanded-deliveries");
			expect({
				declaredMessageCount: seal.declaredMessageCount,
				declaredMessageBytes: seal.declaredMessageBytes,
			}).toEqual(FANOUT_EXPANDED_DECLARATION_BY_CELL_ID[cellId]!);
			// And the count is the §4.5 expansion, not a literal typed twice.
			const cardinality = cohortCellCardinality(
				FANOUT_COHORT_CELL_BY_ID[cellId]!,
			);
			expect(seal.declaredMessageCount).toBe(
				cardinality.measuredIngress * cardinality.subscriberCount,
			);
		}
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
			schema: "campaign-index-entry/v2",
			cellId: "ticker-fanout/rate-10000",
			armId: "ticker-fanout/rate-10000/ws",
			transport: "ws",
			armKind: "primary",
			armTransport: "ws",
			impairment: "none",
			executionPurpose: "focused",
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
			status: "PASS",
			promotable: true,
			failureCode: null,
			refusalCode: null,
			sealedPath: import.meta.path,
			artifactSha256: null,
			...overrides,
		});
		const index: CampaignIndex = {
			schema: "campaign-index/v2",
			campaignRunId: "campaign-r0",
			stage: "full",
			candidate: "ws-wt-r0",
			campaignId: "campaign-r0",
			approvedPlanSha256: "a".repeat(64),
			approvalRecordSha256: "b".repeat(64),
			stagedCapabilitySha256: "c".repeat(64),
			sourceArchiveSha256: "d".repeat(64),
			executionPurpose: "focused",
			cells: ["ticker-fanout/rate-10000"],
			arms: ["ws", "wt"],
			armKinds: ["primary", "read-path", "overlay"],
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 4,
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
					repetitionIndex: 1,
				}),
				campaignIndexKey({
					cellId: "ticker-fanout/rate-10000",
					armId: "ticker-fanout/rate-10000/ws-worker",
					repetitionIndex: 1,
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

describe("the controller's one promotion selector (plan section 6)", () => {
	const CELL = "ticker-fanout/rate-10000";
	const CELL_SAFE = "ticker-fanout_rate-10000";
	const CAMPAIGN = "b4-canonical-r1";

	function seedRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "b4-promotion-"));
		// A pre-existing evidence root: seals, a per-rep leg, a nested index, and
		// one file no promotion has any business rewriting.
		mkdirSync(join(root, "nested"), { recursive: true });
		writeFileSync(join(root, "campaign-index.json"), '{"schema":"pre"}\n');
		writeFileSync(join(root, "nested", "leg.json"), '{"leg":true}\n');
		return root;
	}

	function sealPath(root: string, transport: "ws" | "wt", rep: number): string {
		const path = join(root, `${CELL_SAFE}-${transport}-rep${rep}.sealed.json`);
		writeFileSync(path, `{"transport":"${transport}","rep":${rep}}\n`);
		return path;
	}

	function entry(
		root: string,
		transport: "ws" | "wt",
		repetitionIndex: number,
		overrides: Partial<CampaignIndexEntry> = {},
	): CampaignIndexEntry {
		return {
			schema: "campaign-index-entry/v2",
			cellId: CELL,
			armId: `${CELL}/${transport}`,
			transport,
			armKind: "primary",
			armTransport: transport,
			impairment: "physical",
			executionPurpose: "canonical",
			repetitionKind: "measured",
			repetitionIndex,
			repetitionTotal: 5,
			status: "PASS",
			promotable: true,
			failureCode: null,
			refusalCode: null,
			sealedPath: sealPath(root, transport, repetitionIndex),
			artifactSha256: "a".repeat(64),
			primaryMetricP50: 10 + repetitionIndex,
			readPath: null,
			...overrides,
		};
	}

	function fullSet(
		root: string,
		overrides: Partial<CampaignIndexEntry> = {},
	): CampaignIndexEntry[] {
		const out: CampaignIndexEntry[] = [];
		for (const transport of ["ws", "wt"] as const)
			for (let rep = 1; rep <= 5; rep += 1)
				out.push(entry(root, transport, rep, overrides));
		return out;
	}

	function digestTree(root: string): Map<string, string> {
		const out = new Map<string, string>();
		const walk = (dir: string, prefix: string): void => {
			for (const ent of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, ent.name);
				const key = prefix === "" ? ent.name : `${prefix}/${ent.name}`;
				if (ent.isDirectory()) walk(path, key);
				else
					out.set(
						key,
						createHash("sha256").update(readFileSync(path)).digest("hex"),
					);
			}
		};
		walk(root, "");
		return out;
	}

	it("promotes a complete five-of-five paired canonical set", async () => {
		const root = seedRoot();
		const result = await promoteCampaignFlats({
			evidenceDir: root,
			campaignId: CAMPAIGN,
			executionPurpose: "canonical",
			cellIds: [CELL],
			entries: fullSet(root),
			receiptGraphComplete: () => true,
		});
		expect(result.refusals).toEqual([]);
		expect(result.promotedCells).toEqual([CELL]);
		expect(result.flatsWritten.length).toBe(2);
		expect(existsSync(join(root, `${CELL_SAFE}-ws.json`))).toBe(true);
		expect(existsSync(join(root, `${CELL_SAFE}-wt.json`))).toBe(true);
	});

	it("writes no flat when a canonical run declares repetitionTotal !== 5", async () => {
		const root = seedRoot();
		const result = await promoteCampaignFlats({
			evidenceDir: root,
			campaignId: CAMPAIGN,
			executionPurpose: "canonical",
			cellIds: [CELL],
			// One measured rep on each wire, honestly declared as a total of 1.
			entries: [
				entry(root, "ws", 1, { repetitionTotal: 1 }),
				entry(root, "wt", 1, { repetitionTotal: 1 }),
			],
			receiptGraphComplete: () => true,
		});
		expect(result.promotedCells).toEqual([]);
		expect(result.flatsWritten).toEqual([]);
		expect(result.refusals[0]?.codes).toContain(
			"PROMOTION_REPETITION_TOTAL_INVALID",
		);
		expect(existsSync(join(root, `${CELL_SAFE}-ws.json`))).toBe(false);
		expect(existsSync(join(root, `${CELL_SAFE}-wt.json`))).toBe(false);
	});

	it("writes no flat for a three-of-five set, duplicate rep, or unclosed receipt graph", async () => {
		const root = seedRoot();
		const cases: {
			readonly label: string;
			readonly entries: CampaignIndexEntry[];
			readonly receiptGraphComplete: () => boolean;
			readonly code: PromotionGateRefusalCode;
		}[] = [
			{
				label: "three of five",
				entries: fullSet(root).filter((e) => e.repetitionIndex <= 3),
				receiptGraphComplete: () => true,
				code: "PROMOTION_MEASURED_SET_INCOMPLETE",
			},
			{
				label: "duplicate rep",
				entries: [...fullSet(root), entry(root, "ws", 3)],
				receiptGraphComplete: () => true,
				code: "PROMOTION_REPETITION_DUPLICATE",
			},
			{
				label: "unclosed receipt graph",
				entries: fullSet(root),
				receiptGraphComplete: () => false,
				code: "PROMOTION_RECEIPT_GRAPH_INCOMPLETE",
			},
		];
		for (const scenario of cases) {
			const result = await promoteCampaignFlats({
				evidenceDir: root,
				campaignId: CAMPAIGN,
				executionPurpose: "canonical",
				cellIds: [CELL],
				entries: scenario.entries,
				receiptGraphComplete: scenario.receiptGraphComplete,
			});
			expect(`${scenario.label}: ${result.flatsWritten.length}`).toBe(
				`${scenario.label}: 0`,
			);
			expect(result.refusals[0]?.codes).toContain(scenario.code);
		}
	});

	it("refuses a flat surviving from another campaign rather than overwriting it", async () => {
		const root = seedRoot();
		const stale = join(root, `${CELL_SAFE}-ws.json`);
		writeFileSync(stale, '{"comparisonId":"an-earlier-campaign"}\n');
		const before = readFileSync(stale, "utf8");
		const result = await promoteCampaignFlats({
			evidenceDir: root,
			campaignId: CAMPAIGN,
			executionPurpose: "canonical",
			cellIds: [CELL],
			entries: fullSet(root),
			receiptGraphComplete: () => true,
		});
		expect(result.flatsWritten).toEqual([]);
		expect(result.refusals[0]?.codes).toContain("PROMOTION_STALE_ECHO");
		expect(readFileSync(stale, "utf8")).toBe(before);
	});

	it("writes zero flats for focused and pilot purposes", async () => {
		for (const purpose of ["focused", "pilot"] as const) {
			const root = seedRoot();
			const result = await promoteCampaignFlats({
				evidenceDir: root,
				campaignId: CAMPAIGN,
				executionPurpose: purpose,
				cellIds: [CELL],
				entries: fullSet(root, { executionPurpose: purpose }),
				receiptGraphComplete: () => true,
			});
			expect(result.flatsWritten).toEqual([]);
			expect(result.refusals[0]?.codes).toContain(
				"PROMOTION_PURPOSE_NOT_CANONICAL",
			);
		}
	});

	it("leaves an existing evidence root untouched: files and digests unchanged", async () => {
		const root = seedRoot();
		const entries = fullSet(root);
		const before = digestTree(root);
		const promoted = await promoteCampaignFlats({
			evidenceDir: root,
			campaignId: CAMPAIGN,
			executionPurpose: "canonical",
			cellIds: [CELL],
			entries,
			receiptGraphComplete: () => true,
		});
		expect(promoted.flatsWritten.length).toBe(2);
		const after = digestTree(root);
		for (const [name, digest] of before)
			expect(`${name}=${after.get(name)}`).toBe(`${name}=${digest}`);
		// Only the two flats are new; nothing pre-existing was rewritten or removed.
		const added = [...after.keys()].filter((name) => !before.has(name)).sort();
		expect(added).toEqual([`${CELL_SAFE}-ws.json`, `${CELL_SAFE}-wt.json`]);

		// And a refused promotion adds nothing at all.
		const untouched = mkdtempSync(join(tmpdir(), "b4-promotion-refused-"));
		writeFileSync(join(untouched, "keep.json"), '{"keep":true}\n');
		const baseline = digestTree(untouched);
		const refused = await promoteCampaignFlats({
			evidenceDir: untouched,
			campaignId: CAMPAIGN,
			executionPurpose: "canonical",
			cellIds: [CELL],
			entries: entries.filter((e) => e.repetitionIndex <= 4),
			receiptGraphComplete: () => true,
		});
		expect(refused.flatsWritten).toEqual([]);
		expect([...digestTree(untouched)]).toEqual([...baseline]);
	});
});

describe("resume never carries another campaign's entries into the set gate", () => {
	function indexFor(campaignId: string, sealedPath: string): CampaignIndex {
		return {
			schema: "campaign-index/v2",
			campaignRunId: campaignId,
			stage: "full",
			candidate: "b".repeat(40),
			campaignId,
			approvedPlanSha256: "c".repeat(64),
			approvalRecordSha256: "d".repeat(64),
			stagedCapabilitySha256: "e".repeat(64),
			sourceArchiveSha256: "f".repeat(64),
			executionPurpose: "canonical",
			cells: ["ticker-fanout/rate-10000"],
			arms: ["ws", "wt"],
			armKinds: ["primary"],
			warmupRepetitions: 1,
			measuredRepetitions: 5,
			scheduledMeasuredArms: 10,
			entries: [
				{
					schema: "campaign-index-entry/v2",
					cellId: "ticker-fanout/rate-10000",
					armId: "ticker-fanout/rate-10000/ws",
					transport: "ws",
					armKind: "primary",
					armTransport: "ws",
					impairment: "physical",
					executionPurpose: "canonical",
					repetitionKind: "measured",
					repetitionIndex: 1,
					repetitionTotal: 5,
					status: "PASS",
					promotable: true,
					failureCode: null,
					refusalCode: null,
					sealedPath,
					artifactSha256: "a".repeat(64),
					primaryMetricP50: 11,
					readPath: null,
				},
			],
		};
	}

	it("carries a PASS entry forward for the same campaign and drops it for another", () => {
		const root = mkdtempSync(join(tmpdir(), "b4-resume-"));
		const sealedPath = join(root, "rep1.sealed.json");
		writeFileSync(sealedPath, "{}\n");
		expect(
			resumableEntries(indexFor("same-r1", sealedPath), "same-r1").size,
		).toBe(1);
		expect(
			resumableEntries(indexFor("an-earlier-campaign", sealedPath), "same-r1")
				.size,
		).toBe(0);
	});
});

/**
 * The production dispatch, seen from the controller's own suite.
 *
 * `realRunBody` schedules arms and hands each repetition to
 * `dispatchArmRepetition`; these tests drive that same function over the whole
 * frozen registry, so an arm that the router and `cohortCellForArm` disagree
 * about is a failure here rather than a `CohortExecutorRequiredError` thrown
 * mid-campaign against a live rig.
 */
describe("two-host controller: the production dispatch seam", () => {
	function armInputFor(cellId: string, arm: SealArm) {
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) => candidate.cellId === cellId,
		);
		if (cell === undefined) throw new Error(`no registry cell ${cellId}`);
		return {
			cell,
			arm,
			runId: `seam-${arm.armId}`,
			repIndex: 1,
			repetitionKind: "measured",
			repetitionTotal: 1,
			executionPurpose: "pilot",
			perRepPath: "/dev/null",
			sealedPath: "/dev/null",
		} as unknown as Parameters<typeof dispatchArmRepetition>[0]["arm"];
	}

	it("routes every registry arm the way cohortCellForArm does", async () => {
		let cohort = 0;
		let leg = 0;
		for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
			for (const arm of sealArmsForCell(cell)) {
				const expectCohort =
					FANOUT_COHORT_CELL_IDS.includes(cell.cellId) &&
					arm.armKind === "primary";
				const dispatched = await dispatchArmRepetition({
					arm: armInputFor(cell.cellId, arm),
					executors: {
						measureSealAndWriteRep: async () => ({
							ok: true,
							primaryMetricP50: 0,
							sealedPath: "/dev/null",
							artifactSha256: "0".repeat(64),
						}),
					},
				});
				if (expectCohort) {
					cohort += 1;
					expect(dispatched.route).toBe("cohort");
					// No runtime is wired yet, so the honest answer is a closed §7
					// code -- not a leg measurement of one publisher.
					expect(dispatched.result.ok).toBe(false);
					if (dispatched.result.ok) throw new Error("unreachable");
					expect(dispatched.result.failureCode).toBe("COHORT_NOT_READY");
				} else {
					leg += 1;
					expect(dispatched.route).toBe("single-session-leg");
					expect(dispatched.result.ok).toBe(true);
				}
			}
		}
		// Two wires for each of the six switched cells, and nothing else.
		expect(cohort).toBe(FANOUT_COHORT_CELL_IDS.length * 2);
		expect(leg).toBeGreaterThan(0);
	});

	it("refuses a fanout primary rather than sealing it as a leg", async () => {
		for (const cellId of FANOUT_COHORT_CELL_IDS) {
			for (const arm of sealArmsForCell(
				CANONICAL_SCENARIO_REGISTRY.cells.find((c) => c.cellId === cellId)!,
				["ws", "wt"],
				["primary"],
			)) {
				const dispatched = await dispatchArmRepetition({
					arm: armInputFor(cellId, arm),
					executors: {
						measureSealAndWriteRep: async () => {
							throw new Error(`leg reached for ${arm.armId}`);
						},
					},
				});
				expect(dispatched.result.ok).toBe(false);
				if (dispatched.result.ok) throw new Error("unreachable");
				// The reason names the cell, so a campaign index row says which
				// cohort was missing rather than that "something" refused.
				expect(dispatched.result.reason).toContain(
					FANOUT_COHORT_CELL_BY_ID[cellId] as string,
				);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Amendment slice 5: the signed execution identity, the uid preflight, the
// Phase-A executor seam and the attestation assembly
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import {
	mkdirSync as mkdirSync5,
	mkdtempSync as mkdtempSync5,
	readFileSync as readFileSync5,
	writeFileSync as writeFileSync5,
} from "node:fs";
import { tmpdir as tmpdir5 } from "node:os";
import { join as join5 } from "node:path";
import { PassThrough } from "node:stream";
import { canonicalJson as canonicalJson5 } from "../canonical.ts";
import {
	mintPhaseAAttestationFixture,
	scriptedRigExecutionAcceptedAck,
} from "../cohort-fixture-signing.ts";
import {
	bytesOfCanonical,
	decodeRegisteredRemotePayload,
	encodeRegisteredRemotePayload,
	generateEd25519KeyPair,
	parseCrossSupervisorExecutionDraft,
} from "../cross-supervisor-protocol.ts";
import {
	buildRigSupervisorWrapperScript,
	CohortRigChannel,
	type StagedTrustBootstrapPaths,
	TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
	TRUST_BOOTSTRAP_AUTHORITY_LEAF,
} from "../remote-supervisor.ts";
import { CANONICAL_SCENARIO_REGISTRY as REGISTRY5 } from "../scenario-registry.ts";
import { canonicalRecordBytes, sha256HexOfBytes } from "../secure-fs.ts";
import { verifyServerObservationEvidence } from "../server-observation-artifact.ts";
import {
	buildStagedServerLaunchRecord,
	stagedServerLaunchModesForProfile,
	stagedServerLaunchRecordLeaf,
} from "../server.ts";
import type {
	CohortArmMeasuredV1,
	CohortArmRuntimeProvider,
} from "./compare-controller.ts";
import {
	assembleServerObservationEvidence,
	buildSignedExecutionDraft,
	createPhaseARigLifecycleOverChannel,
	dispatchArmRepetition as dispatchArmRepetition5,
	EXECUTABLE_ROLE_ENTRYPOINT_PATH,
	executableRoleEntrypoint,
	macUidPreflightChecks,
	observeMacClockIdentity,
	readStagedCohortMaterial,
	rigTrustBootstrapPaths,
	runMacUidPreflight,
	sealArmsForCell as sealArmsForCell5,
	stagedServerLaunchRecordFor,
	signedExecutionRunId,
	workloadRolePlanInputFor,
} from "./compare-controller.ts";

const HEX5 = (character: string): string => character.repeat(64);

function stagedFixture(options?: {
	readonly phaseA?: boolean;
	readonly profile?: "phase-a" | "phase-b" | "local-acceptance";
}) {
	const profile =
		options?.profile ?? (options?.phaseA === true ? "phase-a" : "phase-b");
	const stagedDir = mkdtempSync5(join5(tmpdir5(), "slice5-staged-"));
	const stagingRootDir = join5(stagedDir, "staging-root");
	const campaignRootDir = join5(stagedDir, "campaign-root");
	mkdirSync5(stagingRootDir, { recursive: true });
	mkdirSync5(campaignRootDir, { recursive: true });
	mkdirSync5(join5(stagedDir, "roles"), { recursive: true });
	const macKey = new Uint8Array(32).fill(7);
	const rigKey = new Uint8Array(32).fill(9);
	writeFileSync5(join5(stagingRootDir, "mac-supervisor-ed25519.pub"), macKey);
	writeFileSync5(join5(stagingRootDir, "rig-supervisor-ed25519.pub"), rigKey);
	// A PEM-shaped certificate leaf: the reader checks the marker and the digest,
	// not the ASN.1, so a fixture body is enough for the staging contract.
	const tlsCertificate = new TextEncoder().encode(
		"-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n",
	);
	writeFileSync5(
		join5(stagingRootDir, STAGED_SERVER_TLS_CERTIFICATE_LEAF),
		tlsCertificate,
	);
	const launchDigests = {} as Record<"ws" | "wt", Record<string, string>>;
	for (const transport of ["ws", "wt"] as const) {
		launchDigests[transport] = {};
		for (const mode of stagedServerLaunchModesForProfile(profile)) {
			const bytes = canonicalRecordBytes(
				buildStagedServerLaunchRecord({
					profile,
					transport,
					mode,
					serverEntrypointSha256: HEX5("2") as never,
					bunSha256: HEX5("3") as never,
					addonSha256: HEX5("4") as never,
					bindPort: 4433,
					tlsCertificateSha256: sha256HexOfBytes(tlsCertificate),
					tlsPrivateKeySha256: HEX5("9") as never,
				}),
			);
			writeFileSync5(
				join5(stagingRootDir, stagedServerLaunchRecordLeaf(transport, mode)),
				bytes,
			);
			launchDigests[transport][mode] = sha256HexOfBytes(bytes);
		}
	}
	const roleSource = "// staged role entrypoint\n";
	if (profile !== "phase-a") {
		writeFileSync5(join5(stagedDir, "roles", "fanout-role.ts"), roleSource);
	}
	const receipt = {
		schema: "live-stage-receipt/v1",
		stageProfile: profile,
		cohortServerHost:
			profile === "local-acceptance" ? "127.0.0.1" : "10.99.0.2",
		rigRoleRootPath: "/tmp/ws-wt-linux-build.fixture/tools/compare",
		candidate: "cand",
		campaignId: "camp",
		approvedPlanSha256: HEX5("a"),
		approvalRecordSha256: HEX5("b"),
		archiveSha256: HEX5("c"),
		capabilitySha256: HEX5("d"),
		macSigningPublicKeySha256: sha256HexOfBytes(macKey),
		rigSigningPublicKeySha256: sha256HexOfBytes(rigKey),
		macBunSha256: HEX5("e"),
		linuxBunSha256: HEX5("f"),
		linuxAddonManifestSha256: HEX5("1"),
		serverEntrypointSha256: HEX5("2"),
		fanoutRoleEntrypointSha256:
			profile === "phase-a"
				? null
				: sha256HexOfBytes(new TextEncoder().encode(roleSource)),
		stagedServerLaunchRecordSha256ByLaunch: launchDigests,
		tlsCertificateSha256: sha256HexOfBytes(tlsCertificate),
		notAfterMs: 17_000_000_000_000,
	};
	writeFileSync5(
		join5(stagedDir, "stage-receipt.json"),
		canonicalRecordBytes(receipt),
	);
	const paths: StagedTrustBootstrapPaths = {
		stagedDir,
		authorityFile: join5(stagedDir, "authority.json"),
		authorityDigestFile: join5(stagedDir, "authority-digest.bin"),
		campaignRootDir,
		stagingRootDir,
		digests: {
			authority: HEX5("5"),
			lock: HEX5("6"),
			capability: HEX5("d"),
			manifest: HEX5("7"),
		},
	};
	return { stagedDir, stagingRootDir, paths, receipt, macKey, rigKey };
}

describe("slice 5: the staged material a signed execution is drafted from", () => {
	it("reads and digest-checks the keys, the launch record and the role entrypoint", () => {
		const fixture = stagedFixture();
		const material = readStagedCohortMaterial(fixture.paths);
		expect(material.ok).toBe(true);
		if (!material.ok) throw new Error(material.message);
		expect([...material.value.stagedMacPublicRaw32]).toEqual([
			...fixture.macKey,
		]);
		for (const transport of ["ws", "wt"] as const) {
			for (const mode of ["bulk-source", "fanout-cohort"] as const) {
				const staged = stagedServerLaunchRecordFor(
					material.value,
					transport,
					mode,
				);
				expect(staged.record.tlsServerName).toBe("wt-compare.local");
				expect(staged.record.transport).toBe(transport);
				expect(stagedServerLaunchRecordProfile(staged.record)).toBe("phase-b");
				expect(staged.record.argv).toContain(`--mode=${mode}`);
				expect(staged.sha256).toBe(
					fixture.receipt.stagedServerLaunchRecordSha256ByLaunch[transport][
						mode
					] as string,
				);
			}
		}
		expect(material.value.receipt.cohortServerHost).toBe("10.99.0.2");
		expect(material.value.receipt.rigRoleRootPath).toBe(
			"/tmp/ws-wt-linux-build.fixture/tools/compare",
		);
		expect(material.value.roleEntrypointPath).toBe(
			join5(fixture.stagedDir, "roles", "fanout-role.ts"),
		);
		expect(material.value.receipt.fanoutRoleEntrypointSha256).not.toBeNull();
	});

	it("carries a null role entrypoint for a phase-a stage, and only the bulk-source records", () => {
		const fixture = stagedFixture({ phaseA: true });
		const material = readStagedCohortMaterial(fixture.paths);
		expect(material.ok).toBe(true);
		if (!material.ok) throw new Error(material.message);
		expect(material.value.roleEntrypointPath).toBeNull();
		expect(Object.keys(material.value.stagedServerLaunchRecords.ws)).toEqual([
			"bulk-source",
		]);
		// A cohort spawn under a phase-a stage has no record to bind: that is a
		// caller error, not a runtime refusal.
		expect(() =>
			stagedServerLaunchRecordFor(material.value, "ws", "fanout-cohort"),
		).toThrow("binds no ws/fanout-cohort launch record");
	});

	it("reads a local-acceptance stage as loopback and refuses a receipt whose host, profile or record disagrees", () => {
		// Lead ruling G4 on design §3.1: the host is the profile's, bound in the
		// receipt and in every launch record; physical profiles refuse loopback
		// and the local profile refuses the cable address.
		const fixture = stagedFixture({ profile: "local-acceptance" });
		const material = readStagedCohortMaterial(fixture.paths);
		expect(material.ok).toBe(true);
		if (!material.ok) throw new Error(material.message);
		expect(material.value.receipt.stageProfile).toBe("local-acceptance");
		expect(material.value.receipt.cohortServerHost).toBe("127.0.0.1");
		const record = stagedServerLaunchRecordFor(
			material.value,
			"wt",
			"fanout-cohort",
		).record;
		expect(record.bindAddress).toBe("127.0.0.1");
		expect(record.advertisedHost).toBe("127.0.0.1");
		expect(record.argv).toContain("--bind=127.0.0.1");
		expect(record.argv).toContain("--stage-profile=local-acceptance");

		const refusalOf = (
			mutate: (receipt: Record<string, unknown>) => Record<string, unknown>,
		): string => {
			const other = stagedFixture({ profile: "local-acceptance" });
			writeFileSync5(
				join5(other.stagedDir, "stage-receipt.json"),
				canonicalRecordBytes(mutate({ ...other.receipt })),
			);
			const refused = readStagedCohortMaterial(other.paths);
			expect(refused.ok).toBe(false);
			if (refused.ok) throw new Error("unreachable");
			expect(refused.code).toBe("STALE_OR_INVALID_STAGING");
			return refused.message ?? "";
		};
		// The receipt restating the cable address under the local profile.
		expect(
			refusalOf((receipt) => ({ ...receipt, cohortServerHost: "10.99.0.2" })),
		).toContain("not the local-acceptance profile's host");
		// The receipt claiming a physical profile over loopback records: the
		// host check refuses first (same digests, other profile).
		expect(
			refusalOf((receipt) => ({ ...receipt, stageProfile: "phase-b" })),
		).toContain("not the phase-b profile's host");
		// A physical receipt that is self-consistent but whose records were
		// staged under the local profile: the record's profile is not the
		// receipt's.
		expect(
			refusalOf((receipt) => ({
				...receipt,
				stageProfile: "phase-b",
				cohortServerHost: "10.99.0.2",
			})),
		).toContain("was staged under local-acceptance");
		// A receipt whose mode set is not its profile's.
		expect(
			refusalOf((receipt) => ({
				...receipt,
				stagedServerLaunchRecordSha256ByLaunch: {
					ws: { "bulk-source": HEX5("1") },
					wt: { "bulk-source": HEX5("1") },
				},
			})),
		).toContain("not exactly the local-acceptance modes");
		// A role root that is not a path.
		expect(
			refusalOf((receipt) => ({ ...receipt, rigRoleRootPath: "roles" })),
		).toContain("rigRoleRootPath");
	});

	it("refuses a launch record whose argv is not the staged argv for its wire, mode and profile", () => {
		// The controller sends the bound record's argv and the rig compares it
		// byte for byte, so a record carrying any other argv would be a spawn
		// the stage did not bind. Same digests in the receipt; only the argv
		// differs.
		const fixture = stagedFixture();
		const leaf = join5(
			fixture.stagingRootDir,
			stagedServerLaunchRecordLeaf("ws", "bulk-source"),
		);
		const launch = JSON.parse(
			Buffer.from(readFileSync5(leaf)).toString("utf8"),
		) as Record<string, unknown> & { argv: string[] };
		const forged = canonicalRecordBytes({
			...launch,
			argv: [...launch.argv, "--scenario=chat-fanout"],
		});
		writeFileSync5(leaf, forged);
		writeFileSync5(
			join5(fixture.stagedDir, "stage-receipt.json"),
			canonicalRecordBytes({
				...fixture.receipt,
				stagedServerLaunchRecordSha256ByLaunch: {
					...fixture.receipt.stagedServerLaunchRecordSha256ByLaunch,
					ws: {
						...fixture.receipt.stagedServerLaunchRecordSha256ByLaunch.ws,
						"bulk-source": sha256HexOfBytes(forged),
					},
				},
			}),
		);
		const refused = readStagedCohortMaterial(fixture.paths);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.message).toContain(
			"argv is not the staged argv for ws/bulk-source under phase-b",
		);
	});

	it("carries the staged certificate as the CA and refuses a launch record that binds another one", () => {
		// Amendment C4: "Staging binds ... TLS": the CA every Mac-side connector
		// verifies against is the staged leaf, read through the receipt's
		// digest, and the launch record must bind the same certificate.
		const fixture = stagedFixture();
		const material = readStagedCohortMaterial(fixture.paths);
		expect(material.ok).toBe(true);
		if (!material.ok) throw new Error(material.message);
		expect(material.value.tlsCaPem).toContain("-----BEGIN CERTIFICATE-----");
		expect(
			sha256HexOfBytes(new TextEncoder().encode(material.value.tlsCaPem)),
		).toBe(fixture.receipt.tlsCertificateSha256);
		expect(
			stagedServerLaunchRecordFor(material.value, "wt", "fanout-cohort").record
				.tlsCertificateSha256,
		).toBe(fixture.receipt.tlsCertificateSha256);

		// The same leaf and receipt, with a launch record that names another
		// certificate: the receipt is rewritten to cover the record so only
		// the certificate binding differs.
		const other = stagedFixture();
		const launchPath = join5(
			other.stagingRootDir,
			stagedServerLaunchRecordLeaf("wt", "fanout-cohort"),
		);
		const launch = JSON.parse(
			Buffer.from(readFileSync5(launchPath)).toString("utf8"),
		) as Record<string, unknown>;
		const forged = canonicalRecordBytes({
			...launch,
			tlsCertificateSha256: HEX5("8"),
		});
		writeFileSync5(launchPath, forged);
		writeFileSync5(
			join5(other.stagedDir, "stage-receipt.json"),
			canonicalRecordBytes({
				...other.receipt,
				stagedServerLaunchRecordSha256ByLaunch: {
					...other.receipt.stagedServerLaunchRecordSha256ByLaunch,
					wt: {
						...other.receipt.stagedServerLaunchRecordSha256ByLaunch.wt,
						"fanout-cohort": sha256HexOfBytes(forged),
					},
				},
			}),
		);
		const refused = readStagedCohortMaterial(other.paths);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.code).toBe("STALE_OR_INVALID_STAGING");
		expect(refused.message).toContain("tls certificate");
	});

	it("spawns role children on this tree's importable entrypoint only when its bytes are the staged digest", () => {
		// The staged `roles/fanout-role.ts` is a bare leaf: its relative imports
		// resolve to nothing, so it binds and never runs. The file a child runs
		// is `bin/fanout-role.ts` beside the controller, admitted by the same
		// digest and refused under any other.
		const real = sha256HexOfBytes(
			new Uint8Array(readFileSync5(EXECUTABLE_ROLE_ENTRYPOINT_PATH)),
		);
		const admitted = executableRoleEntrypoint(real as never);
		expect(admitted.ok).toBe(true);
		if (!admitted.ok) throw new Error(admitted.message);
		expect(admitted.value).toBe(EXECUTABLE_ROLE_ENTRYPOINT_PATH);
		expect(admitted.value.endsWith(join5("bin", "fanout-role.ts"))).toBe(true);
		for (const staged of [HEX5("a"), null] as const) {
			const refused = executableRoleEntrypoint(staged as never);
			expect(refused.ok).toBe(false);
			if (refused.ok) throw new Error("unreachable");
			expect(refused.code).toBe("STALE_OR_INVALID_STAGING");
		}
	});

	it("refuses before traffic when a key, the launch record or the entrypoint disagrees with the receipt", () => {
		for (const leaf of [
			"staging-root/mac-supervisor-ed25519.pub",
			"staging-root/rig-supervisor-ed25519.pub",
			`staging-root/${stagedServerLaunchRecordLeaf("ws", "bulk-source")}`,
			`staging-root/${stagedServerLaunchRecordLeaf("ws", "fanout-cohort")}`,
			`staging-root/${stagedServerLaunchRecordLeaf("wt", "bulk-source")}`,
			`staging-root/${stagedServerLaunchRecordLeaf("wt", "fanout-cohort")}`,
			`staging-root/${STAGED_SERVER_TLS_CERTIFICATE_LEAF}`,
			"roles/fanout-role.ts",
		]) {
			const fixture = stagedFixture();
			const path = join5(fixture.stagedDir, leaf);
			const bytes = new Uint8Array(readFileSync5(path));
			bytes[0] = bytes[0] === 0 ? 1 : 0;
			writeFileSync5(path, bytes);
			const material = readStagedCohortMaterial(fixture.paths);
			expect(material.ok).toBe(false);
			if (material.ok) throw new Error("unreachable");
			expect(material.code).toBe("STALE_OR_INVALID_STAGING");
		}
	});
});

describe("G3b: the rig boots from one root", () => {
	// The 2026-08-24 amendment models the Linux supervisor with a single
	// retained staging handle and the authority declares exactly one Linux
	// root (`linux-staging`, the observe-linux `--root`): the controller hands
	// the rig that directory as its only root and names no campaign root.
	// The darwin local-acceptance rig is booted by the e2e from the Mac's own
	// pair; which arm a rig gets follows from the staging that produced its
	// root, never from an environment switch.
	it("the rig's bootstrap paths are the staged root and its two authority leaves, and nothing else", () => {
		const staged = "/home/hermes-admin/ws-wt-stage/cand/camp";
		const paths = rigTrustBootstrapPaths(staged);
		expect(paths.ok).toBe(true);
		if (!paths.ok) throw new Error("unreachable");
		expect(paths.paths).toEqual({
			authorityFile: `${staged}/${TRUST_BOOTSTRAP_AUTHORITY_LEAF}`,
			authorityDigestFile: `${staged}/${TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF}`,
			stagingRootDir: staged,
		});
		expect("campaignRootDir" in paths.paths).toBe(false);
		// At the execution point: the production wrapper fed these paths opens
		// the staged root on 6 and passes no `--campaign-root-fd`.
		const wrapper = buildRigSupervisorWrapperScript({
			binaryPath: "/bin/sh",
			bunExecutablePath: "/home/hermes-admin/.bun/bin/bun",
			bootstrap: {
				authority: { fd: 3, label: "authority" },
				authorityDigest: { fd: 4, label: "authority-digest" },
				campaignRoot: { fd: 5, label: "campaign-root" },
				stagingRoot: { fd: 6, label: "staging-root" },
			},
			rigBinaryPath: `${staged}/bin/comparison-supervisor`,
			rigPaths: paths.paths,
			uidCrossing: { targetUser: "_wtcompare" },
		});
		expect(wrapper.ok).toBe(true);
		if (!wrapper.ok) throw new Error(wrapper.code);
		expect(wrapper.script).toContain(`exec 6<'${staged}'`);
		expect(wrapper.script).not.toContain("exec 5<");
		expect(wrapper.script).not.toContain("--campaign-root-fd");
		expect(wrapper.script).toContain('--staging-root-fd "${staging_root_fd}"');
	});

	it("a staged root that is not absolute is refused by name before any spawn", () => {
		for (const bad of ["ws-wt-stage/cand/camp", "", "./stage"]) {
			const refused = rigTrustBootstrapPaths(bad);
			expect(refused.ok).toBe(false);
			if (refused.ok) throw new Error("unreachable");
			expect(refused.reason).toContain("REFUSED/STALE_OR_INVALID_STAGING");
			expect(refused.reason).toContain("COMPARISON_RIG_STAGED_DIR");
		}
	});
});

describe("slice 5: the Mac clock identity and the signed run id", () => {
	it("hashes kern.bootsessionuuid the way the binary does", () => {
		const observed = observeMacClockIdentity();
		expect(observed.ok).toBe(true);
		if (!observed.ok) throw new Error(observed.message);
		const raw = spawnSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
			encoding: "utf8",
		}).stdout.trim();
		expect(observed.value).toBe(
			sha256HexOfBytes(new TextEncoder().encode(raw)),
		);
		expect(observed.value).toMatch(/^[0-9a-f]{64}$/);
	});

	it("names warmup-0 and measured-n and never the same id for both", () => {
		const warmup = signedExecutionRunId({
			campaignId: "camp",
			cellId: "bulk-one-way/physical",
			transport: "ws",
			repetitionKind: "warmup",
			repetitionIndex: 0,
		});
		const measured = signedExecutionRunId({
			campaignId: "camp",
			cellId: "bulk-one-way/physical",
			transport: "ws",
			repetitionKind: "measured",
			repetitionIndex: 1,
		});
		expect(warmup).toBe("camp/bulk-one-way/physical/ws/warmup-0");
		expect(measured).toBe("camp/bulk-one-way/physical/ws/measured-1");
		expect(warmup).not.toBe(measured);
	});
});

describe("slice 5: the signed execution draft", () => {
	const bulk = REGISTRY5.cells.find(
		(cell) => cell.cellId === "bulk-one-way/physical",
	)!;
	const ticker = REGISTRY5.cells.find(
		(cell) => cell.cellId === "ticker-fanout/rate-10000",
	)!;

	function draftFor(
		cell: typeof bulk,
		armKind: "primary" | "read-path" | "overlay",
		transport: "ws" | "wt" = "ws",
	) {
		const fixture = stagedFixture();
		const material = readStagedCohortMaterial(fixture.paths);
		if (!material.ok) throw new Error(material.message);
		const arm = sealArmsForCell5(cell, [transport], [armKind])[0];
		if (arm === undefined)
			throw new Error(`no ${armKind} arm for ${cell.cellId}`);
		return buildSignedExecutionDraft({
			staged: material.value,
			bootstrap: fixture.paths,
			cell,
			arm,
			serverMode: cell.cellId.startsWith("bulk-")
				? "bulk-source"
				: "fanout-cohort",
			executionPurpose: "focused",
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
		});
	}

	it("drafts the Phase-A completed transfer for the bulk primary and the fanout expansion for a cohort primary", () => {
		const bulkDraft = draftFor(bulk, "primary");
		expect(bulkDraft.ok).toBe(true);
		if (!bulkDraft.ok) throw new Error(bulkDraft.message);
		expect(bulkDraft.value.draft.grantDeclaration).toBe(
			"phase-a-completed-transfer",
		);
		expect(bulkDraft.value.draft.declaredMessageCount).toBe(1600);
		expect(bulkDraft.value.draft.runId).toBe(
			"camp/bulk-one-way/physical/ws/measured-1",
		);
		expect(parseCrossSupervisorExecutionDraft(bulkDraft.value.draft).ok).toBe(
			true,
		);
		const workload = workloadRolePlanInputFor(bulk, "ws");
		expect(bulkDraft.value.draft.workloadRolePlanInputSha256).toBe(
			workload.sha256,
		);
		expect(sha256HexOfBytes(bulkDraft.value.draftBytes)).toBe(
			sha256HexOfBytes(canonicalRecordBytes(bulkDraft.value.draft)),
		);

		const cohortDraft = draftFor(ticker, "primary", "wt");
		expect(cohortDraft.ok).toBe(true);
		if (!cohortDraft.ok) throw new Error(cohortDraft.message);
		expect(cohortDraft.value.draft.grantDeclaration).toBe(
			"fanout-expanded-deliveries",
		);
		expect(cohortDraft.value.draft.declaredMessageCount).toBe(10_000_000);
		expect(parseCrossSupervisorExecutionDraft(cohortDraft.value.draft).ok).toBe(
			true,
		);
	});

	it("refuses a non-primary arm and an unregistered declaration by name rather than drafting one", () => {
		const readPath = draftFor(ticker, "read-path");
		expect(readPath.ok).toBe(false);
		if (readPath.ok) throw new Error("unreachable");
		expect(readPath.message).toContain("primary arms only");
		const echo = REGISTRY5.cells.find(
			(cell) => cell.scenarioId === "ai-token-stream",
		);
		if (echo === undefined) throw new Error("no ai-token-stream cell");
		const unregistered = draftFor(echo, "primary");
		expect(unregistered.ok).toBe(false);
		if (unregistered.ok) throw new Error("unreachable");
		expect(unregistered.message).toContain("no signed execution identity");
	});
});

describe("slice 5: the twelve uid access preconditions", () => {
	const inputs = {
		targetUser: "_wtcompare",
		macSigningKeyPath:
			"/var/db/webtransport-bun/comparison/keys/cand/camp.mac.pk8",
		macTrustDir: "/tmp/mac-trust",
		campaignRootDir: "/tmp/mac-trust/campaign-root",
		stagingRootDir: "/tmp/mac-trust/staging-root",
		bunExecutablePath: "/opt/bun",
	};

	it("states exactly the design's twelve checks, in order, with the controller-side ones spelled locally", () => {
		const checks = macUidPreflightChecks(inputs);
		expect(checks.map((check) => check.index)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
		]);
		expect(checks[1]?.argv).toEqual([
			"/bin/test",
			"!",
			"-r",
			inputs.macSigningKeyPath,
		]);
		expect(checks[9]?.argv).toEqual([
			"/bin/test",
			"-r",
			inputs.campaignRootDir,
		]);
		for (const check of checks) {
			if (check.index === 2 || check.index === 10) continue;
			expect(check.argv.slice(0, 4)).toEqual([
				"/usr/bin/sudo",
				"-n",
				"-u",
				"_wtcompare",
			]);
		}
		expect(checks[11]?.argv).toEqual([
			"/usr/bin/sudo",
			"-n",
			"-u",
			"_wtcompare",
			"/bin/test",
			"-x",
			"/bin/kill",
		]);
		expect(checks[10]?.argv).toContain(inputs.bunExecutablePath);
	});

	it("passes when every check exits 0 and refuses before traffic naming the first that does not", () => {
		const ran: string[] = [];
		const pass = runMacUidPreflight(inputs, (argv) => {
			ran.push(argv.join(" "));
			return { exitCode: 0, stderr: "" };
		});
		expect(pass.ok).toBe(true);
		expect(ran.length).toBe(12);

		const refused = runMacUidPreflight(inputs, (argv) =>
			argv.includes(inputs.macSigningKeyPath) && argv[0] === "/bin/test"
				? { exitCode: 1, stderr: "" }
				: { exitCode: 0, stderr: "" },
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.code).toBe("STALE_OR_INVALID_STAGING");
		expect(refused.message).toContain("REFUSED/STALE_OR_INVALID_STAGING");
		expect(refused.message).toContain("check 2");
		expect(refused.message).toContain(
			"controller cannot read the Mac signing key",
		);
	});
});

describe("slice 5: the Phase-A rig executor seam", () => {
	function lifecycleOver(
		respond: (
			request: Record<string, unknown>,
		) => Record<string, unknown> | "silence",
	) {
		const controllerToRig = new PassThrough();
		const rigToController = new PassThrough();
		const seen: Record<string, unknown>[] = [];
		controllerToRig.on("data", (chunk: Buffer) => {
			const frame = new Uint8Array(chunk);
			const decoded = decodeRegisteredRemotePayload(frame);
			if (!decoded.ok) throw new Error(`scripted rig: ${decoded.code}`);
			seen.push(decoded.value.payload);
			const reply = respond(decoded.value.payload);
			if (reply === "silence") {
				rigToController.end();
				return;
			}
			const encoded = encodeRegisteredRemotePayload(
				reply as Record<string, unknown> & { schema: string },
			);
			if (!encoded.ok) throw new Error(`scripted rig encode: ${encoded.code}`);
			rigToController.write(Buffer.from(encoded.value));
		});
		const rigKeys = generateEd25519KeyPair();
		const lifecycle = createPhaseARigLifecycleOverChannel(
			new CohortRigChannel({
				controllerToRig,
				rigToController,
				executionSha256: HEX5("1"),
				stagedRigPublicRaw32: rigKeys.publicRaw32,
				deadlines: {
					frameMs: 1_000,
					serverReadyMs: 100,
					warmupDrainMs: 100,
					captureMs: 100,
					teardownMs: 100,
				},
			}),
		);
		return { lifecycle, seen, rigKeys };
	}

	const PHASE_A_TRIO = {
		measurementGrantBytes: bytesOfCanonical({ schema: "measurement-grant/v1" }),
		receiptBytes: bytesOfCanonical({
			schema: "mac-execution-grant-receipt/v1",
			notAfterMs: 900_000,
		}),
		receiptSignatureBytes: bytesOfCanonical({
			schema: "mac-receipt-signature/v1",
			signedSchema: "mac-execution-grant-receipt/v1",
		}),
	};

	// The positive replacement for the seam's former "no executor" refusal:
	// §5 RIG_EXECUTION_ACCEPTED goes out as the registered frame carrying the
	// exact Phase-A trio, and the rig's signed acceptance comes back verified.
	it("accepts the execution over the channel with the exact grant, receipt and signature bytes", async () => {
		let rigKeysRef: ReturnType<typeof generateEd25519KeyPair> | null = null;
		const { lifecycle, seen, rigKeys } = lifecycleOver((request) =>
			scriptedRigExecutionAcceptedAck({
				rigKeys:
					rigKeysRef ??
					(() => {
						throw new Error("keys");
					})(),
				request,
				executionSha256: HEX5("1"),
				responseSeq: 0,
				nowMs: 1_000,
			}),
		);
		rigKeysRef = rigKeys;
		const accepted = await lifecycle.acceptExecution(PHASE_A_TRIO);
		if (!accepted.ok) throw new Error(`${accepted.code}: ${accepted.message}`);
		expect(seen.map((frame) => frame.schema)).toEqual([
			"rig-accept-execution-request/v1",
		]);
		expect(seen[0]?.measurementGrantBase64).toBe(
			Buffer.from(PHASE_A_TRIO.measurementGrantBytes).toString("base64"),
		);
		expect(seen[0]?.macExecutionGrantReceiptBase64).toBe(
			Buffer.from(PHASE_A_TRIO.receiptBytes).toString("base64"),
		);
		expect(seen[0]?.macExecutionGrantSignatureBase64).toBe(
			Buffer.from(PHASE_A_TRIO.receiptSignatureBytes).toString("base64"),
		);
		expect(accepted.value.acceptance.measurementGrantSha256).toBe(
			sha256HexOfBytes(PHASE_A_TRIO.measurementGrantBytes),
		);
		expect(accepted.value.acceptance.macExecutionGrantReceiptSha256).toBe(
			sha256HexOfBytes(PHASE_A_TRIO.receiptBytes),
		);
		expect(accepted.value.signature.signedSchema).toBe(
			"rig-execution-acceptance/v1",
		);
	});

	it("carries the rig's own refusal of the execution and writes nothing after it", async () => {
		const { lifecycle, seen } = lifecycleOver((request) => ({
			schema: "remote-supervisor-refusal/v1",
			responseSeq: 0,
			ackRequestSeq: request.requestSeq as number,
			executionSha256: null,
			code: "COHORT_NOT_READY",
			campaignStatus: "FAIL",
			terminal: true,
		}));
		const accepted = await lifecycle.acceptExecution(PHASE_A_TRIO);
		expect(accepted.ok).toBe(false);
		if (accepted.ok) throw new Error("unreachable");
		expect(accepted.code).toBe("COHORT_NOT_READY");
		// The ordinary (non-cohort) server spawn and baseline still have no
		// sender on this channel: they refuse by name before any frame.
		const spawned = await lifecycle.spawnServer({
			cohortGrantSha256: null,
			serverEntrypointSha256: HEX5("2"),
			bunSha256: HEX5("3"),
			addonSha256: HEX5("4"),
			stagedServerLaunchRecordBytes: new Uint8Array([1]),
			bindPort: 4433,
			transport: "ws",
			serverArgv: ["server.ts"],
		});
		expect(spawned.ok).toBe(false);
		const baseline = await lifecycle.measureStart({
			rigWarmupDrainedReceiptSha256: null,
			roleWarmupCompletionManifestSha256: null,
		});
		expect(baseline.ok).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(seen.length).toBe(1);
	});

	// R-K: the rig compares `warmupCompleteSha256` with the completion manifest
	// it retained at the drain and refuses a null as a controller describing
	// some other execution (secure_fs.rs `measure_start`); e2e-6 of the gate-3
	// acceptance was exactly that refusal, `CROSS_SUPERVISOR_MISMATCH` on the
	// `rig-measure-start-request/v1`. The adapter therefore sends the drain's
	// two digests the way `CohortChannelRigBinding.measureStartAck` does.
	function channelRecordingMeasureStart() {
		const sent: {
			warmupCompleteSha256: string | null;
			rigWarmupDrainedReceiptSha256: string;
		}[] = [];
		const channel = {
			measureStart: async (args: {
				readonly warmupCompleteSha256: string | null;
				readonly rigWarmupDrainedReceiptSha256: string;
			}) => {
				sent.push(args);
				return { ok: false as const, code: "RECORDED", message: "recorded" };
			},
		} as unknown as CohortRigChannel;
		return { lifecycle: createPhaseARigLifecycleOverChannel(channel), sent };
	}

	it("sends the drained receipt and the completion manifest digest on the baseline request, never a null manifest", async () => {
		const { lifecycle, sent } = channelRecordingMeasureStart();
		const baseline = await lifecycle.measureStart({
			rigWarmupDrainedReceiptSha256: HEX5("a"),
			roleWarmupCompletionManifestSha256: HEX5("b"),
		});
		expect(baseline.ok).toBe(false);
		if (baseline.ok) throw new Error("unreachable");
		expect(baseline.code).toBe("RECORDED");
		expect(sent).toEqual([
			{
				warmupCompleteSha256: HEX5("b"),
				rigWarmupDrainedReceiptSha256: HEX5("a"),
			},
		]);
	});

	it("refuses a baseline that has a drained receipt but no manifest digest before any frame", async () => {
		const { lifecycle, sent } = channelRecordingMeasureStart();
		const baseline = await lifecycle.measureStart({
			rigWarmupDrainedReceiptSha256: HEX5("a"),
			roleWarmupCompletionManifestSha256: null,
		});
		expect(baseline.ok).toBe(false);
		if (baseline.ok) throw new Error("unreachable");
		expect(baseline.code).toBe("COHORT_NOT_READY");
		expect(sent).toEqual([]);
	});
});

describe("slice 5: the lease's teardown asks the rig for its server child", () => {
	const reaped = {
		ok: true as const,
		value: {
			terminalPath: "FAIL" as const,
			records: [],
			reapedPgids: [4242],
			allReaped: true as const,
		},
	};
	function lease(options: {
		readonly serverStarted: boolean;
		readonly rigAnswer?: {
			ok: false;
			code: "COHORT_NOT_READY";
			message: string;
		};
	}) {
		const order: string[] = [];
		return {
			order,
			args: {
				path: "FAIL" as const,
				supervisor: {
					teardown: (path: "PASS" | "FAIL") => {
						order.push(`mac:${path}`);
						return reaped;
					},
				},
				rig: {
					serverStarted: options.serverStarted,
					teardownServer: async () => {
						order.push("rig");
						return (
							options.rigAnswer ?? {
								ok: true as const,
								value: { exitCode: 0, signal: null },
							}
						);
					},
				},
				host: {
					closeAll: () => {
						order.push("host");
					},
				},
			},
		};
	}

	it("reaps_the_mac_children_then_the_rigs_server_child_then_closes_the_host", async () => {
		const { order, args } = lease({ serverStarted: true });
		expect(await teardownCohortArmLease(args)).toEqual(reaped);
		expect(order).toEqual(["mac:FAIL", "rig", "host"]);
	});

	it("asks_the_rig_for_nothing_when_no_server_child_was_ever_started", async () => {
		const { order, args } = lease({ serverStarted: false });
		expect(await teardownCohortArmLease(args)).toEqual(reaped);
		expect(order).toEqual(["mac:FAIL", "host"]);
	});

	it("reports_a_rig_teardown_the_rig_did_not_ack_after_a_clean_mac_reap", async () => {
		const refusal = {
			ok: false as const,
			code: "COHORT_NOT_READY" as const,
			message:
				"rig refused rig-teardown-server-request/v1 with COHORT_NOT_READY",
		};
		const { order, args } = lease({ serverStarted: true, rigAnswer: refusal });
		expect(await teardownCohortArmLease(args)).toEqual(refusal);
		expect(order).toEqual(["mac:FAIL", "rig", "host"]);
	});
});

describe("slice 5: the cohort dispatch reaps on every path out", () => {
	function providerRecording(
		paths: string[],
		mode: "refuse" | "seal-fails" | "seal-passes",
	): CohortArmRuntimeProvider {
		return () => ({
			ok: true,
			value: {
				supervisor: null as never,
				rig: null as never,
				retention: null as never,
				bundleFor: () => {
					throw new Error("unreached");
				},
				workloadRolePlanInputBytes: new Uint8Array(),
				tokenCommitmentLeafManifestBytes: () => null,
				clock: { nowMs: () => 0, nowNs: () => "1" },
				seal: async () =>
					mode === "seal-passes"
						? {
								ok: true,
								primaryMetricP50: 1,
								sealedPath: "",
								artifactSha256: "",
							}
						: {
								ok: false,
								failureCode: "COHORT_PROTOCOL",
								reason: "seal refused",
							},
				cleanup: (path) => {
					paths.push(path);
					return {
						ok: true,
						value: {
							terminalPath: path,
							records: [],
							reapedPgids: [],
							allReaped: true,
						},
					};
				},
			},
		});
	}
	const cell = REGISTRY5.cells.find(
		(candidate) => candidate.cellId === "ticker-fanout/rate-10000",
	)!;
	const arm = sealArmsForCell5(cell, ["ws"], ["primary"])[0]!;
	const armInput = {
		cell,
		arm,
		runId: "reap",
		repIndex: 1,
		repetitionKind: "measured",
		repetitionTotal: 1,
		executionPurpose: "pilot",
		perRepPath: "/dev/null",
		sealedPath: "/dev/null",
	} as unknown as Parameters<typeof dispatchArmRepetition5>[0]["arm"];

	it("reaps as FAIL when the executor refuses, as FAIL when the seal refuses, and as PASS when it seals", async () => {
		const measured: CohortArmMeasuredV1 = {
			executionSha256: HEX5("1"),
			cohortGrantSha256: HEX5("2"),
			capture: null as never,
		};
		const refusePaths: string[] = [];
		await dispatchArmRepetition5({
			arm: armInput,
			cohortRuntime: providerRecording(refusePaths, "refuse"),
			executors: {
				driveCohortArm: async () => ({
					ok: false,
					code: "COHORT_PROTOCOL",
					message: "x",
				}),
			},
		});
		expect(refusePaths).toEqual(["FAIL"]);
		const sealFailPaths: string[] = [];
		await dispatchArmRepetition5({
			arm: armInput,
			cohortRuntime: providerRecording(sealFailPaths, "seal-fails"),
			executors: {
				driveCohortArm: async () => ({ ok: true, value: measured }),
			},
		});
		expect(sealFailPaths).toEqual(["FAIL"]);
		const passPaths: string[] = [];
		const passed = await dispatchArmRepetition5({
			arm: armInput,
			cohortRuntime: providerRecording(passPaths, "seal-passes"),
			executors: {
				driveCohortArm: async () => ({ ok: true, value: measured }),
			},
		});
		expect(passPaths).toEqual(["PASS"]);
		expect(passed.result.ok).toBe(true);
		const throwPaths: string[] = [];
		await expect(
			dispatchArmRepetition5({
				arm: armInput,
				cohortRuntime: providerRecording(throwPaths, "refuse"),
				executors: {
					driveCohortArm: async () => {
						throw new Error("boom");
					},
				},
			}),
		).rejects.toThrow("boom");
		expect(throwPaths).toEqual(["FAIL"]);
	});
});

describe("slice 5: the Phase-A attestation is assembled from exact bytes", () => {
	const fixture = mintPhaseAAttestationFixture({
		cellId: "bulk-one-way/physical",
		transport: "ws",
		runId: "camp/bulk-one-way/physical/ws/measured-1",
	});
	const bytesOf = (base64: string) =>
		new Uint8Array(Buffer.from(base64, "base64"));
	const parsed = (base64: string) =>
		JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
	const observation = fixture.observation;
	const assembled = () =>
		assembleServerObservationEvidence({
			opened: {
				measurementGrantBytes: bytesOf(observation.measurementGrantBase64),
				receiptBytes: bytesOf(observation.macExecutionGrantReceiptBase64),
				receiptSignatureBytes: bytesOf(
					observation.macExecutionGrantSignatureBase64,
				),
			} as never,
			draftBytes: bytesOf(observation.executionDraftBase64),
			workloadRolePlanInputBytes: bytesOf(
				observation.workloadRolePlanInput.bytesBase64,
			),
			stagedServerLaunchRecordBytes: bytesOf(
				observation.stagedServerLaunchRecord.bytesBase64,
			),
			admittedClientSeriesBytes: bytesOf(
				observation.admittedClientSeriesBase64,
			),
			rigExecutionAcceptance: {
				acceptance: parsed(observation.rigExecutionAcceptanceBase64),
				acceptanceBytes: bytesOf(observation.rigExecutionAcceptanceBase64),
				signatureBytes: bytesOf(
					observation.rigExecutionAcceptanceSignatureBase64,
				),
				signature: parsed(observation.rigExecutionAcceptanceSignatureBase64),
			},
			rigMeasureStartAck: {
				ackBytes: bytesOf(observation.rigMeasureStartAckBase64),
				signatureBytes: bytesOf(observation.rigMeasureStartAckSignatureBase64),
				signature: parsed(observation.rigMeasureStartAckSignatureBase64),
				issuedAtMs: 0,
				notAfterMs: 0,
			},
			capture: {
				snapshotFrameBytes: bytesOf(observation.snapshotFrameBase64),
				snapshotReceiptBytes: bytesOf(
					observation.rigServerSnapshotReceiptBase64,
				),
				snapshotSignatureBytes: bytesOf(
					observation.rigServerSnapshotReceiptSignatureBase64,
				),
				snapshotSignature: parsed(
					observation.rigServerSnapshotReceiptSignatureBase64,
				),
				linuxRelayObservationBytes: null,
				relayObservationReceipt: null,
				relayObservationReceiptBytes: null,
				relayObservationSignature: null,
				relayObservationSignatureBytes: null,
			},
			admission: {
				macMeasurementAdmission: {
					bytes: bytesOf(observation.macMeasurementAdmissionReceiptBase64),
					signatureBytes: bytesOf(
						observation.macMeasurementAdmissionSignatureBase64,
					),
					signature: parsed(observation.macMeasurementAdmissionSignatureBase64),
				},
			} as never,
		});

	it("reproduces the reference observation byte for byte and verifies against the staged keys", () => {
		const evidence = assembled();
		expect(canonicalJson5(evidence)).toBe(canonicalJson5(observation));
		const verified = verifyServerObservationEvidence(evidence, fixture.trust, {
			executionSha256: fixture.executionSha256,
		});
		expect(verified.ok).toBe(true);
	});

	it("a substituted admitted series no longer verifies: the admission binds the presented bytes", () => {
		const evidence = assembled();
		const seriesBytes = Buffer.from(
			`${Buffer.from(evidence.admittedClientSeriesBase64, "base64").toString("utf8")} `,
		);
		const tampered = {
			...evidence,
			admittedClientSeriesBase64: seriesBytes.toString("base64"),
			admittedClientSeriesSha256: sha256HexOfBytes(new Uint8Array(seriesBytes)),
			admittedClientSeriesSize: seriesBytes.byteLength,
		};
		const verified = verifyServerObservationEvidence(tampered, fixture.trust, {
			executionSha256: fixture.executionSha256,
		});
		expect(verified.ok).toBe(false);
		if (verified.ok) throw new Error("unreachable");
		expect(verified.message).toBe("client series join");
	});
});

describe("plan 2189: a warmup stops before the seal on both seal paths", () => {
	// `sealOrStopRepetition` is the one tail both `measureSealAndWriteRep`
	// (Phase A) and `sealCohortArmRepetition` (Phase B) end in, and the only
	// caller of `sealRunArtifact` in the controller. A warmup returns before
	// the seal and writes nothing; a measured repetition reaches it. The
	// artifact here cannot be sealed at all (a function has no canonical form),
	// so reaching the seal is observable as the seal's own throw.
	const unsealable = {
		schema: "run-artifact/v1",
		poison: () => 1,
	} as unknown as Parameters<typeof sealOrStopRepetition>[0]["artifact"];

	it("a warmup returns the unsealed shape before any seal and leaves the root empty", async () => {
		const root = mkdtempSync(join(tmpdir(), "seal-or-stop-"));
		const warmup = await sealOrStopRepetition({
			repetitionKind: "warmup",
			artifact: unsealable,
			primaryMetricP50: 7,
			trustContext: {} as never,
			sealedPath: join(root, "rep-0.sealed.json"),
			perRepPath: join(root, "rep-0.json"),
			perRepRecord: { warmup: true },
			subject: "sealed artifact",
		});
		expect(warmup).toEqual({
			ok: true,
			primaryMetricP50: 7,
			sealedPath: "",
			artifactSha256: "",
		});
		expect(readdirSync(root)).toEqual([]);
	});

	it("a measured repetition reaches the seal and writes nothing when it cannot be sealed", async () => {
		const root = mkdtempSync(join(tmpdir(), "seal-or-stop-"));
		await expect(
			sealOrStopRepetition({
				repetitionKind: "measured",
				artifact: unsealable,
				primaryMetricP50: 7,
				trustContext: {} as never,
				sealedPath: join(root, "rep-1.sealed.json"),
				perRepPath: join(root, "rep-1.json"),
				perRepRecord: { measured: true },
				subject: "sealed artifact",
			}),
		).rejects.toThrow("unsupported type");
		expect(readdirSync(root)).toEqual([]);
	});
});
