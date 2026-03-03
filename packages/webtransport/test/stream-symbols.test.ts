import { describe, it, expect } from "bun:test";
import {
	BidiStream,
	SendStream,
	RecvStream,
	WT_RESET,
	WT_STOP_SENDING,
} from "../src/streams.js";

describe("WT stream symbols", () => {
	it("WT_RESET on BidiStream calls native reset and destroys stream", () => {
		const calls: number[] = [];
		const native = {
			reset: (code: number) => calls.push(code),
			stopSending: (_code: number) => {},
			read: async () => null,
			write: async (_chunk: Buffer) => {},
			finish: () => {},
		};
		const stream = new BidiStream({ handleId: 1, nativeHandle: native });
		stream[WT_RESET](42);
		expect(calls[0]).toBe(42);
		expect(calls).toContain(0);
		expect(stream.destroyed).toBe(true);
	});

	it("WT_STOP_SENDING on BidiStream calls native stopSending", () => {
		const calls: number[] = [];
		const native = {
			reset: (_code: number) => {},
			stopSending: (code: number) => calls.push(code),
			read: async () => null,
			write: async (_chunk: Buffer) => {},
			finish: () => {},
		};
		const stream = new BidiStream({ handleId: 2, nativeHandle: native });
		stream[WT_STOP_SENDING](9);
		expect(calls).toEqual([9]);
	});

	it("WT_RESET on SendStream calls native reset and destroys stream", () => {
		const calls: number[] = [];
		const native = {
			reset: (code: number) => calls.push(code),
			write: async (_chunk: Buffer) => {},
			finish: () => {},
		};
		const stream = new SendStream({ handleId: 3, nativeHandle: native });
		stream[WT_RESET](77);
		expect(calls[0]).toBe(77);
		expect(calls).toContain(0);
		expect(stream.destroyed).toBe(true);
	});

	it("WT_STOP_SENDING on RecvStream calls native stopSending", () => {
		const calls: number[] = [];
		const native = {
			stopSending: (code: number) => calls.push(code),
			read: async () => null,
		};
		const stream = new RecvStream({ handleId: 4, nativeHandle: native });
		stream[WT_STOP_SENDING](88);
		expect(calls).toEqual([88]);
	});

	it("BidiStream destroy logs warning when native reset throws", () => {
		const native = {
			reset: (_code: number) => {
				throw new Error("reset-fail");
			},
			stopSending: (_code: number) => {},
			read: async () => null,
			write: async (_chunk: Buffer) => {},
			finish: () => {},
		};
		const stream = new BidiStream({ handleId: 5, nativeHandle: native });
		const warn = console.warn;
		const seen: string[] = [];
		console.warn = (...args: unknown[]) => {
			seen.push(args.map(String).join(" "));
		};
		try {
			stream.destroy();
		} finally {
			console.warn = warn;
		}
		expect(
			seen.some((s) => s.includes("bidi stream reset on destroy failed")),
		).toBe(true);
	});

	it("SendStream destroy logs warning when native reset throws", () => {
		const native = {
			reset: (_code: number) => {
				throw new Error("reset-fail");
			},
			write: async (_chunk: Buffer) => {},
			finish: () => {},
		};
		const stream = new SendStream({ handleId: 6, nativeHandle: native });
		const warn = console.warn;
		const seen: string[] = [];
		console.warn = (...args: unknown[]) => {
			seen.push(args.map(String).join(" "));
		};
		try {
			stream.destroy();
		} finally {
			console.warn = warn;
		}
		expect(
			seen.some((s) =>
				s.includes("unidirectional send stream reset on destroy failed"),
			),
		).toBe(true);
	});

	it("RecvStream destroy logs warning when native stopSending throws", () => {
		const native = {
			stopSending: (_code: number) => {
				throw new Error("stop-fail");
			},
			read: async () => null,
		};
		const stream = new RecvStream({ handleId: 7, nativeHandle: native });
		const warn = console.warn;
		const seen: string[] = [];
		console.warn = (...args: unknown[]) => {
			seen.push(args.map(String).join(" "));
		};
		try {
			stream.destroy();
		} finally {
			console.warn = warn;
		}
		expect(
			seen.some((s) =>
				s.includes("unidirectional recv stream stopSending on destroy failed"),
			),
		).toBe(true);
	});
});
