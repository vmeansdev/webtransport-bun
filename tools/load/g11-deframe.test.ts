import { describe, expect, test } from "bun:test";
import {
	DeframePool,
	deframeWorkerPlan,
	type DeframeSnapshot,
} from "./g11-deframe.ts";
import { encodeFrame, FRAME_HEADER_BYTES, FrameClass } from "./g11-frame.ts";
import { percentileMs, sampleCount } from "./g11-histogram.ts";

describe("deframeWorkerPlan", () => {
	test("auto keeps every cell at or below the threshold inline", () => {
		expect(deframeWorkerPlan(25, "auto", 50)).toBe(0);
		expect(deframeWorkerPlan(50, "auto", 50)).toBe(0);
	});

	test("auto sizes one worker per threshold's worth of sessions above it", () => {
		expect(deframeWorkerPlan(100, "auto", 50)).toBe(2);
		expect(deframeWorkerPlan(101, "auto", 50)).toBe(3);
		expect(deframeWorkerPlan(200, "auto", 50)).toBe(4);
	});

	test("an explicit integer overrides at any session count", () => {
		expect(deframeWorkerPlan(4, "2", 50)).toBe(2);
		expect(deframeWorkerPlan(100, "0", 50)).toBe(0);
	});

	test("refuses a value that is neither auto nor a non-negative integer", () => {
		expect(() => deframeWorkerPlan(100, "two", 50)).toThrow();
		expect(() => deframeWorkerPlan(100, "-1", 50)).toThrow();
		expect(() => deframeWorkerPlan(100, "1.5", 50)).toThrow();
	});
});

const FRAME_BYTES = 64;

function frame(session: number, sequence: number, sendWallNs: bigint): Buffer {
	const chunk = Buffer.alloc(FRAME_BYTES);
	encodeFrame(chunk, {
		totalLength: FRAME_BYTES,
		frameClass: FrameClass.TunnelUp,
		session,
		sequence,
		sendWallNs,
	});
	return chunk;
}

async function finishAndTerminate(
	pool: DeframePool,
): Promise<DeframeSnapshot | null> {
	const snap = await pool.finish();
	pool.terminate();
	return snap;
}

describe("DeframePool", () => {
	test("round-trips frames split across chunk and batch boundaries", async () => {
		const progressed: number[] = [];
		const pool = new DeframePool(2, {
			onProgress: (frames) => progressed.push(frames),
		});
		const streams = [pool.openStream(), pool.openStream(), pool.openStream()];
		const base = 1_000_000_000_000n;
		const framesPerStream = 200;
		for (let i = 0; i < framesPerStream; i += 1) {
			for (let s = 0; s < streams.length; s += 1) {
				// Stamped 2 ms before "arrival", so every latency sample is 2 ms.
				const payload = frame(s, i, base + BigInt(i) * 1_000_000n);
				const arrival = base + BigInt(i) * 1_000_000n + 2_000_000n;
				// Split every frame across two pushes: the worker's Deframer must
				// reassemble exactly as the inline one did.
				const key = streams[s] as number;
				pool.push(key, arrival, payload.subarray(0, 30));
				pool.push(key, arrival, payload.subarray(30));
			}
		}
		const snap = await finishAndTerminate(pool);
		expect(pool.failure).toBeNull();
		expect(snap).not.toBeNull();
		const s = snap as DeframeSnapshot;
		expect(s.upFrames).toBe(framesPerStream * streams.length);
		expect(s.deframeErrors).toBe(0);
		expect(s.latency.negativeCount).toBe(0);
		expect(sampleCount(s.latency)).toBe(framesPerStream * streams.length);
		// Every sample is exactly 2 ms; the p99 lands on a bucket edge near it.
		expect(percentileMs(s.latency, 0.99)).toBeGreaterThan(1.5);
		expect(percentileMs(s.latency, 0.99)).toBeLessThan(2.5);
		for (let sess = 0; sess < streams.length; sess += 1)
			expect(s.perSessionUpBytes.get(sess)).toBe(framesPerStream * FRAME_BYTES);
		// Progress reached the callback and sums to the population.
		expect(progressed.reduce((a, b) => a + b, 0)).toBe(
			framesPerStream * streams.length,
		);
	});

	test("a deframe fault counts once and kills only its stream", async () => {
		const pool = new DeframePool(1, {});
		const bad = pool.openStream();
		const good = pool.openStream();
		// A length prefix below the header size is the Deframer's throw path.
		const garbage = Buffer.alloc(FRAME_BYTES);
		garbage.writeUInt16LE(FRAME_HEADER_BYTES - 1, 0);
		pool.push(bad, 1n, garbage);
		pool.push(bad, 1n, frame(0, 0, 0n)); // Dropped: the stream is dead.
		pool.push(good, 3_000_000n, frame(7, 0, 1_000_000n));
		const snap = await finishAndTerminate(pool);
		expect(snap).not.toBeNull();
		const s = snap as DeframeSnapshot;
		expect(s.deframeErrors).toBe(1);
		expect(s.upFrames).toBe(1);
		expect(s.perSessionUpBytes.get(7)).toBe(FRAME_BYTES);
	});

	test("an unreachable worker script is a pool failure, not a smaller population", async () => {
		const pool = new DeframePool(1, {
			workerUrl: new URL("./g11-deframe-does-not-exist.ts", import.meta.url)
				.href,
		});
		pool.push(pool.openStream(), 1n, frame(0, 0, 0n));
		// The snapshot timeout is the backstop; the error event should land first.
		const finished = pool.finish();
		const failedFast = await Promise.race([
			finished.then(() => true),
			Bun.sleep(5000).then(() => false),
		]);
		expect(failedFast).toBe(true);
		expect(await finished).toBeNull();
		expect(pool.failure).not.toBeNull();
		pool.terminate();
	}, 15_000);
});
