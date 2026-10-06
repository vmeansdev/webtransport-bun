/**
 * Synthetic, internally consistent sharded-arms scan artifacts (the shape the
 * VM rehearsal produced: g6-sharded-scan/3 with an `arms` block), small enough
 * to mutate one raw field per failing-signature test. Two shards, two realm
 * processes, raid slot 0 (server id 1).
 */

import { SNAPSHOT_HZ, snapshotDatagrams } from "./g6-plan.ts";
import type {
	ShardedArmsCell,
	ShardedArmsGradeInput,
} from "./g6-sharded-arms-grade.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

export const FIXTURE = Object.freeze({
	candidate: "c".repeat(40),
	registration: "e".repeat(64),
	shards: 2,
	processes: 2,
	endpoints: 4,
	base: 20000,
	sessionsPerProcess: 4,
	steadyEnterMs: 1_800_000_000_000,
});

type Row = Record<string, unknown>;

export function hist(valueNs: number, count: number) {
	const h = new LatencyHistogram();
	for (let i = 0; i < count; i += 1) h.record(valueNs);
	return h.toJson();
}

/** One client window over `n` sessions (per-session counts registered). */
function clientWindow(
	n: number,
	o: {
		sends: number;
		snapshots: number;
		acks: number;
		rttNs?: number;
		lagNs?: number;
		raid?: number;
	},
) {
	return {
		sent: n * o.sends,
		sendErr: 0,
		scheduleTicksDue: n * o.sends,
		scheduleTicksFired: n * o.sends,
		scheduleTicksSkipped: 0,
		scheduleTicksUnpresented: 0,
		scheduleTicksReconciled: true,
		rxSnapshot: n * o.snapshots,
		rxAck: n * o.acks,
		rxRaid: o.raid ?? 0,
		rxOther: 0,
		rxUnstamped: 0,
		ackUnreflected: 0,
		sessionsLost: 0,
		scheduleLag: hist(o.lagNs ?? 1_000_000, n * o.sends),
		rtt: hist(o.rttNs ?? 5_000_000, n * o.acks),
		oneWay: hist(0, 0),
		serverHold: hist(0, 0),
	};
}

const SNAP_PER_SESSION = (seconds: number) =>
	SNAPSHOT_HZ * snapshotDatagrams() * seconds;

function report(role: string, extra: Row): Row {
	return {
		schema: "mmo-client/2",
		startedAt: "2026-10-06T00:00:00.000Z",
		// mmo-client stamps the closeout id/path (hard-coded) and the gate's
		// sha256 from --preregistration-sha256: the sha binds the gate.
		preRegistration: {
			id: "g6-mmo-closeout/1",
			path: "docs/research/preregistrations/gate-g6-mmo-closeout.md",
			sha256: FIXTURE.registration,
		},
		role,
		sessionsErr: 0,
		sessionsLost: 0,
		connectTimedOut: false,
		...extra,
	};
}

function barrier(parties: number, offset: number) {
	return {
		id: "b",
		role: "x",
		parties,
		steadyEnterUnixMs: FIXTURE.steadyEnterMs + offset,
	};
}

function armsBlock(extra: Row): Row {
	return {
		shardCount: FIXTURE.shards,
		targetSlot: null,
		targetServerId: null,
		dcidLen: 20,
		serverCidLen: 11,
		dcidHashPlaced: true,
		placement: "fnv1a32-first8-mod-shardCount",
		raidMembership: "explicit",
		raidJoinsSent: 0,
		...extra,
	};
}

function le8(n: number): string[] {
	const out: string[] = [];
	let v = n;
	for (let i = 0; i < 8; i += 1) {
		out.push(`0x${(v % 256).toString(16).padStart(2, "0")}`);
		v = Math.floor(v / 256);
	}
	return out;
}

export function steerRaw(steered: number, fallback: number): string {
	const key = (k: number) => [`0x0${k}`, "0x00", "0x00", "0x00"];
	return JSON.stringify([
		{ key: key(0), values: [{ cpu: 0, value: le8(steered) }] },
		{ key: key(1), values: [{ cpu: 0, value: le8(fallback) }] },
	]);
}

function floorTranscript(): string[] {
	const floor = report("realm", {
		sessionsRequested: 20,
		activeWorkloadSessions: 20,
		sessionsOk: 20,
		connectConcurrency: 20,
		connectRatePerSec: 0,
		connectStarts: { offered: 20, achieved: 20, achievedRatePerSec: 1000 },
		config: { steadySec: 10, drainMs: 1000, bindDefault: true },
		client: { endpoints: 1, endpointSourceAddresses: ["[::]:60539"] },
		windows: {
			steady: clientWindow(20, { sends: 40, snapshots: 0, acks: 0 }),
			steadyDrain: clientWindow(20, { sends: 0, snapshots: 150, acks: 5 }),
		},
	});
	return [
		`macgen: head=${FIXTURE.candidate} dirty=no build=ok buildSec=0`,
		`macgen: binary=/g/mmo-client sha256=${"a".repeat(64)}`,
		`mmo-client: json ${JSON.stringify(floor)}`,
		"macgen: exit=0",
		"precheck: rc=0",
	];
}

