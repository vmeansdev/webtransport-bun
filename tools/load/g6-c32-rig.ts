import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
	validateDeadline,
	validateEnvelope,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import type { CampaignClock } from "./g6-c32-operation.ts";
import type { RigLifecycleState } from "./g6-c32-rig-journal.ts";
import { type DesiredRig, validateDesiredRig } from "./g6-c32-rig-model.ts";

export type RigRunContext = Readonly<{
	runId: string;
	root: string;
	deadline: string;
}>;

export type PrepareRigRunInput = Readonly<{
	semanticFreezePath: string;
	semanticApprovalPath: string;
	deadline: string;
}>;

export type RigCommandAction =
	| "VERIFY_SEMANTIC"
	| "LOCAL_GATES"
	| "INVENTORY"
	| "ENSURE"
	| "PREPARE"
	| "BIND"
	| "DISPATCH"
	| "RECOVER_LIVE"
	| "SEAL"
	| "DESTROY";

export type RigBackendActionRequest = Readonly<{
	context: RigRunContext;
	action: RigCommandAction;
	cleanupOnly: boolean;
	signal?: AbortSignal;
}>;

export type RigCommandOperationRecord = Readonly<{
	schema: "g6-c32-rig-command-operation/1";
	envelope: {
		recordedAt: string;
		sequence: number;
		runId: string;
		phase: RigLifecycleState;
		operationId: string;
		clockSource: "offrunner";
	};
	startedAt: string;
	finishedAt: string;
	durationMonotonicNs: string;
	action: RigCommandAction;
	fromState: RigLifecycleState;
	toState: RigLifecycleState;
	outcome: "SUCCEEDED" | "FAILED";
	error: string | null;
}>;

export interface RigBackend {
	prepareRun(input: PrepareRigRunInput): Promise<RigRunContext>;
	openRoot(root: string): Promise<RigRunContext>;
	readState(context: RigRunContext): Promise<RigLifecycleState>;
	nextOperationSequence(context: RigRunContext): Promise<number>;
	persistOperation(
		record: RigCommandOperationRecord,
		context: RigRunContext,
	): Promise<void>;
	execute(request: RigBackendActionRequest): Promise<void>;
	release?(context: RigRunContext): Promise<void>;
}

export type RigCommandDependencies = Readonly<{
	backend: RigBackend;
	clock: CampaignClock;
	signal?: AbortSignal;
	writeStdout?: (value: string) => void;
}>;

export type RigCommandResult = Readonly<{
	context: RigRunContext;
	state: RigLifecycleState;
}>;

export type MakeDesiredRigInput = Readonly<{
	runId: string;
	recordedAt: string;
	deadline: string;
	freezeAuthoritySha256: string;
	freezeArtifactSha256: string;
	approvalAuthoritySha256: string;
	approvalArtifactSha256: string;
	budget: DesiredRig["budget"];
}>;

export function makeDesiredRig(input: MakeDesiredRigInput): DesiredRig {
	const recordedAt = validateRfc3339Millis(input.recordedAt, "recordedAt");
	const deadline = validateDeadline(recordedAt, input.deadline);
	return validateDesiredRig({
		recordedAt,
		requestedAt: recordedAt,
		deadline,
		runId: input.runId,
		managementTag: "g6-c32-managed",
		runTag: input.runId,
		roles: {
			serverName: `${input.runId}-server`,
			generatorName: `${input.runId}-generator`,
		},
		profile: {
			region: "ams3",
			size: "c-32-intel",
			image: "ubuntu-24-04-x64",
			vpcUuid: "6e8547b7-b698-4e28-b4d1-8c755217106c",
			projectMode: "none",
			projectId: null,
			sshKeyId: 34466793,
			expectedVcpus: 32,
			expectedMemoryMiB: 65_536,
		},
		semantic: {
			freezeAuthoritySha256: input.freezeAuthoritySha256,
			freezeArtifactSha256: input.freezeArtifactSha256,
			approvalAuthoritySha256: input.approvalAuthoritySha256,
			approvalArtifactSha256: input.approvalArtifactSha256,
		},
		budget: input.budget,
	});
}

