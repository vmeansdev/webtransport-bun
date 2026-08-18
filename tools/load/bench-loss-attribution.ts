#!/usr/bin/env bun
/**
 * Per-stage counting taps for the 10,000-session datagram loss (T02).
 *
 * Run 32174398131 rung 4 delivered 0.694 at 10,000 sessions and ~2,000
 * datagrams/s while every server drop counter read zero and nothing was
 * CPU-bound. `deliveryRatio` is a single subtraction across five stages, so it
 * cannot say which stage ate the datagrams. This harness instruments all five
 * and reports them as one ledger per rung:
 *
 *   1. clientEnqueued   — `send_datagram` returned Ok (loss-client `steady.sent`)
 *   2. clientWireTx     — quinn `frame_tx.datagram` over the same window; the
 *                         gap to (1) is quinn's silent send-buffer eviction
 *   3. kernelUdp        — host UDP counters (Linux /proc/net/snmp), including
 *                         RcvbufErrors, which is where a loss invisible to both
 *                         endpoints shows up
 *   4. quinnToNative    — server `datagramsIn`, incremented immediately after
 *                         `receive_datagram()` returns, before any native queue
 *   5. jsDelivered      — datagrams the application's `incomingDatagrams()`
 *                         iterator actually yielded
 *
 * plus every native drop reason (`datagramsDropped*`) and the park counter
 * (`datagramsSkippedQueueFull`) that the session-scale harness never sampled —
 * skips are NOT counted in `datagramsDropped`, so a run can park millions of
 * times and still report "all drop counters zero".
 *
 * The payload carries `scale:<seq>:`, so stage 5 is also broken down per
 * session: a prefix loss (sessions started late), a suffix loss (delivery
 * collapsed part way through), scattered gaps and wholly-silent sessions are
 * different mechanisms, and the ledger separates them.
 *
 * Measurement harness, not a gate. Local macOS numbers are attribution evidence
 * only — never a capacity result.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	appendFileSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/loss-client`;

const LADDER = (process.env.LOSS_SESSIONS ?? "1000,5000,7500,10000")
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
const PAYLOAD_BYTES = parseInt(process.env.LOSS_PAYLOAD_BYTES ?? "100", 10);
const INTERVAL_MS = parseInt(process.env.LOSS_INTERVAL_MS ?? "5000", 10);
const STEADY_SECONDS = parseInt(process.env.LOSS_STEADY_SECONDS ?? "120", 10);
const IDLE_SECONDS = parseInt(process.env.LOSS_IDLE_SECONDS ?? "30", 10);
const SETTLE_SECONDS = parseInt(process.env.LOSS_SETTLE_SECONDS ?? "10", 10);
const ENDPOINTS = parseInt(process.env.LOSS_ENDPOINTS ?? "64", 10);
const CONNECT_CONCURRENCY = parseInt(
	process.env.LOSS_CONNECT_CONCURRENCY ?? "500",
	10,
);
const CONNECT_TIMEOUT_SECONDS = parseInt(
	process.env.LOSS_CONNECT_TIMEOUT_SECONDS ?? "300",
	10,
);
const SAMPLE_INTERVAL_MS = parseInt(process.env.LOSS_SAMPLE_MS ?? "2000", 10);
const DRAIN_GRACE_MS = parseInt(process.env.LOSS_DRAIN_GRACE_MS ?? "1000", 10);
const PORT = parseInt(process.env.LOSS_PORT ?? "4433", 10);
const OUT_JSON =
	process.env.LOSS_OUT ?? join(ROOT, "tools/load/bench-loss-attribution.json");
const OUT_CSV = OUT_JSON.replace(/\.json$/, ".csv");

const HAS_PROC = process.platform === "linux";
/** Sequence number every session is expected to reach by the end of steady. */
const EXPECTED_SEQ_MAX = Math.floor((STEADY_SECONDS * 1000) / INTERVAL_MS);

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

function serverRssMb(): number {
	return process.memoryUsage().rss / (1024 * 1024);
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
	if (!HAS_PROC) return null;
	try {
		const status = readFileSync(`/proc/${pid}/status`, "utf8");
		const m = status.match(/^VmRSS:\s+(\d+) kB/m);
		return m?.[1] ? parseInt(m[1], 10) / 1024 : null;
	} catch {
		return null;
	}
}

