/**
 * B4: the cohort executor, the six-cell switch, and what the controller is
 * still not allowed to do.
 *
 * Three separate claims are under test here and it is worth keeping them apart.
 *
 * The first is *which* arms changed. B4 switches exactly six arms -- the
 * primary of each fanout cell -- and nothing else. Six is not a number written
 * down here: it is `cohortCellForArm`'s answer, and these tests ask it for every
 * arm of every cell in the frozen registry so a seventh switched arm, or a
 * missing sixth, is a failure rather than a discrepancy nobody looks for.
 *
 * The second is *what the switched arms declare*. §4.1 requires the expanded
 * delivery declaration -- offered ingress times subscriber count -- and the
 * difference is four to five orders of magnitude. `assertMeasuredArmIsGranted`
 * compares the sealed series against exactly this number, so declaring the
 * unexpanded one is what would let a cohort that delivered a hundredth of what
 * it owed present a series nothing had reason to refuse.
 *
 * The third is that the controller is still only a courier. `driveCohortArm`
 * runs against a *real* `MacFanoutSupervisor`, so a binding that rewrites,
 * invents or cross-pairs a rig record is refused by the supervisor's own
 * signature and digest checks rather than by anything this file asserts.
 */

import { describe, expect, test } from "bun:test";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	readSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
	type ArmRepetitionDispatch,
	armRepetitionSchedule,
	assertFanoutGrantDeclaration,
	type CohortArmLease,
	type CohortArmMeasuredV1,
	type CohortArmRuntimeContext,
	type CohortArmRuntimeProvider,
	CohortChannelRigBinding,
	CohortLifecycleRetention,
	type CohortRigBinding,
	composeCohortRigBinding,
	createCohortArmRuntimeProvider,
	dispatchArmRepetition,
	driveCohortArm,
	FanoutGrantDeclarationError,
	grantDeclarationsFromCell,
	MacRoleChildCohortDriver,
	measuredRepetitionsForPurpose,
	type SealedRepResult,
	sealArmsForCell,
	sealGrantDeclarationForArm,
} from "./bin/compare-controller.ts";
import {
	decodeRoleChildFrame,
	encodeRoleChildFrame,
	RoleChildFrameReader,
	roleChildMaxFramesPerDirection,
} from "./child-pipe-protocol.ts";
import { CohortExecutorRequiredError, getScenarioExecutor } from "./client.ts";
import {
	ScriptedMacCohortBinary,
	scriptedRigExecutionAcceptedAck,
	serveScriptedMac,
} from "./cohort-fixture-signing.ts";
import {
	COHORT_CELL_CARDINALITIES,
	cohortCellCardinality,
	type TokenBundleV1,
	type TokenCommitmentLeafManifestV1,
} from "./cohort-protocol.ts";
import {
	bytesOfCanonical,
	CAMPAIGN_FAILURE_CODES,
	createMemoryReplayLedger,
	decodeRegisteredRemotePayload,
	type Ed25519KeyPairBytes,
	encodeRegisteredRemotePayload,
	generateEd25519KeyPair,
	type Sha256Hex,
	signRigReceipt,
	verifyMacReceiptSignature,
} from "./cross-supervisor-protocol.ts";
import {
	cohortCellForArm,
	FANOUT_COHORT_CELL_BY_ID,
	FANOUT_COHORT_CELL_IDS,
} from "./evidence.ts";
import {
	CohortRigChannel,
	createCloexecPipe,
	MAC_FANOUT_PUBLISHER_COUNT,
	MacCohortChannel,
	type MacFanoutChildPlanV1,
	type MacFanoutRoleChildHost,
	MacFanoutSupervisor,
	MacPermitScheduler,
	MacRoleChildControlChannel,
	macTokenBundleForPlan,
} from "./remote-supervisor.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import {
	buildFanoutCohortFixture,
	createManualRelayClock,
	type FanoutCohortFixture,
} from "./scenarios/fanout-relay.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";

const HEX = (character: string): Sha256Hex => character.repeat(64) as Sha256Hex;

function cellOf(cellId: string) {
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidate) => candidate.cellId === cellId,
	);
	if (cell === undefined) throw new Error(`no registry cell ${cellId}`);
	return cell;
}

// ---------------------------------------------------------------------------
// Which arms the switch covers
// ---------------------------------------------------------------------------

describe("B4: exactly six arms switch to the cohort executor", () => {
	test("six_cells_and_only_six_switch", () => {
		const switched: string[] = [];
		for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
			for (const arm of sealArmsForCell(cell)) {
				if (cohortCellForArm({ cellId: cell.cellId, armKind: arm.armKind })) {
					switched.push(arm.armId);
				}
			}
		}
		// Two wires per cell, primary only: twelve arms across six cells.
		expect(switched.length).toBe(12);
		const switchedCells = new Set(
			switched.map((armId) => armId.slice(0, armId.lastIndexOf("/"))),
		);
		expect([...switchedCells].sort()).toEqual(
			[...FANOUT_COHORT_CELL_IDS].sort(),
		);
	});

	test("read_path_and_overlay_arms_of_a_fanout_cell_do_not_switch", () => {
		for (const cellId of FANOUT_COHORT_CELL_IDS) {
			const cell = cellOf(cellId);
			for (const arm of sealArmsForCell(cell)) {
				const switched =
					cohortCellForArm({ cellId, armKind: arm.armKind }) !== null;
				expect(switched).toBe(arm.armKind === "primary");
			}
		}
	});

	test("the_switched_set_is_the_frozen_4_5_table", () => {
		// The cell-id map and the cardinality table are two lists of the same six
		// cells written in two files. They are allowed to be two lists only for as
		// long as they agree.
		expect(Object.values(FANOUT_COHORT_CELL_BY_ID).sort()).toEqual(
			COHORT_CELL_CARDINALITIES.map((row) => row.cell).sort(),
		);
	});
});

// ---------------------------------------------------------------------------
// The expanded delivery declaration
// ---------------------------------------------------------------------------

describe("B4: the fanout grant declares expanded deliveries", () => {
	test("the_six_primaries_declare_expanded_deliveries", () => {
		for (const cellId of FANOUT_COHORT_CELL_IDS) {
			const cell = cellOf(cellId);
			const cardinality = cohortCellCardinality(
				FANOUT_COHORT_CELL_BY_ID[cellId] as string,
			);
			const declaration = sealGrantDeclarationForArm({
				cell,
				armKind: "primary",
			});
			expect(declaration.grantDeclaration).toBe("fanout-expanded-deliveries");
			expect(declaration.declaredMessageCount).toBe(
				cardinality.expandedDeliveries,
			);
			// The expansion is exactly the subscriber count, and it is not a
			// rounding: the unexpanded declaration is the offered ingress.
			expect(declaration.declaredMessageCount).toBe(
				cardinality.measuredIngress * cardinality.subscriberCount,
			);
			expect(declaration.declaredMessageBytes).toBe(
				cell.scenarioId === "ticker-fanout" ? 100 : 128,
			);
		}
	});

	test("wrong_expanded_delivery_grant_declaration_refused", () => {
		for (const cellId of FANOUT_COHORT_CELL_IDS) {
			const cell = cellOf(cellId);
			const expected = sealGrantDeclarationForArm({ cell, armKind: "primary" });
			const cardinality = cohortCellCardinality(
				FANOUT_COHORT_CELL_BY_ID[cellId] as string,
			);

			// The unexpanded declaration -- offered ingress -- is the specific
			// mistake §4.1 exists to prevent, and it is the one a caller reaching
			// for `grantDeclarationsFromCell` would make.
			expect(() =>
				assertFanoutGrantDeclaration({
					cell,
					armKind: "primary",
					declared: {
						declaredMessageCount: cardinality.measuredIngress,
						declaredMessageBytes: expected.declaredMessageBytes,
					},
				}),
			).toThrow(FanoutGrantDeclarationError);

			// Off by one delivery is refused just as hard: the count is a
			// commitment, not an estimate.
			expect(() =>
				assertFanoutGrantDeclaration({
					cell,
					armKind: "primary",
					declared: {
						declaredMessageCount: expected.declaredMessageCount - 1,
						declaredMessageBytes: expected.declaredMessageBytes,
					},
				}),
			).toThrow(FanoutGrantDeclarationError);

			// Right count, wrong record size.
			expect(() =>
				assertFanoutGrantDeclaration({
					cell,
					armKind: "primary",
					declared: {
						declaredMessageCount: expected.declaredMessageCount,
						declaredMessageBytes: expected.declaredMessageBytes + 1,
					},
				}),
			).toThrow(FanoutGrantDeclarationError);

			// Right numbers under the Phase-A label is still the wrong declaration.
			expect(() =>
				assertFanoutGrantDeclaration({
					cell,
					armKind: "primary",
					declared: {
						...expected,
						grantDeclaration: "phase-a-completed-transfer",
					},
				}),
			).toThrow(FanoutGrantDeclarationError);

			// And the declaration the seal path computes passes.
			expect(() =>
				assertFanoutGrantDeclaration({
					cell,
					armKind: "primary",
					declared: expected,
				}),
			).not.toThrow();
		}
	});

	test("read_path_arms_keep_the_leg_declaration", () => {
		for (const cellId of FANOUT_COHORT_CELL_IDS) {
			const cell = cellOf(cellId);
			const leg = grantDeclarationsFromCell(cell);
			const readPath = sealGrantDeclarationForArm({
				cell,
				armKind: "read-path",
			});
			expect(readPath.grantDeclaration).toBe("phase-a-completed-transfer");
			expect(readPath.declaredMessageCount).toBe(leg.declaredMessageCount);
			// A read-path declaration is never checked against the expanded rule,
			// so it does not throw when it states the leg number.
			expect(() =>
				assertFanoutGrantDeclaration({
					cell,
					armKind: "read-path",
					declared: readPath,
				}),
			).not.toThrow();
		}
	});

	test("non_fanout_cells_declare_exactly_what_they_declared_before", () => {
		for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
			if (FANOUT_COHORT_CELL_IDS.includes(cell.cellId)) continue;
			const declaration = sealGrantDeclarationForArm({
				cell,
				armKind: "primary",
			});
			expect(declaration.grantDeclaration).toBe("phase-a-completed-transfer");
			expect({
				declaredMessageCount: declaration.declaredMessageCount,
				declaredMessageBytes: declaration.declaredMessageBytes,
			}).toEqual(grantDeclarationsFromCell(cell));
		}
	});
});

// ---------------------------------------------------------------------------
// Warmup and repetition identities
// ---------------------------------------------------------------------------

describe("B4: exact warmup and repetition identities", () => {
	test("exact_warmup_and_rep_identities_for_focused_and_pilot", () => {
		for (const purpose of ["focused", "pilot"] as const) {
			const schedule = armRepetitionSchedule(purpose);
			expect(schedule).toEqual([
				{ repetitionKind: "warmup", repetitionIndex: 0 },
				{ repetitionKind: "measured", repetitionIndex: 1 },
			]);
			expect(measuredRepetitionsForPurpose(purpose)).toBe(1);
		}
	});

	test("exact_warmup_and_rep_identities_for_canonical", () => {
		const schedule = armRepetitionSchedule("canonical");
		expect(schedule[0]).toEqual({
			repetitionKind: "warmup",
			repetitionIndex: 0,
		});
		expect(schedule.slice(1).map((slot) => slot.repetitionIndex)).toEqual([
			1, 2, 3, 4, 5,
		]);
		expect(
			schedule.slice(1).every((slot) => slot.repetitionKind === "measured"),
		).toBe(true);
		expect(measuredRepetitionsForPurpose("canonical")).toBe(5);
	});

	test("the_warmup_index_can_never_collide_with_a_measured_index", () => {
		// The promotion set gate counts measured indices `{1..5}`. A warmup that
		// carried index 1 would be a sixth repetition wearing a label, and the set
		// would either reject the cell or promote the warmup's neighbour twice.
		for (const purpose of ["focused", "pilot", "canonical"] as const) {
			const schedule = armRepetitionSchedule(purpose);
			const measured = schedule
				.filter((slot) => slot.repetitionKind === "measured")
				.map((slot) => slot.repetitionIndex);
			const warmups = schedule
				.filter((slot) => slot.repetitionKind === "warmup")
				.map((slot) => slot.repetitionIndex);
			expect(warmups).toEqual([0]);
			expect(measured.includes(0)).toBe(false);
			expect(new Set(measured).size).toBe(measured.length);
		}
	});

	test("every_purpose_schedules_exactly_one_warmup", () => {
		for (const purpose of ["focused", "pilot", "canonical"] as const) {
			expect(
				armRepetitionSchedule(purpose).filter(
					(slot) => slot.repetitionKind === "warmup",
				).length,
			).toBe(1);
		}
	});
});

// ---------------------------------------------------------------------------
// The severance, from the controller's side
// ---------------------------------------------------------------------------

describe("B4: the fanout primary has no single-session leg", () => {
	test("the_registry_executor_refuses_the_primary_for_all_six_cells", async () => {
		for (const cellId of FANOUT_COHORT_CELL_IDS) {
			const cell = cellOf(cellId);
			const executor = getScenarioExecutor(cell.scenarioId);
			expect(executor).toBeDefined();
			let thrown: unknown;
			try {
				await executor?.execute({
					session: null as never,
					cell,
					driverRunId: "x",
					runId: "x",
					sessionId: "x",
					clock: { nowMs: () => 0, sleep: async () => undefined } as never,
					perMessageTimeoutMs: 1,
					contract: null as never,
					armKind: "primary",
				});
			} catch (error: unknown) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(CohortExecutorRequiredError);
		}
	});
});

