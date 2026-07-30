import {
	E_INTERNAL,
	E_TLS,
	type ErrorCode,
	WebTransportError,
} from "./errors.js";
import type { UdpAddr, UdpTransport } from "./wasm-relay.js";

/**
 * How a wasm client decides to trust the server: pin by SHA-256(DER), or
 * verify the chain against caller-supplied CA roots. Exactly one applies.
 */
export type WasmClientTrust =
	| { certHashesBase64: string; caPem?: never }
	| { caPem: string; certHashesBase64?: never };

/**
 * Map a wasm client-construction failure onto the same error codes native
 * reports, so a bad `caPem` surfaces as E_TLS on both backends rather than as
 * an opaque internal error.
 */
function clientConstructionError(error: string | undefined): WebTransportError {
	const message = error ?? "unknown error";
	const code = message.startsWith("E_TLS") ? E_TLS : E_INTERNAL;
	return new WebTransportError(
		code as ErrorCode,
		message.startsWith("E_") ? message : `${code}: ${message}`,
	);
}

/**
 * Host-facing ticket persistence for wasm 0-RTT (Bun-first; IndexedDB IWA
 * adapter can implement the same contract later). `take` is single-use.
 */
export interface TicketStoreHost {
	get(key: string): Promise<Uint8Array | null>;
	put(key: string, ticket: Uint8Array): Promise<void>;
	/** Consume and remove a ticket (anti-replay). */
	take(key: string): Promise<Uint8Array | null>;
}

/** Process-local TicketStoreHost with take-once semantics. */
export class MemoryTicketStoreHost implements TicketStoreHost {
	private readonly map = new Map<string, Uint8Array>();

	async get(key: string): Promise<Uint8Array | null> {
		const value = this.map.get(key);
		return value ? value.slice() : null;
	}

	async put(key: string, ticket: Uint8Array): Promise<void> {
		this.map.set(key, ticket.slice());
	}

	async take(key: string): Promise<Uint8Array | null> {
		const value = this.map.get(key);
		if (!value) return null;
		this.map.delete(key);
		return value.slice();
	}
}

const TEXT_DECODER = new TextDecoder();

/**
 * Format a UdpAddr the way Rust's `SocketAddr` Display/parse expects:
 * IPv6 hosts are bracketed (`[::1]:443`), IPv4/hostnames are bare.
 */
export function formatAddr(addr: UdpAddr): string {
	return addr.address.includes(":")
		? `[${addr.address}]:${addr.port}`
		: `${addr.address}:${addr.port}`;
}

/**
 * Parse a SocketAddr Display string ("ip:port") into an address/port pair.
 * Splits on the LAST ':' so IPv6 (e.g. "[::1]:443") works; surrounding brackets
 * are stripped from the host.
 */
function parseDest(dest: string): UdpAddr {
	const i = dest.lastIndexOf(":");
	const host = dest.slice(0, i);
	const port = Number(dest.slice(i + 1));
	const address =
		host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
	return { address, port };
}

// The wasm-bindgen (nodejs target) glue built by crates/wasm/build-wasm.sh.
// Typed structurally so the package does not hard-depend on generated artifacts.
export interface WasmModule {
	wt_new_endpoint(isServer: boolean, addr: string, peerAddr: string): number;
	wt_new_endpoint_with_options(configJson: string): string;
	wt_connect(eid: number, authority: string): number;
	wt_recv_packet(eid: number, data: Uint8Array, source: string): void;
	wt_poll_transmits(eid: number): Uint8Array;
	wt_next_timeout_ms(eid: number): number;
	wt_handle_timeout(eid: number): void;
	wt_poll_event(eid: number): Uint8Array | undefined;
	wt_release_host_reservation(eid: number, token: number): boolean;
	wt_take_last_error(eid: number): string;
	wt_governor_snapshot(eid: number): string;
	wt_send_datagram(
		eid: number,
		conn: number,
		sessionId: bigint | number,
		data: Uint8Array,
	): boolean;
	wt_max_datagram_size(
		eid: number,
		conn: number,
		sessionId: bigint | number,
	): number;
	wt_open_stream(
		eid: number,
		conn: number,
		sessionId: bigint | number,
		bidi: boolean,
	): number;
	wt_open_session(eid: number, conn: number): number;
	wt_close_session(
		eid: number,
		conn: number,
		sessionId: bigint | number,
		code: number,
		reason: string,
	): boolean;
	wt_drain_session(
		eid: number,
		conn: number,
		sessionId: bigint | number,
	): boolean;
	wt_stream_write(eid: number, stream: number, data: Uint8Array): number;
	wt_stream_pause(eid: number, stream: number): void;
	wt_stream_resume(eid: number, stream: number): void;
	wt_stream_finish(eid: number, stream: number): void;
	wt_stream_reset(eid: number, stream: number, code: number): void;
	wt_stream_stop(eid: number, stream: number, code: number): void;
	wt_conn_has_0rtt(eid: number, conn: number): boolean;
	wt_conn_accepted_0rtt(eid: number, conn: number): boolean;
	wt_conn_stats(eid: number, conn: number): string;
	/** Optional: absent on wasm packages built before the `peer` accessor landed. */
	wt_conn_peer?(eid: number, conn: number): string;
	wt_tls_snapshot?(eid: number): string;
	wt_update_tls?(eid: number, configJson: string): string;
	wt_enable_0rtt(eid: number): boolean;
	wt_dump_client_ticket(eid: number, serverName: string): Uint8Array;
	wt_import_client_ticket(
		eid: number,
		serverName: string,
		blob: Uint8Array,
	): boolean;
	wt_new_client(
		addr: string,
		peerAddr: string,
		certHashesBase64: string,
	): string;
	wt_new_client_with_options(configJson: string): string;
	wt_close_conn(eid: number, conn: number, code: number, reason: string): void;
	wt_close_all(eid: number, code: number, reason: string): void;
	wt_close_endpoint(eid: number): void;
	wt_generate_cert(
		commonName: string,
		validityDays: number,
		notBeforeUnix: number,
	): string;
	wt_new_server(
		addr: string,
		peerAddr: string,
		commonName: string,
		validityDays: number,
		notBeforeUnix: number,
	): string;
	wt_new_server_with_options(configJson: string): string;
}

