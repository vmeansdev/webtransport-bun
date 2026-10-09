#!/usr/bin/env bun
/**
 * Conductor for the off-box RTT dispatch — G2's conversion.
 *
 * Phase 1 could not evaluate G2 because a generator sharing four vCPU with the
 * server could not honestly source 15,000 datagrams/s: every cell at that rung
 * failed the registered schedule-lag check. That diagnosis stands; only the
 * machine the generator moved to has changed. The sibling loadgen VM this
 * conductor was first written against is retired, and the generator is now the
 * Mac at the far end of the direct cable, reached through
 * `tools/offbox/mac-generator-entry.sh`.
 *
 * The move costs this file its provisioning step and is better for it. A Linux
 * runner cannot build a macOS/arm64 binary, so nothing is copied: the Mac
 * fetches the candidate, checks it out, refuses a dirty clone, builds, and
 * reports what it built. There is no `/tmp/load-client` to go stale between
 * dispatches, and no arch-match check to pass by luck.
 *
 * Cells, order, floor arms, honesty conditions, integrity marks and the verdict
 * algebra are pre-registered in
 * `.scratch/bare-metal-campaign/registrations/g2-games.md`, which carries the
 * bare-metal re-derivation of every topology-dependent bound in the VM-era
 * `docs/research/preregistrations/gate-g2-offbox-rtt.md`. This file implements
 * those documents; it does not get to reinterpret them. The order lives in
 * `latency-rtt-schedule.ts` with its own tests, and
 * `latency-rtt-classify.ts` turns the fragments into a verdict — separately, so
 * that someone who does not trust whoever ran the dispatch can redo it from the
 * artifact.
 *
 * Refusals (registration §11) are exits, not warnings. An off-box arm that
 * quietly fell back to loopback would produce a fine-looking number and a false
 * claim, so every precondition that could allow that is checked before the first
 * cell runs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import {
	assertCableHost,
	assertCandidate,
	G2_MACGEN_BIN,
	MACGEN_ENTRY,
	macgenDeadlineSeconds,
} from "./g2-offbox.ts";
import { type RttCell, rttSchedule } from "./latency-rtt-schedule.ts";

const ROOT = process.cwd();
const CLIENT_BIN = `${ROOT}/target/release/load-client`;

const OUT_DIR =
	process.env.LATENCY_RTT_OUT_DIR ?? join(ROOT, ".bench-evidence");
const TAG = process.env.LATENCY_RTT_TAG ?? "local";
const SESSIONS = process.env.LATENCY_RTT_SESSIONS ?? "100";
const PAYLOAD_BYTES = process.env.LATENCY_RTT_PAYLOAD_BYTES ?? "1150";
/** Phase-1's shape, carried over unchanged rather than chosen here. */
const DRIVE_SECONDS = process.env.LATENCY_RTT_DRIVE_SECONDS ?? "20";
const SETTLE_MS = process.env.LATENCY_RTT_SETTLE_MS ?? "6000";
/** Phase-1's 120 s guard plus the ssh round trips an off-box cell pays. */
const ARM_TIMEOUT_MS = parseInt(
	process.env.LATENCY_RTT_ARM_TIMEOUT_MS ?? "150000",
	10,
);
const OFFBOX_SSH = (process.env.LATENCY_RTT_OFFBOX_SSH ?? "").trim();
const OFFBOX_URL_HOST = (process.env.LATENCY_RTT_OFFBOX_URL_HOST ?? "").trim();
const OFFBOX_ENTRY = (
	process.env.LATENCY_RTT_OFFBOX_ENTRY ?? MACGEN_ENTRY
).trim();
/**
 * The tree the Mac builds its generator from. Defaults to this checkout's HEAD,
 * which is also what the manifest records as the candidate — the two must be the
 * same tree or the run measures one program and is stamped against another.
 */
const OFFBOX_CANDIDATE = (
	process.env.LATENCY_RTT_OFFBOX_CANDIDATE ?? ""
).trim();
/**
 * The connect ramp the deadline has to cover on top of the drive window: 100
 * sessions dialled over the cable, plus the client's own exit. Registered on the
 * gate page; carried here as the default so the watchdog cannot be left unset.
 */
