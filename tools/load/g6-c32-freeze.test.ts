import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateBudgetPolicy } from "./g6-c32-budget.ts";
import { makeAttributionWorkPlan } from "./g6-c32-capacity-work.ts";
import {
	bindHostFreeze,
	type CreateSemanticFreezeInput,
	createSemanticFreeze,
	DEFAULT_CAMPAIGN_INPUT_PATHS,
	FORBIDDEN_MISE_NODE_PATH,
	runBoundVerifyCli,
	runDispatchCli,
	runFreezeCli,
	runFreezeCommandCli,
	runQualificationCli,
	type SemanticFreezeDependencies,
	validateLockedExactPair,
	verifyBoundFreeze,
	verifyRetainedBoundFreeze,
	verifySemanticApproval,
	verifySemanticFreeze,
} from "./g6-c32-freeze.ts";
import {
	canonicalArtifactSha256,
	canonicalJson,
	type GeneratedViewContext,
	makeArtifactManifestRecord,
	makeAuthorityRecord,
	makeDispatchFreezeRecord,
	type RecordEnvelope,
	type ReviewReceiptRecord,
	renderExactIdentitySheet,
	renderRegistration,
	renderRunbook,
	type SemanticApprovalRecord,
	type SemanticFreezeRecord,
	validateDispatchFreezeRecord,
} from "./g6-c32-freeze-model.ts";
import { G6_C32_GATE_CATALOG, runGatePhase } from "./g6-c32-gates.ts";
import { preparedGateSshArgs } from "./g6-c32-prepared-command.ts";
import {
	collectPreparedNativeProof,
	PREPARED_NATIVE_GATE_IDS,
	verifyPreparedNativeProof,
} from "./g6-c32-prepared-proof.ts";
import {
	appendRigJournalEvent,
	initializeRigJournal,
} from "./g6-c32-rig-journal.ts";
import { makeAttributionWorkProfiles } from "./g6-c32-work-profile.ts";
import {
	CAPACITY_LINUX_PROOF_TESTS,
	CAPACITY_NATIVE_PROOF_TESTS,
} from "./g6-capacity-proof-catalog.ts";
import { linuxProbeProofFixture } from "./g6-linux-probe-proof.fixture.test-helper.ts";

const temporaryRoots: string[] = [];

