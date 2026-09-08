/**
 * The physical preflight gate (physical-budget amendment D4).
 *
 * Before any phase-b stage the lead runs this once per transport, rig to Mac
 * over the real cable, on the top row of each ladder: it drives the production
 * cohort lifecycle -- the staged `server.ts --mode=fanout-cohort` child spawned
 * by the rig supervisor, eighteen or eleven production `fanout-role.ts`
 * children spawned by the Mac supervisor, the compact codec, the real
 * WebTransport connector and its admission limits, the warmup epoch at the
 * code's own pacing and then the measured window -- and reads, from the
 * lease's own retention, whether the relay accepted everything offered in
 * every origin window, whether the eight Mac workers counted every delivery,
 * whether anything faulted, and how much of the server child's main thread
 * the load cost.
 *
 * Two passes per topology and transport. `1x` paces the publishers at the
 * grant's own rate; `2x` paces them at twice the row's binding ingress
 * through the child's `messageRatePerSecond` spawn-config input, which the
 * lease factory takes as a preflight-only parameter and the receipt records
 * as the offered rate. The grant is the cell's either way. Every per-window
 * figure in the receipt is an origin-window count from the partials and the
 * Linux observation, never a wall-clock sample; the CPU series is the one
 * place wall-clock seconds appear, and it says so.
 *
 * Instruments. The measured-window main-thread and process CPU are the rig
 * supervisor's `serverChildCpu` (D6: `/proc/<pid>/task/<pid>/stat` and
 * `/proc/<pid>/stat`, read on the measure-start ack and the capture ack).
 * The warmup epoch, the per-second series, the rig's per-core MHz, RSS and
 * NOFILE are the preflight's own sampler on the same leaves, over the ssh
 * session the campaign uses, stamped on the Mac clock the barrier's
 * boundaries are written in. On the development host (`--loopback`, the
 * local acceptance profile on one machine) the rig supervisor reads libproc
 * and the sampler reads `ps -M`; the receipt names which.
 *
 * This file is a `cliEntryTs` under `check-official-io`: nothing on the
 * frozen run command or in the controller imports it.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import {
	COHORT_WORKER_COUNT,
	COHORT_LOCAL_ACCEPTANCE_SERVER_HOST,
	cohortCellCardinality,
	cohortCellGrantParameters,
	type LinuxRelayObservationV1,
	parseLinuxRelayObservation,
	parsePublisherPartial,
	parseWorkerPartial,
	type PublisherPartialV1,
	STAGED_SERVER_TLS_CERTIFICATE_LEAF,
	STAGED_SERVER_TLS_PRIVATE_KEY_LEAF,
	WARMUP_DURATION_MS,
	WARMUP_MESSAGES_PER_PUBLISHER,
	type WorkerPartialV1,
} from "../cohort-protocol.ts";
import {
	generateEd25519KeyPair,
	type ProtocolResult,
	type Sha256Hex,
} from "../cross-supervisor-protocol.ts";
import {
	cohortCellForArm,
	FANOUT_COHORT_CELL_IDS,
	sha256HexOfBytes,
	type ToolchainSet,
} from "../evidence.ts";
import {
	R1_AUTHORITY_APPROVAL,
	R1_CAMPAIGN_ID,
	R1_CANDIDATE_ID,
	R1_SOURCE_ARCHIVE_RECEIPT,
} from "../r1-fixtures.ts";
import {
	buildRigSupervisorWrapperScript,
	MAC_SUPERVISOR_DEFAULT_USER,
	processGroupIdOf,
	resolveSupervisorBinaryPath,
	resolveSupervisorBunPath,
	spawnMacSupervisor,
	spawnRigSupervisor,
	type StagedTrustBootstrapPaths,
	stopSupervisor,
	type SupervisorHandle,
	TRUST_BOOTSTRAP_CAMPAIGN_ROOT,
	TRUST_BOOTSTRAP_STAGING_ROOT,
	verifyStagedTrustBootstrap,
} from "../remote-supervisor.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "../scenario-registry.ts";
import { canonicalRecordBytes } from "../secure-fs.ts";
import {
	buildStagedServerLaunchRecord,
	stagedServerLaunchModesForProfile,
	stagedServerLaunchRecordLeaf,
} from "../server.ts";
import {
	type RigServerSnapshotReceiptV1,
	serverChildCpuIssue,
} from "../server-observation-artifact.ts";
import { isServerLoopUtilizationFrameV1 } from "../server-snapshot-protocol.ts";
import {
	observeLocalToolchain,
	toolchainIdentity,
} from "../toolchain-observation.ts";
import {
	COHORT_RECEIPT_VALIDITY_MS,
	type CohortArmLease,
	createCohortArmRuntimeProvider,
	createProductionCohortArmLeaseFactory,
	dispatchArmRepetition,
	EXECUTABLE_ROLE_ENTRYPOINT_PATH,
	MAC_CAMPAIGN_SCRATCH_ROOT_ENV,
	MAC_SIGNING_KEY_ENV,
	MAC_SUPERVISOR_UID_SEAM_ENV,
	MAC_SUPERVISOR_USER_ENV,
	observeMacClockIdentity,
	readStagedCohortMaterial,
	resolveStagedAuthorityDigest,
	RIG_BUN_PATH_ENV,
	RIG_SIGNING_KEY_ENV,
	rigTrustBootstrapPaths,
	runMacUidPreflight,
	sealArmsForCell,
	signedExecutionRunId,
	type StagedCohortMaterialV1,
} from "./compare-controller.ts";
import { readMacContinuousNs } from "./fanout-role.ts";
import {
	hashAddonManifest,
	mintStagedServerTlsIdentity,
} from "./stage-live-campaign.ts";

// ---------------------------------------------------------------------------
// The two topologies, the two passes, the bounds
// ---------------------------------------------------------------------------

export const PREFLIGHT_RECEIPT_SCHEMA =
	"fanout-physical-preflight-receipt/v1" as const;

/** The top row of each ladder (D4): what the preflight is allowed to run. */
export const PREFLIGHT_CELL_IDS = [
	"ticker-fanout/rate-250",
	"chat-fanout/subscribers-1000",
] as const;
export type PreflightCellId = (typeof PREFLIGHT_CELL_IDS)[number];

export const PREFLIGHT_PASSES = ["1x", "2x"] as const;
export type PreflightPass = (typeof PREFLIGHT_PASSES)[number];

/** D1's budget rule: main-thread cores at the binding load and at twice it. */
export const MAIN_THREAD_CORE_BOUND: Readonly<Record<PreflightPass, number>> = {
	"1x": 0.5,
	"2x": 0.8,
};

/** D4's operator precondition: both hosts idle at the start of a pass. */
export const OPERATOR_LOAD_BOUND = { mac: 4, rig: 0.5 } as const;

/** The preflight sampler's cadence; the warmup mean is integrated over it. */
export const SAMPLER_CADENCE_MS = 200;

/** `fanout-relay.ts` bounds every subscriber queue at this many items. */
export const RELAY_PER_SUBSCRIBER_QUEUE_CAP = 64;

export type PreflightTransport = "ws" | "wt";

export interface PreflightOfferPlan {
	readonly cellId: PreflightCellId;
	readonly cohortCell: string;
	readonly pass: PreflightPass;
	readonly publisherCount: number;
	readonly workerCount: number;
	readonly subscriberCount: number;
	readonly sessionCount: number;
	readonly windowCount: number;
	readonly measuredDurationMs: number;
	readonly messageBytes: number;
	/** The row's ingress per 1 s window: 250 (ticker), 10 (chat). */
	readonly rowIngressPerWindow: number;
	/** max(row, warmup epoch) per window: 250 (ticker), 20 (chat). */
	readonly bindingIngressPerWindow: number;
	/** What every origin window must show as accepted. */
	readonly requiredAcceptedPerWindow: number;
	readonly acceptedPredicate: "equals" | "at-least";
	/** The rate each publisher child is paced at. */
	readonly publisherRatePerSecond: number;
	readonly offeredIngressPerSecond: number;
	readonly pacingSource: "cell" | "preflight-input";
	/** The lease factory's preflight-only input; null at 1x. */
	readonly preflightPublisherRatePerSecond: number | null;
	readonly expectedWarmupDeliveries: number;
	readonly expectedWarmupIngress: number;
}

export function isPreflightCellId(value: string): value is PreflightCellId {
	return (PREFLIGHT_CELL_IDS as readonly string[]).includes(value);
}

export function isPreflightPass(value: string): value is PreflightPass {
	return (PREFLIGHT_PASSES as readonly string[]).includes(value);
}

/**
 * The offer the pass makes and the count it must show, from the cell table
 * and the warmup constants only. The 2x pass's rate is never the grant's.
 */
