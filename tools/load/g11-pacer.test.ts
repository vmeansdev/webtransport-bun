import { describe, expect, test } from "bun:test";
import { percentileMs } from "./g11-histogram.ts";
import { runPacedStream } from "./g11-pacer.ts";
import {
	bytesPerSecPerDirection,
	FRAME_BYTES,
	tunnelRung,
} from "./g11-plan.ts";

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

/** One tunnel's downstream share, and its frame — the gate's own numbers. */
const RATE = bytesPerSecPerDirection();
const WRITE = FRAME_BYTES;
const INTERVAL_MS = tunnelRung(1).frameIntervalMs;

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
		// Each write costs 20 ms against the gate's 3.739 ms frame interval: the
		// tunnel cannot keep up. It must fall behind and stay behind, which is
		// what V-P sees as an offer below 0.98 rather than as a burst.
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
		// The lateness travels in the artifact beside the shortfall it explains.
		expect(lateness as number).toBeGreaterThan(INTERVAL_MS);
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
		// 50 ms at a 3.739 ms interval is 14 frames due, including the one at
		// t=0. The exact count is pinned because the livelock this regression
		// guards would show up as zero.
		expect(r.writes).toBe(Math.ceil(50 / INTERVAL_MS));
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

describe("the slice quantum bounds the burst", () => {
	test("a sub-tick rate issues at most one quantum of writes per wake", async () => {
		// No G11 cell runs below the timer tick — the gate's interval is 3.739 ms
		// — but the cap is the thing that would keep a future sub-tick rung
		// comparable to this one, so it is tested rather than assumed.
		const clock = fakeClock();
		const quantum = 4;
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
			writeBytes: WRITE,
			bytesPerSec: RATE * 16, // ~0.23 ms per frame: well below one tick
			durationMs: 2_000,
			sliceQuantum: quantum,
			now: clock.now,
			sleep: clock.sleep,
		});
		expect(r.writes).toBeGreaterThan(0);
		expect(maxRun).toBeLessThanOrEqual(quantum);
	});

	test("a catch-up after a flow-control block stays inside the cumulative schedule", async () => {
		const clock = fakeClock();
		const start = clock.t;
		const quantum = 4;
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
				const dueMs = ((index * WRITE) / RATE) * 1000;
				worstAhead = Math.max(worstAhead, dueMs - (clock.now() - start));
				index += 1;
				await Promise.resolve();
			},
			writeBytes: WRITE,
			bytesPerSec: RATE,
			durationMs: 3_000,
			sliceQuantum: quantum,
			now: clock.now,
			sleep: async (ms: number) => {
				writesThisWake = 0;
				await clock.sleep(ms);
			},
		});
		expect(stalled).toBe(true);
		expect(maxPerWake).toBeLessThanOrEqual(quantum);
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
			write: async (chunk: Uint8Array) => {
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
