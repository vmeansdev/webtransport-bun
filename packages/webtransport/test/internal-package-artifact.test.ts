import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as packageArtifact from "../../../scripts/test-package-artifact.ts";

const { runBoundedWindowsTreeKill } = packageArtifact;

type PackageCommandRunner = (
	command: string,
	args: string[],
	options: {
		cwd: string;
		killGraceMs?: number;
		label: string;
		platform?: NodeJS.Platform;
		timeoutMs: number;
		treeKillTimeoutMs?: number;
		windowsTreeKillCommand?: string;
	},
) => Promise<string>;

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const tempRoots: string[] = [];
const trackedPidFiles: string[] = [];
const trackedPids: number[] = [];

setDefaultTimeout(15_000);

afterEach(() => {
	for (const pid of trackedPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The production timeout cleanup should normally have removed it.
		}
	}
	for (const pidFile of trackedPidFiles.splice(0)) {
		if (!existsSync(pidFile)) continue;
		const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		if (!Number.isFinite(pid)) continue;
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The production timeout cleanup should normally have removed it.
		}
	}
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createFixtureTarball(root: string): string {
	const pkgDir = join(root, "fixture-package");
	const npmCacheDir = join(root, ".npm-cache");
	mkdirSync(pkgDir, { recursive: true });
	mkdirSync(npmCacheDir, { recursive: true });
	writeFileSync(
		join(pkgDir, "package.json"),
		JSON.stringify({
			name: "webtransport-package-fixture",
			version: "1.0.0",
			type: "module",
		}),
		"utf8",
	);
	writeFileSync(
		join(pkgDir, "index.js"),
		"export const fixture = true;\n",
		"utf8",
	);
	const packed = spawnSync("npm", ["pack", "--quiet"], {
		cwd: pkgDir,
		env: {
			...process.env,
			NPM_CONFIG_CACHE: npmCacheDir,
		},
		encoding: "utf8",
	});
	if (packed.status !== 0) {
		throw new Error(
			`fixture npm pack failed (${packed.status ?? packed.signal ?? "unknown"})\n${packed.stdout ?? ""}${packed.stderr ?? ""}`,
		);
	}
	const filename = (packed.stdout ?? "")
		.trim()
		.split("\n")
		.filter(Boolean)
		.at(-1);
	if (!filename) {
		throw new Error("fixture npm pack did not report a tarball");
	}
	return join(pkgDir, filename);
}

function createHangingRuntime(root: string, descendantPidFile: string): string {
	const runtime = join(root, "fake-deno.js");
	const descendant = join(root, "fake-deno-descendant.js");
	writeFileSync(
		descendant,
		[
			'const { writeFileSync } = require("node:fs");',
			"writeFileSync(process.env.WT_FIXTURE_DESCENDANT_PID_FILE, String(process.pid));",
			'console.log("fixture smoke started");',
			'console.error("fixture smoke stderr");',
			"setInterval(() => {}, 1_000);",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		runtime,
		[
			"#!/usr/bin/env node",
			'const { spawn } = require("node:child_process");',
			'if (process.argv[2] === "--version") {',
			'  console.log("deno 2.9.3");',
			"  process.exit(0);",
			"}",
			`const child = spawn(process.execPath, [${JSON.stringify(descendant)}], {`,
			'  stdio: "inherit",',
			"});",
			"if (child.pid === undefined) process.exit(1);",
			"setInterval(() => {}, 1_000);",
		].join("\n"),
		"utf8",
	);
	chmodSync(runtime, 0o755);
	trackedPidFiles.push(descendantPidFile);
	return runtime;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function expectProcessExit(pidFile: string): Promise<void> {
	expect(existsSync(pidFile)).toBe(true);
	const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
	await expectPidExit(pid);
}

async function expectPidExit(pid: number): Promise<void> {
	const deadline = Date.now() + 1_000;
	while (processIsAlive(pid) && Date.now() < deadline) {
		await Bun.sleep(25);
	}
	expect(processIsAlive(pid)).toBe(false);
}

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!existsSync(file) && Date.now() < deadline) {
		await Bun.sleep(25);
	}
	expect(existsSync(file)).toBe(true);
}

