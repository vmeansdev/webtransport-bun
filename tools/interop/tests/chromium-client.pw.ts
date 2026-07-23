import { expect, test } from "@playwright/test";
import {
	BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
	resolveInteropHealthUrl,
	resolveInteropOrigin,
} from "../browser-helpers.js";
import { getCertHashBase64 } from "../cert-hash.js";

test.describe("Chromium WebTransport client", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript({
			content: BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
		});
	});

	test("connects and ready resolves", async ({ page }) => {
		await page.goto(resolveInteropHealthUrl());
		const hashBase64 = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ h, url }) => {
				const withTimeout = (
					globalThis as typeof globalThis & {
						__wtWithTimeout?: <T>(
							promise: PromiseLike<T>,
							timeoutMs: number,
							label: string,
						) => Promise<T>;
					}
				).__wtWithTimeout;
				if (!withTimeout)
					throw new Error("missing __wtWithTimeout init script");
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				try {
					const wt = new WebTransport(url, opts);
					await withTimeout(wt.ready, 5_000, "chromium client ready");
					await wt.close();
					return { connected: true };
				} catch (e: unknown) {
					return { connected: false, error: (e as Error).message };
				}
			},
			{
				h: hashBase64,
				url: interopOrigin,
			},
		);

		expect(result.connected).toBe(true);
	});

	test("round-trip datagrams with binary payload", async ({ page }) => {
		await page.goto(resolveInteropHealthUrl());
		const hashBase64 = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ h, url }) => {
				const helpers = globalThis as typeof globalThis & {
					__wtReadWithTimeout?: <T>(
						reader: ReadableStreamDefaultReader<T>,
						timeoutMs: number,
						label: string,
					) => Promise<ReadableStreamReadResult<T>>;
					__wtWithTimeout?: <T>(
						promise: PromiseLike<T>,
						timeoutMs: number,
						label: string,
					) => Promise<T>;
				};
				const readWithTimeout = helpers.__wtReadWithTimeout;
				const withTimeout = helpers.__wtWithTimeout;
				if (!readWithTimeout || !withTimeout) {
					throw new Error("missing bounded browser init script");
				}
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "chromium datagram ready");

				const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
				const writer = wt.datagrams.writable.getWriter();
				await writer.write(payload);
				writer.releaseLock();

				const reader = wt.datagrams.readable.getReader();
				const { value } = await readWithTimeout(
					reader,
					5000,
					"chromium client datagram read",
				);
				reader.releaseLock();
				await wt.close();

				return value ? Array.from(new Uint8Array(value)) : null;
			},
			{
				h: hashBase64,
				url: interopOrigin,
			},
		);

		expect(result).toEqual([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02]);
	});

	test("bidi stream sends and receives multiple chunks", async ({ page }) => {
		await page.goto(resolveInteropHealthUrl());
		const hashBase64 = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ h, url }) => {
				const helpers = globalThis as typeof globalThis & {
					__wtReadWithTimeout?: <T>(
						reader: ReadableStreamDefaultReader<T>,
						timeoutMs: number,
						label: string,
					) => Promise<ReadableStreamReadResult<T>>;
					__wtWithTimeout?: <T>(
						promise: PromiseLike<T>,
						timeoutMs: number,
						label: string,
					) => Promise<T>;
				};
				const readWithTimeout = helpers.__wtReadWithTimeout;
				const withTimeout = helpers.__wtWithTimeout;
				if (!readWithTimeout || !withTimeout) {
					throw new Error("missing bounded browser init script");
				}
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "chromium bidi ready");

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
					const { done, value } = await readWithTimeout(
						reader,
						5000,
						"chromium client bidi echo read",
					);
					if (done) break;
					chunks.push(dec.decode(value));
				}
				await wt.close();

				return chunks.join("");
			},
			{
				h: hashBase64,
				url: interopOrigin,
			},
		);

		expect(result).toBe("chunk1chunk2");
	});
});
