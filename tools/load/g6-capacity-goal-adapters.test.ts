/** Synthetic offline evidence only. These tests neither execute Linux nor prove capacity. */
import {
	afterAll,
	afterEach,
	beforeAll,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeCapacityLadderWorkPlan } from "./g6-c32-capacity-work.ts";
import {
	canonicalArtifactSha256,
	requireDefined,
	validateOperationReceipt,
} from "./g6-c32-freeze-model.ts";
import {
	cleanupSendPathFixtures,
	sendPathFixture,
} from "./g6-c32-send-path-fixture.test-helper.ts";
import { runWorkCli } from "./g6-c32-work-cli.ts";
import { readWorkCellEvidence } from "./g6-c32-work-execution.ts";
import { gradeWorkCell } from "./g6-c32-work-grade.ts";
import {
	completeGoalAdaptersFixture,
	syntheticLinuxProcessFixture as processFixture,
} from "./g6-capacity-goal-adapters.fixture.test-helper.ts";
import type { CapacityGoalContract } from "./g6-capacity-goal-evaluate.ts";
import {
	evaluateCapacityGoal,
	validateCapacityGoalContract,
} from "./g6-capacity-goal-evaluate.ts";
import {
	contextFromBound,
	verifyCapacityHostReviews,
} from "./g6-capacity-host-review.ts";
import {
	readWorkAuthority,
	validateWorkAuthority,
} from "./g6-capacity-work-authority.ts";

const module = await import("./g6-capacity-goal-adapters.ts").catch(() => null);
const sha = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
function syntheticRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw Error("synthetic fixture requires a JSON object");
	return value as Record<string, unknown>;
}
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupSendPathFixtures);
function api() {
	expect(module?.evaluateCapacityGoalAdapters).toBeFunction();
	return requireDefined(module).evaluateCapacityGoalAdapters;
}
function fixture() {
	const repoRoot = realpathSync(
		mkdtempSync(join(tmpdir(), "g6-goal-adapters-")),
	);
	roots.push(repoRoot);
	const evidenceRoot = join(repoRoot, "evidence");
	mkdirSync(evidenceRoot);
	const verified = new Map<string, string>();
	const contract = {
		objective: { sourceSha: "b".repeat(40), evidenceRoot: "evidence" },
		pendingAdapters: {},
	} as CapacityGoalContract;
	function write(path: string, value: unknown) {
		const bytes = typeof value === "string" ? value : JSON.stringify(value);
		mkdirSync(dirname(join(evidenceRoot, path)), { recursive: true });
		writeFileSync(join(evidenceRoot, path), bytes);
		verified.set(path, sha(bytes));
	}
	return { repoRoot, evidenceRoot, verified, contract, write };
}
test("all four absent mandatory adapters remain explicitly incomplete", () => {
	const f = fixture(),
		result = api()(f);
	expect(result.fatalReasons).toHaveLength(4);
	for (const name of [
		"diagnostics",
		"waiterSafety",
		"sameHostA",
		"finalTeardown",
	])
		expect(result.fatalReasons.join("\n")).toContain(
			`required adapter ${name} is missing`,
		);
});
test.each([
	"../outside.json",
	"/outside.json",
	"sub/../adapter.json",
	"sub\\adapter.json",
])("rejects unsafe adapter path %s before reading a verifier dependency", (path) => {
	const f = fixture();
	f.contract = {
		...f.contract,
		pendingAdapters: {
			diagnostics: { schema: "g6-capacity-diagnostic-coverage/1", path },
		},
	};
	expect(api()(f).fatalReasons.join("\n")).toContain("unsafe");
});
test.each([
	"uncovered",
	"changed",
	"symlink",
])("rejects %s adapter evidence before raw replay", (change) => {
	const f = fixture();
	f.write("adapter.json", { schema: "g6-capacity-diagnostic-coverage/1" });
	f.contract = {
		...f.contract,
		pendingAdapters: {
			diagnostics: {
				schema: "g6-capacity-diagnostic-coverage/1",
				path: "adapter.json",
			},
		},
	};
	if (change === "uncovered") f.verified.delete("adapter.json");
	if (change === "changed")
		writeFileSync(join(f.evidenceRoot, "adapter.json"), "{}");
	if (change === "symlink") {
		f.write(
			"real.json",
			readFileSync(join(f.evidenceRoot, "adapter.json"), "utf8"),
		);
		rmSync(join(f.evidenceRoot, "adapter.json"));
		symlinkSync("real.json", join(f.evidenceRoot, "adapter.json"));
	}
	expect(api()(f).fatalReasons.join("\n")).toMatch(/hash-verified|symlink/);
});
test("an uncovered file anywhere in a referenced run tree refuses replay", () => {
	const f = fixture();
	const ref = {
		runRoot: "evidence/run-a",
		boundRoot: "evidence/run-a/bound",
		policyPath: "evidence/a-policy.json",
	};
	f.write("adapter.json", {
		schema: "g6-capacity-diagnostic-coverage/1",
		campaignA: ref,
		campaignB: ref,
	});
	f.write("run-a/bound/semantic-freeze.json", "{}");
	f.write("run-a/unsealed-output.txt", "unverified");
	f.verified.delete("run-a/unsealed-output.txt");
	f.write("a-policy.json", "{}");
	f.contract = {
		...f.contract,
		pendingAdapters: {
			diagnostics: {
				schema: "g6-capacity-diagnostic-coverage/1",
				path: "adapter.json",
			},
		},
	};
	expect(api()(f).fatalReasons.join("\n")).toContain(
		"unsealed-output.txt is not hash-verified",
	);
});
test.each([
	"complete",
	"uncovered-extra",
	"forged-blob",
	"missing-file",
	"symlink",
])("final local proof source closure: %s", (change) => {
	const f = fixture();
	const git = (...args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: f.repoRoot,
			encoding: "utf8",
		});
		if (result.status !== 0) throw Error(result.stderr);
		return result.stdout.trim();
	};
	git("init", "--quiet");
	git("config", "user.name", "Synthetic Source Proof");
	git("config", "user.email", "synthetic@example.invalid");
	writeFileSync(join(f.repoRoot, "source.ts"), "// synthetic source\n");
	writeFileSync(
		join(f.repoRoot, "source.test.ts"),
		"// synthetic source test\n",
	);
	git("add", "source.ts", "source.test.ts");
	git("commit", "--quiet", "-m", "Add synthetic source tree");
	for (const name of ["source.ts", "source.test.ts"])
		f.write(`source/${name}`, readFileSync(join(f.repoRoot, name), "utf8"));
	const sourceSha = git("rev-parse", "HEAD");
	if (change === "uncovered-extra") {
		f.write("source/extra-output.txt", "not manifested");
		f.verified.delete("source/extra-output.txt");
	}
	if (change === "forged-blob")
		f.write("source/source.ts", "// manifest-rehashed different source\n");
	if (change === "missing-file")
		rmSync(join(f.evidenceRoot, "source/source.test.ts"));
	if (change === "symlink") {
		rmSync(join(f.evidenceRoot, "source/source.test.ts"));
		symlinkSync("source.ts", join(f.evidenceRoot, "source/source.test.ts"));
	}
	const check = () =>
		requireDefined(module).verifyCapacityLocalProofSource({
			...f,
			sourceRoot: "evidence/source",
			sourceSha,
		});
	if (change === "complete") expect(check).not.toThrow();
	else expect(check).toThrow();
});
test.each([
	["diagnostics", "g6-capacity-diagnostic-coverage/1"],
	["waiterSafety", "g6-capacity-waiter-safety/1"],
	["sameHostA", "g6-capacity-same-host-audit/1"],
	["finalTeardown", "g6-capacity-final-teardown/1"],
])("%s cannot be satisfied by a naked schema/PASS without its complete adapter dependency record", (name, schema) => {
	const f = fixture();
	f.write("adapter.json", { schema, verdict: "PASS" });
	f.contract = {
		...f.contract,
		pendingAdapters: {
			[requireDefined(name)]: { schema, path: "adapter.json" },
		},
	};
	expect(api()(f).fatalReasons.join("\n")).toContain(
		"missing or unknown fields",
	);
});

