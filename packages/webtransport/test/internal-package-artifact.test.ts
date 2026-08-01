import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
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
		label: string;
		platform?: NodeJS.Platform;
		timeoutMs: number;
		processTreeProbe?: (rootPid: number) => Promise<{
			rootAlive: boolean;
			descendantAlive: boolean;
		}>;
		windowsTreeKillCommand?: string;
	},
) => Promise<string>;

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const tempRoots: string[] = [];
const trackedPidFiles: string[] = [];
const trackedPids: number[] = [];

setDefaultTimeout(15_000);

afterEach(async () => {
	const pidsToReap = new Set(trackedPids.splice(0));
	for (const pidFile of trackedPidFiles) {
		if (!existsSync(pidFile)) continue;
		const pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
		if (Number.isFinite(pid)) pidsToReap.add(pid);
	}
	for (const pid of pidsToReap) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// The production timeout cleanup should normally have removed it.
		}
	}
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline && [...pidsToReap].some(processIsAlive)) {
		await Bun.sleep(25);
	}
	for (const pid of pidsToReap) expect(processIsAlive(pid)).toBe(false);
	trackedPidFiles.splice(0);
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function createFixtureTarball(root: string): string {
	const pkgDir = join(root, "fixture-package");
	const npmCache = join(root, "npm-cache");
	mkdirSync(pkgDir, { recursive: true });
	mkdirSync(npmCache, { recursive: true });
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
		encoding: "utf8",
		env: {
			...process.env,
			NPM_CONFIG_CACHE: npmCache,
		},
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

function createHangingRuntime(
	root: string,
	descendantPidFile: string,
	startedFile: string,
): string {
	const source = join(root, "fake-deno.c");
	const runtime = join(root, "fake-deno");
	const launcher = join(root, "fake-deno-launcher.sh");
	writeFileSync(
		source,
		[
			"#include <fcntl.h>",
			"#include <stdio.h>",
			"#include <stdlib.h>",
			"#include <string.h>",
			"#include <sys/types.h>",
			"#include <unistd.h>",
			"static void write_text(const char *path, const char *text) {",
			"  if (path == NULL) return;",
			"  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0600);",
			"  if (fd < 0) return;",
			"  (void)write(fd, text, strlen(text));",
			"  close(fd);",
			"}",
			"int main(int argc, char **argv) {",
			'  if (argc > 1 && strcmp(argv[1], "--version") == 0) {',
			'    puts("deno 2.9.3");',
			"    return 0;",
			"  }",
			"  pid_t child = fork();",
			"  if (child < 0) return 1;",
			"  if (child == 0) {",
			'    execlp("sleep", "sleep", "1000", (char *)NULL);',
			"    _exit(127);",
			"  }",
			"  char pid[32];",
			'  snprintf(pid, sizeof(pid), "%d", (int)child);',
			'  write_text(getenv("WT_FIXTURE_DESCENDANT_PID_FILE"), pid);',
			'  puts("fixture smoke started");',
			'  fputs("fixture smoke stderr\\n", stderr);',
			"  fflush(stdout);",
			"  fflush(stderr);",
			"  for (;;) pause();",
			"}",
		].join("\n"),
		"utf8",
	);
	const compiled = spawnSync("cc", ["-O2", source, "-o", runtime], {
		encoding: "utf8",
		timeout: 5_000,
		killSignal: "SIGKILL",
	});
	if (compiled.status !== 0) {
		throw new Error(
			`fixture C runtime compilation failed (${compiled.status ?? compiled.signal ?? "unknown"})\n${compiled.stdout ?? ""}${compiled.stderr ?? ""}`,
		);
	}
	writeFileSync(
		launcher,
		[
			"#!/bin/sh",
			'if [ "${1:-}" = "--version" ]; then',
			'  printf "deno 2.9.3\\n"',
			"  exit 0",
			"fi",
			`  printf "started" > '${startedFile.replaceAll("'", "'\\''")}'`,
			`exec '${runtime.replaceAll("'", "'\\''")}' "$@"`,
			"",
		].join("\n"),
		"utf8",
	);
	chmodSync(launcher, 0o755);
	trackedPidFiles.push(descendantPidFile);
	return launcher;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		if (process.platform !== "win32") {
			const psResult = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
				encoding: "utf8",
			});
			if (!psResult.error) {
				const state = (psResult.stdout ?? "").trim();
				if (state.length === 0) return false;
				if (state.startsWith("Z")) return false;
			}
		}
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
	while (Date.now() < deadline) {
		if (!processIsAlive(pid)) return;
		await Bun.sleep(25);
	}
	expect(processIsAlive(pid)).toBe(false);
}

