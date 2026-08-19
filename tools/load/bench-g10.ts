#!/usr/bin/env bun
/**
 * G10's conductor: the broadcast server, the three interleaved emitter arms, the
 * probe echo the RTT clause rides, and the two stall instruments §6.6 registers.
 *
 * Registration: `docs/research/preregistrations/gate-g10-broadcast.md`. Every
 * rate comes from `g10-plan.ts` and every verdict from `g10-classify.ts`, so
 * nothing in this file is a threshold — it offers the registered load and
 * records what happened. The gate agent recomputes the clauses from the raw
 * fields; the artifact carries the classifier's answer only as a second opinion
 * to disagree with (§10).
 *
 * Four things here are deliberate, and they are why this is not `bench-g6` with
 * a different emitter:
 *
 * 1. **The fan-out is one impulse, on purpose.** G6 spread its emitter over a
 *    20 ms slice grid because a realm server slices its player list. A tick
 *    exists at one instant and every subscriber is owed it, so no arm here
 *    spreads the pass (§5). The spread number this produces is, in large part,
 *    the NIC serializing 10,000 packets.
 * 2. **The spread is never computed here.** It is `max(receiveNs) −
 *    min(receiveNs)` across subscribers who all live in one process on the Mac,
 *    on one clock (§1.8). This process contributes the sequence number and the
 *    arm byte; the subscriber role contributes the arithmetic.
 * 3. **The probe loop is independent of the broadcast.** A probe measuring its
 *    own broadcast copy at fan-out position 9,999 would be measuring its queue
 *    position. Probes send their own datagram and the server echoes it on
 *    receipt (§1.8).
 * 4. **The JS-thread stall is a first-class instrument, not a diagnostic.** M1's
 *    10,000-target cap is a 1 ms stall budget and this gate's fleet is exactly
 *    that cap (§1.11), so C7 reads `passStallNs` and the loop sampler reports
 *    beside it.
 *
 * Clock: `process.hrtime.bigint()`. Every server-side quantity here is a
 * *duration on the JS thread* — the stall, the loop lag, the echo dwell — and
 * the JS thread's own monotonic counter is precisely what those mean. Nothing
 * in this file differences an instant against another host's.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
	connect,
	createServer,
} from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	type ArmClauses,
	type ArmId,
	armComparabilityFalsifier,
	evaluateEmitterHonesty,
	evaluateFleetDelivery,
	evaluateLedger,
	evaluateLiveness,
	evaluatePerSubscriberDelivery,
	evaluateRtt,
	evaluateSpreadClause,
	evaluateStall,
	gateVerdict,
	leverStatement,
	loopLagSamplerFalsifier,
	negativeFalsifier,
	scoreMirrorStallPrediction,
	skewFalsifier,
} from "./g10-classify.ts";
import {
	armForElapsed,
	type BroadcastResult,
	blocksPerArm,
	broadcast,
	type EmitterTransport,
	resolveArms,
	type SendOutcome,
	startLoopLagSampler,
} from "./g10-emitter.ts";
import {
	A2_CHUNK_TARGETS,
	armShape,
	DATAGRAM_MIRROR_MAX,
	GATE_RATE,
	JS_STALL_BUDGET_MS,
	LOOP_LAG_SAMPLE_MS,
	MESSAGE_PAYLOAD_BYTES,
	PROBE_COHORT,
	PROBE_HZ,
	preflightRequirements,
	RATE_LADDER,
	SUBSCRIBERS,
	VERDICT_ARM,
} from "./g10-plan.ts";
import { LatencyHistogram } from "./latency-histogram.ts";
import {
	ARM_A1,
	ARM_A2,
	ARM_A3,
	CLASS_BROADCAST,
	CLASS_PROBE,
	CLASS_PROBE_ECHO,
	decodeStamp,
	encodeStamp,
	STAMP_BYTES_V4,
	writeReflection,
} from "./latency-stamp.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/broadcast-client`;
const PORT = Number.parseInt(process.env.G10_PORT ?? "4433", 10);

const LADDER = (process.env.G10_RATE_LADDER ?? RATE_LADDER.join(","))
	.split(",")
	.map((s) => Number.parseInt(s.trim(), 10))
	.filter((n) => Number.isFinite(n) && n > 0);

const REQUESTED_ARMS = (process.env.G10_ARMS ?? "A1,A2,A3")
	.split(",")
	.map((s) => s.trim().toUpperCase())
	.filter((s): s is ArmId => s === "A1" || s === "A2" || s === "A3");

const WINDOW_SECONDS = Number.parseInt(
	process.env.G10_WINDOW_SECONDS ?? "120",
	10,
);
const SETTLE_SECONDS = Number.parseInt(
	process.env.G10_SETTLE_SECONDS ?? "15",
	10,
);
const BLOCK_MS = Number.parseInt(process.env.G10_BLOCK_MS ?? "10000", 10);
const SAMPLE_INTERVAL_MS = Number.parseInt(
	process.env.G10_SAMPLE_MS ?? "2000",
	10,
);
const OFFBOX_SSH = process.env.G10_OFFBOX_SSH ?? "";
const SERVER_ADDRESS = process.env.G10_SERVER_ADDRESS ?? "10.99.0.2";
const ESTABLISH_TIMEOUT_S = Number.parseInt(
	process.env.G10_ESTABLISH_TIMEOUT_S ?? "300",
	10,
);

/**
 * Local smoke: a handful of co-resident subscribers so the conductor's own
 * wiring — arm resolution, the interleave, the ledger, the stall instruments,
 * the artifact — can be exercised on a laptop.
 *
 * **A smoke run is never a result** (§10). The artifact says so in a field, the
 * fleet size is wrong, the host is wrong, and there is no cable.
 */