let raw: ReturnType<typeof sendPathFixture>;
beforeAll(() => {
	raw = sendPathFixture();
});
function diagnosticInput() {
	const prefix = join(raw.root, "work/A1-1");
	return {
		diagnostic: JSON.parse(
			readFileSync(join(prefix, "g6-sharded-diagnostic.json"), "utf8"),
		),
		profile:
			raw.policy.schema === "g6-c32-budget-policy/2"
				? requireDefined(raw.policy.workProfiles["stock-probe-on"])
				: never(),
		nativeProducerSha256: raw.nativeProducerSha256,
		probeProducerSha256: raw.probeProducerSha256,
		probeText: readFileSync(join(prefix, "linux-probe.jsonl"), "utf8"),
		operation: JSON.parse(
			readFileSync(join(prefix, "scan.receipt.json"), "utf8"),
		),
	};
}
function never(): never {
	throw Error("fixture must use policy/2");
}
test("synthetic complete raw native and Linux phase coverage replays without summary verdicts", () => {
	expect(module?.validateCapacityDiagnosticCoverage).toBeFunction();
	expect(() =>
		requireDefined(module).validateCapacityDiagnosticCoverage(
			diagnosticInput(),
		),
	).not.toThrow();
});
test.each([
	"native-source",
	"phase-order",
	"censored",
	"probe-source",
	"missing-probe",
	"short-operation",
])("diagnostic coverage refuses %s despite retained PASS fields", (change) => {
	const input = diagnosticInput();
	input.diagnostic.verdict = "PASS";
	if (change === "native-source") input.nativeProducerSha256 = "0".repeat(64);
	if (change === "phase-order")
		input.diagnostic.sendPathDiagnostics.shards[0].boundaries.drain.monoNs =
			"1";
	if (change === "censored")
		input.diagnostic.sendPathDiagnostics.shards[0].final.components[0].phases[2].intervals[0].histogram.censored = 1;
	if (change === "probe-source") input.probeProducerSha256 = "0".repeat(64);
	if (change === "missing-probe") input.probeText = "";
	if (change === "short-operation")
		input.operation.durationMonotonicNs = "1000";
	expect(module?.validateCapacityDiagnosticCoverage).toBeFunction();
	expect(() =>
		requireDefined(module).validateCapacityDiagnosticCoverage(input),
	).toThrow();
});

