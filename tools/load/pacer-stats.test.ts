import { describe, expect, test } from "bun:test";
import {
	assertOneProcessPerCell,
	pacerEnvironment,
	readPacerStats,
	windowPacerStats,
} from "./pacer-stats.ts";

const FULL = {
	pps: 75000,
	clump: 32,
	queueMs: 250,
	submits: 10,
	admittedTargets: 1000,
	refusedTargets: 3,
	clumps: 40,
	lateClumps: 2,
	maxLatenessUs: 900,
	scheduleResets: 1,
	deferredFailures: 0,
	threadStarts: 1,
	threadStartFailures: 0,
	pendingTargets: 7,
};

describe("readPacerStats", () => {
	test("reads the diagnostic __pacerStatsJson accessor", () => {
		const server = { __pacerStatsJson: () => JSON.stringify(FULL) };
		expect(readPacerStats(server)).toEqual(FULL);
	});

	test("falls back to the pre-rename pacerStatsJson name", () => {
		const server = { pacerStatsJson: () => JSON.stringify(FULL) };
		expect(readPacerStats(server)?.clumps).toBe(40);
	});

	test("accepts an object-returning snapshot accessor", () => {
		const server = { __pacerStatsSnapshot: () => ({ ...FULL }) };
		expect(readPacerStats(server)?.scheduleResets).toBe(1);
	});

	test("prefers __pacerStatsJson when both names exist", () => {
		const server = {
			__pacerStatsJson: () => JSON.stringify({ ...FULL, clumps: 1 }),
			pacerStatsJson: () => JSON.stringify({ ...FULL, clumps: 2 }),
		};
		expect(readPacerStats(server)?.clumps).toBe(1);
	});

	test("reaches a native handle when the facade exposes one instead", () => {
		const stats = { ...FULL, clumps: 77 };
		expect(
			readPacerStats({
				metricsSnapshot: () => ({}),
				__nativeHandle: { __pacerStatsJson: () => JSON.stringify(stats) },
			})?.clumps,
		).toBe(77);
		expect(
			readPacerStats({
				handle: { pacerStatsJson: () => JSON.stringify(stats) },
			})?.clumps,
		).toBe(77);
	});

	test("a composition without the API reports nothing at all", () => {
		expect(readPacerStats({ metricsSnapshot: () => ({}) })).toBeNull();
		expect(readPacerStats(null)).toBeNull();
		expect(readPacerStats(undefined)).toBeNull();
	});

	test("the knob-off `{}` reply carries no counters and so is not a report", () => {
		expect(readPacerStats({ __pacerStatsJson: () => "{}" })).toBeNull();
	});

	test("a throwing or unparseable accessor never fails the rung", () => {
		expect(
			readPacerStats({
				__pacerStatsJson: () => {
					throw new Error("boom");
				},
			}),
		).toBeNull();
		expect(readPacerStats({ __pacerStatsJson: () => "not json" })).toBeNull();
		expect(readPacerStats({ __pacerStatsJson: () => "[1,2]" })).toBeNull();
	});

	test("drops non-numeric fields rather than carrying them as counters", () => {
		const server = {
			__pacerStatsJson: () =>
				JSON.stringify({ clumps: 4, note: "hi", nan: Number.NaN }),
		};
		expect(readPacerStats(server)).toEqual({ clumps: 4 });
	});
});

