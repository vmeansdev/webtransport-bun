import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendSpendLedgerEntry,
	budgetPolicyArtifactSha256,
	sealWorkSpendLedger,
	validateBudgetPolicy,
} from "./g6-c32-budget.ts";
import {
	canonicalArtifactSha256,
	canonicalJson,
	makeArtifactManifestRecord,
	requireDefined,
} from "./g6-c32-freeze-model.ts";
import {
	appendRigJournalEvent,
	initializeRigJournal,
} from "./g6-c32-rig-journal.ts";
import { validateDesiredRig, validateRigState } from "./g6-c32-rig-model.ts";
import {
	publishTerminalEvidence,
	verifyTerminalEvidence,
} from "./g6-c32-terminal-evidence.ts";
import { workPolicyFixture } from "./g6-c32-work-fixture.test-helper.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const digest = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");
const defaultAt = "2026-09-05T00:10:00.000Z";
function fixture(
	mode: "full" | "partial" | "survivor" | "empty" = "full",
	work?: {
		verifiedAbsentAt?: string;
		alteration?: "absence" | "policy" | "price" | "missing-price" | "downgrade";
	},
) {
	const root = mkdtempSync(join(tmpdir(), "g6-terminal-"));
	roots.push(root);
	const runId = "g6-terminal-test";
	const at = work?.verifiedAbsentAt ?? defaultAt;
	const startedAt = work ? "2026-09-05T00:00:00.000Z" : at;
	const workPolicy = work
		? validateBudgetPolicy({ ...workPolicyFixture(), runId })
		: null;
	const settlementPolicy =
		workPolicy && work?.alteration === "policy"
			? validateBudgetPolicy({
					...workPolicy,
					totalBudgetMicrousd: workPolicy.totalBudgetMicrousd + 1,
				})
			: workPolicy;
	const preSealRoot = "seals/pre";
	mkdirSync(join(root, preSealRoot), { recursive: true });
	const clock = { wallNow: () => at };
	const journalPath = join(root, "rig-state.json");
	const desired = validateDesiredRig({
		recordedAt: startedAt,
		requestedAt: startedAt,
		deadline: "2026-09-05T02:00:00.000Z",
		runId,
		managementTag: "g6-managed",
		runTag: runId,
		roles: {
			serverName: `${runId}-server`,
			generatorName: `${runId}-generator`,
		},
		profile: {
			region: "lon1",
			size: "c-32",
			image: "ubuntu-24-04-x64",
			vpcUuid: "test-vpc",
			projectMode: "assign",
			projectId: "test-project",
			sshKeyId: 77,
			expectedVcpus: 32,
			expectedMemoryMiB: 65536,
		},
		semantic: {
			freezeAuthoritySha256: "1".repeat(64),
			freezeArtifactSha256: "2".repeat(64),
			approvalAuthoritySha256: "3".repeat(64),
			approvalArtifactSha256: "4".repeat(64),
		},
		budget: workPolicy
			? {
					campaignId: workPolicy.campaignId,
					lifecycle: workPolicy.lifecycle,
					policyPath: "campaign/budget-policy.json",
					policySha256: budgetPolicyArtifactSha256(workPolicy),
					totalBudgetMicrousd: workPolicy.totalBudgetMicrousd,
					spentBeforeMicrousd: workPolicy.spentBeforeMicrousd,
					priorLedgerArtifactSha256: requireDefined(workPolicy.priorLedger)
						.sha256,
					maximumLifecycleCostMicrousd: workPolicy.maximumLifecycleCostMicrousd,
					maximumLifecycleSeconds: workPolicy.maximumLifecycleSeconds,
					teardownReserveSeconds: workPolicy.teardownReserveSeconds,
					rolePriceCeilingMicrousd: workPolicy.maximumRoleHourlyMicrousd,
				}
			: {
					campaignId: "g6-capacity",
					lifecycle: "rca-only",
					policyPath: "campaign/budget-policy.json",
					policySha256: "a".repeat(64),
					totalBudgetMicrousd: 10000000,
					spentBeforeMicrousd: 0,
					priorLedgerArtifactSha256: null,
					maximumLifecycleCostMicrousd: 4552100,
					maximumLifecycleSeconds: 5700,
					teardownReserveSeconds: 600,
					rolePriceCeilingMicrousd: { server: 1300600, generator: 1300600 },
				},
	});
	const createdResources = [
		{ id: 101, role: "server" },
		{ id: 102, role: "generator" },
	];
	const ownedResources =
		mode !== "full"
			? []
			: createdResources.map(({ id, role }) => ({
					id,
					role,
					source: "CREATED",
					creationAttempt: 1,
					recordedAt: at,
					recordedIdentity: {
						id,
						role,
						name: `${runId}-${role}`,
						tags: [desired.managementTag, runId],
						region: "lon1",
						size: "c-32",
						image: "ubuntu-24-04-x64",
						vpcUuid: "test-vpc",
						projectId: "test-project",
						sshKeyIds: [77],
						vcpus: 32,
						memoryMiB: 65536,
						status: "active",
						createdAt: at,
						publicIpv4: `203.0.113.${id}`,
						privateIpv4: `10.0.0.${id}`,
					},
				}));
	const preCreateBudgetAuthority =
		workPolicy && work?.alteration !== "missing-price"
			? {
					priceReceipt: {
						recordedAt: startedAt,
						clockSource: "provider",
						runId,
						serverHourlyMicrousd: 1949400,
						generatorHourlyMicrousd: 1949400,
						artifactSha256: "b".repeat(64),
					},
					absenceProof: {
						recordedAt: startedAt,
						clockSource: "provider",
						runId,
						campaignTag: desired.managementTag,
						liveProviderIds: [],
						artifactSha256: "c".repeat(64),
					},
				}
			: null;
	const rigState = validateRigState({
		desired,
		preCreateBudgetAuthority,
		lifecycle: "DESTROYED",
		ownedResources,
		createIntent: null,
		creationAttempt: mode === "empty" ? 0 : 1,
		evidence: {
			offrunnerEvidenceSealed: true,
			controllerExited: true,
			cleanupDisposition: "CLEANUP_COMPLETE",
			inventoryAmbiguous: mode === "partial" || mode === "survivor",
		},
	});
	initializeRigJournal(
		{ path: journalPath, runId, desiredRigAuthority: desired },
		{ clock, randomId: () => "test" },
	);
	const envelope = {
		recordedAt: at,
		sequence: 1,
		runId,
		phase: "FINAL",
		operationId: "offrunner-artifact-manifest",
		clockSource: "offrunner" as const,
	};
	const first = settlementPolicy
		? appendSpendLedgerEntry(null, {
				recordedAt: startedAt,
				campaignId: settlementPolicy.campaignId,
				runId,
				budgetPolicySha256: budgetPolicyArtifactSha256(settlementPolicy),
				event: "CREATE_INTENT",
				rigJournalEventArtifactSha256: "e".repeat(64),
				accruedLifecycleMicrousd: 0,
				prospectiveCellMicrousd: 0,
				teardownReserveMicrousd: 649800,
				totalAuthorizedMicrousd: settlementPolicy.spentBeforeMicrousd + 4353660,
				remainingBudgetMicrousd: 7189796,
				decision: null,
			})
		: appendSpendLedgerEntry(null, {
				recordedAt: at,
				campaignId: "g6-capacity",
				runId,
				budgetPolicySha256: "a".repeat(64),
				event: "PRICE_VERIFIED",
				accruedLifecycleMicrousd: 0,
				prospectiveCellMicrousd: 0,
				teardownReserveMicrousd: 0,
				totalAuthorizedMicrousd: 100,
				remainingBudgetMicrousd: 900,
				decision: null,
			});
	let sealed = settlementPolicy
		? sealWorkSpendLedger({
				policy: settlementPolicy,
				entries: [first],
				recordedAt: at,
				verifiedAbsentAt:
					work?.alteration === "absence"
						? new Date(Date.parse(at) - 60000).toISOString()
						: at,
				hourlyMicrousdByRole:
					work?.alteration === "price"
						? { server: 600000, generator: 600000 }
						: settlementPolicy.maximumRoleHourlyMicrousd,
			})
		: appendSpendLedgerEntry(first, {
				...first,
				event: "SEAL",
				accruedLifecycleMicrousd: 20,
				totalAuthorizedMicrousd: 120,
				remainingBudgetMicrousd: 880,
			});
	if (
		work?.alteration === "downgrade" &&
		sealed.schema === "g6-c32-spend-ledger-entry/2"
	) {
		const { settlement: _settlement, ...fields } = sealed;
		sealed = { ...fields, schema: "g6-c32-spend-ledger-entry/1" };
	}
	writeFileSync(
		join(root, "spend-ledger.json"),
		canonicalJson([first, sealed]),
	);
	writeFileSync(
		join(root, preSealRoot, "pre-destroy-spend-ledger.json"),
		canonicalJson([first]),
	);
	writeFileSync(join(root, "benchmark.json"), '{"raw":true}\n');
	const entries = [
		"benchmark.json",
		`${preSealRoot}/pre-destroy-spend-ledger.json`,
	].map((path) => {
		const bytes = readFileSync(join(root, path));
		return {
			path: `run/${path}`,
			bytes: bytes.length,
			sha256: digest(bytes),
			recordedAt: at,
		};
	});
	const manifest = makeArtifactManifestRecord(envelope, entries);
	writeFileSync(
		join(root, preSealRoot, "artifact-manifest.json"),
		canonicalJson(manifest),
	);
	writeFileSync(
		join(root, preSealRoot, "seal-receipt.json"),
		canonicalJson({
			schema: "g6-c32-offrunner-seal/1",
			envelope,
			manifestArtifactSha256: canonicalArtifactSha256(manifest),
		}),
	);
	appendRigJournalEvent(
		journalPath,
		{
			state: "TERMINAL",
			kind: "RESULT",
			operationId: "offrunner-evidence-sealed",
			details: {
				result: {
					sealRoot: join(root, preSealRoot),
					manifestArtifactSha256: canonicalArtifactSha256(manifest),
				},
			},
		},
		{ clock, randomId: () => "seal" },
	);
	const deletedIds =
		mode === "empty" ? [] : mode === "survivor" ? [102] : [101, 102];
	if (mode === "partial" || mode === "survivor") {
		appendRigJournalEvent(
			journalPath,
			{
				state: "FAILED",
				kind: "RESULT",
				operationId: "do-create-result",
				details: { cloud: { createdResources } },
			},
			{ clock, randomId: () => "created" },
		);
		appendRigJournalEvent(
			journalPath,
			{
				state: "DESTROYING",
				kind: "INTENT",
				operationId: "destroy-journaled-created-pair-before-provider",
				details: { cloud: { ids: deletedIds, createdResources } },
			},
			{ clock, randomId: () => "intent" },
		);
	}
	const operationId =
		mode === "full"
			? "destroy-exact-pair-verified"
			: mode === "empty"
				? "destroy-empty-inventory-verified"
				: "destroy-journaled-created-pair-verified";
	const journal = appendRigJournalEvent(
		journalPath,
		{
			state: "DESTROYED",
			kind: "RESULT",
			operationId,
			details: { rigState, cloud: { deletedIds, verifiedAbsentAt: at } },
		},
		{ clock, randomId: () => "destroy" },
	);
	writeFileSync(
		join(root, "destruction-receipt.json"),
		canonicalJson({
			schema: "g6-c32-destruction-receipt/1",
			envelope: { ...envelope, phase: "DESTROYED" },
			desiredRigAuthoritySha256: journal.desiredRigAuthoritySha256,
			finalJournalArtifactSha256: canonicalArtifactSha256(journal),
			deletedIds,
			verifiedAbsentAt: at,
			runTagInventoryEmpty: true,
		}),
	);
	return { root, runId, preSealRoot, expectedDeletedIds: deletedIds };
}

