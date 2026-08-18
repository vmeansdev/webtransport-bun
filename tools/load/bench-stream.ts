#!/usr/bin/env bun
/**
 * Stream-throughput harness for the stream-throughput axis.
 *
 * Pre-registration (buckets, STOP conditions, ladder) lives at
 * docs/research/preregistrations/stream-throughput.md and is the contract this
 * file executes. Three arms, all measuring ingress (client writes, Bun server
 * reads through the N-API boundary):
 *
 *   A  bulk bytes/s against client write size, plus a raised-window control
 *   B  stream open/close rate ceiling against in-flight concurrency
 *   C  datagrams vs streams at a matched offered byte rate
 *
 * Every step is classified mechanically by the pre-registered rules and the
 * bucket is printed next to the number. Steps that classify INCOMPLETE are not
 * capacity numbers and the summary refuses to treat them as such.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;
const HAS_PROC = process.platform === "linux";
/** Kernel clock ticks per second; 100 on every Linux this runs on. */
const CLK_TCK = parseInt(process.env.BENCH_CLK_TCK ?? "100", 10);
const SAMPLE_INTERVAL_MS = parseInt(
	process.env.BENCH_SAMPLE_INTERVAL_MS ?? "2000",
	10,
);
const OUT_JSON =
	process.env.BENCH_OUT ?? join(ROOT, "tools/load/bench-stream.json");
const OUT_CSV = OUT_JSON.replace(/\.json$/, ".csv");
const ARMS = (process.env.BENCH_STREAM_ARMS ?? "A,B,C")
	.split(",")
	.map((v) => v.trim().toUpperCase())
	.filter((v) => v.length > 0);

// --- Arm A: bulk bytes/s vs write size -------------------------------------
const A_SESSIONS = parseInt(process.env.BENCH_A_SESSIONS ?? "4", 10);
const A_CONCURRENCY = parseInt(process.env.BENCH_A_CONCURRENCY ?? "4", 10);
const A_STEP_SECONDS = parseInt(process.env.BENCH_A_STEP_SECONDS ?? "60", 10);
const A_WRITE_SIZES = (
	process.env.BENCH_A_WRITE_SIZES ?? "4096,16384,65536,262144,1048576"
)
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
/** Which write size the raised-window control (A6) repeats. */
const A_CONTROL_WRITE_SIZE = parseInt(
	process.env.BENCH_A_CONTROL_WRITE_SIZE ?? "262144",
	10,
);

// --- Arm B: stream open/close ceiling --------------------------------------
const B_SESSIONS = parseInt(process.env.BENCH_B_SESSIONS ?? "4", 10);
const B_STEP_SECONDS = parseInt(process.env.BENCH_B_STEP_SECONDS ?? "30", 10);
const B_CONCURRENCY = (process.env.BENCH_B_CONCURRENCY ?? "1,4,16,64,256")
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
const B_PAYLOAD_BYTES = parseInt(process.env.BENCH_B_PAYLOAD_BYTES ?? "64", 10);

// --- Arm C: datagram vs stream at matched offered bytes/s ------------------
const C_SESSIONS = parseInt(process.env.BENCH_C_SESSIONS ?? "8", 10);
const C_STEP_SECONDS = parseInt(process.env.BENCH_C_STEP_SECONDS ?? "60", 10);
const C_TARGET_MBPS = parseInt(process.env.BENCH_C_TARGET_MBPS ?? "600", 10);
const C_DATAGRAM_BYTES = parseInt(
	process.env.BENCH_C_DATAGRAM_BYTES ?? "1150",
	10,
);
const C_STREAM_WRITE_BYTES = parseInt(
	process.env.BENCH_C_STREAM_WRITE_BYTES ?? "65536",
	10,
);

const PORT_A = 4433;
const PORT_A_CONTROL = 4436;
const PORT_B = 4437;
const PORT_C = 4438;

// ---------------------------------------------------------------------------
// Host / process instrumentation
// ---------------------------------------------------------------------------

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

/**
 * utime+stime for a pid, in clock ticks. Returns null once the process is
 * gone, so callers keep the last successful reading as the process total.
 */
function readPidCpuTicks(pid: number): number | null {
	if (!HAS_PROC) return null;
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	// comm can contain spaces and parens; everything after the last ')' is
	// field 3 onward, so utime (field 14) is index 11 there.
	const afterComm = stat
		.slice(stat.lastIndexOf(")") + 2)
		.trim()
		.split(/\s+/);
	const utime = Number(afterComm[11] ?? Number.NaN);
	const stime = Number(afterComm[12] ?? Number.NaN);
	if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
	return utime + stime;
}

function serverCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

function serverRssMb(): number {
	return process.memoryUsage().rss / (1024 * 1024);
}

type UdpSnapshot = {
	inDatagrams: number;
	inErrors: number;
	rcvbufErrors: number;
	sndbufErrors: number;
	outDatagrams: number;
};

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

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

// ---------------------------------------------------------------------------
// Server under test
// ---------------------------------------------------------------------------

type ServerCounters = {
	streamsAccepted: number;
	streamsCompleted: number;
	streamErrors: number;
	chunks: number;
	bytes: number;
	datagrams: number;
	datagramBytes: number;
};

type Harness = {
	server: ReturnType<typeof createServer>;
	counters: ServerCounters;
};

function newCounters(): ServerCounters {
	return {
		streamsAccepted: 0,
		streamsCompleted: 0,
		streamErrors: 0,
		chunks: 0,
		bytes: 0,
		datagrams: 0,
		datagramBytes: 0,
	};
}

type ServerConfig = {
	port: number;
	sessions: number;
	/** Raised QUIC flow-control windows for the Arm A control step. */
	queuedBytesPerStream?: number;
	queuedBytesPerSession?: number;
	/** Arm C only: also drain incoming datagrams. */
	drainDatagrams?: boolean;
	datagramsPerSec?: number;
	maxUniStreamsPerSession?: number;
};

async function startServer(
	cfg: ServerConfig,
	tls: { certPem: string; keyPem: string },
): Promise<Harness> {
	const counters = newCounters();
	const server = createServer({
		port: cfg.port,
		tls,
		limits: {
			maxSessions: cfg.sessions + 100,
			maxHandshakesInFlight: cfg.sessions + 100,
			maxStreamsPerSessionUni: cfg.maxUniStreamsPerSession ?? 4096,
			maxStreamsGlobal: 200_000,
			...(cfg.queuedBytesPerStream !== undefined
				? { maxQueuedBytesPerStream: cfg.queuedBytesPerStream }
				: {}),
			...(cfg.queuedBytesPerSession !== undefined
				? { maxQueuedBytesPerSession: cfg.queuedBytesPerSession }
				: {}),
		},
		rateLimits: {
			handshakesPerSec: Math.max(cfg.sessions * 4, 400),
			handshakesBurst: Math.max(cfg.sessions * 8, 1000),
			handshakesBurstPerPrefix: Math.max(cfg.sessions * 8, 1000),
			// The bench measures the host, not the limiter. Both stream and
			// datagram limiters sit far above any ladder step; a step that
			// trips one is discarded by the classifier, not reported.
			streamsPerSec: 10_000_000,
			streamsBurst: 20_000_000,
			datagramsPerSec: cfg.datagramsPerSec ?? 10_000_000,
			datagramsBurst: (cfg.datagramsPerSec ?? 10_000_000) * 2,
		},
		onSession: (session) => {
			void (async () => {
				// Server sessions expose the W3C shape: a ReadableStream of
				// incoming streams, not an async iterable factory.
				const incoming = session.incomingUnidirectionalStreams.getReader();
				for (;;) {
					const next = await incoming.read();
					if (next.done) break;
					counters.streamsAccepted += 1;
					const readable = next.value;
					void (async () => {
						const reader = readable.getReader();
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							counters.chunks += 1;
							counters.bytes += value.byteLength;
						}
						counters.streamsCompleted += 1;
					})().catch(() => {
						counters.streamErrors += 1;
					});
				}
			})().catch(() => {});

			if (cfg.drainDatagrams) {
				void (async () => {
					for await (const datagram of session.incomingDatagrams()) {
						counters.datagrams += 1;
						counters.datagramBytes += datagram.byteLength;
					}
				})().catch(() => {});
			}
		},
	});
	// createServer has no readiness promise; same pattern as load-addon.ts.
	await Bun.sleep(3000);
	return { server, counters };
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

type ClientSummary = {
	sessionsOk: number;
	sessionsErr: number;
	streamsOpened: number;
	streamsErr: number;
	streamBytesWritten: number;
	streamWrites: number;
	streamsCompleted: number;
	datagramsSent: number;
	datagramsErr: number;
	datagramBytesSent: number;
	udpTxDatagrams: number;
	udpTxBytes: number;
	udpTxIos: number;
	udpRxDatagrams: number;
	udpRxBytes: number;
	udpRxIos: number;
};

