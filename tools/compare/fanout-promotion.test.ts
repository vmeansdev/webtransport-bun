import {
	cohortExportAckSigningBytes,
	ed25519Sign,
	type MacCohortEvidenceExportedAckV1,
} from "./cross-supervisor-protocol.ts";
/**
 * B4 promotion and recursive-verifier tests.
 *
 * Two halves, one question each:
 *
 * 1. `output-policy.ts` -- may this cell promote? The section 6 gate is a *set*
 *    rule (five distinct canonical measured PASS reps on each transport with
 *    closed receipt graphs) and the display median is chosen only after it.
 * 2. `verify-artifact.ts` -- can one measured cohort arm be reconstructed from
 *    the sealed artifact alone? Section 12 criterion 6: recompute the token
 *    leaf root without raw tokens, replay the section 4.5 equations from the
 *    retained partial bytes, and close both issuer signature graphs against the
 *    trust context's staged keys.
 *
 * Every fixture below is honest by construction: each digest is recomputed from
 * the bytes it covers, and each forgery is produced by mutating exactly one
 * record on a copy of that honest export.
 */
import { describe, expect, test } from "bun:test";
import {
	COHORT_MAX_PUBLISHERS,
	COHORT_WORKER_COUNT,
	type CohortCapacityV1,
	type CohortGrantV1,
	type CohortLedgerV1,
	type CohortRateSeriesV1,
	type LinuxRelayObservationV1,
	type ObservedProcessProofV1,
	type PublisherPartialV1,
	type PublisherRoleGrantV1,
	type RetainedCanonicalBytesV1,
	type SubscriberShardV1,
	type TokenCommitmentLeafV1,
	type WorkerPartialV1,
	computeTokenCommitmentRoot,
	observedChildrenDigestSha256,
	orderTokenCommitmentLeaves,
	orderedPartialDigestSetSha256,
	READINESS_DEADLINE_MS_TICKER,
	recomputeCohortLedger,
	recomputeCohortOriginConservation,
	recomputeCohortRateSeries,
	SUBSCRIBER_SHARD_MODULUS,
	tokenCommitmentLeafSha256,
	WARMUP_MESSAGES_PER_PUBLISHER,
} from "./cohort-protocol.ts";
import {
	bytesOfCanonical,
	type CrossSupervisorExecutionDraftV1,
	type CrossSupervisorExecutionV1,
	generateEd25519KeyPair,
	macConstructFinalExecution,
	signMacReceipt,
	signRigReceipt,
	toBase64,
} from "./cross-supervisor-protocol.ts";
import { sha256Canonical } from "./canonical.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";
import {
	CANONICAL_FANOUT_MEASURED_SEAL_COUNT,
	evaluateCanonicalFanoutCompletion,
	evaluateCellPromotionGate,
	expectedPromotionFlatCount,
	FLATS_PER_PROMOTED_CELL,
	type PromotionGateEntry,
} from "./output-policy.ts";
import { reconstructCohortEvidenceOffline } from "./verify-artifact.ts";

// ---------------------------------------------------------------------------
// Promotion gate fixtures
// ---------------------------------------------------------------------------

const CAMPAIGN = "fanout-canonical-r1";
const FANOUT_CELLS = [
	"ticker-fanout/rate-10000",
	"ticker-fanout/rate-50000",
	"ticker-fanout/rate-100000",
	"chat-fanout/subscribers-1000",
	"chat-fanout/subscribers-5000",
	"chat-fanout/subscribers-10000",
] as const;
const CELL = FANOUT_CELLS[0];

function entry(
	transport: "ws" | "wt",
	repetitionIndex: number,
	overrides: Partial<PromotionGateEntry> = {},
): PromotionGateEntry {
	return {
		campaignId: CAMPAIGN,
		cellId: CELL,
		transport,
		armKind: "primary",
		executionPurpose: "canonical",
		repetitionKind: "measured",
		repetitionIndex,
		repetitionTotal: 5,
		status: "PASS",
		promotable: true,
		sealedPath: `/seal/${transport}-${repetitionIndex}.json`,
		artifactSha256: sha256Canonical({ transport, repetitionIndex }),
		receiptGraphComplete: true,
		// Deliberately not monotonic in the index: the median must be chosen by
		// metric, not by arrival order.
		primaryMetricP50: 10 + ((repetitionIndex * 3) % 5),
		...overrides,
	};
}

function completeSet(
	mutate: (entries: PromotionGateEntry[]) => void = () => undefined,
): PromotionGateEntry[] {
	const entries: PromotionGateEntry[] = [];
	for (const transport of ["ws", "wt"] as const) {
		for (let index = 1; index <= 5; index += 1) {
			entries.push(entry(transport, index));
		}
	}
	mutate(entries);
	return entries;
}

function gate(entries: readonly PromotionGateEntry[], overrides = {}) {
	return evaluateCellPromotionGate({
		cellId: CELL,
		campaignId: CAMPAIGN,
		executionPurpose: "canonical",
		entries,
		...overrides,
	});
}

function codes(result: { readonly refusals: readonly { code: string }[] }) {
	return [...new Set(result.refusals.map((refusal) => refusal.code))].sort();
}

