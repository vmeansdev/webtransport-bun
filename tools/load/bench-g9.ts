#!/usr/bin/env bun
/**
 * G9's conductor: the request/response server, the server-side accept series,
 * the liveness counter block, and the cell runner.
 *
 * Registration: `docs/research/preregistrations/gate-g9-churn.md`. Rates come
 * from `g9-plan.ts` and verdicts from `g9-classify.ts`, so nothing in this file
 * is a threshold — it offers the registered load and records what happened.
 *
 * Four things here are deliberate, and are why this is not `bench-session-scale`
 * with a shorter session:
 *
 * 1. **The accept series is the server's.** `onSession` timestamps every
 *    established session here, on this process's clock. The client's arrival
 *    pacing is recorded and never read by the rate clause — the four-axes
 *    retraction showed the previous accept figures were Little's law on the
 *    generator's permit pool.
 * 2. **The base cohort is identified server-side**, by whether the session was
 *    established before the churn tier's first arrival. C4 needs the clause
 *    computed over the base cohort alone, and this is the only way to get that
 *    without trusting the client's account of which sessions were which.
 * 3. **The liveness block is sampled at 1 Hz through the whole cell, and again
 *    after a quiet settle.** The drift clause needs a series, not two endpoints,
 *    and the leak clause needs a reading taken after the churn has stopped but
 *    *before* the 60 s idle timeout could tidy the evidence away.
 * 4. **The exchange is a bidirectional stream.** That is what gives the
 *    leaked-handle clause something to leak; a datagram exchange would make it
 *    vacuous.
 *
 * Not a gate on its own: it writes an artifact, and the gate agent recomputes
 * every clause from the raw fields.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateCertForNames } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	ARRIVAL_SHARDS,
	BASE_PAYLOAD_BYTES,
	BASE_PPS_PER_SESSION,
	BASE_SESSIONS,
	type Cell,
	cells,
	EXCHANGE_REQUEST_BYTES,
	EXCHANGE_RESPONSE_BYTES,
	generatorAbortCeiling,
	RAMP_SEC,
	SETTLE_SEC,
	SOURCE_ENDPOINTS,
} from "./g9-plan.ts";
import { decodeStamp } from "./latency-stamp.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/churn-client`;
const PORT = Number.parseInt(process.env.G9_PORT ?? "4433", 10);
const HAS_PROC = process.platform === "linux";

const CELL_FILTER = (process.env.G9_CELLS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const RAMP = Number.parseInt(process.env.G9_RAMP_SECONDS ?? `${RAMP_SEC}`, 10);
const SETTLE = Number.parseInt(
	process.env.G9_SETTLE_SECONDS ?? `${SETTLE_SEC}`,
	10,
);
const SAMPLE_MS = Number.parseInt(process.env.G9_SAMPLE_MS ?? "1000", 10);
const BIND_PREFIX = process.env.G9_BIND_PREFIX ?? "127.0";
/**
 * The generator host. Empty means co-resident, which the registration registers
 * as the fallback whose result is labelled a **lower bound** — never as a clean
 * capability number.
 */
const OFFBOX_SSH = process.env.G9_OFFBOX_SSH ?? "";
const SERVER_ADDRESS = process.env.G9_SERVER_ADDRESS ?? "127.0.0.1";
const OUT_JSON = process.env.G9_OUT ?? join(ROOT, "tools/load/bench-g9.json");
const OUT_CSV = OUT_JSON.replace(/\.json$/, ".csv");

/* -------------------------------------------------------------------------- */
/* Host taps — null when unreadable, and never a zero (V-K)                   */
/* -------------------------------------------------------------------------- */

type CpuSnapshot = { busy: number; total: number };

function readHostCpu(): CpuSnapshot | null {
	if (!HAS_PROC) return null;
	try {
		const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
		const fields = line.trim().split(/\s+/).slice(1).map(Number);
		const total = fields.reduce((a, b) => a + b, 0);
		const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
		return { busy: total - idle, total };
	} catch {
		return null;
	}
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

/**
 * Per-socket drop counter for the bench port. Returns null when it could not be
 * read — "we saw no drops" and "we could not look" are different statements, and
 * V-K voids a run that confuses them.
 */
function readServerSocketDrops(): number | null {
	if (!HAS_PROC) return null;
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
			const port = Number.parseInt(local.split(":")[1] ?? "", 16);
			if (port !== PORT) continue;
			const d = Number(cols[cols.length - 1]);
			if (Number.isFinite(d)) drops = (drops ?? 0) + d;
		}
	}
	return drops;
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

