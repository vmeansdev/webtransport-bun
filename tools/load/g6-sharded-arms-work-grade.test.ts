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
	nativeShardFixture,
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
import {
	SHARDED_ARMS_CELLS,
	SHARDED_ARMS_REGISTERED,
	SHARDED_ARMS_V_R_MS,
	shardedArmsCell,
} from "./g6-sharded-arms-grade.ts";

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
const R = SHARDED_ARMS_REGISTERED;
/** §3.3: the 1 s drain between steady and sever. */
const DRAIN_MS = 1000;

/**
 * The registered phase spans of a kind (pre-registration §3.3): hotspot 120 s
 * steady and the 50 ms fixture drain; storm 60 s steady, then the 1 s drain,
 * sever, 1,000 ms, the 120 s storm window and the 60 s post-storm, all inside
 * the server's drain phase (182,000 ms drain->idle; sealed S1-5k: 181,997).
 */
function kindSpans(arm: "hotspot" | "storm") {
	return arm === "storm"
		? {
				steadyMs: R.stormSteadySeconds * 1000,
				drainToIdleMs:
					DRAIN_MS +
					R.stormReconnectDelayMs +
					(R.stormWindowSeconds + R.postStormSeconds) * 1000,
			}
		: { steadyMs: R.hotspotSteadySeconds * 1000, drainToIdleMs: 50 };
}

type NativeShape = { steadyMs?: number; drainToIdleMs?: number };

function armsWorkCell(
	nodeId: string,
	mutate?: (scan: Row) => void,
	native: NativeShape = {},
) {
	const node = makeShardedArmsWorkPlan().nodes.find((n) => n.id === nodeId);
	if (node === undefined) throw Error(nodeId);
	const input = workGradeFixture({ node, profile });
	const arm = node.kind as "hotspot" | "storm";
	const cohort = arm === "storm" ? shardedArmsCell(nodeId).cohort : 0;
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
	const spans = kindSpans(arm);
	const diagnostic = o(input.diagnostic);
	if (arm === "storm") {
		// The storm's lifecycle at the registered timings: 60 s steady, 1 s
		// drain, sever, 1,000 ms, 120 s storm window, 60 s post-storm, then
		// idle; all inside the scan operation's interval.
		const startMs = Date.parse(String(scan.startedAt));
		o(aggregate.steady).wallMsMax = spans.steadyMs;
		const steadyAt = 50,
			drainAt = steadyAt + spans.steadyMs,
			severAt = drainAt + DRAIN_MS,
			stormAt = severAt + R.stormReconnectDelayMs,
			postAt = stormAt + R.stormWindowSeconds * 1000,
			idleAt = postAt + R.postStormSeconds * 1000;
		const offsets = [0, steadyAt, drainAt, severAt, stormAt, postAt, idleAt];
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
		for (const row of diagnostic.perShardLifecycle as Row[]) {
			row.boundaries = phases.map((phase, i) => ({
				phase,
				tsMs: startMs + (offsets[i] ?? idleAt + 100),
			}));
			row.exits = [{ code: 0, signal: null, tsMs: startMs + idleAt + 200 }];
		}
		o(diagnostic.postRunSteering).capturedAtMs = startMs + idleAt + 500;
		const operation = input.operation as unknown as Row;
		const finishedAt = new Date(startMs + idleAt + 1000).toISOString();
		operation.finishedAt = finishedAt;
		operation.durationMonotonicNs = String(
			BigInt(Date.parse(finishedAt) - Date.parse(String(operation.startedAt))) *
				1_000_000n,
		);
	}
	// Native send-path boundaries from the same per-kind spans as the
	// lifecycle (the field the coverage check reads), unless a control
	// overrides them.
	const steadyNs = BigInt(native.steadyMs ?? spans.steadyMs) * 1_000_000n,
		drainToIdleNs =
			BigInt(native.drainToIdleMs ?? spans.drainToIdleMs) * 1_000_000n;
	const times = [
		1n,
		100_000_000n,
		150_000_000n,
		150_000_000n + steadyNs,
		150_000_000n + steadyNs + drainToIdleNs,
	];
	const sendPath = o(diagnostic.sendPathDiagnostics);
	sendPath.shards = (sendPath.shards as Row[]).map((shard) =>
		nativeShardFixture(
			Number(shard.serverId),
			Number(shard.pid),
			profile.udpSendBatch,
			times,
		),
	);
	scan.arms = arms.arms;
	mutate?.(scan);
	return input;
}

/** Native (ms) and lifecycle (ms) spans of shard 0: steady->drain, drain->idle. */
function spansOf(input: ReturnType<typeof armsWorkCell>) {
	const d = o(input.diagnostic);
	const shard = (o(d.sendPathDiagnostics).shards as Row[])[0] as Row;
	const b = o(shard.boundaries);
	const mono = (k: string) => Number(BigInt(String(o(b[k]).monoNs)) / 1000n);
	const life = ((d.perShardLifecycle as Row[])[0] as Row).boundaries as {
		phase: string;
		tsMs: number;
	}[];
	const at = (k: string) =>
		(life.find((x) => x.phase === k) as { tsMs: number }).tsMs;
	return {
		native: [
			(mono("drain") - mono("steady")) / 1000,
			(mono("idle") - mono("drain")) / 1000,
		],
		lifecycle: [at("drain") - at("steady"), at("idle") - at("drain")],
	};
}

