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

import {
	appendFileSync,
	readdirSync,
	readFileSync,
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
/** Settling time between the client's last steady send and the server-side
 * counter snapshot that closes the steady window. Must stay far below
 * SCALE_IDLE_SECONDS, which is the window it borrows from. */
const DRAIN_GRACE_MS = parseInt(process.env.SCALE_DRAIN_GRACE_MS ?? "1000", 10);
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
	};
	idle: { sent: number; err: number; received: number };
	client: {
		rssMbSteady: number | null;
		rssMbIdle: number | null;
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
	serverCpuPctSteady: number | null;
	serverCpuPctIdle: number | null;
	hostCpuPctMedianSteady: number | null;
	clientRssMbMax: number | null;
	clientCpuPctSteady: number | null;
	hostMemAvailableMbMin: number | null;
	rateLimitedTotal: number;
	limitExceededTotal: number;
	datagramsDroppedTotal: number;
	sessionsActiveMax: number;
	steadySent: number;
	steadyServerRx: number;
	idleServerRx: number;
	sessionsLost: number;
	clientDistinctSourceIps: number | null;
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
}): { bucket: string; reason: string } {
	if (r.threw || r.sessionsOk === 0) {
		return { bucket: "harness-error", reason: "rung threw or zero sessions" };
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
	const ok = rungs.filter((r) => r.bucket === "ok");
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

	writeFileSync(
		OUT_CSV,
		"rung,sessions,ts_ms,phase,hostCpuPct,serverCpuPct,serverRssMb,serverCommittedMb,serverFd,clientRssMb,memAvailableMb,sessionsActive\n",
	);

	const rungs: Rung[] = [];
	let ladderAborted: string | null = null;

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
		const child = Bun.spawn(
			[
				CLIENT_BIN,
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
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		);

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
			steadyEnd: Window | null;
			idleEnd: Window | null;
			report: ClientReport | null;
		} = {
			phase: "connect",
			steadyStart: null,
			steadyEnd: null,
			idleEnd: null,
			report: null,
		};
		const rungStart = boundary();

		// Phase markers arrive on the client's stdout the instant it switches
		// phases, so both sides use the same boundaries.
		const stdoutText: string[] = [];
		const stdoutPump = (async () => {
			const decoder = new TextDecoder();
			let buffered = "";
			for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
				buffered += decoder.decode(chunk, { stream: true });
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					stdoutText.push(line);
					if (line.includes("phase steady")) {
						state.steadyStart = boundary();
						state.phase = "steady";
					} else if (line.includes("phase idle")) {
						state.phase = "idle";
						// Datagrams sent in the last instant of the steady phase are
						// still in flight when the client stops. Counting the server
						// side immediately would book them as loss; the idle phase
						// sends nothing, so a short drain grace attributes them
						// correctly instead of manufacturing a delivery deficit.
						setTimeout(() => {
							state.steadyEnd = boundary();
						}, DRAIN_GRACE_MS);
					} else if (line.includes("phase stop")) {
						state.idleEnd = boundary();
						state.phase = "stop";
					}
					const jsonMatch = line.match(/^scale-client: json (\{.*\})$/);
					if (jsonMatch?.[1]) {
						state.report = JSON.parse(jsonMatch[1]) as ClientReport;
					}
				}
			}
			if (buffered) stdoutText.push(buffered);
		})();
		const stderrPromise = new Response(child.stderr).text();

		const hostSteady: number[] = [];
		let serverRssMbMax = 0;
		let serverCommittedMbMax: number | null = null;
		let serverFdCountMax: number | null = null;
		let clientRssMbMax: number | null = null;
		let memAvailableMin: number | null = null;
		let sessionsActiveMax = 0;
		let prevHost = readHostCpu();
		let running = true;
		const exited = child.exited.then(() => {
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
			const cRss = clientRssMb(child.pid);
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
				memAvailableMin = Math.min(memAvailableMin ?? avail, avail);
			}
			sessionsActiveMax = Math.max(sessionsActiveMax, active);
			if (state.phase === "steady" && host !== null) hostSteady.push(host);
			appendFileSync(
				OUT_CSV,
				`${index + 1},${sessions},${Date.now()},${state.phase},${host?.toFixed(1) ?? ""},${(
					((serverCpuMs() - rungStart.serverCpuMs) /
						Math.max(Date.now() - rungStart.wallMs, 1)) *
						100
				).toFixed(
					1,
				)},${mem.rssMb.toFixed(1)},${mem.committedMb?.toFixed(1) ?? ""},${fds ?? ""},${cRss?.toFixed(1) ?? ""},${avail?.toFixed(0) ?? ""},${active}\n`,
			);
		}

		await child.exited;
		await stdoutPump;
		const stderr = await stderrPromise;
		if (!state.steadyEnd) state.steadyEnd = boundary();
		if (!state.idleEnd) state.idleEnd = boundary();

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
		const steadyServerRx =
			state.steadyStart && state.steadyEnd
				? state.steadyEnd.serverRx - state.steadyStart.serverRx
				: 0;
		const idleServerRx =
			state.steadyEnd && state.idleEnd
				? state.idleEnd.serverRx - state.steadyEnd.serverRx
				: 0;
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
		const clientCpuPctSteady =
			parsed?.client.cpuMsSteady != null && state.steadyStart && state.steadyEnd
				? (parsed.client.cpuMsSteady /
						(state.steadyEnd.wallMs - rungStart.wallMs)) *
					100
				: null;

		const metrics = {
			sessionsOk,
			connectedRatio: sessionsOk > 0 ? sessionsOk / sessions : 0,
			offeredRatio: expectedSends > 0 ? steadySent / expectedSends : null,
			deliveryRatio: steadySent > 0 ? steadyServerRx / steadySent : null,
			rateLimitedTotal,
			limitExceededTotal,
			hostMemAvailableMbMin: memAvailableMin,
			serverRssMbMax,
			clientRssMbMax,
			connectWallSec: parsed?.connectWallSec ?? 0,
			serverCpuPctSteady: windowPct(state.steadyStart, state.steadyEnd),
			clientCpuPctSteady,
			hostCpuPctMedianSteady: median(hostSteady),
			threw: parsed === null,
		};
		const { bucket, reason } = classify(metrics);

		const rung: Rung = {
			sessions,
			bucket,
			bucketReason: reason,
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
			serverCpuPctSteady: metrics.serverCpuPctSteady,
			serverCpuPctIdle: windowPct(state.steadyEnd, state.idleEnd),
			hostCpuPctMedianSteady: metrics.hostCpuPctMedianSteady,
			clientRssMbMax,
			clientCpuPctSteady,
			hostMemAvailableMbMin: memAvailableMin,
			rateLimitedTotal,
			limitExceededTotal,
			datagramsDroppedTotal: droppedTotal,
			sessionsActiveMax,
			steadySent,
			steadyServerRx,
			idleServerRx,
			sessionsLost: parsed?.sessionsLost ?? 0,
			clientDistinctSourceIps: parsed?.client.distinctSourceIps ?? null,
			connectErrorsSample: parsed?.connectErrorsSample ?? [],
		};
		rungs.push(rung);
		console.log(
			`bench-session-scale: rung ${sessions} bucket=${bucket} (${reason}) connected=${rung.connectedRatio?.toFixed(3)} offered=${rung.offeredRatio?.toFixed(3) ?? "n/a"} delivered=${rung.deliveryRatio?.toFixed(3) ?? "n/a"} acceptP99=${rung.acceptMs.p99 ?? "n/a"}ms accepts/s=${rung.acceptsPerSec?.toFixed(0) ?? "n/a"} rss=${serverRssMbMax.toFixed(0)}MB committed=${serverCommittedMbMax?.toFixed(0) ?? "n/a"}MB fd=${serverFdCountMax ?? "n/a"} srvCpu(steady)=${rung.serverCpuPctSteady?.toFixed(0) ?? "n/a"}% srvCpu(idle)=${rung.serverCpuPctIdle?.toFixed(0) ?? "n/a"}% clientRss=${clientRssMbMax?.toFixed(0) ?? "n/a"}MB`,
		);

		// STOP conditions that end the ladder rather than the rung.
		if (
			memAvailableMin !== null &&
			memAvailableMin < T.hostMemAvailableFloorMb
		) {
			ladderAborted = `S3 host memory floor: MemAvailable ${memAvailableMin.toFixed(0)}MB`;
		} else if (bucket === "harness-error") {
			ladderAborted = "S5 harness error";
		}

		await new Promise((res) => setTimeout(res, SETTLE_SECONDS * 1000));
	}

	await server.close();

	const notRun = LADDER.filter((s) => !rungs.some((r) => r.sessions === s));
	const result = {
		version: 1,
		schema: "bench-session-scale/1",
		startedAt: new Date().toISOString(),
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
			endpoints: ENDPOINTS,
			connectConcurrency: CONNECT_CONCURRENCY,
			echo: false,
			thresholds: T,
		},
		rungs,
		notRun,
		ladderAborted,
		curve: curveShape(rungs),
	};
	writeFileSync(OUT_JSON, `${JSON.stringify(result, null, 2)}\n`);
	console.log(`bench-session-scale: wrote ${OUT_JSON} and ${OUT_CSV}`);
	console.log(
		"sessions | bucket | connected | offered | delivered | acceptP99 | accepts/s | rssMB | committedMB | fd | srvCpuSteady | srvCpuIdle | clientRssMB",
	);
	for (const r of rungs) {
		console.log(
			`${String(r.sessions).padStart(8)} | ${r.bucket.padEnd(20)} | ${(r.connectedRatio ?? 0).toFixed(3)} | ${(r.offeredRatio ?? 0).toFixed(3)} | ${(r.deliveryRatio ?? 0).toFixed(3)} | ${String(r.acceptMs.p99 ?? "n/a").padStart(9)} | ${(r.acceptsPerSec ?? 0).toFixed(0).padStart(9)} | ${r.serverRssMbMax.toFixed(0).padStart(5)} | ${(r.serverCommittedMbMax ?? 0).toFixed(0).padStart(11)} | ${String(r.serverFdCountMax ?? "n/a").padStart(4)} | ${(r.serverCpuPctSteady ?? 0).toFixed(0).padStart(12)} | ${(r.serverCpuPctIdle ?? 0).toFixed(0).padStart(10)} | ${(r.clientRssMbMax ?? 0).toFixed(0).padStart(11)}`,
		);
	}
	console.log(`curve: ${JSON.stringify(result.curve)}`);
	if (ladderAborted) console.log(`ladder aborted: ${ladderAborted}`);
}

await main();
// Server-side sessions left behind by an abruptly exiting client have no QUIC idle
// timeout and keep the event loop referenced after close — a clean drain can hang
// forever (observed on the runner, latency run 32159708926). Output is already
// flushed synchronously above.
process.exit(0);
