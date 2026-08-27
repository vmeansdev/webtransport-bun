import { describe, expect, test } from "bun:test";
import { buildRunArtifact } from "./artifact-builder.ts";
import { type ArtifactRejectionCode, sealRunArtifact } from "./evidence.ts";
import {
	checkPromotionQuarantine,
	ComparisonOutputPolicyError,
} from "./output-policy.ts";
import { renderMarkdownReport } from "./render-report.ts";
import { parseCampaignArgs, runCampaign } from "./run-campaign.ts";
import {
	formatOfficialIoAudit,
	runOfficialIoAudit,
} from "./check-official-io.ts";
import {
	trustContextForArtifact as verifyTrustContext,
	verifyRunArtifact,
	verifyRunArtifactObject,
} from "./verify-artifact.ts";
import type { ManifestRunEntry } from "./r1-fixtures.ts";
import {
	R1_CAMPAIGN_AUTHORITY_SHA256,
	R1_CAMPAIGN_AUTHORITY_BYTES,
	R1_CAMPAIGN_LOCK,
	R1_CAMPAIGN_LOCK_BYTES,
	R1_CAMPAIGN_MANIFEST_V1,
	R1_CAMPAIGN_MANIFEST_V1_BYTES,
	R1_CAMPAIGN_MANIFEST_V1_SHA256,
	R1_NO_BYPASS_FORBIDDEN_SURFACES,
	R1_OFFICIAL_CHILD_ROOTS,
	R1_PUBLICATION_ORDER,
	R1_RESERVED_OUTPUT_NAMES,
	R1_RECOVERY_MODES,
	R1_RED_COMMAND_SET_BYTES,
	R1_RED_COMMAND_SET_SHA256,
	R1_RED_FAILURE_INVENTORY,
	byteFlip,
	canonicalBytes,
	importExpectedModule,
	requiredExport,
	representativeFixture,
	sha256Hex,
} from "./r1-fixtures.ts";

type CallableExpectedModule = Record<string, (...args: unknown[]) => unknown>;

/**
 * RED tests must fail when an approved production export is absent.  Calling
 * through this helper keeps the assertion typed without turning a missing
 * implementation into an optional-chain pass.
 */
function callRequired(
	moduleValue: CallableExpectedModule,
	exportName: string,
	input: unknown,
): unknown {
	return requiredExport(moduleValue, exportName)(input);
}

function captureError(operation: () => unknown): unknown {
	try {
		operation();
		return undefined;
	} catch (error: unknown) {
		return error;
	}
}

