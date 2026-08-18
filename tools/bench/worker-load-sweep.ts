#!/usr/bin/env bun

/**
 * Does delivered throughput ever FALL as offered load RISES, and if so where?
 *
 * On macOS this branch found that one tokio worker collapses under overload:
 * it takes ~103k datagrams/s off the wire and delivers 5.4k, dropping 95% at
 * the queued-bytes reservation because the delivery future is starved on the
 * single worker. Two workers dropped nothing. That was measured on a receive
 * path where quinn-udp's BATCH_SIZE resolves to 1, so every datagram costs a
 * syscall. Linux with GRO batches 32, which moves the economics enough that a
 * single load point would not transfer.
 *
 * So this sweeps offered load against worker count and asks the question
 * directly, rather than re-running one macOS operating point.
 *
 * TWO WAYS THIS MEASUREMENT CAN LIE, both reported rather than assumed:
 *
 *   1. THE GENERATOR IS THE CEILING. On macOS a single load-client pinned at
 *      65.1-65.4k/s and every earlier number in this investigation was that
 *      limit rather than the server's. On a 4-vCPU box with the clients
 *      co-resident this is more likely, not less. Offered rate is therefore a
 *      first-class output, and any rung whose offered load is pinned across
 *      worker counts while falling short of what was requested is flagged
 *      `generatorLimited` — the signature of measuring the sender.
 *   2. THE HOST CANNOT REACH THE CLIFF. If no rung drives the server past its
 *      knee, "no collapse observed" means "not tested", and the summary says
 *      so instead of reporting a negative.
 *
 * Every arm keeps the discipline the macOS runs used: interleaved round-robin,
 * the configured-worker-count abort, the per-OS-thread datagram proof, and a
 * refusal on a dirty tree, a moved HEAD or a non-finite sample.
 *
 * Usage: bun tools/bench/worker-load-sweep.ts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";

import { classify, threadRows } from "./thread-profile.ts";
import {
	dirtyPaths,
	formatGapLine,
	formatPipeCapLine,
	type IngestGap,
	makeRng,
	median,
	type PipeCap,
	pickDisjointPhysicalCpus,
	readHostSiblingMap,
	shuffled,
} from "./worker-thread-parallelism-probe.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const CLIENT_BIN = join(ROOT, "target", "release", "load-client");
const PROBE = join("tools", "bench", "worker-thread-parallelism-probe.ts");
const COMMAND = "bun tools/bench/worker-load-sweep.ts";

const SESSIONS = Number(process.env.SWEEP_SESSIONS ?? "100");
/** Aggregate offered datagrams/s per rung. */
const RATES = (process.env.SWEEP_RATES ?? "20000,40000,80000,160000")
	.split(",")
	.map((r) => Number(r.trim()))
	.filter((r) => Number.isFinite(r) && r > 0);
const WORKERS = (process.env.SWEEP_WORKERS ?? "1,2")
	.split(",")
	.map((w) => w.trim())
	.filter((w) => w.length > 0);
const SEND_MODES = (process.env.SWEEP_SEND_MODES ?? "drop")
	.split(",")
	.map((s) => s.trim())
	.filter((s): s is "drop" | "wait" => s === "drop" || s === "wait");
const CPU_MODES = (process.env.SWEEP_CPU_MODES ?? "shared")
	.split(",")
	.map((s) => s.trim())
	.filter((s): s is "shared" | "split" => s === "shared" || s === "split");
const RMEM_MODES = (process.env.SWEEP_RMEM_MODES ?? "default")
	.split(",")
	.map((s) => s.trim())
	.filter((s): s is "default" | "raised" => s === "default" || s === "raised");
const CC_MODES = (process.env.SWEEP_CC_MODES ?? "cubic")
	.split(",")
	.map((s) => s.trim())
	.filter((s): s is "cubic" | "bbr" => s === "cubic" || s === "bbr");
const GEN_MODES = (process.env.SWEEP_GEN_MODES ?? "onbox")
	.split(",")
	.map((s) => s.trim())
	.filter((s): s is "onbox" | "offbox" => s === "onbox" || s === "offbox");
/** ssh destination for the off-box generator, e.g. user@192.168.2.36. */
const OFFBOX_SSH = (process.env.SWEEP_OFFBOX_SSH ?? "").trim();
/** LAN address of this server as seen from the off-box generator. */
const OFFBOX_HOST = (process.env.SWEEP_OFFBOX_HOST ?? "").trim();
const OFFBOX_BIN = (process.env.SWEEP_OFFBOX_BIN ?? "/tmp/load-client").trim();
const RMEM_RAISED_BYTES = 8 * 1024 * 1024;
/** Load-generator processes sharing the sessions. */
const CLIENTS = Number(process.env.SWEEP_CLIENTS ?? "2");
const REPS = Number(process.env.SWEEP_REPS ?? "2");
const WARMUP_SEC = Number(process.env.SWEEP_WARMUP_SEC ?? "5");
const MEASURE_SEC = Number(process.env.SWEEP_MEASURE_SEC ?? "15");
const PAYLOAD_BYTES = Number(process.env.SWEEP_PAYLOAD_BYTES ?? "1150");
const BASE_PORT = Number(process.env.SWEEP_BASE_PORT ?? "50110");
const ARTIFACT_PATH =
	process.env.SWEEP_OUT ??
	join(ROOT, ".investigation", "worker-load-sweep-linux.json");
const CHILD_TIMEOUT_MS = (WARMUP_SEC + MEASURE_SEC) * 1_000 + 90_000;

/**
 * An arm whose offered load reached this fraction of what was requested was
 * driven as hard as it was asked to be; below it, the generator or the network
 * fell short and the rung's offered rate is the real independent variable.
 */
export const REQUEST_MET = 0.9;
/**
 * Offered rates within this fraction of each other across worker counts, at the
 * same requested rung, are indistinguishable — the generator produced the same
 * load regardless of what the server did, which is what being sender-bound
 * looks like.
 */
export const OFFERED_PINNED = 0.05;
/** Delivered falling to this fraction of an arm's own best counts as collapse. */
export const COLLAPSE_FRACTION = 0.5;

export type SweepArm = {
	workers: string;
	requestedPerSec: number;
	ratePerSession: number;
	sendMode: "drop" | "wait";
	cpuMode: "shared" | "split";
	rmemMode: "default" | "raised";
	ccMode: "cubic" | "bbr";
	genMode: "onbox" | "offbox";
};

export function sweepArms(): SweepArm[] {
	const arms: SweepArm[] = [];
	for (const rmemMode of RMEM_MODES) {
		for (const cpuMode of CPU_MODES) {
			for (const sendMode of SEND_MODES) {
				for (const workers of WORKERS) {
					for (const requestedPerSec of RATES) {
						for (const ccMode of CC_MODES) {
							for (const genMode of GEN_MODES) {
								arms.push({
									workers,
									requestedPerSec,
									ratePerSession: Math.max(
										1,
										Math.round(requestedPerSec / SESSIONS),
									),
									sendMode,
									cpuMode,
									rmemMode,
									ccMode,
									genMode,
								});
							}
						}
					}
				}
			}
		}
	}
	return arms;
}

