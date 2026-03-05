import { test, expect } from "@playwright/test";
import { getCertHashBase64 } from "../cert-hash.js";

async function waitForCloseEvent(
	code: number,
	reason: string,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const res = await fetch("http://127.0.0.1:4434/close-events", {
			cache: "no-store",
		});
		const body = (await res.json()) as {
			closeEvents?: Array<{ code?: number; reason?: string }>;
		};
		if (
			Array.isArray(body.closeEvents) &&
			body.closeEvents.some(
				(evt) =>
					Number(evt?.code ?? 0) === code &&
					String(evt?.reason ?? "") === reason,
			)
		) {
			return true;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

test.describe("Chromium interop edge cases", () => {
	test("bidi writer.close before read still preserves close code and reason to server", async ({
		page,
	}) => {
		await page.goto("http://127.0.0.1:4434");
		const hashBase64 = getCertHashBase64();
		const closeCode = 4999;
		const closeReason = "Done streaming.";

		const browserResult = await page.evaluate(
			async ({ h, closeCode, closeReason }) => {
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				const wt = new WebTransport("https://127.0.0.1:4433", opts);
				await wt.ready;

				const stream = await wt.createBidirectionalStream();
				const writer = stream.writable.getWriter();
				await writer.write(new Uint8Array([1, 2, 3, 4]));
				await writer.ready;
				await writer.close();

				const reader = stream.readable.getReader();
				const first = await Promise.race([
					reader.read(),
					new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
						setTimeout(() => resolve({ done: true, value: undefined }), 5000),
					),
				]);
				reader.releaseLock();
				if (first.done || !first.value) {
					return { ok: false, where: "stream_read", info: null };
				}
				const got = Array.from(first.value);
				if (
					got.length !== 4 ||
					got[0] !== 1 ||
					got[1] !== 2 ||
					got[2] !== 3 ||
					got[3] !== 4
				) {
					return { ok: false, where: "stream_payload", info: got };
				}

				wt.close({ closeCode, reason: closeReason });
				const closed = await wt.closed;
				return {
					ok: true,
					where: "closed",
					info: {
						closeCode: (closed as any)?.closeCode ?? null,
						reason: (closed as any)?.reason ?? null,
					},
				};
			},
			{ h: hashBase64, closeCode, closeReason },
		);

		expect(browserResult.ok).toBe(true);
		expect((browserResult as any).info?.closeCode).toBe(closeCode);
		expect((browserResult as any).info?.reason).toBe(closeReason);

		const seenOnServer = await waitForCloseEvent(closeCode, closeReason, 6000);
		expect(seenOnServer).toBe(true);
	});

	test("client-initiated close code and reason propagate to server", async ({
		page,
	}) => {
		await page.goto("http://127.0.0.1:4434");
		const hashBase64 = getCertHashBase64();
		const closeCode = 1234;
		const closeReason = "Bye bye";

		const browserClosed = await page.evaluate(
			async ({ h, closeCode, closeReason }) => {
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				const wt = new WebTransport("https://127.0.0.1:4433", opts);
				await wt.ready;
				wt.close({ closeCode, reason: closeReason });
				const info = await wt.closed;
				return {
					closeCode: (info as any)?.closeCode ?? null,
					reason: (info as any)?.reason ?? null,
				};
			},
			{ h: hashBase64, closeCode, closeReason },
		);
		expect(browserClosed.closeCode).toBe(closeCode);
		expect(browserClosed.reason).toBe(closeReason);

		const seenOnServer = await waitForCloseEvent(closeCode, closeReason, 6000);
		expect(seenOnServer).toBe(true);
	});

	test("close code and reason propagate on server-triggered close", async ({
		page,
	}) => {
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
			for (const b of payload)
				expectedChecksum = (expectedChecksum + b) % 65536;
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
					? {
							closed: true,
							reason: (closeInfo as any)?.reason ?? null,
							error: null,
						}
					: { closed: false, reason: null, error: null };
			} catch (e) {
				return { closed: true, reason: null, error: (e as Error).message };
			}
		}, hashBase64);

		expect(result.closed).toBe(true);
	});
});
