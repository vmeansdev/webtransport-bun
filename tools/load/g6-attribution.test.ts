import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
	buildBalancedLaneOrder,
	buildLaneContract,
	buildSharedAttributionPlan,
	buildSharedAttributionServerSettings,
	evaluateAttributionOutcome,
	validateAttributionIdentity,
	validateMinimalJsAddonContract,
	type AttributionIdentityLeg,
} from "./g6-attribution.ts";
import type { ClientReportV2 } from "./g6-artifact.ts";
import {
	buildIdentityLeg,
	closeWithin,
	deriveIdleBand,
	type AggregateResult,
	type AttributionLegManifest,
	renderManifestJson,
	renderAggregateArtifacts,
	portableEvidenceName,
	resolveMatrixProvenance,
	settleToIdleBand,
	terminateChildWithin,
	withFreshBuildDirectory,
	withAttributionRunContext,
	waitForRustServerExit,
} from "./g6-attribution-server.ts";

const PREREG_SHA =
	"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const CANDIDATE_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLIENT_SHA =
	"89abcdef0123456789abcdef0123456789abcdef0123456789abcdef01234567";
const CERT_SHA =
	"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

function makeLeg(
	over: Partial<AttributionIdentityLeg> = {},
): AttributionIdentityLeg {
	const plan = buildSharedAttributionPlan();
	const base: AttributionIdentityLeg = {
		lane: "full-js",
		orderIndex: 0,
		preRegistration: {
			id: "g6-mmo-closeout/1",
			path: "docs/research/preregistrations/gate-g6-mmo-closeout.md",
			sha256: PREREG_SHA,
		},
		candidateSha: CANDIDATE_SHA,
		clientBinarySha256: CLIENT_SHA,
		hostIdentity: "runner-a",
		tlsCertSha256: CERT_SHA,
		sessions: plan.sessions,
		durationSec: plan.durationSec,
		upstreamPayloadBytes: plan.upstreamPayloadBytes,
		movePps: plan.movePps,
		actionPps: plan.actionPps,
		actionEveryNthTick: plan.actionEveryNthTick,
		snapshotDatagrams: plan.snapshotDatagrams,
		snapshotPayloadBytes: plan.snapshotPayloadBytes,
		snapshotHz: plan.snapshotHz,
		emitterSliceHz: plan.emitterSliceHz,
		expectedMoveDue: plan.expectedMoveDue,
		expectedSnapshotDue: plan.expectedSnapshotDue,
		expectedAckDue: plan.expectedAckDue,
		clientOfferedRatio: 0.999,
		clientScheduleLagNegative: 0,
		serverEmitterLagNegative: 0,
		phaseMarkers: ["steady", "drain", "idle", "stop"],
		sendErrors: 0,
		unclassifiedDatagrams: 0,
		rateLimitedDelta: 0,
		limitExceededDelta: 0,
		clientScheduleTicksDue: plan.expectedMoveDue,
		serverSnapshotDue: plan.expectedSnapshotDue,
		serverAckDue: plan.expectedAckDue,
		comparableStageMismatchPct: 0.0005,
		issuedRatio: 0.998,
		serverSettings: buildSharedAttributionServerSettings(plan.sessions),
		measurements: {
			window: {
				kind: "steady",
				startPhase: "steady",
				endPhase: "drain",
				wallMs: plan.durationSec * 1000,
				synchronized: true,
			},
			serverProcessCpu: { unit: "cpu-ms", value: 42 },
			clientProcessCpu: { unit: "cpu-ms", value: 41 },
			hostCpu: { unit: "host-cpu-pct", value: 18.5 },
			serverRss: { unit: "rss-mib", value: 128 },
			clientRss: { unit: "rss-mib", value: 64 },
			rawStages: {
				datagramFrameUnit: "quic-datagram-frames",
				udpDatagramUnit: "udp-datagrams",
				datagramFramesSent: 1500,
				datagramFramesReceived: 391,
				udpDatagramsSent: 1500,
				udpDatagramsReceived: 391,
				capturedBeforeTeardown: true,
			},
		},
	};
	return {
		...base,
		...over,
		serverSettings: over.serverSettings ?? base.serverSettings,
	};
}

