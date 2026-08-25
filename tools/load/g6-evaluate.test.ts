import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { evaluateG6, type G6EvaluationRequest } from "./g6-evaluate.ts";
import { exactStaggeredWindowDue } from "./g6-plan.ts";
import {
	armShape,
	G6_CLOSEOUT_SPEC_ID,
	G6_CLOSEOUT_SPEC_PATH,
	preflightRequirements,
} from "./g6-plan.ts";
import {
	LatencyHistogram,
	type LatencyHistogramJson,
} from "./latency-histogram.ts";

const CANDIDATE = "a".repeat(40);
const PREREG_SHA = "b".repeat(64);
const GRADER_SHA = "c".repeat(40);
const GENERATOR_HOST = "macgen";
const STARTED_AT = "2026-08-24T08:00:00.000Z";
const STEADY_SECONDS = 120;

// biome-ignore lint/suspicious/noExplicitAny: compact fixture builders need ergonomic mutable JSON trees
type Json = Record<string, any>;

function histogram(
	valueNs: number,
	count: number,
	over: Partial<LatencyHistogramJson> = {},
): LatencyHistogramJson {
	const h = new LatencyHistogram();
	if (count > 0) h.record(valueNs);
	const json = h.toJson();
	if (count > 0 && json.buckets[0]) json.buckets[0][1] = count;
	return {
		...json,
		count,
		recordedTotal: count,
		minNs: count > 0 ? valueNs : 0,
		maxNs: count > 0 ? valueNs : 0,
		sumNs: count * valueNs,
		...over,
	};
}

function emptyWindow(): Json {
	return {
		sent: 0,
		sendErr: 0,
		scheduleTicksDue: 0,
		scheduleTicksFired: 0,
		scheduleTicksSkipped: 0,
		scheduleTicksUnpresented: 0,
		scheduleTicksReconciled: true,
		rxSnapshot: 0,
		rxAck: 0,
		rxRaid: 0,
		rxOther: 0,
		rxUnstamped: 0,
		ackUnreflected: 0,
		sessionsLost: 0,
		scheduleLag: histogram(0, 0),
		rtt: histogram(0, 0),
		oneWay: histogram(0, 0),
		serverHold: histogram(0, 0),
	};
}

function sendWindow(sent: number, lagNs = 1_000_000): Json {
	return {
		...emptyWindow(),
		sent,
		scheduleTicksDue: sent,
		scheduleTicksFired: sent,
		scheduleLag: histogram(lagNs, sent),
	};
}

function receiveWindow(input: {
	rxSnapshot?: number;
	rxAck?: number;
	rxRaid?: number;
	rttNs?: number;
	oneWayNs?: number;
}): Json {
	const rxSnapshot = input.rxSnapshot ?? 0;
	const rxAck = input.rxAck ?? 0;
	const rxRaid = input.rxRaid ?? 0;
	return {
		...emptyWindow(),
		rxSnapshot,
		rxAck,
		rxRaid,
		rtt: histogram(input.rttNs ?? 12_000_000, rxAck),
		oneWay: histogram(input.oneWayNs ?? 9_000_000, rxRaid),
		serverHold: histogram(500_000, rxAck),
	};
}

function preregistration(): Json {
	return {
		id: G6_CLOSEOUT_SPEC_ID,
		path: G6_CLOSEOUT_SPEC_PATH,
		sha256: PREREG_SHA,
	};
}

function report(input: {
	role?: string;
	sessions: number;
	steady?: Json;
	steadyDrain?: Json;
	stormSurvivors?: Json;
	storm?: Json;
	phaseBarrier?: Json | null;
	steadySeconds?: number;
}): Json {
	return {
		schema: "mmo-client/2",
		startedAt: STARTED_AT,
		preRegistration: preregistration(),
		role: input.role ?? "realm",
		staggerSends: true,
		sessionsRequested: input.sessions,
		sessionsOk: input.sessions,
		sessionsErr: 0,
		sessionsLost: 0,
		connectWallSec: 1,
		connectTimedOut: false,
		connectConcurrency: 500,
		acceptMs: { p50: 2, p90: 3, p99: 4, max: 5 },
		storm:
			input.storm ??
			({
				concurrency: null,
				cohort: 0,
				ran: false,
				windowSec: 120,
				reconnectOk: 0,
				reconnectErr: 0,
				reconnectTotalMs: 0,
				reconnectMeanMs: null,
				reconnectMs: { p50: null, p90: null, p99: null, max: null },
			} as Json),
		phaseBarrier: input.phaseBarrier ?? null,
		windows: {
			steady: input.steady ?? emptyWindow(),
			steadyDrain: input.steadyDrain ?? emptyWindow(),
			stormSurvivors: input.stormSurvivors ?? emptyWindow(),
		},
		lifetime: emptyWindow(),
		quicDrive: {
			connections: input.sessions,
			frameTxDatagram: input.steady?.sent ?? 0,
			frameRxDatagram: 0,
			sentPackets: 1,
			lostPackets: 0,
		},
		client: {
			rssMbDrive: 10,
			rssMbIdle: 10,
			cpuMsConnect: 1,
			cpuMsDrive: 1,
			cpuMsIdle: 1,
			endpoints: 1,
			distinctSourceIps: 1,
		},
		config: {
			sendIntervalMs: input.role === "publisher" ? 50 : 250,
			actionEvery: 8,
			payloadBytes: 64,
			steadySec: input.steadySeconds ?? STEADY_SECONDS,
			drainMs: 1000,
			stormWindowSec: 120,
			postStormSec: 60,
			idleSec: 30,
		},
		connectErrorsSample: [],
	};
}

