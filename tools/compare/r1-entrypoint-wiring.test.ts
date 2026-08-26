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