function git(root: string, ...args: string[]): string {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(
			`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout.trim();
}

const realGitResult: SemanticFreezeDependencies["runGit"] = (root, args) => {
	const result = spawnSync("git", ["-C", root, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
	});
	if (result.error) throw result.error;
	return {
		status: result.status ?? 1,
		stdout: result.stdout,
		stderr: result.stderr,
	};
};

describe("fresh batched current Git inspection", () => {
	test("bounds Git call counts independently of semantic input count", () => {
		const { root, input } = makeRepository();
		const calls: string[][] = [];
		const runGit: SemanticFreezeDependencies["runGit"] = (cwd, args) => {
			calls.push([...args]);
			return realGitResult(cwd, args);
		};
		const freeze = createSemanticFreeze(input, {
			repositoryPath: root,
			runGit,
			now,
		});
		expect(freeze.authority.campaignInputs).toHaveLength(
			DEFAULT_CAMPAIGN_INPUT_PATHS.length,
		);
		for (const command of ["ls-files", "ls-tree", "hash-object", "diff"])
			expect(calls.filter((args) => args.includes(command))).toHaveLength(1);
		for (const args of calls.filter(
			(args) =>
				args.includes("ls-files") ||
				args.includes("ls-tree") ||
				args.includes("diff"),
		))
			expect(args).toContain("--literal-pathspecs");
		expect(calls.find((args) => args.includes("hash-object"))).toContain(
			"--no-filters",
		);
		expect(calls.length).toBeLessThanOrEqual(10);
		calls.length = 0;
		expect(
			verifySemanticFreeze(freeze, { repositoryPath: root, runGit }),
		).toEqual(freeze);
		for (const command of ["ls-files", "ls-tree", "hash-object", "diff"])
			expect(calls.filter((args) => args.includes(command))).toHaveLength(1);
	}, 60_000);

	test("rejects HEAD movement during a fresh inspection", () => {
		const { root, input } = makeRepository();
		let moved = false;
		expect(() =>
			createSemanticFreeze(input, {
				repositoryPath: root,
				now,
				runGit: (cwd, args) => {
					const result = realGitResult(cwd, args);
					if (!moved && args.includes("hash-object")) {
						git(
							root,
							"commit",
							"--quiet",
							"--allow-empty",
							"-m",
							"Move HEAD during inspection",
						);
						moved = true;
					}
					return result;
				},
			}),
		).toThrow(/HEAD.*(changed|moved)/);
		expect(moved).toBe(true);
	}, 60_000);

	test("resolves the candidate tree from the captured commit rather than a moving HEAD alias", () => {
		const { root, input } = makeRepository();
		const initial = git(root, "rev-parse", "HEAD");
		let moved = false;
		const freeze = createSemanticFreeze(input, {
			repositoryPath: root,
			now,
			runGit: (cwd, args) => {
				if (!moved && args.some((arg) => arg.endsWith("^{tree}"))) {
					writeFixture(
						root,
						"unrelated.txt",
						"temporary unrelated HEAD tree\n",
					);
					git(root, "add", "unrelated.txt");
					git(root, "commit", "--quiet", "-m", "Temporarily move HEAD tree");
					const result = realGitResult(cwd, args);
					git(root, "update-ref", "HEAD", initial);
					moved = true;
					return result;
				}
				return realGitResult(cwd, args);
			},
		});
		expect(moved).toBe(true);
		expect(freeze.authority.candidate).toEqual({
			commit: initial,
			tree: git(root, "rev-parse", `${initial}^{tree}`),
		});
	}, 60_000);

	test("rejects raw bytes changed after the Git object inspection", () => {
		const { root, input } = makeRepository();
		let changed = false;
		expect(() =>
			createSemanticFreeze(input, {
				repositoryPath: root,
				now,
				readBytes: (path) => {
					if (!changed) {
						writeFileSync(
							path,
							"changed between raw Git inspection and authority hashing\n",
						);
						changed = true;
					}
					return readFileSync(path);
				},
			}),
		).toThrow(/tracked|HEAD|inspected/);
		expect(changed).toBe(true);
	}, 60_000);

	test("supports literal tracked paths, binary bytes and truly untracked metadata", () => {
		const { root, input } = makeRepository();
		input.planPath = "campaign/[literal] plan.md";
		writeFileSync(join(root, input.planPath), Buffer.from([0xff, 0, 0x61, 10]));
		git(root, "--literal-pathspecs", "add", "--", input.planPath);
		git(root, "commit", "--quiet", "-m", "Add literal binary authority input");
		input.runbookTemplatePath = "campaign/untracked runbook.md";
		writeFixture(root, input.runbookTemplatePath, "untracked template\n");
		writeFixture(root, "unrelated.txt", "unrelated worktree dirt\n");
		const freeze = createSemanticFreeze(input, { repositoryPath: root, now });
		expect(freeze.authority.plan.sha256).toBe(
			sha256(readFileSync(join(root, input.planPath))),
		);
		expect(verifySemanticFreeze(freeze, { repositoryPath: root })).toEqual(
			freeze,
		);
		writeFixture(root, input.planPath, "dirty literal tracked authority\n");
		expect(() =>
			createSemanticFreeze(input, { repositoryPath: root, now }),
		).toThrow(/tracked|HEAD/);
	}, 60_000);

	test.each([
		"--assume-unchanged",
		"--skip-worktree",
	])("rejects bound drift hidden by %s", (flag) => {
		const { root, input } = makeRepository();
		git(root, "update-index", flag, input.controllerPath);
		writeFixture(root, input.controllerPath, "hidden changed controller\n");
		expect(() =>
			createSemanticFreeze(input, { repositoryPath: root, now }),
		).toThrow(/tracked|HEAD/);
	}, 60_000);

	test.each([
		"executable",
		"staged-mode",
		"symlink",
		"missing-index",
	] as const)("rejects %s substitution in the tracked batch", (kind) => {
		const { root, input } = makeRepository();
		if (kind === "executable")
			chmodSync(join(root, input.controllerPath), 0o755);
		else if (kind === "staged-mode")
			git(root, "update-index", "--chmod=+x", input.controllerPath);
		else if (kind === "missing-index")
			git(root, "rm", "--cached", "--", input.controllerPath);
		else {
			unlinkSync(join(root, input.controllerPath));
			symlinkSync(
				join(root, "unrelated.txt"),
				join(root, input.controllerPath),
			);
		}
		expect(() =>
			createSemanticFreeze(input, { repositoryPath: root, now }),
		).toThrow(/tracked|HEAD|regular|symlink|index/);
	}, 60_000);

	test.each([
		["ls-files", "duplicate"],
		["ls-files", "extra"],
		["ls-files", "missing"],
		["ls-files", "stage"],
		["ls-files", "mode"],
		["ls-files", "truncated"],
		["ls-tree", "duplicate"],
		["ls-tree", "extra"],
		["ls-tree", "missing"],
		["ls-tree", "mode"],
		["ls-tree", "truncated"],
		["ls-tree", "failure"],
	] as const)(
		"rejects %s %s batch records",
		(command, kind) => {
			const { root, input } = makeRepository();
			let injected = false;
			expect(() =>
				createSemanticFreeze(input, {
					repositoryPath: root,
					now,
					runGit: (cwd, args) => {
						const result = realGitResult(cwd, args);
						if (!args.includes(command) || !args.includes("-z")) return result;
						injected = true;
						const rows = result.stdout.slice(0, -1).split("\0");
						const first = rows[0];
						if (!first) throw Error("real Git batch fixture must have records");
						if (kind === "duplicate") rows.push(first);
						else if (kind === "extra")
							rows.push(first.replace(/\t.*$/, "\tunrelated.txt"));
						else if (kind === "missing") rows.shift();
						else if (kind === "stage") rows[0] = first.replace(/ 0\t/, " 2\t");
						else if (kind === "mode")
							rows[0] = first.replace(/^100644/, "120000");
						return {
							...result,
							status: kind === "failure" ? 1 : result.status,
							stdout:
								kind === "truncated"
									? result.stdout.slice(0, -1)
									: `${rows.join("\0")}\0`,
						};
					},
				}),
			).toThrow(/Git|tracked|HEAD|batch|index/);
			expect(injected).toBe(true);
		},
		60_000,
	);

	test.each([
		"missing",
		"extra",
		"reversed",
		"truncated",
		"malformed",
		"failure",
	] as const)("rejects %s raw object batch output", (kind) => {
		const { root, input } = makeRepository();
		let injected = false;
		expect(() =>
			createSemanticFreeze(input, {
				repositoryPath: root,
				now,
				runGit: (cwd, args) => {
					const result = realGitResult(cwd, args);
					if (!args.includes("hash-object")) return result;
					injected = true;
					const rows = result.stdout.trimEnd().split("\n");
					if (kind === "missing") rows.shift();
					else if (kind === "extra") rows.push("f".repeat(40));
					else if (kind === "reversed") rows.reverse();
					else if (kind === "malformed") rows[0] = "invalid-object";
					return {
						...result,
						status: kind === "failure" ? 1 : result.status,
						stdout:
							kind === "truncated"
								? result.stdout.slice(0, -1)
								: `${rows.join("\n")}\n`,
					};
				},
			}),
		).toThrow(/Git|HEAD/);
		expect(injected).toBe(true);
	}, 60_000);

	test("rejects oversized batch output before parsing it", () => {
		const { root, input } = makeRepository();
		expect(() =>
			createSemanticFreeze(input, {
				repositoryPath: root,
				now,
				runGit: (cwd, args) =>
					args.includes("ls-files")
						? { status: 0, stdout: "x".repeat(1024 * 1024 + 1), stderr: "" }
						: realGitResult(cwd, args),
			}),
		).toThrow(/Git batch/);
	}, 60_000);

	test("correlates NUL records by literal path instead of output order", () => {
		const { root, input } = makeRepository();
		const freeze = createSemanticFreeze(input, {
			repositoryPath: root,
			now,
			runGit: (cwd, args) => {
				const result = realGitResult(cwd, args);
				return args.includes("-z")
					? {
							...result,
							stdout: `${result.stdout.slice(0, -1).split("\0").reverse().join("\0")}\0`,
						}
					: result;
			},
		});
		expect(verifySemanticFreeze(freeze, { repositoryPath: root })).toEqual(
			freeze,
		);
	}, 60_000);

	test("preserves unrelated staged dirt and clean hidden-index flags", () => {
		const { root, input } = makeRepository();
		writeFixture(root, "unrelated.txt", "unrelated staged dirt\n");
		git(root, "add", "unrelated.txt");
		git(root, "update-index", "--assume-unchanged", input.controllerPath);
		git(root, "update-index", "--skip-worktree", input.planPath);
		const freeze = createSemanticFreeze(input, { repositoryPath: root, now });
		expect(verifySemanticFreeze(freeze, { repositoryPath: root })).toEqual(
			freeze,
		);
	}, 60_000);

	test("compares raw working bytes even when Git clean filters erase the difference", () => {
		const { root, input } = makeRepository();
		git(root, "config", "core.autocrlf", "true");
		const path = join(root, input.planPath);
		writeFileSync(path, readFileSync(path, "utf8").replaceAll("\n", "\r\n"));
		expect(git(root, "hash-object", input.planPath)).toBe(
			git(root, "rev-parse", `HEAD:${input.planPath}`),
		);
		expect(() =>
			createSemanticFreeze(input, { repositoryPath: root, now }),
		).toThrow(/tracked.*HEAD/);
	}, 60_000);
});

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function writeFixture(root: string, path: string, contents: string): void {
	const absolutePath = join(root, path);
	mkdirSync(join(absolutePath, ".."), { recursive: true });
	writeFileSync(absolutePath, contents);
}

function resealBoundFixture(root: string): void {
	const old = JSON.parse(
		readFileSync(join(root, "artifact-manifest.json"), "utf8"),
	);
	const paths: string[] = [];
	const walk = (prefix: string): void => {
		for (const entry of readdirSync(join(root, prefix), {
			withFileTypes: true,
		})) {
			const path = join(prefix, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (
				!["RUN_STATUS", "SHA256SUMS", "artifact-manifest.json"].includes(path)
			)
				paths.push(path);
		}
	};
	walk("");
	paths.sort();
	const manifest = makeArtifactManifestRecord(
		old.envelope,
		paths.map((path) => {
			const bytes = readFileSync(join(root, path));
			return {
				path,
				sha256: sha256(bytes),
				bytes: bytes.byteLength,
				recordedAt: old.envelope.recordedAt,
			};
		}),
	);
	writeFixture(root, "artifact-manifest.json", canonicalJson(manifest));
	writeFixture(
		root,
		"SHA256SUMS",
		`${[...paths, "artifact-manifest.json"]
			.sort()
			.map((path) => `${sha256(readFileSync(join(root, path)))}  ${path}`)
			.join("\n")}\n`,
	);
}

function budgetPolicy(runId: string, overrides: Record<string, unknown> = {}) {
	return {
		schema: "g6-c32-budget-policy/1",
		campaignId: "g6-c32-rca-fix-01",
		runId,
		currency: "USD",
		lifecycle: "rca-only",
		totalBudgetMicrousd: 10_000_000,
		spentBeforeMicrousd: 0,
		maximumRoleHourlyMicrousd: {
			server: 1_300_600,
			generator: 1_300_600,
		},
		maximumLifecycleSeconds: 5_700,
		teardownReserveSeconds: 600,
		maximumLifecycleCostMicrousd: 4_552_100,
		cellMaximumSeconds: {
			probe: 180,
			matrix: 180,
			interaction: 180,
			transfer: 180,
		},
		allowedStages: ["probe", "matrix", "interaction", "transfer"],
		priorLedger: null,
		...overrides,
	};
}

function workBudgetPolicy(runId: string, setupMaximumSeconds = 840) {
	return validateBudgetPolicy(
		budgetPolicy(runId, {
			schema: "g6-c32-budget-policy/2",
			lifecycle: "attribution-only",
			spentBeforeMicrousd: 1,
			priorLedger: {
				path: "prior.json",
				sha256: "b".repeat(64),
				sealedSpentMicrousd: 1,
			},
			maximumLifecycleSeconds: setupMaximumSeconds + 3420,
			maximumLifecycleCostMicrousd:
				setupMaximumSeconds === 2100 ? 4422040 : 3511620,
			cellMaximumSeconds: { attribution: 420 },
			allowedStages: ["attribution"],
			workPlan: {
				...makeAttributionWorkPlan(),
				setupMaximumSeconds,
				activeMaximumSeconds: setupMaximumSeconds + 3420,
			},
			workProfiles: makeAttributionWorkProfiles({
				shards: 16,
				endpoints: 128,
				connectConcurrency: 50,
				connectRatePerSec: 250,
				fixedSourcePortBase: 20000,
				receiveBufferBytes: 26214400,
				gradeMode: "rca-only",
				ackReflector: "native",
				serverWorkers: 2,
				serverGro: "off",
				serverRecvRuntime: "shared",
				ackCadence: "default",
				pacerPps: 0,
				udpSendBatch: 0,
				serverUdpSendBufferBytes: 0,
				serverUdpSendEagainMode: "wait",
				reflectRingBypass: "off",
				detailedProbe: true,
				nativeDiagnostics: true,
			}),
		}),
	);
}

function makeRepository(policyOverrides: Record<string, unknown> = {}): {
	root: string;
	input: CreateSemanticFreezeInput;
} {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "g6-c32-freeze-")));
	temporaryRoots.push(root);
	git(root, "init", "--quiet");
	git(root, "config", "user.name", "G6 Freeze Test");
	git(root, "config", "user.email", "g6-freeze@example.invalid");

	const input: CreateSemanticFreezeInput = {
		runId: "g6-c32-freeze-test",
		planPath: "campaign/plan.md",
		controllerPath: "tools/load/g6-c32-rca-controller.sh",
		budgetPolicyPath: "campaign/budget-policy.json",
		registrationTemplatePath: "tools/load/templates/g6-registration.md",
		runbookTemplatePath: "tools/load/templates/g6-runbook.md",
		gateCatalogPath: "tools/load/g6-c32-gates.ts",
	};
	const boundPaths = [
		input.planPath,
		input.controllerPath,
		"tools/load/g6-c32-freeze.ts",
		input.registrationTemplatePath,
		input.runbookTemplatePath,
		...DEFAULT_CAMPAIGN_INPUT_PATHS,
		input.gateCatalogPath,
	];
	for (const [index, path] of boundPaths.entries()) {
		writeFixture(root, path, `fixture ${index}: ${path}\n`);
	}
	writeFixture(
		root,
		input.gateCatalogPath,
		`${JSON.stringify(G6_C32_GATE_CATALOG)}\n`,
	);
	writeFixture(
		root,
		input.budgetPolicyPath,
		`${JSON.stringify(budgetPolicy(input.runId, policyOverrides))}\n`,
	);
	writeFixture(root, "unrelated.txt", "unrelated original\n");
	git(root, "add", ".");
	git(root, "commit", "--quiet", "-m", "Add semantic freeze fixture");
	return { root, input };
}

const now = () => "2026-08-30T12:00:00.000Z";

function createFixtureFreeze(): {
	root: string;
	freeze: SemanticFreezeRecord;
	input: CreateSemanticFreezeInput;
} {
	const { root, input } = makeRepository();
	const freeze = createSemanticFreeze(input, { repositoryPath: root, now });
	return { root, freeze, input };
}

function envelope(
	freeze: SemanticFreezeRecord,
	sequence: number,
	phase: string,
	operationId: string,
	recordedAt = "2026-08-30T12:00:00.000Z",
): RecordEnvelope {
	return {
		recordedAt,
		sequence,
		runId: freeze.envelope.runId,
		phase,
		operationId,
		clockSource: "offrunner",
	};
}

function makeApprovalChain(freeze: SemanticFreezeRecord): {
	architect: ReviewReceiptRecord;
	critic: ReviewReceiptRecord;
	approval: SemanticApprovalRecord;
} {
	const architect = makeAuthorityRecord(
		"g6-c32-review-receipt/1",
		envelope(freeze, 2, "ARCHITECT_REVIEW", "architect-review"),
		{
			semanticFreezeAuthoritySha256: freeze.authoritySha256,
			role: "architect" as const,
			verdict: "APPROVE" as const,
			unconditional: true as const,
			afterArchitectReceiptArtifactSha256: null,
		},
	);
	const architectArtifactSha256 = canonicalArtifactSha256(architect);
	const critic = makeAuthorityRecord(
		"g6-c32-review-receipt/1",
		envelope(freeze, 3, "CRITIC_REVIEW", "critic-review"),
		{
			semanticFreezeAuthoritySha256: freeze.authoritySha256,
			role: "critic" as const,
			verdict: "APPROVE" as const,
			unconditional: true as const,
			afterArchitectReceiptArtifactSha256: architectArtifactSha256,
		},
	);
	const criticArtifactSha256 = canonicalArtifactSha256(critic);
	const approval = makeAuthorityRecord(
		"g6-c32-semantic-approval/1",
		envelope(freeze, 4, "SEMANTIC_APPROVAL", "semantic-approval"),
		{
			semanticFreezeAuthoritySha256: freeze.authoritySha256,
			architect: {
				verdict: "APPROVE" as const,
				unconditional: true as const,
				receiptPath: "reviews/architect.json",
				receiptArtifactSha256: architectArtifactSha256,
			},
			critic: {
				verdict: "APPROVE" as const,
				unconditional: true as const,
				receiptPath: "reviews/critic.json",
				receiptArtifactSha256: criticArtifactSha256,
				afterArchitectReceiptArtifactSha256: architectArtifactSha256,
			},
		},
	);
	return { architect, critic, approval };
}

function operationFixture(
	runId: string,
	sequence: number,
	phase: string,
	operationId: string,
) {
	return {
		schema: "g6-c32-operation-receipt/1" as const,
		envelope: {
			recordedAt: "2026-08-30T12:20:00.000Z",
			sequence,
			runId,
			phase,
			operationId,
			clockSource: "offrunner" as const,
		},
		startedAt: "2026-08-30T12:20:00.000Z",
		finishedAt: "2026-08-30T12:20:00.000Z",
		durationMonotonicNs: "1",
		attempt: 1,
		action: {
			command: "fixture",
			args: [operationId],
			cwd: ".",
			environmentKeys: [],
		},
		status: { outcome: "SUCCEEDED" as const, exitCode: 0, signal: null },
		stdoutPath: `operations/${operationId}/operation.stdout`,
		stderrPath: `operations/${operationId}/operation.stderr`,
		remoteTiming: null,
	};
}

async function makeBindingFixture(
	outputName = "bound-freeze",
	vcpus = 32,
	preparedNative = false,
	prepareRepository?: (root: string, input: CreateSemanticFreezeInput) => void,
): Promise<{
	root: string;
	provisioningRoot: string;
	outputName: string;
	bindInput: Parameters<typeof bindHostFreeze>[0];
	semanticApproval: SemanticApprovalRecord;
	semanticFreeze: SemanticFreezeRecord;
}> {
	const { root, input } = makeRepository();
	const remoteCheckoutPath = preparedNative
		? `/opt/g6/run/${input.runId}-attempt-1/source`
		: "/opt/g6/run/source";
	prepareRepository?.(root, input);
	const semanticFreeze = createSemanticFreeze(input, {
		repositoryPath: root,
		now,
	});
	const {
		architect,
		critic,
		approval: semanticApproval,
	} = makeApprovalChain(semanticFreeze);
	writeFixture(root, "reviews/architect.json", canonicalJson(architect));
	writeFixture(root, "reviews/critic.json", canonicalJson(critic));
	const provisioningRoot = join(root, "provisioning", input.runId);
	mkdirSync(provisioningRoot, { recursive: true });
	const semanticFreezePath = join(provisioningRoot, "semantic-freeze.json");
	const semanticApprovalPath = join(provisioningRoot, "semantic-approval.json");
	writeFileSync(semanticFreezePath, canonicalJson(semanticFreeze));
	writeFileSync(semanticApprovalPath, canonicalJson(semanticApproval));

	const rigJournalPath = join(provisioningRoot, "rig-state.json");
	const journalClock = { wallNow: () => "2026-08-30T12:10:00.000Z" };
	initializeRigJournal(
		{
			path: rigJournalPath,
			runId: input.runId,
			desiredRigAuthority: {
				runId: input.runId,
				semanticFreezeAuthoritySha256: semanticFreeze.authoritySha256,
				semanticApprovalAuthoritySha256: semanticApproval.authoritySha256,
			},
		},
		{ clock: journalClock, randomId: () => "fixture-init" },
	);
	for (const [index, state] of [
		"CREATING",
		"PROVISIONED",
		"PREPARING",
		"PREPARED",
	].entries()) {
		appendRigJournalEvent(
			rigJournalPath,
			{
				state: state as "CREATING" | "PROVISIONED" | "PREPARING" | "PREPARED",
				kind: "TRANSITION",
				operationId: `fixture-${state.toLowerCase()}`,
				details: { index },
			},
			{ clock: journalClock, randomId: () => `fixture-${index}` },
		);
	}

	const server = {
		id: 101,
		role: "server" as const,
		name: "g6-server",
		tags: ["g6-managed", "g6-run"],
		region: "lon1",
		size: "c-32",
		image: "ubuntu-24-04-x64",
		vpcUuid: "vpc-1",
		projectId: "project-1",
		sshKeyIds: [91],
		vcpus,
		memoryMiB: 65536,
		status: "active",
		createdAt: "2026-08-30T11:00:00.000Z",
		publicIpv4: "192.0.2.10",
		privateIpv4: "10.0.0.10",
	};
	const generator = {
		...server,
		id: 102,
		role: "generator" as const,
		name: "g6-generator",
		createdAt: "2026-08-30T11:00:01.000Z",
		publicIpv4: "192.0.2.11",
		privateIpv4: "10.0.0.11",
	};
	const knownHostsPath = join(provisioningRoot, "known_hosts");
	const knownHostsBytes = [
		"192.0.2.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIServer",
		"192.0.2.11 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGenerator",
		"",
	].join("\n");
	writeFileSync(knownHostsPath, knownHostsBytes);
	const knownHostsReceiptPath = join(
		provisioningRoot,
		"known-hosts-receipt.json",
	);
	writeFileSync(
		knownHostsReceiptPath,
		canonicalJson({
			schema: "g6-c32-known-hosts/1",
			envelope: {
				recordedAt: "2026-08-30T12:11:00.000Z",
				sequence: 1,
				runId: input.runId,
				phase: "BINDING",
				operationId: "capture-known-hosts",
				clockSource: "offrunner",
			},
			knownHostsPath,
			knownHostsSha256: sha256(Buffer.from(knownHostsBytes)),
			entries: [
				{
					role: "server",
					dropletId: server.id,
					publicIpv4: server.publicIpv4,
					keyType: "ssh-ed25519",
					keySha256: "1".repeat(64),
					capturedAt: "2026-08-30T12:10:58.000Z",
				},
				{
					role: "generator",
					dropletId: generator.id,
					publicIpv4: generator.publicIpv4,
					keyType: "ssh-ed25519",
					keySha256: "2".repeat(64),
					capturedAt: "2026-08-30T12:10:59.000Z",
				},
			],
		}),
	);

	const nativeBytes = Buffer.from("native-addon-fixture\n");
	const generatorBytes = Buffer.from("mmo-client-fixture\n");
	const bundleBytes = Buffer.from("exact-bundle-fixture\n");
	const retainedNativePath = join(provisioningRoot, "native-addon.node");
	const retainedGeneratorPath = join(provisioningRoot, "mmo-client");
	const bundlePath = join(provisioningRoot, "candidate.bundle");
	writeFileSync(retainedNativePath, nativeBytes);
	writeFileSync(retainedGeneratorPath, generatorBytes);
	writeFileSync(bundlePath, bundleBytes);
	const preparationOperationPath = join(
		provisioningRoot,
		"operations",
		"prepare-fixture",
		"operation.receipt.json",
	);
	mkdirSync(join(preparationOperationPath, ".."), { recursive: true });
	writeFileSync(
		preparationOperationPath,
		canonicalJson(
			operationFixture(input.runId, 1, "PREPARING", "prepare-fixture"),
		),
	);
	const preparationReceiptPath = join(
		provisioningRoot,
		"preparation-receipt.json",
	);
	writeFileSync(
		preparationReceiptPath,
		canonicalJson({
			schema: "g6-c32-host-preparation/1",
			envelope: {
				recordedAt: "2026-08-30T12:12:00.000Z",
				sequence: 2,
				runId: input.runId,
				phase: "PREPARED",
				operationId: "prepare-hosts",
				clockSource: "offrunner",
			},
			hostIds: { server: server.id, generator: generator.id },
			binaryHashes: {
				nativeAddonSha256: sha256(nativeBytes),
				generatorSha256: sha256(generatorBytes),
			},
			operationReceipts: ["operations/prepare-fixture/operation.receipt.json"],
		}),
	);

	const identityOperationReceiptPaths = {
		server: join(provisioningRoot, "server-identity-operation.json"),
		generator: join(provisioningRoot, "generator-identity-operation.json"),
	};
	writeFileSync(
		identityOperationReceiptPaths.server,
		canonicalJson(
			operationFixture(input.runId, 40, "BINDING", "collect-identity-server"),
		),
	);
	writeFileSync(
		identityOperationReceiptPaths.generator,
		canonicalJson(
			operationFixture(
				input.runId,
				41,
				"BINDING",
				"collect-identity-generator",
			),
		),
	);
	const identityPacketPaths = {
		server: join(provisioningRoot, "server-identity.json"),
		generator: join(provisioningRoot, "generator-identity.json"),
	};
	const packet = (
		provider: typeof server | typeof generator,
		sequence: number,
		bootId: string,
	) => ({
		schema: "g6-c32-host-identity/1",
		envelope: {
			recordedAt: "2026-08-30T12:13:00.000Z",
			sequence,
			runId: input.runId,
			phase: "BINDING",
			operationId: `collect-identity-${provider.role}`,
			clockSource: provider.role,
		},
		provider,
		bootId,
		source: {
			commit: semanticFreeze.authority.candidate.commit,
			tree: semanticFreeze.authority.candidate.tree,
			statusPorcelain: "",
		},
		runtime: {
			os: "Linux",
			osRelease: "Ubuntu 24.04",
			kernel: "6.8.0",
			bunVersion: "1.3.14",
			rustcVersion: "rustc 1.89.0",
			cargoVersion: "cargo 1.89.0",
		},
		binary: {
			kind: provider.role === "server" ? "native-addon" : "mmo-client",
			path:
				provider.role === "server"
					? `${remoteCheckoutPath}/crates/native/webtransport-native.linux-x64-gnu.node`
					: `${remoteCheckoutPath}/target/release/mmo-client`,
			sha256:
				provider.role === "server"
					? sha256(nativeBytes)
					: sha256(generatorBytes),
		},
		clock: {
			requestStartedAt: "2026-08-30T12:12:59.000Z",
			responseFinishedAt: "2026-08-30T12:13:01.000Z",
			remoteWallAt: "2026-08-30T12:13:00.000Z",
			measuredSkewMilliseconds: 0,
		},
	});
	writeFileSync(
		identityPacketPaths.server,
		canonicalJson(packet(server, 40, "11111111-1111-4111-8111-111111111111")),
	);
	writeFileSync(
		identityPacketPaths.generator,
		canonicalJson(
			packet(generator, 41, "22222222-2222-4222-8222-222222222222"),
		),
	);

	const gateReceiptPaths: string[] = [];
	for (const [phase, sequenceStart] of [
		["LOCAL", 100],
		["PREPARED_HOST", 200],
	] as const) {
		await runGatePhase({
			runId: input.runId,
			phase,
			catalog: G6_C32_GATE_CATALOG,
			sequenceStart,
			inputs: {
				G6_C32_REMOTE_BUNDLE_PATH: "/opt/g6/candidate.bundle",
				G6_C32_REMOTE_SMOKE_SCRIPT: "/opt/g6/g6-c32-linux-smoke.sh",
				G6_C32_REMOTE_SMOKE_SERVER_EVIDENCE: "/opt/g6/evidence/server",
				G6_C32_REMOTE_SMOKE_GENERATOR_EVIDENCE: "/opt/g6/evidence/generator",
				G6_C32_SHARDS: "16",
				G6_C32_REMOTE_ROLLBACK_SCRIPT: "/opt/g6/g6-c32-rollback.sh",
				G6_C32_REMOTE_ROLLBACK_EVIDENCE: "/opt/g6/evidence/rollback",
			},
			clock: { wallNow: () => "2026-08-30T12:14:00.000Z" },
			runner: {
				execute: async (request) => {
					const receipt = operationFixture(
						input.runId,
						request.sequence,
						request.gate.phase,
						`gate-${request.gate.id}`,
					);
					const preparedIndex = (
						PREPARED_NATIVE_GATE_IDS as readonly string[]
					).indexOf(request.gate.id);
					const connectProbe =
						request.gate.id === "prepared-server-connect-probe-proof";
					if ((preparedNative && preparedIndex >= 0) || connectProbe) {
						receipt.action = {
							command: "ssh",
							args: preparedGateSshArgs({
								command: request.command,
								args: request.args,
								remoteCwd: remoteCheckoutPath,
								publicIpv4: server.publicIpv4,
								knownHostsPath,
							}),
							cwd: ".",
							environmentKeys: [],
						};
						receipt.startedAt = receipt.finishedAt = "2026-08-30T12:13:30.000Z";
						receipt.stdoutPath = `${input.runId}/operations/${request.gate.id}/operation.stdout`;
						receipt.stderrPath = `${input.runId}/operations/${request.gate.id}/operation.stderr`;
						const output = connectProbe
							? canonicalJson(
									linuxProbeProofFixture({
										bootId: "11111111-1111-4111-8111-111111111111",
										startedAt: receipt.startedAt,
										finishedAt: receipt.finishedAt,
										proofSourceSha256: sha256(
											readFileSync(
												join(root, "tools/load/g6-linux-probe-proof.ts"),
											),
										),
										producerSha256: sha256(
											readFileSync(join(root, "tools/load/g6-linux-probe.ts")),
										),
										diagnosticSourceSha256: sha256(
											readFileSync(
												join(root, "tools/load/g6-sharded-diagnostic.ts"),
											),
										),
									}),
								)
							: preparedIndex === 0
								? `${[...CAPACITY_NATIVE_PROOF_TESTS, ...CAPACITY_LINUX_PROOF_TESTS].map((name) => `test ${name} ... ok`).join("\n")}\ntest result: ok. ${CAPACITY_NATIVE_PROOF_TESTS.length + CAPACITY_LINUX_PROOF_TESTS.length} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n`
								: preparedIndex === 1
									? "Linux\n"
									: `${semanticFreeze.authority.candidate.commit}\n`;
						writeFixture(root, `provisioning/${receipt.stdoutPath}`, output);
						writeFixture(
							root,
							`provisioning/${receipt.stderrPath}`,
							"g6-prepared-boot-id=11111111-1111-4111-8111-111111111111\n",
						);
					}
					const receiptRelative = `operations/gates/${request.gate.id}/operation.receipt.json`;
					const receiptPath = join(provisioningRoot, receiptRelative);
					mkdirSync(join(receiptPath, ".."), { recursive: true });
					writeFileSync(receiptPath, canonicalJson(receipt));
					return { receipt, receiptPath: receiptRelative };
				},
			},
			onReceipt: (receipt) => {
				const path = join(
					provisioningRoot,
					"gate-receipts",
					`${receipt.gate.id}.json`,
				);
				mkdirSync(join(path, ".."), { recursive: true });
				writeFileSync(path, canonicalJson(receipt));
				gateReceiptPaths.push(path);
			},
		});
	}

	return {
		root,
		provisioningRoot,
		outputName,
		semanticApproval,
		semanticFreeze,
		bindInput: {
			runId: input.runId,
			repositoryPath: root,
			provisioningRoot,
			outputName,
			semanticFreezePath,
			semanticApprovalPath,
			rigJournalPath,
			knownHostsPath,
			knownHostsReceiptPath,
			preparationReceiptPath,
			bundlePath,
			retainedNativePath,
			retainedGeneratorPath,
			identityPacketPaths,
			identityOperationReceiptPaths,
			gateReceiptPaths,
			sequenceStart: 300,
		},
	};
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("G6 c32 semantic freeze", () => {
	test("semantic help exits without reading repository or credential state", () => {
		let output = "";
		expect(
			runFreezeCommandCli(["semantic", "--help"], {
				writeStdout: (value) => {
					output += value;
				},
				readBytes: () => {
					throw new Error("help must not read files");
				},
				runGit: () => {
					throw new Error("help must not invoke Git");
				},
			}),
		).toBeNull();
		expect(output).toContain("g6:c32:freeze -- semantic");
	}, 60_000);

	test("binds exact Git identity and every semantic input byte", () => {
		const { root, input } = makeRepository();
		const freeze = createSemanticFreeze(input, { repositoryPath: root, now });

		expect(freeze.authority.candidate).toEqual({
			commit: git(root, "rev-parse", "HEAD^{commit}"),
			tree: git(root, "rev-parse", "HEAD^{tree}"),
		});
		const identities = [
			freeze.authority.plan,
			freeze.authority.controller,
			freeze.authority.freezeGenerator,
			freeze.authority.templates.registration,
			freeze.authority.templates.runbook,
			...freeze.authority.campaignInputs,
			freeze.authority.gateCatalog,
		];
		expect(identities.map(({ path }) => path)).toEqual([
			input.planPath,
			input.controllerPath,
			"tools/load/g6-c32-freeze.ts",
			input.registrationTemplatePath,
			input.runbookTemplatePath,
			...DEFAULT_CAMPAIGN_INPUT_PATHS,
			input.gateCatalogPath,
		]);
		for (const identity of identities) {
			expect(identity.sha256).toBe(
				sha256(readFileSync(join(root, identity.path))),
			);
		}
		expect(freeze.authority.freezeGenerator.schemaVersion).toBe(
			"g6-c32-semantic-freeze/1",
		);
		expect(verifySemanticFreeze(freeze, { repositoryPath: root })).toEqual(
			freeze,
		);
	}, 60_000);

	test("rejects a semantic freeze whose artifact catalog differs from executable gates", () => {
		const { root, input } = makeRepository();
		const staleCatalog: { gates: Array<{ command: string }> } = JSON.parse(
			JSON.stringify(G6_C32_GATE_CATALOG),
		);
		const firstGate = staleCatalog.gates[0];
		if (!firstGate) throw new Error("fixture gate catalog must be nonempty");
		firstGate.command = "node";
		writeFixture(
			root,
			input.gateCatalogPath,
			`${JSON.stringify(staleCatalog)}\n`,
		);
		git(root, "add", input.gateCatalogPath);
		git(root, "commit", "--quiet", "-m", "Replace gate catalog fixture");

		expect(() =>
			createSemanticFreeze(input, { repositoryPath: root, now }),
		).toThrow(/gate catalog.*complete immutable|catalog.*differs/i);
	}, 60_000);

	test("refuses a registration whose pinned producer identities disagree with the bound inputs", () => {
		const { root, input } = makeRepository();
		const pinned = "tools/load/g6-sharded-scan.ts";
		const current = sha256(readFileSync(join(root, pinned)));
		const table = (rows: string) =>
			`# registration\n\n## Frozen producer identities\n\n| Artifact | SHA-256 |\n| --- | --- |\n${rows}\n`;
		const commitRegistration = (rows: string, message: string) => {
			writeFixture(root, input.registrationTemplatePath, table(rows));
			git(root, "add", input.registrationTemplatePath);
			git(root, "commit", "--quiet", "-m", message);
		};

		commitRegistration(
			`| \`${pinned}\` | \`${"1".repeat(64)}\` |`,
			"Pin a stale producer identity",
		);
		expect(() =>
			createSemanticFreeze(input, { repositoryPath: root, now }),
		).toThrow(/producer identit.*g6-sharded-scan\.ts/i);

		commitRegistration(
			`| \`tools/load/not-a-bound-input.ts\` | \`${current}\` |`,
			"Pin an identity the freeze does not bind",
		);
		expect(() =>
			createSemanticFreeze(input, { repositoryPath: root, now }),
		).toThrow(/producer identit.*not bound/i);

		commitRegistration(
			`| \`${pinned}\` | \`${current}\` |`,
			"Pin the current producer identity",
		);
		const freeze = createSemanticFreeze(input, { repositoryPath: root, now });
		expect(verifySemanticFreeze(freeze, { repositoryPath: root })).toEqual(
			freeze,
		);

		writeFixture(root, pinned, "changed producer\n");
		git(root, "add", pinned);
		git(
			root,
			"commit",
			"--quiet",
			"-m",
			"Change the producer without repinning",
		);
		expect(() =>
			createSemanticFreeze(input, { repositoryPath: root, now }),
		).toThrow(/producer identit.*g6-sharded-scan\.ts/i);
	}, 60_000);

	test("allows unrelated dirt but rejects bound tracked-path drift", () => {
		const { root, freeze, input } = createFixtureFreeze();
		writeFixture(root, "unrelated.txt", "unrelated local edit\n");
		expect(verifySemanticFreeze(freeze, { repositoryPath: root })).toEqual(
			freeze,
		);

		writeFixture(root, input.controllerPath, "changed controller\n");
		expect(() =>
			verifySemanticFreeze(freeze, { repositoryPath: root }),
		).toThrow(/controller|tracked|digest/i);
	}, 60_000);

	test("refuses hidden index and assume-unchanged drift on bound paths", () => {
		const first = makeRepository();
		git(
			first.root,
			"update-index",
			"--assume-unchanged",
			first.input.controllerPath,
		);
		writeFixture(
			first.root,
			first.input.controllerPath,
			"hidden local drift\n",
		);
		expect(() =>
			createSemanticFreeze(first.input, {
				repositoryPath: first.root,
				now,
			}),
		).toThrow(/tracked|HEAD|controller/i);

		const second = makeRepository();
		const original = readFileSync(
			join(second.root, second.input.controllerPath),
		);
		writeFixture(second.root, second.input.controllerPath, "staged drift\n");
		git(second.root, "add", second.input.controllerPath);
		writeFileSync(join(second.root, second.input.controllerPath), original);
		expect(() =>
			createSemanticFreeze(second.input, {
				repositoryPath: second.root,
				now,
			}),
		).toThrow(/tracked|HEAD|controller/i);
	}, 60_000);

	test("rejects the forbidden mise Node runtime without invoking it", () => {
		const { root, input } = makeRepository();
		expect(() =>
			createSemanticFreeze(
				{ ...input, runtimePath: FORBIDDEN_MISE_NODE_PATH },
				{ repositoryPath: root, now },
			),
		).toThrow(/forbidden.*mise.*node/i);
	}, 60_000);

	test("semantic CLI atomically writes one record and prints only its digests", () => {
		const { root, input } = makeRepository();
		const outputPath = "evidence/semantic-freeze.json";
		let stdout = "";
		const freeze = runFreezeCli(
			[
				"semantic",
				"--run-id",
				input.runId,
				"--plan",
				input.planPath,
				"--controller",
				input.controllerPath,
				"--budget-policy",
				input.budgetPolicyPath,
				"--registration-template",
				input.registrationTemplatePath,
				"--runbook-template",
				input.runbookTemplatePath,
				"--gate-catalog",
				input.gateCatalogPath,
				"--out",
				outputPath,
			],
			{
				repositoryPath: root,
				now,
				writeStdout: (value) => {
					stdout += value;
				},
			},
		);

		const written = JSON.parse(
			readFileSync(join(root, outputPath), "utf8"),
		) as unknown;
		expect(written).toEqual(freeze);
		expect(stdout).toBe(
			`authoritySha256=${freeze.authoritySha256}\nartifactSha256=${canonicalArtifactSha256(freeze)}\n`,
		);
		expect(readdirSync(join(root, "evidence"))).toEqual([
			"semantic-freeze.json",
		]);
		expect(stdout).not.toContain(root);
	}, 60_000);

	test("binds budget policy bytes and rejects policy drift", () => {
		const { root, input } = makeRepository();
		const budgetPolicyPath = input.budgetPolicyPath;
		const freeze = createSemanticFreeze(input, { repositoryPath: root, now });

		expect(freeze.authority.budgetPolicy.path).toBe(budgetPolicyPath);
		writeFixture(root, budgetPolicyPath, "{}\n");
		expect(() =>
			verifySemanticFreeze(freeze, { repositoryPath: root, now }),
		).toThrow(/budget|policy|bytes|HEAD/i);
	}, 60_000);

	test("rejects invalid or mismatched budget policy authority", () => {
		const mismatched = makeRepository({ runId: "different-run" });
		expect(() =>
			createSemanticFreeze(mismatched.input, {
				repositoryPath: mismatched.root,
				now,
			}),
		).toThrow(/budget policy runId/i);

		const postFixWithoutLedger = makeRepository({
			lifecycle: "post-fix-only",
		});
		expect(() =>
			createSemanticFreeze(postFixWithoutLedger.input, {
				repositoryPath: postFixWithoutLedger.root,
				now,
			}),
		).toThrow(/priorLedger/i);
	}, 60_000);
});

