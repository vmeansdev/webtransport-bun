import { describe, expect, test } from "bun:test";
import {
	editRaidReport,
	editRealmReport,
	FIXTURE,
	gradeInput,
	hist,
	steerRaw,
} from "./g6-sharded-arms.fixture.test-helper.ts";
import {
	applyGeneratorLimit,
	frozenVR,
	gradeShardedArmsCell,
	SHARDED_ARMS_CELLS,
	SHARDED_ARMS_REGISTERED,
	SHARDED_ARMS_V_R_MS,
	type ShardedArmsGradeInput,
} from "./g6-sharded-arms-grade.ts";

type Row = Record<string, unknown>;
const DATE = "2026-10-06T12:00:00.000Z";
const grade = (input: ShardedArmsGradeInput) =>
	gradeShardedArmsCell(input, DATE);
const o = (v: unknown) => v as Row;
const fired = (input: ShardedArmsGradeInput, id: string) => {
	const verdict = grade(input);
	return {
		verdict,
		falsifier: verdict.falsifiers.find((f) => f.id === id),
	};
};

/** Assert one falsifier flips the cell INVALID, and only through itself. */
function expectInvalidBy(input: ShardedArmsGradeInput, id: string) {
	const { verdict, falsifier } = fired(input, id);
	expect(falsifier?.fired).toBe(true);
	expect(verdict.verdict).toBe("INVALID");
	return verdict;
}

/** Set a window's RTT samples in every realm report and per-shard window. */
function setRtt(
	scan: Row,
	name: string,
	valueNs: number,
	onlyShard?: string,
): void {
	for (const which of [
		-1,
		...Array.from({ length: FIXTURE.processes }, (_, i) => i),
	])
		editRealmReport(scan, which, (r) => {
			const shards = o(o(r.arms).shards);
			let changed = 0;
			for (const [id, s] of Object.entries(shards)) {
				if (onlyShard !== undefined && id !== onlyShard) continue;
				const w = o(o(s)[name]);
				w.rtt = hist(valueNs, w.rxAck as number);
				changed += w.rxAck as number;
			}
			const w = o(o(r.windows)[name]);
			const keep = (w.rxAck as number) - changed;
			// Realm-wide histogram = the shard parts, bucket by bucket.
			const parts = new Map<number, number>();
			for (const [idx, c] of hist(valueNs, changed).buckets)
				parts.set(idx, (parts.get(idx) ?? 0) + c);
			for (const [idx, c] of hist(5_000_000, keep).buckets)
				parts.set(idx, (parts.get(idx) ?? 0) + c);
			const buckets = [...parts.entries()].sort((a, b) => a[0] - b[0]);
			w.rtt = {
				...hist(valueNs, 0),
				buckets,
				count: w.rxAck,
				recordedTotal: w.rxAck,
				maxNs: Math.max(valueNs, keep > 0 ? 5_000_000 : 0),
			};
		});
}

describe("registration", () => {
	test("cells, order and maxima are the plan's", () => {
		expect(SHARDED_ARMS_CELLS.map((c) => c.id)).toEqual([
			"H5k",
			"H40k",
			"S1-5k",
			"S2-5k",
			"S1-40k",
			"S2-40k",
		]);
		expect(SHARDED_ARMS_CELLS.map((c) => [c.sessions, c.cohort])).toEqual([
			[5000, 0],
			[40000, 0],
			[5000, 1000],
			[5000, 5000],
			[40000, 8000],
			[40000, 40000],
		]);
		expect(SHARDED_ARMS_CELLS.find((c) => c.id === "S2-40k")?.role).toBe(
			"characterization",
		);
		expect(SHARDED_ARMS_REGISTERED.realmAckRttP99CeilingMs).toBe(25);
		expect(SHARDED_ARMS_REGISTERED.g6AckRttBudgetMs).toBe(50);
		expect(SHARDED_ARMS_REGISTERED.hotspotMaximumSeconds).toBe(480);
		expect(SHARDED_ARMS_REGISTERED.stormMaximumSeconds).toBe(600);
	});

	test("R is frozen at 500 ms (work item 6 characterization)", () => {
		expect(SHARDED_ARMS_V_R_MS).toBe(500);
		expect(frozenVR()).toEqual({ ms: 500, source: "frozen" });
	});
});

