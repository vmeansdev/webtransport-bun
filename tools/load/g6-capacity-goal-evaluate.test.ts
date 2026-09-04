import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
} from "./g6-c32-freeze-model.ts";

const SOURCE_SHA = "724ae1f9711f10dcfe1e67381bc47a088e404c6d";
const PLAN_SHA =
	"b2085021e669ce518e8967551c18b4d5047539fdb8e1b8e6295f3bfa8fed33ad";
const SPEC_SHA =
	"5b1f72d99001488bce836abe9914b3807b1b9e9a63b9e27939fbe6e6ffb6ceb3";
const SEMANTIC_FREEZE_AUTHORITY_SHA = "a".repeat(64);

type RungGate = "PASS" | "MISS";

type ScenarioOptions = {
	rungs?: Array<{ label: string; rung: number; gate: RungGate }>;
	companions?: Array<{ label: "C1" | "C2"; pass: boolean }>;
	unsupportedAdapters?: boolean;
	breakExecutionReceipt?: (receipt: Record<string, unknown>) => string;
	breakContract?: (contract: Record<string, unknown>) => void;
	breakLedgerText?: string;
	tamperManifest?: boolean;
};

function writeText(path: string, text: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, text);
}

function writeJson(path: string, value: unknown): void {
	writeText(path, canonicalJson(value));
}

