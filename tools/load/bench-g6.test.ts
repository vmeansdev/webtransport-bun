import { describe, expect, test } from "bun:test";
import {
	buildBenchArtifact,
	clientWindow,
	clientProcessFailureReasons,
	chooseClientProvenance,
	compareWindowDelivery,
	type BoundaryMarks,
	type BoundarySnapshot,
	type ClientReportV2,
	type ClientMeasurementWindow,
	deltaBoundarySnapshot,
	deriveBoundaryWindows,
	nextEmitterWindowState,
	readPhaseMarker,
	requireClientReportIdentity,
	indexClientBundlesByLaunchRole,
	summarizePhaseBarrier,
	validateSourceBinding,
	windowReceiveTotal,
} from "./g6-artifact.ts";
import { G6_CLOSEOUT_SPEC_ID, G6_CLOSEOUT_SPEC_PATH } from "./g6-plan.ts";

function boundary(over: Partial<BoundarySnapshot> = {}): BoundarySnapshot {
	return {
		rxTotal: 10,
		rxByClass: {
			snapshot: 6,
			ack: 2,
			raid: 1,
			raidJoin: 1,
			unstamped: 1,
		},
		emitter: {
			snapshotDue: 20,
			snapshotIssued: 18,
			ackDue: 4,
			ackIssued: 4,
			raidForwarded: 3,
			sendErrors: 1,
			sendEventsSkipped: 2,
			batchPartialCompletions: 1,
		},
		cpuMs: 1000,
		wallMs: 2000,
		kernel: { InDatagrams: 50, RcvbufErrors: 2, serverSocketDrops: 3 },
		metrics: {
			datagramsIn: 40,
			datagramsDropped: 4,
			datagramsSkippedQueueFull: 5,
			limitExceededCount: 6,
			rateLimitedCount: 7,
			sessionsClosedByIdle: 8,
			sessionsClosedOther: 9,
			handshakesInFlight: 10,
			sessionsActive: 11,
		},
		...over,
	};
}

function measurementWindow(
	over: Partial<ClientMeasurementWindow> = {},
): ClientMeasurementWindow {
	return {
		sent: 100,
		sendErr: 1,
		scheduleTicksDue: 101,
		scheduleTicksFired: 100,
		scheduleTicksSkipped: 1,
		scheduleTicksReconciled: true,
		rxSnapshot: 80,
		rxAck: 9,
		rxRaid: 4,
		rxOther: 0,
		rxUnstamped: 0,
		ackUnreflected: 0,
		scheduleLag: { count: 100, negative: 0, p99Ns: 5_000_000 },
		rtt: { count: 8, negative: 0, p99Ns: 40_000_000 },
		oneWay: { count: 4, negative: 0, p99Ns: 12_000_000 },
		serverHold: { count: 8, negative: 0, p99Ns: 1_500_000 },
		...over,
	};
}

function marks(): BoundaryMarks {
	return {
		start: boundary({ rxTotal: 0, wallMs: 0, cpuMs: 0 }),
		steadyStart: boundary({ rxTotal: 10, wallMs: 100, cpuMs: 10 }),
		drainStart: boundary({
			rxTotal: 30,
			wallMs: 200,
			cpuMs: 30,
			emitter: {
				snapshotDue: 40,
				snapshotIssued: 38,
				ackDue: 8,
				ackIssued: 8,
				raidForwarded: 3,
				sendErrors: 1,
				sendEventsSkipped: 2,
				batchPartialCompletions: 1,
			},
		}),
		drainEnd: boundary({
			rxTotal: 45,
			wallMs: 300,
			cpuMs: 45,
			emitter: {
				snapshotDue: 40,
				snapshotIssued: 38,
				ackDue: 10,
				ackIssued: 10,
				raidForwarded: 3,
				sendErrors: 1,
				sendEventsSkipped: 2,
				batchPartialCompletions: 1,
			},
		}),
		idleStart: boundary({
			rxTotal: 90,
			wallMs: 500,
			cpuMs: 90,
			emitter: {
				snapshotDue: 100,
				snapshotIssued: 96,
				ackDue: 20,
				ackIssued: 20,
				raidForwarded: 8,
				sendErrors: 4,
				sendEventsSkipped: 6,
				batchPartialCompletions: 2,
			},
		}),
		stormStart: boundary({ rxTotal: 50, wallMs: 350, cpuMs: 50 }),
		stormEnd: boundary({ rxTotal: 70, wallMs: 450, cpuMs: 70 }),
	};
}

