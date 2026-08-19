/**
 * Stable error codes for WebTransport operations (AGENTS.md / docs/SPEC.md).
 * Use with WebTransportError.code for programmatic handling.
 */
import type { ErrorCode } from "./types.js";

/** W3C WebTransportErrorSource: stream or session. */
export type WebTransportErrorSource = "stream" | "session";
/** TLS/certificate failure. */
export const E_TLS = "E_TLS";
/** Connection handshake timed out (limits.handshakeTimeoutMs). */
export const E_HANDSHAKE_TIMEOUT = "E_HANDSHAKE_TIMEOUT";
/** Session already closed or in invalid state. */
export const E_SESSION_CLOSED = "E_SESSION_CLOSED";
/** Session idle timeout exceeded. */
export const E_SESSION_IDLE_TIMEOUT = "E_SESSION_IDLE_TIMEOUT";
/**
 * The server ended this session while shutting down (`server.close()`).
 *
 * Unlike its peers this code is a **close reason**, not a thrown
 * `WebTransportError.code`: it arrives as `CloseInfo.reason` paired with close
 * code `3993` (`SERVER_CLOSING_CLOSE_CODE`), which is why it is deliberately
 * absent from the native error-message parser's list. See `docs/SPEC.md`
 * ("Server shutdown close semantics").
 */
export const E_SERVER_CLOSING = "E_SERVER_CLOSING";
/** Stream was reset by peer. */
export const E_STREAM_RESET = "E_STREAM_RESET";
/** Peer sent stopSending. */
export const E_STOP_SENDING = "E_STOP_SENDING";
/** Queue/buffer full (backpressure). */
export const E_QUEUE_FULL = "E_QUEUE_FULL";
/** Backpressure wait exceeded timeout. */
export const E_BACKPRESSURE_TIMEOUT = "E_BACKPRESSURE_TIMEOUT";
/** Resource limit exceeded. */
export const E_LIMIT_EXCEEDED = "E_LIMIT_EXCEEDED";
/** Rate limit (token bucket) exceeded. */
export const E_RATE_LIMITED = "E_RATE_LIMITED";
/** Invalid argument values. */
export const E_INVALID_ARGUMENT = "E_INVALID_ARGUMENT";
/** Unsupported argument combinations / feature requests. */
export const E_UNSUPPORTED_ARGUMENT = "E_UNSUPPORTED_ARGUMENT";
/** Internal/unsupported option or unexpected error. */
export const E_INTERNAL = "E_INTERNAL";

export type { ErrorCode };

/** Options for WebTransportError (W3C-aligned). */
export type WebTransportErrorOptions = {
	source?: WebTransportErrorSource;
	streamErrorCode?: number | null;
	cause?: unknown;
	/**
	 * Browser-style DOMException name when known (e.g. NotSupportedError, TypeError).
	 * When set, Error.name is set to this for browser/isomorphic compatibility.
	 * E_* code is always preserved for programmatic handling.
	 */
	browserName?: string;
};

/**
 * Custom error class for WebTransport errors.
 * Carries a stable error code for programmatic handling.
 * W3C-aligned: source ("stream"|"session"), streamErrorCode.
 * When options.browserName is set, name is set for browser-compatible semantics.
 */
export class WebTransportError extends Error {
	readonly code: ErrorCode;
	readonly source: WebTransportErrorSource;
	readonly streamErrorCode: number | null;

	constructor(
		code: ErrorCode,
		message?: string,
		options?: WebTransportErrorOptions,
	) {
		super(message ?? code, { cause: options?.cause ?? { code } });
		this.name = options?.browserName ?? "WebTransportError";
		this.code = code;
		this.source = options?.source ?? codeToSource(code);
		this.streamErrorCode = options?.streamErrorCode ?? null;
	}
}

/**
 * Extract the QUIC application error code from an abort/cancel reason.
 *
 * Shared by both backends so `writable.abort(reason)` (RESET_STREAM) and
 * `readable.cancel(reason)` (STOP_SENDING) map a reason to a code identically
 * on native and wasm. Accepts a bare integer or anything carrying
 * `streamErrorCode`/`code`; anything else (including no reason) means 0.
 */
export function extractStreamErrorCode(reason: unknown): number {
	if (typeof reason === "number" && Number.isInteger(reason)) return reason;
	const o =
		reason && typeof reason === "object"
			? (reason as Record<string, unknown>)
			: null;
	if (o) {
		const c = (o.streamErrorCode ?? o.code) as unknown;
		if (typeof c === "number" && Number.isInteger(c)) return c;
	}
	return 0;
}

function codeToSource(code: ErrorCode): WebTransportErrorSource {
	switch (code) {
		case E_STREAM_RESET:
		case E_STOP_SENDING:
			return "stream";
		default:
			return "session";
	}
}

// ---------------------------------------------------------------------------
// Never-reject native sentinels
// ---------------------------------------------------------------------------

/**
 * Hot async napi methods resolve their error-code string instead of
 * rejecting: a rejected async napi call leaks a strong self-reference on
 * its handle under Bun (verified 1.3.14 and 1.4.0-canary), permanently
 * pinning the wrapper and its native state. ANY string result from those
 * methods is an error — there is deliberately no allowlist, so an unknown
 * code still throws instead of being delivered as payload.
 *
 * The thrown Error carries the full native reason as its message, exactly
 * like the rejections it replaces, so every downstream catch/mapping path
 * (toWebTransportError, extractMessageErrorCode) behaves unchanged.
 */
export function unwrapNativeValue<T>(result: T | string): T {
	if (typeof result === "string") throw new Error(result);
	return result;
}

/** Void-method variant of {@link unwrapNativeValue}: null/undefined = ok. */
export function unwrapNativeVoid(result: string | null | undefined): void {
	if (typeof result === "string") throw new Error(result);
}
