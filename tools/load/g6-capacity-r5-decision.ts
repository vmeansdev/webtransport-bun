/**
 * r5 A' adapter helpers: extract one R5CellSummary per raw A' cell from
 * validated evidence, and validate the reviewed r5 candidate decision record
 * against an independent recompute of `evaluateR5Attribution`. Plan:
 * docs/superpowers/plans/2026-10-01-g6-capacity-closure-r5.md (T2.3-T2.5, E2).
 */

import { createHash } from "node:crypto";
import {
	R5_LADDER_PLAN_IDS,
	type R5LadderPlanId,
} from "./g6-c32-capacity-work.ts";
import {
	canonicalArtifactSha256,
	canonicalJson,
	requireDefined,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import { gradeSuccessorRung } from "./g6-c32-successor-grade.ts";
import type { WorkOutcome } from "./g6-c32-work-plan.ts";
import type {
	R5CellSummary,
	R5Decision,
	R5Outcome,
} from "./g6-capacity-attribution-r5.ts";
import { CAPACITY_NATIVE_PROOF_TESTS } from "./g6-capacity-proof-catalog.ts";
import {
	type CapacityRawCellInput,
	validateCapacityRawCell,
} from "./g6-capacity-raw-cell.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

export const R5_ATTRIBUTION_PLAN_ID = "g6-capacity-attribution-a-r5";
export const R5_CANDIDATE_DECISION_SCHEMA =
	"g6-capacity-candidate-decision-r5/1";
export const R5_DECISION_ALTERNATIVES = [
	"C-PUMP+stock",
	"C-PUMP+batch64",
	"none",
] as const;
/** batch64 is selectable only when these exact output-ownership tests pass. */
export const R5_BATCH_OWNERSHIP_TESTS = [
	"partial_batch_eagain_resume_never_resends_the_accepted_prefix",
	"gso_fallback_retains_each_segment_and_metadata_until_accepted",
	"count_and_byte_credits_cover_pending_storage_and_release_on_drop",
	"shutdown_while_fallback_waits_joins_and_releases_only_after_terminal_error",
	"accepted_hard_failure_is_sticky_on_the_socket",
].map((name) => `udp_send_batch::tests::${name}`);
for (const name of R5_BATCH_OWNERSHIP_TESTS)
	if (!CAPACITY_NATIVE_PROOF_TESTS.includes(name))
		throw Error(`r5 batch ownership test ${name} is not a required proof test`);

/** E3: vendored wtransport datagram-pump tests the r5 prepared host must pass. */
export const R5_VENDORED_WTRANSPORT_GATE_ID =
	"prepared-server-vendored-wtransport-tests";
export const R5_VENDORED_WTRANSPORT_TESTS = [
	"driver::datagram_pump_tests::pump_outcome_reraises_a_panic_instead_of_reporting_a_disconnect",
	"pump_mode_delivers_in_order_closes_on_malformed_and_cleans_up",
	"legacy_mode_delivers_in_order_closes_on_malformed_and_spawns_no_pump",
] as const;
/** Every cargo summary passed with zero failures and every named test reported ok. */
export function vendoredWtransportTestsPassed(output: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip only ANSI SGR escapes from retained cargo output.
	const text = output.replace(/\x1b\[[0-9;]*m/g, "");
	const summaries = [
		...text.matchAll(
			/^test result: (ok|FAILED)\. (\d+) passed; (\d+) failed;/gm,
		),
	];
	if (
		summaries.length === 0 ||
		summaries.some((row) => row[1] !== "ok" || row[3] !== "0")
	)
		return false;
	const names = new Set(
		[...text.matchAll(/^test ([a-zA-Z0-9_:]+) \.\.\. ok\s*$/gm)].map(
			(match) => match[1],
		),
	);
	return R5_VENDORED_WTRANSPORT_TESTS.every((name) => names.has(name));
}
type Row = Record<string, unknown>;
function fail(message: string): never {
	throw Error(`g6-capacity-r5-decision: ${message}`);
}
function object(value: unknown, label: string): Row {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(`${label} must be structured evidence`);
	return value as Row;
}
function exact(value: unknown, keys: readonly string[], label: string): Row {
	const row = object(value, label);
	if (
		Object.keys(row).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(row, key))
	)
		fail(`${label} has missing or unknown fields`);
	return row;
}
function finite(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		fail(`${label} must be nonnegative finite evidence`);
	return value;
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim())
		fail(`${label} must be nonempty text`);
	return value;
}
function field(value: unknown, ...path: string[]): unknown {
	let current = value;
	for (const key of path) current = object(current, key)[key];
	return current;
}
const ms = (value: unknown) =>
	Date.parse(validateRfc3339Millis(value, "r5 timestamp"));