function report(over: Record<string, unknown> = {}): ClientReportV2 {
	return {
		schema: "mmo-client/2",
		role: "realm",
		startedAt: "2026-08-24T08:00:00.000Z",
		preRegistration: {
			id: G6_CLOSEOUT_SPEC_ID,
			path: G6_CLOSEOUT_SPEC_PATH,
			sha256:
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		},
		windows: {
			steady: measurementWindow(),
			steadyDrain: measurementWindow(),
			stormSurvivors: measurementWindow({ sent: 0, rxRaid: 8 }),
		},
		lifetime: measurementWindow(),
		...over,
	};
}

describe("phase markers", () => {
	test("drain and idle markers stay explicit and untimed", () => {
		expect(readPhaseMarker("mmo-client: phase drain")).toEqual({
			kind: "drain",
		});
		expect(readPhaseMarker("mmo-client: phase idle")).toEqual({
			kind: "idle",
		});
		expect(readPhaseMarker("mmo-client: phase steady")).toEqual({
			kind: "steady",
		});
		expect(readPhaseMarker("mmo-client: phase storm cohort=5000")).toEqual({
			kind: "storm",
			cohort: 5000,
		});
		expect(readPhaseMarker("mmo-client: phase post-storm")).toEqual({
			kind: "post-storm",
		});
		expect(readPhaseMarker("mmo-client: phase stop")).toEqual({
			kind: "stop",
		});
		expect(readPhaseMarker("noise")).toBeNull();
	});
});

describe("emitter window control", () => {
	test("connect and drain emit nothing and storm re-anchors after drain", () => {
		expect(nextEmitterWindowState(null, "connect", 1_000, 20).emit).toBeNull();

		const steady = nextEmitterWindowState(null, "steady", 2_000, 20);
		expect(steady.emit).toEqual({
			kind: "steady",
			deadlineNs: 2_000,
			sliceIndex: 0,
		});

		const drain = nextEmitterWindowState(steady.window, "drain", 9_000, 20);
		expect(drain.emit).toBeNull();
		expect(drain.window).toBeNull();

		const storm = nextEmitterWindowState(drain.window, "storm", 50_000, 20);
		expect(storm.emit).toEqual({
			kind: "storm",
			deadlineNs: 50_000,
			sliceIndex: 0,
		});
	});

	test("post-storm starts a fresh send window instead of carrying storm lag", () => {
		const storm0 = nextEmitterWindowState(null, "storm", 10_000, 20);
		const storm1 = nextEmitterWindowState(storm0.window, "storm", 10_020, 20);
		expect(storm1.emit?.deadlineNs).toBe(10_020);

		const post = nextEmitterWindowState(
			storm1.window,
			"post-storm",
			90_000,
			20,
		);
		expect(post.emit).toEqual({
			kind: "post-storm",
			deadlineNs: 90_000,
			sliceIndex: 0,
		});
	});
});

describe("boundary windows", () => {
	test("per-class ingress and emitter counters are copied and differenced exactly", () => {
		const delta = deltaBoundarySnapshot(
			boundary(),
			boundary({
				rxTotal: 25,
				rxByClass: {
					snapshot: 15,
					ack: 5,
					raid: 3,
					raidJoin: 2,
					unstamped: 4,
				},
				emitter: {
					snapshotDue: 45,
					snapshotIssued: 41,
					ackDue: 10,
					ackIssued: 9,
					raidForwarded: 7,
					sendErrors: 3,
					sendEventsSkipped: 6,
					batchPartialCompletions: 2,
				},
				cpuMs: 1450,
				wallMs: 2800,
				kernel: { InDatagrams: 75, RcvbufErrors: 5, serverSocketDrops: 8 },
				metrics: {
					datagramsIn: 70,
					datagramsDropped: 7,
					datagramsSkippedQueueFull: 9,
					limitExceededCount: 11,
					rateLimitedCount: 12,
					sessionsClosedByIdle: 13,
					sessionsClosedOther: 14,
					handshakesInFlight: 15,
					sessionsActive: 16,
				},
			}),
		);

		expect(delta.rxTotal).toBe(15);
		expect(delta.rxByClass).toEqual({
			snapshot: 9,
			ack: 3,
			raid: 2,
			raidJoin: 1,
			unstamped: 3,
		});
		expect(delta.emitter.snapshotDue).toBe(25);
		expect(delta.kernel?.serverSocketDrops).toBe(5);
		expect(delta.metrics.datagramsSkippedQueueFull).toBe(4);
	});

	test("steadyDrain closes at drainEnd and excludes storm or idle contamination", () => {
		const windows = deriveBoundaryWindows(marks());
		expect(windows.steady.rxTotal).toBe(20);
		expect(windows.steadyDrain.rxTotal).toBe(35);
		expect(windows.lifetime.rxTotal).toBe(90);
		expect(windows.steadyDrain.emitter.snapshotDue).toBe(20);
		expect(windows.steadyDrain.emitter.ackIssued).toBe(6);
		expect(windows.storm?.rxTotal).toBe(20);
	});
});

