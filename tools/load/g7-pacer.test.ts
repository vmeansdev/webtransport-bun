import { describe, expect, test } from "bun:test";
import { percentileMs } from "./g7-classify.ts";
import { runPacedStream, sliceAssignment, sliceOffsetMs } from "./g7-pacer.ts";
import { bulkCellPlan, TOKEN_SLICES_PER_INTERVAL } from "./g7-plan.ts";

/**
 * A fake clock. Time advances only where the writer says it does — in a sleep
 * or inside a write — so the pacer's arithmetic is tested with no timers, no
 * transport, and no flake.
 */
function fakeClock(opts: { writeCostMs?: number; sleepDriftMs?: number } = {}) {
	let t = 1000;
	const writeCost = opts.writeCostMs ?? 0;
	const drift = opts.sleepDriftMs ?? 0;
	const writeAt: number[] = [];
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms + drift;
			await Promise.resolve();
		},
		write: async () => {
			writeAt.push(t);
			t += writeCost;
			await Promise.resolve();
		},
		writeAt,
		advance: (ms: number) => {
			t += ms;
		},
		get t() {
			return t;
		},
	};
}

const RATE = 9_765_625; // one gate-arm stream's share, bytes/s
const WRITE = 65536;

describe("the pacer cannot overshoot", () => {
	test("a 60 s step offers its schedule and not one write more", async () => {
		const clock = fakeClock();
		const r = await runPacedStream({
			write: clock.write,
			writeBytes: WRITE,
			bytesPerSec: RATE,
			durationMs: 60_000,
			sliceQuantum: 1,
			now: clock.now,
			sleep: clock.sleep,
		});
		const scheduled = Math.floor((RATE * 60) / WRITE);
		expect(r.writes).toBeLessThanOrEqual(scheduled + 1);
		expect(r.bytes / (60_000 / 1000)).toBeLessThanOrEqual(RATE * 1.02);
	});

	test("no write is ever issued before its cumulative deadline", async () => {
		const clock = fakeClock();
		const start = clock.t;
		await runPacedStream({
			write: clock.write,
			writeBytes: WRITE,
			bytesPerSec: RATE,
			durationMs: 5_000,
			sliceQuantum: 1,
			now: clock.now,
			sleep: clock.sleep,
		});
		clock.writeAt.forEach((at, i) => {
			const dueMs = ((i * WRITE) / RATE) * 1000;
			expect(at - start).toBeGreaterThanOrEqual(dueMs - 1e-9);
		});
	});

	test("an expensive write shows up as a shortfall, never as a burst ahead", async () => {
		// Each write costs 20 ms against a 6.71 ms interval: the stream cannot
		// keep up. It must fall behind and stay behind.
		const clock = fakeClock({ writeCostMs: 20 });
		const r = await runPacedStream({
			write: clock.write,
			writeBytes: WRITE,
			bytesPerSec: RATE,
			durationMs: 10_000,
			sliceQuantum: 1,
			now: clock.now,
			sleep: clock.sleep,
		});
		const offered = (r.bytes / 10) as number;
		expect(offered).toBeLessThan(RATE);
		const lateness = percentileMs(r.lateness.snapshot(), 0.99);
		expect(lateness).not.toBeNull();
		// The lateness is what V2b reads to call this originator-bound rather
		// than a product shortfall.
		expect(lateness as number).toBeGreaterThan(
			bulkCellPlan("B-64k").writeIntervalMs,
		);
	});
});

