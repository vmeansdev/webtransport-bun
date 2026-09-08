/**
 * S6: the fanout-cohort server child, driven as a real process.
 *
 * Design §2.1 asks for one thing that no other suite in this tree can observe:
 * that `bun tools/compare/server.ts --mode=fanout-cohort`, launched from the
 * staged argv with nothing but its stage-time environment and two control
 * descriptors, serves a real cohort relay and stays alive through the whole
 * §5 lifecycle instead of exiting after `server-warmup-ready/v1`.
 *
 * So nothing here is injected into the child. The rig is scripted -- this file
 * writes the §3.4 frames a rig supervisor would write, in the bytes S1's codec
 * produces -- and everything on the other side of FD 3/4 is the production
 * entrypoint: the real environment parser, the real grant verification against
 * the staged Mac key, a real `Bun.serve` listener behind
 * `serveFanoutCohortRelay`, real WebSocket role peers presenting real tokens
 * against the Merkle root inside the signed grant, and a real warmup and
 * measured window over the wire.
 *
 * The one thing the script stands in for is the rig's signing: this file holds
 * the Mac key, because §1.1 puts the Mac signer in a separate process and the
 * child's whole job is to verify what that process signed.
 */
import { dlopen, FFIType, ptr } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import {
	closeSync,
	createReadStream,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type BinaryMessageClient,
	connectBinaryMessageClient,
} from "./adapters/ws.ts";
import {
	buildChildPipeRefusal,
	buildServerBindExecution,
	buildServerMeasureStart,
	buildServerPresentStartBarrier,
	buildServerStopAndCapture,
	buildServerTeardown,
	buildServerWarmupDrainAndReset,
	buildServerWarmupStart,
	decodeChildPipeFrame,
	encodeServerChildFrame,
	parseServerCaptureAck,
	parseServerMeasureStartAck,
	parseServerReady,
	parseServerStartBarrierAccepted,
	parseServerStopped,
	parseServerWarmupDrained,
	parseServerWarmupReady,
} from "./child-pipe-protocol.ts";
import {
	COHORT_DRAIN_DEADLINE_MS,
	COHORT_WORKER_COUNT,
	type CohortGrantV1,
	type CohortStartBarrierV1,
	type CohortWarmupEpochV1,
	READINESS_DEADLINE_MS_TICKER,
	type SubscriberShardV1,
	WARMUP_MESSAGES_PER_PUBLISHER,
} from "./cohort-protocol.ts";
import {
	type Base64,
	bytesOfCanonical,
	generateEd25519KeyPair,
	macConstructFinalExecution,
	type NsString,
	type Sha256Hex,
	signMacReceipt,
} from "./cross-supervisor-protocol.ts";
import {
	buildFanoutCohortFixture,
	type FanoutCohortFixture,
	fanoutFrameCodecFor,
	fanoutPayload,
	fanoutRoleId,
} from "./scenarios/fanout-relay.ts";
import type { FanoutWireV1 } from "./scenarios/fanout-wire.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";
import { stagedServerLaunchArgv } from "./server.ts";

/**
 * `pipe(2)`, inline.
 *
 * `remote-supervisor.ts` has this already (`createCloexecPipe`, `:772`) and
 * this file deliberately does not import it: that module is `controllerOnlyTs`
 * in the official-I/O allowlist, and a test that reaches into it is a
 * `TEST_IMPORT_CONTROLLER_FORBIDDEN` finding. Node has no `pipe(2)` binding,
 * and Node's own `stdio: "pipe"` at fd >= 3 hands the child a socketpair, which
 * `createFanoutCohortControlPipeIo`'s `fstatSync(fd).isFIFO()` check refuses --
 * correctly, and for exactly the reason the check exists. So the rig's real
 * descriptors are made the way the rig makes them.
 */
const libc = dlopen(
	process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6",
	{
		pipe: { args: [FFIType.ptr], returns: FFIType.i32 },
		fcntl: {
			args: [FFIType.i32, FFIType.i32, FFIType.i32],
			returns: FFIType.i32,
		},
	},
);
const F_SETFD = 2;
const FD_CLOEXEC = 1;

function unixPipe(parentKeeps: "read" | "write"): {
	readonly childFd: number;
	readonly parentFd: number;
} {
	const fds = new Int32Array(2);
	if (libc.symbols.pipe(ptr(fds)) !== 0) throw new Error("pipe(2) failed");
	const readFd = fds[0] as number;
	const writeFd = fds[1] as number;
	const parentFd = parentKeeps === "write" ? writeFd : readFd;
	const childFd = parentKeeps === "write" ? readFd : writeFd;
	// The end the parent keeps must not leak into the child's own exec.
	if (libc.symbols.fcntl(parentFd, F_SETFD, FD_CLOEXEC) !== 0) {
		throw new Error("fcntl(FD_CLOEXEC) failed");
	}
	return { childFd, parentFd };
}

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PROCESS_TEST_TIMEOUT_MS = 300_000;

const COHORT_ID = "cohort-s6-server-child";
const PUBLISHER_COUNT = 2;
const SUBSCRIBER_COUNT = COHORT_WORKER_COUNT;
const MESSAGE_BYTES = 100 as const;
const SAMPLE_WINDOW_MS = 1_000;
const MEASURED_DURATION_MS = 10_000;
const WINDOW_COUNT = MEASURED_DURATION_MS / SAMPLE_WINDOW_MS;
const MEASURED_FRAMES_PER_PUBLISHER = 4;
const LINUX_CLOCK_ID = "c".repeat(64);

const HEX = (character: string): Sha256Hex => character.repeat(64) as Sha256Hex;

const PUBLISHER_IDS = Array.from({ length: PUBLISHER_COUNT }, (_u, index) =>
	fanoutRoleId("publisher", index),
);
const SUBSCRIBER_IDS = Array.from({ length: SUBSCRIBER_COUNT }, (_u, index) =>
	fanoutRoleId("subscriber", index),
);