const CONNECT_RAMP_SECONDS = parseInt(
	process.env.LATENCY_RTT_CONNECT_RAMP_SECONDS ?? "45",
	10,
);
/** macOS has no `timeout(1)`; the entry script's watchdog is the only deadline. */
const OFFBOX_DEADLINE_SEC = macgenDeadlineSeconds(
	parseInt(DRIVE_SECONDS, 10),
	CONNECT_RAMP_SECONDS,
);
/** Cells to run, for local smoke only. Never set on the runner. */
const LIMIT = process.env.LATENCY_RTT_LIMIT
	? parseInt(process.env.LATENCY_RTT_LIMIT, 10)
	: null;
/**
 * Registration §5: cell 0 doubles as the reachability pre-flight. Below this
 * many sessions the whole dispatch aborts rather than producing 21 more cells
 * that cannot mean anything.
 */
const PREFLIGHT_MIN_SESSIONS = 90;

function refuse(reason: string): never {
	console.error(`latency-rtt: REFUSED\n  ${reason}`);
	process.exit(1);
}

function sh(argv: string[]): { status: number | null; stderr: string } {
	const res = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
	return {
		status: res.exitCode,
		stderr: new TextDecoder().decode(res.stderr).trim(),
	};
}

function shOut(argv: string[]): string {
	const res = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
	return new TextDecoder().decode(res.stdout).trim();
}

type CellOutcome = {
	cell: RttCell;
	fragment: string | null;
	exitCode: number | null;
	timedOut: boolean;
	wallSec: number;
	sessionsOk: number | null;
};

function fragmentPath(cell: RttCell): string {
	const replicate = String(cell.replicate).padStart(2, "0");
	const index = String(cell.index).padStart(2, "0");
	return join(
		OUT_DIR,
		`bench-latency-rtt-${TAG}-${index}-${cell.rung}-r${replicate}.json`,
	);
}