function parseClientSummary(stdout: string): ClientSummary {
	const num = (re: RegExp): number => {
		const m = stdout.match(re);
		return m?.[1] ? parseInt(m[1], 10) : 0;
	};
	return {
		sessionsOk: num(/sessions ok=(\d+)/),
		sessionsErr: num(/sessions ok=\d+ err=(\d+)/),
		// Anchored on ": " so the later "load streams opened=" line cannot win.
		streamsOpened: num(/: streams opened=(\d+)/),
		streamsErr: num(/: streams opened=\d+ err=(\d+)/),
		streamBytesWritten: num(/stream bytes written=(\d+)/),
		streamWrites: num(/stream bytes written=\d+ writes=(\d+)/),
		streamsCompleted: num(
			/stream bytes written=\d+ writes=\d+ completed=(\d+)/,
		),
		datagramsSent: num(/datagrams sent=(\d+)/),
		datagramsErr: num(/datagrams sent=\d+ err=(\d+)/),
		datagramBytesSent: num(/bytes tx=(\d+)/),
		udpTxDatagrams: num(/udp tx datagrams=(\d+)/),
		udpTxBytes: num(/udp tx datagrams=\d+ bytes=(\d+)/),
		udpTxIos: num(/udp tx datagrams=\d+ bytes=\d+ ios=(\d+)/),
		udpRxDatagrams: num(/rx datagrams=(\d+) bytes=\d+ ios=\d+/),
		udpRxBytes: num(/rx datagrams=\d+ bytes=(\d+) ios=\d+/),
		udpRxIos: num(/rx datagrams=\d+ bytes=\d+ ios=(\d+)/),
	};
}

type Metrics = { rateLimitedCount: number; limitExceededCount: number };

function metricsOf(harness: Harness): Metrics {
	const m = harness.server.metricsSnapshot() as unknown as Record<
		string,
		number
	>;
	return {
		rateLimitedCount: m.rateLimitedCount ?? 0,
		limitExceededCount: m.limitExceededCount ?? 0,
	};
}

type StepObservation = {
	arm: string;
	label: string;
	client: ClientSummary;
	serverBytes: number;
	serverChunks: number;
	serverStreamsAccepted: number;
	serverStreamsCompleted: number;
	serverStreamErrors: number;
	serverDatagrams: number;
	serverDatagramBytes: number;
	elapsedSec: number;
	/**
	 * Rate denominator. The child's wall time also covers connect, drain grace
	 * and close; dividing by it would understate every rate by the size of that
	 * overhead, so rates use the configured step window instead.
	 */
	windowSec: number;
	hostCpuPctMedian: number | null;
	hostCpuPctMax: number | null;
	serverCpuPct: number;
	clientCpuPct: number | null;
	rssMbMax: number;
	udp: UdpSnapshot | null;
	rateLimitedDelta: number;
	limitExceededDelta: number;
	requestedSessions: number;
	exitCode: number;
};

async function runStep(
	arm: string,
	label: string,
	harness: Harness,
	requestedSessions: number,
	stepSeconds: number,
	args: string[],
	csvIndex: number,
): Promise<StepObservation> {
	const c0 = { ...harness.counters };
	const m0 = metricsOf(harness);
	const cpuMs0 = serverCpuMs();
	const udp0 = readUdpStats();
	const startedAt = Date.now();

	const child = Bun.spawn([CLIENT_BIN, ...args], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();

	const clientTicks0 = readPidCpuTicks(child.pid);
	let clientTicksLast = clientTicks0;
	const hostSamples: number[] = [];
	let rssMbMax = 0;
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
		if (host !== null) hostSamples.push(host);
		rssMbMax = Math.max(rssMbMax, serverRssMb());
		const ticks = readPidCpuTicks(child.pid);
		if (ticks !== null) clientTicksLast = ticks;
		const elapsedMs = Date.now() - startedAt;
		appendFileSync(
			OUT_CSV,
			`${arm},${csvIndex},${label},${Date.now()},${host?.toFixed(1) ?? ""},${(
				((serverCpuMs() - cpuMs0) / Math.max(elapsedMs, 1)) * 100
			).toFixed(1)},${rssMbMax.toFixed(1)}\n`,
		);
	}

	const exitCode = await child.exited;
	const stdout = await stdoutPromise;
	const stderr = await stderrPromise;
	const elapsedSec = (Date.now() - startedAt) / 1000;
	const client = parseClientSummary(stdout);
	if (exitCode !== 0 && client.sessionsOk === 0) {
		console.error(stderr.slice(-2000));
		throw new Error(
			`${arm}/${label}: load-client exited ${exitCode} with no successful sessions`,
		);
	}

	const clientCpuPct =
		clientTicks0 !== null && clientTicksLast !== null
			? ((clientTicksLast - clientTicks0) / CLK_TCK / elapsedSec) * 100
			: null;
	const m1 = metricsOf(harness);

	return {
		arm,
		label,
		client,
		serverBytes: harness.counters.bytes - c0.bytes,
		serverChunks: harness.counters.chunks - c0.chunks,
		serverStreamsAccepted:
			harness.counters.streamsAccepted - c0.streamsAccepted,
		serverStreamsCompleted:
			harness.counters.streamsCompleted - c0.streamsCompleted,
		serverStreamErrors: harness.counters.streamErrors - c0.streamErrors,
		serverDatagrams: harness.counters.datagrams - c0.datagrams,
		serverDatagramBytes: harness.counters.datagramBytes - c0.datagramBytes,
		elapsedSec,
		windowSec: stepSeconds,
		hostCpuPctMedian: median(hostSamples),
		hostCpuPctMax: hostSamples.length ? Math.max(...hostSamples) : null,
		serverCpuPct:
			((serverCpuMs() - cpuMs0) / Math.max(elapsedSec * 1000, 1)) * 100,
		clientCpuPct,
		rssMbMax,
		udp: udpDelta(udp0, readUdpStats()),
		rateLimitedDelta: m1.rateLimitedCount - m0.rateLimitedCount,
		limitExceededDelta: m1.limitExceededCount - m0.limitExceededCount,
		requestedSessions,
		exitCode,
	};
}

