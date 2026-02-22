import { test, expect } from "@playwright/test";
import { getCertHashBase64 } from "../cert-hash.js";

test.describe("Chromium interop edge cases", () => {
    test("close code and reason propagate on server-triggered close", async ({ page }) => {
        await page.goto("http://127.0.0.1:4434");
        const hashBase64 = getCertHashBase64();

        const result = await page.evaluate(async (h: string) => {
            const opts: WebTransportOptions = {};
            if (h) {
                const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
                opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
            }
            const wt = new WebTransport("https://127.0.0.1:4433", opts);
            await wt.ready;
            const writer = wt.datagrams.writable.getWriter();
            await writer.write(new TextEncoder().encode("__WT_CLOSE_4001__"));
            writer.releaseLock();
            try {
                const closeInfo = await wt.closed;
                return {
                    closed: true,
                    closeCode: (closeInfo as any)?.closeCode ?? null,
                    reason: (closeInfo as any)?.reason ?? null,
                    error: null,
                };
            } catch (e) {
                return {
                    closed: true,
                    closeCode: null,
                    reason: null,
                    error: (e as Error).message,
                };
            }
        }, hashBase64);

        expect(result.closed).toBe(true);
        if (result.closeCode != null) {
            expect(result.closeCode).toBe(4001);
        } else {
            expect(result.error).toContain("Connection lost");
        }
    });

    test("large bidi payload round-trips", async ({ page }) => {
        await page.goto("http://127.0.0.1:4434");
        const hashBase64 = getCertHashBase64();

        const result = await page.evaluate(async (h: string) => {
            const opts: WebTransportOptions = {};
            if (h) {
                const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
                opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
            }
            const wt = new WebTransport("https://127.0.0.1:4433", opts);
            await wt.ready;

            const stream = await wt.createBidirectionalStream();
            const writer = stream.writable.getWriter();
            const reader = stream.readable.getReader();

            const size = 256 * 1024;
            const payload = new Uint8Array(size);
            for (let i = 0; i < size; i++) payload[i] = i % 251;
            await writer.write(payload);
            await writer.close();

            let received = 0;
            let checksum = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const buf = new Uint8Array(value);
                received += buf.length;
                for (const b of buf) checksum = (checksum + b) % 65536;
            }
            await wt.close();

            let expectedChecksum = 0;
            for (const b of payload) expectedChecksum = (expectedChecksum + b) % 65536;
            return { received, checksum, expectedChecksum };
        }, hashBase64);

        expect(result.received).toBe(256 * 1024);
        expect(result.checksum).toBe(result.expectedChecksum);
    });

    test("idle timeout closes inactive session", async ({ page }) => {
        await page.goto("http://127.0.0.1:4434");
        const hashBase64 = getCertHashBase64();

        const result = await page.evaluate(async (h: string) => {
            const opts: WebTransportOptions = {};
            if (h) {
                const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
                opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
            }
            const wt = new WebTransport("https://127.0.0.1:4433", opts);
            await wt.ready;
            try {
                const closeInfo = await Promise.race([
                    wt.closed,
                    new Promise<null>((resolve) => setTimeout(() => resolve(null), 9000)),
                ]);
                return closeInfo
                    ? { closed: true, reason: (closeInfo as any)?.reason ?? null, error: null }
                    : { closed: false, reason: null, error: null };
            } catch (e) {
                return { closed: true, reason: null, error: (e as Error).message };
            }
        }, hashBase64);

        expect(result.closed).toBe(true);
    });
});
