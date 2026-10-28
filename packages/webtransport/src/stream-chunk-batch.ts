/**
 * Receive-side stream chunk batching: one N-API crossing per *burst* of
 * arrived stream data instead of one per quinn assembler chunk.
 *
 * The addon's `readBatch(maxBytes)` parks for the first chunk and then takes
 * only what is already queued — no timer, no fill wait — so a batch is exactly
 * "everything that had arrived by the time the first chunk did". Terminal
 * events (FIN / RESET / STOP_SENDING) are never merged into a batch: a batch
 * that runs into one delivers its bytes and leaves the terminal event to be
 * observed by the next call.
 *
 * The lever is OFF by default. With `WEBTRANSPORT_STREAM_BATCH_BYTES` unset
 * every receive path calls `read()` exactly as before, byte for byte.
 *
 * Native only, following the H7 datagram-batching precedent: the wasm backend
 * coalesces internally under identical semantics and has no crossing to
 * amortize.
 */

const STREAM_BATCH_ENV = "WEBTRANSPORT_STREAM_BATCH_BYTES";
const STREAM_BATCH_DIAGNOSTICS_ENV = "WEBTRANSPORT_STREAM_BATCH_DIAGNOSTICS";

/** The addon's own ceiling on one crossing; a larger request is clamped there. */
const MAX_STREAM_BATCH_BYTES = 1024 * 1024;

/**
 * Resolve the per-crossing byte budget from its raw environment value.
 *
 * Mirrors the datagram-batch parser: anything that is not a plain decimal
 * integer — empty, non-numeric, fractional, exponential, hex, Infinity — is
 * invalid and leaves the lever off, and a non-positive value is an explicit
 * "off" rather than a fallback. Positive values are clamped into
 * `1..=MAX_STREAM_BATCH_BYTES`; the addon clamps again against the per-stream
 * receive window, which it is the only side that knows.
 */
export function parseStreamBatchBytes(raw: string | undefined): number {
	if (raw === undefined) return 0;
	const trimmed = raw.trim();
	if (!/^[+-]?\d+$/.test(trimmed)) return 0;
	const value = Number(trimmed);
	// Not redundant with the regex: a decimal-integer string long enough to
	// overflow a double still matches it and converts to Infinity.
	if (!Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	return value > MAX_STREAM_BATCH_BYTES ? MAX_STREAM_BATCH_BYTES : value;
}

// Both knobs are read exactly once, here, so a process cannot change delivery
// shape halfway through a stream's lifetime.
const streamBatchBytes = parseStreamBatchBytes(process.env[STREAM_BATCH_ENV]);
const streamBatchDiagnosticsEnabled =
	process.env[STREAM_BATCH_DIAGNOSTICS_ENV] === "1";

/**
 * G5's instrument. `meanBytesPerCrossing` is the gate's crossing clause, and it
 * is recorded on the unbatched path too — the control arm and the batched arm
 * are measured by the same counter or the comparison means nothing.
 */
export type StreamBatchDiagnostics = {
	/** Crossings that returned stream bytes. */
	dataCrossings: number;
	/** Crossings that returned EOF or an error code. */
	terminalCrossings: number;
	/** Crossings that used `readBatch`; the rest used the legacy `read`. */
	batchedCrossings: number;
	bytes: number;
	meanBytesPerCrossing: number;
	maxBatchBytes: number;
	elapsedMs: number;
	crossingsPerSecond: number;
};

const counters = {
	dataCrossings: 0,
	terminalCrossings: 0,
	batchedCrossings: 0,
	bytes: 0,
	maxBatchBytes: 0,
	since: 0,
};

function elapsedMs(): number {
	if (counters.since === 0) return 0;
	return Math.max(0, performance.now() - counters.since);
}

export function streamBatchDiagnosticsSnapshot(): StreamBatchDiagnostics {
	const ms = elapsedMs();
	const crossings = counters.dataCrossings + counters.terminalCrossings;
	return {
		dataCrossings: counters.dataCrossings,
		terminalCrossings: counters.terminalCrossings,
		batchedCrossings: counters.batchedCrossings,
		bytes: counters.bytes,
		meanBytesPerCrossing:
			counters.dataCrossings > 0 ? counters.bytes / counters.dataCrossings : 0,
		maxBatchBytes: counters.maxBatchBytes,
		elapsedMs: ms,
		crossingsPerSecond: ms > 0 ? (crossings * 1000) / ms : 0,
	};
}

/** Start a fresh measurement window (a probe calls this at phase start). */
export function resetStreamBatchDiagnostics(): void {
	counters.dataCrossings = 0;
	counters.terminalCrossings = 0;
	counters.batchedCrossings = 0;
	counters.bytes = 0;
	counters.maxBatchBytes = 0;
	counters.since = performance.now();
}

function recordCrossing(bytes: number, batched: boolean): void {
	if (counters.since === 0) counters.since = performance.now();
	if (batched) counters.batchedCrossings++;
	if (bytes > 0) {
		counters.dataCrossings++;
		counters.bytes += bytes;
		if (bytes > counters.maxBatchBytes) counters.maxBatchBytes = bytes;
	} else {
		counters.terminalCrossings++;
	}
}

/**
 * The receive-side of a native stream handle, as this module needs it.
 *
 * `readBatch` is optional so an older override addon (or the wasm-backed test
 * doubles) degrades to the legacy path instead of throwing; with the knob off
 * it is never called at all.
 */
export type BatchableRecvHandle = {
	read(): Promise<Uint8Array | string | null>;
	readBatch?: (maxBytes: number) => Promise<Uint8Array | string | null>;
};

/**
 * One receive-side crossing.
 *
 * Returns exactly what `read()` returns — payload, `null` for EOF, or the
 * never-reject error-code string — so every caller keeps its existing
 * handling, including the Node adapter's `push()`/`push(null)` contract and
 * BYOB readers, which see a larger chunk and nothing else.
 */
export async function readStreamChunk(
	handle: BatchableRecvHandle,
): Promise<Uint8Array | string | null> {
	const batch = streamBatchBytes > 0 ? handle.readBatch : undefined;
	const value = batch
		? await batch.call(handle, streamBatchBytes)
		: await handle.read();
	if (streamBatchDiagnosticsEnabled) {
		recordCrossing(
			value !== null && typeof value !== "string" ? value.byteLength : 0,
			batch !== undefined,
		);
	}
	return value;
}

/** Frozen snapshot of what this process resolved at module init. */
export function streamBatchConfig(): Readonly<{
	batchBytes: number;
	diagnosticsEnabled: boolean;
	maxBatchBytes: number;
}> {
	return Object.freeze({
		batchBytes: streamBatchBytes,
		diagnosticsEnabled: streamBatchDiagnosticsEnabled,
		maxBatchBytes: MAX_STREAM_BATCH_BYTES,
	});
}
