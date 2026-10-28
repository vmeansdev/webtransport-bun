/**
 * r5 paired same-host attribution (A') evaluation and the pre-registered,
 * mechanical candidate decision. Plan: docs/superpowers/plans/2026-10-01-
 * g6-capacity-closure-r5.md (SHA256 66b39f74…). Pure: consumes per-cell
 * summaries extracted from validated raw evidence; makes no causal claim.
 */

export const R5_ATTRIBUTION_ORDER = [
	"Xon-1",
	"Xoff-1",
	"A0-1",
	"A0-2",
	"Xoff-2",
	"Xon-2",
	"XB-1",
	"XB-2",
] as const;
export type R5Arm = "Xon" | "Xoff" | "A0" | "XB";
export type R5Outcome = "PASS" | "MISS" | "INVALID";

export type R5CellSummary = Readonly<{
	nodeId: string;
	outcome: R5Outcome;
	startedAt: string;
	sourceSha: string;
	pairId: string; // exact server/generator provider ids + boot ids, joined
	datagramPump: "pump" | "legacy";
	udpSendBatch: number;
	detailedProbe: boolean;
	serverSteadyCpuMs: number;
	generatorSteadyCpuMs: number;
	snapshotIssued: number;
	ackIssued: number;
	serverRxTotal: number;
	offeredMoves: number; // generator scheduleTicksDue in the steady window
	snapshotDue: number;
	ackP50Ms: number;
	ackP99Ms: number;
	serverHoldP99Ms: number;
	clauses: Readonly<
		Record<"S1" | "S2" | "S3" | "S4" | "S5", { value: number; pass: boolean }>
	>;
}>;

export type R5Derived = R5CellSummary & {
	arm: R5Arm;
	generatorUsPerOffered: number;
	serverUsPerOffered: number;
};

export type R5Decision = Readonly<{
	schema: "g6-capacity-attribution-r5-decision/1";
	status: "SELECTED" | "NO_CANDIDATE" | "INCOMPLETE";
	reasons: string[];
	cells: R5Derived[];
	medians: Record<R5Arm, ArmMedians | null>;
	calibration: {
		disposition: "non-interference" | "interference" | "unmeasured";
		serverCpuShift: number | null;
		ackP99Shift: number | null;
	};
	candidate: "C-PUMP" | null;
	sendPath: "stock" | "batch64" | null;
	probeInB: boolean | null;
	bGo: boolean;
	bGoReasons: string[];
	disclosure: {
		generatorCpuDeltaPct: number | null;
		serverCpuDeltaPct: number | null;
		generatorSharesModifiedDriver: true;
		resultScope: "server+generator pair with C-PUMP";
		serverOnlyClaimLimitedToMeasuredDelta: true;
	};
}>;

type ArmMedians = {
	generatorUsPerOffered: number;
	serverUsPerOffered: number;
	ackP50Ms: number;
	ackP99Ms: number;
	serverHoldP99Ms: number;
	minS2: number;
};

const PARITY_TOLERANCE = 0.005;
const CALIBRATION_TOLERANCE = 0.05;