const SMOKE = process.env.G10_SMOKE === "1";
const FLEET = SMOKE
	? Number.parseInt(process.env.G10_SMOKE_FLEET ?? "40", 10)
	: SUBSCRIBERS;

const OUT_JSON = process.env.G10_OUT ?? join(ROOT, "tools/load/bench-g10.json");
const OUT_CSV = OUT_JSON.replace(/\.json$/, ".csv");
const HAS_PROC = process.platform === "linux";

const ARM_BYTE: Record<ArmId, number> = { A1: ARM_A1, A2: ARM_A2, A3: ARM_A3 };

/* -------------------------------------------------------------------------- */
/* Host sampling — Linux only, and absent rather than faked elsewhere          */
/* -------------------------------------------------------------------------- */

type CpuSnapshot = { busy: number; total: number };

function readHostCpu(): CpuSnapshot | null {
	if (!HAS_PROC) return null;
	try {
		const line = require("node:fs")
			.readFileSync("/proc/stat", "utf8")
			.split("\n")[0] as string;
		const parts = line.split(/\s+/).slice(1).map(Number);
		const total = parts.reduce((a, b) => a + b, 0);
		const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
		return { busy: total - idle, total };
	} catch {
		return null;
	}
}

function hostCpuPct(
	prev: CpuSnapshot | null,
	next: CpuSnapshot | null,
): number | null {
	if (!prev || !next) return null;
	const dTotal = next.total - prev.total;
	if (dTotal <= 0) return null;
	return (
		((next.busy - prev.busy) / dTotal) *
		100 *
		(navigator.hardwareConcurrency ?? 1)
	);
}

function serverCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

function readKernelUdp(): Record<string, number> | null {
	if (!HAS_PROC) return null;
	try {
		const text = require("node:fs").readFileSync("/proc/net/snmp", "utf8");
		const lines = text.split("\n").filter((l: string) => l.startsWith("Udp:"));
		const keys = (lines[0] ?? "").split(/\s+/).slice(1);
		const values = (lines[1] ?? "").split(/\s+/).slice(1).map(Number);
		const out: Record<string, number> = {};
		keys.forEach((k: string, i: number) => {
			out[k] = values[i] ?? 0;
		});
		return out;
	} catch {
		return null;
	}
}

/* -------------------------------------------------------------------------- */
/* Per-arm state                                                              */
/* -------------------------------------------------------------------------- */

type ArmState = {
	arm: ArmId;
	broadcastsIssued: number;
	sendAttempts: number;
	sendOk: number;
	sendWouldBlock: number;
	sendErrors: number;
	sendEventsSkipped: number;
	/** Rejections that arrived after the pass returned. Charged against sendOk. */
	deferredErrors: number;
	/** §6.6a — what C7 reads. */
	stall: LatencyHistogram;
	/** §C6 — deadline to the instant the pass *begins*, never across a send. */
	handoffLag: LatencyHistogram;
	/** §6.3 — server dwell on the echo path, disclosed beside C3. */
	hold: LatencyHistogram;
	probeEchoes: number;
	blocks: number;
};

function freshArm(arm: ArmId): ArmState {
	return {
		arm,
		broadcastsIssued: 0,
		sendAttempts: 0,
		sendOk: 0,
		sendWouldBlock: 0,
		sendErrors: 0,
		sendEventsSkipped: 0,
		deferredErrors: 0,
		stall: new LatencyHistogram(),
		handoffLag: new LatencyHistogram(),
		hold: new LatencyHistogram(),
		probeEchoes: 0,
		blocks: 0,
	};
}

type Subscriber = {
	id: string;
	send: (payload: Uint8Array) => SendOutcome;
	alive: boolean;
};

