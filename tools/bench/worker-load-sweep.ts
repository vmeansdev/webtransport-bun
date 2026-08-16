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
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, hostname, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";

import { classify, threadRows } from "./thread-profile.ts";
import {
	dirtyPaths,
	makeRng,
	median,
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
};

export function sweepArms(): SweepArm[] {
	const arms: SweepArm[] = [];
	for (const workers of WORKERS) {
		for (const requestedPerSec of RATES) {
			arms.push({
				workers,
				requestedPerSec,
				ratePerSession: Math.max(1, Math.round(requestedPerSec / SESSIONS)),
			});
		}
	}
	return arms;
}

export const armKey = (a: {
	workers: string;
	requestedPerSec: number;
}): string => `w${a.workers}@${a.requestedPerSec}`;

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
	skippedQueueFull?: number;
	processCores: number;
	tokioCores: number;
	jsCores: number;
	datagramThreads: number;
	configuredWorkers: number | null;
	sessionsOk: number;
	clientSendErrors: number;
	threads: { label: string; cores: number; datagrams: number }[];
};

function gitOutput(args: string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

async function runOne(
	arm: SweepArm,
	round: number,
	port: number,
): Promise<SweepRun> {
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
				WT_PROBE_CLIENTS: String(CLIENTS),
				WT_PROBE_WARMUP_SEC: String(WARMUP_SEC),
				WT_PROBE_MEASURE_SEC: String(MEASURE_SEC),
				WT_PROBE_PAYLOAD_BYTES: String(PAYLOAD_BYTES),
				WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
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
			...(typeof run.drops?.datagramsSkippedQueueFull === "number"
				? { skippedQueueFull: run.drops.datagramsSkippedQueueFull }
				: {}),
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
	skippedQueueFull?: number;
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
			...(mine.some((r) => typeof r.skippedQueueFull === "number")
				? {
						skippedQueueFull: med((r) => r.skippedQueueFull ?? Number.NaN),
					}
				: {}),
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
			`clients=${CLIENTS} workers=[${WORKERS.join(",")}] rates=[${RATES.join(",")}]`,
	);

	const arms = sweepArms();
	const rng = makeRng(Number(process.env.SWEEP_SEED ?? "20260816"));
	const runs: SweepRun[] = [];
	const order: string[] = [];
	// Interleave: a host that heats up part-way through must not hand the whole
	// penalty to whichever worker count happened to run last.
	for (let round = 1; round <= REPS; round += 1) {
		for (const arm of shuffled(arms, rng)) {
			order.push(`r${round}:${armKey(arm)}`);
			console.log(`sweep: round ${round}/${REPS} ${armKey(arm)} ...`);
			runs.push(await runOne(arm, round, BASE_PORT + runs.length));
		}
	}

	const summaries = summarize(arms, runs);
	const generatorLimited = generatorLimitedRates(summaries);
	const collapse: Record<
		string,
		ReturnType<typeof collapseFor>
	> = Object.fromEntries(WORKERS.map((w) => [w, collapseFor(summaries, w)]));
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
		},
		arms: summaries,
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
	const withSkips = summaries.filter(
		(s) => typeof s.skippedQueueFull === "number",
	);
	if (withSkips.length > 0) {
		console.log(`\n  ${"arm".padEnd(16)}${"skipPark".padStart(12)}`);
		for (const s of withSkips) {
			console.log(
				`  ${s.key.padEnd(16)}${Math.round(s.skippedQueueFull ?? Number.NaN).toLocaleString().padStart(12)}`,
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