function emitter(sessions: number): Json {
	const snapshots = sessions * 15 * STEADY_SECONDS;
	const acks = sessions * 0.5 * STEADY_SECONDS;
	return {
		snapshotDue: snapshots,
		snapshotIssued: snapshots,
		ackDue: acks,
		ackIssued: acks,
		raidForwarded: 0,
		sendErrors: 0,
		sendEventsSkipped: 0,
		batchPartialCompletions: 0,
	};
}

function provenance(): string[] {
	return [
		`macgen: host=${GENERATOR_HOST} arch=arm64 os=Darwin`,
		`macgen: clone=/tmp/g6 candidate=${CANDIDATE}`,
		`macgen: head=${CANDIDATE} dirty=no build=ok buildSec=1`,
		`macgen: binary=/tmp/mmo-client sha256=${"d".repeat(64)}`,
		"macgen: exit=0",
	];
}

function rawReports(realm: Json): Json {
	return {
		realm,
		realmProvenance: provenance(),
		realmStderr: [],
		realmExitCode: 0,
		subscriber: null,
		subscriberProvenance: [],
		subscriberStderr: [],
		subscriberExitCode: null,
		publisher: null,
		publisherProvenance: [],
		publisherStderr: [],
		publisherExitCode: null,
	};
}

function steadyArm(sessions: number): Json {
	const upstream = exactStaggeredWindowDue({
		durationSec: STEADY_SECONDS,
		intervalSec: 0.25,
		totalSessions: sessions,
		startIndex: 0,
		count: sessions,
	});
	const snapshots = sessions * 15 * STEADY_SECONDS;
	const acks = sessions * 0.5 * STEADY_SECONDS;
	const steady = sendWindow(upstream);
	const steadyDrain = receiveWindow({ rxSnapshot: snapshots, rxAck: acks });
	const realm = report({ sessions, steady, steadyDrain });
	const emit = emitter(sessions);
	return {
		arm: `steady-${sessions}`,
		sessions,
		shape: armShape(sessions),
		degraded: [],
		clockSource: "ffi",
		windows: {
			steady: {
				serverUpstream: { rxTotal: upstream, rxSurvivors: 0 },
				emitter: emit,
				client: steady,
			},
			steadyDrain: {
				serverUpstream: { rxTotal: upstream, rxSurvivors: 0 },
				emitter: emit,
				client: steadyDrain,
			},
			storm: null,
			lifetime: {
				serverUpstream: { rxTotal: upstream, rxSurvivors: 0 },
				emitter: emit,
				client: { ...steadyDrain, sent: upstream },
			},
		},
		hotspot: null,
		phaseBarrier: null,
		storm: null,
		stageWindows: {
			steady: {
				clientEnqueued: upstream,
				clientWireTx: upstream,
				kernelDropsSocket: 0,
				kernelRcvbufErrors: 0,
				serverObserved: upstream,
				jsDelivered: upstream,
				nativeDropped: 0,
				nativeSkippedQueueFull: 0,
			},
			steadyDrain: {
				clientReceived: snapshots + acks,
				serverIssued: snapshots + acks,
				kernelDropsSocket: 0,
				kernelRcvbufErrors: 0,
				serverObserved: upstream,
				jsDelivered: upstream,
				nativeDropped: 0,
				nativeSkippedQueueFull: 0,
			},
		},
		cpuWindows: {
			steady: { serverPct: 50, hostPctMedian: 10, sessionsActiveMax: sessions },
			steadyDrain: { serverPct: 50, sessionsActiveEnd: sessions },
		},
		rawReports: rawReports(realm),
	};
}

function barrier(role: string, steadyEnterMonotonicNs: number): Json {
	return {
		id: "g6-hotspot-barrier",
		parties: 3,
		role,
		readyUnixMs: 1,
		readyMonotonicNs: 1_000_000,
		releaseUnixMs: 2,
		releaseMonotonicNs: 2_000_000,
		steadyEnterUnixMs: 3,
		steadyEnterMonotonicNs,
	};
}