function candidateFixture() {
	const aDigests = {
		semanticFreezeArtifactSha256: "1".repeat(64),
		hostBindingArtifactSha256: "2".repeat(64),
		terminalReceiptSha256: "3".repeat(64),
		workFinalArtifactSha256: "4".repeat(64),
		attributionArtifactSha256: "5".repeat(64),
	};
	const expected = {
		sourceASha: "a".repeat(40),
		sourceSha: "b".repeat(40),
		aDigests,
		aSealedAt: "2026-09-05T01:00:00.000Z",
		bCreateAt: "2026-09-05T02:00:00.000Z",
	};
	const decision = {
		schema: "g6-capacity-candidate-decision/1",
		recordedAt: "2026-09-05T01:01:00.000Z",
		sourceASha: expected.sourceASha,
		sourceSha: expected.sourceSha,
		aDigests,
		alternatives: [
			{
				id: "bounded-flusher",
				explanation:
					"Synthetic queue evidence supports testing retained ownership",
				evidencePaths: ["evidence/A/raw-queue.json"],
				files: ["crates/native/src/udp_send_batch.rs"],
				tests: ["crates/native/src/udp_send_batch.rs"],
			},
			{
				id: "stock-send",
				explanation: "Synthetic alternative examines socket readiness cost",
				evidencePaths: ["evidence/A/raw-stock.json"],
				files: ["crates/native/src/udp_send_batch.rs"],
				tests: ["crates/native/src/udp_send_batch.rs"],
			},
		],
		selectedAlternativeId: "bounded-flusher",
		selectionExplanation:
			"Synthetic choice for adapter tests only, not measured attribution",
	};
	const decisionBytes = JSON.stringify(decision);
	const architect = {
		schema: "g6-capacity-candidate-review/1",
		role: "architect",
		verdict: "APPROVE",
		unconditional: true,
		recordedAt: "2026-09-05T01:02:00.000Z",
		sourceSha: expected.sourceSha,
		decisionSha256: sha(decisionBytes),
		afterArchitectReceiptArtifactSha256: null,
	};
	const critic = {
		...architect,
		role: "critic",
		recordedAt: "2026-09-05T01:03:00.000Z",
		afterArchitectReceiptArtifactSha256: canonicalArtifactSha256(architect),
	};
	const seen: string[] = [];
	return {
		decision,
		decisionBytes,
		architect,
		critic,
		expected,
		readEvidence: (path: string) => {
			seen.push(path);
			return Buffer.from("synthetic raw A");
		},
		seen,
	};
}
test("synthetic reviewed decision permits A and B source SHA differences with linked alternatives", () => {
	const f = candidateFixture();
	expect(module?.validateCapacityCandidateDecision).toBeFunction();
	expect(() =>
		requireDefined(module).validateCapacityCandidateDecision(f),
	).not.toThrow();
	expect(f.seen).toEqual([
		"evidence/A/raw-queue.json",
		"evidence/A/raw-stock.json",
	]);
});
test.each([
	"one-alternative",
	"orphan-selection",
	"a-digest",
	"unlinked",
	"source",
	"critic-first",
	"decision-before-absence",
	"review-after-create",
	"review-unconditional",
])("candidate decision rejects %s with otherwise affirmative reviews", (change) => {
	const f = candidateFixture();
	if (change === "one-alternative") f.decision.alternatives.pop();
	if (change === "orphan-selection")
		f.decision.selectedAlternativeId = "not-recorded";
	if (change === "a-digest")
		f.decision.aDigests = {
			...f.decision.aDigests,
			attributionArtifactSha256: "6".repeat(64),
		};
	if (change === "unlinked")
		requireDefined(f.decision.alternatives[0]).evidencePaths = [];
	if (change === "source") f.decision.sourceSha = "c".repeat(40);
	if (change === "critic-first")
		f.critic.recordedAt = "2026-09-05T01:01:30.000Z";
	if (change === "decision-before-absence")
		f.decision.recordedAt = "2026-09-05T00:59:00.000Z";
	if (change === "review-after-create")
		f.critic.recordedAt = "2026-09-05T02:01:00.000Z";
	if (change === "review-unconditional") f.critic.unconditional = false;
	f.decisionBytes = JSON.stringify(f.decision);
	f.architect.decisionSha256 = f.critic.decisionSha256 = sha(f.decisionBytes);
	f.critic.afterArchitectReceiptArtifactSha256 = canonicalArtifactSha256(
		f.architect,
	);
	expect(module?.validateCapacityCandidateDecision).toBeFunction();
	expect(() =>
		requireDefined(module).validateCapacityCandidateDecision(f),
	).toThrow();
});

