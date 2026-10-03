/** Offline completion adapters. An outer verified manifest is required before any replay. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
	budgetPolicyArtifactSha256,
	G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA,
	validateBudgetPolicy,
	validatePriorSpendLedger,
	validateSpendLedger,
} from "./g6-c32-budget.ts";
import {
	makeCandidateAttributionWorkPlan,
	makeCapacityLadderWorkPlan,
	R5_LADDER_PLAN_IDS,
	type R5LadderPlanId,
} from "./g6-c32-capacity-work.ts";
import {
	loadRigStateFromJournal,
	validateG6DestructionReceipt,
} from "./g6-c32-digitalocean.ts";
import {
	CONNECT_PROBE_GATE_ID,
	validatePreparedConnectProbe,
	verifyBoundFreeze,
	verifyRetainedBoundFreeze,
} from "./g6-c32-freeze.ts";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
	requireDefined,
	validateEnvelope,
	validateOperationReceipt,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import {
	G6_C32_GATE_CATALOG,
	gateDefinitionSha256,
	validateGateReceipt,
} from "./g6-c32-gates.ts";
import { validateHostIdentityPacket } from "./g6-c32-host.ts";
import {
	buildProcessProofCases,
	exitCaseResult,
	LINUX_SUPERVISOR_SOURCE,
	parseLauncherReceipt,
	parseSupervisorReceipt,
	validateProofDescendant,
	validateProofOwner,
	validateSupervisorProcess,
} from "./g6-c32-linux-work-process-proof.ts";
import { isOwnedSupervisorToken } from "./g6-c32-operation.ts";
import {
	preparedCheckoutFromBoundHosts,
	preparedGateSshArgs,
} from "./g6-c32-prepared-command.ts";
import { verifyPreparedNativeProof } from "./g6-c32-prepared-proof.ts";
import { replayRigJournal } from "./g6-c32-rig-journal.ts";
import { validateDesiredRig } from "./g6-c32-rig-model.ts";
import { evaluateSendPathAttribution } from "./g6-c32-send-path-evaluate.ts";
import { verifyTerminalEvidence } from "./g6-c32-terminal-evidence.ts";
import {
	readWorkCellEvidence,
	readWorkExecution,
	verifyWorkFinal,
} from "./g6-c32-work-execution.ts";
import type { WorkPlan, WorkStep, WorkTarget } from "./g6-c32-work-plan.ts";
import { makeCandidateLadderWorkProfiles } from "./g6-c32-work-profile.ts";
import {
	evaluateR5Attribution,
	type R5Decision,
} from "./g6-capacity-attribution-r5.ts";
import type { CapacityGoalContract } from "./g6-capacity-goal-evaluate.ts";
import {
	contextFromBound,
	verifyCapacityHostReviews,
} from "./g6-capacity-host-review.ts";
import {
	assertNativeProofOutput,
	CAPACITY_NATIVE_PROOF_TESTS,
	capacityLocalProofArgv,
} from "./g6-capacity-proof-catalog.ts";
import {
	batchOwnershipTestsPassed,
	expectedR5LadderPlanId,
	isR5AttributionPlanId,
	isR5LadderPlanId,
	R5_VENDORED_WTRANSPORT_GATE_ID,
	type R5BOverride,
	r5CellSummaries,
	validateR5CandidateDecision,
	vendoredWtransportTestsPassed,
} from "./g6-capacity-r5-decision.ts";
import { validateCapacityRawCell } from "./g6-capacity-raw-cell.ts";
import type { RawPairIdentity } from "./g6-capacity-raw-work.ts";
import {
	deriveWorkAuthority,
	readWorkAuthority,
} from "./g6-capacity-work-authority.ts";

export type CapacityCampaignReference = Readonly<{
	runRoot: string;
	boundRoot: string;
	policyPath: string;
}>;
export type CapacityDiagnosticCoverageRecord = Readonly<{
	schema: "g6-capacity-diagnostic-coverage/1";
	campaignA: CapacityCampaignReference;
	campaignB: CapacityCampaignReference;
}>;
export type CapacityWaiterSafetyRecord = Readonly<{
	schema: "g6-capacity-waiter-safety/1";
	campaignB: CapacityCampaignReference;
	preparedOriginPath: string;
	localNativeReceiptPath: string;
	localProofSourceRoot: string;
}>;
export type CapacitySameHostAuditRecord = Readonly<{
	schema: "g6-capacity-same-host-audit/1";
	campaignA: CapacityCampaignReference;
	campaignB: CapacityCampaignReference;
	decisionPath: string;
	architectPath: string;
	criticPath: string;
}>;
export type CapacityFinalTeardownRecord = Readonly<{
	schema: "g6-capacity-final-teardown/1";
	campaignA: CapacityCampaignReference;
	campaignB: CapacityCampaignReference;
	decisionPath: string;
	localProofSourceRoot: string;
}>;
export type CapacityGoalAdaptersInput = Readonly<{
	repoRoot: string;
	evidenceRoot: string;
	contract: CapacityGoalContract;
	verified: ReadonlyMap<string, string>;
}>;
/** r5 B ladder binding derived from the reviewed, recompute-equal A' decision. */
export type CapacityR5LadderBinding = Readonly<{
	sendPath: "stock" | "batch64";
	probeInB: boolean;
	calibrationDisposition: "non-interference" | "interference";
	/** E2: a probe-off ladder makes no detailed-probe mechanism claim. */
	mechanismClaim: "detailed-probe" | "none";
	/** Disclosed whenever B ran under a recorded user override of bGo=false. */
	bOverride?: R5BOverride;
}>;
export type CapacityGoalAdaptersResult = {
	fatalReasons: string[];
	pendingReasons: string[];
	r5?: CapacityR5LadderBinding;
};
type Row = Record<string, unknown>;
const SCHEMAS = {
	diagnostics: "g6-capacity-diagnostic-coverage/1",
	waiterSafety: "g6-capacity-waiter-safety/1",
	sameHostA: "g6-capacity-same-host-audit/1",
	finalTeardown: "g6-capacity-final-teardown/1",
} as const;
const digest = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
function fail(message: string): never {
	throw Error(`g6-capacity-goal-adapters: ${message}`);
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
function portable(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	)
		fail("unsafe evidence path");
	return value;
}
function ms(value: unknown): number {
	return Date.parse(validateRfc3339Millis(value, "adapter timestamp"));
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
function strings(value: unknown, label: string): string[] {
	if (
		!Array.isArray(value) ||
		!value.every((entry) => typeof entry === "string")
	)
		fail(`${label} must be a string array`);
	return value;
}
function hash(value: unknown): string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
		fail("invalid SHA-256 evidence identity");
	return value;
}
function same(left: unknown, right: unknown, label: string): void {
	if (canonicalJson(left) !== canonicalJson(right))
		fail(`${label} differs from replayed authority`);
}
function evidenceContext(input: CapacityGoalAdaptersInput) {
	for (const root of [input.repoRoot, input.evidenceRoot])
		if (lstatSync(root).isSymbolicLink()) fail("symlink root");
	const repoRoot = realpathSync(input.repoRoot),
		evidenceRoot = realpathSync(input.evidenceRoot);
	if (!evidenceRoot.startsWith(`${repoRoot}${sep}`))
		fail("evidence root escaped repository");
	function pathIn(root: string, value: string): string {
		const path = portable(value);
		let current = root;
		for (const part of path.split("/")) {
			current = join(current, part);
			if (lstatSync(current).isSymbolicLink())
				fail(`symlink evidence: ${path}`);
		}
		return current;
	}
	function readAbsolute(absolute: string): Buffer {
		const path = portable(
			relative(evidenceRoot, absolute).split(sep).join("/"),
		);
		const file = pathIn(evidenceRoot, path),
			stat = lstatSync(file);
		if (!stat.isFile()) fail(`non-file evidence: ${path}`);
		const bytes = readFileSync(file);
		if (input.verified.get(path) !== digest(bytes))
			fail(`${path} is not hash-verified by the final manifest`);
		return bytes;
	}
	const repoPath = (path: unknown) => pathIn(repoRoot, portable(path));
	const read = (path: unknown) => readAbsolute(repoPath(path));
	function json(path: unknown): unknown {
		const bytes = read(path);
		if (bytes.length > 256 * 1024 * 1024) fail("excessive JSON evidence");
		return JSON.parse(bytes.toString("utf8"));
	}
	function tree(path: string): string {
		const root = repoPath(path);
		portable(relative(evidenceRoot, root).split(sep).join("/"));
		if (!lstatSync(root).isDirectory())
			fail("referenced evidence tree is not a directory");
		const visit = (directory: string) => {
			for (const name of readdirSync(directory).sort()) {
				const next = join(directory, name),
					stat = lstatSync(next);
				if (stat.isSymbolicLink()) fail(`symlink evidence: ${next}`);
				if (stat.isDirectory()) visit(next);
				else readAbsolute(next);
			}
		};
		visit(root);
		return root;
	}
	return {
		...input,
		repoRoot,
		evidenceRoot,
		repoPath,
		read,
		json,
		tree,
		readAbsolute,
	};
}
type EvidenceContext = ReturnType<typeof evidenceContext>;
function campaignReference(
	context: EvidenceContext,
	value: unknown,
): CapacityCampaignReference {
	const ref = exact(
		value,
		["runRoot", "boundRoot", "policyPath"],
		"campaign reference",
	) as CapacityCampaignReference;
	context.tree(ref.runRoot);
	context.tree(ref.boundRoot);
	context.read(ref.policyPath);
	if (ref.boundRoot !== `${ref.runRoot}/bound`)
		fail("bound tree is not owned by the referenced provisioning run");
	return ref;
}

