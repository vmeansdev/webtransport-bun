/**
 * Shared W3C WebTransport constructor-option validation.
 * Used by the native facade and the wasm facade so option errors stay aligned.
 */

import type { ErrorCode } from "./types.js";
import {
	E_BACKPRESSURE_TIMEOUT,
	E_HANDSHAKE_TIMEOUT,
	E_INTERNAL,
	E_INVALID_ARGUMENT,
	E_LIMIT_EXCEEDED,
	E_QUEUE_FULL,
	E_RATE_LIMITED,
	E_SESSION_CLOSED,
	E_SESSION_IDLE_TIMEOUT,
	E_STOP_SENDING,
	E_STREAM_RESET,
	E_TLS,
	E_UNSUPPORTED_ARGUMENT,
	WebTransportError,
} from "./errors.js";

export type W3CCongestionControl = "default" | "throughput" | "low-latency";
export type W3CDatagramsReadableType = "bytes" | "default";

export type W3CClientOptionSurface = {
	strictW3CErrors?: boolean;
	allowPooling?: boolean;
	requireUnreliable?: boolean;
	congestionControl?: W3CCongestionControl;
	datagramsReadableType?: W3CDatagramsReadableType;
	serverCertificateHashes?: Array<{
		algorithm: "sha-256";
		value: ArrayBuffer | ArrayBufferView;
	}>;
};

const VALID_CONGESTION = new Set<string>([
	"default",
	"throughput",
	"low-latency",
]);
const VALID_DATAGRAMS_READABLE_TYPE = new Set<string>(["bytes", "default"]);

export function normalizeW3CBrowserName(code: ErrorCode): string | undefined {
	switch (code) {
		case E_INVALID_ARGUMENT:
			return "TypeError";
		case E_UNSUPPORTED_ARGUMENT:
			return "NotSupportedError";
		case E_TLS:
			return "NetworkError";
		case E_HANDSHAKE_TIMEOUT:
		case E_BACKPRESSURE_TIMEOUT:
			return "TimeoutError";
		case E_SESSION_CLOSED:
		case E_SESSION_IDLE_TIMEOUT:
			return "InvalidStateError";
		case E_STREAM_RESET:
		case E_STOP_SENDING:
			return "AbortError";
		case E_LIMIT_EXCEEDED:
		case E_QUEUE_FULL:
		case E_RATE_LIMITED:
			return "QuotaExceededError";
		case E_INTERNAL:
			return "OperationError";
		default: {
			const _exhaustive: never = code;
			void _exhaustive;
			return undefined;
		}
	}
}

export function createW3CMappedError(
	code: ErrorCode,
	message: string,
	strictW3CErrors?: boolean,
	options?: { streamErrorCode?: number | null },
): WebTransportError {
	const browserName =
		strictW3CErrors === true ? normalizeW3CBrowserName(code) : undefined;
	return new WebTransportError(code, message, {
		browserName,
		streamErrorCode: options?.streamErrorCode,
	});
}

/**
 * Validate W3C-shaped constructor options. Throws stable E_* (and optional
 * browser names) — never silently ignores unknown/invalid values for the
 * declared option surface.
 */
export function validateW3CClientOptions(
	opts?: W3CClientOptionSurface,
	strictW3CErrors?: boolean,
): void {
	if (!opts) return;
	const strict = strictW3CErrors ?? opts.strictW3CErrors;
	if (
		opts.allowPooling !== undefined &&
		typeof opts.allowPooling !== "boolean"
	) {
		throw createW3CMappedError(
			E_INVALID_ARGUMENT,
			"E_INVALID_ARGUMENT: allowPooling must be a boolean",
			strict,
		);
	}
	if (
		opts.requireUnreliable !== undefined &&
		typeof opts.requireUnreliable !== "boolean"
	) {
		throw createW3CMappedError(
			E_INVALID_ARGUMENT,
			"E_INVALID_ARGUMENT: requireUnreliable must be a boolean",
			strict,
		);
	}
	if (
		opts.congestionControl !== undefined &&
		!VALID_CONGESTION.has(opts.congestionControl)
	) {
		throw createW3CMappedError(
			E_INVALID_ARGUMENT,
			`E_INVALID_ARGUMENT: congestionControl must be "default", "throughput", or "low-latency", got "${opts.congestionControl}"`,
			strict,
		);
	}
	if (
		opts.datagramsReadableType !== undefined &&
		!VALID_DATAGRAMS_READABLE_TYPE.has(opts.datagramsReadableType)
	) {
		throw createW3CMappedError(
			E_INVALID_ARGUMENT,
			`E_INVALID_ARGUMENT: datagramsReadableType must be "bytes" or "default", got "${opts.datagramsReadableType}"`,
			strict,
		);
	}
	if (opts.serverCertificateHashes !== undefined) {
		if (!Array.isArray(opts.serverCertificateHashes)) {
			throw createW3CMappedError(
				E_INVALID_ARGUMENT,
				"E_INVALID_ARGUMENT: serverCertificateHashes must be an array",
				strict,
			);
		}
		if (opts.serverCertificateHashes.length === 0) {
			throw createW3CMappedError(
				E_INVALID_ARGUMENT,
				"E_INVALID_ARGUMENT: serverCertificateHashes must be a non-empty array",
				strict,
			);
		}
		if (opts.allowPooling === true) {
			// W3C mandates NotSupportedError for this combination.
			throw createW3CMappedError(
				E_UNSUPPORTED_ARGUMENT,
				"E_UNSUPPORTED_ARGUMENT: serverCertificateHashes cannot be used with allowPooling=true",
				true,
			);
		}
	}
}
