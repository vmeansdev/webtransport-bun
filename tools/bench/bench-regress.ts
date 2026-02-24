#!/usr/bin/env bun
/**
 * Benchmark regression gate. Runs throughput benchmarks and fails if below threshold.
 * Output: JSON lines (one per benchmark) for parsing.
 *
 * Thresholds (override with env):
 * - STREAM_MIN_MBPS: minimum stream throughput MB/s (default 0.5)
 */
import { $ } from "bun";

const ROOT = import.meta.dir + "/../..";
const STREAM_MIN_MBPS = Number(process.env.STREAM_MIN_MBPS ?? 0.5);

async function runStreamBench(): Promise<{ throughput_mbps: number } | null> {
	const proc = await $`cd ${ROOT} && bun tools/bench/stream-throughput.ts`
		.quiet()
		.nothrow();
	const out = (await proc.text()).trim();
	const line = out.split("\n").pop();
	if (!line) return null;
	try {
		return JSON.parse(line) as { throughput_mbps: number };
	} catch {
		return null;
	}
}

async function main() {
	console.log("Running stream throughput benchmark...");
	const streamResult = await runStreamBench();
	if (!streamResult) {
		console.error("bench-regress: could not parse stream benchmark output");
		process.exit(1);
	}
	console.log(`stream-throughput: ${streamResult.throughput_mbps} MB/s`);

	if (streamResult.throughput_mbps < STREAM_MIN_MBPS) {
		console.error(
			`bench-regress: stream throughput ${streamResult.throughput_mbps} MB/s below threshold ${STREAM_MIN_MBPS}`,
		);
		process.exit(1);
	}
	console.log("bench-regress: OK");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
