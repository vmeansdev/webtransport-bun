#!/usr/bin/env bun
/**
 * Session-count scaling ladder against the addon server.
 *
 * Session count is the only variable: every rung holds sessions at the same
 * deliberately low per-session datagram rate (default 0.2/s, 100-byte payloads,
 * no echo), so what moves between rungs is the per-session cost, not packet
 * rate. Per rung it reports RSS, committed (RssAnon+VmSwap), fd count, CPU
 * (steady and idle separately), accept latency and accept rate, and
 * steady-state delivery — then classifies the rung with the buckets
 * pre-registered in docs/research/preregistrations/session-scale.md.
 *
 * This is a measurement harness, not a gate. Generator saturation makes a rung
 * *incomplete*, never a capacity number: the load client is co-resident on the
 * same 4 vCPU runner, and a client number reported as a server number is the
 * exact mistake the probe ladder was built to avoid.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	appendFileSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/scale-client`;

const LADDER = (process.env.SCALE_SESSIONS ?? "100,1000,5000,10000,25000,50000")
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
const PAYLOAD_BYTES = parseInt(process.env.SCALE_PAYLOAD_BYTES ?? "100", 10);
const INTERVAL_MS = parseInt(process.env.SCALE_INTERVAL_MS ?? "5000", 10);
const STEADY_SECONDS = parseInt(process.env.SCALE_STEADY_SECONDS ?? "120", 10);
const IDLE_SECONDS = parseInt(process.env.SCALE_IDLE_SECONDS ?? "30", 10);
const SETTLE_SECONDS = parseInt(process.env.SCALE_SETTLE_SECONDS ?? "15", 10);
const ENDPOINTS = parseInt(process.env.SCALE_ENDPOINTS ?? "64", 10);
const CONNECT_CONCURRENCY = parseInt(
	process.env.SCALE_CONNECT_CONCURRENCY ?? "500",
	10,
);
const CONNECT_TIMEOUT_SECONDS = parseInt(
	process.env.SCALE_CONNECT_TIMEOUT_SECONDS ?? "300",
	10,
);
const SAMPLE_INTERVAL_MS = parseInt(process.env.SCALE_SAMPLE_MS ?? "2000", 10);
/** Memory watchdog cadence. Independent of the phase sampler above so the
 * connect ramp — where run 32168754965 died — is covered like any other phase. */
const WATCHDOG_INTERVAL_MS = Math.min(
	2000,
	parseInt(process.env.SCALE_WATCHDOG_MS ?? "2000", 10),
);
/** How long the emergency path waits on server.close() before exiting anyway. */
const ABORT_CLOSE_TIMEOUT_MS = 3000;
/** Settling time between the client's last steady send and the server-side
 * counter snapshot that closes the steady window. Must stay far below
 * SCALE_IDLE_SECONDS, which is the window it borrows from. */
const DRAIN_GRACE_MS = parseInt(process.env.SCALE_DRAIN_GRACE_MS ?? "1000", 10);
/** How long a rung's sessions may take to disappear from the server before the
 * next rung starts anyway (and starts contaminated, and says so). Generous
 * because the backstop is the 120 s server idle timeout: sessions a killed
 * client left behind are reaped, not leaked. */
const DRAIN_TIMEOUT_SECONDS = parseInt(
	process.env.SCALE_DRAIN_TIMEOUT_SECONDS ?? "180",
	10,
);
/** Sessions allowed to still be open when the next rung starts. Zero: any
 * survivor is another rung's memory being charged to this one. */
const DRAIN_BASELINE_SESSIONS = 0;
const PORT = parseInt(process.env.SCALE_PORT ?? "4433", 10);
const OUT_JSON =
	process.env.SCALE_OUT ?? join(ROOT, "tools/load/bench-session-scale.json");
const OUT_CSV = OUT_JSON.replace(/\.json$/, ".csv");

const HAS_PROC = process.platform === "linux";

// --- Pre-registered classifier thresholds. Changing one changes the verdict,
// so they live here as named constants and are stamped into the output. ---
const T = {
	minConnectedRatio: 0.99,
	minOfferedRatio: 0.9,
	minDeliveryRatio: 0.95,
	serverCpuPctLimited: 300,
	clientCpuPctLimited: 300,
	hostCpuPctLimited: 360,
	hostMemAvailableFloorMb: 500,
	/** S3 abort floor, raised from 500MB by Amendment 1 of the pre-registration
	 * after run 32168754965 swap-killed the host before the 500MB rule could
	 * fire. Deliberately *not* the same number as the bucket-4 classifier rule
	 * above, which stays at its pre-registered 500MB: tightening a STOP may only
	 * make the ladder stop earlier, never reclassify a rung. */
	hostMemAvailableAbortMb: 1000,
	coResidentRssCeilingMb: 6500,
	acceptWallLimitSec: 120,
} as const;

type CpuSnapshot = { busy: number; total: number };

function readHostCpu(): CpuSnapshot | null {
	if (!HAS_PROC) return null;
	const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
	const fields = line.trim().split(/\s+/).slice(1).map(Number);
	const total = fields.reduce((a, b) => a + b, 0);
	const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
	return { busy: total - idle, total };
}

/** Percent of ONE core, so a 4 vCPU box tops out near 400. */
function hostCpuPct(
	prev: CpuSnapshot | null,
	next: CpuSnapshot | null,
): number | null {
	if (!prev || !next || next.total === prev.total) return null;
	const cores = navigator?.hardwareConcurrency ?? 1;
	return ((next.busy - prev.busy) / (next.total - prev.total)) * 100 * cores;
}

function serverCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

function procStatusKb(path: string, key: string): number | null {
	if (!HAS_PROC) return null;
	try {
		const status = readFileSync(path, "utf8");
		const m = status.match(new RegExp(`^${key}:\\s+(\\d+) kB`, "m"));
		return m?.[1] ? parseInt(m[1], 10) : 0;
	} catch {
		return null;
	}
}

function serverMem(): { rssMb: number; committedMb: number | null } {
	const rssMb = process.memoryUsage().rss / (1024 * 1024);
	const anon = procStatusKb("/proc/self/status", "RssAnon");
	const swap = procStatusKb("/proc/self/status", "VmSwap");
	if (anon === null) return { rssMb, committedMb: null };
	return { rssMb, committedMb: (anon + (swap ?? 0)) / 1024 };
}