type ParsedCommand =
	| { command: "help" }
	| {
			command: "run";
			semanticFreezePath: string;
			semanticApprovalPath: string;
			deadline: string;
	  }
	| {
			command:
				| "inventory"
				| "ensure"
				| "prepare"
				| "bind"
				| "dispatch"
				| "destroy"
				| "resume";
			root: string;
	  };

const HELP = `Usage:
  bun run g6:c32:campaign -- run --semantic-freeze PATH --semantic-approval PATH --deadline RFC3339
  bun run g6:c32:campaign -- inventory|ensure|prepare|bind|dispatch|destroy|resume --root PATH
`;

const DIAGNOSTIC_COMMANDS = new Set([
	"inventory",
	"ensure",
	"prepare",
	"bind",
	"dispatch",
	"destroy",
	"resume",
]);

const LIFECYCLE_STATES = new Set<RigLifecycleState>([
	"ABSENT",
	"CREATING",
	"PROVISIONED",
	"PREPARING",
	"PREPARED",
	"BINDING",
	"BOUND",
	"QUALIFYING",
	"RUNNING",
	"TERMINAL",
	"DESTROYING",
	"DESTROYED",
	"FAILED",
]);

const ACTIONS = new Set<RigCommandAction>([
	"VERIFY_SEMANTIC",
	"LOCAL_GATES",
	"INVENTORY",
	"ENSURE",
	"PREPARE",
	"BIND",
	"DISPATCH",
	"RECOVER_LIVE",
	"SEAL",
	"DESTROY",
]);

const VALID_STATES: Readonly<Record<string, ReadonlySet<RigLifecycleState>>> = {
	inventory: new Set(["ABSENT"]),
	ensure: new Set(["ABSENT", "CREATING"]),
	prepare: new Set(["PROVISIONED", "PREPARING"]),
	bind: new Set(["PREPARED", "BINDING"]),
	dispatch: new Set(["BOUND"]),
	destroy: new Set(["TERMINAL", "FAILED", "DESTROYING"]),
};

const COMMAND_ACTION: Readonly<Record<string, RigCommandAction>> = {
	inventory: "INVENTORY",
	ensure: "ENSURE",
	prepare: "PREPARE",
	bind: "BIND",
	dispatch: "DISPATCH",
	destroy: "DESTROY",
};

function fail(message: string): never {
	throw new Error(`g6-c32-rig: ${message}`);
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
		fail(`${label} has an invalid shape`);
	}
}

function requireLifecycleState(
	value: unknown,
	label: string,
): RigLifecycleState {
	if (!LIFECYCLE_STATES.has(value as RigLifecycleState)) {
		fail(`${label} is not a lifecycle state`);
	}
	return value as RigLifecycleState;
}

export function validateRigCommandOperationRecord(
	value: unknown,
): RigCommandOperationRecord {
	if (!isRecord(value)) fail("command operation record must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"envelope",
			"startedAt",
			"finishedAt",
			"durationMonotonicNs",
			"action",
			"fromState",
			"toState",
			"outcome",
			"error",
		],
		"command operation record",
	);
	if (value.schema !== "g6-c32-rig-command-operation/1") {
		fail("command operation schema is not supported");
	}
	const envelope = validateEnvelope(value.envelope);
	const startedAt = validateRfc3339Millis(value.startedAt, "startedAt");
	const finishedAt = validateRfc3339Millis(value.finishedAt, "finishedAt");
	if (
		Date.parse(finishedAt) < Date.parse(startedAt) ||
		envelope.recordedAt !== finishedAt
	) {
		fail("command operation timestamps are reversed or inconsistent");
	}
	if (
		typeof value.durationMonotonicNs !== "string" ||
		!/^\d+$/.test(value.durationMonotonicNs)
	) {
		fail("durationMonotonicNs must be a nonnegative decimal string");
	}
	if (!ACTIONS.has(value.action as RigCommandAction)) {
		fail("command operation action is invalid");
	}
	const fromState = requireLifecycleState(value.fromState, "fromState");
	const toState = requireLifecycleState(value.toState, "toState");
	if (envelope.phase !== toState) {
		fail("command operation envelope phase must equal toState");
	}
	if (value.outcome !== "SUCCEEDED" && value.outcome !== "FAILED") {
		fail("command operation outcome is invalid");
	}
	if (
		(value.outcome === "SUCCEEDED" && value.error !== null) ||
		(value.outcome === "FAILED" &&
			(typeof value.error !== "string" || value.error.trim() === ""))
	) {
		fail("command operation error does not match outcome");
	}
	return {
		schema: "g6-c32-rig-command-operation/1",
		envelope: {
			...envelope,
			phase: toState,
			clockSource: "offrunner",
		},
		startedAt,
		finishedAt,
		durationMonotonicNs: value.durationMonotonicNs,
		action: value.action as RigCommandAction,
		fromState,
		toState,
		outcome: value.outcome,
		error: value.error as string | null,
	};
}

