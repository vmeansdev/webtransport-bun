/** Shared online/final phase validity. Pure dependencies; no work-execution or evaluator import. */
import {
	requireDefined,
	validateOperationReceipt,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import type { WorkProfile } from "./g6-c32-work-profile.ts";
import type { ArmsRawShape } from "./g6-capacity-raw-work.ts";
import {
	NATIVE_PHASES,
	type NativeSendPathSnapshot,
	parseNativeSendPath,
} from "./g6-native-send-path.ts";
import {
	type ParsedLinuxProbeJsonl,
	parseLinuxProbeJsonl,
} from "./g6-sharded-diagnostic.ts";
import { G6_SHARDED_VALIDITY } from "./g6-sharded-grade.ts";

type RecordValue = Record<string, unknown>;
function fail(message: string): never {
	throw Error(`g6-capacity-diagnostic-coverage: ${message}`);
}
function object(value: unknown, label: string): RecordValue {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail(`${label} must be structured evidence`);
	return value as RecordValue;
}
function required<T>(value: T | null | undefined, label: string): T {
	if (value === undefined || value === null) fail(`${label} is missing`);
	return value;
}
function records(value: unknown, label: string): RecordValue[] {
	if (!Array.isArray(value)) fail(`${label} must be an array`);
	return value.map((row) => object(row, label));
}
function exact(
	value: unknown,
	keys: readonly string[],
	label: string,
): RecordValue {
	const row = object(value, label);
	if (
		Object.keys(row).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(row, key))
	)
		fail(`${label} has missing or unknown fields`);
	return row;
}
function finite(value: unknown, label: string, positive = false): number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < 0 ||
		(positive && value === 0)
	)
		fail(
			`${label} is not ${positive ? "positive" : "nonnegative"} finite evidence`,
		);
	return value;
}
function count(value: unknown, label: string, positive = false): number {
	const result = finite(value, label, positive);
	if (!Number.isSafeInteger(result)) fail(`${label} must be a safe integer`);
	return result;
}
function ms(value: unknown): number {
	return Date.parse(validateRfc3339Millis(value, "adapter timestamp"));
}
/**
 * The phase spans a cell kind registers. The steady path (and every sealed
 * pre-arms freeze) is 120 s steady with no drain-span requirement. A
 * sharded-arms cell brings its own steady window (hotspot 120 s, storm 60 s);
 * a storm cell also runs sever, the reconnect delay, the storm window and the
 * post-storm inside the native/probe `drain` phase, so its drain->idle span
 * must cover that (g6-sharded-arms/1 §3.3): at least the registered span
 * minus the same tolerance, with no upper bound.
 */
export function coverageSpans(arms: ArmsRawShape | null): {
	steadyMs: number;
	drainToIdleMs: number | null;
} {
	return {
		steadyMs: (arms?.steadySeconds ?? G6_SHARDED_VALIDITY.steadySeconds) * 1000,
		drainToIdleMs: arms?.arm === "storm" ? arms.drainToIdleMs : null,
	};
}
function within(spanMs: number, expectedMs: number): boolean {
	return (
		Math.abs(spanMs - expectedMs) <= G6_SHARDED_VALIDITY.steadyWallMsTolerance
	);
}
/** Coverage of the storm drain needs only a lower bound: an overrun past the
 * registered span (sever barrier, sleeps, marker latency) still covers it. */