type ClientRun = { exitCode: number; report: Record<string, unknown> | null };

function runClient(args: string[]): Promise<ClientRun> {
	const [cmd, argv] = OFFBOX_SSH
		? (["ssh", [OFFBOX_SSH, [CLIENT_BIN, ...args].join(" ")]] as const)
		: ([CLIENT_BIN, args] as const);
	return new Promise((resolve) => {
		const child = spawn(cmd, argv as string[], {
			stdio: ["ignore", "pipe", "inherit"],
			detached: true,
		});
		activeChildren.add(child);
		let out = "";
		child.stdout?.on("data", (d) => {
			out += String(d);
		});
		child.on("close", (code) => {
			activeChildren.delete(child);
			const line = out.split("\n").find((l) => l.startsWith("CHURN_REPORT "));
			let report: Record<string, unknown> | null = null;
			if (line) {
				try {
					report = JSON.parse(line.slice("CHURN_REPORT ".length));
				} catch {
					report = null;
				}
			}
			resolve({ exitCode: code ?? -1, report });
		});
	});
}

/* -------------------------------------------------------------------------- */
/* The server                                                                  */
/* -------------------------------------------------------------------------- */

type CohortSession = {
	acceptedAtMs: number;
	/** Established before the churn tier's first arrival — the base cohort. */
	isBase: boolean;
	alive: boolean;
};

type ServerState = {
	/** One entry per established session, on the server's own clock. */
	acceptSeries: number[];
	sessions: CohortSession[];
	/** Server-side instant the churn tier's first arrival landed. */
	churnStartMs: number | null;
	baseRx: number;
	baseEchoErrors: number;
	streamsAccepted: number;
	streamsCompleted: number;
	streamErrors: number;
	requestBytesRead: number;
	responseBytesWritten: number;
};

function freshState(): ServerState {
	return {
		acceptSeries: [],
		sessions: [],
		churnStartMs: null,
		baseRx: 0,
		baseEchoErrors: 0,
		streamsAccepted: 0,
		streamsCompleted: 0,
		streamErrors: 0,
		requestBytesRead: 0,
		responseBytesWritten: 0,
	};
}

type LivenessSample = {
	tMs: number;
	sessionsActive: number;
	handshakesInFlight: number;
	registryEntries: number | null;
	trackedTasks: number | null;
	rateLimitEntries: number | null;
	bidiHandlesLive: number | null;
	uniSendHandlesLive: number | null;
	uniRecvHandlesLive: number | null;
	asyncOpsPending: number | null;
	closedByIdle: number | null;
	closedByReap: number | null;
	closedOther: number | null;
	limitExceeded: number;
	rateLimited: number;
	hostCpuPct: number | null;
	serverRssMb: number;
	/**
	 * Anonymous + swap, the charged metric this effort settled on. Reported as a
	 * disclosure: 72,000 sessions pass through a cell and per-session retention
	 * would show here long before it showed anywhere else.
	 */
	serverCommittedMb: number | null;
	serverSocketDrops: number | null;
	/** False when the tap could not be read, so V-K can tell the two apart. */
	socketDropsRead: boolean;
};

