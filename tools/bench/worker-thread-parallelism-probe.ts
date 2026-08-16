#!/usr/bin/env bun

/**
 * Tokio worker-thread parallelism probe — does the server's single worker cap
 * receive throughput?
 *
 * The batching investigation showed the receive ceiling is not in JS: the
 * reader drains ~12.2M items/s against ~53k/s arriving. It also left a shape
 * clue. At 150 sessions x 1,000/s the server received ~51,000/s on ~2.05-2.16
 * cores; at 4 sessions x 15,000/s it received ~59,907/s on ~1.58 cores. Fewer
 * connections, more throughput, less CPU — per-connection cost, not
 * per-datagram cost. ~2.05 cores with one tokio worker plus the Bun JS thread
 * looks like both threads pinned.
 *
 * Two sweeps, both receive-only (no echo), both interleaved round-robin:
 *
 *   WORKERS  150 sessions x 1,000/s, worker_threads in {1, 2, 4, auto}.
 *            If per-connection quinn work spreads across workers, the ceiling
 *            rises. If the serialisation is quinn's single endpoint driver —
 *            one UDP socket, one demux loop — extra workers change nothing.
 *
 *   SESSIONS worker_threads=1, aggregate offered load held at ~150k/s while
 *            session count varies over {4, 16, 64, 150}. That separates
 *            per-connection cost from per-datagram cost directly.
 *
 * THE ARMS MUST BE SHOWN TO HAVE DIFFERED. A worker arm that silently ran with
 * one worker produces a flat line indistinguishable from a real negative, which
 * is the exact trap the previous investigation nearly fell into. So the addon
 * carries a per-OS-thread datagram counter (crates/native/src/worker_probe.rs)
 * and every run reports how many distinct threads processed datagrams and how
 * the work divided. `resolve_worker_threads` aborts on an unparseable value
 * rather than defaulting, so a typo cannot masquerade as a null result either.
 *
 * This is a PROBE on an investigation branch. It gates nothing and moves no
 * threshold.
 *
 * Usage:
 *   bun tools/bench/worker-thread-parallelism-probe.ts
 *   bun tools/bench/worker-thread-parallelism-probe.ts --child --port P \
 *       --sessions N --rate R --label L --round K
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	__TESTING__,
	createServer,
} from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const CLIENT_BIN = join(ROOT, "target", "release", "load-client");
const WORKERS_ENV = "WEBTRANSPORT_SERVER_WORKER_THREADS";
const COMMAND = "bun tools/bench/worker-thread-parallelism-probe.ts";

const PAYLOAD_BYTES = Number(process.env.WT_PROBE_PAYLOAD_BYTES ?? "1150");
/**
 * 1150, not 1200: payload plus the WebTransport session-id varint and QUIC
 * framing must stay under the 1200-byte conservative path MTU, or every send
 * fails as too-large. Same size the bandwidth ladder uses.
 */
const AGGREGATE_PER_SEC = Number(process.env.WT_PROBE_AGGREGATE ?? "150000");
const SATURATION_SESSIONS = Number(process.env.WT_PROBE_SESSIONS ?? "150");
const WARMUP_SEC = Number(process.env.WT_PROBE_WARMUP_SEC ?? "5");
const MEASURE_SEC = Number(process.env.WT_PROBE_MEASURE_SEC ?? "20");
export const REPS = Number(process.env.WT_PROBE_REPS ?? "3");
const BASE_PORT = 48_610;
const BIND_WAIT_MS = 3_000;
/**
 * Load-generator processes sharing the session count.
 *
 * One load-client tops out near 65k datagrams/s on this host, which the native
 * control (tools/bench/native-recv-floor-control.ts) showed is the ceiling the
 * first run of this sweep actually measured: sharded over three clients the
 * same one-worker Rust server took 115k/s. Any arm run with a single client is
 * reporting the generator's limit, not the server's.
 */
const CLIENTS = Number(process.env.WT_PROBE_CLIENTS ?? "1");
/**
 * Echo every received datagram, making `send_datagram` as hot as the read path.
 * The default receive-only shape never calls the send path at all, so it cannot
 * say anything about it.
 */
