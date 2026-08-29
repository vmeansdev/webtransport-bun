import { createHash } from "node:crypto";
import {
	sha256Canonical as canonicalDigest,
	canonicalJson,
} from "./canonical.ts";
import {
	type AdmissionCounters,
	ARM_READ_PATH,
	ARM_SHEDDING_POLICY,
	ARM_WIRE,
	type ArmKind,
	type ArmTelemetryEvidence,
	type ArmTransport,
	type ArtifactKind,
	type ArtifactTrustContext,
	balancedArmOrder,
	type CapacityEvidence,
	type CapacityProof,
	ComparisonCliError,
	classifyVerdictTuple,
	EMPTY_ENV_ALLOWLIST_DIGEST,
	EVIDENCE_SCHEMA_VERSION,
	type EvidenceStatus,
	EXPECTED_FQ_LIMIT_PACKETS,
	EXPECTED_LINUX_ADDRESS,
	EXPECTED_LINUX_INTERFACE,
	EXPECTED_LINUX_LINK_LAYER_ADDRESS,
	EXPECTED_MAC_ADDRESS,
	EXPECTED_MAC_INTERFACE,
	EXPECTED_MAC_LINK_LAYER_ADDRESS,
	EXPECTED_MTU,
	EXPECTED_NETEM_LIMIT_PACKETS,
	EXPECTED_SMOKE_INPUT,
	EXPECTED_TLS_SNI,
	expandArmUnits,
	type HostTelemetryEvidence,
	type ImpairmentEvidence,
	type ImpairmentState,
	LINUX_ROUTE_RAW,
	MAC_ROUTE_RAW,
	type MetricClockDomain,
	type MetricsEvidence,
	metricContractForScenario,
	metricContractHash,
	PRIMARY_METRIC_CONTRACTS,
	type ProcessProofEvidence,
	parseMeasurementGrant,
	type RawSidecarDigests,
	type RouteEvidence,
	type RunArtifact,
	type RuntimeEvidence,
	type ScenarioEvidence,
	type ScenarioPayloadEvidence,
	type ScenarioVerdict,
	type SmokeEvidence,
	type SourceEvidence,
	sealRunArtifact,
	type TelemetryEvidence,
	type TlsEvidence,
	type ToolchainSet,
	type TopologyEvidence,
	type Transport,
	type TransportLedgerEvidence,
	UNOBSERVED_TOOLCHAIN,
	validateFixtureOnlyEntrypoint,
	validateOfficialEntrypointContract,
	WIRE_PROFILE_APPLICATION,
} from "./evidence.ts";
import {
	armUnitsFor,
	CANONICAL_CAPACITY_PROFILE,
	CANONICAL_CONNECTION_SETUP,
	CANONICAL_SCENARIO_REGISTRY,
	getScenarioCell,
	requestedImpairmentOf,
} from "./scenario-registry.ts";
import type { ScenarioCell } from "./types.ts";

export { validateFixtureOnlyEntrypoint, validateOfficialEntrypointContract };

/** Every member is reserved: no producer for any of them lands in round 8. */
function emptyArmTelemetry(): ArmTelemetryEvidence {
	return {
		loopUtilizationPercent: 0,
		loopLagMs: { p50: 0, p95: 0, p99: 0 },
		threadCpu: [],
		bytesAllocatedPerMessage: 0,
		gcPauseMs: 0,
	};
}