function serverFdCount(): number | null {
	if (!HAS_PROC) return null;
	try {
		return readdirSync("/proc/self/fd").length;
	} catch {
		return null;
	}
}

function clientRssMb(pid: number): number | null {
	const kb = procStatusKb(`/proc/${pid}/status`, "VmRSS");
	return kb === null ? null : kb / 1024;
}

function hostMemAvailableMb(): number | null {
	if (!HAS_PROC) return null;
	try {
		const m = readFileSync("/proc/meminfo", "utf8").match(
			/^MemAvailable:\s+(\d+) kB/m,
		);
		return m?.[1] ? parseInt(m[1], 10) / 1024 : null;
	} catch {
		return null;
	}
}

// The load client is spawned detached so it leads its own process group, and one
// negative-pid kill takes its whole tree. Run 32168754965 left bench processes
// alive after job teardown; those orphans, not the ladder, drove the host into
// swap-death, so teardown here is unconditional on every exit path.
let activeChild: ChildProcess | null = null;
/** Set once the ladder is running, so a throw at top level still flushes the
 * rungs that already completed. */
let emergencyTeardown: (reason: string) => void = () => {};

function killChildGroup(signal: NodeJS.Signals = "SIGKILL"): void {
	const child = activeChild;
	if (!child) return;
	const pid = child.pid;
	if (pid !== undefined) {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			// Group already reaped, or the child never became a group leader.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// Nothing left to kill.
	}
}

type ClientReport = {
	schema: string;
	sessionsRequested: number;
	sessionsOk: number;
	sessionsErr: number;
	sessionsLost: number;
	connectWallSec: number;
	connectTimedOut: boolean;
	acceptsPerSec: number | null;
	acceptMs: {
		p50: number | null;
		p90: number | null;
		p99: number | null;
		max: number | null;
	};
	steady: {
		sent: number;
		err: number;
		received: number;
		expectedSends: number;
		/** Ticks one session is scheduled to fire inside the steady window. The
		 * boundary tick is excluded by construction — see scale_client.rs. */
		expectedTicksPerSession: number;
		wallSec: number;
	};
	idle: { sent: number; err: number; received: number };
	client: {
		rssMbSteady: number | null;
		rssMbIdle: number | null;
		/** CPU ms per phase window, not cumulative: connect is the expensive
		 * phase and must not leak into the steady rate. */
		cpuMsConnect: number | null;
		cpuMsSteady: number | null;
		cpuMsIdle: number | null;
		fdCount: number | null;
		endpoints: number;
		/** Endpoints that actually got their own 127.0.k.1 source address. Fewer
		 * than `endpoints` means the run exercised fewer distinct rate-limit
		 * keys than intended, which the stamp must not hide. */
		distinctSourceIps: number;
	};
	connectErrorsSample: string[];
};

type Window = {
	serverRx: number;
	serverCpuMs: number;
	wallMs: number;
	metrics: {
		rateLimited: number;
		limitExceeded: number;
		datagramsDropped: number;
		sessionsActive: number;
	};
};

type Rung = {
	sessions: number;
	bucket: string;
	bucketReason: string;
	/** S1 propagation: true on the generator-limited rung itself and on every
	 * rung above it. Such a rung is never a server capacity number and never
	 * enters the curve, whatever its own bucket says. */
	incompleteUnlessOffBox: boolean;
	s1PropagatedFromSessions: number | null;
	/** Non-empty when a measurement window had to be synthesized or the rung
	 * started dirty. A degraded rung is excluded from the curve and can never
	 * read `ok`. */
	degraded: string[];
	connectedRatio: number | null;
	offeredRatio: number | null;
	deliveryRatio: number | null;
	acceptsPerSec: number | null;
	acceptMs: ClientReport["acceptMs"];
	connectWallSec: number;
	connectTimedOut: boolean;
	serverRssMbMax: number;
	serverCommittedMbMax: number | null;
	serverFdCountMax: number | null;
	/** All three are windowed rates over their own phase, percent of one core. */
	serverCpuPctConnect: number | null;
	serverCpuPctSteady: number | null;
	serverCpuPctIdle: number | null;
	hostCpuPctMedianSteady: number | null;
	clientRssMbMax: number | null;
	clientCpuPctConnect: number | null;
	clientCpuPctSteady: number | null;
	clientCpuPctIdle: number | null;
	hostMemAvailableMbMin: number | null;
	rateLimitedTotal: number;
	limitExceededTotal: number;
	datagramsDroppedTotal: number;
	sessionsActiveMax: number;
	/** sessionsActive on the server the instant this rung started. Anything
	 * above zero is a previous rung's sessions still being paid for here. */
	sessionsActiveAtStart: number;
	steadySent: number;
	steadyServerRx: number;
	idleServerRx: number;
	/** Per-stage receive counters, so a delivery deficit is localizable instead
	 * of being one number that could mean anything:
	 *   connect — datagrams the server saw before the steady marker (should be 0)
	 *   steady  — inside the steady window proper
	 *   drain   — arrived during the post-boundary grace (in-flight at the edge)
	 *   idle    — after the steady window closed (should be 0: idle sends nothing)
	 * deliveryRatio counts steady+drain, so a large `drain` is a boundary
	 * artifact and a deficit with a small `drain` is real loss. */
	phaseServerRx: {
		connect: number;
		steady: number;
		drain: number;
		idle: number;
	};
	sessionsLost: number;
	clientDistinctSourceIps: number | null;
	/** The generator's own RSS self-guard tripped and it aborted the rung. */
	clientRssGuardFired: boolean;
	connectErrorsSample: string[];
};

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/**
 * Pre-registered buckets, first match wins. Order matters: a rung the generator
 * could not source must never fall through into a server verdict.
 */
