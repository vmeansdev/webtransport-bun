// Wire format shared by the game server and client. Every message is one
// datagram whose first byte is its kind.
//
//   input    client -> server   4 Hz per player, 32 B
//   action   client -> server   every 8th input, 32 B, answered by an ack
//   ack      server -> client   on receipt of an action, 64 B
//   snapshot server -> client   5 Hz per player, 3 datagrams of 1,150 B

export const Kind = { Input: 1, Action: 2, Ack: 3, Snapshot: 4 } as const;

export const INPUT_HZ = 4;
export const ACTION_EVERY = 8;
export const INPUT_BYTES = 32;
export const ACK_BYTES = 64;
export const SNAPSHOT_HZ = 5;
export const SNAPSHOT_PARTS = 3;
export const SNAPSHOT_PART_BYTES = 1150;

// kind u8 | seq u32 | client send time f64 (ms, client clock)
export function writeInput(
	buf: Uint8Array,
	kind: number,
	seq: number,
	sentMs: number,
) {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	view.setUint8(0, kind);
	view.setUint32(1, seq, true);
	view.setFloat64(5, sentMs, true);
}

export function readStamp(buf: Uint8Array): {
	kind: number;
	seq: number;
	sentMs: number;
} {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return {
		kind: view.getUint8(0),
		seq: view.getUint32(1, true),
		sentMs: view.getFloat64(5, true),
	};
}
