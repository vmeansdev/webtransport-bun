// Backend selection + a high-level WebTransport facade over the wasm endpoint.
//
// The native Node-API addon path stays in index.ts. In a browser / Isolated Web
// App (where `UDPSocket` exists) the wasm backend is used instead, fed by a
// `UdpTransport` (Direct Sockets in production, InMemoryRelay in tests).

import {
	type WasmModule,
	WasmEndpoint,
	type WasmSessionEvents,
} from "./backend-wasm.js";
import type { WebTransportLike, WtCloseInfo } from "./shared.js";
import type { UdpTransport } from "./wasm-relay.js";
import { WasmWebTransport } from "./webtransport-like-wasm.js";

export { WasmWebTransport } from "./webtransport-like-wasm.js";

/**
 * Caps on the per-session buffers that hold events arriving BEFORE the app
 * attaches a consumer. Without them, a peer flooding datagrams or opening many
 * streams before `onDatagram`/`onStream` is called grows memory without bound.
 */
const MAX_PENDING_DATAGRAMS = 1024;
const MAX_PENDING_INCOMING_STREAMS = 256;
/** Per-stream cap on inbound bytes buffered before the app attaches onData. */
const MAX_PENDING_STREAM_BYTES = 1 << 20; // 1 MiB

/** True when the wasm backend should be used (Direct Sockets available). */
export function isWasmRuntime(): boolean {
	return (
		typeof (globalThis as { UDPSocket?: unknown }).UDPSocket !== "undefined"
	);
}

export type BackendKind = "native" | "wasm";

export function selectBackend(): BackendKind {
	return isWasmRuntime() ? "wasm" : "native";
}

/** A WebTransport stream surfaced through the wasm facade. */
export class WasmStream {
	private dataCb: ((data: Uint8Array, fin: boolean) => void) | null = null;
	private resetCb: ((code: number) => void) | null = null;
	private stoppedCb: ((code: number) => void) | null = null;
	private buffered: Array<{ data: Uint8Array; fin: boolean }> = [];
	private bufferedBytes = 0;
	/** Set when the peer STOP_SENDINGs our send half: writes will fail. */
	private stopCode: number | null = null;
	// Per-half completion, mirroring the Rust core. The manager releases this
	// handle only when BOTH halves are done, so a bidi stream that FINs its
	// recv half can still deliver a later STOP_SENDING on its live send half.
	private recvDone: boolean;
	private sendDone: boolean;

	constructor(
		private mgr: WasmTransportManager,
		readonly conn: number,
		readonly handle: number,
		readonly bidi: boolean,
		/** True for a peer-opened stream (via onStreamOpened). */
		incoming = false,
	) {
		// Uni streams have only one half live: a peer-opened uni is recv-only
		// (no send half), a self-opened uni is send-only (no recv half).
		this.recvDone = !bidi && !incoming;
		this.sendDone = !bidi && incoming;
	}

