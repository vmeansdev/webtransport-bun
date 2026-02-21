#!/usr/bin/env bun
/**
 * Soak test targeting addon server (createServer). Phase 9.
 * Duration via SOAK_DURATION env (default 1800 = 30 min). Use SOAK_DURATION=86400 for 24h.
 */

import { createServer, DEFAULT_LIMITS } from "../../packages/webtransport/src/index.ts";
import { $ } from "bun";
import { existsSync } from "node:fs";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;
const DURATION = parseInt(process.env.SOAK_DURATION ?? "1800", 10); // 30 min default
const SESSIONS = 500;
const DATAGRAMS_PER_SEC = 500;
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

    console.log("soak-addon: Building load-client (release)...");
    await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();

    console.log("soak-addon: Starting addon server, duration", DURATION, "s");
    const server = createServer({
        port: 4433,
        tls: { certPem: "", keyPem: "" },
        onSession: () => {},
    });
    const initialFd = await getFdCount(process.pid);
    await Bun.sleep(8000);

    const maxQueuedBytesGlobal = DEFAULT_LIMITS.maxQueuedBytesGlobal;
    const pollIntervalMs = 30_000;
    const poller = (async () => {
        const start = Date.now();
        while (Date.now() - start < (DURATION + 60) * 1000) {
            const m = server.metricsSnapshot();
            if (m.queuedBytesGlobal > maxQueuedBytesGlobal) {
                console.error("soak-addon: FAIL (queuedBytesGlobal", m.queuedBytesGlobal, "> max)");
                await server.close();
                process.exit(1);
            }
            await Bun.sleep(pollIntervalMs);
        }
    })();

    const stderrPath = process.env.CI ? `${ROOT}/tools/load/soak-addon-client-stderr.log` : null;
    console.log("soak-addon: Running load-client...");
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

    const TIMEOUT_MS = (DURATION + 60) * 1000;
    const result = await Promise.race([
        client.exited.then((c) => ({ done: true as const, code: c })),
        Bun.sleep(TIMEOUT_MS).then(() => ({ done: false as const, code: -1 })),
    ]);
    if (!result.done) {
        client.kill();
        await server.close();
        console.error("soak-addon: FAIL (load-client hung)");
        process.exit(1);
    }

    let stderrText = "";
    if (client.stderr) {
        stderrText = await new Response(client.stderr).text();
        if (stderrPath) await Bun.write(stderrPath, stderrText);
    }
    if (stderrText && (stderrText.includes("panicked") || stderrText.includes("panic!"))) {
        console.error("soak-addon: FAIL (load-client panicked)");
        await server.close();
        process.exit(1);
    }

    await poller;
    await Bun.sleep(5000);
    const m = server.metricsSnapshot();
    await server.close();
    const finalFd = await getFdCount(process.pid);

    if (result.code !== 0) {
        console.error("soak-addon: FAIL (load-client exited", result.code, ")");
        process.exit(1);
    }
    if (initialFd > 0 && finalFd > initialFd * 2) {
        console.error("soak-addon: FAIL (FD", initialFd, "->", finalFd, ")");
        process.exit(1);
    }
    // Leak checks: gauges and queued bytes return to baseline
    if (m.sessionTasksActive > 10 || m.streamTasksActive > 10) {
        console.error("soak-addon: FAIL (task gauges high:", m.sessionTasksActive, m.streamTasksActive, ")");
        process.exit(1);
    }
    if (m.queuedBytesGlobal > 1024 * 1024) {
        console.error("soak-addon: FAIL (queuedBytesGlobal not baseline:", m.queuedBytesGlobal, ")");
        process.exit(1);
    }

    console.log("soak-addon: PASS");
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
