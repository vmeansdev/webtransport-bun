/**
 * Gate G11's clauses, validity falsifiers and roll-up, separated from the
 * harness that drives them so every one of them runs without a runner.
 *
 * The contract is docs/research/preregistrations/gate-g11-bidi.md, committed
 * before this file existed. Every threshold here is quoted from that document
 * or computed by `g11-plan.ts` from the constants that document derives.
 * Nothing here looks at a number to decide which question to ask of it.
 *
 * G3b is the reason this file exists in this shape. Its validity falsifier V1
 * lived only in a hand derivation, so nothing computed it until after the run
 * it invalidated. Every falsifier below is a function, is exercised against the
 * signature it exists to reject, and is computed by the same code path that
 * computes the clauses.
 */

import {
	advertisedPerSessionBytes,
	exchangeRttBoundMs,
	FRAME_BYTES,
	oneWayBoundMs,
	SHIPPED_MAX_STREAMS_PER_SESSION_BIDI,
	SHIPPED_QUEUED_BYTES_GLOBAL,
	SHIPPED_QUEUED_BYTES_PER_SESSION,
	tunnelRung,
} from "./g11-plan.ts";

export type Direction = "up" | "down";
export const DIRECTIONS: readonly Direction[] = ["up", "down"] as const;

// --- Pre-registered thresholds ----------------------------------------------

/** §4 V-G: 20% of the one-way bound. Raw p99, nothing subtracted. */
export const SCHEDULER_LAG_P99_BAR_MS = 5;
/** §4 V-P: the cumulative-deadline pacer cannot overshoot; this is a falsifier. */
export const PACE_BAND = { low: 0.98, high: 1.02 } as const;
/** §4 V-S: G5's host bar, percent of the whole box. */
export const HOST_CPU_BAR_PCT_OF_BOX = 90;
/** §4 V-C: G5b's layer-consistency tolerance. */
export const CROSSING_AGREEMENT_TOLERANCE = 0.01;
/** §5 C5: the axis's own 5% integrity band. */
export const FAIRNESS_SPREAD_BAR = 1.05;
export const FAIRNESS_MIN_SHARE = 0.95;
/** §2 Arm D: the falsifier of this registration's own K17 reading. */
export const COUPLING_REFUTED_SPREAD = 2;

export type Verdict = "PASS" | "MISS" | "INVALID" | "INCOMPLETE";

export type ClauseResult = {
	id: string;
	pass: boolean;
	detail: string;
};

export type FalsifierResult = {
	id: string;
	fired: boolean;
	detail: string;
};

// --- Facts the harness must produce ----------------------------------------

/**
 * The generator-honesty report. It is refused unless it belongs to this run,
 * this host and a cell that actually drove sessions — G6's `floorReportIsUsable`,
 * kept because a floor borrowed from another step is not a floor.
 */
export type FloorReport = {
	runId: string;
	host: string;
	drivingSessions: number;
	schedulerLagP99Ms: number;
	schedulerLagMaxMs: number;
	/**
	 * write call → write settled, from the same generator. Pure disclosure: no
	 * clause reads it. It exists so a cell whose generator was flow-controlled
	 * can be told apart from one whose generator was late — the two used to be
	 * summed into `schedulerLag`, which fired V-G on healthy Arm T and Arm D
	 * cells where blocking is the expected condition.
	 */
	writeSettleP99Ms: number | null;
	writeSettleMaxMs: number | null;
};

export type CrossingFacts = {
	dataCrossings: number;
	batchedCrossings: number;
	terminalCrossings: number;
	bytes: number;
	maxBatchBytes: number;
};