function fail(message: string): never {
	throw Error(`g6-capacity-attribution-r5: ${message}`);
}
function finitePositive(value: number, label: string): number {
	if (!Number.isFinite(value) || value <= 0)
		fail(`${label} must be finite and positive`);
	return value;
}
export function median(values: readonly number[]): number {
	if (values.length === 0) fail("median of no values");
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? (sorted[mid] as number)
		: ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Offered datagrams per role: never delivered counts, so a collapse in one arm cannot skew ratios. */
export function deriveCell(cell: R5CellSummary): R5Derived {
	const arm = cell.nodeId.split("-")[0] as R5Arm;
	if (!["Xon", "Xoff", "A0", "XB"].includes(arm))
		fail(`unknown arm in ${cell.nodeId}`);
	const generatorOffered = finitePositive(
		cell.snapshotIssued + cell.ackIssued,
		"generator offered datagrams",
	);
	const serverOffered = finitePositive(
		cell.serverRxTotal + cell.snapshotIssued + cell.ackIssued,
		"server offered datagrams",
	);
	return {
		...cell,
		arm,
		generatorUsPerOffered:
			(finitePositive(cell.generatorSteadyCpuMs, "generator CPU") * 1000) /
			generatorOffered,
		serverUsPerOffered:
			(finitePositive(cell.serverSteadyCpuMs, "server CPU") * 1000) /
			serverOffered,
	};
}

const ARM_BINDING: Record<
	R5Arm,
	{ pump: "pump" | "legacy"; batch: number; probe: boolean }
> = {
	Xon: { pump: "pump", batch: 0, probe: true },
	Xoff: { pump: "pump", batch: 0, probe: false },
	A0: { pump: "legacy", batch: 0, probe: false },
	XB: { pump: "pump", batch: 64, probe: false },
};

function armMedians(cells: readonly R5Derived[]): ArmMedians {
	return {
		generatorUsPerOffered: median(cells.map((c) => c.generatorUsPerOffered)),
		serverUsPerOffered: median(cells.map((c) => c.serverUsPerOffered)),
		ackP50Ms: median(cells.map((c) => c.ackP50Ms)),
		ackP99Ms: median(cells.map((c) => c.ackP99Ms)),
		serverHoldP99Ms: median(cells.map((c) => c.serverHoldP99Ms)),
		minS2: Math.min(...cells.map((c) => c.clauses.S2.value)),
	};
}

const S1_TO_S5 = ["S1", "S2", "S3", "S4", "S5"] as const;
const passesAll = (c: R5Derived) =>
	c.outcome === "PASS" && S1_TO_S5.every((k) => c.clauses[k].pass);

export function evaluateR5Attribution(input: {
	cells: readonly R5CellSummary[];
	expectedSourceSha: string;
	/** Batch output-ownership tests passed in the source-bound Linux receipts. */
	batchOwnershipTestsPassed: boolean;
}): R5Decision {
	const reasons: string[] = [];
	const cells = input.cells.map(deriveCell);
	// Order and identity: a prefix of the registered order, one pair, one SHA.
	cells.forEach((c, i) => {
		if (c.nodeId !== R5_ATTRIBUTION_ORDER[i])
			fail(`cell ${i} is ${c.nodeId}, expected ${R5_ATTRIBUTION_ORDER[i]}`);
		const b = ARM_BINDING[c.arm];
		if (
			c.datagramPump !== b.pump ||
			c.udpSendBatch !== b.batch ||
			c.detailedProbe !== b.probe
		)
			fail(`${c.nodeId} profile echo differs from its arm`);
		if (c.sourceSha !== input.expectedSourceSha)
			fail(`${c.nodeId} source differs`);
		if (c.pairId !== cells[0]?.pairId)
			fail(`${c.nodeId} ran on a different host pair`);
		if (
			i > 0 &&
			!(Date.parse(c.startedAt) > Date.parse(cells[i - 1]?.startedAt ?? ""))
		)
			fail("cell timestamps are not increasing");
	});
	const invalidAt = cells.findIndex((c) => c.outcome === "INVALID");
	if (invalidAt >= 0 && invalidAt !== cells.length - 1)
		fail("cells continue after an INVALID");
	const valid = cells.filter((c) => c.outcome !== "INVALID");
	// Offered-work parity across all valid cells (moves and snapshot schedule).
	for (const key of ["offeredMoves", "snapshotDue"] as const) {
		const m = median(valid.map((c) => c[key]));
		for (const c of valid)
			if (Math.abs(c[key] / m - 1) > PARITY_TOLERANCE) {
				reasons.push(
					`${c.nodeId} ${key} parity ${(c[key] / m - 1).toFixed(4)} exceeds 0.5%`,
				);
			}
	}
	const byArm = (arm: R5Arm) => valid.filter((c) => c.arm === arm);
	const complete = (arm: R5Arm) => byArm(arm).length === 2;
	const medians = Object.fromEntries(
		(["Xon", "Xoff", "A0", "XB"] as R5Arm[]).map((arm) => [
			arm,
			complete(arm) ? armMedians(byArm(arm)) : null,
		]),
	) as Record<R5Arm, ArmMedians | null>;
	const parityOk = reasons.length === 0;

	// Probe calibration (original rule): Xon vs Xoff.
	let calibration: R5Decision["calibration"] = {
		disposition: "unmeasured",
		serverCpuShift: null,
		ackP99Shift: null,
	};
	if (medians.Xon && medians.Xoff && parityOk) {
		const serverCpuShift =
			medians.Xon.serverUsPerOffered / medians.Xoff.serverUsPerOffered - 1;
		const ackP99Shift = medians.Xon.ackP99Ms / medians.Xoff.ackP99Ms - 1;
		const sameDispositions = byArm("Xon").every((on, i) => {
			const off = byArm("Xoff")[i] as R5Derived;
			return (["S1", "S2", "S3", "S5"] as const).every(
				(k) => on.clauses[k].pass === off.clauses[k].pass,
			);
		});
		calibration = {
			disposition:
				Math.abs(serverCpuShift) <= CALIBRATION_TOLERANCE &&
				Math.abs(ackP99Shift) <= CALIBRATION_TOLERANCE &&
				sameDispositions
					? "non-interference"
					: "interference",
			serverCpuShift,
			ackP99Shift,
		};
	}

	const base: Omit<
		R5Decision,
		"status" | "candidate" | "sendPath" | "probeInB" | "bGo" | "bGoReasons"
	> = {
		schema: "g6-capacity-attribution-r5-decision/1",
		reasons,
		cells,
		medians,
		calibration,
		disclosure: {
			generatorCpuDeltaPct:
				medians.Xoff && medians.A0
					? (medians.Xoff.generatorUsPerOffered /
							medians.A0.generatorUsPerOffered -
							1) *
						100
					: null,
			serverCpuDeltaPct:
				medians.Xoff && medians.A0
					? (medians.Xoff.serverUsPerOffered / medians.A0.serverUsPerOffered -
							1) *
						100
					: null,
			generatorSharesModifiedDriver: true,
			resultScope: "server+generator pair with C-PUMP",
			serverOnlyClaimLimitedToMeasuredDelta: true,
		},
	};
	const noB = { bGo: false, bGoReasons: [] as string[] };
	const selectionArmsComplete =
		complete("Xon") && complete("Xoff") && complete("A0");
	if (!selectionArmsComplete || !parityOk) {
		reasons.push(
			!selectionArmsComplete
				? "selection-critical arms incomplete"
				: "offered-work parity failed",
		);
		return {
			...base,
			status: "INCOMPLETE",
			candidate: null,
			sendPath: null,
			probeInB: null,
			...noB,
		};
	}
	const Xoff = medians.Xoff as ArmMedians,
		A0 = medians.A0 as ArmMedians;
	const selected =
		Xoff.generatorUsPerOffered <= 0.9 * A0.generatorUsPerOffered &&
		Xoff.serverUsPerOffered <= A0.serverUsPerOffered &&
		Xoff.ackP99Ms < A0.ackP99Ms &&
		byArm("Xoff").every((c) => c.clauses.S2.value >= 0.995);
	if (!selected) {
		reasons.push("C-PUMP selection rule not met");
		return {
			...base,
			status: "NO_CANDIDATE",
			candidate: null,
			sendPath: null,
			probeInB: null,
			...noB,
		};
	}
	const XB = medians.XB;
	const sendPath: "stock" | "batch64" =
		XB !== null &&
		input.batchOwnershipTestsPassed &&
		XB.ackP99Ms <= 0.85 * Xoff.ackP99Ms &&
		XB.serverUsPerOffered <= Xoff.serverUsPerOffered &&
		XB.minS2 >= 0.995
			? "batch64"
			: "stock";
	const probeInB = calibration.disposition === "non-interference";
	// B go/no-go: both A' replicates of the arm B will run must pass S1-S5.
	const bArm: R5Arm = sendPath === "batch64" ? "XB" : probeInB ? "Xon" : "Xoff";
	const bCells = byArm(bArm);
	const bGoReasons =
		bCells.length === 2 && bCells.every(passesAll)
			? []
			: [`B arm ${bArm} did not pass S1-S5 in both A' replicates`];
	return {
		...base,
		status: "SELECTED",
		candidate: "C-PUMP",
		sendPath,
		probeInB,
		bGo: bGoReasons.length === 0,
		bGoReasons,
	};
}
