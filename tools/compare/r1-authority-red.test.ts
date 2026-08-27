// Coverage ownership (Task A step 1, one exclusive owner per assertion): the
// amendment's step-4 item "import/process-start no-I/O Windows result" is
// owned by r1-secure-fs-red.test.ts (import-time result) and
// r1-entrypoint-red.test.ts (process-start result); this file owns every
// other step-4 authority-schema assertion.
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical.ts";
import {
	R1_AUTHORITY_DIGEST_GRAPH,
	R1_AUTHORITY_APPROVAL,
	R1_AUTHORITY_ROOTS,
	R1_CAMPAIGN_AUTHORITY,
	R1_CAMPAIGN_AUTHORITY_BYTES,
	R1_CAMPAIGN_AUTHORITY_SHA256,
	R1_CANDIDATE_ID,
	R1_FINAL_CANDIDATE_HEAD,
	R1_RED_APPROVAL_BUNDLE,
	R1_RED_APPROVAL_BUNDLE_BYTES,
	R1_RED_APPROVAL_BUNDLE_SHA256,
	R1_SOURCE_ARCHIVE_RECEIPT,
	R1_SOURCE_ARCHIVE_RECEIPT_BYTES,
	R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
	R1_CAMPAIGN_RESERVATION,
	R1_CAMPAIGN_RESERVATION_BYTES,
	R1_CAMPAIGN_RESERVATION_SHA256,
	R1_CAMPAIGN_LOCK,
	R1_CAMPAIGN_LOCK_BYTES,
	R1_CAMPAIGN_LOCK_SHA256,
	R1_SSH_HOST_RECEIPT,
	R1_SSH_HOST_RECEIPT_BYTES,
	R1_SSH_HOST_RECEIPT_SHA256,
	R1_STAGED_ARCHIVE_RECEIPT_BYTES,
	R1_STAGED_ARCHIVE_RECEIPT_SHA256S,
	R1_STAGED_ARCHIVE_RECEIPT_CANONICAL_SHA256S,
	R1_EXACT_APPROVAL_EXPECTED_INPUTS,
	R1_EXACT_APPROVAL_RECORDS,
	R1_EXACT_APPROVAL_RECORD_BYTES,
	R1_EXACT_APPROVAL_RECORD_SHA256S,
	R1_EXACT_APPROVAL_RECORD_SET_BYTES,
	R1_EXACT_APPROVAL_RECORD_SET_SHA256,
	R1_STAGED_METADATA_RECEIPT_BYTES,
	R1_STAGED_METADATA_RECEIPT_EXPECTED_SHA256S,
	R1_STAGED_METADATA_RECEIPT_SHA256S,
	R1_STAGED_METADATA_RECEIPT_SET_BYTES,
	R1_STAGED_METADATA_RECEIPT_SET_SHA256,
	R1_HOST_SUBMISSION_BYTES,
	R1_HOST_SUBMISSION_EXPECTED_SHA256S,
	R1_HOST_SUBMISSION_SHA256S,
	R1_RED_FAILURE_INVENTORY_BYTES,
	R1_RED_FAILURE_INVENTORY_SHA256,
	R1_REPRESENTATIVE_SUITE_FILE_SET_BYTES,
	R1_REPRESENTATIVE_SUITE_SHA256,
	R1_RED_APPROVAL_FIXTURE_METADATA,
	R1_STAGED_APPROVAL_FIXTURE_METADATA,
	R1_BUN_ROLE_LAUNCH_RECEIPT_SET,
	R1_BUN_ROLE_LAUNCH_RECEIPT_SET_BYTES,
	R1_BUN_ROLE_LAUNCH_RECEIPT_SET_SHA256,
	R1_BUN_ROLE_LAUNCH_RECEIPTS,
	R1_BUN_ROLE_LAUNCH_RECEIPTS_BYTES,
	R1_ROLE_TUPLE_ORACLE,
	R1_ROLE_TUPLE_ORACLE_BYTES,
	R1_ROLE_TUPLE_ORACLE_SHA256,
	R1_DESCRIPTOR_ONLY_ROLE_LOADS,
	R1_HOST_LAUNCH_PROVENANCE,
	R1_HOST_LAUNCH_PROVENANCE_BYTES,
	R1_HOST_LAUNCH_PROVENANCE_SHA256S,
	R1_HOST_LAUNCH_PROVENANCE_SET_BYTES,
	R1_HOST_LAUNCH_PROVENANCE_SET_SHA256,
	R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAPS,
	R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_BYTES,
	R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_SHA256S,
	R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_SET_BYTES,
	R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_SET_SHA256,
	R1_HOST_RUNTIME_FACTS,
	R1_HOST_RUNTIME_FACTS_BYTES,
	R1_HOST_RUNTIME_FACTS_SHA256S,
	R1_HOST_RUNTIME_FACTS_SET_BYTES,
	R1_HOST_RUNTIME_FACTS_SET_SHA256,
	R1_BUN_ROLE_LAUNCH_CONTRACT,
	R1_BUN_ROLE_LAUNCH_CONTRACT_BYTES,
	R1_BUN_ROLE_LAUNCH_CONTRACT_SHA256,
	R1_SUPERVISOR_INPUT_V1,
	R1_SUPERVISOR_INPUT_V1_BYTES,
	R1_SUPERVISOR_INPUT_V1_SHA256,
	R1_SUPERVISOR_OUTPUT_V1,
	R1_SUPERVISOR_OUTPUT_V1_BYTES,
	R1_SUPERVISOR_OUTPUT_V1_SHA256,
	R1_COMPARISON_SUPERVISOR_ERROR_V1,
	R1_COMPARISON_SUPERVISOR_ERROR_V1_BYTES,
	R1_COMPARISON_SUPERVISOR_ERROR_V1_SHA256,
	R1_SUPERVISOR_PHYSICAL_OBSERVATION,
	R1_SUPERVISOR_PHYSICAL_OBSERVATION_BYTES,
	R1_SUPERVISOR_PHYSICAL_OBSERVATION_SHA256,
	R1_STAGED_CAPABILITY_V1,
	R1_STAGED_CAPABILITY_V1_BYTES,
	R1_STAGED_CAPABILITY_V1_SHA256,
	byteFlip,
	canonicalBytes,
	flipHexDigest,
	importExpectedModule,
	requiredExport,
	representativeFixture,
	setAtPath,
	sha256Hex,
} from "./r1-fixtures.ts";