function classify(r: {
	sessionsOk: number;
	connectedRatio: number | null;
	offeredRatio: number | null;
	deliveryRatio: number | null;
	rateLimitedTotal: number;
	limitExceededTotal: number;
	hostMemAvailableMbMin: number | null;
	serverRssMbMax: number;
	clientRssMbMax: number | null;
	connectWallSec: number;
	serverCpuPctSteady: number | null;
	clientCpuPctSteady: number | null;
	hostCpuPctMedianSteady: number | null;
	threw: boolean;
	connectTimedOut: boolean;
	clientRssGuardFired: boolean;
}): { bucket: string; reason: string } {
	// The client's RSS self-guard routes here rather than into a bucket of its
	// own: a generator that aborted itself produced no rung verdict, which is
	// exactly what bucket 1 already means. No bucket is added or reordered.
	if (r.clientRssGuardFired) {
		return {
			bucket: "harness-error",
			reason: "client RSS self-guard fired: generator aborted its own run",
		};
	}
	if (r.threw || r.sessionsOk === 0) {
		return { bucket: "harness-error", reason: "rung threw or zero sessions" };
	}
	// S5's registered trigger and its registered bucket, together: the connect
	// phase ran past its timeout, so the rung is a harness error and the ladder
	// stops. This is the only thing that may be labelled S5.
	if (r.connectTimedOut) {
		return {
			bucket: "harness-error",
			reason: `S5 connect timeout: connect phase ${r.connectWallSec.toFixed(1)}s exceeded the timeout`,
		};
	}
	if (r.rateLimitedTotal > 0 || r.limitExceededTotal > 0) {
		return {
			bucket: "limiter-contaminated",
			reason: `rateLimited=${r.rateLimitedTotal} limitExceeded=${r.limitExceededTotal}: measuring the limiter, not the server`,
		};
	}
	if ((r.offeredRatio ?? 0) < T.minOfferedRatio) {
		return {
			bucket: "generator-limited",
			reason: `offeredRatio=${r.offeredRatio?.toFixed(3)} < ${T.minOfferedRatio}: incomplete-unless-off-box`,
		};
	}
	if (
		(r.connectedRatio ?? 0) < T.minConnectedRatio &&
		r.rateLimitedTotal === 0 &&
		r.limitExceededTotal === 0
	) {
		return {
			bucket: "generator-limited",
			reason: `connectedRatio=${r.connectedRatio?.toFixed(3)} with zero server rejections: client/OS-side connect failures`,
		};
	}
	if (
		(r.hostMemAvailableMbMin ?? Number.POSITIVE_INFINITY) <
		T.hostMemAvailableFloorMb
	) {
		return {
			bucket: "host-memory-limited",
			reason: `MemAvailable dropped to ${r.hostMemAvailableMbMin?.toFixed(0)}MB`,
		};
	}
	if (r.serverRssMbMax + (r.clientRssMbMax ?? 0) > T.coResidentRssCeilingMb) {
		return {
			bucket: "host-memory-limited",
			reason: `server+client RSS ${(r.serverRssMbMax + (r.clientRssMbMax ?? 0)).toFixed(0)}MB > ${T.coResidentRssCeilingMb}MB: co-residence contaminates the server number`,
		};
	}
	if (r.connectWallSec > T.acceptWallLimitSec) {
		return {
			bucket: "accept-limited",
			reason: `connect phase ${r.connectWallSec.toFixed(1)}s > ${T.acceptWallLimitSec}s`,
		};
	}
	if (
		(r.deliveryRatio ?? 0) < T.minDeliveryRatio ||
		(r.serverCpuPctSteady ?? 0) >= T.serverCpuPctLimited
	) {
		return {
			bucket: "server-limited",
			reason: `deliveryRatio=${r.deliveryRatio?.toFixed(3)} serverCpu=${r.serverCpuPctSteady?.toFixed(0)}%`,
		};
	}
	if (
		(r.hostCpuPctMedianSteady ?? 0) >= T.hostCpuPctLimited &&
		(r.serverCpuPctSteady ?? 0) < T.serverCpuPctLimited &&
		(r.clientCpuPctSteady ?? 0) < T.clientCpuPctLimited
	) {
		return {
			bucket: "host-limited",
			reason: `hostCpu=${r.hostCpuPctMedianSteady?.toFixed(0)}% with neither process saturated`,
		};
	}
	if (
		(r.connectedRatio ?? 0) >= T.minConnectedRatio &&
		(r.offeredRatio ?? 0) >= T.minOfferedRatio &&
		(r.deliveryRatio ?? 0) >= T.minDeliveryRatio
	) {
		return { bucket: "ok", reason: "all pre-registered thresholds met" };
	}
	return { bucket: "unclassified", reason: "treated as incomplete" };
}

/**
 * Curve shape across `ok` rungs only. A knee that coincides with a
 * generator-limited rung is a generator artifact, not a server knee, so those
 * rungs are excluded by construction.
 */
function curveShape(rungs: Rung[]) {
	// `ok` is necessary but not sufficient: a rung at or above a generator-limited
	// one is incomplete-unless-off-box by pre-registration, and a rung whose
	// measurement windows were synthesized has no trustworthy memory curve point.
	const ok = rungs.filter(
		(r) =>
			r.bucket === "ok" && !r.incompleteUnlessOffBox && r.degraded.length === 0,
	);
	// Committed (RssAnon+VmSwap) is the pre-registered memory metric and is
	// always available on the Linux runner. RSS is the fallback so the local
	// macOS smoke still produces a parseable curve; which one was used is
	// stamped, because the two are not interchangeable as evidence.
	const metric: "committed" | "rss" = ok.every(
		(r) => r.serverCommittedMbMax !== null,
	)
		? "committed"
		: "rss";
	const memMb = (r: Rung) =>
		metric === "committed" ? (r.serverCommittedMbMax ?? 0) : r.serverRssMbMax;
	const marginals: {
		fromSessions: number;
		toSessions: number;
		kbPerSession: number;
	}[] = [];
	for (let i = 1; i < ok.length; i += 1) {
		const prev = ok[i - 1];
		const cur = ok[i];
		if (!prev || !cur) continue;
		const dSessions = cur.sessions - prev.sessions;
		if (dSessions <= 0) continue;
		const dMb = memMb(cur) - memMb(prev);
		marginals.push({
			fromSessions: prev.sessions,
			toSessions: cur.sessions,
			kbPerSession: (dMb * 1024) / dSessions,
		});
	}
	const baseline = marginals[0]?.kbPerSession ?? null;
	let knee: { atSessions: number; kbPerSession: number } | null = null;
	if (baseline !== null && baseline !== 0) {
		for (const m of marginals.slice(1)) {
			const ratio = Math.abs(m.kbPerSession / baseline);
			if (ratio > 2 || ratio < 0.5) {
				knee = { atSessions: m.toSessions, kbPerSession: m.kbPerSession };
				break;
			}
		}
	}
	return {
		memoryMetric: metric,
		okRungs: ok.map((r) => r.sessions),
		marginals,
		baselineKbPerSession: baseline,
		linear: baseline !== null && knee === null,
		knee,
		idleMillicoresPer1000Sessions: ok.map((r) => ({
			sessions: r.sessions,
			value:
				r.serverCpuPctIdle === null
					? null
					: (r.serverCpuPctIdle * 10 * 1000) / r.sessions,
		})),
	};
}

