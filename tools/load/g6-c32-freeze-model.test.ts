import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
	makeArtifactManifestRecord,
	makeAuthorityRecord,
	makeDispatchFreezeRecord,
	makeHostBindingRecord,
	type OperationReceipt,
	type RecordEnvelope,
	renderExactIdentitySheet,
	renderRegistration,
	renderRunbook,
	shardCountForVcpus,
	shellQuote,
	validateArtifactManifestRecord,
	validateDeadline,
	validateDispatchFreezeRecord,
	validateEnvelope,
	validateHostBindingRecord,
	validateOperationReceipt,
	validateRecordSequence,
	validateReviewReceipt,
	validateSemanticApprovalRecord,
	validateSemanticFreezeRecord,
} from "./g6-c32-freeze-model.ts";

const envelope = (overrides: Record<string, unknown> = {}): RecordEnvelope =>
	({
		recordedAt: "2026-08-30T12:34:56.789Z",
		sequence: 1,
		runId: "g6-c32-rca-closure-01-test",
		phase: "SEMANTIC_FREEZE",
		operationId: "semantic-freeze",
		clockSource: "offrunner",
		...overrides,
	}) as RecordEnvelope;

const identity = (path: string, digit: string) => ({
	path,
	sha256: digit.repeat(64),
});

const semanticAuthority = () => ({
	candidate: { commit: "a".repeat(40), tree: "b".repeat(40) },
	plan: identity(".scratch/bare-metal-campaign/plans/campaign.md", "1"),
	controller: identity("tools/load/g6-c32-rca-controller.sh", "2"),
	budgetPolicy: identity(
		".scratch/bare-metal-campaign/policies/g6-c32-budget.json",
		"9",
	),
	freezeGenerator: {
		...identity("tools/load/g6-c32-freeze.ts", "3"),
		schemaVersion: "g6-c32-semantic-freeze/1",
	},
	templates: {
		registration: identity("tools/load/templates/g6-c32-registration.md", "4"),
		runbook: identity("tools/load/templates/g6-c32-runbook.md", "5"),
	},
	campaignInputs: [
		identity("tools/load/g6-c32-rca-evaluate.ts", "6"),
		identity("tools/load/g6-shard-bpf-setup.sh", "7"),
	],
	gateCatalog: identity("tools/load/g6-c32-gates.ts", "8"),
});

const reviewAuthority = (
	role: "architect" | "critic",
	freezeSha: string,
	architectArtifactSha: string | null = null,
) => ({
	semanticFreezeAuthoritySha256: freezeSha,
	role,
	verdict: "APPROVE" as const,
	unconditional: true as const,
	afterArchitectReceiptArtifactSha256:
		role === "critic" ? architectArtifactSha : null,
});

