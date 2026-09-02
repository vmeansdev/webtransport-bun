import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	validateLockedExactPair,
	verifyBoundFreeze,
	verifySemanticApproval,
	verifySemanticFreeze,
} from "./g6-c32-freeze.ts";
import {
	canonicalArtifactSha256,
	canonicalJson,
	makeAuthorityRecord,
	type RecordEnvelope,
	type ReviewReceiptRecord,
	type SemanticApprovalRecord,
	type SemanticFreezeRecord,
} from "./g6-c32-freeze-model.ts";
import { G6_C32_GATE_CATALOG, runGatePhase } from "./g6-c32-gates.ts";
import {
	appendRigJournalEvent,
	initializeRigJournal,
} from "./g6-c32-rig-journal.ts";

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

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function writeFixture(root: string, path: string, contents: string): void {
	const absolutePath = join(root, path);
	mkdirSync(join(absolutePath, ".."), { recursive: true });
	writeFileSync(absolutePath, contents);
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

function makeRepository(policyOverrides: Record<string, unknown> = {}): {
	root: string;
	input: CreateSemanticFreezeInput;
} {
	const root = mkdtempSync(join(tmpdir(), "g6-c32-freeze-"));
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
): Promise<{
	root: string;
	provisioningRoot: string;
	outputName: string;
	bindInput: Parameters<typeof bindHostFreeze>[0];
	semanticApproval: SemanticApprovalRecord;
	semanticFreeze: SemanticFreezeRecord;
}> {
	const { root, input } = makeRepository();
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
		region: "ams3",
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
					? "/opt/g6/run/source/crates/native/webtransport-native.linux-x64-gnu.node"
					: "/opt/g6/run/source/target/release/mmo-client",
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
	});

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
	}, 15_000);

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
	}, 15_000);

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
	});

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
	}, 15_000);

	test("rejects the forbidden mise Node runtime without invoking it", () => {
		const { root, input } = makeRepository();
		expect(() =>
			createSemanticFreeze(
				{ ...input, runtimePath: FORBIDDEN_MISE_NODE_PATH },
				{ repositoryPath: root, now },
			),
		).toThrow(/forbidden.*mise.*node/i);
	}, 15_000);

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
	}, 15_000);

	test("binds budget policy bytes and rejects policy drift", () => {
		const { root, input } = makeRepository();
		const budgetPolicyPath = input.budgetPolicyPath;
		const freeze = createSemanticFreeze(input, { repositoryPath: root, now });

		expect(freeze.authority.budgetPolicy.path).toBe(budgetPolicyPath);
		writeFixture(root, budgetPolicyPath, "{}\n");
		expect(() =>
			verifySemanticFreeze(freeze, { repositoryPath: root, now }),
		).toThrow(/budget|policy|bytes|HEAD/i);
	}, 15_000);

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
	}, 15_000);
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
	});

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
	});

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
	});

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
	});
});

describe("G6 c32 atomic host-bound freeze", () => {
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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);
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
	}, 15_000);

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
	}, 20_000);
});

describe("G6 c32 dispatch CLI", () => {
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
					"--deadline",
					"2026-08-30T13:00:00.000Z",
				],
			},
		]);
	}, 15_000);
});