// ---------------------------------------------------------------------------
// `driveCohortArm` against a real supervisor
// ---------------------------------------------------------------------------

const MINI_PUBLISHERS = MAC_FANOUT_PUBLISHER_COUNT.ticker;
// `buildFanoutCohortFixture` tiles one subscriber per shard, so the mini cohort
// is exactly the eight-worker width. That is enough for the courier properties
// under test here; the full-width wire is B3's integration suite.
const MINI_SUBSCRIBERS = 8;
const MINI_WORKERS = 8;
const MINI_COHORT_ID = "cohort-b4-mini";
const MINI_MEASURED_FRAMES = 10;
const MINI_VALIDITY_MS = 60_000;

function bytesOf(record: unknown): Uint8Array {
	// The supervisor canonicalises with the shared codec; for the digests these
	// tests compare, a stable stringify of an already-canonical record is the
	// same bytes. Records built here are only ever handed straight back.
	return new TextEncoder().encode(JSON.stringify(record));
}

interface MiniHarness {
	readonly supervisor: MacFanoutSupervisor;
	readonly channel: MacCohortChannel;
	readonly workloadBytes: Uint8Array;
	readonly binary: ScriptedMacCohortBinary;
	readonly macKeys: Ed25519KeyPairBytes;
	readonly rigKeys: Ed25519KeyPairBytes;
	readonly executionSha256: Sha256Hex;
	/** The Phase-A open, as the scripted Mac answered it: exact bytes. */
	readonly opened: {
		readonly measurementGrantBytes: Uint8Array;
		readonly receiptBytes: Uint8Array;
		readonly receiptSignatureBytes: Uint8Array;
	};
	readonly fixtures: Map<number, FanoutCohortFixture>;
	readonly manifests: Map<number, TokenCommitmentLeafManifestV1>;
	readonly spawns: MacFanoutChildPlanV1[];
}

/**
 * A supervisor over a mini ticker cohort: one publisher, eight workers, eight
 * subscribers -- one per shard, which is the widest the shared fixture tiles.
 * The Mac signer is a scripted Mac process on a real pipe pair; the Phase-A
 * execution is opened on the channel before the supervisor exists, the way the
 * production acquisition orders it.
 */
async function miniHarness(): Promise<MiniHarness> {
	const macKeys = generateEd25519KeyPair();
	const rigKeys = generateEd25519KeyPair();
	const workloadBytes = bytesOf({ plan: "b4-mini", cohortId: MINI_COHORT_ID });
	const binary = new ScriptedMacCohortBinary({
		keys: macKeys,
		stagedRigPublicRaw32: rigKeys.publicRaw32,
		clock: { nowMs: () => 1_000, nowNs: () => "1000000000" },
		receiptValidityMs: MINI_VALIDITY_MS,
		macClockId: "mini-clock",
		instanceNonce: HEX("7"),
		executableSha256: HEX("b"),
		grant: {
			transport: "ws",
			readinessDeadlineMs: 30_000,
			measuredDurationMs: 10_000,
			messageBytes: 100,
			expectedOfferedIngress: MINI_MEASURED_FRAMES * MINI_PUBLISHERS,
		},
	});
	const wire = serveScriptedMac(binary.respond);
	const channel = new MacCohortChannel({
		controllerToMac: wire.controllerToMac,
		macToController: wire.macToController,
		stagedMacPublicRaw32: macKeys.publicRaw32,
		deadlineMs: 5_000,
	});
	const opened = await channel.openExecution(
		bytesOfCanonical({
			schema: "cross-supervisor-execution-draft/v1",
			authoritySha256: HEX("a"),
			campaignLockSha256: HEX("b"),
			stagedCapabilitySha256: HEX("c"),
			sourceArchiveSha256: HEX("d"),
			approvedPlanSha256: HEX("e"),
			approvalRecordSha256: HEX("f"),
			candidate: "cand",
			campaignId: "camp",
			runId: "camp/ticker-fanout/ws/measured-1",
			executionPurpose: "focused",
			cellId: "ticker-fanout/rate-10000",
			scenarioHash: HEX("5"),
			rolePlanHash: HEX("6"),
			workloadRolePlanInputSha256: sha256HexOfBytes(workloadBytes),
			stagedServerLaunchRecordSha256: HEX("7"),
			armKind: "primary",
			transport: "ws",
			repetitionKind: "measured",
			repetitionIndex: 1,
			repetitionTotal: 1,
			grantDeclaration: "fanout-expanded-deliveries",
			// The declaration is the cell's §4.1 contract, not this harness's
			// scale: the draft names ticker 10k, so it declares ticker 10k's
			// expansion. The mini cohort below is what the executor is driven
			// with, and the two are separate on purpose.
			declaredMessageCount: 10_000_000,
			declaredMessageBytes: 100,
			requestedNotAfterMs: 17_000_000_000_000,
		}),
	);
	if (!opened.ok) throw new Error(`mini execution: ${opened.code}`);
	const executionSha256 = opened.value.executionSha256;

	const fixtures = new Map<number, FanoutCohortFixture>();
	const manifests = new Map<number, TokenCommitmentLeafManifestV1>();
	const spawns: MacFanoutChildPlanV1[] = [];
	let nextPid = 1_000;
	const alive = new Set<number>();

	const supervisor = new MacFanoutSupervisor({
		scenario: "ticker",
		subscriberCount: MINI_SUBSCRIBERS,
		executionSha256,
		channel,
		workloadRolePlanInputBytes: workloadBytes,
		scenarioHash: HEX("5"),
		rolePlanHash: HEX("6"),
		stagedRigPublicRaw32: rigKeys.publicRaw32,
		macClockId: "mini-clock",
		runtimeDir: mkdtempSync(join(tmpdir(), "b4-mini-")),
		mintCohort: ({ cohortAttempt, grantNonceSha256 }) => {
			const cohortId = `${MINI_COHORT_ID}#${cohortAttempt}:${grantNonceSha256.slice(0, 8)}`;
			const tokens = buildFanoutCohortFixture({
				cohortId,
				publisherCount: MINI_PUBLISHERS,
				subscriberCount: MINI_SUBSCRIBERS,
			});
			const leafManifest: TokenCommitmentLeafManifestV1 = {
				schema: "token-commitment-leaf-manifest/v1",
				executionSha256,
				cohortId,
				leafCount: tokens.leaves.length,
				leaves: [...tokens.leaves],
				roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
			};
			manifests.set(cohortAttempt, leafManifest);
			fixtures.set(cohortAttempt, tokens);
			return {
				tokens,
				leafManifestBytes: bytesOfCanonical(leafManifest),
				publishers: tokens.publishers,
				subscriberShards: tokens.subscriberShards,
			};
		},
		spawnChild: (request) => {
			spawns.push(request.plan);
			nextPid += 1;
			alive.add(nextPid);
			return { ok: true, value: { pid: nextPid, pgid: nextPid } };
		},
		processControl: {
			killPgid: (pgid) => {
				alive.delete(pgid);
			},
			waitPgid: (pgid) => !alive.has(pgid),
		},
		ledger: createMemoryReplayLedger(),
		stagedCapabilityNotAfterMs: 17_000_000_000_000,
		bunSha256: HEX("8"),
		entrypointSha256: HEX("9"),
	});

	return {
		supervisor,
		channel,
		workloadBytes,
		binary,
		macKeys,
		rigKeys,
		executionSha256,
		opened: {
			measurementGrantBytes: opened.value.measurementGrantBytes,
			receiptBytes: opened.value.receiptBytes,
			receiptSignatureBytes: opened.value.receiptSignatureBytes,
		},
		fixtures,
		manifests,
		spawns,
	};
}

/** A binding that refuses everything; each test overrides only what it reaches. */
function refusingBinding(
	overrides: Partial<CohortRigBinding> = {},
): CohortRigBinding {
	const refuse = (step: string) => ({
		ok: false as const,
		code: "COHORT_PROTOCOL" as const,
		message: `binding step ${step} was reached`,
	});
	return {
		acceptCohortGrant: () => refuse("acceptCohortGrant") as never,
		startServer: () => refuse("startServer") as never,
		registerRolePeers: () => refuse("registerRolePeers") as never,
		acceptWarmupEpoch: () => refuse("acceptWarmupEpoch") as never,
		runWarmupWire: () => refuse("runWarmupWire") as never,
		drainWarmup: () => refuse("drainWarmup") as never,
		measureStartAck: () => refuse("measureStartAck") as never,
		acceptStartBarrier: () => refuse("acceptStartBarrier") as never,
		runMeasuredWindow: () => refuse("runMeasuredWindow") as never,
		observe: () => refuse("observe") as never,
		collectPartials: () => refuse("collectPartials") as never,
		teardownServer: () => refuse("teardownServer") as never,
		...overrides,
	};
}

function driveInput(harness: MiniHarness, rig: CohortRigBinding) {
	const clock = createManualRelayClock(1_000);
	return {
		supervisor: harness.supervisor,
		rig,
		retention: new CohortLifecycleRetention(),
		bundleFor: (): TokenBundleV1 => {
			throw new Error("bundleFor must not be reached before the grant lands");
		},
		workloadRolePlanInputBytes: harness.workloadBytes,
		tokenCommitmentLeafManifestBytes: () => {
			const manifest = harness.manifests.get(harness.supervisor.cohortAttempt);
			return manifest === undefined ? null : bytesOfCanonical(manifest);
		},
		clock: { nowMs: () => clock.nowMs(), nowNs: () => clock.nowNs() },
	};
}

// ---------------------------------------------------------------------------
// The production dispatch seam
// ---------------------------------------------------------------------------

/**
 * The arm input `realRunBody` builds for one repetition.
 *
 * Only the fields the router reads are real; the rest exist because the seam
 * hands the whole record to whichever executor it chose, and the leg executor
 * here is always the forbidden one. The point of building it through the real
 * `sealArmsForCell` is that the arm identity under test is the one production
 * schedules, not one this file named.
 */
function legInputFor(
	cell: ReturnType<typeof cellOf>,
	armKind: "primary" | "read-path" | "overlay",
	repetitionKind: "warmup" | "measured" = "measured",
): Parameters<typeof dispatchArmRepetition>[0]["arm"] {
	const arm = sealArmsForCell(cell, ["ws"], [armKind])[0];
	if (arm === undefined)
		throw new Error(`no ${armKind} arm for ${cell.cellId}`);
	return {
		cell,
		arm,
		runId: `dispatch-${cell.cellId}-${arm.armId}`,
		repIndex: repetitionKind === "warmup" ? 0 : 1,
		repetitionKind,
		repetitionTotal: 1,
		executionPurpose: "pilot",
		perRepPath: "/dev/null",
		sealedPath: "/dev/null",
	} as unknown as Parameters<typeof dispatchArmRepetition>[0]["arm"];
}

/** A leg executor that fails the test by being called at all. */
function forbiddenLeg(): (
	input: Parameters<typeof dispatchArmRepetition>[0]["arm"],
) => Promise<SealedRepResult> {
	return async (input) => {
		throw new Error(
			`measureSealAndWriteRep must not be reached for ${input.arm.armId}`,
		);
	};
}

/** A runtime over the real supervisor; `seals` records what reached the seal. */
function cohortRuntimeOf(
	harness: MiniHarness,
	rig: CohortRigBinding,
	seals: CohortArmMeasuredV1[],
	sealed: SealedRepResult = {
		ok: true,
		primaryMetricP50: 1,
		sealedPath: "/dev/null",
		artifactSha256: "0".repeat(64),
	},
): CohortArmRuntimeProvider {
	return () => ({
		ok: true,
		value: {
			...driveInput(harness, rig),
			seal: async (measured: CohortArmMeasuredV1) => {
				seals.push(measured);
				return sealed;
			},
			cleanup: (path) => harness.supervisor.teardown(path),
		},
	});
}

