/**
 * The 1→N fan-out shape's arithmetic and its two falsifiers, as pure functions.
 *
 * Registered by `docs/research/preregistrations/egress.md` amendment 8, which
 * replaced the retracted fan-out ladder. Every threshold in this file is a
 * transcription of a number that document fixed before any of this code existed;
 * none of it decides anything on its own.
 *
 * It lives apart from `bench-egress.ts` because a falsifier that only runs
 * inside a 45-second arm on a Linux runner cannot be shown to fire. Here the
 * rules are functions over plain records, so `egress-fanout.test.ts` can feed
 * them the exact signature of the retracted run — a 9–31 µs ingest path, a
 * starved sink — and assert that they reject it.
 */

/**
 * The two registered sweeps. `per-subscriber` holds each subscriber's rate
 * constant while N grows, so aggregate forward load grows with N;
 * `constant-aggregate` pins the aggregate and divides it across N. An effect
 * that shows up in the first and not the second is a rate effect, not an N
 * effect — which is the whole reason both exist.
 */
export type FanoutMode = "per-subscriber" | "constant-aggregate";

export function isFanoutMode(value: string): value is FanoutMode {
	return value === "per-subscriber" || value === "constant-aggregate";
}

/**
 * Ingest-reality floor, in nanoseconds, on the p50 of publisher-send → first
 * forward issue. The retracted run's signature was 9–31 µs; this is 3.2× the top
 * of that. It is a falsifier threshold and not a claim about what a real ingest
 * path costs — the observed distribution is reported in full either way.
 */
export const INGEST_REALITY_FLOOR_NS = 100_000;
/** Arrivals that must carry a decodable publisher stamp. */
export const STAMP_PROVENANCE_FRACTION = 0.99;
/** Multiplicative band the observed frame-gap fraction must fall inside. */
export const CADENCE_BAND_LOW = 0.5;
export const CADENCE_BAND_HIGH = 2.0;
/** A gap this fraction of a grid period or longer is a frame boundary. */
export const CADENCE_GAP_FRACTION = 0.5;

/** The sink pre-check drives this multiple of the load the fan-out will impose. */
export const SINK_HEADROOM_FACTOR = 1.5;
/** Delivery the sink must sustain at that multiple. */
export const SINK_DELIVERY_FLOOR = 0.99;
/** Latency gate the sink must hold at that multiple: one 30 fps frame. */
export const SINK_GATE_NS = 33.3e6;

/** Publisher honesty: offered fraction, and skipped-tick fraction. */
export const PUBLISHER_OFFERED_FRACTION = 0.9;
export const PUBLISHER_SKIP_FRACTION = 0.1;
/** Forward side: fraction of `ingested × subscribers` the server must issue. */
export const FORWARD_OFFERED_FRACTION = 0.9;

/**
 * Publisher datagrams/s for one step of a sweep.
 *
 * `per-subscriber` ignores N — that is the point of it. `constant-aggregate`
 * divides the pinned aggregate across N and reports the quantized result, so a
 * rung's label is the rate it actually asked for.
 */
export function publisherRateFor(
	mode: FanoutMode,
	subscribers: number,
	perSubscriberRate: number,
	aggregateRate: number,
): number {
	if (mode === "per-subscriber") return perSubscriberRate;
	return Math.max(1, Math.round(aggregateRate / Math.max(subscribers, 1)));
}

/**
 * Datagrams the Rust load client emits per tick: `round(rate / hz)`, floored at
 * one, exactly as `crates/reference/src/load_client.rs` computes it. The cadence
 * check needs this number, and deriving it twice from different arithmetic is
 * how a falsifier quietly stops matching the thing it tests.
 */
export function datagramsPerTick(rate: number, tickHz: number): number {
	return Math.max(1, Math.round(rate / Math.max(tickHz, 1)));
}

export type CadenceBand = { low: number; high: number; expected: number };

/**
 * The band the server-observed frame-gap fraction must fall in.
 *
 * A publisher emitting `perTick` datagrams back to back every frame produces one
 * long gap per `perTick` arrivals, so the expected fraction is `1/perTick`. An
 * in-process source that never crossed a network has no such structure: either
 * every gap is short (a free-running loop) or every gap is long (one datagram
 * per synthetic event). Both land outside the band.
 */
export function cadenceBandFor(perTick: number): CadenceBand {
	const expected = 1 / Math.max(perTick, 1);
	return {
		expected,
		low: CADENCE_BAND_LOW * expected,
		high: CADENCE_BAND_HIGH * expected,
	};
}

