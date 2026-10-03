/** Synthetic offline r5 evidence only (plan T2.6). Neither executes Linux nor proves capacity. */
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalArtifactSha256 } from "./g6-c32-freeze-model.ts";
import { cleanupSendPathFixtures } from "./g6-c32-send-path-fixture.test-helper.ts";
import { evaluateR5Attribution } from "./g6-capacity-attribution-r5.ts";
import {
	completeGoalAdaptersFixture,
	syntheticLinuxProcessFixture as processFixture,
} from "./g6-capacity-goal-adapters.fixture.test-helper.ts";
import {
	type CapacityGoalContract,
	evaluateCapacityGoal,
} from "./g6-capacity-goal-evaluate.ts";
import {
	batchOwnershipTestsPassed,
	R5_BATCH_OWNERSHIP_TESTS,
	R5_VENDORED_WTRANSPORT_TESTS,
	vendoredWtransportTestsPassed,
} from "./g6-capacity-r5-decision.ts";

type Fixture = Awaited<ReturnType<typeof completeGoalAdaptersFixture>>;
type Row = Record<string, unknown>;
const sha = (bytes: string | Buffer) =>
	createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupSendPathFixtures);

async function build(
	r5: NonNullable<Parameters<typeof completeGoalAdaptersFixture>[1]>["r5"],
	bOutcomes?: Record<string, "MISS">,
) {
	const f = await completeGoalAdaptersFixture(processFixture().proof, {
		r5,
		...(bOutcomes ? { bOutcomes } : {}),
	});
	roots.push(f.repoRoot);
	return f;
}
function refused(f: Fixture, label: string, reason?: string | RegExp) {
	const result = evaluateCapacityGoal(f);
	if (![1, 2].includes(result.exitCode) || result.status === "PASS")
		throw Error(`${label} was accepted: ${JSON.stringify(result)}`);
	if (reason !== undefined) expect(result.reasons.join("\n")).toMatch(reason);
	return result;
}
/** Byte-level tamper of one evidence file; optionally re-cover it in the outer manifest. */
function tamper(
	f: Fixture,
	path: string,
	change: (text: string) => string,
	rehash = true,
): () => void {
	const file = join(f.repoRoot, path),
		before = readFileSync(file);
	writeFileSync(file, change(before.toString("utf8")));
	if (rehash) f.rehash();
	return () => {
		writeFileSync(file, before);
		f.rehash();
	};
}
const json = (mutate: (value: Row) => void) => (text: string) => {
	const value = JSON.parse(text);
	mutate(value);
	return JSON.stringify(value);
};
function client(scan: Row): Row {
	return JSON.parse(
		String(scan.clientStdout).slice("mmo-client: json ".length),
	);
}
/** Re-sign a hostile decision edit so only recompute equality can refuse it. */
function resignDecision(f: Fixture, mutate: (decision: Row) => void) {
	const paths = [
		f.decisionPath,
		"evidence/candidate-architect.json",
		"evidence/candidate-critic.json",
	].map((path) => join(f.repoRoot, path));
	const originals = paths.map((path) => readFileSync(path));
	const [decisionPath, architectPath, criticPath] = paths as [
		string,
		string,
		string,
	];
	const decision = JSON.parse(String(originals[0]));
	mutate(decision);
	const bytes = JSON.stringify(decision);
	writeFileSync(decisionPath, bytes);
	const architect = {
		...JSON.parse(String(originals[1])),
		decisionSha256: sha(bytes),
	};
	writeFileSync(architectPath, JSON.stringify(architect));
	writeFileSync(
		criticPath,
		JSON.stringify({
			...JSON.parse(String(originals[2])),
			decisionSha256: sha(bytes),
			afterArchitectReceiptArtifactSha256: canonicalArtifactSha256(architect),
		}),
	);
	f.rehash();
	return () => {
		paths.forEach((path, index) => {
			writeFileSync(path, originals[index] as Buffer);
		});
		f.rehash();
	};
}
function withContract(
	f: Fixture,
	change: (contract: CapacityGoalContract) => CapacityGoalContract,
) {
	writeFileSync(f.contractPath, JSON.stringify(change(f.contract)));
	f.rehash();
	return () => {
		writeFileSync(f.contractPath, JSON.stringify(f.contract));
		f.rehash();
	};
}
const aCell = (f: Fixture, nodeId: string, name = "g6-sharded-scan.json") =>
	`${f.campaignA.reference.runRoot}/campaign-${f.campaignA.policy.runId}/work/${nodeId}/${name}`;
