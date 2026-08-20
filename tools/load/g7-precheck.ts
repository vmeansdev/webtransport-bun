/**
 * PF1's producer: drives `g7-sink` at the rates the amended bar demands and
 * emits the `PreflightReport` that `g7-plan.ts`'s `evaluatePreflight` grades.
 *
 * Why this file exists (campaign plan v3-C2): `bench-g7.ts` ships the PF1
 * *evaluator* and nothing in the tree ever produced a report for it. PF1 was a
 * pre-check with no instrument, which is how a rerun could be planned against a
 * bar that four of its cells were already known to exceed.
 *
 * What it does NOT do, deliberately:
 *
 * - It does not touch `tools/load/g7-plan.ts` or `tools/load/g7-classify.ts`.
 *   The amended event bar is injected through `evaluatePreflight`'s existing
 *   `req` parameter (§AMENDED_SINK_EVENTS_PER_SEC below), so the gate's own
 *   evaluator grades the report unmodified and the gate branch stays untouched.
 * - It does not grade the gate. It produces one artifact and one verdict about
 *   the *instrument*, on the run's own calendar day, on loopback.
 * - It does not pace. The source (`g7-precheck-source`) writes flat out, so the
 *   rate the sink achieves is the sink's ceiling. A paced source would measure
 *   the pacer.
 *
 * Registration: `.scratch/bare-metal-campaign/registrations/g7-stream-egress.md`
 * §PF1 amendment. That page carries the arithmetic; this file carries only the
 * bar it was ruled to be.
 */

import { writeFileSync } from "node:fs";
import {
	evaluatePreflight,
	type PreflightReport,
	type PreflightRequirements,
	preflightRequirements,
	TOKEN_WRITE_BYTES,
} from "./g7-plan.ts";
import { createMonotonicClock } from "./latency-clock.ts";
import {
	type CpuSnapshot,
	hostCpuPct,
	pidCpuPct,
	readHostCpu,
	readPidCpuTicks,
} from "./g7-procfs.ts";

const ROOT = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");

const SINK_BIN = process.env.G7_SINK_BIN ?? `${ROOT}/target/release/g7-sink`;
const SOURCE_BIN =
	process.env.G7_PRECHECK_SOURCE_BIN ??
	`${ROOT}/target/release/g7-precheck-source`;
const OUT = process.env.G7_PRECHECK_OUT ?? `${ROOT}/.bench-evidence/g7-precheck.json`;

/**
 * The amended PF1 write-event bar, per the maintainer ruling folded into
 * `.scratch/bare-metal-campaign/plan-run1.md` v2-delta-2 and v3-C2:
 *
 *   > amend PF1 to 1.5x the highest-rate cell (1.5x125.5k)
 *
 * 125,500 write-events/s is `B-1k`'s **achieved** rate in run 32258562623
 * (ticket 31, 2026-08-20 entry); 1.5 x 125,500 = 188,250. The original bar was
 * 1.5 x 25,000 = 37,500, which is what `preflightRequirements()` still returns
 * and what the gate branch must keep returning — the amendment lives on the
 * registration page and is injected here, not patched into the gate tree.
 */
export const AMENDED_SINK_EVENTS_PER_SEC = 188_250;

/** Seconds of driven window per shape. Overridable for a smoke run only. */
const DURATION_SEC = Number(process.env.G7_PRECHECK_DURATION ?? 20);
/** Sessions in the event shape. The token arm's gate rung population. */
const EVENT_SESSIONS = Number(process.env.G7_PRECHECK_EVENT_SESSIONS ?? 1000);
/** Sessions x streams in the byte shape. G5b's operating point, as the gate uses. */
const BYTE_SESSIONS = Number(process.env.G7_PRECHECK_BYTE_SESSIONS ?? 4);
const BYTE_STREAMS_PER_SESSION = Number(
	process.env.G7_PRECHECK_BYTE_STREAMS ?? 4,
);
const BYTE_WRITE_BYTES = Number(process.env.G7_PRECHECK_BYTE_WRITE ?? 65_536);
const BASE_PORT = Number(process.env.G7_PRECHECK_PORT ?? 4491);
/** Per-session connect stagger for the event shape, matching the gate's ramp. */
const CONNECT_STAGGER_MS = Number(process.env.G7_PRECHECK_STAGGER_MS ?? 5);
const SAMPLE_INTERVAL_MS = 1000;
/**
 * Percent of the whole box at which the pre-check's own source counts as the
 * binding constraint. Same 90 the gate's saturation rule uses, in the unit that
 * rule's *host* reading is already in — see the registration page's §3 on why
 * the sink's own 90 is not in that unit.
 */
