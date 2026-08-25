#!/usr/bin/env bun
/**
 * G6 V-S sink pre-check producer (Task 2, tracked harness) — the successor to
 * the scratch single-rate precursor.
 *
 * Drives the producer's own target — 120,000 pps (192.0 Mbit/s at 200 B) —
 * into a loopback UDP sink for `--seconds` (default 30) and emits a
 * dual-rate artifact that records required, target, and observed in separate
 * fields so a reader cannot mistake the producer target for the evaluator
 * floor:
 *
 *   requiredPps                 — SINK_HEADROOM_FACTOR × the arm's downstream
 *                                 (1.5 × 77,500 = 116,250), derived from
 *                                 `g6-plan.ts`, never re-typed
 *   targetPps / targetBps       — what this producer aims at (120,000 pps /
 *                                 192.0 Mbit/s at 200 B), deliberately a
 *                                 margin over the floor
 *   saturationBoundaryPps       — 117,600, the design's exact integer (98% of
 *                                 the target), stated as a literal
 *   precheckOfferedPps          — packets the source actually put on loopback
 *                                 per second (its own count, not the target)
 *   precheckDeliveryRatio       — sink-received ÷ source-sent
 *   precheckOriginatorSaturated — `offeredPps < 117,600`: a source that
 *                                 cannot sustain 98% of the producer's target
 *                                 is a starved witness and fires, never
 *                                 passes (ticket 14's rule)
 *
 * Instrument: iperf3 in UDP mode, both roles on this Mac. DISCLOSED SCOPE:
 * this exercises the kernel/socket receive path at the registered rate and
 * payload — the same class of instrument that declared the Mac sink wall in
 * common doc §2.3 — not `mmo-client`'s decode loop, whose cost rides the
 * gate's own cells.
 *
 * Usage (on the Mac, same calendar day as the G6 dispatch):
 *   bun tools/load/g6-sink-precheck.ts \
 *     --out .bench-evidence/g6-sink-precheck-<date>.json [--seconds 30]
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { hostname } from "node:os";

import { canonicalGeneratorIdentity } from "../offbox/host-identity.ts";
import {
	armShape,
	gateRung,
	SINK_DELIVERY_FLOOR,
	SINK_HEADROOM_FACTOR,
} from "./g6-plan.ts";

/* -------------------------------------------------------------------------- */
/* Constants — exact, pinned by the test suite (Task 1)                       */
/* -------------------------------------------------------------------------- */

/** Producer payload in bytes. 120,000 × 200 × 8 = 192,000,000 bit/s. */
export const SINK_PRECHECK_PAYLOAD_BYTES = 200;
/** Producer target in packets per second — a deliberate margin over the floor. */
export const SINK_PRECHECK_TARGET_PPS = 120_000;
/** Producer target in bit/s, derived: targetPps × payload × 8. */
export const SINK_PRECHECK_TARGET_BPS =
	SINK_PRECHECK_TARGET_PPS * SINK_PRECHECK_PAYLOAD_BYTES * 8;
/**
 * The exact saturation boundary: 98% of the target, stated as the design's
 * integer literal (117,600), never derived by multiplication at runtime.
 * A source offering below this is saturated and an untrustworthy witness.
 */
export const SINK_PRECHECK_SATURATION_BOUNDARY_PPS = 117_600;

if (
	SINK_PRECHECK_TARGET_BPS !==
	SINK_PRECHECK_TARGET_PPS * SINK_PRECHECK_PAYLOAD_BYTES * 8
) {
	throw new Error(
		"g6-sink-precheck: target bitrate invariant violated (targetPps × payload × 8)",
	);
}

/* -------------------------------------------------------------------------- */
/* Pure contract — the test suite's interface                                 */
/* -------------------------------------------------------------------------- */

/**
 * The requirement the producer must satisfy, derived from `g6-plan.ts`: the
 * producer's floor is the evaluator's floor (1.5 × the arm's downstream),
 * never a re-typed number.
 */
