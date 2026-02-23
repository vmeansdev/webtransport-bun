#!/usr/bin/env bun
/**
 * Overload scenario targeting addon server (createServer).
 * Phase 4.4.5: maxSessions=5, attempt 10 sessions. Assert sessionsActive <= 5+2, limitExceededCount > 0.
 */

import { createServer } from "../../packages/webtransport/src/index.ts";
import { $ } from "bun";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;
const MAX_SESSIONS = 5;
const SESSIONS_ATTEMPT = 20;
const DURATION = 8;

async function main() {
    console.log("overload-addon: Building load-client...");
    try {
        const p4433 = await $`lsof -ti :4433`.quiet().nothrow().text();
        if (p4433.trim()) await $`kill -9 ${p4433.trim().split(/\s+/).filter(Boolean).join(" ")}`.quiet().nothrow();
    } catch {}
    await Bun.sleep(3000); // Allow port to be released
    await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client`.quiet();

    console.log("overload-addon: Starting addon server (createServer, maxSessions=" + MAX_SESSIONS + ")...");
    const server = createServer({
        port: 4433,
        tls: { certPem: "", keyPem: "" },
        limits: { maxSessions: MAX_SESSIONS },
        onSession: () => {},
    });
    await Bun.sleep(8000); // Allow addon to bind

    console.log("overload-addon: Running load-client (" + SESSIONS_ATTEMPT + " sessions, " + DURATION + "s)...");
    const client = Bun.spawn(
        [
            CLIENT_BIN,
            "--url", "https://127.0.0.1:4433",
            "--sessions", String(SESSIONS_ATTEMPT),
            "--duration", String(DURATION),
            "--datagrams-per-sec", "10",
            "--streams-per-sec", "1",
            "--max-session-errors", String(SESSIONS_ATTEMPT - MAX_SESSIONS),
        ],
        {
            cwd: ROOT,
            stdout: "inherit",
            stderr: "pipe",
            env: { ...process.env, RUST_BACKTRACE: "1" },
        }
    );

    const TIMEOUT_MS = (DURATION + 20) * 1000;
    const exitOrTimeout = await Promise.race([
        client.exited.then((code) => ({ done: true as const, code })),
        Bun.sleep(TIMEOUT_MS).then(() => ({ done: false as const, code: -1 })),
    ]);
    if (!exitOrTimeout.done) {
        client.kill();
        await server.close();
        console.error("overload-addon: FAIL (load-client hung)");
        process.exit(1);
    }

    await Bun.sleep(8000); // Allow sessions and stream tasks to drain
    const m = server.metricsSnapshot();
    await server.close();

    console.log("overload-addon: sessionsActive=", m.sessionsActive, "limitExceededCount=", m.limitExceededCount);

    if (m.sessionsActive > MAX_SESSIONS + 2) {
        console.error("overload-addon: FAIL (sessionsActive", m.sessionsActive, "> max", MAX_SESSIONS, "+ 2)");
        process.exit(1);
    }
    if (m.limitExceededCount === 0) {
        console.error("overload-addon: FAIL (limitExceededCount should be > 0 when shedding)");
        process.exit(1);
    }

    console.log("overload-addon: PASS (shedding verified)");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
