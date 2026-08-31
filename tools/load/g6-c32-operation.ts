import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import {
	canonicalJson,
	type OperationReceipt,
	type RecordEnvelope,
	validateOperationReceipt,
} from "./g6-c32-freeze-model.ts";

export interface CampaignClock {
	wallNow(): string;
	monotonicNowNs(): bigint;
}

export type CommandSpec = {
	operationId: string;
	phase: string;
	command: string;
	args: readonly string[];
	cwd: string;
	env: Readonly<Record<string, string>>;
	timeoutMs: number;
	stdin: "ignore";
};

export type CommandExecutionResult = {
	stdout: string | Uint8Array;
	stderr: string | Uint8Array;
	status: OperationReceipt["status"];
};

export interface CommandAdapter {
	execute(
		spec: CommandSpec,
		signal?: AbortSignal,
	): Promise<CommandExecutionResult>;
}

export type RecordOperationInput = {
	runId: string;
	sequence: number;
	attempt: number;
	artifactDirectory: string;
	artifactPathPrefix: string;
	spec: CommandSpec;
	signal?: AbortSignal;
	remoteObservationAt?: (
		execution: Readonly<CommandExecutionResult>,
	) => string | null;
};

export type RecordOperationDependencies = {
	clock: CampaignClock;
	adapter: CommandAdapter;
	executionRoot: string;
};

export type OperationStatusRecord = {
	schema: "g6-c32-operation-status/1";
	envelope: RecordEnvelope;
	startedAt: string;
	finishedAt: string;
	durationMonotonicNs: string;
	attempt: number;
	status: OperationReceipt["status"];
};

export type RecordedOperation = {
	receipt: OperationReceipt;
	directoryPath: string;
	stdoutPath: string;
	stderrPath: string;
	statusPath: string;
	receiptPath: string;
};

function fail(message: string): never {
	throw new Error(`g6-c32-operation: ${message}`);
}

function exactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	return (
		actual.length === wanted.length &&
		actual.every((key, index) => key === wanted[index])
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateOperationStatusRecord(
	value: unknown,
): OperationStatusRecord {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"schema",
			"envelope",
			"startedAt",
			"finishedAt",
			"durationMonotonicNs",
			"attempt",
			"status",
		]) ||
		value.schema !== "g6-c32-operation-status/1"
	) {
		fail("operation status record has an invalid schema or shape");
	}
	const checked = validateOperationReceipt({
		schema: "g6-c32-operation-receipt/1",
		envelope: value.envelope,
		startedAt: value.startedAt,
		finishedAt: value.finishedAt,
		durationMonotonicNs: value.durationMonotonicNs,
		attempt: value.attempt,
		action: {
			command: "status-validation",
			args: [],
			cwd: ".",
			environmentKeys: [],
		},
		status: value.status,
		stdoutPath: "status-validation/operation.stdout",
		stderrPath: "status-validation/operation.stderr",
		remoteTiming: null,
	});
	return {
		schema: "g6-c32-operation-status/1",
		envelope: checked.envelope,
		startedAt: checked.startedAt,
		finishedAt: checked.finishedAt,
		durationMonotonicNs: checked.durationMonotonicNs,
		attempt: checked.attempt,
		status: checked.status,
	};
}

function requireSingleLine(value: string, label: string): void {
	if (
		typeof value !== "string" ||
		value.trim() === "" ||
		value.includes("\0") ||
		value.includes("\n") ||
		value.includes("\r")
	) {
		fail(`${label} must be a nonempty single-line string`);
	}
}