const bCell = (f: Fixture, nodeId: string, name = "g6-sharded-scan.json") =>
	`${f.campaignB.reference.runRoot}/campaign-${f.campaignB.policy.runId}/work/${nodeId}/${name}`;

test("r5 synthetic gate: complete A' + decision + B (40k x2, 50k MISS + companions) exits 0; every tamper exits 1 or 2", async () => {
	const f = await build({}, { "L50000-2": "MISS", "C50000-2": "MISS" });
	expect(f.campaignA.policy.workPlan.id).toBe("g6-capacity-attribution-a-r5");
	expect(f.campaignB.policy.workPlan.id).toBe("g6-capacity-ladder-b-r5");
	expect(f.campaignA.sourceSha).toBe(f.campaignB.sourceSha);
	expect(f.contract.objective).toMatchObject({
		aggregateBudgetMicrousd: 133_544_166,
		sealedPriorSpendMicrousd: 104_996_710,
		headroomMicrousd: 28_547_456,
	});
	expect(f.contract.ladder.profile).toMatchObject({
		datagramPump: "pump",
		udpSendBatch: 0,
		reflectRingBypass: "off",
	});
	expect(f.r5Decision).toMatchObject({
		status: "SELECTED",
		sendPath: "stock",
		probeInB: true,
		bGo: true,
		calibration: { disposition: "non-interference" },
	});
	const accepted = evaluateCapacityGoal(f);
	expect(accepted).toMatchObject({
		status: "PASS",
		liveTargetStatus: "PASS",
		exitCode: 0,
		reasons: [],
		r5: {
			sendPath: "stock",
			probeInB: true,
			calibrationDisposition: "non-interference",
			mechanismClaim: "detailed-probe",
			claims: [],
		},
	});

	// Decision differs from the independent A' recompute (re-signed bytes).
	for (const [key, value] of [
		["sendPath", "batch64"],
		["probeInB", false],
		["bWorkPlanId", "g6-capacity-ladder-b-r5-probe-off"],
		["calibrationDisposition", "interference"],
	] as const) {
		const restore = resignDecision(f, (decision) => {
			decision[key] = value;
		});
		refused(
			f,
			`decision ${key}`,
			`r5 decision ${key} differs from the A' recompute`,
		);
		restore();
	}
	// Forged mandatory disclosure and alternatives.
	for (const mutate of [
		(d: Row) => {
			(d.disclosure as Row).generatorSharesModifiedDriver = false;
		},
		(d: Row) => {
			d.alternatives = (d.alternatives as Row[]).slice(0, 2);
		},
	]) {
		const restore = resignDecision(f, mutate);
		refused(
			f,
			"decision disclosure/alternatives",
			/r5 decision|pre-registered alternative/,
		);
		restore();
	}
	// Unsigned decision edit: reviews no longer bind its bytes.
	let restore = tamper(
		f,
		f.decisionPath,
		json((d) => {
			d.selectionExplanation = "edited after review";
		}),
	);
	refused(
		f,
		"unsigned decision edit",
		"candidate review lacks unconditional exact source/decision approval",
	);
	restore();

	// Forged passing flag: raw ACK tail regresses under a stored PASS grade.
	restore = tamper(
		f,
		aCell(f, "Xoff-1"),
		json((scan) => {
			const report = client(scan);
			((report.windows as Row).steadyDrain as Row).rtt = (
				(
					client(
						JSON.parse(
							readFileSync(join(f.repoRoot, aCell(f, "A0-2")), "utf8"),
						),
					).windows as Row
				).steadyDrain as Row
			).rtt;
			scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
		}),
	);
	refused(f, "forged passing flag");
	restore();
	// Wrong A' order: two sealed cells swap places.
	const swap = (from: string, to: string) =>
		renameSync(
			join(f.repoRoot, aCell(f, from, "")),
			join(f.repoRoot, aCell(f, to, "")),
		);
	swap("Xon-1", "tmp-1");
	swap("Xoff-1", "Xon-1");
	swap("tmp-1", "Xoff-1");
	f.rehash();
	refused(f, "wrong A' order");
	swap("Xoff-1", "tmp-1");
	swap("Xon-1", "Xoff-1");
	swap("tmp-1", "Xon-1");
	f.rehash();
	// Mixed SHA within A'.
	restore = tamper(
		f,
		aCell(f, "Xon-2"),
		json((scan) => {
			scan.candidateSha = "f".repeat(40);
		}),
	);
	refused(f, "mixed source SHA");
	restore();
	// Mixed host: the contract pair differs from the bound B pair.
	restore = tamper(
		f,
		"evidence/b-pair.json",
		json((pair) => {
			(pair.generator as Row).bootId = "33333333-3333-4333-8333-333333333333";
		}),
	);
	refused(f, "mixed host");
	restore();
	// Missing datagramPump echo in a rated cell, and a contract without it.
	restore = tamper(
		f,
		bCell(f, "L40000-1"),
		json((scan) => {
			delete (scan.config as Row).datagramPump;
		}),
	);
	refused(f, "missing datagramPump echo");
	restore();
	restore = tamper(
		f,
		bCell(f, "L40000-1"),
		json((scan) => {
			const report = client(scan);
			delete report.datagramDriver;
			scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
		}),
	);
	refused(f, "missing generator datagram driver echo");
	restore();
	const { datagramPump: _pump, ...withoutPump } = f.contract.ladder.profile;
	restore = withContract(f, (c) => ({
		...c,
		ladder: { ...c.ladder, profile: withoutPump as typeof c.ladder.profile },
	}));
	refused(
		f,
		"contract without datagramPump",
		"contract ladder profile differs from the r5 decision",
	);
	restore();
	// Contract send path disagrees with the decision.
	restore = withContract(f, (c) => ({
		...c,
		ladder: { ...c.ladder, profile: { ...c.ladder.profile, udpSendBatch: 64 } },
	}));
	refused(f, "contract batch64 against stock decision");
	restore();
	// Missing companion, missing 40k repeat, local-green-only (no live ladder).
	for (const [label, ladder] of [
		[
			"missing companion",
			{
				...f.contract.ladder,
				companions: f.contract.ladder.companions?.slice(0, 1),
			},
		],
		[
			"missing 40k repeat",
			{
				...f.contract.ladder,
				runs: f.contract.ladder.runs.filter((run) => run.label !== "L40000-2"),
			},
		],
		["local-green-only", { ...f.contract.ladder, runs: [], companions: [] }],
	] as const) {
		restore = withContract(f, (c) => ({ ...c, ladder }));
		refused(f, label);
		restore();
	}
	// Byte tamper of the outer manifest and of B's final ledger (no rehash).
	restore = tamper(
		f,
		"evidence/outer-manifest.json",
		json((manifest) => {
			const entry = (manifest.entries as Row[]).find(
				(row) => row.path === "decision.json",
			) as Row;
			entry.sha256 = "0".repeat(64);
		}),
		false,
	);
	refused(f, "outer manifest digest tamper", "hash mismatch");
	restore();
	restore = tamper(
		f,
		`${f.campaignB.reference.runRoot}/terminal/final-spend-ledger.json`,
		(text) => `${text}\n`,
		false,
	);
	refused(f, "final ledger byte tamper");
	restore();
	restore = tamper(
		f,
		"evidence/prior/final-spend-ledger.json",
		json((ledger) => {
			((ledger as unknown as Row[])[0] as Row).totalAuthorizedMicrousd =
				104_996_709;
		}),
	);
	refused(f, "prior A08 ledger tamper", /prior spend ledger/);
	restore();
	expect(evaluateCapacityGoal(f)).toMatchObject({ exitCode: 0, reasons: [] });

	// The same real extracted cells drive the pure selection edges.
	const cells = requireCells(f);
	expect(() =>
		evaluateR5Attribution({
			cells: [cells[1], cells[0], ...cells.slice(2)] as typeof cells,
			expectedSourceSha: f.campaignA.sourceSha,
			batchOwnershipTestsPassed: true,
		}),
	).toThrow("expected Xon-1");
	expect(() =>
		evaluateR5Attribution({
			cells,
			expectedSourceSha: "f".repeat(40),
			batchOwnershipTestsPassed: true,
		}),
	).toThrow("source differs");
	expect(() =>
		evaluateR5Attribution({
			cells: cells.map((cell, index) =>
				index === 3 ? { ...cell, pairId: "other" } : cell,
			),
			expectedSourceSha: f.campaignA.sourceSha,
			batchOwnershipTestsPassed: true,
		}),
	).toThrow("different host pair");
	expect(() =>
		evaluateR5Attribution({
			cells: cells.map((cell, index) =>
				index === 1 ? { ...cell, datagramPump: "legacy" as const } : cell,
			),
			expectedSourceSha: f.campaignA.sourceSha,
			batchOwnershipTestsPassed: true,
		}),
	).toThrow("profile echo differs");
}, 1_200_000);

