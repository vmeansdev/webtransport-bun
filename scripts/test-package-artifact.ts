import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync } from "node:fs";
import {
	access,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PackFile = { path: string };
type PackResult = { filename?: string; files?: PackFile[] };
type Runtime = "bun" | "node" | "deno";
type Fingerprint = { files: string[]; sha256: Record<string, string> };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "packages", "webtransport");
const prebuildDir = path.join(packageDir, "prebuilds");
const wasmDistDir = path.join(packageDir, "wasm-dist");
const smokeSourceDir = path.join(root, "tools", "package-smoke");
const npmCacheDir = mkdtempSync(path.join(tmpdir(), "webtransport-npm-cache-"));
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_SMOKE_TIMEOUT_MS = 60_000;
const DEFAULT_SMOKE_KILL_GRACE_MS = 250;
const DEFAULT_SMOKE_TREE_KILL_TIMEOUT_MS = 5_000;
process.on("exit", () => rmSync(npmCacheDir, { recursive: true, force: true }));

function sharedEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		NPM_CONFIG_CACHE: npmCacheDir,
		WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
		WEBTRANSPORT_SUPPRESS_UNHANDLED_STREAM_ERROR_LOGS: "1",
		DENO_NO_UPDATE_CHECK: "1",
	};
}

function envInteger(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function formatCapturedOutput(stdout: string, stderr: string): string {
	const sections: string[] = [];
	if (stdout.length > 0) sections.push(`stdout:\n${stdout}`);
	if (stderr.length > 0) sections.push(`stderr:\n${stderr}`);
	return sections.length > 0 ? `\n${sections.join("\n")}` : "";
}

function wait(delayMs: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function closeQuietly(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		closeSync(fd);
	} catch {
		// Best-effort cleanup for parent-side capture handles.
	}
}

async function readCapturedText(file: string): Promise<string> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		const code =
			typeof error === "object" && error !== null && "code" in error
				? String((error as { code?: unknown }).code)
				: "";
		if (code === "ENOENT") return "";
		throw error;
	}
}

function signalPosixProcessTree(
	pid: number,
	child: ReturnType<typeof spawn>,
	signal: NodeJS.Signals,
): void {
	try {
		process.kill(-pid, signal);
		return;
	} catch {
		// Fall back to the direct child when process-group signaling is unavailable.
	}
	try {
		child.kill(signal);
	} catch {
		// Best-effort cleanup after a smoke timeout.
	}
}

export async function runBoundedWindowsTreeKill(
	pid: number,
	timeoutMs: number,
	command = "taskkill",
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let killer: ReturnType<typeof spawn>;
		try {
			killer = spawn(command, ["/PID", String(pid), "/T", "/F"], {
				env: sharedEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			reject(new Error(`taskkill failed to start: ${detail}`));
			return;
		}

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
			if (error) reject(error);
			else resolve();
		};
		const fail = (message: string) =>
			finish(new Error(`${message}${formatCapturedOutput(stdout, stderr)}`));

		killer.stdout?.setEncoding("utf8");
		killer.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		killer.stderr?.setEncoding("utf8");
		killer.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		killer.once("error", (error) =>
			fail(`taskkill failed to start: ${error.message}`),
		);
		killer.once("close", (code, signal) => {
			if (signal) {
				fail(`taskkill terminated by signal ${signal}`);
				return;
			}
			if ((code ?? 0) !== 0) {
				fail(`taskkill exited with code ${code}`);
				return;
			}
			finish();
		});
		timeoutHandle = setTimeout(() => {
			try {
				killer.kill("SIGKILL");
			} catch {
				// The killer may already have exited between the timer and this call.
			}
			killer.stdout?.destroy();
			killer.stderr?.destroy();
			killer.unref();
			fail(`taskkill timed out after ${timeoutMs}ms`);
		}, timeoutMs);
	});
}

