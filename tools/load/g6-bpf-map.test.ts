import { describe, expect, test } from "bun:test";
import { countBpfMapEntries, sumPerCpuSteerStats } from "./g6-bpf-map.ts";

const le = (value: number): string[] => [
	`0x${(value & 0xff).toString(16).padStart(2, "0")}`,
	`0x${((value >>> 8) & 0xff).toString(16).padStart(2, "0")}`,
	"0x00",
	"0x00",
];

describe("G6 BPF map JSON decoding", () => {
	test("accepts the numeric formatted bpftool JSON projection", () => {
		const steer = JSON.stringify([
			{ formatted: { key: 0, values: [{ value: 3 }, { value: 4 }] } },
			{ formatted: { key: 1, values: [{ value: 2 }, { value: 1 }] } },
		]);
		const socks = JSON.stringify([
			{ formatted: { key: 0, value: 4097 } },
			{ key: le(1), value: { error: "No such file or directory" } },
		]);

		expect(sumPerCpuSteerStats(steer)).toEqual({ steered: 7, fallback: 3 });
		expect(countBpfMapEntries(socks)).toBe(1);
	}, 15_000);

	test("accepts raw little-endian hex arrays when BTF formatting is absent", () => {
		const steer = JSON.stringify([
			{ key: le(0), values: [{ value: le(3) }, { value: le(4) }] },
			{ key: le(1), values: [{ value: le(2) }, { value: le(1) }] },
		]);
		const socks = JSON.stringify([
			{ key: le(0), value: le(4097) },
			{ key: le(1), value: { error: "No such file or directory" } },
		]);

		expect(sumPerCpuSteerStats(steer)).toEqual({ steered: 7, fallback: 3 });
		expect(countBpfMapEntries(socks)).toBe(1);
	}, 15_000);

	test("refuses malformed or unknown BPF JSON shapes", () => {
		expect(sumPerCpuSteerStats(JSON.stringify([{ key: 0, values: [] }]))).toBe(
			null,
		);
		expect(
			countBpfMapEntries(JSON.stringify([{ key: le(0), value: "4097" }])),
		).toBe(null);
	}, 15_000);
});
