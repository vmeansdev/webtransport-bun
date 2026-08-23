#!/usr/bin/env bun
/**
 * G6's conductor: the MMO realm server, the batched snapshot emitter, the ack
 * path the round trip is measured on, the raid forward, and the storm's
 * server-side accept series.
 *
 * Registration: `docs/research/preregistrations/gate-g6-mmo.md`. Rates come from
 * `g6-plan.ts` and verdicts from `g6-classify.ts`, so nothing in this file is a
 * threshold — it offers the registered load and records what happened.
 *
 * Four things here are deliberate and are the reason this is not
 * `bench-session-scale` with more sessions:
 *
 * 1. **The emitter is server-originated and batched.** Each session's snapshot
 *    is one `sendDatagramBatch` of three datagrams, and the tick is spread over
 *    a 20 ms slice grid rather than issued as one impulse — the egress mirror of
 *    the kernel-drop mechanism T02 attributed on the ingest side.
 * 2. **The ack path is separate from the snapshot path.** Snapshots are
 *    interpolated client-side and are graded on delivery only; acks are issued
 *    on receipt and carry the round trip. Grading them together would measure
 *    the world tick's own quantization and call it latency.
 * 3. **The accept series is the server's.** `onSession` timestamps every
 *    established session here. The client's connect pacing is recorded, never
 *    used — the four-axes retraction showed the previous accept figures were
 *    Little's law on the generator's permit pool.
 * 4. **Survivors are identified server-side**, by whether their session existed
 *    before the sever instant. §5.3 needs the survivor clause computed over the
 *    survivor cohort alone, and this is the only place that distinction is
 *    observable without trusting the client's account of who it severed.
 *
 * Not a gate on its own: it writes an artifact, and the gate agent recomputes
 * every clause from the raw fields.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	appendFileSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	ACTION_HZ,
	actionEveryNthTick,
	armShape,
	EMITTER_SLICE_HZ,
	MOVE_HZ,
	preflightRequirements,
	RAID_MEMBERS,
	RAID_PUBLISHER_HZ,
	REALM_LADDER,
	SNAPSHOT_HZ,
	SNAPSHOT_PAYLOAD_BYTES,
	STORM_RECONNECT_DELAY_MS,
	snapshotDatagrams,
	stormCohorts,
	stormWindowSec,
	UPSTREAM_PAYLOAD_BYTES,
} from "./g6-plan.ts";
import { createMonotonicClock } from "./latency-clock.ts";
import { LatencyHistogram } from "./latency-histogram.ts";
import {
	CLASS_ACK,
	CLASS_ACTION,
	CLASS_RAID,
	CLASS_RAID_JOIN,
	CLASS_SNAPSHOT,
	decodeStamp,
	encodeStamp,
	STAMP_BYTES_V3,
	writeReflection,
} from "./latency-stamp.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/mmo-client`;
const PORT = parseInt(process.env.G6_PORT ?? "4433", 10);

/** Which arms to run. `steady` alone is the ladder; the others add to it. */
const ARMS = (process.env.G6_ARMS ?? "steady,hotspot,storm")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const LADDER = (process.env.G6_LADDER ?? REALM_LADDER.join(","))
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
const STEADY_SECONDS = parseInt(process.env.G6_STEADY_SECONDS ?? "120", 10);
const IDLE_SECONDS = parseInt(process.env.G6_IDLE_SECONDS ?? "30", 10);
const SETTLE_SECONDS = parseInt(process.env.G6_SETTLE_SECONDS ?? "15", 10);
const DRAIN_GRACE_MS = parseInt(process.env.G6_DRAIN_GRACE_MS ?? "1000", 10);
const SAMPLE_INTERVAL_MS = parseInt(process.env.G6_SAMPLE_MS ?? "2000", 10);
const ENDPOINTS = parseInt(process.env.G6_ENDPOINTS ?? "64", 10);
const CONNECT_CONCURRENCY = parseInt(
	process.env.G6_CONNECT_CONCURRENCY ?? "500",
	10,
);
const CONNECT_TIMEOUT_SECONDS = parseInt(
	process.env.G6_CONNECT_TIMEOUT_SECONDS ?? "300",
	10,
);
/**
 * The generator host. Empty means co-resident, which for this gate is a **local
 * smoke only** — the registration requires the Mac over the cable, and a
 * co-resident run can never be a G6 result.
 */
const OFFBOX_SSH = process.env.G6_OFFBOX_SSH ?? "";
/**
 * The candidate SHA the Mac entrypoint checks out and builds. Required for
 * any off-box run: the entrypoint exits 3 without it, which is exactly the
 * spawn fault O-1 documented — every generator dead before it ran.
 */
const CANDIDATE_SHA = process.env.G6_CANDIDATE_SHA ?? "";
/**
 * mmo_client.rs:152 sleeps a hardcoded 60 s after the storm window before its
 * settle read. Named here because the entrypoint's watchdog deadline must
 * cover it — O-2's arithmetic showed the old fixed 300 s deadline fired at
 * least 31 s before a storm-arm generator could finish.
 */
const POST_STORM_SECONDS = 60;
const OUT_JSON = process.env.G6_OUT ?? join(ROOT, "tools/load/bench-g6.json");
const OUT_CSV = OUT_JSON.replace(/\.json$/, ".csv");
const HAS_PROC = process.platform === "linux";

const SNAPSHOT_DATAGRAMS = snapshotDatagrams();
const SLICE_MS = 1000 / EMITTER_SLICE_HZ;
const SLICES_PER_TICK = Math.max(1, Math.round(EMITTER_SLICE_HZ / SNAPSHOT_HZ));

/* -------------------------------------------------------------------------- */
/* Host taps — same readers the session-scale ladder uses, same reasons        */
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

function hostCpuPct(
	a: CpuSnapshot | null,
	b: CpuSnapshot | null,
): number | null {
	if (!a || !b || b.total <= a.total) return null;
	return (
		((b.busy - a.busy) / (b.total - a.total)) *
		100 *
		(navigator?.hardwareConcurrency ?? 1)
	);
}

function serverCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

