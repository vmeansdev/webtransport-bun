/**
 * Pins G8's arithmetic to the tables in
 * `docs/research/preregistrations/gate-g8-many-rooms.md` §1.
 *
 * These are not tests of behaviour. They are the mechanism that stops the
 * registration's prose and the harness's constants from drifting apart, which is
 * the defect G6's amendment 1 was.
 */

import { describe, expect, test } from "bun:test";
import { datagramsPerTick } from "./egress-fanout.ts";
import {
	forwardIssueLoad,
	G8_LADDERS,
	OPUS_KBPS_DISCLOSED,
	PER_TARGET_ISSUE_NS,
	phaseOffsetNs,
	poolSize,
	ratePerSecFromFrameMs,
	rungPlan,
	sinkProcessFor,
	tolerance,
	voicePayloadBytes,
	VIDEO_BOUND_NS,
	VOICE_BOUND_NS,
} from "./g8-plan.ts";
import { STAMP_BYTES_V3 } from "./latency-stamp.ts";

/** K5: G4's largest complete fan-out step. The yardstick every rung is placed against. */
const G4_LARGEST_COMPLETE_FORWARD_PER_SEC = 33_016;
/** K4: G4's registered gate point. */
const G4_GATE_FORWARD_PER_SEC = 16_510.04;
/** K14: the settled on-box ceiling. */
const ONBOX_CEILING_PER_SEC = 103_000;

describe("§1.2 the voice payload", () => {
	test("32 kbps Opus in a 20 ms frame plus a v3 stamp is 128 B", () => {
		expect(voicePayloadBytes()).toBe(128);
		expect(STAMP_BYTES_V3).toBe(48);
	});

	test("the disclosed 64 kbps variant is 208 B and does not change the rate", () => {
		expect(voicePayloadBytes(OPUS_KBPS_DISCLOSED)).toBe(208);
		expect(ratePerSecFromFrameMs()).toBe(50);
	});

	test("the stamp is larger than an RTP header, so the byte reading is conservative", () => {
		expect(STAMP_BYTES_V3).toBeGreaterThan(12 + 4);
	});
});

describe("§1.5 the bounds", () => {
	test("voice is one Opus frame period", () => {
		expect(VOICE_BOUND_NS).toBe(ratePerSecFromFrameMs() > 0 ? 20e6 : 0);
		expect(VOICE_BOUND_NS / 1e6).toBe(1000 / ratePerSecFromFrameMs());
	});

	test("the G.114 decomposition leaves exactly the registered budget", () => {
		const fixed = 25 + 30 + 30 + 40 + 5;
		expect(150 - fixed).toBe(VOICE_BOUND_NS / 1e6);
	});

	test("video is one 30 fps frame, unchanged from G3 and G4", () => {
		expect(VIDEO_BOUND_NS).toBe(33.3e6);
		// G3 and G4 both truncate the 33.333 ms frame to 33.3, i.e. the bound is
		// 0.1% tighter than the frame. Taken unchanged so arm B compares.
		expect(VIDEO_BOUND_NS).toBeLessThan(1e9 / 30);
		expect((1e9 / 30 - VIDEO_BOUND_NS) / (1e9 / 30)).toBeLessThan(0.002);
	});
});

describe("§1.4 arm A — voice", () => {
	test("the ladder is the registered one", () => {
		expect([...G8_LADDERS.voice]).toEqual([10, 50, 100]);
	});

	test.each([
		[10, 500, 5_000, 5_500],
		[50, 2_500, 25_000, 27_500],
		[100, 5_000, 50_000, 55_000],
	])("M=%i ingests %i/s, forwards %i/s, %i/s total", (m, ingest, fwd, total) => {
		const p = rungPlan("voice", m);
		expect(p.ingestPerSec).toBe(ingest);
		expect(p.forwardPerSec).toBe(fwd);
		expect(p.totalPerSec).toBe(total);
		expect(p.sessions).toBe(m * 11);
		expect(p.boundNs).toBe(VOICE_BOUND_NS);
	});

	test("the top rung is 1.51x G4's largest complete fan-out egress", () => {
		const p = rungPlan("voice", 100);
		expect(p.forwardPerSec / G4_LARGEST_COMPLETE_FORWARD_PER_SEC).toBeCloseTo(
			1.51,
			2,
		);
		expect(p.totalPerSec / ONBOX_CEILING_PER_SEC).toBeCloseTo(0.53, 2);
	});

	test("the top rung pools into 4 publisher and 4 sink processes", () => {
		const p = rungPlan("voice", 100);
		expect(p.publisherProcesses).toBe(4);
		expect(p.sinkProcesses).toBe(4);
		expect(p.publishers / p.publisherProcesses).toBe(25);
		expect(p.subscribers / p.sinkProcesses).toBe(250);
	});
});