describe("B4 section 6: the promotion set gate", () => {
	test("five distinct canonical measured PASS reps on both transports promote", () => {
		const result = gate(completeSet());
		expect(result.promotable).toBe(true);
		expect(result.refusals).toEqual([]);
		expect(result.flatCount).toBe(FLATS_PER_PROMOTED_CELL);
	});

	test("the median is selected only after the set gate, and shares one rep", () => {
		const result = gate(completeSet());
		expect(result.median).toBeDefined();
		// p50 by index: 1->13, 2->11, 3->14, 4->12, 5->10; sorted 5,2,4,1,3.
		expect(result.median?.repetitionIndex).toBe(4);
		expect(result.median?.wsSealedPath).toBe("/seal/ws-4.json");
		expect(result.median?.wtSealedPath).toBe("/seal/wt-4.json");
	});

	test("an incomplete four-rep set is refused and exposes no median", () => {
		const entries = completeSet().filter(
			(candidate) =>
				!(candidate.transport === "wt" && candidate.repetitionIndex === 3),
		);
		const result = gate(entries);
		expect(result.promotable).toBe(false);
		expect(result.median).toBeUndefined();
		expect(codes(result)).toContain("PROMOTION_MEASURED_SET_INCOMPLETE");
	});

	test("a sixth measured rep refuses the whole cell", () => {
		const entries = completeSet();
		entries.push(entry("ws", 6));
		const result = gate(entries);
		expect(result.promotable).toBe(false);
		expect(codes(result)).toContain("PROMOTION_REPETITION_INDEX_INVALID");
	});

	test("a duplicate measured index refuses rather than deduplicating", () => {
		const entries = completeSet();
		entries.push(entry("wt", 2, { sealedPath: "/seal/wt-2-again.json" }));
		const result = gate(entries);
		expect(result.promotable).toBe(false);
		expect(codes(result)).toContain("PROMOTION_REPETITION_DUPLICATE");
	});

	test("a warmup execution offered as a measured rep is refused", () => {
		const entries = completeSet((all) => {
			all[0] = entry("ws", 1, { repetitionKind: "warmup" });
		});
		const result = gate(entries);
		expect(result.promotable).toBe(false);
		expect(codes(result)).toContain("PROMOTION_ENTRY_NOT_MEASURED");
	});

	test("a repetitionTotal other than five is refused", () => {
		const entries = completeSet((all) => {
			all[2] = entry("ws", 3, { repetitionTotal: 4 });
		});
		expect(codes(gate(entries))).toContain(
			"PROMOTION_REPETITION_TOTAL_INVALID",
		);
	});

	test("a focused entry carried into a canonical set is refused", () => {
		const entries = completeSet((all) => {
			all[1] = entry("ws", 2, { executionPurpose: "focused" });
		});
		expect(codes(gate(entries))).toContain("PROMOTION_MIXED_PURPOSE");
	});

	test("a pilot entry carried into a canonical set is refused", () => {
		const entries = completeSet((all) => {
			all[1] = entry("ws", 2, { executionPurpose: "pilot" });
		});
		expect(codes(gate(entries))).toContain("PROMOTION_MIXED_PURPOSE");
	});

	test("an entry minted by another campaign is refused", () => {
		const entries = completeSet((all) => {
			all[4] = entry("ws", 5, { campaignId: "fanout-canonical-r0" });
		});
		expect(codes(gate(entries))).toContain("PROMOTION_CROSS_CAMPAIGN");
	});

	test("an entry describing another cell is refused", () => {
		const entries = completeSet();
		entries.push(entry("ws", 1, { cellId: "chat-fanout/subscribers-1000" }));
		expect(codes(gate(entries))).toContain("PROMOTION_CELL_MISMATCH");
	});

	test("a stale echo flat from an earlier campaign refuses promotion", () => {
		const result = gate(completeSet(), {
			existingFlats: [
				{
					cellId: CELL,
					transport: "ws" as const,
					campaignId: "fanout-pilot-r1",
				},
			],
		});
		expect(result.promotable).toBe(false);
		expect(codes(result)).toContain("PROMOTION_STALE_ECHO");
	});

	test("a flat from this same campaign is not a stale echo", () => {
		const result = gate(completeSet(), {
			existingFlats: [
				{ cellId: CELL, transport: "ws" as const, campaignId: CAMPAIGN },
			],
		});
		expect(result.promotable).toBe(true);
	});

	test("a FAIL rep inside the five refuses the cell", () => {
		const entries = completeSet((all) => {
			all[3] = entry("ws", 4, { status: "FAIL" });
		});
		expect(codes(gate(entries))).toContain("PROMOTION_ENTRY_NOT_PASS");
	});

	test("a PASS rep that did not opt into promotion refuses the cell", () => {
		const entries = completeSet((all) => {
			all[3] = entry("ws", 4, { promotable: false });
		});
		expect(codes(gate(entries))).toContain("PROMOTION_ENTRY_NOT_PROMOTABLE");
	});

	test("a PASS rep without a sealed artifact refuses the cell", () => {
		const entries = completeSet((all) => {
			all[3] = entry("ws", 4, { sealedPath: null });
		});
		expect(codes(gate(entries))).toContain("PROMOTION_SEAL_MISSING");
	});

	test("a rep whose issuer receipt graph is unclosed refuses the cell", () => {
		const entries = completeSet((all) => {
			all[7] = entry("wt", 3, { receiptGraphComplete: false });
		});
		expect(codes(gate(entries))).toContain(
			"PROMOTION_RECEIPT_GRAPH_INCOMPLETE",
		);
	});

	test("a cell with no WT arm at all cannot promote as a pair", () => {
		const entries = completeSet().filter(
			(candidate) => candidate.transport === "ws",
		);
		expect(codes(gate(entries))).toContain("PROMOTION_ARM_PAIR_INCOMPLETE");
	});

	test("read-path and overlay arms never enter the primary promotion set", () => {
		const entries = completeSet();
		entries.push(entry("ws", 1, { armKind: "read-path" }));
		entries.push(entry("ws", 2, { armKind: "overlay" }));
		expect(gate(entries).promotable).toBe(true);
	});

	test("focused campaigns verify but write zero flats", () => {
		const result = gate(completeSet(), { executionPurpose: "focused" });
		expect(result.promotable).toBe(false);
		expect(result.flatCount).toBe(0);
		expect(codes(result)).toEqual(["PROMOTION_PURPOSE_NOT_CANONICAL"]);
	});

	test("pilot campaigns verify but write zero flats", () => {
		const result = gate(completeSet(), { executionPurpose: "pilot" });
		expect(result.promotable).toBe(false);
		expect(result.flatCount).toBe(0);
		expect(expectedPromotionFlatCount("pilot", 6)).toBe(0);
	});

	test("a one-rep focused shape is not a four-fifths canonical promotion", () => {
		const single = [
			entry("ws", 1, { repetitionTotal: 1, executionPurpose: "focused" }),
			entry("wt", 1, { repetitionTotal: 1, executionPurpose: "focused" }),
		];
		expect(gate(single, { executionPurpose: "focused" }).flatCount).toBe(0);
		// The same two entries relabelled canonical still fail the set rule.
		const relabelled = single.map((candidate) => ({
			...candidate,
			executionPurpose: "canonical" as const,
			repetitionTotal: 5,
		}));
		expect(codes(gate(relabelled))).toContain(
			"PROMOTION_MEASURED_SET_INCOMPLETE",
		);
	});

	test("six promoted cells produce twelve flats and sixty measured seals", () => {
		const entries: PromotionGateEntry[] = [];
		for (const cellId of FANOUT_CELLS) {
			for (const transport of ["ws", "wt"] as const) {
				for (let index = 1; index <= 5; index += 1) {
					entries.push(entry(transport, index, { cellId }));
				}
			}
		}
		const completion = evaluateCanonicalFanoutCompletion({
			campaignId: CAMPAIGN,
			executionPurpose: "canonical",
			cellIds: FANOUT_CELLS,
			entries,
		});
		expect(completion.complete).toBe(true);
		expect(completion.promotedCells).toEqual([...FANOUT_CELLS]);
		expect(completion.measuredPassSeals).toBe(
			CANONICAL_FANOUT_MEASURED_SEAL_COUNT,
		);
		expect(completion.measuredPassSeals).toBe(60);
		expect(completion.flatCount).toBe(12);
	});

	test("fifty-nine seals is not a complete six-cell fanout claim", () => {
		const entries: PromotionGateEntry[] = [];
		for (const cellId of FANOUT_CELLS) {
			for (const transport of ["ws", "wt"] as const) {
				for (let index = 1; index <= 5; index += 1) {
					if (cellId === FANOUT_CELLS[5] && transport === "wt" && index === 5)
						continue;
					entries.push(entry(transport, index, { cellId }));
				}
			}
		}
		const completion = evaluateCanonicalFanoutCompletion({
			campaignId: CAMPAIGN,
			executionPurpose: "canonical",
			cellIds: FANOUT_CELLS,
			entries,
		});
		expect(completion.complete).toBe(false);
		expect(completion.measuredPassSeals).toBe(59);
		expect(completion.promotedCells).toHaveLength(5);
		expect(completion.flatCount).toBe(10);
	});

	test("a focused campaign completes no fanout claim at all", () => {
		const completion = evaluateCanonicalFanoutCompletion({
			campaignId: CAMPAIGN,
			executionPurpose: "focused",
			cellIds: FANOUT_CELLS,
			entries: [],
		});
		expect(completion.complete).toBe(false);
		expect(completion.flatCount).toBe(0);
		expect(codes(completion)).toEqual(["PROMOTION_PURPOSE_NOT_CANONICAL"]);
	});
});

// ---------------------------------------------------------------------------
// Offline reconstruction fixtures: one honest ticker 10k cohort arm
// ---------------------------------------------------------------------------

const HEX = (character: string): string => character.repeat(64);
const WINDOWS = 10;
const MEASURED_MS = 10_000;
const MESSAGE_BYTES = 100 as const;
const PUBLISHERS = 1;
const SUBSCRIBERS = 100;
const SHARDS = [13, 13, 13, 13, 12, 12, 12, 12] as const;
/** ticker 10k: 100,000 offered ingress over ten windows. */
const INGRESS_PER_WINDOW = 10_000;
const PER_SUBSCRIBER_DELIVERED = INGRESS_PER_WINDOW * WINDOWS;
const COHORT_ID = "cohort-ticker-10k";
const START_NS = 4_000_000_000_000n;
const NS_PER_MS = 1_000_000n;

const macKeys = generateEd25519KeyPair();
const rigKeys = generateEd25519KeyPair();

function zeros(length: number): number[] {
	return Array.from({ length }, () => 0);
}

function filled(value: number): number[] {
	return Array.from({ length: WINDOWS }, () => value);
}

function retain(value: unknown): RetainedCanonicalBytesV1 {
	const bytes = bytesOfCanonical(value);
	return {
		schema: "retained-canonical-bytes/v1",
		encoding: "base64",
		mediaType: "application/json",
		bytesBase64: toBase64(bytes),
		byteLength: bytes.byteLength,
		sha256: sha256HexOfBytes(bytes),
	};
}

function publisherId(index: number): string {
	return `publisher-${index.toString().padStart(6, "0")}`;
}

function tickerDraft(): CrossSupervisorExecutionDraftV1 {
	return {
		schema: "cross-supervisor-execution-draft/v1",
		authoritySha256: HEX("a"),
		campaignLockSha256: HEX("b"),
		stagedCapabilitySha256: HEX("c"),
		sourceArchiveSha256: HEX("d"),
		approvedPlanSha256: HEX("e"),
		approvalRecordSha256: HEX("f"),
		candidate: "cand",
		campaignId: CAMPAIGN,
		runId: `${CAMPAIGN}/ticker-fanout-10k/ws/measured-1`,
		executionPurpose: "canonical",
		cellId: CELL,
		scenarioHash: HEX("1"),
		rolePlanHash: HEX("2"),
		workloadRolePlanInputSha256: HEX("3"),
		stagedServerLaunchRecordSha256: HEX("4"),
		armKind: "primary",
		transport: "ws",
		repetitionKind: "measured",
		repetitionIndex: 1,
		repetitionTotal: 5,
		grantDeclaration: "fanout-expanded-deliveries",
		// §4.1: the expansion, not the offered ingress. This fixture declared
		// 100,000 -- a hundredth of what ticker 10k owes.
		declaredMessageCount: INGRESS_PER_WINDOW * WINDOWS * SUBSCRIBERS,
		declaredMessageBytes: MESSAGE_BYTES,
		requestedNotAfterMs: 17_000_000_000_000,
	} as CrossSupervisorExecutionDraftV1;
}

function builtExecution(): {
	readonly execution: CrossSupervisorExecutionV1;
	readonly executionSha256: string;
} {
	const built = macConstructFinalExecution({
		draft: tickerDraft(),
		executionIndex: 0,
		macSupervisorInstanceNonce: HEX("5"),
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		grantNonceSha256: HEX("6"),
	});
	if (!built.ok) throw new Error(`execution: ${built.message ?? built.code}`);
	return {
		execution: built.value.execution,
		executionSha256: built.value.executionSha256,
	};
}

