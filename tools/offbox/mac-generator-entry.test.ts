/**
 * The ssh entrypoint's refusals, exercised by actually running it.
 *
 * These are the checks that stand between "a gate ran" and "a gate ran against
 * the candidate". They are cheap to assert and expensive to discover on cable
 * day, when the failure looks like a harness bug rather than a provenance one.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MACGEN_ENTRY, macgenInvocation } from "../load/g2-offbox.ts";

const ENTRY = join(import.meta.dir, "mac-generator-entry.sh");
const SHA = "b4af780ad39012345678901234567890abcdef01";

async function runEntry(
	args: string[],
	env?: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
	const child = Bun.spawn(["bash", ENTRY, ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, out, err };
}

describe("mac-generator-entry.sh", () => {
	test("refuses to run without a candidate", async () => {
		const { code, err } = await runEntry([]);
		expect(code).toBe(3);
		expect(err).toContain("--candidate");
	});

	test("refuses a branch name where a SHA belongs", async () => {
		// The effort's rule is that candidate SHAs come from `git rev-parse`, never
		// typed. A ref here would let the generator drift from the stamped tree
		// between the fetch and the run.
		const { code, err } = await runEntry(["--candidate", "rebind4-staging"]);
		expect(code).toBe(3);
		expect(err).toContain("hex sha");
	});

	test("refuses an abbreviated SHA", async () => {
		const { code, err } = await runEntry(["--candidate", "b4af780"]);
		expect(code).toBe(3);
		expect(err).toContain("40-character");
	});

	test("refuses an unknown flag rather than passing it to load-client", async () => {
		const { code, err } = await runEntry(["--candidate", SHA, "--turbo"]);
		expect(code).toBe(3);
		expect(err).toContain("unknown argument");
	});

	test("--plan prints the whole sequence and touches nothing", async () => {
		const { code, out } = await runEntry([
			"--candidate",
			SHA,
			"--clone",
			"/nonexistent-clone",
			"--plan",
			"--",
			"--url",
			"https://10.99.0.2:4433",
		]);
		expect(code).toBe(0);
		// A plan against a clone that does not exist still succeeds: nothing ran.
		expect(out).toContain(`plan git -C /nonexistent-clone fetch`);
		expect(out).toContain(
			"plan cargo build --release -p reference --bin load-client",
		);
		expect(out).toContain("--url https://10.99.0.2:4433");
	});

	test("the provenance header is printed before anything can fail", async () => {
		const { out } = await runEntry([
			"--candidate",
			SHA,
			"--clone",
			"/nonexistent-clone",
		]);
		expect(out).toContain("macgen: host=");
		expect(out).toContain(`candidate=${SHA}`);
	});

	test("refuses a clone that is not there instead of building somewhere else", async () => {
		const { code, err } = await runEntry([
			"--candidate",
			SHA,
			"--clone",
			"/nonexistent-clone",
		]);
		expect(code).toBe(3);
		expect(err).toContain("no git clone");
	});

	test("--bin defaults to load-client so existing callers are unchanged", async () => {
		const { code, out } = await runEntry(["--candidate", SHA, "--plan"]);
		expect(code).toBe(0);
		expect(out).toContain(
			"plan cargo build --release -p reference --bin load-client",
		);
		expect(out).toContain("target/release/load-client");
	});

	test("--bin broadcast-client builds and runs the subscriber fleet, not the source", async () => {
		const { code, out } = await runEntry([
			"--candidate",
			SHA,
			"--bin",
			"broadcast-client",
			"--plan",
		]);
		expect(code).toBe(0);
		expect(out).toContain(
			"plan cargo build --release -p reference --bin broadcast-client",
		);
		expect(out).toContain("target/release/broadcast-client");
		expect(out).not.toContain("target/release/load-client");
	});

	test("refuses a --bin outside the closed set rather than building it", async () => {
		const { code, err } = await runEntry([
			"--candidate",
			SHA,
			"--bin",
			"latency-probe",
			"--plan",
		]);
		expect(code).toBe(3);
		expect(err).toContain("--bin must be load-client or broadcast-client");
	});

	test("G2's exact ssh argv gets past the parser", async () => {
		// End-to-end contract check: build the argv `bench-latency.ts` really
		// emits for an off-box cell, hand everything after the script path to the
		// script, and require that no flag is refused. The clone check firing
		// (exit 3, "no git clone") is the proof the parser accepted every flag —
		// an unknown argument would have refused before the clone was consulted.
		const invocation = macgenInvocation({
			ssh: "mac-gen",
			candidate: SHA,
			deadlineSeconds: 113,
			localBin: "",
			clientArgs: [
				"--url",
				"https://10.99.0.2:4500",
				"--mode",
				"load",
				"--skip-probes",
				"--latency-stamp",
				"--arrival",
				"uniform",
				"--sessions",
				"100",
				"--datagrams-per-sec",
				"150",
			],
		});
		const scriptAt = invocation.args.indexOf(MACGEN_ENTRY);
		expect(scriptAt).toBeGreaterThan(-1);
		const argv = invocation.args.slice(scriptAt + 1);
		const { code, err } = await runEntry(argv, {
			WT_MACGEN_CLONE: "/nonexistent-clone",
		});
		expect(err).not.toContain("unknown argument");
		expect(code).toBe(3);
		expect(err).toContain("no git clone");
	});

	test("G2 names its --bin explicitly rather than relying on the default", async () => {
		// The default happens to be load-client today. A gate that leans on a
		// default it does not state is one closed-set edit away from generating
		// load with the wrong binary and never saying so.
		const invocation = macgenInvocation({
			ssh: "mac-gen",
			candidate: SHA,
			deadlineSeconds: 113,
			localBin: "",
			clientArgs: [],
		});
		const binAt = invocation.args.indexOf("--bin");
		expect(binAt).toBeGreaterThan(-1);
		expect(invocation.args[binAt + 1]).toBe("load-client");
	});

	test("everything after -- reaches load-client untouched", async () => {
		const { out } = await runEntry([
			"--candidate",
			SHA,
			"--plan",
			"--",
			"--sessions",
			"100",
			"--datagrams-per-sec",
			"150",
		]);
		expect(out).toContain("--sessions 100 --datagrams-per-sec 150");
	});
});
