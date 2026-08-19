#!/usr/bin/env bun
/**
 * G8's conductor: the many-rooms SFU, its room-scoped forward, its own
 * scheduling-lateness probe, and the sink pre-check each rung needs before it
 * counts.
 *
 * Registration: `docs/research/preregistrations/gate-g8-many-rooms.md`. Rates
 * come from `g8-plan.ts`, routing from `g8-router.ts` and verdicts from
 * `g8-classify.ts`, so nothing in this file is a threshold — it offers the
 * registered load and records what happened. The gate agent recomputes every
 * clause from the raw fields.
 *
 * Four things here are deliberate, and are why this is not `bench-egress` with
 * more publishers:
 *
 * 1. **M concurrent ingests.** G4's shape had exactly one, and its stamp named
 *    that as the largest gap between it and the SFU it was named after. Every
 *    per-room quantity here is per room precisely so that gap closes with an
 *    attributable number rather than an aggregate.
 * 2. **The forward is the registered one, unchanged from G4** — pipelined
 *    per-target `session.sendDatagram`, settled together. The mirror API (one
 *    payload, N sessions) does not exist and this gate is forbidden from acting
 *    on it (§0 K11); ticket 34 owns it. `sendDatagramBatch` would hold one
 *    element per target and could only add an allocation.
 * 3. **The conductor measures its own lateness** on a cumulative-deadline grid,
 *    on the main thread, doing no I/O. If the forward loop blocks the loop, that
 *    block is inside every one-way sample and V-H(c) is what says so.
 * 4. **Routing goes through `g8-router.ts`**, the same functions V-H(a)'s
 *    microbench times. A microbench of a copy of the router demonstrates
 *    nothing.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import { datagramsPerTick } from "./egress-fanout.ts";
import { readUdpStats, udpDelta } from "./egress-socket.ts";
import { mergeHistogramJson, p99Of } from "./g8-classify.ts";
import {
	G8_ARMS,
	G8_LADDERS,
	type G8Arm,
	isG8Arm,
	PUBLISHERS_PER_PROCESS,
	rungPlan,
	SUBSCRIBERS_PER_PROCESS,
} from "./g8-plan.ts";
import {
	benchmarkRouting,
	forwardTargets,
	type RoomMember,
	RoomTable,
} from "./g8-router.ts";
import { createMonotonicClock, type MonotonicClock } from "./latency-clock.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";
import {
	CLASS_ROOM_JOIN,
	CLASS_ROOM_MEDIA,
	decodeStamp,
	encodeStamp,
} from "./latency-stamp.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/rooms-client`;
const PORT = Number.parseInt(process.env.G8_PORT ?? "4433", 10);

const ARMS: G8Arm[] = (process.env.G8_ARMS ?? G8_ARMS.join(","))
	.split(",")
	.map((s) => s.trim())
	.filter(isG8Arm);
const DRIVE_SECONDS = Number.parseInt(process.env.G8_DRIVE_SECONDS ?? "60", 10);
const SETTLE_SECONDS = Number.parseInt(
	process.env.G8_SETTLE_SECONDS ?? "10",
	10,
);
const DRAIN_GRACE_MS = Number.parseInt(
	process.env.G8_DRAIN_GRACE_MS ?? "1000",
	10,
);
/** V-H(c)'s grid. 5 ms, cumulative-deadline, main thread, no I/O. */
const LOOP_PROBE_MS = 5;
/** V-S's own window. Shorter than the arm: it is a capability check, not a rung. */
const PRECHECK_SECONDS = Number.parseInt(
	process.env.G8_PRECHECK_SECONDS ?? "20",
	10,
);
const PRECHECK_JOIN_SECONDS = Number.parseInt(
	process.env.G8_PRECHECK_JOIN_SECONDS ?? "60",
	10,
);
/** The pre-check pacer's slice. Spread, never impulse — §1.6's rule on egress. */
const PRECHECK_SLICE_MS = 5;
/** Arrivals the routing microbench times at each M. */
const ROUTING_ARRIVALS = Number.parseInt(
	process.env.G8_ROUTING_ARRIVALS ?? "200000",
	10,
);
const OUT_JSON = process.env.G8_OUT ?? join(ROOT, "tools/load/bench-g8.json");
const HAS_PROC = process.platform === "linux";

