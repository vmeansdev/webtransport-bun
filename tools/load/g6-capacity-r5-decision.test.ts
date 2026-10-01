import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { R5Decision } from "./g6-capacity-attribution-r5.ts";
import { CAPACITY_NATIVE_PROOF_TESTS } from "./g6-capacity-proof-catalog.ts";
import {
	batchOwnershipTestsPassed,
	expectedR5DecisionFields,
	expectedR5LadderPlanId,
	R5_BATCH_OWNERSHIP_TESTS,
	R5_CANDIDATE_DECISION_SCHEMA,
	R5_DECISION_ALTERNATIVES,
	validateR5CandidateDecision,
} from "./g6-capacity-r5-decision.ts";

const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
function decision(overrides: Partial<R5Decision> = {}): R5Decision {
	return {
		schema: "g6-capacity-attribution-r5-decision/1",
		status: "SELECTED",
		reasons: [],
		cells: [],
		medians: { Xon: null, Xoff: null, A0: null, XB: null },
		calibration: {
			disposition: "non-interference",
			serverCpuShift: 0,
			ackP99Shift: 0,
		},
		candidate: "C-PUMP",
		sendPath: "stock",
		probeInB: true,
		bGo: true,
		bGoReasons: [],
		disclosure: {
			generatorCpuDeltaPct: -25,
			serverCpuDeltaPct: 0,
			generatorSharesModifiedDriver: true,
			resultScope: "server+generator pair with C-PUMP",
			serverOnlyClaimLimitedToMeasuredDelta: true,
		},
		...overrides,
	};
}
const aDigests = { attributionArtifactSha256: "a".repeat(64) };
function record(recomputed: R5Decision, edit: Record<string, unknown> = {}) {
	return {
		schema: R5_CANDIDATE_DECISION_SCHEMA,
		recordedAt: "2026-10-02T00:00:00.000Z",
		sourceSha: "c".repeat(40),
		aDigests,
		...expectedR5DecisionFields(recomputed),
		scopeStatement: "Peer-hint arm excluded; B runs reflectRingBypass off.",
		alternatives: R5_DECISION_ALTERNATIVES.map((id) => ({
			id,
			explanation: `Synthetic ${id}`,
			evidencePaths: ["a/work/Xoff-1/g6-sharded-scan.json"],
			files: ["vendor/wtransport/src/driver/mod.rs"],
			tests: ["tools/load/g6-capacity-r5-decision.test.ts"],
		})),
		selectionExplanation: "Mechanical pre-registered rule.",
		...edit,
	};
}
function validate(
	recomputed: R5Decision,
	edit: Record<string, unknown> = {},
	bCreateAt: string | null = "2026-10-03T00:00:00.000Z",
) {
	const bytes = JSON.stringify(record(recomputed, edit));
	const bound: unknown[] = [];
	const result = validateR5CandidateDecision({
		decisionBytes: bytes,
		architect: "architect",
		critic: "critic",
		recomputed,
		expected: {
			sourceSha: "c".repeat(40),
			aDigests,
			aSealedAt: "2026-10-01T00:00:00.000Z",
			bCreateAt,
		},
		readEvidence: () => Buffer.from(""),
		validateReviews: (_reviews, value) => bound.push(value),
	});
	expect(bound).toEqual([
		{
			sourceSha: "c".repeat(40),
			decisionSha256: sha(bytes),
			decisionRecordedAt: "2026-10-02T00:00:00.000Z",
			bCreateAt,
		},
	]);
	return result;
}

test("r5 named batch ownership tests are required native proof tests", () => {
	for (const name of R5_BATCH_OWNERSHIP_TESTS)
		expect(CAPACITY_NATIVE_PROOF_TESTS).toContain(name);
	const all = R5_BATCH_OWNERSHIP_TESTS.map((name) => `test ${name} ... ok`);
	expect(batchOwnershipTestsPassed(all.join("\n"))).toBe(true);
	expect(batchOwnershipTestsPassed(all.slice(1).join("\n"))).toBe(false);
	expect(
		batchOwnershipTestsPassed(all.join("\n").replace(" ... ok", " ... FAILED")),
	).toBe(false);
});

test("r5 B plan id follows the probe disposition only", () => {
	expect(expectedR5LadderPlanId(true)).toBe("g6-capacity-ladder-b-r5");
	expect(expectedR5LadderPlanId(false)).toBe(
		"g6-capacity-ladder-b-r5-probe-off",
	);
	expect(expectedR5DecisionFields(decision())).toMatchObject({
		selectedAlternativeId: "C-PUMP+stock",
		bWorkPlanId: "g6-capacity-ladder-b-r5",
	});
	expect(
		expectedR5DecisionFields(
			decision({
				probeInB: false,
				sendPath: "batch64",
				calibration: {
					disposition: "interference",
					serverCpuShift: 0.1,
					ackP99Shift: 0,
				},
			}),
		),
	).toMatchObject({
		selectedAlternativeId: "C-PUMP+batch64",
		bWorkPlanId: "g6-capacity-ladder-b-r5-probe-off",
	});
	for (const status of ["NO_CANDIDATE", "INCOMPLETE"] as const)
		expect(
			expectedR5DecisionFields(
				decision({
					status,
					candidate: null,
					sendPath: null,
					probeInB: null,
					bGo: false,
				}),
			),
		).toMatchObject({ selectedAlternativeId: "none", bWorkPlanId: null });
	expect(
		expectedR5DecisionFields(decision({ bGo: false, bGoReasons: ["x"] })),
	).toMatchObject({ selectedAlternativeId: "C-PUMP+stock", bWorkPlanId: null });
});

test("r5 decision record must equal the recompute, the window and the pre-registered alternatives", () => {
	expect(validate(decision()).selectedAlternativeId).toBe("C-PUMP+stock");
	// A NO_CANDIDATE record is still a valid reviewed record (no B follows).
	const none = decision({
		status: "NO_CANDIDATE",
		candidate: null,
		sendPath: null,
		probeInB: null,
		bGo: false,
	});
	expect(validate(none, {}, null).bWorkPlanId).toBeNull();
	for (const [edit, message] of [
		[{ status: "NO_CANDIDATE" }, "status differs from the A' recompute"],
		[{ bGo: false }, "bGo differs from the A' recompute"],
		[{ sendPath: "batch64" }, "sendPath differs"],
		[{ probeInB: false }, "probeInB differs"],
		[
			{ attributionArtifactSha256: "0".repeat(64) },
			"attributionArtifactSha256",
		],
		[{ selectedAlternativeId: "none" }, "selectedAlternativeId differs"],
		[
			{ disclosure: { ...decision().disclosure, resultScope: "server alone" } },
			"disclosure differs",
		],
		[{ recordedAt: "2026-10-01T00:00:00.000Z" }, "must follow A' terminal"],
		[{ recordedAt: "2026-10-03T00:00:00.000Z" }, "precede B creation"],
		[{ sourceSha: "d".repeat(40) }, "schema/source binding"],
		[{ aDigests: { attributionArtifactSha256: "b".repeat(64) } }, "A' digests"],
		[{ scopeStatement: " " }, "scope statement"],
		[
			{
				alternatives: record(decision()).alternatives.slice(0, 2),
			},
			"every pre-registered alternative",
		],
		[
			{
				alternatives: record(decision()).alternatives.map((row, index) =>
					index === 2 ? { ...row, id: "C-PUMP+stock" } : row,
				),
			},
			"pre-registered set",
		],
		[{ extra: true }, "missing or unknown fields"],
	] as const)
		expect(() => validate(decision(), edit)).toThrow(message);
});
