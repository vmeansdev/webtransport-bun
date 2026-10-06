import { describe, expect, test } from "bun:test";
import { evenShare } from "./g6-client-merge.ts";
import {
	ARMS_REGISTERED,
	armsBarrierParties,
	armsDeadlineSec,
	compareShardCounts,
	floorFacts,
	precheckPlan,
	raidPlacementFacts,
	raidProcessArgs,
	raidSourcePortBase,
	realmArmsArgs,
	resolveArmsConfig,
	sinkFacts,
	skewMs,
	steeringDelta,
	sumShardCounts,
} from "./g6-sharded-arms.ts";

const base = { shards: 4, sessions: 2000, activeSessions: 2000 };
const barrier = { id: "g6-scan-x", dir: "/tmp/b", timeoutMs: 300_000 };

function after(argv: readonly string[], flag: string): string | undefined {
	const at = argv.lastIndexOf(flag);
	return at < 0 ? undefined : argv[at + 1];
}

describe("sharded arms configuration", () => {
	test("steady is the default and adds nothing to any argv", () => {
		const cfg = resolveArmsConfig({}, base);
		expect(cfg.arm).toBe("steady");
		expect(
			realmArmsArgs(cfg, { realmProcesses: 4, index: 0, barrier }),
		).toEqual([]);
		expect(precheckPlan(cfg, precheckInput)).toBeNull();
		expect(() => raidProcessArgs(cfg, "publisher", raidInput)).toThrow(
			"hotspot",
		);
		// A steady cell keeps its passive tail; the arms refuse one.
		expect(resolveArmsConfig({}, { ...base, activeSessions: 1000 }).arm).toBe(
			"steady",
		);
		expect(() =>
			resolveArmsConfig(
				{ SCAN_ARM: "hotspot" },
				{ ...base, activeSessions: 1000 },
			),
		).toThrow("requested == active");
	});

	test("registered shapes; overrides are recorded", () => {
		const hotspot = resolveArmsConfig({ SCAN_ARM: "hotspot" }, base);
		expect(hotspot.steadySeconds).toBe(120);
		expect(hotspot.durationsOverridden).toBe(false);
		expect(hotspot.raidTargetSlot).toBe(0);
		expect(hotspot.raidDcidLen).toBe(20);
		expect(hotspot.realmNegctlDcidLen).toBeNull();
		const storm = resolveArmsConfig(
			{ SCAN_ARM: "storm", SCAN_STORM_COHORT: "1000" },
			base,
		);
		expect(storm).toMatchObject({
			steadySeconds: 60,
			stormWindowSeconds: 120,
			postStormSeconds: 60,
			stormReconnectDelayMs: 1000,
			stormCohort: 1000,
			durationsOverridden: false,
		});
		expect(
			resolveArmsConfig(
				{
					SCAN_ARM: "storm",
					SCAN_STORM_COHORT: "10",
					SCAN_STORM_WINDOW_SECONDS: "30",
				},
				base,
			).durationsOverridden,
		).toBe(true);
		expect(() => resolveArmsConfig({ SCAN_ARM: "storm" }, base)).toThrow(
			"SCAN_STORM_COHORT",
		);
		expect(() =>
			resolveArmsConfig({ SCAN_ARM: "storm", SCAN_STORM_COHORT: "2001" }, base),
		).toThrow("1..2000");
		expect(() =>
			resolveArmsConfig(
				{ SCAN_ARM: "hotspot", SCAN_RAID_TARGET_SLOT: "4" },
				base,
			),
		).toThrow("0..3");
		expect(() => resolveArmsConfig({ SCAN_ARM: "raid" }, base)).toThrow(
			"SCAN_ARM",
		);
	});
});