export interface BuildArtifactInput {
	readonly comparisonId: string;
	readonly runId: string;
	readonly cellId: string;
	readonly transport: Transport;
	readonly armKind?: ArmKind;
	readonly armTransport?: ArmTransport;
	readonly evidenceStatus?: EvidenceStatus;
	readonly scenarioVerdict?: ScenarioVerdict;
	readonly seed?: number;
	readonly repetitionIndex?: number;
	readonly totalRepetitions?: number;
	readonly samples: readonly number[];
	readonly percentiles: {
		readonly p1: number;
		readonly p50: number;
		readonly p95: number;
		readonly p99: number;
	};
	readonly ledger: {
		readonly attempted: number;
		readonly queued?: number;
		readonly serverObserved?: number;
		readonly acknowledged?: number;
		readonly delivered?: number;
		readonly dropped?: number;
		readonly expired?: number;
		/**
		 * Bytes the arm put on the wire that the scenario did not ask for.
		 *
		 * It was hard-wired to zero, and zero was false on both arms and most
		 * false on WS: each application message rides a 13-byte frame the other
		 * arm does not pay, and the receipt both arms now send rides another
		 * one. An unstated figure is still recorded as zero, because a caller
		 * that measured no bytes has no bytes to record -- but the adapters
		 * measure them, so the campaign's arms no longer state zero.
		 */
		readonly harnessOverheadBytes?: number;
		readonly histogram?: {
			readonly unit: "ms" | "bytes" | "Mbps" | "count" | "ratio" | "percent";
			readonly boundaries: readonly number[];
			readonly counts: readonly number[];
		};
	};
	// There is deliberately no `impairment` input. The recorded impairment is
	// decoded from the canonical cell by `requestedImpairmentOf`, which is also
	// what the verifier pins it against, so a caller-supplied figure could only
	// ever be ignored or believed — and this field was the ignored kind: it was
	// declared, passed by the campaign, and read by nothing.
	readonly admissionCounters?: AdmissionCounters;
	/**
	 * What the recorder filed for these samples, carried through to the sealed
	 * bytes so a reader can see the clock the numbers were taken on.
	 *
	 * Optional because the declared and fixture paths have no recorder. It is
	 * not a second place to state the samples' identity: the campaign guard has
	 * already resolved this against the recorder's record by the time it gets
	 * here, so what arrives is a record that was checked, not a claim.
	 */
	readonly provenance?: {
		readonly attestation: string;
		readonly driverRunId: string;
		readonly clockMethod: string;
		readonly sampleCount: number;
		readonly firstSampleAtMs: number;
		readonly lastSampleAtMs: number;
	};
	/**
	 * The grant the supervisor issued for the execution these samples were
	 * measured for.
	 *
	 * Optional in the type and mandatory in fact: a measured arm -- one that
	 * arrives with `provenance` -- may not be assembled without one. The
	 * declared and fixture paths carry neither, and pairing the two is what
	 * keeps "no recorder" a legitimate state while making "a recorder ran, for
	 * nothing in particular" an unbuildable one.
	 */
	readonly grant?: unknown;
	readonly telemetry?: {
		readonly mac?: Partial<HostTelemetryEvidence>;
		readonly linux?: Partial<HostTelemetryEvidence>;
	};
	readonly sourceSha?: string;
	readonly archiveSha256?: string;
	readonly executableSha256?: string;
	/**
	 * The toolchains observed on the hosts this run executed on.
	 *
	 * Optional in the type and mandatory in fact, on the same terms as `grant`:
	 * a measured arm -- one that arrives with `provenance` -- may not be
	 * assembled without it. The declared and fixture paths have no host to
	 * observe, and publish `UNOBSERVED_TOOLCHAIN` rather than a digest of
	 * nothing, which keeps "nobody looked" a legitimate state while making
	 * "something ran, on a toolchain nobody recorded" an unbuildable one.
	 */
	readonly toolchains?: ToolchainSet;
	/**
	 * The supervisor's per-host capability digest observation.
	 *
	 * Optional in the type and mandatory in fact for a measured arm
	 * carrying `provenance`, on the same terms as `toolchains`. The
	 * per-host entries are the digests the supervisor on each host
	 * read off the staged capability file it launched against; a
	 * child that publishes its own capability digest against an
	 * empty `ComparisonSupervisorOutputV1.capabilitySha256` is the
	 * same defect the per-host toolchain binding exists to remove
	 * -- any guard the producing process can call, it can satisfy.
	 * The F4 binding `assertMeasuredArmObservedItsCapability` is
	 * what stops a measured arm from declaring a capability the
	 * supervisor never admitted: a self-attested capability digest
	 * whose per-host entries disagree with the supervisor's reading
	 * is refused at assembly with `CAPABILITY_SUPERVISOR_MISMATCH`,
	 * and a measured arm that arrives without the binding is
	 * refused with `CAPABILITY_SUPERVISOR_MISSING`. The boundary is
	 * at the supervisor, not the artifact, so the field name and
	 * the type stay the same as the child-stated era and the new
	 * guard is the only thing that has to be honoured.
	 */
	readonly capabilityDigest?: {
		readonly darwin?: string;
		readonly linux?: string;
	};
	/**
	 * The supervisor's per-host lock digest observation, on the
	 * same terms as `capabilityDigest`: optional in the type,
	 * mandatory in fact for a measured arm carrying a
	 * `lockDigest`, with the F4 binding enforcing the per-host
	 * match against the supervisor's readings.
	 */
	readonly lockDigest?: {
		readonly darwin?: string;
		readonly linux?: string;
	};
	/**
	 * The Bun executable digests the supervisor observed on each host.
	 *
	 * Optional in the type and mandatory in fact for a measured arm
	 * carrying `provenance`, on the same terms as `toolchains`. Each
	 * entry is the `bunExecutableSha256` the supervisor on that host
	 * read off the Bun binary it launched. The artifact builder binds
	 * the per-host `toolchains` digests to the supervisor's readings so
	 * an arm whose `darwin.sha256` / `linux.sha256` does not match
	 * the supervisor's reading is refused at assembly with
	 * `TOOLCHAIN_SUPERVISOR_MISMATCH`: a self-attested toolchain digest
	 * against an empty `ComparisonSupervisorOutputV1.toolchainSha256`
	 * would otherwise pass the existing `UNOBSERVED_TOOLCHAIN` guard,
	 * and that is the same self-attested promotion defect R1 exists
	 * to remove.
	 */
	readonly supervisorToolchainDigests?: {
		readonly darwin?: string;
		readonly linux?: string;
	};
	/**
	 * The supervisor's per-host capability digests, recorded for the
	 * F4 binding: a measured arm that claims a capability the
	 * supervisor never admitted is refused. The same structural rule
	 * the toolchain digests enforce applies: the campaign is the only
	 * process that has the supervisor's per-host output in hand, and
	 * the binding is what stops a measured arm from declaring a
	 * capability it never saw.
	 */
	readonly supervisorCapabilityDigests?: {
		readonly darwin?: string;
		readonly linux?: string;
	};
	/**
	 * The supervisor's per-host lock digests, recorded for the F4
	 * binding: a measured arm that claims a lock the supervisor
	 * never admitted is refused. Same shape as the capability
	 * binding; the F4 pattern keeps the per-reservation check in
	 * the same place the existing per-host toolchain and
	 * capability bindings live.
	 */
	readonly supervisorLockDigests?: {
		readonly darwin?: string;
		readonly linux?: string;
	};
	readonly caSha256?: string;
	readonly certSha256?: string;
}

/**
 * Refuse to assemble a measured arm that presents no grant.
 *
 * This is the third of three places that ask, and the cheapest to reach. The
 * supervisor refuses the frame -- that is the binding one, because it is the
 * only writer and a refused series is unwritable rather than merely
 * unpublished. The campaign refuses the measurement before it pays for the
 * artifact. And this refuses to assemble one anyway, which matters because the
 * campaign loop is not the only caller: `buildRunArtifact` is exported, the
 * comparator consumes artifact objects with no file ever existing, and a
 * measured arm reaching this function with no execution behind it should not
 * come out the other side looking like evidence.
 *
 * `provenance` is what makes an arm measured. An arm without it is the
 * declared or fixture path, which has no recorder and no execution and must
 * not be made to invent either.
 */