const EVENT = {
	CONNECTED: 1,
	SESSION_ESTABLISHED: 2,
	DATAGRAM: 3,
	CLOSED: 4,
	STREAM_OPENED: 5,
	STREAM_DATA: 6,
	STREAM_RESET: 7,
	STREAM_STOPPED: 8,
	SESSION_CLOSED: 9,
	SESSION_DRAINING: 10,
} as const;

function decodeVarintSafe(
	buf: Uint8Array,
	off: number,
): [number, number] | null {
	if (off >= buf.length) return null;
	const first = buf[off] ?? 0;
	const len = 1 << (first >> 6);
	if (off + len > buf.length) return null;
	let v = first & 0x3f;
	for (let i = 1; i < len; i++) v = v * 256 + (buf[off + i] ?? 0);
	return [v, off + len];
}

function decodeVarintBig(
	buf: Uint8Array,
	off: number,
): [bigint, number] | null {
	if (off >= buf.length) return null;
	const first = buf[off] ?? 0;
	const len = 1 << (first >> 6);
	if (off + len > buf.length) return null;
	let v = BigInt(first & 0x3f);
	for (let i = 1; i < len; i++) v = v * 256n + BigInt(buf[off + i] ?? 0);
	return [v, off + len];
}

function requireSafeSessionId(sessionId: bigint): bigint | null {
	if (sessionId < 0n || sessionId > BigInt(Number.MAX_SAFE_INTEGER)) {
		return null;
	}
	return sessionId;
}

export type DecodedWasmEvent =
	| { type: "connected"; conn: number }
	| { type: "session-established"; conn: number; sessionId: bigint }
	| {
			type: "datagram";
			conn: number;
			sessionId: bigint;
			payload: Uint8Array;
			hostToken?: number;
	  }
	| { type: "closed"; conn: number; code: number }
	| {
			type: "session-closed";
			conn: number;
			sessionId: bigint;
			code: number;
			/** Peer's WT_CLOSE_SESSION reason; empty when it sent none. */
			reason: string;
	  }
	| { type: "session-draining"; conn: number; sessionId: bigint }
	| {
			type: "stream-opened";
			conn: number;
			sessionId: bigint;
			stream: number;
			bidi: boolean;
	  }
	| {
			type: "stream-data";
			conn: number;
			stream: number;
			payload: Uint8Array;
			fin: boolean;
			hostToken?: number;
	  }
	| { type: "stream-reset"; conn: number; stream: number; code: number }
	| { type: "stream-stopped"; conn: number; stream: number; code: number }
	| { type: "unknown"; tag: number };