export function sinkPrecheckRequirement(): {
	armDownstreamPps: number;
	headroomFactor: number;
	requiredPps: number;
} {
	const armDownstreamPps = armShape(gateRung()).downstreamAggregatePps;
	const requiredPps = SINK_HEADROOM_FACTOR * armDownstreamPps;
	return {
		armDownstreamPps,
		headroomFactor: SINK_HEADROOM_FACTOR,
		requiredPps,
	};
}

/** A source offering below the exact boundary is saturated. */
export function originatorSaturated(offeredPps: number): boolean {
	return offeredPps < SINK_PRECHECK_SATURATION_BOUNDARY_PPS;
}

/** Observed facts a completed pre-check run hands the artifact builder. */
export type SinkPrecheckObs = {
	offeredPps: number;
	deliveryRatio: number;
	sentPackets: number;
	lostPackets: number;
	jitterMs: number | null;
	seconds: number;
	rawEndSum: unknown;
	host: string;
	dateIso: string;
};

/**
 * Pure artifact builder: required, target, and observed live in separate
 * fields; comparisons run on the exact raw values; rounding appears only in
 * the human-readable instrument string. `rawEndSum` is passed through so the
 * classifier's reader can re-derive from raw `end.sum` if it ever needs to.
 */
export function buildSinkPrecheckArtifact(
	obs: SinkPrecheckObs,
): Record<string, unknown> {
	const req = sinkPrecheckRequirement();
	const saturated = originatorSaturated(obs.offeredPps);
	return {
		kind: "g6-sink-precheck",
		host: obs.host,
		dateIso: obs.dateIso,
		instrument: `iperf3 UDP loopback, ${SINK_PRECHECK_PAYLOAD_BYTES} B, target ${SINK_PRECHECK_TARGET_PPS} pps (${(SINK_PRECHECK_TARGET_BPS / 1e6).toFixed(1)} Mbit/s), ${Math.round(obs.seconds)} s`,
		payloadBytes: SINK_PRECHECK_PAYLOAD_BYTES,
		armDownstreamPps: req.armDownstreamPps,
		headroomFactor: req.headroomFactor,
		requiredPps: req.requiredPps,
		targetPps: SINK_PRECHECK_TARGET_PPS,
		targetBps: SINK_PRECHECK_TARGET_BPS,
		saturationBoundaryPps: SINK_PRECHECK_SATURATION_BOUNDARY_PPS,
		precheckOfferedPps: obs.offeredPps,
		precheckDeliveryRatio: obs.deliveryRatio,
		precheckOriginatorSaturated: saturated,
		sentPackets: obs.sentPackets,
		lostPackets: obs.lostPackets,
		jitterMs: obs.jitterMs,
		seconds: obs.seconds,
		rawEndSum: obs.rawEndSum,
	};
}

/* -------------------------------------------------------------------------- */
/* CLI — the official producer run (Task 6 V-S)                              */
/* -------------------------------------------------------------------------- */

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 1) {
	const k = process.argv[i];
	const v = process.argv[i + 1];
	if (k?.startsWith("--") && v !== undefined) args.set(k.slice(2), v);
}
const OUT = args.get("out") ?? "g6-sink-precheck.json";
const SECONDS = Number(args.get("seconds") ?? 30);
const PORT = Number(args.get("port") ?? 45211);

// Resolve from PATH; the Homebrew literal only as the Mac fallback. A missing
// binary must fail loudly, not hang — a spawn ENOENT inside this tool once
// stalled a billed rig for half an hour.
const IPERF = Bun.which("iperf3") ?? "/opt/homebrew/bin/iperf3";

function run(
	cmd: string,
	argv: string[],
): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => {
			out += d;
		});
		child.stderr.on("data", (d) => {
			out += d;
		});
		child.on("exit", (code) => resolve({ code: code ?? -1, out }));
	});
}