export type TunnelCellFacts = {
	cell: string;
	sessions: number;
	repeat: number;
	/** 0 means the chunk-batching knob is off (the gate cell). */
	knobBytes: number;
	windowSec: number;
	runId: string;
	host: string;

	offeredBytes: Record<Direction, number>;
	deliveredBytes: Record<Direction, number>;
	writtenBytes: Record<Direction, number>;
	perSessionDeliveredBytes: Record<Direction, number[]>;
	oneWayP99Ms: Record<Direction, number>;
	oneWaySamples: Record<Direction, number>;
	negativeSamples: Record<Direction, number>;

	streamErrors: number;
	streamResets: number;
	backpressureTimeouts: number;
	streamsClosedBothHalves: number;

	floor: FloorReport;
	hostCpuMedianPctOfBox: number;
	clientCpuPctOfOneCore: number;
	clientCpuCeilingPctOfOneCore: number;
	serverCpuPctOfOneCore: number;
	serverRssMb: number;

	/**
	 * The package's process-global diagnostics counter, per end.
	 *
	 * The client end is `null` when no addon ran there — Arm T's generator is
	 * the reference client, which speaks QUIC directly and has no JS boundary to
	 * cross (Amendment 3). `null` and `0` are different findings and the
	 * classifier keeps them apart: `0` means an addon ran and batched nothing,
	 * which V-K grades; `null` means there was nothing to grade.
	 */
	crossings: { server: CrossingFacts; client: CrossingFacts | null };
	/** The harness's own count of server-side reads, for V-C. */
	harnessServerReadCrossings: number;

	/**
	 * Server-side kernel rcvbuf drops. `null` means the tap was not read — which
	 * is NOT a zero, and V-B says so.
	 */
	serverSocketDrops: number | null;
	rateLimitedCount: number;
	limitExceededCount: number;
	settled: boolean;
	/**
	 * The generator outlived its pre-registered deadline and the conductor killed
	 * it. A killed child quiesces at once, so `settled` says nothing about such a
	 * cell — V-W is what refuses it (ticket 01's pre-registered formula).
	 */
	deadlineBreached: boolean;

	maxQueuedBytesPerSession: number;
	maxQueuedBytesGlobal: number;
};

// --- Small helpers ----------------------------------------------------------

function ratio(actual: number, target: number): number {
	if (target <= 0) return Number.NaN;
	return actual / target;
}

function spread(values: readonly number[]): number {
	if (values.length === 0) return Number.NaN;
	const min = Math.min(...values);
	const max = Math.max(...values);
	if (min <= 0) return Number.POSITIVE_INFINITY;
	return max / min;
}

function pct(value: number): string {
	return `${(value * 100).toFixed(3)}%`;
}

export function floorReportIsUsable(
	floor: FloorReport,
	cell: { runId: string; host: string },
): boolean {
	return (
		floor.runId === cell.runId &&
		floor.host === cell.host &&
		floor.drivingSessions > 0
	);
}

// --- Validity falsifiers (§4) -----------------------------------------------

