#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const CORPUS_ROOT = resolve(import.meta.dir, "corpora");
const EVIDENCE_ROOT = resolve(ROOT, ".release-evidence/fuzz");
const ARTIFACT_PATH =
	process.env.FUZZ_SMOKE_ARTIFACT_OUT ??
	resolve(EVIDENCE_ROOT, "release-smoke.json");
const FIXED_DURATION_SECS = Number(
	process.env.FUZZ_SMOKE_DURATION_SECS ?? "30",
);
const RELEASE_TOOLCHAIN_PATH = resolve(ROOT, ".github/release-toolchain.json");
const DEFAULT_DRAIN_TIMEOUT_MS = 2_000;

export const cargoFuzzTargets = [
	{ name: "h3_frames", corpus: "h3" },
	{ name: "qpack_huffman", corpus: "qpack" },
	{ name: "der_metadata", corpus: "der" },
	{ name: "cert_pin_policy", corpus: "pin" },
	{ name: "handle_allocator", corpus: "handle" },
	{ name: "endpoint_event_dispatch", corpus: "event" },
	{ name: "event_encode", corpus: "bridge" },
	{ name: "limit_arithmetic", corpus: "limits" },
] as const;

type CommandResult = {
	command: string[];
	exitCode: number;
	stdout: string;
	stderr: string;
	stdoutBytes: number;
	stderrBytes: number;
	durationMs: number;
	timeoutMs: number | null;
	timedOut: boolean;
	timeoutSignal: "SIGTERM" | "SIGKILL" | null;
	drainTimeoutMs: number | null;
	drainDurationMs: number;
	drainTimedOut: boolean;
};

type ReleaseToolchainPolicy = {
	rust: string[];
};

function releaseRustToolchain(): string {
	const policy = JSON.parse(
		readFileSync(RELEASE_TOOLCHAIN_PATH, "utf8"),
	) as ReleaseToolchainPolicy;
	const version = policy.rust?.[0];
	if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
		throw new Error(
			`release fuzz requires one exact Rust toolchain in ${RELEASE_TOOLCHAIN_PATH}`,
		);
	}
	return version;
}

function toolchainCommand(toolchain: string, ...args: string[]) {
	return ["rustup", "run", toolchain, ...args];
}

function corpusFiles(directory: string): string[] {
	if (!existsSync(directory)) return [];
	return readdirSync(directory, { recursive: true })
		.map((entry) => join(directory, String(entry)))
		.filter((path) => statSync(path).isFile());
}