// ---------------------------------------------------------------------------
// Pre-registered classifier
// ---------------------------------------------------------------------------

const INCOMPLETE_BUCKETS = new Set([
	"session-failure",
	"limiter-engaged",
	"drain-incomplete",
	"host-saturated",
	"generator-saturated",
	"offer-shortfall",
]);

/** Rules 1-5 of the pre-registration, shared by every arm, in precedence order. */
function commonBucket(step: StepObservation): string | null {
	// Rule 1 is the client's error contract, per the pre-registration.
	// serverStreamErrors is recorded but deliberately not a trip: a reader that
	// loses its tail because the client tore the session down first is a
	// shutdown artifact, and `drain-incomplete` is the rule that catches a
	// genuinely truncated step.
	if (
		step.client.sessionsOk < step.requestedSessions ||
		step.client.streamsErr > 0
	) {
		return "session-failure";
	}
	if (step.rateLimitedDelta > 0 || step.limitExceededDelta > 0) {
		return "limiter-engaged";
	}
	const written = step.client.streamBytesWritten;
	if (written > 0 && written - step.serverBytes > 0.05 * written) {
		return "drain-incomplete";
	}
	if ((step.hostCpuPctMedian ?? 0) >= 90) return "host-saturated";
	if (
		step.clientCpuPct !== null &&
		step.clientCpuPct >= 150 &&
		step.clientCpuPct >= 1.5 * step.serverCpuPct
	) {
		return "generator-saturated";
	}
	return null;
}

function deliveredMbps(step: StepObservation): number {
	const bytes = step.serverBytes + step.serverDatagramBytes;
	return (bytes * 8) / step.windowSec / 1e6;
}

function classifyThroughput(
	step: StepObservation,
	prev: StepObservation | null,
): string {
	const common = commonBucket(step);
	if (common) return common;
	if (
		step.serverCpuPct >= 90 &&
		step.serverCpuPct >= (step.clientCpuPct ?? 0)
	) {
		return "server-boundary-bound";
	}
	const now = deliveredMbps(step);
	const before = prev ? deliveredMbps(prev) : null;
	if (
		before !== null &&
		before > 0 &&
		Math.abs(now - before) < 0.05 * before &&
		(step.hostCpuPctMedian ?? 0) < 70 &&
		step.serverCpuPct < 70 &&
		(step.clientCpuPct ?? 0) < 100
	) {
		return "flow-control-bound";
	}
	if (before !== null && before > 0 && now >= 1.1 * before) return "scaling";
	return "plateau";
}

function streamsPerSec(step: StepObservation): number {
	return step.serverStreamsCompleted / step.windowSec;
}

function classifyChurn(
	step: StepObservation,
	prev: StepObservation | null,
): string {
	const common = commonBucket(step);
	if (common) return common;
	const before = prev ? streamsPerSec(prev) : null;
	if (before !== null && before > 0 && streamsPerSec(step) >= 1.1 * before) {
		return "concurrency-scaling";
	}
	return "churn-ceiling";
}

/** GSO/GRO engagement, per the pre-registered 1.05 threshold. */
function coalescingVerdict(
	datagrams: number,
	ios: number,
): { segmentsPerIo: number | null; verdict: string } {
	if (ios <= 0) return { segmentsPerIo: null, verdict: "unknown" };
	const segmentsPerIo = datagrams / ios;
	return {
		segmentsPerIo,
		verdict: segmentsPerIo > 1.05 ? "ENGAGED" : "NOT-ENGAGED",
	};
}

