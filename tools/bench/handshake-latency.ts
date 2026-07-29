#!/usr/bin/env bun
/**
 * Handshake latency benchmark: p50/p95/p99 connect times.
 * Uses addon server + client.
 */

import {
	connect,
	createServer,
} from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const PORT = Number(process.env.BENCH_PORT ?? 4443);
const N = Number(process.env.BENCH_HANDSHAKES ?? 50);
const CLOSE_TIMEOUT_MS = Number(process.env.BENCH_CLOSE_TIMEOUT_MS ?? 5_000);

function percentile(arr: number[], p: number): number {
	const sorted = [...arr].sort((a, b) => a - b);
	const i = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, i)] ?? 0;
}

async function main() {
	const cert = generateLocalhostCert();
	if (!cert) {
		throw new Error("handshake-latency: failed to generate localhost TLS cert");
	}
	const server = createServer({
		port: PORT,
		tls: { certPem: cert.certPem, keyPem: cert.keyPem },
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
	const closeLatencies: number[] = [];
	const url = `https://127.0.0.1:${PORT}`;

	for (let i = 0; i < N; i++) {
		const start = performance.now();
		try {
			const session = await connect(url, {
				tls: { caPem: cert.certPem, serverName: "localhost" },
			});
			latencies.push(performance.now() - start);
			session.close();
			const closeStartedAt = performance.now();
			await Promise.race([
				session.closed.then(
					() => undefined,
					() => undefined,
				),
				Bun.sleep(CLOSE_TIMEOUT_MS),
			]);
			closeLatencies.push(
				Number(
					Math.min(
						performance.now() - closeStartedAt,
						CLOSE_TIMEOUT_MS,
					).toFixed(3),
				),
			);
		} catch (err) {
			console.warn("[handshake-latency] connect failed during sample:", err);
		}
	}

	await server.close();
	await Bun.sleep(500);
	cert.cleanup();

	if (latencies.length < N / 2) {
		console.error("handshake-latency: too many failures, aborting");
		process.exit(1);
	}

	const p50 = percentile(latencies, 50);
	const p95 = percentile(latencies, 95);
	const p99 = percentile(latencies, 99);
	const closeP99 = percentile(closeLatencies, 99);
	console.log(
		`handshake-latency: n=${latencies.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms p99=${p99.toFixed(1)}ms close-p99=${closeP99.toFixed(1)}ms`,
	);
	console.log(
		JSON.stringify({
			name: "handshake-latency",
			samples: latencies.length,
			p50_ms: Number(p50.toFixed(3)),
			p95_ms: Number(p95.toFixed(3)),
			p99_ms: Number(p99.toFixed(3)),
			close_latency_p99_ms: Number(closeP99.toFixed(3)),
		}),
	);

	console.log("handshake-latency: PASS");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