test("prepared proof replay accepts the BOUND binary checkout and rejects a rehashed process-only cwd substitution", async () => {
	for (const wrongCwd of [undefined, "/root/webtransport-bun"]) {
		const f = await completeGoalAdaptersFixture(processFixture().proof, {
			...(wrongCwd === undefined ? {} : { preparedProcessCwd: wrongCwd }),
		});
		roots.push(f.repoRoot);
		expect(
			f.campaignB.bound.hostBinding.authority.hosts.server.binary.path,
		).toBe(
			"/opt/g6/source/crates/native/webtransport-native.linux-x64-gnu.node",
		);
		expect(
			f.campaignB.bound.hostBinding.authority.hosts.generator.binary.path,
		).toBe("/opt/g6/source/target/release/mmo-client");
		const result = api()({
			...f,
			contract: {
				...f.contract,
				pendingAdapters: {
					waiterSafety: requireDefined(f.contract.pendingAdapters).waiterSafety,
				},
			},
		});
		const waiterErrors = result.fatalReasons.filter((reason) =>
			reason.startsWith("waiterSafety:"),
		);
		if (wrongCwd === undefined) expect(waiterErrors).toEqual([]);
		else
			expect(waiterErrors.join("\n")).toContain(
				"prepared Linux process executable",
			);
	}
}, 180000);

