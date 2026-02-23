/**
 * P2.3: Fairness and abuse resistance validation.
 * - Contention tests prove non-starvation for compliant clients.
 * - Rate-limit enforcement returns correct stable codes and metrics.
 */

import { describe, it, expect } from "bun:test";
import {
    connect,
    createServer,
    E_RATE_LIMITED,
    WebTransportError,
} from "../src/index.js";

function nextPort(): number {
    return 14900 + Math.floor(Math.random() * 200);
}

describe("fairness and abuse resistance (P2.3)", () => {
    it("compliant client recovers after rate limit: tokens refill, new connections succeed", async () => {
        const port = nextPort();
        const server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            rateLimits: {
                handshakesPerSec: 10,
                handshakesBurst: 2,
                handshakesBurstPerPrefix: 5,
            },
            onSession: (s) => {
                void (async () => {
                    for await (const _ of s.incomingDatagrams()) {}
                })().catch(() => {});
            },
        });
        await Bun.sleep(2000);

        const c1 = await connect(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        const c2 = await connect(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        let rateLimitedCount = 0;
        const failed = await Promise.all(
            Array.from({ length: 3 }, () =>
                connect(`https://127.0.0.1:${port}`, {
                    tls: { insecureSkipVerify: true },
                }).catch((e: unknown) => {
                    if (e instanceof WebTransportError && e.code === E_RATE_LIMITED) {
                        rateLimitedCount++;
                    }
                    return null;
                })
            )
        );
        expect(failed.filter((r) => r === null).length).toBeGreaterThanOrEqual(1);
        expect(rateLimitedCount).toBeGreaterThanOrEqual(1);

        const mBefore = server.metricsSnapshot();
        expect(mBefore.rateLimitedCount).toBeGreaterThanOrEqual(1);

        c1.close();
        c2.close();
        await Bun.sleep(1500);

        const c3 = await connect(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        const mAfter = server.metricsSnapshot();
        expect(mAfter.sessionsActive).toBeGreaterThanOrEqual(1);
        c3.close();

        await server.close();
    }, 15000);

    it("rate limit returns E_RATE_LIMITED and increments rateLimitedCount", async () => {
        const port = nextPort();
        const server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            rateLimits: {
                handshakesPerSec: 2,
                handshakesBurst: 1,
                handshakesBurstPerPrefix: 1,
            },
            onSession: () => {},
        });
        await Bun.sleep(2000);

        await connect(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        let err: unknown;
        try {
            await connect(`https://127.0.0.1:${port}`, {
                tls: { insecureSkipVerify: true },
            });
        } catch (e) {
            err = e;
        }
        expect(err).toBeDefined();
        expect((err as WebTransportError).code).toBe(E_RATE_LIMITED);

        const m = server.metricsSnapshot();
        expect(m.rateLimitedCount).toBeGreaterThanOrEqual(1);

        await server.close();
    }, 10000);

    it("per-IP burst: at most burst connections succeed, excess rejected with rate limit", async () => {
        const port = nextPort();
        const burst = 3;
        const server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            rateLimits: {
                handshakesBurst: burst,
                handshakesBurstPerPrefix: burst + 10,
            },
            onSession: () => {},
        });
        await Bun.sleep(2000);

        const results = await Promise.allSettled(
            Array.from({ length: burst + 5 }, () =>
                connect(`https://127.0.0.1:${port}`, {
                    tls: { insecureSkipVerify: true },
                })
            )
        );
        const succeeded = results.filter((r) => r.status === "fulfilled").length;
        const rejected = results.filter((r) => {
            if (r.status === "rejected") {
                const e = r.reason;
                return e instanceof WebTransportError && e.code === E_RATE_LIMITED;
            }
            return false;
        }).length;

        expect(succeeded).toBeLessThanOrEqual(burst + 1);
        expect(rejected).toBeGreaterThanOrEqual(1);

        const m = server.metricsSnapshot();
        expect(m.rateLimitedCount).toBeGreaterThanOrEqual(1);

        for (const r of results) {
            if (r.status === "fulfilled" && r.value) {
                r.value.close();
            }
        }
        await server.close();
    }, 15000);
});