const hostBindingAuthority = () => ({
	semantic: {
		freeze: {
			path: "semantic/semantic-freeze.json",
			authoritySha256: "1".repeat(64),
			artifactSha256: "2".repeat(64),
		},
		approval: {
			path: "semantic/semantic-approval.json",
			authoritySha256: "3".repeat(64),
			artifactSha256: "4".repeat(64),
		},
		architectReceipt: identity("semantic/architect.json", "5"),
		criticReceipt: identity("semantic/critic.json", "6"),
	},
	rigJournal: identity("lifecycle/rig-state.json", "7"),
	knownHosts: {
		file: identity("host/known_hosts", "8"),
		receipt: identity("host/known-hosts-receipt.json", "9"),
	},
	preparationReceipt: identity("host/preparation-receipt.json", "a"),
	bundle: identity("candidate/candidate.bundle", "b"),
	retainedBinaries: {
		nativeAddon: identity("candidate/native-addon.node", "c"),
		generator: identity("candidate/mmo-client", "d"),
	},
	hosts: {
		server: {
			role: "server" as const,
			provider: {
				id: 101,
				name: "g6-server",
				tags: ["g6-managed", "g6-run"],
				region: "ams3",
				size: "c-32",
				image: "ubuntu-24-04-x64",
				vpcUuid: "vpc-1",
				projectId: "project-1",
				sshKeyIds: [91],
				vcpus: 32,
				memoryMiB: 65536,
				status: "active",
				createdAt: "2026-08-30T11:00:00.000Z",
				publicIpv4: "192.0.2.10",
				privateIpv4: "10.0.0.10",
			},
			bootId: "11111111-1111-4111-8111-111111111111",
			source: { commit: "a".repeat(40), tree: "b".repeat(40) },
			runtime: {
				os: "Linux",
				osRelease: "Ubuntu 24.04",
				kernel: "6.8.0",
				bunVersion: "1.3.14",
				rustcVersion: "rustc 1.89.0",
				cargoVersion: "cargo 1.89.0",
			},
			binary: {
				kind: "native-addon" as const,
				path: "/opt/g6/native.node",
				sha256: "c".repeat(64),
			},
			identityPacket: identity("host/server-identity.json", "e"),
			identityOperationReceipt: identity(
				"host/server-identity-operation.json",
				"f",
			),
		},
		generator: {
			role: "generator" as const,
			provider: {
				id: 102,
				name: "g6-generator",
				tags: ["g6-managed", "g6-run"],
				region: "ams3",
				size: "c-32",
				image: "ubuntu-24-04-x64",
				vpcUuid: "vpc-1",
				projectId: "project-1",
				sshKeyIds: [91],
				vcpus: 32,
				memoryMiB: 65536,
				status: "active",
				createdAt: "2026-08-30T11:00:01.000Z",
				publicIpv4: "192.0.2.11",
				privateIpv4: "10.0.0.11",
			},
			bootId: "22222222-2222-4222-8222-222222222222",
			source: { commit: "a".repeat(40), tree: "b".repeat(40) },
			runtime: {
				os: "Linux",
				osRelease: "Ubuntu 24.04",
				kernel: "6.8.0",
				bunVersion: "1.3.14",
				rustcVersion: "rustc 1.89.0",
				cargoVersion: "cargo 1.89.0",
			},
			binary: {
				kind: "mmo-client" as const,
				path: "/opt/g6/mmo-client",
				sha256: "d".repeat(64),
			},
			identityPacket: identity("host/generator-identity.json", "0"),
			identityOperationReceipt: identity(
				"host/generator-identity-operation.json",
				"1",
			),
		},
	},
	gates: {
		catalogAuthoritySha256: "2".repeat(64),
		receipts: [
			{
				id: "local-bun-campaign-suite",
				phase: "LOCAL" as const,
				receipt: identity("gates/local-bun.json", "3"),
				operationReceipt: identity("gates/local-bun-operation.json", "4"),
			},
			{
				id: "prepared-server-linux-smoke",
				phase: "PREPARED_HOST" as const,
				receipt: identity("gates/server-smoke.json", "5"),
				operationReceipt: identity("gates/server-smoke-operation.json", "6"),
			},
		],
	},
});