/**
 * Host-wide UDP counters. `RcvbufErrors` is the tap that matters: a datagram
 * dropped because the receiving socket's buffer was full is invisible to the
 * sender (which sees a successful send) and to quinn (which never sees the
 * packet), which is exactly the shape of "all server drop counters zero".
 * Host-wide, not per-socket, so on a shared box it is an upper bound — the
 * per-socket `drops` column from /proc/net/udp is sampled alongside it.
 */
type KernelUdp = Record<string, number>;

function readKernelUdp(): KernelUdp | null {
	if (!HAS_PROC) return null;
	try {
		const snmp = readFileSync("/proc/net/snmp", "utf8").split("\n");
		const headerIndex = snmp.findIndex((l) => l.startsWith("Udp:"));
		if (headerIndex < 0) return null;
		const keys = snmp[headerIndex]?.trim().split(/\s+/).slice(1) ?? [];
		const values = snmp[headerIndex + 1]?.trim().split(/\s+/).slice(1) ?? [];
		const out: KernelUdp = {};
		for (let i = 0; i < keys.length; i += 1) {
			const key = keys[i];
			const value = values[i];
			if (key && value !== undefined) out[key] = parseInt(value, 10);
		}
		out.serverSocketDrops = readServerSocketDrops() ?? -1;
		return out;
	} catch {
		return null;
	}
}

/** Sum of the `drops` column over UDP sockets bound to the bench port. */
function readServerSocketDrops(): number | null {
	if (!HAS_PROC) return null;
	try {
		const hexPort = PORT.toString(16).toUpperCase().padStart(4, "0");
		let drops = 0;
		let found = false;
		for (const file of ["/proc/net/udp", "/proc/net/udp6"]) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const line of text.split("\n").slice(1)) {
				const fields = line.trim().split(/\s+/);
				const local = fields[1];
				if (!local?.endsWith(`:${hexPort}`)) continue;
				const value = fields[12];
				if (value === undefined) continue;
				drops += parseInt(value, 10);
				found = true;
			}
		}
		return found ? drops : null;
	} catch {
		return null;
	}
}

function diffKernelUdp(
	from: KernelUdp | null,
	to: KernelUdp | null,
): KernelUdp | null {
	if (!from || !to) return null;
	const out: KernelUdp = {};
	for (const key of Object.keys(to)) {
		out[key] = (to[key] ?? 0) - (from[key] ?? 0);
	}
	return out;
}

/**
 * Per-session delivery ledger, rebuilt from the `scale:<seq>:` header. Reading
 * the digits straight off the byte view keeps the hot path free of decoder
 * allocations — this runs once per delivered datagram.
 */
type SessionLedger = {
	first: number;
	last: number;
	count: number;
	unparsed: number;
};

function parseSequence(bytes: Uint8Array): number {
	// "scale:" is 6 bytes; digits run to the next ':'.
	if (bytes.length < 8) return 0;
	if (
		bytes[0] !== 115 /* s */ ||
		bytes[1] !== 99 /* c */ ||
		bytes[2] !== 97 /* a */ ||
		bytes[3] !== 108 /* l */ ||
		bytes[4] !== 101 /* e */ ||
		bytes[5] !== 58 /* : */
	) {
		return 0;
	}
	let value = 0;
	for (let i = 6; i < bytes.length; i += 1) {
		const c = bytes[i] ?? 0;
		if (c === 58 /* : */) return i === 6 ? 0 : value;
		if (c < 48 || c > 57) return 0;
		value = value * 10 + (c - 48);
	}
	return 0;
}

type LedgerSummary = {
	sessions: number;
	delivered: number;
	unparsed: number;
	sessionsSilent: number;
	/** Missing before each session's first delivered sequence. */
	prefixMissing: number;
	/** Missing after each session's last delivered sequence, up to the expected max. */
	suffixMissing: number;
	/** Missing strictly between a session's first and last delivered sequence. */
	interiorGaps: number;
	deliveredPerSessionHistogram: Record<string, number>;
};

function summarize(ledgers: Iterable<SessionLedger>): LedgerSummary {
	const histogram: Record<string, number> = {};
	let sessions = 0;
	let delivered = 0;
	let unparsed = 0;
	let silent = 0;
	let prefixMissing = 0;
	let suffixMissing = 0;
	let interiorGaps = 0;
	for (const l of ledgers) {
		sessions += 1;
		delivered += l.count;
		unparsed += l.unparsed;
		const bucket = String(l.count);
		histogram[bucket] = (histogram[bucket] ?? 0) + 1;
		if (l.count === 0) {
			silent += 1;
			suffixMissing += EXPECTED_SEQ_MAX;
			continue;
		}
		prefixMissing += l.first - 1;
		suffixMissing += Math.max(0, EXPECTED_SEQ_MAX - l.last);
		interiorGaps += Math.max(0, l.last - l.first + 1 - l.count);
	}
	return {
		sessions,
		delivered,
		unparsed,
		sessionsSilent: silent,
		prefixMissing,
		suffixMissing,
		interiorGaps,
		deliveredPerSessionHistogram: histogram,
	};
}