describe("windowPacerStats", () => {
	test("counters are differenced across the window", () => {
		const open = { ...FULL };
		const close = {
			...FULL,
			submits: 30,
			admittedTargets: 4000,
			clumps: 140,
			lateClumps: 9,
			scheduleResets: 3,
		};
		const report = windowPacerStats(open, close);
		expect(report?.windowed).toMatchObject({
			submits: 20,
			admittedTargets: 3000,
			clumps: 100,
			lateClumps: 7,
			scheduleResets: 2,
			refusedTargets: 0,
		});
	});

	test("config is echoed and never differenced", () => {
		const report = windowPacerStats(FULL, { ...FULL, clumps: 41 });
		expect(report?.config).toEqual({ pps: 75000, clump: 32, queueMs: 250 });
		expect(report?.windowed.pps).toBeUndefined();
		expect(report?.configChangedMidWindow).toBeUndefined();
	});

	test("a config change mid-window is disclosed rather than averaged", () => {
		const report = windowPacerStats(FULL, { ...FULL, pps: 60000 });
		expect(report?.configChangedMidWindow).toEqual({
			pps: { open: 75000, close: 60000 },
		});
	});

	test("maxLatenessUs and pendingTargets stay since-process-start", () => {
		const report = windowPacerStats(FULL, {
			...FULL,
			maxLatenessUs: 5000,
			pendingTargets: 12,
		});
		expect(report?.sinceProcessStart).toEqual({
			maxLatenessUs: 5000,
			pendingTargets: 12,
		});
		expect(report?.windowed.maxLatenessUs).toBeUndefined();
		expect(report?.windowed.pendingTargets).toBeUndefined();
	});

	test("the raw pair travels so the subtraction can be checked", () => {
		const close = { ...FULL, clumps: 99 };
		const report = windowPacerStats(FULL, close);
		expect(report?.cumulative.atWindowOpen.clumps).toBe(40);
		expect(report?.cumulative.atWindowClose.clumps).toBe(99);
	});

	test("a counter this file predates is still differenced", () => {
		const report = windowPacerStats(
			{ ...FULL, gsoSegments: 10 },
			{ ...FULL, gsoSegments: 70 },
		);
		expect(report?.windowed.gsoSegments).toBe(60);
	});

	test("one missing read yields no half-attributed report", () => {
		expect(windowPacerStats(null, FULL)).toBeNull();
		expect(windowPacerStats(FULL, null)).toBeNull();
		expect(windowPacerStats(null, null)).toBeNull();
	});
});

describe("assertOneProcessPerCell", () => {
	test("an unpaced process may run the whole ladder and every arm", () => {
		expect(() =>
			assertOneProcessPerCell({
				pacerPps: undefined,
				ladder: [50_000, 60_000, 75_000],
				arms: ["A1", "A2", "A3"],
			}),
		).not.toThrow();
		expect(() =>
			assertOneProcessPerCell({
				pacerPps: "  ",
				ladder: [50_000, 60_000],
				arms: ["A1", "A2"],
			}),
		).not.toThrow();
	});

	test("a paced single-rate single-arm cell is accepted", () => {
		expect(() =>
			assertOneProcessPerCell({
				pacerPps: "75000",
				ladder: [60_000],
				arms: ["A3"],
			}),
		).not.toThrow();
	});

	test("a paced multi-rung ladder is refused at start-up", () => {
		expect(() =>
			assertOneProcessPerCell({
				pacerPps: "75000",
				ladder: [50_000, 60_000],
				arms: ["A3"],
			}),
		).toThrow(/one rate per process/);
	});

	test("a paced empty ladder is refused too", () => {
		expect(() =>
			assertOneProcessPerCell({ pacerPps: "75000", ladder: [], arms: ["A3"] }),
		).toThrow(/parsed 0 rates/);
	});

	test("a paced multi-arm run is refused at start-up", () => {
		expect(() =>
			assertOneProcessPerCell({
				pacerPps: "75000",
				ladder: [60_000],
				arms: ["A1", "A3"],
			}),
		).toThrow(/one arm per process/);
	});
});

describe("pacerEnvironment", () => {
	test("stamps the three knobs as-read plus the composition SHAs", () => {
		expect(
			pacerEnvironment({
				WEBTRANSPORT_PACER_PPS: "75000",
				WEBTRANSPORT_PACER_CLUMP: "32",
				WEBTRANSPORT_PACER_QUEUE_MS: "250",
				G10_COMPOSITION_SHAS: "g10=dcec476 pacer=0f885ef val=abc1234",
				UNRELATED: "ignored",
			}),
		).toEqual({
			WEBTRANSPORT_PACER_PPS: "75000",
			WEBTRANSPORT_PACER_CLUMP: "32",
			WEBTRANSPORT_PACER_QUEUE_MS: "250",
			G10_COMPOSITION_SHAS: "g10=dcec476 pacer=0f885ef val=abc1234",
		});
	});

	test("an unset knob stamps null, never a default the run did not use", () => {
		expect(pacerEnvironment({})).toEqual({
			WEBTRANSPORT_PACER_PPS: null,
			WEBTRANSPORT_PACER_CLUMP: null,
			WEBTRANSPORT_PACER_QUEUE_MS: null,
			G10_COMPOSITION_SHAS: null,
		});
	});
});
