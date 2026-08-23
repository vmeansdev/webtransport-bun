#!/usr/bin/env bun
/**
 * Bandwidth saturation ladder against the addon server.
 *
 * Steps aggregate datagram bandwidth up (fixed sessions, rising per-session
 * rate, MTU-sized payloads) and records, per step: offered vs delivered
 * throughput in both directions (client->server ingest, server->client echo),
 * host and server-process CPU, and server memory. The output locates the knee
 * where this host saturates — it is a measurement harness, not a pass/fail
 * gate; the only hard failures are session-level (connect/echo path broken).
 *
 * Single-host caveat: the load client shares the machine, so host CPU covers
 * client + server; serverCpuPct isolates the server process.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;

const SESSIONS = parseInt(process.env.BENCH_SESSIONS ?? "100", 10);
const PAYLOAD_BYTES = parseInt(process.env.BENCH_PAYLOAD_BYTES ?? "1150", 10);
const STEP_SECONDS = parseInt(process.env.BENCH_STEP_SECONDS ?? "180", 10);
/** Per-session datagrams/s ladder. Defaults target ~25/50/100/200/300/400
 * Mbps aggregate at 100 sessions x 1150B payloads. */
const RATES = (process.env.BENCH_RATES ?? "27,54,109,217,326,435")
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
const SAMPLE_INTERVAL_MS = parseInt(
	process.env.BENCH_SAMPLE_INTERVAL_MS ?? "5000",
	10,
);
const OUT_JSON =
	process.env.BENCH_OUT ?? join(ROOT, "tools/load/bench-bandwidth.json");
const OUT_CSV = OUT_JSON.replace(/\.json$/, ".csv");

const HAS_PROC = process.platform === "linux";

type CpuSnapshot = { busy: number; total: number };

function readHostCpu(): CpuSnapshot | null {
	if (!HAS_PROC) return null;
	const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
	const fields = line.trim().split(/\s+/).slice(1).map(Number);
	const total = fields.reduce((a, b) => a + b, 0);
	const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
	return { busy: total - idle, total };
}

function hostCpuPct(
	prev: CpuSnapshot | null,
	next: CpuSnapshot | null,
): number | null {
	if (!prev || !next || next.total === prev.total) return null;
	return ((next.busy - prev.busy) / (next.total - prev.total)) * 100;
}

function serverCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

function serverMemMb(): { rssMb: number; committedMb: number | null } {
	const rssMb = process.memoryUsage().rss / (1024 * 1024);
	if (!HAS_PROC) return { rssMb, committedMb: null };
	const status = readFileSync("/proc/self/status", "utf8");
	const kb = (key: string) => {
		const m = status.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
		return m?.[1] ? parseInt(m[1], 10) : 0;
	};
	return { rssMb, committedMb: (kb("RssAnon") + kb("VmSwap")) / 1024 };
}

type UdpSnapshot = {
	inDatagrams: number;
	inErrors: number;
	rcvbufErrors: number;
	sndbufErrors: number;
	outDatagrams: number;
};

/** Host-wide UDP counters from /proc/net/snmp; per-step deltas attribute
 * missing datagrams to kernel-side drops (RcvbufErrors) vs sender-side
 * (quinn's congestion-limited send-buffer drops never reach the wire). */
function readUdpStats(): UdpSnapshot | null {
	if (!HAS_PROC) return null;
	const lines = readFileSync("/proc/net/snmp", "utf8").split("\n");
	const headerIdx = lines.findIndex((l) => l.startsWith("Udp:"));
	if (headerIdx < 0 || !lines[headerIdx + 1]?.startsWith("Udp:")) return null;
	const keys = (lines[headerIdx] ?? "").trim().split(/\s+/).slice(1);
	const vals = (lines[headerIdx + 1] ?? "").trim().split(/\s+/).slice(1);
	const get = (key: string) => {
		const i = keys.indexOf(key);
		return i >= 0 ? Number(vals[i] ?? 0) : 0;
	};
	return {
		inDatagrams: get("InDatagrams"),
		inErrors: get("InErrors"),
		rcvbufErrors: get("RcvbufErrors"),
		sndbufErrors: get("SndbufErrors"),
		outDatagrams: get("OutDatagrams"),
	};
}

function udpDelta(
	before: UdpSnapshot | null,
	after: UdpSnapshot | null,
): UdpSnapshot | null {
	if (!before || !after) return null;
	return {
		inDatagrams: after.inDatagrams - before.inDatagrams,
		inErrors: after.inErrors - before.inErrors,
		rcvbufErrors: after.rcvbufErrors - before.rcvbufErrors,
		sndbufErrors: after.sndbufErrors - before.sndbufErrors,
		outDatagrams: after.outDatagrams - before.outDatagrams,
	};
}