describe("shared attribution plan", () => {
	test("uses one immutable armShape-derived workload for every lane", () => {
		const plan = buildSharedAttributionPlan();
		const smokePlan = buildSharedAttributionPlan(20, 5);
		const settings = buildSharedAttributionServerSettings(plan.sessions);

		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(settings)).toBe(true);
		expect(Object.isFrozen(settings.limits)).toBe(true);
		expect(Object.isFrozen(settings.rateLimits)).toBe(true);
		expect(plan.sessions).toBe(5000);
		expect(plan.durationSec).toBe(120);
		expect(plan.movePps).toBe(4);
		expect(plan.upstreamAggregatePps).toBe(20_000);
		expect(plan.snapshotAggregatePps).toBe(75_000);
		expect(plan.ackAggregatePps).toBe(2_500);
		expect(plan.snapshotDatagrams).toBe(3);
		expect(plan.snapshotPayloadBytes).toBe(1150);
		expect(settings.limits.maxSessions).toBe(10_016);
		expect(settings.limits.maxDatagramSize).toBe(1_214);
		expect(settings.rateLimits.handshakesPerSec).toBe(10_016);
		expect(settings.rateLimits.datagramsPerSec).toBe(320_000);
		expect(smokePlan.expectedMoveDue).toBe(391);
		expect(smokePlan.expectedSnapshotDue).toBe(1500);
		expect(smokePlan.expectedAckDue).toBe(40);
		expect(buildBalancedLaneOrder()).toEqual([
			["full-js", "minimal-js-addon", "direct-rust"],
			["minimal-js-addon", "direct-rust", "full-js"],
			["direct-rust", "full-js", "minimal-js-addon"],
		]);
	});

	test("keeps pure evaluation separate from the execution entrypoint", async () => {
		const pureModule = await import("./g6-attribution.ts");
		const executionModule = await import("./g6-attribution-server.ts");

		expect(
			typeof (pureModule as Record<string, unknown>).runAttributionMatrixCli,
		).toBe("undefined");
		expect(typeof executionModule.runAttributionMatrixCli).toBe("function");
		expect(typeof executionModule.runAttributionLeg).toBe("function");
	});

	test("resolves an already-exited direct-rust child without hanging the matrix", async () => {
		const exitedChild = {
			exitCode: 0,
			signalCode: null,
			on() {
				return this;
			},
		} as unknown as ChildProcess;

		const result = await Promise.race([
			waitForRustServerExit(exitedChild),
			Bun.sleep(50).then(() => "timeout"),
		]);

		expect(result).toBe(0);
	});

	test("terminates a hung child with bounded escalation and reaps the exit", async () => {
		class FakeChild extends EventEmitter {
			exitCode: number | null = null;
			signalCode: NodeJS.Signals | null = null;
			killSignals: string[] = [];

			kill(signal: NodeJS.Signals | number = "SIGTERM") {
				this.killSignals.push(String(signal));
				if (signal === "SIGKILL") {
					this.signalCode = "SIGKILL";
					this.emit("exit", null, "SIGKILL");
				}
				return true;
			}
		}

		const child = new FakeChild() as unknown as ChildProcess;
		const exitCode = await terminateChildWithin(child, {
			termTimeoutMs: 10,
			killTimeoutMs: 10,
		});

		expect(exitCode).toBe(128);
		expect((child as unknown as FakeChild).killSignals).toEqual([
			"SIGTERM",
			"SIGKILL",
		]);
	});

	test("fails closed when a js server close exceeds its deadline", async () => {
		await expect(
			closeWithin("js-server close", () => new Promise<void>(() => {}), 10),
		).rejects.toThrow("g6-attribution: js-server close timed out after 10ms");
	});

	test("fails settlement when host cpu never returns to the derived idle band", async () => {
		const idleBand = deriveIdleBand([4, 5, 6], {
			minSlackPct: 1,
			requiredConsecutiveSamples: 2,
		});

		await expect(
			settleToIdleBand({
				idleBand,
				deadlineMs: 30,
				sampleIntervalMs: 5,
				readHostCpu: async () => 20,
			}),
		).rejects.toThrow(
			"g6-attribution: host cpu did not return to the idle band",
		);
	});

	test("invalidates missing raw connection taps instead of treating them as acceptable zeros", () => {
		const plan = buildSharedAttributionPlan(20, 5);
		const leg = buildIdentityLeg({
			lane: "full-js",
			orderIndex: 0,
			plan,
			preRegistrationSha256: PREREG_SHA,
			candidateSha: CANDIDATE_SHA,
			clientBinarySha256: CLIENT_SHA,
			tlsCertSha256: CERT_SHA,
			hostIdentity: "runner-a",
			clientReport: {
				schema: "mmo-client/2",
				role: "realm",
				startedAt: "2026-08-24T00:00:00.000Z",
				preRegistration: {
					id: "g6-mmo-closeout/1",
					path: "docs/research/preregistrations/gate-g6-mmo-closeout.md",
					sha256: PREREG_SHA,
				},
				windows: {
					steady: {
						sent: 391,
						scheduleTicksDue: 391,
						scheduleLag: { negative: 0 },
					},
				},
			} as ClientReportV2,
			phaseMarkers: ["steady", "drain", "idle", "stop"],
			rawServer: {
				state: {
					rxTotal: 391,
					rxUnstamped: 0,
					emitter: {
						snapshotDue: 1500,
						snapshotIssued: 1500,
						ackDue: 40,
						ackIssued: 40,
						raidForwarded: 0,
						sendErrors: 0,
						sendEventsSkipped: 0,
						batchPartialCompletions: 0,
					},
				} as never,
				connectionStats: {
					datagramFramesSent: null,
					datagramFramesReceived: null,
					udpDatagramsSent: null,
					udpDatagramsReceived: null,
				},
			},
		});

		const base = leg as unknown as AttributionIdentityLeg;
		const verdict = validateAttributionIdentity([
			base,
			{
				...base,
				lane: "direct-rust",
				orderIndex: 1,
			},
		]);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons).toContain(
			"direct-rust required measurements missing rawStages.datagramFramesSent",
		);
	});

	test("creates a missing matrix output directory before TLS material is written", async () => {
		const base = mkdtempSync(join(tmpdir(), "g6-attribution-order-"));
		const outDir = join(base, "fresh-output");
		let observedOutDirExists = false;
		let observedCertParent = "";

		await withAttributionRunContext({ outDir }, async ({ outDir, tls }) => {
			observedOutDirExists = existsSync(outDir);
			observedCertParent = dirname(tls.certPath);
			expect(existsSync(tls.certPath)).toBe(true);
			expect(existsSync(tls.keyPath)).toBe(true);
		});

		expect(observedOutDirExists).toBe(true);
		expect(observedCertParent).not.toBe(outDir);

		rmSync(base, { recursive: true, force: true });
	});

	test("cleans ephemeral TLS key material after a successful matrix setup", async () => {
		const base = mkdtempSync(join(tmpdir(), "g6-attribution-success-"));
		const outDir = join(base, "evidence");
		let certPath = "";
		let keyPath = "";
		let tlsDir = "";

		await withAttributionRunContext({ outDir }, async ({ tls }) => {
			certPath = tls.certPath;
			keyPath = tls.keyPath;
			tlsDir = dirname(tls.keyPath);
			expect(existsSync(certPath)).toBe(true);
			expect(existsSync(keyPath)).toBe(true);
		});

		expect(existsSync(certPath)).toBe(false);
		expect(existsSync(keyPath)).toBe(false);
		expect(existsSync(tlsDir)).toBe(false);
		expect(readdirSync(outDir).filter((name) => name.endsWith(".pem"))).toEqual(
			[],
		);

		rmSync(base, { recursive: true, force: true });
	});

	test("cleans ephemeral TLS key material after a setup failure", async () => {
		const base = mkdtempSync(join(tmpdir(), "g6-attribution-fail-"));
		const outDir = join(base, "evidence");
		let certPath = "";
		let keyPath = "";
		let tlsDir = "";

		await expect(
			withAttributionRunContext({ outDir }, async ({ tls }) => {
				certPath = tls.certPath;
				keyPath = tls.keyPath;
				tlsDir = dirname(tls.keyPath);
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(existsSync(certPath)).toBe(false);
		expect(existsSync(keyPath)).toBe(false);
		expect(existsSync(tlsDir)).toBe(false);
		expect(readdirSync(outDir).filter((name) => name.endsWith(".pem"))).toEqual(
			[],
		);

		rmSync(base, { recursive: true, force: true });
	});

	test("stores only portable relative evidence names in the aggregate", () => {
		const root = "/private/tmp/g6-attribution";
		const legPath = join(root, "00-full-js.json");
		const relativeName = portableEvidenceName(root, legPath);

		expect(relativeName).toBe("00-full-js.json");
		expect(isAbsolute(relativeName)).toBe(false);
		expect(() =>
			portableEvidenceName(root, "/private/tmp/elsewhere.json"),
		).toThrow("g6-attribution: evidence path escaped the output directory");
	});

	test("creates and then removes a fresh controlled build directory", async () => {
		let buildDir = "";

		await withFreshBuildDirectory(async (dir) => {
			buildDir = dir;
			expect(existsSync(buildDir)).toBe(true);
			expect(buildDir.includes("target/release")).toBe(false);
		});

		expect(existsSync(buildDir)).toBe(false);
	});

	test("serializes retained aggregate artifacts byte-identically for identical inputs", () => {
		const leg = makeLeg();
		const aggregate: AggregateResult = {
			schema: "g6-attribution/1" as const,
			invokedAt: "2026-08-24T00:00:00.000Z",
			preRegistration: leg.preRegistration,
			plan: buildSharedAttributionPlan(20, 5),
			candidateSha: leg.candidateSha,
			clientBinarySha256: leg.clientBinarySha256,
			rustServerBinarySha256: leg.clientBinarySha256,
			legOrder: ["full-js", "direct-rust"],
			legs: ["00-full-js.json", "01-direct-rust.json"],
			provenance: {
				cleanTree: true as const,
				buildCommand:
					"cargo build --locked --release -p reference --bin mmo-client --bin g6-server",
				freshTargetDir: true as const,
			},
			settlement: {
				baselineSamples: [3.5, 4.2],
				idleBand: {
					baselineSamples: [3.5, 4.2],
					upperBoundPct: 5.1,
					rule: "max(baseline) × 1.1",
					requiredConsecutiveSamples: 3,
				},
				sampleWindowMs: 100,
				sampleIntervalMs: 100,
				deadlineMs: 30_000,
				afterLegs: [
					{ leg: "00-full-js.json", samples: [4.1, 4.0, 3.9] },
					{ leg: "01-direct-rust.json", samples: [4.0, 3.8, 3.7] },
				],
			},
			identity: { valid: true, reasons: [] },
			outcome: { valid: true, reasons: [], cpuAttributionAllowed: true },
			profiles: { available: false as const, reason: "not collected" },
		};
		const executedLegs = [
			{ lane: "full-js" as const, orderIndex: 0, identityLeg: leg },
			{
				lane: "direct-rust" as const,
				orderIndex: 1,
				identityLeg: makeLeg({ lane: "direct-rust", orderIndex: 1 }),
			},
		];

		const once = renderAggregateArtifacts(aggregate, executedLegs);
		const twice = renderAggregateArtifacts(aggregate, executedLegs);

		expect(twice).toEqual(once);
	});

	test("serializers use the provided truthful timestamps instead of a hidden constant", () => {
		const leg = makeLeg();
		const baseAggregate: AggregateResult = {
			schema: "g6-attribution/1" as const,
			invokedAt: "2026-08-24T00:00:00.000Z",
			preRegistration: leg.preRegistration,
			plan: buildSharedAttributionPlan(20, 5),
			candidateSha: leg.candidateSha,
			clientBinarySha256: leg.clientBinarySha256,
			rustServerBinarySha256: leg.clientBinarySha256,
			legOrder: ["full-js"],
			legs: ["00-full-js.json"],
			provenance: {
				cleanTree: true as const,
				buildCommand:
					"cargo build --locked --release -p reference --bin mmo-client --bin g6-server",
				freshTargetDir: true as const,
			},
			settlement: {
				baselineSamples: [3.5],
				idleBand: {
					baselineSamples: [3.5],
					upperBoundPct: 4.5,
					rule: "explicit test input",
					requiredConsecutiveSamples: 3,
				},
				sampleWindowMs: 100,
				sampleIntervalMs: 100,
				deadlineMs: 30_000,
				afterLegs: [{ leg: "00-full-js.json", samples: [3.8, 3.7, 3.6] }],
			},
			identity: { valid: true, reasons: [] },
			outcome: { valid: true, reasons: [], cpuAttributionAllowed: true },
			profiles: { available: false as const, reason: "not collected" },
		};
		const executedLegs = [
			{ lane: "full-js" as const, orderIndex: 0, identityLeg: leg },
		];

		const first = renderAggregateArtifacts(baseAggregate, executedLegs);
		const second = renderAggregateArtifacts(
			{ ...baseAggregate, invokedAt: "2026-08-24T00:05:00.000Z" },
			executedLegs,
		);

		expect(first.aggregateJson).not.toBe(second.aggregateJson);
	});

	test("serializes retained leg manifests byte-identically for identical inputs", () => {
		const leg = makeLeg();
		const manifest: AttributionLegManifest = {
			schema: "g6-attribution-leg/1" as const,
			lane: "full-js" as const,
			orderIndex: 0,
			preRegistration: leg.preRegistration,
			contract: buildLaneContract("full-js"),
			plan: buildSharedAttributionPlan(20, 5),
			hostIdentity: leg.hostIdentity,
			candidateSha: leg.candidateSha,
			clientBinarySha256: leg.clientBinarySha256,
			serverBinarySha256: leg.clientBinarySha256,
			tlsCertSha256: leg.tlsCertSha256,
			serverSettings: leg.serverSettings,
			clientReport: {
				schema: "mmo-client/2",
				role: "realm",
				startedAt: "2026-08-24T00:00:00.000Z",
				preRegistration: leg.preRegistration,
				windows: {
					steady: {
						sent: leg.clientScheduleTicksDue,
						scheduleTicksDue: leg.clientScheduleTicksDue,
						scheduleLag: { negative: 0 },
					},
				},
			},
			phaseMarkers: leg.phaseMarkers,
			stdoutLines: [],
			stderrLines: [],
			rawServer: {},
			identityLeg: leg,
		};

		expect(renderManifestJson(manifest)).toBe(renderManifestJson(manifest));
	});

	test("truthful explicit timestamps can differ without changing evaluator semantics", () => {
		const plan = buildSharedAttributionPlan(20, 5);
		const buildLeg = (startedAt: string) =>
			buildIdentityLeg({
				lane: "full-js",
				orderIndex: 0,
				plan,
				preRegistrationSha256: PREREG_SHA,
				candidateSha: CANDIDATE_SHA,
				clientBinarySha256: CLIENT_SHA,
				tlsCertSha256: CERT_SHA,
				hostIdentity: "runner-a",
				clientReport: {
					schema: "mmo-client/2",
					role: "realm",
					startedAt,
					preRegistration: {
						id: "g6-mmo-closeout/1",
						path: "docs/research/preregistrations/gate-g6-mmo-closeout.md",
						sha256: PREREG_SHA,
					},
					windows: {
						steady: {
							sent: 391,
							scheduleTicksDue: 391,
							scheduleLag: { negative: 0 },
						},
					},
				} as ClientReportV2,
				phaseMarkers: ["steady", "drain", "idle", "stop"],
				rawServer: {
					state: {
						rxTotal: 391,
						rxUnstamped: 0,
						emitter: {
							snapshotDue: 1500,
							snapshotIssued: 1500,
							ackDue: 40,
							ackIssued: 40,
							raidForwarded: 0,
							sendErrors: 0,
							sendEventsSkipped: 0,
							batchPartialCompletions: 0,
						},
					} as never,
					connectionStats: {
						datagramFramesSent: 1500,
						datagramFramesReceived: 391,
						udpDatagramsSent: 1500,
						udpDatagramsReceived: 391,
					},
				},
			});

		expect(buildLeg("2026-08-24T00:00:00.000Z")).toEqual(
			buildLeg("2026-08-24T00:05:00.000Z"),
		);
	});
});

describe("matrix provenance", () => {
	test("rejects a dirty candidate tree before hashing or launch", async () => {
		await expect(
			resolveMatrixProvenance({
				clientBinary: "/tmp/mmo-client",
				rustServerBinary: "/tmp/g6-server",
				deps: {
					candidateSha: () => CANDIDATE_SHA,
					assertCleanTree: () => {
						throw new Error("g6-attribution: candidate tree is dirty");
					},
					buildReferenceBinaries: () => {
						throw new Error("should not build");
					},
					fileExists: () => true,
					hashFile: () => CLIENT_SHA,
				},
			}),
		).rejects.toThrow("g6-attribution: candidate tree is dirty");
	});

	test("fails closed when the locked reference build fails", async () => {
		await expect(
			resolveMatrixProvenance({
				clientBinary: "/tmp/mmo-client",
				rustServerBinary: "/tmp/g6-server",
				deps: {
					candidateSha: () => CANDIDATE_SHA,
					assertCleanTree: () => {},
					buildReferenceBinaries: () => {
						throw new Error("cargo build failed");
					},
					fileExists: () => true,
					hashFile: () => CLIENT_SHA,
				},
			}),
		).rejects.toThrow("cargo build failed");
	});

	test("fails closed when the controlled build does not produce both binaries", async () => {
		await expect(
			resolveMatrixProvenance({
				clientBinary: "/tmp/mmo-client",
				rustServerBinary: "/tmp/g6-server",
				deps: {
					candidateSha: () => CANDIDATE_SHA,
					assertCleanTree: () => {},
					buildReferenceBinaries: () => ({
						command:
							"cargo build --locked --release -p reference --bin mmo-client --bin g6-server",
						clientBinary: "/tmp/mmo-client",
						rustServerBinary: "/tmp/g6-server",
					}),
					fileExists: (path) => path === "/tmp/mmo-client",
					hashFile: () => CLIENT_SHA,
				},
			}),
		).rejects.toThrow(
			"g6-attribution: controlled reference build did not produce /tmp/g6-server",
		);
	});

	test("rejects source and binary provenance mismatches", async () => {
		await expect(
			resolveMatrixProvenance({
				clientBinary: "/override/mmo-client",
				rustServerBinary: "/override/g6-server",
				deps: {
					candidateSha: () => CANDIDATE_SHA,
					assertCleanTree: () => {},
					buildReferenceBinaries: () => ({
						command:
							"cargo build --locked --release -p reference --bin mmo-client --bin g6-server",
						clientBinary: "/target/release/mmo-client",
						rustServerBinary: "/target/release/g6-server",
					}),
					fileExists: () => true,
					hashFile: () => CLIENT_SHA,
				},
			}),
		).rejects.toThrow(
			"g6-attribution: requested client binary /override/mmo-client did not match controlled build output /target/release/mmo-client",
		);
	});
});

describe("minimal js addon contract", () => {
	test("permits only the four diagnostic switches to differ", () => {
		const full = buildLaneContract("full-js");
		const minimal = buildLaneContract("minimal-js-addon");

		expect(validateMinimalJsAddonContract(full, minimal)).toEqual({
			valid: true,
			reasons: [],
		});
	});

	test("rejects any unknown behavioral difference", () => {
		const full = buildLaneContract("full-js");
		const minimal = {
			...buildLaneContract("minimal-js-addon"),
			serverPlan: {
				...buildLaneContract("minimal-js-addon").serverPlan,
				snapshotPayloadBytes: 1200,
			},
		};

		const verdict = validateMinimalJsAddonContract(full, minimal);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons).toContain(
			"minimal-js-addon contract mismatch at serverPlan.snapshotPayloadBytes",
		);
	});
});