/** /2 approval must precede the retained pre-spawn intent, not just a later cell. */
function verifyCampaignHostReviews(
	context: EvidenceContext,
	reference: CapacityCampaignReference,
	bound: Parameters<typeof contextFromBound>[0],
	entryNodeId: string,
): void {
	const journal = replayRigJournal(
		context.json(`${reference.runRoot}/rig-state.json`),
	);
	const desired = validateDesiredRig(journal.desiredRigAuthority);
	const intents = journal.events.filter(
		(event) => event.envelope.operationId === "launch-locked-controller",
	);
	if (intents.length !== 1)
		fail(
			"host-review replay requires exactly one retained controller launch intent",
		);
	const intent = requireDefined(intents[0]);
	const result = object(
		object(intent.details, "launch intent details").result,
		"launch intent result",
	);
	const launch = exact(
		context.json(`${reference.runRoot}/controller-launch.json`),
		[
			"schema",
			"envelope",
			"pid",
			"processGroupId",
			"supervisorToken",
			"command",
			"args",
			"cwd",
			"deadline",
			"startedAt",
			"startedMonotonicNs",
			"operationSequence",
			"evidenceRoot",
		],
		"host-review controller launch",
	);
	const launchEnvelope = validateEnvelope(launch.envelope);
	const workPath = `${reference.runRoot}/campaign-${bound.runId}`;
	const workRoot = context.repoPath(workPath);
	const expectedArgs = [
		resolve(context.repoRoot, bound.semanticFreeze.authority.controller.path),
		"run",
		"--bound-root",
		context.repoPath(reference.boundRoot),
		"--repository",
		context.repoRoot,
		"--budget-policy",
		context.repoPath(reference.policyPath),
		"--spend-ledger",
		context.repoPath(`${reference.runRoot}/spend-ledger.json`),
		"--deadline",
		desired.deadline,
	];
	if (
		intent.kind !== "INTENT" ||
		intent.state !== "QUALIFYING" ||
		intent.envelope.phase !== "QUALIFYING" ||
		intent.envelope.runId !== bound.runId ||
		intent.envelope.clockSource !== "offrunner" ||
		result.boundRoot !== context.repoPath(reference.boundRoot) ||
		result.deadline !== desired.deadline ||
		desired.runId !== bound.runId ||
		desired.semantic.freezeAuthoritySha256 !==
			bound.semanticFreeze.authoritySha256 ||
		launch.schema !== "g6-c32-controller-launch/2" ||
		launchEnvelope.runId !== bound.runId ||
		launchEnvelope.phase !== "QUALIFYING" ||
		launchEnvelope.operationId !== "controller-launch" ||
		launchEnvelope.clockSource !== "offrunner" ||
		launchEnvelope.recordedAt !== launch.startedAt ||
		launch.operationSequence !== launchEnvelope.sequence ||
		!Number.isSafeInteger(launch.pid) ||
		finite(launch.pid, "controller pid") < 2 ||
		launch.processGroupId !== launch.pid ||
		!isOwnedSupervisorToken(launch.supervisorToken) ||
		!/^\d+$/.test(
			text(launch.startedMonotonicNs, "controller monotonic start"),
		) ||
		launch.command !== "bash" ||
		launch.cwd !== context.repoRoot ||
		launch.deadline !== desired.deadline ||
		launch.evidenceRoot !== workRoot ||
		canonicalJson(launch.args) !== canonicalJson(expectedArgs)
	)
		fail(
			"host-review launch evidence differs from its exact frozen controller/run",
		);
	const lock = exact(
		context.json(`${workPath}/qualification/lock-acquired.json`),
		["schema", "envelope"],
		"host-review first lock",
	);
	const lockEnvelope = validateEnvelope(lock.envelope);
	const firstStart = object(
		context.json(`${workPath}/work/${entryNodeId}/start.json`),
		"first work cell start",
	);
	if (
		lock.schema !== "g6-c32-lock-acquired/1" ||
		lockEnvelope.runId !== bound.runId ||
		lockEnvelope.phase !== "QUALIFYING" ||
		lockEnvelope.operationId !== "bench-lock" ||
		lockEnvelope.clockSource !== "offrunner" ||
		firstStart.nodeId !== entryNodeId ||
		ms(intent.envelope.recordedAt) > ms(launch.startedAt) ||
		ms(launch.startedAt) > ms(lockEnvelope.recordedAt) ||
		ms(lockEnvelope.recordedAt) > ms(firstStart.startedAt) ||
		context
			.read(`${workPath}/qualification/bench-lock.stdout`)
			.toString("utf8") !== "LOCKED\n"
	)
		fail("host-review launch/first-lock timing is missing or out of order");
	context.read(`${workPath}/qualification/bench-lock.stderr`);
	verifyCapacityHostReviews({
		reviewRoot: context.repoPath(`${reference.runRoot}/host-reviews`),
		context: contextFromBound(bound),
		// Strictly before the pre-spawn intent, even when wall timestamps coincide.
		now: new Date(ms(intent.envelope.recordedAt) - 1).toISOString(),
		read: context.readAbsolute,
	});
}