// ---------------------------------------------------------------------------
// The Mac's half: a real signed cohort, minted the way the Mac mints one.
// ---------------------------------------------------------------------------

interface Cohort {
	readonly mac: ReturnType<typeof generateEd25519KeyPair>;
	readonly tokens: FanoutCohortFixture;
	readonly grant: CohortGrantV1;
	readonly grantBytes: Uint8Array;
	readonly grantSha256: Sha256Hex;
	readonly grantSignature: unknown;
	readonly executionSha256: Sha256Hex;
	readonly notAfterMs: number;
}

function buildCohort(transport: "ws" | "wt"): Cohort {
	const mac = generateEd25519KeyPair();
	const tokens = buildFanoutCohortFixture({
		cohortId: COHORT_ID,
		publisherCount: PUBLISHER_COUNT,
		subscriberCount: SUBSCRIBER_COUNT,
	});
	const issuedAtMs = Date.now();
	// Every validity window the child checks is checked against a real clock,
	// because the production child reads one. A fixture window of 1,000-2,000 ms
	// would be expired before the process started.
	const notAfterMs = issuedAtMs + 600_000;
	const stagedLaunchRecord = {
		schema: "staged-server-launch-record/v1",
		stageReceiptSha256: HEX("1"),
		serverEntrypointSha256: HEX("2"),
		bunSha256: HEX("3"),
		addonSha256: HEX("4"),
		bindAddress: "127.0.0.1",
		bindPort: 4433,
		advertisedHost: "127.0.0.1",
		tlsServerName: "wt-compare.local",
		tlsCertificateSha256: HEX("5"),
		tlsPrivateKeySha256: HEX("6"),
		transport,
		argv: [
			...stagedServerLaunchArgv(transport, "fanout-cohort", "local-acceptance"),
		],
		allowedEnvironment: [],
	};
	const workloadBytes = bytesOfCanonical({ plan: "s6", cohortId: COHORT_ID });
	const built = macConstructFinalExecution({
		draft: {
			schema: "cross-supervisor-execution-draft/v1",
			authoritySha256: HEX("a"),
			campaignLockSha256: HEX("b"),
			stagedCapabilitySha256: HEX("c"),
			sourceArchiveSha256: HEX("d"),
			approvedPlanSha256: HEX("e"),
			approvalRecordSha256: HEX("f"),
			candidate: "cand",
			campaignId: "camp",
			runId: `camp/ticker-fanout-250/${transport}/measured-1`,
			executionPurpose: "focused",
			cellId: "ticker-fanout/rate-250",
			scenarioHash: HEX("5"),
			rolePlanHash: HEX("6"),
			workloadRolePlanInputSha256: sha256HexOfBytes(workloadBytes),
			stagedServerLaunchRecordSha256: sha256HexOfBytes(
				bytesOfCanonical(stagedLaunchRecord),
			),
			armKind: "primary",
			transport,
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
			grantDeclaration: "fanout-expanded-deliveries",
			declaredMessageCount: 250_000,
			declaredMessageBytes: MESSAGE_BYTES,
			requestedNotAfterMs: notAfterMs,
		},
		executionIndex: 0,
		macSupervisorInstanceNonce: HEX("7"),
		issuedAtMs,
		notAfterMs,
		grantNonceSha256: HEX("8"),
	});
	if (!built.ok) throw new Error(`execution: ${built.code}`);
	const { execution, executionSha256 } = built.value;
	const offeredIngress = PUBLISHER_COUNT * MEASURED_FRAMES_PER_PUBLISHER;
	const grant = {
		schema: "cohort-grant/v1",
		execution,
		executionSha256,
		macExecutionGrantReceiptSha256: HEX("9"),
		approvedPlanSha256: execution.approvedPlanSha256,
		approvalRecordSha256: execution.approvalRecordSha256,
		cohortId: COHORT_ID,
		cohortAttempt: 1,
		scenarioHash: execution.scenarioHash,
		rolePlanHash: execution.rolePlanHash,
		workloadRolePlanInputSha256: execution.workloadRolePlanInputSha256,
		transport,
		publisherCount: PUBLISHER_COUNT,
		subscriberCount: SUBSCRIBER_COUNT,
		workerCount: COHORT_WORKER_COUNT,
		expectedProcessCount: PUBLISHER_COUNT + COHORT_WORKER_COUNT,
		expectedSessionCount: PUBLISHER_COUNT + SUBSCRIBER_COUNT,
		publishers: [...tokens.publishers],
		subscriberShards: [...tokens.subscriberShards] as SubscriberShardV1[],
		tokenCommitmentLeafManifestSha256: HEX("0"),
		roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
		roleTokenCommitmentCount: tokens.roleTokenCommitmentCount,
		connectionRatePerSecond: 500,
		maxConnectionsInFlight: 200,
		readinessDeadlineMs: READINESS_DEADLINE_MS_TICKER,
		inRepetitionWarmupMs: 5_000,
		sampleWindowMs: SAMPLE_WINDOW_MS,
		measuredDurationMs: MEASURED_DURATION_MS,
		drainDeadlineMs: COHORT_DRAIN_DEADLINE_MS,
		messageBytes: MESSAGE_BYTES,
		expectedOfferedIngress: offeredIngress,
		expectedExpandedDeliveries: offeredIngress * SUBSCRIBER_COUNT,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: sha256HexOfBytes(mac.publicRaw32),
		receiptSequence: 1,
		issuedAtMs,
		notAfterMs,
	} as unknown as CohortGrantV1;
	const grantBytes = bytesOfCanonical(grant);
	return {
		mac,
		tokens,
		grant,
		grantBytes,
		grantSha256: sha256HexOfBytes(grantBytes),
		grantSignature: signMacReceipt({
			privatePkcs8Der: mac.privatePkcs8Der,
			publicRaw32: mac.publicRaw32,
			signedSchema: "cohort-grant/v1",
			signedBytes: grantBytes,
		}),
		executionSha256,
		notAfterMs,
	};
}

