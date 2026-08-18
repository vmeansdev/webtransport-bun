/**
 * CLOCK_MONOTONIC, read from Bun, on the same epoch the Rust load client sees.
 *
 * One-way latency across two processes only means something if both ends read
 * the same counter. On Linux `clock_gettime(CLOCK_MONOTONIC)` is one system-wide
 * counter, so a Rust `libc::clock_gettime` read and a Bun FFI read of the same
 * clock share an epoch exactly — no realtime, no NTP, no calibration constant.
 *
 * The FFI call costs ~100 ns, which is real money on a path that sees 100k
 * datagrams/s. So we also try a fast path: `Bun.nanoseconds()` plus a fixed
 * offset. That is only sound if `Bun.nanoseconds()` is derived from the *same*
 * counter, which we test rather than assume — two offset measurements 200 ms
 * apart must agree to under a microsecond. If they don't, we keep the FFI read
 * and pay for it.
 */

import { dlopen, FFIType, ptr, suffix } from "bun:ffi";

/** Linux `CLOCK_MONOTONIC`; on macOS the same name is 6. */
const CLOCK_MONOTONIC = process.platform === "darwin" ? 6 : 1;

const LIBC_CANDIDATES =
	process.platform === "darwin"
		? ["libSystem.B.dylib", `libSystem.${suffix}`]
		: ["libc.so.6", "libc.so", `libc.${suffix}.6`];

export type MonotonicClock = {
	/** Absolute CLOCK_MONOTONIC nanoseconds, as an exactly-representable double. */
	now(): number;
	/** "ffi" (per-read syscall) or "bun-nanoseconds" (offset fast path). */
	source: "ffi" | "bun-nanoseconds";
	/**
	 * Drift between two offset measurements 200 ms apart, in nanoseconds. Zero
	 * on the FFI path, where both processes read the same counter by
	 * construction. Feeds the `clock-invalid` STOP condition.
	 */
	calibrationResidualNs: number;
	/** Spread of the 64 sandwiched offset samples; diagnostic only. */
	calibrationSpreadNs: number;
};

function openClockGettime(): (clockId: number, timespecPtr: number) => number {
	let lastError: unknown;
	for (const candidate of LIBC_CANDIDATES) {
		try {
			const lib = dlopen(candidate, {
				clock_gettime: {
					args: [FFIType.i32, FFIType.ptr],
					returns: FFIType.i32,
				},
			});
			return lib.symbols.clock_gettime as (a: number, b: number) => number;
		} catch (err) {
			lastError = err;
		}
	}
	throw new Error(
		`latency-clock: could not dlopen libc for clock_gettime (${String(lastError)})`,
	);
}

/**
 * A `struct timespec` is two 64-bit words on every platform this harness runs
 * on. We read it as four little-endian u32s so the hot path never allocates a
 * BigInt. Seconds stay well under 2^32 (that is 136 years of uptime), so the
 * high words are read for correctness and are normally zero.
 */
function makeFfiReader(): () => number {
	const clockGettime = openClockGettime();
	const buf = new ArrayBuffer(16);
	const words = new Uint32Array(buf);
	const bufPtr = ptr(buf);
	return () => {
		if (clockGettime(CLOCK_MONOTONIC, bufPtr) !== 0) {
			throw new Error("latency-clock: clock_gettime failed");
		}
		const sec = (words[0] ?? 0) + (words[1] ?? 0) * 4294967296;
		const nsec = (words[2] ?? 0) + (words[3] ?? 0) * 4294967296;
		return sec * 1e9 + nsec;
	};
}

/**
 * Median of 64 offsets between the FFI clock and `Bun.nanoseconds()`, each
 * sandwiched (bun, ffi, bun) so the FFI call's own duration cancels out.
 */
function measureOffset(ffiNow: () => number): {
	offsetNs: number;
	spreadNs: number;
} {
	const samples: number[] = [];
	for (let i = 0; i < 64; i += 1) {
		const b1 = Bun.nanoseconds();
		const f = ffiNow();
		const b2 = Bun.nanoseconds();
		samples.push(f - (b1 + b2) / 2);
	}
	samples.sort((a, b) => a - b);
	const offsetNs = samples[Math.floor(samples.length / 2)] ?? 0;
	const spreadNs = (samples[samples.length - 1] ?? 0) - (samples[0] ?? 0);
	return { offsetNs, spreadNs };
}

/**
 * Build the clock. `allowFastPath: false` forces the FFI read, which is what a
 * run wants when it would rather pay 100 ns than defend an assumption.
 */
export async function createMonotonicClock(
	allowFastPath = true,
): Promise<MonotonicClock> {
	const ffiNow = makeFfiReader();
	if (!allowFastPath) {
		return {
			now: ffiNow,
			source: "ffi",
			calibrationResidualNs: 0,
			calibrationSpreadNs: 0,
		};
	}

	const first = measureOffset(ffiNow);
	await Bun.sleep(200);
	const second = measureOffset(ffiNow);
	const driftNs = Math.abs(second.offsetNs - first.offsetNs);
	const spreadNs = Math.max(first.spreadNs, second.spreadNs);

	// Under a microsecond of drift across 200 ms means the same counter, not two
	// counters that happen to be close. 50 µs of sampling spread means the
	// measurement itself was too noisy to make that call.
	if (driftNs >= 1_000 || spreadNs >= 50_000) {
		return {
			now: ffiNow,
			source: "ffi",
			calibrationResidualNs: 0,
			calibrationSpreadNs: spreadNs,
		};
	}

	const offsetNs = second.offsetNs;
	return {
		now: () => Bun.nanoseconds() + offsetNs,
		source: "bun-nanoseconds",
		calibrationResidualNs: driftNs,
		calibrationSpreadNs: spreadNs,
	};
}