/** Per-arm ladder override, e.g. `G8_LADDER_VOICE=10,50`. */
function ladderFor(arm: G8Arm): number[] {
	const raw = process.env[`G8_LADDER_${arm.toUpperCase()}`];
	if (!raw) return [...G8_LADDERS[arm]];
	return raw
		.split(",")
		.map((v) => Number.parseInt(v.trim(), 10))
		.filter((v) => Number.isFinite(v) && v > 0);
}

/* -------------------------------------------------------------------------- */
/* Host taps                                                                   */
/* -------------------------------------------------------------------------- */

type CpuSnapshot = { busy: number; total: number };

function readHostCpu(): CpuSnapshot | null {
	if (!HAS_PROC) return null;
	const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
	const fields = line.trim().split(/\s+/).slice(1).map(Number);
	const total = fields.reduce((a, b) => a + b, 0);
	const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
	return { busy: total - idle, total };
}

/** Percent of ONE core, the unit the spec pins on every axis. */
function hostCpuPct(
	a: CpuSnapshot | null,
	b: CpuSnapshot | null,
): number | null {
	if (!a || !b || b.total <= a.total) return null;
	const cores = navigator?.hardwareConcurrency ?? 1;
	return ((b.busy - a.busy) / (b.total - a.total)) * 100 * cores;
}

function serverCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

/* -------------------------------------------------------------------------- */
/* Server-side per-room state                                                  */
/* -------------------------------------------------------------------------- */

type SessionSink = {
	sendDatagram(data: Uint8Array): Promise<void>;
	alive: boolean;
};

type RoomState = {
	roomId: number;
	ingested: number;
	publisherStamped: number;
	forwarded: number;
	forwardErrors: number;
	/** Publisher `actual` → JS handler entry. V-I. */
	publisherToIngest: LatencyHistogram;
	/** JS handler entry → first forward issued. V-H(b). */
	handlerToForward: LatencyHistogram;
	/** First forward issued → last, within one arrival's fan-out. */
	forwardIssueSpread: LatencyHistogram;
	/** First forward issued → all of that arrival's sends settled. */
	forwardSettle: LatencyHistogram;
	gaps: number;
	frameGaps: number;
	lastArrivalNs: number;
	/** Per-publisher last arrival, so a mutual room's P streams do not alias. */
	lastArrivalByHandle: Map<number, number>;
	unstamped: number;
};

function freshRoom(roomId: number): RoomState {
	return {
		roomId,
		ingested: 0,
		publisherStamped: 0,
		forwarded: 0,
		forwardErrors: 0,
		publisherToIngest: new LatencyHistogram(),
		handlerToForward: new LatencyHistogram(),
		forwardIssueSpread: new LatencyHistogram(),
		forwardSettle: new LatencyHistogram(),
		gaps: 0,
		frameGaps: 0,
		lastArrivalNs: 0,
		lastArrivalByHandle: new Map(),
		unstamped: 0,
	};
}

/**
 * Everything the arrival handler reads, in one object held by reference.
 *
 * Per-rung reset mutates these fields rather than rebinding a variable: the
 * `onSession` closures outlive a rung, and a closure that keeps writing into the
 * previous rung's table is a silent zero, not a crash. The local smoke found
 * exactly that, and this shape is the fix.
 */
type ConductorState = {
	table: RoomTable<SessionSink>;
	roomStates: Map<number, RoomState>;
	nextHandle: number;
	framePeriodNs: number;
};

function resetConductor(
	state: ConductorState,
	plan: ReturnType<typeof rungPlan>,
): void {
	state.table = new RoomTable<SessionSink>();
	state.roomStates = new Map();
	state.nextHandle = 0;
	state.framePeriodNs = (1000 / plan.ratePerSec) * 1e6;
}

/* -------------------------------------------------------------------------- */
/* The conductor's own lateness probe — V-H(c)                                 */
/* -------------------------------------------------------------------------- */

/**
 * A cumulative-deadline grid on the main thread that measures **lateness only**.
 *
 * This is not the instrument G3b was invalidated for. That one timed the
 * emitter's own send and called the result scheduler lag. This does no send, no
 * await on I/O and no per-tick allocation: it is the pure difference between a
 * fixed grid and when the loop got round to it. Main-thread blocking is exactly
 * the quantity of interest — if the forward loop blocks for 5 ms, that 5 ms is
 * inside every one-way sample and the reader has to be told.
 */
