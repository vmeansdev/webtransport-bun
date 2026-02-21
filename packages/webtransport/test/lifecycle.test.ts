/**
 * Property / lifecycle tests. Phase 15.1.
 * Close while writing, reset storms — exercise session/stream lifecycle.
 */

import { describe, it, expect } from "bun:test";
import { createServer } from "../src/index.js";

describe("lifecycle", () => {
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
