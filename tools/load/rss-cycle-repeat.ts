#!/usr/bin/env bun

/**
 * Masking guard for the allocator-relief work: create, exercise and fully close
 * a native server three times in ONE process and compare post-close RSS across
 * cycles. Relief that only flattens a single close while residency still grows
 * cycle over cycle is masking, not recovery.
 *
 * The workload is deliberately tiny and in-process (one client session, one
 * bidi stream, one datagram) so this driver needs no external load client.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	connect,
	createServer,
	type ServerSession,
} from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	type AllocatorReliefTelemetry,
	toAllocatorReliefTelemetry,
} from "./distributed-scale.ts";

/**
 * One uncounted warmup cycle precedes the three measured cycles: the first
 * full create/load/close pass amortizes runtime lazy initialization (JIT
 * tiers, allocator arenas — ~6 MB on Linux, ~1 MB on macOS), which is
 * one-time cost, not per-cycle growth. The guard's purpose is detecting
 * growth that purging would otherwise mask, so it judges steady-state cycles
 * — the same principle as the harness's service-ready warmup.
 */
const WARMUP_CYCLES = 1;
const CYCLES = 3;
const MAX_CYCLE_RATIO = 1.05;
const CLOSE_TIMEOUT_MS = 10_000;
const DEFAULT_ARTIFACT_PATH = resolve(
	"/private/tmp",
	"webtransport-rss-cycle-repeat.json",
);

export type CycleSample = {
	cycle: number;
	postCloseRssMb: number;
	sessionsObserved: number;
	streamsObserved: number;
	datagramsObserved: number;
	allocatorRelief: AllocatorReliefTelemetry | null;
};

export function evaluateCycleRepeat(
	cycles: { postCloseRssMb: number }[],
	maxRatio = MAX_CYCLE_RATIO,
): { ratioCycle3ToCycle1: number | null; failures: string[] } {
	if (cycles.length !== CYCLES) {
		return {
			ratioCycle3ToCycle1: null,
			failures: [
				`cycle repeat recorded ${cycles.length} cycles; ${CYCLES} are required`,
			],
		};
	}
	const first = cycles[0] as { postCloseRssMb: number };
	const last = cycles[CYCLES - 1] as { postCloseRssMb: number };
	if (!(first.postCloseRssMb > 0)) {
		return {
			ratioCycle3ToCycle1: null,
			failures: ["cycle-1 post-close RSS was not a positive sample"],
		};
	}
	const ratio = Number((last.postCloseRssMb / first.postCloseRssMb).toFixed(4));
	return {
		ratioCycle3ToCycle1: ratio,
		failures:
			ratio > maxRatio
				? [
						`cycle-3 post-close RSS ${last.postCloseRssMb.toFixed(3)}MB exceeded cycle-1 ${first.postCloseRssMb.toFixed(3)}MB * ${maxRatio} (ratio ${ratio})`,
					]
				: [],
	};
}

function rssMb(): number {
	return Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(3));
}

async function settleAndSampleRss(): Promise<number> {
	if (typeof Bun.gc === "function") {
		for (let pass = 0; pass < 3; pass += 1) {
			Bun.gc(true);
			await Bun.sleep(100);
		}
	}
	await Bun.sleep(250);
	return rssMb();
}

