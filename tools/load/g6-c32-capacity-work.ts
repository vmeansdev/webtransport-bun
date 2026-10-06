import { requireDefined } from "./g6-c32-freeze-model.ts";
import {
	validateWorkPlan,
	type WorkNode,
	type WorkPlan,
	type WorkTarget,
} from "./g6-c32-work-plan.ts";
import {
	SHARDED_ARMS_CELLS,
	SHARDED_ARMS_REGISTERED,
} from "./g6-sharded-arms-grade.ts";

const COMPLETE: WorkTarget = { terminal: "COMPLETE" };
const INCOMPLETE: WorkTarget = { terminal: "INCOMPLETE" };

/** Source-bound constructors for the approved A/B experiment, not a second shell schedule. */
export function makeAttributionWorkPlan(): WorkPlan {
	const profiles = [
		"stock-probe-off",
		"stock-probe-on",
		"batch-no-hint",
		"batch-hint",
	];
	const cells = ["A0-1", "A1-1", "B-1", "C-1", "C-2", "B-2", "A1-2", "A0-2"];
	const order = [0, 1, 2, 3, 3, 2, 1, 0];
	return validateWorkPlan({
		schema: "g6-c32-work-plan/1",
		id: "g6-capacity-attribution-a",
		setupMaximumSeconds: 2100,
		controlMaximumSeconds: 60,
		teardownReserveSeconds: 600,
		activeMaximumSeconds: 5520,
		profiles,
		entry: cells[0],
		nodes: cells.map(
			(id, index): WorkNode => ({
				id,
				label: id,
				kind: "attribution",
				profile: requireDefined(profiles[requireDefined(order[index])]),
				requestedSessions: 40000,
				activeWorkloadSessions: 40000,
				maximumSeconds: 420,
				next: {
					PASS: cells[index + 1] ?? COMPLETE,
					MISS: cells[index + 1] ?? COMPLETE,
					INVALID: INCOMPLETE,
				},
			}),
		),
	});
}

/** Ladder B plan ids. The probe-off id exists only for the pre-registered r5
 * fallback when A' measured detailed-probe interference; the evaluator accepts
 * it only with that recorded disposition. */
export const R5_LADDER_PLAN_IDS = [
	"g6-capacity-ladder-b-r5",
	"g6-capacity-ladder-b-r5-probe-off",
] as const;
export type R5LadderPlanId = (typeof R5_LADDER_PLAN_IDS)[number];

/** r5 successor A': same envelope as the original A (8 x 420 s, 2100 s setup,
 * 60 s control, 600 s teardown). Selection-critical arms run first and are
 * mirrored; the send-path arm XB runs last so an XB INVALID only removes the
 * batch64 option. PASS and MISS (including S2/S4) continue; INVALID stops. */
export function makeCandidateAttributionWorkPlan(): WorkPlan {
	const profiles = ["Xon", "Xoff", "A0", "XB"];
	const cells = [
		"Xon-1",
		"Xoff-1",
		"A0-1",
		"A0-2",
		"Xoff-2",
		"Xon-2",
		"XB-1",
		"XB-2",
	];
	return validateWorkPlan({
		schema: "g6-c32-work-plan/1",
		id: "g6-capacity-attribution-a-r5",
		setupMaximumSeconds: 2100,
		controlMaximumSeconds: 60,
		teardownReserveSeconds: 600,
		activeMaximumSeconds: 5520,
		profiles,
		entry: cells[0],
		nodes: cells.map(
			(id, index): WorkNode => ({
				id,
				label: id,
				kind: "attribution-r4",
				profile: requireDefined(id.split("-")[0]),
				requestedSessions: 40000,
				activeWorkloadSessions: 40000,
				maximumSeconds: 420,
				next: {
					PASS: cells[index + 1] ?? COMPLETE,
					MISS: cells[index + 1] ?? COMPLETE,
					INVALID: INCOMPLETE,
				},
			}),
		),
	});
}

