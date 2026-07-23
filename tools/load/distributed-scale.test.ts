import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	awaitWithTimeout,
	buildSourceIdentityProof,
	evaluateOverloadEvidence,
	evaluateSourceIdentityProof,
	evaluateWorkloadEvidence,
	runCommandWithBoundedOutput,
	type FinalGauges,
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
		expect(source).toContain("session.incomingDatagrams()");
		expect(source).toContain("await session.sendDatagram(data)");
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