function hotspotArm(): Json {
	const arm = steadyArm(5000);
	const publisherSent = 20 * STEADY_SECONDS;
	const subscriberReceived = publisherSent * 40;
	arm.arm = "hotspot-5000";
	arm.windows.steady.serverUpstream.rxTotal += publisherSent;
	arm.windows.steadyDrain.serverUpstream.rxTotal += publisherSent;
	arm.hotspot = {
		subscribers: 40,
		ingested: publisherSent,
		publisherStamped: publisherSent,
		forwarded: subscriberReceived,
		subscriberReceived,
		publisherSent,
		oneWay: histogram(9_000_000, subscriberReceived),
		serverForwardDwell: histogram(500_000, publisherSent),
		frameGapFraction: 1,
	};
	arm.phaseBarrier = {
		id: "g6-hotspot-barrier",
		parties: 3,
		roles: ["publisher", "raid-subscriber", "realm"],
		readySkewMs: 2,
		releaseSkewMs: 0,
		steadyEnterSkewMs: 2,
	};
	arm.cpuWindows.steadyDrain.sessionsActiveEnd = 5041;
	arm.rawReports.realm.phaseBarrier = barrier("realm", 3_000_000);
	arm.rawReports.subscriber = report({
		role: "raid-subscriber",
		sessions: 40,
		steadyDrain: receiveWindow({
			rxRaid: subscriberReceived,
			oneWayNs: 9_000_000,
		}),
		phaseBarrier: barrier("raid-subscriber", 4_000_000),
	});
	arm.rawReports.subscriberProvenance = provenance();
	arm.rawReports.subscriberExitCode = 0;
	arm.rawReports.publisher = report({
		role: "publisher",
		sessions: 1,
		steady: sendWindow(publisherSent),
		phaseBarrier: barrier("publisher", 5_000_000),
	});
	arm.rawReports.publisherProvenance = provenance();
	arm.rawReports.publisherExitCode = 0;
	return arm;
}

function stormArm(cohort: number): Json {
	const arm = steadyArm(5000);
	const survivors = 5000 - cohort;
	const survivorSent = exactStaggeredWindowDue({
		durationSec: 120,
		intervalSec: 0.25,
		totalSessions: 5000,
		startIndex: cohort,
		count: survivors,
	});
	const survivorAcks = survivors * 0.5 * 120;
	const survivorSnapshots = survivors * 15 * 120;
	const survivorWindow = {
		...sendWindow(survivorSent),
		...receiveWindow({
			rxSnapshot: survivorSnapshots,
			rxAck: survivorAcks,
		}),
		sent: survivorSent,
		scheduleTicksDue: survivorSent,
		scheduleTicksFired: survivorSent,
		scheduleLag: histogram(1_000_000, survivorSent),
	};
	arm.arm = `storm-${cohort}`;
	arm.rawReports.realm = report({
		sessions: 5000,
		steady: arm.rawReports.realm.windows.steady,
		steadyDrain: arm.rawReports.realm.windows.steadyDrain,
		stormSurvivors: survivorWindow,
		storm: {
			concurrency: null,
			cohort,
			ran: true,
			windowSec: 120,
			reconnectOk: cohort,
			reconnectErr: 0,
			reconnectTotalMs: cohort * 50,
			reconnectMeanMs: 50,
			reconnectMs: { p50: 50, p90: 50, p99: 50, max: 50 },
		},
	});
	arm.windows.storm = {
		serverUpstream: {
			rxTotal: survivorSent,
			rxSurvivors: survivorSent,
		},
		emitter: emitter(5000),
		client: survivorWindow,
	};
	arm.storm = {
		cohort,
		severAtMs: 1_000,
		acceptSeries: [{ tMs: 2_000, accepts: cohort }],
		reAcceptedInWindow: cohort,
		sessionsActiveAtWindowClose: 5000,
		limitExceededDelta: 0,
		rateLimitedDelta: 0,
		handshakesInFlightAtClose: 0,
		sessionsClosedByIdleDelta: 0,
		sessionsClosedOtherDelta: 0,
		kernelStorm: { serverSocketDrops: 0, RcvbufErrors: 0 },
	};
	return arm;
}

function cleanArtifact(): Json {
	return {
		version: 2,
		schema: "bench-g6/2",
		preRegistration: preregistration(),
		startedAt: STARTED_AT,
		writtenAt: "2026-08-24T09:00:00.000Z",
		complete: true,
		host: {
			identity: "runner",
			platform: "linux",
			cpus: 16,
			bunVersion: "1.3.14",
			offboxSsh: GENERATOR_HOST,
		},
		source: { candidateSha: CANDIDATE, dirty: false, coResident: false },
		config: {
			ladder: [500, 2500, 5000],
			arms: ["steady", "hotspot", "storm"],
			movePps: 4,
			actionPps: 0.5,
			actionEvery: 8,
			upstreamPayloadBytes: 64,
			snapshotHz: 5,
			snapshotDatagrams: 3,
			snapshotPayloadBytes: 1150,
			emitterSliceHz: 50,
			raidMembers: 40,
			raidPublisherHz: 20,
			steadySeconds: STEADY_SECONDS,
			drainGraceMs: 1000,
			idleSeconds: 30,
			stormWindowSec: 120,
			stormCohorts: [1000, 5000],
			stormReconnectDelayMs: 1000,
			datagramSendSync: null,
		},
		preflightRequirements: preflightRequirements(),
		arms: [
			steadyArm(500),
			steadyArm(2500),
			steadyArm(5000),
			hotspotArm(),
			stormArm(1000),
			stormArm(5000),
		],
		aborted: null,
	};
}

