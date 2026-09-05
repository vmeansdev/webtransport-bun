import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
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

export const OWNED_COMMAND_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;
const OWNED_COMMAND_OUTPUT_PAGE_BYTES = 64 * 1024;

export type OwnedCommandResult = CommandExecutionResult & {
	ownership: {
		pid: number | null;
		processGroupId: number | null;
		commandPid: number | null;
		commandExitCode: number | null;
		commandSignal: string | null;
		supervisorJoined: boolean;
		supervisorSignal: string | null;
		groupAbsent: boolean;
		outputComplete: boolean;
		targetOutputComplete: boolean;
		cleanupComplete: boolean;
	};
};

export type OwnedCommandHandle = Readonly<{
	pid: number | null;
	processGroupId: number | null;
	supervisorToken: string | null;
	result: Promise<OwnedCommandResult>;
	cancel(): void;
}>;

export type OwnedCommandOptions = {
	/** An earlier, already-running clock; never extends spec.timeoutMs. */
	deadlineMonotonicNs?: bigint;
	/** Borrowed sinks: one pending write per stream, within the same deadline. */
	forwardOutput?: {
		stdout: Writable;
		stderr: Writable;
		inheritStdin?: boolean;
	};
};

export function isOwnedSupervisorToken(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			value,
		)
	);
}

// The supervisor deliberately survives direct-command exit and TERM. Its live
// PID holds ownership of the group until the final group KILL. The target
// streams are forwarded with backpressure. IPC attests target EOF only
// after all forwarded write callbacks completed; outer EOF follows group KILL.
const OWNED_COMMAND_SUPERVISOR = `
const {spawn}=require("node:child_process");
const send=(value)=>{try{process.send(value,()=>{});}catch{}};
// This live process is the group incarnation anchor. Parent death must not
// start another grace period, and parent timer suspension cannot renew cutoff.
const killOwnedGroup=()=>{try{process.kill(-process.pid,"SIGKILL");}catch(error){send({kind:"error",message:"self-group cleanup failed: "+String(error).slice(0,1024)});}};
process.on("SIGTERM",()=>{});process.on("SIGINT",()=>{});process.on("SIGHUP",()=>{});
process.once("disconnect",killOwnedGroup);
const remainingMs=()=>Number(BigInt(supervisorKillAtNs)-process.hrtime.bigint())/1e6;
const expire=()=>{const remaining=remainingMs();if(remaining<=0)killOwnedGroup();else setTimeout(expire,Math.ceil(remaining));};
expire();
const reported=new Set();
const eof=(stream)=>{if(!reported.has(stream)){reported.add(stream);send({kind:"eof",stream});}};
const forward=(input,output,name)=>{
 let pending=0,ended=false;
 const complete=()=>{if(ended&&pending===0)eof(name);};
 input.on("data",chunk=>{
  pending++;
  if(!output.write(chunk,error=>{pending--;if(error)send({kind:"error",message:String(error).slice(0,2048)});complete();})){
   input.pause();output.once("drain",()=>input.resume());
  }
 });
 input.on("end",()=>{ended=true;complete();});
 input.on("error",error=>send({kind:"error",message:String(error).slice(0,2048)}));
 output.on("error",()=>{});
};
process.once("message",message=>{
 if(!message||message.kind!=="start"||!message.environment||typeof message.environment!=="object")return;
 if(remainingMs()<=0){killOwnedGroup();return;}
 const argv=process.argv.slice(1);
 let command;
 const failure=error=>{send({kind:"error",message:String(error).slice(0,2048)});if(!command?.pid){eof("stdout");eof("stderr");}};
 try {
  command=spawn(argv[0],argv.slice(1),{env:message.environment,stdio:[message.inheritStdin===true?"inherit":"ignore","pipe","pipe"]});
  if(command.pid)send({kind:"command",pid:command.pid});
  command.once("error",failure);
  command.once("exit",(code,signal)=>send({kind:"exit",code,signal}));
  forward(command.stdout,process.stdout,"stdout");forward(command.stderr,process.stderr,"stderr");
 } catch(error) { failure(error); }
});
send({kind:"ready",pid:process.pid,token:supervisorToken});
`;