describe("identity validation", () => {
	test("fails closed on candidate, tls, duration, session, payload, and cadence drift", () => {
		const base = makeLeg();
		const plan = buildSharedAttributionPlan();
		const mutated = [
			makeLeg({ candidateSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
			makeLeg({
				tlsCertSha256:
					"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			}),
			makeLeg({ durationSec: plan.durationSec - 1 }),
			makeLeg({ sessions: plan.sessions - 1 }),
			makeLeg({ upstreamPayloadBytes: plan.upstreamPayloadBytes + 1 }),
			makeLeg({ movePps: plan.movePps + 1 }),
		];

		for (const leg of mutated) {
			const verdict = validateAttributionIdentity([base, leg]);
			expect(verdict.valid).toBe(false);
		}
	});

	test("invalidates low offer ratio, negative lag, missing markers, send errors, and unreconciled taps", () => {
		const verdict = validateAttributionIdentity([
			makeLeg(),
			makeLeg({
				lane: "direct-rust",
				orderIndex: 1,
				clientOfferedRatio: 0.98,
				clientScheduleLagNegative: 1,
				phaseMarkers: ["steady", "idle"],
				sendErrors: 1,
				unclassifiedDatagrams: 1,
				rateLimitedDelta: 2,
				limitExceededDelta: 1,
				comparableStageMismatchPct: 0.002,
			}),
		]);

		expect(verdict.valid).toBe(false);
		expect(verdict.reasons).toContain(
			"direct-rust client offered ratio 0.980000 is below 0.99",
		);
		expect(verdict.reasons).toContain(
			"direct-rust reported negative schedule lag samples",
		);
		expect(verdict.reasons).toContain(
			"direct-rust phase markers missing drain,stop",
		);
		expect(verdict.reasons).toContain("direct-rust recorded send errors");
		expect(verdict.reasons).toContain(
			"direct-rust recorded unclassified datagrams",
		);
		expect(verdict.reasons).toContain(
			"direct-rust rate/limit counters changed",
		);
		expect(verdict.reasons).toContain(
			"direct-rust comparable raw-stage mismatch 0.200% exceeded 0.100%",
		);
	});

	test("invalidates missing or drifted shared immutable server settings", () => {
		const base = makeLeg();
		const settings = buildSharedAttributionServerSettings(base.sessions);
		const drifted = {
			...makeLeg({ lane: "direct-rust", orderIndex: 1 }),
			serverSettings: {
				limits: {
					...settings.limits,
					maxDatagramSize: settings.limits.maxDatagramSize + 1,
				},
				rateLimits: {
					...settings.rateLimits,
					datagramsPerSec: settings.rateLimits.datagramsPerSec + 1,
				},
			},
		} as AttributionIdentityLeg;
		const missing = {
			...makeLeg({ lane: "minimal-js-addon", orderIndex: 1 }),
			serverSettings: undefined,
		} as unknown as AttributionIdentityLeg;

		const driftedVerdict = validateAttributionIdentity([base, drifted]);
		expect(driftedVerdict.valid).toBe(false);
		expect(driftedVerdict.reasons).toContain(
			"direct-rust serverSettings.limits.maxDatagramSize drifted from the shared immutable server settings",
		);
		expect(driftedVerdict.reasons).toContain(
			"direct-rust serverSettings.rateLimits.datagramsPerSec drifted from the shared immutable server settings",
		);

		const missingVerdict = validateAttributionIdentity([base, missing]);
		expect(missingVerdict.valid).toBe(false);
		expect(missingVerdict.reasons).toContain(
			"minimal-js-addon missing shared immutable server settings",
		);
	});

	test("invalidates every shared immutable server setting field when it drifts", () => {
		const base = makeLeg();
		const settings = buildSharedAttributionServerSettings(base.sessions);
		const limitKeys = Object.keys(settings.limits) as Array<
			keyof typeof settings.limits
		>;
		const rateKeys = Object.keys(settings.rateLimits) as Array<
			keyof typeof settings.rateLimits
		>;

		for (const key of limitKeys) {
			const verdict = validateAttributionIdentity([
				base,
				{
					...makeLeg({ lane: "direct-rust", orderIndex: 1 }),
					serverSettings: {
						limits: {
							...settings.limits,
							[key]: settings.limits[key] + 1,
						},
						rateLimits: { ...settings.rateLimits },
					},
				},
			]);
			expect(verdict.valid).toBe(false);
			expect(verdict.reasons).toContain(
				`direct-rust serverSettings.limits.${key} drifted from the shared immutable server settings`,
			);
		}

		for (const key of rateKeys) {
			const verdict = validateAttributionIdentity([
				base,
				{
					...makeLeg({ lane: "direct-rust", orderIndex: 1 }),
					serverSettings: {
						limits: { ...settings.limits },
						rateLimits: {
							...settings.rateLimits,
							[key]: settings.rateLimits[key] + 1,
						},
					},
				},
			]);
			expect(verdict.valid).toBe(false);
			expect(verdict.reasons).toContain(
				`direct-rust serverSettings.rateLimits.${key} drifted from the shared immutable server settings`,
			);
		}
	});

	test("invalidates missing steady-window cpu, host cpu, and rss measurements", () => {
		const base = makeLeg();
		const missingServerCpu = {
			...makeLeg({ lane: "minimal-js-addon", orderIndex: 1 }),
			measurements: {
				...makeLeg().measurements,
				serverProcessCpu: { unit: "cpu-ms", value: null },
				clientProcessCpu: { unit: "cpu-ms", value: 42 },
				hostCpu: { unit: "host-cpu-pct", value: 18.5 },
				serverRss: { unit: "rss-mib", value: 128 },
				clientRss: { unit: "rss-mib", value: 64 },
				rawStages: {
					datagramFrameUnit: "quic-datagram-frames",
					udpDatagramUnit: "udp-datagrams",
					datagramFramesSent: 1500,
					datagramFramesReceived: 391,
					udpDatagramsSent: 1500,
					udpDatagramsReceived: 391,
					capturedBeforeTeardown: true,
				},
				window: {
					kind: "steady",
					startPhase: "steady",
					endPhase: "drain",
					wallMs: 120_000,
					synchronized: true,
				},
			},
		} as AttributionIdentityLeg;

		const verdict = validateAttributionIdentity([base, missingServerCpu]);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons).toContain(
			"minimal-js-addon required measurements missing serverProcessCpu",
		);
	});

	test("invalidates wrong measurement units and unsynchronized steady windows", () => {
		const base = makeLeg();
		const driftedWindow = {
			...makeLeg({ lane: "direct-rust", orderIndex: 1 }),
			measurements: {
				window: {
					kind: "steady",
					startPhase: "steady",
					endPhase: "idle",
					wallMs: 119_000,
					synchronized: false,
				},
				serverProcessCpu: { unit: "percent", value: 12 },
				clientProcessCpu: { unit: "cpu-ms", value: 42 },
				hostCpu: { unit: "host-cpu-pct", value: 18.5 },
				serverRss: { unit: "rss-bytes", value: 128 },
				clientRss: { unit: "rss-mib", value: 64 },
				rawStages: {
					datagramFrameUnit: "packets",
					udpDatagramUnit: "frames",
					datagramFramesSent: 1500,
					datagramFramesReceived: 391,
					udpDatagramsSent: 1500,
					udpDatagramsReceived: 391,
					capturedBeforeTeardown: false,
				},
			},
		} as unknown as AttributionIdentityLeg;

		const verdict = validateAttributionIdentity([base, driftedWindow]);
		expect(verdict.valid).toBe(false);
		expect(verdict.reasons).toContain(
			"direct-rust required measurements window was not synchronized to steady->drain",
		);
		expect(verdict.reasons).toContain(
			"direct-rust required measurements serverProcessCpu used percent instead of cpu-ms",
		);
		expect(verdict.reasons).toContain(
			"direct-rust required measurements serverRss used rss-bytes instead of rss-mib",
		);
		expect(verdict.reasons).toContain(
			"direct-rust required measurements rawStages.datagramFrameUnit used packets instead of quic-datagram-frames",
		);
		expect(verdict.reasons).toContain(
			"direct-rust required measurements rawStages.udpDatagramUnit used frames instead of udp-datagrams",
		);
		expect(verdict.reasons).toContain(
			"direct-rust required measurements rawStages were captured after teardown",
		);
	});
});

describe("outcome evaluation", () => {
	test("suppresses cpu attribution when fixed-offer target-shape throughput diverges", () => {
		const result = evaluateAttributionOutcome({
			identity: { valid: true, reasons: [] },
			legs: [
				makeLeg({ lane: "full-js", issuedRatio: 0.992 }),
				makeLeg({
					lane: "minimal-js-addon",
					orderIndex: 1,
					issuedRatio: 0.998,
				}),
				makeLeg({ lane: "direct-rust", orderIndex: 2, issuedRatio: 0.996 }),
			],
			commonThroughputReplay: null,
		});

		expect(result.valid).toBe(true);
		expect(result.cpuAttributionAllowed).toBe(false);
		expect(result.reasons).toContain(
			"pairwise issued parity diverged by 0.600% at target shape; retain capacity result but suppress CPU attribution until a common-throughput replay passes",
		);
	});

	test("reenables cpu attribution after a passing common-throughput replay", () => {
		const result = evaluateAttributionOutcome({
			identity: { valid: true, reasons: [] },
			legs: [
				makeLeg({ lane: "full-js", issuedRatio: 0.992 }),
				makeLeg({
					lane: "minimal-js-addon",
					orderIndex: 1,
					issuedRatio: 0.998,
				}),
				makeLeg({ lane: "direct-rust", orderIndex: 2, issuedRatio: 0.996 }),
			],
			commonThroughputReplay: {
				passed: true,
				issuedRatioFloor: 0.991,
				issuedRatioCeiling: 0.994,
			},
		});

		expect(result.valid).toBe(true);
		expect(result.cpuAttributionAllowed).toBe(true);
		expect(result.reasons).toEqual([]);
	});
});
