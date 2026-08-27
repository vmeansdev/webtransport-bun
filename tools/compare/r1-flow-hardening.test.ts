import { describe, expect, test } from "bun:test";
import { systemTransportClock } from "./adapters/transport.ts";
import { buildRunArtifact } from "./artifact-builder.ts";
import {
	ComparisonCliError,
	classifyVerdictTuple,
	comparisonErrorCode,
	measurementGrantSha256,
	parseMeasurementGrant,
	sealRunArtifact,
	sha256HexOfBytes,
	validateMeasurementGrantBinding,
} from "./evidence.ts";
import {
	R1_CAMPAIGN_AUTHORITY_SHA256 as FROZEN_AUTHORITY_SHA256,
	R1_CAMPAIGN_AUTHORITY_BYTES,
	R1_CAMPAIGN_LOCK_BYTES,
	R1_CAMPAIGN_MANIFEST_V1_BYTES,
} from "./r1-fixtures.ts";
import {
	generateReport,
	requireExistingReportEvidenceDir,
} from "./render-report.ts";
import * as campaignModule from "./run-campaign.ts";
import {
	type ArmMeasurement,
	assertMeasurementProvenance,
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
	CANONICAL_SCENARIO_REGISTRY,
	requestedImpairmentOf,
} from "./scenario-registry.ts";
import { openMeasurement, type SealedMeasurement } from "./stats.ts";
import {
	MEASUREMENT_GRANT_SCHEMA,
	type MeasurementGrantV1,
} from "./supervisor-client.ts";
import {
	parseVerifyArgs,
	requireExistingEvidenceDir,
} from "./verify-artifact.ts";

const HEX64 = "a".repeat(64);

/**
 * A measurement this test states in full.
 *
 * Every `buildMeasuredArmArtifact` caller has to bring its own numbers now that
 * the synthetic executor is gone. That is not a literal moved from production
 * into a test: these are the *inputs* whose scoring the assertions below are
 * about, and each caller picks them so the property under test is actually
 * reachable. Nothing here is published, and none of it is a claim about either
 * transport — no value depends on `transport` at all, which is exactly what the
 * deleted model got wrong.
 */
/**
 * Record a series of latencies through the recorder that mints their token.
 *
 * There is no other way to obtain samples an arm builder will accept, and that
 * is the property under test rather than an inconvenience of it: a test that
 * wants a latency of exactly 99 ms has to stand up a clock and advance it by
 * 99, and the clock it used is named in the artifact's provenance. Typing
 * `samples: [99, 99, 99]` beside a hand-written provenance -- which is what the
 * audit did, and published a ranked delta from -- no longer builds anything.
 */
function recordSamples(
	driverRunId: string,
	samples: readonly number[],
): SealedMeasurement {
	let nowMs = 1_000;
	const recorder = openMeasurement({
		driverRunId,
		clock: { nowMs: () => nowMs, method: "test.stepping" },
	});
	for (const [index, latency] of samples.entries()) {
		recorder.markSent();
		nowMs += latency;
		recorder.markReceived(index + 1);
		nowMs += 1;
	}
	return recorder.seal();
}

/**
 * A grant of the shape the supervisor mints, for one named execution.
 *
 * The tests stand these up rather than obtaining them, and that is exactly the
 * seam the design leaves open on purpose: the controller cannot tell an issued
 * grant from a well-formed invention, because the registry that could is in the
 * supervisor. What these exercise is the half the controller does own -- that a
 * grant names this execution, that it is spent once, and that an arm without
 * one is unbuildable.
 */
let mintedGrants = 0;
function grantFor(
	execution: {
		readonly campaignId: string;
		readonly runId: string;
		readonly executionIndex: number;
		readonly transport: string;
	},
	overrides: Partial<MeasurementGrantV1> = {},
): MeasurementGrantV1 {
	mintedGrants += 1;
	const issuedAt = Date.now();
	return {
		schema: MEASUREMENT_GRANT_SCHEMA,
		campaignId: execution.campaignId,
		candidate: "r1-flow-hardening-candidate",
		declaredMessageBytes: 1_024,
		declaredMessageCount: 4_096,
		executionIndex: execution.executionIndex,
		issuedAt,
		nonceSha256: sha256HexOfBytes(
			new TextEncoder().encode(`grant-nonce-${mintedGrants}`),
		),
		notAfter: issuedAt + 15 * 60 * 1_000,
		runId: execution.runId,
		transport: execution.transport,
		...overrides,
	};
}

