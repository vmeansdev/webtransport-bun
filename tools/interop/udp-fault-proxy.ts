import { createSocket, type RemoteInfo, type Socket } from "node:dgram";

export type FaultDirection = "client-to-server" | "server-to-client";

export interface UdpFaultProfile {
	name: string;
	seed: number;
	lossRate?: number;
	duplicateRate?: number;
	reorderRate?: number;
	delayMs?: number;
	jitterMs?: number;
	reorderExtraMs?: number;
	burstLoss?: { startPacket: number; packetCount: number };
	blackHole?: { startMs: number; durationMs: number };
}

export interface FaultStats {
	seen: number;
	forwarded: number;
	dropped: number;
	duplicated: number;
	delayed: number;
	reordered: number;
	blackHoled: number;
	burstDropped: number;
}

type PacketPlan = { drop: boolean; delaysMs: number[]; reason?: string };

function probability(value: number | undefined, label: string): number {
	const normalized = value ?? 0;
	if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
		throw new Error(`${label} must be between 0 and 1`);
	}
	return normalized;
}

function nonNegative(value: number | undefined, label: string): number {
	const normalized = value ?? 0;
	if (!Number.isFinite(normalized) || normalized < 0) {
		throw new Error(`${label} must be non-negative`);
	}
	return normalized;
}

class XorShift32 {
	private state: number;

	constructor(seed: number) {
		if (!Number.isSafeInteger(seed)) throw new Error("seed must be an integer");
		this.state = seed | 0 || 0x6d2b79f5;
	}

	next(): number {
		let value = this.state;
		value ^= value << 13;
		value ^= value >>> 17;
		value ^= value << 5;
		this.state = value | 0;
		return (value >>> 0) / 0x1_0000_0000;
	}
}

export class SeededUdpFaultEngine {
	readonly profile: Readonly<UdpFaultProfile>;
	readonly stats: FaultStats = {
		seen: 0,
		forwarded: 0,
		dropped: 0,
		duplicated: 0,
		delayed: 0,
		reordered: 0,
		blackHoled: 0,
		burstDropped: 0,
	};
	private readonly random: XorShift32;
	private readonly startMs: number;
	private readonly packetCount = new Map<FaultDirection, number>();

	constructor(profile: UdpFaultProfile, startMs = Date.now()) {
		assertFaultProfile(profile);
		this.profile = structuredClone(profile);
		this.random = new XorShift32(profile.seed);
		this.startMs = startMs;
	}

	plan(direction: FaultDirection, nowMs = Date.now()): PacketPlan {
		this.stats.seen += 1;
		const packet = (this.packetCount.get(direction) ?? 0) + 1;
		this.packetCount.set(direction, packet);
		const elapsedMs = Math.max(0, nowMs - this.startMs);
		const blackHole = this.profile.blackHole;
		if (
			blackHole &&
			elapsedMs >= blackHole.startMs &&
			elapsedMs < blackHole.startMs + blackHole.durationMs
		) {
			this.stats.dropped += 1;
			this.stats.blackHoled += 1;
			return { drop: true, delaysMs: [], reason: "black-hole" };
		}
		const burst = this.profile.burstLoss;
		if (
			burst &&
			packet >= burst.startPacket &&
			packet < burst.startPacket + burst.packetCount
		) {
			this.stats.dropped += 1;
			this.stats.burstDropped += 1;
			return { drop: true, delaysMs: [], reason: "burst-loss" };
		}
		if (this.random.next() < (this.profile.lossRate ?? 0)) {
			this.stats.dropped += 1;
			return { drop: true, delaysMs: [], reason: "seeded-loss" };
		}

		const jitter = this.profile.jitterMs ?? 0;
		const jitterDelta =
			jitter === 0 ? 0 : (this.random.next() * 2 - 1) * jitter;
		let delay = Math.max(0, (this.profile.delayMs ?? 0) + jitterDelta);
		const reordered = this.random.next() < (this.profile.reorderRate ?? 0);
		if (reordered) {
			delay += this.profile.reorderExtraMs ?? 25;
			this.stats.reordered += 1;
		}
		const delaysMs = [Math.round(delay)];
		if (delay > 0) this.stats.delayed += 1;
		if (this.random.next() < (this.profile.duplicateRate ?? 0)) {
			delaysMs.push(Math.round(delay + 1));
			this.stats.duplicated += 1;
		}
		this.stats.forwarded += delaysMs.length;
		return { drop: false, delaysMs };
	}

	evidence(): { profile: Readonly<UdpFaultProfile>; stats: FaultStats } {
		return {
			profile: structuredClone(this.profile),
			stats: { ...this.stats },
		};
	}
}

