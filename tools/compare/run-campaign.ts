/**
 * Task 10: Campaign Orchestrator CLI.
 *
 * Usage:
 *   bun tools/compare/run-campaign.ts --scenarios <ids> --transports <ws|wt|both> --output-dir <dir>
 */

import { SCENARIO_IDS, type ScenarioId } from "./types.ts";

export interface CampaignArgs {
	readonly scenarios: readonly ScenarioId[];
	readonly transports: "ws" | "wt" | "both";
	readonly outputDir: string;
	readonly help?: boolean;
}

export function parseCampaignArgs(argv: readonly string[]): CampaignArgs {
	let scenarios: ScenarioId[] = [...SCENARIO_IDS];
	let transports: "ws" | "wt" | "both" = "both";
	let outputDir = "./evidence";
	let help = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--scenarios") {
			const val = argv[++i] ?? "";
			if (val === "all") {
				scenarios = [...SCENARIO_IDS];
			} else {
				const list = val.split(",").map((s) => s.trim()) as ScenarioId[];
				for (const s of list) {
					if (!SCENARIO_IDS.includes(s)) {
						throw new Error(`Invalid scenario ID: ${s}`);
					}
				}
				scenarios = list;
			}
		} else if (arg === "--transports") {
			const val = argv[++i];
			if (val !== "ws" && val !== "wt" && val !== "both") {
				throw new Error(
					`Invalid --transports: ${val}; expected 'ws', 'wt', or 'both'`,
				);
			}
			transports = val;
		} else if (arg === "--output-dir") {
			outputDir = argv[++i] ?? "";
			if (!outputDir) throw new Error("Missing value for --output-dir");
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}

	return {
		scenarios,
		transports,
		outputDir,
		help,
	};
}

export function printCampaignHelp(): void {
	console.log(`
WebTransport vs WebSocket Comparison Campaign Runner

Usage:
  bun tools/compare/run-campaign.ts [options]

Options:
  --scenarios <list|all>   Comma-separated scenario IDs or 'all' (default: all)
  --transports <ws|wt|both> Transports to evaluate (default: both)
  --output-dir <dir>       Directory to write evidence artifacts (default: ./evidence)
  --help, -h               Show this help message
`);
}

// Entrypoint when invoked directly via CLI
if (import.meta.main) {
	try {
		const args = parseCampaignArgs(process.argv.slice(2));
		if (args.help) {
			printCampaignHelp();
			process.exit(0);
		}
		console.log(
			`[campaign] Starting campaign for ${args.scenarios.length} scenarios across ${args.transports} transports...`,
		);
	} catch (err: unknown) {
		console.error(`[campaign] Error: ${(err as Error).message}`);
		process.exit(1);
	}
}