function loadCampaign(
	context: EvidenceContext,
	value: unknown,
	lane: "A" | "B",
) {
	const reference = campaignReference(context, value),
		root = context.repoPath(reference.runRoot),
		boundRoot = context.repoPath(reference.boundRoot);
	// All raw dependencies are checked above before existing verifiers can read them.
	const bound =
		lane === "A"
			? verifyRetainedBoundFreeze(boundRoot, {
					repositoryPath: context.repoRoot,
				})
			: verifyBoundFreeze(boundRoot, { repositoryPath: context.repoRoot });
	const sourceSha = bound.semanticFreeze.authority.candidate.commit,
		runId = bound.runId;
	if (
		lane === "B" &&
		(sourceSha !== context.contract.objective.sourceSha ||
			runId !== context.contract.ladder.runId)
	)
		fail("B freeze is not the final contract candidate/run");
	if (
		lane === "B" &&
		bound.semanticFreeze.authority.plan.sha256 !==
			context.contract.objective.planSha256
	)
		fail("B frozen plan digest differs from the contract objective");
	const policyBytes = context.read(reference.policyPath),
		policy = validateBudgetPolicy(JSON.parse(policyBytes.toString("utf8")));
	if (
		policy.schema !== "g6-c32-budget-policy/2" ||
		policy.lifecycle !== (lane === "A" ? "attribution-only" : "ladder-only") ||
		policy.runId !== runId ||
		bound.semanticFreeze.authority.budgetPolicy.sha256 !== digest(policyBytes)
	)
		fail(`${lane} policy differs from its frozen /2 authority`);
	if (
		policy.totalBudgetMicrousd !==
			context.contract.objective.aggregateBudgetMicrousd ||
		(lane === "A" &&
			policy.spentBeforeMicrousd !==
				context.contract.objective.sealedPriorSpendMicrousd)
	)
		fail(`${lane} budget differs from the immutable goal ceiling/prior spend`);
	if (lane === "A" && isR5AttributionPlanId(policy.workPlan.id)) {
		// r5 chains A' to the exact sealed prior final ledger (A08 for r5).
		if (!policy.priorLedger)
			fail("A' policy lacks its sealed prior spend ledger chain");
		validatePriorSpendLedger(policy, context.json(policy.priorLedger.path));
	}
	for (const profile of Object.values(policy.workProfiles))
		for (const [key, expected] of Object.entries(
			context.contract.ladder.profile,
		))
			if (
				!(
					lane === "A" &&
					[
						"udpSendBatch",
						"reflectRingBypass",
						"detailedProbe",
						"datagramPump",
						"clientProcesses",
					].includes(key)
				) &&
				(profile as unknown as Row)[key] !== expected
			)
				fail(
					`${lane} common ${key} knob differs from the approved goal profile`,
				);
	verifyCampaignHostReviews(context, reference, bound, policy.workPlan.entry);
	const pair = Object.fromEntries(
		(["server", "generator"] as const).map((role) => {
			const host = bound.hostBinding.authority.hosts[role],
				packet = validateHostIdentityPacket(
					context.json(`${reference.boundRoot}/${host.identityPacket.path}`),
				);
			if (
				packet.source.commit !== sourceSha ||
				packet.envelope.runId !== runId ||
				packet.provider.role !== role ||
				packet.provider.size !== "g5-48vcpu-96gb-80gb" ||
				packet.provider.region !== "ric1" ||
				packet.provider.vcpus !== 48 ||
				packet.provider.memoryMiB !== 98304 ||
				packet.runtime.os !== "Linux"
			)
				fail(
					`${lane} prepared ${role} differs from its exact approved pair/source`,
				);
			return [role, packet];
		}),
	) as RawPairIdentity;
	const ledger = validateSpendLedger(
		context.json(`${reference.runRoot}/spend-ledger.json`),
		{ requireSeal: true },
	).entries;
	if (
		ledger.some(
			(entry) =>
				entry.budgetPolicySha256 !== budgetPolicyArtifactSha256(policy) ||
				entry.runId !== runId ||
				entry.campaignId !== policy.campaignId,
		)
	)
		fail(`${lane} ledger differs from policy/run`);
	const terminal = verifyTerminalEvidence(root),
		destruction = validateG6DestructionReceipt(
			context.json(`${reference.runRoot}/destruction-receipt.json`),
		);
	const ids = [pair.server.provider.id, pair.generator.provider.id].sort(
		(a, b) => a - b,
	);
	if (new Set(ids).size !== 2 || terminal.runId !== runId)
		fail(`${lane} terminal belongs to another pair/run`);
	same(terminal.deletedIds, ids, `${lane} exact terminal deletion IDs`);
	const rig = loadRigStateFromJournal(
		context.repoPath(`${reference.runRoot}/rig-state.json`),
	);
	// Terminal evidence attests exact resource absence and immutable bytes only.
	// Emergency provider teardown must not upgrade an uncontained/incomplete run.
	if (rig.evidence.controllerExited !== true)
		fail(
			`${lane} controller exit is unproven despite verified provider teardown`,
		);
	const preSeal = object(
		context.json(
			`${reference.runRoot}/${terminal.preSealRoot}/seal-receipt.json`,
		),
		`${lane} pre-destroy seal`,
	);
	const preSealEnvelope = validateEnvelope(preSeal.envelope);
	if (
		preSeal.schema !== "g6-c32-offrunner-seal/1" ||
		preSealEnvelope.runId !== runId ||
		preSealEnvelope.phase !== "FINAL" ||
		preSealEnvelope.operationId !== "offrunner-evidence-seal" ||
		preSealEnvelope.clockSource !== "offrunner" ||
		!terminalStatuses(lane, policy).includes(String(preSeal.status)) ||
		preSeal.finalGatesComplete !== true ||
		preSeal.evidenceCollectionComplete !== true ||
		preSeal.finalGateError !== null ||
		rig.evidence.offrunnerEvidenceSealed !== true ||
		ms(preSealEnvelope.recordedAt) > ms(destruction.verifiedAbsentAt)
	)
		fail(`${lane} pre-destroy campaign seal is incomplete`);
	if (
		rig.desired.semantic.freezeAuthoritySha256 !==
			bound.semanticFreeze.authoritySha256 ||
		rig.desired.semantic.freezeArtifactSha256 !==
			canonicalArtifactSha256(bound.semanticFreeze) ||
		rig.desired.budget.policySha256 !== budgetPolicyArtifactSha256(policy)
	)
		fail(
			`${lane} final journal was created under different source/budget authority`,
		);
	const seal = requireDefined(ledger.at(-1));
	if (
		seal.schema !== G6_C32_WORK_SPEND_LEDGER_SEAL_SCHEMA ||
		canonicalArtifactSha256(seal.settlement.policy) !==
			canonicalArtifactSha256(policy) ||
		seal.settlement.overrunMicrousd !== 0
	)
		fail(`${lane} lacks its exact within-budget /2 paid settlement`);
	const firstCreate = ledger.find((entry) => entry.event === "CREATE_INTENT");
	if (!firstCreate) fail(`${lane} lacks paid CREATE_INTENT authority`);
	const workPath = `${reference.runRoot}/campaign-${runId}`,
		workRoot = context.repoPath(workPath);
	const workAuthority = deriveWorkAuthority(bound);
	same(
		readWorkAuthority(workRoot),
		workAuthority,
		`${lane} execution capsule differs from independently verified BOUND authority`,
	);
	const final = verifyWorkFinal({ root: workRoot, policy, ledger });
	if (
		!terminalStatuses(lane, policy).includes(final.terminal) ||
		String(preSeal.status) !== final.terminal ||
		ms(final.recordedAt) > ms(preSealEnvelope.recordedAt)
	)
		fail(`${lane} raw work final is incomplete`);
	// Plan r5 T2.2: an r5 A' run may end early only because its final cell
	// graded INVALID; any other incomplete terminal stays refused.
	if (
		final.terminal === "INCOMPLETE" &&
		final.completed.at(-1)?.outcome !== "INVALID"
	)
		fail(`${lane} raw work final is incomplete`);
	const progress = readWorkExecution({
		root: workRoot,
		policy,
		ledger: ledger.filter(
			(entry) =>
				entry.event !== "SEAL" && ms(entry.recordedAt) <= ms(final.recordedAt),
		),
		now: final.recordedAt,
	});
	const { nativeProducerSha256, probeProducerSha256 } = workAuthority;
	if (
		progress.state.candidateSha !== sourceSha ||
		progress.state.registrationSha256 !==
			bound.dispatchFreeze.authority.views.registration.sha256 ||
		progress.state.nativeProducerSha256 !== nativeProducerSha256 ||
		progress.state.probeProducerSha256 !== probeProducerSha256
	)
		fail(
			`${lane} work state source/registration/producers differ from bound authority`,
		);
	if (lane === "B") {
		assertCapacityCompletionPrefix(policy.workPlan, final.completed);
		same(
			context.json(
				relative(
					context.repoRoot,
					resolve(
						context.evidenceRoot,
						context.contract.ladder.pairIdentityPath,
					),
				)
					.split(sep)
					.join("/"),
			),
			{ schema: "g6-capacity-pair-identity/1", ...pair },
			"B contract exact pair packets",
		);
		if (
			context.contract.ladder.registrationSha256 !==
				progress.state.registrationSha256 ||
			context.contract.ladder.probeProducerSha256 !== probeProducerSha256
		)
			fail("B contract producer/registration differs from frozen authority");
	}
	return {
		lane,
		reference,
		root,
		bound,
		policy,
		pair,
		ledger,
		seal,
		terminal,
		destruction,
		rig,
		firstCreate,
		sourceSha,
		workPath,
		workRoot,
		final,
		progress,
		workAuthority,
		nativeProducerSha256,
		probeProducerSha256,
	};
}
/** Accepted sealed terminals: B and historical A must complete; an r5 A' may stop at a final INVALID. */
function terminalStatuses(
	lane: "A" | "B",
	policy: { workPlan: { id: string } },
): string[] {
	if (lane === "B") return ["LADDER_COMPLETE"];
	return isR5AttributionPlanId(policy.workPlan.id)
		? ["ATTRIBUTION_COMPLETE", "INCOMPLETE"]
		: ["ATTRIBUTION_COMPLETE"];
}
type Campaign = ReturnType<typeof loadCampaign>;
function attribution(context: EvidenceContext, campaign: Campaign) {
	const result = evaluateSendPathAttribution({
		root: campaign.workRoot,
		policy: campaign.policy,
		ledger: campaign.ledger,
		boundHostPair: campaign.pair,
		workAuthority: campaign.workAuthority,
		nativeProducerSha256: campaign.nativeProducerSha256,
		probeProducerSha256: campaign.probeProducerSha256,
	});
	if (
		!result.evidenceValid ||
		result.attributionVerdict !== "VALID_PAIRED_ATTRIBUTION"
	)
		fail(`A attribution does not replay: ${result.reasons.join("; ")}`);
	for (const completion of campaign.progress.completions)
		diagnosticCell(context, campaign, completion.nodeId);
	return result;
}
const isR5 = (campaign: Campaign) =>
	isR5AttributionPlanId(campaign.policy.workPlan.id);
