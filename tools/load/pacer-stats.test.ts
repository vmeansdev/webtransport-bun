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

/**
 * What `stats_json` actually emits, key for key: config scalars at the top, the
 * counters nested under `cumulative` beside a since-process-start maximum whose
 * name says so, a `priority` object, and a token-relative `window`.
 *
 * The flat `FULL` fixture above is the pre-rename shape and no live server
 * produces it any more. It stays because `readPacerStats` still tolerates an
 * older addon, but a test that only feeds it is a test against a schema that
 * does not exist — which is how a difference of maxima reached `windowed`
 * unnoticed.
 */
function nativeStats(over: Record<string, number> = {}) {
	return {
		pps: 75000,
		clump: 32,
		queueMs: 250,
		maxPendingTargets: 18750,
		pendingTargets: 7,
		priority: { requested: "rr:50", applied: false, knobMalformed: false },
		cumulative: {
			submits: 10,
			admittedTargets: 1000,
			refusedTargets: 3,
			clumps: 40,
			lateClumps: 2,
			scheduleResets: 1,
			deferredFailures: 0,
			threadStarts: 1,
			threadStartFailures: 0,
			maxLatenessUsSinceProcessStart: 900,
			...over,
		},
		window: null,
	};
}

/** The native shape as `readPacerStats` hands it on: flattened, numbers only. */
function nativeRead(over: Record<string, number> = {}) {
	const raw = readPacerStats({
		__pacerStatsJson: () => JSON.stringify(nativeStats(over)),
	});
	if (raw === null) throw new Error("fixture did not parse");
	return raw;
}

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

	test("a pre-rename addon's maxLatenessUs is still carried, not differenced", () => {
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
});

describe("windowPacerStats on the shape the native side actually emits", () => {
	test("the nested counters difference and the config travels whole", () => {
		const report = windowPacerStats(
			nativeRead(),
			nativeRead({ submits: 30, clumps: 140, lateClumps: 9 }),
		);
		expect(report?.windowed).toMatchObject({
			submits: 20,
			clumps: 100,
			lateClumps: 7,
			refusedTargets: 0,
		});
		expect(report?.config).toEqual({
			pps: 75000,
			clump: 32,
			queueMs: 250,
			maxPendingTargets: 18750,
		});
	});

	test("the lateness maximum is carried under its real name", () => {
		const report = windowPacerStats(
			nativeRead(),
			nativeRead({ maxLatenessUsSinceProcessStart: 5000 }),
		);
		expect(report?.sinceProcessStart).toEqual({
			maxLatenessUsSinceProcessStart: 5000,
			pendingTargets: 7,
		});
	});

	test("no maximum reaches windowed, under any name", () => {
		// The failure this pins: `windowed.maxLatenessUsSinceProcessStart =
		// close - open`. A rung whose worst lateness predated its window reported
		// 0 and read as perfectly paced; one inheriting a high open value reported
		// an earlier rung's number.
		const report = windowPacerStats(
			nativeRead({ maxLatenessUsSinceProcessStart: 900 }),
			nativeRead({ maxLatenessUsSinceProcessStart: 900 }),
		);
		expect(report?.windowed.maxLatenessUsSinceProcessStart).toBeUndefined();
		expect(report?.windowed.maxPendingTargets).toBeUndefined();
		for (const key of Object.keys(report?.windowed ?? {})) {
			expect(key).not.toMatch(/max/i);
		}
	});

	test("an unrecognised maximum is named rather than differenced", () => {
		const open = { ...nativeRead(), maxQueueDepth: 4 };
		const close = { ...nativeRead(), maxQueueDepth: 900 };
		const report = windowPacerStats(open, close);
		expect(report?.windowed.maxQueueDepth).toBeUndefined();
		expect(report?.refusedDifferencing).toEqual(["maxQueueDepth"]);
	});

	test("a clean window names nothing as refused", () => {
		expect(
			windowPacerStats(nativeRead(), nativeRead())?.refusedDifferencing,
		).toBeUndefined();
	});

	test("a future SinceProcessStart field is carried without being taught", () => {
		const open = { ...nativeRead(), sleepSkewUsSinceProcessStart: 3 };
		const close = { ...nativeRead(), sleepSkewUsSinceProcessStart: 11 };
		const report = windowPacerStats(open, close);
		expect(report?.sinceProcessStart.sleepSkewUsSinceProcessStart).toBe(11);
		expect(report?.windowed.sleepSkewUsSinceProcessStart).toBeUndefined();
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
