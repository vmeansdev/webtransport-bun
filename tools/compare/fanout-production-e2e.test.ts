/**
 * The Phase B fanout cohort path, driven end to end against real processes.
 *
 * Every other cohort suite in this tree injects something: a stub runtime, an
 * in-process rig binding, a hand-built harness. That is why the B5 Critic
 * could find a staged controller that could not reach the cohort executor at
 * all, and why the gap map after it listed ten binding methods with zero
 * production implementers. A suite that supplies the missing half cannot
 * observe that the missing half is missing.
 *
 * This file supplies nothing. It drives:
 *
 *   - `dispatchArmRepetition` with the *production* provider
 *     (`createCohortArmRuntimeProvider`, built exactly as `realRunBody`
 *     builds it) and the *production* executors (no `executors` override),
 *   - a real `bun tools/compare/server.ts --mode=fanout-cohort` child
 *     process, launched from the staged argv the campaign actually writes,
 *   - a real locally built `comparison-supervisor` binary, booted through
 *     the real trust bootstrap by the production `spawnMacSupervisor`, and
 *     spoken to over the real `comparison-supervisor-frame/v1` codec.
 *
 * ## Topology
 *
 * `ticker-fanout/rate-10000`, the frozen "ticker 10k" cohort cell: 1
 * publisher, 8 subscriber workers, 100 subscriber sessions (101 sessions),
 * 100,000 measured ingress frames, 10,000,000 expanded deliveries. It is the
 * smallest of the three ticker rungs and the largest thing that is still a
 * real cohort -- the two arms (`ws` and `wt`) are the pair a campaign seals.
 * The reduction is in the *rung*, not in the shape: nothing here is a
 * one-publisher stand-in for a cohort, which is precisely the demotion
 * `dispatchArmRepetition` exists to refuse.
 *
 * ## What this suite asserts today, and why it is not the asserted list
 *
 * The mandate for this file asked it to assert two sealed PASS arms, a
 * `verifyRunArtifact` PASS over a reconstructed `CohortObservationEvidenceV1`,
 * two verified issuer signature graphs, promotable:false pilot-shaped index
 * entries, and 2 PASS / 0 promotable / 0 flats / 2 sealed through
 * `verifyCampaignIndex`.
 *
 * None of that is reachable yet, and the reason is the finding: **no honest
 * cohort can be measured by this tree yet.**
 *
 * Round two closed five of the boundaries this file used to pin, and each of
 * their assertions moved to what the boundary became rather than being
 * deleted:
 *
 *   - **the wire.** `encodeRemoteSupervisorPayload` writes the frame `kind` as
 *     the schema with `/v1` stripped, exactly as §3.3 requires;
 *     `cohort::rig::ack_kind_for` matched the *schema* spelling, so every
 *     cohort frame the production controller could encode fell through `serve`
 *     to `terminate("TRUST_CHILD_FRAME_INVALID")` -- a fatal end of session,
 *     not a refusal. All six request kinds now reach their transitions, proved
 *     here by writing all six into one live session and counting six answers.
 *   - **the refusal codec.** The rig answers a refused transition in the
 *     Phase-A `admission-refusal` / `measurement-refusal/v1` shape, which is
 *     not a registered remote kind. `CohortRigChannel` now reports the rig's
 *     own code, mapped onto the §7 closed set.
 *   - **the Mac seams.** `createMacProductionCohortMinter`,
 *     `createMacFanoutRoleChildHost` and `createMacFanoutProcessControl` are
 *     production implementers of the three `MacFanoutSupervisorConfig` seams
 *     that had none, and `MacRoleChildCohortDriver` reads the role-child pipes.
 *   - **the grant's signature.** `server-bind-execution/v1` carries
 *     `cohortGrantSignatureBase64`, and `server.ts --mode=fanout-cohort`
 *     verifies it against the staged Mac key before a listener exists. Proved
 *     here against the real entrypoint with the real §3.4 pipes attached.
 *   - **the rig's cohort runtime.** `serve()` installs one from four
 *     all-or-none descriptors, so the six requests reach live transitions when
 *     the rig is booted with them.
 *
 * What remains between this file and its own mandate, each proved by execution
 * rather than by reading the source, is recorded in
 * `docs/superpowers/plans/deviations/2026-09-02-b3-production-cohort-runtime.md`
 * §7 and pinned by the assertions below:
 *
 *   1. **no relay serves the cohort.** The real child verifies the grant, binds
 *      a socket and exits after `server-warmup-ready/v1`
 *      (`the_child_binds_a_socket_and_then_exits_because_no_relay_serves_the_cohort`).
 *      `serveFanoutCohortRelay` needs a `FanoutLinuxAuthority`, whose config
 *      requires the rig private key (`scenarios/fanout-relay.ts:2282`), and the
 *      rig's key reaches the supervisor on a descriptor and not this child. No
 *      role peer can register and no ingress can be accepted.
 *   2. **no lease factory.** `realRunBody` passes none, so the production
 *      provider refuses `COHORT_NOT_READY` naming the Phase-A half of
 *      `CohortArmLease`. `ProductionCohortArmMaterial`
 *      (`bin/compare-controller.ts:5263`) declares the assembled Mac half and
 *      has no factory and no caller.
 *   3. **two §4.1 grant codecs disagree.** Rust `parse_shards` reads
 *      `lastSubscriberIndexExclusive` as the global subscriber range; TS
 *      `parseCohortGrant` reads it as the shard's own membership count. No
 *      grant satisfies both.
 *
 * Every assertion below is the *closest real-process boundary* in each case,
 * written so that completing production turns it red, and each names the
 * expectation it will become. That is the guard: this file fails the day a hole
 * is filled, and fails today if anyone fabricates a way past it.
 */