describe("B4: the production dispatch routes to the cohort executor", () => {
	test("dispatch_routes_ticker_10000_primary_to_the_cohort_executor", async () => {
		for (const wire of ["ws", "wt"] as const) {
			const cell = cellOf("ticker-fanout/rate-10000");
			const arm = sealArmsForCell(cell, [wire], ["primary"])[0]!;
			const drivenWith: unknown[] = [];
			const dispatched = await dispatchArmRepetition({
				arm: {
					...legInputFor(cell, "primary"),
					arm,
				} as Parameters<typeof dispatchArmRepetition>[0]["arm"],
				cohortRuntime: cohortRuntimeOf(
					await miniHarness(),
					refusingBinding(),
					[],
				),
				executors: {
					measureSealAndWriteRep: forbiddenLeg(),
					driveCohortArm: async (input) => {
						drivenWith.push(input);
						return {
							ok: false,
							code: "COHORT_PROTOCOL",
							message: "driven",
						} as never;
					},
				},
			});
			expect(dispatched.route).toBe("cohort");
			// The cohort executor ran exactly once, with the runtime's material.
			expect(drivenWith.length).toBe(1);
			expect(arm.transport).toBe(wire);
		}
	});

	test("dispatch_routes_bulk_one_way_physical_to_the_single_session_leg", async () => {
		const cell = cellOf("bulk-one-way/physical");
		let legRan = 0;
		const dispatched = await dispatchArmRepetition({
			arm: legInputFor(cell, "primary"),
			// A runtime is offered and must still not be used: the router, not the
			// availability of a cohort, decides.
			cohortRuntime: cohortRuntimeOf(
				await miniHarness(),
				refusingBinding(),
				[],
			),
			executors: {
				measureSealAndWriteRep: async () => {
					legRan += 1;
					return {
						ok: true,
						primaryMetricP50: 7,
						sealedPath: "/dev/null",
						artifactSha256: "1".repeat(64),
					};
				},
				driveCohortArm: async () => {
					throw new Error("driveCohortArm must not run for a non-fanout cell");
				},
			},
		});
		expect(dispatched.route).toBe("single-session-leg");
		expect(legRan).toBe(1);
		expect(dispatched.result.ok).toBe(true);
	});

	test("no_fanout_primary_can_reach_measure_seal_and_write_rep", async () => {
		// The `CohortExecutorRequiredError` backstop in `client.ts` is what makes a
		// mistake here loud. This test is the reason it should never fire: every
		// switched arm of every switched cell, on both wires, both repetition
		// kinds, is routed away from the leg by the dispatch itself.
		const results: ArmRepetitionDispatch[] = [];
		for (const cellId of FANOUT_COHORT_CELL_IDS) {
			const cell = cellOf(cellId);
			for (const wire of ["ws", "wt"] as const) {
				for (const repetitionKind of ["warmup", "measured"] as const) {
					const arm = sealArmsForCell(cell, [wire], ["primary"])[0]!;
					results.push(
						await dispatchArmRepetition({
							arm: {
								...legInputFor(cell, "primary", repetitionKind),
								arm,
							} as Parameters<typeof dispatchArmRepetition>[0]["arm"],
							// No runtime at all: the refusal path is the one a production
							// run hits today, and it still must not fall back to a leg.
							executors: { measureSealAndWriteRep: forbiddenLeg() },
						}),
					);
				}
			}
		}
		expect(results.length).toBe(FANOUT_COHORT_CELL_IDS.length * 4);
		for (const dispatched of results) {
			expect(dispatched.route).toBe("cohort");
			expect(dispatched.result.ok).toBe(false);
			if (dispatched.result.ok) throw new Error("unreachable");
			expect(dispatched.result.failureCode).toBe("COHORT_NOT_READY");
		}
	});

	test("read_path_and_overlay_arms_of_a_fanout_cell_still_take_the_leg", async () => {
		for (const armKind of ["read-path", "overlay"] as const) {
			const cell = cellOf("ticker-fanout/rate-10000");
			const arms = sealArmsForCell(cell, ["ws"], [armKind]);
			if (arms.length === 0) continue;
			const dispatched = await dispatchArmRepetition({
				arm: legInputFor(cell, armKind),
				executors: {
					measureSealAndWriteRep: async () => ({
						ok: true,
						primaryMetricP50: 3,
						sealedPath: "/dev/null",
						artifactSha256: "2".repeat(64),
					}),
					driveCohortArm: async () => {
						throw new Error(`driveCohortArm must not run for ${armKind}`);
					},
				},
			});
			expect(dispatched.route).toBe("single-session-leg");
		}
	});

	test("mini_pilot_drives_ticker_10000_ws_through_the_production_dispatch", async () => {
		// The mini pilot: `ticker-fanout/rate-10000`, ws, one publisher and eight
		// workers, driven through the seam `realRunBody` calls, against a real
		// `MacFanoutSupervisor` -- with the *default* `driveCohortArm`, so this is
		// the production executor and not a stand-in for it.
		//
		// Where the topology exactness lives: the 1+8 / 100-subscriber assertions
		// are B3's, in `fanout-supervisor-integration.test.ts`
		// (`mac_supervisor_owns_exact_ticker_1_plus_8` and the full-width relay
		// cases), against a real `FanoutLinuxAuthority`. They are not restated
		// here because the mini cohort is deliberately eight-wide -- the widest
		// `buildFanoutCohortFixture` tiles -- and a second, narrower topology
		// assertion beside the frozen one is how the two come to disagree.
		const harness = await miniHarness();
		const reached: string[] = [];
		const seals: CohortArmMeasuredV1[] = [];
		const rig = refusingBinding({
			acceptCohortGrant: (args) => {
				reached.push("acceptCohortGrant");
				// The grant that arrived is the supervisor's, for this execution,
				// on the wire the arm names.
				expect(args.grant.transport).toBe("ws");
				expect(args.grant.executionSha256).toBe(harness.executionSha256);
				expect(args.grant.publisherCount).toBe(MINI_PUBLISHERS);
				expect(args.grant.workerCount).toBe(MINI_WORKERS);
				return {
					ok: false,
					code: "COHORT_NOT_READY",
					message: "mini pilot stops at the first rig step",
				} as never;
			},
		});
		const dispatched = await dispatchArmRepetition({
			arm: legInputFor(cellOf("ticker-fanout/rate-10000"), "primary"),
			cohortRuntime: cohortRuntimeOf(harness, rig, seals),
			executors: { measureSealAndWriteRep: forbiddenLeg() },
		});
		expect(dispatched.route).toBe("cohort");
		// §5 order held from the seam down: the grant was minted and signed before
		// the binding saw anything.
		expect(reached).toEqual(["acceptCohortGrant"]);
		expect(dispatched.result.ok).toBe(false);
		if (dispatched.result.ok) throw new Error("unreachable");
		expect(dispatched.result.failureCode).toBe("COHORT_NOT_READY");
		expect(seals).toEqual([]);
	});

	test("a_terminal_export_reaches_the_seal_through_the_dispatch", async () => {
		// The other half of the mini pilot: when the executor does export, the
		// seam hands that export -- unchanged -- to the runtime's seal, and the
		// seal's result is what the campaign index will record.
		const seals: CohortArmMeasuredV1[] = [];
		const exported = {
			exportAck: { schema: "mac-cohort-evidence-exported-ack/v1" },
			admissionReceipt: { schema: "cohort-admission-receipt/v1" },
			admissionReceiptSha256: HEX("c"),
		} as unknown as CohortArmMeasuredV1;
		const dispatched = await dispatchArmRepetition({
			arm: legInputFor(cellOf("ticker-fanout/rate-10000"), "primary"),
			cohortRuntime: cohortRuntimeOf(
				await miniHarness(),
				refusingBinding(),
				seals,
				{
					ok: true,
					primaryMetricP50: 42,
					sealedPath: "/tmp/mini.sealed.json",
					artifactSha256: "3".repeat(64),
				},
			),
			executors: {
				measureSealAndWriteRep: forbiddenLeg(),
				driveCohortArm: async () => ({ ok: true, value: exported }),
			},
		});
		expect(dispatched.route).toBe("cohort");
		expect(seals.length).toBe(1);
		expect(seals[0]).toBe(exported);
		expect(dispatched.result).toEqual({
			ok: true,
			primaryMetricP50: 42,
			sealedPath: "/tmp/mini.sealed.json",
			artifactSha256: "3".repeat(64),
		});
	});
});

