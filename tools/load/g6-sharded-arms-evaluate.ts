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
 * INVALID or a clause INCOMPLETE stops the run INCOMPLETE. A later storm
 * INVALID never voids the hotspot cells already stamped. No "G6 PASS" is
 * promoted from this gate.
 *
 * Authoritative stamp (sealed runs; pre-registration §11):
 *   bun tools/load/g6-sharded-arms-evaluate.ts \
 *     --shards 24 --client-processes 4 --endpoints 128 \
 *     --fixed-source-port-base <sealed profile fixedSourcePortBase> \
 *     --cell H5k=<run root> [--cell <id>=<run root> ...] [--out stamp.json]
 *   A run root is `.scratch/bare-metal-campaign/provisioning/<runId>` of a
 *   sealed, destroyed run. Every cell is re-graded by the sealed path itself
 *   (`readWorkCellEvidence` + `gradeWorkCell`, so V-C and the raw-cell
 *   validation run exactly as in the paid run), must agree with the sealed
 *   `work-grade.json`, and the stamp refuses any disagreement. Cells may come
 *   from more than one run (the storm-only rerun): each run supplies a prefix
 *   of its own frozen plan, and a sealed cell left out must be superseded by
 *   another run. The argv is pinned to the registered deployment and the
 *   sealed profile; a missing or different port base refuses.
 *
 * Dry stamp (scan files only; never authoritative):
 *   ... --expect-candidate <sha> --registration-sha256 <sha> \
 *     --shards N --client-processes P --endpoints E \
 *     [--fixed-source-port-base B] [--rig-qualified 1] \
 *     --cell H5k=<scan.json> [--cell ...] [--out stamp.json]
 *   Rehearsal-only options:
 *     --rehearsal-vr-ms R (refused once R is frozen)  --rehearsal-shape <cell>:<sessions>:<cohort>
 *     --rehearsal-raid-target-slot K
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	budgetPolicyArtifactSha256,
	validateBudgetPolicy,
} from "./g6-c32-budget.ts";
import { readWorkCellEvidence } from "./g6-c32-work-execution.ts";
import { gradeWorkCell, type WorkGrade } from "./g6-c32-work-grade.ts";
import {
	SHARDED_ARMS_CLIENT_PROCESSES,
	SHARDED_ARMS_PLAN_IDS,
	SHARDED_ARMS_SHARDS,
} from "./g6-c32-work-profile.ts";
import { readWorkAuthority } from "./g6-capacity-work-authority.ts";
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
	/** The sealed runs the cells were graded from (empty for a dry stamp). */
	sources: StampSource[];
	cells: ShardedArmsCellVerdict[];
};

export type StampSource = {
	runId: string;
	planId: string;
	candidateSha: string;
	registrationSha256: string;
	cells: string[];
	/** Sealed cells of this run replaced by another run's cell. */
	superseded: {
		cell: string;
		sealedOutcome: string;
		sealedReasons: string[];
		supersededBy: string;
	}[];
};

/** The registered deployment's endpoint count (gate §2: ports 20000-20127). */
export const SHARDED_ARMS_ENDPOINTS = 128;

const ORDER = SHARDED_ARMS_CELLS.map((cell) => cell.id);

/** Roll graded cells (in run order) into the arm verdicts. */
export function rollUpShardedArms(
	graded: readonly ShardedArmsCellVerdict[],
	options: {
		authoritative: boolean;
		rehearsalOverrides: string[];
		/** Rehearsal only: grade cells past an INVALID (never authoritative). */
		continueAfterInvalid?: boolean;
		sources?: StampSource[];
	},
): ShardedArmsStamp {
	if (options.continueAfterInvalid && options.authoritative)
		throw Error("g6-sharded-arms: continuing past INVALID is rehearsal-only");
	const ids = graded.map((cell) => cell.cell);
	if (ids.some((id, index) => id !== ORDER[index]))
		throw Error(
			`g6-sharded-arms: cells must be a prefix of the registered order ${ORDER.join(", ")}`,
		);
	// INVALID and a clause INCOMPLETE both stop the run (§7).
	const invalidAt = graded.findIndex(
		(cell) => cell.verdict === "INVALID" || cell.verdict === "INCOMPLETE",
	);
	if (
		invalidAt >= 0 &&
		invalidAt !== graded.length - 1 &&
		!options.continueAfterInvalid
	)
		throw Error("g6-sharded-arms: a cell ran after an INVALID or INCOMPLETE");
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
	const sources = options.sources ?? [];
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
			...(sources.length > 1
				? [
						`Cells combined from ${sources.length} sealed runs: ${sources
							.map((s) => `${s.runId} (${s.cells.join(", ")})`)
							.join("; ")}.`,
					]
				: []),
			...sources.flatMap((s) =>
				s.superseded.map(
					(x) =>
						`${s.runId} ${x.cell} sealed ${x.sealedOutcome} is superseded by ${x.supersededBy} (pre-registration §11).`,
				),
			),
		],
		sources,
		cells: [...graded],
	};
}

