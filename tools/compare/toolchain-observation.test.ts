import { describe, expect, test } from "bun:test";

import { buildRunArtifact } from "./artifact-builder.ts";
import { MEASUREMENT_GRANT_SCHEMA } from "./evidence.ts";
import { checkPromotionQuarantine, EMPTY_SHA256 } from "./output-policy.ts";
import {
	fileSha256,
	nativeToolchainIdentity,
	OBSERVED_TOOLCHAIN_SCHEMA,
	observeLocalToolchain,
	platformToken,
	ToolchainObservationError,
	toolchainIdentity,
} from "./toolchain-observation.ts";

describe("toolchain observation: the facts come from the runtime", () => {
	test("the observed record matches the process that produced it", async () => {
		const observed = await observeLocalToolchain();
		expect(observed.schema).toBe(OBSERVED_TOOLCHAIN_SCHEMA);
		expect(observed.bunVersion).toBe(Bun.version);
		expect(observed.bunRevision).toBe(Bun.revision);
		expect(observed.platform).toBe(
			platformToken(process.platform, process.arch),
		);
	});

	/**
	 * The whole point. The digest this replaces was the SHA-256 of empty input,
	 * so it was identical on every runtime and every host.
	 */
	test("the executable digest is a real digest of a real file", async () => {
		const observed = await observeLocalToolchain();
		expect(observed.bunExecutableSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(observed.bunExecutableSha256).not.toBe(EMPTY_SHA256);
		expect(observed.bunExecutableSha256).toBe(
			await fileSha256(process.execPath),
		);
	});

	test("identity is derived from the observation, not authored", async () => {
		const observed = await observeLocalToolchain();
		expect(toolchainIdentity(observed)).toBe(`bun-${Bun.version}`);
		// The literal it replaces was `"bun-1.3.14-darwin-arm64"`. Deriving it
		// means it tracks the runtime: a 1.4.0 process must not call itself
		// 1.3.14.
		expect(toolchainIdentity({ ...observed, bunVersion: "9.9.9" })).toBe(
			"bun-9.9.9",
		);
	});

	/**
	 * The platform belongs on the per-host entries, not on `js`: both arms of a
	 * comparison must publish the same `js` toolchain, and what has to match
	 * across two machines is the Bun version.
	 */
	test("the js identity is platform-free; the native ones are not", async () => {
		const observed = await observeLocalToolchain();
		expect(toolchainIdentity(observed)).not.toContain(process.arch);
		expect(nativeToolchainIdentity("darwin-arm64")).toBe("darwin-arm64-addon");
	});

	test("host-runtime-facts/v1 spells the machine x86_64, not x64", () => {
		expect(platformToken("linux", "x64")).toBe("linux-x86_64");
		expect(platformToken("darwin", "arm64")).toBe("darwin-arm64");
	});
});

describe("toolchain observation: refuses rather than defaults", () => {
	test("an unreadable executable is a refusal, not a placeholder digest", async () => {
		const attempt = fileSha256("/nonexistent/definitely-not-a-bun-binary");
		await expect(attempt).rejects.toThrow(ToolchainObservationError);
		await attempt.catch((error: unknown) => {
			expect((error as ToolchainObservationError).code).toBe(
				"TOOLCHAIN_EXECUTABLE_UNREADABLE",
			);
		});
	});

	test("an unobservable platform is a refusal", () => {
		expect(() => platformToken("", "arm64")).toThrow(ToolchainObservationError);
		expect(() => platformToken("darwin", "")).toThrow(
			ToolchainObservationError,
		);
	});
});

/**
 * The defect these tests were written against.
 *
 * `buildRunArtifact` published `toolchain.sha256` as the SHA-256 of empty input
 * with no input to override it, so `checkPromotionQuarantine` returned
 * `EMPTY_TOOLCHAIN_DIGEST` -- "empty-file toolchain digest cannot prove the
 * measured toolchain" -- for every artifact the campaign could build, whatever
 * it measured and however honest its source evidence was.
 */
describe("the toolchain digest is evidence, not a constant", () => {
	const base = {
		comparisonId: "toolchain-observation",
		runId: "measured/chat-fanout/subscribers-1000/ws/rep-01",
		cellId: "chat-fanout/subscribers-1000",
		transport: "ws" as const,
		seed: 20260824,
		repetitionIndex: 1,
		totalRepetitions: 5,
		samples: [10, 12, 14],
		percentiles: { p1: 10.04, p50: 12, p95: 13.8, p99: 13.96 },
		ledger: {
			attempted: 3,
			queued: 3,
			serverObserved: 3,
			acknowledged: 3,
			delivered: 3,
			dropped: 0,
		},
		sourceSha: "1111111111111111111111111111111111111111",
		archiveSha256: "12".repeat(32),
		executableSha256: "34".repeat(32),
	};

	const quarantineCodes = (input: Parameters<typeof buildRunArtifact>[0]) =>
		checkPromotionQuarantine({
			artifact: buildRunArtifact(input),
			externalTrustBound: "bound",
		}).reasons.map(({ code }) => code);

	async function observedSet() {
		const observed = await observeLocalToolchain();
		const entry = {
			identity: toolchainIdentity(observed),
			sha256: observed.bunExecutableSha256,
		};
		return { js: entry, darwin: { ...entry }, linux: { ...entry } };
	}

	test("an observed toolchain is no longer quarantined as an empty digest", async () => {
		const codes = quarantineCodes({ ...base, toolchains: await observedSet() });
		expect(codes).not.toContain("EMPTY_TOOLCHAIN_DIGEST");
		expect(codes).not.toContain("TOOLCHAIN_UNOBSERVED");
	});

	test("an artifact nobody observed says so, rather than hashing nothing", () => {
		const artifact = buildRunArtifact(base);
		for (const name of ["js", "darwin", "linux"] as const) {
			expect(artifact.source.toolchains[name].identity).toBe("unobserved");
			expect(artifact.source.toolchains[name].sha256).not.toBe(EMPTY_SHA256);
		}
		expect(quarantineCodes(base)).toContain("TOOLCHAIN_UNOBSERVED");
	});

	test("a measured arm may not be assembled without an observation", async () => {
		const issuedAt = Date.now();
		const measured = {
			...base,
			provenance: {
				attestation: "a".repeat(64),
				driverRunId: "driver-1",
				clockMethod: "process.monotonic",
				sampleCount: 3,
				firstSampleAtMs: 1,
				lastSampleAtMs: 2,
			},
			grant: {
				schema: MEASUREMENT_GRANT_SCHEMA,
				campaignId: base.comparisonId,
				candidate: "toolchain-observation-candidate",
				declaredMessageBytes: 1_024,
				declaredMessageCount: 4_096,
				executionIndex: 1,
				issuedAt,
				nonceSha256: "7".repeat(64),
				notAfter: issuedAt + 15 * 60 * 1_000,
				runId: base.runId,
				transport: base.transport,
			},
		};
		// The grant is the prior question and is asked first: an arm that cannot
		// name its execution is refused for that, not for what it ran on. With
		// one in hand, the toolchain is the next thing that must be real.
		expect(() => buildRunArtifact(measured)).toThrow("TOOLCHAIN_UNOBSERVED");
		const observed = await observedSet();
		const withToolchains = { ...measured, toolchains: observed };
		// Even with a toolchain, a measured arm that arrives without
		// the supervisor's per-host digest binding is refused: the
		// supervisor-measured requirement is mandatory, and a
		// self-attested toolchain against an empty
		// `toolchainSha256` is the same defect R1 exists to remove.
		expect(() => buildRunArtifact(withToolchains)).toThrow(
			"TOOLCHAIN_SUPERVISOR_MISSING",
		);
		// And a measured arm whose per-host digest disagrees with the
		// supervisor's reading is refused with a typed mismatch code.
		const wrongDigests = {
			...measured,
			toolchains: observed,
			supervisorToolchainDigests: {
				darwin: "f".repeat(64),
				linux: "e".repeat(64),
			},
		};
		expect(() => buildRunArtifact(wrongDigests)).toThrow(
			"TOOLCHAIN_SUPERVISOR_MISMATCH",
		);
		// The arm assembles only when the supervisor's per-host digests
		// match the artifact's per-host toolchain entries.
		const expectedDigest = observed.darwin.sha256;
		const withBinding = {
			...measured,
			toolchains: observed,
			supervisorToolchainDigests: {
				darwin: expectedDigest,
				linux: expectedDigest,
			},
		};
		expect(() => buildRunArtifact(withBinding)).not.toThrow();
	});

	test("the published runtime identity tracks the runtime, not a literal", async () => {
		const artifact = buildRunArtifact({
			...base,
			toolchains: await observedSet(),
		});
		expect(artifact.runtime.mac.identity).toBe(
			`mac-runtime-bun-${Bun.version}`,
		);
		expect(artifact.runtime.linux.identity).toBe(
			`linux-runtime-bun-${Bun.version}`,
		);
		expect(artifact.runtime.mac.bun).toBe(`bun-${Bun.version}`);
	});

	test("a toolchain the child authored rather than the supervisor observed is refused at the trust boundary", async () => {
		// Phase 3 of the producer plan: the child-stated path is retired.
		// The supervisor's child observation boundary refuses any of
		// the names a child could use to smuggle a toolchain in --
		// both the umbrella name and the per-field names that a child
		// might try directly. Each name is exercised as a top-level
		// child-observation key, not wrapped in a `toolchain` object,
		// so the assertion is on the structural refusal and not on
		// the umbrella.
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
		// a toolchain in either as a `toolchain` object or by naming
		// the supervisor's per-host fields directly.
		for (const observation of [
			{ toolchain: { bunVersion: "9.9.9" } },
			{ toolchain: { bunRevision: "child-rev" } },
			{ toolchain: { bunExecutableSha256: "f".repeat(64) } },
			{ bunVersion: "9.9.9" },
			{ bunRevision: "child-rev" },
			{ bunExecutableSha256: "f".repeat(64) },
		]) {
			expect(refused(observation)).toEqual({
				ok: false,
				code: "TRUST_CHILD_OBSERVATION_FORBIDDEN",
			});
		}
		// And the absence of any toolchain-named key is accepted, so
		// the refusal is structural rather than blanket -- a child
		// observation that doesn't try to state a toolchain at all
		// is the supervisor's problem to forward or filter, not this
		// boundary's.
		expect(refused({ samples: [1, 2, 3] })).toEqual({ ok: true });
	});
});
