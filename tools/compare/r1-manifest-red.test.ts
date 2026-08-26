import { describe, expect, test } from "bun:test";
import { canonicalJson } from "./canonical.ts";
import { ALL_F_SENTINEL_SHA256, EMPTY_SHA256 } from "./output-policy.ts";
import { CANONICAL_SCENARIO_REGISTRY } from "./scenario-registry.ts";
import type {
	ManifestRunEntry,
	PhaseKind,
	RawKind,
	TransportKind,
} from "./r1-fixtures.ts";
import {
	EXPECTED_CELL_CONTRACTS,
	EXPECTED_CELL_IDS,
	EXPECTED_ARM_IDS,
	R1_MANIFEST_DESCRIPTOR_EXPECTED_COUNT,
	R1_MANIFEST_DESCRIPTOR_ORDER,
	R1_CAMPAIGN_MANIFEST_V1,
	R1_CAMPAIGN_MANIFEST_V1_BYTES,
	R1_CAMPAIGN_MANIFEST_V1_SHA256,
	R1_OBSERVED_ATTESTATION_V1,
	R1_OBSERVED_ATTESTATION_V1_BYTES,
	R1_OBSERVED_ATTESTATION_V1_SHA256,
	R1_CAMPAIGN_VERIFIER_RESULT_V1,
	R1_CAMPAIGN_VERIFIER_RESULT_V1_BYTES,
	R1_CAMPAIGN_VERIFIER_RESULT_V1_SHA256,
	R1_CAMPAIGN_REPORT_V1,
	R1_CAMPAIGN_REPORT_V1_BYTES,
	R1_CAMPAIGN_REPORT_V1_SHA256,
	byteFlip,
	canonicalBytes,
	importExpectedModule,
	requiredExport,
	measuredArtifactRecordFor,
	representativeFixture,
	sha256Hex,
	setAtPath,
} from "./r1-fixtures.ts";

