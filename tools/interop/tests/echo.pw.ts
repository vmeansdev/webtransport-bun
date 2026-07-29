import { expect, test } from "@playwright/test";
import {
	BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
	resolveInteropHealthUrl,
	resolveInteropOrigin,
} from "../browser-helpers.js";
import { getCertHashBase64 } from "../cert-hash.js";

test.beforeEach(async ({ page }) => {
	await page.addInitScript({
		content: BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
	});
});

test("bidi stream echo via WebTransport", async ({ page }) => {
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
			try {
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "echo bidi ready");

				const stream = await wt.createBidirectionalStream();
				const writer = stream.writable.getWriter();
				const reader = stream.readable.getReader();

				const text = "Hello WebTransport from Bun!";
				await writer.write(new TextEncoder().encode(text));
				await writer.close();

				const { value } = await readWithTimeout(
					reader,
					5000,
					"bidi stream echo read",
				);
				await wt.close();

				return new TextDecoder().decode(value);
			} catch (e: unknown) {
				return (e as Error).message;
			}
		},
		{
			h: hashBase64,
			url: interopOrigin,
		},
	);

	expect(result).toBe("Hello WebTransport from Bun!");
});

test("datagram echo via WebTransport", async ({ page }) => {
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
			try {
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "echo datagram ready");

				const text = "Datagram echo test!";
				const payload = new TextEncoder().encode(text);

				const writer = wt.datagrams.writable.getWriter();
				await writer.write(payload);
				writer.releaseLock();

				const reader = wt.datagrams.readable.getReader();
				const { value } = await readWithTimeout(
					reader,
					5000,
					"datagram echo read",
				);
				await wt.close();

				return value ? new TextDecoder().decode(value) : null;
			} catch (e: unknown) {
				return (e as Error).message;
			}
		},
		{
			h: hashBase64,
			url: interopOrigin,
		},
	);

	expect(result).toBe("Datagram echo test!");
});

test("unidirectional stream echo via WebTransport", async ({ page }) => {
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
			try {
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "echo uni ready");

				const text = "Uni stream echo test!";

				// Create outgoing uni stream and write
				const writable = await wt.createUnidirectionalStream();
				const writer = writable.getWriter();
				await writer.write(new TextEncoder().encode(text));
				await writer.close();

				// Server echoes back on a new uni stream; read from incoming
				const reader = wt.incomingUnidirectionalStreams.getReader();
				const { value: stream } = await readWithTimeout(
					reader,
					5000,
					"incoming uni stream handle read",
				);
				if (!stream) throw new Error("No incoming uni stream");

				const streamReader = stream.getReader();
				const { value } = await readWithTimeout(
					streamReader,
					5000,
					"incoming uni payload read",
				);
				await wt.close();

				return value ? new TextDecoder().decode(value) : null;
			} catch (e: unknown) {
				return (e as Error).message;
			}
		},
		{
			h: hashBase64,
			url: interopOrigin,
		},
	);

	expect(result).toBe("Uni stream echo test!");
});