/** The named batch ownership tests passed in the source-bound local native receipt. */
function localBatchOwnership(
	context: EvidenceContext,
	sourceSha: string,
): boolean {
	try {
		const local = context.contract.localVerification.receipts.find(
			(row) => row.receiptKind === "candidate-local-native",
		);
		const native = object(context.json(local?.path), "local native receipt");
		const commands = Array.isArray(native.commands) ? native.commands : [];
		const command = object(commands[0], "native command"),
			out = context.read(command.stdoutPath),
			err = context.read(command.stderrPath);
		if (
			native.sourceSha !== sourceSha ||
			command.exitCode !== 0 ||
			command.signal ||
			digest(out) !== command.stdoutSha256 ||
			digest(err) !== command.stderrSha256
		)
			return false;
		assertNativeProofOutput(`${out}\n${err}`, false);
		return batchOwnershipTestsPassed(`${out}\n${err}`);
	} catch {
		return false;
	}
}
/** r5 A': recompute the pre-registered decision from validated raw cells only. */
function attributionR5(context: EvidenceContext, campaign: Campaign) {
	same(
		campaign.policy.workPlan,
		makeCandidateAttributionWorkPlan(),
		"A' r5 attribution DAG",
	);
	const cells = r5CellSummaries(
		campaign.progress.completions.map((completion) => ({
			nodeId: completion.nodeId,
			outcome: completion.grade.outcome,
			startedAt: completion.startedAt,
		})),
		(nodeId) => {
			const node = requireDefined(
				campaign.policy.workPlan.nodes.find((row) => row.id === nodeId),
			);
			return readWorkCellEvidence(
				campaign.workRoot,
				node,
				requireDefined(campaign.policy.workProfiles[node.profile]),
				campaign.workAuthority,
			);
		},
	);
	return evaluateR5Attribution({
		cells,
		expectedSourceSha: campaign.sourceSha,
		batchOwnershipTestsPassed: localBatchOwnership(context, campaign.sourceSha),
	});
}
/**
 * B exists only for a SELECTED decision that is go, or that carries a
 * validated recorded user override of bGo=false, and runs exactly its encoded
 * variant (with the override's generator process count, never otherwise).
 */
function assertR5Ladder(
	context: EvidenceContext,
	a: Campaign,
	b: Campaign,
	decision: R5Decision,
	bOverride: R5BOverride | undefined,
): CapacityR5LadderBinding {
	if (
		decision.status !== "SELECTED" ||
		(!decision.bGo && bOverride === undefined) ||
		(decision.bGo && bOverride !== undefined) ||
		decision.sendPath === null ||
		decision.probeInB === null
	)
		fail(
			`B exists although the A' decision is ${decision.status} with bGo=${decision.bGo}`,
		);
	const disposition = decision.calibration.disposition;
	if (
		disposition === "unmeasured" ||
		decision.probeInB !== (disposition === "non-interference")
	)
		fail("r5 probe choice differs from the recorded calibration disposition");
	const id = expectedR5LadderPlanId(decision.probeInB);
	if (b.policy.workPlan.id !== id)
		fail(`r5 B work plan must be ${id} for the recorded calibration`);
	same(b.policy.workPlan, makeCapacityLadderWorkPlan(id), "r5 B work DAG");
	if (b.sourceSha !== a.sourceSha)
		fail("r5 B source differs from the A' source (E1 continuity)");
	same(
		b.policy.workProfiles,
		makeCandidateLadderWorkProfiles(
			requireDefined(a.policy.workProfiles.Xoff),
			{
				sendPath: decision.sendPath,
				probe: decision.probeInB,
				...(bOverride ? { clientProcesses: bOverride.generatorProcesses } : {}),
			},
		),
		"r5 B candidate profile",
	);
	const profile = context.contract.ladder.profile;
	if (
		profile.clientProcesses !==
		(bOverride ? bOverride.generatorProcesses : undefined)
	)
		fail(
			"contract ladder clientProcesses differs from the recorded r5 B override",
		);
	if (
		profile.datagramPump !== "pump" ||
		profile.udpSendBatch !== (decision.sendPath === "batch64" ? 64 : 0) ||
		profile.reflectRingBypass !== "off"
	)
		fail("contract ladder profile differs from the r5 decision");
	return {
		sendPath: decision.sendPath,
		probeInB: decision.probeInB,
		calibrationDisposition: disposition,
		mechanismClaim: decision.probeInB ? "detailed-probe" : "none",
		...(bOverride ? { bOverride } : {}),
	};
}
function diagnosticCell(
	_context: EvidenceContext,
	campaign: Campaign,
	id: string,
): void {
	const node = requireDefined(
		campaign.policy.workPlan.nodes.find((node) => node.id === id),
	);
	const profile = requireDefined(campaign.policy.workProfiles[node.profile]);
	validateCapacityRawCell(
		readWorkCellEvidence(
			campaign.workRoot,
			node,
			profile,
			campaign.workAuthority,
		),
	);
}

function bindContractCells(context: EvidenceContext, campaign: Campaign): void {
	const completed = campaign.final.completed.map((step) =>
		requireDefined(
			campaign.policy.workPlan.nodes.find((node) => node.id === step.nodeId),
		),
	);
	const ladder = completed.filter((node) => node.kind === "ladder"),
		companions = completed.filter((node) => node.kind === "companion");
	if (
		context.contract.ladder.runs.length !== ladder.length ||
		(context.contract.ladder.companions?.length ?? 0) !== companions.length
	)
		fail("contract does not describe the exact final B work prefix");
	for (const [nodes, bindings] of [
		[ladder, context.contract.ladder.runs],
		[companions, context.contract.ladder.companions ?? []],
	] as const)
		for (const [index, node] of nodes.entries()) {
			const binding = requireDefined(bindings[index]),
				prefix = `${campaign.workPath}/work/${node.id}`;
			if (binding.label !== node.label)
				fail("contract work ordering differs from B");
			for (const [field, filename] of Object.entries({
				scanPath: "g6-sharded-scan.json",
				diagnosticPath: "g6-sharded-diagnostic.json",
				postRunSteeringPath: "post-run-steering.json",
				operationReceiptPath: "scan.receipt.json",
				probePath: "linux-probe.jsonl",
			})) {
				// An r5 probe-off cell retains no probe file: bind the exact path only.
				const absent =
					field === "probePath" &&
					isR5LadderPlanId(campaign.policy.workPlan.id) &&
					requireDefined(campaign.policy.workProfiles[node.profile])
						.detailedProbe === false;
				const actual = relative(
					context.evidenceRoot,
					absent
						? join(context.repoRoot, portable(`${prefix}/${filename}`))
						: context.repoPath(`${prefix}/${filename}`),
				)
					.split(sep)
					.join("/");
				if ((binding as unknown as Row)[field] !== actual)
					fail(`contract ${node.id}.${field} is not the verified work cell`);
			}
			// Raw goal identities are the contract's independently parsed wrapper; its
			// host contents must equal the host-bound packets, not a parallel pair.
			const identity = object(
				context.json(
					relative(
						context.repoRoot,
						resolve(context.evidenceRoot, binding.identityPath),
					)
						.split(sep)
						.join("/"),
				),
				"cell identity",
			);
			if (identity.schema !== "g6-capacity-pair-identity/1")
				fail("contract cell identity differs from B work");
			for (const role of ["server", "generator"] as const) {
				const host = validateHostIdentityPacket(identity[role]);
				if (host.envelope.runId !== campaign.bound.runId)
					fail("cell identity belongs to another run");
				for (const field of [
					"bootId",
					"provider",
					"source",
					"binary",
					"runtime",
				] as const)
					same(
						host[field],
						campaign.pair[role][field],
						"contract cell exact pair",
					);
			}
			diagnosticCell(context, campaign, node.id);
		}
}

function candidateDigests(
	context: EvidenceContext,
	campaign: Campaign,
	result: unknown,
): CapacityAttributionDigests {
	return {
		semanticFreezeArtifactSha256: canonicalArtifactSha256(
			campaign.bound.semanticFreeze,
		),
		hostBindingArtifactSha256: canonicalArtifactSha256(
			campaign.bound.hostBinding,
		),
		terminalReceiptSha256: digest(
			context.read(
				`${campaign.reference.runRoot}/terminal/terminal-receipt.json`,
			),
		),
		workFinalArtifactSha256: canonicalArtifactSha256(campaign.final),
		attributionArtifactSha256: canonicalArtifactSha256(result),
	};
}
function assertCampaignSequence(
	context: EvidenceContext,
	a: Campaign,
	b: Campaign,
): void {
	if (
		a.bound.runId === b.bound.runId ||
		a.policy.campaignId !== b.policy.campaignId ||
		[a.pair.server.provider.id, a.pair.generator.provider.id].some((id) =>
			[b.pair.server.provider.id, b.pair.generator.provider.id].includes(id),
		)
	)
		fail("A and B are not independent owned campaigns");
	if (
		ms(a.terminal.recordedAt) >= ms(b.firstCreate.recordedAt) ||
		ms(a.destruction.verifiedAbsentAt) >= ms(b.firstCreate.recordedAt)
	)
		fail("B creation precedes A verified terminal absence");
	const absence = b.rig.preCreateBudgetAuthority?.absenceProof;
	if (
		!absence ||
		absence.liveProviderIds.length !== 0 ||
		ms(absence.recordedAt) < ms(a.destruction.verifiedAbsentAt) ||
		ms(absence.recordedAt) > ms(b.firstCreate.recordedAt)
	)
		fail("B creation lacks fresh post-A empty managed inventory");
	const prior = b.policy.priorLedger;
	if (
		!prior ||
		prior.path !== `${a.reference.runRoot}/terminal/final-spend-ledger.json`
	)
		fail("B prior ledger is not the exact A terminal snapshot");
	const summary = validatePriorSpendLedger(b.policy, context.json(prior.path));
	same(summary.entries, a.ledger, "B prior exact A actual ledger");
	if (b.policy.spentBeforeMicrousd !== a.terminal.sealedTotalMicrousd)
		fail("B did not chain A actual paid spend");
}

