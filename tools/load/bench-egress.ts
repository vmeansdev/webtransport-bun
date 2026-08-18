#!/usr/bin/env bun
/**
 * Egress ladder — the Bun server originates, the Rust load client receives.
 *
 * Every throughput number this repo owns is ingest; every scenario that matters
 * is egress. This driver reverses the direction of the latency axis: the server
 * schedules datagrams per subscriber session, stamps each one with the same
 * 28-byte header `docs/research/preregistrations/latency.md` fixed, and the load
 * client differences that stamp against its own `CLOCK_MONOTONIC` read. Both
 * processes read one system-wide counter, so the one-way number is real rather
 * than a halved round trip.
 *
 * Three shapes, selected by `EGRESS_SHAPE`:
 *
 *   `headroom` — the saturation control, on a loaded server. The transport
 *                carries the ladder's top rung while the same scheduler on the
 *                same thread additionally drives shadow sessions into a counting
 *                sink. Answers "could the JS originator have offered more than
 *                the ladder asked, *here*?" before any transport number is
 *                allowed to mean anything.
 *   `ladder`   — N subscriber sessions, one burst profile, a rate ladder.
 *   `fanout`   — a publisher *process*, the server forwarding verbatim, and N
 *                subscriber sessions in a *separate* process. The publisher's
 *                own stamp survives the fan-out, so this shape has no server
 *                clock in its path at all. Two registered sweeps decouple N
 *                from rate, and two registered falsifiers — ingest-reality and
 *                the sink-saturation pre-check — must clear before any step of
 *                it carries a number. Amendment 8 replaced the retracted
 *                original wholesale; nothing from it is reused.
 *
 * Method, gates, buckets and STOP conditions are pre-registered in
 * `docs/research/preregistrations/egress.md`. This file implements that
 * document; it does not get to reinterpret it.
 *
 * Single-host caveat, and it is a real one: the receiver shares the 4 vCPU with
 * the originator, so every percentile here is an *upper bound* on server egress
 * latency. On-box is still the right choice — it is the only configuration where
 * the two ends share a clock, and the off-box path is known-lossy.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	datagramsPerTick,
	type FanoutMode,
	forwardShortfall,
	type IngestRealityVerdict,
	ingestRealityVerdict,
	isFanoutMode,
	publisherRateFor,
	publisherShortfall,
	SINK_HEADROOM_FACTOR,
	type SinkPrecheckOutcome,
	sinkPrecheckVerdict,
} from "./egress-fanout.ts";
import {
	amplitudeAt,
	type EgressPlan,
	type EgressProfile,
	eventsForSeconds,
	isEgressProfile,
	peakWindowDatagrams,
	phaseNsFor,
	planFor,
	scheduledDatagrams,
} from "./egress-schedule.ts";
import { createMonotonicClock } from "./latency-clock.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";
import {
	decodeStamp,
	OFFSET_ACTUAL,
	OFFSET_INTENDED,
	OFFSET_MAGIC,
	OFFSET_SEQUENCE,
	OFFSET_VERSION,
	STAMP_BYTES,
	STAMP_MAGIC,
	STAMP_VERSION,
} from "./latency-stamp.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;

export type EgressShape = "ladder" | "fanout" | "headroom";

const RAW_PROFILE = process.env.EGRESS_PROFILE ?? "constant";
if (!isEgressProfile(RAW_PROFILE)) {
	throw new Error(`EGRESS_PROFILE=${RAW_PROFILE} is not a registered profile`);
}
const PROFILE: EgressProfile = RAW_PROFILE;
const SHAPE = (process.env.EGRESS_SHAPE ?? "ladder") as EgressShape;
const SESSIONS = parseInt(process.env.EGRESS_SESSIONS ?? "100", 10);
const PAYLOAD_BYTES = parseInt(process.env.EGRESS_PAYLOAD_BYTES ?? "1150", 10);
const STEP_SECONDS = parseInt(process.env.EGRESS_STEP_SECONDS ?? "45", 10);
const SETTLE_MS = parseInt(process.env.EGRESS_SETTLE_MS ?? "10000", 10);
const PORT = parseInt(process.env.EGRESS_PORT ?? "4433", 10);
/** Per-session datagrams/s. 326 ≈ 3 Mbps at 1150 B. */
const RATES = (process.env.EGRESS_RATES ?? "110,220,326,490,652,815")
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
/** Subscriber counts for the fan-out shape. */
const FANOUT_N = (process.env.EGRESS_FANOUT_N ?? "10,25,50,100")
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
/** Publisher rate for the `per-subscriber` sweep: 11 datagrams a frame at 30 fps. */
const FANOUT_PUBLISH_RATE = parseInt(
	process.env.EGRESS_FANOUT_PUBLISH_RATE ?? "330",
	10,
);
/**
 * Which of the two registered sweeps to run (amendment 8). `per-subscriber`
 * holds each subscriber's rate while N grows; `constant-aggregate` pins the
 * aggregate forward load at `EGRESS_FANOUT_AGGREGATE` and divides it across N.
 * Neither alone licenses an N claim — an effect in the first and not the second
 * is a rate effect, and that comparison is the whole point of running both.
 */
const RAW_FANOUT_MODE = process.env.EGRESS_FANOUT_MODE ?? "per-subscriber";
if (!isFanoutMode(RAW_FANOUT_MODE)) {
	throw new Error(
		`EGRESS_FANOUT_MODE=${RAW_FANOUT_MODE} is not a registered sweep`,
	);
}
const FANOUT_MODE: FanoutMode = RAW_FANOUT_MODE;
/** Aggregate forward egress the `constant-aggregate` sweep pins: 330 × 50. */
const FANOUT_AGGREGATE = parseInt(
	process.env.EGRESS_FANOUT_AGGREGATE ?? "16500",
	10,
);
/** The publisher's frame grid. 30 fps, the cadence the reality check looks for. */
const FANOUT_TICK_HZ = parseInt(process.env.EGRESS_FANOUT_TICK_HZ ?? "30", 10);
/** Seconds of the sink-saturation pre-check that gates every fan-out N. */
const FANOUT_PRECHECK_SECONDS = parseInt(
	process.env.EGRESS_FANOUT_PRECHECK_SECONDS ?? "20",
	10,
);
/**
 * Shadow-arm multipliers the loaded-server headroom arm escalates through
 * (amendment 1). At multiplier `m` the originator is asked for `1 + m` times the
 * top ladder rung: the real sessions through the transport, plus `m × sessions`
 * sink sessions. `0.5` is the lowest rung on purpose — it is exactly the 1.5×
 * the run-level STOP demands, so clearing that STOP is never free.
 */
const HEADROOM_MULTIPLIERS = (
	process.env.EGRESS_HEADROOM_MULTIPLIERS ?? "0.5,1,2,4"
)
	.split(",")
	.map((v) => Number.parseFloat(v.trim()))
	.filter((v) => Number.isFinite(v) && v > 0);