describe("R1 RED: lock, capability, manifest, and verdict contract", () => {
	test("campaign lock canonicalization must be key-order invariant, parse-roundtrip, and freeze the parsed value", async () => {
		const fixture = representativeFixture();
		const mod = (await importExpectedModule("./campaign-lock.ts")) as Record<
			string,
			(args: unknown) => unknown
		>;
		const reorderedLock = {
			executionPlan: fixture.lock.executionPlan as Record<string, unknown>,
			supervisorPolicy: fixture.lock.supervisorPolicy as Record<
				string,
				unknown
			>,
			resourceContract: fixture.lock.resourceContract as Record<
				string,
				unknown
			>,
			tls: fixture.lock.tls as Record<string, unknown>,
			hosts: {
				linux: (fixture.lock.hosts as Record<string, Record<string, unknown>>)
					.linux,
				mac: (fixture.lock.hosts as Record<string, Record<string, unknown>>)
					.mac,
			},
			topology: {
				linuxAddress: (fixture.lock.topology as Record<string, unknown>)
					.linuxAddress,
				macAddress: (fixture.lock.topology as Record<string, unknown>)
					.macAddress,
				linuxInterface: (fixture.lock.topology as Record<string, unknown>)
					.linuxInterface,
				macInterface: (fixture.lock.topology as Record<string, unknown>)
					.macInterface,
				linuxHostId: (fixture.lock.topology as Record<string, unknown>)
					.linuxHostId,
				macHostId: (fixture.lock.topology as Record<string, unknown>).macHostId,
				kind: (fixture.lock.topology as Record<string, unknown>).kind,
			},
			submissions: {
				capacitySha256: (fixture.lock.submissions as Record<string, unknown>)
					.capacitySha256,
				specSha256: (fixture.lock.submissions as Record<string, unknown>)
					.specSha256,
				registrySha256: (fixture.lock.submissions as Record<string, unknown>)
					.registrySha256,
			},
			source: {
				toolchains: {
					linux: (
						(fixture.lock.source as Record<string, unknown>)
							.toolchains as Record<string, unknown>
					).linux,
					js: (
						(fixture.lock.source as Record<string, unknown>)
							.toolchains as Record<string, unknown>
					).js,
					darwin: (
						(fixture.lock.source as Record<string, unknown>)
							.toolchains as Record<string, unknown>
					).darwin,
				},
				linuxNativeSha256: (fixture.lock.source as Record<string, unknown>)
					.linuxNativeSha256,
				darwinNativeSha256: (fixture.lock.source as Record<string, unknown>)
					.darwinNativeSha256,
				jsExecutableSha256: (fixture.lock.source as Record<string, unknown>)
					.jsExecutableSha256,
				stagedArchiveSha256: (fixture.lock.source as Record<string, unknown>)
					.stagedArchiveSha256,
				archiveSha256: (fixture.lock.source as Record<string, unknown>)
					.archiveSha256,
				reviewedTreeState: (fixture.lock.source as Record<string, unknown>)
					.reviewedTreeState,
				reviewedCleanHead: (fixture.lock.source as Record<string, unknown>)
					.reviewedCleanHead,
			},
			campaignId: fixture.campaignId,
			candidateId: fixture.candidateId,
			lockVersion: "v1",
		};

		expect(
			requiredExport(
				mod,
				"canonicalCampaignLockDigestSha256",
			)({
				lock: fixture.lock,
				expectedLockDigest: fixture.expectedLockDigest,
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				lockDigestSha256: fixture.expectedLockDigest,
			}),
		);
		expect(
			requiredExport(
				mod,
				"canonicalCampaignLockDigestSha256",
			)({
				lock: reorderedLock,
				expectedLockDigest: fixture.expectedLockDigest,
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				lockDigestSha256: fixture.expectedLockDigest,
				lockBytes: fixture.lockBytes,
			}),
		);
		const parsed = requiredExport(
			mod,
			"parseCampaignLockBytes",
		)({
			lockBytes: fixture.lockBytes,
			expectedLockDigest: fixture.expectedLockDigest,
		}) as Record<string, unknown>;
		expect(parsed).toEqual(
			expect.objectContaining({
				ok: true,
				frozen: true,
				lockBytes: fixture.lockBytes,
				resealedBytes: fixture.lockBytes,
			}),
		);
		expect(() => {
			(
				(
					(parsed.lock as Record<string, unknown>).source as Record<
						string,
						unknown
					>
				).toolchains as Record<string, unknown>
			).js = "mutated";
		}).toThrow();
		expect(() => {
			(
				(
					(parsed.lock as Record<string, unknown>).hosts as Record<
						string,
						unknown
					>
				).mac as Record<string, unknown>
			).interface = "en0";
		}).toThrow();
		for (const [inputBytes, code] of [
			[new TextEncoder().encode("{"), "CAMPAIGN_LOCK_JSON_INVALID"],
			[
				new TextEncoder().encode(
					'{"lockVersion":"v1","candidateId":"a","candidateId":"b"}',
				),
				"CAMPAIGN_LOCK_DUPLICATE_KEY",
			],
			[
				new TextEncoder().encode(
					canonicalJson({
						...(fixture.lock as Record<string, unknown>),
						unknownField: true,
					}),
				),
				"CAMPAIGN_LOCK_UNKNOWN_FIELD",
			],
			[
				new TextEncoder().encode(
					canonicalJson({
						candidateId: fixture.candidateId,
					}),
				),
				"CAMPAIGN_LOCK_MISSING_FIELD",
			],
			[byteFlip(fixture.lockBytes), "CAMPAIGN_LOCK_DIGEST_MISMATCH"],
		] as const) {
			expect(
				requiredExport(
					mod,
					"parseCampaignLockBytes",
				)({
					lockBytes: inputBytes,
					expectedLockDigest: fixture.expectedLockDigest,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});

	test("intrinsic lock validation rejects dirty tree, loopback, same-host, alternate path, wrong interfaces and addresses, route or MTU or peer drift, insecure TLS, malformed resources, and invalid supervisor policy", async () => {
		const fixture = representativeFixture();
		const mod = (await importExpectedModule("./campaign-lock.ts")) as Record<
			string,
			(args: unknown) => unknown
		>;

		expect(
			requiredExport(
				mod,
				"validateIntrinsicCampaignLock",
			)({ lock: fixture.lock }),
		).toEqual({
			ok: true,
		});
		for (const [mutation, code] of [
			[
				setAtPath(fixture.lock, ["source", "reviewedTreeState"], "dirty"),
				"LOCK_SOURCE_TREE_NOT_CLEAN",
			],
			[
				setAtPath(fixture.lock, ["hosts", "mac", "address"], "127.0.0.1"),
				"LOCK_LOOPBACK_ADDRESS_FORBIDDEN",
			],
			[
				setAtPath(fixture.lock, ["hosts", "linux", "address"], "::1"),
				"LOCK_LOOPBACK_ADDRESS_FORBIDDEN",
			],
			[
				setAtPath(
					setAtPath(
						fixture.lock,
						["hosts", "linux", "hostId"],
						"mac-controller-01",
					),
					["topology", "linuxHostId"],
					"mac-controller-01",
				),
				"LOCK_HOST_IDS_MUST_DIFFER",
			],
			[
				setAtPath(fixture.lock, ["topology", "kind"], "tailscale"),
				"LOCK_TOPOLOGY_KIND_INVALID",
			],
			[
				setAtPath(fixture.lock, ["hosts", "mac", "interface"], "en0"),
				"LOCK_MAC_INTERFACE_INVALID",
			],
			[
				setAtPath(fixture.lock, ["hosts", "linux", "interface"], "eth0"),
				"LOCK_LINUX_INTERFACE_INVALID",
			],
			[
				setAtPath(fixture.lock, ["hosts", "mac", "address"], "10.99.0.9"),
				"LOCK_MAC_ADDRESS_INVALID",
			],
			[
				setAtPath(fixture.lock, ["hosts", "linux", "address"], "10.99.0.9"),
				"LOCK_LINUX_ADDRESS_INVALID",
			],
			[
				setAtPath(fixture.lock, ["hosts", "mac", "mtu"], 1400),
				"LOCK_MTU_INVALID",
			],
			[
				setAtPath(fixture.lock, ["tls", "rejectUnauthorized"], false),
				"LOCK_TLS_REJECT_UNAUTHORIZED_REQUIRED",
			],
			[
				setAtPath(fixture.lock, ["tls", "compression"], "gzip"),
				"LOCK_TLS_COMPRESSION_FORBIDDEN",
			],
			[
				setAtPath(fixture.lock, ["resourceContract", "mac", "fdSoftLimit"], 1),
				"LOCK_RESOURCE_FD_POLICY_INVALID",
			],
			[
				setAtPath(
					fixture.lock,
					["resourceContract", "linux", "ephemeralPortRange"],
					[60000],
				),
				"LOCK_RESOURCE_PORT_POLICY_INVALID",
			],
			[
				setAtPath(
					fixture.lock,
					["supervisorPolicy", "dedicatedProcessGroupRequired"],
					false,
				),
				"LOCK_SUPERVISOR_POLICY_INVALID",
			],
			[
				setAtPath(fixture.lock, ["supervisorPolicy", "leaseMs"], -1),
				"LOCK_SUPERVISOR_POLICY_INVALID",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"validateIntrinsicCampaignLock",
				)({ lock: mutation }),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});

	test("attestation validation binds candidate, campaign, head, archive, submissions, executables, both host staged archives, route or peer or restoration facts, execution schedule, roles, cleanup, and WT facts", async () => {
		const fixture = representativeFixture();
		const mod = (await importExpectedModule("./campaign-lock.ts")) as Record<
			string,
			(args: unknown) => unknown
		>;
		expect(fixture.observedAttestationModel.source).not.toBe(
			fixture.lock.source,
		);
		expect(fixture.observedAttestationModel.executionPlan).not.toBe(
			(fixture.lock as Record<string, unknown>).executionPlan,
		);
		expect(
			(fixture.observedAttestationModel as Record<string, unknown>)
				.observedRunFacts,
		).toBeDefined();
		expect(
			(fixture.observedAttestationModel as Record<string, unknown>)
				.observedWtFacts,
		).toBeDefined();

		expect(
			requiredExport(
				mod,
				"validateCampaignLockAttestations",
			)({
				lock: fixture.lock,
				lockBytes: fixture.lockBytes,
				expectedLockDigest: fixture.expectedLockDigest,
				observedAttestation: fixture.observedAttestationModel,
			}),
		).toEqual({ ok: true });
		for (const [mutation, code] of [
			[
				setAtPath(
					fixture.observedAttestationModel,
					["candidateId"],
					"candidate-drift",
				),
				"ATTESTATION_CANDIDATE_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["campaignId"],
					"campaign-drift",
				),
				"ATTESTATION_CAMPAIGN_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["source", "reviewedCleanHead"],
					"0".repeat(40),
				),
				"ATTESTATION_SOURCE_HEAD_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["source", "reviewedTreeState"],
					"dirty",
				),
				"ATTESTATION_SOURCE_TREE_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["submissions", "archive", "bytes"],
					byteFlip(fixture.archiveBytes),
				),
				"ATTESTATION_ARCHIVE_BYTES_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["submissions", "archive", "sha256"],
					flipHexDigest(sha256Hex(fixture.archiveBytes)),
				),
				"ATTESTATION_ARCHIVE_DIGEST_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["submissions", "registry", "bytes"],
					byteFlip(fixture.registryBytes),
				),
				"ATTESTATION_REGISTRY_BYTES_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["submissions", "spec", "sha256"],
					flipHexDigest(sha256Hex(fixture.specBytes)),
				),
				"ATTESTATION_SPEC_DIGEST_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["submissions", "capacity", "sha256"],
					flipHexDigest(sha256Hex(fixture.capacityBytes)),
				),
				"ATTESTATION_CAPACITY_DIGEST_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["source", "jsExecutableSha256"],
					"1".repeat(64),
				),
				"ATTESTATION_JS_EXECUTABLE_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["source", "toolchains", "darwin", "identity"],
					"darwin-drift",
				),
				"ATTESTATION_DARWIN_TOOLCHAIN_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["source", "toolchains", "linux", "sha256"],
					"2".repeat(64),
				),
				"ATTESTATION_LINUX_TOOLCHAIN_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["stagedArchivesByHost"],
					[
						{
							hostId: "mac-controller-01",
							bytes: fixture.archiveBytes,
							sha256: sha256Hex(fixture.archiveBytes),
						},
					],
				),
				"ATTESTATION_STAGED_ARCHIVE_HOST_COUNT_INVALID",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["stagedArchivesByHost"],
					[
						...((fixture.observedAttestationModel
							.stagedArchivesByHost as unknown[]) ?? []),
						{
							hostId: "linux-bench-01",
							bytes: fixture.archiveBytes,
							sha256: sha256Hex(fixture.archiveBytes),
						},
					],
				),
				"ATTESTATION_STAGED_ARCHIVE_DUPLICATE_HOST",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["stagedArchivesByHost", 1, "sha256"],
					"3".repeat(64),
				),
				"ATTESTATION_STAGED_ARCHIVE_DIGEST_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["observedCellSnapshots", 0, "postCell", "sha256"],
					"4".repeat(64),
				),
				"ATTESTATION_CELL_SNAPSHOT_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["executionPlan", "totalRuns"],
					587,
				),
				"ATTESTATION_EXECUTION_PLAN_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["executionPlan", "cellPhaseSequences", 0, "sequence", 0],
					"wt@1",
				),
				"ATTESTATION_EXECUTION_SEQUENCE_MISMATCH",
			],
			[
				setAtPath(fixture.observedAttestationModel, ["observedRunFacts"], []),
				"ATTESTATION_OBSERVED_RUN_FACTS_MISSING",
			],
			[
				setAtPath(fixture.observedAttestationModel, ["observedWtFacts"], []),
				"ATTESTATION_OBSERVED_WT_FACTS_MISSING",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["observedRunFacts", 0, "routePath"],
					"tailscale",
				),
				"ATTESTATION_ROUTE_OR_PEER_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["observedRunFacts", 0, "dedicatedPgidObserved"],
					undefined,
				),
				"ATTESTATION_SUPERVISOR_FACTS_MISMATCH",
			],
			[
				setAtPath(
					fixture.observedAttestationModel,
					["observedWtFacts", 0, "zeroRttOutcome"],
					"accepted",
				),
				"ATTESTATION_WT_FACTS_MISMATCH",
			],
			[
				{
					...fixture.observedAttestationModel,
					source: (fixture.lock as Record<string, unknown>).source,
				},
				"ATTESTATION_PLANNED_VALUE_ALIAS_FORBIDDEN",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"validateCampaignLockAttestations",
				)({
					lock: fixture.lock,
					lockBytes: fixture.lockBytes,
					expectedLockDigest: fixture.expectedLockDigest,
					observedAttestation: mutation,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});

	test("staged capability loader must bind candidate, campaign, digest, lock, archive, issued/notAfter, host submissions, and reject ambient or artifact-contained trust", async () => {
		const fixture = representativeFixture();
		const mod = (await importExpectedModule(
			"./staged-capability.ts",
		)) as Record<string, (args: unknown) => unknown>;
		const loaderInput = (
			bytes: Uint8Array,
			expectedCapabilityDigest = sha256Hex(bytes),
		) => ({
			locator: "official/staging/capabilities/campaign-r1.cap",
			expectedCapabilityDigest,
			expectedLockDigest: fixture.expectedLockDigest,
			expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
			expectedCandidateId: fixture.candidateId,
			expectedCampaignId: fixture.campaignId,
			nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
			readBytes: () => bytes,
		});

		expect(
			requiredExport(
				mod,
				"loadStagedTrustCapability",
			)({
				locator: "official/staging/capabilities/campaign-r1.cap",
				expectedCapabilityDigest: fixture.expectedCapabilityDigest,
				expectedLockDigest: fixture.expectedLockDigest,
				expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
				expectedCandidateId: fixture.candidateId,
				expectedCampaignId: fixture.campaignId,
				nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
				readBytes: () => fixture.stagedCapabilityBytes,
			}),
		).toEqual(expect.objectContaining({ ok: true, hostCount: 2 }));
		expect(
			requiredExport(
				mod,
				"loadStagedTrustCapability",
			)({
				locator: "official/staging/capabilities/campaign-r1.cap",
				expectedCapabilityDigest: fixture.expectedCapabilityDigest,
				expectedLockDigest: fixture.expectedLockDigest,
				expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
				expectedCandidateId: fixture.candidateId,
				expectedCampaignId: fixture.campaignId,
				nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
				ambientTrustMarker: "trusted-env",
				readBytes: () => fixture.stagedCapabilityBytes,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_AMBIENT_MARKER_FORBIDDEN",
			}),
		);
		expect(
			requiredExport(
				mod,
				"rejectAmbientOrArtifactTrust",
			)({
				ambientTrustMarker: "trusted",
				artifactContainedTrust: {
					lockDigestSha256: fixture.expectedLockDigest,
					archiveSha256: sha256Hex(fixture.archiveBytes),
				},
				capabilityBytes: fixture.stagedCapabilityBytes,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				codes: [
					"TRUST_MARKER_ENV_FORBIDDEN",
					"TRUST_ARTIFACT_SELF_AUTH_FORBIDDEN",
				],
			}),
		);
		for (const [input, code] of [
			[
				{
					locator: "../official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: fixture.expectedCapabilityDigest,
					expectedLockDigest: fixture.expectedLockDigest,
					expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
					expectedCandidateId: fixture.candidateId,
					expectedCampaignId: fixture.campaignId,
					nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
					readBytes: () => fixture.stagedCapabilityBytes,
				},
				"TRUST_CAPABILITY_LOCATOR_UNSAFE",
			],
			[
				{
					locator: "official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: fixture.expectedCapabilityDigest,
					expectedLockDigest: fixture.expectedLockDigest,
					expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
					expectedCandidateId: fixture.candidateId,
					expectedCampaignId: fixture.campaignId,
					nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
					readBytes: () => {
						throw new Error("ENOENT");
					},
				},
				"TRUST_CAPABILITY_READ_FAILED",
			],
			[
				{
					locator: "official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: flipHexDigest(
						fixture.expectedCapabilityDigest,
					),
					expectedLockDigest: fixture.expectedLockDigest,
					expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
					expectedCandidateId: fixture.candidateId,
					expectedCampaignId: fixture.campaignId,
					nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
					readBytes: () => fixture.stagedCapabilityBytes,
				},
				"TRUST_CAPABILITY_DIGEST_MISMATCH",
			],
			[
				{
					locator: "official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: fixture.expectedCapabilityDigest,
					expectedLockDigest: flipHexDigest(fixture.expectedLockDigest),
					expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
					expectedCandidateId: fixture.candidateId,
					expectedCampaignId: fixture.campaignId,
					nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
					readBytes: () => fixture.stagedCapabilityBytes,
				},
				"TRUST_CAPABILITY_LOCK_DIGEST_MISMATCH",
			],
			[
				{
					locator: "official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: fixture.expectedCapabilityDigest,
					expectedLockDigest: fixture.expectedLockDigest,
					expectedArchiveDigest: flipHexDigest(sha256Hex(fixture.archiveBytes)),
					expectedCandidateId: fixture.candidateId,
					expectedCampaignId: fixture.campaignId,
					nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
					readBytes: () => fixture.stagedCapabilityBytes,
				},
				"TRUST_CAPABILITY_ARCHIVE_DIGEST_MISMATCH",
			],
			[
				{
					locator: "official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: fixture.expectedCapabilityDigest,
					expectedLockDigest: fixture.expectedLockDigest,
					expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
					expectedCandidateId: "candidate-drift",
					expectedCampaignId: fixture.campaignId,
					nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
					readBytes: () => fixture.stagedCapabilityBytes,
				},
				"TRUST_CAPABILITY_CANDIDATE_MISMATCH",
			],
			[
				{
					locator: "official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: fixture.expectedCapabilityDigest,
					expectedLockDigest: fixture.expectedLockDigest,
					expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
					expectedCandidateId: fixture.candidateId,
					expectedCampaignId: "campaign-drift",
					nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
					readBytes: () => fixture.stagedCapabilityBytes,
				},
				"TRUST_CAPABILITY_CAMPAIGN_MISMATCH",
			],
			[
				{
					locator: "official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: fixture.expectedCapabilityDigest,
					expectedLockDigest: fixture.expectedLockDigest,
					expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
					expectedCandidateId: fixture.candidateId,
					expectedCampaignId: fixture.campaignId,
					nowMs: Date.UTC(2026, 7, 24, 9, 0, 0),
					readBytes: () => fixture.stagedCapabilityBytes,
				},
				"TRUST_CAPABILITY_NOT_YET_VALID",
			],
			[
				{
					locator: "official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: fixture.expectedCapabilityDigest,
					expectedLockDigest: fixture.expectedLockDigest,
					expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
					expectedCandidateId: fixture.candidateId,
					expectedCampaignId: fixture.campaignId,
					nowMs: Date.UTC(2026, 7, 24, 23, 0, 0),
					readBytes: () => fixture.stagedCapabilityBytes,
				},
				"TRUST_CAPABILITY_EXPIRED",
			],
			[
				{
					locator: "official/staging/capabilities/campaign-r1.cap",
					expectedCapabilityDigest: sha256Hex(
						fixture.fixtureOnlyCapabilityBytes,
					),
					expectedLockDigest: fixture.expectedLockDigest,
					expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
					expectedCandidateId: fixture.candidateId,
					expectedCampaignId: fixture.campaignId,
					nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
					readBytes: () => fixture.fixtureOnlyCapabilityBytes,
				},
				"TRUST_CAPABILITY_FIXTURE_ONLY_FORBIDDEN",
			],
			[
				(() => {
					const mutated = {
						...(fixture.stagedCapability as Record<string, unknown>),
						stagingId: "staging-drift",
					};
					const bytes = canonicalBytes(mutated);
					return {
						locator: "official/staging/capabilities/campaign-r1.cap",
						expectedCapabilityDigest: sha256Hex(bytes),
						expectedLockDigest: fixture.expectedLockDigest,
						expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
						expectedCandidateId: fixture.candidateId,
						expectedCampaignId: fixture.campaignId,
						nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
						readBytes: () => bytes,
					};
				})(),
				"TRUST_CAPABILITY_STAGING_ID_MISMATCH",
			],
			[
				(() => {
					const mutated = {
						...(fixture.stagedCapability as Record<string, unknown>),
						stagingRootIdentity: "official/staging/root/drift",
					};
					const bytes = canonicalBytes(mutated);
					return {
						locator: "official/staging/capabilities/campaign-r1.cap",
						expectedCapabilityDigest: sha256Hex(bytes),
						expectedLockDigest: fixture.expectedLockDigest,
						expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
						expectedCandidateId: fixture.candidateId,
						expectedCampaignId: fixture.campaignId,
						nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
						readBytes: () => bytes,
					};
				})(),
				"TRUST_CAPABILITY_ROOT_IDENTITY_MISMATCH",
			],
			[
				(() => {
					const mutated = {
						...(fixture.stagedCapability as Record<string, unknown>),
						hostSubmissions: [
							{
								...(
									fixture.stagedCapability.hostSubmissions as Array<
										Record<string, unknown>
									>
								)[0]!,
								hostId: "unknown-host",
							},
							...(
								fixture.stagedCapability.hostSubmissions as Array<
									Record<string, unknown>
								>
							).slice(1),
						],
					};
					const bytes = canonicalBytes(mutated);
					return {
						locator: "official/staging/capabilities/campaign-r1.cap",
						expectedCapabilityDigest: sha256Hex(bytes),
						expectedLockDigest: fixture.expectedLockDigest,
						expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
						expectedCandidateId: fixture.candidateId,
						expectedCampaignId: fixture.campaignId,
						nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
						readBytes: () => bytes,
					};
				})(),
				"TRUST_CAPABILITY_HOST_ID_INVALID",
			],
			[
				(() => {
					const mutated = {
						...(fixture.stagedCapability as Record<string, unknown>),
						hostSubmissions: [
							...(fixture.stagedCapability.hostSubmissions as Array<
								Record<string, unknown>
							>),
							{
								...(
									fixture.stagedCapability.hostSubmissions as Array<
										Record<string, unknown>
									>
								)[1]!,
							},
						],
					};
					const bytes = canonicalBytes(mutated);
					return {
						locator: "official/staging/capabilities/campaign-r1.cap",
						expectedCapabilityDigest: sha256Hex(bytes),
						expectedLockDigest: fixture.expectedLockDigest,
						expectedArchiveDigest: sha256Hex(fixture.archiveBytes),
						expectedCandidateId: fixture.candidateId,
						expectedCampaignId: fixture.campaignId,
						nowMs: Date.UTC(2026, 7, 24, 12, 0, 0),
						readBytes: () => bytes,
					};
				})(),
				"TRUST_CAPABILITY_HOST_SUBMISSION_DUPLICATE",
			],
		] as const) {
			expect(requiredExport(mod, "loadStagedTrustCapability")(input)).toEqual(
				expect.objectContaining({ ok: false, code }),
			);
		}

		// The loader must validate capability content itself, not merely compare
		// the outer capability digest.  Exercise every host and every bound
		// lock/archive/staged-archive/identity field independently.
		for (const hostIndex of [0, 1] as const) {
			for (const [field, code] of [
				["lockDigestSha256", "TRUST_CAPABILITY_HOST_LOCK_DIGEST_MISMATCH"],
				["archiveSha256", "TRUST_CAPABILITY_HOST_ARCHIVE_DIGEST_MISMATCH"],
				[
					"stagedArchiveSha256",
					"TRUST_CAPABILITY_HOST_STAGED_ARCHIVE_DIGEST_MISMATCH",
				],
			] as const) {
				const mutated = {
					...fixture.stagedCapability,
					hostSubmissions: (
						fixture.stagedCapability.hostSubmissions as Array<
							Record<string, unknown>
						>
					).map((host, index) =>
						index === hostIndex ? { ...host, [field]: "f".repeat(64) } : host,
					),
				};
				const bytes = canonicalBytes(mutated);
				expect(
					requiredExport(mod, "loadStagedTrustCapability")(loaderInput(bytes)),
				).toEqual(expect.objectContaining({ ok: false, code }));
			}
			for (const [field, code] of [
				[
					"stagingRootIdentity",
					"TRUST_CAPABILITY_HOST_STAGING_IDENTITY_MISMATCH",
				],
				["osIdentity", "TRUST_CAPABILITY_HOST_OS_IDENTITY_MISMATCH"],
			] as const) {
				const hostSubmissions = fixture.stagedCapability
					.hostSubmissions as Array<Record<string, unknown>>;
				const host = hostSubmissions[hostIndex]!;
				const mutatedHost =
					field === "osIdentity"
						? {
								...host,
								osIdentity: {
									...(host.osIdentity as Record<string, unknown>),
									identitySha256: "e".repeat(64),
								},
							}
						: { ...host, stagingRootIdentity: "official/staging/root/drift" };
				const mutated = {
					...fixture.stagedCapability,
					hostSubmissions: hostSubmissions.map((candidate, index) =>
						index === hostIndex ? mutatedHost : candidate,
					),
				};
				const bytes = canonicalBytes(mutated);
				expect(
					requiredExport(mod, "loadStagedTrustCapability")(loaderInput(bytes)),
				).toEqual(expect.objectContaining({ ok: false, code }));
			}
		}
		for (const [field, value, code] of [
			[
				"lockDigestSha256",
				"f".repeat(64),
				"TRUST_CAPABILITY_LOCK_DIGEST_MISMATCH",
			],
			[
				"archiveSha256",
				"e".repeat(64),
				"TRUST_CAPABILITY_ARCHIVE_DIGEST_MISMATCH",
			],
			[
				"stagedArchiveSha256",
				"d".repeat(64),
				"TRUST_CAPABILITY_STAGED_ARCHIVE_MISMATCH",
			],
		] as const) {
			const bytes = canonicalBytes({
				...fixture.stagedCapability,
				[field]: value,
			});
			expect(
				requiredExport(mod, "loadStagedTrustCapability")(loaderInput(bytes)),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		// The injected loader fixture uses millisecond fields for the logical
		// issuedAt/notAfter bounds; mutate the actual content fields directly.
		for (const [field, value, code] of [
			[
				"issuedAtMs",
				Date.UTC(2026, 7, 24, 13, 0, 0),
				"TRUST_CAPABILITY_NOT_YET_VALID",
			],
			[
				"notAfterMs",
				Date.UTC(2026, 7, 24, 11, 0, 0),
				"TRUST_CAPABILITY_EXPIRED",
			],
		] as const) {
			const bytes = canonicalBytes({
				...fixture.stagedCapability,
				[field]: value,
			});
			expect(
				requiredExport(mod, "loadStagedTrustCapability")(loaderInput(bytes)),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		const unknownCapabilityBytes = canonicalBytes({
			...fixture.stagedCapability,
			unknownCapabilityField: true,
		});
		expect(
			requiredExport(
				mod,
				"loadStagedTrustCapability",
			)(loaderInput(unknownCapabilityBytes)),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_CAPABILITY_UNKNOWN_FIELD",
			}),
		);
		const canonicalCapability = new TextDecoder()
			.decode(fixture.stagedCapabilityBytes)
			.trim();
		const duplicateCapabilityBytes = new TextEncoder().encode(
			`${canonicalCapability.slice(0, -1)},"schemaVersion":"v1"}\n`,
		);
		expect(
			requiredExport(
				mod,
				"loadStagedTrustCapability",
			)(loaderInput(duplicateCapabilityBytes)),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_CAPABILITY_DUPLICATE_FIELD",
			}),
		);
	});

	test("CampaignAuthorityV1 canonical bytes bind source receipt, R1RedApprovalBundle, exact approvals, four pinned roots, and no self-authorization", async () => {
		const mod = await importExpectedModule("./secure-fs.ts");
		expect(new TextDecoder().decode(R1_SOURCE_ARCHIVE_RECEIPT_BYTES)).toBe(
			`${canonicalJson(R1_SOURCE_ARCHIVE_RECEIPT)}\n`,
		);
		expect(new TextDecoder().decode(R1_RED_APPROVAL_BUNDLE_BYTES)).toBe(
			`${canonicalJson(R1_RED_APPROVAL_BUNDLE)}\n`,
		);
		expect(new TextDecoder().decode(R1_CAMPAIGN_AUTHORITY_BYTES)).toBe(
			`${canonicalJson(R1_CAMPAIGN_AUTHORITY)}\n`,
		);
		expect(new TextDecoder().decode(R1_CAMPAIGN_LOCK_BYTES)).toBe(
			`${canonicalJson(R1_CAMPAIGN_LOCK)}\n`,
		);
		expect(new TextDecoder().decode(R1_STAGED_CAPABILITY_V1_BYTES)).toBe(
			`${canonicalJson(R1_STAGED_CAPABILITY_V1)}\n`,
		);
		expect(sha256Hex(R1_SOURCE_ARCHIVE_RECEIPT_BYTES)).toBe(
			R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
		);
		expect(sha256Hex(R1_RED_APPROVAL_BUNDLE_BYTES)).toBe(
			R1_RED_APPROVAL_BUNDLE_SHA256,
		);
		expect(sha256Hex(R1_CAMPAIGN_AUTHORITY_BYTES)).toBe(
			R1_CAMPAIGN_AUTHORITY_SHA256,
		);
		expect(sha256Hex(R1_CAMPAIGN_RESERVATION_BYTES)).toBe(
			R1_CAMPAIGN_RESERVATION_SHA256,
		);
		expect(sha256Hex(R1_STAGED_CAPABILITY_V1_BYTES)).toBe(
			R1_STAGED_CAPABILITY_V1_SHA256,
		);
		const validInput = {
			authority: R1_CAMPAIGN_AUTHORITY,
			authorityBytes: R1_CAMPAIGN_AUTHORITY_BYTES,
			expectedAuthorityDigest: R1_CAMPAIGN_AUTHORITY_SHA256,
			sourceArchiveReceipt: R1_SOURCE_ARCHIVE_RECEIPT,
			sourceArchiveReceiptBytes: R1_SOURCE_ARCHIVE_RECEIPT_BYTES,
			sourceArchiveReceiptSha256: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
			r1RedApprovalBundle: R1_RED_APPROVAL_BUNDLE,
			r1RedApprovalBundleBytes: R1_RED_APPROVAL_BUNDLE_BYTES,
			r1RedApprovalBundleSha256: R1_RED_APPROVAL_BUNDLE_SHA256,
		};
		expect(requiredExport(mod, "parseCampaignAuthorityV1")(validInput)).toEqual(
			expect.objectContaining({ ok: true, schema: "campaign-authority/v1" }),
		);
		expect(
			requiredExport(mod, "validateCampaignAuthorityV1")(validInput),
		).toEqual(
			expect.objectContaining({
				ok: true,
				candidate: R1_CANDIDATE_ID,
				finalCandidateHead: R1_FINAL_CANDIDATE_HEAD,
				rootCount: 4,
			}),
		);
		for (const [input, code] of [
			[
				{
					...validInput,
					authority: { ...R1_CAMPAIGN_AUTHORITY, unknownField: true },
				},
				"TRUST_AUTHORITY_UNKNOWN_FIELD",
			],
			[
				{
					...validInput,
					authorityBytes: byteFlip(R1_CAMPAIGN_AUTHORITY_BYTES),
				},
				"TRUST_AUTHORITY_DIGEST_MISMATCH",
			],
			[
				{
					...validInput,
					sourceArchiveReceipt: {
						...R1_SOURCE_ARCHIVE_RECEIPT,
						finalCandidateHead: "0".repeat(40),
					},
				},
				"TRUST_SOURCE_ARCHIVE_HEAD_MISMATCH",
			],
			[
				{
					...validInput,
					sourceArchiveReceiptBytes: byteFlip(R1_SOURCE_ARCHIVE_RECEIPT_BYTES),
				},
				"TRUST_SOURCE_ARCHIVE_DIGEST_MISMATCH",
			],
			[
				{
					...validInput,
					r1RedApprovalBundle: {
						...R1_RED_APPROVAL_BUNDLE,
						redHead: "0".repeat(40),
					},
				},
				"TRUST_R1_RED_APPROVAL_MISMATCH",
			],
			[
				{
					...validInput,
					r1RedApprovalBundle: {
						...R1_RED_APPROVAL_BUNDLE,
						records: [
							R1_RED_APPROVAL_BUNDLE.records[1],
							R1_RED_APPROVAL_BUNDLE.records[0],
						],
					},
				},
				"TRUST_R1_RED_APPROVAL_ORDER_INVALID",
			],
			[
				{
					...validInput,
					authority: {
						...R1_CAMPAIGN_AUTHORITY,
						roots: R1_AUTHORITY_ROOTS.slice(0, 3),
					},
				},
				"TRUST_AUTHORITY_ROOT_COUNT_INVALID",
			],
			[
				{ ...validInput, authoritySource: "campaign-artifact" },
				"TRUST_AUTHORITY_SELF_AUTH_FORBIDDEN",
			],
			[
				{
					...validInput,
					authorityBytes: new TextEncoder().encode(
						'{"schema":"campaign-authority/v1","schema":"campaign-authority/v1"}',
					),
				},
				"TRUST_AUTHORITY_DUPLICATE_FIELD",
			],
			[
				{ ...validInput, ambientTrustMarker: "trusted-env" },
				"TRUST_AMBIENT_MARKER_FORBIDDEN",
			],
		] as const) {
			expect(requiredExport(mod, "validateCampaignAuthorityV1")(input)).toEqual(
				expect.objectContaining({ ok: false, code }),
			);
		}
		// Every authority-bearing approval input invalidates the original
		// authority digest and therefore all descendant lock/capability/output
		// records.  Keep the descendant links explicit so a validator cannot
		// accept a changed review chain merely because the changed authority was
		// re-hashed by the caller.
		const downstreamAuthorityLinks = [
			R1_CAMPAIGN_LOCK.authoritySha256,
			R1_STAGED_CAPABILITY_V1.authoritySha256,
			R1_SUPERVISOR_INPUT_V1.authoritySha256,
			R1_SUPERVISOR_OUTPUT_V1.authoritySha256,
			R1_SUPERVISOR_PHYSICAL_OBSERVATION.authoritySha256,
		];
		for (const field of [
			"parentPlanSha256",
			"parentDesignSha256",
			"amendmentSha256",
			"finalCandidateHead",
			"finalArchitectApprovalSha256",
			"finalCriticApprovalSha256",
			"finalVerifierApprovalSha256",
		] as const) {
			const approval = R1_CAMPAIGN_AUTHORITY.approval as Record<
				string,
				unknown
			>;
			const mutatedAuthority = {
				...R1_CAMPAIGN_AUTHORITY,
				approval: {
					...approval,
					[field]:
						field === "finalCandidateHead"
							? "0".repeat(40)
							: flipHexDigest(String(approval[field])),
				},
			};
			const mutatedBytes = canonicalBytes(mutatedAuthority);
			expect(sha256Hex(mutatedBytes)).not.toBe(R1_CAMPAIGN_AUTHORITY_SHA256);
			expect(
				requiredExport(
					mod,
					"validateCampaignAuthorityV1",
				)({
					...validInput,
					authority: mutatedAuthority,
					authorityBytes: mutatedBytes,
					expectedAuthorityDigest: R1_CAMPAIGN_AUTHORITY_SHA256,
					downstreamAuthorityLinks,
				}),
			).toEqual(
				expect.objectContaining({
					ok: false,
					code: "TRUST_AUTHORITY_DIGEST_MISMATCH",
				}),
			);
		}
	});

	test("exact campaign-staging approval records are ordered, canonical, independently hashed, and bound into authority", () => {
		expect(R1_EXACT_APPROVAL_RECORDS.map((record) => record.role)).toEqual([
			"architect",
			"critic",
			"verifier",
		]);
		expect(
			R1_EXACT_APPROVAL_RECORDS.every(
				(record) =>
					record.schema === "exact-approval/v1" &&
					record.phase === "campaign-staging" &&
					record.verdict === "APPROVED" &&
					record.expectedCampaignInputs === R1_EXACT_APPROVAL_EXPECTED_INPUTS,
			),
		).toBe(true);
		expect(
			R1_EXACT_APPROVAL_RECORDS.every(
				(record) =>
					record.parentPlanSha256 ===
						"7981f289d7fdb044218a5c7348cc5a1fa755087d48a02acc589d127575983c16" &&
					record.parentDesignSha256 ===
						"0b2b6e9ea38897ee76ea590f25916f39d2f6bce1320c096703ee68b60a4f10b6" &&
					record.amendmentSha256 ===
						"b181325dc3ac558da4c0f44541eb223f6cdb63770ef70b6d1228ce74b0fdf403",
			),
		).toBe(true);
		expect(R1_AUTHORITY_APPROVAL.finalArchitectApprovalSha256).toBe(
			R1_EXACT_APPROVAL_RECORD_SHA256S[0],
		);
		expect(R1_AUTHORITY_APPROVAL.finalCriticApprovalSha256).toBe(
			R1_EXACT_APPROVAL_RECORD_SHA256S[1],
		);
		expect(R1_AUTHORITY_APPROVAL.finalVerifierApprovalSha256).toBe(
			R1_EXACT_APPROVAL_RECORD_SHA256S[2],
		);
		expect(
			R1_EXACT_APPROVAL_RECORD_BYTES.map((bytes) => sha256Hex(bytes)),
		).toEqual([...R1_EXACT_APPROVAL_RECORD_SHA256S]);
		expect(sha256Hex(R1_EXACT_APPROVAL_RECORD_SET_BYTES)).toBe(
			R1_EXACT_APPROVAL_RECORD_SET_SHA256,
		);
		expect(new Set(R1_EXACT_APPROVAL_RECORD_SHA256S).size).toBe(3);
		for (const bytes of R1_EXACT_APPROVAL_RECORD_BYTES) {
			expect(new TextDecoder().decode(bytes).endsWith("\n")).toBe(true);
			expect(sha256Hex(byteFlip(bytes))).not.toBe(sha256Hex(bytes));
		}
	});

	test("Bun role receipts recompute the ordered 768-execution tuple set with no missing or repeated run", () => {
		expect(R1_BUN_ROLE_LAUNCH_RECEIPT_SET.expectedProcessCount).toBe(768);
		expect(R1_BUN_ROLE_LAUNCH_RECEIPTS).toHaveLength(768);
		expect(R1_ROLE_TUPLE_ORACLE).toHaveLength(768);
		expect(
			R1_BUN_ROLE_LAUNCH_RECEIPTS.map((receipt) => receipt.executionIndex),
		).toEqual(Array.from({ length: 768 }, (_, index) => index));
		expect(R1_ROLE_TUPLE_ORACLE.map((entry) => entry.executionIndex)).toEqual(
			Array.from({ length: 768 }, (_, index) => index),
		);
		expect(
			new Set(R1_BUN_ROLE_LAUNCH_RECEIPTS.map((receipt) => receipt.runId)).size,
		).toBe(768);
		expect(
			R1_BUN_ROLE_LAUNCH_RECEIPTS.map(
				(receipt) =>
					`${receipt.executionIndex}|${receipt.runId}|${receipt.logicalRole}|${receipt.processOrdinal}`,
			),
		).toEqual(
			R1_ROLE_TUPLE_ORACLE.map(
				(entry) =>
					`${entry.executionIndex}|${entry.runId}|${entry.logicalRole}|${entry.processOrdinal}`,
			),
		);
		expect(sha256Hex(R1_ROLE_TUPLE_ORACLE_BYTES)).toBe(
			R1_ROLE_TUPLE_ORACLE_SHA256,
		);
	});

	test("source-archive-receipt/v1 and r1-red-approval-bundle/v1 reject missing, duplicate, stale-head, noncanonical, and non-exact approval records", async () => {
		const mod = await importExpectedModule("./secure-fs.ts");
		expect(
			requiredExport(
				mod,
				"validateSourceArchiveReceiptV1",
			)({
				receipt: R1_SOURCE_ARCHIVE_RECEIPT,
				bytes: R1_SOURCE_ARCHIVE_RECEIPT_BYTES,
				expectedDigest: R1_SOURCE_ARCHIVE_RECEIPT_SHA256,
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				schema: "source-archive-receipt/v1",
			}),
		);
		expect(
			requiredExport(
				mod,
				"validateR1RedApprovalBundleV1",
			)({
				bundle: R1_RED_APPROVAL_BUNDLE,
				bytes: R1_RED_APPROVAL_BUNDLE_BYTES,
				expectedDigest: R1_RED_APPROVAL_BUNDLE_SHA256,
				redHead: R1_FINAL_CANDIDATE_HEAD,
			}),
		).toEqual(expect.objectContaining({ ok: true, recordCount: 2 }));
		for (const [receipt, code] of [
			[
				{
					...R1_SOURCE_ARCHIVE_RECEIPT,
					cleanTreeProof: {
						...R1_SOURCE_ARCHIVE_RECEIPT.cleanTreeProof,
						allEmpty: false,
					},
				},
				"TRUST_SOURCE_RECEIPT_INVALID",
			],
			[
				{ ...R1_SOURCE_ARCHIVE_RECEIPT, finalCandidateTreeOid: "not-an-oid" },
				"TRUST_SOURCE_RECEIPT_INVALID",
			],
			[
				{
					...R1_SOURCE_ARCHIVE_RECEIPT,
					archiveRecipe: {
						...R1_SOURCE_ARCHIVE_RECEIPT.archiveRecipe,
						prefix: "evil/",
					},
				},
				"TRUST_SOURCE_RECEIPT_INVALID",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"validateSourceArchiveReceiptV1",
				)({
					receipt,
					bytes: canonicalBytes(receipt),
					expectedDigest: sha256Hex(canonicalBytes(receipt)),
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		for (const [bundle, code] of [
			[
				{
					...R1_RED_APPROVAL_BUNDLE,
					records: [R1_RED_APPROVAL_BUNDLE.records[0]],
				},
				"TRUST_R1_RED_APPROVAL_COUNT_INVALID",
			],
			[
				{
					...R1_RED_APPROVAL_BUNDLE,
					records: [
						{
							...R1_RED_APPROVAL_BUNDLE.records[0],
							verdict: "APPROVED WITH REQUIRED CHANGES",
						},
					],
				},
				"TRUST_R1_RED_APPROVAL_VERDICT_INVALID",
			],
			[
				{
					...R1_RED_APPROVAL_BUNDLE,
					records: [
						{ ...R1_RED_APPROVAL_BUNDLE.records[0], role: "verifier" },
						R1_RED_APPROVAL_BUNDLE.records[1],
					],
				},
				"TRUST_R1_RED_APPROVAL_ROLE_DUPLICATE",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"validateR1RedApprovalBundleV1",
				)({
					bundle,
					bytes: canonicalBytes(bundle),
					expectedDigest: sha256Hex(canonicalBytes(bundle)),
					redHead: R1_FINAL_CANDIDATE_HEAD,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});

	test("runtime facts, launch provenance, durable reservation, and capability bytes are supervisor-owned and bound to authority", async () => {
		const mod = await importExpectedModule("./secure-fs.ts");
		expect(
			requiredExport(
				mod,
				"validateCampaignReservationV1",
			)({
				reservation: R1_CAMPAIGN_RESERVATION,
				bytes: canonicalBytes(R1_CAMPAIGN_RESERVATION),
				expectedAuthoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		).toEqual(expect.objectContaining({ ok: true, state: "RESERVED" }));
		expect(
			requiredExport(
				mod,
				"validateHostRuntimeFactsV1",
			)({
				facts: R1_HOST_RUNTIME_FACTS,
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		).toEqual(expect.objectContaining({ ok: true, hostCount: 2 }));
		expect(
			requiredExport(
				mod,
				"validateHostLaunchProvenanceV1",
			)({
				provenance: R1_HOST_LAUNCH_PROVENANCE,
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		).toEqual(expect.objectContaining({ ok: true, hostCount: 2 }));
		expect(
			requiredExport(
				mod,
				"validateStagedCapabilityV1",
			)({
				capability: R1_STAGED_CAPABILITY_V1,
				bytes: R1_STAGED_CAPABILITY_V1_BYTES,
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		).toEqual(expect.objectContaining({ ok: true, fixtureOnly: false }));
		expect(new TextDecoder().decode(R1_BUN_ROLE_LAUNCH_RECEIPTS_BYTES)).toBe(
			`${canonicalJson(R1_BUN_ROLE_LAUNCH_RECEIPTS)}\n`,
		);
		expect(sha256Hex(R1_BUN_ROLE_LAUNCH_RECEIPT_SET_BYTES)).toBe(
			R1_BUN_ROLE_LAUNCH_RECEIPT_SET_SHA256,
		);
		expect(
			requiredExport(
				mod,
				"validateBunRoleLaunchReceiptSetV1",
			)({
				receiptSet: R1_BUN_ROLE_LAUNCH_RECEIPT_SET,
				bytes: R1_BUN_ROLE_LAUNCH_RECEIPT_SET_BYTES,
				expectedDigest: R1_BUN_ROLE_LAUNCH_RECEIPT_SET_SHA256,
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
				lockSha256: R1_STAGED_CAPABILITY_V1.lockSha256,
				capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
			}),
		).toEqual(expect.objectContaining({ ok: true, expectedProcessCount: 768 }));
		expect(
			requiredExport(
				mod,
				"validateBunRoleLaunchReceiptSetV1",
			)({
				receiptSet: {
					...R1_BUN_ROLE_LAUNCH_RECEIPT_SET,
					receipts: [
						{
							...R1_BUN_ROLE_LAUNCH_RECEIPTS[0],
							socketBeforeStartupHandshake: true,
						},
					],
				},
				bytes: R1_BUN_ROLE_LAUNCH_RECEIPT_SET_BYTES,
				expectedDigest: R1_BUN_ROLE_LAUNCH_RECEIPT_SET_SHA256,
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
				lockSha256: R1_STAGED_CAPABILITY_V1.lockSha256,
				capabilitySha256: R1_STAGED_CAPABILITY_V1_SHA256,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_ROLE_SOCKET_BEFORE_HANDSHAKE",
			}),
		);
		expect(
			requiredExport(
				mod,
				"validateCampaignReservationV1",
			)({
				reservation: { ...R1_CAMPAIGN_RESERVATION, state: "CONSUMED" },
				bytes: canonicalBytes({
					...R1_CAMPAIGN_RESERVATION,
					state: "CONSUMED",
				}),
				expectedAuthoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_CAMPAIGN_RESERVATION_CONSUMED",
			}),
		);
		expect(
			requiredExport(
				mod,
				"validateCampaignReservationV1",
			)({
				reservation: {
					...R1_CAMPAIGN_RESERVATION,
					campaignIdentity: {
						...R1_CAMPAIGN_RESERVATION.campaignIdentity,
						mode: 0o770,
					},
				},
				bytes: canonicalBytes({
					...R1_CAMPAIGN_RESERVATION,
					campaignIdentity: {
						...R1_CAMPAIGN_RESERVATION.campaignIdentity,
						mode: 0o770,
					},
				}),
				expectedAuthoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_CAMPAIGN_RESERVATION_NOT_EXCLUSIVE",
			}),
		);
		expect(
			requiredExport(
				mod,
				"validateHostRuntimeFactsV1",
			)({
				facts: R1_HOST_RUNTIME_FACTS,
				authoritySha256: "0".repeat(64),
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_RUNTIME_FACTS_AUTHORITY_MISMATCH",
			}),
		);
		expect(
			requiredExport(
				mod,
				"validateHostLaunchProvenanceV1",
			)({
				provenance: [
					{ ...R1_HOST_LAUNCH_PROVENANCE[0], hostId: "linux-bench-01" },
					R1_HOST_LAUNCH_PROVENANCE[1],
				],
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_LAUNCH_PROVENANCE_HOST_DUPLICATE",
			}),
		);
		expect(
			requiredExport(
				mod,
				"validateStagedCapabilityV1",
			)({
				capability: { ...R1_STAGED_CAPABILITY_V1, fixtureOnly: true },
				bytes: canonicalBytes({
					...R1_STAGED_CAPABILITY_V1,
					fixtureOnly: true,
				}),
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_CAPABILITY_FIXTURE_ONLY_FORBIDDEN",
			}),
		);
		expect(
			requiredExport(
				mod,
				"validateStagedCapabilityV1",
			)({
				capability: {
					...R1_STAGED_CAPABILITY_V1,
					macStagedArchiveSha256:
						R1_STAGED_CAPABILITY_V1.linuxStagedArchiveSha256,
				},
				bytes: canonicalBytes({
					...R1_STAGED_CAPABILITY_V1,
					macStagedArchiveSha256:
						R1_STAGED_CAPABILITY_V1.linuxStagedArchiveSha256,
				}),
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				code: "TRUST_CAPABILITY_STAGED_ARCHIVE_MISMATCH",
			}),
		);
	});

	test("every frozen authority record has terminal-newline canonical bytes and independent expected digests", () => {
		const terminalNewline = (bytes: Uint8Array) =>
			new TextDecoder().decode(bytes).endsWith("\n");
		expect(terminalNewline(R1_CAMPAIGN_LOCK_BYTES)).toBe(true);
		expect(terminalNewline(R1_SSH_HOST_RECEIPT_BYTES)).toBe(true);
		expect(terminalNewline(R1_RED_FAILURE_INVENTORY_BYTES)).toBe(true);
		expect(terminalNewline(R1_REPRESENTATIVE_SUITE_FILE_SET_BYTES)).toBe(true);
		expect(sha256Hex(R1_CAMPAIGN_LOCK_BYTES)).toBe(R1_CAMPAIGN_LOCK_SHA256);
		expect(sha256Hex(R1_SSH_HOST_RECEIPT_BYTES)).toBe(
			R1_SSH_HOST_RECEIPT_SHA256,
		);
		expect(sha256Hex(R1_RED_FAILURE_INVENTORY_BYTES)).toBe(
			R1_RED_FAILURE_INVENTORY_SHA256,
		);
		expect(sha256Hex(R1_REPRESENTATIVE_SUITE_FILE_SET_BYTES)).toBe(
			R1_REPRESENTATIVE_SUITE_SHA256,
		);
		expect(terminalNewline(R1_BUN_ROLE_LAUNCH_CONTRACT_BYTES)).toBe(true);
		expect(sha256Hex(R1_BUN_ROLE_LAUNCH_CONTRACT_BYTES)).toBe(
			R1_BUN_ROLE_LAUNCH_CONTRACT_SHA256,
		);
		expect(terminalNewline(R1_ROLE_TUPLE_ORACLE_BYTES)).toBe(true);
		expect(sha256Hex(R1_ROLE_TUPLE_ORACLE_BYTES)).toBe(
			R1_ROLE_TUPLE_ORACLE_SHA256,
		);
		expect(
			R1_HOST_RUNTIME_FACTS_BYTES.map((bytes) => sha256Hex(bytes)),
		).toEqual([...R1_HOST_RUNTIME_FACTS_SHA256S]);
		expect(sha256Hex(R1_HOST_RUNTIME_FACTS_SET_BYTES)).toBe(
			R1_HOST_RUNTIME_FACTS_SET_SHA256,
		);
		expect(
			R1_HOST_LAUNCH_PROVENANCE_BYTES.map((bytes) => sha256Hex(bytes)),
		).toEqual([...R1_HOST_LAUNCH_PROVENANCE_SHA256S]);
		expect(sha256Hex(R1_HOST_LAUNCH_PROVENANCE_SET_BYTES)).toBe(
			R1_HOST_LAUNCH_PROVENANCE_SET_SHA256,
		);
		expect(R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAPS).toHaveLength(2);
		expect(
			R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAPS.map(
				(descriptorMap) => descriptorMap.length,
			),
		).toEqual([20, 22]);
		expect(
			R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAPS.map((descriptorMap) =>
				descriptorMap.map(
					(descriptor) => `${descriptor.logicalName}:${descriptor.fd}`,
				),
			),
		).toEqual([
			[
				"sourceReceiptFd:3",
				"redApprovalBundleFd:4",
				"sourceArchiveFd:5",
				"stagedArchiveFd:6",
				"stagingRootFd:7",
				"bunFd:8",
				"selfFd:9",
				"roleManifestFd:10",
				"addonFd:11",
				"routeToolFd:12",
				"interfaceToolFd:13",
				"rustcFd:14",
				"cargoFd:15",
				"opensslFd:16",
				"execParentFd:17",
				"submissionNonceFd:18",
				"phaseControlFd:19",
				"hostSubmissionOutFd:20",
				"authorityOutFd:21",
				"authorityDigestOutFd:22",
			],
			[
				"sourceReceiptFd:3",
				"redApprovalBundleFd:4",
				"sourceArchiveFd:5",
				"stagedArchiveFd:6",
				"stagingRootFd:7",
				"bunFd:8",
				"selfFd:9",
				"roleManifestFd:10",
				"addonFd:11",
				"ipToolFd:12",
				"tcToolFd:13",
				"rustcFd:14",
				"cargoFd:15",
				"opensslFd:16",
				"cpuInfoFd:17",
				"governorFd:18",
				"ephemeralRangeFd:19",
				"submissionNonceFd:20",
				"sshChallengeFd:21",
				"controlInFd:22",
				"controlOutFd:23",
				"hostSubmissionOutFd:24",
			],
		]);
		const expectedDescriptorDeclarations = [
			[
				[
					"sourceReceiptFd",
					"3",
					"read",
					"regular",
					"regular-file-or-pipe",
					"O_RDONLY",
					"S_IFREG|S_IFIFO",
				],
				[
					"redApprovalBundleFd",
					"4",
					"read",
					"regular",
					"regular-file-or-pipe",
					"O_RDONLY",
					"S_IFREG|S_IFIFO",
				],
				[
					"sourceArchiveFd",
					"5",
					"read",
					"regular",
					"regular-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"stagedArchiveFd",
					"6",
					"read",
					"regular",
					"regular-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"stagingRootFd",
					"7",
					"read",
					"directory",
					"directory",
					"O_RDONLY",
					"S_IFDIR",
				],
				[
					"bunFd",
					"8",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"selfFd",
					"9",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"roleManifestFd",
					"10",
					"read",
					"regular",
					"regular-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"addonFd",
					"11",
					"read",
					"regular",
					"regular-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"routeToolFd",
					"12",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"interfaceToolFd",
					"13",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"rustcFd",
					"14",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"cargoFd",
					"15",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"opensslFd",
					"16",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"execParentFd",
					"17",
					"read",
					"directory",
					"directory",
					"O_RDONLY",
					"S_IFDIR",
				],
				[
					"submissionNonceFd",
					"18",
					"read",
					"pipe",
					"pipe",
					"O_RDONLY",
					"S_IFIFO",
				],
				[
					"phaseControlFd",
					"19",
					"read-write",
					"seqpacket",
					"seqpacket-socket",
					"O_RDWR",
					"S_IFSOCK",
				],
				[
					"hostSubmissionOutFd",
					"20",
					"write",
					"pipe",
					"pipe",
					"O_WRONLY",
					"S_IFIFO",
				],
				[
					"authorityOutFd",
					"21",
					"write",
					"pipe",
					"pipe",
					"O_WRONLY",
					"S_IFIFO",
				],
				[
					"authorityDigestOutFd",
					"22",
					"write",
					"pipe",
					"pipe",
					"O_WRONLY",
					"S_IFIFO",
				],
			],
			[
				[
					"sourceReceiptFd",
					"3",
					"read",
					"regular",
					"regular-file-or-pipe",
					"O_RDONLY",
					"S_IFREG|S_IFIFO",
				],
				[
					"redApprovalBundleFd",
					"4",
					"read",
					"regular",
					"regular-file-or-pipe",
					"O_RDONLY",
					"S_IFREG|S_IFIFO",
				],
				[
					"sourceArchiveFd",
					"5",
					"read",
					"regular",
					"regular-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"stagedArchiveFd",
					"6",
					"read",
					"regular",
					"regular-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"stagingRootFd",
					"7",
					"read",
					"directory",
					"directory",
					"O_RDONLY",
					"S_IFDIR",
				],
				[
					"bunFd",
					"8",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"selfFd",
					"9",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"roleManifestFd",
					"10",
					"read",
					"regular",
					"regular-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"addonFd",
					"11",
					"read",
					"regular",
					"regular-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"ipToolFd",
					"12",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"tcToolFd",
					"13",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"rustcFd",
					"14",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"cargoFd",
					"15",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"opensslFd",
					"16",
					"read",
					"executable",
					"regular-executable",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"cpuInfoFd",
					"17",
					"read",
					"observation-file",
					"bounded-proc-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"governorFd",
					"18",
					"read",
					"observation-file",
					"bounded-proc-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"ephemeralRangeFd",
					"19",
					"read",
					"observation-file",
					"bounded-proc-file",
					"O_RDONLY",
					"S_IFREG",
				],
				[
					"submissionNonceFd",
					"20",
					"read",
					"pipe",
					"pipe",
					"O_RDONLY",
					"S_IFIFO",
				],
				["sshChallengeFd", "21", "read", "pipe", "pipe", "O_RDONLY", "S_IFIFO"],
				["controlInFd", "22", "read", "pipe", "pipe", "O_RDONLY", "S_IFIFO"],
				["controlOutFd", "23", "write", "pipe", "pipe", "O_WRONLY", "S_IFIFO"],
				[
					"hostSubmissionOutFd",
					"24",
					"write",
					"pipe",
					"pipe",
					"O_WRONLY",
					"S_IFIFO",
				],
			],
		];
		expect(
			R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAPS.map((descriptorMap) =>
				descriptorMap.map((descriptor) => [
					descriptor.logicalName,
					String(descriptor.fd),
					descriptor.access,
					descriptor.kind,
					descriptor.declaredType,
					descriptor.fgetflAccessMode,
					descriptor.fstatType,
				]),
			),
		).toEqual(expectedDescriptorDeclarations);
		expect(
			R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAPS.flat().every(
				(descriptor) =>
					descriptor.closeOnExec === false &&
					descriptor.inheritedByChild === false,
			),
		).toBe(true);
		expect(
			R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_BYTES.map((bytes) =>
				sha256Hex(bytes),
			),
		).toEqual([...R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_SHA256S]);
		expect(sha256Hex(R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_SET_BYTES)).toBe(
			R1_RESIDENT_SUPERVISOR_DESCRIPTOR_MAP_SET_SHA256,
		);
		expect(
			new TextDecoder().decode(R1_SUPERVISOR_PHYSICAL_OBSERVATION_BYTES),
		).toBe(`${canonicalJson(R1_SUPERVISOR_PHYSICAL_OBSERVATION)}\n`);
		expect(sha256Hex(R1_SUPERVISOR_PHYSICAL_OBSERVATION_BYTES)).toBe(
			R1_SUPERVISOR_PHYSICAL_OBSERVATION_SHA256,
		);
		expect(new TextDecoder().decode(R1_SUPERVISOR_INPUT_V1_BYTES)).toBe(
			`${canonicalJson(R1_SUPERVISOR_INPUT_V1)}\n`,
		);
		expect(sha256Hex(R1_SUPERVISOR_INPUT_V1_BYTES)).toBe(
			R1_SUPERVISOR_INPUT_V1_SHA256,
		);
		expect(new TextDecoder().decode(R1_SUPERVISOR_OUTPUT_V1_BYTES)).toBe(
			`${canonicalJson(R1_SUPERVISOR_OUTPUT_V1)}\n`,
		);
		expect(sha256Hex(R1_SUPERVISOR_OUTPUT_V1_BYTES)).toBe(
			R1_SUPERVISOR_OUTPUT_V1_SHA256,
		);
		expect(
			new TextDecoder().decode(R1_COMPARISON_SUPERVISOR_ERROR_V1_BYTES),
		).toBe(`${canonicalJson(R1_COMPARISON_SUPERVISOR_ERROR_V1)}\n`);
		expect(sha256Hex(R1_COMPARISON_SUPERVISOR_ERROR_V1_BYTES)).toBe(
			R1_COMPARISON_SUPERVISOR_ERROR_V1_SHA256,
		);
		expect(R1_RED_APPROVAL_FIXTURE_METADATA).toEqual(
			expect.objectContaining({
				fixtureOnly: true,
				fictionalApprovalRecords: true,
				notExternalApproval: true,
				redSuiteDigestIsCurrentSevenFileSet: false,
				rustByteDigestIsCurrent: false,
				finalExternalApprovalClaim: false,
			}),
		);
		expect(R1_STAGED_APPROVAL_FIXTURE_METADATA).toEqual(
			expect.objectContaining({
				fixtureOnly: true,
				fictionalApprovalRecords: true,
				notExternalApproval: true,
				redSuiteDigestIsCurrentSevenFileSet: false,
				rustByteDigestIsCurrent: false,
				finalExternalApprovalClaim: false,
			}),
		);
		expect(
			R1_STAGED_ARCHIVE_RECEIPT_BYTES.map((bytes) => sha256Hex(bytes)),
		).toEqual([...R1_STAGED_ARCHIVE_RECEIPT_SHA256S]);
		expect([...R1_STAGED_ARCHIVE_RECEIPT_CANONICAL_SHA256S]).toEqual([
			...R1_STAGED_ARCHIVE_RECEIPT_SHA256S,
		]);
		expect(R1_HOST_SUBMISSION_BYTES.map((bytes) => sha256Hex(bytes))).toEqual([
			...R1_HOST_SUBMISSION_EXPECTED_SHA256S,
		]);
		expect(
			R1_STAGED_METADATA_RECEIPT_BYTES.map((bytes) => sha256Hex(bytes)),
		).toEqual([...R1_STAGED_METADATA_RECEIPT_EXPECTED_SHA256S]);
		expect(sha256Hex(R1_STAGED_METADATA_RECEIPT_SET_BYTES)).toBe(
			R1_STAGED_METADATA_RECEIPT_SET_SHA256,
		);
		for (const bytes of [
			R1_CAMPAIGN_LOCK_BYTES,
			R1_SSH_HOST_RECEIPT_BYTES,
			R1_BUN_ROLE_LAUNCH_CONTRACT_BYTES,
			R1_ROLE_TUPLE_ORACLE_BYTES,
			R1_HOST_RUNTIME_FACTS_SET_BYTES,
			R1_HOST_LAUNCH_PROVENANCE_SET_BYTES,
			R1_SUPERVISOR_PHYSICAL_OBSERVATION_BYTES,
			R1_SUPERVISOR_INPUT_V1_BYTES,
			R1_SUPERVISOR_OUTPUT_V1_BYTES,
			R1_COMPARISON_SUPERVISOR_ERROR_V1_BYTES,
			...R1_STAGED_ARCHIVE_RECEIPT_BYTES,
			...R1_HOST_SUBMISSION_BYTES,
			...R1_STAGED_METADATA_RECEIPT_BYTES,
		]) {
			expect(sha256Hex(byteFlip(bytes))).not.toBe(sha256Hex(bytes));
		}
	});

	test("descriptor-only role loading accepts exactly the four approved child roots and rejects path, environment, descriptor, and loader bypasses", async () => {
		const mod = await importExpectedModule("./supervisor-protocol.ts");
		const loads = R1_DESCRIPTOR_ONLY_ROLE_LOADS;
		expect(
			requiredExport(
				mod,
				"validateDescriptorOnlyRoleLoading",
			)({
				loads,
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
				environment: { LC_ALL: "C", COMPARISON_ADDON_FD: "32" },
			}),
		).toEqual(expect.objectContaining({ ok: true, roleCount: 4 }));
		for (const [mutation, code] of [
			[
				{
					loads: loads.map((load, i) =>
						i === 0
							? { ...load, roleEntrypoint: "tools/compare/run-campaign.ts" }
							: load,
					),
				},
				"TRUST_ROLE_PATH_AUTHORITY_FORBIDDEN",
			],
			[{ loads: [...loads, loads[0]] }, "TRUST_ROLE_COUNT_INVALID"],
			[
				{
					loads: loads.map((load, i) =>
						i === 1
							? { ...load, addonPath: "./prebuilds/webtransport.node" }
							: load,
					),
				},
				"TRUST_ADDON_FALLBACK_FORBIDDEN",
			],
			[
				{
					loads: loads.map((load, i) =>
						i === 2 ? { ...load, roleFd: 31 } : load,
					),
				},
				"TRUST_DESCRIPTOR_DUPLICATE",
			],
			[
				{
					loads,
					environment: {
						...{ AUTHORITY_SHA256: R1_CAMPAIGN_AUTHORITY_SHA256 },
					},
				},
				"TRUST_AUTHORITY_ENV_FORBIDDEN",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"validateDescriptorOnlyRoleLoading",
				)({
					...mutation,
					authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});

	test("authority digest graph is acyclic and invalidates every downstream record when an authority-bearing input changes", async () => {
		const mod = await importExpectedModule("./secure-fs.ts");
		expect(
			requiredExport(
				mod,
				"validateAuthorityDigestGraph",
			)({
				authority: R1_CAMPAIGN_AUTHORITY,
				authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
				edges: R1_AUTHORITY_DIGEST_GRAPH,
			}),
		).toEqual(expect.objectContaining({ ok: true, acyclic: true }));
		for (const [edges, code] of [
			[
				[
					...R1_AUTHORITY_DIGEST_GRAPH,
					["run/raw/snapshot", "campaign-authority/v1"],
				],
				"TRUST_AUTHORITY_DIGEST_CYCLE",
			],
			[
				[...R1_AUTHORITY_DIGEST_GRAPH].filter(
					([from]) => from !== "campaign-authority/v1",
				),
				"TRUST_AUTHORITY_DIGEST_EDGE_MISSING",
			],
			[
				[
					...R1_AUTHORITY_DIGEST_GRAPH,
					["campaign-authority/v1", "campaign-lock/v1"],
				],
				"TRUST_AUTHORITY_DIGEST_EDGE_DUPLICATE",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"validateAuthorityDigestGraph",
				)({
					authority: R1_CAMPAIGN_AUTHORITY,
					authoritySha256: R1_CAMPAIGN_AUTHORITY_SHA256,
					edges,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});
});

// A0-5, ratified 2026-08-27.  This test is deliberately sited inside the
// frozen suite: outside it the ratification is unenforced and a later change
// to `rankAt` would be free.  Inside it, changing one is a bundle reopen,
// which is the intended contract.
interface ProbedContract {
	readonly direction: string;
	readonly rankAt: string;
	readonly unit: string;
	readonly minSamples?: number;
}

interface ProbedEvidenceModule {
	readonly PRIMARY_METRIC_CONTRACTS?: Record<string, ProbedContract>;
	readonly resolveRankPercentile?: (...args: never[]) => number;
	readonly metricContractHash?: (...args: never[]) => string;
}

interface ProbedSummary {
	readonly min: number;
	readonly p1: number;
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
}

interface ProbedStatsModule {
	readonly sampleSummary?: (...args: never[]) => ProbedSummary;
	readonly percentile?: (...args: never[]) => number;
}

function requiredContractTable(
	moduleValue: ProbedEvidenceModule,
): Record<string, ProbedContract> {
	const table = moduleValue.PRIMARY_METRIC_CONTRACTS;
	if (!table) {
		throw new Error(
			"missing required production export: PRIMARY_METRIC_CONTRACTS",
		);
	}
	return table;
}

function requiredFn<T>(value: T | undefined, name: string): T {
	if (typeof value !== "function") {
		throw new Error(`missing required production export: ${name}`);
	}
	return value;
}

function contractOf(
	table: Record<string, ProbedContract>,
	scenarioId: string,
): ProbedContract {
	const contract = table[scenarioId];
	if (!contract) throw new Error(`missing contract ${scenarioId}`);
	return contract;
}

describe("R1 RED: ranking statistic is direction-aware", () => {
	const IN_SCOPE = [
		"game-tick-loss",
		"ai-token-stream",
		"ticker-fanout",
		"tail-under-cross-traffic",
		"crdt-sync",
	] as const;
	const OUT_OF_SCOPE = [
		"chat-fanout",
		"reconnect-storm",
		"handshake-matrix",
		"connection-memory",
		"bulk-one-way",
	] as const;

	test("every in-scope scenario ranks at the adverse tail and every other at the median", async () => {
		const mod: ProbedEvidenceModule = await import("./evidence.ts");
		const contracts = requiredContractTable(mod);
		expect(Object.keys(contracts).sort()).toEqual(
			[...IN_SCOPE, ...OUT_OF_SCOPE].sort(),
		);
		for (const scenarioId of IN_SCOPE) {
			expect(contractOf(contracts, scenarioId).rankAt).toBe("adverse-tail");
		}
		for (const scenarioId of OUT_OF_SCOPE) {
			expect(contractOf(contracts, scenarioId).rankAt).toBe("median");
		}
	});

	// Asserted as a pair in one test on purpose.  A positional constant
	// satisfies either half alone; nothing positional satisfies both, which is
	// what makes this catch the defect the ruling fixes.
	test("adverse-tail resolves to the low percentile for a higher-is-better metric and the high one for a lower-is-better metric", async () => {
		const mod: ProbedEvidenceModule = await import("./evidence.ts");
		const contracts = requiredContractTable(mod);
		const resolve = requiredFn(
			mod.resolveRankPercentile,
			"resolveRankPercentile",
		) as (contract: ProbedContract) => number;
		const game = contractOf(contracts, "game-tick-loss");
		const tail = contractOf(contracts, "tail-under-cross-traffic");
		expect(game.direction).toBe("higher");
		expect(tail.direction).toBe("lower");
		expect(resolve(game)).toBe(1);
		expect(resolve(tail)).toBe(99);
		expect(resolve(contractOf(contracts, "chat-fanout"))).toBe(50);
	});

	test("perturbing one rankAt moves the metric contract hash", async () => {
		const mod: ProbedEvidenceModule = await import("./evidence.ts");
		const contracts = requiredContractTable(mod);
		const hash = requiredFn(mod.metricContractHash, "metricContractHash") as (
			contract: ProbedContract,
		) => string;
		const original = contractOf(contracts, "game-tick-loss");
		expect(hash({ ...original, rankAt: "median" })).not.toBe(hash(original));
	});

	// R8-ab: `adverse-tail` on a higher-is-better metric resolves to p1, so p1
	// has to be a computed member of the summary rather than a fourth name for
	// the minimum.
	test("p1 is computed, ordered below p50, and re-derivable within 1e-9", async () => {
		const stats: ProbedStatsModule = await import("./stats.ts");
		const sampleSummary = requiredFn(stats.sampleSummary, "sampleSummary") as (
			samples: readonly number[],
		) => ProbedSummary;
		const percentile = requiredFn(stats.percentile, "percentile") as (
			samples: readonly number[],
			p: number,
		) => number;
		const samples = [...Array(500).fill(10), ...Array(500).fill(14)];
		const summary = sampleSummary(samples);
		expect(summary.p1).toBe(10);
		expect(summary.p50).toBe(12);
		expect(summary.p95).toBe(14);
		expect(summary.p99).toBe(14);
		expect(summary.p1).toBeLessThanOrEqual(summary.p50);
		expect(Math.abs(summary.p1 - percentile(samples, 1))).toBeLessThan(1e-9);
		// p1 is not the minimum: a distribution with a single low outlier
		// keeps its minimum below p1.
		const skewed = [0, ...Array(999).fill(5)];
		expect(sampleSummary(skewed).min).toBe(0);
		expect(sampleSummary(skewed).p1).toBe(5);
	});

	test("the latency contracts carry a sample floor and the throughput contracts do not", async () => {
		const mod: ProbedEvidenceModule = await import("./evidence.ts");
		const contracts = requiredContractTable(mod);
		for (const contract of Object.values(contracts)) {
			if (contract.unit === "ms") {
				expect(contract.minSamples).toBe(1000);
			} else {
				expect(contract.minSamples).toBeUndefined();
			}
		}
	});
});
