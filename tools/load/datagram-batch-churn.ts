#!/usr/bin/env bun

/**
 * H7 churn falsifier.
 *
 * The batched datagram read holds native state across a JavaScript await, so
 * the question it has to answer is whether churning sessions leaves anything
 * rooted behind. This measures exactly that: a warm, settled protected-object
 * baseline, then 100 server/client session pairs opened, driven, and torn down
 * three different ways, then the same settle again. Growth in the protected
 * set — total, or in any of the four constructors a batch-read leak would show
 * up as — fails the run.
 *
 * The parent runs three fresh child trials because a single process can hide a
 * leak behind allocator noise; three independent processes that all come back
 * flat cannot. Every wait is bounded, and a trial that outlives its deadline is
 * a failure, not a retry.
 *
 * Usage:
 *   bun tools/load/datagram-batch-churn.ts            # parent, writes evidence
 *   bun tools/load/datagram-batch-churn.ts --trial N  # one child measurement
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
	__TESTING__,
	type ClientSession,
	connect,
	createServer,
} from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const ARTIFACT_PATH = join(
	ROOT,
	".release-evidence",
	"h7",
	"datagram-batch-churn.json",
);

const TRIALS = 3;
const TRIAL_TIMEOUT_MS = 60_000;
const SESSION_PAIRS = 100;
const CONCURRENCY = 10;
const DATAGRAMS_PER_SESSION = 10;
/** Every pair must move at least one datagram through the batch path, so the
 * floor is the pair count itself: a trial that churned 100 sessions without
 * delivering anything has measured nothing. */
const MIN_DELIVERED = SESSION_PAIRS;
const ECHO_WAIT_MS = 1_500;
/**
 * An abandoned session is never closed by either peer, so with the shipped
 * 60s idle timeout it is still *open* when the post-churn snapshot is taken —
 * its pending native read is legitimately protected, and the measurement would
 * be reading live state rather than retention. Both ends therefore run a short
 * idle timeout with client keep-alive off, so abandonment ends the way it
 * really ends: the connection times out. The reap window clears that timeout
 * with margin.
 */
const IDLE_TIMEOUT_MS = 3_000;
const ABANDON_REAP_MS = 7_000;

/** Teardown shapes, carried in payload byte 1. */
const TEARDOWN_ABANDON = 0;
const TEARDOWN_CLIENT_CLOSE = 1;
const TEARDOWN_SERVER_CLOSE = 2;
const CONNECT_TIMEOUT_MS = 8_000;
const BASE_PORT = 24_100;

/** A batch-read leak would surface as a retained native session handle, the
 * promise its rejected call captured, or that call's closure. */
const WATCHED_CONSTRUCTORS = [
	"WtSession",
	"ClientSessionHandle",
	"Promise",
	"Function",
] as const;

type ProtectedSnapshot = {
	total: number;
	byConstructor: Record<string, number>;
};

type TrialResult = {
	trial: number;
	pass: boolean;
	failures: string[];
	durationMs: number;
	pairsChurned: number;
	pairsWithDelivery: number;
	delivered: number;
	minDelivered: number;
	baseline: ProtectedSnapshot;
	post: ProtectedSnapshot;
	totalDelta: number;
	watchedDeltas: Record<string, number>;
	awaitProbe: Record<string, number> | null;
	batchConfig: { batchSize: number; diagnosticsEnabled: boolean };
};

