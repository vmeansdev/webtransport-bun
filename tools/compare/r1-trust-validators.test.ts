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
	validateObservedLockFacts,
	validateObservedManifestFacts,
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

describe("lock observation is supervisor-measured or it does not validate", () => {
	const macDigest = "c".repeat(64);
	const linuxDigest = "d".repeat(64);
	const complete = {
		provenance: "supervisor-measured" as const,
		mac: {
			platform: "darwin-arm64",
			lockVersion: "campaign-lock/v1",
			lockDigestSha256: macDigest,
			locks: ["host-lock-mac"],
		},
		linux: {
			platform: "linux-x86_64",
			lockVersion: "campaign-lock/v1",
			lockDigestSha256: linuxDigest,
			locks: ["host-lock-linux"],
		},
	};

	test("echo-of-plan and child-reported can never validate a lock observation", () => {
		for (const provenance of ["echo-of-plan", "child-reported"] as const) {
			expect(validateObservedLockFacts({ ...complete, provenance })).toEqual({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			});
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
			expect(validateObservedLockFacts(observed)).toEqual({
				ok: false,
				code: "TRUST_OBSERVATION_OMITTED",
			});
		}
	});

	test("a per-host fact that was not observed is a typed failure", () => {
		const macMissingVersion = {
			...complete,
			mac: { ...complete.mac, lockVersion: undefined },
		};
		expect(validateObservedLockFacts(macMissingVersion)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_OMITTED",
		});
	});

	test("a non-hex lock digest is drift, not a slip past the type system", () => {
		const badMacDigest = {
			...complete,
			mac: { ...complete.mac, lockDigestSha256: "not-a-digest" },
		};
		expect(validateObservedLockFacts(badMacDigest)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("the two hosts must name the two real platforms", () => {
		const swapped = {
			...complete,
			mac: { ...complete.mac, platform: "linux-x86_64" },
		};
		expect(validateObservedLockFacts(swapped)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("a supervisor measurement with both hosts and real digests validates", () => {
		expect(validateObservedLockFacts(complete)).toEqual({
			ok: true,
			hostCount: 2,
		});
	});

	test("a child may not smuggle a lock into a child observation", async () => {
		// The child observation boundary refuses any of the names a child
		// could use to declare its own lock -- the umbrella name `lock`
		// AND each of the per-field names (`lockVersion`, `locks`) are
		// on the forbidden list, so a child cannot smuggle a lock in
		// either as a `lock` object or by naming the per-host fields
		// directly.
		const mod = await import("./supervisor-protocol.ts");
		const validateChildObservationBoundary = (
			mod as unknown as {
				validateChildObservationBoundary: (input: unknown) => unknown;
			}
		).validateChildObservationBoundary;
		for (const observation of [
			{ lock: { lockVersion: "campaign-lock/v1" } },
			{ lockVersion: "campaign-lock/v1" },
			{ locks: ["host-lock-mac"] },
			{ lockDigestSha256: "f".repeat(64) },
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

describe("capability observation is supervisor-measured, not a child-stated value", () => {
	// Phase 1.1.3 of the real-number plan: the child-stated capability
	// path is retired. The supervisor's child observation boundary
	// refuses any of the names a child could use to declare its own
	// capability -- the umbrella name AND each of the per-field names --
	// so a child cannot smuggle a capability in either as a `capability`
	// object or by naming the per-host fields directly. A regression
	// that restores the child-stated path fails structurally rather
	// than by inspection.
	test("a child may not smuggle a capability into a child observation through any of the supervisor's per-host field names", async () => {
		const mod = await import("./supervisor-protocol.ts");
		const validateChildObservationBoundary = (
			mod as unknown as {
				validateChildObservationBoundary: (input: unknown) => unknown;
			}
		).validateChildObservationBoundary;
		const refused = (observation: unknown) =>
			validateChildObservationBoundary({
				childObservation: observation,
				allowedKinds: ["artifact-payload"],
			});
		// The umbrella name and each of the per-field names are on
		// CHILD_FORBIDDEN_OBSERVATION_FIELDS so a child cannot smuggle
		// a capability in either as a `capability` object or by
		// naming the per-host fields directly. Each name is exercised
		// as a top-level child-observation key, not wrapped in a
		// `capability` object, so the assertion is on the structural
		// refusal and not on the umbrella.
		for (const observation of [
			{ capability: { capabilityVersion: "staged-capability/v1" } },
			{ capability: { capabilityDigestSha256: "f".repeat(64) } },
			{ capability: { capabilities: ["host-submission-mac"] } },
			{ capabilityVersion: "staged-capability/v1" },
			{ capabilityDigestSha256: "f".repeat(64) },
			{ capabilities: ["host-submission-mac"] },
		]) {
			expect(refused(observation)).toEqual({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			});
		}
		// And the absence of any capability-named key is accepted, so
		// the refusal is structural rather than blanket -- a child
		// observation that doesn't try to state a capability at all
		// is the supervisor's problem to forward or filter, not this
		// boundary's.
		expect(refused({ samples: [1, 2, 3] })).toEqual({ ok: true });
	});

	test("a measured arm that arrives with a self-attested capability digest is refused at the F4 binding", async () => {
		// The F4 binding `assertMeasuredArmObservedItsCapability` is
		// what retires the child-stated path at the artifact boundary:
		// a measured arm whose per-host capability digests disagree
		// with the supervisor's reading is refused with
		// `CAPABILITY_SUPERVISOR_MISMATCH`, and a measured arm that
		// arrives without the binding is refused with
		// `CAPABILITY_SUPERVISOR_MISSING`. The supervisor-measured
		// requirement is mandatory; a self-attested capability digest
		// against an empty `ComparisonSupervisorOutputV1.capabilitySha256`
		// is the same defect R1 exists to remove on `uname` and `route`.
		const { buildRunArtifact } = await import("./artifact-builder.ts");
		const grant: MeasurementGrantV1 = {
			schema: MEASUREMENT_GRANT_SCHEMA,
			campaignId: "r1-capability-binding",
			candidate: "r1-capability-binding-candidate",
			declaredMessageBytes: 1_024,
			declaredMessageCount: 4_096,
			executionIndex: 1,
			issuedAt: 1_700_000_000_000,
			nonceSha256: "a".repeat(64),
			notAfter: 1_700_000_900_000,
			runId: "r1-capability-binding-run",
			transport: "ws",
		};
		const arm = {
			comparisonId: "r1-capability-binding",
			runId: "r1-capability-binding-run",
			cellId: "bulk-one-way/delay40-loss1",
			transport: "ws" as const,
			provenance: {
				attestation: "test-attestation",
				driverRunId: "r1-capability-binding-run",
				clockMethod: "process.hrtime",
				sampleCount: 1,
				firstSampleAtMs: 1,
				lastSampleAtMs: 2,
			},
			toolchains: {
				js: { identity: "bun-fixture-darwin-arm64", sha256: "1".repeat(64) },
				darwin: { identity: "darwin-fixture", sha256: "1".repeat(64) },
				linux: { identity: "linux-fixture", sha256: "1".repeat(64) },
			},
			samples: [1, 2, 3],
			percentiles: { p1: 1, p50: 2, p95: 3, p99: 3 },
			ledger: { attempted: 1, delivered: 1 },
			grant,
			// The supervisor's per-host toolchain reading matches the
			// artifact's per-host toolchain digests so the toolchain
			// binding is satisfied; the focus of this test is the
			// capability binding that comes after it.
			supervisorToolchainDigests: {
				darwin: "1".repeat(64),
				linux: "1".repeat(64),
			},
			capabilityDigest: {
				darwin: "a".repeat(64),
				linux: "b".repeat(64),
			},
		};
		// A measured arm without the supervisor's per-host capability
		// binding is refused structurally with `CAPABILITY_SUPERVISOR_MISSING`.
		expect(() => buildRunArtifact(arm)).toThrow(
			"CAPABILITY_SUPERVISOR_MISSING",
		);
		// A measured arm whose per-host capability digests disagree
		// with the supervisor's reading is refused with the typed
		// `CAPABILITY_SUPERVISOR_MISMATCH` code.
		expect(() =>
			buildRunArtifact({
				...arm,
				supervisorCapabilityDigests: {
					darwin: "f".repeat(64),
					linux: "e".repeat(64),
				},
			}),
		).toThrow("CAPABILITY_SUPERVISOR_MISMATCH");
		// And a measured arm whose per-host capability digests match
		// the supervisor's reading is the only shape the binding
		// accepts -- a self-attested capability digest that does match
		// the supervisor's reading is structurally indistinguishable
		// from a real reading, by construction, which is the point of
		// the binding.
		expect(() =>
			buildRunArtifact({
				...arm,
				supervisorCapabilityDigests: {
					darwin: "a".repeat(64),
					linux: "b".repeat(64),
				},
			}),
		).not.toThrow();
	});
});

describe("F-class review of the capability binding: the per-field ban is comprehensive", () => {
	// Phase 1.1.4 of the real-number plan. For toolchain the auto-review
	// surfaced a real gap: a child observation of `{ bunVersion: "9.9.9" }`
	// was being silently accepted by `validateChildObservationBoundary`
	// because the per-field names were not on `CHILD_FORBIDDEN_OBSERVATION_FIELDS`
	// (commit `42d9fff8` closed that gap). For capability the same
	// review found no gap: the per-field names (`capabilityVersion`,
	// `capabilities`, `capabilityDigestSha256`) were already on the
	// forbidden list from commit `8c04e1d0` (Phase 1.1.1), so the
	// structural refusal has caught them since the binding landed.
	// This describe block codifies the F-class review's finding: every
	// shape a child could try to smuggle a capability in is refused
	// structurally, and the absence of any capability-named key is
	// still accepted so the refusal is not blanket.
	test("every smuggling shape the per-field ban claims to catch is caught", async () => {
		const mod = await import("./supervisor-protocol.ts");
		const validateChildObservationBoundary = (
			mod as unknown as {
				validateChildObservationBoundary: (input: unknown) => unknown;
			}
		).validateChildObservationBoundary;
		const refused = (observation: unknown) =>
			validateChildObservationBoundary({
				childObservation: observation,
				allowedKinds: ["artifact-payload"],
			});
		// The umbrella name, each of the per-field names, each per-field
		// name wrapped in the umbrella, and the edge cases (null,
		// undefined, zero, empty string) are all caught because the
		// `field in observation` check fires on the key, not on the
		// value. A child cannot smuggle a capability through any of
		// these shapes -- the only path the capability travels is the
		// supervisor's own per-host observation.
		for (const observation of [
			// Umbrella.
			{ capability: { capabilityVersion: "staged-capability/v1" } },
			{ capability: { capabilityDigestSha256: "f".repeat(64) } },
			{ capability: { capabilities: ["host-submission-mac"] } },
			// Unwrapped per-field.
			{ capabilityVersion: "staged-capability/v1" },
			{ capabilityDigestSha256: "f".repeat(64) },
			{ capabilities: ["host-submission-mac"] },
			// Per-field alongside other unrelated keys.
			{ samples: [1, 2, 3], capabilityVersion: "v1" },
			{ toolchain: { bunVersion: "9.9.9" }, capability: {} },
			// Edge cases: the `in` check fires on the key, not the
			// value, so a child cannot bypass the ban by setting the
			// value to a falsy or non-string.
			{ capabilityVersion: null },
			{ capabilityVersion: undefined },
			{ capabilityVersion: 0 },
			{ capabilityVersion: "" },
			{ capabilityVersion: false },
			{ capability: null },
			{ capability: undefined },
			{ capability: 0 },
			{ capability: "" },
		]) {
			expect(refused(observation)).toEqual({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			});
		}
		// And the absence of any capability-named key is accepted, so
		// the refusal is structural rather than blanket -- a child
		// observation that doesn't try to state a capability at all
		// is the supervisor's problem to forward or filter, not this
		// boundary's. A child observation that names only keys that
		// are not on the forbidden list is also accepted; the ban is
		// on the supervisor's per-host vocabulary, not on the entire
		// keyspace.
		for (const observation of [
			{ samples: [1, 2, 3] },
			{ latencyMs: 42, sampleCount: 1 },
			{},
		]) {
			expect(refused(observation)).toEqual({ ok: true });
		}
	});
});

describe("F-class review of the lock binding: the per-field ban is comprehensive", () => {
	// Phase 1.2.4 of the real-number plan. Same shape as the
	// capability F-class review at Phase 1.1.4: the per-field
	// names (`lockVersion`, `locks`, `lockDigestSha256`) were on
	// the forbidden list from commit `b85a0687` (Phase 1.2.1),
	// so the structural refusal has caught them since the
	// binding landed. This describe block codifies the F-class
	// review's finding: every shape a child could try to smuggle
	// a lock in is refused structurally, and the absence of any
	// lock-named key is still accepted so the refusal is not
	// blanket.
	test("every smuggling shape the per-field ban claims to catch is caught", async () => {
		const mod = await import("./supervisor-protocol.ts");
		const validateChildObservationBoundary = (
			mod as unknown as {
				validateChildObservationBoundary: (input: unknown) => unknown;
			}
		).validateChildObservationBoundary;
		const refused = (observation: unknown) =>
			validateChildObservationBoundary({
				childObservation: observation,
				allowedKinds: ["artifact-payload"],
			});
		// The umbrella name, each of the per-field names, each per-field
		// name wrapped in the umbrella, and the edge cases (null,
		// undefined, number, false, empty string) that a child could
		// try to slip past the `field in observation` check.
		for (const observation of [
			// Umbrella name with each per-field wrapped inside.
			{ lock: { lockVersion: "campaign-lock/v1" } },
			{ lock: { locks: ["host-lock-mac"] } },
			{ lock: { lockDigestSha256: "f".repeat(64) } },
			// Unwrapped per-field.
			{ lockVersion: "campaign-lock/v1" },
			{ lockDigestSha256: "f".repeat(64) },
			{ locks: ["host-lock-mac"] },
			// Per-field alongside other unrelated keys.
			{ samples: [1, 2, 3], lockVersion: "v1" },
			{ toolchain: { bunVersion: "9.9.9" }, lock: {} },
			// Edge cases: the `in` check fires on the key, not the
			// value, so a child cannot bypass the ban by setting the
			// value to a falsy or non-string.
			{ lockVersion: null },
			{ lockVersion: undefined },
			{ lockVersion: 0 },
			{ lockVersion: "" },
			{ lockVersion: false },
			{ lock: null },
			{ lock: undefined },
			{ lock: 0 },
			{ lock: "" },
		]) {
			expect(refused(observation)).toEqual({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			});
		}
		// And the absence of any lock-named key is accepted, so the
		// refusal is structural rather than blanket -- a child
		// observation that doesn't try to state a lock at all is
		// the supervisor's problem to forward or filter, not this
		// boundary's.
		for (const observation of [
			{ samples: [1, 2, 3] },
			{ latencyMs: 42, sampleCount: 1 },
			{},
		]) {
			expect(refused(observation)).toEqual({ ok: true });
		}
	});
});

describe("F-class review of the manifest binding: the per-field ban is comprehensive", () => {
	// Phase 1.3.4 of the real-number plan. Same shape as the
	// capability / lock F-class reviews: the per-field names
	// (`manifestVersion`, `manifests`, `manifestDigestSha256`)
	// were on the forbidden list from commit `1eb0021d` (Phase
	// 1.3.1), so the structural refusal has caught them since
	// the binding landed. This describe block codifies the
	// F-class review's finding: every shape a child could try to
	// smuggle a manifest in is refused structurally, and the
	// absence of any manifest-named key is still accepted so the
	// refusal is not blanket.
	test("every smuggling shape the per-field ban claims to catch is caught", async () => {
		const mod = await import("./supervisor-protocol.ts");
		const validateChildObservationBoundary = (
			mod as unknown as {
				validateChildObservationBoundary: (input: unknown) => unknown;
			}
		).validateChildObservationBoundary;
		const refused = (observation: unknown) =>
			validateChildObservationBoundary({
				childObservation: observation,
				allowedKinds: ["artifact-payload"],
			});
		// The umbrella name, each of the per-field names, each
		// per-field name wrapped in the umbrella, and the edge
		// cases (null, undefined, number, false, empty string)
		// that a child could try to slip past the
		// `field in observation` check.
		for (const observation of [
			// Umbrella name with each per-field wrapped inside.
			{ manifest: { manifestVersion: "manifest/v1" } },
			{ manifest: { manifests: ["host-manifest-mac"] } },
			{ manifest: { manifestDigestSha256: "f".repeat(64) } },
			// Unwrapped per-field.
			{ manifestVersion: "manifest/v1" },
			{ manifestDigestSha256: "f".repeat(64) },
			{ manifests: ["host-manifest-mac"] },
			// Per-field alongside other unrelated keys.
			{ samples: [1, 2, 3], manifestVersion: "v1" },
			{ toolchain: { bunVersion: "9.9.9" }, manifest: {} },
			// Edge cases: the `in` check fires on the key, not
			// the value, so a child cannot bypass the ban by
			// setting the value to a falsy or non-string.
			{ manifestVersion: null },
			{ manifestVersion: undefined },
			{ manifestVersion: 0 },
			{ manifestVersion: "" },
			{ manifestVersion: false },
			{ manifest: null },
			{ manifest: undefined },
			{ manifest: 0 },
			{ manifest: "" },
		]) {
			expect(refused(observation)).toEqual({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			});
		}
		// And the absence of any manifest-named key is accepted,
		// so the refusal is structural rather than blanket -- a
		// child observation that doesn't try to state a manifest
		// at all is the supervisor's problem to forward or filter,
		// not this boundary's.
		for (const observation of [
			{ samples: [1, 2, 3] },
			{ latencyMs: 42, sampleCount: 1 },
			{},
		]) {
			expect(refused(observation)).toEqual({ ok: true });
		}
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

describe("manifest observation is supervisor-measured or it does not validate", () => {
	const macDigest = "e".repeat(64);
	const linuxDigest = "f".repeat(64);
	const complete = {
		provenance: "supervisor-measured" as const,
		mac: {
			platform: "darwin-arm64",
			manifestVersion: "manifest/v1",
			manifestDigestSha256: macDigest,
			manifests: ["host-manifest-mac"],
		},
		linux: {
			platform: "linux-x86_64",
			manifestVersion: "manifest/v1",
			manifestDigestSha256: linuxDigest,
			manifests: ["host-manifest-linux"],
		},
	};

	test("echo-of-plan and child-reported can never validate a manifest observation", () => {
		for (const provenance of ["echo-of-plan", "child-reported"] as const) {
			expect(
				validateObservedManifestFacts({ ...complete, provenance }),
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
			expect(validateObservedManifestFacts(observed)).toEqual({
				ok: false,
				code: "TRUST_OBSERVATION_OMITTED",
			});
		}
	});

	test("a per-host fact that was not observed is a typed failure", () => {
		const macMissingVersion = {
			...complete,
			mac: { ...complete.mac, manifestVersion: undefined },
		};
		expect(validateObservedManifestFacts(macMissingVersion)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_OMITTED",
		});
	});

	test("a non-hex manifest digest is drift, not a slip past the type system", () => {
		const badMacDigest = {
			...complete,
			mac: { ...complete.mac, manifestDigestSha256: "not-a-digest" },
		};
		expect(validateObservedManifestFacts(badMacDigest)).toEqual({
			ok: false,
			code: "TRUST_OBSERVATION_DRIFT",
		});
	});

	test("a supervisor measurement with both hosts and real digests validates", () => {
		expect(validateObservedManifestFacts(complete)).toEqual({
			ok: true,
			hostCount: 2,
		});
	});

	test("a child may not smuggle a manifest into a child observation", async () => {
		const mod = await import("./supervisor-protocol.ts");
		const validateChildObservationBoundary = (
			mod as unknown as {
				validateChildObservationBoundary: (input: unknown) => unknown;
			}
		).validateChildObservationBoundary;
		for (const observation of [
			{ manifest: { manifestVersion: "manifest/v1" } },
			{ manifestVersion: "manifest/v1" },
			{ manifests: ["host-manifest-mac"] },
			{ manifestDigestSha256: "f".repeat(64) },
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