const ECHO = process.env.WT_PROBE_ECHO === "1";
/** Per-session stream opens/s, to make the accept path hot. */
const STREAMS_PER_SEC = Number(process.env.WT_PROBE_STREAMS_PER_SEC ?? "0");
const ARTIFACT_PATH = join(
	ROOT,
	".investigation",
	`worker-thread-parallelism-probe${CLIENTS > 1 ? `-c${CLIENTS}` : ""}.json`,
);
const CHILD_TIMEOUT_MS =
	(WARMUP_SEC + MEASURE_SEC) * 1_000 + BIND_WAIT_MS + 60_000;

/**
 * An arm received this fraction or more of what was offered, so the sender —
 * not the server — set the rate, and the number is offered load rather than
 * capacity. Worth knowing per arm; it does not by itself invalidate the
 * comparison the way it did for batching, but a sweep where every arm is
 * sender-limited measured nothing.
 */
export const SATURATION_CEILING = 0.9;

export type Arm = {
	/** Stable name used in output and as the interleave key. */
	label: string;
	/** Value for WEBTRANSPORT_SERVER_WORKER_THREADS ("" leaves it unset). */
	workers: string;
	sessions: number;
	/** Per-session offered datagrams/s. */
	rate: number;
};

/** worker_threads sweep at the load where the plateau appeared. */
export function workerArms(): Arm[] {
	const perSession = Math.round(AGGREGATE_PER_SEC / SATURATION_SESSIONS);
	return ["1", "2", "4", "auto"].map((workers) => ({
		label: `workers=${workers}`,
		workers,
		sessions: SATURATION_SESSIONS,
		rate: perSession,
	}));
}

/** Session-count sweep at fixed aggregate offered load, one worker. */
export function sessionArms(): Arm[] {
	return [4, 16, 64, SATURATION_SESSIONS].map((sessions) => ({
		label: `sessions=${sessions}`,
		workers: "1",
		sessions,
		rate: Math.round(AGGREGATE_PER_SEC / sessions),
	}));
}

export type ArmRun = {
	label: string;
	round: number;
	workers: string;
	sessions: number;
	ratePerSession: number;
	receivedPerSec: number;
	offeredPerSec: number;
	received: number;
	receivedBytes: number;
	clientSent: number;
	clientSendErrors: number;
	sessionsOk: number;
	sessionsErr: number;
	windowMs: number;
	saturationRatio: number;
	/** Server-side bidi stream accepts/s, non-zero only when streams are driven. */
	acceptedStreamsPerSec: number;
	/** Server-side datagram sends/s, non-zero only in echo mode. */
	datagramsOutPerSec: number;
	/** Arrivals and the reject paths, so a delivery gap can be attributed. */
	drops: {
		datagramsIn: number;
		datagramsDropped: number;
		rateLimited: number;
		backpressureWait: number;
		backpressureTimeout: number;
	};
	/** Whole server process (Bun JS thread + tokio workers), fraction of a core. */
	serverCpuCores: number;
	/**
	 * The proof that the arm ran what it claimed. `configured` is what the
	 * runtime built with; `datagramThreads` is how many distinct OS threads
	 * actually processed datagrams during the window; `perThread` is the split.
	 */
	workerProof: {
		configured: number | null;
		availableParallelism: number | null;
		datagramThreads: number | null;
		perThread: Record<string, number>;
		/**
		 * Raw per-thread CPU and rate-limit counters at both ends of the window,
		 * for tools/bench/thread-profile.ts to difference. Carried rather than
		 * reduced here because which thread is hot is a separate question from
		 * how many threads carried load.
		 */
		cpuBefore: Record<string, number>;
		cpuAfter: Record<string, number>;
	};
};

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[mid - 1] ?? Number.NaN) + (sorted[mid] ?? Number.NaN)) / 2
		: (sorted[mid] ?? Number.NaN);
}