function covers(spanMs: number, expectedMs: number): boolean {
	return spanMs >= expectedMs - G6_SHARDED_VALIDITY.steadyWallMsTolerance;
}
export function validateNative(
	diagnostic: RecordValue,
	p: WorkProfile,
	expectedProducer: string,
	arms: ArmsRawShape | null = null,
): NativeSendPathSnapshot[] {
	const spans = coverageSpans(arms);
	const native = exact(
		diagnostic.sendPathDiagnostics,
		["enabled", "measurementMode", "producerSha256", "shards"],
		"native binding",
	);
	if (
		native.enabled !== true ||
		native.measurementMode !== "on" ||
		native.producerSha256 !== expectedProducer ||
		!Array.isArray(native.shards) ||
		native.shards.length !== p.shards
	)
		fail("native source/coverage binding differs");
	const ids = new Set<number>(),
		pids = new Set<number>();
	const lifecycle = records(diagnostic.perShardLifecycle, "native lifecycle");
	return native.shards.map((raw: unknown) => {
		const row = exact(
			raw,
			["serverId", "pid", "boundaries", "final"],
			"native shard",
		);
		const id = count(row.serverId, "native shard ID", true),
			pid = count(row.pid, "native PID", true);
		if (
			id > p.shards ||
			ids.has(id) ||
			pids.has(pid) ||
			lifecycle.filter((life) => life.serverId === id && life.pid === pid)
				.length !== 1
		)
			fail("duplicate or mismatched native/lifecycle PID membership");
		ids.add(id);
		pids.add(pid);
		const boundaries = exact(
			row.boundaries,
			[...NATIVE_PHASES, "stop"],
			"native phase boundaries",
		);
		let last = -1n;
		const phaseTimes = new Map<string, bigint>();
		for (const phase of NATIVE_PHASES) {
			const snapshot = parseNativeSendPath(boundaries[phase], {
				enabled: true,
				phase,
				finalized: false,
			});
			const now = BigInt(snapshot.monoNs);
			if (now <= last) fail("native phase clock is reversed or repeated");
			last = now;
			phaseTimes.set(phase, now);
		}
		const durationMs =
			Number(
				required(phaseTimes.get("drain"), "native drain time") -
					required(phaseTimes.get("steady"), "native steady time"),
			) / 1e6;
		if (!within(durationMs, spans.steadyMs))
			fail("native steady phase does not span the rated window");
		if (
			spans.drainToIdleMs !== null &&
			!covers(
				Number(
					required(phaseTimes.get("idle"), "native idle time") -
						required(phaseTimes.get("drain"), "native drain time"),
				) / 1e6,
				spans.drainToIdleMs,
			)
		)
			fail("native drain phase does not span the registered storm");
		// Stop observes shutdown while still idle; it is not another phase bank.
		const stop = parseNativeSendPath(boundaries.stop, {
			enabled: true,
			phase: "idle",
			finalized: false,
		});
		const stopTime = BigInt(stop.monoNs);
		if (stopTime < last) fail("native stop precedes idle");
		const snapshot = parseNativeSendPath(row.final, {
			enabled: true,
			phase: "idle",
			finalized: true,
		});
		if (
			BigInt(snapshot.monoNs) < stopTime ||
			!snapshot.components.some((comp) => comp.kind === "reflector") ||
			(p.udpSendBatch === 64) !==
				snapshot.components.some((comp) => comp.kind === "udp-socket")
		)
			fail("native final component coverage differs from frozen sending path");
		return snapshot;
	});
}
/** Full phase parsing, not summary verdicts; clocks are compared only within their own domain. */
export function validateCapacityDiagnosticCoverage(input: {
	diagnostic: unknown;
	profile: WorkProfile;
	nativeProducerSha256: string;
	probeProducerSha256: string;
	probeText: string | null;
	operation: unknown;
	/** The sharded-arms kind's registered shape; null on the steady path. */
	arms?: ArmsRawShape | null;
}): { native: NativeSendPathSnapshot[]; probe: ParsedLinuxProbeJsonl | null } {
	const diagnostic = object(input.diagnostic, "diagnostic"),
		operation = validateOperationReceipt(input.operation);
	if (
		operation.status.outcome !== "SUCCEEDED" ||
		operation.status.exitCode !== 0 ||
		operation.status.signal !== null ||
		BigInt(operation.durationMonotonicNs) < 120_000_000_000n
	)
		fail("diagnostic scan lacks its complete successful operation");
	const arms = input.arms ?? null,
		spans = coverageSpans(arms);
	const snapshots = validateNative(
		diagnostic,
		input.profile,
		input.nativeProducerSha256,
		arms,
	);
	const observed = { reflectQueueWait: 0, reflectSendCall: 0 };
	for (const snapshot of snapshots)
		for (const component of snapshot.components)
			for (const phase of component.phases)
				for (const interval of phase.intervals) {
					const hist = interval.histogram;
					if (
						hist.censored !== 0 ||
						hist.outstanding !== 0 ||
						hist.rejected !== 0 ||
						hist.overflow !== 0
					)
						fail(
							"native phase coverage is censored, rejected, outstanding, or overflowed",
						);
					if (
						phase.phase === "steady" &&
						(interval.name === "reflectQueueWait" ||
							interval.name === "reflectSendCall")
					)
						observed[interval.name] += hist.count;
				}
	if (Object.values(observed).some((count) => count === 0))
		fail("native steady queue/send observations are absent");
	const probe = object(diagnostic.linuxProbe, "diagnostic Linux probe");
	if (!input.profile.detailedProbe) {
		if (
			input.probeText !== null ||
			probe.enabled !== false ||
			object(probe.measurementMode, "Linux probe mode").detail !== "off"
		)
			fail("probe-off profile lacks explicit off evidence");
		return { native: snapshots, probe: null };
	}
	if (!input.probeText) fail("missing detailed Linux probe");
	const parsed = parseLinuxProbeJsonl(input.probeText),
		header = object(
			JSON.parse(requireDefined(input.probeText.split("\n", 1)[0])),
			"Linux probe header",
		);
	if (
		parsed.producerSha256 !== input.probeProducerSha256 ||
		probe.producerSha256 !== input.probeProducerSha256 ||
		probe.enabled !== true
	)
		fail("Linux probe source/enablement differs from frozen authority");
	if (
		ms(header.startedAt) < ms(operation.startedAt) ||
		ms(parsed.summary.endedAt) > ms(operation.finishedAt)
	)
		fail("Linux probe escaped this scan operation");
	const steady = BigInt(parsed.phaseBoundaries.steady.monotonicNs),
		drain = BigInt(parsed.phaseBoundaries.drain.monotonicNs),
		idle = BigInt(parsed.phaseBoundaries.idle.monotonicNs);
	if (!within(Number(drain - steady) / 1e6, spans.steadyMs))
		fail("Linux steady phase does not cover the rated workload");
	if (
		spans.drainToIdleMs !== null &&
		!covers(Number(idle - drain) / 1e6, spans.drainToIdleMs)
	)
		fail("Linux drain phase does not cover the registered storm");
	for (const kind of ["queue", "sched"] as const) {
		const cadenceMs = finite(
			parsed.summary[`${kind}CadenceMs`],
			"probe cadence",
		);
		if (!Number.isSafeInteger(cadenceMs) || cadenceMs === 0)
			fail("invalid probe cadence");
		const cadence = BigInt(cadenceMs) * 1_000_000n,
			extent = parsed.phaseSampleExtents.steady[kind];
		if (
			BigInt(extent.firstNs) - steady > cadence ||
			drain - BigInt(extent.lastNs) > cadence
		)
			fail("Linux probe samples do not span the steady phase");
		if (spans.drainToIdleMs !== null) {
			const stormExtent = parsed.phaseSampleExtents.drain[kind];
			if (
				BigInt(stormExtent.firstNs) - drain > cadence ||
				idle - BigInt(stormExtent.lastNs) > cadence
			)
				fail("Linux probe samples do not span the storm drain phase");
		}
	}
	return { native: snapshots, probe: parsed };
}

export type CapacityDiagnosticCoverageInput = Parameters<
	typeof validateCapacityDiagnosticCoverage
>[0];