async function terminateCommandProcessTree(
	child: ReturnType<typeof spawn>,
	killGraceMs: number,
	treeKillTimeoutMs: number,
	platform: NodeJS.Platform,
	windowsTreeKillCommand?: string,
): Promise<Error | undefined> {
	if (child.pid === undefined) return undefined;
	if (platform === "win32") {
		let cleanupError: Error | undefined;
		try {
			await runBoundedWindowsTreeKill(
				child.pid,
				treeKillTimeoutMs,
				windowsTreeKillCommand,
			);
		} catch (error) {
			cleanupError = error instanceof Error ? error : new Error(String(error));
		}
		try {
			child.kill("SIGKILL");
		} catch {
			// taskkill owns whole-tree cleanup; this is a direct-child fallback only.
		}
		return cleanupError;
	}

	signalPosixProcessTree(child.pid, child, "SIGTERM");
	await wait(killGraceMs);
	signalPosixProcessTree(child.pid, child, "SIGKILL");
	return undefined;
}

export async function runPackageCommand(
	command: string,
	args: string[],
	options: {
		cwd?: string;
		echoOutput?: boolean;
		label?: string;
		platform?: NodeJS.Platform;
		timeoutMs?: number;
		windowsTreeKillCommand?: string;
	},
): Promise<string> {
	const timeoutMs =
		options.timeoutMs ??
		envInteger(
			"WEBTRANSPORT_PACKAGE_COMMAND_TIMEOUT_MS",
			DEFAULT_COMMAND_TIMEOUT_MS,
		);
	const killGraceMs = envInteger(
		"WEBTRANSPORT_PACKAGE_SMOKE_KILL_GRACE_MS",
		DEFAULT_SMOKE_KILL_GRACE_MS,
	);
	const treeKillTimeoutMs = envInteger(
		"WEBTRANSPORT_PACKAGE_SMOKE_TREE_KILL_TIMEOUT_MS",
		DEFAULT_SMOKE_TREE_KILL_TIMEOUT_MS,
	);
	const platform = options.platform ?? process.platform;
	const label = options.label ?? `${command} ${args.join(" ")}`;

	return await new Promise<string>((resolve, reject) => {
		const captureDir = mkdtempSync(
			path.join(tmpdir(), "webtransport-command-capture-"),
		);
		const stdoutPath = path.join(captureDir, "stdout.log");
		const stderrPath = path.join(captureDir, "stderr.log");
		let stdoutFd: number | undefined;
		let stderrFd: number | undefined;
		let child: ReturnType<typeof spawn>;
		try {
			stdoutFd = openSync(stdoutPath, "w");
			stderrFd = openSync(stderrPath, "w");
			child = spawn(command, args, {
				cwd: options.cwd ?? root,
				env: sharedEnv(),
				detached: platform !== "win32",
				stdio: ["ignore", stdoutFd, stderrFd],
			});
		} catch (error) {
			closeQuietly(stdoutFd);
			closeQuietly(stderrFd);
			rmSync(captureDir, { recursive: true, force: true });
			const detail = error instanceof Error ? error.message : String(error);
			reject(new Error(`${label} failed to start: ${detail}`));
			return;
		}
		closeQuietly(stdoutFd);
		closeQuietly(stderrFd);

		let finished = false;
		let timedOut = false;
		let cleanupError: Error | undefined;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

		const cleanup = () => {
			if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
		};

		const finish = async (
			error?: Error,
			code?: number | null,
			signal?: NodeJS.Signals | null,
		): Promise<void> => {
			if (finished) return;
			finished = true;
			cleanup();
			let stdout = "";
			let stderr = "";
			try {
				[stdout, stderr] = await Promise.all([
					readCapturedText(stdoutPath),
					readCapturedText(stderrPath),
				]);
			} catch (captureError) {
				const detail =
					captureError instanceof Error
						? captureError.message
						: String(captureError);
				reject(new Error(`${label} could not read captured output: ${detail}`));
				return;
			} finally {
				await rm(captureDir, { recursive: true, force: true });
			}
			if (timedOut) {
				child.unref();
				const cleanupDetail = cleanupError
					? `; process-tree cleanup failed: ${cleanupError.message}`
					: "";
				reject(
					new Error(
						`${label} timed out after ${timeoutMs}ms${cleanupDetail}${formatCapturedOutput(stdout, stderr)}`,
					),
				);
				return;
			}
			if (error) {
				reject(
					new Error(
						`${label} failed to start: ${error.message}${formatCapturedOutput(stdout, stderr)}`,
					),
				);
				return;
			}
			if (signal) {
				reject(
					new Error(
						`${label} terminated by signal ${signal}${formatCapturedOutput(stdout, stderr)}`,
					),
				);
				return;
			}
			if ((code ?? 0) !== 0) {
				reject(
					new Error(
						`${label} exited with code ${code}${formatCapturedOutput(stdout, stderr)}`,
					),
				);
				return;
			}
			if (options.echoOutput && stdout.length > 0) process.stdout.write(stdout);
			if (options.echoOutput && stderr.length > 0) process.stderr.write(stderr);
			resolve(stdout);
		};

		child.once("error", (error) => {
			if (!timedOut) void finish(error);
		});
		child.once("close", (code, signal) => {
			if (!timedOut) void finish(undefined, code, signal);
		});

		timeoutHandle = setTimeout(() => {
			timedOut = true;
			void terminateCommandProcessTree(
				child,
				killGraceMs,
				treeKillTimeoutMs,
				platform,
				options.windowsTreeKillCommand,
			)
				.then((error) => {
					cleanupError = error;
				})
				.catch((error) => {
					cleanupError =
						error instanceof Error ? error : new Error(String(error));
				})
				.finally(() => void finish());
		}, timeoutMs);
	});
}

