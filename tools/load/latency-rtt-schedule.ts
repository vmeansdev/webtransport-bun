/**
 * The off-box RTT dispatch order, as a pure function.
 *
 * The order is a registered rule, not a scheduling detail:
 * `docs/research/preregistrations/gate-g2-offbox-rtt.md` §5 fixes all 22 cells
 * and their positions before the run, because the floor arms and the on-box
 * controls only mean something if they are spread through the dispatch rather
 * than clustered where a drifting host would flatter one of them. It lives in
 * its own module, with its own tests, so the conductor cannot quietly drift from
 * the document.
 *
 * Cell 0 is deliberately an off-box floor arm: it doubles as the reachability
 * pre-flight, and the conductor aborts the whole dispatch if it produces no
 * sessions.
 */

export type RttPlacement = "offbox" | "onbox";

export type RttRung = {
	/** Registered rung name. `G` is the gate; everything else is context. */
	rung: string;
	placement: RttPlacement;
	perSessionRate: number;
	aggregate: number;
	isFloor: boolean;
};

export const RTT_SESSIONS = 100;

export const RTT_RUNGS = {
	floorOff: {
		rung: "F-off",
		placement: "offbox",
		perSessionRate: 10,
		aggregate: 1_000,
		isFloor: true,
	},
	floorOn: {
		rung: "F-on",
		placement: "onbox",
		perSessionRate: 10,
		aggregate: 1_000,
		isFloor: true,
	},
	contextOff: {
		rung: "A-off",
		placement: "offbox",
		perSessionRate: 100,
		aggregate: 10_000,
		isFloor: false,
	},
	gateOff: {
		rung: "G-off",
		placement: "offbox",
		perSessionRate: 150,
		aggregate: 15_000,
		isFloor: false,
	},
	gateOn: {
		rung: "G-on",
		placement: "onbox",
		perSessionRate: 150,
		aggregate: 15_000,
		isFloor: false,
	},
} as const satisfies Record<string, RttRung>;

/** The one rung that can carry a G2 verdict. */
export const RTT_GATE_RUNG = "G-off";
export const RTT_GATE_REPLICATES = 10;
/** Registered bound: 64% of a 64 Hz tick period. */
export const RTT_BOUND_MS = 10.0;

/** First port a cell binds. Each cell takes the next, so no cell reuses one. */
export const RTT_FIRST_PORT = 4500;

export type RttCell = {
	/** Position in the dispatch, 0-based. Also decides the port. */
	index: number;
	rung: string;
	placement: RttPlacement;
	perSessionRate: number;
	aggregate: number;
	/** 1-based for measurement rungs; floor arms are numbered from 0. */
	replicate: number;
	isFloor: boolean;
	port: number;
};

/**
 * The 22 cells in the order they run, exactly as registered in §5 of the
 * pre-registration. Written out rather than generated: a table a reader can
 * diff against the document beats a loop a reader has to simulate.
 */
const ORDER: ReadonlyArray<readonly [keyof typeof RTT_RUNGS, number]> = [
	["floorOff", 0],
	["floorOn", 0],
	["contextOff", 1],
	["gateOff", 1],
	["gateOn", 1],
	["gateOff", 2],
	["gateOff", 3],
	["contextOff", 2],
	["floorOff", 1],
	["floorOn", 1],
	["gateOff", 4],
	["gateOn", 2],
	["gateOff", 5],
	["gateOff", 6],
	["contextOff", 3],
	["gateOff", 7],
	["gateOn", 3],
	["gateOff", 8],
	["gateOff", 9],
	["gateOff", 10],
	["floorOff", 2],
	["floorOn", 2],
];

export function rttSchedule(): RttCell[] {
	return ORDER.map(([key, replicate], index) => {
		const rung = RTT_RUNGS[key];
		return {
			index,
			rung: rung.rung,
			placement: rung.placement,
			perSessionRate: rung.perSessionRate,
			aggregate: rung.aggregate,
			replicate,
			isFloor: rung.isFloor,
			port: RTT_FIRST_PORT + index,
		};
	});
}