function startServer(_cell: Cell) {
	// The cable run reaches the server by IP, so the certificate has to name it.
	const tls = generateCertForNames(["localhost", "127.0.0.1", SERVER_ADDRESS]);
	if (tls === null)
		throw new Error("bench-g9: could not generate a certificate");
	const state = freshState();
	const response = new Uint8Array(EXCHANGE_RESPONSE_BYTES);

	const server = createServer({
		port: PORT,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		// The shipped limits and the shipped rate limits, untouched. G9's whole
		// ladder is derived FROM them (§1.6), so raising one here would move the
		// ceiling the gate is measuring against.
		onSession: (session) => {
			const acceptedAtMs = Date.now();
			state.acceptSeries.push(acceptedAtMs);
			const isBase =
				state.churnStartMs === null || acceptedAtMs < state.churnStartMs;
			const entry: CohortSession = { acceptedAtMs, isBase, alive: true };
			state.sessions.push(entry);
			const markDead = () => {
				entry.alive = false;
			};
			session.closed.then(markDead, markDead);

			// The base tier's echo. The payload goes back **byte for byte**, and
			// deliberately does not use `writeReflection`: that helper overwrites
			// `actual` with the server's send instant, which is the one field the
			// client's round trip is measured against. Echoing verbatim keeps both
			// ends of the span on the client's single monotonic clock, which is
			// the only kind of latency statement an off-box generator can make.
			void (async () => {
				try {
					for await (const datagram of session.incomingDatagrams()) {
						state.baseRx += 1;
						if (decodeStamp(datagram) === null) continue;
						try {
							session.sendDatagram(datagram);
						} catch {
							state.baseEchoErrors += 1;
						}
					}
				} catch {
					// Session ended; the cohort entry already records it.
				}
			})();

			// The churn tier's exchange.
			void (async () => {
				try {
					for await (const stream of session.incomingBidirectionalStreams) {
						state.streamsAccepted += 1;
						void handleExchange(stream, state, response);
					}
				} catch {
					state.streamErrors += 1;
				}
			})();
		},
	});
	return { server, state };
}

async function handleExchange(
	stream: {
		readable: ReadableStream<Uint8Array>;
		writable: WritableStream<Uint8Array>;
	},
	state: ServerState,
	response: Uint8Array,
): Promise<void> {
	try {
		const reader = stream.readable.getReader();
		let read = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value) read += value.byteLength;
		}
		state.requestBytesRead += read;
		const writer = stream.writable.getWriter();
		await writer.write(response);
		await writer.close();
		state.responseBytesWritten += response.byteLength;
		state.streamsCompleted += 1;
	} catch {
		state.streamErrors += 1;
	}
}

/* -------------------------------------------------------------------------- */
/* One cell                                                                    */
/* -------------------------------------------------------------------------- */

function sampleLiveness(
	server: { metricsSnapshot: () => Record<string, unknown> },
	prevCpu: CpuSnapshot | null,
): { sample: LivenessSample; cpu: CpuSnapshot | null } {
	const m = server.metricsSnapshot() as Record<string, number | undefined>;
	const cpu = readHostCpu();
	const drops = readServerSocketDrops();
	const num = (v: number | undefined): number | null =>
		typeof v === "number" ? v : null;
	return {
		cpu,
		sample: {
			tMs: Date.now(),
			sessionsActive: m.sessionsActive ?? 0,
			handshakesInFlight: m.handshakesInFlight ?? 0,
			registryEntries: num(m.nativeSessionRegistryEntries),
			trackedTasks: num(m.nativeTrackedTasks),
			rateLimitEntries: num(m.nativeRateLimitEntries),
			bidiHandlesLive: num(m.nativeBidiHandlesLive),
			uniSendHandlesLive: num(m.nativeUniSendHandlesLive),
			uniRecvHandlesLive: num(m.nativeUniRecvHandlesLive),
			asyncOpsPending: num(m.nativeAsyncOpsPending),
			closedByIdle: num(m.sessionsClosedByIdle),
			closedByReap: num(m.sessionsClosedByReap),
			closedOther: num(m.sessionsClosedOther),
			limitExceeded: m.limitExceededCount ?? 0,
			rateLimited: m.rateLimitedCount ?? 0,
			hostCpuPct: hostCpuPct(prevCpu, cpu),
			serverRssMb: process.memoryUsage.rss() / 1024 / 1024,
			serverCommittedMb: (() => {
				const anon = procStatusKb("/proc/self/status", "RssAnon:");
				const swap = procStatusKb("/proc/self/status", "VmSwap:");
				return anon === null ? null : (anon + (swap ?? 0)) / 1024;
			})(),
			serverSocketDrops: drops,
			socketDropsRead: drops !== null,
		},
	};
}

/**
 * Least-squares slope of a series, in units per second. C5 part 5 reads it; a
 * series that is flat or falling produces a slope at or below zero and the
 * clause clamps rather than counting it as a leak.
 */
