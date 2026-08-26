import { describe, expect, test } from "bun:test";

import {
	classifyVerdictTuple,
	comparisonErrorCode,
	sha256HexOfBytes,
} from "./evidence.ts";
import {
	R1_CAMPAIGN_AUTHORITY_BYTES,
	R1_CAMPAIGN_AUTHORITY_SHA256 as FROZEN_AUTHORITY_SHA256,
	R1_CAMPAIGN_LOCK_BYTES,
	R1_CAMPAIGN_MANIFEST_V1_BYTES,
} from "./r1-fixtures.ts";
import {
	parseCampaignArgs,
	R1_CAMPAIGN_AUTHORITY_SHA256,
	runOfficialEntrypointFlow,
} from "./run-campaign.ts";
import { parseVerifyArgs } from "./verify-artifact.ts";

const HEX64 = "a".repeat(64);

function bootstrapFor(
	authorityBytes: Uint8Array = R1_CAMPAIGN_AUTHORITY_BYTES,
): (name: string) => Promise<Uint8Array> {
	const table = new Map<string, Uint8Array>([
		["authority", authorityBytes],
		["campaign-lock", R1_CAMPAIGN_LOCK_BYTES],
		["manifest", R1_CAMPAIGN_MANIFEST_V1_BYTES],
	]);
	return async (name: string) => {
		const bytes = table.get(name);
		if (bytes === undefined) throw new Error(`unexpected read: ${name}`);
		return bytes;
	};
}

function flowInput(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		fixtureOnly: true,
		authority: {
			bytes: R1_CAMPAIGN_AUTHORITY_BYTES,
			digest: R1_CAMPAIGN_AUTHORITY_SHA256,
		},
		load: { readBootstrap: bootstrapFor() },
		verify: {
			lock: () => ({ ok: true }),
			manifest: () => ({ ok: true }),
		},
		promotion: {
			promote: () => ({ ok: true, promoted: false }),
			renderReport: () => ({ ok: true }),
		},
		...overrides,
	};
}

async function captureCode(call: () => Promise<unknown>): Promise<string> {
	try {
		await call();
	} catch (error: unknown) {
		return comparisonErrorCode(error);
	}
	throw new Error("expected the flow to refuse, but it resolved");
}

