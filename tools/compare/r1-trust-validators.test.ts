// Task C GREEN regression coverage for the trust validators.
//
// This target is deliberately outside the frozen RED approval bundle: it
// pins the security fixes those modules received, not the contract itself.
import { describe, expect, test } from "bun:test";
import { validateCampaignLockAttestations } from "./campaign-lock.ts";
import { canonicalJson } from "./canonical.ts";
import {
	findDuplicateJsonKey,
	isSafeCount,
	isSafeNonNegative,
	parseStrictJsonBytes,
	validateCampaignAuthorityV1,
	validateStagedCapabilityV1,
} from "./secure-fs.ts";
import { loadStagedTrustCapability } from "./staged-capability.ts";
import {
	decodeSupervisorFrame,
	encodeSupervisorFrame,
	MAX_SESSION_FRAMES,
	MEASUREMENT_GRANT_SCHEMA,
	type MeasurementGrantV1,
	measurementGrantBytes,
	SupervisorSessionFrameBudget,
} from "./supervisor-client.ts";
import {
	measurementPayloadBytes,
	observedCapabilitySetBytes,
	observedCapabilitySetSha256,
	observedToolchainSetBytes,
	observedToolchainSetSha256,
	observationProvenanceIssue,
	validateMeasurementAdmission,
	validateObservedCapabilityFacts,
	validateObservedCapabilitySetV1,
	validateObservedToolchainFacts,
	validateObservedToolchainSetV1,
	validateObservedPathFacts,
	validateSupervisorPhysicalReceipts,
} from "./supervisor-protocol.ts";

const encoder = new TextEncoder();

function bytesOf(text: string): Uint8Array {
	return encoder.encode(text);
}

describe("duplicate-key lexing decodes escapes", () => {
	// A lexer that copies `\uXXXX` through instead of decoding it sees
	// `candidate` and `candidate` as two distinct keys and reports no
	// duplicate, while JSON.parse folds them into one key holding the LAST
	// value. Every binding field becomes smuggleable behind a benign first
	// value that a byte audit would read.
	test("the exact escaped-duplicate attack string is caught", () => {
		const attack = '{"candidate":"benign","\\u0063andidate":"evil"}';
		expect(JSON.parse(attack).candidate).toBe("evil");
		expect(Object.keys(JSON.parse(attack))).toHaveLength(1);
		expect(findDuplicateJsonKey(attack)).toBe("candidate");
	});

	test("every binding field is covered, not just the first", () => {
		for (const field of [
			"candidate",
			"authoritySha256",
			"lockSha256",
			"fixtureOnly",
		]) {
			const escaped = `\\u${field.charCodeAt(0).toString(16).padStart(4, "0")}`;
			const attack = `{"${field}":"benign","${escaped}${field.slice(1)}":"evil"}`;
			expect(findDuplicateJsonKey(attack)).toBe(field);
		}
	});

	test("short escapes alias too", () => {
		expect(findDuplicateJsonKey('{"a\\/b":1,"a/b":2}')).toBe("a/b");
		expect(findDuplicateJsonKey('{"a\\nb":1,"a\\u000ab":2}')).toBe("a\nb");
	});

	test("surrogate pairs decode to one scalar", () => {
		// The same astral key spelled as a pair and as a literal is one key.
		expect(findDuplicateJsonKey('{"\\ud83d\\ude00":1,"\uD83D\uDE00":2}')).toBe(
			"\u{1F600}",
		);
		// Distinct astral keys stay distinct.
		expect(
			findDuplicateJsonKey('{"\\ud83d\\ude00":1,"\\ud83d\\ude01":2}'),
		).toBe(null);
	});

	test("honest canonical records report no duplicate", () => {
		const record = canonicalJson({ a: 1, b: { c: [1, 2] }, d: "x\ny" });
		expect(findDuplicateJsonKey(record)).toBe(null);
		expect(parseStrictJsonBytes(bytesOf(`${record}\n`)).ok).toBe(true);
	});

	test("an escaped duplicate reaches the strict parser as a duplicate", () => {
		const parsed = parseStrictJsonBytes(
			bytesOf('{"candidate":"benign","\\u0063andidate":"evil"}\n'),
		);
		expect(parsed).toEqual({
			ok: false,
			reason: "duplicate",
			key: "candidate",
		});
	});
});