function spawnHangingProcessTree(descendantPidFile: string) {
	const parentSource = hangingProcessTreeSource(descendantPidFile);
	const child = spawn(process.execPath, ["-e", parentSource], {
		stdio: "ignore",
	});
	if (child.pid !== undefined) trackedPids.push(child.pid);
	trackedPidFiles.push(descendantPidFile);
	return child;
}

function hangingProcessTreeSource(
	descendantPidFile: string,
	emitDiagnostics = false,
): string {
	const descendantSource = "setInterval(() => {}, 1_000);";
	return [
		'const { spawn } = require("node:child_process");',
		'const { writeFileSync } = require("node:fs");',
		`const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });`,
		`writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
		...(emitDiagnostics
			? [
					'console.log("fixture command stdout");',
					'console.error("fixture command stderr");',
				]
			: []),
		"setInterval(() => {}, 1_000);",
	].join("\n");
}

function stubbornProcessTreeSource(descendantPidFile: string): string {
	const descendantSource = [
		'process.on("SIGTERM", () => {});',
		"setInterval(() => {}, 1_000);",
	].join("\n");
	return [
		'const { spawn } = require("node:child_process");',
		'const { writeFileSync } = require("node:fs");',
		`const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });`,
		`writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
		'process.on("SIGTERM", () => {});',
		"setInterval(() => {}, 1_000);",
	].join("\n");
}

function createNoopTaskkill(root: string): string {
	const taskkill = join(root, "noop-taskkill");
	writeFileSync(taskkill, ["#!/bin/sh", "exit 0"].join("\n"), "utf8");
	chmodSync(taskkill, 0o755);
	return taskkill;
}

async function runGuarded(
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{
	error?: Error;
	status: number | null;
	stdout: string;
	stderr: string;
}> {
	return await new Promise((resolve) => {
		const child = spawn(process.execPath, args, {
			cwd: PROJECT_ROOT,
			detached: process.platform !== "win32",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let guardExpired = false;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const guard = setTimeout(() => {
			guardExpired = true;
			if (child.pid !== undefined && process.platform !== "win32") {
				try {
					process.kill(-child.pid, "SIGKILL");
					return;
				} catch {
					// Fall through to the direct child handle.
				}
			}
			child.kill("SIGKILL");
		}, 5_000);
		child.once("close", (status) => {
			clearTimeout(guard);
			resolve({
				error: guardExpired
					? new Error("test process exceeded its 5000ms guard")
					: undefined,
				status,
				stdout,
				stderr,
			});
		});
		child.once("error", (error) => {
			clearTimeout(guard);
			resolve({ error, status: null, stdout, stderr });
		});
	});
}

function createHangingTaskkill(root: string): {
	argsFile: string;
	pidFile: string;
} {
	const taskkill = join(root, "taskkill");
	const argsFile = join(root, "taskkill-args.txt");
	const pidFile = join(root, "taskkill.pid");
	writeFileSync(
		taskkill,
		[
			"#!/bin/sh",
			'printf "%s\\n" "$@" > "$WT_FIXTURE_TASKKILL_ARGS_FILE"',
			'printf "%s" "$$" > "$WT_FIXTURE_TASKKILL_PID_FILE"',
			'target="$2"',
			'for child in $(pgrep -P "$target"); do kill -9 "$child" 2>/dev/null || true; done',
			'kill -9 "$target" 2>/dev/null || true',
			"exec sleep 1000",
		].join("\n"),
		"utf8",
	);
	chmodSync(taskkill, 0o755);
	trackedPidFiles.push(pidFile);
	return { argsFile, pidFile };
}

function createFailingTaskkill(root: string): string {
	const taskkill = join(root, "failing-taskkill");
	writeFileSync(
		taskkill,
		[
			"#!/bin/sh",
			'echo "fixture taskkill stdout"',
			'echo "fixture taskkill stderr" >&2',
			"exit 23",
		].join("\n"),
		"utf8",
	);
	chmodSync(taskkill, 0o755);
	return taskkill;
}

function createHangingNpm(root: string): string {
	const npm = join(root, "npm");
	writeFileSync(
		npm,
		[
			"#!/bin/sh",
			'echo "fixture package helper stdout"',
			'echo "fixture package helper stderr" >&2',
			`exec "${process.execPath}" -e 'setInterval(() => {}, 1_000);'`,
		].join("\n"),
		"utf8",
	);
	chmodSync(npm, 0o755);
	return npm;
}

async function capturedError(
	promise: Promise<unknown>,
): Promise<Error | undefined> {
	try {
		await promise;
		return undefined;
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
}

function packageCommandRunner(): PackageCommandRunner | undefined {
	const candidate = (packageArtifact as Record<string, unknown>)
		.runPackageCommand;
	expect(typeof candidate).toBe("function");
	return typeof candidate === "function"
		? (candidate as PackageCommandRunner)
		: undefined;
}

test.serial.skipIf(process.platform === "win32")(
	"exact-package smoke kills its hanging runtime descendant and preserves diagnostics",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "wt-package-smoke-test-"));
		tempRoots.push(root);
		const tarball = createFixtureTarball(root);
		const descendantPidFile = join(root, "descendant.pid");
		const runtime = createHangingRuntime(root, descendantPidFile);
		const startedAt = Date.now();
		const result = await runGuarded(
			[
				"scripts/test-package-artifact.ts",
				"smoke",
				tarball,
				"--runtime",
				"deno",
			],
			{
				...process.env,
				WEBTRANSPORT_DENO_COMMAND: runtime,
				WEBTRANSPORT_PACKAGE_SMOKE_TIMEOUT_MS: "1500",
				WT_FIXTURE_DESCENDANT_PID_FILE: descendantPidFile,
			},
		);
		const elapsedMs = Date.now() - startedAt;

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("deno smoke timed out after 1500ms");
		expect(result.stderr).toContain("fixture smoke started");
		expect(result.stderr).toContain("fixture smoke stderr");
		expect(elapsedMs).toBeLessThan(5_000);
		await expectProcessExit(descendantPidFile);
	},
);

test.serial.skipIf(process.platform !== "win32")(
	"win32 taskkill removes a genuine runtime descendant",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "wt-package-smoke-win32-test-"));
		tempRoots.push(root);
		const descendantPidFile = join(root, "descendant.pid");
		const child = spawnHangingProcessTree(descendantPidFile);
		await waitForFile(descendantPidFile);
		const startedAt = Date.now();
		await runBoundedWindowsTreeKill(child.pid as number, 5_000);

		expect(Date.now() - startedAt).toBeLessThan(7_000);
		await expectPidExit(child.pid as number);
		await expectProcessExit(descendantPidFile);
	},
);