describe("baseline fixtures grade PASS from raw fields", () => {
	test("hotspot", () => {
		const v = grade(gradeInput("hotspot"));
		expect(v.invalidReasons).toEqual([]);
		expect(v.verdict).toBe("PASS");
		expect(v.clauses.map((c) => [c.id, c.verdict])).toEqual([
			["H1", "PASS"],
			["H2", "PASS"],
			["H3", "PASS"],
		]);
		expect(v.reportedBeside[0]?.observed.rttBudgetMs).toBe(50);
		expect(v.falsifiers.map((f) => f.id)).toEqual([
			"V-C",
			"RAW",
			"V-F",
			"V-N/V-K/V-D",
			"V-G",
			"V-P",
			"V-B",
			"V-I/H4",
			"V-S",
		]);
	});

	test("storm", () => {
		const v = grade(gradeInput("storm"));
		expect(v.invalidReasons).toEqual([]);
		expect(v.verdict).toBe("PASS");
		expect(v.clauses.map((c) => [c.id, c.verdict])).toEqual([
			["S-C1", "PASS"],
			["S-C2", "PASS"],
		]);
		expect(v.falsifiers.map((f) => f.id)).toEqual([
			"V-C",
			"RAW",
			"V-F",
			"V-N/V-K/V-D",
			"V-G",
			"V-P",
			"V-B",
			"V-T",
			"V-R",
			"V-W",
			"V-L",
		]);
		expect(o(v.characterization["S-M"]).verdictForce).toBe(false);
	});
});