const EXECUTION = builtExecution();
const EXECUTION_SHA = EXECUTION.executionSha256;

function shardFirstIndex(worker: number): number {
	let total = PUBLISHERS;
	for (let index = 0; index < worker; index += 1) total += SHARDS[index]!;
	return total;
}

function publisherGrants(): PublisherRoleGrantV1[] {
	return Array.from({ length: PUBLISHERS }, (_unused, index) => ({
		schema: "publisher-role-grant/v1" as const,
		childId: publisherId(index),
		publisherId: publisherId(index),
		tokenCommitmentIndex: index,
		tokenSha256: sha256Canonical({ token: `publisher-${index}` }),
	}));
}

function subscriberShards(): SubscriberShardV1[] {
	return Array.from({ length: COHORT_WORKER_COUNT }, (_unused, worker) => ({
		schema: "subscriber-shard/v1" as const,
		childId: `worker-${worker}`,
		workerIndex: worker,
		modulus: SUBSCRIBER_SHARD_MODULUS,
		residue: worker,
		firstSubscriberIndex: 0 as const,
		lastSubscriberIndexExclusive: SUBSCRIBERS,
		subscriberCount: SHARDS[worker]!,
		orderedSubscriberIdsSha256: sha256Canonical({ worker }),
		firstTokenCommitmentIndex: shardFirstIndex(worker),
		lastTokenCommitmentIndexExclusive:
			shardFirstIndex(worker) + SHARDS[worker]!,
	})) as SubscriberShardV1[];
}

function cohortLeaves(): TokenCommitmentLeafV1[] {
	const leaves: TokenCommitmentLeafV1[] = [];
	for (let index = 0; index < PUBLISHERS; index += 1) {
		leaves.push({
			schema: "token-commitment-leaf/v1",
			childId: publisherId(index),
			cohortId: COHORT_ID,
			role: "publisher",
			roleId: publisherId(index),
			tokenSha256: sha256Canonical({ token: `publisher-${index}` }),
			workerIndex: null,
		});
	}
	let subscriber = 0;
	for (let worker = 0; worker < COHORT_WORKER_COUNT; worker += 1) {
		for (let slot = 0; slot < SHARDS[worker]!; slot += 1) {
			leaves.push({
				schema: "token-commitment-leaf/v1",
				childId: `worker-${worker}`,
				cohortId: COHORT_ID,
				role: "subscriber",
				roleId: `subscriber-${subscriber.toString().padStart(6, "0")}`,
				tokenSha256: sha256Canonical({ token: `subscriber-${subscriber}` }),
				workerIndex: worker,
			});
			subscriber += 1;
		}
	}
	return leaves;
}

const LEAVES = orderTokenCommitmentLeaves(cohortLeaves());
const LEAF_ROOT = (() => {
	const root = computeTokenCommitmentRoot(
		LEAVES.map((leaf) => tokenCommitmentLeafSha256(leaf)),
	);
	if (!root.ok) throw new Error("leaf root");
	return root.value;
})();
const LEAF_MANIFEST = {
	schema: "token-commitment-leaf-manifest/v1" as const,
	executionSha256: EXECUTION_SHA,
	cohortId: COHORT_ID,
	leafCount: LEAVES.length,
	leaves: LEAVES,
	roleTokenCommitmentRootSha256: LEAF_ROOT,
};

function cohortGrant(overrides: Partial<CohortGrantV1> = {}): CohortGrantV1 {
	return {
		schema: "cohort-grant/v1",
		execution: EXECUTION.execution,
		executionSha256: EXECUTION_SHA,
		macExecutionGrantReceiptSha256: HEX("7"),
		approvedPlanSha256: EXECUTION.execution.approvedPlanSha256,
		approvalRecordSha256: EXECUTION.execution.approvalRecordSha256,
		cohortId: COHORT_ID,
		cohortAttempt: 1,
		scenarioHash: EXECUTION.execution.scenarioHash,
		rolePlanHash: EXECUTION.execution.rolePlanHash,
		workloadRolePlanInputSha256:
			EXECUTION.execution.workloadRolePlanInputSha256,
		transport: "ws",
		publisherCount: PUBLISHERS,
		subscriberCount: SUBSCRIBERS,
		workerCount: 8,
		expectedProcessCount: PUBLISHERS + COHORT_WORKER_COUNT,
		expectedSessionCount: PUBLISHERS + SUBSCRIBERS,
		publishers: publisherGrants(),
		subscriberShards: subscriberShards(),
		tokenCommitmentLeafManifestSha256: sha256HexOfBytes(
			bytesOfCanonical(LEAF_MANIFEST),
		),
		roleTokenCommitmentRootSha256: LEAF_ROOT,
		roleTokenCommitmentCount: LEAF_MANIFEST.leafCount,
		connectionRatePerSecond: 500,
		maxConnectionsInFlight: 200,
		readinessDeadlineMs: READINESS_DEADLINE_MS_TICKER,
		inRepetitionWarmupMs: 5_000,
		sampleWindowMs: 1_000,
		measuredDurationMs: MEASURED_MS,
		drainDeadlineMs: 10_000,
		messageBytes: MESSAGE_BYTES,
		expectedOfferedIngress: INGRESS_PER_WINDOW * WINDOWS,
		expectedExpandedDeliveries: INGRESS_PER_WINDOW * WINDOWS * SUBSCRIBERS,
		macSupervisorInstanceNonce: HEX("5"),
		signingPublicKeySha256: sha256HexOfBytes(macKeys.publicRaw32),
		receiptSequence: 1,
		issuedAtMs: 1_000,
		notAfterMs: 2_000,
		...overrides,
	} as CohortGrantV1;
}

function publisherPartial(
	overrides: Partial<PublisherPartialV1> = {},
): PublisherPartialV1 {
	return {
		schema: "publisher-partial/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortStartBarrierSha256: BARRIER_RETAINED.sha256,
		childId: publisherId(0),
		childPid: 4_100,
		childPgid: 4_100,
		childInstanceNonce: HEX("1"),
		publisherId: publisherId(0),
		tokenSha256: sha256Canonical({ token: "publisher-0" }),
		macClockId: "mach-continuous-1",
		windowCount: WINDOWS,
		offeredByOriginWindow: filled(INGRESS_PER_WINDOW),
		offeredBytesByOriginWindow: filled(INGRESS_PER_WINDOW * MESSAGE_BYTES),
		acceptedAckSeenByOriginWindow: filled(INGRESS_PER_WINDOW),
		duplicateAckSeenByOriginWindow: zeros(WINDOWS),
		reorderedAckSeenByOriginWindow: zeros(WINDOWS),
		firstOfferAtMacNs: START_NS.toString(),
		lastAckAtMacNs: (START_NS + 1n).toString(),
		exitCode: 0,
		...overrides,
	} as PublisherPartialV1;
}

function workerPartial(
	workerIndex: number,
	overrides: Partial<WorkerPartialV1> = {},
): WorkerPartialV1 {
	const shard = SHARDS[workerIndex]!;
	const perWindow = INGRESS_PER_WINDOW * shard;
	return {
		schema: "worker-partial/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortStartBarrierSha256: BARRIER_RETAINED.sha256,
		childId: `worker-${workerIndex}`,
		childPid: 4_200 + workerIndex,
		childPgid: 4_200 + workerIndex,
		childInstanceNonce: HEX("3"),
		workerIndex,
		tokenBundleSha256: HEX("4"),
		orderedSubscriberIdsSha256: sha256Canonical({ worker: workerIndex }),
		subscriberCount: shard,
		macClockId: "mach-continuous-1",
		windowCount: WINDOWS,
		deliveredByOriginWindow: filled(perWindow),
		deliveredBytesByOriginWindow: filled(perWindow * MESSAGE_BYTES),
		deliveredByEventWindow: filled(perWindow),
		deliveredBytesByEventWindow: filled(perWindow * MESSAGE_BYTES),
		deliveredAfterMeasureStop: 0,
		deliveredBytesAfterMeasureStop: 0,
		perSubscriberDelivered: Array.from(
			{ length: shard },
			() => PER_SUBSCRIBER_DELIVERED,
		),
		duplicateCount: 0,
		reorderCount: 0,
		malformedCount: 0,
		disconnectCount: 0,
		firstDeliveryAtMacNs: START_NS.toString(),
		lastDeliveryAtMacNs: (START_NS + 2n).toString(),
		exitCode: 0,
		...overrides,
	} as WorkerPartialV1;
}