test.serial.skipIf(process.platform === "win32")(
	"mocked win32 tree cleanup bounds taskkill and removes a genuine descendant",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "wt-package-smoke-win32-test-"));
		tempRoots.push(root);
		const descendantPidFile = join(root, "descendant.pid");
		const child = spawnHangingProcessTree(descendantPidFile);
		const taskkill = createHangingTaskkill(root);
		await waitForFile(descendantPidFile);
		const previousArgsFile = process.env.WT_FIXTURE_TASKKILL_ARGS_FILE;
		const previousPidFile = process.env.WT_FIXTURE_TASKKILL_PID_FILE;
		process.env.WT_FIXTURE_TASKKILL_ARGS_FILE = taskkill.argsFile;
		process.env.WT_FIXTURE_TASKKILL_PID_FILE = taskkill.pidFile;
		const startedAt = Date.now();
		let cleanupError: Error | undefined;
		try {
			cleanupError = await capturedError(
				runBoundedWindowsTreeKill(
					child.pid as number,
					1_500,
					join(root, "taskkill"),
				),
			);
		} finally {
			if (previousArgsFile === undefined)
				delete process.env.WT_FIXTURE_TASKKILL_ARGS_FILE;
			else process.env.WT_FIXTURE_TASKKILL_ARGS_FILE = previousArgsFile;
			if (previousPidFile === undefined)
				delete process.env.WT_FIXTURE_TASKKILL_PID_FILE;
			else process.env.WT_FIXTURE_TASKKILL_PID_FILE = previousPidFile;
		}
		const elapsedMs = Date.now() - startedAt;

		expect(readFileSync(taskkill.argsFile, "utf8").trim().split("\n")).toEqual([
			"/PID",
			String(child.pid),
			"/T",
			"/F",
		]);
		expect(cleanupError?.message).toContain("taskkill timed out after 1500ms");
		expect(elapsedMs).toBeLessThan(3_000);
		await expectPidExit(child.pid as number);
		await expectProcessExit(descendantPidFile);
		await expectProcessExit(taskkill.pidFile);
	},
);