test("synthetic complete A/B freezes, work DAGs, prepared raw proofs, decisions and both terminal seals replay all four adapters", async () => {
	const f = await completeGoalAdaptersFixture(processFixture().proof);
	roots.push(f.repoRoot);
	expect(f.campaignA.sourceSha).not.toBe(f.campaignB.sourceSha);
	expect(() => validateCapacityGoalContract(f.contract)).not.toThrow();
	expect(evaluateCapacityGoal(f)).toMatchObject({
		status: "PASS",
		liveTargetStatus: "PASS",
		exitCode: 0,
		reasons: [],
	});
	writeFileSync(
		f.contractPath,
		JSON.stringify({
			...f.contract,
			ladder: {
				...f.contract.ladder,
				runs: f.contract.ladder.runs.slice(0, 6),
			},
		}),
	);
	f.rehash();
	expect(evaluateCapacityGoal(f)).toMatchObject({
		status: "INCOMPLETE",
		liveTargetStatus: "PASS",
		exitCode: 2,
	});
	writeFileSync(f.contractPath, JSON.stringify(f.contract));
	f.rehash();
	// Only the incoming contract's plan claim differs; every raw dependency and
	// the independently verified outer manifest remain byte-for-byte unchanged.
	const manifestBefore = readFileSync(
		join(f.evidenceRoot, "outer-manifest.json"),
	);
	const wrongPlan = {
		...f.contract,
		objective: { ...f.contract.objective, planSha256: "0".repeat(64) },
	};
	expect(() => validateCapacityGoalContract(wrongPlan)).not.toThrow();
	expect(
		api()({ ...f, contract: wrongPlan }).fatalReasons.join("\n"),
	).toContain("B frozen plan digest differs from the contract objective");
	expect(readFileSync(join(f.evidenceRoot, "outer-manifest.json"))).toEqual(
		manifestBefore,
	);
	const diagnosticOnly = {
		...f.contract,
		pendingAdapters: {
			diagnostics: requireDefined(f.contract.pendingAdapters).diagnostics,
		},
	};
	const aRawPath = requireDefined(
		[...f.verified.keys()].find(
			(path) =>
				path.startsWith(f.campaignA.reference.runRoot.slice(9)) &&
				path.includes("/work/"),
		),
	);
	const aRawDigest = requireDefined(f.verified.get(aRawPath));
	f.verified.delete(aRawPath);
	expect(
		api()({ ...f, contract: diagnosticOnly }).fatalReasons.join("\n"),
	).toContain("is not hash-verified");
	f.verified.set(aRawPath, aRawDigest);
	const harnessPath = join(f.repoRoot, "tools/load/g6-c32-work-remote.ts"),
		harnessBytes = readFileSync(harnessPath);
	writeFileSync(
		harnessPath,
		`${harnessBytes.toString()}// Synthetic unsupported harness drift\n`,
	);
	expect(
		api()({ ...f, contract: diagnosticOnly }).fatalReasons.join("\n"),
	).toContain("supported harness");
	writeFileSync(harnessPath, harnessBytes);
	const connectStdout = requireDefined(
		[...f.verified.keys()].find(
			(path) =>
				path.startsWith(f.campaignB.reference.runRoot.slice(9)) &&
				path.includes("prepared-server-connect-probe-proof") &&
				path.endsWith("operation.stdout"),
		),
	);
	const connectPath = join(f.evidenceRoot, connectStdout),
		connectBytes = readFileSync(connectPath);
	writeFileSync(connectPath, JSON.stringify({ passed: true }));
	f.rehash();
	expect(api()(f).fatalReasons.join("\n")).toMatch(
		/pre-sealed bytes changed: operations\/gate-prepared-server-connect-probe-proof\/operation.stdout/,
	);
	writeFileSync(connectPath, connectBytes);
	f.rehash();
	// Provider cleanup may truthfully succeed when controller containment failed.
	// Rebuild all synthetic hashes so this tests semantics, not a digest mismatch.
	expect(f.replaceTerminalEvidence({ controllerExited: false }).status).toBe(
		"TEARDOWN_VERIFIED",
	);
	const incomplete = evaluateCapacityGoal(f);
	expect(incomplete.status).toBe("INCOMPLETE");
	expect(incomplete.reasons.join("\n")).toContain(
		"controller exit is unproven",
	);
	for (const preSeal of [
		{ status: "INCOMPLETE" },
		{ finalGatesComplete: false },
		{ evidenceCollectionComplete: false },
	]) {
		f.replaceTerminalEvidence({
			controllerExited: true,
			preSeal: {
				status: "LADDER_COMPLETE",
				finalGatesComplete: true,
				evidenceCollectionComplete: true,
				...preSeal,
			},
		});
		const rejected = api()({
			...f,
			contract: {
				...f.contract,
				pendingAdapters: {
					waiterSafety: requireDefined(f.contract.pendingAdapters).waiterSafety,
				},
			},
		});
		expect(rejected.fatalReasons.join("\n")).toContain(
			"B pre-destroy campaign seal is incomplete",
		);
	}
}, 360000);
test.each([
	["L40000-1", "C40000-2", "MISS", 1],
	["L40000-2", "C40000-2", "MISS", 1],
	["L50000-2", "C50000-2", "PASS", 0],
] as const)(
	"synthetic raw %s MISS and companion %s MISS complete as goal %s",
	async (missNodeId, companionMissId, expectedStatus, exitCode) => {
		const f = await completeGoalAdaptersFixture(processFixture().proof, {
			bOutcomes: { [missNodeId]: "MISS", [companionMissId]: "MISS" },
		});
		roots.push(f.repoRoot);
		expect(
			Object.keys(requireDefined(f.contract.pendingAdapters)),
		).toHaveLength(4);
		expect(evaluateCapacityGoal(f)).toMatchObject({
			status: expectedStatus,
			liveTargetStatus: expectedStatus,
			exitCode,
			reasons: [],
		});
		if (missNodeId === "L40000-1") {
			for (const ladder of [
				{
					...f.contract.ladder,
					runs: f.contract.ladder.runs.filter(
						(run) => run.label !== "L30000-2",
					),
				},
				{
					...f.contract.ladder,
					companions: requireDefined(f.contract.ladder.companions).slice(0, 1),
				},
			]) {
				// Rehash the incoming contract while retaining every other valid raw
				// artifact: required raw bindings cannot be omitted from final replay.
				writeFileSync(
					f.contractPath,
					JSON.stringify({ ...f.contract, ladder }),
				);
				f.rehash();
				const rejected = evaluateCapacityGoal(f);
				expect(rejected).toMatchObject({ status: "INCOMPLETE", exitCode: 2 });
				expect(rejected.reasons.join("\n")).toMatch(
					/required lower-rung repeat|ordered raw companion cells/,
				);
			}
		}
	},
	360000,
);
test("synthetic raw INVALID 40k measurement remains incomplete with all adapters present", async () => {
	const f = await completeGoalAdaptersFixture(processFixture().proof, {
		bOutcomes: { "L40000-1": "INVALID" },
	});
	roots.push(f.repoRoot);
	expect(Object.keys(requireDefined(f.contract.pendingAdapters))).toHaveLength(
		4,
	);
	expect(f.campaignB.final.terminal).toBe("INCOMPLETE");
	const rejected = evaluateCapacityGoal(f);
	expect(rejected).toMatchObject({ status: "INCOMPLETE", exitCode: 2 });
	expect(rejected.reasons.join("\n")).toContain(
		"B pre-destroy campaign seal is incomplete",
	);
}, 240000);
test("synthetic first-5k MISS requires complete raw evidence but no lower repeat or companions", async () => {
	// The work CLI launches only profiles that name their datagram read path,
	// so this real-CLI replay runs on the r5 (C-PUMP) A'/B lifecycle.
	const f = await completeGoalAdaptersFixture(processFixture().proof, {
		bOutcomes: { "L5000-1": "MISS" },
		realProducerSources: true,
		r5: {},
	});
	roots.push(f.repoRoot);
	expect(Object.keys(requireDefined(f.contract.pendingAdapters))).toHaveLength(
		4,
	);
	expect(f.campaignB.final.completed).toEqual([
		{ nodeId: "L5000-1", outcome: "MISS" },
	]);
	expect(f.campaignB.final.terminal).toBe("LADDER_COMPLETE");
	expect(f.contract.ladder.runs.map((run) => run.label)).toEqual(["L5000-1"]);
	expect(f.contract.ladder.companions).toEqual([]);
	const firstRun = requireDefined(f.contract.ladder.runs[0]);
	const scanPath = join(f.evidenceRoot, firstRun.scanPath);
	const scan: unknown = JSON.parse(readFileSync(scanPath, "utf8"));
	expect(scan).toMatchObject({
		clientExit: 0,
		aggregate: { steady: { rxTotal: Math.floor(5000 * 4 * 120 * 0.994) } },
	});
	expect(evaluateCapacityGoal(f)).toMatchObject({
		status: "MISS",
		liveTargetStatus: "MISS",
		exitCode: 1,
		reasons: [],
	});
	const b = f.campaignB;
	// Execute the real CLI against this actual synthetic BIND. Only the wall
	// clock is controlled; source hashing and the live BIND verifier are real.
	const cliRoot = mkdtempSync(join(tmpdir(), "g6-bound-cli-init-"));
	roots.push(cliRoot);
	mkdirSync(join(cliRoot, "qualification"));
	for (const name of ["setup.receipt.json", "setup.stdout", "setup.stderr"])
		writeFileSync(
			join(cliRoot, "qualification", name),
			readFileSync(join(b.workRoot, "qualification", name)),
		);
	const setup = validateOperationReceipt(
		JSON.parse(
			readFileSync(join(cliRoot, "qualification/setup.receipt.json"), "utf8"),
		),
	);
	writeFileSync(
		join(cliRoot, "active-ledger.json"),
		JSON.stringify(b.ledger.filter((entry) => entry.event === "CREATE_INTENT")),
	);
	const statePath = join(b.workRoot, "work-execution.json"),
		originalState = readFileSync(statePath),
		state = syntheticRecord(JSON.parse(originalState.toString()));
	try {
		setSystemTime(new Date(setup.finishedAt));
		const progress = await runWorkCli([
			"init",
			"--root",
			cliRoot,
			"--policy",
			join(f.repoRoot, b.reference.policyPath),
			"--ledger",
			join(cliRoot, "active-ledger.json"),
			"--deadline",
			String(state.deadline),
			"--candidate",
			b.sourceSha,
			"--registration",
			b.registration,
			"--setup-receipt",
			"qualification/setup.receipt.json",
			"--bound-root",
			b.bound.root,
			"--repository",
			f.repoRoot,
		]);
		expect(progress).toMatchObject({
			schema: "g6-c32-work-next/1",
			node: { id: "L5000-1" },
		});
		expect(readWorkAuthority(cliRoot)).toEqual(b.workAuthority);
	} finally {
		setSystemTime();
	}
	const node = requireDefined(
			b.policy.workPlan.nodes.find((node) => node.id === "L5000-1"),
		),
		profile = requireDefined(b.policy.workProfiles[node.profile]),
		readRaw = () =>
			readWorkCellEvidence(b.workRoot, node, profile, b.workAuthority),
		originalScan = readFileSync(scanPath),
		short = readRaw();
	requireDefined(
		requireDefined(requireDefined(short.scan.shards[0]).windows).steady,
	).wallMs = 119000;
	writeFileSync(scanPath, JSON.stringify(short.scan));
	const online = gradeWorkCell(readRaw());
	expect(online.outcome).toBe("INVALID");
	expect(online.reasons.join("\n")).toContain("rated window");
	// Rehash the entire synthetic cell and terminal closure, leaving the stored
	// measured-MISS grade unchanged: final replay must reject the same raw bytes.
	f.resealWorkEvidence();
	const shortFinal = evaluateCapacityGoal(f);
	expect(shortFinal).toMatchObject({ status: "INCOMPLETE", exitCode: 2 });
	expect(shortFinal.reasons.join("\n")).toContain("rated window");
	writeFileSync(scanPath, originalScan);
	const authorityPath = join(b.workRoot, "work-authority.json"),
		originalAuthority = readFileSync(authorityPath),
		forged = {
			...b.workAuthority,
			dispatchFreezeArtifactSha256: "f".repeat(64),
		};
	expect(() => validateWorkAuthority(forged)).not.toThrow();
	writeFileSync(authorityPath, JSON.stringify(forged));
	state.authority = {
		path: "work-authority.json",
		sha256: sha(readFileSync(authorityPath)),
	};
	writeFileSync(statePath, JSON.stringify(state));
	f.resealWorkEvidence();
	const swapped = evaluateCapacityGoal(f);
	expect(swapped).toMatchObject({ status: "INCOMPLETE", exitCode: 2 });
	expect(swapped.reasons.join("\n")).toContain(
		"B execution capsule differs from independently verified BOUND authority",
	);
	writeFileSync(authorityPath, originalAuthority);
	writeFileSync(statePath, originalState);
	f.resealWorkEvidence();
	// Remove actual raw evidence, retaining the contract and inner seals. A fresh
	// outer manifest cannot make the missing measurement a completed result.
	rmSync(scanPath);
	f.rehash();
	const missing = evaluateCapacityGoal(f);
	expect(missing).toMatchObject({ status: "INCOMPLETE", exitCode: 2 });
	expect(missing.reasons.join("\n")).toContain("g6-sharded-scan.json");
}, 360000);
test("synthetic first-5k raw INVALID remains incomplete with all adapters present", async () => {
	const f = await completeGoalAdaptersFixture(processFixture().proof, {
		bOutcomes: { "L5000-1": "INVALID" },
	});
	roots.push(f.repoRoot);
	expect(Object.keys(requireDefined(f.contract.pendingAdapters))).toHaveLength(
		4,
	);
	expect(f.campaignB.final.completed).toEqual([
		{ nodeId: "L5000-1", outcome: "INVALID" },
	]);
	expect(f.campaignB.final.terminal).toBe("INCOMPLETE");
	expect(f.contract.ladder.runs.map((run) => run.label)).toEqual(["L5000-1"]);
	expect(f.contract.ladder.companions).toEqual([]);
	const firstRun = requireDefined(f.contract.ladder.runs[0]);
	const scan: unknown = JSON.parse(
		readFileSync(join(f.evidenceRoot, firstRun.scanPath), "utf8"),
	);
	expect(scan).toMatchObject({ clientExit: 1 });
	const rejected = evaluateCapacityGoal(f);
	expect(rejected).toMatchObject({ status: "INCOMPLETE", exitCode: 2 });
	expect(rejected.reasons.join("\n")).toContain(
		"B pre-destroy campaign seal is incomplete",
	);
}, 180000);
test("synthetic completed /2 replay rejects rehashed absent, stale, wrong-pair, reversed and post-launch host reviews", async () => {
	const f = await completeGoalAdaptersFixture(processFixture().proof);
	roots.push(f.repoRoot);
	const root = join(f.repoRoot, f.campaignB.reference.runRoot);
	const { architect, critic } = verifyCapacityHostReviews({
		reviewRoot: join(root, "host-reviews"),
		context: contextFromBound(f.campaignB.bound),
		now: new Date(
			Date.parse(f.campaignB.bound.dispatchFreeze.envelope.recordedAt) + 2999,
		).toISOString(),
	});
	const waiterOnly = {
		...f,
		contract: {
			...f.contract,
			pendingAdapters: {
				waiterSafety: requireDefined(f.contract.pendingAdapters).waiterSafety,
			},
		},
	};
	for (const change of [
		"absent",
		"stale",
		"wrong-pair",
		"reversed",
		"simultaneous",
		"post-launch",
		"post-intent",
	] as const) {
		let nextArchitect = structuredClone(architect),
			nextCritic = structuredClone(critic);
		if (change === "stale")
			nextCritic = {
				...nextCritic,
				reviewedAt: new Date(
					Date.parse(critic.context.boundAt) - 1,
				).toISOString(),
			};
		if (change === "wrong-pair") {
			const wrongContext = {
				...nextArchitect.context,
				hostBindingArtifactSha256: canonicalArtifactSha256(
					f.campaignA.bound.hostBinding,
				),
			};
			nextArchitect = { ...nextArchitect, context: wrongContext };
			nextCritic = { ...nextCritic, context: wrongContext };
		}
		if (change === "reversed" || change === "simultaneous")
			nextCritic = {
				...nextCritic,
				reviewedAt: new Date(
					Date.parse(architect.reviewedAt) - (change === "reversed" ? 1 : 0),
				).toISOString(),
			};
		// Both late cases still precede the first load cell at B offset +120s.
		if (change === "post-launch" || change === "post-intent")
			nextCritic = {
				...nextCritic,
				reviewedAt: new Date(
					Date.parse(critic.reviewedAt) +
						(change === "post-launch" ? 1500 : 1100),
				).toISOString(),
			};
		nextCritic = {
			...nextCritic,
			afterArchitectArtifactSha256: canonicalArtifactSha256(nextArchitect),
		};
		expect(
			f.replaceHostReviewEvidence({
				"architect.json": nextArchitect,
				"critic.json": change === "absent" ? null : nextCritic,
			}).status,
		).toBe("TEARDOWN_VERIFIED");
		const result = api()(waiterOnly);
		expect(
			result.fatalReasons.some(
				(reason) =>
					reason.startsWith("waiterSafety:") && reason.includes("host-review"),
			),
		).toBe(true);
		if (change === "absent") {
			const complete = evaluateCapacityGoal(f);
			expect(complete.status).toBe("INCOMPLETE");
			expect(complete.reasons.join("\n")).toContain("host-review");
		}
	}
	f.replaceHostReviewEvidence({
		"architect.json": architect,
		"critic.json": critic,
	});
	expect(
		api()(waiterOnly).fatalReasons.some((reason) =>
			reason.startsWith("waiterSafety:"),
		),
	).toBe(false);
}, 300000);

