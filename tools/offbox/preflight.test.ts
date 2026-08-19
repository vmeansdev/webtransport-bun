import { describe, expect, test } from "bun:test";
import {
	derivePpsCeiling,
	evaluatePreflight,
	guardPeerAddress,
	interfaceIsTunnelled,
	mtuFromDfPayload,
	parseIperf3Tcp,
	parseIperf3Udp,
	parsePingLoss,
	parsePingTimes,
	parseRouteInterface,
	percentile,
	PREFLIGHT_SCHEMA_VERSION,
	type PreflightArtifact,
	type UdpRung,
	summarizeRtt,
} from "./preflight-lib.ts";

describe("address guards", () => {
	test("accepts a peer on the registered cable subnet", () => {
		expect(guardPeerAddress("10.99.0.2")).toEqual({ ok: true });
	});

	test("refuses the Tailscale overlay by name, not by accident", () => {
		const verdict = guardPeerAddress("100.101.102.103");
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain("Tailscale");
	});

	test("refuses the house LAN, which is the Wi-Fi path that lost 64%", () => {
		const verdict = guardPeerAddress("192.168.2.35");
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain("LAN");
	});

	test("refuses an address that is merely not the cable subnet", () => {
		const verdict = guardPeerAddress("10.98.0.2");
		expect(verdict.ok).toBe(false);
		expect(verdict.ok === false && verdict.reason).toContain(
			"outside the registered",
		);
	});

	test("refuses non-addresses instead of treating them as a subnet miss", () => {
		expect(guardPeerAddress("runner.local").ok).toBe(false);
		expect(guardPeerAddress("10.99.0.999").ok).toBe(false);
		expect(guardPeerAddress("10.99.0").ok).toBe(false);
	});

	test("honours a different registered subnet", () => {
		expect(guardPeerAddress("10.42.0.2", "10.42.0.0/24")).toEqual({ ok: true });
		expect(guardPeerAddress("10.99.0.2", "10.42.0.0/24").ok).toBe(false);
	});
});

describe("route interface", () => {
	const routeOutput = [
		"   route to: 10.99.0.2",
		"destination: 10.99.0.2",
		"  interface: en7",
		"      flags: <UP,HOST,DONE,LLINFO,WASCLONED,IFSCOPE>",
	].join("\n");

	test("reads the interface the peer routes over", () => {
		expect(parseRouteInterface(routeOutput)).toBe("en7");
	});

	test("returns null when route said nothing useful", () => {
		expect(
			parseRouteInterface("route: writing to routing socket: not in table"),
		).toBeNull();
	});

	test("knows a tunnel from a wire", () => {
		expect(interfaceIsTunnelled("utun4")).toBe(true);
		expect(interfaceIsTunnelled("lo0")).toBe(true);
		expect(interfaceIsTunnelled("en7")).toBe(false);
		expect(interfaceIsTunnelled("bridge100")).toBe(false);
	});
});

describe("ping", () => {
	const pingOutput = [
		"PING 10.99.0.2 (10.99.0.2): 56 data bytes",
		"64 bytes from 10.99.0.2: icmp_seq=0 ttl=64 time=0.201 ms",
		"64 bytes from 10.99.0.2: icmp_seq=1 ttl=64 time=0.312 ms",
		"64 bytes from 10.99.0.2: icmp_seq=2 ttl=64 time=0.188 ms",
		"64 bytes from 10.99.0.2: icmp_seq=3 ttl=64 time=4.900 ms",
		"",
		"--- 10.99.0.2 ping statistics ---",
		"5 packets transmitted, 4 packets received, 20.0% packet loss",
		"round-trip min/avg/max/stddev = 0.188/1.400/4.900/2.014 ms",
	].join("\n");

	test("reads every per-packet sample, not the summary", () => {
		expect(parsePingTimes(pingOutput)).toEqual([0.201, 0.312, 0.188, 4.9]);
	});

	test("computes loss from the counts rather than trusting the percentage", () => {
		expect(parsePingLoss(pingOutput)).toEqual({
			transmitted: 5,
			received: 4,
			lossPct: 20,
		});
	});

	test("percentiles are nearest-rank, so every value reported was measured", () => {
		const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		expect(percentile(samples, 0.5)).toBe(5);
		expect(percentile(samples, 0.99)).toBe(10);
		expect(percentile(samples, 0.9)).toBe(9);
		expect(percentile([], 0.5)).toBeNull();
	});

	test("summary keeps the tail the average would hide", () => {
		const rtt = summarizeRtt(pingOutput);
		expect(rtt.samples).toBe(4);
		expect(rtt.p99Ms).toBe(4.9);
		expect(rtt.maxMs).toBe(4.9);
		expect(rtt.lossPct).toBe(20);
	});

	test("MTU adds the IPv4 and ICMP headers the DF payload did not count", () => {
		expect(mtuFromDfPayload(1472)).toBe(1500);
	});
});

