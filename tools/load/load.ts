#!/usr/bin/env bun
/**
 * Short load test (CI). Pass: no errors, RSS ≤ 2×, metrics bounded, FD stable (Phase 4.3).
 */

import { $ } from "bun";
import { existsSync } from "node:fs";

// Low concurrency + stagger to reduce wtransport "close-cast" race (see docs/WTRANSPORT_UPSTREAM.md)
const DURATION = 20;
const SESSIONS = 4;
const DATAGRAMS_PER_SEC = 50;
const STREAMS_PER_SEC = 2;

const ROOT = process.cwd();
const SERVER_BIN = `${ROOT}/target/debug/reference-server`;
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;

// Phase 4.3.4: FD count from harness (proc on Linux, lsof on macOS)
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
        return out.trim().split("\n").length - 1; // header line
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
    console.log("load: Building reference server and load-client...");
    await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bins`.quiet();

    console.log("load: Starting reference server...");
    const server = Bun.spawn([SERVER_BIN], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
    });

    // Wait for health endpoint
    for (let i = 0; i < 30; i++) {
        try {
            const res = await fetch("http://127.0.0.1:4434");
            if (res.ok) break;
        } catch {
            await Bun.sleep(200);
        }
        if (i === 29) {
            server.kill();
            console.error("load: Server did not become ready");
            process.exit(1);
        }
    }

    // Sample server RSS for production gate (bounded memory)
    const getServerRss = async (): Promise<number> => {
        try {
            const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(server.pid)], {
                stdout: "pipe",
                stderr: "ignore",
            });
            const out = await new Response(proc.stdout).text();
            return parseInt(out.trim(), 10) || 0;
        } catch {
            return 0;
        }
    };
    const initialRss = await getServerRss();
    const initialFd = await getFdCount(server.pid!);
    console.log("load: Running load-client...");

    const stderrPath = process.env.CI ? `${ROOT}/tools/load/load-client-stderr.log` : null;

    // Phase 4.3.5: Poll metrics during test (every 2s)
    const POLL_INTERVAL_MS = 2000;
    const maxQueuedBytesGlobal = 512 * 1024 * 1024; // 512 MiB (AGENTS.md default)
    let metricsSamples: Array<{ t: number; m: Awaited<ReturnType<typeof getMetrics>> }> = [];
    const poller = (async () => {
        const start = Date.now();
        while (Date.now() - start < (DURATION + 5) * 1000) {
            const m = await getMetrics();
            metricsSamples.push({ t: Date.now(), m });
            if (m && m.queuedBytesGlobal > maxQueuedBytesGlobal) {
                console.error("load: FAIL (queuedBytesGlobal", m.queuedBytesGlobal, "> max", maxQueuedBytesGlobal, ")");
                server.kill();
                process.exit(1);
            }
            await Bun.sleep(POLL_INTERVAL_MS);
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
        {
            cwd: ROOT,
            stdout: "inherit",
            stderr: "pipe", // Always pipe to check no-panics gate
            env: { ...process.env, RUST_BACKTRACE: "1" },
        }
    );

    const TIMEOUT_MS = (DURATION + 30) * 1000;
    const exitOrTimeout = await Promise.race([
        client.exited.then((code) => ({ done: true as const, code })),
        Bun.sleep(TIMEOUT_MS).then(() => ({ done: false as const, code: -1 })),
    ]);
    if (!exitOrTimeout.done) {
        client.kill();
        console.error(`load: FAIL (load-client hung; timeout ${TIMEOUT_MS}ms)`);
        process.exit(1);
    }
    const exitCode = exitOrTimeout.code;

    let stderrText = "";
    if (client.stderr) {
        stderrText = await new Response(client.stderr).text();
        if (stderrPath) await Bun.write(stderrPath, stderrText);
    }

    // Phase 4.1: No panics ever (hard gate)
    if (stderrText && (stderrText.includes("panicked") || stderrText.includes("panic!"))) {
        console.error("load: FAIL (no panics gate: load-client panicked)");
        if (stderrPath) console.error("load: stderr saved to", stderrPath);
        server.kill();
        process.exit(1);
    }

    await poller;

    // Phase 4.3.5: Wait for quiescence (sessionsActive -> 0)
    for (let i = 0; i < 15; i++) {
        const m = await getMetrics();
        if (m && m.sessionsActive === 0 && m.streamsActive === 0) break;
        await Bun.sleep(500);
    }

    const finalMetrics = await getMetrics();
    const finalRss = await getServerRss();
    const finalFd = await getFdCount(server.pid!);
    server.kill();

    if (exitCode !== 0) {
        console.error("load: FAIL (load-client exited with", exitCode, ")");
        process.exit(1);
    }

    const rssGrowth = initialRss > 0 ? finalRss / initialRss : 1;
    if (initialRss > 0 && rssGrowth > 2) {
        console.error("load: FAIL (server RSS growth", rssGrowth.toFixed(2), "x exceeds 2x)");
        process.exit(1);
    }

    // Phase 4.3.4: FD count should not grow unbounded (allow 2x variance)
    if (initialFd > 0 && finalFd > initialFd * 2) {
        console.error("load: FAIL (FD count", initialFd, "->", finalFd, "exceeds 2x)");
        process.exit(1);
    }

    console.log("load: PASS", "(metrics:", finalMetrics ? `sessions=${finalMetrics.sessionsActive} streams=${finalMetrics.streamsActive}` : "n/a", ")");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
