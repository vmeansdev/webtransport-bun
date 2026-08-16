#!/usr/bin/env bun

/**
 * H7 end-to-end batching probe — the real receive path, through the addon.
 *
 * The JS-floor bench (datagram-delivery-floor.ts) answered whether the async
 * generator is the ceiling. It is not, by ~478x. What it could not answer is
 * whether batching actually buys throughput, because it runs over pre-filled
 * arrays with no TSFN, no deferred and no spawn_future — precisely the costs
 * batching folds. Its 1.54x is the amortization of a pre-resolved await and
 * nothing more.
 *
 * This measures the proposition itself: sustained server-side datagrams/s
 * received, receive-only with no echo, WEBTRANSPORT_DATAGRAM_BATCH=0 against
 * =64, same addon build, same host, interleaved.
 *
 * It is a PROBE, not a gate. It writes no verdict into the floor bench's
 * artifact and moves none of its thresholds. Task 8 remains the place the 2.0x
 * requirement is enforced on the full ladder.
 *
 * THE MEASUREMENT ONLY MEANS SOMETHING IF THE RECEIVER IS THE BOTTLENECK.
 * If the sender or the kernel saturates first, both arms report the offered
 * rate and the ratio collapses toward 1.0 for reasons that have nothing to do
 * with batching — the same false-stop shape the floor bench hit. The probe
 * therefore records offered load alongside received load and reports
 * "inconclusive" rather than "stop" when the legacy arm was never driven past
 * its own capacity.
 *
 * Usage:
 *   bun tools/bench/datagram-batch-e2e-probe.ts            # parent
 *   bun tools/bench/datagram-batch-e2e-probe.ts --arm N --port P --round R
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
	__TESTING__,
	createServer,
} from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	DIAGNOSTICS_ENV,
	diagnosticsFailures,
	identityFailures,
	MIN_MEDIAN_SPEEDUP,
	makeRng,
	median,
	minimum,
	parseDiagnosticsRequest,
	shuffled,
} from "./datagram-delivery-floor.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const ARTIFACT_PATH = join(
	ROOT,
	".release-evidence",
	"h7",
	"datagram-batch-e2e-probe.json",
);
const CLIENT_BIN = join(ROOT, "target", "release", "load-client");
const BATCH_ENV = "WEBTRANSPORT_DATAGRAM_BATCH";
const COMMAND = "bun tools/bench/datagram-batch-e2e-probe.ts";

/** The two arms: legacy one-read-per-datagram, and the intended default. */
export const ARMS = [0, 64] as const;
const SESSIONS = Number(process.env.H7_PROBE_SESSIONS ?? "150");
/**
 * 1150, not 1200. A 1200-byte payload plus the WebTransport session-id varint
 * and QUIC framing exceeds the 1200-byte conservative path MTU, so every send
 * fails as too-large — measured at 1.6M send errors against 876k successes.
 * 1150 is the size the bandwidth ladder already uses for the same reason.
 */
const PAYLOAD_BYTES = Number(process.env.H7_PROBE_PAYLOAD_BYTES ?? "1150");
/**
 * Per-session offered rate. The aggregate has to exceed the RECEIVER's
 * capacity or the probe measures the sender; on this host the legacy arm alone
 * sustains ~34,000/s, well above the ~12,500/s the plan assumed, so the offered
 * load must clear that with room. Whether it actually did is not assumed — it
 * is measured, see SATURATION_CEILING.
 */
const DATAGRAMS_PER_SEC = Number(process.env.H7_PROBE_RATE ?? "1000");
const WARMUP_SEC = 5;
const MEASURE_SEC = 20;
/** Three interleaved reps per arm = 60s of steady state each. */
export const REPS = 3;
/**
 * If an arm received this fraction or more of what was offered, the sender
 * never outran it, so its number is offered load and not capacity. One such
 * legacy arm makes the whole comparison inconclusive.
 */
export const SATURATION_CEILING = 0.9;
const BASE_PORT = 47_433;
/** Bind + Tokio/wtransport startup, same 3s the other load tools allow. */
const BIND_WAIT_MS = 3_000;
const CHILD_TIMEOUT_MS =
	(WARMUP_SEC + MEASURE_SEC) * 1_000 + BIND_WAIT_MS + 45_000;

