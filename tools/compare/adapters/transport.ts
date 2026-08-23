import type { CapacityProfile, RuntimeScenarioParameters } from "../types.ts";
import type { WireMessage } from "../wire.ts";

/** Delivery semantics shared by the WS and WT adapters. */
export type DeliveryKind = "datagram" | "reliable-message";

export type TransportKind = "ws" | "wt";

export type SocketPayload = string | ArrayBuffer | ArrayBufferView;

export type WebSocketTransportErrorCode =
	| "E_BACKPRESSURE_TIMEOUT"
	| "E_HANDSHAKE_TIMEOUT"
	| "E_LIMIT_EXCEEDED"
	| "E_QUEUE_FULL"
	| "E_RATE_LIMITED"
	| "E_SESSION_CLOSED"
	| "E_TLS"
	| "E_INTERNAL";

/** Stable errors emitted by the comparison adapters. */
export class WebSocketTransportError extends Error {
	readonly code: WebSocketTransportErrorCode;
	override readonly cause?: unknown;

	constructor(
		code: WebSocketTransportErrorCode,
		message: string,
		options?: { readonly cause?: unknown },
	) {
		super(`${code}: ${message}`);
		this.name = "WebSocketTransportError";
		this.code = code;
		this.cause = options?.cause;
	}
}

/** Injectable time source used by all bounded adapter waits and token buckets. */
export interface TransportClock {
	nowMs(): number;
	sleep(milliseconds: number): Promise<void>;
}

export const systemTransportClock: TransportClock = Object.freeze({
	nowMs: () => Date.now(),
	sleep: (milliseconds: number) =>
		new Promise<void>((resolve) => {
			setTimeout(resolve, Math.max(0, milliseconds));
		}),
});

export interface AdmissionCounters {
	readonly sessionsActive: number;
	readonly handshakesInFlight: number;
	readonly handshakesAttempted: number;
	readonly handshakesAccepted: number;
	readonly handshakesRejected: number;
	readonly streamOpenAttempts: number;
	readonly streamOpenAccepted: number;
	readonly streamOpenRejected: number;
	readonly datagramAttempts: number;
	readonly datagramAccepted: number;
	readonly datagramRejected: number;
	readonly tokenBucketRejected: number;
}

/**
 * Transport counters intentionally do not collapse admission and delivery.
 * In particular, `queued` is not `serverObserved`, and neither is delivery.
 */
export interface TransportMetrics extends AdmissionCounters {
	readonly attempted: number;
	readonly queued: number;
	readonly serverObserved: number;
	readonly acknowledged: number;
	readonly delivered: number;
	readonly refused: number;
	readonly dropped: number;
	readonly timedOut: number;
	readonly sessionsOpened: number;
	readonly sessionsClosed: number;
	readonly streamsOpened: number;
	readonly streamsAccepted: number;
	readonly streamsClosed: number;
	readonly active: boolean;
	readonly queueBytes: number;
	readonly queueBytesPeak: number;
	readonly receiveQueueItems: number;
	readonly receiveQueueBytes: number;
	readonly role?: string;
}

export interface SubmittedCapacityProfile {
	readonly profile: CapacityProfile;
	readonly bytes: string;
	readonly hash: string;
}

export interface SendObservation {
	readonly status: number;
	readonly bytes: number;
	readonly deliveryKind: DeliveryKind;
	readonly attempted: true;
	readonly queued: boolean;
	readonly serverObserved: false;
	readonly acknowledged: false;
	readonly delivered: false;
	readonly channelId?: number;
}

export interface ClientTlsOptions {
	readonly ca?:
		| string
		| ArrayBuffer
		| ArrayBufferView
		| readonly (string | ArrayBuffer | ArrayBufferView)[];
	readonly serverName?: string;
	readonly rejectUnauthorized?: boolean;
	readonly [key: string]: unknown;
}

export interface ServerTlsOptions {
	readonly cert?: string | ArrayBuffer | ArrayBufferView;
	readonly key?: string | ArrayBuffer | ArrayBufferView;
	readonly serverName?: string;
	readonly [key: string]: unknown;
}

export interface ClientConfig {
	readonly url: string;
	readonly role: string;
	readonly tls?: ClientTlsOptions;
	readonly deadlineMs: number;
	readonly sourceKey?: string;
	readonly clientHighWaterMark?: number;
	readonly clientLowWaterMark?: number;
	readonly clientWatermarkPollMs?: number;
	readonly parameters?: RuntimeScenarioParameters;
}