describe("iperf3", () => {
	test("TCP prefers what the receiver saw over what the sender queued", () => {
		const parsed = parseIperf3Tcp({
			end: {
				sum_sent: { bits_per_second: 950e6, retransmits: 12, seconds: 10 },
				sum_received: { bits_per_second: 941e6, seconds: 10 },
			},
		});
		expect(parsed.bitsPerSec).toBe(941e6);
		expect(parsed.retransmits).toBe(12);
	});

	test("TCP falls back to the sender when the receiver summary is absent", () => {
		const parsed = parseIperf3Tcp({
			end: { sum_sent: { bits_per_second: 100e6, seconds: 10 } },
		});
		expect(parsed.bitsPerSec).toBe(100e6);
		expect(parsed.retransmits).toBeNull();
	});

	test("TCP refuses output it cannot read rather than reporting zero", () => {
		expect(() => parseIperf3Tcp({ end: {} })).toThrow();
	});

	test("UDP derives received from sent minus lost so the counts cannot disagree", () => {
		const rung = parseIperf3Udp(
			{
				start: { test_start: { blksize: 1150 } },
				end: {
					sum: {
						packets: 130000,
						lost_packets: 1300,
						lost_percent: 1,
						jitter_ms: 0.04,
						seconds: 10,
					},
				},
			},
			1150,
		);
		expect(rung.sentPackets).toBe(130000);
		expect(rung.receivedPackets).toBe(128700);
		expect(rung.deliveredPps).toBeCloseTo(12870, 5);
		expect(rung.offeredPps).toBeCloseTo(13000, 5);
		expect(rung.payloadBytes).toBe(1150);
	});

	test("UDP computes loss itself when iperf3 omits the percentage", () => {
		const rung = parseIperf3Udp(
			{ end: { sum: { packets: 1000, lost_packets: 250, seconds: 1 } } },
			1150,
		);
		expect(rung.lossPct).toBe(25);
	});
});

function rung(overrides: Partial<UdpRung>): UdpRung {
	return {
		offeredBitsPerSec: 0,
		payloadBytes: 1150,
		sentPackets: 0,
		receivedPackets: 1,
		lostPackets: 0,
		lossPct: 0,
		jitterMs: null,
		seconds: 1,
		deliveredPps: 0,
		offeredPps: 0,
		...overrides,
	};
}

describe("pps ceiling", () => {
	const rungs = [
		rung({ deliveredPps: 10000, offeredPps: 10000, lossPct: 0 }),
		rung({ deliveredPps: 50000, offeredPps: 50000, lossPct: 0.1 }),
		rung({ deliveredPps: 95000, offeredPps: 95000, lossPct: 0.4 }),
		rung({ deliveredPps: 101000, offeredPps: 110000, lossPct: 8.2 }),
	];

	test("the clean ceiling is the best rung under the bound, not the best rung", () => {
		const ceiling = derivePpsCeiling(rungs, 0.5);
		expect(ceiling.cleanPps).toBe(95000);
		expect(ceiling.cleanRungs).toBe(3);
	});

	test("peak delivered is recorded beside it and is never the licence", () => {
		const ceiling = derivePpsCeiling(rungs, 0.5);
		expect(ceiling.peakDeliveredPps).toBe(101000);
		expect(ceiling.peakDeliveredPps).toBeGreaterThan(ceiling.cleanPps ?? 0);
	});

	test("a sweep that never met the bound yields no ceiling at all", () => {
		const ceiling = derivePpsCeiling(
			[rung({ deliveredPps: 9, lossPct: 40 })],
			0.5,
		);
		expect(ceiling.cleanPps).toBeNull();
	});
});

const baselineRtt = {
	samples: 600,
	transmitted: 600,
	received: 600,
	lossPct: 0,
	p50Ms: 0.21,
	p99Ms: 0.44,
	maxMs: 1.1,
};

