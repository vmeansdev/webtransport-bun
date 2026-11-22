// Wire format shared by the rooms server and client.
//
// A server session does not expose the URL the client dialled, so a client
// says which room it wants on its first bidirectional stream:
//
//   join     client -> server   one JSON object, then FIN: {"room":"r1","role":"pub"}
//   joined   server -> client   one JSON object, then FIN: {"publisherId":3} or {"error":"..."}
//
// After that every media packet is one datagram:
//
//   kind u8 | publisher u16 | seq u32 | publisher send time f64 (ms) | payload
//
// The server overwrites the publisher field with the id it assigned on join,
// so a client cannot speak for another publisher in its room.

export const Kind = { Media: 1 } as const;

export type Role = "pub" | "sub";
export type JoinRequest = { room: string; role: Role };
export type JoinReply = { publisherId: number } | { error: string };

export const HEADER_BYTES = 15;
export const JOIN_TIMEOUT_MS = 5000;
export const MAX_JOIN_BYTES = 512;

// 30 fps at ~3 Mbps: 11 datagrams of 1,150 B per frame.
export const DEFAULT_FPS = 30;
export const DEFAULT_KBPS = 3000;
export const DEFAULT_PACKET_BYTES = 1150;

export function packetsPerFrame(
	kbps: number,
	fps: number,
	packetBytes: number,
): number {
	return Math.max(1, Math.ceil((kbps * 1000) / 8 / fps / packetBytes));
}

export function writeMediaHeader(
	buf: Uint8Array,
	publisher: number,
	seq: number,
	sentMs: number,
) {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	view.setUint8(0, Kind.Media);
	view.setUint16(1, publisher, true);
	view.setUint32(3, seq, true);
	view.setFloat64(7, sentMs, true);
}

export function setPublisher(buf: Uint8Array, publisher: number) {
	buf[1] = publisher & 0xff;
	buf[2] = publisher >>> 8;
}

export function readMediaHeader(buf: Uint8Array): {
	kind: number;
	publisher: number;
	seq: number;
	sentMs: number;
} {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return {
		kind: view.getUint8(0),
		publisher: view.getUint16(1, true),
		seq: view.getUint32(3, true),
		sentMs: view.getFloat64(7, true),
	};
}

/** Resolve `promise`, or `null` once `ms` has passed, whichever is first. */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), ms);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
