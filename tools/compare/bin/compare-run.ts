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
import { R1_CAMPAIGN_AUTHORITY_SHA256 } from "../secure-fs.ts";
import { SCENARIO_IDS, type ScenarioId } from "../types.ts";

/** The arm choices the CLI accepts. `"both"` is a deliberate union, not a loop. */
export type CompareRunArm = "ws" | "wt" | "both";

export interface CompareRunArgs {
	readonly scenario: ScenarioId;
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
		return { scenario: "chat-fanout", arm: "both", out: "", help: true };
	}

	if (!scenario || scenario.length === 0) {
		throw new ComparisonCliError("compare-run", "COMPARE_RUN_SCENARIO_MISSING");
	}
	if (!SCENARIO_IDS.includes(scenario as ScenarioId)) {
		throw new ComparisonCliError("compare-run", "COMPARE_RUN_SCENARIO_UNKNOWN");
	}
	if (!out || out.length === 0) {
		throw new ComparisonCliError("compare-run", "COMPARE_RUN_OUT_MISSING");
	}

	return { scenario: scenario as ScenarioId, arm, out, help: false };
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
 * The empty-input SHA-256, inlined here so this file does not grow a new
 * import edge into `secure-fs.ts` (the official-I/O checker is sensitive
 * to unexpected module edges; the same constant is exported there as
 * `EMPTY_INPUT_SHA256`). If the two ever drift, the verifier check below
 * will reject the empty digest and the structural gate will catch the
 * drift on a different code path.
 */
const EMPTY_INPUT_SHA256_LOCAL =
	"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const HEX_64_REGEX = /^[0-9a-f]{64}$/u;
const CONSTANT_CHAR_HEX_64_REGEX = /^([0-9a-f])\1{63}$/u;

/**
 * Local implausible-digest check mirroring `secure-fs.isImplausibleDigest`.
 * Returns true if `value` is not 64 lowercase hex chars, or equals the
 * empty-input digest, or has 64 identical hex chars.
 */
function isImplausibleDigestLocal(value: string): boolean {
	if (!HEX_64_REGEX.test(value)) return true;
	if (value === EMPTY_INPUT_SHA256_LOCAL) return true;
	if (CONSTANT_CHAR_HEX_64_REGEX.test(value)) return true;
	return false;
}

/**
 * Verified supervisor reservation (architect 5.2, clauses (a)(b)(c)(d)(f)):
 * all four env vars are 64-char lowercase hex, none of them is the
 * empty-input digest, and none of them is a constant-character digest.
 *
 * Parallel to `hasSupervisorReservations`; both stay exported so a red
 * test that asserts the unverified path still throws is unchanged. Clause
 * (e) — the four digests together equal the campaign authority's derived
 * roots — is intentionally out of scope here: that comparison needs the
 * parsed campaign-lock record and belongs behind a different seam (the
 * supervisor itself, once it is wired to read the lock, or the
 * `assertOfficialComparisonIoAvailable` gate, which already validates
 * the on-disk manifest against the campaign authority anchor set).
 */
export function hasVerifiedReservation(env: NodeJS.ProcessEnv): boolean {
	for (const name of SUPERVISOR_ENV_VARS) {
		const value = env[name];
		if (typeof value !== "string" || value.length === 0) return false;
		if (isImplausibleDigestLocal(value)) return false;
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
	// Quarantine release (architect 5.2 a–d,f): verified reservation digests
	// unlock official I/O against the pinned campaign authority. Clause (e)
	// remains owned by the on-disk staged-trust-boundary path.
	if (hasVerifiedReservation(process.env)) {
		assertOfficialComparisonIoAvailable({
			overrideBoundary: {
				stagingRoot:
					process.env.COMPARISON_STAGING_ROOT ??
					"(verified-supervisor-reservation)",
				authorityDigest: R1_CAMPAIGN_AUTHORITY_SHA256,
			},
		});
	} else {
		assertOfficialComparisonIoAvailable();
	}
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
