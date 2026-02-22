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
const CLIENT_BIN = `${ROOT}/target/release/load-client`;
const SESSIONS = parseInt(process.env.LOAD_SCALE_SESSIONS ?? "2000", 10);
const DURATION = parseInt(process.env.LOAD_SCALE_DURATION ?? "60", 10);
const DATAGRAMS_PER_SEC = 1000;
const STREAMS_PER_SEC = 5;

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

    console.log("load-scale-addon: Building load-client (release)...");
    await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();

    console.log("load-scale-addon: Starting addon server, sessions=", SESSIONS, "duration=", DURATION);
    const server = createServer({
        port: 4433,
        tls: { certPem: "", keyPem: "" },
        limits: { maxSessions: Math.min(SESSIONS + 500, 5000) },
        rateLimits: { handshakesBurst: Math.max(SESSIONS, 200) },
        onSession: () => {},
    });
    const initialFd = await getFdCount(process.pid);
    await Bun.sleep(8000);

    const maxQueuedBytesGlobal = DEFAULT_LIMITS.maxQueuedBytesGlobal;
    const pollIntervalMs = 5000;
    const poller = (async () => {
        for (let i = 0; i < Math.ceil((DURATION + 30) / (pollIntervalMs / 1000)); i++) {
            await Bun.sleep(pollIntervalMs);
            const m = server.metricsSnapshot();
            if (m.queuedBytesGlobal > maxQueuedBytesGlobal) {
                console.error("load-scale-addon: FAIL (queuedBytesGlobal", m.queuedBytesGlobal, "> max)");
                await server.close();
                process.exit(1);
            }
        }
    })();

    const client = Bun.spawn(
        [
            CLIENT_BIN,
            "--url", "https://127.0.0.1:4433",
            "--sessions", String(SESSIONS),
            "--duration", String(DURATION),
            "--datagrams-per-sec", String(DATAGRAMS_PER_SEC),
            "--streams-per-sec", String(STREAMS_PER_SEC),
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
        console.error("load-scale-addon: FAIL (load-client exited", result.code, ")");
        process.exit(1);
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