type StepResult = {
	perSessionRate: number;
	targetMbps: number;
	clientSent: number;
	clientErr: number;
	clientReceived: number;
	clientBytesTx: number;
	clientBytesRx: number;
	serverRx: number;
	serverRxBytes: number;
	echoSent: number;
	echoErr: number;
	offeredMbps: number;
	serverRxMbps: number;
	echoDeliveredMbps: number;
	upDeliveryRatio: number | null;
	downDeliveryRatio: number | null;
	hostCpuPctMedian: number | null;
	hostCpuPctMax: number | null;
	serverCpuPct: number;
	rssMbMax: number;
	committedMbMax: number | null;
	sessionsOk: number;
	sessionsErr: number;
	elapsedSec: number;
	udp: UdpSnapshot | null;
};

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

async function main(): Promise<void> {
	if (RATES.length === 0) {
		throw new Error("BENCH_RATES parsed to an empty ladder");
	}
	console.log("bench-bandwidth: building load-client (release)...");
	try {
		await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();
	} catch (err) {
		if (!(await Bun.file(CLIENT_BIN).exists())) throw err;
		console.warn(
			"bench-bandwidth: cargo build failed; falling back to existing load-client binary",
		);
	}

	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	// Counters the datagram echo handler feeds; snapshotted per step.
	let serverRx = 0;
	let serverRxBytes = 0;
	let echoSent = 0;
	let echoErr = 0;

	const peakRate = Math.max(...RATES);
	const aggregatePeak = SESSIONS * peakRate;
	const server = createServer({
		port: 4433,
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
			// The bench measures the host, not the limiter: keep the datagram
			// limiter comfortably above the top ladder step.
			datagramsPerSec: aggregatePeak * 4,
			datagramsBurst: aggregatePeak * 8,
		},
		onSession: (session) => {
			void (async () => {
				for await (const datagram of session.incomingDatagrams()) {
					serverRx += 1;
					serverRxBytes += datagram.byteLength;
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
	// Allow the addon server to bind (Tokio + wtransport startup) — same
	// pattern as load-addon.ts; createServer has no readiness promise.
	await Bun.sleep(3000);
	console.log(
		`bench-bandwidth: server up; sessions=${SESSIONS} payload=${PAYLOAD_BYTES}B step=${STEP_SECONDS}s ladder=[${RATES.join(",")}]/s/session`,
	);

	writeFileSync(
		OUT_CSV,
		"step,perSessionRate,targetMbps,ts_ms,hostCpuPct,serverCpuPct,rssMb,committedMb\n",
	);

	const steps: StepResult[] = [];
	for (const [index, rate] of RATES.entries()) {
		const targetMbps = (SESSIONS * rate * PAYLOAD_BYTES * 8) / 1e6;
		console.log(
			`bench-bandwidth: step ${index + 1}/${RATES.length} rate=${rate}/s/session target=${targetMbps.toFixed(0)}Mbps`,
		);
		const rx0 = serverRx;
		const rxBytes0 = serverRxBytes;
		const echo0 = echoSent;
		const echoErr0 = echoErr;
		const cpuMs0 = serverCpuMs();
		const udp0 = readUdpStats();
		const startedAt = Date.now();

		const child = Bun.spawn(
			[
				CLIENT_BIN,
				"--url",
				"https://127.0.0.1:4433",
				"--mode",
				"load",
				"--skip-probes",
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
				// Measurement run: budgets are effectively unbounded so the
				// ladder keeps climbing past the knee instead of exiting early.
				"--max-session-errors",
				String(SESSIONS),
				"--max-datagram-errors",
				"1000000000",
				"--max-stream-errors",
				"1000000000",
			],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		);
		const stdoutPromise = new Response(child.stdout).text();
		const stderrPromise = new Response(child.stderr).text();

		const hostSamples: number[] = [];
		let rssMbMax = 0;
		let committedMbMax: number | null = null;
		let prevHost = readHostCpu();
		let done = false;
		const exited = child.exited.then(() => {
			done = true;
		});
		while (!done) {
			await Promise.race([
				exited,
				new Promise((res) => setTimeout(res, SAMPLE_INTERVAL_MS)),
			]);
			const nextHost = readHostCpu();
			const host = hostCpuPct(prevHost, nextHost);
			prevHost = nextHost;
			const mem = serverMemMb();
			rssMbMax = Math.max(rssMbMax, mem.rssMb);
			if (mem.committedMb !== null) {
				committedMbMax = Math.max(committedMbMax ?? 0, mem.committedMb);
			}
			if (host !== null) hostSamples.push(host);
			const cpuNow = serverCpuMs();
			const elapsed = Date.now() - startedAt;
			appendFileSync(
				OUT_CSV,
				`${index + 1},${rate},${targetMbps.toFixed(1)},${Date.now()},${host?.toFixed(1) ?? ""},${(((cpuNow - cpuMs0) / Math.max(elapsed, 1)) * 100).toFixed(1)},${mem.rssMb.toFixed(1)},${mem.committedMb?.toFixed(1) ?? ""}\n`,
			);
		}

		const exitCode = await child.exited;
		const stdout = await stdoutPromise;
		const stderr = await stderrPromise;
		const elapsedSec = (Date.now() - startedAt) / 1000;
		const num = (re: RegExp): number => {
			const m = stdout.match(re);
			return m?.[1] ? parseInt(m[1], 10) : 0;
		};
		const clientSent = num(/datagrams sent=(\d+)/);
		const clientErr = num(/datagrams sent=\d+ err=(\d+)/);
		const clientReceived = num(/datagrams received=(\d+)/);
		const clientBytesTx = num(/bytes tx=(\d+)/);
		const clientBytesRx = num(/bytes tx=\d+ rx=(\d+)/);
		const sessionsOk = num(/sessions ok=(\d+)/);
		const sessionsErr = num(/sessions ok=\d+ err=(\d+)/);
		if (exitCode !== 0 && sessionsOk === 0) {
			console.error(stderr.slice(-2000));
			throw new Error(
				`step ${index + 1}: load-client exited ${exitCode} with no successful sessions`,
			);
		}

		const stepRx = serverRx - rx0;
		const stepRxBytes = serverRxBytes - rxBytes0;
		const stepEcho = echoSent - echo0;
		const step: StepResult = {
			perSessionRate: rate,
			targetMbps,
			clientSent,
			clientErr,
			clientReceived,
			clientBytesTx,
			clientBytesRx,
			serverRx: stepRx,
			serverRxBytes: stepRxBytes,
			echoSent: stepEcho,
			echoErr: echoErr - echoErr0,
			offeredMbps: (clientBytesTx * 8) / elapsedSec / 1e6,
			serverRxMbps: (stepRxBytes * 8) / elapsedSec / 1e6,
			echoDeliveredMbps: (clientBytesRx * 8) / elapsedSec / 1e6,
			upDeliveryRatio: clientSent > 0 ? stepRx / clientSent : null,
			downDeliveryRatio: stepEcho > 0 ? clientReceived / stepEcho : null,
			hostCpuPctMedian: median(hostSamples),
			hostCpuPctMax: hostSamples.length ? Math.max(...hostSamples) : null,
			serverCpuPct:
				((serverCpuMs() - cpuMs0) / Math.max(elapsedSec * 1000, 1)) * 100,
			rssMbMax,
			committedMbMax,
			sessionsOk,
			sessionsErr,
			elapsedSec,
			udp: udpDelta(udp0, readUdpStats()),
		};
		steps.push(step);
		console.log(
			`bench-bandwidth: step ${index + 1} done offered=${step.offeredMbps.toFixed(1)}Mbps serverRx=${step.serverRxMbps.toFixed(1)}Mbps echoRx=${step.echoDeliveredMbps.toFixed(1)}Mbps up=${step.upDeliveryRatio?.toFixed(3) ?? "n/a"} down=${step.downDeliveryRatio?.toFixed(3) ?? "n/a"} hostCpu=${step.hostCpuPctMedian?.toFixed(0) ?? "n/a"}% serverCpu=${step.serverCpuPct.toFixed(0)}% rssMax=${step.rssMbMax.toFixed(0)}MB udp[in=${step.udp?.inDatagrams ?? "n/a"} out=${step.udp?.outDatagrams ?? "n/a"} rcvbufErr=${step.udp?.rcvbufErrors ?? "n/a"} sndbufErr=${step.udp?.sndbufErrors ?? "n/a"} inErr=${step.udp?.inErrors ?? "n/a"}]`,
		);
		// Brief settle between steps so queues drain and CPU baselines reset.
		await new Promise((res) => setTimeout(res, 10_000));
	}

	await server.close();

	const result = {
		version: 1,
		startedAt: new Date().toISOString(),
		host: {
			platform: process.platform,
			cpus: navigator?.hardwareConcurrency ?? null,
			bunVersion: Bun.version,
		},
		config: {
			sessions: SESSIONS,
			payloadBytes: PAYLOAD_BYTES,
			stepSeconds: STEP_SECONDS,
			ratesPerSession: RATES,
		},
		steps,
	};
	writeFileSync(OUT_JSON, `${JSON.stringify(result, null, 2)}\n`);
	console.log(`bench-bandwidth: wrote ${OUT_JSON} and ${OUT_CSV}`);
	console.log(
		"step | target | offered | serverRx | echoRx | up | down | hostCpu | srvCpu | rssMax | rcvbufErr | sndbufErr",
	);
	for (const [i, s] of steps.entries()) {
		console.log(
			`${String(i + 1).padStart(4)} | ${s.targetMbps.toFixed(0).padStart(6)} | ${s.offeredMbps.toFixed(1).padStart(7)} | ${s.serverRxMbps.toFixed(1).padStart(8)} | ${s.echoDeliveredMbps.toFixed(1).padStart(6)} | ${(s.upDeliveryRatio ?? 0).toFixed(2)} | ${(s.downDeliveryRatio ?? 0).toFixed(2)} | ${s.hostCpuPctMedian?.toFixed(0).padStart(7) ?? "    n/a"} | ${s.serverCpuPct.toFixed(0).padStart(6)} | ${s.rssMbMax.toFixed(0).padStart(6)} | ${String(s.udp?.rcvbufErrors ?? "n/a").padStart(9)} | ${String(s.udp?.sndbufErrors ?? "n/a").padStart(9)}`,
		);
	}
}

try {
	await main();
	process.exit(0);
} catch (err) {
	console.error(err instanceof Error ? (err.stack ?? err.message) : err);
	process.exit(1);
}