describe("§1.4 arm B — video, the controlled comparison with G4", () => {
	test("the rate is G4's quantised 11 datagrams per 30 Hz tick", () => {
		const p = rungPlan("video", 10);
		expect(datagramsPerTick(p.ratePerSec, 30)).toBe(11);
		expect(p.payloadBytes).toBe(1150);
	});

	test.each([
		[2, 660, 6_600],
		[5, 1_650, 16_500],
		[10, 3_300, 33_000],
	])("M=%i ingests %i/s and forwards %i/s", (m, ingest, fwd) => {
		const p = rungPlan("video", m);
		expect(p.ingestPerSec).toBe(ingest);
		expect(p.forwardPerSec).toBe(fwd);
		expect(p.boundNs).toBe(VIDEO_BOUND_NS);
	});

	test("M=5 reproduces G4's gate-point aggregate and M=10 its largest complete step", () => {
		expect(
			rungPlan("video", 5).forwardPerSec / G4_GATE_FORWARD_PER_SEC,
		).toBeCloseTo(1, 2);
		const top = rungPlan("video", 10).forwardPerSec;
		expect(
			Math.abs(top - G4_LARGEST_COMPLETE_FORWARD_PER_SEC) /
				G4_LARGEST_COMPLETE_FORWARD_PER_SEC,
		).toBeLessThan(0.001);
	});

	test("the arm changes exactly one variable against G4: ingest concurrency", () => {
		const top = rungPlan("video", 10);
		expect(top.publishers).toBe(10);
		expect(top.targetsPerArrival).toBe(10);
		// G4's shape: 1 publisher, 100 targets, same product.
		expect(top.publishers * top.targetsPerArrival).toBe(1 * 100);
	});
});

describe("§1.4 arm C — the mutual room, in K6's own units", () => {
	test.each([
		[2, 1_000, 9_000],
		[5, 2_500, 22_500],
		[10, 5_000, 45_000],
	])("M=%i ingests %i/s and forwards %i/s", (m, ingest, fwd) => {
		const p = rungPlan("mutual", m);
		expect(p.ingestPerSec).toBe(ingest);
		expect(p.forwardPerSec).toBe(fwd);
	});

	test("per-room forward load is K6's P(P-1)R", () => {
		const p = rungPlan("mutual", 1);
		expect(p.forwardPerSec).toBe(10 * 9 * 50);
		expect(p.forwardPerSec).toBe(4_500);
	});

	test("the members are the sinks, so the sink pool is the publisher pool", () => {
		const p = rungPlan("mutual", 10);
		expect(p.subscribers).toBe(0);
		expect(p.sessions).toBe(100);
		expect(p.sinkProcesses).toBe(p.publisherProcesses);
	});

	test("M=10 carries arm A's top ingest rate across ten times the publishers", () => {
		expect(rungPlan("mutual", 10).ingestPerSec).toBe(
			rungPlan("voice", 100).ingestPerSec,
		);
		expect(rungPlan("mutual", 10).publishers).toBe(100);
	});

	test("a mutual video room needs 29,700/s for one room — why it stays out of scope", () => {
		expect(10 * 9 * 330).toBe(29_700);
		expect(29_700 / G4_LARGEST_COMPLETE_FORWARD_PER_SEC).toBeGreaterThan(0.89);
	});
});