	write(data: Uint8Array): number {
		return this.mgr.endpoint.streamWrite(this.handle, data);
	}
	/**
	 * Write ALL bytes, waiting out closed flow-control windows. Unlike
	 * {@link write} (which returns the count accepted and may take less than
	 * the full chunk), this never silently drops a tail. Rejects if the stream
	 * is closed or reset mid-write.
	 */
	async writeAll(data: Uint8Array): Promise<void> {
		// wt_stream_write copies into wasm synchronously, so the FAST path (the
		// whole chunk accepted by the first write, no yield) needs no copy. Only
		// once we must yield do we snapshot the remainder, since the caller
		// regains control across the await and may reuse its buffer.
		let owned: Uint8Array | null = null;
		let off = 0;
		while (off < data.length) {
			if (this.stopCode !== null) {
				throw new Error(`stream stopped by peer (code ${this.stopCode})`);
			}
			const view = owned ? owned.subarray(off) : data.subarray(off);
			const n = this.write(view);
			if (n < 0) {
				throw new Error("stream write failed (stream closed or reset)");
			}
			off += n;
			if (off < data.length) {
				if (!owned) owned = data.slice(); // snapshot once before yielding
				// Window closed — wait for real progress (next pump) instead of
				// a fixed 1ms poll, capped so a stalled peer can't hang forever.
				await this.mgr.endpoint.waitForProgress();
			}
		}
	}
	/** Pause inbound delivery; QUIC flow control throttles the sender. */
	pause(): void {
		this.mgr.endpoint.streamPause(this.handle);
	}
	/** Resume inbound delivery after {@link pause}. */
	resume(): void {
		this.mgr.endpoint.streamResume(this.handle);
	}
	finish(): void {
		this.mgr.endpoint.streamFinish(this.handle);
		this.sendDone = true;
		this._maybeRelease();
	}
	reset(code: number): void {
		this.mgr.endpoint.streamReset(this.handle, code);
		this.sendDone = true;
		this._maybeRelease();
	}
	/** STOP_SENDING on the recv half (cancel an incoming readable). */
	stop(code: number): void {
		this.mgr.endpoint.streamStop(this.handle, code);
		this.recvDone = true;
		this._maybeRelease();
	}

	onData(cb: (data: Uint8Array, fin: boolean) => void): void {
		this.dataCb = cb;
		for (const ev of this.buffered) cb(ev.data, ev.fin);
		this.buffered = [];
		this.bufferedBytes = 0;
	}
	onReset(cb: (code: number) => void): void {
		this.resetCb = cb;
	}
	/** Peer STOP_SENDING on our send half; reads continue, writes will fail. */
	onStopped(cb: (code: number) => void): void {
		this.stoppedCb = cb;
		if (this.stopCode !== null) cb(this.stopCode);
	}

	/** @internal */
	_pushData(data: Uint8Array, fin: boolean): void {
		if (this.dataCb) {
			this.dataCb(data, fin);
		} else {
			// Bound un-consumed inbound data: if the app hasn't attached onData
			// and the peer floods past the cap, STOP_SENDING the recv half rather
			// than buffer without bound (OOM). Data already buffered is preserved
			// for a late onData; no further data will arrive after the stop.
			this.buffered.push({ data, fin });
			this.bufferedBytes += data.length;
			if (this.bufferedBytes > MAX_PENDING_STREAM_BYTES && !this.recvDone) {
				this.stop(0);
			}
		}
		if (fin) {
			this.recvDone = true;
			this._maybeRelease();
		}
	}
	/** @internal */
	_pushReset(code: number): void {
		this.resetCb?.(code);
		// A reset ends the recv half. On connection teardown the manager also
		// force-releases, so mark the send half done too to guarantee release.
		this.recvDone = true;
		this._maybeRelease();
	}
	/** @internal */
	_pushStopped(code: number): void {
		if (this.stopCode === null) {
			this.stopCode = code;
			this.stoppedCb?.(code);
		}
		this.sendDone = true;
		this._maybeRelease();
	}
	/**
	 * @internal Called when the underlying connection closes. Errors the
	 * readable ONLY if its recv half was still live (a cleanly-FINed stream is
	 * already settled and must not get a spurious reset), then releases.
	 */
	_closeFromConnection(code: number): void {
		if (!this.recvDone) {
			this.recvDone = true;
			this.resetCb?.(code);
		}
		this.sendDone = true;
		this.mgr._releaseStream(this.handle);
	}

	/** @internal Release from the manager's map once both halves are done. */
	private _maybeRelease(): void {
		if (this.recvDone && this.sendDone) this.mgr._releaseStream(this.handle);
	}
}

