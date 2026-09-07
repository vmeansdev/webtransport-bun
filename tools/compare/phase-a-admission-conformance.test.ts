/**
 * The Phase-A producer/verifier join, without a live campaign.
 *
 * The defect this file exists to prevent: `verifyServerObservationEvidence`
 * required `admission.delivered === PHASE_A_DECLARED_MESSAGE_BYTES` and
 * `sampleCount === 1`, while a bulk leg files `ledger.delivered` as the bulk
 * *schedule* (1,600 chunks) and one Mbps sample per throughput window. The
 * fixture the verifier was tested against was minted to agree with the
 * verifier, so both sides were green and every arm of the first live campaign
 * that ever moved bytes refused at the seal -- with a message ("delivered
 * bytes") that named the condition and neither number.
 *
 * Nothing here is reconstructed: the leg comes out of the production executor
 * (`executeBulkOneWay`) at the canonical cell's own parameters, the payload
 * comes out of the production assembly points (`measurementSeriesFromLeg` ->
 * `measurementPayloadBytes`), and the admission receipt states what the
 * release binary echoes out of that payload. The numbers below were measured
 * on a real arm against the release `comparison-supervisor` on 2026-09-07:
 * server child bytesWritten 104,857,600 in 1,600 chunks, client deliveredBytes
 * 104,857,600, admission `delivered` 1,600, `sampleUnit` "Mbps".
 */

import { describe, expect, test } from "bun:test";
import type {
	ReceiveChannel,
	Session,
	TransportClock,
	TransportMetrics,
} from "./adapters/transport.ts";
import { measurementSeriesFromLeg } from "./bin/compare-controller.ts";
import { executeBulkOneWay, type MeasuredLeg } from "./client.ts";
import { mintPhaseAAttestationFixture } from "./cohort-fixture-signing.ts";
import {
	PHASE_A_DECLARED_MESSAGE_BYTES,
	PHASE_A_DECLARED_MESSAGE_COUNT,
} from "./cross-supervisor-protocol.ts";
import { PRIMARY_METRIC_CONTRACTS } from "./evidence.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import { verifyArmAttestationEvidence } from "./server-observation-artifact.ts";
import { measurementPayloadBytes } from "./supervisor-protocol.ts";
import type { BulkParameters, ScenarioCell } from "./types.ts";

const CELL: ScenarioCell = (() => {
	const found = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(cell) => cell.cellId === "bulk-one-way/physical",
	);
	if (found === undefined) {
		throw new Error("bulk-one-way/physical is not in the registry");
	}
	return found;
})();
const BULK = CELL.parameters as BulkParameters;

/** A clock that steps once per chunk, so the leg files several Mbps windows. */
function steppingClock(startMs: number, stepMs: number): TransportClock {
	let now = startMs;
	return {
		nowMs: () => {
			const reading = now;
			now += stepMs;
			return reading;
		},
		sleep: async () => undefined,
		method: "test.stepping",
	};
}

function metrics(delivered: number): TransportMetrics {
	return {
		attempted: delivered,
		queued: delivered,
		serverObserved: delivered,
		acknowledged: delivered,
		delivered,
		refused: 0,
		dropped: 0,
		timedOut: 0,
		sessionsOpened: 1,
		sessionsClosed: 0,
		streamsOpened: 0,
		streamsAccepted: 1,
		streamsClosed: 0,
		active: true,
		queueBytes: 0,
		queueBytesPeak: 0,
		receiveQueueItems: 0,
		receiveQueueBytes: 0,
		loopUtilization: { busyMs: 1, windowMs: 10 },
		harnessOverheadBytes: 0,
		sessionsActive: 1,
		handshakesInFlight: 0,
		handshakesAttempted: 1,
		handshakesAccepted: 1,
		handshakesRejected: 0,
		streamOpenAttempts: 0,
		streamOpenAccepted: 0,
		streamOpenRejected: 0,
		datagramAttempts: 0,
		datagramAccepted: 0,
		datagramRejected: 0,
		tokenBucketRejected: 0,
	};
}

