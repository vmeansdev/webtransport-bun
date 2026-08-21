/**
 * G11's deframe worker: one Bun Worker's share of the upstream receive-side
 * bookkeeping the conductor's main thread used to do inline. See
 * `g11-deframe.ts` for the design and what it preserves.
 *
 * The worker holds one `Deframer` per stream key (the exact per-stream state
 * the inline reader held), decodes every frame, and records
 * `arrival - sendWallNs` into the same histogram class the main thread uses —
 * the arrival stamp was taken on the main thread at the read() resolution and
 * rides in the batch, so nothing here touches a clock.
 *
 * A deframe error on a stream counts once and kills that stream's decoding
 * (the inline reader's catch ended its read loop the same way); subsequent
 * chunks for the key are dropped rather than fed to corrupt state.
 */

import type {
	DeframeChunkBatch,
	DeframeFinish,
	DeframeProgress,
	DeframeWorkerSnapshot,
} from "./g11-deframe.ts";
import { Deframer } from "./g11-frame.ts";
import { G11Histogram } from "./g11-histogram.ts";

declare var self: Worker;

const deframers = new Map<number, Deframer>();
const dead = new Set<number>();
const latency = new G11Histogram();
const perSessionUpBytes = new Map<number, number>();
let upFrames = 0;
let deframeErrors = 0;

function processBatch(batch: DeframeChunkBatch): number {
	const data = new Uint8Array(batch.data);
	const streams = new Uint32Array(batch.streams);
	const arrivals = new BigUint64Array(batch.arrivals);
	const offsets = new Uint32Array(batch.offsets);
	const lengths = new Uint32Array(batch.lengths);
	let frames = 0;
	for (let i = 0; i < batch.count; i += 1) {
		const key = streams[i] as number;
		if (dead.has(key)) continue;
		const arrival = arrivals[i] as bigint;
		const chunk = data.subarray(
			offsets[i] as number,
			(offsets[i] as number) + (lengths[i] as number),
		);
		let deframer = deframers.get(key);
		if (!deframer) {
			deframer = new Deframer();
			deframers.set(key, deframer);
		}
		try {
			for (const frame of deframer.push(chunk)) {
				frames += 1;
				latency.recordNs(arrival - frame.sendWallNs);
				perSessionUpBytes.set(
					frame.session,
					(perSessionUpBytes.get(frame.session) ?? 0) + frame.totalLength,
				);
			}
		} catch (err) {
			deframeErrors += 1;
			dead.add(key);
			deframers.delete(key);
			console.error(`g11 deframe worker: stream ${key} deframe failed: ${err}`);
		}
	}
	upFrames += frames;
	return frames;
}

self.onmessage = (event: MessageEvent) => {
	const msg = event.data as DeframeChunkBatch | DeframeFinish;
	if (msg.type === "chunks") {
		const frames = processBatch(msg);
		if (frames > 0)
			self.postMessage({ type: "progress", frames } satisfies DeframeProgress);
	} else if (msg.type === "finish") {
		self.postMessage({
			type: "snapshot",
			upFrames,
			deframeErrors,
			latency: latency.snapshot(),
			perSessionUpBytes: [...perSessionUpBytes],
		} satisfies DeframeWorkerSnapshot);
	}
};