export function isR5AttributionPlanId(id: string): boolean {
	return id === R5_ATTRIBUTION_PLAN_ID;
}
export function isR5LadderPlanId(id: string): id is R5LadderPlanId {
	return (R5_LADDER_PLAN_IDS as readonly string[]).includes(id);
}
/** E2: probe-off B exists only for a recorded "interference" disposition. */
export function expectedR5LadderPlanId(probeInB: boolean): R5LadderPlanId {
	return probeInB
		? "g6-capacity-ladder-b-r5"
		: "g6-capacity-ladder-b-r5-probe-off";
}

/** True only when every named batch ownership test executed and passed. */
export function batchOwnershipTestsPassed(output: string): boolean {
	const names = new Set(
		[...output.matchAll(/^test ([a-zA-Z0-9_:]+) \.\.\. ok\s*$/gm)].map(
			(match) => match[1],
		),
	);
	return R5_BATCH_OWNERSHIP_TESTS.every((name) => names.has(name));
}

function histogramMs(value: unknown, label: string) {
	const summary = LatencyHistogram.fromJson(value as never).summary();
	if (summary.count === 0) fail(`${label} histogram is empty`);
	return { p50Ms: summary.p50Ns / 1e6, p99Ms: summary.p99Ns / 1e6 };
}

/**
 * One A' cell summary from exact retained raw evidence. CPU and offered
 * datagrams use the steady window on both roles; clauses come from the same
 * S1-S5 grader the rated cells use; the outcome is the sealed (re-graded) one.
 */
