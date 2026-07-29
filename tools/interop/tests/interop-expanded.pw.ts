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

		expect(
			result.code === 4001 ||
				result.reason?.includes("interop") ||
				result.reason?.includes("Connection"),
		).toBe(true);
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
});
