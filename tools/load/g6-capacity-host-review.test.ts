import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifiedBoundFreeze } from "./g6-c32-freeze.ts";
import * as freezeModule from "./g6-c32-freeze.ts";
import { canonicalArtifactSha256 } from "./g6-c32-freeze-model.ts";
import type {
	CapacityHostReviewContext,
	CapacityHostReviewRecord,
} from "./g6-capacity-host-review.ts";

const module = await import("./g6-capacity-host-review.ts").catch(() => null);

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function api() {
	expect(module?.contextFromBound).toBeFunction();
	expect(module?.validateCapacityHostReviews).toBeFunction();
	expect(module?.verifyCapacityHostReviews).toBeFunction();
	expect(module?.runCapacityHostReviewCli).toBeFunction();
	return module as NonNullable<typeof module>;
}

function sha(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function context(): CapacityHostReviewContext {
	return {
		runId: "g6-review-run",
		semanticFreezeAuthoritySha256: "1".repeat(64),
		hostBindingArtifactSha256: "2".repeat(64),
		dispatchFreezeArtifactSha256: "3".repeat(64),
		boundAt: "2026-09-05T10:00:00.000Z",
	};
}

function architectRecord(
	reviewNoteSha256: string,
	reviewContext: CapacityHostReviewContext = context(),
): CapacityHostReviewRecord {
	return {
		schema: "g6-capacity-host-review/1",
		context: reviewContext,
		role: "architect",
		verdict: "APPROVE",
		unconditional: true as const,
		reviewedAt: "2026-09-05T10:00:01.000Z",
		afterArchitectArtifactSha256: null,
		reviewNoteSha256,
	};
}

function criticRecord(
	architect: unknown,
	reviewNoteSha256: string,
	reviewContext: CapacityHostReviewContext = context(),
): CapacityHostReviewRecord {
	return {
		schema: "g6-capacity-host-review/1",
		context: reviewContext,
		role: "critic",
		verdict: "APPROVE",
		unconditional: true as const,
		reviewedAt: "2026-09-05T10:00:02.000Z",
		afterArchitectArtifactSha256: canonicalArtifactSha256(architect),
		reviewNoteSha256,
	};
}

function fixture() {
	const reviewRoot = mkdtempSync(join(tmpdir(), "g6-host-review-"));
	roots.push(reviewRoot);
	return reviewRoot;
}

test("contextFromBound and validateCapacityHostReviews accept the exact approved review pair", () => {
	const bound: Pick<
		VerifiedBoundFreeze,
		"runId" | "root" | "semanticFreeze" | "hostBinding" | "dispatchFreeze"
	> = {
		runId: "g6-review-run",
		root: fixture(),
		semanticFreeze: { authoritySha256: "1".repeat(64) } as never,
		hostBinding: {
			envelope: { recordedAt: "2026-09-05T09:59:59.000Z" },
		} as never,
		dispatchFreeze: {
			envelope: { recordedAt: "2026-09-05T10:00:00.000Z" },
			authoritySha256: "3".repeat(64),
		} as never,
	};

	const reviewContext = api().contextFromBound(bound);
	expect(reviewContext).toEqual({
		runId: "g6-review-run",
		semanticFreezeAuthoritySha256: "1".repeat(64),
		hostBindingArtifactSha256: canonicalArtifactSha256(bound.hostBinding),
		dispatchFreezeArtifactSha256: canonicalArtifactSha256(bound.dispatchFreeze),
		boundAt: "2026-09-05T10:00:00.000Z",
	});

	const architect = architectRecord(sha("architect notes\n"), reviewContext);
	const critic = criticRecord(architect, sha("critic notes\n"), reviewContext);

	expect(
		api().validateCapacityHostReviews({
			context: reviewContext,
			architect,
			critic,
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			now: "2026-09-05T10:00:03.000Z",
		}),
	).toEqual({
		context: reviewContext,
		architect,
		critic,
	});
});

test("validateCapacityHostReviews rejects a critic review that is not strictly after the architect review", () => {
	const reviewContext = context();
	const architect = architectRecord(sha("architect notes\n"));
	const critic = {
		...criticRecord(architect, sha("critic notes\n")),
		reviewedAt: architect.reviewedAt,
	};

	expect(() =>
		api().validateCapacityHostReviews({
			context: reviewContext,
			architect,
			critic,
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			now: "2026-09-05T10:00:03.000Z",
		}),
	).toThrow(/strictly after/);
});

test("verifyCapacityHostReviews reads the fixed files and rejects a symlinked review file", () => {
	const reviewRoot = fixture();
	const reviewContext = context();
	const architect = architectRecord(sha("architect notes\n"), reviewContext);
	const critic = criticRecord(architect, sha("critic notes\n"), reviewContext);
	writeFileSync(join(reviewRoot, "architect.json"), JSON.stringify(architect));
	writeFileSync(join(reviewRoot, "critic.json"), JSON.stringify(critic));
	writeFileSync(join(reviewRoot, "architect.md"), "architect notes\n");
	writeFileSync(join(reviewRoot, "critic.md"), "critic notes\n");

	const calls: string[] = [];
	const result = api().verifyCapacityHostReviews({
		reviewRoot,
		context: context(),
		now: "2026-09-05T10:00:03.000Z",
		read: (absolutePath) => {
			calls.push(absolutePath);
			return readFileSync(absolutePath);
		},
	});
	expect(result.critic.afterArchitectArtifactSha256).toBe(
		canonicalArtifactSha256(architect),
	);
	expect(calls).toEqual([
		join(realpathSync(reviewRoot), "architect.json"),
		join(realpathSync(reviewRoot), "critic.json"),
		join(realpathSync(reviewRoot), "architect.md"),
		join(realpathSync(reviewRoot), "critic.md"),
	]);

	rmSync(join(reviewRoot, "critic.md"));
	symlinkSync("architect.md", join(reviewRoot, "critic.md"));
	expect(() =>
		api().verifyCapacityHostReviews({
			reviewRoot,
			context: context(),
			now: "2026-09-05T10:00:03.000Z",
		}),
	).toThrow(/symlink/i);
});

test("verifyCapacityHostReviews rejects an oversized review note", () => {
	const reviewRoot = fixture();
	const reviewContext = context();
	const architect = architectRecord(sha("architect notes\n"), reviewContext);
	const critic = criticRecord(architect, sha("critic notes\n"), reviewContext);
	writeFileSync(join(reviewRoot, "architect.json"), JSON.stringify(architect));
	writeFileSync(join(reviewRoot, "critic.json"), JSON.stringify(critic));
	writeFileSync(join(reviewRoot, "architect.md"), "architect notes\n");
	writeFileSync(join(reviewRoot, "critic.md"), "critic notes\n");

	expect(() =>
		api().verifyCapacityHostReviews({
			reviewRoot,
			context: reviewContext,
			now: "2026-09-05T10:00:03.000Z",
			read: (absolutePath) => {
				if (absolutePath.endsWith("critic.md")) {
					return Buffer.alloc(1024 * 1024 + 1, 99);
				}
				return readFileSync(absolutePath);
			},
		}),
	).toThrow(/too large/i);
});

test("verifyCapacityHostReviews rejects invalid UTF-8 review note bytes", () => {
	const reviewRoot = fixture();
	const reviewContext = context();
	const architect = architectRecord(sha("architect notes\n"), reviewContext);
	const critic = criticRecord(architect, sha("critic notes\n"), reviewContext);
	writeFileSync(join(reviewRoot, "architect.json"), JSON.stringify(architect));
	writeFileSync(join(reviewRoot, "critic.json"), JSON.stringify(critic));
	writeFileSync(join(reviewRoot, "architect.md"), "architect notes\n");
	writeFileSync(join(reviewRoot, "critic.md"), "critic notes\n");

	expect(() =>
		api().verifyCapacityHostReviews({
			reviewRoot,
			context: reviewContext,
			now: "2026-09-05T10:00:03.000Z",
			read: (absolutePath) => {
				if (absolutePath.endsWith("critic.md")) {
					return Buffer.from([0xc3, 0x28]);
				}
				return readFileSync(absolutePath);
			},
		}),
	).toThrow(/UTF-8/i);
});

test("validateCapacityHostReviews rejects strict negative review cases", () => {
	const reviewContext = context();
	const architect = architectRecord(sha("architect notes\n"), reviewContext);
	const critic = criticRecord(architect, sha("critic notes\n"), reviewContext);
	const now = "2026-09-05T10:00:03.000Z";
	const cases = [
		{
			name: "unknown fields",
			architect: { ...architect, extra: true },
			critic,
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			pattern: /missing or unknown fields/,
		},
		{
			name: "missing fields",
			architect,
			critic: (() => {
				const { verdict: _verdict, ...rest } = critic;
				return rest;
			})(),
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			pattern: /missing or unknown fields/,
		},
		{
			name: "wrong role",
			architect: { ...architect, role: "critic" },
			critic,
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			pattern: /role must be architect/,
		},
		{
			name: "wrong context",
			architect,
			critic: {
				...critic,
				context: { ...reviewContext, boundAt: "2026-09-05T09:59:59.000Z" },
			},
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			pattern: /does not match the exact host-review context/,
		},
		{
			name: "wrong digests",
			architect: { ...architect, reviewNoteSha256: sha("wrong\n") },
			critic,
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			pattern: /architect review note digest does not match/,
		},
		{
			name: "conditional false",
			architect: { ...architect, unconditional: false },
			critic,
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			pattern: /unconditional must be true/,
		},
		{
			name: "stale before bound",
			architect: { ...architect, reviewedAt: "2026-09-05T09:59:59.000Z" },
			critic,
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			pattern: /must not precede context\.boundAt/,
		},
		{
			name: "future review",
			architect,
			critic: { ...critic, reviewedAt: "2026-09-05T10:00:04.000Z" },
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			pattern: /must not be in the future/,
		},
		{
			name: "wrong architect chain",
			architect,
			critic: {
				...critic,
				afterArchitectArtifactSha256: sha("wrong-chain\n"),
			},
			architectNote: "architect notes\n",
			criticNote: "critic notes\n",
			pattern: /chain after the exact architect review artifact/,
		},
		{
			name: "altered note",
			architect,
			critic,
			architectNote: "architect changed\n",
			criticNote: "critic notes\n",
			pattern: /architect review note digest does not match/,
		},
		{
			name: "empty note",
			architect,
			critic,
			architectNote: "",
			criticNote: "critic notes\n",
			pattern: /nonempty text/,
		},
	] as const;

	for (const testCase of cases) {
		expect(() =>
			api().validateCapacityHostReviews({
				context: reviewContext,
				architect: testCase.architect,
				critic: testCase.critic,
				architectNote: testCase.architectNote,
				criticNote: testCase.criticNote,
				now,
			}),
		).toThrow(testCase.pattern);
	}
});

test("verify CLI binds the current verified freeze before review validation", () => {
	const reviewRoot = fixture();
	const boundRoot = join(reviewRoot, "bound");
	mkdirSync(boundRoot);
	const freeze = {
		runId: "g6-review-run",
		root: boundRoot,
		shellEnvironment: "bun",
		semanticFreeze: {
			authoritySha256: "1".repeat(64),
			authority: {
				controller: { path: "controller.ts" },
				budgetPolicy: { path: "policy.json" },
			},
		},
		hostBinding: {
			envelope: { recordedAt: "2026-09-05T10:00:00.000Z" },
			authoritySha256: "2".repeat(64),
		},
		dispatchFreeze: {
			envelope: { recordedAt: "2026-09-05T10:00:00.000Z" },
			authoritySha256: "3".repeat(64),
		},
	} as unknown as VerifiedBoundFreeze;
	const reviewContext = api().contextFromBound(freeze);
	const architect = architectRecord(sha("architect\n"), reviewContext);
	const critic = criticRecord(architect, sha("critic\n"), reviewContext);
	writeFileSync(join(reviewRoot, "architect.json"), JSON.stringify(architect));
	writeFileSync(join(reviewRoot, "critic.json"), JSON.stringify(critic));
	writeFileSync(join(reviewRoot, "architect.md"), "architect\n");
	writeFileSync(join(reviewRoot, "critic.md"), "critic\n");

	const verifyBoundFreeze = spyOn(
		freezeModule,
		"verifyBoundFreeze",
	).mockReturnValue(freeze);
	try {
		const result = api().runCapacityHostReviewCli(
			[
				"verify",
				"--bound-root",
				boundRoot,
				"--review-root",
				reviewRoot,
				"--repository",
				reviewRoot,
			],
			{ now: () => "2026-09-05T10:00:03.000Z" },
		);
		expect(result.context).toEqual(reviewContext);
		expect(verifyBoundFreeze).toHaveBeenCalledWith(boundRoot, {
			repositoryPath: reviewRoot,
			expectedStatus: "BOUND",
		});
	} finally {
		verifyBoundFreeze.mockRestore();
	}
});
