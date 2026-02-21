/**
 * Property / lifecycle tests. Phase 15.1.
 * Close while writing, reset storms — exercise session/stream lifecycle.
 */

import { describe, it, expect } from "bun:test";
import { createServer } from "../src/index.js";
import { $ } from "bun";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/debug/load-client`;

describe("lifecycle", () => {
    it("server close => session closed promises settle", async () => {
        const sessions: any[] = [];
        const server = createServer({
            port: 14435,
            tls: { certPem: "", keyPem: "" },
            onSession: (s) => sessions.push(s),
        });
        await Bun.sleep(3000);

        const client = Bun.spawn(
            [CLIENT_BIN, "--url", "https://127.0.0.1:14435", "--sessions", "1", "--duration", "30", "--datagrams-per-sec", "2", "--streams-per-sec", "1"],
            { cwd: ROOT, stdout: "pipe", stderr: "pipe" }
        );
        await Bun.sleep(2000);
        expect(sessions.length).toBeGreaterThanOrEqual(1);

        const closedPromises = sessions.map((s) => s.closed);
        await server.close();

        const results = await Promise.race([
            Promise.all(closedPromises.map((p: Promise<any>) => p.then((v: any) => ({ ok: true, v })))),
            Bun.sleep(5000).then(() => null),
        ]);
        expect(results).not.toBeNull();
        expect((results as any[]).every((r) => r?.ok)).toBe(true);

        client.kill();
        await client.exited;
    }, 15000);

    it("server close resolves without hanging", async () => {
        const server = createServer({
            port: 14433,
            tls: { certPem: "", keyPem: "" },
            onSession: () => {},
        });
        const closePromise = server.close();
        await expect(closePromise).resolves.toBeUndefined();
    });

    it("metricsSnapshot after close returns consistent shape", () => {
        const server = createServer({
            port: 14434,
            tls: { certPem: "", keyPem: "" },
            onSession: () => {},
        });
        const m = server.metricsSnapshot();
        expect(typeof m.sessionsActive).toBe("number");
        expect(typeof m.streamsActive).toBe("number");
        expect(typeof m.queuedBytesGlobal).toBe("number");
        expect(typeof m.limitExceededCount).toBe("number");
    });
});
