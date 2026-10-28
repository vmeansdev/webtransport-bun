/**
 * Pins CLOCK_MONOTONIC on this Mac, because the generator's clock is the only
 * clock an off-box gate has.
 *
 * One-way latency is impossible across the cable — two hosts, two counters, no
 * shared epoch — so every off-box design is RTT-gated, and an RTT is one clock
 * read twice by the same process. That makes the generator's monotonic clock
 * load-bearing in a way it never was on-box, where a bad clock would have shown
 * up as an absurd one-way number. Here a subtly wrong clock produces a
 * plausible, wrong RTT.
 *
 * Three things are pinned, and each has a way of being wrong on macOS
 * specifically:
 *
 *   1. `CLOCK_MONOTONIC` is 6 on Darwin and 1 on Linux. The FFI harness carries
 *      a platform switch; passing Linux's 1 to Darwin asks for
 *      `CLOCK_REALTIME_COARSE`-shaped nonsense rather than failing.
 *   2. Darwin's `CLOCK_MONOTONIC` is uptime, not an epoch — so a value that
 *      looks like realtime nanoseconds means the wrong clock answered.
 *   3. `Bun.nanoseconds()` is only a legitimate fast path if it is derived from
 *      the same counter. The probe harness decides that by measuring drift; this
 *      pins that the decision is *made* on this host rather than assumed.
 *
 * The test is skipped off Darwin: it is a statement about this generator host.
 */

import { describe, expect, test } from "bun:test";
import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

const isDarwin = process.platform === "darwin";
const describeDarwin = isDarwin ? describe : describe.skip;

/** Darwin's `CLOCK_MONOTONIC`. Linux calls the same name 1. */
const CLOCK_MONOTONIC_DARWIN = 6;
/** Darwin's `CLOCK_REALTIME`, read only to prove the two are distinguishable. */
const CLOCK_REALTIME_DARWIN = 0;

function openClock() {
	for (const candidate of ["libSystem.B.dylib", `libSystem.${suffix}`]) {
		try {
			const lib = dlopen(candidate, {
				clock_gettime: {
					args: [FFIType.i32, FFIType.ptr],
					returns: FFIType.i32,
				},
			});
			return lib.symbols.clock_gettime as (
				clockId: number,
				tsPtr: number,
			) => number;
		} catch {
			// Try the next name.
		}
	}
	throw new Error("could not dlopen libSystem for clock_gettime");
}

function makeReader(clockId: number): () => number {
	const clockGettime = openClock();
	const buf = new ArrayBuffer(16);
	const words = new Uint32Array(buf);
	const bufPtr = ptr(buf);
	return () => {
		if (clockGettime(clockId, bufPtr) !== 0)
			throw new Error("clock_gettime failed");
		const sec = (words[0] ?? 0) + (words[1] ?? 0) * 4294967296;
		const nsec = (words[2] ?? 0) + (words[3] ?? 0) * 4294967296;
		return sec * 1e9 + nsec;
	};
}

describeDarwin("CLOCK_MONOTONIC through Bun FFI on this generator host", () => {
	test("libSystem exposes clock_gettime and it succeeds", () => {
		const now = makeReader(CLOCK_MONOTONIC_DARWIN);
		expect(now()).toBeGreaterThan(0);
	});

	test("the monotonic clock is uptime, not an epoch — clock id 6 is the right one", () => {
		const monotonic = makeReader(CLOCK_MONOTONIC_DARWIN)();
		const realtime = makeReader(CLOCK_REALTIME_DARWIN)();
		// Realtime is nanoseconds since 1970: ~1.8e18 in 2026. Uptime on a machine
		// that reboots is orders of magnitude smaller. If the two were within a
		// factor of two of each other, id 6 would not be reading uptime.
		expect(realtime).toBeGreaterThan(1.7e18);
		expect(monotonic).toBeLessThan(realtime / 1000);
	});

	test("it never goes backwards across a tight read loop", () => {
		const now = makeReader(CLOCK_MONOTONIC_DARWIN);
		let previous = now();
		for (let i = 0; i < 20_000; i += 1) {
			const current = now();
			expect(current).toBeGreaterThanOrEqual(previous);
			previous = current;
		}
	});

	test("it advances at wall rate, so RTTs are in real milliseconds", async () => {
		const now = makeReader(CLOCK_MONOTONIC_DARWIN);
		const before = now();
		await Bun.sleep(120);
		const elapsedMs = (now() - before) / 1e6;
		// Generous both ways: a sleeping test process is at the scheduler's mercy.
		// The failure this catches is a clock running at the wrong *scale*.
		expect(elapsedMs).toBeGreaterThan(100);
		expect(elapsedMs).toBeLessThan(400);
	});

	test("its resolution is fine enough to measure a sub-millisecond cable RTT", () => {
		const now = makeReader(CLOCK_MONOTONIC_DARWIN);
		// A direct cable RTT is ~0.2 ms. A clock that only ticks each millisecond
		// would quantize that into two values and the p99 would be an artifact.
		let smallestStep = Number.POSITIVE_INFINITY;
		let previous = now();
		for (let i = 0; i < 50_000; i += 1) {
			const current = now();
			const step = current - previous;
			if (step > 0 && step < smallestStep) smallestStep = step;
			previous = current;
		}
		expect(smallestStep).toBeLessThan(10_000);
	});

	test("the Bun.nanoseconds fast path is decided by measurement, not assumption", async () => {
		const now = makeReader(CLOCK_MONOTONIC_DARWIN);
		const measureOffset = () => {
			const samples: number[] = [];
			for (let i = 0; i < 64; i += 1) {
				const b1 = Bun.nanoseconds();
				const f = now();
				const b2 = Bun.nanoseconds();
				samples.push(f - (b1 + b2) / 2);
			}
			samples.sort((a, b) => a - b);
			return samples[Math.floor(samples.length / 2)] ?? 0;
		};
		const first = measureOffset();
		await Bun.sleep(200);
		const second = measureOffset();
		const driftNs = Math.abs(second - first);
		// This is the harness's own predicate. It is not asserted to pass — a Bun
		// build whose nanoseconds() is a different counter is allowed, it just
		// means the run pays for the FFI read. What is asserted is that the
		// measurement is finite here, so the decision is a real one.
		expect(Number.isFinite(driftNs)).toBe(true);
		console.log(
			`mac-clock-pin: Bun.nanoseconds offset drift over 200ms = ${driftNs.toFixed(0)} ns (fast path qualifies below 1000)`,
		);
	});
});