/** A WebTransport session (one QUIC connection) through the wasm facade. */
export class WasmSession {
	/** Resolves once established; REJECTS if the connection fails first. */
	readonly ready: Promise<void>;
	/** Resolves (never rejects) with close info when the session ends. */
	readonly closed: Promise<WtCloseInfo>;
	private resolveReady!: () => void;
	private rejectReady!: (err: Error) => void;
	private resolveClosed!: (info: WtCloseInfo) => void;
	private isClosed = false;
	private established = false;
	private datagramCb: ((data: Uint8Array) => void) | null = null;
	private datagramQueue: Uint8Array[] = [];
	private incomingCb: ((stream: WasmStream) => void) | null = null;
	private incomingQueue: WasmStream[] = [];

	constructor(
		private mgr: WasmTransportManager,
		readonly conn: number,
	) {
		this.ready = new Promise((res, rej) => {
			this.resolveReady = res;
			this.rejectReady = rej;
		});
		// A failed connect rejects `ready`; fire-and-forget consumers that only
		// use `closed` must not die of an unhandled rejection.
		this.ready.catch(() => {});
		this.closed = new Promise((res) => {
			this.resolveClosed = res;
		});
	}

	sendDatagram(data: Uint8Array): boolean {
		return this.mgr.endpoint.sendDatagram(this.conn, data);
	}

	/**
	 * Close THIS session's connection (CONNECTION_CLOSE to the peer). Other
	 * sessions on the same endpoint are unaffected.
	 */
	close(info?: WtCloseInfo): void {
		this.mgr.closeSession(this, info);
	}
	onDatagram(cb: (data: Uint8Array) => void): void {
		this.datagramCb = cb;
		for (const d of this.datagramQueue) cb(d);
		this.datagramQueue = [];
	}

	createBidirectionalStream(): WasmStream {
		return this.mgr.openStream(this, true);
	}
	createUnidirectionalStream(): WasmStream {
		return this.mgr.openStream(this, false);
	}
	onIncomingStream(cb: (stream: WasmStream) => void): void {
		this.incomingCb = cb;
		for (const s of this.incomingQueue) cb(s);
		this.incomingQueue = [];
	}

	/** @internal */
	_markEstablished(): void {
		if (!this.established) {
			this.established = true;
			this.resolveReady();
		}
	}
	/** @internal */
	_markClosed(info: WtCloseInfo): void {
		if (!this.isClosed) {
			this.isClosed = true;
			if (!this.established) {
				this.rejectReady(
					new Error(
						`connection closed before session established (code ${info.code ?? 0})`,
					),
				);
			}
			this.resolveClosed(info);
		}
	}
	/** @internal */
	_pushDatagram(data: Uint8Array): void {
		if (this.datagramCb) {
			this.datagramCb(data);
			return;
		}
		// Bound the pre-subscribe buffer: a peer flooding datagrams before the
		// app attaches a consumer must not grow memory without limit. Datagrams
		// are unreliable, so drop the oldest (ring-buffer) rather than OOM.
		if (this.datagramQueue.length >= MAX_PENDING_DATAGRAMS) {
			this.datagramQueue.shift();
		}
		this.datagramQueue.push(data);
	}
	/** @internal */
	_pushIncomingStream(stream: WasmStream): void {
		if (this.incomingCb) {
			this.incomingCb(stream);
			return;
		}
		// Bound un-accepted incoming streams: tear down the excess rather than
		// buffer unbounded when the app hasn't attached an incoming-stream
		// handler yet. Both halves are ended (stop the recv half AND reset the
		// send half) so the manager actually releases it from the streams map —
		// a bidi stream that only stop()s keeps sendDone false and would orphan.
		if (this.incomingQueue.length >= MAX_PENDING_INCOMING_STREAMS) {
			stream.stop(0);
			stream.reset(0);
			return;
		}
		this.incomingQueue.push(stream);
	}
}

/**
 * Owns one wasm endpoint and routes its events to per-connection sessions and
 * per-handle streams. Used for both the client (single session) and server
 * (one session per accepted connection) facades.
 */