type ClassifiedStep = StepObservation & {
	bucket: string;
	incomplete: boolean;
	deliveredMbps: number;
	streamsPerSec: number;
	meanJsChunkBytes: number | null;
	boundaryEventsPerSec: number;
	gso: ReturnType<typeof coalescingVerdict>;
	gro: ReturnType<typeof coalescingVerdict>;
	wirePacketsPerGbit: number | null;
};

function classify(
	step: StepObservation,
	prev: StepObservation | null,
	kind: "throughput" | "churn",
): ClassifiedStep {
	const bucket =
		kind === "throughput"
			? classifyThroughput(step, prev)
			: classifyChurn(step, prev);
	const mbps = deliveredMbps(step);
	const gbitDelivered = (mbps * step.windowSec) / 1000;
	return {
		...step,
		bucket,
		incomplete: INCOMPLETE_BUCKETS.has(bucket),
		deliveredMbps: mbps,
		streamsPerSec: streamsPerSec(step),
		meanJsChunkBytes:
			step.serverChunks > 0 ? step.serverBytes / step.serverChunks : null,
		boundaryEventsPerSec:
			(step.serverChunks + step.serverDatagrams) / step.windowSec,
		gso: coalescingVerdict(step.client.udpTxDatagrams, step.client.udpTxIos),
		gro: coalescingVerdict(step.client.udpRxDatagrams, step.client.udpRxIos),
		wirePacketsPerGbit:
			step.udp && gbitDelivered > 0
				? step.udp.inDatagrams / gbitDelivered
				: null,
	};
}

function printStep(step: ClassifiedStep): void {
	console.log(
		`bench-stream: ${step.arm}/${step.label} bucket=${step.bucket}${
			step.incomplete ? " [INCOMPLETE]" : ""
		} delivered=${step.deliveredMbps.toFixed(1)}Mbps streams/s=${step.streamsPerSec.toFixed(
			0,
		)} jsChunk=${step.meanJsChunkBytes?.toFixed(0) ?? "n/a"}B boundaryEv/s=${step.boundaryEventsPerSec.toFixed(
			0,
		)} hostCpu=${step.hostCpuPctMedian?.toFixed(0) ?? "n/a"}% srvCpu=${step.serverCpuPct.toFixed(
			0,
		)}% cliCpu=${step.clientCpuPct?.toFixed(0) ?? "n/a"}% rss=${step.rssMbMax.toFixed(
			0,
		)}MB gso=${step.gso.verdict}(${step.gso.segmentsPerIo?.toFixed(2) ?? "-"}) gro=${step.gro.verdict}(${step.gro.segmentsPerIo?.toFixed(2) ?? "-"})`,
	);
}

// ---------------------------------------------------------------------------
// Arms
// ---------------------------------------------------------------------------

function streamArgs(opts: {
	port: number;
	sessions: number;
	seconds: number;
	workload: "bulk" | "churn";
	writeBytes: number;
	concurrency: number;
	targetBytesPerSecPerSession: number;
}): string[] {
	return [
		"--url",
		`https://127.0.0.1:${opts.port}`,
		"--mode",
		"stream",
		"--skip-probes",
		"--sessions",
		String(opts.sessions),
		"--duration",
		String(opts.seconds),
		"--stream-workload",
		opts.workload,
		"--stream-write-bytes",
		String(opts.writeBytes),
		"--stream-concurrency",
		String(opts.concurrency),
		"--stream-target-bytes-per-sec",
		String(opts.targetBytesPerSecPerSession),
		// Measurement run: the ladder must climb past the knee, not exit at it.
		"--max-session-errors",
		String(opts.sessions),
		"--max-datagram-errors",
		"1000000000",
		"--max-stream-errors",
		"1000000000",
	];
}