test("synthetic Linux process proof replays raw launchers, owners, supervisor exits and cleanup commands", () => {
	expect(module?.validateCapacityLinuxProcessProof).toBeFunction();
	const f = processFixture();
	expect(() =>
		requireDefined(module).validateCapacityLinuxProcessProof(
			f.proof,
			f.expected,
		),
	).not.toThrow();
});
test.each([
	"mac",
	"boot",
	"harness",
	"order",
	"naked-pass",
	"raw-exit",
	"unreaped",
	"descendant",
	"cleanup-command",
	"overwritten-owner",
])("Linux proof rejects %s while all stored pass flags remain true", (change) => {
	const f = processFixture();
	if (change === "mac") f.proof.platform = "darwin";
	if (change === "boot")
		f.proof.bootId = "22222222-2222-4222-8222-222222222222";
	if (change === "harness") f.proof.workRemoteSourceSha256 = "d".repeat(64);
	if (change === "order") f.proof.cases.reverse();
	if (change === "naked-pass")
		requireDefined(f.proof.cases[2]).launch.stdout = "PASS";
	if (change === "raw-exit")
		requireDefined(f.proof.cases[2]).launch.exitCode = 0;
	if (change === "unreaped")
		requireDefined(f.proof.cases[2]).launch.stdout = requireDefined(
			f.proof.cases[2],
		).launch.stdout.replace('"remainingChildren":0', '"remainingChildren":1');
	if (change === "descendant")
		requireDefined(f.proof.cases[4]).liveChildStatRaw = requireDefined(
			requireDefined(f.proof.cases[4]).liveChildStatRaw,
		).replace("20000", "20001");
	if (change === "cleanup-command")
		requireDefined(requireDefined(f.proof.cases[4]).cleanup).argv = ["true"];
	if (change === "overwritten-owner")
		requireDefined(f.proof.cases[4]).ownerAfterRaw = "{}";
	expect(module?.validateCapacityLinuxProcessProof).toBeFunction();
	expect(() =>
		requireDefined(module).validateCapacityLinuxProcessProof(
			f.proof,
			f.expected,
		),
	).toThrow();
});

