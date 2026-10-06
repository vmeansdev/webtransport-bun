/**
 * Stamp evaluator for pre-registration g6-sharded-arms/1 (plan
 * docs/superpowers/plans/2026-10-06-g6-sharded-arms.md r6, work item 5).
 *
 * Grades each completed cell from its raw scan artifact
 * (g6-sharded-arms-grade.ts) and rolls the registered cells up into the two
 * arm verdicts:
 *
 *   - hotspot: H40k carries the gate; H5k is the bridge to G6-04 (reported);
 *   - storm: S1-5k (S-C1, S-C2), S2-5k (S-C2) and S1-40k (S-C1, S-C2) carry
 *     the gate; S2-40k is characterization only.
 *
 * Run rules: cells run in the registered order; PASS and MISS continue; an
 * INVALID stops the run INCOMPLETE. A later storm INVALID never voids the
 * hotspot cells already stamped. No "G6 PASS" is promoted from this gate.
 *
 * Usage (stamp / dry stamp):
 *   bun tools/load/g6-sharded-arms-evaluate.ts \
 *     --expect-candidate <sha> --registration-sha256 <sha> \
 *     --shards N --client-processes P --endpoints E \
 *     [--fixed-source-port-base B] [--rig-qualified 1] \
 *     --cell H5k=<scan.json> [--cell ...] [--out stamp.json]
 *   Rehearsal-only (the stamp is then marked non-authoritative):
 *     --rehearsal-vr-ms R  --rehearsal-shape <cell>:<sessions>:<cohort>
 *     --rehearsal-raid-target-slot K
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
	frozenVR,
	gradeShardedArmsCell,
	SHARDED_ARMS_CELLS,
	SHARDED_ARMS_PREREGISTRATION_ID,
	SHARDED_ARMS_REGISTERED,
	type ShardedArmsCell,
	type ShardedArmsCellVerdict,
	shardedArmsCell,
	type VRThreshold,
} from "./g6-sharded-arms-grade.ts";

export type ShardedArmsStamp = {
	schema: "g6-sharded-arms-stamp/1";
	preregistrationId: typeof SHARDED_ARMS_PREREGISTRATION_ID;
	authoritative: boolean;
	rehearsalOverrides: string[];
	run: "COMPLETE" | "INCOMPLETE";
	arms: {
		hotspot: {
			verdict: "PASS" | "MISS" | "INVALID" | "INCOMPLETE";
			gateCell: "H40k";
			bridge: ShardedArmsCellVerdict["verdict"] | "NOT RUN";
		};
		storm: {
			verdict: "PASS" | "MISS" | "INVALID" | "INCOMPLETE";
			gateCells: string[];
			characterization: ShardedArmsCellVerdict["verdict"] | "NOT RUN";
		};
	};
	notes: string[];
	cells: ShardedArmsCellVerdict[];
};

const ORDER = SHARDED_ARMS_CELLS.map((cell) => cell.id);

/** Roll graded cells (in run order) into the arm verdicts. */
export function rollUpShardedArms(
	graded: readonly ShardedArmsCellVerdict[],
	options: {
		authoritative: boolean;
		rehearsalOverrides: string[];
		/** Rehearsal only: grade cells past an INVALID (never authoritative). */
		continueAfterInvalid?: boolean;
	},
): ShardedArmsStamp {
	if (options.continueAfterInvalid && options.authoritative)
		throw Error("g6-sharded-arms: continuing past INVALID is rehearsal-only");
	const ids = graded.map((cell) => cell.cell);
	if (ids.some((id, index) => id !== ORDER[index]))
		throw Error(
			`g6-sharded-arms: cells must be a prefix of the registered order ${ORDER.join(", ")}`,
		);
	const invalidAt = graded.findIndex((cell) => cell.verdict === "INVALID");
	if (
		invalidAt >= 0 &&
		invalidAt !== graded.length - 1 &&
		!options.continueAfterInvalid
	)
		throw Error("g6-sharded-arms: a cell ran after an INVALID");
	const byId = new Map(graded.map((cell) => [cell.cell, cell]));
	// A clause-level INCOMPLETE is not a registered campaign outcome: it stops
	// the arm like INVALID would, without voiding earlier stamped cells.
	const armVerdict = (cells: readonly string[]) => {
		const verdicts = cells.map((id) => byId.get(id as never)?.verdict);
		if (verdicts.includes("INVALID")) return "INVALID" as const;
		if (verdicts.some((v) => v === undefined || v === "INCOMPLETE"))
			return "INCOMPLETE" as const;
		if (verdicts.includes("MISS")) return "MISS" as const;
		return "PASS" as const;
	};
	const stormGates = SHARDED_ARMS_CELLS.filter(
		(cell) => cell.arm === "storm" && cell.role === "gate",
	).map((cell) => cell.id);
	const complete = graded.length === ORDER.length && invalidAt < 0;
	return {
		schema: "g6-sharded-arms-stamp/1",
		preregistrationId: SHARDED_ARMS_PREREGISTRATION_ID,
		authoritative: options.authoritative,
		rehearsalOverrides: options.rehearsalOverrides,
		run: complete ? "COMPLETE" : "INCOMPLETE",
		arms: {
			hotspot: {
				verdict: armVerdict(["H40k"]),
				gateCell: "H40k",
				bridge: byId.get("H5k")?.verdict ?? "NOT RUN",
			},
			storm: {
				verdict: armVerdict(stormGates),
				gateCells: stormGates,
				characterization: byId.get("S2-40k")?.verdict ?? "NOT RUN",
			},
		},
		notes: [
			"G6-04's valid MISS remains the single-instance G6 verdict; no G6 PASS is promoted from this gate.",
			"A storm INVALID stops the run INCOMPLETE and does not void hotspot cells already stamped.",
			"S2-40k is characterization only; its S-C2 is reported without verdict force.",
		],
		cells: [...graded],
	};
}

