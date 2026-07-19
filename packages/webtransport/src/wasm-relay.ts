// UDP transport abstraction addressed by "ip:port". The real Direct Sockets
// adapter and the Bun adapter implement the same interface; tests use the
// InMemoryRelay switch below.

/** A remote endpoint address as surfaced by the UDP layer. */
export interface UdpAddr {
	address: string;
	port: number;
}

export interface UdpTransport {
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
	 * The reported source is intentionally unparseable so each endpoint falls
	 * back to its own configured peer address — preserving the original
	 * single-peer behavior independent of which addresses the test uses.
	 */
	readonly a: UdpTransport;
	readonly b: UdpTransport;

	constructor() {
		let aCb: ((d: Uint8Array, s: UdpAddr) => void) | null = null;
		let bCb: ((d: Uint8Array, s: UdpAddr) => void) | null = null;
		// address "" / port NaN => "ip:port" parse fails on the Rust side, so the
		// endpoint uses its configured peer_addr (matches legacy point-to-point).
		const unknown: UdpAddr = { address: "", port: Number.NaN };
		this.a = {
			send: (data) => {
				if (bCb) {
					const copy = data.slice();
					queueMicrotask(() => bCb?.(copy, unknown));
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
					queueMicrotask(() => aCb?.(copy, unknown));
				}
			},
			onPacket: (cb) => {
				bCb = cb;
			},
		};
	}
}