export function falsifiersForTunnelCell(
	facts: TunnelCellFacts,
): FalsifierResult[] {
	const rung = tunnelRung(facts.sessions);
	const targetBytesPerDirection =
		rung.bytesPerSecPerDirectionPerTunnel * facts.sessions * facts.windowSec;

	const results: FalsifierResult[] = [];

	results.push({
		id: "V-G2",
		fired: !floorReportIsUsable(facts.floor, facts),
		detail: `floor run=${facts.floor.runId}/host=${facts.floor.host}/driving=${facts.floor.drivingSessions} against cell run=${facts.runId}/host=${facts.host}`,
	});

	results.push({
		id: "V-G",
		fired: facts.floor.schedulerLagP99Ms > SCHEDULER_LAG_P99_BAR_MS,
		detail: `client scheduler-lag p99 ${facts.floor.schedulerLagP99Ms} ms (max ${facts.floor.schedulerLagMaxMs} ms) against a ${SCHEDULER_LAG_P99_BAR_MS} ms bar, raw`,
	});

	for (const dir of DIRECTIONS) {
		const r = ratio(facts.offeredBytes[dir], targetBytesPerDirection);
		results.push({
			id: `V-P/${dir}`,
			fired: !(r >= PACE_BAND.low && r <= PACE_BAND.high),
			detail: `offered/target ${r.toFixed(5)} against [${PACE_BAND.low}, ${PACE_BAND.high}]`,
		});
		results.push({
			id: `V-N/${dir}`,
			fired: facts.negativeSamples[dir] > 0,
			detail: `${facts.negativeSamples[dir]} negative one-way samples of ${facts.oneWaySamples[dir]} on a single clock`,
		});
	}

	// An unmeasured reading is not a passing reading. `median()` returns null
	// when no sample survived — a cell shorter than two sample intervals, or one
	// killed early, produces exactly that — and `NaN > bar` is false, so the
	// unmeasured case used to read as "comfortably under the bar".
	const hostCpuMeasured = Number.isFinite(facts.hostCpuMedianPctOfBox);
	results.push({
		id: "V-S",
		fired:
			!hostCpuMeasured || facts.hostCpuMedianPctOfBox > HOST_CPU_BAR_PCT_OF_BOX,
		detail: hostCpuMeasured
			? `host CPU median ${facts.hostCpuMedianPctOfBox}% of box against a ${HOST_CPU_BAR_PCT_OF_BOX}% bar`
			: `host CPU was not measured (no sample survived the cell); the ${HOST_CPU_BAR_PCT_OF_BOX}% bar cannot be cleared by an absent reading`,
	});

	const offeredShort = DIRECTIONS.some(
		(dir) => ratio(facts.offeredBytes[dir], targetBytesPerDirection) < 1,
	);
	// Same rule as V-S: an absent client-CPU reading is un-evaluable, not clear.
	// The harness used to substitute 0 for a missing sample, which is the idlest
	// possible client and can never reach a ceiling.
	const clientCpuMeasured = Number.isFinite(facts.clientCpuPctOfOneCore);
	results.push({
		id: "V-S2",
		fired:
			!clientCpuMeasured ||
			(offeredShort &&
				facts.clientCpuPctOfOneCore >= facts.clientCpuCeilingPctOfOneCore),
		detail: clientCpuMeasured
			? `client CPU ${facts.clientCpuPctOfOneCore}% against its ${facts.clientCpuCeilingPctOfOneCore}% ceiling while offered < target`
			: `client CPU was not measured; its ${facts.clientCpuCeilingPctOfOneCore}% ceiling cannot be cleared by an absent reading`,
	});

	const agreement = ratio(
		facts.crossings.server.dataCrossings,
		facts.harnessServerReadCrossings,
	);
	// V-C is imported from G5b to catch a *disagreeing* instrument, so it has to
	// catch a silent one too: with a zero denominator `agreement` is NaN and
	// `Math.abs(NaN - 1) > tol` is false, which left the falsifier quiet in the
	// one case where a layer produced nothing at all.
	const bothCounted =
		Number.isFinite(agreement) &&
		facts.harnessServerReadCrossings > 0 &&
		facts.crossings.server.dataCrossings > 0;
	results.push({
		id: "V-C",
		fired:
			!bothCounted || Math.abs(agreement - 1) > CROSSING_AGREEMENT_TOLERANCE,
		detail: bothCounted
			? `package dataCrossings ${facts.crossings.server.dataCrossings} vs harness reads ${facts.harnessServerReadCrossings} (${pct(agreement - 1)} apart, tolerance ${pct(CROSSING_AGREEMENT_TOLERANCE)})`
			: `instrument produced no crossings: package dataCrossings ${facts.crossings.server.dataCrossings}, harness reads ${facts.harnessServerReadCrossings} — the layers cannot be compared`,
	});

	results.push({
		id: "V-K",
		fired: !knobProvenanceHolds(facts),
		detail: knobProvenanceDetail(facts),
	});

	results.push({
		id: "V-L",
		fired: facts.rateLimitedCount > 0 || facts.limitExceededCount > 0,
		detail: `rateLimited ${facts.rateLimitedCount}, limitExceeded ${facts.limitExceededCount}`,
	});

	results.push({
		id: "V-W",
		fired: facts.deadlineBreached,
		detail: facts.deadlineBreached
			? "deadline breached: the generator was killed mid-cell, so this window is truncated and every counter under it is partial"
			: "generator exited inside its pre-registered deadline",
	});

	results.push({
		id: "V-D",
		fired: !facts.settled,
		detail: facts.settled
			? "settle barrier quiesced before counters were read"
			: "drain-unsettled: counters read while the server was still receiving",
	});

	results.push({
		id: "V-B",
		fired: facts.serverSocketDrops === null,
		detail:
			facts.serverSocketDrops === null
				? "server socket drop tap was not read; an unread tap is not a zero"
				: `server socket drops ${facts.serverSocketDrops}`,
	});

	return results;
}

/**
 * §4 V-K. A knob-off cell must show no batched crossings and a maximum batch of
 * one QUIC stream frame; the knob cell must have batched every data crossing.
 * G5b's exact discrimination, applied to both ends because this gate is the
 * first to read the client end at all.
 */
