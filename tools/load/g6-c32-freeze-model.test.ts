import { describe, expect, test } from "bun:test";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
	makeAuthorityRecord,
	type OperationReceipt,
	type RecordEnvelope,
	shellQuote,
	validateDeadline,
	validateEnvelope,
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

describe("G6 c32 canonical records", () => {
	test("sorts object keys recursively while preserving array order", () => {
		expect(
			canonicalJson({
				z: [{ y: 2, x: 1 }, "second"],
				a: { d: 4, b: 2 },
			}),
		).toBe(
			'{\n  "a": {\n    "b": 2,\n    "d": 4\n  },\n  "z": [\n    {\n      "x": 1,\n      "y": 2\n    },\n    "second"\n  ]\n}\n',
		);
	});

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
	});

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
	});

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
	});

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
	});

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
	});

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
	});

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
	});

	test("requires a future lifecycle deadline", () => {
		expect(
			validateDeadline("2026-08-30T12:34:56.789Z", "2026-08-30T13:34:56.789Z"),
		).toBe("2026-08-30T13:34:56.789Z");
		expect(() =>
			validateDeadline("2026-08-30T12:34:56.789Z", "2026-08-30T12:34:56.789Z"),
		).toThrow();
	});

	test("shell-quotes allow-listed verifier values without execution", () => {
		expect(shellQuote("plain-value")).toBe("'plain-value'");
		expect(shellQuote("a'b $(touch /tmp/nope)")).toBe(
			"'a'\"'\"'b $(touch /tmp/nope)'",
		);
		expect(() => shellQuote("nul\0byte")).toThrow();
	});
});
