import { describe, expect, test } from "bun:test";

import {
	buildRunArtifact,
	trustContextForArtifact,
} from "./artifact-builder.ts";
import { classifyVerdictTuple, sealRunArtifact } from "./evidence.ts";
import { verifyRunArtifact } from "./verify-artifact.ts";

function artifactInput(
	overrides: Record<string, unknown> = {},
): Parameters<typeof buildRunArtifact>[0] {
	return {
		comparisonId: "r1-verdict-wiring",
		runId: "measured/chat-fanout/subscribers-1000/ws/rep-01",
		cellId: "chat-fanout/subscribers-1000",
		transport: "ws",
		seed: 20260824,
		repetitionIndex: 1,
		totalRepetitions: 5,
		samples: [10, 12, 14],
		percentiles: { p50: 12, p95: 13.8, p99: 13.96 },
		ledger: {
			attempted: 3,
			queued: 3,
			serverObserved: 3,
			acknowledged: 3,
			delivered: 3,
			dropped: 0,
		},
		...overrides,
	} as Parameters<typeof buildRunArtifact>[0];
}

describe("R1 verdict wiring: the matrix decides promotability", () => {
	test("a PASS/PASS artifact is promotable", () => {
		const artifact = buildRunArtifact(artifactInput());
		expect(artifact.evidenceStatus).toBe("PASS");
		expect(artifact.scenarioVerdict).toBe("PASS");
		expect(artifact.promotable).toBe(true);
	});

	// The builder used to hardcode promotable:true alongside the tuple, so a MISS
	// arrived stamped as promotable. Promotability now comes from the matrix.
	test("a PASS/MISS artifact keeps its numbers but is not promotable", () => {
		const artifact = buildRunArtifact(
			artifactInput({ evidenceStatus: "PASS", scenarioVerdict: "MISS" }),
		);
		expect(artifact.scenarioVerdict).toBe("MISS");
		expect(artifact.promotable).toBe(false);
		expect(artifact.metrics).toBeDefined();
	});

	for (const [evidenceStatus, scenarioVerdict] of [
		["PASS", "NO_VERDICT"],
		["FAIL", "MISS"],
		["FAIL", "PASS"],
		["BLOCKED", "PASS"],
		["BLOCKED", "MISS"],
	] as const) {
		test(`a ${evidenceStatus}/${scenarioVerdict} artifact cannot be built at all`, () => {
			expect(() =>
				buildRunArtifact(artifactInput({ evidenceStatus, scenarioVerdict })),
			).toThrow(/VERDICT_TUPLE_CONTRADICTION/);
			expect(classifyVerdictTuple({ evidenceStatus, scenarioVerdict })).toEqual(
				{ ok: false, code: "VERDICT_TUPLE_CONTRADICTION" },
			);
		});
	}

	// F5: the overlay used to be stamped "primary" by the builder, which made it
	// indistinguishable from the arm it shadows and defeated overlay exclusion.
	test("an overlay artifact is built and verified as an overlay", () => {
		const overlay = buildRunArtifact(
			artifactInput({
				runId: "measured/chat-fanout/subscribers-1000/ws-overlay/rep-01",
				armKind: "overlay",
			}),
		);
		expect(overlay.armKind).toBe("overlay");

		const verification = verifyRunArtifact(
			sealRunArtifact(overlay),
			trustContextForArtifact(overlay),
		);
		expect(verification.evidenceStatus).toBe("PASS");
		expect(verification.rejections).toEqual([]);
	});

	test("a primary artifact still defaults to the primary arm kind", () => {
		expect(buildRunArtifact(artifactInput()).armKind).toBe("primary");
	});

	test("an unrecognized arm kind is refused by the verifier", () => {
		const artifact = buildRunArtifact(artifactInput());
		const tampered = sealRunArtifact({
			...artifact,
			armKind: "ws-overlay",
		} as never);
		const verification = verifyRunArtifact(
			tampered,
			trustContextForArtifact(artifact),
		);
		expect(verification.evidenceStatus).not.toBe("PASS");
		expect(verification.rejections.map(({ code }) => code)).toContain(
			"SCHEMA_INVALID_FIELD",
		);
	});
});