const SOURCE_SATURATION_PCT = 90;

export const AMENDED_REQUIREMENTS: PreflightRequirements = {
	...preflightRequirements(),
	sinkEventsPerSec: AMENDED_SINK_EVENTS_PER_SEC,
};

// ---------------------------------------------------------------------------
// Shape results, and the pure function that turns them into a report
// ---------------------------------------------------------------------------

export type ShapeResult = {
	shape: "bytes" | "events";
	/** Sink-side achieved rate: bytes/s for the byte shape, records/s for events. */
	sinkRatePerSec: number | null;
	/** Source-side achieved rate in the same unit. */
	sourceRatePerSec: number | null;
	/** The source's own declaration that it could not source its offer (K16). */
	sourceShortfall: boolean;
	/** Percent of the whole host, `/proc/stat` derived. Median over the window. */
	hostCpuPctMedian: number | null;
	/** Percent of ONE core. Reported in both units — see the page's §3 on why. */
	sinkCpuPctOfOneCoreMedian: number | null;
	sourceCpuPctOfOneCoreMedian: number | null;
	/** The same two figures as a percent of the box's schedulable capacity. */
	sinkCpuPctOfHost: number | null;
	sourceCpuPctOfHost: number | null;
	sinkSummary: Record<string, unknown> | null;
	sourceSummary: Record<string, unknown> | null;
	loopback: boolean;
	clockDeltaMs: number | null;
	notes: string[];
};

/**
 * The report `evaluatePreflight` reads, built from the two shapes.
 *
 * Two rules are fixed here rather than left to whoever reads the artifact:
 * the host-CPU figure is the **max** of the two shapes' medians, so a saturated
 * shape cannot be averaged away by a quiet one; and `sourceShortfall` is the
 * **or** of the two, so either shape failing to source its offer fails the
 * pre-check.
 */
export function buildPreflightReport(
	shapes: readonly ShapeResult[],
	opts: { sameDay: boolean },
): PreflightReport {
	const byShape = (name: ShapeResult["shape"]) =>
		shapes.find((s) => s.shape === name) ?? null;
	const bytes = byShape("bytes");
	const events = byShape("events");
	const hostMedians = shapes
		.map((s) => s.hostCpuPctMedian)
		.filter((v): v is number => v !== null);
	const clockDeltas = shapes
		.map((s) => s.clockDeltaMs)
		.filter((v): v is number => v !== null);
	return {
		sinkBytesPerSecObserved: bytes?.sinkRatePerSec ?? null,
		sinkEventsPerSecObserved: events?.sinkRatePerSec ?? null,
		sourceHostCpuPctMedian:
			hostMedians.length === shapes.length && hostMedians.length > 0
				? Math.max(...hostMedians)
				: null,
		sourceShortfall: shapes.some((s) => s.sourceShortfall),
		clockDeltaMs:
			clockDeltas.length === shapes.length && clockDeltas.length > 0
				? clockDeltas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
				: null,
		sameDay: opts.sameDay,
		loopback: shapes.every((s) => s.loopback),
	};
}

// ---------------------------------------------------------------------------
// Running one shape
// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
	const usable = values.filter((v) => Number.isFinite(v));
	if (usable.length === 0) return null;
	const sorted = [...usable].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? null;
}

function parseTagged<T>(stdout: string, tag: string): T | null {
	const line = stdout.split("\n").find((l) => l.startsWith(`${tag}: `));
	if (!line) return null;
	try {
		return JSON.parse(line.slice(tag.length + 2)) as T;
	} catch {
		return null;
	}
}

function parseTaggedNumber(stdout: string, tag: string): number | null {
	const line = stdout.split("\n").find((l) => l.startsWith(`${tag}: `));
	if (!line) return null;
	const value = Number(line.slice(tag.length + 2).trim());
	return Number.isFinite(value) ? value : null;
}

/** Schedulable hardware contexts: the denominator a percent-of-one-core figure
 * has to be divided by before it can be read as "how much of the box". */
const HW_THREADS = navigator.hardwareConcurrency;

type ShapeSpec = {
	shape: "bytes" | "events";
	port: number;
	sourceArgs: string[];
	sinkArgs: string[];
	targetRatePerSec: number;
	/** Which sink counter is this shape's achieved rate. */
	sinkCounter: "bytesRead" | "records";
};