/** The patterned schedule `runBulkSourcePeer` writes, chunk by chunk. */
function bulkSinkSession(bytes: number, chunkBytes: number): Session {
	let remaining = bytes;
	let sequence = 1;
	const channel: ReceiveChannel = {
		channelId: 1,
		async read() {
			if (remaining <= 0) return null;
			const size = Math.min(chunkBytes, remaining);
			const chunk = new Uint8Array(size);
			chunk.fill(sequence & 0xff);
			remaining -= size;
			sequence += 1;
			return chunk;
		},
		async cancel() {
			remaining = 0;
		},
	};
	const refuse = () => {
		throw new Error("a bulk sink session has only acceptUni");
	};
	return {
		role: "client",
		sendMessage: refuse,
		receiveMessage: refuse,
		sendText: refuse,
		openUni: refuse,
		async acceptUni() {
			return channel;
		},
		openBidi: refuse,
		acceptBidi: refuse,
		async close() {},
		snapshot: () => metrics(Math.ceil(bytes / chunkBytes)),
	} as unknown as Session;
}

/** One measured Phase-A bulk leg, from the production executor. */
async function canonicalBulkLeg(): Promise<MeasuredLeg> {
	const contract = PRIMARY_METRIC_CONTRACTS["bulk-one-way"];
	if (contract === undefined)
		throw new Error("no bulk-one-way metric contract");
	return await executeBulkOneWay({
		session: bulkSinkSession(BULK.bytes, BULK.chunkBytes),
		cell: CELL,
		driverRunId: "phase-a-conformance",
		runId: "phase-a-conformance",
		sessionId: "phase-a-conformance-s1",
		clock: steppingClock(1_700_000_000_000, 1),
		perMessageTimeoutMs: 5_000,
		contract,
	});
}

