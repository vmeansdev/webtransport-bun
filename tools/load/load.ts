#!/usr/bin/env bun
/**
 * Short load test (CI). 30s, 100 sessions, datagrams + streams.
 * Pass: no errors, server RSS within 2× initial.
 */

import { $ } from "bun";

const DURATION = 20;
const SESSIONS = 20;
const DATAGRAMS_PER_SEC = 50;
const STREAMS_PER_SEC = 2;

const ROOT = process.cwd();
const SERVER_BIN = `${ROOT}/target/debug/reference-server`;
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;

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
    console.log("load: Running load-client...");

    const stderrPath = process.env.CI ? `${ROOT}/tools/load/load-client-stderr.log` : null;

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
            stderr: stderrPath ? "pipe" : "inherit",
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
    if (stderrPath && client.stderr) {
        stderrText = await new Response(client.stderr).text();
        await Bun.write(stderrPath, stderrText);
    }

    if (exitCode !== 0) {
        if (stderrText && (stderrText.includes("panicked") || stderrText.includes("panic!"))) {
            console.error("load: FAIL (load-client panicked)");
            if (stderrPath) console.error("load: stderr saved to", stderrPath);
        }
    }
    const finalRss = await getServerRss();
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

    console.log("load: PASS");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