function probe(command: string[]) {
	const [binary, ...args] = command;
	if (!binary) {
		return {
			ok: false,
			exitCode: null,
			stdout: "",
			stderr: "empty command",
		};
	}
	const result = spawnSync(binary, args, { cwd: ROOT, encoding: "utf8" });
	return {
		ok: result.status === 0,
		exitCode: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function rustHostTriple(toolchain: string): string | null {
	const version = probe(toolchainCommand(toolchain, "rustc", "-vV"));
	if (!version.ok) return null;
	const match = version.stdout.match(/^host:\s+(.+)$/m);
	return match?.[1]?.trim() ?? null;
}

function resolveLlvmSymbolizer(toolchain: string): string | null {
	const sysroot = probe(
		toolchainCommand(toolchain, "rustc", "--print", "sysroot"),
	);
	const host = rustHostTriple(toolchain);
	if (sysroot.ok && host) {
		const toolchainPath = resolve(
			sysroot.stdout.trim(),
			"lib",
			"rustlib",
			host,
			"bin",
			"llvm-symbolizer",
		);
		if (existsSync(toolchainPath)) return toolchainPath;
	}
	// rustup's llvm-tools-preview on some hosts (notably current darwin) omits
	// llvm-symbolizer; accept a PATH / Homebrew binary so crash artifacts still
	// symbolize instead of failing the smoke as a false tooling blocker.
	const fromPath = probe(["sh", "-c", "command -v llvm-symbolizer"]);
	if (fromPath.ok) {
		const resolved = fromPath.stdout.trim().split("\n")[0]?.trim();
		if (resolved && existsSync(resolved)) return resolved;
	}
	for (const candidate of [
		"/opt/homebrew/opt/llvm/bin/llvm-symbolizer",
		"/usr/local/opt/llvm/bin/llvm-symbolizer",
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

type CollectedOutput = {
	text: string;
	bytes: number;
};

function collectOutput(stream: ReadableStream<Uint8Array> | undefined | null) {
	let bytes = 0;
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	const reader = stream?.getReader();
	let settled = false;
	let resolved: CollectedOutput | null = null;
	let resolveDone!: (value: CollectedOutput) => void;

	const snapshot = (): CollectedOutput => {
		if (resolved) return resolved;
		resolved = {
			text: `${chunks.join("")}${decoder.decode()}`,
			bytes,
		};
		return resolved;
	};

	const settle = () => {
		if (settled) return;
		settled = true;
		resolveDone(snapshot());
	};

	const done = new Promise<CollectedOutput>((resolve) => {
		resolveDone = resolve;
		if (!reader) {
			settle();
			return;
		}
		void (async () => {
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					chunks.push(decoder.decode(value, { stream: true }));
					resolved = null;
				}
			} catch {}
			settle();
		})();
	});

	const forceClose = () => {
		if (!reader || settled) return;
		void reader.cancel().catch(() => {});
		settle();
	};

	return {
		done,
		forceClose,
		snapshot,
	};
}

export async function runCommand(
	command: string[],
	options: {
		cwd?: string;
		env?: Record<string, string>;
		timeoutMs?: number;
		drainTimeoutMs?: number;
	} = {},
): Promise<CommandResult> {
	const started = performance.now();
	const proc = Bun.spawn(command, {
		cwd: options.cwd ?? ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			...options.env,
		},
	});
	const stdoutCollector = collectOutput(proc.stdout);
	const stderrCollector = collectOutput(proc.stderr);
	let timedOut = false;
	let timeoutSignal: "SIGTERM" | "SIGKILL" | null = null;
	const timeoutMs = options.timeoutMs ?? null;
	const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
	let termTimer: ReturnType<typeof setTimeout> | undefined;
	let killTimer: ReturnType<typeof setTimeout> | undefined;
	if (timeoutMs != null) {
		termTimer = setTimeout(() => {
			timedOut = true;
			timeoutSignal = "SIGTERM";
			try {
				proc.kill("SIGTERM");
			} catch {}
			killTimer = setTimeout(() => {
				timeoutSignal = "SIGKILL";
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 1_000);
		}, timeoutMs);
	}
	const exitCode = await proc.exited;
	if (termTimer) clearTimeout(termTimer);
	if (killTimer) clearTimeout(killTimer);
	const drainStarted = performance.now();
	let drainTimedOut = false;
	let stdoutResult: CollectedOutput;
	let stderrResult: CollectedOutput;
	const drained = await Promise.race([
		Promise.all([stdoutCollector.done, stderrCollector.done]),
		Bun.sleep(drainTimeoutMs).then(() => null),
	]);
	if (drained === null) {
		drainTimedOut = true;
		stdoutCollector.forceClose();
		stderrCollector.forceClose();
		stdoutResult = stdoutCollector.snapshot();
		stderrResult = stderrCollector.snapshot();
	} else {
		[stdoutResult, stderrResult] = drained;
	}
	return {
		command,
		exitCode,
		stdout: stdoutResult.text,
		stderr: stderrResult.text,
		stdoutBytes: stdoutResult.bytes,
		stderrBytes: stderrResult.bytes,
		durationMs: Number((performance.now() - started).toFixed(3)),
		timeoutMs,
		timedOut,
		timeoutSignal,
		drainTimeoutMs,
		drainDurationMs: Number((performance.now() - drainStarted).toFixed(3)),
		drainTimedOut,
	};
}

function writeArtifact(payload: unknown) {
	mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
	writeFileSync(ARTIFACT_PATH, JSON.stringify(payload, null, 2));
}

async function main() {
	if (!Number.isFinite(FIXED_DURATION_SECS) || FIXED_DURATION_SECS <= 0) {
		throw new Error(
			"FUZZ_SMOKE_DURATION_SECS must be a positive finite number",
		);
	}

	const toolchain = releaseRustToolchain();
	const llvmSymbolizer = resolveLlvmSymbolizer(toolchain);
	const failures: string[] = [];
	const cargo = probe(toolchainCommand(toolchain, "cargo", "--version"));
	const cargoFuzz = probe(
		toolchainCommand(toolchain, "cargo", "fuzz", "--version"),
	);
	if (!cargo.ok) {
		failures.push(
			`cargo unavailable via rustup run ${toolchain}: ${cargo.stderr || cargo.stdout}`,
		);
	}
	if (!cargoFuzz.ok) {
		failures.push(
			`cargo-fuzz unavailable via rustup run ${toolchain}: ${cargoFuzz.stderr || cargoFuzz.stdout}`,
		);
	}
	if (!llvmSymbolizer) {
		failures.push(
			`llvm-symbolizer missing for rustup toolchain ${toolchain}; install llvm-tools-preview for the pinned release toolchain`,
		);
	}

	const commandResults: CommandResult[] = [];
	const commonEnv: Record<string, string> = llvmSymbolizer
		? {
				ASAN_SYMBOLIZER_PATH: llvmSymbolizer,
				MSAN_SYMBOLIZER_PATH: llvmSymbolizer,
			}
		: {};
	const fuzzCommandTimeoutMs = FIXED_DURATION_SECS * 1_000 + 30_000;

	for (const target of cargoFuzzTargets) {
		const corpusDirectory = resolve(CORPUS_ROOT, target.corpus);
		if (corpusFiles(corpusDirectory).length === 0) {
			failures.push(
				`${target.name}: checked-in corpus ${corpusDirectory} is empty`,
			);
			continue;
		}
		const crashDirectory = resolve(EVIDENCE_ROOT, "crashes", target.name);
		mkdirSync(crashDirectory, { recursive: true });
		// Match CI compile-check: this crate IS the fuzz package (`tools/fuzz`),
		// so cargo-fuzz needs `--fuzz-dir .`. Stable 1.95.0 cannot build with
		// AddressSanitizer (`-Zsanitizer`), so release smoke uses `--sanitizer none`.
		const command = toolchainCommand(
			toolchain,
			"cargo",
			"fuzz",
			"run",
			target.name,
			"--fuzz-dir",
			".",
			"--sanitizer",
			"none",
			corpusDirectory,
			"--",
			`-max_total_time=${FIXED_DURATION_SECS}`,
			`-artifact_prefix=${crashDirectory}/`,
			"-timeout=10",
			"-rss_limit_mb=4096",
			"-print_final_stats=1",
		);
		const result = await runCommand(command, {
			cwd: import.meta.dir,
			env: commonEnv,
			timeoutMs: fuzzCommandTimeoutMs,
		});
		commandResults.push(result);
		if (result.timedOut) {
			failures.push(
				`${target.name}: cargo-fuzz timed out after ${result.timeoutMs}ms (${result.timeoutSignal ?? "timeout"})`,
			);
			continue;
		}
		if (result.exitCode !== 0) {
			failures.push(
				`${target.name}: cargo-fuzz exited ${result.exitCode}: ${result.stderr || result.stdout}`,
			);
		}
	}

	const propertyTests = await runCommand(
		toolchainCommand(
			toolchain,
			"cargo",
			"test",
			"--manifest-path",
			"crates/wasm/Cargo.toml",
			"parsers_never_panic",
			"--",
			"--nocapture",
		),
		{
			env: commonEnv,
			timeoutMs: 60_000,
		},
	);
	commandResults.push(propertyTests);
	if (propertyTests.timedOut) {
		failures.push(
			`stable parser property tests timed out after ${propertyTests.timeoutMs}ms (${propertyTests.timeoutSignal ?? "timeout"})`,
		);
	} else if (propertyTests.exitCode !== 0) {
		failures.push(
			`stable parser property tests exited ${propertyTests.exitCode}`,
		);
	}

	const tsPropertyHarness = await runCommand(
		[
			"bun",
			"test",
			"packages/webtransport/test/wasm-limits.test.ts",
			"--test-name-pattern",
			"WASM event decoder property harness",
		],
		{
			cwd: ROOT,
			timeoutMs: 30_000,
		},
	);
	commandResults.push(tsPropertyHarness);
	if (tsPropertyHarness.timedOut) {
		failures.push(
			`TS WASM event decoder property harness timed out after ${tsPropertyHarness.timeoutMs}ms (${tsPropertyHarness.timeoutSignal ?? "timeout"})`,
		);
	} else if (tsPropertyHarness.exitCode !== 0) {
		failures.push(
			`TS WASM event decoder property harness exited ${tsPropertyHarness.exitCode}`,
		);
	}

	const artifact = {
		createdAt: new Date().toISOString(),
		fixedDurationSecs: FIXED_DURATION_SECS,
		toolchain: {
			rust: toolchain,
			cargo: cargo.stdout.trim(),
			cargoFuzz: cargoFuzz.stdout.trim(),
			llvmSymbolizer: llvmSymbolizer ?? "",
		},
		corpora: cargoFuzzTargets.map((target) => ({
			target: target.name,
			files: corpusFiles(resolve(CORPUS_ROOT, target.corpus)).map((path) => ({
				path: path.replace(`${ROOT}/`, ""),
				bytes: statSync(path).size,
			})),
		})),
		commandResults,
		crashRoot: resolve(EVIDENCE_ROOT, "crashes").replace(`${ROOT}/`, ""),
		failures,
	};
	writeArtifact(artifact);

	if (failures.length > 0) {
		console.error("fuzz-release-smoke: FAIL");
		for (const failure of failures) console.error(` - ${failure}`);
		console.error(`artifact: ${ARTIFACT_PATH}`);
		process.exit(1);
	}

	console.log(`fuzz-release-smoke: PASS (${cargoFuzzTargets.length} targets)`);
	console.log(`artifact: ${ARTIFACT_PATH}`);
}

if (import.meta.main) {
	main().catch((error) => {
		writeArtifact({
			createdAt: new Date().toISOString(),
			fixedDurationSecs: FIXED_DURATION_SECS,
			failures: [error instanceof Error ? error.message : String(error)],
		});
		console.error(error);
		process.exit(1);
	});
}