async function fileAppearsWithin(
	file: string,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(file) && Date.now() < deadline) {
		await Bun.sleep(25);
	}
	return existsSync(file);
}

async function waitForFile(file: string, timeoutMs = 3_000): Promise<void> {
	expect(await fileAppearsWithin(file, timeoutMs)).toBe(true);
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
		'const { writeFileSync, writeSync } = require("node:fs");',
		...(emitDiagnostics
			? [
					'writeSync(1, "fixture command stdout\\n");',
					'writeSync(2, "fixture command stderr\\n");',
				]
			: []),
		`const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: "ignore" });`,
		`writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
		"setInterval(() => {}, 1_000);",
	].join("\n");
}

function delayedDescendantOutputSource(
	descendantPidFile: string,
	triggerPath: string,
): string {
	const markerPath = `${descendantPidFile}.late`;
	const descendantSource = [
		'const { existsSync, writeFileSync, writeSync } = require("node:fs");',
		`const trigger = ${JSON.stringify(triggerPath)};`,
		"const poll = setInterval(() => {",
		"  if (!existsSync(trigger)) return;",
		"  clearInterval(poll);",
		`  setTimeout(() => { writeFileSync(${JSON.stringify(markerPath)}, "done"); writeSync(1, "late descendant stdout\\n"); writeSync(2, "late descendant stderr\\n"); }, 300);`,
		"}, 5);",
		"setInterval(() => {}, 1_000);",
	].join("\n");
	return [
		'const { spawn } = require("node:child_process");',
		'const { writeFileSync, writeSync } = require("node:fs");',
		'writeSync(1, "fixture command stdout\\n");',
		'writeSync(2, "fixture command stderr\\n");',
		`const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], { stdio: ["ignore", 1, 2] });`,
		`writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid));`,
		"setInterval(() => {}, 1_000);",
	].join("\n");
}

async function runGuarded(
	args: string[],
	env: NodeJS.ProcessEnv,
	guardTimeoutMs = 5_000,
): Promise<{
	error?: Error;
	status: number | null;
	stdout: string;
	stderr: string;
}> {
	return await new Promise((resolve) => {
		const child = spawn(process.execPath, args, {
			cwd: PROJECT_ROOT,
			// The outer guard only owns this launcher; the package command itself
			// performs the process-tree cleanup under test. Avoid adding a second
			// detached process-group setup to the exact smoke startup path.
			detached: false,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let guardExpired = false;
		let guard: ReturnType<typeof setTimeout> | undefined;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("spawn", () => {
			guard = setTimeout(() => {
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
			}, guardTimeoutMs);
		});
		child.once("close", (status) => {
			if (guard !== undefined) clearTimeout(guard);
			resolve({
				error: guardExpired
					? new Error(`test process exceeded its ${guardTimeoutMs}ms guard`)
					: undefined,
				status,
				stdout,
				stderr,
			});
		});
		child.once("error", (error) => {
			if (guard !== undefined) clearTimeout(guard);
			resolve({ error, status: null, stdout, stderr });
		});
	});
}

function createHangingTaskkill(
	root: string,
	descendantPidFile: string,
): {
	argsFile: string;
	pidFile: string;
} {
	const taskkill = join(root, "taskkill");
	const argsFile = join(root, "taskkill-args.txt");
	const pidFile = join(root, "taskkill.pid");
	writeFileSync(
		taskkill,
		[
			`#!${process.execPath}`,
			'const { readFileSync, writeFileSync } = require("node:fs");',
			"const args = process.argv.slice(2);",
			'writeFileSync(process.env.WT_FIXTURE_TASKKILL_ARGS_FILE, `${args.join("\\n")}\\n`);',
			"writeFileSync(process.env.WT_FIXTURE_TASKKILL_PID_FILE, String(process.pid));",
			`const descendantPid = Number(readFileSync(${JSON.stringify(descendantPidFile)}, "utf8"));`,
			'try { process.kill(descendantPid, "SIGKILL"); } catch {}',
			"setTimeout(() => {}, 50);",
			"setInterval(() => {}, 1_000);",
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
			`#!${process.execPath}`,
			'console.log("fixture taskkill stdout");',
			'console.error("fixture taskkill stderr");',
			"process.exit(23);",
		].join("\n"),
		"utf8",
	);
	chmodSync(taskkill, 0o755);
	return taskkill;
}

