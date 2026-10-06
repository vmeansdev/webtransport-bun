/**
 * Informal G6 sharded scan conductor: N g6-shard-server processes share
 * :4433 via SO_REUSEPORT + the pinned steer_by_cid eBPF program, one off-box
 * mmo-client realm fleet drives the registered steady shape at them, and the
 * conductor aggregates per-shard boundary windows.
 *
 * Producer for gate g6-sharded/2 (and for informal characterization runs).
 * The per-shard emitter and the client contract are the gate's own; what is
 * new here is only the process split and the summation. The registered half
 * is tools/load/g6-sharded-grade.ts, which grades this file's schema.
 *
 * Env: SCAN_SHARDS (2), SCAN_SERVER_WORKERS (2), SCAN_SERVER_GRO (on),
 *      SCAN_SERVER_RECV_RUNTIME (shared), SCAN_ACK_CADENCE (default),
 *      SCAN_SESSIONS (5000),
 * SCAN_OUT (g6-sharded-scan.json),
 *      SCAN_PIN_DIR (/sys/fs/bpf/quic-lb), G6_OFFBOX_SSH, G6_CANDIDATE_SHA,
 *      G6_PREREGISTRATION_SHA256, G6_SERVER_ADDRESS (10.99.0.2), G6_PORT
 *      (4433), G6_PACED_EMITTER + WEBTRANSPORT_PACER_PPS (per-shard pacing).
 *      SCAN_DIAGNOSTIC (1) — emit a separate g6-sharded-diagnostic.json with
 *      per-shard /proc/<pid>/net/udp + bpftool map dumps + host-load block +
 *      lifecycle capture + mmo-client connectErrorsSample. When unset, the
 *      workload behavior is unchanged from g6-sharded/1. The rated
 *      g6-sharded-scan.json is **unchanged** — the diagnostic block is a
 *      separate artifact. Registration: registrations/g6-sharded-diagnostic-01.md.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	type AckReflectorMode,
	resolveAckReflectorMode,
} from "./g6-ack-reflector-rule.ts";
import {
	type BoundaryMarks,
	type BoundarySnapshot,
	deriveBoundaryWindows,
	readPhaseMarker,
	type ShardWindowMetrics,
	sumWindowQuic,
} from "./g6-artifact.ts";
import {
	countBpfMapEntries,
	diffSlotPackets,
	parseSlotByServerId,
	type SlotPacketCounts,
	sumPerCpuSlotPackets,
	sumPerCpuSteerStats,
} from "./g6-bpf-map.ts";
import {
	readGeneratorWorkOwner,
	shellQuote,
	workGeneratorSshArguments,
} from "./g6-c32-work-remote.ts";
import { trackChildClose, waitForChildClose } from "./g6-child-lifecycle.ts";
import {
	allocateClientProcesses,
	evenShare,
	mergeClientReports,
} from "./g6-client-merge.ts";
import {
	assertGeneratorDatagramDriver,
	clientReportsForDriverCheck,
} from "./g6-datagram-driver.ts";
import { type G6EmitterMode, resolveEmitterMode } from "./g6-emitter-mode.ts";
import {
	armsFanoutScript,
	demultiplexFanout,
	ownedFanoutScript,
} from "./g6-generator-fanout.ts";
import { DEFAULT_MAX_BYTES } from "./g6-linux-probe.ts";
import {
	NATIVE_PHASES,
	type NativePhase,
	type NativeSendPathSnapshot,
	nativeSendPathProducerSha256,
	parseNativeSendPath,
} from "./g6-native-send-path.ts";
import { assertOffboxCandidateProvenance } from "./g6-offbox-provenance.ts";
import {
	actionEveryNthTick,
	MOVE_HZ,
	UPSTREAM_PAYLOAD_BYTES,
} from "./g6-plan.ts";
import { resolveServerGroMode } from "./g6-server-gro.ts";
import { isArmsPhase } from "./g6-shard-arms.ts";
import {
	ARMS_REGISTERED,
	armsBarrierParties,
	armsDeadlineSec,
	compareShardCounts,
	floorFacts,
	histogramMaxNs,
	precheckPlan,
	raidPlacementFacts,
	raidProcessArgs,
	raidSourcePortBase,
	realmArmsArgs,
	resolveArmsConfig,
	type ShardCounts,
	sinkFacts,
	skewMs,
	steeringDelta,
	sumShardCounts,
} from "./g6-sharded-arms.ts";
import { createShardBoundaryController } from "./g6-sharded-boundary-controller.ts";
import {
	GENERATOR_SAMPLE_SEPARATOR,
	type GeneratorHostSample,
	type HostUdpCounters,
	INTERFACE_SAMPLE_SEPARATOR,
	type InterfaceSample,
	parseConnectErrorsSample,
	parseGeneratorHostSample,
	parseHostUdpCounters,
	parseInterfaceSample,
	readHostMemoryKb,
	readPerProcessUdpSockets,
	readProcessRssKb,
	selectMidpointSample,
} from "./g6-sharded-diagnostic.ts";

const SHARDS = parseInt(process.env.SCAN_SHARDS ?? "2", 10);
const SESSIONS = parseInt(process.env.SCAN_SESSIONS ?? "5000", 10);
const OUT = process.env.SCAN_OUT ?? "g6-sharded-scan.json";
const DIAGNOSTIC_OUT =
	process.env.SCAN_DIAGNOSTIC_OUT ?? "g6-sharded-diagnostic.json";
const POST_RUN_STEERING_OUT =
	process.env.SCAN_POST_RUN_STEERING_OUT ?? "g6-sharded-post-run-steering.json";
const DIAGNOSTIC = process.env.SCAN_DIAGNOSTIC === "1";
const LINUX_PROBE_ENABLED = process.env.SCAN_LINUX_PROBE_ENABLED === "1";
const LINUX_PROBE_OUT =
	process.env.SCAN_LINUX_PROBE_OUT ?? "g6-linux-probe.jsonl";
const LINUX_PROBE_READY_TIMEOUT_MS = 5_000;
const LINUX_PROBE_PHASE_TIMEOUT_MS = 5_000;
const LINUX_PROBE_STOP_TIMEOUT_MS = 5_000;
const NATIVE_SEND_PATH_FLAG =
	process.env.SCAN_NATIVE_SEND_PATH_DIAGNOSTICS ?? "0";
if (!/^[01]$/.test(NATIVE_SEND_PATH_FLAG))
	throw Error("SCAN_NATIVE_SEND_PATH_DIAGNOSTICS must be 0 or 1");
const NATIVE_SEND_PATH_ENABLED = NATIVE_SEND_PATH_FLAG === "1";
const NATIVE_SEND_PATH_PRODUCER_SHA256 = nativeSendPathProducerSha256();
const DIAGNOSTIC_MIDPOINT_SAMPLE_INTERVAL_MS = 1000;
const PIN_DIR = process.env.SCAN_PIN_DIR ?? "/sys/fs/bpf/quic-lb";
const BPF_READY_RECEIPT =
	process.env.G6_BPF_READY_RECEIPT ?? "/var/tmp/g6-shard-bpf-ready.json";
const BPF_READY_SCHEMA = "g6-shard-bpf-ready/1";
const BPF_READY_MAX_AGE_MS = 60_000;
const OFFBOX_SSH = process.env.G6_OFFBOX_SSH ?? "";
const OFFBOX_SSH_OPTIONS = [
	"-o",
	"BatchMode=yes",
	"-o",
	"IdentitiesOnly=yes",
	"-o",
	"StrictHostKeyChecking=yes",
	"-o",
	"UserKnownHostsFile=/root/.ssh/known_hosts",
	"-i",
	"/root/.ssh/id_ed25519",
] as const;
const OFFBOX_ENTRY_SCRIPT = process.env.G6_OFFBOX_ENTRY_SCRIPT ?? "";
const OFFBOX_CLONE = process.env.G6_OFFBOX_CLONE ?? "";
const CANDIDATE_SHA = process.env.G6_CANDIDATE_SHA ?? "";
const PREREG_SHA = process.env.G6_PREREGISTRATION_SHA256 ?? "";
const SERVER_ADDRESS = process.env.G6_SERVER_ADDRESS ?? "10.99.0.2";
const PORT = parseInt(process.env.G6_PORT ?? "4433", 10);
const PACED = process.env.G6_PACED_EMITTER === "1";
const G6_EMITTER_MODE = resolveEmitterMode(process.env.G6_EMITTER_MODE, PACED);
const ACK_REFLECTOR = resolveAckReflectorMode(process.env.SCAN_ACK_REFLECTOR);
// Tokio worker threads per shard server. The native default is 2; the campaign
// A/B raises it. Refused rather than clamped, exactly like SCAN_SHARDS: a run
// that silently measured a different count than it dispatched is worthless.
const SERVER_WORKERS = parseInt(process.env.SCAN_SERVER_WORKERS ?? "2", 10);
// What the controller set the server NIC's generic-receive-offload to before
// this scan. The scan does not change the setting — it records the dispatch so
// the graders can hold the artifact to it, and observes the live state at each
// diagnostic timestamp so a dispatch the driver ignored cannot pass as taken.
const SERVER_GRO = resolveServerGroMode(process.env.SCAN_SERVER_GRO);
// Which thread quinn's endpoint driver runs on: "shared" (default, the
// addon's Tokio worker pool) or "dedicated" (its own thread per shard). Read
// back from the shard's ready message below, not trusted from this env var
// alone.
const SERVER_RECV_RUNTIME = process.env.SCAN_SERVER_RECV_RUNTIME ?? "shared";
// ACK cadence requested of the client: "default" (quinn's stock cadence) or
// "relaxed" (max_ack_delay 100 ms + ACK_FREQUENCY, threshold 10). Read back
// from the shard's ready message below, not trusted from this env var alone.
const SERVER_ACK_CADENCE = process.env.SCAN_ACK_CADENCE ?? "default";
const SERVER_UDP_SNDBUF_BYTES = parseNonnegativeIntegerEnv(
	"SCAN_SERVER_UDP_SNDBUF_BYTES",
	0,
);
// Cross-connection UDP send batching in the addon: 0 (default) = off, one
// sendmsg per transmit as always; N = up to N datagrams per sendmmsg from a
// flusher thread per shard. Read back from the shard's ready message, not
// trusted from this env var alone.
const UDP_SEND_BATCH = parseNonnegativeIntegerEnv("SCAN_UDP_SEND_BATCH", 0);
const SERVER_UDP_SEND_EAGAIN_MODE =
	process.env.SCAN_SERVER_UDP_SEND_EAGAIN_MODE ?? "wait";
const REFLECT_RING_BYPASS = process.env.SCAN_REFLECT_RING_BYPASS ?? "off";
// wtransport driver datagram read path for BOTH roles: "pump" (library
// default) or "legacy" (WTRANSPORT_DATAGRAM_PUMP=0), the paired A' control.
const DATAGRAM_PUMP_RAW = process.env.SCAN_DATAGRAM_PUMP ?? "pump";
if (DATAGRAM_PUMP_RAW !== "pump" && DATAGRAM_PUMP_RAW !== "legacy")
	throw new Error(
		`g6-sharded-scan: SCAN_DATAGRAM_PUMP must be pump|legacy, got ${DATAGRAM_PUMP_RAW}`,
	);
const DATAGRAM_PUMP: "pump" | "legacy" = DATAGRAM_PUMP_RAW;
const WTRANSPORT_DATAGRAM_PUMP_ENV = DATAGRAM_PUMP === "legacy" ? "0" : "1";

// Post-hoc refusal for a paced cell whose pacer thread did not get the
// priority it was asked for (WEBTRANSPORT_PACER_NICE / _SCHED). The cell has
// already been measured and written by the time this is known, so it is a
// distinct exit code the cell wrapper records and continues past: never a
// kill, and never the client-failure exit 1.
const PACER_PRIORITY_REFUSED_EXIT = 3;

type PacerPriority = {
	requestedNice: number | null;
	requestedSchedRrPriority: number | null;
	knobMalformed: boolean;
	achieved: {
		policy: string;
		rtPriority: number;
		nice: number | null;
		niceErrno: number | null;
		schedErrno: number | null;
	} | null;
};

function pacerPriorityOf(
	stats: Record<string, unknown> | null,
): PacerPriority | null {
	const priority = stats?.priority;
	if (priority === undefined || priority === null) return null;
	return priority as PacerPriority;
}

// One reason per shard whose achieved priority does not match what the
// launch asked for; empty when nothing was asked. A shard whose pacer never
// ran (achieved null) with a request outstanding is a refusal too: that is
// exactly the unapplied-nice blind spot this exists to close.
function pacerPriorityRefusals(
	shards: ReadonlyArray<{
		serverId: number;
		pacerStats: Record<string, unknown> | null;
	}>,
	requestedNice: string | undefined,
	requestedSched: string | undefined,
): string[] {
	if (requestedNice === undefined && requestedSched === undefined) return [];
	const wantNice = requestedNice === undefined ? null : Number(requestedNice);
	const wantRr =
		requestedSched === undefined
			? null
			: Number(requestedSched.trim().toLowerCase().replace(/^rr:/, ""));
	const reasons: string[] = [];
	for (const shard of shards) {
		const priority = pacerPriorityOf(shard.pacerStats);
		const achieved = priority?.achieved ?? null;
		if (achieved === null) {
			reasons.push(`shard ${shard.serverId}: pacer priority never reported`);
			continue;
		}
		if (
			wantNice !== null &&
			(achieved.nice !== wantNice || achieved.niceErrno !== null)
		) {
			reasons.push(
				`shard ${shard.serverId}: nice ${String(achieved.nice)} (errno ${String(achieved.niceErrno)}) != requested ${wantNice}`,
			);
		}
		if (
			wantRr !== null &&
			(achieved.policy !== "rr" ||
				achieved.rtPriority !== wantRr ||
				achieved.schedErrno !== null)
		) {
			reasons.push(
				`shard ${shard.serverId}: sched ${achieved.policy}:${achieved.rtPriority} (errno ${String(achieved.schedErrno)}) != requested rr:${wantRr}`,
			);
		}
	}
	return reasons;
}
const STEADY_SECONDS = 120;
const IDLE_SECONDS = 30;
const DRAIN_GRACE_MS = 1000;
function parsePositiveIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`g6-sharded-scan: ${name} must be a positive integer`);
	}
	return value;
}
function parseNonnegativeIntegerEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`g6-sharded-scan: ${name} must be a nonnegative integer`);
	}
	return value;
}
function parseOptionalPortEnv(name: string): number | null {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return null;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
		throw new Error(`g6-sharded-scan: ${name} must be an integer in 1..65535`);
	}
	return value;
}
const CONNECT_TIMEOUT_SECONDS = parsePositiveIntegerEnv(
	"SCAN_CONNECT_TIMEOUT_SECONDS",
	300,
);
const ENDPOINTS = parsePositiveIntegerEnv("SCAN_ENDPOINTS", 64);
// Generator processes on the off-box host. One mmo-client saturates before
// the box does (home rig P0.0: a 32-session canary saw an 11.6 ms max RTT
// beside a 3000-session client reporting a 63 ms p99 through the same
// server), so the rung can be split across N processes that enter steady
// together through mmo-client's phase barrier; their reports are merged into
// the one mmo-client/2 line every grader reads.
const CLIENT_PROCESSES = parsePositiveIntegerEnv("SCAN_CLIENT_PROCESSES", 1);
const GENERATOR_WORK_OWNER = readGeneratorWorkOwner(
	process.env,
	CLIENT_PROCESSES,
);
const CLIENT_PHASE_BARRIER_DIR = "/tmp/webtransport-g6-phase-barriers";
// Per-shard stderr kept for the diagnostic: the shard writes native warn and
// error events there, so a server-side close reason survives the run.
const SHARD_STDERR_TAIL_LINES = 400;
const CONNECT_CONCURRENCY = parsePositiveIntegerEnv(
	"SCAN_CONNECT_CONCURRENCY",
	500,
);
const CONNECT_RATE_PER_SEC = parseNonnegativeIntegerEnv(
	"SCAN_CONNECT_RATE_PER_SEC",
	0,
);
const WORKLOAD_ACTIVE_SESSIONS = parsePositiveIntegerEnv(
	"SCAN_WORKLOAD_ACTIVE_SESSIONS",
	SESSIONS,
);
if (WORKLOAD_ACTIVE_SESSIONS > SESSIONS) {
	throw new Error(
		"g6-sharded-scan: SCAN_WORKLOAD_ACTIVE_SESSIONS must not exceed SCAN_SESSIONS",
	);
}
const FIXED_SOURCE_PORT_BASE = parseOptionalPortEnv(
	"SCAN_FIXED_SOURCE_PORT_BASE",
);
// SCAN_ARM selects the sharded arms (plan 2026-10-06-g6-sharded-arms r6):
// steady (default; nothing below changes), hotspot or storm.
const ARMS = resolveArmsConfig(process.env, {
	shards: SHARDS,
	sessions: SESSIONS,
	activeSessions: WORKLOAD_ACTIVE_SESSIONS,
});
const LINUX_PROBE_MAX_BYTES = parsePositiveIntegerEnv(
	"SCAN_LINUX_PROBE_MAX_BYTES",
	DEFAULT_MAX_BYTES,
);
const RUNTIME_TMP_ROOT = join(process.cwd(), ".scratch", "runtime-tmp");

if (!OFFBOX_SSH || !CANDIDATE_SHA || !PREREG_SHA) {
	throw new Error(
		"g6-sharded-scan: G6_OFFBOX_SSH, G6_CANDIDATE_SHA and G6_PREREGISTRATION_SHA256 are required",
	);
}
if (!OFFBOX_ENTRY_SCRIPT.startsWith("/")) {
	throw new Error(
		"g6-sharded-scan: G6_OFFBOX_ENTRY_SCRIPT must be an absolute path in the checked-out generator clone",
	);
}
if (!OFFBOX_CLONE) {
	throw new Error("g6-sharded-scan: G6_OFFBOX_CLONE is required");
}
// The pinned sockarray is sized at build time, so the setup script rebuilds
// the BPF program with -DMAX_INSTANCES=<shards>; 64 is the largest vCPU count
// the campaign shards for.
if (!Number.isInteger(SHARDS) || SHARDS < 1 || SHARDS > 64) {
	throw new Error("g6-sharded-scan: SCAN_SHARDS must be 1..64");
}
// Mirrors the native bound in crates/native/src/lib.rs; the addon aborts
// out-of-range anyway, but refusing here names the dispatch that was wrong
// instead of leaving an aborted shard to explain itself.
if (
	!Number.isInteger(SERVER_WORKERS) ||
	SERVER_WORKERS < 1 ||
	SERVER_WORKERS > 8
) {
	throw new Error("g6-sharded-scan: SCAN_SERVER_WORKERS must be 1..8");
}
// Naming the bad dispatch beats leaving an aborted shard to explain itself,
// exactly like SCAN_SERVER_WORKERS.
if (SERVER_RECV_RUNTIME !== "shared" && SERVER_RECV_RUNTIME !== "dedicated") {
	throw new Error(
		"g6-sharded-scan: SCAN_SERVER_RECV_RUNTIME must be shared or dedicated",
	);
}
// Same reasoning as SCAN_SERVER_RECV_RUNTIME.
if (SERVER_ACK_CADENCE !== "default" && SERVER_ACK_CADENCE !== "relaxed") {
	throw new Error(
		"g6-sharded-scan: SCAN_ACK_CADENCE must be default or relaxed",
	);
}
if (
	SERVER_UDP_SNDBUF_BYTES !== 0 &&
	(SERVER_UDP_SNDBUF_BYTES < 65_536 || SERVER_UDP_SNDBUF_BYTES > 67_108_864)
) {
	throw new Error(
		"g6-sharded-scan: SCAN_SERVER_UDP_SNDBUF_BYTES must be 0 or 65536..=67108864",
	);
}
if (
	SERVER_UDP_SEND_EAGAIN_MODE !== "wait" &&
	SERVER_UDP_SEND_EAGAIN_MODE !== "drop"
) {
	throw new Error(
		"g6-sharded-scan: SCAN_SERVER_UDP_SEND_EAGAIN_MODE must be wait or drop",
	);
}
// The probe module parses shard lists generically, so any shard count works.
if (LINUX_PROBE_ENABLED && !DIAGNOSTIC) {
	throw new Error("g6-sharded-scan: Linux probe requires diagnostics");
}
if (NATIVE_SEND_PATH_ENABLED && !DIAGNOSTIC)
	throw Error("native send-path measurements require diagnostics");

type Shard = {
	serverId: number;
	child: ReturnType<typeof spawn>;
	boundaries: ReturnType<
		typeof createShardBoundaryController<BoundarySnapshot>
	>;
	emitterMode: G6EmitterMode | null;
	// The pacer's own stats as of the drain boundary: the pacer thread
	// spawns on the first paced send, after the steady boundary (the emitter
	// is idle during connect), so drain is the earliest boundary that can
	// carry the thread priority it actually achieved. null until then, {}
	// when the pacer is off.
	pacerStats: Record<string, unknown> | null;
	sendPathBoundaries: Partial<
		Record<NativePhase | "stop", NativeSendPathSnapshot>
	>;
	sendPathClosed: NativeSendPathSnapshot | null;
	expectedStop: boolean;
	stopBoundaryReceived: boolean;
	marks: Partial<BoundaryMarks> & { stop?: BoundarySnapshot };
	sessionsAtSteady: number | null;
	sessionsByKindAtSteady: {
		player: number;
		raid: number;
		publisher: number;
	} | null;
	// Sharded arms: the shard's "arms" echo at each boundary, keyed by phase.
	armsEchoes: Record<string, unknown>;
	stderrTail: string[];
	// DIAGNOSTIC: per-shard lifecycle (every child.on('exit') with timestamp
	// and signal name; the post-run SIGKILL cleanup at line ~408 is recorded
	// but excluded from D1 by the t2+5s filter at the discrimination step).
	lifecycle: Array<{
		tsMs: number;
		code: number | null;
		signal: NodeJS.Signals | null;
	}>;
	// DIAGNOSTIC: timestamps of every boundary message received (so a
	// missing shard's boundary is visible).
	boundaryArrivedAt: Array<{ phase: string; tsMs: number }>;
};

type LinuxProbeState = {
	child: ReturnType<typeof spawn>;
	exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	stderrTail: string[];
	stdoutTail: string[];
	phase: LinuxProbePhase | null;
	nextRequestId: number;
	pendingPhaseAcks: Map<number, LinuxProbePendingAck>;
	stopped: boolean;
};

type LinuxProbePhase = "connect" | "steady" | "drain" | "idle";

type LinuxProbePendingAck = {
	phase: LinuxProbePhase;
	timeout: ReturnType<typeof setTimeout>;
	resolve: () => void;
	reject: (error: Error) => void;
};

const LINUX_PROBE_PRODUCER_SHA256 = createHash("sha256")
	.update(readFileSync(new URL("./g6-linux-probe.ts", import.meta.url)))
	.digest("hex");

async function startLinuxProbe(
	shards: readonly Shard[],
): Promise<LinuxProbeState> {
	const stderrTail: string[] = [];
	const stdoutTail: string[] = [];
	const pendingPhaseAcks = new Map<number, LinuxProbePendingAck>();
	const child = spawn(
		process.execPath,
		[
			join(import.meta.dir, "g6-linux-probe.ts"),
			"--mode",
			"connect",
			"--out",
			LINUX_PROBE_OUT,
			"--shards",
			shards
				.map((shard) => `${shard.serverId}=${shard.child.pid ?? 0}`)
				.join(","),
			"--max-bytes",
			String(LINUX_PROBE_MAX_BYTES),
			"--producer-sha256",
			LINUX_PROBE_PRODUCER_SHA256,
			"--detail-mode",
			"on",
		],
		{ cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
	);
	trackChildClose(child);
	if (child.stdout === null || child.stderr === null) {
		child.kill("SIGKILL");
		await waitForChildClose(child);
		throw new Error("g6-sharded-scan: Linux probe stdio is unavailable");
	}
	const exit = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) =>
		child.once("exit", (code, signal) => resolve({ code, signal })),
	);
	createInterface({ input: child.stderr }).on("line", (line) => {
		stderrTail.push(line);
		if (stderrTail.length > 20) stderrTail.shift();
		console.error(`[linux probe stderr] ${line}`);
	});
	try {
		await new Promise<void>((resolve, reject) => {
			let ready = false;
			const timeout = setTimeout(() => {
				reject(new Error("g6-sharded-scan: Linux probe ready timeout"));
			}, LINUX_PROBE_READY_TIMEOUT_MS);
			const output = createInterface({ input: child.stdout });
			output.on("line", (line) => {
				stdoutTail.push(line);
				if (stdoutTail.length > 20) stdoutTail.shift();
				if (line === "g6-linux-probe: ready" && !ready) {
					ready = true;
					clearTimeout(timeout);
					resolve();
					return;
				}
				try {
					const message = JSON.parse(line) as {
						ev?: string;
						requestId?: number;
						phase?: LinuxProbePhase;
						error?: string;
					};
					if (
						message.ev === "phase-ack" &&
						typeof message.requestId === "number"
					) {
						const pending = pendingPhaseAcks.get(message.requestId);
						if (!pending) return;
						clearTimeout(pending.timeout);
						pendingPhaseAcks.delete(message.requestId);
						if (message.phase !== pending.phase) {
							pending.reject(
								new Error(
									`g6-sharded-scan: Linux probe ack phase ${message.phase ?? "unknown"} != ${pending.phase}`,
								),
							);
							return;
						}
						pending.resolve();
						return;
					}
					if (
						message.ev === "phase-error" &&
						typeof message.requestId === "number"
					) {
						const pending = pendingPhaseAcks.get(message.requestId);
						if (!pending) return;
						clearTimeout(pending.timeout);
						pendingPhaseAcks.delete(message.requestId);
						pending.reject(
							new Error(
								`g6-sharded-scan: Linux probe phase ${pending.phase} failed: ${message.error ?? "unknown error"}`,
							),
						);
					}
				} catch {
					// Keep non-JSON stdout lines for timeout diagnostics.
				}
			});
			child.once("exit", (code, signal) => {
				for (const [requestId, pending] of pendingPhaseAcks) {
					clearTimeout(pending.timeout);
					pending.reject(
						new Error(
							`g6-sharded-scan: Linux probe exited while waiting for ${pending.phase} (${code ?? signal ?? "unknown"})`,
						),
					);
					pendingPhaseAcks.delete(requestId);
				}
				if (ready) return;
				clearTimeout(timeout);
				reject(
					new Error(
						`g6-sharded-scan: Linux probe exited before ready (${code ?? signal ?? "unknown"}): ${stderrTail.join(" | ")}`,
					),
				);
			});
		});
	} catch (error) {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		await waitForChildClose(child);
		throw error;
	}
	return {
		child,
		exit,
		stderrTail,
		stdoutTail,
		phase: null,
		nextRequestId: 1,
		pendingPhaseAcks,
		stopped: false,
	};
}

async function setLinuxProbePhase(
	probe: LinuxProbeState,
	phase: LinuxProbePhase,
): Promise<void> {
	if (probe.stopped)
		throw new Error(
			`g6-sharded-scan: Linux probe already stopped before ${phase}`,
		);
	if (probe.child.stdin === null) {
		throw new Error("g6-sharded-scan: Linux probe stdin is unavailable");
	}
	const requestId = probe.nextRequestId;
	probe.nextRequestId += 1;
	const ack = new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			probe.pendingPhaseAcks.delete(requestId);
			reject(
				new Error(
					`g6-sharded-scan: Linux probe ${phase} ack timeout: ${probe.stdoutTail.join(" | ")}`,
				),
			);
		}, LINUX_PROBE_PHASE_TIMEOUT_MS);
		probe.pendingPhaseAcks.set(requestId, { phase, timeout, resolve, reject });
	});
	probe.child.stdin.write(
		`${JSON.stringify({ cmd: "phase", phase, requestId })}\n`,
	);
	await ack;
	probe.phase = phase;
}

async function stopLinuxProbe(probe: LinuxProbeState): Promise<void> {
	if (probe.stopped) return;
	probe.stopped = true;
	for (const [requestId, pending] of probe.pendingPhaseAcks) {
		clearTimeout(pending.timeout);
		pending.reject(
			new Error(
				`g6-sharded-scan: Linux probe stopped before ${pending.phase} ack`,
			),
		);
		probe.pendingPhaseAcks.delete(requestId);
	}
	if (probe.child.exitCode === null && probe.child.signalCode === null)
		probe.child.kill("SIGTERM");
	const result = await Promise.race([
		probe.exit,
		Bun.sleep(LINUX_PROBE_STOP_TIMEOUT_MS).then(() => null),
	]);
	if (result === null) {
		probe.child.kill("SIGKILL");
		await waitForChildClose(probe.child);
		throw new Error("g6-sharded-scan: Linux probe stop timeout");
	}
	await waitForChildClose(probe.child);
	if (result.code !== 0 || result.signal !== null) {
		throw new Error(
			`g6-sharded-scan: Linux probe exited ${result.code ?? result.signal ?? "unknown"}: ${probe.stderrTail.join(" | ")}`,
		);
	}
}

function readKernelUdp(): HostUdpCounters | null {
	try {
		return parseHostUdpCounters(readFileSync("/proc/net/snmp", "utf8"));
	} catch {
		return null;
	}
}

// === DIAGNOSTIC HELPERS (g6-sharded-diagnostic-01) ===
// All diagnostic helpers are read-only. They sample OS state (per-shard
// /proc/<pid>/net/udp, BPF maps via bpftool, host-load sysfs) at wall-clock
// triggers (T0, T1, T2). The producer's rated path is untouched: the producer
// is byte-identical to the parent's c9586585; the diagnostic surface is the
// conductor only.

// dumpBpfMap runs `bpftool -j map dump pinned <mapName>` and returns the raw
// JSON output. Used for steer_stats (per-cpu), slot_packets (per-cpu, per
// sockarray slot), socks (slot-to-fd), and slot_by_server_id
// (server-id-to-slot).  JSON is deliberate: bpftool's text
// layout is not stable across versions (notably, Ubuntu's output puts keys and
// values on separate lines). Read-only after producer startup.
function dumpBpfMap(mapName: string): string | null {
	try {
		const out = execFileSync(
			"bpftool",
			["-j", "map", "dump", "pinned", mapName],
			{
				encoding: "utf8",
				timeout: 5000,
			},
		);
		return out;
	} catch {
		return null;
	}
}

// Per-interface counters (/proc/net/dev plus `ethtool -S` for every
// non-loopback interface) on both hosts at each phase mark. r82 showed
// client->server datagrams vanishing between the generator's OutDatagrams and
// the server's InDatagrams with every UDP counter clean, so the layer below
// UDP is sampled too. Both samples run asynchronously so the rated phase
// broadcast is never delayed; they are awaited only when the diagnostic file
// is assembled. Observational only; null when unreachable.
const INTERFACE_SAMPLE_SCRIPT = [
	"cat /proc/net/dev",
	`for i in $(ls /sys/class/net | grep -v '^lo$'); do printf '%s %s\\n' '${INTERFACE_SAMPLE_SEPARATOR}' "$i"; ethtool -S "$i" 2>/dev/null || true; done`,
	"true",
].join("; ");

function sampleInterfaces(
	command: string,
	args: readonly string[],
): Promise<InterfaceSample | null> {
	return new Promise((resolve) => {
		execFile(
			command,
			[...args],
			{ encoding: "utf8", timeout: 5000 },
			(error, stdout) => {
				resolve(error ? null : parseInterfaceSample(String(stdout)));
			},
		);
	});
}

function startServerInterfaceSample(): Promise<InterfaceSample | null> {
	return sampleInterfaces("bash", ["-c", INTERFACE_SAMPLE_SCRIPT]);
}

function startGeneratorInterfaceSample(): Promise<InterfaceSample | null> {
	if (!OFFBOX_SSH) return Promise.resolve(null);
	return sampleInterfaces("ssh", [
		...OFFBOX_SSH_OPTIONS,
		OFFBOX_SSH,
		INTERFACE_SAMPLE_SCRIPT,
	]);
}

async function settleSamples<T>(
	pending: Partial<Record<string, Promise<T | null>>>,
): Promise<Record<string, T | null>> {
	const entries = await Promise.all(
		Object.entries(pending).map(
			async ([phase, promise]) =>
				[phase, (await promise) ?? null] as [string, T | null],
		),
	);
	return Object.fromEntries(entries);
}

// readGeneratorHostSample reads the load generator's loadavg, meminfo, and the
// mmo-client RSS over the same offbox SSH path that spawns the client. The
// generator's socket receive buffers overflowed at 30k in r75 and r80 while
// the server was clean, so its host state is captured next to the server's at
// every diagnostic timestamp. Observational only; null when unreachable.
function readGeneratorHostSample(): GeneratorHostSample | null {
	if (!OFFBOX_SSH) return null;
	const remote = [
		"cat /proc/loadavg",
		`printf '%s\\n' '${GENERATOR_SAMPLE_SEPARATOR}'`,
		"cat /proc/meminfo",
		`printf '%s\\n' '${GENERATOR_SAMPLE_SEPARATOR}'`,
		"for pid in $(pgrep -x mmo-client); do cat /proc/$pid/status; done",
		"true",
	].join("; ");
	try {
		const out = execFileSync(
			"ssh",
			[...OFFBOX_SSH_OPTIONS, OFFBOX_SSH, remote],
			{ encoding: "utf8", timeout: 5000 },
		);
		return parseGeneratorHostSample(out);
	} catch {
		return null;
	}
}

// The bench interface is the one carrying G6_SERVER_ADDRESS — the same private
// address the generator sends to — so the scan never has to be told a device
// name. `ethtool -k` reports the live GRO state; null when the interface cannot
// be resolved or ethtool is unavailable, which the graders read as "unobserved".
function readServerGroState(): "on" | "off" | null {
	try {
		const addresses = execFileSync("ip", ["-o", "-4", "addr", "show"], {
			encoding: "utf8",
			timeout: 5000,
		});
		const line = addresses
			.split("\n")
			.find((entry) => entry.includes(` ${SERVER_ADDRESS}/`));
		const iface = line?.trim().split(/\s+/)[1];
		if (!iface) return null;
		const features = execFileSync("ethtool", ["-k", iface], {
			encoding: "utf8",
			timeout: 5000,
		});
		const feature = features
			.split("\n")
			.find((entry) => entry.startsWith("generic-receive-offload:"));
		if (!feature) return null;
		return feature.includes(": on") ? "on" : "off";
	} catch {
		return null;
	}
}

// readHostLoad captures the host-load block per registration-common.md §3.2.
// loadavg (1/5/15), cpuMhz (per-core, not averaged), packageTempC (k10temp
// or coretemp, named never indexed), governor, residentServices.
function readHostLoad(): {
	tsMs: number;
	loadavg: { "1": number; "5": number; "15": number };
	cpuMhz: Record<string, number>;
	packageTempC: number | null;
	governor: string | null;
	gro: "on" | "off" | null;
	residentServices: { docker: boolean; tailscaled: boolean };
} {
	const tsMs = Date.now();
	let loadavg: { "1": number; "5": number; "15": number } = {
		"1": 0,
		"5": 0,
		"15": 0,
	};
	try {
		const text = readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/);
		loadavg = {
			"1": Number(text[0]) || 0,
			"5": Number(text[1]) || 0,
			"15": Number(text[2]) || 0,
		};
	} catch {
		// leave defaults
	}
	const cpuMhz: Record<string, number> = {};
	try {
		const { readdirSync, readFileSync: rfs } =
			require("node:fs") as typeof import("node:fs");
		const cpuDirs = readdirSync("/sys/devices/system/cpu").filter((d) =>
			/^cpu\d+$/.test(d),
		);
		for (const cpuDir of cpuDirs) {
			try {
				const v = rfs(
					`/sys/devices/system/cpu/${cpuDir}/cpufreq/scaling_cur_freq`,
					"utf8",
				).trim();
				cpuMhz[cpuDir] = Math.round(Number(v) / 1000);
			} catch {
				// missing per-core freq; skip
			}
		}
	} catch {
		// /sys/devices/system/cpu missing; leave empty
	}
	let packageTempC: number | null = null;
	try {
		const { readdirSync, readFileSync: rfs } =
			require("node:fs") as typeof import("node:fs");
		const hwmons = readdirSync("/sys/class/hwmon").filter((d) =>
			/^\d+$/.test(d),
		);
		for (const hw of hwmons) {
			try {
				const name = rfs(`/sys/class/hwmon/${hw}/name`, "utf8").trim();
				if (name === "k10temp" || name === "coretemp") {
					const v = rfs(`/sys/class/hwmon/${hw}/temp1_input`, "utf8").trim();
					packageTempC = Math.round(Number(v) / 1000);
					break;
				}
			} catch {
				// try next hwmon
			}
		}
	} catch {
		// /sys/class/hwmon missing; leave null
	}
	let governor: string | null = null;
	try {
		governor = readFileSync(
			"/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor",
			"utf8",
		).trim();
	} catch {
		// missing
	}
	// residentServices is a process-level check, not a file read. The
	// conductor (running on the rig) doesn't know the resident-services
	// convention itself; the orchestrator records it. The diagnostic
	// records `null` here and the stamp's per-cell block carries the
	// orchestrator's recording.
	return {
		tsMs,
		loadavg,
		cpuMhz,
		packageTempC,
		governor,
		gro: readServerGroState(),
		residentServices: { docker: false, tailscaled: false },
	};
}

function nonnegativeSafeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

type BpfReadyReceiptValidation = {
	valid: boolean;
	reason: string;
	schema: string | null;
	createdAtMs: number | null;
	instances: number | null;
	ageMs: number | null;
};

function readBpfReadyReceipt(): string | null {
	try {
		return readFileSync(BPF_READY_RECEIPT, "utf8");
	} catch {
		return null;
	}
}

function validateBpfReadyReceipt(
	rawReceipt: string | null,
	armedAtMs: number,
): BpfReadyReceiptValidation {
	if (rawReceipt === null) {
		return {
			valid: false,
			reason: "missing",
			schema: null,
			createdAtMs: null,
			instances: null,
			ageMs: null,
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawReceipt);
	} catch {
		return {
			valid: false,
			reason: "malformed-json",
			schema: null,
			createdAtMs: null,
			instances: null,
			ageMs: null,
		};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			valid: false,
			reason: "not-an-object",
			schema: null,
			createdAtMs: null,
			instances: null,
			ageMs: null,
		};
	}
	const receipt = parsed as Record<string, unknown>;
	const schema = typeof receipt.schema === "string" ? receipt.schema : null;
	const createdAtMs = nonnegativeSafeInteger(receipt.createdAtMs);
	const instances = nonnegativeSafeInteger(receipt.instances);
	const ageMs = createdAtMs === null ? null : armedAtMs - createdAtMs;
	if (
		schema !== BPF_READY_SCHEMA ||
		createdAtMs === null ||
		instances === null
	) {
		return {
			valid: false,
			reason: "invalid-fields",
			schema,
			createdAtMs,
			instances,
			ageMs,
		};
	}
	if (instances !== SHARDS) {
		return {
			valid: false,
			reason: "instances-mismatch",
			schema,
			createdAtMs,
			instances,
			ageMs,
		};
	}
	if (createdAtMs > armedAtMs) {
		return {
			valid: false,
			reason: "future",
			schema,
			createdAtMs,
			instances,
			ageMs,
		};
	}
	if (armedAtMs - createdAtMs > BPF_READY_MAX_AGE_MS) {
		return {
			valid: false,
			reason: "stale",
			schema,
			createdAtMs,
			instances,
			ageMs,
		};
	}
	return {
		valid: true,
		reason: "valid",
		schema,
		createdAtMs,
		instances,
		ageMs,
	};
}

function captureBpfPreArm(): {
	fresh: boolean;
	armedAtMs: number;
	rawReceipt: string | null;
	receiptValidation: BpfReadyReceiptValidation;
	socksEntries: number | null;
	steerStats: { steered: number; fallback: number } | null;
	slotPacketsRaw: string | null;
	slotPackets: Record<number, SlotPacketCounts> | null;
} {
	const armedAtMs = Date.now();
	const rawReceipt = readBpfReadyReceipt();
	const receiptValidation = validateBpfReadyReceipt(rawReceipt, armedAtMs);
	const socksMapDump = dumpBpfMap(`${PIN_DIR}/socks`);
	const steerStatsRaw = dumpBpfMap(`${PIN_DIR}/steer_stats`);
	const socksEntries =
		socksMapDump === null ? null : countBpfMapEntries(socksMapDump);
	const steerStats =
		steerStatsRaw === null ? null : sumPerCpuSteerStats(steerStatsRaw);
	const slotPacketsRaw = dumpBpfMap(`${PIN_DIR}/slot_packets`);
	const slotPackets =
		slotPacketsRaw === null ? null : sumPerCpuSlotPackets(slotPacketsRaw);
	const fresh =
		receiptValidation.valid &&
		socksEntries === SHARDS &&
		steerStats?.steered === 0 &&
		steerStats.fallback === 0;
	return {
		fresh,
		armedAtMs,
		rawReceipt,
		receiptValidation,
		socksEntries,
		steerStats,
		slotPacketsRaw,
		slotPackets,
	};
}

async function main(): Promise<void> {
	const shards: Shard[] = [];
	const clients: ReturnType<typeof spawn>[] = [];
	let linuxProbe: LinuxProbeState | null = null;
	let runtimeDir: string | null = null;
	let stopCurrentRung: (() => void) | null = null;
	try {
		assertOffboxCandidateProvenance({
			offboxClone: OFFBOX_CLONE,
			entryScript: OFFBOX_ENTRY_SCRIPT,
			candidateSha: CANDIDATE_SHA,
			run: (remoteArgs) =>
				execFileSync(
					"ssh",
					[...OFFBOX_SSH_OPTIONS, OFFBOX_SSH, ...remoteArgs],
					{
						encoding: "utf8",
						timeout: 15_000,
					},
				),
		});
		const tls = generateLocalhostCert();
		if (!tls) throw new Error("g6-sharded-scan: cert generation failed");
		mkdirSync(RUNTIME_TMP_ROOT, { recursive: true });
		const dir = mkdtempSync(join(RUNTIME_TMP_ROOT, "g6-shard-"));
		runtimeDir = dir;
		const certPath = join(dir, "cert.pem");
		const keyPath = join(dir, "key.pem");
		writeFileSync(certPath, tls.certPem);
		writeFileSync(keyPath, tls.keyPem);

		const readyPromises: Promise<void>[] = [];

		// Root needs no sudo — and must not use it: Ubuntu 26.04's sudo ignores
		// -E ("preserving the entire environment is not supported"), which
		// silently strips WEBTRANSPORT_PACER_PPS from the shards and turns every
		// paced admission into a throw.
		const asRoot = process.getuid?.() === 0;
		for (let i = 1; i <= SHARDS; i += 1) {
			const args = [
				"tools/load/g6-shard-server.ts",
				"--port",
				String(PORT),
				"--server-id",
				String(i),
				"--cert",
				certPath,
				"--key",
				keyPath,
				"--sock-array-pin",
				`${PIN_DIR}/socks`,
				"--top-sessions",
				String(SESSIONS),
				"--paced",
				PACED ? "1" : "0",
				"--emitter-mode",
				G6_EMITTER_MODE,
				"--ack-reflector",
				ACK_REFLECTOR,
				"--send-path-diagnostics",
				NATIVE_SEND_PATH_FLAG,
			];
			// One attach per group is enough; the attach lives on the reuseport
			// group, so the first shard carries it.
			if (i === 1) args.push("--attach-prog-pin", `${PIN_DIR}/steer_by_cid`);
			// The addon resolves its worker count once, when it builds the
			// server runtime, so this has to be in the child's environment
			// before it starts — a CLI flag would arrive too late.
			const shardEnv = {
				...process.env,
				WEBTRANSPORT_NATIVE_SERVER_WORKERS: String(SERVER_WORKERS),
				WEBTRANSPORT_NATIVE_SERVER_RECV_RUNTIME: SERVER_RECV_RUNTIME,
				WEBTRANSPORT_NATIVE_ACK_CADENCE: SERVER_ACK_CADENCE,
				WEBTRANSPORT_NATIVE_SERVER_UDP_SNDBUF_BYTES: String(
					SERVER_UDP_SNDBUF_BYTES,
				),
				WEBTRANSPORT_NATIVE_UDP_SEND_BATCH: String(UDP_SEND_BATCH),
				WEBTRANSPORT_NATIVE_UDP_SEND_EAGAIN_MODE: SERVER_UDP_SEND_EAGAIN_MODE,
				WEBTRANSPORT_NATIVE_REFLECT_RING_BYPASS:
					REFLECT_RING_BYPASS === "on" ? "1" : "0",
				WTRANSPORT_DATAGRAM_PUMP: WTRANSPORT_DATAGRAM_PUMP_ENV,
				// The addon writes warn/error events verbatim to the shard's
				// stderr (peer ip:port included), bypassing its bounded log
				// channel and the JS loop; the scan keeps that stderr per shard.
				WEBTRANSPORT_NATIVE_STDERR_WARNINGS: "1",
				WEBTRANSPORT_NATIVE_SEND_PATH_DIAGNOSTICS: NATIVE_SEND_PATH_FLAG,
			};
			const child = asRoot
				? spawn(process.execPath, args, {
						cwd: process.cwd(),
						env: shardEnv,
						stdio: ["pipe", "pipe", "pipe"],
					})
				: spawn("sudo", ["-E", process.execPath, ...args], {
						cwd: process.cwd(),
						env: shardEnv,
						stdio: ["pipe", "pipe", "pipe"],
					});
			trackChildClose(child);
			const shard: Shard = {
				serverId: i,
				child,
				boundaries: createShardBoundaryController<BoundarySnapshot>(),
				emitterMode: null,
				pacerStats: null,
				sendPathBoundaries: {},
				sendPathClosed: null,
				expectedStop: false,
				stopBoundaryReceived: false,
				marks: {},
				sessionsAtSteady: null,
				sessionsByKindAtSteady: null,
				armsEchoes: {},
				stderrTail: [],
				lifecycle: [],
				boundaryArrivedAt: [],
			};
			shards.push(shard);
			let readyResolve!: () => void;
			let readyReject!: (e: unknown) => void;
			readyPromises.push(
				new Promise<void>((res, rej) => {
					readyResolve = res;
					readyReject = rej;
				}),
			);
			const failShard = (error: unknown): void => {
				shard.boundaries.fail(error);
				readyReject(error);
			};
			child.on("exit", (code, signal) => {
				// DIAGNOSTIC: every exit is recorded with timestamp and signal
				// name, regardless of code. The post-run SIGKILL cleanup is
				// filtered at the discrimination step (tsMs > rung_T2 + 5s).
				if (DIAGNOSTIC) {
					shard.lifecycle.push({ tsMs: Date.now(), code, signal });
				}
				if (!shard.expectedStop || !shard.stopBoundaryReceived) {
					failShard(
						new Error(
							`shard ${i} exited ${code ?? signal ?? "unknown"}: ${shard.stderrTail.join(" | ")}`,
						),
					);
				}
			});
			createInterface({ input: child.stderr! }).on("line", (line) => {
				shard.stderrTail.push(line);
				if (shard.stderrTail.length > SHARD_STDERR_TAIL_LINES)
					shard.stderrTail.shift();
				console.error(`[shard ${i} stderr] ${line}`);
			});
			createInterface({ input: child.stdout! }).on("line", (line) => {
				let msg: {
					ev?: string;
					snap?: BoundarySnapshot;
					phase?: string;
					emitterMode?: G6EmitterMode;
					ackReflector?: AckReflectorMode;
					serverWorkers?: number;
					serverRecvRuntime?: string;
					serverAckCadence?: string;
					serverUdpSendBufferBytes?: number;
					serverUdpSendBatch?: number;
					serverUdpSendEagainMode?: string;
					reflectRingBypass?: string;
					datagramDriver?: string;
					pacerStats?: Record<string, unknown>;
					sendPathDiagnostics?: unknown;
					sendPathProducerSha256?: string;
					arms?: unknown;
					error?: string;
				};
				try {
					msg = JSON.parse(line);
				} catch {
					console.log(`[shard ${i}] ${line}`);
					return;
				}
				if (msg.ev === "ready") {
					try {
						if (msg.sendPathProducerSha256 !== NATIVE_SEND_PATH_PRODUCER_SHA256)
							throw Error("native measurement producer SHA mismatch");
						shard.sendPathBoundaries.unarmed = parseNativeSendPath(
							msg.sendPathDiagnostics,
							{
								enabled: NATIVE_SEND_PATH_ENABLED,
								phase: "unarmed",
								finalized: false,
							},
						);
					} catch (error) {
						failShard(error);
						child.kill("SIGTERM");
						return;
					}
					if (msg.emitterMode !== G6_EMITTER_MODE) {
						failShard(
							new Error(
								`shard ${i} emitterMode ${msg.emitterMode ?? "missing"} != ${G6_EMITTER_MODE}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					if (msg.ackReflector !== ACK_REFLECTOR) {
						failShard(
							new Error(
								`shard ${i} ackReflector ${msg.ackReflector ?? "missing"} != ${ACK_REFLECTOR}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					// The shard reports what its addon actually built, so this
					// catches an environment that never reached the child as
					// well as one the addon refused.
					if (msg.serverWorkers !== SERVER_WORKERS) {
						failShard(
							new Error(
								`shard ${i} serverWorkers ${msg.serverWorkers ?? "missing"} != ${SERVER_WORKERS}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					// Same reasoning as the serverWorkers check above: this catches
					// an environment that never reached the child as well as one
					// the addon refused.
					if (msg.serverRecvRuntime !== SERVER_RECV_RUNTIME) {
						failShard(
							new Error(
								`shard ${i} serverRecvRuntime ${msg.serverRecvRuntime ?? "missing"} != ${SERVER_RECV_RUNTIME}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					// Same reasoning as the serverRecvRuntime check above.
					if (msg.serverUdpSendBatch !== UDP_SEND_BATCH) {
						failShard(
							new Error(
								`shard ${i} serverUdpSendBatch ${msg.serverUdpSendBatch ?? "missing"} != ${UDP_SEND_BATCH}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					if (msg.serverUdpSendEagainMode !== SERVER_UDP_SEND_EAGAIN_MODE) {
						failShard(
							new Error(
								`shard ${i} serverUdpSendEagainMode ${msg.serverUdpSendEagainMode ?? "missing"} != ${SERVER_UDP_SEND_EAGAIN_MODE}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					// The driver mode is read once per process: a shard that echoes a
					// different mode never got (or refused) the environment.
					if (msg.datagramDriver !== DATAGRAM_PUMP) {
						failShard(
							new Error(
								`shard ${i} datagramDriver ${msg.datagramDriver ?? "missing"} != ${DATAGRAM_PUMP}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					if (msg.reflectRingBypass !== REFLECT_RING_BYPASS) {
						failShard(
							new Error(
								`shard ${i} reflectRingBypass ${msg.reflectRingBypass ?? "missing"} != ${REFLECT_RING_BYPASS}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					if (msg.serverAckCadence !== SERVER_ACK_CADENCE) {
						failShard(
							new Error(
								`shard ${i} serverAckCadence ${msg.serverAckCadence ?? "missing"} != ${SERVER_ACK_CADENCE}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					if (msg.serverUdpSendBufferBytes !== SERVER_UDP_SNDBUF_BYTES) {
						failShard(
							new Error(
								`shard ${i} serverUdpSendBufferBytes ${msg.serverUdpSendBufferBytes ?? "missing"} != ${SERVER_UDP_SNDBUF_BYTES}`,
							),
						);
						child.kill("SIGTERM");
						return;
					}
					shard.emitterMode = msg.emitterMode;
					console.log(`g6-sharded-scan: shard ${i} ready`);
					readyResolve();
				} else if (msg.ev === "fatal") {
					failShard(
						new Error(
							`shard ${i} fatal: ${msg.error ?? "unknown emitter failure"}`,
						),
					);
					child.kill("SIGTERM");
				} else if (msg.ev === "send-path-closed") {
					try {
						if (!shard.expectedStop || shard.sendPathClosed !== null)
							throw Error("unexpected or duplicate native terminal evidence");
						shard.sendPathClosed = parseNativeSendPath(
							msg.sendPathDiagnostics,
							{
								enabled: NATIVE_SEND_PATH_ENABLED,
								phase: NATIVE_SEND_PATH_ENABLED ? "idle" : "unarmed",
								finalized: NATIVE_SEND_PATH_ENABLED,
							},
						);
					} catch (error) {
						failShard(error);
						child.kill("SIGTERM");
					}
				} else if (msg.ev === "boundary" && msg.snap) {
					if (msg.arms !== undefined)
						shard.armsEchoes[msg.phase ?? "unknown"] = msg.arms;
					// Arms boundaries (sever / storm / post-storm) cut no native
					// send-path phase; only the steady path's are parsed here.
					if (!isArmsPhase(msg.phase))
						try {
							const phase = msg.phase as NativePhase | "stop";
							if (phase !== "stop" && !NATIVE_PHASES.slice(1).includes(phase))
								throw Error("invalid native boundary phase");
							if (shard.sendPathBoundaries[phase])
								throw Error("duplicate native boundary");
							shard.sendPathBoundaries[phase] = parseNativeSendPath(
								msg.sendPathDiagnostics,
								{
									enabled: NATIVE_SEND_PATH_ENABLED,
									phase: NATIVE_SEND_PATH_ENABLED
										? phase === "stop"
											? "idle"
											: phase
										: "unarmed",
									finalized: false,
								},
							);
						} catch (error) {
							failShard(error);
							child.kill("SIGTERM");
							return;
						}
					if (msg.phase === "stop") {
						shard.stopBoundaryReceived = true;
					}
					if (msg.phase === "drain") {
						shard.pacerStats = msg.pacerStats ?? null;
					}
					// DIAGNOSTIC: every boundary arrival is timestamped.
					if (DIAGNOSTIC) {
						shard.boundaryArrivedAt.push({
							phase: msg.phase ?? "unknown",
							tsMs: Date.now(),
						});
					}
					shard.boundaries.resolve(msg.snap);
				}
			});
		}

		await Promise.all(readyPromises);

		const kernelMarks: Record<string, Record<string, number> | null> = {};
		const broadcast = async (
			cmd: string,
			phase: string | null,
			extra: Record<string, unknown> = {},
		): Promise<BoundarySnapshot[]> => {
			kernelMarks[phase ?? cmd] = readKernelUdp() as Record<
				string,
				number
			> | null;
			return Promise.race([
				Promise.all(
					shards.map((shard) => {
						const boundary = shard.boundaries.wait();
						shard.child.stdin!.write(
							`${JSON.stringify(phase ? { cmd, phase, ...extra } : { cmd })}\n`,
						);
						return boundary;
					}),
				),
				Bun.sleep(5_000).then(() => {
					throw Error(
						`g6-sharded-scan: ${phase ?? cmd} shard boundary deadline exceeded`,
					);
				}),
			]);
		};

		// Give every shard's socket a beat to land in the sockarray before load.
		await Bun.sleep(3000);

		// === DIAGNOSTIC: per-rung block, T0/T1/T2 capture (g6-sharded-diagnostic-01) ===
		// The diagnostic samples OS state at three wall-clock triggers per rung:
		//   T0 = immediately before spawning the mmo-client
		//   T1 = wall-clock T0 + connectWallSec / 2 (computed, not signalled)
		//   T2 = immediately after the mmo-client exits the connect phase
		// The producer's rated path is unchanged. The diagnostic state is collected
		// here and emitted as a separate g6-sharded-diagnostic.json at the end.
		type DiagnosticTimestampBlock = {
			tsMs: number;
			hostLoad: ReturnType<typeof readHostLoad>;
			hostMemoryKb: { totalKb: number; availableKb: number } | null;
			generatorHost: GeneratorHostSample | null;
			perShardRssKb: Record<number, number | null>;
			perShardUdp: Record<number, Record<string, number> | null>;
			perShardHandshakesInFlight: Record<number, number | null>;
			steerStatsSum: { steered: number; fallback: number } | null;
			steerStatsRaw: string | null;
			slotPacketsRaw: string | null;
			slotPackets: Record<number, SlotPacketCounts> | null;
			socksMapDump: string | null;
			slotMapDump: string | null;
		};
		const captureTimestamp = (label: string): DiagnosticTimestampBlock => {
			const tsMs = Date.now();
			const perShardUdp: Record<number, Record<string, number> | null> = {};
			const perShardRssKb: Record<number, number | null> = {};
			const perShardHandshakesInFlight: Record<number, number | null> = {};
			for (const shard of shards) {
				perShardUdp[shard.serverId] = readPerProcessUdpSockets(
					shard.child.pid!,
				);
				perShardRssKb[shard.serverId] = readProcessRssKb(shard.child.pid!);
				// handshakesInFlight is read from the shard's last boundary message
				// (the producer's "connect" boundary at start, or the "steady"
				// boundary at end). The diagnostic does not call into the producer
				// process directly.
				const lastSnap = shard.marks.steadyStart ?? shard.marks.start;
				perShardHandshakesInFlight[shard.serverId] =
					lastSnap &&
					(lastSnap.metrics as Record<string, unknown>).handshakesInFlight !=
						null
						? Number(
								(lastSnap.metrics as Record<string, unknown>)
									.handshakesInFlight,
							)
						: null;
			}
			const steerStatsRaw = dumpBpfMap(`${PIN_DIR}/steer_stats`);
			const steerStatsSum = steerStatsRaw
				? sumPerCpuSteerStats(steerStatsRaw)
				: null;
			const slotPacketsRaw = dumpBpfMap(`${PIN_DIR}/slot_packets`);
			const slotPackets = slotPacketsRaw
				? sumPerCpuSlotPackets(slotPacketsRaw)
				: null;
			const socksMapDump = dumpBpfMap(`${PIN_DIR}/socks`);
			const slotMapDump = dumpBpfMap(`${PIN_DIR}/slot_by_server_id`);
			return {
				tsMs,
				hostLoad: readHostLoad(),
				hostMemoryKb: readHostMemoryKb(),
				generatorHost: readGeneratorHostSample(),
				perShardRssKb,
				perShardUdp,
				perShardHandshakesInFlight,
				steerStatsSum,
				steerStatsRaw,
				slotPacketsRaw,
				slotPackets,
				socksMapDump,
				slotMapDump,
			};
		};
		type DiagnosticRung = {
			rung: number;
			connectStartTsMs: number;
			connectEndTsMs: number | null;
			connectWallSec: number | null;
			t1TargetTsMs: number | null;
			t1OffsetMs: number | null;
			t1SampleCount: number;
			T0: DiagnosticTimestampBlock;
			T1: DiagnosticTimestampBlock | null;
			T2: DiagnosticTimestampBlock | null;
			connectErrorsSample: string[] | null;
			fallbackReasonBreakdown: {
				openingInitialEstimate: number | null;
				fallbackDeltaT2MinusT0: number | null;
				excessFallback: number | null;
				note: string;
			} | null;
		};
		const rungDiagnostics: DiagnosticRung[] = [];
		type DiagnosticPhase = "connect" | "steady" | "drain" | "idle";
		const serverHostUdpSamples: Partial<
			Record<DiagnosticPhase, HostUdpCounters | null>
		> = {};
		const captureServerHostUdp = (phase: DiagnosticPhase): void => {
			serverHostUdpSamples[phase] = readKernelUdp();
		};
		const serverInterfaceSamples: Partial<
			Record<DiagnosticPhase, Promise<InterfaceSample | null>>
		> = {};
		const generatorInterfaceSamples: Partial<
			Record<DiagnosticPhase, Promise<InterfaceSample | null>>
		> = {};
		// Called after the phase broadcast so the rated boundary lands first.
		const captureInterfaceMarks = (phase: DiagnosticPhase): void => {
			serverInterfaceSamples[phase] = startServerInterfaceSample();
			generatorInterfaceSamples[phase] = startGeneratorInterfaceSample();
		};
		const captureRung = (
			rung: number,
			sessionsRequested: number,
		): {
			begin: () => void;
			end: () => void;
			stop: () => void;
			setConnectErrorsSample: (sample: string[] | null) => void;
		} => {
			const block: DiagnosticRung = {
				rung,
				connectStartTsMs: 0,
				connectEndTsMs: null,
				connectWallSec: null,
				t1TargetTsMs: null,
				t1OffsetMs: null,
				t1SampleCount: 0,
				T0: captureTimestamp(`rung${rung}_T0`),
				T1: null,
				T2: null,
				connectErrorsSample: null,
				fallbackReasonBreakdown: null,
			};
			rungDiagnostics.push(block);
			const midpointSamples: DiagnosticTimestampBlock[] = [block.T0];
			let sampler: ReturnType<typeof setInterval> | null = null;
			const stop = (): void => {
				if (sampler) clearInterval(sampler);
				sampler = null;
			};
			return {
				begin: () => {
					block.connectStartTsMs = Date.now();
					sampler = setInterval(() => {
						midpointSamples.push(
							captureTimestamp(`rung${rung}_midpoint_candidate`),
						);
					}, DIAGNOSTIC_MIDPOINT_SAMPLE_INTERVAL_MS);
				},
				end: () => {
					block.connectEndTsMs = Date.now();
					stop();
					block.connectWallSec =
						(block.connectEndTsMs - block.connectStartTsMs) / 1000;
					const midpoint = selectMidpointSample(
						midpointSamples,
						block.connectStartTsMs,
						block.connectEndTsMs,
					);
					block.T1 = midpoint?.sample ?? null;
					block.t1TargetTsMs = midpoint?.targetTsMs ?? null;
					block.t1OffsetMs = midpoint?.offsetMs ?? null;
					block.t1SampleCount = midpointSamples.length;
					block.T2 = captureTimestamp(`rung${rung}_T2`);
					if (block.T0.steerStatsSum && block.T2.steerStatsSum) {
						const fallbackDelta =
							block.T2.steerStatsSum.fallback - block.T0.steerStatsSum.fallback;
						const openingInitialEstimate = sessionsRequested;
						block.fallbackReasonBreakdown = {
							openingInitialEstimate,
							fallbackDeltaT2MinusT0: fallbackDelta,
							excessFallback: Math.max(
								0,
								fallbackDelta - openingInitialEstimate,
							),
							note: "excess fallback is a D2 candidate, not a verdict",
						};
					}
				},
				stop,
				setConnectErrorsSample: (sample) => {
					block.connectErrorsSample = sample;
				},
			};
		};

		const startSnaps = await broadcast("phase", "connect");
		for (const [index, snap] of startSnaps.entries()) {
			(shards[index] as Shard).marks.start = snap;
		}
		if (DIAGNOSTIC) captureServerHostUdp("connect");
		if (DIAGNOSTIC) captureInterfaceMarks("connect");

		// DIAGNOSTIC: capture T0 and begin periodic midpoint candidates. T1 is
		// selected after T2 establishes the actual connect wall interval.
		const currentRung = DIAGNOSTIC ? captureRung(SESSIONS, SESSIONS) : null;
		stopCurrentRung = currentRung?.stop ?? null;
		// Probe spawn + inode walk must finish before begin(). Otherwise
		// connectWallSec includes probe-ready (~54 ms) on on-cells only and
		// the 5% non-interference gate compares two different clocks.
		if (LINUX_PROBE_ENABLED) linuxProbe = await startLinuxProbe(shards);
		if (linuxProbe !== null) await setLinuxProbePhase(linuxProbe, "connect");
		currentRung?.begin();
		let postRunSteering: {
			capturedAtMs: number;
			steerStatsSum: { steered: number; fallback: number };
			slotPacketsRaw: string | null;
			slotPackets: Record<number, SlotPacketCounts> | null;
		} | null = null;
		// The rated steady window is each shard's `phase steady` boundary
		// snapshot -> its `phase drain` boundary snapshot (deriveBoundaryWindows
		// over marks.steadyStart/marks.drainStart). The post-run steering dump
		// is taken in the "stop" branch, which is AFTER drain and idle, so it is
		// the wrong end for a steady comparison: the idle tail's short-header
		// keepalive and ack traffic would inflate the BPF side and look exactly
		// like packets steered to a shard that quinn never received.
		//
		// So bracket the rated window directly. Each dump is taken immediately
		// BEFORE the phase broadcast whose per-shard snapshot defines quinn's
		// boundary, which shifts the BPF interval earlier than quinn's by one
		// broadcast round-trip at each end. That is a few milliseconds against a
		// 120 s window, and it is a shift rather than an inflation.
		type SlotPacketSample = {
			tsMs: number;
			raw: string | null;
			sums: Record<number, SlotPacketCounts> | null;
		};
		const captureSlotPackets = (): SlotPacketSample => {
			const raw = dumpBpfMap(`${PIN_DIR}/slot_packets`);
			return {
				tsMs: Date.now(),
				raw,
				sums: raw === null ? null : sumPerCpuSlotPackets(raw),
			};
		};
		let slotPacketsSteadyStart: SlotPacketSample | null = null;
		let slotPacketsSteadyEnd: SlotPacketSample | null = null;
		const capturePostRunSteering = (): void => {
			if (!DIAGNOSTIC) return;
			if (postRunSteering !== null) {
				throw new Error("g6-sharded-scan: duplicate post-run steering capture");
			}
			const raw = dumpBpfMap(`${PIN_DIR}/steer_stats`);
			if (raw === null) {
				throw new Error("g6-sharded-scan: post-run steering dump failed");
			}
			const steerStatsSum = sumPerCpuSteerStats(raw);
			if (steerStatsSum === null) {
				throw new Error("g6-sharded-scan: post-run steering dump unusable");
			}
			writeFileSync(POST_RUN_STEERING_OUT, raw);
			// Inert: a failed or unusable slot_packets dump records null rather
			// than throwing, so the new counters can never fail a rated run.
			const slotPacketsRaw = dumpBpfMap(`${PIN_DIR}/slot_packets`);
			const slotPackets = slotPacketsRaw
				? sumPerCpuSlotPackets(slotPacketsRaw)
				: null;
			postRunSteering = {
				capturedAtMs: Date.now(),
				steerStatsSum,
				slotPacketsRaw,
				slotPackets,
			};
		};

		const startedAt = new Date().toISOString();
		const deadlineSec = Math.ceil(
			1.5 *
				(CONNECT_TIMEOUT_SECONDS +
					STEADY_SECONDS +
					Math.ceil(DRAIN_GRACE_MS / 1000) +
					IDLE_SECONDS),
		);
		const generatorDeadlineSec =
			ARMS.arm === "steady"
				? deadlineSec
				: armsDeadlineSec(ARMS, {
						connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
						drainMs: DRAIN_GRACE_MS,
						idleSeconds: IDLE_SECONDS,
					});
		if (CONNECT_CONCURRENCY < CLIENT_PROCESSES)
			throw new Error(
				`g6-sharded-scan: connect concurrency ${CONNECT_CONCURRENCY} cannot be split across ${CLIENT_PROCESSES} client processes`,
			);
		const clientPlans = allocateClientProcesses({
			processes: CLIENT_PROCESSES,
			sessions: SESSIONS,
			activeSessions: WORKLOAD_ACTIVE_SESSIONS,
			endpoints: ENDPOINTS,
			fixedSourcePortBase: FIXED_SOURCE_PORT_BASE,
		});
		// One barrier id per scan: mmo-client accepts [A-Za-z0-9._-] only.
		const clientPhaseBarrierId = `g6-scan-${startedAt.replace(/[^A-Za-z0-9._-]/g, "-")}-${process.pid}`;
		const armsBarrier = {
			id: clientPhaseBarrierId,
			dir: CLIENT_PHASE_BARRIER_DIR,
			timeoutMs: CONNECT_TIMEOUT_SECONDS * 1000,
		};
		// The connect shape (concurrency, rate) is split like the sessions, so
		// N processes together present the registered shape, not N times it.
		const clientArgsFor = (plan: (typeof clientPlans)[number]): string[] => [
			"--role",
			"realm",
			"--sessions",
			String(plan.sessions),
			"--active-sessions",
			String(plan.activeSessions),
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
			String(plan.endpoints),
			"--connect-concurrency",
			String(evenShare(CONNECT_CONCURRENCY, CLIENT_PROCESSES, plan.index)),
			"--connect-rate-per-sec",
			String(evenShare(CONNECT_RATE_PER_SEC, CLIENT_PROCESSES, plan.index)),
			...(plan.fixedSourcePortBase === null
				? []
				: ["--fixed-source-port-base", String(plan.fixedSourcePortBase)]),
			"--connect-timeout-secs",
			String(CONNECT_TIMEOUT_SECONDS),
			"--preregistration-sha256",
			PREREG_SHA,
			"--started-at",
			startedAt,
			...(CLIENT_PROCESSES > 1
				? [
						"--phase-barrier-id",
						clientPhaseBarrierId,
						"--phase-barrier-dir",
						CLIENT_PHASE_BARRIER_DIR,
						// Every process is role "realm"; without its own party name
						// they would share one ready file and each count 1/N.
						"--phase-barrier-party",
						`client-${plan.index}`,
						"--phase-barrier-parties",
						String(CLIENT_PROCESSES),
						"--phase-barrier-timeout-ms",
						String(CONNECT_TIMEOUT_SECONDS * 1000),
					]
				: []),
			// Sharded arms only (empty for steady); appended so the realm keeps
			// its registered steady argv and mmo-client takes the later value.
			...realmArmsArgs(ARMS, {
				realmProcesses: CLIENT_PROCESSES,
				index: plan.index,
				barrier: armsBarrier,
			}),
		];
		console.log(
			`g6-sharded-scan: shards=${SHARDS} sessions=${SESSIONS} paced=${PACED} url=https://${SERVER_ADDRESS}:${PORT} started-at=${startedAt}`,
		);
		const bpfPreArm = DIAGNOSTIC ? captureBpfPreArm() : null;
		if (DIAGNOSTIC && !bpfPreArm?.fresh) {
			throw new Error(
				`g6-sharded-scan: refusing diagnostic dispatch without a fresh BPF pre-arm witness: ${JSON.stringify(bpfPreArm)}`,
			);
		}
		const generatorArgsFor = (plan: (typeof clientPlans)[number]): string[] => [
			"env",
			`WT_LINUXGEN_CLONE=${OFFBOX_CLONE}`,
			`WT_MACGEN_CLONE=${OFFBOX_CLONE}`,
			`WTRANSPORT_DATAGRAM_PUMP=${WTRANSPORT_DATAGRAM_PUMP_ENV}`,
			// MMO_CLIENT_QOS (optional): macOS thread QoS class for the
			// generator's threads; the report discloses what was achieved.
			...(process.env.MMO_CLIENT_QOS
				? [`MMO_CLIENT_QOS=${process.env.MMO_CLIENT_QOS}`]
				: []),
			"bash",
			OFFBOX_ENTRY_SCRIPT,
			"--candidate",
			CANDIDATE_SHA,
			"--bin",
			"mmo-client",
			"--deadline",
			String(generatorDeadlineSec),
			// MMO_CLIENT_RSS_LIMIT_MB (optional) — when set on the
			// conductor's env, the linux entry script exports it on
			// the gen before spawning mmo-client. Default (unset)
			// keeps the mmo-client's built-in 12 GB RSS guard.
			...(process.env.MMO_CLIENT_RSS_LIMIT_MB
				? ["--rss-limit", process.env.MMO_CLIENT_RSS_LIMIT_MB]
				: []),
			"--",
			...(DIAGNOSTIC ? ["--diagnostic-host-udp"] : []),
			// Linux binds to 127.0.0.x succeed (unlike macOS), which
			// pins the source to loopback and breaks sendmsg to the
			// VPC (EINVAL on sendmsg from loopback to non-loopback).
			// The parent's macOS runs never hit this because macOS's
			// bind to 127.0.0.x fails and falls back to the default
			// bind. We pass --bind-default unconditionally; mmo-client
			// accepts it on both OSes, and after `--` the linux entry
			// script's case-statement is out of the way.
			...(FIXED_SOURCE_PORT_BASE === null ? ["--bind-default"] : []),
			"--url",
			`https://${SERVER_ADDRESS}:${PORT}`,
			...clientArgsFor(plan),
		];
		const spawnClient = (
			plan: (typeof clientPlans)[number],
		): ReturnType<typeof spawn> => {
			const generatorArgs = generatorArgsFor(plan);
			return spawn(
				"ssh",
				[
					...OFFBOX_SSH_OPTIONS,
					OFFBOX_SSH,
					...workGeneratorSshArguments(GENERATOR_WORK_OWNER, generatorArgs),
				],
				{ stdio: ["ignore", "pipe", "pipe"] },
			);
		};
		const clientStdout: string[] = [];

		// === SHARDED ARMS (plan 2026-10-06-g6-sharded-arms r6) ===
		// Inert for the steady arm: no sever marker is ever printed there, and
		// no raid or pre-check process is launched.
		const armsEntryArgv = (bin: string, args: readonly string[]): string[] => [
			"env",
			`WT_LINUXGEN_CLONE=${OFFBOX_CLONE}`,
			`WT_MACGEN_CLONE=${OFFBOX_CLONE}`,
			`WTRANSPORT_DATAGRAM_PUMP=${WTRANSPORT_DATAGRAM_PUMP_ENV}`,
			...(process.env.MMO_CLIENT_QOS
				? [`MMO_CLIENT_QOS=${process.env.MMO_CLIENT_QOS}`]
				: []),
			"bash",
			OFFBOX_ENTRY_SCRIPT,
			"--candidate",
			CANDIDATE_SHA,
			"--bin",
			bin,
			"--deadline",
			String(generatorDeadlineSec),
			...(process.env.MMO_CLIENT_RSS_LIMIT_MB
				? ["--rss-limit", process.env.MMO_CLIENT_RSS_LIMIT_MB]
				: []),
			"--",
			...args,
		];
		const raidRoles =
			ARMS.arm === "hotspot"
				? (["publisher", "raid-subscriber"] as const)
				: ([] as const);
		const raidArgvs = raidRoles.map((role) =>
			armsEntryArgv("mmo-client", [
				...(FIXED_SOURCE_PORT_BASE === null ? ["--bind-default"] : []),
				"--url",
				`https://${SERVER_ADDRESS}:${PORT}`,
				...raidProcessArgs(ARMS, role, {
					realmProcesses: CLIENT_PROCESSES,
					barrier: armsBarrier,
					drainMs: DRAIN_GRACE_MS,
					idleSeconds: IDLE_SECONDS,
					payloadBytes: UPSTREAM_PAYLOAD_BYTES,
					preregistrationSha256: PREREG_SHA,
					startedAt,
					connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
					fixedSourcePortBase: raidSourcePortBase(
						FIXED_SOURCE_PORT_BASE,
						ENDPOINTS,
						role,
					),
				}),
			]),
		);
		const precheck = precheckPlan(ARMS, {
			id: clientPhaseBarrierId,
			barrierDir: CLIENT_PHASE_BARRIER_DIR,
			preregistrationSha256: PREREG_SHA,
			startedAt,
			moveIntervalMs: Math.round(1000 / MOVE_HZ),
			actionEvery: actionEveryNthTick(),
			payloadBytes: UPSTREAM_PAYLOAD_BYTES,
			drainMs: DRAIN_GRACE_MS,
		});
		type SteerSnapshot = {
			tsMs: number;
			steerStatsSum: { steered: number; fallback: number } | null;
			steerStatsRaw: string | null;
			slotPackets: SlotPacketSample;
		};
		// V-W: steer_stats bracket the storm window, taken immediately before
		// the broadcast that opens / closes it (as the steady brackets are).
		const captureSteer = (): SteerSnapshot => {
			const raw = dumpBpfMap(`${PIN_DIR}/steer_stats`);
			return {
				tsMs: Date.now(),
				steerStatsSum: raw === null ? null : sumPerCpuSteerStats(raw),
				steerStatsRaw: raw,
				slotPackets: captureSlotPackets(),
			};
		};
		const armsRun: {
			severAtMs: number | null;
			stormStartAtMs: number | null;
			stormEndAtMs: number | null;
			steerStart: SteerSnapshot | null;
			steerEnd: SteerSnapshot | null;
			clientMarkers: Record<string, number>;
			stormEnd: Promise<void> | null;
		} = {
			severAtMs: null,
			stormStartAtMs: null,
			stormEndAtMs: null,
			steerStart: null,
			steerEnd: null,
			clientMarkers: {},
			stormEnd: null,
		};
		const broadcastStormBoundary = async (
			phase: "storm" | "post-storm",
		): Promise<void> => {
			const snaps = await broadcast("phase", phase);
			for (const [index, snap] of snaps.entries()) {
				const shard = shards[index] as Shard;
				if (phase === "storm") shard.marks.stormStart = snap;
				else shard.marks.stormEnd = snap;
			}
		};
		// The server-clock sever instant is this host's clock when process 0's
		// sever marker arrives; every shard gets it, and the storm window is
		// anchored at it: [sever + 1,000 ms, + the registered window].
		const armsSever = async (): Promise<void> => {
			if (ARMS.arm !== "storm" || armsRun.severAtMs !== null)
				throw Error("g6-sharded-scan: unexpected sever marker");
			const severAtMs = Date.now();
			armsRun.severAtMs = severAtMs;
			const snaps = await broadcast("phase", "sever", { severAtMs });
			for (const [index, snap] of snaps.entries()) {
				// The steadyDrain window ends at the sever, as in bench-g6.
				(shards[index] as Shard).marks.drainEnd = snap;
			}
			const at = (offsetMs: number) =>
				Bun.sleep(Math.max(0, severAtMs + offsetMs - Date.now()));
			const stormEnd = (async () => {
				await at(ARMS.stormReconnectDelayMs);
				armsRun.steerStart = captureSteer();
				armsRun.stormStartAtMs = Date.now();
				await broadcastStormBoundary("storm");
				await at(ARMS.stormReconnectDelayMs + ARMS.stormWindowSeconds * 1000);
				armsRun.steerEnd = captureSteer();
				armsRun.stormEndAtMs = Date.now();
				await broadcastStormBoundary("post-storm");
			})();
			stormEnd.catch(() => {});
			armsRun.stormEnd = stormEnd;
		};

		const applyMarks = async (kind: string): Promise<void> => {
			if (kind === "steady") {
				if (DIAGNOSTIC) captureServerHostUdp("steady");
				if (linuxProbe !== null) await setLinuxProbePhase(linuxProbe, "steady");
				// Before the broadcast: this is the lower bound of the rated
				// steady window, and the broadcast is what sets marks.steadyStart.
				if (DIAGNOSTIC) slotPacketsSteadyStart = captureSlotPackets();
				const snaps = await broadcast("phase", "steady");
				if (DIAGNOSTIC) captureInterfaceMarks("steady");
				for (const [index, snap] of snaps.entries()) {
					const shard = shards[index] as Shard;
					shard.marks.steadyStart = snap;
					shard.sessionsAtSteady =
						typeof (snap.metrics as Record<string, unknown>).sessionsActive ===
						"number"
							? ((snap.metrics as Record<string, unknown>)
									.sessionsActive as number)
							: null;
					const kinds = (snap.metrics as Record<string, unknown>)
						.g6SessionKinds as Record<string, unknown> | undefined;
					shard.sessionsByKindAtSteady =
						kinds &&
						typeof kinds.player === "number" &&
						typeof kinds.raid === "number" &&
						typeof kinds.publisher === "number"
							? {
									player: kinds.player,
									raid: kinds.raid,
									publisher: kinds.publisher,
								}
							: null;
				}
				console.log(
					`g6-sharded-scan: steady begins; sessions per shard = [${shards
						.map((s) => s.sessionsAtSteady ?? "?")
						.join(", ")}]`,
				);
				// The steady marker closes the connect interval and captures T2.
				currentRung?.end();
			} else if (kind === "drain") {
				if (DIAGNOSTIC) captureServerHostUdp("drain");
				if (linuxProbe !== null) await setLinuxProbePhase(linuxProbe, "drain");
				// Before the broadcast: this is the upper bound of the rated
				// steady window, and the broadcast is what sets marks.drainStart.
				// Taking it here rather than reusing the post-run dump keeps the
				// drain and idle tails out of the steady comparison.
				if (DIAGNOSTIC) slotPacketsSteadyEnd = captureSlotPackets();
				const snaps = await broadcast("phase", "drain");
				if (DIAGNOSTIC) captureInterfaceMarks("drain");
				for (const [index, snap] of snaps.entries()) {
					(shards[index] as Shard).marks.drainStart = snap;
				}
			} else if (kind === "sever") {
				await armsSever();
			} else if (kind === "storm" || kind === "post-storm") {
				// The client's own storm flips: recorded, never broadcast — the
				// shard boundaries follow the server-clock timers armed at sever.
				armsRun.clientMarkers[kind] = Date.now();
			} else if (kind === "idle") {
				if (armsRun.stormEnd !== null) await armsRun.stormEnd;
				if (DIAGNOSTIC) captureServerHostUdp("idle");
				if (linuxProbe !== null) await setLinuxProbePhase(linuxProbe, "idle");
				const snaps = await broadcast("phase", "idle");
				if (DIAGNOSTIC) captureInterfaceMarks("idle");
				for (const [index, snap] of snaps.entries()) {
					const shard = shards[index] as Shard;
					shard.marks.drainEnd ??= snap;
					shard.marks.idleStart = snap;
				}
			} else if (kind === "stop") {
				capturePostRunSteering();
				// The probe's final sample needs the live shard /proc entries.
				if (linuxProbe !== null) await stopLinuxProbe(linuxProbe);
				for (const shard of shards) shard.expectedStop = true;
				const snaps = await broadcast("stop", null);
				for (const [index, snap] of snaps.entries()) {
					(shards[index] as Shard).marks.stop = snap;
				}
				await Promise.race([
					Promise.all(shards.map((shard) => waitForChildClose(shard.child))),
					Bun.sleep(12_000).then(() => {
						throw Error(
							"g6-sharded-scan: shard finalization deadline exceeded",
						);
					}),
				]);
				for (const shard of shards) {
					if (
						shard.child.exitCode !== 0 ||
						shard.child.signalCode !== null ||
						shard.sendPathClosed === null
					)
						throw Error(
							`g6-sharded-scan: shard ${shard.serverId} lacks clean terminal evidence`,
						);
				}
			}
		};

		let markerChain = Promise.resolve();
		// Every process's stdout is kept; only process 0's phase markers drive
		// the shard boundaries, since the barrier makes the processes enter
		// steady together and they share one steady length.
		const perClientStdout: string[][] = clientPlans.map(() => []);
		const clientDones: Promise<number>[] = [];
		const clientOutputDones: Promise<void>[] = [];
		// Spawned one at a time: every entry script fetches, checks out and
		// builds in the same generator clone, and two of them racing on it
		// made one report the candidate "not reachable". The next process
		// starts only after the previous one prints its built binary (or
		// exits); the barrier timeout is the connect timeout, which covers a
		// serialised build.
		// Owned work cells run N generator processes inside ONE owned process
		// group: a fan-out wrapper starts them in order and tags their output,
		// which is split back into per-process streams here.
		// Arms cells always fan out: the generator-loopback pre-checks (V-F,
		// V-S) and the raid processes run inside the same one group, tagged
		// after the realm processes.
		const armsMainArgvs = [...clientPlans.map(generatorArgsFor), ...raidArgvs];
		const fanoutScript =
			precheck === null
				? ownedFanoutScript(clientPlans.map(generatorArgsFor))
				: armsFanoutScript({
						main: armsMainArgvs,
						precheck: {
							...precheck,
							forwarder: armsEntryArgv("g6-server", precheck.forwarder),
							floor: armsEntryArgv("mmo-client", precheck.floor),
							sink:
								precheck.sink === null
									? null
									: {
											subscriber: armsEntryArgv(
												"mmo-client",
												precheck.sink.subscriber,
											),
											publisher: armsEntryArgv(
												"mmo-client",
												precheck.sink.publisher,
											),
										},
						},
					});
		const fanoutCount =
			precheck === null ? clientPlans.length : armsMainArgvs.length + 4;
		const fanoutClients =
			(GENERATOR_WORK_OWNER !== null && CLIENT_PROCESSES > 1) ||
			precheck !== null
				? (() => {
						const fanout = spawn(
							"ssh",
							[
								...OFFBOX_SSH_OPTIONS,
								OFFBOX_SSH,
								...(GENERATOR_WORK_OWNER === null
									? [`bash -c ${shellQuote(fanoutScript)}`]
									: workGeneratorSshArguments(GENERATOR_WORK_OWNER, [
											"bash",
											"-c",
											fanoutScript,
										])),
							],
							{ stdio: ["ignore", "pipe", "pipe"] },
						);
						trackChildClose(fanout);
						clients.push(fanout);
						return demultiplexFanout(fanout, fanoutCount, (line) =>
							console.error(`[generator fan-out] ${line}`),
						);
					})()
				: null;
		// Arms side processes: raid publisher / subscriber, then the
		// pre-checks, in the fan-out's tag order.
		const armsLabels =
			precheck === null
				? []
				: [
						...raidRoles,
						"forwarder",
						"floor",
						...(precheck.sink === null
							? []
							: ["sink-subscriber", "sink-publisher"]),
					];
		const armsOutput: Record<string, { stdout: string[]; stderr: string[] }> =
			{};
		const armsOutputDones: Promise<void>[] = [];
		for (const [offset, label] of armsLabels.entries()) {
			const client = fanoutClients?.[CLIENT_PROCESSES + offset];
			if (client === undefined) throw Error(`missing arms process ${label}`);
			const output = { stdout: [] as string[], stderr: [] as string[] };
			armsOutput[label] = output;
			const lines = createInterface({ input: client.stdout });
			armsOutputDones.push(
				new Promise<void>((resolve) => lines.once("close", resolve)),
			);
			lines.on("line", (line) => output.stdout.push(line));
			createInterface({ input: client.stderr }).on("line", (line) => {
				if (output.stderr.length < SHARD_STDERR_TAIL_LINES)
					output.stderr.push(line);
				console.error(`[${label} stderr] ${line}`);
			});
		}
		for (const plan of clientPlans) {
			const child =
				fanoutClients === null
					? spawnClient(plan)
					: (fanoutClients[plan.index] as unknown as ReturnType<typeof spawn>);
			if (fanoutClients === null) {
				trackChildClose(child);
				clients.push(child);
			}
			const index = plan.index;
			clientDones.push(
				new Promise<number>((res) => {
					child.on("exit", (code, signal) => res(code ?? (signal ? 128 : -1)));
				}),
			);
			const output = createInterface({ input: child.stdout! });
			let built: () => void = () => {};
			const builtOrExited = new Promise<void>((resolve) => {
				built = resolve;
				child.once("exit", () => resolve());
			});
			clientOutputDones.push(
				new Promise<void>((resolve) => {
					output.once("close", resolve);
				}),
			);
			output.on("line", (line) => {
				(perClientStdout[index] as string[]).push(line);
				if (line.startsWith("macgen: binary=")) built();
				if (index === 0) {
					const marker = readPhaseMarker(line);
					if (marker) {
						markerChain = markerChain.then(() => applyMarks(marker.kind));
					}
				}
			});
			createInterface({ input: child.stderr! }).on("line", (line) => {
				console.error(`[client ${index} stderr] ${line}`);
			});
			await builtOrExited;
		}

		const clientExit = Math.max(...(await Promise.all(clientDones)));
		await Promise.all(clientOutputDones);
		await Promise.all(armsOutputDones);
		await markerChain;
		if (CLIENT_PROCESSES === 1) {
			clientStdout.push(...(perClientStdout[0] as string[]));
		} else {
			// The per-process report lines are re-tagged so the merged line is
			// the only "mmo-client: json" line the graders and the connect-error
			// parser can find.
			const reportMarker = "mmo-client: json ";
			const clientReports: unknown[] = [];
			const retagged: string[] = [];
			for (const [index, lines] of perClientStdout.entries()) {
				for (const line of lines) {
					const at = line.indexOf(reportMarker);
					if (at >= 0) {
						clientReports.push(
							JSON.parse(line.slice(at + reportMarker.length)),
						);
						retagged.push(
							`mmo-client[${index}]: json ${line.slice(at + reportMarker.length)}`,
						);
					} else {
						retagged.push(index === 0 ? line : `[client ${index}] ${line}`);
					}
				}
			}
			if (clientReports.length !== CLIENT_PROCESSES) {
				throw new Error(
					`g6-sharded-scan: ${clientReports.length} of ${CLIENT_PROCESSES} client processes reported`,
				);
			}
			// The merged line goes FIRST: the graders take the first line that
			// carries the report schema (the re-tagged per-process lines still
			// do), while the connect-error parser takes the last line with the
			// "mmo-client: json " marker, which only the merged line carries.
			clientStdout.push(
				`${reportMarker}${JSON.stringify(mergeClientReports(clientReports))}`,
				...retagged,
			);
		}
		currentRung?.setConnectErrorsSample(parseConnectErrorsSample(clientStdout));
		if (DIAGNOSTIC && postRunSteering === null) {
			throw new Error("g6-sharded-scan: missing post-run steering capture");
		}
		if (clientExit !== 0) {
			throw new Error(`g6-sharded-scan: generator exited ${clientExit}`);
		}
		console.log(`g6-sharded-scan: client exited ${clientExit}`);
		// The generator shares the wtransport driver: its own report must show it
		// ran the configured datagram path, or the arm is mislabeled.
		for (const report of clientReportsForDriverCheck(clientStdout))
			assertGeneratorDatagramDriver(report, DATAGRAM_PUMP);

		/**
		 * Read `steady.quic` only. quinn's counters are per connection and live
		 * with it, so a window that loses sessions (steadyDrain, lifetime) has
		 * deltas that undercount by whatever the departed connections carried
		 * and are not interpretable. `quic.sessions` is carried so that
		 * condition is visible in the artifact rather than assumed.
		 */
		const sumWindows = ({
			windows,
			entries,
		}: {
			windows: BoundarySnapshot[];
			entries: ShardWindowMetrics[];
		}): Record<string, unknown> => {
			const metricNames = [
				"datagramPumpsSpawned",
				"udpSendBatchErrors",
				"udpSendBatchCongestionDropped",
				"datagramReflectRingBypassMarked",
				"datagramReflectRingBypassRefreshed",
				"datagramReflectRingBypassRefused",
				"datagramReflectRingBypassExpired",
				"datagramReflectRingBypassed",
				"datagramReflectRingDirectBlocked",
				"datagramReflectRingDirectErrors",
				"datagramReflectRingGsoFallback",
			] as const;
			const metrics: Record<(typeof metricNames)[number], number | null> =
				Object.fromEntries(metricNames.map((name) => [name, 0])) as Record<
					(typeof metricNames)[number],
					number | null
				>;
			const total = {
				rxTotal: 0,
				cpuMs: 0,
				wallMsMax: 0,
				rxByClass: { snapshot: 0, ack: 0, raid: 0, raidJoin: 0, unstamped: 0 },
				emitter: {
					snapshotDue: 0,
					snapshotIssued: 0,
					ackDue: 0,
					ackIssued: 0,
					raidForwarded: 0,
					sendErrors: 0,
					sendEventsSkipped: 0,
					batchPartialCompletions: 0,
				},
				// quinn's own view of the same window. The three-count
				// discrimination: `udpDatagramsReceived` is what the UDP socket
				// handed quinn, `datagramFramesReceived` is what quinn decoded out
				// of it, and `rxTotal` above is what the application counted. A gap
				// between the first two is transport-internal loss; a gap between
				// the second and `rxTotal` is app-side. `null` when any shard did
				// not report the fields — see sumWindowQuic.
				...sumWindowQuic(entries),
			};
			for (const w of windows) {
				total.rxTotal += w.rxTotal;
				total.cpuMs += w.cpuMs;
				total.wallMsMax = Math.max(total.wallMsMax, w.wallMs);
				for (const k of Object.keys(total.rxByClass) as Array<
					keyof typeof total.rxByClass
				>) {
					total.rxByClass[k] += w.rxByClass[k];
				}
				for (const k of Object.keys(total.emitter) as Array<
					keyof typeof total.emitter
				>) {
					total.emitter[k] += w.emitter[k];
				}
				for (const name of metricNames) {
					const value = w.metrics[name];
					const current = metrics[name];
					if (
						typeof value !== "number" ||
						!Number.isSafeInteger(value) ||
						value < 0 ||
						current === null ||
						!Number.isSafeInteger(current + value)
					) {
						metrics[name] = null;
					} else {
						metrics[name] = current + value;
					}
				}
			}
			return {
				...total,
				metrics,
			};
		};

		const pacerRefusals = pacerPriorityRefusals(
			shards,
			process.env.WEBTRANSPORT_PACER_NICE,
			process.env.WEBTRANSPORT_PACER_SCHED,
		);
		const shardResults = shards.map((shard) => {
			const m = shard.marks;
			const complete =
				m.start && m.steadyStart && m.drainStart && m.drainEnd && m.idleStart;
			return {
				serverId: shard.serverId,
				emitterMode: shard.emitterMode,
				pacerStats: shard.pacerStats,
				pacerPriority: pacerPriorityOf(shard.pacerStats),
				sessionsAtSteady: shard.sessionsAtSteady,
				sessionsByKindAtSteady: shard.sessionsByKindAtSteady,
				windows: complete ? deriveBoundaryWindows(m as BoundaryMarks) : null,
				marksSeen: Object.keys(m),
			};
		});
		const pickWindows = (
			name: "steady" | "steadyDrain" | "lifetime" | "storm",
		): { windows: BoundarySnapshot[]; entries: ShardWindowMetrics[] } => {
			const windows: BoundarySnapshot[] = [];
			const entries: ShardWindowMetrics[] = [];
			for (const shard of shardResults) {
				const window = shard.windows?.[name];
				if (window == null) continue;
				windows.push(window);
				entries.push({ serverId: shard.serverId, metrics: window.metrics });
			}
			return { windows, entries };
		};
		const steadyWindows = pickWindows("steady");
		const steadyDrainWindows = pickWindows("steadyDrain");
		const lifetimeWindows = pickWindows("lifetime");

		// === INERT BPF PER-SLOT PACKET CONVENIENCE (g6-sharded-diagnostic-01) ===
		// Nothing in the evaluator or grader reads these fields. They exist so a
		// reader can put the packets the steering program dispatched to a shard
		// next to that shard's own `quicUdpDatagramsReceived` for the same
		// window, without re-deriving anything from the raw dumps.
		//
		// Windows, stated because none of them is the obvious one:
		//   steady    the dedicated dumps taken immediately before the `phase
		//             steady` and `phase drain` broadcasts — the same two
		//             instants that bracket quinn's rated steady window, minus
		//             one broadcast round-trip at each end.
		//   lifetime  arm-time zero -> the post-run dump in the "stop" branch,
		//             i.e. the post-run totals themselves. This one DOES include
		//             the drain and idle tails, which is what lifetime means.
		//   steadyDrain has no BPF sample boundary of its own and stays null
		//             rather than being guessed at.
		// T0/T1/T2 are CONNECT-phase boundaries (T2 = the generator leaving
		// connect) and are deliberately not used for any of these.
		const lastRung = rungDiagnostics.at(-1) ?? null;
		const slotToServerId = lastRung?.T2?.slotMapDump
			? parseSlotByServerId(lastRung.T2.slotMapDump)
			: null;
		const finalSlotPackets =
			(
				postRunSteering as {
					slotPackets?: Record<number, SlotPacketCounts> | null;
				} | null
			)?.slotPackets ?? null;
		const steadyStartSample = slotPacketsSteadyStart as SlotPacketSample | null;
		const steadyEndSample = slotPacketsSteadyEnd as SlotPacketSample | null;
		const bpfSlotPackets = {
			steady:
				steadyStartSample === null || steadyEndSample === null
					? null
					: diffSlotPackets(
							steadyStartSample.sums,
							steadyEndSample.sums,
							slotToServerId,
						),
			steadyDrain: null,
			lifetime: diffSlotPackets(null, finalSlotPackets, slotToServerId),
			keyedBy: slotToServerId === null ? "slot" : "serverId",
			steadyBounds: {
				startTsMs: steadyStartSample?.tsMs ?? null,
				endTsMs: steadyEndSample?.tsMs ?? null,
			},
		};

		// Sharded arms evidence: the merged reports' arms blocks, the raid and
		// pre-check processes' reports, and the facts later graders recompute
		// from these raw fields (per-shard counts client vs server, raid
		// placement, skews, V-R, the storm window's steering and admission).
		function buildArmsResult(): Record<string, unknown> {
			const marker = "mmo-client: json ";
			const reportOf = (lines: readonly string[] | undefined) => {
				for (const line of lines ?? []) {
					const at = line.indexOf(marker);
					if (at < 0) continue;
					try {
						return JSON.parse(line.slice(at + marker.length)) as Record<
							string,
							unknown
						>;
					} catch {
						return null;
					}
				}
				return null;
			};
			const rcOf = (label: string): number | null => {
				const line = armsOutput[label]?.stdout.find((l) =>
					l.startsWith("precheck: rc="),
				);
				return line === undefined ? null : Number(line.slice(13));
			};
			const obj = (v: unknown): Record<string, unknown> =>
				v !== null && typeof v === "object" && !Array.isArray(v)
					? (v as Record<string, unknown>)
					: {};
			const realmReports = perClientStdout.map((lines) => reportOf(lines));
			const realmMerged = realmReports.every((r) => r !== null)
				? mergeClientReports(realmReports)
				: null;
			const realmArms = obj(realmMerged?.arms);
			const publisher = reportOf(armsOutput.publisher?.stdout);
			const subscriber = reportOf(armsOutput["raid-subscriber"]?.stdout);
			const byShardAt = (report: unknown, key: string) =>
				(obj(obj(obj(report).arms).sessionsByShard)[key] ??
					null) as ShardCounts | null;
			const serverAt = (
				pick: (shard: Shard) => number | null,
			): ShardCounts | null => {
				const out: ShardCounts = {};
				for (const shard of shards) {
					const value = pick(shard);
					if (value === null) return null;
					out[String(shard.serverId)] = value;
				}
				return out;
			};
			const metricOf = (
				snap: BoundarySnapshot | null | undefined,
				key: string,
			) => {
				const value = (snap?.metrics as Record<string, unknown> | undefined)?.[
					key
				];
				return typeof value === "number" ? value : null;
			};
			const sumOver = (pick: (shard: Shard) => number | null) => {
				let total = 0;
				for (const shard of shards) {
					const value = pick(shard);
					if (value === null) return null;
					total += value;
				}
				return total;
			};
			const raidParts =
				ARMS.arm === "hotspot"
					? [
							byShardAt(publisher, "steadyEntry"),
							byShardAt(subscriber, "steadyEntry"),
						]
					: [];
			const steadyEntry = compareShardCounts(
				sumShardCounts([
					(obj(realmArms.sessionsByShard).steadyEntry ??
						null) as ShardCounts | null,
					...raidParts,
				]),
				serverAt((shard) => shard.sessionsAtSteady),
				SHARDS,
			);
			const floorReport = reportOf(armsOutput.floor?.stdout);
			const precheckResult = {
				forwarder: {
					rc: rcOf("forwarder"),
					stdout: armsOutput.forwarder?.stdout ?? [],
					stderr: armsOutput.forwarder?.stderr ?? [],
				},
				floor: {
					rc: rcOf("floor"),
					facts: floorFacts(floorReport),
					report: floorReport,
					transcript: armsOutput.floor?.stdout ?? [],
				},
				sink:
					ARMS.arm === "hotspot"
						? (() => {
								const sub = reportOf(armsOutput["sink-subscriber"]?.stdout);
								const pub = reportOf(armsOutput["sink-publisher"]?.stdout);
								return {
									rc: {
										subscriber: rcOf("sink-subscriber"),
										publisher: rcOf("sink-publisher"),
									},
									facts: sinkFacts(sub, pub),
									subscriberReport: sub,
									publisherReport: pub,
								};
							})()
						: null,
			};
			const raid =
				ARMS.arm === "hotspot"
					? {
							publisher,
							subscriber,
							publisherStdout: armsOutput.publisher?.stdout ?? [],
							subscriberStdout: armsOutput["raid-subscriber"]?.stdout ?? [],
							membershipEchoAt: "drain",
							membership: shards.map((shard) => {
								const echo = obj(shard.armsEchoes.drain);
								const tokens = obj(echo.raidMembers).tokens;
								const kinds = obj(echo.sessionKinds);
								return {
									serverId: shard.serverId,
									raidTokens: Array.isArray(tokens) ? (tokens as number[]) : [],
									publisherSessions:
										typeof kinds.publisher === "number" ? kinds.publisher : 0,
								};
							}),
							placement: raidPlacementFacts(
								ARMS,
								shards.map((shard) => {
									const echo = obj(shard.armsEchoes.drain);
									const tokens = obj(echo.raidMembers).tokens;
									const kinds = obj(echo.sessionKinds);
									return {
										serverId: shard.serverId,
										raidTokens: Array.isArray(tokens)
											? (tokens as number[])
											: [],
										publisherSessions:
											typeof kinds.publisher === "number" ? kinds.publisher : 0,
									};
								}),
							),
							steadyEntrySkewMs: skewMs(
								[...realmReports, publisher, subscriber].map(
									(report) =>
										obj(obj(report).phaseBarrier).steadyEnterUnixMs as
											| number
											| undefined,
								),
							),
						}
					: null;
			const severAt = armsRun.severAtMs;
			const stormEndAt = armsRun.stormEndAtMs;
			const realmStorm = obj(realmArms.storm);
			const storm =
				ARMS.arm === "storm"
					? {
							cohort: ARMS.stormCohort,
							severAtMs: severAt,
							stormStartAtMs: armsRun.stormStartAtMs,
							stormEndAtMs: stormEndAt,
							clientMarkerArrivalMs: armsRun.clientMarkers,
							severSkewMs: realmStorm.severSkewMs ?? null,
							reconnectInitialLateMaxNs: histogramMaxNs(
								realmStorm.reconnectInitialLate,
							),
							reconnectInitials: realmStorm.reconnectInitials ?? null,
							processes: realmStorm.processes ?? null,
							steering: {
								start:
									armsRun.steerStart === null
										? null
										: {
												tsMs: armsRun.steerStart.tsMs,
												steerStatsSum: armsRun.steerStart.steerStatsSum,
												steerStatsRaw: armsRun.steerStart.steerStatsRaw,
												slotPackets: armsRun.steerStart.slotPackets.sums,
											},
								end:
									armsRun.steerEnd === null
										? null
										: {
												tsMs: armsRun.steerEnd.tsMs,
												steerStatsSum: armsRun.steerEnd.steerStatsSum,
												steerStatsRaw: armsRun.steerEnd.steerStatsRaw,
												slotPackets: armsRun.steerEnd.slotPackets.sums,
											},
								delta: steeringDelta(
									armsRun.steerStart?.steerStatsSum ?? null,
									armsRun.steerEnd?.steerStatsSum ?? null,
								),
								perSlotDelta: diffSlotPackets(
									armsRun.steerStart?.slotPackets.sums ?? null,
									armsRun.steerEnd?.slotPackets.sums ?? null,
									null,
								),
								perSlotKeyedBy: "slot",
							},
							server: {
								// Accepts after the server-clock sever, up to the storm
								// window's close: S-C2's re-accept count.
								reAcceptedThroughWindowClose:
									severAt === null || stormEndAt === null
										? null
										: sumOver((shard) => {
												const accepts = obj(
													shard.armsEchoes.stop,
												).acceptMsAfterSever;
												return Array.isArray(accepts)
													? (accepts as number[]).filter(
															(t) => t > severAt && t <= stormEndAt,
														).length
													: null;
											}),
								sessionsActiveAtWindowClose: sumOver((shard) =>
									metricOf(shard.marks.stormEnd, "sessionsActive"),
								),
								limitExceededDelta: sumOver((shard) => {
									const a = metricOf(
										shard.marks.stormStart,
										"limitExceededCount",
									);
									const b = metricOf(
										shard.marks.stormEnd,
										"limitExceededCount",
									);
									return a === null || b === null ? null : b - a;
								}),
								rateLimitedDelta: sumOver((shard) => {
									const a = metricOf(
										shard.marks.stormStart,
										"rateLimitedCount",
									);
									const b = metricOf(shard.marks.stormEnd, "rateLimitedCount");
									return a === null || b === null ? null : b - a;
								}),
								handshakesInFlightAtClose: sumOver((shard) =>
									metricOf(shard.marks.stormEnd, "handshakesInFlight"),
								),
								perShard: shards.map((shard) => {
									const echo = obj(shard.armsEchoes.stop);
									return {
										serverId: shard.serverId,
										severAtMs: echo.severAtMs ?? null,
										acceptsAfterSever: echo.acceptsAfterSever ?? null,
										acceptMsAfterSever: echo.acceptMsAfterSever ?? null,
										acceptSeriesPerSecond: echo.acceptSeriesPerSecond ?? null,
										stormSamples: echo.stormSamples ?? null,
									};
								}),
							},
							// V-P re-run at storm end: reconnects placed by their own
							// opening DCIDs vs the shards' own session counts.
							sessionsByShardAtStormEnd: compareShardCounts(
								(obj(realmArms.sessionsByShard).stormEnd ??
									null) as ShardCounts | null,
								serverAt((shard) =>
									metricOf(shard.marks.stormEnd, "sessionsActive"),
								),
								SHARDS,
							),
						}
					: null;
			return {
				schema: "g6-sharded-arms-scan/1",
				config: { ...ARMS, registered: ARMS_REGISTERED },
				barrierParties: armsBarrierParties(ARMS, CLIENT_PROCESSES),
				realm: realmMerged === null ? null : { arms: realmMerged.arms ?? null },
				sessionsByShardAtSteady: steadyEntry,
				precheck: precheckResult,
				raid,
				storm,
				shardEchoes: shards.map((shard) => ({
					serverId: shard.serverId,
					echoes: Object.fromEntries(
						Object.entries(shard.armsEchoes).map(([phase, echo]) => {
							// Raw per-accept instants stay in storm.server.perShard.
							const { acceptMsAfterSever: _drop, ...rest } = obj(echo);
							return [phase, rest];
						}),
					),
				})),
			};
		}

		const result = {
			schema: "g6-sharded-scan/3",
			startedAt,
			candidateSha: CANDIDATE_SHA,
			config: {
				shards: SHARDS,
				sessions: SESSIONS,
				activeWorkloadSessions: WORKLOAD_ACTIVE_SESSIONS,
				paced: PACED,
				emitterMode: G6_EMITTER_MODE,
				ackReflector: ACK_REFLECTOR,
				serverWorkers: SERVER_WORKERS,
				serverGro: SERVER_GRO,
				serverRecvRuntime: SERVER_RECV_RUNTIME,
				ackCadence: SERVER_ACK_CADENCE,
				serverUdpSendBufferBytes: SERVER_UDP_SNDBUF_BYTES,
				udpSendBatch: UDP_SEND_BATCH,
				serverUdpSendEagainMode: SERVER_UDP_SEND_EAGAIN_MODE,
				reflectRingBypass: REFLECT_RING_BYPASS,
				datagramPump: DATAGRAM_PUMP,
				pacerPps: process.env.WEBTRANSPORT_PACER_PPS ?? null,
				port: PORT,
				pinDir: PIN_DIR,
				endpoints: ENDPOINTS,
				clientProcesses: CLIENT_PROCESSES,
				clientQos: process.env.MMO_CLIENT_QOS ?? null,
				steadySeconds: STEADY_SECONDS,
				connectTimeoutSeconds: CONNECT_TIMEOUT_SECONDS,
				connectConcurrency: CONNECT_CONCURRENCY,
				connectRatePerSec: CONNECT_RATE_PER_SEC,
				fixedSourcePortBase: FIXED_SOURCE_PORT_BASE,
			},
			clientExit,
			pacerPriorityRefusals: pacerRefusals,
			shards: shardResults,
			aggregate: {
				steady: sumWindows(steadyWindows),
				steadyDrain: sumWindows(steadyDrainWindows),
				lifetime: sumWindows(lifetimeWindows),
				bpfSlotPackets,
				...(ARMS.arm === "storm"
					? { storm: sumWindows(pickWindows("storm")) }
					: {}),
			},
			kernelMarks,
			clientStdout: clientStdout.join("\n"),
			...(precheck === null ? {} : { arms: buildArmsResult() }),
		};
		await Promise.all(
			shards.map((shard) => shard.boundaries.finalize([], () => {})),
		);
		writeFileSync(OUT, JSON.stringify(result, null, 1));
		console.log(`g6-sharded-scan: wrote ${OUT}`);

		// === DIAGNOSTIC EMISSION (g6-sharded-diagnostic-01) ===
		// Emitted as a separate artifact. The rated g6-sharded-scan.json above is
		// unchanged. The diagnostic JSON is read by the off-runner discrimination
		// step to assign D1/D2/D3 hypotheses.
		if (DIAGNOSTIC) {
			const diagnosticResult = {
				schema: "g6-sharded-diagnostic/3",
				startedAt,
				candidateSha: CANDIDATE_SHA,
				dispatch: {
					shards: SHARDS,
					sessions: SESSIONS,
					activeWorkloadSessions: WORKLOAD_ACTIVE_SESSIONS,
					paced: PACED,
					emitterMode: G6_EMITTER_MODE,
					ackReflector: ACK_REFLECTOR,
					serverWorkers: SERVER_WORKERS,
					serverGro: SERVER_GRO,
					serverRecvRuntime: SERVER_RECV_RUNTIME,
					ackCadence: SERVER_ACK_CADENCE,
					serverUdpSendBufferBytes: SERVER_UDP_SNDBUF_BYTES,
					udpSendBatch: UDP_SEND_BATCH,
					serverUdpSendEagainMode: SERVER_UDP_SEND_EAGAIN_MODE,
					reflectRingBypass: REFLECT_RING_BYPASS,
					datagramPump: DATAGRAM_PUMP,
					endpoints: ENDPOINTS,
					connectConcurrency: CONNECT_CONCURRENCY,
					connectRatePerSec: CONNECT_RATE_PER_SEC,
					fixedSourcePortBase: FIXED_SOURCE_PORT_BASE,
					pinDir: PIN_DIR,
				},
				ladder: rungDiagnostics,
				serverHostUdp: serverHostUdpSamples,
				serverInterface: await settleSamples(serverInterfaceSamples),
				generatorInterface: await settleSamples(generatorInterfaceSamples),
				bpfPreArm,
				postRunSteering,
				linuxProbe: {
					enabled: LINUX_PROBE_ENABLED,
					out: LINUX_PROBE_ENABLED ? LINUX_PROBE_OUT : null,
					maxBytes: LINUX_PROBE_ENABLED ? LINUX_PROBE_MAX_BYTES : null,
					measurementMode: LINUX_PROBE_ENABLED
						? { detail: "on", phaseAware: true }
						: { detail: "off", phaseAware: true },
					producerSha256: LINUX_PROBE_ENABLED
						? LINUX_PROBE_PRODUCER_SHA256
						: null,
					stoppedCleanly: linuxProbe?.stopped ?? false,
				},
				sendPathDiagnostics: {
					enabled: NATIVE_SEND_PATH_ENABLED,
					measurementMode: NATIVE_SEND_PATH_ENABLED ? "on" : "off",
					producerSha256: NATIVE_SEND_PATH_PRODUCER_SHA256,
					shards: shards.map((s) => ({
						serverId: s.serverId,
						pid: s.child.pid,
						boundaries: s.sendPathBoundaries,
						final: s.sendPathClosed,
					})),
				},
				perShardLifecycle: shards.map((s) => ({
					serverId: s.serverId,
					pid: s.child.pid,
					boundaries: s.boundaryArrivedAt,
					exits: s.lifecycle,
					stderr: s.stderrTail,
				})),
			};
			writeFileSync(DIAGNOSTIC_OUT, JSON.stringify(diagnosticResult, null, 1));
			console.log(`g6-sharded-scan: wrote ${DIAGNOSTIC_OUT}`);
		}

		process.exitCode = clientExit === 0 ? 0 : 1;
		if (clientExit === 0 && pacerRefusals.length > 0) {
			for (const reason of pacerRefusals) {
				console.error(`g6-sharded-scan: pacer priority refused: ${reason}`);
			}
			process.exitCode = PACER_PRIORITY_REFUSED_EXIT;
		}
	} finally {
		stopCurrentRung?.();
		if (linuxProbe !== null && !linuxProbe.stopped) {
			try {
				await stopLinuxProbe(linuxProbe);
			} catch (error) {
				console.error(`g6-sharded-scan: ${String(error)}`);
			}
		}
		const childCloses = clients.map((child) => waitForChildClose(child));
		const shardCloses = shards.map((shard) => waitForChildClose(shard.child));
		for (const child of clients) {
			if (child.exitCode === null) child.kill("SIGKILL");
		}
		for (const shard of shards) {
			shard.child.kill("SIGKILL");
		}
		await Promise.all([...childCloses, ...shardCloses]);
		if (runtimeDir !== null)
			rmSync(runtimeDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(`g6-sharded-scan: ${String(error)}`);
	process.exit(1);
});