async function runShape(spec: ShapeSpec): Promise<ShapeResult> {
	const notes: string[] = [];
	const clock = await createMonotonicClock(false);

	const ourClockBeforeSpawn = clock.now();
	const source = Bun.spawn([SOURCE_BIN, ...spec.sourceArgs], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const sourceOut = new Response(source.stdout).text();
	const sourceErr = new Response(source.stderr).text();
	// The clock bracket has to close at the source's exit, not at the end of the
	// shape: the sink outlives the source by its drain grace, and reading our own
	// clock after that turns a sub-millisecond agreement into a 30-second
	// "disagreement". The smoke run that found this is why the reading is taken
	// here and not beside the parse.
	const sourceExitClockNs = source.exited.then(() => clock.now());

	// The source prints its port and a clock bracket before it can serve. Give
	// it a moment to bind, then start the sink against it.
	await Bun.sleep(1500);

	const sink = Bun.spawn([SINK_BIN, ...spec.sinkArgs], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	const sinkOut = new Response(sink.stdout).text();
	const sinkErr = new Response(sink.stderr).text();

	const sinkTicks0 = readPidCpuTicks(sink.pid);
	const sourceTicks0 = readPidCpuTicks(source.pid);
	let sinkTicksLast = sinkTicks0;
	let sourceTicksLast = sourceTicks0;
	let prevHost: CpuSnapshot | null = readHostCpu();
	const hostSamples: number[] = [];
	const startedAtMs = Date.now();

	while (!(await Promise.race([sink.exited.then(() => true), Bun.sleep(SAMPLE_INTERVAL_MS).then(() => false)]))) {
		const nextHost = readHostCpu();
		const pct = hostCpuPct(prevHost, nextHost);
		if (pct !== null) hostSamples.push(pct);
		prevHost = nextHost;
		sinkTicksLast = readPidCpuTicks(sink.pid) ?? sinkTicksLast;
		sourceTicksLast = readPidCpuTicks(source.pid) ?? sourceTicksLast;
	}
	const wallSec = (Date.now() - startedAtMs) / 1000;

	// The source stops itself at the end of its own window; kill it if it is
	// still up so the shape cannot outlive its measurement.
	if (!source.killed) source.kill();
	await source.exited;

	const sourceStdout = await sourceOut;
	const sinkStdout = await sinkOut;
	const sourceStderr = await sourceErr;
	const sinkStderr = await sinkErr;
	if (sourceStderr.trim()) notes.push(`source stderr: ${sourceStderr.trim().split("\n").slice(-3).join(" | ")}`);
	if (sinkStderr.trim()) notes.push(`sink stderr: ${sinkStderr.trim().split("\n").slice(-3).join(" | ")}`);

	const sourceSummary = parseTagged<Record<string, unknown>>(
		sourceStdout,
		"g7-precheck-source-summary",
	);
	const sinkSummary = parseTagged<Record<string, unknown>>(
		sinkStdout,
		"g7-sink-summary",
	);
	if (!sourceSummary) notes.push("source printed no summary");
	if (!sinkSummary) notes.push("sink printed no summary");

	// PF2's bracket test, stated as containment rather than as a difference.
	//
	// Both ends read CLOCK_MONOTONIC, which is one system-wide counter on Linux.
	// The proposition to test is therefore *not* "are two clocks close" — it is
	// "is this one counter", and the evidence for that is ordering: every
	// instant the source stamped must fall between the driver's own reading
	// before the source existed and its reading at the source's exit. Inside the
	// bracket the delta is 0 by construction and the agreement is proven; a
	// stamp outside it means the two ends are not reading the same counter, and
	// the distance outside is what gets reported. Measuring the raw difference
	// instead reports process teardown as clock disagreement, which is what the
	// first smoke run did at 52 ms against a 50 ms bar.
	const sourceClockEnd = parseTaggedNumber(
		sourceStdout,
		"g7-precheck-source-clock-end",
	);
	const ourClockAtExit = await sourceExitClockNs;
	let clockDeltaMs: number | null = null;
	if (sourceClockEnd !== null) {
		if (sourceClockEnd < ourClockBeforeSpawn) {
			clockDeltaMs = (sourceClockEnd - ourClockBeforeSpawn) / 1e6;
		} else if (sourceClockEnd > ourClockAtExit) {
			clockDeltaMs = (sourceClockEnd - ourClockAtExit) / 1e6;
		} else {
			clockDeltaMs = 0;
		}
		notes.push(
			`clock bracket ${(ourClockBeforeSpawn / 1e6).toFixed(3)} <= ${(sourceClockEnd / 1e6).toFixed(3)} <= ${(ourClockAtExit / 1e6).toFixed(3)} ms`,
		);
	}
	if (clock.source !== "ffi") {
		notes.push(`monotonic clock source was ${clock.source}, not ffi`);
	}

	// The sink's achieved rate is divided by the SOURCE's drive window, not by
	// the sink's own elapsed: the sink's elapsed includes its connect ramp and
	// its 3 s drain grace, and dividing by it would understate the sink for
	// reasons that are not the sink's.
	const driveSec = Number(sourceSummary?.driveSec ?? Number.NaN);
	const sinkCount = Number(sinkSummary?.[spec.sinkCounter] ?? Number.NaN);
	const sinkRatePerSec =
		Number.isFinite(driveSec) && driveSec > 0 && Number.isFinite(sinkCount)
			? sinkCount / driveSec
			: null;
	if (!Number.isFinite(driveSec)) notes.push("source reported no drive window");

	const sourceRatePerSec = Number.isFinite(
		Number(sourceSummary?.[spec.shape === "bytes" ? "bytesPerSec" : "eventsPerSec"]),
	)
		? Number(
				sourceSummary?.[spec.shape === "bytes" ? "bytesPerSec" : "eventsPerSec"],
			)
		: null;

	const sinkCpuOneCore = pidCpuPct(sinkTicks0, sinkTicksLast, wallSec);
	const sourceCpuOneCore = pidCpuPct(sourceTicks0, sourceTicksLast, wallSec);
	const sourceCpuOfHost =
		sourceCpuOneCore === null ? null : sourceCpuOneCore / HW_THREADS;

	// Attribution, and the reason it cannot be the source's own shortfall flag.
	//
	// These are reliable streams: every byte the source writes arrives, so the
	// sink's rate and the source's rate are the same number by construction and
	// a rate comparison can never say which of the two was the binding
	// constraint. Flow control means a slow sink makes the source look slow.
	//
	// So K16's "a pre-check whose own source could not source its offer is a
	// failure, not a pass" is decided on CPU, which is the one signal that does
	// separate them: the source is the binding constraint only when the pair
	// missed the bar AND the source was itself saturated. A miss with an idle
	// source is a sink finding, which is what the pre-check exists to produce.
	// A fleet that never connected is a source failure unconditionally.
	const shortfallKey = spec.shape === "bytes" ? "byteShortfall" : "eventShortfall";
	const sinkCleared =
		sinkRatePerSec !== null && sinkRatePerSec >= spec.targetRatePerSec;
	const sourceSaturated =
		sourceCpuOfHost !== null && sourceCpuOfHost >= SOURCE_SATURATION_PCT;
	const sourceShortfall =
		sourceSummary === null ||
		sourceSummary.sessionShortfall === true ||
		(!sinkCleared && sourceSaturated);
	if (sourceSummary?.[shortfallKey] === true) {
		notes.push(
			`source reported its own ${spec.shape} shortfall (raw disclosure; binding only with source saturation)`,
		);
	}
	if (sourceSummary?.sessionShortfall === true) {
		notes.push(
			`source drove ${sourceSummary.sessionsAtDriveStart} of ${sourceSummary.expectSessions} expected sessions`,
		);
	}
	if (!sinkCleared && !sourceSaturated) {
		notes.push(
			"pair missed the bar with the source unsaturated: attributed to the sink",
		);
	}

	return {
		shape: spec.shape,
		sinkRatePerSec,
		sourceRatePerSec,
		sourceShortfall,
		hostCpuPctMedian: median(hostSamples),
		sinkCpuPctOfOneCoreMedian: sinkCpuOneCore,
		sourceCpuPctOfOneCoreMedian: sourceCpuOneCore,
		sinkCpuPctOfHost: sinkCpuOneCore === null ? null : sinkCpuOneCore / HW_THREADS,
		sourceCpuPctOfHost: sourceCpuOfHost,
		sinkSummary,
		sourceSummary,
		loopback: true,
		clockDeltaMs,
		notes,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const req = AMENDED_REQUIREMENTS;
	const startedIso = new Date().toISOString();

	console.log(
		`g7-precheck: byte bar ${req.sinkBytesPerSec} B/s, event bar ${req.sinkEventsPerSec} events/s (amended from ${preflightRequirements().sinkEventsPerSec})`,
	);
	console.log(`g7-precheck: source ${SOURCE_BIN}`);
	console.log(`g7-precheck: sink   ${SINK_BIN}`);

	const bytesSpec: ShapeSpec = {
		shape: "bytes",
		port: BASE_PORT,
		targetRatePerSec: req.sinkBytesPerSec,
		sinkCounter: "bytesRead",
		sourceArgs: [
			"--mode",
			"bulk",
			"--port",
			String(BASE_PORT),
			"--duration",
			String(DURATION_SEC),
			"--write-bytes",
			String(BYTE_WRITE_BYTES),
			"--streams-per-session",
			String(BYTE_STREAMS_PER_SESSION),
			"--expect-sessions",
			String(BYTE_SESSIONS),
			"--target-bytes-per-sec",
			String(req.sinkBytesPerSec),
		],
		sinkArgs: [
			"--mode",
			"bulk",
			"--url",
			`https://127.0.0.1:${BASE_PORT}`,
			"--sessions",
			String(BYTE_SESSIONS),
			"--streams-per-session",
			String(BYTE_STREAMS_PER_SESSION),
			"--duration",
			String(DURATION_SEC),
			"--stagger-ms",
			"0",
		],
	};

	const eventsPort = BASE_PORT + 1;
	const eventsSpec: ShapeSpec = {
		shape: "events",
		port: eventsPort,
		targetRatePerSec: req.sinkEventsPerSec,
		sinkCounter: "records",
		sourceArgs: [
			"--mode",
			"tokens",
			"--port",
			String(eventsPort),
			"--duration",
			String(DURATION_SEC),
			"--write-bytes",
			String(TOKEN_WRITE_BYTES),
			"--expect-sessions",
			String(EVENT_SESSIONS),
			"--target-events-per-sec",
			String(req.sinkEventsPerSec),
		],
		sinkArgs: [
			"--mode",
			"tokens",
			"--url",
			`https://127.0.0.1:${eventsPort}`,
			"--sessions",
			String(EVENT_SESSIONS),
			"--record-bytes",
			String(TOKEN_WRITE_BYTES),
			"--duration",
			String(DURATION_SEC),
			"--stagger-ms",
			String(CONNECT_STAGGER_MS),
		],
	};

	const shapes: ShapeResult[] = [];
	for (const spec of [bytesSpec, eventsSpec]) {
		console.log(`g7-precheck: shape ${spec.shape} — target ${spec.targetRatePerSec}`);
		const result = await runShape(spec);
		console.log(
			`g7-precheck: shape ${spec.shape} sink=${result.sinkRatePerSec?.toFixed(1) ?? "null"} source=${result.sourceRatePerSec?.toFixed(1) ?? "null"} hostCpu=${result.hostCpuPctMedian?.toFixed(1) ?? "null"}% sinkCpu=${result.sinkCpuPctOfOneCoreMedian?.toFixed(1) ?? "null"}% of one core`,
		);
		shapes.push(result);
	}

	const finishedIso = new Date().toISOString();
	const sameDay = startedIso.slice(0, 10) === finishedIso.slice(0, 10);
	const report = buildPreflightReport(shapes, { sameDay });
	const verdict = evaluatePreflight(report, req);

	const artifact = {
		schemaVersion: 1,
		kind: "g7-precheck",
		startedIso,
		finishedIso,
		sameDay,
		host: {
			hardwareConcurrency: HW_THREADS,
			platform: process.platform,
		},
		requirements: req,
		originalRequirements: preflightRequirements(),
		amendment: {
			field: "sinkEventsPerSec",
			from: preflightRequirements().sinkEventsPerSec,
			to: req.sinkEventsPerSec,
			authority:
				".scratch/bare-metal-campaign/plan-run1.md v2-delta-2 / v3-C2 (maintainer ruling): 1.5 x the highest-rate cell, 1.5 x 125,500",
		},
		shapes,
		report,
		verdict,
	};
	writeFileSync(OUT, `${JSON.stringify(artifact, null, 2)}\n`);
	console.log(`g7-precheck: artifact ${OUT}`);
	console.log(`g7-precheck: verdict ${verdict.ok ? "OK" : "FAIL"}`);
	for (const reason of verdict.reasons) console.log(`g7-precheck:   - ${reason}`);

	// A failing pre-check is a refusal to dispatch, so it must be visible in the
	// exit status and not only in the artifact.
	process.exit(verdict.ok ? 0 : 1);
}

if (import.meta.main) {
	await main();
}