function requireCells(f: Fixture) {
	if (!f.r5Decision) throw Error("r5 fixture lacks its recompute");
	return f.r5Decision.cells.map(
		({
			arm: _arm,
			generatorUsPerOffered: _g,
			serverUsPerOffered: _s,
			...cell
		}) => cell,
	);
}

test("r5 probe-off B is accepted only with recorded interference, and the evaluator records no mechanism claim", async () => {
	const f = await build({ calibration: "interference" });
	expect(f.r5Decision).toMatchObject({
		status: "SELECTED",
		probeInB: false,
		calibration: { disposition: "interference" },
	});
	expect(f.campaignB.policy.workPlan.id).toBe(
		"g6-capacity-ladder-b-r5-probe-off",
	);
	expect(evaluateCapacityGoal(f)).toMatchObject({
		status: "PASS",
		exitCode: 0,
		reasons: [],
		r5: {
			probeInB: false,
			calibrationDisposition: "interference",
			mechanismClaim: "none",
			claims: [
				"no mechanism claim: B ran probe-off after A' recorded detailed-probe interference",
			],
		},
	});
}, 600_000);

test("r5 probe-off B without an interference disposition is refused", async () => {
	const f = await build({
		calibration: "non-interference",
		bPlanId: "g6-capacity-ladder-b-r5-probe-off",
		bProbe: false,
	});
	expect(f.r5Decision).toMatchObject({ probeInB: true });
	refused(
		f,
		"probe-off without interference",
		"r5 B work plan must be g6-capacity-ladder-b-r5",
	);
}, 600_000);

