#!/usr/bin/env bun
/**
 * Gate G5's verdict, over every bench-stream artifact of one dispatch.
 *
 * `WEBTRANSPORT_STREAM_BATCH_BYTES` is read once at module init, so a knob-off
 * cell and a knob-on cell cannot share a process and Arm G runs as two harness
 * invocations. This is the third: it collects the per-repeat facts both of them
 * emitted and applies the rules in tools/load/gate-g5.ts, which were fixed in
 * docs/research/preregistrations/gate-g5-bulk.md before either ran.
 *
 * Usage: bun tools/load/gate-g5-verdict.ts <artifact.json> [...] > verdict.json
 *
 * It computes nothing itself. Every threshold lives in gate-g5.ts and every
 * fact was classified by the harness at the time it was measured.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { evaluateGateG5, type GateRepeatFacts } from "./gate-g5.ts";

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
	console.error(
		"usage: bun tools/load/gate-g5-verdict.ts <bench-stream artifact.json> [...]",
	);
	process.exit(2);
}

const repeats: GateRepeatFacts[] = [];
const sources: Array<{
	path: string;
	cells: string[];
	batchBytes: number | null;
	diagnosticsEnabled: boolean | null;
}> = [];

for (const path of inputs) {
	const doc = JSON.parse(readFileSync(path, "utf8")) as {
		armG?: Array<GateRepeatFacts & Record<string, unknown>>;
		config?: { g?: { streamBatch?: Record<string, unknown> } };
	};
	const rows = doc.armG ?? [];
	sources.push({
		path,
		cells: [...new Set(rows.map((r) => r.cell))],
		batchBytes:
			(doc.config?.g?.streamBatch?.batchBytes as number | undefined) ?? null,
		diagnosticsEnabled:
			(doc.config?.g?.streamBatch?.diagnosticsEnabled as boolean | undefined) ??
			null,
	});
	for (const row of rows) {
		// Only the fields the rules are allowed to see; `step` and `math` ride
		// along in the artifact for the reader, not for the verdict.
		repeats.push({
			cell: row.cell,
			repeat: row.repeat,
			bucket: row.bucket,
			incomplete: row.incomplete,
			deliveredMbps: row.deliveredMbps,
			packageMeanBytesPerCrossing: row.packageMeanBytesPerCrossing,
			harnessMeanBytesPerCrossing: row.harnessMeanBytesPerCrossing,
			crossingsPerSecond: row.crossingsPerSecond,
			maxBatchBytes: row.maxBatchBytes,
			batchedCrossings: row.batchedCrossings,
			serverSocketDrops: row.serverSocketDrops,
			coResidentDrops: row.coResidentDrops,
			coResidentDropVerdict: row.coResidentDropVerdict,
			serverSocketRxQueueBytesAtEnd: row.serverSocketRxQueueBytesAtEnd,
			queuedBytesPerStream: row.queuedBytesPerStream,
			queuedBytesPerSession: row.queuedBytesPerSession,
			explicitWindowFieldsSet: row.explicitWindowFieldsSet,
			insideShippedPerSessionBudget: row.insideShippedPerSessionBudget,
			batchBytesConfigured: row.batchBytesConfigured,
			serverCpuMsPerGbit: row.serverCpuMsPerGbit,
			rssMbPeak: row.rssMbPeak,
		});
	}
}

// The same cell measured twice under two different knobs would be two arms
// wearing one label, so duplicates end the run rather than being averaged.
const seen = new Set<string>();
for (const r of repeats) {
	const key = `${r.cell}-r${r.repeat}`;
	if (seen.has(key)) {
		console.error(
			`gate-g5-verdict: duplicate cell repeat ${key} across inputs`,
		);
		process.exit(2);
	}
	seen.add(key);
}

const verdict = { ...evaluateGateG5(repeats), sources };
const out = process.env.GATE_G5_OUT;
const json = `${JSON.stringify(verdict, null, 2)}\n`;
if (out) writeFileSync(out, json);
console.log(json);
console.error(
	`gate-g5-verdict: ${verdict.verdict}${verdict.failedClauses.length ? ` — failed: ${verdict.failedClauses.join(" | ")}` : ""}`,
);
