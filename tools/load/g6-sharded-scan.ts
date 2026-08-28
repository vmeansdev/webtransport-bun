/**
 * Informal G6 sharded scan conductor: N g6-shard-server processes share
 * :4433 via SO_REUSEPORT + the pinned steer_by_cid eBPF program, one off-box
 * mmo-client realm fleet drives the registered steady shape at them, and the
 * conductor aggregates per-shard boundary windows.
 *
 * Producer for gate g6-sharded/1 (and for informal characterization runs).
 * The per-shard emitter and the client contract are the gate's own; what is
 * new here is only the process split and the summation. The registered half
 * is tools/load/g6-sharded-grade.ts, which grades this file's schema.
 *
 * Env: SCAN_SHARDS (2), SCAN_SESSIONS (5000), SCAN_OUT (g6-sharded-scan.json),
 *      SCAN_PIN_DIR (/sys/fs/bpf/quic-lb), G6_OFFBOX_SSH, G6_CANDIDATE_SHA,
 *      G6_PREREGISTRATION_SHA256, G6_SERVER_ADDRESS (10.99.0.2), G6_PORT
 *      (4433), G6_PACED_EMITTER + WEBTRANSPORT_PACER_PPS (per-shard pacing).
 *      SCAN_DIAGNOSTIC (1) — emit a separate g6-sharded-diagnostic.json with
 *      per-shard /proc/<pid>/net/udp + bpftool map dumps + host-load block +
 *      lifecycle capture + mmo-client connectErrorsSample. When unset, the
 *      behavior is byte-identical to g6-sharded/1. When set, the rated
 *      g6-sharded-scan.json is **unchanged** — the diagnostic block is a
 *      separate artifact. Registration: registrations/g6-sharded-diagnostic-01.md.
 */
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	type BoundaryMarks,
	type BoundarySnapshot,
	deriveBoundaryWindows,
	readPhaseMarker,
} from "./g6-artifact.ts";
import {
	MOVE_HZ,
	UPSTREAM_PAYLOAD_BYTES,
	actionEveryNthTick,
} from "./g6-plan.ts";

const SHARDS = parseInt(process.env.SCAN_SHARDS ?? "2", 10);
const SESSIONS = parseInt(process.env.SCAN_SESSIONS ?? "5000", 10);
const OUT = process.env.SCAN_OUT ?? "g6-sharded-scan.json";
const DIAGNOSTIC_OUT = process.env.SCAN_DIAGNOSTIC_OUT ?? "g6-sharded-diagnostic.json";
const DIAGNOSTIC = process.env.SCAN_DIAGNOSTIC === "1";
const PIN_DIR = process.env.SCAN_PIN_DIR ?? "/sys/fs/bpf/quic-lb";
const OFFBOX_SSH = process.env.G6_OFFBOX_SSH ?? "";
const OFFBOX_ENTRY_SCRIPT = process.env.G6_OFFBOX_ENTRY_SCRIPT ?? "tools/offbox/mac-generator-entry-g6.sh";
const CANDIDATE_SHA = process.env.G6_CANDIDATE_SHA ?? "";
const PREREG_SHA = process.env.G6_PREREGISTRATION_SHA256 ?? "";
const SERVER_ADDRESS = process.env.G6_SERVER_ADDRESS ?? "10.99.0.2";
const PORT = parseInt(process.env.G6_PORT ?? "4433", 10);
const PACED = process.env.G6_PACED_EMITTER === "1";
const STEADY_SECONDS = 120;
const IDLE_SECONDS = 30;
const DRAIN_GRACE_MS = 1000;
const CONNECT_TIMEOUT_SECONDS = 300;
const ENDPOINTS = parseInt(process.env.SCAN_ENDPOINTS ?? "64", 10);
const CONNECT_CONCURRENCY = 500;

if (!OFFBOX_SSH || !CANDIDATE_SHA || !PREREG_SHA) {
	throw new Error(
		"g6-sharded-scan: G6_OFFBOX_SSH, G6_CANDIDATE_SHA and G6_PREREGISTRATION_SHA256 are required",
	);
}
// 16 needs the BPF program rebuilt with -DMAX_INSTANCES=16 (the pinned
// sockarray's size is compile-time); the setup script handles that.
if (!Number.isInteger(SHARDS) || SHARDS < 1 || SHARDS > 16) {
	throw new Error("g6-sharded-scan: SCAN_SHARDS must be 1..16");
}