async function runArmA(tls: {
	certPem: string;
	keyPem: string;
}): Promise<ClassifiedStep[]> {
	const out: ClassifiedStep[] = [];
	const harness = await startServer(
		{ port: PORT_A, sessions: A_SESSIONS },
		tls,
	);
	console.log(
		`bench-stream: arm A up on ${PORT_A} (default windows) sessions=${A_SESSIONS} concurrency=${A_CONCURRENCY}`,
	);
	let prev: StepObservation | null = null;
	try {
		for (const [i, writeBytes] of A_WRITE_SIZES.entries()) {
			const step = await runStep(
				"A",
				`w=${writeBytes}`,
				harness,
				A_SESSIONS,
				A_STEP_SECONDS,
				streamArgs({
					port: PORT_A,
					sessions: A_SESSIONS,
					seconds: A_STEP_SECONDS,
					workload: "bulk",
					writeBytes,
					concurrency: A_CONCURRENCY,
					targetBytesPerSecPerSession: 0,
				}),
				i + 1,
			);
			const classified = classify(step, prev, "throughput");
			printStep(classified);
			out.push(classified);
			prev = step;
			await Bun.sleep(10_000);
		}
	} finally {
		await harness.server.close();
	}

	// A6 control: same write size, raised QUIC flow-control windows. Prediction
	// on record is "within 10% of the matching default-window step".
	const control = await startServer(
		{
			port: PORT_A_CONTROL,
			sessions: A_SESSIONS,
			queuedBytesPerStream: 16 * 1024 * 1024,
			queuedBytesPerSession: 64 * 1024 * 1024,
		},
		tls,
	);
	console.log(
		`bench-stream: arm A control up on ${PORT_A_CONTROL} (16MiB/64MiB windows)`,
	);
	try {
		const step = await runStep(
			"A",
			`control-w=${A_CONTROL_WRITE_SIZE}`,
			control,
			A_SESSIONS,
			A_STEP_SECONDS,
			streamArgs({
				port: PORT_A_CONTROL,
				sessions: A_SESSIONS,
				seconds: A_STEP_SECONDS,
				workload: "bulk",
				writeBytes: A_CONTROL_WRITE_SIZE,
				concurrency: A_CONCURRENCY,
				targetBytesPerSecPerSession: 0,
			}),
			A_WRITE_SIZES.length + 1,
		);
		const classified = classify(step, null, "throughput");
		printStep(classified);
		out.push(classified);
	} finally {
		await control.server.close();
	}
	return out;
}

async function runArmB(tls: {
	certPem: string;
	keyPem: string;
}): Promise<ClassifiedStep[]> {
	const out: ClassifiedStep[] = [];
	const harness = await startServer(
		{ port: PORT_B, sessions: B_SESSIONS },
		tls,
	);
	console.log(`bench-stream: arm B up on ${PORT_B} sessions=${B_SESSIONS}`);
	let prev: StepObservation | null = null;
	try {
		for (const [i, concurrency] of B_CONCURRENCY.entries()) {
			const step = await runStep(
				"B",
				`c=${concurrency}`,
				harness,
				B_SESSIONS,
				B_STEP_SECONDS,
				streamArgs({
					port: PORT_B,
					sessions: B_SESSIONS,
					seconds: B_STEP_SECONDS,
					workload: "churn",
					writeBytes: B_PAYLOAD_BYTES,
					concurrency,
					targetBytesPerSecPerSession: 0,
				}),
				i + 1,
			);
			const classified = classify(step, prev, "churn");
			printStep(classified);
			out.push(classified);
			prev = step;
			await Bun.sleep(10_000);
		}
	} finally {
		await harness.server.close();
	}
	return out;
}

async function runArmC(tls: {
	certPem: string;
	keyPem: string;
}): Promise<ClassifiedStep[]> {
	const targetBytesPerSec = (C_TARGET_MBPS * 1e6) / 8;
	const perSessionBytes = Math.floor(targetBytesPerSec / C_SESSIONS);
	const perSessionDatagrams = Math.max(
		1,
		Math.floor(perSessionBytes / C_DATAGRAM_BYTES),
	);
	const harness = await startServer(
		{
			port: PORT_C,
			sessions: C_SESSIONS,
			drainDatagrams: true,
			datagramsPerSec: perSessionDatagrams * C_SESSIONS * 4,
		},
		tls,
	);
	console.log(
		`bench-stream: arm C up on ${PORT_C} target=${C_TARGET_MBPS}Mbps sessions=${C_SESSIONS} dgram/s/session=${perSessionDatagrams}`,
	);
	const out: ClassifiedStep[] = [];
	try {
		const dgram = await runStep(
			"C",
			"datagram",
			harness,
			C_SESSIONS,
			C_STEP_SECONDS,
			[
				"--url",
				`https://127.0.0.1:${PORT_C}`,
				"--mode",
				"load",
				"--skip-probes",
				"--sessions",
				String(C_SESSIONS),
				"--duration",
				String(C_STEP_SECONDS),
				"--datagrams-per-sec",
				String(perSessionDatagrams),
				"--streams-per-sec",
				"0",
				"--payload-bytes",
				String(C_DATAGRAM_BYTES),
				"--max-session-errors",
				String(C_SESSIONS),
				"--max-datagram-errors",
				"1000000000",
				"--max-stream-errors",
				"1000000000",
			],
			1,
		);
		const dgramClassified = classify(dgram, null, "throughput");
		printStep(dgramClassified);
		out.push(dgramClassified);
		await Bun.sleep(10_000);

		const stream = await runStep(
			"C",
			"stream",
			harness,
			C_SESSIONS,
			C_STEP_SECONDS,
			streamArgs({
				port: PORT_C,
				sessions: C_SESSIONS,
				seconds: C_STEP_SECONDS,
				workload: "bulk",
				writeBytes: C_STREAM_WRITE_BYTES,
				concurrency: 1,
				targetBytesPerSecPerSession: perSessionBytes,
			}),
			2,
		);
		const streamClassified = classify(stream, null, "throughput");
		printStep(streamClassified);
		out.push(streamClassified);
	} finally {
		await harness.server.close();
	}
	return out;
}

