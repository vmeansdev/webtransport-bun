/**
 * Stream sink ring layout, LAYOUT_VERSION 1 (docs/RFC_STREAM_SINK.md §4).
 *
 * The Rust writer in crates/native/src/stream_sink.rs is the layout
 * authority; this module mirrors it for the TS consumer (SinkReader) and the
 * wasm producer (RingWriter). The cross-language golden vector pins both
 * sides to the same bytes. No native imports: workers load this standalone.
 */

export const SINK_MAGIC = 0x5754_534b; // "WTSK"
export const SINK_LAYOUT_VERSION = 1;
/** Data region start; config/producer/consumer lines live below it. */
export const SINK_DATA_OFFSET = 192;
export const SINK_RECORD_HEADER_BYTES = 32;
/** Capacity withheld so a terminal record always commits on a full ring. */
export const SINK_RESERVED_TAIL_BYTES = 128;

// Header word byte offsets.
export const OFF_MAGIC = 0;
export const OFF_VERSION = 4;
export const OFF_CAPACITY = 8;
export const OFF_FLAGS = 12;
export const OFF_TAIL = 64;
export const OFF_STATE = 68;
export const OFF_DROPPED_RECORDS = 72;
export const OFF_DROPPED_BYTES = 80;
export const OFF_HIGH_WATER = 88;
export const OFF_HEAD = 128;
export const OFF_HEARTBEAT = 132;

// Int32Array indices for the Atomics-visited words.
export const I32_TAIL = OFF_TAIL / 4;
export const I32_HEAD = OFF_HEAD / 4;
export const I32_HEARTBEAT = OFF_HEARTBEAT / 4;

// Config `flags` bits.
export const FLAG_FRAMING = 1 << 0;
export const FLAG_DROP_NEWEST = 1 << 1;
export const FLAG_CLOCK_WALL = 1 << 2;
export const FLAG_PRODUCER_NOTIFIES = 1 << 3;

// `sinkState` word values.
export const SINK_STATE_ACTIVE = 0;
export const SINK_STATE_TERMINAL_COMMITTED = 1;
export const SINK_STATE_EXITED = 2;

// Record `type` bytes.
export const REC_DATA = 1;
export const REC_MESSAGE = 2;
export const REC_EOF = 3;
export const REC_ERROR = 4;
export const REC_RESET = 5;
export const REC_WRAP = 6;
export const REC_DROPGAP = 7;

/** What one native sink task reports through `sinkStats().taskState`. */
export const TASK_STATE_NAMES = [
	"active",
	"eof",
	"error",
	"reset",
	"stalled",
	"closed",
] as const;
export type SinkTaskStateName = (typeof TASK_STATE_NAMES)[number];

/** Descriptor a StreamSinkHandle hands to the worker's SinkReader. */
export interface StreamSinkDescriptor {
	version: 1;
	/** Bytes in the data region (power of two). */
	dataCapacity: number;
	/** Config-line flags, verbatim. */
	flags: number;
	clock: "monotonic" | "wall";
	/**
	 * (monotonic, wall) microseconds sampled at the same instant at open, so
	 * consumers of monotonic stamps can map into wall time.
	 */
	monotonicAnchorUs: number;
	wallAnchorUs: number;
	framing: StreamSinkFraming | null;
}

/** Declarative length-prefix framing (RFC_STREAM_SINK §3). */
export interface StreamSinkFraming {
	headerBytes: number;
	lengthOffset: number;
	lengthWidth: 1 | 2 | 4 | 8;
	endianness?: "le" | "be";
	lengthIncludesHeader?: boolean;
	maxFrameBytes: number;
}
