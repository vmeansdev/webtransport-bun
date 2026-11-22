// Wire format shared by the content server and its client.
//
// A transfer starts with the client opening one bidirectional "control"
// stream, writing a JSON request and closing its write side. The server opens
// one unidirectional stream per requested transfer and, once every one of
// them has been acknowledged by the client, answers on the control stream with
// a JSON summary and closes it.
//
//   request  client -> server   control stream, JSON, then FIN
//   payload  server -> client   one uni stream each: 4-byte index, then bytes
//   summary  server -> client   control stream, JSON, then FIN

export type BulkRequest = {
	streams: number;
	bytesPerStream: number;
	chunkBytes: number;
};

export type BulkSummary = {
	/** Present when the server refused the request. */
	error?: string;
	streams: number;
	bytesSent: number;
	/** Failed transfer streams by error code, e.g. { E_STOP_SENDING: 1 }. */
	streamErrors: Record<string, number>;
	serverMs: number;
};

/** The request is tiny; anything longer is not a request. */
export const MAX_REQUEST_BYTES = 1024;
export const MAX_CHUNK_BYTES = 1024 * 1024;
export const HEADER_BYTES = 4;

export function validateRequest(
	value: unknown,
	limits: { maxStreams: number; maxChunkBytes: number },
): BulkRequest | string {
	if (typeof value !== "object" || value === null) return "not an object";
	const { streams, bytesPerStream, chunkBytes } = value as BulkRequest;
	if (!Number.isInteger(streams) || streams < 1 || streams > limits.maxStreams)
		return `streams must be 1..${limits.maxStreams}`;
	if (!Number.isSafeInteger(bytesPerStream) || bytesPerStream < 0)
		return "bytesPerStream must be a non-negative integer";
	if (
		!Number.isInteger(chunkBytes) ||
		chunkBytes < 1 ||
		chunkBytes > limits.maxChunkBytes
	)
		return `chunkBytes must be 1..${limits.maxChunkBytes}`;
	return { streams, bytesPerStream, chunkBytes };
}

// The payload byte at offset `o` of stream `index` is a pure function of both,
// so the client can check any byte it receives without the server telling it
// anything else. A stream's chunk buffer is built once and written repeatedly.
export function payloadByte(
	index: number,
	offset: number,
	chunkBytes: number,
): number {
	return ((offset % chunkBytes) + index * 7) & 0xff;
}

export function patternChunk(index: number, chunkBytes: number): Uint8Array {
	const chunk = new Uint8Array(chunkBytes);
	for (let i = 0; i < chunkBytes; i++)
		chunk[i] = payloadByte(index, i, chunkBytes);
	return chunk;
}

/** A stable key for counting failures: the E_* code when there is one. */
export function errorKey(err: unknown): string {
	const code = (err as { code?: unknown })?.code;
	if (typeof code === "string") return code;
	const message = err instanceof Error ? err.message : String(err);
	return /^E_[A-Z_]+/.exec(message)?.[0] ?? message;
}

export function countError(into: Record<string, number>, err: unknown) {
	const key = errorKey(err);
	into[key] = (into[key] ?? 0) + 1;
}

export function encodeJson(value: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(value));
}

export function decodeJson(bytes: Uint8Array): unknown {
	return JSON.parse(new TextDecoder().decode(bytes));
}
