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
		expect(calls).toEqual([42]);
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
		expect(calls).toEqual([77]);
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

	it("destroy without error does not emit reset/stopSending control frames", () => {
		const bidiCalls: number[] = [];
		const sendCalls: number[] = [];
		const recvCalls: number[] = [];
		const bidi = new BidiStream({
			handleId: 10,
			nativeHandle: {
				reset: (code: number) => bidiCalls.push(code),
				stopSending: (_code: number) => {},
				read: async () => null,
				write: async (_chunk: Buffer) => {},
				finish: () => {},
			},
		});
		const send = new SendStream({
			handleId: 11,
			nativeHandle: {
				reset: (code: number) => sendCalls.push(code),
				write: async (_chunk: Buffer) => {},
				finish: () => {},
			},
		});
		const recv = new RecvStream({
			handleId: 12,
			nativeHandle: {
				stopSending: (code: number) => recvCalls.push(code),
				read: async () => null,
			},
		});
		bidi.destroy();
		send.destroy();
		recv.destroy();
		expect(bidiCalls).toEqual([]);
		expect(sendCalls).toEqual([]);
		expect(recvCalls).toEqual([]);
	});

	it("destroy(error) without external error listener logs fallback warning", async () => {
		const stream = new BidiStream({
			handleId: 13,
			nativeHandle: {
				reset: (_code: number) => {},
				stopSending: (_code: number) => {},
				read: async () => null,
				write: async (_chunk: Buffer) => {},
				finish: () => {},
			},
		});
		const warn = console.warn;
		const seen: string[] = [];
		console.warn = (...args: unknown[]) => {
			seen.push(args.map(String).join(" "));
		};
		try {
			stream.destroy(new Error("boom"));
			await Bun.sleep(0);
		} finally {
			console.warn = warn;
		}
		expect(stream.destroyed).toBe(true);
		const suppressed =
			process.env.WEBTRANSPORT_SUPPRESS_UNHANDLED_STREAM_ERROR_LOGS === "1";
		expect(
			seen.some((s) => s.includes("unhandled bidi stream error: boom")),
		).toBe(!suppressed);
	});

	it("BidiStream destroy(error) logs warning when native reset throws", () => {
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
		stream.on("error", () => {});
		const warn = console.warn;
		const seen: string[] = [];
		console.warn = (...args: unknown[]) => {
			seen.push(args.map(String).join(" "));
		};
		try {
			stream.destroy(new Error("boom"));
		} finally {
			console.warn = warn;
		}
		expect(
			seen.some((s) => s.includes("bidi stream reset on destroy failed")),
		).toBe(true);
	});

	it("SendStream destroy(error) logs warning when native reset throws", () => {
		const native = {
			reset: (_code: number) => {
				throw new Error("reset-fail");
			},
			write: async (_chunk: Buffer) => {},
			finish: () => {},
		};
		const stream = new SendStream({ handleId: 6, nativeHandle: native });
		stream.on("error", () => {});
		const warn = console.warn;
		const seen: string[] = [];
		console.warn = (...args: unknown[]) => {
			seen.push(args.map(String).join(" "));
		};
		try {
			stream.destroy(new Error("boom"));
		} finally {
			console.warn = warn;
		}
		expect(
			seen.some((s) =>
				s.includes("unidirectional send stream reset on destroy failed"),
			),
		).toBe(true);
	});

	it("RecvStream destroy(error) logs warning when native stopSending throws", () => {
		const native = {
			stopSending: (_code: number) => {
				throw new Error("stop-fail");
			},
			read: async () => null,
		};
		const stream = new RecvStream({ handleId: 7, nativeHandle: native });
		stream.on("error", () => {});
		const warn = console.warn;
		const seen: string[] = [];
		console.warn = (...args: unknown[]) => {
			seen.push(args.map(String).join(" "));
		};
		try {
			stream.destroy(new Error("boom"));
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