async function runSmokeCommand(
	command: string,
	args: string[],
	options: {
		cwd: string;
		label: string;
		echoOnSuccess?: boolean;
		timeoutMs?: number;
	},
): Promise<void> {
	await runPackageCommand(command, args, {
		cwd: options.cwd,
		echoOutput: options.echoOnSuccess !== false,
		label: options.label,
		timeoutMs:
			options.timeoutMs ??
			envInteger(
				"WEBTRANSPORT_PACKAGE_SMOKE_TIMEOUT_MS",
				DEFAULT_SMOKE_TIMEOUT_MS,
			),
	});
}

function parsePackResult(output: string): PackResult {
	const parsed = JSON.parse(output) as PackResult[];
	if (!parsed[0]?.files)
		throw new Error("npm pack did not return a file manifest");
	return parsed[0];
}

async function packResult(dryRun: boolean): Promise<PackResult> {
	const args = ["pack"];
	if (dryRun) args.push("--dry-run");
	args.push("--json", "--ignore-scripts");
	return parsePackResult(
		await runPackageCommand("npm", args, {
			cwd: packageDir,
			label: "npm pack",
		}),
	);
}

function normalizedPackFiles(result: PackResult): string[] {
	return (result.files ?? [])
		.map((file) => file.path.replaceAll("\\", "/"))
		.sort();
}

function assertPackageManifest(result: PackResult): string[] {
	const files = normalizedPackFiles(result);
	const fileSet = new Set(files);
	const required = [
		"package.json",
		"README.md",
		"LICENSE",
		"dist/index.js",
		"dist/index.d.ts",
		"dist/wasm.js",
		"dist/wasm.d.ts",
		"wasm-dist/PRODUCTION_BUILD.json",
		"wasm-dist/SHA256SUMS",
		"wasm-dist/node/package.json",
		"wasm-dist/node/webtransport_wasm.js",
		"wasm-dist/node/webtransport_wasm.d.ts",
		"wasm-dist/node/webtransport_wasm_bg.wasm",
		"wasm-dist/web/webtransport_wasm.js",
		"wasm-dist/web/webtransport_wasm.d.ts",
		"wasm-dist/web/webtransport_wasm_bg.wasm",
	];
	const missing = required.filter((file) => !fileSet.has(file));
	const currentLane = new RegExp(
		`^prebuilds/webtransport-native\\.${process.platform}-${process.arch}(?:-(?:msvc|gnu|musl))?\\.node$`,
	);
	if (!files.some((file) => currentLane.test(file))) {
		missing.push(
			`prebuilds/webtransport-native.${process.platform}-${process.arch}[variant].node`,
		);
	}
	if (!fileSet.has("prebuilds/SHA256SUMS")) {
		missing.push("prebuilds/SHA256SUMS");
	}
	if (missing.length > 0) {
		throw new Error(`package manifest is missing:\n- ${missing.join("\n- ")}`);
	}

	const forbidden = files.filter(
		(file) =>
			/(^|\/)(?:node_modules|target|test|tests|certs?|\.git)(?:\/|$)/i.test(
				file,
			) ||
			/(?:^|\/)(?:\.env(?:\..+)?|\.npmrc|(?:cert|key)\.pem|.+\.key)$/i.test(
				file,
			) ||
			(/\.ts$/.test(file) && !/\.d\.ts$/.test(file)) ||
			/(?:^|\/)pkg(?:\/|$)/.test(file) ||
			/dev-insecure/i.test(file),
	);
	if (forbidden.length > 0) {
		throw new Error(
			`package manifest contains forbidden files:\n- ${forbidden.join("\n- ")}`,
		);
	}
	return files;
}