/** The execution ordinals these tests hand out, unique within the file. */
let nextExecutionIndex = 0;
function nextExecution(): number {
	nextExecutionIndex += 1;
	return nextExecutionIndex;
}

function statedArmMeasurement(input: {
	readonly attempted: number;
	readonly delivered: number;
	readonly samples?: readonly number[];
	readonly grant: MeasurementGrantV1;
}): ArmMeasurement {
	const measured = recordSamples(
		"r1-flow-hardening",
		input.samples ?? [99, 99, 99],
	);
	return {
		samples: measured.samples,
		percentiles: measured.percentiles,
		ledger: {
			attempted: input.attempted,
			queued: input.attempted,
			serverObserved: input.delivered,
			acknowledged: input.delivered,
			delivered: input.delivered,
			dropped: input.attempted - input.delivered,
			expired: 0,
		},
		telemetry: {
			mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
			linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
		},
		admissionCounters: {
			schemaVersion: "v1",
			handshakes: { attempted: 10, accepted: 10, rejected: 0, rateLimited: 0 },
			sessions: { attempted: 10, accepted: 10, rejected: 0, activePeak: 10 },
			streams: { attempted: 0, accepted: 0, rejected: 0, rateLimited: 0 },
			datagrams: {
				attempted: input.attempted,
				accepted: input.delivered,
				rejected: input.attempted - input.delivered,
				rateLimited: 0,
			},
		},
		// The recorder's own, token and all. Nothing here is stated.
		provenance: measured.provenance,
		grant: input.grant,
	};
}

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
		).toBe("[comparison] Error: TRUST_AUTHORITY_UNPINNED\n");
		// A legitimate code still passes through untouched.
		const typed = new ComparisonCliError("report", "REPORT_IDENTITY_UNBOUND");
		expect(typed.code).toBe("REPORT_IDENTITY_UNBOUND");
		expect(typed.stderr).toBe("[report] Error: REPORT_IDENTITY_UNBOUND\n");
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
				// The shortfall is the loss this cell injects, so the lossy rows
				// still reach the rule under test instead of every row arriving
				// lossless. It is the same ledger on all three arms: the property
				// is about the cell's impairment, never about the transport.
				const attempted = 1000;
				const delivered =
					attempted - Math.floor((attempted * injected.lossPercent) / 100);
				const runId = `sweep-${cell.cellId}-${transport}-${armKind}`;
				const executionIndex = nextExecution();
				const artifact = buildMeasuredArmArtifact({
					cell,
					comparisonId: "r1-registry-sweep",
					runId,
					executionIndex,
					transport,
					armKind,
					measurement: statedArmMeasurement({
						attempted,
						delivered,
						grant: grantFor({
							campaignId: "r1-registry-sweep",
							runId,
							executionIndex,
							transport,
						}),
					}),
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
		const measured = recordSamples("r1-arm-builder", samples);
		return {
			samples: measured.samples,
			percentiles: measured.percentiles,
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
			provenance: measured.provenance,
			// Restamped by `armFor` for the execution the arm is actually built
			// as; these tests are about verdicts and ledgers, and the grant's
			// own rules have their own tests further down.
			grant: grantFor({
				campaignId: "r1-arm-builder",
				runId: "unbound",
				executionIndex: 0,
				transport: "wt",
			}),
		};
	}

	function armFor(
		cell: typeof lossCell,
		runId: string,
		measurement: ArmMeasurement,
	) {
		const executionIndex = nextExecution();
		return buildMeasuredArmArtifact({
			cell,
			comparisonId: "r1-arm-builder",
			runId,
			executionIndex,
			transport: "wt",
			armKind: "primary",
			measurement: {
				...measurement,
				grant: grantFor({
					campaignId: "r1-arm-builder",
					runId,
					executionIndex,
					transport: "wt",
				}),
			},
		});
	}

	// `assertMeasurementProvenance` states its own residual in its docstring: a
	// caller may open a recorder with a clock of its own, so fabrication now
	// means standing up a clock "and naming it in `provenance.clockMethod`,
	// which travels into the artifact". It did not travel. The guard consumed
	// the whole `SampleProvenance` and dropped it at build, so neither the clock
	// method nor the attestation appeared anywhere in the sealed bytes and no
	// reader of a published artifact could see what clock produced it. A defence
	// a reader is invited to credit and cannot check is worse than no defence at
	// all, which is why this is asserted against the bytes rather than against
	// the object.
	test("publishes the clock its samples were taken on into the sealed bytes", () => {
		let nowMs = 1_000;
		const recorder = openMeasurement({
			driverRunId: "r1-provenance",
			clock: { nowMs: () => nowMs, method: "MY-FABRICATED-STEPPING-CLOCK" },
		});
		for (let index = 0; index < 3; index++) {
			recorder.markSent();
			nowMs += 4;
			recorder.markReceived(index + 1);
			nowMs += 1;
		}
		const measured = recorder.seal();
		const artifact = armFor(cleanCell, "arm-builder-provenance", {
			...measurementOf(1000),
			samples: measured.samples,
			percentiles: measured.percentiles,
			provenance: measured.provenance,
		});

		expect(artifact.metrics.provenance).toEqual({
			attestation: measured.provenance.attestation,
			driverRunId: "r1-provenance",
			clockMethod: "MY-FABRICATED-STEPPING-CLOCK",
			sampleCount: measured.provenance.sampleCount,
			firstSampleAtMs: measured.provenance.firstSampleAtMs,
			lastSampleAtMs: measured.provenance.lastSampleAtMs,
		});
		const sealed = new TextDecoder().decode(sealRunArtifact(artifact));
		expect(sealed).toContain("MY-FABRICATED-STEPPING-CLOCK");
		expect(sealed).toContain(measured.provenance.attestation);
		expect(sealed).toContain("clockMethod");

		// And it is inside the digest rather than beside it: renaming the clock
		// changes the artifact's bytes, so a published number cannot be moved
		// onto a different clock without the seal saying so.
		const renamed = {
			...artifact,
			metrics: {
				...artifact.metrics,
				provenance: {
					...measured.provenance,
					clockMethod: "process.monotonic",
				},
			},
		};
		expect(sha256HexOfBytes(sealRunArtifact(renamed))).not.toBe(
			sha256HexOfBytes(sealRunArtifact(artifact)),
		);
	});

	// The audit's exact shape, and the reason it mattered. `acknowledged` had no
	// producer, so it was zero on every honest arm; the builder clamped
	// `delivered` down to it and recorded a leg that delivered six of six as
	// having delivered none, then stamped it PASS -- because the verdict was
	// derived from the ledger handed in and the artifact recorded the ledger
	// computed on the way out.
	//
	// It is refused now, and by the send-side progression rather than by an
	// ordering between the two directions: nothing this session sent got past
	// `queued`, and yet six receipts came back for it. That is a broken
	// measurement in the direction the counters are actually about.
	test("refuses a send progression that does not narrow rather than rewriting it", () => {
		const measurement: ArmMeasurement = {
			...measurementOf(1000),
			ledger: {
				attempted: 6,
				queued: 0,
				serverObserved: 6,
				acknowledged: 6,
				delivered: 6,
				dropped: 0,
				expired: 0,
			},
		};
		expect(() =>
			armFor(cleanCell, "arm-builder-nonmonotonic", measurement),
		).toThrow("LEDGER_FUNNEL_NOT_MONOTONIC");
	});

	// The single-use rule the supervisor's registry applies, in the copy that
	// runs first: the grant is spent by the attempt, so an arm refused by a
	// check downstream of the grant is not rebuildable in this process.
	//
	// That is stated here rather than left to be discovered, because the second
	// refusal names `MEASUREMENT_GRANT_ABSENT` -- which reads as though the
	// grant were never presented and in fact means this process already spent
	// it. `GrantRegistry::admit_payload` refuses the same second attempt with
	// `GrantReplayed`, which publishes that same code, so the two copies agree
	// on both the rule and what it says when it fires.
	test("spends the grant on the attempt, so a refused arm is unbuildable", () => {
		const executionIndex = nextExecution();
		const runId = "arm-builder-attempt-spend";
		const grant = grantFor({
			campaignId: "r1-arm-builder",
			runId,
			executionIndex,
			transport: "wt",
		});
		const attempt = (delivered: number) => () =>
			buildMeasuredArmArtifact({
				cell: cleanCell,
				comparisonId: "r1-arm-builder",
				runId,
				executionIndex,
				transport: "wt",
				armKind: "primary",
				measurement: { ...measurementOf(delivered), grant },
			});
		// A ledger this arm's own driver got wrong: nothing to do with the
		// grant, and refused by name.
		expect(attempt(2000)).toThrow("LEDGER_FUNNEL_NOT_MONOTONIC");
		// The same execution again, honest this time and with its own fresh
		// measurement record, is refused on the grant it already spent.
		expect(attempt(1000)).toThrow("MEASUREMENT_GRANT_ABSENT");
	});

	// The shape the single chain got wrong: an honest zero-loss echo peer that
	// lost exactly one receipt. `acknowledged` falls one behind `queued` while
	// `delivered` still equals `serverObserved`, which is precisely what both
	// adapters' docstrings promise -- a measured shortfall the arm reports, not
	// a reason to refuse the arm. Ordered into one chain it was refused, so the
	// shortfall was unrepresentable and an honest peer had no buildable ledger.
	test("records a lost receipt as a shortfall instead of refusing the arm", () => {
		const measurement: ArmMeasurement = {
			...measurementOf(1000),
			ledger: {
				attempted: 6,
				queued: 6,
				serverObserved: 6,
				acknowledged: 5,
				delivered: 6,
				dropped: 0,
				expired: 0,
			},
		};
		const artifact = armFor(cleanCell, "arm-builder-shortfall", measurement);
		expect(artifact.ledger.acknowledged).toBe(5);
		expect(artifact.ledger.delivered).toBe(6);
		expect(artifact.ledger.serverObserved).toBe(6);
	});

	// Each direction, one stage at a time, so the refusal is about the stage
	// that was raised and not about a guard that rejects whatever it is handed
	// -- and so that raising a counter past one in the *other* direction is
	// pinned as accepted rather than merely happening to be.
	test("names every stage that exceeds the one above it in its own direction", () => {
		const honest = {
			attempted: 100,
			queued: 100,
			serverObserved: 100,
			acknowledged: 100,
			delivered: 100,
			dropped: 0,
			expired: 0,
		} as const;
		const build = (ledger: ArmMeasurement["ledger"]) => () =>
			armFor(cleanCell, "arm-builder-stage", {
				...measurementOf(1000),
				ledger,
			});
		expect(build(honest)).not.toThrow();
		// Within a direction, refused by name.
		for (const stage of ["queued", "acknowledged", "delivered"] as const) {
			expect(build({ ...honest, [stage]: 101 })).toThrow(
				"LEDGER_FUNNEL_NOT_MONOTONIC",
			);
		}
		// Across directions, accepted: these are different populations. A
		// fanout subscriber receives more than it sends, and a pure sender
		// receives nothing at all; neither is a broken measurement.
		expect(
			build({ ...honest, serverObserved: 101, delivered: 101 }),
		).not.toThrow();
		expect(
			build({ ...honest, attempted: 0, queued: 0, acknowledged: 0 }),
		).not.toThrow();
		// The loss counters belong to neither progression, so each is bounded
		// by the traffic the session touched in either direction.
		expect(build({ ...honest, dropped: 200 })).not.toThrow();
		expect(build({ ...honest, dropped: 201 })).toThrow(
			"LEDGER_FUNNEL_NOT_MONOTONIC",
		);
		expect(build({ ...honest, expired: 201 })).toThrow(
			"LEDGER_FUNNEL_NOT_MONOTONIC",
		);
	});

	// `run-campaign.ts` claims a cell whose ledger is recorded one way and
	// judged another "is not a shape the code can take". It was: the clamp made
	// the recorded ledger a different object from the judged one. This is the
	// assertion that stands behind the claim.
	test("derives the verdict from the ledger it records", () => {
		for (const [cell, delivered] of [
			[cleanCell, 1000],
			[cleanCell, 999],
			[lossCell, 1000],
			[lossCell, 995],
			[lossCell, 900],
		] as const) {
			const artifact = armFor(
				cell,
				"arm-builder-agreement",
				measurementOf(delivered),
			);
			expect({
				evidenceStatus: artifact.evidenceStatus,
				scenarioVerdict: artifact.scenarioVerdict,
			}).toEqual(
				deriveMeasuredVerdictTuple(
					{
						samples: artifact.metrics.samples,
						ledger: artifact.ledger,
					},
					injectedImpairmentOf(cell),
				),
			);
		}
	});

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
		// A second recording of the same ledger, because an attestation is spent
		// by the build that uses it and one leg is one arm.
		expect(
			armFor(cleanCell, "arm-builder-clean", measurementOf(995))
				.scenarioVerdict,
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
			const runId = `parity-${cell.cellId}`;
			const executionIndex = nextExecution();
			const artifact = buildMeasuredArmArtifact({
				cell,
				comparisonId: "r1-impairment-parity",
				runId,
				executionIndex,
				transport: "wt",
				armKind: "primary",
				// This assertion is about which impairment the artifact records,
				// not about what was measured, so the ledger is lossless and the
				// same for every cell.
				measurement: statedArmMeasurement({
					attempted: 1000,
					delivered: 1000,
					grant: grantFor({
						campaignId: "r1-impairment-parity",
						runId,
						executionIndex,
						transport: "wt",
					}),
				}),
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

	// R1's closure is not "the function was deleted" — a deletion is undone by a
	// paste. It is that the shape the deleted function returned no longer builds
	// an artifact. What follows is `measureCellArm` reconstructed from the
	// literals it actually contained, including the tail values it returned for
	// each arm, handed to the builder exactly as the old default handed it.
	test("a literal-returning producer cannot build an arm, whatever it returns", () => {
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) => candidate.scenarioId === "chat-fanout",
		)!;
		/** The deleted model, reconstructed. */
		const reintroduced = (transport: "ws" | "wt") => {
			const tail = transport === "wt" ? 3.2 : 28.6;
			const attempted = 1000;
			return {
				samples: [tail, tail, tail],
				percentiles: { p1: tail, p50: tail, p95: tail, p99: tail },
				ledger: {
					attempted,
					queued: attempted,
					serverObserved: attempted,
					acknowledged: attempted,
					delivered: attempted,
					dropped: 0,
					expired: 0,
				},
				telemetry: {
					mac: { cpuPercent: 15, rssBytes: 120 * 1024 * 1024 },
					linux: { cpuPercent: 18, rssBytes: 220 * 1024 * 1024 },
				},
				admissionCounters: statedArmMeasurement({
					attempted,
					delivered: attempted,
					grant: grantFor({
						campaignId: "r1-no-literals",
						runId: `no-literals-${transport}`,
						executionIndex: nextExecution(),
						transport,
					}),
				}).admissionCounters,
			};
		};

		for (const transport of ["ws", "wt"] as const) {
			expect(() =>
				buildMeasuredArmArtifact({
					cell,
					comparisonId: "r1-no-literals",
					runId: `no-literals-${transport}`,
					executionIndex: nextExecution(),
					transport,
					armKind: "primary",
					measurement: reintroduced(transport) as never,
				}),
			).toThrow("MEASUREMENT_PROVENANCE_MISSING");
		}
	});

	// Each clause is checked on its own, because a guard that only ever fires on
	// a wholly absent field would be satisfied by a forger who adds five
	// plausible values -- which is exactly what the audit did. Every case here
	// starts from a measurement the recorder actually took and changes one
	// thing, so each refusal is about the thing that changed.
	test("refuses a measurement that is not the one the recorder filed", () => {
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) => candidate.scenarioId === "chat-fanout",
		)!;
		const measurementAt = (executionIndex: number) =>
			statedArmMeasurement({
				attempted: 1000,
				delivered: 1000,
				grant: grantFor({
					campaignId: "r1-provenance",
					runId: "provenance",
					executionIndex,
					transport: "wt",
				}),
			});
		const build =
			(
				mutate: (measurement: ArmMeasurement) => ArmMeasurement,
				executionIndex: number = nextExecution(),
			) =>
			() =>
				buildMeasuredArmArtifact({
					cell,
					comparisonId: "r1-provenance",
					runId: "provenance",
					executionIndex,
					transport: "wt",
					armKind: "primary",
					measurement: mutate(measurementAt(executionIndex)),
				});
		const asIs = (measurement: ArmMeasurement) => measurement;
		const withProvenance =
			(changes: Record<string, unknown>) =>
			(measurement: ArmMeasurement): ArmMeasurement =>
				({
					...measurement,
					provenance: { ...measurement.provenance, ...changes },
				}) as ArmMeasurement;

		// A measurement the recorder took builds, so every refusal below is
		// about the clause it changed and not about a guard rejecting everything.
		expect(build(asIs)).not.toThrow();

		// The shape the audit published from: a measurement-shaped object with
		// five plausible provenance fields and nothing behind them. There is no
		// longer a way to write it that builds.
		expect(
			build(
				withProvenance({
					attestation: "dm1-00000000000000000000000000000000",
					driverRunId: "driver-1",
					clockMethod: "performance.timeOrigin+performance.now",
					sampleCount: 3,
					firstSampleAtMs: 1_000,
					lastSampleAtMs: 1_003,
				}),
			),
		).toThrow("MEASUREMENT_ATTESTATION_UNKNOWN");

		// A grant spent once is gone, so one honestly measured leg cannot be
		// spent across a hundred and five cells. The refusal names the grant
		// rather than the recorder's token because that is the one the
		// supervisor would also raise: the token is process-local and the grant
		// is the execution's.
		const spentIndex = nextExecution();
		const spent = measurementAt(spentIndex);
		expect(build(() => spent, spentIndex)).not.toThrow();
		expect(build(() => spent, spentIndex)).toThrow("MEASUREMENT_GRANT_ABSENT");

		// A real token carried beside numbers it did not file.
		expect(
			build((measurement) => ({ ...measurement, samples: [1, 2, 3] })),
		).toThrow("MEASUREMENT_SAMPLES_UNCORROBORATED");
		expect(
			build((measurement) => ({
				...measurement,
				percentiles: { ...measurement.percentiles, p99: 3.2 },
			})),
		).toThrow("MEASUREMENT_PERCENTILES_UNCORROBORATED");
		expect(build(withProvenance({ driverRunId: "someone-elses-run" }))).toThrow(
			"MEASUREMENT_PROVENANCE_ALTERED",
		);
		expect(build(withProvenance({ firstSampleAtMs: 1 }))).toThrow(
			"MEASUREMENT_PROVENANCE_ALTERED",
		);

		// The stated clauses still fire first, by name, on the shapes they were
		// written for.
		expect(build(withProvenance({ driverRunId: "  " }))).toThrow(
			"MEASUREMENT_DRIVER_RUN_UNSTATED",
		);
		expect(build(withProvenance({ clockMethod: "Date.now" }))).toThrow(
			"MEASUREMENT_CLOCK_UNRESOLVABLE",
		);
		expect(build(withProvenance({ clockMethod: "unstated" }))).toThrow(
			"MEASUREMENT_CLOCK_UNRESOLVABLE",
		);
		expect(build(withProvenance({ sampleCount: 1000 }))).toThrow(
			"MEASUREMENT_SAMPLE_COUNT_UNCORROBORATED",
		);
		expect(build(withProvenance({ firstSampleAtMs: 0 }))).toThrow(
			"MEASUREMENT_WINDOW_UNSTATED",
		);
		expect(build(withProvenance({ lastSampleAtMs: Number.NaN }))).toThrow(
			"MEASUREMENT_WINDOW_UNSTATED",
		);
		expect(
			build(withProvenance({ firstSampleAtMs: 1_003, lastSampleAtMs: 1_000 })),
		).toThrow("MEASUREMENT_WINDOW_INVERTED");
	});

	// The driver's own output has to satisfy the guard, or the guard is a wall
	// with nothing on the other side of it.
	test("the driver's own recorder is accepted by the guard it has to pass", () => {
		const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
			(candidate) => candidate.scenarioId === "chat-fanout",
		)!;
		// Opened on the clock the driver actually runs on, and driven the way
		// the driver drives it.
		const recorder = openMeasurement({
			driverRunId: "driver-run-77",
			clock: systemTransportClock,
		});
		recorder.markSent();
		recorder.markReceived(1);
		recorder.markSent();
		recorder.markReceived(2);
		const measured = recorder.seal();
		expect(measured.provenance.clockMethod).toBe(
			"performance.timeOrigin+performance.now",
		);
		const execution = {
			campaignId: "r1-real-clock",
			runId: "real-clock",
			executionIndex: nextExecution(),
			transport: "wt",
		} as const;
		const measurement = {
			...statedArmMeasurement({
				attempted: 4,
				delivered: 4,
				grant: grantFor(execution),
			}),
			samples: measured.samples,
			percentiles: measured.percentiles,
			provenance: measured.provenance,
		};
		expect(() =>
			assertMeasurementProvenance(measurement, {
				cellId: cell.cellId,
				transport: "wt",
				execution,
			}),
		).not.toThrow();
	});
});

