/** Pure campaign control-flow timing. Feasibility alone never authorizes spend. */
export type WorkOutcome = "PASS" | "MISS" | "INVALID";
export type WorkTerminal = "COMPLETE" | "INCOMPLETE";
export type WorkTarget = string | { terminal: WorkTerminal };
export type WorkNode = {
	id: string;
	label: string;
	kind: "attribution" | "ladder" | "companion";
	profile: string;
	requestedSessions: number;
	activeWorkloadSessions: number;
	maximumSeconds: number;
	next: Record<WorkOutcome, WorkTarget>;
};
export type WorkPlan = {
	schema: "g6-c32-work-plan/1";
	id: string;
	setupMaximumSeconds: number;
	controlMaximumSeconds: number;
	teardownReserveSeconds: number;
	activeMaximumSeconds: number;
	profiles: string[];
	entry: string;
	nodes: WorkNode[];
};
export type WorkStep = { nodeId: string; outcome: WorkOutcome };
export type WorkBranch = {
	steps: WorkStep[];
	terminal: WorkTerminal;
	cellSeconds: number;
	activeSeconds: number;
	totalSeconds: number;
};
export type WorkTimeAdmission = {
	decision: "FEASIBLE" | "REFUSED_DEADLINE" | "TEARDOWN";
	nextNodeId: string | null;
	terminal: WorkTerminal | null;
	requiredExecutionSeconds: number;
	requiredDeadlineSeconds: number;
};

const OUTCOMES = ["PASS", "MISS", "INVALID"] as const;
const MAX_NODES = 64;
const MAX_BRANCHES = 4_096;