function gitOutput(args: string[]): string {
	return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** Double full GC with a settle between: one collection frees the wrappers, the
 * second collects what their finalizers released. */
async function settleHeap(): Promise<void> {
	Bun.gc(true);
	await Bun.sleep(250);
	Bun.gc(true);
	await Bun.sleep(100);
}

function protectedSnapshot(): ProtectedSnapshot {
	const jsc = require("bun:jsc");
	const objects = jsc.getProtectedObjects() as unknown[];
	// Pre-seeded at zero: a constructor that is simply absent from the heap
	// must read as zero rather than as a missing key some later subtraction
	// silently turns into NaN.
	const byConstructor: Record<string, number> = {};
	for (const name of WATCHED_CONSTRUCTORS) byConstructor[name] = 0;
	for (const object of objects) {
		let key: string;
		try {
			key =
				object !== null &&
				(typeof object === "object" || typeof object === "function")
					? ((object as { constructor?: { name?: string } })?.constructor
							?.name ?? "<anon>")
					: typeof object;
		} catch {
			key = "<unprintable>";
		}
		byConstructor[key] = (byConstructor[key] ?? 0) + 1;
	}
	return { total: objects.length, byConstructor };
}

function awaitProbeSnapshot(): Record<string, number> | null {
	const probe = (
		__TESTING__ as unknown as {
			nativeAwaitProbeSnapshotForTests?: () =>
				| Record<string, number>
				| undefined;
		}
	).nativeAwaitProbeSnapshotForTests?.();
	return probe ?? null;
}

function batchConfig(): { batchSize: number; diagnosticsEnabled: boolean } {
	const config = (
		__TESTING__ as unknown as {
			datagramBatchConfigForTests: () => {
				batchSize: number;
				diagnosticsEnabled: boolean;
			};
		}
	).datagramBatchConfigForTests();
	return {
		batchSize: config.batchSize,
		diagnosticsEnabled: config.diagnosticsEnabled,
	};
}

async function connectBounded(port: number): Promise<ClientSession> {
	const deadline = Date.now() + CONNECT_TIMEOUT_MS;
	for (;;) {
		try {
			return await connect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
				limits: {
					idleTimeoutMs: IDLE_TIMEOUT_MS,
					keepAliveIntervalMs: 0,
				},
			});
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await Bun.sleep(50);
		}
	}
}

/**
 * One session pair: connect, push datagrams, read back whatever echoes within
 * the bounded window, then tear down. The three teardown shapes rotate so the
 * trial covers an abandoned session, a client-initiated close, and a
 * server-initiated close rather than only the tidy path.
 */
async function churnPair(port: number, index: number): Promise<number> {
	const client = await connectBounded(port);
	let delivered = 0;
	const teardown = index % 3;
	try {
		const payload = new Uint8Array(64);
		payload.fill(index & 0xff);
		// The teardown shape travels in the payload. Correlating server sessions
		// to client indices by accept order is wrong at this concurrency, and a
		// map that held them for correlation would make the harness the thing
		// retaining what it is trying to measure.
		payload[1] = teardown;
		const iterator = client.incomingDatagrams()[Symbol.asyncIterator]();
		for (let n = 0; n < DATAGRAMS_PER_SESSION; n += 1) {
			payload[0] = n & 0xff;
			await client.sendDatagram(payload);
		}
		const deadline = Date.now() + ECHO_WAIT_MS;
		while (delivered < DATAGRAMS_PER_SESSION && Date.now() < deadline) {
			const next = await Promise.race([
				iterator.next(),
				Bun.sleep(250).then(() => ({ done: true, value: undefined }) as const),
			]);
			if (next.done || !next.value) continue;
			delivered += 1;
		}
		// Release the iterator explicitly: an abandoned pair must not be the one
		// case where the falsifier itself keeps the generator alive.
		await iterator.return?.();
	} finally {
		switch (teardown) {
			case TEARDOWN_CLIENT_CLOSE:
				client.close();
				break;
			case TEARDOWN_SERVER_CLOSE:
				// The peer ends it, on the last datagram it echoed.
				break;
			default:
				// TEARDOWN_ABANDON: no close at all, the last reference just goes
				// out of scope here.
				void TEARDOWN_ABANDON;
				break;
		}
	}
	return delivered;
}

