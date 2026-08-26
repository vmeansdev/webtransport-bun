import { describe, expect, test } from "bun:test";

/**
 * The three executable roots the package scripts run. Their `import.meta.main`
 * blocks — not the exported parsers — are what `bun run compare:*` executes, so
 * they are exercised here as processes rather than as functions.
 */
const ROOTS = [
	["campaign", "tools/compare/run-campaign.ts"],
	["verify", "tools/compare/verify-artifact.ts"],
	["report", "tools/compare/render-report.ts"],
] as const;

const AMBIENT = {
	WEBTRANSPORT_COMPARISON_CANDIDATE: "ambient-candidate",
	WEBTRANSPORT_COMPARISON_CAMPAIGN: "ambient-campaign",
	WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND: "ambient-bound",
} as const;

function runRoot(
	script: string,
	args: readonly string[],
	env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
	const result = Bun.spawnSync({
		cmd: ["bun", script, ...args],
		cwd: process.cwd(),
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		exitCode: result.exitCode ?? -1,
		stdout: new TextDecoder().decode(result.stdout),
		stderr: new TextDecoder().decode(result.stderr),
	};
}

interface ProcessAccounting {
	readonly status: number;
	/** Most children of the command seen alive at once while it ran. */
	readonly maxChildren: number;
	/** Processes still in the command's process group after it exited. */
	readonly survivors: number;
}

/**
 * Runs one command in its own process group and accounts for what it started.
 *
 * The frozen contract records `spawnedChildren: 0` and `pgidDrained: true`, but
 * those are values the error object states about itself, so asserting them
 * proves only that a constructor assigned them. These are measured from outside
 * the process instead. `maxChildren` is a sampled upper bound — a child that
 * lived and died between two samples is missed — while `survivors` is exact,
 * because a leaked process is still in the group when the group is counted.
 * Both meters are exercised against a command that trips them, below.
 */
function accountFor(command: string): ProcessAccounting {
	const script = [
		"set -m",
		// No braces: a grouped command makes the shell fork a subshell, and the
		// command under test would be counted as that subshell's own child.
		`${command} >/dev/null 2>&1 &`,
		"child=$!",
		"max=0",
		"while kill -0 $child 2>/dev/null; do",
		'  n=$(pgrep -P $child 2>/dev/null | wc -l | tr -d " ")',
		'  if [ "$n" -gt "$max" ]; then max=$n; fi',
		"done",
		"wait $child; status=$?",
		'survivors=$(pgrep -g $child 2>/dev/null | wc -l | tr -d " ")',
		'echo "$status $max $survivors"',
	].join("\n");
	const result = Bun.spawnSync({
		cmd: ["sh", "-c", script],
		cwd: process.cwd(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [status, maxChildren, survivors] = new TextDecoder()
		.decode(result.stdout)
		.trim()
		.split(/\s+/u)
		.map(Number);
	return {
		status: status ?? -1,
		maxChildren: maxChildren ?? -1,
		survivors: survivors ?? -1,
	};
}

describe("R1 entrypoint wiring: the process accounting can fail", () => {
	test("a command that forks a child and leaks one is caught by both meters", () => {
		const forking = accountFor("sh -c 'sleep 0.6; :'");
		expect(forking.status).toBe(0);
		expect(forking.maxChildren).toBeGreaterThan(0);

		const leaking = accountFor("sh -c 'sleep 2 & exit 0'");
		expect(leaking.status).toBe(0);
		expect(leaking.survivors).toBeGreaterThan(0);
	});
});

describe("R1 entrypoint wiring: the campaign root can be asked for help", () => {
	// F7: `--help` was parsed into a flag that nothing reached — the parser fell
	// through to the required-argument loop, so asking for help exited 1 with
	// CAMPAIGN_ARG_MISSING_CANDIDATE and `printCampaignHelp` was dead code.
	for (const flag of ["--help", "-h"]) {
		test(`campaign prints its usage and exits 0 for ${flag}`, () => {
			const { exitCode, stdout, stderr } = runRoot(
				"tools/compare/run-campaign.ts",
				[flag],
			);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain("--staged-capability");
			expect(stdout).not.toContain("CAMPAIGN_ARG_MISSING_CANDIDATE");
			expect(stderr).toBe("");
		});
	}

	test("help asks for no authority and writes no official output", () => {
		const { stdout, stderr } = runRoot(
			"tools/compare/run-campaign.ts",
			["--help"],
			AMBIENT,
		);
		const output = `${stdout}${stderr}`;
		expect(output).not.toContain("ambient-candidate");
		expect(output).not.toContain("ambient-campaign");
		expect(output).not.toContain("CANONICAL COMPARISON CAMPAIGN");
	});
});

describe("R1 entrypoint wiring: the package scripts are demoted", () => {
	for (const [role, script] of ROOTS) {
		test(`${role} treats --fixture-only as a flag, not as a path`, () => {
			const { exitCode, stdout, stderr } = runRoot(script, ["--fixture-only"]);
			expect(exitCode).toBe(0);
			expect(stdout).toContain("fixture-only");
			// The flag was previously consumed as a positional and resolved into an
			// official directory literally named "--fixture-only".
			expect(`${stdout}${stderr}`).not.toContain(
				".release-evidence/transport-comparison",
			);
			expect(`${stdout}${stderr}`).not.toContain("unbound-candidate");
			expect(`${stdout}${stderr}`).not.toContain("campaign-unbound");
		});

		test(`${role} ignores an ambient campaign identity under --fixture-only`, () => {
			const { exitCode, stdout, stderr } = runRoot(
				script,
				["--fixture-only"],
				AMBIENT,
			);
			expect(exitCode).toBe(0);
			expect(`${stdout}${stderr}`).not.toContain("ambient-candidate");
			expect(`${stdout}${stderr}`).not.toContain("ambient-campaign");
			expect(`${stdout}${stderr}`).not.toContain("ambient-bound");
		});

		test(`${role} refuses an official run that names no candidate, even with the environment set`, () => {
			const { exitCode, stdout, stderr } = runRoot(script, [], AMBIENT);
			expect(exitCode).toBe(1);
			expect(`${stdout}${stderr}`).toContain("CAMPAIGN_ARG_MISSING_CANDIDATE");
			expect(`${stdout}${stderr}`).not.toContain("ambient-candidate");
		});

		test(`${role} refuses an unsupported declared platform with a typed code only`, () => {
			const { exitCode, stdout, stderr } = runRoot(script, [
				"--platform",
				"windows",
			]);
			expect(exitCode).toBe(1);
			expect(`${stdout}${stderr}`).toContain("OUTPUT_PLATFORM_UNSUPPORTED");
		});

		// The frozen contract asserts a typed error carries stdout "", zero spawned
		// children, and a drained pgid — all values the error object declares about
		// itself. These assert the same properties against the running process,
		// where a regression would actually show up.
		test(`${role} writes nothing to stdout and spawns no child when it refuses`, () => {
			const { exitCode, stdout, stderr } = runRoot(script, [
				"--platform",
				"windows",
			]);
			expect(exitCode).toBe(1);
			expect(stdout).toBe("");
			expect(stderr.trim()).toBe(
				`[${role}] Error: OUTPUT_PLATFORM_UNSUPPORTED`,
			);
			// The banners go to stdout, so this only says anything at all because
			// stdout is the stream being read.
			expect(stdout).not.toContain("CANONICAL COMPARISON CAMPAIGN");
			expect(stdout).not.toContain("running run-");
		});

		test(`${role} starts no child process and leaves its process group drained`, () => {
			const accounting = accountFor(`bun ${script} --platform windows`);
			expect(accounting.status).toBe(1);
			expect(accounting.maxChildren).toBe(0);
			expect(accounting.survivors).toBe(0);
		});

		// There was a per-root test here asserting that a missing evidence
		// directory never printed a path. It could not fail: every root refuses
		// these arguments before the directory is ever consulted — the campaign on
		// CAMPAIGN_ARG_MISSING_STAGED_CAPABILITY, verify and report on
		// CAMPAIGN_ARG_UNKNOWN, since neither accepts `--output-dir` — so the
		// assertion was satisfied by the earlier refusal whether or not the
		// evidence-dir check printed anything. Both halves are pinned where they
		// can actually fail instead, in `r1-flow-hardening.test.ts`:
		// `requireExistingEvidenceDir` and `requireExistingReportEvidenceDir`. The
		// cross-root property this was reaching for is the test below.
		test(`${role} never prints a filesystem path on the error path`, () => {
			const { stdout, stderr } = runRoot(script, [
				"--staged-capability",
				"--fixture-only",
			]);
			const output = `${stdout}${stderr}`;
			expect(output).toContain("CAMPAIGN_ARG_VALUE_MISSING");
			expect(output).not.toContain("/Users/");
			expect(output).not.toContain(".cap");
		});
	}
});
