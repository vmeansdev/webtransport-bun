/**
 * Burst profiles for the egress axis, as pure data.
 *
 * Every bench in this repo before this one offered a uniform, roughly Poisson
 * arrival shape. Real media does not look like that: a 1080p30 stream is eleven
 * MTU datagrams inside a 33 ms window and then silence, and once every two
 * seconds it is fifty-five. Whether the send path absorbs that is a different
 * question from whether it can sustain the mean, and it is the question this
 * axis exists to answer.
 *
 * A plan is deliberately free of clocks and I/O so the shape can be unit-tested
 * against its own arithmetic — the scheduled datagram count is what
 * `offered-shortfall` is evaluated against, so it has to be right independently
 * of whether the run behaved.
 *
 * Profiles and their amplitudes are fixed by
 * `docs/research/preregistrations/egress.md`.
 */

export type EgressProfile =
	| "constant"
	| "frame-bursty"
	| "keyframe-aligned"
	| "desktop-share";

export const EGRESS_PROFILES: readonly EgressProfile[] = [
	"constant",
	"frame-bursty",
	"keyframe-aligned",
	"desktop-share",
];

export function isEgressProfile(value: string): value is EgressProfile {
	return (EGRESS_PROFILES as readonly string[]).includes(value);
}

const FRAME_HZ = 30;
const FRAME_PERIOD_NS = Math.round(1e9 / FRAME_HZ); // 33,333,333 ns
const CONSTANT_HZ = 200;
const CONSTANT_PERIOD_NS = 1e9 / CONSTANT_HZ; // 5,000,000 ns
/** Frames between keyframes: 2 s at 30 fps. */
const KEYFRAME_INTERVAL = 60;
const KEYFRAME_MULTIPLIER = 5;
/** Desktop share: 2.5 s quiet, 0.5 s active, repeating. */
const DESKTOP_IDLE_FRAMES = 75;
const DESKTOP_ACTIVE_FRAMES = 15;
const DESKTOP_CYCLE_FRAMES = DESKTOP_IDLE_FRAMES + DESKTOP_ACTIVE_FRAMES;

export type EgressPlan = {
	profile: EgressProfile;
	/** Wake period of the send grid. Always ≥ 5 ms, so no plan can become a
	 *  measurement of `setTimeout` resolution. */
	gridPeriodNs: number;
	/** Amplitudes repeat with this period, in grid events. */
	cycleEvents: number;
	/** Datagrams to send at event `i % cycleEvents`, before per-session phase. */
	amplitudes: number[];
	/** Datagrams one session sends per cycle. */
	perCycle: number;
	/** Mean datagrams/s this plan actually produces per session. */
	effectiveRatePerSession: number;
	/** Sessions are staggered inside the grid period unless the profile is the
	 *  aligned worst case, where they deliberately are not. */
	staggered: boolean;
};

/** Even integer split of `total` across `slots`, summing to exactly `total`. */
function spread(total: number, slots: number): number[] {
	const out = new Array<number>(slots);
	for (let i = 0; i < slots; i += 1) {
		out[i] =
			Math.floor(((i + 1) * total) / slots) - Math.floor((i * total) / slots);
	}
	return out;
}

/**
 * Build the plan for one profile at one per-session rate.
 *
 * The frame profiles quantize the requested rate to a whole number of datagrams
 * per frame, and the keyframe multiplier raises the mean by 4/60. Both are
 * disclosed in the pre-registration; `effectiveRatePerSession` is what actually
 * gets offered and is what the driver reports.
 */
