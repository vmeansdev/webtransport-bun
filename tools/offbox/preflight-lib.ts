/**
 * Pure half of the cable pre-flight: guards, output parsers, derivations and the
 * STOP rule a gate cites when it says a run over this link is valid.
 *
 * Everything here is a function of text or numbers, so the whole pre-flight can
 * be tested — and argued with — on a machine with no cable attached. The half
 * that shells out to `ping`/`iperf3`/`route` lives in `preflight.ts` and does
 * nothing but feed these.
 *
 * The link is a *registered property* of a gate run, not background scenery. A
 * gate over this path is only valid if a same-day pre-flight shows the path
 * carrying the gate's offered rate under a loss bound written down before the
 * run. `evaluatePreflight` is that rule; it is deliberately unable to see the
 * gate's own results.
 */

export const PREFLIGHT_SCHEMA_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Address guards                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The cable subnet. Dedicated, and nothing else on this machine routes through
 * it, so a measurement over it cannot be quietly carried by another path.
 */
export const DEFAULT_CABLE_SUBNET = "10.99.0.0/24";

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

function parseIpv4(text: string): number[] | null {
	const parts = text.trim().split(".");
	if (parts.length !== 4) return null;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const value = Number(part);
		if (value > 255) return null;
		octets.push(value);
	}
	return octets;
}

function inCidr(octets: number[], cidr: string): boolean {
	const [base, bitsText] = cidr.split("/");
	const baseOctets = base ? parseIpv4(base) : null;
	const bits = Number(bitsText);
	if (!baseOctets || !Number.isInteger(bits) || bits < 0 || bits > 32) {
		throw new Error(`preflight: malformed CIDR ${cidr}`);
	}
	const toInt = (o: number[]) =>
		((o[0] ?? 0) * 2 ** 24 +
			(o[1] ?? 0) * 2 ** 16 +
			(o[2] ?? 0) * 256 +
			(o[3] ?? 0)) >>>
		0;
	// A /0 mask shifts by 32, which JavaScript wraps to a no-op shift. Special-case it.
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (toInt(octets) & mask) >>> 0 === (toInt(baseOctets) & mask) >>> 0;
}

/**
 * Refuse to pre-flight anything but the cable subnet.
 *
 * Two addresses in this house have already produced numbers that looked like
 * results and were not: the 192.168.2.0/24 LAN (Wi-Fi, 64% loss) and the
 * 100.64.0.0/10 Tailscale overlay (3.3k pps). Both are reachable from this Mac
 * by name, and both would answer a pre-flight happily. Naming them explicitly
 * costs nothing and turns the worst failure mode — a pre-flight that passes over
 * the wrong path and licenses a gate — into a refusal.
 */
export function guardPeerAddress(
	peer: string,
	subnet: string = DEFAULT_CABLE_SUBNET,
): GuardVerdict {
	const octets = parseIpv4(peer);
	if (!octets)
		return { ok: false, reason: `peer ${peer} is not an IPv4 address` };
	if (inCidr(octets, "100.64.0.0/10")) {
		return {
			ok: false,
			reason: `peer ${peer} is a Tailscale CGNAT address — the overlay is a falsified generator path (3.3k pps)`,
		};
	}
	if (inCidr(octets, "192.168.2.0/24")) {
		return {
			ok: false,
			reason: `peer ${peer} is on the house LAN — the Wi-Fi path is a falsified generator path (64% loss)`,
		};
	}
	if (!inCidr(octets, subnet)) {
		return {
			ok: false,
			reason: `peer ${peer} is outside the registered cable subnet ${subnet}`,
		};
	}
	return { ok: true };
}

/**
 * The interface the peer actually routes over, from `route -n get <peer>`.
 * A cable pre-flight that comes back over `utun*` (Tailscale) or the Wi-Fi
 * interface is measuring the wrong wire; the caller turns that into a refusal.
 */
export function parseRouteInterface(routeGetOutput: string): string | null {
	const match = routeGetOutput.match(/^\s*interface:\s*(\S+)\s*$/m);
	return match?.[1] ?? null;
}

/** Interface-name prefixes that are never the cable. */
export function interfaceIsTunnelled(iface: string): boolean {
	return /^(utun|ipsec|gif|stf|awdl|llw|lo)\d*$/.test(iface);
}

/* -------------------------------------------------------------------------- */
/* ping                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Per-packet RTTs in milliseconds, in arrival order.
 *
 * The summary line `ping` prints at the end carries min/avg/max/stddev, and a
 * tail is exactly what those hide: a path with a 0.3 ms average and a 40 ms
 * ninety-ninth percentile prints the same average as a clean one. So the samples
 * are parsed individually and the percentiles computed here.
 */