describe("G6 c32 semantic approval", () => {
	test("returns a typed exact sequential approval authority", () => {
		const { freeze } = createFixtureFreeze();
		const { architect, critic, approval } = makeApprovalChain(freeze);
		const verified = verifySemanticApproval(
			freeze,
			approval,
			architect,
			critic,
		);

		expect(verified.kind).toBe("g6-c32-verified-semantic-approval/1");
		expect(verified.semanticFreezeAuthoritySha256).toBe(freeze.authoritySha256);
		expect(verified.architectReceiptArtifactSha256).toBe(
			canonicalArtifactSha256(architect),
		);
		expect(verified.criticReceiptArtifactSha256).toBe(
			canonicalArtifactSha256(critic),
		);
		expect(typeof verified).toBe("object");
	}, 60_000);

	test("rejects missing, conditional, non-approve, reordered, and wrong-authority reviews", () => {
		const { freeze } = createFixtureFreeze();
		const { architect, critic, approval } = makeApprovalChain(freeze);
		expect(() =>
			verifySemanticApproval(freeze, approval, undefined, critic),
		).toThrow();
		expect(() =>
			verifySemanticApproval(freeze, approval, architect, undefined),
		).toThrow();
		expect(() =>
			verifySemanticApproval(freeze, approval, critic, architect),
		).toThrow(/architect|role|sequence/i);

		const conditionalArchitect = makeAuthorityRecord(
			"g6-c32-review-receipt/1",
			architect.envelope,
			{ ...architect.authority, unconditional: false },
		);
		expect(() =>
			verifySemanticApproval(freeze, approval, conditionalArchitect, critic),
		).toThrow(/unconditional/i);

		const rejectedCritic = makeAuthorityRecord(
			"g6-c32-review-receipt/1",
			critic.envelope,
			{ ...critic.authority, verdict: "REJECT" },
		);
		expect(() =>
			verifySemanticApproval(freeze, approval, architect, rejectedCritic),
		).toThrow(/APPROVE/i);

		const wrongFreezeArchitect = makeAuthorityRecord(
			"g6-c32-review-receipt/1",
			architect.envelope,
			{
				...architect.authority,
				semanticFreezeAuthoritySha256: "0".repeat(64),
			},
		);
		expect(() =>
			verifySemanticApproval(freeze, approval, wrongFreezeArchitect, critic),
		).toThrow(/semantic|freeze|digest/i);
	}, 60_000);

	test("rejects receipt envelope or authority substitution", () => {
		const { freeze } = createFixtureFreeze();
		const { architect, critic, approval } = makeApprovalChain(freeze);
		const rerecordedArchitect = {
			...architect,
			envelope: {
				...architect.envelope,
				recordedAt: "2026-08-30T12:00:01.000Z",
			},
		};
		expect(() =>
			verifySemanticApproval(freeze, approval, rerecordedArchitect, critic),
		).toThrow(/artifact|receipt|digest/i);

		const substitutedCritic = makeAuthorityRecord(
			"g6-c32-review-receipt/1",
			critic.envelope,
			{
				...critic.authority,
				afterArchitectReceiptArtifactSha256: "f".repeat(64),
			},
		);
		expect(() =>
			verifySemanticApproval(freeze, approval, architect, substitutedCritic),
		).toThrow(/architect|artifact|digest/i);
	}, 60_000);

	test("accepts a later top-level recording when semantic authority is unchanged", () => {
		const { freeze } = createFixtureFreeze();
		const { architect, critic, approval } = makeApprovalChain(freeze);
		const laterApproval = {
			...approval,
			envelope: {
				...approval.envelope,
				recordedAt: "2026-08-30T12:05:00.000Z",
			},
		};

		expect(canonicalArtifactSha256(laterApproval)).not.toBe(
			canonicalArtifactSha256(approval),
		);
		expect(laterApproval.authoritySha256).toBe(approval.authoritySha256);
		expect(
			verifySemanticApproval(freeze, laterApproval, architect, critic)
				.semanticFreezeAuthoritySha256,
		).toBe(freeze.authoritySha256);
	}, 60_000);
});

