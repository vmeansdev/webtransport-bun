#!/usr/bin/env bun
/**
 * Record a human release disposition for a cold-start residency diagnostic.
 *
 * Writes `<artifact>.disposition.json` NEXT TO the artifact. It never mutates
 * the artifact, never flips `promotable`, and never changes any exit code:
 * the artifact stays self-describing and red on its own. A release process
 * that encounters `promotable: false` solely due to a cold-start residency
 * review entry may reconcile it against this file; the reconciled status is
 * "promotable-with-reviewed-cold-diagnostic", which is intentionally distinct
 * from plain promotability and must be surfaced to the maintainer.
 *
 * Usage:
 *   bun tools/load/sign-cold-disposition.ts <artifact.json> \
 *     --reviewer "<name>" --reason "<why this residency delta is acceptable>"
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

function arg(flag: string): string {
	const index = process.argv.indexOf(flag);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value) {
		console.error(`missing required ${flag} <value>`);
		process.exit(2);
	}
	return value;
}

const artifactPath = process.argv[2];
if (!artifactPath || artifactPath.startsWith("--")) {
	console.error(
		"usage: sign-cold-disposition.ts <artifact.json> --reviewer <name> --reason <text>",
	);
	process.exit(2);
}
const reviewer = arg("--reviewer");
const reason = arg("--reason");

const raw = readFileSync(artifactPath, "utf8");
const artifact = JSON.parse(raw) as {
	promotable?: boolean;
	summary?: {
		failures?: string[];
		reviewRequired?: string[];
		memory?: {
			coldStartDiagnostic?: {
				status?: string;
				deltaMb?: number | null;
				capMb?: number;
				ratio?: number | null;
			};
		};
	};
};

const diagnostic = artifact.summary?.memory?.coldStartDiagnostic;
if (diagnostic?.status !== "review-required") {
	console.error(
		`nothing to disposition: coldStartDiagnostic.status is ${JSON.stringify(diagnostic?.status)}`,
	);
	process.exit(1);
}
const otherFailures = artifact.summary?.failures ?? [];
if (otherFailures.length > 0) {
	console.error(
		`refusing to disposition an artifact with hard failures: ${JSON.stringify(otherFailures)}`,
	);
	process.exit(1);
}

const disposition = {
	kind: "cold-start-residency-disposition",
	reviewer,
	reason,
	timestamp: new Date().toISOString(),
	acknowledged: {
		deltaMb: diagnostic.deltaMb ?? null,
		capMb: diagnostic.capMb ?? null,
		informationalRatio: diagnostic.ratio ?? null,
		reviewRequired: artifact.summary?.reviewRequired ?? [],
	},
	artifactSha256: createHash("sha256").update(raw).digest("hex"),
	reconciledStatus: "promotable-with-reviewed-cold-diagnostic",
};

const outPath = `${artifactPath}.disposition.json`;
writeFileSync(outPath, JSON.stringify(disposition, null, 2));
console.log(
	`disposition recorded: ${outPath} (artifact remains promotable:${artifact.promotable === true})`,
);
