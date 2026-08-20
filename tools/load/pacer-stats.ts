/**
 * Bench-side wiring for the egress pacer's own counters.
 *
 * The pacer lives on `feat/egress-pacer-01` and exposes its counters as an
 * untyped JSON string (`__pacerStatsJson`, diagnostic/unstable). Every paced
 * number the sweep produces is unattributable without them: a cell whose
 * schedule reset mid-window was not running at the rate its filename claims.
 *
 * Three properties this file exists to hold:
 *
 * 1. **Additive.** A composition without the pacer API emits no `pacerStats`
 *    at all, so an older harness reading an older artifact sees exactly what
 *    it saw before. Nothing here can move a measured number.
 * 2. **Windowed.** The counters are cumulative since process start, and a rung
 *    is one window inside that process. The delta between the mark taken as
 *    the drive window opens and the read taken as it closes is the only thing
 *    a per-cell rule may read; the raw cumulative pair travels beside it so a
 *    reader can check the subtraction.
 * 3. **Honest about what does not subtract.** `pps`/`clump`/`queueMs` are
 *    configuration, `pendingTargets` is a gauge, and `maxLatenessUs` is a
 *    since-process-start maximum — a difference of maxima is not a windowed
 *    maximum, so it is carried unsubtracted and labelled, never differenced.
 */

/** Counters that accumulate and therefore subtract across a window. */
const COUNTER_FIELDS = [
	"submits",
	"admittedTargets",
	"refusedTargets",
	"clumps",
	"lateClumps",
	"scheduleResets",
	"deferredFailures",
	"threadStarts",
	"threadStartFailures",
] as const;

/** Configuration echoed by the pacer; identical in both reads of a window. */
const CONFIG_FIELDS = ["pps", "clump", "queueMs"] as const;

export type PacerStatsRaw = Record<string, number>;

export type PacerStatsReport = {
	/**
	 * Counter deltas across the drive window. The only fields a per-cell
	 * validity rule may read.
	 */
	windowed: Record<string, number>;
	/** Configuration as the pacer reports it, when both reads agree. */
	config: Record<string, number>;
	/**
	 * Since-process-start values that are not differences: `maxLatenessUs` is a
	 * running maximum and `pendingTargets` a queue depth at the instant read.
	 */
	sinceProcessStart: Record<string, number>;
	/** The raw reads, so the subtraction above can be checked. */
	cumulative: { atWindowOpen: PacerStatsRaw; atWindowClose: PacerStatsRaw };
	/** Set when the two reads disagree about pps/clump/queueMs. */
	configChangedMidWindow?: Record<string, { open: number; close: number }>;
};

/**
 * Read the pacer's counters off a server object, tolerating an API that has
 * not landed (or has drifted).
 *
 * The napi surface is being renamed to `__pacerStatsJson` on the pacer branch
 * while this rides the G10 branch, so all three plausible names are probed and
 * a missing one is not an error — it is a composition without a pacer.
 */
export function readPacerStats(server: unknown): PacerStatsRaw | null {
	const names = ["__pacerStatsJson", "pacerStatsJson", "__pacerStatsSnapshot"];
	// The facade `createServer()` returns is a plain object literal that closes
	// over the native handle, so the accessor has to be forwarded onto it by the
	// pacer branch. If instead the handle itself is what gets exposed, these are
	// the property names it would arrive under.
	const raw =
		callFirstAvailable(server, names) ??
		callFirstAvailable(nested(server, "__nativeHandle"), names) ??
		callFirstAvailable(nested(server, "__handle"), names) ??
		callFirstAvailable(nested(server, "handle"), names);
	if (raw === null) return null;
	const parsed = coerceStats(raw);
	// `"{}"` is what the pacer returns with the knob off: a live API reporting
	// that nothing is paced, which is not the same as no API at all — but it
	// carries no counters, so there is nothing to window.
	if (parsed === null || Object.keys(parsed).length === 0) return null;
	return parsed;
}

function nested(server: unknown, key: string): unknown {
	if (server === null || typeof server !== "object") return null;
	return (server as Record<string, unknown>)[key] ?? null;
}

function callFirstAvailable(server: unknown, names: string[]): unknown {
	if (server === null || typeof server !== "object") return null;
	const bag = server as Record<string, unknown>;
	for (const name of names) {
		const fn = bag[name];
		if (typeof fn !== "function") continue;
		try {
			return (fn as () => unknown).call(server);
		} catch {
			// A diagnostic accessor must never be able to fail a rung.
			return null;
		}
	}
	return null;
}

function coerceStats(raw: unknown): PacerStatsRaw | null {
	let value = raw;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return null;
		}
	}
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	const out: PacerStatsRaw = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
	}
	// The native JSON nests the actual counters under `cumulative` (and a
	// token-relative `window`): flatten `cumulative`'s numerics to the top
	// level, preferring them on collision — the first sweep cell shipped an
	// empty `windowed` because this function saw only the config scalars.
	const nested = (value as Record<string, unknown>).cumulative;
	if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
		for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
			if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
		}
	}
	return out;
}

