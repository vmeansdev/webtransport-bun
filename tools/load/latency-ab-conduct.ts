#!/usr/bin/env bun
/**
 * Conductor for the interleaved H7 A/B dispatch.
 *
 * The ladder ran two arms as two long sequential processes and produced one
 * paired observation per rate — which the four-axes synthesis is explicit is not
 * a result. This runs the same two arms as 80 short alternating processes plus 6
 * floor arms, all inside one dispatch, so the comparison is paired across ~64
 * seconds instead of across half an hour and has ten replicates to put an
 * interval on.
 *
 * Method, rungs, replicate count, interleave order, floor rule, honesty check,
 * interval estimator and the four cross-check readings are pre-registered in
 * `docs/research/preregistrations/latency-ab.md`. This file implements that
 * document; it does not get to reinterpret it. The order itself lives in
 * `latency-ab-schedule.ts` with its own tests.
 *
 * One cell = one `bench-latency.ts` process running one rung, because the batch
 * knob is read once at import and cannot be varied inside a process. Fragments
 * land in `LATENCY_AB_OUT_DIR`; `latency-ab-classify.ts` turns them into
 * verdicts, and can be re-run on the same fragments by someone who does not
 * trust whoever ran them.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { type AbCell, abSchedule } from "./latency-ab-schedule.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;

const OUT_DIR = process.env.LATENCY_AB_OUT_DIR ?? join(ROOT, ".bench-evidence");
const TAG = process.env.LATENCY_AB_TAG ?? "local";
const SESSIONS = process.env.LATENCY_AB_SESSIONS ?? "100";
const PAYLOAD_BYTES = process.env.LATENCY_AB_PAYLOAD_BYTES ?? "1150";
const DRIVE_SECONDS = process.env.LATENCY_AB_DRIVE_SECONDS ?? "20";
const SETTLE_MS = process.env.LATENCY_AB_SETTLE_MS ?? "6000";
/**
 * Registered STOP 6. One run in this axis's dispatch log hung 55+ minutes in
 * `epoll` after writing its fragment; an 86-arm dispatch cannot discover that
 * the same way, so an arm that overruns is killed and its cell recorded
 * incomplete.
 */
const ARM_TIMEOUT_MS = parseInt(
	process.env.LATENCY_AB_ARM_TIMEOUT_MS ?? "120000",
	10,
);
/** Cells to run, for local smoke only. Never set on the runner. */
const LIMIT = process.env.LATENCY_AB_LIMIT
	? parseInt(process.env.LATENCY_AB_LIMIT, 10)
	: null;

type CellOutcome = {
	cell: AbCell;
	fragment: string | null;
	exitCode: number | null;
	timedOut: boolean;
	wallSec: number;
};

function fragmentPath(cell: AbCell): string {
	const replicate = String(cell.replicate).padStart(2, "0");
	const index = String(cell.index).padStart(2, "0");
	return join(
		OUT_DIR,
		`bench-latency-ab-${TAG}-${index}-${cell.rung}-r${replicate}-${cell.arm}.json`,
	);
}