test.each([
	"absence",
	"policy",
	"price",
	"missing-price",
	"downgrade",
] as const)("rejects self-consistent work settlement with %s differing from journal authority", (alteration) => {
	const input = fixture("full", { alteration });
	expect(() => publishTerminalEvidence(input)).toThrow(
		/settlement|authority|price/,
	);
	expect(existsSync(join(input.root, "terminal/terminal-receipt.json"))).toBe(
		false,
	);
});

test("publishes overrun teardown evidence without granting work or losing excess liability", () => {
	const input = fixture("full", {
		verifiedAbsentAt: "2026-09-05T04:00:00.000Z",
	});
	const before = readFileSync(
		join(input.root, input.preSealRoot, "artifact-manifest.json"),
	);
	const receipt = publishTerminalEvidence(input);
	const seal = JSON.parse(
		readFileSync(join(input.root, "terminal/spend-seal-receipt.json"), "utf8"),
	);
	expect(receipt.status).toBe("TEARDOWN_VERIFIED");
	expect(receipt.sealedTotalMicrousd).toBe(91350910 + 240 * 64980);
	expect(seal.remainingBudgetMicrousd).toBe(0);
	expect(seal.settlement.overrunMicrousd).toBe(
		receipt.sealedTotalMicrousd - 103544166,
	);
	expect(seal.totalAuthorizedMicrousd).toBe(91350910 + 4353660);
	expect(publishTerminalEvidence(input)).toEqual(receipt);
	expect(verifyTerminalEvidence(input.root)).toEqual(receipt);
	expect(
		readFileSync(join(input.root, input.preSealRoot, "artifact-manifest.json")),
	).toEqual(before);
});