async function main(): Promise<void> {
	if (LADDER.length === 0) throw new Error("SCALE_SESSIONS parsed empty");
	console.log("bench-session-scale: building scale-client (release)...");
	try {
		await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin scale-client --release`.quiet();
	} catch (err) {
		if (!(await Bun.file(CLIENT_BIN).exists())) throw err;
		console.warn(
			"bench-session-scale: cargo build failed; using existing scale-client binary",
		);
	}

	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	let serverRx = 0;
	const topSessions = Math.max(...LADDER);
	const aggregatePeak = Math.ceil((topSessions * 1000) / INTERVAL_MS);
	const server = createServer({
		port: PORT,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: topSessions * 2,
			maxHandshakesInFlight: topSessions * 2,
			// Sessions are held for minutes at a 5s send interval; the default
			// 60s idle timeout would reap them mid-rung on a busy host.
			idleTimeoutMs: 120_000,
		},
		rateLimits: {
			// Every one of these is set above the top rung on purpose: a rung that
			// trips a limiter measures configuration, and is bucketed invalid.
			handshakesPerSec: topSessions * 2,
			handshakesBurst: topSessions * 2,
			handshakesBurstPerPrefix: topSessions * 2,
			streamsPerSec: 1000,
			streamsBurst: 2000,
			datagramsPerSec: Math.max(aggregatePeak * 8, 20_000),
			datagramsBurst: Math.max(aggregatePeak * 16, 40_000),
		},
		onSession: (session) => {
			void (async () => {
				// Fan-in shape: consume, never echo. Echo would double the packet
				// rate and re-introduce the throughput axis this run excludes.
				for await (const _datagram of session.incomingDatagrams()) {
					serverRx += 1;
				}
			})().catch(() => {});
		},
	});
	// createServer has no readiness promise (same pattern as load-addon.ts).
	await Bun.sleep(3000);
	console.log(
		`bench-session-scale: server up on ${PORT}; ladder=[${LADDER.join(",")}] interval=${INTERVAL_MS}ms payload=${PAYLOAD_BYTES}B steady=${STEADY_SECONDS}s idle=${IDLE_SECONDS}s endpoints=${ENDPOINTS}`,
	);

	// serverCpuPct is a windowed rate over the sample interval, and serverRxDelta
	// is the receive count inside that same window: a per-phase loss question is
	// answered by summing rows of one phase, not by differencing two run totals.
	writeFileSync(
		OUT_CSV,
		"rung,sessions,ts_ms,phase,windowMs,hostCpuPct,serverCpuPct,serverRssMb,serverCommittedMb,serverFd,clientRssMb,memAvailableMb,sessionsActive,serverRxDelta,serverRxSinceRungStart\n",
	);

	const rungs: Rung[] = [];
	const startedAt = new Date().toISOString();
	let ladderAborted: string | null = null;
	/** Lowest MemAvailable seen in the current rung, written by both the phase
	 * sampler and the independent watchdog. */
	let rungMemAvailableMin: number | null = null;
	/** S1: the first rung the generator could not source. Pre-registration: that
	 * rung *and every rung above it* are incomplete-unless-off-box, because a
	 * generator that could not fill rung N cannot be assumed to have filled
	 * rung N+1 — its own numbers there are a client measurement wearing a server
	 * label. Set once, never cleared. */
	let s1LimitedAtSessions: number | null = null;

	const buildResult = () => ({
		version: 1,
		schema: "bench-session-scale/1",
		startedAt,
		writtenAt: new Date().toISOString(),
		complete: rungs.length === LADDER.length && ladderAborted === null,
		preRegistration: "docs/research/preregistrations/session-scale.md",
		host: {
			platform: process.platform,
			cpus: navigator?.hardwareConcurrency ?? null,
			bunVersion: Bun.version,
		},
		config: {
			ladder: LADDER,
			payloadBytes: PAYLOAD_BYTES,
			datagramIntervalMs: INTERVAL_MS,
			steadySeconds: STEADY_SECONDS,
			idleSeconds: IDLE_SECONDS,
			settleSeconds: SETTLE_SECONDS,
			drainGraceMs: DRAIN_GRACE_MS,
			drainTimeoutSeconds: DRAIN_TIMEOUT_SECONDS,
			endpoints: ENDPOINTS,
			connectConcurrency: CONNECT_CONCURRENCY,
			watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
			echo: false,
			thresholds: T,
		},
		rungs,
		notRun: LADDER.filter((s) => !rungs.some((r) => r.sessions === s)),
		ladderAborted,
		curve: curveShape(rungs),
	});

	// Written after every rung and on every abort path, by atomic rename over the
	// same path. Run 32168754965 crashed 29 minutes in and left nothing at all;
	// completed rungs are evidence and must survive the run that produced them.
	const flushResult = () => {
		const tmp = `${OUT_JSON}.partial`;
		writeFileSync(tmp, `${JSON.stringify(buildResult(), null, 2)}\n`);
		renameSync(tmp, OUT_JSON);
	};

	let tornDown = false;
	const teardown = (reason: string) => {
		if (tornDown) return;
		tornDown = true;
		ladderAborted ??= reason;
		killChildGroup("SIGKILL");
		try {
			flushResult();
		} catch (err) {
			console.error(`bench-session-scale: partial flush failed: ${err}`);
		}
	};

	emergencyTeardown = teardown;

	// Last-resort net: even an unhandled throw must not leave the client running.
	process.on("exit", () => killChildGroup("SIGKILL"));
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => {
			teardown(`signal ${signal}`);
			process.exit(128);
		});
	}

	// S3 (pre-registration Amendment 1): MemAvailable sampled on a timer that
	// knows nothing about phases, so the connect ramp is covered too, and the
	// abort tears the load down instead of waiting for a graceful drain.
	let watchdogSamples = 0;
	let aborting = false;
	const emergencyAbort = (reason: string) => {
		if (aborting) return;
		aborting = true;
		console.error(`bench-session-scale: WATCHDOG ABORT — ${reason}`);
		teardown(reason);
		// Bounded: the point of the abort is to stop consuming memory now. A
		// server that will not close in a few seconds is not worth waiting for.
		void Promise.race([
			server.close(),
			new Promise((res) => setTimeout(res, ABORT_CLOSE_TIMEOUT_MS)),
		]).finally(() => process.exit(0));
	};
	const watchdog = setInterval(() => {
		watchdogSamples += 1;
		const avail = hostMemAvailableMb();
		if (avail !== null) {
			rungMemAvailableMin = Math.min(rungMemAvailableMin ?? avail, avail);
			if (avail < T.hostMemAvailableAbortMb) {
				emergencyAbort(
					`S3 host memory floor: MemAvailable ${avail.toFixed(0)}MB < ${T.hostMemAvailableAbortMb}MB`,
				);
			}
		}
		// Heartbeat so a run log proves the watchdog was alive, not just armed.
		if (watchdogSamples % 15 === 1) {
			console.log(
				`bench-session-scale: watchdog samples=${watchdogSamples} memAvailable=${avail?.toFixed(0) ?? "n/a"}MB`,
			);
		}
	}, WATCHDOG_INTERVAL_MS);
	watchdog.unref?.();
	console.log(
		`bench-session-scale: memory watchdog armed every ${WATCHDOG_INTERVAL_MS}ms, abort below ${T.hostMemAvailableAbortMb}MB MemAvailable${HAS_PROC ? "" : " (no /proc on this platform: readings are null)"}`,
	);

	for (const [index, sessions] of LADDER.entries()) {
		if (ladderAborted) {
			console.log(
				`bench-session-scale: rung ${sessions} not-run (${ladderAborted})`,
			);
			continue;
		}
		console.log(
			`bench-session-scale: rung ${index + 1}/${LADDER.length} sessions=${sessions}`,
		);
		const jsonOut = `${OUT_JSON}.rung-${sessions}.json`;
		rungMemAvailableMin = null;
		// detached: the client leads its own process group, so teardown can take
		// the whole tree with one kill instead of hoping the direct child is all
		// there is.
		const child = spawn(
			CLIENT_BIN,
			[
				"--url",
				`https://127.0.0.1:${PORT}`,
				"--sessions",
				String(sessions),
				"--endpoints",
				String(ENDPOINTS),
				"--connect-concurrency",
				String(CONNECT_CONCURRENCY),
				"--steady-secs",
				String(STEADY_SECONDS),
				"--idle-secs",
				String(IDLE_SECONDS),
				"--datagram-interval-ms",
				String(INTERVAL_MS),
				"--payload-bytes",
				String(PAYLOAD_BYTES),
				"--connect-timeout-secs",
				String(CONNECT_TIMEOUT_SECONDS),
				"--json-out",
				jsonOut,
			],
			{ cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true },
		);
		activeChild = child;

		const boundary = (): Window => ({
			serverRx,
			serverCpuMs: serverCpuMs(),
			wallMs: Date.now(),
			metrics: (() => {
				const m = server.metricsSnapshot();
				return {
					rateLimited: m.rateLimitedCount,
					limitExceeded: m.limitExceededCount,
					datagramsDropped: m.datagramsDropped,
					sessionsActive: m.sessionsActive,
				};
			})(),
		});

		// Held in one object because the phase markers are assigned from inside
		// the stdout pump; plain locals would be narrowed to `never` here.
		const state: {
			phase: string;
			steadyStart: Window | null;
			/** The client's idle marker: end of the steady window proper. */
			steadyMark: Window | null;
			/** steadyMark + drain grace: end of the steady *accounting* window. */
			steadyEnd: Window | null;
			idleEnd: Window | null;
			report: ClientReport | null;
			clientRssGuardFired: boolean;
		} = {
			phase: "connect",
			steadyStart: null,
			steadyMark: null,
			steadyEnd: null,
			idleEnd: null,
			report: null,
			clientRssGuardFired: false,
		};
		const rungStart = boundary();
		// Zero unless a previous rung's sessions outlived it — which would mean
		// this rung's memory and CPU are partly someone else's.
		const sessionsActiveAtStart = rungStart.metrics.sessionsActive;

		// Phase markers arrive on the client's stdout the instant it switches
		// phases, so both sides use the same boundaries.
		const stdoutText: string[] = [];
		const stdoutPump = (async () => {
			const decoder = new TextDecoder();
			let buffered = "";
			for await (const chunk of child.stdout ?? []) {
				buffered += decoder.decode(chunk as Uint8Array, { stream: true });
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					stdoutText.push(line);
					if (line.includes("phase steady")) {
						state.steadyStart = boundary();
						state.phase = "steady";
					} else if (line.includes("phase idle")) {
						state.steadyMark = boundary();
						// Labelled `drain`, not `idle`: these samples carry datagrams
						// that belong to the steady window, and calling them idle
						// would make the per-stage CSV lie about where they landed.
						state.phase = "drain";
						// Datagrams sent in the last instant of the steady phase are
						// still in flight when the client stops. Counting the server
						// side immediately would book them as loss; the idle phase
						// sends nothing, so a short drain grace attributes them
						// correctly instead of manufacturing a delivery deficit.
						setTimeout(() => {
							state.steadyEnd = boundary();
							state.phase = "idle";
						}, DRAIN_GRACE_MS);
					} else if (line.includes("phase stop")) {
						state.idleEnd = boundary();
						state.phase = "stop";
					}
					if (line.includes("abort client-rss-guard")) {
						state.clientRssGuardFired = true;
						console.error(`bench-session-scale: ${line}`);
					}
					const jsonMatch = line.match(/^scale-client: json (\{.*\})$/);
					if (jsonMatch?.[1]) {
						state.report = JSON.parse(jsonMatch[1]) as ClientReport;
					}
				}
			}
			if (buffered) stdoutText.push(buffered);
		})();
		const stderrPromise = (async () => {
			const chunks: string[] = [];
			const decoder = new TextDecoder();
			for await (const chunk of child.stderr ?? []) {
				chunks.push(decoder.decode(chunk as Uint8Array, { stream: true }));
			}
			return chunks.join("");
		})();

		const hostSteady: number[] = [];
		let prevSample = {
			wallMs: rungStart.wallMs,
			cpuMs: rungStart.serverCpuMs,
			serverRx: rungStart.serverRx,
		};
		let serverRssMbMax = 0;
		let serverCommittedMbMax: number | null = null;
		let serverFdCountMax: number | null = null;
		let clientRssMbMax: number | null = null;
		let sessionsActiveMax = 0;
		let prevHost = readHostCpu();
		let running = true;
		const exitCode = new Promise<number>((res) => {
			child.on("exit", (code, signal) => res(code ?? (signal ? 128 : -1)));
			child.on("error", () => res(-1));
		});
		const exited = exitCode.then(() => {
			running = false;
		});
		while (running) {
			await Promise.race([
				exited,
				new Promise((res) => setTimeout(res, SAMPLE_INTERVAL_MS)),
			]);
			const nextHost = readHostCpu();
			const host = hostCpuPct(prevHost, nextHost);
			prevHost = nextHost;
			const mem = serverMem();
			const fds = serverFdCount();
			const cRss = child.pid === undefined ? null : clientRssMb(child.pid);
			const avail = hostMemAvailableMb();
			const active = server.metricsSnapshot().sessionsActive;
			serverRssMbMax = Math.max(serverRssMbMax, mem.rssMb);
			if (mem.committedMb !== null) {
				serverCommittedMbMax = Math.max(
					serverCommittedMbMax ?? 0,
					mem.committedMb,
				);
			}
			if (fds !== null) serverFdCountMax = Math.max(serverFdCountMax ?? 0, fds);
			if (cRss !== null) clientRssMbMax = Math.max(clientRssMbMax ?? 0, cRss);
			if (avail !== null) {
				rungMemAvailableMin = Math.min(rungMemAvailableMin ?? avail, avail);
			}
			sessionsActiveMax = Math.max(sessionsActiveMax, active);
			if (state.phase === "steady" && host !== null) hostSteady.push(host);
			// Windowed, never cumulative: a running average since rung start decays
			// with elapsed time and would report a saturated steady phase as a
			// comfortable one just because the rung had been going a while.
			const nowMs = Date.now();
			const nowCpuMs = serverCpuMs();
			const windowMs = Math.max(nowMs - prevSample.wallMs, 1);
			const cpuPct = ((nowCpuMs - prevSample.cpuMs) / windowMs) * 100;
			const rxDelta = serverRx - prevSample.serverRx;
			prevSample = { wallMs: nowMs, cpuMs: nowCpuMs, serverRx };
			appendFileSync(
				OUT_CSV,
				`${index + 1},${sessions},${nowMs},${state.phase},${windowMs},${host?.toFixed(1) ?? ""},${cpuPct.toFixed(
					1,
				)},${mem.rssMb.toFixed(1)},${mem.committedMb?.toFixed(1) ?? ""},${fds ?? ""},${cRss?.toFixed(1) ?? ""},${avail?.toFixed(0) ?? ""},${active},${rxDelta},${serverRx - rungStart.serverRx}\n`,
			);
		}

		await exitCode;
		await stdoutPump;
		const stderr = await stderrPromise;
		// The rung is over either way; make sure nothing it spawned survives it.
		killChildGroup("SIGKILL");
		activeChild = null;
		// A missing phase marker means the client died before printing it. The
		// windows can still be closed at the child's exit so the rung reports
		// *something*, but a synthesized boundary is not the boundary that was
		// asked for: it silently stretches the steady window over whatever the
		// client was doing when it died. Every synthesis is recorded, and the
		// rung is degraded — never `ok`, never a point on the curve.
		const degraded: string[] = [];
		if (!state.steadyStart) {
			degraded.push("steadyStart marker never arrived");
		}
		if (!state.steadyMark) {
			degraded.push("idle marker never arrived: steady window synthesized");
			state.steadyMark = boundary();
		}
		if (!state.steadyEnd) {
			degraded.push("drain grace never closed: steadyEnd synthesized");
			state.steadyEnd = boundary();
		}
		if (!state.idleEnd) {
			degraded.push("stop marker never arrived: idleEnd synthesized");
			state.idleEnd = boundary();
		}
		if (sessionsActiveAtStart > 0) {
			degraded.push(
				`rung started with ${sessionsActiveAtStart} session(s) still active from the previous rung`,
			);
		}

		const parsed: ClientReport | null = state.report;
		if (!parsed) {
			// No client JSON means no rung verdict; dump both streams so the
			// failure is diagnosable from the run log alone.
			console.error(stdoutText.slice(-20).join("\n"));
			console.error(stderr.slice(-2000));
		}

		const windowPct = (
			from: Window | null,
			to: Window | null,
		): number | null => {
			if (!from || !to || to.wallMs <= from.wallMs) return null;
			return (
				((to.serverCpuMs - from.serverCpuMs) / (to.wallMs - from.wallMs)) * 100
			);
		};
		const rxBetween = (from: Window | null, to: Window | null): number =>
			from && to ? to.serverRx - from.serverRx : 0;
		// Per stage, so a delivery deficit says *where* it happened. `drain` is
		// the boundary artifact the grace exists to absorb; `idle` should be zero
		// because the idle phase sends nothing.
		const phaseServerRx = {
			connect: rxBetween(rungStart, state.steadyStart),
			steady: rxBetween(state.steadyStart, state.steadyMark),
			drain: rxBetween(state.steadyMark, state.steadyEnd),
			idle: rxBetween(state.steadyEnd, state.idleEnd),
		};
		const steadyServerRx = phaseServerRx.steady + phaseServerRx.drain;
		const idleServerRx = phaseServerRx.idle;
		const rateLimitedTotal =
			(state.idleEnd?.metrics.rateLimited ?? 0) - rungStart.metrics.rateLimited;
		const limitExceededTotal =
			(state.idleEnd?.metrics.limitExceeded ?? 0) -
			rungStart.metrics.limitExceeded;
		const droppedTotal =
			(state.idleEnd?.metrics.datagramsDropped ?? 0) -
			rungStart.metrics.datagramsDropped;

		const sessionsOk = parsed?.sessionsOk ?? 0;
		const steadySent = parsed?.steady.sent ?? 0;
		const expectedSends = parsed?.steady.expectedSends ?? 0;
		// The client reports CPU per phase window; divide by the same window, from
		// the steady marker to the idle marker. Dividing a steady-phase CPU
		// figure by a window that includes the connect ramp is the cumulative
		// average this ledger is fixing.
		const pctOver = (
			cpuMs: number | null | undefined,
			from: Window | null,
			to: Window | null,
		): number | null => {
			if (cpuMs == null || !from || !to || to.wallMs <= from.wallMs)
				return null;
			return (cpuMs / (to.wallMs - from.wallMs)) * 100;
		};
		const clientCpuPctSteady = pctOver(
			parsed?.client.cpuMsSteady,
			state.steadyStart,
			state.steadyMark,
		);
		const clientCpuPctIdle = pctOver(
			parsed?.client.cpuMsIdle,
			state.steadyMark,
			state.idleEnd,
		);
		const clientCpuPctConnect = pctOver(
			parsed?.client.cpuMsConnect,
			rungStart,
			state.steadyStart,
		);

		const metrics = {
			sessionsOk,
			connectedRatio: sessionsOk > 0 ? sessionsOk / sessions : 0,
			offeredRatio: expectedSends > 0 ? steadySent / expectedSends : null,
			deliveryRatio: steadySent > 0 ? steadyServerRx / steadySent : null,
			rateLimitedTotal,
			limitExceededTotal,
			hostMemAvailableMbMin: rungMemAvailableMin,
			serverRssMbMax,
			clientRssMbMax,
			connectWallSec: parsed?.connectWallSec ?? 0,
			serverCpuPctSteady: windowPct(state.steadyStart, state.steadyMark),
			clientCpuPctSteady,
			hostCpuPctMedianSteady: median(hostSteady),
			threw: parsed === null,
			connectTimedOut: parsed?.connectTimedOut ?? false,
			clientRssGuardFired: state.clientRssGuardFired,
		};
		let { bucket, reason } = classify(metrics);
		// Degradation cannot invent a bucket — the buckets are pre-registered —
		// but it must not be possible to read a verdict off a window that was
		// never measured. Only the verdicts that *depend* on the server-side
		// windows are demoted, into the already-registered incomplete category;
		// generator- and limiter-side verdicts are computed from the client
		// report and stand on their own.
		const windowDependent = new Set(["ok", "server-limited", "host-limited"]);
		if (degraded.length > 0 && windowDependent.has(bucket)) {
			reason = `${bucket} demoted: ${degraded.join("; ")}`;
			bucket = "unclassified";
		}

		if (bucket === "generator-limited" && s1LimitedAtSessions === null) {
			s1LimitedAtSessions = sessions;
		}
		if (s1LimitedAtSessions !== null && s1LimitedAtSessions !== sessions) {
			reason = `${reason} [S1: incomplete-unless-off-box, generator ran out at ${s1LimitedAtSessions} sessions]`;
		}

		const rung: Rung = {
			sessions,
			bucket,
			bucketReason: reason,
			incompleteUnlessOffBox: s1LimitedAtSessions !== null,
			s1PropagatedFromSessions: s1LimitedAtSessions,
			degraded,
			connectedRatio: metrics.connectedRatio,
			offeredRatio: metrics.offeredRatio,
			deliveryRatio: metrics.deliveryRatio,
			acceptsPerSec: parsed?.acceptsPerSec ?? null,
			acceptMs: parsed?.acceptMs ?? {
				p50: null,
				p90: null,
				p99: null,
				max: null,
			},
			connectWallSec: metrics.connectWallSec,
			connectTimedOut: parsed?.connectTimedOut ?? false,
			serverRssMbMax,
			serverCommittedMbMax,
			serverFdCountMax,
			serverCpuPctConnect: windowPct(rungStart, state.steadyStart),
			serverCpuPctSteady: metrics.serverCpuPctSteady,
			// From the end of the drain grace, so the idle rate is not diluted by
			// the last second of steady-phase arrivals.
			serverCpuPctIdle: windowPct(state.steadyEnd, state.idleEnd),
			hostCpuPctMedianSteady: metrics.hostCpuPctMedianSteady,
			clientRssMbMax,
			clientCpuPctConnect,
			clientCpuPctSteady,
			clientCpuPctIdle,
			hostMemAvailableMbMin: rungMemAvailableMin,
			rateLimitedTotal,
			limitExceededTotal,
			datagramsDroppedTotal: droppedTotal,
			sessionsActiveMax,
			sessionsActiveAtStart,
			steadySent,
			steadyServerRx,
			idleServerRx,
			phaseServerRx,
			sessionsLost: parsed?.sessionsLost ?? 0,
			clientDistinctSourceIps: parsed?.client.distinctSourceIps ?? null,
			clientRssGuardFired: state.clientRssGuardFired,
			connectErrorsSample: parsed?.connectErrorsSample ?? [],
		};
		rungs.push(rung);
		console.log(
			`bench-session-scale: rung ${sessions} bucket=${bucket} (${reason}) connected=${rung.connectedRatio?.toFixed(3)} offered=${rung.offeredRatio?.toFixed(3) ?? "n/a"} delivered=${rung.deliveryRatio?.toFixed(3) ?? "n/a"} rx(connect/steady/drain/idle)=${phaseServerRx.connect}/${phaseServerRx.steady}/${phaseServerRx.drain}/${phaseServerRx.idle} acceptP99=${rung.acceptMs.p99 ?? "n/a"}ms accepts/s=${rung.acceptsPerSec?.toFixed(0) ?? "n/a"} rss=${serverRssMbMax.toFixed(0)}MB committed=${serverCommittedMbMax?.toFixed(0) ?? "n/a"}MB fd=${serverFdCountMax ?? "n/a"} srvCpu(steady)=${rung.serverCpuPctSteady?.toFixed(0) ?? "n/a"}% srvCpu(idle)=${rung.serverCpuPctIdle?.toFixed(0) ?? "n/a"}% clientRss=${clientRssMbMax?.toFixed(0) ?? "n/a"}MB${rung.incompleteUnlessOffBox ? " INCOMPLETE-UNLESS-OFF-BOX" : ""}${degraded.length > 0 ? ` DEGRADED(${degraded.join("; ")})` : ""}`,
		);

		// STOP conditions that end the ladder rather than the rung. S5 is a
		// registered STOP with one trigger — a connect phase past its timeout —
		// and it may not be used as a label for whatever else went wrong; an
		// unregistered failure still stops the ladder, under its own name.
		if (
			rungMemAvailableMin !== null &&
			rungMemAvailableMin < T.hostMemAvailableAbortMb
		) {
			ladderAborted = `S3 host memory floor: MemAvailable ${rungMemAvailableMin.toFixed(0)}MB`;
		} else if (parsed?.connectTimedOut) {
			ladderAborted = `S5 connect timeout: connect phase ${metrics.connectWallSec.toFixed(0)}s exceeded ${CONNECT_TIMEOUT_SECONDS}s at ${sessions} sessions`;
		} else if (bucket === "harness-error") {
			ladderAborted = `harness error at ${sessions} sessions (not a registered STOP): ${reason}`;
		}

		// Every completed rung is on disk before the next one starts.
		flushResult();
		console.log(
			`bench-session-scale: flushed ${rungs.length} rung(s) to ${OUT_JSON}`,
		);

		await new Promise((res) => setTimeout(res, SETTLE_SECONDS * 1000));

		// The settle window is a guess; sessionsActive is the fact. A rung that
		// starts while the previous rung's sessions are still open measures both
		// of them, and the memory curve — the whole deliverable — is the first
		// thing that lie corrupts. Wait for the count to come back to the
		// baseline before the next rung is allowed to start.
		if (!ladderAborted && index + 1 < LADDER.length) {
			const drainDeadline = Date.now() + DRAIN_TIMEOUT_SECONDS * 1000;
			let active = server.metricsSnapshot().sessionsActive;
			while (active > DRAIN_BASELINE_SESSIONS && Date.now() < drainDeadline) {
				await new Promise((res) => setTimeout(res, 1000));
				active = server.metricsSnapshot().sessionsActive;
			}
			if (active > DRAIN_BASELINE_SESSIONS) {
				// Not fatal — the next rung records it as `sessionsActiveAtStart`
				// and is marked degraded — but it must be loud in the run log.
				console.warn(
					`bench-session-scale: rung ${sessions} left ${active} session(s) active after ${DRAIN_TIMEOUT_SECONDS}s of drain; next rung starts contaminated`,
				);
			} else {
				console.log(
					`bench-session-scale: drained to ${active} active session(s) before the next rung`,
				);
			}
		}
	}

	clearInterval(watchdog);
	await server.close();

	const result = buildResult();
	flushResult();
	console.log(`bench-session-scale: wrote ${OUT_JSON} and ${OUT_CSV}`);
	console.log(
		"sessions | bucket | usable | connected | offered | delivered | rx steady/drain/idle | acceptP99 | accepts/s | rssMB | committedMB | fd | srvCpuSteady | srvCpuIdle | clientRssMB",
	);
	for (const r of rungs) {
		// `usable` is the honest headline: a rung can pass every threshold and
		// still be unusable as a server number because the generator ran out
		// below it or its windows were synthesized.
		const usable =
			r.bucket === "ok" && !r.incompleteUnlessOffBox && r.degraded.length === 0
				? "yes"
				: r.incompleteUnlessOffBox
					? "S1 "
					: r.degraded.length > 0
						? "deg"
						: "no ";
		console.log(
			`${String(r.sessions).padStart(8)} | ${r.bucket.padEnd(20)} | ${usable} | ${(r.connectedRatio ?? 0).toFixed(3)} | ${(r.offeredRatio ?? 0).toFixed(3)} | ${(r.deliveryRatio ?? 0).toFixed(3)} | ${`${r.phaseServerRx.steady}/${r.phaseServerRx.drain}/${r.phaseServerRx.idle}`.padStart(20)} | ${String(r.acceptMs.p99 ?? "n/a").padStart(9)} | ${(r.acceptsPerSec ?? 0).toFixed(0).padStart(9)} | ${r.serverRssMbMax.toFixed(0).padStart(5)} | ${(r.serverCommittedMbMax ?? 0).toFixed(0).padStart(11)} | ${String(r.serverFdCountMax ?? "n/a").padStart(4)} | ${(r.serverCpuPctSteady ?? 0).toFixed(0).padStart(12)} | ${(r.serverCpuPctIdle ?? 0).toFixed(0).padStart(10)} | ${(r.clientRssMbMax ?? 0).toFixed(0).padStart(11)}`,
		);
	}
	console.log(`curve: ${JSON.stringify(result.curve)}`);
	if (ladderAborted) console.log(`ladder aborted: ${ladderAborted}`);
}

try {
	await main();
} catch (err) {
	// A throw must not cost the rungs that already completed, and must not leave
	// the generator running: both are what turned run 32168754965 into a
	// force-restart with zero evidence.
	emergencyTeardown(`harness threw: ${err}`);
	killChildGroup("SIGKILL");
	console.error(err);
	process.exit(1);
}
// Server-side sessions left behind by an abruptly exiting client have no QUIC idle
// timeout and keep the event loop referenced after close — a clean drain can hang
// forever (observed on the runner, latency run 32159708926). Output is already
// flushed synchronously above.
process.exit(0);