export function knobProvenanceHolds(facts: TunnelCellFacts): boolean {
	const ends = [facts.crossings.server, facts.crossings.client].filter(
		(end): end is CrossingFacts => end !== null,
	);
	if (facts.knobBytes === 0) {
		return ends.every(
			(end) => end.batchedCrossings === 0 && end.maxBatchBytes <= FRAME_BYTES,
		);
	}
	return ends.every(
		(end) =>
			end.dataCrossings > 0 && end.batchedCrossings === end.dataCrossings,
	);
}

function knobProvenanceDetail(facts: TunnelCellFacts): string {
	const fmt = (name: string, end: CrossingFacts | null) =>
		end === null
			? `${name}: no addon on this end (Amendment 3), nothing to grade`
			: `${name}: data ${end.dataCrossings}, batched ${end.batchedCrossings}, max ${end.maxBatchBytes} B`;
	return `knob ${facts.knobBytes} B — ${fmt("server", facts.crossings.server)}; ${fmt("client", facts.crossings.client)}`;
}

// --- Gate clauses (§5) ------------------------------------------------------

export function clausesForTunnelCell(facts: TunnelCellFacts): ClauseResult[] {
	const rung = tunnelRung(facts.sessions);
	const targetBytesPerDirection =
		rung.bytesPerSecPerDirectionPerTunnel * facts.sessions * facts.windowSec;
	const perSessionTarget =
		rung.bytesPerSecPerDirectionPerTunnel * facts.windowSec;
	const bound = oneWayBoundMs();
	const out: ClauseResult[] = [];

	// C1 / C2 — offered rate, per direction.
	const clauseIds: Record<Direction, string> = { up: "C1", down: "C2" };
	for (const dir of DIRECTIONS) {
		const r = ratio(facts.offeredBytes[dir], targetBytesPerDirection);
		out.push({
			id: clauseIds[dir],
			pass: r >= PACE_BAND.low && r <= PACE_BAND.high,
			detail: `${dir} offered ${(facts.offeredBytes[dir] / facts.windowSec / 125_000).toFixed(3)} Mbps, ratio ${r.toFixed(5)}`,
		});
	}

	// C3 — reliable streams: the accounting closes exactly, both directions.
	const c3 = DIRECTIONS.every(
		(dir) => facts.deliveredBytes[dir] === facts.writtenBytes[dir],
	);
	out.push({
		id: "C3",
		pass: c3,
		detail: DIRECTIONS.map(
			(dir) =>
				`${dir} delivered ${facts.deliveredBytes[dir]} vs written ${facts.writtenBytes[dir]}`,
		).join("; "),
	});

	// C4 — drain completeness. K17 makes this the clause most worth stating.
	const c4 =
		facts.streamErrors === 0 &&
		facts.streamResets === 0 &&
		facts.backpressureTimeouts === 0 &&
		facts.streamsClosedBothHalves === facts.sessions;
	out.push({
		id: "C4",
		pass: c4,
		detail: `errors ${facts.streamErrors}, resets ${facts.streamResets}, backpressure timeouts ${facts.backpressureTimeouts}, streams closed both halves ${facts.streamsClosedBothHalves}/${facts.sessions}`,
	});

	// C5 — per-session fairness, each direction.
	const fairness = DIRECTIONS.map((dir) => {
		const values = facts.perSessionDeliveredBytes[dir];
		const s = spread(values);
		const minShare =
			values.length > 0 ? Math.min(...values) / perSessionTarget : 0;
		return { dir, s, minShare, count: values.length };
	});
	const c5 = fairness.every(
		(f) =>
			f.count === facts.sessions &&
			f.s <= FAIRNESS_SPREAD_BAR &&
			f.minShare >= FAIRNESS_MIN_SHARE,
	);
	out.push({
		id: "C5",
		pass: c5,
		detail: fairness
			.map(
				(f) =>
					`${f.dir} spread ${f.s.toFixed(4)} (bar ${FAIRNESS_SPREAD_BAR}), min share ${f.minShare.toFixed(4)} (bar ${FAIRNESS_MIN_SHARE}), ${f.count}/${facts.sessions} sessions`,
			)
			.join("; "),
	});

	// C6 / C7 — one-way p99, raw, per direction.
	const latencyIds: Record<Direction, string> = { up: "C6", down: "C7" };
	for (const dir of DIRECTIONS) {
		out.push({
			id: latencyIds[dir],
			pass: facts.oneWaySamples[dir] > 0 && facts.oneWayP99Ms[dir] <= bound,
			detail: `${dir} one-way p99 ${facts.oneWayP99Ms[dir]} ms (raw) against ${bound} ms, ${facts.oneWaySamples[dir]} samples, floor p99 ${facts.floor.schedulerLagP99Ms} ms reported beside it`,
		});
	}

	// C8 — memory statement.
	const advertised = advertisedPerSessionBytes(facts.maxQueuedBytesPerSession);
	const c8 =
		facts.maxQueuedBytesPerSession <= SHIPPED_QUEUED_BYTES_PER_SESSION &&
		facts.maxQueuedBytesGlobal <= SHIPPED_QUEUED_BYTES_GLOBAL;
	out.push({
		id: "C8",
		pass: c8,
		detail: `per-session governor ${facts.maxQueuedBytesPerSession} B, global ${facts.maxQueuedBytesGlobal} B, advertised worst case ${advertised} B/session, peak RSS ${facts.serverRssMb} MB`,
	});

	// C9 — the crossing disclosure. Graded on nothing, by construction.
	out.push({
		id: "C9",
		pass: true,
		detail: `DISCLOSURE ONLY (graded on nothing): server ${meanBytesPerCrossing(facts.crossings.server).toFixed(1)} B/crossing, client ${facts.crossings.client === null ? "no addon on this end (Amendment 3)" : `${meanBytesPerCrossing(facts.crossings.client).toFixed(1)} B/crossing`} at knob ${facts.knobBytes} B`,
	});

	return out;
}

