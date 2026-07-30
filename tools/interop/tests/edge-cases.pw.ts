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

type BrowserCloseInfo = {
	closeCode: number | null;
	reason: string | null;
};

type BrowserBidiCloseResult = {
	ok: boolean;
	where: string;
	info: BrowserCloseInfo | number[] | null;
};

type IdleTimeoutOutcome = {
	closed: boolean;
	closeCode: number | null;
	reason: string | null;
	errorName: string | null;
	errorMessage: string | null;
};

const IDLE_TIMEOUT_CLOSE_INFO = Object.freeze({
	closeCode: 3990,
	reason: "E_SESSION_IDLE_TIMEOUT",
});

function normalizeBrowserCloseInfo(
	outcome: Pick<IdleTimeoutOutcome, "closeCode" | "reason">,
): BrowserCloseInfo {
	return {
		// WebTransportCloseInfo defaults missing fields to 0/"". Some engines omit
		// unset members when serializing back through Playwright.
		closeCode: outcome.closeCode ?? 0,
		reason: outcome.reason ?? "",
	};
}

function hasStableIdleTimeoutCloseInfo(outcome: IdleTimeoutOutcome): boolean {
	if (!outcome.closed) {
		return false;
	}
	if (outcome.errorName != null || outcome.errorMessage != null) {
		return false;
	}
	const normalized = normalizeBrowserCloseInfo(outcome);
	return (
		normalized.closeCode === IDLE_TIMEOUT_CLOSE_INFO.closeCode &&
		normalized.reason === IDLE_TIMEOUT_CLOSE_INFO.reason
	);
}