describe("R1 RED: current registry and execution model mismatches", () => {
	test("canonical registry exposes exact 35 WS primary, 35 WT primary, and 12 overlay arms with valid overlayOf bindings and no legacy discriminants", () => {
		const arms = CANONICAL_SCENARIO_REGISTRY.arms as unknown as Array<
			Record<string, unknown>
		>;
		const cells = CANONICAL_SCENARIO_REGISTRY.cells as unknown as Array<
			Record<string, unknown>
		>;
		const wsPrimary = arms.filter(
			(arm) => arm.armKind === "primary" && arm.transport === "ws",
		);
		const wtPrimary = arms.filter(
			(arm) => arm.armKind === "primary" && arm.transport === "wt",
		);
		const overlayArms = arms.filter((arm) => arm.armKind === "overlay");
		const armIds = new Set(arms.map((arm) => String(arm.armId)));

		expect(cells.map((cell) => cell.cellId)).toEqual([...EXPECTED_CELL_IDS]);
		expect(arms.map((arm) => arm.armId)).toEqual([...EXPECTED_ARM_IDS]);
		expect(
			arms.every(
				(arm) => arm.armKind === "primary" || arm.armKind === "overlay",
			),
		).toBe(true);
		expect(
			cells.map((cell) => ({
				cellId: cell.cellId,
				scenarioId: cell.scenarioId,
				warmupRepetitions: (cell.runPolicy as unknown as Record<string, number>)
					.warmupRepetitions,
				measuredRepetitions: (
					cell.runPolicy as unknown as Record<string, number>
				).measuredRepetitions,
				expectedStartTransport: EXPECTED_CELL_CONTRACTS.find(
					(expected) => expected.cellId === cell.cellId,
				)?.expectedStartTransport,
				hasOverlay: arms.some(
					(arm) => arm.cellId === cell.cellId && arm.armKind === "overlay",
				),
			})),
		).toEqual([...EXPECTED_CELL_CONTRACTS]);
		expect(wsPrimary).toHaveLength(35);
		expect(wtPrimary).toHaveLength(35);
		expect(overlayArms).toHaveLength(12);
		expect(overlayArms.every((arm) => arm.transport === "ws")).toBe(true);
		expect(
			overlayArms.every((arm) => arm.overlayOf === `${String(arm.cellId)}/ws`),
		).toBe(true);
		expect(
			overlayArms.every(
				(arm) =>
					armIds.has(String(arm.overlayOf)) &&
					wsPrimary.some(
						(primary) =>
							primary.armId === arm.overlayOf && primary.cellId === arm.cellId,
					),
			),
		).toBe(true);
		expect(
			arms.some(
				(arm) =>
					arm.armKind === "ws-lossy-overlay" ||
					arm.transport === "ws-lossy-overlay",
			),
		).toBe(false);
	});

	test("representative fixture expands the exact 588-run schedule with independent per-cell seeded order, odd-tail behavior, overlay adjacency, and monotonic execution indexes", () => {
		const fixture = representativeFixture();
		const warmups = fixture.runEntries.filter(
			(entry) => entry.phase === "warmup",
		);
		const measured = fixture.runEntries.filter(
			(entry) => entry.phase === "measured",
		);
		const overlayRuns = fixture.runEntries.filter(
			(entry) => entry.armKind === "overlay",
		);

		expect(fixture.runEntries).toHaveLength(588);
		expect(warmups).toHaveLength(98);
		expect(measured).toHaveLength(490);
		expect(fixture.runEntries.map((entry) => entry.executionIndex)).toEqual(
			Array.from({ length: fixture.runEntries.length }, (_, index) => index),
		);
		expect(
			new Set(fixture.runEntries.map((entry) => entry.executionIndex)).size,
		).toBe(588);
		expect(new Set(overlayRuns.map((entry) => entry.armId)).size).toBe(12);

		// Fixture-pure by design (Task A step 2: literal expectations
		// independent of production helpers): the frozen cell contracts are
		// the iteration source; the registry-vs-fixture comparisons live in
		// the RED registry oracles, not in this self-integrity pass.
		for (const expectedCell of EXPECTED_CELL_CONTRACTS) {
			for (const phase of ["warmup", "measured"] as const) {
				const repetitions =
					phase === "warmup"
						? expectedCell.warmupRepetitions
						: expectedCell.measuredRepetitions;
				const cellPhaseRuns = fixture.runEntries.filter(
					(entry) =>
						entry.cellId === expectedCell.cellId && entry.phase === phase,
				);
				const primaryRuns = cellPhaseRuns.filter(
					(entry) => entry.armKind === "primary",
				);
				const alternate: TransportKind =
					expectedCell.expectedStartTransport === "ws" ? "wt" : "ws";
				const expectedPrimary: Array<{
					transport: TransportKind;
					repetitionIndex: number;
				}> = [];
				for (
					let repetitionIndex = 0;
					repetitionIndex < repetitions;
					repetitionIndex += 2
				) {
					if (repetitionIndex + 1 === repetitions) {
						expectedPrimary.push({
							transport: expectedCell.expectedStartTransport,
							repetitionIndex,
						});
						expectedPrimary.push({
							transport: alternate,
							repetitionIndex,
						});
						continue;
					}
					expectedPrimary.push({
						transport: expectedCell.expectedStartTransport,
						repetitionIndex,
					});
					expectedPrimary.push({ transport: alternate, repetitionIndex });
					expectedPrimary.push({
						transport: alternate,
						repetitionIndex: repetitionIndex + 1,
					});
					expectedPrimary.push({
						transport: expectedCell.expectedStartTransport,
						repetitionIndex: repetitionIndex + 1,
					});
				}

				expect(primaryRuns).toHaveLength(repetitions * 2);
				expect(
					primaryRuns.map(
						(entry) => `${entry.transport}@${entry.repetitionIndex}`,
					),
				).toEqual(
					expectedPrimary.map(
						(slot) => `${slot.transport}@${slot.repetitionIndex}`,
					),
				);
				expect(
					primaryRuns.every(
						(entry) =>
							entry.phasePrimaryTransportSequence.join(",") ===
							expectedPrimary.map((slot) => slot.transport).join(","),
					),
				).toBe(true);
				expect(
					primaryRuns.at(-2)?.repetitionIndex === repetitions - 1 &&
						primaryRuns.at(-1)?.repetitionIndex === repetitions - 1,
				).toBe(true);

				if (cell.scenarioId === "game-tick-loss") {
					for (let index = 0; index < cellPhaseRuns.length; index += 1) {
						const current = cellPhaseRuns[index]!;
						if (current.armKind !== "overlay") continue;
						const previous = cellPhaseRuns[index - 1]!;
						expect(previous.armKind).toBe("primary");
						expect(previous.transport).toBe("ws");
						expect(current.overlayOf).toBe(previous.armId);
						expect(current.repetitionIndex).toBe(previous.repetitionIndex);
					}
				}
			}
		}
	});

	test("representative fixture binds 588 artifacts, 2940 per-run raw descriptors, and 70 once-per-cell snapshot descriptors outside run counts", () => {
		const fixture = representativeFixture();
		const rawDescriptors = fixture.runEntries.flatMap(
			(entry) => entry.rawDescriptors,
		);

		expect(Object.keys(fixture.artifactBytesByPath)).toHaveLength(588);
		expect(Object.keys(fixture.rawBytesByPath)).toHaveLength(2940);
		expect(rawDescriptors).toHaveLength(2940);
		expect(fixture.cellSnapshotBundles).toHaveLength(35);
		expect(Object.keys(fixture.snapshotBytesByPath)).toHaveLength(70);
		expect(
			fixture.cellSnapshotBundles.every(
				(bundle) =>
					bundle.preCell.kind === "snapshot-pre" &&
					bundle.postCell.kind === "snapshot-post",
			),
		).toBe(true);
	});
});