export function parsePingTimes(pingOutput: string): number[] {
	const times: number[] = [];
	for (const line of pingOutput.split("\n")) {
		const match = line.match(/time[=<]([\d.]+)\s*ms/);
		if (match?.[1]) times.push(Number(match[1]));
	}
	return times;
}

/** Transmitted/received counts from ping's summary line. */
export function parsePingLoss(
	pingOutput: string,
): { transmitted: number; received: number; lossPct: number } | null {
	const match = pingOutput.match(
		/(\d+) packets transmitted, (\d+) packets received/,
	);
	if (!match?.[1] || !match[2]) return null;
	const transmitted = Number(match[1]);
	const received = Number(match[2]);
	return {
		transmitted,
		received,
		lossPct:
			transmitted === 0 ? 0 : ((transmitted - received) / transmitted) * 100,
	};
}

/**
 * Nearest-rank percentile. `p` is a fraction: 0.5 is the median, 0.99 the
 * ninety-ninth. Nearest-rank never interpolates between two samples, so every
 * number reported is a measurement that actually happened.
 */
export function percentile(samples: number[], p: number): number | null {
	if (samples.length === 0) return null;
	const sorted = [...samples].sort((a, b) => a - b);
	const rank = Math.ceil(p * sorted.length);
	return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1] ?? null;
}

export type RttBaseline = {
	samples: number;
	transmitted: number;
	received: number;
	lossPct: number | null;
	p50Ms: number | null;
	p99Ms: number | null;
	maxMs: number | null;
};

export function summarizeRtt(pingOutput: string): RttBaseline {
	const times = parsePingTimes(pingOutput);
	const loss = parsePingLoss(pingOutput);
	return {
		samples: times.length,
		transmitted: loss?.transmitted ?? times.length,
		received: loss?.received ?? times.length,
		lossPct: loss?.lossPct ?? null,
		p50Ms: percentile(times, 0.5),
		p99Ms: percentile(times, 0.99),
		maxMs: times.length > 0 ? Math.max(...times) : null,
	};
}

/**
 * IP MTU implied by the largest ICMP payload that crossed with DF set.
 * ICMP echo carries 8 bytes of header on top of a 20-byte IPv4 header.
 */
export function mtuFromDfPayload(payloadBytes: number): number {
	return payloadBytes + 28;
}

/** True when a DF-set ping was rejected for being too big rather than lost. */
export function pingSaysTooBig(pingOutput: string): boolean {
	return (
		/message too long/i.test(pingOutput) ||
		/frag needed/i.test(pingOutput) ||
		/Message too long/.test(pingOutput)
	);
}

/* -------------------------------------------------------------------------- */
/* iperf3                                                                     */
/* -------------------------------------------------------------------------- */

export type IperfTcpResult = {
	bitsPerSec: number;
	retransmits: number | null;
	seconds: number;
};

export function parseIperf3Tcp(json: unknown): IperfTcpResult {
	const end = (json as { end?: Record<string, unknown> })?.end;
	const sent = end?.sum_sent as
		| { bits_per_second?: number; retransmits?: number; seconds?: number }
		| undefined;
	const received = end?.sum_received as
		| { bits_per_second?: number; seconds?: number }
		| undefined;
	if (!sent && !received)
		throw new Error("iperf3 TCP output has no end.sum_sent/sum_received");
	// Received is the honest one: it is what crossed, not what was handed to the
	// kernel. Sent stands in only if the receiver's summary is missing.
	const bitsPerSec = received?.bits_per_second ?? sent?.bits_per_second ?? 0;
	return {
		bitsPerSec,
		retransmits:
			typeof sent?.retransmits === "number" ? sent.retransmits : null,
		seconds: received?.seconds ?? sent?.seconds ?? 0,
	};
}

export type UdpRung = {
	/** What `-b` asked for, in bits/s. The rung's label is the delivered rate. */
	offeredBitsPerSec: number;
	payloadBytes: number;
	/** Datagrams the sender handed to the kernel. */
	sentPackets: number;
	/** Datagrams the receiver saw. */
	receivedPackets: number;
	lostPackets: number;
	lossPct: number;
	jitterMs: number | null;
	seconds: number;
	/** Delivered packets per second — the currency the gates are provisioned in. */
	deliveredPps: number;
	offeredPps: number;
};

/**
 * One UDP rung out of iperf3's JSON.
 *
 * iperf3 reports the receiver's view under `end.sum` for UDP (and, on newer
 * builds, splits it into `sum_sent`/`sum_received`). Both shapes are handled:
 * the sender-side count comes from whichever is present, and packets *received*
 * is always sent minus lost so the two numbers cannot disagree with each other.
 */
