import { describe, expect, test } from "bun:test";

import {
	classifyVerdictTuple,
	ComparisonCliError,
	comparisonErrorCode,
	sha256HexOfBytes,
} from "./evidence.ts";
import {
	generateReport,
	requireExistingReportEvidenceDir,
} from "./render-report.ts";
import {
	R1_CAMPAIGN_AUTHORITY_BYTES,
	R1_CAMPAIGN_AUTHORITY_SHA256 as FROZEN_AUTHORITY_SHA256,
	R1_CAMPAIGN_LOCK_BYTES,
	R1_CAMPAIGN_MANIFEST_V1_BYTES,
} from "./r1-fixtures.ts";
import {
	CANONICAL_SCENARIO_REGISTRY,
	requestedImpairmentOf,
} from "./scenario-registry.ts";
import * as campaignModule from "./run-campaign.ts";
import {
	type ArmMeasurement,
	buildMeasuredArmArtifact,
	type CampaignAuthorityAnchor,
	deriveMeasuredVerdictTuple,
	injectedImpairmentOf,
	isPinnedCampaignAuthority,
	parseCampaignArgs,
	R1_CAMPAIGN_AUTHORITY_ANCHOR_SET,
	R1_CAMPAIGN_AUTHORITY_ANCHORS,
	R1_CAMPAIGN_AUTHORITY_SHA256,
	runCampaign,
	runOfficialEntrypointFlow,
	selectMintingAnchor,
} from "./run-campaign.ts";
import {
	parseVerifyArgs,
	requireExistingEvidenceDir,
} from "./verify-artifact.ts";

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
		// An official run. A fixture run can never promote, so pinning the
		// promotion rules with `fixtureOnly: true` everywhere asserted them
		// against inputs that cannot reach them; the demotion cases below state
		// the flag deliberately instead.
		fixtureOnly: false,
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

	// H2: the report is the last and least trusted step. It supplies no part of
	// the verdict tuple — not the half the promote step left undefined, and not
	// a half whose promote-side claim was unreadable.
	//
	// Each case below produced `promotable: true` while the two seams were merged
	// with `??`, so reverting to that merge fails every one of them.
	test("a report seam that names either tuple field is disputing the promotion", async () => {
		for (const reported of [
			{ evidenceStatus: "PASS", scenarioVerdict: "PASS" },
			{ evidenceStatus: "PASS" },
			{ scenarioVerdict: "PASS" },
			{ evidenceStatus: "FAIL", scenarioVerdict: "PASS", promotable: true },
		] as const) {
			expect(
				await captureCode(() =>
					runOfficialEntrypointFlow(
						flowInput({
							promotion: {
								promote: () => ({ ok: true, promoted: true }),
								renderReport: () => ({ ok: true, ...reported }),
							},
						}) as never,
					),
				),
			).toBe("VERDICT_TUPLE_DISPUTED");
		}
	});

	test("the report cannot complete a half tuple the promote step left open", async () => {
		expect(
			await captureCode(() =>
				runOfficialEntrypointFlow(
					flowInput({
						promotion: {
							promote: () => ({
								ok: true,
								promoted: true,
								evidenceStatus: "PASS",
							}),
							renderReport: () => ({ ok: true, scenarioVerdict: "PASS" }),
						},
					}) as never,
				),
			),
		).toBe("VERDICT_TUPLE_DISPUTED");
	});

	test("an unreadable tuple claim on the promote step is a refusal, not an absence", async () => {
		for (const claimed of [
			{ evidenceStatus: 0, scenarioVerdict: 0 },
			{ evidenceStatus: "PASS", scenarioVerdict: null },
			{ evidenceStatus: ["PASS"], scenarioVerdict: "PASS" },
		] as const) {
			expect(
				await captureCode(() =>
					runOfficialEntrypointFlow(
						flowInput({
							promotion: {
								promote: () => ({ ok: true, promoted: true, ...claimed }),
								renderReport: () => ({ ok: true }),
							},
						}) as never,
					),
				),
			).toBe("VERDICT_TUPLE_MALFORMED");
		}
	});

	test("a promotion that claims no tuple at all is not promotable", async () => {
		const result = await runOfficialEntrypointFlow(
			flowInput({
				promotion: {
					promote: () => ({ ok: true, promoted: true }),
					renderReport: () => ({ ok: true }),
				},
			}) as never,
		);
		expect(result.promoted).toBe(true);
		expect(result.promotable).toBe(false);
		expect(result.evidenceStatus).toBeUndefined();
		expect(result.scenarioVerdict).toBeUndefined();
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

	// S4: a seam's `code` is an untrusted string, and the error object formats
	// its own stderr, so sanitizing at the print site was already too late.
	test("a seam that refuses with a path for a code reports a typed code instead", async () => {
		const secret = "/private/staging/capabilities/campaign-r1-9f2a.cap";
		for (const [overrides, expected] of [
			[
				{
					verify: {
						lock: () => ({ ok: false, code: secret }),
						manifest: () => ({ ok: true }),
					},
				},
				"CAMPAIGN_LOCK_INVALID",
			],
			[
				{
					promotion: {
						promote: () => ({ ok: false, code: secret }),
						renderReport: () => ({ ok: true }),
					},
				},
				"PROMOTION_REJECTED",
			],
			[
				{
					promotion: {
						promote: () => ({ ok: true, promoted: false }),
						renderReport: () => ({ ok: false, code: secret }),
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
			const typed = thrown as ComparisonCliError;
			expect(typed.code).toBe(expected);
			expect(typed.message).toBe(expected);
			expect(typed.stderr).not.toContain(secret);
			expect(typed.stderr).not.toContain("/");
			expect(typed.stderr).not.toContain(".cap");
		}
	});

	test("a typed error cannot be constructed around a path, message, or role", () => {
		const secret = "/private/staging/capabilities/campaign-r1-9f2a.cap";
		for (const unsafe of [
			secret,
			`ENOENT: no such file or directory, open '${secret}'`,
			"../../etc/passwd",
			"lowercase_code",
			"",
		]) {
			const error = new ComparisonCliError("campaign", unsafe);
			expect(error.code).toBe("COMPARISON_UNTYPED_FAILURE");
			expect(error.message).toBe("COMPARISON_UNTYPED_FAILURE");
			expect(error.stderr).toBe(
				"[campaign] Error: COMPARISON_UNTYPED_FAILURE\n",
			);
			expect(comparisonErrorCode(error)).toBe("COMPARISON_UNTYPED_FAILURE");
		}
		expect(
			new ComparisonCliError(secret, "TRUST_AUTHORITY_UNPINNED").stderr,
		).toBe("[comparison] Error: TRUST_AUTHORITY_UNPINNED\\n");
		// A legitimate code still passes through untouched.
		const typed = new ComparisonCliError("report", "REPORT_IDENTITY_UNBOUND");
		expect(typed.code).toBe("REPORT_IDENTITY_UNBOUND");
		expect(typed.stderr).toBe("[report] Error: REPORT_IDENTITY_UNBOUND\\n");
	});
});

describe("R1 flow hardening: a fixture run carries no authority", () => {
	// S2: `fixtureOnly` used to be declared on the input and never read, so a
	// caller could state a fixture run and still receive `promotable: true`.
	test("a fixture run that claims a promotion is refused", async () => {
		expect(
			await captureCode(() =>
				runOfficialEntrypointFlow(
					flowInput({
						fixtureOnly: true,
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
				),
			),
		).toBe("TRUST_FIXTURE_PROMOTION_FORBIDDEN");
	});

	test("a fixture run that promotes nothing is never promotable", async () => {
		const result = await runOfficialEntrypointFlow(
			flowInput({
				fixtureOnly: true,
				promotion: {
					promote: () => ({
						ok: true,
						promoted: false,
						evidenceStatus: "PASS",
						scenarioVerdict: "PASS",
					}),
					renderReport: () => ({ ok: true }),
				},
			}) as never,
		);
		expect(result.fixtureOnly).toBe(true);
		expect(result.promotable).toBe(false);
		// The same seams under an official run are promotable, which is what makes
		// the demotion above attributable to the flag and nothing else.
		const official = await runOfficialEntrypointFlow(
			flowInput({
				fixtureOnly: false,
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
		expect(official.promotable).toBe(true);
	});

	test("a fixture flag that is not a boolean is refused, not read as official", async () => {
		for (const malformed of ["true", "no", 1, 0, {}, null] as const) {
			expect(
				await captureCode(() =>
					runOfficialEntrypointFlow(
						flowInput({ fixtureOnly: malformed }) as never,
					),
				),
			).toBe("TRUST_FIXTURE_FLAG_INVALID");
		}
	});

	test("the flow never launches a role", async () => {
		let launches = 0;
		const result = await runOfficialEntrypointFlow(
			flowInput({
				spawnRole: () => {
					launches += 1;
					throw new Error("the flow must not start a role or a socket");
				},
			}) as never,
		);
		expect(result.ok).toBe(true);
		expect(launches).toBe(0);
	});
});

describe("R1 flow hardening: the authority anchor set", () => {
	// S3: the anchor is committed, not supplied. Rotation is an edit to this
	// set; a caller may name an anchor and may never introduce one.
	test("every anchor is a committed SHA-256 and the set cannot grow at runtime", () => {
		expect(R1_CAMPAIGN_AUTHORITY_ANCHORS.length).toBeGreaterThan(0);
		for (const anchor of R1_CAMPAIGN_AUTHORITY_ANCHORS) {
			expect(anchor).toMatch(/^[0-9a-f]{64}$/u);
			expect(isPinnedCampaignAuthority(anchor)).toBe(true);
		}
		expect(R1_CAMPAIGN_AUTHORITY_ANCHORS).toContain(FROZEN_AUTHORITY_SHA256);
		expect(Object.isFrozen(R1_CAMPAIGN_AUTHORITY_ANCHORS)).toBe(true);
		expect(() =>
			(R1_CAMPAIGN_AUTHORITY_ANCHORS as string[]).push("f".repeat(64)),
		).toThrow();
		expect(isPinnedCampaignAuthority("f".repeat(64))).toBe(false);
	});

	test("a digest that hashes its own bytes honestly is still not an anchor", () => {
		// The H3 tautology in one line: this record is internally consistent and
		// carries no authority whatsoever.
		const forged = new TextEncoder().encode('{"schema":"forged-authority"}');
		expect(isPinnedCampaignAuthority(sha256HexOfBytes(forged))).toBe(false);
	});

	test("the anchor the caller names is the one the bytes are proved against", async () => {
		const result = await runOfficialEntrypointFlow(flowInput() as never);
		expect(result.authoritySha256).toBe(R1_CAMPAIGN_AUTHORITY_SHA256);
		expect(isPinnedCampaignAuthority(result.authoritySha256)).toBe(true);
	});

	// F4: the minting anchor used to be "the last array element", which made the
	// documented rotation path unexecutable — appending the incoming anchor moved
	// minting authority by typing order, and prepending it minted against the
	// retired one.
	test("a two-anchor set mints against the anchor declared minting, wherever it sits", () => {
		const incoming: CampaignAuthorityAnchor = {
			sha256: "b".repeat(64),
			status: "minting",
		};
		const outgoing: CampaignAuthorityAnchor = {
			sha256: "a".repeat(64),
			status: "retired",
		};
		expect(selectMintingAnchor([outgoing, incoming])).toBe(incoming.sha256);
		expect(selectMintingAnchor([incoming, outgoing])).toBe(incoming.sha256);
		// The shipped constant is that selection, not a position.
		expect(R1_CAMPAIGN_AUTHORITY_SHA256).toBe(
			selectMintingAnchor(R1_CAMPAIGN_AUTHORITY_ANCHOR_SET),
		);
	});

	// F5: a set with no minting anchor, or two, is not a rotation anyone reviewed.
	test("a set that does not name exactly one minting anchor refuses", () => {
		for (const anchors of [
			[],
			[{ sha256: "a".repeat(64), status: "retired" } as const],
			[
				{ sha256: "a".repeat(64), status: "minting" } as const,
				{ sha256: "b".repeat(64), status: "minting" } as const,
			],
		]) {
			expect(() => selectMintingAnchor(anchors)).toThrow(
				/TRUST_AUTHORITY_MINT_AMBIGUOUS/u,
			);
		}
	});

	test("the shipped anchor set names one minting anchor and it is the frozen fixture", () => {
		expect(Object.isFrozen(R1_CAMPAIGN_AUTHORITY_ANCHOR_SET)).toBe(true);
		const minting = R1_CAMPAIGN_AUTHORITY_ANCHOR_SET.filter(
			(anchor) => anchor.status === "minting",
		);
		expect(minting).toHaveLength(1);
		expect(minting[0]!.sha256).toBe(FROZEN_AUTHORITY_SHA256);
		// A retired anchor still validates what it minted, so it stays pinned.
		for (const anchor of R1_CAMPAIGN_AUTHORITY_ANCHOR_SET) {
			expect(isPinnedCampaignAuthority(anchor.sha256)).toBe(true);
		}
	});
});

describe("R1 flow hardening: the verify root refuses without a path", () => {
	// F3: the root printed `Directory '<resolved official path>' does not exist`
	// straight to stderr, which is the one thing every other refusal on these
	// roots avoids. The check is a typed refusal now.
	test("a missing evidence directory is a typed code, never the path", () => {
		const missing = "/Users/someone/.release-evidence/secret-candidate/run-1";
		let code = "";
		let message = "";
		try {
			requireExistingEvidenceDir(missing, () => false);
			throw new Error("expected the directory check to refuse");
		} catch (error: unknown) {
			code = comparisonErrorCode(error);
			message = String((error as Error).message);
		}
		expect(code).toBe("VERIFY_EVIDENCE_DIR_MISSING");
		expect(message).not.toContain(missing);
		expect(message).not.toContain("/Users/");
	});

	test("a directory that exists is returned unchanged", () => {
		expect(requireExistingEvidenceDir("/tmp/evidence", () => true)).toBe(
			"/tmp/evidence",
		);
	});
});

describe("R1 flow hardening: malformed flow input is a typed refusal", () => {
	// F6: the seam table and the authority record were read outside `runSeam`, so
	// a caller that omitted either escaped as a raw TypeError naming the property
	// the runtime could not read — the boundary the flow's docblock says only
	// typed codes survive.
	for (const load of [undefined, null, "bootstrap", 7, true]) {
		test(`a flow input whose load table is ${JSON.stringify(load) ?? "undefined"} refuses typed`, async () => {
			expect(
				await captureCode(() =>
					runOfficialEntrypointFlow({
						...flowInput(),
						load,
					} as never),
				),
			).toBe("TRUST_FLOW_SEAMS_INVALID");
		});
	}

	test("a flow input that is undefined entirely refuses typed", async () => {
		expect(
			await captureCode(() => runOfficialEntrypointFlow(undefined as never)),
		).toBe("TRUST_FLOW_SEAMS_INVALID");
	});

	test("a flow input with no authority record refuses as unpinned", async () => {
		const { authority: _authority, ...rest } = flowInput();
		expect(
			await captureCode(() => runOfficialEntrypointFlow(rest as never)),
		).toBe("TRUST_AUTHORITY_UNPINNED");
	});

	test("a flow input whose authority names the anchor but carries no bytes refuses typed", async () => {
		expect(
			await captureCode(() =>
				runOfficialEntrypointFlow(
					flowInput({
						authority: { digest: R1_CAMPAIGN_AUTHORITY_SHA256 },
					}) as never,
				),
			),
		).toBe("TRUST_AUTHORITY_BYTES_MISMATCH");
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

/**
 * Runs `body` with the process reporting an unsupported host.
 *
 * The declared-platform cases above pass whether or not the host is checked,
 * because the flag is validated separately. Only an unsupported host proves the
 * host check itself runs, so these tests stub it: deleting any
 * `assertSupportedPlatform(role, process.platform)` call makes them fail.
 */
function onUnsupportedHost(body: () => void): void {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", {
		value: "win32",
		configurable: true,
	});
	try {
		expect(process.platform).toBe("win32");
		body();
	} finally {
		if (original) Object.defineProperty(process, "platform", original);
	}
}

describe("R1 flow hardening: the host platform gate", () => {
	// S5: the parsers are not the only way in, and a supported host proves
	// nothing about whether the check ran.
	test("the parsers refuse an unsupported host even with no --platform flag", () => {
		onUnsupportedHost(() => {
			expect(() => parseCampaignArgs(["--fixture-only"])).toThrow(
				/OUTPUT_PLATFORM_UNSUPPORTED/,
			);
			expect(() => parseVerifyArgs(["--fixture-only"])).toThrow(
				/OUTPUT_PLATFORM_UNSUPPORTED/,
			);
		});
		// The same arguments parse on this supported host, so the refusal above is
		// attributable to the host and to nothing else in the argument vector.
		expect(parseCampaignArgs(["--fixture-only"]).fixtureOnly).toBe(true);
	});

	test("the in-process entry points refuse an unsupported host themselves", async () => {
		// An in-process caller assembles these inputs directly and never reaches a
		// parser, so the gate has to live on the entry point too.
		const campaignArgs = {
			scenarios: ["chat-fanout"],
			transports: "ws",
			outputDir: "",
			candidate: "in-process",
			campaignId: "in-process-campaign",
		} as const;
		const identity = {
			candidate: "in-process",
			campaignId: "in-process-campaign",
		} as const;

		let campaignCode = "";
		let reportCode = "";
		const original = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", {
			value: "win32",
			configurable: true,
		});
		try {
			campaignCode = await captureCode(() =>
				runCampaign(campaignArgs as never),
			);
			try {
				generateReport(identity);
				throw new Error("expected generateReport to refuse");
			} catch (error: unknown) {
				reportCode = comparisonErrorCode(error);
			}
		} finally {
			if (original) Object.defineProperty(process, "platform", original);
		}
		expect(campaignCode).toBe("OUTPUT_PLATFORM_UNSUPPORTED");
		expect(reportCode).toBe("OUTPUT_PLATFORM_UNSUPPORTED");

		// On this supported host both entry points get past the platform gate and
		// stop at the quarantined trust boundary instead, which is what makes the
		// refusals above the platform gate's doing.
		expect(await captureCode(() => runCampaign(campaignArgs as never))).toBe(
			"OUTPUT_TRUST_BOUNDARY_UNAVAILABLE",
		);
	});
});

describe("R1 flow hardening: the campaign states its own verdict", () => {
	// S6: `buildRunArtifact` defaults an unstated tuple to PASS/PASS, which the
	// matrix reads as promotable, so a call site that states nothing stamps
	// promotability before verification. The campaign derives its tuple.
	test("on a cell that injects no loss, a complete ledger is the only PASS/PASS", () => {
		const ledger = {
			attempted: 1000,
			delivered: 1000,
			dropped: 0,
			expired: 0,
		};
		expect(deriveMeasuredVerdictTuple({ samples: [1, 2, 3], ledger })).toEqual({
			evidenceStatus: "PASS",
			scenarioVerdict: "PASS",
		});
		for (const lossy of [
			{ ...ledger, dropped: 1 },
			{ ...ledger, expired: 1 },
			{ ...ledger, delivered: 999 },
		]) {
			expect(
				deriveMeasuredVerdictTuple({ samples: [1, 2, 3], ledger: lossy }),
			).toEqual({ evidenceStatus: "PASS", scenarioVerdict: "MISS" });
			expect(
				classifyVerdictTuple(
					deriveMeasuredVerdictTuple({ samples: [1, 2, 3], ledger: lossy }),
				),
			).toEqual(expect.objectContaining({ ok: true, promotable: false }));
			// The same ledger under injected loss is the impairment doing its job.
			expect(
				deriveMeasuredVerdictTuple(
					{ samples: [1, 2, 3], ledger: lossy },
					{ lossPercent: 1 },
				),
			).toEqual({ evidenceStatus: "PASS", scenarioVerdict: "PASS" });
		}
	});

	test("an arm that produced no samples is blocked with no verdict", () => {
		expect(
			deriveMeasuredVerdictTuple({
				samples: [],
				ledger: { attempted: 1000, delivered: 1000, dropped: 0, expired: 0 },
			}),
		).toEqual({ evidenceStatus: "BLOCKED", scenarioVerdict: "NO_VERDICT" });
	});

	// F1: treating any incomplete ledger as a MISS inverted the verdict on the
	// one scenario built to measure loss tolerance. `game-tick-loss` makes
	// datagrams drop on purpose; a 99% delivery under 1% injected loss is the
	// measurement working, and scoring it MISS made every WT and WS-overlay arm
	// of that scenario unpromotable — so the 12 overlay records the frozen
	// manifest contract requires could never be written at all.
	test("no arm of the live registry is scored MISS for loss its own cell injects", () => {
		const scored = CANONICAL_SCENARIO_REGISTRY.cells.flatMap((cell) => {
			const injected = injectedImpairmentOf(cell);
			return (
				[
					["wt", "primary"],
					["ws", "primary"],
					["ws", "overlay"],
				] as const
			).map(([transport, armKind]) => {
				const artifact = buildMeasuredArmArtifact({
					cell,
					comparisonId: "r1-registry-sweep",
					runId: `sweep-${cell.cellId}-${transport}-${armKind}`,
					transport,
					armKind,
				});
				return { cell, injected, transport, armKind, artifact };
			});
		});

		expect(scored.length).toBeGreaterThan(0);
		const missed = scored.filter(
			({ artifact }) => artifact.scenarioVerdict !== "PASS",
		);
		expect(
			missed.map(
				({ cell, transport, armKind }) =>
					`${cell.cellId}/${transport}/${armKind}`,
			),
		).toEqual([]);
		// Every arm therefore reaches the promotion boundary as a promotable
		// artifact, which is what the MISS was costing.
		expect(scored.every(({ artifact }) => artifact.promotable)).toBe(true);

		// The sweep only says something because the loss scenario really does
		// deliver less than it attempted on both of its lossy arms.
		const lossy = scored.filter(
			({ cell, armKind, transport }) =>
				cell.scenarioId === "game-tick-loss" &&
				(transport === "wt" || armKind === "overlay"),
		);
		expect(lossy).toHaveLength(24);
		expect(
			lossy.every(
				({ artifact }) => artifact.ledger.delivered < artifact.ledger.attempted,
			),
		).toBe(true);
		expect(lossy.every(({ injected }) => injected.lossPercent > 0)).toBe(true);
	});

	// The budget is attribution, not amnesty: an arm that lost far more than the
	// cell injected is still a MISS, and a cell that injects nothing forgives
	// nothing.
	test("loss beyond what the impairment explains is still a measured MISS", () => {
		const ledger = {
			attempted: 1000,
			delivered: 800,
			dropped: 200,
			expired: 0,
		};
		expect(
			deriveMeasuredVerdictTuple(
				{ samples: [1, 2, 3], ledger },
				{ lossPercent: 1 },
			),
		).toEqual({ evidenceStatus: "PASS", scenarioVerdict: "MISS" });
		expect(
			deriveMeasuredVerdictTuple({ samples: [1, 2, 3], ledger }, {}),
		).toEqual({ evidenceStatus: "PASS", scenarioVerdict: "MISS" });
		for (const bogus of [Number.NaN, -5, "5" as unknown as number]) {
			expect(
				deriveMeasuredVerdictTuple(
					{
						samples: [1, 2, 3],
						ledger: { attempted: 1000, delivered: 999, dropped: 1, expired: 0 },
					},
					{ lossPercent: bogus },
				),
			).toEqual({ evidenceStatus: "PASS", scenarioVerdict: "MISS" });
		}
	});
});

describe("R1 flow hardening: the campaign's per-arm artifact is derived", () => {
	// F2: nothing asserted that `runCampaign` passed a derived tuple to
	// `buildRunArtifact`. `runCampaign` cannot be reached in-process, so deleting
	// the spread from its loop restored the S6 defect with a green suite. The
	// construction is a function now, and this is what calls it.
	const lossCell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(cell) => cell.scenarioId === "game-tick-loss",
	)!;
	/** A cell that injects no loss, so nothing about its shortfall is expected. */
	const cleanCell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(cell) => injectedImpairmentOf(cell).lossPercent === 0,
	)!;

	/** A measured arm the test states in full, rather than borrowing the model. */
	function measurementOf(
		delivered: number,
		samples: readonly number[] = [99, 99, 99],
	): ArmMeasurement {
		const attempted = 1000;
		return {
			samples: [...samples],
			percentiles: { p1: 99, p50: 99, p95: 99, p99: 99 },
			ledger: {
				attempted,
				queued: attempted,
				serverObserved: attempted,
				acknowledged: attempted,
				delivered,
				dropped: attempted - delivered,
				expired: 0,
			},
			telemetry: {
				mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
				linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
			},
			admissionCounters: {
				schemaVersion: "v1",
				handshakes: {
					attempted: 10,
					accepted: 10,
					rejected: 0,
					rateLimited: 0,
				},
				sessions: { attempted: 10, accepted: 10, rejected: 0, activePeak: 10 },
				streams: { attempted: 0, accepted: 0, rejected: 0, rateLimited: 0 },
				datagrams: {
					attempted: 1000,
					accepted: 1000,
					rejected: 0,
					rateLimited: 0,
				},
			},
		};
	}

	function armFor(
		cell: typeof lossCell,
		runId: string,
		measurement: ArmMeasurement,
	) {
		return buildMeasuredArmArtifact({
			cell,
			comparisonId: "r1-arm-builder",
			runId,
			transport: "wt",
			armKind: "primary",
			measurement,
		});
	}

	test("the arm builder states a tuple rather than inheriting the promotable default", () => {
		const measurement = measurementOf(995);
		const artifact = armFor(lossCell, "arm-builder-wt", measurement);
		expect({
			evidenceStatus: artifact.evidenceStatus,
			scenarioVerdict: artifact.scenarioVerdict,
		}).toEqual({
			...deriveMeasuredVerdictTuple(
				measurement,
				injectedImpairmentOf(lossCell),
			),
		});
		// The recorded impairment is the same reading the verdict was derived
		// against, so a cell cannot be judged on one loss figure and stamped with
		// another.
		expect(artifact.impairment.requested).toEqual(
			expect.objectContaining(injectedImpairmentOf(lossCell)),
		);
		// The identical ledger on a cell that injects nothing is a MISS, which is
		// what makes the PASS above the injected impairment's doing rather than a
		// blanket amnesty.
		expect(injectedImpairmentOf(lossCell).lossPercent).toBeGreaterThan(0);
		expect(artifact.scenarioVerdict).toBe("PASS");
		expect(
			armFor(cleanCell, "arm-builder-clean", measurement).scenarioVerdict,
		).toBe("MISS");
	});

	test("an arm that measured nothing is built BLOCKED, not defaulted to PASS/PASS", () => {
		const artifact = armFor(
			lossCell,
			"arm-builder-blocked",
			measurementOf(1000, []),
		);
		expect(artifact.evidenceStatus).toBe("BLOCKED");
		expect(artifact.scenarioVerdict).toBe("NO_VERDICT");
		expect(artifact.promotable).toBe(false);
	});

	test("an arm whose ledger lost more than the cell injected is built as a MISS", () => {
		const artifact = armFor(lossCell, "arm-builder-miss", measurementOf(0));
		expect(artifact.scenarioVerdict).toBe("MISS");
		expect(artifact.promotable).toBe(false);
	});

	// A1: the builder re-resolved the cell by `cellId` for the artifact but
	// judged against the caller's object, and being callable from outside
	// `runCampaign` is the whole point of it. A spread copy of a zero-loss cell
	// carrying `lossPercent: 100` bought a total blackout a PASS/PASS, stamped
	// promotable, over an artifact that still recorded a clean `fq` run — and a
	// PASS scenario verdict is *required* to be promotable, so the verifier
	// accepts it. The cell is resolved from the registry now and a supplied
	// object that is not canonically identical is refused.
	const blackout = measurementOf(0);

	test("a cell object that is not the registry's own is refused, not judged", () => {
		for (const forgedLoss of [100, 5]) {
			const forged = {
				...cleanCell,
				parameters: {
					...(cleanCell.parameters as Record<string, unknown>),
					lossPercent: forgedLoss,
				},
			} as typeof cleanCell;
			let code = "";
			try {
				armFor(forged, `forged-loss-${forgedLoss}`, blackout);
				throw new Error("expected the forged cell to be refused");
			} catch (error: unknown) {
				code = comparisonErrorCode(error);
			}
			expect(code).toBe("CAMPAIGN_CELL_NOT_CANONICAL");
		}
	});

	test("a cell naming no registry row is a typed refusal, not a RangeError", () => {
		let code = "";
		try {
			armFor(
				{ ...cleanCell, cellId: "no-such-scenario/no-such-cell" },
				"forged-cell-id",
				blackout,
			);
			throw new Error("expected the unknown cell to be refused");
		} catch (error: unknown) {
			code = comparisonErrorCode(error);
		}
		expect(code).toBe("CAMPAIGN_CELL_NOT_CANONICAL");
	});

	test("the registry's own cell still builds, and the blackout on it is a MISS", () => {
		const artifact = armFor(cleanCell, "canonical-cell", blackout);
		expect(artifact.scenarioVerdict).toBe("MISS");
		expect(artifact.promotable).toBe(false);
	});
});

describe("R1 flow hardening: the impairment is read once", () => {
	// A2: `buildRunArtifact` recorded `requestedImpairmentOf`, which decodes the
	// named paths, while the verdict was derived from a second reader that saw
	// only the numeric parameters. On `bulk-one-way/delay40-loss1` the artifact
	// recorded a 1%-loss run and the judge scored it as if none had been
	// injected, so a genuine 1% shortfall came out a MISS. This cell is the one
	// that discriminates: `game-tick-loss` is the one family where the two
	// readers happened to agree.
	const pathCell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(cell) => cell.cellId === "bulk-one-way/delay40-loss1",
	)!;

	test("a cell that states its impairment as a path injects that impairment", () => {
		expect(injectedImpairmentOf(pathCell)).toEqual({
			qdisc: "netem",
			delayMs: 40,
			lossPercent: 1,
		});
	});

	test("a 1% shortfall on a cell injecting 1% by path is the impairment's doing", () => {
		const attempted = 1600;
		const delivered = 1584;
		expect(
			deriveMeasuredVerdictTuple(
				{
					samples: [1, 2, 3],
					ledger: {
						attempted,
						delivered,
						dropped: attempted - delivered,
						expired: 0,
					},
				},
				injectedImpairmentOf(pathCell),
			),
		).toEqual({ evidenceStatus: "PASS", scenarioVerdict: "PASS" });
	});

	test("every cell records the impairment it is judged against", () => {
		for (const cell of CANONICAL_SCENARIO_REGISTRY.cells) {
			const artifact = buildMeasuredArmArtifact({
				cell,
				comparisonId: "r1-impairment-parity",
				runId: `parity-${cell.cellId}`,
				transport: "wt",
				armKind: "primary",
			});
			const judged = injectedImpairmentOf(cell);
			expect({
				qdisc: artifact.impairment.requested.qdisc,
				delayMs: artifact.impairment.requested.delayMs,
				lossPercent: artifact.impairment.requested.lossPercent,
			}).toEqual(judged);
			// Both names resolve to the one decoder; there is no second reading to
			// drift away from this one.
			expect(judged).toEqual(requestedImpairmentOf(cell));
		}
	});
});

describe("R1 flow hardening: the attribution budget is bounded", () => {
	const tuple = (attempted: number, delivered: number, lossPercent?: number) =>
		deriveMeasuredVerdictTuple(
			{
				samples: [1, 2, 3],
				ledger: {
					attempted,
					delivered,
					dropped: attempted - delivered,
					expired: 0,
				},
			},
			lossPercent === undefined ? {} : { lossPercent },
		);
	const PASS = { evidenceStatus: "PASS", scenarioVerdict: "PASS" } as const;
	const MISS = { evidenceStatus: "PASS", scenarioVerdict: "MISS" } as const;
	const UNATTRIBUTABLE = {
		evidenceStatus: "BLOCKED",
		scenarioVerdict: "NO_VERDICT",
	} as const;

	// A3: the budget was `attempted * lossPercent/100 * factor` with no upper
	// bound, so an injected rate of 50, 100 or 1e9 forgave a total blackout
	// outright. The registry ships 1/2.5/5 and clamps overrides to 0-100, and
	// 100 alone forgives everything.
	test("an injected rate past the calibrated regime attributes nothing", () => {
		for (const lossPercent of [10.5, 50, 100, 1e9]) {
			expect(tuple(1000, 0, lossPercent)).toEqual(UNATTRIBUTABLE);
		}
		// At the boundary the rule still has an opinion, and a blackout is not it.
		expect(tuple(1000, 0, 10)).toEqual(MISS);
	});

	// A3: the budget is a fraction of what was attempted, so on a handful of
	// messages it degenerated — `attempted: 1` under 1% injected loss rounded up
	// to a one-message budget and passed a 100% loss.
	test("a ledger too small to attribute anything within says so", () => {
		expect(tuple(1, 0, 1)).toEqual(UNATTRIBUTABLE);
		expect(tuple(10, 9, 1)).toEqual(UNATTRIBUTABLE);
		expect(tuple(99, 90, 1)).toEqual(UNATTRIBUTABLE);
		// A complete ledger needs no attribution, however small.
		expect(tuple(1, 1, 1)).toEqual(PASS);
		expect(tuple(10, 10, 1)).toEqual(PASS);
		// And a cell injecting nothing forgives nothing at any size, because there
		// is no attribution question to be too small for.
		expect(tuple(10, 9)).toEqual(MISS);
	});

	// A4: at 2x an arm that lost exactly double the injected rate — a 100%
	// attribution error, indistinguishable from a broken datagram path — was
	// stamped PASS and promotable.
	test("an arm that doubled the injected loss rate cannot pass as attribution", () => {
		for (const [lossPercent, doubled] of [
			[1, 980],
			[2.5, 950],
			[5, 900],
		] as const) {
			expect(tuple(1000, doubled, lossPercent)).toEqual(MISS);
		}
	});

	test("an arm losing what the impairment injects, and half again, still passes", () => {
		for (const [lossPercent, atRate, atBudget] of [
			[1, 990, 985],
			[2.5, 975, 963],
			[5, 950, 925],
		] as const) {
			expect(tuple(1000, atRate, lossPercent)).toEqual(PASS);
			expect(tuple(1000, atBudget, lossPercent)).toEqual(PASS);
		}
		// One message past the budget is a MISS, so the bound is a bound.
		expect(tuple(1000, 984, 1)).toEqual(MISS);
	});

	// A3: every case above uses a ledger whose budget happens to be a whole
	// number, or a shortfall the min-attempts bound rejects first, so `floor` at
	// `run-campaign.ts` was never once reached with a fractional budget —
	// reverting it to `ceil` left the entire suite green. These two pin it. At
	// `attempted: 150` and 1% injected the raw budget is 2.25: `floor` allows two
	// missing messages, `ceil` would allow three.
	test("a fractional budget is not rounded up in the arm's favour", () => {
		expect(tuple(150, 148, 1)).toEqual(PASS);
		expect(tuple(150, 147, 1)).toEqual(MISS);
	});

	// The cost of that choice, accepted with its eyes open and pinned so it
	// cannot change silently: `floor` scores a MISS on ledgers in [126, 133] that
	// lose exactly what the campaign's own 1.2x overlay model predicts, because
	// the budget only reaches two messages at 134. Unreachable live — lossy cells
	// attempt 600 or 1800 — and preferred to `ceil`, which would forgive one
	// missing message on any ledger whose raw budget falls below 1.
	test("the accepted false-MISS band under the overlay model stays where it is", () => {
		expect(tuple(133, 131, 1)).toEqual(MISS);
		expect(tuple(134, 132, 1)).toEqual(PASS);
		// The amnesty `floor` is refusing: 0.001% injected over 1000 attempts is a
		// hundred times too small to explain a 0.1% shortfall, and a budget rounded
		// up from 0.015 to a whole message would say it explains it exactly.
		expect(tuple(1000, 999, 0.001)).toEqual(MISS);
	});

	// Behaviours the bound must not have cost: a rate that is not a positive
	// finite number injects nothing, and the two readings of "missing" do not
	// double-count.
	test("a rate that is not a positive finite number forgives nothing", () => {
		for (const bogus of [
			undefined,
			0,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			-1,
			null as unknown as number,
			"1" as unknown as number,
		]) {
			expect(tuple(1000, 999, bogus as number | undefined)).toEqual(MISS);
		}
	});

	test("a full delivery count alongside a drop counter is judged on the drop", () => {
		expect(
			deriveMeasuredVerdictTuple(
				{
					samples: [1],
					ledger: {
						attempted: 1000,
						delivered: 1000,
						dropped: 10,
						expired: 5,
					},
				},
				{ lossPercent: 1 },
			),
		).toEqual(PASS);
		expect(
			deriveMeasuredVerdictTuple(
				{
					samples: [1],
					ledger: {
						attempted: 1000,
						delivered: 1000,
						dropped: 10,
						expired: 7,
					},
				},
				{ lossPercent: 1 },
			),
		).toEqual(MISS);
		// 1000 - 990 and 10 + 0 are the same 10 messages, counted once.
		expect(
			deriveMeasuredVerdictTuple(
				{
					samples: [1],
					ledger: {
						attempted: 1000,
						delivered: 990,
						dropped: 10,
						expired: 0,
					},
				},
				{ lossPercent: 1 },
			),
		).toEqual(PASS);
	});
});

describe("R1 flow hardening: the report root refuses without a path", () => {
	// A6/F3: the verify half of this was covered and the report half was not —
	// reverting `render-report.ts` to a raw `Error` quoting the resolved official
	// directory left the whole suite green, because the three cross-root tests
	// that named this fix are satisfied by an earlier refusal on every root.
	test("a missing report evidence directory is a typed code, never the path", () => {
		const missing = "/Users/someone/.release-evidence/secret-candidate/run-1";
		let code = "";
		let message = "";
		try {
			requireExistingReportEvidenceDir(missing, () => false);
			throw new Error("expected the directory check to refuse");
		} catch (error: unknown) {
			code = comparisonErrorCode(error);
			message = String((error as Error).message);
		}
		expect(code).toBe("REPORT_EVIDENCE_DIR_MISSING");
		expect(message).not.toContain(missing);
		expect(message).not.toContain("/Users/");
	});

	test("a report evidence directory that exists is returned unchanged", () => {
		expect(requireExistingReportEvidenceDir("/tmp/evidence", () => true)).toBe(
			"/tmp/evidence",
		);
	});
});

describe("R1 flow hardening: the synthetic measurement model is not an API", () => {
	// A5: round three justified the optional `measurement` parameter by claiming
	// that exporting the model "tripped check-official-io's
	// FORBIDDEN_SYNTHETIC_EXECUTOR". It does not: `measureCellArm` is a
	// name-listed forbidden surface, so the checker already reports its
	// declaration and its call site at HEAD. Exporting it leaves the 114-row
	// (code, file) key set and the failure count identical and the module graph
	// unchanged (`resolved-graph-sha256` is stable) — but it is not, as the
	// round-four commit message said, byte-identical: the recorded line:col moves
	// and both content digests shift with it. The true reason to keep it
	// unexported is that exporting it would put a synthetic executor one frame
	// from a production API — so this pins the property the reason is about,
	// rather than the checker behaviour that was invented for it.
	test("the campaign publishes no synthetic executor", () => {
		expect(Object.keys(campaignModule)).not.toContain("measureCellArm");
		expect(
			(campaignModule as Record<string, unknown>).measureCellArm,
		).toBeUndefined();
	});
});
