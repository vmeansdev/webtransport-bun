import { describe, expect, test } from "bun:test";
import { LatencyHistogram } from "./latency-histogram.ts";
import {
	censoredP99Ns,
	classifyRttRun,
	crossHostClean,
	FLOOR_NOT_QUIET_MS,
	type RttFragment,
	toCell,
} from "./latency-rtt-classify.ts";
import {
	RTT_FIRST_PORT,
	RTT_GATE_RUNG,
	rttSchedule,
} from "./latency-rtt-schedule.ts";

/* ---------------------------------------------------------------------- *
 * Schedule — the registered order, checked against the document's counts.
 * ---------------------------------------------------------------------- */

describe("rttSchedule", () => {
	const cells = rttSchedule();

	test("runs the 22 registered cells with unique indexes and ports", () => {
		expect(cells).toHaveLength(22);
		expect(cells.map((c) => c.index)).toEqual([...Array(22).keys()]);
		expect(new Set(cells.map((c) => c.port)).size).toBe(22);
		expect(cells[0]?.port).toBe(RTT_FIRST_PORT);
	});

	test("carries exactly the registered cell counts per rung", () => {
		const count = (rung: string) => cells.filter((c) => c.rung === rung).length;
		expect(count("G-off")).toBe(10);
		expect(count("G-on")).toBe(3);
		expect(count("A-off")).toBe(3);
		expect(count("F-off")).toBe(3);
		expect(count("F-on")).toBe(3);
	});

	test("opens with an off-box floor arm, which doubles as the reachability pre-flight", () => {
		expect(cells[0]?.rung).toBe("F-off");
		expect(cells[0]?.placement).toBe("offbox");
	});

	test("spreads the floor arms across the start, middle and end", () => {
		const floorIndexes = cells.filter((c) => c.isFloor).map((c) => c.index);
		expect(floorIndexes).toEqual([0, 1, 8, 9, 20, 21]);
	});

	test("numbers the gate replicates 1..10 without repeating one", () => {
		const replicates = cells
			.filter((c) => c.rung === RTT_GATE_RUNG)
			.map((c) => c.replicate)
			.sort((a, b) => a - b);
		expect(replicates).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	test("interleaves the on-box controls between gate replicates rather than clustering them", () => {
		const controls = cells.filter((c) => c.rung === "G-on").map((c) => c.index);
		expect(controls).toEqual([4, 11, 16]);
	});

	test("gates only the off-box 15,000/s rung", () => {
		const gate = cells.filter((c) => c.rung === RTT_GATE_RUNG);
		expect(gate.every((c) => c.aggregate === 15_000)).toBe(true);
		expect(gate.every((c) => c.placement === "offbox")).toBe(true);
		expect(gate.every((c) => c.perSessionRate === 150)).toBe(true);
	});
});

/* ---------------------------------------------------------------------- *
 * Fixtures
 * ---------------------------------------------------------------------- */

function histogram(valueNs: number, count: number): LatencyHistogram {
	const h = new LatencyHistogram();
	for (let i = 0; i < count; i += 1) h.record(valueNs);
	return h;
}

/**
 * A histogram with a *graded* tail: the top `tailShare` of samples ramp from
 * `tailFromNs` to `tailToNs`, so two nearby quantiles read different values. A
 * flat tail would make the censoring correction untestable — every quantile in
 * it returns the same number whether the correction is applied or not.
 */
function tailed(
	bodyNs: number,
	tailFromNs: number,
	tailToNs: number,
	count: number,
	tailShare: number,
): LatencyHistogram {
	const h = new LatencyHistogram();
	const tail = Math.round(count * tailShare);
	for (let i = 0; i < count - tail; i += 1) h.record(bodyNs);
	for (let i = 0; i < tail; i += 1) {
		h.record(
			tailFromNs + ((tailToNs - tailFromNs) * i) / Math.max(tail - 1, 1),
		);
	}
	return h;
}

const EMPTY = new LatencyHistogram().toJson();

type CellOptions = {
	index: number;
	rung: string;
	replicate: number;
	placement?: "onbox" | "offbox";
	aggregate?: number;
	rttNs?: number;
	rttHistogram?: LatencyHistogram;
	sent?: number;
	returned?: number;
	serverRx?: number;
	lagNs?: number;
	ticksSkipped?: number;
	kernelDrops?: number;
	contaminate?: boolean;
	noTaps?: boolean;
	loopbackBytes?: number;
	/** O5 — what the Mac reported about the tree it built its generator from. */
	generatorHead?: string;
	generatorDirty?: boolean;
	generatorWatchdog?: boolean;
};

/** Stands in for the candidate SHA the dispatch is stamped against. */
const FIXTURE_CANDIDATE = "0fbe9cb0000000000000000000000000000000ab";

function fragment(options: CellOptions): RttFragment {
	const placement = options.placement ?? "offbox";
	const aggregate = options.aggregate ?? 15_000;
	const sent = options.sent ?? 300_000;
	const returned = options.returned ?? sent;
	const serverRx = options.serverRx ?? sent;
	const rtt = options.rttHistogram ?? histogram(options.rttNs ?? 5e6, returned);
	const payloadBytes = 1150;
	const lanBytes =
		placement === "offbox" ? sent * payloadBytes * 1.04 : sent * 8;
	const loBytes =
		options.loopbackBytes ??
		(placement === "offbox" ? sent * 8 : sent * payloadBytes * 1.04);
	return {
		rung: options.rung,
		replicate: options.replicate,
		cellIndex: options.index,
		config: {
			generatorMode: placement,
			sharedClock: placement === "onbox",
			payloadBytes,
			sessions: 100,
		},
		steps: [
			{
				aggregateRate: aggregate,
				requestedDatagrams: sent,
				clientSent: sent,
				clientReceived: returned,
				serverRx,
				echoSent: serverRx,
				upDeliveryRatio: serverRx / sent,
				ingest:
					placement === "offbox" && !options.contaminate
						? EMPTY
						: histogram(3e6, serverRx).toJson(),
				turnaround: histogram(1e4, serverRx).toJson(),
				client: {
					rtt: rtt.toJson(),
					scheduleLag: histogram(options.lagNs ?? 1.5e6, 20_000).toJson(),
					egressOneWay:
						placement === "offbox" && !options.contaminate
							? EMPTY
							: histogram(2e6, returned).toJson(),
					upstreamPlusTurnaround:
						placement === "offbox" && !options.contaminate
							? EMPTY
							: histogram(3e6, returned).toJson(),
					echoMissingEchoInstant: placement === "offbox" ? returned : 0,
					ticksSkipped: options.ticksSkipped ?? 0,
					sendEvents: 20_000,
				},
				hostCpuPctMedian: 50,
				serverCpuPct: 190,
				sessionsOk: 100,
				generator: {
					mode: placement,
					ssh: placement === "offbox" ? "vmeansdev@10.99.0.1" : null,
					urlHost: placement === "offbox" ? "10.99.0.2" : "127.0.0.1",
					macgen:
						placement === "offbox"
							? {
									bin: "load-client",
									entry: "tools/offbox/mac-generator-entry.sh",
									candidateAsked: FIXTURE_CANDIDATE,
									deadlineSec: 113,
									provenance: {
										host: "Nikitas-MacBook-Pro",
										arch: "arm64",
										os: "Darwin/25.4.0",
										candidate: FIXTURE_CANDIDATE,
										head: options.generatorHead ?? FIXTURE_CANDIDATE,
										dirty: options.generatorDirty ?? false,
										binarySha256: "a".repeat(64),
										rustc: "1.85.0",
										buildSeconds: 41,
										watchdogFired: options.generatorWatchdog ?? false,
										exitCode: 0,
									},
									problems: [],
								}
							: null,
				},
				netRxDelta: options.noTaps
					? null
					: {
							lo: { rxBytes: loBytes, rxPackets: Math.round(loBytes / 1200) },
							eth0: {
								rxBytes: lanBytes,
								rxPackets: Math.round(lanBytes / 1200),
							},
						},
				udpDelta: {
					inDatagrams: serverRx,
					inErrors: 0,
					rcvbufErrors: options.kernelDrops ?? 0,
				},
			},
		],
	};
}

/** The registered dispatch, all cells healthy, gate p99 at `gateRttNs`. */
function healthyRun(gateRttNs: number, overrides: RttFragment[] = []) {
	const cells = rttSchedule().map((cell) => {
		const rttNs =
			cell.rung === RTT_GATE_RUNG
				? gateRttNs
				: cell.isFloor
					? cell.placement === "offbox"
						? 2.2e6
						: 1.7e6
					: 6e6;
		return fragment({
			index: cell.index,
			rung: cell.rung,
			replicate: cell.replicate,
			placement: cell.placement,
			aggregate: cell.aggregate,
			rttNs,
			sent: cell.aggregate * 20,
			lagNs: cell.isFloor ? 1.2e6 : 1.5e6,
		});
	});
	for (const override of overrides) {
		const index = override.cellIndex ?? -1;
		if (index >= 0) cells[index] = override;
	}
	return cells;
}

/* ---------------------------------------------------------------------- *
 * Censoring — the correction that stops loss from buying a better tail.
 * ---------------------------------------------------------------------- */

describe("censoredP99Ns", () => {
	test("with nothing missing it is the ordinary p99", () => {
		const h = tailed(2e6, 10e6, 60e6, 100_000, 0.02);
		expect(censoredP99Ns(h, 0)).toBe(h.percentile(0.99));
	});

	test("missing samples raise the quantile, they never lower it", () => {
		const h = tailed(2e6, 10e6, 60e6, 100_000, 0.02);
		const raw = h.percentile(0.99);
		const corrected = censoredP99Ns(h, 0.005);
		expect(corrected).not.toBeNull();
		expect(corrected as number).toBeGreaterThan(raw);
	});

	test("reads the survivor quantile the registered formula names", () => {
		const h = tailed(2e6, 10e6, 60e6, 100_000, 0.02);
		expect(censoredP99Ns(h, 0.005)).toBe(h.percentile(0.99 / 0.995));
		expect(censoredP99Ns(h, 0.005)).not.toBe(h.percentile(0.99));
	});

	test("at 1% missing the true p99 is unbounded and no figure is produced", () => {
		const h = tailed(2e6, 10e6, 60e6, 100_000, 0.02);
		expect(censoredP99Ns(h, 0.01)).toBeNull();
		expect(censoredP99Ns(h, 0.2)).toBeNull();
	});
});

/* ---------------------------------------------------------------------- *
 * Integrity — a cell that cannot prove it was off-box does not count.
 * ---------------------------------------------------------------------- */

describe("off-box integrity", () => {
	const opts = { payloadBytes: 1150, lagFloorNs: 1.2e6 };

	test("a healthy off-box cell carries all four marks and no cross-host histogram", () => {
		const cell = toCell(
			fragment({ index: 3, rung: "G-off", replicate: 1 }),
			opts,
		);
		expect(cell?.integrityFailures).toEqual([]);
		expect(cell?.crossHostClean).toBe(true);
		expect(cell?.honestyFailures).toEqual([]);
	});

	test("an off-box cell whose traffic crossed loopback fails O3 and O4", () => {
		const frag = fragment({ index: 3, rung: "G-off", replicate: 1 });
		const step = frag.steps?.[0];
		if (step?.netRxDelta) {
			step.netRxDelta = {
				lo: { rxBytes: 300_000 * 1150, rxPackets: 300_000 },
				eth0: { rxBytes: 0, rxPackets: 0 },
			};
		}
		const cell = toCell(frag, opts);
		expect(cell?.integrityFailures).toEqual(["O3", "O4"]);
	});

	test("a Tailscale address fails O2 even when everything else looks fine", () => {
		const frag = fragment({ index: 3, rung: "G-off", replicate: 1 });
		const step = frag.steps?.[0];
		if (step?.generator) step.generator.urlHost = "100.68.152.116";
		expect(toCell(frag, opts)?.integrityFailures).toContain("O2");
	});

	test("the retired loadgen's own LAN address now fails O2", () => {
		// 192.168.2.x was the VM era's *required* address family. On the cable it
		// is the family Wi-Fi LAN, which is exactly what O2 exists to rule out.
		const frag = fragment({ index: 3, rung: "G-off", replicate: 1 });
		const step = frag.steps?.[0];
		if (step?.generator) step.generator.urlHost = "192.168.2.35";
		expect(toCell(frag, opts)?.integrityFailures).toContain("O2");
	});

	test("a generator that checked out a different tree fails O5", () => {
		const frag = fragment({
			index: 3,
			rung: "G-off",
			replicate: 1,
			generatorHead: "b".repeat(40),
		});
		expect(toCell(frag, opts)?.integrityFailures).toContain("O5");
	});

	test("a generator built from a dirty clone fails O5", () => {
		const frag = fragment({
			index: 3,
			rung: "G-off",
			replicate: 1,
			generatorDirty: true,
		});
		expect(toCell(frag, opts)?.integrityFailures).toContain("O5");
	});

	test("a watchdog kill fails O5 rather than reporting a short cell", () => {
		const frag = fragment({
			index: 3,
			rung: "G-off",
			replicate: 1,
			generatorWatchdog: true,
		});
		expect(toCell(frag, opts)?.integrityFailures).toContain("O5");
	});

	test("an off-box cell with no macgen provenance at all fails O5", () => {
		// A fragment from the retired scp-and-run path parses fine and says
		// nothing about which tree generated its load.
		const frag = fragment({ index: 3, rung: "G-off", replicate: 1 });
		const step = frag.steps?.[0];
		if (step?.generator) step.generator.macgen = null;
		expect(toCell(frag, opts)?.integrityFailures).toContain("O5");
	});

	test("O5 does not apply to the on-box control arm", () => {
		const cell = toCell(
			fragment({
				index: 4,
				rung: "G-on",
				replicate: 1,
				placement: "onbox",
			}),
			opts,
		);
		expect(cell?.integrityFailures).not.toContain("O5");
	});

	test("missing kernel taps are a failure, not a pass", () => {
		const cell = toCell(
			fragment({ index: 3, rung: "G-off", replicate: 1, noTaps: true }),
			opts,
		);
		expect(cell?.integrityFailures).toEqual(["O3", "O4"]);
	});

	test("a cross-host histogram on an off-box cell is detected", () => {
		const frag = fragment({
			index: 3,
			rung: "G-off",
			replicate: 1,
			contaminate: true,
		});
		const step = frag.steps?.[0];
		expect(step).toBeDefined();
		if (step) expect(crossHostClean(step, "offbox")).toBe(false);
		expect(toCell(frag, opts)?.crossHostClean).toBe(false);
	});
});

/* ---------------------------------------------------------------------- *
 * Honesty — the generator's own conditions, now measured on the loadgen.
 * ---------------------------------------------------------------------- */

describe("generator honesty", () => {
	const opts = { payloadBytes: 1150, lagFloorNs: 1.2e6 };

	test("H1 compares the effective rate against the rung's registered one", () => {
		const cell = toCell(
			fragment({
				index: 3,
				rung: "G-off",
				replicate: 1,
				aggregate: 14_000,
			}),
			opts,
		);
		expect(cell?.honestyFailures).toContain("H1");
	});

	test("H3 fires above one skipped tick per thousand send events", () => {
		const cell = toCell(
			fragment({ index: 3, rung: "G-off", replicate: 1, ticksSkipped: 25 }),
			opts,
		);
		expect(cell?.honestyFailures).toContain("H3");
	});

	test("H4 measures the loadgen's lag against the loadgen's own floor", () => {
		const cell = toCell(
			fragment({ index: 3, rung: "G-off", replicate: 1, lagNs: 3e6 }),
			opts,
		);
		expect(cell?.honestyFailures).toContain("H4");
		const withHigherFloor = toCell(
			fragment({ index: 3, rung: "G-off", replicate: 1, lagNs: 3e6 }),
			{ ...opts, lagFloorNs: 2e6 },
		);
		expect(withHigherFloor?.honestyFailures).not.toContain("H4");
	});

	test("H5 fires when a percent of the datagrams never come back", () => {
		const cell = toCell(
			fragment({
				index: 3,
				rung: "G-off",
				replicate: 1,
				sent: 300_000,
				returned: 296_000,
			}),
			opts,
		);
		expect(cell?.honestyFailures).toContain("H5");
		expect(cell?.rttP99CensoredNs).toBeNull();
	});
});

/* ---------------------------------------------------------------------- *
 * Verdicts — every registered row of §10, in order.
 * ---------------------------------------------------------------------- */

describe("classifyRttRun", () => {
	test("passes when the gate rung is honest, off-box and under the bound", () => {
		const result = classifyRttRun(healthyRun(6e6));
		expect(result.verdict).toBe("PASS");
		expect(result.decidedBy).toBe("row 8");
		expect(result.gate.cellsEvaluable).toBe(10);
		expect((result.gate.medianRttP99CensoredNs ?? 0) / 1e6).toBeCloseTo(6, 1);
	});

	test("misses when the median censored p99 is above the bound", () => {
		const result = classifyRttRun(healthyRun(26e6));
		expect(result.verdict).toBe("MISS");
		expect(result.decidedBy).toContain("row 7");
	});

	test("a bound that falls inside the interval is labelled, not hidden", () => {
		const cells = healthyRun(6e6);
		// Half the replicates above the bound, half below: the median passes and
		// the interval straddles.
		let flipped = 0;
		for (let i = 0; i < cells.length; i += 1) {
			if (cells[i]?.rung !== RTT_GATE_RUNG) continue;
			if (flipped++ >= 4) break;
			cells[i] = fragment({
				index: cells[i]?.cellIndex ?? i,
				rung: "G-off",
				replicate: cells[i]?.replicate ?? 1,
				rttNs: 14e6,
				sent: 300_000,
			});
		}
		const result = classifyRttRun(cells);
		expect(result.verdict).toBe("PASS");
		expect(result.labels).toContain("gate-ci-spans-bound");
	});

	test("a contaminated cross-host histogram voids the dispatch", () => {
		const cells = healthyRun(6e6);
		cells[3] = fragment({
			index: 3,
			rung: "G-off",
			replicate: 1,
			contaminate: true,
		});
		const result = classifyRttRun(cells);
		expect(result.verdict).toBe("INCOMPLETE");
		expect(result.decidedBy).toContain("row 2");
	});

	test("a floor that is not quiet is a path finding, not a product one", () => {
		const cells = healthyRun(6e6);
		cells[0] = fragment({
			index: 0,
			rung: "F-off",
			replicate: 0,
			aggregate: 1_000,
			rttNs: FLOOR_NOT_QUIET_MS * 1e6 + 1e6,
			sent: 20_000,
			lagNs: 1.2e6,
		});
		const result = classifyRttRun(cells);
		expect(result.verdict).toBe("INCOMPLETE");
		expect(result.decidedBy).toContain("path-not-quiet");
	});

	test("floor drift across the dispatch voids it too", () => {
		const cells = healthyRun(6e6);
		cells[20] = fragment({
			index: 20,
			rung: "F-off",
			replicate: 2,
			aggregate: 1_000,
			rttNs: 3.9e6,
			sent: 20_000,
			lagNs: 1.2e6,
		});
		cells[0] = fragment({
			index: 0,
			rung: "F-off",
			replicate: 0,
			aggregate: 1_000,
			rttNs: 1.2e6,
			sent: 20_000,
			lagNs: 1.2e6,
		});
		const result = classifyRttRun(cells);
		expect(result.verdict).toBe("INCOMPLETE");
		expect(result.decidedBy).toContain("floor-drift");
	});

	test("loss the server's own kernel dropped is a miss, not a rig excuse", () => {
		const cells = healthyRun(6e6);
		for (let i = 0; i < cells.length; i += 1) {
			if (cells[i]?.rung !== RTT_GATE_RUNG) continue;
			cells[i] = fragment({
				index: cells[i]?.cellIndex ?? i,
				rung: "G-off",
				replicate: cells[i]?.replicate ?? 1,
				rttNs: 6e6,
				sent: 300_000,
				returned: 294_000,
				serverRx: 294_000,
				kernelDrops: 6_000,
			});
		}
		const result = classifyRttRun(cells);
		expect(result.verdict).toBe("MISS");
		expect(result.decidedBy).toContain("row 6");
	});

	test("the same loss with no kernel drops is a path disclosure, and the rung goes incomplete", () => {
		const cells = healthyRun(6e6);
		for (let i = 0; i < cells.length; i += 1) {
			if (cells[i]?.rung !== RTT_GATE_RUNG) continue;
			cells[i] = fragment({
				index: cells[i]?.cellIndex ?? i,
				rung: "G-off",
				replicate: cells[i]?.replicate ?? 1,
				rttNs: 6e6,
				sent: 300_000,
				returned: 294_000,
				serverRx: 294_000,
				kernelDrops: 0,
			});
		}
		const result = classifyRttRun(cells);
		expect(result.verdict).toBe("INCOMPLETE");
		expect(result.decidedBy).toContain("row 5");
		expect(
			result.cells
				.filter((c) => c.rung === RTT_GATE_RUNG)
				.every((c) => c.lossAttribution === "off-host"),
		).toBe(true);
	});

	test("a collapsed path is incomplete regardless of attribution", () => {
		const cells = healthyRun(6e6);
		for (let i = 0; i < cells.length; i += 1) {
			if (cells[i]?.rung !== RTT_GATE_RUNG) continue;
			cells[i] = fragment({
				index: cells[i]?.cellIndex ?? i,
				rung: "G-off",
				replicate: cells[i]?.replicate ?? 1,
				rttNs: 6e6,
				sent: 300_000,
				returned: 270_000,
				serverRx: 270_000,
				kernelDrops: 30_000,
			});
		}
		const result = classifyRttRun(cells);
		expect(result.verdict).toBe("INCOMPLETE");
		expect(result.decidedBy).toContain("row 4");
	});

	test("fewer than eight honest gate cells leaves the gate unevaluated", () => {
		const cells = healthyRun(6e6);
		let broken = 0;
		for (let i = 0; i < cells.length; i += 1) {
			if (cells[i]?.rung !== RTT_GATE_RUNG) continue;
			if (broken++ >= 3) break;
			cells[i] = fragment({
				index: cells[i]?.cellIndex ?? i,
				rung: "G-off",
				replicate: cells[i]?.replicate ?? 1,
				rttNs: 6e6,
				sent: 300_000,
				lagNs: 4e6,
			});
		}
		const result = classifyRttRun(cells);
		expect(result.verdict).toBe("INCOMPLETE");
		expect(result.decidedBy).toContain("row 5");
		expect(result.gate.cellsEvaluable).toBe(7);
	});

	test("the on-box control and the 10k rung are reported and carry no verdict", () => {
		const result = classifyRttRun(healthyRun(6e6));
		const rungs = result.context.map((c) => c.rung);
		expect(rungs).toContain("G-on");
		expect(rungs).toContain("A-off");
		expect(result.decidedBy).toBe("row 8");
	});

	test("the wire cost is published as the difference between the two floors", () => {
		const result = classifyRttRun(healthyRun(6e6));
		expect(result.floor.wireCostP99Ns).not.toBeNull();
		expect((result.floor.wireCostP99Ns ?? 0) / 1e6).toBeCloseTo(0.5, 1);
	});
});