function procStatusKb(path: string, key: string): number | null {
	if (!HAS_PROC) return null;
	try {
		const line = readFileSync(path, "utf8")
			.split("\n")
			.find((l) => l.startsWith(key));
		const kb = line?.split(/\s+/)[1];
		return kb === undefined ? null : Number(kb);
	} catch {
		return null;
	}
}

function serverMem(): { rssMb: number; committedMb: number | null } {
	const rss = process.memoryUsage.rss() / 1024 / 1024;
	const anon = procStatusKb("/proc/self/status", "RssAnon:");
	const swap = procStatusKb("/proc/self/status", "VmSwap:");
	const committed = anon === null ? null : (anon + (swap ?? 0)) / 1024;
	return { rssMb: rss, committedMb: committed };
}

function hostMemAvailableMb(): number | null {
	if (!HAS_PROC) return null;
	try {
		const line = readFileSync("/proc/meminfo", "utf8")
			.split("\n")
			.find((l) => l.startsWith("MemAvailable:"));
		const kb = line?.split(/\s+/)[1];
		return kb === undefined ? null : Number(kb) / 1024;
	} catch {
		return null;
	}
}

type KernelUdp = Record<string, number>;

/**
 * Per-socket drop counter for the bench port, from `/proc/net/udp`. The primary
 * kernel tap; `/proc/net/snmp RcvbufErrors` is host-wide and therefore an upper
 * bound. A tap that cannot read returns null and is reported as null — "we saw
 * no drops" and "we could not look" are different statements.
 */
function readServerSocketDrops(): number | null {
	if (!HAS_PROC) return null;
	try {
		let drops: number | null = null;
		for (const file of ["/proc/net/udp", "/proc/net/udp6"]) {
			let text: string;
			try {
				text = readFileSync(file, "utf8");
			} catch {
				continue;
			}
			for (const line of text.split("\n").slice(1)) {
				const cols = line.trim().split(/\s+/);
				const local = cols[1];
				if (!local) continue;
				const port = parseInt(local.split(":")[1] ?? "", 16);
				if (port !== PORT) continue;
				const d = Number(cols[cols.length - 1]);
				if (Number.isFinite(d)) drops = (drops ?? 0) + d;
			}
		}
		return drops;
	} catch {
		return null;
	}
}

function readKernelUdp(): KernelUdp | null {
	if (!HAS_PROC) return null;
	try {
		const lines = readFileSync("/proc/net/snmp", "utf8").split("\n");
		const header = lines.find((l) => l.startsWith("Udp:"));
		const values = lines.find(
			(l, i) => l.startsWith("Udp:") && i > lines.indexOf(header ?? ""),
		);
		if (!header || !values) return null;
		const keys = header.trim().split(/\s+/).slice(1);
		const nums = values.trim().split(/\s+/).slice(1).map(Number);
		const out: KernelUdp = {};
		keys.forEach((k, i) => {
			const v = nums[i];
			if (v !== undefined) out[k] = v;
		});
		const socketDrops = readServerSocketDrops();
		if (socketDrops !== null) out.serverSocketDrops = socketDrops;
		return out;
	} catch {
		return null;
	}
}

function diffKernelUdp(
	a: KernelUdp | null,
	b: KernelUdp | null,
): KernelUdp | null {
	if (!a || !b) return null;
	const out: KernelUdp = {};
	for (const k of Object.keys(b)) {
		const from = a[k];
		const to = b[k];
		if (from !== undefined && to !== undefined) out[k] = to - from;
	}
	return out;
}

/* -------------------------------------------------------------------------- */
/* Child process lifetime                                                      */
/* -------------------------------------------------------------------------- */

const activeChildren = new Set<ChildProcess>();

function killChildren(signal: NodeJS.Signals = "SIGKILL"): void {
	for (const child of activeChildren) {
		if (child.pid !== undefined) {
			try {
				process.kill(-child.pid, signal);
			} catch {
				// Group already reaped, or the child never led one.
			}
		}
		try {
			child.kill(signal);
		} catch {
			// Nothing left to kill.
		}
	}
}

process.on("exit", () => killChildren("SIGKILL"));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {
		killChildren("SIGKILL");
		process.exit(128);
	});
}

/* -------------------------------------------------------------------------- */
/* The realm server                                                            */
/* -------------------------------------------------------------------------- */

type SessionKind = "player" | "publisher" | "raid";

type Player = {
	send: (datagrams: readonly Uint8Array[]) => Promise<{
		sent: number;
		error?: unknown;
	}>;
	sendOne: (d: Uint8Array) => unknown;
	/** Server-clock instant this session became established. */
	acceptedAtMs: number;
	kind: SessionKind;
	alive: boolean;
};

type EmitterCounters = {
	snapshotIssued: number;
	snapshotDue: number;
	ackIssued: number;
	ackDue: number;
	raidForwarded: number;
	sendErrors: number;
	sendEventsSkipped: number;
	batchPartialCompletions: number;
};

type ServerState = {
	rxByClass: Map<number, number>;
	rxTotal: number;
	rxUnstamped: number;
	/** Upstream arrivals on sessions established before the sever instant. */
	rxSurvivors: number;
	/** Server-clock accept completions, one entry per established session. */
	acceptSeries: number[];
	emitter: EmitterCounters;
	/** Publisher→first-forward lag, the ingest-reality falsifier's input. */
	ingestToForward: LatencyHistogram;
	/** Server-observed inter-arrival gaps on the publisher session. */
	publisherGaps: number[];
	publisherStamped: number;
	publisherArrivals: number;
	/** Emitter slice lag at the scheduler handoff — never across `await send`. */
	emitterLag: LatencyHistogram;
	/** Server dwell on the ack path, the disclosure beside C3. */
	hold: LatencyHistogram;
};

function freshState(): ServerState {
	return {
		rxByClass: new Map(),
		rxTotal: 0,
		rxUnstamped: 0,
		rxSurvivors: 0,
		acceptSeries: [],
		emitter: {
			snapshotIssued: 0,
			snapshotDue: 0,
			ackIssued: 0,
			ackDue: 0,
			raidForwarded: 0,
			sendErrors: 0,
			sendEventsSkipped: 0,
			batchPartialCompletions: 0,
		},
		ingestToForward: new LatencyHistogram(),
		publisherGaps: [],
		publisherStamped: 0,
		publisherArrivals: 0,
		emitterLag: new LatencyHistogram(),
		hold: new LatencyHistogram(),
	};
}

