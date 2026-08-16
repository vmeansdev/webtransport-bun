// Proves batched native datagram delivery survives a real Chromium peer.
//
// The interop server runs with WEBTRANSPORT_DATAGRAM_BATCH=4 (see the H7 block
// in docs/TESTPLAN.md), so a 100-datagram burst crosses ~25 batch boundaries.
// Every datagram carries a unique sequence id, which is what makes a batching
// defect visible: a dropped, duplicated, or reordered-into-corruption batch
// shows up as a missing or malformed id rather than as a byte-identical echo
// that any single-datagram test would also pass.
//
// QUIC datagrams are unreliable, so loss is tolerated and ordering is not
// asserted. What is asserted is that nothing is duplicated or corrupted, and
// that the overwhelming majority of the burst arrives inside a bounded window.
//
// The burst body is hoisted out of the test callback deliberately: it runs in
// the browser, and keeping it out of the callback lets
// `security-evidence.test.ts` prove the Playwright-side body contains no early
// return that could end the case before it asserts.

import { expect, test } from "@playwright/test";
import {
	BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
	resolveInteropHealthUrl,
	resolveInteropOrigin,
} from "../browser-helpers.js";
import { getCertHashBase64 } from "../cert-hash.js";

const BURST_SIZE = 100;
const MIN_UNIQUE_ECHOES = 95;
const ECHO_WINDOW_MS = 10_000;
const PAYLOAD_BYTES = 16;

type BurstArgs = {
	h: string | undefined;
	url: string;
	total: number;
	windowMs: number;
	payloadBytes: number;
};

type BurstOutcome = {
	error: string | null;
	sent: number;
	received: number;
	unique: number;
	duplicates: number;
	corrupt: number;
	timedOut: boolean;
};

const runBurst = async ({
	h,
	url,
	total,
	windowMs,
	payloadBytes,
}: BurstArgs): Promise<BurstOutcome> => {
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
	const outcome: BurstOutcome = {
		error: null,
		sent: 0,
		received: 0,
		unique: 0,
		duplicates: 0,
		corrupt: 0,
		timedOut: false,
	};

	const readWithTimeout = helpers.__wtReadWithTimeout;
	const withTimeout = helpers.__wtWithTimeout;
	if (!readWithTimeout || !withTimeout) {
		outcome.error = "missing bounded browser init script";
	} else {
		const opts: WebTransportOptions = {};
		if (h) {
			const bin = Uint8Array.from(atob(h), (c) => c.charCodeAt(0));
			opts.serverCertificateHashes = [{ algorithm: "sha-256", value: bin }];
		}

		// id in bytes 0..3, its bitwise complement in 4..7, then a byte pattern
		// derived from the id. Any single-bit flip or cross-datagram splice the
		// batch path could introduce breaks one of the three.
		const encode = (id: number): Uint8Array => {
			const bytes = new Uint8Array(payloadBytes);
			const view = new DataView(bytes.buffer);
			view.setUint32(0, id, false);
			view.setUint32(4, id ^ 0xffffffff, false);
			bytes.fill((id + 1) & 0xff, 8);
			return bytes;
		};

		const decode = (bytes: Uint8Array): number | null => {
			let id: number | null = null;
			if (bytes.byteLength === payloadBytes) {
				const view = new DataView(
					bytes.buffer,
					bytes.byteOffset,
					bytes.byteLength,
				);
				const candidate = view.getUint32(0, false);
				const complement = view.getUint32(4, false);
				const filler = (candidate + 1) & 0xff;
				const fillerIntact = bytes.subarray(8).every((byte) => byte === filler);
				const idInRange = candidate < total;
				const complementIntact = complement === (candidate ^ 0xffffffff) >>> 0;
				if (idInRange && complementIntact && fillerIntact) id = candidate;
			}
			return id;
		};

		let transport: WebTransport | null = null;
		try {
			const wt = new WebTransport(url, opts);
			transport = wt;
			await withTimeout(wt.ready, 5_000, "h7 burst ready");

			const reader = wt.datagrams.readable.getReader();
			const seen = new Set<number>();
			const deadline = performance.now() + windowMs;

			// Drain concurrently with the send so the browser's own receive
			// queue never has to hold the whole burst.
			const drain = (async () => {
				while (seen.size < total) {
					const remaining = deadline - performance.now();
					if (remaining <= 0) {
						outcome.timedOut = true;
						break;
					}
					const { value, done } = await readWithTimeout(
						reader,
						remaining,
						"h7 burst echo read",
					);
					if (done) break;
					if (!value) continue;
					outcome.received += 1;
					const id = decode(new Uint8Array(value));
					if (id === null) outcome.corrupt += 1;
					else if (seen.has(id)) outcome.duplicates += 1;
					else seen.add(id);
				}
			})().catch((error: unknown) => {
				const message = (error as Error).message;
				// A read that runs out the bounded window is the window closing,
				// not a harness failure; the echo count judges the run.
				if (/timeout|timed out/i.test(message)) outcome.timedOut = true;
				else outcome.error = message;
			});

			const writer = wt.datagrams.writable.getWriter();
			for (let id = 0; id < total; id += 1) {
				await writer.ready;
				await writer.write(encode(id));
				outcome.sent += 1;
			}
			writer.releaseLock();

			await drain;
			outcome.unique = seen.size;
			reader.releaseLock();
		} catch (error: unknown) {
			outcome.error = (error as Error).message;
		}
		try {
			transport?.close();
		} catch {
			// Session may already be gone; the counters above are the result.
		}
	}

	return outcome;
};

test.beforeEach(async ({ page }) => {
	await page.addInitScript({
		content: BROWSER_READ_WITH_TIMEOUT_INIT_SCRIPT,
	});
});

test("H7 batch=4 delivers a unique bounded Chromium burst", async ({
	page,
}) => {
	await page.goto(resolveInteropHealthUrl());

	const outcome = await page.evaluate(runBurst, {
		h: getCertHashBase64(),
		url: resolveInteropOrigin(),
		total: BURST_SIZE,
		windowMs: ECHO_WINDOW_MS,
		payloadBytes: PAYLOAD_BYTES,
	});

	expect(outcome.error).toBeNull();
	expect(outcome.sent).toBe(BURST_SIZE);
	// Unreliable transport: loss is tolerated, mangling is not.
	expect(outcome.corrupt).toBe(0);
	expect(outcome.duplicates).toBe(0);
	expect(outcome.unique).toBeLessThanOrEqual(BURST_SIZE);
	expect(outcome.unique).toBeGreaterThanOrEqual(MIN_UNIQUE_ECHOES);
});
