#!/usr/bin/env bun
/**
 * Load test targeting the addon server (createServer), not the reference server.
 * Polls addon metricsSnapshot() — Phase 4.3.5 / INSTRUCTIONS Phase E.
 */

import { createServer, DEFAULT_LIMITS } from "../../packages/webtransport/src/index.ts";
import { $ } from "bun";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const RSS_TREND_OUT = process.env.RSS_TREND_OUT ?? join(ROOT, "tools/load/rss-trend.json");

function getRssMb(): number {
    try {
        return (process.memoryUsage?.()?.rss ?? 0) / (1024 * 1024);
    } catch {
        return 0;
    }
}
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;
const DURATION = 15;
const SESSIONS = 4;
const DATAGRAMS_PER_SEC = 30;
const STREAMS_PER_SEC = 2;

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
    // Ensure port 4433 is free
    try {
        const p = await $`lsof -ti :4433`.quiet().nothrow().text();
        if (p.trim()) await $`kill -9 ${p.trim().split(/\s+/).filter(Boolean)}`.quiet().nothrow();
    } catch {}
    await Bun.sleep(1000);

    console.log("load-addon: Building load-client...");
    await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client`.quiet();

    console.log("load-addon: Starting addon server (createServer)...");
    const server = createServer({
        port: 4433,
        tls: { certPem: "", keyPem: "" },
        onSession: () => {},
    });
    const initialFd = await getFdCount(process.pid);
    await Bun.sleep(8000); // Allow addon server to bind (Tokio + wtransport startup)

    const maxQueuedBytesGlobal = DEFAULT_LIMITS.maxQueuedBytesGlobal;
    const pollIntervalMs = 2000;
    const rssSamples: { ts_ms: number; rss_mb: number; sessions: number; streams: number }[] = [];
    let lastMetrics = server.metricsSnapshot();
    const poller = (async () => {
        for (let i = 0; i < Math.ceil((DURATION + 10) / (pollIntervalMs / 1000)); i++) {
            await Bun.sleep(pollIntervalMs);
            const m = server.metricsSnapshot();
            lastMetrics = m;
            rssSamples.push({
                ts_ms: Date.now(),
                rss_mb: getRssMb(),
                sessions: m.sessionsActive,
                streams: m.streamsActive,
            });
            if (m.queuedBytesGlobal > maxQueuedBytesGlobal) {
                console.error("load-addon: FAIL (queuedBytesGlobal", m.queuedBytesGlobal, "> max)");
                await server.close();
                process.exit(1);
            }
        }
    })();

    console.log("load-addon: Running load-client...");
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
            stderr: "pipe",
            env: { ...process.env, RUST_BACKTRACE: "1" },
        }
    );

    const exitCode = await client.exited;
    await poller;

    let stderrText = "";
    if (client.stderr) {
        stderrText = await new Response(client.stderr).text();
    }
    if (stderrText && (stderrText.includes("panicked") || stderrText.includes("panic!"))) {
        console.error("load-addon: FAIL (no panics gate: load-client panicked)");
        await server.close();
        process.exit(1);
    }

    await Bun.sleep(3000);
    const m = server.metricsSnapshot();
    await server.close();
    const finalFd = await getFdCount(process.pid);

    // Leak checks: task gauges and queued bytes return to baseline
    if (m.sessionTasksActive > 10 || m.streamTasksActive > 10) {
        console.error("load-addon: FAIL (task gauges high:", m.sessionTasksActive, m.streamTasksActive, ")");
        process.exit(1);
    }
    if (m.queuedBytesGlobal > 128 * 1024) {
        console.error("load-addon: FAIL (queuedBytesGlobal not baseline:", m.queuedBytesGlobal, ")");
        process.exit(1);
    }

    if (exitCode !== 0) {
        console.error("load-addon: FAIL (load-client exited with", exitCode, ")");
        process.exit(1);
    }

    if (initialFd > 0 && finalFd > initialFd * 2) {
        console.error("load-addon: FAIL (FD count", initialFd, "->", finalFd, "exceeds 2x)");
        process.exit(1);
    }

    if (rssSamples.length > 0) {
        writeFileSync(RSS_TREND_OUT, JSON.stringify(rssSamples, null, 0));
        const csv = ["ts_ms,rss_mb,sessions,streams", ...rssSamples.map((s) => `${s.ts_ms},${s.rss_mb.toFixed(2)},${s.sessions},${s.streams}`)].join("\n");
        writeFileSync(RSS_TREND_OUT.replace(/\.json$/, ".csv"), csv);
        console.log("load-addon: RSS trend written to", RSS_TREND_OUT);
    }
    console.log("load-addon: PASS", "(metrics: sessions=", m.sessionsActive, "streams=", m.streamsActive, ")");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