function linuxObservation(
	overrides: Partial<LinuxRelayObservationV1> = {},
): LinuxRelayObservationV1 {
	return {
		schema: "linux-relay-observation/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortStartBarrierSha256: BARRIER_RETAINED.sha256,
		roleTokenCommitmentRootSha256: LEAF_ROOT,
		serverChildPid: 900,
		serverChildPgid: 900,
		serverChildInstanceNonce: HEX("7"),
		linuxClockId: "clock-monotonic-1",
		windowCount: WINDOWS,
		registeredPublisherIds: [publisherId(0)],
		registeredSubscriberIdsSha256: HEX("8"),
		registeredPublisherCount: PUBLISHERS,
		registeredSubscriberCount: SUBSCRIBERS,
		acceptedIngressByOriginWindow: filled(INGRESS_PER_WINDOW),
		acceptedIngressBytesByOriginWindow: filled(
			INGRESS_PER_WINDOW * MESSAGE_BYTES,
		),
		relayWritesCompletedByOriginWindow: filled(
			INGRESS_PER_WINDOW * SUBSCRIBERS,
		),
		relayWriteBytesByOriginWindow: filled(
			INGRESS_PER_WINDOW * SUBSCRIBERS * MESSAGE_BYTES,
		),
		duplicateIngressByOriginWindow: zeros(WINDOWS),
		reorderedIngressByOriginWindow: zeros(WINDOWS),
		queueDropDeliveriesByOriginWindow: zeros(WINDOWS),
		writeTimeoutDeliveriesByOriginWindow: zeros(WINDOWS),
		disconnectUndeliveredByOriginWindow: zeros(WINDOWS),
		malformedIngressByOriginWindow: zeros(WINDOWS),
		publisherEndCount: PUBLISHERS,
		subscriberEndCount: SUBSCRIBERS,
		sessionsAccepted: PUBLISHERS + SUBSCRIBERS,
		sessionsActivePeak: PUBLISHERS + SUBSCRIBERS,
		publisherSessionsActivePeak: PUBLISHERS,
		subscriberSessionsActivePeak: SUBSCRIBERS,
		queueItemsPeak: 16,
		queueBytesPeak: 1_600,
		concurrentWritesPeak: 8,
		measurementStartedAtLinuxNs: "5000000000",
		relayDrainedAtLinuxNs: "5010000000",
		allSessionsClosedAtLinuxNs: "5020000000",
		allSessionsClosed: true,
		...overrides,
	} as LinuxRelayObservationV1;
}

function observedProcessProof(
	publisherSha: string,
	workerShas: readonly string[],
): ObservedProcessProofV1 {
	const children = [
		{
			schema: "observed-child-process/v1" as const,
			childId: publisherId(0),
			role: "publisher" as const,
			pid: 4_100,
			pgid: 4_100,
			instanceNonce: HEX("1"),
			bunSha256: HEX("d"),
			entrypointSha256: HEX("e"),
			tokenOrBundleSha256: sha256Canonical({ token: "publisher-0" }),
			publisherId: publisherId(0),
			workerIndex: null,
			orderedSubscriberIdsSha256: null,
			subscriberCount: 0,
			spawnedAtMacNs: "1",
			readyAtMacNs: "2",
			warmupCompleteAtMacNs: "3",
			measureArmedAtMacNs: "4",
			stoppedAtMacNs: "5",
			partialSha256: publisherSha,
			exitCode: 0,
			signal: null,
			replacementCount: 0 as const,
		},
		...workerShas.map((sha, index) => ({
			schema: "observed-child-process/v1" as const,
			childId: `worker-${index}`,
			role: "subscriber-worker" as const,
			pid: 4_200 + index,
			pgid: 4_200 + index,
			instanceNonce: HEX("3"),
			bunSha256: HEX("d"),
			entrypointSha256: HEX("f"),
			tokenOrBundleSha256: HEX("4"),
			publisherId: null,
			workerIndex: index,
			orderedSubscriberIdsSha256: sha256Canonical({ worker: index }),
			subscriberCount: SHARDS[index]!,
			spawnedAtMacNs: "1",
			readyAtMacNs: "2",
			warmupCompleteAtMacNs: "3",
			measureArmedAtMacNs: "4",
			stoppedAtMacNs: "5",
			partialSha256: sha,
			exitCode: 0,
			signal: null,
			replacementCount: 0 as const,
		})),
	];
	return {
		schema: "observed-process-proof/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortStartBarrierSha256: BARRIER_RETAINED.sha256,
		expectedProcessCount: PUBLISHERS + COHORT_WORKER_COUNT,
		observedProcessCount: PUBLISHERS + COHORT_WORKER_COUNT,
		expectedPublisherCount: PUBLISHERS,
		observedPublisherCount: PUBLISHERS,
		expectedWorkerCount: COHORT_WORKER_COUNT,
		observedWorkerCount: COHORT_WORKER_COUNT,
		expectedSubscriberCount: SUBSCRIBERS,
		observedSubscriberCount: SUBSCRIBERS,
		children,
		childrenDigestSha256: observedChildrenDigestSha256(children),
	} as ObservedProcessProofV1;
}

function orderedManifest(
	publisher: RetainedCanonicalBytesV1,
	workers: readonly RetainedCanonicalBytesV1[],
) {
	const entries = [
		{
			schema: "ordered-partial-manifest-entry/v1" as const,
			order: 0,
			partialKind: "publisher" as const,
			childId: publisherId(0),
			partialSha256: publisher.sha256,
			partialSize: publisher.byteLength,
		},
		...workers.map((retained, index) => ({
			schema: "ordered-partial-manifest-entry/v1" as const,
			order: index + 1,
			partialKind: "worker" as const,
			childId: `worker-${index}`,
			partialSha256: retained.sha256,
			partialSize: retained.byteLength,
		})),
	];
	return {
		schema: "ordered-partial-manifest/v1" as const,
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortStartBarrierSha256: BARRIER_RETAINED.sha256,
		publisherPartialCount: PUBLISHERS,
		workerPartialCount: COHORT_WORKER_COUNT,
		totalPartialBytes:
			publisher.byteLength +
			workers.reduce((sum, retained) => sum + retained.byteLength, 0),
		entries,
		orderedDigestSetSha256: orderedPartialDigestSetSha256(entries),
	};
}

// --- the signed spine ------------------------------------------------------
//
// Ordered exactly as the lifecycle mints it: grant, acceptance, warmup epoch
// and its manifest, drained receipt, measure-start ack, barrier, barrier
// acceptance. Each digest below is the digest of the record above it.
//
// The spine is re-minted per fixture rather than frozen at module load: a
// grant override has to reach every partial that names the grant digest, or
// the forgery under test degenerates into a cross-cohort substitution B1
// already refuses, and the check being exercised is never reached.

// `any` here is deliberate and local: these are re-minted per fixture and the
// records they hold are exactly the section 4.4 shapes their parsers assert, so
// a hand-written type here would be a second, drifting declaration of them.
/* biome-ignore-all lint/suspicious/noExplicitAny: per-fixture spine bindings */
let GRANT_RECORD: any;
let GRANT_RETAINED: any;
let GRANT_SIGNATURE: any;
let GRANT_SIGNATURE_RETAINED: any;
let RIG_ACCEPTANCE: any;
let RIG_ACCEPTANCE_RETAINED: any;
let RIG_ACCEPTANCE_SIGNATURE_RETAINED: any;
let WARMUP_EPOCH: any;
let WARMUP_EPOCH_RETAINED: any;
let WARMUP_EPOCH_SIGNATURE_RETAINED: any;
let WARMUP_MANIFEST_RETAINED: any;
let WARMUP_MANIFEST_SIGNATURE_RETAINED: any;
let SERVER_DRAINED_RETAINED: any;
let RIG_DRAINED: any;
let RIG_DRAINED_RETAINED: any;
let RIG_DRAINED_SIGNATURE_RETAINED: any;
let MEASURE_ACK_RETAINED: any;
let MEASURE_ACK_SIGNATURE_RETAINED: any;
let BARRIER: any;
let BARRIER_RETAINED: any;
let BARRIER_SIGNATURE_RETAINED: any;
let SERVER_BARRIER_RETAINED: any;
let RIG_BARRIER_ACCEPTANCE: any;
let RIG_BARRIER_ACCEPTANCE_RETAINED: any;
let RIG_BARRIER_ACCEPTANCE_SIGNATURE_RETAINED: any;