function normalizeCommandSpec(spec: CommandSpec): CommandSpec {
	requireSingleLine(spec.operationId, "operationId");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(spec.operationId)) {
		fail("operationId must be safe for an artifact directory name");
	}
	requireSingleLine(spec.phase, "phase");
	requireSingleLine(spec.command, "command");
	if (
		!Array.isArray(spec.args) ||
		spec.args.some((value) => typeof value !== "string" || value.includes("\0"))
	) {
		fail("command arguments must be NUL-free strings");
	}
	if (
		spec.cwd !== "." &&
		(spec.cwd.startsWith("/") ||
			spec.cwd.includes("\\") ||
			spec.cwd
				.split("/")
				.some((part) => part === "" || part === "." || part === ".."))
	) {
		fail("cwd must be '.' or a portable repository-relative path");
	}
	if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1) {
		fail("timeoutMs must be a positive safe integer");
	}
	if (spec.stdin !== "ignore") fail("stdin must be ignore");
	const env: Record<string, string> = {};
	for (const key of Object.keys(spec.env).sort()) {
		if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
			fail(`environment key is invalid: ${key}`);
		}
		const value = spec.env[key];
		if (typeof value !== "string" || value.includes("\0")) {
			fail(`environment value for ${key} must be a NUL-free string`);
		}
		env[key] = value;
	}
	const executable = basename(spec.command);
	let args = [...spec.args];
	const sshIdentityPath = env.G6_C32_SSH_IDENTITY_PATH;
	if (
		(executable === "ssh" || executable === "scp") &&
		sshIdentityPath !== undefined
	) {
		if (!sshIdentityPath.startsWith("/")) {
			fail("G6_C32_SSH_IDENTITY_PATH must be absolute");
		}
		args = ["-i", sshIdentityPath, "-o", "IdentitiesOnly=yes", ...args];
	}
	if (executable === "ssh" && !args.includes("-n")) args = ["-n", ...args];
	if (executable === "scp") {
		const withoutBatchMode: string[] = [];
		for (let index = 0; index < args.length; index += 1) {
			const argument = args[index];
			const next = args[index + 1];
			if (
				argument === "-o" &&
				typeof next === "string" &&
				/^BatchMode=/i.test(next)
			) {
				index += 1;
				continue;
			}
			if (typeof argument === "string" && /^-oBatchMode=/i.test(argument)) {
				continue;
			}
			if (argument !== undefined) withoutBatchMode.push(argument);
		}
		args = ["-o", "BatchMode=yes", ...withoutBatchMode];
	}
	return {
		...spec,
		args,
		env,
	};
}

class SystemCampaignClock implements CampaignClock {
	wallNow(): string {
		return new Date().toISOString();
	}

	monotonicNowNs(): bigint {
		return process.hrtime.bigint();
	}
}

type ExitMarker =
	| { kind: "exited"; exitCode: number }
	| { kind: "timed-out" }
	| { kind: "cancelled" };

function cancellableMarker(signal: AbortSignal | undefined): {
	promise: Promise<ExitMarker>;
	dispose: () => void;
} {
	if (!signal) {
		return { promise: new Promise<ExitMarker>(() => {}), dispose: () => {} };
	}
	let listener: (() => void) | undefined;
	const promise = new Promise<ExitMarker>((resolvePromise) => {
		if (signal.aborted) {
			resolvePromise({ kind: "cancelled" });
			return;
		}
		listener = () => resolvePromise({ kind: "cancelled" });
		signal.addEventListener("abort", listener, { once: true });
	});
	return {
		promise,
		dispose: () => {
			if (listener) signal.removeEventListener("abort", listener);
		},
	};
}

export class BunCommandAdapter implements CommandAdapter {
	readonly #executionRoot: string;

	constructor(executionRoot: string) {
		this.#executionRoot = executionRoot;
	}