/** Cover the complete final Git source tree, including local proof/test sources, before replay. */
export function verifyCapacityLocalProofSource(
	input: CapacityGoalAdaptersInput & { sourceRoot: string; sourceSha: string },
): void {
	const context = evidenceContext(input),
		root = context.tree(input.sourceRoot);
	portable(relative(context.evidenceRoot, root).split(sep).join("/"));
	if (!/^[a-f0-9]{40}$/.test(input.sourceSha))
		fail("invalid local source commit");
	const git = (...args: string[]) => {
		const result = spawnSync(
			"git",
			["--no-replace-objects", "-C", context.repoRoot, ...args],
			{ encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30000 },
		);
		if (result.error || result.status !== 0)
			fail("cannot verify final local proof Git source");
		return result.stdout;
	};
	if (
		git("rev-parse", "--verify", `${input.sourceSha}^{commit}`).trim() !==
		input.sourceSha
	)
		fail("local proof source is not a commit");
	const entries = git("ls-tree", "-r", "-z", input.sourceSha)
		.split("\0")
		.filter(Boolean);
	if (!entries.length) fail("local proof source tree is empty");
	for (const row of entries) {
		const match = /^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(row);
		if (!match)
			fail("local proof source contains unsupported symlink/submodule inputs");
		const path = portable(match[3]),
			bytes = context.read(`${input.sourceRoot}/${path}`),
			oid = createHash("sha1")
				.update(`blob ${bytes.length}\0`)
				.update(bytes)
				.digest("hex");
		if (
			oid !== match[2] ||
			Boolean(
				lstatSync(context.repoPath(`${input.sourceRoot}/${path}`)).mode & 0o111,
			) !==
				(match[1] === "100755")
		)
			fail(`local proof source differs from final Git blob: ${path}`);
	}
}
function verifyLocalReceipts(context: EvidenceContext): void {
	for (const binding of context.contract.localVerification.receipts) {
		const receipt = object(context.json(binding.path), "local proof receipt");
		if (
			receipt.kind !== binding.receiptKind ||
			receipt.sourceSha !== context.contract.objective.sourceSha ||
			!Array.isArray(receipt.commands)
		)
			fail("local proof receipt source/kind differs");
		for (const raw of receipt.commands) {
			const command = object(raw, "local proof command");
			if (
				digest(context.read(command.stdoutPath)) !==
					hash(command.stdoutSha256) ||
				digest(context.read(command.stderrPath)) !== hash(command.stderrSha256)
			)
				fail("local proof output differs from hash-bound command");
		}
	}
}

function waiterSafety(
	context: EvidenceContext,
	record: CapacityWaiterSafetyRecord,
	b: Campaign,
): void {
	if (
		Object.values(b.policy.workProfiles).some(
			(profile) =>
				profile.reflectRingBypass !== "off" ||
				profile.nativeDiagnostics !== true,
		)
	)
		fail("final candidate must retire peer hints and retain native coverage");
	const local = context.contract.localVerification.receipts.find(
			(row) => row.receiptKind === "candidate-local-native",
		),
		linux = context.contract.localVerification.receipts.find(
			(row) => row.receiptKind === "candidate-local-linux",
		);
	if (!local || !linux || record.localNativeReceiptPath !== local.path)
		fail("waiter proof differs from the contract local native receipt");
	const native = object(context.json(local.path), "local native receipt"),
		argv = capacityLocalProofArgv("candidate-local-native");
	if (
		native.schema !== "g6-capacity-execution-receipt/1" ||
		native.kind !== "candidate-local-native" ||
		native.sourceSha !== b.sourceSha ||
		!Array.isArray(native.commands) ||
		native.commands.length !== 3
	)
		fail("local waiter proof lacks exact final native execution");
	for (const [index, value] of native.commands.entries()) {
		const command = object(value, "native command"),
			commandArgv = strings(command.argv, "native command argv"),
			out = context.read(command.stdoutPath),
			err = context.read(command.stderrPath);
		same(
			[commandArgv[0]?.split("/").at(-1), ...commandArgv.slice(1)],
			argv[index],
			"local native command",
		);
		if (
			command.exitCode !== 0 ||
			command.signal ||
			digest(out) !== command.stdoutSha256 ||
			digest(err) !== command.stderrSha256
		)
			fail("native command failed or output digest changed");
		if (
			index === 0 &&
			assertNativeProofOutput(`${out}\n${err}`, false).passed <
				CAPACITY_NATIVE_PROOF_TESTS.length
		)
			fail("local native proof summary omits required executed tests");
		if (
			index === 1 &&
			(!["Linux", "Darwin"].includes(out.toString().trim()) ||
				out.toString().trim() !== native.platform ||
				err.toString().trim())
		)
			fail("local native platform is not witnessed");
		if (
			index === 2 &&
			(out.toString().trim() !== b.sourceSha || err.toString().trim())
		)
			fail("local native source command differs from final candidate");
	}
	const r5Batch =
		isR5LadderPlanId(b.policy.workPlan.id) &&
		Object.values(b.policy.workProfiles).some(
			(profile) => profile.udpSendBatch === 64,
		);
	if (r5Batch) {
		// r5 batch64 is admissible only with the named output-ownership tests
		// passing in both direct receipts (local native and prepared Linux).
		const outputs = [
			native,
			object(context.json(linux.path), "Linux proof"),
		].map((receipt) => {
			const command = object(
				Array.isArray(receipt.commands) ? receipt.commands[0] : null,
				"native proof command",
			);
			return `${context.read(command.stdoutPath)}\n${context.read(command.stderrPath)}`;
		});
		if (!outputs.every(batchOwnershipTestsPassed))
			fail("batch64 lacks passing named output-ownership test receipts");
	}
	const origin = object(
		context.json(record.preparedOriginPath),
		"prepared origin",
	);
	if (
		origin.boundRoot !== b.reference.boundRoot ||
		origin.proofPath !== linux.path ||
		origin.sourceSha !== b.sourceSha ||
		origin.serverId !== b.pair.server.provider.id ||
		origin.bootId !== b.pair.server.bootId
	)
		fail(
			"prepared Linux origin is not the contract's exact final server/source/receipt",
		);
	context.read(origin.knownHostsPath);
	context.read(origin.proofPath);
	const replay = verifyPreparedNativeProof(
		context.repoRoot,
		record.preparedOriginPath,
	);
	if (replay.proofPath !== linux.path)
		fail("prepared Linux replay selected a parallel proof");
	const id = "prepared-server-owned-process-proof",
		references = b.bound.hostBinding.authority.gates.receipts.filter(
			(row) => row.id === id,
		);
	if (references.length !== 1 || !references[0])
		fail("missing exact prepared Linux process gate");
	const reference = references[0],
		gate = validateGateReceipt(
			context.json(`${b.reference.boundRoot}/${reference.receipt.path}`),
		),
		operation = validateOperationReceipt(
			context.json(
				`${b.reference.boundRoot}/${reference.operationReceipt.path}`,
			),
		);
	const definition = requireDefined(
		G6_C32_GATE_CATALOG.gates.find((row) => row.id === id),
	);
	if (
		gate.gate.definitionSha256 !== gateDefinitionSha256(definition) ||
		gate.gateCatalogAuthoritySha256 !==
			canonicalAuthoritySha256(G6_C32_GATE_CATALOG) ||
		gate.result.operationReceiptArtifactSha256 !==
			canonicalArtifactSha256(operation) ||
		gate.result.verdict !== "PASS"
	)
		fail("Linux process gate differs from exact catalog/operation");
	for (const envelope of [gate.envelope, operation.envelope])
		if (
			envelope.runId !== b.bound.runId ||
			envelope.phase !== "PREPARED_HOST" ||
			envelope.operationId !== `gate-${id}` ||
			envelope.clockSource !== "offrunner"
		)
			fail("Linux process gate belongs to another prepared run");
	const setup = validateOperationReceipt(
		context.json(`${b.workPath}/${b.progress.state.setupReceipt.path}`),
	);
	if (
		operation.status.outcome !== "SUCCEEDED" ||
		operation.status.exitCode !== 0 ||
		operation.status.signal !== null ||
		ms(operation.finishedAt) > ms(setup.finishedAt) ||
		ms(operation.startedAt) < ms(b.firstCreate.recordedAt) ||
		BigInt(operation.durationMonotonicNs) > 35_000_000_000n
	)
		fail("Linux process gate is not a successful bounded pre-load operation");
	if (isR5LadderPlanId(b.policy.workPlan.id))
		verifyR5VendoredWtransportGate(context, b, setup.finishedAt);
	const sshArgs = preparedGateSshArgs({
		command: "bun",
		args: ["tools/load/g6-c32-linux-work-process-proof.ts"],
		remoteCwd: preparedCheckoutFromBoundHosts(
			b.bound.hostBinding.authority.hosts,
		),
		publicIpv4: b.pair.server.provider.publicIpv4,
		knownHostsPath: context.repoPath(origin.knownHostsPath),
	});
	const args = operation.action.environmentKeys.includes(
		"G6_C32_SSH_IDENTITY_PATH",
	)
		? ["-i", "<redacted-ssh-identity>", "-o", "IdentitiesOnly=yes", ...sshArgs]
		: sshArgs;
	same(operation.action.args, args, "prepared Linux process executable");
	if (operation.action.command !== "ssh" || operation.action.cwd !== ".")
		fail("wrong prepared Linux process command");
	for (const path of [operation.stdoutPath, operation.stderrPath])
		if (!path.startsWith(`${b.bound.runId}/operations/`))
			fail("Linux process output escaped its provisioning run");
	const provisioningRoot = dirname(b.root),
		stdout = context
			.readAbsolute(resolve(provisioningRoot, operation.stdoutPath))
			.toString("utf8"),
		stderr = context
			.readAbsolute(resolve(provisioningRoot, operation.stderrPath))
			.toString("utf8");
	if (stderr.trim() !== `g6-prepared-boot-id=${b.pair.server.bootId}`)
		fail("Linux process operation lacks exact prepared boot witness");
	const proof = JSON.parse(stdout);
	if (
		ms(proof.startedAt) < ms(operation.startedAt) ||
		ms(proof.finishedAt) > ms(operation.finishedAt)
	)
		fail("Linux process proof escaped its prepared operation");
	validateCapacityLinuxProcessProof(proof, {
		bootId: b.pair.server.bootId,
		proofSourceSha256: digest(
			context.read(
				`${b.reference.boundRoot}/semantic/inputs/tools/load/g6-c32-linux-work-process-proof.ts`,
			),
		),
		workRemoteSourceSha256: digest(
			context.read(
				`${b.reference.boundRoot}/semantic/inputs/tools/load/g6-c32-work-remote.ts`,
			),
		),
	});
	const connectReference = requireDefined(
		b.bound.hostBinding.authority.gates.receipts.find(
			(row) => row.id === CONNECT_PROBE_GATE_ID,
		),
	);
	const connectOperation = validateOperationReceipt(
		context.json(
			`${b.reference.boundRoot}/${connectReference.operationReceipt.path}`,
		),
	);
	if (
		ms(connectOperation.finishedAt) > ms(setup.finishedAt) ||
		ms(connectOperation.startedAt) < ms(b.firstCreate.recordedAt)
	)
		fail("connect probe is outside setup");
	const connectRaw = {
		knownHostsPath: context.repoPath(origin.knownHostsPath),
		stdout: context
			.readAbsolute(resolve(provisioningRoot, connectOperation.stdoutPath))
			.toString("utf8"),
		stderr: context
			.readAbsolute(resolve(provisioningRoot, connectOperation.stderrPath))
			.toString("utf8"),
	};
	same(
		connectRaw,
		context.json(
			`${b.reference.boundRoot}/gates/${CONNECT_PROBE_GATE_ID}.raw.json`,
		),
		"connect probe retained raw replay",
	);
	validatePreparedConnectProbe({
		operation: connectOperation,
		runId: b.bound.runId,
		server: b.pair.server,
		generator: b.pair.generator,
		...connectRaw,
		proofSourceSha256: digest(
			context.read(
				`${b.reference.boundRoot}/semantic/inputs/tools/load/g6-linux-probe-proof.ts`,
			),
		),
		producerSha256: digest(
			context.read(
				`${b.reference.boundRoot}/semantic/inputs/tools/load/g6-linux-probe.ts`,
			),
		),
		diagnosticSourceSha256: digest(
			context.read(
				`${b.reference.boundRoot}/semantic/inputs/tools/load/g6-sharded-diagnostic.ts`,
			),
		),
	});
	verifyCapacityLocalProofSource({
		...context,
		sourceRoot: record.localProofSourceRoot,
		sourceSha: b.sourceSha,
	});
	verifyLocalReceipts(context);
}

