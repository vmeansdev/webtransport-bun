import { describe, expect, test } from "bun:test";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	type OperationReceipt,
} from "./g6-c32-freeze-model.ts";
import {
	G6_C32_GATE_CATALOG,
	G6_C32_GATE_CATALOG_SCHEMA,
	gateDefinitionSha256,
	runGatePhase,
	validateGateCatalog,
	validateGateReceipt,
} from "./g6-c32-gates.ts";

const REQUIRED_BUN_TESTS = [
	"tools/load/g6-sharded-scan-source.test.ts",
	"tools/load/g6-shard-server-source.test.ts",
	"tools/load/g6-sharded-diagnostic.test.ts",
	"tools/load/g6-sharded-grade.test.ts",
	"tools/load/g6-c32-capacity-evaluate.test.ts",
	"tools/load/g6-c32-rca-evaluate.test.ts",
	"tools/load/g6-c32-successor-grade.test.ts",
	"tools/load/g6-offbox.test.ts",
	"tools/load/g6-offbox-provenance.test.ts",
	"tools/load/g6-linux-probe.test.ts",
	"tools/load/g6-bpf-map.test.ts",
	"tools/load/g6-manifest.test.ts",
	"tools/load/g6-bundle.test.ts",
	"tools/offbox/linux-generator-entry-g6.test.ts",
	"tools/offbox/generator-report.test.ts",
	"tools/load/g6-c32-freeze-model.test.ts",
	"tools/load/g6-c32-gates.test.ts",
	"tools/load/g6-c32-freeze.test.ts",
	"tools/load/g6-c32-operation.test.ts",
	"tools/load/g6-c32-rig-model.test.ts",
	"tools/load/g6-c32-rig-journal.test.ts",
	"tools/load/g6-c32-digitalocean.test.ts",
	"tools/load/g6-c32-host.test.ts",
	"tools/load/g6-c32-rca-controller.test.ts",
	"tools/load/g6-c32-rig.test.ts",
	"tools/load/g6-c32-rca-closure-source.test.ts",
] as const;

const EXPECTED_IDS = [
	"local-bun-campaign-suite",
	"local-reference-mmo-client-tests",
	"local-reference-integration-tests",
	"local-biome-changed-files",
	"local-rust-format",
	"local-typescript-typecheck",
	"local-reference-clippy",
	"prepared-server-bundle-verify",
	"prepared-generator-bundle-verify",
	"prepared-server-linux-smoke",
	"prepared-generator-linux-smoke",
	"prepared-server-rollback-proof",
	"locked-exact-pair-qualification",
	"final-candidate-bundle-verify",
	"final-manifest-verify",
] as const;

function operationReceipt(
	sequence: number,
	gateId: string,
	outcome: OperationReceipt["status"]["outcome"] = "SUCCEEDED",
): OperationReceipt {
	const exitCode = outcome === "SUCCEEDED" ? 0 : 1;
	return {
		schema: "g6-c32-operation-receipt/1",
		envelope: {
			recordedAt: `2026-08-30T12:00:${String(sequence).padStart(2, "0")}.000Z`,
			sequence,
			runId: "gate-test",
			phase: "LOCAL",
			operationId: `gate-${gateId}`,
			clockSource: "offrunner",
		},
		startedAt: `2026-08-30T12:00:${String(sequence).padStart(2, "0")}.000Z`,
		finishedAt: `2026-08-30T12:00:${String(sequence).padStart(2, "0")}.000Z`,
		durationMonotonicNs: "1",
		attempt: 1,
		action: {
			command: "fixture",
			args: [gateId],
			cwd: ".",
			environmentKeys: [],
		},
		status: { outcome, exitCode, signal: null },
		stdoutPath: `operations/${gateId}/operation.stdout`,
		stderrPath: `operations/${gateId}/operation.stderr`,
		remoteTiming: null,
	};
}

