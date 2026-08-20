/**
 * The wiring test C1-1 exists for. These assert the *path* from the burst-probe
 * artifact to the clause, not the arithmetic — `g10-classify.test.ts` already
 * grades `spreadFloorFalsifier` itself. What was missing was any caller at all,
 * so what is pinned here is that an absent artifact reaches C1 and strips it.
 */

import { describe, expect, test } from "bun:test";
import { burstFloorFacts } from "./g10-burst-floor.ts";
import { evaluateSpreadClause, spreadFloorFalsifier } from "./g10-classify.ts";

const DAY = "2026-08-20";
const MAC = "cable-mac";

/** A cell whose spread is comfortably inside the bound, so only V-SP can act. */
const healthySpread = {
	rate: 5,
	subscribers: 10_000,
	spreadP99Ms: 30,
	messagesIssued: 600,
	messagesComplete: 600,
};

function c1(recv: unknown, send: unknown, expectedHost = MAC) {
	const fired = spreadFloorFalsifier(
		burstFloorFacts({ recv, send, runDate: DAY, expectedHost }),
	);
	return { fired, clause: evaluateSpreadClause(healthySpread, fired.fires) };
}

const recvArtifact = {
	role: "recv",
	date: DAY,
	host: MAC,
	drainMsMax: 100,
	completenessMin: 0.98,
};
const sendArtifact = {
	role: "send",
	date: DAY,
	host: "runner",
	emitMsMax: 140,
	emitMsNetMax: 95,
};

describe("V-SP reaches C1, or the gate grades its headline clause blind", () => {
	test("no burst artifact at all forces C1 to no-verdict", () => {
		const { fired, clause } = c1(null, null);
		expect(fired.fires).toBe(true);
		expect(clause.status).toBe("no-verdict-force");
		expect(clause.status).not.toBe("pass");
		expect(clause.reason).toContain("V-SP");
	});

	test("a recv artifact with no send artifact still forces no-verdict", () => {
		expect(c1(recvArtifact, null).clause.status).toBe("no-verdict-force");
	});

	test("yesterday's probe does not license today's run", () => {
		const stale = { ...recvArtifact, date: "2026-08-19" };
		expect(c1(stale, sendArtifact).clause.status).toBe("no-verdict-force");
	});

	test("a probe from the wrong host does not license the run", () => {
		expect(c1(recvArtifact, sendArtifact, "some-other-mac").clause.status).toBe(
			"no-verdict-force",
		);
	});

	test("an unconfigured expected host cannot be matched by any artifact", () => {
		expect(c1(recvArtifact, sendArtifact, "").clause.status).toBe(
			"no-verdict-force",
		);
	});

	test("a same-day sink at wire pace lets C1 render its verdict", () => {
		const { fired, clause } = c1(recvArtifact, sendArtifact);
		expect(fired.fires).toBe(false);
		expect(clause.status).toBe("pass");
	});

	test("a same-day sink slower than the emission still strips the verdict", () => {
		const slow = { ...recvArtifact, drainMsMax: 120 };
		expect(c1(slow, sendArtifact).clause.status).toBe("no-verdict-force");
	});

	test("a pre-Amendment-5 artifact cannot license the run", () => {
		// The old field names. V-SP's ceiling is not computable from them, so the
		// facts read as absent rather than as a reading — which is the rule.
		const legacyRecv = { role: "recv", date: DAY, host: MAC, drainMsP99: 91.9 };
		const legacySend = { role: "send", date: DAY, emitMsMax: 95 };
		expect(c1(legacyRecv, legacySend).clause.status).toBe("no-verdict-force");
	});
});

describe("burstFloorFacts refuses to invent a reading", () => {
	test("NaN percentiles — an empty sample — read as absent, not as zero", () => {
		const facts = burstFloorFacts({
			recv: { date: DAY, host: MAC, drainMsMax: Number.NaN },
			send: { emitMsNetMax: Number.NaN },
			runDate: DAY,
			expectedHost: MAC,
		});
		expect(facts.burstDrainMaxMs).toBeNull();
		expect(facts.burstEmitNetMaxMs).toBeNull();
		expect(spreadFloorFalsifier(facts).fires).toBe(true);
	});

	test("completeness travels even though nothing bounds it", () => {
		const facts = burstFloorFacts({
			recv: recvArtifact,
			send: sendArtifact,
			runDate: DAY,
			expectedHost: MAC,
		});
		expect(facts.burstCompletenessMin).toBe(0.98);
		expect(spreadFloorFalsifier(facts).reason).toContain("completeness min");
	});
});
