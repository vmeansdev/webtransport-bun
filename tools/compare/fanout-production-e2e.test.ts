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
 * None of that is reachable, and the reason is the finding: **no honest
 * cohort can be measured by this tree yet.** Three independent real-process
 * boundaries stop it, and each is pinned below by execution rather than by
 * reading the source:
 *
 *   1. the production runtime provider has no Mac supervisor lease, so the
 *      dispatch refuses `COHORT_NOT_READY` before any transport is opened;
 *   2. `server.ts --mode=fanout-cohort` refuses before it binds a listener,
 *      because `server-bind-execution/v1` carries a cohort grant and no
 *      signature over it;
 *   3. the real supervisor binary installs no cohort runtime outside its own
 *      test module, and -- separately -- the controller's frames do not reach
 *      its cohort dispatch at all (see `D1` below).
 *
 * So the assertions here are the *closest real-process boundary* in each
 * case, written so that completing production turns them red. Each one names
 * the expectation it will become. That is the guard: this file fails the day
 * the hole is filled, and fails today if anyone fabricates a way past it.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
import { cohortCellCardinality } from "./cohort-protocol.ts";
import {
	bytesOfCanonical,
	encodeRegisteredRemotePayload,
} from "./cross-supervisor-protocol.ts";
import { cohortCellForArm } from "./evidence.ts";
import {
	CohortRigChannel,
	spawnMacSupervisor,
	stopSupervisor,
	TRUST_BOOTSTRAP_AUTHORITY_DIGEST_LEAF,
	TRUST_BOOTSTRAP_AUTHORITY_LEAF,
	TRUST_BOOTSTRAP_CAMPAIGN_ROOT,
	TRUST_BOOTSTRAP_STAGING_ROOT,
} from "./remote-supervisor.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import { stagedServerLaunchArgv } from "./server.ts";
import { encodeSupervisorFrame } from "./supervisor-client.ts";

/** The cohort cell this suite drives. */
const CELL_ID = "ticker-fanout/rate-10000";
const COHORT_CELL = "ticker 10k";

/** Repo root: this file lives at `<root>/tools/compare/`. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** A long timeout: these tests build Rust binaries and boot real processes. */
const PROCESS_TEST_TIMEOUT_MS = 900_000;

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
				} as unknown as Parameters<
					typeof dispatchArmRepetition
				>[0]["arm"],
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
			// The refusal names the three seams with no production implementer.
			// A refusal that stopped naming them would be a refusal nobody
			// could act on.
			expect(dispatched.result.reason).toContain("cohort minter");
			expect(dispatched.result.reason).toContain("role-child spawner");
			expect(dispatched.result.reason).toContain("process control");

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
		"refuses_at_the_missing_grant_signature_channel_rather_than_binding_a_listener",
		() => {
			const run = runServer(WELL_FORMED_ENV);
			// WILL BECOME: a server that binds and serves the cohort, once
			// `server-bind-execution/v1` carries a Mac signature over the grant.
			expect(run.exitCode).not.toBe(0);
			expect(run.output).toContain("COHORT_NOT_READY");
			expect(run.output).toContain("no signed cohort grant channel");
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
			// the grant-channel branch at all.
			expect(run.output).not.toContain("no signed cohort grant channel");
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
			join(REPO_ROOT, "tools", "compare", "bin", "mint-live-trust-bootstrap.ts"),
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

/** The one cohort request this suite puts on the wire. */
const ACCEPT_COHORT_REQUEST = {
	schema: "rig-accept-cohort-request/v1",
	requestSeq: 1,
	executionSha256: "a".repeat(64),
	cohortGrantBase64: "e30=",
	cohortGrantSignatureBase64: "e30=",
} as const;

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

describe("B3.5 e2e: the real comparison-supervisor binary over the real codec", () => {
	it(
		"the_production_controller_encoder_cannot_reach_the_rigs_cohort_dispatch",
		async () => {
			// D1. `encodeRemoteSupervisorPayload` writes the frame `kind` as the
			// schema with `/v1` stripped (`headerKindFromSchema`), so the
			// controller sends `kind: "rig-accept-cohort-request"`. The rig
			// matches on the suffixed form (`cohort::rig::ack_kind_for` takes
			// `"rig-accept-cohort-request/v1"`), so every cohort frame the
			// production controller can encode falls through the `serve`
			// dispatch to `_ => terminate("TRUST_CHILD_FRAME_INVALID")` -- a
			// *fatal* end of session, not a refusal the controller can act on.
			//
			// WILL BECOME: a `rig-cohort-accepted-ack/v1`, once the two sides
			// agree on one spelling of the kind.
			buildSupervisorBinaries();
			const handle = await bootSupervisor(mintTrustBootstrap());
			try {
				const encoded = encodeRegisteredRemotePayload(
					ACCEPT_COHORT_REQUEST as unknown as Record<string, unknown> & {
						schema: string;
					},
				);
				expect(encoded.ok).toBe(true);
				if (!encoded.ok) throw new Error("unreachable");
				handle.controllerToSupervisor?.write(Buffer.from(encoded.value));
				const answer = await readNext(handle, 10_000);
				expect(answer).toContain("admission-refusal");
				expect(answer).toContain("TRUST_CHILD_FRAME_INVALID");
				expect(answer).not.toContain("rig-cohort-accepted-ack");
			} finally {
				await stopSupervisor(handle, 5_000);
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"the_rig_dispatch_reached_by_hand_refuses_because_production_installs_no_cohort_runtime",
		async () => {
			// Isolates D1 from the thing underneath it. Framed by hand with the
			// suffixed kind the rig actually matches, the request *does* reach
			// `cohort_request`, which reads `self.cohort` -- `None` outside the
			// binary's own `cohort_dispatch_tests` module, because
			// `install_cohort_runtime` has no caller in `main`/`serve`.
			//
			// WILL BECOME: a `rig-cohort-accepted-ack/v1`, once `serve` installs
			// a runtime from a signing-key fd, the staged Mac key and a Phase-A
			// rig binding.
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
				expect(answer).toContain("COHORT_NOT_READY");
				expect(answer).not.toContain("TRUST_CHILD_FRAME_INVALID");
			} finally {
				await stopSupervisor(handle, 5_000);
			}
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"the_controllers_cohort_channel_cannot_decode_the_rigs_refusal_shape",
		async () => {
			// D2, and it is separate from D1: even at an agreed kind, the rig
			// answers a refused transition with an `admission-refusal` frame
			// carrying `measurement-refusal/v1`, while `CohortRigChannel` only
			// understands `remote-supervisor-refusal/v1`. The controller
			// therefore reports a decode failure and never learns the rig's
			// code, so an operator reading the campaign log cannot tell
			// "the rig has no cohort runtime" from "the wire is corrupt".
			//
			// WILL BECOME: `code === "COHORT_NOT_READY"` carried through, once
			// the rig answers in the remote refusal shape (or the channel
			// learns the measurement one).
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
				expect(accepted.message).toContain("decode");
				// The rig's own code did not survive the crossing.
				expect(accepted.message).not.toContain("COHORT_NOT_READY");
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
