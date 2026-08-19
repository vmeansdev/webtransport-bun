/**
 * The ssh entrypoint's refusals, exercised by actually running it.
 *
 * These are the checks that stand between "a gate ran" and "a gate ran against
 * the candidate". They are cheap to assert and expensive to discover on cable
 * day, when the failure looks like a harness bug rather than a provenance one.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "mac-generator-entry.sh");
const SHA = "b4af780ad39012345678901234567890abcdef01";

async function runEntry(
	args: string[],
): Promise<{ code: number; out: string; err: string }> {
	const child = Bun.spawn(["bash", ENTRY, ...args], {
		stdout: "pipe",
		stderr: "pipe",
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
