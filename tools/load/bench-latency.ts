#!/usr/bin/env bun
/**
 * Latency ladder against the addon server — one *arm* per process.
 *
 * Every earlier bench in this repo reported throughput and delivery ratio and
 * nothing about *when* a datagram arrived. This one measures the interval the
 * H7 batch gate actually trades against: from the load client's send call to the
 * moment the datagram reaches the JavaScript handler body. Both ends read the
 * same `CLOCK_MONOTONIC` counter, so the one-way number is real rather than a
 * differenced round trip.
 *
 * An arm is `(batch knob, arrival profile)`. The batch knob is read once at
 * import by `packages/webtransport`, so it cannot be varied inside a process —
 * hence one process per arm, and `tools/load/latency-classify.ts` to merge them.
 *
 * Method, buckets and STOP conditions are pre-registered in
 * `docs/research/preregistrations/latency.md`. This file implements that
 * document; it does not get to reinterpret it.
 *
 * Single-host caveat, and it is a real one: the load client shares the 4 vCPU
 * with the server, so every percentile here is an *upper bound* on server
 * latency. `scheduleLag` is the client's own queueing, reported separately and
 * wired to the generator-saturation STOP so co-residence cannot masquerade as
 * server tail.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import { createMonotonicClock } from "./latency-clock.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";
import { STAMP_BYTES, decodeStamp } from "./latency-stamp.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;

export type ArrivalProfile = "uniform" | "tick";

const ARM = process.env.LATENCY_ARM ?? "default";
const SESSIONS = parseInt(process.env.LATENCY_SESSIONS ?? "100", 10);
const PAYLOAD_BYTES = parseInt(process.env.LATENCY_PAYLOAD_BYTES ?? "1150", 10);
const STEP_SECONDS = parseInt(process.env.LATENCY_STEP_SECONDS ?? "60", 10);
const SETTLE_MS = parseInt(process.env.LATENCY_SETTLE_MS ?? "10000", 10);
const TICK_HZ = parseInt(process.env.LATENCY_TICK_HZ ?? "64", 10);
const ARRIVAL: ArrivalProfile =
	process.env.LATENCY_ARRIVAL === "tick" ? "tick" : "uniform";
const ECHO = (process.env.LATENCY_ECHO ?? "1") !== "0";
const PORT = parseInt(process.env.LATENCY_PORT ?? "4433", 10);
/** Per-session datagrams/s. Aggregate = this × sessions. */
const RATES = (process.env.LATENCY_RATES ?? "100,250,500,750,900,1100")
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
const OUT_JSON =
	process.env.LATENCY_OUT ?? join(ROOT, `tools/load/bench-latency-${ARM}.json`);

const HAS_PROC = process.platform === "linux";

function serverCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

type CpuSnapshot = { busy: number; total: number };

function readHostCpu(): CpuSnapshot | null {
	if (!HAS_PROC) return null;
	const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
	const fields = line.trim().split(/\s+/).slice(1).map(Number);
	const total = fields.reduce((a, b) => a + b, 0);
	const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
	return { busy: total - idle, total };
}

function hostCpuPct(prev: CpuSnapshot | null, next: CpuSnapshot | null) {
	if (!prev || !next || next.total === prev.total) return null;
	return ((next.busy - prev.busy) / (next.total - prev.total)) * 100;
}

export type ClientLatencyJson = {
	arrival: string;
	effectiveDatagramsPerSecPerSession: number;
	rtt: LatencyHistogramJson;
	/** Wake lateness of the first datagram in each send event. */
	scheduleLag: LatencyHistogramJson;
	/** First-to-last duration of one send event; zero in the uniform arm. */
	burstSpread: LatencyHistogramJson;
	echoUnstamped: number;
	ticksSkipped: number;
	sendEvents: number;
};

export type LatencyStep = {
	perSessionRate: number;
	aggregateRate: number;
	elapsedSec: number;
	requestedDatagrams: number;
	clientSent: number;
	clientErr: number;
	clientReceived: number;
	serverRx: number;
	serverStamped: number;
	serverUnstamped: number;
	echoSent: number;
	echoErr: number;
	upDeliveryRatio: number | null;
	/** Server-side one-way: client send call → JS handler body. */
	ingest: LatencyHistogramJson;
	client: ClientLatencyJson | null;
	hostCpuPctMedian: number | null;
	serverCpuPct: number;
	sessionsOk: number;
	sessionsErr: number;
};

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

