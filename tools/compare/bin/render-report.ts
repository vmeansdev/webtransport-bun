/**
 * CLI entry for the report root (`bun run compare:report`).
 *
 * `../render-report.ts` is an official child module with no entry block of
 * its own; argv handling lives here.
 */
import { comparisonErrorCode } from "../evidence.ts";
import { generateReport, parseReportArgs } from "../render-report.ts";

export function main(argv: readonly string[]): number {
	try {
		// Strip --cells= before staged-trust parse (unknown --* fails closed there).
		const cells: string[] = [];
		const forwarded: string[] = [];
		for (const arg of argv) {
			if (arg.startsWith("--cells=")) {
				const raw = arg.slice("--cells=".length);
				for (const part of raw.split(",")) {
					const trimmed = part.trim();
					if (trimmed.length > 0) cells.push(trimmed);
				}
			} else {
				forwarded.push(arg);
			}
		}
		const args = parseReportArgs(forwarded);
		if (args.fixtureOnly) {
			console.log(
				"[report] fixture-only: no official evidence is read or written. Run the supervisor for an official report.",
			);
			return 0;
		}
		generateReport({
			candidate: args.candidateId,
			campaignId: args.campaignId,
			evidenceDir: args.positionals[0],
			outputFile: args.positionals[1],
			...(cells.length > 0
				? {
						cells,
						headerNote:
							"Phase-4 gate subset (not a failed full 35-cell matrix). serverAggregate loop utilization unobserved.",
					}
				: {}),
		});
		return 0;
	} catch (error: unknown) {
		console.error(`[report] Error: ${comparisonErrorCode(error)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
