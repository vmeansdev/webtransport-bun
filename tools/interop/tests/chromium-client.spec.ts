import { test, expect } from "@playwright/test";
import { getCertHashBase64 } from "../cert-hash.js";

function wtConnectScript(hashBase64: string): string {
    return `
        const opts = {};
        const h = "${hashBase64}";
        if (h) {
            const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
            opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
        }
        const wt = new WebTransport("https://127.0.0.1:4433", opts);
        await wt.ready;
        return wt;
    `;
}

test.describe("Chromium WebTransport client", () => {
    test("connects and ready resolves", async ({ page }) => {
        await page.goto("http://127.0.0.1:4434");
        const hashBase64 = getCertHashBase64();

        const result = await page.evaluate(async (h: string) => {
            const opts: WebTransportOptions = {};
            if (h) {
                const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
                opts.serverCertificateHashes = [
                    { algorithm: "sha-256", value: bin },
                ];
            }
            try {
                const wt = new WebTransport("https://127.0.0.1:4433", opts);
                await wt.ready;
                await wt.close();
                return { connected: true };
            } catch (e: unknown) {
                return { connected: false, error: (e as Error).message };
            }
        }, hashBase64);

        expect(result.connected).toBe(true);
    });

    test("round-trip datagrams with binary payload", async ({ page }) => {
        await page.goto("http://127.0.0.1:4434");
        const hashBase64 = getCertHashBase64();

        const result = await page.evaluate(async (h: string) => {
            const opts: WebTransportOptions = {};
            if (h) {
                const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
                opts.serverCertificateHashes = [
                    { algorithm: "sha-256", value: bin },
                ];
            }
            const wt = new WebTransport("https://127.0.0.1:4433", opts);
            await wt.ready;

            const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
            const writer = wt.datagrams.writable.getWriter();
            await writer.write(payload);
            writer.releaseLock();

            const reader = wt.datagrams.readable.getReader();
            const { value } = await reader.read();
            reader.releaseLock();
            await wt.close();

            return value ? Array.from(new Uint8Array(value)) : null;
        }, hashBase64);

        expect(result).toEqual([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
    });

    test("bidi stream sends and receives multiple chunks", async ({ page }) => {
        await page.goto("http://127.0.0.1:4434");
        const hashBase64 = getCertHashBase64();

        const result = await page.evaluate(async (h: string) => {
            const opts: WebTransportOptions = {};
            if (h) {
                const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
                opts.serverCertificateHashes = [
                    { algorithm: "sha-256", value: bin },
                ];
            }
            const wt = new WebTransport("https://127.0.0.1:4433", opts);
            await wt.ready;

            const stream = await wt.createBidirectionalStream();
            const writer = stream.writable.getWriter();
            const reader = stream.readable.getReader();

            const enc = new TextEncoder();
            await writer.write(enc.encode("chunk1"));
            await writer.write(enc.encode("chunk2"));
            await writer.close();

            const chunks: string[] = [];
            const dec = new TextDecoder();
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(dec.decode(value));
            }
            await wt.close();

            return chunks.join("");
        }, hashBase64);

        expect(result).toBe("chunk1chunk2");
    });
});
