/**
 * The physical preflight (physical-budget amendment D4): its offer plan, its
 * pass predicate, its receipt, its sampler parsing, and one loopback run of
 * the whole tool against the production lifecycle on this host.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	cohortCellCardinality,
	cohortCellGrantParameters,
} from "../cohort-protocol.ts";
import { R1_CANDIDATE_ID } from "../r1-fixtures.ts";
import {
	CohortLifecycleRetention,
	createRetainedRoleChildFrameSource,
	type StagedCohortMaterialV1,
} from "./compare-controller.ts";
import {
	type CpuSample,
	cpuCoreOverInterval,
	evaluatePreflightPredicate,
	LINUX_SAMPLER_SCRIPT,
	MAIN_THREAD_CORE_BOUND,
	main,
	OPERATOR_LOAD_BOUND,
	PREFLIGHT_CELL_IDS,
	PREFLIGHT_PREDICATES,
	PREFLIGHT_RECEIPT_KEYS,
	PREFLIGHT_RECEIPT_SCHEMA,
	type PreflightFaultCounts,
	type PreflightPredicateInput,
	type PreflightReceiptV1,
	PreflightUsageError,
	parseDarwinPsThreads,
	parseLinuxSamplerBlock,
	parsePreflightArgs,
	parsePreflightReceipt,
	parseProcStatCpuTicks,
	parsePsCpuTime,
	preflightOfferPlan,
	preflightReceiptPath,
} from "./fanout-physical-preflight.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

const NO_FAULTS: PreflightFaultCounts = {
	relayQueueDrops: 0,
	relayWriteTimeouts: 0,
	relayDisconnectUndelivered: 0,
	relayMalformedIngress: 0,
	relayDuplicateIngress: 0,
	relayReorderedIngress: 0,
	workerMalformed: 0,
	workerDuplicate: 0,
	workerReorder: 0,
	workerDisconnect: 0,
};

/** A ticker 2x pass exactly as D4 wants it: 500 per window, everything counted. */
function passingTicker2x(): PreflightPredicateInput {
	const windows = new Array<number>(10).fill(500);
	return {
		pass: "2x",
		windowCount: 10,
		subscriberCount: 100,
		requiredAcceptedPerWindow: 500,
		acceptedPredicate: "at-least",
		offeredByOriginWindow: windows,
		acceptedByOriginWindow: windows,
		deliveredByOriginWindow: windows.map((count) => count * 100),
		expectedWarmupDeliveries: 1_000,
		warmupMacDelivered: 1_000,
		faults: NO_FAULTS,
		preconditionsOk: true,
		preconditionDetail: "",
		lifecycleCompleted: true,
		lifecycleDetail: "",
		measuredMainThreadCore: 0.76,
		warmupMainThreadCore: 0.2,
		warmupCpuCovered: true,
		samplerStderrTail: "",
		samplerPid: 4242,
		capturePid: 4242,
	};
}

function predicatesOf(input: PreflightPredicateInput): string[] {
	return evaluatePreflightPredicate(input).failures.map((f) => f.predicate);
}

describe("preflightOfferPlan: the offer each pass makes", () => {
	it("ticker 1x paces at the cell's own rate and requires exactly 250 per window", () => {
		const plan = preflightOfferPlan("ticker-fanout/rate-250", "1x");
		expect(plan.cohortCell).toBe("ticker 250");
		expect(plan.publisherRatePerSecond).toBe(250);
		expect(plan.pacingSource).toBe("cell");
		expect(plan.preflightPublisherRatePerSecond).toBeNull();
		expect(plan.requiredAcceptedPerWindow).toBe(250);
		expect(plan.acceptedPredicate).toBe("equals");
		expect(plan.rowIngressPerWindow).toBe(250);
		expect(plan.bindingIngressPerWindow).toBe(250);
		expect(plan.expectedWarmupDeliveries).toBe(1_000);
		expect(plan.expectedWarmupIngress).toBe(10);
		expect(plan.windowCount).toBe(10);
	});

	it("ticker 2x paces the one publisher at 500 through the preflight input and requires at least 500", () => {
		const plan = preflightOfferPlan("ticker-fanout/rate-250", "2x");
		expect(plan.publisherRatePerSecond).toBe(500);
		expect(plan.pacingSource).toBe("preflight-input");
		expect(plan.preflightPublisherRatePerSecond).toBe(500);
		expect(plan.requiredAcceptedPerWindow).toBe(500);
		expect(plan.acceptedPredicate).toBe("at-least");
		expect(plan.offeredIngressPerSecond).toBe(500);
	});

	it("chat 1x paces ten publishers at 1/s and requires exactly 10 per window", () => {
		const plan = preflightOfferPlan("chat-fanout/subscribers-1000", "1x");
		expect(plan.publisherRatePerSecond).toBe(1);
		expect(plan.requiredAcceptedPerWindow).toBe(10);
		expect(plan.rowIngressPerWindow).toBe(10);
		expect(plan.bindingIngressPerWindow).toBe(20);
		expect(plan.windowCount).toBe(30);
		expect(plan.expectedWarmupDeliveries).toBe(100_000);
	});

	it("chat 2x is twice the warmup epoch's 20/s, never twice the 10/s row: 4 per publisher, 40 per window", () => {
		const plan = preflightOfferPlan("chat-fanout/subscribers-1000", "2x");
		expect(plan.publisherRatePerSecond).toBe(4);
		expect(plan.preflightPublisherRatePerSecond).toBe(4);
		expect(plan.requiredAcceptedPerWindow).toBe(40);
		expect(plan.acceptedPredicate).toBe("at-least");
	});

	it("only the top row of each ladder is admitted", () => {
		expect([...PREFLIGHT_CELL_IDS]).toEqual([
			"ticker-fanout/rate-250",
			"chat-fanout/subscribers-1000",
		]);
	});
});