const HEADROOM_SECONDS = parseInt(
	process.env.EGRESS_HEADROOM_SECONDS ?? "20",
	10,
);
/** Per-session rate the headroom arm loads the transport at: the ladder's top rung. */
const HEADROOM_RATE = parseInt(
	process.env.EGRESS_HEADROOM_RATE ?? String(Math.max(...RATES)),
	10,
);
/** The pre-registered origination-lag bound for a passing headroom rung. */
const HEADROOM_LAG_BOUND_NS = 5e6;
/** The pre-registered emitted fraction for a passing headroom rung. */
const HEADROOM_EMITTED_FRACTION = 0.95;
/** Seconds allowed for every subscriber session to hand shake before a step starts. */
const CONNECT_BUDGET_S = parseInt(process.env.EGRESS_CONNECT_BUDGET ?? "8", 10);
/** Seconds allowed for the previous step's sessions to close before the next one. */
const DRAIN_BUDGET_S = parseInt(process.env.EGRESS_DRAIN_BUDGET ?? "15", 10);
/**
 * Slack on the client's `--duration` past what the driver needs.
 *
 * The client counts its duration from process start, the driver starts its
 * clock once the sessions are up. Without slack a step that spends its whole
 * connect budget has the receiver exiting on the same instant the originator
 * stops, and the tail of the step is measured against a client that is already
 * tearing down.
 */
const CLIENT_DURATION_SLACK_S = parseInt(
	process.env.EGRESS_CLIENT_SLACK ?? "10",
	10,
);
const OUT_JSON =
	process.env.EGRESS_OUT ??
	join(
		ROOT,
		SHAPE === "fanout"
			? // The two sweeps are separate measurements and must not land on one
				// filename, or running both leaves only the second one.
				`tools/load/bench-egress-fanout-${FANOUT_MODE}.json`
			: `tools/load/bench-egress-${SHAPE}-${PROFILE}.json`,
	);

const HAS_PROC = process.platform === "linux";
/** Cores the box has. The CPU unit below is per-core, so this is the scale. */
const HOST_CPU_COUNT = cpus().length;

function serverCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

type CpuSnapshot = { busy: number; total: number };

function readHostCpu(): CpuSnapshot | null {
	if (!HAS_PROC) return null;
	const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
	const fields = line.trim().split(/\s+/).slice(1).map(Number);
	const total = fields.reduce((a, b) => a + b, 0);
	const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
	return { busy: total - idle, total };
}

/**
 * Host CPU as **percent of one core**, the unit the effort spec binds every axis
 * to — a 4 vCPU box reads up to 400, and this number is directly comparable to
 * the `serverCpuPct` reported beside it. `/proc/stat`'s aggregate is
 * percent-of-the-whole-box, so it is scaled by the core count, which the
 * artifact also records so the scale is never inferred.
 */
