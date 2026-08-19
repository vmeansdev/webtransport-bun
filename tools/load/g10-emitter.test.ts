import { describe, expect, test } from "bun:test";
import {
	type ArmId,
	armForElapsed,
	blocksPerArm,
	broadcast,
	broadcastA1,
	broadcastA2,
	broadcastA3,
	type EmitterTransport,
	type MirrorEnvelope,
	resolveArms,
	type SendOutcome,
	startLoopLagSampler,
} from "./g10-emitter";
import { A2_CHUNK_TARGETS, DATAGRAM_MIRROR_MAX, SUBSCRIBERS } from "./g10-plan";

const PAYLOAD = new Uint8Array(200);

/**
 * A transport with a clock that only moves when someone does work, so a test can
 * state "A1 held the loop for the whole pass" as an exact number instead of a
 * flaky wall-clock comparison.
 */
function fakeTransport(options?: {
	nsPerSend?: number;
	nsPerMirrorTarget?: number;
	outcome?: (target: string, index: number) => SendOutcome;
	mirror?: (targets: readonly string[]) => MirrorEnvelope;
	mirrorCap?: number;
}): EmitterTransport & { clockNs: bigint; yields: number; sends: string[] } {
	const nsPerSend = BigInt(options?.nsPerSend ?? 343);
	const nsPerMirrorTarget = BigInt(options?.nsPerMirrorTarget ?? 86);
	const state = {
		clockNs: 0n,
		yields: 0,
		sends: [] as string[],
		nowNs(): bigint {
			return state.clockNs;
		},
		async yieldToLoop(): Promise<void> {
			state.yields += 1;
			// A yield is where the loop gets to do something else; give it time,
			// so an arm that failed to yield is distinguishable from one that did.
			state.clockNs += 1_000_000n;
		},
		trySend(target: string): SendOutcome {
			const index = state.sends.length;
			state.sends.push(target);
			state.clockNs += nsPerSend;
			return options?.outcome?.(target, index) ?? "ok";
		},
	} as EmitterTransport & { clockNs: bigint; yields: number; sends: string[] };

	if (options?.mirror) {
		state.sendMirror = (targets: readonly string[]): MirrorEnvelope => {
			state.clockNs += nsPerMirrorTarget * BigInt(targets.length);
			return (options.mirror as (t: readonly string[]) => MirrorEnvelope)(
				targets,
			);
		};
	}
	if (options?.mirrorCap !== undefined) state.mirrorCap = options.mirrorCap;
	return state;
}

const fleet = (n = SUBSCRIBERS): string[] =>
	Array.from({ length: n }, (_, i) => `s${i}`);

/* -------------------------------------------------------------------------- */

describe("§2.3 / §11.1 — arm resolution never blocks the gate", () => {
	test("no mirror entry point degrades to two arms with a warning, not an error", () => {
		const r = resolveArms(["A1", "A2", "A3"], fakeTransport());
		expect(r.arms).toEqual(["A1", "A2"]);
		expect(r.dropped).toEqual(["A3"]);
		expect(r.warnings[0]).toContain("two-arm gate");
	});

	test("a mirror entry point admits three arms and warns about nothing", () => {
		const r = resolveArms(
			["A1", "A2", "A3"],
			fakeTransport({ mirror: () => ({ sent: 0, failures: [] }) }),
		);
		expect(r.arms).toEqual(["A1", "A2", "A3"]);
		expect(r.warnings).toEqual([]);
	});

	test("a product cap that disagrees with §1.11 is disclosed, not absorbed", () => {
		// The arm still runs — but the stall derivation was registered against
		// 10,000 and a silent 8,192 would invalidate it without saying so.
		const r = resolveArms(
			["A1", "A2", "A3"],
			fakeTransport({
				mirror: () => ({ sent: 0, failures: [] }),
				mirrorCap: 8_192,
			}),
		);
		expect(r.arms).toContain("A3");
		expect(r.warnings.join(" ")).toContain("8192");
	});
});

/* -------------------------------------------------------------------------- */

