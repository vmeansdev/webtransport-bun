/**
 * Public methods that forward caller numbers into `u32` N-API parameters must
 * normalize them first, so no `number` reaches the binding's conversion and
 * fails with a generic error instead of the documented behavior.
 */

import { describe, expect, it } from "bun:test";
import {
	MIRROR_REPORTS_RING_CAP,
	normalizeMirrorReportsMax,
} from "../src/datagram-mirror.js";
import { createServer } from "../src/index.js";
import {
	openReadSinkOnNativeHandle,
	type SinkCapableNativeHandle,
} from "../src/sink.js";
import { nextPort } from "./helpers/network.js";

const AWKWARD = [
	-1,
	0,
	-0,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	1.5,
	0.5,
	2 ** 40,
	Number.MAX_VALUE,
];

describe("readMirrorReports(max)", () => {
	it("normalizes every number into what a u32 can carry, or reads nothing", () => {
		expect(normalizeMirrorReportsMax(undefined)).toBeUndefined();
		expect(normalizeMirrorReportsMax(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(normalizeMirrorReportsMax(-1)).toBe(0);
		expect(normalizeMirrorReportsMax(0)).toBe(0);
		expect(normalizeMirrorReportsMax(Number.NaN)).toBe(0);
		expect(normalizeMirrorReportsMax(Number.NEGATIVE_INFINITY)).toBe(0);
		expect(normalizeMirrorReportsMax(0.5)).toBe(0);
		expect(normalizeMirrorReportsMax(1.5)).toBe(1);
		expect(normalizeMirrorReportsMax(7)).toBe(7);
		expect(normalizeMirrorReportsMax(2 ** 40)).toBe(MIRROR_REPORTS_RING_CAP);
		expect(normalizeMirrorReportsMax("3")).toBe(0);
	});

	it("never throws on a live server, whatever number it is handed", async () => {
		const server = createServer({
			port: nextPort(27_700, 60),
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			for (const max of [...AWKWARD, undefined]) {
				expect(() => server.readMirrorReports(max)).not.toThrow();
				expect(server.readMirrorReports(max)).toEqual([]);
			}
			expect(server.readMirrorReports("8" as never)).toEqual([]);
		} finally {
			await server.close();
		}
	});
});

describe("openReadSink framing numbers", () => {
	const neverCalled = new Proxy({} as SinkCapableNativeHandle, {
		get: () => () => {
			throw new Error("the native handle must not be reached");
		},
	});

	for (const key of [
		"headerBytes",
		"lengthOffset",
		"lengthWidth",
		"maxFrameBytes",
	] as const) {
		it(`rejects a framing.${key} a u32 cannot carry with E_SINK_BAD_OPTIONS`, () => {
			for (const bad of [
				-1,
				1.5,
				Number.NaN,
				2 ** 40,
				Number.POSITIVE_INFINITY,
			]) {
				const framing = {
					headerBytes: 4,
					lengthOffset: 0,
					lengthWidth: 4,
					maxFrameBytes: 1024,
					[key]: bad,
				};
				expect(() =>
					openReadSinkOnNativeHandle(neverCalled, { framing } as never),
				).toThrow(/^E_SINK_BAD_OPTIONS: framing\./);
			}
		});
	}
});
