import { describe, expect, test } from "bun:test";
import {
	cadenceBandFor,
	datagramsPerTick,
	forwardShortfall,
	INGEST_REALITY_FLOOR_NS,
	type IngestRealityInput,
	ingestRealityVerdict,
	isFanoutMode,
	publisherRateFor,
	publisherShortfall,
	type SinkPrecheckInput,
	sinkPrecheckVerdict,
} from "./egress-fanout.ts";

const MS = 1e6;
const US = 1e3;

/** A healthy 1→N step: real loopback ingest, 11 datagrams a frame, stamped. */
function healthyIngest(
	over: Partial<IngestRealityInput> = {},
): IngestRealityInput {
	return {
		ingestToForwardP50Ns: 0.9 * MS,
		frameGapFraction: 1 / 11,
		datagramsPerTick: 11,
		publisherStamped: 14_850,
		ingested: 14_850,
		...over,
	};
}

function healthySink(over: Partial<SinkPrecheckInput> = {}): SinkPrecheckInput {
	return {
		subscribers: 50,
		offeredPerSec: 24_750,
		deliveryRatio: 0.998,
		oneWayP99Ns: 6 * MS,
		generatorSaturated: false,
		...over,
	};
}

describe("sweep arithmetic", () => {
	test("per-subscriber holds the rate while N grows", () => {
		for (const n of [10, 25, 50, 100]) {
			expect(publisherRateFor("per-subscriber", n, 330, 16_500)).toBe(330);
		}
	});

	test("constant-aggregate divides the pinned aggregate across N", () => {
		expect(publisherRateFor("constant-aggregate", 10, 330, 16_500)).toBe(1650);
		expect(publisherRateFor("constant-aggregate", 50, 330, 16_500)).toBe(330);
		expect(publisherRateFor("constant-aggregate", 100, 330, 16_500)).toBe(165);
	});

	test("the two sweeps meet at the N the aggregate was derived from", () => {
		expect(publisherRateFor("constant-aggregate", 50, 330, 16_500)).toBe(
			publisherRateFor("per-subscriber", 50, 330, 16_500),
		);
	});

	test("per-tick burst matches the load client's own arithmetic", () => {
		expect(datagramsPerTick(330, 30)).toBe(11);
		expect(datagramsPerTick(165, 30)).toBe(6);
		expect(datagramsPerTick(1650, 30)).toBe(55);
		// Floored at one, the way the Rust side floors it.
		expect(datagramsPerTick(5, 30)).toBe(1);
	});

	test("only the two registered sweeps are modes", () => {
		expect(isFanoutMode("per-subscriber")).toBe(true);
		expect(isFanoutMode("constant-aggregate")).toBe(true);
		expect(isFanoutMode("whatever-clears-the-gate")).toBe(false);
	});
});

describe("falsifier 1 — ingest reality", () => {
	test("a real loopback ingest path passes", () => {
		const verdict = ingestRealityVerdict(healthyIngest());
		expect(verdict.real).toBe(true);
		expect(verdict.reasons).toEqual([]);
	});

	/**
	 * The signature that got the original fan-out arm retracted: an
	 * ingest-to-forward lag of 9–31 µs while the ladder beside it read 1.4–4.9 ms.
	 * Both ends of that observed range must be rejected, or the falsifier does not
	 * catch the run it was written for.
	 */
	test.each([
		9 * US,
		20 * US,
		31 * US,
	])("the retracted %d ns µs-lag signature is rejected", (lagNs) => {
		const verdict = ingestRealityVerdict(
			healthyIngest({ ingestToForwardP50Ns: lagNs }),
		);
		expect(verdict.real).toBe(false);
		expect(verdict.reasons).toContain("lag-microsecond");
	});

	test("the floor is exclusive at exactly the registered value", () => {
		expect(
			ingestRealityVerdict(
				healthyIngest({ ingestToForwardP50Ns: INGEST_REALITY_FLOOR_NS - 1 }),
			).real,
		).toBe(false);
		expect(
			ingestRealityVerdict(
				healthyIngest({ ingestToForwardP50Ns: INGEST_REALITY_FLOOR_NS }),
			).real,
		).toBe(true);
	});

	test("a free-running in-process source has no frame cadence", () => {
		const verdict = ingestRealityVerdict(
			healthyIngest({ frameGapFraction: 0 }),
		);
		expect(verdict.real).toBe(false);
		expect(verdict.reasons).toContain("cadence-absent");
	});

	test("a one-datagram-per-synthetic-event source is all cadence and no burst", () => {
		const verdict = ingestRealityVerdict(
			healthyIngest({ frameGapFraction: 1 }),
		);
		expect(verdict.real).toBe(false);
		expect(verdict.reasons).toContain("cadence-absent");
	});

	test("the cadence band is centred on one long gap per tick burst", () => {
		const band = cadenceBandFor(11);
		expect(band.expected).toBeCloseTo(1 / 11, 6);
		expect(band.low).toBeCloseTo(0.5 / 11, 6);
		expect(band.high).toBeCloseTo(2 / 11, 6);
		// Real jitter around the expectation still passes.
		expect(
			ingestRealityVerdict(healthyIngest({ frameGapFraction: 0.07 })).real,
		).toBe(true);
		expect(
			ingestRealityVerdict(healthyIngest({ frameGapFraction: 0.17 })).real,
		).toBe(true);
	});

	test("arrivals that are not the publisher's stamped datagrams are not ingest", () => {
		const verdict = ingestRealityVerdict(
			healthyIngest({ publisherStamped: 12_000, ingested: 14_850 }),
		);
		expect(verdict.real).toBe(false);
		expect(verdict.reasons).toContain("stamp-provenance");
	});

	test("a step with no arrivals at all is not real ingest", () => {
		const verdict = ingestRealityVerdict(
			healthyIngest({ publisherStamped: 0, ingested: 0 }),
		);
		expect(verdict.real).toBe(false);
		expect(verdict.reasons).toContain("stamp-provenance");
	});

	test("every failed condition is reported, not just the first", () => {
		const verdict = ingestRealityVerdict(
			healthyIngest({
				ingestToForwardP50Ns: 12 * US,
				frameGapFraction: 0,
				publisherStamped: 0,
				ingested: 100,
			}),
		);
		expect(verdict.reasons).toEqual([
			"lag-microsecond",
			"cadence-absent",
			"stamp-provenance",
		]);
	});
});