describe("G6 c32 atomic host-bound freeze", () => {
	test("freezes shared diagnostic coverage before online work and final replay", () => {
		expect(DEFAULT_CAMPAIGN_INPUT_PATHS).toContain(
			"tools/load/g6-capacity-diagnostic-coverage.ts",
		);
	});

	test("freezes the exact-host review verifier with the campaign inputs", () => {
		expect(DEFAULT_CAMPAIGN_INPUT_PATHS).toContain(
			"tools/load/g6-capacity-host-review.ts",
		);
		expect(DEFAULT_CAMPAIGN_INPUT_PATHS).toContain(
			"crates/native/src/server_spawn.rs",
		);
	});

	test.each([
		0, 840, 2100,
	])("derives exact-host review views and replay from frozen policy bytes, setup=%s", async (setup) => {
		const work = setup !== 0;
		const fixture = await makeBindingFixture(
			"review-policy",
			32,
			false,
			(root, input) => {
				// A misleading name cannot enable /2 review policy; /2 works without it.
				if (!work) input.runId = "g6-capacity-attribution-v2-policy-one";
				writeFixture(
					root,
					input.budgetPolicyPath,
					JSON.stringify(
						work
							? workBudgetPolicy(input.runId, setup)
							: budgetPolicy(input.runId),
					),
				);
				git(root, "rm", "--cached", "--", input.budgetPolicyPath);
				git(
					root,
					"commit",
					"--quiet",
					"-m",
					"Keep policy snapshot independent of live metadata",
				);
			},
		);
		const contexts: GeneratedViewContext[] = [];
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "review-policy",
			renderers: {
				registration: (context) => {
					contexts.push(context);
					return renderRegistration(context);
				},
				runbook: (context) => {
					contexts.push(context);
					return renderRunbook(context);
				},
			},
		});
		expect(contexts).toHaveLength(2);
		for (const context of contexts)
			expect(context.requiresExactHostReview).toBe(work ? true : undefined);
		for (const name of ["registration", "runbook"] as const) {
			const view = readFileSync(join(result.root, `views/${name}.md`), "utf8");
			expect(view.includes("no automatic retry or replacement")).toBe(work);
			expect(view.includes("retried once")).toBe(!work);
			expect(view.includes("existing 840-second setup")).toBe(setup === 840);
			expect(view.includes("2100-second setup")).toBe(setup === 2100);
			expect(view.includes("420-second qualification reserve")).toBe(
				setup === 2100,
			);
			expect(view.includes("does not restart Architect or Critic review")).toBe(
				!work,
			);
		}
		expect(
			verifyBoundFreeze(result.root, { repositoryPath: fixture.root })
				.semanticFreeze,
		).toEqual(fixture.semanticFreeze);
		// Replay must not read a later live policy, even when its schema is valid.
		const policyPath = fixture.semanticFreeze.authority.budgetPolicy.path;
		writeFixture(
			fixture.root,
			policyPath,
			JSON.stringify(
				work
					? budgetPolicy(fixture.bindInput.runId)
					: workBudgetPolicy(fixture.bindInput.runId),
			),
		);
		expect(
			verifyRetainedBoundFreeze(result.root, { repositoryPath: fixture.root })
				.semanticFreeze,
		).toEqual(fixture.semanticFreeze);
		unlinkSync(join(fixture.root, policyPath));
		expect(
			verifyRetainedBoundFreeze(result.root, { repositoryPath: fixture.root })
				.semanticFreeze,
		).toEqual(fixture.semanticFreeze);

		const context = contexts[0];
		if (!context) throw Error("missing renderer fixture context");
		for (const timingDrift of work ? [false, true] : [false]) {
			for (const name of ["registration", "runbook"] as const) {
				const copy = join(
					fixture.provisioningRoot,
					`review-drift-${timingDrift}-${name}`,
				);
				cpSync(result.root, copy, { recursive: true });
				const viewPath = `views/${name}.md`;
				const view = (
					name === "registration" ? renderRegistration : renderRunbook
				)({
					...context,
					requiresExactHostReview: timingDrift ? true : !work,
					hostReviewTiming:
						timingDrift && setup === 840
							? { setupMaximumSeconds: 2100, qualificationReserveSeconds: 420 }
							: undefined,
				});
				writeFixture(copy, viewPath, view);
				const dispatch = validateDispatchFreezeRecord(
					JSON.parse(readFileSync(join(copy, "dispatch-freeze.json"), "utf8")),
				);
				writeFixture(
					copy,
					"dispatch-freeze.json",
					canonicalJson(
						makeDispatchFreezeRecord(dispatch.envelope, {
							...dispatch.authority,
							views: {
								...dispatch.authority.views,
								[name]: { path: viewPath, sha256: sha256(Buffer.from(view)) },
							},
						}),
					),
				);
				resealBoundFixture(copy);
				expect(() =>
					verifyRetainedBoundFreeze(copy, { repositoryPath: fixture.root }),
				).toThrow(/view is not the deterministic rendering/);
			}
		}
	}, 120_000);

	test.each([
		false,
		true,
	])("refuses a renderer-supplied exact-host review flag that differs from policy bytes, work policy=%s", async (work) => {
		const fixture = await makeBindingFixture(
			"review-context-drift",
			32,
			false,
			(root, input) => {
				if (work) {
					writeFixture(
						root,
						input.budgetPolicyPath,
						JSON.stringify(workBudgetPolicy(input.runId)),
					);
					git(root, "add", input.budgetPolicyPath);
					git(root, "commit", "--quiet", "-m", "Bind work policy fixture");
				}
			},
		);
		let tick = 1n;
		await expect(
			bindHostFreeze(fixture.bindInput, {
				clock: {
					wallNow: () => "2026-08-30T12:30:00.000Z",
					monotonicNowNs: () => tick++,
				},
				randomId: () => "review-context-drift",
				renderers: {
					registration: (context) =>
						renderRegistration({ ...context, requiresExactHostReview: !work }),
					runbook: renderRunbook,
					exactIdentity: renderExactIdentitySheet,
				},
			}),
		).rejects.toThrow(/verification|deterministic rendering/i);
		expect(existsSync(join(fixture.provisioningRoot, fixture.outputName))).toBe(
			false,
		);
		expect(
			readFileSync(
				join(
					fixture.provisioningRoot,
					`${fixture.outputName}.staging-review-context-drift/RUN_STATUS`,
				),
				"utf8",
			),
		).toBe("INCOMPLETE\n");
	}, 120_000);

	test("freezes the executable real Linux process-group proof input", () => {
		expect(DEFAULT_CAMPAIGN_INPUT_PATHS).toContain(
			"tools/load/g6-c32-linux-work-process-proof.ts",
		);
	});

	test("retains every exact semantic input before publishing BOUND", async () => {
		const fixture = await makeBindingFixture();
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "retained-inputs",
		});
		const a = fixture.semanticFreeze.authority;
		const identities = [
			a.plan,
			a.controller,
			a.budgetPolicy,
			a.freezeGenerator,
			a.templates.registration,
			a.templates.runbook,
			...a.campaignInputs,
			a.gateCatalog,
		];
		const sums = readFileSync(join(result.root, "SHA256SUMS"), "utf8");
		for (const identity of identities) {
			const path = `semantic/inputs/${identity.path}`;
			expect(existsSync(join(result.root, path))).toBe(true);
			expect(sha256(readFileSync(join(result.root, path)))).toBe(
				identity.sha256,
			);
			expect(readFileSync(join(result.root, path))).toEqual(
				readFileSync(join(fixture.root, identity.path)),
			);
			expect(sums).toContain(`${identity.sha256}  ${path}\n`);
		}
	}, 120_000);

	test("historical replay permits native-only HEAD advancement but live dispatch refuses it", async () => {
		const fixture = await makeBindingFixture();
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "retained-native-change",
		});
		writeFixture(
			fixture.root,
			"crates/native/src/udp_send_batch.rs",
			"final candidate native change\n",
		);
		git(fixture.root, "add", "crates/native/src/udp_send_batch.rs");
		git(
			fixture.root,
			"commit",
			"--quiet",
			"-m",
			"Change native candidate fixture",
		);
		expect(() =>
			verifyBoundFreeze(result.root, { repositoryPath: fixture.root }),
		).toThrow(/current Git identity or bytes/);
		const historical = verifyRetainedBoundFreeze(result.root, {
			repositoryPath: fixture.root,
		});
		expect(historical.semanticFreeze).toEqual(fixture.semanticFreeze);
		expect(historical).not.toHaveProperty("shellEnvironment");
		expect(git(fixture.root, "rev-parse", "HEAD")).not.toBe(
			fixture.semanticFreeze.authority.candidate.commit,
		);
	}, 120_000);

	test("historical replay uses retained untracked plan policy templates and JSON catalog", async () => {
		let metadataPaths: string[] = [];
		const fixture = await makeBindingFixture(
			"untracked-inputs",
			32,
			false,
			(root, input) => {
				metadataPaths = [
					input.planPath,
					input.budgetPolicyPath,
					input.registrationTemplatePath,
					input.runbookTemplatePath,
				];
				git(root, "rm", "--cached", "--", ...metadataPaths);
				git(
					root,
					"commit",
					"--quiet",
					"-m",
					"Keep campaign metadata untracked in fixture",
				);
				input.gateCatalogPath = "campaign/gate-catalog.json";
				writeFixture(
					root,
					input.gateCatalogPath,
					`${JSON.stringify(G6_C32_GATE_CATALOG)}\n`,
				);
				metadataPaths.push(input.gateCatalogPath);
				writeFileSync(join(root, input.planPath), Buffer.from([0xff, 0, 0x61]));
			},
		);
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "untracked-inputs",
		});
		for (const path of metadataPaths) unlinkSync(join(fixture.root, path));
		expect(
			verifyRetainedBoundFreeze(result.root, { repositoryPath: fixture.root })
				.semanticFreeze,
		).toEqual(fixture.semanticFreeze);
	}, 120_000);

	test("historical replay rejects rehashed missing forged and extra semantic snapshots", async () => {
		const fixture = await makeBindingFixture();
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "snapshot-forgery",
		});
		const verify = verifyRetainedBoundFreeze;
		const inputPath = fixture.semanticFreeze.authority.plan.path;
		const mutations = [
			(root: string) => unlinkSync(join(root, `semantic/inputs/${inputPath}`)),
			(root: string) =>
				writeFixture(root, `semantic/inputs/${inputPath}`, "forged input\n"),
			(root: string) =>
				writeFixture(root, "semantic/inputs/unexpected.txt", "unbound input\n"),
		];
		for (const [index, mutate] of mutations.entries()) {
			const copy = join(fixture.provisioningRoot, `snapshot-tamper-${index}`);
			cpSync(result.root, copy, { recursive: true });
			mutate(copy);
			resealBoundFixture(copy);
			expect(() => verify(copy, { repositoryPath: fixture.root })).toThrow(
				/semantic input/,
			);
		}
	}, 120_000);

	test("historical replay verifies frozen Git tree and blobs independently of rehashed records", async () => {
		const fixture = await makeBindingFixture();
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "git-object-forgery",
		});
		const verify = verifyRetainedBoundFreeze;
		for (const kind of [
			"non-commit",
			"tree",
			"blob",
			"missing-input",
		] as const) {
			const copy = join(fixture.provisioningRoot, `git-tamper-${kind}`);
			cpSync(result.root, copy, { recursive: true });
			const freeze = structuredClone(fixture.semanticFreeze);
			if (kind === "non-commit")
				freeze.authority.candidate.commit = freeze.authority.candidate.tree;
			else if (kind === "tree")
				freeze.authority.candidate.tree = "f".repeat(40);
			else if (kind === "missing-input") freeze.authority.campaignInputs.pop();
			else {
				const identity = freeze.authority.campaignInputs.find(
					({ path }) => path === "crates/native/src/udp_send_batch.rs",
				);
				if (!identity)
					throw Error("fixture is missing its frozen native input");
				const bytes = "forged frozen native source\n";
				identity.sha256 = sha256(Buffer.from(bytes));
				writeFixture(copy, `semantic/inputs/${identity.path}`, bytes);
			}
			writeFixture(
				copy,
				"semantic/semantic-freeze.json",
				canonicalJson(
					makeAuthorityRecord(freeze.schema, freeze.envelope, freeze.authority),
				),
			);
			resealBoundFixture(copy);
			expect(() => verify(copy, { repositoryPath: fixture.root })).toThrow(
				kind === "non-commit"
					? /frozen Git commit/
					: kind === "tree"
						? /frozen Git tree/
						: kind === "blob"
							? /frozen Git blob/
							: /complete fixed input set/,
			);
		}
	}, 120_000);

	test("historical replay refuses current harness drift without granting a dispatch environment", async () => {
		const fixture = await makeBindingFixture();
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "harness-drift",
		});
		const verify = verifyRetainedBoundFreeze;
		writeFixture(
			fixture.root,
			"tools/load/g6-c32-freeze-model.ts",
			"changed supported rendering semantics\n",
		);
		git(fixture.root, "add", "tools/load/g6-c32-freeze-model.ts");
		git(fixture.root, "commit", "--quiet", "-m", "Change harness fixture");
		expect(() => verify(result.root, { repositoryPath: fixture.root })).toThrow(
			/supported harness/,
		);
	}, 120_000);

	test("historical replay cannot opt into an INCOMPLETE staging tree", async () => {
		const fixture = await makeBindingFixture();
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "retained-incomplete",
		});
		writeFixture(result.root, "RUN_STATUS", "INCOMPLETE\n");
		const untypedOptions = {
			repositoryPath: fixture.root,
			expectedStatus: "INCOMPLETE",
		};
		expect(() =>
			verifyRetainedBoundFreeze(result.root, untypedOptions),
		).toThrow(/RUN_STATUS must be BOUND/);
	}, 120_000);

	for (const module of [
		"system-clock",
		"cell-admission",
		"connect-probe-proof",
	])
		test(`${module}-only source mutations invalidate current and rehashed retained replay`, async () => {
			const fixture = await makeBindingFixture();
			let tick = 1n;
			const result = await bindHostFreeze(fixture.bindInput, {
				clock: {
					wallNow: () => "2026-08-30T12:30:00.000Z",
					monotonicNowNs: () => tick++,
				},
				randomId: () => "clock-source-mutation",
			});
			const path =
				module === "connect-probe-proof"
					? "tools/load/g6-linux-probe-proof.ts"
					: `tools/load/g6-c32-${module}.ts`;
			const original = readFileSync(join(fixture.root, path));
			const replacement = Buffer.concat([
				original,
				Buffer.from("\n// changed clock only\n"),
			]);
			writeFileSync(join(fixture.root, path), replacement);
			expect(() =>
				verifyBoundFreeze(result.root, { repositoryPath: fixture.root }),
			).toThrow();
			writeFileSync(join(fixture.root, path), original);
			const freeze = structuredClone(fixture.semanticFreeze);
			const identity = freeze.authority.campaignInputs.find(
				(item) => item.path === path,
			);
			if (!identity) throw Error("clock module not frozen");
			identity.sha256 = sha256(replacement);
			writeFixture(
				result.root,
				`semantic/inputs/${path}`,
				replacement.toString("utf8"),
			);
			writeFixture(
				result.root,
				"semantic/semantic-freeze.json",
				canonicalJson(
					makeAuthorityRecord(freeze.schema, freeze.envelope, freeze.authority),
				),
			);
			resealBoundFixture(result.root);
			expect(() =>
				verifyRetainedBoundFreeze(result.root, {
					repositoryPath: fixture.root,
				}),
			).toThrow(/frozen Git blob/);
		}, 120_000);

	test("historical replay ignores mutable Git replacement refs when checking frozen blobs", async () => {
		const fixture = await makeBindingFixture();
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "git-replacement-forgery",
		});
		const freeze = structuredClone(fixture.semanticFreeze);
		const identity = freeze.authority.campaignInputs.find(
			({ path }) => path === "crates/native/src/udp_send_batch.rs",
		);
		if (!identity) throw Error("fixture is missing its frozen native input");
		const originalBlob = git(
			fixture.root,
			"rev-parse",
			`${freeze.authority.candidate.commit}:${identity.path}`,
		);
		const replacement = "replacement native source\n";
		writeFixture(fixture.root, "replacement.txt", replacement);
		const replacedBlob = git(
			fixture.root,
			"hash-object",
			"-w",
			"replacement.txt",
		);
		git(fixture.root, "replace", originalBlob, replacedBlob);
		identity.sha256 = sha256(Buffer.from(replacement));
		writeFixture(result.root, `semantic/inputs/${identity.path}`, replacement);
		writeFixture(
			result.root,
			"semantic/semantic-freeze.json",
			canonicalJson(
				makeAuthorityRecord(freeze.schema, freeze.envelope, freeze.authority),
			),
		);
		resealBoundFixture(result.root);
		expect(() =>
			verifyRetainedBoundFreeze(result.root, { repositoryPath: fixture.root }),
		).toThrow(/frozen Git blob/);
	}, 120_000);

	test("collects and replays BOUND prepared-native proof from its frozen /opt checkout and refuses mutation", async () => {
		const fixture = await makeBindingFixture("bound", 48, true);
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "prepared-proof",
		});
		const input = {
			repositoryPath: fixture.root,
			boundRoot: result.root,
			knownHostsPath: fixture.bindInput.knownHostsPath,
		};
		const proof = collectPreparedNativeProof(input);
		expect(collectPreparedNativeProof(input)).toEqual(proof);
		const origin = `provisioning/${fixture.bindInput.runId}/proofs/prepared-native-origin.json`;
		expect(verifyPreparedNativeProof(fixture.root, origin)).toEqual(proof);
		const raw = `provisioning/${fixture.bindInput.runId}/operations/prepared-server-native-unit-tests/operation.stdout`;
		const original = readFileSync(join(fixture.root, raw), "utf8");
		expect(original).toContain(
			`test result: ok. ${CAPACITY_NATIVE_PROOF_TESTS.length + CAPACITY_LINUX_PROOF_TESTS.length} passed;`,
		);
		writeFixture(
			fixture.root,
			raw,
			original.replace("0 filtered out", "1 filtered out"),
		);
		expect(() => verifyPreparedNativeProof(fixture.root, origin)).toThrow(
			/filtered/,
		);
		writeFixture(fixture.root, raw, `${original}another passing annotation\n`);
		expect(() => verifyPreparedNativeProof(fixture.root, origin)).toThrow(
			/does not replay/,
		);
		expect(() => collectPreparedNativeProof(input)).toThrow(/differs/);
	}, 120_000);
	test("resumes an interrupted BINDING journal without another review", async () => {
		const fixture = await makeBindingFixture("resumed-bound-freeze");
		appendRigJournalEvent(
			fixture.bindInput.rigJournalPath,
			{
				state: "BINDING",
				kind: "RECOVERY",
				operationId: "fixture-interrupted-binding",
				details: { stagingRoot: "lost-staging" },
			},
			{
				clock: { wallNow: () => "2026-08-30T12:15:00.000Z" },
				randomId: () => "fixture-binding-resume",
			},
		);
		let monotonic = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => monotonic++,
			},
			randomId: () => "binding-resume",
		});
		expect(result.root).toBe(
			join(realpathSync(fixture.provisioningRoot), "resumed-bound-freeze"),
		);
		expect(readFileSync(join(result.root, "RUN_STATUS"), "utf8")).toBe(
			"BOUND\n",
		);
	}, 60_000);

	test("scales the bound shard count with the server droplet's vCPUs", async () => {
		const fixture = await makeBindingFixture("wide-bound-freeze", 48);
		let monotonic = 10n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => monotonic++,
			},
			randomId: () => "bind-wide",
		});
		expect(
			verifyBoundFreeze(result.root, {
				repositoryPath: fixture.root,
				expectedStatus: "BOUND",
			}).shellEnvironment,
		).toContain("G6_C32_SHARDS='24'");
	}, 60_000);

	test("connect probe raw evidence blocks binding and rehashed retained replay", async () => {
		for (const mutation of [
			"missing",
			"fabricated-pass",
			"wrong-arch",
			"wrong-source",
			"wrong-boot",
		]) {
			const fixture = await makeBindingFixture();
			const path = join(
				fixture.provisioningRoot,
				"operations/gates/prepared-server-connect-probe-proof/operation.receipt.json",
			);
			const operation = JSON.parse(readFileSync(path, "utf8"));
			const rawPath = join(
				dirname(fixture.provisioningRoot),
				operation.stdoutPath,
			);
			const proof = JSON.parse(readFileSync(rawPath, "utf8"));
			if (mutation === "missing") unlinkSync(rawPath);
			else {
				if (mutation === "fabricated-pass") proof.cases = [];
				if (mutation === "wrong-arch") proof.arch = "arm64";
				if (mutation === "wrong-source") proof.producerSha256 = "a".repeat(64);
				if (mutation === "wrong-boot")
					proof.bootId = "22222222-2222-4222-8222-222222222222";
				writeFileSync(rawPath, canonicalJson(proof));
			}
			let tick = 1n;
			await expect(
				bindHostFreeze(fixture.bindInput, {
					clock: {
						wallNow: () => "2026-08-30T12:30:00.000Z",
						monotonicNowNs: () => tick++,
					},
					randomId: () => "raw-connect-negative",
				}),
			).rejects.toThrow(/connect probe|g6-linux-probe-proof|ENOENT/);
		}
		const fixture = await makeBindingFixture();
		let tick = 1n;
		const bound = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "raw-connect-replay",
		});
		const rawPath = join(
				bound.root,
				"gates/prepared-server-connect-probe-proof.raw.json",
			),
			raw = JSON.parse(readFileSync(rawPath, "utf8")),
			proof = JSON.parse(raw.stdout);
		proof.cases[0].raw = "{}\n";
		raw.stdout = canonicalJson(proof);
		writeFileSync(rawPath, canonicalJson(raw));
		resealBoundFixture(bound.root);
		expect(() =>
			verifyRetainedBoundFreeze(bound.root, { repositoryPath: fixture.root }),
		).toThrow();
	}, 60000);

	test("publishes BOUND only after a fresh read-only verification operation", async () => {
		const fixture = await makeBindingFixture();
		let monotonic = 10n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:00.000Z",
				monotonicNowNs: () => monotonic++,
			},
			randomId: () => "bind-fixture",
		});

		expect(result.root).toBe(
			join(realpathSync(fixture.provisioningRoot), fixture.outputName),
		);
		expect(readFileSync(join(result.root, "RUN_STATUS"), "utf8")).toBe(
			"BOUND\n",
		);
		expect(result.verificationReceipt.status.outcome).toBe("SUCCEEDED");
		expect(result.verificationReceiptPath.startsWith(result.root)).toBeFalse();
		const verified = verifyBoundFreeze(result.root, {
			repositoryPath: fixture.root,
			expectedStatus: "BOUND",
		});
		expect(verified.runId).toBe(fixture.bindInput.runId);
		expect(verified.shellEnvironment).toContain("G6_C32_SERVER_ID='101'");
		expect(verified.shellEnvironment).toContain("G6_C32_GENERATOR_ID='102'");
		expect(verified.shellEnvironment).toContain("G6_C32_SHARDS='16'");
		expect(verified.shellEnvironment).not.toContain("$(`");
		let verifierStdout = "";
		expect(
			runBoundVerifyCli(["verify", "--root", result.root, "--manifest-only"], {
				repositoryPath: fixture.root,
				writeStdout: (value) => {
					verifierStdout += value;
				},
			}).shellEnvironment,
		).toBe(verifierStdout);

		const sums = readFileSync(join(result.root, "SHA256SUMS"), "utf8");
		expect(sums).not.toContain("SHA256SUMS");
		expect(sums).not.toContain("RUN_STATUS");
		expect(sums).toContain("host-binding.json");
		expect(sums).toContain("dispatch-freeze.json");
		expect(
			readdirSync(fixture.provisioningRoot).some((name) =>
				name.includes(".staging-"),
			),
		).toBeFalse();
	}, 60_000);

	test("fresh disk verification rejects every artifact class, additions, removals, and timestamps", async () => {
		const fixture = await makeBindingFixture();
		let monotonic = 50n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:31:00.000Z",
				monotonicNowNs: () => monotonic++,
			},
			randomId: () => "tamper-fixture",
		});
		const mutations: Array<(root: string) => void> = [
			(root) =>
				writeFileSync(join(root, "semantic/semantic-freeze.json"), "{}\n"),
			(root) => writeFileSync(join(root, "host-binding.json"), "{}\n"),
			(root) => writeFileSync(join(root, "views/runbook.md"), "changed\n"),
			(root) =>
				writeFileSync(
					join(root, "gates/local-bun-campaign-suite.json"),
					"{}\n",
				),
			(root) =>
				writeFileSync(join(root, "candidate/native-addon.node"), "changed\n"),
			(root) =>
				writeFileSync(join(root, "candidate/candidate.bundle"), "changed\n"),
			(root) => writeFileSync(join(root, "unexpected.txt"), "added\n"),
			(root) => unlinkSync(join(root, "candidate/mmo-client")),
			(root) => {
				const path = join(root, "artifact-manifest.json");
				const manifest = JSON.parse(readFileSync(path, "utf8"));
				manifest.envelope.recordedAt = "untimed";
				writeFileSync(path, canonicalJson(manifest));
			},
		];
		for (const [index, mutate] of mutations.entries()) {
			const copy = join(fixture.provisioningRoot, `tamper-${index}`);
			cpSync(result.root, copy, { recursive: true });
			mutate(copy);
			expect(() =>
				verifyBoundFreeze(copy, {
					repositoryPath: fixture.root,
					expectedStatus: "BOUND",
				}),
			).toThrow();
		}
	}, 60_000);

	test("preserves an INCOMPLETE staging root when a renderer fails before publish", async () => {
		const fixture = await makeBindingFixture("renderer-failure");
		let monotonic = 90n;
		await expect(
			bindHostFreeze(fixture.bindInput, {
				clock: {
					wallNow: () => "2026-08-30T12:32:00.000Z",
					monotonicNowNs: () => monotonic++,
				},
				randomId: () => "renderer-fixture",
				renderers: {
					runbook: () => {
						throw new Error("injected renderer failure");
					},
				},
			}),
		).rejects.toThrow(/renderer failure/i);
		expect(
			existsSync(join(fixture.provisioningRoot, fixture.outputName)),
		).toBeFalse();
		const staging = readdirSync(fixture.provisioningRoot).find((name) =>
			name.startsWith(`${fixture.outputName}.staging-`),
		);
		expect(staging).toBeDefined();
		expect(
			readFileSync(
				join(fixture.provisioningRoot, staging as string, "RUN_STATUS"),
				"utf8",
			),
		).toBe("INCOMPLETE\n");
	}, 60_000);

	test("a host-only replacement does not invalidate semantic approval authority", async () => {
		const fixture = await makeBindingFixture("host-only-rebind");
		const before = verifySemanticApproval(
			fixture.semanticFreeze,
			fixture.semanticApproval,
			JSON.parse(
				readFileSync(join(fixture.root, "reviews/architect.json"), "utf8"),
			),
			JSON.parse(
				readFileSync(join(fixture.root, "reviews/critic.json"), "utf8"),
			),
		);
		const serverIdentityPath = fixture.bindInput.identityPacketPaths.server;
		const packet = JSON.parse(readFileSync(serverIdentityPath, "utf8"));
		packet.provider.id = 901;
		packet.provider.name = "g6-server-replacement";
		packet.provider.publicIpv4 = "192.0.2.90";
		packet.provider.privateIpv4 = "10.0.0.90";
		packet.bootId = "99999999-9999-4999-8999-999999999999";
		writeFileSync(serverIdentityPath, canonicalJson(packet));
		const after = verifySemanticApproval(
			fixture.semanticFreeze,
			fixture.semanticApproval,
			JSON.parse(
				readFileSync(join(fixture.root, "reviews/architect.json"), "utf8"),
			),
			JSON.parse(
				readFileSync(join(fixture.root, "reviews/critic.json"), "utf8"),
			),
		);
		expect(after.semanticFreezeAuthoritySha256).toBe(
			before.semanticFreezeAuthoritySha256,
		);
		expect(after.semanticApprovalAuthoritySha256).toBe(
			before.semanticApprovalAuthoritySha256,
		);
	}, 60_000);
});

