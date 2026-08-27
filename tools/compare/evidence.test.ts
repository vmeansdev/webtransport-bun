import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type ArtifactRejectionCode,
	type ArtifactTrustContext,
	addRejection,
	balancedArmOrder,
	expandArmUnits,
	canonicalDigest,
	compareRunArtifacts,
	metricContractForScenario,
	metricContractHash,
	PRIMARY_METRIC_CONTRACTS,
	type RawSidecarDigests,
	type RunArtifact,
	sealRunArtifact,
	snapshotEvidenceValue,
	verifyRunArtifactObject as verifyRawRunArtifactObject,
	verifyRunArtifact,
} from "./compare.ts";
import {
	armUnitsFor,
	CANONICAL_SCENARIO_REGISTRY,
	getScenarioCell,
} from "./scenario-registry.ts";

const fixture = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

const wsBytes = fixture("valid-ws-run.json");
const wtBytes = fixture("valid-wt-run.json");

function fixtureObject(bytes: Uint8Array): RunArtifact {
	return JSON.parse(new TextDecoder().decode(bytes)) as RunArtifact;
}

function trustContextForArtifact(artifact: RunArtifact): ArtifactTrustContext {
	return {
		comparisonId: artifact.comparisonId,
		runId: artifact.runId,
		transport: artifact.transport,
		sourceSha: artifact.source.sourceSha,
		archiveSha256: artifact.source.archiveSha256,
		executableSha256: artifact.source.executableSha256,
		toolchain: artifact.source.toolchain,
		rawSidecarDigests: artifact.rawSidecarDigests,
	};
}

function trustContext(bytes: Uint8Array): ArtifactTrustContext {
	return trustContextForArtifact(fixtureObject(bytes));
}

function verifyObject(artifact: RunArtifact) {
	return verifyRawRunArtifactObject(
		artifact,
		trustContextForArtifact(artifact),
	);
}

function verifyRunArtifactObject(input: unknown) {
	try {
		if (input && typeof input === "object" && "source" in input)
			return verifyRawRunArtifactObject(
				input,
				trustContextForArtifact(input as RunArtifact),
			);
	} catch {
		// The production verifier owns hostile-root handling; retry without
		// touching the root so the test exercises that path.
	}
	return verifyRawRunArtifactObject(input);
}

function measuredBytes(bytes: Uint8Array): Uint8Array {
	const artifact = fixtureObject(bytes);
	artifact.artifactKind = "measured";
	artifact.promotable = true;
	return sealRunArtifact(artifact);
}

function mutatedBytes(
	bytes: Uint8Array,
	mutate: (artifact: RunArtifact) => void,
): Uint8Array {
	const artifact = fixtureObject(bytes);
	artifact.artifactKind = "measured";
	artifact.promotable = true;
	const originalSidecars = canonicalDigest(artifact.rawSidecarDigests);
	mutate(artifact);
	if (canonicalDigest(artifact.rawSidecarDigests) === originalSidecars)
		bindRawSidecar(artifact);
	return sealRunArtifact(artifact);
}

function verifyCode(bytes: Uint8Array): ArtifactRejectionCode[] {
	return verifyRunArtifact(bytes).rejections.map(({ code }) => code);
}

function bytesSha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function setMetricClock(
	artifact: RunArtifact,
	metricKind: string = "mac-local-end-to-end",
	clock?: Record<string, unknown>,
): void {
	const metrics = artifact.metrics as unknown as Record<string, unknown>;
	metrics.metricKind = metricKind;
	metrics.clock = clock ?? {
		domain:
			metricKind === "linux-local-service"
				? "linux-monotonic"
				: metricKind === "one-way"
					? "independent-offset"
					: "mac-monotonic",
		monotonic: true,
		method: "process.monotonic",
		...(metricKind === "one-way" ? { offsetMs: 0, uncertaintyMs: 0.25 } : {}),
	};
}

function canonicalCellArtifact(
	baseBytes: Uint8Array,
	cellId: string,
): RunArtifact {
	const artifact = fixtureObject(baseBytes);
	const cell = getScenarioCell(CANONICAL_SCENARIO_REGISTRY, cellId);
	artifact.scenario.cellId = cell.cellId;
	artifact.scenario.scenarioId = cell.scenarioId;
	artifact.scenario.config = cell.parameters as unknown as Record<
		string,
		unknown
	>;
	artifact.scenario.scenarioHash = cell.scenarioHash;
	artifact.scenario.direction = cell.rolePlan.direction;
	artifact.scenario.repetition.total = cell.runPolicy.measuredRepetitions;
	// The retargeted cell may schedule more units than the source cell did, so
	// the recorded slot order has to be recomputed for it.
	artifact.scenario.armOrder = [
		...expandArmUnits(
			balancedArmOrder(
				artifact.scenario.seed,
				artifact.scenario.repetition.index,
				armUnitsFor(cell),
			),
		),
	];
	artifact.artifactKind = "measured";
	artifact.promotable = true;
	const contract = metricContractForScenario(cell.scenarioId);
	if (contract) {
		artifact.metrics.name = contract.name;
		artifact.metrics.unit = contract.unit;
		artifact.metrics.metricKind = contract.metricKind;
		artifact.metricContractId = contract.id;
		artifact.metricContractHash = metricContractHash(contract);
		artifact.ledger.histogram.unit = contract.unit;
	}
	artifact.processProof = {
		rolePlanHash: canonicalDigest(cell.rolePlan),
		macRoles: cell.rolePlan.macRoles,
		linuxRole: cell.rolePlan.linuxRole,
		sharding: cell.rolePlan.sharding,
		processCohort: cell.rolePlan.processCohort,
	};
	artifact.rawSidecarBindingSha256 = canonicalDigest({
		comparisonId: artifact.comparisonId,
		runId: artifact.runId,
		transport: artifact.transport,
		sourceBindingSha256: artifact.source.bindingSha256,
		scenarioHash: artifact.scenario.scenarioHash,
		metricContractHash: artifact.metricContractHash,
		rawSidecarDigests: artifact.rawSidecarDigests,
	});
	setMetricClock(artifact, contract?.metricKind ?? "mac-local-end-to-end");
	return artifact;
}

function bindDirectDigest(artifact: RunArtifact): void {
	const withoutDigest = {
		...(artifact as unknown as Record<string, unknown>),
		artifactByteSha256: "0".repeat(64),
	};
	artifact.artifactByteSha256 = canonicalDigest(withoutDigest);
}

function bindRawSidecar(artifact: RunArtifact): void {
	artifact.rawSidecarBindingSha256 = canonicalDigest({
		comparisonId: artifact.comparisonId,
		runId: artifact.runId,
		transport: artifact.transport,
		sourceBindingSha256: artifact.source.bindingSha256,
		scenarioHash: artifact.scenario.scenarioHash,
		metricContractHash: artifact.metricContractHash,
		rawSidecarDigests: artifact.rawSidecarDigests,
	});
}

function bulkArtifactObject(baseBytes: Uint8Array): RunArtifact {
	const artifact = canonicalCellArtifact(baseBytes, "bulk-one-way/physical");
	setPayloadBytes(artifact, 65_536);
	bindDirectDigest(artifact);
	return artifact;
}