/** Deterministic order shuffling so the interleave is reproducible from a seed. */
export function makeRng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state ^= state << 13;
		state >>>= 0;
		state ^= state >>> 17;
		state ^= state << 5;
		state >>>= 0;
		return state / 0x1_0000_0000;
	};
}

export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rng() * (i + 1));
		const a = out[i] as T;
		const b = out[j] as T;
		out[i] = b;
		out[j] = a;
	}
	return out;
}

function gitOutput(args: string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * Uncommitted changes to anything the measurement runs on.
 *
 * `.investigation/` is where these probes write their artifacts and where the
 * write-up lives, and `.bench-evidence/` is where CI collects them for upload.
 * Both are excluded: a run must not be able to fail itself by producing its own
 * output. Everything else — source, harness, addon — counts.
 */
export function dirtyPaths(porcelain: string): string[] {
	return porcelain
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.map((line) => line.replace(/^\S+\s+/, ""))
		.filter(
			(path) =>
				!path.startsWith(".investigation/") &&
				!path.startsWith(".bench-evidence/"),
		);
}

// ---------------------------------------------------------------------------
// Child: one arm, one round, one fresh process (the knob is read at runtime init)
// ---------------------------------------------------------------------------

/** The per-thread CPU and rate-limit keys, which the profiler differences. */
function timingKeys(snapshot: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(snapshot)) {
		if (
			key.startsWith("cpuNanos:") ||
			key.startsWith("rateLimitNanos:") ||
			key.startsWith("rateLimitCalls:") ||
			key.startsWith("thread:")
		) {
			out[key] = value;
		}
	}
	return out;
}

/** Per-thread datagram counts, minus the bookkeeping keys the addon also returns. */
function threadCounts(
	snapshot: Record<string, number>,
): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [key, value] of Object.entries(snapshot)) {
		if (key.startsWith("thread:")) out[key.slice("thread:".length)] = value;
	}
	return out;
}