// Host-token recovery on failure: a malformed (null) or unknown-tag event
// cannot have its embedded host token released here. The token is the TRAILING
// varint of DATAGRAM/STREAM_DATA events, so its position is only known after a
// full successful parse — every failure path below fails before/at the token
// bytes (truncation) or on an unknown layout, and guessing a token from the
// tail risks releasing a DIFFERENT live reservation (worse than the leak). The
// in-tree Rust encoder only ever emits well-formed events, so this arm is pure
// defense-in-depth; a leak here implies encoder corruption/version skew and is
// reclaimed at endpoint close (release_all_host_tokens).
export function decodeWasmEvent(ev: Uint8Array): DecodedWasmEvent | null {
	const tag = ev[0];
	if (tag == null) return null;
	let off = 1;
	const connResult = decodeVarintSafe(ev, off);
	if (!connResult) return null;
	const [conn, nextOff] = connResult;
	off = nextOff;
	switch (tag) {
		case EVENT.CONNECTED:
			return { type: "connected", conn };
		case EVENT.SESSION_ESTABLISHED: {
			const sid = decodeVarintBig(ev, off);
			if (!sid) return null;
			const sessionId = requireSafeSessionId(sid[0]);
			if (sessionId == null) return null;
			return {
				type: "session-established",
				conn,
				sessionId,
			};
		}
		case EVENT.DATAGRAM: {
			const sid = decodeVarintBig(ev, off);
			if (!sid) return null;
			off = sid[1];
			const lenResult = decodeVarintSafe(ev, off);
			if (!lenResult) return null;
			let len: number;
			[len, off] = lenResult;
			if (off + len > ev.length) return null;
			const payload = ev.subarray(off, off + len);
			off += len;
			const hostTokenResult =
				off < ev.length ? decodeVarintSafe(ev, off) : null;
			if (off < ev.length && !hostTokenResult) return null;
			const hostToken = hostTokenResult?.[0];
			const sessionId = requireSafeSessionId(sid[0]);
			if (sessionId == null) return null;
			return {
				type: "datagram",
				conn,
				sessionId,
				payload,
				hostToken: hostToken && hostToken > 0 ? hostToken : undefined,
			};
		}
		case EVENT.CLOSED: {
			const codeResult = decodeVarintSafe(ev, off);
			if (!codeResult) return null;
			return { type: "closed", conn, code: codeResult[0] };
		}
		case EVENT.SESSION_CLOSED: {
			const sid = decodeVarintBig(ev, off);
			if (!sid) return null;
			off = sid[1];
			const codeResult = decodeVarintSafe(ev, off);
			if (!codeResult) return null;
			let code: number;
			[code, off] = codeResult;
			const lenResult = decodeVarintSafe(ev, off);
			if (!lenResult) return null;
			let len: number;
			[len, off] = lenResult;
			if (off + len > ev.length) return null;
			const sessionId = requireSafeSessionId(sid[0]);
			if (sessionId == null) return null;
			return {
				type: "session-closed",
				conn,
				sessionId,
				code,
				reason: TEXT_DECODER.decode(ev.subarray(off, off + len)),
			};
		}
		case EVENT.SESSION_DRAINING: {
			const sid = decodeVarintBig(ev, off);
			if (!sid) return null;
			const sessionId = requireSafeSessionId(sid[0]);
			if (sessionId == null) return null;
			return { type: "session-draining", conn, sessionId };
		}
		case EVENT.STREAM_OPENED: {
			const sid = decodeVarintBig(ev, off);
			if (!sid) return null;
			off = sid[1];
			const streamResult = decodeVarintSafe(ev, off);
			if (!streamResult) return null;
			let stream: number;
			[stream, off] = streamResult;
			if (off >= ev.length) return null;
			const sessionId = requireSafeSessionId(sid[0]);
			if (sessionId == null) return null;
			return {
				type: "stream-opened",
				conn,
				sessionId,
				stream,
				bidi: (ev[off] ?? 0) === 1,
			};
		}
		case EVENT.STREAM_DATA: {
			const streamResult = decodeVarintSafe(ev, off);
			if (!streamResult) return null;
			let stream: number;
			[stream, off] = streamResult;
			if (off >= ev.length) return null;
			const fin = (ev[off] ?? 0) === 1;
			off += 1;
			const lenResult = decodeVarintSafe(ev, off);
			if (!lenResult) return null;
			let len: number;
			[len, off] = lenResult;
			if (off + len > ev.length) return null;
			const payload = ev.subarray(off, off + len);
			off += len;
			const hostTokenResult =
				off < ev.length ? decodeVarintSafe(ev, off) : null;
			if (off < ev.length && !hostTokenResult) return null;
			const hostToken = hostTokenResult?.[0];
			return {
				type: "stream-data",
				conn,
				stream,
				payload,
				fin,
				hostToken: hostToken && hostToken > 0 ? hostToken : undefined,
			};
		}
		case EVENT.STREAM_RESET: {
			const streamResult = decodeVarintSafe(ev, off);
			if (!streamResult) return null;
			let stream: number;
			[stream, off] = streamResult;
			const codeResult = decodeVarintSafe(ev, off);
			if (!codeResult) return null;
			return { type: "stream-reset", conn, stream, code: codeResult[0] };
		}
		case EVENT.STREAM_STOPPED: {
			const streamResult = decodeVarintSafe(ev, off);
			if (!streamResult) return null;
			let stream: number;
			[stream, off] = streamResult;
			const codeResult = decodeVarintSafe(ev, off);
			if (!codeResult) return null;
			return {
				type: "stream-stopped",
				conn,
				stream,
				code: codeResult[0],
			};
		}
		default:
			return { type: "unknown", tag };
	}
}