describe("G6 c32 locked exact-pair qualification", () => {
	test("requeries the exact provider and host identities without new review authority", async () => {
		const fixture = await makeBindingFixture("qualification-bound");
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:20.000Z",
				monotonicNowNs: (() => {
					let value = 1n;
					return () => value++;
				})(),
			},
			randomId: () => "qualification",
		});
		const binding = result.hostBinding;
		const providerPath = (role: "server" | "generator") => {
			const host = binding.authority.hosts[role];
			const path = join(fixture.provisioningRoot, `${role}-provider-live.json`);
			writeFileSync(
				path,
				canonicalJson([
					{
						id: host.provider.id,
						name: host.provider.name,
						tags: host.provider.tags,
						region: { slug: host.provider.region },
						size_slug: host.provider.size,
						image: { slug: host.provider.image },
						vpc_uuid: host.provider.vpcUuid,
						vcpus: host.provider.vcpus,
						memory: host.provider.memoryMiB,
						status: "active",
						created_at: host.provider.createdAt,
						networks: {
							v4: [
								{ type: "public", ip_address: host.provider.publicIpv4 },
								{ type: "private", ip_address: host.provider.privateIpv4 },
							],
						},
					},
				]),
			);
			return path;
		};
		const hostPath = (role: "server" | "generator") => {
			const host = binding.authority.hosts[role];
			const path = join(fixture.provisioningRoot, `${role}-host-live.txt`);
			const encoded = (value: string) => Buffer.from(value).toString("base64");
			writeFileSync(
				path,
				[
					"recordedAt=2026-08-30T12:39:59.000Z",
					`bootId=${host.bootId}`,
					`head=${host.source.commit}`,
					`tree=${host.source.tree}`,
					`os=${host.runtime.os}`,
					`osReleaseB64=${encoded(host.runtime.osRelease)}`,
					`kernel=${host.runtime.kernel}`,
					`bun=${host.runtime.bunVersion}`,
					`rustcB64=${encoded(host.runtime.rustcVersion)}`,
					`cargoB64=${encoded(host.runtime.cargoVersion)}`,
					`binarySha=${host.binary.sha256}`,
					"",
				].join("\n"),
			);
			return path;
		};
		const serverProviderPath = providerPath("server");
		const generatorProviderPath = providerPath("generator");
		for (const path of [serverProviderPath, generatorProviderPath]) {
			const provider = JSON.parse(readFileSync(path, "utf8"));
			provider[0].created_at = provider[0].created_at.replace(".000Z", "Z");
			writeFileSync(path, canonicalJson(provider));
		}
		const serverHostPath = hostPath("server");
		const generatorHostPath = hostPath("generator");
		const record = validateLockedExactPair({
			root: result.root,
			repositoryPath: fixture.root,
			serverProviderPath,
			generatorProviderPath,
			serverHostPath,
			generatorHostPath,
			recordedAt: "2026-08-30T12:40:00.000Z",
		});
		expect(record.envelope.recordedAt).toBe("2026-08-30T12:40:00.000Z");
		expect(record.hosts.server.id).toBe(101);
		expect(record.hosts.generator.id).toBe(102);
		expect(record.hostBindingAuthoritySha256).toBe(binding.authoritySha256);

		const drifted = JSON.parse(readFileSync(serverProviderPath, "utf8"));
		drifted[0].networks.v4[0].ip_address = "192.0.2.99";
		writeFileSync(serverProviderPath, canonicalJson(drifted));
		expect(() =>
			validateLockedExactPair({
				root: result.root,
				repositoryPath: fixture.root,
				serverProviderPath,
				generatorProviderPath,
				serverHostPath,
				generatorHostPath,
				recordedAt: "2026-08-30T12:41:00.000Z",
			}),
		).toThrow(/provider response differs/);
	}, 60_000);

	test("requires every timestamped qualification receipt and validates the measured artifacts", async () => {
		const fixture = await makeBindingFixture("qualification-evidence-bound");
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:30:20.000Z",
				monotonicNowNs: (() => {
					let value = 1n;
					return () => value++;
				})(),
			},
			randomId: () => "qualification-evidence",
		});
		const qualificationRoot = join(fixture.provisioningRoot, "qualification");
		mkdirSync(join(qualificationRoot, "server"), { recursive: true });
		mkdirSync(join(qualificationRoot, "generator"), { recursive: true });
		const { server, generator } = result.hostBinding.authority.hosts;
		const encoded = (value: string) => Buffer.from(value).toString("base64");
		const writeLiveHost = (
			role: "server" | "generator",
			host: typeof server,
		) => {
			writeFileSync(
				join(qualificationRoot, `${role}-identity.stdout`),
				[
					"recordedAt=2026-08-30T12:20:00.000Z",
					`bootId=${host.bootId}`,
					`head=${host.source.commit}`,
					`tree=${host.source.tree}`,
					`os=${host.runtime.os}`,
					`osReleaseB64=${encoded(host.runtime.osRelease)}`,
					`kernel=${host.runtime.kernel}`,
					`bun=${host.runtime.bunVersion}`,
					`rustcB64=${encoded(host.runtime.rustcVersion)}`,
					`cargoB64=${encoded(host.runtime.cargoVersion)}`,
					`binarySha=${host.binary.sha256}`,
					"",
				].join("\n"),
			);
		};
		writeLiveHost("server", server);
		writeLiveHost("generator", generator);
		const lockedHost = (host: typeof server) => ({
			id: host.provider.id,
			name: host.provider.name,
			publicIpv4: host.provider.publicIpv4,
			privateIpv4: host.provider.privateIpv4,
			recordedAt: "2026-08-30T12:20:00.000Z",
			bootId: host.bootId,
			commit: host.source.commit,
			tree: host.source.tree,
			os: host.runtime.os,
			osRelease: host.runtime.osRelease,
			kernel: host.runtime.kernel,
			bunVersion: host.runtime.bunVersion,
			rustcVersion: host.runtime.rustcVersion,
			cargoVersion: host.runtime.cargoVersion,
			binarySha256: host.binary.sha256,
		});
		writeFileSync(
			join(qualificationRoot, "exact-pair.json"),
			canonicalJson({
				schema: "g6-c32-locked-qualification/1",
				envelope: {
					recordedAt: "2026-08-30T12:20:00.000Z",
					sequence: 1,
					runId: fixture.bindInput.runId,
					phase: "QUALIFIED",
					operationId: "locked-pair-qualification",
					clockSource: "offrunner",
				},
				dispatchFreezeArtifactSha256: canonicalArtifactSha256(
					result.dispatchFreeze,
				),
				hostBindingAuthoritySha256: result.hostBinding.authoritySha256,
				hosts: {
					server: lockedHost(server),
					generator: lockedHost(generator),
				},
				checks: ["provider-exact-pair"],
			}),
		);

		const operations = [
			["apply-nofile-server", "apply-nofile-server"],
			["apply-nofile-generator", "apply-nofile-generator"],
			["doctl-server", "doctl-server"],
			["doctl-generator", "doctl-generator"],
			["server-identity", "server-identity"],
			["generator-identity", "generator-identity"],
			["exact-pair", "exact-pair-validation"],
			["server-resources", "server-resources"],
			["generator-resources", "generator-resources"],
			["vpc", "vpc-requery"],
			["vpc-cidr", "vpc-cidr"],
			["r-down-listener", "r-down-listener"],
			["r-down", "r-down"],
			["r-down-stop", "r-down-stop"],
			["r-up-listener", "r-up-listener"],
			["r-up", "r-up"],
			["r-up-stop", "r-up-stop"],
			["isolated-sink", "isolated-sink"],
			["loaded-down-listener", "loaded-down-listener"],
			["loaded-up-listener", "loaded-up-listener"],
			["loaded-down", "loaded-down"],
			["loaded-up", "loaded-up"],
			["loaded-down-stop", "loaded-down-stop"],
			["loaded-up-stop", "loaded-up-stop"],
			["bpf-shards", "bpf-shards"],
			["snapshot-before", "snapshot-before"],
			["snapshot-copy", "snapshot-copy"],
			["rollback-proof", "rollback-proof"],
			["restore-sysctls", "restore-server-sysctls"],
			["snapshot-restored", "snapshot-restored"],
			["snapshot-compare", "snapshot-compare"],
			["rollback-record", "rollback-record"],
			["copy-server", "copy-qualification-server"],
			["copy-generator", "copy-qualification-generator"],
		] as const;
		for (const [[name, operationId], index] of operations.map(
			(entry, index) => [entry, index] as const,
		)) {
			writeFileSync(
				join(qualificationRoot, `${name}.receipt.json`),
				canonicalJson(
					operationFixture(
						fixture.bindInput.runId,
						index + 1,
						"QUALIFYING",
						operationId,
					),
				),
			);
			if (!existsSync(join(qualificationRoot, `${name}.stdout`))) {
				writeFileSync(join(qualificationRoot, `${name}.stdout`), "fixture\n");
			}
			writeFileSync(join(qualificationRoot, `${name}.stderr`), "");
		}
		const resources = [
			"recordedAt=2026-08-30T12:20:00.000Z",
			"nofile=1048576",
			"Filesystem 1024-blocks Used Available Capacity Mounted on",
			"/dev/vda 100000 1 99999 1% /",
			"MemAvailable: 64000000 kB",
			"",
		].join("\n");
		writeFileSync(
			join(qualificationRoot, "server-resources.stdout"),
			resources,
		);
		writeFileSync(
			join(qualificationRoot, "generator-resources.stdout"),
			resources,
		);
		writeFileSync(join(qualificationRoot, "vpc-cidr.stdout"), "10.0.0.0/24\n");
		const preflight = (
			peerAddress: string,
			payloadBytes: number,
			cleanPps: number,
		) => ({
			schemaVersion: 3,
			startedAt: "2026-08-30T12:20:00.000Z",
			link: {
				peerAddress,
				subnet: "10.0.0.0/24",
				mtuBytes: 1500,
			},
			guards: [{ name: "peer-on-registered-subnet", ok: true }],
			registeredProperties: {
				payloadBytes,
				cleanPpsCeiling: cleanPps,
				idleRttP99Ms: 1,
			},
		});
		writeFileSync(
			join(qualificationRoot, "server", "preflight-r-down.json"),
			canonicalJson(preflight(generator.provider.privateIpv4, 1_150, 75_000)),
		);
		writeFileSync(
			join(qualificationRoot, "generator", "preflight-r-up.json"),
			canonicalJson(preflight(server.provider.privateIpv4, 64, 20_000)),
		);
		writeFileSync(
			join(qualificationRoot, "generator", "g6-sink-precheck.json"),
			canonicalJson({
				kind: "g6-sink-precheck",
				dateIso: "2026-08-30T12:20:00.000Z",
				requiredPps: 116_250,
				precheckOriginatorSaturated: false,
				precheckOfferedPps: 120_000,
				precheckDeliveryRatio: 0.999,
			}),
		);
		const loaded = (payloadBytes: number, targetBitrate: number) => ({
			start: {
				timestamp: { time: "fixture UTC", timesecs: 1_777_111_200 },
				test_start: {
					protocol: "UDP",
					blksize: payloadBytes,
					duration: 20,
					target_bitrate: targetBitrate,
				},
			},
			end: { sum: { lost_percent: 0.1 } },
		});
		writeFileSync(
			join(qualificationRoot, "server", "loaded-down.json"),
			canonicalJson(loaded(1_150, 750_000_000)),
		);
		writeFileSync(
			join(qualificationRoot, "generator", "loaded-up.json"),
			canonicalJson(loaded(64, 12_000_000)),
		);
		writeFileSync(
			join(qualificationRoot, "server", "g6-shard-bpf-ready.json"),
			canonicalJson({
				schema: "g6-shard-bpf-ready/1",
				createdAtMs: 1_777_111_200_000,
				instances: 16,
			}),
		);
		writeFileSync(
			join(qualificationRoot, "rollback-receipt.json"),
			canonicalJson({
				schema: "g6-c32-rollback/1",
				recordedAt: "2026-08-30T12:20:00.000Z",
				appliedBytes: 26_214_400,
				effectiveSocketReceiveBytes: 52_428_800,
				restored: true,
				byteIdentical: true,
			}),
		);

		const output = join(qualificationRoot, "qualification-record.json");
		const record = runQualificationCli(
			[
				"qualification",
				"--root",
				result.root,
				"--repository",
				fixture.root,
				"--qualification-root",
				qualificationRoot,
				"--out",
				output,
			],
			{
				now: () => "2026-08-30T12:21:00.000Z",
				writeStdout: () => {},
			},
		);
		expect(record.checks).toContain("simultaneous-loaded-legs");
		expect(record.checks).toContain("bpf-shards-zero-fallback");
		expect(record.checks).not.toContain("bpf-16-zero-fallback");
		expect(record.checks).toContain("rollback-25mib-byte-identical");
		expect(record.hosts.server.rustcVersion).toBe(server.runtime.rustcVersion);

		const loadedDownPath = join(
			qualificationRoot,
			"server",
			"loaded-down.json",
		);
		const drifted = JSON.parse(readFileSync(loadedDownPath, "utf8"));
		drifted.end.sum.lost_percent = 0.51;
		writeFileSync(loadedDownPath, canonicalJson(drifted));
		expect(() =>
			runQualificationCli(
				[
					"qualification",
					"--root",
					result.root,
					"--repository",
					fixture.root,
					"--qualification-root",
					qualificationRoot,
					"--out",
					join(qualificationRoot, "qualification-drifted.json"),
				],
				{ writeStdout: () => {} },
			),
		).toThrow(/simultaneous loaded leg/);
	}, 60_000);
});