test("rejects a receipt that omits an ID from the committed destruction even when the caller agrees", () => {
	const input = fixture();
	const path = join(input.root, "destruction-receipt.json");
	const receipt = JSON.parse(readFileSync(path, "utf8"));
	receipt.deletedIds = [101];
	writeFileSync(path, canonicalJson(receipt));
	input.expectedDeletedIds = [101];
	expect(() => publishTerminalEvidence(input)).toThrow(
		/committed|journal|owned/,
	);
});

test("rejects rewritten raw evidence and self-consistent pre-seal bytes against the journal commit", () => {
	const input = fixture();
	writeFileSync(join(input.root, "benchmark.json"), "replacement\n");
	const path = join(input.root, input.preSealRoot, "artifact-manifest.json");
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	const entry = manifest.entries.find(
		(entry: { path: string }) => entry.path === "run/benchmark.json",
	);
	entry.sha256 = digest("replacement\n");
	entry.bytes = Buffer.byteLength("replacement\n");
	writeFileSync(path, canonicalJson(manifest));
	const receiptPath = join(input.root, input.preSealRoot, "seal-receipt.json");
	const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
	receipt.manifestArtifactSha256 = canonicalArtifactSha256(manifest);
	writeFileSync(receiptPath, canonicalJson(receipt));
	expect(() => publishTerminalEvidence(input)).toThrow(
		/journal.*seal|seal.*journal/,
	);
});

