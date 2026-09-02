import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

process.env.G6_C32_SHARDS = "24";
const {
	buildSteeringDatagram,
	fixedSourcePortReceipt,
	makeProbeOperation,
	validateProbeStateRoot,
} = await import("./g6-c32-linux-smoke-probe.ts");

const PROBE_PATH = join(import.meta.dir, "g6-c32-linux-smoke-probe.ts");

describe("G6 c32 production Linux smoke probe", () => {
	test("builds the exact short-header QUIC-LB route for the configured shard count", () => {
		const packet = buildSteeringDatagram(24);
		expect([...packet]).toEqual([
			0x40, 0x00, 0x00, 0x18, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
		]);
		expect(() => buildSteeringDatagram(0)).toThrow(/server ID must be 1\.\.24/);
		expect(() => buildSteeringDatagram(25)).toThrow(
			/server ID must be 1\.\.24/,
		);
	}, 15_000);

	test("refuses to load without a positive integer G6_C32_SHARDS", () => {
		const { G6_C32_SHARDS: _absent, ...withoutShards } = process.env;
		for (const [label, environment] of [
			["missing", withoutShards],
			["blank", { ...withoutShards, G6_C32_SHARDS: "" }],
			["zero", { ...withoutShards, G6_C32_SHARDS: "0" }],
			["fractional", { ...withoutShards, G6_C32_SHARDS: "16.5" }],
			["not a number", { ...withoutShards, G6_C32_SHARDS: "sixteen" }],
		] as const) {
			const result = spawnSync(process.execPath, [PROBE_PATH, "--help"], {
				encoding: "utf8",
				env: environment as NodeJS.ProcessEnv,
			});
			expect({ label, code: result.status }).toEqual({ label, code: 1 });
			expect(result.stderr).toContain(
				"G6_C32_SHARDS must be a positive integer",
			);
		}
	}, 15_000);

	test("loads with a valid G6_C32_SHARDS", () => {
		const result = spawnSync(process.execPath, [PROBE_PATH, "--help"], {
			encoding: "utf8",
			env: { ...process.env, G6_C32_SHARDS: "32" },
		});
		expect({ code: result.status, stderr: result.stderr }).toEqual({
			code: 0,
			stderr: "",
		});
		expect(result.stdout).toContain("usage: bun");
	}, 15_000);

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
	}, 15_000);

	test("accepts only an absolute normalized non-root state directory", () => {
		expect(validateProbeStateRoot("/opt/g6/run/example-probe-state")).toBe(
			"/opt/g6/run/example-probe-state",
		);
		expect(() => validateProbeStateRoot("relative/state")).toThrow(/absolute/);
		expect(() => validateProbeStateRoot("/")).toThrow(/root directory/);
		expect(() => validateProbeStateRoot("/opt/g6/../escape")).toThrow(
			/normalized/,
		);
	}, 15_000);

	test("records every probe operation with wall bounds and monotonic duration", () => {
		expect(
			makeProbeOperation({
				operationId: "fixture-operation",
				startedAt: "2026-08-30T12:00:00.000Z",
				finishedAt: "2026-08-30T12:00:00.001Z",
				startedMonotonicNs: 100n,
				finishedMonotonicNs: 125n,
				outcome: "SUCCEEDED",
				error: null,
			}),
		).toEqual({
			schema: "g6-c32-smoke-probe-operation/1",
			recordedAt: "2026-08-30T12:00:00.001Z",
			operationId: "fixture-operation",
			startedAt: "2026-08-30T12:00:00.000Z",
			finishedAt: "2026-08-30T12:00:00.001Z",
			durationMonotonicNs: "25",
			outcome: "SUCCEEDED",
			error: null,
		});
		expect(() =>
			makeProbeOperation({
				operationId: "backwards-operation",
				startedAt: "2026-08-30T12:00:00.001Z",
				finishedAt: "2026-08-30T12:00:00.000Z",
				startedMonotonicNs: 125n,
				finishedMonotonicNs: 100n,
				outcome: "FAILED",
				error: "backwards",
			}),
		).toThrow(/backwards/);
	}, 15_000);
});