function setPayloadBytes(artifact: RunArtifact, length: number): void {
	const payload = new Uint8Array(length);
	for (let index = 0; index < payload.length; index += 1)
		payload[index] = index & 0xff;
	artifact.scenario.payload = {
		encoding: "base64",
		data: Buffer.from(payload).toString("base64"),
		bytes: payload.byteLength,
		sha256: bytesSha256(payload),
	};
}

function scaleArtifactObject(
	baseBytes: Uint8Array,
	liveConnections: 1_000 | 5_000 | 10_000,
): RunArtifact {
	return canonicalCellArtifact(
		baseBytes,
		`connection-memory/live-${liveConnections}`,
	);
}

/**
 * The latency contracts carry a `minSamples` floor, so a four-sample fixture
 * is below it.  This is the same construction the frozen fixtures use: two
 * equal runs of 500, whose percentiles are exact.
 */
function setFlooredSamples(artifact: RunArtifact, low: number, high: number) {
	artifact.metrics.samples = [
		...Array(500).fill(low),
		...Array(500).fill(high),
	];
	artifact.metrics.percentiles = {
		p1: low,
		p50: (low + high) / 2,
		p95: high,
		p99: high,
	};
}

function roleScaleArtifactObject(
	baseBytes: Uint8Array,
	cellId: string,
): RunArtifact {
	const artifact = canonicalCellArtifact(baseBytes, cellId);
	const cell = getScenarioCell(CANONICAL_SCENARIO_REGISTRY, cellId);
	const parameters = cell.parameters as Record<string, unknown>;
	const payloadBytes = [
		"messageBytes",
		"recordBytes",
		"tickBytes",
		"firstMessageBytes",
		"operationBytes",
		"chunkBytes",
		"controlMessageBytes",
	]
		.map((key) => parameters[key])
		.find((value) => typeof value === "number");
	if (typeof payloadBytes === "number") setPayloadBytes(artifact, payloadBytes);
	return artifact;
}

function compareCode(
	mutator: (artifact: RunArtifact) => void,
	rebindSource = false,
): ArtifactRejectionCode[] {
	const changed = fixtureObject(wtBytes);
	changed.artifactKind = "measured";
	changed.promotable = true;
	const originalSidecars = canonicalDigest(changed.rawSidecarDigests);
	mutator(changed);
	if (rebindSource) {
		changed.source.bindingSha256 = canonicalDigest({
			sourceSha: changed.source.sourceSha,
			archiveSha256: changed.source.archiveSha256,
			executableSha256: changed.source.executableSha256,
			toolchain: changed.source.toolchain,
			cleanTree: changed.source.cleanTree,
		});
	}
	if (canonicalDigest(changed.rawSidecarDigests) === originalSidecars)
		bindRawSidecar(changed);
	const changedBytes = sealRunArtifact(changed);
	const result = compareRunArtifacts(measuredBytes(wsBytes), changedBytes, {
		ws: trustContext(measuredBytes(wsBytes)),
		wt: trustContext(changedBytes),
	});
	return result.rejections.map(({ code }) => code);
}

