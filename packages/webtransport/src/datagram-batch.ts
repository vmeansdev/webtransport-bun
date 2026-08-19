/**
 * The datagram batch cap and the chunking that keeps callers from ever meeting
 * it.
 *
 * The cap is one number in this codebase. Native holds the only other copy, in
 * `crates/native/src/datagram_batch.rs`, and
 * `packages/webtransport/test/datagram-send-batch.test.ts` asserts the two
 * agree and that no third has appeared.
 */

/**
 * Largest batch one datagram call may carry — receive or send.
 *
 * Batching exists to amortize the N-API round trip and the win is flat well
 * before here; a larger cap only widens the window in which payloads sit
 * outside the queue's byte reservation.
 */
export const DATAGRAM_BATCH_MAX = 256;

/** What native resolves for a batched send: prefix semantics, never a throw. */
export type NativeDatagramBatchResult = {
	sent: number;
	code?: string;
};

/**
 * Send `datagrams` through `send`, which may take at most
 * {@link DATAGRAM_BATCH_MAX} elements per call.
 *
 * Prefix semantics survive the chunking: `sent` is an absolute count into the
 * caller's array, so the failing element is always at index `sent`, whichever
 * chunk it landed in, and nothing after it was attempted.
 *
 * Deliberately not an `async function`: argument validation must throw at the
 * call site rather than reject a promise the caller may not be awaiting yet,
 * and neither check crosses N-API, so throwing costs nothing.
 */
export function sendDatagramBatchChunked(
	send: (chunk: Uint8Array[]) => Promise<NativeDatagramBatchResult>,
	datagrams: readonly Uint8Array[],
): Promise<NativeDatagramBatchResult> {
	if (!Array.isArray(datagrams)) {
		throw new TypeError("sendDatagramBatch expects an array of Uint8Array");
	}
	for (let i = 0; i < datagrams.length; i += 1) {
		if (!ArrayBuffer.isView(datagrams[i])) {
			throw new TypeError(
				`sendDatagramBatch expects Uint8Array elements; element ${i} is not one`,
			);
		}
	}
	if (datagrams.length === 0) return Promise.resolve({ sent: 0 });
	return sendChunks(send, datagrams);
}

async function sendChunks(
	send: (chunk: Uint8Array[]) => Promise<NativeDatagramBatchResult>,
	datagrams: readonly Uint8Array[],
): Promise<NativeDatagramBatchResult> {
	let sent = 0;
	for (let start = 0; start < datagrams.length; start += DATAGRAM_BATCH_MAX) {
		const chunk = datagrams.slice(
			start,
			start + DATAGRAM_BATCH_MAX,
		) as Uint8Array[];
		const result = await send(chunk);
		sent += result.sent;
		// A short chunk without a code cannot happen — native reports why it
		// stopped — but treating it as a stop keeps the prefix honest rather
		// than silently skipping to the next chunk over an unsent element.
		if (result.code !== undefined) return { sent, code: result.code };
		if (result.sent < chunk.length) return { sent };
	}
	return { sent };
}
