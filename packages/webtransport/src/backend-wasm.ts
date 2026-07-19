import type { UdpAddr, UdpTransport } from "./wasm-relay.js";

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
	wt_connect(eid: number, authority: string): number;
	wt_recv_packet(eid: number, data: Uint8Array, source: string): void;
	wt_poll_transmits(eid: number): Uint8Array;
	wt_next_timeout_ms(eid: number): number;
	wt_handle_timeout(eid: number): void;
	wt_poll_event(eid: number): Uint8Array | undefined;
	wt_send_datagram(eid: number, conn: number, data: Uint8Array): boolean;
	wt_open_stream(eid: number, conn: number, bidi: boolean): number;
	wt_stream_write(eid: number, stream: number, data: Uint8Array): number;
	wt_stream_pause(eid: number, stream: number): void;
	wt_stream_resume(eid: number, stream: number): void;
	wt_stream_finish(eid: number, stream: number): void;
	wt_stream_reset(eid: number, stream: number, code: number): void;
	wt_stream_stop(eid: number, stream: number, code: number): void;
	wt_new_client(
		addr: string,
		peerAddr: string,
		certHashesBase64: string,
	): string;
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
} as const;

function decodeVarint(buf: Uint8Array, off: number): [number, number] {
	const first = buf[off] ?? 0;
	const len = 1 << (first >> 6);
	let v = first & 0x3f;
	for (let i = 1; i < len; i++) v = v * 256 + (buf[off + i] ?? 0);
	return [v, off + len];
}

export interface WasmSessionEvents {
	onConnected?: (conn: number) => void;
	onEstablished?: (conn: number) => void;
	onDatagram?: (conn: number, data: Uint8Array) => void;
	onClosed?: (conn: number, code: number) => void;
	onStreamOpened?: (conn: number, stream: number, bidi: boolean) => void;
	onStreamData?: (
		conn: number,
		stream: number,
		data: Uint8Array,
		fin: boolean,
	) => void;
	onStreamReset?: (conn: number, stream: number, code: number) => void;
	/** Peer STOP_SENDING on our send half; the recv half is unaffected. */
	onStreamStopped?: (conn: number, stream: number, code: number) => void;
}