// INVARIANT (double-release safety): the catch blocks below release the raw
// hostToken after a throwing callback that may itself have already released the
// same token (via a manager reservation, e.g. WasmStream._deliverData). That
// second release is a safe no-op ONLY because both releases run synchronously
// within this one dispatch: Rust reuses freed token ids, and only wt_poll_event
// processing allocates new ones, so nothing can interleave and rebind the id to
// a different live reservation between the two calls. Any change that defers
// either release (queueMicrotask, await, re-entrant pump) breaks this.
export function dispatchDecodedWasmEvent(
	decoded: DecodedWasmEvent | null,
	events: WasmSessionEvents,
	releaseHostReservation: (token: number) => boolean = () => false,
): void {
	if (!decoded) return;
	switch (decoded.type) {
		case "connected":
			events.onConnected?.(decoded.conn);
			return;
		case "session-established":
			events.onEstablished?.(decoded.conn, decoded.sessionId);
			return;
		case "datagram": {
			const callback = events.onDatagram;
			if (callback) {
				try {
					callback(
						decoded.conn,
						decoded.sessionId,
						decoded.payload,
						decoded.hostToken,
					);
				} catch (error) {
					if (decoded.hostToken) releaseHostReservation(decoded.hostToken);
					throw error;
				}
			} else if (decoded.hostToken) {
				releaseHostReservation(decoded.hostToken);
			}
			return;
		}
		case "closed":
			events.onClosed?.(decoded.conn, decoded.code);
			return;
		case "session-closed":
			events.onSessionClosed?.(
				decoded.conn,
				decoded.sessionId,
				decoded.code,
				decoded.reason,
			);
			return;
		case "session-draining":
			events.onSessionDraining?.(decoded.conn, decoded.sessionId);
			return;
		case "stream-opened":
			events.onStreamOpened?.(
				decoded.conn,
				decoded.sessionId,
				decoded.stream,
				decoded.bidi,
			);
			return;
		case "stream-data": {
			const callback = events.onStreamData;
			if (callback) {
				try {
					callback(
						decoded.conn,
						decoded.stream,
						decoded.payload,
						decoded.fin,
						decoded.hostToken,
					);
				} catch (error) {
					if (decoded.hostToken) releaseHostReservation(decoded.hostToken);
					throw error;
				}
			} else if (decoded.hostToken) {
				releaseHostReservation(decoded.hostToken);
			}
			return;
		}
		case "stream-reset":
			events.onStreamReset?.(decoded.conn, decoded.stream, decoded.code);
			return;
		case "stream-stopped":
			events.onStreamStopped?.(decoded.conn, decoded.stream, decoded.code);
			return;
		case "unknown":
			return;
	}
}

export interface WasmSessionEvents {
	onConnected?: (conn: number) => void;
	onEstablished?: (conn: number, sessionId: bigint) => void;
	onDatagram?: (
		conn: number,
		sessionId: bigint,
		data: Uint8Array,
		hostToken?: number,
	) => void;
	onClosed?: (conn: number, code: number) => void;
	onSessionDraining?: (conn: number, sessionId: bigint) => void;
	onSessionClosed?: (
		conn: number,
		sessionId: bigint,
		code: number,
		reason: string,
	) => void;
	onStreamOpened?: (
		conn: number,
		sessionId: bigint,
		stream: number,
		bidi: boolean,
	) => void;
	onStreamData?: (
		conn: number,
		stream: number,
		data: Uint8Array,
		fin: boolean,
		hostToken?: number,
	) => void;
	onStreamReset?: (conn: number, stream: number, code: number) => void;
	/** Peer STOP_SENDING on our send half; the recv half is unaffected. */
	onStreamStopped?: (conn: number, stream: number, code: number) => void;
}

export interface WasmEndpointConstructorOptions {
	limits: {
		maxSessions: number;
		maxHandshakesInFlight: number;
		maxStreamsPerSessionBidi: number;
		maxStreamsPerSessionUni: number;
		maxStreamsGlobal: number;
		maxDatagramSize: number;
		maxQueuedBytesGlobal: number;
		maxQueuedBytesPerSession: number;
		maxQueuedBytesPerStream: number;
		backpressureTimeoutMs: number;
		handshakeTimeoutMs: number;
		idleTimeoutMs: number;
	};
	rateLimits: {
		handshakesPerSec: number;
		handshakesBurst: number;
		streamOpensPerSec: number;
		streamOpensBurst: number;
		datagramsIngressPerSec: number;
		datagramsIngressBurst: number;
	};
	/** Opt-in QUIC TLS 1.3 early data (0-RTT). Default false. */
	enable0Rtt?: boolean;
	/** Opt-in process-shared 0-RTT ticket store. Default false. */
	shareProcess0RttTicketStore?: boolean;
	/** Optional SETTINGS_WT_MAX_SESSIONS (forwarded to the Rust bridge). */
	wtMaxSessions?: number;
	qpackMaxTableCapacity?: number;
	qpackBlockedStreams?: number;
	enableDynamicQpack?: boolean;
}

function isConstructorOptions(
	value: WasmEndpointConstructorOptions | WasmSessionEvents,
): value is WasmEndpointConstructorOptions {
	return "limits" in value && "rateLimits" in value;
}

