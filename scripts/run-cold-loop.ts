#!/usr/bin/env bun

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const INTEROP_DIR = join(ROOT, "tools", "interop");
const DEFAULT_PACKAGE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_INTEROP_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_INTEROP_QUIC_PORT = 4433;
const DEFAULT_INTEROP_HEALTH_PORT = 4434;
const INTEROP_PORT_STRIDE = 4;
const PROCESS_TREE_TERM_GRACE_MS = 250;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 2_000;

export const DEFAULT_REQUIRED_COLD_LOOP_COUNT = 10;

type Mode = "packages" | "interop";

export type InteropIterationState = {
	rootDir: string;
	env: Record<string, string>;
};

function parsePositiveInt(
	value: string | undefined,
	label: string,
): number | null {
	if (!value) {
		return null;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`${label} must be a positive integer, received: ${value}`);
	}
	return parsed;
}

export function resolveRequiredColdLoopCount(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return (
		parsePositiveInt(
			env.WEBTRANSPORT_COLD_LOOP_COUNT,
			"WEBTRANSPORT_COLD_LOOP_COUNT",
		) ?? DEFAULT_REQUIRED_COLD_LOOP_COUNT
	);
}

function resolveMode(argv: string[]): Mode {
	const mode = argv[2];
	if (mode === "packages" || mode === "interop") {
		return mode;
	}
	throw new Error(`usage: bun scripts/run-cold-loop.ts <packages|interop>`);
}

function resolveTimeoutMs(
	mode: Mode,
	env: NodeJS.ProcessEnv = process.env,
): number {
	if (mode === "packages") {
		return (
			parsePositiveInt(
				env.WEBTRANSPORT_PACKAGE_LOOP_TIMEOUT_MS ??
					env.WEBTRANSPORT_COLD_LOOP_TIMEOUT_MS,
				"package cold-loop timeout",
			) ?? DEFAULT_PACKAGE_TIMEOUT_MS
		);
	}
	return (
		parsePositiveInt(
			env.WEBTRANSPORT_INTEROP_LOOP_TIMEOUT_MS ??
				env.WEBTRANSPORT_COLD_LOOP_TIMEOUT_MS,
			"interop cold-loop timeout",
		) ?? DEFAULT_INTEROP_TIMEOUT_MS
	);
}

export function buildInteropIterationState(
	parentDir: string,
	iteration: number,
	env: NodeJS.ProcessEnv = process.env,
): InteropIterationState {
	const rootDir = mkdtempSync(
		join(parentDir, `interop-${String(iteration).padStart(2, "0")}-`),
	);
	const certDir = join(rootDir, "certs");
	mkdirSync(certDir, { recursive: true });

	const baseQuicPort =
		parsePositiveInt(
			env.WEBTRANSPORT_INTEROP_BASE_QUIC_PORT,
			"WEBTRANSPORT_INTEROP_BASE_QUIC_PORT",
		) ?? DEFAULT_INTEROP_QUIC_PORT;
	const baseHealthPort =
		parsePositiveInt(
			env.WEBTRANSPORT_INTEROP_BASE_HEALTH_PORT,
			"WEBTRANSPORT_INTEROP_BASE_HEALTH_PORT",
		) ?? DEFAULT_INTEROP_HEALTH_PORT;
	const portOffset = (iteration - 1) * INTEROP_PORT_STRIDE;

	return {
		rootDir,
		env: {
			WEBTRANSPORT_INTEROP_CERT_DIR: certDir,
			WEBTRANSPORT_INTEROP_QUIC_PORT: String(baseQuicPort + portOffset),
			WEBTRANSPORT_INTEROP_HEALTH_PORT: String(baseHealthPort + portOffset),
		},
	};
}

async function sleep(delayMs: number): Promise<void> {
	await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
}

async function runBoundedWindowsTreeKill(pid: number): Promise<void> {
	await new Promise<void>((resolvePromise) => {
		let killer: ReturnType<typeof spawn>;
		try {
			killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
				stdio: "ignore",
				windowsHide: true,
			});
		} catch {
			resolvePromise();
			return;
		}

		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			resolvePromise();
		};
		timer = setTimeout(() => {
			try {
				killer.kill("SIGKILL");
			} catch {
				// The taskkill process may already have exited.
			}
			killer.unref();
			finish();
		}, WINDOWS_TREE_KILL_TIMEOUT_MS);
		killer.once("error", finish);
		killer.once("close", finish);
	});
}

