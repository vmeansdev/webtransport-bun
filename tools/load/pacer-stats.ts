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
 * 3. **Honest about what does not subtract.** `pps`/`clump`/`queueMs`/
 *    `maxPendingTargets` are configuration, `pendingTargets` is a gauge, and
 *    `maxLatenessUsSinceProcessStart` is a since-process-start maximum — a
 *    difference of maxima is not a windowed maximum, so it is carried
 *    unsubtracted under its own name, never differenced.
 *
 * That third property was held by a list of literal field names, and the native
 * side outgrew the list: `maxLatenessUs` became
 * `maxLatenessUsSinceProcessStart`, so the maximum vanished from
 * `sinceProcessStart` and reappeared inside `windowed` as `close - open` — a
 * difference of maxima in the one object a per-cell rule is allowed to read.
 * A rung whose worst lateness predated its window would have read as perfectly
 * paced. Names are now matched by rule, not by literal: anything ending
 * `SinceProcessStart` is carried, and nothing whose name says `max` is ever
 * differenced.
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

/**
 * Configuration echoed by the pacer; identical in both reads of a window.
 *
 * `maxPendingTargets` is the admission bound (`cfg.max_pending()`), not a
 * counter and not a gauge — it is here so it travels as the constant it is
 * rather than being differenced to a meaningless zero.
 */
const CONFIG_FIELDS = ["pps", "clump", "queueMs", "maxPendingTargets"] as const;

/** Gauges: read at an instant, meaningless as a difference. */
const GAUGE_FIELDS = ["pendingTargets"] as const;

/**
 * Since-process-start values, matched by suffix rather than by name.
 *
 * The native side has already renamed one of these once (`maxLatenessUs` →
 * `maxLatenessUsSinceProcessStart`) and a hardcoded list did not survive it.
 * The bare legacy name is still recognised so an older addon stays readable.
 */
function isSinceProcessStart(field: string): boolean {
	return field.endsWith("SinceProcessStart") || field === "maxLatenessUs";
}

/**
 * The backstop, and the one rule that does not depend on knowing the schema: a
 * field whose name says `max` is a maximum, and the difference of two maxima is
 * not the maximum over the window between them. Whatever the pacer adds next,
 * it does not land in `windowed` by being unrecognised.
 */
function namesAMaximum(field: string): boolean {
	return /max/i.test(field);
}

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
	 * Since-process-start values that are not differences, under the names the
	 * pacer emits them under: `maxLatenessUsSinceProcessStart` is a running
	 * maximum and `pendingTargets` a queue depth at the instant read.
	 */
	sinceProcessStart: Record<string, number>;
	/** The raw reads, so the subtraction above can be checked. */
	cumulative: { atWindowOpen: PacerStatsRaw; atWindowClose: PacerStatsRaw };
	/** Set when the two reads disagree about pps/clump/queueMs. */
	configChangedMidWindow?: Record<string, { open: number; close: number }>;
	/**
	 * Fields the pacer emitted that this file declined to difference because
	 * their names say `max`, and that it also did not recognise as
	 * since-process-start. Present so a schema addition shows up as a name in
	 * the artifact rather than as a plausible-looking number inside `windowed`.
	 */
	refusedDifferencing?: string[];
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
	const probed = probePacerApi(server);
	return probed.kind === "live" ? probed.stats : null;
}

/**
 * What the composition actually offers, as three distinguishable answers.
 *
 * `readPacerStats` collapses the first two into `null`, which is right for the
 * windowing path — there is nothing to window either way — and wrong for the
 * start-up check, where the difference is the whole finding. A stale addon has
 * no accessor; a current addon with the knob off answers `"{}"`. Only the
 * second is a deliberate unpaced control.
 */
export type PacerApiProbe =
	| { kind: "absent" }
	| { kind: "knob-off" }
	| { kind: "live"; stats: PacerStatsRaw };

export function probePacerApi(server: unknown): PacerApiProbe {
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
	if (raw === null) return { kind: "absent" };
	const parsed = coerceStats(raw);
	// `"{}"` is what the pacer returns with the knob off: a live API reporting
	// that nothing is paced, which is not the same as no API at all — but it
	// carries no counters, so there is nothing to window.
	if (parsed === null || Object.keys(parsed).length === 0) {
		return { kind: "knob-off" };
	}
	return { kind: "live", stats: parsed };
}

/**
 * The paced-cell readability guard (review-d3a H3).
 *
 * `WEBTRANSPORT_PACER_PPS` set with no readable pacer produces an artifact with
 * no `pacerStats` block at all — visually identical to a deliberate unpaced
 * control, and ungradable with nothing saying so. The two ways to get there are
 * a composition whose addon predates the accessors, and a knob that never
 * reached the server. Both are mis-shaped cells, and both are worth exactly the
 * seconds it takes to refuse here rather than the hour a sweep costs.
 *
 * Called after `createServer()` and before the fleet: this needs a server to
 * ask, which `assertOneProcessPerCell` does not.
 */
export function assertPacerReadable(
	server: unknown,
	pacerPps: string | undefined,
): void {
	const paced = (pacerPps ?? "").trim();
	if (paced === "") return;
	const probe = probePacerApi(server);
	if (probe.kind === "live") return;
	const why =
		probe.kind === "absent"
			? "the server exposes no pacer stats accessor at all, which means the " +
				"native addon in this composition predates `__pacerStatsJson` — it " +
				"was not rebuilt, or a prebuilt one was picked up"
			: "the pacer stats accessor answered the knob-off sentinel (`{}`), which " +
				"means the knob never reached the pacer in this process";
	throw new Error(
		`bench-g10: WEBTRANSPORT_PACER_PPS=${paced} is set, but ${why}. A paced ` +
			"cell with no readable pacer produces an artifact indistinguishable " +
			"from an unpaced control and cannot be graded (review-d3a H3). Rebuild " +
			"the addon from the pacer branch, or unset the knob to run a control.",
	);
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
	// is how the next schema addition goes unnoticed for a whole sweep. But an
	// unknown *maximum* differenced is worse than dropped — it reads as a
	// windowed maximum and is not one — so those are named instead.
	const refused: string[] = [];
	for (const [field, close] of Object.entries(atWindowClose)) {
		if (field in windowed) continue;
		if (isKnownNonCounter(field)) continue;
		if (namesAMaximum(field)) {
			refused.push(field);
			continue;
		}
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

	// Carried under whatever name the pacer emitted, not translated into one this
	// file prefers: a reader matching the artifact against `stats_json` has to
	// find the same key.
	const sinceProcessStart: Record<string, number> = {};
	for (const [field, close] of Object.entries(atWindowClose)) {
		if (!isSinceProcessStart(field)) continue;
		if (typeof close === "number") sinceProcessStart[field] = close;
	}
	for (const field of GAUGE_FIELDS) {
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
	if (refused.length > 0) {
		report.refusedDifferencing = refused;
		console.warn(
			`bench-g10: pacer stats carried ${refused.join(", ")} undifferenced — ` +
				"the name says maximum and a difference of maxima is not a windowed " +
				"maximum. Add it to this file's rules if that reading is wrong.",
		);
	}
	return report;
}

function isKnownNonCounter(field: string): boolean {
	return (
		(CONFIG_FIELDS as readonly string[]).includes(field) ||
		(GAUGE_FIELDS as readonly string[]).includes(field) ||
		isSinceProcessStart(field)
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
