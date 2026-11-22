// Wire format and helpers shared by the RPC / tunnel server and client
// (runbook: docs/scenarios/rpc-and-tunnels.md). Every stream the
// client opens is a bidirectional stream whose first byte is its mode.
//
//   exchange  mode u8 | response size u32 | request padding ... FIN
//             server reads to FIN, then answers
//             request size u32 | response padding ... FIN
//
//   tunnel    mode u8, then length-prefixed frames in both directions:
//             len u32 (bytes after this field) | type u8 | body
//               hello    client -> server  bits/s u32 | frame size u32
//               data     both ways         seq u32 | sent wall-clock ms f64 | padding
//               summary  server -> client  JSON, after the client's FIN
//
// A stream is a byte stream: one read can hold half a frame or several, so
// FrameReader reassembles frames before anything looks at them.

export const Mode = { Exchange: 1, Tunnel: 2 } as const;
export const Frame = { Hello: 1, Data: 2, Summary: 3 } as const;

export const LEN_BYTES = 4;
export const DATA_HEADER_BYTES = LEN_BYTES + 1 + 4 + 8;
export const EXCHANGE_HEADER_BYTES = 1 + 4;

// Session and open errors are WebTransportErrors with a `code`; errors a
// Node stream emits are plain Errors whose message starts with the code.
export function errorCode(err: unknown): string {
	const { code, message } = (err ?? {}) as { code?: string; message?: string };
	return code ?? /^E_[A-Z_]+/.exec(message ?? "")?.[0] ?? "unknown";
}

/** Wall-anchored milliseconds, comparable between processes on one host. */
export function wallNowMs(): number {
	return performance.timeOrigin + performance.now();
}

export function exchangeRequest(
	requestBytes: number,
	responseBytes: number,
): Uint8Array {
	const buf = new Uint8Array(Math.max(EXCHANGE_HEADER_BYTES, requestBytes));
	buf[0] = Mode.Exchange;
	new DataView(buf.buffer).setUint32(1, responseBytes, true);
	return buf;
}

export function exchangeResponse(
	requestBytes: number,
	responseBytes: number,
): Uint8Array {
	const buf = new Uint8Array(Math.max(4, responseBytes));
	new DataView(buf.buffer).setUint32(0, requestBytes, true);
	return buf;
}

export function encodeFrame(type: number, body: Uint8Array): Uint8Array {
	const buf = new Uint8Array(LEN_BYTES + 1 + body.byteLength);
	new DataView(buf.buffer).setUint32(0, 1 + body.byteLength, true);
	buf[LEN_BYTES] = type;
	buf.set(body, LEN_BYTES + 1);
	return buf;
}

export function tunnelHello(bitsPerSec: number, frameBytes: number) {
	const body = new Uint8Array(8);
	const view = new DataView(body.buffer);
	view.setUint32(0, bitsPerSec, true);
	view.setUint32(4, frameBytes, true);
	const frame = encodeFrame(Frame.Hello, body);
	const out = new Uint8Array(1 + frame.byteLength);
	out[0] = Mode.Tunnel;
	out.set(frame, 1);
	return out;
}

/**
 * `count` data frames of `frameBytes` each (length prefix included), packed
 * into one buffer so a tick costs one stream write, not one per frame.
 */
export function dataFrames(
	count: number,
	frameBytes: number,
	firstSeq: number,
	sentMs: number,
): Uint8Array {
	const buf = new Uint8Array(count * frameBytes);
	const view = new DataView(buf.buffer);
	for (let i = 0; i < count; i++) {
		const at = i * frameBytes;
		view.setUint32(at, frameBytes - LEN_BYTES, true);
		view.setUint8(at + LEN_BYTES, Frame.Data);
		view.setUint32(at + LEN_BYTES + 1, firstSeq + i, true);
		view.setFloat64(at + LEN_BYTES + 5, sentMs, true);
	}
	return buf;
}

export type ParsedFrame = { type: number; body: Uint8Array; bytes: number };

export class FrameReader {
	#pending = new Uint8Array(0);