/** Arm C's pre-registered pre-comparison gate (C1/C2/C3). */
function compareArmC(steps: ClassifiedStep[], targetMbps: number) {
	const dgram = steps.find((s) => s.label === "datagram");
	const stream = steps.find((s) => s.label === "stream");
	if (!dgram || !stream) {
		return { bucket: "offer-shortfall", reason: "a sub-arm did not run" };
	}
	const offeredMbps = (s: ClassifiedStep) => {
		const bytes =
			s.label === "datagram"
				? s.client.datagramBytesSent
				: s.client.streamBytesWritten;
		return (bytes * 8) / s.windowSec / 1e6;
	};
	const dgramOffered = offeredMbps(dgram);
	const streamOffered = offeredMbps(stream);
	if (dgramOffered < 0.95 * targetMbps || streamOffered < 0.95 * targetMbps) {
		return {
			bucket: "offer-shortfall",
			reason: `offered dgram=${dgramOffered.toFixed(1)}Mbps stream=${streamOffered.toFixed(1)}Mbps vs target ${targetMbps}Mbps`,
			dgramOffered,
			streamOffered,
		};
	}
	const dgramRatio =
		dgram.client.datagramsSent > 0
			? dgram.serverDatagrams / dgram.client.datagramsSent
			: 0;
	const bucket = dgramRatio < 0.98 ? "dgram-lossy" : "matched";
	return {
		bucket,
		reason:
			bucket === "dgram-lossy"
				? `datagram delivery ratio ${dgramRatio.toFixed(3)}; comparison stated at delivered bytes/s`
				: "both sub-arms met the offered target",
		dgramOffered,
		streamOffered,
		dgramDeliveryRatio: dgramRatio,
		datagram: {
			deliveredMbps: dgram.deliveredMbps,
			wirePacketsPerGbit: dgram.wirePacketsPerGbit,
			boundaryEventsPerSec: dgram.boundaryEventsPerSec,
			serverCpuPct: dgram.serverCpuPct,
			serverCpuPctPerGbps: dgram.serverCpuPct / (dgram.deliveredMbps / 1000),
			hostCpuPctMedian: dgram.hostCpuPctMedian,
			gso: dgram.gso,
		},
		stream: {
			deliveredMbps: stream.deliveredMbps,
			wirePacketsPerGbit: stream.wirePacketsPerGbit,
			boundaryEventsPerSec: stream.boundaryEventsPerSec,
			serverCpuPct: stream.serverCpuPct,
			serverCpuPctPerGbps: stream.serverCpuPct / (stream.deliveredMbps / 1000),
			hostCpuPctMedian: stream.hostCpuPctMedian,
			gso: stream.gso,
		},
	};
}

/**
 * Whole-run GSO verdict. Prefers a step that produced a usable number, but any
 * step with a non-zero io count answers the question — and a run with no io
 * counts at all answers `unknown`, never `NOT-ENGAGED`.
 */
function gsoVerdictOf(steps: ClassifiedStep[]) {
	const usable = steps.find(
		(s) => !s.incomplete && s.gso.segmentsPerIo !== null,
	);
	const any = steps.find((s) => s.gso.segmentsPerIo !== null);
	return (
		usable?.gso ??
		any?.gso ?? { segmentsPerIo: null, verdict: "unknown" as const }
	);
}