export function parseIperf3Udp(json: unknown, payloadBytes: number): UdpRung {
	const root = json as {
		start?: { test_start?: { bytes?: number; blksize?: number } };
		end?: Record<string, unknown>;
	};
	const end = root?.end;
	const sum = (end?.sum ?? end?.sum_received ?? end?.sum_sent) as
		| {
				packets?: number;
				lost_packets?: number;
				lost_percent?: number;
				jitter_ms?: number;
				seconds?: number;
				bits_per_second?: number;
		  }
		| undefined;
	if (!sum) throw new Error("iperf3 UDP output has no end.sum");
	const sentPackets = sum.packets ?? 0;
	const lostPackets = sum.lost_packets ?? 0;
	const seconds = sum.seconds ?? 0;
	const receivedPackets = Math.max(sentPackets - lostPackets, 0);
	const lossPct =
		typeof sum.lost_percent === "number"
			? sum.lost_percent
			: sentPackets > 0
				? (lostPackets / sentPackets) * 100
				: 0;
	const blk = root?.start?.test_start?.blksize ?? payloadBytes;
	return {
		offeredBitsPerSec: 0,
		payloadBytes: blk,
		sentPackets,
		receivedPackets,
		lostPackets,
		lossPct,
		jitterMs: typeof sum.jitter_ms === "number" ? sum.jitter_ms : null,
		seconds,
		deliveredPps: seconds > 0 ? receivedPackets / seconds : 0,
		offeredPps: seconds > 0 ? sentPackets / seconds : 0,
	};
}

/* -------------------------------------------------------------------------- */
/* Derivations                                                                */
/* -------------------------------------------------------------------------- */

export type PpsCeiling = {
	/** Highest delivered pps on any rung whose loss stayed under the bound. */
	cleanPps: number | null;
	/** The rung's offered pps, so the sender's own shortfall stays visible. */
	cleanOfferedPps: number | null;
	/** Highest delivered pps observed at all, loss included. Never a licence. */
	peakDeliveredPps: number | null;
	lossBoundPct: number;
	/** Rungs that met the bound, lowest first. */
	cleanRungs: number;
};

/**
 * The link's pps ceiling under a loss bound.
 *
 * "Clean" is the number a gate may provision against; "peak delivered" is
 * recorded beside it because a path that delivers more while dropping 20% is a
 * fact about the path, not a capacity. A rung whose *offered* rate fell well
 * short of what was asked for is a generator-side shortfall, so it is kept as a
 * clean rung only if it also delivered what it offered — otherwise the ceiling
 * would be read off a rung the sender never reached.
 */
export function derivePpsCeiling(
	rungs: UdpRung[],
	lossBoundPct: number,
): PpsCeiling {
	const clean = rungs.filter(
		(r) => r.lossPct <= lossBoundPct && r.receivedPackets > 0,
	);
	const best = clean.reduce<UdpRung | null>(
		(acc, r) => (acc === null || r.deliveredPps > acc.deliveredPps ? r : acc),
		null,
	);
	const peak = rungs.reduce<number | null>(
		(acc, r) => (acc === null || r.deliveredPps > acc ? r.deliveredPps : acc),
		null,
	);
	return {
		cleanPps: best?.deliveredPps ?? null,
		cleanOfferedPps: best?.offeredPps ?? null,
		peakDeliveredPps: peak,
		lossBoundPct,
		cleanRungs: clean.length,
	};
}

/* -------------------------------------------------------------------------- */
/* The artifact                                                               */
/* -------------------------------------------------------------------------- */

export type PreflightArtifact = {
	schemaVersion: number;
	/** ISO instant the pre-flight started. The same-day rule reads this. */
	startedAt: string;
	generator: {
		hostname: string;
		platform: string;
		arch: string;
		cpus: number | null;
		memoryBytes: number | null;
	};
	link: {
		localAddress: string;
		peerAddress: string;
		subnet: string;
		/** Interface the peer routes over, per `route -n get`. */
		interfaceName: string | null;
		/** IP MTU implied by the largest DF ping that crossed. */
		mtuBytes: number | null;
		mtuProbePayloadBytes: number | null;
	};
	guards: { name: string; ok: boolean; detail: string }[];
	rtt: RttBaseline | null;
	tcp: IperfTcpResult | null;
	udpRungs: UdpRung[];
	ceiling: PpsCeiling | null;
	/**
	 * What a gate pre-registration cites. Everything a gate needs to say "this
	 * link, on this day, carried this much" without re-reading the raw rungs.
	 */
	registeredProperties: {
		mtuBytes: number | null;
		idleRttP50Ms: number | null;
		idleRttP99Ms: number | null;
		cleanPpsCeiling: number | null;
		lossBoundPct: number;
		payloadBytes: number;
	};
	/** Non-fatal notes: refusals, missing tools, skipped phases. */
	notes: string[];
};

/* -------------------------------------------------------------------------- */
/* The STOP rule                                                              */
/* -------------------------------------------------------------------------- */