async function main(): Promise<void> {
	if (RATES.length === 0)
		throw new Error("LATENCY_RATES parsed to an empty ladder");
	if (PAYLOAD_BYTES < STAMP_BYTES) {
		throw new Error(
			`LATENCY_PAYLOAD_BYTES must be >= ${STAMP_BYTES} to carry a stamp`,
		);
	}

	const clock = await createMonotonicClock();
	console.log(
		`bench-latency: arm=${ARM} arrival=${ARRIVAL} clock=${clock.source} residual=${clock.calibrationResidualNs.toFixed(0)}ns spread=${clock.calibrationSpreadNs.toFixed(0)}ns batchEnv=${process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? "(default)"}`,
	);

	console.log("bench-latency: building load-client (release)...");
	try {
		await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();
	} catch (err) {
		if (!(await Bun.file(CLIENT_BIN).exists())) throw err;
		console.warn(
			"bench-latency: cargo build failed; falling back to existing load-client binary",
		);
	}

	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	const ingest = new LatencyHistogram();
	let serverRx = 0;
	let serverStamped = 0;
	let serverUnstamped = 0;
	let echoSent = 0;
	let echoErr = 0;

	const aggregatePeak = SESSIONS * Math.max(...RATES);
	const server = createServer({
		port: PORT,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: SESSIONS + 100,
			maxHandshakesInFlight: SESSIONS + 100,
		},
		rateLimits: {
			handshakesPerSec: Math.max(SESSIONS * 2, 400),
			handshakesBurst: Math.max(SESSIONS * 4, 1000),
			handshakesBurstPerPrefix: Math.max(SESSIONS * 4, 1000),
			streamsPerSec: 1000,
			streamsBurst: 2000,
			// Four times the top ladder step: measure the host, never the limiter.
			datagramsPerSec: aggregatePeak * 4,
			datagramsBurst: aggregatePeak * 8,
		},
		onSession: (session) => {
			void (async () => {
				for await (const datagram of session.incomingDatagrams()) {
					// First statement in the body: everything after this point is
					// the bench's own cost, not the transport's.
					const arrivedNs = clock.now();
					serverRx += 1;
					const stamp = decodeStamp(datagram);
					if (stamp === null) {
						serverUnstamped += 1;
					} else {
						serverStamped += 1;
						ingest.record(arrivedNs - stamp.actualNs);
					}
					if (!ECHO) continue;
					try {
						await session.sendDatagram(datagram);
						echoSent += 1;
					} catch {
						echoErr += 1;
					}
				}
			})().catch(() => {});
		},
	});
	// createServer has no readiness promise; same 3s the other load tools use.
	await Bun.sleep(3000);
	console.log(
		`bench-latency: server up port=${PORT} sessions=${SESSIONS} payload=${PAYLOAD_BYTES}B step=${STEP_SECONDS}s echo=${ECHO} ladder=[${RATES.join(",")}]/s/session`,
	);

	const steps: LatencyStep[] = [];
	for (const [index, rate] of RATES.entries()) {
		const aggregate = SESSIONS * rate;
		console.log(
			`bench-latency: step ${index + 1}/${RATES.length} rate=${rate}/s/session aggregate=${aggregate}/s`,
		);
		ingest.reset();
		const rx0 = serverRx;
		const stamped0 = serverStamped;
		const unstamped0 = serverUnstamped;
		const echo0 = echoSent;
		const echoErr0 = echoErr;
		const cpuMs0 = serverCpuMs();
		const startedAt = Date.now();

		const args = [
			CLIENT_BIN,
			"--url",
			`https://127.0.0.1:${PORT}`,
			"--mode",
			"load",
			"--skip-probes",
			"--latency-stamp",
			"--arrival",
			ARRIVAL,
			"--tick-hz",
			String(TICK_HZ),
			"--sessions",
			String(SESSIONS),
			"--duration",
			String(STEP_SECONDS),
			"--datagrams-per-sec",
			String(rate),
			"--streams-per-sec",
			"0",
			"--payload-bytes",
			String(PAYLOAD_BYTES),
			// Measurement run: the ladder must climb past the knee, not exit at it.
			"--max-session-errors",
			String(SESSIONS),
			"--max-datagram-errors",
			"1000000000",
			"--max-stream-errors",
			"1000000000",
		];
		const child = Bun.spawn(args, {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdoutPromise = new Response(child.stdout).text();
		const stderrPromise = new Response(child.stderr).text();

		const hostSamples: number[] = [];
		let prevHost = readHostCpu();
		let done = false;
		const exited = child.exited.then(() => {
			done = true;
		});
		while (!done) {
			await Promise.race([exited, Bun.sleep(5000)]);
			const nextHost = readHostCpu();
			const host = hostCpuPct(prevHost, nextHost);
			prevHost = nextHost;
			if (host !== null) hostSamples.push(host);
		}

		const exitCode = await child.exited;
		const stdout = await stdoutPromise;
		const stderr = await stderrPromise;
		const elapsedSec = (Date.now() - startedAt) / 1000;

		const num = (re: RegExp): number => {
			const m = stdout.match(re);
			return m?.[1] ? parseInt(m[1], 10) : 0;
		};
		const sessionsOk = num(/sessions ok=(\d+)/);
		if (exitCode !== 0 && sessionsOk === 0) {
			console.error(stderr.slice(-2000));
			throw new Error(
				`step ${index + 1}: load-client exited ${exitCode} with no successful sessions`,
			);
		}

		let client: ClientLatencyJson | null = null;
		const latencyLine = stdout.match(/load-client: latency-json (\{.*\})/);
		if (latencyLine?.[1]) {
			client = JSON.parse(latencyLine[1]) as ClientLatencyJson;
		} else {
			console.warn(
				`bench-latency: step ${index + 1} produced no client latency-json`,
			);
		}

		const step: LatencyStep = {
			perSessionRate: rate,
			aggregateRate: aggregate,
			elapsedSec,
			requestedDatagrams: aggregate * STEP_SECONDS,
			clientSent: num(/datagrams sent=(\d+)/),
			clientErr: num(/datagrams sent=\d+ err=(\d+)/),
			clientReceived: num(/datagrams received=(\d+)/),
			serverRx: serverRx - rx0,
			serverStamped: serverStamped - stamped0,
			serverUnstamped: serverUnstamped - unstamped0,
			echoSent: echoSent - echo0,
			echoErr: echoErr - echoErr0,
			upDeliveryRatio: null,
			ingest: ingest.toJson(),
			client,
			hostCpuPctMedian: median(hostSamples),
			serverCpuPct:
				((serverCpuMs() - cpuMs0) / Math.max(elapsedSec * 1000, 1)) * 100,
			sessionsOk,
			sessionsErr: num(/sessions ok=\d+ err=(\d+)/),
		};
		step.upDeliveryRatio =
			step.clientSent > 0 ? step.serverRx / step.clientSent : null;
		steps.push(step);

		const s = ingest.summary();
		const ms = (ns: number) => (ns / 1e6).toFixed(3);
		console.log(
			`bench-latency: step ${index + 1} done n=${s.count} p50=${ms(s.p50Ns)}ms p99=${ms(s.p99Ns)}ms p999=${ms(s.p999Ns)}ms max=${ms(s.maxNs)}ms neg=${s.negative} up=${step.upDeliveryRatio?.toFixed(3) ?? "n/a"} sent=${step.clientSent}/${step.requestedDatagrams} hostCpu=${step.hostCpuPctMedian?.toFixed(0) ?? "n/a"}%`,
		);
		await Bun.sleep(SETTLE_MS);
	}

	await server.close();

	const result = {
		version: 1,
		arm: ARM,
		startedAt: new Date().toISOString(),
		host: {
			platform: process.platform,
			cpus: navigator?.hardwareConcurrency ?? null,
			bunVersion: Bun.version,
		},
		clock: {
			source: clock.source,
			calibrationResidualNs: clock.calibrationResidualNs,
			calibrationSpreadNs: clock.calibrationSpreadNs,
		},
		config: {
			sessions: SESSIONS,
			payloadBytes: PAYLOAD_BYTES,
			stepSeconds: STEP_SECONDS,
			ratesPerSession: RATES,
			arrival: ARRIVAL,
			tickHz: TICK_HZ,
			echo: ECHO,
			datagramBatchEnv: process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? null,
		},
		steps,
	};
	writeFileSync(OUT_JSON, `${JSON.stringify(result)}\n`);
	console.log(`bench-latency: wrote ${OUT_JSON}`);
}

await main();