export class WasmTransportManager {
	readonly endpoint: WasmEndpoint;
	private sessions = new Map<number, WasmSession>();
	private streams = new Map<number, WasmStream>();
	private onSession: ((session: WasmSession) => void) | null;
	/** Transport the manager owns and closes on {@link close}, if any. */
	private ownedTransport: UdpTransport | null = null;

	private constructor(
		isServer: boolean,
		onSession: ((session: WasmSession) => void) | null,
		makeEndpoint: (events: WasmSessionEvents) => WasmEndpoint,
	) {
		this.onSession = onSession;
		const events: WasmSessionEvents = {
			onEstablished: (conn) => {
				const s = this.ensureSession(conn);
				s._markEstablished();
				if (isServer) this.onSession?.(s);
			},
			onDatagram: (conn, data) => {
				// Use get, not ensureSession: a datagram surfaced after the
				// session was already closed/deleted (final drain on a graceful
				// end) must NOT resurrect a zombie session no consumer holds.
				this.sessions.get(conn)?._pushDatagram(data.slice());
			},
			onClosed: (conn, code) => {
				this.ensureSession(conn)._markClosed({ code });
				// Settle and release everything belonging to this connection.
				// _closeFromConnection errors only readers still live (a
				// cleanly-FINed stream stays settled), avoiding a spurious reset.
				// A throwing user onReset callback must not abort cleanup of the
				// remaining streams, so isolate each one.
				for (const [handle, ws] of this.streams) {
					if (ws.conn === conn) {
						try {
							ws._closeFromConnection(code);
						} catch (err) {
							this.onCallbackError?.(err);
						}
						this.streams.delete(handle);
					}
				}
				this.sessions.delete(conn);
			},
			onStreamOpened: (conn, stream, bidi) => {
				const s = this.ensureSession(conn);
				const ws = new WasmStream(this, conn, stream, bidi, true);
				this.streams.set(stream, ws);
				s._pushIncomingStream(ws);
			},
			onStreamData: (_conn, stream, data, fin) => {
				// The stream releases itself from the map once BOTH halves are
				// done (see WasmStream._maybeRelease); deleting on fin here would
				// drop a later STOP_SENDING for a still-open bidi send half.
				this.streams.get(stream)?._pushData(data.slice(), fin);
			},
			onStreamReset: (_conn, stream, code) => {
				this.streams.get(stream)?._pushReset(code);
			},
			onStreamStopped: (_conn, stream, code) => {
				// Send half rejected by the peer; reads (if bidi) continue.
				this.streams.get(stream)?._pushStopped(code);
			},
		};
		this.endpoint = makeEndpoint(events);
		// A throwing user callback is contained by the pump and surfaced here
		// instead of crashing the UDP data handler / stalling the endpoint.
		this.endpoint.onError = (err) => {
			if (this.onCallbackError) this.onCallbackError(err);
			else console.error("wasm transport: event callback threw:", err);
		};
	}

	/** Optional hook for exceptions thrown by user event callbacks. */
	onCallbackError: ((err: unknown) => void) | null = null;

	static create(
		wasm: WasmModule,
		udp: UdpTransport,
		isServer: boolean,
		addr: string,
		peerAddr: string,
		onSession: ((session: WasmSession) => void) | null,
		certHashesBase64?: string,
	): WasmTransportManager {
		return new WasmTransportManager(isServer, onSession, (events) =>
			!isServer && certHashesBase64
				? WasmEndpoint.createPinnedClient(
						wasm,
						udp,
						addr,
						peerAddr,
						certHashesBase64,
						events,
					)
				: WasmEndpoint.create(wasm, udp, isServer, addr, peerAddr, events),
		);
	}

	/** Wrap an endpoint already created wasm-side (e.g. via wt_new_server). */
	static adopt(
		wasm: WasmModule,
		udp: UdpTransport,
		eid: number,
		onSession: (session: WasmSession) => void,
	): WasmTransportManager {
		return new WasmTransportManager(true, onSession, (events) =>
			WasmEndpoint.adopt(wasm, udp, eid, events),
		);
	}