describe("numeric guards", () => {
	test("Infinity and NaN are not counts", () => {
		// 1e999 parses to Infinity, which compares greater than every bound.
		expect(JSON.parse("1e999")).toBe(Number.POSITIVE_INFINITY);
		for (const hostile of [
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			Number.NaN,
			1.5,
			Number.MAX_SAFE_INTEGER + 2,
		]) {
			expect(isSafeCount(hostile)).toBe(false);
			expect(isSafeNonNegative(hostile)).toBe(false);
		}
		expect(isSafeCount(588)).toBe(true);
		expect(isSafeNonNegative(-1)).toBe(false);
	});

	test("an Infinity notAfterMs never yields an immortal capability", () => {
		const capability = {
			schemaVersion: "v1",
			candidateId: "candidate",
			campaignId: "campaign-direct-cable-2026-08-24",
			locator: "official/staging/capabilities/campaign-r1.cap",
			stagingId: "staging-2026-08-24-r1",
			stagingRootIdentity:
				"official/staging/root/campaign-direct-cable-2026-08-24",
			lockDigestSha256: "0123456789abcdef".repeat(4),
			archiveSha256: "fedcba9876543210".repeat(4),
			stagedArchiveSha256: "0f1e2d3c4b5a6978".repeat(4),
			issuedAtMs: 0,
			notAfterMs: 0,
			fixtureOnly: false,
			hostSubmissions: [],
		};
		// JSON.stringify would write Infinity as null, so the hostile literal
		// goes into the bytes directly: `1e999` parses to Infinity.
		const text = JSON.stringify(capability).replace(
			'"notAfterMs":0',
			'"notAfterMs":1e999',
		);
		const bytes = bytesOf(text);
		const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
		const result = loadStagedTrustCapability({
			locator: capability.locator,
			readBytes: () => bytes,
			expectedCapabilityDigest: digest,
			expectedCandidateId: capability.candidateId,
			expectedCampaignId: capability.campaignId,
			expectedLockDigest: capability.lockDigestSha256,
			expectedArchiveDigest: capability.archiveSha256,
			nowMs: 1,
		});
		expect(result).toEqual({ ok: false, code: "TRUST_CAPABILITY_MALFORMED" });
	});
});

describe("absent digests are rejections, not skipped checks", () => {
	test("the authority requires an expected digest", () => {
		const authority = { schema: "campaign-authority/v1" };
		const bytes = bytesOf(`${canonicalJson(authority)}\n`);
		// No expectedAuthorityDigest at all.
		expect(
			validateCampaignAuthorityV1({ authority, authorityBytes: bytes }),
		).toEqual(expect.objectContaining({ ok: false }));
	});

	test("a capability with a digest mismatch is refused", () => {
		expect(
			validateStagedCapabilityV1({
				capability: { schema: "staged-capability/v1" },
				capabilityBytes: bytesOf('{"schema":"staged-capability/v1"}\n'),
				expectedCapabilityDigest: "f".repeat(64),
			}),
		).toEqual({ ok: false, code: "TRUST_CAPABILITY_DIGEST_MISMATCH" });
	});

	test("a capability with duplicate keys in its bytes is refused", () => {
		expect(
			validateStagedCapabilityV1({
				capability: { schema: "staged-capability/v1" },
				capabilityBytes: bytesOf(
					'{"schema":"staged-capability/v1","\\u0073chema":"other"}\n',
				),
			}),
		).toEqual({ ok: false, code: "TRUST_CAPABILITY_DUPLICATE_FIELD" });
	});
});