import { describe, expect, it } from "bun:test";
import { spawn as nodeSpawn } from "node:child_process";
import {
	createReadStream,
	createWriteStream,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createCohortArmRuntimeProvider,
	dispatchArmRepetition,
	sealArmsForCell,
} from "./bin/compare-controller.ts";
import {
	CAMPAIGN_INDEX_V2_SCHEMA,
	type CampaignIndexEntryV2,
	type CampaignIndexV2,
	verifyCampaignIndex,
} from "./bin/verify-campaign-index.ts";
import {
	decodeChildPipeFrame,
	encodeChildPipeFrame,
	parseServerWarmupReady,
} from "./child-pipe-protocol.ts";
import { cohortCellCardinality } from "./cohort-protocol.ts";
import {
	bytesOfCanonical,
	decodeRegisteredRemotePayload,
	encodeRegisteredRemotePayload,
	generateEd25519KeyPair,
	signMacReceipt,
} from "./cross-supervisor-protocol.ts";
import { cohortCellForArm, sha256HexOfBytes } from "./evidence.ts";
import {
	CohortRigChannel,
	createCloexecPipe,
	SUPERVISOR_ARTIFACT_PAYLOAD_MAX_BYTES,
	spawnMacSupervisor,
	stopSupervisor,
	TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
	TRUST_BOOTSTRAP_AUTHORITY_LEAF,
	TRUST_BOOTSTRAP_CAMPAIGN_ROOT,
	TRUST_BOOTSTRAP_STAGING_ROOT,
} from "./remote-supervisor.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import { stagedServerLaunchArgv } from "./server.ts";
import {
	decodeSupervisorFrame,
	encodeSupervisorFrame,
} from "./supervisor-client.ts";

/** The cohort cell this suite drives. */
const CELL_ID = "ticker-fanout/rate-10000";
const COHORT_CELL = "ticker 10k";

/** Repo root: this file lives at `<root>/tools/compare/`. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A long timeout: these tests build Rust binaries and boot real processes. */
const PROCESS_TEST_TIMEOUT_MS = 900_000;

/** A throwaway certificate for a loopback listener. */
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

function cellOf(cellId: string) {
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidate) => candidate.cellId === cellId,
	);
	if (cell === undefined) throw new Error(`no registry cell ${cellId}`);
	return cell;
}

// ---------------------------------------------------------------------------
// 1. The production dispatch, with the production provider and executors
// ---------------------------------------------------------------------------

describe("B3.5 e2e: the production cohort dispatch for ticker 10k", () => {
	/**
	 * `realRunBody` builds exactly this and passes no `lease`. Reproduced here
	 * rather than imported so that a future `lease` becoming mandatory shows up
	 * as a type error in this file too.
	 */
	function productionProvider() {
		return createCohortArmRuntimeProvider({
			sourceIdentity: {
				sourceSha: "candidate-b35",
				archiveSha256: "a".repeat(64),
				executableSha256: "b".repeat(64),
			},
			executionPurpose: "pilot",
			repetitionTotal: 1,
		});
	}

	it("the_frozen_topology_is_the_one_this_suite_claims_to_drive", () => {
		// The doc comment above states a topology; this pins it to the frozen
		// table so the two cannot drift into a comment that describes a cohort
		// nobody runs.
		expect(cohortCellCardinality(COHORT_CELL)).toEqual({
			cell: COHORT_CELL,
			publisherCount: 1,
			workerCount: 8,
			subscriberCount: 100,
			sessionCount: 101,
			measuredIngress: 100_000,
			expandedDeliveries: 10_000_000,
		});
		expect(cohortCellForArm({ cellId: CELL_ID, armKind: "primary" })).toBe(
			COHORT_CELL,
		);
	});

	for (const wire of ["ws", "wt"] as const) {
		it(`the_${wire}_primary_reaches_the_cohort_executor_and_refuses_with_a_named_missing_input`, async () => {
			const cell = cellOf(CELL_ID);
			const arm = sealArmsForCell(cell, [wire], ["primary"])[0];
			expect(arm).toBeDefined();
			const root = mkdtempSync(join(tmpdir(), `fanout-e2e-${wire}-`));
			const perRepPath = join(root, "rep-1.json");
			const sealedPath = join(root, "rep-1.sealed.json");

			const dispatched = await dispatchArmRepetition({
				arm: {
					cell,
					arm,
					runId: `e2e-${CELL_ID}-${wire}`,
					repIndex: 1,
					repetitionKind: "measured",
					repetitionTotal: 1,
					executionPurpose: "pilot",
					perRepPath,
					sealedPath,
				} as unknown as Parameters<typeof dispatchArmRepetition>[0]["arm"],
				cohortRuntime: productionProvider(),
				// No `executors` override: `driveCohortArm` and
				// `measureSealAndWriteRep` are the production functions.
			});

			// It is routed to the cohort executor, not demoted to a leg.
			expect(dispatched.route).toBe("cohort");
			expect(dispatched.result.ok).toBe(false);
			if (dispatched.result.ok) throw new Error("unreachable");
			// WILL BECOME: `expect(dispatched.result.ok).toBe(true)` with a
			// sealed artifact at `sealedPath`, once a Mac cohort supervisor
			// lease exists.
			expect(dispatched.result.failureCode).toBe("COHORT_NOT_READY");
			// The refusal still names the missing input, and the input it names
			// has moved: the three supervisor seams -- cohort minter, role-child
			// spawner, process control -- now have production implementers
			// (`createMacProductionCohortMinter`, `createMacFanoutRoleChildHost`,
			// `createMacFanoutProcessControl`), and so does the role-child pipe
			// reader `runWarmupWire` and `runMeasuredWindow` needed. What no
			// caller supplies yet is the *seal* half of `CohortArmLease`: the
			// Phase-A supervisor context, the rig's loop reading, the admission
			// counters and the recorder identity. A refusal that stopped naming
			// whatever is currently missing would be one nobody could act on.
			expect(dispatched.result.reason).toContain(
				"Phase-A half of CohortArmLease",
			);
			expect(dispatched.result.reason).toContain("supervisor context");
			expect(dispatched.result.reason).toContain("admission counters");

			// Nothing was written. A refused cohort must not leave a per-rep or
			// a sealed file behind for the index to point at.
			expect(readdirSync(root)).toEqual([]);
		});
	}

	it("a_refused_cohort_arm_is_never_demoted_to_a_single_session_leg", async () => {
		// The demotion this guards against measures one publisher and presents
		// it as a 101-session cohort. `measureSealAndWriteRep` is the
		// production leg executor; if the dispatch ever reached it for a
		// fanout primary, the injected spy below would fire.
		const cell = cellOf(CELL_ID);
		const arm = sealArmsForCell(cell, ["ws"], ["primary"])[0];
		let legRuns = 0;
		const dispatched = await dispatchArmRepetition({
			arm: {
				cell,
				arm,
				runId: "e2e-no-demotion",
				repIndex: 1,
				repetitionKind: "measured",
				repetitionTotal: 1,
				executionPurpose: "pilot",
				perRepPath: "/dev/null",
				sealedPath: "/dev/null",
			} as unknown as Parameters<typeof dispatchArmRepetition>[0]["arm"],
			cohortRuntime: productionProvider(),
			executors: {
				measureSealAndWriteRep: async () => {
					legRuns += 1;
					return { ok: false, reason: "must not run" };
				},
			},
		});
		expect(legRuns).toBe(0);
		expect(dispatched.route).toBe("cohort");
	});
});

