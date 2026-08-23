import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	type ArtifactRejectionCode,
	canonicalDigest,
	compareRunArtifacts,
	type RunArtifact,
	sealRunArtifact,
	verifyRunArtifact,
	verifyRunArtifactObject,
} from "./compare.ts";

const fixture = (name: string): Uint8Array =>
	new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", name)));

const wsBytes = fixture("valid-ws-run.json");
const wtBytes = fixture("valid-wt-run.json");

function fixtureObject(bytes: Uint8Array): RunArtifact {
	const artifact = verifyRunArtifact(bytes).artifact;
	if (!artifact) throw new Error("fixture must be a valid run artifact");
	return artifact;
}

function mutatedBytes(
	bytes: Uint8Array,
	mutate: (artifact: RunArtifact) => void,
): Uint8Array {
	const artifact = fixtureObject(bytes);
	mutate(artifact);
	return sealRunArtifact(artifact);
}

function verifyCode(bytes: Uint8Array): ArtifactRejectionCode[] {
	return verifyRunArtifact(bytes).rejections.map(({ code }) => code);
}

function compareCode(
	mutator: (artifact: RunArtifact) => void,
	rebindSource = false,
): ArtifactRejectionCode[] {
	const changed = fixtureObject(wtBytes);
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
	return compareRunArtifacts(wsBytes, sealRunArtifact(changed)).rejections.map(
		({ code }) => code,
	);
}

describe("fail-closed comparison evidence", () => {
	test("accepts compatible WS and WT artifacts and computes a delta", () => {
		const result = compareRunArtifacts(wsBytes, wtBytes);

		expect(result.evidenceStatus).toBe("PASS");
		expect(result.scenarioVerdict).toBe("PASS");
		expect(result.ws.visible).toBe(true);
		expect(result.wt.visible).toBe(true);
		expect(result.delta).toEqual({
			metric: "p50",
			unit: "ms",
			ws: 2,
			wt: 1,
			absolute: -1,
			relative: -0.5,
		});
		expect(result.ranking).toBe("wt");
	});

	test("binds the exact supplied artifact bytes with a non-self-referential digest", () => {
		expect(verifyRunArtifact(wsBytes).evidenceStatus).toBe("PASS");
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
			"wrong interface",
			(a) => {
				a.topology.mac.interface = "lo0";
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
			"wrong route",
			(a) => {
				a.topology.mac.route.interface = "en0";
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
				(a) => (a.scenario.direction = "linux-to-mac"),
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

	test("requires Mac FD/ephemeral-port proof and effective child nofile for scale", () => {
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
			[
				"Mac child limit",
				(a) => (a.capacityProof.mac.fd.effectiveChildLimit = 65_535),
				"CAPACITY_EFFECTIVE_LIMIT_TOO_LOW",
			],
			[
				"Linux child limit",
				(a) => (a.capacityProof.linux.fd.effectiveChildLimit = 65_535),
				"CAPACITY_EFFECTIVE_LIMIT_TOO_LOW",
			],
		];
		for (const [label, mutate, code] of cases) {
			expect(verifyCode(mutatedBytes(wsBytes, mutate)), label).toContain(code);
		}
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
		const result = compareRunArtifacts(blockedWs, wtBytes);
		expect(result.ws.visible).toBe(false);
		expect(result.ws.evidenceStatus).toBe("BLOCKED");
		expect(result.delta).toBe("not computed");
		expect(result.ranking).toBe("not computed");
	});

	test("retains a valid WS arm when WT is missing with a typed blocker and no delta", () => {
		const result = compareRunArtifacts(wsBytes, undefined);

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
		const result = compareRunArtifacts(wsBytes, stale);

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
		});
		const result = compareRunArtifacts(wsBytes, changed);

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
		).toContain("SCHEMA_OWN_FIELD_REQUIRED");

		const getterObject = fixtureObject(wsBytes) as unknown as Record<
			string,
			unknown
		>;
		const originalSource = getterObject.source;
		let reads = 0;
		Object.defineProperty(getterObject, "source", {
			enumerable: true,
			get: () => {
				reads += 1;
				return originalSource;
			},
		});
		expect(verifyRunArtifactObject(getterObject).evidenceStatus).toBe("PASS");
		expect(reads).toBe(1);
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
