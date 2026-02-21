import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";

describe("webtransport client", () => {
    it("exports connect function", () => {
        expect(typeof connect).toBe("function");
    });

    it.skip("connect rejects when server unreachable", async () => {
        await expect(connect("https://127.0.0.1:19999")).rejects.toThrow();
    });

    it("connect with insecureSkipVerify emits warning log", async () => {
        const logs: Array<{ level: string; msg: string }> = [];
        const connectPromise = connect("https://127.0.0.1:19998", {
            tls: { insecureSkipVerify: true },
            log: (e) => logs.push(e),
        });
        await Bun.sleep(100);
        expect(logs.length).toBeGreaterThanOrEqual(1);
        const entry = logs.find((e) => e.msg?.includes("insecureSkipVerify"));
        expect(entry).toBeDefined();
        expect(entry!.msg).toContain("dev only");
        try {
            await Promise.race([connectPromise, Bun.sleep(3000)]);
        } catch {
            // connection fails, ignore
        }
    }, 5000);

    it("connect succeeds when server is running and datagrams work", async () => {
        const server = createServer({
            port: 14450,
            tls: { certPem: "", keyPem: "" },
            onSession: async (session) => {
                for await (const d of session.incomingDatagrams()) {
                    await session.sendDatagram(d);
                }
            },
        });
        await Bun.sleep(2000);

        const client = await connect("https://127.0.0.1:14450", {
            tls: { insecureSkipVerify: true },
        });
        expect(client.id).toBeDefined();
        expect(client.peer).toBeDefined();
        expect(client.peer.port).toBeGreaterThan(0);

        await client.sendDatagram(new Uint8Array([1, 2, 3]));
        const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
        const first = await iter.next();
        expect(first.done).toBe(false);
        expect(new Uint8Array(first.value!)).toEqual(new Uint8Array([1, 2, 3]));

        const bidi = await client.createBidirectionalStream();
        bidi.write(Buffer.from([4, 5, 6]));
        bidi.end();
        const chunks: Buffer[] = [];
        for await (const c of bidi) chunks.push(c);
        expect(Buffer.concat(chunks)).toEqual(Buffer.from([4, 5, 6]));

        await server.close();
    }, 15000);
});
