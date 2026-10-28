/**
 * New public options objects must reject malformed values instead of silently
 * coercing them: an unknown sink `overflow` must not quietly become lossless
 * blocking, a negative timeout must not quietly disable a deadline, and a bad
 * explicit QUIC window must not quietly fall back to the derived one.
 */

import { describe, expect, it } from "bun:test";
import { connect, createServer, E_INVALID_ARGUMENT } from "../src/index.js";
import {
	openReadSinkOnNativeHandle,
	type SinkCapableNativeHandle,
	validateStreamSinkOptions,
} from "../src/sink.js";
import { openWasmReadSink, type WasmSinkStream } from "../src/wasm-sink.js";
import { nextPort } from "./helpers/network.js";

const FRAMING = {
	headerBytes: 4,
	lengthOffset: 0,
	lengthWidth: 4,
	maxFrameBytes: 1024,
};

const BAD_SINK_OPTIONS: [string, unknown][] = [
	["overflow drop-oldest", { overflow: "drop-oldest" }],
	["overflow empty", { overflow: "" }],
	["clock utc", { clock: "utc" }],
	["clock non-string", { clock: 1 }],
	["backpressureTimeoutMs -1", { backpressureTimeoutMs: -1 }],
	["backpressureTimeoutMs 0", { backpressureTimeoutMs: 0 }],
	["backpressureTimeoutMs NaN", { backpressureTimeoutMs: Number.NaN }],
	["backpressureTimeoutMs Infinity", { backpressureTimeoutMs: Infinity }],
	["backpressureTimeoutMs 1.5", { backpressureTimeoutMs: 1.5 }],
	["backpressureTimeoutMs 2**31", { backpressureTimeoutMs: 2 ** 31 }],
	["idleTimeoutMs -1", { idleTimeoutMs: -1 }],
	["idleTimeoutMs NaN", { idleTimeoutMs: Number.NaN }],
	["idleTimeoutMs Infinity", { idleTimeoutMs: Infinity }],
	["idleTimeoutMs string", { idleTimeoutMs: "5" }],
	["ringBytes NaN", { ringBytes: Number.NaN }],
	["ringBytes string", { ringBytes: "4096" }],
	["ringBytes -1", { ringBytes: -1 }],
	["framing not an object", { framing: 4 }],
	["framing lengthWidth 3", { framing: { ...FRAMING, lengthWidth: 3 } }],
	["framing endianness", { framing: { ...FRAMING, endianness: "middle" } }],
	[
		"framing lengthIncludesHeader",
		{ framing: { ...FRAMING, lengthIncludesHeader: "yes" } },
	],
	["framing headerBytes -1", { framing: { ...FRAMING, headerBytes: -1 } }],
	["options not an object", 7],
];

const neverNative = new Proxy({} as SinkCapableNativeHandle, {
	get: () => () => {
		throw new Error("the native handle must not be reached");
	},
});
const neverWasm = new Proxy({} as WasmSinkStream, {
	get: () => () => {
		throw new Error("the wasm stream must not be reached");
	},
});

describe("openReadSink options", () => {
	for (const [label, opts] of BAD_SINK_OPTIONS) {
		it(`rejects ${label} with E_SINK_BAD_OPTIONS on both backends`, () => {
			expect(() => validateStreamSinkOptions(opts)).toThrow(
				/^E_SINK_BAD_OPTIONS: /,
			);
			expect(() =>
				openReadSinkOnNativeHandle(neverNative, opts as never),
			).toThrow(/^E_SINK_BAD_OPTIONS: /);
			expect(() => openWasmReadSink(neverWasm, opts as never)).toThrow(
				/^E_SINK_BAD_OPTIONS: /,
			);
		});
	}

	it("accepts every documented value", () => {
		for (const opts of [
			undefined,
			{},
			{ overflow: "block" },
			{ overflow: "drop-newest", idleTimeoutMs: 0 },
			{ clock: "monotonic" },
			{ clock: "wall" },
			{ backpressureTimeoutMs: 1, idleTimeoutMs: 2 ** 31 - 1 },
			{ ringBytes: 65_536.5 },
			{
				framing: {
					...FRAMING,
					lengthWidth: 8,
					endianness: "be",
					lengthIncludesHeader: false,
				},
			},
		]) {
			expect(() => validateStreamSinkOptions(opts)).not.toThrow();
		}
	});
});

describe("explicit QUIC window options", () => {
	const BAD = [0, -1, 1.5, Number.NaN, Infinity, 2 ** 53, "65536"];
	for (const key of [
		"streamReceiveWindow",
		"receiveWindow",
		"sendWindow",
	] as const) {
		it(`createServer rejects a malformed limits.${key}`, () => {
			for (const bad of BAD) {
				expect(() =>
					createServer({
						port: 0,
						tls: { certPem: "", keyPem: "" },
						limits: { [key]: bad } as never,
						onSession: () => {},
					}),
				).toThrow(
					new RegExp(`^${E_INVALID_ARGUMENT}: limits\\.${key} must be`),
				);
			}
		});

		it(`connect rejects a malformed limits.${key}`, async () => {
			for (const bad of BAD) {
				await expect(
					connect(`https://127.0.0.1:${nextPort(27_800, 60)}`, {
						tls: { insecureSkipVerify: true },
						limits: { [key]: bad } as never,
					}),
				).rejects.toThrow(
					new RegExp(`^${E_INVALID_ARGUMENT}: limits\\.${key} must be`),
				);
			}
		});
	}
});

