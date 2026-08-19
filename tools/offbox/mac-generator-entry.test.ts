/**
 * The ssh entrypoint's refusals, exercised by actually running it.
 *
 * These are the checks that stand between "a gate ran" and "a gate ran against
 * the candidate". They are cheap to assert and expensive to discover on cable
 * day, when the failure looks like a harness bug rather than a provenance one.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { offboxInvocation } from "../load/g10-offbox";

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

	test("the G10 conductor's exact ssh argv gets past the parser", async () => {
		// End-to-end contract check for §11b: build the argv the conductor really
		// emits, hand everything after the script path to the script, and require
		// that no flag is refused. The clone check firing (exit 3, "no git clone")
		// is the proof the parser accepted every flag — an unknown argument would
		// have refused before the clone was ever consulted.
		const invocation = offboxInvocation({
			ssh: "mac-gen",
			candidate: SHA,
			deadlineSeconds: 120,
			localBin: "",
			subscriber: {
				url: "https://10.99.0.1:4433",
				sessions: 100,
				probeCohort: 10,
				probeHz: 20,
				payloadBytes: 200,
				rate: 30,
				seconds: 60,
			},
		});
		const scriptAt = invocation.args.indexOf(
			"tools/offbox/mac-generator-entry.sh",
		);
		expect(scriptAt).toBeGreaterThan(-1);
		const argv = invocation.args.slice(scriptAt + 1);
		const { code, err } = await runEntry(argv, {
			WT_MACGEN_CLONE: "/nonexistent-clone",
		});
		expect(err).not.toContain("unknown argument");
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