describe("evaluatePreflightPredicate: every D4 clause, one failure each", () => {
	it("a complete 2x ticker pass PASSes with no failures", () => {
		const verdict = evaluatePreflightPredicate(passingTicker2x());
		expect(verdict).toEqual({ verdict: "PASS", failures: [] });
	});

	it("an under-offer at 2x (the 1x pacing) fails ACCEPTED_PER_WINDOW in every window even though O = A", () => {
		const windows = new Array<number>(10).fill(250);
		const failures = evaluatePreflightPredicate({
			...passingTicker2x(),
			offeredByOriginWindow: windows,
			acceptedByOriginWindow: windows,
			deliveredByOriginWindow: windows.map((count) => count * 100),
		}).failures;
		expect(failures.map((f) => f.predicate as string)).toEqual(
			new Array<string>(10).fill("ACCEPTED_PER_WINDOW"),
		);
		expect(failures[0]?.detail).toContain("required >= 500");
	});

	it("a front-loaded offer fails the windows it starved", () => {
		const offered = [5_000, 0, 0, 0, 0, 0, 0, 0, 0, 0];
		const failures = evaluatePreflightPredicate({
			...passingTicker2x(),
			offeredByOriginWindow: offered,
			acceptedByOriginWindow: offered,
			deliveredByOriginWindow: offered.map((count) => count * 100),
		}).failures;
		expect(failures).toHaveLength(9);
		expect(failures.every((f) => f.predicate === "ACCEPTED_PER_WINDOW")).toBe(
			true,
		);
	});

	it("the 1x predicate is an equality: 500 accepted per window is not the row's pacing", () => {
		const windows = new Array<number>(10).fill(500);
		const predicates = predicatesOf({
			...passingTicker2x(),
			pass: "1x",
			requiredAcceptedPerWindow: 250,
			acceptedPredicate: "equals",
			offeredByOriginWindow: windows,
			acceptedByOriginWindow: windows,
			deliveredByOriginWindow: windows.map((count) => count * 100),
			measuredMainThreadCore: 0.4,
		});
		expect(predicates).toEqual(
			new Array<string>(10).fill("ACCEPTED_PER_WINDOW"),
		);
	});

	it("a relay that refuses to keep O = A fails OFFERED_EQUALS_ACCEPTED in that window", () => {
		const accepted = [...passingTicker2x().acceptedByOriginWindow];
		accepted[3] = 499;
		const failures = evaluatePreflightPredicate({
			...passingTicker2x(),
			acceptedByOriginWindow: accepted,
			deliveredByOriginWindow: accepted.map((count) => count * 100),
		}).failures;
		expect(failures.map((f) => f.predicate as string)).toEqual([
			"OFFERED_EQUALS_ACCEPTED",
			"ACCEPTED_PER_WINDOW",
		]);
		expect(failures[0]?.detail).toBe("window 3: offered 500, accepted 499");
	});

	it("a delivery the workers did not count fails D = A x K", () => {
		const delivered = [...passingTicker2x().deliveredByOriginWindow];
		delivered[9] = 49_999;
		const failures = evaluatePreflightPredicate({
			...passingTicker2x(),
			deliveredByOriginWindow: delivered,
		}).failures;
		expect(failures).toEqual([
			{
				predicate: "DELIVERED_EQUALS_ACCEPTED_TIMES_K",
				detail:
					"window 9: workers delivered 49999, accepted 500 x K 100 = 50000",
			},
		]);
	});

	it("the warmup epoch's deliveries are owed in full, and an absent manifest is a failure", () => {
		expect(
			predicatesOf({ ...passingTicker2x(), warmupMacDelivered: 999 }),
		).toEqual(["WARMUP_DELIVERIES"]);
		expect(
			predicatesOf({ ...passingTicker2x(), warmupMacDelivered: null }),
		).toEqual(["WARMUP_DELIVERIES"]);
	});

	it("every fault counter is a named ZERO_FAULTS failure", () => {
		for (const name of Object.keys(
			NO_FAULTS,
		) as (keyof PreflightFaultCounts)[]) {
			const failures = evaluatePreflightPredicate({
				...passingTicker2x(),
				faults: { ...NO_FAULTS, [name]: 1 },
			}).failures;
			expect(failures).toEqual([
				{ predicate: "ZERO_FAULTS", detail: `${name} = 1` },
			]);
		}
	});

	it("the main-thread bound is 0.50 at 1x and 0.80 at 2x, on the whole-window mean", () => {
		expect(MAIN_THREAD_CORE_BOUND).toEqual({ "1x": 0.5, "2x": 0.8 });
		expect(
			predicatesOf({ ...passingTicker2x(), measuredMainThreadCore: 0.8 }),
		).toEqual([]);
		expect(
			predicatesOf({ ...passingTicker2x(), measuredMainThreadCore: 0.801 }),
		).toEqual(["MEASURED_MAIN_THREAD_CPU"]);
		const oneX = {
			...passingTicker2x(),
			pass: "1x" as const,
			requiredAcceptedPerWindow: 500,
		};
		expect(predicatesOf({ ...oneX, measuredMainThreadCore: 0.5 })).toEqual([]);
		expect(predicatesOf({ ...oneX, measuredMainThreadCore: 0.501 })).toEqual([
			"MEASURED_MAIN_THREAD_CPU",
		]);
		expect(
			predicatesOf({ ...passingTicker2x(), measuredMainThreadCore: null }),
		).toEqual(["MEASURED_MAIN_THREAD_CPU"]);
	});

	it("the warmup epoch's main thread is gated at 1x only, and needs a covered series there", () => {
		const oneX = {
			...passingTicker2x(),
			pass: "1x" as const,
			requiredAcceptedPerWindow: 500,
			measuredMainThreadCore: 0.4,
		};
		expect(predicatesOf({ ...oneX, warmupMainThreadCore: 0.51 })).toEqual([
			"WARMUP_MAIN_THREAD_CPU",
		]);
		expect(predicatesOf({ ...oneX, warmupMainThreadCore: null })).toEqual([
			"WARMUP_MAIN_THREAD_CPU",
		]);
		expect(predicatesOf({ ...oneX, warmupCpuCovered: false })).toEqual([
			"CPU_SERIES_COVERED",
		]);
		expect(
			predicatesOf({
				...passingTicker2x(),
				warmupMainThreadCore: 0.99,
				warmupCpuCovered: false,
			}),
		).toEqual([]);
	});

	it("the sampled pid must be the pid the capture names", () => {
		expect(predicatesOf({ ...passingTicker2x(), capturePid: 4243 })).toEqual([
			"SERVER_CHILD_PID_MATCH",
		]);
		expect(predicatesOf({ ...passingTicker2x(), samplerPid: null })).toEqual([
			"SERVER_CHILD_PID_MATCH",
		]);
	});

	it("an incomplete lifecycle fails by name and reports the count clauses as absent, never as zeros", () => {
		const failures = evaluatePreflightPredicate({
			...passingTicker2x(),
			lifecycleCompleted: false,
			lifecycleDetail: "COHORT_PROTOCOL: worker 3 exited",
			offeredByOriginWindow: [],
			acceptedByOriginWindow: [],
			deliveredByOriginWindow: [],
		}).failures;
		expect(failures.map((f) => f.predicate as string)).toEqual([
			"LIFECYCLE_COMPLETE",
			"OFFERED_EQUALS_ACCEPTED",
			"ACCEPTED_PER_WINDOW",
			"DELIVERED_EQUALS_ACCEPTED_TIMES_K",
		]);
		expect(failures[0]?.detail).toBe("COHORT_PROTOCOL: worker 3 exited");
	});

	it("a failed operator precondition is its own failure", () => {
		expect(
			predicatesOf({
				...passingTicker2x(),
				preconditionsOk: false,
				preconditionDetail: "rig load 0.9 >= 0.5",
			}),
		).toEqual(["OPERATOR_PRECONDITION"]);
		expect(OPERATOR_LOAD_BOUND).toEqual({ mac: 4, rig: 0.5 });
	});

	it("every failure names a predicate from the closed set", () => {
		const everything = evaluatePreflightPredicate({
			...passingTicker2x(),
			pass: "1x",
			preconditionsOk: false,
			preconditionDetail: "x",
			lifecycleCompleted: false,
			lifecycleDetail: "y",
			offeredByOriginWindow: [],
			acceptedByOriginWindow: [],
			deliveredByOriginWindow: [],
			warmupMacDelivered: null,
			faults: { ...NO_FAULTS, workerMalformed: 1 },
			measuredMainThreadCore: null,
			warmupMainThreadCore: null,
			warmupCpuCovered: false,
			samplerStderrTail: "",
			samplerPid: null,
		});
		expect(everything.verdict).toBe("FAIL");
		expect(new Set(everything.failures.map((f) => f.predicate))).toEqual(
			new Set(PREFLIGHT_PREDICATES),
		);
	});
});