/** E3: r5 B's prepared host passed the exact-catalog vendored wtransport gate. */
function verifyR5VendoredWtransportGate(
	context: EvidenceContext,
	b: Campaign,
	setupFinishedAt: string,
): void {
	const id = R5_VENDORED_WTRANSPORT_GATE_ID,
		references = b.bound.hostBinding.authority.gates.receipts.filter(
			(row) => row.id === id,
		);
	if (references.length !== 1 || !references[0])
		fail("missing exact prepared vendored wtransport gate");
	const reference = references[0],
		gate = validateGateReceipt(
			context.json(`${b.reference.boundRoot}/${reference.receipt.path}`),
		),
		operation = validateOperationReceipt(
			context.json(
				`${b.reference.boundRoot}/${reference.operationReceipt.path}`,
			),
		);
	const definition = requireDefined(
		G6_C32_GATE_CATALOG.gates.find((row) => row.id === id),
	);
	if (
		gate.gate.id !== id ||
		gate.gate.definitionSha256 !== gateDefinitionSha256(definition) ||
		gate.gateCatalogAuthoritySha256 !==
			canonicalAuthoritySha256(G6_C32_GATE_CATALOG) ||
		gate.result.operationReceiptArtifactSha256 !==
			canonicalArtifactSha256(operation) ||
		gate.result.verdict !== "PASS"
	)
		fail("vendored wtransport gate differs from exact catalog/operation");
	for (const envelope of [gate.envelope, operation.envelope])
		if (
			envelope.runId !== b.bound.runId ||
			envelope.phase !== "PREPARED_HOST" ||
			envelope.operationId !== `gate-${id}` ||
			envelope.clockSource !== "offrunner"
		)
			fail("vendored wtransport gate belongs to another prepared run");
	if (
		operation.status.outcome !== "SUCCEEDED" ||
		operation.status.exitCode !== 0 ||
		operation.status.signal !== null ||
		ms(operation.finishedAt) > ms(setupFinishedAt) ||
		ms(operation.startedAt) < ms(b.firstCreate.recordedAt)
	)
		fail("vendored wtransport gate is not a successful pre-load operation");
	for (const path of [operation.stdoutPath, operation.stderrPath])
		if (!path.startsWith(`${b.bound.runId}/operations/`))
			fail("vendored wtransport output escaped its provisioning run");
	const provisioningRoot = dirname(b.root),
		[stdout, stderr] = [operation.stdoutPath, operation.stderrPath].map(
			(path) =>
				context.readAbsolute(resolve(provisioningRoot, path)).toString("utf8"),
		);
	if (!vendoredWtransportTestsPassed(`${stdout}\n${stderr}`))
		fail(
			"vendored wtransport gate lacks the named passing datagram-pump tests",
		);
}

export { validateCapacityDiagnosticCoverage } from "./g6-capacity-diagnostic-coverage.ts";