export function meanBytesPerCrossing(end: CrossingFacts): number {
	if (end.dataCrossings === 0) return 0;
	return end.bytes / end.dataCrossings;
}

// --- Roll-up ----------------------------------------------------------------

export type TunnelRollUp = {
	verdict: Verdict;
	reason: string;
	clauses: Record<string, ClauseResult[]>;
	falsifiers: Record<string, FalsifierResult[]>;
};

/**
 * The gate is PASS only if every clause passes on every gate-cell repeat and no
 * falsifier fired. A fired falsifier makes the cell INVALID — never a miss, and
 * never a pass, no matter how many clauses computed PASS underneath it. That
 * ordering is the whole lesson of G3b's stamp and it is tested directly.
 *
 * V-S is the one falsifier that produces INCOMPLETE rather than INVALID: a
 * saturated host did not measure the product wrongly, it measured a rig that
 * had nothing left to give, and a saturated rung is not a capacity number.
 */
export function rollUpTunnelGate(
	gateCellRepeats: readonly TunnelCellFacts[],
): TunnelRollUp {
	const clauses: Record<string, ClauseResult[]> = {};
	const falsifiers: Record<string, FalsifierResult[]> = {};

	if (gateCellRepeats.length === 0) {
		return {
			verdict: "INCOMPLETE",
			reason: "no gate-cell repeats were produced",
			clauses,
			falsifiers,
		};
	}

	for (const facts of gateCellRepeats) {
		const key = `${facts.cell}#${facts.repeat}`;
		clauses[key] = clausesForTunnelCell(facts);
		falsifiers[key] = falsifiersForTunnelCell(facts);
	}

	const firedSaturation = Object.entries(falsifiers).flatMap(([key, list]) =>
		list
			.filter((f) => f.fired && (f.id === "V-S" || f.id === "V-S2"))
			.map((f) => `${key} ${f.id}: ${f.detail}`),
	);
	const firedOther = Object.entries(falsifiers).flatMap(([key, list]) =>
		list
			.filter((f) => f.fired && f.id !== "V-S" && f.id !== "V-S2")
			.map((f) => `${key} ${f.id}: ${f.detail}`),
	);

	if (firedOther.length > 0) {
		return {
			verdict: "INVALID",
			reason: `validity falsifier fired: ${firedOther.join(" | ")}`,
			clauses,
			falsifiers,
		};
	}
	if (firedSaturation.length > 0) {
		return {
			verdict: "INCOMPLETE",
			reason: `saturation STOP: ${firedSaturation.join(" | ")}`,
			clauses,
			falsifiers,
		};
	}

	const failed = Object.entries(clauses).flatMap(([key, list]) =>
		list.filter((c) => !c.pass).map((c) => `${key} ${c.id}: ${c.detail}`),
	);
	if (failed.length > 0) {
		return {
			verdict: "MISS",
			reason: `clause failed: ${failed.join(" | ")}`,
			clauses,
			falsifiers,
		};
	}

	return {
		verdict: "PASS",
		reason: `every clause passed on ${gateCellRepeats.length} repeat(s) with no falsifier fired`,
		clauses,
		falsifiers,
	};
}