type ArmsPolicy = Extract<
	ReturnType<typeof validateBudgetPolicy>,
	{ schema: "g6-c32-budget-policy/2" }
>;
type SealedRun = {
	root: string;
	runId: string;
	campaign: string;
	policy: ArmsPolicy;
	authority: ReturnType<typeof readWorkAuthority>;
};

/** A sealed tree's SHA256SUMS: every listed file must still hash to its
 * entry (`all`), or just the `required` ones; every required path must be
 * listed. */
function verifySealedSums(
	dir: string,
	required: readonly string[],
	all: boolean,
): void {
	const listed = new Map<string, string>();
	for (const line of readFileSync(join(dir, "SHA256SUMS"), "utf8").split(
		"\n",
	)) {
		if (line === "") continue;
		const m = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
		if (m === null) throw Error(`${dir}: malformed SHA256SUMS line`);
		listed.set(m[2] as string, m[1] as string);
	}
	for (const path of required)
		if (!listed.has(path)) throw Error(`${dir}: ${path} is not sealed`);
	for (const [path, sum] of listed)
		if (
			(all || required.includes(path)) &&
			createHash("sha256")
				.update(readFileSync(join(dir, path)))
				.digest("hex") !== sum
		)
			throw Error(`${dir}: sealed ${path} differs from SHA256SUMS`);
}

function readSealedRun(root: string): SealedRun {
	const runId = basename(root);
	if (readFileSync(join(root, "RUN_STATUS"), "utf8").trim() !== "DESTROYED")
		throw Error(`${runId}: not a sealed, destroyed run`);
	const campaign = join(root, `campaign-${runId}`);
	const policyPath = `semantic/inputs/.scratch/bare-metal-campaign/plans/${runId}-budget.json`;
	// The seals, not only RUN_STATUS: the bound policy and the whole sealed
	// campaign tree must match their SHA256SUMS.
	verifySealedSums(join(root, "bound"), [policyPath], false);
	verifySealedSums(campaign, ["work-authority.json"], true);
	const authority = readWorkAuthority(campaign);
	const policy = validateBudgetPolicy(
		JSON.parse(
			readFileSync(
				join(
					root,
					"bound/semantic/inputs/.scratch/bare-metal-campaign/plans",
					`${runId}-budget.json`,
				),
				"utf8",
			),
		),
	);
	if (policy.schema !== "g6-c32-budget-policy/2")
		throw Error(`${runId}: bound policy carries no work plan`);
	if (
		authority.runId !== runId ||
		policy.runId !== runId ||
		budgetPolicyArtifactSha256(policy) !== authority.policySha256 ||
		!(SHARDED_ARMS_PLAN_IDS as readonly string[]).includes(policy.workPlan.id)
	)
		throw Error(`${runId}: bound policy/authority is not a sharded-arms run`);
	return { root, runId, campaign, policy, authority };
}

/**
 * The authoritative stamp from sealed runs. Each cell is re-graded by the
 * sealed path (`gradeWorkCell` over `readWorkCellEvidence`), which must equal
 * the sealed `work-grade.json`; the arms verdict is recomputed with the sealed
 * profile and run authority and must agree with that grade. Any disagreement
 * refuses: the stamp can never be laxer than the sealed grade.
 */
