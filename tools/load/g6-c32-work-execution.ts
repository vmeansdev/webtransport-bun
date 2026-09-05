/** Durable /2 progress: the DAG advances only through reverified raw cell evidence. */
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
	type BudgetPolicy,
	budgetPolicyArtifactSha256,
	type SpendLedgerEntry,
	spendLedgerEntryArtifactSha256,
	validateBudgetPolicy,
	validateSpendLedger,
} from "./g6-c32-budget.ts";
import { executionCutoff } from "./g6-c32-execution-clock.ts";
import {
	canonicalArtifactSha256,
	requireDefined,
	validateOperationReceipt,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import {
	gradeWorkCell,
	type WorkGrade,
	type WorkGradeInput,
} from "./g6-c32-work-grade.ts";
import type { WorkNode, WorkStep, WorkTarget } from "./g6-c32-work-plan.ts";
import type { WorkProfile } from "./g6-c32-work-profile.ts";
import {
	readWorkAuthority,
	validateWorkAuthority,
	type WorkAuthority,
} from "./g6-capacity-work-authority.ts";
import type { RungScan } from "./g6-sharded-grade.ts";

type FileBinding = { path: string; sha256: string };
type WorkPolicy = Extract<BudgetPolicy, { schema: "g6-c32-budget-policy/2" }>;
type WorkState = {
	schema: "g6-c32-work-execution/1";
	policySha256: string;
	candidateSha: string;
	registrationSha256: string;
	nativeProducerSha256: string;
	probeProducerSha256: string;
	deadline: string;
	setupReceipt: FileBinding;
	authority: FileBinding;
};
type Start = {
	schema: "g6-c32-work-cell-start/1";
	nodeId: string;
	policySha256: string;
	startedAt: string;
	startedMonotonicNs: string;
	cutoffAt: string;
	previousCompletionSha256: string | null;
};
type Completion = {
	schema: "g6-c32-work-cell-completion/1";
	nodeId: string;
	policySha256: string;
	startedAt: string;
	finishedAt: string;
	durationMonotonicNs: string;
	previousCompletionSha256: string | null;
	grade: WorkGrade;
	files: FileBinding[];
};
type CellAdmission = {
	schema: "g6-c32-cell-admission/2";
	decision: "ADMIT";
	nextNodeId: string;
	budgetPolicySha256: string;
	recordedAt: string;
	ledgerEntryArtifactSha256: string;
};
type Context = {
	root: string;
	policy: BudgetPolicy;
	ledger: readonly SpendLedgerEntry[];
	now: string;
};
type VerifiedScanPrefix = {
	sequence: number;
	finishedAt: string;
	startedAts: readonly string[];
};
export type WorkFinal = {
	schema: "g6-c32-work-final/1";
	recordedAt: string;
	policySha256: string;
	lifecycle: WorkPolicy["lifecycle"];
	terminal: "ATTRIBUTION_COMPLETE" | "LADDER_COMPLETE" | "INCOMPLETE";
	completed: WorkStep[];
	controlUsedSeconds: number;
	elapsedPaidSeconds: number;
};
function fail(message: string): never {
	throw Error(`g6-c32-work-execution: ${message}`);
}
function object(value: unknown, keys: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		fail("missing or unknown evidence fields");
	return value as Record<string, unknown>;
}
function millis(value: string) {
	return Date.parse(validateRfc3339Millis(value, "work timestamp"));
}
function sha(bytes: string | Buffer) {
	return createHash("sha256").update(bytes).digest("hex");
}
function pathIn(root: string, path: string): string {
	if (
		!path ||
		path.includes("\\") ||
		path
			.split("/")
			.some((piece) => !piece || piece === "." || piece === "..") ||
		path.startsWith("/")
	)
		fail("unsafe evidence path");
	const base = realpathSync(root),
		absolute = resolve(base, path);
	let current = base;
	for (const piece of path.split("/")) {
		current = join(current, piece);
		if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
			fail("symlink evidence");
	}
	if (!absolute.startsWith(`${base}${sep}`)) fail("evidence escaped root");
	return absolute;
}
function readWorkBytes(
	root: string,
	path: string,
	maximumBytes = 256 * 1024 * 1024,
): Buffer {
	const absolute = pathIn(root, path),
		retainedBefore = lstatSync(absolute);
	if (!retainedBefore.isFile() || retainedBefore.size > maximumBytes)
		fail("non-file or excessive evidence");
	const fd = openSync(
		absolute,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd);
		if (
			!before.isFile() ||
			before.size > maximumBytes ||
			before.dev !== retainedBefore.dev ||
			before.ino !== retainedBefore.ino
		)
			fail("non-file or excessive evidence");
		// A growth race must not turn the size check into an unbounded read.
		const bytes = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < bytes.length) {
			const count = readSync(fd, bytes, length, bytes.length - length, null);
			if (count === 0) break;
			length += count;
		}
		const after = fstatSync(fd),
			retained = lstatSync(pathIn(root, path));
		if (
			length !== before.size ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			retained.dev !== before.dev ||
			retained.ino !== before.ino ||
			realpathSync(absolute) !== absolute
		)
			fail("evidence changed during bounded read");
		return bytes.subarray(0, length);
	} finally {
		closeSync(fd);
	}
}
export function readWorkJson(root: string, path: string): unknown {
	return JSON.parse(readWorkBytes(root, path).toString("utf8"));
}
export function writeWorkJson(
	root: string,
	path: string,
	value: unknown,
): void {
	const absolute = pathIn(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	const fd = openSync(absolute, "wx", 0o600);
	try {
		writeFileSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	const parent = openSync(dirname(absolute), "r");
	try {
		fsyncSync(parent);
	} finally {
		closeSync(parent);
	}
}
function binding(root: string, path: string): FileBinding {
	return { path, sha256: sha(readWorkBytes(root, path)) };
}
function verifyBinding(root: string, value: FileBinding): void {
	object(value, ["path", "sha256"]);
	if (
		typeof value.path !== "string" ||
		typeof value.sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.sha256) ||
		binding(root, value.path).sha256 !== value.sha256
	)
		fail(`artifact digest changed: ${value.path}`);
}
function policyContext(input: Context): WorkPolicy {
	const policy = validateBudgetPolicy(input.policy);
	if (policy.schema !== "g6-c32-budget-policy/2")
		fail("execution requires policy/2");
	const ledger = validateSpendLedger(input.ledger, {
		requireSeal: false,
	}).entries;
	if (
		ledger.at(-1)?.event === "SEAL" ||
		ledger.some(
			(entry) =>
				entry.budgetPolicySha256 !== budgetPolicyArtifactSha256(policy) ||
				entry.campaignId !== policy.campaignId ||
				entry.runId !== policy.runId,
		)
	)
		fail("ledger does not bind this active policy");
	return policy;
}
function authorityMatches(
	authority: WorkAuthority,
	policy: WorkPolicy,
	fields: Pick<
		WorkState,
		| "candidateSha"
		| "registrationSha256"
		| "nativeProducerSha256"
		| "probeProducerSha256"
	>,
): void {
	if (
		authority.runId !== policy.runId ||
		authority.policySha256 !== budgetPolicyArtifactSha256(policy) ||
		authority.candidateSha !== fields.candidateSha ||
		authority.registrationSha256 !== fields.registrationSha256 ||
		authority.nativeProducerSha256 !== fields.nativeProducerSha256 ||
		authority.probeProducerSha256 !== fields.probeProducerSha256
	)
		fail("execution authority mismatch");
}
function stateOf(input: Context, policy: WorkPolicy) {
	const state = object(readWorkJson(input.root, "work-execution.json"), [
		"schema",
		"policySha256",
		"candidateSha",
		"registrationSha256",
		"nativeProducerSha256",
		"probeProducerSha256",
		"deadline",
		"setupReceipt",
		"authority",
	]) as WorkState;
	if (
		state.schema !== "g6-c32-work-execution/1" ||
		state.policySha256 !== budgetPolicyArtifactSha256(policy) ||
		!/^[0-9a-f]{40}$/.test(state.candidateSha) ||
		![
			state.registrationSha256,
			state.nativeProducerSha256,
			state.probeProducerSha256,
		].every((hash) => /^[0-9a-f]{64}$/.test(hash))
	)
		fail("execution authority mismatch");
	millis(state.deadline);
	verifyBinding(input.root, state.setupReceipt);
	if (state.authority?.path !== "work-authority.json")
		fail("execution authority must bind work-authority.json");
	verifyBinding(input.root, state.authority);
	const authority = readWorkAuthority(input.root);
	verifyBinding(input.root, state.authority);
	authorityMatches(authority, policy, state);
	return { state, authority };
}
export function initializeWorkExecution(
	input: Context & {
		deadline: string;
		candidateSha: string;
		registrationSha256: string;
		nativeProducerSha256: string;
		probeProducerSha256: string;
		setupReceiptPath: string;
		authority: WorkAuthority;
	},
): void {
	const policy = policyContext(input),
		authority = validateWorkAuthority(input.authority),
		setup = validateOperationReceipt(
			readWorkJson(input.root, input.setupReceiptPath),
		);
	authorityMatches(authority, policy, input);
	const clock = executionCutoff({
		plan: policy.workPlan,
		entries: input.ledger,
		deadline: input.deadline,
		now: input.now,
		setupComplete: false,
	});
	if (
		!clock.paidStartAt ||
		clock.expired ||
		setup.envelope.runId !== policy.runId ||
		setup.envelope.operationId !== "work-setup" ||
		setup.status.outcome !== "SUCCEEDED" ||
		setup.status.exitCode !== 0 ||
		millis(setup.finishedAt) > millis(input.now) ||
		millis(setup.startedAt) < millis(clock.paidStartAt)
	)
		fail("setup lacks timely successful owned receipt");
	// Exclusive publication prevents replay from replacing an earlier capsule.
	writeWorkJson(input.root, "work-authority.json", authority);
	const state: WorkState = {
		schema: "g6-c32-work-execution/1",
		policySha256: budgetPolicyArtifactSha256(policy),
		candidateSha: input.candidateSha,
		registrationSha256: input.registrationSha256,
		nativeProducerSha256: input.nativeProducerSha256,
		probeProducerSha256: input.probeProducerSha256,
		deadline: input.deadline,
		setupReceipt: binding(input.root, input.setupReceiptPath),
		authority: binding(input.root, "work-authority.json"),
	};
	writeWorkJson(input.root, "work-execution.json", state);
}
function startOf(root: string, node: WorkNode, policySha256: string): Start {
	const start = object(readWorkJson(root, `work/${node.id}/start.json`), [
		"schema",
		"nodeId",
		"policySha256",
		"startedAt",
		"startedMonotonicNs",
		"cutoffAt",
		"previousCompletionSha256",
	]) as Start;
	if (
		start.schema !== "g6-c32-work-cell-start/1" ||
		start.nodeId !== node.id ||
		start.policySha256 !== policySha256 ||
		!/^(0|[1-9][0-9]*)$/.test(start.startedMonotonicNs) ||
		millis(start.cutoffAt) !==
			millis(start.startedAt) + node.maximumSeconds * 1000
	)
		fail("cell start binding mismatch");
	return start;
}
/** Load exact retained raw bytes; lifecycle/prefix checks remain with execution. */
export function readWorkCellEvidence(
	root: string,
	node: WorkNode,
	profile: WorkProfile,
	authority: WorkAuthority,
): WorkGradeInput {
	const prefix = `work/${node.id}`,
		text = (name: string) =>
			readWorkBytes(root, `${prefix}/${name}`, 128 * 1024 * 1024).toString(
				"utf8",
			),
		json = (name: string) => readWorkJson(root, `${prefix}/${name}`);
	const bufferOperations: WorkGradeInput["bufferOperations"] = {};
	for (const suffix of [
		"apply-buffer",
		"apply-buffer-generator",
		...(profile.serverUdpSendBufferBytes > 0 ? ["apply-server-sndbuf"] : []),
	]) {
		bufferOperations[suffix] = {
			receipt: json(`${suffix}.receipt.json`),
			stdout: text(`${suffix}.stdout`),
			stderr: text(`${suffix}.stderr`),
		};
	}
	return {
		runId: authority.runId,
		pair: authority.pair,
		node,
		profile,
		scan: json("g6-sharded-scan.json") as RungScan,
		diagnostic: json("g6-sharded-diagnostic.json"),
		postRunSteeringText: text("post-run-steering.json"),
		// Pass actual retained evidence, including unexpected probe-off output.
		// The shared validator decides whether absence/presence matches the profile.
		probe: existsSync(pathIn(root, `${prefix}/linux-probe.jsonl`))
			? text("linux-probe.jsonl")
			: null,
		expectCandidate: authority.candidateSha,
		registrationSha256: authority.registrationSha256,
		nativeProducerSha256: authority.nativeProducerSha256,
		probeProducerSha256: authority.probeProducerSha256,
		operation: validateOperationReceipt(json("scan.receipt.json")),
		scanStdout: text("scan.stdout"),
		scanStderr: text("scan.stderr"),
		owners: {
			server: json("scan-owner.json"),
			generator: json("generator-owner.json"),
		},
		bufferOperations,
	};
}
function rawGrade(
	input: Context,
	state: WorkState,
	authority: WorkAuthority,
	policy: WorkPolicy,
	node: WorkNode,
	verifiedPrefix: VerifiedScanPrefix,
): { grade: WorkGrade; scanPrefix: VerifiedScanPrefix } {
	const raw = readWorkCellEvidence(
			input.root,
			node,
			requireDefined(policy.workProfiles[node.profile]),
			authority,
		),
		operation = validateOperationReceipt(raw.operation),
		start = startOf(input.root, node, state.policySha256);
	if (
		operation.envelope.runId !== policy.runId ||
		operation.envelope.operationId !== `${node.id}-scan` ||
		operation.attempt !== 1 ||
		millis(operation.startedAt) < millis(start.startedAt) ||
		BigInt(operation.durationMonotonicNs) >
			BigInt(node.maximumSeconds) * 1_000_000_000n ||
		millis(operation.finishedAt) >
			Math.min(millis(input.now), millis(start.cutoffAt))
	)
		fail("raw scan operation does not bind this timely owned cell");
	const scanStartedAt = validateRfc3339Millis(
		(raw.scan as RungScan & { startedAt?: unknown })?.startedAt,
		"raw scan startedAt",
	);
	if (
		operation.envelope.sequence <= verifiedPrefix.sequence ||
		millis(operation.startedAt) < millis(verifiedPrefix.finishedAt) ||
		verifiedPrefix.startedAts.includes(scanStartedAt)
	)
		fail(
			"raw scan conflicts with the verified prefix sequence, interval or start identity",
		);
	return {
		grade: gradeWorkCell(raw),
		scanPrefix: {
			sequence: operation.envelope.sequence,
			finishedAt: operation.finishedAt,
			startedAts: [...verifiedPrefix.startedAts, scanStartedAt],
		},
	};
}
function cellFiles(root: string, node: WorkNode): FileBinding[] {
	const directory = pathIn(root, `work/${node.id}`),
		result: FileBinding[] = [];
	for (const name of readdirSync(directory).sort()) {
		if (name === "completion.json") continue;
		const path = `work/${node.id}/${name}`;
		if (!lstatSync(pathIn(root, path)).isFile())
			fail("unexpected nested/non-file cell artifact");
		result.push(binding(root, path));
	}
	if (result.length > 128) fail("too many cell artifacts");
	return result;
}
function verifyOperations(
	input: Context,
	policy: WorkPolicy,
	node: WorkNode,
	start: Start,
	finishedAt: string,
	files: FileBinding[],
) {
	const profile = requireDefined(policy.workProfiles[node.profile]),
		prefix = `work/${node.id}`;
	const seal = object(readWorkJson(input.root, `${prefix}/cell-seal.json`), [
		"schema",
		"nodeId",
		"files",
	]);
	const sealedFiles = files.filter(
		(file) =>
			![
				"cell-seal.json",
				"seal.stdout",
				"seal.stderr",
				"seal.receipt.json",
			].some((name) => file.path === `${prefix}/${name}`),
	);
	if (
		seal.schema !== "g6-c32-work-cell-seal/1" ||
		seal.nodeId !== node.id ||
		canonicalArtifactSha256(seal.files) !== canonicalArtifactSha256(sealedFiles)
	)
		fail("raw cell seal does not cover exact stable artifact set");
	const required = [
		"remote-mkdir",
		"apply-gro",
		"bpf-repin",
		"scan",
		"copy",
		"evaluate",
		"restore-gro",
		"seal",
		"apply-buffer",
		"apply-buffer-generator",
		"restore-buffer",
		"restore-buffer-generator",
	];
	if (profile.serverUdpSendBufferBytes > 0)
		required.push("apply-server-sndbuf", "restore-server-sndbuf");
	let previous = 0;
	const operations = files
		.filter((file) => file.path.endsWith(".receipt.json"))
		.map((file) =>
			validateOperationReceipt(readWorkJson(input.root, file.path)),
		)
		.sort((a, b) => a.envelope.sequence - b.envelope.sequence);
	for (const op of operations) {
		if (
			op.envelope.runId !== policy.runId ||
			op.envelope.sequence <= previous ||
			op.attempt !== 1 ||
			op.status.outcome !== "SUCCEEDED" ||
			op.status.exitCode !== 0 ||
			op.status.signal !== null ||
			millis(op.startedAt) < millis(start.startedAt) ||
			millis(op.finishedAt) > millis(finishedAt)
		)
			fail("cell operation failed, retried, or outside whole-cell interval");
		previous = op.envelope.sequence;
		for (const stream of [op.stdoutPath, op.stderrPath])
			if (!files.some((file) => file.path === stream))
				fail("operation stream is not sealed with cell");
	}
	for (const name of required)
		if (!files.some((file) => file.path === `${prefix}/${name}.receipt.json`))
			fail(`missing cell operation ${name}`);
	const scan = operations.find(
			(op) => op.envelope.operationId === `${node.id}-scan`,
		),
		grade = operations.find(
			(op) => op.envelope.operationId === `${node.id}-evaluate`,
		),
		sealOp = operations.find(
			(op) => op.envelope.operationId === `${node.id}-seal`,
		);
	if (
		!scan ||
		!grade ||
		!sealOp ||
		scan.envelope.sequence >= grade.envelope.sequence ||
		grade.envelope.sequence >= sealOp.envelope.sequence
	)
		fail("cell operation sequence is incomplete");
	const admission = object(
		readWorkJson(input.root, `${prefix}/admission.json`),
		[
			"schema",
			"decision",
			"nextNodeId",
			"budgetPolicySha256",
			"recordedAt",
			"ledgerEntryArtifactSha256",
		],
	) as CellAdmission;
	if (
		admission.schema !== "g6-c32-cell-admission/2" ||
		admission.decision !== "ADMIT" ||
		admission.nextNodeId !== node.id ||
		admission.budgetPolicySha256 !== start.policySha256 ||
		millis(admission.recordedAt) < millis(start.startedAt) ||
		millis(admission.recordedAt) > millis(scan.startedAt)
	)
		fail("cell admission binding differs");
	const entry = input.ledger.find(
		(entry) =>
			spendLedgerEntryArtifactSha256(entry) ===
			admission.ledgerEntryArtifactSha256,
	);
	if (
		!entry ||
		entry.event !== "CELL_ADMISSION" ||
		entry.decision !== "ADMIT" ||
		entry.recordedAt !== admission.recordedAt
	)
		fail("cell admission not in verified spend ledger");
}

export function readWorkExecution(input: Context) {
	const policy = policyContext(input),
		{ state, authority } = stateOf(input, policy),
		setup = validateOperationReceipt(
			readWorkJson(input.root, state.setupReceipt.path),
		);
	const clock = executionCutoff({
		plan: policy.workPlan,
		entries: input.ledger,
		deadline: state.deadline,
		now: input.now,
		setupComplete: true,
	});
	if (
		!clock.paidStartAt ||
		setup.envelope.runId !== policy.runId ||
		setup.envelope.operationId !== "work-setup" ||
		setup.status.exitCode !== 0 ||
		millis(setup.finishedAt) > millis(input.now) ||
		millis(setup.finishedAt) - millis(clock.paidStartAt) >
			policy.workPlan.setupMaximumSeconds * 1000
	)
		fail("invalid setup interval");
	let current: WorkTarget = policy.workPlan.entry,
		previousCompletionSha256: string | null = null,
		previousFinish = millis(setup.finishedAt),
		cellsMs = 0;
	let scanPrefix: VerifiedScanPrefix = {
		sequence: setup.envelope.sequence,
		finishedAt: setup.finishedAt,
		startedAts: [],
	};
	const completed: WorkStep[] = [],
		completions: Completion[] = [];
	while (typeof current === "string") {
		const node = requireDefined(
			policy.workPlan.nodes.find((node) => node.id === current),
		);
		if (!existsSync(pathIn(input.root, `work/${node.id}/completion.json`)))
			break;
		const completion = object(
			readWorkJson(input.root, `work/${node.id}/completion.json`),
			[
				"schema",
				"nodeId",
				"policySha256",
				"startedAt",
				"finishedAt",
				"durationMonotonicNs",
				"previousCompletionSha256",
				"grade",
				"files",
			],
		) as Completion;
		const start = startOf(input.root, node, state.policySha256);
		if (
			completion.schema !== "g6-c32-work-cell-completion/1" ||
			completion.nodeId !== node.id ||
			completion.policySha256 !== state.policySha256 ||
			completion.startedAt !== start.startedAt ||
			start.previousCompletionSha256 !== previousCompletionSha256 ||
			completion.previousCompletionSha256 !== previousCompletionSha256
		)
			fail("completion skipped or replayed prefix");
		const duration = millis(completion.finishedAt) - millis(start.startedAt);
		if (
			duration < 0 ||
			duration > node.maximumSeconds * 1000 ||
			millis(start.startedAt) < previousFinish ||
			millis(completion.finishedAt) > millis(input.now) ||
			!/^(0|[1-9][0-9]*)$/.test(completion.durationMonotonicNs) ||
			BigInt(completion.durationMonotonicNs) >
				BigInt(node.maximumSeconds) * 1_000_000_000n
		)
			fail("whole-cell deadline bound violated");
		if (
			!Array.isArray(completion.files) ||
			completion.files.length > 128 ||
			canonicalArtifactSha256(cellFiles(input.root, node)) !==
				canonicalArtifactSha256(completion.files)
		)
			fail("cell artifact set changed after seal");
		for (const file of completion.files) verifyBinding(input.root, file);
		verifyOperations(
			input,
			policy,
			node,
			start,
			completion.finishedAt,
			completion.files,
		);
		const raw = rawGrade(input, state, authority, policy, node, scanPrefix),
			grade = raw.grade;
		if (
			canonicalArtifactSha256(grade) !==
			canonicalArtifactSha256(completion.grade)
		)
			fail(
				`stored grade does not match raw evidence${grade.reasons.length ? `: ${grade.reasons.join("; ")}` : ""}`,
			);
		scanPrefix = raw.scanPrefix;
		completed.push({ nodeId: node.id, outcome: grade.outcome });
		completions.push(completion);
		previousCompletionSha256 = binding(
			input.root,
			`work/${node.id}/completion.json`,
		).sha256;
		cellsMs += duration;
		previousFinish = millis(completion.finishedAt);
		current = node.next[grade.outcome];
	}
	for (const node of policy.workPlan.nodes)
		if (
			!completed.some((step) => step.nodeId === node.id) &&
			existsSync(pathIn(input.root, `work/${node.id}/completion.json`))
		)
			fail("orphan completion outside verified DAG prefix");
	const nextNode =
		typeof current === "string"
			? requireDefined(
					policy.workPlan.nodes.find((node) => node.id === current),
				)
			: null;
	let pending: Start | null = null;
	if (
		nextNode &&
		existsSync(pathIn(input.root, `work/${nextNode.id}/start.json`))
	) {
		pending = startOf(input.root, nextNode, state.policySha256);
		if (
			pending.previousCompletionSha256 !== previousCompletionSha256 ||
			millis(pending.startedAt) < previousFinish ||
			millis(pending.startedAt) > millis(input.now)
		)
			fail("pending cell start differs from prefix");
	}
	const controlMs =
		(pending ? millis(pending.startedAt) : millis(input.now)) -
		millis(setup.finishedAt) -
		cellsMs;
	if (controlMs < 0) fail("negative control interval");
	const controlUsedSeconds = Math.ceil(controlMs / 1000),
		elapsedPaidSeconds = Math.ceil(clock.elapsedPaidSeconds);
	if (controlUsedSeconds > policy.workPlan.controlMaximumSeconds)
		fail("inter-cell control bound exceeded");
	return {
		state,
		authority,
		policy,
		completed,
		completions,
		scanPrefix,
		nextNode,
		terminal: typeof current === "string" ? null : current.terminal,
		previousCompletionSha256,
		pending,
		elapsedPaidSeconds,
		controlUsedSeconds,
		controlCutoffAt: new Date(
			millis(setup.finishedAt) +
				cellsMs +
				policy.workPlan.controlMaximumSeconds * 1000,
		).toISOString(),
		remainingDeadlineSeconds: Math.max(
			0,
			Math.floor((millis(state.deadline) - millis(input.now)) / 1000),
		),
	};
}

export function startWorkCell(
	input: Context & { nodeId: string; monotonicNs: string },
): Start {
	const progress = readWorkExecution(input),
		node = progress.nextNode;
	if (!node || node.id !== input.nodeId || progress.pending)
		fail("cell start must be next unattempted DAG node; no retries");
	const start: Start = {
		schema: "g6-c32-work-cell-start/1",
		nodeId: node.id,
		policySha256: progress.state.policySha256,
		startedAt: input.now,
		startedMonotonicNs: input.monotonicNs,
		cutoffAt: new Date(
			millis(input.now) + node.maximumSeconds * 1000,
		).toISOString(),
		previousCompletionSha256: progress.previousCompletionSha256,
	};
	writeWorkJson(input.root, `work/${node.id}/start.json`, start);
	return start;
}
export function gradePendingWorkCell(
	input: Context & { nodeId: string },
): WorkGrade {
	const progress = readWorkExecution(input);
	if (progress.nextNode?.id !== input.nodeId || !progress.pending)
		fail("grade requires current started cell");
	return rawGrade(
		input,
		progress.state,
		progress.authority,
		progress.policy,
		progress.nextNode,
		progress.scanPrefix,
	).grade;
}
export function sealPendingWorkCell(input: Context & { nodeId: string }): void {
	const progress = readWorkExecution(input),
		node = progress.nextNode;
	if (!node || node.id !== input.nodeId || !progress.pending)
		fail("seal requires current started cell");
	const files = cellFiles(input.root, node).filter(
		(file) =>
			!["seal.stdout", "seal.stderr", "seal.receipt.json"].some(
				(name) => file.path === `work/${node.id}/${name}`,
			),
	);
	writeWorkJson(input.root, `work/${node.id}/cell-seal.json`, {
		schema: "g6-c32-work-cell-seal/1",
		nodeId: node.id,
		files,
	});
}
export function finishWorkCell(
	input: Context & {
		nodeId: string;
		monotonicNs: string;
		finishedClock?: () => { now: string; monotonicNs: string };
	},
): Completion {
	const progress = readWorkExecution(input),
		node = progress.nextNode,
		start = progress.pending;
	if (!node || node.id !== input.nodeId || !start)
		fail("finish requires current started cell");
	const durationNs =
		BigInt(input.monotonicNs) - BigInt(start.startedMonotonicNs);
	if (
		millis(input.now) > millis(start.cutoffAt) ||
		durationNs < 0 ||
		durationNs > BigInt(node.maximumSeconds) * 1_000_000_000n
	)
		fail("whole-cell deadline bound exceeded");
	const grade = rawGrade(
			input,
			progress.state,
			progress.authority,
			progress.policy,
			node,
			progress.scanPrefix,
		).grade,
		files = cellFiles(input.root, node);
	verifyOperations(input, progress.policy, node, start, input.now, files);
	if (
		canonicalArtifactSha256(
			readWorkJson(input.root, `work/${node.id}/work-grade.json`),
		) !== canonicalArtifactSha256(grade)
	)
		fail("grade operation output differs from raw grade");
	const finished = input.finishedClock?.() ?? input;
	const finalDurationNs =
		BigInt(finished.monotonicNs) - BigInt(start.startedMonotonicNs);
	if (
		millis(finished.now) < millis(input.now) ||
		millis(finished.now) > millis(start.cutoffAt) ||
		finalDurationNs < durationNs ||
		finalDurationNs > BigInt(node.maximumSeconds) * 1_000_000_000n
	)
		fail("whole-cell deadline exceeded during final verification");
	const completion: Completion = {
		schema: "g6-c32-work-cell-completion/1",
		nodeId: node.id,
		policySha256: progress.state.policySha256,
		startedAt: start.startedAt,
		finishedAt: finished.now,
		durationMonotonicNs: String(finalDurationNs),
		previousCompletionSha256: progress.previousCompletionSha256,
		grade,
		files,
	};
	writeWorkJson(input.root, `work/${node.id}/completion.json`, completion);
	return completion;
}

/** Construct only from the regraded terminal prefix, never caller-supplied outcomes. */
export function createWorkFinal(input: Context): WorkFinal {
	const progress = readWorkExecution(input);
	if (!progress.terminal || progress.pending)
		fail("cannot finalize a nonterminal or unsealed work prefix");
	return {
		schema: "g6-c32-work-final/1",
		recordedAt: validateRfc3339Millis(input.now, "work final recordedAt"),
		policySha256: progress.state.policySha256,
		lifecycle: progress.policy.lifecycle,
		terminal:
			progress.terminal === "COMPLETE"
				? progress.policy.lifecycle === "attribution-only"
					? "ATTRIBUTION_COMPLETE"
					: "LADDER_COMPLETE"
				: "INCOMPLETE",
		completed: progress.completed,
		controlUsedSeconds: progress.controlUsedSeconds,
		elapsedPaidSeconds: progress.elapsedPaidSeconds,
	};
}

/** Historical verification remains valid after teardown, seal, and later publication. */
export function verifyWorkFinal(
	input: Omit<Context, "now"> & { now?: string },
): WorkFinal {
	const result = object(readWorkJson(input.root, "closeout/work-final.json"), [
		"schema",
		"recordedAt",
		"policySha256",
		"lifecycle",
		"terminal",
		"completed",
		"controlUsedSeconds",
		"elapsedPaidSeconds",
	]) as WorkFinal;
	const recordedMs = millis(result.recordedAt);
	if (recordedMs > millis(input.now ?? new Date().toISOString()))
		fail("work final time is in the future");
	// Validate the entire supplied chain before selecting its historical prefix.
	const entries = validateSpendLedger(input.ledger, {
		requireSeal: false,
	}).entries;
	const lastEntry = entries.at(-1);
	const seal = lastEntry?.event === "SEAL" ? lastEntry : null;
	if (seal && millis(seal.recordedAt) < recordedMs)
		fail("work final time follows ledger seal");
	const closeoutEvents = new Set([
		"DESTROY_INTENT",
		"DESTROY_CONFIRMED",
		"EMERGENCY_RECONCILIATION",
		"DEADLINE",
		"ABORT",
		"SEAL",
	]);
	if (
		entries.some(
			(entry) =>
				millis(entry.recordedAt) > recordedMs &&
				!closeoutEvents.has(entry.event),
		)
	)
		fail("post-final work appears in spend ledger");
	const expected = createWorkFinal({
		...input,
		ledger: entries.filter(
			(entry) =>
				entry.event !== "SEAL" && millis(entry.recordedAt) <= recordedMs,
		),
		now: result.recordedAt,
	});
	if (canonicalArtifactSha256(result) !== canonicalArtifactSha256(expected))
		fail("work final differs from verified terminal evidence");
	return expected;
}