export function makeCapacityLadderWorkPlan(
	id: "g6-capacity-ladder-b" | R5LadderPlanId = "g6-capacity-ladder-b",
): WorkPlan {
	const rungs = [5000, 10000, 20000, 30000, 40000, 40000, 50000, 50000];
	const ids = rungs.map(
		(rung, index) => `L${rung}-${rungs[index - 1] === rung ? 2 : 1}`,
	);
	const nodes: WorkNode[] = [];
	const companion = (requested: number, active: number): string => {
		const first = `C${requested}-1`;
		if (!nodes.some((node) => node.id === first)) {
			for (const replicate of [1, 2])
				nodes.push({
					id: `C${requested}-${replicate}`,
					label: `C${replicate}`,
					kind: "companion",
					profile: "candidate",
					requestedSessions: requested,
					activeWorkloadSessions: active,
					maximumSeconds: 480,
					next: {
						PASS: replicate === 1 ? `C${requested}-2` : COMPLETE,
						MISS: replicate === 1 ? `C${requested}-2` : COMPLETE,
						INVALID: INCOMPLETE,
					},
				});
		}
		return first;
	};
	for (const [index, rung] of rungs.entries()) {
		let miss: WorkTarget = COMPLETE;
		const lower = rungs
			.slice(0, index)
			.filter((value) => value < rung)
			.at(-1);
		if (lower !== undefined) {
			const companionId = companion(rung, lower);
			if (lower === 40000) miss = companionId;
			else {
				const repeatId = `L${lower}-2`;
				miss = repeatId;
				if (!nodes.some((node) => node.id === repeatId))
					nodes.push({
						id: repeatId,
						label: repeatId,
						kind: "ladder",
						profile: "candidate",
						requestedSessions: lower,
						activeWorkloadSessions: lower,
						maximumSeconds: 480,
						next: { PASS: companionId, MISS: INCOMPLETE, INVALID: INCOMPLETE },
					});
			}
		}
		nodes.push({
			id: requireDefined(ids[index]),
			label: requireDefined(ids[index]),
			kind: "ladder",
			profile: "candidate",
			requestedSessions: rung,
			activeWorkloadSessions: rung,
			maximumSeconds: 480,
			next: {
				PASS: ids[index + 1] ?? COMPLETE,
				MISS: miss,
				INVALID: INCOMPLETE,
			},
		});
	}
	return validateWorkPlan({
		schema: "g6-c32-work-plan/1",
		id,
		setupMaximumSeconds: 2100,
		controlMaximumSeconds: 120,
		teardownReserveSeconds: 600,
		activeMaximumSeconds: 7020,
		profiles: ["candidate"],
		entry: ids[0],
		nodes,
	});
}

/** Post-closure 50k send-buffer A/B on one pair: two full-rate 50k cells,
 * `D` (default buffer) and `S` (4 MiB), order counterbalanced across pairs.
 * attribution-r4 semantics: S1-S4 MISS is measured and continues. */
export function makeSendBufferAbWorkPlan(
	order: "ds" | "sd",
	probe = false,
): WorkPlan {
	const cells = order === "ds" ? ["D50k", "S50k"] : ["S50k", "D50k"];
	return validateWorkPlan({
		schema: "g6-c32-work-plan/1",
		id: `g6-sndbuf-50k-ab-${order}${probe ? "-probe" : ""}`,
		setupMaximumSeconds: 2100,
		controlMaximumSeconds: 60,
		teardownReserveSeconds: 600,
		activeMaximumSeconds: 3120,
		profiles: ["D", "S"],
		entry: requireDefined(cells[0]),
		nodes: cells.map(
			(id, index): WorkNode => ({
				id,
				label: id,
				kind: "attribution-r4",
				profile: id.slice(0, 1),
				requestedSessions: 50000,
				activeWorkloadSessions: 50000,
				maximumSeconds: 480,
				next: {
					PASS: cells[index + 1] ?? COMPLETE,
					MISS: cells[index + 1] ?? COMPLETE,
					INVALID: INCOMPLETE,
				},
			}),
		),
	});
}

export const SHARDED_ARMS_PLAN_ID = "g6-sharded-arms";

/** Sharded arms (pre-registration g6-sharded-arms/1, plan r6) on one pair:
 * H5k, H40k, S1-5k, S2-5k, S1-40k, S2-40k in that order, every cell on the
 * closed 40k candidate profile. Whole-cell maxima hotspot 480 s, storm 600 s;
 * setup 2100 s, control 60 s, teardown 600 s (5,520 s active). PASS and MISS
 * continue; INVALID stops INCOMPLETE (stamped hotspot cells stand). Each
 * cell's arm, sessions and cohort come from SHARDED_ARMS_CELLS by node id. */
export function makeShardedArmsWorkPlan(): WorkPlan {
	const cells = SHARDED_ARMS_CELLS;
	return validateWorkPlan({
		schema: "g6-c32-work-plan/1",
		id: SHARDED_ARMS_PLAN_ID,
		setupMaximumSeconds: 2100,
		controlMaximumSeconds: 60,
		teardownReserveSeconds: 600,
		activeMaximumSeconds: 5520,
		profiles: ["candidate"],
		entry: requireDefined(cells[0]).id,
		nodes: cells.map(
			(cell, index): WorkNode => ({
				id: cell.id,
				label: cell.id,
				kind: cell.arm,
				profile: "candidate",
				requestedSessions: cell.sessions,
				activeWorkloadSessions: cell.sessions,
				maximumSeconds:
					cell.arm === "hotspot"
						? SHARDED_ARMS_REGISTERED.hotspotMaximumSeconds
						: SHARDED_ARMS_REGISTERED.stormMaximumSeconds,
				next: {
					PASS: cells[index + 1]?.id ?? COMPLETE,
					MISS: cells[index + 1]?.id ?? COMPLETE,
					INVALID: INCOMPLETE,
				},
			}),
		),
	});
}
