import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
	buildProcessProofCases,
	captureProofProcess,
	exitCaseResult,
	LINUX_SUPERVISOR_SOURCE,
	parseLauncherReceipt,
	parseLinuxProcessStat,
	parseSupervisorReceipt,
	processProofComplete,
	validateProofDescendant,
	validateProofOwner,
	validateSupervisorProcess,
} from "./g6-c32-linux-work-process-proof.ts";
import {
	cleanupWorkProcessCommand,
	ownedWorkProcessCommand,
} from "./g6-c32-work-remote.ts";

const bootId = "11111111-1111-4111-8111-111111111111";
const expected = {
	runId: "proof-123",
	nodeId: "cleanup",
	role: "server" as const,
	remoteRoot: "/tmp/g6-process-proof-123",
	bootId,
};
const owner = {
	schema: "g6-c32-work-process-owner/1" as const,
	runId: expected.runId,
	nodeId: expected.nodeId,
	role: expected.role,
	pid: 101,
	processGroupId: 101,
	startTicks: "98765",
	bootId,
};
const stat = (pid = 101, pgrp = 101, startTicks = "98765", name = "bash") => {
	const fields = Array(22).fill("0");
	Object.assign(fields, {
		0: "S",
		1: "77",
		2: String(pgrp),
		3: String(pgrp),
		19: startTicks,
	});
	return `${pid} (${name}) ${fields.join(" ")}\n`;
};
const supervisor = (launcherExit = 37) => ({
	schema: "g6-work-process-supervisor/1" as const,
	supervisorPid: 77,
	launcherPid: 101,
	launcherExit,
	launcherSignal: null,
	timedOut: false,
	remainingChildren: 0,
	trackingFailure: false,
	reaped: [
		{
			pid: 101,
			startTicks: "98765",
			processGroupId: 101,
			exitCode: 37,
			signal: null,
		},
	],
});

test("Linux stat parser handles parenthesized names without shifting PID, group or start-ticks", () => {
	expect(
		parseLinuxProcessStat(stat(101, 101, "98765", "odd ) ( command")),
	).toMatchObject({
		pid: 101,
		parentPid: 77,
		processGroupId: 101,
		sessionId: 101,
		startTicks: "98765",
		state: "S",
	});
	for (const value of [
		"",
		stat(0),
		stat(101, 0),
		stat(101, 101, "bad"),
		"101 (bash) S 1 101",
	])
		expect(() => parseLinuxProcessStat(value)).toThrow();
});

test("owned receipt must match every expected authority field and actual Linux process identity", () => {
	expect(validateProofOwner(owner, expected, stat())).toEqual(owner);
	for (const change of [
		{ pid: 102 },
		{ processGroupId: 102 },
		{ startTicks: "98766" },
		{ bootId: "22222222-2222-4222-8222-222222222222" },
		{ role: "generator" },
		{ runId: "another" },
		{ nodeId: "another" },
		{ unknown: true },
	])
		expect(() =>
			validateProofOwner({ ...owner, ...change }, expected, stat()),
		).toThrow();
});

test("cleanup targets must include a currently live exact child, not a stale or zombie identity", () => {
	const child = stat(102, 101, "98766").replace(" S 77 ", " S 101 ");
	expect(validateProofDescendant(owner, child, child).pid).toBe(102);
	for (const changed of [
		child.replace(" S ", " Z "),
		child.replace("98766", "98767"),
		child.replace(" S 101 ", " S 999 "),
		child.replace(" S 101 101 ", " S 101 102 "),
	])
		expect(() => validateProofDescendant(owner, child, changed)).toThrow();
});

test("supervisor receipt is unique, exact and fails closed on incomplete or invented process evidence", () => {
	const prefix = "g6-process-supervisor: ";
	expect(
		parseSupervisorReceipt(`${prefix}${JSON.stringify(supervisor())}\n`),
	).toEqual(supervisor());
	for (const value of [
		"",
		`${prefix}{}\n`,
		`${prefix}${JSON.stringify(supervisor())}\n${prefix}${JSON.stringify(supervisor())}\n`,
		`${prefix}${JSON.stringify({ ...supervisor(), reaped: [{ pid: -1 }] })}\n`,
	])
		expect(() => parseSupervisorReceipt(value)).toThrow();
	expect(() =>
		parseSupervisorReceipt(
			`${prefix}${JSON.stringify({ ...supervisor(), launcherExit: 0 })}\n`,
		),
	).toThrow();
});

test("supervisor receipt must belong to the actually reaped process and preserve its raw exit", () => {
	const command = {
		pid: 77,
		exitCode: 37,
		signal: null,
		timedOut: false,
		outputTruncated: false,
		error: null,
	};
	expect(() => validateSupervisorProcess(supervisor(), command)).not.toThrow();
	for (const change of [
		{ pid: 78 },
		{ exitCode: 0 },
		{ signal: "SIGTERM" },
		{ timedOut: true },
		{ outputTruncated: true },
		{ error: "lost process" },
	])
		expect(() =>
			validateSupervisorProcess(supervisor(), { ...command, ...change }),
		).toThrow();
});

test("actual initial caller group witnesses distinguish ordinary from process-group-leader launch", () => {
	const caller = {
		schema: "g6-work-process-launcher/1" as const,
		pid: 101,
		processGroupId: 77,
		sessionId: 77,
		startTicks: "98765",
	};
	const line = (value: unknown) =>
		`g6-process-launcher: ${JSON.stringify(value)}\n`;
	expect(parseLauncherReceipt(line(caller), supervisor(), false)).toEqual(
		caller,
	);
	expect(
		parseLauncherReceipt(
			line({ ...caller, processGroupId: 101 }),
			supervisor(),
			true,
		).processGroupId,
	).toBe(101);
	for (const change of [
		{ pid: 102 },
		{ processGroupId: 101 },
		{ sessionId: 101 },
		{ startTicks: "98766" },
		{ unknown: true },
	])
		expect(() =>
			parseLauncherReceipt(line({ ...caller, ...change }), supervisor(), false),
		).toThrow();
	expect(() =>
		parseLauncherReceipt(line(caller) + line(caller), supervisor(), false),
	).toThrow();
});

