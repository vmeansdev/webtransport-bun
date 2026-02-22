/**
 * Hardening tests: byte-budget enforcement, error-code mapping, close-path settlement.
 */

import { describe, it, expect } from "bun:test";
import {
    connect,
    createServer,
    WebTransportError,
    E_SESSION_CLOSED,
    E_QUEUE_FULL,
    E_BACKPRESSURE_TIMEOUT,
    E_HANDSHAKE_TIMEOUT,
    E_INTERNAL,
    E_LIMIT_EXCEEDED,
} from "../src/index.js";

describe("error-code mapping", () => {
    it("client send_datagram after close returns E_SESSION_CLOSED", async () => {
        const server = createServer({
            port: 14700,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const _ of s.incomingDatagrams()) {}
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14700", {
            tls: { insecureSkipVerify: true },
        });
        await client.close();
        await Bun.sleep(500);
        try {
            await client.sendDatagram(new Uint8Array([1, 2, 3]));
            expect(true).toBe(false);
        } catch (e: any) {
            expect(e).toBeInstanceOf(WebTransportError);
            expect(e.code).toBe(E_SESSION_CLOSED);
        }
        await server.close();
    }, 10000);

    it("client oversized datagram returns E_QUEUE_FULL", async () => {
        const server = createServer({
            port: 14701,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const _ of s.incomingDatagrams()) {}
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14701", {
            tls: { insecureSkipVerify: true },
        });
        try {
            await client.sendDatagram(new Uint8Array(1500));
            expect(true).toBe(false);
        } catch (e: any) {
            expect(e).toBeInstanceOf(WebTransportError);
            expect(e.code).toBe(E_QUEUE_FULL);
        }
        await server.close();
    }, 10000);

    it("connect to unreachable host returns WebTransportError", async () => {
        try {
            await connect("https://127.0.0.1:19999", {
                limits: { handshakeTimeoutMs: 2000 },
            });
            expect(true).toBe(false);
        } catch (e: any) {
            expect(e).toBeInstanceOf(WebTransportError);
        }
    }, 10000);

    it("all E_* codes are exported strings", () => {
        expect(typeof E_SESSION_CLOSED).toBe("string");
        expect(typeof E_QUEUE_FULL).toBe("string");
        expect(typeof E_BACKPRESSURE_TIMEOUT).toBe("string");
        expect(typeof E_HANDSHAKE_TIMEOUT).toBe("string");
        expect(typeof E_INTERNAL).toBe("string");
    });
});

describe("close-path promise settlement", () => {
    it("server close settles all session closed promises", async () => {
        let serverSession: any = null;
        const server = createServer({
            port: 14702,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                serverSession = s;
                for await (const _ of s.incomingDatagrams()) {}
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14702", {
            tls: { insecureSkipVerify: true },
        });

        const closedPromise = client.closed;
        await server.close();

        const info = await Promise.race([
            closedPromise,
            Bun.sleep(5000).then(() => "timeout"),
        ]);

        expect(info).not.toBe("timeout");
    }, 15000);

    it("client close resolves closed promise", async () => {
        const server = createServer({
            port: 14703,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const _ of s.incomingDatagrams()) {}
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14703", {
            tls: { insecureSkipVerify: true },
        });

        const closedPromise = client.closed;
        await client.close();

        const info = await Promise.race([
            closedPromise,
            Bun.sleep(5000).then(() => "timeout"),
        ]);

        expect(info).not.toBe("timeout");
        await server.close();
    }, 15000);
});

describe("client metricsSnapshot", () => {
    it("reflects datagram activity", async () => {
        const server = createServer({
            port: 14704,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const dgram of s.incomingDatagrams()) {
                    await s.sendDatagram(dgram);
                }
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14704", {
            tls: { insecureSkipVerify: true },
        });

        await client.sendDatagram(new Uint8Array([1, 2, 3]));
        const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
        const first = await iter.next();
        expect(first.done).toBe(false);

        const snap = client.metricsSnapshot();
        expect(snap.datagramsOut).toBeGreaterThanOrEqual(1);
        expect(snap.datagramsIn).toBeGreaterThanOrEqual(1);

        await server.close();
    }, 10000);

    it("tracks streamsActive and queuedBytes", async () => {
        const server = createServer({
            port: 14705,
            tls: { certPem: "", keyPem: "" },
            onSession: async (s) => {
                for await (const bidi of s.incomingBidirectionalStreams()) {
                    for await (const chunk of bidi) {
                        bidi.write(chunk);
                        break;
                    }
                    bidi.end();
                }
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14705", {
            tls: { insecureSkipVerify: true },
        });

        const stream = await client.createBidirectionalStream();
        const snapDuring = client.metricsSnapshot();
        expect(snapDuring.streamsActive).toBeGreaterThanOrEqual(1);

        stream.write(new Uint8Array([10, 20, 30]));

        const reply = await new Promise<Buffer>((resolve) => {
            stream.once("data", resolve);
        });
        expect(reply).not.toBeNull();
        expect(reply.length).toBe(3);
        stream.end();

        await Bun.sleep(500);
        const snapAfter = client.metricsSnapshot();
        expect(typeof snapAfter.queuedBytes).toBe("number");

        await server.close();
    }, 10000);
});

describe("server-created stream cap enforcement", () => {
    it("createBidirectionalStream fails after maxStreamsPerSessionBidi", async () => {
        const cap = 2;
        let serverSession: any = null;
        const serverReady = new Promise<void>((resolve) => {
            var server = createServer({
                port: 14710,
                tls: { certPem: "", keyPem: "" },
                limits: { maxStreamsPerSessionBidi: cap, maxStreamsGlobal: 50000 },
                onSession: async (s) => {
                    serverSession = s;
                    resolve();
                    for await (const _ of s.incomingDatagrams()) {}
                },
            });
        });

        const client = await connect("https://127.0.0.1:14710", {
            tls: { insecureSkipVerify: true },
        });
        await serverReady;
        expect(serverSession).not.toBeNull();

        const opened: any[] = [];
        for (let i = 0; i < cap; i++) {
            opened.push(await serverSession.createBidirectionalStream());
        }
        expect(opened.length).toBe(cap);

        try {
            await serverSession.createBidirectionalStream();
            expect(true).toBe(false);
        } catch (e: any) {
            expect(e).toBeInstanceOf(WebTransportError);
            expect(e.code).toBe(E_LIMIT_EXCEEDED);
        }

        await client.close();
    }, 15000);

    it("createUnidirectionalStream fails after maxStreamsPerSessionUni", async () => {
        const cap = 2;
        let serverSession: any = null;
        const serverReady = new Promise<void>((resolve) => {
            var server = createServer({
                port: 14711,
                tls: { certPem: "", keyPem: "" },
                limits: { maxStreamsPerSessionUni: cap, maxStreamsGlobal: 50000 },
                onSession: async (s) => {
                    serverSession = s;
                    resolve();
                    for await (const _ of s.incomingDatagrams()) {}
                },
            });
        });

        const client = await connect("https://127.0.0.1:14711", {
            tls: { insecureSkipVerify: true },
        });
        await serverReady;
        expect(serverSession).not.toBeNull();

        const opened: any[] = [];
        for (let i = 0; i < cap; i++) {
            opened.push(await serverSession.createUnidirectionalStream());
        }
        expect(opened.length).toBe(cap);

        try {
            await serverSession.createUnidirectionalStream();
            expect(true).toBe(false);
        } catch (e: any) {
            expect(e).toBeInstanceOf(WebTransportError);
            expect(e.code).toBe(E_LIMIT_EXCEEDED);
        }

        await client.close();
    }, 15000);
});