describe("§6.6a — the arms differ in exactly the way C7 reads", () => {
	test("A1 holds the loop for the whole pass and never yields", async () => {
		const t = fakeTransport();
		const r = broadcastA1(fleet(), PAYLOAD, t);
		expect(r.attempts).toBe(SUBSCRIBERS);
		expect(r.ok).toBe(SUBSCRIBERS);
		expect(r.spans).toBe(1);
		expect(t.yields).toBe(0);
		// 10,000 x 343 ns = 3.43 ms, the figure §1.10 registers and P9 predicts
		// will fail C7.
		expect(Number(r.stallNs) / 1e6).toBeCloseTo(3.43, 6);
	});

	test("A2's stall is one chunk, not the pass, and it yields between them", async () => {
		const t = fakeTransport();
		const r = await broadcastA2(fleet(), PAYLOAD, t);
		expect(r.attempts).toBe(SUBSCRIBERS);
		expect(r.spans).toBe(Math.ceil(SUBSCRIBERS / A2_CHUNK_TARGETS));
		expect(t.yields).toBe(r.spans - 1);
		// 256 x 343 ns = 87.8 us — §1.11's "11x inside the budget".
		expect(Number(r.stallNs) / 1e6).toBeCloseTo(0.087808, 6);
	});

	test("A2 reports its WORST chunk, so its own yields cannot flatter it", async () => {
		// One chunk takes ten times as long as the rest. A mean would hide it.
		let calls = 0;
		const t = fakeTransport();
		const inner = t.trySend.bind(t);
		t.trySend = (target: string, payload: Uint8Array): SendOutcome => {
			calls += 1;
			if (calls > 600 && calls <= 700) t.clockNs += 10_000n;
			return inner(target, payload);
		};
		const r = await broadcastA2(fleet(1024), PAYLOAD, t);
		const worstMs = Number(r.stallNs) / 1e6;
		const uniformChunkMs = (A2_CHUNK_TARGETS * 343) / 1e6;
		expect(worstMs).toBeGreaterThan(uniformChunkMs * 2);
	});

	test("A3 is one span over the whole fleet", () => {
		const t = fakeTransport({
			mirror: (targets) => ({ sent: targets.length, failures: [] }),
		});
		const r = broadcastA3(fleet(), PAYLOAD, t);
		expect(r.spans).toBe(1);
		expect(r.attempts).toBe(SUBSCRIBERS);
		expect(r.ok).toBe(SUBSCRIBERS);
		expect(t.sends).toHaveLength(0); // never touched the per-target path
		// 10,000 x 86 ns = 0.86 ms: §1.11's lower bound, reproduced.
		expect(Number(r.stallNs) / 1e6).toBeCloseTo(0.86, 6);
	});

	test("the three arms are ordered as §1.11 says, on the same clock", async () => {
		const a1 = broadcastA1(fleet(), PAYLOAD, fakeTransport());
		const a2 = await broadcastA2(fleet(), PAYLOAD, fakeTransport());
		const a3 = broadcastA3(
			fleet(),
			PAYLOAD,
			fakeTransport({ mirror: (t) => ({ sent: t.length, failures: [] }) }),
		);
		expect(a2.stallNs).toBeLessThan(a3.stallNs);
		expect(a3.stallNs).toBeLessThan(a1.stallNs);
	});
});

/* -------------------------------------------------------------------------- */

describe("the ledger every arm has to close (C5)", () => {
	test("A1's outcomes sum to its attempts", () => {
		const t = fakeTransport({
			outcome: (_target, i) =>
				i % 100 === 0 ? "would-block" : i % 997 === 0 ? "error" : "ok",
		});
		const r = broadcastA1(fleet(), PAYLOAD, t);
		expect(r.ok + r.wouldBlock + r.errors).toBe(r.attempts);
		expect(r.wouldBlock).toBeGreaterThan(0);
		expect(r.errors).toBeGreaterThan(0);
	});

	test("A3's failures-only envelope lands in the same three counters", () => {
		const t = fakeTransport({
			mirror: (targets) => ({
				sent: targets.length - 3,
				failures: [
					{ index: 4, code: "E_QUEUE_FULL" },
					{ index: 9, code: "E_QUEUE_FULL" },
					{ index: 77, code: "E_SESSION_CLOSED" },
				],
			}),
		});
		const r = broadcastA3(fleet(), PAYLOAD, t);
		expect(r.attempts).toBe(SUBSCRIBERS);
		expect(r.wouldBlock).toBe(2);
		expect(r.errors).toBe(1);
		expect(r.ok + r.wouldBlock + r.errors).toBe(r.attempts);
	});

	test("A3 does not retry its failures — that would make it a different emitter", () => {
		let calls = 0;
		const t = fakeTransport({
			mirror: (targets) => {
				calls += 1;
				return {
					sent: targets.length - 1,
					failures: [{ index: 0, code: "E_QUEUE_FULL" }],
				};
			},
		});
		broadcastA3(fleet(), PAYLOAD, t);
		expect(calls).toBe(1);
		expect(t.sends).toHaveLength(0);
	});
});

