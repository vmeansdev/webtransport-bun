#!/usr/bin/env bun
/**
 * Latency ladder against the addon server — one *arm* per process.
 *
 * Every earlier bench in this repo reported throughput and delivery ratio and
 * nothing about *when* a datagram arrived. This one measures the interval the
 * H7 batch gate actually trades against: from the load client's send call to the
 * moment the datagram reaches the JavaScript handler body. Both ends read the
 * same `CLOCK_MONOTONIC` counter, so the one-way number is real rather than a
 * differenced round trip.
 *
 * An arm is `(batch knob, arrival profile)`. The batch knob is read once at
 * import by `packages/webtransport`, so it cannot be varied inside a process —
 * hence one process per arm, and `tools/load/latency-classify.ts` to merge them.
 *
 * Method, buckets and STOP conditions are pre-registered in
 * `docs/research/preregistrations/latency.md`. This file implements that
 * document; it does not get to reinterpret it.
 *
 * Single-host caveat, and it is a real one: the load client shares the 4 vCPU
 * with the server, so every percentile here is an *upper bound* on server
 * latency. `scheduleLag` is the client's own queueing, reported separately and
 * wired to the generator-saturation STOP so co-residence cannot masquerade as
 * server tail.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	type GeneratorProvenance,
	parseGeneratorReport,
} from "../offbox/generator-report.ts";
import {
	assertCableHost,
	assertCandidate,
	G2_MACGEN_BIN,
	MACGEN_ENTRY,
	macgenInvocation,
	dataSubnetPrefix,
} from "./g2-offbox.ts";
import { createMonotonicClock } from "./latency-clock.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";
import { decodeStamp, STAMP_BYTES, writeEchoActual } from "./latency-stamp.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;

export type ArrivalProfile = "uniform" | "tick";

const ARM = process.env.LATENCY_ARM ?? "default";
const SESSIONS = parseInt(process.env.LATENCY_SESSIONS ?? "100", 10);
const PAYLOAD_BYTES = parseInt(process.env.LATENCY_PAYLOAD_BYTES ?? "1150", 10);
const STEP_SECONDS = parseInt(process.env.LATENCY_STEP_SECONDS ?? "60", 10);
const SETTLE_MS = parseInt(process.env.LATENCY_SETTLE_MS ?? "10000", 10);
const TICK_HZ = parseInt(process.env.LATENCY_TICK_HZ ?? "64", 10);
const ARRIVAL: ArrivalProfile =
	process.env.LATENCY_ARRIVAL === "tick" ? "tick" : "uniform";
const ECHO = (process.env.LATENCY_ECHO ?? "1") !== "0";
const PORT = parseInt(process.env.LATENCY_PORT ?? "4433", 10);
/** Per-session datagrams/s. Aggregate = this × sessions. */
const RATES = (process.env.LATENCY_RATES ?? "100,250,500,750,900,1100")
	.split(",")
	.map((v) => parseInt(v.trim(), 10))
	.filter((v) => Number.isFinite(v) && v > 0);
const OUT_JSON =
	process.env.LATENCY_OUT ?? join(ROOT, `tools/load/bench-latency-${ARM}.json`);
/**
 * Cell identity in an interleaved dispatch: which rung, which replicate, and
 * where in the dispatch's fixed order this process ran. The conductor sets them;
 * a ladder run leaves them null and the classifier treats the fragment as a
 * ladder fragment. See `docs/research/preregistrations/latency-ab.md`.
 */
const RUNG = process.env.LATENCY_RUNG ?? null;
const REPLICATE = process.env.LATENCY_REPLICATE
	? parseInt(process.env.LATENCY_REPLICATE, 10)
	: null;
const CELL_INDEX = process.env.LATENCY_CELL_INDEX
	? parseInt(process.env.LATENCY_CELL_INDEX, 10)
	: null;
/** The conductor builds `load-client` once for the whole dispatch. */
const SKIP_BUILD = process.env.LATENCY_SKIP_BUILD === "1";