const COVERAGE_RED =
	"g6-capacity-diagnostic-coverage: native steady phase does not span the rated window";

describe("arms work-cell fixture: native boundaries consistent with the lifecycle", () => {
	test.each(SHARDED_ARMS_CELLS.map((c) => c.id))("%s", (id) => {
		const spans = spansOf(armsWorkCell(id));
		expect(spans.native).toEqual(spans.lifecycle);
		expect(spans.native).toEqual(
			shardedArmsCell(id).arm === "storm" ? [60_000, 182_000] : [120_000, 50],
		);
	});
});

describe("gradeWorkCell: storm coverage windows (run 01's S1-5k INVALID)", () => {
	test("storm raw cell: full gradeWorkCell path with storm-shaped native phases", () => {
		// Red at 440632c7: the coverage check hard-coded a 120 s native steady,
		// so this cell graded INVALID with exactly COVERAGE_RED, the sealed
		// reason of run 01's S1-5k (g6-sharded-arms-20261007-01).
		const grade = gradeWorkCell(armsWorkCell("S1-5k"));
		expect(grade.reasons).not.toContain(COVERAGE_RED);
		expect(grade).toEqual({
			schema: "g6-c32-work-grade/1",
			nodeId: "S1-5k",
			outcome: "PASS",
			reasons: [],
		});
	});

	test.each(
		SHARDED_ARMS_CELLS.map((c) => c.id),
	)("%s grades through gradeWorkCell with kind-consistent native phases", (id) => {
		const grade = gradeWorkCell(armsWorkCell(id));
		// S2 cells sever the whole realm: S-C1 (not gated there) has no
		// survivors to grade.
		expect(grade.reasons).toEqual(
			id.startsWith("S2-")
				? ["S-C1 does not apply: the whole realm was severed"]
				: [],
		);
		expect(grade.outcome).toBe("PASS");
	});

	test("negative control: a storm cell with a 120 s native steady is INVALID", () => {
		const grade = gradeWorkCell(
			armsWorkCell("S1-5k", undefined, { steadyMs: 120_000 }),
		);
		expect(grade).toMatchObject({
			outcome: "INVALID",
			reasons: [COVERAGE_RED],
		});
	});

	test("negative control: a storm whose drain->idle is 100 s does not cover the storm", () => {
		for (const drainToIdleMs of [100_000, 181_700, 182_300]) {
			const grade = gradeWorkCell(
				armsWorkCell("S1-40k", undefined, { drainToIdleMs }),
			);
			expect(grade).toMatchObject({
				outcome: "INVALID",
				reasons: [
					"g6-capacity-diagnostic-coverage: native drain phase does not span the registered storm",
				],
			});
		}
		// Inside the registered tolerance (sealed S1-5k: 181,997 ms).
		expect(
			gradeWorkCell(
				armsWorkCell("S1-40k", undefined, { drainToIdleMs: 181_997 }),
			).outcome,
		).toBe("PASS");
	});

	test("negative control: a hotspot cell with a 60 s native steady is INVALID", () => {
		const grade = gradeWorkCell(
			armsWorkCell("H40k", undefined, { steadyMs: 60_000 }),
		);
		expect(grade).toMatchObject({
			outcome: "INVALID",
			reasons: [COVERAGE_RED],
		});
	});

	test("hotspot timing is unchanged: no drain-span requirement", () => {
		// A hotspot drain->idle far from the storm span still grades PASS.
		expect(
			gradeWorkCell(armsWorkCell("H5k", undefined, { drainToIdleMs: 995 }))
				.outcome,
		).toBe("PASS");
	});
});

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

	test("storm grades with the frozen R; a rehearsal R never replaces it", () => {
		expect(SHARDED_ARMS_V_R_MS).toBe(500);
		const input = armsWorkCell("S1-5k");
		expect(gradeWorkCell(input)).toMatchObject({
			nodeId: "S1-5k",
			outcome: "PASS",
		});
		// 400 ms is within the frozen 500 ms; a 250 ms rehearsal R is ignored.
		const late = armsWorkCell("S1-5k", (scan) => {
			for (const which of [-1, 0, 1])
				editRealmReport(scan, which, (r) => {
					const storm = o(o(r.arms).storm);
					storm.reconnectInitialLate = hist(400_000_000, Number(storm.cohort));
				});
		});
		expect(gradeWorkCell(late, { rehearsalVR: REHEARSAL_VR }).outcome).toBe(
			"PASS",
		);
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
							600_000_000,
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
