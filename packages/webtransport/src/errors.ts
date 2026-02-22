/**
 * Stable error codes for WebTransport operations.
 * These codes are part of the public API contract (AGENTS.md / docs/SPEC.md).
 */

export const E_TLS = "E_TLS";
export const E_HANDSHAKE_TIMEOUT = "E_HANDSHAKE_TIMEOUT";
export const E_SESSION_CLOSED = "E_SESSION_CLOSED";
export const E_SESSION_IDLE_TIMEOUT = "E_SESSION_IDLE_TIMEOUT";
export const E_STREAM_RESET = "E_STREAM_RESET";
export const E_STOP_SENDING = "E_STOP_SENDING";
export const E_QUEUE_FULL = "E_QUEUE_FULL";
export const E_BACKPRESSURE_TIMEOUT = "E_BACKPRESSURE_TIMEOUT";
export const E_LIMIT_EXCEEDED = "E_LIMIT_EXCEEDED";
export const E_RATE_LIMITED = "E_RATE_LIMITED";
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

/**
 * Custom error class for WebTransport errors.
 * Carries a stable error code for programmatic handling.
 */
export class WebTransportError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message?: string) {
    super(message ?? code);
    this.name = "WebTransportError";
    this.code = code;
  }
}
