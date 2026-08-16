#!/usr/bin/env bun

/**
 * Control for the parallelism probe: the same quinn + wtransport receive path
 * with the addon, N-API and JS removed.
 *
 * The main probe found the addon's receive rate rises only 1.24x from one tokio
 * worker to ten (50.7k -> 62.8k datagrams/s) while server CPU rises 1.81x, and
 * that at ten workers the host still has six idle cores. Something serialises.
 * Two candidates survive: quinn's single endpoint driver reading one UDP
 * socket, and the single-threaded delivery hop into Bun's JS thread.
 *
 * crates/reference/src/recv_floor_server.rs is the second candidate deleted.
 * Run at the same offered load, its ceiling separates them:
 *
 *   - plateaus near the addon's ~62k  ->  the transport is the limit, and no
 *     amount of work on the delivery path can raise it
 *   - goes materially higher          ->  the delivery hop is the limit, and
 *     the transport had headroom the addon never reached
 *
 * Arms are interleaved and the tree must be clean, same rules as the main probe.
 *
 * Usage: bun tools/bench/native-recv-floor-control.ts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	dirtyPaths,
	makeRng,
	median,
	shuffled,
} from "./worker-thread-parallelism-probe.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const CLIENT_BIN = join(ROOT, "target", "release", "load-client");
const SERVER_BIN = join(ROOT, "target", "release", "recv-floor-server");
const COMMAND = "bun tools/bench/native-recv-floor-control.ts";

const SESSIONS = Number(process.env.WT_PROBE_SESSIONS ?? "150");
const AGGREGATE_PER_SEC = Number(process.env.WT_PROBE_AGGREGATE ?? "150000");
const PAYLOAD_BYTES = Number(process.env.WT_PROBE_PAYLOAD_BYTES ?? "1150");
const WARMUP_SEC = Number(process.env.WT_PROBE_WARMUP_SEC ?? "5");
const MEASURE_SEC = Number(process.env.WT_PROBE_MEASURE_SEC ?? "20");
const REPS = Number(process.env.WT_PROBE_REPS ?? "3");
const BASE_PORT = 49_110;
const BIND_WAIT_MS = 2_000;
/** Load-generator processes sharing the session count. */
const CLIENTS = Number(process.env.WT_PROBE_CLIENTS ?? "1");
const ARTIFACT_PATH = join(
	ROOT,
	".investigation",
	`native-recv-floor-control${CLIENTS > 1 ? `-c${CLIENTS}` : ""}.json`,
);
const ARMS = ["1", "auto"] as const;

type Run = {
	workers: string;
	round: number;
	receivedPerSec: number;
	offeredPerSec: number;
	received: number;
	windowMs: number;
	saturationRatio: number;
	serverCpuCores: number;
	configuredWorkers: number;
	datagramThreads: number;
	sessionsAccepted: number;
	clientSent: number;
	clientSendErrors: number;
	sessionsOk: number;
};

function gitOutput(args: string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

async function runOne(
	workers: string,
	round: number,
	port: number,
): Promise<Run> {
	const rate = Math.round(AGGREGATE_PER_SEC / SESSIONS);
	const server = Bun.spawn(
		[
			SERVER_BIN,
			"--port",
			String(port),
			"--workers",
			workers,
			"--warmup",
			String(WARMUP_SEC),
			"--measure",
			String(MEASURE_SEC),
		],
		{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
	);
	const serverStdout = new Response(server.stdout).text();
	const serverStderr = new Response(server.stderr).text();
	await Bun.sleep(BIND_WAIT_MS);

	// One load-client offers a stubbornly flat ~65k/s here regardless of what the
	// server does, which is close enough to the measured receive rate that the
	// generator itself is a candidate for the ceiling. Sharding the same session
	// count over several client processes tells the two apart.
	const perClientSessions = Math.floor(SESSIONS / CLIENTS);
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
				String(
					i === 0
						? SESSIONS - perClientSessions * (CLIENTS - 1)
						: perClientSessions,
				),
				"--duration",
				String(WARMUP_SEC + MEASURE_SEC),
				"--datagrams-per-sec",
				String(rate),
				"--streams-per-sec",
				"0",
				"--payload-bytes",
				String(PAYLOAD_BYTES),
				"--max-session-errors",
				String(SESSIONS),
				"--max-datagram-errors",
				"1000000000",
				"--max-stream-errors",
				"1000000000",
			],
			{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
		),
	);
	const clientOutputs = await Promise.all(
		clients.map(async (c) => {
			const text = await new Response(c.stdout).text();
			await c.exited;
			return text;
		}),
	);

	const out = await serverStdout;
	server.kill("SIGKILL");
	await server.exited;
	const line = out.split("\n").find((l) => l.startsWith("__SERVER_RESULT__"));
	if (!line) {
		throw new Error(
			`workers=${workers} round ${round}: server produced no result\n${(await serverStderr).slice(-1500)}`,
		);
	}
	const server_ = JSON.parse(line.slice("__SERVER_RESULT__".length));
	const num = (re: RegExp): number =>
		clientOutputs.reduce((total, text) => {
			const m = text.match(re);
			return total + (m?.[1] ? Number.parseInt(m[1], 10) : 0);
		}, 0);
	const clientSent = num(/datagrams sent=(\d+)/);
	const offeredPerSec = clientSent / (WARMUP_SEC + MEASURE_SEC);
	return {
		workers,
		round,
		receivedPerSec: server_.receivedPerSec,
		offeredPerSec,
		received: server_.received,
		windowMs: server_.windowMs,
		saturationRatio:
			offeredPerSec > 0 ? server_.receivedPerSec / offeredPerSec : 0,
		serverCpuCores: server_.serverCpuCores,
		configuredWorkers: server_.configuredWorkers,
		datagramThreads: server_.datagramThreads,
		sessionsAccepted: server_.sessionsAccepted,
		clientSent,
		clientSendErrors: num(/datagrams sent=\d+ err=(\d+)/),
		sessionsOk: num(/sessions ok=(\d+)/),
	};
}