describe("R1 flow hardening: seam trust", () => {
	test("the pinned authority digest has not drifted from the frozen fixture", () => {
		expect(R1_CAMPAIGN_AUTHORITY_SHA256).toBe(FROZEN_AUTHORITY_SHA256);
		expect(sha256HexOfBytes(R1_CAMPAIGN_AUTHORITY_BYTES)).toBe(
			R1_CAMPAIGN_AUTHORITY_SHA256,
		);
	});

	// H1: a seam that answers with anything other than the boolean true is a
	// seam that did not pass.
	for (const truthy of ["yes", 1, {}, [], "false"] as const) {
		test(`a lock seam returning ok=${JSON.stringify(truthy)} does not promote`, async () => {
			expect(
				await captureCode(() =>
					runOfficialEntrypointFlow(
						flowInput({
							verify: {
								lock: () => ({ ok: truthy }),
								manifest: () => ({ ok: true }),
							},
						}) as never,
					),
				),
			).toBe("CAMPAIGN_LOCK_INVALID");
		});

		test(`a promote seam returning ok=${JSON.stringify(truthy)} does not promote`, async () => {
			expect(
				await captureCode(() =>
					runOfficialEntrypointFlow(
						flowInput({
							promotion: {
								promote: () => ({ ok: truthy, promoted: true }),
								renderReport: () => ({ ok: true }),
							},
						}) as never,
					),
				),
			).toBe("PROMOTION_REJECTED");
		});
	}

	// H2: the report is the last and least trusted step. It cannot stamp a
	// verdict tuple, or promotability, onto the authoritative envelope.
	test("a report seam cannot stamp a contradictory verdict tuple onto the envelope", async () => {
		expect(
			await captureCode(() =>
				runOfficialEntrypointFlow(
					flowInput({
						promotion: {
							promote: () => ({ ok: true, promoted: false }),
							renderReport: () => ({
								ok: true,
								evidenceStatus: "FAIL",
								scenarioVerdict: "PASS",
								promotable: true,
							}),
						},
					}) as never,
				),
			),
		).toBe("VERDICT_TUPLE_CONTRADICTION");
	});

	test("a report seam cannot smuggle promotable into the envelope", async () => {
		const result = await runOfficialEntrypointFlow(
			flowInput({
				promotion: {
					promote: () => ({ ok: true, promoted: false }),
					renderReport: () => ({
						ok: true,
						promotable: true,
						promoted: true,
						manifestSha256: "0".repeat(64),
					}),
				},
			}) as never,
		);
		expect(result.promotable).toBe(false);
		expect(result.promoted).toBe(false);
		expect(result.manifestSha256).toBe(
			sha256HexOfBytes(R1_CAMPAIGN_MANIFEST_V1_BYTES),
		);
	});

	test("a promoted PASS/PASS campaign is promotable and keeps its own manifest digest", async () => {
		const result = await runOfficialEntrypointFlow(
			flowInput({
				promotion: {
					promote: () => ({
						ok: true,
						promoted: true,
						evidenceStatus: "PASS",
						scenarioVerdict: "PASS",
					}),
					renderReport: () => ({ ok: true }),
				},
			}) as never,
		);
		expect(result).toEqual(
			expect.objectContaining({
				ok: true,
				promoted: true,
				promotable: true,
				evidenceStatus: "PASS",
				scenarioVerdict: "PASS",
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		);
	});

	test("a PASS/MISS campaign is visible but never promotable", async () => {
		const result = await runOfficialEntrypointFlow(
			flowInput({
				promotion: {
					promote: () => ({
						ok: true,
						promoted: true,
						evidenceStatus: "PASS",
						scenarioVerdict: "MISS",
					}),
					renderReport: () => ({ ok: true }),
				},
			}) as never,
		);
		expect(result.promotable).toBe(false);
		expect(
			classifyVerdictTuple({
				evidenceStatus: "PASS",
				scenarioVerdict: "MISS",
			}),
		).toEqual(expect.objectContaining({ ok: true, numericDataVisible: true }));
	});

	// H3: an authority record carrying its own honest digest proves nothing.
	test("forged authority bytes with an honest self-digest are refused", async () => {
		const forged = new TextEncoder().encode('{"schema":"forged"}');
		const honestDigest = sha256HexOfBytes(forged);
		expect(honestDigest).not.toBe(R1_CAMPAIGN_AUTHORITY_SHA256);
		expect(
			await captureCode(() =>
				runOfficialEntrypointFlow(
					flowInput({
						authority: { bytes: forged, digest: honestDigest },
						load: { readBootstrap: bootstrapFor(forged) },
					}) as never,
				),
			),
		).toBe("TRUST_AUTHORITY_UNPINNED");
	});

	test("declared authority bytes that do not hash to the pinned digest are refused", async () => {
		expect(
			await captureCode(() =>
				runOfficialEntrypointFlow(
					flowInput({
						authority: {
							bytes: new TextEncoder().encode("not the authority"),
							digest: R1_CAMPAIGN_AUTHORITY_SHA256,
						},
					}) as never,
				),
			),
		).toBe("TRUST_AUTHORITY_BYTES_MISMATCH");
	});

	test("read authority bytes that do not hash to the pinned digest are refused", async () => {
		expect(
			await captureCode(() =>
				runOfficialEntrypointFlow(
					flowInput({
						load: {
							readBootstrap: bootstrapFor(
								new TextEncoder().encode("substituted at read time"),
							),
						},
					}) as never,
				),
			),
		).toBe("TRUST_AUTHORITY_DIGEST_MISMATCH");
	});

	// H5: a seam that throws must not leak the path it was reading.
	test("a throwing seam is normalized to a typed code and leaks no path", async () => {
		const secret = "/private/official/staging/capabilities/campaign-r1.cap";
		for (const [overrides, expected] of [
			[
				{
					load: {
						readBootstrap: async () => {
							throw new Error(`ENOENT: ${secret}`);
						},
					},
				},
				"TRUST_AUTHORITY_READ_FAILED",
			],
			[
				{
					verify: {
						lock: () => {
							throw new Error(`bad lock at ${secret}`);
						},
						manifest: () => ({ ok: true }),
					},
				},
				"CAMPAIGN_LOCK_INVALID",
			],
			[
				{
					promotion: {
						promote: () => {
							throw new Error(`cannot promote ${secret}`);
						},
						renderReport: () => ({ ok: true }),
					},
				},
				"PROMOTION_REJECTED",
			],
			[
				{
					promotion: {
						promote: () => ({ ok: true, promoted: false }),
						renderReport: () => {
							throw new Error(`cannot render ${secret}`);
						},
					},
				},
				"REPORT_REJECTED",
			],
		] as const) {
			let thrown: unknown;
			try {
				await runOfficialEntrypointFlow(flowInput(overrides) as never);
			} catch (error: unknown) {
				thrown = error;
			}
			expect(comparisonErrorCode(thrown)).toBe(expected);
			expect((thrown as Error).message).not.toContain(secret);
			expect(String((thrown as Error).stack ?? "")).not.toContain(secret);
		}
	});

	test("an untyped error never reports anything but an opaque code", () => {
		expect(comparisonErrorCode(new Error("/private/official/secret.cap"))).toBe(
			"COMPARISON_UNTYPED_FAILURE",
		);
		expect(comparisonErrorCode({ code: "../../etc/passwd" })).toBe(
			"COMPARISON_UNTYPED_FAILURE",
		);
		expect(comparisonErrorCode({ code: "TRUST_AUTHORITY_UNPINNED" })).toBe(
			"TRUST_AUTHORITY_UNPINNED",
		);
	});
});

describe("R1 flow hardening: argument parsing", () => {
	// M7: a flag is never a value.
	test("a flag is not swallowed as the value of the flag before it", () => {
		expect(() =>
			parseCampaignArgs([
				"--staged-capability",
				"--fixture-only",
				"--candidate",
				"c",
			]),
		).toThrow(/CAMPAIGN_ARG_VALUE_MISSING/);
		expect(() => parseVerifyArgs(["--candidate", "--fixture-only"])).toThrow(
			/CAMPAIGN_ARG_VALUE_MISSING/,
		);
		expect(() => parseCampaignArgs(["--output-dir"])).toThrow(
			/CAMPAIGN_ARG_VALUE_MISSING/,
		);
	});

	// F3: fixture-only refuses every official digest and locator, not two.
	for (const [flag, value] of [
		["--capability-digest", HEX64],
		["--lock-digest", HEX64],
		["--archive-digest", HEX64],
	] as const) {
		test(`--fixture-only refuses ${flag}`, () => {
			expect(() => parseCampaignArgs(["--fixture-only", flag, value])).toThrow(
				/TRUST_OFFICIAL_CAPABILITY_FORBIDDEN/,
			);
			expect(() => parseVerifyArgs(["--fixture-only", flag, value])).toThrow(
				/TRUST_OFFICIAL_CAPABILITY_FORBIDDEN/,
			);
		});
	}

	for (const [flag, value] of [
		["--staged-capability", "official/staging/campaign.cap"],
		["--candidate", "candidate-1"],
		["--campaign-id", "campaign-1"],
		["--external-trust-bound", "external-bound"],
	] as const) {
		test(`--fixture-only refuses ${flag}`, () => {
			expect(() => parseCampaignArgs(["--fixture-only", flag, value])).toThrow(
				/TRUST_PATH_LOCATOR_FORBIDDEN/,
			);
		});
	}

	test("--fixture-only refuses a positional evidence root on the verify root", () => {
		expect(() =>
			parseVerifyArgs(["--fixture-only", ".release-evidence/candidate/x"]),
		).toThrow(/TRUST_PATH_LOCATOR_FORBIDDEN/);
	});

	test("a bare --fixture-only carries a fixed identity and no trust inputs", () => {
		const args = parseCampaignArgs(["--fixture-only"]);
		expect(args).toEqual(
			expect.objectContaining({
				fixtureOnly: true,
				candidate: "fixture-candidate",
				campaignId: "fixture-campaign",
				stagedCapabilityPath: "",
				capabilityDigestSha256: "",
				lockDigestSha256: "",
				archiveDigestSha256: "",
				outputDir: "",
				externalTrustBound: undefined,
			}),
		);
	});

	// F2: no ambient environment may select an official identity or directory.
	test("environment variables cannot bind a campaign identity", () => {
		const restore = {
			candidate: process.env.WEBTRANSPORT_COMPARISON_CANDIDATE,
			campaign: process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN,
			bound: process.env.WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND,
		};
		process.env.WEBTRANSPORT_COMPARISON_CANDIDATE = "ambient-candidate";
		process.env.WEBTRANSPORT_COMPARISON_CAMPAIGN = "ambient-campaign";
		process.env.WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND = "ambient-bound";
		try {
			expect(() => parseCampaignArgs([])).toThrow(
				/CAMPAIGN_ARG_MISSING_CANDIDATE/,
			);
			expect(() => parseVerifyArgs([])).toThrow(
				/CAMPAIGN_ARG_MISSING_CANDIDATE/,
			);
			const fixture = parseCampaignArgs(["--fixture-only"]);
			expect(fixture.candidate).toBe("fixture-candidate");
			expect(fixture.externalTrustBound).toBeUndefined();
		} finally {
			for (const [key, value] of [
				["WEBTRANSPORT_COMPARISON_CANDIDATE", restore.candidate],
				["WEBTRANSPORT_COMPARISON_CAMPAIGN", restore.campaign],
				["WEBTRANSPORT_COMPARISON_EXTERNAL_TRUST_BOUND", restore.bound],
			] as const) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	// M6: the platform gate is not opt-in and not self-declared.
	test("a declared platform is validated in addition to the running host", () => {
		expect(() => parseCampaignArgs(["--platform", "windows"])).toThrow(
			/OUTPUT_PLATFORM_UNSUPPORTED/,
		);
		expect(() => parseVerifyArgs(["--platform", "win32"])).toThrow(
			/OUTPUT_PLATFORM_UNSUPPORTED/,
		);
		// The running host is supported, so omitting the flag still parses — the
		// check ran, it simply passed.
		expect(parseCampaignArgs(["--fixture-only"]).fixtureOnly).toBe(true);
	});
});