const precheckInput = {
	id: "g6-scan-x",
	barrierDir: "/tmp/b",
	preregistrationSha256: "a".repeat(64),
	startedAt: "2026-10-06T00:00:00.000Z",
	moveIntervalMs: 250,
	actionEvery: 8,
	payloadBytes: 64,
	drainMs: 1000,
};
const raidInput = {
	realmProcesses: 4,
	barrier,
	drainMs: 1000,
	idleSeconds: 30,
	payloadBytes: 64,
	preregistrationSha256: "a".repeat(64),
	startedAt: "2026-10-06T00:00:00.000Z",
	connectTimeoutSeconds: 300,
	fixedSourcePortBase: 20_128,
};

describe("generator argv", () => {
	test("hotspot realm: shard attribution, explicit membership, six-party barrier", () => {
		const cfg = resolveArmsConfig({ SCAN_ARM: "hotspot" }, base);
		const argv = realmArmsArgs(cfg, { realmProcesses: 4, index: 2, barrier });
		expect(after(argv, "--shard-count")).toBe("4");
		expect(after(argv, "--raid-membership")).toBe("explicit");
		expect(after(argv, "--steady-secs")).toBe("120");
		expect(after(argv, "--phase-barrier-parties")).toBe("6");
		expect(after(argv, "--phase-barrier-party")).toBe("client-2");
		expect(armsBarrierParties(cfg, 4)).toBe(6);
		expect(argv).not.toContain("--target-shard");
		expect(argv).not.toContain("--storm-cohort");
		expect(argv).not.toContain("--dcid-len");
	});

	test("negative control: only realm process 0 opens with the 11-octet DCID", () => {
		const cfg = resolveArmsConfig(
			{ SCAN_ARM: "hotspot", SCAN_NEGCTL_REALM_DCID_LEN: "11" },
			base,
		);
		expect(cfg.realmNegctlDcidLen).toBe(11);
		const argvs = [0, 1, 2, 3].map((index) =>
			realmArmsArgs(cfg, { realmProcesses: 4, index, barrier }),
		);
		expect(after(argvs[0] ?? [], "--dcid-len")).toBe("11");
		for (const argv of argvs.slice(1)) expect(argv).not.toContain("--dcid-len");
		expect(() =>
			resolveArmsConfig(
				{ SCAN_ARM: "hotspot", SCAN_NEGCTL_REALM_DCID_LEN: "7" },
				base,
			),
		).toThrow("8..20");
	});

	test("storm realm: exact cohort shares by global index, anchored timeline", () => {
		const cfg = resolveArmsConfig(
			{ SCAN_ARM: "storm", SCAN_STORM_COHORT: "1001" },
			base,
		);
		const shares = [0, 1, 2, 3].map((index) =>
			Number(
				after(
					realmArmsArgs(cfg, { realmProcesses: 4, index, barrier }),
					"--storm-cohort",
				),
			),
		);
		expect(shares).toEqual([251, 250, 250, 250]);
		expect(shares.reduce((a, b) => a + b, 0)).toBe(1001);
		expect(shares).toEqual([0, 1, 2, 3].map((i) => evenShare(1001, 4, i)));
		const argv = realmArmsArgs(cfg, { realmProcesses: 4, index: 0, barrier });
		expect(after(argv, "--storm-timeline")).toBe("anchored");
		expect(after(argv, "--storm-reconnect-delay-ms")).toBe("1000");
		expect(after(argv, "--storm-window-secs")).toBe("120");
		expect(after(argv, "--post-storm-secs")).toBe("60");
		expect(after(argv, "--storm-concurrency")).toBe("0");
		expect(after(argv, "--steady-secs")).toBe("60");
		expect(after(argv, "--phase-barrier-parties")).toBe("4");
		expect(argv).not.toContain("--raid-membership");
	});

	test("raid processes target slot K with the registered DCID and own ports", () => {
		const cfg = resolveArmsConfig(
			{ SCAN_ARM: "hotspot", SCAN_RAID_TARGET_SLOT: "3" },
			base,
		);
		const publisher = raidProcessArgs(cfg, "publisher", raidInput);
		expect(after(publisher, "--role")).toBe("publisher");
		expect(after(publisher, "--sessions")).toBe("1");
		expect(after(publisher, "--send-interval-ms")).toBe("50");
		expect(after(publisher, "--target-shard")).toBe("3");
		expect(after(publisher, "--shard-count")).toBe("4");
		expect(publisher).not.toContain("--dcid-len");
		expect(after(publisher, "--phase-barrier-party")).toBe("publisher");
		expect(after(publisher, "--phase-barrier-parties")).toBe("6");
		const subscriber = raidProcessArgs(cfg, "raid-subscriber", raidInput);
		expect(after(subscriber, "--sessions")).toBe("40");
		expect(after(subscriber, "--raid-membership")).toBe("explicit");
		expect(subscriber).not.toContain("--send-interval-ms");
		const negative = raidProcessArgs(
			resolveArmsConfig(
				{ SCAN_ARM: "hotspot", SCAN_RAID_DCID_LEN: "11" },
				base,
			),
			"raid-subscriber",
			raidInput,
		);
		expect(after(negative, "--dcid-len")).toBe("11");
		expect(raidSourcePortBase(20_000, 128, "publisher")).toBe(20_128);
		expect(raidSourcePortBase(20_000, 128, "raid-subscriber")).toBe(20_129);
		expect(raidSourcePortBase(null, 128, "publisher")).toBeNull();
	});

	test("generator watchdog covers every phase of the cell", () => {
		const io = { connectTimeoutSeconds: 300, drainMs: 1000, idleSeconds: 30 };
		expect(
			armsDeadlineSec(resolveArmsConfig({ SCAN_ARM: "hotspot" }, base), io),
		).toBe(Math.ceil(1.5 * (300 + 120 + 1 + 30)));
		expect(
			armsDeadlineSec(
				resolveArmsConfig({ SCAN_ARM: "storm", SCAN_STORM_COHORT: "5" }, base),
				io,
			),
		).toBe(Math.ceil(1.5 * (300 + 60 + 1 + 1 + 120 + 60 + 30)));
	});

	test("pre-checks: a 20-session 10 s floor every cell, a 1,200/s sink in hotspot cells", () => {
		const storm = precheckPlan(
			resolveArmsConfig({ SCAN_ARM: "storm", SCAN_STORM_COHORT: "5" }, base),
			precheckInput,
		);
		expect(storm?.sink).toBeNull();
		expect(storm?.dir).toBe("/tmp/g6-arms-precheck-g6-scan-x");
		const floor = storm?.floor ?? [];
		expect(after(floor, "--sessions")).toBe(
			String(ARMS_REGISTERED.floorSessions),
		);
		expect(after(floor, "--active-sessions")).toBe("20");
		expect(after(floor, "--steady-secs")).toBe("10");
		expect(after(floor, "--send-interval-ms")).toBe("250");
		expect(after(floor, "--url")).toBe("https://127.0.0.1:4499");
		expect(after(floor, "--role")).toBe("realm");
		const fw = storm?.forwarder ?? [];
		expect(after(fw, "--port")).toBe("4499");
		expect(after(fw, "--ready-path")).toBe(storm?.readyPath);
		const hot = precheckPlan(
			resolveArmsConfig({ SCAN_ARM: "hotspot" }, base),
			precheckInput,
		);
		const pub = hot?.sink?.publisher ?? [];
		const interval = Number(after(pub, "--send-interval-us"));
		expect((40 * 1_000_000) / interval).toBeCloseTo(1200, 1);
		expect(after(pub, "--steady-secs")).toBe("20");
		expect(after(hot?.sink?.subscriber ?? [], "--sessions")).toBe("40");
		expect(after(pub, "--phase-barrier-parties")).toBe("2");
		expect(() =>
			precheckPlan(resolveArmsConfig({ SCAN_ARM: "hotspot" }, base), {
				...precheckInput,
				id: "bad id",
			}),
		).toThrow("precheck id");
	});
});

