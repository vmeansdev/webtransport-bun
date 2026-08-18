import { describe, expect, test } from "bun:test";
import {
	type ArmSummary,
	armKey,
	classifyCc,
	classifyCoresplit,
	classifyOffbox,
	classifyRmem,
	classifyWaitVsDrop,
	collapseFor,
	generatorLimitedRates,
	proofFailures,
} from "./worker-load-sweep.ts";
import { formatGapLine } from "./worker-thread-parallelism-probe.ts";

function arm(over: Partial<ArmSummary> = {}): ArmSummary {
	const base: ArmSummary = {
		key: "w1@20000",
		workers: "1",
		requestedPerSec: 20_000,
		offeredPerSec: 19_800,
		deliveredPerSec: 19_700,
		ingestedPerSec: 19_750,
		droppedPct: 0,
		droppedTooLarge: 0,
		droppedQueueSession: 0,
		droppedQueueGlobal: 0,
		droppedRateLimited: 0,
		processCores: 1.1,
		tokioCores: 0.6,
		jsCores: 0.3,
		datagramThreads: 1,
		configuredWorkers: 1,
		requestMet: true,
		runs: [],
	};
	const merged = { ...base, ...over };
	return { ...merged, key: armKey(merged) };
}

describe("collapseFor", () => {
	test("delivered falling by more than half beyond the peak is a collapse", () => {
		const summaries = [
			arm({
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 20_000,
			}),
			arm({
				requestedPerSec: 80_000,
				offeredPerSec: 80_000,
				deliveredPerSec: 78_000,
			}),
			arm({
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 5_000,
			}),
		];
		const result = collapseFor(summaries, "1");
		expect(result.collapsed).toBe(true);
		expect(result.peakPerSec).toBe(78_000);
		expect(result.worstPerSec).toBe(5_000);
	});

	test("a plateau is not a collapse", () => {
		const summaries = [
			arm({
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 20_000,
			}),
			arm({
				requestedPerSec: 80_000,
				offeredPerSec: 80_000,
				deliveredPerSec: 60_000,
			}),
			arm({
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 61_000,
			}),
		];
		expect(collapseFor(summaries, "1").collapsed).toBe(false);
	});

	test("a modest fall-off short of half is not called a collapse", () => {
		const summaries = [
			arm({
				requestedPerSec: 80_000,
				offeredPerSec: 80_000,
				deliveredPerSec: 60_000,
			}),
			arm({
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 40_000,
			}),
		];
		expect(collapseFor(summaries, "1").collapsed).toBe(false);
	});

	test("only rungs offered more than the peak can show a fall-off", () => {
		// Highest delivered is also the highest offered: nothing beyond it.
		const summaries = [
			arm({
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 5_000,
			}),
			arm({
				requestedPerSec: 80_000,
				offeredPerSec: 80_000,
				deliveredPerSec: 79_000,
			}),
		];
		expect(collapseFor(summaries, "1").collapsed).toBe(false);
	});

	test("separates worker counts", () => {
		const summaries = [
			arm({
				workers: "1",
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 20_000,
			}),
			arm({
				workers: "1",
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 2_000,
			}),
			arm({
				workers: "2",
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				deliveredPerSec: 20_000,
			}),
			arm({
				workers: "2",
				requestedPerSec: 160_000,
				offeredPerSec: 158_000,
				deliveredPerSec: 155_000,
			}),
		];
		expect(collapseFor(summaries, "1").collapsed).toBe(true);
		expect(collapseFor(summaries, "2").collapsed).toBe(false);
	});
});

describe("generatorLimitedRates", () => {
	test("flags a rung whose offered load is pinned and short of the request", () => {
		const summaries = [
			arm({
				workers: "1",
				requestedPerSec: 160_000,
				offeredPerSec: 65_200,
				requestMet: false,
			}),
			arm({
				workers: "2",
				requestedPerSec: 160_000,
				offeredPerSec: 65_400,
				requestMet: false,
			}),
		];
		expect(generatorLimitedRates(summaries)).toEqual([160_000]);
	});

	test("does not flag a rung whose request was met", () => {
		const summaries = [
			arm({
				workers: "1",
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				requestMet: true,
			}),
			arm({
				workers: "2",
				requestedPerSec: 20_000,
				offeredPerSec: 20_000,
				requestMet: true,
			}),
		];
		expect(generatorLimitedRates(summaries)).toEqual([]);
	});

	test("does not flag when offered load differs by worker count", () => {
		// The server is influencing what the sender achieves, so the shortfall is
		// not simply the generator's own ceiling.
		const summaries = [
			arm({
				workers: "1",
				requestedPerSec: 160_000,
				offeredPerSec: 70_000,
				requestMet: false,
			}),
			arm({
				workers: "2",
				requestedPerSec: 160_000,
				offeredPerSec: 140_000,
				requestMet: false,
			}),
		];
		expect(generatorLimitedRates(summaries)).toEqual([]);
	});
});