describe("R1 RED: amendment manifest and descriptor contracts", () => {
	test("campaign-manifest/v1 and downstream frozen records use exact envelopes, paths, counts, and literal digests", () => {
		expect(R1_CAMPAIGN_MANIFEST_V1.schema).toBe("campaign-manifest/v1");
		expect(R1_CAMPAIGN_MANIFEST_V1.descriptors).toHaveLength(3599);
		expect(R1_CAMPAIGN_MANIFEST_V1.cardinality).toEqual(
			expect.objectContaining({
				cellCount: 35,
				armCount: 82,
				executionCount: 588,
				rawDescriptorCount: 2940,
				snapshotDescriptorCount: 70,
				descriptorCount: 3599,
			}),
		);
		expect(R1_CAMPAIGN_MANIFEST_V1.descriptors[0]).toEqual(
			expect.objectContaining({
				kind: "artifact",
				components: ["official", "artifacts", expect.any(String)],
				runId: expect.any(String),
				executionIndex: 0,
			}),
		);
		expect(R1_CAMPAIGN_MANIFEST_V1.descriptors.at(-1)).toEqual(
			expect.objectContaining({
				kind: "attestation",
				components: ["official", "observed-attestation.json"],
				cellId: "campaign",
				runId: null,
				executionIndex: null,
			}),
		);
		expect(R1_CAMPAIGN_MANIFEST_V1.descriptors.at(-1)?.sha256).toBe(
			R1_OBSERVED_ATTESTATION_V1_SHA256,
		);
		expect(
			R1_CAMPAIGN_MANIFEST_V1.descriptors.filter(
				(descriptor) => descriptor.kind === "snapshot-pre",
			),
		).toHaveLength(35);
		expect(
			R1_CAMPAIGN_MANIFEST_V1.descriptors.filter(
				(descriptor) => descriptor.kind === "snapshot-post",
			),
		).toHaveLength(35);
		expect(
			new TextDecoder().decode(R1_CAMPAIGN_MANIFEST_V1_BYTES).endsWith("\n"),
		).toBe(true);
		expect(sha256Hex(R1_CAMPAIGN_MANIFEST_V1_BYTES)).toBe(
			R1_CAMPAIGN_MANIFEST_V1_SHA256,
		);
		expect(R1_OBSERVED_ATTESTATION_V1.schema).toBe("observed-attestation/v1");
		expect(R1_OBSERVED_ATTESTATION_V1.childAuthoredObservationForbidden).toBe(
			true,
		);
		expect(R1_OBSERVED_ATTESTATION_V1.pathSnapshotCount).toBe(70);
		expect(R1_OBSERVED_ATTESTATION_V1.runNetworkReceiptCount).toBe(588);
		expect(sha256Hex(R1_OBSERVED_ATTESTATION_V1_BYTES)).toBe(
			R1_OBSERVED_ATTESTATION_V1_SHA256,
		);
		expect(R1_CAMPAIGN_VERIFIER_RESULT_V1.schema).toBe(
			"campaign-verifier-result/v1",
		);
		expect(R1_CAMPAIGN_VERIFIER_RESULT_V1.promotable).toBe(false);
		expect(sha256Hex(R1_CAMPAIGN_VERIFIER_RESULT_V1_BYTES)).toBe(
			R1_CAMPAIGN_VERIFIER_RESULT_V1_SHA256,
		);
		expect(R1_CAMPAIGN_REPORT_V1.schema).toBe("campaign-report/v1");
		expect(R1_CAMPAIGN_REPORT_V1.comparisonRowCount).toBe(0);
		expect(sha256Hex(R1_CAMPAIGN_REPORT_V1_BYTES)).toBe(
			R1_CAMPAIGN_REPORT_V1_SHA256,
		);
		expect(sha256Hex(byteFlip(R1_CAMPAIGN_MANIFEST_V1_BYTES))).not.toBe(
			R1_CAMPAIGN_MANIFEST_V1_SHA256,
		);
		expect(sha256Hex(byteFlip(R1_OBSERVED_ATTESTATION_V1_BYTES))).not.toBe(
			R1_OBSERVED_ATTESTATION_V1_SHA256,
		);
		expect(sha256Hex(byteFlip(R1_CAMPAIGN_VERIFIER_RESULT_V1_BYTES))).not.toBe(
			R1_CAMPAIGN_VERIFIER_RESULT_V1_SHA256,
		);
		expect(sha256Hex(byteFlip(R1_CAMPAIGN_REPORT_V1_BYTES))).not.toBe(
			R1_CAMPAIGN_REPORT_V1_SHA256,
		);
	});

	test("manifest validation binds runs, artifacts, raw descriptors, and snapshots with exact lock and campaign identity plus restoration precedence", async () => {
		const fixture = representativeFixture();
		const mod = (await importExpectedModule("./manifest-lock.ts")) as Record<
			string,
			(args: unknown) => unknown
		>;

		expect(
			requiredExport(
				mod,
				"validateLockedManifest",
			)({
				lock: fixture.lock,
				expectedLockDigest: fixture.expectedLockDigest,
				manifest: fixture.manifest,
				artifactBytesByPath: fixture.artifactBytesByPath,
				rawBytesByPath: fixture.rawBytesByPath,
				snapshotBytesByPath: fixture.snapshotBytesByPath,
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				warmupRunCount: 98,
				measuredRunCount: 490,
				artifactCount: 588,
				rawDescriptorCount: 2940,
				cellSnapshotBundleCount: 35,
			}),
		);
		for (const [label, input, code] of [
			[
				"missing run",
				{
					manifest: {
						...fixture.manifest,
						runEntries: fixture.manifest.runEntries.slice(1),
					},
				},
				"MANIFEST_RUN_MISSING",
			],
			[
				"extra run",
				{
					manifest: {
						...fixture.manifest,
						runEntries: [
							...fixture.manifest.runEntries,
							fixture.manifest.runEntries[0]!,
						],
					},
				},
				"MANIFEST_RUN_DUPLICATE",
			],
			[
				"artifact digest mismatch",
				{
					artifactBytesByPath: {
						...fixture.artifactBytesByPath,
						[fixture.manifest.runEntries[0]!.artifact.relativePath]: byteFlip(
							fixture.artifactBytesByPath[
								fixture.manifest.runEntries[0]!.artifact.relativePath
							]!,
						),
					},
				},
				"MANIFEST_ARTIFACT_DIGEST_MISMATCH",
			],
			[
				"artifact traversal",
				{
					manifest: {
						...fixture.manifest,
						runEntries: fixture.manifest.runEntries.map((entry, index) =>
							index === 0
								? {
										...entry,
										artifact: {
											...entry.artifact,
											relativePath: "../evil.json",
										},
									}
								: entry,
						),
					},
				},
				"MANIFEST_ARTIFACT_PATH_TRAVERSAL",
			],
			[
				"artifact absolute path",
				{
					manifest: {
						...fixture.manifest,
						runEntries: fixture.manifest.runEntries.map((entry, index) =>
							index === 0
								? {
										...entry,
										artifact: {
											...entry.artifact,
											relativePath: "/abs/evil.json",
										},
									}
								: entry,
						),
					},
				},
				"MANIFEST_ARTIFACT_PATH_ABSOLUTE",
			],
			[
				"raw kind missing",
				{
					manifest: {
						...fixture.manifest,
						runEntries: fixture.manifest.runEntries.map((entry, index) =>
							index === 0
								? {
										...entry,
										rawDescriptors: entry.rawDescriptors.slice(1),
									}
								: entry,
						),
					},
				},
				"MANIFEST_RAW_DESCRIPTOR_MISSING",
			],
			[
				"raw digest mismatch",
				{
					rawBytesByPath: {
						...fixture.rawBytesByPath,
						[fixture.manifest.runEntries[0]!.rawDescriptors[0]!.relativePath]:
							byteFlip(
								fixture.rawBytesByPath[
									fixture.manifest.runEntries[0]!.rawDescriptors[0]!
										.relativePath
								]!,
							),
					},
				},
				"MANIFEST_RAW_DIGEST_MISMATCH",
			],
			[
				"raw empty digest sentinel",
				{
					manifest: {
						...fixture.manifest,
						runEntries: fixture.manifest.runEntries.map((entry, index) =>
							index === 0
								? {
										...entry,
										rawDescriptors: [
											{
												...entry.rawDescriptors[0]!,
												sha256: EMPTY_SHA256,
											},
											...entry.rawDescriptors.slice(1),
										] as unknown as ManifestRunEntry["rawDescriptors"],
									}
								: entry,
						),
					},
				},
				"MANIFEST_RAW_EMPTY_DIGEST_FORBIDDEN",
			],
			[
				"raw all-f sentinel",
				{
					manifest: {
						...fixture.manifest,
						runEntries: fixture.manifest.runEntries.map((entry, index) =>
							index === 0
								? {
										...entry,
										rawDescriptors: [
											{
												...entry.rawDescriptors[0]!,
												sha256: ALL_F_SENTINEL_SHA256,
											},
											...entry.rawDescriptors.slice(1),
										] as unknown as ManifestRunEntry["rawDescriptors"],
									}
								: entry,
						),
					},
				},
				"MANIFEST_RAW_ALL_F_DIGEST_FORBIDDEN",
			],
			[
				"snapshot missing",
				{
					snapshotBytesByPath: Object.fromEntries(
						Object.entries(fixture.snapshotBytesByPath).slice(1),
					),
				},
				"MANIFEST_SNAPSHOT_MISSING",
			],
			[
				"snapshot digest mismatch precedence",
				{
					snapshotBytesByPath: {
						...fixture.snapshotBytesByPath,
						[fixture.cellSnapshotBundles[0]!.postCell.relativePath]: byteFlip(
							fixture.snapshotBytesByPath[
								fixture.cellSnapshotBundles[0]!.postCell.relativePath
							]!,
						),
					},
				},
				"MANIFEST_SNAPSHOT_DIGEST_MISMATCH",
			],
			[
				"cross campaign",
				{
					manifest: {
						...fixture.manifest,
						campaignId: "campaign-drift",
					},
				},
				"MANIFEST_CAMPAIGN_MISMATCH",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"validateLockedManifest",
				)({
					lock: fixture.lock,
					expectedLockDigest: fixture.expectedLockDigest,
					manifest: "manifest" in input ? input.manifest : fixture.manifest,
					artifactBytesByPath:
						"artifactBytesByPath" in input
							? input.artifactBytesByPath
							: fixture.artifactBytesByPath,
					rawBytesByPath:
						"rawBytesByPath" in input
							? input.rawBytesByPath
							: fixture.rawBytesByPath,
					snapshotBytesByPath:
						"snapshotBytesByPath" in input
							? input.snapshotBytesByPath
							: fixture.snapshotBytesByPath,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
		const unrestoredSnapshotBytes = {
			...fixture.snapshotBytesByPath,
			[fixture.cellSnapshotBundles[0]!.postCell.relativePath]: canonicalBytes({
				cellId: fixture.cellSnapshotBundles[0]!.cellId,
				candidateId: fixture.candidateId,
				campaignId: fixture.campaignId,
				kind: "snapshot-post",
				restoredQdisc: "netem loss 5%",
				dedicatedPgidObserved: 4300,
				cleanupStatus: "not-restored",
			}),
		};
		expect(
			requiredExport(
				mod,
				"validateLockedManifest",
			)({
				lock: fixture.lock,
				expectedLockDigest: fixture.expectedLockDigest,
				manifest: {
					...fixture.manifest,
					cellSnapshotBundles: fixture.manifest.cellSnapshotBundles.map(
						(bundle, index) =>
							index === 0
								? {
										...bundle,
										postCell: {
											...bundle.postCell,
											sha256: sha256Hex(
												unrestoredSnapshotBytes[bundle.postCell.relativePath]!,
											),
										},
									}
								: bundle,
					),
				},
				artifactBytesByPath: fixture.artifactBytesByPath,
				rawBytesByPath: fixture.rawBytesByPath,
				snapshotBytesByPath: unrestoredSnapshotBytes,
			}),
		).toEqual(
			expect.objectContaining({
				ok: false,
				evidenceStatus: "FAIL",
				scenarioVerdict: "NO_VERDICT",
				code: "CELL_POST_SNAPSHOT_RESTORATION_MISMATCH",
			}),
		);
	});

	test("delta set produces exactly 35 measured primary comparisons, excludes overlays and warmups, accepts distinct raw hashes, and zeros out missing or blocked or failed or incompatible evidence", async () => {
		const fixture = representativeFixture();
		const mod = (await importExpectedModule("./manifest-lock.ts")) as Record<
			string,
			(args: unknown) => unknown
		>;
		const measuredPrimaryRuns = fixture.manifest.runEntries.filter(
			(entry) => entry.phase === "measured" && entry.armKind === "primary",
		);
		const verifiedArtifactsByRunInstanceId = Object.fromEntries(
			fixture.manifest.runEntries.map((entry) => [
				entry.runInstanceId,
				measuredArtifactRecordFor(entry, {
					evidenceStatus: entry.phase === "warmup" ? "PASS" : "PASS",
					scenarioVerdict: entry.phase === "warmup" ? "NO_VERDICT" : "PASS",
					promotable: entry.phase === "measured" && entry.armKind === "primary",
					rawSidecarDigests: Object.fromEntries(
						entry.rawDescriptors.map((descriptor) => [
							descriptor.kind,
							`${entry.transport}-${descriptor.sha256}`,
						]),
					),
				}),
			]),
		);

		const baselineDelta = requiredExport(
			mod,
			"buildPrimaryDeltaSet",
		)({
			lock: fixture.lock,
			expectedLockDigest: fixture.expectedLockDigest,
			manifest: fixture.manifest,
			verifiedArtifactsByRunInstanceId,
		});
		expect(
			requiredExport(
				mod,
				"buildPrimaryDeltaSet",
			)({
				lock: fixture.lock,
				expectedLockDigest: fixture.expectedLockDigest,
				manifest: fixture.manifest,
				verifiedArtifactsByRunInstanceId,
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				deltaCount: 35,
				rankingCount: 35,
				excludedOverlayCount: 12,
				excludedWarmupCount: 98,
				requiresRawHashEquality: false,
			}),
		);
		const extremeOverlayMetrics = Object.fromEntries(
			Object.entries(verifiedArtifactsByRunInstanceId).map(
				([runInstanceId, value]) => {
					const record = value as Record<string, unknown>;
					if (record.armKind !== "overlay") return [runInstanceId, record];
					return [
						runInstanceId,
						{
							...record,
							samples: [
								Number.MAX_SAFE_INTEGER,
								Number.MAX_SAFE_INTEGER,
								Number.MAX_SAFE_INTEGER,
							],
							percentiles: {
								p50: Number.MAX_SAFE_INTEGER,
								p95: Number.MAX_SAFE_INTEGER,
								p99: Number.MAX_SAFE_INTEGER,
							},
							ledger: {
								attempted: Number.MAX_SAFE_INTEGER,
								delivered: 0,
								dropped: Number.MAX_SAFE_INTEGER,
							},
							telemetry: {
								mac: {
									cpuPercent: Number.MAX_SAFE_INTEGER,
									rssBytes: Number.MAX_SAFE_INTEGER,
								},
								linux: {
									cpuPercent: Number.MAX_SAFE_INTEGER,
									rssBytes: Number.MAX_SAFE_INTEGER,
								},
							},
						},
					];
				},
			),
		);
		const extremeOverlayDelta = requiredExport(
			mod,
			"buildPrimaryDeltaSet",
		)({
			lock: fixture.lock,
			expectedLockDigest: fixture.expectedLockDigest,
			manifest: fixture.manifest,
			verifiedArtifactsByRunInstanceId: extremeOverlayMetrics,
		});
		// Overlay observations are diagnostic-only and must never perturb a
		// primary WS-vs-WT delta, ranking, or numeric evidence status.
		expect(extremeOverlayDelta).toEqual(baselineDelta);
		expect(
			Object.values(verifiedArtifactsByRunInstanceId).filter(
				(value) =>
					(value as Record<string, unknown>).scenarioVerdict === "NO_VERDICT",
			),
		).toHaveLength(98);
		expect(
			Object.values(verifiedArtifactsByRunInstanceId).filter(
				(value) => (value as Record<string, unknown>).armKind === "overlay",
			),
		).toHaveLength(12);
		for (const [artifactOverrides, code] of [
			[
				Object.fromEntries([
					...Object.entries(verifiedArtifactsByRunInstanceId).slice(1),
				]),
				"DELTA_WT_OR_WS_ARTIFACT_MISSING",
			],
			[
				{
					...verifiedArtifactsByRunInstanceId,
					[measuredPrimaryRuns.find((entry) => entry.transport === "wt")!
						.runInstanceId]: measuredArtifactRecordFor(
						measuredPrimaryRuns.find((entry) => entry.transport === "wt")!,
						{
							evidenceStatus: "BLOCKED",
							scenarioVerdict: "NO_VERDICT",
							promotable: false,
						},
					),
				},
				"DELTA_EVIDENCE_NOT_COMPARABLE",
			],
			[
				{
					...verifiedArtifactsByRunInstanceId,
					[measuredPrimaryRuns.find((entry) => entry.transport === "wt")!
						.runInstanceId]: measuredArtifactRecordFor(
						measuredPrimaryRuns.find((entry) => entry.transport === "wt")!,
						{
							evidenceStatus: "FAIL",
							scenarioVerdict: "NO_VERDICT",
							promotable: false,
						},
					),
				},
				"DELTA_EVIDENCE_NOT_COMPARABLE",
			],
			[
				{
					...verifiedArtifactsByRunInstanceId,
					[measuredPrimaryRuns.find((entry) => entry.transport === "wt")!
						.runInstanceId]: measuredArtifactRecordFor(
						measuredPrimaryRuns.find((entry) => entry.transport === "wt")!,
						{
							sharedIdentity: {
								...measuredPrimaryRuns[0]!.sharedIdentity,
								lockDigestSha256: "9".repeat(64),
							},
							promotable: false,
						},
					),
				},
				"DELTA_SHARED_IDENTITY_MISMATCH",
			],
			[
				Object.fromEntries(
					Object.entries(verifiedArtifactsByRunInstanceId).filter(
						([runInstanceId]) =>
							runInstanceId !==
							measuredPrimaryRuns.find((entry) => entry.transport === "wt")!
								.runInstanceId,
					),
				),
				"DELTA_WT_OR_WS_ARTIFACT_MISSING",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"buildPrimaryDeltaSet",
				)({
					lock: fixture.lock,
					expectedLockDigest: fixture.expectedLockDigest,
					manifest: fixture.manifest,
					verifiedArtifactsByRunInstanceId: artifactOverrides,
				}),
			).toEqual(
				expect.objectContaining({
					ok: false,
					code,
					deltaCount: 0,
					rankingCount: 0,
					numericDelta: "not-computed",
				}),
			);
		}
	});

	test("manifest descriptor publication is exactly 3,599 ordered payloads with 588 runs, 2,940 raw descriptors, 70 snapshots, and no reserved-output self-selection", async () => {
		const fixture = representativeFixture();
		const mod = await importExpectedModule("./manifest-lock.ts");
		const descriptors = [
			...fixture.manifest.runEntries.flatMap((entry) => [
				{
					kind: "artifact",
					relativePath: entry.artifact.relativePath,
					sha256: entry.artifact.sha256,
				},
				...entry.rawDescriptors.map((raw) => ({
					kind: `raw-${raw.kind}`,
					relativePath: raw.relativePath,
					sha256: raw.sha256,
				})),
			]),
			...fixture.manifest.cellSnapshotBundles.flatMap((bundle) => [
				{
					kind: "snapshot-pre",
					relativePath: bundle.preCell.relativePath,
					sha256: bundle.preCell.sha256,
				},
				{
					kind: "snapshot-post",
					relativePath: bundle.postCell.relativePath,
					sha256: bundle.postCell.sha256,
				},
			]),
			{
				kind: "attestation",
				relativePath: "official/observed-attestation.json",
				sha256: sha256Hex(canonicalBytes(fixture.observedAttestation)),
			},
		];
		expect(descriptors).toHaveLength(R1_MANIFEST_DESCRIPTOR_EXPECTED_COUNT);
		expect(
			descriptors.slice(0, 6).map((descriptor) => descriptor.kind),
		).toEqual([
			"artifact",
			"raw-client",
			"raw-server",
			"raw-topology",
			"raw-impairment",
			"raw-cleanup",
		]);
		expect(descriptors.at(-1)?.kind).toBe("attestation");
		expect(
			fixture.manifest.runEntries.every(
				(entry) =>
					sha256Hex(
						fixture.artifactBytesByPath[entry.artifact.relativePath]!,
					) === entry.artifact.sha256 &&
					entry.rawDescriptors.every(
						(raw) =>
							sha256Hex(fixture.rawBytesByPath[raw.relativePath]!) ===
							raw.sha256,
					),
			),
		).toBe(true);
		expect(
			fixture.cellSnapshotBundles.every(
				(bundle) =>
					sha256Hex(
						fixture.snapshotBytesByPath[bundle.preCell.relativePath]!,
					) === bundle.preCell.sha256 &&
					sha256Hex(
						fixture.snapshotBytesByPath[bundle.postCell.relativePath]!,
					) === bundle.postCell.sha256,
			),
		).toBe(true);
		expect(fixture.runEntries).toHaveLength(588);
		expect(
			fixture.runEntries.flatMap((entry) => entry.rawDescriptors),
		).toHaveLength(2940);
		expect(
			fixture.cellSnapshotBundles.flatMap((bundle) => [
				bundle.preCell,
				bundle.postCell,
			]),
		).toHaveLength(70);
		expect(
			requiredExport(
				mod,
				"validateManifestDescriptorSet",
			)({
				manifest: fixture.manifest,
				descriptors,
				expectedDescriptorCount: R1_MANIFEST_DESCRIPTOR_EXPECTED_COUNT,
				expectedDescriptorOrder: R1_MANIFEST_DESCRIPTOR_ORDER,
				reservedOutputs: [
					"manifest.json",
					"verifier-result.json",
					"report.md",
					"report.json",
				],
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				descriptorCount: 3599,
				rawDescriptorCount: 2940,
				snapshotDescriptorCount: 70,
			}),
		);
		for (const [mutation, code] of [
			[
				{ descriptors: descriptors.slice(0, -1) },
				"MANIFEST_DESCRIPTOR_COUNT_INVALID",
			],
			[
				{
					descriptors: descriptors.map((descriptor, index) =>
						index === 0 ? { ...descriptor, kind: "raw-client" } : descriptor,
					),
				},
				"MANIFEST_DESCRIPTOR_ORDER_INVALID",
			],
			[
				{
					descriptors: descriptors.map((descriptor, index) =>
						index === 3
							? { ...descriptor, relativePath: "manifest.json" }
							: descriptor,
					),
				},
				"MANIFEST_RESERVED_OUTPUT_SELECTED",
			],
			[
				{
					descriptors: descriptors.map((descriptor, index) =>
						index === 3
							? { ...descriptor, relativePath: "../escape.json" }
							: descriptor,
					),
				},
				"MANIFEST_PATH_COMPONENT_INVALID",
			],
			[
				{
					descriptors: descriptors.map((descriptor, index) =>
						index === 3
							? { ...descriptor, sha256: "0".repeat(64) }
							: descriptor,
					),
				},
				"MANIFEST_DESCRIPTOR_DIGEST_MISMATCH",
			],
			[
				{
					manifest: {
						...fixture.manifest,
						runEntries: fixture.manifest.runEntries.filter(
							(entry) => entry.armKind === "primary",
						),
					},
				},
				"MANIFEST_OVERLAY_OR_WARMUP_CARDINALITY_INVALID",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"validateManifestDescriptorSet",
				)({
					manifest:
						"manifest" in mutation ? mutation.manifest : fixture.manifest,
					descriptors:
						"descriptors" in mutation ? mutation.descriptors : descriptors,
					expectedDescriptorCount: R1_MANIFEST_DESCRIPTOR_EXPECTED_COUNT,
					expectedDescriptorOrder: R1_MANIFEST_DESCRIPTOR_ORDER,
					reservedOutputs: [
						"manifest.json",
						"verifier-result.json",
						"report.md",
						"report.json",
					],
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});

	test("manifest observed facts remain supervisor-owned and bind PGID, pre/post snapshots, overlay exclusion, warmup exclusion, and every incompatibility axis", async () => {
		const fixture = representativeFixture();
		const mod = await importExpectedModule("./manifest-lock.ts");
		const measured = fixture.manifest.runEntries.filter(
			(entry) => entry.phase === "measured" && entry.armKind === "primary",
		);
		const observedFacts = fixture.observedAttestationModel;
		const observedRunFacts = observedFacts.observedRunFacts as unknown as Array<
			Record<string, unknown>
		>;
		expect(
			requiredExport(
				mod,
				"validateManifestObservedFacts",
			)({
				manifest: fixture.manifest,
				observedAttestation: observedFacts,
				measuredPrimaryCount: measured.length,
			}),
		).toEqual(
			expect.objectContaining({
				ok: true,
				measuredPrimaryCount: 35,
				warmupExcluded: 98,
				overlaysExcluded: 12,
			}),
		);
		for (const [mutation, code] of [
			[
				{ observedAttestation: { ...observedFacts, observedRunFacts: [] } },
				"ATTESTATION_OBSERVED_RUN_FACTS_MISSING",
			],
			[
				{
					observedAttestation: {
						...observedFacts,
						observedRunFacts: observedRunFacts.map((fact, index) =>
							index === 0
								? { ...fact, dedicatedPgidObserved: undefined }
								: fact,
						),
					},
				},
				"ATTESTATION_SUPERVISOR_FACTS_MISMATCH",
			],
			[
				{
					observedAttestation: { ...observedFacts, observedCellSnapshots: [] },
				},
				"ATTESTATION_CELL_SNAPSHOT_MISMATCH",
			],
			[
				{
					observedAttestation: {
						...observedFacts,
						observedRunFacts: observedRunFacts.map((fact, index) =>
							index === 0 ? { ...fact, routePath: "tailscale" } : fact,
						),
					},
				},
				"ATTESTATION_ROUTE_OR_PEER_MISMATCH",
			],
			[
				{
					manifest: {
						...fixture.manifest,
						runEntries: fixture.manifest.runEntries.map((entry, index) =>
							index === 0 ? { ...entry, excludeFromDelta: false } : entry,
						),
					},
				},
				"MANIFEST_WARMUP_OR_OVERLAY_INCLUDED",
			],
		] as const) {
			expect(
				requiredExport(
					mod,
					"validateManifestObservedFacts",
				)({
					manifest:
						"manifest" in mutation ? mutation.manifest : fixture.manifest,
					observedAttestation:
						"observedAttestation" in mutation
							? mutation.observedAttestation
							: observedFacts,
					measuredPrimaryCount: measured.length,
				}),
			).toEqual(expect.objectContaining({ ok: false, code }));
		}
	});
});