describe("falsifier 2 — sink saturation", () => {
	test("a sink that absorbs 1.5x the fan-out load passes", () => {
		expect(sinkPrecheckVerdict(healthySink())).toBe("pass");
	});

	test("a starved sink drops delivery and is caught", () => {
		expect(sinkPrecheckVerdict(healthySink({ deliveryRatio: 0.86 }))).toBe(
			"sink-saturation",
		);
	});

	test("a sink that keeps delivery but blows the frame gate is caught", () => {
		expect(sinkPrecheckVerdict(healthySink({ oneWayP99Ns: 41 * MS }))).toBe(
			"sink-saturation",
		);
	});

	test("the delivery bar is the same 0.99 G4 sets on forward delivery", () => {
		expect(sinkPrecheckVerdict(healthySink({ deliveryRatio: 0.99 }))).toBe(
			"pass",
		);
		expect(sinkPrecheckVerdict(healthySink({ deliveryRatio: 0.9899 }))).toBe(
			"sink-saturation",
		);
	});

	/**
	 * A saturated originator offers less load, which looks exactly like a healthy
	 * sink. Calling that a pass would let the pre-check certify the sink precisely
	 * when it learned nothing about it.
	 */
	test("a pre-check whose own generator saturated is inconclusive, never a pass", () => {
		expect(
			sinkPrecheckVerdict(
				healthySink({ generatorSaturated: true, deliveryRatio: 1.0 }),
			),
		).toBe("sink-precheck-inconclusive");
	});

	test("a pre-check with no client numbers is inconclusive", () => {
		expect(sinkPrecheckVerdict(healthySink({ oneWayP99Ns: null }))).toBe(
			"sink-precheck-inconclusive",
		);
		expect(sinkPrecheckVerdict(healthySink({ deliveryRatio: null }))).toBe(
			"sink-precheck-inconclusive",
		);
	});
});

describe("generator STOPs sit on the publisher side", () => {
	test("a publisher that offered its rate is honest", () => {
		expect(
			publisherShortfall({
				sent: 14_850,
				effectiveRatePerSec: 330,
				driveWindowSec: 45,
				ticksSkipped: 3,
				sendEvents: 1350,
			}),
		).toBe(false);
	});

	test("a publisher that under-offered is a shortfall", () => {
		expect(
			publisherShortfall({
				sent: 9_000,
				effectiveRatePerSec: 330,
				driveWindowSec: 45,
				ticksSkipped: 0,
				sendEvents: 1350,
			}),
		).toBe(true);
	});

	test("a publisher that skipped a tenth of its grid is a shortfall", () => {
		expect(
			publisherShortfall({
				sent: 14_850,
				effectiveRatePerSec: 330,
				driveWindowSec: 45,
				ticksSkipped: 150,
				sendEvents: 1200,
			}),
		).toBe(true);
	});
});

describe("capacity STOPs sit on the forward side", () => {
	test("a server that fanned every arrival out to everyone is complete", () => {
		expect(forwardShortfall(14_850 * 50, 14_850, 50)).toBe(false);
	});

	test("a server that dropped a fifth of its forwards did not offer the shape", () => {
		expect(forwardShortfall(0.8 * 14_850 * 50, 14_850, 50)).toBe(true);
	});

	test("a step with no arrivals cannot be a forward shortfall", () => {
		expect(forwardShortfall(0, 0, 50)).toBe(false);
	});
});
