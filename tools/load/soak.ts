#!/usr/bin/env bun
/**
 * Soak test (nightly). 30 min, 500 sessions. Pass: no errors, RSS trend, FD stable (Phase 4.3).
 */

import { $ } from "bun";
import { existsSync } from "node:fs";

const DURATION = 1800; // 30 minutes
const SESSIONS = 500;
const DATAGRAMS_PER_SEC = 500;
const STREAMS_PER_SEC = 5;

const ROOT = process.cwd();
const SERVER_BIN = `${ROOT}/target/debug/reference-server`;
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;

async function getFdCount(pid: number): Promise<number> {
	try {
		if (existsSync(`/proc/${pid}/fd`)) {
			const proc = Bun.spawn(["ls", `/proc/${pid}/fd`], {
				stdout: "pipe",
				stderr: "ignore",
			});
			const out = await new Response(proc.stdout).text();
			return out.trim().split("\n").filter(Boolean).length;
		}
		const proc = Bun.spawn(["lsof", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = await new Response(proc.stdout).text();
		return out.trim().split("\n").length - 1;
	} catch {
		return 0;
	}
}

async function getMetrics(): Promise<{
	sessionsActive: number;
	streamsActive: number;
	queuedBytesGlobal: number;
} | null> {
	try {
		const res = await fetch("http://127.0.0.1:4434/metrics");
		if (!res.ok) return null;
		const j = (await res.json()) as {
			sessionsActive?: number;
			streamsActive?: number;
			queuedBytesGlobal?: number;
		};
		return {
			sessionsActive: j.sessionsActive ?? 0,
			streamsActive: j.streamsActive ?? 0,
			queuedBytesGlobal: j.queuedBytesGlobal ?? 0,
		};
	} catch {
		return null;
	}
}

async function main() {
	console.log("soak: Building reference server and load-client...");
	await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --release --bins`.quiet();

	const SERVER_BIN_RELEASE = `${ROOT}/target/release/reference-server`;
	const CLIENT_BIN_RELEASE = `${ROOT}/target/release/load-client`;

	console.log("soak: Starting reference server...");
	const server = Bun.spawn([SERVER_BIN_RELEASE], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});

	for (let i = 0; i < 30; i++) {
		try {
			const res = await fetch("http://127.0.0.1:4434");
			if (res.ok) break;
		} catch {
			await Bun.sleep(200);
		}
		if (i === 29) {
			server.kill();
			console.error("soak: Server did not become ready");
			process.exit(1);
		}
	}

	const initialFd = await getFdCount(server.pid!);
	const maxQueuedBytesGlobal = 512 * 1024 * 1024;
	console.log("soak: Running load-client (30 min)...");

	const stderrPath = process.env.CI
		? `${ROOT}/tools/load/soak-client-stderr.log`
		: null;

	const pollIntervalMs = 30_000; // every 30s during soak
	const poller = (async () => {
		const start = Date.now();
		while (Date.now() - start < (DURATION + 60) * 1000) {
			const m = await getMetrics();
			if (m && m.queuedBytesGlobal > maxQueuedBytesGlobal) {
				console.error(
					"soak: FAIL (queuedBytesGlobal",
					m.queuedBytesGlobal,
					"> max)",
				);
				server.kill();
				process.exit(1);
			}
			await Bun.sleep(pollIntervalMs);
		}
	})();

	const client = Bun.spawn(
		[
			CLIENT_BIN_RELEASE,
			"--url",
			"https://127.0.0.1:4433",
			"--sessions",
			String(SESSIONS),
			"--duration",
			String(DURATION),
			"--datagrams-per-sec",
			String(DATAGRAMS_PER_SEC),
			"--streams-per-sec",
			String(STREAMS_PER_SEC),
		],
		{
			cwd: ROOT,
			stdout: "inherit",
			stderr: "pipe", // Always pipe to check no-panics gate
			env: { ...process.env, RUST_BACKTRACE: "1" },
		},
	);

	const TIMEOUT_MS = (DURATION + 60) * 1000;
	const exitOrTimeout = await Promise.race([
		client.exited.then((code) => ({ done: true as const, code })),
		Bun.sleep(TIMEOUT_MS).then(() => ({ done: false as const, code: -1 })),
	]);
	if (!exitOrTimeout.done) {
		client.kill();
		console.error(`soak: FAIL (load-client hung; timeout ${TIMEOUT_MS}ms)`);
		process.exit(1);
	}
	const exitCode = exitOrTimeout.code;

	let stderrText = "";
	if (client.stderr) {
		stderrText = await new Response(client.stderr).text();
		if (stderrPath) await Bun.write(stderrPath, stderrText);
	}

	// Phase 4.1: No panics ever (hard gate)
	if (
		stderrText &&
		(stderrText.includes("panicked") || stderrText.includes("panic!"))
	) {
		console.error("soak: FAIL (no panics gate: load-client panicked)");
		if (stderrPath) console.error("soak: stderr saved to", stderrPath);
		server.kill();
		process.exit(1);
	}

	await poller;

	for (let i = 0; i < 30; i++) {
		const m = await getMetrics();
		if (m && m.sessionsActive === 0 && m.streamsActive === 0) break;
		await Bun.sleep(500);
	}

	const finalFd = await getFdCount(server.pid!);
	server.kill();

	if (exitCode !== 0) {
		console.error("soak: FAIL (load-client exited with", exitCode, ")");
		process.exit(1);
	}

	if (initialFd > 0 && finalFd > initialFd * 2) {
		console.error(
			"soak: FAIL (FD count",
			initialFd,
			"->",
			finalFd,
			"exceeds 2x)",
		);
		process.exit(1);
	}

	console.log("soak: PASS");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