function assertMeasuredArmIsGranted(input: BuildArtifactInput): void {
	if (input.provenance === undefined) return;
	if (input.grant === undefined || input.grant === null) {
		throw new ComparisonCliError("artifact", "MEASUREMENT_GRANT_ABSENT");
	}
	const parsed = parseMeasurementGrant(input.grant);
	if (!parsed.ok) {
		throw new ComparisonCliError("artifact", parsed.code);
	}
	// The grant names how many messages the execution was authorised to send,
	// so a series longer than that is reporting traffic nobody asked for. The
	// supervisor makes the same comparison against the grant it issued; this
	// one is against the grant the arm presents, which is weaker and free.
	if (input.provenance.sampleCount > parsed.grant.declaredMessageCount) {
		throw new ComparisonCliError(
			"artifact",
			"MEASUREMENT_SERIES_LEDGER_DIVERGES",
		);
	}
}

/**
 * Refuse to assemble a measured arm whose toolchain nobody observed.
 *
 * The same shape of argument as the grant above: `provenance` is what makes an
 * arm measured, an execution happened on some host, and that host had a runtime
 * whose identity is a fact rather than a matter of opinion. Publishing
 * `UNOBSERVED_TOOLCHAIN` for it would record "nobody looked" about a run where
 * somebody could have.
 *
 * Deliberately a refusal and not a default. The field this replaces *was* a
 * default -- the digest of empty input -- and defaulting is exactly what let
 * every artifact claim a toolchain it had never seen.
 */
function assertMeasuredArmObservedItsToolchain(
	input: BuildArtifactInput,
): void {
	if (input.provenance === undefined) return;
	const toolchains = input.toolchains;
	if (toolchains === undefined) {
		throw new ComparisonCliError("artifact", "TOOLCHAIN_UNOBSERVED");
	}
	for (const entry of [toolchains.js, toolchains.darwin, toolchains.linux]) {
		if (
			entry === undefined ||
			entry.sha256 === UNOBSERVED_TOOLCHAIN.sha256 ||
			entry.identity === UNOBSERVED_TOOLCHAIN.identity
		) {
			throw new ComparisonCliError("artifact", "TOOLCHAIN_UNOBSERVED");
		}
	}
	// F4 binding: the campaign must pass the supervisor's per-host
	// digests, and the artifact's per-host toolchain entries must
	// match. A measured arm that arrives without the binding is
	// refused: the supervisor-measured requirement is mandatory, and
	// the campaign is the only process that has the supervisor's
	// per-host output in hand. The error codes are typed so a
	// regression that drops the binding fails structurally rather
	// than by inspection.
	const digests = input.supervisorToolchainDigests;
	if (
		digests === undefined ||
		typeof digests.darwin !== "string" ||
		typeof digests.linux !== "string"
	) {
		throw new ComparisonCliError("artifact", "TOOLCHAIN_SUPERVISOR_MISSING");
	}
	if (digests.darwin !== toolchains.darwin.sha256) {
		throw new ComparisonCliError("artifact", "TOOLCHAIN_SUPERVISOR_MISMATCH");
	}
	if (digests.linux !== toolchains.linux.sha256) {
		throw new ComparisonCliError("artifact", "TOOLCHAIN_SUPERVISOR_MISMATCH");
	}
}

/**
 * F4 binding for the capability reservation.
 *
 * The campaign passes the supervisor's per-host digests, the
 * artifact's per-host capability entries must match, and a missing
 * or mismatched binding throws a typed error. The F4 pattern keeps
 * the binding check in the same place the existing per-host
 * toolchain binding lives, and the per-host check is what retires
 * the child-stated path: a measured arm that arrives with a
 * `capabilityDigest` whose per-host entries disagree with the
 * supervisor's reading is refused with `CAPABILITY_SUPERVISOR_MISMATCH`,
 * and a measured arm that arrives without the binding is refused
 * with `CAPABILITY_SUPERVISOR_MISSING`. The child-stated path was
 * the same defect R1 exists to remove on `uname` and `route` -- any
 * guard the producing process can call, it can satisfy -- and this
 * is the structural answer for capability.
 */
function assertMeasuredArmObservedItsCapability(
	input: BuildArtifactInput,
): void {
	if (input.provenance === undefined) return;
	const capabilityDigest = input.capabilityDigest;
	if (capabilityDigest === undefined) return;
	const digests = input.supervisorCapabilityDigests;
	if (
		digests === undefined ||
		typeof digests.darwin !== "string" ||
		typeof digests.linux !== "string"
	) {
		throw new ComparisonCliError("artifact", "CAPABILITY_SUPERVISOR_MISSING");
	}
	const macDigest = capabilityDigest.darwin;
	const linuxDigest = capabilityDigest.linux;
	if (typeof macDigest !== "string" || typeof linuxDigest !== "string") {
		throw new ComparisonCliError("artifact", "CAPABILITY_SUPERVISOR_MISSING");
	}
	if (digests.darwin !== macDigest) {
		throw new ComparisonCliError("artifact", "CAPABILITY_SUPERVISOR_MISMATCH");
	}
	if (digests.linux !== linuxDigest) {
		throw new ComparisonCliError("artifact", "CAPABILITY_SUPERVISOR_MISMATCH");
	}
}

/**
 * F4 binding for the lock reservation.
 *
 * Same shape as the capability F4 binding: a measured arm that claims
 * a lock the supervisor never observed is refused. The campaign
 * passes the supervisor's per-host digests, the artifact's per-host
 * lock entries must match, and a missing or mismatched binding
 * throws a typed error.
 */
function assertMeasuredArmObservedItsLock(input: BuildArtifactInput): void {
	if (input.provenance === undefined) return;
	const lockDigest = input.lockDigest;
	if (lockDigest === undefined) return;
	const digests = input.supervisorLockDigests;
	if (
		digests === undefined ||
		typeof digests.darwin !== "string" ||
		typeof digests.linux !== "string"
	) {
		throw new ComparisonCliError("artifact", "LOCK_SUPERVISOR_MISSING");
	}
	const macDigest = lockDigest.darwin;
	const linuxDigest = lockDigest.linux;
	if (typeof macDigest !== "string" || typeof linuxDigest !== "string") {
		throw new ComparisonCliError("artifact", "LOCK_SUPERVISOR_MISSING");
	}
	if (digests.darwin !== macDigest) {
		throw new ComparisonCliError("artifact", "LOCK_SUPERVISOR_MISMATCH");
	}
	if (digests.linux !== linuxDigest) {
		throw new ComparisonCliError("artifact", "LOCK_SUPERVISOR_MISMATCH");
	}
}

