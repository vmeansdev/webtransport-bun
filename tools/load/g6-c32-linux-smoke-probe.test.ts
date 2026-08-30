import { describe, expect, test } from "bun:test";
import {
	buildSteeringDatagram,
	fixedSourcePortReceipt,
	validateProbeStateRoot,
} from "./g6-c32-linux-smoke-probe.ts";

describe("G6 c32 production Linux smoke probe", () => {
	test("builds the exact short-header QUIC-LB route for one of 16 shards", () => {
		const packet = buildSteeringDatagram(16);
		expect([...packet]).toEqual([
			0x40, 0x00, 0x00, 0x10, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		]);
		expect(() => buildSteeringDatagram(0)).toThrow(/server ID must be 1\.\.16/);
		expect(() => buildSteeringDatagram(17)).toThrow(
			/server ID must be 1\.\.16/,
		);
	});

	test("emits timestamped fixed-port evidence only for the full distinct range", () => {
		expect(
			fixedSourcePortReceipt(
				"2026-08-30T12:00:00.000Z",
				45_000,
				512,
				new Set(Array.from({ length: 512 }, (_, index) => 45_000 + index)),
			),
		).toEqual({
			schema: "g6-fixed-source-port-smoke/1",
			recordedAt: "2026-08-30T12:00:00.000Z",
			base: 45_000,
			count: 512,
			distinct: 512,
			withinRange: true,
			passed: true,
		});
		expect(() =>
			fixedSourcePortReceipt(
				"2026-08-30T12:00:00.000Z",
				45_000,
				512,
				new Set([45_000]),
			),
		).toThrow(/did not bind every fixed source port/);
	});

	test("accepts only an absolute normalized non-root state directory", () => {
		expect(validateProbeStateRoot("/opt/g6/run/example-probe-state")).toBe(
			"/opt/g6/run/example-probe-state",
		);
		expect(() => validateProbeStateRoot("relative/state")).toThrow(/absolute/);
		expect(() => validateProbeStateRoot("/")).toThrow(/root directory/);
		expect(() => validateProbeStateRoot("/opt/g6/../escape")).toThrow(
			/normalized/,
		);
	});
});