export interface ServerConfig {
	readonly hostname?: string;
	readonly port: number;
	readonly role?: string;
	readonly tls?: ServerTlsOptions;
	readonly sourceKey?: string;
	readonly parameters?: RuntimeScenarioParameters;
	readonly capacityProfile?: CapacityProfile;
}

export interface ChannelConfig {
	readonly sourceKey?: string;
}

export interface ClientWebSocketLike {
	readonly readyState: number;
	bufferedAmount: number;
	binaryType?: "blob" | "arraybuffer" | "nodebuffer" | "uint8array";
	send(data: SocketPayload): void;
	close(code?: number, reason?: string): void;
	addEventListener(type: string, listener: EventListener): void;
	removeEventListener(type: string, listener: EventListener): void;
}

export interface ServerWebSocketLike<T = unknown> {
	readonly readyState: number;
	readonly remoteAddress?: string;
	data: T;
	send(data: SocketPayload, compress?: boolean): number;
	close(code?: number, reason?: string): void;
	addEventListener?(type: string, listener: EventListener): void;
	removeEventListener?(type: string, listener: EventListener): void;
}

export interface WebSocketHandler<T = unknown> {
	readonly data?: T;
	readonly maxPayloadLength: number;
	readonly backpressureLimit: number;
	readonly closeOnBackpressureLimit: boolean;
	readonly idleTimeout: number;
	readonly perMessageDeflate: false;
	readonly open: (socket: ServerWebSocketLike<T>) => void | Promise<void>;
	readonly message: (
		socket: ServerWebSocketLike<T>,
		message: string | ArrayBuffer | ArrayBufferView,
	) => void | Promise<void>;
	readonly drain: (socket: ServerWebSocketLike<T>) => void | Promise<void>;
	readonly close: (
		socket: ServerWebSocketLike<T>,
		code: number,
		reason: string,
	) => void | Promise<void>;
	readonly error?: (
		socket: ServerWebSocketLike<T>,
		error: unknown,
	) => void | Promise<void>;
}

export interface WebSocketServerRuntimeOptions {
	readonly hostname?: string;
	readonly port: number;
	readonly tls?: ServerTlsOptions;
	readonly websocket: WebSocketHandler;
	readonly fetch?: (
		request: Request,
		server: unknown,
	) => Response | undefined | Promise<Response | undefined>;
}

export interface WebSocketServerRuntime {
	stop(closeActiveConnections?: boolean): void | Promise<void>;
}

export type ClientSocketFactory = (
	url: string,
	options: ClientWebSocketOptions,
) => ClientWebSocketLike;

export interface ClientWebSocketOptions {
	readonly tls?: ClientTlsOptions;
	readonly perMessageDeflate: false;
	readonly protocol?: string;
	readonly protocols?: string | readonly string[];
}

export type WebSocketServerFactory = (
	options: WebSocketServerRuntimeOptions,
) => WebSocketServerRuntime;

export interface SendChannel {
	readonly channelId: number;
	write(bytes: Uint8Array, deadlineMs: number): Promise<SendObservation>;
	end(deadlineMs: number): Promise<void>;
}

export interface ReceiveChannel {
	readonly channelId: number;
	read(deadlineMs: number): Promise<Uint8Array | null>;
	cancel(deadlineMs: number): Promise<void>;
}

export interface BidiChannel extends SendChannel, ReceiveChannel {}

export interface Session {
	readonly role: string;
	sendMessage(
		kind: DeliveryKind,
		message: WireMessage,
		deadlineMs: number,
	): Promise<SendObservation>;
	receiveMessage(kind: DeliveryKind, deadlineMs: number): Promise<WireMessage>;
	sendText(text: string, deadlineMs: number): Promise<SendObservation>;
	openUni(deadlineMs: number, options?: ChannelConfig): Promise<SendChannel>;
	acceptUni(deadlineMs: number): Promise<ReceiveChannel>;
	openBidi(deadlineMs: number, options?: ChannelConfig): Promise<BidiChannel>;
	acceptBidi(deadlineMs: number): Promise<BidiChannel>;
	close(deadlineMs: number): Promise<void>;
	snapshot(): TransportMetrics;
}

export interface ServerHandle {
	acceptSession(deadlineMs: number): Promise<Session>;
	stop(deadlineMs: number): Promise<void>;
	snapshot(): TransportMetrics;
}

export interface TransportAdapter {
	readonly kind: TransportKind;
	readonly submittedCapacityProfile: SubmittedCapacityProfile;
	startServer(config: ServerConfig): Promise<ServerHandle>;
	connect(config: ClientConfig): Promise<Session>;
}
