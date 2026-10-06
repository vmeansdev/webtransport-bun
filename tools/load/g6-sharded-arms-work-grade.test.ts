/**
 * The campaign's arms grading path end to end: a full raw work cell (exact
 * pair, scan receipt, owners, diagnostic, post-run steering) whose scan carries
 * a sharded-arms block, graded by `gradeWorkCell` — the call the paid run
 * makes — rather than by the arms grader alone. Synthetic and scaled to the
 * registered cells' sessions on a 2-shard, 2-process profile.
 */
import { describe, expect, test } from "bun:test";
import { makeShardedArmsWorkPlan } from "./g6-c32-capacity-work.ts";
import {
	workGradeFixture,
	workProfileFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import { gradeWorkCell } from "./g6-c32-work-grade.ts";
import type { WorkProfile } from "./g6-c32-work-profile.ts";
import {
	armsScanFixture,
	editRaidReport,
	editRealmReport,
	hist,
} from "./g6-sharded-arms.fixture.test-helper.ts";
import { SHARDED_ARMS_V_R_MS } from "./g6-sharded-arms-grade.ts";

type Row = Record<string, unknown>;
const o = (v: unknown) => v as Row;

const PROCESSES = 2;
const SHARDS = 2;
const profile: WorkProfile = {
	...workProfileFixture,
	datagramPump: "pump",
	detailedProbe: false,
	clientProcesses: PROCESSES,
	shards: SHARDS,
	endpoints: 4,
	fixedSourcePortBase: 20_000,
};
const REHEARSAL_VR = { ms: 250, source: "rehearsal" as const };

function armsWorkCell(nodeId: "H5k" | "S1-5k", mutate?: (scan: Row) => void) {
	const node = makeShardedArmsWorkPlan().nodes.find((n) => n.id === nodeId);
	if (node === undefined) throw Error(nodeId);
	const input = workGradeFixture({ node, profile });
	const arm = node.kind as "hotspot" | "storm";
	const cohort = nodeId === "S1-5k" ? 1000 : 0;
	// The controller's arm env, exactly as the registered cell sets it.
	const args = (input.operation as unknown as { action: { args: string[] } })
		.action.args;
	args[3] = `${
		arm === "hotspot"
			? "SCAN_ARM=hotspot SCAN_RAID_TARGET_SLOT=0"
			: `SCAN_ARM=storm SCAN_STORM_COHORT=${cohort}`
	} ${args[3]}`;
	const scan = input.scan as unknown as Row;
	const arms = armsScanFixture(arm, {
		shards: SHARDS,
		processes: PROCESSES,
		endpoints: profile.endpoints,
		base: profile.fixedSourcePortBase ?? 0,
		sessionsPerProcess: node.requestedSessions / PROCESSES,
		cohortPerProcess: cohort / PROCESSES,
		candidate: input.expectCandidate,
		registration: input.registrationSha256,
	}).scan;
	// The realm reports: the raw cell's generator facts (datagram driver,
	// connect shape) under the arms reports' windows, shards and storm.
	const workClient = JSON.parse(
		String(scan.clientStdout).slice("mmo-client: json ".length),
	) as Row;
	scan.clientStdout = String(arms.clientStdout)
		.split("\n")
		.map((line) => {
			const m = /^(mmo-client(?:\[\d+\])?: json )(.*)$/.exec(line);
			if (m === null) return line;
			const r = JSON.parse(m[2] ?? "") as Row;
			const merged = {
				...workClient,
				...r,
				startedAt: workClient.startedAt,
				...(line.startsWith("mmo-client: json ")
					? {}
					: { clientProcesses: undefined }),
			};
			return `${m[1]}${JSON.stringify(merged)}`;
		})
		.join("\n");
	// Server shards: the arms windows over the raw cell's lifetime metrics.
	const armsShards = arms.shards as Row[];
	for (const [i, shard] of (scan.shards as Row[]).entries()) {
		const a = armsShards[i] as Row;
		const windows = o(shard.windows);
		for (const [phase, w] of Object.entries(o(a.windows))) {
			const base = o(windows[phase] ?? {});
			windows[phase] = {
				...base,
				...o(w),
				metrics: { ...o(base.metrics ?? {}), ...o(o(w).metrics) },
			};
		}
		shard.sessionsAtSteady = a.sessionsAtSteady;
	}
	// The aggregate is the shards' sum, as the scan writes it.
	const aggregate = o(scan.aggregate);
	for (const phase of ["steady", "steadyDrain", "lifetime"]) {
		const ws = (scan.shards as Row[]).map((s) => o(o(s.windows)[phase]));
		const agg = o(aggregate[phase]);
		agg.rxTotal = ws.reduce((t, w) => t + Number(w.rxTotal), 0);
		const emitter = o(agg.emitter);
		for (const key of Object.keys(o(ws[0]?.emitter)))
			emitter[key] = ws.reduce((t, w) => t + Number(o(w.emitter)[key]), 0);
	}
	if (arm === "storm") {
		// The storm's lifecycle: 60 s steady, then sever / storm / post-storm,
		// all inside the scan operation's interval.
		const startMs = Date.parse(String(scan.startedAt));
		o(aggregate.steady).wallMsMax = 60_000;
		const offsets = [0, 50, 60_050, 61_050, 62_050, 120_000, 120_100, 120_200];
		const phases = [
			"connect",
			"steady",
			"drain",
			"sever",
			"storm",
			"post-storm",
			"idle",
			"stop",
		];
		for (const row of o(input.diagnostic).perShardLifecycle as Row[])
			row.boundaries = phases.map((phase, i) => ({
				phase,
				tsMs: startMs + (offsets[i] ?? 0),
			}));
	}
	scan.arms = arms.arms;
	mutate?.(scan);
	return input;
}

describe("gradeWorkCell: sharded arms from a full raw work cell", () => {
	test("hotspot PASS", () => {
		const grade = gradeWorkCell(armsWorkCell("H5k"));
		expect(grade).toMatchObject({ nodeId: "H5k", outcome: "PASS" });
		expect(grade.reasons).toEqual([]);
	});

	test("hotspot MISS: raid one-way p99 over 25 ms (H1)", () => {
		const grade = gradeWorkCell(
			armsWorkCell("H5k", (scan) =>
				editRaidReport(scan, "subscriberStdout", (r) => {
					const w = o(o(r.windows).steadyDrain);
					w.oneWay = hist(40_000_000, Number(w.rxRaid));
				}),
			),
		);
		expect(grade.outcome).toBe("MISS");
		expect(grade.reasons.join(" ")).toContain("H1");
	});

	test("hotspot INVALID: a raid member off shard K (V-P)", () => {
		const grade = gradeWorkCell(
			armsWorkCell("H5k", (scan) => {
				const echoes = o(scan.arms).shardEchoes as Row[];
				const drain = o(o(o(echoes[0]).echoes).drain);
				drain.raidMembers = {
					count: 39,
					tokens: Array.from({ length: 39 }, (_, i) => i + 1),
				};
			}),
		);
		expect(grade.outcome).toBe("INVALID");
		expect(grade.reasons.join(" ")).toContain("V-P");
	});

	test("an arms cell whose raw pair evidence fails is INVALID before arms grading", () => {
		const input = armsWorkCell("H5k");
		(input.scan as unknown as Row).candidateSha = "f".repeat(40);
		const grade = gradeWorkCell(input);
		expect(grade.outcome).toBe("INVALID");
		expect(grade.reasons.join(" ")).not.toContain("sharded arms");
	});

	test("storm refuses while R is not frozen; grades with a rehearsal R", () => {
		const input = armsWorkCell("S1-5k");
		if (SHARDED_ARMS_V_R_MS === null) {
			const refused = gradeWorkCell(input);
			expect(refused.outcome).toBe("INVALID");
			expect(refused.reasons.join(" ")).toContain("R is not frozen");
		}
		const grade = gradeWorkCell(input, { rehearsalVR: REHEARSAL_VR });
		expect(grade).toMatchObject({ nodeId: "S1-5k", outcome: "PASS" });
	});

	test("storm MISS: a re-accept after the window closes (S-C2, from raw instants)", () => {
		const grade = gradeWorkCell(
			armsWorkCell("S1-5k", (scan) => {
				const st = o(o(scan.arms).storm);
				const shard = (o(st.server).perShard as Row[])[0] as Row;
				const accepts = shard.acceptMsAfterSever as number[];
				accepts[accepts.length - 1] = Number(st.stormEndAtMs) + 5;
			}),
			{ rehearsalVR: REHEARSAL_VR },
		);
		expect(grade.outcome).toBe("MISS");
		expect(grade.reasons.join(" ")).toContain("S-C2");
	});

	test("storm INVALID: a reconnect Initial later than R (V-R)", () => {
		const grade = gradeWorkCell(
			armsWorkCell("S1-5k", (scan) => {
				for (const which of [-1, 0, 1])
					editRealmReport(scan, which, (r) => {
						const storm = o(o(r.arms).storm);
						storm.reconnectInitialLate = hist(
							400_000_000,
							Number(storm.cohort),
						);
					});
			}),
			{ rehearsalVR: REHEARSAL_VR },
		);
		expect(grade.outcome).toBe("INVALID");
		expect(grade.reasons.join(" ")).toContain("V-R");
	});
});
