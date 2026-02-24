/**
 * Parity tests: WebTransport datagrams facade (Phase P2).
 * Verifies datagrams.readable and datagrams.writable Web Streams.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { WebTransport, createServer } from "../src/index.js";

describe("parity datagrams (P2)", () => {
    let server: ReturnType<typeof createServer>;
    let port: number;

    beforeAll(async () => {
        port = 15520;
        server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const d of s.incomingDatagrams()) {
                    await s.sendDatagram(d);
                }
            },
        });
        await Bun.sleep(2000);
    });

    afterAll(async () => {
        await server.close();
    });

    test("datagrams.writable.write sends datagram", async () => {
        const wt = new WebTransport(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await wt.ready;
        const writer = wt.datagrams.writable.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        writer.releaseLock();
        wt.close();
    });

    test("datagrams.readable receives echoed datagram", async () => {
        const wt = new WebTransport(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await wt.ready;
        const payload = new Uint8Array([10, 20, 30]);
        const writer = wt.datagrams.writable.getWriter();
        await writer.write(payload);
        writer.releaseLock();
        const reader = wt.datagrams.readable.getReader();
        const { value, done } = await reader.read();
        expect(done).toBe(false);
        expect(value).toBeDefined();
        expect(new Uint8Array(value!)).toEqual(payload);
        reader.releaseLock();
        wt.close();
    });

    test("datagram round-trip via Web Streams", async () => {
        const wt = new WebTransport(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await wt.ready;
        const sent = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
        const writer = wt.datagrams.writable.getWriter();
        await writer.write(sent);
        writer.releaseLock();
        const reader = wt.datagrams.readable.getReader();
        const { value } = await reader.read();
        expect(value).toBeDefined();
        expect(new Uint8Array(value!)).toEqual(sent);
        reader.releaseLock();
        wt.close();
    });

    test("datagrams.createWritable returns WritableStream", async () => {
        const wt = new WebTransport(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await wt.ready;
        const writable = wt.datagrams.createWritable();
        expect(writable).toBeInstanceOf(WritableStream);
        const writer = writable.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        writer.releaseLock();
        wt.close();
    });

    test("datagrams.maxDatagramSize is positive number", async () => {
        const wt = new WebTransport(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await wt.ready;
        expect(typeof wt.datagrams.maxDatagramSize).toBe("number");
        expect(wt.datagrams.maxDatagramSize).toBeGreaterThan(0);
        wt.close();
    });

    test("datagrams.createWritable rejects sendGroup option", async () => {
        const wt = new WebTransport(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await wt.ready;
        expect(() => wt.datagrams.createWritable({ sendGroup: {} })).toThrow(
            /unsupported option 'sendGroup'/,
        );
        wt.close();
    });
});
