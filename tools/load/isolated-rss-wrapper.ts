#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const DEFAULT_ARTIFACT_PATH = resolve(
	ROOT,
	".release-evidence/load/load-scale-artifact.json",
);
const SAMPLE_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1_000;
const TERMINATE_GRACE_MS = 2_000;
const MAX_CAPTURE_BYTES = 256 * 1024;

export type IsolatedRssSample = {
	atMs: number;
	rssMb: number;
};

export type IsolatedRssExit = {
	exitCode: number | null;
	exitSignal: string | null;
	exitedWithinMs: number | null;
};

/** Parse the RSS column emitted by `ps -o rss=`. The input is kilobytes. */
export function parseProcessRssMb(raw: string): number | null {
	const token = raw.trim().split(/\s+/).at(-1) ?? "";
	const value = Number(token);
	if (!Number.isFinite(value) || value <= 0) return null;
	return Number((value / 1024).toFixed(3));
}

function parseTasklistRssMb(raw: string): number | null {
	const match = raw.match(/"([\d,]+)\s*K"/i);
	const token = match?.[1];
	if (!token) return null;
	return parseProcessRssMb(token.replaceAll(",", ""));
}

/** Pure summary helper kept small so the artifact contract is unit-testable. */
export function buildIsolatedRssTelemetry(
	samples: IsolatedRssSample[],
	exit: IsolatedRssExit,
) {
	const valid = samples.filter(
		(sample) =>
			Number.isFinite(sample.atMs) &&
			sample.atMs >= 0 &&
			Number.isFinite(sample.rssMb) &&
			sample.rssMb > 0,
	);
	const last = valid.at(-1)?.rssMb ?? null;
	const peak = valid.reduce((max, sample) => Math.max(max, sample.rssMb), 0);
	return {
		lastSampleRssMb: last,
		peakRssMb: peak || null,
		sampleCount: valid.length,
		exitCode: exit.exitCode,
		exitSignal: exit.exitSignal,
		exitedWithinMs: exit.exitedWithinMs,
	};
}

function sampleProcessRssMb(pid: number): number | null {
	if (!Number.isInteger(pid) || pid <= 0) return null;
	if (process.platform === "win32") {
		const result = spawnSync(
			"tasklist",
			["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		return result.status === 0 ? parseTasklistRssMb(result.stdout) : null;
	}
	const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	return result.status === 0 ? parseProcessRssMb(result.stdout) : null;
}

function appendBounded(current: string, chunk: Buffer | string): string {
	const next = current + chunk.toString();
	return next.length <= MAX_CAPTURE_BYTES
		? next
		: next.slice(next.length - MAX_CAPTURE_BYTES);
}

function signalChildTree(pid: number, signal: NodeJS.Signals): void {
	if (pid <= 0) return;
	try {
		if (process.platform !== "win32") {
			process.kill(-pid, signal);
		} else {
			process.kill(pid, signal);
		}
	} catch {
		// The child may have exited between sampling and the bounded signal.
	}
}

async function runIsolatedScale(): Promise<number> {
	const artifactPath =
		process.env.LOAD_SCALE_ARTIFACT_OUT?.trim() || DEFAULT_ARTIFACT_PATH;
	const timeoutMs = Number(
		process.env.LOAD_SCALE_ISOLATED_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
	);
	const startedAt = Date.now();
	const child = spawn(process.execPath, ["tools/load/load-scale-addon.ts"], {
		cwd: ROOT,
		env: { ...process.env, LOAD_SCALE_ARTIFACT_OUT: artifactPath },
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk) => {
		stdout = appendBounded(stdout, chunk);
	});
	child.stderr?.on("data", (chunk) => {
		stderr = appendBounded(stderr, chunk);
	});
	const exitPromise = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("exit", (code, signal) => resolveExit({ code, signal }));
	});

	const samples: IsolatedRssSample[] = [];
	let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
		null;
	let timedOut = false;
	while (!exit) {
		const rssMb = sampleProcessRssMb(child.pid ?? 0);
		if (rssMb != null) {
			samples.push({ atMs: Date.now() - startedAt, rssMb });
		}
		const elapsed = Date.now() - startedAt;
		if (elapsed >= timeoutMs) {
			timedOut = true;
			signalChildTree(child.pid ?? 0, "SIGTERM");
			await Bun.sleep(TERMINATE_GRACE_MS);
			signalChildTree(child.pid ?? 0, "SIGKILL");
			exit = { code: -1, signal: "SIGKILL" };
			break;
		}
		exit = await Promise.race([
			exitPromise,
			Bun.sleep(SAMPLE_INTERVAL_MS).then(() => null),
		]);
	}

	const telemetry = buildIsolatedRssTelemetry(samples, {
		exitCode: timedOut ? -1 : exit.code,
		exitSignal: timedOut ? "SIGKILL" : exit.signal,
		exitedWithinMs: timedOut ? null : Date.now() - startedAt,
	});
	if (existsSync(artifactPath)) {
		try {
			const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<
				string,
				unknown
			>;
			artifact.processIsolatedRss = telemetry;
			const tempPath = `${artifactPath}.tmp-${process.pid}`;
			writeFileSync(tempPath, JSON.stringify(artifact, null, 2));
			renameSync(tempPath, artifactPath);
		} catch (error) {
			stderr = appendBounded(
				stderr,
				`\nfailed to patch isolated RSS telemetry: ${String(error)}\n`,
			);
		}
	}
	process.stdout.write(stdout);
	process.stderr.write(stderr);
	return timedOut || exit.code !== 0 ? 1 : 0;
}

if (import.meta.main) {
	runIsolatedScale()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			console.error(`isolated-rss-wrapper: ${String(error)}`);
			process.exitCode = 1;
		});
}