test("publishes immutable pre/post teardown bindings and verifies all final bytes", () => {
	const input = fixture();
	const before = readFileSync(
		join(input.root, input.preSealRoot, "artifact-manifest.json"),
	);
	const receipt = publishTerminalEvidence(input);
	expect(receipt.status).toBe("TEARDOWN_VERIFIED");
	expect(receipt.sealedTotalMicrousd).toBe(120);
	expect(verifyTerminalEvidence(input.root)).toEqual(receipt);
	expect(publishTerminalEvidence(input)).toEqual(receipt);
	expect(
		readFileSync(join(input.root, input.preSealRoot, "artifact-manifest.json")),
	).toEqual(before);
});

test.each([
	"partial",
	"survivor",
	"empty",
] as const)("derives %s cleanup IDs without requiring a fully parsed owned pair", (mode) => {
	const { expectedDeletedIds, ...input } = fixture(mode);
	const receipt = publishTerminalEvidence(input);
	expect(receipt.deletedIds).toEqual(expectedDeletedIds);
	expect(verifyTerminalEvidence(input.root)).toEqual(receipt);
});

test.each([
	"benchmark.json",
	"spend-ledger.json",
	"destruction-receipt.json",
	"rig-state.json",
	"terminal/final-spend-ledger.json",
])("detects post-teardown mutation of %s without rewriting evidence", (path) => {
	const input = fixture();
	publishTerminalEvidence(input);
	const receipt = readFileSync(
		join(input.root, "terminal/terminal-receipt.json"),
	);
	writeFileSync(join(input.root, path), "tampered\n");
	expect(() => verifyTerminalEvidence(input.root)).toThrow();
	expect(() => publishTerminalEvidence(input)).toThrow();
	expect(
		readFileSync(join(input.root, "terminal/terminal-receipt.json")),
	).toEqual(receipt);
});

test("refuses unsealed spend, wrong deleted IDs, reused journal and mutable pre-seal ledger", () => {
	for (const mutation of ["ledger", "ids", "journal", "pre"]) {
		const input = fixture();
		if (mutation === "ledger") {
			const ledger = JSON.parse(
				readFileSync(join(input.root, "spend-ledger.json"), "utf8"),
			);
			writeFileSync(
				join(input.root, "spend-ledger.json"),
				canonicalJson(ledger.slice(0, 1)),
			);
		} else if (mutation === "ids") input.expectedDeletedIds = [101];
		else if (mutation === "journal") {
			const destruction = JSON.parse(
				readFileSync(join(input.root, "destruction-receipt.json"), "utf8"),
			);
			destruction.finalJournalArtifactSha256 = "f".repeat(64);
			writeFileSync(
				join(input.root, "destruction-receipt.json"),
				canonicalJson(destruction),
			);
		} else {
			const path = join(
				input.root,
				input.preSealRoot,
				"artifact-manifest.json",
			);
			const manifest = JSON.parse(readFileSync(path, "utf8"));
			manifest.entries[1].path = "run/spend-ledger.json";
			writeFileSync(path, canonicalJson(manifest));
		}
		expect(() => publishTerminalEvidence(input)).toThrow();
		expect(existsSync(join(input.root, "terminal/terminal-receipt.json"))).toBe(
			false,
		);
	}
});

test.each([
	"snapshots",
	"manifest",
	"receipt",
] as const)("replays a publication crash after %s without changing prior files", (boundary) => {
	const input = fixture();
	expect(() =>
		publishTerminalEvidence({
			...input,
			onPublishBoundary: (at) => {
				if (at === boundary) throw new Error("simulated crash");
			},
		}),
	).toThrow("simulated crash");
	const ledger = readFileSync(
		join(input.root, "terminal/final-spend-ledger.json"),
	);
	const result = publishTerminalEvidence(input);
	expect(verifyTerminalEvidence(input.root)).toEqual(result);
	expect(
		readFileSync(join(input.root, "terminal/final-spend-ledger.json")),
	).toEqual(ledger);
});
