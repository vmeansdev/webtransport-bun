/** Private, bounded measurement adapter. Never feed these banks to deltaRecord. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const NATIVE_PHASES = [
	"unarmed",
	"connect",
	"steady",
	"drain",
	"idle",
] as const;
export type NativePhase = (typeof NATIVE_PHASES)[number];
const INTERVALS = [
	"reflectQueueWait",
	"reflectSendCall",
	"ringFull",
	"flusherEagain",
	"udpQueueWait",
];
const GAUGES = [
	"reflectReservedSlots",
	"udpPendingPackets",
	"udpPendingBytes",
	"waiterRegistrations",
];
const BOUNDS = Array.from({ length: 31 }, (_, i) => 1_000 * 2 ** i);
const MAX_JSON_BYTES = 2 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
export type NativeHistogram = {
	count: number;
	buckets: number[];
	crossedPhase: number;
	outstanding: number;
	censored: number;
	rejected: number;
	overflow: number;
};
export type NativeComponent = {
	kind: "reflector" | "udp-socket";
	phase: NativePhase;
	createdNs: string;
	createdPhase: NativePhase;
	errors: number;
	cuts: { phase: NativePhase; beginNs: string; endNs: string }[];
	phases: {
		phase: NativePhase;
		intervals: { name: string; histogram: NativeHistogram }[];
	}[];
	gauges: {
		name: string;
		gauge: { current: number; phase: number; phaseHighWater: number[] };
	}[];
};
export type NativeSendPathSnapshot = {
	schema: "g6-native-send-path/1";
	enabled: boolean;
	finalized: boolean;
	phase: NativePhase;
	monoNs: string;
	phaseOrder: string[];
	bucketUpperBoundsNs: number[];
	errors: number;
	components: NativeComponent[];
};
function demand(condition: unknown, message: string): asserts condition {
	if (!condition) throw Error(`g6-native-send-path: ${message}`);
}
function object(value: unknown, keys: string[], label: string): ObjectValue {
	demand(
		value !== null && typeof value === "object" && !Array.isArray(value),
		`${label} is not an object`,
	);
	const entry = value as ObjectValue;
	demand(
		Object.keys(entry).length === keys.length &&
			keys.every((key) => Object.hasOwn(entry, key)),
		`${label} keys mismatch`,
	);
	return entry;
}
function integer(value: unknown, label: string): number {
	demand(
		Number.isSafeInteger(value) && (value as number) >= 0,
		`${label} is not a nonnegative safe integer`,
	);
	return value as number;
}
function time(value: unknown): bigint {
	demand(
		typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value),
		"invalid monotonic nanoseconds",
	);
	const result = BigInt(value);
	demand(
		result <= 18_446_744_073_709_551_615n,
		"monotonic nanoseconds overflow",
	);
	return result;
}
function array(value: unknown, length: number, label: string): unknown[] {
	demand(
		Array.isArray(value) && value.length === length,
		`${label} length mismatch`,
	);
	return value;
}
function phase(value: unknown): number {
	const index = NATIVE_PHASES.indexOf(value as NativePhase);
	demand(index >= 0, "unknown native phase");
	return index;
}
export function parseNativeSendPath(
	value: unknown,
	expected: { enabled: boolean; phase?: NativePhase; finalized?: boolean },
): NativeSendPathSnapshot {
	const root = object(
		value,
		[
			"schema",
			"enabled",
			"finalized",
			"phase",
			"monoNs",
			"phaseOrder",
			"bucketUpperBoundsNs",
			"errors",
			"components",
		],
		"snapshot",
	);
	demand(root.schema === "g6-native-send-path/1", "unknown schema");
	demand(
		root.enabled === expected.enabled && typeof root.finalized === "boolean",
		"measurement mode mismatch",
	);
	demand(root.errors === 0, "native diagnostic errors");
	const currentPhase = phase(root.phase),
		now = time(root.monoNs);
	demand(
		expected.phase === undefined || root.phase === expected.phase,
		"phase mismatch",
	);
	demand(
		expected.finalized === undefined || root.finalized === expected.finalized,
		"finality mismatch",
	);
	demand(!root.finalized || currentPhase === 4, "finalized before idle");
	demand(
		JSON.stringify(root.phaseOrder) === JSON.stringify(NATIVE_PHASES),
		"phase order mismatch",
	);
	demand(
		JSON.stringify(root.bucketUpperBoundsNs) === JSON.stringify(BOUNDS),
		"bucket bounds mismatch",
	);
	demand(
		Array.isArray(root.components) && root.components.length <= 64,
		"unbounded components",
	);
	demand(
		root.enabled ||
			(root.components.length === 0 && currentPhase === 0 && !root.finalized),
		"off snapshot carries armed state",
	);
	for (const raw of root.components) {
		const comp = object(
			raw,
			[
				"kind",
				"phase",
				"createdNs",
				"createdPhase",
				"errors",
				"cuts",
				"phases",
				"gauges",
			],
			"component",
		);
		demand(
			comp.kind === "reflector" || comp.kind === "udp-socket",
			"unknown component",
		);
		demand(
			comp.phase === root.phase && comp.errors === 0,
			"component phase/error mismatch",
		);
		const createdPhase = phase(comp.createdPhase);
		demand(createdPhase <= currentPhase, "component created in future phase");
		let lastCut = time(comp.createdNs);
		demand(lastCut <= now, "component created in future time");
		const cuts = array(comp.cuts, currentPhase - createdPhase, "cuts");
		for (const [index, rawCut] of cuts.entries()) {
			const cut = object(rawCut, ["phase", "beginNs", "endNs"], "cut");
			const begin = time(cut.beginNs),
				end = time(cut.endNs);
			demand(
				cut.phase === NATIVE_PHASES[createdPhase + index + 1],
				"missing or fabricated cut",
			);
			demand(
				begin >= lastCut && end >= begin && end <= now,
				"invalid cut bracket",
			);
			lastCut = end;
		}
		for (const [index, rawBank] of array(
			comp.phases,
			4,
			"phase banks",
		).entries()) {
			const bank = object(rawBank, ["phase", "intervals"], "phase bank");
			const phaseIndex = index + 1;
			demand(bank.phase === NATIVE_PHASES[phaseIndex], "bank phase mismatch");
			for (const [kind, rawInterval] of array(
				bank.intervals,
				5,
				"intervals",
			).entries()) {
				const interval = object(rawInterval, ["name", "histogram"], "interval");
				demand(interval.name === INTERVALS[kind], "interval name mismatch");
				const hist = object(
					interval.histogram,
					[
						"count",
						"buckets",
						"crossedPhase",
						"outstanding",
						"censored",
						"rejected",
						"overflow",
					],
					"histogram",
				);
				const count = integer(hist.count, "count");
				const buckets = array(hist.buckets, 32, "buckets").map((v) =>
					integer(v, "bucket"),
				);
				const sum = buckets.reduce(
					(total, n) => integer(total + n, "bucket sum"),
					0,
				);
				demand(
					count === sum && hist.overflow === buckets[31],
					"histogram totals mismatch",
				);
				const crossed = integer(hist.crossedPhase, "crossedPhase");
				// Live counters are provisional: bucket and crossed loads can straddle a
				// completion. Only sealed, quiescent banks are a consistent final readout.
				demand(
					!root.finalized || crossed <= count,
					"crossedPhase exceeds completions",
				);
				const outstanding = integer(hist.outstanding, "outstanding");
				const censored = integer(hist.censored, "censored"),
					rejected = integer(hist.rejected, "rejected");
				demand(
					!root.finalized || outstanding === 0,
					"finalized with outstanding intervals",
				);
				demand(
					(phaseIndex >= createdPhase && phaseIndex <= currentPhase) ||
						(count === 0 &&
							outstanding === 0 &&
							censored === 0 &&
							rejected === 0),
					"observations outside component lifetime",
				);
			}
		}
		for (const [index, rawGauge] of array(comp.gauges, 4, "gauges").entries()) {
			const entry = object(rawGauge, ["name", "gauge"], "named gauge");
			demand(entry.name === GAUGES[index], "gauge name mismatch");
			const gauge = object(
				entry.gauge,
				["current", "phase", "phaseHighWater"],
				"gauge",
			);
			const current = integer(gauge.current, "gauge current");
			demand(gauge.phase === currentPhase, "gauge phase mismatch");
			const maxima = array(gauge.phaseHighWater, 5, "gauge maxima").map((v) =>
				integer(v, "maximum"),
			);
			demand(
				current <= (maxima[currentPhase] ?? -1) &&
					maxima.every((n) => n < 2 ** 30),
				"gauge maximum mismatch",
			);
			demand(
				maxima.every(
					(n, i) => (i >= createdPhase && i <= currentPhase) || n === 0,
				),
				"gauge outside component lifetime",
			);
			demand(
				!root.finalized || current === 0,
				"finalized with outstanding ownership",
			);
		}
	}
	return value as NativeSendPathSnapshot;
}

export async function readNativeSendPath(
	read: ((phase?: string) => string) | undefined,
	requested: Exclude<NativePhase, "unarmed"> | "closed" | undefined,
	enabled: boolean,
	options: {
		timeoutMs?: number;
		nowMs?: () => number;
		sleepMs?: (ms: number) => Promise<void>;
	} = {},
): Promise<NativeSendPathSnapshot> {
	demand(
		typeof read === "function",
		"missing native diagnostic seam (not explicit off)",
	);
	const now = options.nowMs ?? Date.now;
	const sleep =
		options.sleepMs ??
		((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	const timeout = options.timeoutMs ?? (requested === "closed" ? 5_000 : 1_000);
	demand(
		Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 5_000,
		"invalid boundary deadline",
	);
	const deadline = now() + timeout;
	for (;;) {
		try {
			const raw = read(requested);
			demand(
				typeof raw === "string",
				"native seam returned a non-string value",
			);
			demand(
				Buffer.byteLength(raw) <= MAX_JSON_BYTES,
				"snapshot exceeds byte cap",
			);
			return parseNativeSendPath(JSON.parse(raw), {
				enabled,
				phase: enabled
					? requested === "closed"
						? "idle"
						: requested
					: "unarmed",
				finalized: enabled && requested === "closed",
			});
		} catch (error) {
			const message = String(error);
			if (
				!message.includes("native diagnostic cut busy") &&
				!message.includes("native send diagnostics require quiescent ownership")
			)
				throw error;
			demand(now() < deadline, `boundary deadline exceeded: ${message}`);
			await sleep(Math.min(1, deadline - now()));
		}
	}
}

/** Bind the measurement producer sources; native build provenance is a separate gate. */
export function nativeSendPathProducerSha256(): string {
	const files = [
		"../../crates/native/src/send_path_diagnostics.rs",
		"../../crates/native/src/datagram_reflector.rs",
		"../../crates/native/src/udp_send_batch.rs",
		"../../crates/native/src/lib.rs",
		"../../crates/native/src/server_napi.rs",
		"g6-native-send-path.ts",
		"g6-shard-server.ts",
	];
	const hash = createHash("sha256");
	for (const name of files)
		hash
			.update(name)
			.update("\0")
			.update(
				createHash("sha256")
					.update(readFileSync(new URL(name, import.meta.url)))
					.digest("hex"),
			)
			.update("\n");
	return hash.digest("hex");
}