function mintSpine(grantOverride: Partial<CohortGrantV1> = {}): void {
	GRANT_RECORD = cohortGrant(grantOverride);
	GRANT_RETAINED = retain(GRANT_RECORD);
	GRANT_SIGNATURE = signMacReceipt({
		privatePkcs8Der: macKeys.privatePkcs8Der,
		publicRaw32: macKeys.publicRaw32,
		signedSchema: "cohort-grant/v1",
		signedBytes: bytesOfCanonical(GRANT_RECORD),
	});
	GRANT_SIGNATURE_RETAINED = retain(GRANT_SIGNATURE);

	RIG_ACCEPTANCE = {
		schema: "rig-cohort-acceptance/v1" as const,
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortGrantSignatureSha256: GRANT_SIGNATURE_RETAINED.sha256,
		roleTokenCommitmentRootSha256: LEAF_ROOT,
		approvedPlanSha256: EXECUTION.execution.approvedPlanSha256,
		approvalRecordSha256: EXECUTION.execution.approvalRecordSha256,
		rigExecutionIndex: 0,
		rigSupervisorInstanceNonce: HEX("9"),
		signingPublicKeySha256: sha256HexOfBytes(rigKeys.publicRaw32),
		receiptSequence: 1,
		acceptedAtMs: 1_100,
		issuedAtMs: 1_100,
		notAfterMs: 2_000,
	};
	RIG_ACCEPTANCE_RETAINED = retain(RIG_ACCEPTANCE);
	RIG_ACCEPTANCE_SIGNATURE_RETAINED = retain(
		signRigReceipt({
			privatePkcs8Der: rigKeys.privatePkcs8Der,
			publicRaw32: rigKeys.publicRaw32,
			signedSchema: "rig-cohort-acceptance/v1",
			signedBytes: bytesOfCanonical(RIG_ACCEPTANCE),
		}),
	);

	WARMUP_EPOCH = {
		schema: "cohort-warmup-epoch/v1" as const,
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortId: COHORT_ID,
		warmupNonce: HEX("9"),
		durationMs: 5_000,
		warmupMessagesPerPublisher: WARMUP_MESSAGES_PER_PUBLISHER,
		warmupIntervalMs: 500,
		expectedWarmupIngress: PUBLISHERS * WARMUP_MESSAGES_PER_PUBLISHER,
		expectedWarmupDeliveries:
			PUBLISHERS * WARMUP_MESSAGES_PER_PUBLISHER * SUBSCRIBERS,
		macSupervisorInstanceNonce: HEX("5"),
		signingPublicKeySha256: sha256HexOfBytes(macKeys.publicRaw32),
		receiptSequence: 2,
		issuedAtMs: 1_200,
		notAfterMs: 2_000,
	};
	WARMUP_EPOCH_RETAINED = retain(WARMUP_EPOCH);
	WARMUP_EPOCH_SIGNATURE_RETAINED = retain(
		signMacReceipt({
			privatePkcs8Der: macKeys.privatePkcs8Der,
			publicRaw32: macKeys.publicRaw32,
			signedSchema: "cohort-warmup-epoch/v1",
			signedBytes: bytesOfCanonical(WARMUP_EPOCH),
		}),
	);

	WARMUP_MANIFEST_RETAINED = retain({ label: "role-warmup-manifest" });
	WARMUP_MANIFEST_SIGNATURE_RETAINED = retain({
		label: "role-warmup-manifest-sig",
	});
	SERVER_DRAINED_RETAINED = retain({ label: "server-warmup-drained" });

	RIG_DRAINED = {
		schema: "rig-warmup-drained-receipt/v1" as const,
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortWarmupEpochSha256: WARMUP_EPOCH_RETAINED.sha256,
		cohortWarmupEpochSignatureSha256: WARMUP_EPOCH_SIGNATURE_RETAINED.sha256,
		roleWarmupCompletionManifestSha256: WARMUP_MANIFEST_RETAINED.sha256,
		roleWarmupCompletionManifestSignatureSha256:
			WARMUP_MANIFEST_SIGNATURE_RETAINED.sha256,
		serverWarmupDrainedSha256: SERVER_DRAINED_RETAINED.sha256,
		rigSupervisorInstanceNonce: HEX("9"),
		signingPublicKeySha256: sha256HexOfBytes(rigKeys.publicRaw32),
		receiptSequence: 3,
		receivedAtRigNs: "5000000000",
		linuxClockId: "clock-monotonic-1",
		issuedAtMs: 1_300,
		notAfterMs: 2_000,
	};
	RIG_DRAINED_RETAINED = retain(RIG_DRAINED);
	RIG_DRAINED_SIGNATURE_RETAINED = retain(
		signRigReceipt({
			privatePkcs8Der: rigKeys.privatePkcs8Der,
			publicRaw32: rigKeys.publicRaw32,
			signedSchema: "rig-warmup-drained-receipt/v1",
			signedBytes: bytesOfCanonical(RIG_DRAINED),
		}),
	);

	MEASURE_ACK_RETAINED = retain({ label: "rig-measure-start-ack" });
	MEASURE_ACK_SIGNATURE_RETAINED = retain({
		label: "rig-measure-start-ack-sig",
	});

	BARRIER = {
		schema: "cohort-start-barrier/v1" as const,
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		rigCohortAcceptanceSha256: RIG_ACCEPTANCE_RETAINED.sha256,
		rigMeasureStartAckSha256: MEASURE_ACK_RETAINED.sha256,
		roleWarmupCompletionManifestSha256: WARMUP_MANIFEST_RETAINED.sha256,
		roleWarmupCompletionManifestSignatureSha256:
			WARMUP_MANIFEST_SIGNATURE_RETAINED.sha256,
		rigWarmupDrainedReceiptSha256: RIG_DRAINED_RETAINED.sha256,
		cohortId: COHORT_ID,
		barrierNonce: HEX("2"),
		macClockId: "mach-continuous-1",
		mintedAtMacNs: (START_NS - 3n).toString(),
		warmupStartedAtMacNs: (START_NS - 2n).toString(),
		warmupCompletedAtMacNs: (START_NS - 1n).toString(),
		measureStartAtMacNs: START_NS.toString(),
		measureStopAtMacNs: (START_NS + BigInt(MEASURED_MS) * NS_PER_MS).toString(),
		sampleWindowMs: 1_000 as const,
		windowCount: WINDOWS as 10,
		measuredDurationMs: MEASURED_MS as 10000,
		drainDeadlineMs: 10_000 as const,
		macSupervisorInstanceNonce: HEX("5"),
		signingPublicKeySha256: sha256HexOfBytes(macKeys.publicRaw32),
		receiptSequence: 4,
		issuedAtMs: 1_400,
		notAfterMs: 2_000,
	};
	BARRIER_RETAINED = retain(BARRIER);
	BARRIER_SIGNATURE_RETAINED = retain(
		signMacReceipt({
			privatePkcs8Der: macKeys.privatePkcs8Der,
			publicRaw32: macKeys.publicRaw32,
			signedSchema: "cohort-start-barrier/v1",
			signedBytes: bytesOfCanonical(BARRIER),
		}),
	);
	SERVER_BARRIER_RETAINED = retain({ label: "server-start-barrier" });

	RIG_BARRIER_ACCEPTANCE = {
		schema: "rig-barrier-acceptance/v1" as const,
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortStartBarrierSha256: BARRIER_RETAINED.sha256,
		cohortStartBarrierSignatureSha256: BARRIER_SIGNATURE_RETAINED.sha256,
		rigMeasureStartAckSha256: MEASURE_ACK_RETAINED.sha256,
		serverStartBarrierAcceptedSha256: SERVER_BARRIER_RETAINED.sha256,
		rigSupervisorInstanceNonce: HEX("9"),
		signingPublicKeySha256: sha256HexOfBytes(rigKeys.publicRaw32),
		receiptSequence: 5,
		acceptedAtLinuxNs: "5000000001",
		linuxClockId: "clock-monotonic-1",
		issuedAtMs: 1_500,
		notAfterMs: 2_000,
	};
	RIG_BARRIER_ACCEPTANCE_RETAINED = retain(RIG_BARRIER_ACCEPTANCE);
	RIG_BARRIER_ACCEPTANCE_SIGNATURE_RETAINED = retain(
		signRigReceipt({
			privatePkcs8Der: rigKeys.privatePkcs8Der,
			publicRaw32: rigKeys.publicRaw32,
			signedSchema: "rig-barrier-acceptance/v1",
			signedBytes: bytesOfCanonical(RIG_BARRIER_ACCEPTANCE),
		}),
	);
}

mintSpine();

/** Admission fields that name records this fixture does not model. */
const ADMISSION_OPAQUE_FIELDS = [
	"measurementGrantSha256",
	"macExecutionGrantReceiptSha256",
	"rigServerSnapshotReceiptSha256",
	"rigServerSnapshotReceiptSignatureSha256",
	"macMeasurementAdmissionReceiptSha256",
	"macMeasurementAdmissionSignatureSha256",
] as const;

interface CohortFixtureOptions {
	/** Rewrite a derived record before the admission receipt is minted. */
	readonly rewrite?: (records: {
		proof: ObservedProcessProofV1;
		ledger: CohortLedgerV1;
		capacity: CohortCapacityV1;
		series: CohortRateSeriesV1;
		linux: LinuxRelayObservationV1;
	}) => void;
	/** Replace the retained grant bytes with a differently-declared grant. */
	readonly grantOverride?: Partial<CohortGrantV1>;
	/** Replace the retained leaf manifest with a tampered one. */
	readonly leafManifestOverride?: Record<string, unknown>;
	/** Sign the Mac graph with a key the trust context did not stage. */
	readonly foreignMacKey?: boolean;
	/** Sign the rig graph with a key the trust context did not stage. */
	readonly foreignRigKey?: boolean;
	/** Fold post-stop drain deliveries into the worker partials. */
	readonly postStopDrain?: number;
	/** Report a queue drop so the anomaly counters are not all zero. */
	readonly queueDrop?: boolean;
}

