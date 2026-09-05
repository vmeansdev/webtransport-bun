/** Real-Linux qualification entrypoint; local unit evidence is never Linux proof. */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cleanupWorkProcessCommand,
	ownedWorkProcessCommand,
	shellQuote,
	type WorkProcessOwner,
} from "./g6-c32-work-remote.ts";

const SUPERVISOR_MARKER = "g6-process-supervisor: ";
export const LINUX_SUPERVISOR_SOURCE = String.raw`#define _POSIX_C_SOURCE 200809L
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <signal.h>
#include <time.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <limits.h>

typedef struct { pid_t pid, group, parent; unsigned long long ticks; int reaped, status; } Identity;
static Identity known[64];
static int count_known, failed;
static volatile sig_atomic_t interrupted;
static void interrupted_by(int sig) { (void)sig; interrupted = 1; }
static double clock_ms(void) {
  struct timespec t;
  if (clock_gettime(CLOCK_MONOTONIC, &t)) _exit(70);
  return t.tv_sec * 1000.0 + t.tv_nsec / 1000000.0;
}
static int snapshot(pid_t pid, Identity *out) {
  char path[96], text[4096], *end, *save = NULL, *token;
  snprintf(path, sizeof path, "/proc/%ld/stat", (long)pid);
  FILE *file = fopen(path, "r");
  if (!file) return 0;
  if (!fgets(text, sizeof text, file)) { fclose(file); return 0; }
  fclose(file);
  end = strrchr(text, ')');
  if (!end) return 0;
  memset(out, 0, sizeof *out); out->pid = pid;
  int index = 0;
  for (token = strtok_r(end + 1, " \n", &save); token; token = strtok_r(NULL, " \n", &save), index++) {
    char *tail; errno = 0;
    if (index == 1 || index == 2) {
      long value = strtol(token, &tail, 10);
      if (errno || *tail || value < 0 || value > INT_MAX) return 0;
      if (index == 1) out->parent = (pid_t)value; else out->group = (pid_t)value;
    }
    if (index == 19) {
      out->ticks = strtoull(token, &tail, 10);
      if (errno || *tail || token[0] == '-' || !out->ticks) return 0;
      return out->pid > 1 && out->group > 1;
    }
  }
  return 0;
}
static void remember(Identity value) {
  for (int i = 0; i < count_known; i++) if (known[i].pid == value.pid) {
    if (known[i].ticks != value.ticks) failed = 1;
    else known[i].group = value.group;
    return;
  }
  if (count_known == 64) { failed = 1; return; }
  known[count_known++] = value;
}
/* Discover only the new supervisor's own child subtree, not arbitrary /proc PIDs. */
static int children(pid_t parent, int depth) {
  if (depth > 32) { failed = 1; return 1; }
  char path[128]; long pid; int found = 0;
  snprintf(path, sizeof path, "/proc/%ld/task/%ld/children", (long)parent, (long)parent);
  FILE *file = fopen(path, "r");
  if (!file) { if (parent == getpid() || errno != ENOENT) failed = 1; return 0; }
  while (fscanf(file, "%ld", &pid) == 1) {
    if (++found > 64 || pid <= 1 || pid > INT_MAX) { failed = 1; break; }
    Identity value;
    if (snapshot((pid_t)pid, &value) && value.parent == parent) {
      remember(value);
      children(value.pid, depth + 1);
    }
  }
  if (ferror(file)) failed = 1;
  fclose(file);
  return found;
}
static void reap_known(void) {
  for (int i = 0; i < count_known; i++) if (!known[i].reaped) {
    Identity live;
    if (snapshot(known[i].pid, &live)) {
      if (live.ticks != known[i].ticks) { failed = 1; continue; }
      known[i].group = live.group;
    }
    int status;
    pid_t result = waitpid(known[i].pid, &status, WNOHANG);
    if (result == known[i].pid) { known[i].reaped = 1; known[i].status = status; }
    /* ECHILD is normal for descendants still owned/reaped by their live parent. */
    else if (result < 0 && errno != ECHILD && errno != EINTR) failed = 1;
  }
}
static void signal_known(int signal_number) {
  for (int i = count_known - 1; i >= 0; i--) if (!known[i].reaped) {
    Identity live;
    if (snapshot(known[i].pid, &live) && live.ticks == known[i].ticks && live.group == known[i].group)
      if (kill(live.pid, signal_number) && errno != ESRCH) failed = 1;
  }
}
static void status_json(int status, int reaped) {
  if (reaped && WIFEXITED(status)) printf("%d,\"signal\":null", WEXITSTATUS(status));
  else if (reaped && WIFSIGNALED(status)) printf("null,\"signal\":%d", WTERMSIG(status));
  else printf("null,\"signal\":null");
}
int main(int argc, char **argv) {
  if (argc != 4 || (strcmp(argv[1], "ordinary") && strcmp(argv[1], "leader"))) return 70;
  char *tail; long budget = strtol(argv[2], &tail, 10);
  if (*tail || budget < 1000 || budget > 4000) return 70;
  if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0)) { perror("prctl"); return 70; }
  struct sigaction action; memset(&action, 0, sizeof action); action.sa_handler = interrupted_by;
  sigemptyset(&action.sa_mask); sigaction(SIGTERM, &action, NULL); sigaction(SIGINT, &action, NULL);
  FILE *script = fopen(argv[3], "r");
  if (!script) return 70;
  char command[32769]; size_t size = fread(command, 1, sizeof command - 1, script);
  int too_large = !feof(script); fclose(script);
  if (!size || too_large) return 70;
  command[size] = 0;
  double end = clock_ms() + budget, stop = end - 800.0;
  pid_t launcher = fork();
  if (launcher < 0) return 70;
  if (launcher == 0) {
    if (!strcmp(argv[1], "leader") && setpgid(0, 0)) _exit(70);
    Identity caller;
    if (!snapshot(getpid(), &caller)) _exit(70);
    printf("g6-process-launcher: {\"schema\":\"g6-work-process-launcher/1\",\"pid\":%ld,\"processGroupId\":%ld,\"sessionId\":%ld,\"startTicks\":\"%llu\"}\n", (long)getpid(), (long)getpgrp(), (long)getsid(0), caller.ticks);
    fflush(stdout);
    execl("/bin/bash", "bash", "-c", command, (char *)NULL); _exit(70);
  }
  int timed_out = 0, sent_term = 0, sent_kill = 0, remaining = 1, launcher_done = 0, launcher_status = 0;
  for (;;) {
    children(getpid(), 0); reap_known();
    for (int i = 0; i < count_known; i++) if (known[i].pid == launcher && known[i].reaped) { launcher_done = 1; launcher_status = known[i].status; }
    remaining = children(getpid(), 0);
    if (launcher_done && !remaining) break;
    double now = clock_ms();
    if (interrupted || failed) { if (stop > now) stop = now; }
    if (now >= stop) {
      timed_out = 1;
      if (!sent_term) { signal_known(SIGTERM); sent_term = 1; }
      if (now >= stop + 200.0) { signal_known(SIGKILL); sent_kill = 1; }
    }
    if (now >= end) break;
    struct timespec pause = {0, 10000000}; nanosleep(&pause, NULL);
  }
  (void)sent_kill;
  printf("g6-process-supervisor: {\"schema\":\"g6-work-process-supervisor/1\",\"supervisorPid\":%ld,\"launcherPid\":%ld,\"launcherExit\":", (long)getpid(), (long)launcher);
  if (launcher_done && WIFEXITED(launcher_status)) printf("%d", WEXITSTATUS(launcher_status)); else printf("null");
  printf(",\"launcherSignal\":");
  if (launcher_done && WIFSIGNALED(launcher_status)) printf("%d", WTERMSIG(launcher_status)); else printf("null");
  printf(",\"timedOut\":%s,\"remainingChildren\":%d,\"trackingFailure\":%s,\"reaped\":[", timed_out ? "true" : "false", remaining, failed ? "true" : "false");
  int printed = 0;
  for (int i = 0; i < count_known; i++) if (known[i].reaped) {
    if (printed++) printf(",");
    printf("{\"pid\":%ld,\"startTicks\":\"%llu\",\"processGroupId\":%ld,\"exitCode\":", (long)known[i].pid, known[i].ticks, (long)known[i].group);
    status_json(known[i].status, 1); printf("}");
  }
  printf("]}\n"); fflush(stdout);
  return timed_out || remaining || failed || !launcher_done ? 71 : WIFEXITED(launcher_status) ? WEXITSTATUS(launcher_status) : 72;
}
`;
const CASE_IDS = [
	"wrong-boot",
	"preexisting-owner",
	"ordinary-exit37",
	"group-leader-exit37",
	"cleanup-repeat",
] as const;
type CommandResult = {
	argv: string[];
	pid: number | null;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	outputTruncated: boolean;
	stdout: string;
	stderr: string;
	durationMs: number;
	error: string | null;
};
type ProcessProofCaseResult = {
	id: (typeof CASE_IDS)[number];
	passed: boolean;
	role: WorkProcessOwner["role"];
	processGroupLeader: boolean;
	ownerAuthority: WorkProcessOwner;
	launchCommand: string;
	launchCommandSha256: string;
	cleanupCommandSha256: string;
	ownerRaw?: string;
	ownerStatRaw?: string;
	owner?: CapturedOwner;
	liveOwnerStatRaw?: string;
	ownerStat?: ReturnType<typeof parseLinuxProcessStat>;
	childStatRaw?: string;
	liveChildStatRaw?: string;
	childStat?: ReturnType<typeof parseLinuxProcessStat>;
	cleanup?: CommandResult;
	launch?: CommandResult;
	supervisor?: SupervisorReceipt;
	ownerAbsent?: boolean;
	childAbsent?: boolean;
	repeatCleanup?: CommandResult;
	ownerAfterRaw?: string | null;
	ownerReceiptUnchanged?: boolean;
	innerExecuted?: boolean;
	preexistingOwnerRaw?: string | null;
	ownerPreserved?: boolean;
	exitPropagation?: ReturnType<typeof exitCaseResult>;
	reason?: string;
	caller?: ReturnType<typeof parseLauncherReceipt>;
	durationMs?: number;
};
type ProcessProofReceipt = {
	schema: "g6-c32-linux-work-process-proof/1";
	platform: NodeJS.Platform;
	architecture: string;
	startedAt: string;
	maximumDurationMs: 30000;
	passed: boolean;
	cases: ProcessProofCaseResult[];
	cleanupVerified: boolean;
	proofSourceSha256: string;
	workRemoteSourceSha256: string;
	supervisorSourceSha256: string;
	bootId?: string;
	qualificationRoot?: string;
	runId?: string;
	compile?: CommandResult;
	supervisorBinarySha256?: string;
	error?: string;
	qualificationRootRemoved?: boolean;
	cleanupError?: string;
	durationMs?: number;
	finishedAt?: string;
};
/** Detached groups belong solely to this invocation; an exited leader is never signalled by a reused PID. */
export function captureProofProcess(
	argv: readonly string[],
	timeoutMs: number,
): Promise<CommandResult> {
	const command = argv[0];
	if (
		!command ||
		argv.some((value) => !value || value.includes("\0")) ||
		!Number.isFinite(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > 30000
	)
		fail("invalid bounded process request");
	return new Promise((resolve) => {
		const started = performance.now(),
			child = spawn(command, argv.slice(1), {
				detached: true,
				stdio: ["ignore", "pipe", "pipe"],
			});
		const result: CommandResult = {
			argv: [...argv],
			pid: child.pid ?? null,
			exitCode: null,
			signal: null,
			timedOut: false,
			outputTruncated: false,
			stdout: "",
			stderr: "",
			durationMs: 0,
			error: null,
		};
		let linuxIdentity: ReturnType<typeof parseLinuxProcessStat> | null = null;
		if (process.platform === "linux" && child.pid)
			try {
				linuxIdentity = parseLinuxProcessStat(
					readFileSync(`/proc/${child.pid}/stat`, "utf8"),
				);
			} catch {
				/* An already-exited child needs no signal. */
			}
		let finished = false,
			exited = false,
			terminating = false;
		const timers: ReturnType<typeof setTimeout>[] = [];
		const signal = (value: NodeJS.Signals) => {
			if (!exited && child.pid && child.pid > 1)
				try {
					if (process.platform === "linux") {
						const current = parseLinuxProcessStat(
							readFileSync(`/proc/${child.pid}/stat`, "utf8"),
						);
						if (
							!linuxIdentity ||
							current.startTicks !== linuxIdentity.startTicks ||
							current.processGroupId !== child.pid
						)
							fail("refusing signal to an unverified launcher identity");
					}
					process.kill(-child.pid, value);
				} catch (error) {
					if (
						!["ESRCH", "ENOENT"].includes(
							(error as NodeJS.ErrnoException).code ?? "",
						)
					)
						result.error = String(error);
				}
		};
		const finish = () => {
			if (finished) return;
			finished = true;
			timers.forEach(clearTimeout);
			child.stdout.destroy();
			child.stderr.destroy();
			result.durationMs = performance.now() - started;
			resolve(result);
		};
		const terminate = () => {
			if (terminating) return;
			terminating = true;
			signal("SIGTERM");
			timers.push(
				setTimeout(() => signal("SIGKILL"), 200),
				setTimeout(finish, 400),
			);
		};
		for (const key of ["stdout", "stderr"] as const)
			child[key].on("data", (chunk: Buffer) => {
				const available = 65536 - Buffer.byteLength(result[key]);
				result[key] += chunk
					.subarray(0, Math.max(0, available))
					.toString("utf8");
				if (chunk.length > available) {
					result.outputTruncated = true;
					terminate();
				}
			});
		child.on("error", (error) => {
			result.error = String(error);
			finish();
		});
		child.on("exit", (code, signal) => {
			exited = true;
			result.exitCode = code;
			result.signal = signal;
		});
		child.on("close", finish);
		timers.push(
			setTimeout(() => {
				result.timedOut = true;
				terminate();
			}, timeoutMs),
		);
	});
}
export function processProofComplete(
	cases: readonly { id: string; passed: boolean }[],
	elapsedMs: number,
	clean: boolean,
): boolean {
	return (
		clean &&
		Number.isFinite(elapsedMs) &&
		elapsedMs >= 0 &&
		elapsedMs <= 30000 &&
		cases.length === CASE_IDS.length &&
		cases.every(
			(row, index) => row.id === CASE_IDS[index] && row.passed === true,
		)
	);
}
function fail(message: string): never {
	throw Error(`g6-c32-linux-work-process-proof: ${message}`);
}
function exact(value: unknown, keys: string[]) {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		fail("missing or unknown structured fields");
	return value as Record<string, unknown>;
}
function integer(value: unknown, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum)
		fail("invalid integer identity/status");
	return value as number;
}
function ticks(value: unknown): string {
	if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value))
		fail("invalid process start ticks");
	return value;
}
export function parseLinuxProcessStat(text: string) {
	if (text.length > 4096) fail("excessive /proc stat");
	const end = text.lastIndexOf(")"),
		beginning = text.match(/^([1-9][0-9]*) \(/);
	if (!beginning || end < beginning[0].length) fail("malformed /proc stat");
	const fields = text
		.slice(end + 1)
		.trim()
		.split(/\s+/);
	const state = fields[0];
	if (fields.length < 20 || !state || !/^[A-Za-z]$/.test(state))
		fail("incomplete /proc stat");
	return {
		pid: integer(Number(beginning[1]), 2),
		parentPid: integer(Number(fields[1])),
		processGroupId: integer(Number(fields[2]), 2),
		sessionId: integer(Number(fields[3]), 2),
		startTicks: ticks(fields[19]),
		state,
	};
}
type CapturedOwner = {
	schema: "g6-c32-work-process-owner/1";
	runId: string;
	nodeId: string;
	role: "server" | "generator";
	pid: number;
	processGroupId: number;
	startTicks: string;
	bootId: string;
};
export function validateProofOwner(
	value: unknown,
	expected: WorkProcessOwner,
	stat: string,
): CapturedOwner {
	const row = exact(value, [
			"schema",
			"runId",
			"nodeId",
			"role",
			"pid",
			"processGroupId",
			"startTicks",
			"bootId",
		]),
		process = parseLinuxProcessStat(stat);
	if (
		row.schema !== "g6-c32-work-process-owner/1" ||
		row.runId !== expected.runId ||
		row.nodeId !== expected.nodeId ||
		row.role !== expected.role ||
		row.bootId !== expected.bootId ||
		row.pid !== process.pid ||
		row.processGroupId !== process.processGroupId ||
		row.pid !== row.processGroupId ||
		row.startTicks !== process.startTicks
	)
		fail("owner differs from captured Linux process/authority");
	return row as CapturedOwner;
}
export function validateProofDescendant(
	owner: CapturedOwner,
	savedStat: string,
	liveStat: string,
) {
	const saved = parseLinuxProcessStat(savedStat),
		live = parseLinuxProcessStat(liveStat);
	if (
		saved.pid === owner.pid ||
		saved.pid !== live.pid ||
		saved.startTicks !== live.startTicks ||
		[saved, live].some(
			(value) =>
				value.parentPid !== owner.pid ||
				value.processGroupId !== owner.processGroupId ||
				value.sessionId !== owner.pid ||
				["Z", "X", "x"].includes(value.state),
		)
	)
		fail(
			"descendant is not a currently live member of the exact owned process group",
		);
	return live;
}
export type SupervisorReceipt = {
	schema: "g6-work-process-supervisor/1";
	supervisorPid: number;
	launcherPid: number;
	launcherExit: number | null;
	launcherSignal: number | null;
	timedOut: boolean;
	remainingChildren: number;
	trackingFailure: boolean;
	reaped: {
		pid: number;
		startTicks: string;
		processGroupId: number;
		exitCode: number | null;
		signal: number | null;
	}[];
};
function exitStatus(code: unknown, signal: unknown) {
	if ((code === null) === (signal === null)) fail("ambiguous exit status");
	const exitCode = code === null ? null : integer(code);
	if (exitCode !== null && exitCode > 255) fail("invalid exit status");
	const signalNumber = signal === null ? null : integer(signal, 1);
	if (signalNumber !== null && signalNumber > 64) fail("invalid signal");
	return { exitCode, signal: signalNumber };
}
export function parseSupervisorReceipt(stdout: string): SupervisorReceipt {
	if (stdout.length > 65536) fail("excessive supervisor output");
	const lines = stdout
		.split(/\r?\n/)
		.filter((line) => line.startsWith(SUPERVISOR_MARKER));
	const line = lines[0];
	if (lines.length !== 1 || line === undefined)
		fail("missing or duplicate supervisor receipt");
	const row = exact(JSON.parse(line.slice(SUPERVISOR_MARKER.length)), [
		"schema",
		"supervisorPid",
		"launcherPid",
		"launcherExit",
		"launcherSignal",
		"timedOut",
		"remainingChildren",
		"trackingFailure",
		"reaped",
	]);
	if (
		row.schema !== "g6-work-process-supervisor/1" ||
		typeof row.timedOut !== "boolean" ||
		typeof row.trackingFailure !== "boolean" ||
		!Array.isArray(row.reaped) ||
		row.reaped.length > 64
	)
		fail("invalid supervisor receipt");
	const supervisorPid = integer(row.supervisorPid, 2),
		launcherPid = integer(row.launcherPid, 2),
		remainingChildren = integer(row.remainingChildren),
		launcherStatus = exitStatus(row.launcherExit, row.launcherSignal);
	const seen = new Set<number>();
	const reaped = row.reaped.map((raw: unknown) => {
		const child = exact(raw, [
			"pid",
			"startTicks",
			"processGroupId",
			"exitCode",
			"signal",
		]);
		const pid = integer(child.pid, 2),
			processGroupId = integer(child.processGroupId, 2),
			startTicks = ticks(child.startTicks),
			status = exitStatus(child.exitCode, child.signal);
		if (seen.has(pid)) fail("duplicate reaped child");
		seen.add(pid);
		return { pid, startTicks, processGroupId, ...status };
	});
	const launcher = reaped.find((child) => child.pid === launcherPid);
	if (
		!launcher ||
		launcher.exitCode !== row.launcherExit ||
		launcher.signal !== row.launcherSignal
	)
		fail("launcher status contradicts reaped process evidence");
	return {
		schema: row.schema,
		supervisorPid,
		launcherPid,
		launcherExit: launcherStatus.exitCode,
		launcherSignal: launcherStatus.signal,
		timedOut: row.timedOut,
		remainingChildren,
		trackingFailure: row.trackingFailure,
		reaped,
	};
}
export function validateSupervisorProcess(
	value: SupervisorReceipt,
	command: Pick<
		CommandResult,
		"pid" | "exitCode" | "signal" | "timedOut" | "outputTruncated" | "error"
	>,
): void {
	if (
		command.pid !== value.supervisorPid ||
		command.exitCode !== (value.launcherExit ?? 72) ||
		command.signal !== null ||
		command.timedOut ||
		command.outputTruncated ||
		command.error ||
		value.timedOut ||
		value.trackingFailure ||
		value.remainingChildren !== 0
	)
		fail(
			"supervisor differs from the actually completed process or has incomplete cleanup",
		);
}
export function parseLauncherReceipt(
	stdout: string,
	supervisor: SupervisorReceipt,
	processGroupLeader: boolean,
) {
	const marker = "g6-process-launcher: ";
	const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith(marker));
	const line = lines[0];
	if (lines.length !== 1 || line === undefined)
		fail("missing or duplicate initial launcher witness");
	const row = exact(JSON.parse(line.slice(marker.length)), [
		"schema",
		"pid",
		"processGroupId",
		"sessionId",
		"startTicks",
	]);
	const launcher = supervisor.reaped.find(
		(child) => child.pid === supervisor.launcherPid,
	);
	if (
		row.schema !== "g6-work-process-launcher/1" ||
		row.pid !== supervisor.launcherPid ||
		row.processGroupId !==
			(processGroupLeader ? row.pid : supervisor.supervisorPid) ||
		row.sessionId !== supervisor.supervisorPid ||
		row.startTicks !== launcher?.startTicks
	)
		fail("initial launcher is not the requested real process-group case");
	return row as {
		schema: "g6-work-process-launcher/1";
		pid: number;
		processGroupId: number;
		sessionId: number;
		startTicks: string;
	};
}
export function exitCaseResult(value: SupervisorReceipt, pid: number) {
	const owned = value.reaped.find((child) => child.pid === pid);
	return {
		pass:
			!value.timedOut &&
			!value.trackingFailure &&
			value.remainingChildren === 0 &&
			value.launcherExit === 37 &&
			value.launcherSignal === null &&
			(owned === undefined || (owned.exitCode === 37 && owned.signal === null)),
		launcherExit: value.launcherExit,
		ownedExit: owned?.exitCode ?? null,
		forked: value.launcherPid !== pid,
	};
}
export function buildProcessProofCases(
	root: string,
	runId: string,
	bootId: string,
) {
	return CASE_IDS.map((id) => {
		const directory = join(root, "cells", `work-${id}`),
			owner: WorkProcessOwner = {
				remoteRoot: root,
				runId,
				nodeId: id,
				role:
					id === "preexisting-owner" || id === "group-leader-exit37"
						? "generator"
						: "server",
				bootId:
					id === "wrong-boot"
						? (bootId.startsWith("0") ? "1" : "0") + bootId.slice(1)
						: bootId,
			};
		const markerPath = join(directory, "inner-executed"),
			statPath = join(directory, "inner.stat"),
			childStatPath = join(directory, "child.stat");
		const innerCommand =
			id === "wrong-boot" || id === "preexisting-owner"
				? `printf executed >${shellQuote(markerPath)}`
				: id.endsWith("exit37")
					? `cat /proc/$$/stat >${shellQuote(statPath)}\nexit 37`
					: `cat /proc/$$/stat >${shellQuote(statPath)}\nsleep 60 &\nfixture_child=$!\ntrap 'kill -TERM "$fixture_child" 2>/dev/null || true; wait "$fixture_child" 2>/dev/null || true; exit 0' TERM INT\ncat /proc/$fixture_child/stat >${shellQuote(childStatPath)}\nwait "$fixture_child"`;
		return {
			id,
			directory,
			owner,
			markerPath,
			statPath,
			childStatPath,
			ownerPath: join(
				directory,
				`${owner.role === "server" ? "scan" : "generator"}-owner.json`,
			),
			innerCommand,
			processGroupLeader: id === "group-leader-exit37",
			launchCommand: `exec ${ownedWorkProcessCommand(owner, innerCommand)}`,
			cleanupCommand: cleanupWorkProcessCommand(owner),
		};
	});
}
const digest = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");
function readSmall(path: string): string {
	const bytes = readFileSync(path);
	if (bytes.length > 65536) fail("excessive fixture evidence");
	return bytes.toString("utf8");
}
function identityAbsent(
	identity: ReturnType<typeof parseLinuxProcessStat>,
): boolean {
	try {
		return (
			parseLinuxProcessStat(readSmall(`/proc/${identity.pid}/stat`))
				.startTicks !== identity.startTicks
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}
async function until(
	predicate: () => boolean,
	deadline: number,
): Promise<void> {
	while (!predicate()) {
		if (performance.now() >= deadline)
			fail("bounded fixture observation timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
function successful(result: CommandResult) {
	return (
		result.exitCode === 0 &&
		result.signal === null &&
		!result.error &&
		!result.timedOut &&
		!result.outputTruncated
	);
}

/** No platform injection or skip mode: this function always checks the actual host. */
export async function runLinuxWorkProcessProof() {
	const started = performance.now(),
		startedAt = new Date().toISOString();
	const receipt: ProcessProofReceipt = {
		schema: "g6-c32-linux-work-process-proof/1",
		platform: process.platform,
		architecture: process.arch,
		startedAt,
		maximumDurationMs: 30000,
		passed: false,
		cases: [],
		cleanupVerified: false,
		proofSourceSha256: digest(readFileSync(import.meta.path)),
		workRemoteSourceSha256: digest(
			readFileSync(join(import.meta.dir, "g6-c32-work-remote.ts")),
		),
		supervisorSourceSha256: digest(LINUX_SUPERVISOR_SOURCE),
	};
	if (process.platform !== "linux")
		return {
			...receipt,
			refusal: "real Linux /proc and setsid are required",
			durationMs: performance.now() - started,
			finishedAt: new Date().toISOString(),
		};
	let root: string | null = null,
		allSupervisorsReaped = true;
	const identities: ReturnType<typeof parseLinuxProcessStat>[] = [];
	const workDeadline = started + 26000;
	const remaining = (maximum: number) => {
		const value = Math.min(
			maximum,
			Math.floor(workDeadline - performance.now()),
		);
		if (value < 1000)
			fail("whole-proof work deadline exhausted before dispatch");
		return value;
	};
	try {
		const bootId = readSmall("/proc/sys/kernel/random/boot_id").trim();
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId))
			fail("actual Linux boot ID is malformed");
		receipt.bootId = bootId;
		root = mkdtempSync(join(tmpdir(), "g6-linux-work-process-"));
		receipt.qualificationRoot = root;
		const runId = `process-proof-${randomUUID()}`;
		receipt.runId = runId;
		const source = join(root, "supervisor.c"),
			binary = join(root, "supervisor");
		writeFileSync(source, LINUX_SUPERVISOR_SOURCE, { flag: "wx", mode: 0o600 });
		const compiler = ["/usr/bin/cc", "/usr/bin/clang"].find(existsSync);
		if (!compiler)
			fail("prepared compiler is unavailable; qualification cannot be skipped");
		receipt.compile = await captureProofProcess(
			[
				compiler,
				"-std=c11",
				"-O2",
				"-Wall",
				"-Wextra",
				"-Werror",
				source,
				"-o",
				binary,
			],
			remaining(3000),
		);
		if (!successful(receipt.compile))
			fail("real Linux supervisor compilation failed");
		receipt.supervisorBinarySha256 = digest(readFileSync(binary));
		for (const row of buildProcessProofCases(root, runId, bootId)) {
			const caseStart = performance.now(),
				budget = remaining(4000),
				caseDeadline = caseStart + budget;
			mkdirSync(row.directory, { recursive: true });
			const script = join(row.directory, "launch.sh");
			writeFileSync(script, row.launchCommand, { flag: "wx", mode: 0o600 });
			const before = "preexisting-owner-must-not-be-overwritten\n";
			if (row.id === "preexisting-owner")
				writeFileSync(row.ownerPath, before, { flag: "wx", mode: 0o600 });
			const result: ProcessProofCaseResult = {
				id: row.id,
				passed: false,
				role: row.owner.role,
				processGroupLeader: row.processGroupLeader,
				ownerAuthority: row.owner,
				launchCommand: row.launchCommand,
				launchCommandSha256: digest(row.launchCommand),
				cleanupCommandSha256: digest(row.cleanupCommand),
			};
			receipt.cases.push(result);
			const launched = captureProofProcess(
				[
					binary,
					row.processGroupLeader ? "leader" : "ordinary",
					String(budget),
					script,
				],
				budget + 300,
			);
			try {
				if (row.id === "cleanup-repeat") {
					await until(
						() =>
							existsSync(row.ownerPath) &&
							existsSync(row.statPath) &&
							existsSync(row.childStatPath) &&
							readSmall(row.childStatPath).endsWith("\n"),
						Math.min(caseDeadline - 2800, performance.now() + 500),
					);
					result.ownerRaw = readSmall(row.ownerPath);
					result.ownerStatRaw = readSmall(row.statPath);
					result.owner = validateProofOwner(
						JSON.parse(result.ownerRaw),
						row.owner,
						result.ownerStatRaw,
					);
					result.liveOwnerStatRaw = readSmall(`/proc/${result.owner.pid}/stat`);
					result.ownerStat = parseLinuxProcessStat(result.liveOwnerStatRaw);
					validateProofOwner(result.owner, row.owner, result.liveOwnerStatRaw);
					if (["Z", "X", "x"].includes(result.ownerStat.state))
						fail("cleanup owner is not alive");
					result.childStatRaw = readSmall(row.childStatPath);
					result.liveChildStatRaw = readSmall(
						`/proc/${parseLinuxProcessStat(result.childStatRaw).pid}/stat`,
					);
					result.childStat = validateProofDescendant(
						result.owner,
						result.childStatRaw,
						result.liveChildStatRaw,
					);
					identities.push(result.ownerStat, result.childStat);
					const ownerBytes = readSmall(row.ownerPath);
					result.cleanup = await captureProofProcess(
						["/bin/bash", "-c", row.cleanupCommand],
						Math.min(2600, caseDeadline - performance.now() - 200),
					);
					result.launch = await launched;
					result.supervisor = parseSupervisorReceipt(result.launch.stdout);
					result.ownerAbsent = identityAbsent(result.ownerStat);
					result.childAbsent = identityAbsent(result.childStat);
					result.repeatCleanup = await captureProofProcess(
						["/bin/bash", "-c", row.cleanupCommand],
						Math.min(1000, Math.max(1, caseDeadline - performance.now())),
					);
					result.ownerAfterRaw = readSmall(row.ownerPath);
					result.ownerReceiptUnchanged = result.ownerAfterRaw === ownerBytes;
					result.passed =
						successful(result.cleanup) &&
						successful(result.repeatCleanup) &&
						successful(result.launch) &&
						result.ownerAbsent &&
						result.childAbsent &&
						result.ownerReceiptUnchanged;
				} else {
					result.launch = await launched;
					result.supervisor = parseSupervisorReceipt(result.launch.stdout);
					if (row.id === "wrong-boot" || row.id === "preexisting-owner") {
						result.innerExecuted = existsSync(row.markerPath);
						result.preexistingOwnerRaw =
							row.id === "preexisting-owner" ? before : null;
						result.ownerAfterRaw = existsSync(row.ownerPath)
							? readSmall(row.ownerPath)
							: null;
						result.ownerPreserved =
							row.id === "wrong-boot"
								? result.ownerAfterRaw === null
								: result.ownerAfterRaw === before;
						result.passed =
							!result.innerExecuted &&
							result.ownerPreserved &&
							result.supervisor.launcherExit === 1 &&
							result.supervisor.launcherSignal === null;
					} else {
						result.ownerRaw = readSmall(row.ownerPath);
						result.ownerStatRaw = readSmall(row.statPath);
						result.owner = validateProofOwner(
							JSON.parse(result.ownerRaw),
							row.owner,
							result.ownerStatRaw,
						);
						result.ownerStat = parseLinuxProcessStat(result.ownerStatRaw);
						identities.push(result.ownerStat);
						result.exitPropagation = exitCaseResult(
							result.supervisor,
							result.owner.pid,
						);
						result.ownerAbsent = identityAbsent(result.ownerStat);
						result.passed = result.exitPropagation.pass && result.ownerAbsent;
						if (!result.exitPropagation.pass)
							result.reason =
								"exit37 did not propagate; compare launcher and owned-child statuses (setsid requires wait semantics when it forks)";
					}
				}
				validateSupervisorProcess(result.supervisor, result.launch);
				result.caller = parseLauncherReceipt(
					result.launch.stdout,
					result.supervisor,
					row.processGroupLeader,
				);
				if (
					row.id.endsWith("exit37") &&
					(!result.exitPropagation ||
						result.exitPropagation.forked !== row.processGroupLeader)
				)
					fail(
						"setsid fork behavior differs from the witnessed initial caller group",
					);
			} catch (error) {
				result.passed = false;
				result.reason = String(error);
				result.launch = await launched;
				try {
					result.supervisor = parseSupervisorReceipt(result.launch.stdout);
				} catch {
					allSupervisorsReaped = false;
				}
			} finally {
				if (
					!result.supervisor ||
					!result.launch ||
					result.supervisor.remainingChildren !== 0 ||
					result.supervisor.trackingFailure ||
					result.supervisor.supervisorPid !== result.launch.pid ||
					result.launch.exitCode === null
				)
					allSupervisorsReaped = false;
				result.durationMs = performance.now() - caseStart;
			}
			if (result.durationMs > budget + 400)
				fail("case exceeded its hard supervisor bound");
			if (!allSupervisorsReaped)
				fail(
					"supervisor did not attest complete reaping; retain owned evidence",
				);
		}
	} catch (error) {
		receipt.error = String(error);
	} finally {
		/* Each C supervisor already bounded and reaped its own subtree, including failed cases. */
		try {
			receipt.cleanupVerified =
				allSupervisorsReaped &&
				identities.every(identityAbsent) &&
				(!receipt.compile ||
					(!receipt.compile.timedOut &&
						!receipt.compile.outputTruncated &&
						!receipt.compile.error &&
						receipt.compile.exitCode !== null));
			if (root && receipt.cleanupVerified) {
				rmSync(root, { recursive: true });
				receipt.qualificationRootRemoved = true;
			} else receipt.qualificationRootRemoved = false;
		} catch (error) {
			receipt.cleanupVerified = false;
			receipt.cleanupError = String(error);
		}
	}
	receipt.durationMs = performance.now() - started;
	receipt.finishedAt = new Date().toISOString();
	receipt.passed =
		!receipt.error &&
		processProofComplete(
			receipt.cases,
			receipt.durationMs,
			receipt.cleanupVerified,
		);
	return receipt;
}
if (import.meta.main) {
	const receipt =
		process.argv.length === 2
			? await runLinuxWorkProcessProof()
			: {
					schema: "g6-c32-linux-work-process-proof/1",
					platform: process.platform,
					passed: false,
					cases: [],
					refusal:
						"qualification takes no arguments or emulated-platform overrides",
				};
	console.log(JSON.stringify(receipt));
	process.exitCode = receipt.passed ? 0 : 2;
}