export class WasmEndpoint {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	private closing = false;
	private datagramSendError = "";
	private streamWriteError = "";
	private pumping = false;
	private pumpAgain = false;
	/** Reports an exception thrown by a user event callback during dispatch. */
	onError: ((err: unknown) => void) | null = null;
	/** Resolved on the next pump() — lets backpressured writers wake on real
	 * progress (inbound acks / timers) instead of a fixed busy-poll. */
	private drainWaiters: Array<{
		fire: () => void;
		timer?: ReturnType<typeof setTimeout>;
	}> = [];

	private constructor(
		private wasm: WasmModule,
		private udp: UdpTransport,
		private eid: number,
		private events: WasmSessionEvents = {},
	) {
		udp.onPacket((data, source) => {
			// Ignore packets that arrive after close(): the wasm-side endpoint
			// (this.eid) has been freed by wt_close_endpoint, so calling
			// wt_recv_packet on it would be a use-after-free on a freed/reused
			// eid. `closed` is set before the free, so this guard is race-safe.
			if (this.closed) return;
			// IPv6 sources must be bracketed or the Rust-side SocketAddr parse
			// fails closed as malformed source metadata.
			this.wasm.wt_recv_packet(this.eid, data, formatAddr(source));
			this.pump();
		});
	}

	/**
	 * Create a new endpoint (allocates the wasm-side endpoint).
	 *
	 * SECURITY: a CLIENT endpoint created this way accepts ANY server
	 * certificate — use {@link createPinnedClient} for production clients.
	 */
	static create(
		wasm: WasmModule,
		udp: UdpTransport,
		isServer: boolean,
		addr: string,
		peerAddr: string,
		optionsOrEvents: WasmEndpointConstructorOptions | WasmSessionEvents = {},
		events: WasmSessionEvents = {},
	): WasmEndpoint {
		const options = isConstructorOptions(optionsOrEvents)
			? optionsOrEvents
			: {
					limits: {
						maxSessions: 2000,
						maxHandshakesInFlight: 200,
						maxStreamsPerSessionBidi: 200,
						maxStreamsPerSessionUni: 200,
						maxStreamsGlobal: 50_000,
						maxDatagramSize: 1200,
						maxQueuedBytesGlobal: 512 * 1024 * 1024,
						maxQueuedBytesPerSession: 2 * 1024 * 1024,
						maxQueuedBytesPerStream: 256 * 1024,
						backpressureTimeoutMs: 5_000,
						handshakeTimeoutMs: 10_000,
						idleTimeoutMs: 60_000,
					},
					rateLimits: {
						handshakesPerSec: 20,
						handshakesBurst: 40,
						streamOpensPerSec: 200,
						streamOpensBurst: 400,
						datagramsIngressPerSec: 2000,
						datagramsIngressBurst: 5000,
					},
				};
		const sessionEvents = isConstructorOptions(optionsOrEvents)
			? events
			: optionsOrEvents;
		const parsed = JSON.parse(
			wasm.wt_new_endpoint_with_options(
				JSON.stringify({ isServer, addr, peerAddr, ...options }),
			),
		) as { eid?: number; error?: string };
		if (parsed.error || parsed.eid == null) {
			throw new Error(
				`wt_new_endpoint failed: ${parsed.error ?? "unknown error"}`,
			);
		}
		return new WasmEndpoint(wasm, udp, parsed.eid, sessionEvents);
	}

	/**
	 * Create a CLIENT endpoint that pins the server certificate by SHA-256 of
	 * its DER (the browser's `serverCertificateHashes` trust model). The TLS
	 * handshake fails against any other certificate.
	 */
	static createPinnedClient(
		wasm: WasmModule,
		udp: UdpTransport,
		addr: string,
		peerAddr: string,
		certHashesBase64: string,
		optionsOrEvents: WasmEndpointConstructorOptions | WasmSessionEvents = {},
		events: WasmSessionEvents = {},
	): WasmEndpoint {
		return WasmEndpoint.createClient(
			wasm,
			udp,
			addr,
			peerAddr,
			{ certHashesBase64 },
			optionsOrEvents,
			events,
		);
	}

	/**
	 * Create a CLIENT endpoint that verifies the server's chain against the CA
	 * roots in `caPem`. Nothing outside those roots is trusted — there is no
	 * bundled or system trust store on wasm.
	 */
	static createCaVerifiedClient(
		wasm: WasmModule,
		udp: UdpTransport,
		addr: string,
		peerAddr: string,
		caPem: string,
		optionsOrEvents: WasmEndpointConstructorOptions | WasmSessionEvents = {},
		events: WasmSessionEvents = {},
	): WasmEndpoint {
		return WasmEndpoint.createClient(
			wasm,
			udp,
			addr,
			peerAddr,
			{ caPem },
			optionsOrEvents,
			events,
		);
	}