export type CapacityAttributionDigests = Readonly<{
	semanticFreezeArtifactSha256: string;
	hostBindingArtifactSha256: string;
	terminalReceiptSha256: string;
	workFinalArtifactSha256: string;
	attributionArtifactSha256: string;
}>;
export type CapacityCandidateDecision = Readonly<{
	schema: "g6-capacity-candidate-decision/1";
	recordedAt: string;
	sourceASha: string;
	sourceSha: string;
	aDigests: CapacityAttributionDigests;
	alternatives: readonly Readonly<{
		id: string;
		explanation: string;
		evidencePaths: readonly string[];
		files: readonly string[];
		tests: readonly string[];
	}>[];
	selectedAlternativeId: string;
	selectionExplanation: string;
}>;
export type CapacityCandidateReview = Readonly<{
	schema: "g6-capacity-candidate-review/1";
	role: "architect" | "critic";
	verdict: "APPROVE";
	unconditional: true;
	recordedAt: string;
	sourceSha: string;
	decisionSha256: string;
	afterArchitectReceiptArtifactSha256: string | null;
}>;
/** Sequential unconditional Architect then Critic approval of exact decision bytes. */
function validateCandidateReviews(
	input: { architect: unknown; critic: unknown },
	expected: {
		sourceSha: string;
		decisionSha256: string;
		decisionRecordedAt: string;
		bCreateAt: string | null;
	},
): void {
	const reviews = [input.architect, input.critic].map((value, index) => {
		const row = exact(
			value,
			[
				"schema",
				"role",
				"verdict",
				"unconditional",
				"recordedAt",
				"sourceSha",
				"decisionSha256",
				"afterArchitectReceiptArtifactSha256",
			],
			"candidate review",
		);
		if (
			row.schema !== "g6-capacity-candidate-review/1" ||
			row.role !== (index ? "critic" : "architect") ||
			row.verdict !== "APPROVE" ||
			row.unconditional !== true ||
			row.sourceSha !== expected.sourceSha ||
			row.decisionSha256 !== expected.decisionSha256
		)
			fail(
				"candidate review lacks unconditional exact source/decision approval",
			);
		if (
			ms(row.recordedAt) <= ms(expected.decisionRecordedAt) ||
			(expected.bCreateAt !== null &&
				ms(row.recordedAt) >= ms(expected.bCreateAt))
		)
			fail("candidate review is outside the post-decision/pre-create interval");
		return row;
	});
	if (
		requireDefined(reviews[0]).afterArchitectReceiptArtifactSha256 !== null ||
		requireDefined(reviews[1]).afterArchitectReceiptArtifactSha256 !==
			canonicalArtifactSha256(input.architect) ||
		ms(requireDefined(reviews[1]).recordedAt) <=
			ms(requireDefined(reviews[0]).recordedAt)
	)
		fail("candidate reviews are not sequential Architect then Critic");
}
/** Semantic choice remains a human review; the machine verifies the exact reviewed evidence graph. */
export function validateCapacityCandidateDecision(input: {
	decisionBytes: string | Buffer;
	architect: unknown;
	critic: unknown;
	expected: {
		sourceASha: string;
		sourceSha: string;
		aDigests: CapacityAttributionDigests;
		aSealedAt: string;
		bCreateAt: string;
	};
	readEvidence: (path: string) => Buffer;
}): CapacityCandidateDecision {
	const decision = exact(
			JSON.parse(input.decisionBytes.toString()),
			[
				"schema",
				"recordedAt",
				"sourceASha",
				"sourceSha",
				"aDigests",
				"alternatives",
				"selectedAlternativeId",
				"selectionExplanation",
			],
			"candidate decision",
		),
		expected = input.expected;
	if (
		decision.schema !== "g6-capacity-candidate-decision/1" ||
		decision.sourceASha !== expected.sourceASha ||
		decision.sourceSha !== expected.sourceSha
	)
		fail("candidate decision source binding differs");
	if (
		ms(decision.recordedAt) <= ms(expected.aSealedAt) ||
		ms(decision.recordedAt) >= ms(expected.bCreateAt)
	)
		fail(
			"candidate decision must follow A terminal sealing and precede B creation",
		);
	same(decision.aDigests, expected.aDigests, "candidate decision A digests");
	if (
		!Array.isArray(decision.alternatives) ||
		decision.alternatives.length < 2 ||
		decision.alternatives.length > 16
	)
		fail("candidate decision requires at least two bounded alternatives");
	const ids = new Set<string>();
	for (const value of decision.alternatives) {
		const alternative = exact(
				value,
				["id", "explanation", "evidencePaths", "files", "tests"],
				"candidate alternative",
			),
			id = text(alternative.id, "alternative ID");
		if (ids.has(id)) fail("duplicate candidate alternative");
		ids.add(id);
		text(alternative.explanation, "alternative explanation");
		for (const field of ["evidencePaths", "files", "tests"]) {
			const paths = alternative[field];
			if (
				!Array.isArray(paths) ||
				paths.length === 0 ||
				paths.length > 128 ||
				new Set(paths).size !== paths.length
			)
				fail(`candidate alternative lacks unique ${field}`);
			for (const path of paths) {
				portable(path);
				if (field === "evidencePaths") input.readEvidence(path);
			}
		}
	}
	if (!ids.has(text(decision.selectedAlternativeId, "selected alternative")))
		fail("candidate selection is orphaned from reviewed alternatives");
	text(decision.selectionExplanation, "candidate selection explanation");
	validateCandidateReviews(
		{ architect: input.architect, critic: input.critic },
		{
			sourceSha: expected.sourceSha,
			decisionSha256: digest(input.decisionBytes),
			decisionRecordedAt: decision.recordedAt as string,
			bCreateAt: expected.bCreateAt,
		},
	);
	return decision as CapacityCandidateDecision;
}

/** Validate completed evidence; the goal evaluator separately determines 40k success eligibility. */
export function assertCapacityCompletionPrefix(
	plan: WorkPlan,
	completed: readonly WorkStep[],
): void {
	same(
		plan,
		makeCapacityLadderWorkPlan(
			(R5_LADDER_PLAN_IDS as readonly string[]).includes(plan.id)
				? (plan.id as R5LadderPlanId)
				: undefined,
		),
		"capacity work DAG",
	);
	let next: WorkTarget = plan.entry;
	for (const step of completed) {
		if (
			typeof next !== "string" ||
			next !== step.nodeId ||
			!["PASS", "MISS"].includes(step.outcome)
		)
			fail("capacity completion is not the exact accepted DAG prefix");
		const node = requireDefined(
			plan.nodes.find((row) => row.id === step.nodeId),
		);
		next = node.next[step.outcome];
	}
	if (typeof next === "string" || next.terminal !== "COMPLETE")
		fail("capacity completion lacks the required suffix");
}

/** Reconstruct safety from raw Linux process receipts; stored PASS/absence summaries are not authority. */
export function validateCapacityLinuxProcessProof(
	value: unknown,
	expected: {
		bootId: string;
		proofSourceSha256: string;
		workRemoteSourceSha256: string;
	},
): void {
	const proof = object(value, "Linux process proof");
	if (
		proof.schema !== "g6-c32-linux-work-process-proof/1" ||
		proof.platform !== "linux" ||
		proof.architecture !== "x64" ||
		proof.bootId !== expected.bootId ||
		proof.proofSourceSha256 !== hash(expected.proofSourceSha256) ||
		proof.workRemoteSourceSha256 !== hash(expected.workRemoteSourceSha256) ||
		proof.supervisorSourceSha256 !== digest(LINUX_SUPERVISOR_SOURCE) ||
		proof.error ||
		proof.refusal ||
		proof.cleanupError
	)
		fail("Linux process proof source/platform/boot authority differs");
	hash(proof.supervisorBinarySha256);
	if (
		proof.maximumDurationMs !== 30000 ||
		finite(proof.durationMs, "Linux proof duration") > 30000 ||
		ms(proof.finishedAt) < ms(proof.startedAt) ||
		ms(proof.finishedAt) - ms(proof.startedAt) > 30000
	)
		fail("Linux process proof exceeded its whole-proof bound");
	const root = text(proof.qualificationRoot, "Linux proof root"),
		runId = text(proof.runId, "Linux proof run ID");
	if (
		!/^\/(?:tmp|var\/tmp)\/g6-linux-work-process-[A-Za-z0-9_-]+$/.test(root) ||
		!/^process-proof-[A-Za-z0-9-]+$/.test(runId)
	)
		fail("Linux proof lacks an owned temporary namespace");
	function command(
		value: unknown,
		argv: readonly string[],
		expectedExit: number,
	) {
		const result = exact(
			value,
			[
				"argv",
				"pid",
				"exitCode",
				"signal",
				"timedOut",
				"outputTruncated",
				"stdout",
				"stderr",
				"durationMs",
				"error",
			],
			"Linux command",
		);
		same(result.argv, argv, "Linux executable command");
		if (
			typeof result.pid !== "number" ||
			!Number.isSafeInteger(result.pid) ||
			result.pid < 2 ||
			result.exitCode !== expectedExit ||
			result.signal !== null ||
			result.timedOut !== false ||
			result.outputTruncated !== false ||
			result.error !== null ||
			typeof result.stdout !== "string" ||
			typeof result.stderr !== "string" ||
			finite(result.durationMs, "Linux command duration") > 30000
		)
			fail("Linux command failed, truncated, or lacks process identity");
		return {
			argv: strings(result.argv, "Linux command argv"),
			pid: result.pid,
			exitCode: expectedExit,
			signal: null,
			timedOut: false,
			outputTruncated: false,
			stdout: result.stdout,
			stderr: result.stderr,
			durationMs: finite(result.durationMs, "Linux command duration"),
			error: null,
		};
	}
	const compile = object(proof.compile, "Linux supervisor compilation"),
		compileArgv = strings(compile.argv, "Linux compiler argv"),
		compiler = requireDefined(compileArgv[0]);
	if (!["/usr/bin/cc", "/usr/bin/clang"].includes(compiler))
		fail("unsupported Linux supervisor compiler");
	command(
		compile,
		[
			compiler,
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			`${root}/supervisor.c`,
			"-o",
			`${root}/supervisor`,
		],
		0,
	);
	const definitions = buildProcessProofCases(root, runId, expected.bootId);
	if (!Array.isArray(proof.cases) || proof.cases.length !== definitions.length)
		fail("Linux proof lacks all owned process cases");
	for (const [index, definition] of definitions.entries()) {
		const row = object(proof.cases[index], "Linux process case");
		if (
			row.id !== definition.id ||
			row.role !== definition.owner.role ||
			row.processGroupLeader !== definition.processGroupLeader ||
			row.launchCommand !== definition.launchCommand ||
			row.launchCommandSha256 !== digest(definition.launchCommand) ||
			row.cleanupCommandSha256 !== digest(definition.cleanupCommand) ||
			row.reason
		)
			fail("Linux process case order/owned executable differs");
		same(row.ownerAuthority, definition.owner, "Linux owner authority");
		const launch = object(row.launch, "Linux launch"),
			budget = Number(strings(launch.argv, "Linux launch argv")[2]);
		if (
			!Number.isSafeInteger(budget) ||
			budget < 1000 ||
			budget > 4000 ||
			finite(row.durationMs, "Linux case duration") > budget + 400
		)
			fail("Linux case lacks its bounded supervisor");
		const exit = index < 2 ? 1 : index < 4 ? 37 : 0;
		const completedLaunch = command(
			launch,
			[
				`${root}/supervisor`,
				definition.processGroupLeader ? "leader" : "ordinary",
				String(budget),
				`${definition.directory}/launch.sh`,
			],
			exit,
		);
		const supervisor = parseSupervisorReceipt(completedLaunch.stdout);
		validateSupervisorProcess(supervisor, completedLaunch);
		parseLauncherReceipt(
			completedLaunch.stdout,
			supervisor,
			definition.processGroupLeader,
		);
		if (index < 2) {
			const preserved =
				index === 1 ? "preexisting-owner-must-not-be-overwritten\n" : null;
			if (
				row.innerExecuted !== false ||
				row.preexistingOwnerRaw !== preserved ||
				row.ownerAfterRaw !== preserved
			)
				fail("failed owned startup executed inner work or overwrote authority");
			continue;
		}
		const owner = validateProofOwner(
			JSON.parse(text(row.ownerRaw, "raw process owner")),
			definition.owner,
			text(row.ownerStatRaw, "raw owner stat"),
		);
		if (index < 4) {
			const propagation = exitCaseResult(supervisor, owner.pid);
			if (
				!propagation.pass ||
				propagation.forked !== definition.processGroupLeader
			)
				fail(
					"Linux owned nonzero exit did not propagate through real setsid behavior",
				);
		} else {
			validateProofOwner(
				owner,
				definition.owner,
				text(row.liveOwnerStatRaw, "live owner stat"),
			);
			validateProofDescendant(
				owner,
				text(row.childStatRaw, "child stat"),
				text(row.liveChildStatRaw, "live child stat"),
			);
			command(row.cleanup, ["/bin/bash", "-c", definition.cleanupCommand], 0);
			command(
				row.repeatCleanup,
				["/bin/bash", "-c", definition.cleanupCommand],
				0,
			);
			if (row.ownerAfterRaw !== row.ownerRaw)
				fail("repeated Linux cleanup overwrote owner evidence");
			// The exact inner command cannot escape its group; the independently reaped
			// subreaper reports no remaining descendants after the observed live child.
			if (
				!supervisor.reaped.some(
					(child) =>
						child.pid === owner.pid &&
						child.startTicks === owner.startTicks &&
						child.processGroupId === owner.processGroupId,
				)
			)
				fail("Linux cleanup lacks an exact reaped owner");
		}
	}
}