async function runChild(
	label: string,
	port: number,
	round: number,
	sessions: number,
	rate: number,
): Promise<void> {
	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	let received = 0;
	let receivedBytes = 0;
	let acceptedStreams = 0;
	const aggregateOffered = sessions * rate;
	const server = createServer({
		port,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: sessions + 100,
			maxHandshakesInFlight: sessions + 100,
		},
		rateLimits: {
			handshakesPerSec: Math.max(sessions * 2, 400),
			handshakesBurst: Math.max(sessions * 4, 1000),
			handshakesBurstPerPrefix: Math.max(sessions * 4, 1000),
			streamsPerSec: 1000,
			streamsBurst: 2000,
			// Measure the delivery path, never the limiter.
			datagramsPerSec: aggregateOffered * 4,
			datagramsBurst: aggregateOffered * 8,
		},
		onSession: (session) => {
			// Receive-only by default: an echo would put the send path in the
			// measurement and halve the pps headroom on the same host. ECHO turns
			// it on deliberately, when the send path is what is being measured.
			void (async () => {
				for await (const datagram of session.incomingDatagrams()) {
					received += 1;
					receivedBytes += datagram.byteLength;
					if (ECHO) {
						// Unawaited: awaiting would serialise the reader behind the
						// send and measure the round trip instead of send capacity.
						void session.sendDatagram(datagram).catch(() => {});
					}
				}
			})().catch(() => {});
			if (STREAMS_PER_SEC > 0) {
				// ServerSession exposes incoming streams as a ReadableStream, not an
				// async-iterable method as the client session does.
				void (async () => {
					const reader = session.incomingBidirectionalStreams.getReader();
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						acceptedStreams += 1;
						// Drain and drop; the accept rate is the measurement.
						void value.readable
							.pipeTo(new WritableStream({ write() {} }))
							.catch(() => {});
					}
				})().catch(() => {});
			}
		},
	});
	await Bun.sleep(BIND_WAIT_MS);

	const perClient = Math.floor(sessions / CLIENTS);
	const clients = Array.from({ length: CLIENTS }, (_, i) =>
		Bun.spawn(
			[
				CLIENT_BIN,
				"--url",
				`https://127.0.0.1:${port}`,
				"--mode",
				"load",
				"--skip-probes",
				"--sessions",
				String(i === 0 ? sessions - perClient * (CLIENTS - 1) : perClient),
				"--duration",
				String(WARMUP_SEC + MEASURE_SEC),
				"--datagrams-per-sec",
				String(rate),
				"--streams-per-sec",
				String(STREAMS_PER_SEC),
				"--payload-bytes",
				String(PAYLOAD_BYTES),
				"--max-session-errors",
				String(sessions),
				"--max-datagram-errors",
				"1000000000",
				"--max-stream-errors",
				"1000000000",
			],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		),
	);
	const stdoutPromise = Promise.all(
		clients.map((c) => new Response(c.stdout).text()),
	);
	const stderrPromise = Promise.all(
		clients.map((c) => new Response(c.stderr).text()),
	);

	// Steady state only: let handshakes and cwnd settle before the window opens.
	await Bun.sleep(WARMUP_SEC * 1_000);
	const rx0 = received;
	const bytes0 = receivedBytes;
	const cpu0 = process.cpuUsage();
	const probe0 = __TESTING__.nativeWorkerProbeSnapshotForTests() ?? {};
	const metrics0 = server.metricsSnapshot();
	const streams0 = acceptedStreams;
	const t0 = performance.now();
	await Bun.sleep(MEASURE_SEC * 1_000);
	const rx1 = received;
	const bytes1 = receivedBytes;
	const cpu1 = process.cpuUsage();
	const probe1 = __TESTING__.nativeWorkerProbeSnapshotForTests() ?? {};
	const metrics1 = server.metricsSnapshot();
	const t1 = performance.now();

	for (const c of clients) await c.exited;
	const stdout = await stdoutPromise;
	const stderr = (await stderrPromise).join("\n");
	const num = (re: RegExp): number =>
		stdout.reduce((total, text) => {
			const m = text.match(re);
			return total + (m?.[1] ? Number.parseInt(m[1], 10) : 0);
		}, 0);
	const clientSent = num(/datagrams sent=(\d+)/);
	const sessionsOk = num(/sessions ok=(\d+)/);
	const windowMs = t1 - t0;
	// Offered is averaged over the client's whole run; the window is a subset of
	// it. Good enough for its only job, which is detecting non-saturation.
	const offeredPerSec = clientSent / (WARMUP_SEC + MEASURE_SEC);
	const receivedPerSec = ((rx1 - rx0) / windowMs) * 1000;

	// Window delta, so a thread that only worked during warmup does not count as
	// having carried load.
	const before = threadCounts(probe0);
	const perThread: Record<string, number> = {};
	for (const [name, after] of Object.entries(threadCounts(probe1))) {
		const delta = after - (before[name] ?? 0);
		if (delta > 0) perThread[name] = delta;
	}

	const result: ArmRun = {
		label,
		round,
		workers: process.env[WORKERS_ENV] ?? "",
		sessions,
		ratePerSession: rate,
		receivedPerSec,
		offeredPerSec,
		received: rx1 - rx0,
		receivedBytes: bytes1 - bytes0,
		clientSent,
		clientSendErrors: num(/datagrams sent=\d+ err=(\d+)/),
		sessionsOk,
		sessionsErr: num(/sessions ok=\d+ err=(\d+)/),
		windowMs,
		saturationRatio: offeredPerSec > 0 ? receivedPerSec / offeredPerSec : 0,
		serverCpuCores:
			(cpu1.user - cpu0.user + (cpu1.system - cpu0.system)) / 1_000 / windowMs,
		// Which drop path discarded what the receive path took in but the JS
		// reader never saw. datagramsIn counts arrivals; the two reject counters
		// separate the rate limiter from the queue-budget reservation.
		acceptedStreamsPerSec: ((acceptedStreams - streams0) / windowMs) * 1000,
		datagramsOutPerSec:
			(((metrics1.datagramsOut ?? 0) - (metrics0.datagramsOut ?? 0)) /
				windowMs) *
			1000,
		drops: {
			datagramsIn: metrics1.datagramsIn - metrics0.datagramsIn,
			datagramsDropped: metrics1.datagramsDropped - metrics0.datagramsDropped,
			rateLimited: metrics1.rateLimitedCount - metrics0.rateLimitedCount,
			backpressureWait:
				metrics1.backpressureWaitCount - metrics0.backpressureWaitCount,
			backpressureTimeout:
				metrics1.backpressureTimeoutCount - metrics0.backpressureTimeoutCount,
		},
		workerProof: {
			configured: probe1.configuredServerWorkerThreads ?? null,
			availableParallelism: probe1.availableParallelism ?? null,
			datagramThreads: Object.keys(perThread).length,
			perThread,
			cpuBefore: timingKeys(probe0),
			cpuAfter: timingKeys(probe1),
		},
	};
	if (sessionsOk === 0) {
		console.error(`load-client produced no sessions:\n${stderr.slice(-2000)}`);
		process.exit(2);
	}
	console.log(`__ARM_RESULT__${JSON.stringify(result)}`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------

async function runOne(arm: Arm, round: number, port: number): Promise<ArmRun> {
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
	};
	if (arm.workers) env[WORKERS_ENV] = arm.workers;
	else delete env[WORKERS_ENV];

	const child = Bun.spawn(
		[
			"bun",
			join("tools", "bench", "worker-thread-parallelism-probe.ts"),
			"--child",
			"--label",
			arm.label,
			"--port",
			String(port),
			"--round",
			String(round),
			"--sessions",
			String(arm.sessions),
			"--rate",
			String(arm.rate),
		],
		{ cwd: ROOT, stdout: "pipe", stderr: "pipe", env },
	);
	const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
	try {
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		const exitCode = await child.exited;
		const line = stdout.split("\n").find((l) => l.startsWith("__ARM_RESULT__"));
		if (exitCode !== 0 || !line) {
			throw new Error(
				`arm ${arm.label} round ${round} failed (exit ${exitCode}): ${stderr.slice(-1500)}`,
			);
		}
		return JSON.parse(line.slice("__ARM_RESULT__".length)) as ArmRun;
	} finally {
		clearTimeout(timer);
	}
}