describe("R1 RED: builder and CLI contracts", () => {
	test("legacy fixture stays rejected and measured artifact construction requires explicit validated lock, capability, artifact, raw, and snapshot inputs", async () => {
		const fixture = representativeFixture();
		const builder = (await importExpectedModule(
			"./artifact-builder.ts",
		)) as Record<string, (args: unknown) => unknown>;

		expect(
			callRequired(builder, "verifyPromotableMeasuredArtifact", {
				artifactBytes: fixture.legacyFixtureBytes,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TEST_FIXTURE_NONPROMOTABLE",
			}),
		);
		for (const incompleteInput of [
			{
				lockBytes: fixture.lockBytes,
				expectedLockDigest: fixture.expectedLockDigest,
			},
			{
				lockBytes: fixture.lockBytes,
				expectedLockDigest: fixture.expectedLockDigest,
				capabilityBytes: fixture.stagedCapabilityBytes,
				expectedCapabilityDigest: fixture.expectedCapabilityDigest,
			},
			{
				...fixture.explicitMeasuredBuildInput,
				artifactBytes: undefined,
			},
			{
				...fixture.explicitMeasuredBuildInput,
				rawBytesByPath: undefined,
			},
			{
				...fixture.explicitMeasuredBuildInput,
				snapshotBytesByPath: undefined,
			},
		]) {
			expect(
				callRequired(
					builder,
					"buildMeasuredArtifactFromValidatedInputs",
					incompleteInput,
				),
			).toEqual(
				expect.objectContaining({
					ok: false,
					code: "MEASURED_ARTIFACT_INPUT_INCOMPLETE",
				}),
			);
		}
		expect(
			callRequired(
				builder,
				"buildMeasuredArtifactFromValidatedInputs",
				fixture.explicitMeasuredBuildInput,
			),
		).toEqual(
			expect.objectContaining({
				ok: true,
				candidateId: fixture.candidateId,
				campaignId: fixture.campaignId,
				runInstanceId: (
					fixture.explicitMeasuredBuildInput.runEntry as ManifestRunEntry
				).runInstanceId,
				artifactKind: "measured",
				artifactBytes: fixture.explicitMeasuredBuildInput.artifactBytes,
				artifactDigestSha256:
					fixture.explicitMeasuredBuildInput.artifactDigestSha256,
				artifact: fixture.explicitMeasuredBuildInput.expectedArtifact,
			}),
		);
		for (const [input, code] of [
			[
				{
					...fixture.explicitMeasuredBuildInput,
					artifactBytes: byteFlip(
						fixture.explicitMeasuredBuildInput.artifactBytes as Uint8Array,
					),
				},
				"MEASURED_ARTIFACT_BYTES_MISMATCH",
			],
			[
				{
					...fixture.explicitMeasuredBuildInput,
					artifactDescriptor: {
						...(fixture.explicitMeasuredBuildInput.artifactDescriptor as Record<
							string,
							unknown
						>),
						sha256: "0".repeat(64),
					},
				},
				"MEASURED_ARTIFACT_DESCRIPTOR_DIGEST_MISMATCH",
			],
			[
				{
					...fixture.explicitMeasuredBuildInput,
					lockBytes: byteFlip(fixture.lockBytes),
				},
				"MEASURED_ARTIFACT_LOCK_BYTES_MISMATCH",
			],
			[
				{
					...fixture.explicitMeasuredBuildInput,
					capabilityBytes: byteFlip(fixture.stagedCapabilityBytes),
				},
				"MEASURED_ARTIFACT_CAPABILITY_BYTES_MISMATCH",
			],
			[
				{
					...fixture.explicitMeasuredBuildInput,
					expectedArchiveDigest: "f".repeat(64),
				},
				"MEASURED_ARTIFACT_ARCHIVE_DIGEST_MISMATCH",
			],
			[
				{
					...fixture.explicitMeasuredBuildInput,
					rawBytesByPath: {
						...fixture.rawBytesByPath,
						[(fixture.explicitMeasuredBuildInput.runEntry as ManifestRunEntry)
							.rawDescriptors[0]!.relativePath]: byteFlip(
							fixture.rawBytesByPath[
								(
									fixture.explicitMeasuredBuildInput
										.runEntry as ManifestRunEntry
								).rawDescriptors[0]!.relativePath
							]!,
						),
					},
				},
				"MEASURED_ARTIFACT_RAW_BYTES_MISMATCH",
			],
			[
				{
					...fixture.explicitMeasuredBuildInput,
					snapshotBytesByPath: {
						...fixture.snapshotBytesByPath,
						[(fixture.explicitMeasuredBuildInput.runEntry as ManifestRunEntry)
							.cellSnapshotBundle.postCell.relativePath]: byteFlip(
							fixture.snapshotBytesByPath[
								(
									fixture.explicitMeasuredBuildInput
										.runEntry as ManifestRunEntry
								).cellSnapshotBundle.postCell.relativePath
							]!,
						),
					},
				},
				"MEASURED_ARTIFACT_SNAPSHOT_BYTES_MISMATCH",
			],
		] as const) {
			expect(
				callRequired(
					builder,
					"buildMeasuredArtifactFromValidatedInputs",
					input,
				),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});

	test("campaign CLI parser requires explicit candidate, campaign, staged capability locator, capability digest, lock digest, and archive digest", () => {
		const fixture = representativeFixture();

		expect(
			parseCampaignArgs([
				"--candidate",
				fixture.candidateId,
				"--campaign-id",
				fixture.campaignId,
				"--staged-capability",
				"official/staging/capabilities/campaign-r1.cap",
				"--capability-digest",
				fixture.expectedCapabilityDigest,
				"--lock-digest",
				fixture.expectedLockDigest,
				"--archive-digest",
				sha256Hex(fixture.archiveBytes),
			]) as unknown as Record<string, unknown>,
		).toEqual(
			expect.objectContaining({
				candidate: fixture.candidateId,
				campaignId: fixture.campaignId,
				stagedCapabilityPath: "official/staging/capabilities/campaign-r1.cap",
				capabilityDigestSha256: fixture.expectedCapabilityDigest,
				lockDigestSha256: fixture.expectedLockDigest,
				archiveDigestSha256: sha256Hex(fixture.archiveBytes),
			}),
		);
	});

	test("campaign CLI parser rejects each missing required argument, invalid digests, and unbound defaults", () => {
		const fixture = representativeFixture();
		const validArgs = [
			"--candidate",
			fixture.candidateId,
			"--campaign-id",
			fixture.campaignId,
			"--staged-capability",
			"official/staging/capabilities/campaign-r1.cap",
			"--capability-digest",
			fixture.expectedCapabilityDigest,
			"--lock-digest",
			fixture.expectedLockDigest,
			"--archive-digest",
			sha256Hex(fixture.archiveBytes),
		];

		expect(() => parseCampaignArgs([])).toThrow(
			/MISSING_CANDIDATE|MISSING_CAMPAIGN|MISSING_STAGED_CAPABILITY|candidate|campaign|staged-capability/i,
		);

		for (const [flag, code] of [
			["--candidate", "CAMPAIGN_ARG_MISSING_CANDIDATE"],
			["--campaign-id", "CAMPAIGN_ARG_MISSING_CAMPAIGN"],
			["--staged-capability", "CAMPAIGN_ARG_MISSING_STAGED_CAPABILITY"],
			["--capability-digest", "CAMPAIGN_ARG_MISSING_CAPABILITY_DIGEST"],
			["--lock-digest", "CAMPAIGN_ARG_MISSING_LOCK_DIGEST"],
			["--archive-digest", "CAMPAIGN_ARG_MISSING_ARCHIVE_DIGEST"],
		] as const) {
			const flagIndex = validArgs.indexOf(flag);
			const missingArgs = validArgs.filter(
				(_, index) => index !== flagIndex && index !== flagIndex + 1,
			);
			expect(() => parseCampaignArgs(missingArgs)).toThrow(
				new RegExp(code, "i"),
			);
		}

		for (const [flag, code] of [
			["--capability-digest", "CAMPAIGN_ARG_INVALID_CAPABILITY_DIGEST"],
			["--lock-digest", "CAMPAIGN_ARG_INVALID_LOCK_DIGEST"],
			["--archive-digest", "CAMPAIGN_ARG_INVALID_ARCHIVE_DIGEST"],
		] as const) {
			const flagIndex = validArgs.indexOf(flag);
			const invalidArgs = [...validArgs];
			invalidArgs[flagIndex + 1] = "xyz-not-hex";
			expect(() => parseCampaignArgs(invalidArgs)).toThrow(
				new RegExp(code, "i"),
			);
		}
	});
});

describe("R1 RED: amendment official entrypoint contracts", () => {
	test("verdict and promotability matrix must keep PASS/MISS visible but nonpromotable, only PASS/PASS promotable true, and reject contradictions", async () => {
		const mod = (await importExpectedModule("./verify-artifact.ts")) as Record<
			string,
			(args: unknown) => unknown
		>;

		for (const [input, expected] of [
			[
				{ evidenceStatus: "PASS", scenarioVerdict: "PASS" },
				{ ok: true, promotable: true },
			],
			[
				{ evidenceStatus: "PASS", scenarioVerdict: "MISS" },
				{ ok: true, promotable: false, numericDataVisible: true },
			],
			[
				{ evidenceStatus: "BLOCKED", scenarioVerdict: "NO_VERDICT" },
				{ ok: true, promotable: false },
			],
			[
				{ evidenceStatus: "FAIL", scenarioVerdict: "NO_VERDICT" },
				{ ok: true, promotable: false },
			],
		] as const) {
			expect(callRequired(mod, "classifyVerdictTuple", input)).toEqual(
				expect.objectContaining(expected),
			);
		}
		for (const bad of [
			{ evidenceStatus: "PASS", scenarioVerdict: "NO_VERDICT" },
			{ evidenceStatus: "FAIL", scenarioVerdict: "MISS" },
			{ evidenceStatus: "BLOCKED", scenarioVerdict: "MISS" },
			{ evidenceStatus: "BLOCKED", scenarioVerdict: "PASS" },
			{ evidenceStatus: "BLOCKED", scenarioVerdict: "BLOCKED" },
		]) {
			expect(callRequired(mod, "classifyVerdictTuple", bad)).toEqual(
				expect.objectContaining({
					ok: false,
					code: "VERDICT_TUPLE_CONTRADICTION",
				}),
			);
		}
	});

	test("verify/report CLI syntax must require staged capability arguments, while capability content mismatch belongs to the loader with an injected reader", async () => {
		const fixture = representativeFixture();
		const verify = (await importExpectedModule(
			"./verify-artifact.ts",
		)) as Record<string, (args: unknown) => unknown>;
		const report = (await importExpectedModule("./render-report.ts")) as Record<
			string,
			(args: unknown) => unknown
		>;
		const capability = (await importExpectedModule(
			"./staged-capability.ts",
		)) as Record<string, (args: unknown) => unknown>;

		expect(
			callRequired(verify, "parseVerifyArgs", [
				"--candidate",
				fixture.candidateId,
				"--campaign-id",
				fixture.campaignId,
				"--staged-capability",
				"official/staging/capabilities/campaign-r1.cap",
				"--capability-digest",
				fixture.expectedCapabilityDigest,
				"--lock-digest",
				fixture.expectedLockDigest,
				"--archive-digest",
				sha256Hex(fixture.archiveBytes),
				"official/release-evidence/transport-comparison/candidate/campaign",
			]),
		).toEqual(expect.objectContaining({ candidateId: fixture.candidateId }));
		expect(
			callRequired(report, "parseReportArgs", [
				"--candidate",
				fixture.candidateId,
				"--campaign-id",
				fixture.campaignId,
				"--staged-capability",
				"official/staging/capabilities/campaign-r1.cap",
				"--capability-digest",
				fixture.expectedCapabilityDigest,
				"--lock-digest",
				fixture.expectedLockDigest,
				"--archive-digest",
				sha256Hex(fixture.archiveBytes),
			]),
		).toEqual(expect.objectContaining({ campaignId: fixture.campaignId }));
		expect(
			callRequired(capability, "loadStagedTrustCapability", {
				locator: "official/staging/capabilities/campaign-r1.cap",
				expectedCapabilityDigest: "f".repeat(64),
				expectedLockDigest: fixture.expectedLockDigest,
				expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
				expectedCandidateId: fixture.candidateId,
				expectedCampaignId: fixture.campaignId,
				nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
				readBytes: () => fixture.stagedCapabilityBytes,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_CAPABILITY_DIGEST_MISMATCH",
			}),
		);
	});

	test("official entrypoints are exactly four descriptor-launched roots and package commands remain fixture-only", async () => {
		const campaign = await importExpectedModule("./run-campaign.ts");
		const artifact = await importExpectedModule("./artifact-builder.ts");
		const verify = await importExpectedModule("./verify-artifact.ts");
		const report = await importExpectedModule("./render-report.ts");
		expect(
			callRequired(campaign, "validateOfficialEntrypointContract", {
				roots: R1_OFFICIAL_CHILD_ROOTS,
				fixtureOnly: true,
				authority: undefined,
			}),
		).toEqual(expect.objectContaining({ ok: true, rootCount: 4 }));
		expect(
			callRequired(artifact, "validateOfficialEntrypointContract", {
				roots: R1_OFFICIAL_CHILD_ROOTS,
				fixtureOnly: true,
				authority: undefined,
			}),
		).toEqual(expect.objectContaining({ ok: true, rootCount: 4 }));
		expect(
			callRequired(verify, "validateOfficialEntrypointContract", {
				roots: R1_OFFICIAL_CHILD_ROOTS,
				fixtureOnly: true,
				authority: undefined,
			}),
		).toEqual(expect.objectContaining({ ok: true, rootCount: 4 }));
		expect(
			callRequired(report, "validateOfficialEntrypointContract", {
				roots: R1_OFFICIAL_CHILD_ROOTS,
				fixtureOnly: true,
				authority: undefined,
			}),
		).toEqual(expect.objectContaining({ ok: true, rootCount: 4 }));
		for (const [moduleValue, input, code] of [
			[
				campaign,
				{ fixtureOnly: false, authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256 },
				"TRUST_FIXTURE_ONLY_REQUIRED",
			],
			[
				artifact,
				{ fixtureOnly: true, authorityFd: 3 },
				"TRUST_OFFICIAL_HANDLE_FORBIDDEN",
			],
			[
				verify,
				{ fixtureOnly: true, authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256 },
				"TRUST_OFFICIAL_CAPABILITY_FORBIDDEN",
			],
			[
				report,
				{ fixtureOnly: true, rootPath: "official/release-evidence" },
				"TRUST_PATH_LOCATOR_FORBIDDEN",
			],
		] as const) {
			expect(
				callRequired(moduleValue, "validateFixtureOnlyEntrypoint", input),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		expect(
			callRequired(campaign, "parseRecoveryMode", {
				mode: R1_RECOVERY_MODES[0],
				fixtureOnly: false,
			}),
		).toEqual(expect.objectContaining({ ok: true, mode: "verify-existing" }));
		expect(
			callRequired(report, "parseRecoveryMode", {
				mode: R1_RECOVERY_MODES[1],
				fixtureOnly: false,
			}),
		).toEqual(expect.objectContaining({ ok: true, mode: "report-existing" }));
	});

	test("official publication follows the exact seven-step order and never selects manifest, verifier, or report outputs", async () => {
		const mod = await importExpectedModule("./supervisor-client.ts");
		expect(
			callRequired(mod, "validateOfficialPublicationOrder", {
				steps: R1_PUBLICATION_ORDER,
				reservedOutputs: R1_RESERVED_OUTPUT_NAMES,
				manifestSelectedPaths: [
					"official/artifacts/a.json",
					"official/raw/a/client.ndjson",
				],
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				stepCount: 7,
				reservedOutputCount: 4,
			}),
		);
		for (const [steps, code] of [
			[[...R1_PUBLICATION_ORDER].reverse(), "OUTPUT_PUBLICATION_ORDER_INVALID"],
			[
				[...R1_PUBLICATION_ORDER].slice(0, 6),
				"OUTPUT_PUBLICATION_ORDER_INVALID",
			],
			[
				[...R1_PUBLICATION_ORDER, "manifest"],
				"OUTPUT_PUBLICATION_ORDER_DUPLICATE",
			],
		] as const) {
			expect(
				callRequired(mod, "validateOfficialPublicationOrder", {
					steps,
					reservedOutputs: R1_RESERVED_OUTPUT_NAMES,
					manifestSelectedPaths: ["official/manifest.json"],
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		expect(
			callRequired(mod, "validateOfficialPublicationOrder", {
				steps: R1_PUBLICATION_ORDER,
				reservedOutputs: R1_RESERVED_OUTPUT_NAMES,
				manifestSelectedPaths: [
					"official/verifier-result.json",
					"official/report.json",
				],
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "MANIFEST_RESERVED_OUTPUT_SELECTED",
			}),
		);
	});

	test("official entrypoint allowlist and runtime spies reject every filesystem, enumeration, synthetic executor, and addon fallback bypass", async () => {
		const mod = await importExpectedModule("./supervisor-client.ts");
		expect(
			callRequired(mod, "validateOfficialIoAllowlist", {
				roots: R1_OFFICIAL_CHILD_ROOTS,
				forbiddenSurfaces: R1_NO_BYPASS_FORBIDDEN_SURFACES,
				fixtureOnly: true,
			}),
		).toEqual(expect.objectContaining({ ok: true, rootCount: 4 }));
		expect(
			callRequired(mod, "runOfficialEntrypointIoSpies", {
				roots: R1_OFFICIAL_CHILD_ROOTS,
				forbiddenSurfaces: R1_NO_BYPASS_FORBIDDEN_SURFACES,
				fixtureOnly: true,
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				filesystemCalls: 0,
				networkCalls: 0,
			}),
		);
		for (const [surface, code] of [
			["node:fs", "OUTPUT_OFFICIAL_IO_BYPASS"],
			["Bun.file", "OUTPUT_OFFICIAL_IO_BYPASS"],
			["readdirSync", "OUTPUT_DIRECTORY_ENUMERATION_FORBIDDEN"],
			["measureCellArm", "OUTPUT_SYNTHETIC_EXECUTOR_FORBIDDEN"],
			["pathname-addon-fallback", "OUTPUT_ADDON_FALLBACK_FORBIDDEN"],
			["dynamic-import", "OUTPUT_DYNAMIC_IMPORT_FORBIDDEN"],
		] as const) {
			expect(
				callRequired(mod, "runOfficialEntrypointIoSpies", {
					roots: R1_OFFICIAL_CHILD_ROOTS,
					forbiddenSurfaces: R1_NO_BYPASS_FORBIDDEN_SURFACES,
					injectedBypass: surface,
					fixtureOnly: true,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});

	test("real load-lock-manifest-verify-promote-report flow is typed, bounded, and fails closed before official I/O", async () => {
		const fixture = representativeFixture();
		const loadedLock = JSON.parse(
			new TextDecoder().decode(canonicalBytes(R1_CAMPAIGN_LOCK)),
		) as Record<string, unknown>;
		const loadedManifest = JSON.parse(
			new TextDecoder().decode(canonicalBytes(R1_CAMPAIGN_MANIFEST_V1)),
		) as Record<string, unknown>;
		expect(loadedLock.schema).toBe("campaign-lock/v1");
		expect(loadedManifest.schema).toBe("campaign-manifest/v1");
		expect((loadedManifest.descriptors as unknown[]).length).toBe(4679);
		expect(
			(loadedLock.cardinality as Record<string, unknown>).executionCount,
		).toBe(768);
		expect(fixture.manifest).toEqual(
			expect.objectContaining({
				schema: "campaign-manifest/v1",
				authoritySha256: R1_CAMPAIGN_LOCK.authoritySha256,
			}),
		);

		const artifact = buildRunArtifact({
			comparisonId: fixture.campaignId,
			runId: "measured/chat-fanout/subscribers-1000/ws/rep-01",
			cellId: "chat-fanout/subscribers-1000",
			transport: "ws",
			seed: 20260824,
			repetitionIndex: 1,
			totalRepetitions: 5,
			samples: [...Array(500).fill(10), ...Array(500).fill(14)],
			percentiles: {
				// rank 0.01 x 999 = 9.99, and values[9] === values[10] === 10,
				// so this is exact with no interpolation.
				p1: 10,
				// rank 499.5 interpolates values[499]=10 and values[500]=14.
				p50: 12,
				p95: 14,
				p99: 14,
			},
			// Not all-equal, so `LEDGER_FUNNEL_DEGENERATE` can be switched on
			// later without editing a frozen byte here.
			ledger: {
				attempted: 1000,
				queued: 1000,
				serverObserved: 998,
				acknowledged: 997,
				delivered: 996,
				dropped: 4,
			},
		});
		const sealedArtifact = sealRunArtifact(artifact);
		const objectVerification = verifyRunArtifactObject(
			artifact,
			verifyTrustContext(artifact),
		);
		expect(objectVerification.evidenceStatus).toBe("FAIL");
		expect(objectVerification.rejections.map(({ code }) => code)).toContain(
			"ARTIFACT_BYTE_DIGEST_MISMATCH",
		);
		const verification = verifyRunArtifact(
			sealedArtifact,
			verifyTrustContext(artifact),
		);
		expect(verification.evidenceStatus).toBe("PASS");
		expect(verification.rejections).toEqual([]);

		const quarantine = checkPromotionQuarantine({
			artifact,
			externalTrustBound: "r1-fixture-external-bound",
			expectedComparisonId: fixture.campaignId,
		});
		expect(quarantine.promotable).toBe(false);
		expect(quarantine.reasons.map(({ code }) => code)).toEqual(
			expect.arrayContaining([
				"EXTERNAL_TRUST_BOUND_UNVALIDATED",
				"LEGACY_SYNTHETIC_SOURCE",
				"SENTINEL_SIDECAR_DIGEST",
			]),
		);

		const markdown = renderMarkdownReport({
			campaignId: fixture.campaignId,
			generatedAt: "2026-08-24T12:00:00.000Z",
			totalCells: 1,
			comparableCells: 0,
			rejectedCells: 1,
			comparisons: [
				{
					cellId: "chat-fanout/subscribers-1000",
					scenarioId: "chat-fanout",
					status: "INCOMPATIBLE",
					rejectionReason: "quarantined by external trust boundary",
				},
			],
		});
		expect(markdown).toContain("0/1 cells comparable");
		expect(markdown).toContain("quarantined by external trust boundary");

		let entrypointError: unknown;
		try {
			await runCampaign({
				scenarios: ["chat-fanout"],
				transports: "ws",
				candidate: fixture.candidateId,
				campaignId: fixture.campaignId,
				outputDir: ".release-evidence/transport-comparison/r1-red/no-write",
			});
		} catch (error: unknown) {
			entrypointError = error;
		}
		expect(entrypointError).toBeInstanceOf(ComparisonOutputPolicyError);
		expect((entrypointError as ComparisonOutputPolicyError).code).toBe(
			"OUTPUT_TRUST_BOUNDARY_UNAVAILABLE",
		);
	});

	test("public entrypoint flow propagates load, lock/manifest verification, promotion, and report through injected socket-free seams", async () => {
		const campaign = await importExpectedModule("./run-campaign.ts");
		const events: string[] = [];
		let networkStarts = 0;
		const bootstrap = new Map<string, Uint8Array>([
			["authority", R1_CAMPAIGN_AUTHORITY_BYTES],
			["campaign-lock", R1_CAMPAIGN_LOCK_BYTES],
			["manifest", R1_CAMPAIGN_MANIFEST_V1_BYTES],
		]);
		const result = await callRequired(campaign, "runOfficialEntrypointFlow", {
			fixtureOnly: true,
			authority: {
				bytes: R1_CAMPAIGN_AUTHORITY_BYTES,
				digest: R1_CAMPAIGN_AUTHORITY_SHA256,
			},
			load: {
				readBootstrap: async (name: string) => {
					events.push(`load:${name}`);
					const bytes = bootstrap.get(name);
					if (!bytes) throw new Error(`unexpected bootstrap read: ${name}`);
					return bytes;
				},
				readAuthority: async () => {
					events.push("load:authority");
					return R1_CAMPAIGN_AUTHORITY_BYTES;
				},
				readLock: async () => {
					events.push("load:campaign-lock");
					return R1_CAMPAIGN_LOCK_BYTES;
				},
				readManifest: async () => {
					events.push("load:manifest");
					return R1_CAMPAIGN_MANIFEST_V1_BYTES;
				},
			},
			verify: {
				lock: (bytes: Uint8Array) => {
					events.push("verify:lock");
					expect(bytes).toEqual(R1_CAMPAIGN_LOCK_BYTES);
					return { ok: true, schema: "campaign-lock/v1", bytes };
				},
				manifest: (bytes: Uint8Array) => {
					events.push("verify:manifest");
					expect(bytes).toEqual(R1_CAMPAIGN_MANIFEST_V1_BYTES);
					return {
						ok: true,
						schema: "campaign-manifest/v1",
						descriptorCount: 4679,
						bytes,
					};
				},
			},
			promotion: {
				promote: (verified: unknown) => {
					events.push("promote");
					return { ok: true, promoted: false, verified };
				},
				renderReport: (promoted: unknown) => {
					events.push("report");
					return {
						ok: true,
						report: promoted,
						manifestSha256: R1_CAMPAIGN_MANIFEST_V1_SHA256,
					};
				},
			},
			spawnRole: () => {
				networkStarts += 1;
				throw new Error("RED flow must not start a role or network");
			},
		});
		expect(events).toEqual([
			"load:authority",
			"load:campaign-lock",
			"verify:lock",
			"load:manifest",
			"verify:manifest",
			"promote",
			"report",
		]);
		expect(networkStarts).toBe(0);
		expect(result).toEqual(
			expect.objectContaining({ ok: true, promoted: false }),
		);
	});

	test("tracked official-I/O checker and runtime-spy contracts expose a deterministic RED inventory without source-substring coverage", () => {
		const first = runOfficialIoAudit({ repoRoot: process.cwd() });
		const second = runOfficialIoAudit({ repoRoot: process.cwd() });
		expect(first.schema).toBe("comparison-official-io-allowlist/v1");
		expect(first.status).toBe("FAIL");
		expect(first).toEqual(second);
		expect(first.failureCount).toBe(first.failures.length);
		expect(formatOfficialIoAudit(first)).toBe(formatOfficialIoAudit(second));
		expect(sha256Hex(R1_RED_COMMAND_SET_BYTES)).toBe(R1_RED_COMMAND_SET_SHA256);
		const expectedInventoryKeys = new Set(
			R1_RED_FAILURE_INVENTORY.map(({ code, file }) => `${code}|${file}`),
		);
		expect(expectedInventoryKeys.size).toBe(R1_RED_FAILURE_INVENTORY.length);
		const observedCheckerKeys = new Set(
			first.failures.map(({ code, file }) => `${code}|${file}`),
		);
		expect(
			[...observedCheckerKeys].every((key) => expectedInventoryKeys.has(key)),
		).toBe(true);
		expect(observedCheckerKeys.size).toBeGreaterThan(0);
		for (const requiredKey of [
			"ALLOWLIST_FILE_MISSING|tools/compare/staged-capability.ts",
			"ALLOWLIST_FILE_MISSING|tools/compare/supervisor-client.ts",
			"LEGACY_OVERLAY_DISCRIMINANT_PRESENT|tools/compare/run-campaign.ts",
			"TYPED_CLI_CONTRACT_MISSING|tools/compare/run-campaign.ts",
		]) {
			expect(expectedInventoryKeys.has(requiredKey)).toBe(true);
		}
		// The mutable checker digest is observed and compared only for repeatability;
		// it is intentionally not embedded in the immutable R1 fixture inventory.
		expect(first.failureInventorySha256).toMatch(/^[0-9a-f]{64}$/u);
	});

	test("every field the round reserved is present, typed, and carries its declared round-8 value", () => {
		// A reserved field is never absent: the canonical bytes have to be
		// deterministic, and "we forgot" must not be spellable as a missing key.
		// This is shape-only by construction — no producer for any of these
		// lands in round 8 — but the shape is exactly what a later round would
		// have had to reopen the bundle to add.
		const artifact = buildRunArtifact({
			comparisonId: "reserved-shape",
			runId: "measured/chat-fanout/subscribers-1000/ws/rep-01",
			cellId: "chat-fanout/subscribers-1000",
			transport: "ws",
			seed: 20260824,
			repetitionIndex: 1,
			totalRepetitions: 5,
			samples: [...Array(500).fill(10), ...Array(500).fill(14)],
			percentiles: { p1: 10, p50: 12, p95: 14, p99: 14 },
			ledger: {
				attempted: 1000,
				queued: 1000,
				serverObserved: 998,
				acknowledged: 997,
				delivered: 996,
				dropped: 4,
			},
		});

		// The pacer already measures lateness and skipped slots; the artifact
		// could not carry them, which is the one confound disclosure cannot
		// repair, because the slow samples are simply absent from the data.
		expect(artifact.ledger.offered).toBe(0);
		expect(artifact.ledger.latenessMs).toBe(0);
		expect(artifact.ledger.skippedSlots).toBe(0);
		expect(artifact.ledger.senderStalledMs).toBe(0);
		expect(artifact.ledger.harnessOverheadBytes).toBe(0);
		expect(artifact.ledger.warmup.discardedSamples).toBe(0);
		expect(artifact.ledger.digestVerified).toBeNull();
		expect(artifact.ledger.snapshotHash).toBeNull();
		// `sinkStats` is null on every arm but the sink, and the sink arm is not
		// implemented, so null here is the truth rather than a placeholder.
		expect(artifact.ledger.sinkStats).toBeNull();
		// Populated, not reserved: each arm's shedding policy and the mechanism
		// each capacity parameter is actually applied through are facts about
		// the adapters that are true today.
		expect(artifact.ledger.sheddingPolicy).toBe("drop-and-count");
		expect(artifact.ledger.profileApplication).toEqual({
			backpressureTimeoutMs: "unenforced",
			maxQueuedBytesPerStream: "bun:maxPayloadLength",
			handshakesBurst: "js:AdmissionController",
		});

		// One artifact spans two hosts, so the arm block sits inside the host
		// block: the client's receiver loop is a Mac quantity and the server's
		// per-thread CPU is a Linux one, and a single artifact-scoped block
		// could have held only one of them.
		for (const host of ["mac", "linux"] as const) {
			expect(artifact.telemetry[host].arm).toEqual({
				loopUtilizationPercent: 0,
				loopLagMs: { p50: 0, p95: 0, p99: 0 },
				threadCpu: [],
				bytesAllocatedPerMessage: 0,
				gcPauseMs: 0,
			});
			// A digest of a declared empty allowlist, never the empty string:
			// `SCHED_RR` arrives as a stale export in one operator's shell on one
			// machine, and "empty" must stay distinguishable from "we forgot".
			expect(artifact.runtime[host].envDigest).toMatch(/^[0-9a-f]{64}$/u);
			expect(artifact.runtime[host].envAllowlistApplied).toBe(false);
			expect(artifact.capacityProof[host].fd.provenance).toBe("declared");
		}

		// The process side of the carve-out the round freezes into the
		// comparison document: `SO_REUSEPORT` is inherently multi-process, so a
		// threads-only obligation would disclose the wrong quantity.
		expect(artifact.processProof.readPathThreadModel).toBe("main-loop");
		expect(artifact.processProof.serverThreadCount).toBe(0);
		expect(artifact.processProof.serverThreadsProvenance).toBe("declared");
		expect(artifact.processProof.serverProcessCount).toBe(1);
		expect(artifact.processProof.serverProcessProvenance).toBe("declared");

		// "declared" is the truth about a hardcoded peer, and writing "measured"
		// would be the fabrication this round exists to stop.
		expect(artifact.topology.serverObservedPeer.provenance).toBe("declared");
		expect(artifact.topology.managementPath).toEqual({
			address: null,
			interface: null,
		});
		for (const host of ["mac", "linux"] as const) {
			const route = artifact.topology[host].route;
			expect(route.gateway).toBeNull();
			expect(route.raw.length).toBeGreaterThan(0);
			expect(route.neighbourEntry.linkLayerAddress).toMatch(
				/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/u,
			);
		}

		// netem's loss is per-skb, so the queue depth and the offload state
		// decide what a nominal percentage actually costs each arm.
		for (const state of [
			artifact.impairment.requested,
			artifact.impairment.observedBefore,
			artifact.impairment.observedAfter,
		]) {
			expect(state.limitPackets).toBeGreaterThan(0);
			expect(state.mtu).toBe(1500);
			expect(state.offload).toEqual({ tso: true, gso: true, gro: true });
			expect(state.observedLossPercent).toBeNull();
			expect(state.tcpNoDelay).toBeNull();
		}

		// R9 needs the sink's native stamp published beside the primary series
		// rather than as it; the overlay's metric is filtered by definition and
		// may not be printed unmarked beside the arms it shadows.
		expect(artifact.metrics.secondarySeries).toBeNull();
		expect(artifact.metrics.filtered).toEqual({
			applied: false,
			policy: null,
		});
		expect(artifact.scenario.saturatePct).toBe(0);
	});

	test("every rejection code the round names exists in the union, including the ones whose rules land later", () => {
		// A code is asserted by name inside a frozen test, so a code added in a
		// later round reopens the bundle exactly as surely as a field would.
		// Three of these carry no rule in round 8; this assertion is checked by
		// the type gate, which is where a missing union member shows up.
		const reserved: readonly ArtifactRejectionCode[] = [
			"RANKING_TIER_VIOLATION",
			"RANKING_SAME_WIRE",
			"WITHIN_PAIR_WIRE_MISMATCH",
			"WITHIN_PAIR_SAME_TIER",
			"ARM_IDENTITY_INCONSISTENT",
			"ARM_COUNT_MISMATCH",
			"MANIFEST_CARDINALITY_MISMATCH",
			"TOPOLOGY_INDIRECT_PATH",
			"METRICS_SAMPLES_BELOW_FLOOR",
			"METRICS_SAMPLE_COUNT_INCOMPATIBLE",
			// Rule lands with the WT counter fixes.
			"LEDGER_FUNNEL_DEGENERATE",
			// Rule lands with the open-loop pacer wiring.
			"PACER_SKIPPED_SLOTS_DIVERGENT",
			"WS_ARM_NOT_MEASURED",
			"WT_ARM_NOT_MEASURED",
			"WS_WORKER_ARM_NOT_MEASURED",
			"WT_STREAM_SINK_ARM_NOT_MEASURED",
			// Rule lands with the profile-application fix.
			"PROFILE_APPLICATION_MISMATCH",
		];
		expect(new Set(reserved).size).toBe(reserved.length);
	});

	test("a planned module that is allowlisted before it exists costs exactly two reserved inventory keys and no third", () => {
		const audit = runOfficialIoAudit({ repoRoot: process.cwd() });
		const inventoryKeys = new Set(
			R1_RED_FAILURE_INVENTORY.map(({ code, file }) => `${code}|${file}`),
		);
		const observed = audit.failures.map(({ code, file }) => `${code}|${file}`);
		// `STATIC_IMPORT_ALLOWLIST_EXTRA` is reported at `${root}/${edge.from}`
		// while `edge.from` is already repo-relative, so the emitted path is
		// doubled. These keys are pasted from a run rather than composed, because
		// composing the un-doubled form would flip this test red for a reason
		// that has nothing to do with the reservation it exists to prove.
		for (const [module, extraPath] of [
			[
				"tools/compare/adapters/ws-worker.ts",
				"tools/compare/tools/compare/adapters/ws-worker.ts",
			],
			[
				"tools/compare/adapters/wt-stream-sink.ts",
				"tools/compare/tools/compare/adapters/wt-stream-sink.ts",
			],
			[
				"tools/compare/adapters/sink-worker.ts",
				"tools/compare/tools/compare/adapters/sink-worker.ts",
			],
			[
				"tools/compare/saturator.ts",
				"tools/compare/tools/compare/saturator.ts",
			],
		] as const) {
			const reserved = [
				`ALLOWLIST_FILE_MISSING|${module}`,
				`STATIC_IMPORT_ALLOWLIST_EXTRA|${extraPath}`,
			];
			for (const key of reserved) {
				expect(inventoryKeys.has(key)).toBe(true);
				expect(observed).toContain(key);
			}
			// Nothing else: a planned module that produced a third key would be
			// an unreserved key the day it landed, which is a bundle reopen.
			const basename = module.slice(module.lastIndexOf("/") + 1);
			expect(
				[...new Set(observed.filter((key) => key.includes(basename)))].sort(),
			).toEqual([...reserved].sort());
		}
		// When each module lands, both of its keys simply disappear: the frozen
		// assertion is `observed subset expected`, so a key going away is free.
		// That asymmetry is what makes the reservation cost one edit now and none
		// later, and it is why the two stale keys are not inventory rot.
		expect(observed.every((key) => inventoryKeys.has(key))).toBe(true);
	});

	test("typed CLI errors preserve platform rejection, canonical stderr, empty stdout, and no child/process side effects", () => {
		const error = captureError(() =>
			parseCampaignArgs(["--platform", "windows"]),
		);
		expect(error).toBeInstanceOf(Error);
		const typed = error as Error & {
			code: string;
			stderr: string;
			stdout: string;
			spawnedChildren: number;
			pgidDrained: boolean;
		};
		expect(typed.code).toBe("OUTPUT_PLATFORM_UNSUPPORTED");
		expect(typed.stderr).toBe(
			"[campaign] Error: OUTPUT_PLATFORM_UNSUPPORTED\n",
		);
		expect(typed.stdout).toBe("");
		expect(typed.spawnedChildren).toBe(0);
		expect(typed.pgidDrained).toBe(true);
	});
});