async function killProcessTree(pid: number | undefined): Promise<void> {
	if (!pid) {
		return;
	}

	if (process.platform === "win32") {
		await runBoundedWindowsTreeKill(pid);
		return;
	}

	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		try {
			process.kill(-pid, signal);
		} catch {
			// runChild creates a process group; it may already be gone.
		}
		await sleep(PROCESS_TREE_TERM_GRACE_MS);
	}
}

export async function runChild(
	label: string,
	cwd: string,
	args: string[],
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
): Promise<void> {
	const child = spawn(process.execPath, args, {
		cwd,
		env,
		stdio: "inherit",
		detached: process.platform !== "win32",
	});

	let timedOut = false;
	let cleanup: Promise<void> | undefined;
	let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
	// A loaded host can delay exec after spawn() returns. Start the bounded
	// command deadline once the child has actually spawned, matching the
	// package-artifact command runner's startup contract.
	child.once("spawn", () => {
		timer = globalThis.setTimeout(() => {
			timedOut = true;
			cleanup = killProcessTree(child.pid);
		}, timeoutMs);
	});

	let result: { code: number | null; signal: NodeJS.Signals | null };
	try {
		result = await new Promise<{
			code: number | null;
			signal: NodeJS.Signals | null;
		}>((resolvePromise, rejectPromise) => {
			child.once("error", rejectPromise);
			child.once("exit", (code, signal) => resolvePromise({ code, signal }));
		});
	} catch (error) {
		if (timer !== undefined) globalThis.clearTimeout(timer);
		await (cleanup ?? killProcessTree(child.pid));
		throw error;
	}

	if (timer !== undefined) globalThis.clearTimeout(timer);
	if (timedOut) {
		await (cleanup ?? killProcessTree(child.pid));
		throw new Error(`${label} timed out after ${timeoutMs}ms`);
	}
	if (result.code !== 0) {
		await killProcessTree(child.pid);
		throw new Error(
			`${label} failed with exit ${result.code ?? "null"} signal ${
				result.signal ?? "none"
			}`,
		);
	}
}

async function runPackageLoops(
	count: number,
	timeoutMs: number,
): Promise<void> {
	for (let iteration = 1; iteration <= count; iteration += 1) {
		console.log(`[cold-loop] packages iteration ${iteration}/${count}`);
		await runChild(
			`packages iteration ${iteration}`,
			ROOT,
			["test", "packages/"],
			{
				...process.env,
				WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
			},
			timeoutMs,
		);
	}
}

async function runInteropLoops(
	count: number,
	timeoutMs: number,
): Promise<void> {
	const loopRoot = mkdtempSync(join(tmpdir(), "wt-interop-cold-loop-"));
	try {
		for (let iteration = 1; iteration <= count; iteration += 1) {
			const state = buildInteropIterationState(loopRoot, iteration);
			console.log(
				`[cold-loop] interop iteration ${iteration}/${count} ` +
					`quic=${state.env.WEBTRANSPORT_INTEROP_QUIC_PORT} ` +
					`health=${state.env.WEBTRANSPORT_INTEROP_HEALTH_PORT}`,
			);
			try {
				await runChild(
					`interop iteration ${iteration}`,
					INTEROP_DIR,
					["run", "test:once"],
					{
						...process.env,
						WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN: "1",
						...state.env,
					},
					timeoutMs,
				);
			} finally {
				rmSync(state.rootDir, { recursive: true, force: true });
			}
		}
	} finally {
		rmSync(loopRoot, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const mode = resolveMode(process.argv);
	const count = resolveRequiredColdLoopCount();
	const timeoutMs = resolveTimeoutMs(mode);

	if (mode === "packages") {
		await runPackageLoops(count, timeoutMs);
	} else {
		await runInteropLoops(count, timeoutMs);
	}
}