describe("failing signatures: one per falsifier", () => {
	test("V-C: an unqualified rig is INVALID", () => {
		const input = gradeInput("hotspot");
		input.rig = { qualified: false, reasons: ["PREPARED_HOST missing"] };
		expectInvalidBy(input, "V-C");
	});

	test("V-F: floor scheduleLag p99 above 10 ms", () => {
		expectInvalidBy(
			gradeInput("storm", (scan) => {
				const floor = o(o(o(scan.arms).precheck).floor);
				const lines = floor.transcript as string[];
				floor.transcript = lines.map((line) => {
					if (!line.startsWith("mmo-client: json ")) return line;
					const r = JSON.parse(line.slice(17));
					r.windows.steady.scheduleLag = hist(12_000_000, 800);
					return `mmo-client: json ${JSON.stringify(r)}`;
				});
			}),
			"V-F",
		);
	});

	test("V-F: a failed loopback forwarder (recorded, not aborted) is INVALID", () => {
		const v = expectInvalidBy(
			gradeInput("storm", (scan) => {
				o(o(o(scan.arms).precheck).forwarder).rc = 1;
			}),
			"V-F",
		);
		expect(v.invalidReasons.join(" ")).toContain("forwarder");
	});

	test("V-F: a floor over 19 sessions is INVALID", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) => {
				const floor = o(o(o(scan.arms).precheck).floor);
				floor.transcript = (floor.transcript as string[]).map((line) =>
					line.replace('"sessionsOk":20', '"sessionsOk":19'),
				);
			}),
			"V-F",
		);
	});

	test("V-S: sink delivery below 0.995", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) => {
				const sink = o(o(o(scan.arms).precheck).sink);
				o(o(o(sink.subscriberReport).windows).steadyDrain).rxRaid = 23000;
			}),
			"V-S",
		);
	});

	const sinkPublisher = (scan: Row, sent: number, skipped: number) => {
		const sink = o(o(o(scan.arms).precheck).sink);
		const w = o(o(o(sink.publisherReport).windows).steady);
		w.sent = sent;
		w.scheduleTicksFired = sent;
		w.scheduleTicksSkipped = skipped;
		w.scheduleTicksDue = sent + skipped;
		o(o(o(sink.subscriberReport).windows).steadyDrain).rxRaid = sent * 40;
	};

	test("V-S: a skip fraction of 0.5 % is tolerated and disclosed", () => {
		const v = grade(
			gradeInput("hotspot", (scan) => sinkPublisher(scan, 597, 3)),
		);
		expect(v.falsifiers.find((f) => f.id === "V-S")?.fired).toBe(false);
		expect(v.verdict).toBe("PASS");
		expect(o(v.characterization["V-S"])).toMatchObject({
			publisherTicksSkipped: 3,
			publisherTicksDue: 600,
			achievedPps: 1194,
			floorPps: 1194,
			delivery: 1,
		});
	});

	test("V-S: a single skipped tick does not fire on its own", () => {
		const v = grade(
			gradeInput("hotspot", (scan) => sinkPublisher(scan, 599, 1)),
		);
		expect(v.falsifiers.find((f) => f.id === "V-S")?.fired).toBe(false);
		expect(v.verdict).toBe("PASS");
		expect(o(v.characterization["V-S"]).publisherTicksSkipped).toBe(1);
	});

	test("V-S: a failed loopback forwarder invalidates the sink check", () => {
		const { verdict, falsifier } = fired(
			gradeInput("hotspot", (scan) => {
				o(o(o(scan.arms).precheck).forwarder).rc = 1;
			}),
			"V-S",
		);
		expect(falsifier?.fired).toBe(true);
		expect(falsifier?.reasons.join(" ")).toContain("forwarder rc 1");
		expect(verdict.verdict).toBe("INVALID");
	});

	test("V-S: an originator below 0.995 x 1,200/s is INVALID", () => {
		const v = expectInvalidBy(
			gradeInput("hotspot", (scan) => sinkPublisher(scan, 596, 4)),
			"V-S",
		);
		expect(v.invalidReasons.join(" ")).toContain("4 of 600 ticks skipped");
	});

	test("V-N: a negative RTT sample in one process", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRealmReport(scan, 1, (r) => {
					o(o(o(r.windows).steadyDrain).rtt).negative = 1;
				}),
			),
			"V-N/V-K/V-D",
		);
	});

	test("V-K: recordedTotal ahead of the buckets, per process before merge", () => {
		expectInvalidBy(
			gradeInput("storm", (scan) =>
				editRealmReport(scan, 0, (r) => {
					const h = o(o(o(r.windows).stormSurvivors).rtt);
					h.recordedTotal = (h.count as number) + 5;
				}),
			),
			"V-N/V-K/V-D",
		);
	});

	test("V-K: a merged histogram that is not the bucket sum of the processes", () => {
		const v = expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRealmReport(scan, -1, (r) => {
					const w = o(o(r.windows).steadyDrain);
					w.rtt = hist(6_000_000, w.rxAck as number);
				}),
			),
			"V-N/V-K/V-D",
		);
		expect(v.invalidReasons.join(" ")).toContain("V-K merge");
	});

	test("V-D: shard-K subset denominator differs from its stamped deliveries", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRealmReport(scan, 0, (r) => {
					const w = o(o(o(o(r.arms).shards)["1"]).steadyDrain);
					w.rxAck = (w.rxAck as number) + 1;
				}),
			),
			"V-N/V-K/V-D",
		);
	});

	test("V-D: unstamped receives make the subscriber population unclassifiable", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRaidReport(scan, "subscriberStdout", (r) => {
					o(o(r.windows).steadyDrain).rxUnstamped = 3;
				}),
			),
			"V-N/V-K/V-D",
		);
	});

	test("V-L: Little's law on a permit pool strips S-M only", () => {
		const v = grade(
			gradeInput("storm", (scan) =>
				editRealmReport(scan, -1, (r) => {
					// 2 accepts over 1 ms → 2000/s x 0.04 s = 80 = the pool.
					o(r.storm).concurrency = 80;
				}),
			),
		);
		// The accepts in the fixture are simultaneous: give them a span.
		const input = gradeInput("storm", (scan) => {
			editRealmReport(scan, -1, (r) => {
				o(r.storm).concurrency = 80;
			});
			const st = o(o(scan.arms).storm);
			const shard = (o(st.server).perShard as Row[])[0] as Row;
			const t = (shard.acceptMsAfterSever as number[])[0] as number;
			shard.acceptMsAfterSever = [t, t + 1];
		});
		const little = grade(input).falsifiers.find((f) => f.id === "V-L");
		expect(little?.fired).toBe(true);
		expect(little?.scope).toBe("characterization");
		expect(o(grade(input).characterization["S-M"]).strippedByVL).toBe(true);
		// The registered storm has no permit pool: a pool is a raw-cell INVALID.
		expect(v.falsifiers.find((f) => f.id === "RAW")?.fired).toBe(true);
	});

	test("V-G: realm offered ratio below 0.99", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRealmReport(scan, -1, (r) => {
					const w = o(o(r.windows).steady);
					w.scheduleTicksDue = Math.ceil((w.sent as number) / 0.98);
				}),
			),
			"V-G",
		);
	});

	test("V-I/H4: no cadence on shard K's publisher arrivals", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) => {
				const echoes = o(scan.arms).shardEchoes as Row[];
				const stop = o(o(o(echoes[0]).echoes).stop);
				const hot = o(stop.hotspot);
				hot.publisherGapsSteadyDrainNs = (
					hot.publisherGapsSteadyDrainNs as number[]
				).map(() => 1_000);
			}),
			"V-I/H4",
		);
	});

	test("V-I/H4: shard K without raw publisher arrivals is INVALID, not a pass", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) => {
				const echoes = o(scan.arms).shardEchoes as Row[];
				delete o(o(o(echoes[0]).echoes).stop).hotspot;
			}),
			"V-I/H4",
		);
	});

	test("V-P: a raid member lands off shard K", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) => {
				const echoes = o(scan.arms).shardEchoes as Row[];
				const drainK = o(o(o(echoes[0]).echoes).drain);
				o(drainK.raidMembers).tokens = Array.from(
					{ length: 39 },
					(_, i) => i + 1,
				);
				const drain2 = o(o(o(echoes[1]).echoes).drain);
				o(drain2.raidMembers).tokens = [40];
			}),
			"V-P",
		);
	});

	test("V-P: client-derived per-shard counts disagree with the server at steady entry", () => {
		expectInvalidBy(
			gradeInput("storm", (scan) => {
				const shards = scan.shards as Row[];
				(shards[1] as Row).sessionsAtSteady =
					((shards[1] as Row).sessionsAtSteady as number) + 1;
				(shards[0] as Row).sessionsAtSteady =
					((shards[0] as Row).sessionsAtSteady as number) - 1;
			}),
			"V-P",
		);
	});

	test("V-P: reconnect placement disagrees at storm end", () => {
		expectInvalidBy(
			gradeInput("storm", (scan) => {
				const server = o(
					o(o(o(scan.arms).storm).sessionsByShardAtStormEnd).server,
				);
				server["1"] = (server["1"] as number) + 1;
				server["2"] = (server["2"] as number) - 1;
			}),
			"V-P",
		);
	});

	test("V-P: an 11-octet opening DCID (kernel-hash path) is INVALID", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRaidReport(scan, "subscriberStdout", (r) => {
					o(r.arms).dcidLen = 11;
				}),
			),
			"V-P",
		);
	});

	test("V-T: sever instants more than 100 ms apart", () => {
		expectInvalidBy(
			gradeInput("storm", (scan) =>
				editRealmReport(scan, 1, (r) => {
					const st = o(o(r.arms).storm);
					st.severUnixMs = (st.severUnixMs as number) + 101;
				}),
			),
			"V-T",
		);
	});

	test("V-R: a first Initial later than R", () => {
		expectInvalidBy(
			gradeInput("storm", (scan) =>
				editRealmReport(scan, 0, (r) => {
					o(o(r.arms).storm).reconnectInitialLate = hist(300_000_000, 1);
				}),
			),
			"V-R",
		);
	});

	test("V-R on the characterization cell (S2-40k) is reported, not verdict-forcing", () => {
		const input = gradeInput("storm", (scan) => {
			for (const which of [-1, ...Array(FIXTURE.processes).keys()])
				editRealmReport(scan, which, (r) => {
					const storm = o(o(r.arms).storm);
					storm.reconnectInitialLate = hist(300_000_000, Number(storm.cohort));
				});
		});
		input.cell = {
			...input.cell,
			id: "S2-40k",
			role: "characterization",
			gatedClauses: ["S-C2"],
		};
		const v = grade(input);
		expect(v.verdict).toBe("PASS");
		expect(v.verdictForce).toBe(false);
		expect(v.falsifiers.find((f) => f.id === "V-R")?.fired).toBe(false);
		const reported = v.falsifiers.find((f) => f.id === "V-R (reported)");
		expect(reported?.fired).toBe(true);
		expect(reported?.scope).toBe("characterization");
		expect(reported?.reasons.join(" ")).toContain("> R 250 ms");
		expect(v.disclosures.join(" ")).toContain("S2-40k) is reported");
	});

	test("V-R raw integrity still forces on the characterization cell", () => {
		const input = gradeInput("storm", (scan) =>
			editRealmReport(scan, 0, (r) => {
				o(o(r.arms).storm).initialIssueClock = "wire";
			}),
		);
		input.cell = { ...input.cell, id: "S2-40k", role: "characterization" };
		expectInvalidBy(input, "V-R");
	});

	test("V-R: a missing lateness maxNs is raw-integrity INVALID, even on S2-40k", () => {
		const input = gradeInput("storm", (scan) =>
			editRealmReport(scan, 0, (r) => {
				delete o(o(o(r.arms).storm).reconnectInitialLate).maxNs;
			}),
		);
		input.cell = { ...input.cell, id: "S2-40k", role: "characterization" };
		const v = expectInvalidBy(input, "V-R");
		expect(v.invalidReasons.join(" ")).toContain(
			"outside the highest non-empty bucket",
		);
	});

	test("V-R: a lateness maxNs outside the highest non-empty bucket is INVALID", () => {
		for (const maxNs of [1_000, 900_000_000, Number.NaN, -1])
			expectInvalidBy(
				gradeInput("storm", (scan) =>
					editRealmReport(scan, -1, (r) => {
						o(o(o(r.arms).storm).reconnectInitialLate).maxNs = maxNs;
					}),
				),
				"V-R",
			);
	});

	test("S-C1 accounting: a numerator above survivor sent by window misalignment is reported, not INVALID", () => {
		const baseline = o(
			grade(gradeInput("storm")).characterization["S-C1 accounting"],
		);
		expect(baseline.verdictForce).toBe(false);
		// 200 datagrams over sent: about 1.5 ms of window misalignment at the
		// S1-40k survivor rate (about 130 datagrams/ms), on a correct cell.
		const over = 200 - Number(baseline.numeratorMinusSent);
		const v = grade(
			gradeInput("storm", (scan) => {
				const w = o(o(((scan.shards as Row[])[0] as Row).windows).storm);
				w.rxSurvivors = Number(w.rxSurvivors) + over;
			}),
		);
		expect(v.verdict).toBe("PASS");
		expect(v.invalidReasons).toEqual([]);
		expect(v.falsifiers.map((f) => f.id)).not.toContain("S-C1 accounting");
		expect(o(v.characterization["S-C1 accounting"])).toMatchObject({
			verdictForce: false,
			numeratorMinusSent: 200,
		});
		expect(v.clauses.find((c) => c.id === "S-C1")?.verdict).toBe("PASS");
	});

	test("V-R: without a frozen R a storm cell refuses to grade", () => {
		const input = gradeInput("storm");
		input.vR = null;
		const v = expectInvalidBy(input, "V-R");
		expect(v.invalidReasons.join(" ")).toContain("R is not frozen");
	});

	test("V-F': a generator-limited steady window is INVALID, never a MISS", () => {
		const v = grade(
			gradeInput("hotspot", (scan) =>
				editRaidReport(scan, "publisherStdout", (r) => {
					const w = o(o(r.windows).steady);
					w.scheduleLag = hist(15_000_000, w.scheduleTicksFired as number);
				}),
			),
		);
		expect(v.verdict).toBe("INVALID");
		expect(v.clauses.find((c) => c.id === "H1")?.verdict).toBe("INVALID");
		expect(v.clauses.find((c) => c.id === "H1")?.generatorLimited).toBe(
			"fired",
		);
	});

	test("V-F': an empty named histogram is not applicable, never INVALID", () => {
		const clause = applyGeneratorLimit(
			{ id: "S-C1", verdict: "N/A", reasons: [], observed: {}, gated: false },
			{ worstMs: null, byProcess: { "realm process 0": null } },
			"storm-window survivor scheduleLag",
		);
		expect(clause.generatorLimited).toBe("not applicable");
		expect(clause.verdict).toBe("N/A");
	});

	test("V-W: storm-window fallback above 1 % from the raw dumps", () => {
		expectInvalidBy(
			gradeInput("storm", (scan) => {
				const steering = o(o(o(scan.arms).storm).steering);
				o(steering.end).steerStatsRaw = steerRaw(51000, 1000);
				// The scan's own summary would still say 0 — never read.
				steering.delta = { steered: 50000, fallback: 0, fallbackFraction: 0 };
			}),
			"V-W",
		);
	});

	test("V-B: six-party steady-entry skew above 100 ms", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRaidReport(scan, "subscriberStdout", (r) => {
					const b = o(r.phaseBarrier);
					b.steadyEnterUnixMs = (b.steadyEnterUnixMs as number) + 150;
				}),
			),
			"V-B",
		);
	});
});