describe("G6 c32 dispatch CLI", () => {
	test("rejects frozen work-plan /2 before calling the runner even with a distant future deadline", async () => {
		const fixture = await makeBindingFixture(
			"work-dispatch-bound",
			32,
			false,
			(root, input) => {
				writeFixture(
					root,
					input.budgetPolicyPath,
					JSON.stringify(workBudgetPolicy(input.runId)),
				);
				git(root, "add", input.budgetPolicyPath);
				git(root, "commit", "--quiet", "-m", "Bind work dispatch fixture");
			},
		);
		let tick = 1n;
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:50:00.000Z",
				monotonicNowNs: () => tick++,
			},
			randomId: () => "work-dispatch",
		});
		expect(readFileSync(join(result.root, "RUN_STATUS"), "utf8")).toBe(
			"BOUND\n",
		);
		expect(
			validateBudgetPolicy(
				JSON.parse(
					readFileSync(
						join(
							result.root,
							"semantic/inputs",
							fixture.semanticFreeze.authority.budgetPolicy.path,
						),
						"utf8",
					),
				),
			).schema,
		).toBe("g6-c32-budget-policy/2");
		for (const deadline of ["2099-01-01T00:00:00.000Z", undefined]) {
			let calls = 0;
			let failure: unknown;
			try {
				runDispatchCli(
					[
						"dispatch",
						"--root",
						result.root,
						"--repository",
						fixture.root,
						...(deadline ? ["--deadline", deadline] : []),
					],
					{
						now: () => "2026-08-30T12:59:00.000Z",
						runController: () => {
							calls += 1;
							return { status: 0, stdout: "", stderr: "" };
						},
						writeStdout: () => {},
					},
				);
			} catch (error) {
				failure = error;
			}
			expect(calls).toBe(0);
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).toMatch(/work-plan.*ProductionRigBackend/i);
		}
	}, 120_000);

	test("verifies first and invokes only the checked-in controller with the bound root", async () => {
		const fixture = await makeBindingFixture("dispatch-bound");
		const result = await bindHostFreeze(fixture.bindInput, {
			clock: {
				wallNow: () => "2026-08-30T12:50:00.000Z",
				monotonicNowNs: (() => {
					let value = 1n;
					return () => value++;
				})(),
			},
			randomId: () => "dispatch",
		});
		const calls: Array<{
			command: string;
			args: readonly string[];
			cwd: string;
		}> = [];
		const verified = runDispatchCli(
			[
				"dispatch",
				"--root",
				result.root,
				"--repository",
				fixture.root,
				"--deadline",
				"2026-08-30T13:00:00.000Z",
			],
			{
				now: () => "2026-08-30T12:59:00.000Z",
				runController: (command, args, cwd) => {
					calls.push({ command, args, cwd });
					return { status: 0, stdout: "controller-complete\n", stderr: "" };
				},
				writeStdout: () => {},
			},
		);
		expect(verified.root).toBe(result.root);
		expect(calls).toEqual([
			{
				command: "bash",
				cwd: fixture.root,
				args: [
					join(fixture.root, "tools/load/g6-c32-rca-controller.sh"),
					"run",
					"--bound-root",
					result.root,
					"--repository",
					fixture.root,
					"--budget-policy",
					join(
						fixture.root,
						fixture.semanticFreeze.authority.budgetPolicy.path,
					),
					"--spend-ledger",
					join(dirname(result.root), "spend-ledger.json"),
					"--deadline",
					"2026-08-30T13:00:00.000Z",
				],
			},
		]);
	}, 60_000);
});