/* -------------------------------------------------------------------------- */

describe("§1.11's knife edge — the fleet sits exactly on the cap", () => {
	test("the whole fleet mirrors in one call", () => {
		const t = fakeTransport({
			mirror: (targets) => ({ sent: targets.length, failures: [] }),
		});
		expect(() =>
			broadcastA3(fleet(DATAGRAM_MIRROR_MAX), PAYLOAD, t),
		).not.toThrow();
	});

	test("one subscriber more throws rather than silently chunking", () => {
		// The product's wrapper throws; a harness that quietly split the list
		// would substitute a chunked mirror — a different arm (§2.3) — and
		// nothing downstream could tell.
		const t = fakeTransport({
			mirror: (targets) => ({ sent: targets.length, failures: [] }),
		});
		expect(() =>
			broadcastA3(fleet(DATAGRAM_MIRROR_MAX + 1), PAYLOAD, t),
		).toThrow(RangeError);
	});

	test("a candidate with a smaller cap is respected, not overridden", () => {
		const t = fakeTransport({
			mirror: (targets) => ({ sent: targets.length, failures: [] }),
			mirrorCap: 4_096,
		});
		expect(() => broadcastA3(fleet(5_000), PAYLOAD, t)).toThrow(RangeError);
	});

	test("running A3 without a mirror is a harness bug, and says so", () => {
		expect(() => broadcastA3(fleet(10), PAYLOAD, fakeTransport())).toThrow(
			/resolveArms/,
		);
	});
});

/* -------------------------------------------------------------------------- */

describe("§2 — the interleave K5 made necessary", () => {
	const arms: ArmId[] = ["A1", "A2", "A3"];

	test("arms rotate every 10 s block rather than running as separate stretches", () => {
		expect(armForElapsed(0, arms)).toBe("A1");
		expect(armForElapsed(9_999, arms)).toBe("A1");
		expect(armForElapsed(10_000, arms)).toBe("A2");
		expect(armForElapsed(20_000, arms)).toBe("A3");
		expect(armForElapsed(30_000, arms)).toBe("A1");
	});

	test("a two-arm gate interleaves just as evenly", () => {
		const two: ArmId[] = ["A1", "A2"];
		expect(armForElapsed(10_000, two)).toBe("A2");
		expect(armForElapsed(20_000, two)).toBe("A1");
	});

	test("a 120 s window gives three arms four blocks each", () => {
		const counts = blocksPerArm(120_000, arms);
		expect([...counts.values()]).toEqual([4, 4, 4]);
	});

	test("an uneven window is visible in the artifact rather than inferred", () => {
		// 100 s over three arms cannot be even, and the conductor reports it.
		const counts = blocksPerArm(100_000, arms);
		expect([...counts.values()]).toEqual([4, 3, 3]);
	});

	test("no arms is a harness fault, not a silent default", () => {
		expect(() => armForElapsed(0, [])).toThrow();
	});
});

/* -------------------------------------------------------------------------- */

describe("§6.6b — the loop-lag sampler", () => {
	test("it records ticks and never a negative lag", async () => {
		const samples: number[] = [];
		const stop = startLoopLagSampler(
			2,
			() => process.hrtime.bigint(),
			(s) => samples.push(Number(s.lagNs)),
		);
		await Bun.sleep(40);
		const ticks = stop();
		expect(ticks).toBeGreaterThan(4);
		expect(samples).toHaveLength(ticks);
		for (const lag of samples) expect(lag).toBeGreaterThanOrEqual(0);
	});

	test("stopping it stops the recording", async () => {
		let recorded = 0;
		const stop = startLoopLagSampler(
			1,
			() => process.hrtime.bigint(),
			() => {
				recorded += 1;
			},
		);
		await Bun.sleep(10);
		const atStop = stop();
		await Bun.sleep(10);
		expect(recorded).toBe(atStop);
	});
});

/* -------------------------------------------------------------------------- */

describe("the dispatcher the conductor calls", () => {
	test("every arm routes to its own shape", async () => {
		const mirror = {
			mirror: (t: readonly string[]) => ({ sent: t.length, failures: [] }),
		};
		expect(
			(await broadcast("A1", fleet(300), PAYLOAD, fakeTransport())).spans,
		).toBe(1);
		expect(
			(await broadcast("A2", fleet(300), PAYLOAD, fakeTransport())).spans,
		).toBe(2);
		expect(
			(await broadcast("A3", fleet(300), PAYLOAD, fakeTransport(mirror))).arm,
		).toBe("A3");
	});
});