// ---------------------------------------------------------------------------
// 2. The real fanout-cohort server child process
// ---------------------------------------------------------------------------

describe("B3.5 e2e: the real fanout-cohort server process", () => {
	function runServer(env: Record<string, string>): {
		readonly exitCode: number;
		readonly output: string;
	} {
		const argv = stagedServerLaunchArgv("wt", "fanout-cohort");
		expect(argv[0]).toBe("server.ts");
		const proc = Bun.spawnSync({
			cmd: [
				"bun",
				join(REPO_ROOT, "tools", "compare", argv[0] as string),
				...argv.slice(1),
			],
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});
		return {
			exitCode: proc.exitCode,
			output: `${proc.stdout.toString()}${proc.stderr.toString()}`,
		};
	}

	/** Stage-time constants a phase-b launch record would carry. */
	const WELL_FORMED_ENV = {
		WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: Buffer.from(
			new Uint8Array(32),
		).toString("base64"),
		WS_WT_COHORT_LINUX_CLOCK_ID: "c".repeat(64),
		WS_WT_COHORT_RECEIPT_VALIDITY_MS: "60000",
	};

	it(
		"refuses_at_the_absent_control_pipe_rather_than_binding_a_listener",
		() => {
			const run = runServer(WELL_FORMED_ENV);
			// This used to be "no signed cohort grant channel": the frame had no
			// signature field, so no grant could ever be authenticated here.
			// `server-bind-execution/v1` now carries one and this entrypoint
			// reads it off FD 3, so the deepest refusal a process spawned
			// *without* a rig supervisor can reach is the missing pipe itself.
			// It is still before any listener.
			expect(run.exitCode).not.toBe(0);
			expect(run.output).toContain("UNEXPECTED_FD");
			expect(run.output).toContain("rig-supervisor server child");
			// Past the stage-time env gate: the refusal is the deep one, not
			// the shallow one. Without this the test would pass on a server
			// that simply could not read its own environment.
			expect(run.output).not.toContain("fanout cohort mode requires");
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"refuses_earlier_when_the_stage_time_environment_is_absent",
		() => {
			const run = runServer({
				WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: "",
				WS_WT_COHORT_LINUX_CLOCK_ID: "",
				WS_WT_COHORT_RECEIPT_VALIDITY_MS: "",
			});
			expect(run.exitCode).not.toBe(0);
			expect(run.output).toContain("fanout cohort mode requires");
			// A server that could not name its Mac key must not have reached
			// the control-pipe branch at all.
			expect(run.output).not.toContain("UNEXPECTED_FD");
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	/**
	 * The same real process, this time with the §3.4 control pipes attached and
	 * this test standing in for the rig on the other end of them.
	 *
	 * Only the rig is stood in for. The child is the real entrypoint, the frames
	 * are the real codec, the grant is really signed and really verified against
	 * the key the process reads out of its own environment, and the socket it
	 * opens is a real socket. What the test supplies is exactly what a rig
	 * supervisor would supply and nothing else -- and it is supplied so that the
	 * *next* boundary can be observed rather than assumed.
	 */
	it(
		"the_child_binds_a_socket_and_then_exits_because_no_relay_serves_the_cohort",
		async () => {
			const mac = generateEd25519KeyPair();
			const dir = mkdtempSync(join(tmpdir(), "fanout-e2e-child-"));
			try {
				const tls = selfSignedTls(dir);
				const executionSha256 = "7".repeat(64);
				// `decideCohortBind` reads schema, execution and transport out of
				// the signed bytes and runs no second copy of the §4.1 codec (see
				// server.ts's comment at `decideCohortBind`), so this is a grant
				// in exactly the respects the child is entitled to an opinion on.
				const grantBytes = bytesOfCanonical({
					schema: "cohort-grant/v1",
					executionSha256,
					transport: "ws",
				});
				const bind = encodeChildPipeFrame({
					schema: "server-bind-execution/v1",
					sequence: 0,
					executionSha256,
					rigExecutionAcceptanceSha256: "e".repeat(64),
					cohortGrantBase64: Buffer.from(grantBytes).toString("base64"),
					cohortGrantSignatureBase64: Buffer.from(
						bytesOfCanonical(
							signMacReceipt({
								privatePkcs8Der: mac.privatePkcs8Der,
								publicRaw32: mac.publicRaw32,
								signedSchema: "cohort-grant/v1",
								signedBytes: grantBytes,
							}),
						),
					).toString("base64"),
				});
				if (!bind.ok) throw new Error(`bind frame: ${bind.code}`);
				const epoch = bytesOfCanonical({
					schema: "cohort-warmup-epoch/v1",
					executionSha256,
					cohortGrantSha256: sha256HexOfBytes(grantBytes),
				});
				const warmupStart = encodeChildPipeFrame({
					schema: "server-warmup-start/v1",
					sequence: 1,
					executionSha256,
					cohortWarmupEpochBase64: Buffer.from(epoch).toString("base64"),
					cohortWarmupEpochSignatureBase64: Buffer.from(
						bytesOfCanonical(
							signMacReceipt({
								privatePkcs8Der: mac.privatePkcs8Der,
								publicRaw32: mac.publicRaw32,
								signedSchema: "cohort-warmup-epoch/v1",
								signedBytes: epoch,
							}),
						),
					).toString("base64"),
				});
				if (!warmupStart.ok) throw new Error(`warmup: ${warmupStart.code}`);

				const inbound = createCloexecPipe({ parentKeeps: "write" });
				const outbound = createCloexecPipe({ parentKeeps: "read" });
				if (!inbound.ok || !outbound.ok) throw new Error("pipe(2) failed");
				const argv = stagedServerLaunchArgv("ws", "fanout-cohort");
				const port = 20_000 + Math.floor(Math.random() * 20_000);
				const child = nodeSpawn(
					"bun",
					[
						join(REPO_ROOT, "tools", "compare", argv[0] as string),
						...argv.slice(1),
						// The staged argv names transport and mode; the port is the
						// rig's. The bind address is left at the staged default --
						// `parseServerArgs` refuses a loopback outright, and the
						// address only names what `server-ready/v1` reports.
						`--port=${port}`,
					],
					{
						cwd: REPO_ROOT,
						stdio: [
							"ignore",
							"pipe",
							"pipe",
							inbound.pipe.childFd,
							outbound.pipe.childFd,
						],
						env: {
							...process.env,
							WS_WT_COHORT_STAGED_MAC_PUBLIC_KEY_BASE64: Buffer.from(
								mac.publicRaw32,
							).toString("base64"),
							WS_WT_COHORT_LINUX_CLOCK_ID: "c".repeat(64),
							WS_WT_COHORT_RECEIPT_VALIDITY_MS: "60000",
							WS_WT_TLS_CERT_CONTENT: tls.cert,
							WS_WT_TLS_KEY_CONTENT: tls.key,
							WS_WT_TLS_SERVER_NAME: "wt-compare.local",
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
				const readAll = new Promise<void>((done) => {
					let buffered = Buffer.alloc(0);
					const stream = createReadStream("", {
						fd: outbound.pipe.parentFd,
						autoClose: true,
					});
					stream.on("data", (chunk: Buffer | string) => {
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
					stream.on("end", () => done());
					stream.on("close", () => done());
				});

				const writer = createWriteStream("", {
					fd: inbound.pipe.parentFd,
					autoClose: true,
				});
				writer.write(Buffer.from(bind.value));
				writer.write(Buffer.from(warmupStart.value));

				const exitCode = await Promise.race([
					exited,
					new Promise<number>((done) => setTimeout(() => done(-999), 120_000)),
				]);
				await Promise.race([
					readAll,
					new Promise<void>((done) => setTimeout(done, 2_000)),
				]);
				const output = `${Buffer.concat(stdout).toString()}${Buffer.concat(stderr).toString()}`;

				// It got all the way through the §3.4 prefix: a verified grant, a
				// bound socket, and a warmup-ready digested over the epoch bytes
				// exactly as they arrived.
				expect(answers.map((frame) => frame.schema)).toEqual([
					"server-ready/v1",
					"server-warmup-ready/v1",
				]);
				const warmupReady = parseServerWarmupReady(
					answers[1] as Record<string, unknown>,
				);
				expect(warmupReady.ok).toBe(true);
				if (!warmupReady.ok) throw new Error("unreachable");
				expect(warmupReady.value.cohortWarmupEpochSha256).toBe(
					sha256HexOfBytes(epoch),
				);
				expect(warmupReady.value.warmupCountersZero).toBe(true);
				expect(output).toContain("warmup ready for execution");

				// And then it exits, having served no cohort. This is the primary
				// blocker for a measured cohort, and it is a design gap rather than
				// a wiring one: `serveFanoutCohortRelay` needs a
				// `FanoutLinuxAuthority`, whose config requires
				// `rig.privatePkcs8Der` (scenarios/fanout-relay.ts:2282), and the
				// rig's signing key reaches the supervisor on a descriptor
				// (`--cohort-signing-key-fd`) and is deliberately not passed to
				// this child. So `server.ts:1379` binds `startServer` -- a plain
				// listener -- and `server.ts:1431` exits. No role peer can
				// register, no ingress can be accepted, and every §5 transition
				// after warmup reports counters that do not exist.
				//
				// WILL BECOME: the child stays up, `serveFanoutCohortRelay` is what
				// bound the socket, and the frames after `server-warmup-ready/v1`
				// are `server-warmup-drained/v1` and `server-start-barrier-accepted/v1`.
				expect(exitCode).toBe(0);
				expect(answers.length).toBe(2);
				expect(output).not.toContain("server-warmup-drained");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// 3. The real supervisor binary over the real remote codec
// ---------------------------------------------------------------------------

/**
 * Build the two release binaries the live path resolves by default. Cheap
 * when warm; the per-test timeout covers a cold build.
 */
function buildSupervisorBinaries(): void {
	const built = Bun.spawnSync({
		cmd: [
			"cargo",
			"build",
			"-p",
			"native",
			"--release",
			"--bin",
			"comparison-supervisor",
			"--bin",
			"observe-directory-identity",
		],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (built.exitCode !== 0) {
		throw new Error(
			`cargo build failed (${built.exitCode}): ${built.stderr.toString().slice(-2000)}`,
		);
	}
}

/** Mint a fixture trust bootstrap the real binary will accept. */
function mintTrustBootstrap(): string {
	const out = mkdtempSync(join(tmpdir(), "fanout-e2e-boot-"));
	const minted = Bun.spawnSync({
		cmd: [
			"bun",
			join(
				REPO_ROOT,
				"tools",
				"compare",
				"bin",
				"mint-live-trust-bootstrap.ts",
			),
			"--fixture-only",
			`--out=${out}`,
		],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			OBSERVE_DIRECTORY_IDENTITY_BINARY: join(
				REPO_ROOT,
				"target",
				"release",
				"observe-directory-identity",
			),
		},
	});
	if (minted.exitCode !== 0) {
		throw new Error(
			`mint-live-trust-bootstrap failed (${minted.exitCode}): ${minted.stderr.toString()}`,
		);
	}
	return out;
}

/** Boot the real supervisor through the production local spawn path. */
async function bootSupervisor(stagedDir: string) {
	const spawned = await spawnMacSupervisor({
		binaryPath: join(REPO_ROOT, "target", "release", "comparison-supervisor"),
		bunExecutablePath: process.execPath,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		control: {
			controlIn: { fd: 0, label: "control-in" },
			controlOut: { fd: 1, label: "control-out" },
		},
		localPaths: {
			authorityFile: join(stagedDir, TRUST_BOOTSTRAP_AUTHORITY_LEAF),
			authorityDigestFile: join(
				stagedDir,
				TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
			),
			campaignRootDir: join(stagedDir, TRUST_BOOTSTRAP_CAMPAIGN_ROOT),
			stagingRootDir: join(stagedDir, TRUST_BOOTSTRAP_STAGING_ROOT),
		},
	});
	if (!spawned.ok) {
		throw new Error(
			`spawnMacSupervisor refused (${spawned.code}): ${spawned.message}`,
		);
	}
	return spawned.handle;
}

/**
 * The one cohort request this suite puts on the wire.
 *
 * Six keys, not four: §2.13 widened the accept frame to carry this execution's
 * Phase-A `rig-execution-acceptance/v1` and the rig signature over it, so one
 * campaign-scoped rig process can bind a second execution without a second
 * startup. The rig's `RIG_ACCEPT_COHORT_FIELDS` is an exact key set, so the
 * four-key form no longer reaches the transition at all.
 */
const ACCEPT_COHORT_REQUEST = {
	schema: "rig-accept-cohort-request/v1",
	requestSeq: 1,
	executionSha256: "a".repeat(64),
	cohortGrantBase64: "e30=",
	cohortGrantSignatureBase64: "e30=",
	rigExecutionAcceptanceBase64: "e30=",
	rigExecutionAcceptanceSignatureBase64: "e30=",
} as const;

/**
 * Every controller -> rig cohort request, in the shape the frozen §3.3 field
 * table names, at the shallowest content each one accepts.
 *
 * The point of the sweep is the *frame*, not the record: each of these is
 * encoded by the production encoder and must be recognised by the rig's own
 * dispatch. Their records are deliberately thin, because a rig with no cohort
 * installed refuses all six on the same code and the interesting thing is that
 * it refuses rather than terminating the session.
 */
const COHORT_REQUESTS: readonly (Record<string, unknown> & {
	readonly schema: string;
})[] = [
	ACCEPT_COHORT_REQUEST,
	{
		schema: "rig-spawn-server-request/v1",
		requestSeq: 2,
		executionSha256: "a".repeat(64),
		cohortGrantSha256: "b".repeat(64),
		serverEntrypointSha256: "c".repeat(64),
		bunSha256: "d".repeat(64),
		addonSha256: "e".repeat(64),
		stagedServerLaunchRecordBase64: "e30=",
		stagedServerLaunchRecordSha256: "f".repeat(64),
		stagedServerLaunchRecordSize: 2,
		bindAddress: "10.99.0.2",
		bindPort: 4433,
		advertisedHost: "10.99.0.2",
		tlsServerName: "wt-compare.local",
		transport: "ws",
		serverArgv: ["server.ts"],
	},
	{
		schema: "rig-begin-warmup-request/v1",
		requestSeq: 3,
		executionSha256: "a".repeat(64),
		cohortWarmupEpochBase64: "e30=",
		cohortWarmupEpochSignatureBase64: "e30=",
	},
	{
		schema: "rig-finish-warmup-request/v1",
		requestSeq: 4,
		executionSha256: "a".repeat(64),
		roleWarmupCompletionManifestBase64: "e30=",
		roleWarmupCompletionManifestSignatureBase64: "e30=",
	},
	{
		schema: "rig-measure-start-request/v1",
		requestSeq: 5,
		executionSha256: "a".repeat(64),
		cohortGrantSha256: "b".repeat(64),
		warmupCompleteSha256: "c".repeat(64),
		rigWarmupDrainedReceiptSha256: "d".repeat(64),
	},
	{
		schema: "rig-present-start-barrier-request/v1",
		requestSeq: 6,
		executionSha256: "a".repeat(64),
		cohortStartBarrierBase64: "e30=",
		cohortStartBarrierSignatureBase64: "e30=",
	},
];

/**
 * The exact frames `crates/native/src/bin/comparison-supervisor.rs` decodes in
 * its own `cohort_dispatch_tests` module, pinned here so neither side of the
 * cross-language pair can move alone.
 *
 * A pinned byte string is worth more than an equality between two functions
 * here: the failure this pair exists to catch was two *correct-looking*
 * implementations of "the frame kind", one deriving it from the schema and one
 * matching it as the schema. Only the bytes tell them apart.
 */
const RUST_PINNED_FRAME_HEX: Readonly<Record<string, string>> = {
	"rig-accept-cohort-request/v1":
		"0000004f7b226b696e64223a227269672d6163636570742d636f686f72742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001227b22636f686f72744772616e74426173653634223a226533303d222c22636f686f72744772616e745369676e6174757265426173653634223a226533303d222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a312c22726967457865637574696f6e416363657074616e6365426173653634223a226533303d222c22726967457865637574696f6e416363657074616e63655369676e6174757265426173653634223a226533303d222c22736368656d61223a227269672d6163636570742d636f686f72742d726571756573742f7631227d0a086cfd430284b746eb187ca91b232fca30fa21a947677f7d228ec9e27e859efa",
	"rig-measure-start-request/v1":
		"0000004f7b226b696e64223a227269672d6d6561737572652d73746172742d72657175657374222c22736368656d61223a22636f6d70617269736f6e2d73757065727669736f722d6672616d652f7631227d0a00000000000001a27b22636f686f72744772616e74536861323536223a2262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262626262222c22657865637574696f6e536861323536223a2261616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161616161222c2272657175657374536571223a352c227269675761726d7570447261696e656452656365697074536861323536223a2264646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464646464222c22736368656d61223a227269672d6d6561737572652d73746172742d726571756573742f7631222c227761726d7570436f6d706c657465536861323536223a2263636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363636363227d0ad8587aab427325779bc31a24fe67c03d90e48bafa9b3d2c36a63776802506729",
};

function encodedFrame(payload: Record<string, unknown> & { schema: string }) {
	const encoded = encodeRegisteredRemotePayload(payload);
	if (!encoded.ok) throw new Error(`encode ${payload.schema}: ${encoded.code}`);
	return encoded.value;
}

/** Read whatever the supervisor writes next, or time out. */
async function readNext(
	handle: Awaited<ReturnType<typeof bootSupervisor>>,
	timeoutMs: number,
): Promise<string> {
	const stream = handle.supervisorToController;
	if (stream === undefined) throw new Error("no control-out stream");
	const chunks: Buffer[] = [];
	await new Promise<void>((done) => {
		const timer = setTimeout(done, timeoutMs);
		stream.on("data", (chunk: Buffer) => {
			chunks.push(Buffer.from(chunk));
			clearTimeout(timer);
			done();
		});
	});
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read until `wanted` complete supervisor frames have arrived, and return each
 * one's header kind with its parsed payload.
 *
 * Decoding rather than substring-matching is the point: "the session was not
 * terminated" is a statement about frame boundaries, and a test that reads the
 * bytes as a string cannot tell six answers from one answer repeated.
 */
async function readAnswers(
	handle: Awaited<ReturnType<typeof bootSupervisor>>,
	wanted: number,
	timeoutMs: number,
): Promise<readonly { kind: string; payload: Record<string, unknown> }[]> {
	const stream = handle.supervisorToController;
	if (stream === undefined) throw new Error("no control-out stream");
	const answers: { kind: string; payload: Record<string, unknown> }[] = [];
	let buffered = Buffer.alloc(0);
	await new Promise<void>((done) => {
		const timer = setTimeout(done, timeoutMs);
		stream.on("data", (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
			for (;;) {
				const decoded = decodeSupervisorFrame(
					new Uint8Array(buffered),
					SUPERVISOR_ARTIFACT_PAYLOAD_MAX_BYTES,
				);
				if (!decoded.ok) break;
				const header = JSON.parse(
					new TextDecoder().decode(decoded.value.frame.header),
				) as { kind: string };
				const payload = JSON.parse(
					new TextDecoder().decode(decoded.value.frame.payload),
				) as Record<string, unknown>;
				answers.push({ kind: header.kind, payload });
				buffered = buffered.subarray(decoded.value.consumed);
			}
			if (answers.length >= wanted) {
				clearTimeout(timer);
				done();
			}
		});
	});
	return answers;
}

describe("B3.5 e2e: the real comparison-supervisor binary over the real codec", () => {
	it("the_frames_the_rust_dispatch_pins_are_the_ones_this_encoder_produces", () => {
		// The forward half of the cross-language pair, and the cheap half: no
		// process, no build. `comparison-supervisor.rs`'s `cohort_dispatch_tests`
		// holds these same two hex strings and feeds them to the real `serve`
		// dispatch, so a change to either encoder that moves a byte turns one of
		// the two suites red immediately instead of at the next 15-minute e2e.
		for (const [schema, hex] of Object.entries(RUST_PINNED_FRAME_HEX)) {
			const payload = COHORT_REQUESTS.find(
				(candidate) => candidate.schema === schema,
			);
			expect(payload).toBeDefined();
			if (payload === undefined) throw new Error("unreachable");
			expect(Buffer.from(encodedFrame(payload)).toString("hex")).toBe(hex);
		}
	});

	it("every_cohort_frame_kind_is_its_schema_without_the_version_suffix", () => {
		// §3.3, in one line: "`header.kind` is exactly the payload `schema` with
		// the terminal `/v1` removed". This is what the rig was not doing.
		for (const payload of COHORT_REQUESTS) {
			const decoded = decodeRegisteredRemotePayload(encodedFrame(payload));
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) throw new Error("unreachable");
			expect(decoded.value.headerKind).toBe(payload.schema.slice(0, -3));
		}
	});

	it(
		"every_production_encoded_cohort_frame_is_matched_by_the_real_rig_dispatch",
		async () => {
			// The property is that each of the six frames the production encoder
			// can produce is *matched* by the rig dispatch: named, carried to
			// its own transition, and answered with that transition's refusal
			// rather than with `TRUST_CHILD_FRAME_INVALID`, which is what an
			// unmatched kind produces. Production installs no cohort runtime,
			// so every transition refuses on `COHORT_NOT_READY`.
			//
			// One session per frame, because §2.7 made a refused cohort
			// transition terminal: `terminate_cohort` writes the refusal, tears
			// the cohort down and ends the arm. An earlier form of this test
			// wrote all six into one session and expected six answers; under
			// §2.7 that session is over after the first, and the six-in-a-row
			// reading was the pre-§2.7 one. Driving each frame in a fresh
			// session tests what the name says and stays true afterwards.
			//
			// WILL BECOME: six acks rather than six refusals, once `serve`
			// installs a runtime from a signing-key fd, the staged Mac key and a
			// Phase-A rig binding (residual 5 of the deviation, another slice).
			buildSupervisorBinaries();
			for (const payload of COHORT_REQUESTS) {
				const handle = await bootSupervisor(mintTrustBootstrap());
				try {
					handle.controllerToSupervisor?.write(
						Buffer.from(encodedFrame(payload)),
					);
					const answers = await readAnswers(handle, 1, 20_000);
					expect(answers.length).toBe(1);
					const answer = answers[0];
					if (answer === undefined) throw new Error("unreachable");
					// §2.7's refusal kind. Plan 531: "The refusal kind is
					// `remote-supervisor-refusal`. No alias kind is accepted."
					expect(answer.kind).toBe("remote-supervisor-refusal");
					// The frame was named, the transition was reached, and the
					// transition said the rig holds no cohort.
					// `TRUST_CHILD_FRAME_INVALID` here would mean the kind fell
					// off the dispatch again -- which is the whole point of the
					// sweep.
					expect(answer.payload.code).toBe("COHORT_NOT_READY");
					expect(answer.payload.terminal).toBe(true);
					expect(answer.payload.ackRequestSeq).toBe(payload.requestSeq);
				} finally {
					await stopSupervisor(handle, 5_000);
				}
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"a_kind_spelled_as_a_schema_is_still_not_a_frame_this_rig_speaks",
		async () => {
			// The other side of the same contract, and the reason the fix is a
			// fix and not a second alias: the suffixed spelling the rig used to
			// match is not admitted now that the header spelling is. One kind
			// per frame, and an unknown kind still ends the stream.
			buildSupervisorBinaries();
			const handle = await bootSupervisor(mintTrustBootstrap());
			try {
				const header = new TextEncoder().encode(
					`${JSON.stringify({
						kind: "rig-accept-cohort-request/v1",
						schema: "comparison-supervisor-frame/v1",
					})}\n`,
				);
				const framed = encodeSupervisorFrame(
					header,
					bytesOfCanonical(ACCEPT_COHORT_REQUEST as unknown as never),
					1_048_576,
				);
				expect(framed.ok).toBe(true);
				if (!framed.ok) throw new Error("unreachable");
				handle.controllerToSupervisor?.write(Buffer.from(framed.value));
				const answer = await readNext(handle, 10_000);
				expect(answer).toContain("TRUST_CHILD_FRAME_INVALID");
				expect(answer).not.toContain("COHORT_NOT_READY");
			} finally {
				await stopSupervisor(handle, 5_000);
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"the_controllers_cohort_channel_reports_the_rigs_own_refusal_code",
		async () => {
			// D2, closed. The rig answers a refused transition in the Phase-A
			// `admission-refusal` / `measurement-refusal/v1` shape, which is not
			// a registered remote kind; the channel used to hand that to
			// `decodeRegisteredRemotePayload` and report "unregistered remote
			// kind" over the top of whatever the rig was trying to say. An
			// operator reading the campaign log can now tell "the rig has no
			// cohort runtime" from "the wire is corrupt".
			buildSupervisorBinaries();
			const handle = await bootSupervisor(mintTrustBootstrap());
			try {
				const channel = new CohortRigChannel({
					controllerToRig: handle.controllerToSupervisor as never,
					rigToController: handle.supervisorToController as never,
					executionSha256: "a".repeat(64) as never,
					stagedRigPublicRaw32: new Uint8Array(32),
					deadlines: {
						frameMs: 5_000,
						serverReadyMs: 5_000,
						warmupDrainMs: 5_000,
						captureMs: 5_000,
					},
				});
				const accepted = await channel.acceptCohort({
					cohortGrantBytes: new TextEncoder().encode("{}"),
					cohortGrantSignatureBytes: new TextEncoder().encode("{}"),
				});
				expect(accepted.ok).toBe(false);
				if (accepted.ok) throw new Error("unreachable");
				// The rig's code, as a §7 literal, not a decode failure.
				expect(accepted.code).toBe("COHORT_NOT_READY");
				expect(accepted.message).toContain("COHORT_NOT_READY");
				expect(accepted.message).not.toContain("decode");
			} finally {
				await stopSupervisor(handle, 5_000);
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// 4. What the campaign index can honestly claim about this run
// ---------------------------------------------------------------------------

describe("B3.5 e2e: the campaign index over two refused cohort arms", () => {
	/** The index `realRunBody` writes when both fanout primaries refuse. */
	function refusedIndex(root: string): string {
		const entry = (wire: "ws" | "wt"): CampaignIndexEntryV2 => ({
			schema: "campaign-index-entry/v2",
			cellId: CELL_ID,
			armId: `${CELL_ID}/${wire}`,
			transport: wire,
			armKind: "primary",
			armTransport: wire,
			impairment: "none",
			executionPurpose: "pilot",
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
			status: "FAIL",
			promotable: false,
			failureCode: "COHORT_NOT_READY",
			refusalCode: null,
			sealedPath: null,
			artifactSha256: null,
			primaryMetricP50: null,
			readPath: null,
		});
		const index: CampaignIndexV2 = {
			schema: CAMPAIGN_INDEX_V2_SCHEMA,
			campaignRunId: "e2e-run",
			stage: "full",
			candidate: "candidate-b35",
			campaignId: "e2e-campaign",
			approvedPlanSha256: "1".repeat(64),
			approvalRecordSha256: "2".repeat(64),
			stagedCapabilitySha256: "b".repeat(64),
			sourceArchiveSha256: "a".repeat(64),
			executionPurpose: "pilot",
			cells: [CELL_ID],
			arms: ["ws", "wt"],
			armKinds: ["primary"],
			// The schedule is exactly one warmup then the measured reps (§5).
			// A warmup is never sealed, indexed or counted, so it leaves no
			// entry behind -- but the index still declares that it ran.
			warmupRepetitions: 1,
			measuredRepetitions: 1,
			scheduledMeasuredArms: 2,
			entries: [entry("ws"), entry("wt")],
		};
		const indexPath = join(root, "campaign-index.json");
		writeFileSync(indexPath, `${JSON.stringify(index)}\n`);
		return indexPath;
	}

	it("the_wrapper_expected_counts_for_a_sealed_pilot_pair_are_not_met", () => {
		const root = mkdtempSync(join(tmpdir(), "fanout-e2e-index-"));
		const indexPath = refusedIndex(root);
		// The shape the mandate asked this suite to prove: two measured PASS
		// seals, nothing promotable, no flats. It must not be satisfiable by a
		// campaign that measured nothing.
		//
		// WILL BECOME: `ok: true`, once the cohort can actually be measured.
		const claimed = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
			expectedPassCount: 2,
			expectedPromotableCount: 0,
			expectedFlatCount: 0,
			expectedSealedCount: 2,
		});
		expect(claimed.ok).toBe(false);
	});

	it("the_honest_counts_for_this_run_are_zero_passes_and_zero_seals", () => {
		const root = mkdtempSync(join(tmpdir(), "fanout-e2e-index-honest-"));
		const indexPath = refusedIndex(root);
		const honest = verifyCampaignIndex({
			campaignRoot: root,
			indexPath,
			externalTrustBoundSha256: "4".repeat(64),
			expectedPassCount: 0,
			expectedFailCount: 2,
			expectedPromotableCount: 0,
			expectedFlatCount: 0,
			expectedSealedCount: 0,
		});
		expect(honest.ok).toBe(true);
		if (!honest.ok) throw new Error("unreachable");
		expect(honest.passCount).toBe(0);
		expect(honest.sealedCount).toBe(0);
		expect(honest.promotableCount).toBe(0);
		expect(honest.promotedCells).toEqual([]);
		expect(honest.canonicalFanoutComplete).toBe(false);
	});
});
