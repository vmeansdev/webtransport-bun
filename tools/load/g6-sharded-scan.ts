/**
 * Informal G6 sharded scan conductor: N g6-shard-server processes share
 * :4433 via SO_REUSEPORT + the pinned steer_by_cid eBPF program, one off-box
 * mmo-client realm fleet drives the registered steady shape at them, and the
 * conductor aggregates per-shard boundary windows.
 *
 * Characterization only — not a registered producer. The per-shard emitter
 * and the client contract are the gate's own; what is new here is only the
 * process split and the summation.
 *
 * Env: SCAN_SHARDS (2), SCAN_SESSIONS (5000), SCAN_OUT (g6-sharded-scan.json),
 *      SCAN_PIN_DIR (/sys/fs/bpf/quic-lb), G6_OFFBOX_SSH, G6_CANDIDATE_SHA,
 *      G6_PREREGISTRATION_SHA256, G6_SERVER_ADDRESS (10.99.0.2), G6_PORT
 *      (4433), G6_PACED_EMITTER + WEBTRANSPORT_PACER_PPS (per-shard pacing).
 */
import { spawn } from "node:child_process";
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
const PIN_DIR = process.env.SCAN_PIN_DIR ?? "/sys/fs/bpf/quic-lb";
const OFFBOX_SSH = process.env.G6_OFFBOX_SSH ?? "";
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

	for (let i = 1; i <= SHARDS; i += 1) {
		const args = [
			"-E",
			process.execPath,
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
		const child = spawn("sudo", args, {
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
		child.on("exit", (code) => {
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
	const startSnaps = await broadcast("phase", "connect");
	for (const [index, snap] of startSnaps.entries()) {
		(shards[index] as Shard).marks.start = snap;
	}

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
			"tools/offbox/mac-generator-entry-g6.sh",
			"--candidate",
			CANDIDATE_SHA,
			"--bin",
			"mmo-client",
			"--deadline",
			String(deadlineSec),
			"--",
			"--url",
			`https://${SERVER_ADDRESS}:${PORT}`,
			...clientArgs,
		],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);

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

	for (const shard of shards) {
		shard.child.kill("SIGKILL");
	}
	process.exit(clientExit === 0 ? 0 : 1);
}

main().catch((error) => {
	console.error(`g6-sharded-scan: ${String(error)}`);
	process.exit(1);
});