let activeChild: ChildProcess | null = null;

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

type QuicTap = Record<string, number>;

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
		ticksLate: number;
		expectedSends: number;
	};
	idle: { sent: number; err: number; received: number };
	steadyQuic: QuicTap;
	steadyPerConn: {
		sampled: number;
		silent: number;
		minDatagramFrames: number;
		maxDatagramFrames: number;
	};
	client: {
		rssMbSteady: number | null;
		cpuMsSteady: number | null;
		fdCount: number | null;
		endpoints: number;
		distinctSourceIps: number;
	};
	connectErrorsSample: string[];
};

type NativeMetrics = {
	datagramsIn: number;
	datagramsDropped: number;
	datagramsDroppedRateLimited: number;
	datagramsDroppedTooLarge: number;
	datagramsDroppedQueueGlobal: number;
	datagramsDroppedQueueSession: number;
	datagramsSkippedQueueFull: number;
	queuedBytesGlobal: number;
	backpressureWaitCount: number;
	rateLimitedCount: number;
	limitExceededCount: number;
	sessionsActive: number;
};

type Boundary = {
	wallMs: number;
	serverCpuMs: number;
	jsDelivered: number;
	native: NativeMetrics;
	kernel: KernelUdp | null;
	ledger: LedgerSummary;
};

