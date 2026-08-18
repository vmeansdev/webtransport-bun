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
 *   `fanout`   — one publisher, N subscribers, the server forwarding verbatim.
 *                The publisher's own stamp survives the fan-out, so this shape
 *                has no server clock in its path at all.
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
/** Publisher rate for the fan-out shape: 11 datagrams a frame at 30 fps. */
const FANOUT_PUBLISH_RATE = parseInt(
	process.env.EGRESS_FANOUT_PUBLISH_RATE ?? "330",
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
	join(ROOT, `tools/load/bench-egress-${SHAPE}-${PROFILE}.json`);

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
	/** Fan-out only: arrival → forward issue, inside the server. */
	forwardLag: LatencyHistogramJson | null;
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
	let ingested = 0;
	/**
	 * First and last server-observed ingest of the publisher's datagrams. The
	 * fan-out step's drive window is the span between them: a wall clock from
	 * before the publisher process was spawned to after it exited would carry a
	 * far larger overshoot than the ladder's, and every derived rate would be
	 * biased down by a different amount on each shape.
	 */
	let firstIngestNs = 0;
	let lastIngestNs = 0;
	const forwardLag = new LatencyHistogram();
	let fanoutForwarded = 0;
	let fanoutForwardErrors = 0;
	let fanoutActive = false;

	const peakSessions = Math.max(SESSIONS, ...FANOUT_N) + 2;
	const aggregatePeak = Math.max(
		peakSessions * Math.max(...RATES, FANOUT_PUBLISH_RATE),
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
					ingested += 1;
					if (firstIngestNs === 0) firstIngestNs = arrivedNs;
					lastIngestNs = arrivedNs;
					if (!fanoutActive) continue;
					// Minimal SFU: forward verbatim to everyone else, so the
					// publisher's own stamp survives and the measured interval has
					// no server clock in it at all.
					const targets = subscribers.filter((s) => s !== entry);
					forwardLag.record(clock.now() - arrivedNs);
					const results = await Promise.allSettled(
						targets.map((s) => s.send(datagram)),
					);
					for (const r of results) {
						if (r.status === "fulfilled") fanoutForwarded += 1;
						else fanoutForwardErrors += 1;
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

	const runStep = async (
		perSessionRate: number,
		sessionsRequested: number,
	): Promise<void> => {
		const plan = planFor(PROFILE, perSessionRate);
		const durationSec =
			STEP_SECONDS + CONNECT_BUDGET_S + CLIENT_DURATION_SLACK_S;
		await waitForDrain();
		const sub = spawnClient(subscriberArgs(sessionsRequested, durationSec));
		const connected = await waitForSessions(sessionsRequested);
		if (connected === 0) {
			sub.child.kill();
			throw new Error(
				`rate ${perSessionRate}: no subscriber session connected in ${CONNECT_BUDGET_S}s`,
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
			STEP_SECONDS,
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
		const clientReceived = parseCount(stdout, /datagrams received=(\d+)/);

		steps.push({
			shape: SHAPE,
			profile: PROFILE,
			perSessionRate,
			sessionsRequested,
			sessionsConnected: connected,
			aggregateRate: Math.round(plan.effectiveRatePerSession * connected),
			elapsedSec,
			originator: stats,
			clientReceived,
			client,
			downDeliveryRatio: stats.sent > 0 ? clientReceived / stats.sent : null,
			hostCpuPctMedian: median(hostSamples),
			hostCpuCount: HOST_CPU_COUNT,
			// Percent of one core, over the drive window — not over `elapsedSec`,
			// which also contains the sampler join and the client's exit.
			serverCpuPct: (cpuMsDrive / (stats.driveWindowSec * 1000)) * 100,
			ingested: 0,
			forwardLag: null,
		});

		const oneWay = client
			? LatencyHistogram.fromJson(client.egressOneWay).summary()
			: null;
		const ms = (ns: number) => (ns / 1e6).toFixed(3);
		console.log(
			`bench-egress: rate=${perSessionRate}/s/session sessions=${connected} sent=${stats.sent}/${stats.scheduledDatagrams} recv=${clientReceived} ` +
				(oneWay
					? `p50=${ms(oneWay.p50Ns)}ms p99=${ms(oneWay.p99Ns)}ms p999=${ms(oneWay.p999Ns)}ms neg=${oneWay.negative} `
					: "no-client-json ") +
				`peakWindow=${stats.peakWindowDatagrams} skipped=${stats.sendEventsSkipped}/${stats.sendEventsScheduled} host=${median(hostSamples)?.toFixed(0) ?? "n/a"}%`,
		);
	};

	const runFanoutStep = async (n: number): Promise<void> => {
		const durationSec =
			STEP_SECONDS + CONNECT_BUDGET_S + CLIENT_DURATION_SLACK_S;
		await waitForDrain();
		const sub = spawnClient(subscriberArgs(n, durationSec));
		const connected = await waitForSessions(n);
		if (connected === 0) {
			sub.child.kill();
			throw new Error(`fan-out N=${n}: no subscriber connected`);
		}

		const ingest0 = ingested;
		const fwd0 = fanoutForwarded;
		const fwdErr0 = fanoutForwardErrors;
		forwardLag.reset();
		firstIngestNs = 0;
		lastIngestNs = 0;
		const cpuMs0 = serverCpuMs();
		const startedAt = Date.now();
		const hostSamples: number[] = [];
		let prevHost = readHostCpu();

		fanoutActive = true;
		// The publisher is the same load client in its ordinary sending mode: one
		// session, 30 Hz ticks of 11 datagrams. Its stamp is the one the
		// subscribers measure against, so the fan-out path is timed end to end
		// between two processes that share a clock and never involve the server's.
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
			"30",
			"--sessions",
			"1",
			"--duration",
			String(STEP_SECONDS),
			"--datagrams-per-sec",
			String(FANOUT_PUBLISH_RATE),
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
		await pub.stdout;
		fanoutActive = false;
		const cpuMsDrive = serverCpuMs() - cpuMs0;
		const elapsedSec = (Date.now() - startedAt) / 1000;
		// First to last server-observed ingest, on the shared clock: the interval
		// the publisher was actually driving, with the spawn, the handshake and
		// the client's exit outside it. Same definition of "drive window" the
		// ladder uses, so rates on the two shapes are comparable.
		const driveWindowSec =
			lastIngestNs > firstIngestNs
				? (lastIngestNs - firstIngestNs) / 1e9
				: Math.max(elapsedSec, 1);

		await sub.child.exited;
		const stdout = await sub.stdout;
		const client = parseClientJson(stdout);
		const clientReceived = parseCount(stdout, /datagrams received=(\d+)/);
		const forwarded = fanoutForwarded - fwd0;
		const ingestedNow = ingested - ingest0;

		steps.push({
			shape: SHAPE,
			profile: PROFILE,
			perSessionRate: FANOUT_PUBLISH_RATE,
			sessionsRequested: n,
			sessionsConnected: connected,
			aggregateRate: FANOUT_PUBLISH_RATE * connected,
			elapsedSec,
			originator: {
				sent: forwarded,
				sendErrors: fanoutForwardErrors - fwdErr0,
				sendEventsScheduled: ingestedNow,
				sendEventsSkipped: 0,
				scheduledDatagrams: ingestedNow * connected,
				originationLag: forwardLag.toJson(),
				sendIssueSpread: new LatencyHistogram().toJson(),
				gridPeriodNs: Math.round(1e9 / 30),
				peakWindowDatagrams: 11 * connected,
				driveWindowSec,
			},
			clientReceived,
			client,
			downDeliveryRatio: forwarded > 0 ? clientReceived / forwarded : null,
			hostCpuPctMedian: median(hostSamples),
			hostCpuCount: HOST_CPU_COUNT,
			serverCpuPct: (cpuMsDrive / (driveWindowSec * 1000)) * 100,
			ingested: ingestedNow,
			forwardLag: forwardLag.toJson(),
		});

		const oneWay = client
			? LatencyHistogram.fromJson(client.egressOneWay).summary()
			: null;
		const ms = (ns: number) => (ns / 1e6).toFixed(3);
		console.log(
			`bench-egress: fanout N=${connected} ingest=${ingestedNow} forwarded=${forwarded} recv=${clientReceived} ` +
				(oneWay
					? `p50=${ms(oneWay.p50Ns)}ms p99=${ms(oneWay.p99Ns)}ms p999=${ms(oneWay.p999Ns)}ms`
					: "no-client-json"),
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
			`bench-egress: fan-out N=[${FANOUT_N.join(",")}] publisher=${FANOUT_PUBLISH_RATE}/s step=${STEP_SECONDS}s`,
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
				fanoutPublishRate: FANOUT_PUBLISH_RATE,
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