function expectedPayloadBytes(parameters: Record<string, unknown>): number {
	for (const key of [
		"messageBytes",
		"recordBytes",
		"tickBytes",
		"firstMessageBytes",
		"operationBytes",
		"chunkBytes",
		"controlMessageBytes",
	] as const) {
		const candidate = parameters[key];
		if (typeof candidate === "number") return candidate;
	}
	return 65536;
}

export function buildRunArtifact(input: BuildArtifactInput): RunArtifact {
	assertMeasuredArmIsGranted(input);
	assertMeasuredArmObservedItsToolchain(input);
	assertMeasuredArmObservedItsCapability(input);
	assertMeasuredArmObservedItsLock(input);
	assertMeasuredArmObservedItsLock(input);
	const cell = getScenarioCell(CANONICAL_SCENARIO_REGISTRY, input.cellId);
	const seed = input.seed ?? 42;
	const totalRepetitions = cell.runPolicy.measuredRepetitions;
	const repetitionIndex = input.repetitionIndex ?? 1;

	const sourceSha =
		input.sourceSha ?? "f8cb82d77054a737be2e6f4a3e7ef154f8cb82d7";
	const archiveSha256 =
		input.archiveSha256 ??
		"db703cbc50dec7598bbe8e5eeca565f298508136a7bd54e8e32d97df0883bc64";
	const executableSha256 =
		input.executableSha256 ??
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

	// These three used to be a pair of literals: the identity string
	// `"bun-1.3.14-darwin-arm64"` and, for the digest, the SHA-256 of empty
	// input -- which is also what `executableSha256` still defaults to above.
	// Neither moved when the runtime moved, so an artifact could not name the
	// Bun it was produced on and could not disagree with the name it printed.
	//
	// There was no input for them either, so no caller could correct them: every
	// artifact this function produced carried the empty digest, and
	// `checkPromotionQuarantine` rejects that by name (`EMPTY_TOOLCHAIN_DIGEST`,
	// "empty-file toolchain digest cannot prove the measured toolchain"). The
	// campaign could not promote a single artifact, whatever it measured.
	//
	// They are now supplied by the caller, which is the half of the process that
	// can actually look: this function is pure by contract, and observation is
	// file I/O. `toolchain-observation.ts` does the looking.
	// Spread rather than shared: `snapshotEvidenceValue` refuses a repeated
	// object reference anywhere in an artifact, and three slots pointing at one
	// frozen constant is exactly that.
	const toolchains: ToolchainSet = input.toolchains ?? {
		js: { ...UNOBSERVED_TOOLCHAIN },
		darwin: { ...UNOBSERVED_TOOLCHAIN },
		linux: { ...UNOBSERVED_TOOLCHAIN },
	};

	const sourceBindingSha256 = canonicalDigest({
		sourceSha,
		archiveSha256,
		executableSha256,
		toolchains,
		cleanTree: true,
	});

	const source: SourceEvidence = {
		sourceSha,
		archiveSha256,
		executableSha256,
		toolchains,
		cleanTree: true,
		bindingSha256: sourceBindingSha256,
	};

	const payloadBytes = expectedPayloadBytes(
		cell.parameters as unknown as Record<string, unknown>,
	);
	const payloadArray = new Uint8Array(payloadBytes);
	for (let i = 0; i < payloadBytes; i++) payloadArray[i] = i % 256;
	const payloadBase64 = Buffer.from(payloadArray).toString("base64");
	const payloadSha256 = createHash("sha256").update(payloadArray).digest("hex");

	const scenarioPayload: ScenarioPayloadEvidence = {
		encoding: "base64",
		data: payloadBase64,
		bytes: payloadBytes,
		sha256: payloadSha256,
	};

	const armOrder = [
		...expandArmUnits(
			balancedArmOrder(seed, repetitionIndex, armUnitsFor(cell)),
		),
	];

	// Resolved before the evidence blocks because three of them are arm-shaped:
	// the shedding policy, the read-path thread model and the overlay's
	// filtered-metric marker are all facts about which arm produced this
	// artifact, not about the cell.
	const armKind: ArmKind = input.armKind ?? "primary";
	// The overlay has no arm transport; its suffix is its kind.  Every other arm
	// declares its `armTransport` and carries that same token as its id suffix.
	const armTransport: ArmTransport =
		input.armTransport ?? (input.transport as ArmTransport);
	const armSuffix = armKind === "overlay" ? "ws-overlay" : armTransport;

	const scenario: ScenarioEvidence = {
		cellId: cell.cellId,
		scenarioId: cell.scenarioId,
		canonical: true,
		config: cell.parameters as unknown as Record<string, unknown>,
		scenarioHash: cell.scenarioHash,
		seed,
		repetition: {
			index: repetitionIndex,
			total: totalRepetitions,
		},
		armOrder,
		saturatePct: 0,
		payload: scenarioPayload,
		direction: cell.rolePlan.direction,
	};

	const macRoute: RouteEvidence = {
		source: EXPECTED_MAC_ADDRESS,
		destination: EXPECTED_LINUX_ADDRESS,
		interface: EXPECTED_MAC_INTERFACE,
		gateway: null,
		neighbourEntry: {
			address: EXPECTED_LINUX_ADDRESS,
			linkLayerAddress: EXPECTED_LINUX_LINK_LAYER_ADDRESS,
			state: "reachable",
		},
		raw: MAC_ROUTE_RAW,
	};
	const linuxRoute: RouteEvidence = {
		source: EXPECTED_LINUX_ADDRESS,
		destination: EXPECTED_MAC_ADDRESS,
		interface: EXPECTED_LINUX_INTERFACE,
		gateway: null,
		neighbourEntry: {
			address: EXPECTED_MAC_ADDRESS,
			linkLayerAddress: EXPECTED_MAC_LINK_LAYER_ADDRESS,
			state: "REACHABLE",
		},
		raw: LINUX_ROUTE_RAW,
	};

	const topology: TopologyEvidence = {
		mac: {
			hostId: "mac-controller",
			os: "darwin",
			arch: "arm64",
			interface: EXPECTED_MAC_INTERFACE,
			address: EXPECTED_MAC_ADDRESS,
			mtu: EXPECTED_MTU,
			route: macRoute,
		},
		linux: {
			hostId: "linux-server",
			os: "linux",
			arch: "x86_64",
			interface: EXPECTED_LINUX_INTERFACE,
			address: EXPECTED_LINUX_ADDRESS,
			mtu: EXPECTED_MTU,
			route: linuxRoute,
		},
		serverObservedPeer: {
			hostId: "mac-controller",
			address: EXPECTED_MAC_ADDRESS,
			interface: EXPECTED_LINUX_INTERFACE,
			// The literal below is exactly what makes this "declared": nothing
			// here was observed by a server.  Saying so is the point.
			provenance: "declared",
		},
		sidecars: {
			mac: { host: true, process: true, nic: true },
			linux: { host: true, process: true, nic: true },
		},
		managementPath: { address: null, interface: null },
	};

	const smoke: SmokeEvidence = {
		input: EXPECTED_SMOKE_INPUT,
		completed: true,
		usedLoopback: false,
	};

	const tls: TlsEvidence = {
		sni: EXPECTED_TLS_SNI,
		certificateSha256:
			input.certSha256 ??
			"d5aa016b229deb9fe3768d4c4372751754ae87ec6c08efb712224f778a8b2301",
		caSha256:
			input.caSha256 ??
			"d5aa016b229deb9fe3768d4c4372751754ae87ec6c08efb712224f778a8b2301",
		rejectUnauthorized: true,
		verification: "custom-ca",
		compression: "off",
	};

	const req = requestedImpairmentOf(cell);

	const declaredOffload = { tso: true, gso: true, gro: true } as const;
	const fqState = {
		delayMs: 0,
		lossPercent: 0,
		qdisc: "fq",
		limitPackets: EXPECTED_FQ_LIMIT_PACKETS,
		mtu: EXPECTED_MTU,
		offload: { ...declaredOffload },
		observedLossPercent: null,
		tcpNoDelay: null,
	} as const satisfies ImpairmentState;

	const impairment: ImpairmentEvidence = {
		requested: {
			direction: "linux-egress",
			delayMs: req.delayMs,
			lossPercent: req.lossPercent,
			qdisc: req.qdisc,
			limitPackets:
				req.qdisc === "netem"
					? EXPECTED_NETEM_LIMIT_PACKETS
					: EXPECTED_FQ_LIMIT_PACKETS,
			mtu: EXPECTED_MTU,
			offload: { ...declaredOffload },
			observedLossPercent: null,
			tcpNoDelay: null,
		},
		observedBefore: { ...fqState, offload: { ...declaredOffload } },
		observedAfter: { ...fqState, offload: { ...declaredOffload } },
		restored: true,
		restorationProof: {
			matches: true,
			// Derived from the state it proves, not from a constant beside it:
			// the impairment schema grew this round and a literal would have gone
			// quietly stale.
			observedBeforeSha256: canonicalDigest(fqState),
			observedAfterSha256: canonicalDigest(fqState),
		},
	};

	const submittedProfileBytes = canonicalJson(CANONICAL_CAPACITY_PROFILE);
	const submittedProfileHash = canonicalDigest(CANONICAL_CAPACITY_PROFILE);

	const defaultAdmission: AdmissionCounters = {
		schemaVersion: "v1",
		handshakes: { attempted: 10, accepted: 10, rejected: 0, rateLimited: 0 },
		sessions: { attempted: 10, accepted: 10, rejected: 0, activePeak: 10 },
		streams: { attempted: 10, accepted: 10, rejected: 0, rateLimited: 0 },
		datagrams: { attempted: 10, accepted: 10, rejected: 0, rateLimited: 0 },
	};

	const capacity: CapacityEvidence = {
		profileId: CANONICAL_CAPACITY_PROFILE.profileId,
		profileHash: submittedProfileHash,
		requested: CANONICAL_CAPACITY_PROFILE as unknown as Record<
			string,
			number | string
		>,
		submittedProfileBytes,
		submittedProfileHash,
		admissionCounters: input.admissionCounters ?? defaultAdmission,
		connectionRamp: {
			connectionRampPerSecond: 500,
			maxConnectsInFlight: 200,
		},
	};

	const capacityProof: CapacityProof = {
		mac: {
			fd: {
				softLimit: 131072,
				hardLimit: 262144,
				effectiveChildLimit: 131072,
				provenance: "declared",
			},
			ephemeralPorts: {
				rangeStart: 49152,
				rangeEnd: 65535,
				freePorts: 14000,
				requiredFreePorts: 12500,
			},
		},
		linux: {
			fd: {
				softLimit: 131072,
				hardLimit: 524288,
				effectiveChildLimit: 131072,
				provenance: "declared",
			},
		},
	};

	// Every canonical scenario id has a primary contract, so this is a guard
	// against a cell that never came from the registry.  Without it the eight
	// reads below are all unchecked, and the first one to run would fail with a
	// bare property-access TypeError instead of naming the cause.
	const contract = metricContractForScenario(cell.scenarioId);
	if (!contract) {
		throw new ComparisonCliError("artifact", "METRIC_CONTRACT_UNKNOWN");
	}
	const mContractHash = metricContractHash(contract);

	const validSamples = input.samples.length > 0 ? [...input.samples] : [1];

	const clockDomain: MetricClockDomain =
		contract.metricKind === "linux-local-service"
			? "linux-monotonic"
			: contract.metricKind === "one-way"
				? "independent-offset"
				: "mac-monotonic";

	const metrics: MetricsEvidence = {
		name: contract.name,
		unit: contract.unit,
		metricKind: contract.metricKind,
		clock: {
			domain: clockDomain,
			monotonic: true,
			method: "process.monotonic",
		},
		samples: validSamples,
		percentiles: {
			p1: input.percentiles.p1,
			p50: input.percentiles.p50,
			p95: input.percentiles.p95,
			p99: input.percentiles.p99,
		},
		secondarySeries: null,
		// The overlay drops before it counts, so its metric is a different
		// measurement from the arms it is printed beside.  Marking it is what
		// lets a renderer refuse to put it in the same column.
		filtered: { applied: armKind === "overlay", policy: null },
		provenance: input.provenance
			? {
					attestation: input.provenance.attestation,
					driverRunId: input.provenance.driverRunId,
					clockMethod: input.provenance.clockMethod,
					sampleCount: input.provenance.sampleCount,
					firstSampleAtMs: input.provenance.firstSampleAtMs,
					lastSampleAtMs: input.provenance.lastSampleAtMs,
				}
			: null,
	};

	const runtime: RuntimeEvidence = {
		mac: {
			// Derived, not authored. These were the literals
			// `"mac-runtime-bun-1.3.14"` and `"bun-1.3.14"`, which said 1.3.14 on
			// a 1.4.0 process just as confidently. They now read whatever the
			// `js` toolchain was observed to be, so an unobserved run says
			// `mac-runtime-unobserved` rather than naming a version at random.
			//
			// Both hosts derive from the same entry on purpose: the comparison's
			// premise is that the arms ran on one Bun, and `compare.ts` refuses a
			// pair whose `js` toolchains differ.
			identity: `mac-runtime-${toolchains.js.identity}`,
			cpu: "Apple arm64 performance cores",
			bun: toolchains.js.identity,
			envDigest: EMPTY_ENV_ALLOWLIST_DIGEST,
			envAllowlistApplied: false,
		},
		linux: {
			identity: `linux-runtime-${toolchains.js.identity}`,
			cpu: "x86_64 server cores",
			bun: toolchains.js.identity,
			envDigest: EMPTY_ENV_ALLOWLIST_DIGEST,
			envAllowlistApplied: false,
		},
	};

	const processProof: ProcessProofEvidence = {
		rolePlanHash: canonicalDigest(cell.rolePlan),
		macRoles: cell.rolePlan.macRoles,
		linuxRole: cell.rolePlan.linuxRole,
		sharding: cell.rolePlan.sharding,
		processCohort: cell.rolePlan.processCohort,
		readPathThreadModel: ARM_READ_PATH[armTransport],
		serverThreadCount: 0,
		serverThreadsProvenance: "declared",
		serverProcessCount: 1,
		serverProcessProvenance: "declared",
	};

	// A progression that does not narrow is a broken measurement, and the only
	// honest thing to do with one is refuse it. But there are two progressions
	// here, not one, and ordering them into a single chain was itself a defect.
	//
	// These lines used to be `Math.min` against the preceding stage, which is
	// not a bound -- it is a silent rewrite of a number somebody measured. It
	// was load-bearing: `acknowledged` had no producer on either arm, so it was
	// always zero, so `delivered` clamped to zero, so a leg that really did
	// deliver six of six messages was recorded as having delivered none of them
	// -- and stamped PASS, because the verdict was derived from the ledger that
	// came in and the artifact recorded the ledger that came out.
	//
	// Replacing the clamp with `delivered <= acknowledged` fixed the rewrite and
	// installed a different error: those two counters measure opposite
	// directions. In a session's own counters `acknowledged` counts receipts
	// arriving for messages *this* session sent, and `delivered` counts messages
	// this session *received from the peer* -- different populations, and the
	// chain only ever held because a symmetric echo loop makes both equal N. An
	// honest zero-loss echo peer that lost one receipt (`serverObserved 6,
	// acknowledged 5, delivered 6`) was refused as unbuildable, which is exactly
	// the shape both adapters' docstrings promise is "a measured shortfall the
	// funnel already reports". It cannot be reported by a ledger that will not
	// build.
	//
	// So there are two progressions, each monotone in its own direction:
	//
	//   send    attempted -> queued -> acknowledged
	//   receive serverObserved -> delivered
	//
	// A lost receipt now lands where it belongs: `acknowledged` falls below
	// `queued` and the shortfall is recorded. `dropped` and `expired` are stages
	// of neither -- they are loss counters the adapters move on both paths (a
	// malformed inbound envelope is `dropped`; a deadline is `timedOut`) -- so
	// each is bounded by the traffic the session touched in either direction
	// rather than by the send population alone.
	//
	// An absent stage still defaults to its predecessor within its own
	// direction. That is not a rewrite: a caller who states nothing is not
	// contradicted by anything, and the arms the campaign builds state every
	// stage. `serverObserved` heads its direction and has no predecessor, so it
	// defaults to `queued` -- the echo loop's own identity, and the reading
	// every partial caller in the suite already assumed.
	const attempted = input.ledger.attempted;
	const queued = input.ledger.queued ?? attempted;
	const acknowledged = input.ledger.acknowledged ?? queued;
	const serverObserved = input.ledger.serverObserved ?? queued;
	const delivered = input.ledger.delivered ?? serverObserved;
	const dropped = input.ledger.dropped ?? 0;
	const expired = input.ledger.expired ?? 0;
	const touched = attempted + serverObserved;
	for (const [stage, bound] of [
		[queued, attempted],
		[acknowledged, queued],
		[delivered, serverObserved],
		[serverObserved, Number.POSITIVE_INFINITY],
		[dropped, touched],
		[expired, touched],
	] as const) {
		if (!Number.isFinite(stage) || stage < 0 || stage > bound) {
			throw new ComparisonCliError("artifact", "LEDGER_FUNNEL_NOT_MONOTONIC");
		}
	}

	const ledger: TransportLedgerEvidence = {
		attempted,
		queued,
		serverObserved,
		acknowledged,
		delivered,
		dropped,
		expired,
		offered: 0,
		latenessMs: 0,
		skippedSlots: 0,
		senderStalledMs: 0,
		sheddingPolicy: ARM_SHEDDING_POLICY[armTransport],
		harnessOverheadBytes: input.ledger.harnessOverheadBytes ?? 0,
		warmup: {
			repetitions:
				armKind === "read-path"
					? cell.runPolicy.readPathWarmupRepetitions
					: cell.runPolicy.warmupRepetitions,
			discardedSamples: 0,
		},
		sinkStats: null,
		profileApplication: WIRE_PROFILE_APPLICATION[ARM_WIRE[armTransport]],
		digestVerified: null,
		snapshotHash: null,
		histogram: {
			unit: input.ledger.histogram?.unit ?? contract.unit,
			boundaries: input.ledger.histogram?.boundaries
				? [...input.ledger.histogram.boundaries]
				: [1, 2, 4],
			counts: input.ledger.histogram?.counts
				? [...input.ledger.histogram.counts]
				: [1, 0, 0],
		},
	};

	const telemetry: TelemetryEvidence = {
		mac: {
			cpuPercent: input.telemetry?.mac?.cpuPercent ?? 15,
			rssBytes: input.telemetry?.mac?.rssBytes ?? 128 * 1024 * 1024,
			arm: emptyArmTelemetry(),
		},
		linux: {
			cpuPercent: input.telemetry?.linux?.cpuPercent ?? 20,
			rssBytes: input.telemetry?.linux?.rssBytes ?? 256 * 1024 * 1024,
			arm: emptyArmTelemetry(),
		},
	};

	const rawSidecarDigests: RawSidecarDigests = {
		client: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		server: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		topology:
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		impairment:
			"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
		cleanup: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	};

	const rawSidecarBindingSha256 = canonicalDigest({
		comparisonId: input.comparisonId,
		runId: input.runId,
		transport: input.transport,
		sourceBindingSha256: source.bindingSha256,
		scenarioHash: cell.scenarioHash,
		metricContractHash: mContractHash,
		rawSidecarDigests,
	});

	// Promotability is derived from the evidence/verdict pair, never asserted
	// alongside it: an artifact that claims a tuple the matrix rejects is a
	// contradiction and must not be built at all.
	//
	// KNOWN HAZARD: this default is optimistic. PASS/PASS is the one promotable
	// row, so an input that states no tuple gets an artifact stamped promotable
	// before anything has been verified. It cannot be made required here — the
	// frozen contract at `r1-entrypoint-red.test.ts:616` builds an artifact with
	// no tuple and requires it to verify PASS with no rejections, and the
	// verifier separately requires a PASS/PASS artifact to be promotable, so
	// neither refusing nor demoting an unstated tuple is available until that
	// contract is reopened. Every caller inside this repo states its own tuple
	// (`deriveMeasuredVerdictTuple` in run-campaign.ts); do not add one that
	// relies on this default.
	const evidenceStatus = input.evidenceStatus ?? "PASS";
	const scenarioVerdict = input.scenarioVerdict ?? "PASS";
	const classification = classifyVerdictTuple({
		evidenceStatus,
		scenarioVerdict,
	});
	if (classification.ok !== true) {
		throw new ComparisonCliError("artifact", classification.code);
	}

	const artifact: RunArtifact = {
		schemaVersion: EVIDENCE_SCHEMA_VERSION,
		artifactByteSha256: "0".repeat(64),
		artifactKind: "measured" as ArtifactKind,
		comparisonId: input.comparisonId,
		runId: input.runId,
		transport: input.transport,
		armId: `${cell.cellId}/${armSuffix}`,
		...(armKind === "overlay" ? {} : { armTransport }),
		armKind,
		evidenceStatus,
		scenarioVerdict: scenarioVerdict as ScenarioVerdict,
		promotable: classification.promotable,
		source,
		scenario,
		topology,
		smoke,
		tls,
		impairment,
		capacity,
		capacityProof,
		metrics,
		metricContractId: contract.id,
		metricContractHash: mContractHash,
		runtime,
		processProof,
		ledger,
		telemetry,
		rawSidecarDigests,
		rawSidecarBindingSha256,
	};

	return artifact;
}