	async execute(
		spec: CommandSpec,
		signal?: AbortSignal,
	): Promise<CommandExecutionResult> {
		if (signal?.aborted) {
			return {
				stdout: "",
				stderr: "cancelled before process start\n",
				status: { outcome: "CANCELLED", exitCode: null, signal: null },
			};
		}
		let child: ReturnType<typeof Bun.spawn>;
		try {
			child = Bun.spawn([spec.command, ...spec.args], {
				cwd: resolve(this.#executionRoot, spec.cwd),
				env: { ...spec.env },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			return {
				stdout: "",
				stderr: `process start failed: ${error instanceof Error ? error.message : String(error)}\n`,
				status: { outcome: "FAILED", exitCode: null, signal: null },
			};
		}
		const stdoutPromise = new Response(
			child.stdout as ReadableStream<Uint8Array>,
		).arrayBuffer();
		const stderrPromise = new Response(
			child.stderr as ReadableStream<Uint8Array>,
		).arrayBuffer();
		const exitPromise = child.exited.then(
			(exitCode): ExitMarker => ({ kind: "exited", exitCode }),
		);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<ExitMarker>((resolvePromise) => {
			timeout = setTimeout(
				() => resolvePromise({ kind: "timed-out" }),
				spec.timeoutMs,
			);
		});
		const cancellation = cancellableMarker(signal);
		const marker = await Promise.race([
			exitPromise,
			timeoutPromise,
			cancellation.promise,
		]);
		if (timeout) clearTimeout(timeout);
		cancellation.dispose();
		let terminationSignal: string | null = null;
		if (marker.kind !== "exited") {
			terminationSignal = "SIGTERM";
			child.kill("SIGTERM");
			const terminated = await Promise.race([
				exitPromise.then(() => true),
				new Promise<false>((resolvePromise) =>
					setTimeout(() => resolvePromise(false), 1_000),
				),
			]);
			if (!terminated) {
				terminationSignal = "SIGKILL";
				child.kill("SIGKILL");
			}
		}
		const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
		if (marker.kind === "timed-out") {
			return {
				stdout: new Uint8Array(stdout),
				stderr: new Uint8Array(stderr),
				status: {
					outcome: "TIMED_OUT",
					exitCode: null,
					signal: terminationSignal,
				},
			};
		}
		if (marker.kind === "cancelled") {
			return {
				stdout: new Uint8Array(stdout),
				stderr: new Uint8Array(stderr),
				status: {
					outcome: "CANCELLED",
					exitCode: null,
					signal: terminationSignal,
				},
			};
		}
		return {
			stdout: new Uint8Array(stdout),
			stderr: new Uint8Array(stderr),
			status:
				marker.exitCode === 0
					? { outcome: "SUCCEEDED", exitCode: 0, signal: null }
					: {
							outcome: "FAILED",
							exitCode: marker.exitCode,
							signal: null,
						},
		};
	}
}

function defaultDependencies(
	overrides: Partial<RecordOperationDependencies>,
): RecordOperationDependencies {
	const executionRoot = overrides.executionRoot ?? process.cwd();
	return {
		clock: overrides.clock ?? new SystemCampaignClock(),
		adapter: overrides.adapter ?? new BunCommandAdapter(executionRoot),
		executionRoot,
	};
}

function portablePrefix(value: string): string {
	if (
		typeof value !== "string" ||
		value === "" ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.includes("\n") ||
		value
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	) {
		fail("artifactPathPrefix must be a portable repository-relative path");
	}
	return value;
}

function writeDurableFile(path: string, value: string | Uint8Array): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, value);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function publishOperation(
	artifactDirectory: string,
	directoryName: string,
	files: Readonly<Record<string, string | Uint8Array>>,
): string {
	mkdirSync(artifactDirectory, { recursive: true });
	const finalDirectory = join(artifactDirectory, directoryName);
	if (existsSync(finalDirectory)) {
		fail(`operation artifact directory already exists: ${directoryName}`);
	}
	const stagingDirectory = join(
		artifactDirectory,
		`.${directoryName}.staging-${randomUUID()}`,
	);
	mkdirSync(stagingDirectory, { recursive: false, mode: 0o700 });
	try {
		for (const [name, value] of Object.entries(files)) {
			writeDurableFile(join(stagingDirectory, name), value);
		}
		const stagingFd = openSync(stagingDirectory, "r");
		try {
			fsyncSync(stagingFd);
		} finally {
			closeSync(stagingFd);
		}
		renameSync(stagingDirectory, finalDirectory);
		const parentFd = openSync(artifactDirectory, "r");
		try {
			fsyncSync(parentFd);
		} finally {
			closeSync(parentFd);
		}
		return finalDirectory;
	} catch (error) {
		if (existsSync(stagingDirectory)) {
			rmSync(stagingDirectory, { recursive: true, force: true });
		}
		throw error;
	}
}

function timestampToken(timestamp: string): string {
	return timestamp.replaceAll(/[^0-9]/g, "");
}

export async function recordOperation(
	input: RecordOperationInput,
	overrides: Partial<RecordOperationDependencies> = {},
): Promise<RecordedOperation> {
	const deps = defaultDependencies(overrides);
	const spec = normalizeCommandSpec(input.spec);
	const startedAt = deps.clock.wallNow();
	const startedMonotonic = deps.clock.monotonicNowNs();
	let execution: CommandExecutionResult;
	try {
		execution = await deps.adapter.execute(spec, input.signal);
	} catch (error) {
		execution = {
			stdout: "",
			stderr: `command adapter failed: ${error instanceof Error ? error.message : String(error)}\n`,
			status: { outcome: "FAILED", exitCode: null, signal: null },
		};
	}
	const finishedAt = deps.clock.wallNow();
	const finishedMonotonic = deps.clock.monotonicNowNs();
	if (finishedMonotonic < startedMonotonic) {
		fail("monotonic clock moved backwards");
	}
	const envelope: RecordEnvelope = {
		recordedAt: finishedAt,
		sequence: input.sequence,
		runId: input.runId,
		phase: spec.phase,
		operationId: spec.operationId,
		clockSource: "offrunner",
	};
	const observationAt = input.remoteObservationAt?.(execution) ?? null;
	const directoryName = `${String(input.sequence).padStart(6, "0")}-${spec.operationId}-${timestampToken(finishedAt)}`;
	const pathPrefix = portablePrefix(input.artifactPathPrefix);
	const relativeDirectory = posix.join(pathPrefix, directoryName);
	const receipt = validateOperationReceipt({
		schema: "g6-c32-operation-receipt/1",
		envelope,
		startedAt,
		finishedAt,
		durationMonotonicNs: (finishedMonotonic - startedMonotonic).toString(10),
		attempt: input.attempt,
		action: {
			command: spec.command,
			args: [...spec.args],
			cwd: spec.cwd,
			environmentKeys: Object.keys(spec.env).sort(),
		},
		status: execution.status,
		stdoutPath: posix.join(relativeDirectory, "operation.stdout"),
		stderrPath: posix.join(relativeDirectory, "operation.stderr"),
		remoteTiming: input.remoteObservationAt
			? {
					requestStartedAt: startedAt,
					responseFinishedAt: finishedAt,
					observationAt,
				}
			: null,
	});
	const status = validateOperationStatusRecord({
		schema: "g6-c32-operation-status/1",
		envelope,
		startedAt,
		finishedAt,
		durationMonotonicNs: receipt.durationMonotonicNs,
		attempt: input.attempt,
		status: execution.status,
	});
	const directoryPath = publishOperation(
		input.artifactDirectory,
		directoryName,
		{
			"operation.stdout": execution.stdout,
			"operation.stderr": execution.stderr,
			"operation.status": canonicalJson(status),
			"operation.receipt.json": canonicalJson(receipt),
		},
	);
	return {
		receipt,
		directoryPath,
		stdoutPath: join(directoryPath, "operation.stdout"),
		stderrPath: join(directoryPath, "operation.stderr"),
		statusPath: join(directoryPath, "operation.status"),
		receiptPath: join(directoryPath, "operation.receipt.json"),
	};
}