function syntheticReceipt(): PreflightReceiptV1 {
	const windows = new Array<number>(10).fill(500);
	const cpu = (instrument: string) => ({
		instrument,
		processMs: 9_000,
		mainThreadMs: 7_600,
		intervalMs: 10_000,
		processCore: 0.9,
		mainThreadCore: 0.76,
		bound: 0.8,
		sampleCount: 2,
		covered: true,
	});
	return {
		schema: PREFLIGHT_RECEIPT_SCHEMA,
		candidate: "a".repeat(40),
		campaignId: "fanout-pilot-r1",
		mode: "physical",
		transport: "wt",
		cellId: "ticker-fanout/rate-250",
		cohortCell: "ticker 250",
		pass: "2x",
		runId: "fanout-pilot-r1/ticker-fanout/rate-250/wt/measured-1",
		generatedAtMs: 1,
		macClockId: "m".repeat(64),
		topology: {
			publisherCount: 1,
			workerCount: 8,
			subscriberCount: 100,
			sessionCount: 101,
			windowCount: 10,
			measuredDurationMs: 10_000,
			messageBytes: 100,
		},
		offer: {
			pacingSource: "preflight-input",
			publisherRatePerSecond: 500,
			offeredIngressPerSecond: 500,
			rowIngressPerWindow: 250,
			bindingIngressPerWindow: 250,
			requiredAcceptedPerWindow: 500,
			acceptedPredicate: "at-least",
		},
		preconditions: {
			macLoad1: 1.2,
			macLoadBound: 4,
			rigLoad1: 0.1,
			rigLoadBound: 0.5,
			rigIsThisHost: false,
			enforced: true,
			failures: [],
			ok: true,
		},
		lifecycle: {
			completed: true,
			dispatchOk: false,
			failureCode: "TRUST_PROTOCOL",
			reason: "expectedOfferedIngress 2500 != 5000",
			sealedPath: null,
		},
		windows: {
			note: "origin-window counts",
			offeredByOriginWindow: windows,
			acceptedByOriginWindow: windows,
			deliveredByOriginWindow: windows.map((c) => c * 100),
			relayWritesCompletedByOriginWindow: windows.map((c) => c * 100),
		},
		totals: {
			offered: 5_000,
			accepted: 5_000,
			delivered: 500_000,
			deliveredBytes: 50_000_000,
			expectedDelivered: 500_000,
			ingressRefusals: 0,
		},
		warmup: {
			epochMs: 5_000,
			expectedIngress: 10,
			expectedDeliveries: 1_000,
			macOffered: 10,
			macDelivered: 1_000,
			relayIngress: 10,
			relayDeliveries: 1_000,
		},
		faults: NO_FAULTS,
		queue: {
			relayQueueItemsPeak: 40,
			relayQueueBytesPeak: 4_960,
			perSubscriberCap: 64,
			note: "relay-wide peak",
		},
		relayBusy: {
			instrument: "onRelayWork spans",
			busyMs: 4_100,
			windowMs: 10_000,
			fraction: 0.41,
		},
		serverChildCpu: {
			measured: cpu("rig supervisor serverChildCpu"),
			warmup: { ...cpu("preflight sampler"), bound: null },
			perSecondNote: "wall-clock seconds",
			perSecondMainThreadCore: new Array<number>(10).fill(0.76),
			perSecondMainThreadCoreMax: 0.76,
			sampler: {
				instrument: "preflight sampler",
				cadenceMs: 200,
				sampleCount: 300,
				stderrTail: "",
				pid: 4242,
				capturePid: 4242,
				pidMatchesCapture: true,
			},
		},
		rig: {
			coreMhz: {
				warmupStart: [2100, 2466.6],
				warmupEnd: [3700, 2466.6],
				measureStart: [3700, 2466.6],
				measureStop: [3664.7, 2466.6],
			},
			rssKb: { warmupStart: 90_000, measureStop: 120_000, peak: 121_000 },
			nofile: { soft: 524_288, hard: 524_288 },
		},
		mac: {
			load1AtStart: 1.2,
			load1Peak: 3.1,
			workers: [
				{
					childId: "worker-0",
					workerIndex: 0,
					pid: 100,
					cpuMsOverMeasuredWindow: 1_200,
					cpuCore: 0.12,
				},
			],
		},
		verdict: "PASS",
		failedPredicates: [],
	};
}

