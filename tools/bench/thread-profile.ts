#!/usr/bin/env bun

/**
 * Which thread is actually pinned?
 *
 * The process burns ~2.1 cores with one tokio worker, and only two threads can
 * be doing the work: the single `wt-server` worker and Bun's JS thread. If the
 * JS thread is the saturated one, no number of tokio workers can help. Nothing
 * measured so far distinguishes them — `process.cpuUsage()` is process-wide and
 * `performance.eventLoopUtilization()` is a stub returning zeroes under Bun.
 *
 * So each thread reports its own `CLOCK_THREAD_CPUTIME_ID`: the tokio workers
 * from the datagram path, the JS thread from the N-API getter, which by
 * definition runs on it. The per-thread figures are deltas over the same window
 * as the throughput, and the residual against `process.cpuUsage()` is reported
 * rather than hidden — it is every thread that never touched either path.
 *
 * The same run answers two more questions. With
 * WEBTRANSPORT_WORKER_PROBE_TIMING=1 it attributes time spent inside the
 * datagram rate limiter, whose bucket mutex is keyed by peer IP and therefore
 * shared by every session on loopback. And it captures `sample(1)` output so
 * the endpoint driver's recv syscall can be read off a live stack — `recvmsg`
 * means quinn-udp resolved BATCH_SIZE to 1, `recvmsg_x` means the batched
 * Apple datapath.
 *
 * Usage: bun tools/bench/thread-profile.ts [--workers N] [--clients N]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const ARTIFACT_PATH = join(ROOT, ".investigation", "thread-profile.json");
const PROBE = join("tools", "bench", "worker-thread-parallelism-probe.ts");

const SESSIONS = Number(process.env.WT_PROBE_SESSIONS ?? "150");
const AGGREGATE_PER_SEC = Number(process.env.WT_PROBE_AGGREGATE ?? "150000");
const WARMUP_SEC = Number(process.env.WT_PROBE_WARMUP_SEC ?? "5");
const MEASURE_SEC = Number(process.env.WT_PROBE_MEASURE_SEC ?? "20");
const BASE_PORT = 49_610;

/** Every combination worth profiling: the two worker counts either side of the
 * cliff, at both the under-loaded and the properly-loaded generator. */
const CASES = [
	{ workers: "1", clients: 1 },
	{ workers: "1", clients: 3 },
	{ workers: "2", clients: 3 },
	{ workers: "auto", clients: 3 },
];

export type ThreadRow = {
	label: string;
	datagrams: number;
	cores: number;
	rateLimitCores: number;
	rateLimitCalls: number;
};

/**
 * Per-thread CPU as a fraction of one core, from the probe's before/after
 * snapshots. A thread with no CPU delta is dropped: registered-but-idle threads
 * are noise in a table whose question is which thread is hot.
 */
export function threadRows(
	before: Record<string, number>,
	after: Record<string, number>,
	windowMs: number,
): ThreadRow[] {
	const labels = new Set(
		Object.keys(after)
			.filter((k) => k.startsWith("cpuNanos:"))
			.map((k) => k.slice("cpuNanos:".length)),
	);
	const delta = (prefix: string, label: string): number =>
		(after[`${prefix}:${label}`] ?? 0) - (before[`${prefix}:${label}`] ?? 0);
	return [...labels]
		.map((label) => ({
			label,
			datagrams: delta("thread", label),
			cores: delta("cpuNanos", label) / 1e6 / windowMs,
			rateLimitCores: delta("rateLimitNanos", label) / 1e6 / windowMs,
			rateLimitCalls: delta("rateLimitCalls", label),
		}))
		.filter((row) => row.cores > 0.001 || row.datagrams > 0)
		.sort((a, b) => b.cores - a.cores);
}

/** A thread that never polls datagrams but does burn CPU is the JS thread. */
export function classify(row: ThreadRow): "tokio-worker" | "js-thread" {
	return row.datagrams > 0 || row.label.startsWith("wt-server")
		? "tokio-worker"
		: "js-thread";
}

