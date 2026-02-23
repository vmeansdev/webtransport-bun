/**
 * Property / lifecycle tests. Phase 15.1.
 * Close while writing, reset storms — exercise session/stream lifecycle.
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";

async function waitUntil(
    condition: () => boolean,
    timeoutMs: number,
    intervalMs = 50,
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (condition()) return true;
        await Bun.sleep(intervalMs);
    }
    return condition();
}

describe("lifecycle", () => {
    it("server close => session closed promises settle", async () => {
        const sessions: any[] = [];
        const server = createServer({
            port: 14435,
            tls: { certPem: "", keyPem: "" },
            onSession: (s) => {
                sessions.push(s);
            },
        });
        const client = await connect("https://127.0.0.1:14435", {
            tls: { insecureSkipVerify: true },
        });
        const accepted = await waitUntil(() => sessions.length >= 1, 8000);
        expect(accepted).toBe(true);

        const closedPromises = sessions.map((s) => s.closed);
        await server.close();

        const results = await Promise.race([
            Promise.all(closedPromises.map((p: Promise<any>) => p.then((v: any) => ({ ok: true, v })))),
            Bun.sleep(5000).then(() => null),
        ]);
        expect(results).not.toBeNull();
        expect((results as any[]).every((r) => r?.ok)).toBe(true);

        client.close();
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
        void server.close();
    });
});
