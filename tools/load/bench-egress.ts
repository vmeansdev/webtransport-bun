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
 *   `generator` — the pre-registered saturation control. The same scheduler and
 *                 the same per-datagram stamping and copy, into a counting sink.
 *                 Answers "could the JS originator have offered more?" before
 *                 any transport number is allowed to mean anything.
 *   `ladder`    — N subscriber sessions, one burst profile, a rate ladder.
 *   `fanout`    — one publisher, N subscribers, the server forwarding verbatim.
 *                 The publisher's own stamp survives the fan-out, so this shape
 *                 has no server clock in its path at all.
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
import { join } from "node:path";
import { $ } from "bun";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	type EgressPlan,
	type EgressProfile,
	amplitudeAt,
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

export type EgressShape = "ladder" | "fanout" | "generator";

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
/** Aggregate rates the generator-headroom probe escalates through. */
const GENERATOR_RATES = (
	process.env.EGRESS_GENERATOR_RATES ?? "20000,40000,80000,160000,240000,320000"
)
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
const GENERATOR_SECONDS = parseInt(
	process.env.EGRESS_GENERATOR_SECONDS ?? "5",
	10,
);
/** The pre-registered origination-lag bound for a passing generator rung. */
const GENERATOR_LAG_BOUND_NS = 5e6;
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

function hostCpuPct(prev: CpuSnapshot | null, next: CpuSnapshot | null) {
	if (!prev || !next || next.total === prev.total) return null;
	return ((next.busy - prev.busy) / (next.total - prev.total)) * 100;
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
	sendEventsScheduled: number;
	sendEventsSkipped: number;
	scheduledDatagrams: number;
	/** intended send → actual send, first datagram of each send event. */
	originationLag: LatencyHistogramJson;
	/** first to last datagram inside one send event. */
	sendIssueSpread: LatencyHistogramJson;
	gridPeriodNs: number;
	peakWindowDatagrams: number;
	effectiveRatePerSession: number;
};

type SendFn = (bytes: Uint8Array) => Promise<unknown>;

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
): Promise<OriginatorStats> {
	const sessions = sends.length;
	const originationLag = new LatencyHistogram();
	const sendIssueSpread = new LatencyHistogram();
	let sent = 0;
	let sendErrors = 0;
	let eventsScheduled = 0;
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
			let wokeNs = clock.now();
			const behind = Math.floor((wokeNs - intendedNs) / plan.gridPeriodNs);
			if (behind > 0) {
				eventsSkipped += behind;
				eventIndex += behind;
				const shifted = base + eventIndex * plan.gridPeriodNs;
				if (shifted >= endNs) break;
				wokeNs = clock.now();
			}
			const effectiveIntendedNs = base + eventIndex * plan.gridPeriodNs;

			const amplitude = amplitudeAt(plan, index, sessions, eventIndex);
			eventsScheduled += 1;
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
			}
			if (amplitude > 0) {
				originationLag.record(firstActualNs - effectiveIntendedNs);
				sendIssueSpread.record(lastActualNs - firstActualNs);
			}
			eventIndex += 1;
		}
	};

	await Promise.all(sends.map((_, i) => runSession(i)));

	return {
		sent,
		sendErrors,
		sendEventsScheduled: eventsScheduled,
		sendEventsSkipped: eventsSkipped,
		scheduledDatagrams: scheduledDatagrams(plan, sessions, events),
		originationLag: originationLag.toJson(),
		sendIssueSpread: sendIssueSpread.toJson(),
		gridPeriodNs: plan.gridPeriodNs,
		peakWindowDatagrams: peakWindowDatagrams(plan, sessions),
		effectiveRatePerSession: plan.effectiveRatePerSession,
	};
}

export type GeneratorRung = {
	aggregateRate: number;
	perSessionRate: number;
	emitted: number;
	scheduled: number;
	emittedFraction: number;
	originationLagP99Ns: number;
	/** Lowest `originationLagP99Ns` seen so far: this platform's timer-wake floor. */
	lagFloorNs: number;
	passes: boolean;
};

export type GeneratorProbe = {
	seconds: number;
	sessions: number;
	rungs: GeneratorRung[];
	ceilingPerSec: number;
};

/**
 * The pre-registered generator-saturation control.
 *
 * Everything the originator does except the native call: the same per-session
 * loops, the same stamping, the same `Buffer.from` copy `sendDatagram` would
 * make. If this ceiling is not comfortably above what the transport delivered,
 * the ladder measured the generator and the run is `incomplete`. That rule is
 * arithmetic in `egress-classify.ts`, not a judgement call here.
 */
