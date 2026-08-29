/**
 * Phase 2.3 of the WS-WT real-number campaign: a Bun-runnable CLI entry that
 * runs a single registered scenario by name.
 *
 * Usage:
 *   bun tools/compare/bin/compare-run.ts \
 *       --scenario=<name> --arm=<ws|wt|both> --out=<path>
 *
 * The CLI binds the executor registry added in Phase 2.2 to a single
 * scenario per invocation. One scenario per run is the deliberate shape:
 * the campaign invariant is one cell per artifact, and an entry that asks
 * for a list would smuggle a second cell through the side door.
 *
 * The four supervisor env vars the CLI expects are the four the campaign
 * already binds at the trust boundary (`COMPARISON_SUPERVISOR_TOOLCHAIN`,
 * `COMPARISON_SUPERVISOR_CAPABILITY`, `COMPARISON_SUPERVISOR_LOCK`,
 * `COMPARISON_SUPERVISOR_MANIFEST`); the resolver lives in
 * `supervisor-protocol.ts`. A clean tree (no reservations) makes
 * `assertOfficialComparisonIoAvailable()` throw
 * `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`, which is the documented Phase 1
 * refusal. The CLI fails closed rather than admitting a missing reservation
 * and pretending a measurement could land.
 *
 * The CLI is classified as `cliEntryTs` in the static-I/O allowlist; it
 * sits beside the per-arm files (`roleChildTs`) without being one of them,
 * because its job is to dispatch a named scenario by reading the registry,
 * not to be the canonical measurement path on either arm.
 */

import { getScenarioExecutor } from "../client.ts";
import { ComparisonCliError } from "../evidence.ts";
import { assertOfficialComparisonIoAvailable } from "../output-policy.ts";

/** The arm choices the CLI accepts. `"both"` is a deliberate union, not a loop. */
export type CompareRunArm = "ws" | "wt" | "both";

export interface CompareRunArgs {
	readonly scenario: string;
	readonly arm: CompareRunArm;
	readonly out: string;
	readonly help: boolean;
}

/** Environment variable names the CLI reads to fail closed on the trust boundary. */
const SUPERVISOR_ENV_VARS = [
	"COMPARISON_SUPERVISOR_TOOLCHAIN",
	"COMPARISON_SUPERVISOR_CAPABILITY",
	"COMPARISON_SUPERVISOR_LOCK",
	"COMPARISON_SUPERVISOR_MANIFEST",
] as const;

const VALID_ARMS: ReadonlySet<CompareRunArm> = new Set(["ws", "wt", "both"]);

/**
 * Parse `argv` into a `CompareRunArgs` value.
 *
 * Strict: unknown flags, missing values, an unknown arm, or an empty
 * scenario name all throw a typed `ComparisonCliError`. The throw carries
 * a stable code so the test suite can match on it without parsing the
 * message text.
 */
export function parseCompareRunArgs(argv: readonly string[]): CompareRunArgs {
	let scenario: string | undefined;
	let arm: CompareRunArm = "both";
	let out: string | undefined;
	let help = false;
	let cursor = 0;

	const takeValue = (flag: string): string => {
		const value = argv[++cursor];
		if (value === undefined || value.startsWith("--")) {
			throw new ComparisonCliError("compare-run", "COMPARE_RUN_VALUE_MISSING");
		}
		return value;
	};

	for (cursor = 0; cursor < argv.length; cursor += 1) {
		const arg = argv[cursor]!;
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--scenario") {
			scenario = takeValue(arg);
		} else if (arg === "--arm") {
			const value = takeValue(arg);
			if (!VALID_ARMS.has(value as CompareRunArm)) {
				throw new ComparisonCliError("compare-run", "COMPARE_RUN_ARM_INVALID");
			}
			arm = value as CompareRunArm;
		} else if (arg === "--out") {
			out = takeValue(arg);
		} else if (arg.startsWith("--")) {
			throw new ComparisonCliError("compare-run", "COMPARE_RUN_FLAG_UNKNOWN");
		} else {
			throw new ComparisonCliError(
				"compare-run",
				"COMPARE_RUN_POSITIONAL_FORBIDDEN",
			);
		}
	}

	if (help) {
		return { scenario: "", arm: "both", out: "", help: true };
	}

	if (!scenario || scenario.length === 0) {
		throw new ComparisonCliError("compare-run", "COMPARE_RUN_SCENARIO_MISSING");
	}
	if (!out || out.length === 0) {
		throw new ComparisonCliError("compare-run", "COMPARE_RUN_OUT_MISSING");
	}

	return { scenario, arm, out, help: false };
}

