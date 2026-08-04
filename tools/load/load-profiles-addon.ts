#!/usr/bin/env bun
/**
 * P2.1: Load profile suite — handshake flood, stream-open flood, datagram flood, mixed.
 * P2.3-A: Contention profile — abusive burst with rate limits; compliant clients must progress.
 * Runs each profile against the addon server; all must pass.
 */

import { createServer } from "../../packages/webtransport/src/index.ts";
import type { ServerSession } from "../../packages/webtransport/src/index.ts";
import { $ } from "bun";
import { existsSync } from "node:fs";

/**
 * Consume everything the client floods at us. A no-op handler leaves incoming
 * streams unclaimed, so per-session active-stream limits fill up and the
 * server rejects the overflow with reset/stop_sending(0) — which the
 * load-client counts as stream errors. Use the native zero-copy discard path
 * (same one distributed-scale drains with): streams are consumed in Rust and
 * their guards release without a JS round-trip per stream, so the flood is
 * serviced at wire speed. Echo is deliberately absent — probe echo coverage
 * lives in load-addon/load-scale, and the client runs with --skip-probes.
 */
const DRAIN_TIMEOUT_MS = 120_000;
type DiscardFn = (timeoutMs?: number) => Promise<number | null | undefined>;
type DiscardingSession = ServerSession & {
	discardIncomingDatagrams?: DiscardFn;
	discardIncomingBidiStreams?: DiscardFn;
	discardIncomingUniStreams?: DiscardFn;
};
function drainSession(session: ServerSession): void {
	const s = session as DiscardingSession;
	void s.discardIncomingDatagrams?.(DRAIN_TIMEOUT_MS).catch(() => {});
	void s.discardIncomingBidiStreams?.(DRAIN_TIMEOUT_MS).catch(() => {});
	void s.discardIncomingUniStreams?.(DRAIN_TIMEOUT_MS).catch(() => {});
}

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;

async function killPort4433(): Promise<void> {
	try {
		const p = await $`lsof -ti :4433`.quiet().nothrow().text();
		if (p.trim())
			await $`kill -9 ${p.trim().split(/\s+/).filter(Boolean)}`
				.quiet()
				.nothrow();
	} catch (err) {
		console.warn("load-profiles-addon: port cleanup failed:", err);
	}
	await Bun.sleep(2000);
}

async function runProfile(
	name: string,
	sessions: number,
	duration: number,
	datagramsPerSec: number,
	streamsPerSec: number,
	maxSessionErrors: number,
	rateLimits?: {
		handshakesBurst?: number;
		handshakesPerSec?: number;
		streamsPerSec?: number;
		streamsBurst?: number;
	},
): Promise<{ pass: boolean; msg: string }> {
	await killPort4433();

	const server = createServer({
		port: 4433,
		tls: { certPem: "", keyPem: "" },
		limits: { maxSessions: Math.min(sessions + 50, 5000) },
		rateLimits: rateLimits ?? undefined,
		onSession: drainSession,
	});
	await Bun.sleep(5000);

	const client = Bun.spawn(
		[
			CLIENT_BIN,
			"--url",
			"https://127.0.0.1:4433",
			"--sessions",
			String(sessions),
			"--duration",
			String(duration),
			"--datagrams-per-sec",
			String(datagramsPerSec),
			"--streams-per-sec",
			String(streamsPerSec),
			"--max-session-errors",
			String(maxSessionErrors),
			// Profiles measure flood robustness against a non-echoing server;
			// the per-session probe suite requires the echo protocol (covered by
			// load-addon and load-scale) and would fail every session here.
			"--skip-probes",
		],
		{
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, RUST_BACKTRACE: "1" },
		},
	);

	const exitCode = await client.exited;
	const stderr = client.stderr ? await new Response(client.stderr).text() : "";
	await server.close();
	await Bun.sleep(3000);

	if (stderr && (stderr.includes("panicked") || stderr.includes("panic!"))) {
		return { pass: false, msg: "load-client panicked" };
	}
	if (exitCode !== 0) {
		return { pass: false, msg: `load-client exited ${exitCode}` };
	}
	return { pass: true, msg: "PASS" };
}

async function main() {
	if (!existsSync(CLIENT_BIN)) {
		console.log("load-profiles-addon: Building load-client...");
		await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client`.quiet();
	}

	const profiles: Array<{
		name: string;
		sessions: number;
		duration: number;
		dg: number;
		st: number;
		maxErr: number;
		rateLimits?: {
			handshakesBurst?: number;
			handshakesPerSec?: number;
			streamsPerSec?: number;
			streamsBurst?: number;
		};
	}> = [
		{
			name: "handshake flood",
			sessions: 20,
			duration: 5,
			dg: 1,
			st: 1,
			maxErr: 5,
		},
		{
			name: "stream-open flood",
			sessions: 8,
			duration: 10,
			dg: 5,
			st: 50,
			maxErr: 0,
			// All 8 sessions share 127.0.0.1, so the default per-peer limiter
			// (200 streams/s, burst 400) would shed ~half of the 400/s flood by
			// design. Raise the limiter for this profile so maxErr=0 asserts the
			// data path services the full flood; limiter-shedding semantics are
			// covered by the contention profile.
			rateLimits: { streamsPerSec: 600, streamsBurst: 1200 },
		},
		{
			name: "datagram flood",
			sessions: 8,
			duration: 10,
			dg: 500,
			st: 2,
			maxErr: 0,
		},
		{
			name: "mixed realistic",
			sessions: 6,
			duration: 12,
			dg: 80,
			st: 8,
			maxErr: 0,
		},
		{
			name: "contention (P2.3-A)",
			sessions: 12,
			duration: 8,
			dg: 60,
			st: 15,
			maxErr: 8,
			rateLimits: { handshakesBurst: 4, handshakesPerSec: 10 },
		},
	];

	let failed = 0;
	for (const p of profiles) {
		process.stdout.write(`load-profiles-addon: ${p.name}... `);
		const r = await runProfile(
			p.name,
			p.sessions,
			p.duration,
			p.dg,
			p.st,
			p.maxErr,
			p.rateLimits,
		);
		if (r.pass) {
			console.log(r.msg);
		} else {
			console.log("FAIL (" + r.msg + ")");
			failed++;
		}
	}

	if (failed > 0) {
		console.error("load-profiles-addon: " + failed + " profile(s) failed");
		process.exit(1);
	}
	console.log("load-profiles-addon: all profiles PASS");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