async function runTrial(trial: number): Promise<TrialResult> {
	const startedAtMs = Date.now();
	const failures: string[] = [];
	const tls = generateLocalhostCert();
	if (!tls) throw new Error("localhost certificate generation failed");
	const port = BASE_PORT + trial;

	const server = createServer({
		port,
		tls: { certPem: tls.certPem, keyPem: tls.keyPem },
		// Churn at this rate from one loopback prefix trips the shipped
		// handshake limiter, which would turn a retention measurement into a
		// rate-limit measurement. Abandoned pairs also linger until their idle
		// timeout, so the session ceiling has to clear the pair count.
		limits: {
			maxSessions: SESSION_PAIRS * 2,
			maxHandshakesInFlight: SESSION_PAIRS * 2,
			idleTimeoutMs: IDLE_TIMEOUT_MS,
		},
		rateLimits: {
			handshakesPerSec: 2_000,
			handshakesBurst: 4_000,
			handshakesBurstPerPrefix: 4_000,
			streamsPerSec: 2_000,
			streamsBurst: 4_000,
			datagramsPerSec: 40_000,
			datagramsBurst: 80_000,
		},
		onSession: async (session) => {
			try {
				for await (const datagram of session.incomingDatagrams()) {
					await session.sendDatagram(datagram);
					if (
						datagram[1] === TEARDOWN_SERVER_CLOSE &&
						datagram[0] === DATAGRAMS_PER_SESSION - 1
					) {
						session.close();
						return;
					}
				}
			} catch {
				// Churned pairs tear down mid-iteration by design.
			}
		},
	});

	let delivered = 0;
	let pairsWithDelivery = 0;
	let pairsChurned = 0;
	try {
		// Warm cycle before the baseline: the first session in a process
		// allocates lazily on both sides, and that one-time cost is not churn.
		const warm = await connectBounded(port);
		await warm.sendDatagram(new Uint8Array([0]));
		await Bun.sleep(100);
		warm.close();
		await Bun.sleep(200);
		await settleHeap();
		const baseline = protectedSnapshot();

		let cursor = 0;
		const worker = async (): Promise<void> => {
			for (;;) {
				const index = cursor++;
				if (index >= SESSION_PAIRS) return;
				const moved = await churnPair(port, index);
				pairsChurned += 1;
				delivered += moved;
				if (moved > 0) pairsWithDelivery += 1;
			}
		};
		await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

		await Bun.sleep(ABANDON_REAP_MS);
		await settleHeap();
		const post = protectedSnapshot();
		const awaitProbe = awaitProbeSnapshot();

		const totalDelta = post.total - baseline.total;
		const watchedDeltas: Record<string, number> = {};
		for (const name of WATCHED_CONSTRUCTORS) {
			watchedDeltas[name] =
				(post.byConstructor[name] ?? 0) - (baseline.byConstructor[name] ?? 0);
		}

		if (pairsChurned !== SESSION_PAIRS) {
			failures.push(`churned ${pairsChurned} pairs, expected ${SESSION_PAIRS}`);
		}
		if (delivered < MIN_DELIVERED) {
			failures.push(
				`delivered ${delivered} datagrams, expected at least ${MIN_DELIVERED}`,
			);
		}
		if (pairsWithDelivery !== SESSION_PAIRS) {
			failures.push(
				`${SESSION_PAIRS - pairsWithDelivery} pairs delivered no datagrams`,
			);
		}
		if (awaitProbe === null) {
			failures.push("native await probe is unavailable");
		} else {
			for (const [gauge, value] of Object.entries(awaitProbe)) {
				if (value !== 0) failures.push(`await gauge ${gauge}=${value}`);
			}
		}
		if (totalDelta > 0) {
			failures.push(`protected objects grew by ${totalDelta}`);
		}
		for (const [name, value] of Object.entries(watchedDeltas)) {
			if (value > 0) failures.push(`protected ${name} grew by ${value}`);
		}

		return {
			trial,
			pass: failures.length === 0,
			failures,
			durationMs: Date.now() - startedAtMs,
			pairsChurned,
			pairsWithDelivery,
			delivered,
			minDelivered: MIN_DELIVERED,
			baseline,
			post,
			totalDelta,
			watchedDeltas,
			awaitProbe,
			batchConfig: batchConfig(),
		};
	} finally {
		try {
			await server.close();
		} catch {
			// A server already torn down by a churned pair is fine.
		}
		tls.cleanup();
	}
}