describe("parsePreflightReceipt: the D4 receipt's closed shape", () => {
	it("accepts a complete receipt and names its keys once", () => {
		const parsed = parsePreflightReceipt(syntheticReceipt());
		expect(parsed.ok).toBe(true);
		expect([...PREFLIGHT_RECEIPT_KEYS]).toEqual(
			Object.keys(syntheticReceipt()).sort(),
		);
	});

	it("refuses an extra key, a missing key and the wrong schema", () => {
		const extra = { ...syntheticReceipt(), note: "x" };
		expect(parsePreflightReceipt(extra).ok).toBe(false);
		const { rig: _rig, ...missing } = syntheticReceipt();
		expect(parsePreflightReceipt(missing).ok).toBe(false);
		expect(
			parsePreflightReceipt({ ...syntheticReceipt(), schema: "x/v1" }).ok,
		).toBe(false);
	});

	it("refuses a verdict that disagrees with its failure list, and an unknown predicate", () => {
		expect(
			parsePreflightReceipt({ ...syntheticReceipt(), verdict: "FAIL" }).ok,
		).toBe(false);
		expect(
			parsePreflightReceipt({
				...syntheticReceipt(),
				failedPredicates: [{ predicate: "ZERO_FAULTS", detail: "x" }],
			}).ok,
		).toBe(false);
		expect(
			parsePreflightReceipt({
				...syntheticReceipt(),
				verdict: "FAIL",
				failedPredicates: [{ predicate: "SOMETHING_ELSE", detail: "x" }],
			}).ok,
		).toBe(false);
		const failed = parsePreflightReceipt({
			...syntheticReceipt(),
			verdict: "FAIL",
			failedPredicates: [{ predicate: "ZERO_FAULTS", detail: "x" }],
		});
		expect(failed.ok).toBe(true);
	});

	it("refuses origin-window series that are not the cell's length, and an offer that is not the pass's plan", () => {
		const short = syntheticReceipt();
		expect(
			parsePreflightReceipt({
				...short,
				windows: { ...short.windows, acceptedByOriginWindow: [500] },
			}).ok,
		).toBe(false);
		expect(
			parsePreflightReceipt({
				...short,
				offer: { ...short.offer, requiredAcceptedPerWindow: 250 },
			}).ok,
		).toBe(false);
		expect(
			parsePreflightReceipt({
				...short,
				offer: { ...short.offer, pacingSource: "cell" },
			}).ok,
		).toBe(false);
	});

	it("refuses an instrument that is not named", () => {
		const receipt = syntheticReceipt();
		expect(
			parsePreflightReceipt({
				...receipt,
				serverChildCpu: {
					...receipt.serverChildCpu,
					measured: { ...receipt.serverChildCpu.measured, instrument: 7 },
				},
			}).ok,
		).toBe(false);
	});

	it("lands at <out>/<candidate>/<transport>-<cell>-<pass>.json", () => {
		expect(
			preflightReceiptPath({
				outDir: "/evidence/preflight",
				candidate: "abc",
				transport: "wt",
				cellId: "chat-fanout/subscribers-1000",
				pass: "1x",
			}),
		).toBe("/evidence/preflight/abc/wt-chat-fanout_subscribers-1000-1x.json");
	});
});