export function planFor(
	profile: EgressProfile,
	perSessionRate: number,
): EgressPlan {
	if (!Number.isFinite(perSessionRate) || perSessionRate <= 0) {
		throw new Error(`egress-schedule: bad per-session rate ${perSessionRate}`);
	}

	if (profile === "constant") {
		// One second of grid events carrying exactly `perSessionRate` datagrams,
		// so a rate that is not a multiple of the grid still comes out exact.
		const amplitudes = spread(Math.round(perSessionRate), CONSTANT_HZ);
		const perCycle = amplitudes.reduce((a, b) => a + b, 0);
		return {
			profile,
			gridPeriodNs: CONSTANT_PERIOD_NS,
			cycleEvents: CONSTANT_HZ,
			amplitudes,
			perCycle,
			effectiveRatePerSession: perCycle,
			staggered: true,
		};
	}

	const perFrame = Math.max(1, Math.round(perSessionRate / FRAME_HZ));

	if (profile === "desktop-share") {
		const idle = Math.max(0, Math.round(perFrame * 0.1));
		// Rate-neutral by construction: the active phase carries whatever the
		// quiet phase did not, so a bimodal shape and a constant shape offer the
		// same mean and the comparison is about burstiness alone.
		const activeTotal =
			DESKTOP_CYCLE_FRAMES * perFrame - DESKTOP_IDLE_FRAMES * idle;
		const active = spread(Math.max(0, activeTotal), DESKTOP_ACTIVE_FRAMES);
		const amplitudes = [
			...new Array<number>(DESKTOP_IDLE_FRAMES).fill(idle),
			...active,
		];
		const perCycle = amplitudes.reduce((a, b) => a + b, 0);
		return {
			profile,
			gridPeriodNs: FRAME_PERIOD_NS,
			cycleEvents: DESKTOP_CYCLE_FRAMES,
			amplitudes,
			perCycle,
			effectiveRatePerSession:
				(perCycle * 1e9) / (DESKTOP_CYCLE_FRAMES * FRAME_PERIOD_NS),
			staggered: true,
		};
	}

	// frame-bursty and keyframe-aligned share amplitudes and differ only in
	// whether the sessions land on the same grid. That is the whole experiment:
	// alignment, not shape.
	const amplitudes = new Array<number>(KEYFRAME_INTERVAL).fill(perFrame);
	amplitudes[0] = perFrame * KEYFRAME_MULTIPLIER;
	const perCycle = amplitudes.reduce((a, b) => a + b, 0);
	return {
		profile,
		gridPeriodNs: FRAME_PERIOD_NS,
		cycleEvents: KEYFRAME_INTERVAL,
		amplitudes,
		perCycle,
		effectiveRatePerSession:
			(perCycle * 1e9) / (KEYFRAME_INTERVAL * FRAME_PERIOD_NS),
		staggered: profile === "frame-bursty",
	};
}

/**
 * Sub-period offset for one session. Staggered profiles spread sessions evenly
 * across the grid period; the aligned profile puts every session on the same
 * deadline, which is the thundering herd it exists to produce.
 */
export function phaseNsFor(
	plan: EgressPlan,
	session: number,
	sessions: number,
): number {
	if (!plan.staggered || sessions <= 1) return 0;
	return (plan.gridPeriodNs * session) / sessions;
}

/**
 * Cycle offset for one session. Staggered profiles also spread the *keyframe*
 * (and the desktop-share active phase) across the cycle, so accidental
 * alignment is the aligned arm's variable and not a coincidence of this one.
 */
export function cycleOffsetFor(
	plan: EgressPlan,
	session: number,
	sessions: number,
): number {
	if (!plan.staggered || sessions <= 1) return 0;
	return Math.floor((session * plan.cycleEvents) / sessions);
}

/** Datagrams this session owes at this grid event. */
export function amplitudeAt(
	plan: EgressPlan,
	session: number,
	sessions: number,
	eventIndex: number,
): number {
	const offset = cycleOffsetFor(plan, session, sessions);
	const i = (eventIndex + offset) % plan.cycleEvents;
	return plan.amplitudes[i] ?? 0;
}

/**
 * Exactly how many datagrams the plan schedules for a whole step. This is the
 * denominator of the `offered-shortfall` STOP, so it is computed from the plan
 * rather than from `rate × seconds` — the frame profiles quantize, and a
 * denominator that ignored that would manufacture a shortfall.
 */
export function scheduledDatagrams(
	plan: EgressPlan,
	sessions: number,
	events: number,
): number {
	let total = 0;
	for (let s = 0; s < sessions; s += 1) {
		for (let e = 0; e < events; e += 1) {
			total += amplitudeAt(plan, s, sessions, e);
		}
	}
	return total;
}

/** Grid events in a step of `seconds`. */
export function eventsForSeconds(plan: EgressPlan, seconds: number): number {
	return Math.floor((seconds * 1e9) / plan.gridPeriodNs);
}

/**
 * Peak datagrams in a single grid window across all sessions — the number the
 * keyframe-aligned arm exists to produce (100 sessions × 55 ≈ 5,500 in one
 * 33 ms window). Reported per step so the adversarial claim is arithmetic in
 * the artifact rather than prose in a report.
 */
export function peakWindowDatagrams(
	plan: EgressPlan,
	sessions: number,
): number {
	let peak = 0;
	for (let e = 0; e < plan.cycleEvents; e += 1) {
		let window = 0;
		for (let s = 0; s < sessions; s += 1) {
			window += amplitudeAt(plan, s, sessions, e);
		}
		if (window > peak) peak = window;
	}
	return peak;
}