describe("observation provenance is structural", () => {
	const planned = {
		macInterface: "en10",
		macAddress: "10.9.0.1",
		linuxInterface: "enp1s0",
		linuxAddress: "10.9.0.2",
		mtu: 1500,
	};

	test("echo-of-plan and child-reported can never validate", () => {
		for (const provenance of ["echo-of-plan", "child-reported"] as const) {
			expect(
				validateObservedPathFacts(planned, { ...planned, provenance }),
			).toEqual({ ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" });
		}
	});

	test("an undeclared provenance is indistinguishable from an echo", () => {
		expect(observationProvenanceIssue({ ...planned })).toBe(
			"TRUST_OBSERVATION_PROVENANCE_MISSING",
		);
	});

	test("omission is a typed failure, never a skipped check", () => {
		expect(
			validateObservedPathFacts(planned, {
				provenance: "supervisor-measured",
				macInterface: planned.macInterface,
			}),
		).toEqual({ ok: false, code: "TRUST_OBSERVATION_OMITTED" });
	});

	test("a supervisor measurement that matches and cleans up passes", () => {
		expect(
			validateObservedPathFacts(planned, {
				...planned,
				provenance: "supervisor-measured",
				qdiscRestored: true,
				cleanupReleased: true,
			}),
		).toEqual({ ok: true });
	});

	test("drift is caught after omission", () => {
		expect(
			validateObservedPathFacts(planned, {
				...planned,
				provenance: "supervisor-measured",
				mtu: 9000,
				qdiscRestored: true,
				cleanupReleased: true,
			}),
		).toEqual({ ok: false, code: "TRUST_OBSERVATION_DRIFT" });
	});

	test("a physical observation declaring a non-supervisor source is refused", () => {
		expect(
			validateSupervisorPhysicalReceipts({
				observation: { provenance: "child-reported" },
			}),
		).toEqual({ ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" });
	});

	test("a structuredClone of the plan is no longer a distinct observation", () => {
		// Reference identity alone is defeated by a clone; canonical equality
		// on the blocks whose honest shape differs from the plan is not.
		const lock = {
			candidateId: "candidate",
			campaignId: "campaign",
			source: { reviewedTreeState: "clean", archiveSha256: "a".repeat(64) },
			submissions: { registrySha256: "b".repeat(64) },
			topology: {},
			executionPlan: {},
		};
		const result = validateCampaignLockAttestations({
			lock,
			observedAttestation: {
				candidateId: lock.candidateId,
				campaignId: lock.campaignId,
				source: structuredClone(lock.source),
				submissions: structuredClone(lock.submissions),
				executionPlan: {},
			},
		});
		expect(result).toEqual({
			ok: false,
			code: "ATTESTATION_PLANNED_VALUE_ALIAS_FORBIDDEN",
		});
	});
});

describe("toolchain observation is structural", () => {
	const macDigest = "1".repeat(64);
	const linuxDigest = "2".repeat(64);
	const bunVersion = "1.3.14";
	const bunRevision = "abc1234";

	const complete = {
		provenance: "supervisor-measured" as const,
		mac: {
			platform: "darwin-arm64",
			bunVersion,
			bunRevision,
			bunExecutableSha256: macDigest,
		},
		linux: {
			platform: "linux-x86_64",
			bunVersion,
			bunRevision,
			bunExecutableSha256: linuxDigest,
		},
	};

	test("echo-of-plan and child-reported can never validate a toolchain observation", () => {
		for (const provenance of ["echo-of-plan", "child-reported"] as const) {
			expect(
				validateObservedToolchainFacts({ ...complete, provenance }),
			).toEqual({ ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" });
		}
	});

	test("a missing per-host side is a typed failure, not a skipped check", () => {
		const macOnly = {
			provenance: "supervisor-measured" as const,
			mac: complete.mac,
		};
		const linuxOnly = {
			provenance: "supervisor-measured" as const,
			linux: complete.linux,
		};
		for (const observed of [macOnly, linuxOnly]) {
			expect(validateObservedToolchainFacts(observed)).toEqual({
				ok: false,
				code: "TRUST_OBSERVATION_OMITTED",
			});
		}
	});

	test("a per-host fact that was not observed is a typed failure", () => {
		const macMissingVersion = {
			...complete,
			mac: { ...complete.mac, bunVersion: undefined },
		};
		expect(validateObservedToolchainFacts(macMissingVersion)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_OMITTED",
		});
	});

	test("a non-hex executable digest is drift, not a slip past the type system", () => {
		const badMacDigest = {
			...complete,
			mac: { ...complete.mac, bunExecutableSha256: "not-a-digest" },
		};
		expect(validateObservedToolchainFacts(badMacDigest)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("the two hosts must name the two real platforms", () => {
		const swapped = {
			...complete,
			mac: { ...complete.mac, platform: "linux-x86_64" },
		};
		expect(validateObservedToolchainFacts(swapped)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("the two hosts must name different platforms", () => {
		const samePlatform = {
			...complete,
			linux: { ...complete.linux, platform: "darwin-arm64" },
		};
		expect(validateObservedToolchainFacts(samePlatform)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("a supervisor measurement with both hosts and real digests validates", () => {
		expect(validateObservedToolchainFacts(complete)).toEqual({
			ok: true,
			hostCount: 2,
		});
	});

	test("a child may not smuggle a toolchain into a child observation", async () => {
		// The child observation boundary refuses any of the names a child
		// could use to declare its own toolchain -- the umbrella name
		// `toolchain` AND each of the per-field names (`bunVersion`,
		// `bunRevision`, `bunExecutableSha256`) are on the forbidden
		// list, so a child cannot smuggle a toolchain in either as a
		// `toolchain` object or by naming the per-host fields directly.
		const mod = await import("./supervisor-protocol.ts");
		const validateChildObservationBoundary = (
			mod as unknown as {
				validateChildObservationBoundary: (input: unknown) => unknown;
			}
		).validateChildObservationBoundary;
		for (const observation of [
			{ toolchain: { bunVersion } },
			{ bunVersion },
			{ bunRevision: "child-rev" },
			{ bunExecutableSha256: "f".repeat(64) },
		]) {
			expect(
				validateChildObservationBoundary({
					childObservation: observation,
					allowedKinds: ["artifact-payload"],
				}),
			).toEqual({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			});
		}
	});
});

describe("capability observation is supervisor-measured or it does not validate", () => {
	const macDigest = "a".repeat(64);
	const linuxDigest = "b".repeat(64);
	const complete = {
		provenance: "supervisor-measured" as const,
		mac: {
			platform: "darwin-arm64",
			capabilityVersion: "staged-capability/v1",
			capabilityDigestSha256: macDigest,
			capabilities: ["host-submission-mac"],
		},
		linux: {
			platform: "linux-x86_64",
			capabilityVersion: "staged-capability/v1",
			capabilityDigestSha256: linuxDigest,
			capabilities: ["host-submission-linux"],
		},
	};

	test("echo-of-plan and child-reported can never validate a capability observation", () => {
		for (const provenance of ["echo-of-plan", "child-reported"] as const) {
			expect(
				validateObservedCapabilityFacts({ ...complete, provenance }),
			).toEqual({ ok: false, code: "TRUST_CHILD_OBSERVATION_FORBIDDEN" });
		}
	});

	test("a missing per-host side is a typed failure, not a skipped check", () => {
		const macOnly = {
			provenance: "supervisor-measured" as const,
			mac: complete.mac,
		};
		const linuxOnly = {
			provenance: "supervisor-measured" as const,
			linux: complete.linux,
		};
		for (const observed of [macOnly, linuxOnly]) {
			expect(validateObservedCapabilityFacts(observed)).toEqual({
				ok: false,
				code: "TRUST_OBSERVATION_OMITTED",
			});
		}
	});

	test("a per-host fact that was not observed is a typed failure", () => {
		const macMissingVersion = {
			...complete,
			mac: { ...complete.mac, capabilityVersion: undefined },
		};
		expect(validateObservedCapabilityFacts(macMissingVersion)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_OMITTED",
		});
	});

	test("a non-hex capability digest is drift, not a slip past the type system", () => {
		const badMacDigest = {
			...complete,
			mac: { ...complete.mac, capabilityDigestSha256: "not-a-digest" },
		};
		expect(validateObservedCapabilityFacts(badMacDigest)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("a non-array capabilities field is omission, not drift", () => {
		// Cast through `unknown as ObservedCapabilityFacts` so the test
		// inputs a non-array value at runtime even though the type
		// signature would refuse it; this is the test for the
		// runtime refusal, which the type system cannot see.
		const badMacCapabilities = {
			...complete,
			mac: { ...complete.mac, capabilities: "host-submission-mac" },
		};
		expect(
			validateObservedCapabilityFacts(
				badMacCapabilities as unknown as Parameters<
					typeof validateObservedCapabilityFacts
				>[0],
			),
		).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_OMITTED",
		});
	});

	test("the two hosts must name the two real platforms", () => {
		const swapped = {
			...complete,
			mac: { ...complete.mac, platform: "linux-x86_64" },
		};
		expect(validateObservedCapabilityFacts(swapped)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("the two hosts must name different platforms", () => {
		const samePlatform = {
			...complete,
			linux: { ...complete.linux, platform: "darwin-arm64" },
		};
		expect(validateObservedCapabilityFacts(samePlatform)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("a supervisor measurement with both hosts and real digests validates", () => {
		expect(validateObservedCapabilityFacts(complete)).toEqual({
			ok: true,
			hostCount: 2,
		});
	});

	test("a child may not smuggle a capability into a child observation", async () => {
		// The child observation boundary refuses any of the names a child
		// could use to declare its own capability -- the umbrella name
		// `capability` AND each of the per-field names (`capabilityVersion`,
		// `capabilities`) are on the forbidden list, so a child cannot
		// smuggle a capability in either as a `capability` object or by
		// naming the per-host fields directly.
		const mod = await import("./supervisor-protocol.ts");
		const validateChildObservationBoundary = (
			mod as unknown as {
				validateChildObservationBoundary: (input: unknown) => unknown;
			}
		).validateChildObservationBoundary;
		for (const observation of [
			{ capability: { capabilityVersion: "staged-capability/v1" } },
			{ capabilityVersion: "staged-capability/v1" },
			{ capabilities: ["host-submission-mac"] },
			{ capabilityDigestSha256: "f".repeat(64) },
		]) {
			expect(
				validateChildObservationBoundary({
					childObservation: observation,
					allowedKinds: ["artifact-payload"],
				}),
			).toEqual({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			});
		}
	});
});

describe("capability set is a typed record, not an echo of the per-host observation", () => {
	const completeSet = {
		schema: "observed-capability-set/v1" as const,
		mac: {
			platform: "darwin-arm64",
			capabilityVersion: "staged-capability/v1",
			capabilityDigestSha256: "a".repeat(64),
			capabilities: ["host-submission-mac"],
		},
		linux: {
			platform: "linux-x86_64",
			capabilityVersion: "staged-capability/v1",
			capabilityDigestSha256: "b".repeat(64),
			capabilities: ["host-submission-linux"],
		},
		observedAt: "2026-08-24T12:00:00.000Z",
	};

	test("a complete set with the right schema validates", () => {
		expect(validateObservedCapabilitySetV1(completeSet)).toEqual({
			ok: true,
			hostCount: 2,
		});
	});

	test("a wrong schema tag is refused structurally", () => {
		const wrongSchema = { ...completeSet, schema: "host-runtime-facts-set/v1" };
		expect(validateObservedCapabilitySetV1(wrongSchema)).toEqual({
			ok: false,
			code: "TRUST_CAPABILITY_SET_INVALID",
		});
	});

	test("a missing observedAt is a typed failure", () => {
		const { observedAt: _drop, ...withoutObservedAt } = completeSet;
		expect(validateObservedCapabilitySetV1(withoutObservedAt)).toEqual({
			ok: false,
			code: "TRUST_CAPABILITY_SET_INVALID",
		});
	});

	test("a per-host omission in the set fails the same way it would alone", () => {
		const macMissing = {
			...completeSet,
			mac: { ...completeSet.mac, capabilityVersion: undefined },
		};
		expect(validateObservedCapabilitySetV1(macMissing)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_OMITTED",
		});
	});

	test("a non-64-char capability digest on either host is drift, not a slip past the type system", () => {
		const badDigest = {
			...completeSet,
			linux: { ...completeSet.linux, capabilityDigestSha256: "not-a-digest" },
		};
		expect(validateObservedCapabilitySetV1(badDigest)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("the two hosts must name the two real platforms, in the right slots", () => {
		const swapped = {
			...completeSet,
			mac: { ...completeSet.mac, platform: "linux-x86_64" },
		};
		expect(validateObservedCapabilitySetV1(swapped)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("a capability digest match across hosts is left to the comparator, not enforced here", () => {
		// The set validator is the structural layer; the comparator is
		// where "WS and WT must publish the same capability" is enforced.
		// Coupling the two supervisors' read of their own host to enforce
		// the match here would defeat the per-host observation's
		// per-host independence.
		const mismatch = {
			...completeSet,
			linux: { ...completeSet.linux, capabilityDigestSha256: "f".repeat(64) },
		};
		expect(validateObservedCapabilitySetV1(mismatch)).toEqual({
			ok: true,
			hostCount: 2,
		});
	});

	test("the canonical-bytes and sha256 helpers are stable across reordering and stable across calls", () => {
		const different = {
			...completeSet,
			mac: { ...completeSet.mac, capabilityDigestSha256: "f".repeat(64) },
		};
		const bytesA = observedCapabilitySetBytes(completeSet);
		const bytesB = observedCapabilitySetBytes(completeSet);
		expect(bytesA).toEqual(bytesB);
		expect(observedCapabilitySetSha256(completeSet)).toMatch(/^[0-9a-f]{64}$/);
		// Different content -> different sha256.
		expect(observedCapabilitySetSha256(completeSet)).not.toBe(
			observedCapabilitySetSha256(different),
		);
	});
});

describe("toolchain set is a typed record, not an echo of the per-host observation", () => {
	const completeSet = {
		schema: "observed-toolchain-set/v1" as const,
		mac: {
			platform: "darwin-arm64",
			bunVersion: "1.3.14",
			bunRevision: "abc1234",
			bunExecutableSha256: "1".repeat(64),
		},
		linux: {
			platform: "linux-x86_64",
			bunVersion: "1.3.14",
			bunRevision: "abc1234",
			bunExecutableSha256: "2".repeat(64),
		},
		observedAt: "2026-08-24T12:00:00.000Z",
	};

	test("a complete set with the right schema validates", () => {
		expect(validateObservedToolchainSetV1(completeSet)).toEqual({
			ok: true,
			hostCount: 2,
		});
	});

	test("a wrong schema tag is refused structurally", () => {
		const wrongSchema = { ...completeSet, schema: "host-runtime-facts-set/v1" };
		expect(validateObservedToolchainSetV1(wrongSchema)).toEqual({
			ok: false,
			code: "TRUST_TOOLCHAIN_SET_INVALID",
		});
	});

	test("a missing observedAt is a typed failure", () => {
		const { observedAt: _drop, ...withoutObservedAt } = completeSet;
		expect(validateObservedToolchainSetV1(withoutObservedAt)).toEqual({
			ok: false,
			code: "TRUST_TOOLCHAIN_SET_INVALID",
		});
	});

	test("a per-host omission in the set fails the same way it would alone", () => {
		const macMissing = {
			...completeSet,
			mac: { ...completeSet.mac, bunVersion: undefined },
		};
		expect(validateObservedToolchainSetV1(macMissing)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_OMITTED",
		});
	});

	test("a non-64-char executable digest on either host is drift, not a slip past the type system", () => {
		const badDigest = {
			...completeSet,
			linux: { ...completeSet.linux, bunExecutableSha256: "not-a-digest" },
		};
		expect(validateObservedToolchainSetV1(badDigest)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("the two hosts must name the two real platforms, in the right slots", () => {
		const swapped = {
			...completeSet,
			mac: { ...completeSet.mac, platform: "linux-x86_64" },
		};
		expect(validateObservedToolchainSetV1(swapped)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("a Bun version mismatch across hosts is left to the comparator, not enforced here", () => {
		// The set validator is the structural layer; the comparator is
		// where "WS and WT must publish the same js toolchain" is enforced
		// (compare.ts:319-326, TOOLCHAIN_DIGEST_MISMATCH). Coupling the
		// two supervisors' read of their own host to enforce the match
		// here would defeat the per-host observation's per-host
		// independence.
		const mismatch = {
			...completeSet,
			linux: { ...completeSet.linux, bunVersion: "9.9.9" },
		};
		expect(validateObservedToolchainSetV1(mismatch)).toEqual({
			ok: true,
			hostCount: 2,
		});
	});

	test("the canonical-bytes and sha256 helpers are stable across reordering and stable across calls", () => {
		const different = {
			...completeSet,
			mac: { ...completeSet.mac, bunExecutableSha256: "f".repeat(64) },
		};
		const bytesA = observedToolchainSetBytes(completeSet);
		const bytesB = observedToolchainSetBytes(completeSet);
		expect(bytesA).toEqual(bytesB);
		expect(observedToolchainSetSha256(completeSet)).toMatch(/^[0-9a-f]{64}$/);
		// Different content -> different sha256.
		expect(observedToolchainSetSha256(completeSet)).not.toBe(
			observedToolchainSetSha256(different),
		);
	});
});

describe("frame codec bounds", () => {
	test("the session frame budget is enforced, not merely declared", () => {
		const budget = new SupervisorSessionFrameBudget();
		for (let index = 0; index < MAX_SESSION_FRAMES; index += 1) {
			expect(budget.charge().ok).toBe(true);
		}
		expect(budget.used).toBe(MAX_SESSION_FRAMES);
		expect(budget.charge()).toEqual({ ok: false, code: "FRAME_SESSION_LIMIT" });
	});

	test("an unrepresentable payload bound is a typed code, not a throw", () => {
		const header = bytesOf('{"schema":"comparison-supervisor-frame/v1"}');
		for (const bound of [
			Number.POSITIVE_INFINITY,
			Number.NaN,
			1.5,
			-1,
		] as const) {
			expect(encodeSupervisorFrame(header, new Uint8Array(0), bound)).toEqual({
				ok: false,
				code: "FRAME_PAYLOAD_BOUND_INVALID",
			});
			expect(decodeSupervisorFrame(new Uint8Array(64), bound)).toEqual({
				ok: false,
				code: "FRAME_PAYLOAD_BOUND_INVALID",
			});
		}
	});

	test("a bounded frame still round-trips", () => {
		const header = bytesOf('{"schema":"comparison-supervisor-frame/v1"}');
		const payload = bytesOf("payload-bytes");
		const encoded = encodeSupervisorFrame(header, payload, 1024);
		expect(encoded.ok).toBe(true);
		if (!encoded.ok) return;
		const decoded = decodeSupervisorFrame(encoded.value, 1024);
		expect(decoded.ok).toBe(true);
		if (!decoded.ok) return;
		expect(decoded.value.frame.payload).toEqual(payload);
	});
});

describe("measurement admission: the controller's copy of the supervisor's rules", () => {
	// Phase 1 landed these comparisons and left them uncovered: their admit path
	// was exercised against two real adapter legs and their refusals only by a
	// throwaway harness. The binding copy is `secure_fs::measurement`; this is
	// the controller's, and an uncovered advisory validator is one nobody
	// notices going quiet.
	const grant: MeasurementGrantV1 = {
		schema: MEASUREMENT_GRANT_SCHEMA,
		campaignId: "r1-admission",
		candidate: "r1-admission-candidate",
		declaredMessageBytes: 1_024,
		declaredMessageCount: 4_096,
		executionIndex: 1,
		issuedAt: 1_700_000_000_000,
		nonceSha256: "a".repeat(64),
		notAfter: 1_700_000_900_000,
		runId: "run-admission",
		transport: "ws",
	};

	function seriesOf(input: {
		readonly firstAtMs: number;
		readonly latencyMs: number;
		readonly gapMs: number;
		readonly count: number;
	}) {
		const roundTrips = [];
		let sentAtMs = input.firstAtMs;
		let lastAtMs = input.firstAtMs;
		for (let sequence = 1; sequence <= input.count; sequence += 1) {
			const receivedAtMs = sentAtMs + input.latencyMs;
			roundTrips.push({
				sequence,
				sentAtMs,
				receivedAtMs,
				latencyMs: input.latencyMs,
			});
			lastAtMs = receivedAtMs;
			sentAtMs = receivedAtMs + input.gapMs;
		}
		return {
			samples: roundTrips.map((trip) => trip.latencyMs),
			roundTrips,
			ledger: { delivered: input.count },
			provenance: {
				sampleCount: input.count,
				firstSampleAtMs: input.firstAtMs,
				lastSampleAtMs: lastAtMs,
			},
		};
	}

	const bracket = { grantIssuedAtMs: 1_000, frameAcceptedAtMs: 2_000 };
	const honest = seriesOf({
		firstAtMs: 1_100,
		latencyMs: 0.5,
		gapMs: 0.2,
		count: 6,
	});

	test("admits a series its own readings corroborate", () => {
		expect(validateMeasurementAdmission(honest, bracket)).toEqual({
			ok: true,
			sampleCount: 6,
		});
		// A leg that ran and recorded nothing is a real outcome, scored as one
		// downstream, and there is no window to bracket.
		expect(
			validateMeasurementAdmission(
				{
					samples: [],
					roundTrips: [],
					ledger: { delivered: 0 },
					provenance: {
						sampleCount: 0,
						firstSampleAtMs: 0,
						lastSampleAtMs: 0,
					},
				},
				bracket,
			),
		).toEqual({ ok: true, sampleCount: 0 });
	});

	test("refuses a series the ledger beside it contradicts", () => {
		for (const divergent of [
			{ ...honest, ledger: { delivered: 1_800 } },
			{ ...honest, provenance: { ...honest.provenance, sampleCount: 5 } },
			{ ...honest, samples: honest.samples.map((value) => value / 8) },
			{
				...honest,
				roundTrips: honest.roundTrips.map((trip) => ({
					...trip,
					sequence: 1,
				})),
			},
		]) {
			expect(validateMeasurementAdmission(divergent, bracket)).toEqual({
				ok: false,
				code: "MEASUREMENT_SERIES_LEDGER_DIVERGES",
			});
		}
	});

	test("refuses a series the supervisor's own bracket does not contain", () => {
		// The forgery that defeated both in-process guards: a stepping clock,
		// a thousand samples, 28.6 ms apiece. Nothing about it is malformed.
		const stepping = seriesOf({
			firstAtMs: 1_100,
			latencyMs: 28.6,
			gapMs: 0,
			count: 1_000,
		});
		expect(validateMeasurementAdmission(stepping, bracket)).toEqual({
			ok: false,
			code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW",
		});
		// A window outside the bracket entirely.
		expect(
			validateMeasurementAdmission(
				seriesOf({ firstAtMs: 5_000, latencyMs: 0.5, gapMs: 0.2, count: 6 }),
				bracket,
			),
		).toEqual({ ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" });
		// An inverted or incoherent bracket admits nothing.
		expect(
			validateMeasurementAdmission(honest, {
				grantIssuedAtMs: 2_000,
				frameAcceptedAtMs: 1_000,
			}),
		).toEqual({ ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" });
		// A declared window wider than the trips that occupy it is a third
		// statement standing beside two that already disagree with it.
		expect(
			validateMeasurementAdmission(
				{
					...honest,
					provenance: { ...honest.provenance, firstSampleAtMs: 1_050 },
				},
				bracket,
			),
		).toEqual({ ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" });
	});

	test("refuses what is not a series at all", () => {
		for (const malformed of [
			null,
			{ samples: [1], roundTrips: [], ledger: {}, provenance: {} },
			{ ...honest, provenance: { ...honest.provenance, sampleCount: -1 } },
		]) {
			const result = validateMeasurementAdmission(malformed, bracket);
			expect(result.ok).toBe(false);
			expect((result as { readonly code: string }).code).toBe(
				"TRUST_RECORD_MALFORMED",
			);
		}
	});

	test("admits a rewritten latency only inside a band of microseconds", () => {
		// Epoch-scale stamps on purpose: the slack is scaled to the magnitude
		// of its operands, so a test on small numbers exercises the floor
		// instead of the constant. This is where the forgery channel lives --
		// real timestamps, rewritten latencies -- and its width is the gate.
		const firstAtMs = 1_787_859_507_833.223;
		const epochBracket = {
			grantIssuedAtMs: firstAtMs - 5,
			frameAcceptedAtMs: firstAtMs + 500,
		};
		const shaved = (shaveMs: number) => {
			const roundTrips = [];
			let sentAtMs = firstAtMs;
			let lastAtMs = firstAtMs;
			for (let sequence = 1; sequence <= 12; sequence += 1) {
				const receivedAtMs = sentAtMs + 0.5;
				roundTrips.push({
					sequence,
					sentAtMs,
					receivedAtMs,
					latencyMs: 0.5 - shaveMs,
				});
				lastAtMs = receivedAtMs;
				sentAtMs = receivedAtMs + 0.2;
			}
			return {
				samples: roundTrips.map((trip) => trip.latencyMs),
				roundTrips,
				ledger: { delivered: 12 },
				provenance: {
					sampleCount: 12,
					firstSampleAtMs: firstAtMs,
					lastSampleAtMs: lastAtMs,
				},
			};
		};
		expect(validateMeasurementAdmission(shaved(0), epochBracket)).toEqual({
			ok: true,
			sampleCount: 12,
		});
		// Ten microseconds either way, and the 0.4 ms shave the prover ran.
		// At the 4096-ulp constant this replaced, all three were admitted --
		// the band was 1.63 ms, wider than the latency being reported.
		for (const shaveMs of [0.01, -0.01, 0.4]) {
			expect(
				validateMeasurementAdmission(shaved(shaveMs), epochBracket),
			).toEqual({
				ok: false,
				code: "MEASUREMENT_SERIES_LEDGER_DIVERGES",
			});
		}
	});

	test("encodes a grant to the same bytes the Rust supervisor writes", () => {
		// The grant crosses a language boundary and comes back to be compared
		// against the record the supervisor issued, so the two encoders have to
		// agree byte for byte or every honest leg is refused. This string was
		// produced by `MeasurementGrant::canonical_bytes` in
		// `crates/native/src/secure_fs.rs` for exactly these fields; the escapes
		// in `candidate` are here because a quote or a backslash is where two
		// hand-written JSON encoders diverge first.
		expect(
			new TextDecoder().decode(
				measurementGrantBytes({
					schema: MEASUREMENT_GRANT_SCHEMA,
					campaignId: "camp-1",
					candidate: 'cand"esc\\x',
					declaredMessageBytes: 1_024,
					declaredMessageCount: 4_096,
					executionIndex: 7,
					issuedAt: 1_700_000_000_123,
					nonceSha256: "b".repeat(64),
					notAfter: 1_700_000_900_123,
					runId: "run-1",
					transport: "wt",
				}),
			),
		).toBe(
			`{"campaignId":"camp-1","candidate":"cand\\"esc\\\\x",` +
				`"declaredMessageBytes":1024,"declaredMessageCount":4096,` +
				`"executionIndex":7,"issuedAt":1700000000123,` +
				`"nonceSha256":"${"b".repeat(64)}","notAfter":1700000900123,` +
				`"runId":"run-1","schema":"measurement-grant/v1","transport":"wt"}\n`,
		);
	});

	test("assembles the frame payload in one place, grant included", () => {
		const bytes = measurementPayloadBytes(honest, grant);
		const text = new TextDecoder().decode(bytes);
		expect(text.endsWith("\n")).toBe(true);
		const decoded = JSON.parse(text) as Record<string, unknown>;
		// The grant rides inside the payload, which is what the frame digests
		// and what the supervisor strict-parses.
		expect(decoded.grant).toEqual(grant);
		expect(decoded.samples).toEqual(honest.samples);
		expect(decoded.roundTrips).toEqual(honest.roundTrips);
		// Same series, same bytes: the payload is not a rendering choice made by
		// whichever caller happened to hold the leg.
		expect(measurementPayloadBytes(honest, grant)).toEqual(bytes);
	});
});