function fail(message: string): never {
	throw new Error(`g6-c32-work-plan: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		fail(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (
		actual.length !== expected.length ||
		actual.some((key, i) => key !== expected[i])
	)
		fail(`${label} has missing or unknown fields`);
}

function integer(value: unknown, label: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum)
		fail(`${label} must be a safe integer >=${minimum}`);
	return value as number;
}

function sum(...values: number[]): number {
	return integer(
		values.reduce((total, value) => total + value, 0),
		"duration sum",
	);
}

function identifier(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(value)
	)
		fail(`${label} is not a bounded identifier`);
	return value;
}

function target(value: unknown): WorkTarget {
	if (typeof value === "string") return identifier(value, "next node");
	const object = record(value, "terminal");
	exactKeys(object, ["terminal"], "terminal");
	if (object.terminal !== "COMPLETE" && object.terminal !== "INCOMPLETE")
		fail("unknown terminal");
	return { terminal: object.terminal };
}

function node(value: unknown, profiles: readonly string[]): WorkNode {
	const object = record(value, "node");
	exactKeys(
		object,
		[
			"id",
			"label",
			"kind",
			"profile",
			"requestedSessions",
			"activeWorkloadSessions",
			"maximumSeconds",
			"next",
		],
		"node",
	);
	const id = identifier(object.id, "node id");
	const label = identifier(object.label, "cell label");
	const profile = identifier(object.profile, "profile");
	if (!profiles.includes(profile)) fail(`unknown profile ${profile}`);
	if (
		object.kind !== "attribution" &&
		object.kind !== "ladder" &&
		object.kind !== "companion"
	)
		fail(`unknown cell kind ${String(object.kind)}`);
	const requestedSessions = integer(
		object.requestedSessions,
		"requestedSessions",
		1,
	);
	const activeWorkloadSessions = integer(
		object.activeWorkloadSessions,
		"activeWorkloadSessions",
		1,
	);
	if (
		object.kind === "companion"
			? activeWorkloadSessions >= requestedSessions
			: activeWorkloadSessions !== requestedSessions
	)
		fail("cell kind disagrees with full-rate/companion session counts");
	const next = record(object.next, "next");
	exactKeys(next, OUTCOMES, "next");
	const edges = {
		PASS: target(next.PASS),
		MISS: target(next.MISS),
		INVALID: target(next.INVALID),
	};
	if (
		typeof edges.INVALID === "string" ||
		edges.INVALID.terminal !== "INCOMPLETE"
	)
		fail("INVALID must stop incomplete without another cell");
	return {
		id,
		label,
		kind: object.kind,
		profile,
		requestedSessions,
		activeWorkloadSessions,
		maximumSeconds: integer(object.maximumSeconds, "maximumSeconds", 1),
		next: edges,
	};
}

/** Enumerate bounded paths; shared suffix nodes are allowed, cycles are not. */
function branches(plan: WorkPlan): WorkBranch[] {
	const byId = new Map(plan.nodes.map((entry) => [entry.id, entry]));
	const reached = new Set<string>();
	const result: WorkBranch[] = [];
	const visit = (
		current: WorkTarget,
		steps: WorkStep[],
		labels: Set<string>,
		cellSeconds: number,
	): void => {
		if (typeof current !== "string") {
			if (result.length >= MAX_BRANCHES)
				fail("branch count exceeds bounded enumeration");
			const activeSeconds = sum(
				plan.setupMaximumSeconds,
				plan.controlMaximumSeconds,
				cellSeconds,
			);
			result.push({
				steps,
				terminal: current.terminal,
				cellSeconds,
				activeSeconds,
				totalSeconds: sum(activeSeconds, plan.teardownReserveSeconds),
			});
			return;
		}
		if (steps.some(({ nodeId }) => nodeId === current))
			fail(`cycle at ${current}`);
		const currentNode = byId.get(current) ?? fail(`missing node ${current}`);
		if (labels.has(currentNode.label))
			fail(`duplicate cell label on one path: ${currentNode.label}`);
		reached.add(current);
		const nextLabels = new Set([...labels, currentNode.label]);
		for (const outcome of OUTCOMES) {
			visit(
				currentNode.next[outcome],
				[...steps, { nodeId: current, outcome }],
				nextLabels,
				sum(cellSeconds, currentNode.maximumSeconds),
			);
		}
	};
	visit(plan.entry, [], new Set(), 0);
	if (reached.size !== plan.nodes.length)
		fail("unreachable nodes are not permitted");
	return result;
}

/** Structural/timing validation, not approval of a campaign's scientific design. */
export function validateWorkPlan(value: unknown): WorkPlan {
	const object = record(value, "work plan");
	exactKeys(
		object,
		[
			"schema",
			"id",
			"setupMaximumSeconds",
			"controlMaximumSeconds",
			"teardownReserveSeconds",
			"activeMaximumSeconds",
			"profiles",
			"entry",
			"nodes",
		],
		"work plan",
	);
	if (object.schema !== "g6-c32-work-plan/1") fail("unknown work-plan schema");
	if (
		!Array.isArray(object.profiles) ||
		object.profiles.length < 1 ||
		object.profiles.length > MAX_NODES
	)
		fail("profiles must be a bounded nonempty list");
	const profiles = object.profiles.map((profile) =>
		identifier(profile, "profile"),
	);
	if (new Set(profiles).size !== profiles.length) fail("duplicate profiles");
	if (
		!Array.isArray(object.nodes) ||
		object.nodes.length < 1 ||
		object.nodes.length > MAX_NODES
	)
		fail("nodes must be a bounded nonempty list");
	const nodes = object.nodes.map((entry) => node(entry, profiles));
	if (new Set(nodes.map(({ id }) => id)).size !== nodes.length)
		fail("duplicate node IDs");
	const plan: WorkPlan = {
		schema: "g6-c32-work-plan/1",
		id: identifier(object.id, "plan id"),
		setupMaximumSeconds: integer(
			object.setupMaximumSeconds,
			"setupMaximumSeconds",
			1,
		),
		controlMaximumSeconds: integer(
			object.controlMaximumSeconds,
			"controlMaximumSeconds",
			1,
		),
		teardownReserveSeconds: integer(
			object.teardownReserveSeconds,
			"teardownReserveSeconds",
			1,
		),
		activeMaximumSeconds: integer(
			object.activeMaximumSeconds,
			"activeMaximumSeconds",
			1,
		),
		profiles,
		entry: identifier(object.entry, "entry"),
		nodes,
	};
	const maximum = Math.max(
		...branches(plan).map(({ activeSeconds }) => activeSeconds),
	);
	if (plan.activeMaximumSeconds !== maximum)
		fail(
			`activeMaximumSeconds must equal setup + longest cell branch + control (${maximum})`,
		);
	return plan;
}

export function enumerateWorkPlanBranches(value: unknown): WorkBranch[] {
	return branches(validateWorkPlan(value));
}

/**
 * Reserve every still-possible suffix, including a late repeat MISS.
 * Callers must also enforce monetary admission, exact source/host approval,
 * actual setup/cell deadlines, and authenticated controller progress.
 */
export function evaluateWorkPlanTimeAdmission(
	value: unknown,
): WorkTimeAdmission {
	const input = record(value, "time admission");
	exactKeys(
		input,
		[
			"plan",
			"completed",
			"setupComplete",
			"elapsedPaidSeconds",
			"controlUsedSeconds",
			"remainingDeadlineSeconds",
		],
		"time admission",
	);
	const plan = validateWorkPlan(input.plan);
	if (typeof input.setupComplete !== "boolean")
		fail("setupComplete must be explicit");
	const elapsed = integer(input.elapsedPaidSeconds, "elapsedPaidSeconds");
	const controlUsed = integer(input.controlUsedSeconds, "controlUsedSeconds");
	const deadline = integer(
		input.remainingDeadlineSeconds,
		"remainingDeadlineSeconds",
	);
	if (controlUsed > plan.controlMaximumSeconds || controlUsed > elapsed)
		fail("controlUsedSeconds exceeds its bound or elapsed paid time");
	if (!Array.isArray(input.completed) || input.completed.length > MAX_NODES)
		fail("completed must be a bounded ordered list");
	if (
		!input.setupComplete &&
		(input.completed.length !== 0 || controlUsed !== 0)
	)
		fail("completed cells/control require completed setup");
	const byId = new Map(plan.nodes.map((entry) => [entry.id, entry]));
	let current: WorkTarget = plan.entry;
	const completed: WorkStep[] = [];
	for (const raw of input.completed) {
		if (typeof current !== "string")
			fail("completed cell follows terminal outcome");
		const step = record(raw, "completed cell");
		exactKeys(step, ["nodeId", "outcome"], "completed cell");
		if (step.nodeId !== current)
			fail("completed cells skip, replay or change the frozen sequence");
		if (!OUTCOMES.some((outcome) => outcome === step.outcome))
			fail("unknown completed outcome");
		const outcome = step.outcome as WorkOutcome;
		completed.push({ nodeId: current, outcome });
		current = byId.get(current)!.next[outcome];
	}
	if (typeof current !== "string")
		return {
			decision: "TEARDOWN",
			nextNodeId: null,
			terminal: current.terminal,
			requiredExecutionSeconds: 0,
			requiredDeadlineSeconds: plan.teardownReserveSeconds,
		};
	const possible = branches(plan).filter(({ steps }) =>
		completed.every(
			(step, index) =>
				steps[index]?.nodeId === step.nodeId &&
				steps[index]?.outcome === step.outcome,
		),
	);
	const maximumCells = Math.max(
		...possible.map(({ steps }) =>
			steps
				.slice(completed.length)
				.reduce(
					(total, step) => sum(total, byId.get(step.nodeId)!.maximumSeconds),
					0,
				),
		),
	);
	// Before setup completes, all paid time is setup: the history/control
	// validation above forbids treating cell work as setup progress.
	const setupRemaining = input.setupComplete
		? 0
		: Math.max(0, plan.setupMaximumSeconds - elapsed);
	const requiredExecutionSeconds = sum(
		setupRemaining,
		maximumCells,
		plan.controlMaximumSeconds - controlUsed,
	);
	const requiredDeadlineSeconds = sum(
		requiredExecutionSeconds,
		plan.teardownReserveSeconds,
	);
	return {
		decision:
			(!input.setupComplete && elapsed >= plan.setupMaximumSeconds) ||
			deadline < requiredDeadlineSeconds ||
			sum(elapsed, requiredExecutionSeconds) > plan.activeMaximumSeconds
				? "REFUSED_DEADLINE"
				: "FEASIBLE",
		nextNodeId: current,
		terminal: null,
		requiredExecutionSeconds,
		requiredDeadlineSeconds,
	};
}