/** Arm A's pre-registered A6 falsifier. */
function evaluateArmAControl(steps: ClassifiedStep[]) {
	const control = steps.find((s) => s.label.startsWith("control-"));
	const baseline = steps.find((s) => s.label === `w=${A_CONTROL_WRITE_SIZE}`);
	if (!control || !baseline) {
		return { verdict: "unknown", reason: "control or baseline step missing" };
	}
	const ratio = control.deliveredMbps / Math.max(baseline.deliveredMbps, 1e-9);
	return {
		verdict: ratio > 1.1 ? "WINDOW-BOUND" : "WINDOWS-NOT-BINDING",
		ratio,
		controlMbps: control.deliveredMbps,
		baselineMbps: baseline.deliveredMbps,
		reason:
			ratio > 1.1
				? "raised windows beat the default by >10%: arm A measures flow control, not the N-API boundary"
				: "raised windows made no material difference: default windows are not the binding constraint",
	};
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log("bench-stream: building load-client (release)...");
	try {
		await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();
	} catch (err) {
		if (!(await Bun.file(CLIENT_BIN).exists())) throw err;
		console.warn(
			"bench-stream: cargo build failed; falling back to existing load-client binary",
		);
	}

	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");
	const creds = { certPem: tls.certPem, keyPem: tls.keyPem };

	writeFileSync(
		OUT_CSV,
		"arm,step,label,ts_ms,hostCpuPct,serverCpuPct,rssMb\n",
	);

	const armA = ARMS.includes("A") ? await runArmA(creds) : [];
	const armB = ARMS.includes("B") ? await runArmB(creds) : [];
	const armC = ARMS.includes("C") ? await runArmC(creds) : [];

	const ladderA = armA.filter((s) => !s.label.startsWith("control-"));
	const usableA = ladderA.filter((s) => !s.incomplete);
	const usableB = armB.filter((s) => !s.incomplete);
	const bestA =
		usableA.length > 0
			? usableA.reduce((a, b) => (b.deliveredMbps > a.deliveredMbps ? b : a))
			: null;
	const bestB =
		usableB.length > 0
			? usableB.reduce((a, b) => (b.streamsPerSec > a.streamsPerSec ? b : a))
			: null;
	// STOP conditions 1 and 2: if the top of the ladder is a generator or host
	// number, the arm yields a lower bound, not a ceiling.
	const armATopIncomplete =
		ladderA.length > 0 &&
		ladderA.reduce((a, b) => (b.deliveredMbps > a.deliveredMbps ? b : a))
			.incomplete;

	const result = {
		version: 1,
		startedAt: new Date().toISOString(),
		preregistration: "docs/research/preregistrations/stream-throughput.md",
		host: {
			platform: process.platform,
			cpus: navigator?.hardwareConcurrency ?? null,
			bunVersion: Bun.version,
			hasProcFs: HAS_PROC,
		},
		config: {
			arms: ARMS,
			a: {
				sessions: A_SESSIONS,
				concurrency: A_CONCURRENCY,
				stepSeconds: A_STEP_SECONDS,
				writeSizes: A_WRITE_SIZES,
				controlWriteSize: A_CONTROL_WRITE_SIZE,
			},
			b: {
				sessions: B_SESSIONS,
				stepSeconds: B_STEP_SECONDS,
				concurrency: B_CONCURRENCY,
				payloadBytes: B_PAYLOAD_BYTES,
			},
			c: {
				sessions: C_SESSIONS,
				stepSeconds: C_STEP_SECONDS,
				targetMbps: C_TARGET_MBPS,
				datagramBytes: C_DATAGRAM_BYTES,
				streamWriteBytes: C_STREAM_WRITE_BYTES,
			},
		},
		armA,
		armB,
		armC,
		verdicts: {
			bulkCeilingMbps: bestA?.deliveredMbps ?? null,
			bulkCeilingWriteSize: bestA?.label ?? null,
			bulkCeilingIsLowerBoundOnly: armATopIncomplete,
			streamOpenClosePerSec: bestB?.streamsPerSec ?? null,
			streamOpenCloseAt: bestB?.label ?? null,
			flowControlControl: ARMS.includes("A") ? evaluateArmAControl(armA) : null,
			datagramVsStream: ARMS.includes("C")
				? compareArmC(armC, C_TARGET_MBPS)
				: null,
			gsoOnStreamSendPath: gsoVerdictOf([...armA, ...armB, ...armC]),
		},
	};
	writeFileSync(OUT_JSON, `${JSON.stringify(result, null, 2)}\n`);
	console.log(`bench-stream: wrote ${OUT_JSON} and ${OUT_CSV}`);
	console.log(
		"bench-stream: verdicts",
		JSON.stringify(result.verdicts, null, 2),
	);
}

await main();
// Server-side sessions left behind by an abruptly exiting client have no QUIC idle
// timeout and keep the event loop referenced after close — a clean drain can hang
// forever (observed on the runner, latency run 32159708926). Output is already
// flushed synchronously above.
process.exit(0);