describe("G6 c32 immutable gate catalog", () => {
	test("binds the complete exact plan-required suite as semantic bytes", () => {
		const catalog = validateGateCatalog(G6_C32_GATE_CATALOG);
		expect(catalog.schema).toBe(G6_C32_GATE_CATALOG_SCHEMA);
		expect(catalog.gates.map(({ id }) => id)).toEqual([...EXPECTED_IDS]);
		expect(new Set(catalog.gates.map(({ id }) => id)).size).toBe(
			catalog.gates.length,
		);

		const bunGate = catalog.gates[0];
		expect(bunGate).toMatchObject({
			phase: "LOCAL",
			command: "bun",
			cwd: ".",
			requiredHost: "offrunner",
		});
		expect(bunGate?.args.slice(0, 1)).toEqual(["test"]);
		for (const path of REQUIRED_BUN_TESTS) {
			expect(bunGate?.args).toContain(path);
		}

		expect(catalog.gates).toContainEqual(
			expect.objectContaining({
				id: "local-reference-mmo-client-tests",
				command: "cargo",
				args: ["test", "-p", "reference", "--bin", "mmo-client"],
			}),
		);
		expect(catalog.gates).toContainEqual(
			expect.objectContaining({
				id: "local-rust-format",
				command: "cargo",
				args: ["fmt", "--check", "--all"],
			}),
		);
		expect(catalog.gates).toContainEqual(
			expect.objectContaining({
				id: "local-typescript-typecheck",
				command: "bun",
				args: ["run", "typecheck"],
			}),
		);
		expect(catalog.gates).toContainEqual(
			expect.objectContaining({
				id: "local-reference-clippy",
				command: "cargo",
				args: [
					"clippy",
					"-p",
					"reference",
					"--bin",
					"mmo-client",
					"--all-targets",
					"--",
					"-D",
					"warnings",
				],
			}),
		);
		expect(
			catalog.gates.filter(({ phase }) => phase === "PREPARED_HOST"),
		).toHaveLength(5);
		expect(catalog.gates.some(({ id }) => id.includes("rollback"))).toBeTrue();
		expect(catalog.gates.some(({ id }) => id.includes("bundle"))).toBeTrue();
		expect(catalog.gates.some(({ id }) => id.includes("manifest"))).toBeTrue();
		expect(catalog.gates).toContainEqual(
			expect.objectContaining({
				id: "locked-exact-pair-qualification",
				phase: "LOCKED_PAIR",
				command: "bun",
				args: [
					"tools/load/g6-c32-freeze.ts",
					"dispatch",
					"--root",
					"$" + "{G6_C32_BOUND_ROOT}",
					"--repository",
					"$" + "{G6_C32_REPOSITORY_PATH}",
				],
				requiredHost: "pair",
			}),
		);
		expect(Object.isFrozen(G6_C32_GATE_CATALOG)).toBeTrue();
		expect(Object.isFrozen(G6_C32_GATE_CATALOG.gates)).toBeTrue();
		for (const gate of G6_C32_GATE_CATALOG.gates) {
			expect(Object.isFrozen(gate)).toBeTrue();
			expect(Object.isFrozen(gate.args)).toBeTrue();
			expect(Object.isFrozen(gate.requiredInputs)).toBeTrue();
			expect(gateDefinitionSha256(gate)).toMatch(/^[0-9a-f]{64}$/);
		}
		expect(canonicalAuthoritySha256(catalog)).toMatch(/^[0-9a-f]{64}$/);
	});

	test("runs a phase serially and emits one timestamped PASS receipt per gate", async () => {
		const calls: string[] = [];
		let clockIndex = 40;
		const result = await runGatePhase({
			runId: "gate-test",
			phase: "LOCAL",
			catalog: G6_C32_GATE_CATALOG,
			sequenceStart: 1,
			inputs: {},
			clock: {
				wallNow: () =>
					`2026-08-30T12:00:${String(clockIndex++).padStart(2, "0")}.000Z`,
			},
			runner: {
				execute: async (request) => {
					calls.push(request.gate.id);
					const receipt = operationReceipt(request.sequence, request.gate.id);
					return {
						receipt,
						receiptPath: `operations/${request.gate.id}/operation.receipt.json`,
					};
				},
			},
		});

		const expected = G6_C32_GATE_CATALOG.gates
			.filter(({ phase }) => phase === "LOCAL")
			.map(({ id }) => id);
		expect(calls).toEqual(expected);
		expect(result.complete).toBeTrue();
		expect(result.receipts.map(({ result }) => result.verdict)).toEqual(
			expected.map(() => "PASS"),
		);
		for (const receipt of result.receipts) {
			expect(validateGateReceipt(receipt)).toEqual(receipt);
			expect(receipt.envelope.recordedAt).toMatch(/\.\d{3}Z$/);
			expect(receipt.result.operationReceiptArtifactSha256).toMatch(
				/^[0-9a-f]{64}$/,
			);
		}
	});

	test("records a failed gate and every unrun remainder as INCOMPLETE without fallback", async () => {
		const calls: string[] = [];
		let clockIndex = 40;
		const result = await runGatePhase({
			runId: "gate-test",
			phase: "LOCAL",
			catalog: G6_C32_GATE_CATALOG,
			sequenceStart: 20,
			inputs: {},
			clock: {
				wallNow: () =>
					`2026-08-30T12:00:${String(clockIndex++).padStart(2, "0")}.000Z`,
			},
			runner: {
				execute: async (request) => {
					calls.push(request.gate.id);
					const outcome = calls.length === 2 ? "FAILED" : "SUCCEEDED";
					const receipt = operationReceipt(
						request.sequence,
						request.gate.id,
						outcome,
					);
					return {
						receipt,
						receiptPath: `operations/${request.gate.id}/operation.receipt.json`,
					};
				},
			},
		});

		expect(result.complete).toBeFalse();
		expect(calls).toHaveLength(2);
		expect(result.receipts).toHaveLength(
			G6_C32_GATE_CATALOG.gates.filter(({ phase }) => phase === "LOCAL").length,
		);
		expect(result.receipts[0]?.result.verdict).toBe("PASS");
		expect(result.receipts[1]?.result).toMatchObject({
			verdict: "INCOMPLETE",
			reason: "NONZERO",
		});
		for (const receipt of result.receipts.slice(2)) {
			expect(receipt.result).toEqual({
				verdict: "INCOMPLETE",
				reason: "SKIPPED_AFTER_INCOMPLETE",
				operationReceiptPath: null,
				operationReceiptArtifactSha256: null,
			});
			expect(validateGateReceipt(receipt)).toEqual(receipt);
		}
	});

	test("records an unavailable runner before skipping the exact remainder", async () => {
		const run = await runGatePhase({
			runId: "gate-test",
			phase: "LOCAL",
			catalog: G6_C32_GATE_CATALOG,
			sequenceStart: 1,
			inputs: {},
			clock: { wallNow: () => "2026-08-30T12:02:00.000Z" },
			runner: {
				execute: async () => {
					throw new Error("binary unavailable");
				},
			},
		});
		expect(run.complete).toBeFalse();
		expect(run.receipts[0]?.result).toEqual({
			verdict: "INCOMPLETE",
			reason: "UNAVAILABLE",
			operationReceiptPath: null,
			operationReceiptArtifactSha256: null,
		});
		expect(
			run.receipts
				.slice(1)
				.every(({ result }) => result.reason === "SKIPPED_AFTER_INCOMPLETE"),
		).toBeTrue();
	});

	test("rejects catalog, definition, timestamp, status, and operation-digest drift", async () => {
		const catalog = structuredClone(G6_C32_GATE_CATALOG) as unknown as {
			schema: string;
			gates: Array<Record<string, unknown> & { args: string[] }>;
		};
		const firstGate = catalog.gates[0];
		expect(firstGate).toBeDefined();
		if (!firstGate) throw new Error("fixture gate is missing");
		firstGate.args = ["test"];
		expect(() => validateGateCatalog(catalog)).toThrow(/catalog|gate|args/i);

		const run = await runGatePhase({
			runId: "gate-test",
			phase: "LOCAL",
			catalog: G6_C32_GATE_CATALOG,
			sequenceStart: 1,
			inputs: {},
			clock: { wallNow: () => "2026-08-30T12:01:00.000Z" },
			runner: {
				execute: async (request) => {
					const receipt = operationReceipt(request.sequence, request.gate.id);
					return {
						receipt,
						receiptPath: `operations/${request.gate.id}/operation.receipt.json`,
					};
				},
			},
		});
		const valid = run.receipts[0];
		expect(valid).toBeDefined();
		if (!valid) throw new Error("fixture receipt is missing");
		expect(valid.result.operationReceiptArtifactSha256).toBe(
			canonicalArtifactSha256(operationReceipt(1, valid.gate.id)),
		);
		for (const invalid of [
			{ ...valid, envelope: { ...valid.envelope, recordedAt: "untimed" } },
			{ ...valid, gate: { ...valid.gate, definitionSha256: "0".repeat(64) } },
			{
				...valid,
				result: { ...valid.result, verdict: "INCOMPLETE", reason: null },
			},
		]) {
			expect(() => validateGateReceipt(invalid)).toThrow();
		}
	});
});