async function runCycle(
	cycle: number,
	cert: { certPem: string; keyPem: string },
): Promise<CycleSample> {
	let sessionsObserved = 0;
	let streamsObserved = 0;
	let datagramsObserved = 0;
	const serverTasks: Promise<void>[] = [];

	const server = createServer({
		port: 0,
		tls: { certPem: cert.certPem, keyPem: cert.keyPem },
		onSession: (session: ServerSession) => {
			sessionsObserved += 1;
			serverTasks.push(
				(async () => {
					const streams = session.incomingBidirectionalStreams.getReader();
					try {
						const { value } = await streams.read();
						if (!value) return;
						streamsObserved += 1;
						const reader = value.readable.getReader();
						try {
							await reader.read();
						} finally {
							reader.releaseLock();
						}
					} finally {
						streams.releaseLock();
					}
				})().catch(() => undefined),
			);
			serverTasks.push(
				(async () => {
					for await (const _datagram of session.incomingDatagrams()) {
						datagramsObserved += 1;
						break;
					}
				})().catch(() => undefined),
			);
		},
	});

	const client = await connect(`https://127.0.0.1:${server.address.port}`, {
		tls: { insecureSkipVerify: true },
	});
	const stream = await client.createBidirectionalStream();
	stream.write(new Uint8Array([cycle]));
	stream.end();
	await client.sendDatagram(new Uint8Array([cycle]));
	await Bun.sleep(250);
	client.close();
	await Promise.race([Promise.allSettled(serverTasks), Bun.sleep(2_000)]);
	const closeResult = await Promise.race([
		server.close(),
		Bun.sleep(CLOSE_TIMEOUT_MS).then(() => {
			throw new Error(`cycle ${cycle} server.close timed out`);
		}),
	]);
	serverTasks.length = 0;

	return {
		cycle,
		postCloseRssMb: await settleAndSampleRss(),
		sessionsObserved,
		streamsObserved,
		datagramsObserved,
		allocatorRelief: toAllocatorReliefTelemetry("campaign", closeResult),
	};
}

export async function runCycleRepeat(): Promise<{
	warmup: CycleSample | null;
	cycles: CycleSample[];
	ratioCycle3ToCycle1: number | null;
	failures: string[];
}> {
	const cert = generateLocalhostCert();
	if (!cert) {
		throw new Error("rss-cycle-repeat: failed to generate localhost TLS cert");
	}
	const cycles: CycleSample[] = [];
	let warmup: CycleSample | null = null;
	try {
		for (let i = 1; i <= WARMUP_CYCLES; i += 1) {
			warmup = await runCycle(0, cert);
		}
		for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
			cycles.push(await runCycle(cycle, cert));
		}
	} finally {
		cert.cleanup();
	}
	const warmupFailures =
		warmup &&
		(warmup.sessionsObserved === 0 ||
			warmup.streamsObserved === 0 ||
			warmup.datagramsObserved === 0)
			? [
					`warmup cycle did not exercise the stack: sessions=${warmup.sessionsObserved} streams=${warmup.streamsObserved} datagrams=${warmup.datagramsObserved}`,
				]
			: [];
	const workloadFailures = cycles
		.filter(
			(sample) =>
				sample.sessionsObserved === 0 ||
				sample.streamsObserved === 0 ||
				sample.datagramsObserved === 0,
		)
		.map(
			(sample) =>
				`cycle ${sample.cycle} did not exercise the stack: sessions=${sample.sessionsObserved} streams=${sample.streamsObserved} datagrams=${sample.datagramsObserved}`,
		);
	const verdict = evaluateCycleRepeat(cycles);
	return {
		warmup,
		cycles,
		ratioCycle3ToCycle1: verdict.ratioCycle3ToCycle1,
		failures: [...warmupFailures, ...workloadFailures, ...verdict.failures],
	};
}

if (import.meta.main) {
	const artifactPath =
		process.env.LOAD_SCALE_ARTIFACT_OUT?.trim() || DEFAULT_ARTIFACT_PATH;
	const result = await runCycleRepeat();
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(
		artifactPath,
		JSON.stringify(
			{
				createdAt: new Date().toISOString(),
				bunVersion: Bun.version,
				maxCycleRatio: MAX_CYCLE_RATIO,
				...result,
			},
			null,
			2,
		),
	);
	for (const failure of result.failures) {
		console.error(`rss-cycle-repeat: ${failure}`);
	}
	console.log(`rss-cycle-repeat artifact: ${artifactPath}`);
	process.exit(result.failures.length === 0 ? 0 : 1);
}
