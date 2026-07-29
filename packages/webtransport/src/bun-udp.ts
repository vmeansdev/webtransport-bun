// Bun UDP adapter implementing UdpTransport — lets the wasm WebTransport stack
// run over real UDP in Bun/Node (not just a browser's Direct Sockets). Useful
// for cross-stack interop (wasm client <-> native server) and for headless tests.

import type { UdpAddr, UdpTransport } from "./wasm-relay.js";

interface BunUdpSocket {
	send(data: Uint8Array, port?: number, address?: string): number | boolean;
	close(): void;
	readonly port?: number;
}
interface BunUdpGlobal {
	udpSocket(opts: {
		connect?: { hostname: string; port: number };
		hostname?: string;
		port?: number;
		socket: {
			data(
				socket: BunUdpSocket,
				data: Uint8Array,
				port: number,
				address: string,
			): void;
		};
	}): Promise<BunUdpSocket>;
}

function bun(): BunUdpGlobal {
	const b = (globalThis as { Bun?: BunUdpGlobal }).Bun;
	if (!b?.udpSocket) {
		throw new Error("Bun.udpSocket is unavailable: run under Bun");
	}
	return b;
}

export class BunUdpTransport implements UdpTransport {
	private cb: ((data: Uint8Array, source: UdpAddr) => void) | null = null;
	private closed = false;

	/** Bound port (OS-assigned when the caller passed 0); unset in client mode. */
	readonly localPort?: number;

	private constructor(
		private socket: BunUdpSocket,
		private connected: boolean,
	) {
		if (!connected) this.localPort = socket.port;
	}

	/** Client: connected socket toward a fixed server. */
	static async connect(host: string, port: number): Promise<BunUdpTransport> {
		let self: BunUdpTransport;
		const socket = await bun().udpSocket({
			connect: { hostname: host, port },
			socket: {
				// Connected socket: all packets come from the fixed server.
				data: (_s, data) => self?.deliver(data, { address: host, port }),
			},
		});
		self = new BunUdpTransport(socket, true);
		return self;
	}

	/** Server: bound socket on a local port. Surfaces each packet's real peer. */
	static async bind(host: string, port: number): Promise<BunUdpTransport> {
		let self: BunUdpTransport;
		const socket = await bun().udpSocket({
			hostname: host,
			port,
			socket: {
				data: (_s, data, p, addr) =>
					self?.deliver(data, { address: addr, port: p }),
			},
		});
		self = new BunUdpTransport(socket, false);
		return self;
	}

	private deliver(data: Uint8Array, source: UdpAddr): void {
		// Copy: Bun may reuse the backing buffer after the callback returns.
		this.cb?.(data.slice(), source);
	}

	send(data: Uint8Array, dest: UdpAddr): void {
		if (this.closed) return;
		// A connected client socket always targets its fixed server, so `dest`
		// is ignored there; a bound server socket routes to the given peer.
		// A failed send is UDP packet loss, never an exception into the pump —
		// Bun closes a connected socket on ICMP unreachable (dead peer), and
		// QUIC's idle timeout is the correct detector for that.
		try {
			if (this.connected) this.socket.send(data);
			else this.socket.send(data, dest.port, dest.address);
		} catch {
			// Dropped; loss recovery / idle timeout handles the rest.
		}
	}

	onPacket(cb: (data: Uint8Array, source: UdpAddr) => void): void {
		this.cb = cb;
	}

	close(): void {
		this.closed = true;
		try {
			this.socket.close();
		} catch {
			// already closed
		}
	}
}