describe("facts", () => {
	test("sink and floor facts are read from the reports, not trusted", () => {
		const facts = sinkFacts(
			{ sessionsOk: 40, windows: { steadyDrain: { rxRaid: 23_900 } } },
			{ sessionsOk: 1, windows: { steady: { sent: 600 } } },
		);
		expect(facts.expectedDeliveries).toBe(24_000);
		expect(facts.offeredPps).toBe(1200);
		expect(facts.deliveryRatio).toBeCloseTo(23_900 / 24_000, 9);
		expect(sinkFacts(null, null).deliveryRatio).toBeNull();
		expect(
			floorFacts({
				sessionsRequested: 20,
				sessionsOk: 20,
				activeWorkloadSessions: 20,
				config: { steadySec: 10 },
				windows: { steady: { scheduleLag: { count: 800, maxNs: 9 } } },
			}),
		).toMatchObject({ sessionsOk: 20, steadySec: 10, scheduleLagCount: 800 });
	});

	test("per-shard counts: summed across processes and compared shard by shard", () => {
		const client = sumShardCounts([
			{ "1": 10, "2": 5 },
			{ "1": 1, "2": 0 },
		]);
		expect(client).toEqual({ "1": 11, "2": 5 });
		expect(sumShardCounts([{ "1": 1 }, null])).toBeNull();
		expect(compareShardCounts(client, { "1": 11, "2": 5 }, 2).equal).toBe(true);
		const bad = compareShardCounts(client, { "1": 11, "2": 6 }, 2);
		expect(bad.equal).toBe(false);
		expect(bad.mismatches).toEqual([{ serverId: 2, client: 5, server: 6 }]);
		expect(compareShardCounts(null, { "1": 1 }, 1).equal).toBe(false);
	});

	test("raid placement holds only when shard K has exactly the 40 tokens and the publisher", () => {
		const cfg = resolveArmsConfig(
			{ SCAN_ARM: "hotspot", SCAN_RAID_TARGET_SLOT: "1" },
			base,
		);
		const tokens = Array.from({ length: 40 }, (_, i) => i + 1);
		const placed = raidPlacementFacts(cfg, [
			{ serverId: 1, raidTokens: [], publisherSessions: 0 },
			{ serverId: 2, raidTokens: [...tokens].reverse(), publisherSessions: 1 },
			{ serverId: 3, raidTokens: [], publisherSessions: 0 },
		]);
		expect(placed).toMatchObject({
			targetServerId: 2,
			membersOnTarget: 40,
			tokensExact: true,
			placed: true,
		});
		const spread = raidPlacementFacts(cfg, [
			{ serverId: 1, raidTokens: tokens.slice(0, 10), publisherSessions: 0 },
			{ serverId: 2, raidTokens: tokens.slice(10), publisherSessions: 1 },
		]);
		expect(spread.placed).toBe(false);
		expect(spread.shardsHoldingOtherRaidParties).toEqual([
			{ serverId: 1, members: 10, publishers: 0 },
		]);
		expect(
			raidPlacementFacts(cfg, [
				{ serverId: 2, raidTokens: tokens, publisherSessions: 0 },
			]).placed,
		).toBe(false);
	});

	test("skews, steering deltas", () => {
		expect(skewMs([100, 140, 120])).toBe(40);
		expect(skewMs([100, undefined])).toBeNull();
		expect(skewMs([])).toBeNull();
		expect(
			steeringDelta(
				{ steered: 10, fallback: 2 },
				{ steered: 1010, fallback: 7 },
			),
		).toEqual({ steered: 1000, fallback: 5, fallbackFraction: 5 / 1005 });
		expect(steeringDelta(null, { steered: 1, fallback: 1 })).toBeNull();
	});
});