export function extractR5CellSummary(
	input: CapacityRawCellInput,
	sealed: { outcome: WorkOutcome; startedAt: string },
): R5CellSummary {
	const { scan, report } = validateCapacityRawCell(input);
	const grade = gradeSuccessorRung({
		rung: input.node.requestedSessions,
		scan,
		postRunSteeringText: input.postRunSteeringText,
		expectCandidate: input.expectCandidate,
		registrationSha256: input.registrationSha256,
		profile: input.profile,
	});
	if (!grade.valid) fail(`${input.node.id} raw S1-S5 grade is invalid`);
	const clause = (key: string) => {
		const row = requireDefined(grade.clauses[key]);
		return { value: finite(row.value, `${key} value`), pass: row.pass };
	};
	const ack = histogramMs(
		field(report, "windows", "steadyDrain", "rtt"),
		"ACK",
	);
	if (ack.p99Ms !== clause("S4_ackRttP99Ms").value)
		fail(`${input.node.id} ACK p99 differs from the S4 grader`);
	const hold = histogramMs(
		field(report, "windows", "steadyDrain", "serverHold"),
		"server hold",
	);
	const shards = scan.shards as unknown[];
	const shardCpu = shards.reduce(
		(total: number, shard) =>
			total + finite(field(shard, "windows", "steady", "cpuMs"), "shard CPU"),
		0,
	);
	const serverSteadyCpuMs = finite(
		field(scan, "aggregate", "steady", "cpuMs"),
		"server steady CPU",
	);
	if (Math.abs(serverSteadyCpuMs - shardCpu) > 1e-9 * Math.max(1, shardCpu))
		fail(`${input.node.id} server CPU aggregate differs from its shards`);
	const emitter = (key: string) =>
		finite(field(scan, "aggregate", "steady", "emitter", key), key);
	const config = object(scan.config, "scan config");
	const { server, generator } = input.pair;
	return {
		nodeId: input.node.id,
		outcome: sealed.outcome as R5Outcome,
		startedAt: validateRfc3339Millis(sealed.startedAt, "cell startedAt"),
		sourceSha: text((scan as unknown as Row).candidateSha, "scan candidate"),
		pairId: canonicalJson({
			server: [server.provider.id, server.bootId],
			generator: [generator.provider.id, generator.bootId],
		}),
		datagramPump: config.datagramPump as "pump" | "legacy",
		udpSendBatch: finite(config.udpSendBatch, "udpSendBatch echo"),
		detailedProbe: input.probe !== null,
		serverSteadyCpuMs,
		generatorSteadyCpuMs: finite(
			field(report, "client", "cpuMsSteady"),
			"generator steady CPU",
		),
		snapshotIssued: emitter("snapshotIssued"),
		ackIssued: emitter("ackIssued"),
		snapshotDue: emitter("snapshotDue"),
		serverRxTotal: finite(
			field(scan, "aggregate", "steady", "rxTotal"),
			"server steady rxTotal",
		),
		offeredMoves: finite(
			field(report, "windows", "steady", "scheduleTicksDue"),
			"generator scheduleTicksDue",
		),
		ackP50Ms: ack.p50Ms,
		ackP99Ms: ack.p99Ms,
		serverHoldP99Ms: hold.p99Ms,
		clauses: {
			S1: clause("S1_ingest"),
			S2: clause("S2_delivery"),
			S3: clause("S3_duty"),
			S4: clause("S4_ackRttP99Ms"),
			S5: clause("S5_sessionsLost"),
		},
	};
}

export type R5CandidateDecisionRecord = Readonly<{
	schema: typeof R5_CANDIDATE_DECISION_SCHEMA;
	recordedAt: string;
	sourceSha: string;
	aDigests: Readonly<Record<string, string>>;
	attributionArtifactSha256: string;
	status: R5Decision["status"];
	candidate: R5Decision["candidate"];
	sendPath: R5Decision["sendPath"];
	probeInB: R5Decision["probeInB"];
	calibrationDisposition: R5Decision["calibration"]["disposition"];
	bGo: boolean;
	bGoReasons: readonly string[];
	bWorkPlanId: R5LadderPlanId | null;
	disclosure: R5Decision["disclosure"];
	scopeStatement: string;
	alternatives: readonly Readonly<{
		id: (typeof R5_DECISION_ALTERNATIVES)[number];
		explanation: string;
		evidencePaths: readonly string[];
		files: readonly string[];
		tests: readonly string[];
	}>[];
	selectedAlternativeId: (typeof R5_DECISION_ALTERNATIVES)[number];
	selectionExplanation: string;
}>;
export const R5_DECISION_KEYS = [
	"schema",
	"recordedAt",
	"sourceSha",
	"aDigests",
	"attributionArtifactSha256",
	"status",
	"candidate",
	"sendPath",
	"probeInB",
	"calibrationDisposition",
	"bGo",
	"bGoReasons",
	"bWorkPlanId",
	"disclosure",
	"scopeStatement",
	"alternatives",
	"selectedAlternativeId",
	"selectionExplanation",
] as const;

/** The mechanical record the reviewed decision must equal, field for field. */
export function expectedR5DecisionFields(decision: R5Decision) {
	return {
		attributionArtifactSha256: canonicalArtifactSha256(decision),
		status: decision.status,
		candidate: decision.candidate,
		sendPath: decision.sendPath,
		probeInB: decision.probeInB,
		calibrationDisposition: decision.calibration.disposition,
		bGo: decision.bGo,
		bGoReasons: decision.bGoReasons,
		bWorkPlanId:
			decision.status === "SELECTED" && decision.bGo
				? expectedR5LadderPlanId(decision.probeInB === true)
				: null,
		disclosure: decision.disclosure,
		selectedAlternativeId:
			decision.status === "SELECTED"
				? (`C-PUMP+${decision.sendPath}` as const)
				: ("none" as const),
	};
}