test("accepted completion prefixes preserve required lower repeats, companions and the 50k suffix", () => {
	const allPass = [
		"L5000-1",
		"L10000-1",
		"L20000-1",
		"L30000-1",
		"L40000-1",
		"L40000-2",
		"L50000-1",
		"L50000-2",
	].map((nodeId) => ({ nodeId, outcome: "PASS" as const }));
	const miss = [
		...allPass.slice(0, -1),
		{ nodeId: "L50000-2", outcome: "MISS" as const },
		{ nodeId: "C50000-1", outcome: "PASS" as const },
		{ nodeId: "C50000-2", outcome: "PASS" as const },
	];
	const belowTarget = [
		...allPass.slice(0, 4),
		{ nodeId: "L40000-1", outcome: "MISS" as const },
		{ nodeId: "L30000-2", outcome: "PASS" as const },
		{ nodeId: "C40000-1", outcome: "PASS" as const },
		{ nodeId: "C40000-2", outcome: "MISS" as const },
	];
	expect(module?.assertCapacityCompletionPrefix).toBeFunction();
	for (const completed of [allPass, miss, belowTarget])
		expect(() =>
			requireDefined(module).assertCapacityCompletionPrefix(
				makeCapacityLadderWorkPlan(),
				completed,
			),
		).not.toThrow();
	for (const completed of [
		miss.slice(0, -1),
		allPass.slice(0, 6),
		allPass.filter((row) => row.nodeId !== "L40000-2"),
		[...allPass, requireDefined(allPass[0])],
		[...allPass.slice(0, 4), { nodeId: "L40000-1", outcome: "MISS" as const }],
		belowTarget.filter((row) => row.nodeId !== "L30000-2"),
		belowTarget.map((row) =>
			row.nodeId === "L30000-2" ? { ...row, outcome: "MISS" as const } : row,
		),
		belowTarget.map((row) =>
			row.nodeId === "C40000-2" ? { ...row, outcome: "INVALID" as const } : row,
		),
	])
		expect(() =>
			requireDefined(module).assertCapacityCompletionPrefix(
				makeCapacityLadderWorkPlan(),
				completed,
			),
		).toThrow();
});