	private ensureSession(conn: number): WasmSession {
		let s = this.sessions.get(conn);
		if (!s) {
			s = new WasmSession(this, conn);
			this.sessions.set(conn, s);
		}
		return s;
	}

	/** @internal */
	openStream(session: WasmSession, bidi: boolean): WasmStream {
		const handle = this.endpoint.openStream(session.conn, bidi);
		if (handle < 0) {
			throw new Error(
				"openStream failed: session not established or connection closed",
			);
		}
		const ws = new WasmStream(this, session.conn, handle, bidi, false);
		this.streams.set(handle, ws);
		return ws;
	}

	/** @internal Remove a stream whose both halves are complete. */
	_releaseStream(handle: number): void {
		this.streams.delete(handle);
	}

	connectClient(authority: string): WasmSession {
		const conn = this.endpoint.connect(authority);
		if (conn < 0) {
			// wt_connect returns -1 for a server endpoint or rejected params; no
			// Rust connection exists, so `ready` would hang. Fail it eagerly.
			throw new Error(
				"wasm connect failed: server endpoint or invalid connection parameters",
			);
		}
		return this.ensureSession(conn);
	}

	/** @internal Close one session's connection; the endpoint stays up. */
	closeSession(session: WasmSession, info?: WtCloseInfo): void {
		this.endpoint.closeConn(session.conn, info?.code ?? 0, info?.reason ?? "");
	}

	/** Take ownership of a transport so {@link close} releases its socket. */
	ownTransport(udp: UdpTransport): void {
		this.ownedTransport = udp;
	}

	/**
	 * Shut down the endpoint: CONNECTION_CLOSE every session, drop wasm state,
	 * and close an owned transport so its UDP socket/port is released.
	 */
	close(): void {
		this.endpoint.close();
		this.ownedTransport?.close?.();
		this.ownedTransport = null;
	}
}

/** Options for {@link connectWasm} / {@link connectWasmUnified}. */
export interface WasmConnectOptions {
	/**
	 * Comma-separated base64 SHA-256 cert hashes to pin (the `hashBase64` from
	 * `serveOverUdp`/`wt_generate_cert`) — the browser's
	 * `serverCertificateHashes` trust model. STRONGLY recommended: without it
	 * the client accepts ANY server certificate.
	 */
	certHashBase64?: string;
}

/** Client: connect to a WebTransport server over the given UDP transport. */
export async function connectWasm(
	wasm: WasmModule,
	udp: UdpTransport,
	authority: string,
	addr = "127.0.0.1:0",
	peerAddr = "127.0.0.1:443",
	opts: WasmConnectOptions = {},
): Promise<{ session: WasmSession; manager: WasmTransportManager }> {
	const mgr = WasmTransportManager.create(
		wasm,
		udp,
		false,
		addr,
		peerAddr,
		null,
		opts.certHashBase64,
	);
	const session = mgr.connectClient(authority);
	try {
		await session.ready;
	} catch (err) {
		mgr.close();
		// The connect failed and we're throwing, so the caller can't get the
		// transport back — release it here to avoid leaking its socket/read loop.
		// (mgr.close() only closes a transport the manager itself owns.)
		try {
			udp.close?.();
		} catch {}
		throw err;
	}
	return { session, manager: mgr };
}

/** Server: accept WebTransport sessions over the given UDP transport. */
export function createWasmServer(
	wasm: WasmModule,
	udp: UdpTransport,
	onSession: (session: WasmSession) => void,
	addr = "0.0.0.0:443",
	peerAddr = "127.0.0.1:0",
): WasmTransportManager {
	return WasmTransportManager.create(
		wasm,
		udp,
		true,
		addr,
		peerAddr,
		onSession,
	);
}