export type ArmSummary = {
	label: string;
	workers: string;
	sessions: number;
	ratePerSession: number;
	medianReceivedPerSec: number;
	medianServerCpuCores: number;
	maxSaturationRatio: number;
	/** Distinct OS threads that processed datagrams, worst (lowest) round. */
	minDatagramThreads: number;
	maxDatagramThreads: number;
	configuredWorkers: number | null;
	runs: ArmRun[];
};

export function summarizeSweep(arms: Arm[], runs: ArmRun[]): ArmSummary[] {
	return arms.map((arm) => {
		const armRuns = runs.filter((r) => r.label === arm.label);
		const threads = armRuns.map((r) => r.workerProof.datagramThreads ?? 0);
		return {
			label: arm.label,
			workers: arm.workers,
			sessions: arm.sessions,
			ratePerSession: arm.rate,
			medianReceivedPerSec: median(armRuns.map((r) => r.receivedPerSec)),
			medianServerCpuCores: median(armRuns.map((r) => r.serverCpuCores)),
			maxSaturationRatio: Math.max(...armRuns.map((r) => r.saturationRatio)),
			minDatagramThreads: Math.min(...threads),
			maxDatagramThreads: Math.max(...threads),
			configuredWorkers: armRuns[0]?.workerProof.configured ?? null,
			runs: armRuns,
		};
	});
}

/**
 * Did the knob take effect? Two independent checks per arm, both required.
 *
 * `configured` catches a harness that never passed the variable; the observed
 * distinct-thread count catches a runtime that accepted it and then ran
 * everything on one worker anyway. Neither alone is sufficient — the first is
 * self-reported, and the second can legitimately be 1 on a 1-worker arm.
 */
