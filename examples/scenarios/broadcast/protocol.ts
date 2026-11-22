// Wire format of the ticker. One datagram per tick, the same bytes to every
// subscriber:
//
//   seq u32 | server send time f64 (ms, epoch-based) | filler to the tick size
//
// The send time is taken when the tick is built, before the fan-out, so a
// subscriber's "age" includes however long the pacer took to reach it. It is
// comparable with the receiver's clock only when both run on the same host.

export const HEADER_BYTES = 12;
export const DEFAULT_TICK_HZ = 5;
export const DEFAULT_TICK_BYTES = 200;

/** Milliseconds on a clock two processes on one host agree on. */
export function wallMs(): number {
	return performance.timeOrigin + performance.now();
}

export function writeTick(buf: Uint8Array, seq: number, sentMs: number) {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	view.setUint32(0, seq, true);
	view.setFloat64(4, sentMs, true);
}

export function readTick(buf: Uint8Array): { seq: number; sentMs: number } {
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	return { seq: view.getUint32(0, true), sentMs: view.getFloat64(4, true) };
}
