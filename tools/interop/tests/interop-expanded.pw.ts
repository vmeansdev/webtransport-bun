/**
 * P3.3: Extended Chromium interop — reconnect storms, mixed concurrency, close/reset/stopSending.
 */

import { expect, test } from "@playwright/test";
import {
	BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
	createMonotonicDeadline,
	fetchWithTimeout,
	promiseWithTimeout,
	resolveInteropHealthUrl,
	resolveInteropOrigin,
} from "../browser-helpers.js";
import { getCertHashBase64 } from "../cert-hash.js";

test.describe("P3.3 interop expansion", () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript({
			content: BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
		});
	});

	test("execution identity is the native addon", async () => {
		const deadline = createMonotonicDeadline(2_000);
		const response = await fetchWithTimeout(
			new URL("execution-identity", resolveInteropHealthUrl()),
			{
				cache: "no-store",
			},
			2_000,
			"interop execution identity fetch",
			deadline,
		);
		expect(response.ok).toBe(true);
		expect(
			await promiseWithTimeout(
				response.json(),
				2_000,
				"interop execution identity json",
				deadline,
			),
		).toEqual({
			executionIdentity: "native-addon",
		});
	});

	test("reconnect storm: rapid connect/close cycles complete without hang", async ({
		page,
	}) => {
		await page.goto(resolveInteropHealthUrl());
		const h = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ hash, url }) => {
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
				const opts = hash
					? {
							serverCertificateHashes: [
								{
									algorithm: "sha-256" as const,
									value: Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)),
								},
							],
						}
					: {};
				let ok = 0;
				let err = 0;
				for (let i = 0; i < 8; i++) {
					try {
						const wt = new WebTransport(url, opts);
						await withTimeout(wt.ready, 5_000, `reconnect ${i + 1} ready`);
						await wt.close();
						ok++;
					} catch {
						err++;
					}
				}
				return { ok, err };
			},
			{
				hash: h,
				url: interopOrigin,
			},
		);

		expect(result).toEqual({ ok: 8, err: 0 });
	});

	test("mixed stream/datagram concurrency: bidi + uni + datagrams in parallel", async ({
		page,
	}) => {
		await page.goto(resolveInteropHealthUrl());
		const h = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ hash, url }) => {
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
				const opts = hash
					? {
							serverCertificateHashes: [
								{
									algorithm: "sha-256" as const,
									value: Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)),
								},
							],
						}
					: {};
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "mixed interop ready");

				const [bidiRes, uniRes, dgramRes] = await Promise.all([
					(async () => {
						const s = await wt.createBidirectionalStream();
						const w = s.writable.getWriter();
						const r = s.readable.getReader();
						await w.write(new TextEncoder().encode("bidi"));
						await w.close();
						const { value } = await readWithTimeout(
							r,
							5000,
							"interop expanded bidi echo read",
						);
						return value ? new TextDecoder().decode(value as Uint8Array) : null;
					})(),
					(async () => {
						const out = await wt.createUnidirectionalStream();
						const w = out.getWriter();
						await w.write(new TextEncoder().encode("uni"));
						await w.close();
						const reader = wt.incomingUnidirectionalStreams.getReader();
						const { value: stream } = await readWithTimeout(
							reader,
							5000,
							"interop expanded incoming uni handle read",
						);
						if (!stream) return null;
						const { value } = await readWithTimeout(
							stream.getReader(),
							5000,
							"interop expanded incoming uni payload read",
						);
						return value ? new TextDecoder().decode(value) : null;
					})(),
					(async () => {
						const w = wt.datagrams.writable.getWriter();
						await w.write(new TextEncoder().encode("dgram"));
						w.releaseLock();
						const r = wt.datagrams.readable.getReader();
						const { value } = await readWithTimeout(
							r,
							5000,
							"interop expanded datagram read",
						);
						return value ? new TextDecoder().decode(value) : null;
					})(),
				]);

				await wt.close();
				return { bidiRes, uniRes, dgramRes };
			},
			{
				hash: h,
				url: interopOrigin,
			},
		);

		expect(result.bidiRes).toBe("bidi");
		expect(result.uniRes).toBe("uni");
		expect(result.dgramRes).toBe("dgram");
	});

	test("close with code and reason propagates to client", async ({ page }) => {
		await page.goto(resolveInteropHealthUrl());
		const h = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ hash, url }) => {
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
				const opts = hash
					? {
							serverCertificateHashes: [
								{
									algorithm: "sha-256" as const,
									value: Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)),
								},
							],
						}
					: {};
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "close propagation ready");
				const w = wt.datagrams.writable.getWriter();
				await w.write(new TextEncoder().encode("__WT_CLOSE_4001__"));
				w.releaseLock();
				try {
					const info = await withTimeout(
						wt.closed,
						5_000,
						"server close propagation",
					);
					return {
						code: (info as { closeCode?: number })?.closeCode ?? null,
						reason: (info as { reason?: string })?.reason ?? null,
					};
				} catch (e) {
					return { code: null, reason: (e as Error).message };
				}
			},
			{ hash: h, url: interopOrigin },
		);

		// Previously satisfied by the reason merely containing "Connection", which
		// a bare connection teardown also produces. The close capsule carries the
		// real code and reason, so assert them exactly.
		expect(result.code).toBe(4001);
		expect(result.reason).toBe("interop-close");
	});

	test("getStats returns connection stats when available", async ({ page }) => {
		await page.goto(resolveInteropHealthUrl());
		const h = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ hash, url }) => {
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
				const opts = hash
					? {
							serverCertificateHashes: [
								{
									algorithm: "sha-256" as const,
									value: Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)),
								},
							],
						}
					: {};
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "stats interop ready");
				if (typeof wt.getStats !== "function") {
					await wt.close();
					return { supported: false };
				}
				const stats = await wt.getStats();
				await wt.close();
				return {
					supported: true,
					hasDatagrams: stats != null && "datagrams" in stats,
					datagramKeys:
						stats?.datagrams != null ? Object.keys(stats.datagrams) : [],
				};
			},
			{ hash: h, url: interopOrigin },
		);

		if (result.supported) {
			expect(result.hasDatagrams).toBe(true);
			expect(Array.isArray(result.datagramKeys)).toBe(true);
		}
	});

	test("stream reset: writable.abort does not crash session", async ({
		page,
	}) => {
		await page.goto(resolveInteropHealthUrl());
		const h = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ hash, url }) => {
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
				const opts = hash
					? {
							serverCertificateHashes: [
								{
									algorithm: "sha-256" as const,
									value: Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)),
								},
							],
						}
					: {};
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "reset interop ready");
				const s = await wt.createBidirectionalStream();
				const writer = s.writable.getWriter();
				await writer.write(new TextEncoder().encode("x"));
				await writer.abort("reset-test");
				try {
					await wt.close();
				} catch {
					/* close may reject if stream aborted */
				}
				return { ok: true };
			},
			{ hash: h, url: interopOrigin },
		);

		expect(result.ok).toBe(true);
	});

	test("stream reset code round-trips through the WT_APPLICATION_ERROR remap", async ({
		page,
	}) => {
		await page.goto(resolveInteropHealthUrl());
		const h = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		// A WebTransport application error code does not travel as itself: draft
		// §4.4 maps it onto a reserved QUIC range on the way out and back on the
		// way in. Chromium does that mapping independently of us, so a code that
		// survives a server reset intact is proof both ends agree. 0x1e is the
		// mapping's period, so a code just past a multiple of it lands right after
		// one of the skipped reserved values — the arithmetic most likely to be
		// wrong. 0x1e * 7 + 1 = 211.
		const RESET_CODE = 211;

		const result = await page.evaluate(
			async ({ hash, url, code }) => {
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
				if (!readWithTimeout || !withTimeout)
					throw new Error("missing bounded timeout init scripts");
				const opts = hash
					? {
							serverCertificateHashes: [
								{
									algorithm: "sha-256" as const,
									value: Uint8Array.from(atob(hash), (c) => c.charCodeAt(0)),
								},
							],
						}
					: {};
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "reset code ready");

				const incoming = wt.incomingUnidirectionalStreams.getReader();
				const w = wt.datagrams.writable.getWriter();
				await w.write(new TextEncoder().encode(`__WT_RESET_${code}__`));
				w.releaseLock();

				const { value: stream } = await withTimeout(
					readWithTimeout(incoming, 5_000, "reset code incoming uni"),
					5_000,
					"reset code incoming uni",
				);
				if (!stream) return { errorName: null, streamErrorCode: null };

				const reader = (stream as ReadableStream<Uint8Array>).getReader();
				try {
					// Drain until the reset surfaces as a read rejection.
					for (;;) {
						const { done } = await withTimeout(
							readWithTimeout(reader, 5_000, "reset code read"),
							5_000,
							"reset code read",
						);
						if (done) return { errorName: "closed", streamErrorCode: null };
					}
				} catch (e) {
					const err = e as { name?: string; streamErrorCode?: number };
					return {
						errorName: err?.name ?? null,
						streamErrorCode: err?.streamErrorCode ?? null,
					};
				}
			},
			{ hash: h, url: interopOrigin, code: RESET_CODE },
		);

		expect(result?.errorName).toBe("WebTransportError");
		expect(result?.streamErrorCode).toBe(RESET_CODE);
	});
});