function createRootOnlyTaskkill(root: string, triggerPath?: string): string {
	const taskkill = join(root, "root-only-taskkill");
	writeFileSync(
		taskkill,
		[
			`#!${process.execPath}`,
			'const { writeFileSync } = require("node:fs");',
			'try { process.kill(Number(process.argv[3]), "SIGKILL"); } catch {}',
			...(triggerPath
				? [`writeFileSync(${JSON.stringify(triggerPath)}, "");`]
				: []),
			"process.exit(0);",
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
			'printf "fixture package helper stdout\\n"',
			'printf "fixture package helper stderr\\n" >&2',
			"exec sleep 1000",
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

function readPid(pidFile: string): number {
	return Number.parseInt(readFileSync(pidFile, "utf8"), 10);
}

async function probeFixtureTree(
	rootPid: number,
	descendantPidFile: string,
): Promise<{
	rootAlive: boolean;
	descendantAlive: boolean;
}> {
	await waitForFile(descendantPidFile);
	return {
		rootAlive: processIsAlive(rootPid),
		descendantAlive: processIsAlive(readPid(descendantPidFile)),
	};
}

function packageCommandRunner(): PackageCommandRunner | undefined {
	const candidate = (packageArtifact as Record<string, unknown>)
		.runPackageCommand;
	expect(typeof candidate).toBe("function");
	return typeof candidate === "function"
		? (candidate as PackageCommandRunner)
		: undefined;
}

describe.serial("package artifact cleanup", () => {
	test.serial(
		"exact-package smoke kills its hanging runtime descendant and preserves diagnostics",
		async () => {
			if (process.platform === "win32") return;
			const root = mkdtempSync(join(tmpdir(), "wt-package-smoke-test-"));
			tempRoots.push(root);
			const tarball = createFixtureTarball(root);
			const descendantPidFile = join(root, "descendant.pid");
			const smokeStartedFile = join(root, "smoke.started");
			const runtime = createHangingRuntime(
				root,
				descendantPidFile,
				smokeStartedFile,
			);
			const fixtureEnv = {
				...process.env,
				WEBTRANSPORT_DENO_COMMAND: runtime,
				WEBTRANSPORT_PACKAGE_SMOKE_TIMEOUT_MS: "1500",
				WEBTRANSPORT_PACKAGE_SMOKE_KILL_GRACE_MS: "100",
				WEBTRANSPORT_PACKAGE_SMOKE_TREE_KILL_TIMEOUT_MS: "1000",
				NPM_CONFIG_OFFLINE: "true",
				WT_FIXTURE_DESCENDANT_PID_FILE: descendantPidFile,
			};
			const guardedResult = runGuarded(
				[
					"scripts/test-package-artifact.ts",
					"smoke",
					tarball,
					"--runtime",
					"deno",
				],
				fixtureEnv,
				45_000,
			);
			// Wait for the fixture's durable startup marker before starting the
			// cleanup stopwatch. The smoke deadline still starts in the production
			// command after its child has spawned; this assertion measures only the
			// bounded cleanup path and cannot turn delayed fixture startup into a
			// cleanup failure.
			const smokeStarted = await fileAppearsWithin(smokeStartedFile, 30_000);
			const startedAt = Date.now();
			const result = await guardedResult;
			const elapsedMs = Date.now() - startedAt;

			if (!smokeStarted) {
				const tail = (value: string) => value.slice(-4_000);
				throw new Error(
					[
						"exact-package smoke fixture did not start",
						`guard status: ${result.status ?? "none"}`,
						`guard error: ${result.error?.message ?? "none"}`,
						`guard stdout tail:\n${tail(result.stdout)}`,
						`guard stderr tail:\n${tail(result.stderr)}`,
					].join("\n"),
				);
			}
			expect(smokeStarted).toBe(true);
			expect(result.error).toBeUndefined();
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("deno smoke timed out after 1500ms");
			expect(result.stderr).toContain("fixture smoke started");
			expect(result.stderr).toContain("fixture smoke stderr");
			expect(elapsedMs).toBeLessThan(5_000);
			await waitForFile(descendantPidFile);
			await expectProcessExit(descendantPidFile);
		},
		60_000,
	);

	test.serial(
		"win32 taskkill removes a genuine runtime descendant",
		async () => {
			if (process.platform !== "win32") return;
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

	test.serial(
		"mocked win32 tree cleanup bounds taskkill and removes a genuine descendant",
		async () => {
			if (process.platform === "win32") return;
			const root = mkdtempSync(join(tmpdir(), "wt-package-smoke-win32-test-"));
			tempRoots.push(root);
			const descendantPidFile = join(root, "descendant.pid");
			const child = spawnHangingProcessTree(descendantPidFile);
			const taskkill = createHangingTaskkill(root, descendantPidFile);
			await waitForFile(descendantPidFile);
			const previousArgsFile = process.env.WT_FIXTURE_TASKKILL_ARGS_FILE;
			const previousPidFile = process.env.WT_FIXTURE_TASKKILL_PID_FILE;
			process.env.WT_FIXTURE_TASKKILL_ARGS_FILE = taskkill.argsFile;
			process.env.WT_FIXTURE_TASKKILL_PID_FILE = taskkill.pidFile;
			const startedAt = Date.now();
			const taskkillTimeoutMs = 3_000;
			let cleanupError: Error | undefined;
			const cleanupPromise = capturedError(
				runBoundedWindowsTreeKill(
					child.pid as number,
					taskkillTimeoutMs,
					join(root, "taskkill"),
				),
			);
			try {
				// The mocked command writes its invocation evidence before sleeping.
				// Wait for that bounded proof while the fixture environment is still
				// installed; otherwise a loaded host can time out before /bin/sh has
				// flushed the files, making the assertion race the test cleanup.
				await waitForFile(taskkill.argsFile);
				cleanupError = await cleanupPromise;
			} finally {
				if (previousArgsFile === undefined)
					delete process.env.WT_FIXTURE_TASKKILL_ARGS_FILE;
				else process.env.WT_FIXTURE_TASKKILL_ARGS_FILE = previousArgsFile;
				if (previousPidFile === undefined)
					delete process.env.WT_FIXTURE_TASKKILL_PID_FILE;
				else process.env.WT_FIXTURE_TASKKILL_PID_FILE = previousPidFile;
			}
			const elapsedMs = Date.now() - startedAt;

			expect(
				readFileSync(taskkill.argsFile, "utf8").trim().split("\n"),
			).toEqual(["/PID", String(child.pid), "/T", "/F"]);
			expect(cleanupError?.message).toContain(
				`taskkill timed out after ${taskkillTimeoutMs}ms`,
			);
			expect(elapsedMs).toBeLessThan(5_000);
			await expectPidExit(child.pid as number);
			await expectProcessExit(descendantPidFile);
			await expectProcessExit(taskkill.pidFile);
		},
	);

	test.serial(
		"win32 tree cleanup rejects when taskkill cannot start",
		async () => {
			if (process.platform === "win32") return;
			const root = mkdtempSync(
				join(tmpdir(), "wt-package-smoke-missing-taskkill-"),
			);
			tempRoots.push(root);
			const startedAt = Date.now();
			const cleanupError = await capturedError(
				runBoundedWindowsTreeKill(
					123_456,
					1_500,
					join(root, "missing-taskkill"),
				),
			);

			expect(cleanupError?.message).toContain("taskkill failed to start");
			expect(Date.now() - startedAt).toBeLessThan(3_000);
		},
	);

	test.serial(
		"win32 tree cleanup rejects nonzero taskkill without claiming a live descendant was removed",
		async () => {
			if (process.platform === "win32") return;
			const root = mkdtempSync(
				join(tmpdir(), "wt-package-smoke-failing-taskkill-"),
			);
			tempRoots.push(root);
			const descendantPidFile = join(root, "descendant.pid");
			const child = spawnHangingProcessTree(descendantPidFile);
			await waitForFile(descendantPidFile);
			const taskkillTimeoutMs = 3_000;
			const cleanupError = await capturedError(
				runBoundedWindowsTreeKill(
					child.pid as number,
					taskkillTimeoutMs,
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

	test.serial(
		"bounded command reports unproven win32 cleanup and uses its direct-child fallback",
		async () => {
			if (process.platform === "win32") return;
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

	test.serial(
		"bounded command preserves late descendant output when win32 cleanup cannot prove exit",
		async () => {
			if (process.platform === "win32") return;
			const runPackageCommand = packageCommandRunner();
			if (!runPackageCommand) return;
			const root = mkdtempSync(
				join(tmpdir(), "wt-package-command-win32-descendant-proof-"),
			);
			tempRoots.push(root);
			const descendantPidFile = join(root, "descendant.pid");
			const triggerPath = join(root, "late.trigger");
			trackedPidFiles.push(descendantPidFile);
			const cleanupError = await capturedError(
				runPackageCommand(
					process.execPath,
					["-e", delayedDescendantOutputSource(descendantPidFile, triggerPath)],
					{
						cwd: root,
						label: "fixture windows command",
						platform: "win32",
						timeoutMs: 1_500,
						processTreeProbe: (rootPid) =>
							probeFixtureTree(rootPid, descendantPidFile),
						windowsTreeKillCommand: createRootOnlyTaskkill(root, triggerPath),
					},
				),
			);
			await waitForFile(descendantPidFile);
			await waitForFile(`${descendantPidFile}.late`);
			const descendantPid = readPid(descendantPidFile);

			expect(cleanupError?.message).toContain(
				"process-tree cleanup failed: descendant exit unproven after taskkill exit 0",
			);
			expect(cleanupError?.message).toContain("fixture command stdout");
			expect(cleanupError?.message).toContain("fixture command stderr");
			expect(cleanupError?.message).toContain("late descendant stdout");
			expect(cleanupError?.message).toContain("late descendant stderr");
			expect(processIsAlive(descendantPid)).toBe(true);
			try {
				process.kill(descendantPid, "SIGKILL");
			} catch {
				// The negative control explicitly reaps its live descendant before returning.
			}
			await expectPidExit(descendantPid);
		},
	);

	test.serial(
		"bounded command labels POSIX direct-child fallback as descendant exit unproven",
		async () => {
			if (process.platform === "win32") return;
			const runPackageCommand = packageCommandRunner();
			if (!runPackageCommand) return;
			const root = mkdtempSync(
				join(tmpdir(), "wt-package-command-posix-direct-child-fallback-"),
			);
			tempRoots.push(root);
			const originalKill = process.kill.bind(process);
			process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
				if (pid < 0) {
					throw new Error("fixture process-group kill unavailable");
				}
				return originalKill(pid, signal);
			}) as typeof process.kill;
			let cleanupError: Error | undefined;
			try {
				cleanupError = await capturedError(
					runPackageCommand(
						process.execPath,
						[
							"-e",
							'process.stdout.write("fixture command stdout\\n"); process.stderr.write("fixture command stderr\\n"); setInterval(() => {}, 1_000);',
						],
						{
							cwd: root,
							label: "fixture posix command",
							timeoutMs: 1_500,
						},
					),
				);
			} finally {
				process.kill = originalKill;
			}

			expect(cleanupError?.message).toContain(
				"process-tree cleanup failed: descendant exit unproven after direct-child fallback",
			);
			expect(cleanupError?.message).toContain("fixture command stdout");
			expect(cleanupError?.message).toContain("fixture command stderr");
		},
	);

	test.serial(
		"bounded command rejects POSIX cleanup when process-group proof stays unverified",
		async () => {
			if (process.platform === "win32") return;
			const runPackageCommand = packageCommandRunner();
			if (!runPackageCommand) return;
			const root = mkdtempSync(
				join(tmpdir(), "wt-package-command-posix-proof-timeout-"),
			);
			tempRoots.push(root);
			const previousKillGrace =
				process.env.WEBTRANSPORT_PACKAGE_SMOKE_KILL_GRACE_MS;
			const originalKill = process.kill.bind(process);
			const previousTreeKillTimeout =
				process.env.WEBTRANSPORT_PACKAGE_SMOKE_TREE_KILL_TIMEOUT_MS;
			process.env.WEBTRANSPORT_PACKAGE_SMOKE_KILL_GRACE_MS = "350";
			process.env.WEBTRANSPORT_PACKAGE_SMOKE_TREE_KILL_TIMEOUT_MS = "100";
			process.kill = ((pid: number, signal?: number | NodeJS.Signals) => {
				if (
					pid < 0 &&
					(signal === 0 || signal === undefined || signal === "SIGKILL")
				) {
					return true as never;
				}
				return originalKill(pid, signal);
			}) as typeof process.kill;
			let cleanupError: Error | undefined;
			const startedAt = Date.now();
			try {
				cleanupError = await capturedError(
					runPackageCommand(
						process.execPath,
						["-e", "setInterval(() => {}, 1_000);"],
						{
							cwd: root,
							label: "fixture posix command",
							timeoutMs: 600,
						},
					),
				);
			} finally {
				process.kill = originalKill;
				if (previousKillGrace === undefined) {
					delete process.env.WEBTRANSPORT_PACKAGE_SMOKE_KILL_GRACE_MS;
				} else {
					process.env.WEBTRANSPORT_PACKAGE_SMOKE_KILL_GRACE_MS =
						previousKillGrace;
				}
				if (previousTreeKillTimeout === undefined) {
					delete process.env.WEBTRANSPORT_PACKAGE_SMOKE_TREE_KILL_TIMEOUT_MS;
				} else {
					process.env.WEBTRANSPORT_PACKAGE_SMOKE_TREE_KILL_TIMEOUT_MS =
						previousTreeKillTimeout;
				}
			}
			const elapsedMs = Date.now() - startedAt;

			expect(cleanupError?.message).toContain(
				"process-tree cleanup failed: descendant exit unproven after bounded process-group proof",
			);
			expect(elapsedMs).toBeLessThan(900);
		},
	);

	test.serial(
		"canonical package check bounds a hanging non-smoke npm command",
		async () => {
			if (process.platform === "win32") return;
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
					WEBTRANSPORT_PACKAGE_SMOKE_KILL_GRACE_MS: "100",
					WEBTRANSPORT_PACKAGE_SMOKE_TREE_KILL_TIMEOUT_MS: "250",
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
});
