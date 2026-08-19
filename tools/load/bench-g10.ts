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
	cellDeadlineMs,
	waitForChildWithDeadline,
} from "./bench-child-deadline.ts";
import {
	type ArmClauses,
	type ArmId,
	armComparabilityFalsifier,
	deadlineFalsifier,
	denominatorFalsifier,
	evaluateEmitterHonesty,
	evaluateFleetDelivery,
	evaluateLedger,
	evaluateLiveness,
	evaluatePerSubscriberDelivery,
	evaluateRtt,
	evaluateSpreadClause,
	evaluateStall,
	gateVerdict,
	generatorFalsifier,
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
	offboxDeadlineSeconds,
	offboxInvocation,
	parseMacgenLine,
} from "./g10-offbox.ts";
import {
	A2_CHUNK_TARGETS,
	armShape,
	DATAGRAM_MIRROR_MAX,
	DELIVERY_FLOOR,
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
	ARM_NONE,
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
/**
 * The candidate SHA the Mac checks out and builds. Required for an off-box run
 * — `mac-generator-entry.sh` refuses without it — and unused when the fleet is
 * co-resident, which is a wiring check rather than a run (§11a).
 */
const CANDIDATE = process.env.G10_CANDIDATE ?? "";
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

/**
 * Smoke affordances, both of which exist to exercise a path the composition
 * would otherwise hide, and neither of which changes anything a run is scored
 * against.
 *
 * `G10_SMOKE_RUST=1` puts the real `broadcast-client` at the far end of a
 * loopback smoke, at the smoke fleet size. Without it a laptop never runs the
 * Rust subscriber role at all, and the wire contract between the two halves of
 * the v4 stamp — and the report shape the conductor parses — would first be
 * exercised on the cable, which is the worst place to find out they disagree.
 *
 * `G10_HIDE_MIRROR=1` makes the conductor behave as though the candidate does
 * not expose `sendDatagramMirror`, which is composition option C (§11.1). With
 * M1 landed on staging the mirror is now always present, so the degradation path
 * — A3 dropped with a warning, `armsRun = ["A1","A2"]`, the run continuing —
 * would otherwise be untestable end to end on this branch.
 */
const SMOKE_RUST = SMOKE && process.env.G10_SMOKE_RUST === "1";
const HIDE_MIRROR = process.env.G10_HIDE_MIRROR === "1";

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

/**
 * What `crates/reference/src/broadcast_client.rs` prints, and the one field it
 * deliberately does not.
 *
 * `messagesIssued` is absent by design. The subscriber role cannot know it — a
 * broadcast no subscriber received leaves no trace on the Mac — and reporting
 * the sequences it happened to see would turn a total delivery failure into a
 * completeness success. The emitter's own `broadcastsIssued` is the denominator,
 * and the field stays optional so that it is used.
 *
 * `subscriberReceivedCounts` is the *distribution* of per-subscriber receive
 * counts (`{"<received>": <subscribers>}`, every session present including the
 * ones that got nothing). C2b is divided here rather than there, against the
 * count the emitter issued, for the same reason.
 */
type OffboxArmReport = {
	messagesIssued?: number;
	messagesObserved?: number;
	messagesComplete?: number;
	received?: number;
	spreadP99Ms?: number | null;
	spreadHistogram?: HistogramFragment;
	rttP99Ms?: number | null;
	rttHistogram?: HistogramFragment;
	probeEchoes?: number;
	probeLagP99Ms?: number | null;
	probeLagHistogram?: HistogramFragment;
	offeredRatio?: number;
	subscriberReceivedCounts?: Record<string, number>;
	subscribersMeetingFloor?: number;
	worstSubscriberRatio?: number;
	negativeSamples?: number;
};

type HistogramFragment = {
	count?: number;
	recordedTotal?: number;
	negative?: number;
};

type OffboxReport = {
	sessions?: number;
	sessionsFailed?: number;
	sessionsLost?: number;
	sessionsAliveAtEnd?: number;
	undecodable?: number;
	sequenceOverflow?: number;
	unattributedReceived?: number;
	probeSent?: number;
	probeIntended?: number;
	offeredRatio?: number | null;
	/** Smoke path only. Never a rung, never a clause input beyond delivery. */
	smokeDelivery?: { received: number; unstamped: number; subscribers: number };
	perArm?: Record<string, OffboxArmReport>;
};

/**
 * C2b's two numbers, computed here from the Mac's distribution and the emitter's
 * own issue count — never from a ratio the far end divided for us.
 */
function perSubscriberDelivery(
	counts: Record<string, number> | undefined,
	messagesIssued: number,
	subscribers: number,
): { subscribersMeetingFloor: number; worstSubscriberRatio: number | null } {
	if (!counts || messagesIssued <= 0) {
		return { subscribersMeetingFloor: 0, worstSubscriberRatio: null };
	}
	let meeting = 0;
	let worst: number | null = null;
	let reported = 0;
	for (const [received, sessions] of Object.entries(counts)) {
		const ratio = Number(received) / messagesIssued;
		reported += sessions;
		if (ratio >= DELIVERY_FLOOR) meeting += sessions;
		if (worst === null || ratio < worst) worst = ratio;
	}
	// A subscriber missing from the distribution is a subscriber that cannot
	// fail C2b, which is the defect the clause exists for. Absent sessions are
	// counted as having received nothing.
	if (reported < subscribers) worst = 0;
	return { subscribersMeetingFloor: meeting, worstSubscriberRatio: worst };
}

/** A histogram fragment the far end wrote, in the shape the falsifiers read. */
function offboxHistogramFacts(
	name: string,
	fragment: HistogramFragment | undefined,
	deliveredOnPath: number,
): {
	name: string;
	count: number;
	recordedTotal: number;
	negative: number;
	deliveredOnPath: number;
	unstamped: number;
} | null {
	if (!fragment) return null;
	return {
		name,
		count: fragment.count ?? 0,
		recordedTotal: fragment.recordedTotal ?? 0,
		negative: fragment.negative ?? 0,
		deliveredOnPath,
		unstamped: 0,
	};
}

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
function spawnSubscribers(rate: number, port: number): SpawnedClient {
	const { cmd, args: cmdArgs } = offboxInvocation({
		ssh: OFFBOX_SSH,
		candidate: CANDIDATE,
		deadlineSeconds: offboxDeadlineSeconds(WINDOW_SECONDS, ESTABLISH_TIMEOUT_S),
		localBin: CLIENT_BIN,
		subscriber: {
			url: `https://${OFFBOX_SSH ? SERVER_ADDRESS : "127.0.0.1"}:${OFFBOX_SSH ? PORT : port}`,
			sessions: FLEET,
			probeCohort: SMOKE ? Math.min(PROBE_COHORT, FLEET) : PROBE_COHORT,
			probeHz: PROBE_HZ,
			payloadBytes: MESSAGE_PAYLOAD_BYTES,
			rate,
			seconds: WINDOW_SECONDS,
		},
	});
	const child = spawn(cmd, [...cmdArgs], {
		cwd: ROOT,
		// stderr is inherited, not piped: a piped stderr nobody drains fills its
		// 64 KB buffer, ssh then cannot flush the remote's stderr, never exits,
		// and the conductor waits on an exit that cannot come — every rung
		// breached its deadline with a perfectly healthy child before this.
		stdio: ["ignore", "pipe", "inherit"],
		detached: true,
	});
	activeChildren.add(child);
	const exited = new Promise<number>((res) => {
		child.on("exit", (code, signal) => res(code ?? (signal ? 128 : -1)));
		child.on("error", () => res(-1));
	});
	return { child, exited };
}

/** Provenance the entry script prints: which tree the Mac's generator came from. */
const macgen: Record<string, string> = {};

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
			Object.assign(macgen, parseMacgenLine(line) ?? {});
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

	if (!SMOKE || SMOKE_RUST) {
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
	/**
	 * The arm byte the server stamps into a probe echo — and `ARM_NONE` whenever
	 * no arm is emitting.
	 *
	 * It is deliberately not `ARM_BYTE[currentArm]`. Probes keep their grid
	 * running through the establish ramp and the drain grace, and an echo taken
	 * while nothing is broadcasting is an RTT measured under no load. Attributing
	 * those to whichever arm happened to be last would hand that arm a block of
	 * flattering samples — and V-A compares exactly that percentile across arms.
	 * Unattributed echoes land in the subscriber role`s arm-0 slot, which no
	 * per-arm percentile reads.
	 */
	let echoArmByte: number = ARM_NONE;
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
						arm: echoArmByte,
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

	const mirrorEntry = HIDE_MIRROR
		? undefined
		: (
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
	/** Rates whose subscriber fleet outlived its deadline and was killed. */
	const breachedRates: number[] = [];
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
		candidate: CANDIDATE,
		// Ticket 29's provenance: the Mac builds its own binary, so which tree the
		// generator came from stops being obvious and has to be reported.
		generator: macgen,
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
		// A rung whose fleet had to be killed is a truncated window, and the
		// killing itself quiesces the server — so the fact travels at the top of
		// the artifact as well as inside the rung, where a reader cannot miss it.
		deadlineBreachedRates: breachedRates,
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

		const client =
			SMOKE && !SMOKE_RUST
				? await startSmokeFleet(server.address.port)
				: spawnSubscribers(rate, server.address.port);
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
		// C4 asks how many subscribers were still there **at arm end**, so the
		// snapshot is taken here — before the fleet is asked to go away. Taken
		// after the drain it would read zero on every valid run, which is a
		// clause that always fails rather than a clause.
		const sessionsActive = server.metricsSnapshot().sessionsActive;

		if (client.smoke) await client.smoke.stop();

		// The unbounded wait this gate used to carry. `pumpSubscribers` drains the
		// fleet's stdout and then awaits its exit, so a wedged subscriber wedged
		// the conductor — G7's failure mode, and the one ticket 01 exists to make
		// impossible. The deadline is the pre-registered
		// drive + stagger + settle + margin, measured from the drive window's
		// start; the fleet's own establishment is bounded separately by
		// ESTABLISH_TIMEOUT_S, so the stagger term is zero here.
		const rungDeadlineMs = cellDeadlineMs({
			driveMs: WINDOW_SECONDS * 1000,
			connectStaggerMs: 0,
			settleMaxMs: SETTLE_SECONDS * 1000,
			// The client's printed contract is "window Ns + 10s drain", and then
			// it closes its whole fleet. The 2026-08-19 18:20 gate run measured
			// whole-rung tails of ~7 minutes at fleet 10,000, so the per-session
			// close allowance is 40 ms — set from that run's wall clock, an
			// empirical upper allowance for this rig, not a tuning-to-pass.
			childTailMs: 10_000 + FLEET * 40,
		});
		// A holder rather than a `let`: assigned inside a callback, a plain local
		// reads back as `null` to the narrower and the report would quietly type
		// itself out of existence.
		const pumpedReport: { value: OffboxReport | null } = { value: null };
		const wait = await waitForChildWithDeadline(
			{
				exited: pumped.then((r) => {
					pumpedReport.value = r;
					return 0;
				}),
				// Detached spawn, so this signals the whole process group: an ssh
				// wrapper that outlives its child is the wedge shape this gate is
				// most exposed to.
				kill: (signal) =>
					killChildren(typeof signal === "string" ? signal : "SIGKILL"),
			},
			{
				deadlineMs: Math.max(rungDeadlineMs - (Date.now() - startedMs), 0),
				sampleIntervalMs: 1000,
				onBreach: (phase) =>
					console.error(
						`bench-g10: rung R=${rate} passed its ${(rungDeadlineMs / 1000).toFixed(0)} s deadline — ${phase}; this rung is INVALID`,
					),
			},
		);
		// A killed fleet's partial stdout is a truncated window, not a short rung:
		// reporting its counters would put half a window's delivery beside the
		// flag that says it is not a measurement.
		const report = wait.deadlineBreached ? null : pumpedReport.value;
		if (wait.deadlineBreached) breachedRates.push(rate);

		return summarize(
			rate,
			report,
			sessionsActive,
			loopLag,
			loopTicks,
			kernelBefore,
			kernelAfter,
			wait.deadlineBreached,
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
			echoArmByte = ARM_BYTE[armId];
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
				echoArmByte = ARM_NONE;
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
		deadlineBreached: boolean,
	): unknown {
		const loopLagP99Ms =
			loopLag.count > 0 ? loopLag.percentile(0.99) / 1e6 : null;
		const vL = loopLagSamplerFalsifier({
			ticksRecorded: loopTicks,
			windowSeconds: WINDOW_SECONDS,
		});
		const perArm = resolution.arms.map((arm) => {
			const state = arms.find((a) => a.arm === arm) as ArmState;
			const offbox: OffboxArmReport = report?.perArm?.[arm] ?? {};
			const stallP99Ms =
				state.stall.count > 0 ? state.stall.percentile(0.99) / 1e6 : null;
			// The emitter's own count is the denominator: the far end cannot know
			// how many broadcasts it never received.
			const messagesIssued = offbox.messagesIssued ?? state.broadcastsIssued;
			const perSubscriber = offbox.subscriberReceivedCounts
				? perSubscriberDelivery(
						offbox.subscriberReceivedCounts,
						messagesIssued,
						FLEET,
					)
				: {
						subscribersMeetingFloor: offbox.subscribersMeetingFloor ?? 0,
						worstSubscriberRatio: offbox.worstSubscriberRatio ?? null,
					};
			const delivery = {
				received: offbox.received ?? 0,
				messagesIssued,
				subscribers: FLEET,
				...perSubscriber,
			};
			const clauses = [
				evaluateSpreadClause({
					rate,
					subscribers: FLEET,
					spreadP99Ms: offbox.spreadP99Ms ?? null,
					messagesIssued,
					messagesComplete: offbox.messagesComplete ?? 0,
				}),
				evaluateFleetDelivery(delivery),
				evaluatePerSubscriberDelivery(delivery),
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
				messagesIssued,
				perSubscriber,
				offbox,
				clauses,
			};
		});

		const vA = armComparabilityFalsifier(
			perArm.map((a) => ({
				arm: a.arm,
				probeLagP99Ms: a.offbox.probeLagP99Ms ?? null,
				emitterLagP99Ms: a.handoffLagP99Ms,
			})),
		);
		const armClauses: ArmClauses[] = perArm.map((a) => ({
			arm: a.arm,
			clauses: a.clauses,
		}));
		// V-N, V-K and V-D read *every* histogram this gate takes a percentile
		// from, which includes the two the Mac computed. Reading only the
		// server-side stall histogram would leave the spread — this gate's
		// headline metric — with no denominator check at all.
		const hists = [
			...perArm.map((a) => ({
				name: `${a.arm}.stall`,
				count: a.stallHistogram.count,
				recordedTotal: a.stallHistogram.recordedTotal,
				negative: a.stallHistogram.negative,
				deliveredOnPath: a.broadcastsIssued,
				unstamped: 0,
			})),
			...perArm.flatMap((a) =>
				[
					offboxHistogramFacts(
						`${a.arm}.spread`,
						a.offbox.spreadHistogram,
						a.offbox.messagesComplete ?? 0,
					),
					offboxHistogramFacts(
						`${a.arm}.rtt`,
						a.offbox.rttHistogram,
						a.offbox.probeEchoes ?? 0,
					),
					offboxHistogramFacts(
						`${a.arm}.probeLag`,
						a.offbox.probeLagHistogram,
						// A lag sample exists only for an echo this process matched to
						// its own send, so unmatched echoes are the gap and are
						// disclosed rather than folded in.
						a.offbox.probeLagHistogram?.count ?? 0,
					),
				].filter((h) => h !== null),
			),
		];
		// V-G. The Mac is a new generator host, and the probe grid is the only
		// generator this gate has on it.
		const vG = generatorFalsifier(
			typeof report?.offeredRatio === "number" ? [report.offeredRatio] : [],
		);

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
			deadlineBreached,
			falsifiers: {
				"V-W": deadlineFalsifier(deadlineBreached),
				"V-A": vA,
				"V-L": vL,
				"V-G": vG,
				"V-N": negativeFalsifier(hists),
				"V-K": skewFalsifier(hists),
				"V-D": denominatorFalsifier(hists),
			},
			histograms: hists,
			lever: leverStatement(
				perArm.map((a) => ({
					arm: a.arm,
					spreadP99Ms: a.offbox.spreadP99Ms ?? null,
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
			// clause from the raw fields above; this is here to disagree with. A
			// breached rung has no verdict to offer: killing the fleet stops every
			// counter at once, so its clauses would compute over half a window and
			// the liveness clause would read a server that quiesced because it was
			// emptied.
			classifierVerdict: deadlineBreached
				? {
						verdict: "no-verdict" as const,
						arm: VERDICT_ARM,
						failed: [],
						reason: deadlineFalsifier(true).reason,
					}
				: gateVerdict(armClauses),
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