/**
 * Off-box generation. When `LATENCY_OFFBOX_SSH` is set the load client runs on
 * the Mac at the far end of the cable and dials this server over it, which is
 * the whole point of the G2 conversion: the generator stops competing with the
 * server for the same cores.
 *
 * The generator is reached through `tools/offbox/mac-generator-entry.sh`, which
 * builds `load-client` **on the Mac at the candidate SHA** and reports what it
 * built. Nothing is copied to the generator and no remote binary path is named:
 * the retired VM harness scp'd a Linux binary to `/tmp/load-client`, and a path
 * like that survives its run — the next dispatch finds a stale binary from a
 * tree no SHA describes and produces a fine-looking number from it. See
 * `g2-offbox.ts`.
 *
 * The price of moving off-box is that the two ends no longer share
 * `CLOCK_MONOTONIC`, so every cross-host interval this harness normally reports
 * becomes an arbitrary constant plus a latency. Rather than record those and
 * rely on a reader not to quote them, off-box mode does not record them at all —
 * see `OFFBOX` below and the registration, whose classifier asserts the
 * histograms are empty.
 */
const OFFBOX_SSH = (process.env.LATENCY_OFFBOX_SSH ?? "").trim();
const OFFBOX = OFFBOX_SSH.length > 0;
/** This server's address as the generator sees it. The cable, 10.99.0.0/24. */
const OFFBOX_URL_HOST = (process.env.LATENCY_OFFBOX_URL_HOST ?? "").trim();
/** The tree the generator builds. 40 lowercase hex, from `git rev-parse`. */
const OFFBOX_CANDIDATE = (process.env.LATENCY_OFFBOX_CANDIDATE ?? "").trim();
/** Entry-script path on the Mac, relative to the ssh login's cwd. */
const OFFBOX_ENTRY = (process.env.LATENCY_OFFBOX_ENTRY ?? MACGEN_ENTRY).trim();
/**
 * The remote watchdog, in seconds. macOS has no `timeout(1)`; the entry script
 * carries the deadline and reports `exit=watchdog` so a deadline kill stays
 * distinguishable from a load-client failure. The conductor registers the value.
 */
const OFFBOX_DEADLINE_SEC = parseInt(
	process.env.LATENCY_OFFBOX_DEADLINE_SEC ?? "0",
	10,
);

const HAS_PROC = process.platform === "linux";

function serverCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

type CpuSnapshot = { busy: number; total: number };

function readHostCpu(): CpuSnapshot | null {
	if (!HAS_PROC) return null;
	const line = readFileSync("/proc/stat", "utf8").split("\n")[0] ?? "";
	const fields = line.trim().split(/\s+/).slice(1).map(Number);
	const total = fields.reduce((a, b) => a + b, 0);
	const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
	return { busy: total - idle, total };
}

function hostCpuPct(prev: CpuSnapshot | null, next: CpuSnapshot | null) {
	if (!prev || !next || next.total === prev.total) return null;
	return ((next.busy - prev.busy) / (next.total - prev.total)) * 100;
}

/** Per-interface receive counters, keyed by interface name. */
export type NetCounters = Record<
	string,
	{ rxBytes: number; rxPackets: number }
>;

function readNetCounters(): NetCounters | null {
	if (!HAS_PROC) return null;
	const out: NetCounters = {};
	for (const line of readFileSync("/proc/net/dev", "utf8").split("\n")) {
		const m = line.match(/^\s*([^:]+):\s*(\d+)\s+(\d+)/);
		if (!m?.[1]) continue;
		out[m[1].trim()] = {
			rxBytes: Number(m[2]),
			rxPackets: Number(m[3]),
		};
	}
	return out;
}

function netDelta(
	prev: NetCounters | null,
	next: NetCounters | null,
): NetCounters | null {
	if (!prev || !next) return null;
	const out: NetCounters = {};
	for (const [iface, after] of Object.entries(next)) {
		const before = prev[iface];
		if (!before) continue;
		out[iface] = {
			rxBytes: after.rxBytes - before.rxBytes,
			rxPackets: after.rxPackets - before.rxPackets,
		};
	}
	return out;
}

