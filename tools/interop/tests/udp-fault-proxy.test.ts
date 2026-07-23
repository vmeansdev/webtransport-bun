import { describe, expect, test } from "bun:test";
import {
	assertFaultProfile,
	RELEASE_FAULT_PROFILES,
	SeededUdpFaultEngine,
} from "../udp-fault-proxy.js";

describe("seeded UDP fault engine", () => {
	test("the same seed and packet timeline produce identical decisions", () => {
		const profile = {
			name: "determinism",
			seed: 123456,
			lossRate: 0.2,
			duplicateRate: 0.25,
			reorderRate: 0.3,
			delayMs: 10,
			jitterMs: 7,
		};
		const first = new SeededUdpFaultEngine(profile, 1_000);
		const second = new SeededUdpFaultEngine(profile, 1_000);
		const firstPlans = Array.from({ length: 100 }, (_, index) =>
			first.plan(
				index % 2 === 0 ? "client-to-server" : "server-to-client",
				1_000 + index,
			),
		);
		const secondPlans = Array.from({ length: 100 }, (_, index) =>
			second.plan(
				index % 2 === 0 ? "client-to-server" : "server-to-client",
				1_000 + index,
			),
		);
		expect(secondPlans).toEqual(firstPlans);
		expect(second.evidence()).toEqual(first.evidence());
	});

	test("burst loss is directional and recovery is deterministic", () => {
		const engine = new SeededUdpFaultEngine(
			{
				name: "burst",
				seed: 1,
				burstLoss: { startPacket: 2, packetCount: 2 },
			},
			0,
		);
		expect(engine.plan("client-to-server", 0).drop).toBe(false);
		expect(engine.plan("client-to-server", 1)).toMatchObject({
			drop: true,
			reason: "burst-loss",
		});
		expect(engine.plan("client-to-server", 2).drop).toBe(true);
		expect(engine.plan("client-to-server", 3).drop).toBe(false);
		expect(engine.plan("server-to-client", 4).drop).toBe(false);
		expect(engine.evidence().stats.burstDropped).toBe(2);
	});

	test("black-hole drops only inside its bounded window and then recovers", () => {
		const engine = new SeededUdpFaultEngine(
			{
				name: "black-hole",
				seed: 2,
				blackHole: { startMs: 100, durationMs: 50 },
			},
			1_000,
		);
		expect(engine.plan("client-to-server", 1_099).drop).toBe(false);
		expect(engine.plan("client-to-server", 1_100).reason).toBe("black-hole");
		expect(engine.plan("server-to-client", 1_149).reason).toBe("black-hole");
		expect(engine.plan("server-to-client", 1_150).drop).toBe(false);
		expect(engine.evidence().stats.blackHoled).toBe(2);
	});

	test("release matrix names every required impairment with immutable seeds", () => {
		const encoded = JSON.stringify(RELEASE_FAULT_PROFILES);
		for (const required of [
			"seeded-loss",
			"seeded-duplication",
			"seeded-reordering",
			"fixed-delay",
			"seeded-jitter",
			"burst-loss",
			"black-hole-recovery",
		]) {
			expect(encoded).toContain(required);
		}
		for (const profile of RELEASE_FAULT_PROFILES) {
			expect(() => assertFaultProfile(profile)).not.toThrow();
			expect(Number.isSafeInteger(profile.seed)).toBe(true);
		}
	});

	test("invalid probabilities and unbounded impairment values fail closed", () => {
		expect(() =>
			assertFaultProfile({ name: "bad", seed: 1, lossRate: 1.1 }),
		).toThrow("lossRate");
		expect(() =>
			assertFaultProfile({ name: "bad", seed: 1, jitterMs: -1 }),
		).toThrow("jitterMs");
		expect(() =>
			assertFaultProfile({
				name: "bad",
				seed: 1,
				blackHole: { startMs: 0, durationMs: 0 },
			}),
		).toThrow("durationMs");
	});
});