	/** Shared client construction; `trust` selects pinning or CA roots. */
	private static createClient(
		wasm: WasmModule,
		udp: UdpTransport,
		addr: string,
		peerAddr: string,
		trust: WasmClientTrust,
		optionsOrEvents: WasmEndpointConstructorOptions | WasmSessionEvents = {},
		events: WasmSessionEvents = {},
	): WasmEndpoint {
		const options = isConstructorOptions(optionsOrEvents)
			? optionsOrEvents
			: {
					limits: {
						maxSessions: 2000,
						maxHandshakesInFlight: 200,
						maxStreamsPerSessionBidi: 200,
						maxStreamsPerSessionUni: 200,
						maxStreamsGlobal: 50_000,
						maxDatagramSize: 1200,
						maxQueuedBytesGlobal: 512 * 1024 * 1024,
						maxQueuedBytesPerSession: 2 * 1024 * 1024,
						maxQueuedBytesPerStream: 256 * 1024,
						backpressureTimeoutMs: 5_000,
						handshakeTimeoutMs: 10_000,
						idleTimeoutMs: 60_000,
					},
					rateLimits: {
						handshakesPerSec: 20,
						handshakesBurst: 40,
						streamOpensPerSec: 200,
						streamOpensBurst: 400,
						datagramsIngressPerSec: 2000,
						datagramsIngressBurst: 5000,
					},
				};
		const sessionEvents = isConstructorOptions(optionsOrEvents)
			? events
			: optionsOrEvents;
		const parsed = JSON.parse(
			wasm.wt_new_client_with_options(
				JSON.stringify({
					addr,
					peerAddr,
					...trust,
					...options,
				}),
			),
		) as { eid?: number; error?: string };
		if (parsed.error || parsed.eid == null) {
			throw clientConstructionError(parsed.error);
		}
		return new WasmEndpoint(wasm, udp, parsed.eid, sessionEvents);
	}

	/** Wrap an endpoint already created wasm-side (e.g. via wt_new_server). */
	static adopt(
		wasm: WasmModule,
		udp: UdpTransport,
		eid: number,
		events: WasmSessionEvents = {},
	): WasmEndpoint {
		return new WasmEndpoint(wasm, udp, eid, events);
	}

	// Every operation calls a wt_* function on this.eid. After close() has freed
	// the wasm-side endpoint (wt_close_endpoint), that eid is invalid and may be
	// reused by a later endpoint, so any call here would be a use-after-free (or
	// cross-endpoint injection). Guard each with `closed` — a parked writer whose
	// promise is released during close() can otherwise loop back into
	// streamWrite() as a microtask after the eid is freed.
	connect(authority: string): number {
		if (this.closed) return 0;
		const conn = this.wasm.wt_connect(this.eid, authority);
		this.pump();
		return conn;
	}

	sendDatagram(conn: number, sessionId: bigint, data: Uint8Array): boolean {
		this.datagramSendError = "";
		if (this.closed) {
			this.datagramSendError = "E_SESSION_CLOSED: endpoint is closed";
			return false;
		}
		const ok = this.wasm.wt_send_datagram(this.eid, conn, sessionId, data);
		// Capture the operation-scoped diagnostic before pump() dispatches any
		// unrelated close callback that might consume the endpoint's last error.
		if (!ok) this.datagramSendError = this.wasm.wt_take_last_error(this.eid);
		this.pump();
		return ok;
	}

	maxDatagramSize(conn: number, sessionId: bigint): number {
		if (this.closed) return -1;
		return this.wasm.wt_max_datagram_size(this.eid, conn, sessionId);
	}

	takeDatagramSendError(): string {
		const error = this.datagramSendError;
		this.datagramSendError = "";
		return error;
	}

	/** Open a WebTransport stream; returns its handle or -1. */
	openStream(conn: number, sessionId: bigint, bidi: boolean): number {
		if (this.closed) return -1;
		const s = this.wasm.wt_open_stream(this.eid, conn, sessionId, bidi);
		this.pump();
		return s;
	}

	openSession(conn: number): bigint | null {
		if (this.closed) return null;
		const sid = this.wasm.wt_open_session(this.eid, conn);
		this.pump();
		if (sid < 0) return null;
		return BigInt(sid);
	}

	closeSession(
		conn: number,
		sessionId: bigint,
		code: number,
		reason: string,
	): boolean {
		if (this.closed) return false;
		const ok = this.wasm.wt_close_session(
			this.eid,
			conn,
			sessionId,
			code,
			reason,
		);
		this.pump();
		return ok;
	}

	drainSession(conn: number, sessionId: bigint): boolean {
		if (this.closed) return false;
		// Older wasm builds predate the drain capsule; treating it as a no-op
		// keeps a mismatched module from throwing on a purely advisory signal.
		if (typeof this.wasm.wt_drain_session !== "function") return false;
		const ok = this.wasm.wt_drain_session(this.eid, conn, sessionId);
		this.pump();
		return ok;
	}

	has0Rtt(conn: number): boolean {
		if (this.closed) return false;
		return this.wasm.wt_conn_has_0rtt(this.eid, conn);
	}