describe("§5 the 1%-of-cohort tolerance", () => {
	test.each([
		[2, 0],
		[5, 0],
		[10, 0],
		[50, 0],
		[99, 0],
		[100, 1],
		[1_000, 10],
	])("tolerance(%i) is %i", (n, want) => {
		expect(tolerance(n)).toBe(want);
	});

	test("it means the same thing at every M, unlike a worst-of-M clause", () => {
		// A worst-of-M clause tightens as M grows because it is a max over more
		// order statistics. A fixed fraction does not.
		expect(tolerance(100) / 100).toBeCloseTo(tolerance(1_000) / 1_000, 10);
	});
});

describe("§1.6 phase spreading", () => {
	test("publishers are spread evenly across one frame period", () => {
		const period = 20e6;
		expect(phaseOffsetNs(0, 4, period)).toBe(0);
		expect(phaseOffsetNs(1, 4, period)).toBe(5e6);
		expect(phaseOffsetNs(3, 4, period)).toBe(15e6);
	});

	test("no offset ever reaches a whole period, so no publisher is aliased onto another", () => {
		const period = 20e6;
		for (let i = 0; i < 100; i += 1) {
			expect(phaseOffsetNs(i, 100, period)).toBeLessThan(period);
		}
		const offsets = new Set(
			Array.from({ length: 100 }, (_, i) => phaseOffsetNs(i, 100, period)),
		);
		expect(offsets.size).toBe(100);
	});

	test("a single publisher has no offset to spread", () => {
		expect(phaseOffsetNs(0, 1, 20e6)).toBe(0);
	});
});

describe("§3.2 pooling", () => {
	test("pool size is a ceiling, not a rounding", () => {
		expect(poolSize(100, 25)).toBe(4);
		expect(poolSize(101, 25)).toBe(5);
		expect(poolSize(0, 25)).toBe(0);
	});

	test("subscribers round-robin so room identity is independent of sink identity", () => {
		// Arm A M=10: 100 subscribers, 1 sink process — nothing to spread.
		expect(sinkProcessFor(7, 1)).toBe(0);
		// Arm A M=100: consecutive subscribers of one room land on different sinks.
		const roomBase = 3 * 10;
		const sinks = new Set(
			Array.from({ length: 10 }, (_, slot) =>
				sinkProcessFor(roomBase + slot, 4),
			),
		);
		expect(sinks.size).toBe(4);
	});
});

describe("§1.7 the forward-issue budget", () => {
	test("the applicable per-target cost is G4's K=10 column, not its headline", () => {
		expect(PER_TARGET_ISSUE_NS).toBe(9_730);
		// The headline 6.31 µs is the N=50 step and would understate G8 by 1.54x.
		expect(PER_TARGET_ISSUE_NS / 6_310).toBeCloseTo(1.54, 2);
	});

	test("arm A's top rung needs about half a core for the issue loop alone", () => {
		expect(forwardIssueLoad(50_000)).toBeCloseTo(0.4865, 4);
		expect(forwardIssueLoad(45_000)).toBeCloseTo(0.4379, 4);
	});
});

describe("derived falsifier bounds", () => {
	test("V-G's publisher lag bound is a tenth of the arm's own bound", () => {
		expect(rungPlan("voice", 10).publisherLagBoundNs).toBe(2e6);
		expect(rungPlan("video", 10).publisherLagBoundNs).toBeCloseTo(3.33e6, 0);
	});

	test("V-H(c) and the scaling band are derived from the bound, never from data", () => {
		const p = rungPlan("voice", 50);
		expect(p.conductorLagBoundNs).toBe(2e6);
		expect(p.scalingBandNs).toBe(2e6);
	});

	test("V-S drives 1.5x the rung's forward load", () => {
		expect(rungPlan("voice", 100).sinkPrecheckOfferedPerSec).toBe(75_000);
		expect(rungPlan("video", 10).sinkPrecheckOfferedPerSec).toBe(49_500);
	});
});