async function sha256(file: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(file))
		.digest("hex");
}

async function filesWithSuffix(dir: string, suffix: string): Promise<string[]> {
	if (!existsSync(dir)) return [];
	return (await readdir(dir, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
		.map((entry) => entry.name)
		.sort();
}

async function writeChecksums(dir: string, files: string[]): Promise<void> {
	const lines: string[] = [];
	for (const file of files) {
		lines.push(`${await sha256(path.join(dir, file))}  ${file}`);
	}
	await writeFile(
		path.join(dir, "SHA256SUMS"),
		`${lines.join("\n")}\n`,
		"utf8",
	);
}

async function assertChecksums(dir: string, files: string[]): Promise<void> {
	const checksumPath = path.join(dir, "SHA256SUMS");
	const lines = (await readFile(checksumPath, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean);
	const expectedNames = new Set(files);
	if (lines.length !== files.length) {
		throw new Error(
			`${checksumPath} does not cover exactly ${files.length} files`,
		);
	}
	for (const line of lines) {
		const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
		const checksum = match?.[1];
		const file = match?.[2];
		if (!checksum || !file || !expectedNames.delete(file)) {
			throw new Error(`invalid or unexpected checksum line: ${line}`);
		}
		if ((await sha256(path.join(dir, file))) !== checksum) {
			throw new Error(`checksum mismatch: ${path.join(dir, file)}`);
		}
	}
	if (expectedNames.size > 0) {
		throw new Error(
			`checksum entries missing: ${[...expectedNames].join(", ")}`,
		);
	}
}

async function copyAndVerifyPrebuilds(sourceArg?: string): Promise<void> {
	const localNativeDir = path.join(root, "crates", "native");
	const source = sourceArg ? path.resolve(root, sourceArg) : localNativeDir;
	let binaries = await filesWithSuffix(source, ".node");
	if (binaries.length === 0 && !sourceArg) {
		await runPackageCommand("bun", ["run", "build:native"], {
			cwd: root,
			echoOutput: true,
		});
		binaries = await filesWithSuffix(source, ".node");
	}
	if (binaries.length === 0) {
		throw new Error(`no native prebuilds found in ${source}`);
	}

	if (path.resolve(source) !== path.resolve(prebuildDir)) {
		await rm(prebuildDir, { recursive: true, force: true });
		await mkdir(prebuildDir, { recursive: true });
		for (const binary of binaries) {
			await cp(path.join(source, binary), path.join(prebuildDir, binary));
		}
	}
	const packagedBinaries = await filesWithSuffix(prebuildDir, ".node");
	await writeChecksums(prebuildDir, packagedBinaries);
	await assertChecksums(prebuildDir, packagedBinaries);
}

async function assertReleasePrebuildTargets(): Promise<void> {
	const binaries = await filesWithSuffix(prebuildDir, ".node");
	const required: Array<[string, RegExp]> = [
		["macOS arm64", /^webtransport-native\.darwin-arm64\.node$/],
		["macOS x64", /^webtransport-native\.darwin-x64\.node$/],
		["Linux x64", /^webtransport-native\.linux-x64(?:-(?:gnu|musl))?\.node$/],
		["Windows x64", /^webtransport-native\.win32-x64(?:-msvc)?\.node$/],
	];
	const missing = required
		.filter(([, pattern]) => !binaries.some((binary) => pattern.test(binary)))
		.map(([target]) => target);
	if (missing.length > 0) {
		throw new Error(`release prebuild set is missing: ${missing.join(", ")}`);
	}
}

async function walkFiles(dir: string, prefix = ""): Promise<string[]> {
	const result: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory())
			result.push(...(await walkFiles(path.join(dir, entry.name), relative)));
		else if (entry.isFile()) result.push(relative);
	}
	return result.sort();
}

async function finalizeProductionWasm(): Promise<void> {
	// wasm-bindgen's `nodejs` target is CommonJS. Scope that generated glue away
	// from the published package's root `type: module` so `/wasm` can import it.
	await writeFile(
		path.join(wasmDistDir, "node", "package.json"),
		'{"private":true,"type":"commonjs"}\n',
		"utf8",
	);
	const marker = {
		schemaVersion: 1,
		profile: "release",
		devInsecure: false,
		targets: ["nodejs", "web"],
	};
	await writeFile(
		path.join(wasmDistDir, "PRODUCTION_BUILD.json"),
		`${JSON.stringify(marker, null, 2)}\n`,
		"utf8",
	);
	const wasmFiles = (await walkFiles(wasmDistDir)).filter(
		(file) => file !== "SHA256SUMS" && file !== "PRODUCTION_BUILD.json",
	);
	const checksumLines: string[] = [];
	for (const file of wasmFiles) {
		checksumLines.push(
			`${await sha256(path.join(wasmDistDir, file))}  ${file}`,
		);
	}
	await writeFile(
		path.join(wasmDistDir, "SHA256SUMS"),
		`${checksumLines.join("\n")}\n`,
		"utf8",
	);
}

async function assertProductionWasm(): Promise<void> {
	const marker = JSON.parse(
		await readFile(path.join(wasmDistDir, "PRODUCTION_BUILD.json"), "utf8"),
	) as Record<string, unknown>;
	if (marker.profile !== "release" || marker.devInsecure !== false) {
		throw new Error("WASM production provenance marker is invalid");
	}
	const nodePackage = JSON.parse(
		await readFile(path.join(wasmDistDir, "node", "package.json"), "utf8"),
	) as Record<string, unknown>;
	if (nodePackage.type !== "commonjs") {
		throw new Error("Node WASM glue is not scoped as CommonJS");
	}
	const wasmFiles = (await walkFiles(wasmDistDir)).filter(
		(file) => file !== "SHA256SUMS" && file !== "PRODUCTION_BUILD.json",
	);
	await assertChecksums(wasmDistDir, wasmFiles);
	const nodeWasm = path.join(wasmDistDir, "node", "webtransport_wasm_bg.wasm");
	const webWasm = path.join(wasmDistDir, "web", "webtransport_wasm_bg.wasm");
	if (
		!(await readFile(nodeWasm)).includes("dev-insecure client path unavailable")
	) {
		throw new Error(
			"production WASM does not contain the compiled-out dev-insecure guard",
		);
	}
	if ((await sha256(nodeWasm)) !== (await sha256(webWasm))) {
		throw new Error(
			"node and web wrappers do not contain the same production WASM binary",
		);
	}
}

async function buildOutputs(): Promise<void> {
	await rm(path.join(packageDir, "dist"), { recursive: true, force: true });
	await rm(wasmDistDir, { recursive: true, force: true });
	await runPackageCommand("bun", ["run", "build"], {
		cwd: packageDir,
		echoOutput: true,
	});
	await runPackageCommand(
		"bash",
		[path.join(root, "crates", "wasm", "build-wasm.sh"), "dist"],
		{ cwd: root, echoOutput: true },
	);
	await finalizeProductionWasm();
	await assertProductionWasm();
}

async function fingerprint(): Promise<Fingerprint> {
	const files = assertPackageManifest(await packResult(true));
	const hashes: Record<string, string> = {};
	for (const file of files)
		hashes[file] = await sha256(path.join(packageDir, file));
	return { files, sha256: hashes };
}

function assertSameFingerprint(first: Fingerprint, second: Fingerprint): void {
	const firstJson = JSON.stringify(first);
	const secondJson = JSON.stringify(second);
	if (firstJson !== secondJson) {
		const changed = [...new Set([...first.files, ...second.files])].filter(
			(file) => first.sha256[file] !== second.sha256[file],
		);
		throw new Error(
			`artifact is not reproducible; logical contents changed: ${changed.join(", ") || "manifest differs"}`,
		);
	}
}

function optionValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	const value = process.argv[index + 1];
	if (!value || value.startsWith("--"))
		throw new Error(`${name} requires a value`);
	return value;
}