test.serial.skipIf(process.platform === "win32")(
	"win32 tree cleanup rejects when taskkill cannot start",
	async () => {
		const root = mkdtempSync(
			join(tmpdir(), "wt-package-smoke-missing-taskkill-"),
		);
		tempRoots.push(root);
		const startedAt = Date.now();
		const cleanupError = await capturedError(
			runBoundedWindowsTreeKill(123_456, 1_500, join(root, "missing-taskkill")),
		);

		expect(cleanupError?.message).toContain("taskkill failed to start");
		expect(Date.now() - startedAt).toBeLessThan(3_000);
	},
);

test.serial.skipIf(process.platform === "win32")(
	"win32 tree cleanup rejects nonzero taskkill without claiming a live descendant was removed",
	async () => {
		const root = mkdtempSync(
			join(tmpdir(), "wt-package-smoke-failing-taskkill-"),
		);
		tempRoots.push(root);
		const descendantPidFile = join(root, "descendant.pid");
		const child = spawnHangingProcessTree(descendantPidFile);
		await waitForFile(descendantPidFile);
		const cleanupError = await capturedError(
			runBoundedWindowsTreeKill(
				child.pid as number,
				1_500,
				createFailingTaskkill(root),
			),
		);
		const descendantPid = Number.parseInt(
			readFileSync(descendantPidFile, "utf8"),
			10,
		);

		expect(cleanupError?.message).toContain("taskkill exited with code 23");
		expect(cleanupError?.message).toContain("fixture taskkill stdout");
		expect(cleanupError?.message).toContain("fixture taskkill stderr");
		expect(processIsAlive(child.pid as number)).toBe(true);
		expect(processIsAlive(descendantPid)).toBe(true);
	},
);

test.serial.skipIf(process.platform === "win32")(
	"bounded command reports unproven win32 cleanup and uses its direct-child fallback",
	async () => {
		const runPackageCommand = packageCommandRunner();
		if (!runPackageCommand) return;
		const root = mkdtempSync(
			join(tmpdir(), "wt-package-command-cleanup-failure-"),
		);
		tempRoots.push(root);
		const descendantPidFile = join(root, "descendant.pid");
		trackedPidFiles.push(descendantPidFile);
		const cleanupError = await capturedError(
			runPackageCommand(
				process.execPath,
				["-e", hangingProcessTreeSource(descendantPidFile, true)],
				{
					cwd: root,
					label: "fixture windows command",
					platform: "win32",
					timeoutMs: 1_500,
					windowsTreeKillCommand: createFailingTaskkill(root),
				},
			),
		);
		await waitForFile(descendantPidFile);
		const descendantPid = Number.parseInt(
			readFileSync(descendantPidFile, "utf8"),
			10,
		);

		expect(cleanupError?.message).toContain(
			"process-tree cleanup failed: taskkill exited with code 23",
		);
		expect(cleanupError?.message).toContain("fixture command stdout");
		expect(cleanupError?.message).toContain("fixture command stderr");
		expect(processIsAlive(descendantPid)).toBe(true);
	},
);

test.serial.skipIf(process.platform === "win32")(
	"posix cleanup stops waiting once the process tree has exited",
	async () => {
		const runPackageCommand = packageCommandRunner();
		if (!runPackageCommand) return;
		const root = mkdtempSync(join(tmpdir(), "wt-package-cleanup-prompt-"));
		tempRoots.push(root);
		const descendantPidFile = join(root, "descendant.pid");
		trackedPidFiles.push(descendantPidFile);
		const startedAt = Date.now();
		const cleanupError = await capturedError(
			runPackageCommand(
				process.execPath,
				["-e", hangingProcessTreeSource(descendantPidFile)],
				{
					cwd: root,
					killGraceMs: 3_000,
					label: "fixture prompt-exit command",
					timeoutMs: 500,
					treeKillTimeoutMs: 3_000,
				},
			),
		);
		const elapsedMs = Date.now() - startedAt;

		expect(cleanupError?.message).toContain("timed out after 500ms");
		expect(cleanupError?.message).not.toContain("unproven");
		expect(elapsedMs).toBeLessThan(2_000);
	},
);