const digest = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");

/**
 * Recompute-bound r5 decision. The record must equal the independent
 * `evaluateR5Attribution` replay, follow A's seal, precede B's first CREATE,
 * and carry sequential unconditional Architect then Critic approvals of its
 * exact bytes (review schema shared with the historical decision).
 */
export function validateR5CandidateDecision(input: {
	decisionBytes: string | Buffer;
	architect: unknown;
	critic: unknown;
	recomputed: R5Decision;
	expected: {
		sourceSha: string;
		aDigests: Readonly<Record<string, string>>;
		aSealedAt: string;
		bCreateAt: string | null;
	};
	readEvidence: (path: string) => Buffer;
	validateReviews: (
		reviews: { architect: unknown; critic: unknown },
		bound: {
			sourceSha: string;
			decisionSha256: string;
			decisionRecordedAt: string;
			bCreateAt: string | null;
		},
	) => void;
}): R5CandidateDecisionRecord {
	const decision = exact(
			JSON.parse(input.decisionBytes.toString()),
			R5_DECISION_KEYS,
			"r5 candidate decision",
		),
		expected = input.expected;
	if (
		decision.schema !== R5_CANDIDATE_DECISION_SCHEMA ||
		decision.sourceSha !== expected.sourceSha
	)
		fail("r5 decision schema/source binding differs");
	if (
		ms(decision.recordedAt) <= ms(expected.aSealedAt) ||
		(expected.bCreateAt !== null &&
			ms(decision.recordedAt) >= ms(expected.bCreateAt))
	)
		fail("r5 decision must follow A' terminal sealing and precede B creation");
	if (canonicalJson(decision.aDigests) !== canonicalJson(expected.aDigests))
		fail("r5 decision A' digests differ from replayed authority");
	for (const [key, value] of Object.entries(
		expectedR5DecisionFields(input.recomputed),
	))
		if (canonicalJson(decision[key]) !== canonicalJson(value))
			fail(`r5 decision ${key} differs from the A' recompute`);
	text(decision.scopeStatement, "r5 scope statement");
	text(decision.selectionExplanation, "r5 selection explanation");
	if (
		!Array.isArray(decision.alternatives) ||
		decision.alternatives.length !== R5_DECISION_ALTERNATIVES.length
	)
		fail("r5 decision must list every pre-registered alternative");
	const ids = new Set<string>();
	for (const value of decision.alternatives) {
		const alternative = exact(
				value,
				["id", "explanation", "evidencePaths", "files", "tests"],
				"r5 alternative",
			),
			id = text(alternative.id, "alternative ID");
		if (
			!(R5_DECISION_ALTERNATIVES as readonly string[]).includes(id) ||
			ids.has(id)
		)
			fail("r5 alternatives differ from the pre-registered set");
		ids.add(id);
		text(alternative.explanation, "alternative explanation");
		for (const key of ["evidencePaths", "files", "tests"]) {
			const paths = alternative[key];
			if (
				!Array.isArray(paths) ||
				paths.length === 0 ||
				paths.length > 128 ||
				new Set(paths).size !== paths.length ||
				!paths.every((path) => typeof path === "string")
			)
				fail(`r5 alternative lacks unique ${key}`);
			if (key === "evidencePaths")
				for (const path of paths) input.readEvidence(path);
		}
	}
	input.validateReviews(
		{ architect: input.architect, critic: input.critic },
		{
			sourceSha: expected.sourceSha,
			decisionSha256: digest(input.decisionBytes),
			decisionRecordedAt: decision.recordedAt as string,
			bCreateAt: expected.bCreateAt,
		},
	);
	return decision as unknown as R5CandidateDecisionRecord;
}
