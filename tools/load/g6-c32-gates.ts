import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
	type OperationReceipt,
	type RecordEnvelope,
	validateEnvelope,
	validateOperationReceipt,
	validateRecordSequence,
} from "./g6-c32-freeze-model.ts";

export const G6_C32_GATE_CATALOG_SCHEMA = "g6-c32-gate-catalog/1";
export const G6_C32_GATE_RECEIPT_SCHEMA = "g6-c32-gate-receipt/1";

export type GatePhase = "LOCAL" | "PREPARED_HOST" | "LOCKED_PAIR" | "FINAL";
export type GateRequiredHost = "offrunner" | "server" | "generator" | "pair";

export type GateDefinition = Readonly<{
	id: string;
	phase: GatePhase;
	command: string;
	args: readonly string[];
	cwd: string;
	timeoutMs: number;
	requiredHost: GateRequiredHost;
	requiredInputs: readonly string[];
}>;

export type GateCatalog = Readonly<{
	schema: typeof G6_C32_GATE_CATALOG_SCHEMA;
	gates: readonly GateDefinition[];
}>;

export type GateIncompleteReason =
	| "MISSING_INPUT"
	| "UNAVAILABLE"
	| "TIMEOUT"
	| "SIGNAL_OR_CANCELLED"
	| "NONZERO"
	| "SKIPPED_AFTER_INCOMPLETE";

export type GateReceipt = Readonly<{
	schema: typeof G6_C32_GATE_RECEIPT_SCHEMA;
	envelope: RecordEnvelope;
	gateCatalogAuthoritySha256: string;
	gate: {
		id: string;
		phase: GatePhase;
		definitionSha256: string;
	};
	result:
		| {
				verdict: "PASS";
				reason: null;
				operationReceiptPath: string;
				operationReceiptArtifactSha256: string;
		  }
		| {
				verdict: "INCOMPLETE";
				reason: GateIncompleteReason;
				operationReceiptPath: string | null;
				operationReceiptArtifactSha256: string | null;
		  };
}>;

export type GateExecutionRequest = Readonly<{
	runId: string;
	sequence: number;
	gate: GateDefinition;
	command: string;
	args: readonly string[];
	cwd: string;
	timeoutMs: number;
	requiredHost: GateRequiredHost;
}>;

export interface GateOperationRunner {
	execute(request: GateExecutionRequest): Promise<{
		receipt: OperationReceipt;
		receiptPath: string;
	}>;
}

export interface GateClock {
	wallNow(): string;
}

export type RunGatePhaseOptions = {
	runId: string;
	phase: GatePhase;
	catalog: GateCatalog;
	sequenceStart: number;
	inputs: Readonly<Record<string, string>>;
	clock: GateClock;
	runner: GateOperationRunner;
	onReceipt?: (receipt: GateReceipt) => void | Promise<void>;
};

export type GatePhaseResult = Readonly<{
	phase: GatePhase;
	complete: boolean;
	receipts: readonly GateReceipt[];
}>;