/** Poll until the one-shot server is actually listening (or give up). */
function waitListening(port: number, ms = 5_000): Promise<boolean> {
	return new Promise((resolve) => {
		const start = Date.now();
		const tick = () => {
			// lsof, not nc: a connection probe would consume the `-1` one-shot
			// server's single client and kill it before the real client dials.
			const probe = spawn(
				"/usr/sbin/lsof",
				["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN"],
				{ stdio: ["ignore", "ignore", "ignore"] },
			);
			probe.on("exit", (code) => {
				if (code === 0) return resolve(true);
				if (Date.now() - start > ms) return resolve(false);
				setTimeout(tick, 100);
			});
		};
		tick();
	});
}

async function main(): Promise<number> {
	// Server in the background: the `-1` one-shot exits only after one client
	// disconnects, so it must be running while the client dials — starting it
	// and awaiting exit before the client is a deadlock.
	const server = spawn(IPERF, ["-s", "-p", String(PORT), "-1"], {
		stdio: ["ignore", "ignore", "ignore"],
	});
	const listening = await waitListening(PORT);
	if (!listening) {
		server.kill("SIGKILL");
		console.error(
			`g6-sink-precheck: iperf3 server never came up on port ${PORT}`,
		);
		return 1;
	}

	const client = await run(IPERF, [
		"-c",
		"127.0.0.1",
		"-p",
		String(PORT),
		"-u",
		"-b",
		String(SINK_PRECHECK_TARGET_BPS),
		"-l",
		String(SINK_PRECHECK_PAYLOAD_BYTES),
		"-t",
		String(SECONDS),
		"--get-server-output",
		"-J",
	]);
	// The one-shot server exits when the client disconnects; reap it.
	await new Promise<void>((resolve) => {
		if (server.exitCode !== null) return resolve();
		server.on("exit", () => resolve());
		setTimeout(() => resolve(), 3_000);
	});

	if (client.code !== 0) {
		console.error(
			`g6-sink-precheck: iperf3 client failed (exit ${client.code}):\n${client.out}`,
		);
		return 1;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(client.out);
	} catch {
		console.error("g6-sink-precheck: iperf3 client output was not JSON");
		return 1;
	}
	const endSum = (parsed as { end?: { sum?: unknown } })?.end?.sum;
	if (endSum === undefined || endSum === null) {
		console.error("g6-sink-precheck: iperf3 client output has no end.sum");
		return 1;
	}

	const sum = endSum as {
		packets?: number;
		lost_packets?: number;
		jitter_ms?: number;
		seconds?: number;
	};
	const sentPackets = sum.packets ?? 0;
	const lostPackets = sum.lost_packets ?? 0;
	if (sentPackets <= 0) {
		console.error("g6-sink-precheck: end.sum reports zero packets sent");
		return 1;
	}
	const seconds = sum.seconds ?? SECONDS;
	const offeredPps = sentPackets / seconds;
	const deliveryRatio = (sentPackets - lostPackets) / sentPackets;

	const artifact = buildSinkPrecheckArtifact({
		offeredPps,
		deliveryRatio,
		sentPackets,
		lostPackets,
		jitterMs: sum.jitter_ms ?? null,
		seconds,
		rawEndSum: endSum,
		host: canonicalGeneratorIdentity(hostname()),
		dateIso: new Date().toISOString(),
	});

	writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);

	// Convenience summary (labeled; grading is falsifierSink's alone).
	const req = sinkPrecheckRequirement();
	const wouldFireVS =
		artifact.precheckOriginatorSaturated ||
		offeredPps < req.requiredPps ||
		deliveryRatio < SINK_DELIVERY_FLOOR;
	console.log(
		`g6-sink-precheck: offered=${offeredPps.toFixed(3)} pps ` +
			`delivery=${deliveryRatio.toFixed(5)} saturated=${artifact.precheckOriginatorSaturated} ` +
			`required=${req.requiredPps} target=${SINK_PRECHECK_TARGET_PPS} ` +
			`wouldFireVS(convenience)=${wouldFireVS}`,
	);
	return 0;
}

if (import.meta.main) {
	process.exitCode = await main();
}