function noOwnedCommand(
	outcome: "FAILED" | "CANCELLED" | "TIMED_OUT",
	message: string,
): OwnedCommandHandle {
	return Object.freeze({
		pid: null,
		processGroupId: null,
		supervisorToken: null,
		cancel: () => {},
		result: Promise.resolve({
			stdout: "",
			stderr: `${message}\n`,
			status: { outcome, exitCode: null, signal: null },
			ownership: {
				pid: null,
				processGroupId: null,
				commandPid: null,
				commandExitCode: null,
				commandSignal: null,
				supervisorJoined: true,
				supervisorSignal: null,
				groupAbsent: true,
				outputComplete: true,
				targetOutputComplete: true,
				cleanupComplete: true,
			},
		}),
	});
}

function linuxLeaderIdentity(pid: number): { group: number; ticks: string } {
	const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	const fields = stat
		.slice(stat.lastIndexOf(")") + 1)
		.trim()
		.split(/\s+/);
	const group = Number(fields[2]),
		ticks = fields[19];
	if (
		!Number.isSafeInteger(group) ||
		group < 2 ||
		!ticks ||
		!/^[1-9][0-9]*$/.test(ticks)
	)
		fail("invalid owned supervisor /proc identity");
	return { group, ticks };
}

/** All command work, TERM grace, KILL join, and output collection fit timeoutMs. */
export function startOwnedCommand(
	spec: CommandSpec,
	executionRoot: string,
	signal?: AbortSignal,
	options: OwnedCommandOptions = {},
): OwnedCommandHandle {
	if (signal?.aborted)
		return noOwnedCommand("CANCELLED", "cancelled before process start");
	if (process.platform !== "linux" && process.platform !== "darwin")
		return noOwnedCommand(
			"FAILED",
			"owned campaign process groups require Linux or macOS; no Windows capacity qualification",
		);
	if (
		!Number.isSafeInteger(spec.timeoutMs) ||
		spec.timeoutMs < 1 ||
		spec.stdin !== "ignore"
	)
		return noOwnedCommand(
			"FAILED",
			"invalid owned command deadline/stdin contract",
		);
	const monotonicStart = process.hrtime.bigint();
	const ownDeadline = monotonicStart + BigInt(spec.timeoutMs) * 1_000_000n;
	if (
		options.deadlineMonotonicNs !== undefined &&
		typeof options.deadlineMonotonicNs !== "bigint"
	)
		return noOwnedCommand("FAILED", "invalid absolute owned-command cutoff");
	const absoluteDeadline =
		options.deadlineMonotonicNs !== undefined &&
		options.deadlineMonotonicNs < ownDeadline
			? options.deadlineMonotonicNs
			: ownDeadline;
	const budgetMs = Number(absoluteDeadline - monotonicStart) / 1e6;
	if (budgetMs <= 0)
		return noOwnedCommand("TIMED_OUT", "deadline expired before process start");
	const remainingMs = () =>
		Math.max(0, Number(absoluteDeadline - process.hrtime.bigint()) / 1e6);
	const grace = Math.min(250, Math.floor(budgetMs / 3));
	const joinBound = Math.min(250, Math.floor(budgetMs / 3));
	const supervisorKillAt = absoluteDeadline - BigInt(joinBound) * 1_000_000n;
	const token = randomUUID();
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(
			process.execPath,
			[
				"-e",
				`const supervisorToken=${JSON.stringify(token)};const supervisorKillAtNs=${JSON.stringify(String(supervisorKillAt))};${OWNED_COMMAND_SUPERVISOR}`,
				"--",
				spec.command,
				...spec.args,
			],
			{
				cwd: resolve(executionRoot, spec.cwd),
				env: {},
				detached: true,
				stdio: [
					options.forwardOutput?.inheritStdin ? "inherit" : "ignore",
					"pipe",
					"pipe",
					"ipc",
				],
				serialization: "json",
			},
		);
	} catch (error) {
		return noOwnedCommand("FAILED", `process start failed: ${String(error)}`);
	}
	const pid = child.pid ?? null;
	let initialLinuxIdentity: ReturnType<typeof linuxLeaderIdentity> | null =
		null;
	if (pid && process.platform === "linux")
		try {
			initialLinuxIdentity = linuxLeaderIdentity(pid);
		} catch {
			/* A spawn error is collected below. */
		}
	let cancel = () => {};
	const result = new Promise<OwnedCommandResult>((resolveResult) => {
		const stdout: Buffer[] = [],
			stderr: Buffer[] = [],
			diagnostics: string[] = [];
		let stdoutBytes = 0,
			stderrBytes = 0,
			stdoutEnded = false,
			stderrEnded = false,
			controlEnded = false;
		let targetStdoutEnded = false,
			targetStderrEnded = false,
			controlMessages = 0;
		let pendingForwardWrites = 0,
			forwardFailed = false;
		const detachForwarders: (() => void)[] = [];
		let commandPid: number | null = null,
			commandExit: { code: number | null; signal: string | null } | null = null;
		let supervisorJoined = false,
			supervisorSignal: string | null = null,
			ready = false,
			finished = false,
			killed = false;
		let stopping: "completed" | "FAILED" | "TIMED_OUT" | "CANCELLED" | null =
			null;
		let lastSignal: string | null = null,
			absenceError: string | null = null;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const output = child.stdout,
			errors = child.stderr;
		const diagnostic = (message: string) => {
			if (diagnostics.length < 8 && !diagnostics.includes(message))
				diagnostics.push(message.slice(0, 2048));
		};
		const groupAbsent = () => {
			if (pid === null) return true;
			try {
				process.kill(-pid, 0);
				return false;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") {
					absenceError = null;
					return true;
				}
				// EPERM is not absence. A later ESRCH can prove cleanup; retain the
				// probe error only when the bounded join never obtains that proof.
				absenceError = `owned group absence check failed: ${String(error)}`;
				return false;
			}
		};
		const signalGroup = (name: "SIGTERM" | "SIGKILL") => {
			if (
				pid === null ||
				pid < 2 ||
				supervisorJoined ||
				child.exitCode !== null ||
				child.signalCode !== null
			)
				return;
			try {
				if (process.platform === "linux") {
					const live = linuxLeaderIdentity(pid);
					if (!initialLinuxIdentity && ready) initialLinuxIdentity = live;
					if (
						!initialLinuxIdentity ||
						live.group !== pid ||
						live.ticks !== initialLinuxIdentity.ticks
					)
						throw Error("supervisor identity changed");
				} else {
					const check = spawnSync(
						"/bin/ps",
						["-ww", "-p", String(pid), "-o", "pid=,pgid=,command="],
						{
							encoding: "utf8",
							timeout: Math.max(1, Math.min(50, Math.floor(remainingMs()))),
							maxBuffer: 65536,
						},
					);
					const ids = check.stdout?.match(/^\s*(\d+)\s+(\d+)\s/);
					if (
						check.error ||
						check.status !== 0 ||
						Number(ids?.[1]) !== pid ||
						Number(ids?.[2]) !== pid ||
						!check.stdout.includes(token)
					)
						throw Error("supervisor PID/group/nonce is not the owned launcher");
				}
				process.kill(-pid, name);
				lastSignal = name;
			} catch (error) {
				diagnostic(
					`refused or failed ${name} for owned group: ${String(error)}`,
				);
			}
		};
		const finish = (forced = false) => {
			if (finished) return;
			const outputComplete =
				stdoutEnded &&
				stderrEnded &&
				controlEnded &&
				pendingForwardWrites === 0 &&
				!forwardFailed;
			if (!forced && (!supervisorJoined || !outputComplete)) return;
			const absent = groupAbsent();
			const targetOutputComplete = targetStdoutEnded && targetStderrEnded;
			const cleanupComplete = supervisorJoined && absent && outputComplete;
			if (!forced && !cleanupComplete) return;
			finished = true;
			timers.forEach(clearTimeout);
			for (const detach of detachForwarders) detach();
			signal?.removeEventListener("abort", cancel);
			if (!cleanupComplete)
				diagnostic(
					`owned command cleanup/pipe join deadline expired (joined=${supervisorJoined}, absent=${absent}, stdoutEOF=${stdoutEnded}, stderrEOF=${stderrEnded}, controlEOF=${controlEnded}); partial output retained and cleanup is unverified`,
				);
			if (!absent && absenceError) diagnostic(absenceError);
			if (!targetOutputComplete)
				diagnostic(
					"target output EOF was not attested; retained bytes are partial",
				);
			for (const stream of [output, errors]) stream?.destroy();
			if (child.connected)
				try {
					child.disconnect();
				} catch {
					/* Forced deadline already records incomplete collection. */
				}
			child.unref();
			if (stopping === "completed" && remainingMs() === 0) {
				stopping = "TIMED_OUT";
				diagnostic(
					"owned cleanup was not observed within the absolute deadline",
				);
			}
			const retainedStdout = Buffer.concat(stdout, stdoutBytes);
			const retainedStderr = Buffer.concat([
				Buffer.concat(stderr, stderrBytes),
				...diagnostics.map((value) =>
					Buffer.from(`g6-c32-operation: ${value}\n`),
				),
			]);
			// Collection includes the bounded final copies. A delayed event-loop
			// join cannot publish success using a now-expired earlier observation.
			if (stopping === "completed" && remainingMs() === 0)
				stopping = "TIMED_OUT";
			let status: OperationReceipt["status"];
			if (stopping === "TIMED_OUT" || stopping === "CANCELLED")
				status = { outcome: stopping, exitCode: null, signal: lastSignal };
			else if (
				stopping === "completed" &&
				cleanupComplete &&
				targetOutputComplete &&
				diagnostics.length === 0 &&
				commandExit?.code === 0
			)
				status = { outcome: "SUCCEEDED", exitCode: 0, signal: null };
			else
				status = {
					outcome: "FAILED",
					exitCode:
						commandExit?.code && commandExit.code !== 0
							? commandExit.code
							: null,
					signal: commandExit?.signal ?? (cleanupComplete ? null : lastSignal),
				};
			resolveResult({
				stdout: retainedStdout,
				stderr: retainedStderr,
				status,
				ownership: {
					pid,
					processGroupId: pid,
					commandPid,
					commandExitCode: commandExit?.code ?? null,
					commandSignal: commandExit?.signal ?? null,
					supervisorJoined,
					supervisorSignal,
					groupAbsent: absent,
					outputComplete,
					targetOutputComplete,
					cleanupComplete,
				},
			});
		};
		const kill = () => {
			if (!killed) {
				killed = true;
				signalGroup("SIGKILL");
			}
		};
		const pollJoin = () => {
			if (finished) return;
			finish();
			if (!finished) timers.push(setTimeout(pollJoin, 10));
		};
		const stop = (reason: NonNullable<typeof stopping>, message?: string) => {
			if (finished) return;
			const first = stopping === null;
			if (first || stopping === "completed") stopping = reason;
			if (message) diagnostic(message);
			if (!first) return;
			clearTimeout(workTimer);
			signalGroup("SIGTERM");
			const remaining = remainingMs();
			const termDelay = Math.min(grace, Math.max(0, remaining - joinBound));
			timers.push(
				setTimeout(() => {
					kill();
					pollJoin();
				}, termDelay),
				setTimeout(
					() => {
						kill();
						finish(true);
					},
					Math.min(remaining, termDelay + joinBound),
				),
			);
		};
		const maybeCompleted = () => {
			if (
				ready &&
				commandExit &&
				targetStdoutEnded &&
				targetStderrEnded &&
				stopping === null
			)
				stop("completed");
		};
		const collect = (stream: Readable, name: "stdout" | "stderr") => {
			let page: Buffer | null = null;
			let forwardPending = false;
			const sink = options.forwardOutput?.[name];
			const failed = (error: unknown) => {
				forwardFailed = true;
				stop("FAILED", `${name} forwarding failed: ${String(error)}`);
			};
			if (sink) {
				sink.on("error", failed);
				// A still-pending write may emit its error after our bounded return.
				// Keep only that one listener until the borrowed sink settles/closes.
				detachForwarders.push(() => {
					if (!forwardPending) sink.removeListener("error", failed);
				});
			}
			stream.on("data", (chunk: Buffer) => {
				if (finished) return;
				const count = name === "stdout" ? stdoutBytes : stderrBytes;
				const retained = Math.min(
					chunk.length,
					OWNED_COMMAND_OUTPUT_LIMIT_BYTES - count,
				);
				const pages = name === "stdout" ? stdout : stderr;
				// At most 256 pages per stream, including under one-byte writes.
				for (let offset = 0; offset < retained; ) {
					const pageOffset = (count + offset) % OWNED_COMMAND_OUTPUT_PAGE_BYTES;
					if (page === null || pageOffset === 0) {
						page = Buffer.allocUnsafe(OWNED_COMMAND_OUTPUT_PAGE_BYTES);
						pages.push(page);
					}
					const length = Math.min(
						retained - offset,
						OWNED_COMMAND_OUTPUT_PAGE_BYTES - pageOffset,
					);
					chunk.copy(page, pageOffset, offset, offset + length);
					offset += length;
				}
				if (name === "stdout") stdoutBytes += retained;
				else stderrBytes += retained;
				if (sink && retained > 0 && !forwardFailed) {
					// Pause even if write() returns true: callback count, not just bytes,
					// must stay bounded for arbitrarily small target writes.
					stream.pause();
					pendingForwardWrites++;
					forwardPending = true;
					let callbackDone = false,
						callbackError = false,
						drained = false,
						writeReturned = false,
						settled = false;
					const resume = () => {
						if (
							!writeReturned ||
							!callbackDone ||
							(!drained && !forwardFailed) ||
							settled
						)
							return;
						settled = true;
						forwardPending = false;
						pendingForwardWrites--;
						sink.removeListener("drain", onDrain);
						sink.removeListener("close", onClose);
						if (finished && !callbackError)
							sink.removeListener("error", failed);
						else if (finished)
							sink.once("error", () => sink.removeListener("error", failed));
						else if (!forwardFailed) stream.resume();
					};
					const onDrain = () => {
						drained = true;
						resume();
					};
					const onClose = () => {
						callbackDone = true;
						failed(Error("forwarded sink closed before write completion"));
						resume();
						sink.removeListener("error", failed);
					};
					sink.once("close", onClose);
					sink.once("drain", onDrain);
					try {
						const accepted = sink.write(
							chunk.subarray(0, retained),
							(error) => {
								callbackDone = true;
								if (error) {
									callbackError = true;
									drained = true;
									failed(error);
								}
								resume();
							},
						);
						writeReturned = true;
						drained ||= accepted;
						resume();
					} catch (error) {
						writeReturned = true;
						callbackDone = true;
						drained = true;
						failed(error);
						resume();
					}
				}
				if (retained !== chunk.length)
					stop(
						"FAILED",
						`${name} exceeded ${OWNED_COMMAND_OUTPUT_LIMIT_BYTES} bytes; partial output retained`,
					);
			});
			stream.on("end", () => {
				if (name === "stdout") stdoutEnded = true;
				else stderrEnded = true;
				maybeCompleted();
			});
			stream.on("error", (error) =>
				stop("FAILED", `${name} collection failed: ${String(error)}`),
			);
		};
		if (output) collect(output, "stdout");
		if (errors) collect(errors, "stderr");
		child.on("message", (value: unknown) => {
			try {
				if (
					++controlMessages > 8 ||
					Buffer.byteLength(JSON.stringify(value)) > 16384
				)
					throw Error("supervisor control evidence exceeded its bound");
				if (!isRecord(value)) throw Error("invalid control record");
				if (
					value.kind === "ready" &&
					exactKeys(value, ["kind", "pid", "token"]) &&
					!ready &&
					value.pid === pid &&
					value.token === token
				) {
					ready = true;
					if (stopping === null)
						child.send(
							{
								kind: "start",
								environment: { ...spec.env },
								inheritStdin: options.forwardOutput?.inheritStdin === true,
							},
							(error) => {
								if (error)
									stop(
										"FAILED",
										`owned command start channel failed: ${String(error)}`,
									);
							},
						);
				} else if (
					value.kind === "command" &&
					exactKeys(value, ["kind", "pid"]) &&
					ready &&
					commandPid === null &&
					Number.isSafeInteger(value.pid) &&
					Number(value.pid) > 1
				)
					commandPid = Number(value.pid);
				else if (
					value.kind === "eof" &&
					exactKeys(value, ["kind", "stream"]) &&
					ready &&
					((value.stream === "stdout" && !targetStdoutEnded) ||
						(value.stream === "stderr" && !targetStderrEnded))
				) {
					if (value.stream === "stdout") targetStdoutEnded = true;
					else targetStderrEnded = true;
				} else if (
					value.kind === "exit" &&
					exactKeys(value, ["kind", "code", "signal"]) &&
					ready &&
					commandPid !== null &&
					commandExit === null &&
					((Number.isSafeInteger(value.code) &&
						Number(value.code) >= 0 &&
						Number(value.code) <= 255 &&
						value.signal === null) ||
						(value.code === null &&
							typeof value.signal === "string" &&
							/^SIG[A-Z0-9]+$/.test(value.signal)))
				)
					commandExit = {
						code: value.code as number | null,
						signal: value.signal as string | null,
					};
				else if (
					value.kind === "error" &&
					exactKeys(value, ["kind", "message"]) &&
					typeof value.message === "string"
				)
					stop("FAILED", `command process start failed: ${value.message}`);
				else throw Error("unknown, duplicate or contradictory control record");
			} catch (error) {
				stop("FAILED", `supervisor control evidence failed: ${String(error)}`);
			}
			maybeCompleted();
		});
		child.on("disconnect", () => {
			controlEnded = true;
			if (stopping === null)
				stop(
					"FAILED",
					"supervisor control pipe closed before owned completion",
				);
		});
		child.on("error", (error) => {
			supervisorJoined = pid === null;
			stop("FAILED", `process start failed: ${String(error)}`);
		});
		child.on("exit", (_code, signalName) => {
			supervisorJoined = true;
			supervisorSignal = signalName;
			if (!killed)
				stop("FAILED", "owned supervisor exited before group cleanup");
		});
		const workTimer = setTimeout(
			() =>
				stop(
					"TIMED_OUT",
					"owned command deadline expired; partial output retained",
				),
			Math.max(0, remainingMs() - grace - joinBound),
		);
		timers.push(
			workTimer,
			setTimeout(() => {
				stop("TIMED_OUT", "whole owned-command deadline expired");
				kill();
				finish(true);
			}, remainingMs()),
		);
		cancel = () =>
			stop("CANCELLED", "owned command cancelled; partial output retained");
		if (!output || !errors)
			stop("FAILED", "owned command output pipe was not created");
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
	});
	return Object.freeze({
		pid,
		processGroupId: pid,
		supervisorToken: pid === null ? null : token,
		result,
		cancel: () => cancel(),
	});
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
		return startOwnedCommand(spec, this.#executionRoot, signal).result;
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
	const identityPath = spec.env.G6_C32_SSH_IDENTITY_PATH;
	const receiptArgs = spec.args.map((argument, index, args) =>
		argument === identityPath ||
		argument === "/root/.ssh/id_ed25519" ||
		argument.endsWith(":/root/.ssh/id_ed25519") ||
		(index > 0 && args[index - 1] === "-i")
			? "<redacted-ssh-identity>"
			: argument,
	);
	const receipt = validateOperationReceipt({
		schema: "g6-c32-operation-receipt/1",
		envelope,
		startedAt,
		finishedAt,
		durationMonotonicNs: (finishedMonotonic - startedMonotonic).toString(10),
		attempt: input.attempt,
		action: {
			command: spec.command,
			args: receiptArgs,
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