describe("per-kind raw-cell expectations", () => {
	test("raid processes on their own registered source ports", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRaidReport(scan, "publisherStdout", (r) => {
					o(r.client).endpointSourceAddresses = [`0.0.0.0:${FIXTURE.base}`];
				}),
			),
			"RAW",
		);
	});

	test("session census: 40 raid subscribers and one publisher", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRaidReport(scan, "subscriberStdout", (r) => {
					r.sessionsOk = 39;
				}),
			),
			"RAW",
		);
	});

	test("realm sessions never join the raid", () => {
		expectInvalidBy(
			gradeInput("hotspot", (scan) =>
				editRealmReport(scan, -1, (r) => {
					o(r.arms).raidJoinsSent = 3;
				}),
			),
			"RAW",
		);
	});

	test("overridden durations are a rehearsal, not a cell", () => {
		expectInvalidBy(
			gradeInput("storm", (scan) => {
				o(o(scan.arms).config).durationsOverridden = true;
			}),
			"RAW",
		);
	});

	test("a cohort split that is not the even share", () => {
		expectInvalidBy(
			gradeInput("storm", (scan) =>
				editRealmReport(scan, 0, (r) => {
					o(o(r.arms).storm).cohort = 2;
				}),
			),
			"RAW",
		);
	});
});