type Shard = {
	serverId: number;
	child: ReturnType<typeof spawn>;
	pendingBoundaries: Array<(snap: BoundarySnapshot) => void>;
	marks: Partial<BoundaryMarks> & { stop?: BoundarySnapshot };
	sessionsAtSteady: number | null;
	stderrTail: string[];
	// DIAGNOSTIC: per-shard lifecycle (every child.on('exit') with timestamp
	// and signal name; the post-run SIGKILL cleanup at line ~408 is recorded
	// but excluded from D1 by the t2+5s filter at the discrimination step).
	lifecycle: Array<{ tsMs: number; code: number | null; signal: NodeJS.Signals | null }>;
	// DIAGNOSTIC: timestamps of every boundary message received (so a
	// missing shard's boundary is visible).
	boundaryArrivedAt: Array<{ phase: string; tsMs: number }>;
};

function readKernelUdp(): Record<string, number> | null {
	try {
		const snmp = readFileSync("/proc/net/snmp", "utf8");
		const lines = snmp.split("\n").filter((l) => l.startsWith("Udp:"));
		if (lines.length < 2) return null;
		const keys = (lines[0] as string).split(/\s+/).slice(1);
		const vals = (lines[1] as string).split(/\s+/).slice(1).map(Number);
		const out: Record<string, number> = {};
		keys.forEach((k, i) => {
			out[k] = vals[i] ?? 0;
		});
		return out;
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

// readPerShardUdp reads /proc/<pid>/net/udp (per-shard, not host-wide).
// Returns { InDatagrams, NoPorts, InErrors, OutDatagrams, RcvbufErrors,
// SndbufErrors, InCsumErrors, IgnoredMulti, MemErrors } or null on failure.
function readPerShardUdp(pid: number): Record<string, number> | null {
	try {
		const text = readFileSync(`/proc/${pid}/net/udp`, "utf8");
		const lines = text.split("\n").filter((l) => l.startsWith("Udp:"));
		if (lines.length < 2) return null;
		const keys = lines[0]!.split(/\s+/).slice(1);
		const vals = lines[1]!.split(/\s+/).slice(1).map(Number);
		const out: Record<string, number> = {};
		keys.forEach((k, i) => {
			out[k] = vals[i] ?? 0;
		});
		return out;
	} catch {
		return null;
	}
}

// dumpBpfMap runs `bpftool map dump pinned <mapName>` and returns the raw
// text output. Used for steer_stats (per-cpu), socks (slot-to-fd), and
// slot_by_server_id (server-id-to-slot). Read-only after producer startup.
function dumpBpfMap(mapName: string): string | null {
	try {
		const out = execFileSync("bpftool", ["map", "dump", "pinned", mapName], {
			encoding: "utf8",
			timeout: 5000,
		});
		return out;
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
	residentServices: { docker: boolean; tailscaled: boolean };
} {
	const tsMs = Date.now();
	let loadavg: { "1": number; "5": number; "15": number } = { "1": 0, "5": 0, "15": 0 };
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
		const { readdirSync, readFileSync: rfs } = require("node:fs") as typeof import("node:fs");
		const cpuDirs = readdirSync("/sys/devices/system/cpu").filter((d) => /^cpu\d+$/.test(d));
		for (const cpuDir of cpuDirs) {
			try {
				const v = rfs(`/sys/devices/system/cpu/${cpuDir}/cpufreq/scaling_cur_freq`, "utf8").trim();
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
		const { readdirSync, readFileSync: rfs } = require("node:fs") as typeof import("node:fs");
		const hwmons = readdirSync("/sys/class/hwmon").filter((d) => /^\d+$/.test(d));
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
		governor = readFileSync("/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor", "utf8").trim();
	} catch {
		// missing
	}
	// residentServices is a process-level check, not a file read. The
	// conductor (running on the rig) doesn't know the resident-services
	// convention itself; the orchestrator records it. The diagnostic
	// records `null` here and the stamp's per-cell block carries the
	// orchestrator's recording.
	return { tsMs, loadavg, cpuMhz, packageTempC, governor, residentServices: { docker: false, tailscaled: false } };
}

// sumPerCpuSteerStats parses a `bpftool map dump pinned .../steer_stats`
// output and returns the sum of steered (key 0) and fallback (key 1)
// across CPUs. The map is BPF_MAP_TYPE_PERCPU_ARRAY; bpftool prints one
// line per CPU. We sum the values per key.
function sumPerCpuSteerStats(text: string): { steered: number; fallback: number } | null {
	let steered = 0;
	let fallback = 0;
	let found = false;
	for (const line of text.split("\n")) {
		// Format: "key: 0  value: 1234" or similar per-CPU output
		const m = line.match(/key:\s*(\d+)\s+value:\s*(\d+)/);
		if (m) {
			found = true;
			const key = Number(m[1]);
			const val = Number(m[2]);
			if (key === 0) steered += val;
			else if (key === 1) fallback += val;
		}
	}
	return found ? { steered, fallback } : null;
}

async function main(): Promise<void> {
	const tls = generateLocalhostCert();
	if (!tls) throw new Error("g6-sharded-scan: cert generation failed");
	const dir = mkdtempSync(join(tmpdir(), "g6-shard-"));
	const certPath = join(dir, "cert.pem");
	const keyPath = join(dir, "key.pem");
	writeFileSync(certPath, tls.certPem);
	writeFileSync(keyPath, tls.keyPem);

	const shards: Shard[] = [];
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
		];
		// One attach per group is enough; the attach lives on the reuseport
		// group, so the first shard carries it.
		if (i === 1) args.push("--attach-prog-pin", `${PIN_DIR}/steer_by_cid`);
		const child = asRoot
			? spawn(process.execPath, args, {
					cwd: process.cwd(),
					stdio: ["pipe", "pipe", "pipe"],
				})
			: spawn("sudo", ["-E", process.execPath, ...args], {
					cwd: process.cwd(),
					stdio: ["pipe", "pipe", "pipe"],
				});
		const shard: Shard = {
			serverId: i,
			child,
			pendingBoundaries: [],
			marks: {},
			sessionsAtSteady: null,
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
		child.on("exit", (code, signal) => {
			// DIAGNOSTIC: every exit is recorded with timestamp and signal
			// name, regardless of code. The post-run SIGKILL cleanup is
			// filtered at the discrimination step (tsMs > rung_T2 + 5s).
			shard.lifecycle.push({ tsMs: Date.now(), code, signal });
			if (code !== 0) {
				readyReject(
					new Error(
						`shard ${i} exited ${code}: ${shard.stderrTail.join(" | ")}`,
					),
				);
			}
		});
		createInterface({ input: child.stderr! }).on("line", (line) => {
			shard.stderrTail.push(line);
			if (shard.stderrTail.length > 20) shard.stderrTail.shift();
			console.error(`[shard ${i} stderr] ${line}`);
		});
		createInterface({ input: child.stdout! }).on("line", (line) => {
			let msg: { ev?: string; snap?: BoundarySnapshot };
			try {
				msg = JSON.parse(line);
			} catch {
				console.log(`[shard ${i}] ${line}`);
				return;
			}
			if (msg.ev === "ready") {
				console.log(`g6-sharded-scan: shard ${i} ready`);
				readyResolve();
			} else if (msg.ev === "boundary" && msg.snap) {
				// DIAGNOSTIC: every boundary arrival is timestamped.
				shard.boundaryArrivedAt.push({
					phase: (msg.snap as unknown as { phase?: string }).phase ?? "unknown",
					tsMs: Date.now(),
				});
				shard.pendingBoundaries.shift()?.(msg.snap);
			}
		});
	}

	await Promise.all(readyPromises);

	const kernelMarks: Record<string, Record<string, number> | null> = {};
	const broadcast = async (
		cmd: string,
		phase: string | null,
	): Promise<BoundarySnapshot[]> => {
		kernelMarks[phase ?? cmd] = readKernelUdp();
		return Promise.all(
			shards.map(
				(shard) =>
					new Promise<BoundarySnapshot>((res) => {
						shard.pendingBoundaries.push(res);
						shard.child.stdin!.write(
							`${JSON.stringify(phase ? { cmd, phase } : { cmd })}\n`,
						);
					}),
			),
		);
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
		perShardUdp: Record<number, Record<string, number> | null>;
		perShardHandshakesInFlight: Record<number, number | null>;
		steerStatsSum: { steered: number; fallback: number } | null;
		steerStatsRaw: string | null;
		socksMapDump: string | null;
		slotMapDump: string | null;
	};
	const captureTimestamp = (label: string): DiagnosticTimestampBlock => {
		const tsMs = Date.now();
		const perShardUdp: Record<number, Record<string, number> | null> = {};
		const perShardHandshakesInFlight: Record<number, number | null> = {};
		for (const shard of shards) {
			perShardUdp[shard.serverId] = readPerShardUdp(shard.child.pid!);
			// handshakesInFlight is read from the shard's last boundary message
			// (the producer's "connect" boundary at start, or the "steady"
			// boundary at end). The diagnostic does not call into the producer
			// process directly.
			const lastSnap = shard.marks.start ?? shard.marks.steadyStart;
			perShardHandshakesInFlight[shard.serverId] =
				lastSnap && (lastSnap.metrics as Record<string, unknown>).handshakesInFlight != null
					? Number((lastSnap.metrics as Record<string, unknown>).handshakesInFlight)
					: null;
		}
		const steerStatsRaw = dumpBpfMap(`${PIN_DIR}/steer_stats`);
		const steerStatsSum = steerStatsRaw ? sumPerCpuSteerStats(steerStatsRaw) : null;
		const socksMapDump = dumpBpfMap(`${PIN_DIR}/socks`);
		const slotMapDump = dumpBpfMap(`${PIN_DIR}/slot_by_server_id`);
		return {
			tsMs,
			hostLoad: readHostLoad(),
			perShardUdp,
			perShardHandshakesInFlight,
			steerStatsSum,
			steerStatsRaw,
			socksMapDump,
			slotMapDump,
		};
	};
	type DiagnosticRung = {
		rung: number;
		connectStartTsMs: number;
		connectEndTsMs: number | null;
		connectWallSec: number | null;
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
	const captureRung = (rung: number, sessionsRequested: number): {
		begin: () => void;
		mid: () => void;
		end: () => void;
	} => {
		const block: DiagnosticRung = {
			rung,
			connectStartTsMs: 0,
			connectEndTsMs: null,
			connectWallSec: null,
			T0: captureTimestamp(`rung${rung}_T0`),
			T1: null,
			T2: null,
			connectErrorsSample: null,
			fallbackReasonBreakdown: null,
		};
		rungDiagnostics.push(block);
		let midScheduled = false;
		return {
			begin: () => {
				block.connectStartTsMs = Date.now();
			},
			mid: () => {
				if (midScheduled) return;
				midScheduled = true;
				const elapsed = Date.now() - block.connectStartTsMs;
				const targetMs = elapsed / 2; // schedule T1 at half the elapsed connect time
				setTimeout(() => {
					block.T1 = captureTimestamp(`rung${rung}_T1`);
				}, Math.max(0, targetMs));
			},
			end: () => {
				block.connectEndTsMs = Date.now();
				block.connectWallSec = (block.connectEndTsMs - block.connectStartTsMs) / 1000;
				block.T2 = captureTimestamp(`rung${rung}_T2`);
				if (block.T0.steerStatsSum && block.T2.steerStatsSum) {
					const fallbackDelta = block.T2.steerStatsSum.fallback - block.T0.steerStatsSum.fallback;
					const openingInitialEstimate = sessionsRequested;
					block.fallbackReasonBreakdown = {
						openingInitialEstimate,
						fallbackDeltaT2MinusT0: fallbackDelta,
						excessFallback: Math.max(0, fallbackDelta - openingInitialEstimate),
						note: "excess fallback is a D2 candidate, not a verdict",
					};
				}
			},
		};
	};

	const startSnaps = await broadcast("phase", "connect");
	for (const [index, snap] of startSnaps.entries()) {
		(shards[index] as Shard).marks.start = snap;
	}

	// DIAGNOSTIC: capture the T0 block (already collected by the
	// `captureTimestamp` call inside `captureRung`), and wire begin/mid/end.
	const currentRung = captureRung(SESSIONS, SESSIONS);
	currentRung.begin();

	const startedAt = new Date().toISOString();
	const deadlineSec = Math.ceil(
		1.5 *
			(CONNECT_TIMEOUT_SECONDS +
				STEADY_SECONDS +
				Math.ceil(DRAIN_GRACE_MS / 1000) +
				IDLE_SECONDS),
	);
	const clientArgs = [
		"--role",
		"realm",
		"--sessions",
		String(SESSIONS),
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
		PREREG_SHA,
		"--started-at",
		startedAt,
	];
	console.log(
		`g6-sharded-scan: shards=${SHARDS} sessions=${SESSIONS} paced=${PACED} url=https://${SERVER_ADDRESS}:${PORT} started-at=${startedAt}`,
	);
	const client = spawn(
		"ssh",
		[
			"-o",
			"BatchMode=yes",
			OFFBOX_SSH,
			OFFBOX_ENTRY_SCRIPT,
			"--candidate",
			CANDIDATE_SHA,
			"--bin",
			"mmo-client",
			"--deadline",
			String(deadlineSec),
			// MMO_CLIENT_RSS_LIMIT_MB (optional) — when set on the
			// conductor's env, the linux entry script exports it on
			// the gen before spawning mmo-client. Default (unset)
			// keeps the mmo-client's built-in 12 GB RSS guard.
			...(process.env.MMO_CLIENT_RSS_LIMIT_MB
				? ["--rss-limit", process.env.MMO_CLIENT_RSS_LIMIT_MB]
				: []),
			"--",
			// Linux binds to 127.0.0.x succeed (unlike macOS), which
			// pins the source to loopback and breaks sendmsg to the
			// VPC (EINVAL on sendmsg from loopback to non-loopback).
			// The parent's macOS runs never hit this because macOS's
			// bind to 127.0.0.x fails and falls back to the default
			// bind. We pass --bind-default unconditionally; mmo-client
			// accepts it on both OSes, and after `--` the linux entry
			// script's case-statement is out of the way.
			"--bind-default",
			"--url",
			`https://${SERVER_ADDRESS}:${PORT}`,
			...clientArgs,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

	// DIAGNOSTIC: schedule T1 capture at half the connect phase's elapsed time.
	// T1 is a wall-clock trigger, not a producer phase. The mid-point is
	// estimated as T0 + connectWallSec/2; if the connect phase completes
	// faster, T1 still fires (it's an upper bound on the connect phase).
	// For 20k, the connect phase is ~2.2s; T1 fires at ~1.1s after begin().
	currentRung.mid();

	const clientStdout: string[] = [];
	const clientDone = new Promise<number>((res) => {
		client.on("exit", (code, signal) => res(code ?? (signal ? 128 : -1)));
	});

	const applyMarks = async (kind: string): Promise<void> => {
		if (kind === "steady") {
			const snaps = await broadcast("phase", "steady");
			for (const [index, snap] of snaps.entries()) {
				const shard = shards[index] as Shard;
				shard.marks.steadyStart = snap;
				shard.sessionsAtSteady =
					typeof (snap.metrics as Record<string, unknown>).sessionsActive ===
					"number"
						? ((snap.metrics as Record<string, unknown>)
								.sessionsActive as number)
						: null;
			}
			console.log(
				`g6-sharded-scan: steady begins; sessions per shard = [${shards
					.map((s) => s.sessionsAtSteady ?? "?")
					.join(", ")}]`,
			);
			// DIAGNOSTIC: the steady marker is the end of the connect phase.
			// Capture the mmo-client's connectErrorsSample (5-string sample,
			// truncation disclosed per L9) and fire the T2 block.
			const sampleMatch = clientStdout.join("\n").match(/"connectErrorsSample":\s*(\[[^\]]*\])/);
			if (sampleMatch && currentRung) {
				try {
					currentRung.connectErrorsSample = JSON.parse(sampleMatch[1]!) as string[];
				} catch {
					// malformed sample; leave as null
				}
			}
			currentRung?.end();
		} else if (kind === "drain") {
			const snaps = await broadcast("phase", "drain");
			for (const [index, snap] of snaps.entries()) {
				(shards[index] as Shard).marks.drainStart = snap;
			}
		} else if (kind === "idle") {
			const snaps = await broadcast("phase", "idle");
			for (const [index, snap] of snaps.entries()) {
				const shard = shards[index] as Shard;
				shard.marks.drainEnd = snap;
				shard.marks.idleStart = snap;
			}
		} else if (kind === "stop") {
			const snaps = await broadcast("stop", null);
			for (const [index, snap] of snaps.entries()) {
				(shards[index] as Shard).marks.stop = snap;
			}
		}
	};

	const markerQueue: Promise<void>[] = [];
	createInterface({ input: client.stdout! }).on("line", (line) => {
		clientStdout.push(line);
		const marker = readPhaseMarker(line);
		if (marker) markerQueue.push(applyMarks(marker.kind));
	});
	createInterface({ input: client.stderr! }).on("line", (line) => {
		console.error(`[client stderr] ${line}`);
	});

	const clientExit = await clientDone;
	await Promise.all(markerQueue);
	console.log(`g6-sharded-scan: client exited ${clientExit}`);

	const sumWindows = (windows: BoundarySnapshot[]): Record<string, unknown> => {
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
		}
		return total;
	};

	const shardResults = shards.map((shard) => {
		const m = shard.marks;
		const complete =
			m.start && m.steadyStart && m.drainStart && m.drainEnd && m.idleStart;
		return {
			serverId: shard.serverId,
			sessionsAtSteady: shard.sessionsAtSteady,
			windows: complete ? deriveBoundaryWindows(m as BoundaryMarks) : null,
			marksSeen: Object.keys(m),
		};
	});
	const steadyWindows = shardResults
		.map((s) => s.windows?.steady)
		.filter((w): w is BoundarySnapshot => w != null);
	const steadyDrainWindows = shardResults
		.map((s) => s.windows?.steadyDrain)
		.filter((w): w is BoundarySnapshot => w != null);

	const result = {
		schema: "g6-sharded-scan/1",
		startedAt,
		candidateSha: CANDIDATE_SHA,
		config: {
			shards: SHARDS,
			sessions: SESSIONS,
			paced: PACED,
			pacerPps: process.env.WEBTRANSPORT_PACER_PPS ?? null,
			port: PORT,
			pinDir: PIN_DIR,
			endpoints: ENDPOINTS,
			steadySeconds: STEADY_SECONDS,
		},
		clientExit,
		shards: shardResults,
		aggregate: {
			steady: sumWindows(steadyWindows),
			steadyDrain: sumWindows(steadyDrainWindows),
		},
		kernelMarks,
		clientStdout: clientStdout.join("\n"),
	};
	writeFileSync(OUT, JSON.stringify(result, null, 1));
	console.log(`g6-sharded-scan: wrote ${OUT}`);

	// === DIAGNOSTIC EMISSION (g6-sharded-diagnostic-01) ===
	// Emitted as a separate artifact. The rated g6-sharded-scan.json above is
	// unchanged. The diagnostic JSON is read by the off-runner discrimination
	// step to assign D1/D2/D3 hypotheses.
	if (DIAGNOSTIC) {
		const diagnosticResult = {
			schema: "g6-sharded-diagnostic/1",
			startedAt,
			candidateSha: CANDIDATE_SHA,
			dispatch: {
				shards: SHARDS,
				sessions: SESSIONS,
				paced: PACED,
				endpoints: ENDPOINTS,
				connectConcurrency: CONNECT_CONCURRENCY,
				pinDir: PIN_DIR,
			},
			ladder: rungDiagnostics,
			perShardLifecycle: shards.map((s) => ({
				serverId: s.serverId,
				pid: s.child.pid,
				boundaries: s.boundaryArrivedAt,
				exits: s.lifecycle,
			})),
		};
		writeFileSync(DIAGNOSTIC_OUT, JSON.stringify(diagnosticResult, null, 1));
		console.log(`g6-sharded-scan: wrote ${DIAGNOSTIC_OUT}`);
	}

	for (const shard of shards) {
		shard.child.kill("SIGKILL");
	}
	process.exit(clientExit === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(`g6-sharded-scan: ${String(error)}`);
	process.exit(1);
});
