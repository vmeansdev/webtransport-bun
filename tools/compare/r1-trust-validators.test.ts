// Task C GREEN regression coverage for the trust validators.
//
// This target is deliberately outside the frozen RED approval bundle: it
// pins the security fixes those modules received, not the contract itself.
import { describe, expect, test } from "bun:test";

import { canonicalJson } from "./canonical.ts";
import {
	findDuplicateJsonKey,
	isSafeCount,
	isSafeNonNegative,
	parseStrictJsonBytes,
	validateCampaignAuthorityV1,
	validateStagedCapabilityV1,
} from "./secure-fs.ts";
import { validateCampaignLockAttestations } from "./campaign-lock.ts";
import { loadStagedTrustCapability } from "./staged-capability.ts";
import {
	observationProvenanceIssue,
	validateObservedPathFacts,
	validateSupervisorPhysicalReceipts,
} from "./supervisor-protocol.ts";
import {
	decodeSupervisorFrame,
	encodeSupervisorFrame,
	MAX_SESSION_FRAMES,
	SupervisorSessionFrameBudget,
} from "./supervisor-client.ts";

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