describe("clauses on this deployment's own bars", () => {
	test("H3 is gated at 25 ms on shard K's co-resident sessions", () => {
		const v = grade(
			gradeInput("hotspot", (scan) =>
				setRtt(scan, "steadyDrain", 30_000_000, "1"),
			),
		);
		expect(v.verdict).toBe("MISS");
		const h3 = v.clauses.find((c) => c.id === "H3");
		expect(h3?.verdict).toBe("MISS");
		expect(h3?.reasons.join(" ")).toContain("H3 shard 1 S4");
		// G6's 50 ms bar is reported beside, without verdict force.
		expect(v.reportedBeside[0]?.verdict).toBe("PASS");
	});

	test("S-C1 survivors at 30 ms MISS the gated 25 ms and pass G6's 50 ms", () => {
		const v = grade(
			gradeInput("storm", (scan) => setRtt(scan, "stormSurvivors", 30_000_000)),
		);
		expect(v.clauses.find((c) => c.id === "S-C1")?.verdict).toBe("MISS");
		expect(v.reportedBeside[0]?.verdict).toBe("PASS");
		expect(v.verdict).toBe("MISS");
	});

	test("S-C1 reports the rxAck-corrected and the uncorrected survivor delivery", () => {
		const v = grade(gradeInput("storm"));
		const gated = v.clauses.find((c) => c.id === "S-C1");
		const beside = v.reportedBeside.find((c) => c.id.startsWith("S-C1 (G6"));
		for (const c of [gated, beside]) {
			const obs = o(c?.observed);
			const moves = obs.survivorMovesJs as number;
			const acks = obs.survivorAcksReflected as number;
			expect(moves).toBeGreaterThan(0);
			expect(acks).toBeGreaterThan(0);
			expect(typeof obs.delivery).toBe("number");
			expect(typeof obs.deliveryUncorrected).toBe("number");
			// The corrected ratio adds the reflected survivor actions.
			expect(obs.delivery as number).toBeCloseTo(
				(obs.deliveryUncorrected as number) * ((moves + acks) / moves),
				9,
			);
		}
		expect(gated?.verdict).toBe("PASS");
	});

	test("S-C1 without the reflected survivor actions (uncorrected) MISSes delivery", () => {
		const v = grade(
			gradeInput("storm", (scan) => {
				for (const which of [
					-1,
					...Array.from({ length: FIXTURE.processes }, (_, i) => i),
				])
					editRealmReport(scan, which, (r) => {
						o(o(r.windows).stormSurvivors).rxAck = 0;
						o(o(r.windows).stormSurvivors).rtt = hist(5_000_000, 0);
					});
			}),
		);
		const sc1 = v.clauses.find((c) => c.id === "S-C1");
		expect(o(sc1?.observed).survivorAcksReflected).toBe(0);
		expect(sc1?.reasons.join(" ")).toContain("survivor upstream delivery");
	});

	test("S-C2 from the raw accept instants, not the scan's count", () => {
		const v = grade(
			gradeInput("storm", (scan) => {
				const st = o(o(scan.arms).storm);
				const shard = (o(st.server).perShard as Row[])[0] as Row;
				shard.acceptMsAfterSever = [
					(shard.acceptMsAfterSever as number[])[0],
					(st.stormEndAtMs as number) + 5,
				];
				o(st.server).reAcceptedThroughWindowClose = 2;
			}),
		);
		expect(v.clauses.find((c) => c.id === "S-C2")?.verdict).toBe("MISS");
	});

	test("H2 forward delivery below 0.995", () => {
		const v = grade(
			gradeInput("hotspot", (scan) =>
				editRaidReport(scan, "subscriberStdout", (r) => {
					const w = o(o(r.windows).steadyDrain);
					w.rxRaid = 95000;
					w.oneWay = hist(4_000_000, 95000);
				}),
			),
		);
		expect(v.clauses.find((c) => c.id === "H2")?.verdict).toBe("MISS");
		expect(v.verdict).toBe("MISS");
	});
});
