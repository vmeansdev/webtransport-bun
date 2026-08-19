import { describe, expect, test } from "bun:test";
import {
	gsoAmortization,
	parseUdpSnapshot,
	type UdpSnapshot,
	udpDelta,
} from "./egress-socket.ts";

/** A real `/proc/net/snmp` head, trimmed to the tables around `Udp:`. */
const SNMP = `Ip: Forwarding DefaultTTL InReceives
Ip: 2 64 123456
Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti MemErrors
Udp: 1000 3 7 2000 11 13 0 0 0
UdpLite: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors
UdpLite: 0 0 0 0 0 0
`;

describe("parseUdpSnapshot", () => {
	test("reads counters by column name", () => {
		expect(parseUdpSnapshot(SNMP)).toEqual({
			inDatagrams: 1000,
			inErrors: 7,
			rcvbufErrors: 11,
			sndbufErrors: 13,
			outDatagrams: 2000,
		});
	});

	test("is not fooled by column order", () => {
		const reordered = `Udp: OutDatagrams RcvbufErrors InDatagrams InErrors SndbufErrors
Udp: 2000 11 1000 7 13
`;
		expect(parseUdpSnapshot(reordered)?.inDatagrams).toBe(1000);
		expect(parseUdpSnapshot(reordered)?.rcvbufErrors).toBe(11);
	});

	test("returns null when the table is absent or truncated", () => {
		expect(parseUdpSnapshot("Ip: Forwarding\nIp: 2\n")).toBeNull();
		expect(parseUdpSnapshot("Udp: InDatagrams OutDatagrams\n")).toBeNull();
	});

	test("missing columns read as zero rather than NaN", () => {
		const partial = "Udp: InDatagrams OutDatagrams\nUdp: 5 9\n";
		expect(parseUdpSnapshot(partial)).toEqual({
			inDatagrams: 5,
			inErrors: 0,
			rcvbufErrors: 0,
			sndbufErrors: 0,
			outDatagrams: 9,
		});
	});
});

describe("udpDelta", () => {
	const before: UdpSnapshot = {
		inDatagrams: 1000,
		inErrors: 7,
		rcvbufErrors: 11,
		sndbufErrors: 13,
		outDatagrams: 2000,
	};

	test("differences every counter", () => {
		const after: UdpSnapshot = {
			inDatagrams: 1500,
			inErrors: 9,
			rcvbufErrors: 11,
			sndbufErrors: 20,
			outDatagrams: 42_000,
		};
		expect(udpDelta(before, after)).toEqual({
			inDatagrams: 500,
			inErrors: 2,
			rcvbufErrors: 0,
			sndbufErrors: 7,
			outDatagrams: 40_000,
		});
	});

	test("null when either end is missing — the off-Linux case", () => {
		expect(udpDelta(null, before)).toBeNull();
		expect(udpDelta(before, null)).toBeNull();
	});
});

describe("gsoAmortization", () => {
	test("a syscall per datagram reads as 1", () => {
		const delta = udpDelta(
			{
				inDatagrams: 0,
				inErrors: 0,
				rcvbufErrors: 0,
				sndbufErrors: 0,
				outDatagrams: 0,
			},
			{
				inDatagrams: 0,
				inErrors: 0,
				rcvbufErrors: 0,
				sndbufErrors: 0,
				outDatagrams: 16_500,
			},
		);
		expect(gsoAmortization(16_500, delta)).toBe(1);
	});

	test("segmented sends read above 1", () => {
		const delta: UdpSnapshot = {
			inDatagrams: 0,
			inErrors: 0,
			rcvbufErrors: 0,
			sndbufErrors: 0,
			outDatagrams: 1000,
		};
		expect(gsoAmortization(64_000, delta)).toBe(64);
	});

	test("no denominator, no ratio", () => {
		expect(gsoAmortization(1000, null)).toBeNull();
		expect(
			gsoAmortization(1000, {
				inDatagrams: 0,
				inErrors: 0,
				rcvbufErrors: 0,
				sndbufErrors: 0,
				outDatagrams: 0,
			}),
		).toBeNull();
		expect(
			gsoAmortization(0, {
				inDatagrams: 0,
				inErrors: 0,
				rcvbufErrors: 0,
				sndbufErrors: 0,
				outDatagrams: 10,
			}),
		).toBeNull();
	});
});