describe("gap print", () => {
	test("omitted UDP rcvbuf prints n/a, not 0", () => {
		expect(
			formatGapLine({
				windowOfferedPerSec: null,
				ingestedPerSec: 99_000,
				packetsLostDelta: null,
				packetsReceivedDelta: null,
				udpInErrorsDelta: null,
				udpRcvbufErrorsDelta: null,
				frameTxDatagramPerSec: null,
				udpTxPerSec: null,
				unexplainedPerSec: 48_000,
				stopBucket: "unexplained",
			}),
		).toBe(
			"gap: windowOffered=n/a ingest=99000 frameTx=n/a udpTx=n/a lost=n/a rcvbuf=n/a unexplained=48000 STOP=unexplained",
		);
	});
});

describe("proofFailures", () => {
	test("a matching arm passes", () => {
		expect(proofFailures([arm()])).toEqual([]);
		expect(
			proofFailures([
				arm({ workers: "2", configuredWorkers: 2, datagramThreads: 2 }),
			]),
		).toEqual([]);
	});

	test("catches a two-worker arm whose load landed on one thread", () => {
		const failures = proofFailures([
			arm({ workers: "2", configuredWorkers: 2, datagramThreads: 1 }),
		]);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toContain("one OS thread");
	});

	test("catches the runtime ignoring the requested worker count", () => {
		const failures = proofFailures([
			arm({ workers: "2", configuredWorkers: 1 }),
		]);
		expect(failures.some((f) => f.includes("expected 2"))).toBe(true);
	});

	test("catches a non-finite delivered rate", () => {
		const failures = proofFailures([arm({ deliveredPerSec: Number.NaN })]);
		expect(failures.some((f) => f.includes("non-finite"))).toBe(true);
	});

	test("refuses when the addon has no worker probe", () => {
		expect(proofFailures([arm({ configuredWorkers: null })])[0]).toContain(
			"no worker-probe snapshot",
		);
	});
});

function withFrameTx(
	key: string,
	frameTxDatagramPerSec: number,
	offeredPerSec: number,
	skRcvbuf: number | null = 212_992,
): ArmSummary {
	return {
		...arm({
			workers: "2",
			requestedPerSec: 160_000,
			offeredPerSec,
			configuredWorkers: 2,
			datagramThreads: 2,
		}),
		key,
		runs: [
			{
				key,
				workers: "2",
				requestedPerSec: 160_000,
				round: 1,
				offeredPerSec,
				deliveredPerSec: frameTxDatagramPerSec,
				ingestedPerSec: frameTxDatagramPerSec,
				droppedPct: 0,
				rateLimited: 0,
				droppedTooLarge: 0,
				droppedQueueSession: 0,
				droppedQueueGlobal: 0,
				droppedRateLimited: 0,
				processCores: 2,
				tokioCores: 1,
				jsCores: 0.5,
				datagramThreads: 2,
				configuredWorkers: 2,
				sessionsOk: 100,
				clientSendErrors: 0,
				threads: [],
				gap: {
					windowOfferedPerSec: offeredPerSec,
					ingestedPerSec: frameTxDatagramPerSec,
					packetsLostDelta: 0,
					packetsReceivedDelta: 0,
					udpInErrorsDelta: 0,
					udpRcvbufErrorsDelta: 0,
					frameTxDatagramPerSec,
					udpTxPerSec: frameTxDatagramPerSec,
					unexplainedPerSec: 0,
					stopBucket: "unexplained",
				},
				pipeCap: null,
				clientTaskset: "",
				clientCpusAllowed: [],
				clientAffinityOk: true,
				skRcvbuf,
				skDrops: 0,
				appliedCongestion: key.includes("@bbr") ? "bbr" : "cubic",
				offboxSsh: key.endsWith("@offbox") ? "hermes-admin@192.168.2.36" : null,
			},
		],
	};
}