describe("phase-a admission conformance: the producer's units are the verifier's", () => {
	test("the canonical cell declares 1,600 chunks of 65,536 bytes", () => {
		expect(BULK.bytes).toBe(PHASE_A_DECLARED_MESSAGE_BYTES);
		expect(BULK.bytes / BULK.chunkBytes).toBe(PHASE_A_DECLARED_MESSAGE_COUNT);
	});

	test("a measured bulk leg files delivered in CHUNKS and deliveredBytes in BYTES", async () => {
		const leg = await canonicalBulkLeg();
		// The exact confusion that cost four live campaigns: `ledger.delivered`
		// is not a byte count, and no check may read it as one.
		expect(leg.ledger.delivered).toBe(PHASE_A_DECLARED_MESSAGE_COUNT);
		expect(leg.ledger.delivered).not.toBe(PHASE_A_DECLARED_MESSAGE_BYTES);
		expect(leg.deliveredBytes).toBe(PHASE_A_DECLARED_MESSAGE_BYTES);
		expect(leg.sampleUnit).toBe("Mbps");
		expect(leg.roundTrips).toEqual([]);
		// One sample per throughput window, never exactly one for the leg.
		expect(leg.samples.length).toBeGreaterThan(1);
		expect(leg.provenance.sampleCount).toBe(leg.samples.length);
	});

	test("the production payload carries both, and the Phase-A verifier accepts it", async () => {
		const leg = await canonicalBulkLeg();
		const series = measurementSeriesFromLeg(leg);
		expect(series.ledger.delivered).toBe(PHASE_A_DECLARED_MESSAGE_COUNT);
		expect(series.deliveredBytes).toBe(PHASE_A_DECLARED_MESSAGE_BYTES);

		// The payload's embedded grant is the minter's own, so the bytes grafted
		// in are the bytes this execution's driver would have presented.
		const grant = mintPhaseAAttestationFixture().grant;
		const fixture = mintPhaseAAttestationFixture({
			phaseAClientSeries: {
				bytes: measurementPayloadBytes(series, grant),
				sampleCount: leg.samples.length,
				delivered: leg.ledger.delivered,
			},
		});
		const verified = verifyArmAttestationEvidence(
			fixture.attestation,
			fixture.trust,
			{
				executionSha256: fixture.executionSha256,
				cellId: "bulk-one-way/physical",
				armKind: "primary",
			},
		);
		expect(verified).toEqual({ ok: true });
	});

	test("a relabelled series is refused, naming the unit on both records", async () => {
		const leg = await canonicalBulkLeg();
		const series = measurementSeriesFromLeg(leg);
		const grant = mintPhaseAAttestationFixture().grant;
		const fixture = mintPhaseAAttestationFixture({
			phaseAClientSeries: {
				bytes: measurementPayloadBytes(
					{ ...series, sampleUnit: "count" },
					grant,
				),
				sampleCount: leg.samples.length,
				delivered: leg.ledger.delivered,
			},
		});
		const verified = verifyArmAttestationEvidence(
			fixture.attestation,
			fixture.trust,
			{
				executionSha256: fixture.executionSha256,
				cellId: "bulk-one-way/physical",
				armKind: "primary",
			},
		);
		expect(verified.ok).toBe(false);
		if (verified.ok) throw new Error("unreachable");
		expect(verified.code).toBe("MEASUREMENT_WINDOW");
		expect(verified.message).toBe(
			"phase-a sampleUnit: observed count on the admitted series and " +
				"Mbps on the admission, expected Mbps on both",
		);
	});

	test("a short transfer is refused on the byte field, with both byte counts", async () => {
		// `executeBulkOneWay` refuses a short read itself, so a series that
		// claims fewer bytes can only come from a driver that is wrong or
		// lying. The declared byte total is asserted here and nowhere else, so
		// this is the case that keeps it asserted.
		const leg = await canonicalBulkLeg();
		const series = measurementSeriesFromLeg(leg);
		const grant = mintPhaseAAttestationFixture().grant;
		const short = PHASE_A_DECLARED_MESSAGE_BYTES / 2;
		const fixture = mintPhaseAAttestationFixture({
			phaseAClientSeries: {
				bytes: measurementPayloadBytes(
					{ ...series, deliveredBytes: short },
					grant,
				),
				sampleCount: leg.samples.length,
				delivered: leg.ledger.delivered,
			},
		});
		const verified = verifyArmAttestationEvidence(
			fixture.attestation,
			fixture.trust,
			{
				executionSha256: fixture.executionSha256,
				cellId: "bulk-one-way/physical",
				armKind: "primary",
			},
		);
		expect(verified.ok).toBe(false);
		if (verified.ok) throw new Error("unreachable");
		expect(verified.code).toBe("MEASUREMENT_WINDOW");
		expect(verified.message).toBe(
			"admitted client series deliveredBytes: " +
				`observed ${short}, expected ${PHASE_A_DECLARED_MESSAGE_BYTES}`,
		);
	});

	test("a series whose ledger disagrees with the receipt that binds it is refused", async () => {
		// The admission receipt is signed over a digest of these bytes, so a
		// receipt saying 1,600 beside a payload saying 1,601 is a substitution.
		const leg = await canonicalBulkLeg();
		const series = measurementSeriesFromLeg(leg);
		const grant = mintPhaseAAttestationFixture().grant;
		const fixture = mintPhaseAAttestationFixture({
			phaseAClientSeries: {
				bytes: measurementPayloadBytes(
					{ ...series, ledger: { delivered: leg.ledger.delivered + 1 } },
					grant,
				),
				sampleCount: leg.samples.length,
				delivered: leg.ledger.delivered,
			},
		});
		const verified = verifyArmAttestationEvidence(
			fixture.attestation,
			fixture.trust,
			{
				executionSha256: fixture.executionSha256,
				cellId: "bulk-one-way/physical",
				armKind: "primary",
			},
		);
		expect(verified.ok).toBe(false);
		if (verified.ok) throw new Error("unreachable");
		expect(verified.code).toBe("CROSS_SUPERVISOR_MISMATCH");
		expect(verified.message).toBe(
			"admitted client series ledger.delivered (scheduled chunks): " +
				`observed ${PHASE_A_DECLARED_MESSAGE_COUNT + 1}, expected ${PHASE_A_DECLARED_MESSAGE_COUNT}`,
		);
	});

	test("a sample count that is not the series' own is refused, with both counts", async () => {
		const leg = await canonicalBulkLeg();
		const series = measurementSeriesFromLeg(leg);
		const grant = mintPhaseAAttestationFixture().grant;
		const fixture = mintPhaseAAttestationFixture({
			phaseAClientSeries: {
				bytes: measurementPayloadBytes(series, grant),
				sampleCount: leg.samples.length + 1,
				delivered: leg.ledger.delivered,
			},
		});
		const verified = verifyArmAttestationEvidence(
			fixture.attestation,
			fixture.trust,
			{
				executionSha256: fixture.executionSha256,
				cellId: "bulk-one-way/physical",
				armKind: "primary",
			},
		);
		expect(verified.ok).toBe(false);
		if (verified.ok) throw new Error("unreachable");
		expect(verified.code).toBe("MEASUREMENT_WINDOW");
		// The whole message survives: a literal this module wrote is never
		// truncated by the bound that protects it from evidence-supplied text.
		expect(verified.message).toBe(
			"phase-a admission sampleCount (Mbps windows): observed " +
				`${leg.samples.length + 1}, expected ${leg.samples.length}, ` +
				"the admitted series' own sample count, and at least 1",
		);
	});

	test("an admission with no measured span is refused, and says so", async () => {
		const leg = await canonicalBulkLeg();
		const series = measurementSeriesFromLeg(leg);
		const grant = mintPhaseAAttestationFixture().grant;
		const fixture = mintPhaseAAttestationFixture({
			spanMs: 0,
			phaseAClientSeries: {
				bytes: measurementPayloadBytes(series, grant),
				sampleCount: leg.samples.length,
				delivered: leg.ledger.delivered,
			},
		});
		const verified = verifyArmAttestationEvidence(
			fixture.attestation,
			fixture.trust,
			{
				executionSha256: fixture.executionSha256,
				cellId: "bulk-one-way/physical",
				armKind: "primary",
			},
		);
		expect(verified.ok).toBe(false);
		if (verified.ok) throw new Error("unreachable");
		expect(verified.code).toBe("MEASUREMENT_WINDOW");
		expect(verified.message).toBe(
			"phase-a admission spanMs: observed 0, expected > 0",
		);
	});

	test("the old expectation is refused, and the refusal carries both numbers", async () => {
		const leg = await canonicalBulkLeg();
		const series = measurementSeriesFromLeg(leg);
		const grant = mintPhaseAAttestationFixture().grant;
		const fixture = mintPhaseAAttestationFixture({
			phaseAClientSeries: {
				bytes: measurementPayloadBytes(series, grant),
				sampleCount: leg.samples.length,
				// What the verifier used to require of this field: the byte total.
				delivered: PHASE_A_DECLARED_MESSAGE_BYTES,
			},
		});
		const verified = verifyArmAttestationEvidence(
			fixture.attestation,
			fixture.trust,
			{
				executionSha256: fixture.executionSha256,
				cellId: "bulk-one-way/physical",
				armKind: "primary",
			},
		);
		expect(verified.ok).toBe(false);
		if (verified.ok) throw new Error("unreachable");
		expect(verified.code).toBe("MEASUREMENT_WINDOW");
		expect(verified.message).toBe(
			"phase-a admission ledger.delivered (scheduled chunks): " +
				`observed ${PHASE_A_DECLARED_MESSAGE_BYTES}, expected ${PHASE_A_DECLARED_MESSAGE_COUNT}`,
		);
	});
});