function hostCpuPct(prev: CpuSnapshot | null, next: CpuSnapshot | null) {
	if (!prev || !next || next.total === prev.total) return null;
	const ofBox = (next.busy - prev.busy) / (next.total - prev.total);
	return ofBox * 100 * HOST_CPU_COUNT;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

/**
 * A per-session payload buffer with its stamp fields written in place.
 *
 * `sendDatagram` does `Buffer.from(data)` synchronously before it awaits
 * anything, so one buffer per session is safe and the originator does not spend
 * the ladder allocating. Fields are written through a retained DataView rather
 * than `encodeStamp` so the hot path allocates nothing at all — the layout still
 * comes from `latency-stamp.ts`, so there is one source of truth for it.
 */
class StampedPayload {
	readonly bytes: Uint8Array;
	private readonly view: DataView;

	constructor(byteLength: number) {
		if (byteLength < STAMP_BYTES) {
			throw new Error(`payload must be at least ${STAMP_BYTES} bytes`);
		}
		this.bytes = new Uint8Array(byteLength).fill(0x78 /* 'x' */);
		this.view = new DataView(this.bytes.buffer);
		this.view.setUint16(OFFSET_MAGIC, STAMP_MAGIC, true);
		this.view.setUint16(OFFSET_VERSION, STAMP_VERSION, true);
	}

	stamp(intendedNs: number, actualNs: number, sequence: number): void {
		writeU64(this.view, OFFSET_INTENDED, intendedNs);
		writeU64(this.view, OFFSET_ACTUAL, actualNs);
		writeU64(this.view, OFFSET_SEQUENCE, sequence);
	}
}

function writeU64(view: DataView, offset: number, value: number): void {
	const low = value % 4294967296;
	view.setUint32(offset, low, true);
	view.setUint32(offset + 4, (value - low) / 4294967296, true);
}

export type OriginatorStats = {
	sent: number;
	sendErrors: number;
	/** Every grid event the plan put inside the step — run *and* skipped. */
	sendEventsScheduled: number;
	sendEventsSkipped: number;
	scheduledDatagrams: number;
	/** intended send → actual send, first datagram of each send event. */
	originationLag: LatencyHistogramJson;
	/** first to last datagram inside one send event. */
	sendIssueSpread: LatencyHistogramJson;
	gridPeriodNs: number;
	peakWindowDatagrams: number;
	/**
	 * The interval the originator was actually driving, on the shared monotonic
	 * clock. Every rate divides by this and never by a wall clock that also
	 * contains the CPU sampler, the client's exit or a process spawn.
	 */
	driveWindowSec: number;
};

type SendFn = (bytes: Uint8Array) => Promise<unknown>;

/**
 * The falsifier for the headroom arm: a synthetic per-datagram cost in the
 * originator, so a deliberately starved generator can be shown to trip the STOP
 * that exists to catch one. Any artifact carrying a non-zero burn is marked
 * `harness-falsifier` by the classifier and can never carry a capacity number.
 */
const HEADROOM_BURN_NS = parseInt(
	process.env.EGRESS_HEADROOM_BURN_NS ?? "0",
	10,
);

function burn(clock: { now(): number }, ns: number): void {
	if (ns <= 0) return;
	const end = clock.now() + ns;
	while (clock.now() < end) {
		// deliberate busy-wait
	}
}

/**
 * Drive one burst profile against a set of send functions for `seconds`.
 *
 * One loop per session, each on its own phase offset — the shape the
 * pre-registration describes. Every grid period is ≥ 5 ms, an order of magnitude
 * above the ~1 ms timer granularity, so the loop cannot become a measurement of
 * `setTimeout`. Missed deadlines are skipped rather than caught up, the way the
 * Rust load client's schedule does, so a backlogged originator cannot run away
 * and reshape the offered load; the skip count is what the
 * `generator-saturation` STOP reads.
 */
async function driveProfile(
	plan: EgressPlan,
	sends: SendFn[],
	seconds: number,
	clock: { now(): number },
	burnNs = 0,
): Promise<OriginatorStats> {
	const sessions = sends.length;
	const originationLag = new LatencyHistogram();
	const sendIssueSpread = new LatencyHistogram();
	let sent = 0;
	let sendErrors = 0;
	let eventsRun = 0;
	let eventsSkipped = 0;

	const anchorNs = clock.now() + 50_000_000; // 50 ms so every loop starts armed
	const endNs = anchorNs + seconds * 1e9;
	const events = eventsForSeconds(plan, seconds);

	const runSession = async (index: number): Promise<void> => {
		const send = sends[index];
		if (!send) return;
		const payload = new StampedPayload(PAYLOAD_BYTES);
		const phaseNs = phaseNsFor(plan, index, sessions);
		const base = anchorNs + phaseNs;
		let eventIndex = 0;
		let sequence = 0;

		while (true) {
			const intendedNs = base + eventIndex * plan.gridPeriodNs;
			if (intendedNs >= endNs) break;
			const waitMs = (intendedNs - clock.now()) / 1e6;
			if (waitMs > 0) await Bun.sleep(waitMs);

			// Skip whole events we are already past, then send the current one.
			const behind = Math.floor((clock.now() - intendedNs) / plan.gridPeriodNs);
			if (behind > 0) {
				eventsSkipped += behind;
				eventIndex += behind;
				const shifted = base + eventIndex * plan.gridPeriodNs;
				if (shifted >= endNs) break;
			}
			const effectiveIntendedNs = base + eventIndex * plan.gridPeriodNs;

			const amplitude = amplitudeAt(plan, index, sessions, eventIndex);
			eventsRun += 1;
			let firstActualNs = 0;
			let lastActualNs = 0;
			for (let k = 0; k < amplitude; k += 1) {
				const actualNs = clock.now();
				if (k === 0) firstActualNs = actualNs;
				lastActualNs = actualNs;
				sequence += 1;
				payload.stamp(effectiveIntendedNs, actualNs, sequence);
				try {
					await send(payload.bytes);
					sent += 1;
				} catch {
					sendErrors += 1;
				}
				burn(clock, burnNs);
			}
			if (amplitude > 0) {
				originationLag.record(firstActualNs - effectiveIntendedNs);
				sendIssueSpread.record(lastActualNs - firstActualNs);
			}
			eventIndex += 1;
		}
	};

	await Promise.all(sends.map((_, i) => runSession(i)));
	const driveEndNs = clock.now();

	return {
		sent,
		sendErrors,
		// Run plus skipped: the denominator the `generator-saturation` STOP is
		// written against is every grid event the plan put inside the step, not
		// only the ones that survived to run.
		sendEventsScheduled: eventsRun + eventsSkipped,
		sendEventsSkipped: eventsSkipped,
		scheduledDatagrams: scheduledDatagrams(plan, sessions, events),
		originationLag: originationLag.toJson(),
		sendIssueSpread: sendIssueSpread.toJson(),
		gridPeriodNs: plan.gridPeriodNs,
		peakWindowDatagrams: peakWindowDatagrams(plan, sessions),
		driveWindowSec: Math.max(driveEndNs - anchorNs, 1) / 1e9,
	};
}

export type HeadroomRung = {
	/** Sink sessions per real session at this rung. */
	multiplier: number;
	realSessions: number;
	shadowSessions: number;
	perSessionRate: number;
	/** Datagrams/s the originator was asked for, real and shadow together. */
	offeredPerSec: number;
	/** Datagrams/s it actually sourced. */
	emittedPerSec: number;
	emitted: number;
	scheduled: number;
	emittedFraction: number;
	/** Of `emitted`, the part that went through the real transport. */
	realEmitted: number;
	shadowEmitted: number;
	originationLagP99Ns: number;
	sendEventsSkipped: number;
	sendEventsScheduled: number;
	driveWindowSec: number;
	hostCpuPct: number | null;
	passes: boolean;
};

export type HeadroomProbe = {
	secondsPerRung: number;
	profile: EgressProfile;
	perSessionRate: number;
	realSessions: number;
	burnNs: number;
	rungs: HeadroomRung[];
	ceilingPerSec: number;
};

/**
 * The loaded-server generator-headroom arm (pre-registration amendment 1).
 *
 * The question is "could the JS originator have offered more than the ladder
 * asked of it, on the box the ladder actually ran on?" — so it is answered
 * there: the transport carries the top ladder rung for the whole arm, and the
 * *same* scheduler on the *same* thread additionally drives `m × sessions`
 * shadow sessions into a counting sink, doing everything the real path does
 * except the native call. A rung passes when the originator kept its registered
 * emitted fraction and lag bound across real and shadow together, and the
 * ceiling is the combined rate it demonstrably sourced.
 *
 * The arm it replaced ran on an idle box with no server in the picture, and its
 * STOP divided by delivered throughput — a quantity a generator-bound run
 * depresses, so the rule passed exactly when it should have fired. Neither
 * property survives here: the box is loaded, and the classifier divides by the
 * plan's own offered rate.
 */
async function runHeadroomArm(
	clock: { now(): number },
	realSends: SendFn[],
	sampleHostCpu: () => number | null,
): Promise<HeadroomProbe> {
	const rungs: HeadroomRung[] = [];
	const plan = planFor(PROFILE, HEADROOM_RATE);
	let shadowEmitted = 0;
	let realEmitted = 0;
	const sink: SendFn = async (bytes) => {
		// Everything `sendDatagram` does on the JS side before the native call.
		shadowEmitted += Buffer.from(bytes).length > 0 ? 1 : 0;
	};
	const counted: SendFn[] = realSends.map((send) => async (bytes) => {
		const result = await send(bytes);
		realEmitted += 1;
		return result;
	});

	for (const multiplier of HEADROOM_MULTIPLIERS) {
		const shadowSessions = Math.max(1, Math.round(multiplier * counted.length));
		const sends = [...counted, ...new Array<SendFn>(shadowSessions).fill(sink)];
		realEmitted = 0;
		shadowEmitted = 0;
		sampleHostCpu();
		const stats = await driveProfile(
			plan,
			sends,
			HEADROOM_SECONDS,
			clock,
			HEADROOM_BURN_NS,
		);
		const p99 = LatencyHistogram.fromJson(stats.originationLag).percentile(
			0.99,
		);
		const fraction =
			stats.scheduledDatagrams > 0 ? stats.sent / stats.scheduledDatagrams : 0;
		const rung: HeadroomRung = {
			multiplier,
			realSessions: counted.length,
			shadowSessions,
			perSessionRate: plan.effectiveRatePerSession,
			offeredPerSec: stats.scheduledDatagrams / stats.driveWindowSec,
			emittedPerSec: stats.sent / stats.driveWindowSec,
			emitted: stats.sent,
			scheduled: stats.scheduledDatagrams,
			emittedFraction: fraction,
			realEmitted,
			shadowEmitted,
			originationLagP99Ns: p99,
			sendEventsSkipped: stats.sendEventsSkipped,
			sendEventsScheduled: stats.sendEventsScheduled,
			driveWindowSec: stats.driveWindowSec,
			hostCpuPct: sampleHostCpu(),
			passes:
				fraction >= HEADROOM_EMITTED_FRACTION && p99 < HEADROOM_LAG_BOUND_NS,
		};
		rungs.push(rung);
		console.log(
			`bench-egress: headroom m=${multiplier} real=${rung.realSessions} shadow=${shadowSessions} offered=${rung.offeredPerSec.toFixed(0)}/s emitted=${(fraction * 100).toFixed(1)}% (${rung.emittedPerSec.toFixed(0)}/s) lagP99=${(p99 / 1e6).toFixed(2)}ms ${rung.passes ? "ok" : "SATURATED"}`,
		);
		if (!rung.passes) break;
	}

	// The ceiling is what the originator demonstrably sourced, not what it was
	// asked for: a rung that passed emitted at least 0.95 of its schedule, and
	// the smaller of the two is the honest number.
	const best = rungs.filter((r) => r.passes).at(-1);
	return {
		secondsPerRung: HEADROOM_SECONDS,
		profile: PROFILE,
		perSessionRate: plan.effectiveRatePerSession,
		realSessions: realSends.length,
		burnNs: HEADROOM_BURN_NS,
		rungs,
		ceilingPerSec: best ? Math.min(best.offeredPerSec, best.emittedPerSec) : 0,
	};
}

export type ClientEgressJson = {
	arrival: string;
	egressOneWay: LatencyHistogramJson;
	endToEnd: LatencyHistogramJson;
	recvUnstamped: number;
};

export type EgressStep = {
	shape: EgressShape;
	profile: EgressProfile;
	perSessionRate: number;
	sessionsRequested: number;
	sessionsConnected: number;
	aggregateRate: number;
	/**
	 * Wall clock across the whole step, samplers and process lifetimes included.
	 * Reported for disclosure only: no rate divides by it. That is
	 * `originator.driveWindowSec`.
	 */
	elapsedSec: number;
	originator: OriginatorStats;
	clientReceived: number;
	client: ClientEgressJson | null;
	downDeliveryRatio: number | null;
	/** Percent of one core (4 vCPU box reads up to 400), same unit as `serverCpuPct`. */
	hostCpuPctMedian: number | null;
	hostCpuCount: number;
	serverCpuPct: number;
	/** Fan-out only: datagrams the publisher pushed into the server. */
	ingested: number;
	/** Fan-out only: JS handler entry → first forward issue, inside the server. */
	forwardLag: LatencyHistogramJson | null;
	/** Everything the fan-out shape's falsifiers and instruments produced. */
	fanout: FanoutRecord | null;
};

/**
 * The fan-out shape's own record: the send-cost instrument the retracted run
 * left hardcoded empty, the two falsifiers' inputs and verdicts, and the
 * publisher's own honesty counters.
 */
export type FanoutRecord = {
	mode: FanoutMode;
	subscribers: number;
	publisherRatePerSec: number;
	tickHz: number;
	datagramsPerTick: number;
	/** Publisher arrivals the server observed, and the stamped part of them. */
	ingested: number;
	publisherStamped: number;
	forwarded: number;
	forwardErrors: number;
	forwardDeliveryRatio: number | null;
	/** Publisher actual-send stamp → first forward send issued. Falsifier 1. */
	ingestToForward: LatencyHistogramJson;
	/** JS handler entry → first forward issue. Diagnostic; legitimately µs. */
	handlerToForward: LatencyHistogramJson;
	/** First forward send call → last one, inside one arrival's fan-out. */
	forwardIssueSpread: LatencyHistogramJson;
	/** First forward send call → all of that arrival's sends settled. */
	forwardSettle: LatencyHistogramJson;
	/** Gaps between consecutive server-observed publisher arrivals. */
	serverInterArrival: LatencyHistogramJson;
	interArrivalGaps: number;
	frameGaps: number;
	frameGapFraction: number;
	ingestReality: IngestRealityVerdict;
	publisherShortfall: boolean;
	forwardShortfall: boolean;
	publisher: {
		sent: number;
		sendErrors: number;
		effectiveRatePerSec: number;
		ticksSkipped: number;
		sendEvents: number;
		scheduleLag: LatencyHistogramJson | null;
	};
	precheck: FanoutPrecheck;
};

/** The sink-saturation pre-check that gates one N. Falsifier 2. */
export type FanoutPrecheck = {
	outcome: SinkPrecheckOutcome;
	subscribers: number;
	perSessionRate: number;
	offeredPerSec: number;
	deliveredPerSec: number;
	deliveryRatio: number | null;
	oneWayP99Ns: number | null;
	generatorSaturated: boolean;
	seconds: number;
};

type ClientHandle = {
	child: ReturnType<typeof Bun.spawn>;
	stdout: Promise<string>;
	stderr: Promise<string>;
};

function spawnClient(args: string[]): ClientHandle {
	const child = Bun.spawn([CLIENT_BIN, ...args], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		child,
		stdout: new Response(child.stdout).text(),
		stderr: new Response(child.stderr).text(),
	};
}

function subscriberArgs(sessions: number, durationSec: number): string[] {
	return [
		"--url",
		`https://127.0.0.1:${PORT}`,
		"--mode",
		"load",
		"--skip-probes",
		"--egress-recv",
		"--sessions",
		String(sessions),
		"--duration",
		String(durationSec),
		"--datagrams-per-sec",
		"0",
		"--streams-per-sec",
		"0",
		// Measurement run: the ladder must climb past the knee, not exit at it.
		"--max-session-errors",
		String(sessions),
		"--max-datagram-errors",
		"1000000000",
		"--max-stream-errors",
		"1000000000",
	];
}

function parseClientJson(stdout: string): ClientEgressJson | null {
	const line = stdout.match(/load-client: latency-json (\{.*\})/);
	if (!line?.[1]) return null;
	return JSON.parse(line[1]) as ClientEgressJson;
}

function parseCount(stdout: string, re: RegExp): number {
	const m = stdout.match(re);
	return m?.[1] ? parseInt(m[1], 10) : 0;
}

async function main(): Promise<void> {
	if (PAYLOAD_BYTES < STAMP_BYTES) {
		throw new Error(`EGRESS_PAYLOAD_BYTES must be >= ${STAMP_BYTES}`);
	}

	const clock = await createMonotonicClock();
	console.log(
		`bench-egress: shape=${SHAPE} profile=${PROFILE} clock=${clock.source} residual=${clock.calibrationResidualNs.toFixed(0)}ns spread=${clock.calibrationSpreadNs.toFixed(0)}ns batchEnv=${process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? "(default)"}`,
	);

	if (HEADROOM_BURN_NS > 0) {
		console.warn(
			`bench-egress: EGRESS_HEADROOM_BURN_NS=${HEADROOM_BURN_NS} — this is the falsifier. The artifact is marked harness-falsifier and carries no capacity number.`,
		);
	}

	console.log("bench-egress: building load-client (release)...");
	try {
		await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();
	} catch (err) {
		if (!(await Bun.file(CLIENT_BIN).exists())) throw err;
		console.warn(
			"bench-egress: cargo build failed; falling back to existing load-client binary",
		);
	}

	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	type Sub = { send: SendFn; id: number };
	const subscribers: Sub[] = [];
	let nextId = 1;

	/**
	 * Everything the server observes about one fan-out step, reset before each.
	 *
	 * The retracted run recorded an arrival timestamp and a second clock read
	 * taken immediately after it, which is why its "ingest→forward lag" read
	 * 9–31 µs: it measured two adjacent clock reads, not a path. Here the ingest
	 * interval is anchored on the *publisher's own stamp*, which is a different
	 * process on the same system clock, so the number contains the loopback UDP
	 * hop, quinn's decrypt, the N-API crossing and the JS event loop — or it
	 * doesn't, and the falsifier says so.
	 */
	type FanoutState = {
		active: boolean;
		publisherId: number | null;
		ingested: number;
		stamped: number;
		forwarded: number;
		forwardErrors: number;
		firstIngestNs: number;
		lastIngestNs: number;
		prevArrivalNs: number;
		gaps: number;
		frameGaps: number;
		frameGapThresholdNs: number;
		ingestToForward: LatencyHistogram;
		handlerToForward: LatencyHistogram;
		forwardIssueSpread: LatencyHistogram;
		forwardSettle: LatencyHistogram;
		interArrival: LatencyHistogram;
	};

	const fanout: FanoutState = {
		active: false,
		publisherId: null,
		ingested: 0,
		stamped: 0,
		forwarded: 0,
		forwardErrors: 0,
		firstIngestNs: 0,
		lastIngestNs: 0,
		prevArrivalNs: 0,
		gaps: 0,
		frameGaps: 0,
		frameGapThresholdNs: 0,
		ingestToForward: new LatencyHistogram(),
		handlerToForward: new LatencyHistogram(),
		forwardIssueSpread: new LatencyHistogram(),
		forwardSettle: new LatencyHistogram(),
		interArrival: new LatencyHistogram(),
	};

	const resetFanout = (gridPeriodNs: number): void => {
		fanout.publisherId = null;
		fanout.ingested = 0;
		fanout.stamped = 0;
		fanout.forwarded = 0;
		fanout.forwardErrors = 0;
		fanout.firstIngestNs = 0;
		fanout.lastIngestNs = 0;
		fanout.prevArrivalNs = 0;
		fanout.gaps = 0;
		fanout.frameGaps = 0;
		// A gap at least half a frame long is a frame boundary; anything shorter is
		// inside one tick's burst. The registered cadence check counts the ratio.
		fanout.frameGapThresholdNs = gridPeriodNs / 2;
		fanout.ingestToForward.reset();
		fanout.handlerToForward.reset();
		fanout.forwardIssueSpread.reset();
		fanout.forwardSettle.reset();
		fanout.interArrival.reset();
	};

	const peakSessions = Math.max(SESSIONS, ...FANOUT_N) + 2;
	// The heaviest aggregate any shape asks for: the ladder's top rung, the
	// fan-out's forward egress, and the sink pre-check's 1.5× of it. The limiter
	// is set four times this so it is never the thing being measured.
	const aggregatePeak = Math.max(
		peakSessions * Math.max(...RATES, FANOUT_PUBLISH_RATE),
		Math.round(SINK_HEADROOM_FACTOR * FANOUT_AGGREGATE),
		Math.max(...FANOUT_N) * FANOUT_PUBLISH_RATE,
		1,
	);
	const server = createServer({
		port: PORT,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: peakSessions + 100,
			maxHandshakesInFlight: peakSessions + 100,
		},
		rateLimits: {
			handshakesPerSec: Math.max(peakSessions * 2, 400),
			handshakesBurst: Math.max(peakSessions * 4, 1000),
			handshakesBurstPerPrefix: Math.max(peakSessions * 4, 1000),
			streamsPerSec: 1000,
			streamsBurst: 2000,
			// Four times the top ladder step: measure the host, never the limiter.
			datagramsPerSec: aggregatePeak * 4,
			datagramsBurst: aggregatePeak * 8,
		},
		onSession: (session) => {
			const entry: Sub = {
				id: nextId++,
				send: (bytes) => session.sendDatagram(bytes),
			};
			subscribers.push(entry);
			void session.closed
				.catch(() => {})
				.then(() => {
					const i = subscribers.indexOf(entry);
					if (i >= 0) subscribers.splice(i, 1);
				});
			void (async () => {
				for await (const datagram of session.incomingDatagrams()) {
					const arrivedNs = clock.now();
					if (!fanout.active) continue;
					const stamp = decodeStamp(datagram);
					// The publisher is whoever sends us a stamped datagram first.
					// Subscribers are spawned with `--datagrams-per-sec 0`, so any
					// other sender is a harness fault and is counted, not forwarded.
					if (stamp && fanout.publisherId === null) {
						fanout.publisherId = entry.id;
					}
					if (entry.id !== fanout.publisherId) continue;

					fanout.ingested += 1;
					if (fanout.firstIngestNs === 0) fanout.firstIngestNs = arrivedNs;
					fanout.lastIngestNs = arrivedNs;
					if (fanout.prevArrivalNs > 0) {
						const gapNs = arrivedNs - fanout.prevArrivalNs;
						fanout.interArrival.record(gapNs);
						fanout.gaps += 1;
						if (gapNs >= fanout.frameGapThresholdNs) fanout.frameGaps += 1;
					}
					fanout.prevArrivalNs = arrivedNs;
					if (!stamp) continue;
					fanout.stamped += 1;

					// Minimal SFU: forward verbatim to every subscriber, so the
					// publisher's own stamp survives and the measured interval has no
					// server clock in it at all. `sendDatagram` copies synchronously
					// before its first await, so issuing all of them and then settling
					// is safe — and it is the shape that makes the issue spread mean
					// "N boundary crossings" rather than "N round trips".
					const targets = subscribers.filter((s) => s !== entry);
					const issuedNs = clock.now();
					fanout.handlerToForward.record(issuedNs - arrivedNs);
					fanout.ingestToForward.record(issuedNs - stamp.actualNs);
					const pending: Array<Promise<unknown>> = [];
					for (const target of targets) pending.push(target.send(datagram));
					fanout.forwardIssueSpread.record(clock.now() - issuedNs);
					const results = await Promise.allSettled(pending);
					fanout.forwardSettle.record(clock.now() - issuedNs);
					for (const r of results) {
						if (r.status === "fulfilled") fanout.forwarded += 1;
						else fanout.forwardErrors += 1;
					}
				}
			})().catch(() => {});
		},
	});
	// createServer has no readiness promise; same 3s the other load tools use.
	await Bun.sleep(3000);

	const waitForSessions = async (target: number): Promise<number> => {
		const deadline = Date.now() + CONNECT_BUDGET_S * 1000;
		while (Date.now() < deadline && subscribers.length < target) {
			await Bun.sleep(100);
		}
		return subscribers.length;
	};

	/**
	 * Wait for the previous step's sessions to actually leave.
	 *
	 * `subscribers` is one array for the whole run and entries are removed when
	 * `session.closed` settles, which is later than the previous client's exit.
	 * Without this, `waitForSessions` returns instantly on the *old* sessions and
	 * the step drives datagrams into connections that are on their way out —
	 * which reads as a delivery collapse that has nothing to do with egress.
	 */
	const waitForDrain = async (): Promise<void> => {
		const deadline = Date.now() + DRAIN_BUDGET_S * 1000;
		while (Date.now() < deadline && subscribers.length > 0) {
			await Bun.sleep(100);
		}
		if (subscribers.length > 0) {
			console.warn(
				`bench-egress: ${subscribers.length} session(s) still open after ${DRAIN_BUDGET_S}s drain`,
			);
		}
	};

	const steps: EgressStep[] = [];

	/**
	 * Drive one server-originated arm into a fresh subscriber process.
	 *
	 * Shared by the ladder and by the fan-out's sink pre-check: the pre-check
	 * needs the ladder's exact origination path, because the question it asks is
	 * "can this subscriber process absorb the load the fan-out is about to put on
	 * it", and answering it with a second, differently-shaped originator would be
	 * answering a different question.
	 */
	type DirectArm = {
		connected: number;
		stats: OriginatorStats;
		client: ClientEgressJson | null;
		clientReceived: number;
		hostSamples: number[];
		cpuMsDrive: number;
		elapsedSec: number;
	};

	const runDirectArm = async (
		profile: EgressProfile,
		perSessionRate: number,
		sessionsRequested: number,
		seconds: number,
		label: string,
	): Promise<DirectArm> => {
		const plan = planFor(profile, perSessionRate);
		const durationSec = seconds + CONNECT_BUDGET_S + CLIENT_DURATION_SLACK_S;
		await waitForDrain();
		const sub = spawnClient(subscriberArgs(sessionsRequested, durationSec));
		const connected = await waitForSessions(sessionsRequested);
		if (connected === 0) {
			sub.child.kill();
			throw new Error(
				`${label}: no subscriber session connected in ${CONNECT_BUDGET_S}s`,
			);
		}

		const cpuMs0 = serverCpuMs();
		const startedAt = Date.now();
		const hostSamples: number[] = [];
		let prevHost = readHostCpu();
		let sampling = true;
		const sampler = (async () => {
			while (sampling) {
				await Bun.sleep(5000);
				const next = readHostCpu();
				const pct = hostCpuPct(prevHost, next);
				prevHost = next;
				if (pct !== null) hostSamples.push(pct);
			}
		})();

		const snapshot = subscribers.slice(0, connected);
		const stats = await driveProfile(
			plan,
			snapshot.map((s) => s.send),
			seconds,
			clock,
		);
		// Read before the sampler is joined and before the client is reaped, so
		// the numerator covers the drive window the denominator does.
		const cpuMsDrive = serverCpuMs() - cpuMs0;
		sampling = false;
		await sampler;
		const elapsedSec = (Date.now() - startedAt) / 1000;

		await sub.child.exited;
		const stdout = await sub.stdout;
		const stderr = await sub.stderr;
		const client = parseClientJson(stdout);
		if (!client) console.warn(stderr.slice(-1500));
		return {
			connected,
			stats,
			client,
			clientReceived: parseCount(stdout, /datagrams received=(\d+)/),
			hostSamples,
			cpuMsDrive,
			elapsedSec,
		};
	};

	const runStep = async (
		perSessionRate: number,
		sessionsRequested: number,
	): Promise<void> => {
		const arm = await runDirectArm(
			PROFILE,
			perSessionRate,
			sessionsRequested,
			STEP_SECONDS,
			`rate ${perSessionRate}`,
		);
		const { stats } = arm;

		steps.push({
			shape: SHAPE,
			profile: PROFILE,
			perSessionRate,
			sessionsRequested,
			sessionsConnected: arm.connected,
			aggregateRate: Math.round(
				planFor(PROFILE, perSessionRate).effectiveRatePerSession *
					arm.connected,
			),
			elapsedSec: arm.elapsedSec,
			originator: stats,
			clientReceived: arm.clientReceived,
			client: arm.client,
			downDeliveryRatio:
				stats.sent > 0 ? arm.clientReceived / stats.sent : null,
			hostCpuPctMedian: median(arm.hostSamples),
			hostCpuCount: HOST_CPU_COUNT,
			// Percent of one core, over the drive window — not over `elapsedSec`,
			// which also contains the sampler join and the client's exit.
			serverCpuPct: (arm.cpuMsDrive / (stats.driveWindowSec * 1000)) * 100,
			ingested: 0,
			forwardLag: null,
			fanout: null,
		});

		const oneWay = arm.client
			? LatencyHistogram.fromJson(arm.client.egressOneWay).summary()
			: null;
		const ms = (ns: number) => (ns / 1e6).toFixed(3);
		console.log(
			`bench-egress: rate=${perSessionRate}/s/session sessions=${arm.connected} sent=${stats.sent}/${stats.scheduledDatagrams} recv=${arm.clientReceived} ` +
				(oneWay
					? `p50=${ms(oneWay.p50Ns)}ms p99=${ms(oneWay.p99Ns)}ms p999=${ms(oneWay.p999Ns)}ms neg=${oneWay.negative} `
					: "no-client-json ") +
				`peakWindow=${stats.peakWindowDatagrams} skipped=${stats.sendEventsSkipped}/${stats.sendEventsScheduled} host=${median(arm.hostSamples)?.toFixed(0) ?? "n/a"}%`,
		);
	};

	/**
	 * Falsifier 2, run before every fan-out N.
	 *
	 * The subscriber process is co-resident on the same 4 vCPU as the server and
	 * the publisher. If it is the binding constraint, a fan-out p99 is a number
	 * about the subscriber process — which is exactly the mistake that got the
	 * original fan-out arm retracted, wearing different clothes. So the sink is
	 * asked, first and separately, to absorb 1.5× the load the step will impose,
	 * on the ladder's own proven origination path.
	 *
	 * A pre-check whose own JS originator saturated is `inconclusive`, never a
	 * pass: a starved generator offers less load, which is indistinguishable from
	 * a healthy sink.
	 */
	const runSinkPrecheck = async (
		subscriberCount: number,
		fanoutPerSubscriberRate: number,
	): Promise<FanoutPrecheck> => {
		const perSessionRate = Math.max(
			1,
			Math.round(SINK_HEADROOM_FACTOR * fanoutPerSubscriberRate),
		);
		const arm = await runDirectArm(
			"constant",
			perSessionRate,
			subscriberCount,
			FANOUT_PRECHECK_SECONDS,
			`sink pre-check N=${subscriberCount}`,
		);
		const { stats } = arm;
		const events = stats.sendEventsScheduled;
		// The registered `generator-saturation` conditions that a single arm can
		// evaluate. The third — the within-profile lag floor — needs a ladder of
		// steps to establish a floor from, and one arm is not a ladder.
		const generatorSaturated =
			(events > 0 && stats.sendEventsSkipped >= 0.1 * events) ||
			(stats.scheduledDatagrams > 0 &&
				stats.sent < 0.9 * stats.scheduledDatagrams);
		const deliveryRatio =
			stats.sent > 0 ? arm.clientReceived / stats.sent : null;
		const oneWayP99Ns = arm.client
			? LatencyHistogram.fromJson(arm.client.egressOneWay).percentile(0.99)
			: null;
		const precheck: FanoutPrecheck = {
			outcome: sinkPrecheckVerdict({
				subscribers: arm.connected,
				offeredPerSec: stats.scheduledDatagrams / stats.driveWindowSec,
				deliveryRatio,
				oneWayP99Ns,
				generatorSaturated,
			}),
			subscribers: arm.connected,
			perSessionRate,
			offeredPerSec: stats.scheduledDatagrams / stats.driveWindowSec,
			deliveredPerSec: arm.clientReceived / stats.driveWindowSec,
			deliveryRatio,
			oneWayP99Ns,
			generatorSaturated,
			seconds: FANOUT_PRECHECK_SECONDS,
		};
		console.log(
			`bench-egress: sink pre-check N=${arm.connected} at ${perSessionRate}/s/session ` +
				`(${precheck.offeredPerSec.toFixed(0)}/s offered, ${SINK_HEADROOM_FACTOR}x the step) ` +
				`delivery=${deliveryRatio?.toFixed(4) ?? "n/a"} p99=${oneWayP99Ns !== null ? (oneWayP99Ns / 1e6).toFixed(2) : "n/a"}ms → ${precheck.outcome}`,
		);
		return precheck;
	};

	const runFanoutStep = async (n: number): Promise<void> => {
		const publishRate = publisherRateFor(
			FANOUT_MODE,
			n,
			FANOUT_PUBLISH_RATE,
			FANOUT_AGGREGATE,
		);
		const perTick = datagramsPerTick(publishRate, FANOUT_TICK_HZ);
		// The Rust client sends `round(rate/hz)` per tick, so the rate it actually
		// offers is that burst times the grid — quantized, and labelled as such.
		const effectiveRate = perTick * FANOUT_TICK_HZ;
		const gridPeriodNs = Math.round(1e9 / FANOUT_TICK_HZ);

		// Falsifier 2 first: a saturated sink makes every number below meaningless,
		// so there is no point in producing them before it has been ruled out.
		const precheck = await runSinkPrecheck(n, effectiveRate);

		const durationSec =
			STEP_SECONDS + CONNECT_BUDGET_S + CLIENT_DURATION_SLACK_S;
		await waitForDrain();
		const sub = spawnClient(subscriberArgs(n, durationSec));
		const connected = await waitForSessions(n);
		if (connected === 0) {
			sub.child.kill();
			throw new Error(`fan-out N=${n}: no subscriber connected`);
		}

		resetFanout(gridPeriodNs);
		const cpuMs0 = serverCpuMs();
		const startedAt = Date.now();
		const hostSamples: number[] = [];
		let prevHost = readHostCpu();

		fanout.active = true;
		// The publisher is a *separate process* from the subscribers: one load
		// client, one session, 30 Hz ticks. Its stamp is the one the subscribers
		// measure against, so the fan-out interval is timed end to end between two
		// processes that share a clock and never contains the server's.
		const pub = spawnClient([
			"--url",
			`https://127.0.0.1:${PORT}`,
			"--mode",
			"load",
			"--skip-probes",
			"--latency-stamp",
			"--arrival",
			"tick",
			"--tick-hz",
			String(FANOUT_TICK_HZ),
			"--sessions",
			"1",
			"--duration",
			String(STEP_SECONDS),
			"--datagrams-per-sec",
			String(publishRate),
			"--streams-per-sec",
			"0",
			"--payload-bytes",
			String(PAYLOAD_BYTES),
			"--max-session-errors",
			"1",
			"--max-datagram-errors",
			"1000000000",
			"--max-stream-errors",
			"1000000000",
		]);

		let done = false;
		const exited = pub.child.exited.then(() => {
			done = true;
		});
		while (!done) {
			await Promise.race([exited, Bun.sleep(5000)]);
			const next = readHostCpu();
			const pct = hostCpuPct(prevHost, next);
			prevHost = next;
			if (pct !== null) hostSamples.push(pct);
		}
		const pubStdout = await pub.stdout;
		fanout.active = false;
		const cpuMsDrive = serverCpuMs() - cpuMs0;
		const elapsedSec = (Date.now() - startedAt) / 1000;
		// First to last server-observed ingest, on the shared clock: the interval
		// the publisher was actually driving, with the spawn, the handshake and
		// the client's exit outside it. Same definition of "drive window" the
		// ladder uses, so rates on the two shapes are comparable.
		const driveWindowSec =
			fanout.lastIngestNs > fanout.firstIngestNs
				? (fanout.lastIngestNs - fanout.firstIngestNs) / 1e9
				: Math.max(elapsedSec, 1);

		await sub.child.exited;
		const stdout = await sub.stdout;
		const client = parseClientJson(stdout);
		const clientReceived = parseCount(stdout, /datagrams received=(\d+)/);
		const pubJson = parseClientJson(pubStdout) as
			| (ClientEgressJson & {
					effectiveDatagramsPerSecPerSession?: number;
					ticksSkipped?: number;
					sendEvents?: number;
					scheduleLag?: LatencyHistogramJson;
			  })
			| null;
		const pubSent = parseCount(pubStdout, /datagrams sent=(\d+)/);
		const pubErrors = parseCount(pubStdout, /datagrams sent=\d+ err=(\d+)/);

		const frameGapFraction =
			fanout.gaps > 0 ? fanout.frameGaps / fanout.gaps : 0;
		const reality = ingestRealityVerdict({
			ingestToForwardP50Ns: fanout.ingestToForward.percentile(0.5),
			frameGapFraction,
			datagramsPerTick: perTick,
			publisherStamped: fanout.stamped,
			ingested: fanout.ingested,
		});
		const publisherLate = publisherShortfall({
			sent: pubSent,
			effectiveRatePerSec:
				pubJson?.effectiveDatagramsPerSecPerSession ?? effectiveRate,
			driveWindowSec,
			ticksSkipped: pubJson?.ticksSkipped ?? 0,
			sendEvents: pubJson?.sendEvents ?? 0,
		});
		const forwardLate = forwardShortfall(
			fanout.forwarded,
			fanout.stamped,
			connected,
		);

		const record: FanoutRecord = {
			mode: FANOUT_MODE,
			subscribers: connected,
			publisherRatePerSec: publishRate,
			tickHz: FANOUT_TICK_HZ,
			datagramsPerTick: perTick,
			ingested: fanout.ingested,
			publisherStamped: fanout.stamped,
			forwarded: fanout.forwarded,
			forwardErrors: fanout.forwardErrors,
			forwardDeliveryRatio:
				fanout.forwarded > 0 ? clientReceived / fanout.forwarded : null,
			ingestToForward: fanout.ingestToForward.toJson(),
			handlerToForward: fanout.handlerToForward.toJson(),
			forwardIssueSpread: fanout.forwardIssueSpread.toJson(),
			forwardSettle: fanout.forwardSettle.toJson(),
			serverInterArrival: fanout.interArrival.toJson(),
			interArrivalGaps: fanout.gaps,
			frameGaps: fanout.frameGaps,
			frameGapFraction,
			ingestReality: reality,
			publisherShortfall: publisherLate,
			forwardShortfall: forwardLate,
			publisher: {
				sent: pubSent,
				sendErrors: pubErrors,
				effectiveRatePerSec:
					pubJson?.effectiveDatagramsPerSecPerSession ?? effectiveRate,
				ticksSkipped: pubJson?.ticksSkipped ?? 0,
				sendEvents: pubJson?.sendEvents ?? 0,
				scheduleLag: pubJson?.scheduleLag ?? null,
			},
			precheck,
		};

		steps.push({
			shape: SHAPE,
			profile: PROFILE,
			perSessionRate: publishRate,
			sessionsRequested: n,
			sessionsConnected: connected,
			// Forward egress: what the server had to originate, not what one
			// publisher offered. This is the number the capacity claim is about.
			aggregateRate: Math.round(effectiveRate * connected),
			elapsedSec,
			originator: {
				// The forward side is the originator in this shape: the server sent
				// `forwarded` datagrams and the arrivals asked it for one per
				// subscriber. No JS scheduler exists here, so no grid is invented for
				// one — the publisher-side generator STOP lives in `fanout` instead.
				sent: fanout.forwarded,
				sendErrors: fanout.forwardErrors,
				sendEventsScheduled: fanout.stamped,
				sendEventsSkipped: 0,
				scheduledDatagrams: fanout.stamped * connected,
				originationLag: fanout.ingestToForward.toJson(),
				sendIssueSpread: fanout.forwardIssueSpread.toJson(),
				gridPeriodNs,
				peakWindowDatagrams: perTick * connected,
				driveWindowSec,
			},
			clientReceived,
			client,
			downDeliveryRatio:
				fanout.forwarded > 0 ? clientReceived / fanout.forwarded : null,
			hostCpuPctMedian: median(hostSamples),
			hostCpuCount: HOST_CPU_COUNT,
			serverCpuPct: (cpuMsDrive / (driveWindowSec * 1000)) * 100,
			ingested: fanout.ingested,
			forwardLag: fanout.handlerToForward.toJson(),
			fanout: record,
		});

		const oneWay = client
			? LatencyHistogram.fromJson(client.egressOneWay).summary()
			: null;
		const ms = (ns: number) => (ns / 1e6).toFixed(3);
		const issue = fanout.forwardIssueSpread.summary();
		console.log(
			`bench-egress: fanout ${FANOUT_MODE} N=${connected} pub=${publishRate}/s ingest=${fanout.stamped} forwarded=${fanout.forwarded} recv=${clientReceived} ` +
				(oneWay
					? `p50=${ms(oneWay.p50Ns)}ms p99=${ms(oneWay.p99Ns)}ms p999=${ms(oneWay.p999Ns)}ms `
					: "no-client-json ") +
				`ingestToForward p50=${ms(fanout.ingestToForward.percentile(0.5))}ms issueSpread p99=${ms(issue.p99Ns)}ms ` +
				`cadence=${frameGapFraction.toFixed(4)} (band ${reality.band.low.toFixed(4)}..${reality.band.high.toFixed(4)}) ` +
				`ingestReal=${reality.real}${reality.real ? "" : ` (${reality.reasons.join(",")})`}`,
		);
	};

	let headroom: HeadroomProbe | null = null;

	if (SHAPE === "headroom") {
		console.log(
			`bench-egress: headroom arm sessions=${SESSIONS} rate=${HEADROOM_RATE}/s/session profile=${PROFILE} multipliers=[${HEADROOM_MULTIPLIERS.join(",")}] ${HEADROOM_SECONDS}s each`,
		);
		const armSeconds =
			HEADROOM_MULTIPLIERS.length * (HEADROOM_SECONDS + 2) + CONNECT_BUDGET_S;
		const sub = spawnClient(
			subscriberArgs(SESSIONS, armSeconds + CLIENT_DURATION_SLACK_S),
		);
		const connected = await waitForSessions(SESSIONS);
		if (connected === 0) {
			sub.child.kill();
			throw new Error(`headroom: no subscriber session connected`);
		}
		let prevHost = readHostCpu();
		const sampleHostCpu = (): number | null => {
			const next = readHostCpu();
			const pct = hostCpuPct(prevHost, next);
			prevHost = next;
			return pct;
		};
		headroom = await runHeadroomArm(
			clock,
			subscribers.slice(0, connected).map((s) => s.send),
			sampleHostCpu,
		);
		sub.child.kill();
		await sub.child.exited;
		console.log(
			`bench-egress: headroom ceiling ${headroom.ceilingPerSec.toFixed(0)}/s (loaded, ${connected} real sessions at ${HEADROOM_RATE}/s)`,
		);
	} else if (SHAPE === "fanout") {
		console.log(
			`bench-egress: fan-out sweep=${FANOUT_MODE} N=[${FANOUT_N.join(",")}] ` +
				(FANOUT_MODE === "per-subscriber"
					? `publisher=${FANOUT_PUBLISH_RATE}/s per N`
					: `aggregate pinned at ${FANOUT_AGGREGATE}/s`) +
				` tick=${FANOUT_TICK_HZ}Hz step=${STEP_SECONDS}s precheck=${FANOUT_PRECHECK_SECONDS}s`,
		);
		for (const n of FANOUT_N) {
			await runFanoutStep(n);
			await Bun.sleep(SETTLE_MS);
		}
	} else {
		console.log(
			`bench-egress: ladder sessions=${SESSIONS} payload=${PAYLOAD_BYTES}B step=${STEP_SECONDS}s rates=[${RATES.join(",")}]/s/session`,
		);
		for (const rate of RATES) {
			await runStep(rate, SESSIONS);
			await Bun.sleep(SETTLE_MS);
		}
	}

	await server.close();

	writeFileSync(
		OUT_JSON,
		`${JSON.stringify({
			version: 1,
			shape: SHAPE,
			profile: PROFILE,
			startedAt: new Date().toISOString(),
			host: {
				platform: process.platform,
				cpus: navigator?.hardwareConcurrency ?? null,
				cpuCount: HOST_CPU_COUNT,
				bunVersion: Bun.version,
			},
			clock: {
				source: clock.source,
				calibrationResidualNs: clock.calibrationResidualNs,
				calibrationSpreadNs: clock.calibrationSpreadNs,
			},
			config: {
				sessions: SESSIONS,
				payloadBytes: PAYLOAD_BYTES,
				stepSeconds: STEP_SECONDS,
				ratesPerSession: RATES,
				fanoutN: FANOUT_N,
				fanoutMode: FANOUT_MODE,
				fanoutPublishRate: FANOUT_PUBLISH_RATE,
				fanoutAggregate: FANOUT_AGGREGATE,
				fanoutTickHz: FANOUT_TICK_HZ,
				fanoutPrecheckSeconds: FANOUT_PRECHECK_SECONDS,
				headroomMultipliers: HEADROOM_MULTIPLIERS,
				headroomRatePerSession: HEADROOM_RATE,
				headroomSeconds: HEADROOM_SECONDS,
				headroomBurnNs: HEADROOM_BURN_NS,
				datagramBatchEnv: process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? null,
			},
			headroom,
			steps,
		})}\n`,
	);
	console.log(`bench-egress: wrote ${OUT_JSON}`);
}

await main();
// Server-side sessions left behind by an abruptly exiting client have no QUIC idle
// timeout and keep the event loop referenced after close — a clean drain can hang
// forever (observed on the runner, latency run 32159708926). Output is already
// flushed synchronously above.
process.exit(0);
