/**
 * Stable error codes for WebTransport operations (AGENTS.md / docs/SPEC.md).
 * Use with WebTransportError.code for programmatic handling.
 */

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
/** Internal/unsupported option or unexpected error. */
export const E_INTERNAL = "E_INTERNAL";

export type ErrorCode =
  | typeof E_TLS
  | typeof E_HANDSHAKE_TIMEOUT
  | typeof E_SESSION_CLOSED
  | typeof E_SESSION_IDLE_TIMEOUT
  | typeof E_STREAM_RESET
  | typeof E_STOP_SENDING
  | typeof E_QUEUE_FULL
  | typeof E_BACKPRESSURE_TIMEOUT
  | typeof E_LIMIT_EXCEEDED
  | typeof E_RATE_LIMITED
  | typeof E_INTERNAL;

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

function codeToSource(code: ErrorCode): WebTransportErrorSource {
  switch (code) {
    case E_STREAM_RESET:
    case E_STOP_SENDING:
      return "stream";
    default:
      return "session";
  }
}
