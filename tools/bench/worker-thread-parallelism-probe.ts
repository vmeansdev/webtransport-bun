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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	__TESTING__,
	createServer,
	type QuicConnectionStats,
	type ServerSession,
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
/**
 * Drain via `discardIncomingDatagram` (one N-API call per datagram) instead of
 * `incomingDatagrams` / `readDatagram`. Mutually exclusive with ECHO: discard
 * does not materialise a payload to send back.
 */
const DISCARD = process.env.WT_PROBE_DISCARD === "1";
/** Per-session stream opens/s, to make the accept path hot. */
const STREAMS_PER_SEC = Number(process.env.WT_PROBE_STREAMS_PER_SEC ?? "0");
/** `taskset -c` list for load-client only; empty means unpinned (shared arm). */
const CLIENT_TASKSET = (process.env.WT_PROBE_CLIENT_TASKSET ?? "").trim();
/** Restrict the worker sweep, e.g. `1` for a hop A/B at the collapse default. */
const WORKER_FILTER = (process.env.WT_PROBE_WORKERS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter((s) => s.length > 0);
const SKIP_SESSION_SWEEP =
	process.env.WT_PROBE_SKIP_SESSION === "1" ||
	ECHO ||
	DISCARD ||
	STREAMS_PER_SEC > 0;

export function artifactSuffix(opts: {
	clients: number;
	echo: boolean;
	discard: boolean;
	streamsPerSec: number;
}): string {
	const parts: string[] = [];
	if (opts.clients > 1) parts.push(`c${opts.clients}`);
	if (opts.echo) parts.push("echo");
	if (opts.discard) parts.push("discard");
	if (opts.streamsPerSec > 0) parts.push(`streams${opts.streamsPerSec}`);
	return parts.length > 0 ? `-${parts.join("-")}` : "";
}

const ARTIFACT_PATH = join(
	ROOT,
	".investigation",
	`worker-thread-parallelism-probe${artifactSuffix({
		clients: CLIENTS,
		echo: ECHO,
		discard: DISCARD,
		streamsPerSec: STREAMS_PER_SEC,
	})}.json`,
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
	const all = ["1", "2", "4", "auto"].map((workers) => ({
		label: `workers=${workers}`,
		workers,
		sessions: SATURATION_SESSIONS,
		rate: perSession,
	}));
	if (WORKER_FILTER.length === 0) return all;
	return all.filter((arm) => WORKER_FILTER.includes(arm.workers));
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

export type IngestGapBucket =
	| "window-accounting"
	| "quic-loss"
	| "udp-rcvbuf"
	| "client-cc"
	| "wire"
	| "unexplained";

export type IngestGap = {
	windowOfferedPerSec: number | null;
	ingestedPerSec: number;
	packetsLostDelta: number | null;
	packetsReceivedDelta: number | null;
	udpInErrorsDelta: number | null;
	udpRcvbufErrorsDelta: number | null;
	frameTxDatagramPerSec: number | null;
	udpTxPerSec: number | null;
	unexplainedPerSec: number | null;
	stopBucket: IngestGapBucket;
};

export type PipeCapBucket =
	| "server-ingest"
	| "cc"
	| "client-cpu"
	| "unexplained"
	| "incomplete";

export type PipeCap = {
	frameTxPerSec: number | null;
	ingestedPerSec: number;
	predictedPps: number | null;
	bdpBps: number | null;
	cwnd: number | null;
	rttUs: number | null;
	clientCpuCores: number | null;
	congPerSec: number | null;
	bytesPerDatagram: number | null;
	stopBucket: PipeCapBucket;
};

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
		datagramsDroppedTooLarge: number;
		datagramsDroppedQueueSession: number;
		datagramsDroppedQueueGlobal: number;
		datagramsDroppedRateLimited: number;
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
	gap: IngestGap;
	pipeCap: PipeCap;
	clientTaskset: string;
	clientCpusAllowed: number[][];
	clientAffinityOk: boolean;
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

export const SENT_PROGRESS_RE =
	/^load-client: t_ms=(\d+) sent=(\d+)(?: frame_tx_datagram=(\d+) udp_tx=(\d+)(?: udp_tx_bytes=(\d+) cwnd=(\d+) rtt_us=(\d+) cong=(\d+) bdp_bps=(\d+) cpu_ms=(\d+))?)?\s*$/gm;

export type SentProgressSample = {
	tMs: number;
	sent: number;
	frameTxDatagram: number | null;
	udpTx: number | null;
	udpTxBytes: number | null;
	cwnd: number | null;
	rttUs: number | null;
	cong: number | null;
	bdpBps: number | null;
	cpuMs: number | null;
};

export type WindowSentDelta = {
	sent0: number;
	sent1: number;
	t0: number;
	t1: number;
	frameTx0: number | null;
	frameTx1: number | null;
	udpTx0: number | null;
	udpTx1: number | null;
	udpTxBytes0: number | null;
	udpTxBytes1: number | null;
	cong0: number | null;
	cong1: number | null;
	cpuMs0: number | null;
	cpuMs1: number | null;
	cwnd1: number | null;
	rttUs1: number | null;
	bdpBps1: number | null;
};

function optionalInt(value: string | undefined): number | null {
	return value == null ? null : Number.parseInt(value, 10);
}

export function parseLoadClientSentProgress(
	text: string,
): SentProgressSample[] {
	const samples: SentProgressSample[] = [];
	for (const match of text.matchAll(SENT_PROGRESS_RE)) {
		samples.push({
			tMs: Number.parseInt(match[1] ?? "0", 10),
			sent: Number.parseInt(match[2] ?? "0", 10),
			frameTxDatagram: optionalInt(match[3]),
			udpTx: optionalInt(match[4]),
			udpTxBytes: optionalInt(match[5]),
			cwnd: optionalInt(match[6]),
			rttUs: optionalInt(match[7]),
			cong: optionalInt(match[8]),
			bdpBps: optionalInt(match[9]),
			cpuMs: optionalInt(match[10]),
		});
	}
	return samples;
}

export function windowSentDelta(
	samples: readonly SentProgressSample[],
	warmupMs: number,
	measureMs: number,
): WindowSentDelta | null {
	const endMs = warmupMs + measureMs;
	let t0Sample: SentProgressSample | null = null;
	let t1Sample: SentProgressSample | null = null;
	for (const sample of samples) {
		if (sample.tMs <= warmupMs) t0Sample = sample;
		if (sample.tMs <= endMs) t1Sample = sample;
	}
	if (!t0Sample || !t1Sample) return null;
	if (t1Sample.tMs <= t0Sample.tMs) return null;
	const frameTxPresent =
		t0Sample.frameTxDatagram != null && t1Sample.frameTxDatagram != null;
	const udpTxPresent = t0Sample.udpTx != null && t1Sample.udpTx != null;
	const pipePresent =
		t0Sample.udpTxBytes != null &&
		t1Sample.udpTxBytes != null &&
		t0Sample.cong != null &&
		t1Sample.cong != null &&
		t0Sample.cpuMs != null &&
		t1Sample.cpuMs != null;
	return {
		sent0: t0Sample.sent,
		sent1: t1Sample.sent,
		t0: t0Sample.tMs,
		t1: t1Sample.tMs,
		frameTx0: frameTxPresent ? t0Sample.frameTxDatagram : null,
		frameTx1: frameTxPresent ? t1Sample.frameTxDatagram : null,
		udpTx0: udpTxPresent ? t0Sample.udpTx : null,
		udpTx1: udpTxPresent ? t1Sample.udpTx : null,
		udpTxBytes0: pipePresent ? t0Sample.udpTxBytes : null,
		udpTxBytes1: pipePresent ? t1Sample.udpTxBytes : null,
		cong0: pipePresent ? t0Sample.cong : null,
		cong1: pipePresent ? t1Sample.cong : null,
		cpuMs0: pipePresent ? t0Sample.cpuMs : null,
		cpuMs1: pipePresent ? t1Sample.cpuMs : null,
		cwnd1: t1Sample.cwnd,
		rttUs1: t1Sample.rttUs,
		bdpBps1: t1Sample.bdpBps,
	};
}

export function procRow(
	text: string,
	section: string,
	keys: readonly string[],
): Record<string, number> | null {
	const lines = text.split("\n");
	const prefix = `${section}:`;
	const headerIdx = lines.findIndex((line) => line.startsWith(prefix));
	if (headerIdx < 0) return null;
	const valueLine = lines[headerIdx + 1];
	if (!valueLine?.startsWith(prefix)) return null;
	const headerKeys = (lines[headerIdx] ?? "").trim().split(/\s+/).slice(1);
	const vals = valueLine.trim().split(/\s+/).slice(1);
	if (headerKeys.length !== vals.length) return null;
	const out: Record<string, number> = {};
	for (const key of keys) {
		const i = headerKeys.indexOf(key);
		if (i < 0) return null;
		out[key] = Number.parseInt(vals[i] ?? "0", 10);
	}
	return out;
}

export function parseProcSnmpUdp(text: string): {
	InDatagrams: number;
	InErrors: number;
	rcvbufErrors?: number;
} | null {
	const required = procRow(text, "Udp", ["InDatagrams", "InErrors"]);
	if (!required) return null;
	const withRcvbuf = procRow(text, "Udp", [
		"InDatagrams",
		"InErrors",
		"RcvbufErrors",
	]);
	return {
		InDatagrams: required.InDatagrams ?? 0,
		InErrors: required.InErrors ?? 0,
		...(withRcvbuf ? { rcvbufErrors: withRcvbuf.RcvbufErrors ?? 0 } : {}),
	};
}

export function parseProcNetstatUdp(
	text: string,
): { RcvbufErrors: number; SndbufErrors: number } | null {
	const row = procRow(text, "Udp", ["RcvbufErrors", "SndbufErrors"]);
	if (!row) return null;
	return {
		RcvbufErrors: row.RcvbufErrors ?? 0,
		SndbufErrors: row.SndbufErrors ?? 0,
	};
}

export function sumWindowOfferedPerSec(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
): number | null {
	let sum = 0;
	let any = false;
	for (const text of clientStdouts) {
		const delta = windowSentDelta(
			parseLoadClientSentProgress(text),
			warmupMs,
			measureMs,
		);
		if (!delta) continue;
		any = true;
		sum += (delta.sent1 - delta.sent0) / ((delta.t1 - delta.t0) / 1000);
	}
	return any ? sum : null;
}

export function sumWindowCounterPerSec(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
	pick: (d: WindowSentDelta) => { a: number; b: number } | null,
): number | null {
	let sum = 0;
	let any = false;
	for (const text of clientStdouts) {
		const delta = windowSentDelta(
			parseLoadClientSentProgress(text),
			warmupMs,
			measureMs,
		);
		if (!delta) continue;
		const pair = pick(delta);
		if (!pair) continue;
		any = true;
		sum += (pair.b - pair.a) / ((delta.t1 - delta.t0) / 1000);
	}
	return any ? sum : null;
}

export function sumWindowFrameTxPerSec(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
): number | null {
	return sumWindowCounterPerSec(clientStdouts, warmupMs, measureMs, (d) =>
		d.frameTx0 != null && d.frameTx1 != null
			? { a: d.frameTx0, b: d.frameTx1 }
			: null,
	);
}

export function sumWindowUdpTxPerSec(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
): number | null {
	return sumWindowCounterPerSec(clientStdouts, warmupMs, measureMs, (d) =>
		d.udpTx0 != null && d.udpTx1 != null ? { a: d.udpTx0, b: d.udpTx1 } : null,
	);
}

export function sumWindowUdpTxBytesPerSec(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
): number | null {
	return sumWindowCounterPerSec(clientStdouts, warmupMs, measureMs, (d) =>
		d.udpTxBytes0 != null && d.udpTxBytes1 != null
			? { a: d.udpTxBytes0, b: d.udpTxBytes1 }
			: null,
	);
}

export function sumWindowCongPerSec(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
): number | null {
	return sumWindowCounterPerSec(clientStdouts, warmupMs, measureMs, (d) =>
		d.cong0 != null && d.cong1 != null ? { a: d.cong0, b: d.cong1 } : null,
	);
}

export function sumWindowClientCpuCores(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
): number | null {
	const msPerSec = sumWindowCounterPerSec(
		clientStdouts,
		warmupMs,
		measureMs,
		(d) =>
			d.cpuMs0 != null && d.cpuMs1 != null
				? { a: d.cpuMs0, b: d.cpuMs1 }
				: null,
	);
	return msPerSec == null ? null : msPerSec / 1000;
}

export function sumWindowBdpBps(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
): number | null {
	let sum = 0;
	let any = false;
	for (const text of clientStdouts) {
		const delta = windowSentDelta(
			parseLoadClientSentProgress(text),
			warmupMs,
			measureMs,
		);
		if (!delta || delta.bdpBps1 == null) continue;
		any = true;
		sum += delta.bdpBps1;
	}
	return any ? sum : null;
}

export function sumWindowCwnd(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
): number | null {
	let sum = 0;
	let any = false;
	for (const text of clientStdouts) {
		const delta = windowSentDelta(
			parseLoadClientSentProgress(text),
			warmupMs,
			measureMs,
		);
		if (!delta || delta.cwnd1 == null) continue;
		any = true;
		sum += delta.cwnd1;
	}
	return any ? sum : null;
}

export function meanWindowRttUs(
	clientStdouts: readonly string[],
	warmupMs: number,
	measureMs: number,
): number | null {
	let sum = 0;
	let n = 0;
	for (const text of clientStdouts) {
		const delta = windowSentDelta(
			parseLoadClientSentProgress(text),
			warmupMs,
			measureMs,
		);
		if (!delta || delta.rttUs1 == null) continue;
		sum += delta.rttUs1;
		n += 1;
	}
	return n > 0 ? sum / n : null;
}

export function parseCpuList(spec: string): number[] {
	const cpus = new Set<number>();
	for (const part of spec.split(",")) {
		const token = part.trim();
		if (!token) continue;
		const range = token.split("-");
		if (range.length === 1) {
			const n = Number.parseInt(range[0] ?? "", 10);
			if (Number.isFinite(n)) cpus.add(n);
			continue;
		}
		const lo = Number.parseInt(range[0] ?? "", 10);
		const hi = Number.parseInt(range[1] ?? "", 10);
		if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) continue;
		for (let cpu = lo; cpu <= hi; cpu += 1) cpus.add(cpu);
	}
	return [...cpus].sort((a, b) => a - b);
}

export function cpuListsEqual(
	left: readonly number[],
	right: readonly number[],
): boolean {
	if (left.length !== right.length) return false;
	return left.every((cpu, i) => cpu === right[i]);
}

export function cpusSharePhysicalCore(
	cpuA: number,
	cpuB: number,
	siblingsOfA: readonly number[],
): boolean {
	if (cpuA === cpuB) return true;
	return siblingsOfA.includes(cpuB);
}

export function parseCpusAllowedListFromStatus(
	statusText: string,
): number[] | null {
	const line = statusText
		.split("\n")
		.find((row) => row.startsWith("Cpus_allowed_list:"));
	if (!line) return null;
	return parseCpuList(line.slice("Cpus_allowed_list:".length));
}

export function readCpusAllowedList(pid: number): number[] | null {
	try {
		return parseCpusAllowedListFromStatus(
			readFileSync(`/proc/${pid}/status`, "utf8"),
		);
	} catch {
		return null;
	}
}

export function readThreadSiblings(cpu: number): number[] | null {
	try {
		return parseCpuList(
			readFileSync(
				`/sys/devices/system/cpu/cpu${cpu}/topology/thread_siblings_list`,
				"utf8",
			).trim(),
		);
	} catch {
		return null;
	}
}

export function classifyPipeCap(input: {
	frameTxPerSec: number | null;
	ingestedPerSec: number;
	bdpBps: number | null;
	cwnd: number | null;
	rttUs: number | null;
	udpTxBytesPerSec: number | null;
	clientCpuCores: number | null;
	congPerSec: number | null;
}): PipeCap {
	const frameTx = input.frameTxPerSec;
	const bytesPerDatagram =
		frameTx != null &&
		frameTx > 0 &&
		input.udpTxBytesPerSec != null &&
		input.udpTxBytesPerSec > 0
			? input.udpTxBytesPerSec / frameTx
			: null;
	const predictedPps =
		input.bdpBps != null && bytesPerDatagram != null && bytesPerDatagram > 0
			? input.bdpBps / bytesPerDatagram
			: null;

	let stopBucket: PipeCapBucket;
	if (frameTx == null || input.bdpBps == null) {
		stopBucket = "incomplete";
	} else if (input.ingestedPerSec < 0.9 * frameTx) {
		stopBucket = "server-ingest";
	} else if (predictedPps != null && predictedPps <= 1.15 * frameTx) {
		stopBucket = "cc";
	} else if (
		predictedPps != null &&
		predictedPps > 1.25 * frameTx &&
		input.clientCpuCores != null &&
		input.clientCpuCores >= 1.5
	) {
		stopBucket = "client-cpu";
	} else {
		stopBucket = "unexplained";
	}

	return {
		frameTxPerSec: frameTx,
		ingestedPerSec: input.ingestedPerSec,
		predictedPps,
		bdpBps: input.bdpBps,
		cwnd: input.cwnd,
		rttUs: input.rttUs,
		clientCpuCores: input.clientCpuCores,
		congPerSec: input.congPerSec,
		bytesPerDatagram,
		stopBucket,
	};
}

export function formatPipeCapLine(pipe: PipeCap): string {
	const n = (value: number | null): string =>
		value == null ? "n/a" : String(Math.round(value));
	return (
		`pipe: frameTx=${n(pipe.frameTxPerSec)} ingest=${Math.round(pipe.ingestedPerSec)} ` +
		`predicted=${n(pipe.predictedPps)} bdpBps=${n(pipe.bdpBps)} ` +
		`cwnd=${n(pipe.cwnd)} rtt_us=${n(pipe.rttUs)} ` +
		`clientCpu=${pipe.clientCpuCores == null ? "n/a" : pipe.clientCpuCores.toFixed(2)} ` +
		`cong=${n(pipe.congPerSec)} STOP=${pipe.stopBucket}`
	);
}

const GAP_STOP_PER_SEC = 5_000;
const ACCOUNTS_FRACTION = 0.9;

export function classifyIngestGap(input: {
	windowOfferedPerSec: number | null;
	offeredPerSec: number;
	ingestedPerSec: number;
	packetsLostDelta: number | null;
	packetsReceivedDelta: number | null;
	udpInErrorsDelta: number | null;
	udpRcvbufErrorsDelta: number | null;
	frameTxDatagramPerSec?: number | null;
	udpTxPerSec?: number | null;
	windowSec: number;
}): IngestGap {
	const offered = input.windowOfferedPerSec ?? input.offeredPerSec;
	const gap = Math.max(0, offered - input.ingestedPerSec);
	const rate = (delta: number | null): number | null =>
		delta != null && input.windowSec > 0 ? delta / input.windowSec : null;
	const lostRate = rate(input.packetsLostDelta);
	const rcvbufRate = rate(input.udpRcvbufErrorsDelta);
	const frameTx = input.frameTxDatagramPerSec ?? null;
	const udpTx = input.udpTxPerSec ?? null;
	const acceptedNotFramed =
		frameTx != null ? Math.max(0, offered - frameTx) : null;
	const framedNotIngested =
		frameTx != null ? Math.max(0, frameTx - input.ingestedPerSec) : null;

	let stopBucket: IngestGapBucket;
	let accounted = 0;
	if (gap < GAP_STOP_PER_SEC) {
		stopBucket = "window-accounting";
	} else if (lostRate != null && lostRate >= ACCOUNTS_FRACTION * gap) {
		stopBucket = "quic-loss";
		accounted = lostRate;
	} else if (rcvbufRate != null && rcvbufRate >= ACCOUNTS_FRACTION * gap) {
		stopBucket = "udp-rcvbuf";
		accounted = rcvbufRate;
	} else if (
		acceptedNotFramed != null &&
		acceptedNotFramed >= ACCOUNTS_FRACTION * gap
	) {
		stopBucket = "client-cc";
		accounted = acceptedNotFramed;
	} else if (
		framedNotIngested != null &&
		framedNotIngested >= ACCOUNTS_FRACTION * gap
	) {
		stopBucket = "wire";
		accounted = framedNotIngested;
	} else {
		stopBucket = "unexplained";
	}

	return {
		windowOfferedPerSec: input.windowOfferedPerSec,
		ingestedPerSec: input.ingestedPerSec,
		packetsLostDelta: input.packetsLostDelta,
		packetsReceivedDelta: input.packetsReceivedDelta,
		udpInErrorsDelta: input.udpInErrorsDelta,
		udpRcvbufErrorsDelta: input.udpRcvbufErrorsDelta,
		frameTxDatagramPerSec: frameTx,
		udpTxPerSec: udpTx,
		unexplainedPerSec: Math.max(0, gap - accounted),
		stopBucket,
	};
}

export function formatGapLine(gap: IngestGap): string {
	const n = (value: number | null): string =>
		value == null ? "n/a" : String(Math.round(value));
	return (
		`gap: windowOffered=${n(gap.windowOfferedPerSec)} ingest=${Math.round(gap.ingestedPerSec)} ` +
		`frameTx=${n(gap.frameTxDatagramPerSec)} udpTx=${n(gap.udpTxPerSec)} ` +
		`lost=${n(gap.packetsLostDelta)} rcvbuf=${n(gap.udpRcvbufErrorsDelta)} ` +
		`unexplained=${n(gap.unexplainedPerSec)} STOP=${gap.stopBucket}`
	);
}

type UdpSnapshot = {
	inErrors: number | null;
	rcvbufErrors: number | null;
};

function readLinuxUdpSnapshot(): UdpSnapshot | null {
	if (process.platform !== "linux") return null;
	let snmpText: string;
	try {
		snmpText = readFileSync("/proc/net/snmp", "utf8");
	} catch {
		return null;
	}
	const snmp = parseProcSnmpUdp(snmpText);
	if (!snmp) return null;
	let rcvbufErrors: number | null = snmp.rcvbufErrors ?? null;
	if (rcvbufErrors == null) {
		try {
			rcvbufErrors =
				parseProcNetstatUdp(readFileSync("/proc/net/netstat", "utf8"))
					?.RcvbufErrors ?? null;
		} catch {
			rcvbufErrors = null;
		}
	}
	return { inErrors: snmp.InErrors, rcvbufErrors };
}

function deltaOrNull(
	before: number | null | undefined,
	after: number | null | undefined,
): number | null {
	if (before == null || after == null) return null;
	return after - before;
}

type SessionWithStats = ServerSession & {
	connectionStats?: () => QuicConnectionStats | null;
};

function sumConnectionStats(sessions: readonly SessionWithStats[]): {
	packetsLost: number;
	packetsReceived: number;
} | null {
	let packetsLost = 0;
	let packetsReceived = 0;
	let any = false;
	for (const session of sessions) {
		const stats = session.connectionStats?.();
		if (!stats) continue;
		any = true;
		packetsLost += stats.packetsLost;
		packetsReceived += stats.packetsReceived;
	}
	return any ? { packetsLost, packetsReceived } : null;
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
	const sessionRefs: SessionWithStats[] = [];
	const aggregateOffered = sessions * rate;
	const server = createServer({
		port,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: sessions + 100,
			maxHandshakesInFlight: sessions + 100,
			...(STREAMS_PER_SEC > 0
				? {
						maxStreamsGlobal: 200_000,
						maxStreamsPerSessionBidi: 2_000,
						maxStreamsPerSessionUni: 2_000,
					}
				: {}),
		},
		rateLimits: {
			handshakesPerSec: Math.max(sessions * 2, 400),
			handshakesBurst: Math.max(sessions * 4, 1000),
			handshakesBurstPerPrefix: Math.max(sessions * 4, 1000),
			// Scale with the driven open rate, or the limiter becomes the thing
			// being measured instead of the accept path.
			streamsPerSec: Math.max(1000, sessions * STREAMS_PER_SEC * 4),
			streamsBurst: Math.max(2000, sessions * STREAMS_PER_SEC * 8),
			// Measure the delivery path, never the limiter.
			datagramsPerSec: aggregateOffered * 4,
			datagramsBurst: aggregateOffered * 8,
		},
		onSession: (session) => {
			sessionRefs.push(session as SessionWithStats);
			if (DISCARD) {
				const discard = (
					session as {
						discardIncomingDatagram?: (
							timeoutMs?: number,
						) => Promise<boolean | null | undefined>;
					}
				).discardIncomingDatagram?.bind(session);
				if (!discard) {
					throw new Error(
						"WT_PROBE_DISCARD=1 but session.discardIncomingDatagram is missing",
					);
				}
				void (async () => {
					for (;;) {
						const got = await discard();
						if (got == null) break;
						if (got) received += 1;
					}
				})().catch(() => {});
			} else {
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
			}
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
	const expectedClientCpus = CLIENT_TASKSET ? parseCpuList(CLIENT_TASKSET) : [];
	const clients = Array.from({ length: CLIENTS }, (_, i) => {
		const args = [
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
		];
		return Bun.spawn(
			CLIENT_TASKSET ? ["taskset", "-c", CLIENT_TASKSET, ...args] : args,
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		);
	});
	const clientCpusAllowed = clients.map((client) =>
		client.pid == null ? [] : (readCpusAllowedList(client.pid) ?? []),
	);
	const clientAffinityOk =
		!CLIENT_TASKSET ||
		(expectedClientCpus.length > 0 &&
			clientCpusAllowed.length === CLIENTS &&
			clientCpusAllowed.every((allowed) =>
				cpuListsEqual(allowed, expectedClientCpus),
			));
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
	const stats0 = sumConnectionStats(sessionRefs);
	const udp0 = readLinuxUdpSnapshot();
	const t0 = performance.now();
	await Bun.sleep(MEASURE_SEC * 1_000);
	const rx1 = received;
	const bytes1 = receivedBytes;
	const cpu1 = process.cpuUsage();
	const probe1 = __TESTING__.nativeWorkerProbeSnapshotForTests() ?? {};
	const metrics1 = server.metricsSnapshot();
	const stats1 = sumConnectionStats(sessionRefs);
	const udp1 = readLinuxUdpSnapshot();
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
	const ingestedPerSec =
		((metrics1.datagramsIn - metrics0.datagramsIn) / windowMs) * 1000;
	const windowOfferedPerSec = sumWindowOfferedPerSec(
		stdout,
		WARMUP_SEC * 1_000,
		MEASURE_SEC * 1_000,
	);
	const frameTxDatagramPerSec = sumWindowFrameTxPerSec(
		stdout,
		WARMUP_SEC * 1_000,
		MEASURE_SEC * 1_000,
	);
	const udpTxPerSec = sumWindowUdpTxPerSec(
		stdout,
		WARMUP_SEC * 1_000,
		MEASURE_SEC * 1_000,
	);
	const packetsLostDelta = deltaOrNull(
		stats0?.packetsLost,
		stats1?.packetsLost,
	);
	const packetsReceivedDelta = deltaOrNull(
		stats0?.packetsReceived,
		stats1?.packetsReceived,
	);
	const udpInErrorsDelta = deltaOrNull(udp0?.inErrors, udp1?.inErrors);
	const udpRcvbufErrorsDelta = deltaOrNull(
		udp0?.rcvbufErrors,
		udp1?.rcvbufErrors,
	);
	const gap = classifyIngestGap({
		windowOfferedPerSec,
		offeredPerSec,
		ingestedPerSec,
		packetsLostDelta,
		packetsReceivedDelta,
		udpInErrorsDelta,
		udpRcvbufErrorsDelta,
		frameTxDatagramPerSec,
		udpTxPerSec,
		windowSec: windowMs / 1000,
	});
	const pipeCap = classifyPipeCap({
		frameTxPerSec: frameTxDatagramPerSec,
		ingestedPerSec,
		bdpBps: sumWindowBdpBps(stdout, WARMUP_SEC * 1_000, MEASURE_SEC * 1_000),
		cwnd: sumWindowCwnd(stdout, WARMUP_SEC * 1_000, MEASURE_SEC * 1_000),
		rttUs: meanWindowRttUs(stdout, WARMUP_SEC * 1_000, MEASURE_SEC * 1_000),
		udpTxBytesPerSec: sumWindowUdpTxBytesPerSec(
			stdout,
			WARMUP_SEC * 1_000,
			MEASURE_SEC * 1_000,
		),
		clientCpuCores: sumWindowClientCpuCores(
			stdout,
			WARMUP_SEC * 1_000,
			MEASURE_SEC * 1_000,
		),
		congPerSec: sumWindowCongPerSec(
			stdout,
			WARMUP_SEC * 1_000,
			MEASURE_SEC * 1_000,
		),
	});

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
			datagramsDroppedTooLarge:
				(metrics1.datagramsDroppedTooLarge ?? 0) -
				(metrics0.datagramsDroppedTooLarge ?? 0),
			datagramsDroppedQueueSession:
				(metrics1.datagramsDroppedQueueSession ?? 0) -
				(metrics0.datagramsDroppedQueueSession ?? 0),
			datagramsDroppedQueueGlobal:
				(metrics1.datagramsDroppedQueueGlobal ?? 0) -
				(metrics0.datagramsDroppedQueueGlobal ?? 0),
			datagramsDroppedRateLimited:
				(metrics1.datagramsDroppedRateLimited ?? 0) -
				(metrics0.datagramsDroppedRateLimited ?? 0),
		},
		workerProof: {
			configured: probe1.configuredServerWorkerThreads ?? null,
			availableParallelism: probe1.availableParallelism ?? null,
			datagramThreads: Object.keys(perThread).length,
			perThread,
			cpuBefore: timingKeys(probe0),
			cpuAfter: timingKeys(probe1),
		},
		gap,
		pipeCap,
		clientTaskset: CLIENT_TASKSET,
		clientCpusAllowed,
		clientAffinityOk,
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
				`${Math.round(median(s.runs.map((r) => r.datagramsOutPerSec)))
					.toLocaleString()
					.padStart(9)} send/s  ` +
				`${Math.round(median(s.runs.map((r) => r.acceptedStreamsPerSec)))
					.toLocaleString()
					.padStart(7)} acc/s  ` +
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

	if (ECHO && DISCARD) {
		console.error(
			"probe: REFUSED\n  WT_PROBE_ECHO and WT_PROBE_DISCARD cannot both be set",
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
	if (workers.length === 0) {
		console.error(
			"probe: REFUSED\n  WT_PROBE_WORKERS matched no arms; expected 1,2,4,auto",
		);
		process.exit(1);
	}
	const sessions = SKIP_SESSION_SWEEP ? [] : sessionArms();
	const workerSweep = await runSweep("workers", workers, rng, BASE_PORT);
	const sessionSweep =
		sessions.length > 0
			? await runSweep("sessions", sessions, rng, BASE_PORT + 200)
			: { runs: [] as ArmRun[], order: [] as string[] };

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
			echo: ECHO,
			discard: DISCARD,
			streamsPerSec: STREAMS_PER_SEC,
			skipSessionSweep: SKIP_SESSION_SWEEP,
			saturationCeiling: SATURATION_CEILING,
			seed,
			workerOrder: workerSweep.order,
			sessionOrder: sessionSweep.order,
			hops: {
				readDatagramViaServerRuntime:
					process.env.WEBTRANSPORT_READ_DATAGRAM_VIA_SERVER_RUNTIME ?? "",
				sendDatagramViaServerRuntime:
					process.env.WEBTRANSPORT_SEND_DATAGRAM_VIA_SERVER_RUNTIME ?? "",
				discardDatagramViaServerRuntime:
					process.env.WEBTRANSPORT_DISCARD_DATAGRAM_VIA_SERVER_RUNTIME ?? "",
				streamOpsViaServerRuntime:
					process.env.WEBTRANSPORT_STREAM_OPS_VIA_SERVER_RUNTIME ?? "",
				globalQueueInterval:
					process.env.WEBTRANSPORT_SERVER_GLOBAL_QUEUE_INTERVAL ?? "",
			},
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
	if (sessionSummary.length > 0) {
		printSweep(
			`SESSION SWEEP (workers=1, ~${AGGREGATE_PER_SEC.toLocaleString()}/s offered)`,
			sessionSummary,
		);
	}
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