function honestEvidence(
	options: CohortFixtureOptions = {},
): Record<string, unknown> {
	// Re-mint the whole signed spine so a grant override reaches every record
	// that names the grant digest, not just the retained grant itself.
	mintSpine(options.grantOverride ?? {});
	const drain = options.postStopDrain ?? 0;
	const publisher = publisherPartial();
	const workers = Array.from(
		{ length: COHORT_WORKER_COUNT },
		(_unused, index) => {
			const shard = SHARDS[index]!;
			const share = index === 0 ? drain : 0;
			const perWindow = INGRESS_PER_WINDOW * shard;
			// Drain deliveries leave the measured event windows and reappear after
			// stop; the origin windows never move, which is the whole point.
			const event = filled(perWindow);
			if (share > 0) event[WINDOWS - 1] = perWindow - share;
			const eventBytes = event.map((count) => count * MESSAGE_BYTES);
			return workerPartial(index, {
				deliveredByEventWindow: event,
				deliveredBytesByEventWindow: eventBytes,
				deliveredAfterMeasureStop: share,
				deliveredBytesAfterMeasureStop: share * MESSAGE_BYTES,
			});
		},
	);
	const linuxRecord = options.queueDrop
		? linuxObservation({
				relayWritesCompletedByOriginWindow: filled(
					INGRESS_PER_WINDOW * SUBSCRIBERS,
				),
				queueDropDeliveriesByOriginWindow: filled(0).map((_unused, index) =>
					index === 0 ? 0 : 0,
				),
			})
		: linuxObservation();

	const conservation = recomputeCohortOriginConservation({
		publisherPartials: [publisher],
		workerPartials: workers,
		linuxRelayObservation: linuxRecord,
		subscriberCount: SUBSCRIBERS,
		messageBytes: MESSAGE_BYTES,
	});
	if (!conservation.ok)
		throw new Error(`conservation: ${conservation.message}`);
	const seriesResult = recomputeCohortRateSeries({
		workerPartials: workers,
		conservation: conservation.value,
		windowCount: WINDOWS as 10,
		measuredDurationMs: MEASURED_MS as 10000,
		firstDeliveryAtMacNs: START_NS.toString(),
		lastMeasuredWindowDeliveryAtMacNs: (START_NS + 2n).toString(),
		lastDeliveryIncludingDrainAtMacNs: (START_NS + 3n).toString(),
	});
	if (!seriesResult.ok) throw new Error(`series: ${seriesResult.message}`);
	const ledgerResult = recomputeCohortLedger({
		conservation: conservation.value,
		subscriberCount: SUBSCRIBERS,
		messageBytes: MESSAGE_BYTES,
	});
	if (!ledgerResult.ok) throw new Error(`ledger: ${ledgerResult.message}`);

	const publisherRetained = retain(publisher);
	const workerRetained = workers.map((worker) => retain(worker));
	const records = {
		proof: observedProcessProof(
			publisherRetained.sha256,
			workerRetained.map((member) => member.sha256),
		),
		ledger: ledgerResult.value,
		capacity: {
			schema: "cohort-capacity/v1",
			expectedSessions: PUBLISHERS + SUBSCRIBERS,
			sessionsAccepted: PUBLISHERS + SUBSCRIBERS,
			sessionsActivePeak: PUBLISHERS + SUBSCRIBERS,
			expectedPublishers: PUBLISHERS,
			registeredPublishers: PUBLISHERS,
			expectedSubscribers: SUBSCRIBERS,
			registeredSubscribers: SUBSCRIBERS,
		} as CohortCapacityV1,
		series: seriesResult.value,
		linux: linuxRecord,
	};
	options.rewrite?.(records);

	const linuxRetained = retain(records.linux);
	const manifestRetained = retain(
		orderedManifest(publisherRetained, workerRetained),
	);
	const proofRetained = retain(records.proof);
	const seriesRetained = retain(records.series);
	const ledgerRetained = retain(records.ledger);
	const capacityRetained = retain(records.capacity);

	const relayReceipt = {
		schema: "rig-relay-observation-receipt/v1" as const,
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: GRANT_RETAINED.sha256,
		cohortStartBarrierSha256: BARRIER_RETAINED.sha256,
		linuxRelayObservationSha256: linuxRetained.sha256,
		rigExecutionAcceptanceSha256: RIG_ACCEPTANCE_RETAINED.sha256,
		rigSupervisorInstanceNonce: HEX("9"),
		signingPublicKeySha256: sha256HexOfBytes(
			(options.foreignRigKey ? generateEd25519KeyPair() : rigKeys).publicRaw32,
		),
		receiptSequence: 6,
		receivedAtRigNs: "5030000000",
		issuedAtMs: 1_600,
		notAfterMs: 2_000,
	};
	const relayReceiptRetained = retain(relayReceipt);
	const relaySigner = options.foreignRigKey
		? generateEd25519KeyPair()
		: rigKeys;
	const relayReceiptSignatureRetained = retain(
		signRigReceipt({
			privatePkcs8Der: relaySigner.privatePkcs8Der,
			publicRaw32: relaySigner.publicRaw32,
			signedSchema: "rig-relay-observation-receipt/v1",
			signedBytes: bytesOfCanonical(relayReceipt),
		}),
	);

	const grantRetained = GRANT_RETAINED;
	const leafManifestRetained = retain(
		options.leafManifestOverride ?? LEAF_MANIFEST,
	);

	const admission: Record<string, unknown> = {
		schema: "cohort-admission-receipt/v1",
		executionSha256: EXECUTION_SHA,
		cohortGrantSha256: grantRetained.sha256,
		cohortGrantSignatureSha256: GRANT_SIGNATURE_RETAINED.sha256,
		rigCohortAcceptanceSha256: RIG_ACCEPTANCE_RETAINED.sha256,
		rigCohortAcceptanceSignatureSha256:
			RIG_ACCEPTANCE_SIGNATURE_RETAINED.sha256,
		tokenCommitmentLeafManifestSha256: leafManifestRetained.sha256,
		cohortWarmupEpochSha256: WARMUP_EPOCH_RETAINED.sha256,
		cohortWarmupEpochSignatureSha256: WARMUP_EPOCH_SIGNATURE_RETAINED.sha256,
		roleWarmupCompletionManifestSha256: WARMUP_MANIFEST_RETAINED.sha256,
		roleWarmupCompletionManifestSignatureSha256:
			WARMUP_MANIFEST_SIGNATURE_RETAINED.sha256,
		serverWarmupDrainedSha256: SERVER_DRAINED_RETAINED.sha256,
		rigWarmupDrainedReceiptSha256: RIG_DRAINED_RETAINED.sha256,
		rigWarmupDrainedReceiptSignatureSha256:
			RIG_DRAINED_SIGNATURE_RETAINED.sha256,
		rigMeasureStartAckSha256: MEASURE_ACK_RETAINED.sha256,
		rigMeasureStartAckSignatureSha256: MEASURE_ACK_SIGNATURE_RETAINED.sha256,
		cohortStartBarrierSha256: BARRIER_RETAINED.sha256,
		cohortStartBarrierSignatureSha256: BARRIER_SIGNATURE_RETAINED.sha256,
		rigBarrierAcceptanceSha256: RIG_BARRIER_ACCEPTANCE_RETAINED.sha256,
		rigBarrierAcceptanceSignatureSha256:
			RIG_BARRIER_ACCEPTANCE_SIGNATURE_RETAINED.sha256,
		serverStartBarrierAcceptedSha256: SERVER_BARRIER_RETAINED.sha256,
		orderedPartialManifestSha256: manifestRetained.sha256,
		observedProcessProofSha256: proofRetained.sha256,
		linuxRelayObservationSha256: linuxRetained.sha256,
		rigRelayObservationReceiptSha256: relayReceiptRetained.sha256,
		rigRelayObservationReceiptSignatureSha256:
			relayReceiptSignatureRetained.sha256,
		rateSeriesSha256: seriesRetained.sha256,
		ledgerSha256: ledgerRetained.sha256,
		capacitySha256: capacityRetained.sha256,
		approvedPlanSha256: EXECUTION.execution.approvedPlanSha256,
		approvalRecordSha256: EXECUTION.execution.approvalRecordSha256,
		publisherCount: PUBLISHERS,
		workerCount: COHORT_WORKER_COUNT,
		subscriberCount: SUBSCRIBERS,
		offeredIngress: records.ledger.offeredIngress,
		serverAcceptedIngress: records.ledger.serverAcceptedIngress,
		linuxRelayWritesCompleted: records.ledger.linuxRelayWritesCompleted,
		delivered: records.ledger.delivered,
		macSupervisorInstanceNonce: HEX("5"),
		signingPublicKeySha256: sha256HexOfBytes(macKeys.publicRaw32),
		receiptSequence: 7,
		issuedAtMs: 1_700,
		notAfterMs: 2_000,
	};
	for (const opaque of ADMISSION_OPAQUE_FIELDS) admission[opaque] = HEX("9");
	const admissionSigner = options.foreignMacKey
		? generateEd25519KeyPair()
		: macKeys;
	const admissionSignatureRetained = retain(
		signMacReceipt({
			privatePkcs8Der: admissionSigner.privatePkcs8Der,
			publicRaw32: admissionSigner.publicRaw32,
			signedSchema: "cohort-admission-receipt/v1",
			signedBytes: bytesOfCanonical(admission),
		}),
	);

	return {
		schema: "cohort-observation-evidence/v1",
		workloadRolePlanInput: retain({ label: "workload" }),
		cohortGrant: grantRetained,
		cohortGrantSignature: GRANT_SIGNATURE_RETAINED,
		rigCohortAcceptance: RIG_ACCEPTANCE_RETAINED,
		rigCohortAcceptanceSignature: RIG_ACCEPTANCE_SIGNATURE_RETAINED,
		tokenCommitmentLeafManifest: leafManifestRetained,
		cohortWarmupEpoch: WARMUP_EPOCH_RETAINED,
		cohortWarmupEpochSignature: WARMUP_EPOCH_SIGNATURE_RETAINED,
		roleWarmupCompletionManifest: WARMUP_MANIFEST_RETAINED,
		roleWarmupCompletionManifestSignature: WARMUP_MANIFEST_SIGNATURE_RETAINED,
		roleWarmupCompletes: Array.from(
			{ length: PUBLISHERS + COHORT_WORKER_COUNT },
			(_unused, index) => retain({ label: `warmup-complete-${index}` }),
		),
		serverWarmupDrained: SERVER_DRAINED_RETAINED,
		rigWarmupDrainedReceipt: RIG_DRAINED_RETAINED,
		rigWarmupDrainedReceiptSignature: RIG_DRAINED_SIGNATURE_RETAINED,
		rigMeasureStartAck: MEASURE_ACK_RETAINED,
		rigMeasureStartAckSignature: MEASURE_ACK_SIGNATURE_RETAINED,
		cohortStartBarrier: BARRIER_RETAINED,
		cohortStartBarrierSignature: BARRIER_SIGNATURE_RETAINED,
		rigBarrierAcceptance: RIG_BARRIER_ACCEPTANCE_RETAINED,
		rigBarrierAcceptanceSignature: RIG_BARRIER_ACCEPTANCE_SIGNATURE_RETAINED,
		serverStartBarrierAccepted: SERVER_BARRIER_RETAINED,
		publisherPartials: [publisherRetained],
		workerPartials: workerRetained,
		orderedPartialManifest: manifestRetained,
		observedProcessProof: proofRetained,
		linuxRelayObservation: linuxRetained,
		rigRelayObservationReceipt: relayReceiptRetained,
		rigRelayObservationReceiptSignature: relayReceiptSignatureRetained,
		rateSeries: seriesRetained,
		ledger: ledgerRetained,
		capacity: capacityRetained,
		cohortAdmissionReceipt: retain(admission),
		cohortAdmissionSignature: admissionSignatureRetained,
	};
}