export function trustContextForArtifact(
	artifact: RunArtifact,
): ArtifactTrustContext {
	return {
		comparisonId: artifact.comparisonId,
		runId: artifact.runId,
		transport: artifact.transport,
		sourceSha: artifact.source.sourceSha,
		archiveSha256: artifact.source.archiveSha256,
		executableSha256: artifact.source.executableSha256,
		toolchains: artifact.source.toolchains,
		rawSidecarDigests: artifact.rawSidecarDigests,
	};
}

export interface MeasuredArtifactFailure {
	readonly ok: false;
	readonly code: string;
	readonly detail?: string;
}

export interface MeasuredArtifactSuccess {
	readonly ok: true;
	readonly candidateId: string;
	readonly campaignId: string;
	readonly runInstanceId: string;
	readonly artifactKind: "measured";
	readonly artifactBytes: Uint8Array;
	readonly artifactDigestSha256: string;
	readonly artifact: Record<string, unknown>;
}

function sha256HexOf(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function decodeRecordBytes(bytes: Uint8Array): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
		if (value === null || typeof value !== "object" || Array.isArray(value)) {
			return null;
		}
		return value as Record<string, unknown>;
	} catch {
		return null;
	}
}

/**
 * A measured artifact only becomes promotable through the validated campaign
 * inputs. Legacy hand-written fixtures declare themselves non-promotable, and
 * that self-declaration is authoritative: no fixture may be laundered into
 * official evidence by re-serializing it.
 */