describe("the sampler's parsing and integration", () => {
	it("reads utime + stime off a /proc stat line whose comm carries spaces and parentheses", () => {
		const line =
			"4242 (bun (x) y) S 1 4242 4242 0 -1 4194304 100 0 0 0 1234 56 0 0 20 0 9 0 1000 500000 300 18446744073709551615";
		expect(parseProcStatCpuTicks(line)).toBe(1_290);
		expect(parseProcStatCpuTicks("garbage")).toBeNull();
	});

	it("reads ps cputime in its three shapes", () => {
		expect(parsePsCpuTime("0:01.23")).toBe(1_230);
		expect(parsePsCpuTime("1:02:03")).toBe(3_723_000);
		expect(parsePsCpuTime("2-00:00:01.5")).toBe(172_801_500);
		expect(parsePsCpuTime("nope")).toBeNull();
	});

	it("reads ps -M on darwin: the first thread line is the main thread, the process is the sum", () => {
		const text = [
			"USER        PID   TT   %CPU STAT PRI     STIME     UTIME COMMAND",
			"me        99134   ??    0.0 S    31T   0:00.10   0:00.20 bun server.ts --mode=fanout-cohort",
			"          99134         0.0 S    31T   0:00.01   0:00.02 ",
			"          99134         0.0 S    31T   0:01.00   0:02.00 ",
		].join("\n");
		expect(parseDarwinPsThreads(text)).toEqual({
			mainThreadMs: 300,
			processMs: 3_330,
		});
		expect(parseDarwinPsThreads("USER PID\n")).toBeNull();
	});

	it("turns one tagged block from the Linux script into a sample in milliseconds", () => {
		const block = [
			"P 7 (bun) S 1 7 7 0 -1 0 0 0 0 0 300 100 0 0 20 0 9 0 1 1 1 1",
			"M 7 (bun) S 1 7 7 0 -1 0 0 0 0 0 150 50 0 0 20 0 1 0 1 1 1 1",
			"R 123456",
			"L 0.42",
			"F 2100.0,3700.1",
		];
		expect(parseLinuxSamplerBlock(block, 100, 5n)).toEqual({
			atMacNs: 5n,
			processMs: 4_000,
			mainThreadMs: 2_000,
			rssKb: 123_456,
			load1: 0.42,
			coreMhz: [2_100, 3_700.1],
		});
		expect(parseLinuxSamplerBlock(["R 1"], 100, 5n)).toBeNull();
		expect(LINUX_SAMPLER_SCRIPT).toContain("/proc/$pid/task/$pid/stat");
		expect(LINUX_SAMPLER_SCRIPT).toContain("/proc/$pid/limits");
		expect(LINUX_SAMPLER_SCRIPT).toContain("cpu MHz");
	});

	it("keeps the sampler alive by /proc, never by a signal probe it is not allowed to send", () => {
		// The sampler runs as the ssh account against the supervisor account's
		// child; `kill -0` answers EPERM there and the loop would never run.
		expect(LINUX_SAMPLER_SCRIPT).toContain('while [ -d "/proc/$pid" ]; do');
		expect(LINUX_SAMPLER_SCRIPT).not.toContain("kill -0");
	});

	it("quotes what the sampler said on stderr when it produced no warmup reading", () => {
		const failures = evaluatePreflightPredicate({
			...passingTicker2x(),
			pass: "1x",
			measuredMainThreadCore: 0.4,
			warmupMainThreadCore: null,
			warmupCpuCovered: false,
			samplerStderrTail:
				"bash: line 7: kill: (4242) - Operation not permitted\n",
		}).failures;
		const covered = failures.find((f) => f.predicate === "CPU_SERIES_COVERED");
		const warmup = failures.find(
			(f) => f.predicate === "WARMUP_MAIN_THREAD_CPU",
		);
		expect(covered?.detail).toContain("Operation not permitted");
		expect(warmup?.detail).toContain("Operation not permitted");
	});

	it("integrates a cumulative series to exact boundaries and reports coverage", () => {
		const samples: CpuSample[] = [0, 1, 2, 3, 4, 5].map((second) => ({
			atMacNs: BigInt(second) * 1_000_000_000n,
			processMs: second * 900,
			mainThreadMs: second * 500,
			rssKb: 100 + second,
			load1: 0.1,
			coreMhz: null,
		}));
		const over = cpuCoreOverInterval(
			samples,
			500_000_000n,
			4_500_000_000n,
			100_000_000n,
		);
		expect(over.covered).toBe(true);
		expect(over.intervalMs).toBe(4_000);
		expect(over.mainThreadCore).toBeCloseTo(0.5, 6);
		expect(over.processCore).toBeCloseTo(0.9, 6);
		expect(over.sampleCount).toBe(4);
		const late = cpuCoreOverInterval(
			samples,
			-2_000_000_000n,
			4_000_000_000n,
			100_000_000n,
		);
		expect(late.covered).toBe(false);
		expect(
			cpuCoreOverInterval([], 0n, 1_000_000_000n, 100_000_000n).mainThreadCore,
		).toBeNull();
	});
});