// --- Arm X: the acceptance path ---------------------------------------------

export type ExchangeCellFacts = {
	cell: string;
	sessions: number;
	windowSec: number;
	runId: string;
	host: string;
	attemptedExchanges: number;
	completedExchanges: number;
	/** Counted at the SERVER, on the server's own clock. */
	serverAcceptedStreams: number;
	/** Counted at the client; recorded, and never used as the accept rate. */
	clientOpenedStreams: number;
	peakConcurrentBidiPerSession: number;
	exchangeRttP99Ms: number;
	rttSamples: number;
	negativeSamples: number;
	floor: FloorReport;
	hostCpuMedianPctOfBox: number;
	rateLimitedCount: number;
	limitExceededCount: number;
	settled: boolean;
	/** See `TunnelCellFacts.deadlineBreached`. */
	deadlineBreached: boolean;
};

export const EXCHANGE_COMPLETION_BAR = 0.999;

export function falsifiersForExchangeCell(
	facts: ExchangeCellFacts,
): FalsifierResult[] {
	return [
		{
			id: "V-G2",
			fired: !floorReportIsUsable(facts.floor, facts),
			detail: `floor run=${facts.floor.runId}/host=${facts.floor.host}/driving=${facts.floor.drivingSessions}`,
		},
		{
			id: "V-G",
			fired: facts.floor.schedulerLagP99Ms > SCHEDULER_LAG_P99_BAR_MS,
			detail: `client scheduler-lag p99 ${facts.floor.schedulerLagP99Ms} ms against ${SCHEDULER_LAG_P99_BAR_MS} ms`,
		},
		{
			id: "V-A",
			fired: facts.serverAcceptedStreams !== facts.clientOpenedStreams,
			detail: `server-observed accepts ${facts.serverAcceptedStreams} vs client-observed opens ${facts.clientOpenedStreams}`,
		},
		{
			id: "V-X2",
			fired:
				facts.peakConcurrentBidiPerSession >=
				SHIPPED_MAX_STREAMS_PER_SESSION_BIDI,
			detail: `peak concurrent bidi/session ${facts.peakConcurrentBidiPerSession} against the shipped cap ${SHIPPED_MAX_STREAMS_PER_SESSION_BIDI}`,
		},
		{
			id: "V-N",
			fired: facts.negativeSamples > 0,
			detail: `${facts.negativeSamples} negative RTT samples of ${facts.rttSamples}`,
		},
		{
			// Arm X's copy of the tunnel V-S, and of its NaN blindness: the same
			// `hostCpuMedianPct ?? NaN` reaches both, and an unmeasured host must
			// not clear the bar here either.
			id: "V-S",
			fired:
				!Number.isFinite(facts.hostCpuMedianPctOfBox) ||
				facts.hostCpuMedianPctOfBox > HOST_CPU_BAR_PCT_OF_BOX,
			detail: Number.isFinite(facts.hostCpuMedianPctOfBox)
				? `host CPU median ${facts.hostCpuMedianPctOfBox}%`
				: "host CPU was not measured; an absent reading cannot clear the bar",
		},
		{
			id: "V-L",
			fired: facts.rateLimitedCount > 0 || facts.limitExceededCount > 0,
			detail: `rateLimited ${facts.rateLimitedCount}, limitExceeded ${facts.limitExceededCount}`,
		},
		{
			id: "V-W",
			fired: facts.deadlineBreached,
			detail: facts.deadlineBreached
				? "deadline breached: the generator was killed mid-cell, so this window is truncated"
				: "generator exited inside its pre-registered deadline",
		},
		{
			id: "V-D",
			fired: !facts.settled,
			detail: facts.settled ? "quiesced" : "drain-unsettled",
		},
	];
}