export const armKey = (a: {
	workers: string;
	requestedPerSec: number;
	sendMode?: "drop" | "wait";
	cpuMode?: "shared" | "split";
	rmemMode?: "default" | "raised";
	ccMode?: "cubic" | "bbr";
	genMode?: "onbox" | "offbox";
}): string => {
	let key = `w${a.workers}@${a.requestedPerSec}`;
	if (a.sendMode && a.sendMode !== "drop") key += `@${a.sendMode}`;
	if (a.cpuMode && a.cpuMode !== "shared") key += `@${a.cpuMode}`;
	if (a.rmemMode && a.rmemMode !== "default") key += `@${a.rmemMode}`;
	if (a.ccMode && a.ccMode !== "cubic") key += `@${a.ccMode}`;
	if (a.genMode && a.genMode !== "onbox") key += `@${a.genMode}`;
	return key;
};

export type SweepRun = {
	key: string;
	workers: string;
	requestedPerSec: number;
	round: number;
	offeredPerSec: number;
	deliveredPerSec: number;
	ingestedPerSec: number;
	droppedPct: number;
	rateLimited: number;
	droppedTooLarge: number;
	droppedQueueSession: number;
	droppedQueueGlobal: number;
	droppedRateLimited: number;
	processCores: number;
	tokioCores: number;
	jsCores: number;
	datagramThreads: number;
	configuredWorkers: number | null;
	sessionsOk: number;
	clientSendErrors: number;
	threads: { label: string; cores: number; datagrams: number }[];
	gap: IngestGap | null;
	pipeCap: PipeCap | null;
	clientTaskset: string;
	clientCpusAllowed: number[][];
	clientAffinityOk: boolean;
	skRcvbuf: number | null;
	skDrops: number | null;
	appliedCongestion: string | null;
	offboxSsh: string | null;
};

