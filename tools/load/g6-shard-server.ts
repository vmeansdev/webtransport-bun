/**
 * One shard of the informal G6 sharded scan: a standalone server process that
 * binds :4433 with SO_REUSEPORT, issues QUIC-LB CIDs carrying its server id,
 * inserts its socket into the pinned steering sockarray, and runs the same
 * g6-server-core emitter bench-g6 runs in-process.
 *
 * Driven over stdio by tools/load/g6-sharded-scan.ts, one JSON object per
 * line:
 *   in : {"cmd":"phase","phase":"steady"} | {"cmd":"stop"}
 *   out: {"ev":"ready",...} | {"ev":"boundary","phase":...,"snap":...}
 *
 * Not a registered producer — the scan is characterization, and this process
 * deliberately reuses the registered core (createG6ServerCore) so the emitter
 * under test is byte-for-byte the gate's.
 */
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createServer } from "../../packages/webtransport/src/index.ts";
import type { BoundarySnapshot, EmitterPhase } from "./g6-artifact.ts";
import {
	createG6ServerCore,
	freshG6ServerState,
	type G6ServerCorePacedMirror,
	REGISTERED_G6_SERVER_CORE_PLAN,
} from "./g6-server-core.ts";
import { createMonotonicClock } from "./latency-clock.ts";
import {
	CLASS_ACK,
	CLASS_RAID,
	CLASS_RAID_JOIN,
	CLASS_SNAPSHOT,
} from "./latency-stamp.ts";

function arg(name: string): string | null {
	const index = process.argv.indexOf(`--${name}`);
	if (index === -1) return null;
	return process.argv[index + 1] ?? null;
}

function requireArg(name: string): string {
	const value = arg(name);
	if (value === null) {
		throw new Error(`g6-shard-server: --${name} is required`);
	}
	return value;
}

// The BPF example's layout, byte for byte (steer_by_cid.bpf.c: SERVER_ID_LEN
// 2, NONCE_LEN 8, CONFIG_ROTATION 0). Nothing on the wire encodes these; the
// program and this config must agree or routing degrades to the kernel hash.
const SERVER_ID_LEN = 2;
const NONCE_LEN = 8;
const CONFIG_ROTATION = 0;

async function main(): Promise<void> {
	const port = parseInt(requireArg("port"), 10);
	const serverId = parseInt(requireArg("server-id"), 10);
	const certPem = readFileSync(requireArg("cert"), "utf8");
	const keyPem = readFileSync(requireArg("key"), "utf8");
	const sockArrayPinPath = requireArg("sock-array-pin");
	const attachProgPinPath = arg("attach-prog-pin");
	const topSessions = parseInt(requireArg("top-sessions"), 10);
	const paced = arg("paced") === "1";

	if (!Number.isInteger(serverId) || serverId < 1 || serverId > 8) {
		throw new Error("g6-shard-server: --server-id must be 1..8");
	}

	const clock = await createMonotonicClock(false);
	const phaseState: { current: EmitterPhase } = { current: "connect" };
	const state = freshG6ServerState();
	let pacedMirror: G6ServerCorePacedMirror | null = null;

	const core = createG6ServerCore({
		plan: REGISTERED_G6_SERVER_CORE_PLAN,
		clock,
		nowMs: () => Date.now(),
		phaseState,
		state: () => state,
		severAtMs: () => null,
		pacedMirror: () => pacedMirror,
	});

	const shape = REGISTERED_G6_SERVER_CORE_PLAN;
	const server = createServer({
		port,
		tls: { certPem, keyPem },
		reusePort: true,
		quicLb: {
			serverId: [0, serverId],
			nonceLen: NONCE_LEN,
			configRotation: CONFIG_ROTATION,
		},
		reusePortSteering: {
			sockArrayPinPath,
			key: serverId - 1,
			...(attachProgPinPath ? { attachProgPinPath } : {}),
		},
		limits: {
			maxSessions: topSessions * 2,
			maxHandshakesInFlight: topSessions * 2,
			idleTimeoutMs: 300_000,
			maxDatagramSize: shape.snapshotPayloadBytes + 64,
		},
		rateLimits: {
			handshakesPerSec: topSessions * 2,
			handshakesBurst: topSessions * 2,
			handshakesBurstPerPrefix: topSessions * 2,
			streamsPerSec: 1000,
			streamsBurst: 2000,
			datagramsPerSec: 200_000,
			datagramsBurst: 400_000,
		},
		onSession: core.onSession,
	});
	if (paced) {
		pacedMirror = {
			send: (targets, payload) =>
				server.sendDatagramMirrorPaced(targets, payload),
			readReports: (max) => server.readMirrorReports(max),
		};
	}

	let cpuBase = process.cpuUsage();
	const cpuStart = cpuBase;
	const serverCpuMs = (): number => {
		cpuBase = process.cpuUsage();
		return (
			(cpuBase.user - cpuStart.user + cpuBase.system - cpuStart.system) / 1000
		);
	};

	const boundary = (): BoundarySnapshot => ({
		rxTotal: state.rxTotal,
		rxSurvivors: state.rxSurvivors,
		rxByClass: {
			snapshot: state.rxByClass.get(CLASS_SNAPSHOT) ?? 0,
			ack: state.rxByClass.get(CLASS_ACK) ?? 0,
			raid: state.rxByClass.get(CLASS_RAID) ?? 0,
			raidJoin: state.rxByClass.get(CLASS_RAID_JOIN) ?? 0,
			unstamped: state.rxUnstamped,
		},
		emitter: { ...state.emitter },
		cpuMs: serverCpuMs(),
		wallMs: Date.now(),
		// Kernel UDP counters are host-wide; with N shards on one host the
		// conductor owns that sample, not the shard.
		kernel: null,
		metrics: server.metricsSnapshot() as unknown as Record<string, unknown>,
	});

	const stopEmitter = core.startEmitter(() => phaseState.current);

	const emit = (line: unknown): void => {
		process.stdout.write(`${JSON.stringify(line)}\n`);
	};
	emit({
		ev: "ready",
		shard: serverId,
		pid: process.pid,
		paced,
		pacerPps: process.env.WEBTRANSPORT_PACER_PPS ?? null,
	});

	const rl = createInterface({ input: process.stdin });
	for await (const raw of rl) {
		const line = raw.trim();
		if (line === "") continue;
		const msg = JSON.parse(line) as { cmd: string; phase?: EmitterPhase };
		if (msg.cmd === "phase" && msg.phase) {
			phaseState.current = msg.phase;
			emit({ ev: "boundary", phase: msg.phase, snap: boundary() });
		} else if (msg.cmd === "stop") {
			emit({ ev: "boundary", phase: "stop", snap: boundary() });
			break;
		}
	}
	stopEmitter();
	await server.close();
	process.exit(0);
}

main().catch((error) => {
	process.stderr.write(`g6-shard-server: ${String(error)}\n`);
	process.exit(1);
});