export function resolveCampaignInputPath(input: {
	repositoryPath: string;
	campaignRoot: string;
	inputPath: string;
	label: string;
}): string {
	if (!input.inputPath || input.inputPath.includes("\0")) {
		fail(`${input.label} path is empty or contains NUL`);
	}
	const repository = realpathSync(input.repositoryPath);
	const campaignRoot = realpathSync(input.campaignRoot);
	const unresolved = isAbsolute(input.inputPath)
		? resolve(input.inputPath)
		: resolve(repository, input.inputPath);
	const unresolvedStat = lstatSync(unresolved);
	if (unresolvedStat.isSymbolicLink()) {
		fail(`${input.label} must not be a symlink`);
	}
	if (!unresolvedStat.isFile()) {
		fail(`${input.label} must be a regular file`);
	}
	const resolved = realpathSync(unresolved);
	const below = relative(campaignRoot, resolved);
	if (
		below === "" ||
		below === ".." ||
		below.startsWith(`..${sep}`) ||
		isAbsolute(below)
	) {
		fail(`${input.label} must remain below the fixed campaign root`);
	}
	return resolved;
}

function parsePairs(
	args: readonly string[],
	allowed: ReadonlySet<string>,
): Record<string, string> {
	const values: Record<string, string> = {};
	for (let index = 0; index < args.length; index += 2) {
		const option = args[index];
		const value = args[index + 1];
		if (!option || !allowed.has(option)) {
			fail(`unknown option ${option ?? "<missing>"}`);
		}
		if (!value || value.startsWith("--")) {
			fail(`option ${option} requires an explicit value`);
		}
		if (Object.hasOwn(values, option)) fail(`option ${option} was repeated`);
		values[option] = value;
	}
	return values;
}

function required(values: Record<string, string>, option: string): string {
	const value = values[option];
	if (!value) fail(`required option ${option} is missing`);
	return value;
}

function parseCommand(args: readonly string[]): ParsedCommand {
	const [rawCommand, ...rest] = args;
	if (!rawCommand || rawCommand === "--help" || rawCommand === "-h") {
		return { command: "help" };
	}
	if (rest.length === 1 && (rest[0] === "--help" || rest[0] === "-h")) {
		if (rawCommand === "run" || DIAGNOSTIC_COMMANDS.has(rawCommand)) {
			return { command: "help" };
		}
	}
	if (rawCommand === "run") {
		const values = parsePairs(
			rest,
			new Set(["--semantic-freeze", "--semantic-approval", "--deadline"]),
		);
		const deadline = validateRfc3339Millis(
			required(values, "--deadline"),
			"--deadline",
		);
		return {
			command: "run",
			semanticFreezePath: required(values, "--semantic-freeze"),
			semanticApprovalPath: required(values, "--semantic-approval"),
			deadline,
		};
	}
	if (!DIAGNOSTIC_COMMANDS.has(rawCommand)) {
		fail(`unknown command ${rawCommand}`);
	}
	const values = parsePairs(rest, new Set(["--root"]));
	return {
		command: rawCommand as Exclude<ParsedCommand["command"], "help" | "run">,
		root: required(values, "--root"),
	};
}