export function proofFailures(summaries: ArmSummary[]): string[] {
	const failures: string[] = [];
	for (const s of summaries) {
		const expected =
			s.workers === "auto"
				? (s.runs[0]?.workerProof.availableParallelism ?? null)
				: Number(s.workers);
		if (s.configuredWorkers === null) {
			failures.push(`${s.label}: addon reported no worker-probe snapshot`);
			continue;
		}
		if (expected !== null && s.configuredWorkers !== expected) {
			failures.push(
				`${s.label}: runtime configured ${s.configuredWorkers} workers, expected ${expected}`,
			);
		}
		if (s.configuredWorkers > 1 && s.maxDatagramThreads < 2) {
			failures.push(
				`${s.label}: configured ${s.configuredWorkers} workers but datagrams ` +
					"only ever landed on one OS thread — the arm is indistinguishable " +
					"from workers=1 and its result cannot be read as a negative",
			);
		}
		if (s.configuredWorkers === 1 && s.maxDatagramThreads > 1) {
			failures.push(
				`${s.label}: one worker configured but ${s.maxDatagramThreads} threads ` +
					"processed datagrams",
			);
		}
	}
	return failures;
}

function nonFiniteFailures(runs: ArmRun[]): string[] {
	return runs
		.filter(
			(r) =>
				!Number.isFinite(r.receivedPerSec) ||
				r.receivedPerSec <= 0 ||
				!Number.isFinite(r.serverCpuCores),
		)
		.map((r) => `${r.label} round ${r.round}: non-finite or zero sample`);
}

async function runSweep(
	name: string,
	arms: Arm[],
	rng: () => number,
	portBase: number,
): Promise<{ runs: ArmRun[]; order: string[] }> {
	const runs: ArmRun[] = [];
	const order: string[] = [];
	// Alternate arms round by round rather than running each arm's reps as a
	// block: a host that heats up part-way through would otherwise hand the whole
	// penalty to whichever arm ran last.
	for (let round = 1; round <= REPS; round += 1) {
		for (const arm of shuffled(arms, rng)) {
			order.push(`r${round}:${arm.label}`);
			console.log(
				`probe: ${name} round ${round}/${REPS} ${arm.label} ` +
					`(${arm.sessions} sessions x ${arm.rate}/s) ...`,
			);
			runs.push(await runOne(arm, round, portBase + runs.length));
		}
	}
	return { runs, order };
}

function printSweep(name: string, summaries: ArmSummary[]): void {
	console.log(`\n  ${name}`);
	for (const s of summaries) {
		console.log(
			`    ${s.label.padEnd(16)} ` +
				`${Math.round(s.medianReceivedPerSec).toLocaleString().padStart(9)} recv/s  ` +
				`${s.medianServerCpuCores.toFixed(2)} cores  ` +
				`sat ${s.maxSaturationRatio.toFixed(3)}  ` +
				`workers=${s.configuredWorkers}  ` +
				`dgram threads ${s.minDatagramThreads}-${s.maxDatagramThreads}`,
		);
	}
}