	/** Feed one read's bytes; returns every frame they complete. */
	push(chunk: Uint8Array): ParsedFrame[] {
		let buf = chunk;
		if (this.#pending.byteLength > 0) {
			buf = new Uint8Array(this.#pending.byteLength + chunk.byteLength);
			buf.set(this.#pending);
			buf.set(chunk, this.#pending.byteLength);
		}
		const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
		const frames: ParsedFrame[] = [];
		let at = 0;
		while (buf.byteLength - at >= LEN_BYTES) {
			const len = view.getUint32(at, true);
			if (buf.byteLength - at - LEN_BYTES < len) break;
			frames.push({
				type: buf[at + LEN_BYTES] as number,
				body: buf.subarray(at + LEN_BYTES + 1, at + LEN_BYTES + len),
				bytes: LEN_BYTES + len,
			});
			at += LEN_BYTES + len;
		}
		// Copy the tail: the caller may reuse or release the chunk it passed in.
		this.#pending = buf.slice(at);
		return frames;
	}

	get buffered(): number {
		return this.#pending.byteLength;
	}
}

export function readDataStamp(body: Uint8Array): {
	seq: number;
	sentMs: number;
} {
	const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
	return { seq: view.getUint32(0, true), sentMs: view.getFloat64(4, true) };
}

/**
 * Latency histogram with ~2 % wide logarithmic buckets from 10 µs to about
 * 100 s. It is small enough to ship in the tunnel summary and merges across
 * sessions, which per-session percentiles cannot.
 */
export class LatencyHistogram {
	static readonly MIN_MS = 0.01;
	static readonly GROWTH = 1.02;
	readonly counts = new Map<number, number>();
	total = 0;

	record(ms: number) {
		const index =
			ms <= LatencyHistogram.MIN_MS
				? 0
				: Math.ceil(
						Math.log(ms / LatencyHistogram.MIN_MS) /
							Math.log(LatencyHistogram.GROWTH),
					);
		this.counts.set(index, (this.counts.get(index) ?? 0) + 1);
		this.total++;
	}

	merge(other: LatencyHistogram) {
		for (const [index, count] of other.counts)
			this.counts.set(index, (this.counts.get(index) ?? 0) + count);
		this.total += other.total;
	}

	/** Upper edge of the bucket holding the p-th percentile, in ms. */
	percentile(p: number): number {
		if (this.total === 0) return Number.NaN;
		const rank = Math.max(1, Math.ceil((p / 100) * this.total));
		let seen = 0;
		for (const index of [...this.counts.keys()].sort((a, b) => a - b)) {
			seen += this.counts.get(index) as number;
			if (seen >= rank)
				return LatencyHistogram.MIN_MS * LatencyHistogram.GROWTH ** index;
		}
		return Number.NaN;
	}

	toJSON(): [number, number][] {
		return [...this.counts];
	}

	static from(pairs: [number, number][]): LatencyHistogram {
		const h = new LatencyHistogram();
		for (const [index, count] of pairs) {
			h.counts.set(index, count);
			h.total += count;
		}
		return h;
	}
}

const TICK_MS = 10;
const MAX_WRITE_BYTES = 64 * 1024;

/**
 * Paces one direction of a tunnel: every 10 ms it writes the data frames the
 * schedule says are due, as one write. It keeps a single write in flight, so
 * a stream that pushes back makes the sender fall behind its schedule rather
 * than pile bytes up in JavaScript; the next writes catch up, at most 64 KiB
 * at a time. bytesOffered against bytesSent shows how far behind it fell.
 */
export class TunnelSender {
	readonly framesPerSec: number;
	readonly frameBytes: number;
	bytesSent = 0;
	error: unknown;
	#seq = 0;
	#startedAt = 0;
	#stoppedAt = 0;
	#timer: ReturnType<typeof setInterval> | undefined;
	#phase: ReturnType<typeof setTimeout> | undefined;
	#inFlight: Promise<void> | null = null;
	readonly #write: (buf: Uint8Array) => Promise<void>;

	constructor(
		bitsPerSec: number,
		frameBytes: number,
		write: (buf: Uint8Array) => Promise<void>,
	) {
		this.frameBytes = frameBytes;
		this.framesPerSec = bitsPerSec / 8 / frameBytes;
		this.#write = write;
	}

	/** Starts at a random phase of the tick so tunnels do not send in step. */
	start() {
		this.#phase = setTimeout(() => {
			this.#startedAt = performance.now();
			this.#timer = setInterval(() => this.#tick(), TICK_MS);
		}, Math.random() * TICK_MS);
	}

	#tick() {
		if (this.#inFlight || this.error !== undefined) return;
		const due =
			Math.floor(
				((performance.now() - this.#startedAt) / 1000) * this.framesPerSec,
			) - this.#seq;
		const count = Math.min(
			due,
			Math.max(1, Math.floor(MAX_WRITE_BYTES / this.frameBytes)),
		);
		if (count <= 0) return;
		const buf = dataFrames(count, this.frameBytes, this.#seq, wallNowMs());
		this.#seq += count;
		this.#inFlight = this.#write(buf).then(
			() => {
				this.bytesSent += buf.byteLength;
				this.#inFlight = null;
			},
			(err) => {
				this.error = err;
				this.#inFlight = null;
			},
		);
	}

	/** Stops the schedule and waits for the write in flight to settle. */
	async stop() {
		clearTimeout(this.#phase);
		clearInterval(this.#timer);
		this.#stoppedAt ||= performance.now();
		await this.#inFlight;
	}

	get elapsedMs(): number {
		if (this.#startedAt === 0) return 0;
		return (this.#stoppedAt || performance.now()) - this.#startedAt;
	}

	get bytesOffered(): number {
		return (
			Math.floor((this.elapsedMs / 1000) * this.framesPerSec) * this.frameBytes
		);
	}
}

/** What the server tells the client about a tunnel once the client is done. */
export type TunnelSummary = {
	/** Data-frame bytes the server read from the client (up). */
	upBytesReceived: number;
	upFramesReceived: number;
	upLatency: [number, number][];
	/** Data-frame bytes the server's schedule called for, and wrote (down). */
	downBytesOffered: number;
	downBytesSent: number;
	downElapsedMs: number;
};