async function waitForCloseEvent(
	code: number,
	reason: string,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = createMonotonicDeadline(timeoutMs);
	const closeEventsUrl = resolveInteropHealthUrl("/close-events");
	while (!deadline.expired()) {
		const res = await fetchWithTimeout(
			closeEventsUrl,
			{ cache: "no-store" },
			1_000,
			"close events fetch",
			deadline,
		);
		const body = (await promiseWithTimeout(
			res.json(),
			1_000,
			"close events json",
			deadline,
		)) as {
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
	test.beforeEach(async ({ page }) => {
		await page.addInitScript({
			content: BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
		});
	});

	test("bidi writer.close before read still preserves close code and reason to server", async ({
		page,
	}) => {
		await page.goto(resolveInteropHealthUrl());
		const hashBase64 = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();
		const closeCode = 4999;
		const closeReason = "Done streaming.";

		const browserResult: BrowserBidiCloseResult = await page.evaluate(
			async ({
				h,
				closeCode,
				closeReason,
				url,
			}: {
				h: string;
				closeCode: number;
				closeReason: string;
				url: string;
			}) => {
				type ReadWithTimeout = <T>(
					reader: ReadableStreamDefaultReader<T>,
					timeoutMs: number,
					label: string,
				) => Promise<ReadableStreamReadResult<T>>;
				type PromiseWithTimeout = <T>(
					promise: PromiseLike<T>,
					timeoutMs: number,
					label: string,
				) => Promise<T>;
				type BrowserGlobalScope = typeof globalThis & {
					__wtReadWithTimeout?: ReadWithTimeout;
					__wtWithTimeout?: PromiseWithTimeout;
				};
				type LocalCloseInfo = {
					closeCode?: number;
					reason?: string;
				};
				const readWithTimeout = (globalThis as BrowserGlobalScope)
					.__wtReadWithTimeout;
				const withTimeout = (globalThis as BrowserGlobalScope).__wtWithTimeout;
				if (!readWithTimeout || !withTimeout) {
					throw new Error("missing bounded browser init script");
				}
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "edge bidi ready");

				const stream = await wt.createBidirectionalStream();
				const writer = stream.writable.getWriter();
				await writer.write(new Uint8Array([1, 2, 3, 4]));
				await withTimeout(writer.ready, 5_000, "edge bidi writer ready");
				await writer.close();

				const reader = stream.readable.getReader();
				const first = await readWithTimeout(
					reader,
					5000,
					"edge-case pre-close bidi echo read",
				);
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
				const closed = await withTimeout(wt.closed, 5_000, "edge bidi close");
				return {
					ok: true,
					where: "closed",
					info: {
						closeCode: (closed as LocalCloseInfo)?.closeCode ?? null,
						reason: (closed as LocalCloseInfo)?.reason ?? null,
					},
				};
			},
			{
				h: hashBase64,
				closeCode,
				closeReason,
				url: interopOrigin,
			},
		);

		expect(browserResult.ok).toBe(true);
		expect((browserResult.info as BrowserCloseInfo | null)?.closeCode).toBe(
			closeCode,
		);
		expect((browserResult.info as BrowserCloseInfo | null)?.reason).toBe(
			closeReason,
		);

		const seenOnServer = await waitForCloseEvent(closeCode, closeReason, 6000);
		expect(seenOnServer).toBe(true);
	});

	test("client-initiated close code and reason propagate to server", async ({
		page,
	}) => {
		await page.goto(resolveInteropHealthUrl());
		const hashBase64 = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();
		const closeCode = 1234;
		const closeReason = "Bye bye";

		const browserClosed: BrowserCloseInfo = await page.evaluate(
			async ({
				h,
				closeCode,
				closeReason,
				url,
			}: {
				h: string;
				closeCode: number;
				closeReason: string;
				url: string;
			}) => {
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
				type LocalCloseInfo = {
					closeCode?: number;
					reason?: string;
				};
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "client close ready");
				wt.close({ closeCode, reason: closeReason });
				const info = await withTimeout(
					wt.closed,
					5_000,
					"client close settled",
				);
				return {
					closeCode: (info as LocalCloseInfo)?.closeCode ?? null,
					reason: (info as LocalCloseInfo)?.reason ?? null,
				};
			},
			{ h: hashBase64, closeCode, closeReason, url: interopOrigin },
		);
		expect(browserClosed.closeCode).toBe(closeCode);
		expect(browserClosed.reason).toBe(closeReason);

		const seenOnServer = await waitForCloseEvent(closeCode, closeReason, 6000);
		expect(seenOnServer).toBe(true);
	});

	test("close code and reason propagate on server-triggered close", async ({
		page,
	}) => {
		await page.goto(resolveInteropHealthUrl());
		const hashBase64 = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ h, url }) => {
				type ReadWithTimeout = <T>(
					reader: ReadableStreamDefaultReader<T>,
					timeoutMs: number,
					label: string,
				) => Promise<ReadableStreamReadResult<T>>;
				type BrowserGlobalScope = typeof globalThis & {
					__wtReadWithTimeout?: ReadWithTimeout;
					__wtWithTimeout?: <T>(
						promise: PromiseLike<T>,
						timeoutMs: number,
						label: string,
					) => Promise<T>;
				};
				type LocalCloseInfo = {
					closeCode?: number;
					reason?: string;
				};
				const readWithTimeout = (globalThis as BrowserGlobalScope)
					.__wtReadWithTimeout;
				const withTimeout = (globalThis as BrowserGlobalScope).__wtWithTimeout;
				if (!readWithTimeout || !withTimeout) {
					throw new Error("missing bounded browser init script");
				}
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "server close ready");
				const writer = wt.datagrams.writable.getWriter();
				await writer.write(new TextEncoder().encode("__WT_CLOSE_4001__"));
				writer.releaseLock();
				try {
					const closeInfo = await withTimeout(
						wt.closed,
						5_000,
						"server close settled",
					);
					return {
						closed: true,
						closeCode: (closeInfo as LocalCloseInfo)?.closeCode ?? null,
						reason: (closeInfo as LocalCloseInfo)?.reason ?? null,
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
			},
			{
				h: hashBase64,
				url: interopOrigin,
			},
		);

		// A QUIC CONNECTION_CLOSE told Chromium only that the connection was gone,
		// so this used to accept a bare "Connection lost". The server now sends a
		// CLOSE_WEBTRANSPORT_SESSION capsule, which is the only way Chromium can
		// report the code and reason — so demand both.
		expect(result.error).toBeNull();
		expect(result.closed).toBe(true);
		expect(result.closeCode).toBe(4001);
		expect(result.reason).toBe("interop-close");
	});

	test("large bidi payload round-trips", async ({ page }) => {
		await page.goto(resolveInteropHealthUrl());
		const hashBase64 = getCertHashBase64();
		const interopOrigin = resolveInteropOrigin();

		const result = await page.evaluate(
			async ({ h, url }) => {
				type ReadWithTimeout = <T>(
					reader: ReadableStreamDefaultReader<T>,
					timeoutMs: number,
					label: string,
				) => Promise<ReadableStreamReadResult<T>>;
				type BrowserGlobalScope = typeof globalThis & {
					__wtReadWithTimeout?: ReadWithTimeout;
					__wtWithTimeout?: <T>(
						promise: PromiseLike<T>,
						timeoutMs: number,
						label: string,
					) => Promise<T>;
				};
				const readWithTimeout = (globalThis as BrowserGlobalScope)
					.__wtReadWithTimeout;
				const withTimeout = (globalThis as BrowserGlobalScope).__wtWithTimeout;
				if (!readWithTimeout || !withTimeout) {
					throw new Error("missing bounded browser init script");
				}
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "large bidi ready");

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
					const { done, value } = await readWithTimeout(
						reader,
						5000,
						"edge-case large bidi payload read",
					);
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
			},
			{
				h: hashBase64,
				url: interopOrigin,
			},
		);

		expect(result.received).toBe(256 * 1024);
		expect(result.checksum).toBe(result.expectedChecksum);
	});

	test("idle timeout closes inactive session", async ({ page }) => {
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
				type LocalCloseInfo = { closeCode?: number; reason?: string };
				const opts: WebTransportOptions = {};
				if (h) {
					const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
					opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
				}
				const wt = new WebTransport(url, opts);
				await withTimeout(wt.ready, 5_000, "idle timeout ready");
				try {
					const closeInfo = await withTimeout(
						wt.closed,
						9_000,
						"idle timeout close",
					);
					return closeInfo
						? {
								closed: true,
								closeCode: (closeInfo as LocalCloseInfo)?.closeCode ?? null,
								reason: (closeInfo as LocalCloseInfo)?.reason ?? null,
								errorName: null,
								errorMessage: null,
							}
						: {
								closed: false,
								closeCode: null,
								reason: null,
								errorName: null,
								errorMessage: null,
							};
				} catch (e) {
					return {
						closed: true,
						closeCode: null,
						reason: null,
						errorName:
							e instanceof DOMException || e instanceof Error ? e.name : null,
						errorMessage: (e as Error).message,
					};
				}
			},
			{ h: hashBase64, url: interopOrigin },
		);

		expect(
			hasStableIdleTimeoutCloseInfo({
				closed: true,
				closeCode: 3990,
				reason: "E_SESSION_IDLE_TIMEOUT",
				errorName: null,
				errorMessage: null,
			}),
		).toBe(true);
		expect(
			hasStableIdleTimeoutCloseInfo({
				closed: true,
				closeCode: 0,
				reason: "E_SESSION_IDLE_TIMEOUT",
				errorName: null,
				errorMessage: null,
			}),
		).toBe(false);
		expect(
			hasStableIdleTimeoutCloseInfo({
				closed: true,
				closeCode: 3990,
				reason: "E_SESSION_IDLE_TIMEOUT: idle timeout",
				errorName: null,
				errorMessage: null,
			}),
		).toBe(false);
		expect(
			hasStableIdleTimeoutCloseInfo({
				closed: false,
				closeCode: null,
				reason: null,
				errorName: "NetworkError",
				errorMessage: "timeout after 9000ms: idle timeout close",
			}),
		).toBe(false);
		// Chromium may resolve wt.closed with stable idle close info, or reject
		// with WebTransportError("Connection lost.") — same tolerance as the
		// server-triggered close case. Server close-events must still record 3990.
		expect(result.closed).toBe(true);
		if (result.closeCode != null) {
			expect(hasStableIdleTimeoutCloseInfo(result)).toBe(true);
		} else {
			expect(result.errorMessage ?? "").toContain("Connection lost");
		}
		expect(
			await waitForCloseEvent(
				IDLE_TIMEOUT_CLOSE_INFO.closeCode,
				IDLE_TIMEOUT_CLOSE_INFO.reason,
				6_000,
			),
		).toBe(true);
	});
});