test("exit37 must propagate from both ordinary and group-leader launchers; a fork's exit0 is not success", () => {
	expect(exitCaseResult(supervisor(), owner.pid).pass).toBe(true);
	const lost = { ...supervisor(0), launcherPid: 100 };
	expect(exitCaseResult(lost, owner.pid)).toMatchObject({
		pass: false,
		launcherExit: 0,
		ownedExit: 37,
		forked: true,
	});
	expect(
		exitCaseResult({ ...supervisor(), timedOut: true }, owner.pid).pass,
	).toBe(false);
	const firstReaped = supervisor().reaped[0];
	if (!firstReaped) throw Error("missing fixture reaped child");
	const waited = {
		...supervisor(),
		launcherPid: 100,
		reaped: [{ ...firstReaped, pid: 100 }],
	};
	expect(exitCaseResult(waited, owner.pid)).toMatchObject({
		pass: true,
		ownedExit: null,
		forked: true,
	});
});

test("case construction consumes unchanged production constructors, including the forced group-leader call", () => {
	const cases = buildProcessProofCases(
		expected.remoteRoot,
		expected.runId,
		bootId,
	);
	expect(cases.map((row) => row.id)).toEqual([
		"wrong-boot",
		"preexisting-owner",
		"ordinary-exit37",
		"group-leader-exit37",
		"cleanup-repeat",
	]);
	for (const row of cases) {
		expect(row.launchCommand).toBe(
			`exec ${ownedWorkProcessCommand(row.owner, row.innerCommand)}`,
		);
		expect(row.cleanupCommand).toBe(cleanupWorkProcessCommand(row.owner));
	}
	expect(cases[3]?.processGroupLeader).toBe(true);
	expect(cases[2]?.processGroupLeader).toBe(false);
	expect(cases[0]?.owner.bootId).not.toBe(bootId);
	expect(new Set(cases.map((row) => row.owner.role))).toEqual(
		new Set(["server", "generator"]),
	);
});

test("non-Linux CLI refuses with actual platform evidence, never a skipped or synthetic Linux pass", () => {
	if (process.platform === "linux") return;
	const result = spawnSync(
		process.execPath,
		[join(import.meta.dir, "g6-c32-linux-work-process-proof.ts")],
		{ encoding: "utf8", timeout: 5000 },
	);
	expect(result.status).toBe(2);
	expect(JSON.parse(result.stdout)).toMatchObject({
		schema: "g6-c32-linux-work-process-proof/1",
		platform: process.platform,
		passed: false,
		cases: [],
		refusal: "real Linux /proc and setsid are required",
	});
});

test("CLI rejects attempts to supply an emulated Linux platform on every actual platform", () => {
	const result = spawnSync(
		process.execPath,
		[
			join(import.meta.dir, "g6-c32-linux-work-process-proof.ts"),
			"--platform=linux",
		],
		{ encoding: "utf8", timeout: 5000 },
	);
	expect(result.status).toBe(2);
	expect(JSON.parse(result.stdout)).toMatchObject({
		platform: process.platform,
		passed: false,
		cases: [],
		refusal: "qualification takes no arguments or emulated-platform overrides",
	});
});

test("bounded local process capture preserves exit37 and reports timeout without an open wait", async () => {
	const exited = await captureProofProcess(
		[process.execPath, "-e", "process.exit(37)"],
		1000,
	);
	expect(exited).toMatchObject({ exitCode: 37, signal: null, timedOut: false });
	const hung = await captureProofProcess(
		[process.execPath, "-e", "setInterval(() => {}, 1000)"],
		100,
	);
	expect(hung.timedOut).toBe(true);
	expect(hung.durationMs).toBeLessThan(1000);
});

test("completion requires every exact case, no cleanup residue and at most30s; local predicate is not Linux execution", () => {
	const cases = buildProcessProofCases(
		expected.remoteRoot,
		expected.runId,
		bootId,
	).map((row) => ({ id: row.id, passed: true }));
	const firstCase = cases[0];
	if (!firstCase) throw Error("missing fixture proof case");
	expect(processProofComplete(cases, 29999, true)).toBe(true);
	for (const changed of [
		cases.slice(1),
		[...cases, firstCase],
		cases.map((row, i) => ({ ...row, passed: i !== 2 })),
	])
		expect(processProofComplete(changed, 100, true)).toBe(false);
	expect(processProofComplete(cases, 30001, true)).toBe(false);
	expect(processProofComplete(cases, 100, false)).toBe(false);
});

test("supervisor C has a local syntax check only; this does not execute Linux prctl or setsid", () => {
	expect(LINUX_SUPERVISOR_SOURCE).toContain("prctl(PR_SET_CHILD_SUBREAPER, 1");
	const portableSyntax = LINUX_SUPERVISOR_SOURCE.replace(
		"#include <sys/prctl.h>",
		"extern int prctl(int, ...);\n#define PR_SET_CHILD_SUBREAPER 36",
	);
	const compiler = spawnSync(
		"/usr/bin/cc",
		[
			"-std=c11",
			"-Wall",
			"-Wextra",
			"-Werror",
			"-fsyntax-only",
			"-x",
			"c",
			"-",
		],
		{ input: portableSyntax, encoding: "utf8", timeout: 3000 },
	);
	expect(compiler.stderr).toBe("");
	expect(compiler.status).toBe(0);
});
