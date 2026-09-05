import { requireDefined } from "./g6-c32-freeze-model.ts";
import {
	validateWorkPlan,
	type WorkNode,
	type WorkPlan,
	type WorkTarget,
} from "./g6-c32-work-plan.ts";

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
		setupMaximumSeconds: 840,
		controlMaximumSeconds: 60,
		teardownReserveSeconds: 600,
		activeMaximumSeconds: 4260,
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

export function makeCapacityLadderWorkPlan(): WorkPlan {
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
		id: "g6-capacity-ladder-b",
		setupMaximumSeconds: 840,
		controlMaximumSeconds: 120,
		teardownReserveSeconds: 600,
		activeMaximumSeconds: 5760,
		profiles: ["candidate"],
		entry: ids[0],
		nodes,
	});
}
