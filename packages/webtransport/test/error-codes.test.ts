/**
 * P0.2: Tests that stable error codes E_RATE_LIMITED, E_SESSION_IDLE_TIMEOUT,
 * and E_STOP_SENDING are emitted by runtime paths.
 */

import { describe, it, expect } from "bun:test";
import {
    connect,
    createServer,
    E_RATE_LIMITED,
    E_SESSION_IDLE_TIMEOUT,
    E_STOP_SENDING,
    WebTransportError,
    WT_STOP_SENDING,
} from "../src/index.js";

const BASE_PORT = 14700;

function nextPort(): number {
    return BASE_PORT + Math.floor(Math.random() * 400);
}

describe("P0.2 stable error codes", () => {
    it("E_SESSION_IDLE_TIMEOUT: session closed due to idle has E_SESSION_IDLE_TIMEOUT in close info", async () => {
        const port = nextPort();
        let serverSession: any = null;
        const server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            limits: { idleTimeoutMs: 500 },
            onSession: (s) => {
                serverSession = s;
            },
        });
        await Bun.sleep(1500);

        await connect(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await Bun.sleep(100);
        if (!serverSession) throw new Error("onSession never fired");
        const info = await serverSession.closed;
        await server.close();

        expect(String(info?.reason ?? "")).toContain(E_SESSION_IDLE_TIMEOUT);
    }, 10000);

    it("E_RATE_LIMITED: handshake rate limit rejects with E_RATE_LIMITED", async () => {
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
        await Bun.sleep(1500);

        await connect(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await Bun.sleep(50);
        let err: unknown;
        try {
            await connect(`https://127.0.0.1:${port}`, {
                tls: { insecureSkipVerify: true },
            });
        } catch (e) {
            err = e;
        }
        await server.close();

        expect(err).toBeDefined();
        expect((err as WebTransportError).code).toBe(E_RATE_LIMITED);
    }, 15000);

    it("E_STOP_SENDING: write after peer stopSending throws E_STOP_SENDING", async () => {
        const port = nextPort();
        let stopSendingCalled = false;
        const server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const duplex of s.incomingBidirectionalStreams()) {
                    duplex.once("data", () => {
                        (duplex as any)[WT_STOP_SENDING](0);
                        stopSendingCalled = true;
                    });
                    break;
                }
            },
        });
        await Bun.sleep(1500);

        const client = await connect(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        const stream = await client.createBidirectionalStream();
        let err: unknown;
        const errPromise = new Promise<void>((r) => {
            stream.on("error", (e: any) => {
                err = e;
                r();
            });
        });
        stream.write(Buffer.from("hello"));
        while (!stopSendingCalled) await Bun.sleep(50);
        await Bun.sleep(300);

        const writeWithCallback = (): Promise<void> =>
            new Promise((resolve, reject) => {
                stream.write(Buffer.from("x"), (e: any) => {
                    if (e) {
                        err = e;
                        reject(e);
                    } else resolve();
                });
            });
        for (let i = 0; i < 20; i++) {
            try {
                await writeWithCallback();
            } catch {
                break;
            }
            await Bun.sleep(50);
        }
        if (!err) await Promise.race([errPromise, Bun.sleep(500)]);
        expect(err).toBeDefined();
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toContain(E_STOP_SENDING);

        await server.close();
    }, 15000);
});