describe("classifyWaitVsDrop", () => {
	test("wait frame_tx at least 10% above drop is drop-starves-tx", () => {
		const result = classifyWaitVsDrop([
			withFrameTx("w2@160000", 100_000, 147_000),
			withFrameTx("w2@160000@wait", 120_000, 120_000),
		]);
		expect(result.stopBucket).toBe("drop-starves-tx");
		expect(result.ratio).toBeCloseTo(1.2);
	});

	test("wait frame_tx matching drop is path-cap", () => {
		expect(
			classifyWaitVsDrop([
				withFrameTx("w2@160000", 100_000, 147_000),
				withFrameTx("w2@160000@wait", 101_000, 101_000),
			]).stopBucket,
		).toBe("path-cap");
	});

	test("missing wait arm is incomplete, not path-cap", () => {
		expect(
			classifyWaitVsDrop([withFrameTx("w2@160000", 100_000, 147_000)])
				.stopBucket,
		).toBe("incomplete");
	});
});

describe("classifyCoresplit", () => {
	const base = {
		nproc: 4,
		tasksetOk: true,
		clientCpus: [0, 2],
	};

	test("split 20% above shared is co-residence", () => {
		expect(
			classifyCoresplit({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@split", 130_000, 130_000),
				],
			}).stopBucket,
		).toBe("co-residence");
	});

	test("flat split is not-coresidence, not path/cc", () => {
		expect(
			classifyCoresplit({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@split", 106_000, 106_000),
				],
			}).stopBucket,
		).toBe("not-coresidence");
	});

	test("shared outside the reproduce band is incomplete", () => {
		expect(
			classifyCoresplit({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 80_000, 80_000),
					withFrameTx("w2@160000@wait@split", 100_000, 100_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("nproc under 4 is incomplete", () => {
		expect(
			classifyCoresplit({
				...base,
				nproc: 2,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@split", 130_000, 130_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("no disjoint physical CPU pair is incomplete", () => {
		expect(
			classifyCoresplit({
				...base,
				clientCpus: null,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@split", 130_000, 130_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("unverified split affinity is incomplete", () => {
		const split = withFrameTx("w2@160000@wait@split", 130_000, 130_000);
		split.runs[0]!.clientAffinityOk = false;
		expect(
			classifyCoresplit({
				...base,
				summaries: [withFrameTx("w2@160000@wait", 105_000, 105_000), split],
			}).stopBucket,
		).toBe("incomplete");
	});
});

describe("classifyRmem", () => {
	const base = {
		rmemDefaultWrote: true,
		controlRmemDefault: 212_992,
	};

	test("socket grew and frame_tx rose 20% is rmem", () => {
		expect(
			classifyRmem({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000, 212_992),
					withFrameTx("w2@160000@wait@raised", 130_000, 130_000, 8_388_608),
				],
			}).stopBucket,
		).toBe("rmem");
	});

	test("socket grew but pipe stayed is not-rmem", () => {
		expect(
			classifyRmem({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000, 212_992),
					withFrameTx("w2@160000@wait@raised", 106_000, 106_000, 8_388_608),
				],
			}).stopBucket,
		).toBe("not-rmem");
	});

	test("sysctl write failed is incomplete", () => {
		expect(
			classifyRmem({
				...base,
				rmemDefaultWrote: false,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000, 212_992),
					withFrameTx("w2@160000@wait@raised", 130_000, 130_000, 8_388_608),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("raised socket not 4x default is incomplete", () => {
		expect(
			classifyRmem({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000, 212_992),
					withFrameTx("w2@160000@wait@raised", 130_000, 130_000, 300_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});
});

describe("classifyCc", () => {
	const base = {
		rmemModes: ["default"],
		cpuModes: ["shared"],
		sessions: 100,
	};

	test("bbr 20% above cubic and above 120k is cc", () => {
		expect(
			classifyCc({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@bbr", 130_000, 130_000),
				],
			}).stopBucket,
		).toBe("cc");
	});

	test("same leftover band is not-cc", () => {
		expect(
			classifyCc({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@bbr", 106_000, 106_000),
				],
			}).stopBucket,
		).toBe("not-cc");
	});

	test("gray cell 105k to 121k is not-cc", () => {
		expect(
			classifyCc({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@bbr", 121_000, 121_000),
				],
			}).stopBucket,
		).toBe("not-cc");
	});

	test("91k to 110k stays incomplete", () => {
		expect(
			classifyCc({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 91_000, 91_000),
					withFrameTx("w2@160000@wait@bbr", 110_000, 110_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("print mismatch is incomplete", () => {
		const bbr = withFrameTx("w2@160000@wait@bbr", 130_000, 130_000);
		bbr.runs[0]!.appliedCongestion = "cubic";
		expect(
			classifyCc({
				...base,
				summaries: [withFrameTx("w2@160000@wait", 105_000, 105_000), bbr],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("sessions_ok below 90 of 100 is incomplete", () => {
		const bbr = withFrameTx("w2@160000@wait@bbr", 130_000, 130_000);
		bbr.runs[0]!.sessionsOk = 80;
		expect(
			classifyCc({
				...base,
				summaries: [withFrameTx("w2@160000@wait", 105_000, 105_000), bbr],
			}).stopBucket,
		).toBe("incomplete");
	});
});

describe("classifyOffbox", () => {
	const base = {
		ccModes: ["cubic"],
		rmemModes: ["default"],
		cpuModes: ["shared"],
		sessions: 100,
		provisioned: true,
	};

	test("offbox 20% above onbox and above 120k is offbox-lifts", () => {
		expect(
			classifyOffbox({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@offbox", 140_000, 140_000),
				],
			}).stopBucket,
		).toBe("offbox-lifts");
	});

	test("same leftover band is not-offbox", () => {
		expect(
			classifyOffbox({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@offbox", 110_000, 110_000),
				],
			}).stopBucket,
		).toBe("not-offbox");
	});

	test("gray cell 105k to 121k without the ratio is not-offbox", () => {
		expect(
			classifyOffbox({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@offbox", 121_000, 121_000),
				],
			}).stopBucket,
		).toBe("not-offbox");
	});

	test("ratio met but offbox still inside the band is incomplete", () => {
		expect(
			classifyOffbox({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 91_000, 91_000),
					withFrameTx("w2@160000@wait@offbox", 112_000, 112_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("onbox control out of the 90k-120k band is incomplete", () => {
		expect(
			classifyOffbox({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 80_000, 80_000),
					withFrameTx("w2@160000@wait@offbox", 140_000, 140_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("offbox path collapsing below 90k is incomplete, not not-offbox", () => {
		expect(
			classifyOffbox({
				...base,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@offbox", 70_000, 70_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("mixed cc modes are incomplete", () => {
		expect(
			classifyOffbox({
				...base,
				ccModes: ["cubic", "bbr"],
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@offbox", 140_000, 140_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("unprovisioned generator is incomplete", () => {
		expect(
			classifyOffbox({
				...base,
				provisioned: false,
				summaries: [
					withFrameTx("w2@160000@wait", 105_000, 105_000),
					withFrameTx("w2@160000@wait@offbox", 140_000, 140_000),
				],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("offbox run missing the remote mark is incomplete", () => {
		const off = withFrameTx("w2@160000@wait@offbox", 140_000, 140_000);
		off.runs[0]!.offboxSsh = null;
		expect(
			classifyOffbox({
				...base,
				summaries: [withFrameTx("w2@160000@wait", 105_000, 105_000), off],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("onbox run carrying a remote mark is incomplete", () => {
		const on = withFrameTx("w2@160000@wait", 105_000, 105_000);
		on.runs[0]!.offboxSsh = "hermes-admin@192.168.2.36";
		expect(
			classifyOffbox({
				...base,
				summaries: [on, withFrameTx("w2@160000@wait@offbox", 140_000, 140_000)],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("sessions_ok below 90 of 100 is incomplete", () => {
		const off = withFrameTx("w2@160000@wait@offbox", 140_000, 140_000);
		off.runs[0]!.sessionsOk = 80;
		expect(
			classifyOffbox({
				...base,
				summaries: [withFrameTx("w2@160000@wait", 105_000, 105_000), off],
			}).stopBucket,
		).toBe("incomplete");
	});

	test("missing offbox arms are incomplete", () => {
		expect(
			classifyOffbox({
				...base,
				summaries: [withFrameTx("w2@160000@wait", 105_000, 105_000)],
			}).stopBucket,
		).toBe("incomplete");
	});
});

describe("armKey genMode", () => {
	test("offbox appends and onbox is omitted", () => {
		expect(
			armKey({
				workers: "2",
				requestedPerSec: 160_000,
				sendMode: "wait",
				genMode: "offbox",
			}),
		).toBe("w2@160000@wait@offbox");
		expect(
			armKey({
				workers: "2",
				requestedPerSec: 160_000,
				sendMode: "wait",
				genMode: "onbox",
			}),
		).toBe("w2@160000@wait");
	});
});