describe("explicit null is never read as omitted", () => {
	for (const key of [
		"framing",
		"overflow",
		"clock",
		"backpressureTimeoutMs",
		"idleTimeoutMs",
		"ringBytes",
	]) {
		it(`openReadSink rejects ${key}: null on both backends`, () => {
			const opts = { [key]: null };
			expect(() => validateStreamSinkOptions(opts)).toThrow(
				/^E_SINK_BAD_OPTIONS: /,
			);
			expect(() =>
				openReadSinkOnNativeHandle(neverNative, opts as never),
			).toThrow(/^E_SINK_BAD_OPTIONS: /);
			expect(() => openWasmReadSink(neverWasm, opts as never)).toThrow(
				/^E_SINK_BAD_OPTIONS: /,
			);
		});
	}

	it("openReadSink rejects options: null", () => {
		expect(() => validateStreamSinkOptions(null)).toThrow(
			/^E_SINK_BAD_OPTIONS: options must be an object/,
		);
	});

	const SERVER_NULLS: [string, Record<string, unknown>, RegExp][] = [
		["egressPacer", { egressPacer: null }, /egressPacer must be an object/],
		["quicLb", { quicLb: null }, /quicLb must be an object/],
		["reusePort", { reusePort: null }, /reusePort must be a boolean/],
		[
			"reusePortSteering",
			{ reusePortSteering: null },
			/reusePortSteering must be an object/,
		],
		["limits", { limits: null }, /limits must be an object/],
		["rateLimits", { rateLimits: null }, /rateLimits must be an object/],
		[
			"limits.maxSessions",
			{ limits: { maxSessions: null } },
			/limits\.maxSessions must be a finite number/,
		],
		[
			"limits.keepAliveIntervalMs",
			{ limits: { keepAliveIntervalMs: null } },
			/limits\.keepAliveIntervalMs must be a finite number/,
		],
		[
			"limits.streamReceiveWindow",
			{ limits: { streamReceiveWindow: null } },
			/limits\.streamReceiveWindow must be/,
		],
		[
			"limits.receiveWindow",
			{ limits: { receiveWindow: null } },
			/limits\.receiveWindow must be/,
		],
		[
			"limits.sendWindow",
			{ limits: { sendWindow: null } },
			/limits\.sendWindow must be/,
		],
		[
			"rateLimits.handshakesPerSec",
			{ rateLimits: { handshakesPerSec: null } },
			/rateLimits\.handshakesPerSec must be a finite number/,
		],
		[
			"rateLimits.handshakesBurstPerPrefix",
			{ rateLimits: { handshakesBurstPerPrefix: null } },
			/rateLimits\.handshakesBurstPerPrefix must be a finite number/,
		],
	];
	for (const [label, extra, message] of SERVER_NULLS) {
		it(`createServer rejects ${label}: null with E_INVALID_ARGUMENT`, () => {
			let thrown: unknown;
			try {
				createServer({
					port: 0,
					tls: { certPem: "", keyPem: "" },
					onSession: () => {},
					...extra,
				} as never);
			} catch (error) {
				thrown = error;
			}
			expect((thrown as { code?: string })?.code).toBe(E_INVALID_ARGUMENT);
			expect(String((thrown as Error)?.message)).toMatch(message);
		});
	}

	for (const [label, limits] of [
		["limits", null],
		["limits.receiveWindow", { receiveWindow: null }],
		["limits.idleTimeoutMs", { idleTimeoutMs: null }],
	] as const) {
		it(`connect rejects ${label}: null with E_INVALID_ARGUMENT`, async () => {
			await expect(
				connect(`https://127.0.0.1:${nextPort(27_800, 60)}`, {
					tls: { insecureSkipVerify: true },
					limits: limits as never,
				}),
			).rejects.toThrow(/^E_INVALID_ARGUMENT: limits/);
		});
	}
});

describe("arrays and other non-plain objects are never option containers", () => {
	const NOT_PLAIN: [string, unknown][] = [
		["[]", []],
		["a Map", new Map()],
		["a Date", new Date(0)],
		["a function", () => {}],
	];

	for (const [label, value] of NOT_PLAIN) {
		it(`openReadSink rejects options and framing as ${label} on both backends`, () => {
			for (const opts of [value, { framing: value }]) {
				expect(() => validateStreamSinkOptions(opts)).toThrow(
					/^E_SINK_BAD_OPTIONS: (options|framing) must be an object/,
				);
				expect(() =>
					openReadSinkOnNativeHandle(neverNative, opts as never),
				).toThrow(/^E_SINK_BAD_OPTIONS: /);
				expect(() => openWasmReadSink(neverWasm, opts as never)).toThrow(
					/^E_SINK_BAD_OPTIONS: /,
				);
			}
		});

		for (const field of [
			"egressPacer",
			"quicLb",
			"reusePortSteering",
			"limits",
			"rateLimits",
		]) {
			it(`createServer rejects ${field} as ${label} with E_INVALID_ARGUMENT`, () => {
				let thrown: unknown;
				try {
					createServer({
						port: 0,
						tls: { certPem: "", keyPem: "" },
						onSession: () => {},
						[field]: value,
					} as never);
				} catch (error) {
					thrown = error;
				}
				expect((thrown as { code?: string })?.code).toBe(E_INVALID_ARGUMENT);
				expect(String((thrown as Error)?.message)).toMatch(
					new RegExp(`${field} must be an object`),
				);
			});
		}

		it(`connect rejects limits as ${label} with E_INVALID_ARGUMENT`, async () => {
			await expect(
				connect(`https://127.0.0.1:${nextPort(27_800, 60)}`, {
					tls: { insecureSkipVerify: true },
					limits: value as never,
				}),
			).rejects.toThrow(/^E_INVALID_ARGUMENT: limits must be an object/);
		});
	}

	it("a null-prototype object is still a valid container", () => {
		const opts = Object.assign(Object.create(null), { overflow: "block" });
		expect(() => validateStreamSinkOptions(opts)).not.toThrow();
	});
});