test("r5 batch64 selection requires the named batch ownership receipts", async () => {
	expect(R5_BATCH_OWNERSHIP_TESTS).toHaveLength(5);
	const f = await build({ sendPath: "batch64" });
	expect(f.r5Decision).toMatchObject({
		status: "SELECTED",
		sendPath: "batch64",
		bGo: true,
	});
	expect(evaluateCapacityGoal(f)).toMatchObject({
		exitCode: 0,
		reasons: [],
		r5: { sendPath: "batch64" },
	});
	const named = requireNamedTest();
	const restore = tamper(
		f,
		"evidence/local/candidate-local-native-0.stdout",
		(text) => text.replace(`test ${named} ... ok\n`, ""),
	);
	expect(
		batchOwnershipTestsPassed(
			readFileSync(
				join(f.repoRoot, "evidence/local/candidate-local-native-0.stdout"),
				"utf8",
			),
		),
	).toBe(false);
	refused(f, "batch64 without named ownership test");
	restore();
}, 600_000);
function requireNamedTest(): string {
	const name = R5_BATCH_OWNERSHIP_TESTS[0];
	if (!name) throw Error("missing named batch ownership test");
	return name;
}

test("r5 B present while A' parity fails (INCOMPLETE, bGo=false) is refused", async () => {
	const f = await build({ offeredMovesSkew: { "A0-2": 1.02 } });
	expect(f.r5Decision).toMatchObject({ status: "INCOMPLETE", bGo: false });
	expect(f.r5Decision?.reasons.join("\n")).toContain(
		"A0-2 offeredMoves parity",
	);
	refused(
		f,
		"B while bGo=false",
		"B exists although the A' decision is INCOMPLETE with bGo=false",
	);
}, 600_000);

