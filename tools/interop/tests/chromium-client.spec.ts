import { test, expect } from "@playwright/test";

/**
 * Chromium WebTransport client interop test.
 *
 * Prerequisites:
 * - A local webtransport server running on localhost:4433 with a self-signed cert
 * - Chromium launched with QUIC flags (handled by playwright.config.ts)
 *
 * This test verifies that a browser WebTransport client can:
 * 1. Connect to the in-process server
 * 2. Send and receive datagrams
 * 3. Open bidi/uni streams
 */

test.describe("Chromium WebTransport client", () => {
    test.skip(true, "Not yet implemented — requires running server");

    test("connects to local server and exchanges datagrams", async ({ page }) => {
        // TODO: start server in beforeAll, then use page.evaluate() to
        // create a WebTransport session and send/receive datagrams
        await page.goto("about:blank");

        const result = await page.evaluate(async () => {
            const wt = new (globalThis as any).WebTransport("https://localhost:4433");
            await wt.ready;
            return { connected: true };
        });

        expect(result.connected).toBe(true);
    });

    test("opens bidirectional stream and echoes data", async ({ page }) => {
        // TODO: implement bidi stream echo test
        await page.goto("about:blank");
        expect(true).toBe(true);
    });
});