describe("parsePreflightArgs", () => {
	it("needs the physical inputs, or --loopback without them", () => {
		expect(() =>
			parsePreflightArgs([
				"--transport",
				"ws",
				"--cell",
				"ticker-fanout/rate-250",
				"--pass",
				"1x",
				"--out",
				"/tmp/x",
			]),
		).toThrow(PreflightUsageError);
		const physical = parsePreflightArgs([
			"--transport=wt",
			"--cell=chat-fanout/subscribers-1000",
			"--pass=2x",
			"--out=/tmp/x",
			"--rig=hermes-admin@10.99.0.2",
			"--ssh-key=/k",
			`--candidate=${"b".repeat(40)}`,
			"--staged-dir=/s",
		]);
		expect(physical.loopback).toBe(false);
		expect(physical.rig).toBe("hermes-admin@10.99.0.2");
		expect(physical.pass).toBe("2x");
		expect(() =>
			parsePreflightArgs([
				"--transport",
				"ws",
				"--cell",
				"ticker-fanout/rate-250",
				"--pass",
				"1x",
				"--out",
				"/tmp/x",
				"--loopback",
				"--rig",
				"a@b",
			]),
		).toThrow(/--loopback/);
		expect(() =>
			parsePreflightArgs([
				"--transport",
				"ws",
				"--cell",
				"ticker-fanout/rate-50",
			]),
		).toThrow(/--cell/);
		expect(() => parsePreflightArgs(["--bogus"])).toThrow(/unknown flag/);
	});

	it("--ignore-load is refused outside --loopback", () => {
		const physical = [
			"--transport=wt",
			"--cell=chat-fanout/subscribers-1000",
			"--pass=2x",
			"--out=/tmp/x",
			"--rig=hermes-admin@10.99.0.2",
			"--ssh-key=/k",
			`--candidate=${"b".repeat(40)}`,
			"--staged-dir=/s",
		];
		expect(() => parsePreflightArgs([...physical, "--ignore-load"])).toThrow(
			/--ignore-load/,
		);
		expect(parsePreflightArgs([...physical]).ignoreLoad).toBe(false);
		expect(
			parsePreflightArgs([
				"--transport=ws",
				"--cell=ticker-fanout/rate-250",
				"--pass=1x",
				"--out=/tmp/x",
				"--loopback",
				"--ignore-load",
			]).ignoreLoad,
		).toBe(true);
	});
});

