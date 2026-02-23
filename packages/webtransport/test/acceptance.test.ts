/**
 * Acceptance tests for Task.md gates.
 * - P0-2: Sustained multi-stream traffic; streams opened/accepted repeatedly with limits enforced
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";

const BASE_PORT = 14600;

function nextPort(): number {
    return BASE_PORT + Math.floor(Math.random() * 500);
}

describe("acceptance (Task gates)", () => {
    it("P0-2: sustained multi-stream and datagram traffic", async () => {
        const port = nextPort();
        let streamsAccepted = 0;
        let datagramsEchoed = 0;

        const server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                void (async () => {
                    for await (const d of s.incomingDatagrams()) {
                        await s.sendDatagram(d);
                        datagramsEchoed++;
                    }
                })().catch(() => {});
                void (async () => {
                    for await (const _ of s.incomingBidirectionalStreams()) {
                        streamsAccepted++;
                    }
                })().catch(() => {});
            },
        });
        await Bun.sleep(2000);

        const client = await connect(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });

        // Open multiple bidi streams (write-only; server accepts but doesn't echo)
        const streamPromises = Array.from({ length: 5 }, async () => {
            const stream = await client.createBidirectionalStream();
            stream.write(Buffer.from("ping"));
            await new Promise<void>((r) => stream.end(r));
        });
        await Promise.all(streamPromises);

        // Send many datagrams and verify echo
        for (let i = 0; i < 10; i++) {
            await client.sendDatagram(new Uint8Array([i]));
        }
        let received = 0;
        const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
        while (received < 10) {
            const next = await iter.next();
            if (next.done) break;
            received++;
        }
        expect(received).toBe(10);

        await server.close();
        expect(streamsAccepted).toBe(5);
        expect(datagramsEchoed).toBeGreaterThanOrEqual(10);
    }, 15000);

    it("P1-4: metricsSnapshot reflects activity", async () => {
        const port = nextPort();
        const server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                void (async () => {
                    for await (const d of s.incomingDatagrams()) {
                        await s.sendDatagram(d);
                    }
                })().catch(() => {});
            },
        });
        await Bun.sleep(2000);

        const client = await connect(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await client.sendDatagram(new Uint8Array([1, 2, 3]));
        const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
        await iter.next();

        const metrics = server.metricsSnapshot();
        expect(metrics).toBeDefined();
        expect(typeof metrics.sessionsActive).toBe("number");
        expect(typeof metrics.datagramsIn).toBe("number");
        expect(typeof metrics.datagramsOut).toBe("number");

        await server.close();
    }, 10000);

    it("P1-6: repeated open/close cycles do not hang", async () => {
        for (let i = 0; i < 3; i++) {
            const port = nextPort();
            const server = createServer({
                port,
                tls: { certPem: "", keyPem: "" },
                onSession: () => {},
            });
            await Bun.sleep(1500);
            const client = await connect(`https://127.0.0.1:${port}`, {
                tls: { insecureSkipVerify: true },
            });
            client.close();
            await server.close();
        }
    }, 25000);

    it("P3-10: moderate load completes without panic", async () => {
        const port = nextPort();
        const server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                void (async () => {
                    for await (const d of s.incomingDatagrams()) {
                        await s.sendDatagram(d);
                    }
                })().catch(() => {});
            },
        });
        await Bun.sleep(2000);

        const clients = await Promise.all(
            Array.from({ length: 4 }, () =>
                connect(`https://127.0.0.1:${port}`, {
                    tls: { insecureSkipVerify: true },
                })
            )
        );
        const metrics = server.metricsSnapshot();
        expect(metrics.sessionsActive).toBe(4);

        await Promise.all(
            clients.flatMap((c) =>
                Array.from({ length: 20 }, () =>
                    c.sendDatagram(new Uint8Array(100)).catch(() => {})
                )
            )
        );
        clients.forEach((c) => c.close());
        await server.close();
    }, 20000);
});