function optionValues(name: string): string[] {
	const values: string[] = [];
	for (let index = 0; index < process.argv.length; index++) {
		if (process.argv[index] === name) {
			const value = process.argv[index + 1];
			if (!value || value.startsWith("--"))
				throw new Error(`${name} requires a value`);
			values.push(value);
		}
	}
	return values;
}

async function smokeTarball(
	tarball: string,
	runtimes: Runtime[],
): Promise<void> {
	await access(tarball);
	const consumerDir = await mkdtemp(
		path.join(tmpdir(), "webtransport-consumer-"),
	);
	try {
		await writeFile(
			path.join(consumerDir, "package.json"),
			'{"private":true,"type":"module"}\n',
			"utf8",
		);
		await runPackageCommand(
			"npm",
			[
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				path.resolve(tarball),
			],
			{ cwd: consumerDir, echoOutput: true, label: "npm install" },
		);
		await cp(smokeSourceDir, path.join(consumerDir, "smoke"), {
			recursive: true,
		});
		for (const runtime of runtimes) {
			const executable =
				runtime === "deno"
					? (process.env.WEBTRANSPORT_DENO_COMMAND ?? runtime)
					: runtime;
			try {
				await runSmokeCommand(executable, ["--version"], {
					cwd: consumerDir,
					label: `${runtime} --version probe`,
					echoOnSuccess: false,
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(
					`${runtime} is required for the exact-package smoke gate\n${detail}`,
				);
			}
			const args =
				runtime === "deno"
					? ["run", "-A", "--node-modules-dir=manual", "smoke/deno.ts"]
					: [`smoke/${runtime}.mjs`];
			await runSmokeCommand(executable, args, {
				cwd: consumerDir,
				label: `${runtime} smoke`,
			});
		}
	} finally {
		await rm(consumerDir, { recursive: true, force: true });
	}
}

async function buildArtifact(): Promise<void> {
	await copyAndVerifyPrebuilds(optionValue("--prebuilds-dir"));
	if (process.argv.includes("--require-release-targets")) {
		await assertReleasePrebuildTargets();
	}
	await buildOutputs();
	const first = await fingerprint();
	if (process.argv.includes("--verify-reproducible")) {
		await buildOutputs();
		const second = await fingerprint();
		assertSameFingerprint(first, second);
		console.log(
			"Reproducibility OK (logical manifest and file hashes match; archive timestamps are intentionally ignored)",
		);
	}

	for (const entry of await readdir(packageDir)) {
		if (entry.endsWith(".tgz"))
			await rm(path.join(packageDir, entry), { force: true });
	}
	const packed = await packResult(false);
	assertPackageManifest(packed);
	await assertChecksums(
		prebuildDir,
		await filesWithSuffix(prebuildDir, ".node"),
	);
	await assertProductionWasm();
	const filename = packed.filename;
	if (!filename)
		throw new Error("npm pack did not report the tarball filename");
	const tarball = path.join(packageDir, filename);
	const requested = optionValues("--runtime");
	const runtimes = requested.map((runtime) => {
		if (runtime !== "bun" && runtime !== "node" && runtime !== "deno") {
			throw new Error(`unsupported smoke runtime: ${runtime}`);
		}
		return runtime;
	}) as Runtime[];
	if (process.argv.includes("--smoke") && runtimes.length === 0) {
		runtimes.push("bun", "node", "deno");
	}
	if (runtimes.length > 0) await smokeTarball(tarball, runtimes);
	console.log(`ARTIFACT_PATH=${tarball}`);
}

async function main(): Promise<void> {
	const command = process.argv[2] ?? "check";
	switch (command) {
		case "check": {
			const files = assertPackageManifest(await packResult(true));
			await assertChecksums(
				prebuildDir,
				await filesWithSuffix(prebuildDir, ".node"),
			);
			await assertProductionWasm();
			console.log(`Package manifest OK (${files.length} files)`);
			break;
		}
		case "build":
			await buildArtifact();
			break;
		case "smoke": {
			const tarball = process.argv[3];
			if (!tarball || tarball.startsWith("--"))
				throw new Error("smoke requires a tarball path");
			const requested = optionValues("--runtime");
			await smokeTarball(
				path.resolve(root, tarball),
				(requested.length > 0
					? requested
					: ["bun", "node", "deno"]) as Runtime[],
			);
			break;
		}
		default:
			throw new Error(`unknown command: ${command}`);
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	await main();
}