/** Build a hotspot or storm cell artifact. */
export function armsScanFixture(arm: "hotspot" | "storm"): {
	scan: Row;
	cell: ShardedArmsCell;
} {
	const P = FIXTURE.processes;
	const n = FIXTURE.sessionsPerProcess;
	const sessions = P * n;
	const cohortPerProcess = arm === "storm" ? 1 : 0;
	const cohort = cohortPerProcess * P;
	const steadySeconds = arm === "storm" ? 60 : 120;
	const snaps = SNAP_PER_SESSION(steadySeconds);
	// Each process puts half its sessions on each shard.
	const perShard = n / FIXTURE.shards;
	const realmWindows = (k: number) => ({
		steady: clientWindow(k, { sends: 40, snapshots: 0, acks: 0 }),
		steadyDrain: clientWindow(k, { sends: 0, snapshots: snaps, acks: 5 }),
		...(arm === "storm"
			? {
					stormSurvivors: clientWindow(k, {
						sends: 80,
						snapshots: 0,
						acks: 10,
					}),
				}
			: {}),
	});
	const survivorsByShard = (shard: number) =>
		// cohort sessions are each process's first local, placed on shard 1.
		shard === 1 ? perShard - cohortPerProcess : perShard;
	const processReport = (i: number, total: number) => {
		const windows = realmWindows(total);
		if (arm === "storm")
			windows.stormSurvivors = clientWindow(
				total - cohortPerProcess * (total / n),
				{
					sends: 80,
					snapshots: 0,
					acks: 10,
				},
			);
		const shardsBlock: Row = {};
		for (let s = 1; s <= FIXTURE.shards; s += 1) {
			const k = perShard * (total / n);
			const w: Row = realmWindows(k);
			if (arm === "storm")
				w.stormSurvivors = clientWindow(survivorsByShard(s) * (total / n), {
					sends: 80,
					snapshots: 0,
					acks: 10,
				});
			shardsBlock[String(s)] = w;
		}
		const steadyEntry = Object.fromEntries(
			Array.from({ length: FIXTURE.shards }, (_, s) => [
				String(s + 1),
				perShard * (total / n),
			]),
		);
		return report("realm", {
			sessionsRequested: total,
			activeWorkloadSessions: total,
			sessionsOk: total,
			...(i < 0 ? { clientProcesses: P } : {}),
			phaseBarrier: barrier(P + (arm === "hotspot" ? 2 : 0), i < 0 ? 0 : i * 5),
			windows,
			client: {
				endpoints: FIXTURE.endpoints,
				endpointSourceAddresses: Array.from(
					{ length: FIXTURE.endpoints },
					(_, e) => `0.0.0.0:${FIXTURE.base + e}`,
				),
			},
			storm: {
				concurrency: null,
				cohort: i < 0 ? cohort : cohortPerProcess,
				ran: arm === "storm",
				reconnectMeanMs: 40,
				reconnectMs: { p50: 40, p90: 50, p99: 60, max: 60 },
			},
			arms: armsBlock({
				raidMembership: arm === "hotspot" ? "explicit" : "legacy",
				sessionsByShard: {
					steadyEntry,
					stormEnd: arm === "storm" ? steadyEntry : null,
				},
				shards: shardsBlock,
				...(arm === "storm"
					? {
							storm:
								i < 0
									? {
											timeline: "anchored",
											cohort,
											reconnectDelayMs: 1000,
											severedClosed: cohort,
											reconnectInitials: cohort,
											initialIssueClock: "dcid-provider-call",
											reconnectInitialLate: hist(5_000_000, cohort),
										}
									: {
											timeline: "anchored",
											cohort: cohortPerProcess,
											reconnectDelayMs: 1000,
											severBarrier: { parties: P },
											severUnixMs: FIXTURE.steadyEnterMs + 60_000 + i * 3,
											severedClosed: cohortPerProcess,
											reconnectInitials: cohortPerProcess,
											initialIssueClock: "dcid-provider-call",
											reconnectInitialLate: hist(5_000_000, cohortPerProcess),
										},
						}
					: {}),
			}),
		});
	};
	const perProcess = Array.from({ length: P }, (_, i) => processReport(i, n));
	const merged = processReport(-1, sessions);
	const clientStdout = [
		`mmo-client: json ${JSON.stringify(merged)}`,
		...perProcess.map((r, i) => `mmo-client[${i}]: json ${JSON.stringify(r)}`),
		"g6-sharded-scan: client exited 0",
	].join("\n");
	// Server shards.
	const raidPerSec = 20;
	const raidSent = raidPerSec * 120;
	const realmOnShard = perShard * P;
	const shards = Array.from({ length: FIXTURE.shards }, (_, s) => {
		const id = s + 1;
		const raid = arm === "hotspot" && id === 1 ? raidSent : 0;
		const upstream = realmOnShard * 40;
		const issued = realmOnShard * snaps;
		const w = (wallMs: number, rx: number, extra: Row = {}) => ({
			rxTotal: rx,
			rxSurvivors: 0,
			rxByClass: { snapshot: 0, ack: 0, raid, raidJoin: 0, unstamped: 0 },
			emitter: {
				snapshotDue: issued,
				snapshotIssued: issued,
				ackDue: 0,
				ackIssued: 0,
				raidForwarded: raid * 40,
				sendErrors: 0,
				sendEventsSkipped: 0,
				batchPartialCompletions: 0,
			},
			wallMs,
			metrics: { limitExceededCount: 0, rateLimitedCount: 0 },
			...extra,
		});
		const survivors = survivorsByShard(id) * P;
		return {
			serverId: id,
			sessionsAtSteady: realmOnShard + (arm === "hotspot" && id === 1 ? 41 : 0),
			windows: {
				steady: w(steadySeconds * 1000, upstream + raid),
				steadyDrain: w(steadySeconds * 1000 + 1000, upstream + raid),
				lifetime: w(steadySeconds * 1000 + 40_000, upstream + raid),
				...(arm === "storm"
					? {
							storm: w(120_000, survivors * 80, {
								rxSurvivors: survivors * 70,
							}),
						}
					: {}),
			},
		};
	});
	const severAt = FIXTURE.steadyEnterMs + 60_010;
	const tokens = Array.from({ length: 40 }, (_, i) => i + 1);
	const echoes = shards.map((shard) => {
		const k = shard.serverId === 1 && arm === "hotspot";
		const kinds = {
			player: realmOnShard,
			raid: k ? 40 : 0,
			publisher: k ? 1 : 0,
		};
		return {
			serverId: shard.serverId,
			echoes: {
				drain: {
					severAtMs: null,
					sessionKinds: kinds,
					raidMembers: { count: k ? 40 : 0, tokens: k ? tokens : [] },
				},
				stop: {
					sessionKinds: kinds,
					...(k
						? {
								hotspot: {
									publisherArrivalsSteadyDrain: raidSent,
									publisherStampedSteadyDrain: raidSent,
									publisherGapsSteadyDrainNs: Array(raidSent - 1).fill(50e6),
									ingestToForwardSteadyDrain: hist(200_000, raidSent),
								},
							}
						: {}),
				},
			},
		};
	});
	const raidReport = (role: "publisher" | "raid-subscriber") => {
		const pub = role === "publisher";
		const port = FIXTURE.base + FIXTURE.endpoints + (pub ? 0 : 1);
		return report(role, {
			sessionsRequested: pub ? 1 : 40,
			activeWorkloadSessions: pub ? 1 : 40,
			sessionsOk: pub ? 1 : 40,
			phaseBarrier: barrier(P + 2, pub ? 7 : 9),
			windows: {
				steady: pub
					? clientWindow(1, { sends: raidSent, snapshots: 0, acks: 0 })
					: clientWindow(40, { sends: 0, snapshots: 0, acks: 0 }),
				steadyDrain: pub
					? clientWindow(1, { sends: 0, snapshots: 0, acks: 0 })
					: {
							...clientWindow(40, { sends: 0, snapshots: 0, acks: 0 }),
							rxRaid: raidSent * 40,
							oneWay: hist(4_000_000, raidSent * 40),
						},
			},
			client: { endpoints: 1, endpointSourceAddresses: [`0.0.0.0:${port}`] },
			arms: armsBlock({
				targetSlot: 0,
				targetServerId: 1,
				raidJoinsSent: pub ? 0 : 40,
				sessionsByShard: {
					steadyEntry: { "1": pub ? 1 : 40, "2": 0 },
					stormEnd: null,
				},
				shards: {},
			}),
		});
	};
	const sinkPub = report("publisher", {
		sessionsOk: 1,
		windows: {
			steady: clientWindow(1, { sends: 600, snapshots: 0, acks: 0 }),
		},
	});
	const sinkSub = report("raid-subscriber", {
		sessionsOk: 40,
		windows: {
			steadyDrain: {
				...clientWindow(40, { sends: 0, snapshots: 0, acks: 0 }),
				rxRaid: 24000,
			},
		},
	});
	const stormStart = severAt + 1000;
	const stormEnd = stormStart + 120_000;
	const scan: Row = {
		schema: "g6-sharded-scan/3",
		startedAt: "2026-10-06T00:00:00.000Z",
		candidateSha: FIXTURE.candidate,
		config: { shards: FIXTURE.shards, clientProcesses: P, steadySeconds: 120 },
		clientExit: 0,
		shards,
		clientStdout,
		arms: {
			schema: "g6-sharded-arms-scan/1",
			config: {
				arm,
				shards: FIXTURE.shards,
				raidTargetSlot: 0,
				raidDcidLen: 20,
				stormCohort: cohort,
				steadySeconds,
				stormWindowSeconds: 120,
				postStormSeconds: 60,
				stormReconnectDelayMs: 1000,
				loopbackPort: 4499,
				durationsOverridden: false,
			},
			barrierParties: P + (arm === "hotspot" ? 2 : 0),
			precheck: {
				forwarder: { rc: 143, stdout: [], stderr: [] },
				floor: { rc: 0, transcript: floorTranscript() },
				sink:
					arm === "hotspot"
						? {
								rc: { subscriber: 0, publisher: 0 },
								subscriberReport: sinkSub,
								publisherReport: sinkPub,
							}
						: null,
			},
			raid:
				arm === "hotspot"
					? {
							publisherStdout: [
								`mmo-client: json ${JSON.stringify(raidReport("publisher"))}`,
							],
							subscriberStdout: [
								`mmo-client: json ${JSON.stringify(raidReport("raid-subscriber"))}`,
							],
						}
					: null,
			storm:
				arm === "storm"
					? {
							cohort,
							severAtMs: severAt,
							stormStartAtMs: stormStart,
							stormEndAtMs: stormEnd,
							steering: {
								start: { tsMs: stormStart, steerStatsRaw: steerRaw(1000, 2) },
								end: { tsMs: stormEnd, steerStatsRaw: steerRaw(51000, 3) },
								perSlotDelta: {},
							},
							server: {
								perShard: shards.map((shard) => ({
									serverId: shard.serverId,
									severAtMs: severAt,
									acceptMsAfterSever:
										shard.serverId === 1
											? Array(cohort).fill(stormStart + 30)
											: [],
									stormSamples: [{ handshakesInFlight: 2 }],
								})),
							},
							sessionsByShardAtStormEnd: {
								server: Object.fromEntries(
									shards.map((s) => [String(s.serverId), realmOnShard]),
								),
							},
						}
					: null,
			shardEchoes: echoes,
		},
	};
	return {
		scan,
		cell: {
			id: arm === "hotspot" ? "H40k" : "S1-40k",
			arm,
			sessions,
			cohort,
			role: "gate",
			gatedClauses: arm === "hotspot" ? ["H1", "H2", "H3"] : ["S-C1", "S-C2"],
		},
	};
}