function gitOutput(args: string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

function readSysctl(name: string): number | null {
	try {
		const text = readFileSync(`/proc/sys/${name.replaceAll(".", "/")}`, "utf8");
		const n = Number.parseInt(text.trim(), 10);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

function writeSysctl(name: string, value: number): boolean {
	const path = `/proc/sys/${name.replaceAll(".", "/")}`;
	try {
		writeFileSync(path, `${value}\n`);
		return readSysctl(name) === value;
	} catch {
		const result = spawnSync("sysctl", ["-w", `${name}=${value}`], {
			encoding: "utf8",
		});
		if (result.status === 0 && readSysctl(name) === value) return true;
		const sudo = spawnSync("sudo", ["-n", "sysctl", "-w", `${name}=${value}`], {
			encoding: "utf8",
		});
		return sudo.status === 0 && readSysctl(name) === value;
	}
}

async function runOne(
	arm: SweepArm,
	round: number,
	port: number,
	splitTaskset: string,
): Promise<SweepRun> {
	if (arm.genMode === "offbox") {
		// A prior run's stragglers must not share the generator with this arm.
		spawnSync(
			"ssh",
			["-o", "BatchMode=yes", OFFBOX_SSH, "pkill", "-x", "load-client"],
			{ encoding: "utf8" },
		);
	}
	const child = Bun.spawn(
		[
			"bun",
			PROBE,
			"--child",
			"--label",
			armKey(arm),
			"--port",
			String(port),
			"--round",
			String(round),
			"--sessions",
			String(SESSIONS),
			"--rate",
			String(arm.ratePerSession),
		],
		{
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...(process.env as Record<string, string>),
				WEBTRANSPORT_SERVER_WORKER_THREADS: arm.workers,
				LOAD_CLIENT_DATAGRAM_WAIT: arm.sendMode === "wait" ? "1" : "0",
				WT_PROBE_CLIENTS: String(CLIENTS),
				WT_PROBE_WARMUP_SEC: String(WARMUP_SEC),
				WT_PROBE_MEASURE_SEC: String(MEASURE_SEC),
				WT_PROBE_PAYLOAD_BYTES: String(PAYLOAD_BYTES),
				WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
				WT_PROBE_CLIENT_TASKSET: arm.cpuMode === "split" ? splitTaskset : "",
				WT_PROBE_CONGESTION: arm.ccMode,
				WT_PROBE_OFFBOX_SSH: arm.genMode === "offbox" ? OFFBOX_SSH : "",
				WT_PROBE_OFFBOX_URL_HOST: arm.genMode === "offbox" ? OFFBOX_HOST : "",
				WT_PROBE_OFFBOX_BIN: OFFBOX_BIN,
			},
		},
	);
	const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
	try {
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		const exitCode = await child.exited;
		const line = stdout.split("\n").find((l) => l.startsWith("__ARM_RESULT__"));
		if (exitCode !== 0 || !line) {
			throw new Error(
				`${armKey(arm)} round ${round} failed (exit ${exitCode}): ${stderr.slice(-1500)}`,
			);
		}
		const run = JSON.parse(line.slice("__ARM_RESULT__".length));
		const rows = threadRows(
			run.workerProof.cpuBefore ?? {},
			run.workerProof.cpuAfter ?? {},
			run.windowMs,
		);
		const seconds = run.windowMs / 1000;
		const ingested = (run.drops?.datagramsIn ?? 0) / seconds;
		const dropped = (run.drops?.datagramsDropped ?? 0) / seconds;
		return {
			key: armKey(arm),
			workers: arm.workers,
			requestedPerSec: arm.requestedPerSec,
			round,
			offeredPerSec: run.offeredPerSec,
			deliveredPerSec: run.receivedPerSec,
			ingestedPerSec: ingested,
			droppedPct: ingested > 0 ? (dropped / ingested) * 100 : 0,
			rateLimited: run.drops?.rateLimited ?? 0,
			droppedTooLarge: run.drops?.datagramsDroppedTooLarge ?? 0,
			droppedQueueSession: run.drops?.datagramsDroppedQueueSession ?? 0,
			droppedQueueGlobal: run.drops?.datagramsDroppedQueueGlobal ?? 0,
			droppedRateLimited: run.drops?.datagramsDroppedRateLimited ?? 0,
			processCores: run.serverCpuCores,
			tokioCores: rows
				.filter((r) => classify(r) === "tokio-worker")
				.reduce((a, r) => a + r.cores, 0),
			jsCores: rows
				.filter((r) => classify(r) === "js-thread")
				.reduce((a, r) => a + r.cores, 0),
			datagramThreads: run.workerProof.datagramThreads ?? 0,
			configuredWorkers: run.workerProof.configured ?? null,
			sessionsOk: run.sessionsOk,
			clientSendErrors: run.clientSendErrors,
			threads: rows.map((r) => ({
				label: r.label,
				cores: r.cores,
				datagrams: r.datagrams,
			})),
			gap: run.gap ?? null,
			pipeCap: run.pipeCap ?? null,
			clientTaskset: run.clientTaskset ?? "",
			clientCpusAllowed: run.clientCpusAllowed ?? [],
			clientAffinityOk: run.clientAffinityOk !== false,
			skRcvbuf: run.skRcvbuf ?? null,
			skDrops: run.skDrops ?? null,
			appliedCongestion: run.appliedCongestion ?? null,
			offboxSsh: run.offboxSsh ?? null,
		};
	} finally {
		clearTimeout(timer);
	}
}

export type ArmSummary = {
	key: string;
	workers: string;
	requestedPerSec: number;
	offeredPerSec: number;
	deliveredPerSec: number;
	ingestedPerSec: number;
	droppedPct: number;
	droppedTooLarge: number;
	droppedQueueSession: number;
	droppedQueueGlobal: number;
	droppedRateLimited: number;
	processCores: number;
	tokioCores: number;
	jsCores: number;
	datagramThreads: number;
	configuredWorkers: number | null;
	requestMet: boolean;
	runs: SweepRun[];
};

export function summarize(arms: SweepArm[], runs: SweepRun[]): ArmSummary[] {
	return arms.map((arm) => {
		const mine = runs.filter((r) => r.key === armKey(arm));
		const med = (pick: (r: SweepRun) => number): number =>
			mine.length > 0 ? median(mine.map(pick)) : Number.NaN;
		const offered = med((r) => r.offeredPerSec);
		return {
			key: armKey(arm),
			workers: arm.workers,
			requestedPerSec: arm.requestedPerSec,
			offeredPerSec: offered,
			deliveredPerSec: med((r) => r.deliveredPerSec),
			ingestedPerSec: med((r) => r.ingestedPerSec),
			droppedPct: med((r) => r.droppedPct),
			droppedTooLarge: med((r) => r.droppedTooLarge),
			droppedQueueSession: med((r) => r.droppedQueueSession),
			droppedQueueGlobal: med((r) => r.droppedQueueGlobal),
			droppedRateLimited: med((r) => r.droppedRateLimited),
			processCores: med((r) => r.processCores),
			tokioCores: med((r) => r.tokioCores),
			jsCores: med((r) => r.jsCores),
			datagramThreads: Math.max(...mine.map((r) => r.datagramThreads)),
			configuredWorkers: mine[0]?.configuredWorkers ?? null,
			requestMet: offered >= arm.requestedPerSec * REQUEST_MET,
			runs: mine,
		};
	});
}

/**
 * Rungs where the generator, not the server, set the pace.
 *
 * Two conditions together: the requested load was not reached, and every worker
 * count produced near-identical offered load. Either alone is ambiguous — a
 * server that collapses identically at both worker counts would also fail the
 * first — but a generator indifferent to what the server is doing shows both.
 */
export function generatorLimitedRates(summaries: ArmSummary[]): number[] {
	const rates = [...new Set(summaries.map((s) => s.requestedPerSec))];
	return rates.filter((rate) => {
		const atRate = summaries.filter((s) => s.requestedPerSec === rate);
		if (atRate.length < 2) return false;
		if (atRate.every((s) => s.requestMet)) return false;
		const offered = atRate.map((s) => s.offeredPerSec);
		const lo = Math.min(...offered);
		const hi = Math.max(...offered);
		return hi > 0 && (hi - lo) / hi <= OFFERED_PINNED;
	});
}

/** Did delivered throughput fall as offered load rose, for this worker count? */
export function collapseFor(
	summaries: ArmSummary[],
	workers: string,
): {
	collapsed: boolean;
	peakPerSec: number;
	atPeakOffered: number;
	worstPerSec: number;
	worstOffered: number;
} {
	const ladder = summaries
		.filter((s) => s.workers === workers)
		.sort((a, b) => a.offeredPerSec - b.offeredPerSec);
	if (ladder.length === 0) {
		return {
			collapsed: false,
			peakPerSec: 0,
			atPeakOffered: 0,
			worstPerSec: 0,
			worstOffered: 0,
		};
	}
	const peak = ladder.reduce((a, b) =>
		b.deliveredPerSec > a.deliveredPerSec ? b : a,
	);
	// Only rungs offered MORE than the peak's can show a fall-off with rising load.
	const beyond = ladder.filter((s) => s.offeredPerSec > peak.offeredPerSec);
	const worst = beyond.reduce(
		(a, b) => (b.deliveredPerSec < a.deliveredPerSec ? b : a),
		beyond[0] ?? peak,
	);
	return {
		collapsed:
			beyond.length > 0 &&
			worst.deliveredPerSec < peak.deliveredPerSec * COLLAPSE_FRACTION,
		peakPerSec: peak.deliveredPerSec,
		atPeakOffered: peak.offeredPerSec,
		worstPerSec: worst.deliveredPerSec,
		worstOffered: worst.offeredPerSec,
	};
}

export function proofFailures(summaries: ArmSummary[]): string[] {
	const failures: string[] = [];
	for (const s of summaries) {
		const expected = Number(s.workers);
		if (s.configuredWorkers === null) {
			failures.push(`${s.key}: addon reported no worker-probe snapshot`);
			continue;
		}
		if (Number.isFinite(expected) && s.configuredWorkers !== expected) {
			failures.push(
				`${s.key}: runtime configured ${s.configuredWorkers} workers, expected ${expected}`,
			);
		}
		if (s.configuredWorkers > 1 && s.datagramThreads < 2) {
			failures.push(
				`${s.key}: ${s.configuredWorkers} workers configured but datagrams only ` +
					"ever landed on one OS thread",
			);
		}
		if (!Number.isFinite(s.deliveredPerSec) || s.deliveredPerSec <= 0) {
			failures.push(`${s.key}: non-finite or zero delivered rate`);
		}
	}
	return failures;
}

export type WaitVsDropBucket = "path-cap" | "drop-starves-tx" | "incomplete";

export type WaitVsDrop = {
	dropFrameTxPerSec: number | null;
	waitFrameTxPerSec: number | null;
	dropOfferedPerSec: number | null;
	waitOfferedPerSec: number | null;
	ratio: number | null;
	stopBucket: WaitVsDropBucket;
};

function medianFrameTx(summaries: readonly ArmSummary[]): number | null {
	const vals = summaries.flatMap((s) =>
		s.runs
			.map((r) => r.gap?.frameTxDatagramPerSec)
			.filter((n): n is number => n != null),
	);
	return vals.length > 0 ? median(vals) : null;
}

export function classifyWaitVsDrop(
	summaries: readonly ArmSummary[],
): WaitVsDrop {
	const drop = summaries.filter((s) => !s.key.includes("@wait"));
	const wait = summaries.filter((s) => s.key.includes("@wait"));
	const dropFrameTxPerSec = medianFrameTx(drop);
	const waitFrameTxPerSec = medianFrameTx(wait);
	const dropOfferedPerSec =
		drop.length > 0 ? median(drop.map((s) => s.offeredPerSec)) : null;
	const waitOfferedPerSec =
		wait.length > 0 ? median(wait.map((s) => s.offeredPerSec)) : null;
	if (
		dropFrameTxPerSec == null ||
		waitFrameTxPerSec == null ||
		dropFrameTxPerSec <= 0
	) {
		return {
			dropFrameTxPerSec,
			waitFrameTxPerSec,
			dropOfferedPerSec,
			waitOfferedPerSec,
			ratio: null,
			stopBucket: "incomplete",
		};
	}
	const ratio = waitFrameTxPerSec / dropFrameTxPerSec;
	return {
		dropFrameTxPerSec,
		waitFrameTxPerSec,
		dropOfferedPerSec,
		waitOfferedPerSec,
		ratio,
		stopBucket: ratio >= 1.1 ? "drop-starves-tx" : "path-cap",
	};
}

export type CoresplitBucket = "co-residence" | "not-coresidence" | "incomplete";

export type Coresplit = {
	sharedFrameTxPerSec: number | null;
	splitFrameTxPerSec: number | null;
	ratio: number | null;
	nproc: number;
	tasksetOk: boolean;
	affinityOk: boolean;
	clientCpus: number[] | null;
	htSiblings: boolean;
	stopBucket: CoresplitBucket;
};

const SHARED_FRAME_TX_MIN = 90_000;
const SHARED_FRAME_TX_MAX = 120_000;
const CORESPLIT_RATIO = 1.2;

export function classifyCoresplit(input: {
	summaries: readonly ArmSummary[];
	nproc: number;
	tasksetOk: boolean;
	clientCpus: number[] | null;
}): Coresplit {
	const shared = input.summaries.filter((s) => !s.key.endsWith("@split"));
	const split = input.summaries.filter((s) => s.key.endsWith("@split"));
	const sharedFrameTxPerSec = medianFrameTx(shared);
	const splitFrameTxPerSec = medianFrameTx(split);
	const ratio =
		sharedFrameTxPerSec != null &&
		splitFrameTxPerSec != null &&
		sharedFrameTxPerSec > 0
			? splitFrameTxPerSec / sharedFrameTxPerSec
			: null;
	const affinityOk = split.every((s) =>
		s.runs.every((r) => r.clientAffinityOk),
	);
	const htSiblings = input.clientCpus == null || input.clientCpus.length < 2;
	const sharedReproduced =
		sharedFrameTxPerSec != null &&
		sharedFrameTxPerSec >= SHARED_FRAME_TX_MIN &&
		sharedFrameTxPerSec <= SHARED_FRAME_TX_MAX;
	const incomplete =
		input.nproc < 4 ||
		!input.tasksetOk ||
		!affinityOk ||
		split.length === 0 ||
		sharedFrameTxPerSec == null ||
		splitFrameTxPerSec == null ||
		htSiblings ||
		!sharedReproduced;
	let stopBucket: CoresplitBucket = "incomplete";
	if (!incomplete && ratio != null) {
		stopBucket = ratio >= CORESPLIT_RATIO ? "co-residence" : "not-coresidence";
	}
	return {
		sharedFrameTxPerSec,
		splitFrameTxPerSec,
		ratio,
		nproc: input.nproc,
		tasksetOk: input.tasksetOk,
		affinityOk,
		clientCpus: input.clientCpus,
		htSiblings,
		stopBucket,
	};
}

export type RmemBucket = "rmem" | "not-rmem" | "incomplete";

export type RmemCap = {
	defaultFrameTxPerSec: number | null;
	raisedFrameTxPerSec: number | null;
	ratio: number | null;
	defaultSkRcvbuf: number | null;
	raisedSkRcvbuf: number | null;
	rmemDefaultWrote: boolean;
	stopBucket: RmemBucket;
};

export function classifyRmem(input: {
	summaries: readonly ArmSummary[];
	rmemDefaultWrote: boolean;
	controlRmemDefault: number | null;
}): RmemCap {
	const def = input.summaries.filter((s) => !s.key.endsWith("@raised"));
	const raised = input.summaries.filter((s) => s.key.endsWith("@raised"));
	const defaultFrameTxPerSec = medianFrameTx(def);
	const raisedFrameTxPerSec = medianFrameTx(raised);
	const ratio =
		defaultFrameTxPerSec != null &&
		raisedFrameTxPerSec != null &&
		defaultFrameTxPerSec > 0
			? raisedFrameTxPerSec / defaultFrameTxPerSec
			: null;
	const medianSk = (arms: readonly ArmSummary[]): number | null => {
		const vals = arms.flatMap((s) =>
			s.runs
				.map((r) => r.skRcvbuf)
				.filter((n): n is number => n != null && n > 0),
		);
		return vals.length > 0 ? median(vals) : null;
	};
	const defaultSkRcvbuf = medianSk(def);
	const raisedSkRcvbuf = medianSk(raised);
	const socketGrew =
		defaultSkRcvbuf != null &&
		raisedSkRcvbuf != null &&
		raisedSkRcvbuf >= 4 * defaultSkRcvbuf;
	const defaultReproduced =
		defaultFrameTxPerSec != null &&
		defaultFrameTxPerSec >= SHARED_FRAME_TX_MIN &&
		defaultFrameTxPerSec <= SHARED_FRAME_TX_MAX;
	const noTreatment =
		input.controlRmemDefault != null &&
		input.controlRmemDefault >= RMEM_RAISED_BYTES;
	const incomplete =
		!input.rmemDefaultWrote ||
		noTreatment ||
		!socketGrew ||
		raised.length === 0 ||
		defaultFrameTxPerSec == null ||
		raisedFrameTxPerSec == null ||
		!defaultReproduced;
	let stopBucket: RmemBucket = "incomplete";
	if (!incomplete && ratio != null) {
		stopBucket = ratio >= CORESPLIT_RATIO ? "rmem" : "not-rmem";
	}
	return {
		defaultFrameTxPerSec,
		raisedFrameTxPerSec,
		ratio,
		defaultSkRcvbuf,
		raisedSkRcvbuf,
		rmemDefaultWrote: input.rmemDefaultWrote,
		stopBucket,
	};
}

export type CcBucket = "cc" | "not-cc" | "incomplete";

export type CcCap = {
	cubicFrameTxPerSec: number | null;
	bbrFrameTxPerSec: number | null;
	ratio: number | null;
	stopBucket: CcBucket;
};

export function classifyCc(input: {
	summaries: readonly ArmSummary[];
	rmemModes: readonly string[];
	cpuModes: readonly string[];
	sessions: number;
}): CcCap {
	const cubic = input.summaries.filter((s) => !s.key.endsWith("@bbr"));
	const bbr = input.summaries.filter((s) => s.key.endsWith("@bbr"));
	const cubicFrameTxPerSec = medianFrameTx(cubic);
	const bbrFrameTxPerSec = medianFrameTx(bbr);
	const ratio =
		cubicFrameTxPerSec != null &&
		bbrFrameTxPerSec != null &&
		cubicFrameTxPerSec > 0
			? bbrFrameTxPerSec / cubicFrameTxPerSec
			: null;
	const cubicReproduced =
		cubicFrameTxPerSec != null &&
		cubicFrameTxPerSec >= SHARED_FRAME_TX_MIN &&
		cubicFrameTxPerSec <= SHARED_FRAME_TX_MAX;
	const printMatches = (
		arms: readonly ArmSummary[],
		expected: string,
	): boolean =>
		arms.length > 0 &&
		arms.every((s) => s.runs.every((r) => r.appliedCongestion === expected));
	const sessionsHealthy = (arms: readonly ArmSummary[]): boolean =>
		arms.every((s) =>
			s.runs.every((r) => r.sessionsOk >= 0.9 * input.sessions),
		);
	const mixedRmem = input.rmemModes.some((m) => m !== "default");
	const mixedCpu = input.cpuModes.some((m) => m !== "shared");
	const incomplete =
		mixedRmem ||
		mixedCpu ||
		bbr.length === 0 ||
		cubicFrameTxPerSec == null ||
		bbrFrameTxPerSec == null ||
		bbrFrameTxPerSec === 0 ||
		!cubicReproduced ||
		!printMatches(cubic, "cubic") ||
		!printMatches(bbr, "bbr") ||
		!sessionsHealthy(cubic) ||
		!sessionsHealthy(bbr) ||
		bbrFrameTxPerSec < SHARED_FRAME_TX_MIN ||
		(ratio != null &&
			ratio >= CORESPLIT_RATIO &&
			bbrFrameTxPerSec <= SHARED_FRAME_TX_MAX);
	let stopBucket: CcBucket = "incomplete";
	if (!incomplete && ratio != null && bbrFrameTxPerSec != null) {
		if (ratio >= CORESPLIT_RATIO && bbrFrameTxPerSec > SHARED_FRAME_TX_MAX) {
			stopBucket = "cc";
		} else if (
			ratio < CORESPLIT_RATIO &&
			bbrFrameTxPerSec >= SHARED_FRAME_TX_MIN
		) {
			stopBucket = "not-cc";
		}
	}
	return {
		cubicFrameTxPerSec,
		bbrFrameTxPerSec,
		ratio,
		stopBucket,
	};
}

export type OffboxBucket = "offbox-lifts" | "not-offbox" | "incomplete";

export type OffboxCap = {
	onboxFrameTxPerSec: number | null;
	offboxFrameTxPerSec: number | null;
	ratio: number | null;
	provisioned: boolean;
	stopBucket: OffboxBucket;
};

export function classifyOffbox(input: {
	summaries: readonly ArmSummary[];
	ccModes: readonly string[];
	rmemModes: readonly string[];
	cpuModes: readonly string[];
	sessions: number;
	provisioned: boolean;
}): OffboxCap {
	const onbox = input.summaries.filter((s) => !s.key.endsWith("@offbox"));
	const offbox = input.summaries.filter((s) => s.key.endsWith("@offbox"));
	const onboxFrameTxPerSec = medianFrameTx(onbox);
	const offboxFrameTxPerSec = medianFrameTx(offbox);
	const ratio =
		onboxFrameTxPerSec != null &&
		offboxFrameTxPerSec != null &&
		onboxFrameTxPerSec > 0
			? offboxFrameTxPerSec / onboxFrameTxPerSec
			: null;
	const onboxReproduced =
		onboxFrameTxPerSec != null &&
		onboxFrameTxPerSec >= SHARED_FRAME_TX_MIN &&
		onboxFrameTxPerSec <= SHARED_FRAME_TX_MAX;
	const allCubic = (arms: readonly ArmSummary[]): boolean =>
		arms.length > 0 &&
		arms.every((s) => s.runs.every((r) => r.appliedCongestion === "cubic"));
	const sessionsHealthy = (arms: readonly ArmSummary[]): boolean =>
		arms.every((s) =>
			s.runs.every((r) => r.sessionsOk >= 0.9 * input.sessions),
		);
	// The remote mark separates a real off-box run from a mislabeled local one.
	const remoteMarked =
		offbox.length > 0 &&
		offbox.every((s) => s.runs.every((r) => r.offboxSsh != null)) &&
		onbox.every((s) => s.runs.every((r) => r.offboxSsh == null));
	const mixedCc = input.ccModes.some((m) => m !== "cubic");
	const mixedRmem = input.rmemModes.some((m) => m !== "default");
	const mixedCpu = input.cpuModes.some((m) => m !== "shared");
	const incomplete =
		mixedCc ||
		mixedRmem ||
		mixedCpu ||
		!input.provisioned ||
		offbox.length === 0 ||
		onboxFrameTxPerSec == null ||
		offboxFrameTxPerSec == null ||
		offboxFrameTxPerSec === 0 ||
		!onboxReproduced ||
		!remoteMarked ||
		!allCubic(onbox) ||
		!allCubic(offbox) ||
		!sessionsHealthy(onbox) ||
		!sessionsHealthy(offbox) ||
		offboxFrameTxPerSec < SHARED_FRAME_TX_MIN ||
		(ratio != null &&
			ratio >= CORESPLIT_RATIO &&
			offboxFrameTxPerSec <= SHARED_FRAME_TX_MAX);
	let stopBucket: OffboxBucket = "incomplete";
	if (!incomplete && ratio != null && offboxFrameTxPerSec != null) {
		if (ratio >= CORESPLIT_RATIO && offboxFrameTxPerSec > SHARED_FRAME_TX_MAX) {
			stopBucket = "offbox-lifts";
		} else if (
			ratio < CORESPLIT_RATIO &&
			offboxFrameTxPerSec >= SHARED_FRAME_TX_MIN
		) {
			stopBucket = "not-offbox";
		}
	}
	return {
		onboxFrameTxPerSec,
		offboxFrameTxPerSec,
		ratio,
		provisioned: input.provisioned,
		stopBucket,
	};
}

export type OffboxBbrBucket =
	| "bbr-lifts"
	| "path-only"
	| "not-bbr"
	| "incomplete";

export type OffboxBbrCap = {
	cubicOffboxFrameTxPerSec: number | null;
	bbrOffboxFrameTxPerSec: number | null;
	ratio: number | null;
	provisioned: boolean;
	stopBucket: OffboxBbrBucket;
};

/** Cubic over the virtual switch framed ~64k; a control outside this band is
 * a different path regime, not a reproduction. */
const OFFBOX_CUBIC_MIN = 40_000;
const OFFBOX_CUBIC_MAX = 90_000;

export function classifyOffboxBbr(input: {
	summaries: readonly ArmSummary[];
	genModes: readonly string[];
	rmemModes: readonly string[];
	cpuModes: readonly string[];
	sessions: number;
	provisioned: boolean;
}): OffboxBbrCap {
	const cubicOff = input.summaries.filter(
		(s) => s.key.endsWith("@offbox") && !s.key.includes("@bbr"),
	);
	const bbrOff = input.summaries.filter(
		(s) => s.key.endsWith("@offbox") && s.key.includes("@bbr"),
	);
	const cubicOffboxFrameTxPerSec = medianFrameTx(cubicOff);
	const bbrOffboxFrameTxPerSec = medianFrameTx(bbrOff);
	const ratio =
		cubicOffboxFrameTxPerSec != null &&
		bbrOffboxFrameTxPerSec != null &&
		cubicOffboxFrameTxPerSec > 0
			? bbrOffboxFrameTxPerSec / cubicOffboxFrameTxPerSec
			: null;
	const controlReproduced =
		cubicOffboxFrameTxPerSec != null &&
		cubicOffboxFrameTxPerSec >= OFFBOX_CUBIC_MIN &&
		cubicOffboxFrameTxPerSec <= OFFBOX_CUBIC_MAX;
	const applied = (arms: readonly ArmSummary[], expected: string): boolean =>
		arms.length > 0 &&
		arms.every((s) => s.runs.every((r) => r.appliedCongestion === expected));
	const sessionsHealthy = (arms: readonly ArmSummary[]): boolean =>
		arms.every((s) =>
			s.runs.every((r) => r.sessionsOk >= 0.9 * input.sessions),
		);
	const remoteMarked = (arms: readonly ArmSummary[]): boolean =>
		arms.length > 0 &&
		arms.every((s) => s.runs.every((r) => r.offboxSsh != null));
	const mixedGen = input.genModes.some((m) => m !== "offbox");
	const mixedRmem = input.rmemModes.some((m) => m !== "default");
	const mixedCpu = input.cpuModes.some((m) => m !== "shared");
	const incomplete =
		mixedGen ||
		mixedRmem ||
		mixedCpu ||
		!input.provisioned ||
		bbrOff.length === 0 ||
		cubicOffboxFrameTxPerSec == null ||
		bbrOffboxFrameTxPerSec == null ||
		bbrOffboxFrameTxPerSec === 0 ||
		!controlReproduced ||
		!remoteMarked(cubicOff) ||
		!remoteMarked(bbrOff) ||
		!applied(cubicOff, "cubic") ||
		!applied(bbrOff, "bbr") ||
		!sessionsHealthy(cubicOff) ||
		!sessionsHealthy(bbrOff);
	let stopBucket: OffboxBbrBucket = "incomplete";
	if (!incomplete && ratio != null && bbrOffboxFrameTxPerSec != null) {
		if (ratio < CORESPLIT_RATIO) {
			stopBucket = "not-bbr";
		} else if (bbrOffboxFrameTxPerSec > SHARED_FRAME_TX_MAX) {
			stopBucket = "bbr-lifts";
		} else if (bbrOffboxFrameTxPerSec >= SHARED_FRAME_TX_MIN) {
			stopBucket = "path-only";
		}
	}
	return {
		cubicOffboxFrameTxPerSec,
		bbrOffboxFrameTxPerSec,
		ratio,
		provisioned: input.provisioned,
		stopBucket,
	};
}

async function main(): Promise<void> {
	if (!(await Bun.file(CLIENT_BIN).exists())) {
		console.error(`sweep: REFUSED\n  ${CLIENT_BIN} is missing`);
		process.exit(1);
	}
	const head = gitOutput(["rev-parse", "HEAD"]);
	const dirty = dirtyPaths(gitOutput(["status", "--porcelain"]));
	if (!head || dirty.length > 0) {
		console.error(
			`sweep: REFUSED\n  ${!head ? "git HEAD unreadable" : `dirty tree: ${dirty.slice(0, 5).join(", ")}`}`,
		);
		process.exit(1);
	}

	const capacity = {
		cpus: cpus().length,
		memoryMb: Math.round(totalmem() / 1024 / 1024),
		model: cpus()[0]?.model ?? "unknown",
	};
	console.log(
		`sweep: host cpus=${capacity.cpus} mem=${capacity.memoryMb}MB sessions=${SESSIONS} ` +
			`clients=${CLIENTS} workers=[${WORKERS.join(",")}] rates=[${RATES.join(",")}] ` +
			`cpuModes=[${CPU_MODES.join(",")}] ccModes=[${CC_MODES.join(",")}]`,
	);

	const offboxStamp = GEN_MODES.includes("offbox");
	const offboxBbrStamp =
		offboxStamp && !GEN_MODES.includes("onbox") && CC_MODES.includes("bbr");
	let offboxProvisioned = false;
	if (offboxStamp) {
		if (!OFFBOX_SSH || !OFFBOX_HOST) {
			console.error(
				"sweep: REFUSED\n  SWEEP_OFFBOX_SSH and SWEEP_OFFBOX_HOST are required for offbox arms",
			);
			process.exit(1);
		}
		const ping = spawnSync(
			"ssh",
			["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", OFFBOX_SSH, "true"],
			{ encoding: "utf8" },
		);
		const copy =
			ping.status === 0
				? spawnSync(
						"scp",
						[
							"-q",
							"-o",
							"BatchMode=yes",
							CLIENT_BIN,
							`${OFFBOX_SSH}:${OFFBOX_BIN}`,
						],
						{ encoding: "utf8" },
					)
				: null;
		const mark =
			copy?.status === 0
				? spawnSync(
						"ssh",
						["-o", "BatchMode=yes", OFFBOX_SSH, "chmod", "+x", OFFBOX_BIN],
						{ encoding: "utf8" },
					)
				: null;
		offboxProvisioned = mark?.status === 0;
		console.log(
			`sweep: offbox ssh=${OFFBOX_SSH} host=${OFFBOX_HOST} bin=${OFFBOX_BIN} ` +
				`provisioned=${offboxProvisioned}`,
		);
		if (!offboxProvisioned) {
			console.error(
				`sweep: REFUSED\n  offbox provisioning failed (${(ping.stderr || copy?.stderr || mark?.stderr || "").trim().slice(0, 300)})`,
			);
			process.exit(1);
		}
	}

	const siblingMap = readHostSiblingMap(capacity.cpus);
	const clientCpus = siblingMap ? pickDisjointPhysicalCpus(siblingMap) : null;
	const clientTaskset = clientCpus ? clientCpus.join(",") : "";
	console.log(
		`sweep: clientCpus=${clientCpus ? clientCpus.join(",") : "n/a"} ` +
			`taskset=${clientTaskset || "none"}`,
	);

	const arms = sweepArms();
	const rng = makeRng(Number(process.env.SWEEP_SEED ?? "20260816"));
	const runs: SweepRun[] = [];
	const order: string[] = [];
	// Interleave: a host that heats up part-way through must not hand the whole
	// penalty to whichever worker count happened to run last.
	const origRmemDefault = readSysctl("net.core.rmem_default");
	const origRmemMax = readSysctl("net.core.rmem_max");
	const raisedBytes = Math.max(origRmemDefault ?? 0, RMEM_RAISED_BYTES);
	let rmemDefaultWrote = true;
	console.log(
		`sweep: rmem_default=${origRmemDefault ?? "n/a"} rmem_max=${origRmemMax ?? "n/a"} ` +
			`raised=${raisedBytes} rmemModes=[${RMEM_MODES.join(",")}]`,
	);
	try {
		for (let round = 1; round <= REPS; round += 1) {
			for (const arm of shuffled(arms, rng)) {
				order.push(`r${round}:${armKey(arm)}`);
				console.log(`sweep: round ${round}/${REPS} ${armKey(arm)} ...`);
				if (arm.rmemMode === "raised") {
					const maxOk = writeSysctl(
						"net.core.rmem_max",
						Math.max(origRmemMax ?? raisedBytes, raisedBytes),
					);
					const defOk = writeSysctl("net.core.rmem_default", raisedBytes);
					rmemDefaultWrote = rmemDefaultWrote && maxOk && defOk;
				} else {
					if (origRmemMax != null)
						writeSysctl("net.core.rmem_max", origRmemMax);
					if (origRmemDefault != null) {
						writeSysctl("net.core.rmem_default", origRmemDefault);
					}
				}
				runs.push(
					await runOne(arm, round, BASE_PORT + runs.length, clientTaskset),
				);
			}
		}
	} finally {
		if (origRmemMax != null) writeSysctl("net.core.rmem_max", origRmemMax);
		if (origRmemDefault != null) {
			writeSysctl("net.core.rmem_default", origRmemDefault);
		}
	}

	const summaries = summarize(arms, runs);
	const generatorLimited = generatorLimitedRates(summaries);
	const collapse: Record<
		string,
		ReturnType<typeof collapseFor>
	> = Object.fromEntries(WORKERS.map((w) => [w, collapseFor(summaries, w)]));
	const waitVsDrop = classifyWaitVsDrop(summaries);
	const tasksetOk =
		spawnSync("taskset", ["-c", "0", "true"], { encoding: "utf8" }).status ===
		0;
	const coresplit = classifyCoresplit({
		summaries,
		nproc: capacity.cpus,
		tasksetOk,
		clientCpus,
	});
	const rmem = classifyRmem({
		summaries,
		rmemDefaultWrote,
		controlRmemDefault: origRmemDefault,
	});
	const cc = classifyCc({
		summaries,
		rmemModes: RMEM_MODES,
		cpuModes: CPU_MODES,
		sessions: SESSIONS,
	});
	const offbox = classifyOffbox({
		summaries,
		ccModes: CC_MODES,
		rmemModes: RMEM_MODES,
		cpuModes: CPU_MODES,
		sessions: SESSIONS,
		provisioned: offboxProvisioned,
	});
	const offboxBbr = classifyOffboxBbr({
		summaries,
		genModes: GEN_MODES,
		rmemModes: RMEM_MODES,
		cpuModes: CPU_MODES,
		sessions: SESSIONS,
		provisioned: offboxProvisioned,
	});
	const failures = [
		...proofFailures(summaries),
		...(gitOutput(["rev-parse", "HEAD"]) === head
			? []
			: ["HEAD moved mid-run"]),
	];

	// If the top rung never drove the server past its own peak, no rung tested
	// the hypothesis and "no collapse" would be an unearned negative.
	const topRung = Math.max(...RATES);
	const testedTheCliff = summaries.some(
		(s) => s.requestedPerSec === topRung && s.requestMet && s.droppedPct > 1,
	);

	const artifact = {
		version: 1,
		mode: "worker-load-sweep",
		kind: "probe",
		status: failures.length === 0 ? "ok" : "refused",
		generatedAtMs: Date.now(),
		head,
		bunVersion: Bun.version,
		platform: `${process.platform}/${process.arch}`,
		machine: process.env.BENCH_MACHINE_IDENTITY?.trim() || hostname(),
		command: COMMAND,
		capacity,
		design: {
			sessions: SESSIONS,
			clients: CLIENTS,
			workers: WORKERS,
			requestedRates: RATES,
			payloadBytes: PAYLOAD_BYTES,
			warmupSec: WARMUP_SEC,
			measureSec: MEASURE_SEC,
			reps: REPS,
			order,
			sendModes: SEND_MODES,
			cpuModes: CPU_MODES,
			rmemModes: RMEM_MODES,
			ccModes: CC_MODES,
			genModes: GEN_MODES,
			offboxSsh: OFFBOX_SSH || null,
			offboxHost: OFFBOX_HOST || null,
			offboxProvisioned,
			rmemDefault: origRmemDefault,
			rmemMax: origRmemMax,
			rmemRaised: raisedBytes,
		},
		arms: summaries,
		waitVsDrop,
		coresplit,
		rmem,
		cc,
		offbox,
		offboxBbr,
		generatorLimitedRates: generatorLimited,
		collapse,
		testedTheCliff,
		failures,
	};
	mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
	writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));

	console.log(
		`\n  ${"arm".padEnd(16)}${"requested".padStart(10)}${"offered".padStart(10)}` +
			`${"delivered".padStart(11)}${"ingested".padStart(10)}${"drop%".padStart(8)}` +
			`${"cores".padStart(7)}${"tokio".padStart(7)}${"js".padStart(6)}${"thr".padStart(5)}`,
	);
	for (const s of summaries) {
		console.log(
			`  ${s.key.padEnd(16)}${Math.round(s.requestedPerSec).toLocaleString().padStart(10)}` +
				`${Math.round(s.offeredPerSec).toLocaleString().padStart(10)}` +
				`${Math.round(s.deliveredPerSec).toLocaleString().padStart(11)}` +
				`${Math.round(s.ingestedPerSec).toLocaleString().padStart(10)}` +
				`${s.droppedPct.toFixed(1).padStart(8)}${s.processCores.toFixed(2).padStart(7)}` +
				`${s.tokioCores.toFixed(2).padStart(7)}${s.jsCores.toFixed(2).padStart(6)}` +
				`${String(s.datagramThreads).padStart(5)}${s.requestMet ? "" : "  (request not met)"}`,
		);
		for (const r of s.runs) {
			// Under the offbox stamp the older per-run STOP lines would invite
			// flipping on the wrong classifier; the offbox line is the stamp.
			if (r.gap && !offboxStamp)
				console.log(`  ${s.key} r${r.round} ${formatGapLine(r.gap)}`);
			if (r.pipeCap && !offboxStamp)
				console.log(`  ${s.key} r${r.round} ${formatPipeCapLine(r.pipeCap)}`);
			if (r.skRcvbuf != null) {
				console.log(
					`  ${s.key} r${r.round} sk: rcvbuf=${r.skRcvbuf} drops=${r.skDrops ?? "n/a"}`,
				);
			}
			if (r.appliedCongestion) {
				console.log(
					`  ${s.key} r${r.round} cc: applied=${r.appliedCongestion}`,
				);
			}
		}
	}
	const withDrops = summaries.filter((s) => s.droppedPct > 0.05);
	if (withDrops.length > 0) {
		console.log(
			`\n  ${"arm".padEnd(16)}${"tooLarge".padStart(10)}${"sessionQ".padStart(10)}${"globalQ".padStart(10)}${"dgramRL".padStart(10)}`,
		);
		for (const s of withDrops) {
			console.log(
				`  ${s.key.padEnd(16)}${Math.round(s.droppedTooLarge).toLocaleString().padStart(10)}` +
					`${Math.round(s.droppedQueueSession).toLocaleString().padStart(10)}` +
					`${Math.round(s.droppedQueueGlobal).toLocaleString().padStart(10)}` +
					`${Math.round(s.droppedRateLimited).toLocaleString().padStart(10)}`,
			);
		}
	}
	for (const w of WORKERS) {
		const c = collapse[w] ?? collapseFor(summaries, w);
		console.log(
			`\n  workers=${w}: peak ${Math.round(c.peakPerSec).toLocaleString()}/s at ` +
				`${Math.round(c.atPeakOffered).toLocaleString()}/s offered; beyond it worst is ` +
				`${Math.round(c.worstPerSec).toLocaleString()}/s at ${Math.round(c.worstOffered).toLocaleString()}/s — ` +
				`${c.collapsed ? "COLLAPSE" : "no collapse"}`,
		);
	}
	if (generatorLimited.length > 0) {
		console.log(
			`\n  GENERATOR-LIMITED rungs (offered pinned across worker counts, request unmet): ` +
				generatorLimited.map((r) => r.toLocaleString()).join(", "),
		);
	}
	if (!testedTheCliff) {
		console.log(
			"\n  NOT TESTED: no rung both met its requested load and pushed the server " +
				"into dropping. This host did not generate enough load to test the " +
				"hypothesis; a 'no collapse' reading here is unearned.",
		);
	}
	if (waitVsDrop.stopBucket !== "incomplete") {
		const n = (value: number | null): string =>
			value == null ? "n/a" : String(Math.round(value));
		console.log(
			`\n  wait-vs-drop: dropFrameTx=${n(waitVsDrop.dropFrameTxPerSec)} ` +
				`waitFrameTx=${n(waitVsDrop.waitFrameTxPerSec)} ` +
				`dropOffered=${n(waitVsDrop.dropOfferedPerSec)} ` +
				`waitOffered=${n(waitVsDrop.waitOfferedPerSec)} ` +
				`ratio=${waitVsDrop.ratio == null ? "n/a" : waitVsDrop.ratio.toFixed(2)} ` +
				`STOP=${waitVsDrop.stopBucket}`,
		);
	}
	if (CPU_MODES.includes("split")) {
		const n = (value: number | null): string =>
			value == null ? "n/a" : String(Math.round(value));
		console.log(
			`\n  coresplit: sharedFrameTx=${n(coresplit.sharedFrameTxPerSec)} ` +
				`splitFrameTx=${n(coresplit.splitFrameTxPerSec)} ` +
				`ratio=${coresplit.ratio == null ? "n/a" : coresplit.ratio.toFixed(2)} ` +
				`nproc=${coresplit.nproc} clientCpus=${coresplit.clientCpus?.join(",") ?? "n/a"} ` +
				`taskset=${coresplit.tasksetOk} ` +
				`affinity=${coresplit.affinityOk} htSiblings=${coresplit.htSiblings} ` +
				`STOP=${coresplit.stopBucket}`,
		);
	}
	if (RMEM_MODES.includes("raised")) {
		const n = (value: number | null): string =>
			value == null ? "n/a" : String(Math.round(value));
		console.log(
			`\n  rmem: defaultFrameTx=${n(rmem.defaultFrameTxPerSec)} ` +
				`raisedFrameTx=${n(rmem.raisedFrameTxPerSec)} ` +
				`ratio=${rmem.ratio == null ? "n/a" : rmem.ratio.toFixed(2)} ` +
				`defaultSk=${n(rmem.defaultSkRcvbuf)} raisedSk=${n(rmem.raisedSkRcvbuf)} ` +
				`wrote=${rmem.rmemDefaultWrote} STOP=${rmem.stopBucket}`,
		);
	}
	if (CC_MODES.includes("bbr") && !offboxBbrStamp) {
		const n = (value: number | null): string =>
			value == null ? "n/a" : String(Math.round(value));
		console.log(
			`\n  cc: cubicFrameTx=${n(cc.cubicFrameTxPerSec)} ` +
				`bbrFrameTx=${n(cc.bbrFrameTxPerSec)} ` +
				`ratio=${cc.ratio == null ? "n/a" : cc.ratio.toFixed(2)} ` +
				`STOP=${cc.stopBucket}`,
		);
	}
	if (offboxStamp && !offboxBbrStamp) {
		const n = (value: number | null): string =>
			value == null ? "n/a" : String(Math.round(value));
		console.log(
			`\n  offbox: onboxFrameTx=${n(offbox.onboxFrameTxPerSec)} ` +
				`offboxFrameTx=${n(offbox.offboxFrameTxPerSec)} ` +
				`ratio=${offbox.ratio == null ? "n/a" : offbox.ratio.toFixed(2)} ` +
				`provisioned=${offbox.provisioned} STOP=${offbox.stopBucket}`,
		);
	}
	if (offboxBbrStamp) {
		const n = (value: number | null): string =>
			value == null ? "n/a" : String(Math.round(value));
		console.log(
			`\n  offbox-bbr: cubicOffFrameTx=${n(offboxBbr.cubicOffboxFrameTxPerSec)} ` +
				`bbrOffFrameTx=${n(offboxBbr.bbrOffboxFrameTxPerSec)} ` +
				`ratio=${offboxBbr.ratio == null ? "n/a" : offboxBbr.ratio.toFixed(2)} ` +
				`provisioned=${offboxBbr.provisioned} STOP=${offboxBbr.stopBucket}`,
		);
	}
	if (failures.length > 0)
		console.log(`\nsweep: REFUSED\n  ${failures.join("\n  ")}`);
	console.log(`\nartifact: ${ARTIFACT_PATH}`);
	process.exit(failures.length === 0 ? 0 : 1);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("sweep: crashed", err);
		process.exit(1);
	});
}