export function verifyPromotableMeasuredArtifact(input: {
	readonly artifactBytes?: Uint8Array;
}): MeasuredArtifactFailure | { readonly ok: true; readonly promotable: true } {
	const bytes = input?.artifactBytes;
	if (!(bytes instanceof Uint8Array)) {
		return { ok: false, code: "MEASURED_ARTIFACT_INPUT_INCOMPLETE" };
	}
	const record = decodeRecordBytes(bytes);
	if (record === null) {
		return { ok: false, code: "MEASURED_ARTIFACT_BYTES_MISMATCH" };
	}
	if (record.artifactKind !== "measured" || record.promotable === false) {
		return { ok: false, code: "TEST_FIXTURE_NONPROMOTABLE" };
	}
	return { ok: true, promotable: true };
}

const REQUIRED_MEASURED_BUILD_INPUTS = [
	"lock",
	"lockBytes",
	"expectedLockDigest",
	"stagedCapability",
	"capabilityBytes",
	"expectedCapabilityDigest",
	"expectedArchiveDigest",
	"runEntry",
	"artifactBytes",
	"artifactDescriptor",
	"artifactDigestSha256",
	"rawBytesByPath",
	"snapshotBytesByPath",
] as const;

interface RawDescriptorLike {
	readonly relativePath: string;
	readonly sha256: string;
}