async function runParent(): Promise<void> {
	if (!(await Bun.file(CLIENT_BIN).exists())) {
		console.error(
			`probe: REFUSED\n  ${CLIENT_BIN} is missing; build it with ` +
				"`CARGO_TARGET_DIR=$PWD/target cargo build -p reference --bin load-client --release`",
		);
		process.exit(1);
	}

	const head = gitOutput(["rev-parse", "HEAD"]);
	const dirtyBefore = dirtyPaths(gitOutput(["status", "--porcelain"]));
	const dirty = dirtyBefore.length > 0;
	const identityFailures: string[] = [];
	if (!head) identityFailures.push("git HEAD is unreadable");
	if (dirty) {
		identityFailures.push(
			"working tree is dirty; a measurement that cannot be tied to a commit " +
				`is not evidence (${dirtyBefore.slice(0, 5).join(", ")})`,
		);
	}
	if (identityFailures.length > 0) {
		console.error(`probe: REFUSED\n  ${identityFailures.join("\n  ")}`);
		process.exit(1);
	}

	const seed = Number(process.env.WT_PROBE_SEED ?? "20260816");
	const rng = makeRng(seed);
	const workers = workerArms();
	const sessions = sessionArms();
	const workerSweep = await runSweep("workers", workers, rng, BASE_PORT);
	const sessionSweep = await runSweep(
		"sessions",
		sessions,
		rng,
		BASE_PORT + 200,
	);

	const workerSummary = summarizeSweep(workers, workerSweep.runs);
	const sessionSummary = summarizeSweep(sessions, sessionSweep.runs);
	const allRuns = [...workerSweep.runs, ...sessionSweep.runs];

	const headAfter = gitOutput(["rev-parse", "HEAD"]);
	const failures = [
		...(headAfter === head
			? []
			: [`HEAD moved mid-run: ${head} -> ${headAfter}`]),
		...(dirtyPaths(gitOutput(["status", "--porcelain"])).length > 0
			? ["working tree became dirty mid-run"]
			: []),
		...nonFiniteFailures(allRuns),
		...proofFailures(workerSummary),
		...proofFailures(sessionSummary),
	];

	const baseline = workerSummary.find((s) => s.workers === "1");
	const best = workerSummary.reduce(
		(a, b) => (b.medianReceivedPerSec > a.medianReceivedPerSec ? b : a),
		workerSummary[0] as ArmSummary,
	);
	const workerSpeedup =
		baseline && baseline.medianReceivedPerSec > 0
			? best.medianReceivedPerSec / baseline.medianReceivedPerSec
			: null;

	const artifact = {
		version: 1,
		mode: "worker-thread-parallelism-probe",
		kind: "probe",
		status: failures.length === 0 ? "ok" : "refused",
		generatedAtMs: Date.now(),
		head,
		dirty,
		bunVersion: Bun.version,
		platform: `${process.platform}/${process.arch}`,
		machine: process.env.BENCH_MACHINE_IDENTITY?.trim() || hostname(),
		command: COMMAND,
		design: {
			aggregateOfferedPerSec: AGGREGATE_PER_SEC,
			saturationSessions: SATURATION_SESSIONS,
			payloadBytes: PAYLOAD_BYTES,
			warmupSec: WARMUP_SEC,
			measureSec: MEASURE_SEC,
			reps: REPS,
			clients: CLIENTS,
			saturationCeiling: SATURATION_CEILING,
			seed,
			workerOrder: workerSweep.order,
			sessionOrder: sessionSweep.order,
		},
		workerSweep: workerSummary,
		sessionSweep: sessionSummary,
		workerSpeedup,
		failures,
	};
	mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
	writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));

	printSweep(
		`WORKER SWEEP (${SATURATION_SESSIONS} sessions, ~${AGGREGATE_PER_SEC.toLocaleString()}/s offered)`,
		workerSummary,
	);
	printSweep(
		`SESSION SWEEP (workers=1, ~${AGGREGATE_PER_SEC.toLocaleString()}/s offered)`,
		sessionSummary,
	);
	console.log(
		`\n  best worker arm / workers=1: ${workerSpeedup?.toFixed(4) ?? "n/a"}x (${best.label})`,
	);
	if (failures.length > 0)
		console.log(`\nprobe: REFUSED\n  ${failures.join("\n  ")}`);
	console.log(`\nartifact: ${ARTIFACT_PATH}`);
	process.exit(failures.length === 0 ? 0 : 1);
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const flag = (name: string): string | null => {
		const i = argv.indexOf(name);
		return i >= 0 ? (argv[i + 1] ?? null) : null;
	};
	const run = argv.includes("--child")
		? runChild(
				flag("--label") ?? "child",
				Number(flag("--port") ?? BASE_PORT),
				Number(flag("--round") ?? 1),
				Number(flag("--sessions") ?? SATURATION_SESSIONS),
				Number(flag("--rate") ?? 1000),
			)
		: runParent();
	run.catch((err) => {
		console.error("probe: crashed", err);
		process.exit(1);
	});
}