function sha256Text(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function reviewReceipt(
	role: "architect" | "critic",
	architectArtifactSha256: string | null,
) {
	const authority = {
		semanticFreezeAuthoritySha256: SEMANTIC_FREEZE_AUTHORITY_SHA,
		role,
		verdict: "APPROVE" as const,
		unconditional: true as const,
		afterArchitectReceiptArtifactSha256:
			role === "critic" ? architectArtifactSha256 : null,
	};
	return {
		schema: "g6-c32-review-receipt/1",
		envelope: {
			recordedAt:
				role === "architect"
					? "2026-09-04T10:00:00.000Z"
					: "2026-09-04T10:00:01.000Z",
			sequence: role === "architect" ? 2 : 3,
			runId: "g6-40k-capacity-closure-r1",
			phase: role === "architect" ? "ARCHITECT_REVIEW" : "CRITIC_REVIEW",
			operationId: role === "architect" ? "architect-review" : "critic-review",
			clockSource: "offrunner" as const,
		},
		authoritySha256: canonicalAuthoritySha256(authority),
		authority,
	};
}

function executionReceipt(kind: string): Record<string, unknown> {
	return {
		schema: "g6-capacity-execution-receipt/1",
		kind,
		sourceSha: SOURCE_SHA,
		phase: "verification",
		commands: [
			{
				argv: ["bun", "test", "tools/load/example.test.ts"],
				exitCode: 0,
				passed: 1,
				failed: 0,
			},
		],
		liveEvidence: false,
		note: "fixture",
	};
}

function rcaCell(label: string): Record<string, unknown> {
	return {
		schema: "g6-c32-rca-cell/1",
		cell: label,
		complete: true,
		reasons: [],
		functionalPass: true,
		rcaQualityPass: true,
		rigCleanPass: true,
		ingressCleanPass: true,
		connectWallSec: 1,
		connectOwnedSocketDrops: 0,
		connectServerRcvbufErrors: 0,
		generatorConnectErrors: 0,
		postConnectServerRcvbufErrors: 0,
		hostSocketDropEquality: true,
		maxFallbackSessionExcessPerShard: 0,
		peakReceiveQueueBytes: 1,
		effectiveReceiveBufferBytes: 1,
		effectiveSendBufferBytes: 1,
		udpSendBatchCongestionDropped: 0,
		datagramReflectRingBypassed: 0,
		steadySent: 1,
		drainStallAligned: true,
	};
}

function successorGrade(gate: RungGate): Record<string, unknown> {
	return {
		schema: "g6-c32-successor-grade/1",
		profileLabel: "successor-g6",
		registrationSha256: "b".repeat(64),
		expectCandidate: SOURCE_SHA,
		profile: {
			shards: 16,
			endpoints: 128,
			connectConcurrency: 500,
			connectRatePerSec: 0,
			fixedSourcePortBase: 40000,
			ackReflector: "js",
			serverWorkers: 2,
			serverGro: "off",
			serverRecvRuntime: "shared",
			ackCadence: "default",
		},
		valid: true,
		invalidReasons: [],
		gate,
		clauses: {},
		steeredTotal: 1,
		udpSendBatchCongestionDropped: 0,
		datagramReflectRingBypassed: 0,
	};
}

function companionSummary(
	label: "C1" | "C2",
	pass: boolean,
): Record<string, unknown> {
	return {
		schema: "g6-c32-session-scale-evidence/1",
		label,
		complete: true,
		reasons: [],
		requestedSessions: 50_000,
		activeWorkloadSessions: 40_000,
		sessionsOk: pass ? 50_000 : 49_000,
		sessionsErr: pass ? 0 : 1,
		steadySessionsLost: 0,
		lifecycleClean: pass,
		hostClean: pass,
		passiveJoinCount: 10_000,
		ingestRatio: pass ? 0.999 : 0.9,
		deliveryRatio: pass ? 0.999 : 0.9,
		dutyRatio: pass ? 0.999 : 0.9,
	};
}

function sealEntry(): Record<string, unknown> {
	return {
		schema: "g6-c32-spend-ledger-entry/1",
		sequence: 1,
		recordedAt: "2026-09-04T10:30:00.000Z",
		campaignId: "g6-40k-capacity-closure",
		runId: "g6-40k-capacity-closure-r1",
		budgetPolicySha256: "c".repeat(64),
		previousEntryArtifactSha256: null,
		rigJournalEventArtifactSha256: null,
		event: "SEAL",
		accruedLifecycleMicrousd: 100,
		prospectiveCellMicrousd: 0,
		teardownReserveMicrousd: 0,
		totalAuthorizedMicrousd: 100,
		remainingBudgetMicrousd: 12_193_156,
		decision: null,
	};
}

function scenario(options: ScenarioOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "g6-capacity-goal-"));
	const evidenceRoot = join(root, "evidence");
	const repoRoot = root;
	mkdirSync(evidenceRoot, { recursive: true });
	mkdirSync(join(evidenceRoot, "receipts"), { recursive: true });
	mkdirSync(join(evidenceRoot, "companions"), { recursive: true });
	mkdirSync(join(repoRoot, ".omx/goals/performance/g6-40k-capacity-closure"), {
		recursive: true,
	});

	const architectPath = ".scratch/reviews/architect.json";
	const criticPath = ".scratch/reviews/critic.json";
	const architect = reviewReceipt("architect", null);
	const architectArtifactSha256 = canonicalArtifactSha256(architect);
	const critic = reviewReceipt("critic", architectArtifactSha256);
	writeJson(join(repoRoot, architectPath), architect);
	writeJson(join(repoRoot, criticPath), critic);

	const executionKinds = [
		"candidate-local-native",
		"candidate-local-linux",
		"harness-lifecycle",
		"bounded-overload",
	];
	for (const kind of executionKinds) {
		const path = join(repoRoot, `.scratch/local/${kind}.json`);
		const receipt = executionReceipt(kind);
		if (options.breakExecutionReceipt && kind === "candidate-local-native") {
			writeText(path, options.breakExecutionReceipt(receipt));
		} else {
			writeJson(path, receipt);
		}
	}

	const defaultRungs = [
		{ label: "L5000-1", rung: 5_000, gate: "PASS" as const },
		{ label: "L10000-1", rung: 10_000, gate: "PASS" as const },
		{ label: "L20000-1", rung: 20_000, gate: "PASS" as const },
		{ label: "L30000-1", rung: 30_000, gate: "PASS" as const },
	];
	for (const { label, rung, gate } of options.rungs ?? defaultRungs) {
		writeJson(
			join(evidenceRoot, "receipts", `${label}.rca.json`),
			rcaCell(label),
		);
		writeJson(
			join(evidenceRoot, "receipts", `${label}.grade.json`),
			successorGrade(gate),
		);
	}

	for (const companion of options.companions ?? []) {
		writeJson(
			join(evidenceRoot, "companions", companion.label, "summary.json"),
			companionSummary(companion.label, companion.pass),
		);
	}

	const manifestPayloadPath = "receipts/manifest-payload.json";
	writeJson(join(evidenceRoot, manifestPayloadPath), { value: 1 });
	const payloadText = readFileSync(
		join(evidenceRoot, manifestPayloadPath),
		"utf8",
	);
	const payloadSha = sha256Text(payloadText);
	const manifest = {
		schema: "g6-c32-artifact-manifest/1",
		envelope: {
			recordedAt: "2026-09-04T10:31:00.000Z",
			sequence: 1,
			runId: "g6-40k-capacity-closure-r1",
			phase: "FINAL",
			operationId: "offrunner-artifact-manifest",
			clockSource: "offrunner" as const,
		},
		entries: [
			{
				path: manifestPayloadPath,
				sha256: payloadSha,
				bytes: Buffer.byteLength(payloadText),
				recordedAt: "2026-09-04T10:31:00.000Z",
			},
		],
	};
	writeJson(join(evidenceRoot, "artifact-manifest.json"), manifest);
	if (options.tamperManifest) {
		writeJson(join(evidenceRoot, manifestPayloadPath), { value: 2 });
	}

	const seal = sealEntry();
	if (options.breakLedgerText) {
		writeText(join(evidenceRoot, "spend-ledger.json"), options.breakLedgerText);
	} else {
		writeJson(join(evidenceRoot, "spend-ledger.json"), [seal]);
	}
	writeJson(join(evidenceRoot, "seal-receipt.json"), seal);

	const adapterSchemas = {
		diagnostics: "g6-capacity-diagnostic-coverage/1",
		waiterSafety: "g6-capacity-waiter-safety/1",
		sameHostA: "g6-capacity-same-host-audit/1",
		finalTeardown: "g6-capacity-final-teardown/1",
	};
	for (const [name, schema] of Object.entries(adapterSchemas)) {
		writeJson(join(evidenceRoot, "receipts", `${name}.json`), { schema });
	}

	const contract: Record<string, unknown> = {
		schema: "g6-capacity-goal-contract/1",
		objective: {
			slug: "g6-40k-capacity-closure",
			sourceSha: SOURCE_SHA,
			planSha256: PLAN_SHA,
			specSha256: SPEC_SHA,
			evidenceRoot: "evidence",
			targetSessions: 40_000,
			ceilingProbeSessions: 50_000,
			aggregateBudgetMicrousd: 103_544_166,
			sealedPriorSpendMicrousd: 91_350_910,
			headroomMicrousd: 12_193_256,
		},
		approvals: {
			semanticFreezeAuthoritySha256: SEMANTIC_FREEZE_AUTHORITY_SHA,
			architectPath,
			criticPath,
		},
		localVerification: {
			receipts: executionKinds.map((kind) => ({
				label: kind,
				receiptKind: kind,
				path: `.scratch/local/${kind}.json`,
			})),
		},
		pendingAdapters: {
			diagnostics: {
				schema: adapterSchemas.diagnostics,
				path: "receipts/diagnostics.json",
			},
			waiterSafety: {
				schema: adapterSchemas.waiterSafety,
				path: "receipts/waiterSafety.json",
			},
			sameHostA: {
				schema: adapterSchemas.sameHostA,
				path: "receipts/sameHostA.json",
			},
			finalTeardown: {
				schema: adapterSchemas.finalTeardown,
				path: "receipts/finalTeardown.json",
			},
		},
		ladder: {
			runs: [
				{
					label: "L5000-1",
					rung: 5_000,
					rcaPath: "receipts/L5000-1.rca.json",
					gradePath: "receipts/L5000-1.grade.json",
				},
				{
					label: "L10000-1",
					rung: 10_000,
					rcaPath: "receipts/L10000-1.rca.json",
					gradePath: "receipts/L10000-1.grade.json",
				},
				{
					label: "L20000-1",
					rung: 20_000,
					rcaPath: "receipts/L20000-1.rca.json",
					gradePath: "receipts/L20000-1.grade.json",
				},
				{
					label: "L30000-1",
					rung: 30_000,
					rcaPath: "receipts/L30000-1.rca.json",
					gradePath: "receipts/L30000-1.grade.json",
				},
				...(options.rungs ?? defaultRungs)
					.filter(({ rung }) => rung >= 40_000)
					.map(({ label, rung }) => ({
						label,
						rung,
						rcaPath: `receipts/${label}.rca.json`,
						gradePath: `receipts/${label}.grade.json`,
					})),
			],
			companionRoot: "companions",
		},
		finalAudit: {
			spendLedgerPath: "spend-ledger.json",
			sealReceiptPath: "seal-receipt.json",
			artifactManifestPath: "artifact-manifest.json",
		},
	};
	if (!options.unsupportedAdapters) {
		delete contract.pendingAdapters;
	}
	options.breakContract?.(contract);
	const contractPath = join(
		repoRoot,
		".omx/goals/performance/g6-40k-capacity-closure/contract.json",
	);
	writeJson(contractPath, contract);
	return { repoRoot, evidenceRoot, contractPath, root };
}

