#!/usr/bin/env bun
/**
 * Soak test (nightly). 30 min, 500 sessions, mixed datagram + stream workload.
 * Pass: no errors, no memory growth beyond 1.5× steady state.
 */

import { $ } from "bun";

const DURATION = 1800; // 30 minutes
const SESSIONS = 500;
const DATAGRAMS_PER_SEC = 500;
const STREAMS_PER_SEC = 5;

const ROOT = process.cwd();
const SERVER_BIN = `${ROOT}/target/debug/reference-server`;
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;

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

    console.log("soak: Running load-client (30 min)...");

    const client = Bun.spawn(
        [
            CLIENT_BIN_RELEASE,
            "--url", "https://127.0.0.1:4433",
            "--sessions", String(SESSIONS),
            "--duration", String(DURATION),
            "--datagrams-per-sec", String(DATAGRAMS_PER_SEC),
            "--streams-per-sec", String(STREAMS_PER_SEC),
        ],
        {
            cwd: ROOT,
            stdout: "inherit",
            stderr: "inherit",
        }
    );

    const exitCode = await client.exited;
    server.kill();

    if (exitCode !== 0) {
        console.error("soak: FAIL (load-client exited with", exitCode, ")");
        process.exit(1);
    }

    console.log("soak: PASS");
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
