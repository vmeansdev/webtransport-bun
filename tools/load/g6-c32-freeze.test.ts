import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CreateSemanticFreezeInput,
	createSemanticFreeze,
	DEFAULT_CAMPAIGN_INPUT_PATHS,
	FORBIDDEN_MISE_NODE_PATH,
	runFreezeCli,
	verifySemanticApproval,
	verifySemanticFreeze,
} from "./g6-c32-freeze.ts";
import {
	canonicalArtifactSha256,
	makeAuthorityRecord,
	type RecordEnvelope,
	type ReviewReceiptRecord,
	type SemanticApprovalRecord,
	type SemanticFreezeRecord,
} from "./g6-c32-freeze-model.ts";

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

function makeRepository(): {
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

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("G6 c32 semantic freeze", () => {
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
	});

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
	});

	test("rejects the forbidden mise Node runtime without invoking it", () => {
		const { root, input } = makeRepository();
		expect(() =>
			createSemanticFreeze(
				{ ...input, runtimePath: FORBIDDEN_MISE_NODE_PATH },
				{ repositoryPath: root, now },
			),
		).toThrow(/forbidden.*mise.*node/i);
	});

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
	});
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