export type ArmRun = {
	arm: number;
	round: number;
	receivedPerSec: number;
	offeredPerSec: number;
	received: number;
	receivedBytes: number;
	clientSent: number;
	clientSendErrors: number;
	sessionsOk: number;
	sessionsErr: number;
	windowMs: number;
	saturationRatio: number;
	/** Server-process CPU over the window, as a fraction of one core. */
	serverCpuCores: number;
	/**
	 * Only populated by a deliberately diagnostics-enabled mechanism run, which
	 * is never the measurement (the parent refuses diagnostics). `meanBatchSize`
	 * is the number that says whether batching had anything to amortize.
	 */
	batchDiagnostics: Record<string, number> | null;
};

function gitOutput(args: string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

// ---------------------------------------------------------------------------
// Child: one arm, one round, one fresh process (the knob is read at init)
// ---------------------------------------------------------------------------

async function runChild(arm: number, port: number, round: number) {
	// A child MAY be run with diagnostics on, deliberately, to inspect the
	// mechanism. The parent never does that for the measurement.
	const diagnosticsOn = parseDiagnosticsRequest(process.env[DIAGNOSTICS_ENV]);
	const tls = generateLocalhostCert();
	if (!tls) throw new Error("failed to generate localhost cert");

	let received = 0;
	let receivedBytes = 0;
	const aggregateOffered = SESSIONS * DATAGRAMS_PER_SEC;
	createServer({
		port,
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
			// Measure the delivery path, never the limiter.
			datagramsPerSec: aggregateOffered * 4,
			datagramsBurst: aggregateOffered * 8,
		},
		onSession: (session) => {
			// Receive-only. No echo: an echo would put the send path in the
			// measurement and halve the pps headroom on the same host.
			void (async () => {
				for await (const datagram of session.incomingDatagrams()) {
					received += 1;
					receivedBytes += datagram.byteLength;
				}
			})().catch(() => {});
		},
	});
	await Bun.sleep(BIND_WAIT_MS);

	const client = Bun.spawn(
		[
			CLIENT_BIN,
			"--url",
			`https://127.0.0.1:${port}`,
			"--mode",
			"load",
			"--skip-probes",
			"--sessions",
			String(SESSIONS),
			"--duration",
			String(WARMUP_SEC + MEASURE_SEC),
			"--datagrams-per-sec",
			String(DATAGRAMS_PER_SEC),
			"--streams-per-sec",
			"0",
			"--payload-bytes",
			String(PAYLOAD_BYTES),
			"--max-session-errors",
			String(SESSIONS),
			"--max-datagram-errors",
			"1000000000",
			"--max-stream-errors",
			"1000000000",
		],
		{ cwd: ROOT, stdout: "pipe", stderr: "pipe" },
	);
	const stdoutPromise = new Response(client.stdout).text();
	const stderrPromise = new Response(client.stderr).text();

	// Steady state only: let handshakes and cwnd settle before the window opens.
	await Bun.sleep(WARMUP_SEC * 1_000);
	const rx0 = received;
	const bytes0 = receivedBytes;
	const cpu0 = process.cpuUsage();
	const diag0 = __TESTING__.datagramBatchDiagnosticsSnapshotForTests();
	const t0 = performance.now();
	await Bun.sleep(MEASURE_SEC * 1_000);
	const rx1 = received;
	const bytes1 = receivedBytes;
	const cpu1 = process.cpuUsage();
	const diag1 = __TESTING__.datagramBatchDiagnosticsSnapshotForTests();
	const t1 = performance.now();

	await client.exited;
	const stdout = await stdoutPromise;
	const stderr = await stderrPromise;
	const num = (re: RegExp): number => {
		const m = stdout.match(re);
		return m?.[1] ? Number.parseInt(m[1], 10) : 0;
	};
	const clientSent = num(/datagrams sent=(\d+)/);
	const sessionsOk = num(/sessions ok=(\d+)/);
	const windowMs = t1 - t0;
	// Offered is averaged over the client's whole run; the window is a subset of
	// it. Good enough for its only job, which is detecting non-saturation.
	const offeredPerSec = clientSent / (WARMUP_SEC + MEASURE_SEC);
	const receivedPerSec = ((rx1 - rx0) / windowMs) * 1000;
	const result: ArmRun = {
		arm,
		round,
		receivedPerSec,
		offeredPerSec,
		received: rx1 - rx0,
		receivedBytes: bytes1 - bytes0,
		clientSent,
		clientSendErrors: num(/datagrams sent=\d+ err=(\d+)/),
		sessionsOk,
		sessionsErr: num(/sessions ok=\d+ err=(\d+)/),
		windowMs,
		saturationRatio: offeredPerSec > 0 ? receivedPerSec / offeredPerSec : 0,
		serverCpuCores:
			(cpu1.user - cpu0.user + (cpu1.system - cpu0.system)) / 1_000 / windowMs,
		batchDiagnostics: diagnosticsOn
			? {
					batchReadCalls: diag1.batchReadCalls - diag0.batchReadCalls,
					legacyReadCalls: diag1.legacyReadCalls - diag0.legacyReadCalls,
					materializedItems: diag1.materializedItems - diag0.materializedItems,
					maxBatchSize: diag1.maxBatchSize,
					meanBatchSize:
						diag1.batchReadCalls > diag0.batchReadCalls
							? (diag1.materializedItems - diag0.materializedItems) /
								(diag1.batchReadCalls - diag0.batchReadCalls)
							: 0,
				}
			: null,
	};
	if (sessionsOk === 0) {
		console.error(`load-client produced no sessions:\n${stderr.slice(-2000)}`);
		process.exit(2);
	}
	console.log(`__ARM_RESULT__${JSON.stringify(result)}`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent
// ---------------------------------------------------------------------------

async function runOne(
	arm: number,
	round: number,
	port: number,
): Promise<ArmRun> {
	const child = Bun.spawn(
		[
			"bun",
			join("tools", "bench", "datagram-batch-e2e-probe.ts"),
			"--arm",
			String(arm),
			"--port",
			String(port),
			"--round",
			String(round),
		],
		{
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				[BATCH_ENV]: String(arm),
				WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
			},
		},
	);
	const timer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
	try {
		const stdout = await new Response(child.stdout).text();
		const stderr = await new Response(child.stderr).text();
		const exitCode = await child.exited;
		const line = stdout.split("\n").find((l) => l.startsWith("__ARM_RESULT__"));
		if (exitCode !== 0 || !line) {
			throw new Error(
				`arm ${arm} round ${round} failed (exit ${exitCode}): ${stderr.slice(-1500)}`,
			);
		}
		return JSON.parse(line.slice("__ARM_RESULT__".length)) as ArmRun;
	} finally {
		clearTimeout(timer);
	}
}

export function summarizeProbe(runs: ArmRun[]) {
	const byArm = ARMS.map((arm) => {
		const armRuns = runs.filter((r) => r.arm === arm);
		const rates = armRuns.map((r) => r.receivedPerSec);
		return {
			arm,
			runs: armRuns,
			medianReceivedPerSec: rates.length > 0 ? median(rates) : Number.NaN,
			minReceivedPerSec: rates.length > 0 ? minimum(rates) : Number.NaN,
			maxSaturationRatio:
				armRuns.length > 0
					? Math.max(...armRuns.map((r) => r.saturationRatio))
					: Number.NaN,
		};
	});
	const legacy = byArm[0];
	const batched = byArm[1];
	const ratio =
		legacy && batched && legacy.medianReceivedPerSec > 0
			? batched.medianReceivedPerSec / legacy.medianReceivedPerSec
			: null;
	const nonFinite = runs.some(
		(r) => !Number.isFinite(r.receivedPerSec) || r.receivedPerSec <= 0,
	);

	let verdict: "proceed" | "stop" | "inconclusive";
	let rationale: string;
	if (nonFinite || ratio === null || runs.length !== ARMS.length * REPS) {
		verdict = "inconclusive";
		rationale = "a run produced no usable rate";
	} else if ((legacy?.maxSaturationRatio ?? 1) >= SATURATION_CEILING) {
		verdict = "inconclusive";
		rationale =
			`the legacy arm received >= ${SATURATION_CEILING} of the offered load, ` +
			"so it was never driven past its own capacity and the ratio measures " +
			"the sender, not the receive path";
	} else if (ratio >= MIN_MEDIAN_SPEEDUP) {
		verdict = "proceed";
		rationale = `the real receive path shows >= ${MIN_MEDIAN_SPEEDUP}x`;
	} else {
		verdict = "stop";
		rationale = `the real receive path shows < ${MIN_MEDIAN_SPEEDUP}x with the receiver demonstrably saturated`;
	}
	return { byArm, ratio, verdict, rationale };
}

async function runParent(): Promise<void> {
	const diagnostics = {
		requested: parseDiagnosticsRequest(process.env[DIAGNOSTICS_ENV]),
		// The parent never serves, so the only resolved state that matters is
		// the children's — and they are spawned with the knob set explicitly.
		resolved: false,
	};
	const refusals = diagnosticsFailures(diagnostics);
	if (refusals.length > 0) {
		console.error(`e2e-probe: REFUSED\n  ${refusals.join("\n  ")}`);
		process.exit(1);
	}

	if (!(await Bun.file(CLIENT_BIN).exists())) {
		console.error(
			`e2e-probe: REFUSED\n  ${CLIENT_BIN} is missing; build it with ` +
				"`CARGO_TARGET_DIR=$PWD/target cargo build -p reference --bin load-client --release`",
		);
		process.exit(1);
	}

	const head = gitOutput(["rev-parse", "HEAD"]);
	const dirty = gitOutput(["status", "--porcelain"]).length > 0;
	const externalCandidate = process.env.SOAK_CANDIDATE_COMMIT;
	const identity = {
		head,
		candidate: externalCandidate ?? head,
		dirty,
	};

	const seed = Number(process.env.H7_PROBE_SEED ?? "20260816");
	const rng = makeRng(seed);
	const runs: ArmRun[] = [];
	const order: string[] = [];
	// Alternate arms round by round rather than running each arm's reps as one
	// block: a host that heats up part-way through would otherwise hand the
	// whole penalty to whichever arm ran second.
	for (let round = 1; round <= REPS; round += 1) {
		for (const arm of shuffled(ARMS, rng)) {
			order.push(`r${round}:batch${arm}`);
			console.log(`e2e-probe: round ${round}/${REPS} arm batch=${arm} ...`);
			runs.push(await runOne(arm, round, BASE_PORT + runs.length));
		}
	}

	const summary = summarizeProbe(runs);
	const failures = [
		...diagnosticsFailures(diagnostics),
		...identityFailures(identity),
	];
	const artifact = {
		version: 1,
		mode: "datagram-batch-e2e-probe",
		kind: "probe",
		status: failures.length === 0 ? "ok" : "refused",
		verdict: summary.verdict,
		rationale: summary.rationale,
		generatedAtMs: Date.now(),
		head,
		candidate: identity.candidate,
		candidateBinding: externalCandidate ? "external" : "self-reference",
		dirty,
		bunVersion: Bun.version,
		platform: `${process.platform}/${process.arch}`,
		machine: process.env.BENCH_MACHINE_IDENTITY?.trim() || hostname(),
		command: COMMAND,
		diagnostics,
		design: {
			arms: [...ARMS],
			sessions: SESSIONS,
			payloadBytes: PAYLOAD_BYTES,
			datagramsPerSecPerSession: DATAGRAMS_PER_SEC,
			aggregateOfferedPerSec: SESSIONS * DATAGRAMS_PER_SEC,
			warmupSec: WARMUP_SEC,
			measureSec: MEASURE_SEC,
			reps: REPS,
			saturationCeiling: SATURATION_CEILING,
			ratioReference: MIN_MEDIAN_SPEEDUP,
			seed,
			order,
		},
		ratio: summary.ratio,
		arms: summary.byArm,
		failures,
	};
	mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
	writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));

	for (const arm of summary.byArm) {
		console.log(
			`  batch=${arm.arm}: median ${Math.round(arm.medianReceivedPerSec).toLocaleString()} recv/s, ` +
				`min ${Math.round(arm.minReceivedPerSec).toLocaleString()}, ` +
				`worst saturation ${arm.maxSaturationRatio.toFixed(3)}`,
		);
	}
	console.log(
		`  ratio batch64/batch0: ${summary.ratio?.toFixed(4) ?? "n/a"} ` +
			`(reference ${MIN_MEDIAN_SPEEDUP}x)`,
	);
	console.log(
		`e2e-probe: ${summary.verdict.toUpperCase()} — ${summary.rationale}`,
		JSON.stringify({ artifact: ARTIFACT_PATH, failures }, null, 2),
	);
	// A probe exits 0 when it measured something trustworthy, whichever way the
	// answer went. Refusal and inconclusive both need a human.
	process.exit(
		artifact.status === "ok" && summary.verdict !== "inconclusive" ? 0 : 1,
	);
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const flag = (name: string): number | null => {
		const i = argv.indexOf(name);
		return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : null;
	};
	const arm = flag("--arm");
	const run =
		arm === null
			? runParent()
			: runChild(arm, flag("--port") ?? BASE_PORT, flag("--round") ?? 1);
	run.catch((err) => {
		console.error("e2e-probe: crashed", err);
		process.exit(1);
	});
}