function preflight(payloadBytes: number, deliveredPps: number): Json {
	return {
		schemaVersion: 2,
		startedAt: STARTED_AT,
		generator: {
			hostname: GENERATOR_HOST,
			platform: "darwin",
			arch: "arm64",
			cpus: 10,
			memoryBytes: 64 * 1024 ** 3,
		},
		link: {
			localAddress: "10.99.0.1",
			peerAddress: "10.99.0.2",
			subnet: "10.99.0.0/24",
			interfaceName: "en7",
			mtuBytes: 1500,
			mtuProbePayloadBytes: 1472,
		},
		guards: [{ name: "peer-on-cable", ok: true, detail: "ok" }],
		rtt: {
			samples: 100,
			transmitted: 100,
			received: 100,
			lossPct: 0,
			p50Ms: 0.2,
			p99Ms: 0.5,
			maxMs: 1,
		},
		tcp: null,
		udpRungs: [
			{
				offeredBitsPerSec: deliveredPps * payloadBytes * 8,
				payloadBytes,
				sentPackets: deliveredPps * 10,
				receivedPackets: deliveredPps * 10,
				lostPackets: 0,
				lossPct: 0,
				jitterMs: 0.1,
				seconds: 10,
				deliveredPps,
				offeredPps: deliveredPps,
			},
		],
		ceiling: null,
		registeredProperties: {
			mtuBytes: 1500,
			idleRttP50Ms: 0.2,
			idleRttP99Ms: 0.5,
			cleanPpsCeiling: deliveredPps,
			lossBoundPct: 0.1,
			payloadBytes,
		},
		notes: [],
	};
}

function floorTranscript(
	input: {
		sessions?: number;
		sessionsOk?: number;
		negative?: number;
		startedAt?: string;
		host?: string;
	} = {},
): string {
	const sessions = input.sessions ?? 20;
	const fired = exactStaggeredWindowDue({
		durationSec: 5,
		intervalSec: 0.25,
		totalSessions: sessions,
		startIndex: 0,
		count: sessions,
	});
	const floor = report({
		sessions,
		steadySeconds: 5,
		steady: sendWindow(fired),
	});
	floor.startedAt = input.startedAt ?? STARTED_AT;
	floor.sessionsOk = input.sessionsOk ?? sessions;
	floor.windows.steady.scheduleLag.negative = input.negative ?? 0;
	return [
		`macgen: host=${input.host ?? GENERATOR_HOST} arch=arm64 os=Darwin`,
		`macgen: clone=/tmp/g6 candidate=${CANDIDATE}`,
		`macgen: head=${CANDIDATE} dirty=no build=ok buildSec=1`,
		`macgen: binary=/tmp/mmo-client sha256=${"d".repeat(64)}`,
		`mmo-client: json ${JSON.stringify(floor)}`,
		"macgen: exit=0",
	].join("\n");
}

function sink(): Json {
	return {
		kind: "g6-sink-precheck",
		host: GENERATOR_HOST,
		dateIso: STARTED_AT,
		payloadBytes: 200,
		armDownstreamPps: 77_500,
		headroomFactor: 1.5,
		requiredPps: 116_250,
		targetPps: 120_000,
		targetBps: 192_000_000,
		saturationBoundaryPps: 117_600,
		precheckOfferedPps: 120_000,
		precheckDeliveryRatio: 1,
		precheckOriginatorSaturated: false,
		sentPackets: 3_600_000,
		lostPackets: 0,
		jitterMs: 0.1,
		seconds: 30,
		rawEndSum: {},
	};
}

function request(over: Partial<G6EvaluationRequest> = {}): G6EvaluationRequest {
	return {
		artifact: cleanArtifact(),
		artifactCsvPresent: true,
		preflightDown: preflight(1150, 80_000),
		preflightUp: preflight(64, 25_000),
		floorTranscript: floorTranscript(),
		sink: sink(),
		expectedCandidate: CANDIDATE,
		expectedGeneratorHost: GENERATOR_HOST,
		expectedPreregistrationSha256: PREREG_SHA,
		trackedPreregistrationSha256: PREREG_SHA,
		graderSha: GRADER_SHA,
		inputSha256: {
			artifactJson: "1".repeat(64),
			artifactCsv: "2".repeat(64),
			preflightDown: "3".repeat(64),
			preflightUp: "4".repeat(64),
			floor: "5".repeat(64),
			sink: "6".repeat(64),
		},
		...over,
	};
}

function sha256(value: string | Uint8Array): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(value);
	return hasher.digest("hex");
}