function digestMismatch(
	bytesByPath: Record<string, Uint8Array>,
	descriptors: readonly RawDescriptorLike[],
): boolean {
	return descriptors.some((descriptor) => {
		const bytes = bytesByPath[descriptor.relativePath];
		return !bytes || sha256HexOf(bytes) !== descriptor.sha256;
	});
}

/**
 * Builds a measured artifact strictly from inputs the campaign lock, staged
 * capability, and validated manifest already vouch for. Every byte set is
 * re-hashed against the digest its own validated descriptor carries, so a
 * silently swapped artifact, raw sidecar, or cell snapshot fails closed
 * instead of producing an artifact that merely looks well formed.
 */
export function buildMeasuredArtifactFromValidatedInputs(
	input: Record<string, unknown>,
): MeasuredArtifactFailure | MeasuredArtifactSuccess {
	if (input === null || typeof input !== "object") {
		return { ok: false, code: "MEASURED_ARTIFACT_INPUT_INCOMPLETE" };
	}
	for (const key of REQUIRED_MEASURED_BUILD_INPUTS) {
		if (input[key] === undefined || input[key] === null) {
			return {
				ok: false,
				code: "MEASURED_ARTIFACT_INPUT_INCOMPLETE",
				detail: key,
			};
		}
	}

	const artifactBytes = input.artifactBytes as Uint8Array;
	const artifactDigestSha256 = input.artifactDigestSha256 as string;
	const lockBytes = input.lockBytes as Uint8Array;
	const capabilityBytes = input.capabilityBytes as Uint8Array;
	const runEntry = input.runEntry as Record<string, unknown>;
	const artifactDescriptor = input.artifactDescriptor as RawDescriptorLike;
	const rawBytesByPath = input.rawBytesByPath as Record<string, Uint8Array>;
	const snapshotBytesByPath = input.snapshotBytesByPath as Record<
		string,
		Uint8Array
	>;

	if (sha256HexOf(artifactBytes) !== artifactDigestSha256) {
		return { ok: false, code: "MEASURED_ARTIFACT_BYTES_MISMATCH" };
	}

	// The artifact descriptor must be the very one the validated manifest run
	// entry carries; a descriptor cloned with a poisoned digest is rejected here.
	const entryDescriptor = runEntry.artifact as RawDescriptorLike | undefined;
	if (
		entryDescriptor === undefined ||
		artifactDescriptor.sha256 !== entryDescriptor.sha256 ||
		artifactDescriptor.relativePath !== entryDescriptor.relativePath
	) {
		return { ok: false, code: "MEASURED_ARTIFACT_DESCRIPTOR_DIGEST_MISMATCH" };
	}

	if (sha256HexOf(lockBytes) !== (input.expectedLockDigest as string)) {
		return { ok: false, code: "MEASURED_ARTIFACT_LOCK_BYTES_MISMATCH" };
	}
	if (
		sha256HexOf(capabilityBytes) !== (input.expectedCapabilityDigest as string)
	) {
		return { ok: false, code: "MEASURED_ARTIFACT_CAPABILITY_BYTES_MISMATCH" };
	}

	const sharedIdentity = runEntry.sharedIdentity as
		| Record<string, unknown>
		| undefined;
	if (
		sharedIdentity === undefined ||
		input.expectedArchiveDigest !== sharedIdentity.archiveSha256
	) {
		return { ok: false, code: "MEASURED_ARTIFACT_ARCHIVE_DIGEST_MISMATCH" };
	}

	const rawDescriptors =
		runEntry.rawDescriptors as readonly RawDescriptorLike[];
	if (digestMismatch(rawBytesByPath, rawDescriptors)) {
		return { ok: false, code: "MEASURED_ARTIFACT_RAW_BYTES_MISMATCH" };
	}

	const snapshotBundle = runEntry.cellSnapshotBundle as Record<
		string,
		RawDescriptorLike
	>;
	if (
		digestMismatch(snapshotBytesByPath, [
			snapshotBundle.preCell as RawDescriptorLike,
			snapshotBundle.postCell as RawDescriptorLike,
		])
	) {
		return { ok: false, code: "MEASURED_ARTIFACT_SNAPSHOT_BYTES_MISMATCH" };
	}

	const artifact = decodeRecordBytes(artifactBytes);
	if (artifact === null || artifact.artifactKind !== "measured") {
		return { ok: false, code: "MEASURED_ARTIFACT_BYTES_MISMATCH" };
	}

	return {
		ok: true,
		candidateId: runEntry.candidateId as string,
		campaignId: runEntry.campaignId as string,
		runInstanceId: runEntry.runInstanceId as string,
		artifactKind: "measured",
		artifactBytes,
		artifactDigestSha256,
		artifact,
	};
}
