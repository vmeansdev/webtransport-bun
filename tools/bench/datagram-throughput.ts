#!/usr/bin/env bun
/**
 * Datagram throughput benchmark with in-process client/server metrics.
 * Reports throughput, loss ratio, event-loop delay, CPU user time, and peak RSS.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";

import {
	connect,
	createServer,
} from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const PORT = Number(process.env.BENCH_PORT ?? 4433);
const SESSION_COUNT = Number(process.env.BENCH_SESSIONS ?? 4);
const DATAGRAMS_PER_SESSION = Number(
	process.env.BENCH_DATAGRAMS_PER_SESSION ?? 2_500,
);
const PAYLOAD_SIZE = Number(process.env.BENCH_DATAGRAM_SIZE ?? 512);
const SETTLE_TIMEOUT_MS = Number(process.env.BENCH_SETTLE_TIMEOUT_MS ?? 5_000);
const SETTLE_QUIET_MS = Number(process.env.BENCH_SETTLE_QUIET_MS ?? 250);
const SAMPLE_INTERVAL_MS = Number(process.env.BENCH_SAMPLE_INTERVAL_MS ?? 25);

async function waitForSettle(
	readCount: () => number,
	targetCount: number,
	timeoutMs: number,
	quietMs: number,
) {
	const startedAt = performance.now();
	let lastCount = readCount();
	let lastChangedAt = startedAt;
	while (performance.now() - startedAt < timeoutMs) {
		await Bun.sleep(25);
		const current = readCount();
		if (current !== lastCount) {
			lastCount = current;
			lastChangedAt = performance.now();
		}
		if (current >= targetCount) {
			return current;
		}
		if (performance.now() - lastChangedAt >= quietMs) {
			return current;
		}
	}
	return readCount();
}

async function main() {
	const cert = generateLocalhostCert();
	if (!cert) {
		throw new Error(
			"datagram-throughput: failed to generate localhost TLS cert",
		);
	}

	const payload = new Uint8Array(PAYLOAD_SIZE).fill(0x61);
	let receivedDatagrams = 0;
	let peakRssMiB = process.memoryUsage().rss / (1024 * 1024);
	const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
	const rssSampler = setInterval(() => {
		peakRssMiB = Math.max(
			peakRssMiB,
			process.memoryUsage().rss / (1024 * 1024),
		);
	}, SAMPLE_INTERVAL_MS);
	eventLoopDelay.enable();

	const server = createServer({
		port: PORT,
		tls: { certPem: cert.certPem, keyPem: cert.keyPem },
		onSession: (session) => {
			void (async () => {
				for await (const _datagram of session.incomingDatagrams()) {
					receivedDatagrams += 1;
				}
			})().catch((error) => {
				console.warn(
					"datagram-throughput: incoming datagram drain failed:",
					error,
				);
			});
		},
	});

	const clients = [];
	const cpuStartedAt = process.cpuUsage();
	const benchmarkStartedAt = performance.now();

	try {
		await Bun.sleep(1_000);
		const url = `https://127.0.0.1:${PORT}`;
		for (let i = 0; i < SESSION_COUNT; i++) {
			clients.push(
				await connect(url, {
					tls: { caPem: cert.certPem, serverName: "localhost" },
				}),
			);
		}

		await Promise.all(
			clients.map(async (client) => {
				for (let i = 0; i < DATAGRAMS_PER_SESSION; i++) {
					await client.sendDatagram(payload);
				}
			}),
		);

		const totalSent = SESSION_COUNT * DATAGRAMS_PER_SESSION;
		const observedAfterSettle = await waitForSettle(
			() => receivedDatagrams,
			totalSent,
			SETTLE_TIMEOUT_MS,
			SETTLE_QUIET_MS,
		);
		const elapsedSecs = (performance.now() - benchmarkStartedAt) / 1000;
		const throughput = totalSent / elapsedSecs;
		const delivered = Math.min(totalSent, observedAfterSettle);
		const lossRatio = totalSent === 0 ? 0 : (totalSent - delivered) / totalSent;
		const cpuUsage = process.cpuUsage(cpuStartedAt);

		console.log(
			[
				"datagram-throughput:",
				`sent=${totalSent}`,
				`received=${delivered}`,
				`elapsed=${elapsedSecs.toFixed(3)}s`,
				`throughput=${throughput.toFixed(1)} dgram/s`,
				`loss=${lossRatio.toFixed(6)}`,
			].join(" "),
		);
		console.log(
			JSON.stringify({
				name: "datagram-throughput",
				sent: totalSent,
				received: delivered,
				throughput_dgrams_per_sec: Number(throughput.toFixed(3)),
				loss_ratio: Number(lossRatio.toFixed(6)),
				event_loop_delay_p99_ms: Number(
					(eventLoopDelay.percentile(99) / 1_000_000).toFixed(3),
				),
				cpu_user_ms: Number((cpuUsage.user / 1000).toFixed(3)),
				peak_rss_mib: Number(peakRssMiB.toFixed(3)),
			}),
		);
	} finally {
		clearInterval(rssSampler);
		eventLoopDelay.disable();
		for (const client of clients) {
			client.close();
		}
		await server.close();
		cert.cleanup();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