describe("g6-classified/2 evaluator", () => {
	test("recomputes a clean six-arm successor artifact as PASS", () => {
		const fixture = JSON.parse(
			readFileSync(
				resolve(import.meta.dir, "fixtures/g6/clean-successor.json"),
				"utf8",
			),
		) as Json;
		const result = evaluateG6(request());
		expect(result.schema).toBe("g6-classified/2");
		expect(result.final).toEqual({
			valid: fixture.expected.valid,
			gate: fixture.expected.gate,
		});
		expect(result.preRegistration.sha256).toBe(PREREG_SHA);
		expect(result.source).toEqual({
			candidateSha: CANDIDATE,
			graderSha: GRADER_SHA,
			generatorHost: GENERATOR_HOST,
		});
		expect(result.publication.steadyRungs).toHaveLength(
			fixture.expected.steadyRungs,
		);
		expect(result.clauses.map((clause) => clause.id)).toEqual(
			fixture.expected.clauseIds,
		);
	});

	test("counted mid-steady session losses keep the run valid within the derived due band", () => {
		const input = request();
		const steady = (input.artifact as Json).arms[0].rawReports.realm.windows
			.steady;
		// Two sessions died mid-steady: their forfeited due is bounded by two
		// full windows (2 × (4 × 120 + 1) = 962 ticks); 400 is well inside.
		const forfeit = 400;
		steady.scheduleTicksDue -= forfeit;
		steady.scheduleTicksFired -= forfeit;
		steady.sent -= forfeit;
		steady.sessionsLost = 2;
		steady.scheduleLag = histogram(1_000_000, steady.scheduleTicksFired);

		const result = evaluateG6(input);
		expect(
			result.invalidReasons.filter((reason) => reason.includes("schedule due")),
		).toEqual([]);
		expect(result.final.valid).toBe(true);
	});

	test("a due shortfall beyond the counted losses is refused", () => {
		const input = request();
		const steady = (input.artifact as Json).arms[0].rawReports.realm.windows
			.steady;
		// The same shortfall with zero counted losses has no derivation: the
		// generator under-drove without a matching loss ledger.
		const forfeit = 400;
		steady.scheduleTicksDue -= forfeit;
		steady.scheduleTicksFired -= forfeit;
		steady.sent -= forfeit;
		steady.scheduleLag = histogram(1_000_000, steady.scheduleTicksFired);

		const result = evaluateG6(input);
		expect(result.final.gate).toBe("INVALID");
		expect(result.invalidReasons.join(" ")).toContain("counted losses");
	});

	test("a due count above the registered demand is refused", () => {
		const input = request();
		const steady = (input.artifact as Json).arms[0].rawReports.realm.windows
			.steady;
		steady.scheduleTicksDue += 1;
		steady.scheduleTicksUnpresented = 1;

		const result = evaluateG6(input);
		expect(result.final.gate).toBe("INVALID");
		expect(result.invalidReasons.join(" ")).toContain("exceeds registered");
	});

	test("a receipt-bound ack shortfall is not a validity refusal, but an excess is", () => {
		const short = request();
		for (const window of ["steady", "steadyDrain", "lifetime"]) {
			const emitter = (short.artifact as Json).arms[0].windows[window].emitter;
			// The server only ingested a bit over half the planned actions;
			// its ack ledger stays honest against what it actually received.
			emitter.ackDue = Math.round(emitter.ackDue * 0.55);
			emitter.ackIssued = emitter.ackDue;
		}
		const shortResult = evaluateG6(short);
		expect(
			shortResult.invalidReasons.filter((reason) => reason.includes("ack due")),
		).toEqual([]);
		expect(shortResult.final.valid).toBe(true);

		const excess = request();
		const emitter = (excess.artifact as Json).arms[0].windows.steadyDrain
			.emitter;
		emitter.ackDue += 1;
		const excessResult = evaluateG6(excess);
		expect(excessResult.final.gate).toBe("INVALID");
		expect(excessResult.invalidReasons.join(" ")).toContain("ack due");
	});

	test("the measured 5000-rung saturation profile grades as a valid MISS, never INVALID", () => {
		// The license-protecting property, encoded from attribution run
		// 32840857971's measured shape: offered ~0.999, server ingest ~54%,
		// snapshots issued ~88%, acks receipt-bound at ~55%, and a few dozen
		// counted mid-steady session losses. The gate must grade this as its
		// registered overload outcome — clauses MISS — with validity intact.
		const input = request();
		const arm = (input.artifact as Json).arms[2]; // steady-5000
		const steady = arm.rawReports.realm.windows.steady;
		const forfeit = 400;
		steady.scheduleTicksDue -= forfeit;
		steady.scheduleTicksFired -= forfeit;
		steady.sent -= forfeit;
		steady.sessionsLost = 24;
		steady.scheduleLag = histogram(1_000_000, steady.scheduleTicksFired);
		const ingested = Math.round(steady.sent * 0.54);
		for (const window of ["steady", "steadyDrain", "lifetime"]) {
			arm.windows[window].serverUpstream.rxTotal = ingested;
			const emitter = arm.windows[window].emitter;
			emitter.ackDue = Math.round(emitter.ackDue * 0.55);
			emitter.ackIssued = emitter.ackDue;
			emitter.snapshotIssued = Math.round(emitter.snapshotDue * 0.88);
		}
		arm.stageWindows.steady.clientEnqueued = steady.sent;
		arm.stageWindows.steady.clientWireTx = steady.sent;
		arm.stageWindows.steady.serverObserved = ingested;
		arm.stageWindows.steady.jsDelivered = ingested;

		const result = evaluateG6(input);
		expect(result.invalidReasons).toEqual([]);
		expect(result.final.valid).toBe(true);
		expect(result.final.gate).toBe("MISS");
	});

	test("uses the subscriber raw one-way histogram, never the clean artifact summary", () => {
		const input = request();
		const hotspot = (input.artifact as Json).arms[3];
		hotspot.hotspot.oneWay.negative = 0;
		hotspot.rawReports.subscriber.windows.steadyDrain.oneWay.negative = 1;

		const result = evaluateG6(input);
		expect(result.final.gate).toBe("INVALID");
		expect(result.invalidReasons.join(" ")).toContain(
			"V-N hotspot-5000/oneWay",
		);
	});

	test("never substitutes lifetime ack totals for the steady RTT denominator", () => {
		const lifetimeOnly = request();
		(lifetimeOnly.artifact as Json).arms[2].rawReports.realm.lifetime.rtt =
			histogram(12_000_000, 1, { negative: 7 });
		expect(evaluateG6(lifetimeOnly).final.gate).toBe("PASS");

		const steadyMismatch = request();
		const rtt = (steadyMismatch.artifact as Json).arms[2].rawReports.realm
			.windows.steadyDrain.rtt;
		rtt.buckets[0][1] -= 1;
		rtt.count -= 1;
		rtt.recordedTotal -= 1;
		expect(evaluateG6(steadyMismatch).invalidReasons.join(" ")).toContain(
			"V-D steady-5000/rtt",
		);
	});

	test("rejects the wrong floor arm and a negative floor schedule sample", () => {
		const wrongArm = evaluateG6(
			request({ floorTranscript: floorTranscript({ sessions: 500 }) }),
		);
		expect(wrongArm.final.gate).toBe("INVALID");
		expect(wrongArm.invalidReasons.join(" ")).toContain(
			"floor sessionsRequested 500, expected 20",
		);

		const negative = evaluateG6(
			request({ floorTranscript: floorTranscript({ negative: 1 }) }),
		);
		expect(negative.final.gate).toBe("INVALID");
		expect(negative.invalidReasons.join(" ")).toContain(
			"V-N floor/scheduleLag",
		);
	});

	test("uses raw bucket totals and ignores advisory artifact histograms", () => {
		const advisoryOnly = request();
		(advisoryOnly.artifact as Json).arms[3].hotspot.oneWay.negative = 9;
		expect(evaluateG6(advisoryOnly).final.gate).toBe("PASS");

		const declaredMismatch = request();
		const declared = (declaredMismatch.artifact as Json).arms[0].rawReports
			.realm.windows.steadyDrain.rtt;
		declared.count -= 1;
		expect(evaluateG6(declaredMismatch).invalidReasons.join(" ")).toContain(
			"V-K steady-500/rtt: raw bucket total",
		);

		const recordingRace = request();
		const raced = (recordingRace.artifact as Json).arms[1].rawReports.realm
			.windows.steadyDrain.rtt;
		raced.recordedTotal += Math.ceil(raced.count * 0.002);
		expect(evaluateG6(recordingRace).invalidReasons.join(" ")).toContain(
			"V-K steady-2500/rtt: recordedTotal",
		);
	});

	test("accepts per-arm start instants while binding concurrent hotspot roles", () => {
		const perArm = request();
		for (const [index, arm] of (perArm.artifact as Json).arms.entries()) {
			const armStartedAt = `2026-08-24T08:${String(index + 1).padStart(2, "0")}:00.000Z`;
			arm.rawReports.realm.startedAt = armStartedAt;
			if (arm.rawReports.subscriber) {
				arm.rawReports.subscriber.startedAt = armStartedAt;
			}
			if (arm.rawReports.publisher) {
				arm.rawReports.publisher.startedAt = armStartedAt;
			}
		}
		expect(evaluateG6(perArm).final).toEqual({ valid: true, gate: "PASS" });

		const splitHotspot = request();
		(splitHotspot.artifact as Json).arms[3].rawReports.publisher.startedAt =
			"2026-08-24T08:59:00.000Z";
		expect(evaluateG6(splitHotspot).invalidReasons.join(" ")).toContain(
			"hotspot role startedAt values did not agree",
		);
	});

	test("requires the floor on the same generator host and day with driving sessions", () => {
		const wrongDay = evaluateG6(
			request({
				floorTranscript: floorTranscript({
					startedAt: "2026-08-25T08:00:00.000Z",
				}),
			}),
		);
		expect(wrongDay.invalidReasons.join(" ")).toContain("same-day rule");

		const wrongHost = evaluateG6(
			request({ floorTranscript: floorTranscript({ host: "other-mac" }) }),
		);
		expect(wrongHost.invalidReasons.join(" ")).toContain(
			"floor came from other-mac",
		);

		const zeroDriving = evaluateG6(
			request({ floorTranscript: floorTranscript({ sessionsOk: 0 }) }),
		);
		expect(zeroDriving.invalidReasons.join(" ")).toContain(
			"no session offered load",
		);

		const partial = evaluateG6(
			request({ floorTranscript: floorTranscript({ sessionsOk: 19 }) }),
		);
		expect(partial.invalidReasons.join(" ")).toContain(
			"floor sessionsOk 19, expected 20",
		);
	});

	test("requires both independently passing cable preflights", () => {
		const missingDown = evaluateG6(request({ preflightDown: null }));
		expect(missingDown.final.gate).toBe("INVALID");
		expect(missingDown.invalidReasons.join(" ")).toContain("V-C R-down");

		const failedUp = evaluateG6(
			request({ preflightUp: preflight(64, 10_000) }),
		);
		expect(failedUp.final.gate).toBe("INVALID");
		expect(failedUp.invalidReasons.join(" ")).toContain(
			"V-C R-up: link carries 10000 pps",
		);
	});

	test("recomputes sink rate, loss, and source saturation from raw counters", () => {
		const underRateInput = sink();
		underRateInput.sentPackets = 3_000_000;
		const underRate = evaluateG6(request({ sink: underRateInput }));
		expect(underRate.invalidReasons.join(" ")).toContain(
			"V-S: pre-check drove 100000 pps",
		);

		const lossyInput = sink();
		lossyInput.lostPackets = 36_000;
		const lossy = evaluateG6(request({ sink: lossyInput }));
		expect(lossy.invalidReasons.join(" ")).toContain(
			"V-S: pre-check delivery 0.99000",
		);

		const saturatedInput = sink();
		saturatedInput.sentPackets = 3_300_000;
		const saturated = evaluateG6(request({ sink: saturatedInput }));
		expect(saturated.invalidReasons.join(" ")).toContain(
			"pre-check's own originator saturated",
		);
	});

	test("derives V-G from every registered steady rung", () => {
		const subFloor = request();
		const window = (subFloor.artifact as Json).arms[1].rawReports.realm.windows
			.steady;
		const skipped = Math.ceil(window.scheduleTicksDue * 0.02);
		window.scheduleTicksFired -= skipped;
		window.scheduleTicksSkipped = skipped;
		window.sent -= skipped;
		window.scheduleLag = histogram(1_000_000, window.scheduleTicksFired);
		const result = evaluateG6(subFloor);
		expect(result.invalidReasons.join(" ")).toContain(
			"V-G: rung 2500 offered 0.98000",
		);

		const missing = request();
		delete (missing.artifact as Json).arms[0].rawReports.realm.windows.steady
			.sent;
		expect(evaluateG6(missing).invalidReasons.join(" ")).toContain(
			"V-G: rung 500 offered 0.00000",
		);
	});

	test("derives V-I from raw path, cadence, and publisher provenance", () => {
		const cadence = request();
		(cadence.artifact as Json).arms[3].hotspot.frameGapFraction = 0;
		expect(evaluateG6(cadence).invalidReasons.join(" ")).toContain(
			"V-I cadence-absent",
		);

		const path = request();
		const subscriber = (path.artifact as Json).arms[3].rawReports.subscriber;
		subscriber.windows.steadyDrain.oneWay = histogram(
			50_000,
			subscriber.windows.steadyDrain.rxRaid,
		);
		expect(evaluateG6(path).invalidReasons.join(" ")).toContain(
			"V-I lag-microsecond",
		);

		const provenance = request();
		(provenance.artifact as Json).arms[3].rawReports.publisherProvenance = [];
		expect(evaluateG6(provenance).invalidReasons.join(" ")).toContain(
			"V-I provenance",
		);
	});

	test("binds hotspot and storm cohorts to the registered scenario", () => {
		const wrongRaidSize = request();
		(wrongRaidSize.artifact as Json).arms[3].hotspot.subscribers = 39;
		expect(evaluateG6(wrongRaidSize).invalidReasons.join(" ")).toContain(
			"hotspot subscribers 39, expected 40",
		);

		const wrongStormCohort = request();
		(wrongStormCohort.artifact as Json).arms[4].rawReports.realm.storm.cohort =
			999;
		expect(evaluateG6(wrongStormCohort).invalidReasons.join(" ")).toContain(
			"storm-1000 client cohort 999, expected 1000",
		);
	});

	test("rejects synthesized phase boundaries even when counters look clean", () => {
		const degraded = request();
		(degraded.artifact as Json).arms[0].degraded = [
			"drainEnd marker never arrived: boundary synthesized",
		];
		expect(evaluateG6(degraded).invalidReasons.join(" ")).toContain(
			"steady-500 degraded evidence",
		);
	});

	test("reports a finite-pool Little signature without invalidating a valid run", () => {
		const finitePool = request();
		const arm = (finitePool.artifact as Json).arms[4];
		arm.rawReports.realm.storm.concurrency = 500;
		arm.rawReports.realm.storm.reconnectMeanMs = 50;
		arm.storm.acceptSeries = [{ tMs: 2_000, accepts: 10_000 }];
		const characterized = evaluateG6(finitePool);
		expect(characterized.final).toEqual({ valid: true, gate: "PASS" });
		expect(characterized.characterizationOnlyReasons.join(" ")).toContain(
			"storm-1000: V-L",
		);

		const noPool = evaluateG6(request());
		expect(noPool.characterizationOnlyReasons).toEqual([]);
	});

	test("refuses a missing CSV and a candidate mismatch", () => {
		const noCsv = evaluateG6(request({ artifactCsvPresent: false }));
		expect(noCsv.invalidReasons.join(" ")).toContain(
			"required nonempty bench-g6 CSV input is missing",
		);

		const mismatched = request();
		(mismatched.artifact as Json).source.candidateSha = "e".repeat(40);
		expect(evaluateG6(mismatched).invalidReasons.join(" ")).toContain(
			"artifact.source.candidateSha",
		);
	});

	test("regrades the compact G6-03 defect fixture as INVALID", () => {
		const fixture = JSON.parse(
			readFileSync(
				resolve(import.meta.dir, "fixtures/g6/g6-03-invalid.json"),
				"utf8",
			),
		) as Json;
		const defects = fixture.defects as Json;
		const input = request({
			artifactCsvPresent: defects.manifestIncludesGateCsv,
			floorTranscript: floorTranscript({ sessions: defects.floorSessions }),
		});
		const artifact = input.artifact as Json;
		const steady5000 = artifact.arms[2].rawReports.realm.windows.steady;
		steady5000.scheduleTicksFired = Math.round(
			steady5000.scheduleTicksDue * defects.steady5000OfferedRatio,
		);
		steady5000.scheduleTicksSkipped =
			steady5000.scheduleTicksDue - steady5000.scheduleTicksFired;
		steady5000.sent = steady5000.scheduleTicksFired;
		steady5000.scheduleLag = histogram(
			1_000_000,
			steady5000.scheduleTicksFired,
			{ negative: defects.steady5000NegativeScheduleLag },
		);
		const hotspot = artifact.arms[3];
		delete hotspot.rawReports.subscriber.windows.steadyDrain.oneWay;
		hotspot.hotspot.frameGapFraction = defects.hotspotFrameGapFraction;
		const storm = artifact.arms[4];
		storm.rawReports.realm.storm.concurrency =
			defects.storm1000ConnectConcurrency;
		storm.rawReports.realm.storm.reconnectMeanMs =
			defects.storm1000MeanAcceptLatencyMs;
		storm.storm.acceptSeries = [
			{ tMs: 2_000, accepts: defects.storm1000PeakAcceptsPerSecond },
		];

		const result = evaluateG6(input);
		expect(result.final).toEqual({
			valid: fixture.expected.valid,
			gate: fixture.expected.gate,
		});
		for (const fragment of fixture.expected.invalidReasonFragments) {
			expect(result.invalidReasons.join(" ")).toContain(fragment);
		}
		for (const fragment of fixture.expected.characterizationReasonFragments) {
			expect(result.characterizationOnlyReasons.join(" ")).toContain(fragment);
		}
	});

	test("CLI writes byte-identical payloads and distinguishes invalid from malformed", () => {
		const repo = resolve(import.meta.dir, "../..");
		const preregPath = resolve(repo, G6_CLOSEOUT_SPEC_PATH);
		const actualPreregSha = sha256(readFileSync(preregPath));
		const dir = mkdtempSync(join(tmpdir(), "g6-evaluate-test-"));
		try {
			const artifactPath = join(dir, "bench-g6.json");
			const csvPath = join(dir, "bench-g6.csv");
			const downPath = join(dir, "down.json");
			const upPath = join(dir, "up.json");
			const floorPath = join(dir, "floor.log");
			const sinkPath = join(dir, "sink.json");
			const out1 = join(dir, "classified-1.json");
			const out2 = join(dir, "classified-2.json");
			writeFileSync(
				artifactPath,
				JSON.stringify(cleanArtifact()).replaceAll(PREREG_SHA, actualPreregSha),
			);
			writeFileSync(csvPath, "arm,metric,value\nsteady-500,C1,1\n");
			writeFileSync(downPath, JSON.stringify(preflight(1150, 80_000)));
			writeFileSync(upPath, JSON.stringify(preflight(64, 25_000)));
			writeFileSync(
				floorPath,
				floorTranscript().replaceAll(PREREG_SHA, actualPreregSha),
			);
			writeFileSync(sinkPath, JSON.stringify(sink()));
			const args = (out: string, candidate = CANDIDATE) => [
				process.execPath,
				"tools/load/g6-evaluate.ts",
				"--artifact",
				artifactPath,
				"--preflight-down",
				downPath,
				"--preflight-up",
				upPath,
				"--floor",
				floorPath,
				"--sink",
				sinkPath,
				"--expected-candidate",
				candidate,
				"--expected-generator-host",
				GENERATOR_HOST,
				"--expected-preregistration-sha256",
				actualPreregSha,
				"--out",
				out,
			];
			const first = Bun.spawnSync({ cmd: args(out1), cwd: repo });
			const second = Bun.spawnSync({ cmd: args(out2), cwd: repo });
			expect(first.exitCode).toBe(0);
			expect(second.exitCode).toBe(0);
			expect(readFileSync(out1)).toEqual(readFileSync(out2));

			const invalid = Bun.spawnSync({
				cmd: args(join(dir, "invalid.json"), "e".repeat(40)),
				cwd: repo,
			});
			expect(invalid.exitCode).toBe(2);

			rmSync(csvPath);
			const malformed = Bun.spawnSync({
				cmd: args(join(dir, "missing-csv.json")),
				cwd: repo,
			});
			expect(malformed.exitCode).toBe(3);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
