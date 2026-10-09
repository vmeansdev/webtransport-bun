import { validateRfc3339Millis } from "./g6-c32-freeze-model.ts";
import {
	evaluateWorkPlanTimeAdmission,
	validateWorkPlan,
	type WorkPlan,
} from "./g6-c32-work-plan.ts";

type ClockEntry = Readonly<{ event: string; recordedAt: string }>;
type ClockInput = Readonly<{
	plan: WorkPlan;
	entries: readonly ClockEntry[];
	deadline: string;
	now: string;
	setupComplete: boolean;
}>;

function millis(value: string, label: string): number {
	return Date.parse(validateRfc3339Millis(value, label));
}

/** Re-evaluated from durable intent evidence, never reset on retry or resume. */
export function executionCutoff(input: ClockInput) {
	const plan = validateWorkPlan(input.plan);
	const now = millis(input.now, "execution clock now");
	const deadline = millis(input.deadline, "execution clock deadline");
	if (typeof input.setupComplete !== "boolean")
		throw Error("setupComplete must be explicit");
	let paidStart: number | null = null;
	let previous = 0;
	for (const entry of input.entries) {
		const timestamp = millis(entry.recordedAt, "paid clock entry recordedAt");
		if (timestamp < previous || timestamp > now)
			throw Error("paid clock evidence is reversed or future dated");
		previous = timestamp;
		if (entry.event === "CREATE_INTENT") paidStart ??= timestamp;
		if (entry.event === "CREATE_OBSERVED" && paidStart === null)
			throw Error("paid creation lacks CREATE_INTENT");
	}
	if (input.setupComplete && paidStart === null)
		throw Error("setup cannot complete without paid intent");
	let cutoff = deadline - plan.teardownReserveSeconds * 1000;
	let phase: "deadline" | "setup" | "active" = "deadline";
	if (paidStart !== null) {
		const paidCutoff =
			paidStart +
			(input.setupComplete
				? plan.activeMaximumSeconds
				: plan.setupMaximumSeconds) *
				1000;
		if (paidCutoff < cutoff) {
			cutoff = paidCutoff;
			phase = input.setupComplete ? "active" : "setup";
		}
	}
	return {
		paidStartAt: paidStart === null ? null : new Date(paidStart).toISOString(),
		elapsedPaidSeconds: paidStart === null ? 0 : (now - paidStart) / 1000,
		cutoffAt: new Date(cutoff).toISOString(),
		phase,
		expired: now >= cutoff,
	};
}

/** Host approval cannot consume the final 420 seconds reserved for qualification. */
export function hostReviewCutoff(input: ClockInput) {
	const execution = executionCutoff({ ...input, setupComplete: false });
	if (execution.paidStartAt === null)
		throw Error("host review requires the original paid setup clock");
	const plan = validateWorkPlan(input.plan);
	if (plan.setupMaximumSeconds < 420)
		throw Error("host review setup lacks the 420-second qualification reserve");
	const cutoff = Date.parse(execution.cutoffAt) - 420 * 1000;
	return {
		...execution,
		cutoffAt: new Date(cutoff).toISOString(),
		expired: millis(input.now, "host review now") >= cutoff,
	};
}

/** One absolute reserve shared by every cleanup phase; a resume cannot reset it. */
export function teardownCutoff(
	input: ClockInput & { teardownStartedAt: string },
) {
	const active = executionCutoff(input);
	const plan = validateWorkPlan(input.plan);
	const now = millis(input.now, "teardown clock now");
	const started = millis(input.teardownStartedAt, "teardown start");
	if (started > now) throw Error("teardown start is future dated");
	const reserve = plan.teardownReserveSeconds * 1000;
	const cutoff = Math.min(
		millis(input.deadline, "teardown deadline"),
		Date.parse(active.cutoffAt) + reserve,
		started + reserve,
	);
	// Evidence recovery is optional. Preserve the final half of the same
	// reserve for exact-ID deletion and provider absence verification.
	const collectionCutoff = cutoff - Math.ceil(reserve / 2);
	return {
		cutoffAt: new Date(cutoff).toISOString(),
		collectionCutoffAt: new Date(collectionCutoff).toISOString(),
		remainingMilliseconds: Math.max(0, cutoff - now),
		collectionExpired: now >= collectionCutoff,
		expired: now >= cutoff,
	};
}

/** Run immediately before the first provider mutation, after local gates/pricing. */
export function requirePreCreateWorkTime(input: {
	plan: WorkPlan;
	now: string;
	deadline: string;
}): void {
	const now = millis(input.now, "pre-create now"),
		deadline = millis(input.deadline, "pre-create deadline");
	const result = evaluateWorkPlanTimeAdmission({
		plan: input.plan,
		completed: [],
		setupComplete: false,
		elapsedPaidSeconds: 0,
		controlUsedSeconds: 0,
		remainingDeadlineSeconds: Math.max(0, Math.floor((deadline - now) / 1000)),
	});
	if (result.decision !== "FEASIBLE")
		throw Error(
			"insufficient deadline for whole remaining work plus teardown before create",
		);
}