	connPeer(conn: number): { ip: string; port: number } | null {
		if (this.closed) return null;
		if (typeof this.wasm.wt_conn_peer !== "function") return null;
		try {
			const parsed = JSON.parse(this.wasm.wt_conn_peer(this.eid, conn)) as {
				ip?: string;
				port?: number;
				error?: string;
			};
			if (typeof parsed.ip !== "string" || typeof parsed.port !== "number") {
				return null;
			}
			return { ip: parsed.ip, port: parsed.port };
		} catch {
			return null;
		}
	}

	connStats(conn: number): {
		bytesSent: number;
		bytesReceived: number;
		packetsSent: number;
		packetsReceived: number;
		datagrams: {
			droppedIncoming: number;
			expiredIncoming: number;
			expiredOutgoing: number;
			lostOutgoing: number;
		};
		smoothedRttMs?: number;
		error?: string;
	} | null {
		if (this.closed) return null;
		if (typeof this.wasm.wt_conn_stats !== "function") return null;
		try {
			return JSON.parse(this.wasm.wt_conn_stats(this.eid, conn)) as {
				bytesSent: number;
				bytesReceived: number;
				packetsSent: number;
				packetsReceived: number;
				datagrams: {
					droppedIncoming: number;
					expiredIncoming: number;
					expiredOutgoing: number;
					lostOutgoing: number;
				};
				smoothedRttMs?: number;
				error?: string;
			};
		} catch {
			return null;
		}
	}

	updateTls(configJson: string): string {
		if (this.closed) {
			return JSON.stringify({ error: "E_SESSION_CLOSED: endpoint is closed" });
		}
		const fn = this.wasm.wt_update_tls;
		if (typeof fn !== "function") {
			return JSON.stringify({
				error: "E_TLS: live TLS resolver unavailable on this endpoint",
			});
		}
		return fn.call(this.wasm, this.eid, configJson);
	}

	tlsSnapshot(): string {
		if (this.closed) {
			return JSON.stringify({
				unknownSniPolicy: "reject",
				defaultCertPresent: false,
				sniNames: [],
			});
		}
		const fn = this.wasm.wt_tls_snapshot;
		if (typeof fn !== "function") {
			return JSON.stringify({
				unknownSniPolicy: "reject",
				defaultCertPresent: true,
				sniNames: [],
			});
		}
		return fn.call(this.wasm, this.eid);
	}

	accepted0Rtt(conn: number): boolean {
		if (this.closed) return false;
		return this.wasm.wt_conn_accepted_0rtt(this.eid, conn);
	}

	enable0Rtt(): boolean {
		if (this.closed) return false;
		return this.wasm.wt_enable_0rtt(this.eid);
	}

	/** Drain client tickets for `serverName` into an opaque vault blob. */
	dumpClientTicket(serverName: string): Uint8Array | null {
		if (this.closed) return null;
		const blob = this.wasm.wt_dump_client_ticket(this.eid, serverName);
		return blob.length > 0 ? blob : null;
	}

	/** Hydrate opaque client-ticket blob before connect. */
	importClientTicket(serverName: string, blob: Uint8Array): boolean {
		if (this.closed) return false;
		return this.wasm.wt_import_client_ticket(this.eid, serverName, blob);
	}

	streamWrite(stream: number, data: Uint8Array): number {
		// -1 (not 0) so a parked writeAll loop throws "stream write failed"
		// and terminates instead of busy-looping on zero progress.
		this.streamWriteError = "";
		if (this.closed) {
			this.streamWriteError = "E_SESSION_CLOSED: endpoint is closed";
			return -1;
		}
		const n = this.wasm.wt_stream_write(this.eid, stream, data);
		if (n < 0) this.streamWriteError = this.wasm.wt_take_last_error(this.eid);
		this.pump();
		return n;
	}

	takeStreamWriteError(): string {
		const error = this.streamWriteError;
		this.streamWriteError = "";
		return error;
	}

	/** Pause reading a stream — QUIC flow control throttles the sender. */
	streamPause(stream: number): void {
		if (this.closed) return;
		this.wasm.wt_stream_pause(this.eid, stream);
	}

	/** Resume a paused stream; pump so buffered data and window updates flow. */
	streamResume(stream: number): void {
		if (this.closed) return;
		this.wasm.wt_stream_resume(this.eid, stream);
		this.pump();
	}

	streamFinish(stream: number): void {
		if (this.closed) return;
		this.wasm.wt_stream_finish(this.eid, stream);
		this.pump();
	}

	streamReset(stream: number, code: number): void {
		if (this.closed) return;
		this.wasm.wt_stream_reset(this.eid, stream, code);
		this.pump();
	}

	/** STOP_SENDING on the recv half (cancel an incoming readable). */
	streamStop(stream: number, code: number): void {
		if (this.closed) return;
		this.wasm.wt_stream_stop(this.eid, stream, code);
		this.pump();
	}

	releaseHostReservation(token: number): boolean {
		if (this.closed || token <= 0) return false;
		const released = this.wasm.wt_release_host_reservation(this.eid, token);
		if (released) this.pump();
		return released;
	}

