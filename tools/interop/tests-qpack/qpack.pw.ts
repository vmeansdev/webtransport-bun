/**
 * Dynamic-QPACK interop proof (CQ-3), run against real headless Chromium.
 *
 * The native addon server is started with WT_QPACK_MAX_TABLE_CAPACITY=4096 (see
 * playwright.qpack.config.ts), so it advertises a non-zero
 * SETTINGS_QPACK_MAX_TABLE_CAPACITY. Chromium connects over HTTP/3 WebTransport.
 *
 * WHAT THIS PROVES (the honest CQ-3 goal): native no longer *rejects* Chromium
 * when it advertises a dynamic-table capacity — the session establishes and the
 * data plane (datagram + bidi + uni echo) works with no QPACK_DECOMPRESSION_FAILED
 * and no QPACK_ENCODER_STREAM_ERROR. If native mis-decoded any encoder-stream
 * instruction Chromium sent, or advertised a table it could not honor, the
 * connection would fail the QPACK stream and these echoes would not complete.
 *
 * WHAT THIS DOES NOT PROVE: that Chromium actually emitted dynamic-table
 * *references* on the CONNECT. It cannot, and here is why, stated plainly:
 *   - A WebTransport session carries exactly one header exchange (the CONNECT
 *     request + its response). The request is the first thing sent, so nothing
 *     has been acknowledged yet; with SETTINGS_QPACK_BLOCKED_STREAMS = 0 (which
 *     native always advertises) an encoder MUST NOT reference an unacknowledged
 *     entry. So no dynamic *reference* is physically possible on this exchange,
 *     from Chromium or anyone.
 *   - The WebTransport API gives the application no way to add request headers,
 *     so the CONNECT header set is fixed and tiny; we cannot enlarge it to coax
 *     Chromium's encoder into the dynamic table.
 *   - At most Chromium could send encoder-stream *insert* instructions to prime
 *     its table for a future section that never comes. Whether it bothers is an
 *     internal encoder heuristic, and the fork exposes no native-side signal for
 *     it, so this test cannot assert native decoded Chromium's inserts.
 *
 * The decode-path correctness therefore rests on the fork's RFC 9204 Appendix B
 * vectors and its native<->native machinery unit tests; this interop test is the
 * no-regression-under-advertised-capacity proof. Do not read it as a Chromium
 * dynamic-QPACK decode proof.
 */

import { expect, test } from "@playwright/test";
import {
	BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
	resolveInteropHealthUrl,
	resolveInteropOrigin,
} from "../browser-helpers.js";
import { getCertHashBase64 } from "../cert-hash.js";

test.beforeEach(async ({ page }) => {
	await page.addInitScript({ content: BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT });
});

test("session + datagram + bidi + uni echo under advertised QPACK capacity, no QPACK errors", async ({
	page,
}) => {
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
				await withTimeout(wt.ready, 5_000, "qpack ready");

				// Datagram echo.
				const dgramText = "qpack-datagram";
				const dgramWriter = wt.datagrams.writable.getWriter();
				await dgramWriter.write(new TextEncoder().encode(dgramText));
				dgramWriter.releaseLock();
				const dgramReader = wt.datagrams.readable.getReader();
				const dgram = await readWithTimeout(
					dgramReader,
					5000,
					"qpack datagram read",
				);
				const dgramEcho = dgram.value
					? new TextDecoder().decode(dgram.value)
					: null;

				// Bidi stream echo.
				const bidiText = "qpack-bidi";
				const stream = await wt.createBidirectionalStream();
				const bidiWriter = stream.writable.getWriter();
				await bidiWriter.write(new TextEncoder().encode(bidiText));
				await bidiWriter.close();
				const bidiReader = stream.readable.getReader();
				const bidi = await readWithTimeout(bidiReader, 5000, "qpack bidi read");
				const bidiEcho = bidi.value
					? new TextDecoder().decode(bidi.value)
					: null;

				// Uni stream echo (server replies on a new uni stream).
				const uniText = "qpack-uni";
				const writable = await wt.createUnidirectionalStream();
				const uniWriter = writable.getWriter();
				await uniWriter.write(new TextEncoder().encode(uniText));
				await uniWriter.close();
				const incoming = wt.incomingUnidirectionalStreams.getReader();
				const incomingHandle = await readWithTimeout(
					incoming,
					5000,
					"qpack incoming uni handle",
				);
				let uniEcho: string | null = null;
				if (incomingHandle.value) {
					const r = incomingHandle.value.getReader();
					const uni = await readWithTimeout(r, 5000, "qpack uni read");
					uniEcho = uni.value ? new TextDecoder().decode(uni.value) : null;
				}

				await wt.close();
				return { ok: true, dgramEcho, bidiEcho, uniEcho };
			} catch (e: unknown) {
				return { ok: false, error: (e as Error).message };
			}
		},
		{ h: hashBase64, url: interopOrigin },
	);

	// Session established and every echo round-tripped: the connection did not
	// fail QPACK under an advertised dynamic table.
	expect(result.ok).toBe(true);
	expect(result.dgramEcho).toBe("qpack-datagram");
	expect(result.bidiEcho).toBe("qpack-bidi");
	expect(result.uniEcho).toBe("qpack-uni");

	// Belt-and-suspenders: no QPACK failure leaked into the surfaced error text.
	const errText = "error" in result ? (result.error ?? "") : "";
	expect(errText).not.toMatch(/QPACK/i);
});