async function main(): Promise<void> {
	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	let jsDelivered = 0;
	let ledgers: SessionLedger[] = [];
	const topSessions = Math.max(...LADDER);
	const aggregatePeak = Math.ceil((topSessions * 1000) / INTERVAL_MS);
	const server = createServer({
		port: PORT,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: topSessions * 2,
			maxHandshakesInFlight: topSessions * 2,
			idleTimeoutMs: 120_000,
		},
		rateLimits: {
			// Every limiter is set above the top rung on purpose: a rung that trips
			// a limiter measures configuration, not the mechanism under study.
			handshakesPerSec: topSessions * 2,
			handshakesBurst: topSessions * 2,
			handshakesBurstPerPrefix: topSessions * 2,
			streamsPerSec: 1000,
			streamsBurst: 2000,
			datagramsPerSec: Math.max(aggregatePeak * 8, 20_000),
			datagramsBurst: Math.max(aggregatePeak * 16, 40_000),
		},
		onSession: (session) => {
			const ledger: SessionLedger = {
				first: 0,
				last: 0,
				count: 0,
				unparsed: 0,
			};
			ledgers.push(ledger);
			void (async () => {
				// Fan-in shape, same as the session-scale harness: consume, never echo.
				for await (const datagram of session.incomingDatagrams()) {
					jsDelivered += 1;
					const seq = parseSequence(
						datagram instanceof Uint8Array
							? datagram
							: new Uint8Array(datagram),
					);
					if (seq === 0) {
						ledger.unparsed += 1;
						continue;
					}
					ledger.count += 1;
					if (ledger.first === 0 || seq < ledger.first) ledger.first = seq;
					if (seq > ledger.last) ledger.last = seq;
				}
			})().catch(() => {});
		},
	});
	// createServer has no readiness promise (same pattern as load-addon.ts).
	await Bun.sleep(3000);
	console.log(
		`bench-loss-attribution: server up on ${PORT}; ladder=[${LADDER.join(",")}] interval=${INTERVAL_MS}ms payload=${PAYLOAD_BYTES}B steady=${STEADY_SECONDS}s expectedSeqMax=${EXPECTED_SEQ_MAX}`,
	);

	writeFileSync(
		OUT_CSV,
		"rung,sessions,ts_ms,phase,hostCpuPct,serverCpuPct,serverRssMb,serverFd,clientRssMb,sessionsActive,jsDelivered,datagramsIn,datagramsSkippedQueueFull\n",
	);

	const nativeMetrics = (): NativeMetrics => {
		const m = server.metricsSnapshot();
		return {
			datagramsIn: m.datagramsIn,
			datagramsDropped: m.datagramsDropped,
			datagramsDroppedRateLimited: m.datagramsDroppedRateLimited ?? 0,
			datagramsDroppedTooLarge: m.datagramsDroppedTooLarge ?? 0,
			datagramsDroppedQueueGlobal: m.datagramsDroppedQueueGlobal ?? 0,
			datagramsDroppedQueueSession: m.datagramsDroppedQueueSession ?? 0,
			datagramsSkippedQueueFull: m.datagramsSkippedQueueFull ?? 0,
			queuedBytesGlobal: m.queuedBytesGlobal,
			backpressureWaitCount: m.backpressureWaitCount,
			rateLimitedCount: m.rateLimitedCount,
			limitExceededCount: m.limitExceededCount,
			sessionsActive: m.sessionsActive,
		};
	};

	const rungs: unknown[] = [];
	const startedAt = new Date().toISOString();

	for (const [index, sessions] of LADDER.entries()) {
		console.log(
			`bench-loss-attribution: rung ${index + 1}/${LADDER.length} sessions=${sessions}`,
		);
		jsDelivered = 0;
		ledgers = [];

		const jsonOut = `${OUT_JSON}.rung-${sessions}.json`;
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

		const boundary = (): Boundary => ({
			wallMs: Date.now(),
			serverCpuMs: serverCpuMs(),
			jsDelivered,
			native: nativeMetrics(),
			kernel: readKernelUdp(),
			ledger: summarize(ledgers),
		});

		const state: {
			phase: string;
			steadyStart: Boundary | null;
			steadyEnd: Boundary | null;
			report: ClientReport | null;
		} = { phase: "connect", steadyStart: null, steadyEnd: null, report: null };

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
						state.phase = "idle";
						// Datagrams still in flight when the client stops would be booked
						// as loss if the window closed instantly; the idle phase sends
						// nothing, so a short drain grace attributes them correctly.
						setTimeout(() => {
							state.steadyEnd = boundary();
						}, DRAIN_GRACE_MS);
					} else if (line.includes("phase stop")) {
						state.phase = "stop";
					}
					const jsonMatch = line.match(/^loss-client: json (\{.*\})$/);
					if (jsonMatch?.[1])
						state.report = JSON.parse(jsonMatch[1]) as ClientReport;
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
		let serverRssMbMax = 0;
		let clientRssMbMax: number | null = null;
		let sessionsActiveMax = 0;
		let prevHost = readHostCpu();
		let running = true;
		const rungStart = boundary();
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
			const rss = serverRssMb();
			const fds = serverFdCount();
			const cRss = child.pid === undefined ? null : clientRssMb(child.pid);
			const m = nativeMetrics();
			serverRssMbMax = Math.max(serverRssMbMax, rss);
			if (cRss !== null) clientRssMbMax = Math.max(clientRssMbMax ?? 0, cRss);
			sessionsActiveMax = Math.max(sessionsActiveMax, m.sessionsActive);
			if (state.phase === "steady" && host !== null) hostSteady.push(host);
			appendFileSync(
				OUT_CSV,
				`${index + 1},${sessions},${Date.now()},${state.phase},${host?.toFixed(1) ?? ""},${(
					((serverCpuMs() - rungStart.serverCpuMs) /
						Math.max(Date.now() - rungStart.wallMs, 1)) *
						100
				).toFixed(
					1,
				)},${rss.toFixed(1)},${fds ?? ""},${cRss?.toFixed(1) ?? ""},${m.sessionsActive},${jsDelivered},${m.datagramsIn},${m.datagramsSkippedQueueFull}\n`,
			);
		}

		await exitCode;
		await stdoutPump;
		const stderr = await stderrPromise;
		killChildGroup("SIGKILL");
		activeChild = null;
		if (!state.steadyEnd) state.steadyEnd = boundary();

		const report = state.report;
		if (!report) {
			console.error(stdoutText.slice(-20).join("\n"));
			console.error(stderr.slice(-2000));
		}

		const from = state.steadyStart;
		const to = state.steadyEnd;
		const delta = (pick: (b: Boundary) => number): number | null =>
			from && to ? pick(to) - pick(from) : null;

		const clientEnqueued = report?.steady.sent ?? null;
		const clientWireTx = report?.steadyQuic.frameTxDatagram ?? null;
		const quinnToNative = delta((b) => b.native.datagramsIn);
		const jsDeliveredWindow = delta((b) => b.jsDelivered);
		const nativeDropped = delta((b) => b.native.datagramsDropped);
		const skippedQueueFull = delta((b) => b.native.datagramsSkippedQueueFull);

		// The ledger is cumulative per session across the whole rung, and the
		// client only sends during steady, so the end-of-window summary IS the
		// steady-window summary.
		const ledger = to?.ledger ?? summarize(ledgers);

		const rung = {
			sessions,
			ladderIndex: index + 1,
			// --- the ledger the ticket asked for, one row per stage ---
			stages: {
				clientEnqueued,
				clientWireTx,
				quinnToNative,
				jsDelivered: jsDeliveredWindow,
			},
			gaps: {
				// Where a datagram vanished, by stage. A positive number means the
				// stage above it produced more than the stage below it observed.
				enqueueToWire:
					clientEnqueued !== null && clientWireTx !== null
						? clientEnqueued - clientWireTx
						: null,
				wireToQuinnRecv:
					clientWireTx !== null && quinnToNative !== null
						? clientWireTx - quinnToNative
						: null,
				quinnRecvToJs:
					quinnToNative !== null && jsDeliveredWindow !== null
						? quinnToNative - jsDeliveredWindow
						: null,
			},
			deliveryRatio:
				clientEnqueued && jsDeliveredWindow !== null
					? jsDeliveredWindow / clientEnqueued
					: null,
			native: {
				dropped: nativeDropped,
				droppedRateLimited: delta((b) => b.native.datagramsDroppedRateLimited),
				droppedTooLarge: delta((b) => b.native.datagramsDroppedTooLarge),
				droppedQueueGlobal: delta((b) => b.native.datagramsDroppedQueueGlobal),
				droppedQueueSession: delta(
					(b) => b.native.datagramsDroppedQueueSession,
				),
				skippedQueueFull,
				backpressureWaitCount: delta((b) => b.native.backpressureWaitCount),
				rateLimitedCount: delta((b) => b.native.rateLimitedCount),
				limitExceededCount: delta((b) => b.native.limitExceededCount),
				queuedBytesGlobalAtEnd: to?.native.queuedBytesGlobal ?? null,
			},
			kernelUdpSteady: diffKernelUdp(from?.kernel ?? null, to?.kernel ?? null),
			perSession: ledger,
			expectedSeqMax: EXPECTED_SEQ_MAX,
			clientQuic: report?.steadyQuic ?? null,
			clientPerConn: report?.steadyPerConn ?? null,
			clientTicksLate: report?.steady.ticksLate ?? null,
			offeredRatio:
				report && report.steady.expectedSends > 0
					? report.steady.sent / report.steady.expectedSends
					: null,
			connectedRatio: report
				? report.sessionsOk / report.sessionsRequested
				: null,
			acceptMs: report?.acceptMs ?? null,
			sessionsActiveMax,
			serverRssMbMax,
			clientRssMbMax,
			serverCpuPctSteady:
				from && to && to.wallMs > from.wallMs
					? ((to.serverCpuMs - from.serverCpuMs) / (to.wallMs - from.wallMs)) *
						100
					: null,
			hostCpuPctMedianSteady:
				hostSteady.length > 0
					? [...hostSteady].sort((a, b) => a - b)[
							Math.floor(hostSteady.length / 2)
						]
					: null,
			steadyWindowMs: from && to ? to.wallMs - from.wallMs : null,
			clientReportPresent: report !== null,
		};
		rungs.push(rung);

		console.log(
			`bench-loss-attribution: rung ${sessions} enqueued=${clientEnqueued} wireTx=${clientWireTx} quinnRx=${quinnToNative} js=${jsDeliveredWindow} delivery=${rung.deliveryRatio?.toFixed(3) ?? "n/a"} silentSessions=${ledger.sessionsSilent} prefix=${ledger.prefixMissing} suffix=${ledger.suffixMissing} interior=${ledger.interiorGaps} skipQueueFull=${skippedQueueFull}`,
		);

		writeFileSync(
			OUT_JSON,
			`${JSON.stringify(
				{
					version: 1,
					schema: "bench-loss-attribution/1",
					startedAt,
					writtenAt: new Date().toISOString(),
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
						endpoints: ENDPOINTS,
						connectConcurrency: CONNECT_CONCURRENCY,
						drainGraceMs: DRAIN_GRACE_MS,
						expectedSeqMax: EXPECTED_SEQ_MAX,
					},
					rungs,
				},
				null,
				1,
			)}\n`,
		);

		if (index < LADDER.length - 1) await Bun.sleep(SETTLE_SECONDS * 1000);
	}

	await server.close();
	console.log(`bench-loss-attribution: wrote ${OUT_JSON}`);
}

process.on("SIGINT", () => {
	killChildGroup("SIGKILL");
	process.exit(130);
});

await main();