const BUN_CAMPAIGN_TESTS = [
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

const BIOME_CHANGED_FILES = [
	"package.json",
	"tools/load/g6-c32-freeze-model.ts",
	"tools/load/g6-c32-freeze-model.test.ts",
	"tools/load/g6-c32-freeze.ts",
	"tools/load/g6-c32-freeze.test.ts",
	"tools/load/g6-c32-gates.ts",
	"tools/load/g6-c32-gates.test.ts",
	"tools/load/g6-c32-operation.ts",
	"tools/load/g6-c32-operation.test.ts",
	"tools/load/g6-c32-rig-model.ts",
	"tools/load/g6-c32-rig-model.test.ts",
	"tools/load/g6-c32-rig-journal.ts",
	"tools/load/g6-c32-rig-journal.test.ts",
	"tools/load/g6-c32-digitalocean.ts",
	"tools/load/g6-c32-digitalocean.test.ts",
	"tools/load/g6-c32-host.ts",
	"tools/load/g6-c32-host.test.ts",
	"tools/load/g6-c32-rca-controller.test.ts",
	"tools/load/g6-c32-rig.ts",
	"tools/load/g6-c32-rig.test.ts",
	"tools/load/g6-c32-rca-closure-source.test.ts",
] as const;

const gate = (
	id: string,
	phase: GatePhase,
	command: string,
	args: readonly string[],
	timeoutMs: number,
	requiredHost: GateRequiredHost,
	requiredInputs: readonly string[] = [],
	cwd = ".",
): GateDefinition => ({
	id,
	phase,
	command,
	args,
	cwd,
	timeoutMs,
	requiredHost,
	requiredInputs,
});

const inputToken = (name: string): string => `\${${name}}`;

const RAW_GATE_CATALOG: GateCatalog = {
	schema: G6_C32_GATE_CATALOG_SCHEMA,
	gates: [
		gate(
			"local-bun-campaign-suite",
			"LOCAL",
			"bun",
			["test", ...BUN_CAMPAIGN_TESTS],
			1_800_000,
			"offrunner",
		),
		gate(
			"local-reference-mmo-client-tests",
			"LOCAL",
			"cargo",
			["test", "-p", "reference", "--bin", "mmo-client"],
			1_200_000,
			"offrunner",
		),
		gate(
			"local-reference-integration-tests",
			"LOCAL",
			"cargo",
			["test", "-p", "reference"],
			1_200_000,
			"offrunner",
		),
		gate(
			"local-biome-changed-files",
			"LOCAL",
			"bunx",
			[
				"@biomejs/biome",
				"check",
				"--error-on-warnings",
				...BIOME_CHANGED_FILES,
			],
			300_000,
			"offrunner",
		),
		gate(
			"local-rust-format",
			"LOCAL",
			"cargo",
			["fmt", "--check", "--all"],
			300_000,
			"offrunner",
		),
		gate(
			"local-typescript-typecheck",
			"LOCAL",
			"bun",
			["run", "typecheck"],
			600_000,
			"offrunner",
		),
		gate(
			"local-reference-clippy",
			"LOCAL",
			"cargo",
			[
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
			1_200_000,
			"offrunner",
		),
		gate(
			"prepared-server-bundle-verify",
			"PREPARED_HOST",
			"git",
			["bundle", "verify", inputToken("G6_C32_REMOTE_BUNDLE_PATH")],
			120_000,
			"server",
			["G6_C32_REMOTE_BUNDLE_PATH"],
		),
		gate(
			"prepared-generator-bundle-verify",
			"PREPARED_HOST",
			"git",
			["bundle", "verify", inputToken("G6_C32_REMOTE_BUNDLE_PATH")],
			120_000,
			"generator",
			["G6_C32_REMOTE_BUNDLE_PATH"],
		),
		gate(
			"prepared-server-linux-smoke",
			"PREPARED_HOST",
			"bash",
			[
				inputToken("G6_C32_REMOTE_SMOKE_SCRIPT"),
				"server",
				inputToken("G6_C32_REMOTE_SMOKE_SERVER_EVIDENCE"),
			],
			300_000,
			"server",
			["G6_C32_REMOTE_SMOKE_SCRIPT", "G6_C32_REMOTE_SMOKE_SERVER_EVIDENCE"],
		),
		gate(
			"prepared-generator-linux-smoke",
			"PREPARED_HOST",
			"bash",
			[
				inputToken("G6_C32_REMOTE_SMOKE_SCRIPT"),
				"generator",
				inputToken("G6_C32_REMOTE_SMOKE_GENERATOR_EVIDENCE"),
			],
			300_000,
			"generator",
			["G6_C32_REMOTE_SMOKE_SCRIPT", "G6_C32_REMOTE_SMOKE_GENERATOR_EVIDENCE"],
		),
		gate(
			"prepared-server-rollback-proof",
			"PREPARED_HOST",
			"bash",
			[
				inputToken("G6_C32_REMOTE_ROLLBACK_SCRIPT"),
				inputToken("G6_C32_REMOTE_ROLLBACK_EVIDENCE"),
			],
			300_000,
			"server",
			["G6_C32_REMOTE_ROLLBACK_SCRIPT", "G6_C32_REMOTE_ROLLBACK_EVIDENCE"],
		),
		gate(
			"locked-exact-pair-qualification",
			"LOCKED_PAIR",
			"bash",
			[
				"tools/load/g6-c32-rca-controller.sh",
				"qualify",
				"--bound-root",
				inputToken("G6_C32_BOUND_ROOT"),
			],
			1_200_000,
			"pair",
			["G6_C32_BOUND_ROOT"],
		),
		gate(
			"final-candidate-bundle-verify",
			"FINAL",
			"git",
			["bundle", "verify", inputToken("G6_C32_CANDIDATE_BUNDLE_PATH")],
			120_000,
			"offrunner",
			["G6_C32_CANDIDATE_BUNDLE_PATH"],
		),
		gate(
			"final-manifest-verify",
			"FINAL",
			"bun",
			[
				"tools/load/g6-c32-freeze.ts",
				"verify",
				"--root",
				inputToken("G6_C32_BOUND_ROOT"),
				"--manifest-only",
			],
			300_000,
			"offrunner",
			["G6_C32_BOUND_ROOT"],
		),
	],
};

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const nested of Object.values(value as Record<string, unknown>)) {
			deepFreeze(nested);
		}
	}
	return value;
}

