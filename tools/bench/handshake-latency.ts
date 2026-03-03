#!/usr/bin/env bun
/**
 * Handshake latency benchmark: p50/p95/p99 connect times.
 * Uses addon server + client.
 */

import {
	createServer,
	connect,
} from "../../packages/webtransport/src/index.ts";

const PORT = Number(process.env.BENCH_PORT ?? 4443);
const N = Number(process.env.BENCH_HANDSHAKES ?? 50);
const P95_MAX_MS = Number(process.env.BENCH_P95_MAX_MS ?? 500);

function percentile(arr: number[], p: number): number {
	const sorted = [...arr].sort((a, b) => a - b);
	const i = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, i)] ?? 0;
}

async function main() {
	const server = createServer({
		port: PORT,
		tls: { certPem: "", keyPem: "" },
		onSession: (s) => {
			s.closed
				.then(() => {})
				.catch((err) => {
					console.warn("[handshake-latency] session closed rejection:", err);
				});
		},
	});
	await Bun.sleep(2000);

	const latencies: number[] = [];
	const url = `https://127.0.0.1:${PORT}`;

	for (let i = 0; i < N; i++) {
		const start = performance.now();
		try {
			const session = await connect(url, { tls: { insecureSkipVerify: true } });
			latencies.push(performance.now() - start);
			session.close();
		} catch (err) {
			console.warn("[handshake-latency] connect failed during sample:", err);
		}
	}

	await server.close();
	await Bun.sleep(500);

	if (latencies.length < N / 2) {
		console.error("handshake-latency: too many failures, aborting");
		process.exit(1);
	}

	const p50 = percentile(latencies, 50);
	const p95 = percentile(latencies, 95);
	const p99 = percentile(latencies, 99);
	console.log(
		`handshake-latency: n=${latencies.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms (threshold p95<=${P95_MAX_MS}ms)`,
	);

	if (p95 > P95_MAX_MS) {
		console.error(
			`handshake-latency: FAIL (p95 ${p95.toFixed(1)}ms exceeds threshold ${P95_MAX_MS}ms)`,
		);
		process.exit(1);
	}

	console.log("handshake-latency: PASS");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