describe("the preflight is not on the frozen path", () => {
	it("neither the controller, the stage tool, nor any frozen fragment names it, and the allowlist classes it as a CLI entry only", () => {
		const compare = join(REPO_ROOT, "tools", "compare");
		for (const file of [
			"bin/compare-controller.ts",
			"bin/stage-live-campaign.ts",
			"bin/frozen-run-wrapper.fragment.sh",
			"bin/frozen-run-section-9.5.fragment.sh",
			"bin/frozen-run-section-9.6.fragment.sh",
			"bin/frozen-run-section-9.7.fragment.sh",
			"server.ts",
			"bin/fanout-role.ts",
		]) {
			expect(readFileSync(join(compare, file), "utf8")).not.toContain(
				"fanout-physical-preflight",
			);
		}
		const allowlist = JSON.parse(
			readFileSync(join(compare, "official-io-allowlist.json"), "utf8"),
		) as Record<string, unknown>;
		for (const [className, entries] of Object.entries(allowlist)) {
			if (!Array.isArray(entries)) continue;
			const named = entries.includes("bin/fanout-physical-preflight.ts");
			expect(named).toBe(className === "cliEntryTs");
		}
	});
});

describe("the lease factory's preflight pacing input", () => {
	function frameSourceWith(override: number | undefined) {
		const retention = new CohortLifecycleRetention();
		retention.grant = {
			record: {} as never,
			bytes: new Uint8Array([1, 2, 3]),
			signatureBytes: new Uint8Array([4]),
			signatureRaw64: new Uint8Array(64),
			sha256: "a".repeat(64),
		};
		const plan = {
			childId: "publisher-0",
			role: "publisher" as const,
			publisherId: "p0",
			workerIndex: null,
			assignedGlobalOrdinals: [0],
			assignedRoleIds: ["p0"],
			controlReadFd: 3 as const,
			controlWriteFd: 4 as const,
			tokenBundleFd: 5 as const,
		};
		const staged = {
			stagedServerLaunchRecords: {
				ws: {
					"fanout-cohort": {
						bytes: new Uint8Array([9]),
						sha256: "b".repeat(64),
						record: {
							advertisedHost: "127.0.0.1",
							tlsServerName: "wt-compare.local",
						},
					},
				},
				wt: {},
			},
			stagedMacPublicRaw32: new Uint8Array(32),
			receipt: {
				macSigningPublicKeySha256: "c".repeat(64),
				stageProfile: "local-acceptance",
			},
		} as unknown as StagedCohortMaterialV1;
		const frames = createRetainedRoleChildFrameSource({
			retention,
			executionSha256: "d".repeat(64),
			workloadRolePlanInputBytes: new Uint8Array([1]),
			staged,
			transport: "ws",
			serverPort: 44_100,
			cell: cohortCellCardinality("ticker 250"),
			grantParameters: cohortCellGrantParameters("ticker 250"),
			childStateFor: () => ({
				plan,
				pid: 1,
				pgid: 1,
				instanceNonce: "e".repeat(64),
				tokenBundleSha256: "f".repeat(64),
				tokenBundleSize: 1,
				tokenBundleEntryCount: 1,
				spawnedAtMacNs: "0",
				readyAtMacNs: null,
				warmupCompleteAtMacNs: null,
				measureArmedAtMacNs: null,
				stoppedAtMacNs: null,
				partialSha256: null,
				exitCode: null,
			}),
			clock: { nowNs: () => "0" },
			...(override !== undefined
				? { preflightPublisherRatePerSecond: override }
				: {}),
		});
		const config = frames.spawnConfigFor(plan);
		if (!config.ok) throw new Error(config.message);
		return config.value as unknown as { readonly messageRatePerSecond: number };
	}

	it("without the input the child is paced at the cell's rate; with it, at the preflight's", () => {
		expect(frameSourceWith(undefined).messageRatePerSecond).toBe(250);
		expect(frameSourceWith(500).messageRatePerSecond).toBe(500);
	});

	it("refuses a rate that is not a whole positive number", () => {
		expect(() => frameSourceWith(0)).toThrow(RangeError);
		expect(() => frameSourceWith(2.5)).toThrow(RangeError);
	});
});