test("r5 waiter safety requires the exact passing vendored wtransport datagram-pump gate (E3)", async () => {
	const ok = R5_VENDORED_WTRANSPORT_TESTS.map((name) => `test ${name} ... ok`);
	const summary =
		"test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out;";
	expect(vendoredWtransportTestsPassed([...ok, summary].join("\n"))).toBe(true);
	expect(vendoredWtransportTestsPassed(ok.join("\n"))).toBe(false);
	expect(
		vendoredWtransportTestsPassed([...ok.slice(1), summary].join("\n")),
	).toBe(false);
	expect(
		vendoredWtransportTestsPassed(
			[...ok, summary.replace("0 failed", "1 failed")].join("\n"),
		),
	).toBe(false);
	// A named pump test failed on the prepared host although the gate exited 0.
	const failed = [
		...ok.slice(0, 2),
		`test ${R5_VENDORED_WTRANSPORT_TESTS[2]} ... FAILED`,
		summary,
	].join("\n");
	const f = await build({ vendoredGateStdout: failed });
	refused(
		f,
		"failed named vendored test",
		"vendored wtransport gate lacks the named passing datagram-pump tests",
	);
	// Missing gate output (byte removal under a fresh outer manifest).
	const out = `${f.campaignB.reference.runRoot}/operations/gate-prepared-server-vendored-wtransport-tests/operation.stdout`;
	rmSync(join(f.repoRoot, out));
	f.rehash();
	const missing = refused(f, "missing vendored gate output");
	expect(missing.exitCode).toBe(2);
}, 600_000);

test("r5 a trailing XB INVALID (raw S5 session error) only removes batch64; a non-trailing-arm INVALID stays INCOMPLETE", async () => {
	const f = await completeGoalAdaptersFixture(processFixture().proof, {
		r5: {},
		aOutcomes: { "XB-1": "INVALID" },
	});
	roots.push(f.repoRoot);
	expect(f.campaignA.final.completed.map((row) => row.nodeId)).toEqual([
		"Xon-1",
		"Xoff-1",
		"A0-1",
		"A0-2",
		"Xoff-2",
		"Xon-2",
		"XB-1",
	]);
	expect(f.r5Decision).toMatchObject({
		status: "SELECTED",
		sendPath: "stock",
		bGo: true,
	});
	expect(evaluateCapacityGoal(f)).toMatchObject({
		status: "PASS",
		exitCode: 0,
		r5: { sendPath: "stock" },
	});
	// Sealed bytes of the INVALID cell stay manifest-covered; they are never
	// extracted (r5CellSummaries unit tests cover an absent raw cell).
	const restore = tamper(f, aCell(f, "XB-1"), () => "{not json");
	refused(f, "tampered sealed INVALID cell", /pre-sealed bytes changed/);
	restore();

	const g = await completeGoalAdaptersFixture(processFixture().proof, {
		r5: {},
		aOutcomes: { "A0-1": "INVALID" },
	});
	roots.push(g.repoRoot);
	expect(g.r5Decision).toMatchObject({ status: "INCOMPLETE", bGo: false });
	refused(
		g,
		"A0 INVALID with B present",
		/B exists although the A' decision is INCOMPLETE/,
	);
}, 600_000);