describe("G6 c32 canonical records", () => {
	test("exposes Bun-only semantic-freeze, campaign, and automation commands", () => {
		const packageJson = JSON.parse(
			readFileSync(join(import.meta.dir, "../../package.json"), "utf8"),
		) as { scripts?: Record<string, string> };
		const scripts = packageJson.scripts ?? {};
		expect(scripts["g6:c32:freeze"]).toBe("bun tools/load/g6-c32-freeze.ts");
		expect(scripts["g6:c32:campaign"]).toBe("bun tools/load/g6-c32-rig.ts");
		expect(scripts["test:g6:c32-automation"]).toContain(
			"bun test tools/load/g6-c32-freeze-model.test.ts",
		);
		for (const name of [
			"g6:c32:freeze",
			"g6:c32:campaign",
			"test:g6:c32-automation",
		]) {
			const command = scripts[name] ?? "";
			expect(command).not.toMatch(
				/(?:^|\s)(?:node|npx)(?:\s|$)|mise\/installs\/node|\.md\b|extract/i,
			);
		}
	}, 15_000);

	test("sorts object keys recursively while preserving array order", () => {
		expect(
			canonicalJson({
				z: [{ y: 2, x: 1 }, "second"],
				a: { d: 4, b: 2 },
			}),
		).toBe(
			'{\n  "a": {\n    "b": 2,\n    "d": 4\n  },\n  "z": [\n    {\n      "x": 1,\n      "y": 2\n    },\n    "second"\n  ]\n}\n',
		);
	}, 15_000);

	test("rejects values that cannot have one canonical JSON representation", () => {
		const sparse = ["first", "second"];
		delete sparse[1];

		for (const value of [
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			1n,
			new Date("2026-08-30T12:34:56.789Z"),
			sparse,
			{ value: undefined },
		]) {
			expect(() => canonicalJson(value)).toThrow();
		}
	}, 15_000);

	test("validates the required timestamp envelope", () => {
		expect(validateEnvelope(envelope())).toEqual(envelope());

		for (const invalid of [
			envelope({ recordedAt: "2026-08-30T12:34:56Z" }),
			envelope({ recordedAt: "2026-08-30T12:34:56.789+00:00" }),
			envelope({ recordedAt: "2026-02-30T12:34:56.789Z" }),
			envelope({ sequence: 0 }),
			envelope({ sequence: 1.5 }),
			envelope({ runId: "" }),
			envelope({ phase: "" }),
			envelope({ operationId: "" }),
			envelope({ clockSource: "local" }),
		]) {
			expect(() => validateEnvelope(invalid)).toThrow();
		}
	}, 15_000);

	test("hashes canonical authority and complete timestamped artifact separately", () => {
		const authority = { candidate: "a".repeat(40), tree: "b".repeat(40) };
		const first = makeAuthorityRecord(
			"g6-c32-semantic-freeze/1",
			envelope(),
			authority,
		);
		const later = makeAuthorityRecord(
			"g6-c32-semantic-freeze/1",
			envelope({ recordedAt: "2026-08-30T12:35:56.789Z", sequence: 2 }),
			authority,
		);

		expect(first.authoritySha256).toBe(canonicalAuthoritySha256(authority));
		expect(later.authoritySha256).toBe(first.authoritySha256);
		expect(canonicalArtifactSha256(later)).not.toBe(
			canonicalArtifactSha256(first),
		);
	}, 15_000);

	test("keeps semantic freeze, approval, and review authority stable across new envelopes", () => {
		const freeze = makeAuthorityRecord(
			"g6-c32-semantic-freeze/1",
			envelope(),
			semanticAuthority(),
		);
		const architect = makeAuthorityRecord(
			"g6-c32-review-receipt/1",
			envelope({ phase: "ARCHITECT_REVIEW", operationId: "architect" }),
			reviewAuthority("architect", freeze.authoritySha256),
		);
		const critic = makeAuthorityRecord(
			"g6-c32-review-receipt/1",
			envelope({ phase: "CRITIC_REVIEW", operationId: "critic", sequence: 2 }),
			reviewAuthority(
				"critic",
				freeze.authoritySha256,
				canonicalArtifactSha256(architect),
			),
		);
		const approvalAuthority = {
			semanticFreezeAuthoritySha256: freeze.authoritySha256,
			architect: {
				verdict: "APPROVE" as const,
				unconditional: true as const,
				receiptPath: "reviews/architect.json",
				receiptArtifactSha256: canonicalArtifactSha256(architect),
			},
			critic: {
				verdict: "APPROVE" as const,
				unconditional: true as const,
				receiptPath: "reviews/critic.json",
				receiptArtifactSha256: canonicalArtifactSha256(critic),
				afterArchitectReceiptArtifactSha256: canonicalArtifactSha256(architect),
			},
		};
		const approval = makeAuthorityRecord(
			"g6-c32-semantic-approval/1",
			envelope({
				phase: "SEMANTIC_APPROVAL",
				operationId: "approval",
				sequence: 3,
			}),
			approvalAuthority,
		);
		const laterApproval = makeAuthorityRecord(
			"g6-c32-semantic-approval/1",
			envelope({
				phase: "SEMANTIC_APPROVAL",
				operationId: "approval",
				sequence: 4,
				recordedAt: "2026-08-30T13:34:56.789Z",
			}),
			approvalAuthority,
		);

		expect(validateSemanticFreezeRecord(freeze)).toEqual(freeze);
		expect(validateReviewReceipt(architect)).toEqual(architect);
		expect(validateReviewReceipt(critic)).toEqual(critic);
		expect(validateSemanticApprovalRecord(approval)).toEqual(approval);
		expect(laterApproval.authoritySha256).toBe(approval.authoritySha256);
		expect(canonicalArtifactSha256(laterApproval)).not.toBe(
			canonicalArtifactSha256(approval),
		);
	}, 15_000);

	test("requires the exact budget policy in semantic authority", () => {
		const authority = {
			...semanticAuthority(),
			budgetPolicy: identity(
				".scratch/bare-metal-campaign/policies/g6-c32-budget.json",
				"9",
			),
		};
		const freeze = makeAuthorityRecord(
			"g6-c32-semantic-freeze/1",
			envelope(),
			authority,
		);

		expect(validateSemanticFreezeRecord(freeze)).toEqual(freeze);
	}, 15_000);

	test("rejects malformed semantic schemas and authority digest drift", () => {
		const freeze = makeAuthorityRecord(
			"g6-c32-semantic-freeze/1",
			envelope(),
			semanticAuthority(),
		);
		expect(() =>
			validateSemanticFreezeRecord({
				...freeze,
				authoritySha256: "0".repeat(64),
			}),
		).toThrow();
		expect(() =>
			validateSemanticFreezeRecord({
				...freeze,
				authority: {
					...freeze.authority,
					plan: identity("/absolute/plan.md", "1"),
				},
			}),
		).toThrow();
		expect(() =>
			validateReviewReceipt(
				makeAuthorityRecord(
					"g6-c32-review-receipt/1",
					envelope(),
					reviewAuthority("critic", freeze.authoritySha256, null),
				),
			),
		).toThrow();

		const approval = makeAuthorityRecord(
			"g6-c32-semantic-approval/1",
			envelope({ phase: "SEMANTIC_APPROVAL", operationId: "approval" }),
			{
				semanticFreezeAuthoritySha256: freeze.authoritySha256,
				architect: {
					verdict: "APPROVE" as const,
					unconditional: true as const,
					receiptPath: "reviews/architect\nsubstitution.json",
					receiptArtifactSha256: "1".repeat(64),
				},
				critic: {
					verdict: "APPROVE" as const,
					unconditional: true as const,
					receiptPath: "reviews/critic.json",
					receiptArtifactSha256: "2".repeat(64),
					afterArchitectReceiptArtifactSha256: "1".repeat(64),
				},
			},
		);
		expect(() => validateSemanticApprovalRecord(approval)).toThrow(
			/single-line|path/i,
		);
	}, 15_000);

	test("validates operation wall time, monotonic duration, and timestamped sidecars", () => {
		const receipt: OperationReceipt = {
			schema: "g6-c32-operation-receipt/1",
			envelope: envelope({ phase: "LOCAL_GATES", operationId: "bun-tests" }),
			startedAt: "2026-08-30T12:34:50.000Z",
			finishedAt: "2026-08-30T12:34:56.000Z",
			durationMonotonicNs: "6000000000",
			attempt: 1,
			action: {
				command: "bun",
				args: ["test", "tools/load/g6-c32-freeze-model.test.ts"],
				cwd: ".",
				environmentKeys: ["PATH"],
			},
			status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
			stdoutPath: "operations/bun-tests.stdout",
			stderrPath: "operations/bun-tests.stderr",
			remoteTiming: null,
		};
		expect(validateOperationReceipt(receipt)).toEqual(receipt);

		for (const mutation of [
			{ finishedAt: "2026-08-30T12:34:49.999Z" },
			{ durationMonotonicNs: "-1" },
			{ durationMonotonicNs: "1.5" },
			{ attempt: 0 },
			{ stdoutPath: "/tmp/unbound.stdout" },
		]) {
			expect(() =>
				validateOperationReceipt({ ...receipt, ...mutation }),
			).toThrow();
		}
	}, 15_000);

	test("orders same-millisecond records by strictly increasing sequence", () => {
		const sameTime = "2026-08-30T12:34:56.789Z";
		expect(
			validateRecordSequence([
				envelope({ sequence: 1, recordedAt: sameTime }),
				envelope({ sequence: 2, recordedAt: sameTime }),
				envelope({ sequence: 5, recordedAt: sameTime }),
			]),
		).toHaveLength(3);
		expect(() =>
			validateRecordSequence([
				envelope({ sequence: 2 }),
				envelope({ sequence: 2, operationId: "duplicate" }),
			]),
		).toThrow();
		expect(() =>
			validateRecordSequence([
				envelope({ sequence: 2 }),
				envelope({ sequence: 1, operationId: "backward" }),
			]),
		).toThrow();
	}, 15_000);

	test("requires a future lifecycle deadline", () => {
		expect(
			validateDeadline("2026-08-30T12:34:56.789Z", "2026-08-30T13:34:56.789Z"),
		).toBe("2026-08-30T13:34:56.789Z");
		expect(() =>
			validateDeadline("2026-08-30T12:34:56.789Z", "2026-08-30T12:34:56.789Z"),
		).toThrow();
	}, 15_000);

	test("shell-quotes allow-listed verifier values without execution", () => {
		expect(shellQuote("plain-value")).toBe("'plain-value'");
		expect(shellQuote("a'b $(touch /tmp/nope)")).toBe(
			"'a'\"'\"'b $(touch /tmp/nope)'",
		);
		expect(() => shellQuote("nul\0byte")).toThrow();
	}, 15_000);
});

