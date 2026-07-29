// UDP transport abstraction addressed by "ip:port". The real Direct Sockets
// adapter and the Bun adapter implement the same interface; tests use the
// InMemoryRelay switch below.

/** A remote endpoint address as surfaced by the UDP layer. */
export interface UdpAddr {
	address: string;
	port: number;
}

export interface UdpTransport {
	/**
	 * Port the socket actually bound to. Set by bound-mode (server) adapters and
	 * is the OS-assigned port when the caller asked for the ephemeral port 0.
	 */
	readonly localPort?: number;
	/** Send `data` toward `dest`. A connected client socket may ignore `dest`. */
	send(data: Uint8Array, dest: UdpAddr): void;
	/** Register the inbound-packet callback; `source` is the sender's address. */
	onPacket(cb: (data: Uint8Array, source: UdpAddr) => void): void;
	/** Release the underlying socket, if any. Idempotent. */
	close?(): void;
}

function addrKey(a: UdpAddr): string {
	return `${a.address}:${a.port}`;
}

/**
 * An in-memory UDP switch: endpoints register at an "ip:port" address and sends
 * are routed to the destination endpoint's onPacket, tagged with the sender's
 * address. Delivery stays async (queueMicrotask) and copies the buffer, matching
 * real socket semantics.
 */
export class InMemoryRelay {
	private endpoints = new Map<
		string,
		(data: Uint8Array, source: UdpAddr) => void
	>();

	/** Create a transport bound at `addr` that routes through this switch. */
	endpoint(addr: UdpAddr): UdpTransport {
		const selfKey = addrKey(addr);
		return {
			send: (data, dest) => {
				const cb = this.endpoints.get(addrKey(dest));
				if (cb) {
					const copy = data.slice();
					queueMicrotask(() => cb(copy, { ...addr }));
				}
			},
			onPacket: (cb) => {
				this.endpoints.set(selfKey, cb);
			},
		};
	}

	/**
	 * Convenience for the legacy 2-endpoint tests: a fixed point-to-point pair.
	 * `.a`'s sends go to `.b` and vice versa, ignoring the passed destination.
	 * Packets carry the fixed loopback source addresses used by those fixtures.
	 */
	readonly a: UdpTransport;
	readonly b: UdpTransport;

	constructor() {
		let aCb: ((d: Uint8Array, s: UdpAddr) => void) | null = null;
		let bCb: ((d: Uint8Array, s: UdpAddr) => void) | null = null;
		const aSource: UdpAddr = { address: "127.0.0.1", port: 4433 };
		const bSource: UdpAddr = { address: "127.0.0.1", port: 5544 };
		this.a = {
			send: (data) => {
				if (bCb) {
					const copy = data.slice();
					queueMicrotask(() => bCb?.(copy, { ...aSource }));
				}
			},
			onPacket: (cb) => {
				aCb = cb;
			},
		};
		this.b = {
			send: (data) => {
				if (aCb) {
					const copy = data.slice();
					queueMicrotask(() => aCb?.(copy, { ...bSource }));
				}
			},
			onPacket: (cb) => {
				bCb = cb;
			},
		};
	}
}
