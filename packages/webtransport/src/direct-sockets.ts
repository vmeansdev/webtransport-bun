// Direct Sockets UDPSocket adapter implementing UdpTransport.
//
// Available only in a Chromium Isolated Web App with the `direct-sockets`
// permission. Not runnable under Bun/Node (no UDPSocket); typed structurally so
// the package builds everywhere and the adapter activates only in the browser.
//
// Multi-client: bound server mode surfaces each packet's real remote address to
// onPacket and routes sends to the destination the wasm endpoint chose, so a
// single bound socket serves many clients.

import type { UdpAddr, UdpTransport } from "./wasm-relay.js";

interface UDPMessage {
	data: Uint8Array;
	remoteAddress?: string;
	remotePort?: number;
}
interface UDPSocketOpenInfo {
	readable: ReadableStream<UDPMessage>;
	writable: WritableStream<UDPMessage>;
	localAddress?: string;
	localPort?: number;
}
interface UDPSocketLike {
	opened: Promise<UDPSocketOpenInfo>;
	close(): Promise<void>;
}
type UDPSocketCtor = new (options: Record<string, unknown>) => UDPSocketLike;

function getUDPSocket(): UDPSocketCtor {
	const ctor = (globalThis as { UDPSocket?: UDPSocketCtor }).UDPSocket;
	if (!ctor) {
		throw new Error(
			"UDPSocket is unavailable: Direct Sockets requires a Chromium Isolated Web App with the direct-sockets permission",
		);
	}
	return ctor;
}

export class DirectSocketsUdpTransport implements UdpTransport {
	private cb: ((data: Uint8Array, source: UdpAddr) => void) | null = null;
	private writer: WritableStreamDefaultWriter<UDPMessage> | null = null;
	// Structural type: avoids DOM-vs-node ReadableStreamDefaultReader lib clashes.
	private reader: {
		read(): Promise<{ value?: UDPMessage; done: boolean }>;
		cancel(reason?: unknown): Promise<void>;
		releaseLock(): void;
	} | null = null;
	private connected: boolean;
	private serverAddress?: string;
	private serverPort?: number;
	private closed = false;
	private boundPort?: number;

	/** Bound port reported by the socket; unset in client (connected) mode. */
	get localPort(): number | undefined {
		return this.boundPort;
	}

	private constructor(
		private socket: UDPSocketLike,
		connected: boolean,
		serverAddress?: string,
		serverPort?: number,
	) {
		this.connected = connected;
		this.serverAddress = serverAddress;
		this.serverPort = serverPort;
	}

	/** Client: connected-mode socket toward a fixed server. */
	static async connect(
		remoteAddress: string,
		remotePort: number,
	): Promise<DirectSocketsUdpTransport> {
		const Ctor = getUDPSocket();
		const socket = new Ctor({ remoteAddress, remotePort });
		const t = new DirectSocketsUdpTransport(
			socket,
			true,
			remoteAddress,
			remotePort,
		);
		await t.start();
		return t;
	}

	/**
	 * Server: bound-mode socket listening on a local address/port.
	 *
	 * Port 0 means "let the OS pick". The WICG spec rejects an explicit
	 * `localPort: 0` with a TypeError, so the field is omitted instead; the real
	 * port comes back on `openInfo.localPort` and is surfaced as `localPort`.
	 */
	static async bind(
		localAddress: string,
		localPort: number,
	): Promise<DirectSocketsUdpTransport> {
		const Ctor = getUDPSocket();
		const socket = new Ctor(
			localPort === 0 ? { localAddress } : { localAddress, localPort },
		);
		const t = new DirectSocketsUdpTransport(socket, false);
		await t.start();
		return t;
	}

	private async start(): Promise<void> {
		const info = await this.socket.opened;
		if (!this.connected) this.boundPort = info.localPort;
		this.writer = info.writable.getWriter();
		void this.readLoop(info.readable);
	}

	private async readLoop(readable: ReadableStream<UDPMessage>): Promise<void> {
		const reader = readable.getReader();
		this.reader = reader;
		try {
			while (!this.closed) {
				const { value, done } = await reader.read();
				if (done) break;
				if (!value) continue;
				// Connected mode: all packets are from the fixed server. Bound
				// mode: surface each packet's real remote so the endpoint routes.
				const source: UdpAddr = this.connected
					? {
							address: this.serverAddress ?? "",
							port: this.serverPort ?? 0,
						}
					: {
							address: value.remoteAddress ?? "",
							port: value.remotePort ?? 0,
						};
				this.cb?.(value.data, source);
			}
		} catch {
			// socket closed/errored; stop the loop.
		} finally {
			try {
				reader.releaseLock();
			} catch {
				// reader already released by close()'s cancel()
			}
			this.reader = null;
		}
	}

	send(data: Uint8Array, dest: UdpAddr): void {
		if (this.closed || !this.writer) return;
		// Connected sockets target the fixed server; bound sockets route to the
		// destination the wasm endpoint chose for the packet.
		const msg: UDPMessage = this.connected
			? { data }
			: { data, remoteAddress: dest.address, remotePort: dest.port };
		// Fire-and-forget; backpressure handled by the wasm send budget. A
		// rejection (socket torn down mid-pump) is UDP loss, not an error to
		// surface — swallow it so it never becomes an unhandled rejection.
		this.writer.write(msg).catch(() => {});
	}

	onPacket(cb: (data: Uint8Array, source: UdpAddr) => void): void {
		this.cb = cb;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		// UDPSocket.close() REJECTS while readable/writable are locked, so the
		// stream locks must be released first: cancel() the parked reader (this
		// also unblocks readLoop's pending read()) and release the writer.
		try {
			await this.reader?.cancel();
		} catch {
			// reader already gone
		}
		try {
			this.writer?.releaseLock();
		} catch {
			// writer already released
		}
		try {
			await this.socket.close();
		} catch {
			// already closing
		}
	}
}