describe("source binding", () => {
	test("accepts exact lowercase clean candidate source", () => {
		expect(
			validateSourceBinding({
				checkedOutSha: "0123456789abcdef0123456789abcdef01234567",
				expectedCandidateSha: "0123456789abcdef0123456789abcdef01234567",
				statusPorcelain: "",
			}),
		).toEqual({
			candidateSha: "0123456789abcdef0123456789abcdef01234567",
			dirty: false,
		});
	});

	test("rejects uppercase expected SHA and dirty worktrees", () => {
		expect(() =>
			validateSourceBinding({
				checkedOutSha: "0123456789abcdef0123456789abcdef01234567",
				expectedCandidateSha: "0123456789ABCDEF0123456789abcdef01234567",
				statusPorcelain: "",
			}),
		).toThrow("exact lowercase 40-hex");
		expect(() =>
			validateSourceBinding({
				checkedOutSha: "0123456789abcdef0123456789abcdef01234567",
				expectedCandidateSha: "0123456789abcdef0123456789abcdef01234567",
				statusPorcelain: " M tools/load/bench-g6.ts\n",
			}),
		).toThrow("is dirty");
	});
});

describe("client report identity", () => {
	test("accepts matching v2 reports and exposes storm survivors", () => {
		const validated = requireClientReportIdentity(report(), {
			role: "realm",
			startedAt: "2026-08-24T08:00:00.000Z",
			preregistrationSha256:
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		});
		expect(clientWindow(validated, "stormSurvivors")?.rxRaid).toBe(8);
	});

	test("rejects historical v1 successor reports and prereg mismatches", () => {
		expect(() =>
			requireClientReportIdentity(
				{
					schema: "mmo-client/1",
					role: "realm",
				},
				{
					role: "realm",
					startedAt: "2026-08-24T08:00:00.000Z",
					preregistrationSha256:
						"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				},
			),
		).toThrow("historical mmo-client/1");
		expect(() =>
			requireClientReportIdentity(
				report({
					preRegistration: {
						id: G6_CLOSEOUT_SPEC_ID,
						path: G6_CLOSEOUT_SPEC_PATH,
						sha256: "b".repeat(64),
					},
				}),
				{
					role: "realm",
					startedAt: "2026-08-24T08:00:00.000Z",
					preregistrationSha256:
						"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
				},
			),
		).toThrow("preregistration sha256 mismatch");
	});
});

describe("hotspot phase barrier", () => {
	test("summarizes matching hotspot role evidence from monotonic timestamps", () => {
		const base = {
			id: "g6-hotspot-arm",
			parties: 3,
			releaseUnixMs: 1_000,
			releaseMonotonicNs: 9_000_000,
		};
		const summary = summarizePhaseBarrier(
			[
				report({
					role: "realm",
					phaseBarrier: {
						...base,
						role: "realm",
						readyUnixMs: 900,
						readyMonotonicNs: 5_000_000,
						steadyEnterUnixMs: 1_005,
						steadyEnterMonotonicNs: 9_005_000,
					},
				}),
				report({
					role: "raid-subscriber",
					phaseBarrier: {
						...base,
						role: "raid-subscriber",
						readyUnixMs: 902,
						readyMonotonicNs: 6_000_000,
						steadyEnterUnixMs: 1_006,
						steadyEnterMonotonicNs: 9_006_000,
					},
				}),
				report({
					role: "publisher",
					phaseBarrier: {
						...base,
						role: "publisher",
						readyUnixMs: 904,
						readyMonotonicNs: 7_500_000,
						steadyEnterUnixMs: 1_007,
						steadyEnterMonotonicNs: 9_007_000,
					},
				}),
			],
			3,
		);
		expect(summary).toEqual({
			id: "g6-hotspot-arm",
			parties: 3,
			roles: ["publisher", "raid-subscriber", "realm"],
			readySkewMs: 2.5,
			releaseSkewMs: 0,
			steadyEnterSkewMs: 0.002,
		});
	});

	test("rejects hotspot evidence when a required role is missing", () => {
		expect(() =>
			summarizePhaseBarrier(
				[
					report({
						role: "realm",
						phaseBarrier: {
							id: "g6-hotspot-arm",
							parties: 3,
							role: "realm",
							readyUnixMs: 900,
							readyMonotonicNs: 5_000_000,
							releaseUnixMs: 1_000,
							releaseMonotonicNs: 9_000_000,
							steadyEnterUnixMs: 1_005,
							steadyEnterMonotonicNs: 9_005_000,
						},
					}),
					report({
						role: "publisher",
						phaseBarrier: {
							id: "g6-hotspot-arm",
							parties: 3,
							role: "publisher",
							readyUnixMs: 904,
							readyMonotonicNs: 7_500_000,
							releaseUnixMs: 1_000,
							releaseMonotonicNs: 9_000_000,
							steadyEnterUnixMs: 1_007,
							steadyEnterMonotonicNs: 9_007_000,
						},
					}),
					report({
						role: "publisher",
						phaseBarrier: {
							id: "g6-hotspot-arm",
							parties: 3,
							role: "publisher",
							readyUnixMs: 905,
							readyMonotonicNs: 7_600_000,
							releaseUnixMs: 1_000,
							releaseMonotonicNs: 9_000_000,
							steadyEnterUnixMs: 1_008,
							steadyEnterMonotonicNs: 9_008_000,
						},
					}),
				],
				3,
			),
		).toThrow("hotspot barrier roles mismatch");
	});
});

describe("window counter handling", () => {
	test("counts exact, under, over, unreflected, and unparseable receive windows", () => {
		expect(
			compareWindowDelivery(
				93,
				measurementWindow({ rxSnapshot: 80, rxAck: 9, rxRaid: 4 }),
			).status,
		).toBe("exact");
		expect(
			compareWindowDelivery(
				100,
				measurementWindow({ rxSnapshot: 80, rxAck: 9, rxRaid: 4 }),
			).status,
		).toBe("under");
		expect(
			compareWindowDelivery(
				90,
				measurementWindow({ rxSnapshot: 80, rxAck: 9, rxRaid: 4 }),
			).status,
		).toBe("over");
		expect(
			compareWindowDelivery(93, measurementWindow({ ackUnreflected: 1 }))
				.status,
		).toBe("unreflected");
		expect(
			compareWindowDelivery(93, measurementWindow({ rxUnstamped: 1 })).status,
		).toBe("unparseable");
	});

	test("receive totals include unstamped datagrams instead of subtracting them", () => {
		expect(
			windowReceiveTotal(
				measurementWindow({
					rxSnapshot: 50,
					rxAck: 5,
					rxRaid: 2,
					rxOther: 1,
					rxUnstamped: 3,
				}),
			),
		).toBe(61);
	});
});

describe("bench artifact", () => {
	test("emits bench-g6/2 windows with closeout prereg identity, explicit source cleanliness, and raw reports", () => {
		const artifact = buildBenchArtifact({
			startedAt: "2026-08-24T08:00:00.000Z",
			writtenAt: "2026-08-24T08:10:00.000Z",
			preregistrationSha256:
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			host: {
				identity: "runner-linux",
				platform: "linux",
				cpus: 16,
				bunVersion: "1.3.14",
				offboxSsh: "generator-mac",
			},
			source: {
				candidateSha: "0123456789abcdef0123456789abcdef01234567",
				dirty: false as const,
				coResident: false,
			},
			config: {
				ladder: [5000],
				arms: ["steady"],
				movePps: 4,
				actionPps: 0.5,
				actionEvery: 8,
				upstreamPayloadBytes: 64,
				snapshotHz: 5,
				snapshotDatagrams: 3,
				snapshotPayloadBytes: 1150,
				emitterSliceHz: 50,
				raidMembers: 40,
				raidPublisherHz: 20,
				steadySeconds: 120,
				drainGraceMs: 1000,
				idleSeconds: 30,
				stormWindowSec: 120,
				stormCohorts: [1000, 5000],
				stormReconnectDelayMs: 1000,
				datagramSendSync: null,
			},
			preflightRequirements: [],
			arms: [
				{
					arm: "steady-5000",
					sessions: 5000,
					windows: {
						steady: {
							serverUpstream: { rxTotal: 1, rxByClass: boundary().rxByClass },
							emitter: boundary().emitter,
							client: measurementWindow(),
						},
						steadyDrain: {
							serverUpstream: { rxTotal: 2, rxByClass: boundary().rxByClass },
							emitter: boundary().emitter,
							client: measurementWindow(),
						},
						storm: null,
						lifetime: {
							serverUpstream: { rxTotal: 3, rxByClass: boundary().rxByClass },
							emitter: boundary().emitter,
							client: measurementWindow(),
						},
					},
					rawReports: {
						realm: { role: "realm" },
						subscriber: null,
						publisher: null,
					},
				},
			],
			aborted: null,
		});

		expect(artifact.schema).toBe("bench-g6/2");
		expect(artifact.preRegistration).toEqual({
			id: G6_CLOSEOUT_SPEC_ID,
			path: G6_CLOSEOUT_SPEC_PATH,
			sha256:
				"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		});
		expect(artifact.source).toEqual({
			candidateSha: "0123456789abcdef0123456789abcdef01234567",
			dirty: false,
			coResident: false,
		});
		expect("preregistrationSha256" in artifact).toBe(false);
		expect(artifact.arms[0]?.windows.steadyDrain.client.rxAck).toBe(9);
		expect(artifact.arms[0]?.rawReports.realm).toEqual({ role: "realm" });
	});
});

describe("client provenance selection", () => {
	test("preserves launch-owned side-role failures before either client emits JSON", () => {
		const byRole = indexClientBundlesByLaunchRole(
			["raid-subscriber", "publisher"] as const,
			[
				{
					report: null,
					provenanceLines: [],
					stderrLines: ["subscriber checkout failed"],
					exitCode: 128,
				},
				{
					report: null,
					provenanceLines: [],
					stderrLines: ["publisher build failed"],
					exitCode: 17,
				},
			],
		);

		const subscriber = byRole.get("raid-subscriber");
		const publisher = byRole.get("publisher");
		expect(subscriber?.exitCode).toBe(128);
		expect(subscriber?.stderrLines).toEqual(["subscriber checkout failed"]);
		expect(publisher?.exitCode).toBe(17);
		expect(publisher?.stderrLines).toEqual(["publisher build failed"]);
		expect(
			clientProcessFailureReasons("raid-subscriber", subscriber, true),
		).toEqual([
			"raid-subscriber client produced no JSON report",
			"raid-subscriber client exited 128; stderr=subscriber checkout failed",
			"raid-subscriber client produced no off-box provenance lines",
		]);
		expect(clientProcessFailureReasons("publisher", publisher, true)).toEqual([
			"publisher client produced no JSON report",
			"publisher client exited 17; stderr=publisher build failed",
			"publisher client produced no off-box provenance lines",
		]);
	});

	test("uses provided provenance when present", () => {
		expect(
			chooseClientProvenance({
				provenanceLines: ["macgen: host=generator"],
				offbox: false,
				exitCode: 0,
				localFallback: ["localgen: exit=0"],
			}),
		).toEqual(["macgen: host=generator"]);
	});

	test("falls back locally only when a bundle exists but reported no provenance", () => {
		expect(
			chooseClientProvenance({
				provenanceLines: [],
				offbox: false,
				exitCode: 17,
				localFallback: ["localgen: exit=17"],
			}),
		).toEqual(["localgen: exit=17"]);
		expect(
			chooseClientProvenance({
				provenanceLines: [],
				offbox: false,
				exitCode: null,
				localFallback: ["localgen: exit=0"],
			}),
		).toEqual([]);
	});

	test("never fabricates local provenance for off-box runs", () => {
		expect(
			chooseClientProvenance({
				provenanceLines: [],
				offbox: true,
				exitCode: 0,
				localFallback: ["localgen: exit=0"],
			}),
		).toEqual([]);
	});
});