/**
 * Why the arms report `ok` optimistically, and what pays for it.
 *
 * There is no public `trySendDatagram`: the landed promise-free fast path lives
 * *inside* `session.sendDatagram()`, which takes it whenever queue budget allows
 * and only allocates a promise when it has to park (index.ts
 * `sendDatagramWithoutPromise`). That is exactly the emitter §2.1 registers — but
 * it means the call's outcome is not available at the instant the call returns.
 *
 * So the pass counts an attempt synchronously, and a rejection that arrives
 * later increments `deferredErrors` on the arm that issued it. C5's ledger is
 * evaluated against `sendOk − deferredErrors`, after the drain grace, so a
 * failure that landed after the pass is a failure in the ledger rather than a
 * success the arm walked away from. Awaiting inside the pass instead would make
 * every arm the parking path and measure something no arm here is.
 */

/* -------------------------------------------------------------------------- */

type OffboxReport = {
	sessions?: number;
	/** Smoke path only. Never a rung, never a clause input beyond delivery. */
	smokeDelivery?: { received: number; unstamped: number; subscribers: number };
	perArm?: Record<
		string,
		{
			messagesIssued?: number;
			messagesComplete?: number;
			received?: number;
			spreadP99Ms?: number;
			spreadHistogram?: unknown;
			rttP99Ms?: number;
			probeLagP99Ms?: number;
			offeredRatio?: number;
			subscribersMeetingFloor?: number;
			worstSubscriberRatio?: number;
			negativeSamples?: number;
		}
	>;
};

type SpawnedClient = {
	child: ChildProcess | null;
	exited: Promise<number>;
	/**
	 * Set on the smoke path, where there is no child to pump. `finished`
	 * resolves only when `stop()` is called, so the conductor's one pump call
	 * site keeps its shape: on both paths the report arrives when the fleet is
	 * done, never as a snapshot taken the instant the fleet started.
	 */
	smoke?: { finished: Promise<OffboxReport>; stop: () => Promise<void> };
};

const activeChildren = new Set<ChildProcess>();

function killChildren(signal: NodeJS.Signals = "SIGKILL"): void {
	for (const child of activeChildren) {
		try {
			if (child.pid) process.kill(-child.pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				/* already gone */
			}
		}
	}
}

/**
 * The smoke path's subscriber fleet: real client sessions in this process,
 * receiving real datagrams over loopback.
 *
 * It exists to exercise the conductor — arm resolution, the interleave, the
 * ledger, both stall instruments, the artifact — on a laptop, and it is
 * deliberately not a substitute for the Rust role: it shares this process's
 * event loop with the emitter, so its receive instants are contaminated by the
 * very stall C7 measures, and computing a spread from them would be measuring
 * the emitter with the emitter. **The smoke path therefore reports delivery and
 * nothing else**, and the artifact is flagged as not a result (§10).
 */
async function startSmokeFleet(port: number): Promise<SpawnedClient> {
	const sessions: Awaited<ReturnType<typeof connect>>[] = [];
	let received = 0;
	let unstamped = 0;
	const perSubscriber = new Map<number, number>();
	for (let i = 0; i < FLEET; i += 1) {
		const session = await connect(`https://127.0.0.1:${port}/g10`, {
			tls: { insecureSkipVerify: true },
		});
		sessions.push(session);
		const index = i;
		void (async () => {
			try {
				for await (const datagram of session.incomingDatagrams()) {
					const stamp = decodeStamp(datagram);
					if (stamp === null) {
						unstamped += 1;
						continue;
					}
					if (stamp.klass !== CLASS_BROADCAST) continue;
					received += 1;
					perSubscriber.set(index, (perSubscriber.get(index) ?? 0) + 1);
				}
			} catch {
				/* the arm ended and the session went with it */
			}
		})();
	}
	let settle: (report: OffboxReport) => void = () => {};
	const finished = new Promise<OffboxReport>((res) => {
		settle = res;
	});
	return {
		child: null,
		exited: finished.then(() => 0),
		smoke: {
			finished,
			stop: async () => {
				const report: OffboxReport = {
					sessions: sessions.length,
					perArm: {},
					smokeDelivery: {
						received,
						unstamped,
						subscribers: perSubscriber.size,
					},
				};
				await Promise.allSettled(sessions.map((s) => s.close()));
				settle(report);
			},
		},
	};
}

/**
 * The Mac's subscriber role, over ssh, exactly as ticket 29's interface contract
 * specifies. `G10_OFFBOX_SSH` empty means co-resident, which §11a records as a
 * wiring check that can never be a G10 result — the artifact carries the flag
 * and the workflow warns.
 */