test.serial.skipIf(process.platform === "win32")(
	"posix cleanup proves descendant exit before reporting the timeout",
	async () => {
		const runPackageCommand = packageCommandRunner();
		if (!runPackageCommand) return;
		const root = mkdtempSync(join(tmpdir(), "wt-package-cleanup-proof-"));
		tempRoots.push(root);
		const descendantPidFile = join(root, "descendant.pid");
		trackedPidFiles.push(descendantPidFile);
		const cleanupError = await capturedError(
			runPackageCommand(
				process.execPath,
				["-e", stubbornProcessTreeSource(descendantPidFile)],
				{
					cwd: root,
					killGraceMs: 200,
					label: "fixture stubborn command",
					timeoutMs: 750,
					treeKillTimeoutMs: 3_000,
				},
			),
		);
		const descendantPid = Number.parseInt(
			readFileSync(descendantPidFile, "utf8"),
			10,
		);

		expect(cleanupError?.message).toContain("timed out after 750ms");
		expect(cleanupError?.message).not.toContain("unproven");
		expect(processIsAlive(descendantPid)).toBe(false);
	},
);

test.serial.skipIf(process.platform === "win32")(
	"posix cleanup reports descendant exit unproven when it cannot prove the tree died",
	async () => {
		const runPackageCommand = packageCommandRunner();
		if (!runPackageCommand) return;
		const root = mkdtempSync(join(tmpdir(), "wt-package-cleanup-unproven-"));
		tempRoots.push(root);
		const descendantPidFile = join(root, "descendant.pid");
		trackedPidFiles.push(descendantPidFile);
		const cleanupError = await capturedError(
			runPackageCommand(
				process.execPath,
				["-e", stubbornProcessTreeSource(descendantPidFile)],
				{
					cwd: root,
					killGraceMs: 50,
					label: "fixture unprovable command",
					timeoutMs: 750,
					treeKillTimeoutMs: 0,
				},
			),
		);

		expect(cleanupError?.message).toContain("timed out after 750ms");
		expect(cleanupError?.message).toContain("descendant exit unproven");
		await expectProcessExit(descendantPidFile);
	},
);

test.serial.skipIf(process.platform === "win32")(
	"win32 cleanup does not claim success when taskkill leaves the tree alive",
	async () => {
		const runPackageCommand = packageCommandRunner();
		if (!runPackageCommand) return;
		const root = mkdtempSync(join(tmpdir(), "wt-package-cleanup-win32-noop-"));
		tempRoots.push(root);
		const descendantPidFile = join(root, "descendant.pid");
		trackedPidFiles.push(descendantPidFile);
		const cleanupError = await capturedError(
			runPackageCommand(
				process.execPath,
				["-e", stubbornProcessTreeSource(descendantPidFile)],
				{
					cwd: root,
					killGraceMs: 50,
					label: "fixture win32 noop-taskkill command",
					platform: "win32",
					timeoutMs: 750,
					treeKillTimeoutMs: 250,
					windowsTreeKillCommand: createNoopTaskkill(root),
				},
			),
		);
		await waitForFile(descendantPidFile);
		const descendantPid = Number.parseInt(
			readFileSync(descendantPidFile, "utf8"),
			10,
		);

		expect(cleanupError?.message).toContain("timed out after 750ms");
		expect(cleanupError?.message).toContain("descendant exit unproven");
		expect(cleanupError?.message).not.toContain("cleanup failed");
		expect(processIsAlive(descendantPid)).toBe(true);
	},
);

test.serial.skipIf(process.platform === "win32")(
	"canonical package check bounds a hanging non-smoke npm command",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "wt-package-command-timeout-"));
		tempRoots.push(root);
		createHangingNpm(root);
		const startedAt = Date.now();
		const result = await runGuarded(
			["scripts/test-package-artifact.ts", "check"],
			{
				...process.env,
				PATH: `${root}:${process.env.PATH ?? ""}`,
				WEBTRANSPORT_PACKAGE_COMMAND_TIMEOUT_MS: "1500",
			},
		);

		expect(result.error).toBeUndefined();
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("npm pack timed out after 1500ms");
		expect(result.stderr).toContain("fixture package helper stdout");
		expect(result.stderr).toContain("fixture package helper stderr");
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	},
);