export function clausesForExchangeCell(
	facts: ExchangeCellFacts,
): ClauseResult[] {
	const completion = ratio(facts.completedExchanges, facts.attemptedExchanges);
	const bound = exchangeRttBoundMs();
	return [
		{
			id: "X1",
			pass: completion >= EXCHANGE_COMPLETION_BAR,
			detail: `completed ${facts.completedExchanges}/${facts.attemptedExchanges} = ${completion.toFixed(5)} against ${EXCHANGE_COMPLETION_BAR}`,
		},
		{
			id: "X2",
			pass: facts.rttSamples > 0 && facts.exchangeRttP99Ms <= bound,
			detail: `exchange RTT p99 ${facts.exchangeRttP99Ms} ms (raw) against ${bound} ms, ${facts.rttSamples} samples, floor p99 ${facts.floor.schedulerLagP99Ms} ms`,
		},
		{
			id: "X3",
			pass:
				facts.serverAcceptedStreams >=
				facts.attemptedExchanges * EXCHANGE_COMPLETION_BAR,
			detail: `server-side accepts ${facts.serverAcceptedStreams} against ${facts.attemptedExchanges} attempted opens — measured at the server, never inferred from client pacing`,
		},
	];
}

export function rollUpExchangeArm(facts: ExchangeCellFacts): TunnelRollUp {
	const key = facts.cell;
	const cellClauses = clausesForExchangeCell(facts);
	const cellFalsifiers = falsifiersForExchangeCell(facts);
	const clauses = { [key]: cellClauses };
	const falsifiers = { [key]: cellFalsifiers };
	const fired = cellFalsifiers.filter((f) => f.fired);
	const saturation = fired.filter((f) => f.id === "V-S");
	const other = fired.filter((f) => f.id !== "V-S");
	if (other.length > 0) {
		return {
			verdict: "INVALID",
			reason: other.map((f) => `${f.id}: ${f.detail}`).join(" | "),
			clauses,
			falsifiers,
		};
	}
	if (saturation.length > 0) {
		return {
			verdict: "INCOMPLETE",
			reason: saturation.map((f) => `${f.id}: ${f.detail}`).join(" | "),
			clauses,
			falsifiers,
		};
	}
	const failed = cellClauses.filter((c) => !c.pass);
	return failed.length > 0
		? {
				verdict: "MISS",
				reason: failed.map((c) => `${c.id}: ${c.detail}`).join(" | "),
				clauses,
				falsifiers,
			}
		: { verdict: "PASS", reason: "all clauses passed", clauses, falsifiers };
}

// --- Arm D: the cross-direction budget probe (mechanism arm, no verdict) ----

/**
 * Which end of the bidi stream holds the slow reader. Amendment 2: the two ends
 * read through different native paths — the server-accepted handle reads
 * deferred-direct (transient reservation), the client-opened handle reads
 * through a read-ahead bridge that holds its reservation until JS consumes —
 * so a probe that does not separate them measures the wrong path and reports
 * "no coupling" as if it were general.
 */
export type StreamEnd = "client-opened" | "server-accepted";

export type CouplingCellFacts = {
	cell: string;
	end: StreamEnd;
	backlogFraction: number;
	downstreamWriteP99Ms: number;
	backpressureTimeouts: number;
	streamErrors: number;
	peakSessionQueuedBytes: number;
	/** See `TunnelCellFacts.deadlineBreached`. Arm D drops such a cell. */
	deadlineBreached: boolean;
};

export type CouplingReading = {
	/** Never a gate verdict — Arm D grades nothing. */
	reading: "COUPLING-OBSERVED" | "COUPLING-REFUTED" | "INDETERMINATE";
	detail: string;
};

export type CouplingArmReading = {
	perEnd: Record<StreamEnd, CouplingReading>;
	/**
	 * The registered reading of the pair. `PATH-ASYMMETRY-HELD` is D-P1′;
	 * `COUPLING-ABSENT` is D-F1′'s first branch; `PATH-ASYMMETRY-REFUTED` is its
	 * second — the more interesting refutation of the two, per §2.
	 */
	verdictFreeReading:
		| "PATH-ASYMMETRY-HELD"
		| "PATH-ASYMMETRY-REFUTED"
		| "COUPLING-ABSENT"
		| "COUPLING-BOTH-ENDS"
		| "INDETERMINATE";
	detail: string;
};

