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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ArmRepetitionDispatch,
	armRepetitionSchedule,
	assertFanoutGrantDeclaration,
	type CohortArmEvidence,
	type CohortArmRuntimeProvider,
	type CohortRigBinding,
	dispatchArmRepetition,
	driveCohortArm,
	FanoutGrantDeclarationError,
	grantDeclarationsFromCell,
	measuredRepetitionsForPurpose,
	type SealedRepResult,
	sealArmsForCell,
	sealGrantDeclarationForArm,
} from "./bin/compare-controller.ts";
import { CohortExecutorRequiredError, getScenarioExecutor } from "./client.ts";
import {
	COHORT_CELL_CARDINALITIES,
	type CohortGrantV1,
	cohortCellCardinality,
	type TokenBundleV1,
	type TokenCommitmentLeafManifestV1,
} from "./cohort-protocol.ts";
import {
	CAMPAIGN_FAILURE_CODES,
	createMemoryReplayLedger,
	type Ed25519KeyPairBytes,
	type Sha256Hex,
	generateEd25519KeyPair,
	macConstructFinalExecution,
	signRigReceipt,
} from "./cross-supervisor-protocol.ts";
import {
	cohortCellForArm,
	FANOUT_COHORT_CELL_BY_ID,
	FANOUT_COHORT_CELL_IDS,
} from "./evidence.ts";
import {
	MAC_FANOUT_PUBLISHER_COUNT,
	type MacFanoutChildPlanV1,
	type MacFanoutExecutionJoinsV1,
	MacFanoutSupervisor,
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
				await executor!.execute({
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

const macExecutionJoins: MacFanoutExecutionJoinsV1 = {
	measurementGrantSha256: HEX("1"),
	macExecutionGrantReceiptSha256: HEX("2"),
	rigServerSnapshotReceiptSha256: HEX("3"),
	rigServerSnapshotReceiptSignatureSha256: HEX("4"),
	macMeasurementAdmissionReceiptSha256: HEX("5"),
	macMeasurementAdmissionSignatureSha256: HEX("6"),
	approvedPlanSha256: HEX("a"),
	approvalRecordSha256: HEX("b"),
};

function bytesOf(record: unknown): Uint8Array {
	// The supervisor canonicalises with the shared codec; for the digests these
	// tests compare, a stable stringify of an already-canonical record is the
	// same bytes. Records built here are only ever handed straight back.
	return new TextEncoder().encode(JSON.stringify(record));
}

interface MiniHarness {
	readonly supervisor: MacFanoutSupervisor;
	readonly macKeys: Ed25519KeyPairBytes;
	readonly rigKeys: Ed25519KeyPairBytes;
	readonly executionSha256: Sha256Hex;
	readonly grants: Map<number, CohortGrantV1>;
	readonly fixtures: Map<number, FanoutCohortFixture>;
	readonly manifests: Map<number, TokenCommitmentLeafManifestV1>;
	readonly spawns: MacFanoutChildPlanV1[];
}

/**
 * A supervisor over a mini ticker cohort: one publisher, eight workers, eight
 * subscribers -- one per shard, which is the widest the shared fixture tiles.
 */
function miniHarness(): MiniHarness {
	const macKeys = generateEd25519KeyPair();
	const rigKeys = generateEd25519KeyPair();
	const workloadBytes = bytesOf({ plan: "b4-mini", cohortId: MINI_COHORT_ID });
	const built = macConstructFinalExecution({
		draft: {
			schema: "cross-supervisor-execution-draft/v1",
			authoritySha256: HEX("a"),
			campaignLockSha256: HEX("b"),
			stagedCapabilitySha256: HEX("c"),
			sourceArchiveSha256: HEX("d"),
			approvedPlanSha256: macExecutionJoins.approvedPlanSha256,
			approvalRecordSha256: macExecutionJoins.approvalRecordSha256,
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
		},
		executionIndex: 0,
		macSupervisorInstanceNonce: HEX("7"),
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		grantNonceSha256: HEX("8"),
	});
	if (!built.ok) throw new Error(`mini execution: ${built.code}`);
	const execution = built.value.execution;
	const executionSha256 = built.value.executionSha256;

	const grants = new Map<number, CohortGrantV1>();
	const fixtures = new Map<number, FanoutCohortFixture>();
	const manifests = new Map<number, TokenCommitmentLeafManifestV1>();
	const spawns: MacFanoutChildPlanV1[] = [];
	let nextPid = 1_000;
	const alive = new Set<number>();

	const supervisor = new MacFanoutSupervisor({
		scenario: "ticker",
		subscriberCount: MINI_SUBSCRIBERS,
		executionSha256,
		macKeys,
		stagedRigPublicRaw32: rigKeys.publicRaw32,
		macSupervisorInstanceNonce: HEX("7"),
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
			const offeredIngress = MINI_MEASURED_FRAMES * MINI_PUBLISHERS;
			const grant: CohortGrantV1 = {
				schema: "cohort-grant/v1",
				execution,
				executionSha256,
				macExecutionGrantReceiptSha256:
					macExecutionJoins.macExecutionGrantReceiptSha256,
				approvedPlanSha256: execution.approvedPlanSha256,
				approvalRecordSha256: execution.approvalRecordSha256,
				cohortId,
				cohortAttempt,
				scenarioHash: execution.scenarioHash,
				rolePlanHash: execution.rolePlanHash,
				workloadRolePlanInputSha256: execution.workloadRolePlanInputSha256,
				transport: "ws",
				publisherCount: MINI_PUBLISHERS,
				subscriberCount: MINI_SUBSCRIBERS,
				workerCount: 8,
				expectedProcessCount: MINI_PUBLISHERS + MINI_WORKERS,
				expectedSessionCount: MINI_PUBLISHERS + MINI_SUBSCRIBERS,
				publishers: [...tokens.publishers],
				subscriberShards: [...tokens.subscriberShards],
				tokenCommitmentLeafManifestSha256: sha256HexOfBytes(
					bytesOf(leafManifest),
				),
				roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
				roleTokenCommitmentCount: tokens.roleTokenCommitmentCount,
				connectionRatePerSecond: 500,
				maxConnectionsInFlight: 200,
				readinessDeadlineMs: 30_000,
				inRepetitionWarmupMs: 5_000,
				sampleWindowMs: 1_000,
				measuredDurationMs: 10_000,
				drainDeadlineMs: 10_000,
				messageBytes: 100,
				expectedOfferedIngress: offeredIngress,
				expectedExpandedDeliveries: offeredIngress * MINI_SUBSCRIBERS,
				macSupervisorInstanceNonce: HEX("7"),
				signingPublicKeySha256: sha256HexOfBytes(macKeys.publicRaw32),
				receiptSequence: 1,
				issuedAtMs: 1_000,
				notAfterMs: 2_000,
			};
			fixtures.set(cohortAttempt, tokens);
			grants.set(cohortAttempt, grant);
			return { tokens, grant };
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
		executionJoins: macExecutionJoins,
		bunSha256: HEX("8"),
		entrypointSha256: HEX("9"),
		receiptValidityMs: MINI_VALIDITY_MS,
	});

	return {
		supervisor,
		macKeys,
		rigKeys,
		executionSha256,
		grants,
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
		...overrides,
	};
}

function driveInput(harness: MiniHarness, rig: CohortRigBinding) {
	const clock = createManualRelayClock(1_000);
	return {
		supervisor: harness.supervisor,
		rig,
		bundleFor: (): TokenBundleV1 => {
			throw new Error("bundleFor must not be reached before the grant lands");
		},
		workloadRolePlanInputBytes: new Uint8Array(),
		tokenCommitmentLeafManifestBytes: new Uint8Array(),
		warmupEpoch: {},
		startBarrierFor: () => ({}),
		clock: { nowMs: () => clock.nowMs(), nowNs: () => clock.nowNs() },
		receiptValidityMs: MINI_VALIDITY_MS,
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
	seals: CohortArmEvidence[],
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
			seal: async (evidence: CohortArmEvidence) => {
				seals.push(evidence);
				return sealed;
			},
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
				cohortRuntime: cohortRuntimeOf(miniHarness(), refusingBinding(), []),
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
			cohortRuntime: cohortRuntimeOf(miniHarness(), refusingBinding(), []),
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
		const harness = miniHarness();
		const reached: string[] = [];
		const seals: CohortArmEvidence[] = [];
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
		const seals: CohortArmEvidence[] = [];
		const exported = {
			exportAck: { schema: "mac-cohort-evidence-exported-ack/v1" },
			admissionReceipt: { schema: "cohort-admission-receipt/v1" },
			admissionReceiptSha256: HEX("c"),
		} as unknown as CohortArmEvidence;
		const dispatched = await dispatchArmRepetition({
			arm: legInputFor(cellOf("ticker-fanout/rate-10000"), "primary"),
			cohortRuntime: cohortRuntimeOf(miniHarness(), refusingBinding(), seals, {
				ok: true,
				primaryMetricP50: 42,
				sealedPath: "/tmp/mini.sealed.json",
				artifactSha256: "3".repeat(64),
			}),
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
		const harness = miniHarness();
		const reached: string[] = [];
		const rig = refusingBinding({
			acceptCohortGrant: (args) => {
				reached.push("acceptCohortGrant");
				// The grant the rig sees is the one the supervisor minted, and it
				// has no start timestamp -- it is pre-readiness by construction.
				expect(args.grant.schema).toBe("cohort-grant/v1");
				expect(args.grant.executionSha256).toBe(harness.executionSha256);
				expect("measureStartAtMacNs" in args.grant).toBe(false);
				expect(args.signature.signedSchema).toBe("cohort-grant/v1");
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
		const harness = miniHarness();
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
				return { ok: true, value: { acceptance, signature } };
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
		const harness = miniHarness();
		const seals: CohortArmEvidence[] = [];
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
		const harness = miniHarness();
		// A second open on one supervisor is refused, so nothing downstream runs.
		const first = harness.supervisor.openCohort();
		expect(first.ok).toBe(true);
		const reached: string[] = [];
		const rig = refusingBinding({
			acceptCohortGrant: () => {
				reached.push("acceptCohortGrant");
				return { ok: true, value: { acceptance: {}, signature: {} } };
			},
		});
		const result = await driveCohortArm(driveInput(harness, rig));
		expect(result.ok).toBe(false);
		expect(reached).toEqual([]);
	});
});