function runEvaluator(
	repoRoot: string,
	evidenceRoot: string,
	contractPath: string,
) {
	return Bun.spawnSync({
		cmd: [
			process.execPath,
			join(import.meta.dir, "g6-capacity-goal-evaluate.ts"),
			"--evidence-root",
			evidenceRoot,
			"--contract",
			contractPath,
		],
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
}

function parseStdout(stdout: Uint8Array): Record<string, unknown> {
	return JSON.parse(Buffer.from(stdout).toString("utf8"));
}

describe("g6-capacity-goal-evaluate", () => {
	test("reports a proven 40k miss even while future adapter schemas remain pending", () => {
		const fixture = scenario({
			unsupportedAdapters: true,
			rungs: [
				{ label: "L5000-1", rung: 5_000, gate: "PASS" },
				{ label: "L10000-1", rung: 10_000, gate: "PASS" },
				{ label: "L20000-1", rung: 20_000, gate: "PASS" },
				{ label: "L30000-1", rung: 30_000, gate: "PASS" },
				{ label: "L40000-1", rung: 40_000, gate: "MISS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(1);
			const decision = parseStdout(result.stdout);
			expect(decision.status).toBe("MISS");
			expect(decision.liveTargetStatus).toBe("MISS");
			expect(decision.reasons).toContain(
				"future adapter g6-capacity-diagnostic-coverage/1 is not yet supported",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("fails closed on unsupported adapter schemas when the live target is not yet resolved", () => {
		const fixture = scenario({
			unsupportedAdapters: true,
			rungs: [
				{ label: "L5000-1", rung: 5_000, gate: "PASS" },
				{ label: "L10000-1", rung: 10_000, gate: "PASS" },
				{ label: "L20000-1", rung: 20_000, gate: "PASS" },
				{ label: "L30000-1", rung: 30_000, gate: "PASS" },
				{ label: "L40000-1", rung: 40_000, gate: "PASS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.status).toBe("INCOMPLETE");
			expect(decision.liveTargetStatus).toBe("UNPROVEN");
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("rejects stale source SHA in a local verification receipt", () => {
		const fixture = scenario({
			breakExecutionReceipt(receipt) {
				return canonicalJson({ ...receipt, sourceSha: "d".repeat(40) });
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"local receipt candidate-local-native sourceSha differs from contract sourceSha",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("rejects forged passing flags without executable command proof", () => {
		const fixture = scenario({
			breakExecutionReceipt(receipt) {
				const { commands, ...rest } = receipt;
				return canonicalJson({ ...rest, passed: true, commands: [] });
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"local receipt candidate-local-native is malformed",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("rejects missing 40k replication on an otherwise clean target", () => {
		const fixture = scenario({
			rungs: [
				{ label: "L5000-1", rung: 5_000, gate: "PASS" },
				{ label: "L10000-1", rung: 10_000, gate: "PASS" },
				{ label: "L20000-1", rung: 20_000, gate: "PASS" },
				{ label: "L30000-1", rung: 30_000, gate: "PASS" },
				{ label: "L40000-1", rung: 40_000, gate: "PASS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"missing required rung receipt L40000-2",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("rejects missing companions after a 50k miss above a replicated 40k clean rung", () => {
		const fixture = scenario({
			rungs: [
				{ label: "L5000-1", rung: 5_000, gate: "PASS" },
				{ label: "L10000-1", rung: 10_000, gate: "PASS" },
				{ label: "L20000-1", rung: 20_000, gate: "PASS" },
				{ label: "L30000-1", rung: 30_000, gate: "PASS" },
				{ label: "L40000-1", rung: 40_000, gate: "PASS" },
				{ label: "L40000-2", rung: 40_000, gate: "PASS" },
				{ label: "L50000-1", rung: 50_000, gate: "MISS" },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain("missing C1/summary.json");
			expect(decision.reasons).toContain("missing C2/summary.json");
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("rejects local green receipts without live rung proof", () => {
		const fixture = scenario();
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"missing required rung receipt L40000-1",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("rejects tampered final-manifest content", () => {
		const fixture = scenario({
			tamperManifest: true,
			rungs: [
				{ label: "L5000-1", rung: 5_000, gate: "PASS" },
				{ label: "L10000-1", rung: 10_000, gate: "PASS" },
				{ label: "L20000-1", rung: 20_000, gate: "PASS" },
				{ label: "L30000-1", rung: 30_000, gate: "PASS" },
				{ label: "L40000-1", rung: 40_000, gate: "PASS" },
				{ label: "L40000-2", rung: 40_000, gate: "PASS" },
				{ label: "L50000-1", rung: 50_000, gate: "MISS" },
			],
			companions: [
				{ label: "C1", pass: true },
				{ label: "C2", pass: true },
			],
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"artifact manifest entry receipts/manifest-payload.json hash mismatch",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("rejects Infinity and negative values in final spend evidence", () => {
		const fixture = scenario({
			breakLedgerText:
				'[{"schema":"g6-c32-spend-ledger-entry/1","sequence":1,"recordedAt":"2026-09-04T10:30:00.000Z","campaignId":"g6-40k-capacity-closure","runId":"g6-40k-capacity-closure-r1","budgetPolicySha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","previousEntryArtifactSha256":null,"rigJournalEventArtifactSha256":null,"event":"SEAL","accruedLifecycleMicrousd":1e309,"prospectiveCellMicrousd":0,"teardownReserveMicrousd":0,"totalAuthorizedMicrousd":-1,"remainingBudgetMicrousd":12193156,"decision":null}]',
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain("spend ledger is malformed");
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("rejects zero target sessions in the contract", () => {
		const fixture = scenario({
			breakContract(contract) {
				const objective = contract.objective as Record<string, unknown>;
				objective.targetSessions = 0;
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain("contract is malformed");
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);

	test("treats an unbound semantic freeze digest as an explicit incomplete state", () => {
		const fixture = scenario({
			breakContract(contract) {
				const approvals = contract.approvals as Record<string, unknown>;
				approvals.semanticFreezeAuthoritySha256 = null;
			},
		});
		try {
			const result = runEvaluator(
				fixture.repoRoot,
				fixture.evidenceRoot,
				fixture.contractPath,
			);
			expect(result.exitCode).toBe(2);
			const decision = parseStdout(result.stdout);
			expect(decision.reasons).toContain(
				"approval semantic freeze authority digest is unbound",
			);
		} finally {
			rmSync(fixture.root, { force: true, recursive: true });
		}
	}, 15_000);
});