describe("B4: the cohort executor is a courier", () => {
	test("the_cohort_grant_is_minted_before_any_rig_step", async () => {
		const harness = await miniHarness();
		const reached: string[] = [];
		const rig = refusingBinding({
			acceptCohortGrant: (args) => {
				reached.push("acceptCohortGrant");
				// The grant the rig sees is the one the supervisor minted, and it
				// has no start timestamp -- it is pre-readiness by construction.
				expect(args.grant.schema).toBe("cohort-grant/v1");
				expect(args.grant.executionSha256).toBe(harness.executionSha256);
				expect("measureStartAtMacNs" in args.grant).toBe(false);
				const signature = JSON.parse(
					Buffer.from(args.grantSignatureBytes).toString("utf8"),
				) as { signedSchema: string };
				expect(signature.signedSchema).toBe("cohort-grant/v1");
				expect(sha256HexOfBytes(args.grantBytes)).toBe(
					sha256HexOfBytes(bytesOfCanonical(args.grant)),
				);
				return {
					ok: false,
					code: "COHORT_PROTOCOL",
					message: "stop after the first step",
				} as never;
			},
		});
		const result = await driveCohortArm(driveInput(harness, rig));
		expect(result.ok).toBe(false);
		// Exactly one rig step ran, and it is the first one in §5.
		expect(reached).toEqual(["acceptCohortGrant"]);
	});

	test("controller_cannot_inject_or_rewrite_the_bundle", async () => {
		// A binding that hands back a genuinely rig-signed acceptance bound to a
		// *different* grant digest is the injection this test is about: the
		// signature verifies, the record parses, and it still names something the
		// supervisor did not mint.
		const harness = await miniHarness();
		const rig = refusingBinding({
			acceptCohortGrant: (args) => {
				const acceptance = {
					schema: "rig-cohort-acceptance/v1",
					executionSha256: args.grant.executionSha256,
					cohortGrantSha256: HEX("f"),
					cohortGrantSignatureSha256: HEX("e"),
					roleTokenCommitmentRootSha256:
						args.grant.roleTokenCommitmentRootSha256,
					approvedPlanSha256: args.grant.approvedPlanSha256,
					approvalRecordSha256: args.grant.approvalRecordSha256,
					rigExecutionIndex: 0,
					rigSupervisorInstanceNonce: HEX("d"),
					signingPublicKeySha256: sha256HexOfBytes(harness.rigKeys.publicRaw32),
					receiptSequence: 1,
					acceptedAtMs: 1_000,
					issuedAtMs: 1_000,
					notAfterMs: 17_000_000_000_000,
				};
				const signature = signRigReceipt({
					privatePkcs8Der: harness.rigKeys.privatePkcs8Der,
					publicRaw32: harness.rigKeys.publicRaw32,
					signedSchema: "rig-cohort-acceptance/v1",
					signedBytes: bytesOf(acceptance),
				});
				return {
					ok: true,
					value: {
						acceptance,
						acceptanceBytes: bytesOf(acceptance),
						signature,
						signatureBytes: bytesOfCanonical(signature),
					},
				} as never;
			},
		});
		const result = await driveCohortArm(driveInput(harness, rig));
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		// The refusal is the supervisor's, not this file's: it names a cohort
		// grant digest the supervisor never produced.
		expect(typeof result.code).toBe("string");
	});

	test("the_supervisor_refusal_reaches_the_dispatch_as_a_closed_seven_code", async () => {
		// The same refusal as `controller_cannot_inject_or_rewrite_the_bundle`,
		// but observed where the campaign index will read it: whatever code the
		// supervisor produced has to arrive as a member of §7's closed set, or
		// the index records free text in a field a gate keys off.
		const harness = await miniHarness();
		const seals: CohortArmMeasuredV1[] = [];
		const dispatched = await dispatchArmRepetition({
			arm: legInputFor(cellOf("ticker-fanout/rate-10000"), "primary"),
			cohortRuntime: cohortRuntimeOf(harness, refusingBinding(), seals),
			executors: { measureSealAndWriteRep: forbiddenLeg() },
		});
		expect(dispatched.route).toBe("cohort");
		expect(dispatched.result.ok).toBe(false);
		if (dispatched.result.ok) throw new Error("unreachable");
		expect(CAMPAIGN_FAILURE_CODES).toContain(dispatched.result.failureCode!);
		// A cohort that never exported has nothing to seal.
		expect(seals).toEqual([]);
	});

	test("the_executor_never_reaches_the_rig_when_the_supervisor_refuses", async () => {
		const harness = await miniHarness();
		// A second open on one supervisor is refused, so nothing downstream runs.
		const first = await harness.supervisor.openCohort();
		expect(first.ok).toBe(true);
		const reached: string[] = [];
		const rig = refusingBinding({
			acceptCohortGrant: () => {
				reached.push("acceptCohortGrant");
				return { ok: true, value: { acceptance: {}, signature: {} } } as never;
			},
		});
		const result = await driveCohortArm(driveInput(harness, rig));
		expect(result.ok).toBe(false);
		expect(reached).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// B5: the production rig binding and the production cohort runtime provider
// ---------------------------------------------------------------------------

/**
 * A scripted rig on a real pipe pair.
 *
 * Deliberately a second copy of the shape `remote-supervisor.test.ts` uses
 * rather than an import: the audit forbids a test module importing another
 * test module, and the two files are testing different sides -- that one pins
 * the channel's own guards, this one pins that the *binding* puts the exact
 * bytes it was handed on that channel and nothing else.
 */
function b5FramedLength(buffer: Uint8Array): number | null {
	if (buffer.byteLength < 4) return null;
	const view = new DataView(
		buffer.buffer,
		buffer.byteOffset,
		buffer.byteLength,
	);
	const headerLength = view.getUint32(0, false);
	if (buffer.byteLength < 4 + headerLength + 8) return null;
	const payloadLength = Number(view.getBigUint64(4 + headerLength, false));
	const total = 4 + headerLength + 8 + payloadLength + 32;
	return buffer.byteLength < total ? null : total;
}

interface B5RigWire {
	readonly controllerToRig: PassThrough;
	readonly rigToController: PassThrough;
	readonly seen: Record<string, unknown>[];
}

function b5ScriptedRig(
	respond: (request: Record<string, unknown>) => Record<string, unknown>,
): B5RigWire {
	const controllerToRig = new PassThrough();
	const rigToController = new PassThrough();
	const seen: Record<string, unknown>[] = [];
	let pending = new Uint8Array(0);
	controllerToRig.on("data", (chunk: Buffer) => {
		const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
		merged.set(pending, 0);
		merged.set(new Uint8Array(chunk), pending.byteLength);
		pending = merged;
		for (;;) {
			const length = b5FramedLength(pending);
			if (length === null) return;
			const frame = pending.slice(0, length);
			pending = pending.slice(length);
			const decoded = decodeRegisteredRemotePayload(frame);
			if (!decoded.ok) throw new Error(`scripted rig: ${decoded.code}`);
			seen.push(decoded.value.payload);
			const encoded = encodeRegisteredRemotePayload(
				respond(decoded.value.payload) as Record<string, unknown> & {
					schema: string;
				},
			);
			if (!encoded.ok) throw new Error(`scripted rig encode: ${encoded.code}`);
			rigToController.write(Buffer.from(encoded.value));
		}
	});
	return { controllerToRig, rigToController, seen };
}

/** The exact refusal payload §3.3 registers; the code is the rig's own. */
function b5Refusal(
	request: Record<string, unknown>,
	code: string,
): Record<string, unknown> {
	return {
		schema: "remote-supervisor-refusal/v1",
		responseSeq: 0,
		ackRequestSeq: request.requestSeq as number,
		executionSha256: null,
		code,
		campaignStatus: "FAIL",
		terminal: true,
	};
}

const B5_DEADLINES = {
	frameMs: 5_000,
	serverReadyMs: 15_000,
	warmupDrainMs: 6_000,
	captureMs: 15_000,
	teardownMs: 10_000,
};

const B5_SPAWN = {
	serverEntrypointSha256: HEX("4"),
	bunSha256: HEX("5"),
	addonSha256: HEX("6"),
	stagedServerLaunchRecordBytes: bytesOfCanonical({
		schema: "staged-server-launch-record/v1",
		bindPort: 4433,
	}),
	bindPort: 4433,
	transport: "ws",
	serverArgv: ["server.ts", "--transport=ws", "--mode=fanout-cohort"],
} as const;

function b5Channel(
	wire: B5RigWire,
	executionSha256: Sha256Hex,
	stagedRigPublicRaw32: Uint8Array,
): CohortRigChannel {
	return new CohortRigChannel({
		controllerToRig: wire.controllerToRig,
		rigToController: wire.rigToController,
		executionSha256,
		stagedRigPublicRaw32,
		deadlines: B5_DEADLINES,
	});
}

function b5Binding(
	wire: B5RigWire,
	executionSha256: Sha256Hex,
	stagedRigPublicRaw32: Uint8Array,
	channel = b5Channel(wire, executionSha256, stagedRigPublicRaw32),
): CohortChannelRigBinding {
	return new CohortChannelRigBinding({
		channel,
		spawn: B5_SPAWN,
		macStopIssuedAtNs: () => "1700000000000000009",
		drainDeadlineMs: 10_000,
	});
}

/**
 * A scripted rig that answers RIG_EXECUTION_ACCEPTED honestly and hands every
 * later frame to `respond`, plus the binding over a channel that has already
 * accepted the harness's execution -- the state production reaches before any
 * cohort step.
 */
async function b5AcceptedBinding(
	harness: MiniHarness,
	respond: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<{
	readonly wire: B5RigWire;
	readonly binding: CohortChannelRigBinding;
}> {
	const wire = b5ScriptedRig((request) =>
		request.schema === "rig-accept-execution-request/v1"
			? scriptedRigExecutionAcceptedAck({
					rigKeys: harness.rigKeys,
					request,
					executionSha256: harness.executionSha256,
					responseSeq: 0,
					nowMs: 1_000,
				})
			: respond(request),
	);
	const channel = b5Channel(
		wire,
		harness.executionSha256,
		harness.rigKeys.publicRaw32,
	);
	const accepted = await channel.acceptExecution(harness.opened);
	if (!accepted.ok) throw new Error(`acceptExecution: ${accepted.code}`);
	return {
		wire,
		binding: b5Binding(
			wire,
			harness.executionSha256,
			harness.rigKeys.publicRaw32,
			channel,
		),
	};
}

/** The grant the scripted Mac process minted for the harness, and its signature. */
async function b5OpenedCohort(harness: MiniHarness) {
	const opened = await harness.supervisor.openCohort();
	if (!opened.ok) throw new Error(`openCohort: ${opened.code}`);
	return opened.value;
}

describe("B5: the production rig binding refuses what has no producer", () => {
	const wire = b5ScriptedRig(() => {
		throw new Error("no frame may be written by a refusing step");
	});
	const binding = b5Binding(
		wire,
		HEX("1"),
		generateEd25519KeyPair().publicRaw32,
	);

	test("register_role_peers_has_no_frame_on_the_frozen_registry", async () => {
		const result = await binding.registerRolePeers({
			scheduler: null as never,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("COHORT_NOT_READY");
		expect(result.message).toContain("role-peer registration frame");
		expect(wire.seen).toEqual([]);
	});

	test("a_manifest_whose_bytes_and_digests_disagree_never_reaches_the_wire", async () => {
		// A binding that had an epoch would still refuse this pair, and that is
		// the check under test: the two come off one supervisor ack, so a
		// disagreement means they were assembled from two different manifests.
		const manifest = bytesOfCanonical({
			schema: "role-warmup-completion-manifest/v1",
		});
		const withEpoch = b5Binding(
			wire,
			HEX("1"),
			generateEd25519KeyPair().publicRaw32,
		);
		// Reach into the epoch state the only way production does: an epoch the
		// scripted rig refuses leaves the binding without one, so the digest guard
		// is exercised through `drainWarmup`'s own ordering instead.
		const result = await withEpoch.drainWarmup({
			roleWarmupCompletionManifestBytes: manifest,
			roleWarmupCompletionManifestSignatureBytes: manifest,
			roleWarmupCompletionManifestSha256: HEX("e"),
			roleWarmupCompletionManifestSignatureSha256: HEX("e"),
			nowMs: 1_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(wire.seen).toEqual([]);
	});

	test("warmup_wire_and_measured_window_need_the_role_child_pipes", async () => {
		for (const step of [
			"runWarmupWire",
			"runMeasuredWindow",
			"collectPartials",
		] as const) {
			const result = await binding[step]();
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.code).toBe("COHORT_NOT_READY");
			expect(result.message).toContain("role-child control pipes");
		}
		expect(wire.seen).toEqual([]);
	});

	test("drain_warmup_before_an_epoch_writes_no_finish_frame", async () => {
		const manifest = bytesOfCanonical({
			schema: "role-warmup-completion-manifest/v1",
		});
		const signature = bytesOfCanonical({ schema: "mac-receipt-signature/v1" });
		const result = await binding.drainWarmup({
			roleWarmupCompletionManifestBytes: manifest,
			roleWarmupCompletionManifestSignatureBytes: signature,
			roleWarmupCompletionManifestSha256: sha256HexOfBytes(manifest),
			roleWarmupCompletionManifestSignatureSha256: sha256HexOfBytes(signature),
			nowMs: 1_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("COHORT_NOT_READY");
		expect(result.message).toContain("warmup epoch");
		expect(wire.seen).toEqual([]);
	});

	test("measure_start_before_a_drain_writes_no_baseline_frame", async () => {
		const result = await binding.measureStartAck({ nowMs: 1_000 });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("COHORT_NOT_READY");
		expect(result.message).toContain("drained receipt");
		expect(wire.seen).toEqual([]);
	});

	test("start_server_before_a_grant_writes_no_spawn_frame", async () => {
		const result = await binding.startServer();
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("COHORT_NOT_READY");
		expect(wire.seen).toEqual([]);
	});
});

describe("B5: the production rig binding is a byte-faithful courier", () => {
	test("the_grant_reaches_the_rig_as_the_exact_bytes_the_mac_signed", async () => {
		const harness = await miniHarness();
		const opened = await b5OpenedCohort(harness);
		const { wire, binding } = await b5AcceptedBinding(harness, (request) =>
			b5Refusal(request, "COHORT_NOT_READY"),
		);
		const result = await binding.acceptCohortGrant({
			grant: opened.grant,
			grantBytes: opened.grantBytes,
			grantSignatureBytes: bytesOfCanonical(opened.grantSignature),
			nowMs: 1_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		// The rig's own closed code, not one the binding chose.
		expect(result.code).toBe("COHORT_NOT_READY");

		// Frame 0 was RIG_EXECUTION_ACCEPTED; the cohort accept is frame 1 and
		// carries the acceptance the rig answered with.
		expect(wire.seen[0]?.schema).toBe("rig-accept-execution-request/v1");
		const sent = wire.seen[1];
		expect(sent).toBeDefined();
		expect(sent?.schema).toBe("rig-accept-cohort-request/v1");
		expect(typeof sent?.rigExecutionAcceptanceBase64).toBe("string");
		// The bytes on the wire are the canonical grant, digest for digest. The
		// supervisor is the one that decides what "the grant" is; the binding is
		// only allowed to carry it.
		const carried = new Uint8Array(
			Buffer.from(sent?.cohortGrantBase64 as string, "base64"),
		);
		expect(sha256HexOfBytes(carried)).toBe(
			sha256HexOfBytes(bytesOfCanonical(opened.grant)),
		);
		expect(
			sha256HexOfBytes(
				new Uint8Array(
					Buffer.from(sent?.cohortGrantSignatureBase64 as string, "base64"),
				),
			),
		).toBe(sha256HexOfBytes(bytesOfCanonical(opened.grantSignature)));
	});

	test("a_rig_refusal_surfaces_as_its_own_closed_code", async () => {
		for (const code of [
			"COHORT_PROTOCOL",
			"CROSS_SUPERVISOR_MISMATCH",
			"COHORT_NOT_READY",
		] as const) {
			const harness = await miniHarness();
			const opened = await b5OpenedCohort(harness);
			const { binding } = await b5AcceptedBinding(harness, (request) =>
				b5Refusal(request, code),
			);
			const result = await binding.acceptCohortGrant({
				grant: opened.grant,
				grantBytes: opened.grantBytes,
				grantSignatureBytes: bytesOfCanonical(opened.grantSignature),
				nowMs: 1_000,
			});
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.code).toBe(code);
			expect(CAMPAIGN_FAILURE_CODES.includes(result.code as never)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// The production provider
// ---------------------------------------------------------------------------

const B5_SOURCE_IDENTITY = {
	sourceSha: "0".repeat(40),
	archiveSha256: HEX("1"),
	executableSha256: HEX("2"),
};

function b5ProviderContext(
	cellId: string,
	armKind: "primary" | "read-path" | "overlay",
): CohortArmRuntimeContext {
	const cell = cellOf(cellId);
	const arm = sealArmsForCell(cell, ["ws"], [armKind])[0];
	if (arm === undefined) throw new Error(`no ${armKind} arm for ${cellId}`);
	return {
		cell,
		arm,
		cohortCellId:
			cohortCellForArm({ cellId, armKind }) ?? "ticker-fanout/rate-10000",
		runId: `b5-${cellId}-${armKind}`,
		repetitionKind: "measured",
		repetitionIndex: 1,
		perRepPath: "/dev/null",
		sealedPath: "/dev/null",
	};
}

describe("B5: the production cohort runtime provider", () => {
	test("a_fanout_primary_gets_a_runtime_when_a_lease_exists", async () => {
		const harness = await miniHarness();
		const leases: CohortArmRuntimeContext[] = [];
		const provider = createCohortArmRuntimeProvider({
			lease: (context) => {
				leases.push(context);
				return {
					ok: true,
					value: b5Lease(harness, refusingBinding()),
				};
			},
			sourceIdentity: B5_SOURCE_IDENTITY,
			executionPurpose: "pilot",
			repetitionTotal: 1,
		});
		for (const cellId of FANOUT_COHORT_CELL_IDS) {
			const context = b5ProviderContext(cellId, "primary");
			const runtime = await provider(context);
			expect(runtime.ok).toBe(true);
			if (!runtime.ok) throw new Error(runtime.message);
			expect(runtime.value.supervisor).toBe(harness.supervisor);
			expect(typeof runtime.value.seal).toBe("function");
		}
		expect(leases.length).toBe(FANOUT_COHORT_CELL_IDS.length);
	});

	test("the_provider_refuses_every_arm_the_router_does_not_route", async () => {
		const harness = await miniHarness();
		const provider = createCohortArmRuntimeProvider({
			lease: () => ({ ok: true, value: b5Lease(harness, refusingBinding()) }),
			sourceIdentity: B5_SOURCE_IDENTITY,
			executionPurpose: "pilot",
			repetitionTotal: 1,
		});
		let refused = 0;
		for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
			for (const armKind of ["primary", "read-path", "overlay"] as const) {
				if (cohortCellForArm({ cellId: cell.cellId, armKind }) !== null) {
					continue;
				}
				const arms = sealArmsForCell(cell, ["ws"], [armKind]);
				if (arms.length === 0) continue;
				const result = await provider(b5ProviderContext(cell.cellId, armKind));
				expect(result.ok).toBe(false);
				if (result.ok) throw new Error("unreachable");
				expect(result.code).toBe("COHORT_PROTOCOL");
				refused += 1;
			}
		}
		expect(refused).toBeGreaterThan(0);
	});

	test("no_lease_refuses_cohort_not_ready_and_names_the_missing_input", async () => {
		const provider = createCohortArmRuntimeProvider({
			sourceIdentity: B5_SOURCE_IDENTITY,
			executionPurpose: "pilot",
			repetitionTotal: 1,
		});
		const result = await provider(
			b5ProviderContext("ticker-fanout/rate-10000", "primary"),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("COHORT_NOT_READY");
		// The named missing input moved when the three Mac seams got production
		// implementers: what a leaseless provider is now missing is the Phase-A
		// half of `CohortArmLease`, not the supervisor's seams.
		// The named missing input is the production acquisition's: the two
		// supervisor control channels realRun spawns, without which no lease
		// factory exists.
		expect(result.message).toContain("no cohort lease factory");
		expect(result.message).toContain("acquireCohortArmMaterial");
	});

	test("the_leaseless_provider_refuses_the_primary_and_never_runs_a_leg", async () => {
		const cell = cellOf("ticker-fanout/rate-10000");
		const dispatched = await dispatchArmRepetition({
			arm: legInputFor(cell, "primary"),
			cohortRuntime: createCohortArmRuntimeProvider({
				sourceIdentity: B5_SOURCE_IDENTITY,
				executionPurpose: "pilot",
				repetitionTotal: 1,
			}),
			executors: { measureSealAndWriteRep: forbiddenLeg() },
		});
		expect(dispatched.route).toBe("cohort");
		expect(dispatched.result.ok).toBe(false);
		if (dispatched.result.ok) throw new Error("unreachable");
		// This is what lands in the campaign index entry.
		expect(dispatched.result.failureCode).toBe("COHORT_NOT_READY");
	});
});

/** A lease over the mini harness; finalization is refused by name. */
function b5Lease(harness: MiniHarness, rig: CohortRigBinding): CohortArmLease {
	return {
		...driveInput(harness, rig),
		executionSha256: harness.executionSha256,
		publisherCount: MINI_PUBLISHERS,
		subscriberCount: MINI_SUBSCRIBERS,
		comparisonId: "camp",
		executionIndex: 0,
		finalize: async () => ({
			ok: false,
			code: "CROSS_SUPERVISOR_MISMATCH",
			message: "the b5 lease finalizes nothing",
		}),
		cleanup: (path) => harness.supervisor.teardown(path),
	};
}

describe("B5: the seal refuses what finalization refused", () => {
	test("a_finalization_refusal_is_a_closed_fail_and_writes_nothing", async () => {
		const harness = await miniHarness();
		const provider = createCohortArmRuntimeProvider({
			lease: () => ({ ok: true, value: b5Lease(harness, refusingBinding()) }),
			sourceIdentity: B5_SOURCE_IDENTITY,
			executionPurpose: "pilot",
			repetitionTotal: 1,
		});
		const context = b5ProviderContext("ticker-fanout/rate-10000", "primary");
		const runtime = await provider({
			...context,
			sealedPath: "/tmp/b5-never-written.sealed.json",
		});
		expect(runtime.ok).toBe(true);
		if (!runtime.ok) throw new Error(runtime.message);
		const result = await runtime.value.seal({
			executionSha256: harness.executionSha256,
			cohortGrantSha256: HEX("c"),
			capture: null as never,
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		// The lease's own closed code, carried into the index field a gate reads.
		expect(result.failureCode).toBe("CROSS_SUPERVISOR_MISMATCH");
		expect(result.reason).toContain("finalization refused");
		expect(existsSync("/tmp/b5-never-written.sealed.json")).toBe(false);
	});
});

describe("B5: driveCohortArm couriers the binary's bytes", () => {
	test("the_binary_signed_epoch_reaches_the_rig_as_the_exact_bytes_it_was_issued_with", async () => {
		// The lifecycle up to the warmup epoch, against the real supervisor over
		// the scripted Mac process: a rig-signed acceptance that names the
		// grant the binary minted, then the epoch the binary signs. The binding
		// records what the executor hands it for the rig and stops there.
		const harness = await miniHarness();
		let carried: {
			epochBytes: Uint8Array;
			epochSignatureBytes: Uint8Array;
		} | null = null;
		const rig = refusingBinding({
			acceptCohortGrant: (args) => {
				const acceptance = {
					schema: "rig-cohort-acceptance/v1",
					executionSha256: args.grant.executionSha256,
					cohortGrantSha256: sha256HexOfBytes(args.grantBytes),
					cohortGrantSignatureSha256: sha256HexOfBytes(
						args.grantSignatureBytes,
					),
					roleTokenCommitmentRootSha256:
						args.grant.roleTokenCommitmentRootSha256,
					approvedPlanSha256: args.grant.approvedPlanSha256,
					approvalRecordSha256: args.grant.approvalRecordSha256,
					rigExecutionIndex: 0,
					rigSupervisorInstanceNonce: HEX("d"),
					signingPublicKeySha256: sha256HexOfBytes(harness.rigKeys.publicRaw32),
					receiptSequence: 1,
					acceptedAtMs: 1_000,
					issuedAtMs: 1_000,
					notAfterMs: 17_000_000_000_000,
				};
				const acceptanceBytes = bytesOfCanonical(acceptance);
				const signature = signRigReceipt({
					privatePkcs8Der: harness.rigKeys.privatePkcs8Der,
					publicRaw32: harness.rigKeys.publicRaw32,
					signedSchema: "rig-cohort-acceptance/v1",
					signedBytes: acceptanceBytes,
				});
				return {
					ok: true,
					value: {
						acceptance,
						acceptanceBytes,
						signature,
						signatureBytes: bytesOfCanonical(signature),
					},
				} as never;
			},
			startServer: () =>
				({
					ok: true,
					value: {
						childPid: 4242,
						childPgid: 4242,
						childInstanceNonce: HEX("9"),
						serverReadyFrameSha256: HEX("8"),
					},
				}) as never,
			registerRolePeers: () => ({ ok: true, value: true }),
			acceptWarmupEpoch: (args) => {
				carried = {
					epochBytes: args.epochBytes,
					epochSignatureBytes: args.epochSignatureBytes,
				};
				return {
					ok: false,
					code: "COHORT_PROTOCOL",
					message: "stop once the epoch has been couriered",
				} as never;
			},
		});
		const input = {
			...driveInput(harness, rig),
			// The lifecycle reaches the spawn now, so the bundles are real: built
			// from the material the harness's minter produced for this attempt.
			bundleFor: (plan: MacFanoutChildPlanV1): TokenBundleV1 => {
				const material = harness.fixtures.get(harness.supervisor.cohortAttempt);
				const grantSha256 = harness.supervisor.cohortGrantSha256;
				if (material === undefined || grantSha256 === null) {
					throw new Error("no minted material for this attempt");
				}
				const bundle = macTokenBundleForPlan({
					plan,
					executionSha256: harness.executionSha256,
					cohortGrantSha256: grantSha256,
					material,
				});
				if (!bundle.ok) throw new Error(`bundle: ${bundle.code}`);
				return bundle.value;
			},
		};
		const result = await driveCohortArm(input);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.message).toContain("stop once the epoch");
		expect(carried).not.toBeNull();
		const bytes = (carried as unknown as { epochBytes: Uint8Array }).epochBytes;
		const signatureBytes = (
			carried as unknown as { epochSignatureBytes: Uint8Array }
		).epochSignatureBytes;
		// The bytes the rig receives verify under the scripted Mac's key: they
		// are the binary's, not a controller re-encoding.
		const signature = JSON.parse(Buffer.from(signatureBytes).toString("utf8"));
		expect(
			verifyMacReceiptSignature({
				stagedMacPublicRaw32: harness.macKeys.publicRaw32,
				signedBytes: bytes,
				signature,
			}).ok,
		).toBe(true);
		// And the same bytes were retained for the role children's warmup start.
		expect(input.retention.epoch).not.toBeNull();
		expect(sha256HexOfBytes(input.retention.epoch?.bytes as Uint8Array)).toBe(
			sha256HexOfBytes(bytes),
		);
		expect(input.retention.grant?.sha256).toBe(
			harness.supervisor.cohortGrantSha256 as string,
		);
	});
});

// ---------------------------------------------------------------------------
// B3.5 blocker 9: the Mac-owned role-child half of the lifecycle
//
// `CohortChannelRigBinding` refuses `registerRolePeers`, `runWarmupWire` and
// `runMeasuredWindow` because their evidence arrives on the role-child control
// pipes rather than on the rig channel. `MacRoleChildCohortDriver` is the caller
// of the reader for those pipes, and the tests below drive it against scripted
// children over the *real* `MacRoleChildControlChannel` -- real section 3.4
// framing, real per-direction sequences, real caps -- with only the descriptors
// replaced, because the framing is the part that has to be right.
// ---------------------------------------------------------------------------

interface ScriptedChild {
	readonly channel: MacRoleChildControlChannel;
	/** Frames the supervisor sent, decoded, in order. */
	readonly received: Record<string, unknown>[];
	/** Queue one child -> supervisor frame, stamped with the next sequence. */
	readonly reply: (payload: Record<string, unknown>) => void;
	/** Close the child's write end: the supervisor sees EOF. */
	readonly hangUp: () => void;
	/** Exact canonical payloads this child put on the wire, in order. */
	readonly sentPayloads: Uint8Array[];
}

function scriptedChild(args: {
	readonly childId: string;
	readonly assignedSessionCount: number;
}): ScriptedChild {
	const received: Record<string, unknown>[] = [];
	const inbound: Uint8Array[] = [];
	let waiting: ((chunk: Uint8Array | null) => void) | null = null;
	let ended = false;
	let childOutboundSequence = 0;
	const sentPayloads: Uint8Array[] = [];
	const supervisorReader = new RoleChildFrameReader();
	void supervisorReader;

	const deliver = (chunk: Uint8Array | null): void => {
		if (waiting !== null) {
			const resolve = waiting;
			waiting = null;
			resolve(chunk);
			return;
		}
		if (chunk !== null) inbound.push(chunk);
	};

	const channel = new MacRoleChildControlChannel({
		childId: args.childId,
		maxFramesPerDirection: roleChildMaxFramesPerDirection(
			args.assignedSessionCount,
		),
		readFd: -1,
		writeFd: -1,
		receiveDeadlineMs: 1_000,
		read: () =>
			new Promise<Uint8Array | null>((resolve) => {
				const queued = inbound.shift();
				if (queued !== undefined) {
					resolve(queued);
					return;
				}
				if (ended) {
					resolve(null);
					return;
				}
				waiting = resolve;
			}),
		write: async (_fd, bytes) => {
			// The supervisor's frame, decoded the way the child would decode it.
			const decoded = decodeRoleChildFrame(bytes);
			if (!decoded.ok) throw new Error(`supervisor frame: ${decoded.code}`);
			received.push(decoded.value);
		},
	});

	return {
		channel,
		received,
		reply: (payload) => {
			const encoded = encodeRoleChildFrame({
				...payload,
				schema: payload.schema as string,
				sequence: childOutboundSequence,
			});
			if (!encoded.ok) throw new Error(`child frame: ${encoded.code}`);
			childOutboundSequence += 1;
			sentPayloads.push(encoded.value.slice(4));
			deliver(encoded.value);
		},
		hangUp: () => {
			ended = true;
			deliver(null);
		},
		sentPayloads,
	};
}

/** A host whose channels are the scripted ones; nothing is ever forked. */
function scriptedHost(children: ReadonlyMap<string, ScriptedChild>) {
	const signals: { pgid: number; signal: string }[] = [];
	return {
		spawnChild: (() => {
			throw new Error("the scripted host does not spawn");
		}) as never,
		processControl: {
			killPgid: (pgid: number, signal: string) => {
				signals.push({ pgid, signal });
			},
			waitPgid: () => true,
		},
		channel: (childId: string) => children.get(childId)?.channel,
		channels: new Map([...children].map(([id, child]) => [id, child.channel])),
		spawned: [],
		closeAll: () => {
			for (const child of children.values()) child.channel.close();
		},
		signals,
	};
}

describe("B3.5: the Mac role-child driver reads the pipes nobody read", () => {
	const EXECUTION = HEX("1");
	const GRANT = HEX("2");
	const BARRIER = HEX("3");
	/** The barrier's declared stop; the scripted clocks below are already past it. */
	const MEASURE_STOP_NS = "1000000000";
	/** What the driver told the supervisor about each child, in order. */
	const stampsSeen: Record<string, unknown>[] = [];
	function recordingStamps() {
		return {
			markChildLifecycle: (args: Record<string, unknown>) => {
				stampsSeen.push(args);
				return { ok: true as const, value: true as const };
			},
		};
	}

	const publisherPlan: MacFanoutChildPlanV1 = {
		childId: "publisher-child-0",
		role: "publisher",
		publisherId: "publisher-000000",
		workerIndex: null,
		assignedGlobalOrdinals: [24],
		assignedRoleIds: ["publisher-000000"],
		controlReadFd: 3,
		controlWriteFd: 4,
		tokenBundleFd: 5,
	};

	function driverFor(child: ScriptedChild) {
		const children = new Map([[publisherPlan.childId, child]]);
		const host = scriptedHost(children);
		const driver = new MacRoleChildCohortDriver({
			host: host as unknown as MacFanoutRoleChildHost,
			children: [publisherPlan],
			executionSha256: EXECUTION,
			joins: {
				cohortGrantSha256: () => GRANT,
				cohortStartBarrierSha256: () => BARRIER,
				measureStopAtMacNs: () => MEASURE_STOP_NS,
			},
			stamps: recordingStamps(),
			frames: {
				spawnConfigFor: () => ({
					ok: true,
					value: { schema: "role-spawn-config/v1" as const },
				}),
				warmupStartFor: () => ({
					ok: true,
					value: { schema: "role-warmup-start/v1" as const },
				}),
				measureStart: () => ({
					ok: true,
					value: { schema: "role-measure-start/v1" as const },
				}),
			},
			clock: { nowMs: () => Date.now(), nowNs: () => "1000000000" },
			readinessDeadlineMs: 1_000,
			warmupDeadlineMs: 1_000,
			measuredDeadlineMs: 1_000,
			teardownDeadlineMs: 1_000,
		});
		return { driver, host, child };
	}

	function warmupComplete(overrides: Record<string, unknown> = {}) {
		return {
			schema: "role-warmup-complete/v1",
			executionSha256: EXECUTION,
			cohortGrantSha256: GRANT,
			cohortWarmupEpochSha256: HEX("4"),
			warmupNonce: HEX("5"),
			childId: publisherPlan.childId,
			role: "publisher",
			startedAtMacNs: "1000000000",
			completedAtMacNs: "6000000000",
			offeredWarmupIngress: 10,
			deliveredWarmupRecords: 0,
			...overrides,
		};
	}

	test("a warmup completion is carried as the exact bytes the child wrote", async () => {
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		child.reply(warmupComplete());
		const run = await driver.runWarmupWire();
		expect(run.ok).toBe(true);
		if (!run.ok) throw new Error("unreachable");
		expect(run.value.roleWarmupCompleteBytes.length).toBe(1);

		// The manifest entry's digest is the digest of the frame payload the
		// child actually produced -- not of a record re-encoded from the parse.
		const bytes = run.value.roleWarmupCompleteBytes[0] as Uint8Array;
		// Byte-for-byte what the child put on the wire. The codec's canonical
		// re-encode check makes this identity structural rather than incidental,
		// and pinning it is what keeps a future "normalise on the way in" from
		// making the signed manifest name bytes no child wrote.
		expect([...bytes]).toEqual([...(child.sentPayloads[0] as Uint8Array)]);
		// And the payload really does parse back to the child's record.
		expect(JSON.parse(Buffer.from(bytes).toString("utf8")).childId).toBe(
			publisherPlan.childId,
		);
		// The child was asked exactly twice: its config, then its warmup start.
		expect(child.received.map((frame) => frame.schema)).toEqual([
			"role-spawn-config/v1",
			"role-warmup-start/v1",
		]);
	});

	test("a completion naming another child is refused on this child's pipe", async () => {
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		child.reply(warmupComplete({ childId: "subscriber-worker-3" }));
		const run = await driver.runWarmupWire();
		expect(run.ok).toBe(false);
		if (run.ok) throw new Error("unreachable");
		expect(run.code).toBe("CROSS_SUPERVISOR_MISMATCH");
	});

	test("a silent child is a warmup deadline, not a hang", async () => {
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		const run = await driver.runWarmupWire();
		expect(run.ok).toBe(false);
		if (run.ok) throw new Error("unreachable");
		expect(run.code).toBe("WARMUP_DEADLINE_EXCEEDED");
	}, 10_000);

	test("a child that hangs up mid-lifecycle is UNEXPECTED_EOF", async () => {
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		child.hangUp();
		const run = await driver.runWarmupWire();
		expect(run.ok).toBe(false);
		if (run.ok) throw new Error("unreachable");
		expect(run.code).toBe("UNEXPECTED_EOF");
	});

	test("a frame the lifecycle did not ask for is refused rather than buffered", async () => {
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		// The partial arrives where the warmup completion was owed. Buffering it
		// would let a child reorder its own lifecycle.
		child.reply({
			schema: "role-partial/v1",
			executionSha256: EXECUTION,
			childId: publisherPlan.childId,
			partialKind: "publisher",
			partialBase64: "e30=",
			partialSha256: HEX("7"),
		});
		const run = await driver.runWarmupWire();
		expect(run.ok).toBe(false);
		if (run.ok) throw new Error("unreachable");
		expect(run.code).toBe("STATE_INVALID");
	});

	test("spawn configs are delivered once and only once", async () => {
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		const again = await driver.deliverSpawnConfigs();
		expect(again.ok).toBe(false);
		if (again.ok) throw new Error("unreachable");
		expect(again.code).toBe("COHORT_PROTOCOL");
	});

	test("the ramp cannot start before any child has its config", async () => {
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		const ramped = await driver.registerRolePeers({
			scheduler: null as never,
		});
		expect(ramped.ok).toBe(false);
		if (ramped.ok) throw new Error("unreachable");
		expect(ramped.code).toBe("COHORT_NOT_READY");
	});

	test("a permit issued from another child's poll of the scheduler still releases its owner", async () => {
		// Two publishers, both ordinals due at the same instant. `issueReady`
		// hands out every due permit smallest ordinal first, so whichever
		// child polls first issues -- and the driver sends -- both grants. The
		// other child's own poll then finds nothing left to issue; its wait
		// has to key on its ordinal having been issued, not on its poll having
		// been the one that issued it (the four-execution run stalled eight of
		// ten publishers this way, READY_DEADLINE_EXCEEDED after 90 s).
		const plans: MacFanoutChildPlanV1[] = [0, 1].map((ordinal) => ({
			childId: `publisher-child-${ordinal}`,
			role: "publisher",
			publisherId: `publisher-${ordinal.toString().padStart(6, "0")}`,
			workerIndex: null,
			assignedGlobalOrdinals: [ordinal],
			assignedRoleIds: [`publisher-${ordinal.toString().padStart(6, "0")}`],
			controlReadFd: 3,
			controlWriteFd: 4,
			tokenBundleFd: 5,
		}));
		const children = new Map(
			plans.map((plan) => [
				plan.childId,
				scriptedChild({ childId: plan.childId, assignedSessionCount: 1 }),
			]),
		);
		const host = scriptedHost(children);
		const RAMP_EPOCH_NS = "1000000000";
		// Before the epoch: nothing is due until the clock is moved.
		let nowNs = "999999999";
		const driver = new MacRoleChildCohortDriver({
			host: host as unknown as MacFanoutRoleChildHost,
			children: plans,
			executionSha256: EXECUTION,
			joins: {
				cohortGrantSha256: () => GRANT,
				cohortStartBarrierSha256: () => BARRIER,
				measureStopAtMacNs: () => MEASURE_STOP_NS,
			},
			stamps: recordingStamps(),
			frames: {
				spawnConfigFor: () => ({
					ok: true,
					value: { schema: "role-spawn-config/v1" as const },
				}),
				warmupStartFor: () => ({
					ok: true,
					value: { schema: "role-warmup-start/v1" as const },
				}),
				measureStart: () => ({
					ok: true,
					value: { schema: "role-measure-start/v1" as const },
				}),
			},
			clock: { nowMs: () => Date.now(), nowNs: () => nowNs },
			readinessDeadlineMs: 1_000,
			warmupDeadlineMs: 1_000,
			measuredDeadlineMs: 1_000,
			teardownDeadlineMs: 1_000,
		});
		const scheduler = new MacPermitScheduler({
			executionSha256: EXECUTION,
			cohortGrantSha256: GRANT,
			publisherCount: 2,
			subscriberCount: 0,
			rampEpochMacNs: RAMP_EPOCH_NS,
			readinessDeadlineMs: 30_000,
			childIdForOrdinal: (ordinal) => `publisher-child-${ordinal}`,
		});
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		// Both requests are on the pipes before the ramp starts.
		for (const plan of plans) {
			children.get(plan.childId)?.reply({
				schema: "connect-permit-request/v1",
				executionSha256: EXECUTION,
				cohortGrantSha256: GRANT,
				childId: plan.childId,
				globalOrdinal: plan.assignedGlobalOrdinals[0],
				roleId: plan.assignedRoleIds[0],
			});
		}
		// Each child answers the grant it receives, whichever poll issued it.
		const answered = new Set<string>();
		const answerGrants = (): void => {
			for (const [childId, child] of children) {
				if (answered.has(childId)) continue;
				const grant = child.received.find(
					(frame) => frame.schema === "connect-permit-grant/v1",
				);
				if (grant === undefined) continue;
				answered.add(childId);
				child.reply({
					schema: "connect-permit-complete/v1",
					executionSha256: EXECUTION,
					cohortGrantSha256: GRANT,
					childId,
					globalOrdinal: grant.globalOrdinal,
					permitNonce: grant.permitNonce,
					startedAtMacNs: nowNs,
					completedAtMacNs: nowNs,
					outcome: "ready",
				});
				child.reply({
					schema: "role-ready/v1",
					executionSha256: EXECUTION,
					cohortGrantSha256: GRANT,
					childId,
					childPid: 4242,
					childPgid: 4242,
					childInstanceNonce: HEX("9"),
					registeredSessionCount: 1,
				});
			}
		};
		const ramp = driver.registerRolePeers({ scheduler });
		// Let both children queue their requests while nothing is due, then
		// move the clock past both permit times in one step.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(scheduler.pendingCount).toBe(2);
		expect(scheduler.grantedCount).toBe(0);
		nowNs = "2000000000";
		const watcher = setInterval(answerGrants, 1);
		let ramped: Awaited<typeof ramp>;
		try {
			ramped = await ramp;
		} finally {
			clearInterval(watcher);
		}
		expect(ramped).toEqual({ ok: true, value: true });
		expect(scheduler.grantedCount).toBe(2);
		expect(scheduler.completedCount).toBe(2);
		for (const child of children.values()) {
			expect(
				child.received.filter(
					(frame) => frame.schema === "connect-permit-grant/v1",
				),
			).toHaveLength(1);
		}
	});

	function measureStartAck() {
		return {
			schema: "role-measure-start-ack/v1",
			executionSha256: EXECUTION,
			childId: publisherPlan.childId,
			cohortStartBarrierSha256: BARRIER,
			armedAtMacNs: "1000000000",
		};
	}

	function publisherPartial() {
		const partialBytes = new TextEncoder().encode("{}");
		return {
			schema: "role-partial/v1",
			executionSha256: EXECUTION,
			childId: publisherPlan.childId,
			partialKind: "publisher",
			partialBase64: Buffer.from(partialBytes).toString("base64"),
			partialSha256: sha256HexOfBytes(partialBytes),
		};
	}

	test("the measured window returns at the declared Mac stop with the stop queued, and reads no partial before the capture", async () => {
		// Plan §5 steps 11-14: the Mac stop, then Linux's drain and capture,
		// then the partials. The relay sends the subscriber end markers only
		// when it drains on the capture request, and a worker's partial
		// states those markers -- so a driver that waited for the partials
		// before the capture (the gate-3 order) held every worker to its 10 s
		// drain deadline and closed 671 sockets as disconnects (relay-r-h.md §4).
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		// Nothing to collect before the window is armed.
		const early = await driver.collectPartials();
		expect(early.ok).toBe(false);
		if (early.ok) throw new Error("unreachable");
		expect(early.code).toBe("COHORT_NOT_READY");

		child.reply(measureStartAck());
		const stopped = await driver.runMeasuredWindow();
		expect(stopped).toEqual({
			ok: true,
			value: { measureStopAtMacNs: MEASURE_STOP_NS },
		});
		// Armed and stopped, and nothing past that: no partial was asked for.
		expect(child.received.map((frame) => frame.schema)).toEqual([
			"role-spawn-config/v1",
			"role-measure-start/v1",
			"role-stop/v1",
		]);
		// The stop carries the barrier's declared stop, not the write instant.
		expect(child.received[2]?.stopAtMacNs).toBe(MEASURE_STOP_NS);
		expect(child.received[2]?.cohortStartBarrierSha256).toBe(BARRIER);
		// A second arming is refused: the window is one per cohort.
		const again = await driver.runMeasuredWindow();
		expect(again.ok).toBe(false);
		if (again.ok) throw new Error("unreachable");
		expect(again.code).toBe("COHORT_PROTOCOL");

		// After the capture, the partial and the exit.
		child.reply(publisherPartial());
		child.reply({
			schema: "role-exited/v1",
			executionSha256: EXECUTION,
			childId: publisherPlan.childId,
			exitCode: 0,
		});
		const collected = await driver.collectPartials();
		expect(collected.ok).toBe(true);
		if (!collected.ok) throw new Error("unreachable");
		expect(collected.value.partials.map((partial) => partial.childId)).toEqual([
			publisherPlan.childId,
		]);
		expect(child.received.map((frame) => frame.schema)).toEqual([
			"role-spawn-config/v1",
			"role-measure-start/v1",
			"role-stop/v1",
			"role-partial-accepted/v1",
			"role-exit/v1",
		]);
		// The process proof's stamps went to the supervisor from the frames
		// that carry them: armed from the ack, stopped from the declared stop,
		// the exit code from `role-exited/v1`
		// (`MacFanoutSupervisor.buildObservedProcessProof` requires all three).
		expect(stampsSeen.slice(-2)).toEqual([
			{
				childId: publisherPlan.childId,
				measureArmedAtMacNs: "1000000000",
				stoppedAtMacNs: MEASURE_STOP_NS,
			},
			{ childId: publisherPlan.childId, exitCode: 0 },
		]);
	});

	test("the measured window does not return before the Mac clock reaches the declared stop", async () => {
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const children = new Map([[publisherPlan.childId, child]]);
		const host = scriptedHost(children);
		// A clock that moves: the stop is 150 ms ahead of arming.
		const startedAtMs = Date.now();
		const stopAtNs = (BigInt(startedAtMs + 150) * 1_000_000n).toString();
		const driver = new MacRoleChildCohortDriver({
			host: host as unknown as MacFanoutRoleChildHost,
			children: [publisherPlan],
			executionSha256: EXECUTION,
			joins: {
				cohortGrantSha256: () => GRANT,
				cohortStartBarrierSha256: () => BARRIER,
				measureStopAtMacNs: () => stopAtNs,
			},
			stamps: recordingStamps(),
			frames: {
				spawnConfigFor: () => ({
					ok: true,
					value: { schema: "role-spawn-config/v1" as const },
				}),
				warmupStartFor: () => ({
					ok: true,
					value: { schema: "role-warmup-start/v1" as const },
				}),
				measureStart: () => ({
					ok: true,
					value: { schema: "role-measure-start/v1" as const },
				}),
			},
			clock: {
				nowMs: () => Date.now(),
				nowNs: () => (BigInt(Date.now()) * 1_000_000n).toString(),
			},
			readinessDeadlineMs: 1_000,
			warmupDeadlineMs: 1_000,
			measuredDeadlineMs: 1_000,
			teardownDeadlineMs: 1_000,
		});
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		child.reply(measureStartAck());
		const stopped = await driver.runMeasuredWindow();
		expect(stopped.ok).toBe(true);
		expect(Date.now()).toBeGreaterThanOrEqual(startedAtMs + 150);
		expect(child.received[2]?.stopAtMacNs).toBe(stopAtNs);
	});

	test("a role-exited/v1 already on the pipe before the driver arms its teardown wait is not lost", async () => {
		// R-L, driver side. The teardown receive (`runMeasuredWindow`: send
		// `role-exit/v1`, then `receive("role-exited/v1")`) is armed after the
		// child may already have answered: the child closes its sessions and
		// writes `role-exited/v1` the moment it reads `role-exit/v1`
		// (fanout-role.ts). Over the real descriptors and the real
		// `readChunkFromFd`, everything the child wrote before the driver's
		// wait -- here the whole measured-window reply, written before
		// `runMeasuredWindow()` is even called -- sits in the kernel pipe and
		// in the channel's frame queue until the lifecycle asks for it.
		const childToParent = createCloexecPipe({ parentKeeps: "read" });
		const parentToChild = createCloexecPipe({ parentKeeps: "write" });
		if (!childToParent.ok || !parentToChild.ok) throw new Error("pipe");
		const channel = new MacRoleChildControlChannel({
			childId: publisherPlan.childId,
			maxFramesPerDirection: roleChildMaxFramesPerDirection(1),
			readFd: childToParent.pipe.parentFd,
			writeFd: parentToChild.pipe.parentFd,
			receiveDeadlineMs: 1_000,
		});
		const host = {
			...scriptedHost(new Map()),
			channel: (childId: string) =>
				childId === publisherPlan.childId ? channel : undefined,
			channels: new Map([[publisherPlan.childId, channel]]),
			closeAll: () => channel.close(),
		};
		const driver = new MacRoleChildCohortDriver({
			host: host as unknown as MacFanoutRoleChildHost,
			children: [publisherPlan],
			executionSha256: EXECUTION,
			joins: {
				cohortGrantSha256: () => GRANT,
				cohortStartBarrierSha256: () => BARRIER,
				measureStopAtMacNs: () => MEASURE_STOP_NS,
			},
			stamps: recordingStamps(),
			frames: {
				spawnConfigFor: () => ({
					ok: true,
					value: { schema: "role-spawn-config/v1" as const },
				}),
				warmupStartFor: () => ({
					ok: true,
					value: { schema: "role-warmup-start/v1" as const },
				}),
				measureStart: () => ({
					ok: true,
					value: { schema: "role-measure-start/v1" as const },
				}),
			},
			clock: { nowMs: () => Date.now(), nowNs: () => "1000000000" },
			readinessDeadlineMs: 1_000,
			warmupDeadlineMs: 1_000,
			measuredDeadlineMs: 1_000,
			teardownDeadlineMs: 1_000,
		});
		try {
			expect((await driver.deliverSpawnConfigs()).ok).toBe(true);

			// The child's entire reply to the measured window, on the kernel
			// pipe before the driver has sent a single measured-window frame.
			let childSequence = 0;
			const childWrites = (payload: Record<string, unknown>): void => {
				const encoded = encodeRoleChildFrame({
					...payload,
					schema: payload.schema as string,
					sequence: childSequence,
				});
				if (!encoded.ok) throw new Error(`child frame: ${encoded.code}`);
				childSequence += 1;
				writeSync(childToParent.pipe.childFd, encoded.value);
			};
			const partialBytes = new TextEncoder().encode("{}");
			childWrites({
				schema: "role-measure-start-ack/v1",
				executionSha256: EXECUTION,
				childId: publisherPlan.childId,
				cohortStartBarrierSha256: BARRIER,
				armedAtMacNs: "1000000000",
			});
			childWrites({
				schema: "role-partial/v1",
				executionSha256: EXECUTION,
				childId: publisherPlan.childId,
				partialKind: "publisher",
				partialBase64: Buffer.from(partialBytes).toString("base64"),
				partialSha256: sha256HexOfBytes(partialBytes),
			});
			childWrites({
				schema: "role-exited/v1",
				executionSha256: EXECUTION,
				childId: publisherPlan.childId,
				exitCode: 0,
			});

			const stopped = await driver.runMeasuredWindow();
			expect(stopped).toEqual({
				ok: true,
				value: { measureStopAtMacNs: MEASURE_STOP_NS },
			});
			const run = await driver.collectPartials();
			expect(run).toEqual({
				ok: true,
				value: {
					partials: [
						{
							childId: publisherPlan.childId,
							frame: expect.objectContaining({ schema: "role-partial/v1" }),
						},
					],
				},
			});
			expect(channel.receivedCount).toBe(3);
			expect(channel.refusal).toBeNull();

			// The driver said everything the lifecycle owes the child, in order,
			// and asked for the exit before it waited on it.
			channel.close();
			const reader = new RoleChildFrameReader();
			const supervisorFrames: string[] = [];
			const buffer = Buffer.alloc(64 * 1024);
			for (;;) {
				const read = readSync(parentToChild.pipe.childFd, buffer);
				if (read === 0) break;
				const pushed = reader.push(new Uint8Array(buffer.subarray(0, read)));
				if (!pushed.ok) throw new Error(`supervisor framing: ${pushed.code}`);
				for (const frame of pushed.value) {
					const decoded = decodeRoleChildFrame(frame);
					if (!decoded.ok) throw new Error(`supervisor frame: ${decoded.code}`);
					supervisorFrames.push(decoded.value.schema as string);
				}
			}
			expect(supervisorFrames).toEqual([
				"role-spawn-config/v1",
				"role-measure-start/v1",
				"role-stop/v1",
				"role-partial-accepted/v1",
				"role-exit/v1",
			]);
		} finally {
			channel.close();
			closeSync(childToParent.pipe.childFd);
			closeSync(parentToChild.pipe.childFd);
		}
	});

	test("the composed binding hands each child its spawn config, because driveCohortArm never does", async () => {
		// `driveCohortArm` goes spawnRoleChildren -> beginRamp ->
		// `rig.registerRolePeers`, and `composeCohortRigBinding` routes that last
		// step at the driver. `deliverSpawnConfigs` has no other caller anywhere
		// in the non-test tree, so the production composition reached the ramp
		// with no child holding a `role-spawn-config/v1` and refused its own
		// cohort on `COHORT_NOT_READY`. Every driver test in this file called
		// `deliverSpawnConfigs` itself, which is exactly how a suite that states
		// its own inputs hides the step production never takes.
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		const rig = new Proxy({} as CohortRigBinding, {
			get: () => () => ({ ok: true, value: true }),
		});
		const composed = composeCohortRigBinding({ rig, roleChildren: driver });
		const ramped = await composed.registerRolePeers({
			scheduler: null as never,
		});
		// The child has its config. The ramp still fails -- there is no scheduler
		// and no child answering a permit request -- but it fails at the ramp.
		expect(child.received.map((frame) => frame.schema)).toEqual([
			"role-spawn-config/v1",
		]);
		expect(ramped.ok).toBe(false);
		if (ramped.ok) throw new Error("unreachable");
		expect(ramped.message ?? "").not.toContain("spawn config yet");
	}, 10_000);

	test("the composed binding routes each step to the courier that can see it", async () => {
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const { driver } = driverFor(child);
		const calls: string[] = [];
		const rig = new Proxy({} as CohortRigBinding, {
			get: (_target, property: string) => () => {
				calls.push(property);
				return { ok: true, value: true };
			},
		});
		const composed = composeCohortRigBinding({ rig, roleChildren: driver });
		await composed.startServer();
		await composed.observe({ nowMs: 0 });
		// The two Mac-owned steps never reach the rig courier.
		const warmup = await composed.runWarmupWire();
		expect(warmup.ok).toBe(false);
		expect(calls).toEqual(["startServer", "observe"]);
	}, 10_000);

	test("a replacement cohort, under its fresh grant, is handed its spawn configs again", async () => {
		// Plan 2210: a pre-readiness replacement mints a fresh grant and spawns a
		// whole new cohort. The driver's "once" is once per grant, and the
		// composed binding delivers on the driver's word, not on a flag of its
		// own -- otherwise the replacement children would ramp with no config.
		const child = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		let grant: Sha256Hex = GRANT;
		const children = new Map([[publisherPlan.childId, child]]);
		const driver = new MacRoleChildCohortDriver({
			host: scriptedHost(children) as unknown as MacFanoutRoleChildHost,
			children: [publisherPlan],
			executionSha256: EXECUTION,
			joins: {
				cohortGrantSha256: () => grant,
				cohortStartBarrierSha256: () => BARRIER,
				measureStopAtMacNs: () => MEASURE_STOP_NS,
			},
			stamps: recordingStamps(),
			frames: {
				spawnConfigFor: () => ({
					ok: true,
					value: { schema: "role-spawn-config/v1" as const },
				}),
				warmupStartFor: () => ({
					ok: true,
					value: { schema: "role-warmup-start/v1" as const },
				}),
				measureStart: () => ({
					ok: true,
					value: { schema: "role-measure-start/v1" as const },
				}),
			},
			clock: { nowMs: () => Date.now(), nowNs: () => "1000000000" },
			readinessDeadlineMs: 1_000,
			warmupDeadlineMs: 1_000,
			measuredDeadlineMs: 1_000,
			teardownDeadlineMs: 1_000,
		});
		expect(driver.spawnConfigsDelivered).toBe(false);
		expect((await driver.deliverSpawnConfigs()).ok).toBe(true);
		expect(driver.spawnConfigsDelivered).toBe(true);
		expect((await driver.deliverSpawnConfigs()).ok).toBe(false);

		grant = HEX("7");
		expect(driver.spawnConfigsDelivered).toBe(false);
		const rig = new Proxy({} as CohortRigBinding, {
			get: () => () => ({ ok: true, value: true }),
		});
		const composed = composeCohortRigBinding({ rig, roleChildren: driver });
		const ramped = await composed.registerRolePeers({
			scheduler: null as never,
		});
		expect(ramped.ok).toBe(false);
		if (ramped.ok) throw new Error("unreachable");
		expect(ramped.message ?? "").not.toContain("spawn config yet");
		expect(child.received.map((frame) => frame.schema)).toEqual([
			"role-spawn-config/v1",
			"role-spawn-config/v1",
		]);
	}, 10_000);

	test("the warmup wire starts every child before it reads any completion, one child at a time", async () => {
		// R-P: a blocking read per child in `Promise.all` parked the later start
		// frames behind the earlier reads on Bun's bounded pool (role.md §3),
		// and a publisher started late sends its first paced offsets back to
		// back. The wire now sends every start first and reads the completions
		// in the frozen order. With the first child silent, the second child
		// has its start and its completion sits unread in its pipe: the driver
		// never took a read on it while it waited on the first.
		const workerPlan: MacFanoutChildPlanV1 = {
			childId: "subscriber-worker-0",
			role: "subscriber-worker",
			publisherId: null,
			workerIndex: 0,
			assignedGlobalOrdinals: [0],
			assignedRoleIds: ["subscriber-000000"],
			controlReadFd: 3,
			controlWriteFd: 4,
			tokenBundleFd: 5,
		};
		const publisher = scriptedChild({
			childId: publisherPlan.childId,
			assignedSessionCount: 1,
		});
		const worker = scriptedChild({
			childId: workerPlan.childId,
			assignedSessionCount: 1,
		});
		const children = new Map([
			[publisherPlan.childId, publisher],
			[workerPlan.childId, worker],
		]);
		const driver = new MacRoleChildCohortDriver({
			host: scriptedHost(children) as unknown as MacFanoutRoleChildHost,
			children: [publisherPlan, workerPlan],
			executionSha256: EXECUTION,
			joins: {
				cohortGrantSha256: () => GRANT,
				cohortStartBarrierSha256: () => BARRIER,
				measureStopAtMacNs: () => MEASURE_STOP_NS,
			},
			stamps: recordingStamps(),
			frames: {
				spawnConfigFor: () => ({
					ok: true,
					value: { schema: "role-spawn-config/v1" as const },
				}),
				warmupStartFor: () => ({
					ok: true,
					value: { schema: "role-warmup-start/v1" as const },
				}),
				measureStart: () => ({
					ok: true,
					value: { schema: "role-measure-start/v1" as const },
				}),
			},
			clock: { nowMs: () => Date.now(), nowNs: () => "1000000000" },
			readinessDeadlineMs: 1_000,
			warmupDeadlineMs: 300,
			measuredDeadlineMs: 1_000,
			teardownDeadlineMs: 1_000,
		});
		// The worker answers at once; the publisher never does.
		worker.reply(
			warmupComplete({
				childId: workerPlan.childId,
				role: "subscriber",
				offeredWarmupIngress: 0,
				deliveredWarmupRecords: 10,
			}),
		);
		const wire = await driver.runWarmupWire();
		expect(wire.ok).toBe(false);
		if (wire.ok) throw new Error("unreachable");
		expect(wire.code).toBe("WARMUP_DEADLINE_EXCEEDED");
		expect(wire.message).toContain(publisherPlan.childId);
		// Both starts went out before the first read.
		expect(publisher.received.map((frame) => frame.schema)).toEqual([
			"role-warmup-start/v1",
		]);
		expect(worker.received.map((frame) => frame.schema)).toEqual([
			"role-warmup-start/v1",
		]);
		// The worker's completion was never read: no read was pending on it.
		expect(worker.channel.receivedCount).toBe(0);
		expect(publisher.channel.receivedCount).toBe(0);
	}, 10_000);
});

// ---------------------------------------------------------------------------
// Plan 2210: exactly one pre-readiness cohort replacement
// ---------------------------------------------------------------------------

/**
 * A rig that accepts every grant the supervisor mints (a genuine rig-signed
 * acceptance naming that grant's digest), starts a server on each, and
 * answers the ramp from a script. What the executor asked, in order, is the
 * record under test.
 */
function replacementRig(
	harness: MiniHarness,
	rampOutcomes: readonly ProtocolResultLike[],
	overrides: Partial<CohortRigBinding> = {},
): {
	readonly rig: CohortRigBinding;
	readonly calls: string[];
	readonly grants: { attempt: number; sha256: Sha256Hex; root: Sha256Hex }[];
} {
	const calls: string[] = [];
	const grants: { attempt: number; sha256: Sha256Hex; root: Sha256Hex }[] = [];
	const ramps = [...rampOutcomes];
	let receiptSequence = 0;
	const rig = refusingBinding({
		acceptCohortGrant: (args) => {
			calls.push(`acceptCohortGrant#${args.grant.cohortAttempt}`);
			grants.push({
				attempt: args.grant.cohortAttempt,
				sha256: sha256HexOfBytes(args.grantBytes),
				root: args.grant.roleTokenCommitmentRootSha256,
			});
			receiptSequence += 1;
			const acceptance = {
				schema: "rig-cohort-acceptance/v1",
				executionSha256: args.grant.executionSha256,
				cohortGrantSha256: sha256HexOfBytes(args.grantBytes),
				cohortGrantSignatureSha256: sha256HexOfBytes(args.grantSignatureBytes),
				roleTokenCommitmentRootSha256: args.grant.roleTokenCommitmentRootSha256,
				approvedPlanSha256: args.grant.approvedPlanSha256,
				approvalRecordSha256: args.grant.approvalRecordSha256,
				rigExecutionIndex: 0,
				rigSupervisorInstanceNonce: HEX("d"),
				signingPublicKeySha256: sha256HexOfBytes(harness.rigKeys.publicRaw32),
				receiptSequence,
				acceptedAtMs: 1_000,
				issuedAtMs: 1_000,
				notAfterMs: 17_000_000_000_000,
			};
			const acceptanceBytes = bytesOfCanonical(acceptance);
			const signature = signRigReceipt({
				privatePkcs8Der: harness.rigKeys.privatePkcs8Der,
				publicRaw32: harness.rigKeys.publicRaw32,
				signedSchema: "rig-cohort-acceptance/v1",
				signedBytes: acceptanceBytes,
			});
			return {
				ok: true,
				value: {
					acceptance,
					acceptanceBytes,
					signature,
					signatureBytes: bytesOfCanonical(signature),
				},
			} as never;
		},
		startServer: () => {
			calls.push("startServer");
			return {
				ok: true,
				value: {
					childPid: 4242,
					childPgid: 4242,
					childInstanceNonce: HEX("9"),
					serverReadyFrameSha256: HEX("8"),
				},
			} as never;
		},
		teardownServer: () => {
			calls.push("teardownServer");
			return {
				ok: true,
				value: { exitCode: 0, signal: null, reaped: true },
			} as never;
		},
		registerRolePeers: () => {
			calls.push("registerRolePeers");
			const next = ramps.shift();
			if (next === undefined) throw new Error("the ramp script ran out");
			return next as never;
		},
		acceptWarmupEpoch: () => {
			calls.push("acceptWarmupEpoch");
			return {
				ok: false,
				code: "COHORT_PROTOCOL",
				message: "stop once readiness was reached",
			} as never;
		},
		...overrides,
	});
	return { rig, calls, grants };
}

type ProtocolResultLike =
	| { readonly ok: true; readonly value: true }
	| { readonly ok: false; readonly code: string; readonly message: string };

function replacementInput(harness: MiniHarness, rig: CohortRigBinding) {
	return {
		...driveInput(harness, rig),
		bundleFor: (plan: MacFanoutChildPlanV1): TokenBundleV1 => {
			const material = harness.fixtures.get(harness.supervisor.cohortAttempt);
			const grantSha256 = harness.supervisor.cohortGrantSha256;
			if (material === undefined || grantSha256 === null) {
				throw new Error("no minted material for this attempt");
			}
			const bundle = macTokenBundleForPlan({
				plan,
				executionSha256: harness.executionSha256,
				cohortGrantSha256: grantSha256,
				material,
			});
			if (!bundle.ok) throw new Error(`bundle: ${bundle.code}`);
			return bundle.value;
		},
	};
}

const CHILD_LOSS: ProtocolResultLike = {
	ok: false,
	code: "UNEXPECTED_EOF",
	message:
		"subscriber-worker-3: control pipe ended before connect-permit-complete/v1",
};

describe("plan 2210: one pre-readiness cohort replacement, the second loss is terminal", () => {
	test("a_child_lost_before_readiness_replaces_the_whole_cohort_once_and_readiness_is_re_run", async () => {
		const harness = await miniHarness();
		const { rig, calls, grants } = replacementRig(harness, [
			CHILD_LOSS,
			{ ok: true, value: true },
		]);
		const input = replacementInput(harness, rig);
		const result = await driveCohortArm(input);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		// The lifecycle went past readiness: the scripted stop is the epoch step.
		expect(result.message).toContain("stop once readiness was reached");
		// Plan 2210's order: the abandoned cohort's server child is killed, the
		// replacement grant goes to the rig, a fresh server child is spawned, and
		// readiness is re-run -- exactly once.
		expect(calls).toEqual([
			"acceptCohortGrant#1",
			"startServer",
			"registerRolePeers",
			"teardownServer",
			"acceptCohortGrant#2",
			"startServer",
			"registerRolePeers",
			"acceptWarmupEpoch",
		]);
		// Fresh nonce, grant and token root: the rig saw two different grants.
		expect(grants.map((grant) => grant.attempt)).toEqual([1, 2]);
		expect(grants[0]!.sha256).not.toBe(grants[1]!.sha256);
		expect(grants[0]!.root).not.toBe(grants[1]!.root);
		expect(harness.supervisor.cohortAttempt).toBe(2);
		expect(harness.supervisor.replacementCount).toBe(1);
		expect(harness.supervisor.cohortGrantSha256).toBe(grants[1]!.sha256);
		// The retention holds the replacement grant, as the exact bytes the rig
		// was handed.
		expect(input.retention.grant?.sha256).toBe(grants[1]!.sha256);
		expect(sha256HexOfBytes(input.retention.grant!.bytes)).toBe(
			grants[1]!.sha256,
		);
		// Every child was spawned twice: a whole new cohort, not a patched child.
		expect(harness.spawns.length).toBe(
			2 * harness.supervisor.topology.expectedProcessCount,
		);
		expect(harness.supervisor.allChildrenReady).toBe(true);
	});

	test("a_second_pre_readiness_loss_is_terminal_with_the_supervisors_own_refusal", async () => {
		const harness = await miniHarness();
		const { rig, calls } = replacementRig(harness, [CHILD_LOSS, CHILD_LOSS]);
		const result = await driveCohortArm(replacementInput(harness, rig));
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("CHILD_LIFECYCLE");
		expect(result.message).toContain(
			"a second pre-readiness replacement is terminal",
		);
		// The reason names the loss that ended the arm.
		expect(result.message).toContain("UNEXPECTED_EOF");
		expect(calls).toEqual([
			"acceptCohortGrant#1",
			"startServer",
			"registerRolePeers",
			"teardownServer",
			"acceptCohortGrant#2",
			"startServer",
			"registerRolePeers",
		]);
		expect(harness.supervisor.cohortAttempt).toBe(2);
		expect(harness.supervisor.replacementCount).toBe(1);
	});

	test("every_child_loss_shape_of_the_ramp_is_replaced_and_nothing_else_is", async () => {
		const replaced = [
			{ code: "UNEXPECTED_EOF", message: "control pipe ended" },
			{ code: "CHILD_LIFECYCLE", message: "write failed: EPIPE" },
			{
				code: "COHORT_NOT_READY",
				message: "subscriber-worker-7 failed to connect ordinal 647",
			},
		];
		for (const loss of replaced) {
			const harness = await miniHarness();
			const { rig, calls } = replacementRig(harness, [
				{ ok: false, ...loss },
				{ ok: true, value: true },
			]);
			await driveCohortArm(replacementInput(harness, rig));
			expect(calls.filter((call) => call === "registerRolePeers").length).toBe(
				2,
			);
			expect(harness.supervisor.replacementCount).toBe(1);
		}
		// A deadline, a protocol fault or a cross-supervisor mismatch is not a
		// child loss: the arm ends on it, cohort attempt 1, no second grant.
		const terminal = [
			{ code: "READY_DEADLINE_EXCEEDED", message: "ordinal 9 never due" },
			{ code: "COHORT_PROTOCOL", message: "a permit request for x arrived" },
			{ code: "CROSS_SUPERVISOR_MISMATCH", message: "another cohort" },
		];
		for (const refusal of terminal) {
			const harness = await miniHarness();
			const { rig, calls } = replacementRig(harness, [
				{ ok: false, ...refusal },
			]);
			const result = await driveCohortArm(replacementInput(harness, rig));
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("unreachable");
			expect(result.code).toBe(refusal.code);
			expect(calls).toEqual([
				"acceptCohortGrant#1",
				"startServer",
				"registerRolePeers",
			]);
			expect(harness.supervisor.cohortAttempt).toBe(1);
			expect(harness.supervisor.replacementCount).toBe(0);
		}
	});

	test("a_child_lost_after_readiness_is_never_replaced", async () => {
		const harness = await miniHarness();
		const { rig, calls } = replacementRig(
			harness,
			[{ ok: true, value: true }],
			{
				acceptWarmupEpoch: () => {
					calls.push("acceptWarmupEpoch");
					return { ok: true, value: true } as never;
				},
				runWarmupWire: () => {
					calls.push("runWarmupWire");
					return CHILD_LOSS as never;
				},
			},
		);
		const result = await driveCohortArm(replacementInput(harness, rig));
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.code).toBe("UNEXPECTED_EOF");
		expect(calls).toEqual([
			"acceptCohortGrant#1",
			"startServer",
			"registerRolePeers",
			"acceptWarmupEpoch",
			"runWarmupWire",
		]);
		expect(harness.supervisor.cohortAttempt).toBe(1);
		expect(harness.supervisor.replacementCount).toBe(0);
	});

	test("a_rig_that_cannot_stop_the_abandoned_server_child_ends_the_arm_on_that_refusal", async () => {
		const harness = await miniHarness();
		const { rig, calls } = replacementRig(
			harness,
			[CHILD_LOSS, { ok: true, value: true }],
			{
				teardownServer: () => {
					calls.push("teardownServer");
					return {
						ok: false,
						code: "COHORT_NOT_READY",
						message: "rig refused rig-teardown-server-request/v1",
					} as never;
				},
			},
		);
		const result = await driveCohortArm(replacementInput(harness, rig));
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.message).toContain("rig refused rig-teardown-server-request");
		// The role cohort was already replaced (the kill precedes the rig ask),
		// and no grant reached the rig after its refusal.
		expect(harness.supervisor.cohortAttempt).toBe(2);
		expect(calls).toEqual([
			"acceptCohortGrant#1",
			"startServer",
			"registerRolePeers",
			"teardownServer",
		]);
	});
});