async function runGeneratorProbe(clock: {
	now(): number;
}): Promise<GeneratorProbe> {
	const rungs: GeneratorRung[] = [];
	let sunk = 0;
	const sink: SendFn = async (bytes) => {
		sunk += Buffer.from(bytes).length;
	};

	// The bound is the flat 5 ms the pre-registration fixed. A floor-relative
	// bound was tempting — this platform's idle timer-wake granularity is not
	// load — but every way of relaxing it makes the ceiling larger, and a larger
	// ceiling makes the `generator-headroom` STOP easier to clear. That STOP is
	// the maintainer's non-negotiable, so it is left exactly as registered and
	// the floor is recorded as a diagnostic only.
	let lagFloorNs = Number.POSITIVE_INFINITY;

	for (const aggregate of GENERATOR_RATES) {
		const perSession = Math.max(1, Math.round(aggregate / SESSIONS));
		const plan = planFor("constant", perSession);
		const sends = new Array<SendFn>(SESSIONS).fill(sink);
		const stats = await driveProfile(plan, sends, GENERATOR_SECONDS, clock);
		const hist = LatencyHistogram.fromJson(stats.originationLag);
		const p99 = hist.percentile(0.99);
		if (p99 > 0) lagFloorNs = Math.min(lagFloorNs, p99);
		const fraction =
			stats.scheduledDatagrams > 0 ? stats.sent / stats.scheduledDatagrams : 0;
		const rung: GeneratorRung = {
			aggregateRate: perSession * SESSIONS,
			perSessionRate: perSession,
			emitted: stats.sent,
			scheduled: stats.scheduledDatagrams,
			emittedFraction: fraction,
			originationLagP99Ns: p99,
			lagFloorNs: Number.isFinite(lagFloorNs) ? lagFloorNs : 0,
			passes: fraction >= 0.95 && p99 < GENERATOR_LAG_BOUND_NS,
		};
		rungs.push(rung);
		console.log(
			`bench-egress: generator ${rung.aggregateRate}/s emitted=${(fraction * 100).toFixed(1)}% lagP99=${(p99 / 1e6).toFixed(2)}ms ${rung.passes ? "ok" : "SATURATED"}`,
		);
		if (!rung.passes) break;
	}
	void sunk;

	const ceilingPerSec =
		rungs.filter((r) => r.passes).at(-1)?.aggregateRate ?? 0;
	return {
		seconds: GENERATOR_SECONDS,
		sessions: SESSIONS,
		rungs,
		ceilingPerSec,
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
	elapsedSec: number;
	originator: OriginatorStats;
	clientReceived: number;
	client: ClientEgressJson | null;
	downDeliveryRatio: number | null;
	hostCpuPctMedian: number | null;
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

	// The generator control needs no server and no clients at all.
	if (SHAPE === "generator") {
		const probe = await runGeneratorProbe(clock);
		writeFileSync(
			OUT_JSON,
			`${JSON.stringify({
				version: 1,
				shape: SHAPE,
				startedAt: new Date().toISOString(),
				host: {
					platform: process.platform,
					cpus: navigator?.hardwareConcurrency ?? null,
					bunVersion: Bun.version,
				},
				clock: {
					source: clock.source,
					calibrationResidualNs: clock.calibrationResidualNs,
					calibrationSpreadNs: clock.calibrationSpreadNs,
				},
				config: { sessions: SESSIONS, payloadBytes: PAYLOAD_BYTES },
				generator: probe,
			})}\n`,
		);
		console.log(
			`bench-egress: generator ceiling ${probe.ceilingPerSec}/s -> ${OUT_JSON}`,
		);
		return;
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
			serverCpuPct:
				((serverCpuMs() - cpuMs0) / Math.max(elapsedSec * 1000, 1)) * 100,
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
		const elapsedSec = (Date.now() - startedAt) / 1000;

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
				effectiveRatePerSession: FANOUT_PUBLISH_RATE,
			},
			clientReceived,
			client,
			downDeliveryRatio: forwarded > 0 ? clientReceived / forwarded : null,
			hostCpuPctMedian: median(hostSamples),
			serverCpuPct:
				((serverCpuMs() - cpuMs0) / Math.max(elapsedSec * 1000, 1)) * 100,
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

	if (SHAPE === "fanout") {
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
				datagramBatchEnv: process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? null,
			},
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