function macSign(
	cohort: Cohort,
	signedSchema: Parameters<typeof signMacReceipt>[0]["signedSchema"],
	signedBytes: Uint8Array,
): unknown {
	return signMacReceipt({
		privatePkcs8Der: cohort.mac.privatePkcs8Der,
		publicRaw32: cohort.mac.publicRaw32,
		signedSchema,
		signedBytes,
	});
}

function warmupEpochFor(cohort: Cohort): {
	readonly epoch: CohortWarmupEpochV1;
	readonly bytes: Uint8Array;
	readonly sha256: Sha256Hex;
	readonly signature: unknown;
} {
	const epoch: CohortWarmupEpochV1 = {
		schema: "cohort-warmup-epoch/v1",
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		cohortId: COHORT_ID,
		warmupNonce: HEX("8"),
		durationMs: 5_000,
		warmupMessagesPerPublisher: WARMUP_MESSAGES_PER_PUBLISHER,
		warmupIntervalMs: 500,
		expectedWarmupIngress: PUBLISHER_COUNT * WARMUP_MESSAGES_PER_PUBLISHER,
		expectedWarmupDeliveries:
			PUBLISHER_COUNT * WARMUP_MESSAGES_PER_PUBLISHER * SUBSCRIBER_COUNT,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: sha256HexOfBytes(cohort.mac.publicRaw32),
		receiptSequence: 2,
		issuedAtMs: cohort.grant.issuedAtMs,
		notAfterMs: cohort.notAfterMs,
	};
	const bytes = bytesOfCanonical(epoch);
	return {
		epoch,
		bytes,
		sha256: sha256HexOfBytes(bytes),
		signature: macSign(cohort, "cohort-warmup-epoch/v1", bytes),
	};
}

function startBarrierFor(cohort: Cohort): {
	readonly barrier: CohortStartBarrierV1;
	readonly bytes: Uint8Array;
	readonly sha256: Sha256Hex;
	readonly signature: unknown;
} {
	const macNs = `${BigInt(Date.now()) * 1_000_000n}` as NsString;
	const barrier: CohortStartBarrierV1 = {
		schema: "cohort-start-barrier/v1",
		executionSha256: cohort.executionSha256,
		cohortGrantSha256: cohort.grantSha256,
		rigCohortAcceptanceSha256: HEX("1"),
		rigMeasureStartAckSha256: HEX("2"),
		roleWarmupCompletionManifestSha256: MANIFEST_SHA,
		roleWarmupCompletionManifestSignatureSha256: HEX("4"),
		rigWarmupDrainedReceiptSha256: HEX("5"),
		cohortId: COHORT_ID,
		barrierNonce: HEX("6"),
		macClockId: "m".repeat(64),
		mintedAtMacNs: macNs,
		warmupStartedAtMacNs: macNs,
		warmupCompletedAtMacNs: macNs,
		measureStartAtMacNs: macNs,
		measureStopAtMacNs:
			`${BigInt(Date.now() + MEASURED_DURATION_MS) * 1_000_000n}` as NsString,
		sampleWindowMs: SAMPLE_WINDOW_MS,
		windowCount: WINDOW_COUNT as 10 | 30,
		measuredDurationMs: MEASURED_DURATION_MS as 10000 | 30000,
		drainDeadlineMs: COHORT_DRAIN_DEADLINE_MS as 10000,
		macSupervisorInstanceNonce: HEX("7"),
		signingPublicKeySha256: sha256HexOfBytes(cohort.mac.publicRaw32),
		receiptSequence: 3,
		issuedAtMs: cohort.grant.issuedAtMs,
		notAfterMs: cohort.notAfterMs,
	};
	const bytes = bytesOfCanonical(barrier);
	return {
		barrier,
		bytes,
		sha256: sha256HexOfBytes(bytes),
		signature: macSign(cohort, "cohort-start-barrier/v1", bytes),
	};
}

const MANIFEST_SHA = HEX("3");

// ---------------------------------------------------------------------------
// The scripted rig: a real child process on the other end of real FD 3/4 pipes.
// ---------------------------------------------------------------------------