export function leastSquaresSlopePerSec(
	points: { tMs: number; value: number }[],
): number | null {
	if (points.length < 3) return null;
	const t0 = points[0]?.tMs ?? 0;
	const xs = points.map((p) => (p.tMs - t0) / 1000);
	const ys = points.map((p) => p.value);
	const n = xs.length;
	const meanX = xs.reduce((a, b) => a + b, 0) / n;
	const meanY = ys.reduce((a, b) => a + b, 0) / n;
	let num = 0;
	let den = 0;
	for (let i = 0; i < n; i += 1) {
		const dx = (xs[i] as number) - meanX;
		num += dx * ((ys[i] as number) - meanY);
		den += dx * dx;
	}
	return den === 0 ? null : num / den;
}

/** Accepts per second, keyed by the server's own clock. */
export function acceptSeriesPerSecond(
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

async function runCell(cell: Cell, repeat: number) {
	const { server, state } = startServer(cell);
	const samples: LivenessSample[] = [];
	let prevCpu = readHostCpu();
	const sampler = setInterval(() => {
		const { sample, cpu } = sampleLiveness(
			server as unknown as { metricsSnapshot: () => Record<string, unknown> },
			prevCpu,
		);
		prevCpu = cpu;
		samples.push(sample);
	}, SAMPLE_MS);

	const url = `https://${SERVER_ADDRESS}:${PORT}`;
	const shared = [
		"--url",
		url,
		"--bind-prefix",
		BIND_PREFIX,
		"--ramp-secs",
		String(RAMP),
		"--steady-secs",
		String(cell.windowSec),
		"--settle-secs",
		String(SETTLE),
	];

	// The base run is held separately and awaited LAST. Awaiting it alongside the
	// churn run would put the settle sample after the base tier had already
	// closed its sessions, and then C5's `registryEntries == baseSessions` and
	// C4's lost-session count would both be reading an empty server. The local
	// smoke caught exactly that.
	let baseRun: Promise<ClientRun> | null = null;
	const runs: Promise<ClientRun>[] = [];
	if (cell.baseSessions > 0) {
		baseRun = runClient([
			...shared,
			"--role",
			"base",
			"--source-endpoints",
			String(cell.sourceEndpoints),
			"--base-sessions",
			String(cell.baseSessions),
			"--base-interval-ms",
			String(1000 / BASE_PPS_PER_SESSION),
			"--base-payload-bytes",
			String(BASE_PAYLOAD_BYTES),
		]);
	}
	if (cell.churnRatePerSec > 0) {
		// The churn tier's first arrival is what separates the base cohort from
		// the churn cohort, server-side. Two G9-02 stamp defects lived on this
		// boundary and both are fixed here:
		//
		//  * D-A (cohort inflation): the old marker fired one ramp window after
		//    spawn, but the churn clock issues arrivals at full rate from its
		//    first second — everything it connected in that window was
		//    misclassified as base (2,232–17,828 phantom cohort members in the
		//    G9-02 artifact). The marker now lands at churn spawn, which every
		//    churn accept necessarily follows.
		//  * F-1 (admission collision): the base fleet's size sits exactly on
		//    the shipped max_handshakes_in_flight, so churn dials overlapping
		//    the base ramp bounced a base connect. The churn client now spawns
		//    only after the server has accepted the full base population (or a
		//    20 s cap expires — a base that cannot establish is V-B's finding,
		//    and the cap keeps this wait from hiding it).
		if (cell.baseSessions > 0) {
			const establishedBy = Date.now() + 20_000;
			while (
				state.acceptSeries.length < cell.baseSessions &&
				Date.now() < establishedBy
			) {
				await new Promise((r) => setTimeout(r, 100));
			}
		}
		state.churnStartMs = Date.now();
		runs.push(
			runClient([
				...shared,
				"--role",
				"churn",
				"--source-endpoints",
				String(cell.sourceEndpoints),
				"--churn-rate",
				String(cell.churnRatePerSec),
				"--arrival-shards",
				String(ARRIVAL_SHARDS),
				"--request-bytes",
				String(EXCHANGE_REQUEST_BYTES),
				"--response-bytes",
				String(EXCHANGE_RESPONSE_BYTES),
				"--abort-ceiling",
				String(generatorAbortCeiling()),
			]),
		);
	}

	const churnResults = await Promise.all(runs);

	// The quiet settle: churn has stopped, the base is still there, and the 60 s
	// idle timeout has not yet had time to tidy anything away. This is where the
	// leak clause reads.
	await new Promise((r) => setTimeout(r, SETTLE * 1000));
	const { sample: settleSample } = sampleLiveness(
		server as unknown as { metricsSnapshot: () => Record<string, unknown> },
		prevCpu,
	);
	// Snapshot the cohort's alive flags AT the settle instant, while the base
	// tier is still connected. The old code filtered `state.sessions` at
	// fragment-assembly time — after `await baseRun`, when the base client had
	// already torn down — so every fragment read aliveAtSettle=0 and
	// lost=cohort against its own settle sample's 199–200 active sessions
	// (G9-02 stamp defect D-A, the read-after-teardown class).
	const baseCohortAliveAtSettleSnapshot = state.sessions.filter(
		(s) => s.isBase && s.alive,
	).length;
	const baseCohortLostAtSettleSnapshot = state.sessions.filter(
		(s) => s.isBase && !s.alive,
	).length;
	clearInterval(sampler);
	const results = baseRun ? [...churnResults, await baseRun] : churnResults;

	const churnReport =
		results.find((r) => r.report?.role === "churn")?.report ?? null;
	const baseReport =
		results.find((r) => r.report?.role === "base")?.report ?? null;

	const gradedFrom = (samples[0]?.tMs ?? Date.now()) + RAMP * 1000;
	const gradedTo = gradedFrom + cell.windowSec * 1000;
	const gradedSamples = samples.filter(
		(s) => s.tMs >= gradedFrom && s.tMs <= gradedTo,
	);
	const acceptsInWindow = state.acceptSeries.filter(
		(t) => t >= gradedFrom && t <= gradedTo,
	).length;

	const fragment = {
		cell: cell.id,
		repeat,
		role: cell.role,
		offeredRatePerSec: cell.churnRatePerSec,
		baseSessions: cell.baseSessions,
		sourceEndpoints: cell.sourceEndpoints,
		steadySec: cell.windowSec,
		rampSec: RAMP,
		settleSec: SETTLE,
		offboxSsh: OFFBOX_SSH === "" ? null : OFFBOX_SSH,
		exitCodes: results.map((r) => r.exitCode),
		/* server-side, and the only source for the rate clause */
		serverAcceptsTotal: state.acceptSeries.length,
		serverAcceptsInSteadyWindow: acceptsInWindow,
		acceptSeriesPerSecond: acceptSeriesPerSecond(state.acceptSeries),
		churnStartMs: state.churnStartMs,
		baseCohortSessions: state.sessions.filter((s) => s.isBase).length,
		baseCohortLost: baseCohortLostAtSettleSnapshot,
		// C5 compares the registry to what the SERVER still holds, not to the
		// configured base size: a generator that could not establish its
		// population is a generator problem (V-B), never a leak. Both cohort
		// counts are the settle-instant snapshots — see D-A above.
		baseCohortAliveAtSettle: baseCohortAliveAtSettleSnapshot,
		configuredBaseSessions: cell.baseSessions,
		serverBaseRx: state.baseRx,
		serverBaseEchoErrors: state.baseEchoErrors,
		serverStreamsAccepted: state.streamsAccepted,
		serverStreamsCompleted: state.streamsCompleted,
		serverStreamErrors: state.streamErrors,
		serverRequestBytesRead: state.requestBytesRead,
		serverResponseBytesWritten: state.responseBytesWritten,
		/* liveness */
		livenessSamples: samples,
		settleSample,
		registrySlopePerSec: leastSquaresSlopePerSec(
			gradedSamples
				.filter((s) => s.registryEntries !== null)
				.map((s) => ({ tMs: s.tMs, value: s.registryEntries as number })),
		),
		handshakesInFlightPeak: samples.reduce(
			(a, s) => Math.max(a, s.handshakesInFlight),
			0,
		),
		sessionsActivePeak: samples.reduce(
			(a, s) => Math.max(a, s.sessionsActive),
			0,
		),
		limitExceededDelta:
			(settleSample.limitExceeded ?? 0) - (samples[0]?.limitExceeded ?? 0),
		rateLimitedDelta:
			(settleSample.rateLimited ?? 0) - (samples[0]?.rateLimited ?? 0),
		hostCpuPctMedian: median(
			gradedSamples
				.map((s) => s.hostCpuPct)
				.filter((v): v is number => v !== null),
		),
		/* client-side, latency and honesty only */
		churnReport,
		baseReport,
	};

	// Ticket 03's terminal contract is the only place `nativeAsyncOpsPending == 0`
	// is a meaningful bar: a *live* session legitimately holds an in-flight N-API
	// read future, so the settle reading (taken with the base tier still up) is a
	// disclosure and this one is the clause. Run 32209051975 stamped exactly this
	// reading at zero.
	// The per-socket drop tap dies with the socket: /proc/net/udp loses the
	// port row the moment `server.close()` returns, so a post-close read is
	// "could not look", not "saw no drops" — and V-K then fires on every cell
	// (stamp D-6). Take the tap's terminal reading while the socket still
	// exists and carry it into the post-close sample.
	const terminalDrops = readServerSocketDrops();
	await server.close();
	const postClose = {
		...sampleLiveness(
			server as unknown as { metricsSnapshot: () => Record<string, unknown> },
			prevCpu,
		).sample,
		serverSocketDrops: terminalDrops,
		socketDropsRead: terminalDrops !== null,
	};
	return { ...fragment, postCloseSample: postClose };
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
	const plan = cells().filter(
		(c) => CELL_FILTER.length === 0 || CELL_FILTER.includes(c.id),
	);
	const fragments = [];
	for (const cell of plan) {
		for (let repeat = 1; repeat <= cell.repeats; repeat += 1) {
			console.log(
				`bench-g9: ${cell.id} repeat ${repeat}/${cell.repeats} — churn ${cell.churnRatePerSec}/s, base ${cell.baseSessions}, ${cell.sourceEndpoints} source endpoint(s)`,
			);
			fragments.push(await runCell(cell, repeat));
		}
	}

	const artifact = {
		gate: "g9-churn",
		registration: "docs/research/preregistrations/gate-g9-churn.md",
		generatedAtIso: new Date().toISOString(),
		offboxSsh: OFFBOX_SSH === "" ? null : OFFBOX_SSH,
		config: {
			port: PORT,
			bindPrefix: BIND_PREFIX,
			sourceEndpoints: SOURCE_ENDPOINTS,
			arrivalShards: ARRIVAL_SHARDS,
			baseSessions: BASE_SESSIONS,
			basePpsPerSession: BASE_PPS_PER_SESSION,
			exchangeRequestBytes: EXCHANGE_REQUEST_BYTES,
			exchangeResponseBytes: EXCHANGE_RESPONSE_BYTES,
			abortCeiling: generatorAbortCeiling(),
			rampSec: RAMP,
			settleSec: SETTLE,
			sampleMs: SAMPLE_MS,
			envDatagramSendSync:
				process.env.WEBTRANSPORT_DATAGRAM_SEND_SYNC ?? "(unset)",
			envDatagramBatch: process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? "(unset)",
			envStreamBatchBytes:
				process.env.WEBTRANSPORT_STREAM_BATCH_BYTES ?? "(unset)",
		},
		fragments,
	};

	const tmp = `${OUT_JSON}.tmp`;
	writeFileSync(tmp, JSON.stringify(artifact, null, 2));
	renameSync(tmp, OUT_JSON);
	writeFileSync(OUT_CSV, toCsv(fragments));
	console.log(`bench-g9: wrote ${OUT_JSON} and ${OUT_CSV}`);
	if (OFFBOX_SSH === "") {
		console.log(
			"bench-g9: WARNING — offboxSsh is null; this is the registered co-resident FALLBACK and its result is a lower bound, never a clean capability number",
		);
	}
}

function toCsv(fragments: Record<string, unknown>[]): string {
	const header = [
		"cell",
		"repeat",
		"offeredRatePerSec",
		"baseSessions",
		"serverAcceptsInSteadyWindow",
		"steadySec",
		"handshakesInFlightPeak",
		"sessionsActivePeak",
		"limitExceededDelta",
		"rateLimitedDelta",
		"hostCpuPctMedian",
		"serverStreamsAccepted",
		"serverStreamsCompleted",
		"serverStreamErrors",
	];
	const rows = fragments.map((f) =>
		header.map((k) => String(f[k] ?? "")).join(","),
	);
	return [header.join(","), ...rows].join("\n");
}

if (import.meta.main) {
	await main();
}