describe("regression: the deadline comparison must tolerate rounding residue", () => {
	test("a clock that advances only by the sleep amount still terminates", async () => {
		// `written / rate` leaves ~1e-14 ms of double-rounding residue, which
		// made an exactly-due write look permanently early: the writer slept a
		// value too small to move any clock and livelocked. A real 1 ms timer
		// floor hides this; a fake clock does not.
		const clock = fakeClock();
		const r = await runPacedStream({
			write: clock.write,
			writeBytes: WRITE,
			bytesPerSec: RATE,
			durationMs: 50,
			sliceQuantum: 1,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(r.writes).toBe(8);
		expect(r.completedFullDuration).toBe(true);
	});
});

describe("timer error does not accumulate", () => {
	test("an over-sleeping timer shortens the next sleep instead of shifting the schedule", async () => {
		const perfect = fakeClock();
		const drifty = fakeClock({ sleepDriftMs: 2 });
		const opts = {
			writeBytes: WRITE,
			bytesPerSec: RATE,
			durationMs: 20_000,
			sliceQuantum: 1,
		};
		const a = await runPacedStream({
			...opts,
			write: perfect.write,
			now: perfect.now,
			sleep: perfect.sleep,
		});
		const b = await runPacedStream({
			...opts,
			write: drifty.write,
			now: drifty.now,
			sleep: drifty.sleep,
		});
		// Every sleep overshoots by 2 ms — a third of the interval — and the
		// cumulative deadline absorbs all of it: the two step totals differ by
		// at most one write.
		expect(Math.abs(a.writes - b.writes)).toBeLessThanOrEqual(1);
	});
});

describe("the slice quantum bounds the burst at every rung", () => {
	test("a sub-tick rung issues at most one timer tick of bytes per wake", async () => {
		const plan = bulkCellPlan("B-1k");
		const clock = fakeClock();
		let maxRun = 0;
		let run = 0;
		let lastT = -1;
		const r = await runPacedStream({
			write: async () => {
				if (clock.now() === lastT) run += 1;
				else {
					run = 1;
					lastT = clock.now();
				}
				if (run > maxRun) maxRun = run;
				await Promise.resolve();
			},
			writeBytes: plan.writeBytes,
			bytesPerSec: plan.perStreamBytesPerSec,
			durationMs: 2_000,
			sliceQuantum: plan.sliceQuantum,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(r.writes).toBeGreaterThan(0);
		expect(maxRun).toBeLessThanOrEqual(plan.sliceQuantum);
	});

	test("a catch-up after a stall stays inside the cumulative schedule", async () => {
		const plan = bulkCellPlan("B-4k");
		const clock = fakeClock();
		const start = clock.t;
		let stalled = false;
		let writesThisWake = 0;
		let maxPerWake = 0;
		let worstAhead = -Infinity;
		let index = 0;
		await runPacedStream({
			write: async () => {
				if (!stalled && clock.now() - start > 1500) {
					stalled = true;
					clock.advance(100); // a 100 ms flow-control block
				}
				writesThisWake += 1;
				if (writesThisWake > maxPerWake) maxPerWake = writesThisWake;
				// The substantive property: a catch-up write is still not issued
				// before its own cumulative deadline. It repays lateness, never
				// borrows against the future.
				const dueMs =
					((index * plan.writeBytes) / plan.perStreamBytesPerSec) * 1000;
				worstAhead = Math.max(worstAhead, dueMs - (clock.now() - start));
				index += 1;
				await Promise.resolve();
			},
			writeBytes: plan.writeBytes,
			bytesPerSec: plan.perStreamBytesPerSec,
			durationMs: 3_000,
			sliceQuantum: plan.sliceQuantum,
			now: clock.now,
			sleep: async (ms) => {
				writesThisWake = 0;
				await clock.sleep(ms);
			},
		});
		expect(stalled).toBe(true);
		expect(maxPerWake).toBeLessThanOrEqual(plan.sliceQuantum);
		// Never ahead of schedule by more than the rounding guard.
		expect(worstAhead).toBeLessThanOrEqual(1e-6);
	});
});

describe("failure handling", () => {
	test("a failing write stops the stream instead of hot-looping on the error", async () => {
		const clock = fakeClock();
		let calls = 0;
		const r = await runPacedStream({
			write: async () => {
				calls += 1;
				if (calls === 3) throw new Error("E_STREAM_RESET");
				await Promise.resolve();
			},
			writeBytes: WRITE,
			bytesPerSec: RATE,
			durationMs: 60_000,
			sliceQuantum: 1,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(calls).toBe(3);
		expect(r.errors).toBe(1);
		expect(r.firstError).toBe("E_STREAM_RESET");
		expect(r.completedFullDuration).toBe(false);
		// The write that failed is counted as issued and not as settled: the
		// ledger must be able to see the discrepancy, not have it hidden.
		expect(r.writes).toBe(3);
		expect(r.settles).toBe(2);
	});
});

describe("the payload can carry its own stamp", () => {
	test("fill runs immediately before each write, with the write's intended instant", async () => {
		const clock = fakeClock();
		const seen: { index: number; intended: number; firstByte: number }[] = [];
		await runPacedStream({
			write: async (chunk) => {
				const last = seen[seen.length - 1];
				if (last) last.firstByte = chunk[0] as number;
				await Promise.resolve();
			},
			writeBytes: 40,
			bytesPerSec: 40 * 25,
			durationMs: 200,
			sliceQuantum: 1,
			now: clock.now,
			sleep: clock.sleep,
			fill: (chunk, index, intendedMs) => {
				chunk[0] = (index + 1) & 0xff;
				seen.push({ index, intended: intendedMs, firstByte: -1 });
			},
		});
		expect(seen.length).toBeGreaterThan(3);
		seen.forEach((s, i) => {
			expect(s.index).toBe(i);
			expect(s.firstByte).toBe((i + 1) & 0xff);
		});
		// Intended instants are the schedule, not the observed times.
		const first = seen[0];
		const second = seen[1];
		expect(first && second).toBeTruthy();
		expect((second?.intended ?? 0) - (first?.intended ?? 0)).toBeCloseTo(40, 6);
	});
});

describe("the token emitter spreads instead of aligning", () => {
	test("sessions are spread across the interval's slices", () => {
		const slices = TOKEN_SLICES_PER_INTERVAL;
		const counts = new Array(slices).fill(0);
		for (let s = 0; s < 1000; s += 1)
			counts[sliceAssignment(s, slices)] =
				counts[sliceAssignment(s, slices)] + 1;
		expect(new Set(counts).size).toBe(1);
		expect(counts[0]).toBe(50);
	});

	test("slice offsets tile the interval exactly once", () => {
		const offsets = Array.from({ length: TOKEN_SLICES_PER_INTERVAL }, (_, i) =>
			sliceOffsetMs(i, TOKEN_SLICES_PER_INTERVAL, 40),
		);
		expect(offsets[0]).toBe(0);
		expect(offsets[TOKEN_SLICES_PER_INTERVAL - 1]).toBe(38);
		expect(new Set(offsets).size).toBe(TOKEN_SLICES_PER_INTERVAL);
	});
});