export const G6_C32_GATE_CATALOG: GateCatalog = deepFreeze(RAW_GATE_CATALOG);

const PHASES = new Set<GatePhase>([
	"LOCAL",
	"PREPARED_HOST",
	"LOCKED_PAIR",
	"FINAL",
]);
const HOSTS = new Set<GateRequiredHost>([
	"offrunner",
	"server",
	"generator",
	"pair",
]);
const HASH_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const INPUT_RE = /^[A-Z_][A-Z0-9_]*$/;
const INPUT_TOKEN_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

function fail(message: string): never {
	throw new Error(`g6-c32-gates: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		fail(`${label} has unexpected keys`);
	}
}

function requireString(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.includes("\0") ||
		value.includes("\n") ||
		value.includes("\r")
	) {
		fail(`${label} must be a nonempty NUL-free single-line string`);
	}
	return value;
}

function requirePortableCwd(value: unknown, label: string): string {
	const checked = requireString(value, label);
	if (
		checked !== "." &&
		(checked.startsWith("/") ||
			checked.includes("\\") ||
			checked
				.split("/")
				.some((part) => part === "" || part === "." || part === ".."))
	) {
		fail(`${label} must be '.' or a portable repository-relative path`);
	}
	return checked;
}

function requireStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value.map((entry, index) => {
		if (typeof entry !== "string" || entry.includes("\0")) {
			fail(`${label}[${index}] must be a NUL-free string`);
		}
		return entry;
	});
}

function validateGateDefinition(value: unknown, index: number): GateDefinition {
	const label = `catalog.gates[${index}]`;
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(
		value,
		[
			"id",
			"phase",
			"command",
			"args",
			"cwd",
			"timeoutMs",
			"requiredHost",
			"requiredInputs",
		],
		label,
	);
	const id = requireString(value.id, `${label}.id`);
	if (!SAFE_ID_RE.test(id)) fail(`${label}.id is not safe`);
	if (!PHASES.has(value.phase as GatePhase)) fail(`${label}.phase is invalid`);
	if (!HOSTS.has(value.requiredHost as GateRequiredHost)) {
		fail(`${label}.requiredHost is invalid`);
	}
	if (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) < 1) {
		fail(`${label}.timeoutMs must be a positive safe integer`);
	}
	const args = requireStringArray(value.args, `${label}.args`);
	const requiredInputs = requireStringArray(
		value.requiredInputs,
		`${label}.requiredInputs`,
	);
	if (
		new Set(requiredInputs).size !== requiredInputs.length ||
		requiredInputs.some((input) => !INPUT_RE.test(input))
	) {
		fail(`${label}.requiredInputs must contain unique environment-style names`);
	}
	const usedInputs = new Set(
		args.flatMap((argument) => {
			const match = INPUT_TOKEN_RE.exec(argument);
			return match?.[1] ? [match[1]] : [];
		}),
	);
	if (
		usedInputs.size !== requiredInputs.length ||
		requiredInputs.some((input) => !usedInputs.has(input))
	) {
		fail(`${label} input tokens must exactly match requiredInputs`);
	}
	return {
		id,
		phase: value.phase as GatePhase,
		command: requireString(value.command, `${label}.command`),
		args,
		cwd: requirePortableCwd(value.cwd, `${label}.cwd`),
		timeoutMs: Number(value.timeoutMs),
		requiredHost: value.requiredHost as GateRequiredHost,
		requiredInputs,
	};
}

export function validateGateCatalog(value: unknown): GateCatalog {
	if (!isRecord(value)) fail("catalog must be an object");
	requireExactKeys(value, ["schema", "gates"], "catalog");
	if (value.schema !== G6_C32_GATE_CATALOG_SCHEMA) {
		fail(`catalog schema must be ${G6_C32_GATE_CATALOG_SCHEMA}`);
	}
	if (!Array.isArray(value.gates) || value.gates.length === 0) {
		fail("catalog.gates must be a nonempty array");
	}
	const gates = value.gates.map(validateGateDefinition);
	if (new Set(gates.map(({ id }) => id)).size !== gates.length) {
		fail("catalog gate IDs must be unique");
	}
	const checked: GateCatalog = {
		schema: G6_C32_GATE_CATALOG_SCHEMA,
		gates,
	};
	if (canonicalJson(checked) !== canonicalJson(RAW_GATE_CATALOG)) {
		fail("catalog differs from the complete immutable G6 c32 gate catalog");
	}
	return checked;
}

export function gateDefinitionSha256(gateValue: GateDefinition): string {
	return canonicalAuthoritySha256(validateGateDefinition(gateValue, 0));
}

function requireHash(value: unknown, label: string): string {
	if (typeof value !== "string" || !HASH_RE.test(value)) {
		fail(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

function findGate(id: string, phase: GatePhase): GateDefinition {
	const gate = G6_C32_GATE_CATALOG.gates.find(
		(candidate) => candidate.id === id && candidate.phase === phase,
	);
	if (!gate) fail(`gate receipt references unknown gate ${id}/${phase}`);
	return gate;
}

export function validateGateReceipt(value: unknown): GateReceipt {
	if (!isRecord(value)) fail("gate receipt must be an object");
	requireExactKeys(
		value,
		["schema", "envelope", "gateCatalogAuthoritySha256", "gate", "result"],
		"gate receipt",
	);
	if (value.schema !== G6_C32_GATE_RECEIPT_SCHEMA) {
		fail(`gate receipt schema must be ${G6_C32_GATE_RECEIPT_SCHEMA}`);
	}
	const envelope = validateEnvelope(value.envelope);
	if (!isRecord(value.gate)) fail("gate receipt gate must be an object");
	requireExactKeys(
		value.gate,
		["id", "phase", "definitionSha256"],
		"gate receipt gate",
	);
	const id = requireString(value.gate.id, "gate receipt gate.id");
	if (!PHASES.has(value.gate.phase as GatePhase)) {
		fail("gate receipt gate.phase is invalid");
	}
	const phase = value.gate.phase as GatePhase;
	const definition = findGate(id, phase);
	const definitionSha256 = requireHash(
		value.gate.definitionSha256,
		"gate receipt gate.definitionSha256",
	);
	if (definitionSha256 !== gateDefinitionSha256(definition)) {
		fail("gate receipt definition digest mismatch");
	}
	const gateCatalogAuthoritySha256 = requireHash(
		value.gateCatalogAuthoritySha256,
		"gate receipt gateCatalogAuthoritySha256",
	);
	if (
		gateCatalogAuthoritySha256 !== canonicalAuthoritySha256(G6_C32_GATE_CATALOG)
	) {
		fail("gate receipt catalog digest mismatch");
	}
	if (
		envelope.phase !== phase ||
		envelope.operationId !== `gate-${id}` ||
		envelope.clockSource !== "offrunner"
	) {
		fail("gate receipt envelope does not match its gate");
	}
	if (!isRecord(value.result)) fail("gate receipt result must be an object");
	requireExactKeys(
		value.result,
		[
			"verdict",
			"reason",
			"operationReceiptPath",
			"operationReceiptArtifactSha256",
		],
		"gate receipt result",
	);
	if (value.result.verdict === "PASS") {
		if (value.result.reason !== null) fail("PASS gate reason must be null");
		return {
			schema: G6_C32_GATE_RECEIPT_SCHEMA,
			envelope,
			gateCatalogAuthoritySha256,
			gate: { id, phase, definitionSha256 },
			result: {
				verdict: "PASS",
				reason: null,
				operationReceiptPath: requireString(
					value.result.operationReceiptPath,
					"gate receipt operationReceiptPath",
				),
				operationReceiptArtifactSha256: requireHash(
					value.result.operationReceiptArtifactSha256,
					"gate receipt operationReceiptArtifactSha256",
				),
			},
		};
	}
	if (value.result.verdict !== "INCOMPLETE") {
		fail("gate receipt verdict must be PASS or INCOMPLETE");
	}
	const reasons = new Set<GateIncompleteReason>([
		"MISSING_INPUT",
		"UNAVAILABLE",
		"TIMEOUT",
		"SIGNAL_OR_CANCELLED",
		"NONZERO",
		"SKIPPED_AFTER_INCOMPLETE",
	]);
	if (!reasons.has(value.result.reason as GateIncompleteReason)) {
		fail("INCOMPLETE gate reason is invalid");
	}
	const reason = value.result.reason as GateIncompleteReason;
	const operationReceiptPath =
		value.result.operationReceiptPath === null
			? null
			: requireString(
					value.result.operationReceiptPath,
					"gate receipt operationReceiptPath",
				);
	const operationReceiptArtifactSha256 =
		value.result.operationReceiptArtifactSha256 === null
			? null
			: requireHash(
					value.result.operationReceiptArtifactSha256,
					"gate receipt operationReceiptArtifactSha256",
				);
	if (
		(operationReceiptPath === null) !==
		(operationReceiptArtifactSha256 === null)
	) {
		fail(
			"gate receipt operation path and digest must both be present or absent",
		);
	}
	if (
		(reason === "SKIPPED_AFTER_INCOMPLETE" || reason === "MISSING_INPUT") &&
		operationReceiptPath !== null
	) {
		fail(`${reason} must not reference an operation receipt`);
	}
	if (
		reason !== "SKIPPED_AFTER_INCOMPLETE" &&
		reason !== "MISSING_INPUT" &&
		reason !== "UNAVAILABLE" &&
		operationReceiptPath === null
	) {
		fail(`${reason} must reference an operation receipt`);
	}
	return {
		schema: G6_C32_GATE_RECEIPT_SCHEMA,
		envelope,
		gateCatalogAuthoritySha256,
		gate: { id, phase, definitionSha256 },
		result: {
			verdict: "INCOMPLETE",
			reason,
			operationReceiptPath,
			operationReceiptArtifactSha256,
		},
	};
}

function resolveGate(
	gate: GateDefinition,
	inputs: Readonly<Record<string, string>>,
): { command: string; args: string[] } | null {
	for (const name of gate.requiredInputs) {
		const value = inputs[name];
		if (
			typeof value !== "string" ||
			value === "" ||
			value.includes("\0") ||
			value.includes("\n") ||
			value.includes("\r")
		) {
			return null;
		}
	}
	return {
		command: gate.command,
		args: gate.args.map((argument) => {
			const match = INPUT_TOKEN_RE.exec(argument);
			return match?.[1] ? (inputs[match[1]] as string) : argument;
		}),
	};
}

function operationFailureReason(
	receipt: OperationReceipt,
): GateIncompleteReason | null {
	if (receipt.status.outcome === "SUCCEEDED") return null;
	if (receipt.status.outcome === "TIMED_OUT") return "TIMEOUT";
	if (
		receipt.status.outcome === "CANCELLED" ||
		receipt.status.signal !== null
	) {
		return "SIGNAL_OR_CANCELLED";
	}
	if (receipt.status.exitCode === null) return "UNAVAILABLE";
	return "NONZERO";
}

function createReceipt(
	options: RunGatePhaseOptions,
	gate: GateDefinition,
	sequence: number,
	result: GateReceipt["result"],
): GateReceipt {
	return validateGateReceipt({
		schema: G6_C32_GATE_RECEIPT_SCHEMA,
		envelope: {
			recordedAt: options.clock.wallNow(),
			sequence,
			runId: options.runId,
			phase: gate.phase,
			operationId: `gate-${gate.id}`,
			clockSource: "offrunner",
		},
		gateCatalogAuthoritySha256: canonicalAuthoritySha256(G6_C32_GATE_CATALOG),
		gate: {
			id: gate.id,
			phase: gate.phase,
			definitionSha256: gateDefinitionSha256(gate),
		},
		result,
	});
}

async function emit(
	options: RunGatePhaseOptions,
	receipt: GateReceipt,
): Promise<void> {
	await options.onReceipt?.(receipt);
}

export async function runGatePhase(
	options: RunGatePhaseOptions,
): Promise<GatePhaseResult> {
	const catalog = validateGateCatalog(options.catalog);
	if (!PHASES.has(options.phase)) fail("requested gate phase is invalid");
	if (
		!Number.isSafeInteger(options.sequenceStart) ||
		options.sequenceStart < 1
	) {
		fail("sequenceStart must be a positive safe integer");
	}
	const gates = catalog.gates.filter(({ phase }) => phase === options.phase);
	if (gates.length === 0) fail(`catalog has no ${options.phase} gates`);
	const receipts: GateReceipt[] = [];
	let incomplete = false;
	for (const [index, gate] of gates.entries()) {
		const sequence = options.sequenceStart + index;
		if (incomplete) {
			const receipt = createReceipt(options, gate, sequence, {
				verdict: "INCOMPLETE",
				reason: "SKIPPED_AFTER_INCOMPLETE",
				operationReceiptPath: null,
				operationReceiptArtifactSha256: null,
			});
			receipts.push(receipt);
			await emit(options, receipt);
			continue;
		}
		const resolved = resolveGate(gate, options.inputs);
		if (resolved === null) {
			incomplete = true;
			const receipt = createReceipt(options, gate, sequence, {
				verdict: "INCOMPLETE",
				reason: "MISSING_INPUT",
				operationReceiptPath: null,
				operationReceiptArtifactSha256: null,
			});
			receipts.push(receipt);
			await emit(options, receipt);
			continue;
		}
		let executed:
			| { receipt: OperationReceipt; receiptPath: string }
			| undefined;
		try {
			executed = await options.runner.execute({
				runId: options.runId,
				sequence,
				gate,
				command: resolved.command,
				args: resolved.args,
				cwd: gate.cwd,
				timeoutMs: gate.timeoutMs,
				requiredHost: gate.requiredHost,
			});
		} catch {
			incomplete = true;
			const receipt = createReceipt(options, gate, sequence, {
				verdict: "INCOMPLETE",
				reason: "UNAVAILABLE",
				operationReceiptPath: null,
				operationReceiptArtifactSha256: null,
			});
			receipts.push(receipt);
			await emit(options, receipt);
			continue;
		}
		const operation = validateOperationReceipt(executed.receipt);
		if (
			operation.envelope.runId !== options.runId ||
			operation.envelope.sequence !== sequence ||
			operation.envelope.phase !== gate.phase ||
			operation.envelope.operationId !== `gate-${gate.id}`
		) {
			fail(`operation receipt authority mismatch for ${gate.id}`);
		}
		const reason = operationFailureReason(operation);
		if (reason !== null) incomplete = true;
		const receipt = createReceipt(
			options,
			gate,
			sequence,
			reason === null
				? {
						verdict: "PASS",
						reason: null,
						operationReceiptPath: executed.receiptPath,
						operationReceiptArtifactSha256: canonicalArtifactSha256(operation),
					}
				: {
						verdict: "INCOMPLETE",
						reason,
						operationReceiptPath: executed.receiptPath,
						operationReceiptArtifactSha256: canonicalArtifactSha256(operation),
					},
		);
		receipts.push(receipt);
		await emit(options, receipt);
	}
	validateRecordSequence(receipts.map(({ envelope }) => envelope));
	return {
		phase: options.phase,
		complete: !incomplete,
		receipts,
	};
}