/**
 * Kernel UDP counters. `RcvbufErrors` is the counter T02 used to attribute the
 * 10k session loss; here it separates a drop inside this host from one on the
 * wire, which is the difference between a product miss and a rig disclosure.
 */
export type UdpCounters = {
	inDatagrams: number;
	inErrors: number;
	rcvbufErrors: number;
};

function readUdpCounters(): UdpCounters | null {
	if (!HAS_PROC) return null;
	const lines = readFileSync("/proc/net/snmp", "utf8").split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const header = lines[i] ?? "";
		if (!header.startsWith("Udp:")) continue;
		const names = header.trim().split(/\s+/).slice(1);
		const values = (lines[i + 1] ?? "").trim().split(/\s+/).slice(1);
		const at = (name: string): number => {
			const idx = names.indexOf(name);
			return idx >= 0 ? Number(values[idx] ?? 0) : 0;
		};
		return {
			inDatagrams: at("InDatagrams"),
			inErrors: at("InErrors"),
			rcvbufErrors: at("RcvbufErrors"),
		};
	}
	return null;
}

function udpDelta(
	prev: UdpCounters | null,
	next: UdpCounters | null,
): UdpCounters | null {
	if (!prev || !next) return null;
	return {
		inDatagrams: next.inDatagrams - prev.inDatagrams,
		inErrors: next.inErrors - prev.inErrors,
		rcvbufErrors: next.rcvbufErrors - prev.rcvbufErrors,
	};
}

export type ClientLatencyJson = {
	arrival: string;
	effectiveDatagramsPerSecPerSession: number;
	rtt: LatencyHistogramJson;
	/** Wake lateness of the first datagram in each send event. */
	scheduleLag: LatencyHistogramJson;
	/** First-to-last duration of one send event; zero in the uniform arm. */
	burstSpread: LatencyHistogramJson;
	/** Server echo send instant → this client's receive. The egress leg. */
	egressOneWay: LatencyHistogramJson;
	/** This client's send → the server's echo send: the server's first two legs. */
	upstreamPlusTurnaround: LatencyHistogramJson;
	/** Echoes that came back stamped but with no echo instant to measure from. */
	echoMissingEchoInstant: number;
	echoUnstamped: number;
	ticksSkipped: number;
	sendEvents: number;
	/** Longest window any one session spent offering load, in seconds. */
	driveWindowSec: number;
	/** Mean of the same across sessions that offered any. */
	driveWindowMeanSec: number;
	sessionsDriving: number;
};

export type LatencyStep = {
	/** Effective — what the generator produced. Rungs are labelled by this. */
	perSessionRate: number;
	aggregateRate: number;
	/** What was asked for. Kept so the request and the load stay separable. */
	nominalPerSessionRate: number;
	nominalAggregateRate: number;
	/** Client-process wall clock: spawn to exit, drain excluded. */
	elapsedSec: number;
	/** Window the load was actually offered over — the rate denominator. */
	driveWindowSec: number;
	/** False when the client reported none and the nominal step length stood in. */
	driveWindowMeasured: boolean;
	requestedDatagrams: number;
	clientSent: number;
	clientErr: number;
	clientReceived: number;
	serverRx: number;
	serverStamped: number;
	serverUnstamped: number;
	echoSent: number;
	echoErr: number;
	/** Echoes whose payload could not carry the echo instant — no egress sample. */
	echoStampFailures: number;
	/** Drain grace held open after the client exited, before the snapshot. */
	drainMs: number;
	/** Datagrams that landed during that grace — this step's longest queued. */
	drainArrivals: number;
	upDeliveryRatio: number | null;
	/** Server-side one-way: client send call → JS handler body. */
	ingest: LatencyHistogramJson;
	/** Server-side: JS handler body → the echo's send call. */
	turnaround: LatencyHistogramJson;
	client: ClientLatencyJson | null;
	hostCpuPctMedian: number | null;
	serverCpuPct: number;
	sessionsOk: number;
	sessionsErr: number;
	/**
	 * Where the generator ran, and the marks that prove it (registration §6).
	 * Optional because fragments written before the off-box work exist and are
	 * still read by `latency-classify.ts`; a fragment without it is not off-box.
	 */
	generator?: {
		mode: "onbox" | "offbox";
		ssh: string | null;
		urlHost: string;
		/** Declared data-path /24 prefix, recorded for the classifier's O2. */
		dataSubnetPrefix: string;
		/**
		 * What the Mac reported about the binary it built and ran. Absent on-box,
		 * where the harness spawned the binary itself and already knows. Off-box
		 * it is the only evidence that the generator was the candidate: the Mac
		 * builds its own, so "which tree" is a claim that has to be carried.
		 */
		macgen?: {
			bin: string;
			entry: string;
			candidateAsked: string;
			deadlineSec: number;
			provenance: GeneratorProvenance;
			problems: string[];
		} | null;
	};
	/** Per-interface receive deltas over the client-process window. */
	netRxDelta?: NetCounters | null;
	/** Server-side kernel UDP deltas over the same window. */
	udpDelta?: UdpCounters | null;
};

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