/**
 * Browser/IWA convenience: serve WebTransport over a Direct Sockets UDPSocket.
 * Returns the manager and the `serverCertificateHashes` value clients must pin.
 * `bind` is `(localAddress, localPort) => Promise<UdpTransport>` — pass
 * `DirectSocketsUdpTransport.bind` (kept injectable so the package core has no
 * hard dependency on the browser-only module).
 */
export async function serveOverUdp(
	wasm: WasmModule,
	bind: (localAddress: string, localPort: number) => Promise<UdpTransport>,
	opts: {
		localAddress?: string;
		localPort: number;
		commonName?: string;
		validityDays?: number;
		onSession: (session: WasmSession) => void;
	},
): Promise<{ manager: WasmTransportManager; certHashBase64: string }> {
	const udp = await bind(opts.localAddress ?? "0.0.0.0", opts.localPort);
	const notBefore = Math.floor(Date.now() / 1000) - 3600;
	const json = wasm.wt_new_server(
		`${opts.localAddress ?? "0.0.0.0"}:${opts.localPort}`,
		"127.0.0.1:0",
		opts.commonName ?? "localhost",
		opts.validityDays ?? 14,
		notBefore,
	);
	const parsed = JSON.parse(json) as {
		eid?: number;
		hashBase64?: string;
		error?: string;
	};
	if (parsed.error || parsed.eid == null || parsed.hashBase64 == null) {
		// Release the socket we just bound before failing, or the port leaks.
		udp.close?.();
		throw new Error(`wt_new_server failed: ${parsed.error ?? "unknown"}`);
	}
	const manager = WasmTransportManager.adopt(
		wasm,
		udp,
		parsed.eid,
		opts.onSession,
	);
	// manager.close() now releases the bound UDP socket too.
	manager.ownTransport(udp);
	return { manager, certHashBase64: parsed.hashBase64 };
}

/**
 * Connect over the wasm backend and present the session through the shared
 * {@link WebTransportLike} contract. The returned `transport` is backend
 * agnostic; `manager` is exposed so callers can `close()` the endpoint.
 */
export async function connectWasmUnified(
	wasm: WasmModule,
	udp: UdpTransport,
	authority: string,
	addr = "127.0.0.1:0",
	peerAddr = "127.0.0.1:443",
	opts: WasmConnectOptions = {},
): Promise<{ transport: WebTransportLike; manager: WasmTransportManager }> {
	const { session, manager } = await connectWasm(
		wasm,
		udp,
		authority,
		addr,
		peerAddr,
		opts,
	);
	return { transport: new WasmWebTransport(session), manager };
}

/** Construction args for the wasm side of {@link createUnifiedClient}. */
export interface WasmClientArgs {
	kind: "wasm";
	wasm: WasmModule;
	udp: UdpTransport;
	authority: string;
	addr?: string;
	peerAddr?: string;
	/** Pin the server cert by base64 SHA-256 hash(es). See {@link WasmConnectOptions}. */
	certHashBase64?: string;
}

/** Construction args for the native side of {@link createUnifiedClient}. */
export interface NativeClientArgs {
	kind: "native";
	/** Wraps an already-constructed native W3C `WebTransport` instance. */
	create: () => WebTransportLike;
}

/**
 * Selector factory: yield a backend-agnostic {@link WebTransportLike} for the
 * current runtime. The wasm and native sides take different construction args
 * (module/udp vs a native-instance factory) — both yield the same contract.
 *
 * Pass `args` whose `kind` matches the runtime; mismatches throw. Use
 * {@link selectBackend} to pick which args to build.
 */
export async function createUnifiedClient(
	args: WasmClientArgs | NativeClientArgs,
): Promise<WebTransportLike> {
	if (args.kind === "wasm") {
		const { transport } = await connectWasmUnified(
			args.wasm,
			args.udp,
			args.authority,
			args.addr,
			args.peerAddr,
			{ certHashBase64: args.certHashBase64 },
		);
		return transport;
	}
	return args.create();
}
