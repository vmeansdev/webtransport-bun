import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	awaitWithTimeout,
	buildFinalSampleOrdering,
	buildScaleArtifact,
	buildSourceIdentityProof,
	captureMemoryTelemetrySnapshot,
	evaluateOverloadEvidence,
	evaluateSourceIdentityProof,
	evaluateWorkloadEvidence,
	type FinalGauges,
	runCommandWithBoundedOutput,
	type ScaleCampaignConfig,
	validateScaleCampaignConfig,
} from "./distributed-scale.ts";

const TEMP_ROOTS: string[] = [];

afterEach(() => {
	for (const root of TEMP_ROOTS.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const ZERO_GAUGES: FinalGauges = {
	sessionsActive: 0,
	sessionTasksActive: 0,
	streamTasksActive: 0,
	handshakesInFlight: 0,
	streamsActive: 0,
	queuedBytesGlobal: 0,
	rateLimitedCount: 0,
	limitExceededCount: 0,
};

describe("Task 14 distributed scale evidence", () => {
	test("starts the child watchdog after the process spawn event", () => {
		const source = readFileSync(
			new URL("./distributed-scale.ts", import.meta.url),
			"utf8",
		);
		const helperStart = source.indexOf(
			"export async function runCommandWithBoundedOutput",
		);
		const helper = source.slice(helperStart);

		expect(helper).toContain('child.once("spawn"');
		expect(helper).toContain("setTimeout");
		expect(helper).toContain("outerTimeoutMs");
	});

	test("the live harness uses server observations and an explicit overload phase", () => {
		const source = readFileSync(
			new URL("./distributed-scale.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("serverObservedPeerIps.add(session.peer.ip)");
		expect(source).toContain("runOverloadPhase(");
		expect(source).toContain(
			"evaluateOverloadEvidence(overloadResult.evidence)",
		);
		expect(source).not.toMatch(
			/clientSummaries\.filter\([\s\S]*?sourceIdentityCount/,
		);
	});

	test("actively exercises server datagram and bidi/uni stream opens so server histograms are real", () => {
		const source = readFileSync(
			new URL("./distributed-scale.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain("createLoadSessionHandler");
		expect(source).toContain("onDatagramEcho");
		expect(source).toContain("await session.createBidirectionalStream()");
		expect(source).toContain("await session.createUnidirectionalStream()");
		expect(source).toContain("serverDatagramErrors");
		expect(source).toContain("serverStreamErrors");
	});

	test("counts identities only from server-observed peer addresses", () => {
		const proof = buildSourceIdentityProof([
			"127.0.0.1",
			"127.0.0.1",
			"10.20.30.40",
		]);

		expect(proof.kind).toBe("server-observed-peer-ip");
		expect(proof.identities).toEqual(["10.20.30.40", "127.0.0.1"]);
		expect(proof.prefixes).toEqual(["10.20.30.0/24", "127.0.0.0/24"]);
		expect(proof.sourceIdentityCount).toBe(2);
	});

	test("marks loopback-only diversity as requiring an external environment", () => {
		const proof = buildSourceIdentityProof(["127.0.0.1", "::1"]);
		const failures = evaluateSourceIdentityProof(proof, 2);

		expect(proof.environment).toBe("loopback-only");
		expect(failures).toContain(
			"server observed 2 loopback-only peer identities; external source addresses are required to prove source diversity",
		);
	});

	test("requires overload rejection counters and recovery to the steady baseline", () => {
		const steady = { ...ZERO_GAUGES, sessionsActive: 10 };
		const recovered = {
			...steady,
			limitExceededCount: 3,
		};
		const valid = {
			attemptedSessions: 3,
			acceptedSessions: 0,
			rejectedSessions: 3,
			limitExceededDelta: 3,
			rateLimitedDelta: 0,
			admissionShedCount: 3,
			steadyStateBeforeOverload: steady,
			postOverloadGauges: recovered,
			recoveryDurationMs: 10,
		};
		expect(evaluateOverloadEvidence(valid)).toEqual([]);
		expect(
			evaluateOverloadEvidence({
				...valid,
				steadyStateBeforeOverload: {
					...steady,
					streamsActive: 2,
					queuedBytesGlobal: 128,
				},
				postOverloadGauges: {
					...recovered,
					streamsActive: 0,
					queuedBytesGlobal: 8 * 1024 * 1024,
				},
			}),
		).toEqual([]);
		expect(
			evaluateOverloadEvidence({
				...valid,
				acceptedSessions: 1,
				rejectedSessions: 2,
			}),
		).toContain("overload phase admitted sessions beyond the configured cap");
		expect(
			evaluateOverloadEvidence({
				...valid,
				rejectedSessions: 0,
				limitExceededDelta: 0,
				admissionShedCount: 0,
				postOverloadGauges: {
					...recovered,
					sessionsActive: 11,
					streamTasksActive: 1,
					queuedBytesGlobal: 4,
				},
			}),
		).toEqual([
			"overload phase did not reject any admission",
			"overload phase produced no limit/rate admission-shed evidence",
			"overload phase did not recover to its steady-state gauge baseline",
		]);
	});

	test("rejects non-finite scale config values from env-derived input", () => {
		const failures = validateScaleCampaignConfig({
			...validConfig(),
			sessions: Number.NaN,
			maxRecoveryRssRatio: Number.POSITIVE_INFINITY,
		});

		expect(failures).toContain(
			"sessions must be a finite integer greater than 0",
		);
		expect(failures).toContain(
			"maxRecoveryRssRatio must be a finite number greater than 0",
		);
	});

	test("requires the workload to populate datagram and stream evidence before trusting p99s", () => {
		expect(
			evaluateWorkloadEvidence({
				datagramsPerSec: 10,
				streamsPerSec: 1,
				clientSummaries: [
					{
						clientIndex: 0,
						serverPort: 4433,
						requestedSessions: 1,
						okSessions: 1,
						sessionErrors: 0,
						datagramsSent: 0,
						datagramErrors: 0,
						streamsOpened: 0,
						streamErrors: 0,
						successRate: 1,
						exitCode: 0,
						exitSignal: null,
						timedOut: false,
						forceKilled: false,
						stdoutDrainTimedOut: false,
						stderrDrainTimedOut: false,
						durationMs: 1,
						stderr: "",
					},
				],
				serverDatagramSends: 0,
				serverBidiStreamsOpened: 0,
				serverUniStreamsOpened: 0,
				serverDatagramErrors: 0,
				serverStreamErrors: 0,
				p99HandshakeMs: 1,
				p99DatagramEnqueueMs: 1,
				p99StreamOpenMs: 1,
			}),
		).toEqual([
			"workload did not send any datagrams despite a positive datagram rate target",
			"server workload did not send any datagrams despite a positive datagram rate target",
			"workload did not open any streams despite a positive stream rate target",
			"server workload did not open any bidirectional streams despite a positive stream rate target",
			"server workload did not open any unidirectional streams despite a positive stream rate target",
		]);
	});

	test("bounds hung child and close waits with explicit timeouts", async () => {
		await expect(
			awaitWithTimeout("child.exited", new Promise<never>(() => {}), 10),
		).rejects.toThrow("child.exited timed out after 10ms");

		const source = readFileSync(
			new URL("./distributed-scale.ts", import.meta.url),
			"utf8",
		);
		expect(source).toContain('awaitWithTimeout("child.exited"');
		expect(source).toContain('awaitWithTimeout("server.close"');
	});

	test("captures memory telemetry fields in MB for warmed, loaded, and recovery snapshots", () => {
		expect(
			captureMemoryTelemetrySnapshot({
				rss: 96 * 1024 * 1024,
				heapTotal: 40 * 1024 * 1024,
				heapUsed: 24 * 1024 * 1024,
				external: 12 * 1024 * 1024,
				arrayBuffers: 8 * 1024 * 1024,
			}),
		).toEqual({
			rssMb: 96,
			heapTotalMb: 40,
			heapUsedMb: 24,
			externalMb: 12,
			arrayBuffersMb: 8,
		});
	});

	test("records final sample ordering around reference release and diagnostic GC", () => {
		expect(buildFinalSampleOrdering(false)).toEqual({
			stages: [
				"warmed-idle",
				"pre-close-loaded",
				"post-close-gauges",
				"references-released",
				"post-close-recovery",
			],
			diagnosticGcTriggered: false,
		});
		expect(buildFinalSampleOrdering(true)).toEqual({
			stages: [
				"warmed-idle",
				"pre-close-loaded",
				"post-close-gauges",
				"references-released",
				"diagnostic-gc",
				"post-close-recovery",
			],
			diagnosticGcTriggered: true,
		});
	});

	test("builds a scale artifact with telemetry embedded in the summary", () => {
		const telemetry = {
			warmedIdle: captureMemoryTelemetrySnapshot({
				rss: 48 * 1024 * 1024,
				heapTotal: 20 * 1024 * 1024,
				heapUsed: 12 * 1024 * 1024,
				external: 6 * 1024 * 1024,
				arrayBuffers: 3 * 1024 * 1024,
			}),
			preCloseLoaded: captureMemoryTelemetrySnapshot({
				rss: 450 * 1024 * 1024,
				heapTotal: 50 * 1024 * 1024,
				heapUsed: 25 * 1024 * 1024,
				external: 7 * 1024 * 1024,
				arrayBuffers: 4 * 1024 * 1024,
			}),
			postCloseRecovery: captureMemoryTelemetrySnapshot({
				rss: 451 * 1024 * 1024,
				heapTotal: 49 * 1024 * 1024,
				heapUsed: 24 * 1024 * 1024,
				external: 6 * 1024 * 1024,
				arrayBuffers: 3 * 1024 * 1024,
			}),
			finalSampleOrdering: buildFinalSampleOrdering(true),
			inProcessRssRecovery: {
				authoritative: false as const,
				status: "fail" as const,
				initialRssMb: 48,
				loadedRssMb: 450,
				finalRssMb: 451,
				ratio: 9.396,
				thresholdRatio: 1.25,
			},
		};
		const artifact = buildScaleArtifact(
			validConfig(),
			{
				label: "scale",
				sessions: 4,
				durationSec: 2,
				serverCount: 1,
				clientCount: 1,
				totalRequestedSessions: 4,
				totalOkSessions: 4,
				globalSuccessRate: 1,
				fairnessGap: 0,
				peakLiveSessions: 4,
				peakStreams: 2,
				peakQueuedBytesGlobal: 0,
				peakRssMb: 450,
				finalRssMb: 451,
				serverDatagramSends: 4,
				serverBidiStreamsOpened: 1,
				serverUniStreamsOpened: 1,
				serverDatagramErrors: 0,
				serverStreamErrors: 0,
				sourceIdentityCount: 1,
				sourcePrefixCount: 1,
				sourceIdentityProof: buildSourceIdentityProof(["127.0.0.1"]),
				liveSetHeldMs: 1000,
				admissionShedCount: 1,
				overloadEvidence: {
					attemptedSessions: 1,
					acceptedSessions: 0,
					rejectedSessions: 1,
					limitExceededDelta: 1,
					rateLimitedDelta: 0,
					admissionShedCount: 1,
					steadyStateBeforeOverload: ZERO_GAUGES,
					postOverloadGauges: ZERO_GAUGES,
					recoveryDurationMs: 1,
				},
				overloadClientSummaries: [],
				closeDurationMs: 1,
				finalGauges: ZERO_GAUGES,
				memoryTelemetry: telemetry,
				p99HandshakeMs: 1,
				p99DatagramEnqueueMs: 1,
				p99StreamOpenMs: 1,
				clientSummaries: [],
				failures: [],
			} as any,
			"2026-08-01T00:00:00.000Z",
			"1.3.14",
			"rustc 1.90.0",
		);

		expect(artifact.summary.memoryTelemetry).toEqual(telemetry);
		expect(artifact.createdAt).toBe("2026-08-01T00:00:00.000Z");
		expect(artifact.bunVersion).toBe("1.3.14");
		expect(artifact.rustcVersion).toBe("rustc 1.90.0");
	});

	test("terminates descendant-held pipes and records timeout and drain metadata", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "wt-distributed-scale-"));
		TEMP_ROOTS.push(tempRoot);
		const fixturePath = join(tempRoot, "held-pipe-fixture.mjs");
		writeFileSync(
			fixturePath,
			`
import { spawn } from "node:child_process";

if (process.argv[2] === "grandchild") {
	process.stdout.write("grandchild stdout\\n");
	process.stderr.write("grandchild stderr\\n");
	setInterval(() => {}, 1_000);
} else {
	const grandchild = spawn(process.execPath, [process.argv[1], "grandchild"], {
		detached: process.platform !== "win32",
		stdio: "inherit",
	});
	grandchild.unref();
	process.stdout.write("sessions ok=0 err=1\\n");
	process.stderr.write("parent exiting\\n");
}
`,
			"utf8",
		);

		const result = await runCommandWithBoundedOutput(
			[process.execPath, fixturePath],
			{
				cwd: tempRoot,
				outerTimeoutMs: 200,
				terminateGraceMs: 75,
				drainTimeoutMs: 75,
			},
		);

		expect(result.stdout).toContain("sessions ok=0 err=1");
		expect(result.stderr).toContain("parent exiting");
		expect(result.timedOut).toBe(true);
		expect(result.forceKilled).toBe(true);
		expect(result.stdoutDrainTimedOut || result.stderrDrainTimedOut).toBe(true);
	});
});

function validConfig(): ScaleCampaignConfig {
	return {
		label: "scale",
		sessions: 4,
		durationSec: 2,
		serverCount: 1,
		clientCount: 1,
		basePort: 4433,
		datagramsPerSec: 10,
		streamsPerSec: 1,
		minSuccessRate: 1,
		maxRssMb: 256,
		maxRecoveryRssRatio: 1.25,
		maxFairnessGap: 0.1,
		p99HandshakeMs: 100,
		p99DatagramEnqueueMs: 10,
		p99StreamOpenMs: 20,
		minLiveSessions: 1,
		minLiveSetHoldMs: 10,
		minSourceIdentityCount: 1,
		overloadSessionsPerServer: 1,
		overloadRecoveryTimeoutMs: 1000,
		artifactPath: "/tmp/distributed-scale.json",
		clientTargetHost: "127.0.0.1",
		clientLaunches: [
			{
				label: "default",
				commandPrefix: [],
			},
		],
	};
}