describe("G6 c32 host-bound digest graph and generated views", () => {
	test("binds semantic records, exact hosts, keys, retained bytes, bundle, and gates", () => {
		const hostBinding = makeHostBindingRecord(
			envelope({
				sequence: 20,
				phase: "HOST_BINDING",
				operationId: "host-binding",
			}),
			hostBindingAuthority(),
		);
		expect(validateHostBindingRecord(hostBinding)).toEqual(hostBinding);
		expect(hostBinding.authority.hosts.server.provider.id).toBe(101);
		expect(hostBinding.authority.hosts.generator.bootId).not.toBe(
			hostBinding.authority.hosts.server.bootId,
		);
		expect(hostBinding.authority.knownHosts.file.sha256).toBe("8".repeat(64));
		expect(hostBinding.authority.retainedBinaries.nativeAddon.sha256).toBe(
			"c".repeat(64),
		);
		expect(hostBinding.authority.bundle.sha256).toBe("b".repeat(64));
		expect(hostBinding.authority.gates.receipts).toHaveLength(2);

		for (const invalid of [
			{
				...hostBinding,
				authority: {
					...hostBinding.authority,
					hosts: {
						...hostBinding.authority.hosts,
						generator: {
							...hostBinding.authority.hosts.generator,
							role: "server",
						},
					},
				},
			},
			{
				...hostBinding,
				authority: {
					...hostBinding.authority,
					gates: { ...hostBinding.authority.gates, receipts: [] },
				},
			},
		]) {
			expect(() => validateHostBindingRecord(invalid)).toThrow();
		}
	}, 15_000);

	test("renders three acyclic timestamped views and a dispatch freeze over their digests", () => {
		const hostBinding = makeHostBindingRecord(
			envelope({
				sequence: 20,
				phase: "HOST_BINDING",
				operationId: "host-binding",
			}),
			hostBindingAuthority(),
		);
		const common = {
			recordedAt: "2026-08-30T13:00:00.000Z",
			runId: "g6-c32-rca-closure-01-test",
			controllerPath: "tools/load/g6-c32-rca-controller.sh",
			semanticFreezeArtifactSha256:
				hostBinding.authority.semantic.freeze.artifactSha256,
			semanticApprovalArtifactSha256:
				hostBinding.authority.semantic.approval.artifactSha256,
			hostBindingArtifactSha256: canonicalArtifactSha256(hostBinding),
			hostBinding,
		};
		const registration = renderRegistration(common);
		const runbook = renderRunbook(common);
		const exactIdentity = renderExactIdentitySheet(common);
		for (const view of [registration, runbook, exactIdentity]) {
			expect(view).toContain(common.recordedAt);
			expect(view).toContain(common.semanticFreezeArtifactSha256);
			expect(view).toContain(common.semanticApprovalArtifactSha256);
			expect(view).toContain(common.hostBindingArtifactSha256);
			expect(view).not.toContain("dispatch-freeze.json");
		}
		expect(runbook).toContain("bun run g6:c32:campaign -- run");
		expect(runbook).toContain(common.controllerPath);
		for (const view of [registration, runbook]) {
			expect(view).toMatch(
				/semantic.*Architect.*Critic.*before provisioning/is,
			);
			expect(view).toMatch(/host-only.*does not restart.*Architect.*Critic/is);
			expect(view).toMatch(/exact-zero.*exact-two.*deterministic/is);
			expect(view).toMatch(/partial.*journal-owned.*cleaned.*retried once/is);
			expect(view).toMatch(/create-response.*durable intent/is);
			expect(view).toMatch(/unknown resources.*without mutation/is);
			expect(view).toMatch(
				/deadline.*cancellation.*terminal.*exact-owned IDs/is,
			);
			expect(view).toMatch(
				/every operation.*every persisted record.*timestamped/is,
			);
			expect(view).not.toMatch(
				/any (?:host|boot|binary) change.*restarts both reviews/is,
			);
			expect(view).not.toMatch(/partial creation requires agent direction/is);
		}
		expect((runbook.match(/```bash/g) ?? []).length).toBe(1);
		expect(runbook).not.toContain("g6-c32-rca-controller.sh run");
		expect(exactIdentity).not.toMatch(/verdict/i);

		const dispatch = makeDispatchFreezeRecord(
			envelope({
				sequence: 21,
				phase: "DISPATCH_FREEZE",
				operationId: "dispatch-freeze",
			}),
			{
				semanticFreeze: hostBinding.authority.semantic.freeze,
				semanticApproval: hostBinding.authority.semantic.approval,
				hostBinding: {
					path: "host-binding.json",
					authoritySha256: hostBinding.authoritySha256,
					artifactSha256: common.hostBindingArtifactSha256,
				},
				views: {
					registration: identity("views/registration.md", "7"),
					runbook: identity("views/runbook.md", "8"),
					exactIdentity: identity("views/exact-identity.md", "9"),
				},
			},
		);
		expect(validateDispatchFreezeRecord(dispatch)).toEqual(dispatch);
		expect(canonicalJson(dispatch)).not.toContain(
			canonicalArtifactSha256(dispatch),
		);
	}, 15_000);

	test("requires a timestamp on every manifest entry and excludes manifest-control files", () => {
		const manifest = makeArtifactManifestRecord(
			envelope({
				sequence: 30,
				phase: "BINDING",
				operationId: "artifact-manifest",
			}),
			[
				{
					path: "candidate/candidate.bundle",
					sha256: "a".repeat(64),
					bytes: 123,
					recordedAt: "2026-08-30T13:00:00.000Z",
				},
				{
					path: "host-binding.json",
					sha256: "b".repeat(64),
					bytes: 456,
					recordedAt: "2026-08-30T13:00:01.000Z",
				},
			],
		);
		expect(validateArtifactManifestRecord(manifest)).toEqual(manifest);
		for (const invalid of [
			{
				...manifest,
				entries: [
					{ ...manifest.entries[0], recordedAt: undefined },
					manifest.entries[1],
				],
			},
			{
				...manifest,
				entries: [
					...manifest.entries,
					{
						path: "RUN_STATUS",
						sha256: "c".repeat(64),
						bytes: 6,
						recordedAt: "2026-08-30T13:00:02.000Z",
					},
				],
			},
			{
				...manifest,
				entries: [
					{
						path: ".operation-sequence",
						sha256: "d".repeat(64),
						bytes: 2,
						recordedAt: "2026-08-30T13:00:03.000Z",
					},
					...manifest.entries,
				],
			},
		]) {
			expect(() => validateArtifactManifestRecord(invalid)).toThrow();
		}
	}, 15_000);

	test("accepts the exact offrunner final-seal manifest identity", () => {
		const manifest = makeArtifactManifestRecord(
			envelope({
				sequence: 31,
				phase: "FINAL",
				operationId: "offrunner-artifact-manifest",
			}),
			[
				{
					path: "run/spend-ledger.json",
					sha256: "d".repeat(64),
					bytes: 456,
					recordedAt: "2026-08-31T10:09:24.000Z",
				},
			],
		);
		expect(validateArtifactManifestRecord(manifest)).toEqual(manifest);
	}, 15_000);
});

describe("shardCountForVcpus", () => {
	test("gives one shard per two vCPUs across the c-32 family", () => {
		expect([
			shardCountForVcpus(2),
			shardCountForVcpus(32),
			shardCountForVcpus(48),
			shardCountForVcpus(64),
		]).toEqual([1, 16, 24, 32]);
	}, 15_000);

	test("refuses anything that is not a positive even safe integer", () => {
		for (const invalid of [
			0,
			-2,
			-32,
			1,
			31,
			33,
			32.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			expect(() => shardCountForVcpus(invalid)).toThrow();
		}
	}, 15_000);
});