function startLoopProbe(clock: MonotonicClock): {
	histogram: LatencyHistogram;
	stop: () => void;
} {
	const histogram = new LatencyHistogram();
	const periodNs = LOOP_PROBE_MS * 1e6;
	const startNs = clock.now();
	let n = 1;
	let stopped = false;
	const tick = (): void => {
		if (stopped) return;
		const nowNs = clock.now();
		const dueNs = startNs + n * periodNs;
		histogram.record(nowNs - dueNs);
		// Cumulative: skip past deadlines already gone rather than drifting the
		// grid forward by however late this tick was.
		do {
			n += 1;
		} while (startNs + n * periodNs <= nowNs);
		const sleepMs = (startNs + n * periodNs - nowNs) / 1e6;
		timer = setTimeout(tick, Math.max(0, sleepMs));
	};
	let timer = setTimeout(tick, LOOP_PROBE_MS);
	return {
		histogram,
		stop: () => {
			stopped = true;
			clearTimeout(timer);
		},
	};
}

/* -------------------------------------------------------------------------- */
/* Client processes                                                            */
/* -------------------------------------------------------------------------- */

const activeChildren = new Set<ChildProcess>();

type SpawnedClient = { child: ChildProcess; exited: Promise<number> };

function spawnClient(args: string[]): SpawnedClient {
	const full = ["--url", `https://127.0.0.1:${PORT}`, ...args];
	const child = spawn(CLIENT_BIN, full, {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	activeChildren.add(child);
	const exited = new Promise<number>((res) => {
		child.on("exit", (code, signal) => res(code ?? (signal ? 128 : -1)));
		child.on("error", () => res(-1));
	});
	child.stderr?.on("data", (chunk: Uint8Array) => {
		process.stderr.write(chunk);
	});
	return { child, exited };
}

type ClientReport = {
	role: string;
	processIndex: number;
	sessionsOpened: number;
	sessionsFailed: number;
	helloErrors: number;
	cpuMs: number;
	rssMb: number;
	publishers: Array<Record<string, unknown>>;
	rooms: Array<{
		roomId: number;
		received: number;
		undecodable: number;
		oneWay: ReturnType<LatencyHistogram["toJson"]>;
	}>;
	errors: string[];
};

async function collect(client: SpawnedClient): Promise<ClientReport | null> {
	let report: ClientReport | null = null;
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of client.child.stdout ?? []) {
		buffered += decoder.decode(chunk as Uint8Array, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			const match = line.match(/^rooms-client: json (\{.*\})$/);
			if (match?.[1]) report = JSON.parse(match[1]) as ClientReport;
			else if (line.trim()) console.log(line);
		}
	}
	await client.exited;
	activeChildren.delete(client.child);
	return report;
}

/* -------------------------------------------------------------------------- */
/* One rung                                                                    */
/* -------------------------------------------------------------------------- */

type RungOutput = {
	arm: G8Arm;
	rooms: number;
	plan: ReturnType<typeof rungPlan>;
	driveWindowSec: number;
	roomRecords: unknown[];
	publisherRecords: unknown[];
	conductor: { loopLag: unknown; routing: unknown };
	precheck: unknown;
	disclosures: Record<string, unknown>;
};

async function runRung(
	arm: G8Arm,
	rooms: number,
	ctx: {
		clock: MonotonicClock;
		state: ConductorState;
		routing: unknown;
	},
): Promise<RungOutput> {
	const plan = rungPlan(arm, rooms);

	// V-S first, standalone, with no fan-out arm live. A pre-check run beside the
	// arm would be measuring the arm.
	const precheck = await runPrecheck(plan, ctx);
	console.log(
		`bench-g8: precheck arm=${arm} rooms=${rooms} offered=${precheck.offeredPerSec.toFixed(0)}/s target=${precheck.targetPerSec}/s delivery=${precheck.deliveryRatio?.toFixed(4) ?? "null"}`,
	);
	await Bun.sleep(SETTLE_SECONDS * 1000);

	resetConductor(ctx.state, plan);
	const probe = startLoopProbe(ctx.clock);
	const cpuBefore = serverCpuMs();
	const hostBefore = readHostCpu();
	const udpBefore = readUdpStats();

	const clients: SpawnedClient[] = [];
	const perTick = datagramsPerTick(plan.ratePerSec, 1000 / plan.frameMs);

	// Publishers: contiguous slices, at most 25 to a process (§3.2).
	for (let p = 0; p < plan.publisherProcesses; p += 1) {
		const base = p * PUBLISHERS_PER_PROCESS;
		const count = Math.min(PUBLISHERS_PER_PROCESS, plan.publishers - base);
		clients.push(
			spawnClient([
				"--role",
				arm === "mutual" ? "mutual" : "publisher",
				"--sessions",
				String(count),
				"--index-base",
				String(base),
				"--index-stride",
				"1",
				"--total-publishers",
				String(plan.publishers),
				"--publishers-per-room",
				String(plan.publishersPerRoom),
				"--subscribers-per-room",
				String(plan.subscribersPerRoom),
				"--rooms",
				String(plan.rooms),
				"--rate",
				String(plan.ratePerSec),
				"--payload-bytes",
				String(plan.payloadBytes),
				"--duration-sec",
				String(DRIVE_SECONDS),
				"--process-index",
				String(p),
			]),
		);
	}

	// Subscribers: strided by the sink-process count, so a room's members land in
	// different processes and room identity stays independent of sink identity.
	if (plan.subscribers > 0) {
		for (let s = 0; s < plan.sinkProcesses; s += 1) {
			const count = Math.ceil((plan.subscribers - s) / plan.sinkProcesses);
			clients.push(
				spawnClient([
					"--role",
					"subscriber",
					"--sessions",
					String(count),
					"--index-base",
					String(s),
					"--index-stride",
					String(plan.sinkProcesses),
					"--total-publishers",
					String(plan.publishers),
					"--total-subscribers",
					String(plan.subscribers),
					"--publishers-per-room",
					String(plan.publishersPerRoom),
					"--subscribers-per-room",
					String(plan.subscribersPerRoom),
					"--rooms",
					String(plan.rooms),
					"--rate",
					"0",
					"--duration-sec",
					String(DRIVE_SECONDS),
					"--process-index",
					String(s),
				]),
			);
		}
	}

	const reports = (await Promise.all(clients.map(collect))).filter(
		(r): r is ClientReport => r !== null,
	);
	await Bun.sleep(DRAIN_GRACE_MS);

	probe.stop();
	const cpuAfter = serverCpuMs();
	const hostAfter = readHostCpu();
	const udpAfter = readUdpStats();

	// Client-side room receipts, merged across sink processes. The merge goes
	// through `mergeHistogramJson`, the same function the classifier derives
	// `aggregateOneWay` with, so there is one bucket-merging implementation.
	const received = new Map<number, { received: number; undecodable: number }>();
	const oneWayParts = new Map<number, LatencyHistogramJson[]>();
	for (const report of reports) {
		for (const room of report.rooms) {
			const acc = received.get(room.roomId) ?? { received: 0, undecodable: 0 };
			acc.received += room.received;
			acc.undecodable += room.undecodable;
			received.set(room.roomId, acc);
			const parts = oneWayParts.get(room.roomId);
			if (parts === undefined) oneWayParts.set(room.roomId, [room.oneWay]);
			else parts.push(room.oneWay);
		}
	}

	const roomRecords = [];
	for (let r = 0; r < plan.rooms; r += 1) {
		const roomState = ctx.state.roomStates.get(r) ?? freshRoom(r);
		const recv = received.get(r) ?? { received: 0, undecodable: 0 };
		const oneWay = mergeHistogramJson(oneWayParts.get(r) ?? []);
		roomRecords.push({
			roomId: r,
			ingested: roomState.ingested,
			publisherStamped: roomState.publisherStamped,
			forwarded: roomState.forwarded,
			forwardErrors: roomState.forwardErrors,
			received: recv.received,
			undecodable: recv.undecodable,
			oneWay,
			publisherToIngestP50Ns: roomState.publisherToIngest.percentile(0.5),
			publisherToIngest: roomState.publisherToIngest.toJson(),
			handlerToForward: roomState.handlerToForward.toJson(),
			forwardIssueSpread: roomState.forwardIssueSpread.toJson(),
			forwardSettle: roomState.forwardSettle.toJson(),
			frameGapFraction:
				roomState.gaps > 0 ? roomState.frameGaps / roomState.gaps : 0,
			datagramsPerTick: perTick,
			unstamped: roomState.unstamped,
		});
	}

	const publisherRecords = reports.flatMap((r) => r.publishers);

	return {
		arm,
		rooms,
		plan,
		driveWindowSec: DRIVE_SECONDS,
		roomRecords,
		publisherRecords,
		conductor: { loopLag: probe.histogram.toJson(), routing: ctx.routing },
		precheck,
		disclosures: {
			serverCpuPct: ((cpuAfter - cpuBefore) / (DRIVE_SECONDS * 1000)) * 100,
			hostCpuPct: hostCpuPct(hostBefore, hostAfter),
			udp: udpDelta(udpBefore, udpAfter),
			clientReports: reports.map((r) => ({
				role: r.role,
				processIndex: r.processIndex,
				sessionsOpened: r.sessionsOpened,
				sessionsFailed: r.sessionsFailed,
				helloErrors: r.helloErrors,
				cpuMs: r.cpuMs,
				rssMb: r.rssMb,
				errors: r.errors,
			})),
			datagramSendSyncEnv: process.env.WEBTRANSPORT_DATAGRAM_SEND_SYNC ?? null,
			datagramBatchEnv: process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? null,
			forwardEmitter: "sendDatagram-pipelined",
			placement: "on-box (publisher pool, sink pool and server co-resident)",
		},
	};
}

/* -------------------------------------------------------------------------- */
/* V-S — the sink pre-check                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Drive 1.5× the rung's forward load into the rung's own sink pool shape, with
 * no fan-out arm live, and see whether the sink holds the arm's bars.
 *
 * The originator here is the conductor, so `actual` is the server's clock and
 * the sink's one-way is server→sink. That is the right quantity: the question is
 * whether the sink can absorb this rate at all, not what the whole path costs.
 *
 * The pacer is cumulative-deadline over a 5 ms slice grid and **cannot
 * overshoot** (G5b's discipline), so a delivered figure can never come from a
 * burst. If it cannot source the rate it says so — `generatorSaturated` — and
 * `sinkPrecheckVerdict` reads that as *inconclusive*, never as a pass, because a
 * saturated originator offering less load looks exactly like a healthy sink.
 */
async function runPrecheck(
	plan: ReturnType<typeof rungPlan>,
	ctx: { clock: MonotonicClock; state: ConductorState },
): Promise<{
	offeredPerSec: number;
	deliveryRatio: number | null;
	oneWayP99Ns: number | null;
	generatorSaturated: boolean;
	sinkProcesses: number;
	targetPerSec: number;
	sent: number;
	sendErrors: number;
	windowSec: number;
}> {
	resetConductor(ctx.state, plan);
	const target = plan.sinkPrecheckOfferedPerSec;
	const processes = plan.sinkProcesses;
	const sessionsTotal = plan.sinkSessions;
	const clients: SpawnedClient[] = [];
	for (let s = 0; s < processes; s += 1) {
		const count = Math.ceil((sessionsTotal - s) / processes);
		clients.push(
			spawnClient([
				"--role",
				"subscriber",
				"--sessions",
				String(count),
				"--index-base",
				String(s),
				"--index-stride",
				String(processes),
				"--total-subscribers",
				String(sessionsTotal),
				"--subscribers-per-room",
				String(Math.max(1, Math.round(sessionsTotal / plan.rooms))),
				"--rooms",
				String(plan.rooms),
				"--rate",
				"0",
				"--duration-sec",
				String(PRECHECK_SECONDS),
				"--process-index",
				String(s),
			]),
		);
	}

	// Wait for the pool to join before pacing anything at it.
	const joinDeadline = Date.now() + PRECHECK_JOIN_SECONDS * 1000;
	while (
		ctx.state.table.memberCount < sessionsTotal &&
		Date.now() < joinDeadline
	) {
		await Bun.sleep(100);
	}

	const members: RoomMember<SessionSink>[] = [];
	for (const room of ctx.state.table.rooms()) members.push(...room.members);

	const payload = new Uint8Array(plan.payloadBytes);
	let sent = 0;
	let sendErrors = 0;
	const startNs = ctx.clock.now();
	const endNs = startNs + PRECHECK_SECONDS * 1e9;
	const sliceNs = PRECHECK_SLICE_MS * 1e6;
	// The quota is cumulative, not per-slice: `round(target × elapsed) − sent`.
	// A per-slice quota of `round(target / slices)` quantises upward — at
	// target 1,500 over 200 slices it offers 1,600/s — and an offered figure
	// above the plan is exactly what G5b's discipline exists to make impossible.
	let cursor = 0;
	for (let n = 1; members.length > 0; n += 1) {
		const dueNs = startNs + n * sliceNs;
		if (dueNs >= endNs) break;
		const waitMs = (dueNs - ctx.clock.now()) / 1e6;
		if (waitMs > 0) await Bun.sleep(waitMs);
		// Cumulative deadline: a late slice sends its own quota and no more, so
		// the offered total is bounded by the plan whatever the loop did.
		const pending: Promise<void>[] = [];
		const dueTotal = Math.floor((target * (n * sliceNs)) / 1e9);
		const quota = Math.max(0, dueTotal - sent);
		for (let i = 0; i < quota; i += 1) {
			const member = members[cursor % members.length];
			cursor += 1;
			if (member === undefined || !member.session.alive) continue;
			encodeStamp(payload, {
				intendedNs: dueNs,
				actualNs: ctx.clock.now(),
				sequence: sent,
				klass: CLASS_ROOM_MEDIA,
				version: 3,
			});
			pending.push(member.session.sendDatagram(payload.slice()));
			sent += 1;
		}
		void Promise.allSettled(pending).then((results) => {
			for (const r of results) if (r.status === "rejected") sendErrors += 1;
		});
	}
	const windowSec = (ctx.clock.now() - startNs) / 1e9;

	const reports = (await Promise.all(clients.map(collect))).filter(
		(r): r is ClientReport => r !== null,
	);
	let receivedTotal = 0;
	const parts: LatencyHistogramJson[] = [];
	for (const report of reports) {
		for (const room of report.rooms) {
			receivedTotal += room.received;
			parts.push(room.oneWay);
		}
	}
	const merged = mergeHistogramJson(parts);
	const offeredPerSec = windowSec > 0 ? sent / windowSec : 0;
	return {
		offeredPerSec,
		deliveryRatio: sent > 0 ? receivedTotal / sent : null,
		oneWayP99Ns: merged.count > 0 ? p99Of(merged) : null,
		// The registered originator-honesty rule for this arm: an originator that
		// sourced less than 90% of the plan is not evidence about the sink.
		generatorSaturated: offeredPerSec < 0.9 * target || members.length === 0,
		sinkProcesses: processes,
		targetPerSec: target,
		sent,
		sendErrors,
		windowSec,
	};
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
	// FFI read, not the `Bun.nanoseconds()` fast path: the gate's evidence chain
	// must not carry the fast path's same-counter assumption.
	const clock = await createMonotonicClock(false);
	const tls = generateLocalhostCert();
	if (tls === null)
		throw new Error("bench-g8: could not generate a localhost cert");

	// One state object, held by reference. An earlier draft reassigned `table`
	// per rung and the `onSession` closure kept joining the previous rung's
	// table, so the pre-check saw an empty room map and offered nothing. The
	// smoke caught it; the shape below makes it unrepresentable.
	const state: ConductorState = {
		table: new RoomTable<SessionSink>(),
		roomStates: new Map<number, RoomState>(),
		nextHandle: 0,
		framePeriodNs: 20e6,
	};

	const topPlan = rungPlan("voice", Math.max(...ladderFor("voice")));
	const server = createServer({
		port: PORT,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: topPlan.sessions * 2,
			maxHandshakesInFlight: topPlan.sessions * 2,
			idleTimeoutMs: 300_000,
			maxDatagramSize: 1500,
		},
		rateLimits: {
			// Every limiter is above the arm on purpose: a run that trips one is
			// measuring configuration. The deltas are published either way.
			handshakesPerSec: topPlan.sessions * 2,
			handshakesBurst: topPlan.sessions * 2,
			handshakesBurstPerPrefix: topPlan.sessions * 2,
			streamsPerSec: 1000,
			streamsBurst: 2000,
			datagramsPerSec: 500_000,
			datagramsBurst: 1_000_000,
		},
		onSession: (session) => {
			const handle = state.nextHandle++;
			const sink: SessionSink = {
				sendDatagram: (d) => session.sendDatagram(d),
				alive: true,
			};
			session.closed.then(
				() => {
					sink.alive = false;
				},
				() => {
					sink.alive = false;
				},
			);
			void (async () => {
				let member: RoomMember<SessionSink> | null = null;
				let room: RoomState | null = null;
				for await (const datagram of session.incomingDatagrams()) {
					// First statement of the handler body: the server's dwell for
					// this arrival starts here and nowhere later.
					const entryNs = clock.now();
					const stamp = decodeStamp(datagram);
					if (stamp === null) {
						if (room !== null) room.unstamped += 1;
						continue;
					}
					if (stamp.klass === CLASS_ROOM_JOIN) {
						if (member !== null) continue;
						const roomId = stamp.sequence;
						member = { handle, roomId, session: sink };
						state.table.join(member);
						room = state.roomStates.get(roomId) ?? freshRoom(roomId);
						state.roomStates.set(roomId, room);
						continue;
					}
					if (stamp.klass !== CLASS_ROOM_MEDIA || room === null) continue;

					room.ingested += 1;
					room.publisherStamped += 1;
					room.publisherToIngest.record(entryNs - stamp.actualNs);
					// Gaps are per publisher inside the room, so a mutual room's P
					// interleaved streams do not destroy each other's cadence.
					const prev = room.lastArrivalByHandle.get(handle);
					if (prev !== undefined) {
						room.gaps += 1;
						if (entryNs - prev >= state.framePeriodNs / 2) room.frameGaps += 1;
					}
					room.lastArrivalByHandle.set(handle, entryNs);

					// The forward. Pipelined per-target `sendDatagram`, settled
					// together — G4's registered emitter, unchanged (§0 K10).
					const pending: Promise<void>[] = [];
					let firstIssueNs = 0;
					const issued = forwardTargets(state.table, handle, (target) => {
						if (!target.session.alive) return;
						if (firstIssueNs === 0) firstIssueNs = clock.now();
						pending.push(target.session.sendDatagram(datagram));
					});
					if (issued === 0 || firstIssueNs === 0) continue;
					const lastIssueNs = clock.now();
					room.handlerToForward.record(firstIssueNs - entryNs);
					room.forwardIssueSpread.record(lastIssueNs - firstIssueNs);
					room.forwarded += issued;
					const settleRoom = room;
					void Promise.allSettled(pending).then((results) => {
						settleRoom.forwardSettle.record(clock.now() - firstIssueNs);
						for (const r of results) {
							if (r.status === "rejected") settleRoom.forwardErrors += 1;
						}
					});
				}
			})();
		},
	});

	// V-H(a) runs once, before any arm, on an otherwise idle box: it is a
	// property of the router, not of the load.
	const routing = benchmarkRouting(
		[...new Set(G8_ARMS.flatMap(ladderFor))].sort((a, b) => a - b),
		11,
		ROUTING_ARRIVALS,
	);
	console.log(`bench-g8: routing microbench ${JSON.stringify(routing)}`);

	const rungs: RungOutput[] = [];
	for (const arm of ARMS) {
		for (const rooms of ladderFor(arm)) {
			console.log(`bench-g8: arm=${arm} rooms=${rooms}`);
			const output = await runRung(arm, rooms, { clock, state, routing });
			rungs.push(output);
			await Bun.sleep(SETTLE_SECONDS * 1000);
		}
	}

	writeFileSync(
		OUT_JSON,
		`${JSON.stringify(
			{
				registration: "docs/research/preregistrations/gate-g8-many-rooms.md",
				generatedAt: new Date().toISOString(),
				clock: {
					source: clock.source,
					calibrationResidualNs: clock.calibrationResidualNs,
					calibrationSpreadNs: clock.calibrationSpreadNs,
				},
				pools: {
					publishersPerProcess: PUBLISHERS_PER_PROCESS,
					subscribersPerProcess: SUBSCRIBERS_PER_PROCESS,
				},
				rungs,
			},
			null,
			1,
		)}\n`,
	);
	console.log(`bench-g8: wrote ${OUT_JSON}`);

	await Promise.race([server.close(), Bun.sleep(5000)]);
	for (const child of activeChildren) {
		try {
			child.kill("SIGKILL");
		} catch {
			// already gone
		}
	}
	process.exit(0);
}

await main();