describe("R1 flow hardening: a measurement is bound to one execution", () => {
	// The reviewer who defeated guard v2 wrote the diagnosis this block exists
	// to answer: the guard "authenticates that a recorder ran, never that a
	// transport did". The grant does not answer it either -- nothing on this
	// side of the pipe can -- but it answers the half that was letting one real
	// leg stand in for a campaign. A series is now for an execution, and an
	// execution has exactly one.
	//
	// Everything here is the controller's copy of the rule, and the controller's
	// copy is advice: it cannot tell a grant the supervisor issued from a
	// well-formed one a caller invented, because the issuing registry is in the
	// Rust supervisor and the nonce it turns on was unpredictable before the
	// execution opened. The binding copy and its tests are
	// `secure_fs::measurement` and `bin/comparison-supervisor.rs`.
	const cell = CANONICAL_SCENARIO_REGISTRY.cells.find(
		(candidate) => injectedImpairmentOf(candidate).lossPercent === 0,
	)!;

	function armWith(input: {
		readonly runId: string;
		readonly executionIndex: number;
		readonly measurement: ArmMeasurement;
	}) {
		return buildMeasuredArmArtifact({
			cell,
			comparisonId: "r1-grant",
			runId: input.runId,
			executionIndex: input.executionIndex,
			transport: "wt",
			armKind: "primary",
			measurement: input.measurement,
		});
	}

	function grantedMeasurement(
		runId: string,
		executionIndex: number,
		overrides: Partial<MeasurementGrantV1> = {},
	): ArmMeasurement {
		return statedArmMeasurement({
			attempted: 1000,
			delivered: 1000,
			grant: grantFor(
				{ campaignId: "r1-grant", runId, executionIndex, transport: "wt" },
				overrides,
			),
		});
	}

	function refusalOf(build: () => unknown): string {
		try {
			build();
			return "";
		} catch (error: unknown) {
			return comparisonErrorCode(error);
		}
	}

	test("an arm that presents no grant is unbuildable", () => {
		const runId = "grant-absent";
		const executionIndex = nextExecution();
		const measurement = grantedMeasurement(runId, executionIndex);
		const { grant: _dropped, ...ungranted } = measurement;
		expect(
			refusalOf(() =>
				armWith({
					runId,
					executionIndex,
					measurement: ungranted as unknown as ArmMeasurement,
				}),
			),
		).toBe("MEASUREMENT_GRANT_ABSENT");
	});

	test("a measured arm reaching the builder without a grant is refused there too", () => {
		// The campaign is not the only caller. `buildRunArtifact` is exported and
		// the comparator consumes artifact objects with no file ever existing, so
		// the builder asks the same question one layer down.
		const measured = {
			comparisonId: "r1-grant",
			runId: "builder-direct",
			cellId: cell.cellId,
			transport: "wt" as const,
			samples: [10, 10, 10],
			percentiles: { p1: 10, p50: 10, p95: 10, p99: 10 },
			ledger: { attempted: 3, delivered: 3 },
			provenance: {
				attestation: "dm1-00000000000000000000000000000000",
				driverRunId: "builder-direct",
				clockMethod: "performance.timeOrigin+performance.now",
				sampleCount: 3,
				firstSampleAtMs: 1_000,
				lastSampleAtMs: 1_003,
			},
		};
		expect(refusalOf(() => buildRunArtifact(measured))).toBe(
			"MEASUREMENT_GRANT_ABSENT",
		);
		// A grant that is not a grant record fails as a record, not as an
		// absence: the two are different diagnoses and only one of them is a
		// caller who forgot.
		expect(
			refusalOf(() =>
				buildRunArtifact({ ...measured, grant: { schema: "not-a-grant" } }),
			),
		).toBe("TRUST_RECORD_SCHEMA_INVALID");
		// And an arm with no recorder behind it is the declared path, which has
		// no execution and must not be made to invent one.
		expect(
			refusalOf(() => {
				const { provenance: _none, ...declared } = measured;
				return buildRunArtifact(declared);
			}),
		).toBe("");
	});

	test("a grant issued for another execution does not authorise this one", () => {
		const executionIndex = nextExecution();
		const measurement = grantedMeasurement("elsewhere", executionIndex + 1_000);
		expect(
			refusalOf(() => armWith({ runId: "here", executionIndex, measurement })),
		).toBe("MEASUREMENT_GRANT_ABSENT");
	});

	test("a grant presented twice is presented once", () => {
		const runId = "replay";
		const executionIndex = nextExecution();
		const measurement = grantedMeasurement(runId, executionIndex);
		expect(() => armWith({ runId, executionIndex, measurement })).not.toThrow();
		// The second attempt carries the same grant, so there is nothing left to
		// spend even though the series in front of it is a real one.
		expect(
			refusalOf(() => armWith({ runId, executionIndex, measurement })),
		).toBe("MEASUREMENT_GRANT_ABSENT");
	});

	test("a grant presented outside its own lifetime is refused on the window", () => {
		const runId = "expired";
		const executionIndex = nextExecution();
		const issuedAt = Date.now() - 60 * 60 * 1_000;
		const measurement = grantedMeasurement(runId, executionIndex, {
			issuedAt,
			notAfter: issuedAt + 15 * 60 * 1_000,
		});
		expect(
			refusalOf(() => armWith({ runId, executionIndex, measurement })),
		).toBe("MEASUREMENT_OUTSIDE_GRANT_WINDOW");
	});

	// The failure the phase exists to close. Every presentation carries a real
	// series with a ledger that agrees with it; the leg happened. What makes a
	// hundred and four of them false is not anything about the numbers -- it is
	// that they are the same numbers, counted as a hundred and five
	// measurements.
	test("one honest leg cannot answer for a hundred and five cells", () => {
		const cells = CANONICAL_SCENARIO_REGISTRY.cells;
		const firstIndex = nextExecution();
		const leg = grantedMeasurement("one-honest-leg", firstIndex);
		expect(() =>
			buildMeasuredArmArtifact({
				cell: cells[0] as (typeof cells)[number],
				comparisonId: "r1-grant",
				runId: "one-honest-leg",
				executionIndex: firstIndex,
				transport: "wt",
				armKind: "primary",
				measurement: leg,
			}),
		).not.toThrow();

		const refusals: string[] = [];
		for (let index = 1; index < 105; index += 1) {
			refusals.push(
				refusalOf(() =>
					buildMeasuredArmArtifact({
						cell: cells[index % cells.length] as (typeof cells)[number],
						comparisonId: "r1-grant",
						runId: `one-honest-leg-${index}`,
						executionIndex: nextExecution(),
						transport: "wt",
						armKind: "primary",
						measurement: leg,
					}),
				),
			);
		}
		expect(refusals).toHaveLength(104);
		expect(new Set(refusals)).toEqual(new Set(["MEASUREMENT_GRANT_ABSENT"]));
	});

	test("the binding validator answers only what the controller can answer", () => {
		const execution = {
			campaignId: "r1-grant",
			runId: "binding",
			executionIndex: nextExecution(),
			transport: "wt",
		} as const;
		const grant = grantFor(execution);
		const spent = new Set<string>();
		const admitted = validateMeasurementGrantBinding({
			grant,
			execution,
			spentGrantDigests: spent,
			atMs: grant.issuedAt + 1,
		});
		expect(admitted.ok).toBe(true);
		const digest = (admitted as { readonly grantSha256: string }).grantSha256;
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		expect(measurementGrantSha256(grant)).toBe(digest);

		spent.add(digest);
		expect(
			validateMeasurementGrantBinding({
				grant,
				execution,
				spentGrantDigests: spent,
				atMs: grant.issuedAt + 1,
			}),
		).toEqual({ ok: false, code: "MEASUREMENT_GRANT_ABSENT" });
		expect(
			validateMeasurementGrantBinding({
				grant: undefined,
				execution,
				spentGrantDigests: new Set<string>(),
				atMs: grant.issuedAt + 1,
			}),
		).toEqual({ ok: false, code: "MEASUREMENT_GRANT_ABSENT" });
		expect(
			validateMeasurementGrantBinding({
				grant: { ...grant, executionIndex: execution.executionIndex + 1 },
				execution,
				spentGrantDigests: new Set<string>(),
				atMs: grant.issuedAt + 1,
			}),
		).toEqual({ ok: false, code: "MEASUREMENT_GRANT_ABSENT" });
		expect(
			validateMeasurementGrantBinding({
				grant,
				execution,
				spentGrantDigests: new Set<string>(),
				atMs: grant.notAfter + 1,
			}),
		).toEqual({ ok: false, code: "MEASUREMENT_OUTSIDE_GRANT_WINDOW" });
		// An extra field is not a grant: it re-encodes to different canonical
		// bytes than the ones it was issued as, so the supervisor would refuse
		// it and the refusal here should name the same thing.
		expect(parseMeasurementGrant({ ...grant, extra: 1 })).toEqual({
			ok: false,
			code: "TRUST_RECORD_MALFORMED",
		});
		expect(parseMeasurementGrant({ ...grant, nonceSha256: "nope" })).toEqual({
			ok: false,
			code: "TRUST_RECORD_MALFORMED",
		});
	});
});
