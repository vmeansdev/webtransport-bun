/** Synthetic offline A/B lifecycle. No controller, SSH, cloud, or Linux process is executed. */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
	appendSpendLedgerEntry,
	budgetPolicyArtifactSha256,
	evaluateWorkAdmission,
	sealWorkSpendLedger,
	validateBudgetPolicy,
} from "./g6-c32-budget.ts";
import {
	makeCandidateAttributionWorkPlan,
	makeCapacityLadderWorkPlan,
	type R5LadderPlanId,
} from "./g6-c32-capacity-work.ts";
import { createCellAdmission } from "./g6-c32-cell-admission.ts";
import {
	cleanScan,
	diagnosticFixture,
	steeringDump,
} from "./g6-c32-evaluator-fixture.test-helper.ts";
import {
	bindHostFreeze,
	createSemanticFreeze,
	DEFAULT_CAMPAIGN_INPUT_PATHS,
	verifyBoundFreeze,
} from "./g6-c32-freeze.ts";
import {
	canonicalArtifactSha256,
	canonicalJson,
	makeArtifactManifestRecord,
	makeAuthorityRecord,
	requireDefined,
	validateOperationReceipt,
} from "./g6-c32-freeze-model.ts";
import { G6_C32_GATE_CATALOG, runGatePhase } from "./g6-c32-gates.ts";
import {
	buildProcessProofCases,
	LINUX_SUPERVISOR_SOURCE,
} from "./g6-c32-linux-work-process-proof.ts";
import { preparedGateSshArgs } from "./g6-c32-prepared-command.ts";
import {
	collectPreparedNativeProof,
	PREPARED_NATIVE_GATE_IDS,
} from "./g6-c32-prepared-proof.ts";
import {
	appendRigJournalEvent,
	initializeRigJournal,
} from "./g6-c32-rig-journal.ts";
import { validateDesiredRig, validateRigState } from "./g6-c32-rig-model.ts";
import { evaluateSendPathAttribution } from "./g6-c32-send-path-evaluate.ts";
import { sendPathFixture } from "./g6-c32-send-path-fixture.test-helper.ts";
import { publishTerminalEvidence } from "./g6-c32-terminal-evidence.ts";
import {
	createWorkFinal,
	readWorkCellEvidence,
} from "./g6-c32-work-execution.ts";
import {
	operationFixture,
	workClockDomainFixture,
} from "./g6-c32-work-fixture.test-helper.ts";
import { gradeWorkCell } from "./g6-c32-work-grade.ts";
import type { WorkOutcome, WorkTarget } from "./g6-c32-work-plan.ts";
import {
	makeCandidateAttributionWorkProfiles,
	makeCandidateLadderWorkProfiles,
	type WorkProfile,
} from "./g6-c32-work-profile.ts";
import { evaluateR5Attribution } from "./g6-capacity-attribution-r5.ts";
import {
	type CapacityGoalContract,
	G6_CAPACITY_GOAL_CONTRACT_SCHEMA,
} from "./g6-capacity-goal-evaluate.ts";
import {
	type CapacityHostReviewRecord,
	contextFromBound,
} from "./g6-capacity-host-review.ts";
import {
	CAPACITY_HARNESS_PROOF_FILES,
	CAPACITY_LINUX_PROOF_TESTS,
	CAPACITY_NATIVE_PROOF_TESTS,
	capacityLocalProofArgv,
} from "./g6-capacity-proof-catalog.ts";
import {
	expectedR5DecisionFields,
	expectedR5LadderPlanId,
	extractR5CellSummary,
	R5_CANDIDATE_DECISION_SCHEMA,
	R5_DECISION_ALTERNATIVES,
	R5_VENDORED_WTRANSPORT_GATE_ID,
	R5_VENDORED_WTRANSPORT_TESTS,
} from "./g6-capacity-r5-decision.ts";
import { deriveWorkAuthority } from "./g6-capacity-work-authority.ts";
import { linuxProbeFixtureText } from "./g6-linux-probe-fixture.ts";
import { linuxProbeProofFixture } from "./g6-linux-probe-proof.fixture.test-helper.ts";
import { LatencyHistogram } from "./latency-histogram.ts";

type Row = Record<string, unknown>;
function record(value: unknown): Row {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("synthetic fixture expected a record");
	return value as Row;
}
function fixtureRecords(value: unknown): Row[] {
	if (!Array.isArray(value))
		throw Error("synthetic fixture expected record array");
	return value.map(record);
}
function fixtureText(value: unknown): string {
	if (typeof value !== "string") throw Error("synthetic fixture expected text");
	return value;
}
function fixtureNumber(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw Error("synthetic fixture expected a finite number");
	return value;
}
const sha = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
const json = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
const write = (root: string, path: string, value: unknown) => {
	const file = join(root, path);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		typeof value === "string" || Buffer.isBuffer(value)
			? value
			: canonicalJson(value),
	);
};
const binding = (root: string, path: string) => ({
	path,
	sha256: sha(readFileSync(join(root, path))),
});
function git(root: string, ...args: string[]) {
	const result = spawnSync("git", ["--no-replace-objects", ...args], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status !== 0)
		throw Error(`synthetic fixture Git: ${result.stderr}`);
	return result.stdout.trim();
}
const baseTime = Date.parse("2026-09-04T00:00:00.000Z");
const at = (seconds: number) =>
	new Date(baseTime + seconds * 1000).toISOString();
const envelope = (
	runId: string,
	sequence: number,
	phase: string,
	operationId: string,
	seconds: number,
) => ({
	recordedAt: at(seconds),
	runId,
	sequence,
	phase,
	operationId,
	clockSource: "offrunner" as const,
});
const nativeInputs = [
	"../../crates/native/src/send_path_diagnostics.rs",
	"../../crates/native/src/datagram_reflector.rs",
	"../../crates/native/src/udp_send_batch.rs",
	"../../crates/native/src/lib.rs",
	"../../crates/native/src/server_napi.rs",
	"g6-native-send-path.ts",
	"g6-shard-server.ts",
];
function producer(root: string) {
	const hash = createHash("sha256");
	for (const name of nativeInputs)
		hash
			.update(name)
			.update("\0")
			.update(
				sha(
					readFileSync(
						join(
							root,
							name.startsWith("../../") ? name.slice(6) : `tools/load/${name}`,
						),
					),
				),
			)
			.update("\n");
	return hash.digest("hex");
}

/** r5 synthetic A' arm metrics: a pre-registered selection, not a measurement. */
export type R5FixtureOptions = {
	/** Xon server CPU shift vs Xoff; >5% records probe interference. */
	calibration?: "non-interference" | "interference";
	/** XB ACK edge large enough (<=0.85x Xoff) to select batch64. */
	sendPath?: "stock" | "batch64";
	/** Run B under a different plan/variant than the decision selects. */
	bPlanId?: R5LadderPlanId;
	bProbe?: boolean;
	bSendPath?: "stock" | "batch64";
	/** Make A0 cheaper than C-PUMP so no candidate is selected. */
	noCandidate?: boolean;
	/** Replace the prepared vendored wtransport gate stdout (E3 tamper). */
	vendoredGateStdout?: string;
	/** Scale one A' cell's offered moves (offered-work parity edge). */
	offeredMovesSkew?: Readonly<Record<string, number>>;
};
function r5ArmMetrics(nodeId: string, r5: R5FixtureOptions) {
	const arm = requireDefined(nodeId.split("-")[0]);
	const pump = arm !== "A0";
	const generatorCpuMs = r5.noCandidate ? 200000 : pump ? 150000 : 200000;
	const serverCpuMs =
		arm === "Xon" && r5.calibration === "interference" ? 264000 : 240000;
	const ackMs =
		arm === "A0"
			? r5.noCandidate
				? 4
				: 20
			: arm === "XB" && r5.sendPath === "batch64"
				? 4
				: 10;
	return { generatorCpuMs, serverCpuMs, ackMs };
}
function histogramJson(ms: number): unknown {
	const histogram = new LatencyHistogram();
	for (let i = 0; i < 1000; i++) histogram.record(Math.round(ms * 1e6));
	return histogram.toJson();
}

