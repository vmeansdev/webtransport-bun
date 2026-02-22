/**
 * Parity tests: WebTransport streams facade (Phase P3).
 * Verifies createBidirectionalStream, createUnidirectionalStream,
 * incomingBidirectionalStreams, incomingUnidirectionalStreams.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { WebTransport, createServer } from "../src/index.js";

describe("parity streams (P3)", () => {
    let server: ReturnType<typeof createServer>;
    let port: number;

    beforeAll(async () => {
        port = 15530;
        server = createServer({
            port,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const duplex of s.incomingBidirectionalStreams()) {
                    void (async () => {
                        const chunks: Buffer[] = [];
                        for await (const c of duplex) chunks.push(c);
                        if (chunks.length > 0) {
                            duplex.write(Buffer.concat(chunks));
                            duplex.end();
                        }
                    })().catch(() => {});
                }
                for await (const readable of s.incomingUnidirectionalStreams()) {
                    void (async () => {
                        const chunks: Buffer[] = [];
                        for await (const c of readable) chunks.push(c);
                        // Echo back on a new uni stream
                        const w = await s.createUnidirectionalStream();
                        w.write(Buffer.concat(chunks));
                        w.end();
                    })().catch(() => {});
                }
            },
        });
        await Bun.sleep(2000);
    });

    afterAll(async () => {
        await server.close();
    });

    test("createBidirectionalStream returns Web Streams bidi", async () => {
        const wt = new WebTransport(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await wt.ready;
        const { readable, writable } = await wt.createBidirectionalStream();
        expect(readable).toBeInstanceOf(ReadableStream);
        expect(writable).toBeInstanceOf(WritableStream);
        const writer = writable.getWriter();
        await writer.write(new Uint8Array([1, 2, 3]));
        writer.close();
        const reader = readable.getReader();
        const { value } = await reader.read();
        expect(value).toBeDefined();
        expect(new Uint8Array(value!)).toEqual(new Uint8Array([1, 2, 3]));
        reader.releaseLock();
        wt.close();
    });

    test("createUnidirectionalStream returns WritableStream", async () => {
        const wt = new WebTransport(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await wt.ready;
        const writable = await wt.createUnidirectionalStream();
        expect(writable).toBeInstanceOf(WritableStream);
        const writer = writable.getWriter();
        await writer.write(new Uint8Array([4, 5, 6]));
        writer.close();
        wt.close();
    });

    test("incomingBidirectionalStreams is ReadableStream of bidi streams", async () => {
        const wt = new WebTransport(`https://127.0.0.1:${port}`, {
            tls: { insecureSkipVerify: true },
        });
        await wt.ready;
        expect(wt.incomingBidirectionalStreams).toBeInstanceOf(ReadableStream);
        expect(wt.incomingUnidirectionalStreams).toBeInstanceOf(ReadableStream);
        wt.close();
    });
});
