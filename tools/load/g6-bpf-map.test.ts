import { describe, expect, test } from "bun:test";
import {
	countBpfMapEntries,
	parseSlotByServerId,
	sumPerCpuSlotPackets,
	sumPerCpuSteerStats,
} from "./g6-bpf-map.ts";

const le = (value: number): string[] => [
	`0x${(value & 0xff).toString(16).padStart(2, "0")}`,
	`0x${((value >>> 8) & 0xff).toString(16).padStart(2, "0")}`,
	"0x00",
	"0x00",
];

const u64le = (value: number): string[] => {
	const bytes: string[] = [];
	let rest = value;
	for (let i = 0; i < 8; i += 1) {
		bytes.push(`0x${(rest % 256).toString(16).padStart(2, "0")}`);
		rest = Math.floor(rest / 256);
	}
	return bytes;
};

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

	test("sums the per-cpu slot_packets struct in the formatted projection", () => {
		const raw = JSON.stringify([
			{
				formatted: {
					key: 0,
					values: [
						{ value: { short_header: 10, long_header: 2 } },
						{ value: { short_header: 5, long_header: 1 } },
					],
				},
			},
			{
				formatted: {
					key: 1,
					values: [{ value: { short_header: 7, long_header: 3 } }],
				},
			},
		]);

		expect(sumPerCpuSlotPackets(raw)).toEqual({
			0: { shortHeader: 15, longHeader: 3 },
			1: { shortHeader: 7, longHeader: 3 },
		});
	}, 15_000);

	test("sums slot_packets from raw little-endian octets when BTF is absent", () => {
		const raw = JSON.stringify([
			{
				key: le(0),
				values: [
					{ value: [...u64le(4), ...u64le(1)] },
					{ value: [...u64le(6), ...u64le(2)] },
				],
			},
		]);

		expect(sumPerCpuSlotPackets(raw)).toEqual({
			0: { shortHeader: 10, longHeader: 3 },
		});
	}, 15_000);

	test("refuses malformed slot_packets shapes", () => {
		expect(sumPerCpuSlotPackets("not json")).toBe(null);
		expect(sumPerCpuSlotPackets(JSON.stringify([{ key: 0 }]))).toBe(null);
		expect(
			sumPerCpuSlotPackets(
				JSON.stringify([{ key: 0, values: [{ value: { short_header: 1 } }] }]),
			),
		).toBe(null);
		expect(
			sumPerCpuSlotPackets(
				JSON.stringify([{ key: 0, values: [{ value: le(1) }] }]),
			),
		).toBe(null);
	}, 15_000);

	test("maps sockarray slots back to server ids", () => {
		const raw = JSON.stringify([
			{
				key: ["0x00", "0x01", "0x00", "0x00", "0x00", "0x00", "0x00", "0x00"],
				value: le(0),
			},
			{
				key: ["0x00", "0x02", "0x00", "0x00", "0x00", "0x00", "0x00", "0x00"],
				value: le(1),
			},
		]);

		expect(parseSlotByServerId(raw)).toEqual({ 0: 1, 1: 2 });
	}, 15_000);

	test("refuses slot_by_server_id dumps it cannot decode", () => {
		expect(parseSlotByServerId("not json")).toBe(null);
		expect(
			parseSlotByServerId(JSON.stringify([{ key: le(1), value: le(0) }])),
		).toBe(null);
		expect(
			parseSlotByServerId(
				JSON.stringify([
					{
						key: [
							"0x00",
							"0x01",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
						],
						value: le(0),
					},
					{
						key: [
							"0x00",
							"0x02",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
							"0x00",
						],
						value: le(0),
					},
				]),
			),
		).toBe(null);
	}, 15_000);
});
