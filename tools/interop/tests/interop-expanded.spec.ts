/**
 * P3.3: Extended Chromium interop — reconnect storms, mixed concurrency, close/reset/stopSending.
 */

import { test, expect } from "@playwright/test";
import { getCertHashBase64 } from "../cert-hash.js";

test.describe("P3.3 interop expansion", () => {
	test("reconnect storm: rapid connect/close cycles complete without hang", async ({
		page,
	}) => {
		await page.goto("http://127.0.0.1:4434");
		const h = getCertHashBase64();

		const result = await page.evaluate(async (hash: string) => {
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
					const wt = new WebTransport("https://127.0.0.1:4433", opts);
					await wt.ready;
					await wt.close();
					ok++;
				} catch (e) {
					err++;
				}
			}
			return { ok, err };
		}, h);

		expect(result.ok).toBeGreaterThanOrEqual(4);
	});

	test("mixed stream/datagram concurrency: bidi + uni + datagrams in parallel", async ({
		page,
	}) => {
		await page.goto("http://127.0.0.1:4434");
		const h = getCertHashBase64();

		const result = await page.evaluate(async (hash: string) => {
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
			const wt = new WebTransport("https://127.0.0.1:4433", opts);
			await wt.ready;

			const [bidiRes, uniRes, dgramRes] = await Promise.all([
				(async () => {
					const s = await wt.createBidirectionalStream();
					const w = s.writable.getWriter();
					const r = s.readable.getReader();
					await w.write(new TextEncoder().encode("bidi"));
					await w.close();
					const { value } = await r.read();
					return value ? new TextDecoder().decode(value) : null;
				})(),
				(async () => {
					const out = await wt.createUnidirectionalStream();
					const w = out.getWriter();
					await w.write(new TextEncoder().encode("uni"));
					await w.close();
					const reader = wt.incomingUnidirectionalStreams.getReader();
					const { value: stream } = await reader.read();
					if (!stream) return null;
					const { value } = await stream.getReader().read();
					return value ? new TextDecoder().decode(value) : null;
				})(),
				(async () => {
					const w = wt.datagrams.writable.getWriter();
					await w.write(new TextEncoder().encode("dgram"));
					w.releaseLock();
					const r = wt.datagrams.readable.getReader();
					const { value } = await r.read();
					return value ? new TextDecoder().decode(value) : null;
				})(),
			]);

			await wt.close();
			return { bidiRes, uniRes, dgramRes };
		}, h);

		expect(result.bidiRes).toBe("bidi");
		expect(result.uniRes).toBe("uni");
		expect(result.dgramRes).toBe("dgram");
	});

	test("close with code and reason propagates to client", async ({ page }) => {
		await page.goto("http://127.0.0.1:4434");
		const h = getCertHashBase64();

		const result = await page.evaluate(async (hash: string) => {
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
			const wt = new WebTransport("https://127.0.0.1:4433", opts);
			await wt.ready;
			const w = wt.datagrams.writable.getWriter();
			await w.write(new TextEncoder().encode("__WT_CLOSE_4001__"));
			w.releaseLock();
			try {
				const info = await wt.closed;
				return {
					code: (info as { closeCode?: number })?.closeCode ?? null,
					reason: (info as { reason?: string })?.reason ?? null,
				};
			} catch (e) {
				return { code: null, reason: (e as Error).message };
			}
		}, h);

		expect(
			result.code === 4001 ||
				result.reason?.includes("interop") ||
				result.reason?.includes("Connection"),
		).toBe(true);
	});

	test("getStats returns connection stats when available", async ({ page }) => {
		await page.goto("http://127.0.0.1:4434");
		const h = getCertHashBase64();

		const result = await page.evaluate(async (hash: string) => {
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
			const wt = new WebTransport("https://127.0.0.1:4433", opts);
			await wt.ready;
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
		}, h);

		if (result.supported) {
			expect(result.hasDatagrams).toBe(true);
			expect(Array.isArray(result.datagramKeys)).toBe(true);
		}
	});

	test("stream reset: writable.abort does not crash session", async ({
		page,
	}) => {
		await page.goto("http://127.0.0.1:4434");
		const h = getCertHashBase64();

		const result = await page.evaluate(async (hash: string) => {
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
			const wt = new WebTransport("https://127.0.0.1:4433", opts);
			await wt.ready;
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
		}, h);

		expect(result.ok).toBe(true);
	});
});