async function runCell(cell: AbCell): Promise<CellOutcome> {
	const out = fragmentPath(cell);
	const startedAt = Date.now();
	const child = Bun.spawn(["bun", "tools/load/bench-latency.ts"], {
		cwd: ROOT,
		env: {
			...process.env,
			// The knob is the arm. `batch0` takes the legacy one-at-a-time receive
			// path; `default` leaves the shipped 64 in place, which is what G2 is
			// stated against.
			...(cell.arm === "batch0"
				? { WEBTRANSPORT_DATAGRAM_BATCH: "0" }
				: { WEBTRANSPORT_DATAGRAM_BATCH: undefined }),
			LATENCY_ARM: cell.arm,
			LATENCY_ARRIVAL: "uniform",
			LATENCY_RUNG: cell.rung,
			LATENCY_REPLICATE: String(cell.replicate),
			LATENCY_CELL_INDEX: String(cell.index),
			LATENCY_PORT: String(cell.port),
			LATENCY_SESSIONS: SESSIONS,
			LATENCY_PAYLOAD_BYTES: PAYLOAD_BYTES,
			LATENCY_STEP_SECONDS: DRIVE_SECONDS,
			LATENCY_SETTLE_MS: SETTLE_MS,
			LATENCY_RATES: String(cell.perSessionRate),
			LATENCY_SKIP_BUILD: "1",
			LATENCY_OUT: out,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill("SIGKILL");
	}, ARM_TIMEOUT_MS);
	const exitCode = await child.exited;
	clearTimeout(timer);

	const wallSec = (Date.now() - startedAt) / 1000;
	const text = await stdout;
	const errText = await stderr;
	const exists = await Bun.file(out).exists();
	if (!exists || timedOut) {
		// Keep the tail of both streams: a cell that produced no fragment is the
		// only evidence about itself that will ever exist.
		console.error(errText.slice(-1500));
		console.error(text.slice(-1500));
	}
	return {
		cell,
		fragment: exists && !timedOut ? out : null,
		exitCode,
		timedOut,
		wallSec,
	};
}

async function main(): Promise<void> {
	mkdirSync(OUT_DIR, { recursive: true });
	const schedule = abSchedule();
	const cells = LIMIT === null ? schedule : schedule.slice(0, LIMIT);

	console.log(
		`latency-ab: building load-client (release) once for ${cells.length} cells...`,
	);
	await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();
	if (!(await Bun.file(CLIENT_BIN).exists())) {
		throw new Error(`load-client missing after build: ${CLIENT_BIN}`);
	}

	const outcomes: CellOutcome[] = [];
	const startedAt = Date.now();
	for (const cell of cells) {
		const label = `${cell.index + 1}/${cells.length} rung=${cell.rung} r=${cell.replicate} arm=${cell.arm} port=${cell.port}`;
		console.log(`== latency-ab cell ${label} ==`);
		const outcome = await runCell(cell);
		outcomes.push(outcome);
		console.log(
			`latency-ab: cell ${label} exit=${outcome.exitCode}${outcome.timedOut ? " TIMED-OUT" : ""} wall=${outcome.wallSec.toFixed(1)}s fragment=${outcome.fragment ? "yes" : "MISSING"}`,
		);
	}

	const manifestPath = join(OUT_DIR, `bench-latency-ab-${TAG}-manifest.json`);
	writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				version: 1,
				preregistration: "docs/research/preregistrations/latency-ab.md",
				tag: TAG,
				startedAt: new Date(startedAt).toISOString(),
				wallSec: (Date.now() - startedAt) / 1000,
				config: {
					sessions: SESSIONS,
					payloadBytes: PAYLOAD_BYTES,
					driveSeconds: DRIVE_SECONDS,
					settleMs: SETTLE_MS,
					armTimeoutMs: ARM_TIMEOUT_MS,
					cells: cells.length,
				},
				// Every cell, including the ones that produced nothing: a dispatch
				// that quietly drops its failures is not a dispatch log.
				cells: outcomes.map((o) => ({
					index: o.cell.index,
					arm: o.cell.arm,
					rung: o.cell.rung,
					replicate: o.cell.replicate,
					aggregate: o.cell.aggregate,
					port: o.cell.port,
					exitCode: o.exitCode,
					timedOut: o.timedOut,
					wallSec: o.wallSec,
					fragment: o.fragment,
				})),
			},
			null,
			2,
		)}\n`,
	);

	const missing = outcomes.filter((o) => o.fragment === null).length;
	console.log(
		`latency-ab: ${outcomes.length - missing}/${outcomes.length} cells produced a fragment (${missing} missing), wall=${((Date.now() - startedAt) / 60000).toFixed(1)}min`,
	);
	console.log(`latency-ab: wrote ${manifestPath}`);
}

await main();
// Same reason `bench-latency.ts` exits explicitly: sessions abandoned by an
// exiting child can keep an event loop referenced. Output is already flushed.
process.exit(0);
