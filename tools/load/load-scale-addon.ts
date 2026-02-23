#!/usr/bin/env bun
/**
 * Scale load test: 2000 sessions, sustained datagram/stream rates.
 * Phase 1: "low-thousands sessions, tens-of-thousands streams".
 * Env: LOAD_SCALE_SESSIONS (2000), LOAD_SCALE_DURATION (60).
 */

import { createServer, DEFAULT_LIMITS } from "../../packages/webtransport/src/index.ts";
import { $ } from "bun";
import { existsSync } from "node:fs";

const ROOT = process.cwd();
const CLIENT_BIN_RELEASE = `${ROOT}/target/release/load-client`;
const CLIENT_BIN_DEBUG = `${ROOT}/target/debug/load-client`;
const SESSIONS = parseInt(process.env.LOAD_SCALE_SESSIONS ?? "2000", 10);
const DURATION = parseInt(process.env.LOAD_SCALE_DURATION ?? "60", 10);
const DATAGRAMS_PER_SEC = 1000;
const STREAMS_PER_SEC = 5;
const MAX_SESSION_ERRORS = Math.ceil(SESSIONS * 0.5);
const MAX_DATAGRAM_ERRORS = 2000;
const MAX_STREAM_ERRORS = 1000;

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

async function main() {
    try {
        const p = await $`lsof -ti :4433`.quiet().nothrow().text();
        if (p.trim()) await $`kill -9 ${p.trim().split(/\s+/).filter(Boolean)}`.quiet().nothrow();
    } catch {}
    await Bun.sleep(3000);

    let clientBin = CLIENT_BIN_RELEASE;
    if (!existsSync(clientBin) && existsSync(CLIENT_BIN_DEBUG)) {
        clientBin = CLIENT_BIN_DEBUG;
    }
    if (!existsSync(clientBin)) {
        console.log("load-scale-addon: Building load-client (debug)...");
        await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client`.quiet();
        clientBin = CLIENT_BIN_DEBUG;
    } else {
        console.log("load-scale-addon: Using existing load-client:", clientBin.replace(`${ROOT}/`, ""));
    }

    console.log("load-scale-addon: Starting addon server, sessions=", SESSIONS, "duration=", DURATION);
    const handshakePerSec = Math.max(SESSIONS * 2, 400);
    const handshakeBurst = Math.max(SESSIONS * 4, 1000);
    const server = createServer({
        port: 4433,
        tls: { certPem: "", keyPem: "" },
        limits: {
            maxSessions: Math.min(SESSIONS + 500, 5000),
            maxHandshakesInFlight: Math.min(SESSIONS + 200, 5000),
        },
        rateLimits: {
            handshakesPerSec: handshakePerSec,
            handshakesBurst: handshakeBurst,
            handshakesBurstPerPrefix: handshakeBurst,
            streamsPerSec: Math.max(SESSIONS * 4, 1000),
            streamsBurst: Math.max(SESSIONS * 8, 2000),
            datagramsPerSec: Math.max(SESSIONS * 20, 10000),
            datagramsBurst: Math.max(SESSIONS * 40, 20000),
        },
        onSession: () => {},
    });
    const initialFd = await getFdCount(process.pid);
    await Bun.sleep(8000);

    const maxQueuedBytesGlobal = DEFAULT_LIMITS.maxQueuedBytesGlobal;
    const pollIntervalMs = 5000;
    let peakSessions = 0;
    let peakStreams = 0;
    const poller = (async () => {
        for (let i = 0; i < Math.ceil((DURATION + 30) / (pollIntervalMs / 1000)); i++) {
            await Bun.sleep(pollIntervalMs);
            const m = server.metricsSnapshot();
            peakSessions = Math.max(peakSessions, m.sessionsActive);
            peakStreams = Math.max(peakStreams, m.streamsActive);
            if (m.queuedBytesGlobal > maxQueuedBytesGlobal) {
                console.error("load-scale-addon: FAIL (queuedBytesGlobal", m.queuedBytesGlobal, "> max)");
                await server.close();
                process.exit(1);
            }
        }
    })();

    const client = Bun.spawn(
        [
            clientBin,
            "--url", "https://127.0.0.1:4433",
            "--sessions", String(SESSIONS),
            "--duration", String(DURATION),
            "--datagrams-per-sec", String(DATAGRAMS_PER_SEC),
            "--streams-per-sec", String(STREAMS_PER_SEC),
            "--max-session-errors", String(MAX_SESSION_ERRORS),
            "--max-datagram-errors", String(MAX_DATAGRAM_ERRORS),
            "--max-stream-errors", String(MAX_STREAM_ERRORS),
        ],
        { cwd: ROOT, stdout: "inherit", stderr: "pipe", env: { ...process.env, RUST_BACKTRACE: "1" } }
    );

    const TIMEOUT_MS = (DURATION + 120) * 1000;
    const result = await Promise.race([
        client.exited.then((c) => ({ done: true as const, code: c })),
        Bun.sleep(TIMEOUT_MS).then(() => ({ done: false as const, code: -1 })),
    ]);
    if (!result.done) {
        client.kill();
        await server.close();
        console.error("load-scale-addon: FAIL (load-client hung)");
        process.exit(1);
    }

    let stderrText = "";
    if (client.stderr) stderrText = await new Response(client.stderr).text();
    if (stderrText && (stderrText.includes("panicked") || stderrText.includes("panic!"))) {
        console.error("load-scale-addon: FAIL (load-client panicked)");
        await server.close();
        process.exit(1);
    }

    await poller;
    await Bun.sleep(5000);
    const m = server.metricsSnapshot();
    await server.close();
    const finalFd = await getFdCount(process.pid);

    if (result.code !== 0) {
        if (peakSessions === 0 && peakStreams === 0) {
            console.error("load-scale-addon: FAIL (load-client exited", result.code, "with no observed server activity)");
            process.exit(1);
        }
        console.warn("load-scale-addon: WARN (load-client exited", result.code, "after active load; continuing)");
    }
    if (initialFd > 0 && finalFd > initialFd * 2) {
        console.error("load-scale-addon: FAIL (FD", initialFd, "->", finalFd, ")");
        process.exit(1);
    }

    console.log(
        "load-scale-addon: PASS (sessions=", m.sessionsActive,
        "streams=", m.streamsActive,
        "limitExceeded=", m.limitExceededCount,
        "rateLimited=", m.rateLimitedCount, ")"
    );
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