export function evaluateCapacityGoalAdapters(
	input: CapacityGoalAdaptersInput,
): CapacityGoalAdaptersResult {
	const fatalReasons: string[] = [],
		pendingReasons: string[] = [];
	let context: EvidenceContext;
	try {
		context = evidenceContext(input);
	} catch (error) {
		return { fatalReasons: [String(error)], pendingReasons };
	}
	const references = new Map<"A" | "B", unknown>(),
		campaigns = new Map<"A" | "B", Campaign>();
	const get = (lane: "A" | "B", value: unknown): Campaign => {
		if (references.has(lane))
			same(references.get(lane), value, `${lane} references across adapters`);
		else references.set(lane, value);
		const existing = campaigns.get(lane);
		if (existing) return existing;
		const campaign = loadCampaign(context, value, lane);
		campaigns.set(lane, campaign);
		return campaign;
	};
	let auditedDecisionPath: string | null = null,
		r5: CapacityR5LadderBinding | undefined;
	const recordKeys = {
		diagnostics: ["schema", "campaignA", "campaignB"],
		waiterSafety: [
			"schema",
			"campaignB",
			"preparedOriginPath",
			"localNativeReceiptPath",
			"localProofSourceRoot",
		],
		sameHostA: [
			"schema",
			"campaignA",
			"campaignB",
			"decisionPath",
			"architectPath",
			"criticPath",
		],
		finalTeardown: [
			"schema",
			"campaignA",
			"campaignB",
			"decisionPath",
			"localProofSourceRoot",
		],
	} as const;
	for (const name of Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[]) {
		const binding = input.contract.pendingAdapters?.[name];
		if (!binding) {
			fatalReasons.push(`required adapter ${name} is missing`);
			continue;
		}
		try {
			const bytes = context.readAbsolute(
					resolve(context.evidenceRoot, portable(binding.path)),
				),
				value = exact(
					JSON.parse(bytes.toString("utf8")),
					recordKeys[name],
					name,
				);
			if (binding.schema !== SCHEMAS[name] || value.schema !== SCHEMAS[name])
				fail(`${name} adapter schema differs from contract`);
			if (name === "diagnostics") {
				const a = get("A", value.campaignA),
					b = get("B", value.campaignB);
				if (isR5(a)) attributionR5(context, a);
				else attribution(context, a);
				bindContractCells(context, b);
			} else if (name === "waiterSafety") {
				waiterSafety(
					context,
					value as CapacityWaiterSafetyRecord,
					get("B", value.campaignB),
				);
			} else if (name === "sameHostA") {
				const a = get("A", value.campaignA),
					b = get("B", value.campaignB);
				const readEvidence = (path: string) => {
					if (!portable(path).startsWith(`${a.workPath}/work/`))
						fail("candidate alternative is not linked to raw A work evidence");
					return context.read(path);
				};
				if (isR5(a)) {
					const decision = attributionR5(context, a);
					assertCampaignSequence(context, a, b);
					const decisionRecord = validateR5CandidateDecision({
						decisionBytes: context.read(value.decisionPath),
						architect: context.json(value.architectPath),
						critic: context.json(value.criticPath),
						recomputed: decision,
						expected: {
							sourceSha: a.sourceSha,
							aDigests: candidateDigests(context, a, decision),
							aSealedAt: a.terminal.recordedAt,
							bCreateAt: b.firstCreate.recordedAt,
						},
						readEvidence,
						readAuthority: (path) => context.read(path),
						validateReviews: validateCandidateReviews,
					});
					r5 = assertR5Ladder(
						context,
						a,
						b,
						decision,
						decisionRecord.bOverride,
					);
				} else {
					if (b.policy.workPlan.id !== "g6-capacity-ladder-b")
						fail("historical A requires the historical B ladder plan");
					const result = attribution(context, a);
					assertCampaignSequence(context, a, b);
					validateCapacityCandidateDecision({
						decisionBytes: context.read(value.decisionPath),
						architect: context.json(value.architectPath),
						critic: context.json(value.criticPath),
						expected: {
							sourceASha: a.sourceSha,
							sourceSha: b.sourceSha,
							aDigests: candidateDigests(context, a, result),
							aSealedAt: a.terminal.recordedAt,
							bCreateAt: b.firstCreate.recordedAt,
						},
						readEvidence,
					});
				}
				auditedDecisionPath = portable(value.decisionPath);
			} else {
				const a = get("A", value.campaignA),
					b = get("B", value.campaignB);
				assertCampaignSequence(context, a, b);
				if (!auditedDecisionPath || value.decisionPath !== auditedDecisionPath)
					fail(
						"final teardown lacks the exact independently reviewed candidate decision",
					);
				context.read(value.decisionPath);
				const spend = relative(
						context.evidenceRoot,
						context.repoPath(
							`${b.reference.runRoot}/terminal/final-spend-ledger.json`,
						),
					)
						.split(sep)
						.join("/"),
					seal = relative(
						context.evidenceRoot,
						context.repoPath(
							`${b.reference.runRoot}/terminal/spend-seal-receipt.json`,
						),
					)
						.split(sep)
						.join("/");
				if (
					context.contract.finalAudit.spendLedgerPath !== spend ||
					context.contract.finalAudit.sealReceiptPath !== seal
				)
					fail(
						"contract final spend/seal is not B's actual terminal settlement",
					);
				verifyCapacityLocalProofSource({
					...context,
					sourceRoot: portable(value.localProofSourceRoot),
					sourceSha: b.sourceSha,
				});
				verifyLocalReceipts(context);
				// Recheck the complete referenced trees after all dependency readers have
				// returned. A publication/concurrent mutation never silently uses a cache.
				context.tree(a.reference.runRoot);
				context.tree(b.reference.runRoot);
			}
		} catch (error) {
			fatalReasons.push(
				`${name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return r5 && fatalReasons.length === 0
		? { fatalReasons, pendingReasons, r5 }
		: { fatalReasons, pendingReasons };
}