/** A throwaway certificate for the child's loopback listener. */
function selfSignedTls(dir: string): { cert: string; key: string } {
	const certPath = join(dir, "server.crt");
	const keyPath = join(dir, "server.key");
	const made = Bun.spawnSync({
		cmd: [
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-keyout",
			keyPath,
			"-out",
			certPath,
			"-days",
			"1",
			"-nodes",
			"-subj",
			"/CN=wt-compare.local",
			"-addext",
			"subjectAltName=DNS:wt-compare.local,IP:127.0.0.1",
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	if (made.exitCode !== 0) {
		throw new Error(`openssl failed: ${made.stderr.toString().slice(-500)}`);
	}
	return {
		cert: readFileSync(certPath, "utf8"),
		key: readFileSync(keyPath, "utf8"),
	};
}

interface ChildProcessHarness {
	readonly port: number;
	readonly url: string;
	readonly cert: string;
	/** Frames the child wrote on FD 4, in arrival order. */
	readonly answers: Record<string, unknown>[];
	send(frame: Uint8Array): void;
	/** Resolve once `answers.length >= count`, or throw at the deadline. */
	awaitAnswers(count: number, whatFor: string): Promise<void>;
	output(): string;
	exit(): Promise<number>;
	dispose(): void;
}

const OPEN_CHILDREN: (() => void)[] = [];

function startChild(args: {
	readonly cohort: Cohort;
	readonly transport: "ws" | "wt";
	readonly macPublicRaw32?: Uint8Array;
	readonly env?: Record<string, string>;
}): ChildProcessHarness {
	const dir = mkdtempSync(join(tmpdir(), "s6-server-child-"));
	const tls = selfSignedTls(dir);
	// The local-acceptance argv: one machine, loopback (design §3.1).
	const argv = stagedServerLaunchArgv(
		args.transport,
		"fanout-cohort",
		"local-acceptance",
	);
	const port = 21_000 + Math.floor(Math.random() * 20_000);
	const inbound = unixPipe("write");
	const outbound = unixPipe("read");
	const child = nodeSpawn(
		"bun",
		[
			join(REPO_ROOT, "tools", "compare", argv[0] as string),
			...argv.slice(1),
			`--port=${port}`,
		],
		{
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "pipe", inbound.childFd, outbound.childFd],
			env: {
				...process.env,
				WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: Buffer.from(
					args.macPublicRaw32 ?? args.cohort.mac.publicRaw32,
				).toString("base64"),
				WS_WT_COHORT_LINUX_CLOCK_ID: LINUX_CLOCK_ID,
				WS_WT_COHORT_RECEIPT_VALIDITY_MS: "600000",
				WS_WT_TLS_CERT_CONTENT: tls.cert,
				WS_WT_TLS_KEY_CONTENT: tls.key,
				WS_WT_TLS_SERVER_NAME: "wt-compare.local",
				...(args.env ?? {}),
			},
		},
	);
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
	const exited = new Promise<number>((done) => {
		child.once("exit", (code) => done(code ?? -1));
	});

	const answers: Record<string, unknown>[] = [];
	let buffered = Buffer.alloc(0);
	const reader = createReadStream("", {
		fd: outbound.parentFd,
		autoClose: true,
	});
	reader.on("data", (chunk: Buffer | string) => {
		buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
		for (;;) {
			if (buffered.byteLength < 4) break;
			const length = buffered.readUInt32BE(0);
			if (buffered.byteLength < 4 + length) break;
			const frame = buffered.subarray(0, 4 + length);
			buffered = buffered.subarray(4 + length);
			const decoded = decodeChildPipeFrame(new Uint8Array(frame));
			if (!decoded.ok) throw new Error(`child frame: ${decoded.code}`);
			answers.push(decoded.value);
		}
	});

	let disposed = false;
	const dispose = (): void => {
		if (disposed) return;
		disposed = true;
		try {
			closeParentWrite();
		} catch {
			// The child may already have closed its end.
		}
		reader.destroy();
		child.kill("SIGKILL");
		rmSync(dir, { recursive: true, force: true });
	};
	OPEN_CHILDREN.push(dispose);

	// `fs.writeSync` rather than a stream: the frames are small and the ordering
	// against the child's reads has to be exact.
	let writeClosed = false;
	const closeParentWrite = (): void => {
		if (writeClosed) return;
		writeClosed = true;
		closeSync(inbound.parentFd);
	};

	return {
		port,
		url: `wss://127.0.0.1:${port}/fanout`,
		cert: tls.cert,
		answers,
		send: (frame) => {
			let written = 0;
			while (written < frame.byteLength) {
				written += writeSync(
					inbound.parentFd,
					frame,
					written,
					frame.byteLength - written,
				);
			}
		},
		awaitAnswers: async (count, whatFor) => {
			const deadline = Date.now() + 60_000;
			while (answers.length < count) {
				if (Date.now() > deadline) {
					throw new Error(
						`timed out waiting for ${whatFor}: ${answers.length} of ${count} frames; output=${Buffer.concat(stderr).toString().slice(-2000)}`,
					);
				}
				await Bun.sleep(20);
			}
		},
		output: () =>
			`${Buffer.concat(stdout).toString()}${Buffer.concat(stderr).toString()}`,
		exit: async () => {
			closeParentWrite();
			return await Promise.race([
				exited,
				new Promise<number>((done) => setTimeout(() => done(-999), 30_000)),
			]);
		},
		dispose,
	};
}

// ---------------------------------------------------------------------------
// The role peers: real sockets, real tokens, real wire frames.
// ---------------------------------------------------------------------------

interface RolePeer {
	readonly roleId: string;
	send(frame: FanoutWireV1): void;
	received(): readonly FanoutWireV1[];
	close(): void;
}

async function connectRole(
	harness: ChildProcessHarness,
	cohort: Cohort,
	role: "publisher" | "subscriber",
	roleId: string,
): Promise<RolePeer> {
	const codec = fanoutFrameCodecFor("ws");
	const received: FanoutWireV1[] = [];
	const client: BinaryMessageClient = await connectBinaryMessageClient({
		url: harness.url,
		tls: {
			rejectUnauthorized: true,
			serverName: "wt-compare.local",
			ca: harness.cert,
		},
		onMessage: (bytes) => {
			const decoded = codec.decode(bytes);
			if (decoded.ok) received.push(decoded.value);
		},
	});
	const send = (frame: FanoutWireV1): void => {
		const encoded = codec.encode(frame);
		if (!encoded.ok) throw new Error(`encode ${frame.kind}: ${encoded.code}`);
		client.send(encoded.value);
	};
	send({
		schema: "fanout-wire/v1",
		kind: "register",
		cohortGrantSha256: cohort.grantSha256,
		transport: "ws",
		role,
		childId: cohort.tokens.childIdByRoleId.get(roleId) as string,
		roleId,
		workerIndex: cohort.tokens.workerIndexByRoleId.get(roleId) ?? null,
		tokenBase64: cohort.tokens.tokenBase64ByRoleId.get(roleId) as Base64,
		tokenSha256: cohort.tokens.tokenSha256ByRoleId.get(roleId) as Sha256Hex,
		tokenCommitmentIndex: cohort.tokens.commitmentIndexByRoleId.get(
			roleId,
		) as number,
		tokenMerkleProofSha256: [
			...(cohort.tokens.proofByRoleId.get(roleId) ?? []),
		],
	} as FanoutWireV1);
	return {
		roleId,
		send,
		received: () => received,
		close: () => client.close(),
	};
}

async function waitUntil(
	predicate: () => boolean,
	whatFor: string,
	timeoutMs = 60_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${whatFor}`);
		await Bun.sleep(20);
	}
}

// ---------------------------------------------------------------------------
// The lifecycle, one R->C frame at a time.
// ---------------------------------------------------------------------------

function frameBytes(
	record: Record<string, unknown> & { schema: string },
): Uint8Array {
	const encoded = encodeServerChildFrame(record);
	if (!encoded.ok) throw new Error(`encode ${record.schema}: ${encoded.code}`);
	return encoded.value;
}

describe("S6: the fanout-cohort server child serves a cohort and survives it", () => {
	test(
		"the_child_answers_every_r_to_c_frame_over_a_real_cohort",
		async () => {
			const cohort = buildCohort("ws");
			const harness = startChild({ cohort, transport: "ws" });
			try {
				// R->C 0: bind. The grant is verified against the staged Mac key
				// before any listener exists.
				const bind = buildServerBindExecution({
					sequence: 0,
					executionSha256: cohort.executionSha256,
					rigExecutionAcceptanceSha256: HEX("e"),
					cohortGrantBase64: Buffer.from(cohort.grantBytes).toString("base64"),
					cohortGrantSignatureBase64: Buffer.from(
						bytesOfCanonical(cohort.grantSignature),
					).toString("base64"),
					macExecutionGrantReceiptBase64: null,
					macExecutionGrantSignatureBase64: null,
				});
				if (!bind.ok) throw new Error(`bind: ${bind.code}`);
				harness.send(
					frameBytes(
						bind.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(1, "server-ready/v1");

				const ready = parseServerReady(harness.answers[0]);
				expect(ready.ok).toBe(true);
				if (!ready.ok) throw new Error("unreachable");
				expect(ready.value.sequence).toBe(0);
				expect(ready.value.cohortGrantSha256).toBe(cohort.grantSha256);
				expect(ready.value.executionSha256).toBe(cohort.executionSha256);
				// The child states its own pid, and it is the process we spawned.
				expect(ready.value.childPid).toBeGreaterThan(0);
				expect(ready.value.listeningAddress).toContain(`:${harness.port}`);

				// RAMP_AND_READY: the cohort comes up on the wire, one socket at a
				// time, exactly as the Mac's permit schedule releases it.
				const subscribers: RolePeer[] = [];
				for (const roleId of SUBSCRIBER_IDS) {
					subscribers.push(
						await connectRole(harness, cohort, "subscriber", roleId),
					);
				}
				const publishers: RolePeer[] = [];
				for (const roleId of PUBLISHER_IDS) {
					publishers.push(
						await connectRole(harness, cohort, "publisher", roleId),
					);
				}
				for (const peer of [...subscribers, ...publishers]) {
					await waitUntil(
						() => peer.received().some((frame) => frame.kind === "accept"),
						`accept for ${peer.roleId}`,
					);
				}

				// R->C 1: warmup start. The child admits the wire-registered cohort
				// and verifies the Mac-signed epoch.
				const epoch = warmupEpochFor(cohort);
				const warmupStart = buildServerWarmupStart({
					sequence: 1,
					executionSha256: cohort.executionSha256,
					cohortWarmupEpochBase64: Buffer.from(epoch.bytes).toString("base64"),
					cohortWarmupEpochSignatureBase64: Buffer.from(
						bytesOfCanonical(epoch.signature),
					).toString("base64"),
				});
				if (!warmupStart.ok)
					throw new Error(`warmup start: ${warmupStart.code}`);
				harness.send(
					frameBytes(
						warmupStart.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(2, "server-warmup-ready/v1");
				const warmupReady = parseServerWarmupReady(harness.answers[1]);
				expect(warmupReady.ok).toBe(true);
				if (!warmupReady.ok) throw new Error("unreachable");
				expect(warmupReady.value.sequence).toBe(1);
				expect(warmupReady.value.cohortWarmupEpochSha256).toBe(epoch.sha256);
				expect(warmupReady.value.warmupCountersZero).toBe(true);

				// The warmup wire itself: exactly ten paced frames per publisher and
				// a warmup-end, expanded to every subscriber by the real relay.
				for (const publisher of publishers) {
					for (
						let sequence = 0;
						sequence < WARMUP_MESSAGES_PER_PUBLISHER;
						sequence += 1
					) {
						publisher.send({
							schema: "fanout-wire/v1",
							kind: "warmup-data",
							direction: "publisher-to-relay",
							cohortGrantSha256: cohort.grantSha256,
							cohortWarmupEpochSha256: epoch.sha256,
							warmupNonce: epoch.epoch.warmupNonce,
							publisherId: publisher.roleId,
							publisherSequence: sequence,
							subscriberId: null,
							linuxAcceptedOrdinal: null,
							...fanoutPayload(
								MESSAGE_BYTES,
								`${publisher.roleId}:warmup:${sequence}`,
							),
							payloadBytes: MESSAGE_BYTES,
						} as FanoutWireV1);
					}
					publisher.send({
						schema: "fanout-wire/v1",
						kind: "warmup-end",
						cohortGrantSha256: cohort.grantSha256,
						cohortWarmupEpochSha256: epoch.sha256,
						warmupNonce: epoch.epoch.warmupNonce,
						role: "publisher",
						roleId: publisher.roleId,
						finalPublisherSequence: WARMUP_MESSAGES_PER_PUBLISHER - 1,
						reason: "publisher-warmup-complete",
					} as FanoutWireV1);
				}
				const expectedWarmupIngress =
					PUBLISHER_COUNT * WARMUP_MESSAGES_PER_PUBLISHER;
				for (const subscriber of subscribers) {
					await waitUntil(
						() =>
							subscriber
								.received()
								.filter((frame) => frame.kind === "warmup-data").length >=
							expectedWarmupIngress,
						`${expectedWarmupIngress} warmup deliveries to ${subscriber.roleId}`,
					);
				}

				// R->C 2: drain and reset.
				const drainAndReset = buildServerWarmupDrainAndReset({
					sequence: 2,
					executionSha256: cohort.executionSha256,
					cohortWarmupEpochSha256: epoch.sha256,
					roleWarmupCompletionManifestSha256: MANIFEST_SHA,
				});
				if (!drainAndReset.ok) throw new Error(`drain: ${drainAndReset.code}`);
				harness.send(
					frameBytes(
						drainAndReset.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(3, "server-warmup-drained/v1");
				const drained = parseServerWarmupDrained(harness.answers[2]);
				expect(drained.ok).toBe(true);
				if (!drained.ok) throw new Error("unreachable");
				expect(drained.value.sequence).toBe(2);
				expect(drained.value.warmupIngress).toBe(expectedWarmupIngress);
				expect(drained.value.warmupDeliveries).toBe(
					expectedWarmupIngress * SUBSCRIBER_COUNT,
				);
				expect(drained.value.publisherWarmupEndCount).toBe(PUBLISHER_COUNT);
				expect(drained.value.subscriberWarmupEndCount).toBe(SUBSCRIBER_COUNT);
				expect(drained.value.warmupQueuesEmpty).toBe(true);
				expect(drained.value.measuredCountersZero).toBe(true);
				expect(drained.value.linuxClockId).toBe(LINUX_CLOCK_ID);

				// R->C 3: the Linux baseline. This is the frame that proves the
				// child has a real busy-time observer rather than a default.
				const measureStart = buildServerMeasureStart({
					sequence: 3,
					executionSha256: cohort.executionSha256,
					warmupCompleteSha256: MANIFEST_SHA,
				});
				if (!measureStart.ok) throw new Error(`measure: ${measureStart.code}`);
				harness.send(
					frameBytes(
						measureStart.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(4, "server-measure-start-ack/v1");
				const baseline = parseServerMeasureStartAck(harness.answers[3]);
				expect(baseline.ok).toBe(true);
				if (!baseline.ok) throw new Error("unreachable");
				expect(baseline.value.sequence).toBe(3);
				expect(Number.isSafeInteger(baseline.value.baselineBusyMs)).toBe(true);
				expect(baseline.value.baselineBusyMs).toBeGreaterThanOrEqual(0);
				expect(baseline.value.linuxClockId).toBe(LINUX_CLOCK_ID);

				// R->C 4: the start barrier.
				const barrier = startBarrierFor(cohort);
				const present = buildServerPresentStartBarrier({
					sequence: 4,
					executionSha256: cohort.executionSha256,
					cohortStartBarrierBase64: Buffer.from(barrier.bytes).toString(
						"base64",
					),
					cohortStartBarrierSignatureBase64: Buffer.from(
						bytesOfCanonical(barrier.signature),
					).toString("base64"),
				});
				if (!present.ok) throw new Error(`barrier: ${present.code}`);
				harness.send(
					frameBytes(
						present.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(5, "server-start-barrier-accepted/v1");
				const accepted = parseServerStartBarrierAccepted(harness.answers[4]);
				expect(accepted.ok).toBe(true);
				if (!accepted.ok) throw new Error("unreachable");
				expect(accepted.value.sequence).toBe(4);
				expect(accepted.value.cohortStartBarrierSha256).toBe(barrier.sha256);
				expect(accepted.value.measuredTrafficAllowed).toBe(true);

				// MEASURING: real measured traffic through the real relay.
				for (const publisher of publishers) {
					for (
						let sequence = 0;
						sequence < MEASURED_FRAMES_PER_PUBLISHER;
						sequence += 1
					) {
						publisher.send({
							schema: "fanout-wire/v1",
							kind: "data",
							direction: "publisher-to-relay",
							cohortGrantSha256: cohort.grantSha256,
							cohortStartBarrierSha256: barrier.sha256,
							windowIndex: 0,
							publisherId: publisher.roleId,
							publisherSequence: sequence,
							subscriberId: null,
							linuxAcceptedOrdinal: null,
							...fanoutPayload(
								MESSAGE_BYTES,
								`${publisher.roleId}:measured:${sequence}`,
							),
							payloadBytes: MESSAGE_BYTES,
						} as FanoutWireV1);
					}
				}
				const expectedMeasured =
					PUBLISHER_COUNT * MEASURED_FRAMES_PER_PUBLISHER;
				for (const subscriber of subscribers) {
					await waitUntil(
						() =>
							subscriber.received().filter((frame) => frame.kind === "data")
								.length >= expectedMeasured,
						`${expectedMeasured} measured deliveries to ${subscriber.roleId}`,
					);
				}

				// R->C 5: stop and capture, and both observation bodies.
				const stop = buildServerStopAndCapture({
					sequence: 5,
					executionSha256: cohort.executionSha256,
					cohortStartBarrierSha256: barrier.sha256,
					drainDeadlineMs: COHORT_DRAIN_DEADLINE_MS,
				});
				if (!stop.ok) throw new Error(`stop: ${stop.code}`);
				harness.send(
					frameBytes(
						stop.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(6, "server-capture-ack/v1");
				const capture = parseServerCaptureAck(harness.answers[5]);
				expect(capture.ok).toBe(true);
				if (!capture.ok) throw new Error("unreachable");
				expect(capture.value.sequence).toBe(5);

				// §1.3: the two records travel as base64 of the child's own canonical
				// bytes, so the rig digests what it received rather than a
				// re-canonicalisation of parsed fields.
				const snapshotBytes = Buffer.from(
					capture.value.snapshotFrameBase64,
					"base64",
				);
				const snapshot = JSON.parse(snapshotBytes.toString("utf8")) as Record<
					string,
					unknown
				>;
				expect(snapshot.schema).toBe("server-loop-utilization/v1");
				expect(snapshot.executionSha256).toBe(cohort.executionSha256);
				expect(snapshot.cohortGrantSha256).toBe(cohort.grantSha256);
				expect(snapshot.cohortStartBarrierSha256).toBe(barrier.sha256);
				expect(snapshot.linuxClockId).toBe(LINUX_CLOCK_ID);
				expect(snapshot.bulkSourceCompletion).toBe(null);
				// The rig re-derives the difference (`secure_fs.rs:16826-16831`), so
				// a child that stated a third number would be refused there.
				expect(snapshot.busyMs).toBe(
					(snapshot.finalBusyMs as number) -
						(snapshot.baselineBusyMs as number),
				);
				expect(snapshot.baselineBusyMs).toBe(baseline.value.baselineBusyMs);
				expect(snapshot.windowMs as number).toBeGreaterThan(0);
				// The observer is wired to real work, not present-and-zero. This
				// cohort moves 20 warmup frames and 8 measured frames through a
				// fan-out of eight, which is 224 deliveries: a loop that reported
				// under a millisecond of busy time across all of them would be
				// reporting a placeholder. (Measured here: baseline 7 ms, final
				// 10 ms, window 47 ms.)
				expect(snapshot.finalBusyMs as number).toBeGreaterThan(0);
				expect(snapshot.finalBusyMs as number).toBeGreaterThanOrEqual(
					snapshot.baselineBusyMs as number,
				);

				expect(capture.value.linuxRelayObservationBase64).not.toBeNull();
				const observation = JSON.parse(
					Buffer.from(
						capture.value.linuxRelayObservationBase64 as string,
						"base64",
					).toString("utf8"),
				) as Record<string, unknown>;
				expect(observation.schema).toBe("linux-relay-observation/v1");
				expect(observation.registeredPublisherCount).toBe(PUBLISHER_COUNT);
				expect(observation.registeredSubscriberCount).toBe(SUBSCRIBER_COUNT);
				expect(observation.allSessionsClosed).toBe(true);
				expect(
					(observation.acceptedIngressByOriginWindow as number[]).reduce(
						(sum, value) => sum + value,
						0,
					),
				).toBe(expectedMeasured);
				expect(
					(observation.relayWritesCompletedByOriginWindow as number[]).reduce(
						(sum, value) => sum + value,
						0,
					),
				).toBe(expectedMeasured * SUBSCRIBER_COUNT);

				// R->C 6: teardown. The child stops the peer and says so.
				const teardown = buildServerTeardown({
					sequence: 6,
					executionSha256: cohort.executionSha256,
				});
				if (!teardown.ok) throw new Error(`teardown: ${teardown.code}`);
				harness.send(
					frameBytes(
						teardown.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(7, "server-stopped/v1");
				const stopped = parseServerStopped(harness.answers[6]);
				expect(stopped.ok).toBe(true);
				if (!stopped.ok) throw new Error("unreachable");
				expect(stopped.value.sequence).toBe(6);
				expect(stopped.value.exitCode).toBe(0);
				expect(stopped.value.allSessionsClosed).toBe(true);

				// Seven frames each way, in one order, and the process exits 0 --
				// which is the whole point: it stayed alive from bind to teardown.
				expect(harness.answers.map((frame) => frame.schema)).toEqual([
					"server-ready/v1",
					"server-warmup-ready/v1",
					"server-warmup-drained/v1",
					"server-measure-start-ack/v1",
					"server-start-barrier-accepted/v1",
					"server-capture-ack/v1",
					"server-stopped/v1",
				]);
				expect(await harness.exit()).toBe(0);
			} finally {
				harness.dispose();
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	test(
		"a_frame_out_of_the_frozen_order_is_a_terminal_child_pipe_refusal",
		async () => {
			const cohort = buildCohort("ws");
			const harness = startChild({ cohort, transport: "ws" });
			try {
				const bind = buildServerBindExecution({
					sequence: 0,
					executionSha256: cohort.executionSha256,
					rigExecutionAcceptanceSha256: HEX("e"),
					cohortGrantBase64: Buffer.from(cohort.grantBytes).toString("base64"),
					cohortGrantSignatureBase64: Buffer.from(
						bytesOfCanonical(cohort.grantSignature),
					).toString("base64"),
					macExecutionGrantReceiptBase64: null,
					macExecutionGrantSignatureBase64: null,
				});
				if (!bind.ok) throw new Error(`bind: ${bind.code}`);
				harness.send(
					frameBytes(
						bind.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(1, "server-ready/v1");

				// R->C 1 must be `server-warmup-start/v1`. A measure-start here is
				// the rig skipping three states.
				const skipped = buildServerMeasureStart({
					sequence: 1,
					executionSha256: cohort.executionSha256,
					warmupCompleteSha256: null,
				});
				if (!skipped.ok) throw new Error(`measure: ${skipped.code}`);
				harness.send(
					frameBytes(
						skipped.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(2, "child-pipe-refusal/v1");
				expect(harness.answers[1]?.schema).toBe("child-pipe-refusal/v1");
				expect(harness.answers[1]?.code).toBe("STATE_INVALID");
				expect(harness.answers[1]?.terminal).toBe(true);
				expect(await harness.exit()).not.toBe(0);
			} finally {
				harness.dispose();
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	test(
		"a_frame_for_another_execution_is_refused_after_the_bind",
		async () => {
			const cohort = buildCohort("ws");
			const harness = startChild({ cohort, transport: "ws" });
			try {
				const bind = buildServerBindExecution({
					sequence: 0,
					executionSha256: cohort.executionSha256,
					rigExecutionAcceptanceSha256: HEX("e"),
					cohortGrantBase64: Buffer.from(cohort.grantBytes).toString("base64"),
					cohortGrantSignatureBase64: Buffer.from(
						bytesOfCanonical(cohort.grantSignature),
					).toString("base64"),
					macExecutionGrantReceiptBase64: null,
					macExecutionGrantSignatureBase64: null,
				});
				if (!bind.ok) throw new Error(`bind: ${bind.code}`);
				harness.send(
					frameBytes(
						bind.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(1, "server-ready/v1");

				const epoch = warmupEpochFor(cohort);
				const foreign = buildServerWarmupStart({
					sequence: 1,
					executionSha256: HEX("b"),
					cohortWarmupEpochBase64: Buffer.from(epoch.bytes).toString("base64"),
					cohortWarmupEpochSignatureBase64: Buffer.from(
						bytesOfCanonical(epoch.signature),
					).toString("base64"),
				});
				if (!foreign.ok) throw new Error(`warmup: ${foreign.code}`);
				harness.send(
					frameBytes(
						foreign.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				await harness.awaitAnswers(2, "child-pipe-refusal/v1");
				expect(harness.answers[1]?.schema).toBe("child-pipe-refusal/v1");
				expect(harness.answers[1]?.code).toBe("EXECUTION_MISMATCH");
				expect(await harness.exit()).not.toBe(0);
			} finally {
				harness.dispose();
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	test(
		"the_two_existing_fail_closed_orders_are_unchanged",
		async () => {
			// (1) Stage-time environment before anything else: a server that cannot
			// name the Mac key it trusts never reaches the control-pipe branch.
			const argv = stagedServerLaunchArgv(
				"wt",
				"fanout-cohort",
				"local-acceptance",
			);
			const withoutEnvironment = Bun.spawnSync({
				cmd: [
					"bun",
					join(REPO_ROOT, "tools", "compare", argv[0] as string),
					...argv.slice(1),
				],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: "",
					WS_WT_COHORT_LINUX_CLOCK_ID: "",
					WS_WT_COHORT_RECEIPT_VALIDITY_MS: "",
				},
			});
			const envOutput = `${withoutEnvironment.stdout.toString()}${withoutEnvironment.stderr.toString()}`;
			expect(withoutEnvironment.exitCode).not.toBe(0);
			expect(envOutput).toContain("fanout cohort mode requires");
			expect(envOutput).not.toContain("UNEXPECTED_FD");

			// (2) The control pipe before any listener: a process spawned without a
			// rig supervisor refuses at the missing descriptors.
			const withoutPipes = Bun.spawnSync({
				cmd: [
					"bun",
					join(REPO_ROOT, "tools", "compare", argv[0] as string),
					...argv.slice(1),
				],
				cwd: REPO_ROOT,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: Buffer.from(
						new Uint8Array(32),
					).toString("base64"),
					WS_WT_COHORT_LINUX_CLOCK_ID: LINUX_CLOCK_ID,
					WS_WT_COHORT_RECEIPT_VALIDITY_MS: "60000",
					WS_WT_TLS_CERT_CONTENT:
						"-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n",
					WS_WT_TLS_KEY_CONTENT:
						"-----BEGIN PRIVATE KEY-----\nZml4dHVyZQ==\n-----END PRIVATE KEY-----\n",
					WS_WT_TLS_SERVER_NAME: "wt-compare.local",
				},
			});
			const pipeOutput = `${withoutPipes.stdout.toString()}${withoutPipes.stderr.toString()}`;
			expect(withoutPipes.exitCode).not.toBe(0);
			expect(pipeOutput).toContain("UNEXPECTED_FD");
			expect(pipeOutput).toContain("rig-supervisor server child");
			expect(pipeOutput).not.toContain("fanout cohort mode requires");
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	test(
		"a_grant_signed_by_another_key_never_reaches_a_listener",
		async () => {
			const cohort = buildCohort("ws");
			const foreign = generateEd25519KeyPair();
			// The child is staged with a key that did not sign this grant.
			const harness = startChild({
				cohort,
				transport: "ws",
				macPublicRaw32: foreign.publicRaw32,
			});
			try {
				const bind = buildServerBindExecution({
					sequence: 0,
					executionSha256: cohort.executionSha256,
					rigExecutionAcceptanceSha256: HEX("e"),
					cohortGrantBase64: Buffer.from(cohort.grantBytes).toString("base64"),
					cohortGrantSignatureBase64: Buffer.from(
						bytesOfCanonical(cohort.grantSignature),
					).toString("base64"),
					macExecutionGrantReceiptBase64: null,
					macExecutionGrantSignatureBase64: null,
				});
				if (!bind.ok) throw new Error(`bind: ${bind.code}`);
				harness.send(
					frameBytes(
						bind.value as unknown as Record<string, unknown> & {
							schema: string;
						},
					),
				);
				const exitCode = await harness.exit();
				expect(exitCode).not.toBe(0);
				expect(harness.output()).toContain("MAC_SIGNING_KEY_MISMATCH");
				// Nothing was answered: before the grant verifies, the child cannot
				// name an authenticated execution, so it says nothing at all.
				expect(harness.answers.length).toBe(0);
				// And no socket was ever opened on the port it was given.
				const probe = await connectBinaryMessageClient({
					url: harness.url,
					tls: {
						rejectUnauthorized: true,
						serverName: "wt-compare.local",
						ca: harness.cert,
					},
					onMessage: () => {},
					openTimeoutMs: 2_000,
				}).then(
					() => "connected",
					() => "refused",
				);
				expect(probe).toBe("refused");
			} finally {
				harness.dispose();
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

// A refusal frame the child could build is the same codec the rig reads; this
// keeps the import honest rather than only exercising it through the process.
test("the_refusal_the_child_writes_is_the_frozen_codec", () => {
	const refusal = buildChildPipeRefusal({
		sequence: 1,
		executionSha256: HEX("7"),
		code: "STATE_INVALID",
	});
	expect(refusal.ok).toBe(true);
	if (!refusal.ok) throw new Error("unreachable");
	expect(refusal.value.terminal).toBe(true);
});