/** Full approved 24-shard shape, with synthetic raw events rather than live measurements. */
export async function completeGoalAdaptersFixture(
	processProof: ReturnType<
		typeof syntheticLinuxProcessFixture
	>["proof"] = syntheticLinuxProcessFixture().proof,
	options: {
		bOutcomes?: Readonly<Record<string, WorkOutcome>>;
		realProducerSources?: boolean;
		preparedProcessCwd?: string;
		/** r5 A' (C-PUMP attribution) + recompute-bound decision + selected B. */
		r5?: R5FixtureOptions;
	} = {},
) {
	const r5 = options.r5;
	const repoRoot = realpathSync(
		mkdtempSync(join(tmpdir(), "g6-all-goal-adapters-")),
	);
	const evidenceRoot = join(repoRoot, "evidence");
	mkdirSync(evidenceRoot);
	const sourceRoot = "evidence/local/source";
	git(repoRoot, "init", "--quiet");
	git(repoRoot, "config", "user.name", "Synthetic G6 Adapter Test");
	git(repoRoot, "config", "user.email", "synthetic@example.invalid");
	for (const path of [
		...DEFAULT_CAMPAIGN_INPUT_PATHS,
		...CAPACITY_HARNESS_PROOF_FILES,
		"tools/load/g6-capacity-overload.test.ts",
		"tools/load/g6-c32-freeze.ts",
		"tools/load/g6-c32-rca-controller.sh",
	])
		write(repoRoot, path, `// Synthetic tracked source: ${path}\n`);
	if (options.realProducerSources)
		for (const name of [...nativeInputs, "g6-linux-probe.ts"]) {
			const path = name.startsWith("../../")
				? name.slice(6)
				: `tools/load/${name}`;
			write(repoRoot, path, readFileSync(join(import.meta.dir, "../..", path)));
		}
	write(repoRoot, ".gitignore", "evidence/\n");
	git(repoRoot, "add", ".");
	git(repoRoot, "commit", "--quiet", "-m", "Add synthetic source A");
	const raw = sendPathFixture();
	if (raw.policy.schema !== "g6-c32-budget-policy/2")
		throw Error("synthetic policy /2 required");
	let aPolicy = validateBudgetPolicy({
		...raw.policy,
		workProfiles: Object.fromEntries(
			Object.entries(raw.policy.workProfiles).map(([name, value]) => [
				name,
				{ ...value, shards: 24 },
			]),
		),
	});
	// r5 chains A' to a sealed prior ledger (A08 in the live campaign).
	const priorLedgerPath = "evidence/prior/final-spend-ledger.json";
	let r5Common: WorkProfile | null = null;
	if (r5) {
		const priorLedger = [
			appendSpendLedgerEntry(null, {
				recordedAt: at(-3600),
				campaignId: aPolicy.campaignId,
				runId: "synthetic-a08",
				budgetPolicySha256: "d".repeat(64),
				event: "SEAL",
				accruedLifecycleMicrousd: 0,
				prospectiveCellMicrousd: 0,
				teardownReserveMicrousd: 0,
				totalAuthorizedMicrousd: 104996710,
				remainingBudgetMicrousd: 28547456,
				decision: null,
			}),
		];
		write(repoRoot, priorLedgerPath, priorLedger);
		const common: WorkProfile = {
			...requireDefined(
				(aPolicy as { workProfiles: Record<string, WorkProfile> }).workProfiles[
					"stock-probe-off"
				],
			),
			datagramPump: "pump",
		};
		r5Common = common;
		const workPlan = makeCandidateAttributionWorkPlan();
		aPolicy = validateBudgetPolicy({
			...aPolicy,
			totalBudgetMicrousd: 133544166,
			spentBeforeMicrousd: 104996710,
			priorLedger: {
				path: priorLedgerPath,
				sha256: canonicalArtifactSha256(priorLedger),
				sealedSpentMicrousd: 104996710,
			},
			cellMaximumSeconds: { "attribution-r4": 420 },
			allowedStages: ["attribution-r4"],
			workPlan,
			workProfiles: makeCandidateAttributionWorkProfiles(common),
		});
	}
	const a = await campaign("A", 0, aPolicy);
	const candidateChangePath = options.realProducerSources
		? "crates/native/src/capacity_fixture_identity.rs"
		: "crates/native/src/datagram_reflector.rs";
	if (!r5) {
		write(
			repoRoot,
			candidateChangePath,
			"// Synthetic native-only candidate B\n",
		);
		git(repoRoot, "add", candidateChangePath);
		git(
			repoRoot,
			"commit",
			"--quiet",
			"-m",
			"Change synthetic native candidate B",
		);
	}
	const r5BSendPath = r5?.bSendPath ?? r5?.sendPath ?? "stock",
		r5BProbe = r5?.bProbe ?? r5?.calibration !== "interference";
	const profile = r5Common
		? requireDefined(
				makeCandidateLadderWorkProfiles(r5Common, {
					sendPath: r5BSendPath,
					probe: r5BProbe,
				}).candidate,
			)
		: {
				...(raw.policy.schema === "g6-c32-budget-policy/2"
					? requireDefined(raw.policy.workProfiles["stock-probe-on"])
					: {}),
				reflectRingBypass: "off",
				shards: 24,
			};
	const bPolicy = validateBudgetPolicy({
		...raw.policy,
		schema: "g6-c32-budget-policy/2",
		lifecycle: "ladder-only",
		spentBeforeMicrousd: a.terminal.sealedTotalMicrousd,
		maximumLifecycleSeconds: 7020,
		maximumLifecycleCostMicrousd: 8252460,
		cellMaximumSeconds: { ladder: 480, companion: 480 },
		allowedStages: ["ladder", "companion"],
		...(r5 ? { totalBudgetMicrousd: a.policy.totalBudgetMicrousd } : {}),
		workPlan: r5
			? makeCapacityLadderWorkPlan(
					r5.bPlanId ?? expectedR5LadderPlanId(r5BProbe),
				)
			: makeCapacityLadderWorkPlan(),
		workProfiles: { candidate: profile },
		priorLedger: {
			path: `${a.reference.runRoot}/terminal/final-spend-ledger.json`,
			sha256: canonicalArtifactSha256(a.ledger),
			sealedSpentMicrousd: a.terminal.sealedTotalMicrousd,
		},
	});
	const b = await campaign("B", 1800, bPolicy);
	const nativeReceipt = "evidence/local/native.json";
	const receipts = [];
	for (const kind of [
		"candidate-local-native",
		"harness-lifecycle",
		"bounded-overload",
	] as const) {
		const receiptPath =
			kind === "candidate-local-native"
				? nativeReceipt
				: `evidence/local/${kind}.json`;
		const commands = capacityLocalProofArgv(kind).map((argv, index) => {
			const stdoutPath = `evidence/local/${kind}-${index}.stdout`,
				stderrPath = `evidence/local/${kind}-${index}.stderr`;
			const stdout =
				index === 1
					? "Darwin\n"
					: index === 2
						? `${b.sourceSha}\n`
						: kind === "candidate-local-native"
							? nativeOutput(false)
							: `${argv
									.slice(2)
									.map(
										(file) =>
											`${file}:\n(pass) Synthetic offline fixture only\n`,
									)
									.join("\n")}\n${argv.length - 2} pass\n0 fail\n`;
			write(repoRoot, stdoutPath, stdout);
			write(repoRoot, stderrPath, "");
			return {
				argv,
				exitCode: 0,
				signal: null,
				durationMs: 1,
				stdoutPath,
				stderrPath,
				stdoutSha256: sha(stdout),
				stderrSha256: sha(""),
			};
		});
		write(repoRoot, receiptPath, {
			schema: "g6-capacity-execution-receipt/1",
			kind,
			sourceSha: b.sourceSha,
			phase: "LOCAL",
			platform: "Darwin",
			commands,
			liveEvidence: false,
			note: "Synthetic offline fixture, not an execution claim.",
		});
		receipts.push({ label: kind, receiptKind: kind, path: receiptPath });
	}
	receipts.push({
		label: "candidate-local-linux",
		receiptKind: "candidate-local-linux",
		path: `${b.reference.runRoot}/proofs/prepared-native.json`,
	});
	for (const row of git(repoRoot, "ls-tree", "-r", b.sourceSha).split("\n")) {
		const [metadata, path] = row.split("\t");
		if (!path) continue;
		write(
			repoRoot,
			`${sourceRoot}/${path}`,
			readFileSync(join(repoRoot, path)),
		);
		chmodSync(
			join(repoRoot, sourceRoot, path),
			requireDefined(metadata).startsWith("100755") ? 0o755 : 0o644,
		);
	}
	const aDigests = (attribution: unknown) => ({
		semanticFreezeArtifactSha256: canonicalArtifactSha256(
			a.bound.semanticFreeze,
		),
		hostBindingArtifactSha256: canonicalArtifactSha256(a.bound.hostBinding),
		terminalReceiptSha256: sha(
			readFileSync(
				join(repoRoot, a.reference.runRoot, "terminal/terminal-receipt.json"),
			),
		),
		workFinalArtifactSha256: canonicalArtifactSha256(a.final),
		attributionArtifactSha256: canonicalArtifactSha256(attribution),
	});
	const aCellPath = (nodeId: string) =>
		`${a.reference.runRoot}/campaign-${a.policy.runId}/work/${nodeId}/g6-sharded-scan.json`;
	let decision: Row,
		r5Decision: ReturnType<typeof evaluateR5Attribution> | null = null;
	if (r5) {
		const cells = a.final.completed.map(({ nodeId }) => {
			const node = requireDefined(
				a.policy.workPlan.nodes.find((row) => row.id === nodeId),
			);
			const completion = record(
				json(join(a.workRoot, "work", nodeId, "completion.json")),
			);
			return extractR5CellSummary(
				readWorkCellEvidence(
					a.workRoot,
					node,
					requireDefined(a.policy.workProfiles[node.profile]),
					a.workAuthority,
				),
				{
					outcome: record(completion.grade).outcome as WorkOutcome,
					startedAt: fixtureText(completion.startedAt),
				},
			);
		});
		r5Decision = evaluateR5Attribution({
			cells,
			expectedSourceSha: a.sourceSha,
			batchOwnershipTestsPassed: true,
		});
		decision = {
			schema: R5_CANDIDATE_DECISION_SCHEMA,
			recordedAt: at(1500),
			sourceSha: a.sourceSha,
			aDigests: aDigests(r5Decision),
			...expectedR5DecisionFields(r5Decision),
			scopeStatement:
				"Synthetic: A' attributes ACK hold, send path (stock vs batch64, no peer hint), datagram receive path and per-role CPU per offered datagram; the peer-hint arm is excluded and B runs reflectRingBypass off.",
			alternatives: R5_DECISION_ALTERNATIVES.map((id) => ({
				id,
				explanation: `Synthetic alternative ${id}, no product inference.`,
				evidencePaths: [aCellPath("Xoff-1"), aCellPath("A0-1")],
				files: ["crates/native/src/datagram_reflector.rs"],
				tests: ["tools/load/g6-capacity-goal-adapters.ts"],
			})),
			selectionExplanation:
				"Synthetic mechanical application of the pre-registered r5 rule.",
		};
	} else {
		const aResult = evaluateSendPathAttribution({
			root: a.workRoot,
			policy: a.policy,
			ledger: a.ledger,
			boundHostPair: a.pair,
			nativeProducerSha256: a.nativeProducer,
			probeProducerSha256: a.probeProducer,
			workAuthority: a.workAuthority,
		});
		if (
			!aResult.evidenceValid ||
			aResult.attributionVerdict !== "VALID_PAIRED_ATTRIBUTION"
		)
			throw Error(`synthetic A attribution: ${JSON.stringify(aResult)}`);
		decision = {
			schema: "g6-capacity-candidate-decision/1",
			recordedAt: at(1500),
			sourceASha: a.sourceSha,
			sourceSha: b.sourceSha,
			aDigests: aDigests(aResult),
			alternatives: ["selected", "not-selected"].map((id) => ({
				id,
				explanation: `Synthetic alternative ${id}, no product inference.`,
				evidencePaths: [aCellPath("A1-1")],
				files: ["crates/native/src/datagram_reflector.rs"],
				tests: ["tools/load/g6-capacity-goal-adapters.ts"],
			})),
			selectedAlternativeId: "selected",
			selectionExplanation:
				"Synthetic source-linked decision for adapter replay only.",
		};
	}
	const decisionPath = "evidence/decision.json";
	write(repoRoot, decisionPath, decision);
	const review = (role: string, seconds: number, after: string | null) => ({
		schema: "g6-capacity-candidate-review/1",
		role,
		verdict: "APPROVE",
		unconditional: true,
		recordedAt: at(seconds),
		sourceSha: b.sourceSha,
		decisionSha256: sha(readFileSync(join(repoRoot, decisionPath))),
		afterArchitectReceiptArtifactSha256: after,
	});
	const architect = review("architect", 1510, null);
	write(repoRoot, "evidence/candidate-architect.json", architect);
	write(
		repoRoot,
		"evidence/candidate-critic.json",
		review("critic", 1520, canonicalArtifactSha256(architect)),
	);
	const records = {
		diagnostics: {
			schema: "g6-capacity-diagnostic-coverage/1",
			campaignA: a.reference,
			campaignB: b.reference,
		},
		waiterSafety: {
			schema: "g6-capacity-waiter-safety/1",
			campaignB: b.reference,
			preparedOriginPath: `${b.reference.runRoot}/proofs/prepared-native-origin.json`,
			localNativeReceiptPath: nativeReceipt,
			localProofSourceRoot: sourceRoot,
		},
		sameHostA: {
			schema: "g6-capacity-same-host-audit/1",
			campaignA: a.reference,
			campaignB: b.reference,
			decisionPath,
			architectPath: "evidence/candidate-architect.json",
			criticPath: "evidence/candidate-critic.json",
		},
		finalTeardown: {
			schema: "g6-capacity-final-teardown/1",
			campaignA: a.reference,
			campaignB: b.reference,
			decisionPath,
			localProofSourceRoot: sourceRoot,
		},
	};
	const pendingAdapters: Row = {};
	for (const [key, value] of Object.entries(records)) {
		write(repoRoot, `evidence/${key}.json`, value);
		pendingAdapters[key] = { path: `${key}.json`, schema: value.schema };
	}
	const pairPath = "evidence/b-pair.json";
	write(repoRoot, pairPath, {
		schema: "g6-capacity-pair-identity/1",
		...b.pair,
	});
	const completedNodes = b.final.completed.map(({ nodeId }) =>
		requireDefined(b.policy.workPlan.nodes.find((node) => node.id === nodeId)),
	);
	const rawBinding = (nodeId: string, label: string) => {
		const prefix = `${b.reference.runRoot.slice("evidence/".length)}/campaign-${b.policy.runId}/work/${nodeId}`;
		return {
			label,
			identityPath: "b-pair.json",
			scanPath: `${prefix}/g6-sharded-scan.json`,
			diagnosticPath: `${prefix}/g6-sharded-diagnostic.json`,
			postRunSteeringPath: `${prefix}/post-run-steering.json`,
			operationReceiptPath: `${prefix}/scan.receipt.json`,
			probePath: `${prefix}/linux-probe.jsonl`,
		};
	};
	const runs = completedNodes
		.filter((node) => node.kind === "ladder")
		.map((node) => ({
			...rawBinding(node.id, node.label),
			rung: node.requestedSessions,
		}));
	const companions = completedNodes
		.filter((node) => node.kind === "companion")
		.map((node) => ({
			...rawBinding(node.id, node.label),
			requestedSessions: node.requestedSessions,
			activeWorkloadSessions: node.activeWorkloadSessions,
		}));
	const contract = {
		schema: G6_CAPACITY_GOAL_CONTRACT_SCHEMA,
		objective: {
			slug: "g6-40k-capacity-closure",
			sourceSha: b.sourceSha,
			planSha256: b.bound.semanticFreeze.authority.plan.sha256,
			specSha256: sha("Synthetic spec only"),
			evidenceRoot: "evidence",
			targetSessions: 40000,
			ceilingProbeSessions: 50000,
			aggregateBudgetMicrousd: a.policy.totalBudgetMicrousd,
			sealedPriorSpendMicrousd: a.policy.spentBeforeMicrousd,
			headroomMicrousd:
				a.policy.totalBudgetMicrousd - a.policy.spentBeforeMicrousd,
		},
		approvals: {
			semanticFreezeAuthoritySha256: b.bound.semanticFreeze.authoritySha256,
			architectPath: `${b.reference.runRoot}/architect.json`,
			criticPath: `${b.reference.runRoot}/critic.json`,
		},
		pendingAdapters,
		localVerification: { receipts },
		ladder: {
			runId: b.policy.runId,
			profile: Object.fromEntries(
				Object.entries(profile).filter(
					([key]) =>
						![
							"gradeMode",
							"receiveBufferBytes",
							"detailedProbe",
							"nativeDiagnostics",
						].includes(key),
				),
			),
			registrationSha256: b.registration,
			probeProducerSha256: b.probeProducer,
			pairIdentityPath: "b-pair.json",
			runs,
			companions,
		},
		finalAudit: {
			spendLedgerPath: `${b.reference.runRoot.slice(9)}/terminal/final-spend-ledger.json`,
			sealReceiptPath: `${b.reference.runRoot.slice(9)}/terminal/spend-seal-receipt.json`,
			artifactManifestPath: "outer-manifest.json",
		},
	} as unknown as CapacityGoalContract;
	const contractPath = join(repoRoot, "evidence/contract.json");
	write(repoRoot, "evidence/contract.json", contract);
	const verified = new Map<string, string>();
	const rehash = () => {
		verified.clear();
		const visit = (directory: string) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name);
				if (path === join(evidenceRoot, "outer-manifest.json")) continue;
				if (entry.isDirectory()) visit(path);
				else
					verified.set(relative(evidenceRoot, path), sha(readFileSync(path)));
			}
		};
		visit(evidenceRoot);
		write(
			evidenceRoot,
			"outer-manifest.json",
			makeArtifactManifestRecord(
				envelope(
					b.policy.runId,
					900,
					"FINAL",
					"offrunner-artifact-manifest",
					4000,
				),
				[...verified]
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([path, sha256]) => ({
						path,
						sha256,
						bytes: readFileSync(join(evidenceRoot, path)).length,
						recordedAt: at(4000),
					})),
			),
		);
	};
	rehash();
	/** Deliberately rebuild synthetic terminal bytes, never modify live evidence. */
	const replaceTerminalEvidence = (changes: {
		controllerExited?: boolean;
		preSeal?: Row;
	}) => {
		const root = join(repoRoot, b.reference.runRoot);
		const journal = record(json(join(root, "rig-state.json")));
		if (changes.controllerExited !== undefined)
			record(
				record(
					record(requireDefined(fixtureRecords(journal.events).at(-1)).details)
						.rigState,
				).evidence,
			).controllerExited = changes.controllerExited;
		journal.lastEventArtifactSha256 = canonicalArtifactSha256(
			requireDefined(fixtureRecords(journal.events).at(-1)),
		);
		write(root, "rig-state.json", journal);
		const destruction = record(json(join(root, "destruction-receipt.json")));
		destruction.finalJournalArtifactSha256 = canonicalArtifactSha256(journal);
		write(root, "destruction-receipt.json", destruction);
		if (changes.preSeal)
			write(root, "seals/pre/seal-receipt.json", {
				...record(json(join(root, "seals/pre/seal-receipt.json"))),
				...changes.preSeal,
			});
		rmSync(join(root, "terminal"), { recursive: true });
		const terminal = publishTerminalEvidence({
			root,
			runId: b.policy.runId,
			preSealRoot: "seals/pre",
			expectedDeletedIds: b.terminal.deletedIds,
		});
		rehash();
		return terminal;
	};
	const publishRebuiltBManifest = (manifest: Row) => {
		const root = join(repoRoot, b.reference.runRoot);
		const manifestArtifactSha256 = canonicalArtifactSha256(manifest);
		write(root, "seals/pre/artifact-manifest.json", manifest);
		write(root, "seals/pre/seal-receipt.json", {
			...record(json(join(root, "seals/pre/seal-receipt.json"))),
			manifestArtifactSha256,
		});
		const journal = record(json(join(root, "rig-state.json")));
		const events = fixtureRecords(journal.events);
		const sealed = requireDefined(
			events.find(
				(event) =>
					record(event.envelope).operationId === "offrunner-evidence-sealed",
			),
		);
		record(record(sealed.details).result).manifestArtifactSha256 =
			manifestArtifactSha256;
		let previous: string | null = null;
		for (const event of events) {
			event.previousEventArtifactSha256 = previous;
			previous = canonicalArtifactSha256(event);
		}
		journal.lastEventArtifactSha256 = previous;
		write(root, "rig-state.json", journal);
		return replaceTerminalEvidence({});
	};
	/** Rebuild the synthetic B seals after a hostile review edit, not live evidence. */
	const replaceHostReviewEvidence = (
		changes: Partial<
			Record<
				"architect.json" | "critic.json" | "architect.md" | "critic.md",
				string | Row | null
			>
		>,
	) => {
		const root = join(repoRoot, b.reference.runRoot);
		const names = [
			"architect.json",
			"critic.json",
			"architect.md",
			"critic.md",
		] as const;
		for (const name of names) {
			const change = changes[name];
			if (change === undefined) continue;
			if (change === null)
				rmSync(join(root, "host-reviews", name), { force: true });
			else write(root, `host-reviews/${name}`, change);
		}
		const manifest = record(
			json(join(root, "seals/pre/artifact-manifest.json")),
		);
		const reviewPaths = new Set(
			names.map((name) => `run/host-reviews/${name}`),
		);
		const entries = fixtureRecords(manifest.entries).filter(
			(entry) => !reviewPaths.has(fixtureText(entry.path)),
		);
		for (const name of names) {
			const path = join(root, "host-reviews", name);
			if (!existsSync(path)) continue;
			const bytes = readFileSync(path);
			entries.push({
				path: `run/host-reviews/${name}`,
				bytes: bytes.length,
				sha256: sha(bytes),
				recordedAt: record(manifest.envelope).recordedAt,
			});
		}
		entries.sort((a, b) =>
			fixtureText(a.path) < fixtureText(b.path)
				? -1
				: fixtureText(a.path) > fixtureText(b.path)
					? 1
					: 0,
		);
		manifest.entries = entries;
		return publishRebuiltBManifest(manifest);
	};
	/** Deliberately reseal corrupted synthetic raw bytes without changing stored grades. */
	const resealWorkEvidence = () => {
		let previous: string | null = null;
		for (const { nodeId } of b.final.completed) {
			const prefix = `work/${nodeId}`,
				start = record(json(join(b.workRoot, prefix, "start.json"))),
				completion = record(json(join(b.workRoot, prefix, "completion.json")));
			start.previousCompletionSha256 = previous;
			completion.previousCompletionSha256 = previous;
			write(b.workRoot, `${prefix}/start.json`, start);
			const files = () =>
				readdirSync(join(b.workRoot, prefix))
					.sort()
					.filter((name) => name !== "completion.json")
					.map((name) => binding(b.workRoot, `${prefix}/${name}`));
			write(b.workRoot, `${prefix}/cell-seal.json`, {
				schema: "g6-c32-work-cell-seal/1",
				nodeId,
				files: files().filter(
					(file) =>
						!/\/(cell-seal\.json|seal\.(stdout|stderr|receipt\.json))$/.test(
							file.path,
						),
				),
			});
			completion.files = files();
			write(b.workRoot, `${prefix}/completion.json`, completion);
			previous = binding(b.workRoot, `${prefix}/completion.json`).sha256;
		}
		const root = join(repoRoot, b.reference.runRoot),
			manifest = record(json(join(root, "seals/pre/artifact-manifest.json")));
		manifest.entries = fixtureRecords(manifest.entries).map((entry) => {
			const path = fixtureText(entry.path);
			if (!path.startsWith(`run/campaign-${b.policy.runId}/`)) return entry;
			const bytes = readFileSync(join(root, path.slice("run/".length)));
			return { ...entry, bytes: bytes.length, sha256: sha(bytes) };
		});
		return publishRebuiltBManifest(manifest);
	};
	return {
		repoRoot,
		evidenceRoot,
		contract,
		contractPath,
		decisionPath,
		r5Decision,
		verified,
		campaignA: a,
		campaignB: b,
		rehash,
		replaceTerminalEvidence,
		replaceHostReviewEvidence,
		resealWorkEvidence,
	};

	async function campaign(
		lane: "A" | "B",
		offset: number,
		templatePolicy: ReturnType<typeof validateBudgetPolicy>,
	) {
		const runId = `synthetic-${lane.toLowerCase()}`,
			runPath = `evidence/provisioning/${runId}`,
			runRoot = join(repoRoot, runPath);
		const input = {
			runId,
			planPath: `${runPath}/plan.md`,
			controllerPath: "tools/load/g6-c32-rca-controller.sh",
			budgetPolicyPath: `${runPath}/policy.json`,
			registrationTemplatePath: `${runPath}/registration.template.md`,
			runbookTemplatePath: `${runPath}/runbook.template.md`,
			gateCatalogPath: `${runPath}/gate-catalog.json`,
		};
		const policy = validateBudgetPolicy({ ...templatePolicy, runId });
		if (policy.schema !== "g6-c32-budget-policy/2")
			throw Error("synthetic policy /2 required");
		write(repoRoot, input.planPath, "Synthetic approved fixture plan only.\n");
		write(repoRoot, input.budgetPolicyPath, policy);
		write(repoRoot, input.registrationTemplatePath, "Synthetic registration\n");
		write(repoRoot, input.runbookTemplatePath, "Synthetic runbook\n");
		write(repoRoot, input.gateCatalogPath, G6_C32_GATE_CATALOG);
		const semantic = createSemanticFreeze(input, {
			repositoryPath: repoRoot,
			now: () => at(offset - 20),
		});
		const aReview = makeAuthorityRecord(
			"g6-c32-review-receipt/1",
			envelope(runId, 2, "ARCHITECT_REVIEW", "architect-review", offset - 19),
			{
				semanticFreezeAuthoritySha256: semantic.authoritySha256,
				role: "architect",
				verdict: "APPROVE",
				unconditional: true,
				afterArchitectReceiptArtifactSha256: null,
			},
		);
		const cReview = makeAuthorityRecord(
			"g6-c32-review-receipt/1",
			envelope(runId, 3, "CRITIC_REVIEW", "critic-review", offset - 18),
			{
				...aReview.authority,
				role: "critic",
				afterArchitectReceiptArtifactSha256: canonicalArtifactSha256(aReview),
			},
		);
		const approval = makeAuthorityRecord(
			"g6-c32-semantic-approval/1",
			envelope(runId, 4, "SEMANTIC_APPROVAL", "semantic-approval", offset - 17),
			{
				semanticFreezeAuthoritySha256: semantic.authoritySha256,
				architect: {
					verdict: "APPROVE",
					unconditional: true,
					receiptPath: `${runPath}/architect.json`,
					receiptArtifactSha256: canonicalArtifactSha256(aReview),
				},
				critic: {
					verdict: "APPROVE",
					unconditional: true,
					receiptPath: `${runPath}/critic.json`,
					receiptArtifactSha256: canonicalArtifactSha256(cReview),
					afterArchitectReceiptArtifactSha256: canonicalArtifactSha256(aReview),
				},
			},
		);
		write(runRoot, "semantic-freeze.json", semantic);
		write(runRoot, "semantic-approval.json", approval);
		write(runRoot, "architect.json", aReview);
		write(runRoot, "critic.json", cReview);
		const sourceSha = semantic.authority.candidate.commit;
		const pair = structuredClone(raw.boundHostPair);
		const preparedCheckout = "/opt/g6/source";
		for (const [i, role] of (["server", "generator"] as const).entries()) {
			Object.assign(pair[role].envelope, {
				runId,
				recordedAt: at(offset + 110),
				sequence: 40 + i,
			});
			Object.assign(pair[role].provider, {
				id: (lane === "A" ? 101 : 201) + i,
				name: `${runId}-${role}`,
				tags: ["g6-c32-managed", runId],
				createdAt: at(offset),
				sshKeyIds: [77],
			});
			Object.assign(pair[role].source, {
				commit: sourceSha,
				tree: semantic.authority.candidate.tree,
			});
			Object.assign(pair[role].clock, {
				requestStartedAt: at(offset + 109),
				responseFinishedAt: at(offset + 111),
				remoteWallAt: at(offset + 110),
			});
			pair[role].binary.sha256 = sha(`${role} synthetic binary`);
			pair[role].binary.path =
				role === "server"
					? `${preparedCheckout}/crates/native/webtransport-native.linux-x64-gnu.node`
					: `${preparedCheckout}/target/release/mmo-client`;
			write(runRoot, `${role}-identity.json`, pair[role]);
		}
		const desired = validateDesiredRig({
			recordedAt: at(offset),
			requestedAt: at(offset),
			deadline: at(offset + 7200),
			runId,
			managementTag: "g6-c32-managed",
			runTag: runId,
			roles: {
				serverName: `${runId}-server`,
				generatorName: `${runId}-generator`,
			},
			profile: {
				region: "ams3",
				size: "c-48-intel",
				image: "ubuntu-24-04-x64",
				vpcUuid: pair.server.provider.vpcUuid,
				projectMode: "none",
				projectId: null,
				sshKeyId: 77,
				expectedVcpus: 48,
				expectedMemoryMiB: 98304,
			},
			semantic: {
				freezeAuthoritySha256: semantic.authoritySha256,
				freezeArtifactSha256: canonicalArtifactSha256(semantic),
				approvalAuthoritySha256: approval.authoritySha256,
				approvalArtifactSha256: canonicalArtifactSha256(approval),
			},
			budget: {
				campaignId: policy.campaignId,
				lifecycle: policy.lifecycle,
				policyPath: input.budgetPolicyPath,
				policySha256: budgetPolicyArtifactSha256(policy),
				totalBudgetMicrousd: policy.totalBudgetMicrousd,
				spentBeforeMicrousd: policy.spentBeforeMicrousd,
				priorLedgerArtifactSha256: policy.priorLedger?.sha256 ?? null,
				maximumLifecycleCostMicrousd: policy.maximumLifecycleCostMicrousd,
				maximumLifecycleSeconds: policy.maximumLifecycleSeconds,
				teardownReserveSeconds: policy.teardownReserveSeconds,
				rolePriceCeilingMicrousd: policy.maximumRoleHourlyMicrousd,
			},
		});
		const journalPath = join(runRoot, "rig-state.json");
		initializeRigJournal(
			{ path: journalPath, runId, desiredRigAuthority: desired },
			{ clock: { wallNow: () => at(offset) }, randomId: () => "init" },
		);
		for (const lifecycle of [
			"CREATING",
			"PROVISIONED",
			"PREPARING",
			"PREPARED",
		] as const)
			appendRigJournalEvent(
				journalPath,
				{
					state: lifecycle,
					kind: "TRANSITION",
					operationId: `synthetic-${lifecycle}`,
					details: {},
				},
				{
					clock: { wallNow: () => at(offset + 110) },
					randomId: () => lifecycle,
				},
			);
		const knownHostsPath = join(runRoot, "known_hosts"),
			keys = `${pair.server.provider.publicIpv4} ssh-ed25519 AAAASyntheticServer\n${pair.generator.provider.publicIpv4} ssh-ed25519 AAAASyntheticGenerator\n`;
		write(runRoot, "known_hosts", keys);
		write(runRoot, "known-hosts-receipt.json", {
			schema: "g6-c32-known-hosts/1",
			envelope: envelope(
				runId,
				1,
				"BINDING",
				"capture-known-hosts",
				offset + 111,
			),
			knownHostsPath,
			knownHostsSha256: sha(keys),
			entries: (["server", "generator"] as const).map((role, index) => ({
				role,
				dropletId: pair[role].provider.id,
				publicIpv4: pair[role].provider.publicIpv4,
				keyType: "ssh-ed25519",
				keySha256: String(index + 1).repeat(64),
				capturedAt: at(offset + 110),
			})),
		});
		for (const role of ["server", "generator"] as const)
			write(runRoot, `${role}.binary`, `${role} synthetic binary`);
		write(
			runRoot,
			"candidate.bundle",
			"Synthetic retained bundle, never executed.\n",
		);
		const op = (
			id: string,
			seq: number,
			phase: string,
			start: number,
			end = start + 0.1,
		) =>
			validateOperationReceipt({
				...operationFixture(id, seq, at(start), at(end)),
				envelope: envelope(runId, seq, phase, id, end),
				durationMonotonicNs: String(Math.round((end - start) * 1e9)),
				stdoutPath: `${runId}/operations/${id}/operation.stdout`,
				stderrPath: `${runId}/operations/${id}/operation.stderr`,
			});
		const preparation = op("prepare", 1, "PREPARING", offset + 20);
		write(runRoot, "operations/prepare/operation.receipt.json", preparation);
		write(runRoot, "preparation-receipt.json", {
			schema: "g6-c32-host-preparation/1",
			envelope: envelope(runId, 2, "PREPARED", "prepare-hosts", offset + 105),
			hostIds: {
				server: pair.server.provider.id,
				generator: pair.generator.provider.id,
			},
			binaryHashes: {
				nativeAddonSha256: pair.server.binary.sha256,
				generatorSha256: pair.generator.binary.sha256,
			},
			operationReceipts: ["operations/prepare/operation.receipt.json"],
		});
		for (const [i, role] of (["server", "generator"] as const).entries())
			write(
				runRoot,
				`${role}-identity-operation.json`,
				op(`collect-identity-${role}`, 40 + i, "BINDING", offset + 109),
			);
		const gateReceiptPaths: string[] = [];
		for (const [phase, sequenceStart] of [
			["LOCAL", 100],
			["PREPARED_HOST", 200],
		] as const)
			await runGatePhase({
				runId,
				phase,
				catalog: G6_C32_GATE_CATALOG,
				sequenceStart,
				inputs: {
					G6_C32_REMOTE_BUNDLE_PATH: "/opt/g6/candidate.bundle",
					G6_C32_REMOTE_SMOKE_SCRIPT: "/opt/g6/smoke.sh",
					G6_C32_REMOTE_SMOKE_SERVER_EVIDENCE: "/opt/g6/server",
					G6_C32_REMOTE_SMOKE_GENERATOR_EVIDENCE: "/opt/g6/generator",
					G6_C32_SHARDS: "1",
					G6_C32_REMOTE_ROLLBACK_SCRIPT: "/opt/g6/rollback.sh",
					G6_C32_REMOTE_ROLLBACK_EVIDENCE: "/opt/g6/rollback",
				},
				clock: { wallNow: () => at(offset + 115) },
				runner: {
					execute: async (request) => {
						const receipt = op(
							`gate-${request.gate.id}`,
							request.sequence,
							phase,
							offset + 30 + (request.sequence - sequenceStart) * 3,
							offset + 32 + (request.sequence - sequenceStart) * 3,
						);
						const nativeIndex = (
							PREPARED_NATIVE_GATE_IDS as readonly string[]
						).indexOf(request.gate.id);
						const ownedProcess =
							request.gate.id === "prepared-server-owned-process-proof";
						const connectProbe =
							request.gate.id === "prepared-server-connect-probe-proof";
						let stdout = "synthetic gate output\n",
							stderr = "";
						if (nativeIndex >= 0 || ownedProcess || connectProbe) {
							receipt.action = {
								command: "ssh",
								args: preparedGateSshArgs({
									command: request.command,
									args: request.args,
									remoteCwd:
										ownedProcess && options.preparedProcessCwd !== undefined
											? options.preparedProcessCwd
											: preparedCheckout,
									publicIpv4: pair.server.provider.publicIpv4,
									knownHostsPath,
								}),
								cwd: ".",
								environmentKeys: [],
							};
							stderr = `g6-prepared-boot-id=${pair.server.bootId}\n`;
							stdout = connectProbe
								? canonicalJson(
										linuxProbeProofFixture({
											bootId: pair.server.bootId,
											startedAt: receipt.startedAt,
											finishedAt: receipt.finishedAt,
											proofSourceSha256: sha(
												readFileSync(
													join(repoRoot, "tools/load/g6-linux-probe-proof.ts"),
												),
											),
											producerSha256: sha(
												readFileSync(
													join(repoRoot, "tools/load/g6-linux-probe.ts"),
												),
											),
											diagnosticSourceSha256: sha(
												readFileSync(
													join(repoRoot, "tools/load/g6-sharded-diagnostic.ts"),
												),
											),
										}),
									)
								: nativeIndex === 0
									? nativeOutput(true)
									: nativeIndex === 1
										? "Linux\n"
										: nativeIndex === 2
											? `${sourceSha}\n`
											: canonicalJson({
													...processProof,
													startedAt: receipt.startedAt,
													finishedAt: at(
														Date.parse(receipt.startedAt) / 1000 -
															baseTime / 1000 +
															1,
													),
													proofSourceSha256: sha(
														readFileSync(
															join(
																repoRoot,
																"tools/load/g6-c32-linux-work-process-proof.ts",
															),
														),
													),
													workRemoteSourceSha256: sha(
														readFileSync(
															join(
																repoRoot,
																"tools/load/g6-c32-work-remote.ts",
															),
														),
													),
												});
						}
						if (request.gate.id === R5_VENDORED_WTRANSPORT_GATE_ID)
							stdout =
								options.r5?.vendoredGateStdout ??
								`${R5_VENDORED_WTRANSPORT_TESTS.map((name) => `test ${name} ... ok`).join("\n")}\n\ntest result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n`;
						write(dirname(runRoot), receipt.stdoutPath, stdout);
						write(dirname(runRoot), receipt.stderrPath, stderr);
						const receiptPath = `operations/gates/${request.gate.id}/operation.receipt.json`;
						write(runRoot, receiptPath, receipt);
						return { receipt, receiptPath };
					},
				},
				onReceipt: (receipt) => {
					const path = join(
						runRoot,
						"gate-receipts",
						`${receipt.gate.id}.json`,
					);
					write(runRoot, relative(runRoot, path), receipt);
					gateReceiptPaths.push(path);
				},
			});
		let tick = 1n;
		const boundResult = await bindHostFreeze(
			{
				runId,
				repositoryPath: repoRoot,
				provisioningRoot: runRoot,
				outputName: "bound",
				semanticFreezePath: join(runRoot, "semantic-freeze.json"),
				semanticApprovalPath: join(runRoot, "semantic-approval.json"),
				rigJournalPath: journalPath,
				knownHostsPath,
				knownHostsReceiptPath: join(runRoot, "known-hosts-receipt.json"),
				preparationReceiptPath: join(runRoot, "preparation-receipt.json"),
				bundlePath: join(runRoot, "candidate.bundle"),
				retainedNativePath: join(runRoot, "server.binary"),
				retainedGeneratorPath: join(runRoot, "generator.binary"),
				identityPacketPaths: {
					server: join(runRoot, "server-identity.json"),
					generator: join(runRoot, "generator-identity.json"),
				},
				identityOperationReceiptPaths: {
					server: join(runRoot, "server-identity-operation.json"),
					generator: join(runRoot, "generator-identity-operation.json"),
				},
				gateReceiptPaths,
				sequenceStart: 300,
			},
			{
				clock: {
					wallNow: () => at(offset + 116),
					monotonicNowNs: () => tick++,
				},
			},
		);
		const bound = verifyBoundFreeze(boundResult.root, {
			repositoryPath: repoRoot,
		});
		const workAuthority = deriveWorkAuthority(bound);
		if (lane === "B")
			collectPreparedNativeProof({
				repositoryPath: repoRoot,
				boundRoot: bound.root,
				knownHostsPath,
			});
		const nativeProducer = producer(repoRoot),
			probeProducer = sha(
				readFileSync(join(repoRoot, "tools/load/g6-linux-probe.ts")),
			),
			registration = bound.dispatchFreeze.authority.views.registration.sha256;
		const ledgerBase = {
			recordedAt: at(offset),
			campaignId: policy.campaignId,
			runId,
			budgetPolicySha256: budgetPolicyArtifactSha256(policy),
			accruedLifecycleMicrousd: 0,
			prospectiveCellMicrousd: 0,
			teardownReserveMicrousd: 0,
			totalAuthorizedMicrousd: policy.spentBeforeMicrousd,
			remainingBudgetMicrousd:
				policy.totalBudgetMicrousd - policy.spentBeforeMicrousd,
			decision: null,
		};
		const ledger = [
			appendSpendLedgerEntry(null, {
				...ledgerBase,
				event: "CREATE_INTENT",
				rigJournalEventArtifactSha256: "e".repeat(64),
			}),
		];
		const workRoot = join(runRoot, `campaign-${runId}`);
		mkdirSync(workRoot);
		const reviewContext = contextFromBound(bound);
		const architectNote = `Synthetic ${lane} exact-host Architect approval; no live review occurred.\n`;
		const criticNote = `Synthetic ${lane} exact-host Critic approval after the Architect; no live review occurred.\n`;
		const hostArchitect: CapacityHostReviewRecord = {
			schema: "g6-capacity-host-review/1",
			context: reviewContext,
			role: "architect",
			verdict: "APPROVE",
			unconditional: true,
			reviewedAt: at(offset + 117),
			afterArchitectArtifactSha256: null,
			reviewNoteSha256: sha(architectNote),
		};
		const hostCritic: CapacityHostReviewRecord = {
			...hostArchitect,
			role: "critic",
			reviewedAt: at(offset + 118),
			afterArchitectArtifactSha256: canonicalArtifactSha256(hostArchitect),
			reviewNoteSha256: sha(criticNote),
		};
		write(runRoot, "host-reviews/architect.json", hostArchitect);
		write(runRoot, "host-reviews/critic.json", hostCritic);
		write(runRoot, "host-reviews/architect.md", architectNote);
		write(runRoot, "host-reviews/critic.md", criticNote);
		appendRigJournalEvent(
			journalPath,
			{
				state: "QUALIFYING",
				kind: "INTENT",
				operationId: "launch-locked-controller",
				details: {
					result: { boundRoot: bound.root, deadline: desired.deadline },
				},
			},
			{ clock: { wallNow: () => at(offset + 119) }, randomId: () => "launch" },
		);
		write(runRoot, "controller-launch.json", {
			schema: "g6-c32-controller-launch/2",
			supervisorToken:
				lane === "A"
					? "11111111-1111-4111-8111-111111111111"
					: "22222222-2222-4222-8222-222222222222",
			envelope: envelope(
				runId,
				400,
				"QUALIFYING",
				"controller-launch",
				offset + 119.2,
			),
			pid: 8001,
			processGroupId: 8001,
			command: "bash",
			args: [
				join(repoRoot, input.controllerPath),
				"run",
				"--bound-root",
				bound.root,
				"--repository",
				repoRoot,
				"--budget-policy",
				join(repoRoot, input.budgetPolicyPath),
				"--spend-ledger",
				join(runRoot, "spend-ledger.json"),
				"--deadline",
				desired.deadline,
			],
			cwd: repoRoot,
			deadline: desired.deadline,
			startedAt: at(offset + 119.2),
			startedMonotonicNs: "119200000000",
			operationSequence: 400,
			evidenceRoot: workRoot,
		});
		write(workRoot, "qualification/lock-acquired.json", {
			schema: "g6-c32-lock-acquired/1",
			envelope: envelope(runId, 1, "QUALIFYING", "bench-lock", offset + 119.4),
		});
		write(workRoot, "qualification/bench-lock.stdout", "LOCKED\n");
		write(workRoot, "qualification/bench-lock.stderr", "");
		const setup = {
			...op("work-setup", 1, "RUNNING", offset, offset + 120),
			stdoutPath: "qualification/setup.stdout",
			stderrPath: "qualification/setup.stderr",
		};
		write(workRoot, "qualification/setup.receipt.json", setup);
		write(workRoot, setup.stdoutPath, "");
		write(workRoot, setup.stderrPath, "");
		write(workRoot, "work-authority.json", workAuthority);
		write(workRoot, "work-execution.json", {
			schema: "g6-c32-work-execution/1",
			policySha256: budgetPolicyArtifactSha256(policy),
			candidateSha: sourceSha,
			registrationSha256: registration,
			nativeProducerSha256: nativeProducer,
			probeProducerSha256: probeProducer,
			authority: binding(workRoot, "work-authority.json"),
			deadline: at(offset + 7200),
			setupReceipt: binding(workRoot, "qualification/setup.receipt.json"),
		});
		let previous: string | null = null,
			target: WorkTarget = policy.workPlan.entry,
			index = 0;
		const admissionCompleted: {
			nodeId: string;
			outcome: "PASS" | "MISS" | "INVALID";
		}[] = [];
		while (typeof target === "string") {
			const node = requireDefined(
					policy.workPlan.nodes.find((n) => n.id === target),
				),
				p = requireDefined(policy.workProfiles[node.profile]);
			const expectedOutcome =
				lane === "B" ? (options.bOutcomes?.[node.id] ?? "PASS") : "PASS";
			// r5 arms reuse the historical probe-on/off raw cells and rebind knobs.
			const templateId = r5
					? p.udpSendBatch === 64
						? "B-1"
						: p.detailedProbe
							? "A1-1"
							: "A0-1"
					: lane === "A"
						? node.id
						: "A1-1",
				template = join(raw.root, "work", templateId),
				prefix = `work/${node.id}`;
			const start = offset + 120 + index * 125,
				originalStart = Date.parse(
					fixtureText(record(json(join(template, "start.json"))).startedAt),
				),
				shift = baseTime + start * 1000 - originalStart;
			const transform = (value: unknown): unknown => {
				if (typeof value === "string") {
					return value
						.replace(/2026-09-04T\d\d:\d\d:\d\d\.\d\d\dZ/g, (timestamp) =>
							new Date(Date.parse(timestamp) + shift).toISOString(),
						)
						.replaceAll(raw.policy.runId, runId)
						.replaceAll(templateId, node.id)
						.replaceAll("b".repeat(64), registration)
						.replaceAll(raw.nativeProducerSha256, nativeProducer)
						.replaceAll(raw.probeProducerSha256, probeProducer)
						.replaceAll("a".repeat(40), sourceSha);
				}
				if (Array.isArray(value)) return value.map(transform);
				if (value && typeof value === "object")
					return Object.fromEntries(
						Object.entries(value).map(([k, v]) => [k, transform(v)]),
					);
				return value;
			};
			for (const name of readdirSync(template)) {
				if (
					[
						"completion.json",
						"cell-seal.json",
						"admission.json",
						"start.json",
						"work-grade.json",
					].includes(name) ||
					(r5 && !p.detailedProbe && name === "linux-probe.jsonl")
				)
					continue;
				const bytes = readFileSync(join(template, name), "utf8");
				write(
					workRoot,
					`${prefix}/${name}`,
					name.endsWith(".json")
						? transform(JSON.parse(bytes))
						: transform(bytes),
				);
			}
			const scan = record(json(join(workRoot, prefix, "g6-sharded-scan.json"))),
				diagnostic = record(
					json(join(workRoot, prefix, "g6-sharded-diagnostic.json")),
				);
			for (const row of fixtureRecords(diagnostic.perShardLifecycle)) {
				for (const boundary of fixtureRecords(row.boundaries))
					boundary.tsMs = fixtureNumber(boundary.tsMs) + shift;
				for (const exit of fixtureRecords(row.exits))
					exit.tsMs = fixtureNumber(exit.tsMs) + shift;
			}
			const steering = record(diagnostic.postRunSteering);
			steering.capturedAtMs = fixtureNumber(steering.capturedAtMs) + shift;
			if (r5 && !p.detailedProbe && templateId !== "A0-1")
				// Probe-off arms on a probe-on template retain the explicit off record.
				diagnostic.linuxProbe = record(
					json(join(raw.root, "work", "A0-1", "g6-sharded-diagnostic.json")),
				).linuxProbe;
			if (lane === "B") {
				const fresh = record(
						transform(cleanScan(node.requestedSessions, p, 1)),
					),
					freshDiag = record(
						transform(
							diagnosticFixture({
								sessions: node.requestedSessions,
								shape: p,
								shards: 1,
								drops: 0,
								steered: 30000000,
							}),
						),
					);
				const client = record(
					JSON.parse(
						fixtureText(fresh.clientStdout).slice("mmo-client: json ".length),
					),
				);
				const oldClient = record(
					JSON.parse(
						fixtureText(scan.clientStdout).slice("mmo-client: json ".length),
					),
				);
				client.startedAt = at(start + 1);
				client.activeWorkloadSessions = node.activeWorkloadSessions;
				if (node.kind === "companion") {
					record(record(client.windows).steady).sent =
						node.activeWorkloadSessions * 4 * 120;
					record(record(client.windows).steadyDrain).rxSnapshot =
						node.activeWorkloadSessions * 15 * 120;
					for (const shard of fixtureRecords(fresh.shards)) {
						for (const window of fixtureRecords(
							Object.values(record(shard.windows)),
						)) {
							window.rxTotal = node.activeWorkloadSessions * 4 * 120;
							record(window.emitter).snapshotIssued =
								node.activeWorkloadSessions * 15 * 120;
						}
					}
					record(record(fresh.aggregate).lifetime).rxByClass = {
						raidJoin: node.requestedSessions - node.activeWorkloadSessions,
					};
				}
				record(client.client).endpointSourceAddresses = record(
					oldClient.client,
				).endpointSourceAddresses;
				record(record(client.windows).steadyDrain).rtt = record(
					record(oldClient.windows).steadyDrain,
				).rtt;
				Object.assign(scan, fresh);
				if (expectedOutcome === "MISS") {
					const steady = record(
						record(requireDefined(fixtureRecords(scan.shards)[0]).windows)
							.steady,
					);
					steady.rxTotal = Math.floor(fixtureNumber(steady.rxTotal) * 0.994);
				}
				if (expectedOutcome === "INVALID") scan.clientExit = 1;
				scan.startedAt = at(start + 1);
				Object.assign(record(scan.config), p, {
					activeWorkloadSessions: node.activeWorkloadSessions,
					pacerPps: null,
				});
				scan.clientStdout = `mmo-client: json ${JSON.stringify(client)}\n`;
				for (const shard of fixtureRecords(scan.shards))
					Object.assign(
						record(record(record(shard.windows).lifetime).metrics),
						{
							udpSendBatchErrors: 0,
						},
					);
				Object.assign(record(record(record(scan.aggregate).lifetime).metrics), {
					udpSendBatchErrors: 0,
				});
				for (const phase of ["steady", "steadyDrain", "lifetime"]) {
					const windows = fixtureRecords(scan.shards).map((shard) =>
						record(record(shard.windows)[phase]),
					);
					Object.assign(record(record(scan.aggregate)[phase]), {
						rxTotal: windows.reduce(
							(sum, window) => sum + fixtureNumber(window.rxTotal),
							0,
						),
						emitter: Object.fromEntries(
							["snapshotIssued", "sendErrors"].map((key) => [
								key,
								windows.reduce(
									(sum, window) =>
										sum + fixtureNumber(record(window.emitter)[key]),
									0,
								),
							]),
						),
					});
				}
				Object.assign(record(diagnostic.dispatch), record(scan.config));
				const rung = requireDefined(fixtureRecords(diagnostic.ladder)[0]);
				rung.sessions = node.requestedSessions;
				Object.assign(
					rung,
					requireDefined(fixtureRecords(freshDiag.ladder)[0]),
				);
				rung.T1 = { hostLoad: { gro: "off" } };
				record(rung.T2).hostLoad = { gro: "off" };
				// Preserve native/probe phase cuts while taking the requested-session raw quality counters from the reusable fixture.
			}
			if (r5) {
				// r5 echoes: datagram read path on both roles, per-role steady CPU,
				// offered work and per-arm ACK/hold histograms (A' only).
				const client = record(
					JSON.parse(
						fixtureText(scan.clientStdout).slice("mmo-client: json ".length),
					),
				);
				const pump = p.datagramPump === "pump";
				client.datagramDriver = {
					mode: p.datagramPump,
					pumpsSpawned: pump ? 128 : 0,
					pumpsLive: 0,
				};
				const steady = record(record(client.windows).steady);
				const steadyDrain = record(record(client.windows).steadyDrain);
				const metrics =
					lane === "A"
						? r5ArmMetrics(node.id, r5)
						: { generatorCpuMs: 150000, serverCpuMs: 240000, ackMs: 10 };
				record(client.client).cpuMsSteady = metrics.generatorCpuMs;
				steady.scheduleTicksDue = Math.round(
					fixtureNumber(steady.sent) *
						(lane === "A" ? (r5.offeredMovesSkew?.[node.id] ?? 1) : 1),
				);
				steadyDrain.rtt = histogramJson(metrics.ackMs);
				steadyDrain.serverHold = histogramJson(0.01);
				scan.clientStdout = `mmo-client: json ${JSON.stringify(client)}\n`;
				const aggregate = record(scan.aggregate),
					aggSteady = record(aggregate.steady),
					emitter = record(aggSteady.emitter);
				emitter.ackIssued = fixtureNumber(aggSteady.rxTotal);
				emitter.snapshotDue = fixtureNumber(emitter.snapshotIssued);
				aggSteady.cpuMs = metrics.serverCpuMs;
				record(record(aggregate.lifetime).metrics).datagramPumpsSpawned = pump
					? p.shards
					: 0;
				const shard = requireDefined(fixtureRecords(scan.shards)[0]),
					windows = record(shard.windows);
				record(windows.steady).cpuMs = metrics.serverCpuMs;
				const shardEmitter = record(record(windows.steady).emitter);
				shardEmitter.ackIssued = emitter.ackIssued;
				shardEmitter.snapshotDue = emitter.snapshotDue;
				record(record(windows.lifetime).metrics).datagramPumpsSpawned = pump
					? p.shards
					: 0;
			}
			const share = (total: number, index: number) =>
				Math.floor(total / p.shards) + (index < total % p.shards ? 1 : 0);
			const templateShard = requireDefined(fixtureRecords(scan.shards)[0]);
			scan.shards = Array.from({ length: p.shards }, (_, index) => {
				const row = structuredClone(templateShard);
				row.serverId = index + 1;
				row.sessionsAtSteady = share(node.requestedSessions, index);
				if (node.kind === "companion")
					row.sessionsByKindAtSteady = {
						player: share(node.activeWorkloadSessions, index),
						raid: share(
							node.requestedSessions - node.activeWorkloadSessions,
							index,
						),
						publisher: 0,
					};
				for (const window of fixtureRecords(
					Object.values(record(row.windows)),
				)) {
					window.rxTotal = share(fixtureNumber(window.rxTotal), index);
					if (window.cpuMs !== undefined)
						window.cpuMs = share(fixtureNumber(window.cpuMs), index);
					for (const counters of [
						record(window.emitter),
						record(window.metrics ?? {}),
					])
						for (const key of Object.keys(counters))
							counters[key] = share(fixtureNumber(counters[key]), index);
				}
				return row;
			});
			Object.assign(record(scan.config), p);
			Object.assign(record(diagnostic.dispatch), record(scan.config));
			record(diagnostic.bpfPreArm).socksEntries = p.shards;
			record(record(diagnostic.bpfPreArm).receiptValidation).instances =
				p.shards;
			for (const phase of ["T0", "T2"])
				record(
					requireDefined(fixtureRecords(diagnostic.ladder)[0])[phase],
				).perShardUdp = Object.fromEntries(
					Array.from({ length: p.shards }, (_, index) => [
						String(index + 1),
						{ drops: 0 },
					]),
				);
			diagnostic.perShardLifecycle = Array.from(
				{ length: p.shards },
				(_, index) => ({
					...structuredClone(
						requireDefined(fixtureRecords(diagnostic.perShardLifecycle)[0]),
					),
					serverId: index + 1,
					pid: 101 + index,
				}),
			);
			record(diagnostic.sendPathDiagnostics).shards = Array.from(
				{ length: p.shards },
				(_, index) => ({
					...structuredClone(
						requireDefined(
							fixtureRecords(record(diagnostic.sendPathDiagnostics).shards)[0],
						),
					),
					serverId: index + 1,
					pid: 101 + index,
				}),
			);
			write(workRoot, `${prefix}/g6-sharded-scan.json`, scan);
			write(workRoot, `${prefix}/g6-sharded-diagnostic.json`, diagnostic);
			if (p.detailedProbe) {
				const probePath = join(workRoot, prefix, "linux-probe.jsonl");
				const rows = readFileSync(probePath, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				rows[0].startedAt = at(start + 1);
				rows.at(-1).endedAt = at(start + 121.15);
				for (const row of rows)
					for (const field of ["shards", "sched"]) {
						if (!Array.isArray(row[field])) continue;
						const template = row[field][0];
						row[field] = Array.from({ length: p.shards }, (_, index) => ({
							...template,
							serverId: index + 1,
							pid: 101 + index,
							...(template.inodes ? { inodes: [String(111 + index)] } : {}),
						}));
					}
				for (const field of ["summary", "historicalConnectSummary"]) {
					rows.at(-1)[field].peakReceiveQueueBytes *= p.shards;
					rows.at(-1)[field].peakDrops *= p.shards;
				}
				write(
					workRoot,
					`${prefix}/linux-probe.jsonl`,
					linuxProbeFixtureText(rows),
				);
			}
			for (const name of readdirSync(join(workRoot, prefix)).filter((name) =>
				name.endsWith(".receipt.json"),
			)) {
				const receipt = validateOperationReceipt(
					json(join(workRoot, prefix, name)),
				);
				if (name === "scan.receipt.json")
					receipt.action.args = receipt.action.args.map((arg: string) =>
						arg.replaceAll("SCAN_SHARDS=1 ", `SCAN_SHARDS=${p.shards} `),
					);
				if (r5 && name === "scan.receipt.json")
					receipt.action.args = receipt.action.args.map((arg: string) =>
						arg.includes("SCAN_UDP_SEND_BATCH=")
							? `SCAN_DATAGRAM_PUMP=${p.datagramPump} ${arg
									.replace(
										/SCAN_UDP_SEND_BATCH=\d+ /,
										`SCAN_UDP_SEND_BATCH=${p.udpSendBatch} `,
									)
									.replace(
										/SCAN_LINUX_PROBE_ENABLED=\d /,
										`SCAN_LINUX_PROBE_ENABLED=${p.detailedProbe ? 1 : 0} `,
									)}`
							: arg,
					);
				receipt.envelope.runId = runId;
				receipt.envelope.sequence =
					2 +
					index * 14 +
					[
						"remote-mkdir",
						"apply-buffer",
						"apply-buffer-generator",
						"apply-gro",
						"bpf-repin",
						"prepare-generator-owner",
						"scan",
						"copy",
						"copy-generator-owner",
						"evaluate",
						"restore-buffer",
						"restore-buffer-generator",
						"restore-gro",
						"seal",
					].indexOf(name.slice(0, -".receipt.json".length));
				if (lane === "B" && name === "scan.receipt.json")
					receipt.action.args = receipt.action.args.map((arg: string) =>
						arg
							.replaceAll(
								"SESSIONS=40000",
								`SESSIONS=${node.requestedSessions}`,
							)
							.replaceAll(
								`SCAN_WORKLOAD_ACTIVE_SESSIONS=${node.requestedSessions}`,
								`SCAN_WORKLOAD_ACTIVE_SESSIONS=${node.activeWorkloadSessions}`,
							),
					);
				write(workRoot, `${prefix}/${name}`, receipt);
			}
			write(
				workRoot,
				`${prefix}/scan.stdout`,
				readFileSync(join(workRoot, prefix, "scan.stdout"), "utf8").replaceAll(
					"shards=1 ",
					`shards=${p.shards} `,
				),
			);
			if (lane === "B") {
				const path = `${prefix}/scan.stdout`;
				write(
					workRoot,
					path,
					readFileSync(join(workRoot, path), "utf8").replaceAll(
						"sessions=40000",
						`sessions=${node.requestedSessions}`,
					),
				);
			}
			const { entry: admission, receipt } = createCellAdmission({
				policy,
				previous: requireDefined(ledger.at(-1)),
				recordedAt: at(start),
				result: evaluateWorkAdmission({
					policy,
					stage: node.kind,
					completed: admissionCompleted,
					setupComplete: true,
					elapsedPaidSeconds: Math.ceil(
						(Date.parse(at(start)) -
							Date.parse(
								requireDefined(
									ledger.find((entry) => entry.event === "CREATE_INTENT"),
								).recordedAt,
							)) /
							1000,
					),
					controlUsedSeconds: 0,
					remainingDeadlineSeconds: Math.floor(
						(Date.parse(at(offset + 7200)) - Date.parse(at(start))) / 1000,
					),
				}),
			});
			ledger.push(admission);
			write(workRoot, `${prefix}/start.json`, {
				schema: "g6-c32-work-cell-start/2",
				clockDomain: workClockDomainFixture(),
				nodeId: node.id,
				policySha256: budgetPolicyArtifactSha256(policy),
				startedAt: at(start),
				startedMonotonicNs: String(BigInt(index) * 125000000000n),
				cutoffAt: at(start + node.maximumSeconds),
				previousCompletionSha256: previous,
			});
			write(workRoot, `${prefix}/admission.json`, receipt);
			const grade = gradeWorkCell({
				runId,
				pair: workAuthority.pair,
				node,
				profile: p,
				scan: scan as ReturnType<typeof cleanScan>,
				diagnostic,
				postRunSteeringText: steeringDump(30000000),
				probe: p.detailedProbe
					? readFileSync(join(workRoot, prefix, "linux-probe.jsonl"), "utf8")
					: null,
				expectCandidate: sourceSha,
				registrationSha256: registration,
				nativeProducerSha256: nativeProducer,
				probeProducerSha256: probeProducer,
				operation: json(join(workRoot, prefix, "scan.receipt.json")),
				scanStdout: readFileSync(join(workRoot, prefix, "scan.stdout"), "utf8"),
				scanStderr: readFileSync(join(workRoot, prefix, "scan.stderr"), "utf8"),
				owners: {
					server: json(join(workRoot, prefix, "scan-owner.json")),
					generator: json(join(workRoot, prefix, "generator-owner.json")),
				},
				bufferOperations: Object.fromEntries(
					[
						"apply-buffer",
						"apply-buffer-generator",
						...(p.serverUdpSendBufferBytes > 0 ? ["apply-server-sndbuf"] : []),
					].map((name) => [
						name,
						{
							receipt: json(join(workRoot, prefix, `${name}.receipt.json`)),
							stdout: readFileSync(
								join(workRoot, prefix, `${name}.stdout`),
								"utf8",
							),
							stderr: readFileSync(
								join(workRoot, prefix, `${name}.stderr`),
								"utf8",
							),
						},
					]),
				),
			});
			if (grade.outcome !== expectedOutcome)
				throw Error(
					`synthetic ${lane}/${node.id} grade ${JSON.stringify(grade)}`,
				);
			write(workRoot, `${prefix}/work-grade.json`, grade);
			const files = () =>
				readdirSync(join(workRoot, prefix))
					.sort()
					.map((name) => binding(workRoot, `${prefix}/${name}`));
			write(workRoot, `${prefix}/cell-seal.json`, {
				schema: "g6-c32-work-cell-seal/1",
				nodeId: node.id,
				files: files().filter(
					(f) =>
						!/\/(seal\.stdout|seal\.stderr|seal\.receipt\.json)$/.test(f.path),
				),
			});
			write(workRoot, `${prefix}/completion.json`, {
				schema: "g6-c32-work-cell-completion/2",
				clockDomain: workClockDomainFixture(),
				startedMonotonicNs: String(BigInt(index) * 125000000000n),
				finishedMonotonicNs: String(BigInt(index + 1) * 125000000000n),
				nodeId: node.id,
				policySha256: budgetPolicyArtifactSha256(policy),
				startedAt: at(start),
				finishedAt: at(start + 125),
				durationMonotonicNs: "125000000000",
				previousCompletionSha256: previous,
				grade,
				files: files(),
			});
			previous = binding(workRoot, `${prefix}/completion.json`).sha256;
			admissionCompleted.push({ nodeId: node.id, outcome: grade.outcome });
			target = node.next[grade.outcome];
			index++;
		}
		const final = createWorkFinal({
			root: workRoot,
			policy,
			ledger,
			now: at(offset + 120 + index * 125 + 1),
		});
		write(workRoot, "closeout/work-final.json", final);
		const absent = offset + 130 + index * 125,
			sealRoot = "seals/pre";
		write(runRoot, `${sealRoot}/pre-destroy-spend-ledger.json`, ledger);
		const stableFiles = [`${sealRoot}/pre-destroy-spend-ledger.json`];
		const collectStable = (directory: string) => {
			for (const entry of readdirSync(directory, { withFileTypes: true })) {
				const path = join(directory, entry.name),
					rel = relative(runRoot, path);
				if (
					["rig-state.json", "RUN_STATUS", "spend-ledger.json"].includes(rel) ||
					rel.startsWith("seals/")
				)
					continue;
				if (entry.isDirectory()) collectStable(path);
				else stableFiles.push(rel);
			}
		};
		collectStable(runRoot);
		const entries = stableFiles.sort().map((path) => {
			const bytes = readFileSync(join(runRoot, path));
			return {
				path: `run/${path}`,
				bytes: bytes.length,
				sha256: sha(bytes),
				recordedAt: at(absent),
			};
		});
		const manifest = makeArtifactManifestRecord(
			envelope(runId, 500, "FINAL", "offrunner-artifact-manifest", absent),
			entries,
		);
		write(runRoot, `${sealRoot}/artifact-manifest.json`, manifest);
		write(runRoot, `${sealRoot}/seal-receipt.json`, {
			schema: "g6-c32-offrunner-seal/1",
			envelope: {
				...manifest.envelope,
				sequence: 501,
				operationId: "offrunner-evidence-seal",
			},
			status: final.terminal,
			finalGatesComplete: final.terminal !== "INCOMPLETE",
			evidenceCollectionComplete: final.terminal !== "INCOMPLETE",
			finalGateError: null,
			manifestArtifactSha256: canonicalArtifactSha256(manifest),
		});
		appendRigJournalEvent(
			journalPath,
			{
				state: "TERMINAL",
				kind: "RESULT",
				operationId: "offrunner-evidence-sealed",
				details: {
					result: {
						sealRoot: join(runRoot, sealRoot),
						manifestArtifactSha256: canonicalArtifactSha256(manifest),
					},
				},
			},
			{ clock: { wallNow: () => at(absent) }, randomId: () => "seal" },
		);
		const rigState = validateRigState({
			desired,
			preCreateBudgetAuthority: {
				priceReceipt: {
					recordedAt: at(offset),
					clockSource: "provider",
					runId,
					serverHourlyMicrousd: 1949400,
					generatorHourlyMicrousd: 1949400,
					artifactSha256: "b".repeat(64),
				},
				absenceProof: {
					recordedAt: at(offset),
					clockSource: "provider",
					runId,
					campaignTag: desired.managementTag,
					liveProviderIds: [],
					artifactSha256: "c".repeat(64),
				},
			},
			lifecycle: "DESTROYED",
			ownedResources: (["server", "generator"] as const).map((role) => ({
				id: pair[role].provider.id,
				role,
				source: "CREATED",
				creationAttempt: 1,
				recordedAt: at(offset),
				recordedIdentity: pair[role].provider,
			})),
			createIntent: null,
			creationAttempt: 1,
			evidence: {
				offrunnerEvidenceSealed: true,
				controllerExited: true,
				cleanupDisposition: "CLEANUP_COMPLETE",
				inventoryAmbiguous: false,
			},
		});
		const ids = [pair.server.provider.id, pair.generator.provider.id];
		const journal = appendRigJournalEvent(
			journalPath,
			{
				state: "DESTROYED",
				kind: "RESULT",
				operationId: "destroy-exact-pair-verified",
				details: {
					rigState,
					cloud: { deletedIds: ids, verifiedAbsentAt: at(absent) },
				},
			},
			{ clock: { wallNow: () => at(absent) }, randomId: () => "destroy" },
		);
		write(runRoot, "destruction-receipt.json", {
			schema: "g6-c32-destruction-receipt/1",
			envelope: envelope(runId, 501, "DESTROYED", "destroy", absent),
			desiredRigAuthoritySha256: journal.desiredRigAuthoritySha256,
			finalJournalArtifactSha256: canonicalArtifactSha256(journal),
			deletedIds: ids,
			verifiedAbsentAt: at(absent),
			runTagInventoryEmpty: true,
		});
		ledger.push(
			sealWorkSpendLedger({
				policy,
				entries: ledger,
				recordedAt: at(absent),
				verifiedAbsentAt: at(absent),
				hourlyMicrousdByRole: policy.maximumRoleHourlyMicrousd,
			}),
		);
		write(runRoot, "spend-ledger.json", ledger);
		const terminal = publishTerminalEvidence({
			root: runRoot,
			runId,
			preSealRoot: sealRoot,
			expectedDeletedIds: ids,
		});
		return {
			reference: {
				runRoot: runPath,
				boundRoot: `${runPath}/bound`,
				policyPath: input.budgetPolicyPath,
			},
			sourceSha,
			policy,
			pair,
			bound,
			ledger,
			terminal,
			workRoot,
			final,
			nativeProducer,
			probeProducer,
			registration,
			workAuthority,
		};
	}
}
function nativeOutput(linux: boolean) {
	const names = [
		...CAPACITY_NATIVE_PROOF_TESTS,
		...(linux ? CAPACITY_LINUX_PROOF_TESTS : []),
	];
	return `${names.map((name) => `test ${name} ... ok`).join("\n")}\ntest result: ok. ${names.length} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s\n`;
}
export function syntheticLinuxProcessFixture() {
	const bootId = "11111111-1111-4111-8111-111111111111",
		root = "/tmp/g6-linux-work-process-synthetic",
		runId = "process-proof-synthetic";
	const expected = {
		bootId,
		proofSourceSha256: "a".repeat(64),
		workRemoteSourceSha256: "b".repeat(64),
	};
	const command = (argv: string[], exitCode = 0, pid = 77) => ({
		argv,
		pid,
		exitCode,
		signal: null,
		timedOut: false,
		outputTruncated: false,
		stdout: "",
		stderr: "",
		durationMs: 10,
		error: null,
	});
	const stat = (pid: number, parent: number, group: number, ticks: string) => {
		const fields = Array(22).fill("0");
		Object.assign(fields, {
			0: "S",
			1: String(parent),
			2: String(group),
			3: String(group),
			19: ticks,
		});
		return `${pid} (bash) ${fields.join(" ")}\n`;
	};
	const cases = buildProcessProofCases(root, runId, bootId).map(
		(definition, index) => {
			const pid = 101 + index * 10,
				ownedPid = definition.processGroupLeader ? pid + 1 : pid,
				ticks = String(10000 + index);
			const exitCode = index < 2 ? 1 : index < 4 ? 37 : 0;
			const supervisor = {
				schema: "g6-work-process-supervisor/1",
				supervisorPid: 77,
				launcherPid: pid,
				launcherExit: exitCode,
				launcherSignal: null,
				timedOut: false,
				remainingChildren: 0,
				trackingFailure: false,
				reaped: [
					{
						pid,
						startTicks: ticks,
						processGroupId: definition.processGroupLeader ? pid : ownedPid,
						exitCode,
						signal: null,
					},
				],
			};
			const caller = {
				schema: "g6-work-process-launcher/1",
				pid,
				processGroupId: definition.processGroupLeader ? pid : 77,
				sessionId: 77,
				startTicks: ticks,
			};
			const launch = command(
				[
					`${root}/supervisor`,
					definition.processGroupLeader ? "leader" : "ordinary",
					"4000",
					`${definition.directory}/launch.sh`,
				],
				exitCode,
			);
			launch.stdout = `g6-process-launcher: ${JSON.stringify(caller)}\ng6-process-supervisor: ${JSON.stringify(supervisor)}\n`;
			const owner = {
				schema: "g6-c32-work-process-owner/1",
				runId,
				nodeId: definition.id,
				role: definition.owner.role,
				pid: ownedPid,
				processGroupId: ownedPid,
				startTicks: ticks,
				bootId,
			};
			const value = {
				id: definition.id,
				passed: true,
				role: definition.owner.role,
				processGroupLeader: definition.processGroupLeader,
				ownerAuthority: definition.owner,
				launchCommand: definition.launchCommand,
				launchCommandSha256: sha(definition.launchCommand),
				cleanupCommandSha256: sha(definition.cleanupCommand),
				launch,
				supervisor,
				durationMs: 10,
			};
			const ownership =
				index < 2
					? {
							innerExecuted: false,
							preexistingOwnerRaw: index
								? "preexisting-owner-must-not-be-overwritten\n"
								: null,
							ownerAfterRaw: index
								? "preexisting-owner-must-not-be-overwritten\n"
								: null,
							ownerPreserved: true,
						}
					: {
							ownerRaw: JSON.stringify(owner),
							ownerStatRaw: stat(ownedPid, 77, ownedPid, ticks),
							ownerAbsent: true,
						};
			const descendants =
				index === 4
					? {
							liveOwnerStatRaw: stat(ownedPid, 77, ownedPid, ticks),
							childStatRaw: stat(ownedPid + 1, ownedPid, ownedPid, "20000"),
							liveChildStatRaw: stat(ownedPid + 1, ownedPid, ownedPid, "20000"),
							cleanup: command(["/bin/bash", "-c", definition.cleanupCommand]),
							repeatCleanup: command([
								"/bin/bash",
								"-c",
								definition.cleanupCommand,
							]),
							ownerAfterRaw: JSON.stringify(owner),
							ownerReceiptUnchanged: true,
							childAbsent: true,
						}
					: {};
			return { ...value, ...ownership, ...descendants };
		},
	);
	const proof = {
		schema: "g6-c32-linux-work-process-proof/1",
		platform: "linux",
		architecture: "x64",
		startedAt: "2026-09-05T00:00:00.000Z",
		finishedAt: "2026-09-05T00:00:01.000Z",
		durationMs: 1000,
		maximumDurationMs: 30000,
		passed: true,
		cases,
		cleanupVerified: true,
		qualificationRootRemoved: true,
		qualificationRoot: root,
		runId,
		bootId,
		proofSourceSha256: expected.proofSourceSha256,
		workRemoteSourceSha256: expected.workRemoteSourceSha256,
		supervisorSourceSha256: sha(LINUX_SUPERVISOR_SOURCE),
		supervisorBinarySha256: "c".repeat(64),
		compile: command([
			"/usr/bin/cc",
			"-std=c11",
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			`${root}/supervisor.c`,
			"-o",
			`${root}/supervisor`,
		]),
	};
	return { proof, expected };
}