function operationId(action: RigCommandAction): string {
	return `orchestrator-${action.toLowerCase().replaceAll("_", "-")}`;
}

async function runAction(
	context: RigRunContext,
	action: RigCommandAction,
	deps: RigCommandDependencies,
	cleanupOnly = false,
): Promise<RigLifecycleState> {
	const fromState = await deps.backend.readState(context);
	const sequence = await deps.backend.nextOperationSequence(context);
	const startedAt = validateRfc3339Millis(deps.clock.wallNow(), "startedAt");
	const startedMonotonic = deps.clock.monotonicNowNs();
	let error: unknown;
	try {
		await deps.backend.execute({
			context,
			action,
			cleanupOnly,
			...(deps.signal ? { signal: deps.signal } : {}),
		});
	} catch (caught) {
		error = caught;
	}
	const finishedAt = validateRfc3339Millis(deps.clock.wallNow(), "finishedAt");
	const finishedMonotonic = deps.clock.monotonicNowNs();
	if (finishedMonotonic < startedMonotonic)
		fail("monotonic clock moved backwards");
	const toState = await deps.backend.readState(context);
	const record = validateRigCommandOperationRecord({
		schema: "g6-c32-rig-command-operation/1",
		envelope: {
			recordedAt: finishedAt,
			sequence,
			runId: context.runId,
			phase: toState,
			operationId: operationId(action),
			clockSource: "offrunner",
		},
		startedAt,
		finishedAt,
		durationMonotonicNs: (finishedMonotonic - startedMonotonic).toString(10),
		action,
		fromState,
		toState,
		outcome: error === undefined ? "SUCCEEDED" : "FAILED",
		error:
			error === undefined
				? null
				: error instanceof Error
					? error.message
					: String(error),
	});
	await deps.backend.persistOperation(record, context);
	if (error !== undefined) throw error;
	return toState;
}

async function runRemainingLifecycle(
	context: RigRunContext,
	deps: RigCommandDependencies,
	initialState: RigLifecycleState,
): Promise<RigLifecycleState> {
	let state = initialState;
	const cancelled = (): boolean => deps.signal?.aborted === true;

	if (state === "ABSENT") {
		state = await runAction(context, "VERIFY_SEMANTIC", deps);
		state = await runAction(context, "LOCAL_GATES", deps);
		state = await runAction(context, "INVENTORY", deps);
		state = await runAction(context, "ENSURE", deps, cancelled());
	} else if (state === "CREATING") {
		state = await runAction(context, "ENSURE", deps, cancelled());
	}
	if (state === "FAILED") {
		state = await runAction(context, "SEAL", deps, true);
		return runAction(context, "DESTROY", deps, true);
	}
	if (state === "PROVISIONED" || state === "PREPARING") {
		state = await runAction(context, "PREPARE", deps, cancelled());
	}
	if (state === "PREPARED" || state === "BINDING") {
		state = await runAction(context, "BIND", deps, cancelled());
	}
	if (state === "BOUND") {
		state = await runAction(context, "DISPATCH", deps, cancelled());
	} else if (state === "QUALIFYING" || state === "RUNNING") {
		state = await runAction(context, "RECOVER_LIVE", deps, true);
	}
	if (state === "TERMINAL" || state === "FAILED") {
		state = await runAction(context, "SEAL", deps, true);
	}
	if (state === "TERMINAL" || state === "FAILED" || state === "DESTROYING") {
		state = await runAction(context, "DESTROY", deps, true);
	}
	return state;
}

async function executeDiagnostic(
	command: Exclude<ParsedCommand["command"], "help" | "run" | "resume">,
	context: RigRunContext,
	deps: RigCommandDependencies,
): Promise<RigLifecycleState> {
	const state = await deps.backend.readState(context);
	const allowed = VALID_STATES[command];
	if (!allowed?.has(state)) {
		fail(`${command} is not valid from ${state}`);
	}
	const action = COMMAND_ACTION[command];
	if (!action) fail(`no action is registered for ${command}`);
	return runAction(context, action, deps, deps.signal?.aborted === true);
}