export function gradeInput(
	arm: "hotspot" | "storm",
	mutate?: (scan: Row) => void,
): ShardedArmsGradeInput {
	const { scan, cell } = armsScanFixture(arm);
	mutate?.(scan);
	return {
		cell,
		scan,
		expectCandidate: FIXTURE.candidate,
		registrationSha256: FIXTURE.registration,
		shards: FIXTURE.shards,
		clientProcesses: FIXTURE.processes,
		endpoints: FIXTURE.endpoints,
		fixedSourcePortBase: FIXTURE.base,
		rig: { qualified: true, reasons: [] },
		vR: { ms: 250, source: "rehearsal" },
	};
}

/** Rewrite one realm report line (merged = -1, else process index). */
export function editRealmReport(
	scan: Row,
	which: number,
	edit: (report: Row) => void,
): void {
	const prefix =
		which < 0 ? "mmo-client: json " : `mmo-client[${which}]: json `;
	scan.clientStdout = String(scan.clientStdout)
		.split("\n")
		.map((line) => {
			if (!line.startsWith(prefix)) return line;
			const r = JSON.parse(line.slice(prefix.length)) as Row;
			edit(r);
			return `${prefix}${JSON.stringify(r)}`;
		})
		.join("\n");
}

export function editRaidReport(
	scan: Row,
	role: "publisherStdout" | "subscriberStdout",
	edit: (report: Row) => void,
): void {
	const raid = (scan.arms as Row).raid as Row;
	const [line] = raid[role] as string[];
	const r = JSON.parse(String(line).slice("mmo-client: json ".length)) as Row;
	edit(r);
	raid[role] = [`mmo-client: json ${JSON.stringify(r)}`];
}