export type IngestRealityInput = {
	/** p50 of publisher actual-send → first forward send issued. */
	ingestToForwardP50Ns: number;
	/** Fraction of server-observed inter-arrival gaps at or above a frame boundary. */
	frameGapFraction: number;
	/** Datagrams the publisher emits per tick, from `datagramsPerTick`. */
	datagramsPerTick: number;
	/** Publisher arrivals that carried a decodable stamp. */
	publisherStamped: number;
	/** Publisher arrivals the server observed at all. */
	ingested: number;
};

export type IngestRealityVerdict = {
	real: boolean;
	/** Every condition that failed, in registered order. Empty when real. */
	reasons: Array<"lag-microsecond" | "cadence-absent" | "stamp-provenance">;
	band: CadenceBand;
};

/**
 * Falsifier 1. The retracted fan-out run reported a 9–31 µs ingest-to-forward
 * lag while the ladder beside it read 1.4–4.9 ms — proof that the path it
 * measured never contained a network. These three conditions reject that
 * signature: the lag has to be above a µs-scale floor, the publisher's frame
 * cadence has to be visible in the server's own arrival times, and the arrivals
 * have to actually be the publisher's stamped datagrams.
 */
export function ingestRealityVerdict(
	input: IngestRealityInput,
): IngestRealityVerdict {
	const band = cadenceBandFor(input.datagramsPerTick);
	const reasons: IngestRealityVerdict["reasons"] = [];
	if (input.ingestToForwardP50Ns < INGEST_REALITY_FLOOR_NS) {
		reasons.push("lag-microsecond");
	}
	if (input.frameGapFraction < band.low || input.frameGapFraction > band.high) {
		reasons.push("cadence-absent");
	}
	if (
		input.ingested <= 0 ||
		input.publisherStamped < STAMP_PROVENANCE_FRACTION * input.ingested
	) {
		reasons.push("stamp-provenance");
	}
	return { real: reasons.length === 0, reasons, band };
}

export type SinkPrecheckInput = {
	subscribers: number;
	/** Aggregate datagrams/s the pre-check drove into the subscriber process. */
	offeredPerSec: number;
	deliveryRatio: number | null;
	oneWayP99Ns: number | null;
	/** True when the pre-check's own JS originator saturated. */
	generatorSaturated: boolean;
};

export type SinkPrecheckOutcome =
	| "pass"
	| "sink-saturation"
	| "sink-precheck-inconclusive";

/**
 * Falsifier 2. The subscriber process shares 4 vCPU with everything else, so a
 * fan-out p99 is only about the server if the sink was demonstrably not the
 * binding constraint. The pre-check drives the sink at 1.5× the load the fan-out
 * will impose and requires it to hold the same delivery bar G4 sets on forward
 * delivery, under the frame gate.
 *
 * A pre-check whose own JS originator saturated says nothing about the sink, so
 * it is `inconclusive` rather than a pass — a saturated generator offering less
 * load would otherwise look exactly like a healthy sink.
 */
export function sinkPrecheckVerdict(
	input: SinkPrecheckInput,
): SinkPrecheckOutcome {
	if (input.generatorSaturated) return "sink-precheck-inconclusive";
	if (input.deliveryRatio === null || input.oneWayP99Ns === null) {
		return "sink-precheck-inconclusive";
	}
	if (input.deliveryRatio < SINK_DELIVERY_FLOOR) return "sink-saturation";
	if (input.oneWayP99Ns >= SINK_GATE_NS) return "sink-saturation";
	return "pass";
}

export type PublisherHonestyInput = {
	sent: number;
	effectiveRatePerSec: number;
	driveWindowSec: number;
	ticksSkipped: number;
	sendEvents: number;
};

/**
 * The publisher is a Rust process, so the ladder's JS `generator-saturation`
 * rule does not describe it. This is its registered replacement, in the same
 * two parts: did it offer the load, and did it hit its own grid.
 */
export function publisherShortfall(input: PublisherHonestyInput): boolean {
	const expected = input.effectiveRatePerSec * input.driveWindowSec;
	if (expected > 0 && input.sent < PUBLISHER_OFFERED_FRACTION * expected) {
		return true;
	}
	const events = input.ticksSkipped + input.sendEvents;
	return events > 0 && input.ticksSkipped >= PUBLISHER_SKIP_FRACTION * events;
}

/** The forward side did not issue the shape the arrivals called for. */
export function forwardShortfall(
	forwarded: number,
	ingested: number,
	subscribers: number,
): boolean {
	const expected = ingested * subscribers;
	return expected > 0 && forwarded < FORWARD_OFFERED_FRACTION * expected;
}
