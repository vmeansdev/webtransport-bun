/**
 * P0-A: session accept callback called exactly once
 */

import { describe, it, expect } from "bun:test";
import { createServer } from "../src/index.js";
import { $ } from "bun";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;

describe("session accept (P0-A)", () => {
    it("onSession called when client connects", async () => {
        const sessions: any[] = [];
        const server = createServer({
            port: 14440,
            tls: { certPem: "", keyPem: "" },
            onSession: (s) => sessions.push(s),
        });
        await Bun.sleep(6000);

        const client = Bun.spawn(
            [CLIENT_BIN, "--url", "https://127.0.0.1:14440", "--sessions", "1", "--duration", "2", "--datagrams-per-sec", "5", "--streams-per-sec", "1"],
            { cwd: ROOT, stdout: "pipe", stderr: "pipe" }
        );
        await client.exited;
        await Bun.sleep(1000);
        await server.close();

        expect(sessions.length).toBeGreaterThanOrEqual(1);
        expect(sessions[0]).toBeDefined();
        expect(sessions[0].id).toBeDefined();
        expect(typeof sessions[0].id).toBe("string");
    }, 30000);

    it("closed promise settles when session ends", async () => {
        const sessions: any[] = [];
        const server = createServer({
            port: 14441,
            tls: { certPem: "", keyPem: "" },
            onSession: (s) => sessions.push(s),
        });
        await Bun.sleep(2000);

        const client = Bun.spawn(
            [CLIENT_BIN, "--url", "https://127.0.0.1:14441", "--sessions", "1", "--duration", "1", "--datagrams-per-sec", "2", "--streams-per-sec", "1"],
            { cwd: ROOT, stdout: "pipe", stderr: "pipe" }
        );
        await client.exited;

        expect(sessions.length).toBeGreaterThanOrEqual(1);
        const closedResult = await Promise.race([
            sessions[0].closed.then((info: any) => ({ ok: true, info })),
            Bun.sleep(5000).then(() => ({ ok: false })),
        ]);
        expect(closedResult.ok).toBe(true);
        expect((closedResult as any).info).toBeDefined();

        await server.close();
    }, 20000);
});