async function runChild(trial: number): Promise<void> {
	const result = await runTrial(trial);
	console.log(`__CHURN__${JSON.stringify(result)}`);
	// The accept loops keep a pending read alive per session by design, so the
	// event loop no longer drains once the measurement is written.
	process.exit(result.pass ? 0 : 1);
}

type ChildOutcome = {
	trial: number;
	pass: boolean;
	exitCode: number | null;
	timedOut: boolean;
	failures: string[];
	result: TrialResult | null;
	stderrTail: string;
};

async function runChildTrial(trial: number): Promise<ChildOutcome> {
	const proc = Bun.spawn(
		[
			process.execPath,
			join(ROOT, "tools/load/datagram-batch-churn.ts"),
			"--trial",
			String(trial),
		],
		{ cwd: ROOT, env: process.env, stdout: "pipe", stderr: "pipe" },
	);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;
	try {
		const exited = await Promise.race([
			proc.exited,
			new Promise<"timeout">((r) => {
				timer = setTimeout(() => r("timeout"), TRIAL_TIMEOUT_MS);
			}),
		]);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		if (exited === "timeout") {
			timedOut = true;
			proc.kill("SIGKILL");
			return {
				trial,
				pass: false,
				exitCode: null,
				timedOut,
				failures: [`trial did not finish within ${TRIAL_TIMEOUT_MS}ms`],
				result: null,
				stderrTail: stderr.slice(-2000),
			};
		}
		const line = stdout
			.split("\n")
			.reverse()
			.find((candidate) => candidate.startsWith("__CHURN__"));
		if (!line) {
			return {
				trial,
				pass: false,
				exitCode: exited,
				timedOut,
				failures: ["trial produced no measurement"],
				result: null,
				stderrTail: stderr.slice(-2000),
			};
		}
		const result = JSON.parse(line.slice("__CHURN__".length)) as TrialResult;
		return {
			trial,
			pass: result.pass && exited === 0,
			exitCode: exited,
			timedOut,
			failures: result.failures,
			result,
			stderrTail: stderr.slice(-2000),
		};
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function runParent(): Promise<void> {
	const head = gitOutput(["rev-parse", "HEAD"]);
	const dirty = gitOutput(["status", "--porcelain"]).length > 0;
	const candidate = process.env.SOAK_CANDIDATE_COMMIT ?? head;

	const trials: ChildOutcome[] = [];
	// Sequential: three concurrent QUIC churn trials on one host would measure
	// scheduler contention rather than retention.
	for (let trial = 1; trial <= TRIALS; trial += 1) {
		trials.push(await runChildTrial(trial));
	}

	const failures: string[] = [];
	if (head !== candidate) {
		failures.push(`HEAD ${head} does not match candidate ${candidate}`);
	}
	if (dirty) failures.push("working tree is dirty");
	for (const outcome of trials) {
		if (!outcome.pass) {
			failures.push(
				`trial ${outcome.trial}: ${outcome.failures.join("; ") || `exit ${outcome.exitCode}`}`,
			);
		}
	}

	const artifact = {
		version: 1,
		mode: "datagram-batch-churn",
		status: failures.length === 0 ? "pass" : "fail",
		generatedAtMs: Date.now(),
		head,
		candidate,
		dirty,
		trials: TRIALS,
		sessionPairs: SESSION_PAIRS,
		concurrency: CONCURRENCY,
		datagramsPerSession: DATAGRAMS_PER_SESSION,
		trialTimeoutMs: TRIAL_TIMEOUT_MS,
		watchedConstructors: [...WATCHED_CONSTRUCTORS],
		failures,
		results: trials,
	};
	mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
	writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));
	console.log(
		artifact.status === "pass"
			? "datagram-batch-churn: PASS"
			: "datagram-batch-churn: FAIL",
		JSON.stringify({ artifact: ARTIFACT_PATH, failures }, null, 2),
	);
	process.exit(artifact.status === "pass" ? 0 : 1);
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const trialIndex = argv.indexOf("--trial");
	const run =
		trialIndex >= 0
			? runChild(Number(argv[trialIndex + 1] ?? "1"))
			: runParent();
	run.catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
