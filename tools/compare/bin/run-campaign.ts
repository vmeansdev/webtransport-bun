/**
 * CLI entry for the campaign root (`bun run compare:run`).
 *
 * The root itself (`../run-campaign.ts`) is an official child module and
 * carries no `import.meta.main` block: argv, exit codes and the console are
 * this wrapper's, so the audit can hold the root to its published seams.
 */
import { comparisonErrorCode } from "../evidence.ts";
import {
	parseCampaignArgs,
	printCampaignHelp,
	runCampaign,
	unavailableArmMeasurement,
} from "../run-campaign.ts";

export async function main(argv: readonly string[]): Promise<number> {
	try {
		const args = parseCampaignArgs(argv);
		if (args.help) {
			printCampaignHelp();
			return 0;
		}
		if (args.fixtureOnly) {
			// The package script is a developer convenience. It publishes nothing.
			console.log(
				"[campaign] fixture-only: no official evidence is written. Run the supervisor for an official campaign.",
			);
			return 0;
		}
		await runCampaign(args, { measureArm: unavailableArmMeasurement });
		return 0;
	} catch (err: unknown) {
		console.error(`[campaign] Error: ${comparisonErrorCode(err)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