export class WasmEndpoint {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private closed = false;
	/** Reports an exception thrown by a user event callback during dispatch. */
	onError: ((err: unknown) => void) | null = null;
	/** Resolved on the next pump() — lets backpressured writers wake on real
	 * progress (inbound acks / timers) instead of a fixed busy-poll. */
	private drainWaiters: Array<() => void> = [];

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
			// fails and every IPv6 client collapses onto the fallback peer_addr.
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
		events: WasmSessionEvents = {},
	): WasmEndpoint {
		const eid = wasm.wt_new_endpoint(isServer, addr, peerAddr);
		if (eid === 0) {
			// 0 is the bad-address sentinel (valid eids start at 1). Surface it
			// here so the real cause isn't misattributed to a later connect error.
			throw new Error(
				`wt_new_endpoint failed: invalid address ${JSON.stringify(addr)} or peerAddr ${JSON.stringify(peerAddr)}`,
			);
		}
		return new WasmEndpoint(wasm, udp, eid, events);
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
		events: WasmSessionEvents = {},
	): WasmEndpoint {
		const parsed = JSON.parse(
			wasm.wt_new_client(addr, peerAddr, certHashesBase64),
		) as { eid?: number; error?: string };
		if (parsed.error || parsed.eid == null) {
			throw new Error(`wt_new_client failed: ${parsed.error ?? "unknown"}`);
		}
		return new WasmEndpoint(wasm, udp, parsed.eid, events);
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

	connect(authority: string): number {
		const conn = this.wasm.wt_connect(this.eid, authority);
		this.pump();
		return conn;
	}

	sendDatagram(conn: number, data: Uint8Array): boolean {
		const ok = this.wasm.wt_send_datagram(this.eid, conn, data);
		this.pump();
		return ok;
	}

	/** Open a WebTransport stream; returns its handle or -1. */
	openStream(conn: number, bidi: boolean): number {
		const s = this.wasm.wt_open_stream(this.eid, conn, bidi);
		this.pump();
		return s;
	}

	streamWrite(stream: number, data: Uint8Array): number {
		const n = this.wasm.wt_stream_write(this.eid, stream, data);
		this.pump();
		return n;
	}

	/** Pause reading a stream — QUIC flow control throttles the sender. */
	streamPause(stream: number): void {
		this.wasm.wt_stream_pause(this.eid, stream);
	}

	/** Resume a paused stream; pump so buffered data and window updates flow. */
	streamResume(stream: number): void {
		this.wasm.wt_stream_resume(this.eid, stream);
		this.pump();
	}

	streamFinish(stream: number): void {
		this.wasm.wt_stream_finish(this.eid, stream);
		this.pump();
	}

	streamReset(stream: number, code: number): void {
		this.wasm.wt_stream_reset(this.eid, stream, code);
		this.pump();
	}

	/** STOP_SENDING on the recv half (cancel an incoming readable). */
	streamStop(stream: number, code: number): void {
		this.wasm.wt_stream_stop(this.eid, stream, code);
		this.pump();
	}

	/**
	 * Resolve on the next pump (real progress) or after `maxMs` as a safety net.
	 * Used by backpressured writers instead of a fixed-interval poll.
	 */
	waitForProgress(maxMs = 50): Promise<void> {
		if (this.closed) return Promise.resolve();
		return new Promise((resolve) => {
			let done = false;
			const fire = () => {
				if (!done) {
					done = true;
					resolve();
				}
			};
			this.drainWaiters.push(fire);
			setTimeout(fire, maxMs);
		});
	}

	/** Drain transmits to the wire, dispatch events, reschedule the timer. */
	pump(): void {
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
			for (const w of waiters) w();
		}
		this.reschedule();
	}

	private dispatch(ev: Uint8Array): void {
		const tag = ev[0];
		let off = 1;
		let conn: number;
		[conn, off] = decodeVarint(ev, off);
		if (tag === EVENT.CONNECTED) {
			this.events.onConnected?.(conn);
		} else if (tag === EVENT.SESSION_ESTABLISHED) {
			this.events.onEstablished?.(conn);
		} else if (tag === EVENT.DATAGRAM) {
			let len: number;
			[len, off] = decodeVarint(ev, off);
			this.events.onDatagram?.(conn, ev.subarray(off, off + len));
		} else if (tag === EVENT.CLOSED) {
			const [code] = decodeVarint(ev, off);
			this.events.onClosed?.(conn, code);
		} else if (tag === EVENT.STREAM_OPENED) {
			// conn already decoded; next: stream varint, then bidi byte.
			let stream: number;
			[stream, off] = decodeVarint(ev, off);
			const bidi = (ev[off] ?? 0) === 1;
			this.events.onStreamOpened?.(conn, stream, bidi);
		} else if (tag === EVENT.STREAM_DATA) {
			// conn already decoded; next: stream varint, fin byte, len + data.
			let stream: number;
			[stream, off] = decodeVarint(ev, off);
			const fin = (ev[off] ?? 0) === 1;
			off += 1;
			let len: number;
			[len, off] = decodeVarint(ev, off);
			this.events.onStreamData?.(
				conn,
				stream,
				ev.subarray(off, off + len),
				fin,
			);
		} else if (tag === EVENT.STREAM_RESET) {
			// conn already decoded; next: stream varint, then code varint.
			let stream: number;
			[stream, off] = decodeVarint(ev, off);
			const [code] = decodeVarint(ev, off);
			this.events.onStreamReset?.(conn, stream, code);
		} else if (tag === EVENT.STREAM_STOPPED) {
			// conn already decoded; next: stream varint, then code varint.
			let stream: number;
			[stream, off] = decodeVarint(ev, off);
			const [code] = decodeVarint(ev, off);
			this.events.onStreamStopped?.(conn, stream, code);
		}
	}

	private reschedule(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		const ms = this.wasm.wt_next_timeout_ms(this.eid);
		if (ms >= 0) {
			this.timer = setTimeout(
				() => {
					this.wasm.wt_handle_timeout(this.eid);
					this.pump();
				},
				Math.max(0, ms),
			);
		}
	}

	/** Close ONE connection (CONNECTION_CLOSE to the peer); others unaffected. */
	closeConn(conn: number, code = 0, reason = ""): void {
		this.wasm.wt_close_conn(this.eid, conn, code, reason);
		this.pump();
	}

	close(): void {
		if (this.closed) return;
		// Gracefully CONNECTION_CLOSE every live connection and flush those
		// frames to the wire before dropping the wasm-side state.
		this.wasm.wt_close_all(this.eid, 0, "endpoint closed");
		this.pump();
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		// Release any parked writers so their promises settle (writes will fail).
		const waiters = this.drainWaiters;
		this.drainWaiters = [];
		for (const w of waiters) w();
		this.wasm.wt_close_endpoint(this.eid);
	}
}