export type PreflightRequirement = {
	/** The gate's aggregate offered rate, in datagrams/s. */
	offeredPps: number;
	/** Loss the path may show at that rate and still license a run. */
	maxLossPct: number;
	/** Payload the gate offers; a pre-flight at another size does not speak for it. */
	payloadBytes: number;
	/** The gate run's own date, ISO. The pre-flight must be from the same day. */
	runDateIso: string;
	/** Minimum MTU the path must carry, if the gate registered one. */
	minMtuBytes?: number;
	/** Idle RTT p99 above which the path is too noisy to gate latency on. */
	maxIdleRttP99Ms?: number;
};

export type PreflightVerdict = {
	valid: boolean;
	/** Every reason the path failed, not just the first. */
	reasons: string[];
	/** Facts the verdict rests on, for the stamp. */
	observed: {
		cleanPpsCeiling: number | null;
		headroomRatio: number | null;
		mtuBytes: number | null;
		idleRttP99Ms: number | null;
		preflightDate: string;
	};
};

function isoDate(instant: string): string {
	return instant.slice(0, 10);
}

/**
 * The registered STOP rule, in one function.
 *
 * A gate run over the cable is INVALID unless a pre-flight from the same day
 * shows the path carrying the gate's offered rate at the gate's payload size
 * with loss at or under the registered bound. This is deliberately a *link*
 * statement: it says nothing about the server, and it is computed from an
 * artifact that was written before the gate ran, so it cannot be tuned by what
 * the gate produced.
 *
 * The rule is intentionally strict about the payload size. Packets-per-second is
 * the hard currency on this rig, and a 1500 B pre-flight does not license a
 * 1150 B gate — the pps at the same bitrate differ by 30%.
 */
export function evaluatePreflight(
	artifact: PreflightArtifact,
	requirement: PreflightRequirement,
): PreflightVerdict {
	const reasons: string[] = [];

	for (const guard of artifact.guards) {
		if (!guard.ok) reasons.push(`guard ${guard.name} failed: ${guard.detail}`);
	}

	if (artifact.schemaVersion !== PREFLIGHT_SCHEMA_VERSION) {
		reasons.push(
			`pre-flight schema ${artifact.schemaVersion} is not the expected ${PREFLIGHT_SCHEMA_VERSION}`,
		);
	}

	if (isoDate(artifact.startedAt) !== isoDate(requirement.runDateIso)) {
		reasons.push(
			`pre-flight ran ${isoDate(artifact.startedAt)}, gate ran ${isoDate(requirement.runDateIso)} — same-day rule`,
		);
	}

	const payloads = new Set(artifact.udpRungs.map((r) => r.payloadBytes));
	if (artifact.udpRungs.length === 0) {
		reasons.push("pre-flight has no UDP rungs");
	} else if (!payloads.has(requirement.payloadBytes)) {
		reasons.push(
			`pre-flight measured payloads [${[...payloads].join(",")}] B, gate offers ${requirement.payloadBytes} B`,
		);
	}

	const matching = artifact.udpRungs.filter(
		(r) => r.payloadBytes === requirement.payloadBytes,
	);
	const ceiling = derivePpsCeiling(matching, requirement.maxLossPct);
	const cleanPps = ceiling.cleanPps;
	if (cleanPps === null) {
		reasons.push(
			`no UDP rung at ${requirement.payloadBytes} B stayed under ${requirement.maxLossPct}% loss`,
		);
	} else if (cleanPps < requirement.offeredPps) {
		reasons.push(
			`link carries ${Math.round(cleanPps)} pps under ${requirement.maxLossPct}% loss; gate offers ${requirement.offeredPps} pps`,
		);
	}

	const mtu = artifact.link.mtuBytes;
	if (requirement.minMtuBytes !== undefined) {
		if (mtu === null) reasons.push("pre-flight did not establish an MTU");
		else if (mtu < requirement.minMtuBytes) {
			reasons.push(
				`path MTU ${mtu} B is below the registered ${requirement.minMtuBytes} B`,
			);
		}
	}

	const rttP99 = artifact.rtt?.p99Ms ?? null;
	if (requirement.maxIdleRttP99Ms !== undefined) {
		if (rttP99 === null)
			reasons.push("pre-flight produced no idle RTT baseline");
		else if (rttP99 > requirement.maxIdleRttP99Ms) {
			reasons.push(
				`idle RTT p99 ${rttP99.toFixed(3)} ms exceeds the registered ${requirement.maxIdleRttP99Ms} ms`,
			);
		}
	}

	return {
		valid: reasons.length === 0,
		reasons,
		observed: {
			cleanPpsCeiling: cleanPps,
			headroomRatio:
				cleanPps !== null && requirement.offeredPps > 0
					? cleanPps / requirement.offeredPps
					: null,
			mtuBytes: mtu,
			idleRttP99Ms: rttP99,
			preflightDate: isoDate(artifact.startedAt),
		},
	};
}
