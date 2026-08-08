/** Maximum complete stream body retained by the example echo/broadcast apps. */
export const EXAMPLE_MAX_STREAM_BODY_BYTES = 256 * 1024;

type AsyncChunkSource = AsyncIterable<Uint8Array>;

/**
 * Collect a complete example body without allowing unbounded remote input.
 * The iterator is explicitly returned on overflow so the WebTransport stream
 * can stop producing data instead of continuing to feed a discarded body.
 */
export async function readLimitedChunks(
	source: AsyncChunkSource,
	maxBytes = EXAMPLE_MAX_STREAM_BODY_BYTES,
): Promise<Uint8Array[]> {
	const iterator = source[Symbol.asyncIterator]();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const next = await iterator.next();
			if (next.done) return chunks;
			const chunk = next.value;
			if (chunk.byteLength > maxBytes - totalBytes) {
				throw new RangeError(
					`stream body exceeds the ${maxBytes}-byte example limit`,
				);
			}
			chunks.push(chunk);
			totalBytes += chunk.byteLength;
		}
	} catch (error) {
		try {
			await iterator.return?.();
		} catch {
			// Preserve the bounded-body error if the transport is already closed.
		}
		throw error;
	}
}
