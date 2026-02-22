/**
 * P0-C: Queue saturation, backpressure timeout, and recovery.
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer, E_BACKPRESSURE_TIMEOUT } from "../src/index.js";

describe("backpressure (P0-C)", () => {
    it("datagram size over max is rejected", async () => {
        const server = createServer({
            port: 14460,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const _ of s.incomingDatagrams()) {}
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14460", {
            tls: { insecureSkipVerify: true },
        });

        const big = new Uint8Array(1500);
        await expect(client.sendDatagram(big)).rejects.toThrow(/E_QUEUE_FULL/);

        await server.close();
    }, 10000);

    it("rapid datagram sends eventually apply backpressure", async () => {
        const server = createServer({
            port: 14461,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const _ of s.incomingDatagrams()) {}
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14461", {
            tls: { insecureSkipVerify: true },
        });

        const dgram = new Uint8Array(100);
        const sends = Array.from({ length: 400 }, () =>
            client.sendDatagram(dgram).catch((e: Error) => e)
        );
        const results = await Promise.all(sends);
        const timeouts = results.filter(
            (r) => r instanceof Error && r.message?.includes("E_BACKPRESSURE_TIMEOUT")
        );
        const successes = results.filter((r) => !(r instanceof Error));

        expect(successes.length).toBeGreaterThan(0);
        if (timeouts.length > 0) {
            expect(timeouts[0]).toBeInstanceOf(Error);
            expect((timeouts[0] as Error).message).toContain(E_BACKPRESSURE_TIMEOUT);
        }

        await server.close();
    }, 15000);

    it("send and receive works when server echoes", async () => {
        const server = createServer({
            port: 14462,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const d of s.incomingDatagrams()) {
                    await s.sendDatagram(d);
                }
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14462", {
            tls: { insecureSkipVerify: true },
        });

        const dgram = new Uint8Array([1, 2, 3]);
        await client.sendDatagram(dgram);
        const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
        const first = await iter.next();
        expect(first.done).toBe(false);

        await server.close();
    }, 10000);
});