function spawnSubscribers(rate: number): SpawnedClient {
	const args = [
		"--url",
		`https://${OFFBOX_SSH ? SERVER_ADDRESS : "127.0.0.1"}:${PORT}`,
		"--sessions",
		String(FLEET),
		"--probe-cohort",
		String(SMOKE ? Math.min(PROBE_COHORT, FLEET) : PROBE_COHORT),
		"--probe-hz",
		String(PROBE_HZ),
		"--payload-bytes",
		String(MESSAGE_PAYLOAD_BYTES),
		"--rate",
		String(rate),
		"--seconds",
		String(WINDOW_SECONDS),
	];
	const [cmd, cmdArgs] = OFFBOX_SSH
		? ([
				"ssh",
				[
					"-o",
					"BatchMode=yes",
					OFFBOX_SSH,
					"tools/offbox/mac-generator-entry.sh",
					"--",
					...args,
				],
			] as const)
		: ([CLIENT_BIN, args] as const);
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

async function pumpSubscribers(
	client: SpawnedClient,
	onLine: (line: string) => void,
): Promise<OffboxReport | null> {
	let report: OffboxReport | null = null;
	if (client.smoke) return await client.smoke.finished;
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of client.child?.stdout ?? []) {
		buffered += decoder.decode(chunk as Uint8Array, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			onLine(line);
			const match = line.match(/^broadcast-client: json (\{.*\})$/);
			if (match?.[1]) report = JSON.parse(match[1]) as OffboxReport;
		}
	}
	await client.exited;
	if (client.child) activeChildren.delete(client.child);
	return report;
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
	if (LADDER.length === 0) throw new Error("G10_RATE_LADDER parsed empty");
	if (REQUESTED_ARMS.length === 0) throw new Error("G10_ARMS parsed empty");

	if (!SMOKE) {
		console.log("bench-g10: building broadcast-client (release)...");
		try {
			await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin broadcast-client --release`.quiet();
		} catch (err) {
			if (!(await Bun.file(CLIENT_BIN).exists())) {
				// Registered in the pre-registration §11b: the Rust subscriber role
				// is the piece a Mac validates and is not built on this branch. Fail
				// with the reason rather than with a spawn error six frames down.
				throw new Error(
					"bench-g10: no broadcast-client binary. The Rust subscriber role " +
						"(crates/reference/src/broadcast_client.rs) is registered as NOT " +
						"BUILT in gate-g10-broadcast.md §11b; this gate does not dispatch " +
						`until it exists. Underlying error: ${String(err)}`,
				);
			}
			console.warn("bench-g10: cargo build failed; using existing binary");
		}
	}

	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	const shape = armShape(Math.max(...LADDER), FLEET);
	const subscribers: Subscriber[] = [];
	// A per-broadcast linear scan would be 10,000 x 10,000 lookups per tick.
	const byId = new Map<string, Subscriber>();
	let arms: ArmState[] = [];
	let currentArm: ArmId = REQUESTED_ARMS[0] as ArmId;
	const armState = (): ArmState => {
		const found = arms.find((a) => a.arm === currentArm);
		if (!found) throw new Error(`no state for arm ${currentArm}`);
		return found;
	};

	const server = createServer({
		port: PORT,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: FLEET * 2,
			maxHandshakesInFlight: FLEET * 2,
			// A 60 s idle timeout would reap subscribers that only ever receive.
			idleTimeoutMs: 600_000,
			maxDatagramSize: MESSAGE_PAYLOAD_BYTES + 64,
		},
		rateLimits: {
			// Every limiter sits above the arm deliberately: a run that trips one
			// is measuring configuration, and C5's ledger would show it as errors.
			handshakesPerSec: FLEET * 2,
			handshakesBurst: FLEET * 2,
			handshakesBurstPerPrefix: FLEET * 2,
			streamsPerSec: 1000,
			streamsBurst: 2000,
			datagramsPerSec: Math.max(shape.serverInPps * 8, 200_000),
			datagramsBurst: Math.max(shape.serverInPps * 16, 400_000),
		},
		onSession: (session) => {
			const subscriber: Subscriber = {
				id: session.id,
				send: (payload) => {
					if (!subscriber.alive) return "error";
					// Never awaited: the pass is the span C7 reads, and awaiting here
					// would put every arm on the parking path.
					void session.sendDatagram(payload).catch(() => {
						armState().deferredErrors += 1;
					});
					return "ok";
				},
				alive: true,
			};
			subscribers.push(subscriber);
			byId.set(subscriber.id, subscriber);
			session.closed.then(
				() => {
					subscriber.alive = false;
				},
				() => {
					subscriber.alive = false;
				},
			);
			void (async () => {
				for await (const datagram of session.incomingDatagrams()) {
					// First statement of the handler body: the echo dwell starts here.
					const entryNs = process.hrtime.bigint();
					const stamp = decodeStamp(datagram);
					if (stamp === null || stamp.klass !== CLASS_PROBE) continue;
					const state = armState();
					const sendNs = process.hrtime.bigint();
					const hold = Number(sendNs - entryNs);
					state.hold.record(hold);
					const echoed = writeReflection(datagram, {
						echoActualNs: stamp.actualNs,
						serverSendNs: Number(sendNs),
						holdNs: hold,
						klass: CLASS_PROBE_ECHO,
						sequence: stamp.sequence,
						arm: ARM_BYTE[currentArm],
					});
					if (!echoed) continue;
					if (subscriber.send(datagram) === "ok") state.probeEchoes += 1;
				}
			})();
		},
	});
	console.log(
		`bench-g10: listening on ${server.address.port}; fleet ${FLEET}, arms requested ` +
			`${REQUESTED_ARMS.join(",")}, ladder ${LADDER.join(",")}` +
			(SMOKE ? " — SMOKE RUN, never a result" : ""),
	);

	const mirrorEntry = (
		server as unknown as {
			sendDatagramMirror?: (
				targets: string[],
				payload: Uint8Array,
			) => {
				sent: number;
				failures: readonly { index: number; error?: { code?: string } }[];
			};
		}
	).sendDatagramMirror;

	const transport: EmitterTransport = {
		trySend: (target, payload) => {
			const sub = byId.get(target);
			if (!sub || !sub.alive) return "error";
			return sub.send(payload);
		},
		nowNs: () => process.hrtime.bigint(),
		yieldToLoop: () => new Promise<void>((res) => setImmediate(res)),
	};
	if (typeof mirrorEntry === "function") {
		transport.sendMirror = (targets, payload) => {
			const envelope = mirrorEntry.call(server, targets as string[], payload);
			return {
				sent: envelope.sent,
				failures: envelope.failures.map((f) => ({
					index: f.index,
					code: f.error?.code ?? "E_INTERNAL",
				})),
			};
		};
		transport.mirrorCap = DATAGRAM_MIRROR_MAX;
	}

	const resolution = resolveArms(REQUESTED_ARMS, transport);
	for (const warning of resolution.warnings)
		console.warn(`bench-g10: ${warning}`);
	if (resolution.arms.length === 0) {
		throw new Error("bench-g10: every requested arm was dropped");
	}

	writeFileSync(
		OUT_CSV,
		"rate,arm,tMs,phase,windowMs,hostCpuPct,serverCpuPct,rssMb,sessionsActive," +
			"broadcasts,sendOk,sendWouldBlock,sendErrors,stallP99Ms,loopLagP99Ms\n",
	);

	const rungs: unknown[] = [];
	for (const rate of LADDER) {
		rungs.push(await runRung(rate));
		await drain();
	}

	const artifact = {
		gate: "G10",
		registration: "docs/research/preregistrations/gate-g10-broadcast.md",
		smoke: SMOKE,
		offbox: OFFBOX_SSH !== "",
		disclaimer: SMOKE
			? "SMOKE RUN on the harness author's box: not a result, not a rung, not a verdict (prereg §10)"
			: OFFBOX_SSH === ""
				? "co-resident subscribers: a wiring check, never a G10 result (prereg §11a)"
				: null,
		host: { platform: process.platform, cores: navigator.hardwareConcurrency },
		fleet: FLEET,
		payloadBytes: MESSAGE_PAYLOAD_BYTES,
		stampBytes: STAMP_BYTES_V4,
		gateRate: GATE_RATE,
		verdictArm: VERDICT_ARM,
		chunkTargets: A2_CHUNK_TARGETS,
		stallBudgetMs: JS_STALL_BUDGET_MS,
		loopLagSampleMs: LOOP_LAG_SAMPLE_MS,
		armsRequested: REQUESTED_ARMS,
		armsRun: resolution.arms,
		armsDropped: resolution.dropped,
		resolutionWarnings: resolution.warnings,
		mirrorComposed: typeof mirrorEntry === "function",
		preflightRequirements: preflightRequirements(GATE_RATE),
		windowSeconds: WINDOW_SECONDS,
		rungs,
	};
	writeFileSync(OUT_JSON, `${JSON.stringify(artifact, null, 2)}\n`);
	console.log(`bench-g10: wrote ${OUT_JSON}`);
	await server.close();
	killChildren();

	/* ---------------------------------------------------------------------- */

	async function runRung(rate: number): Promise<unknown> {
		arms = resolution.arms.map(freshArm);
		const rungShape = armShape(rate, FLEET);
		console.log(
			`bench-g10: rung R=${rate} — ${rungShape.broadcastEgressPps}/s egress, ` +
				`spread bound ${rungShape.spreadBoundMs.toFixed(2)} ms, wire floor ` +
				`${rungShape.serializationMs.toFixed(2)} ms, clause ` +
				`${rungShape.spreadClauseApplies ? "applies" : "N/A (§1.6)"}`,
		);

		const client = SMOKE
			? await startSmokeFleet(server.address.port)
			: spawnSubscribers(rate);
		const pumped = pumpSubscribers(client, (line) => {
			if (line.trim()) console.log(`  [sub] ${line}`);
		});

		await waitForFleet(client);

		const loopLag = new LatencyHistogram();
		const stopSampler = startLoopLagSampler(
			LOOP_LAG_SAMPLE_MS,
			() => process.hrtime.bigint(),
			(s) => loopLag.record(Number(s.lagNs)),
		);

		const kernelBefore = readKernelUdp();
		const startedMs = Date.now();
		const emitter = startEmitter(rate, startedMs);
		const sampler = sample(rate, startedMs);
		await Bun.sleep(WINDOW_SECONDS * 1000);
		emitter.stop();
		sampler.stop();
		const loopTicks = stopSampler();
		const kernelAfter = readKernelUdp();

		if (client.smoke) await client.smoke.stop();
		const report = await pumped;
		const sessionsActive = server.metricsSnapshot().sessionsActive;

		return summarize(
			rate,
			report,
			sessionsActive,
			loopLag,
			loopTicks,
			kernelBefore,
			kernelAfter,
		);
	}

	/**
	 * The fleet barrier. A rung that began before every subscriber existed would
	 * be a smaller fan-out reported as this one, which is exactly what C4 exists
	 * to catch after the fact — so it is also worth refusing to start.
	 */
	async function waitForFleet(client: SpawnedClient): Promise<void> {
		const deadline = Date.now() + ESTABLISH_TIMEOUT_S * 1000;
		let done = false;
		void client.exited.then(() => {
			done = true;
		});
		while (Date.now() < deadline) {
			if (server.metricsSnapshot().sessionsActive >= FLEET) return;
			if (done) break;
			await Bun.sleep(500);
		}
		throw new Error(
			`bench-g10: only ${server.metricsSnapshot().sessionsActive} of ${FLEET} ` +
				"subscribers established; V-M is the falsifier this would have fired",
		);
	}

	function startEmitter(rate: number, startedMs: number): { stop: () => void } {
		const periodMs = 1000 / rate;
		const payload = new Uint8Array(MESSAGE_PAYLOAD_BYTES);
		let sequence = 0;
		let stopped = false;
		let deadlineMs = startedMs + periodMs;
		let inFlight = false;
		// Targets are built once per rung, in fan-out index order, and reused:
		// rebuilding a 10,000-element array five times a second would put an
		// allocation in the arm that the arm is not about (§2.3).
		let targets: string[] = [];
		let targetsAt = 0;

		const tick = async (): Promise<void> => {
			if (stopped) return;
			const nowMs = Date.now();
			const armId = armForElapsed(nowMs - startedMs, resolution.arms, BLOCK_MS);
			currentArm = armId;
			const state = armState();
			if (inFlight) {
				// The previous fan-out has not finished. Skipping is counted, never
				// hidden: C6 reads sendEventsSkipped, and an emitter that queued
				// instead would report a lag it created itself.
				state.sendEventsSkipped += 1;
				deadlineMs += periodMs;
				return;
			}
			// §C6: measured at the scheduler handoff — deadline to the instant the
			// pass begins — and never across a send. That was G3's defect 1.
			state.handoffLag.record(Math.max(0, (nowMs - deadlineMs) * 1e6));
			if (targets.length !== subscribers.length || targetsAt !== state.blocks) {
				targets = subscribers.filter((s) => s.alive).map((s) => s.id);
				targetsAt = state.blocks;
			}
			sequence += 1;
			encodeStamp(payload, {
				intendedNs: Math.round(deadlineMs * 1e6),
				actualNs: Number(process.hrtime.bigint()),
				sequence,
				klass: CLASS_BROADCAST,
				arm: ARM_BYTE[armId],
				version: 4,
			});
			inFlight = true;
			deadlineMs += periodMs;
			let result: BroadcastResult;
			try {
				result = await broadcast(armId, targets, payload, transport);
			} finally {
				inFlight = false;
			}
			state.broadcastsIssued += 1;
			state.sendAttempts += result.attempts;
			state.sendOk += result.ok;
			state.sendWouldBlock += result.wouldBlock;
			state.sendErrors += result.errors;
			state.stall.record(Number(result.stallNs));
		};

		// Aimed at the deadline, re-armed from inside the tick — not a polling
		// interval at some fraction of the period. A poller's handoff lag is its
		// own poll granularity, and C6 reads handoff lag while V-A compares it
		// across arms: an instrument that manufactured tens of milliseconds of
		// lag identically for every arm would make both of those meaningless.
		let timer: ReturnType<typeof setTimeout> | null = null;
		const arm = (): void => {
			if (stopped) return;
			const waitMs = Math.max(0, deadlineMs - Date.now());
			timer = setTimeout(() => {
				void tick().finally(arm);
			}, waitMs);
		};
		arm();
		return {
			stop: () => {
				stopped = true;
				if (timer !== null) clearTimeout(timer);
			},
		};
	}

	function sample(rate: number, startedMs: number): { stop: () => void } {
		let running = true;
		let prevHost = readHostCpu();
		let prevWall = Date.now();
		let prevCpu = serverCpuMs();
		void (async () => {
			while (running) {
				await Bun.sleep(SAMPLE_INTERVAL_MS);
				if (!running) break;
				const nextHost = readHostCpu();
				const host = hostCpuPct(prevHost, nextHost);
				prevHost = nextHost;
				const now = Date.now();
				const cpu = serverCpuMs();
				const windowMs = Math.max(now - prevWall, 1);
				// Windowed, never cumulative: an average since arm start decays with
				// elapsed time and reports a saturated phase as a comfortable one.
				const cpuPct = ((cpu - prevCpu) / windowMs) * 100;
				prevWall = now;
				prevCpu = cpu;
				const state = armState();
				appendFileSync(
					OUT_CSV,
					`${rate},${currentArm},${now - startedMs},steady,${windowMs},` +
						`${host?.toFixed(1) ?? ""},${cpuPct.toFixed(1)},` +
						`${(process.memoryUsage().rss / 1048576).toFixed(1)},` +
						`${server.metricsSnapshot().sessionsActive},` +
						`${state.broadcastsIssued},${state.sendOk},${state.sendWouldBlock},` +
						`${state.sendErrors},${(state.stall.percentile(0.99) / 1e6).toFixed(4)},\n`,
				);
			}
		})();
		return {
			stop: () => {
				running = false;
			},
		};
	}

	function summarize(
		rate: number,
		report: OffboxReport | null,
		sessionsActive: number,
		loopLag: LatencyHistogram,
		loopTicks: number,
		kernelBefore: Record<string, number> | null,
		kernelAfter: Record<string, number> | null,
	): unknown {
		const loopLagP99Ms =
			loopLag.count > 0 ? loopLag.percentile(0.99) / 1e6 : null;
		const vL = loopLagSamplerFalsifier({
			ticksRecorded: loopTicks,
			windowSeconds: WINDOW_SECONDS,
		});
		const perArm = resolution.arms.map((arm) => {
			const state = arms.find((a) => a.arm === arm) as ArmState;
			const offbox = report?.perArm?.[arm] ?? {};
			const stallP99Ms =
				state.stall.count > 0 ? state.stall.percentile(0.99) / 1e6 : null;
			const clauses = [
				evaluateSpreadClause({
					rate,
					subscribers: FLEET,
					spreadP99Ms: offbox.spreadP99Ms ?? null,
					messagesIssued: offbox.messagesIssued ?? state.broadcastsIssued,
					messagesComplete: offbox.messagesComplete ?? 0,
				}),
				evaluateFleetDelivery({
					received: offbox.received ?? 0,
					messagesIssued: offbox.messagesIssued ?? state.broadcastsIssued,
					subscribers: FLEET,
					subscribersMeetingFloor: offbox.subscribersMeetingFloor ?? 0,
					worstSubscriberRatio: offbox.worstSubscriberRatio ?? null,
				}),
				evaluatePerSubscriberDelivery({
					received: offbox.received ?? 0,
					messagesIssued: offbox.messagesIssued ?? state.broadcastsIssued,
					subscribers: FLEET,
					subscribersMeetingFloor: offbox.subscribersMeetingFloor ?? 0,
					worstSubscriberRatio: offbox.worstSubscriberRatio ?? null,
				}),
				evaluateRtt({
					rttP99Ms: offbox.rttP99Ms ?? null,
					holdP99Ms:
						state.hold.count > 0 ? state.hold.percentile(0.99) / 1e6 : null,
				}),
				evaluateLiveness({
					sessionsActiveAtEnd: sessionsActive,
					subscribers: FLEET,
					sessionsLost: Math.max(0, FLEET - sessionsActive),
				}),
				evaluateLedger({
					broadcastsIssued: state.broadcastsIssued,
					subscribers: FLEET,
					sendAttempts: state.sendAttempts,
					// A rejection that arrived after the pass is charged back here,
					// so the ledger closes against what actually happened.
					sendOk: state.sendOk - state.deferredErrors,
					sendWouldBlock: state.sendWouldBlock,
					sendErrors: state.sendErrors + state.deferredErrors,
				}),
				evaluateEmitterHonesty({
					// C6 asks whether the emitter sourced the load it claims: the
					// denominator is what it issued, the numerator what it attempted.
					emitted: state.sendAttempts,
					messagesIssued: state.broadcastsIssued,
					subscribers: FLEET,
					handoffLagP99Ms:
						state.handoffLag.count > 0
							? state.handoffLag.percentile(0.99) / 1e6
							: null,
					sendEventsSkipped: state.sendEventsSkipped,
					sendErrors: state.sendErrors + state.deferredErrors,
					rate,
				}),
				evaluateStall({ arm, passStallP99Ms: stallP99Ms, loopLagP99Ms }),
			];
			return {
				arm,
				blocks:
					blocksPerArm(WINDOW_SECONDS * 1000, resolution.arms, BLOCK_MS).get(
						arm,
					) ?? 0,
				broadcastsIssued: state.broadcastsIssued,
				sendAttempts: state.sendAttempts,
				sendOk: state.sendOk,
				sendWouldBlock: state.sendWouldBlock,
				sendErrors: state.sendErrors,
				sendEventsSkipped: state.sendEventsSkipped,
				deferredErrors: state.deferredErrors,
				probeEchoes: state.probeEchoes,
				stallP99Ms,
				stallHistogram: state.stall.toJson(),
				handoffLagP99Ms:
					state.handoffLag.count > 0
						? state.handoffLag.percentile(0.99) / 1e6
						: null,
				holdP99Ms:
					state.hold.count > 0 ? state.hold.percentile(0.99) / 1e6 : null,
				offbox,
				clauses,
			};
		});

		const vA = armComparabilityFalsifier(
			perArm.map((a) => ({
				arm: a.arm,
				probeLagP99Ms:
					(a.offbox as { probeLagP99Ms?: number }).probeLagP99Ms ?? null,
				emitterLagP99Ms: a.handoffLagP99Ms,
			})),
		);
		const armClauses: ArmClauses[] = perArm.map((a) => ({
			arm: a.arm,
			clauses: a.clauses,
		}));
		const hists = perArm.map((a) => ({
			name: `${a.arm}.stall`,
			count: a.stallHistogram.count,
			recordedTotal: a.stallHistogram.recordedTotal,
			negative: a.stallHistogram.negative,
			deliveredOnPath: a.broadcastsIssued,
			unstamped: 0,
		}));

		return {
			rate,
			shape: armShape(rate, FLEET),
			sessionsActiveAtEnd: sessionsActive,
			loopLag: {
				p99Ms: loopLagP99Ms,
				ticksRecorded: loopTicks,
				histogram: loopLag.toJson(),
				falsifier: vL,
			},
			kernelUdpDelta:
				kernelBefore && kernelAfter
					? Object.fromEntries(
							Object.keys(kernelAfter).map((k) => [
								k,
								(kernelAfter[k] ?? 0) - (kernelBefore[k] ?? 0),
							]),
						)
					: null,
			perArm,
			offboxReport: report,
			falsifiers: {
				"V-A": vA,
				"V-L": vL,
				"V-N": negativeFalsifier(hists),
				"V-K": skewFalsifier(hists),
			},
			lever: leverStatement(
				perArm.map((a) => ({
					arm: a.arm,
					spreadP99Ms:
						(a.offbox as { spreadP99Ms?: number }).spreadP99Ms ?? null,
				})),
				vA.fires,
			),
			mirrorStall: scoreMirrorStallPrediction(
				(() => {
					const a3 = perArm.find((a) => a.arm === "A3");
					return a3
						? {
								arm: "A3" as const,
								passStallP99Ms: a3.stallP99Ms,
								loopLagP99Ms,
							}
						: undefined;
				})(),
				FLEET,
			),
			// Second opinion only. §10 requires the gate agent to recompute every
			// clause from the raw fields above; this is here to disagree with.
			classifierVerdict: gateVerdict(armClauses),
		};
	}

	async function drain(): Promise<void> {
		killChildren("SIGKILL");
		activeChildren.clear();
		subscribers.length = 0;
		byId.clear();
		const deadline = Date.now() + SETTLE_SECONDS * 1000 + 60_000;
		while (Date.now() < deadline) {
			if (server.metricsSnapshot().sessionsActive === 0) break;
			await Bun.sleep(1000);
		}
		await Bun.sleep(SETTLE_SECONDS * 1000);
	}
}

await main();