async function cleanupAfterFailure(
	context: RigRunContext,
	deps: RigCommandDependencies,
): Promise<void> {
	const { signal: _cancelledSignal, ...uncancelled } = deps;
	const cleanupDeps: RigCommandDependencies = uncancelled;
	const failures: unknown[] = [];
	let state = await cleanupDeps.backend.readState(context);
	if (state === "ABSENT" || state === "DESTROYED") return;
	const attempt = async (
		action: RigCommandAction,
	): Promise<RigLifecycleState> => {
		try {
			return await runAction(context, action, cleanupDeps, true);
		} catch (error) {
			failures.push(error);
			return cleanupDeps.backend.readState(context);
		}
	};
	if (state === "CREATING") {
		state = await attempt("ENSURE");
	}
	if (state === "QUALIFYING" || state === "RUNNING") {
		state = await attempt("RECOVER_LIVE");
	}
	if (state !== "DESTROYING" && state !== "DESTROYED") {
		state = await attempt("SEAL");
	}
	if (state !== "DESTROYED") {
		state = await attempt("DESTROY");
	}
	if (failures.length > 0) {
		throw new AggregateError(
			failures,
			`cleanup encountered ${failures.length} failure${failures.length === 1 ? "" : "s"}: ${failures
				.map((error) =>
					error instanceof Error ? error.message : String(error),
				)
				.join("; ")}`,
		);
	}
}

export async function runRigCommand(
	args: readonly string[],
	deps: RigCommandDependencies,
): Promise<RigCommandResult> {
	const parsed = parseCommand(args);
	if (parsed.command === "help") {
		(deps.writeStdout ?? ((value) => process.stdout.write(value)))(HELP);
		return {
			context: {
				runId: "help",
				root: ".",
				deadline: "1970-01-01T00:00:00.000Z",
			},
			state: "DESTROYED",
		};
	}
	const context =
		parsed.command === "run"
			? await deps.backend.prepareRun({
					semanticFreezePath: parsed.semanticFreezePath,
					semanticApprovalPath: parsed.semanticApprovalPath,
					deadline: parsed.deadline,
				})
			: await deps.backend.openRoot(parsed.root);
	try {
		let state: RigLifecycleState;
		if (parsed.command === "run" || parsed.command === "resume") {
			try {
				state = await runRemainingLifecycle(
					context,
					deps,
					await deps.backend.readState(context),
				);
			} catch (error) {
				try {
					await cleanupAfterFailure(context, deps);
				} catch (cleanupError) {
					const original =
						error instanceof Error ? error.message : String(error);
					const cleanup =
						cleanupError instanceof Error
							? cleanupError.message
							: String(cleanupError);
					throw new Error(`${original}; cleanup failed: ${cleanup}`, {
						cause: error,
					});
				}
				throw error;
			}
		} else {
			state = await executeDiagnostic(parsed.command, context, deps);
		}
		return { context, state };
	} finally {
		await deps.backend.release?.(context);
	}
}

if (import.meta.main) {
	const cancellation = new AbortController();
	const cancel = (signal: string): void => {
		if (!cancellation.signal.aborted) cancellation.abort(signal);
	};
	const onSigint = (): void => cancel("SIGINT");
	const onSigterm = (): void => cancel("SIGTERM");
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigterm);
	try {
		const { ProductionRigBackend, SystemCampaignClock } = await import(
			"./g6-c32-rig-production.ts"
		);
		const clock = new SystemCampaignClock();
		const result = await runRigCommand(process.argv.slice(2), {
			backend: new ProductionRigBackend({ clock }),
			clock,
			signal: cancellation.signal,
		});
		if (result.context.runId !== "help") {
			process.stdout.write(
				`runId=${result.context.runId}\nroot=${result.context.root}\nstate=${result.state}\n`,
			);
		}
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", onSigint);
		process.off("SIGTERM", onSigterm);
	}
}