test("r5 B under a recorded user override (SELECTED, bGo=false) with 4 generator processes passes and is disclosed", async () => {
	// Recorded probe interference puts B on Xoff; an Xoff-2 S4 MISS (26 ms > 25)
	// keeps C-PUMP SELECTED (median Xoff ACK 18 ms < A0 20 ms) but sets bGo=false.
	const f = await completeGoalAdaptersFixture(processFixture().proof, {
		r5: {
			calibration: "interference",
			// XB keeps no 15% ACK edge over the raised Xoff median: stock B.
			ackMs: { "Xoff-2": 26, "XB-1": 17, "XB-2": 17 },
			bClientProcesses: 4,
			bOverride: true,
		},
		aOutcomes: { "Xoff-2": "MISS" },
	});
	roots.push(f.repoRoot);
	expect(f.r5Decision).toMatchObject({
		status: "SELECTED",
		sendPath: "stock",
		probeInB: false,
		calibration: { disposition: "interference" },
		bGo: false,
	});
	// The override keeps the E2 probe-off plan for the recorded interference.
	expect(f.campaignB.policy.workPlan.id).toBe(
		"g6-capacity-ladder-b-r5-probe-off",
	);
	expect(f.campaignB.policy.workProfiles.candidate).toMatchObject({
		clientProcesses: 4,
	});
	expect(f.contract.ladder.profile).toMatchObject({ clientProcesses: 4 });
	const accepted = evaluateCapacityGoal(f);
	expect(accepted).toMatchObject({
		status: "PASS",
		exitCode: 0,
		reasons: [],
		r5: {
			sendPath: "stock",
			probeInB: false,
			mechanismClaim: "none",
			bOverride: {
				authorityPath: "evidence/b-override-authority.txt",
				generatorProcesses: 4,
			},
		},
	});
	expect(accepted.r5?.claims.join("\n")).toContain(
		"recorded user override of A' bGo=false with 4 generator processes",
	);
	// The authority bytes must hash to the recorded digest.
	let restore = tamper(
		f,
		"evidence/b-override-authority.txt",
		(text) => `${text}edited\n`,
	);
	refused(f, "edited override authority", /authority bytes differ/);
	restore();
	// Without the override record, bGo=false still forbids B.
	restore = resignDecision(f, (decision) => {
		delete decision.bOverride;
	});
	refused(
		f,
		"B without override",
		"B exists although the A' decision is SELECTED with bGo=false",
	);
	restore();
	// The override's process count must be the one B actually ran.
	restore = resignDecision(f, (decision) => {
		(decision.bOverride as Row).generatorProcesses = 2;
	});
	refused(f, "override count differs from B", /r5 B candidate profile differs/);
	restore();
	// A merged client report covering fewer processes is refused.
	restore = tamper(
		f,
		bCell(f, "L40000-1"),
		json((scan) => {
			const report = client(scan);
			report.clientProcesses = 3;
			scan.clientStdout = `mmo-client: json ${JSON.stringify(report)}\n`;
		}),
	);
	refused(f, "merged report count differs");
	restore();
	expect(evaluateCapacityGoal(f).exitCode).toBe(0);
}, 900_000);

test("r5 B with clientProcesses but no recorded override is refused", async () => {
	const f = await build({ bClientProcesses: 4 });
	expect(f.r5Decision).toMatchObject({ status: "SELECTED", bGo: true });
	refused(f, "unrecorded fan-out", /r5 B candidate profile differs/);
}, 600_000);