async function main(): Promise<void> {
	if (RATES.length === 0)
		throw new Error("LATENCY_RATES parsed to an empty ladder");
	if (PAYLOAD_BYTES < STAMP_BYTES) {
		throw new Error(
			`LATENCY_PAYLOAD_BYTES must be >= ${STAMP_BYTES} to carry a stamp`,
		);
	}

	if (OFFBOX) {
		// Refusals, not warnings: an off-box arm that quietly falls back to
		// loopback produces a good-looking number and a false claim.
		assertCableHost(OFFBOX_URL_HOST, "LATENCY_OFFBOX_URL_HOST");
		// Mirrored from the entry script so a bad SHA is a sentence here rather
		// than exit 3 inside an ssh channel.
		assertCandidate(OFFBOX_CANDIDATE);
		if (!Number.isFinite(OFFBOX_DEADLINE_SEC) || OFFBOX_DEADLINE_SEC <= 0) {
			throw new Error(
				"LATENCY_OFFBOX_DEADLINE_SEC must be a positive number of seconds — " +
					"macOS has no timeout(1), so the entry script's watchdog is the " +
					"only deadline an off-box cell has",
			);
		}
	}

	const clock = await createMonotonicClock();
	console.log(
		`bench-latency: arm=${ARM} arrival=${ARRIVAL} clock=${clock.source} residual=${clock.calibrationResidualNs.toFixed(0)}ns spread=${clock.calibrationSpreadNs.toFixed(0)}ns batchEnv=${process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? "(default)"}`,
	);

	if (SKIP_BUILD) {
		if (!(await Bun.file(CLIENT_BIN).exists())) {
			throw new Error(
				`LATENCY_SKIP_BUILD=1 but ${CLIENT_BIN} does not exist; build it first`,
			);
		}
	} else {
		console.log("bench-latency: building load-client (release)...");
		try {
			await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();
		} catch (err) {
			if (!(await Bun.file(CLIENT_BIN).exists())) throw err;
			console.warn(
				"bench-latency: cargo build failed; falling back to existing load-client binary",
			);
		}
	}

	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	const ingest = new LatencyHistogram();
	// JS handler entry → the echo's send call. The middle leg of the registered
	// ingest-vs-egress cross-check: with it, `ingest + turnaround + egress` adds
	// up to the client's round trip exactly, per datagram, so the two processes
	// can be checked against each other instead of trusted.
	const turnaround = new LatencyHistogram();
	let serverRx = 0;
	let serverStamped = 0;
	let serverUnstamped = 0;
	let echoSent = 0;
	let echoErr = 0;
	/** Echoes whose payload could not carry the echo instant. */
	let echoStampFailures = 0;

	// The tick arm rounds its per-tick burst up, so the effective rate can exceed
	// the requested one by up to a tick's worth of datagrams per session.
	const aggregatePeak = SESSIONS * (Math.max(...RATES) + TICK_HZ);
	const server = createServer({
		port: PORT,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		limits: {
			maxSessions: SESSIONS + 100,
			maxHandshakesInFlight: SESSIONS + 100,
		},
		rateLimits: {
			handshakesPerSec: Math.max(SESSIONS * 2, 400),
			handshakesBurst: Math.max(SESSIONS * 4, 1000),
			handshakesBurstPerPrefix: Math.max(SESSIONS * 4, 1000),
			streamsPerSec: 1000,
			streamsBurst: 2000,
			// Four times the top ladder step: measure the host, never the limiter.
			datagramsPerSec: aggregatePeak * 4,
			datagramsBurst: aggregatePeak * 8,
		},
		onSession: (session) => {
			void (async () => {
				for await (const datagram of session.incomingDatagrams()) {
					// First statement in the body: everything after this point is
					// the bench's own cost, not the transport's.
					const arrivedNs = clock.now();
					serverRx += 1;
					const stamp = decodeStamp(datagram);
					if (stamp === null) {
						serverUnstamped += 1;
					} else {
						serverStamped += 1;
						// Off-box the stamp's send instant is another machine's
						// counter. There is no ingest interval to compute, so none
						// is computed and the histogram ships empty — a number that
						// does not exist cannot be quoted.
						if (!OFFBOX) ingest.record(arrivedNs - stamp.actualNs);
					}
					if (!ECHO) continue;
					// Stamp the send instant into the payload the client is about
					// to get back, as late as possible before handing it over, so
					// the egress leg the client measures starts here and not
					// somewhere earlier in this function.
					const echoAtNs = clock.now();
					// Turnaround is server-local at both ends and stays valid
					// off-box. Writing the instant into the payload does not: the
					// client would difference it against its own clock and produce
					// two fictional legs. So off-box the instant is measured and
					// not shipped, the client sees no echo instant, and its egress
					// and upstream histograms stay empty by construction.
					if (OFFBOX) {
						turnaround.record(echoAtNs - arrivedNs);
					} else if (writeEchoActual(datagram, echoAtNs)) {
						turnaround.record(echoAtNs - arrivedNs);
					} else {
						echoStampFailures += 1;
					}
					try {
						await session.sendDatagram(datagram);
						echoSent += 1;
					} catch {
						echoErr += 1;
					}
				}
			})().catch(() => {});
		},
	});
	// createServer has no readiness promise; same 3s the other load tools use.
	await Bun.sleep(3000);
	console.log(
		`bench-latency: server up port=${PORT} sessions=${SESSIONS} payload=${PAYLOAD_BYTES}B step=${STEP_SECONDS}s echo=${ECHO} generator=${OFFBOX ? `macgen(${OFFBOX_SSH} bin=${G2_MACGEN_BIN} candidate=${OFFBOX_CANDIDATE.slice(0, 12)} -> ${OFFBOX_URL_HOST} deadline=${OFFBOX_DEADLINE_SEC}s)` : "onbox"} ladder=[${RATES.join(",")}]/s/session`,
	);

	const steps: LatencyStep[] = [];
	for (const [index, rate] of RATES.entries()) {
		const nominalAggregate = SESSIONS * rate;
		console.log(
			`bench-latency: step ${index + 1}/${RATES.length} requesting rate=${rate}/s/session aggregate=${nominalAggregate}/s`,
		);
		ingest.reset();
		turnaround.reset();
		const stampFailures0 = echoStampFailures;
		const rx0 = serverRx;
		const stamped0 = serverStamped;
		const unstamped0 = serverUnstamped;
		const echo0 = echoSent;
		const echoErr0 = echoErr;
		const cpuMs0 = serverCpuMs();
		const net0 = readNetCounters();
		const udp0 = readUdpCounters();
		const startedAt = Date.now();

		if (OFFBOX) {
			// A straggler from an earlier cell would share the generator with this
			// one and land in its schedule lag.
			Bun.spawnSync([
				"ssh",
				"-o",
				"BatchMode=yes",
				OFFBOX_SSH,
				"pkill",
				"-x",
				"load-client",
			]);
		}

		const clientArgs = [
			"--url",
			`https://${OFFBOX ? OFFBOX_URL_HOST : "127.0.0.1"}:${PORT}`,
			"--mode",
			"load",
			"--skip-probes",
			"--latency-stamp",
			"--arrival",
			ARRIVAL,
			"--tick-hz",
			String(TICK_HZ),
			"--sessions",
			String(SESSIONS),
			"--duration",
			String(STEP_SECONDS),
			"--datagrams-per-sec",
			String(rate),
			"--streams-per-sec",
			"0",
			"--payload-bytes",
			String(PAYLOAD_BYTES),
			// Measurement run: the ladder must climb past the knee, not exit at it.
			"--max-session-errors",
			String(SESSIONS),
			"--max-datagram-errors",
			"1000000000",
			"--max-stream-errors",
			"1000000000",
		];
		// A dead ssh channel must not orphan a remote generator, so the remote
		// process carries its own deadline — the entry script's watchdog, since
		// macOS has no `timeout(1)` for the VM-era invocation to have used.
		const invocation = macgenInvocation({
			ssh: OFFBOX ? OFFBOX_SSH : "",
			candidate: OFFBOX_CANDIDATE,
			deadlineSeconds: OFFBOX_DEADLINE_SEC,
			localBin: CLIENT_BIN,
			clientArgs,
			bin: G2_MACGEN_BIN,
			entry: OFFBOX_ENTRY,
		});
		const argv = [invocation.cmd, ...invocation.args];
		const child = Bun.spawn(argv, {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdoutPromise = new Response(child.stdout).text();
		const stderrPromise = new Response(child.stderr).text();

		const hostSamples: number[] = [];
		let prevHost = readHostCpu();
		let done = false;
		const exited = child.exited.then(() => {
			done = true;
		});
		while (!done) {
			await Promise.race([exited, Bun.sleep(5000)]);
			const nextHost = readHostCpu();
			const host = hostCpuPct(prevHost, nextHost);
			prevHost = nextHost;
			if (host !== null) hostSamples.push(host);
		}

		const exitCode = await child.exited;
		const stdout = await stdoutPromise;
		const stderr = await stderrPromise;
		const elapsedSec = (Date.now() - startedAt) / 1000;
		const cpuMsAtClientExit = serverCpuMs();
		const rxAtClientExit = serverRx;
		// Read the kernel taps at client exit, over the same window the rates
		// use: the drain that follows is idle and would dilute them.
		const netRxDelta = netDelta(net0, readNetCounters());
		const udpRxDelta = udpDelta(udp0, readUdpCounters());

		// Drain grace, spent before the step is snapshotted rather than after.
		// Datagrams still in flight when the client process exits are this step's
		// — and they are the ones that queued longest, which is the tail this axis
		// exists to measure. Reading the histogram at client exit truncated
		// exactly that tail, and the reset at the top of the next step then threw
		// the late arrivals away. The settle window between steps is the same
		// 10 s; it is now on the useful side of the snapshot.
		await Bun.sleep(SETTLE_MS);

		// One snapshot, taken here, used by both the artifact and the console
		// line. The server keeps running between these statements, so reading the
		// live histogram twice — once into the JSON and once for the log — printed
		// a p99 the artifact does not contain, and the counters read one at a time
		// could disagree with each other about the same step.
		const drainArrivals = serverRx - rxAtClientExit;
		const ingestJson = ingest.toJson();
		const turnaroundJson = turnaround.toJson();
		const stampFailuresTotal = echoStampFailures;
		const rxTotal = serverRx;
		const stampedTotal = serverStamped;
		const unstampedTotal = serverUnstamped;
		const echoTotal = echoSent;
		const echoErrTotal = echoErr;

		const num = (re: RegExp): number => {
			const m = stdout.match(re);
			return m?.[1] ? parseInt(m[1], 10) : 0;
		};
		const sessionsOk = num(/sessions ok=(\d+)/);
		// Off-box, everything the on-box harness got for free — which binary,
		// which tree, which host — arrives as text on a pipe or not at all.
		const report = OFFBOX
			? parseGeneratorReport(stdout, OFFBOX_CANDIDATE)
			: null;
		if (report && report.problems.length > 0) {
			console.warn(
				`bench-latency: step ${index + 1} generator problems: ${report.problems.join("; ")}`,
			);
		}
		if (exitCode !== 0 && sessionsOk === 0) {
			console.error(stderr.slice(-2000));
			throw new Error(
				`step ${index + 1}: load-client exited ${exitCode} with no successful sessions`,
			);
		}

		let client: ClientLatencyJson | null = null;
		const latencyLine = stdout.match(/load-client: latency-json (\{.*\})/);
		if (latencyLine?.[1]) {
			client = JSON.parse(latencyLine[1]) as ClientLatencyJson;
		} else {
			console.warn(
				`bench-latency: step ${index + 1} produced no client latency-json`,
			);
		}

		// The rung is labelled by what the generator can actually produce, never
		// by what was asked for. The tick arm sends `round(rate / tickHz)`
		// datagrams per tick, so a requested 100/s/session at 64 Hz is really
		// 128/s/session — a 28% mislabel if the request is used as the label.
		// The uniform arm quantizes too, by well under a datagram per second.
		const effectivePerSessionRate =
			client?.effectiveDatagramsPerSecPerSession ?? rate;
		const aggregate = Math.round(SESSIONS * effectivePerSessionRate);

		// Requested volume is the registered session count times the effective
		// rate times the window the load was actually offered over — never the
		// nominal step length. The client process spends time connecting,
		// staggering and joining that it does not spend sending, so
		// `STEP_SECONDS` overstated the request, and a step cut short was judged
		// against load it was never given time to send. Sessions that never
		// connected drive nothing and stay in the multiplier, so they still show
		// up as the shortfall they are.
		const measuredWindow = client?.sessionsDriving
			? client.driveWindowSec
			: null;
		if (measuredWindow === null) {
			console.warn(
				`bench-latency: step ${index + 1} reported no drive window; falling back to the nominal ${STEP_SECONDS}s`,
			);
		}
		const driveWindowSec = measuredWindow ?? STEP_SECONDS;

		const step: LatencyStep = {
			perSessionRate: effectivePerSessionRate,
			aggregateRate: aggregate,
			nominalPerSessionRate: rate,
			nominalAggregateRate: nominalAggregate,
			elapsedSec,
			driveWindowSec,
			driveWindowMeasured: measuredWindow !== null,
			requestedDatagrams: Math.round(aggregate * driveWindowSec),
			clientSent: num(/datagrams sent=(\d+)/),
			clientErr: num(/datagrams sent=\d+ err=(\d+)/),
			clientReceived: num(/datagrams received=(\d+)/),
			serverRx: rxTotal - rx0,
			serverStamped: stampedTotal - stamped0,
			serverUnstamped: unstampedTotal - unstamped0,
			echoSent: echoTotal - echo0,
			echoErr: echoErrTotal - echoErr0,
			echoStampFailures: stampFailuresTotal - stampFailures0,
			drainMs: SETTLE_MS,
			drainArrivals,
			upDeliveryRatio: null,
			ingest: ingestJson,
			turnaround: turnaroundJson,
			client,
			hostCpuPctMedian: median(hostSamples),
			// Over the client-process window only: the drain that follows it is
			// idle and would dilute the rate it is supposed to report.
			serverCpuPct:
				((cpuMsAtClientExit - cpuMs0) / Math.max(elapsedSec * 1000, 1)) * 100,
			sessionsOk,
			sessionsErr: num(/sessions ok=\d+ err=(\d+)/),
			generator: {
				mode: OFFBOX ? "offbox" : "onbox",
				ssh: OFFBOX ? OFFBOX_SSH : null,
				urlHost: OFFBOX ? OFFBOX_URL_HOST : "127.0.0.1",
				// The declared data-path /24, recorded so the classifier's host
				// falsifier grades against the artifact rather than the
				// classify-time environment (reproducible re-grades).
				dataSubnetPrefix: dataSubnetPrefix(),
				macgen: report
					? {
							bin: G2_MACGEN_BIN,
							entry: OFFBOX_ENTRY,
							candidateAsked: OFFBOX_CANDIDATE,
							deadlineSec: OFFBOX_DEADLINE_SEC,
							provenance: report.provenance,
							problems: report.problems,
						}
					: null,
			},
			netRxDelta,
			udpDelta: udpRxDelta,
		};
		step.upDeliveryRatio =
			step.clientSent > 0 ? step.serverRx / step.clientSent : null;
		steps.push(step);

		const s = LatencyHistogram.fromJson(step.ingest).summary();
		const t = LatencyHistogram.fromJson(step.turnaround).summary();
		const e = step.client
			? LatencyHistogram.fromJson(step.client.egressOneWay).summary()
			: null;
		const ms = (ns: number) => (ns / 1e6).toFixed(3);
		console.log(
			`bench-latency: step ${index + 1} legs ingestP99=${ms(s.p99Ns)}ms turnaroundP99=${ms(t.p99Ns)}ms egressP99=${e ? ms(e.p99Ns) : "n/a"}ms egressN=${e?.count ?? 0} stampFail=${step.echoStampFailures} noEchoInstant=${step.client?.echoMissingEchoInstant ?? "n/a"}`,
		);
		console.log(
			`bench-latency: step ${index + 1} done n=${s.count} p50=${ms(s.p50Ns)}ms p99=${ms(s.p99Ns)}ms p999=${ms(s.p999Ns)}ms max=${ms(s.maxNs)}ms neg=${s.negative} effective=${step.aggregateRate}/s up=${step.upDeliveryRatio?.toFixed(3) ?? "n/a"} sent=${step.clientSent}/${step.requestedDatagrams} over ${step.driveWindowSec.toFixed(1)}s drained=${drainArrivals} hostCpu=${step.hostCpuPctMedian?.toFixed(0) ?? "n/a"}%`,
		);
	}

	await server.close();

	const result = {
		version: 1,
		arm: ARM,
		/** Non-null only in an interleaved dispatch; see `LATENCY_RUNG` above. */
		rung: RUNG,
		replicate: REPLICATE,
		cellIndex: CELL_INDEX,
		startedAt: new Date().toISOString(),
		host: {
			platform: process.platform,
			cpus: navigator?.hardwareConcurrency ?? null,
			bunVersion: Bun.version,
		},
		clock: {
			source: clock.source,
			calibrationResidualNs: clock.calibrationResidualNs,
			calibrationSpreadNs: clock.calibrationSpreadNs,
		},
		config: {
			sessions: SESSIONS,
			payloadBytes: PAYLOAD_BYTES,
			stepSeconds: STEP_SECONDS,
			settleMs: SETTLE_MS,
			ratesPerSession: RATES,
			arrival: ARRIVAL,
			tickHz: TICK_HZ,
			echo: ECHO,
			datagramBatchEnv: process.env.WEBTRANSPORT_DATAGRAM_BATCH ?? null,
			generatorMode: OFFBOX ? "offbox" : "onbox",
			offboxSsh: OFFBOX ? OFFBOX_SSH : null,
			offboxUrlHost: OFFBOX ? OFFBOX_URL_HOST : null,
			offboxCandidate: OFFBOX ? OFFBOX_CANDIDATE : null,
			offboxBin: OFFBOX ? G2_MACGEN_BIN : null,
			offboxEntry: OFFBOX ? OFFBOX_ENTRY : null,
			offboxDeadlineSec: OFFBOX ? OFFBOX_DEADLINE_SEC : null,
			/**
			 * False off-box: the two ends read different counters, so no
			 * cross-host interval is recorded at all (registration §6).
			 */
			sharedClock: !OFFBOX,
		},
		steps,
	};
	writeFileSync(OUT_JSON, `${JSON.stringify(result)}\n`);
	console.log(`bench-latency: wrote ${OUT_JSON}`);
}

await main();
// Server-side sessions left behind by an abruptly exiting client have no QUIC idle
// timeout and keep the event loop referenced after close — a clean drain can hang
// forever (observed on the runner, latency run 32159708926: default arm wrote its
// JSON, then hung 55+ minutes with zero sockets open). Output is already flushed
// synchronously above.
process.exit(0);