function exportReceipt(
	evidence: unknown,
	overrides: Record<string, unknown> = {},
) {
	const bytes = bytesOfCanonical(evidence);
	const ack = {
		schema: "mac-cohort-evidence-exported-ack/v1",
		responseSeq: 11,
		ackRequestSeq: 11,
		executionSha256: EXECUTION_SHA,
		cohortObservationEvidenceSha256: sha256HexOfBytes(bytes),
		cohortObservationEvidenceSize: bytes.byteLength,
		terminalExport: true,
		...overrides,
	} as MacCohortEvidenceExportedAckV1;
	return {
		...ack,
		cohortObservationEvidenceSignatureBase64: toBase64(
			ed25519Sign(macKeys.privatePkcs8Der, cohortExportAckSigningBytes(ack)),
		),
	};
}

function reconstruct(
	options: {
		readonly evidence?: unknown;
		readonly receipt?: unknown;
		readonly withKeys?: boolean;
		readonly cellId?: string;
		readonly armKind?: "primary" | "read-path" | "overlay";
		readonly transport?: "ws" | "wt";
	} = {},
) {
	const evidence = "evidence" in options ? options.evidence : honestEvidence();
	return reconstructCohortEvidenceOffline({
		cellId: options.cellId ?? CELL,
		armKind: options.armKind ?? "primary",
		transport: options.transport ?? "ws",
		executionSha256: EXECUTION_SHA,
		cohortObservationEvidence: evidence,
		cohortEvidenceExport: options.receipt ?? exportReceipt(evidence),
		...(options.withKeys === false
			? {}
			: {
					stagedMacPublicRaw32: macKeys.publicRaw32,
					stagedRigPublicRaw32: rigKeys.publicRaw32,
				}),
	});
}

function failureCode(result: ReturnType<typeof reconstruct>): string {
	if (result.ok) throw new Error("expected a reconstruction failure");
	return result.code;
}