export function stampFromSealedRuns(
	cells: readonly { id: string; root: string }[],
	argv: {
		shards: number;
		clientProcesses: number;
		endpoints: number;
		fixedSourcePortBase: number | null;
	},
	grade: (
		input: Parameters<typeof gradeWorkCell>[0],
	) => WorkGrade = gradeWorkCell,
): ShardedArmsStamp {
	if (
		argv.shards !== SHARDED_ARMS_SHARDS ||
		argv.clientProcesses !== SHARDED_ARMS_CLIENT_PROCESSES ||
		argv.endpoints !== SHARDED_ARMS_ENDPOINTS
	)
		throw Error(
			`stamp argv must be --shards ${SHARDED_ARMS_SHARDS} --client-processes ${SHARDED_ARMS_CLIENT_PROCESSES} --endpoints ${SHARDED_ARMS_ENDPOINTS}`,
		);
	if (argv.fixedSourcePortBase === null)
		throw Error("--fixed-source-port-base is required (the sealed profile's)");
	const runs = new Map<string, SealedRun>();
	const taken = new Map<string, string[]>();
	const graded: ShardedArmsCellVerdict[] = [];
	for (const { id, root } of cells) {
		const run = runs.get(root) ?? readSealedRun(root);
		runs.set(root, run);
		const node = run.policy.workPlan.nodes.find((n) => n.id === id);
		if (node === undefined) throw Error(`${run.runId}: no cell ${id}`);
		const profile = run.policy.workProfiles[node.profile];
		if (
			profile === undefined ||
			profile.shards !== argv.shards ||
			profile.clientProcesses !== argv.clientProcesses ||
			profile.endpoints !== argv.endpoints ||
			profile.fixedSourcePortBase !== argv.fixedSourcePortBase
		)
			throw Error(
				`${run.runId} ${id}: stamp argv differs from the sealed profile`,
			);
		const sealedPath = join(run.campaign, "work", id, "work-grade.json");
		if (!existsSync(sealedPath))
			throw Error(`${run.runId} ${id}: no sealed work grade`);
		// Every file of the cell is covered by the campaign seal.
		verifySealedSums(
			run.campaign,
			readdirSync(join(run.campaign, "work", id)).map(
				(name) => `work/${id}/${name}`,
			),
			false,
		);
		const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as WorkGrade;
		const raw = readWorkCellEvidence(
			run.campaign,
			node,
			profile,
			run.authority,
		);
		const work = grade(raw);
		if (work.outcome !== sealed.outcome || work.nodeId !== sealed.nodeId)
			throw Error(
				`${run.runId} ${id}: re-grade ${work.outcome} disagrees with the sealed work grade ${sealed.outcome} (${sealed.reasons.join("; ")})`,
			);
		let arms = gradeShardedArmsCell(
			{
				cell: shardedArmsCell(id),
				scan: raw.scan,
				expectCandidate: run.authority.candidateSha,
				registrationSha256: run.authority.registrationSha256,
				shards: profile.shards,
				clientProcesses: profile.clientProcesses ?? 1,
				endpoints: profile.endpoints,
				fixedSourcePortBase: profile.fixedSourcePortBase,
				rig: { qualified: true, reasons: [] },
				vR: frozenVR(),
				raidTargetSlot: SHARDED_ARMS_REGISTERED.raidTargetSlot,
			},
			String((raw.scan as unknown as { startedAt?: unknown }).startedAt),
		);
		const stops = (v: string) => v === "INVALID" || v === "INCOMPLETE";
		if (work.outcome === "INVALID" && !stops(arms.verdict))
			// The raw-cell validation (V-C, coverage, receipts) failed where the
			// arms grade alone would not: the sealed grade governs.
			arms = {
				...arms,
				verdict: "INVALID",
				invalidReasons: [
					...arms.invalidReasons,
					...work.reasons.map((r) => `V-C (sealed gradeWorkCell): ${r}`),
				],
			};
		else if (
			work.outcome !== "INVALID" &&
			(stops(arms.verdict) || arms.verdict !== work.outcome)
		)
			throw Error(
				`${run.runId} ${id}: stamp verdict ${arms.verdict} disagrees with the sealed grade ${work.outcome}`,
			);
		graded.push(arms);
		taken.set(root, [...(taken.get(root) ?? []), id]);
	}
	// Each run supplies a prefix of its own frozen plan; a sealed cell it ran
	// but does not supply must be supplied by another run (superseded).
	const sources: StampSource[] = [];
	for (const [root, run] of runs) {
		const ids = taken.get(root) ?? [];
		const plan = run.policy.workPlan.nodes.map((n) => n.id);
		if (ids.some((id, i) => plan[i] !== id))
			throw Error(
				`${run.runId}: stamped cells ${ids.join(", ")} are not a prefix of its plan ${plan.join(", ")}`,
			);
		const superseded: StampSource["superseded"] = [];
		for (const id of plan.slice(ids.length)) {
			const sealedPath = join(run.campaign, "work", id, "work-grade.json");
			if (!existsSync(sealedPath)) continue;
			const by = [...runs].find(
				([other]) => other !== root && (taken.get(other) ?? []).includes(id),
			);
			if (by === undefined)
				throw Error(
					`${run.runId} ${id}: sealed cell omitted without a superseding run`,
				);
			const sealed = JSON.parse(readFileSync(sealedPath, "utf8")) as WorkGrade;
			superseded.push({
				cell: id,
				sealedOutcome: sealed.outcome,
				sealedReasons: sealed.reasons,
				supersededBy: by[1].runId,
			});
		}
		sources.push({
			runId: run.runId,
			planId: run.policy.workPlan.id,
			candidateSha: run.authority.candidateSha,
			registrationSha256: run.authority.registrationSha256,
			cells: ids,
			superseded,
		});
	}
	return rollUpShardedArms(graded, {
		authoritative: true,
		rehearsalOverrides: [],
		sources,
	});
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
/**
 * V-R's R for a stamp. The frozen R (SHARDED_ARMS_V_R_MS) always wins: a
 * rehearsal R is accepted only while R is not frozen (the stamp is then
 * non-authoritative), and is refused once R is frozen.
 */
export function resolveVR(
	rehearsalVr: string | null,
	overrides: string[],
	frozen: VRThreshold | null = frozenVR(),
): VRThreshold | null {
	if (rehearsalVr === null) return frozen;
	if (frozen !== null)
		throw Error(
			`R is frozen at ${frozen.ms} ms; --rehearsal-vr-ms ${rehearsalVr} cannot replace it`,
		);
	if (!/^\d+$/.test(rehearsalVr))
		throw Error("--rehearsal-vr-ms must be an integer");
	overrides.push(`V-R R = ${rehearsalVr} ms (rehearsal; R not frozen)`);
	return { ms: Number(rehearsalVr), source: "rehearsal" };
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
	const cellSpecs = args("cell").map((spec) => {
		const eq = spec.indexOf("=");
		if (eq <= 0) throw Error(`--cell ${spec}: expected <id>=<path>`);
		return { id: spec.slice(0, eq), path: spec.slice(eq + 1) };
	});
	const sealedMode = cellSpecs.map((c) => statSync(c.path).isDirectory());
	if (sealedMode.some(Boolean)) {
		if (!sealedMode.every(Boolean))
			throw Error("a stamp grades either sealed run roots or scan files");
		for (const option of [
			"expect-candidate",
			"registration-sha256",
			"rig-qualified",
			"run-date",
			"rehearsal-vr-ms",
			"rehearsal-shape",
			"rehearsal-raid-target-slot",
			"rehearsal-continue-after-invalid",
		])
			if (args(option).length > 0)
				throw Error(
					`--${option} is not accepted for a sealed stamp (taken from the sealed run)`,
				);
		const base = arg("fixed-source-port-base");
		if (base !== null && !/^\d+$/.test(base))
			throw Error("--fixed-source-port-base must be an integer");
		const stamp = stampFromSealedRuns(
			cellSpecs.map((c) => ({ id: c.id, root: c.path })),
			{
				shards: intArg("shards"),
				clientProcesses: intArg("client-processes"),
				endpoints: intArg("endpoints"),
				fixedSourcePortBase: base === null ? null : Number(base),
			},
		);
		const text = JSON.stringify(stamp, null, 1);
		const out = arg("out");
		if (out) writeFileSync(out, text);
		else console.log(text);
		process.exitCode = 0;
		return;
	}
	// Dry stamp from scan files: the raw cell (V-C, receipts, coverage) is not
	// validated, so it is never authoritative.
	const overrides: string[] = [
		"scan-only dry stamp: raw cell (V-C, receipts, diagnostic coverage) not validated",
	];
	const expectCandidate = arg("expect-candidate");
	const registrationSha256 = arg("registration-sha256");
	if (!expectCandidate || !registrationSha256)
		throw Error("--expect-candidate and --registration-sha256 are required");
	const vR = resolveVR(arg("rehearsal-vr-ms"), overrides);
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
	for (const spec of cellSpecs) {
		const registered = shardedArmsCell(spec.id);
		const shape = shapes.get(registered.id);
		const cell: ShardedArmsCell = shape
			? { ...registered, ...shape }
			: registered;
		graded.push(
			gradeShardedArmsCell(
				{
					cell,
					scan: JSON.parse(readFileSync(spec.path, "utf8")),
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