function artifact(
	overrides: Partial<PreflightArtifact> = {},
): PreflightArtifact {
	return {
		schemaVersion: PREFLIGHT_SCHEMA_VERSION,
		startedAt: "2026-08-20T09:00:00.000Z",
		generator: {
			hostname: "mac",
			platform: "darwin",
			arch: "arm64",
			cpus: 10,
			memoryBytes: 68719476736,
		},
		link: {
			localAddress: "10.99.0.1",
			peerAddress: "10.99.0.2",
			subnet: "10.99.0.0/24",
			interfaceName: "en7",
			mtuBytes: 1500,
			mtuProbePayloadBytes: 1472,
		},
		guards: [{ name: "peer-on-cable-subnet", ok: true, detail: "ok" }],
		rtt: baselineRtt,
		tcp: { bitsPerSec: 941e6, retransmits: 3, seconds: 10 },
		udpRungs: [
			rung({ deliveredPps: 60000, offeredPps: 60000, lossPct: 0.05 }),
			rung({ deliveredPps: 95000, offeredPps: 95000, lossPct: 0.3 }),
		],
		ceiling: null,
		registeredProperties: {
			mtuBytes: 1500,
			idleRttP50Ms: 0.21,
			idleRttP99Ms: 0.44,
			cleanPpsCeiling: 95000,
			lossBoundPct: 0.5,
			payloadBytes: 1150,
		},
		notes: [],
		...overrides,
	};
}

const requirement = {
	offeredPps: 15000,
	maxLossPct: 0.5,
	payloadBytes: 1150,
	runDateIso: "2026-08-20T14:00:00.000Z",
	minMtuBytes: 1500,
	maxIdleRttP99Ms: 2,
};

describe("the STOP rule", () => {
	test("a same-day pre-flight with headroom licenses the run", () => {
		const verdict = evaluatePreflight(artifact(), requirement);
		expect(verdict.reasons).toEqual([]);
		expect(verdict.valid).toBe(true);
		expect(verdict.observed.headroomRatio).toBeCloseTo(95000 / 15000, 6);
	});

	test("yesterday's pre-flight does not license today's run", () => {
		const verdict = evaluatePreflight(
			artifact({ startedAt: "2026-08-19T09:00:00.000Z" }),
			requirement,
		);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("same-day");
	});

	test("a link that cannot carry the offered rate cleanly is refused", () => {
		const verdict = evaluatePreflight(artifact(), {
			...requirement,
			offeredPps: 120000,
		});
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("gate offers 120000 pps");
	});

	test("a rung that delivered a lot while losing a lot is not a ceiling", () => {
		const verdict = evaluatePreflight(
			artifact({
				udpRungs: [
					rung({ deliveredPps: 101000, offeredPps: 110000, lossPct: 8.2 }),
				],
			}),
			requirement,
		);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("stayed under 0.5% loss");
	});

	test("a pre-flight at another payload size does not speak for this gate", () => {
		const verdict = evaluatePreflight(
			artifact({
				udpRungs: [
					rung({
						payloadBytes: 1400,
						deliveredPps: 95000,
						offeredPps: 95000,
						lossPct: 0.1,
					}),
				],
			}),
			requirement,
		);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("gate offers 1150 B");
	});

	test("a failed guard invalidates the run even when the numbers look fine", () => {
		const verdict = evaluatePreflight(
			artifact({
				guards: [
					{
						name: "peer-routes-over-wire",
						ok: false,
						detail: "interface utun4 is a tunnel",
					},
				],
			}),
			requirement,
		);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("utun4");
	});

	test("a short MTU is refused against a gate that registered one", () => {
		const verdict = evaluatePreflight(
			artifact({ link: { ...artifact().link, mtuBytes: 1400 } }),
			requirement,
		);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("below the registered");
	});

	test("a noisy idle path cannot carry a latency gate", () => {
		const verdict = evaluatePreflight(
			artifact({ rtt: { ...baselineRtt, p99Ms: 9.4 } }),
			requirement,
		);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("idle RTT p99");
	});

	test("every failing clause is reported, not just the first", () => {
		const verdict = evaluatePreflight(
			artifact({ startedAt: "2026-08-01T09:00:00.000Z", udpRungs: [] }),
			requirement,
		);
		expect(verdict.reasons.length).toBeGreaterThanOrEqual(2);
	});

	test("an artifact from a future schema is not silently accepted", () => {
		const verdict = evaluatePreflight(
			artifact({ schemaVersion: 99 }),
			requirement,
		);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("schema 99");
	});
});