async function runCell(cell: RttCell, candidate: string): Promise<CellOutcome> {
	const out = fragmentPath(cell);
	const offbox = cell.placement === "offbox";
	const startedAt = Date.now();
	const child = Bun.spawn(["bun", "tools/load/bench-latency.ts"], {
		cwd: ROOT,
		env: {
			...process.env,
			// The gate is stated against the shipped default. No knob is set here,
			// in either direction: an unset variable is the product's own value.
			WEBTRANSPORT_DATAGRAM_BATCH: undefined,
			LATENCY_ARM: cell.rung,
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
			LATENCY_OFFBOX_SSH: offbox ? OFFBOX_SSH : "",
			LATENCY_OFFBOX_URL_HOST: offbox ? OFFBOX_URL_HOST : "",
			LATENCY_OFFBOX_CANDIDATE: offbox ? candidate : "",
			LATENCY_OFFBOX_ENTRY: OFFBOX_ENTRY,
			LATENCY_OFFBOX_DEADLINE_SEC: String(OFFBOX_DEADLINE_SEC),
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
		// A cell that produced no fragment is the only evidence about itself that
		// will ever exist.
		console.error(errText.slice(-1500));
		console.error(text.slice(-1500));
	}

	let sessionsOk: number | null = null;
	if (exists && !timedOut) {
		try {
			const frag = JSON.parse(await Bun.file(out).text());
			sessionsOk = frag?.steps?.[0]?.sessionsOk ?? null;
		} catch {
			sessionsOk = null;
		}
	}

	return {
		cell,
		fragment: exists && !timedOut ? out : null,
		exitCode,
		timedOut,
		wallSec,
		sessionsOk,
	};
}

async function main(): Promise<void> {
	const schedule = rttSchedule();
	const cells = LIMIT === null ? schedule : schedule.slice(0, LIMIT);
	const needsOffbox = cells.some((c) => c.placement === "offbox");

	// §11.6 — the harness that produced an artifact must be the tree the artifact
	// names.
	const head = shOut(["git", "rev-parse", "HEAD"]);
	const dirty = shOut(["git", "status", "--porcelain"])
		.split("\n")
		.filter((l) => l.trim().length > 0);
	if (!head) refuse("git HEAD unreadable");
	if (dirty.length > 0) {
		refuse(`dirty tree: ${dirty.slice(0, 5).join(", ")}`);
	}

	// §11.1-11.2 are checked before the build: a dispatch that is going to be
	// refused should be refused in a second, not after a release compile.
	// The candidate the Mac builds is this checkout's HEAD unless overridden, and
	// the manifest records the same value: one tree measured, one tree stamped.
	const candidate = OFFBOX_CANDIDATE || head;
	if (needsOffbox) {
		if (!OFFBOX_SSH) {
			refuse("LATENCY_RTT_OFFBOX_SSH is required for off-box cells");
		}
		try {
			assertCableHost(OFFBOX_URL_HOST, "LATENCY_RTT_OFFBOX_URL_HOST");
			assertCandidate(candidate);
		} catch (err) {
			refuse(String(err instanceof Error ? err.message : err));
		}
	}

	console.log(
		`latency-rtt: building load-client (release) once for ${cells.length} cells...`,
	);
	await $`cd ${ROOT} && CARGO_TARGET_DIR=${ROOT}/target cargo build -p reference --bin load-client --release`.quiet();
	if (!(await Bun.file(CLIENT_BIN).exists())) {
		refuse(`load-client missing after build: ${CLIENT_BIN}`);
	}

	let remoteArch: string | null = null;
	let entrySha256: string | null = null;
	let planOutput: string | null = null;
	if (needsOffbox) {
		const ping = sh([
			"ssh",
			"-o",
			"BatchMode=yes",
			"-o",
			"ConnectTimeout=10",
			OFFBOX_SSH,
			"true",
		]);
		if (ping.status !== 0) {
			refuse(`ssh to ${OFFBOX_SSH} failed: ${ping.stderr.slice(0, 300)}`);
		}
		// Recorded, not gated. Nothing is copied to the generator any more, so a
		// mismatched arch is no longer a way to fail — but a run should still say
		// what machine produced its load.
		remoteArch = shOut([
			"ssh",
			"-o",
			"BatchMode=yes",
			OFFBOX_SSH,
			"uname",
			"-m",
		]);

		// The entry script the run executes is the Mac's provisioned copy, not the
		// candidate's file. That is the one piece of this harness a candidate SHA
		// does not describe, so its hash is recorded here and the gate page pins
		// the value it must equal.
		entrySha256 =
			shOut([
				"ssh",
				"-o",
				"BatchMode=yes",
				OFFBOX_SSH,
				"shasum",
				"-a",
				"256",
				OFFBOX_ENTRY,
			]).split(/\s+/)[0] ?? null;
		if (!entrySha256) {
			refuse(
				`no ${OFFBOX_ENTRY} on ${OFFBOX_SSH} — provision the generator entry ` +
					"script first (docs/research/runbooks/mac-generator-cable.md §8)",
			);
		}

		// `--plan` resolves the candidate and prints the exact build and exec it
		// would perform, without running anything. It is the cheapest possible
		// proof that the clone exists, the SHA is reachable, and the `--bin`
		// selector is inside the script's closed set: all three refuse with exit 3
		// mid-dispatch otherwise, twenty-two cells deep.
		const plan = Bun.spawnSync([
			"ssh",
			"-o",
			"BatchMode=yes",
			OFFBOX_SSH,
			OFFBOX_ENTRY,
			"--bin",
			G2_MACGEN_BIN,
			"--candidate",
			candidate,
			"--plan",
		]);
		planOutput = new TextDecoder().decode(plan.stdout).trim();
		if (plan.exitCode !== 0) {
			refuse(
				`generator --plan refused (exit ${plan.exitCode}): ` +
					`${new TextDecoder().decode(plan.stderr).trim().slice(0, 300)}`,
			);
		}
		console.log(
			`latency-rtt: macgen ssh=${OFFBOX_SSH} urlHost=${OFFBOX_URL_HOST} bin=${G2_MACGEN_BIN} candidate=${candidate} deadline=${OFFBOX_DEADLINE_SEC}s arch=${remoteArch} entry=${OFFBOX_ENTRY} entrySha256=${entrySha256}`,
		);
	}

	mkdirSync(OUT_DIR, { recursive: true });

	// Idle-path context for the registration's wireCost disclosure. Recorded, not
	// gated: a ping is not a QUIC round trip.
	const generatorHost = OFFBOX_SSH.includes("@")
		? (OFFBOX_SSH.split("@")[1] ?? OFFBOX_SSH)
		: OFFBOX_SSH;
	const pathPing = needsOffbox
		? shOut(["ping", "-c", "200", "-i", "0.05", "-q", generatorHost])
		: "";

	const outcomes: CellOutcome[] = [];
	const startedAt = Date.now();
	let aborted: string | null = null;
	for (const cell of cells) {
		const label = `${cell.index + 1}/${cells.length} rung=${cell.rung} r=${cell.replicate} placement=${cell.placement} port=${cell.port}`;
		console.log(`== latency-rtt cell ${label} ==`);
		const outcome = await runCell(cell, candidate);
		outcomes.push(outcome);
		console.log(
			`latency-rtt: cell ${label} exit=${outcome.exitCode}${outcome.timedOut ? " TIMED-OUT" : ""} wall=${outcome.wallSec.toFixed(1)}s sessionsOk=${outcome.sessionsOk ?? "n/a"} fragment=${outcome.fragment ? "yes" : "MISSING"}`,
		);
		if (
			cell.index === 0 &&
			cell.placement === "offbox" &&
			(outcome.sessionsOk ?? 0) < PREFLIGHT_MIN_SESSIONS
		) {
			aborted = "offbox-unreachable";
			console.error(
				`latency-rtt: ABORT offbox-unreachable — cell 0 produced ${outcome.sessionsOk ?? 0} sessions (< ${PREFLIGHT_MIN_SESSIONS}). No further cell runs; no partial result may be quoted.`,
			);
			break;
		}
	}

	const manifestPath = join(OUT_DIR, `bench-latency-rtt-${TAG}-manifest.json`);
	writeFileSync(
		manifestPath,
		`${JSON.stringify(
			{
				version: 1,
				preregistration: "docs/research/preregistrations/gate-g2-offbox-rtt.md",
				tag: TAG,
				candidateSha: head,
				generatorCandidateSha: candidate,
				startedAt: new Date(startedAt).toISOString(),
				wallSec: (Date.now() - startedAt) / 1000,
				aborted,
				offbox: {
					ssh: OFFBOX_SSH || null,
					urlHost: OFFBOX_URL_HOST || null,
					bin: G2_MACGEN_BIN,
					entry: OFFBOX_ENTRY,
					entrySha256,
					deadlineSec: OFFBOX_DEADLINE_SEC,
					connectRampSec: CONNECT_RAMP_SECONDS,
					plan: planOutput,
					remoteArch,
					pathPing: pathPing || null,
				},
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
					rung: o.cell.rung,
					placement: o.cell.placement,
					replicate: o.cell.replicate,
					aggregate: o.cell.aggregate,
					port: o.cell.port,
					exitCode: o.exitCode,
					timedOut: o.timedOut,
					wallSec: o.wallSec,
					sessionsOk: o.sessionsOk,
					fragment: o.fragment,
				})),
			},
			null,
			2,
		)}\n`,
	);

	const missing = outcomes.filter((o) => o.fragment === null).length;
	console.log(
		`latency-rtt: ${outcomes.length - missing}/${cells.length} cells produced a fragment (${missing} missing${aborted ? `, ABORTED ${aborted}` : ""}), wall=${((Date.now() - startedAt) / 60000).toFixed(1)}min`,
	);
	console.log(`latency-rtt: wrote ${manifestPath}`);
	if (aborted) process.exit(2);
}

await main();
// Same reason `bench-latency.ts` exits explicitly: sessions abandoned by an
// exiting child can keep an event loop referenced. Output is already flushed.
process.exit(0);