async function main(): Promise<void> {
	for (const bin of [CLIENT_BIN, SERVER_BIN]) {
		if (!(await Bun.file(bin).exists())) {
			console.error(`control: REFUSED\n  ${bin} is missing`);
			process.exit(1);
		}
	}
	const head = gitOutput(["rev-parse", "HEAD"]);
	const dirty = dirtyPaths(gitOutput(["status", "--porcelain"]));
	if (!head || dirty.length > 0) {
		console.error(
			`control: REFUSED\n  ${!head ? "git HEAD unreadable" : `dirty tree: ${dirty.slice(0, 5).join(", ")}`}`,
		);
		process.exit(1);
	}

	const rng = makeRng(Number(process.env.WT_PROBE_SEED ?? "20260816"));
	const runs: Run[] = [];
	for (let round = 1; round <= REPS; round += 1) {
		for (const workers of shuffled(ARMS, rng)) {
			console.log(`control: round ${round}/${REPS} workers=${workers} ...`);
			runs.push(await runOne(workers, round, BASE_PORT + runs.length));
		}
	}

	const byArm = ARMS.map((workers) => {
		const armRuns = runs.filter((r) => r.workers === workers);
		return {
			workers,
			medianReceivedPerSec: median(armRuns.map((r) => r.receivedPerSec)),
			medianServerCpuCores: median(armRuns.map((r) => r.serverCpuCores)),
			maxSaturationRatio: Math.max(...armRuns.map((r) => r.saturationRatio)),
			minDatagramThreads: Math.min(...armRuns.map((r) => r.datagramThreads)),
			maxDatagramThreads: Math.max(...armRuns.map((r) => r.datagramThreads)),
			configuredWorkers: armRuns[0]?.configuredWorkers ?? null,
			runs: armRuns,
		};
	});

	const failures: string[] = [];
	for (const arm of byArm) {
		if (arm.configuredWorkers === null)
			failures.push(`workers=${arm.workers}: no result`);
		if ((arm.configuredWorkers ?? 0) > 1 && arm.maxDatagramThreads < 2) {
			failures.push(
				`workers=${arm.workers}: ${arm.configuredWorkers} workers configured but ` +
					"datagrams only ever landed on one OS thread",
			);
		}
	}
	for (const r of runs) {
		if (!Number.isFinite(r.receivedPerSec) || r.receivedPerSec <= 0) {
			failures.push(`workers=${r.workers} round ${r.round}: non-finite sample`);
		}
	}
	if (gitOutput(["rev-parse", "HEAD"]) !== head)
		failures.push("HEAD moved mid-run");

	const artifact = {
		version: 1,
		mode: "native-recv-floor-control",
		kind: "probe",
		status: failures.length === 0 ? "ok" : "refused",
		generatedAtMs: Date.now(),
		head,
		bunVersion: Bun.version,
		platform: `${process.platform}/${process.arch}`,
		machine: process.env.BENCH_MACHINE_IDENTITY?.trim() || hostname(),
		command: COMMAND,
		design: {
			sessions: SESSIONS,
			aggregateOfferedPerSec: AGGREGATE_PER_SEC,
			payloadBytes: PAYLOAD_BYTES,
			warmupSec: WARMUP_SEC,
			measureSec: MEASURE_SEC,
			reps: REPS,
			clients: CLIENTS,
			arms: [...ARMS],
		},
		arms: byArm,
		failures,
	};
	mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
	writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));

	console.log(
		`\n  NATIVE CONTROL (${SESSIONS} sessions over ${CLIENTS} client process(es), no addon / no N-API / no JS)`,
	);
	for (const arm of byArm) {
		console.log(
			`    workers=${arm.workers.padEnd(6)} ` +
				`${Math.round(arm.medianReceivedPerSec).toLocaleString().padStart(9)} recv/s  ` +
				`${arm.medianServerCpuCores.toFixed(2)} cores  ` +
				`sat ${arm.maxSaturationRatio.toFixed(3)}  ` +
				`dgram threads ${arm.minDatagramThreads}-${arm.maxDatagramThreads}`,
		);
	}
	if (failures.length > 0)
		console.log(`\ncontrol: REFUSED\n  ${failures.join("\n  ")}`);
	console.log(`\nartifact: ${ARTIFACT_PATH}`);
	process.exit(failures.length === 0 ? 0 : 1);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("control: crashed", err);
		process.exit(1);
	});
}
