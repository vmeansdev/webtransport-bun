#!/usr/bin/env bun
/**
 * Gate G5b's verdict, over every bench-stream artifact of one dispatch.
 *
 * `WEBTRANSPORT_STREAM_BATCH_BYTES` is read once at module init, so a knob-off
 * cell and a knob-on cell cannot share a process and Arm P runs as two harness
 * invocations. This is the third: it collects the per-repeat facts both of them
 * emitted and applies the rules in tools/load/gate-g5b.ts, which were fixed in
 * docs/research/preregistrations/gate-g5b.md before either ran.
 *
 * Usage: bun tools/load/gate-g5b-verdict.ts <artifact.json> [...] > verdict.json
 *
 * It computes nothing itself. Every threshold lives in gate-g5b.ts and every
 * fact was classified by the harness at the time it was measured.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { evaluateGateG5b, type PacedRepeatFacts } from "./gate-g5b.ts";

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
	console.error(
		"usage: bun tools/load/gate-g5b-verdict.ts <bench-stream artifact.json> [...]",
	);
	process.exit(2);
}

const repeats: PacedRepeatFacts[] = [];
const sources: Array<{
	path: string;
	cells: string[];
	batchBytes: number | null;
	diagnosticsEnabled: boolean | null;
	paceTargetGbps: number | null;
}> = [];

for (const path of inputs) {
	const doc = JSON.parse(readFileSync(path, "utf8")) as {
		armP?: Array<PacedRepeatFacts & Record<string, unknown>>;
		config?: {
			p?: {
				paceTargetGbps?: number;
				streamBatch?: Record<string, unknown>;
			};
		};
	};
	const rows = doc.armP ?? [];
	sources.push({
		path,
		cells: [...new Set(rows.map((r) => r.cell))],
		batchBytes:
			(doc.config?.p?.streamBatch?.batchBytes as number | undefined) ?? null,
		diagnosticsEnabled:
			(doc.config?.p?.streamBatch?.diagnosticsEnabled as boolean | undefined) ??
			null,
		paceTargetGbps: doc.config?.p?.paceTargetGbps ?? null,
	});
	for (const row of rows) {
		// Only the fields the rules are allowed to see; `step` and `math` ride
		// along in the artifact for the reader, not for the verdict.
		repeats.push({
			cell: row.cell,
			repeat: row.repeat,
			bucket: row.bucket,
			incomplete: row.incomplete,
			paceTargetGbps: row.paceTargetGbps,
			offeredGbps: row.offeredGbps,
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
			hostCpuPctMedian: row.hostCpuPctMedian,
			serverCpuPct: row.serverCpuPct,
			clientCpuPct: row.clientCpuPct,
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
			`gate-g5b-verdict: duplicate cell repeat ${key} across inputs`,
		);
		process.exit(2);
	}
	seen.add(key);
}

const verdict = { ...evaluateGateG5b(repeats), sources };
const out = process.env.GATE_G5B_OUT;
const json = `${JSON.stringify(verdict, null, 2)}\n`;
if (out) writeFileSync(out, json);
console.log(json);
console.error(
	`gate-g5b-verdict: ${verdict.verdict}${verdict.failedClauses.length ? ` — failed: ${verdict.failedClauses.join(" | ")}` : ""}`,
);