	takeLastError(): string {
		if (this.closed) return "";
		return this.wasm.wt_take_last_error(this.eid);
	}

	governorSnapshot(): string {
		if (this.closed) return "{}";
		return this.wasm.wt_governor_snapshot(this.eid);
	}

	/**
	 * Resolve on the next pump (real progress) or after `maxMs` as a safety net.
	 * Used by backpressured writers instead of a fixed-interval poll.
	 */
	waitForProgress(maxMs = 50): Promise<void> {
		if (this.closed) return Promise.resolve();
		return new Promise((resolve) => {
			let done = false;
			const waiter: {
				fire: () => void;
				timer?: ReturnType<typeof setTimeout>;
			} = {
				fire: () => {
					if (!done) {
						done = true;
						resolve();
					}
				},
				timer: undefined,
			};
			waiter.timer = setTimeout(() => waiter.fire(), maxMs);
			this.drainWaiters.push(waiter);
		});
	}

	/** Drain transmits to the wire, dispatch events, reschedule the timer. */
	pump(): void {
		if (this.closed) return;
		if (this.pumping) {
			this.pumpAgain = true;
			return;
		}
		this.pumping = true;
		try {
			do {
				this.pumpAgain = false;
				this.pumpOnce();
			} while (this.pumpAgain && !this.closed);
		} finally {
			this.pumping = false;
		}
	}

	private pumpOnce(): void {
		if (this.closed) return;
		const out = this.wasm.wt_poll_transmits(this.eid);
		let off = 0;
		// Records: [dest_len:u8][dest utf8][pkt_len:u32-le][pkt].
		while (off < out.length) {
			const destLen = out[off] ?? 0;
			off += 1;
			const dest = TEXT_DECODER.decode(out.subarray(off, off + destLen));
			off += destLen;
			if (off + 4 > out.length) break;
			const len =
				(out[off] ?? 0) |
				((out[off + 1] ?? 0) << 8) |
				((out[off + 2] ?? 0) << 16) |
				((out[off + 3] ?? 0) << 24);
			off += 4;
			this.udp.send(out.subarray(off, off + len), parseDest(dest));
			off += len;
		}
		for (
			let ev = this.wasm.wt_poll_event(this.eid);
			ev;
			ev = this.wasm.wt_poll_event(this.eid)
		) {
			// A throwing user callback must not abort the drain loop (skipping
			// later events, e.g. Closed) or unwind into the UDP data handler.
			try {
				this.dispatch(ev);
			} catch (err) {
				this.onError?.(err);
			}
		}
		// Wake any backpressured writers: a pump means acks/window updates were
		// processed, so a previously-blocked stream_write may now make progress.
		if (this.drainWaiters.length > 0) {
			const waiters = this.drainWaiters;
			this.drainWaiters = [];
			for (const w of waiters) {
				if (w.timer !== undefined) clearTimeout(w.timer);
				w.fire();
			}
		}
		this.reschedule();
	}

	private dispatch(ev: Uint8Array): void {
		dispatchDecodedWasmEvent(decodeWasmEvent(ev), this.events, (token) =>
			this.releaseHostReservation(token),
		);
	}

	private reschedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		// close() clears the timer, but guard here and in the callback too so a
		// timer that fires during the close race never calls wt_* on a freed eid.
		if (this.closed) return;
		const ms = this.wasm.wt_next_timeout_ms(this.eid);
		if (ms >= 0) {
			this.timer = setTimeout(
				() => {
					if (this.closed) return;
					this.wasm.wt_handle_timeout(this.eid);
					this.pump();
				},
				Math.max(0, ms),
			);
		}
	}

	/** Close ONE connection (CONNECTION_CLOSE to the peer); others unaffected. */
	closeConn(conn: number, code = 0, reason = ""): void {
		// Guard like every other op: after close() freed the eid, calling
		// wt_close_conn on it is a use-after-free. Reachable via
		// WasmWebTransport.close() → session.close() → mgr.closeSession().
		if (this.closed) return;
		this.wasm.wt_close_conn(this.eid, conn, code, reason);
		this.pump();
	}

	/** Begin deterministic teardown while reservation-release calls remain valid. */
	beginClose(): void {
		if (this.closed || this.closing) return;
		this.closing = true;
		// Gracefully CONNECTION_CLOSE every live connection and flush those
		// frames to the wire before dropping the wasm-side state.
		this.wasm.wt_close_all(this.eid, 0, "endpoint closed");
		this.pump();
	}

	/** Finish teardown after the manager has released every retained payload. */
	finishClose(): void {
		if (this.closed) return;
		if (!this.closing) this.beginClose();
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		// Release any parked writers so their promises settle (writes will fail).
		const waiters = this.drainWaiters;
		this.drainWaiters = [];
		for (const w of waiters) {
			if (w.timer !== undefined) clearTimeout(w.timer);
			w.fire();
		}
		this.wasm.wt_close_endpoint(this.eid);
	}

	close(): void {
		this.beginClose();
		this.finishClose();
	}
}