function gitOutput(args: string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

/**
 * The recv syscall the endpoint driver is sitting in, read off a live stack.
 *
 * `cargo tree` already shows `fast-apple-datapath` is not enabled, which makes
 * quinn-udp's BATCH_SIZE 1 on this platform. This confirms that against the
 * running process instead of against the manifest.
 */
function sampleRecvSyscall(pid: number): {
	recvmsg: boolean;
	recvmsgX: boolean;
	error: string | null;
} {
	const out = spawnSync("sample", [String(pid), "2", "-mayDie"], {
		encoding: "utf8",
		timeout: 60_000,
	});
	if (out.status !== 0 || !out.stdout) {
		return {
			recvmsg: false,
			recvmsgX: false,
			error: out.stderr?.slice(0, 300) ?? "sample failed",
		};
	}
	return {
		recvmsg: /\b__recvmsg\b|\brecvmsg\b/.test(out.stdout),
		recvmsgX: /recvmsg_x/.test(out.stdout),
		error: null,
	};
}

async function profileOne(
	workers: string,
	clients: number,
	port: number,
): Promise<Record<string, unknown>> {
	const child = Bun.spawn(
		[
			"bun",
			PROBE,
			"--child",
			"--label",
			`profile-workers=${workers}-clients=${clients}`,
			"--port",
			String(port),
			"--round",
			"1",
			"--sessions",
			String(SESSIONS),
			"--rate",
			String(Math.round(AGGREGATE_PER_SEC / SESSIONS)),
		],
		{
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...(process.env as Record<string, string>),
				WEBTRANSPORT_SERVER_WORKER_THREADS: workers,
				WEBTRANSPORT_WORKER_PROBE_TIMING: "1",
				WT_PROBE_CLIENTS: String(clients),
				WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
			},
		},
	);
	const stdoutPromise = new Response(child.stdout).text();
	const stderrPromise = new Response(child.stderr).text();

	// Land the stack sample in the middle of the measured window, once the
	// handshakes have settled and the server is in steady state.
	await Bun.sleep((WARMUP_SEC + MEASURE_SEC / 2) * 1_000);
	const syscall = sampleRecvSyscall(child.pid);

	const stdout = await stdoutPromise;
	const exitCode = await child.exited;
	const line = stdout.split("\n").find((l) => l.startsWith("__ARM_RESULT__"));
	if (exitCode !== 0 || !line) {
		throw new Error(
			`workers=${workers} clients=${clients} failed (exit ${exitCode}): ${(await stderrPromise).slice(-1200)}`,
		);
	}
	const run = JSON.parse(line.slice("__ARM_RESULT__".length));
	const rows = threadRows(
		run.workerProof.cpuBefore ?? {},
		run.workerProof.cpuAfter ?? {},
		run.windowMs,
	);
	const tokioCores = rows
		.filter((r) => classify(r) === "tokio-worker")
		.reduce((a, r) => a + r.cores, 0);
	const jsCores = rows
		.filter((r) => classify(r) === "js-thread")
		.reduce((a, r) => a + r.cores, 0);
	return {
		workers,
		clients,
		receivedPerSec: run.receivedPerSec,
		offeredPerSec: run.offeredPerSec,
		processCores: run.serverCpuCores,
		tokioCores,
		jsCores,
		// Threads that touched neither path: Bun's GC and IO helpers, quinn's
		// timers on a runtime thread that never polled a datagram, and so on.
		unattributedCores: run.serverCpuCores - tokioCores - jsCores,
		rateLimitCores: rows.reduce((a, r) => a + r.rateLimitCores, 0),
		rateLimitCalls: rows.reduce((a, r) => a + r.rateLimitCalls, 0),
		threads: rows,
		recvSyscall: syscall,
	};
}

async function main(): Promise<void> {
	const head = gitOutput(["rev-parse", "HEAD"]);
	const results: Record<string, unknown>[] = [];
	for (const [i, c] of CASES.entries()) {
		console.log(`profile: workers=${c.workers} clients=${c.clients} ...`);
		results.push(await profileOne(c.workers, c.clients, BASE_PORT + i));
	}

	const artifact = {
		version: 1,
		mode: "thread-profile",
		kind: "probe",
		generatedAtMs: Date.now(),
		head,
		bunVersion: Bun.version,
		platform: `${process.platform}/${process.arch}`,
		machine: process.env.BENCH_MACHINE_IDENTITY?.trim() || hostname(),
		design: {
			sessions: SESSIONS,
			aggregateOfferedPerSec: AGGREGATE_PER_SEC,
			warmupSec: WARMUP_SEC,
			measureSec: MEASURE_SEC,
		},
		cases: results,
	};
	mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
	writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));

	for (const r of results as Record<
		string,
		number | string | ThreadRow[] | Record<string, unknown>
	>[]) {
		console.log(
			`\n  workers=${r.workers} clients=${r.clients}: ` +
				`${Math.round(r.receivedPerSec as number).toLocaleString()} recv/s, ` +
				`process ${(r.processCores as number).toFixed(2)} cores`,
		);
		console.log(
			`    tokio ${(r.tokioCores as number).toFixed(2)}  js ${(r.jsCores as number).toFixed(2)}  ` +
				`unattributed ${(r.unattributedCores as number).toFixed(2)}  ` +
				`rate-limit ${(r.rateLimitCores as number).toFixed(3)} cores over ${(r.rateLimitCalls as number).toLocaleString()} calls`,
		);
		for (const t of r.threads as ThreadRow[]) {
			console.log(
				`      ${classify(t).padEnd(13)} ${t.label.padEnd(28)} ` +
					`${t.cores.toFixed(3)} cores  ${t.datagrams.toLocaleString()} dgrams  ` +
					`rl ${t.rateLimitCores.toFixed(3)}`,
			);
		}
		const s = r.recvSyscall as {
			recvmsg: boolean;
			recvmsgX: boolean;
			error: string | null;
		};
		console.log(
			`    recv syscall: recvmsg=${s.recvmsg} recvmsg_x=${s.recvmsgX}${s.error ? ` (${s.error})` : ""}`,
		);
	}
	console.log(`\nartifact: ${ARTIFACT_PATH}`);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("profile: crashed", err);
		process.exit(1);
	});
}