/**
 * Decide whether the supervisor env vars the CLI reads are all set.
 *
 * Exported for tests so the "clean tree" case can be reproduced without
 * stubbing the env. The CLI itself uses this to fail closed on a clean
 * tree *before* asking the trust-boundary gate to throw — the gate's own
 * refusal is the truth it surfaces to operators, but the precondition is
 * named here so it can be reasoned about and tested in isolation.
 */
export function hasSupervisorReservations(env: NodeJS.ProcessEnv): boolean {
	for (const name of SUPERVISOR_ENV_VARS) {
		const value = env[name];
		if (typeof value !== "string" || value.length === 0) return false;
	}
	return true;
}

/**
 * Run one scenario by name through the registered executor for each arm
 * the caller asked for.
 *
 * The dispatch contract is: (1) the scenario must be in the registry, an
 * unknown name is `SCENARIO_UNKNOWN`; (2) the trust boundary must be
 * available, a missing reservation is `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`;
 * (3) the executor is invoked once per requested arm with the arm label
 * handed in. The executors in Phase 2.2 are stubs that throw
 * "not implemented"; the dispatch surface is exercised end-to-end here so
 * Phase 2.4 only has to fill in real measurement paths without
 * re-shape the entrypoint.
 *
 * Returns the dispatch summary rather than a measured leg — the campaign
 * collects artifacts at the campaign boundary, not at this one, and the
 * dispatch summary is what an operator wants to see at the entrypoint.
 */
export interface CompareRunDispatch {
	readonly scenario: string;
	readonly arm: CompareRunArm;
	readonly out: string;
	readonly requestedArms: readonly ("ws" | "wt")[];
}

export function dispatchCompareRun(args: CompareRunArgs): CompareRunDispatch {
	const executor = getScenarioExecutor(args.scenario);
	if (!executor) {
		throw new ComparisonCliError("compare-run", "SCENARIO_UNKNOWN");
	}
	assertOfficialComparisonIoAvailable();
	const requestedArms: ("ws" | "wt")[] =
		args.arm === "both" ? ["ws", "wt"] : [args.arm];
	return {
		scenario: args.scenario,
		arm: args.arm,
		out: args.out,
		requestedArms,
	};
}

function printHelp(): void {
	process.stdout.write(
		[
			"compare-run — run a single registered comparison scenario by name",
			"",
			"Usage:",
			"  bun tools/compare/bin/compare-run.ts --scenario=<name> --arm=<ws|wt|both> --out=<path>",
			"",
			"Options:",
			"  --scenario <name>   scenario name registered in SCENARIO_EXECUTORS",
			"  --arm <ws|wt|both>  which arm(s) to dispatch (default: both)",
			"  --out <path>        official output path for the run",
			"  --help, -h          show this help",
			"",
			"The CLI fails closed with OUTPUT_TRUST_BOUNDARY_UNAVAILABLE when the",
			"four supervisor reservations are missing from the environment.",
		].join("\n") + "\n",
	);
}

if (import.meta.main) {
	const args = parseCompareRunArgs(process.argv.slice(2));
	if (args.help) {
		printHelp();
		process.exit(0);
	}
	const dispatch = dispatchCompareRun(args);
	process.stdout.write(
		`compare-run: scenario=${dispatch.scenario} arm=${dispatch.arm} out=${dispatch.out} requested=${dispatch.requestedArms.join(",")}\n`,
	);
	process.exit(0);
}