/**
 * Window a pair of reads. Returns null unless both reads exist, so a pacer
 * that appeared mid-rung produces no half-attributed report.
 */
export function windowPacerStats(
	atWindowOpen: PacerStatsRaw | null,
	atWindowClose: PacerStatsRaw | null,
): PacerStatsReport | null {
	if (!atWindowOpen || !atWindowClose) return null;
	const windowed: Record<string, number> = {};
	for (const field of COUNTER_FIELDS) {
		const open = atWindowOpen[field];
		const close = atWindowClose[field];
		if (typeof open !== "number" || typeof close !== "number") continue;
		windowed[field] = close - open;
	}
	// Fields the pacer grew that this file predates still travel: an unknown
	// counter is more useful differenced than dropped, and dropping it silently
	// is how the next schema addition goes unnoticed for a whole sweep.
	for (const [field, close] of Object.entries(atWindowClose)) {
		if (field in windowed) continue;
		if (isKnownNonCounter(field)) continue;
		const open = atWindowOpen[field];
		if (typeof open === "number") windowed[field] = close - open;
	}

	const config: Record<string, number> = {};
	const drift: Record<string, { open: number; close: number }> = {};
	for (const field of CONFIG_FIELDS) {
		const open = atWindowOpen[field];
		const close = atWindowClose[field];
		if (typeof close !== "number") continue;
		config[field] = close;
		if (typeof open === "number" && open !== close) {
			drift[field] = { open, close };
		}
	}

	const sinceProcessStart: Record<string, number> = {};
	for (const field of ["maxLatenessUs", "pendingTargets"] as const) {
		const close = atWindowClose[field];
		if (typeof close === "number") sinceProcessStart[field] = close;
	}

	const report: PacerStatsReport = {
		windowed,
		config,
		sinceProcessStart,
		cumulative: { atWindowOpen, atWindowClose },
	};
	if (Object.keys(drift).length > 0) report.configChangedMidWindow = drift;
	return report;
}

function isKnownNonCounter(field: string): boolean {
	return (
		(CONFIG_FIELDS as readonly string[]).includes(field) ||
		field === "maxLatenessUs" ||
		field === "pendingTargets"
	);
}

/**
 * The one-process-per-cell guard.
 *
 * A paced sweep cell is one rate, one arm, one process: the pacer's counters
 * are process-global, so a second rung inside the same process would window a
 * schedule the first rung already disturbed, and a second arm would blend two
 * shapes under one set of them. Both are cheap to do by accident from the
 * environment and impossible to detect afterwards in the artifact — so the
 * harness refuses at start-up rather than producing a cell nobody can grade.
 */
export function assertOneProcessPerCell(opts: {
	pacerPps: string | undefined;
	ladder: readonly number[];
	arms: readonly string[];
}): void {
	const paced = (opts.pacerPps ?? "").trim();
	if (paced === "") return;
	if (opts.ladder.length !== 1) {
		throw new Error(
			`bench-g10: WEBTRANSPORT_PACER_PPS=${paced} is set, so this process is ` +
				`one sweep cell — but G10_RATE_LADDER parsed ${opts.ladder.length} ` +
				`rates (${opts.ladder.join(",")}). A paced cell is one rate in one ` +
				"process: the pacer's counters are process-global and cannot be " +
				"attributed across rungs. Run one rate per process.",
		);
	}
	if (opts.arms.length !== 1) {
		throw new Error(
			`bench-g10: WEBTRANSPORT_PACER_PPS=${paced} is set, so this process is ` +
				`one sweep cell — but G10_ARMS requested ${opts.arms.length} arms ` +
				`(${opts.arms.join(",")}). A paced cell is one arm: two arms share ` +
				"one set of process-global pacer counters and neither can be graded. " +
				"Run one arm per process.",
		);
	}
}

/**
 * The knobs and composition SHAs an artifact needs to stand on its own.
 *
 * Filenames are labels, not evidence: `sweep2-c32-p75000-w60-r1.json` says
 * what the operator meant to run, and this says what the process actually
 * read. `G10_COMPOSITION_SHAS` is free-form on purpose — the composition is
 * three branches on two machines and no fixed schema survives that.
 */
export function pacerEnvironment(
	env: Record<string, string | undefined>,
): Record<string, string | null> {
	const read = (key: string): string | null => env[key] ?? null;
	return {
		WEBTRANSPORT_PACER_PPS: read("WEBTRANSPORT_PACER_PPS"),
		WEBTRANSPORT_PACER_CLUMP: read("WEBTRANSPORT_PACER_CLUMP"),
		WEBTRANSPORT_PACER_QUEUE_MS: read("WEBTRANSPORT_PACER_QUEUE_MS"),
		G10_COMPOSITION_SHAS: read("G10_COMPOSITION_SHAS"),
	};
}
