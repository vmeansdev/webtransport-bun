#!/usr/bin/env bun
/**
 * P2.1: Load profile suite — handshake flood, stream-open flood, datagram flood, mixed.
 * Runs each profile against the addon server; all must pass.
 */

import { createServer } from "../../packages/webtransport/src/index.ts";
import { $ } from "bun";
import { existsSync } from "node:fs";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;

async function killPort4433(): Promise<void> {
    try {
        const p = await $`lsof -ti :4433`.quiet().nothrow().text();
        if (p.trim()) await $`kill -9 ${p.trim().split(/\s+/).filter(Boolean)}`.quiet().nothrow();
    } catch {}
    await Bun.sleep(2000);
}

async function runProfile(
    name: string,
    sessions: number,
    duration: number,
    datagramsPerSec: number,
    streamsPerSec: number,
    maxSessionErrors: number
): Promise<{ pass: boolean; msg: string }> {
    await killPort4433();

    const server = createServer({
        port: 4433,
        tls: { certPem: "", keyPem: "" },
        limits: { maxSessions: Math.min(sessions + 50, 5000) },
        onSession: () => {},
    });
    await Bun.sleep(5000);

    const client = Bun.spawn(
        [
            CLIENT_BIN,
            "--url", "https://127.0.0.1:4433",
            "--sessions", String(sessions),
            "--duration", String(duration),
            "--datagrams-per-sec", String(datagramsPerSec),
            "--streams-per-sec", String(streamsPerSec),
            "--max-session-errors", String(maxSessionErrors),
        ],
        { cwd: ROOT, stdout: "pipe", stderr: "pipe", env: { ...process.env, RUST_BACKTRACE: "1" } }
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

    const profiles: Array<{ name: string; sessions: number; duration: number; dg: number; st: number; maxErr: number }> = [
        { name: "handshake flood", sessions: 20, duration: 5, dg: 1, st: 1, maxErr: 5 },
        { name: "stream-open flood", sessions: 8, duration: 10, dg: 5, st: 50, maxErr: 0 },
        { name: "datagram flood", sessions: 8, duration: 10, dg: 500, st: 2, maxErr: 0 },
        { name: "mixed realistic", sessions: 6, duration: 12, dg: 80, st: 8, maxErr: 0 },
    ];

    let failed = 0;
    for (const p of profiles) {
        process.stdout.write(`load-profiles-addon: ${p.name}... `);
        const r = await runProfile(p.name, p.sessions, p.duration, p.dg, p.st, p.maxErr);
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