export function assertFaultProfile(profile: UdpFaultProfile): void {
	if (!profile.name.trim()) throw new Error("fault profile name is required");
	if (!Number.isSafeInteger(profile.seed))
		throw new Error("seed must be an integer");
	probability(profile.lossRate, "lossRate");
	probability(profile.duplicateRate, "duplicateRate");
	probability(profile.reorderRate, "reorderRate");
	nonNegative(profile.delayMs, "delayMs");
	nonNegative(profile.jitterMs, "jitterMs");
	nonNegative(profile.reorderExtraMs, "reorderExtraMs");
	if (profile.burstLoss) {
		if (
			!Number.isSafeInteger(profile.burstLoss.startPacket) ||
			profile.burstLoss.startPacket < 1
		) {
			throw new Error("burstLoss.startPacket must be a positive integer");
		}
		if (
			!Number.isSafeInteger(profile.burstLoss.packetCount) ||
			profile.burstLoss.packetCount < 1
		) {
			throw new Error("burstLoss.packetCount must be a positive integer");
		}
	}
	if (profile.blackHole) {
		nonNegative(profile.blackHole.startMs, "blackHole.startMs");
		if (
			!Number.isFinite(profile.blackHole.durationMs) ||
			profile.blackHole.durationMs <= 0
		) {
			throw new Error("blackHole.durationMs must be positive");
		}
	}
}

interface ProxyOptions {
	listenHost?: string;
	listenPort: number;
	upstreamHost?: string;
	upstreamPort: number;
	profile: UdpFaultProfile;
}

export class UdpFaultProxy {
	readonly engine: SeededUdpFaultEngine;
	private front: Socket | null = null;
	private back: Socket | null = null;
	private client: { address: string; port: number } | null = null;
	private closed = false;
	private readonly timers = new Set<ReturnType<typeof setTimeout>>();

	constructor(private readonly options: ProxyOptions) {
		this.engine = new SeededUdpFaultEngine(options.profile);
	}

	async start(): Promise<void> {
		if (this.front || this.back)
			throw new Error("UDP fault proxy already started");
		const upstreamHost = this.options.upstreamHost ?? "127.0.0.1";
		const back = createSocket("udp4");
		const front = createSocket("udp4");
		this.back = back;
		this.front = front;
		back.on("message", (data) => {
			const client = this.client;
			if (!client) return;
			this.forward("server-to-client", data, (packet) => {
				front.send(packet, client.port, client.address);
			});
		});
		front.on("message", (data, remote: RemoteInfo) => {
			if (
				this.client &&
				(this.client.address !== remote.address ||
					this.client.port !== remote.port)
			) {
				return;
			}
			this.client = { address: remote.address, port: remote.port };
			this.forward("client-to-server", data, (packet) => back.send(packet));
		});
		try {
			await new Promise<void>((resolve, reject) => {
				const fail = (error: Error) => reject(error);
				back.once("error", fail);
				back.connect(this.options.upstreamPort, upstreamHost, () => {
					back.off("error", fail);
					resolve();
				});
			});
			await new Promise<void>((resolve, reject) => {
				const fail = (error: Error) => reject(error);
				front.once("error", fail);
				front.bind(
					this.options.listenPort,
					this.options.listenHost ?? "127.0.0.1",
					() => {
						front.off("error", fail);
						resolve();
					},
				);
			});
		} catch (error) {
			this.close();
			throw error;
		}
	}

	private forward(
		direction: FaultDirection,
		data: Uint8Array,
		send: (packet: Uint8Array) => void,
	): void {
		if (this.closed) return;
		const packet = data.slice();
		const plan = this.engine.plan(direction);
		if (plan.drop) return;
		for (const delayMs of plan.delaysMs) {
			const timer = setTimeout(() => {
				this.timers.delete(timer);
				if (!this.closed) send(packet.slice());
			}, delayMs);
			this.timers.add(timer);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const timer of this.timers) clearTimeout(timer);
		this.timers.clear();
		try {
			this.front?.close();
		} catch {
			// The socket may have failed before bind completed.
		}
		try {
			this.back?.close();
		} catch {
			// The socket may have failed before connect completed.
		}
		this.front = null;
		this.back = null;
		this.client = null;
	}
}

export const RELEASE_FAULT_PROFILES: readonly UdpFaultProfile[] = [
	{ name: "seeded-loss", seed: 0x1a2b3c4d, lossRate: 0.08 },
	{ name: "seeded-duplication", seed: 0x2a3b4c5d, duplicateRate: 0.08 },
	{
		name: "seeded-reordering",
		seed: 0x3a4b5c6d,
		reorderRate: 0.08,
		reorderExtraMs: 20,
	},
	{ name: "fixed-delay", seed: 0x4a5b6c7d, delayMs: 30 },
	{ name: "seeded-jitter", seed: 0x5a6b7c8d, delayMs: 20, jitterMs: 15 },
	{
		name: "burst-loss",
		seed: 0x6a7b8c9d,
		burstLoss: { startPacket: 12, packetCount: 3 },
	},
	{
		name: "black-hole-recovery",
		seed: 0x7a8b9cad,
		blackHole: { startMs: 750, durationMs: 500 },
	},
] as const;