describe("B4 section 11: publisher-partial cardinality at reconstruction", () => {
	// The §4.5 recomputation is where a cohort's publisher set is finally
	// counted. A bundle offering none, or more than the frozen maximum, is a
	// different cohort than the one that was granted -- so it is refused here
	// rather than reduced to whatever happens to be present.
	const workers = Array.from(
		{ length: COHORT_WORKER_COUNT },
		(_unused, index) => workerPartial(index),
	);

	test("zero publisher partials are refused", () => {
		const result = recomputeCohortOriginConservation({
			publisherPartials: [],
			workerPartials: workers,
			linuxRelayObservation: linuxObservation(),
			subscriberCount: SUBSCRIBERS,
			messageBytes: MESSAGE_BYTES,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain(
			"publisher partial count is outside 1..10",
		);
	});

	test("more than COHORT_MAX_PUBLISHERS publisher partials are refused", () => {
		const tooMany = Array.from({ length: COHORT_MAX_PUBLISHERS + 1 }, () =>
			publisherPartial(),
		);
		expect(tooMany.length).toBe(11);
		const result = recomputeCohortOriginConservation({
			publisherPartials: tooMany,
			workerPartials: workers,
			linuxRelayObservation: linuxObservation(),
			subscriberCount: SUBSCRIBERS,
			messageBytes: MESSAGE_BYTES,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain(
			"publisher partial count is outside 1..10",
		);
	});

	test("exactly COHORT_MAX_PUBLISHERS is not itself the refusal", () => {
		// The boundary is a cardinality rule, not a count-of-one rule: ten
		// publishers get past the guard and are refused (if at all) on their
		// arithmetic, never on being ten.
		const atCap = Array.from({ length: COHORT_MAX_PUBLISHERS }, () =>
			publisherPartial(),
		);
		const result = recomputeCohortOriginConservation({
			publisherPartials: atCap,
			workerPartials: workers,
			linuxRelayObservation: linuxObservation(),
			subscriberCount: SUBSCRIBERS,
			messageBytes: MESSAGE_BYTES,
		});
		if (!result.ok)
			expect(result.message).not.toContain("publisher partial count");
	});
});

describe("B4 section 12 #6: offline reconstruction of one cohort arm", () => {
	test("an honest ticker 10k export reconstructs, closes both graphs, and is promotable", () => {
		const result = reconstruct();
		if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
		expect(result.cell).toBe("ticker 10k");
		expect(result.receiptGraphComplete).toBe(true);
		expect(result.promotionEligible).toBe(true);
		expect(result.ledger.offeredIngress).toBe(100_000);
		expect(result.ledger.delivered).toBe(10_000_000);
		expect(result.rateSeries.postStopDrainDelivered).toBe(0);
		expect(result.tokenCommitmentRootSha256).toBe(LEAF_ROOT);
	});

	test("the token leaf Merkle root is recomputed from the manifest, not restated", () => {
		const tampered = {
			...LEAF_MANIFEST,
			roleTokenCommitmentRootSha256: HEX("c"),
		};
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({ leafManifestOverride: tampered }),
				}),
			),
		).toBe("COHORT_TOKEN_ROOT_MISMATCH");
	});

	test("a leaf swapped inside the manifest moves the recomputed root", () => {
		const swapped = {
			...LEAF_MANIFEST,
			leaves: [
				...LEAF_MANIFEST.leaves.slice(0, LEAF_MANIFEST.leaves.length - 1),
				{
					...LEAF_MANIFEST.leaves[LEAF_MANIFEST.leaves.length - 1]!,
					tokenSha256: HEX("b"),
				},
			],
		};
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({ leafManifestOverride: swapped }),
				}),
			),
		).toBe("COHORT_TOKEN_ROOT_MISMATCH");
	});

	test("a wrong expanded-delivery grant declaration is refused", () => {
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({
						grantOverride: {
							expectedOfferedIngress: 100_000,
							expectedExpandedDeliveries: 100_000,
						},
					}),
				}),
			),
		).toBe("COHORT_GRANT_DECLARATION_INVALID");
	});

	test("a grant for another cell's cardinality is refused", () => {
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({
						grantOverride: {
							expectedOfferedIngress: 500_000,
							expectedExpandedDeliveries: 50_000_000,
						},
					}),
				}),
			),
		).toBe("COHORT_GRANT_DECLARATION_INVALID");
	});

	test("a cross-transport grant swap is refused", () => {
		expect(failureCode(reconstruct({ transport: "wt" }))).toBe(
			"COHORT_CROSS_RUN_SWAP",
		);
	});

	test("a ledger rewritten before the receipt still fails its own arithmetic", () => {
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({
						rewrite: (records) => {
							// Internally consistent, and still not what the partials say:
							// the forgery has to survive the ledger's own arithmetic
							// before the recomputation is what refuses it.
							const ledger = records.ledger as {
								delivered: number;
								deliveredBytes: number;
							};
							ledger.delivered = 9_999_000;
							ledger.deliveredBytes = 9_999_000 * MESSAGE_BYTES;
						},
					}),
				}),
			),
		).toBe("COHORT_LEDGER_REWRITTEN");
	});

	test("a rate series rewritten before the receipt is refused", () => {
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({
						rewrite: (records) => {
							const series = records.series as unknown as {
								samples: number[];
								measuredWindowDeliveredTotal: number;
								conservationDeliveredTotal: number;
								meanNumerator: number;
							};
							series.samples = [...series.samples];
							series.samples[0] = series.samples[0]! + 1;
							series.measuredWindowDeliveredTotal += 1;
							series.conservationDeliveredTotal += 1;
							series.meanNumerator += 1_000;
						},
					}),
				}),
			),
		).toBe("COHORT_SERIES_REWRITTEN");
	});

	test("a capacity record rewritten before the receipt is refused", () => {
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({
						rewrite: (records) => {
							(
								records.capacity as { sessionsActivePeak: number }
							).sessionsActivePeak = PUBLISHERS + SUBSCRIBERS - 1;
						},
					}),
				}),
			),
		).toBe("COHORT_CAPACITY_REWRITTEN");
	});

	test("two children sharing one pid are refused", () => {
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({
						rewrite: (records) => {
							const children = records.proof.children as unknown as {
								pid: number;
							}[];
							// Re-digested after the rewrite, so the proof is internally
							// honest and only the duplicate identity is left to catch.
							children[1]!.pid = children[0]!.pid;
							(
								records.proof as { childrenDigestSha256: string }
							).childrenDigestSha256 = observedChildrenDigestSha256(
								records.proof.children as never,
							);
						},
					}),
				}),
			),
		).toBe("COHORT_PROCESS_PROOF_REWRITTEN");
	});

	test("a Linux observation captured before every session closed is refused by the schema", () => {
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({
						rewrite: (records) => {
							(
								records.linux as { allSessionsClosed: unknown }
							).allSessionsClosed = false;
						},
					}),
				}),
			),
		).toBe("COHORT_EVIDENCE_GRAPH_INVALID");
	});

	test("post-stop drain is never folded backward into the measured samples", () => {
		const result = reconstruct({
			evidence: honestEvidence({ postStopDrain: 5 }),
		});
		if (!result.ok) throw new Error(`${result.code}: ${result.reason}`);
		expect(result.rateSeries.postStopDrainDelivered).toBe(5);
		// The conservation total still accounts for every delivery...
		expect(result.rateSeries.conservationDeliveredTotal).toBe(10_000_000);
		// ...but the measured window is short by exactly the drain, and the arm
		// is not promotable.
		expect(result.rateSeries.measuredWindowDeliveredTotal).toBe(9_999_995);
		expect(result.promotionEligible).toBe(false);
	});

	test("the export receipt digest must cover the retained bytes", () => {
		expect(
			failureCode(
				reconstruct({
					receipt: exportReceipt(honestEvidence(), {
						cohortObservationEvidenceSha256: HEX("4"),
					}),
				}),
			),
		).toBe("COHORT_EXPORT_DIGEST_MISMATCH");
	});

	test("the export receipt size must equal the canonical byte length", () => {
		expect(
			failureCode(
				reconstruct({
					receipt: exportReceipt(honestEvidence(), {
						cohortObservationEvidenceSize: 12,
					}),
				}),
			),
		).toBe("COHORT_EXPORT_SIZE_MISMATCH");
	});

	test("an export receipt naming another execution is refused", () => {
		expect(
			failureCode(
				reconstruct({
					receipt: exportReceipt(honestEvidence(), {
						executionSha256: HEX("7"),
					}),
				}),
			),
		).toBe("COHORT_EXPORT_EXECUTION_MISMATCH");
	});

	test("a non-terminal export acknowledgement is refused", () => {
		expect(
			failureCode(
				reconstruct({
					receipt: exportReceipt(honestEvidence(), { terminalExport: false }),
				}),
			),
		).toBe("COHORT_EXPORT_RECEIPT_INVALID");
	});

	test("an export acknowledgement without a request sequence is refused", () => {
		expect(
			failureCode(
				reconstruct({
					receipt: exportReceipt(honestEvidence(), { ackRequestSeq: 0 }),
				}),
			),
		).toBe("COHORT_EXPORT_RECEIPT_INVALID");
	});

	test("a missing worker partial is refused before any digest is believed", () => {
		const evidence = honestEvidence();
		evidence.workerPartials = (
			evidence.workerPartials as RetainedCanonicalBytesV1[]
		).slice(0, COHORT_WORKER_COUNT - 1);
		expect(
			failureCode(reconstruct({ evidence, receipt: exportReceipt(evidence) })),
		).toBe("COHORT_EVIDENCE_GRAPH_INVALID");
	});

	test("a duplicated worker partial is refused", () => {
		const evidence = honestEvidence();
		const workers = evidence.workerPartials as RetainedCanonicalBytesV1[];
		evidence.workerPartials = [...workers.slice(0, 7), workers[0]!];
		expect(
			failureCode(reconstruct({ evidence, receipt: exportReceipt(evidence) })),
		).toBe("COHORT_EVIDENCE_GRAPH_INVALID");
	});

	test("a reordered worker partial set is refused", () => {
		const evidence = honestEvidence();
		const workers = [
			...(evidence.workerPartials as RetainedCanonicalBytesV1[]),
		];
		[workers[0], workers[1]] = [workers[1]!, workers[0]!];
		evidence.workerPartials = workers;
		expect(
			failureCode(reconstruct({ evidence, receipt: exportReceipt(evidence) })),
		).toBe("COHORT_EVIDENCE_GRAPH_INVALID");
	});

	test("a genuine admission receipt paired with different partial bytes is refused", () => {
		const evidence = honestEvidence();
		evidence.publisherPartials = [
			retain(publisherPartial({ childPid: 4_101, childPgid: 4_101 })),
		];
		expect(
			failureCode(reconstruct({ evidence, receipt: exportReceipt(evidence) })),
		).toBe("COHORT_EVIDENCE_GRAPH_INVALID");
	});

	test("a Mac graph signed by an unstaged key is refused", () => {
		expect(
			failureCode(
				reconstruct({ evidence: honestEvidence({ foreignMacKey: true }) }),
			),
		).toBe("COHORT_MAC_SIGNATURE_INVALID");
	});

	test("a rig graph signed by an unstaged key is refused", () => {
		expect(
			failureCode(
				reconstruct({ evidence: honestEvidence({ foreignRigKey: true }) }),
			),
		).toBe("COHORT_RIG_SIGNATURE_INVALID");
	});

	test("without staged keys the graph is not closed and nothing is promotable", () => {
		const result = reconstruct({ withKeys: false });
		expect(failureCode(result)).toBe("COHORT_EXPORT_RECEIPT_INVALID");
	});

	test("a shard whose worker reported a different subscriber count is refused", () => {
		expect(
			failureCode(
				reconstruct({
					evidence: honestEvidence({
						rewrite: (records) => {
							const children = records.proof.children as unknown as {
								role: string;
								subscriberCount: number;
							}[];
							const worker = children.find(
								(child) => child.role === "subscriber-worker",
							)!;
							worker.subscriberCount -= 1;
							(
								records.proof as { childrenDigestSha256: string }
							).childrenDigestSha256 = observedChildrenDigestSha256(
								records.proof.children as never,
							);
						},
					}),
				}),
			),
		).toBe("COHORT_EVIDENCE_GRAPH_INVALID");
	});

	test("a non-fanout cell offered cohort evidence is refused as unexpected", () => {
		expect(failureCode(reconstruct({ cellId: "bulk-one-way/physical" }))).toBe(
			"COHORT_EVIDENCE_UNEXPECTED",
		);
	});

	test("a read-path arm of a fanout cell runs no cohort", () => {
		expect(failureCode(reconstruct({ armKind: "read-path" }))).toBe(
			"COHORT_EVIDENCE_UNEXPECTED",
		);
	});

	test("a fanout primary arm without the export is refused as missing", () => {
		expect(
			failureCode(
				reconstruct({
					evidence: null,
					receipt: exportReceipt({ empty: true }),
				}),
			),
		).toBe("COHORT_EVIDENCE_MISSING");
	});
});

test("terminal export forgery fails despite honest complete graph and matching digest", () => {
	const evidence = honestEvidence();
	const receipt = exportReceipt(evidence);
	expect(reconstruct({ evidence, receipt }).ok).toBe(true);
	for (const change of [
		{ responseSeq: 12 },
		{ ackRequestSeq: 12 },
		{ cohortObservationEvidenceSignatureBase64: toBase64(new Uint8Array(64)) },
		{ untrustedKey: toBase64(macKeys.publicRaw32) },
	]) {
		expect(
			failureCode(
				reconstruct({ evidence, receipt: { ...receipt, ...change } }),
			),
		).toBe("COHORT_EXPORT_RECEIPT_INVALID");
	}
});