async function main(): Promise<void> {
	if (LADDER.length === 0) throw new Error("G6_LADDER parsed empty");
	console.log("bench-g6: building mmo-client (release)...");
	try {
		await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin mmo-client --release`.quiet();
	} catch (err) {
		if (!(await Bun.file(CLIENT_BIN).exists())) throw err;
		console.warn(
			"bench-g6: cargo build failed; using existing mmo-client binary",
		);
	}

	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	// FFI read, not the `Bun.nanoseconds()` fast path: the gate's evidence chain
	// must not carry the fast path's same-counter assumption.
	const clock = await createMonotonicClock(false);
	let state = freshState();
	const players: Player[] = [];
	const raidMembers: Player[] = [];
	/**
	 * Server-clock instant the storm severed its cohort. Sessions accepted
	 * before it are the survivors; sessions accepted after it are the cohort
	 * coming back. Null outside the storm arm.
	 */
	let severAtMs: number | null = null;

	const topSessions = Math.max(...LADDER) + RAID_MEMBERS + 1;
	const shape = armShape(Math.max(...LADDER));
	const server = createServer({
		port: PORT,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: topSessions * 2,
			maxHandshakesInFlight: topSessions * 2,
			// The storm severs and reconnects a whole realm; a 60 s idle timeout
			// would reap sessions mid-arm on a busy host.
			idleTimeoutMs: 300_000,
			maxDatagramSize: SNAPSHOT_PAYLOAD_BYTES + 64,
		},
		rateLimits: {
			// Every limiter is set above the arm on purpose: a run that trips one
			// measures configuration. S-C2 reads the deltas and fails on any.
			handshakesPerSec: topSessions * 2,
			handshakesBurst: topSessions * 2,
			handshakesBurstPerPrefix: topSessions * 2,
			streamsPerSec: 1000,
			streamsBurst: 2000,
			datagramsPerSec: Math.max(shape.upstreamAggregatePps * 8, 200_000),
			datagramsBurst: Math.max(shape.upstreamAggregatePps * 16, 400_000),
		},
		onSession: (session) => {
			const acceptedAtMs = Date.now();
			state.acceptSeries.push(acceptedAtMs);
			const player: Player = {
				send: (datagrams) => session.sendDatagramBatch(datagrams),
				sendOne: (d) => session.sendDatagram(d),
				acceptedAtMs,
				kind: "player",
				alive: true,
			};
			players.push(player);
			session.closed.then(
				() => {
					player.alive = false;
				},
				() => {
					player.alive = false;
				},
			);
			void (async () => {
				let lastPublisherArrivalNs: number | null = null;
				for await (const datagram of session.incomingDatagrams()) {
					// First statement of the handler body: this instant is where
					// the server's own dwell starts.
					const entryNs = clock.now();
					state.rxTotal += 1;
					const stamp = decodeStamp(datagram);
					if (stamp === null) {
						state.rxUnstamped += 1;
						continue;
					}
					state.rxByClass.set(
						stamp.klass,
						(state.rxByClass.get(stamp.klass) ?? 0) + 1,
					);
					if (severAtMs !== null && player.acceptedAtMs < severAtMs) {
						state.rxSurvivors += 1;
					}

					if (stamp.klass === CLASS_RAID_JOIN) {
						player.kind = "raid";
						if (!raidMembers.includes(player)) raidMembers.push(player);
						continue;
					}

					if (stamp.klass === CLASS_RAID) {
						player.kind = "publisher";
						state.publisherArrivals += 1;
						state.publisherStamped += 1;
						if (lastPublisherArrivalNs !== null) {
							state.publisherGaps.push(entryNs - lastPublisherArrivalNs);
						}
						lastPublisherArrivalNs = entryNs;
						forwardToRaid(datagram, entryNs, state, raidMembers, clock);
						continue;
					}

					if (stamp.klass === CLASS_ACTION) {
						// Issued on receipt, not on the world tick: holding the
						// confirm for the next snapshot would cost up to a full
						// tick of quantization and the budget does not have it.
						state.emitter.ackDue += 1;
						const ack = new Uint8Array(STAMP_BYTES_V3);
						ack.set(datagram.subarray(0, STAMP_BYTES_V3));
						const sendNs = clock.now();
						const ok = writeReflection(ack, {
							echoActualNs: stamp.actualNs,
							serverSendNs: sendNs,
							holdNs: sendNs - entryNs,
							klass: CLASS_ACK,
							sequence: stamp.sequence,
						});
						if (!ok) {
							state.emitter.sendEventsSkipped += 1;
							continue;
						}
						state.hold.record(sendNs - entryNs);
						try {
							player.sendOne(ack);
							state.emitter.ackIssued += 1;
						} catch {
							state.emitter.sendErrors += 1;
						}
					}
				}
			})().catch(() => {});
		},
	});
	await Bun.sleep(3000);
	console.log(
		`bench-g6: server up on ${PORT}; ladder=[${LADDER.join(",")}] arms=[${ARMS.join(",")}] snapshot=${SNAPSHOT_DATAGRAMS}x${SNAPSHOT_PAYLOAD_BYTES}B@${SNAPSHOT_HZ}Hz slices=${SLICES_PER_TICK}`,
	);

	writeFileSync(
		OUT_CSV,
		"arm,sessions,ts_ms,phase,windowMs,hostCpuPct,serverCpuPct,serverRssMb,serverCommittedMb,memAvailableMb,sessionsActive,rxDelta,snapshotIssuedDelta,ackIssuedDelta\n",
	);

	const arms: unknown[] = [];
	const startedAt = new Date().toISOString();
	let aborted: string | null = null;

	const buildResult = () => ({
		version: 1,
		schema: "bench-g6/1",
		startedAt,
		writtenAt: new Date().toISOString(),
		complete: aborted === null && arms.length > 0,
		preRegistration: "docs/research/preregistrations/gate-g6-mmo.md",
		host: {
			platform: process.platform,
			cpus: navigator?.hardwareConcurrency ?? null,
			bunVersion: Bun.version,
			/** Empty means the generator was co-resident: a smoke, never a G6 result. */
			offboxSsh: OFFBOX_SSH || null,
		},
		config: {
			ladder: LADDER,
			arms: ARMS,
			movePps: MOVE_HZ,
			actionPps: ACTION_HZ,
			actionEvery: actionEveryNthTick(),
			upstreamPayloadBytes: UPSTREAM_PAYLOAD_BYTES,
			snapshotHz: SNAPSHOT_HZ,
			snapshotDatagrams: SNAPSHOT_DATAGRAMS,
			snapshotPayloadBytes: SNAPSHOT_PAYLOAD_BYTES,
			emitterSliceHz: EMITTER_SLICE_HZ,
			raidMembers: RAID_MEMBERS,
			raidPublisherHz: RAID_PUBLISHER_HZ,
			steadySeconds: STEADY_SECONDS,
			idleSeconds: IDLE_SECONDS,
			stormWindowSec: stormWindowSec(),
			stormCohorts: stormCohorts(Math.max(...LADDER)),
			stormReconnectDelayMs: STORM_RECONNECT_DELAY_MS,
			// Recorded because it is a live maintainer ruling and it changes the
			// path every ack takes (disclosure ledger K15).
			datagramSendSync: process.env.WEBTRANSPORT_DATAGRAM_SEND_SYNC ?? null,
		},
		preflightRequirements: preflightRequirements(Math.max(...LADDER)),
		arms,
		aborted,
	});

	const flush = () => {
		const tmp = `${OUT_JSON}.partial`;
		writeFileSync(tmp, `${JSON.stringify(buildResult(), null, 2)}\n`);
		renameSync(tmp, OUT_JSON);
	};

	try {
		for (const sessions of LADDER) {
			if (!ARMS.includes("steady")) break;
			arms.push(
				await runArm({
					name: `steady-${sessions}`,
					sessions,
					server,
					state: () => state,
					resetState: () => {
						state = freshState();
					},
					players,
					raidMembers,
					clock,
					hotspot: false,
					stormCohort: 0,
					setSeverAt: (v) => {
						severAtMs = v;
					},
				}),
			);
			flush();
			await drainBetweenArms(server, players, raidMembers);
		}

		if (ARMS.includes("hotspot")) {
			arms.push(
				await runArm({
					name: `hotspot-${Math.max(...LADDER)}`,
					sessions: Math.max(...LADDER),
					server,
					state: () => state,
					resetState: () => {
						state = freshState();
					},
					players,
					raidMembers,
					clock,
					hotspot: true,
					stormCohort: 0,
					setSeverAt: (v) => {
						severAtMs = v;
					},
				}),
			);
			flush();
			await drainBetweenArms(server, players, raidMembers);
		}

		if (ARMS.includes("storm")) {
			for (const cohort of stormCohorts(Math.max(...LADDER))) {
				arms.push(
					await runArm({
						name: `storm-${cohort}`,
						sessions: Math.max(...LADDER),
						server,
						state: () => state,
						resetState: () => {
							state = freshState();
						},
						players,
						raidMembers,
						clock,
						hotspot: false,
						stormCohort: cohort,
						setSeverAt: (v) => {
							severAtMs = v;
						},
					}),
				);
				flush();
				await drainBetweenArms(server, players, raidMembers);
			}
		}
	} catch (err) {
		aborted = String(err);
		console.error(`bench-g6: aborted — ${aborted}`);
	}

	flush();
	killChildren("SIGKILL");
	await Promise.race([server.close(), Bun.sleep(5000)]);
	console.log(`bench-g6: wrote ${OUT_JSON}`);
}

/** Forward one publisher datagram to every raid member (§3). */
function forwardToRaid(
	datagram: Uint8Array,
	entryNs: number,
	state: ServerState,
	raidMembers: Player[],
	clock: { now: () => number },
): void {
	let first = true;
	for (const member of raidMembers) {
		if (!member.alive) continue;
		// Copied per member: the payload leaves this loop and the caller's
		// buffer is not ours to keep.
		const out = new Uint8Array(datagram.byteLength);
		out.set(datagram);
		try {
			member.sendOne(out);
			state.emitter.raidForwarded += 1;
			if (first) {
				// Server-internal dwell: arrival → first forward issued, both on
				// the *server's* clock. Reported as a disclosure and expected to
				// be µs-scale, because it is entirely inside one process.
				//
				// It is NOT the ingest-reality falsifier's input. Ticket 14's
				// rule reads "publisher-send → first forward", which on-box was
				// one clock and off-box is two hosts — un-differenceable. The
				// off-box replacement is the subscriber's own one-way, which
				// spans the whole path on one clock (Amendment 2).
				state.ingestToForward.record(clock.now() - entryNs);
				first = false;
			}
		} catch {
			state.emitter.sendErrors += 1;
		}
	}
}

/**
 * The snapshot emitter: one `sendDatagramBatch` per session per world tick,
 * spread across a 20 ms slice grid.
 *
 * Its lag is measured at the **scheduler handoff** — the interval between the
 * slice's scheduled deadline and the instant the batch is handed to the send
 * path — and never across `await send(...)`. Measuring across the await was
 * G3's defect 1: the metric absorbed the product's own send latency and then
 * the product was judged by it.
 */
function startEmitter(
	players: Player[],
	state: ServerState,
	clock: { now: () => number },
): () => void {
	const body = new Uint8Array(SNAPSHOT_PAYLOAD_BYTES);
	body.fill(0x77);
	let slice = 0;
	let sequence = 0;
	let stopped = false;
	const startedNs = clock.now();
	const timer = setInterval(() => {
		if (stopped) return;
		const deadlineNs = startedNs + slice * SLICE_MS * 1e6;
		const handoffNs = clock.now();
		state.emitterLag.record(Math.max(0, handoffNs - deadlineNs));
		const target = players.filter((p) => p.alive && p.kind === "player");
		const perSlice = Math.ceil(target.length / SLICES_PER_TICK);
		const from = (slice % SLICES_PER_TICK) * perSlice;
		const chunk = target.slice(from, from + perSlice);
		slice += 1;
		for (const player of chunk) {
			sequence += 1;
			const batch: Uint8Array[] = [];
			for (let k = 0; k < SNAPSHOT_DATAGRAMS; k += 1) {
				const d = new Uint8Array(SNAPSHOT_PAYLOAD_BYTES);
				d.set(body);
				encodeStamp(d, {
					version: 3,
					intendedNs: deadlineNs,
					actualNs: handoffNs,
					sequence: sequence * SNAPSHOT_DATAGRAMS + k,
					klass: CLASS_SNAPSHOT,
				});
				batch.push(d);
			}
			state.emitter.snapshotDue += SNAPSHOT_DATAGRAMS;
			// Fire-and-account: the batch envelope is `{sent, code}` and a
			// partial completion is a real outcome, counted rather than
			// forgiven. Awaiting here would serialize the slice and turn the
			// emitter into the thing being measured.
			player
				.send(batch)
				.then((res) => {
					state.emitter.snapshotIssued += res.sent;
					if (res.sent < batch.length) {
						state.emitter.batchPartialCompletions += 1;
					}
				})
				.catch(() => {
					state.emitter.sendErrors += 1;
				});
		}
	}, SLICE_MS);
	timer.unref?.();
	return () => {
		stopped = true;
		clearInterval(timer);
	};
}

type ArmOptions = {
	name: string;
	sessions: number;
	server: ReturnType<typeof createServer>;
	state: () => ServerState;
	resetState: () => void;
	players: Player[];
	raidMembers: Player[];
	clock: { now: () => number; source: string };
	hotspot: boolean;
	stormCohort: number;
	setSeverAt: (v: number | null) => void;
};

type Marks = {
	start: Boundary | null;
	steadyStart: Boundary | null;
	steadyMark: Boundary | null;
	steadyEnd: Boundary | null;
	stormStart: Boundary | null;
	stormEnd: Boundary | null;
	idleEnd: Boundary | null;
};

type Boundary = {
	rx: number;
	snapshotIssued: number;
	ackIssued: number;
	cpuMs: number;
	wallMs: number;
	kernel: KernelUdp | null;
	metrics: ReturnType<ReturnType<typeof createServer>["metricsSnapshot"]>;
};

async function runArm(o: ArmOptions): Promise<unknown> {
	o.players.length = 0;
	o.raidMembers.length = 0;
	o.resetState();
	o.setSeverAt(null);
	const shape = armShape(o.sessions);
	console.log(
		`bench-g6: arm ${o.name} sessions=${o.sessions} up=${shape.upstreamAggregatePps}/s down=${shape.downstreamAggregatePps}/s storm=${o.stormCohort}`,
	);

	const stopEmitter = startEmitter(o.players, o.state(), o.clock);
	// O-2's arithmetic, computed from the same constants the argv carries,
	// with the macgen 1.5x allowance. The entrypoint's watchdog arms after its
	// build, so this covers only the client's own phases.
	const realmDeadlineSec = Math.ceil(
		1.5 *
			(CONNECT_TIMEOUT_SECONDS +
				STEADY_SECONDS +
				(o.stormCohort > 0
					? Math.ceil(STORM_RECONNECT_DELAY_MS / 1000) +
						stormWindowSec() +
						POST_STORM_SECONDS
					: 0) +
				IDLE_SECONDS),
	);
	const sideDeadlineSec = Math.ceil(
		1.5 * (CONNECT_TIMEOUT_SECONDS + STEADY_SECONDS + IDLE_SECONDS),
	);
	const cloneFor = new Map<string, string | null>();
	// Pre-provision each concurrent role's clone BEFORE any spawn, so the three
	// macgen invocations never share one worktree (index.lock race, run
	// 32662000300 hotspot null-subscriber).
	for (const role of o.hotspot
		? ["realm", "raid-subscriber", "publisher"]
		: ["realm"]) {
		cloneFor.set(role, await macgenCloneFor(role));
	}
	const realm = spawnClient(
		[
			"--role",
			"realm",
			"--sessions",
			String(o.sessions),
			"--send-interval-ms",
			String(Math.round(1000 / MOVE_HZ)),
			"--action-every",
			String(actionEveryNthTick()),
			"--payload-bytes",
			String(UPSTREAM_PAYLOAD_BYTES),
			"--steady-secs",
			String(STEADY_SECONDS),
			"--idle-secs",
			String(IDLE_SECONDS),
			"--endpoints",
			String(ENDPOINTS),
			"--connect-concurrency",
			String(CONNECT_CONCURRENCY),
			"--connect-timeout-secs",
			String(CONNECT_TIMEOUT_SECONDS),
			...(o.stormCohort > 0
				? [
						"--storm-cohort",
						String(o.stormCohort),
						"--storm-window-secs",
						String(stormWindowSec()),
						"--storm-reconnect-delay-ms",
						String(STORM_RECONNECT_DELAY_MS),
						// Zero = no permit pool. The registered configuration, and the
						// reason Little's law cannot be what the accept series measures.
						"--storm-concurrency",
						"0",
					]
				: []),
		],
		realmDeadlineSec,
		cloneFor.get("realm") ?? null,
	);

	const extras: ReturnType<typeof spawnClient>[] = [];
	if (o.hotspot) {
		extras.push(
			spawnClient(
				[
					"--role",
					"raid-subscriber",
					"--sessions",
					String(RAID_MEMBERS),
					"--steady-secs",
					String(STEADY_SECONDS),
					"--idle-secs",
					String(IDLE_SECONDS),
				],
				sideDeadlineSec,
				cloneFor.get("raid-subscriber") ?? null,
			),
		);
		extras.push(
			spawnClient(
				[
					"--role",
					"publisher",
					"--sessions",
					"1",
					"--send-interval-ms",
					String(Math.round(1000 / RAID_PUBLISHER_HZ)),
					"--payload-bytes",
					String(UPSTREAM_PAYLOAD_BYTES),
					"--steady-secs",
					String(STEADY_SECONDS),
					"--idle-secs",
					String(IDLE_SECONDS),
				],
				sideDeadlineSec,
				cloneFor.get("publisher") ?? null,
			),
		);
	}

	const boundary = (): Boundary => ({
		rx: o.state().rxTotal,
		snapshotIssued: o.state().emitter.snapshotIssued,
		ackIssued: o.state().emitter.ackIssued,
		cpuMs: serverCpuMs(),
		wallMs: Date.now(),
		kernel: readKernelUdp(),
		metrics: o.server.metricsSnapshot(),
	});

	const marks: Marks = {
		start: boundary(),
		steadyStart: null,
		steadyMark: null,
		steadyEnd: null,
		stormStart: null,
		stormEnd: null,
		idleEnd: null,
	};
	let phase = "connect";
	const hostSteady: number[] = [];
	const degraded: string[] = [];

	const onLine = (line: string) => {
		if (line.includes("phase steady")) {
			marks.steadyStart = boundary();
			phase = "steady";
		} else if (line.includes("phase storm")) {
			marks.steadyMark = boundary();
			phase = "storm";
			marks.stormStart = boundary();
			// The sever instant, on the server's clock. Everything accepted
			// before it is a survivor; everything after it is the cohort
			// returning. This is the only place that distinction exists without
			// trusting the client's account of who it severed.
			o.setSeverAt(Date.now());
		} else if (line.includes("phase post-storm")) {
			marks.stormEnd = boundary();
			phase = "post";
		} else if (line.includes("phase idle")) {
			marks.steadyMark ??= boundary();
			phase = "drain";
			setTimeout(() => {
				marks.steadyEnd = boundary();
				phase = "idle";
			}, DRAIN_GRACE_MS);
		} else if (line.includes("phase stop")) {
			marks.idleEnd = boundary();
			phase = "stop";
		}
	};

	const [realmRaw, extraReports] = await Promise.all([
		pumpClient(realm, onLine),
		Promise.all(extras.map((c) => pumpClient(c, () => {}))),
		sampleWhile(
			() => realm.exited,
			o,
			() => phase,
			hostSteady,
			marks,
		),
	]);
	stopEmitter();

	const realmReport = realmRaw as Record<string, unknown> | null;
	// The subscriber's and publisher's reports are evidence, not noise: the
	// one-way percentile the hotspot clause reads lives in the *subscriber's*
	// histogram, and the smoke that first ran this arm discarded them.
	const byRole = new Map<string, Record<string, unknown>>();
	for (const r of extraReports) {
		const rec = r as Record<string, unknown> | null;
		const role = rec?.role;
		if (typeof role === "string")
			byRole.set(role, rec as Record<string, unknown>);
	}
	const subscriberReport = byRole.get("raid-subscriber") ?? null;
	const publisherReport = byRole.get("publisher") ?? null;
	if (!realmReport) degraded.push("realm client produced no JSON report");
	// A missing phase marker means the client died before printing it. The
	// windows can still be closed at the child's exit so the arm reports
	// something, but a synthesized boundary silently stretches the window over
	// whatever the client was doing when it died. Every synthesis is recorded,
	// and a degraded arm can never be read as a clean one.
	for (const key of [
		"steadyStart",
		"steadyMark",
		"steadyEnd",
		"idleEnd",
	] as const) {
		if (!marks[key]) {
			degraded.push(`${key} marker never arrived: boundary synthesized`);
			marks[key] = boundary();
		}
	}

	const between = (
		from: Boundary | null,
		to: Boundary | null,
		pick: (b: Boundary) => number,
	) => (from && to ? pick(to) - pick(from) : 0);
	const metricBetween = (
		from: Boundary | null,
		to: Boundary | null,
		key: string,
	) =>
		from && to
			? ((to.metrics as unknown as Record<string, number>)[key] ?? 0) -
				((from.metrics as unknown as Record<string, number>)[key] ?? 0)
			: null;
	const kernelDelta = diffKernelUdp(
		marks.steadyStart?.kernel ?? null,
		marks.steadyEnd?.kernel ?? null,
	);
	const kernelValue = (key: string): number | null => {
		const v = kernelDelta?.[key];
		return v === undefined ? null : v;
	};

	const state = o.state();
	const classCount = (k: number) => state.rxByClass.get(k) ?? 0;
	const acceptSeries = state.acceptSeries;
	const severAt = marks.stormStart?.wallMs ?? null;

	return {
		arm: o.name,
		sessions: o.sessions,
		shape,
		degraded,
		clockSource: o.clock.source,
		client: realmReport,
		subscriberClient: subscriberReport,
		publisherClient: publisherReport,
		serverUpstream: {
			rxTotal: between(marks.steadyStart, marks.steadyEnd, (b) => b.rx),
			rxUnstamped: state.rxUnstamped,
			rxMove: classCount(0),
			rxAction: classCount(CLASS_ACTION),
			rxRaid: classCount(CLASS_RAID),
			rxRaidJoin: classCount(CLASS_RAID_JOIN),
			rxSurvivors: state.rxSurvivors,
		},
		emitter: {
			...state.emitter,
			lag: state.emitterLag.toJson(),
			// Reported beside the round trip, and never subtracted from it.
			hold: state.hold.toJson(),
		},
		hotspot: o.hotspot
			? {
					subscribers: o.raidMembers.length,
					ingested: state.publisherArrivals,
					publisherStamped: state.publisherStamped,
					forwarded: state.emitter.raidForwarded,
					subscriberReceived:
						(subscriberReport?.realm as Record<string, number> | undefined)
							?.rxRaid ?? 0,
					publisherSent:
						(publisherReport?.realm as Record<string, number> | undefined)
							?.sent ?? 0,
					/** The clause's percentile, on the subscriber's own clock. */
					oneWay: (subscriberReport?.oneWay as unknown) ?? null,
					/** Server-internal dwell. Disclosure only — see the comment
					 * at the recording site and Amendment 2. */
					serverForwardDwell: state.ingestToForward.toJson(),
					// A gap at or above half a publisher period is a frame
					// boundary; the falsifier's band is computed from the
					// publisher's own per-tick count.
					frameGapFraction: frameGapFraction(
						state.publisherGaps,
						1e9 / RAID_PUBLISHER_HZ,
					),
				}
			: null,
		storm:
			o.stormCohort > 0
				? {
						cohort: o.stormCohort,
						severAtMs: severAt,
						// The server's own accept completions, at 1 s resolution.
						// Never the client's connect pacing (disclosure ledger K10).
						acceptSeries: acceptSeriesPerSecond(acceptSeries),
						reAcceptedInWindow:
							severAt === null
								? 0
								: acceptSeries.filter(
										(t) =>
											t > severAt && t <= severAt + stormWindowSec() * 1000,
									).length,
						sessionsActiveAtWindowClose:
							marks.stormEnd?.metrics.sessionsActive ?? null,
						limitExceededDelta: metricBetween(
							marks.stormStart,
							marks.stormEnd,
							"limitExceededCount",
						),
						rateLimitedDelta: metricBetween(
							marks.stormStart,
							marks.stormEnd,
							"rateLimitedCount",
						),
						handshakesInFlightAtClose:
							marks.stormEnd?.metrics.handshakesInFlight ?? null,
						sessionsClosedByIdleDelta: metricBetween(
							marks.stormStart,
							marks.stormEnd,
							"sessionsClosedByIdle",
						),
						sessionsClosedOtherDelta: metricBetween(
							marks.stormStart,
							marks.stormEnd,
							"sessionsClosedOther",
						),
						kernelStorm: diffKernelUdp(
							marks.stormStart?.kernel ?? null,
							marks.stormEnd?.kernel ?? null,
						),
					}
				: null,
		stageLedger: {
			clientEnqueued:
				(realmReport?.realm as Record<string, number> | undefined)?.sent ?? 0,
			clientWireTx:
				(realmReport?.quicDrive as Record<string, number> | undefined)
					?.frameTxDatagram ?? null,
			kernelDropsSocket: kernelValue("serverSocketDrops"),
			kernelRcvbufErrors: kernelValue("RcvbufErrors"),
			serverObserved: metricBetween(
				marks.steadyStart,
				marks.steadyEnd,
				"datagramsIn",
			),
			jsDelivered: between(marks.steadyStart, marks.steadyEnd, (b) => b.rx),
			nativeDropped: metricBetween(
				marks.steadyStart,
				marks.steadyEnd,
				"datagramsDropped",
			),
			nativeSkippedQueueFull: metricBetween(
				marks.steadyStart,
				marks.steadyEnd,
				"datagramsSkippedQueueFull",
			),
		},
		kernelSteady: kernelDelta,
		serverCpuPctSteady:
			marks.steadyStart &&
			marks.steadyMark &&
			marks.steadyMark.wallMs > marks.steadyStart.wallMs
				? ((marks.steadyMark.cpuMs - marks.steadyStart.cpuMs) /
						(marks.steadyMark.wallMs - marks.steadyStart.wallMs)) *
					100
				: null,
		hostCpuPctMedianSteady: median(hostSteady),
		sessionsActiveMax: marks.steadyMark?.metrics.sessionsActive ?? null,
	};
}

/** Accepts per second, keyed by the server's own clock. */
function acceptSeriesPerSecond(
	acceptMs: number[],
): { tMs: number; accepts: number }[] {
	const buckets = new Map<number, number>();
	for (const t of acceptMs) {
		const key = Math.floor(t / 1000) * 1000;
		buckets.set(key, (buckets.get(key) ?? 0) + 1);
	}
	return [...buckets.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([tMs, accepts]) => ({ tMs, accepts }));
}

/**
 * Fraction of observed inter-arrival gaps at or above half a publisher period —
 * ticket 14's cadence signal, computed on the server's own arrival times.
 */
function frameGapFraction(gaps: number[], periodNs: number): number | null {
	if (gaps.length === 0) return null;
	const threshold = 0.5 * periodNs;
	return gaps.filter((g) => g >= threshold).length / gaps.length;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

type SpawnedClient = {
	child: ChildProcess;
	exited: Promise<number>;
};

function spawnClient(
	args: string[],
	deadlineSeconds: number,
	cloneName: string | null = null,
): SpawnedClient {
	const full = [
		"--url",
		`https://${OFFBOX_SSH ? serverAddressForOffbox() : "127.0.0.1"}:${PORT}`,
		...args,
	];
	// Off-box the generator is the Mac, reached over ssh exactly as ticket 29's
	// interface contract specifies; the entrypoint enforces the candidate SHA at
	// the generator rather than trusting it. The G6 variant of the entrypoint
	// (a separate file — the sibling's hash is pinned by G2's PD-1) accepts
	// `mmo-client` and takes the deadline from this conductor's own phase
	// arithmetic instead of a fixed 300 s that O-2 showed kills the storm arm.
	if (OFFBOX_SSH && CANDIDATE_SHA === "") {
		throw new Error(
			"bench-g6: G6_CANDIDATE_SHA is required for an off-box run — the entrypoint refuses to build without it",
		);
	}
	const cloneNameFor = cloneName;
	const entrypointArgs =
		cloneNameFor === null
			? ["tools/offbox/mac-generator-entry-g6.sh"]
			: [
					"tools/offbox/mac-generator-entry-g6.sh",
					"--clone",
					`~/${cloneNameFor}`,
				];
	const [cmd, cmdArgs] = OFFBOX_SSH
		? ([
				"ssh",
				[
					"-o",
					"BatchMode=yes",
					OFFBOX_SSH,
					...entrypointArgs,
					"--candidate",
					CANDIDATE_SHA,
					"--bin",
					"mmo-client",
					"--deadline",
					String(deadlineSeconds),
					"--",
					...full,
				],
			] as const)
		: ([CLIENT_BIN, full] as const);
	const child = spawn(cmd, [...cmdArgs], {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	activeChildren.add(child);
	const exited = new Promise<number>((res) => {
		child.on("exit", (code, signal) => res(code ?? (signal ? 128 : -1)));
		child.on("error", () => res(-1));
	});
	return { child, exited };
}

function serverAddressForOffbox(): string {
	// The bench subnet's server address. Registered by the cable runbook; never
	// the LAN and never Tailscale.
	return process.env.G6_SERVER_ADDRESS ?? "10.99.0.2";
}

/**
 * Per-role Mac clone for the off-box generator.
 *
 * The hotspot arm spawns three `mac-generator-entry-g6.sh` invocations
 * (realm, raid-subscriber, publisher) concurrently. Every invocation does
 * `git fetch && git checkout --detach <sha> && git status` on one worktree
 * before building; two concurrent checkouts on the same clone race on
 * `index.lock` and one exits 128, silently producing no report — run
 * 32662000300's hotspot arm recorded `subscriberClient: null` that way. Give
 * each concurrent role its own clone, isolated by `--clone` (the entrypoint
 * already accepts it); `git clone --local` on the Mac hardlinks objects and
 * provisions in ~2 s. Absent a role, the default `~/wt-macgen` is used.
 */
const MACGEN_BASE_CLONE = "wt-macgen";
const macgenCloneProvisioned = new Set<string>();

async function macgenCloneFor(role: string | null): Promise<string | null> {
	if (!OFFBOX_SSH) return null; // co-resident smoke: shared CLIENT_BIN.
	if (role === null || role === "realm") return null; // default clone.
	const clone = `wt-macgen-${role}`;
	if (macgenCloneProvisioned.has(clone)) return clone;
	// Provision on the Mac: clone from the base repo (local, hardlinked
	// objects). Guard against the race where two arms both try to create it.
	const cloneCmd = `"$HOME/.bun/bin/bun" --version >/dev/null 2>&1 || true; CLONE=$HOME/${clone}; if [ ! -d "$CLONE/.git" ]; then if [ ! -d "$HOME/${MACGEN_BASE_CLONE}/.git" ]; then echo "macgen: no base clone at $HOME/${MACGEN_BASE_CLONE}" >&2; exit 3; fi; if mkdir "$CLONE.lock" 2>/dev/null; then if [ ! -d "$CLONE/.git" ]; then git clone --local --quiet "$HOME/${MACGEN_BASE_CLONE}" "$CLONE" || echo "macgen: clone failed" >&2; fi; rmdir "$CLONE.lock" 2>/dev/null || true; fi; fi; [ -d "$CLONE/.git" ] || { echo "macgen: $CLONE not provisioned" >&2; exit 3; }`;
	const child = spawn("ssh", ["-o", "BatchMode=yes", OFFBOX_SSH, cloneCmd], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	// Bounded wait: provisioning must not hang the gate. 60 s is generous for a
	// 2 s local clone on a box the gate will then hammer for 25 min.
	const code = await new Promise<number>((res) => {
		const t = setTimeout(() => {
			child.kill("SIGKILL");
			res(-1);
		}, 60_000);
		child.on("exit", (c) => {
			clearTimeout(t);
			res(c ?? -1);
		});
	});
	if (code !== 0) {
		throw new Error(
			`bench-g6: failed to provision Mac generator clone ${clone} (exit ${code})`,
		);
	}
	macgenCloneProvisioned.add(clone);
	return clone;
}

async function pumpClient(
	client: SpawnedClient,
	onLine: (line: string) => void,
): Promise<unknown | null> {
	let report: unknown | null = null;
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of client.child.stdout ?? []) {
		buffered += decoder.decode(chunk as Uint8Array, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			onLine(line);
			const match = line.match(/^mmo-client: json (\{.*\})$/);
			if (match?.[1]) report = JSON.parse(match[1]);
		}
	}
	await client.exited;
	activeChildren.delete(client.child);
	return report;
}

async function sampleWhile(
	exited: () => Promise<number>,
	o: ArmOptions,
	phase: () => string,
	hostSteady: number[],
	_marks: Marks,
): Promise<null> {
	let running = true;
	void exited().then(() => {
		running = false;
	});
	let prevHost = readHostCpu();
	let prev = {
		wallMs: Date.now(),
		cpuMs: serverCpuMs(),
		rx: o.state().rxTotal,
		snapshot: o.state().emitter.snapshotIssued,
		ack: o.state().emitter.ackIssued,
	};
	while (running) {
		await Bun.sleep(SAMPLE_INTERVAL_MS);
		const nextHost = readHostCpu();
		const host = hostCpuPct(prevHost, nextHost);
		prevHost = nextHost;
		if (phase() === "steady" && host !== null) hostSteady.push(host);
		const mem = serverMem();
		const now = Date.now();
		const cpu = serverCpuMs();
		const state = o.state();
		const windowMs = Math.max(now - prev.wallMs, 1);
		// Windowed, never cumulative: a running average since arm start decays
		// with elapsed time and reports a saturated phase as a comfortable one.
		const cpuPct = ((cpu - prev.cpuMs) / windowMs) * 100;
		appendFileSync(
			OUT_CSV,
			`${o.name},${o.sessions},${now},${phase()},${windowMs},${host?.toFixed(1) ?? ""},${cpuPct.toFixed(1)},${mem.rssMb.toFixed(1)},${mem.committedMb?.toFixed(1) ?? ""},${hostMemAvailableMb()?.toFixed(0) ?? ""},${o.server.metricsSnapshot().sessionsActive},${state.rxTotal - prev.rx},${state.emitter.snapshotIssued - prev.snapshot},${state.emitter.ackIssued - prev.ack}\n`,
		);
		prev = {
			wallMs: now,
			cpuMs: cpu,
			rx: state.rxTotal,
			snapshot: state.emitter.snapshotIssued,
			ack: state.emitter.ackIssued,
		};
	}
	return null;
}

/**
 * Settle between arms and hold a drain barrier: any session still open when the
 * next arm starts is a previous arm's memory and CPU being charged to this one.
 */
async function drainBetweenArms(
	server: ReturnType<typeof createServer>,
	players: Player[],
	raidMembers: Player[],
): Promise<void> {
	killChildren("SIGKILL");
	activeChildren.clear();
	players.length = 0;
	raidMembers.length = 0;
	const deadline = Date.now() + SETTLE_SECONDS * 1000 + 60_000;
	while (Date.now() < deadline) {
		if (server.metricsSnapshot().sessionsActive === 0) break;
		await Bun.sleep(1000);
	}
	await Bun.sleep(SETTLE_SECONDS * 1000);
}

try {
	await main();
	process.exit(0);
} catch (err) {
	console.error(err instanceof Error ? (err.stack ?? err.message) : err);
	process.exit(1);
}