function args(name: string): string[] {
	const out: string[] = [];
	for (let i = 2; i < process.argv.length; i += 1)
		if (process.argv[i] === `--${name}`) {
			const value = process.argv[i + 1];
			if (value === undefined) throw Error(`--${name} needs a value`);
			out.push(value);
		}
	return out;
}
function arg(name: string): string | null {
	const all = args(name);
	if (all.length > 1) throw Error(`--${name} repeated`);
	return all[0] ?? null;
}
function intArg(name: string, fallback?: number): number {
	const raw = arg(name);
	if (raw === null) {
		if (fallback === undefined) throw Error(`--${name} is required`);
		return fallback;
	}
	if (!/^\d+$/.test(raw)) throw Error(`--${name} must be an integer`);
	return Number(raw);
}

async function main(): Promise<void> {
	const overrides: string[] = [];
	const expectCandidate = arg("expect-candidate");
	const registrationSha256 = arg("registration-sha256");
	if (!expectCandidate || !registrationSha256)
		throw Error("--expect-candidate and --registration-sha256 are required");
	let vR: VRThreshold | null = frozenVR();
	const rehearsalVr = arg("rehearsal-vr-ms");
	if (rehearsalVr !== null) {
		if (vR !== null)
			throw Error("R is frozen; a rehearsal R cannot replace it");
		vR = { ms: Number(rehearsalVr), source: "rehearsal" };
		overrides.push(`V-R R = ${rehearsalVr} ms (rehearsal; R not frozen)`);
	}
	const shapes = new Map<string, { sessions: number; cohort: number }>();
	for (const spec of args("rehearsal-shape")) {
		const [id, sessions, cohort] = spec.split(":");
		shapes.set(String(id), {
			sessions: Number(sessions),
			cohort: Number(cohort),
		});
		overrides.push(`cell ${id} shape ${sessions} sessions, cohort ${cohort}`);
	}
	const slotRaw = arg("rehearsal-raid-target-slot");
	if (slotRaw !== null) overrides.push(`raid target slot ${slotRaw}`);
	const continueAfterInvalid = arg("rehearsal-continue-after-invalid") === "1";
	if (continueAfterInvalid)
		overrides.push("cells graded past an INVALID (rehearsal)");
	const rigQualified = arg("rig-qualified") === "1";
	if (!rigQualified) overrides.push("rig not qualified (V-C fires)");
	const base = arg("fixed-source-port-base");
	const graded: ShardedArmsCellVerdict[] = [];
	const runDate = arg("run-date") ?? new Date().toISOString();
	for (const spec of args("cell")) {
		const eq = spec.indexOf("=");
		const registered = shardedArmsCell(spec.slice(0, eq));
		const shape = shapes.get(registered.id);
		const cell: ShardedArmsCell = shape
			? { ...registered, ...shape }
			: registered;
		graded.push(
			gradeShardedArmsCell(
				{
					cell,
					scan: JSON.parse(readFileSync(spec.slice(eq + 1), "utf8")),
					expectCandidate,
					registrationSha256,
					shards: intArg("shards"),
					clientProcesses: intArg("client-processes"),
					endpoints: intArg("endpoints"),
					fixedSourcePortBase: base === null ? null : Number(base),
					rig: {
						qualified: rigQualified,
						reasons: rigQualified
							? []
							: ["not the registered rig (rehearsal or unqualified pair)"],
					},
					vR,
					raidTargetSlot:
						slotRaw === null
							? SHARDED_ARMS_REGISTERED.raidTargetSlot
							: Number(slotRaw),
				},
				runDate,
			),
		);
	}
	const stamp = rollUpShardedArms(graded, {
		authoritative: overrides.length === 0,
		rehearsalOverrides: overrides,
		continueAfterInvalid,
	});
	const text = JSON.stringify(stamp, null, 1);
	const out = arg("out");
	if (out) writeFileSync(out, text);
	else console.log(text);
	process.exitCode = stamp.authoritative ? 0 : 3;
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		console.error(String(error));
		process.exitCode = 1;
	}
}