describe("fail-closed comparison evidence", () => {
	test("accepts compatible WS and WT artifacts and computes a delta", () => {
		const ws = measuredBytes(wsBytes);
		const wt = measuredBytes(wtBytes);
		const result = compareRunArtifacts(ws, wt, {
			ws: trustContext(ws),
			wt: trustContext(wt),
		});

		expect(result.evidenceStatus).toBe("PASS");
		expect(result.scenarioVerdict).toBe("PASS");
		expect(result.ws.visible).toBe(true);
		expect(result.wt.visible).toBe(true);
		expect(result.delta).toEqual({
			metric: "application-throughput-mbps",
			unit: "Mbps",
			ws: 2,
			wt: 1,
			absolute: -1,
			relative: -0.5,
		});
		expect(result.ranking).toBe("ws");
	});

	test("binds the exact supplied artifact bytes with a non-self-referential digest", () => {
		expect(
			verifyRunArtifact(wsBytes, trustContext(wsBytes)).evidenceStatus,
		).toBe("PASS");
		const changed = new Uint8Array(wsBytes);
		const marker = new TextEncoder().encode('"p50":2');
		const markerIndex = findBytes(changed, marker);
		expect(markerIndex).toBeGreaterThanOrEqual(0);
		changed[markerIndex + marker.length - 1] =
			(changed[markerIndex + marker.length - 1] ?? 0) ^ 1;
		expect(verifyCode(changed)).toContain("ARTIFACT_BYTE_DIGEST_MISMATCH");
	});

	test("rejects schema-version and duplicate digest ambiguity", () => {
		expect(
			verifyCode(
				mutatedBytes(
					wsBytes,
					(artifact) => (artifact.schemaVersion = "v0" as never),
				),
			),
		).toContain("SCHEMA_INVALID_FIELD");
		const text = new TextDecoder().decode(wsBytes);
		const marker = `"artifactByteSha256":"${fixtureObject(wsBytes).artifactByteSha256}"`;
		const duplicate = text.replace(marker, `${marker},${marker}`);
		expect(verifyCode(new TextEncoder().encode(duplicate))).toContain(
			"ARTIFACT_BYTE_DIGEST_INVALID",
		);
	});

	test("rejects source, run, comparison, sidecar, and executable binding mutations", () => {
		const cases: readonly [
			string,
			(artifact: RunArtifact) => void,
			ArtifactRejectionCode,
			boolean,
		][] = [
			[
				"source SHA",
				(a) => (a.source.sourceSha = "b".repeat(40)),
				"SOURCE_SHA_MISMATCH",
				true,
			],
			[
				"source archive",
				(a) => (a.source.archiveSha256 = "b".repeat(64)),
				"SOURCE_ARCHIVE_DIGEST_MISMATCH",
				true,
			],
			[
				"executable",
				(a) => (a.source.executableSha256 = "d".repeat(64)),
				"EXECUTABLE_DIGEST_MISMATCH",
				true,
			],
			[
				"toolchain",
				(a) => (a.source.toolchain.sha256 = "b".repeat(64)),
				"TOOLCHAIN_DIGEST_MISMATCH",
				true,
			],
			[
				"raw sidecar",
				(a) => (a.rawSidecarDigests.client = "b".repeat(64)),
				"RAW_SIDECAR_DIGEST_MISMATCH",
				false,
			],
			["run", (a) => (a.runId = "different-run"), "RUN_ID_MISMATCH", false],
			[
				"comparison",
				(a) => (a.comparisonId = "different-comparison"),
				"COMPARISON_ID_MISMATCH",
				false,
			],
		];
		for (const [label, mutate, code, rebindSource] of cases) {
			expect(compareCode(mutate, rebindSource), label).toContain(code);
		}
	});

	const topologyCases: readonly [
		string,
		(a: RunArtifact) => void,
		ArtifactRejectionCode,
	][] = [
		[
			"loopback",
			(a) => {
				a.topology.mac.address = "127.0.0.1";
			},
			"TOPOLOGY_LOOPBACK",
		],
		[
			"localhost",
			(a) => {
				a.smoke.input = "https://localhost:4433";
			},
			"TOPOLOGY_LOOPBACK",
		],
		[
			"unspecified",
			(a) => {
				a.topology.linux.address = "0.0.0.0";
			},
			"TOPOLOGY_UNSPECIFIED",
		],
		[
			"missing Linux",
			(a) => {
				delete (a.topology as unknown as Record<string, unknown>).linux;
			},
			"TOPOLOGY_MISSING_LINUX",
		],
		[
			"same host",
			(a) => {
				a.topology.linux.hostId = a.topology.mac.hostId;
			},
			"TOPOLOGY_SAME_HOST",
		],
		[
			"wrong Mac OS",
			(a) => {
				a.topology.mac.os = "linux";
			},
			"TOPOLOGY_OS_MISMATCH",
		],
		[
			"wrong Linux OS",
			(a) => {
				a.topology.linux.os = "darwin" as never;
			},
			"TOPOLOGY_OS_MISMATCH",
		],
		[
			"wrong interface",
			(a) => {
				a.topology.mac.interface = "lo0";
			},
			"TOPOLOGY_INTERFACE_MISMATCH",
		],
		[
			"wrong Linux interface",
			(a) => {
				a.topology.linux.interface = "eth0";
			},
			"TOPOLOGY_INTERFACE_MISMATCH",
		],
		[
			"wrong address",
			(a) => {
				a.topology.mac.address = "10.99.0.9";
			},
			"TOPOLOGY_ADDRESS_MISMATCH",
		],
		[
			"wrong Linux address",
			(a) => {
				a.topology.linux.address = "10.99.0.9";
			},
			"TOPOLOGY_ADDRESS_MISMATCH",
		],
		[
			"wrong route",
			(a) => {
				a.topology.mac.route.interface = "en0";
			},
			"TOPOLOGY_ROUTE_MISMATCH",
		],
		[
			"wrong Linux route",
			(a) => {
				a.topology.linux.route.interface = "eth0";
			},
			"TOPOLOGY_ROUTE_MISMATCH",
		],
		[
			"wrong MTU",
			(a) => {
				a.topology.linux.mtu = 9000;
			},
			"TOPOLOGY_MTU_MISMATCH",
		],
		[
			"missing peer",
			(a) => {
				delete (a.topology as unknown as Record<string, unknown>)
					.serverObservedPeer;
			},
			"TOPOLOGY_PEER_MISSING",
		],
		[
			"wrong peer",
			(a) => {
				a.topology.serverObservedPeer.address = "10.99.0.9";
			},
			"TOPOLOGY_PEER_MISMATCH",
		],
		[
			"missing Linux sidecar",
			(a) => {
				a.topology.sidecars.linux.process = false;
			},
			"TOPOLOGY_SIDECAR_MISSING",
		],
		[
			"loopback smoke",
			(a) => {
				a.smoke.usedLoopback = true;
			},
			"SMOKE_INPUT_INVALID",
		],
	];
	test.each(
		topologyCases,
	)("rejects %s topology/smoke evidence", (_label, mutate, code) => {
		expect(verifyCode(mutatedBytes(wsBytes, mutate))).toContain(code);
	});

	test("rejects a scenario, canonical-config, hash, seed, repetition, arm-order, payload, or direction mutation", () => {
		const cases: readonly [
			string,
			(a: RunArtifact) => void,
			ArtifactRejectionCode,
		][] = [
			[
				"scenario id",
				(a) => (a.scenario.scenarioId = "ticker-fanout"),
				"SCENARIO_CONFIG_MISMATCH",
			],
			[
				"canonical flag",
				(a) => (a.scenario.canonical = false),
				"SCENARIO_NON_CANONICAL",
			],
			[
				"scenario hash",
				(a) => (a.scenario.scenarioHash = "b".repeat(64)),
				"SCENARIO_HASH_MISMATCH",
			],
			["seed", (a) => (a.scenario.seed = -1), "SCENARIO_SEED_INVALID"],
			[
				"repetition",
				(a) => (a.scenario.repetition.index = 0),
				"SCENARIO_REPETITION_INVALID",
			],
			[
				"arm order",
				(a) => (a.scenario.armOrder = ["ws", "ws", "wt", "wt"]),
				"SCENARIO_ARM_ORDER_INVALID",
			],
			[
				"payload bytes",
				(a) => (a.scenario.payload.bytes = 129),
				"SCENARIO_PAYLOAD_MISMATCH",
			],
			[
				"payload hash",
				(a) => (a.scenario.payload.sha256 = "b".repeat(64)),
				"SCENARIO_PAYLOAD_MISMATCH",
			],
			[
				"direction",
				(a) => (a.scenario.direction = "mac-to-linux"),
				"SCENARIO_DIRECTION_MISMATCH",
			],
		];
		for (const [label, mutate, code] of cases) {
			expect(compareCode(mutate), label).toContain(code);
		}
	});

	test("rejects TLS, SNI, certificate, and compression mismatches", () => {
		const cases: readonly [
			string,
			(a: RunArtifact) => void,
			ArtifactRejectionCode,
		][] = [
			[
				"TLS mode",
				(a) => (a.tls.rejectUnauthorized = false),
				"TLS_CONFIGURATION_INVALID",
			],
			["SNI", (a) => (a.tls.sni = "wrong.example"), "TLS_SNI_MISMATCH"],
			[
				"certificate",
				(a) => (a.tls.certificateSha256 = "b".repeat(64)),
				"TLS_CERTIFICATE_MISMATCH",
			],
			[
				"CA",
				(a) => (a.tls.caSha256 = "f".repeat(64)),
				"TLS_CONFIGURATION_INVALID",
			],
			[
				"compression",
				(a) => (a.tls.compression = "permessage-deflate"),
				"TLS_COMPRESSION_ENABLED",
			],
		];
		for (const [label, mutate, code] of cases) {
			expect(compareCode(mutate), label).toContain(code);
		}
	});

	test("rejects impairment requested/observed/pre/post/restoration drift", () => {
		const cases: readonly [
			string,
			(a: RunArtifact) => void,
			ArtifactRejectionCode,
		][] = [
			[
				"requested",
				(a) => (a.impairment.requested.delayMs = 40),
				"IMPAIRMENT_REQUESTED_INVALID",
			],
			[
				"observed before",
				(a) => (a.impairment.observedBefore.qdisc = "netem"),
				"IMPAIRMENT_OBSERVED_INVALID",
			],
			[
				"observed after",
				(a) => (a.impairment.observedAfter.qdisc = "netem"),
				"IMPAIRMENT_RESTORATION_INVALID",
			],
			[
				"restoration flag",
				(a) => (a.impairment.restored = false),
				"IMPAIRMENT_RESTORATION_INVALID",
			],
			[
				"restoration proof",
				(a) => (a.impairment.restorationProof.matches = false),
				"IMPAIRMENT_RESTORATION_INVALID",
			],
		];
		for (const [label, mutate, code] of cases) {
			expect(compareCode(mutate), label).toContain(code);
		}
	});

	test("binds impairment to the selected path and requires an initial fq state", () => {
		const physical = canonicalCellArtifact(
			wsBytes,
			"handshake-matrix/physical-cold",
		);
		physical.impairment.requested = {
			qdisc: "netem",
			delayMs: 40,
			lossPercent: 0,
			direction: "linux-egress",
		};
		bindDirectDigest(physical);
		expect(
			verifyRunArtifactObject(physical).rejections.map(({ code }) => code),
		).toContain("IMPAIRMENT_REQUESTED_INVALID");

		const delay40 = canonicalCellArtifact(
			wsBytes,
			"handshake-matrix/delay40-cold",
		);
		delay40.impairment.requested = {
			qdisc: "netem",
			delayMs: 40,
			lossPercent: 0,
			direction: "linux-egress",
		};
		delay40.capacityProof.mac.ephemeralPorts.requiredFreePorts = 125;
		setFlooredSamples(delay40, 1, 3);
		bindDirectDigest(delay40);
		expect(verifyRunArtifactObject(delay40).evidenceStatus).toBe("PASS");

		const preExistingNetem = canonicalCellArtifact(
			wsBytes,
			"handshake-matrix/physical-cold",
		);
		preExistingNetem.impairment.observedBefore = {
			qdisc: "netem",
			delayMs: 40,
			lossPercent: 0,
		};
		preExistingNetem.impairment.observedAfter = {
			qdisc: "netem",
			delayMs: 40,
			lossPercent: 0,
		};
		preExistingNetem.impairment.restorationProof.observedBeforeSha256 =
			canonicalDigest(preExistingNetem.impairment.observedBefore);
		preExistingNetem.impairment.restorationProof.observedAfterSha256 =
			canonicalDigest(preExistingNetem.impairment.observedAfter);
		bindDirectDigest(preExistingNetem);
		expect(
			verifyRunArtifactObject(preExistingNetem).rejections.map(
				({ code }) => code,
			),
		).toContain("IMPAIRMENT_OBSERVED_INVALID");

		const game = canonicalCellArtifact(
			wsBytes,
			"game-tick-loss/tick-20-loss-1-delay-40",
		);
		setPayloadBytes(game, 64);
		game.impairment.requested = {
			qdisc: "netem",
			delayMs: 100,
			lossPercent: 1,
			direction: "linux-egress",
		};
		bindDirectDigest(game);
		expect(
			verifyRunArtifactObject(game).rejections.map(({ code }) => code),
		).toContain("IMPAIRMENT_REQUESTED_INVALID");
	});

	test("rejects capacity ID/hash/normalized bytes/hash/admission schema/counters/ramp drift", () => {
		const cases: readonly [
			string,
			(a: RunArtifact) => void,
			ArtifactRejectionCode,
		][] = [
			[
				"profile ID",
				(a) => (a.capacity.profileId = "capacity-old"),
				"CAPACITY_PROFILE_ID_MISMATCH",
			],
			[
				"profile hash",
				(a) => (a.capacity.profileHash = "b".repeat(64)),
				"CAPACITY_PROFILE_HASH_MISMATCH",
			],
			[
				"requested value",
				(a) => (a.capacity.requested.maxSessions = 11_999),
				"CAPACITY_PROFILE_VALUES_MISMATCH",
			],
			[
				"normalized bytes",
				(a) => (a.capacity.submittedProfileBytes = "{}"),
				"CAPACITY_SUBMITTED_BYTES_MISMATCH",
			],
			[
				"normalized hash",
				(a) => (a.capacity.submittedProfileHash = "b".repeat(64)),
				"CAPACITY_SUBMITTED_HASH_MISMATCH",
			],
			[
				"admission schema",
				(a) => (a.capacity.admissionCounters.schemaVersion = "v0" as never),
				"CAPACITY_ADMISSION_SCHEMA_MISMATCH",
			],
			[
				"admission counter",
				(a) => (a.capacity.admissionCounters.sessions.accepted = 11),
				"CAPACITY_ADMISSION_COUNTER_INVALID",
			],
			[
				"connection ramp",
				(a) => (a.capacity.connectionRamp.maxConnectsInFlight = 201),
				"CAPACITY_CONNECTION_RAMP_MISMATCH",
			],
		];
		for (const [label, mutate, code] of cases) {
			expect(compareCode(mutate), label).toContain(code);
		}
	});

	test("compares admission-counter schema shape while retaining differing values", () => {
		const wt = fixtureObject(wtBytes);
		wt.artifactKind = "measured";
		wt.promotable = true;
		wt.capacity.admissionCounters.sessions.accepted = 9;
		wt.capacity.admissionCounters.sessions.rejected = 1;
		wt.capacity.admissionCounters.sessions.activePeak = 9;
		const wtMeasured = sealRunArtifact(wt);
		const wsMeasured = measuredBytes(wsBytes);
		const result = compareRunArtifacts(wsMeasured, wtMeasured, {
			ws: trustContext(wsMeasured),
			wt: trustContext(wtMeasured),
		});
		expect(result.evidenceStatus).toBe("PASS");
		expect(result.delta).toEqual({
			metric: "application-throughput-mbps",
			unit: "Mbps",
			ws: 2,
			wt: 1,
			absolute: -1,
			relative: -0.5,
		});
	});

	test("blocks runtime CPU identity drift without producing a delta or ranking", () => {
		const wt = fixtureObject(wtBytes);
		wt.artifactKind = "measured";
		wt.promotable = true;
		wt.runtime.mac.cpu = "Apple arm64 efficiency cores";
		const wtMeasured = sealRunArtifact(wt);
		const wsMeasured = measuredBytes(wsBytes);
		const result = compareRunArtifacts(wsMeasured, wtMeasured, {
			ws: trustContext(wsMeasured),
			wt: trustContext(wtMeasured),
		});

		expect(result.evidenceStatus).toBe("BLOCKED");
		expect(result.delta).toBe("not computed");
		expect(result.ranking).toBe("not computed");
		expect(result.rejections.map(({ code }) => code)).toContain(
			"EVIDENCE_RUNTIME_INVALID",
		);
	});

	test("requires exact histogram bucket boundaries while allowing measured counts to differ", () => {
		const wsMeasured = measuredBytes(wsBytes);
		const differentCounts = fixtureObject(wtBytes);
		differentCounts.artifactKind = "measured";
		differentCounts.promotable = true;
		differentCounts.ledger.histogram.counts = [0, 1, 0];
		const differentCountsBytes = sealRunArtifact(differentCounts);
		const compatible = compareRunArtifacts(wsMeasured, differentCountsBytes, {
			ws: trustContext(wsMeasured),
			wt: trustContext(differentCountsBytes),
		});
		expect(compatible.evidenceStatus).toBe("PASS");
		expect(compatible.delta).not.toBe("not computed");

		const differentBoundary = fixtureObject(wtBytes);
		differentBoundary.artifactKind = "measured";
		differentBoundary.promotable = true;
		differentBoundary.ledger.histogram.boundaries[1] = 3;
		const differentBoundaryBytes = sealRunArtifact(differentBoundary);
		const blocked = compareRunArtifacts(wsMeasured, differentBoundaryBytes, {
			ws: trustContext(wsMeasured),
			wt: trustContext(differentBoundaryBytes),
		});
		expect(blocked.evidenceStatus).toBe("BLOCKED");
		expect(blocked.delta).toBe("not computed");
		expect(blocked.ranking).toBe("not computed");
		expect(blocked.rejections.map(({ code }) => code)).toContain(
			"EVIDENCE_LEDGER_INVALID",
		);
	});

	test("requires capacity proof only for connection-scale cells", () => {
		const cases: readonly [
			string,
			(a: RunArtifact) => void,
			ArtifactRejectionCode,
		][] = [
			[
				"Mac FD",
				(a) => (a.capacityProof.mac.fd = undefined as never),
				"CAPACITY_FD_PROOF_MISSING",
			],
			[
				"ephemeral ports",
				(a) => (a.capacityProof.mac.ephemeralPorts.freePorts = 100),
				"CAPACITY_EPHEMERAL_PORT_PROOF_INVALID",
			],
		];
		for (const [label, mutate, code] of cases) {
			expect(verifyCode(mutatedBytes(wsBytes, mutate)), label).toContain(code);
		}

		const nonScale = fixtureObject(wsBytes);
		nonScale.capacityProof.mac.fd.effectiveChildLimit = 1_024;
		nonScale.capacityProof.linux.fd.effectiveChildLimit = 1_024;
		nonScale.capacityProof.mac.ephemeralPorts.requiredFreePorts = 1;
		bindDirectDigest(nonScale);
		expect(verifyRunArtifactObject(nonScale).evidenceStatus).toBe("PASS");
		const ordinaryTicker = roleScaleArtifactObject(
			wsBytes,
			"ticker-fanout/rate-10000",
		);
		ordinaryTicker.capacityProof.mac.fd.effectiveChildLimit = 1_024;
		ordinaryTicker.capacityProof.linux.fd.effectiveChildLimit = 1_024;
		ordinaryTicker.capacityProof.mac.ephemeralPorts.requiredFreePorts = 1;
		bindDirectDigest(ordinaryTicker);
		expect(verifyRunArtifactObject(ordinaryTicker).evidenceStatus).toBe("PASS");
		const zeroHeadroom = fixtureObject(wsBytes);
		zeroHeadroom.capacityProof.mac.ephemeralPorts.requiredFreePorts = 0;
		bindDirectDigest(zeroHeadroom);
		expect(
			verifyRunArtifactObject(zeroHeadroom).rejections.map(({ code }) => code),
		).toContain("CAPACITY_EPHEMERAL_PORT_PROOF_INVALID");

		for (const [liveConnections, requiredFreePorts] of [
			[5_000, 6_250],
			[10_000, 12_500],
		] as const) {
			const scale = scaleArtifactObject(wsBytes, liveConnections);
			scale.capacityProof.mac.ephemeralPorts.requiredFreePorts =
				requiredFreePorts;
			bindDirectDigest(scale);
			expect(verifyRunArtifactObject(scale).evidenceStatus).toBe("PASS");
		}

		const tampered = scaleArtifactObject(wsBytes, 10_000);
		tampered.capacityProof.mac.ephemeralPorts.requiredFreePorts = 0;
		bindDirectDigest(tampered);
		expect(
			verifyRunArtifactObject(tampered).rejections.map(({ code }) => code),
		).toContain("CAPACITY_EPHEMERAL_PORT_PROOF_INVALID");

		const lowMacFd = scaleArtifactObject(wsBytes, 10_000);
		lowMacFd.capacityProof.mac.fd.effectiveChildLimit = 65_535;
		bindDirectDigest(lowMacFd);
		expect(
			verifyRunArtifactObject(lowMacFd).rejections.map(({ code }) => code),
		).toContain("CAPACITY_EFFECTIVE_LIMIT_TOO_LOW");
		const lowLinuxFd = scaleArtifactObject(wsBytes, 10_000);
		lowLinuxFd.capacityProof.linux.fd.effectiveChildLimit = 65_535;
		bindDirectDigest(lowLinuxFd);
		expect(
			verifyRunArtifactObject(lowLinuxFd).rejections.map(({ code }) => code),
		).toContain("CAPACITY_EFFECTIVE_LIMIT_TOO_LOW");
	});

	test("derives connection-scale proof from canonical role cardinality", () => {
		for (const [subscriberCount, requiredFreePorts] of [
			[5_000, 6_250],
			[10_000, 12_500],
		] as const) {
			const cellId = `chat-fanout/subscribers-${subscriberCount}`;
			const valid = roleScaleArtifactObject(wsBytes, cellId);
			valid.capacityProof.mac.ephemeralPorts.requiredFreePorts =
				requiredFreePorts;
			bindDirectDigest(valid);
			expect(verifyRunArtifactObject(valid).evidenceStatus).toBe("PASS");

			const lowMacLimit = roleScaleArtifactObject(wsBytes, cellId);
			lowMacLimit.capacityProof.mac.ephemeralPorts.requiredFreePorts =
				requiredFreePorts;
			lowMacLimit.capacityProof.mac.fd.effectiveChildLimit = 65_535;
			bindDirectDigest(lowMacLimit);
			expect(
				verifyRunArtifactObject(lowMacLimit).rejections.map(({ code }) => code),
			).toContain("CAPACITY_EFFECTIVE_LIMIT_TOO_LOW");

			const lowLinuxLimit = roleScaleArtifactObject(wsBytes, cellId);
			lowLinuxLimit.capacityProof.mac.ephemeralPorts.requiredFreePorts =
				requiredFreePorts;
			lowLinuxLimit.capacityProof.linux.fd.effectiveChildLimit = 65_535;
			bindDirectDigest(lowLinuxLimit);
			expect(
				verifyRunArtifactObject(lowLinuxLimit).rejections.map(
					({ code }) => code,
				),
			).toContain("CAPACITY_EFFECTIVE_LIMIT_TOO_LOW");

			const lowPorts = roleScaleArtifactObject(wsBytes, cellId);
			lowPorts.capacityProof.mac.ephemeralPorts.requiredFreePorts = 1;
			bindDirectDigest(lowPorts);
			expect(
				verifyRunArtifactObject(lowPorts).rejections.map(({ code }) => code),
			).toContain("CAPACITY_EPHEMERAL_PORT_PROOF_INVALID");
		}

		const reconnect = roleScaleArtifactObject(
			wsBytes,
			"reconnect-storm/cold-full",
		);
		reconnect.capacityProof.mac.ephemeralPorts.requiredFreePorts = 125;
		setFlooredSamples(reconnect, 1, 3);
		bindDirectDigest(reconnect);
		expect(verifyRunArtifactObject(reconnect).evidenceStatus).toBe("PASS");
	});

	test("rejects invalid units, empty/nonfinite/sparse samples, and percentiles", () => {
		const invalid = [
			[
				"unit",
				(a: RunArtifact) => (a.metrics.unit = "watts" as never),
				"METRICS_UNIT_INVALID",
			],
			[
				"empty",
				(a: RunArtifact) => (a.metrics.samples = []),
				"METRICS_SAMPLES_EMPTY",
			],
			[
				"nonfinite",
				(a: RunArtifact) => (a.metrics.samples = [1, Number.NaN]),
				"METRICS_SAMPLE_INVALID",
			],
			[
				"sparse",
				(a: RunArtifact) => {
					const sparse = [] as unknown as number[];
					Object.defineProperty(sparse, "length", { value: 2 });
					sparse[1] = 2;
					a.metrics.samples = sparse;
				},
				"METRICS_SAMPLES_SPARSE",
			],
			[
				"percentiles",
				(a: RunArtifact) => (a.metrics.percentiles.p95 = 0),
				"METRICS_PERCENTILES_INVALID",
			],
		] as const;
		for (const [label, mutate, code] of invalid) {
			if (label === "nonfinite" || label === "sparse") {
				const object = fixtureObject(wsBytes);
				mutate(object);
				expect(
					verifyRunArtifactObject(object).rejections.map(
						({ code: rejectionCode }) => rejectionCode,
					),
					label,
				).toContain(code);
			} else {
				expect(verifyCode(mutatedBytes(wsBytes, mutate)), label).toContain(
					code,
				);
			}
		}
	});

	test("requires explicit metric clock provenance and binds metric kind", () => {
		const local = fixtureObject(wsBytes);
		setMetricClock(local);
		bindDirectDigest(local);
		expect(verifyRunArtifactObject(local).evidenceStatus).toBe("PASS");

		const oneWayWithoutOffset = fixtureObject(wsBytes);
		setMetricClock(oneWayWithoutOffset, "one-way", {
			domain: "independent-offset",
			monotonic: true,
			method: "ptp-offset-sample",
		});
		bindDirectDigest(oneWayWithoutOffset);
		expect(
			verifyRunArtifactObject(oneWayWithoutOffset).rejections.map(
				({ code }) => code,
			),
		).toContain("CLOCK_PROVENANCE_INVALID");

		const oneWay = fixtureObject(wsBytes);
		oneWay.metrics.name = "one-way-latency";
		setMetricClock(oneWay, "one-way", {
			domain: "independent-offset",
			monotonic: true,
			method: "ptp-offset-sample",
			offsetMs: 0.25,
			uncertaintyMs: 0.05,
		});
		bindDirectDigest(oneWay);
		expect(
			verifyRunArtifactObject(oneWay).rejections.map(({ code }) => code),
		).toContain("METRICS_CONTRACT_INVALID");

		const renamed = fixtureObject(wsBytes);
		renamed.metrics.name = "one-way-latency";
		setMetricClock(renamed);
		bindDirectDigest(renamed);
		expect(
			verifyRunArtifactObject(renamed).rejections.map(({ code }) => code),
		).toContain("METRICS_CONTRACT_INVALID");

		const wt = fixtureObject(wtBytes);
		wt.artifactKind = "measured";
		wt.promotable = true;
		setMetricClock(wt, "mac-local-end-to-end", {
			domain: "mac-monotonic",
			monotonic: true,
			method: "different-monotonic-source",
		});
		const wsMeasured = measuredBytes(wsBytes);
		const wtMeasured = sealRunArtifact(wt);
		const comparison = compareRunArtifacts(wsMeasured, wtMeasured, {
			ws: trustContext(wsMeasured),
			wt: trustContext(wtMeasured),
		});
		expect(comparison.delta).toBe("not computed");
		expect(comparison.rejections.map(({ code }) => code)).toContain(
			"CLOCK_PROVENANCE_MISMATCH",
		);
	});

	test("accepts an exact 64 KiB canonical bulk chunk and rejects an oversized chunk", () => {
		expect(fixtureObject(wsBytes).scenario.cellId).toBe(
			"bulk-one-way/physical",
		);
		const bulk = bulkArtifactObject(wsBytes);
		expect(verifyRunArtifactObject(bulk).evidenceStatus).toBe("PASS");

		const oversized = bulkArtifactObject(wsBytes);
		setPayloadBytes(oversized, 65_537);
		bindDirectDigest(oversized);
		expect(
			verifyRunArtifactObject(oversized).rejections.map(({ code }) => code),
		).toContain("SCENARIO_PAYLOAD_MISMATCH");

		const beyondSupportedCap = bulkArtifactObject(wsBytes);
		setPayloadBytes(beyondSupportedCap, 1_048_577);
		bindDirectDigest(beyondSupportedCap);
		expect(
			verifyRunArtifactObject(beyondSupportedCap).rejections.map(
				({ code }) => code,
			),
		).toContain("SCENARIO_PAYLOAD_INVALID");
	});

	test("keeps evidence status, scenario verdict, and promotability separate but rejects contradictions", () => {
		const cases: readonly [string, (a: RunArtifact) => void][] = [
			[
				"PASS with NO_VERDICT",
				(a) => {
					a.scenarioVerdict = "NO_VERDICT";
				},
			],
			[
				"FAIL promotable",
				(a) => {
					a.evidenceStatus = "FAIL";
					a.scenarioVerdict = "NO_VERDICT";
					a.promotable = true;
				},
			],
			[
				"BLOCKED promotable",
				(a) => {
					a.evidenceStatus = "BLOCKED";
					a.scenarioVerdict = "NO_VERDICT";
					a.promotable = true;
				},
			],
			["PASS verdict not promotable", (a) => (a.promotable = false)],
		];
		for (const [label, mutate] of cases) {
			expect(verifyCode(mutatedBytes(wsBytes, mutate)), label).toContain(
				"STATUS_CONTRADICTION",
			);
		}
	});

	test("does not expose a declared BLOCKED arm as a measured PASS", () => {
		const blockedWs = mutatedBytes(wsBytes, (artifact) => {
			artifact.evidenceStatus = "BLOCKED";
			artifact.scenarioVerdict = "NO_VERDICT";
			artifact.promotable = false;
		});
		const wtMeasured = measuredBytes(wtBytes);
		const result = compareRunArtifacts(blockedWs, wtMeasured, {
			ws: trustContext(blockedWs),
			wt: trustContext(wtMeasured),
		});
		expect(result.ws.visible).toBe(false);
		expect(result.ws.evidenceStatus).toBe("BLOCKED");
		expect(result.delta).toBe("not computed");
		expect(result.ranking).toBe("not computed");
	});

	test("retains a valid WS arm when WT is missing with a typed blocker and no delta", () => {
		const wsMeasured = measuredBytes(wsBytes);
		const result = compareRunArtifacts(wsMeasured, undefined, {
			ws: trustContext(wsMeasured),
		});

		expect(result.evidenceStatus).toBe("BLOCKED");
		expect(result.ws.visible).toBe(true);
		expect(result.ws.evidenceStatus).toBe("PASS");
		expect(result.wt).toEqual({
			visible: false,
			evidenceStatus: "BLOCKED",
			rejections: [
				{
					code: "WT_ARM_NOT_MEASURED",
					reason: "WT arm was not measured for this canonical run",
				},
			],
		});
		expect(result.delta).toBe("not computed");
		expect(result.ranking).toBe("not computed");
	});

	test("blocks stale WT evidence beside valid WS without substituting zero/null", () => {
		const stale = mutatedBytes(wtBytes, (artifact) => {
			artifact.runId = "stale-run";
		});
		const wsMeasured = measuredBytes(wsBytes);
		const result = compareRunArtifacts(wsMeasured, stale, {
			ws: trustContext(wsMeasured),
			wt: trustContext(stale),
		});

		expect(result.ws.visible).toBe(true);
		expect(result.wt.visible).toBe(false);
		expect(result.wt.rejections.map(({ code }) => code)).toContain(
			"RUN_ID_MISMATCH",
		);
		expect(result.delta).toBe("not computed");
		expect(result.ranking).toBe("not computed");
		expect(JSON.stringify(result)).not.toContain('"delta":0');
	});

	test("does not compute a delta when either PASS arm has a mismatched compatibility binding", () => {
		const changed = mutatedBytes(wtBytes, (artifact) => {
			artifact.scenario.seed += 1;
			artifact.scenario.armOrder = [
				...expandArmUnits(
					balancedArmOrder(
						artifact.scenario.seed,
						artifact.scenario.repetition.index,
					),
				),
			];
		});
		const wsMeasured = measuredBytes(wsBytes);
		const result = compareRunArtifacts(wsMeasured, changed, {
			ws: trustContext(wsMeasured),
			wt: trustContext(changed),
		});

		expect(result.evidenceStatus).toBe("BLOCKED");
		expect(result.delta).toBe("not computed");
		expect(result.ranking).toBe("not computed");
		expect(result.rejections.map(({ code }) => code)).toContain(
			"SCENARIO_BINDING_MISMATCH",
		);
	});

	test("rejects inherited fields and snapshots direct getters once", () => {
		const object = fixtureObject(wsBytes) as unknown as Record<string, unknown>;
		const source = object.source as Record<string, unknown>;
		delete object.source;
		Object.setPrototypeOf(object, { source });
		expect(
			verifyRunArtifactObject(object).rejections.map(({ code }) => code),
		).toContain("SCHEMA_RESOURCE_LIMIT");

		const getterObject = fixtureObject(wsBytes) as unknown as Record<
			string,
			unknown
		>;
		const getterContext = trustContextForArtifact(
			getterObject as unknown as RunArtifact,
		);
		const originalSource = getterObject.source;
		let reads = 0;
		Object.defineProperty(getterObject, "source", {
			enumerable: true,
			get: () => {
				reads += 1;
				return originalSource;
			},
		});
		expect(
			verifyRawRunArtifactObject(getterObject, getterContext).evidenceStatus,
		).toBe("PASS");
		expect(reads).toBe(1);
	});

	test("requires literal raw self-digest key and value spans", () => {
		const text = new TextDecoder().decode(wsBytes);
		const escapedKey = text.replace(
			'"artifactByteSha256":',
			'"artifactByteSha\\u0032\\u0035\\u0036":',
		);
		expect(verifyCode(new TextEncoder().encode(escapedKey))).toContain(
			"ARTIFACT_BYTE_DIGEST_INVALID",
		);

		const valueMatch = text.match(/("artifactByteSha256":")([0-9a-f]{64})(")/);
		expect(valueMatch).not.toBeNull();
		if (!valueMatch) return;
		const first = valueMatch[2]?.[0];
		if (!first) return;
		const escapedValue = text.replace(
			valueMatch[0],
			`${valueMatch[1]}\\u${first.codePointAt(0)?.toString(16).padStart(4, "0")}${valueMatch[2]?.slice(1)}${valueMatch[3]}`,
		);
		expect(verifyCode(new TextEncoder().encode(escapedValue))).toContain(
			"ARTIFACT_BYTE_DIGEST_INVALID",
		);

		const collision = text.replace(
			valueMatch[0],
			`${valueMatch[0]},"artifactByteSha\\u0032\\u0035\\u0036":"${valueMatch[2]}"`,
		);
		expect(verifyCode(new TextEncoder().encode(collision))).toContain(
			"ARTIFACT_BYTE_DIGEST_INVALID",
		);
	});

	test("never re-reads a hostile root after snapshot failure", () => {
		const revoked = Proxy.revocable(
			JSON.parse(new TextDecoder().decode(wsBytes)) as object,
			{},
		);
		revoked.revoke();
		const revokedResult = verifyRunArtifactObject(revoked.proxy);
		expect(revokedResult.rejections.length).toBeGreaterThan(0);
		expect(revokedResult.rejections.map(({ code }) => code)).toContain(
			"SCHEMA_RESOURCE_LIMIT",
		);

		const throwing = new Proxy(
			{},
			{
				ownKeys: () => {
					throw new Error("revoked");
				},
			},
		);
		const throwingResult = verifyRunArtifactObject(throwing);
		expect(throwingResult.rejections.map(({ code }) => code)).toContain(
			"SCHEMA_RESOURCE_LIMIT",
		);
	});

	test("rejects cycles, shared references, and resource-budget overflow", () => {
		const shared = { value: 1 };
		const sharedRoot = { first: shared, second: shared };
		expect(() => snapshotEvidenceValue(sharedRoot)).toThrow();

		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => snapshotEvidenceValue(cycle)).toThrow();

		const hugeKey = { ["x".repeat(100_000)]: true };
		expect(() => snapshotEvidenceValue(hugeKey)).toThrow();
	});

	test("deduplicates and caps rejection reporting", () => {
		const rejections: Array<{
			code: ArtifactRejectionCode;
			reason: string;
			path: string;
		}> = [];
		for (let index = 0; index < 100_000; index += 1) {
			addRejection(
				rejections,
				"SCHEMA_INVALID_FIELD",
				"same reason",
				`$.samples[${index}]`,
			);
		}
		expect(rejections.length).toBeLessThan(100_000);
		expect(rejections.map(({ code }) => code)).toContain("REJECTIONS_CAPPED");
	});

	test("requires external trust anchors instead of self-consistency alone", () => {
		const verifyWithContext = verifyRunArtifact as unknown as (
			input: Uint8Array,
			context?: Record<string, unknown>,
		) => ReturnType<typeof verifyRunArtifact>;
		const raw = JSON.parse(new TextDecoder().decode(wsBytes)) as Record<
			string,
			unknown
		>;
		const rawSource = raw.source as Record<string, unknown>;
		const rawToolchain = rawSource.toolchain as Record<string, unknown>;
		const rawSidecarDigests = raw.rawSidecarDigests as RawSidecarDigests;
		const context = {
			comparisonId: raw.comparisonId as string,
			runId: raw.runId as string,
			transport: raw.transport as "ws" | "wt",
			sourceSha: rawSource.sourceSha as string,
			archiveSha256: rawSource.archiveSha256 as string,
			executableSha256: rawSource.executableSha256 as string,
			toolchain: {
				identity: rawToolchain.identity as string,
				sha256: rawToolchain.sha256 as string,
			},
			rawSidecarDigests,
		};
		expect(
			verifyWithContext(wsBytes).rejections.map(({ code }) => code),
		).toContain("TRUST_CONTEXT_MISSING");
		expect(verifyWithContext(wsBytes, context).evidenceStatus).toBe("PASS");
		expect(
			verifyWithContext(wsBytes, {
				...context,
				sourceSha: "b".repeat(40),
			}).rejections.map(({ code }) => code),
		).toContain("TRUST_ANCHOR_MISMATCH");
	});

	test("keeps test fixtures visible but never promotable or comparable", () => {
		const verified = verifyRunArtifact(wsBytes, trustContext(wsBytes));
		expect(verified.evidenceStatus).toBe("PASS");
		expect(verified.artifact).toBeUndefined();
		const result = compareRunArtifacts(wsBytes, wtBytes, {
			ws: trustContext(wsBytes),
			wt: trustContext(wtBytes),
		});
		expect(result.evidenceStatus).toBe("BLOCKED");
		expect(result.delta).toBe("not computed");
		expect(result.ranking).toBe("not computed");
		expect(result.rejections.map(({ code }) => code)).toContain(
			"ARTIFACT_FIXTURE_NOT_PROMOTABLE",
		);
	});

	test("defines an exact contract for every canonical scenario", () => {
		const expected: Record<string, [string, string, string, string]> = {
			"chat-fanout": [
				"delivered-messages-per-second",
				"count",
				"mac-local-end-to-end",
				"higher",
			],
			"ticker-fanout": [
				"delivered-updates-per-second",
				"count",
				// R8-y: both stamps are taken on the Mac.
				"mac-local-end-to-end",
				"higher",
			],
			"game-tick-loss": [
				"delivery-percent",
				"percent",
				"mac-local-end-to-end",
				"higher",
			],
			"reconnect-storm": [
				"recovery-time-ms",
				"ms",
				"mac-local-end-to-end",
				"lower",
			],
			"handshake-matrix": [
				"first-message-latency-ms",
				"ms",
				"mac-local-end-to-end",
				"lower",
			],
			"connection-memory": [
				"rss-bytes-per-connection",
				"bytes",
				"mac-local-end-to-end",
				"lower",
			],
			"crdt-sync": [
				"applied-unique-ops-per-second",
				"count",
				"mac-local-end-to-end",
				"higher",
			],
			"ai-token-stream": [
				"inter-token-latency-ms",
				"ms",
				"mac-local-end-to-end",
				"lower",
			],
			"bulk-one-way": [
				"application-throughput-mbps",
				"Mbps",
				"mac-local-end-to-end",
				"higher",
			],
			"tail-under-cross-traffic": [
				"control-latency-ms",
				"ms",
				"mac-local-end-to-end",
				"lower",
			],
		};
		expect(Object.keys(PRIMARY_METRIC_CONTRACTS).sort()).toEqual(
			Object.keys(expected).sort(),
		);
		for (const [
			scenarioId,
			[name, unit, metricKind, direction],
		] of Object.entries(expected)) {
			const contract = PRIMARY_METRIC_CONTRACTS[scenarioId];
			if (!contract) throw new Error(`missing contract ${scenarioId}`);
			expect(contract).toMatchObject({
				name,
				unit,
				metricKind,
				direction,
			});
			expect(metricContractHash(contract)).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	test("uses contract direction and explicit undefined relative baseline", () => {
		const zero = fixtureObject(wsBytes);
		zero.artifactKind = "measured";
		zero.promotable = true;
		zero.metrics.samples = [0, 0, 0, 0];
		zero.metrics.percentiles = { p1: 0, p50: 0, p95: 0, p99: 0 };
		bindRawSidecar(zero);
		const ws = sealRunArtifact(zero);
		const wt = measuredBytes(wtBytes);
		const result = compareRunArtifacts(ws, wt, {
			ws: trustContext(ws),
			wt: trustContext(wt),
		});
		expect(result.evidenceStatus).toBe("PASS");
		if (result.delta === "not computed") throw new Error("delta missing");
		expect(result.delta.relative).toBeNull();
		expect(result.ranking).toBe("wt");

		const lowerWs = roleScaleArtifactObject(
			wsBytes,
			"reconnect-storm/cold-full",
		);
		setFlooredSamples(lowerWs, 1, 3);
		bindRawSidecar(lowerWs);
		const lowerWt = roleScaleArtifactObject(
			wtBytes,
			"reconnect-storm/cold-full",
		);
		setFlooredSamples(lowerWt, 2, 4);
		bindRawSidecar(lowerWt);
		const lowerWsBytes = sealRunArtifact(lowerWs);
		const lowerWtBytes = sealRunArtifact(lowerWt);
		const lower = compareRunArtifacts(lowerWsBytes, lowerWtBytes, {
			ws: trustContext(lowerWsBytes),
			wt: trustContext(lowerWtBytes),
		});
		expect(lower.evidenceStatus).toBe("PASS");
		expect(lower.ranking).toBe("ws");
	});

	test("validates counters, runtime dimensions, ledger, and telemetry invariants", () => {
		const cases: readonly [
			string,
			(artifact: RunArtifact) => void,
			ArtifactRejectionCode,
		][] = [
			[
				"counter arithmetic",
				(a) => (a.capacity.admissionCounters.sessions.accepted = 9),
				"CAPACITY_ADMISSION_COUNTER_INVALID",
			],
			[
				"rate limit bound",
				(a) => (a.capacity.admissionCounters.handshakes.rateLimited = 1),
				"CAPACITY_ADMISSION_COUNTER_INVALID",
			],
			[
				"active peak bound",
				(a) => (a.capacity.admissionCounters.sessions.activePeak = 11),
				"CAPACITY_ADMISSION_COUNTER_INVALID",
			],
			[
				"runtime identity",
				(a) => (a.runtime.mac.bun = ""),
				"EVIDENCE_RUNTIME_INVALID",
			],
			[
				"role proof hash",
				(a) => (a.processProof.rolePlanHash = "b".repeat(64)),
				"EVIDENCE_PROCESS_PROOF_INVALID",
			],
			[
				"ledger ordering",
				(a) => (a.ledger.delivered = 2),
				"EVIDENCE_LEDGER_INVALID",
			],
			[
				"telemetry RSS",
				(a) => (a.telemetry.mac.rssBytes = -1),
				"EVIDENCE_TELEMETRY_INVALID",
			],
		];
		for (const [label, mutate, code] of cases) {
			const artifact = fixtureObject(wsBytes);
			artifact.artifactKind = "measured";
			artifact.promotable = true;
			mutate(artifact);
			bindRawSidecar(artifact);
			bindDirectDigest(artifact);
			expect(
				verifyObject(artifact).rejections.map(({ code: actual }) => actual),
				label,
			).toContain(code);
		}
	});

	test("binds arm order to adjacent seed choices and enforces port bounds", () => {
		const wrong = fixtureObject(wsBytes);
		wrong.artifactKind = "measured";
		wrong.promotable = true;
		wrong.scenario.seed += 1;
		bindRawSidecar(wrong);
		bindDirectDigest(wrong);
		expect(verifyObject(wrong).rejections.map(({ code }) => code)).toContain(
			"SCENARIO_ARM_ORDER_INVALID",
		);

		const right = fixtureObject(wsBytes);
		right.artifactKind = "measured";
		right.promotable = true;
		right.scenario.seed += 1;
		right.scenario.armOrder = [
			...expandArmUnits(
				balancedArmOrder(right.scenario.seed, right.scenario.repetition.index),
			),
		];
		bindRawSidecar(right);
		bindDirectDigest(right);
		expect(verifyObject(right).evidenceStatus).toBe("PASS");

		for (const [start, end] of [
			[0, 65_535],
			[1, 65_536],
		] as const) {
			const invalid = fixtureObject(wsBytes);
			invalid.artifactKind = "measured";
			invalid.promotable = true;
			invalid.capacityProof.mac.ephemeralPorts.rangeStart = start;
			invalid.capacityProof.mac.ephemeralPorts.rangeEnd = end;
			bindRawSidecar(invalid);
			bindDirectDigest(invalid);
			expect(
				verifyObject(invalid).rejections.map(({ code }) => code),
			).toContain("CAPACITY_EPHEMERAL_PORT_PROOF_INVALID");
		}
	});
});

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
	outer: for (
		let start = 0;
		start <= haystack.length - needle.length;
		start += 1
	) {
		for (let index = 0; index < needle.length; index += 1) {
			if (haystack[start + index] !== needle[index]) continue outer;
		}
		return start;
	}
	return -1;
}
