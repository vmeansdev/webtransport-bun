/**
 * The interleaved A/B dispatch order, as a pure function.
 *
 * The order is a registered rule, not a scheduling detail:
 * `docs/research/preregistrations/latency-ab.md` fixes it before the run because
 * the whole point of the dispatch is that the two arms of a pair are compared
 * across ~64 seconds instead of across half an hour. It lives in its own module,
 * with its own tests, so the conductor cannot quietly drift from the document and
 * so a reader can check the schedule without reading a process spawner.
 *
 * Two properties the tests pin, and the reason each exists:
 *
 *   * **Adjacency** — the two members of a pair run back-to-back, so a slow drift
 *     in host state is common to both and cancels in the paired Δ.
 *   * **ABBA** — odd replicates run `default` first, even replicates run `batch0`
 *     first, so the *residual* drift inside a pair cancels across the dispatch
 *     rather than accumulating into one arm's favour.
 */

export type AbArm = "default" | "batch0";

/** Rungs, labelled by the aggregate rate at 100 sessions. `F` is the floor arm. */
export const AB_RUNGS = [
	{ rung: "A", perSessionRate: 100, aggregate: 10_000 },
	{ rung: "B", perSessionRate: 150, aggregate: 15_000 },
	{ rung: "C", perSessionRate: 200, aggregate: 20_000 },
	{ rung: "D", perSessionRate: 250, aggregate: 25_000 },
] as const;

/**
 * The floor arm: 1,000/s aggregate, one fifteenth of rung B and two orders of
 * magnitude below the measured knee. Queueing cannot be present, so what it
 * measures is the harness's own fixed cost — which is what the pinned floor rule
 * subtracts and what the honesty check compares schedule lag against.
 */
export const AB_FLOOR_RUNG = {
	rung: "F",
	perSessionRate: 10,
	aggregate: 1_000,
} as const;

/** G2's rate, and the reason this dispatch exists. */
export const AB_GATE_RUNG = "B";

export const AB_REPLICATES = 10;

/** First port an arm binds. Each cell takes the next one, so no arm reuses a port. */
export const AB_FIRST_PORT = 4400;

export type AbCell = {
	/** Position in the dispatch, 0-based. Also decides the port. */
	index: number;
	arm: AbArm;
	rung: string;
	perSessionRate: number;
	aggregate: number;
	/** 1-based replicate, or 0 for a floor arm. */
	replicate: number;
	isFloor: boolean;
	port: number;
};

/**
 * The dispatch's cells in the order they run. 86 of them: 4 rungs × 10 pairs ×
 * 2 arms, plus 3 floor pairs spread across the dispatch so floor drift over its
 * ~50 minutes is visible rather than assumed away.
 */
export function abSchedule(): AbCell[] {
	const cells: Omit<AbCell, "index" | "port">[] = [];

	const floorPair = (pairIndex: number) => {
		const arms: AbArm[] =
			pairIndex % 2 === 0 ? ["default", "batch0"] : ["batch0", "default"];
		for (const arm of arms) {
			cells.push({
				arm,
				rung: AB_FLOOR_RUNG.rung,
				perSessionRate: AB_FLOOR_RUNG.perSessionRate,
				aggregate: AB_FLOOR_RUNG.aggregate,
				replicate: 0,
				isFloor: true,
			});
		}
	};

	floorPair(0);
	for (let r = 1; r <= AB_REPLICATES; r += 1) {
		for (const { rung, perSessionRate, aggregate } of AB_RUNGS) {
			const arms: AbArm[] =
				r % 2 === 1 ? ["default", "batch0"] : ["batch0", "default"];
			for (const arm of arms) {
				cells.push({
					arm,
					rung,
					perSessionRate,
					aggregate,
					replicate: r,
					isFloor: false,
				});
			}
		}
		if (r === 5) floorPair(1);
	}
	floorPair(2);

	return cells.map((cell, index) => ({
		...cell,
		index,
		port: AB_FIRST_PORT + index,
	}));
}