/**
 * D-P1′ vs D-F1′ for one end, both registered in §2 and Amendment 2 before the
 * run: downstream write latency rising with inbound backlog, or a
 * E_BACKPRESSURE_TIMEOUT at the top fraction, reads as coupling; flat latency
 * with no timeout refutes it for that end.
 */
export function readCouplingEnd(
	cells: readonly CouplingCellFacts[],
): CouplingReading {
	// A breached cell is a truncated window, and Arm D reads a *pair* of cells
	// against each other: silently dropping one would compare a full window with
	// a partial one and call the difference coupling. The end reads
	// INDETERMINATE instead.
	const breached = cells.filter((c) => c.deadlineBreached);
	if (breached.length > 0) {
		return {
			reading: "INDETERMINATE",
			detail: `deadline breached on ${breached.map((c) => c.cell).join(", ")}; a truncated cell is not a control and not a load point`,
		};
	}
	const control = cells.find((c) => c.backlogFraction === 0);
	const top = cells.reduce<CouplingCellFacts | undefined>(
		(best, c) =>
			best === undefined || c.backlogFraction > best.backlogFraction ? c : best,
		undefined,
	);
	if (!control || !top || control === top) {
		return {
			reading: "INDETERMINATE",
			detail:
				"Arm D needs a control cell at fraction 0 and at least one loaded cell",
		};
	}
	if (control.downstreamWriteP99Ms <= 0) {
		return {
			reading: "INDETERMINATE",
			detail: "control cell reported no downstream write latency",
		};
	}
	const spreadRatio = top.downstreamWriteP99Ms / control.downstreamWriteP99Ms;
	const timedOut = top.backpressureTimeouts > 0;
	const detail = `control p99 ${control.downstreamWriteP99Ms} ms vs f=${top.backlogFraction} p99 ${top.downstreamWriteP99Ms} ms (${spreadRatio.toFixed(2)}x), backpressure timeouts at top ${top.backpressureTimeouts}, peak session queued ${top.peakSessionQueuedBytes} B`;
	if (timedOut || spreadRatio >= COUPLING_REFUTED_SPREAD) {
		return { reading: "COUPLING-OBSERVED", detail };
	}
	return { reading: "COUPLING-REFUTED", detail };
}

/**
 * The pair reading. D-P1′ predicts coupling on the client-opened end and none
 * on the server-accepted end; every other combination is named here so that the
 * outcome the run produces is one this document already anticipated, rather
 * than one it interprets afterwards.
 */
export function readCouplingArm(
	cells: readonly CouplingCellFacts[],
): CouplingArmReading {
	const perEnd: Record<StreamEnd, CouplingReading> = {
		"client-opened": readCouplingEnd(
			cells.filter((c) => c.end === "client-opened"),
		),
		"server-accepted": readCouplingEnd(
			cells.filter((c) => c.end === "server-accepted"),
		),
	};
	const client = perEnd["client-opened"].reading;
	const server = perEnd["server-accepted"].reading;
	const detail = `client-opened: ${perEnd["client-opened"].detail} || server-accepted: ${perEnd["server-accepted"].detail}`;

	if (client === "INDETERMINATE" || server === "INDETERMINATE") {
		return { perEnd, verdictFreeReading: "INDETERMINATE", detail };
	}
	if (client === "COUPLING-OBSERVED" && server === "COUPLING-REFUTED") {
		return { perEnd, verdictFreeReading: "PATH-ASYMMETRY-HELD", detail };
	}
	if (client === "COUPLING-REFUTED" && server === "COUPLING-OBSERVED") {
		return { perEnd, verdictFreeReading: "PATH-ASYMMETRY-REFUTED", detail };
	}
	if (client === "COUPLING-OBSERVED" && server === "COUPLING-OBSERVED") {
		return { perEnd, verdictFreeReading: "COUPLING-BOTH-ENDS", detail };
	}
	return { perEnd, verdictFreeReading: "COUPLING-ABSENT", detail };
}