export function preflightOfferPlan(
	cellId: PreflightCellId,
	pass: PreflightPass,
): PreflightOfferPlan {
	const cohortCell = cohortCellForArm({ cellId, armKind: "primary" });
	if (cohortCell === null) {
		throw new RangeError(`${cellId} is not a fanout cohort cell`);
	}
	const cardinality = cohortCellCardinality(cohortCell);
	const grant = cohortCellGrantParameters(cohortCell);
	const windowCount = grant.measuredDurationMs / 1_000;
	const rowIngressPerWindow = cardinality.measuredIngress / windowCount;
	const warmupIngressPerSecond =
		(cardinality.publisherCount * WARMUP_MESSAGES_PER_PUBLISHER) /
		(WARMUP_DURATION_MS / 1_000);
	const bindingIngressPerWindow = Math.max(
		rowIngressPerWindow,
		warmupIngressPerSecond,
	);
	const cellRate = rowIngressPerWindow / cardinality.publisherCount;
	if (!Number.isSafeInteger(cellRate) || cellRate < 1) {
		throw new RangeError(
			`${cellId}: the cell's per-publisher rate is not whole`,
		);
	}
	if (pass === "1x") {
		return {
			cellId,
			cohortCell,
			pass,
			publisherCount: cardinality.publisherCount,
			workerCount: cardinality.workerCount,
			subscriberCount: cardinality.subscriberCount,
			sessionCount: cardinality.sessionCount,
			windowCount,
			measuredDurationMs: grant.measuredDurationMs,
			messageBytes: grant.messageBytes,
			rowIngressPerWindow,
			bindingIngressPerWindow,
			requiredAcceptedPerWindow: rowIngressPerWindow,
			acceptedPredicate: "equals",
			publisherRatePerSecond: cellRate,
			offeredIngressPerSecond: rowIngressPerWindow,
			pacingSource: "cell",
			preflightPublisherRatePerSecond: null,
			expectedWarmupDeliveries:
				WARMUP_MESSAGES_PER_PUBLISHER *
				cardinality.publisherCount *
				cardinality.subscriberCount,
			expectedWarmupIngress:
				WARMUP_MESSAGES_PER_PUBLISHER * cardinality.publisherCount,
		};
	}
	const required = 2 * bindingIngressPerWindow;
	const rate = required / cardinality.publisherCount;
	if (!Number.isSafeInteger(rate) || rate < 1) {
		throw new RangeError(
			`${cellId}: 2x binding ingress ${required} does not divide over ${cardinality.publisherCount} publishers`,
		);
	}
	return {
		cellId,
		cohortCell,
		pass,
		publisherCount: cardinality.publisherCount,
		workerCount: cardinality.workerCount,
		subscriberCount: cardinality.subscriberCount,
		sessionCount: cardinality.sessionCount,
		windowCount,
		measuredDurationMs: grant.measuredDurationMs,
		messageBytes: grant.messageBytes,
		rowIngressPerWindow,
		bindingIngressPerWindow,
		requiredAcceptedPerWindow: required,
		acceptedPredicate: "at-least",
		publisherRatePerSecond: rate,
		offeredIngressPerSecond: required,
		pacingSource: "preflight-input",
		preflightPublisherRatePerSecond: rate,
		expectedWarmupDeliveries:
			WARMUP_MESSAGES_PER_PUBLISHER *
			cardinality.publisherCount *
			cardinality.subscriberCount,
		expectedWarmupIngress:
			WARMUP_MESSAGES_PER_PUBLISHER * cardinality.publisherCount,
	};
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

export const PREFLIGHT_PREDICATES = [
	"OPERATOR_PRECONDITION",
	"LIFECYCLE_COMPLETE",
	"OFFERED_EQUALS_ACCEPTED",
	"ACCEPTED_PER_WINDOW",
	"DELIVERED_EQUALS_ACCEPTED_TIMES_K",
	"WARMUP_DELIVERIES",
	"ZERO_FAULTS",
	"MEASURED_MAIN_THREAD_CPU",
	"WARMUP_MAIN_THREAD_CPU",
	"CPU_SERIES_COVERED",
	"SERVER_CHILD_PID_MATCH",
] as const;
export type PreflightPredicate = (typeof PREFLIGHT_PREDICATES)[number];

export interface PredicateFailure {
	readonly predicate: PreflightPredicate;
	readonly detail: string;
}

export interface PreflightFaultCounts {
	readonly relayQueueDrops: number;
	readonly relayWriteTimeouts: number;
	readonly relayDisconnectUndelivered: number;
	readonly relayMalformedIngress: number;
	readonly relayDuplicateIngress: number;
	readonly relayReorderedIngress: number;
	readonly workerMalformed: number;
	readonly workerDuplicate: number;
	readonly workerReorder: number;
	readonly workerDisconnect: number;
}

export interface PreflightPredicateInput {
	readonly pass: PreflightPass;
	readonly windowCount: number;
	readonly subscriberCount: number;
	readonly requiredAcceptedPerWindow: number;
	readonly acceptedPredicate: "equals" | "at-least";
	readonly offeredByOriginWindow: readonly number[];
	readonly acceptedByOriginWindow: readonly number[];
	readonly deliveredByOriginWindow: readonly number[];
	readonly expectedWarmupDeliveries: number;
	readonly warmupMacDelivered: number | null;
	readonly faults: PreflightFaultCounts;
	readonly preconditionsOk: boolean;
	readonly preconditionDetail: string;
	readonly lifecycleCompleted: boolean;
	readonly lifecycleDetail: string;
	readonly measuredMainThreadCore: number | null;
	readonly warmupMainThreadCore: number | null;
	readonly warmupCpuCovered: boolean;
	/** What the sampler said on stderr; quoted when it produced no reading. */
	readonly samplerStderrTail: string;
	readonly samplerPid: number | null;
	readonly capturePid: number | null;
}

/**
 * D4's pass predicate, one failure per clause that does not hold. The count
 * clauses read origin windows; the CPU clauses read whole-interval means; a
 * lifecycle that did not reach the capture fails by name and the count
 * clauses are then reported as absent rather than as zeros that pass.
 */
export function evaluatePreflightPredicate(input: PreflightPredicateInput): {
	readonly verdict: "PASS" | "FAIL";
	readonly failures: readonly PredicateFailure[];
} {
	const failures: PredicateFailure[] = [];
	const fail = (predicate: PreflightPredicate, detail: string) => {
		failures.push({ predicate, detail });
	};
	if (!input.preconditionsOk) {
		fail("OPERATOR_PRECONDITION", input.preconditionDetail);
	}
	if (!input.lifecycleCompleted) {
		fail("LIFECYCLE_COMPLETE", input.lifecycleDetail);
	}
	const w = input.windowCount;
	const arraysComplete =
		input.offeredByOriginWindow.length === w &&
		input.acceptedByOriginWindow.length === w &&
		input.deliveredByOriginWindow.length === w;
	if (!arraysComplete) {
		const shape = `offered ${input.offeredByOriginWindow.length}, accepted ${input.acceptedByOriginWindow.length}, delivered ${input.deliveredByOriginWindow.length} of ${w} windows`;
		fail(
			"OFFERED_EQUALS_ACCEPTED",
			`no complete origin-window series: ${shape}`,
		);
		fail("ACCEPTED_PER_WINDOW", `no complete origin-window series: ${shape}`);
		fail(
			"DELIVERED_EQUALS_ACCEPTED_TIMES_K",
			`no complete origin-window series: ${shape}`,
		);
	} else {
		for (let i = 0; i < w; i += 1) {
			const offered = input.offeredByOriginWindow[i] as number;
			const accepted = input.acceptedByOriginWindow[i] as number;
			const delivered = input.deliveredByOriginWindow[i] as number;
			if (offered !== accepted) {
				fail(
					"OFFERED_EQUALS_ACCEPTED",
					`window ${i}: offered ${offered}, accepted ${accepted}`,
				);
			}
			const required = input.requiredAcceptedPerWindow;
			const holds =
				input.acceptedPredicate === "equals"
					? accepted === required
					: accepted >= required;
			if (!holds) {
				fail(
					"ACCEPTED_PER_WINDOW",
					`window ${i}: accepted ${accepted}, required ${input.acceptedPredicate === "equals" ? "=" : ">="} ${required}`,
				);
			}
			const owed = accepted * input.subscriberCount;
			if (delivered !== owed) {
				fail(
					"DELIVERED_EQUALS_ACCEPTED_TIMES_K",
					`window ${i}: workers delivered ${delivered}, accepted ${accepted} x K ${input.subscriberCount} = ${owed}`,
				);
			}
		}
	}
	if (input.warmupMacDelivered === null) {
		fail("WARMUP_DELIVERIES", "no warmup completion manifest was retained");
	} else if (input.warmupMacDelivered !== input.expectedWarmupDeliveries) {
		fail(
			"WARMUP_DELIVERIES",
			`workers delivered ${input.warmupMacDelivered} in the warmup epoch, expected ${input.expectedWarmupDeliveries}`,
		);
	}
	for (const [name, count] of Object.entries(input.faults)) {
		if (count !== 0) fail("ZERO_FAULTS", `${name} = ${count}`);
	}
	const bound = MAIN_THREAD_CORE_BOUND[input.pass];
	if (input.measuredMainThreadCore === null) {
		fail(
			"MEASURED_MAIN_THREAD_CPU",
			"the capture carried no attested serverChildCpu",
		);
	} else if (input.measuredMainThreadCore > bound) {
		fail(
			"MEASURED_MAIN_THREAD_CPU",
			`main thread ${input.measuredMainThreadCore.toFixed(3)} core over the measured window, bound ${bound.toFixed(2)} at ${input.pass}`,
		);
	}
	if (input.pass === "1x") {
		const samplerSaid =
			input.samplerStderrTail.trim().length === 0
				? ""
				: `; sampler stderr: ${JSON.stringify(input.samplerStderrTail.trim().slice(-400))}`;
		if (!input.warmupCpuCovered) {
			fail(
				"CPU_SERIES_COVERED",
				`the sampler did not cover the whole warmup epoch${samplerSaid}`,
			);
		}
		if (input.warmupMainThreadCore === null) {
			fail(
				"WARMUP_MAIN_THREAD_CPU",
				`no warmup-epoch main-thread reading${samplerSaid}`,
			);
		} else if (input.warmupMainThreadCore > bound) {
			fail(
				"WARMUP_MAIN_THREAD_CPU",
				`main thread ${input.warmupMainThreadCore.toFixed(3)} core over the warmup epoch, bound ${bound.toFixed(2)} at 1x`,
			);
		}
	}
	if (input.samplerPid === null || input.capturePid === null) {
		fail(
			"SERVER_CHILD_PID_MATCH",
			`sampled pid ${String(input.samplerPid)}, capture pid ${String(input.capturePid)}`,
		);
	} else if (input.samplerPid !== input.capturePid) {
		fail(
			"SERVER_CHILD_PID_MATCH",
			`the sampler followed pid ${input.samplerPid} but the capture names ${input.capturePid}`,
		);
	}
	return { verdict: failures.length === 0 ? "PASS" : "FAIL", failures };
}

// ---------------------------------------------------------------------------
// The receipt
// ---------------------------------------------------------------------------

export interface PreflightCpuInterval {
	readonly instrument: string;
	readonly processMs: number | null;
	readonly mainThreadMs: number | null;
	readonly intervalMs: number | null;
	readonly processCore: number | null;
	readonly mainThreadCore: number | null;
	readonly bound: number | null;
	readonly sampleCount: number | null;
	readonly covered: boolean;
}

export interface PreflightReceiptV1 {
	readonly schema: typeof PREFLIGHT_RECEIPT_SCHEMA;
	readonly candidate: string;
	readonly campaignId: string;
	readonly mode: "physical" | "loopback";
	readonly transport: PreflightTransport;
	readonly cellId: PreflightCellId;
	readonly cohortCell: string;
	readonly pass: PreflightPass;
	readonly runId: string;
	readonly generatedAtMs: number;
	readonly macClockId: string | null;
	readonly topology: {
		readonly publisherCount: number;
		readonly workerCount: number;
		readonly subscriberCount: number;
		readonly sessionCount: number;
		readonly windowCount: number;
		readonly measuredDurationMs: number;
		readonly messageBytes: number;
	};
	readonly offer: {
		readonly pacingSource: "cell" | "preflight-input";
		readonly publisherRatePerSecond: number;
		readonly offeredIngressPerSecond: number;
		readonly rowIngressPerWindow: number;
		readonly bindingIngressPerWindow: number;
		readonly requiredAcceptedPerWindow: number;
		readonly acceptedPredicate: "equals" | "at-least";
	};
	readonly preconditions: {
		readonly macLoad1: number;
		readonly macLoadBound: number;
		readonly rigLoad1: number | null;
		readonly rigLoadBound: number;
		readonly rigIsThisHost: boolean;
		/** False only under `--loopback --ignore-load`: the loads are recorded, not gated. */
		readonly enforced: boolean;
		readonly failures: readonly string[];
		readonly ok: boolean;
	};
	readonly lifecycle: {
		readonly completed: boolean;
		readonly dispatchOk: boolean;
		readonly failureCode: string | null;
		readonly reason: string | null;
		readonly sealedPath: string | null;
	};
	readonly windows: {
		readonly note: string;
		readonly offeredByOriginWindow: readonly number[];
		readonly acceptedByOriginWindow: readonly number[];
		readonly deliveredByOriginWindow: readonly number[];
		readonly relayWritesCompletedByOriginWindow: readonly number[];
	};
	readonly totals: {
		readonly offered: number;
		readonly accepted: number;
		readonly delivered: number;
		readonly deliveredBytes: number;
		readonly expectedDelivered: number;
		readonly ingressRefusals: number;
	};
	readonly warmup: {
		readonly epochMs: number;
		readonly expectedIngress: number;
		readonly expectedDeliveries: number;
		readonly macOffered: number | null;
		readonly macDelivered: number | null;
		readonly relayIngress: number | null;
		readonly relayDeliveries: number | null;
	};
	readonly faults: PreflightFaultCounts;
	readonly queue: {
		readonly relayQueueItemsPeak: number | null;
		readonly relayQueueBytesPeak: number | null;
		readonly perSubscriberCap: number;
		readonly note: string;
	};
	readonly relayBusy: {
		readonly instrument: string;
		readonly busyMs: number | null;
		readonly windowMs: number | null;
		readonly fraction: number | null;
	};
	readonly serverChildCpu: {
		readonly measured: PreflightCpuInterval;
		readonly warmup: PreflightCpuInterval;
		readonly perSecondNote: string;
		readonly perSecondMainThreadCore: readonly number[] | null;
		readonly perSecondMainThreadCoreMax: number | null;
		readonly sampler: {
			readonly instrument: string;
			readonly cadenceMs: number;
			readonly sampleCount: number;
			readonly stderrTail: string;
			readonly pid: number | null;
			readonly capturePid: number | null;
			readonly pidMatchesCapture: boolean;
		};
	};
	readonly rig: {
		readonly coreMhz: {
			readonly warmupStart: readonly number[] | null;
			readonly warmupEnd: readonly number[] | null;
			readonly measureStart: readonly number[] | null;
			readonly measureStop: readonly number[] | null;
		};
		readonly rssKb: {
			readonly warmupStart: number | null;
			readonly measureStop: number | null;
			readonly peak: number | null;
		};
		readonly nofile: {
			readonly soft: number | null;
			readonly hard: number | null;
		} | null;
	};
	readonly mac: {
		readonly load1AtStart: number;
		readonly load1Peak: number | null;
		readonly workers: readonly {
			readonly childId: string;
			readonly workerIndex: number;
			readonly pid: number;
			readonly cpuMsOverMeasuredWindow: number | null;
			readonly cpuCore: number | null;
		}[];
	};
	readonly verdict: "PASS" | "FAIL";
	readonly failedPredicates: readonly PredicateFailure[];
}

export const PREFLIGHT_RECEIPT_KEYS: readonly string[] = [
	"campaignId",
	"candidate",
	"cellId",
	"cohortCell",
	"failedPredicates",
	"faults",
	"generatedAtMs",
	"lifecycle",
	"mac",
	"macClockId",
	"mode",
	"offer",
	"pass",
	"preconditions",
	"queue",
	"relayBusy",
	"rig",
	"runId",
	"schema",
	"serverChildCpu",
	"topology",
	"totals",
	"transport",
	"verdict",
	"warmup",
	"windows",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCountArray(value: unknown, length: number): value is number[] {
	return (
		Array.isArray(value) &&
		value.length === length &&
		value.every((item) => isNonNegInt(item))
	);
}

function receiptFail(message: string): ProtocolResult<never> {
	return { ok: false, code: "PREFLIGHT_RECEIPT_INVALID", message };
}

/**
 * The receipt's own shape: every D4 field present, the count series the
 * cell's length, the verdict agreeing with the failure list, every failure
 * naming a predicate from the closed set.
 */
export function parsePreflightReceipt(
	value: unknown,
): ProtocolResult<PreflightReceiptV1> {
	if (!isRecord(value)) return receiptFail("receipt is not an object");
	const keys = Object.keys(value).sort();
	if (
		keys.length !== PREFLIGHT_RECEIPT_KEYS.length ||
		keys.some((key, index) => key !== PREFLIGHT_RECEIPT_KEYS[index])
	) {
		return receiptFail(`receipt keys [${keys.join(",")}]`);
	}
	if (value.schema !== PREFLIGHT_RECEIPT_SCHEMA) {
		return receiptFail("receipt schema");
	}
	if (typeof value.candidate !== "string" || value.candidate.length === 0) {
		return receiptFail("candidate");
	}
	if (value.mode !== "physical" && value.mode !== "loopback") {
		return receiptFail("mode");
	}
	if (value.transport !== "ws" && value.transport !== "wt") {
		return receiptFail("transport");
	}
	if (typeof value.cellId !== "string" || !isPreflightCellId(value.cellId)) {
		return receiptFail("cellId");
	}
	if (typeof value.pass !== "string" || !isPreflightPass(value.pass)) {
		return receiptFail("pass");
	}
	const topology = value.topology;
	if (!isRecord(topology) || !isNonNegInt(topology.windowCount)) {
		return receiptFail("topology.windowCount");
	}
	const plan = preflightOfferPlan(value.cellId, value.pass);
	if (topology.windowCount !== plan.windowCount) {
		return receiptFail("topology.windowCount is not the cell's");
	}
	const offer = value.offer;
	if (
		!isRecord(offer) ||
		offer.requiredAcceptedPerWindow !== plan.requiredAcceptedPerWindow ||
		offer.acceptedPredicate !== plan.acceptedPredicate ||
		offer.publisherRatePerSecond !== plan.publisherRatePerSecond ||
		offer.pacingSource !== plan.pacingSource
	) {
		return receiptFail("offer does not restate the pass's plan");
	}
	const windows = value.windows;
	if (
		!isRecord(windows) ||
		!isCountArray(windows.offeredByOriginWindow, plan.windowCount) ||
		!isCountArray(windows.acceptedByOriginWindow, plan.windowCount) ||
		!isCountArray(windows.deliveredByOriginWindow, plan.windowCount)
	) {
		return receiptFail("windows: origin-window series of the cell's length");
	}
	const cpu = value.serverChildCpu;
	if (
		!isRecord(cpu) ||
		!isRecord(cpu.measured) ||
		!isRecord(cpu.warmup) ||
		!isRecord(cpu.sampler) ||
		typeof cpu.measured.instrument !== "string" ||
		typeof cpu.warmup.instrument !== "string" ||
		typeof cpu.sampler.instrument !== "string"
	) {
		return receiptFail("serverChildCpu names its instruments");
	}
	if (value.verdict !== "PASS" && value.verdict !== "FAIL") {
		return receiptFail("verdict");
	}
	const failed = value.failedPredicates;
	if (!Array.isArray(failed)) return receiptFail("failedPredicates");
	for (const entry of failed) {
		if (
			!isRecord(entry) ||
			typeof entry.predicate !== "string" ||
			!(PREFLIGHT_PREDICATES as readonly string[]).includes(entry.predicate) ||
			typeof entry.detail !== "string"
		) {
			return receiptFail("failedPredicates entry");
		}
	}
	if ((value.verdict === "PASS") !== (failed.length === 0)) {
		return receiptFail("verdict does not agree with failedPredicates");
	}
	return { ok: true, value: value as unknown as PreflightReceiptV1 };
}

export function cellIdSlug(cellId: string): string {
	return cellId.replace(/[/:]/g, "_");
}

/** `<out>/<candidate>/<transport>-<cell>-<pass>.json`, the D4 path. */
export function preflightReceiptPath(args: {
	readonly outDir: string;
	readonly candidate: string;
	readonly transport: PreflightTransport;
	readonly cellId: string;
	readonly pass: PreflightPass;
}): string {
	return join(
		args.outDir,
		args.candidate,
		`${args.transport}-${cellIdSlug(args.cellId)}-${args.pass}.json`,
	);
}

// ---------------------------------------------------------------------------
// Sampler parsing and integration (pure)
// ---------------------------------------------------------------------------

/** One reading of the server child, stamped when it reached the Mac. */
export interface CpuSample {
	readonly atMacNs: bigint;
	readonly processMs: number;
	readonly mainThreadMs: number;
	readonly rssKb: number | null;
	readonly load1: number | null;
	readonly coreMhz: readonly number[] | null;
}

/** utime + stime of a `/proc/<pid>/stat` or `/proc/<pid>/task/<tid>/stat` line, in clock ticks. */
export function parseProcStatCpuTicks(line: string): number | null {
	const close = line.lastIndexOf(")");
	if (close < 0) return null;
	const fields = line
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	// After the comm: state ppid pgrp session tty tpgid flags minflt cminflt
	// majflt cmajflt utime stime ...
	const utime = Number.parseInt(fields[11] ?? "", 10);
	const stime = Number.parseInt(fields[12] ?? "", 10);
	if (!Number.isSafeInteger(utime) || !Number.isSafeInteger(stime)) return null;
	return utime + stime;
}

/** `[[dd-]hh:]mm:ss[.cc]` as `ps` prints cputime, to milliseconds. */
export function parsePsCpuTime(token: string): number | null {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)(?:\.(\d+))?$/.exec(
		token.trim(),
	);
	if (match === null) return null;
	const days = Number.parseInt(match[1] ?? "0", 10);
	const hours = Number.parseInt(match[2] ?? "0", 10);
	const minutes = Number.parseInt(match[3] ?? "0", 10);
	const seconds = Number.parseInt(match[4] ?? "0", 10);
	const fraction = match[5] ?? "";
	const fractionMs =
		fraction.length === 0
			? 0
			: Math.round(
					(Number.parseInt(fraction, 10) / 10 ** fraction.length) * 1000,
				);
	return (
		(((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000 + fractionMs
	);
}

/**
 * `ps -M -p <pid>` on Darwin: one line per thread, the first the thread the
 * process was created with, each carrying STIME and UTIME columns.
 */
export function parseDarwinPsThreads(
	text: string,
): { readonly processMs: number; readonly mainThreadMs: number } | null {
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length < 2) return null;
	let processMs = 0;
	let mainThreadMs: number | null = null;
	for (const line of lines.slice(1)) {
		const times = line.match(/(?:\d+-)?(?:\d+:)?\d+:\d+(?:\.\d+)?/g);
		if (times === null || times.length < 2) continue;
		const stime = parsePsCpuTime(times[0] as string);
		const utime = parsePsCpuTime(times[1] as string);
		if (stime === null || utime === null) continue;
		processMs += stime + utime;
		if (mainThreadMs === null) mainThreadMs = stime + utime;
	}
	if (mainThreadMs === null) return null;
	return { processMs, mainThreadMs };
}

function interpolate(
	samples: readonly CpuSample[],
	pick: (sample: CpuSample) => number,
	atNs: bigint,
): number {
	const first = samples[0] as CpuSample;
	const last = samples[samples.length - 1] as CpuSample;
	if (atNs <= first.atMacNs) return pick(first);
	if (atNs >= last.atMacNs) return pick(last);
	for (let i = 1; i < samples.length; i += 1) {
		const right = samples[i] as CpuSample;
		if (right.atMacNs < atNs) continue;
		const left = samples[i - 1] as CpuSample;
		const span = Number(right.atMacNs - left.atMacNs);
		if (span <= 0) return pick(right);
		const t = Number(atNs - left.atMacNs) / span;
		return pick(left) + (pick(right) - pick(left)) * t;
	}
	return pick(last);
}

/**
 * The mean core a cumulative counter (CPU milliseconds) spent between two
 * instants, from samples that bracket them: linear interpolation to the
 * boundaries, and `covered` false when the series starts after or ends before
 * an instant by more than the tolerance.
 */
export function cpuCoreOverInterval(
	samples: readonly CpuSample[],
	startNs: bigint,
	endNs: bigint,
	toleranceNs: bigint,
): {
	readonly processMs: number | null;
	readonly mainThreadMs: number | null;
	readonly intervalMs: number;
	readonly processCore: number | null;
	readonly mainThreadCore: number | null;
	readonly sampleCount: number;
	readonly covered: boolean;
} {
	const intervalMs = Number(endNs - startNs) / 1e6;
	const inside = samples.filter(
		(sample) => sample.atMacNs >= startNs && sample.atMacNs <= endNs,
	);
	if (samples.length < 2 || intervalMs <= 0) {
		return {
			processMs: null,
			mainThreadMs: null,
			intervalMs,
			processCore: null,
			mainThreadCore: null,
			sampleCount: inside.length,
			covered: false,
		};
	}
	const first = samples[0] as CpuSample;
	const last = samples[samples.length - 1] as CpuSample;
	const covered =
		first.atMacNs <= startNs + toleranceNs &&
		last.atMacNs >= endNs - toleranceNs;
	const processMs =
		interpolate(samples, (s) => s.processMs, endNs) -
		interpolate(samples, (s) => s.processMs, startNs);
	const mainThreadMs =
		interpolate(samples, (s) => s.mainThreadMs, endNs) -
		interpolate(samples, (s) => s.mainThreadMs, startNs);
	return {
		processMs,
		mainThreadMs,
		intervalMs,
		processCore: processMs / intervalMs,
		mainThreadCore: mainThreadMs / intervalMs,
		sampleCount: inside.length,
		covered,
	};
}

/** The nearest sample at or before `atNs`, or the first after it. */
function sampleNear(
	samples: readonly CpuSample[],
	atNs: bigint,
): CpuSample | null {
	let best: CpuSample | null = null;
	for (const sample of samples) {
		if (sample.atMacNs <= atNs) best = sample;
		else {
			if (best === null) best = sample;
			break;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export class PreflightUsageError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

export interface PreflightArgs {
	readonly transport: PreflightTransport;
	readonly cellId: PreflightCellId;
	readonly pass: PreflightPass;
	readonly outDir: string;
	readonly loopback: boolean;
	readonly rig: string | null;
	readonly sshKey: string | null;
	readonly candidate: string | null;
	readonly stagedDir: string | null;
	readonly supervisorBinary: string | null;
	/** Loopback only: record the operator loads without gating on them. */
	readonly ignoreLoad: boolean;
	readonly help: boolean;
}

export const PREFLIGHT_USAGE = `usage:
  bun tools/compare/bin/fanout-physical-preflight.ts \\
      --transport ws|wt --cell <cell-id> --pass 1x|2x --out <preflight-root> \\
      --rig <user@host> --ssh-key <path> --candidate <sha> --staged-dir <mac staged dir>
  bun tools/compare/bin/fanout-physical-preflight.ts \\
      --transport ws|wt --cell <cell-id> --pass 1x|2x --out <dir> --loopback [--supervisor-binary <path>] [--ignore-load]

cells: ${PREFLIGHT_CELL_IDS.join(", ")}

The physical mode reads the rig install from the frozen run command's variables:
  ${RIG_SIGNING_KEY_ENV}, ${RIG_BUN_PATH_ENV}, COMPARISON_RIG_STAGED_DIR,
  COMPARISON_RIG_SUPERVISOR_BINARY, ${MAC_SIGNING_KEY_ENV},
  COMPARISON_SUPERVISOR_BINARY, COMPARISON_SUPERVISOR_BUN_PATH.
The receipt lands at <out>/<candidate>/<transport>-<cell>-<pass>.json.
`;

export function parsePreflightArgs(argv: readonly string[]): PreflightArgs {
	const values = new Map<string, string>();
	let loopback = false;
	let ignoreLoad = false;
	let help = false;
	const valued = new Set([
		"transport",
		"cell",
		"pass",
		"out",
		"rig",
		"ssh-key",
		"candidate",
		"staged-dir",
		"supervisor-binary",
	]);
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] as string;
		if (token === "--help" || token === "-h") {
			help = true;
			continue;
		}
		if (token === "--loopback") {
			loopback = true;
			continue;
		}
		if (token === "--ignore-load") {
			ignoreLoad = true;
			continue;
		}
		if (!token.startsWith("--")) {
			throw new PreflightUsageError("USAGE", `unexpected argument ${token}`);
		}
		const eq = token.indexOf("=");
		const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
		if (!valued.has(name)) {
			throw new PreflightUsageError("USAGE", `unknown flag --${name}`);
		}
		let value: string | undefined;
		if (eq >= 0) value = token.slice(eq + 1);
		else {
			value = argv[i + 1];
			i += 1;
		}
		if (value === undefined || value.length === 0 || value.startsWith("--")) {
			throw new PreflightUsageError("USAGE", `--${name} needs a value`);
		}
		if (values.has(name)) {
			throw new PreflightUsageError("USAGE", `--${name} given twice`);
		}
		values.set(name, value);
	}
	if (help) {
		return {
			transport: "ws",
			cellId: PREFLIGHT_CELL_IDS[0],
			pass: "1x",
			outDir: "",
			loopback,
			rig: null,
			sshKey: null,
			candidate: null,
			stagedDir: null,
			supervisorBinary: null,
			ignoreLoad,
			help: true,
		};
	}
	const transport = values.get("transport");
	if (transport !== "ws" && transport !== "wt") {
		throw new PreflightUsageError("USAGE", "--transport must be ws or wt");
	}
	const cellId = values.get("cell");
	if (cellId === undefined || !isPreflightCellId(cellId)) {
		throw new PreflightUsageError(
			"USAGE",
			`--cell must be one of ${PREFLIGHT_CELL_IDS.join(", ")}`,
		);
	}
	const pass = values.get("pass");
	if (pass === undefined || !isPreflightPass(pass)) {
		throw new PreflightUsageError("USAGE", "--pass must be 1x or 2x");
	}
	const outDir = values.get("out");
	if (outDir === undefined) {
		throw new PreflightUsageError("USAGE", "--out is required");
	}
	const rig = values.get("rig") ?? null;
	const sshKey = values.get("ssh-key") ?? null;
	const candidate = values.get("candidate") ?? null;
	const stagedDir = values.get("staged-dir") ?? null;
	if (loopback) {
		if (rig !== null || sshKey !== null || stagedDir !== null) {
			throw new PreflightUsageError(
				"USAGE",
				"--loopback stages its own pair on this host; --rig, --ssh-key and --staged-dir do not apply",
			);
		}
	} else {
		if (ignoreLoad) {
			throw new PreflightUsageError(
				"USAGE",
				"--ignore-load is a loopback smoke option; the physical preflight gates on both hosts' load",
			);
		}
		if (
			rig === null ||
			sshKey === null ||
			candidate === null ||
			stagedDir === null
		) {
			throw new PreflightUsageError(
				"USAGE",
				"the physical mode needs --rig, --ssh-key, --candidate and --staged-dir",
			);
		}
		if (!/^[^@\s]+@[^@\s]+$/.test(rig)) {
			throw new PreflightUsageError("USAGE", "--rig must be user@host");
		}
		if (!/^[0-9a-f]{40}$/.test(candidate)) {
			throw new PreflightUsageError(
				"USAGE",
				"--candidate must be the 40-hex candidate commit",
			);
		}
	}
	return {
		transport,
		cellId,
		pass,
		outDir: resolve(outDir),
		loopback,
		rig,
		sshKey: sshKey === null ? null : resolve(sshKey),
		candidate,
		stagedDir: stagedDir === null ? null : resolve(stagedDir),
		supervisorBinary:
			values.get("supervisor-binary") === undefined
				? null
				: resolve(values.get("supervisor-binary") as string),
		ignoreLoad,
		help: false,
	};
}

// ---------------------------------------------------------------------------
// The two ways to reach a staged pair
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const REPO_TOOLS = join(REPO_ROOT, "tools", "compare");

interface RigSsh {
	readonly target: string;
	readonly identity: string;
}

function sshArgv(rig: RigSsh, tail: readonly string[]): string[] {
	return [
		"ssh",
		"-i",
		rig.identity,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ConnectTimeout=10",
		"-T",
		rig.target,
		"--",
		...tail,
	];
}

async function sshExec(
	rig: RigSsh,
	command: string,
	deadlineMs: number,
): Promise<{
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
}> {
	const proc = Bun.spawn(sshArgv(rig, [command]), {
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(() => {
		try {
			proc.kill("SIGKILL");
		} catch {
			// the child may be gone already
		}
	}, deadlineMs);
	const code = await proc.exited;
	clearTimeout(timer);
	return {
		ok: code === 0,
		stdout: await new Response(proc.stdout).text(),
		stderr: await new Response(proc.stderr).text(),
	};
}

/** What both modes hand the run: supervisors, material, and how to sample. */
interface PreflightPair {
	readonly mode: "physical" | "loopback";
	readonly staged: StagedCohortMaterialV1;
	readonly bootstrap: StagedTrustBootstrapPaths;
	readonly macSupervisor: SupervisorHandle;
	readonly rigSupervisor: SupervisorHandle;
	readonly serverPort: number;
	readonly toolchains: ToolchainSet;
	readonly bunExecutablePath: string;
	readonly macClockId: string;
	readonly runtimeRoot: string;
	readonly rigIsThisHost: boolean;
	readonly rigSsh: RigSsh | null;
	readonly cleanup: () => Promise<void>;
}

function chooseLocalAcceptanceServerPort(): number {
	return 44_000 + Math.floor(Math.random() * 1_000);
}

function hostOwnsAdvertisedServerHost(host: string): ProtocolResult<true> {
	try {
		const listener = Bun.listen({
			hostname: host,
			port: 0,
			socket: { data() {} },
		});
		listener.stop(true);
		return { ok: true, value: true };
	} catch (error) {
		return {
			ok: false,
			code: "COHORT_NOT_READY",
			message: `this host does not own ${host} (${(error as Error).message})`,
		};
	}
}

function mintFixtureTrustBootstrap(
	stagedDir: string,
	observerBinary: string,
): void {
	const minted = Bun.spawnSync({
		cmd: [
			process.execPath,
			join(REPO_TOOLS, "bin", "mint-live-trust-bootstrap.ts"),
			"--fixture-only",
			`--out=${stagedDir}`,
		],
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, OBSERVE_DIRECTORY_IDENTITY_BINARY: observerBinary },
	});
	if (minted.exitCode !== 0) {
		throw new Error(
			`mint-live-trust-bootstrap failed (${minted.exitCode}): ${minted.stderr.toString()}`,
		);
	}
}

/**
 * The local acceptance pair: one host, loopback, the fixture authority, the
 * tier-B uid seam -- laid out the way `stage-live-campaign.ts` lays a pair
 * out for two hosts and read back through the same calls `realRun` makes.
 */
async function stageLoopbackPair(args: {
	readonly supervisorBinary: string;
}): Promise<PreflightPair> {
	const owns = hostOwnsAdvertisedServerHost(
		COHORT_LOCAL_ACCEPTANCE_SERVER_HOST,
	);
	if (!owns.ok) throw new Error(owns.message);
	const root = mkdtempSync(join(tmpdir(), "fanout-preflight-pair-"));
	const stagedDir = join(root, "staged");
	const stagingRoot = join(stagedDir, TRUST_BOOTSTRAP_STAGING_ROOT);
	const campaignRoot = join(stagedDir, TRUST_BOOTSTRAP_CAMPAIGN_ROOT);
	const rolesDir = join(stagedDir, "roles");
	const scratchRoot = join(root, "scratch");
	for (const dir of [
		stagedDir,
		stagingRoot,
		campaignRoot,
		rolesDir,
		scratchRoot,
	]) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}
	const mac = generateEd25519KeyPair();
	const rig = generateEd25519KeyPair();
	const macKeyPath = join(scratchRoot, "mac-supervisor.pk8");
	const rigKeyPath = join(scratchRoot, "rig-supervisor.pk8");
	writeFileSync(macKeyPath, mac.privatePkcs8Der, { mode: 0o400 });
	writeFileSync(rigKeyPath, rig.privatePkcs8Der, { mode: 0o400 });
	writeFileSync(
		join(stagingRoot, "mac-supervisor-ed25519.pub"),
		mac.publicRaw32,
		{
			mode: 0o644,
		},
	);
	writeFileSync(
		join(stagingRoot, "rig-supervisor-ed25519.pub"),
		rig.publicRaw32,
		{
			mode: 0o644,
		},
	);
	const tls = mintStagedServerTlsIdentity({
		outDir: join(root, "tls"),
		validDays: 1,
		profile: "local-acceptance",
	});
	const certificate = readFileSync(tls.certPath);
	const privateKey = readFileSync(tls.keyPath);
	writeFileSync(
		join(stagingRoot, STAGED_SERVER_TLS_CERTIFICATE_LEAF),
		certificate,
		{
			mode: 0o644,
		},
	);
	writeFileSync(
		join(stagingRoot, STAGED_SERVER_TLS_PRIVATE_KEY_LEAF),
		privateKey,
		{
			mode: 0o600,
		},
	);
	const tlsCertificateSha256 = sha256HexOfBytes(certificate);
	const tlsPrivateKeySha256 = sha256HexOfBytes(privateKey);
	const serverEntrypointSha256 = sha256HexOfBytes(
		readFileSync(join(REPO_TOOLS, "server.ts")),
	);
	const roleSource = readFileSync(EXECUTABLE_ROLE_ENTRYPOINT_PATH);
	const fanoutRoleEntrypointSha256 = sha256HexOfBytes(roleSource);
	writeFileSync(join(rolesDir, "fanout-role.ts"), roleSource, { mode: 0o644 });
	const bunSha256 = sha256HexOfBytes(readFileSync(process.execPath));
	const addonSha256 = hashAddonManifest(
		join(REPO_ROOT, "packages", "webtransport", "prebuilds"),
	);
	const serverPort = chooseLocalAcceptanceServerPort();
	const launchSha256 = {} as Record<"ws" | "wt", Record<string, Sha256Hex>>;
	for (const transport of ["ws", "wt"] as const) {
		launchSha256[transport] = {};
		for (const mode of stagedServerLaunchModesForProfile("local-acceptance")) {
			const bytes = canonicalRecordBytes(
				buildStagedServerLaunchRecord({
					profile: "local-acceptance",
					transport,
					mode,
					serverEntrypointSha256,
					bunSha256,
					addonSha256,
					bindPort: serverPort,
					tlsCertificateSha256,
					tlsPrivateKeySha256,
				}),
			);
			writeFileSync(
				join(stagingRoot, stagedServerLaunchRecordLeaf(transport, mode)),
				bytes,
				{ mode: 0o644 },
			);
			launchSha256[transport][mode] = sha256HexOfBytes(bytes);
		}
	}
	mintFixtureTrustBootstrap(
		stagedDir,
		join(dirname(args.supervisorBinary), "observe-directory-identity"),
	);
	const bootstrapReceipt = JSON.parse(
		readFileSync(join(stagedDir, "live-bootstrap-receipt.json"), "utf8"),
	) as { readonly authoritySha256: string; readonly capabilitySha256: string };
	const receipt = {
		schema: "live-stage-receipt/v1",
		stageProfile: "local-acceptance",
		cohortServerHost: COHORT_LOCAL_ACCEPTANCE_SERVER_HOST,
		rigRoleRootPath: REPO_TOOLS,
		candidate: R1_CANDIDATE_ID,
		campaignId: R1_CAMPAIGN_ID,
		authoritySha256: bootstrapReceipt.authoritySha256,
		approvedPlanSha256: R1_AUTHORITY_APPROVAL.approvedPlanSha256,
		approvalRecordSha256: R1_AUTHORITY_APPROVAL.approvalRecordSha256,
		archiveSha256: R1_SOURCE_ARCHIVE_RECEIPT.sourceArchiveSha256,
		capabilitySha256: bootstrapReceipt.capabilitySha256,
		macSigningPublicKeySha256: mac.publicKeySha256,
		rigSigningPublicKeySha256: rig.publicKeySha256,
		macBunSha256: bunSha256,
		linuxBunSha256: bunSha256,
		linuxAddonManifestSha256: addonSha256,
		serverEntrypointSha256,
		fanoutRoleEntrypointSha256,
		stagedServerLaunchRecordSha256ByLaunch: launchSha256,
		tlsCertificateSha256,
		notAfterMs: Date.now() + 71 * 60 * 60 * 1_000,
	};
	writeFileSync(
		join(stagedDir, "stage-receipt.json"),
		canonicalRecordBytes(receipt),
		{
			mode: 0o444,
		},
	);
	const verified = verifyStagedTrustBootstrap(
		stagedDir,
		resolveStagedAuthorityDigest(stagedDir),
	);
	if (!verified.ok) {
		throw new Error(
			`staged-dir verify failed (${verified.code}): ${verified.message}`,
		);
	}
	const material = readStagedCohortMaterial(verified.paths);
	if (!material.ok) throw new Error(`stage material: ${material.message}`);

	// The Mac signer under the tier-B seam: the variable and a key inside the
	// scratch root, exactly the local acceptance's two conditions.
	process.env[MAC_SUPERVISOR_UID_SEAM_ENV] = "1";
	const macSpawned = await spawnMacSupervisor({
		binaryPath: args.supervisorBinary,
		bunExecutablePath: process.execPath,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		localPaths: {
			authorityFile: verified.paths.authorityFile,
			authorityDigestFile: verified.paths.authorityDigestFile,
			campaignRootDir: verified.paths.campaignRootDir,
			stagingRootDir: verified.paths.stagingRootDir,
		},
		cohort: {
			macSigningKey: { fd: 7, label: "mac-signing-key", path: macKeyPath },
			stagedRigPublicKey: {
				fd: 8,
				label: "staged-rig-public-key",
				path: join(verified.paths.stagingRootDir, "rig-supervisor-ed25519.pub"),
			},
			receiptValidityMs: COHORT_RECEIPT_VALIDITY_MS,
		},
		controllerUidSeam: { campaignScratchRoot: scratchRoot },
	});
	if (!macSpawned.ok) {
		throw new Error(
			`spawnMacSupervisor refused (${macSpawned.code}): ${macSpawned.message}`,
		);
	}

	// The rig on this host: the production wrapper, exec'd here instead of on
	// the far side of ssh.
	const wrapper = buildRigSupervisorWrapperScript({
		binaryPath: args.supervisorBinary,
		bunExecutablePath: process.execPath,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		rigBinaryPath: args.supervisorBinary,
		rigPaths: {
			authorityFile: verified.paths.authorityFile,
			authorityDigestFile: verified.paths.authorityDigestFile,
			campaignRootDir: verified.paths.campaignRootDir,
			stagingRootDir: verified.paths.stagingRootDir,
		},
		rigCohort: {
			signingKey: { fd: 7, label: "cohort-signing-key", path: rigKeyPath },
			roleRoot: {
				fd: 10,
				label: "cohort-role-root",
				path: material.value.receipt.rigRoleRootPath,
			},
		},
	});
	if (!wrapper.ok) {
		throw new Error(
			`rig wrapper refused (${wrapper.code}): ${wrapper.message}`,
		);
	}
	const rigChild = nodeSpawn("/bin/bash", ["-c", wrapper.script], {
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	rigChild.stderr?.on("data", (chunk: Buffer) => {
		process.stderr.write(`[rig] ${chunk.toString("utf8")}`);
	});
	const rigPid = rigChild.pid as number;
	const rigExited = new Promise<number>((done) => {
		rigChild.on("exit", (code, signal) => done(code ?? (signal ? 128 : -1)));
	});
	const rigSupervisor: SupervisorHandle = {
		pid: rigPid,
		pgid: processGroupIdOf(rigPid),
		host: "rig",
		subprocess: {
			pid: rigPid,
			get exitCode() {
				return rigChild.exitCode;
			},
			kill: (signal?: NodeJS.Signals | number) => rigChild.kill(signal),
			exited: rigExited,
		},
		bootstrapFds: [],
		controlParentFds: [],
		controllerToSupervisor: rigChild.stdin as NonNullable<
			typeof rigChild.stdin
		>,
		supervisorToController: rigChild.stdout as NonNullable<
			typeof rigChild.stdout
		>,
	};
	const local = await observeLocalToolchain();
	const identity = toolchainIdentity(local);
	const toolchains: ToolchainSet = {
		js: { identity, sha256: local.bunExecutableSha256 },
		darwin: { identity, sha256: local.bunExecutableSha256 },
		linux: { identity, sha256: local.bunExecutableSha256 },
	};
	const macClockId = observeMacClockIdentity();
	if (!macClockId.ok) throw new Error(macClockId.message);
	const runtimeRoot = mkdtempSync(join(tmpdir(), "fanout-preflight-runtime-"));
	return {
		mode: "loopback",
		staged: material.value,
		bootstrap: verified.paths,
		macSupervisor: macSpawned.handle,
		rigSupervisor,
		serverPort,
		toolchains,
		bunExecutablePath: process.execPath,
		macClockId: macClockId.value,
		runtimeRoot,
		rigIsThisHost: true,
		rigSsh: null,
		cleanup: async () => {
			await stopSupervisor(rigSupervisor, 5_000);
			await stopSupervisor(macSpawned.handle, 5_000);
			rmSync(runtimeRoot, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		},
	};
}

/**
 * The staged pair on the two campaign hosts, opened the way `realRun` opens
 * it: the Mac's verified staged dir, the Mac signer under the tier-A crossing
 * (or the seam when the operator names it), the rig supervisor over ssh from
 * the frozen run command's variables.
 */
async function openPhysicalPair(args: {
	readonly stagedDir: string;
	readonly rig: string;
	readonly sshKey: string;
	readonly candidate: string;
	readonly supervisorBinary: string | null;
}): Promise<PreflightPair> {
	const expectedAuthority = resolveStagedAuthorityDigest(args.stagedDir);
	const verified = verifyStagedTrustBootstrap(
		args.stagedDir,
		expectedAuthority,
	);
	if (!verified.ok) {
		throw new Error(
			`staged-dir verify failed (${verified.code}): ${verified.message}`,
		);
	}
	const binary =
		args.supervisorBinary === null
			? resolveSupervisorBinaryPath()
			: { ok: true as const, path: args.supervisorBinary };
	if (!binary.ok) throw new Error(binary.message);
	const bunPath = resolveSupervisorBunPath();
	if (!bunPath.ok) throw new Error(bunPath.message);
	const material = readStagedCohortMaterial(verified.paths);
	if (!material.ok) throw new Error(`stage material: ${material.message}`);
	if (material.value.receipt.candidate !== args.candidate) {
		throw new Error(
			`--candidate ${args.candidate} is not the staged candidate ${material.value.receipt.candidate}`,
		);
	}
	if (material.value.receipt.stageProfile !== "phase-b") {
		throw new Error(
			`the staged profile is ${material.value.receipt.stageProfile}; the preflight needs a phase-b stage`,
		);
	}
	const macClockId = observeMacClockIdentity();
	if (!macClockId.ok) throw new Error(macClockId.message);

	const macSigningKeyPath = process.env[MAC_SIGNING_KEY_ENV];
	if (typeof macSigningKeyPath !== "string" || macSigningKeyPath.length === 0) {
		throw new Error(
			`${MAC_SIGNING_KEY_ENV} is not set; the Mac signer cannot sign`,
		);
	}
	const targetUser =
		process.env[MAC_SUPERVISOR_USER_ENV] ?? MAC_SUPERVISOR_DEFAULT_USER;
	let controllerUidSeam: { readonly campaignScratchRoot: string } | undefined;
	if (process.env[MAC_SUPERVISOR_UID_SEAM_ENV] === "1") {
		controllerUidSeam = {
			campaignScratchRoot:
				process.env[MAC_CAMPAIGN_SCRATCH_ROOT_ENV] ??
				dirname(macSigningKeyPath),
		};
	} else {
		const preflight = runMacUidPreflight({
			targetUser,
			macSigningKeyPath,
			macTrustDir: verified.paths.stagedDir,
			campaignRootDir: verified.paths.campaignRootDir,
			stagingRootDir: verified.paths.stagingRootDir,
			bunExecutablePath: bunPath.path,
		});
		if (!preflight.ok) throw new Error(preflight.message ?? preflight.code);
	}
	const macSpawned = await spawnMacSupervisor({
		binaryPath: binary.path,
		bunExecutablePath: bunPath.path,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		localPaths: {
			authorityFile: verified.paths.authorityFile,
			authorityDigestFile: verified.paths.authorityDigestFile,
			campaignRootDir: verified.paths.campaignRootDir,
			stagingRootDir: verified.paths.stagingRootDir,
		},
		cohort: {
			macSigningKey: {
				fd: 7,
				label: "mac-signing-key",
				path: macSigningKeyPath,
			},
			stagedRigPublicKey: {
				fd: 8,
				label: "staged-rig-public-key",
				path: join(verified.paths.stagingRootDir, "rig-supervisor-ed25519.pub"),
			},
			receiptValidityMs: COHORT_RECEIPT_VALIDITY_MS,
		},
		...(controllerUidSeam !== undefined ? { controllerUidSeam } : {}),
	});
	if (!macSpawned.ok) {
		throw new Error(
			`mac supervisor spawn failed (${macSpawned.code}): ${macSpawned.message}`,
		);
	}
	const rigStagedDir = process.env.COMPARISON_RIG_STAGED_DIR;
	const rigBinary = process.env.COMPARISON_RIG_SUPERVISOR_BINARY;
	const rigSigningKeyPath = process.env[RIG_SIGNING_KEY_ENV];
	const rigBunPath = process.env[RIG_BUN_PATH_ENV];
	for (const [name, value] of [
		["COMPARISON_RIG_STAGED_DIR", rigStagedDir],
		["COMPARISON_RIG_SUPERVISOR_BINARY", rigBinary],
		[RIG_SIGNING_KEY_ENV, rigSigningKeyPath],
		[RIG_BUN_PATH_ENV, rigBunPath],
	] as const) {
		if (typeof value !== "string" || value.length === 0) {
			await stopSupervisor(macSpawned.handle, 5_000);
			throw new Error(`${name} is not set; the rig install cannot be reached`);
		}
	}
	const rigPaths = rigTrustBootstrapPaths(rigStagedDir as string);
	if (!rigPaths.ok) {
		await stopSupervisor(macSpawned.handle, 5_000);
		throw new Error(rigPaths.reason);
	}
	const rigSsh: RigSsh = { target: args.rig, identity: args.sshKey };
	const rigSpawned = await spawnRigSupervisor({
		rigCohort: {
			signingKey: {
				fd: 7,
				label: "cohort-signing-key",
				path: rigSigningKeyPath as string,
			},
			roleRoot: {
				fd: 10,
				label: "cohort-role-root",
				path: material.value.receipt.rigRoleRootPath,
			},
		},
		uidCrossing: { targetUser: MAC_SUPERVISOR_DEFAULT_USER },
		binaryPath: binary.path,
		bunExecutablePath: rigBunPath as string,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		rigBinaryPath: rigBinary as string,
		rigPaths: rigPaths.paths,
		sshTarget: rigSsh.target,
		sshIdentity: rigSsh.identity,
	});
	if (!rigSpawned.ok) {
		await stopSupervisor(macSpawned.handle, 5_000);
		throw new Error(
			`rig supervisor spawn failed (${rigSpawned.code}): ${rigSpawned.message}`,
		);
	}
	const local = await observeLocalToolchain();
	const identity = toolchainIdentity(local);
	const sha = await sshExec(rigSsh, `sha256sum ${rigBunPath}`, 15_000);
	const linuxSha = sha.stdout.trim().split(/\s+/)[0] ?? "";
	const version = await sshExec(rigSsh, `${rigBunPath} --version`, 15_000);
	const linuxVersion = version.stdout.trim();
	if (
		!sha.ok ||
		!/^[0-9a-f]{64}$/.test(linuxSha) ||
		!version.ok ||
		linuxVersion === ""
	) {
		await stopSupervisor(rigSpawned.handle, 5_000);
		await stopSupervisor(macSpawned.handle, 5_000);
		throw new Error(
			`the rig's bun could not be observed: ${sha.stderr}${version.stderr}`,
		);
	}
	const toolchains: ToolchainSet = {
		js: { identity, sha256: local.bunExecutableSha256 },
		darwin: { identity, sha256: local.bunExecutableSha256 },
		linux: { identity: `bun-${linuxVersion}`, sha256: linuxSha },
	};
	const runtimeRoot = mkdtempSync(join(tmpdir(), "fanout-preflight-runtime-"));
	const launch =
		material.value.stagedServerLaunchRecords["ws"]["fanout-cohort"];
	if (launch === undefined) {
		throw new Error("the phase-b stage binds no fanout-cohort launch record");
	}
	return {
		mode: "physical",
		staged: material.value,
		bootstrap: verified.paths,
		macSupervisor: macSpawned.handle,
		rigSupervisor: rigSpawned.handle,
		serverPort: launch.record.bindPort,
		toolchains,
		bunExecutablePath: bunPath.path,
		macClockId: macClockId.value,
		runtimeRoot,
		rigIsThisHost: false,
		rigSsh,
		cleanup: async () => {
			await stopSupervisor(rigSpawned.handle, 5_000);
			await stopSupervisor(macSpawned.handle, 5_000);
			rmSync(runtimeRoot, { recursive: true, force: true });
		},
	};
}

// ---------------------------------------------------------------------------
// The samplers
// ---------------------------------------------------------------------------

/**
 * The script the Linux sampler runs against the server child: one block of
 * tagged lines per cadence off the same leaves the rig supervisor reads. The
 * Mac stamps each block on arrival. Liveness is `/proc/$pid` existing, not
 * `kill -0`: the sampler runs as the ssh account and the child belongs to the
 * supervisor account, so the signal probe answers EPERM and a `kill -0` loop
 * never runs at all -- which is exactly what the first physical pass did.
 */
export const LINUX_SAMPLER_SCRIPT = `set -u
pid="$1"
cadence="$2"
echo "K $(getconf CLK_TCK)"
if [ -r "/proc/$pid/limits" ]; then
  awk '/^Max open files/ { print "N " $4 " " $5 }' "/proc/$pid/limits"
fi
while [ -d "/proc/$pid" ]; do
  p=$(cat "/proc/$pid/stat" 2>/dev/null) || break
  m=$(cat "/proc/$pid/task/$pid/stat" 2>/dev/null) || break
  r=$(awk '/^VmRSS/ { print $2 }' "/proc/$pid/status" 2>/dev/null)
  l=$(cut -d' ' -f1 /proc/loadavg)
  f=$(awk '/^cpu MHz/ { printf "%s%s", sep, $4; sep="," }' /proc/cpuinfo)
  echo "P $p"
  echo "M $m"
  echo "R $r"
  echo "L $l"
  echo "F $f"
  echo "E"
  sleep "$cadence"
done
`;

interface ServerSamplerState {
	readonly samples: CpuSample[];
	nofile: { readonly soft: number; readonly hard: number } | null;
	pid: number;
	instrument: string;
	/** The last 2 KiB the sampler wrote to stderr: the explanation when it produced no samples. */
	stderrTail: string;
	stop: () => Promise<void>;
}

const SAMPLER_STDERR_TAIL_BYTES = 2048;

function keepStderrTail(
	state: { stderrTail: string },
	stream: ReadableStream<Uint8Array>,
): void {
	void (async () => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			state.stderrTail = (
				state.stderrTail + decoder.decode(chunk, { stream: true })
			).slice(-SAMPLER_STDERR_TAIL_BYTES);
		}
	})();
}

/** Parse one tagged block from the Linux script into a sample. */
export function parseLinuxSamplerBlock(
	lines: readonly string[],
	clockTicksPerSecond: number,
	atMacNs: bigint,
): CpuSample | null {
	let processTicks: number | null = null;
	let mainTicks: number | null = null;
	let rssKb: number | null = null;
	let load1: number | null = null;
	let coreMhz: number[] | null = null;
	for (const line of lines) {
		const tag = line.slice(0, 2);
		const rest = line.slice(2);
		if (tag === "P ") processTicks = parseProcStatCpuTicks(rest);
		else if (tag === "M ") mainTicks = parseProcStatCpuTicks(rest);
		else if (tag === "R ") {
			const parsed = Number.parseInt(rest.trim(), 10);
			rssKb = Number.isSafeInteger(parsed) ? parsed : null;
		} else if (tag === "L ") {
			const parsed = Number.parseFloat(rest.trim());
			load1 = Number.isFinite(parsed) ? parsed : null;
		} else if (tag === "F ") {
			const values = rest
				.split(",")
				.map((token) => Number.parseFloat(token))
				.filter((value) => Number.isFinite(value));
			coreMhz = values.length > 0 ? values : null;
		}
	}
	if (processTicks === null || mainTicks === null || clockTicksPerSecond <= 0) {
		return null;
	}
	return {
		atMacNs,
		processMs: (processTicks * 1000) / clockTicksPerSecond,
		mainThreadMs: (mainTicks * 1000) / clockTicksPerSecond,
		rssKb,
		load1,
		coreMhz,
	};
}

function startLinuxSampler(args: {
	readonly pid: number;
	readonly rigSsh: RigSsh | null;
	readonly cadenceMs: number;
}): ServerSamplerState {
	const cadenceSeconds = (args.cadenceMs / 1000).toFixed(3);
	const tail = ["bash", "-s", "--", String(args.pid), cadenceSeconds];
	const cmd = args.rigSsh === null ? tail : sshArgv(args.rigSsh, tail);
	const proc = Bun.spawn(cmd, {
		stdin: new Blob([LINUX_SAMPLER_SCRIPT]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const state: ServerSamplerState = {
		samples: [],
		nofile: null,
		pid: args.pid,
		instrument:
			args.rigSsh === null
				? "preflight sampler: /proc/<pid>/stat and /proc/<pid>/task/<pid>/stat on this host"
				: `preflight sampler: /proc/<pid>/stat and /proc/<pid>/task/<pid>/stat over ssh to ${args.rigSsh.target}`,
		stderrTail: "",
		stop: async () => {
			try {
				proc.kill("SIGTERM");
			} catch {
				// gone already
			}
			await proc.exited;
		},
	};
	let clockTicks = 100;
	let block: string[] = [];
	// Drained so a chatty ssh can never block on a full stderr pipe; the tail
	// is kept because a sampler that says nothing on stdout usually said why
	// on stderr.
	keepStderrTail(state, proc.stderr);
	const reader = (async () => {
		const decoder = new TextDecoder();
		let pending = "";
		for await (const chunk of proc.stdout) {
			pending += decoder.decode(chunk, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
				if (line.startsWith("K ")) {
					const parsed = Number.parseInt(line.slice(2).trim(), 10);
					if (Number.isSafeInteger(parsed) && parsed > 0) clockTicks = parsed;
				} else if (line.startsWith("N ")) {
					const [soft, hard] = line
						.slice(2)
						.trim()
						.split(/\s+/)
						.map((token) => Number.parseInt(token, 10));
					if (Number.isSafeInteger(soft) && Number.isSafeInteger(hard)) {
						state.nofile = { soft: soft as number, hard: hard as number };
					}
				} else if (line === "E") {
					const sample = parseLinuxSamplerBlock(
						block,
						clockTicks,
						BigInt(readMacContinuousNs()),
					);
					if (sample !== null) state.samples.push(sample);
					block = [];
				} else {
					block.push(line);
				}
			}
		}
	})();
	void reader;
	return state;
}

function startDarwinSampler(args: {
	readonly pid: number;
	readonly cadenceMs: number;
}): ServerSamplerState {
	let running = true;
	const state: ServerSamplerState = {
		samples: [],
		nofile: null,
		pid: args.pid,
		instrument:
			"preflight sampler: ps -M per-thread STIME+UTIME on this host (darwin)",
		stderrTail: "",
		stop: async () => {
			running = false;
		},
	};
	const loop = (async () => {
		while (running) {
			const threads = Bun.spawnSync(["ps", "-M", "-p", String(args.pid)], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const rss = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(args.pid)], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const at = BigInt(readMacContinuousNs());
			if (threads.exitCode !== 0) break;
			const parsed = parseDarwinPsThreads(threads.stdout.toString());
			if (parsed !== null) {
				const rssKb = Number.parseInt(rss.stdout.toString().trim(), 10);
				state.samples.push({
					atMacNs: at,
					processMs: parsed.processMs,
					mainThreadMs: parsed.mainThreadMs,
					rssKb: Number.isSafeInteger(rssKb) ? rssKb : null,
					load1: loadavg()[0] ?? null,
					coreMhz: null,
				});
			}
			await Bun.sleep(args.cadenceMs);
		}
	})();
	void loop;
	return state;
}

interface WorkerCpuSample {
	readonly atMacNs: bigint;
	readonly cpuMsByPid: ReadonlyMap<number, number>;
	readonly load1: number;
}

/** The Mac's role children and its load, once a second. */
function startMacSampler(pids: () => readonly number[]): {
	readonly samples: WorkerCpuSample[];
	readonly stop: () => void;
} {
	let running = true;
	const samples: WorkerCpuSample[] = [];
	const loop = (async () => {
		while (running) {
			const list = pids();
			const cpuMsByPid = new Map<number, number>();
			if (list.length > 0) {
				const out = Bun.spawnSync(
					["ps", "-o", "pid=,cputime=", "-p", list.join(",")],
					{ stdout: "pipe", stderr: "pipe" },
				);
				for (const line of out.stdout.toString().split("\n")) {
					const [pidToken, timeToken] = line.trim().split(/\s+/);
					const pid = Number.parseInt(pidToken ?? "", 10);
					const ms = parsePsCpuTime(timeToken ?? "");
					if (Number.isSafeInteger(pid) && ms !== null) cpuMsByPid.set(pid, ms);
				}
			}
			samples.push({
				atMacNs: BigInt(readMacContinuousNs()),
				cpuMsByPid,
				load1: loadavg()[0] ?? 0,
			});
			await Bun.sleep(1_000);
		}
	})();
	void loop;
	return { samples, stop: () => void (running = false) };
}

function workerCpuOver(
	samples: readonly WorkerCpuSample[],
	pid: number,
	startNs: bigint,
	endNs: bigint,
): number | null {
	const series = samples
		.filter((sample) => sample.cpuMsByPid.has(pid))
		.map((sample) => ({
			atMacNs: sample.atMacNs,
			processMs: sample.cpuMsByPid.get(pid) as number,
			mainThreadMs: 0,
			rssKb: null,
			load1: null,
			coreMhz: null,
		}));
	if (series.length < 2) return null;
	const over = cpuCoreOverInterval(series, startNs, endNs, 2_500_000_000n);
	return over.covered ? over.processMs : null;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function jsonOf(bytes: Uint8Array): unknown {
	try {
		return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
	} catch {
		return null;
	}
}

function sum(values: readonly number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function sumWindows(
	series: readonly (readonly number[])[],
	count: number,
): number[] {
	const out = new Array<number>(count).fill(0);
	for (const row of series) {
		for (let i = 0; i < count; i += 1)
			out[i] = (out[i] as number) + (row[i] ?? 0);
	}
	return out;
}

async function readRigLoad(rigSsh: RigSsh): Promise<number | null> {
	const result = await sshExec(rigSsh, "cat /proc/loadavg", 15_000);
	if (!result.ok) return null;
	const load = Number.parseFloat(result.stdout.trim().split(/\s+/)[0] ?? "");
	return Number.isFinite(load) ? load : null;
}

export interface PreflightRunResult {
	readonly receipt: PreflightReceiptV1;
	readonly receiptPath: string;
	readonly receiptSha256: Sha256Hex;
}

export async function runPreflight(
	args: PreflightArgs,
): Promise<PreflightRunResult> {
	const plan = preflightOfferPlan(args.cellId, args.pass);
	const generatedAtMs = Date.now();

	// Operator preconditions first: both hosts idle before anything spawns.
	const macLoad1 = loadavg()[0] ?? 0;
	let rigLoad1: number | null = null;
	let rigSsh: RigSsh | null = null;
	if (args.loopback) {
		rigLoad1 = macLoad1;
	} else {
		rigSsh = { target: args.rig as string, identity: args.sshKey as string };
		rigLoad1 = await readRigLoad(rigSsh);
	}
	const rigLoadBound = args.loopback
		? OPERATOR_LOAD_BOUND.mac
		: OPERATOR_LOAD_BOUND.rig;
	const preconditionFailures: string[] = [];
	if (macLoad1 >= OPERATOR_LOAD_BOUND.mac) {
		preconditionFailures.push(
			`mac load ${macLoad1.toFixed(2)} >= ${OPERATOR_LOAD_BOUND.mac}`,
		);
	}
	if (rigLoad1 === null) preconditionFailures.push("rig load unreadable");
	else if (rigLoad1 >= rigLoadBound) {
		preconditionFailures.push(
			`rig load ${rigLoad1.toFixed(2)} >= ${rigLoadBound}`,
		);
	}
	const enforced = !(args.loopback && args.ignoreLoad);
	const preconditions: PreflightReceiptV1["preconditions"] = {
		macLoad1,
		macLoadBound: OPERATOR_LOAD_BOUND.mac,
		rigLoad1,
		rigLoadBound,
		rigIsThisHost: args.loopback,
		enforced,
		failures: preconditionFailures,
		ok: !enforced || preconditionFailures.length === 0,
	};

	const candidate = args.loopback
		? (args.candidate ?? R1_CANDIDATE_ID)
		: (args.candidate as string);
	const receiptPath = preflightReceiptPath({
		outDir: args.outDir,
		candidate,
		transport: args.transport,
		cellId: args.cellId,
		pass: args.pass,
	});
	const emptyCpu = (instrument: string): PreflightCpuInterval => ({
		instrument,
		processMs: null,
		mainThreadMs: null,
		intervalMs: null,
		processCore: null,
		mainThreadCore: null,
		bound: null,
		sampleCount: null,
		covered: false,
	});
	const zeroFaults: PreflightFaultCounts = {
		relayQueueDrops: 0,
		relayWriteTimeouts: 0,
		relayDisconnectUndelivered: 0,
		relayMalformedIngress: 0,
		relayDuplicateIngress: 0,
		relayReorderedIngress: 0,
		workerMalformed: 0,
		workerDuplicate: 0,
		workerReorder: 0,
		workerDisconnect: 0,
	};
	const write = (receipt: PreflightReceiptV1): PreflightRunResult => {
		const parsed = parsePreflightReceipt(receipt);
		if (!parsed.ok)
			throw new Error(`receipt does not parse: ${parsed.message}`);
		mkdirSync(dirname(receiptPath), { recursive: true });
		const bytes = new TextEncoder().encode(
			`${JSON.stringify(receipt, null, 2)}\n`,
		);
		writeFileSync(receiptPath, bytes);
		return { receipt, receiptPath, receiptSha256: sha256HexOfBytes(bytes) };
	};
	const base = {
		schema: PREFLIGHT_RECEIPT_SCHEMA,
		candidate,
		campaignId: "",
		mode: args.loopback ? ("loopback" as const) : ("physical" as const),
		transport: args.transport,
		cellId: args.cellId,
		cohortCell: plan.cohortCell,
		pass: args.pass,
		generatedAtMs,
		topology: {
			publisherCount: plan.publisherCount,
			workerCount: plan.workerCount,
			subscriberCount: plan.subscriberCount,
			sessionCount: plan.sessionCount,
			windowCount: plan.windowCount,
			measuredDurationMs: plan.measuredDurationMs,
			messageBytes: plan.messageBytes,
		},
		offer: {
			pacingSource: plan.pacingSource,
			publisherRatePerSecond: plan.publisherRatePerSecond,
			offeredIngressPerSecond: plan.offeredIngressPerSecond,
			rowIngressPerWindow: plan.rowIngressPerWindow,
			bindingIngressPerWindow: plan.bindingIngressPerWindow,
			requiredAcceptedPerWindow: plan.requiredAcceptedPerWindow,
			acceptedPredicate: plan.acceptedPredicate,
		},
		preconditions,
	};

	if (!preconditions.ok) {
		const detail = preconditionFailures.join("; ");
		const verdict = evaluatePreflightPredicate({
			pass: args.pass,
			windowCount: plan.windowCount,
			subscriberCount: plan.subscriberCount,
			requiredAcceptedPerWindow: plan.requiredAcceptedPerWindow,
			acceptedPredicate: plan.acceptedPredicate,
			offeredByOriginWindow: [],
			acceptedByOriginWindow: [],
			deliveredByOriginWindow: [],
			expectedWarmupDeliveries: plan.expectedWarmupDeliveries,
			warmupMacDelivered: null,
			faults: zeroFaults,
			preconditionsOk: false,
			preconditionDetail: detail,
			lifecycleCompleted: false,
			lifecycleDetail: "not run: operator precondition failed",
			measuredMainThreadCore: null,
			warmupMainThreadCore: null,
			warmupCpuCovered: false,
			samplerStderrTail: "",
			samplerPid: null,
			capturePid: null,
		});
		return write({
			...base,
			runId: "",
			macClockId: null,
			lifecycle: {
				completed: false,
				dispatchOk: false,
				failureCode: null,
				reason: "not run: operator precondition failed",
				sealedPath: null,
			},
			windows: {
				note: "origin-window counts from the partials and the Linux observation",
				offeredByOriginWindow: new Array<number>(plan.windowCount).fill(0),
				acceptedByOriginWindow: new Array<number>(plan.windowCount).fill(0),
				deliveredByOriginWindow: new Array<number>(plan.windowCount).fill(0),
				relayWritesCompletedByOriginWindow: new Array<number>(
					plan.windowCount,
				).fill(0),
			},
			totals: {
				offered: 0,
				accepted: 0,
				delivered: 0,
				deliveredBytes: 0,
				expectedDelivered: 0,
				ingressRefusals: 0,
			},
			warmup: {
				epochMs: WARMUP_DURATION_MS,
				expectedIngress: plan.expectedWarmupIngress,
				expectedDeliveries: plan.expectedWarmupDeliveries,
				macOffered: null,
				macDelivered: null,
				relayIngress: null,
				relayDeliveries: null,
			},
			faults: zeroFaults,
			queue: {
				relayQueueItemsPeak: null,
				relayQueueBytesPeak: null,
				perSubscriberCap: RELAY_PER_SUBSCRIBER_QUEUE_CAP,
				note: "not run",
			},
			relayBusy: {
				instrument: "onRelayWork spans (server child busyMs)",
				busyMs: null,
				windowMs: null,
				fraction: null,
			},
			serverChildCpu: {
				measured: emptyCpu("not run"),
				warmup: emptyCpu("not run"),
				perSecondNote:
					"wall-clock seconds from the measure start; recorded, not gated",
				perSecondMainThreadCore: null,
				perSecondMainThreadCoreMax: null,
				sampler: {
					instrument: "not run",
					cadenceMs: SAMPLER_CADENCE_MS,
					sampleCount: 0,
					stderrTail: "",
					pid: null,
					capturePid: null,
					pidMatchesCapture: false,
				},
			},
			rig: {
				coreMhz: {
					warmupStart: null,
					warmupEnd: null,
					measureStart: null,
					measureStop: null,
				},
				rssKb: { warmupStart: null, measureStop: null, peak: null },
				nofile: null,
			},
			mac: { load1AtStart: macLoad1, load1Peak: null, workers: [] },
			verdict: verdict.verdict,
			failedPredicates: verdict.failures,
		});
	}

	const supervisorBinary =
		args.supervisorBinary ??
		(() => {
			const resolved = resolveSupervisorBinaryPath();
			if (!resolved.ok) throw new Error(resolved.message);
			return resolved.path;
		})();
	const pair = args.loopback
		? await stageLoopbackPair({ supervisorBinary })
		: await openPhysicalPair({
				stagedDir: args.stagedDir as string,
				rig: args.rig as string,
				sshKey: args.sshKey as string,
				candidate,
				supervisorBinary: args.supervisorBinary,
			});

	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidateCell) => candidateCell.cellId === args.cellId,
	);
	if (cell === undefined) {
		await pair.cleanup();
		throw new Error(`no registry cell ${args.cellId}`);
	}
	const arm = sealArmsForCell(cell, [args.transport], ["primary"])[0];
	if (arm === undefined) {
		await pair.cleanup();
		throw new Error(`no ${args.transport} primary arm for ${args.cellId}`);
	}
	const runId = signedExecutionRunId({
		campaignId: pair.staged.receipt.campaignId,
		cellId: args.cellId,
		transport: args.transport,
		repetitionKind: "measured",
		repetitionIndex: 1,
	});

	let lease: CohortArmLease | null = null;
	const productionLease = createProductionCohortArmLeaseFactory({
		staged: pair.staged,
		bootstrap: pair.bootstrap,
		macSupervisor: pair.macSupervisor,
		rigSupervisor: pair.rigSupervisor,
		executionPurpose: "pilot",
		repetitionTotal: 1,
		toolchains: pair.toolchains,
		bunExecutablePath: pair.bunExecutablePath,
		serverPort: pair.serverPort,
		tlsCaPem: pair.staged.tlsCaPem,
		macClockId: pair.macClockId,
		runtimeRoot: pair.runtimeRoot,
		...(plan.preflightPublisherRatePerSecond !== null
			? {
					preflightPublisherRatePerSecond: plan.preflightPublisherRatePerSecond,
				}
			: {}),
	});
	const provider = createCohortArmRuntimeProvider({
		sourceIdentity: {
			sourceSha: pair.staged.receipt.candidate,
			archiveSha256: pair.staged.receipt.archiveSha256,
			executableSha256: pair.staged.receipt.capabilitySha256,
		},
		supervisorToolchainDigests: {
			darwin: pair.toolchains.darwin.sha256,
			linux: pair.toolchains.linux.sha256,
		},
		executionPurpose: "pilot",
		repetitionTotal: 1,
		lease: async (context) => {
			const acquired = await productionLease(context);
			if (acquired.ok) lease = acquired.value;
			return acquired;
		},
	});

	// The server sampler follows the lease: as soon as the rig answers the
	// grant with the child's pid, the sampler attaches to that pid.
	let serverSampler: ServerSamplerState | null = null;
	let watching = true;
	const watcher = (async () => {
		while (watching) {
			const current = lease as CohortArmLease | null;
			const ready = current?.retention.serverReady ?? null;
			if (
				ready !== null &&
				(serverSampler === null || serverSampler.pid !== ready.childPid)
			) {
				if (serverSampler !== null) await serverSampler.stop();
				serverSampler = pair.rigIsThisHost
					? process.platform === "linux"
						? startLinuxSampler({
								pid: ready.childPid,
								rigSsh: null,
								cadenceMs: SAMPLER_CADENCE_MS,
							})
						: startDarwinSampler({
								pid: ready.childPid,
								cadenceMs: SAMPLER_CADENCE_MS,
							})
					: startLinuxSampler({
							pid: ready.childPid,
							rigSsh: pair.rigSsh,
							cadenceMs: SAMPLER_CADENCE_MS,
						});
			}
			await Bun.sleep(50);
		}
	})();
	const macSampler = startMacSampler(() => {
		const current = lease as CohortArmLease | null;
		return current === null
			? []
			: current.supervisor.spawnedChildren.map((child) => child.pid);
	});

	const scratch = join(
		args.outDir,
		candidate,
		"scratch",
		`${args.transport}-${cellIdSlug(args.cellId)}-${args.pass}`,
	);
	mkdirSync(scratch, { recursive: true });
	const perRepPath = join(scratch, "rep-1.json");
	const sealedPath = join(scratch, "rep-1.sealed.json");
	let dispatch: Awaited<ReturnType<typeof dispatchArmRepetition>> | null = null;
	let dispatchError: string | null = null;
	try {
		dispatch = await dispatchArmRepetition({
			arm: {
				cell,
				arm,
				runId,
				repIndex: 1,
				repetitionKind: "measured",
				repetitionTotal: 1,
				executionPurpose: "pilot",
				perRepPath,
				sealedPath,
			} as unknown as Parameters<typeof dispatchArmRepetition>[0]["arm"],
			cohortRuntime: provider,
		});
	} catch (error) {
		dispatchError = error instanceof Error ? error.message : String(error);
	} finally {
		watching = false;
		await watcher;
		macSampler.stop();
		if (serverSampler !== null)
			await (serverSampler as ServerSamplerState).stop();
		await pair.cleanup();
	}

	// What the lifecycle retained, read straight off the lease.
	const retained = lease as CohortArmLease | null;
	const retention = retained?.retention ?? null;
	const capture = retention?.capture ?? null;
	const barrier = retention?.barrier?.record ?? null;
	const observationJson =
		capture?.linuxRelayObservationBytes != null
			? jsonOf(capture.linuxRelayObservationBytes)
			: null;
	const observationParsed =
		observationJson === null
			? null
			: parseLinuxRelayObservation(observationJson);
	const observation: LinuxRelayObservationV1 | null =
		observationParsed !== null && observationParsed.ok
			? observationParsed.value
			: null;
	const publishers: PublisherPartialV1[] = [];
	const workers: WorkerPartialV1[] = [];
	if (retention !== null) {
		for (const record of retention.partials.values()) {
			const asPublisher = parsePublisherPartial(record);
			if (asPublisher.ok) {
				publishers.push(asPublisher.value);
				continue;
			}
			const asWorker = parseWorkerPartial(record);
			if (asWorker.ok) workers.push(asWorker.value);
		}
	}
	const lifecycleCompleted =
		observation !== null &&
		barrier !== null &&
		publishers.length === plan.publisherCount &&
		workers.length === COHORT_WORKER_COUNT;
	const dispatchResult = dispatch?.result ?? null;
	const lifecycleDetail = !lifecycleCompleted
		? dispatchError !== null
			? `dispatch threw: ${dispatchError}`
			: dispatchResult !== null && !dispatchResult.ok
				? `${dispatchResult.failureCode ?? "TRUST_PROTOCOL"}: ${dispatchResult.reason}`
				: `retained ${publishers.length} publisher and ${workers.length} worker partials, observation ${observation === null ? "absent" : "present"}`
		: "capture and every partial retained";

	const w = plan.windowCount;
	const offeredByOriginWindow = lifecycleCompleted
		? sumWindows(
				publishers.map((p) => p.offeredByOriginWindow),
				w,
			)
		: [];
	const acceptedByOriginWindow =
		observation === null ? [] : [...observation.acceptedIngressByOriginWindow];
	const deliveredByOriginWindow = lifecycleCompleted
		? sumWindows(
				workers.map((worker) => worker.deliveredByOriginWindow),
				w,
			)
		: [];
	const deliveredBytes = sum(
		workers.map((worker) => sum(worker.deliveredBytesByOriginWindow)),
	);
	const faults: PreflightFaultCounts =
		observation === null
			? zeroFaults
			: {
					relayQueueDrops: sum(observation.queueDropDeliveriesByOriginWindow),
					relayWriteTimeouts: sum(
						observation.writeTimeoutDeliveriesByOriginWindow,
					),
					relayDisconnectUndelivered: sum(
						observation.disconnectUndeliveredByOriginWindow,
					),
					relayMalformedIngress: sum(
						observation.malformedIngressByOriginWindow,
					),
					relayDuplicateIngress: sum(
						observation.duplicateIngressByOriginWindow,
					),
					relayReorderedIngress: sum(
						observation.reorderedIngressByOriginWindow,
					),
					workerMalformed: sum(workers.map((worker) => worker.malformedCount)),
					workerDuplicate: sum(workers.map((worker) => worker.duplicateCount)),
					workerReorder: sum(workers.map((worker) => worker.reorderCount)),
					workerDisconnect: sum(
						workers.map((worker) => worker.disconnectCount),
					),
				};

	const manifest = retention?.warmupCompletionManifest?.record ?? null;
	const warmupMacDelivered =
		manifest === null
			? null
			: sum(
					manifest.entries
						.filter((entry) => entry.role === "subscriber-worker")
						.map((entry) => entry.deliveredWarmupRecords),
				);
	const warmupMacOffered =
		manifest === null
			? null
			: sum(
					manifest.entries
						.filter((entry) => entry.role === "publisher")
						.map((entry) => entry.offeredWarmupIngress),
				);
	const drainedJson =
		retention?.warmupDrained !== null && retention?.warmupDrained !== undefined
			? jsonOf(retention.warmupDrained.serverWarmupDrainedBytes)
			: null;
	const drained =
		isRecord(drainedJson) && drainedJson.schema === "server-warmup-drained/v1"
			? drainedJson
			: null;

	// The rig's attested measured-window CPU and the child's busy spans.
	let snapshotReceipt: RigServerSnapshotReceiptV1 | null = null;
	let busy: { readonly busyMs: number; readonly windowMs: number } | null =
		null;
	if (capture !== null) {
		const receiptJson = jsonOf(capture.snapshotReceiptBytes);
		if (
			isRecord(receiptJson) &&
			serverChildCpuIssue(receiptJson.serverChildCpu) === null
		) {
			snapshotReceipt = receiptJson as unknown as RigServerSnapshotReceiptV1;
		}
		const frameJson = jsonOf(capture.snapshotFrameBytes);
		if (isServerLoopUtilizationFrameV1(frameJson)) {
			busy = { busyMs: frameJson.busyMs, windowMs: frameJson.windowMs };
		}
	}
	const measuredCpu: PreflightCpuInterval =
		snapshotReceipt === null
			? emptyCpu(
					"rig supervisor serverChildCpu on rig-server-snapshot-receipt/v1 (absent)",
				)
			: {
					instrument: pair.rigIsThisHost
						? "rig supervisor serverChildCpu on rig-server-snapshot-receipt/v1: libproc at measure-start ack and capture ack (darwin local acceptance)"
						: "rig supervisor serverChildCpu on rig-server-snapshot-receipt/v1: /proc/<pid>/task/<pid>/stat and /proc/<pid>/stat at measure-start ack and capture ack",
					processMs: snapshotReceipt.serverChildCpu.processMs,
					mainThreadMs: snapshotReceipt.serverChildCpu.mainThreadMs,
					intervalMs: snapshotReceipt.serverChildCpu.windowMs,
					processCore:
						snapshotReceipt.serverChildCpu.processMs /
						snapshotReceipt.serverChildCpu.windowMs,
					mainThreadCore:
						snapshotReceipt.serverChildCpu.mainThreadMs /
						snapshotReceipt.serverChildCpu.windowMs,
					bound: MAIN_THREAD_CORE_BOUND[args.pass],
					sampleCount: 2,
					covered: true,
				};

	// The preflight's own series over the barrier's boundaries.
	const sampler = serverSampler as ServerSamplerState | null;
	const samples = sampler?.samples ?? [];
	const tolerance = BigInt(SAMPLER_CADENCE_MS) * 3n * 1_000_000n;
	const warmupStart =
		barrier === null ? null : BigInt(barrier.warmupStartedAtMacNs);
	const warmupEnd =
		barrier === null ? null : BigInt(barrier.warmupCompletedAtMacNs);
	const measureStart =
		barrier === null ? null : BigInt(barrier.measureStartAtMacNs);
	const measureStop =
		barrier === null ? null : BigInt(barrier.measureStopAtMacNs);
	const warmupOver =
		warmupStart !== null && warmupEnd !== null
			? cpuCoreOverInterval(samples, warmupStart, warmupEnd, tolerance)
			: null;
	const warmupCpu: PreflightCpuInterval =
		warmupOver === null
			? emptyCpu(
					`${sampler?.instrument ?? "preflight sampler (never attached)"} (no barrier)`,
				)
			: {
					instrument:
						sampler?.instrument ?? "preflight sampler (never attached)",
					processMs: warmupOver.processMs,
					mainThreadMs: warmupOver.mainThreadMs,
					intervalMs: warmupOver.intervalMs,
					processCore: warmupOver.processCore,
					mainThreadCore: warmupOver.mainThreadCore,
					bound: args.pass === "1x" ? MAIN_THREAD_CORE_BOUND["1x"] : null,
					sampleCount: warmupOver.sampleCount,
					covered: warmupOver.covered,
				};
	let perSecond: number[] | null = null;
	if (measureStart !== null && measureStop !== null && samples.length >= 2) {
		perSecond = [];
		for (let i = 0; i < w; i += 1) {
			const from = measureStart + BigInt(i) * 1_000_000_000n;
			const to = from + 1_000_000_000n;
			const over = cpuCoreOverInterval(samples, from, to, tolerance);
			perSecond.push(over.mainThreadCore ?? Number.NaN);
		}
		if (perSecond.some((value) => !Number.isFinite(value))) perSecond = null;
	}
	const near = (at: bigint | null) =>
		at === null ? null : sampleNear(samples, at);
	const rssPeak = samples.reduce<number | null>(
		(peak, sample) =>
			sample.rssKb === null
				? peak
				: peak === null
					? sample.rssKb
					: Math.max(peak, sample.rssKb),
		null,
	);
	const capturePid = snapshotReceipt?.childPid ?? null;
	const samplerPid = sampler?.pid ?? null;

	const workerRows = (retained?.supervisor.spawnedChildren ?? [])
		.filter((child) => child.plan.role === "subscriber-worker")
		.map((child) => {
			const cpuMs =
				measureStart !== null && measureStop !== null
					? workerCpuOver(
							macSampler.samples,
							child.pid,
							measureStart,
							measureStop,
						)
					: null;
			return {
				childId: child.plan.childId,
				workerIndex: child.plan.workerIndex ?? -1,
				pid: child.pid,
				cpuMsOverMeasuredWindow: cpuMs,
				cpuCore: cpuMs === null ? null : cpuMs / plan.measuredDurationMs,
			};
		});
	const macLoadPeak = macSampler.samples.reduce<number | null>(
		(peak, sample) =>
			peak === null ? sample.load1 : Math.max(peak, sample.load1),
		null,
	);

	const verdict = evaluatePreflightPredicate({
		pass: args.pass,
		windowCount: w,
		subscriberCount: plan.subscriberCount,
		requiredAcceptedPerWindow: plan.requiredAcceptedPerWindow,
		acceptedPredicate: plan.acceptedPredicate,
		offeredByOriginWindow,
		acceptedByOriginWindow,
		deliveredByOriginWindow,
		expectedWarmupDeliveries: plan.expectedWarmupDeliveries,
		warmupMacDelivered,
		faults,
		preconditionsOk: true,
		preconditionDetail: "",
		lifecycleCompleted,
		lifecycleDetail,
		measuredMainThreadCore: measuredCpu.mainThreadCore,
		warmupMainThreadCore: warmupCpu.mainThreadCore,
		warmupCpuCovered: warmupCpu.covered,
		samplerStderrTail: sampler?.stderrTail ?? "",
		samplerPid,
		capturePid,
	});
	const offered = sum(offeredByOriginWindow);
	const accepted = sum(acceptedByOriginWindow);
	return write({
		...base,
		campaignId: pair.staged.receipt.campaignId,
		runId,
		macClockId: pair.macClockId,
		lifecycle: {
			completed: lifecycleCompleted,
			dispatchOk: dispatchResult?.ok ?? false,
			failureCode:
				dispatchResult !== null && !dispatchResult.ok
					? (dispatchResult.failureCode ?? "TRUST_PROTOCOL")
					: null,
			reason:
				dispatchResult !== null && !dispatchResult.ok
					? dispatchResult.reason
					: dispatchError,
			sealedPath:
				dispatchResult !== null && dispatchResult.ok
					? dispatchResult.sealedPath
					: null,
		},
		windows: {
			note: "origin-window counts: offered from the publisher partials, accepted from the Linux relay observation, delivered from the eight worker partials; never wall-clock samples",
			offeredByOriginWindow: lifecycleCompleted
				? offeredByOriginWindow
				: new Array<number>(w).fill(0),
			acceptedByOriginWindow:
				observation === null
					? new Array<number>(w).fill(0)
					: acceptedByOriginWindow,
			deliveredByOriginWindow: lifecycleCompleted
				? deliveredByOriginWindow
				: new Array<number>(w).fill(0),
			relayWritesCompletedByOriginWindow:
				observation === null
					? new Array<number>(w).fill(0)
					: [...observation.relayWritesCompletedByOriginWindow],
		},
		totals: {
			offered,
			accepted,
			delivered: sum(deliveredByOriginWindow),
			deliveredBytes,
			expectedDelivered: accepted * plan.subscriberCount,
			ingressRefusals: Math.max(0, offered - accepted),
		},
		warmup: {
			epochMs: WARMUP_DURATION_MS,
			expectedIngress: plan.expectedWarmupIngress,
			expectedDeliveries: plan.expectedWarmupDeliveries,
			macOffered: warmupMacOffered,
			macDelivered: warmupMacDelivered,
			relayIngress:
				drained !== null && isNonNegInt(drained.warmupIngress)
					? drained.warmupIngress
					: null,
			relayDeliveries:
				drained !== null && isNonNegInt(drained.warmupDeliveries)
					? drained.warmupDeliveries
					: null,
		},
		faults,
		queue: {
			relayQueueItemsPeak: observation?.queueItemsPeak ?? null,
			relayQueueBytesPeak: observation?.queueBytesPeak ?? null,
			perSubscriberCap: RELAY_PER_SUBSCRIBER_QUEUE_CAP,
			note: "relay-wide queued-item peak over the window (an upper bound on any one subscriber's depth); the relay keeps no per-subscriber peak",
		},
		relayBusy: {
			instrument:
				"onRelayWork spans (server child busyMs on server-loop-utilization/v1)",
			busyMs: busy?.busyMs ?? null,
			windowMs: busy?.windowMs ?? null,
			fraction:
				busy === null || busy.windowMs === 0
					? null
					: busy.busyMs / busy.windowMs,
		},
		serverChildCpu: {
			measured: measuredCpu,
			warmup: warmupCpu,
			perSecondNote:
				"main-thread core per wall-clock second from the barrier's measure start, from the preflight sampler; recorded, not gated",
			perSecondMainThreadCore: perSecond,
			perSecondMainThreadCoreMax:
				perSecond === null ? null : Math.max(...perSecond),
			sampler: {
				instrument: sampler?.instrument ?? "preflight sampler (never attached)",
				cadenceMs: SAMPLER_CADENCE_MS,
				sampleCount: samples.length,
				stderrTail: sampler?.stderrTail ?? "",
				pid: samplerPid,
				capturePid,
				pidMatchesCapture: samplerPid !== null && samplerPid === capturePid,
			},
		},
		rig: {
			coreMhz: {
				warmupStart: near(warmupStart)?.coreMhz ?? null,
				warmupEnd: near(warmupEnd)?.coreMhz ?? null,
				measureStart: near(measureStart)?.coreMhz ?? null,
				measureStop: near(measureStop)?.coreMhz ?? null,
			},
			rssKb: {
				warmupStart: near(warmupStart)?.rssKb ?? null,
				measureStop: near(measureStop)?.rssKb ?? null,
				peak: rssPeak,
			},
			nofile: sampler?.nofile ?? null,
		},
		mac: {
			load1AtStart: macLoad1,
			load1Peak: macLoadPeak,
			workers: workerRows,
		},
		verdict: verdict.verdict,
		failedPredicates: verdict.failures,
	});
}

export async function main(argv: readonly string[]): Promise<number> {
	let args: PreflightArgs;
	try {
		args = parsePreflightArgs(argv);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n${PREFLIGHT_USAGE}`,
		);
		return 64;
	}
	if (args.help) {
		process.stdout.write(PREFLIGHT_USAGE);
		return 0;
	}
	if (!args.loopback && !existsSync(args.sshKey as string)) {
		process.stderr.write(`ssh key ${args.sshKey} does not exist\n`);
		return 64;
	}
	const result = await runPreflight(args);
	process.stdout.write(
		`preflight ${result.receipt.transport} ${result.receipt.cellId} ${result.receipt.pass}: ${result.receipt.verdict}\n` +
			`receipt ${result.receiptPath}\nsha256 ${result.receiptSha256}\n` +
			(result.receipt.failedPredicates.length === 0
				? ""
				: `${result.receipt.failedPredicates
						.map((failure) => `  ${failure.predicate}: ${failure.detail}`)
						.join("\n")}\n`),
	);
	return result.receipt.verdict === "PASS" ? 0 : 1;
}

if (import.meta.main) {
	const code = await main(process.argv.slice(2));
	process.exit(code);
}