/**
 * The tool, end to end, on this host: the local acceptance pair, the real
 * supervisors, the real server child and role children, the 2x ticker pass,
 * whose count predicate is the only proof the publisher was paced at 500/s.
 */
describe("fanout-physical-preflight --loopback", () => {
	it("runs the ticker 2x pass through the production lifecycle and writes a receipt that parses", async () => {
		const built = Bun.spawnSync({
			cmd: [
				"cargo",
				"build",
				"-p",
				"native",
				"--release",
				"--bin",
				"comparison-supervisor",
				"--bin",
				"observe-directory-identity",
			],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		if (built.exitCode !== 0) {
			throw new Error(
				`cargo build failed: ${built.stderr.toString().slice(-2000)}`,
			);
		}
		const supervisor = join(
			REPO_ROOT,
			"target",
			"release",
			"comparison-supervisor",
		);
		const out = mkdtempSync(join(tmpdir(), "fanout-preflight-out-"));
		try {
			const code = await main([
				"--transport",
				"ws",
				"--cell",
				"ticker-fanout/rate-250",
				"--pass",
				"2x",
				"--out",
				out,
				"--loopback",
				"--ignore-load",
				"--supervisor-binary",
				supervisor,
			]);
			const path = preflightReceiptPath({
				outDir: out,
				candidate: R1_CANDIDATE_ID,
				transport: "ws",
				cellId: "ticker-fanout/rate-250",
				pass: "2x",
			});
			const receiptJson = JSON.parse(readFileSync(path, "utf8")) as unknown;
			const parsed = parsePreflightReceipt(receiptJson);
			if (!parsed.ok) throw new Error(parsed.message);
			const receipt = parsed.value;
			expect(receipt.mode).toBe("loopback");
			expect(receipt.preconditions.enforced).toBe(false);
			expect(receipt.offer.pacingSource).toBe("preflight-input");
			expect(receipt.offer.publisherRatePerSecond).toBe(500);
			expect(receipt.lifecycle.completed).toBe(true);
			expect(receipt.windows.offeredByOriginWindow).toEqual(
				new Array<number>(10).fill(500),
			);
			expect(receipt.windows.acceptedByOriginWindow).toEqual(
				new Array<number>(10).fill(500),
			);
			expect(receipt.windows.deliveredByOriginWindow).toEqual(
				new Array<number>(10).fill(50_000),
			);
			expect(receipt.totals.delivered).toBe(500_000);
			expect(receipt.warmup.macDelivered).toBe(1_000);
			expect(receipt.warmup.relayDeliveries).toBe(1_000);
			expect(receipt.faults).toEqual(NO_FAULTS);
			expect(receipt.serverChildCpu.measured.instrument).toContain("libproc");
			expect(receipt.serverChildCpu.measured.mainThreadCore).not.toBeNull();
			expect(receipt.serverChildCpu.sampler.instrument).toContain("ps -M");
			expect(receipt.serverChildCpu.sampler.pidMatchesCapture).toBe(true);
			expect(receipt.serverChildCpu.sampler.sampleCount).toBeGreaterThan(20);
			expect(receipt.serverChildCpu.warmup.covered).toBe(true);
			expect(receipt.relayBusy.busyMs).not.toBeNull();
			expect(receipt.mac.workers).toHaveLength(8);
			expect(receipt.verdict).toBe("PASS");
			expect(code).toBe(0);
		} finally {
			rmSync(out, { recursive: true, force: true });
		}
	}, 900_000);
});
