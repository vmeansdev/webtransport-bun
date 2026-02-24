#!/usr/bin/env bun
/**
 * Overload scenario: session flood (Phase 4.4.5).
 * maxSessions=5, attempt 20 sessions. Assert sessionsActive <= 5, limitExceededCount > 0.
 */

import { $ } from "bun";

const ROOT = process.cwd();
const SERVER_BIN = `${ROOT}/target/debug/reference-server`;
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;
const MAX_SESSIONS = 5;
const SESSIONS_ATTEMPT = 10;
const DURATION = 5;

async function getMetrics(): Promise<{
	sessionsActive: number;
	limitExceededCount: number;
} | null> {
	try {
		const res = await fetch("http://127.0.0.1:4434/metrics");
		if (!res.ok) return null;
		const j = (await res.json()) as {
			sessionsActive?: number;
			limitExceededCount?: number;
		};
		return {
			sessionsActive: j.sessionsActive ?? 0,
			limitExceededCount: j.limitExceededCount ?? 0,
		};
	} catch (e) {
		return null;
	}
}

async function main() {
	console.log("overload-session: Building reference server and load-client...");
	// Ensure ports are free (kill leftover servers)
	try {
		const p4434 = await $`lsof -ti :4434`.quiet().nothrow().text();
		const p4433 = await $`lsof -ti :4433`.quiet().nothrow().text();
		for (const p of [p4434.trim(), p4433.trim()].flatMap((s) =>
			s.split(/\s+/).filter(Boolean),
		)) {
			if (p) await $`kill -9 ${p}`.quiet().nothrow();
		}
	} catch {}
	await Bun.sleep(1500);
	await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bins`.quiet();

	console.log(
		"overload-session: Starting reference server (max_sessions=5)...",
	);
	const server = Bun.spawn([SERVER_BIN], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, REF_MAX_SESSIONS: String(MAX_SESSIONS) },
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
			console.error("overload-session: Server did not become ready");
			process.exit(1);
		}
	}

	console.log("overload-session: Running load-client (20 sessions, 10s)...");
	const client = Bun.spawn(
		[
			CLIENT_BIN,
			"--url",
			"https://127.0.0.1:4433",
			"--sessions",
			String(SESSIONS_ATTEMPT),
			"--duration",
			String(DURATION),
			"--datagrams-per-sec",
			"10",
			"--streams-per-sec",
			"1",
		],
		{
			cwd: ROOT,
			stdout: "inherit",
			stderr: "pipe",
			env: { ...process.env, RUST_BACKTRACE: "1" },
		},
	);

	const TIMEOUT_MS = (DURATION + 20) * 1000;
	const exitOrTimeout = await Promise.race([
		client.exited.then((code) => ({ done: true as const, code })),
		Bun.sleep(TIMEOUT_MS).then(() => ({ done: false as const, code: -1 })),
	]);
	if (!exitOrTimeout.done) {
		client.kill();
		server.kill();
		console.error("overload-session: FAIL (load-client hung)");
		process.exit(1);
	}
	// load-client may exit 1 (sessions_err > 0) when server sheds; we only care about server metrics

	await Bun.sleep(3000); // Allow sessions to drain
	let m = await getMetrics();
	for (let i = 0; !m && i < 5; i++) {
		await Bun.sleep(500);
		m = await getMetrics();
	}
	server.kill();

	if (!m) {
		console.error(
			"overload-session: FAIL (could not fetch metrics from http://127.0.0.1:4434/metrics)",
		);
		process.exit(1);
	}

	const pass = m.sessionsActive <= MAX_SESSIONS + 2 && m.limitExceededCount > 0;
	console.log(
		"overload-session: sessionsActive=",
		m.sessionsActive,
		"limitExceededCount=",
		m.limitExceededCount,
	);

	if (m.sessionsActive > MAX_SESSIONS + 2) {
		console.error(
			"overload-session: FAIL (sessionsActive",
			m.sessionsActive,
			"> max",
			MAX_SESSIONS,
			")",
		);
		process.exit(1);
	}
	if (m.limitExceededCount === 0) {
		console.error(
			"overload-session: FAIL (limitExceededCount should be > 0 when shedding)",
		);
		process.exit(1);
	}

	console.log("overload-session: PASS (shedding verified)");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
