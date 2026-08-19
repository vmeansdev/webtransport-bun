/**
 * Run a snippet in a fresh bounded Bun process with a chosen environment.
 *
 * Delivery knobs are resolved exactly once per process, so any test that
 * compares knob settings has to compare processes: flipping the variable
 * in-process would only re-assert the value frozen at module load.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ChildRun = {
	exitCode: number | null;
	result: unknown;
	stdout: string;
	stderr: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export async function runChild(
	body: string,
	env: Record<string, string | undefined> = {},
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ChildRun> {
	const dir = mkdtempSync(join(tmpdir(), "wt-child-"));
	const script = join(dir, "child.ts");
	const internalModule = new URL("../../src/internal.ts", import.meta.url)
		.pathname;
	const publicModule = new URL("../../src/index.ts", import.meta.url).pathname;
	const preamble =
		`const INTERNAL_MODULE = ${JSON.stringify(internalModule)};\n` +
		`const PUBLIC_MODULE = ${JSON.stringify(publicModule)};\n` +
		`const report = (v: unknown) => console.log("__RESULT__" + JSON.stringify(v));\n`;
	await Bun.write(script, preamble + body);
	const childEnv: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env))
		if (v !== undefined) childEnv[k] = v;
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete childEnv[k];
		else childEnv[k] = v;
	}
	const proc = Bun.spawn([process.execPath, script], {
		env: childEnv,
		stdout: "pipe",
		stderr: "pipe",
		cwd: new URL("../../../..", import.meta.url).pathname,
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const exited = await Promise.race([
			proc.exited,
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
			}),
		]);
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		if (exited === "timeout") {
			proc.kill();
			throw new Error(
				`child did not exit within ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
		}
		const line = stdout
			.split("\n")
			.find((l) => l.startsWith("__RESULT__"))
			?.slice("__RESULT__".length);
		return {
			exitCode: exited,
			result: line === undefined ? undefined : JSON.parse(line),
			stdout,
			stderr,
		};
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Fail loudly rather than letting a crashed child read as an empty pass. */
// biome-ignore lint/suspicious/noExplicitAny: child payloads are ad-hoc JSON.
export function childResult(run: ChildRun): any {
	if (run.exitCode !== 0)
		throw new Error(
			`child exited ${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
		);
	if (run.result === undefined)
		throw new Error(
			`child produced no __RESULT__ line\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
		);
	return run.result;
}
