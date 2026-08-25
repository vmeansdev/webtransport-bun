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
import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { $ } from "bun";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import { canonicalGeneratorIdentity } from "../offbox/host-identity.ts";
import {
	type BoundarySnapshot,
	buildBenchArtifact,
	buildRetainedG6ClientRoleEvidence,
	chooseClientProvenance,
	clientProcessFailureReasons,
	clientWindow,
	compareWindowDelivery,
	deriveBoundaryWindows,
	type EmitterPhase,
	HOTSPOT_PHASE_BARRIER_PARTIES,
	HOTSPOT_PHASE_BARRIER_STEADY_SKEW_MS,
	indexClientBundlesByLaunchRole,
	readPhaseMarker,
	renderRetainedG6ClientRoleLog,
	requireClientReportIdentity,
	summarizePhaseBarrier,
	validateSourceBinding,
} from "./g6-artifact.ts";
import { g6MacgenCloneCommand } from "./g6-offbox.ts";
import {
	ACTION_HZ,
	actionEveryNthTick,
	armShape,
	G6_CLOSEOUT_SPEC_PATH,
	MOVE_HZ,
	preflightRequirements,
	RAID_MEMBERS,
	RAID_PUBLISHER_HZ,
	REALM_LADDER,
	SNAPSHOT_HZ,
	STORM_RECONNECT_DELAY_MS,
	stormCohorts,
	stormWindowSec,
	UPSTREAM_PAYLOAD_BYTES,
} from "./g6-plan.ts";
import {
	createG6ServerCore,
	freshG6ServerState,
	type Player,
	REGISTERED_G6_SERVER_CORE_PLAN,
	type ServerState,
} from "./g6-server-core.ts";
import { createMonotonicClock } from "./latency-clock.ts";
import {
	CLASS_ACK,
	CLASS_RAID,
	CLASS_RAID_JOIN,
	CLASS_SNAPSHOT,
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
const EXPECTED_PREREGISTRATION_SHA256 =
	process.env.G6_PREREGISTRATION_SHA256 ?? "";
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
const SERVER_HOSTNAME = canonicalGeneratorIdentity(hostname());
const HOTSPOT_PHASE_BARRIER_DIR =
	process.env.G6_PHASE_BARRIER_DIR ?? "/tmp/webtransport-g6-phase-barriers";

const SERVER_CORE_PLAN = REGISTERED_G6_SERVER_CORE_PLAN;

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

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function sha256FileHex(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readTrackedPreregistrationSha256(): string {
	return sha256Hex(readFileSync(join(ROOT, G6_CLOSEOUT_SPEC_PATH), "utf8"));
}

function requirePreregistrationSha256(): string {
	if (!EXPECTED_PREREGISTRATION_SHA256) {
		throw new Error(
			"bench-g6: G6_PREREGISTRATION_SHA256 is required for bench-g6/2",
		);
	}
	if (!/^[0-9a-f]{64}$/i.test(EXPECTED_PREREGISTRATION_SHA256)) {
		throw new Error(
			`bench-g6: G6_PREREGISTRATION_SHA256 must be 64 hex chars, got '${EXPECTED_PREREGISTRATION_SHA256}'`,
		);
	}
	const actual = readTrackedPreregistrationSha256();
	if (actual !== EXPECTED_PREREGISTRATION_SHA256) {
		throw new Error(
			`bench-g6: preregistration sha256 mismatch for ${G6_CLOSEOUT_SPEC_PATH}: expected ${EXPECTED_PREREGISTRATION_SHA256}, got ${actual}`,
		);
	}
	return actual;
}

async function resolveCandidateSource(): Promise<{
	candidateSha: string;
	dirty: false;
}> {
	const checkedOutSha = (
		await $`cd ${ROOT} && git rev-parse HEAD`.text()
	).trim();
	const statusPorcelain = await $`cd ${ROOT} && git status --porcelain`.text();
	return validateSourceBinding({
		checkedOutSha,
		expectedCandidateSha: CANDIDATE_SHA || null,
		statusPorcelain,
	});
}

function localClientProvenanceLines(candidateSha: string): string[] {
	return [
		`localgen: host=${SERVER_HOSTNAME} candidate=${candidateSha} head=${candidateSha} dirty=no`,
		`localgen: binary=${CLIENT_BIN} sha256=${sha256FileHex(CLIENT_BIN)}`,
	];
}

function localClientProvenance(
	candidateSha: string,
	exitCode: number,
): string[] {
	return [
		...localClientProvenanceLines(candidateSha),
		`localgen: exit=${exitCode}`,
	];
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

async function main(): Promise<void> {
	if (LADDER.length === 0) throw new Error("G6_LADDER parsed empty");
	const preregistrationSha256 = requirePreregistrationSha256();
	const candidateSource = await resolveCandidateSource();
	const campaignStartedAt = new Date().toISOString();
	console.log("bench-g6: building mmo-client (release)...");
	await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin mmo-client --release`.quiet();

	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	// FFI read, not the `Bun.nanoseconds()` fast path: the gate's evidence chain
	// must not carry the fast path's same-counter assumption.
	const clock = await createMonotonicClock(false);
	const phaseState: { current: EmitterPhase } = { current: "idle" };
	let state = freshG6ServerState();
	/**
	 * Server-clock instant the storm severed its cohort. Sessions accepted
	 * before it are the survivors; sessions accepted after it are the cohort
	 * coming back. Null outside the storm arm.
	 */
	let severAtMs: number | null = null;
	const serverCore = createG6ServerCore({
		plan: SERVER_CORE_PLAN,
		clock,
		nowMs: () => Date.now(),
		phaseState,
		state: () => state,
		severAtMs: () => severAtMs,
	});
	const { players, raidMembers } = serverCore;

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
			maxDatagramSize: SERVER_CORE_PLAN.snapshotPayloadBytes + 64,
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
		onSession: serverCore.onSession,
	});
	await Bun.sleep(3000);
	console.log(
		`bench-g6: server up on ${PORT}; ladder=[${LADDER.join(",")}] arms=[${ARMS.join(",")}] snapshot=${SERVER_CORE_PLAN.snapshotDatagrams}x${SERVER_CORE_PLAN.snapshotPayloadBytes}B@${SERVER_CORE_PLAN.snapshotHz}Hz slices=${SERVER_CORE_PLAN.slicesPerTick}`,
	);

	writeFileSync(
		OUT_CSV,
		"arm,sessions,ts_ms,phase,windowMs,hostCpuPct,serverCpuPct,serverRssMb,serverCommittedMb,memAvailableMb,sessionsActive,rxDelta,snapshotIssuedDelta,ackIssuedDelta\n",
	);

	const arms: unknown[] = [];
	let aborted: string | null = null;

	const buildResult = () => ({
		startedAt: campaignStartedAt,
		writtenAt: new Date().toISOString(),
		complete: aborted === null && arms.length > 0,
		host: {
			identity: SERVER_HOSTNAME,
			platform: process.platform,
			cpus: navigator?.hardwareConcurrency ?? null,
			bunVersion: Bun.version,
			/** Empty means the generator was co-resident: a smoke, never a G6 result. */
			offboxSsh: OFFBOX_SSH || null,
		},
		source: {
			...candidateSource,
			coResident: OFFBOX_SSH === "",
		},
		config: {
			ladder: LADDER,
			arms: ARMS,
			movePps: MOVE_HZ,
			actionPps: ACTION_HZ,
			actionEvery: actionEveryNthTick(),
			upstreamPayloadBytes: UPSTREAM_PAYLOAD_BYTES,
			snapshotHz: SNAPSHOT_HZ,
			snapshotDatagrams: SERVER_CORE_PLAN.snapshotDatagrams,
			snapshotPayloadBytes: SERVER_CORE_PLAN.snapshotPayloadBytes,
			emitterSliceHz: SERVER_CORE_PLAN.emitterSliceHz,
			raidMembers: RAID_MEMBERS,
			raidPublisherHz: RAID_PUBLISHER_HZ,
			steadySeconds: STEADY_SECONDS,
			drainGraceMs: DRAIN_GRACE_MS,
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
		const artifact = buildBenchArtifact({
			...buildResult(),
			preregistrationSha256,
		});
		const tmp = `${OUT_JSON}.partial`;
		writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`);
		renameSync(tmp, OUT_JSON);
		const rawDir = join(dirname(OUT_JSON), "raw");
		mkdirSync(rawDir, { recursive: true });
		for (const role of ["realm", "subscriber", "publisher"] as const) {
			const evidence = buildRetainedG6ClientRoleEvidence(artifact, role);
			writeFileSync(
				join(rawDir, `${role}-report.json`),
				`${JSON.stringify(evidence, null, 2)}\n`,
			);
			writeFileSync(
				join(rawDir, `${role}.log`),
				renderRetainedG6ClientRoleLog(evidence),
			);
		}
	};

	try {
		for (const sessions of LADDER) {
			if (!ARMS.includes("steady")) break;
			arms.push(
				await runArm({
					name: `steady-${sessions}`,
					sessions,
					startedAt: new Date().toISOString(),
					candidateSha: candidateSource.candidateSha,
					server,
					state: () => state,
					resetState: () => {
						state = freshG6ServerState();
					},
					startEmitter: serverCore.startEmitter,
					players,
					raidMembers,
					clock,
					phaseState,
					hotspot: false,
					stormCohort: 0,
					setSeverAt: (v) => {
						severAtMs = v;
					},
					phaseBarrierId: null,
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
					startedAt: new Date().toISOString(),
					candidateSha: candidateSource.candidateSha,
					server,
					state: () => state,
					resetState: () => {
						state = freshG6ServerState();
					},
					startEmitter: serverCore.startEmitter,
					players,
					raidMembers,
					clock,
					phaseState,
					hotspot: true,
					stormCohort: 0,
					setSeverAt: (v) => {
						severAtMs = v;
					},
					phaseBarrierId: randomUUID(),
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
						startedAt: new Date().toISOString(),
						candidateSha: candidateSource.candidateSha,
						server,
						state: () => state,
						resetState: () => {
							state = freshG6ServerState();
						},
						startEmitter: serverCore.startEmitter,
						players,
						raidMembers,
						clock,
						phaseState,
						hotspot: false,
						stormCohort: cohort,
						setSeverAt: (v) => {
							severAtMs = v;
						},
						phaseBarrierId: null,
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

type ArmOptions = {
	name: string;
	sessions: number;
	startedAt: string;
	candidateSha: string;
	server: ReturnType<typeof createServer>;
	state: () => ServerState;
	resetState: () => void;
	startEmitter: ReturnType<typeof createG6ServerCore>["startEmitter"];
	players: Player[];
	raidMembers: Player[];
	clock: { now: () => number; source: string };
	phaseState: { current: EmitterPhase };
	hotspot: boolean;
	stormCohort: number;
	setSeverAt: (v: number | null) => void;
	phaseBarrierId: string | null;
};

type Marks = {
	start: BoundarySnapshot | null;
	steadyStart: BoundarySnapshot | null;
	drainStart: BoundarySnapshot | null;
	drainEnd: BoundarySnapshot | null;
	stormStart: BoundarySnapshot | null;
	stormEnd: BoundarySnapshot | null;
	idleStart: BoundarySnapshot | null;
	idleEnd: BoundarySnapshot | null;
};

async function runArm(o: ArmOptions): Promise<unknown> {
	o.players.length = 0;
	o.raidMembers.length = 0;
	o.resetState();
	o.setSeverAt(null);
	o.phaseState.current = "connect";
	const shape = armShape(o.sessions);
	console.log(
		`bench-g6: arm ${o.name} sessions=${o.sessions} up=${shape.upstreamAggregatePps}/s down=${shape.downstreamAggregatePps}/s storm=${o.stormCohort}`,
	);

	let phase: EmitterPhase = "connect";
	const stopEmitter = o.startEmitter(() => phase);
	// O-2's arithmetic, computed from the same constants the argv carries,
	// with the macgen 1.5x allowance. The entrypoint's watchdog arms after its
	// build, so this covers only the client's own phases.
	const realmDeadlineSec = Math.ceil(
		1.5 *
			(CONNECT_TIMEOUT_SECONDS +
				STEADY_SECONDS +
				Math.ceil(DRAIN_GRACE_MS / 1000) +
				(o.stormCohort > 0
					? Math.ceil(STORM_RECONNECT_DELAY_MS / 1000) +
						stormWindowSec() +
						POST_STORM_SECONDS
					: 0) +
				IDLE_SECONDS),
	);
	const sideDeadlineSec = Math.ceil(
		1.5 *
			(CONNECT_TIMEOUT_SECONDS +
				STEADY_SECONDS +
				Math.ceil(DRAIN_GRACE_MS / 1000) +
				IDLE_SECONDS),
	);
	const phaseBarrierArgs = o.hotspot
		? [
				"--phase-barrier-id",
				o.phaseBarrierId ??
					(() => {
						throw new Error("bench-g6: hotspot arm missing phase barrier id");
					})(),
				"--phase-barrier-dir",
				HOTSPOT_PHASE_BARRIER_DIR,
				"--phase-barrier-parties",
				String(HOTSPOT_PHASE_BARRIER_PARTIES),
				"--phase-barrier-timeout-ms",
				"60000",
			]
		: [];
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
			"--drain-ms",
			String(DRAIN_GRACE_MS),
			"--idle-secs",
			String(IDLE_SECONDS),
			"--endpoints",
			String(ENDPOINTS),
			"--connect-concurrency",
			String(CONNECT_CONCURRENCY),
			"--connect-timeout-secs",
			String(CONNECT_TIMEOUT_SECONDS),
			"--preregistration-sha256",
			EXPECTED_PREREGISTRATION_SHA256,
			"--started-at",
			o.startedAt,
			...phaseBarrierArgs,
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
	const extraRoles = o.hotspot
		? (["raid-subscriber", "publisher"] as const)
		: ([] as const);
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
					"--drain-ms",
					String(DRAIN_GRACE_MS),
					"--idle-secs",
					String(IDLE_SECONDS),
					"--preregistration-sha256",
					EXPECTED_PREREGISTRATION_SHA256,
					"--started-at",
					o.startedAt,
					...phaseBarrierArgs,
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
					"--drain-ms",
					String(DRAIN_GRACE_MS),
					"--idle-secs",
					String(IDLE_SECONDS),
					"--preregistration-sha256",
					EXPECTED_PREREGISTRATION_SHA256,
					"--started-at",
					o.startedAt,
					...phaseBarrierArgs,
				],
				sideDeadlineSec,
				cloneFor.get("publisher") ?? null,
			),
		);
	}

	const boundary = (): BoundarySnapshot => ({
		rxTotal: o.state().rxTotal,
		rxSurvivors: o.state().rxSurvivors,
		rxByClass: {
			snapshot: o.state().rxByClass.get(CLASS_SNAPSHOT) ?? 0,
			ack: o.state().rxByClass.get(CLASS_ACK) ?? 0,
			raid: o.state().rxByClass.get(CLASS_RAID) ?? 0,
			raidJoin: o.state().rxByClass.get(CLASS_RAID_JOIN) ?? 0,
			unstamped: o.state().rxUnstamped,
		},
		emitter: {
			...o.state().emitter,
		},
		cpuMs: serverCpuMs(),
		wallMs: Date.now(),
		kernel: readKernelUdp(),
		metrics: o.server.metricsSnapshot(),
	});

	const marks: Marks = {
		start: boundary(),
		steadyStart: null,
		drainStart: null,
		drainEnd: null,
		stormStart: null,
		stormEnd: null,
		idleStart: null,
		idleEnd: null,
	};
	const hostSteady: number[] = [];
	const degraded: string[] = [];

	const onLine = (line: string) => {
		const marker = readPhaseMarker(line);
		if (!marker) return;
		if (marker.kind === "steady") {
			marks.steadyStart = boundary();
			phase = "steady";
			o.phaseState.current = "steady";
		} else if (marker.kind === "drain") {
			marks.drainStart = boundary();
			phase = "drain";
			o.phaseState.current = "drain";
		} else if (marker.kind === "storm") {
			marks.drainEnd ??= boundary();
			marks.stormStart = boundary();
			phase = "storm";
			o.phaseState.current = "storm";
			o.setSeverAt(marks.stormStart.wallMs);
		} else if (marker.kind === "post-storm") {
			marks.stormEnd = boundary();
			phase = "post-storm";
			o.phaseState.current = "post-storm";
		} else if (marker.kind === "idle") {
			marks.drainEnd ??= boundary();
			marks.idleStart = boundary();
			phase = "idle";
			o.phaseState.current = "idle";
		} else if (marker.kind === "stop") {
			marks.idleEnd = boundary();
			phase = "stop";
			o.phaseState.current = "stop";
		}
	};

	const [realmRaw, extraReports] = await Promise.all([
		pumpClient(realm, onLine),
		Promise.all(extras.map((c, i) => pumpClient(c, () => {}, `extra-${i}`))),
		sampleWhile(
			() => realm.exited,
			o,
			() => phase,
			hostSteady,
			marks,
		),
	]);
	stopEmitter();

	const realmReport = realmRaw.report
		? requireClientReportIdentity(realmRaw.report, {
				role: "realm",
				startedAt: o.startedAt,
				preregistrationSha256: EXPECTED_PREREGISTRATION_SHA256,
			})
		: null;
	// The subscriber's and publisher's reports are evidence, not noise: the
	// one-way percentile the hotspot clause reads lives in the *subscriber's*
	// histogram, and the smoke that first ran this arm discarded them.
	const byRole = indexClientBundlesByLaunchRole(extraRoles, extraReports);
	const subscriberBundle = byRole.get("raid-subscriber") ?? null;
	const publisherBundle = byRole.get("publisher") ?? null;
	const subscriberReport = subscriberBundle?.report
		? requireClientReportIdentity(subscriberBundle.report, {
				role: "raid-subscriber",
				startedAt: o.startedAt,
				preregistrationSha256: EXPECTED_PREREGISTRATION_SHA256,
			})
		: null;
	const publisherReport = publisherBundle?.report
		? requireClientReportIdentity(publisherBundle.report, {
				role: "publisher",
				startedAt: o.startedAt,
				preregistrationSha256: EXPECTED_PREREGISTRATION_SHA256,
			})
		: null;
	degraded.push(
		...clientProcessFailureReasons("realm", realmRaw, OFFBOX_SSH !== ""),
	);
	if (o.hotspot) {
		degraded.push(
			...clientProcessFailureReasons(
				"raid-subscriber",
				subscriberBundle,
				OFFBOX_SSH !== "",
			),
			...clientProcessFailureReasons(
				"publisher",
				publisherBundle,
				OFFBOX_SSH !== "",
			),
		);
	}
	// A missing phase marker means the client died before printing it. The
	// windows can still be closed at the child's exit so the arm reports
	// something, but a synthesized boundary silently stretches the window over
	// whatever the client was doing when it died. Every synthesis is recorded,
	// and a degraded arm can never be read as a clean one.
	for (const key of [
		"steadyStart",
		"drainStart",
		"drainEnd",
		"idleStart",
		"idleEnd",
	] as const) {
		if (!marks[key]) {
			degraded.push(`${key} marker never arrived: boundary synthesized`);
			marks[key] = boundary();
		}
	}
	if (o.stormCohort > 0) {
		for (const key of ["stormStart", "stormEnd"] as const) {
			if (!marks[key]) {
				degraded.push(`${key} marker never arrived: boundary synthesized`);
				marks[key] = boundary();
			}
		}
	}
	const metricBetween = (
		from: BoundarySnapshot | null,
		to: BoundarySnapshot | null,
		key: string,
	) =>
		from && to
			? ((to.metrics as Record<string, number>)[key] ?? 0) -
				((from.metrics as Record<string, number>)[key] ?? 0)
			: null;

	const state = o.state();
	const acceptSeries = state.acceptSeries;
	const severAt = marks.stormStart?.wallMs ?? null;
	const requiredMark = (
		key: "start" | "steadyStart" | "drainStart" | "drainEnd" | "idleStart",
	): BoundarySnapshot => {
		const mark = marks[key];
		if (!mark) throw new Error(`bench-g6: required ${key} boundary is missing`);
		return mark;
	};
	const {
		steady: steadyWindow,
		steadyDrain: steadyDrainWindow,
		lifetime: lifetimeWindow,
		storm: stormWindow,
	} = deriveBoundaryWindows({
		start: requiredMark("start"),
		steadyStart: requiredMark("steadyStart"),
		drainStart: requiredMark("drainStart"),
		drainEnd: requiredMark("drainEnd"),
		idleStart: requiredMark("idleStart"),
		stormStart: marks.stormStart,
		stormEnd: marks.stormEnd,
	});
	const steadyClient = clientWindow(realmReport, "steady");
	const steadyDrainClient = clientWindow(realmReport, "steadyDrain");
	const stormSurvivorsClient = clientWindow(realmReport, "stormSurvivors");
	const subscriberSteadyDrain = clientWindow(subscriberReport, "steadyDrain");
	const publisherSteady = clientWindow(publisherReport, "steady");
	const steadyDrainDelivery = steadyDrainClient
		? compareWindowDelivery(
				steadyDrainWindow.emitter.snapshotIssued +
					steadyDrainWindow.emitter.ackIssued,
				steadyDrainClient,
			)
		: null;
	const stormSurvivorDelivery =
		stormWindow && stormSurvivorsClient
			? compareWindowDelivery(
					stormWindow.emitter.snapshotIssued + stormWindow.emitter.ackIssued,
					stormSurvivorsClient,
				)
			: null;
	if (steadyDrainDelivery?.status === "unparseable") {
		degraded.push(
			"realm steadyDrain window contained unstamped receives and is invalidating",
		);
	}
	if (steadyDrainDelivery?.status === "unreflected") {
		degraded.push(
			"realm steadyDrain window contained unreflected acks and is degraded",
		);
	}
	if (stormSurvivorDelivery?.status === "unparseable") {
		degraded.push(
			"realm stormSurvivors window contained unstamped receives and is invalidating",
		);
	}
	const hotspotPhaseBarrier =
		o.hotspot && realmReport && subscriberReport && publisherReport
			? summarizePhaseBarrier(
					[realmReport, subscriberReport, publisherReport],
					HOTSPOT_PHASE_BARRIER_PARTIES,
				)
			: null;
	if (
		hotspotPhaseBarrier &&
		hotspotPhaseBarrier.steadyEnterSkewMs > HOTSPOT_PHASE_BARRIER_STEADY_SKEW_MS
	) {
		throw new Error(
			`bench-g6: hotspot phase barrier steady-enter skew ${hotspotPhaseBarrier.steadyEnterSkewMs.toFixed(3)}ms exceeded ${HOTSPOT_PHASE_BARRIER_STEADY_SKEW_MS}ms`,
		);
	}

	return {
		arm: o.name,
		sessions: o.sessions,
		shape,
		degraded,
		clockSource: o.clock.source,
		windows: {
			steady: {
				serverUpstream: {
					rxTotal: steadyWindow.rxTotal,
					rxSurvivors: steadyWindow.rxSurvivors,
					rxByClass: steadyWindow.rxByClass,
				},
				emitter: steadyWindow.emitter,
				diagnostics: {
					emitterLag: state.emitterLagSteady.toJson(),
				},
				client: steadyClient,
			},
			steadyDrain: {
				serverUpstream: {
					rxTotal: steadyDrainWindow.rxTotal,
					rxSurvivors: steadyDrainWindow.rxSurvivors,
					rxByClass: steadyDrainWindow.rxByClass,
				},
				emitter: steadyDrainWindow.emitter,
				diagnostics: {
					serverHold: state.holdSteadyDrain.toJson(),
					ingestToForward: state.ingestToForwardSteadyDrain.toJson(),
				},
				client: steadyDrainClient,
			},
			storm: stormWindow
				? {
						serverUpstream: {
							rxTotal: stormWindow.rxTotal,
							rxSurvivors: stormWindow.rxSurvivors,
							rxByClass: stormWindow.rxByClass,
						},
						emitter: stormWindow.emitter,
						diagnostics: {
							emitterLag: state.emitterLagStorm.toJson(),
							serverHold: state.holdStorm.toJson(),
						},
						client: stormSurvivorsClient,
					}
				: null,
			lifetime: {
				serverUpstream: {
					rxTotal: lifetimeWindow.rxTotal,
					rxSurvivors: lifetimeWindow.rxSurvivors,
					rxByClass: lifetimeWindow.rxByClass,
				},
				emitter: lifetimeWindow.emitter,
				diagnostics: {
					emitterLag: state.emitterLag.toJson(),
					serverHold: state.hold.toJson(),
					ingestToForward: state.ingestToForward.toJson(),
				},
				client: realmReport?.lifetime ?? null,
			},
		},
		hotspot: o.hotspot
			? {
					subscribers: o.raidMembers.length,
					ingested: state.publisherArrivalsSteadyDrain,
					publisherStamped: state.publisherStampedSteadyDrain,
					forwarded: state.emitter.raidForwarded,
					subscriberReceived: subscriberSteadyDrain?.rxRaid ?? 0,
					publisherSent: publisherSteady?.sent ?? 0,
					/** The clause's percentile, on the subscriber's own clock. */
					oneWay: subscriberSteadyDrain?.oneWay ?? null,
					/** Server-internal dwell. Disclosure only — see the comment
					 * at the recording site and Amendment 2. */
					serverForwardDwell: state.ingestToForwardSteadyDrain.toJson(),
					// A gap at or above half a publisher period is a frame
					// boundary; the falsifier's band is computed from the
					// publisher's own per-tick count.
					frameGapFraction: frameGapFraction(
						state.publisherGapsSteadyDrain,
						1e9 / RAID_PUBLISHER_HZ,
					),
				}
			: null,
		phaseBarrier: hotspotPhaseBarrier,
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
						kernelStorm: stormWindow?.kernel ?? null,
					}
				: null,
		stageWindows: {
			steady: {
				clientEnqueued: steadyClient?.sent ?? 0,
				clientWireTx:
					(realmReport?.quicDrive as Record<string, number> | undefined)
						?.frameTxDatagram ?? null,
				kernelDropsSocket: steadyWindow.kernel?.serverSocketDrops ?? null,
				kernelRcvbufErrors: steadyWindow.kernel?.RcvbufErrors ?? null,
				serverObserved: steadyWindow.metrics.datagramsIn ?? null,
				jsDelivered: steadyWindow.rxTotal,
				nativeDropped: steadyWindow.metrics.datagramsDropped ?? null,
				nativeSkippedQueueFull:
					steadyWindow.metrics.datagramsSkippedQueueFull ?? null,
			},
			steadyDrain: {
				clientReceived: steadyDrainDelivery?.clientReceived ?? null,
				serverIssued:
					steadyDrainWindow.emitter.snapshotIssued +
					steadyDrainWindow.emitter.ackIssued,
				kernelDropsSocket: steadyDrainWindow.kernel?.serverSocketDrops ?? null,
				kernelRcvbufErrors: steadyDrainWindow.kernel?.RcvbufErrors ?? null,
				serverObserved: steadyDrainWindow.metrics.datagramsIn ?? null,
				jsDelivered: steadyDrainWindow.rxTotal,
				nativeDropped: steadyDrainWindow.metrics.datagramsDropped ?? null,
				nativeSkippedQueueFull:
					steadyDrainWindow.metrics.datagramsSkippedQueueFull ?? null,
			},
		},
		cpuWindows: {
			steady: {
				serverPct:
					steadyWindow.wallMs > 0
						? (steadyWindow.cpuMs / steadyWindow.wallMs) * 100
						: null,
				hostPctMedian: median(hostSteady),
				sessionsActiveMax: marks.drainStart?.metrics.sessionsActive ?? null,
			},
			steadyDrain: {
				serverPct:
					steadyDrainWindow.wallMs > 0
						? (steadyDrainWindow.cpuMs / steadyDrainWindow.wallMs) * 100
						: null,
				sessionsActiveEnd: marks.drainEnd?.metrics.sessionsActive ?? null,
			},
		},
		rawReports: {
			realm: realmReport,
			realmProvenance: chooseClientProvenance({
				provenanceLines: realmRaw.provenanceLines,
				offbox: OFFBOX_SSH !== "",
				exitCode: realmRaw.exitCode,
				localFallback: localClientProvenance(o.candidateSha, realmRaw.exitCode),
			}),
			realmStderr: realmRaw.stderrLines,
			realmStdout: realmRaw.stdoutLines,
			realmExitCode: realmRaw.exitCode,
			realmOutputTruncated: realmRaw.outputTruncated,
			subscriber: subscriberReport,
			subscriberProvenance: chooseClientProvenance({
				provenanceLines: subscriberBundle?.provenanceLines,
				offbox: OFFBOX_SSH !== "",
				exitCode: subscriberBundle?.exitCode ?? null,
				localFallback: subscriberBundle
					? localClientProvenance(o.candidateSha, subscriberBundle.exitCode)
					: [],
			}),
			subscriberStderr: subscriberBundle?.stderrLines ?? [],
			subscriberStdout: subscriberBundle?.stdoutLines ?? [],
			subscriberExitCode: subscriberBundle?.exitCode ?? null,
			subscriberOutputTruncated: subscriberBundle?.outputTruncated ?? false,
			publisher: publisherReport,
			publisherProvenance: chooseClientProvenance({
				provenanceLines: publisherBundle?.provenanceLines,
				offbox: OFFBOX_SSH !== "",
				exitCode: publisherBundle?.exitCode ?? null,
				localFallback: publisherBundle
					? localClientProvenance(o.candidateSha, publisherBundle.exitCode)
					: [],
			}),
			publisherStderr: publisherBundle?.stderrLines ?? [],
			publisherStdout: publisherBundle?.stdoutLines ?? [],
			publisherExitCode: publisherBundle?.exitCode ?? null,
			publisherOutputTruncated: publisherBundle?.outputTruncated ?? false,
		},
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

type PumpedClient = {
	report: Record<string, unknown> | null;
	provenanceLines: string[];
	stdoutLines: string[];
	stderrLines: string[];
	exitCode: number;
	outputTruncated: boolean;
};

const MAX_RETAINED_CLIENT_OUTPUT_LINES = 100_000;

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
			: ["tools/offbox/mac-generator-entry-g6.sh", "--clone", cloneNameFor];
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
const macgenCloneProvisioned = new Set<string>();

async function macgenCloneFor(role: string | null): Promise<string | null> {
	if (!OFFBOX_SSH) return null; // co-resident smoke: shared CLIENT_BIN.
	if (role === null || role === "realm") return null; // default clone.
	const clone = `wt-macgen-${role}`;
	if (macgenCloneProvisioned.has(clone)) return clone;
	// Absolute path on the Mac: a literal `~/…` passed through `--clone` is
	// never tilde-expanded by the entrypoint (bash expands tilde in
	// assignments, not in `CLONE="${2:-}"`), so the clone would fail its
	// `.git` existence check exactly as a provisioning miss would.
	const macHome = await macHomeOf(OFFBOX_SSH);
	const absClone = `${macHome}/${clone}`;
	// Provision on the Mac: clone the probe branch straight from GitHub origin.
	// A clone-from-base lane has a state race: the subclone fetches the base as
	// its origin, and the base is only brought to the new commit by the realm's
	// own macgen fetch — so a subscriber that fetches before the realm lands
	// sees the old commit and dies with "unable to read tree (candidate)".
	// Each role cloning from GitHub directly removes that coupling; the
	// entrypoint's own `git fetch origin` then reconciles any later commits.
	const cloneCmd = g6MacgenCloneCommand({ cloneName: clone });
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
	return absClone;
}

const macHomeCache = new Map<string, string>();
async function macHomeOf(sshDest: string): Promise<string> {
	const cached = macHomeCache.get(sshDest);
	if (cached) return cached;
	const child = spawn(
		"ssh",
		["-o", "BatchMode=yes", sshDest, 'printf %s "$HOME"'],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let out = "";
	child.stdout.on("data", (d) => {
		out += d;
	});
	const code = await new Promise<number>((res) => {
		const t = setTimeout(() => {
			child.kill("SIGKILL");
			res(-1);
		}, 30_000);
		child.on("exit", (c) => {
			clearTimeout(t);
			res(c ?? -1);
		});
	});
	if (code !== 0 || !out.trim()) {
		throw new Error(
			`bench-g6: cannot resolve Mac home of ${sshDest} (exit ${code})`,
		);
	}
	const home = out.trim();
	macHomeCache.set(sshDest, home);
	return home;
}

async function pumpClient(
	client: SpawnedClient,
	onLine: (line: string) => void,
	extraLabel?: string,
): Promise<PumpedClient> {
	let report: Record<string, unknown> | null = null;
	const provenanceLines: string[] = [];
	const stdoutLines: string[] = [];
	const stderrLines: string[] = [];
	const stdoutDecoder = new TextDecoder();
	const stderrDecoder = new TextDecoder();
	let bufferedStdout = "";
	let bufferedStderr = "";
	let outputTruncated = false;
	const debugExtras = process.env.G6_DEBUG_EXTRAS === "1";
	const remember = (lines: string[], line: string) => {
		if (lines.length < MAX_RETAINED_CLIENT_OUTPUT_LINES) {
			lines.push(line);
		} else {
			outputTruncated = true;
		}
	};
	const drainStdout = (async () => {
		for await (const chunk of client.child.stdout ?? []) {
			bufferedStdout += stdoutDecoder.decode(chunk as Uint8Array, {
				stream: true,
			});
			const lines = bufferedStdout.split("\n");
			bufferedStdout = lines.pop() ?? "";
			for (const line of lines) {
				remember(stdoutLines, line);
				onLine(line);
				if (debugExtras && extraLabel) console.error(`${extraLabel}| ${line}`);
				if (line.startsWith("macgen: ")) provenanceLines.push(line);
				const match = line.match(/^mmo-client: json (\{.*\})$/);
				if (match?.[1])
					report = JSON.parse(match[1]) as Record<string, unknown>;
			}
		}
		if (bufferedStdout.length > 0) {
			remember(stdoutLines, bufferedStdout);
			onLine(bufferedStdout);
			if (debugExtras && extraLabel) {
				console.error(`${extraLabel}| ${bufferedStdout}`);
			}
			if (bufferedStdout.startsWith("macgen: ")) {
				provenanceLines.push(bufferedStdout);
			}
			const match = bufferedStdout.match(/^mmo-client: json (\{.*\})$/);
			if (match?.[1]) report = JSON.parse(match[1]) as Record<string, unknown>;
		}
	})();
	const drainStderr = (async () => {
		for await (const chunk of client.child.stderr ?? []) {
			bufferedStderr += stderrDecoder.decode(chunk as Uint8Array, {
				stream: true,
			});
			const lines = bufferedStderr.split("\n");
			bufferedStderr = lines.pop() ?? "";
			for (const line of lines) remember(stderrLines, line);
		}
		if (bufferedStderr.length > 0) remember(stderrLines, bufferedStderr);
	})();
	await Promise.all([drainStdout, drainStderr]);
	const exitCode = await client.exited;
	activeChildren.delete(client.child);
	return {
		report,
		provenanceLines,
		stdoutLines,
		stderrLines,
		exitCode,
		outputTruncated,
	};
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
