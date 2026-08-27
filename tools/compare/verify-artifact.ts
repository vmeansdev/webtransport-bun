import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Canonical } from "./canonical.ts";
import {
	type ArtifactBytes,
	type ArtifactRejection,
	type ArtifactRejectionCode,
	type ArtifactTrustContext,
	type ArtifactVerification,
	addRejection,
	artifactByteSha256,
	artifactInputBytes,
	ARM_SLOTS,
	armIdentityIssue,
	type ArmSlot,
	balancedArmOrder,
	expandArmUnits,
	EVIDENCE_SCHEMA_VERSION,
	EXPECTED_LINUX_ADDRESS,
	EXPECTED_LINUX_INTERFACE,
	EXPECTED_MAC_ADDRESS,
	EXPECTED_MAC_INTERFACE,
	EXPECTED_MTU,
	EXPECTED_SMOKE_INPUT,
	EXPECTED_TLS_SNI,
	findDuplicateJsonKey,
	type HostEvidence,
	isBase64,
	isSha1,
	isSha256,
	MAX_ARTIFACT_BYTES,
	MAX_ARTIFACT_SAMPLES,
	MAX_PAYLOAD_BASE64_LENGTH,
	MAX_SUPPORTED_PAYLOAD_BYTES,
	MIN_EFFECTIVE_CHILD_NOFILE,
	classifyVerdictTuple,
	ComparisonCliError,
	comparisonErrorCode,
	metricContractForScenario,
	metricContractHash,
	parseRecoveryMode,
	parseStagedTrustArgv,
	type RunArtifact,
	snapshotEvidenceValue,
	type StagedTrustArgs,
	validateFixtureOnlyEntrypoint,
	validateOfficialEntrypointContract,
} from "./evidence.ts";
import {
	assertOfficialComparisonIoAvailable,
	checkPromotionQuarantine,
	readOfficialComparisonFile,
	resolveOfficialComparisonOutputDir,
	resolveOfficialComparisonOutputFile,
} from "./output-policy.ts";
import {
	CANONICAL_CAPACITY_PROFILE,
	CANONICAL_CONNECTION_SETUP,
	armEligibilityFor,
	armUnitsFor,
	CANONICAL_SCENARIO_REGISTRY,
	getScenarioCell,
	requestedImpairmentOf,
} from "./scenario-registry.ts";
import { sampleSummary } from "./stats.ts";

const EXPECTED_ADMISSION_KEYS = [
	"schemaVersion",
	"handshakes",
	"sessions",
	"streams",
	"datagrams",
] as const;
const EXPECTED_COUNTER_KEYS: Readonly<Record<string, readonly string[]>> = {
	handshakes: ["attempted", "accepted", "rejected", "rateLimited"],
	sessions: ["attempted", "accepted", "rejected", "activePeak"],
	streams: ["attempted", "accepted", "rejected", "rateLimited"],
	datagrams: ["attempted", "accepted", "rejected", "rateLimited"],
};
const EXPECTED_SIDECAR_KEYS = [
	"client",
	"server",
	"topology",
	"impairment",
	"cleanup",
] as const;
const EXPECTED_SOURCE_KEYS = [
	"sourceSha",
	"archiveSha256",
	"executableSha256",
	"toolchain",
	"cleanTree",
	"bindingSha256",
] as const;
const EXPECTED_TOP_LEVEL_KEYS = [
	"schemaVersion",
	"artifactByteSha256",
	"artifactKind",
	"comparisonId",
	"runId",
	"transport",
	"armId",
	"armTransport",
	"armKind",
	"evidenceStatus",
	"scenarioVerdict",
	"promotable",
	"source",
	"scenario",
	"topology",
	"smoke",
	"tls",
	"impairment",
	"capacity",
	"capacityProof",
	"metrics",
	"metricContractId",
	"metricContractHash",
	"runtime",
	"processProof",
	"ledger",
	"telemetry",
	"rawSidecarDigests",
	"rawSidecarBindingSha256",
] as const;
const EXPECTED_METRIC_KINDS = [
	"mac-local-end-to-end",
	"linux-local-service",
	"one-way",
] as const;
const EXPECTED_CLOCK_DOMAINS = [
	"mac-monotonic",
	"linux-monotonic",
	"independent-offset",
] as const;
const INITIAL_IMPAIRMENT = Object.freeze({
	qdisc: "fq" as const,
	delayMs: 0,
	lossPercent: 0,
});

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function field(
	value: Record<string, unknown> | undefined,
	key: string,
): unknown {
	return value && Object.hasOwn(value, key) ? value[key] : undefined;
}

function verifyTrustContext(
	value: unknown,
	artifact: Record<string, unknown>,
	rejections: ArtifactRejection[],
): void {
	let context: Record<string, unknown> | undefined;
	if (value !== undefined) {
		try {
			context = record(snapshotEvidenceValue(value));
		} catch {
			addRejection(
				rejections,
				"TRUST_CONTEXT_INVALID",
				"verification context cannot be safely snapshotted",
				"$.verificationContext",
			);
			return;
		}
	}
	if (!context) {
		addRejection(
			rejections,
			"TRUST_CONTEXT_MISSING",
			"external source/run/comparison trust anchors are required",
			"$.verificationContext",
		);
		return;
	}
	const transport = field(artifact, "transport");
	const expected = [
		"comparisonId",
		"runId",
		"transport",
		"sourceSha",
		"archiveSha256",
		"executableSha256",
		"toolchain",
		"rawSidecarDigests",
	];
	requireKeys(context, expected, "$.verificationContext", rejections);
	const checks: readonly [string, unknown, unknown][] = [
		[
			"comparisonId",
			field(context, "comparisonId"),
			field(artifact, "comparisonId"),
		],
		["runId", field(context, "runId"), field(artifact, "runId")],
		["transport", field(context, "transport"), transport],
		[
			"sourceSha",
			field(context, "sourceSha"),
			field(record(field(artifact, "source")), "sourceSha"),
		],
		[
			"archiveSha256",
			field(context, "archiveSha256"),
			field(record(field(artifact, "source")), "archiveSha256"),
		],
		[
			"executableSha256",
			field(context, "executableSha256"),
			field(record(field(artifact, "source")), "executableSha256"),
		],
		[
			"toolchain",
			field(context, "toolchain"),
			field(record(field(artifact, "source")), "toolchain"),
		],
		[
			"rawSidecarDigests",
			field(context, "rawSidecarDigests"),
			field(artifact, "rawSidecarDigests"),
		],
	];
	for (const [name, expectedValue, actualValue] of checks) {
		if (!compareCanonical(expectedValue, actualValue))
			addRejection(
				rejections,
				"TRUST_ANCHOR_MISMATCH",
				`verification context ${name} does not match the artifact`,
				`$.verificationContext.${name}`,
			);
	}
	const expectedArtifactDigest = field(context, "artifactByteSha256");
	if (
		expectedArtifactDigest !== undefined &&
		(!isSha256(expectedArtifactDigest) ||
			expectedArtifactDigest !== field(artifact, "artifactByteSha256"))
	)
		addRejection(
			rejections,
			"TRUST_ANCHOR_MISMATCH",
			"verification context artifact digest does not match",
			"$.verificationContext.artifactByteSha256",
		);
}

function requireKeys(
	value: Record<string, unknown> | undefined,
	keys: readonly string[],
	path: string,
	rejections: ArtifactRejection[],
): void {
	if (!value) {
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			`${path} must be an object`,
			path,
		);
		return;
	}
	const allowed = new Set(keys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key))
			addRejection(
				rejections,
				"SCHEMA_UNKNOWN_FIELD",
				`${path}.${key} is not allowed`,
				`${path}.${key}`,
			);
	}
	for (const key of keys) {
		if (!Object.hasOwn(value, key) || value[key] === undefined) {
			addRejection(
				rejections,
				"SCHEMA_OWN_FIELD_REQUIRED",
				`${path}.${key} must be an own field`,
				`${path}.${key}`,
			);
		}
	}
}

function stringField(
	value: unknown,
	path: string,
	rejections: ArtifactRejection[],
	options: { nonEmpty?: boolean } = {},
): value is string {
	if (
		typeof value !== "string" ||
		(options.nonEmpty === true && value.length === 0)
	) {
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			`${path} must be a non-empty string`,
			path,
		);
		return false;
	}
	return true;
}

function boolField(
	value: unknown,
	path: string,
	rejections: ArtifactRejection[],
): value is boolean {
	if (typeof value !== "boolean") {
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			`${path} must be boolean`,
			path,
		);
		return false;
	}
	return true;
}

function finiteNumber(
	value: unknown,
	path: string,
	rejections: ArtifactRejection[],
	integer = false,
): value is number {
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		(integer && !Number.isSafeInteger(value))
	) {
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			`${path} must be finite${integer ? " safe integer" : ""}`,
			path,
		);
		return false;
	}
	return true;
}

function safePositive(
	value: unknown,
	path: string,
	rejections: ArtifactRejection[],
): value is number {
	if (!finiteNumber(value, path, rejections, true) || value <= 0) {
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			`${path} must be a positive safe integer`,
			path,
		);
		return false;
	}
	return true;
}

function safeNonNegative(
	value: unknown,
	path: string,
	rejections: ArtifactRejection[],
): value is number {
	if (!finiteNumber(value, path, rejections, true) || value < 0) {
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			`${path} must be a non-negative safe integer`,
			path,
		);
		return false;
	}
	return true;
}

function compareCanonical(left: unknown, right: unknown): boolean {
	try {
		return canonicalJson(left) === canonicalJson(right);
	} catch {
		return false;
	}
}

function verifyTopLevelShape(
	value: unknown,
	rejections: ArtifactRejection[],
): value is RunArtifact {
	const root = record(value);
	if (!root) {
		addRejection(
			rejections,
			"SCHEMA_ROOT_INVALID",
			"artifact root must be an object",
			"$",
		);
		return false;
	}
	requireKeys(root, EXPECTED_TOP_LEVEL_KEYS, "$", rejections);
	return true;
}

function verifyIdentity(
	artifact: Record<string, unknown>,
	rejections: ArtifactRejection[],
): void {
	if (field(artifact, "schemaVersion") !== EVIDENCE_SCHEMA_VERSION)
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			`schemaVersion must be ${EVIDENCE_SCHEMA_VERSION}`,
			"$.schemaVersion",
		);
	const artifactDigest = field(artifact, "artifactByteSha256");
	if (!isSha256(artifactDigest)) {
		addRejection(
			rejections,
			artifactDigest === undefined
				? "ARTIFACT_BYTE_DIGEST_MISSING"
				: "ARTIFACT_BYTE_DIGEST_INVALID",
			"artifactByteSha256 must be lowercase SHA-256",
			"$.artifactByteSha256",
		);
	}
	const comparisonId = field(artifact, "comparisonId");
	if (
		!stringField(comparisonId, "$.comparisonId", rejections, { nonEmpty: true })
	)
		addRejection(
			rejections,
			"COMPARISON_ID_INVALID",
			"comparisonId is invalid",
			"$.comparisonId",
		);
	const runId = field(artifact, "runId");
	if (!stringField(runId, "$.runId", rejections, { nonEmpty: true }))
		addRejection(rejections, "RUN_ID_INVALID", "runId is invalid", "$.runId");
	const transport = field(artifact, "transport");
	if (transport !== "ws" && transport !== "wt")
		addRejection(
			rejections,
			"TRANSPORT_INVALID",
			"transport must be ws or wt",
			"$.transport",
		);
	const armKind = field(artifact, "armKind");
	if (armKind !== "primary" && armKind !== "read-path" && armKind !== "overlay")
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			"armKind must be primary, read-path, or overlay",
			"$.armKind",
		);
	const armTransport = field(artifact, "armTransport");
	const armId = field(artifact, "armId");
	const identityIssue = armIdentityIssue({
		transport,
		armId,
		armTransport,
		armKind,
	});
	if (identityIssue !== null)
		addRejection(
			rejections,
			"ARM_IDENTITY_INCONSISTENT",
			identityIssue,
			"$.armId",
		);
	else if (armTransport === "wt-stream-sink") {
		// The check that would have caught the datagram cells automatically: a
		// sink arm is only expressible where the cell carries one.
		const cellId = field(record(field(artifact, "scenario")), "cellId");
		const sinkCell =
			typeof cellId === "string"
				? CANONICAL_SCENARIO_REGISTRY.cells.find(
						(candidate) => candidate.cellId === cellId,
					)
				: undefined;
		if (!sinkCell || !armEligibilityFor(sinkCell).hasWtStreamSink)
			addRejection(
				rejections,
				"ARM_IDENTITY_INCONSISTENT",
				"this cell carries no wt-stream-sink arm",
				"$.armTransport",
			);
	}
	const artifactKind = field(artifact, "artifactKind");
	if (artifactKind !== "measured" && artifactKind !== "test-fixture")
		addRejection(
			rejections,
			"ARTIFACT_KIND_INVALID",
			"artifactKind must be measured or test-fixture",
			"$.artifactKind",
		);
}

function verifySource(value: unknown, rejections: ArtifactRejection[]): void {
	const source = record(value);
	requireKeys(source, EXPECTED_SOURCE_KEYS, "$.source", rejections);
	if (!source) return;
	const sourceSha = field(source, "sourceSha");
	if (!isSha1(sourceSha))
		addRejection(
			rejections,
			"SOURCE_SHA_INVALID",
			"source.sourceSha must be a 40-character lowercase SHA-1",
			"$.source.sourceSha",
		);
	const archive = field(source, "archiveSha256");
	if (!isSha256(archive))
		addRejection(
			rejections,
			"SOURCE_ARCHIVE_DIGEST_INVALID",
			"source.archiveSha256 must be SHA-256",
			"$.source.archiveSha256",
		);
	const executable = field(source, "executableSha256");
	if (!isSha256(executable))
		addRejection(
			rejections,
			"EXECUTABLE_DIGEST_INVALID",
			"source.executableSha256 must be SHA-256",
			"$.source.executableSha256",
		);
	const toolchain = record(field(source, "toolchain"));
	requireKeys(
		toolchain,
		["identity", "sha256"],
		"$.source.toolchain",
		rejections,
	);
	if (toolchain) {
		stringField(
			field(toolchain, "identity"),
			"$.source.toolchain.identity",
			rejections,
			{ nonEmpty: true },
		);
		if (!isSha256(field(toolchain, "sha256")))
			addRejection(
				rejections,
				"TOOLCHAIN_DIGEST_INVALID",
				"source.toolchain.sha256 must be SHA-256",
				"$.source.toolchain.sha256",
			);
	}
	boolField(field(source, "cleanTree"), "$.source.cleanTree", rejections);
	if (!isSha256(field(source, "bindingSha256")))
		addRejection(
			rejections,
			"SOURCE_UNBOUND",
			"source binding digest is missing or invalid",
			"$.source.bindingSha256",
		);
	if (
		isSha1(sourceSha) &&
		isSha256(archive) &&
		isSha256(executable) &&
		toolchain &&
		isSha256(field(toolchain, "sha256")) &&
		isSha256(field(source, "bindingSha256"))
	) {
		const expected = sha256Canonical({
			sourceSha,
			archiveSha256: archive,
			executableSha256: executable,
			toolchain: {
				identity: field(toolchain, "identity"),
				sha256: field(toolchain, "sha256"),
			},
			cleanTree: field(source, "cleanTree"),
		});
		if (expected !== field(source, "bindingSha256"))
			addRejection(
				rejections,
				"SOURCE_UNBOUND",
				"source fields do not match source binding digest",
				"$.source.bindingSha256",
			);
		if (field(source, "cleanTree") !== true)
			addRejection(
				rejections,
				"SOURCE_UNBOUND",
				"source evidence must prove a clean tree",
				"$.source.cleanTree",
			);
	}
}

function endpointIsLoopback(value: string): boolean {
	const lower = value.toLowerCase();
	return (
		lower === "localhost" ||
		lower.startsWith("127.") ||
		lower === "::1" ||
		lower.startsWith("unix:") ||
		lower.includes("/tmp/") ||
		/(?:^|\/\/)(?:localhost|127(?:\.\d+){1,3}|\[::1\])(?=[:/]|$)/.test(lower)
	);
}

function endpointIsUnspecified(value: string): boolean {
	const lower = value.toLowerCase();
	return (
		lower === "0.0.0.0" ||
		lower === "::" ||
		lower === "*" ||
		/(?:^|\/\/)(?:0\.0\.0\.0|\[::\])(?=[:/]|$)/.test(lower)
	);
}

function verifyHost(
	value: unknown,
	expected: HostEvidence,
	path: string,
	rejections: ArtifactRejection[],
): value is HostEvidence {
	const host = record(value);
	requireKeys(
		host,
		["hostId", "os", "arch", "interface", "address", "mtu", "route"],
		path,
		rejections,
	);
	if (!host) return false;
	const address = field(host, "address");
	stringField(field(host, "hostId"), `${path}.hostId`, rejections, {
		nonEmpty: true,
	});
	if (stringField(address, `${path}.address`, rejections, { nonEmpty: true })) {
		if (endpointIsLoopback(address))
			addRejection(
				rejections,
				"TOPOLOGY_LOOPBACK",
				`${path}.address may not be loopback`,
				`${path}.address`,
			);
		if (endpointIsUnspecified(address))
			addRejection(
				rejections,
				"TOPOLOGY_UNSPECIFIED",
				`${path}.address may not be unspecified`,
				`${path}.address`,
			);
		if (address !== expected.address)
			addRejection(
				rejections,
				"TOPOLOGY_ADDRESS_MISMATCH",
				`${path}.address must be ${expected.address}`,
				`${path}.address`,
			);
	}
	if (field(host, "os") !== expected.os)
		addRejection(
			rejections,
			"TOPOLOGY_OS_MISMATCH",
			`${path}.os must be ${expected.os}`,
			`${path}.os`,
		);
	if (field(host, "arch") !== expected.arch)
		addRejection(
			rejections,
			"TOPOLOGY_ARCH_MISMATCH",
			`${path}.arch must be ${expected.arch}`,
			`${path}.arch`,
		);
	if (field(host, "interface") !== expected.interface)
		addRejection(
			rejections,
			"TOPOLOGY_INTERFACE_MISMATCH",
			`${path}.interface must be ${expected.interface}`,
			`${path}.interface`,
		);
	if (field(host, "mtu") !== expected.mtu)
		addRejection(
			rejections,
			"TOPOLOGY_MTU_MISMATCH",
			`${path}.mtu must be ${expected.mtu}`,
			`${path}.mtu`,
		);
	const route = record(field(host, "route"));
	requireKeys(
		route,
		["source", "destination", "interface"],
		`${path}.route`,
		rejections,
	);
	if (route) {
		if (
			field(route, "source") !== expected.route.source ||
			field(route, "destination") !== expected.route.destination ||
			field(route, "interface") !== expected.route.interface
		) {
			addRejection(
				rejections,
				"TOPOLOGY_ROUTE_MISMATCH",
				`${path}.route does not prove the direct cable`,
				`${path}.route`,
			);
		}
	}
	return true;
}

function verifyTopology(value: unknown, rejections: ArtifactRejection[]): void {
	const topology = record(value);
	if (!topology) {
		addRejection(
			rejections,
			"TOPOLOGY_MISSING_LINUX",
			"topology must include Mac and Linux proofs",
			"$.topology",
		);
		return;
	}
	requireKeys(
		topology,
		["mac", "linux", "serverObservedPeer", "sidecars"],
		"$.topology",
		rejections,
	);
	const expectedMac: HostEvidence = {
		hostId: "",
		os: "darwin",
		arch: "arm64",
		interface: EXPECTED_MAC_INTERFACE,
		address: EXPECTED_MAC_ADDRESS,
		mtu: EXPECTED_MTU,
		route: {
			source: EXPECTED_MAC_ADDRESS,
			destination: EXPECTED_LINUX_ADDRESS,
			interface: EXPECTED_MAC_INTERFACE,
		},
	};
	const expectedLinux: HostEvidence = {
		hostId: "",
		os: "linux",
		arch: "x86_64",
		interface: EXPECTED_LINUX_INTERFACE,
		address: EXPECTED_LINUX_ADDRESS,
		mtu: EXPECTED_MTU,
		route: {
			source: EXPECTED_LINUX_ADDRESS,
			destination: EXPECTED_MAC_ADDRESS,
			interface: EXPECTED_LINUX_INTERFACE,
		},
	};
	const mac = record(field(topology, "mac"));
	const linux = record(field(topology, "linux"));
	if (!linux)
		addRejection(
			rejections,
			"TOPOLOGY_MISSING_LINUX",
			"Linux server proof is required",
			"$.topology.linux",
		);
	verifyHost(mac, expectedMac, "$.topology.mac", rejections);
	verifyHost(linux, expectedLinux, "$.topology.linux", rejections);
	if (mac && linux && field(mac, "hostId") === field(linux, "hostId"))
		addRejection(
			rejections,
			"TOPOLOGY_SAME_HOST",
			"Mac and Linux host identities must differ",
			"$.topology",
		);
	const peer = record(field(topology, "serverObservedPeer"));
	if (!peer)
		addRejection(
			rejections,
			"TOPOLOGY_PEER_MISSING",
			"Linux server-observed Mac peer proof is required",
			"$.topology.serverObservedPeer",
		);
	requireKeys(
		peer,
		["hostId", "address", "interface"],
		"$.topology.serverObservedPeer",
		rejections,
	);
	if (peer) {
		stringField(
			field(peer, "hostId"),
			"$.topology.serverObservedPeer.hostId",
			rejections,
			{ nonEmpty: true },
		);
		stringField(
			field(peer, "address"),
			"$.topology.serverObservedPeer.address",
			rejections,
			{ nonEmpty: true },
		);
		stringField(
			field(peer, "interface"),
			"$.topology.serverObservedPeer.interface",
			rejections,
			{ nonEmpty: true },
		);
		if (
			field(peer, "hostId") !== field(mac, "hostId") ||
			field(peer, "address") !== EXPECTED_MAC_ADDRESS ||
			field(peer, "interface") !== EXPECTED_LINUX_INTERFACE
		)
			addRejection(
				rejections,
				"TOPOLOGY_PEER_MISMATCH",
				"Linux must observe the expected Mac peer on eno1",
				"$.topology.serverObservedPeer",
			);
	}
	const sidecars = record(field(topology, "sidecars"));
	requireKeys(sidecars, ["mac", "linux"], "$.topology.sidecars", rejections);
	for (const host of ["mac", "linux"] as const) {
		const sidecar = record(field(sidecars, host));
		if (!sidecar)
			addRejection(
				rejections,
				"TOPOLOGY_SIDECAR_MISSING",
				`${host} host/process/NIC sidecars are required`,
				`$.topology.sidecars.${host}`,
			);
		requireKeys(
			sidecar,
			["host", "process", "nic"],
			`$.topology.sidecars.${host}`,
			rejections,
		);
		if (
			sidecar &&
			(field(sidecar, "host") !== true ||
				field(sidecar, "process") !== true ||
				field(sidecar, "nic") !== true)
		)
			addRejection(
				rejections,
				"TOPOLOGY_SIDECAR_MISSING",
				`${host} host/process/NIC sidecars are required`,
				`$.topology.sidecars.${host}`,
			);
	}
}

function verifySmoke(value: unknown, rejections: ArtifactRejection[]): void {
	const smoke = record(value);
	requireKeys(
		smoke,
		["input", "completed", "usedLoopback"],
		"$.smoke",
		rejections,
	);
	if (!smoke) return;
	const input = field(smoke, "input");
	if (!stringField(input, "$.smoke.input", rejections, { nonEmpty: true }))
		return;
	if (endpointIsLoopback(input))
		addRejection(
			rejections,
			"TOPOLOGY_LOOPBACK",
			"smoke input may not use loopback",
			"$.smoke.input",
		);
	if (endpointIsUnspecified(input))
		addRejection(
			rejections,
			"TOPOLOGY_UNSPECIFIED",
			"smoke input may not use an unspecified endpoint",
			"$.smoke.input",
		);
	if (input !== EXPECTED_SMOKE_INPUT)
		addRejection(
			rejections,
			"SMOKE_INPUT_INVALID",
			`smoke input must be ${EXPECTED_SMOKE_INPUT}`,
			"$.smoke.input",
		);
	if (
		field(smoke, "completed") !== true ||
		field(smoke, "usedLoopback") !== false
	)
		addRejection(
			rejections,
			"SMOKE_INPUT_INVALID",
			"smoke input must complete without loopback",
			"$.smoke",
		);
}

function verifyScenario(
	value: unknown,
	transport: unknown,
	rejections: ArtifactRejection[],
): ReturnType<typeof getScenarioCell> | undefined {
	const scenario = record(value);
	const path = "$.scenario";
	requireKeys(
		scenario,
		[
			"cellId",
			"scenarioId",
			"canonical",
			"config",
			"scenarioHash",
			"seed",
			"repetition",
			"armOrder",
			"payload",
			"direction",
		],
		path,
		rejections,
	);
	if (!scenario) return undefined;
	if (field(scenario, "canonical") !== true)
		addRejection(
			rejections,
			"SCENARIO_NON_CANONICAL",
			"only canonical scenario cells are comparable",
			`${path}.canonical`,
		);
	const cellId = field(scenario, "cellId");
	if (!stringField(cellId, `${path}.cellId`, rejections, { nonEmpty: true }))
		return undefined;
	let cell: ReturnType<typeof getScenarioCell>;
	try {
		cell = getScenarioCell(CANONICAL_SCENARIO_REGISTRY, cellId);
	} catch {
		addRejection(
			rejections,
			"SCENARIO_ID_INVALID",
			`unknown canonical scenario cell ${cellId}`,
			`${path}.cellId`,
		);
		return undefined;
	}
	if (field(scenario, "scenarioId") !== cell.scenarioId)
		addRejection(
			rejections,
			"SCENARIO_CONFIG_MISMATCH",
			"scenarioId does not match the canonical cell",
			`${path}.scenarioId`,
		);
	if (!compareCanonical(field(scenario, "config"), cell.parameters))
		addRejection(
			rejections,
			"SCENARIO_CONFIG_MISMATCH",
			"scenario config does not match the canonical registry",
			`${path}.config`,
		);
	const hash = field(scenario, "scenarioHash");
	if (!isSha256(hash))
		addRejection(
			rejections,
			"SCENARIO_HASH_INVALID",
			"scenarioHash must be SHA-256",
			`${path}.scenarioHash`,
		);
	if (hash !== cell.scenarioHash)
		addRejection(
			rejections,
			"SCENARIO_HASH_MISMATCH",
			"scenarioHash does not match the canonical registry",
			`${path}.scenarioHash`,
		);
	if (!safeNonNegative(field(scenario, "seed"), `${path}.seed`, rejections))
		addRejection(
			rejections,
			"SCENARIO_SEED_INVALID",
			"seed must be a non-negative safe integer",
			`${path}.seed`,
		);
	const repetition = record(field(scenario, "repetition"));
	requireKeys(repetition, ["index", "total"], `${path}.repetition`, rejections);
	if (repetition) {
		const index = field(repetition, "index");
		const total = field(repetition, "total");
		if (
			!safePositive(index, `${path}.repetition.index`, rejections) ||
			!safePositive(total, `${path}.repetition.total`, rejections) ||
			index > total ||
			total !== cell.runPolicy.measuredRepetitions
		)
			addRejection(
				rejections,
				"SCENARIO_REPETITION_INVALID",
				"repetition must be within the canonical measured policy",
				`${path}.repetition`,
			);
	}
	const armOrder = field(scenario, "armOrder");
	const seed = field(scenario, "seed");
	const repetitionIndex = field(record(field(scenario, "repetition")), "index");
	const expectedArmOrder =
		typeof seed === "number" && typeof repetitionIndex === "number"
			? expandArmUnits(
					balancedArmOrder(seed, repetitionIndex, armUnitsFor(cell)),
				)
			: undefined;
	// The membership test is deliberately weaker than the old two-valued one —
	// it admits every declared slot — so it is never the last line of defence.
	// The exact order equality below it is what actually pins the schedule.
	if (
		!Array.isArray(armOrder) ||
		!expectedArmOrder ||
		armOrder.length !== expectedArmOrder.length ||
		!armOrder.every((arm): arm is ArmSlot => ARM_SLOTS.has(arm as ArmSlot)) ||
		armOrder.join(",") !== expectedArmOrder.join(",")
	)
		addRejection(
			rejections,
			"SCENARIO_ARM_ORDER_INVALID",
			"arm order must be the seeded balanced unit order for this cell",
			`${path}.armOrder`,
		);
	const payload = record(field(scenario, "payload"));
	requireKeys(
		payload,
		["encoding", "data", "bytes", "sha256"],
		`${path}.payload`,
		rejections,
	);
	if (payload) {
		const data = field(payload, "data");
		const decoded = decodeCanonicalBase64(data);
		if (field(payload, "encoding") !== "base64" || decoded === undefined)
			addRejection(
				rejections,
				"SCENARIO_PAYLOAD_INVALID",
				"payload must be canonical base64",
				`${path}.payload.data`,
			);
		if (decoded !== undefined) {
			if (
				field(payload, "bytes") !== decoded.byteLength ||
				!isSha256(field(payload, "sha256")) ||
				sha256Bytes(decoded) !== field(payload, "sha256")
			)
				addRejection(
					rejections,
					"SCENARIO_PAYLOAD_MISMATCH",
					"payload byte count/hash does not match its bytes",
					`${path}.payload`,
				);
			const expectedBytes = expectedPayloadBytes(
				cell.parameters as unknown as Record<string, unknown>,
			);
			if (
				expectedBytes !== undefined &&
				field(payload, "bytes") !== expectedBytes
			)
				addRejection(
					rejections,
					"SCENARIO_PAYLOAD_MISMATCH",
					"payload size does not match the canonical scenario",
					`${path}.payload.bytes`,
				);
		}
	}
	if (field(scenario, "direction") !== cell.rolePlan.direction)
		addRejection(
			rejections,
			"SCENARIO_DIRECTION_MISMATCH",
			"scenario direction does not match the canonical role plan",
			`${path}.direction`,
		);
	if (transport !== "ws" && transport !== "wt")
		addRejection(
			rejections,
			"TRANSPORT_INVALID",
			"transport must be ws or wt",
			"$.transport",
		);
	return cell;
}

function expectedPayloadBytes(
	parameters: Record<string, unknown>,
): number | undefined {
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
	return undefined;
}

function decodeCanonicalBase64(value: unknown): Uint8Array | undefined {
	if (!isBase64(value, MAX_PAYLOAD_BASE64_LENGTH)) return undefined;
	const decoded = new Uint8Array(Buffer.from(value, "base64"));
	if (decoded.byteLength > MAX_SUPPORTED_PAYLOAD_BYTES) return undefined;
	return Buffer.from(decoded).toString("base64") === value
		? decoded
		: undefined;
}

function sha256Bytes(bytes: Uint8Array): string {
	// `sha256Canonical` is intentionally not used for payload bytes: this is a
	// digest of the exact application bytes, not their JSON representation.
	return createHash("sha256").update(bytes).digest("hex");
}

function verifyTls(value: unknown, rejections: ArtifactRejection[]): void {
	const tls = record(value);
	requireKeys(
		tls,
		[
			"sni",
			"certificateSha256",
			"caSha256",
			"rejectUnauthorized",
			"verification",
			"compression",
		],
		"$.tls",
		rejections,
	);
	if (!tls) return;
	if (field(tls, "sni") !== EXPECTED_TLS_SNI)
		addRejection(
			rejections,
			"TLS_SNI_MISMATCH",
			`TLS SNI must be ${EXPECTED_TLS_SNI}`,
			"$.tls.sni",
		);
	if (!isSha256(field(tls, "certificateSha256")))
		addRejection(
			rejections,
			"TLS_CERTIFICATE_DIGEST_INVALID",
			"certificateSha256 must be SHA-256",
			"$.tls.certificateSha256",
		);
	if (!isSha256(field(tls, "caSha256")))
		addRejection(
			rejections,
			"TLS_CA_DIGEST_INVALID",
			"caSha256 must be SHA-256",
			"$.tls.caSha256",
		);
	if (
		field(tls, "rejectUnauthorized") !== true ||
		field(tls, "verification") !== "custom-ca"
	)
		addRejection(
			rejections,
			"TLS_CONFIGURATION_INVALID",
			"TLS must use the shared custom CA with certificate verification",
			"$.tls",
		);
	if (field(tls, "compression") !== "off")
		addRejection(
			rejections,
			"TLS_COMPRESSION_ENABLED",
			"primary arms must disable compression",
			"$.tls.compression",
		);
}

/**
 * The impairment this cell was supposed to ask for. This is the same decoder
 * the builder records from and the campaign judges against — the verifier owned
 * a second copy of it, and a second copy is how the recorded and the judged
 * reading drifted apart in the first place.
 */
function expectedRequestedImpairment(
	cell: ReturnType<typeof getScenarioCell> | undefined,
): { qdisc: "fq" | "netem"; delayMs: number; lossPercent: number } {
	return requestedImpairmentOf(cell);
}

function verifyImpairment(
	value: unknown,
	rejections: ArtifactRejection[],
	cell?: ReturnType<typeof getScenarioCell>,
): void {
	const impairment = record(value) as Record<string, unknown> | undefined;
	requireKeys(
		impairment,
		[
			"requested",
			"observedBefore",
			"observedAfter",
			"restored",
			"restorationProof",
		],
		"$.impairment",
		rejections,
	);
	if (!impairment) return;
	const requested = record(field(impairment, "requested"));
	const before = record(field(impairment, "observedBefore"));
	const after = record(field(impairment, "observedAfter"));
	for (const [state, path] of [
		[requested, "$.impairment.requested"],
		[before, "$.impairment.observedBefore"],
		[after, "$.impairment.observedAfter"],
	] as const) {
		requireKeys(
			state,
			state === requested
				? ["qdisc", "delayMs", "lossPercent", "direction"]
				: ["qdisc", "delayMs", "lossPercent"],
			path,
			rejections,
		);
		if (state) {
			const stateCode: ArtifactRejectionCode =
				state === requested
					? "IMPAIRMENT_REQUESTED_INVALID"
					: "IMPAIRMENT_OBSERVED_INVALID";
			if (
				!finiteNumber(field(state, "delayMs"), `${path}.delayMs`, rejections) ||
				(field(state, "delayMs") as number) < 0
			)
				addRejection(
					rejections,
					stateCode,
					"delayMs must be non-negative",
					`${path}.delayMs`,
				);
			if (
				!finiteNumber(
					field(state, "lossPercent"),
					`${path}.lossPercent`,
					rejections,
				) ||
				(field(state, "lossPercent") as number) < 0 ||
				(field(state, "lossPercent") as number) > 100
			)
				addRejection(
					rejections,
					stateCode,
					"lossPercent must be within 0..100",
					`${path}.lossPercent`,
				);
			if (field(state, "qdisc") !== "fq" && field(state, "qdisc") !== "netem")
				addRejection(
					rejections,
					state === requested
						? "IMPAIRMENT_REQUESTED_INVALID"
						: "IMPAIRMENT_OBSERVED_INVALID",
					"qdisc must be fq or netem",
					`${path}.qdisc`,
				);
		}
	}
	if (requested && field(requested, "direction") !== "linux-egress")
		addRejection(
			rejections,
			"IMPAIRMENT_REQUESTED_INVALID",
			"impairment direction must be linux-egress",
			"$.impairment.requested.direction",
		);
	const expectedRequested = expectedRequestedImpairment(cell);
	if (
		!requested ||
		field(requested, "qdisc") !== expectedRequested.qdisc ||
		field(requested, "delayMs") !== expectedRequested.delayMs ||
		field(requested, "lossPercent") !== expectedRequested.lossPercent
	)
		addRejection(
			rejections,
			"IMPAIRMENT_REQUESTED_INVALID",
			"requested impairment does not match the canonical scenario path",
			"$.impairment.requested",
		);
	if (!before || !compareCanonical(before, INITIAL_IMPAIRMENT))
		addRejection(
			rejections,
			"IMPAIRMENT_OBSERVED_INVALID",
			"pre-run impairment must be the initial fq state",
			"$.impairment.observedBefore",
		);
	if (!after || !compareCanonical(after, INITIAL_IMPAIRMENT))
		addRejection(
			rejections,
			"IMPAIRMENT_RESTORATION_INVALID",
			"post-run impairment must be restored to the initial fq state",
			"$.impairment.observedAfter",
		);
	const proof = record(field(impairment, "restorationProof"));
	if (!proof)
		addRejection(
			rejections,
			"IMPAIRMENT_RESTORATION_INVALID",
			"restoration proof is required",
			"$.impairment.restorationProof",
		);
	requireKeys(
		proof,
		["observedBeforeSha256", "observedAfterSha256", "matches"],
		"$.impairment.restorationProof",
		rejections,
	);
	if (proof) {
		if (
			!isSha256(field(proof, "observedBeforeSha256")) ||
			!isSha256(field(proof, "observedAfterSha256"))
		)
			addRejection(
				rejections,
				"IMPAIRMENT_RESTORATION_INVALID",
				"restoration proof hashes must be SHA-256",
				"$.impairment.restorationProof",
			);
		if (before && after && !compareCanonical(before, after))
			addRejection(
				rejections,
				"IMPAIRMENT_OBSERVED_INVALID",
				"pre-run and post-run impairment observations differ",
				"$.impairment",
			);
		if (
			field(proof, "matches") !== true ||
			field(impairment, "restored") !== true ||
			!compareCanonical(before, after)
		)
			addRejection(
				rejections,
				"IMPAIRMENT_RESTORATION_INVALID",
				"post-run qdisc must match pre-run state and restoration must be proven",
				"$.impairment",
			);
		if (
			before &&
			isSha256(field(proof, "observedBeforeSha256")) &&
			sha256Canonical(before) !== field(proof, "observedBeforeSha256")
		)
			addRejection(
				rejections,
				"IMPAIRMENT_RESTORATION_INVALID",
				"pre-run qdisc proof hash does not match",
				"$.impairment.restorationProof.observedBeforeSha256",
			);
		if (
			after &&
			isSha256(field(proof, "observedAfterSha256")) &&
			sha256Canonical(after) !== field(proof, "observedAfterSha256")
		)
			addRejection(
				rejections,
				"IMPAIRMENT_RESTORATION_INVALID",
				"post-run qdisc proof hash does not match",
				"$.impairment.restorationProof.observedAfterSha256",
			);
		const initialHash = sha256Canonical(INITIAL_IMPAIRMENT);
		if (
			field(proof, "observedBeforeSha256") !== initialHash ||
			field(proof, "observedAfterSha256") !== initialHash
		)
			addRejection(
				rejections,
				"IMPAIRMENT_RESTORATION_INVALID",
				"restoration proof must bind the initial fq state",
				"$.impairment.restorationProof",
			);
	}
}

function verifyCapacity(value: unknown, rejections: ArtifactRejection[]): void {
	const capacity = record(value) as Record<string, unknown> | undefined;
	requireKeys(
		capacity,
		[
			"profileId",
			"profileHash",
			"requested",
			"submittedProfileBytes",
			"submittedProfileHash",
			"admissionCounters",
			"connectionRamp",
		],
		"$.capacity",
		rejections,
	);
	if (!capacity) return;
	if (capacity.profileId !== CANONICAL_CAPACITY_PROFILE.profileId)
		addRejection(
			rejections,
			"CAPACITY_PROFILE_ID_MISMATCH",
			"capacity profile ID is not canonical",
			"$.capacity.profileId",
		);
	if (!isSha256(capacity.profileHash))
		addRejection(
			rejections,
			"CAPACITY_PROFILE_HASH_INVALID",
			"capacity profile hash must be SHA-256",
			"$.capacity.profileHash",
		);
	if (capacity.profileHash !== sha256Canonical(CANONICAL_CAPACITY_PROFILE))
		addRejection(
			rejections,
			"CAPACITY_PROFILE_HASH_MISMATCH",
			"capacity profile hash is not canonical",
			"$.capacity.profileHash",
		);
	if (!compareCanonical(capacity.requested, CANONICAL_CAPACITY_PROFILE))
		addRejection(
			rejections,
			"CAPACITY_PROFILE_VALUES_MISMATCH",
			"requested capacity values are not canonical",
			"$.capacity.requested",
		);
	const expectedSubmitted = canonicalJson(CANONICAL_CAPACITY_PROFILE);
	if (capacity.submittedProfileBytes !== expectedSubmitted)
		addRejection(
			rejections,
			"CAPACITY_SUBMITTED_BYTES_MISMATCH",
			"submitted profile bytes are not the normalized canonical bytes",
			"$.capacity.submittedProfileBytes",
		);
	if (!isSha256(capacity.submittedProfileHash))
		addRejection(
			rejections,
			"CAPACITY_SUBMITTED_HASH_INVALID",
			"submitted profile hash must be SHA-256",
			"$.capacity.submittedProfileHash",
		);
	if (
		capacity.submittedProfileHash !==
		sha256Canonical(CANONICAL_CAPACITY_PROFILE)
	)
		addRejection(
			rejections,
			"CAPACITY_SUBMITTED_HASH_MISMATCH",
			"submitted profile hash does not match normalized bytes",
			"$.capacity.submittedProfileHash",
		);
	verifyAdmissionCounters(capacity.admissionCounters, rejections);
	if (!compareCanonical(capacity.connectionRamp, CANONICAL_CONNECTION_SETUP))
		addRejection(
			rejections,
			"CAPACITY_CONNECTION_RAMP_MISMATCH",
			"connection ramp is not canonical",
			"$.capacity.connectionRamp",
		);
}

function verifyAdmissionCounters(
	value: unknown,
	rejections: ArtifactRejection[],
): void {
	const counters = record(value);
	requireKeys(
		counters,
		EXPECTED_ADMISSION_KEYS,
		"$.capacity.admissionCounters",
		rejections,
	);
	if (!counters) return;
	if (field(counters, "schemaVersion") !== "v1")
		addRejection(
			rejections,
			"CAPACITY_ADMISSION_SCHEMA_MISMATCH",
			"admission counter schema must be v1",
			"$.capacity.admissionCounters.schemaVersion",
		);
	for (const section of [
		"handshakes",
		"sessions",
		"streams",
		"datagrams",
	] as const) {
		const item = record(field(counters, section));
		const keys = EXPECTED_COUNTER_KEYS[section] ?? [];
		requireKeys(
			item,
			keys,
			`$.capacity.admissionCounters.${section}`,
			rejections,
		);
		if (!item) continue;
		for (const key of keys) {
			if (
				!finiteNumber(
					field(item, key),
					`$.capacity.admissionCounters.${section}.${key}`,
					rejections,
					true,
				) ||
				(field(item, key) as number) < 0
			)
				addRejection(
					rejections,
					"CAPACITY_ADMISSION_COUNTER_INVALID",
					"admission counters must be non-negative safe integers",
					`$.capacity.admissionCounters.${section}.${key}`,
				);
		}
		const attempted = field(item, "attempted");
		const accepted = field(item, "accepted");
		if (
			typeof attempted === "number" &&
			typeof accepted === "number" &&
			accepted > attempted
		)
			addRejection(
				rejections,
				"CAPACITY_ADMISSION_COUNTER_INVALID",
				`${section}.accepted cannot exceed attempted`,
				`$.capacity.admissionCounters.${section}`,
			);
		const rejected = field(item, "rejected");
		if (
			typeof attempted === "number" &&
			typeof accepted === "number" &&
			typeof rejected === "number" &&
			accepted + rejected !== attempted
		)
			addRejection(
				rejections,
				"CAPACITY_ADMISSION_COUNTER_INVALID",
				`${section}.accepted plus rejected must equal attempted`,
				`$.capacity.admissionCounters.${section}`,
			);
		const rateLimited = field(item, "rateLimited");
		if (
			typeof rateLimited === "number" &&
			typeof rejected === "number" &&
			rateLimited > rejected
		)
			addRejection(
				rejections,
				"CAPACITY_ADMISSION_COUNTER_INVALID",
				`${section}.rateLimited cannot exceed rejected`,
				`$.capacity.admissionCounters.${section}.rateLimited`,
			);
		if (
			section === "sessions" &&
			typeof field(item, "activePeak") === "number" &&
			typeof accepted === "number" &&
			(field(item, "activePeak") as number) > accepted
		)
			addRejection(
				rejections,
				"CAPACITY_ADMISSION_COUNTER_INVALID",
				"sessions.activePeak cannot exceed sessions.accepted",
				"$.capacity.admissionCounters.sessions.activePeak",
			);
	}
}

function verifyCapacityProof(
	value: unknown,
	rejections: ArtifactRejection[],
	cell?: ReturnType<typeof getScenarioCell>,
): void {
	const proof = record(value);
	requireKeys(proof, ["mac", "linux"], "$.capacityProof", rejections);
	if (!proof) return;
	const mac = record(field(proof, "mac"));
	const linux = record(field(proof, "linux"));
	requireKeys(mac, ["fd", "ephemeralPorts"], "$.capacityProof.mac", rejections);
	requireKeys(linux, ["fd"], "$.capacityProof.linux", rejections);
	const macFd = record(field(mac, "fd"));
	const linuxFd = record(field(linux, "fd"));
	const selectedRole = cell?.rolePlan.macRoles.find(
		({ role }) => role === cell.rolePlan.sharding.role,
	);
	const parameters = cell?.parameters as Record<string, unknown> | undefined;
	const canonicalCardinality =
		selectedRole &&
		Number.isSafeInteger(selectedRole.count) &&
		selectedRole.count > 0
			? selectedRole.count
			: [
					"liveConnections",
					"subscriberCount",
					"receiverCount",
					"clientCount",
					"sessionCount",
					"concurrency",
				]
					.map((key) => parameters?.[key])
					.find(
						(value): value is number =>
							typeof value === "number" &&
							Number.isSafeInteger(value) &&
							value > 0,
					);
	const isConnectionScale =
		canonicalCardinality !== undefined &&
		(selectedRole?.processModel === "cohort" ||
			(selectedRole?.processModel === "sharded" &&
				canonicalCardinality >= 1_000) ||
			(selectedRole === undefined && canonicalCardinality >= 1_000));
	const expectedFreePorts = isConnectionScale
		? Math.ceil(canonicalCardinality * 1.25)
		: undefined;
	for (const [fd, path] of [
		[macFd, "$.capacityProof.mac.fd"],
		[linuxFd, "$.capacityProof.linux.fd"],
	] as const) {
		requireKeys(
			fd,
			["softLimit", "hardLimit", "effectiveChildLimit"],
			path,
			rejections,
		);
		if (!fd) {
			addRejection(
				rejections,
				"CAPACITY_FD_PROOF_MISSING",
				`${path} is required`,
				path,
			);
			continue;
		}
		for (const key of [
			"softLimit",
			"hardLimit",
			"effectiveChildLimit",
		] as const) {
			if (
				!finiteNumber(field(fd, key), `${path}.${key}`, rejections, true) ||
				(field(fd, key) as number) <= 0
			)
				addRejection(
					rejections,
					"CAPACITY_FD_PROOF_MISSING",
					`${path}.${key} must be a positive safe integer`,
					`${path}.${key}`,
				);
		}
		const soft = field(fd, "softLimit");
		const hard = field(fd, "hardLimit");
		const effective = field(fd, "effectiveChildLimit");
		if (typeof soft === "number" && typeof hard === "number" && hard < soft)
			addRejection(
				rejections,
				"CAPACITY_FD_PROOF_MISSING",
				`${path}.hardLimit must not be below softLimit`,
				`${path}.hardLimit`,
			);
		if (
			typeof effective === "number" &&
			typeof hard === "number" &&
			effective > hard
		)
			addRejection(
				rejections,
				"CAPACITY_FD_PROOF_MISSING",
				`${path}.effectiveChildLimit must not exceed hardLimit`,
				`${path}.effectiveChildLimit`,
			);
		if (
			isConnectionScale &&
			typeof effective === "number" &&
			effective < MIN_EFFECTIVE_CHILD_NOFILE
		)
			addRejection(
				rejections,
				"CAPACITY_EFFECTIVE_LIMIT_TOO_LOW",
				`${path}.effectiveChildLimit must be at least ${MIN_EFFECTIVE_CHILD_NOFILE}`,
				`${path}.effectiveChildLimit`,
			);
	}
	const ports = record(field(mac, "ephemeralPorts"));
	requireKeys(
		ports,
		["rangeStart", "rangeEnd", "freePorts", "requiredFreePorts"],
		"$.capacityProof.mac.ephemeralPorts",
		rejections,
	);
	if (ports) {
		for (const key of [
			"rangeStart",
			"rangeEnd",
			"freePorts",
			"requiredFreePorts",
		] as const)
			finiteNumber(
				field(ports, key),
				`$.capacityProof.mac.ephemeralPorts.${key}`,
				rejections,
				true,
			);
		const start = field(ports, "rangeStart");
		const end = field(ports, "rangeEnd");
		const free = field(ports, "freePorts");
		const required = field(ports, "requiredFreePorts");
		if (
			typeof start === "number" &&
			typeof end === "number" &&
			typeof free === "number" &&
			typeof required === "number" &&
			(start < 1 ||
				end > 65_535 ||
				end <= start ||
				free < 0 ||
				required <= 0 ||
				end - start + 1 < required ||
				free < required ||
				free > end - start + 1)
		)
			addRejection(
				rejections,
				"CAPACITY_EPHEMERAL_PORT_PROOF_INVALID",
				"ephemeral-port proof lacks the required free-port headroom",
				"$.capacityProof.mac.ephemeralPorts",
			);
		if (
			isConnectionScale &&
			typeof required === "number" &&
			expectedFreePorts !== undefined &&
			required < expectedFreePorts
		)
			addRejection(
				rejections,
				"CAPACITY_EPHEMERAL_PORT_PROOF_INVALID",
				`requiredFreePorts must be at least ceil(connection cardinality * 1.25) = ${expectedFreePorts}`,
				"$.capacityProof.mac.ephemeralPorts.requiredFreePorts",
			);
	}
}

function verifyMetrics(
	value: unknown,
	rejections: ArtifactRejection[],
	scenarioId?: unknown,
	artifactKind?: unknown,
): void {
	const metrics = record(value);
	requireKeys(
		metrics,
		["name", "unit", "metricKind", "clock", "samples", "percentiles"],
		"$.metrics",
		rejections,
	);
	if (!metrics) return;
	const metricName = field(metrics, "name");
	stringField(metricName, "$.metrics.name", rejections, {
		nonEmpty: true,
	});
	const contract = metricContractForScenario(scenarioId);
	if (!contract) {
		addRejection(
			rejections,
			"METRICS_CONTRACT_INVALID",
			"scenario has no primary metric contract",
			"$.metrics",
		);
	} else if (
		metricName !== contract.name ||
		field(metrics, "unit") !== contract.unit ||
		field(metrics, "metricKind") !== contract.metricKind
	) {
		addRejection(
			rejections,
			"METRICS_CONTRACT_INVALID",
			"metric name, unit, and clock kind must match the primary contract",
			"$.metrics",
		);
	}
	const metricKind = field(metrics, "metricKind");
	const clock = record(field(metrics, "clock"));
	if (!EXPECTED_METRIC_KINDS.includes(metricKind as never))
		addRejection(
			rejections,
			"CLOCK_PROVENANCE_INVALID",
			"metrics.metricKind is not supported",
			"$.metrics.metricKind",
		);
	const requiredClockKeys =
		metricKind === "one-way"
			? ["domain", "monotonic", "method", "offsetMs", "uncertaintyMs"]
			: ["domain", "monotonic", "method"];
	requireKeys(clock, requiredClockKeys, "$.metrics.clock", rejections);
	if (clock) {
		const domain = field(clock, "domain");
		if (!EXPECTED_CLOCK_DOMAINS.includes(domain as never))
			addRejection(
				rejections,
				"CLOCK_PROVENANCE_INVALID",
				"clock domain is not supported",
				"$.metrics.clock.domain",
			);
		if (field(clock, "monotonic") !== true)
			addRejection(
				rejections,
				"CLOCK_PROVENANCE_INVALID",
				"clock evidence must be monotonic",
				"$.metrics.clock.monotonic",
			);
		if (
			!stringField(
				field(clock, "method"),
				"$.metrics.clock.method",
				rejections,
				{ nonEmpty: true },
			)
		)
			addRejection(
				rejections,
				"CLOCK_PROVENANCE_INVALID",
				"clock method is required",
				"$.metrics.clock.method",
			);
		const expectedDomain =
			metricKind === "mac-local-end-to-end"
				? "mac-monotonic"
				: metricKind === "linux-local-service"
					? "linux-monotonic"
					: "independent-offset";
		if (domain !== expectedDomain)
			addRejection(
				rejections,
				"CLOCK_PROVENANCE_INVALID",
				`metric kind ${String(metricKind)} requires ${expectedDomain} clock evidence`,
				"$.metrics.clock.domain",
			);
		const oneWayName =
			typeof metricName === "string" &&
			/one[- ]?way|cross[- ]?host/i.test(metricName);
		if (
			(oneWayName && metricKind !== "one-way") ||
			(!oneWayName && metricKind === "one-way")
		)
			addRejection(
				rejections,
				"CLOCK_PROVENANCE_INVALID",
				"metric name and metric kind must agree on one-way semantics",
				"$.metrics",
			);
		if (metricKind === "one-way") {
			if (
				!finiteNumber(
					field(clock, "offsetMs"),
					"$.metrics.clock.offsetMs",
					rejections,
				) ||
				!finiteNumber(
					field(clock, "uncertaintyMs"),
					"$.metrics.clock.uncertaintyMs",
					rejections,
				) ||
				(field(clock, "uncertaintyMs") as number) < 0
			)
				addRejection(
					rejections,
					"CLOCK_PROVENANCE_INVALID",
					"one-way metrics require finite offset and non-negative uncertainty",
					"$.metrics.clock",
				);
		}
	}
	const unit = field(metrics, "unit");
	if (
		!["ms", "bytes", "Mbps", "count", "ratio", "percent"].includes(
			unit as string,
		)
	)
		addRejection(
			rejections,
			"METRICS_UNIT_INVALID",
			"metrics.unit is not supported",
			"$.metrics.unit",
		);
	const samples = field(metrics, "samples");
	let samplesValid = true;
	if (!Array.isArray(samples)) {
		samplesValid = false;
		addRejection(
			rejections,
			"METRICS_SAMPLE_INVALID",
			"metrics.samples must be an array",
			"$.metrics.samples",
		);
	} else if (samples.length === 0) {
		samplesValid = false;
		addRejection(
			rejections,
			"METRICS_SAMPLES_EMPTY",
			"metrics.samples must not be empty",
			"$.metrics.samples",
		);
	} else if (samples.length > MAX_ARTIFACT_SAMPLES) {
		samplesValid = false;
		addRejection(
			rejections,
			"METRICS_SAMPLE_INVALID",
			"metrics.samples exceeds the cap",
			"$.metrics.samples",
		);
	} else if (
		artifactKind === "measured" &&
		contract?.minSamples !== undefined &&
		samples.length < contract.minSamples
	) {
		samplesValid = false;
		addRejection(
			rejections,
			"METRICS_SAMPLES_BELOW_FLOOR",
			"metrics.samples is below the primary contract's sample floor",
			"$.metrics.samples",
		);
	} else {
		for (let index = 0; index < samples.length; index += 1) {
			if (!Object.hasOwn(samples, index)) {
				samplesValid = false;
				addRejection(
					rejections,
					"METRICS_SAMPLES_SPARSE",
					"metrics.samples must be dense",
					`$.metrics.samples[${index}]`,
				);
				break;
			}
			if (
				!finiteNumber(
					samples[index],
					`$.metrics.samples[${index}]`,
					rejections,
				) ||
				(samples[index] as number) < 0
			) {
				samplesValid = false;
				addRejection(
					rejections,
					"METRICS_SAMPLE_INVALID",
					"metrics.samples must contain finite non-negative numbers",
					`$.metrics.samples[${index}]`,
				);
			} else if (
				contract &&
				((samples[index] as number) < contract.minimum ||
					(contract.maximum !== undefined &&
						(samples[index] as number) > contract.maximum))
			) {
				samplesValid = false;
				addRejection(
					rejections,
					"METRICS_CONTRACT_INVALID",
					"metric sample is outside the primary contract bounds",
					`$.metrics.samples[${index}]`,
				);
			}
		}
	}
	const percentiles = record(field(metrics, "percentiles"));
	requireKeys(
		percentiles,
		["p1", "p50", "p95", "p99"],
		"$.metrics.percentiles",
		rejections,
	);
	if (!percentiles || !Array.isArray(samples) || !samplesValid) return;
	if (
		contract &&
		["p1", "p50", "p95", "p99"].some((key) => {
			const candidate = field(percentiles, key);
			return (
				typeof candidate !== "number" ||
				candidate < contract.minimum ||
				(contract.maximum !== undefined && candidate > contract.maximum)
			);
		})
	)
		addRejection(
			rejections,
			"METRICS_CONTRACT_INVALID",
			"metric percentile is outside the primary contract bounds",
			"$.metrics.percentiles",
		);
	if (
		!percentiles ||
		!finiteNumber(
			field(percentiles, "p1"),
			"$.metrics.percentiles.p1",
			rejections,
		) ||
		!finiteNumber(
			field(percentiles, "p50"),
			"$.metrics.percentiles.p50",
			rejections,
		) ||
		!finiteNumber(
			field(percentiles, "p95"),
			"$.metrics.percentiles.p95",
			rejections,
		) ||
		!finiteNumber(
			field(percentiles, "p99"),
			"$.metrics.percentiles.p99",
			rejections,
		)
	)
		return;
	const summary = (() => {
		try {
			return sampleSummary(samples);
		} catch {
			return undefined;
		}
	})();
	if (summary === undefined) {
		addRejection(
			rejections,
			"METRICS_PERCENTILES_INVALID",
			"percentiles cannot be derived from the supplied samples",
			"$.metrics.percentiles",
		);
		return;
	}
	const actual = [
		field(percentiles, "p1"),
		field(percentiles, "p50"),
		field(percentiles, "p95"),
		field(percentiles, "p99"),
	];
	const expected = [summary.p1, summary.p50, summary.p95, summary.p99];
	if (
		actual.some(
			(value, index) =>
				typeof value !== "number" ||
				Math.abs(value - (expected[index] as number)) > 1e-9,
		) ||
		(field(percentiles, "p1") as number) >
			(field(percentiles, "p50") as number) ||
		(field(percentiles, "p50") as number) >
			(field(percentiles, "p95") as number) ||
		(field(percentiles, "p95") as number) >
			(field(percentiles, "p99") as number)
	)
		addRejection(
			rejections,
			"METRICS_PERCENTILES_INVALID",
			"percentiles must match dense samples and be ordered",
			"$.metrics.percentiles",
		);
}

function verifyMetricContract(
	artifact: Record<string, unknown>,
	scenarioCell: ReturnType<typeof getScenarioCell> | undefined,
	rejections: ArtifactRejection[],
): void {
	const contract = metricContractForScenario(scenarioCell?.scenarioId);
	const id = field(artifact, "metricContractId");
	const hash = field(artifact, "metricContractHash");
	if (
		!contract ||
		typeof id !== "string" ||
		id !== contract.id ||
		!isSha256(hash) ||
		hash !== metricContractHash(contract)
	)
		addRejection(
			rejections,
			"METRICS_CONTRACT_INVALID",
			"metric contract identity/hash does not match the canonical scenario",
			"$.metricContractHash",
		);
}

function verifyRuntime(value: unknown, rejections: ArtifactRejection[]): void {
	const runtime = record(value);
	requireKeys(runtime, ["mac", "linux"], "$.runtime", rejections);
	for (const host of ["mac", "linux"] as const) {
		const item = record(field(runtime, host));
		requireKeys(
			item,
			["cpu", "bun", "identity"],
			`$.runtime.${host}`,
			rejections,
		);
		if (!item) continue;
		for (const key of ["cpu", "bun", "identity"] as const) {
			if (
				!stringField(field(item, key), `$.runtime.${host}.${key}`, rejections, {
					nonEmpty: true,
				})
			)
				addRejection(
					rejections,
					"EVIDENCE_RUNTIME_INVALID",
					"runtime identity fields must be non-empty strings",
					`$.runtime.${host}.${key}`,
				);
		}
	}
}

function verifyProcessProof(
	value: unknown,
	scenarioCell: ReturnType<typeof getScenarioCell> | undefined,
	rejections: ArtifactRejection[],
): void {
	const proof = record(value);
	requireKeys(
		proof,
		["rolePlanHash", "macRoles", "linuxRole", "sharding", "processCohort"],
		"$.processProof",
		rejections,
	);
	if (!proof || !scenarioCell) return;
	const rolePlan = scenarioCell.rolePlan;
	if (
		!isSha256(field(proof, "rolePlanHash")) ||
		field(proof, "rolePlanHash") !== sha256Canonical(rolePlan)
	)
		addRejection(
			rejections,
			"EVIDENCE_PROCESS_PROOF_INVALID",
			"process proof is not bound to the canonical role plan",
			"$.processProof.rolePlanHash",
		);
	if (!compareCanonical(field(proof, "macRoles"), rolePlan.macRoles))
		addRejection(
			rejections,
			"EVIDENCE_PROCESS_PROOF_INVALID",
			"Mac process roles do not match the canonical role plan",
			"$.processProof.macRoles",
		);
	if (field(proof, "linuxRole") !== rolePlan.linuxRole)
		addRejection(
			rejections,
			"EVIDENCE_PROCESS_PROOF_INVALID",
			"Linux process role does not match the canonical role plan",
			"$.processProof.linuxRole",
		);
	const sharding = record(field(proof, "sharding"));
	requireKeys(
		sharding,
		["role", "workerCount", "strategy", "shards"],
		"$.processProof.sharding",
		rejections,
	);
	if (sharding && !compareCanonical(sharding, rolePlan.sharding))
		addRejection(
			rejections,
			"EVIDENCE_PROCESS_PROOF_INVALID",
			"sharding proof does not match the canonical role plan",
			"$.processProof.sharding",
		);
	const cohort = record(field(proof, "processCohort"));
	requireKeys(
		cohort,
		["kind", "processes", "primeBeforeMeasurement", "measuredCycles"],
		"$.processProof.processCohort",
		rejections,
	);
	if (cohort && !compareCanonical(cohort, rolePlan.processCohort))
		addRejection(
			rejections,
			"EVIDENCE_PROCESS_PROOF_INVALID",
			"process cohort proof does not match the canonical role plan",
			"$.processProof.processCohort",
		);
}

function verifyLedger(
	value: unknown,
	metricUnit: unknown,
	rejections: ArtifactRejection[],
): void {
	const ledger = record(value);
	const keys = [
		"attempted",
		"queued",
		"serverObserved",
		"acknowledged",
		"delivered",
		"expired",
		"dropped",
		"histogram",
	] as const;
	requireKeys(ledger, keys, "$.ledger", rejections);
	if (!ledger) return;
	for (const key of keys.slice(0, -1))
		safeNonNegative(field(ledger, key), `$.ledger.${key}`, rejections);
	const ordered = [
		"queued",
		"serverObserved",
		"acknowledged",
		"delivered",
	] as const;
	for (let index = 0; index < ordered.length; index += 1) {
		const currentKey = ordered[index];
		const previousKey = index === 0 ? "attempted" : ordered[index - 1];
		if (!currentKey || !previousKey) continue;
		const current = field(ledger, currentKey);
		const previous = field(ledger, previousKey);
		if (
			typeof current === "number" &&
			typeof previous === "number" &&
			current > previous
		)
			addRejection(
				rejections,
				"EVIDENCE_LEDGER_INVALID",
				`ledger.${ordered[index]} cannot exceed its preceding stage`,
				`$.ledger.${ordered[index]}`,
			);
	}
	for (const key of ["expired", "dropped"] as const) {
		const candidate = field(ledger, key);
		const attempted = field(ledger, "attempted");
		if (
			typeof candidate === "number" &&
			typeof attempted === "number" &&
			candidate > attempted
		)
			addRejection(
				rejections,
				"EVIDENCE_LEDGER_INVALID",
				`ledger.${key} cannot exceed attempted`,
				`$.ledger.${key}`,
			);
	}
	const histogram = record(field(ledger, "histogram"));
	requireKeys(
		histogram,
		["unit", "boundaries", "counts"],
		"$.ledger.histogram",
		rejections,
	);
	if (!histogram) return;
	if (field(histogram, "unit") !== metricUnit)
		addRejection(
			rejections,
			"EVIDENCE_LEDGER_INVALID",
			"histogram unit must match the primary metric unit",
			"$.ledger.histogram.unit",
		);
	const boundaries = field(histogram, "boundaries");
	const counts = field(histogram, "counts");
	if (
		!Array.isArray(boundaries) ||
		!Array.isArray(counts) ||
		boundaries.length === 0 ||
		boundaries.length !== counts.length
	)
		addRejection(
			rejections,
			"EVIDENCE_LEDGER_INVALID",
			"histogram boundaries and counts must be equal non-empty arrays",
			"$.ledger.histogram",
		);
	if (Array.isArray(boundaries) && Array.isArray(counts)) {
		let previous = -Infinity;
		let total = 0;
		for (let index = 0; index < boundaries.length; index += 1) {
			const boundary = boundaries[index];
			const count = counts[index];
			if (
				!finiteNumber(
					boundary,
					`$.ledger.histogram.boundaries[${index}]`,
					rejections,
				) ||
				!safeNonNegative(
					count,
					`$.ledger.histogram.counts[${index}]`,
					rejections,
				) ||
				(boundary as number) < previous
			)
				addRejection(
					rejections,
					"EVIDENCE_LEDGER_INVALID",
					"histogram buckets must be finite, ordered, and counted",
					"$.ledger.histogram",
				);
			previous = typeof boundary === "number" ? boundary : previous;
			if (typeof count === "number") total += count;
		}
		const attempted = field(ledger, "attempted");
		if (typeof attempted === "number" && total > attempted)
			addRejection(
				rejections,
				"EVIDENCE_LEDGER_INVALID",
				"histogram count cannot exceed attempted",
				"$.ledger.histogram.counts",
			);
	}
}

function verifyTelemetry(
	value: unknown,
	rejections: ArtifactRejection[],
): void {
	const telemetry = record(value);
	requireKeys(telemetry, ["mac", "linux"], "$.telemetry", rejections);
	for (const host of ["mac", "linux"] as const) {
		const item = record(field(telemetry, host));
		requireKeys(
			item,
			["cpuPercent", "rssBytes"],
			`$.telemetry.${host}`,
			rejections,
		);
		if (!item) continue;
		const cpu = field(item, "cpuPercent");
		if (
			!finiteNumber(cpu, `$.telemetry.${host}.cpuPercent`, rejections) ||
			(cpu as number) < 0 ||
			(cpu as number) > 100 * 1024
		)
			addRejection(
				rejections,
				"EVIDENCE_TELEMETRY_INVALID",
				"CPU telemetry must be a finite non-negative percentage",
				`$.telemetry.${host}.cpuPercent`,
			);
		if (
			!safeNonNegative(
				field(item, "rssBytes"),
				`$.telemetry.${host}.rssBytes`,
				rejections,
			)
		)
			addRejection(
				rejections,
				"EVIDENCE_TELEMETRY_INVALID",
				"RSS telemetry must be a non-negative safe integer",
				`$.telemetry.${host}.rssBytes`,
			);
	}
}

function verifyRawSidecars(
	artifact: Record<string, unknown>,
	rejections: ArtifactRejection[],
): void {
	const sidecars = record(field(artifact, "rawSidecarDigests"));
	requireKeys(
		sidecars,
		EXPECTED_SIDECAR_KEYS,
		"$.rawSidecarDigests",
		rejections,
	);
	if (!sidecars) return;
	for (const key of EXPECTED_SIDECAR_KEYS)
		if (!isSha256(field(sidecars, key)))
			addRejection(
				rejections,
				"RAW_SIDECAR_DIGEST_INVALID",
				`rawSidecarDigests.${key} must be SHA-256`,
				`$.rawSidecarDigests.${key}`,
			);
	const binding = field(artifact, "rawSidecarBindingSha256");
	if (!isSha256(binding)) {
		addRejection(
			rejections,
			"RAW_SIDECAR_DIGEST_INVALID",
			"rawSidecarBindingSha256 must be SHA-256",
			"$.rawSidecarBindingSha256",
		);
	} else if (sidecars) {
		const sourceBindingSha256 = field(
			record(field(artifact, "source")),
			"bindingSha256",
		);
		const scenarioHash = field(
			record(field(artifact, "scenario")),
			"scenarioHash",
		);
		const metricContractHashValue = field(artifact, "metricContractHash");
		const bindingInputs = [
			field(artifact, "comparisonId"),
			field(artifact, "runId"),
			field(artifact, "transport"),
			sourceBindingSha256,
			scenarioHash,
			metricContractHashValue,
		];
		if (
			bindingInputs.every((item) => item !== undefined) &&
			binding !==
				sha256Canonical({
					comparisonId: field(artifact, "comparisonId"),
					runId: field(artifact, "runId"),
					transport: field(artifact, "transport"),
					sourceBindingSha256,
					scenarioHash,
					metricContractHash: metricContractHashValue,
					rawSidecarDigests: sidecars,
				})
		) {
			addRejection(
				rejections,
				"RAW_SIDECAR_DIGEST_MISMATCH",
				"raw sidecar digests do not match their binding",
				"$.rawSidecarBindingSha256",
			);
		}
	}
}

function verifyStatus(
	artifact: Record<string, unknown>,
	rejections: ArtifactRejection[],
): void {
	const status = field(artifact, "evidenceStatus");
	const verdict = field(artifact, "scenarioVerdict");
	const promotable = field(artifact, "promotable");
	const artifactKind = field(artifact, "artifactKind");
	if (status !== "PASS" && status !== "FAIL" && status !== "BLOCKED")
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			"evidenceStatus is invalid",
			"$.evidenceStatus",
		);
	if (verdict !== "PASS" && verdict !== "MISS" && verdict !== "NO_VERDICT")
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			"scenarioVerdict is invalid",
			"$.scenarioVerdict",
		);
	if (typeof promotable !== "boolean")
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			"promotable must be boolean",
			"$.promotable",
		);
	if (status === "PASS" && verdict === "NO_VERDICT")
		addRejection(
			rejections,
			"STATUS_CONTRADICTION",
			"PASS evidence must have a PASS or MISS scenario verdict",
			"$",
		);
	if (
		status === "PASS" &&
		verdict === "PASS" &&
		promotable !== true &&
		artifactKind !== "test-fixture"
	)
		addRejection(
			rejections,
			"STATUS_CONTRADICTION",
			"a PASS scenario must be promotable",
			"$.promotable",
		);
	if (status === "PASS" && verdict === "MISS" && promotable !== false)
		addRejection(
			rejections,
			"STATUS_CONTRADICTION",
			"a measured MISS is not promotable",
			"$.promotable",
		);
	if (artifactKind === "test-fixture" && promotable !== false)
		addRejection(
			rejections,
			"ARTIFACT_FIXTURE_NOT_PROMOTABLE",
			"test fixtures must never be promotable",
			"$.promotable",
		);
	if (
		(status === "FAIL" || status === "BLOCKED") &&
		(verdict !== "NO_VERDICT" || promotable !== false)
	)
		addRejection(
			rejections,
			"STATUS_CONTRADICTION",
			"FAIL/BLOCKED evidence must have NO_VERDICT and promotable=false",
			"$",
		);
}

function verifySnapshot(
	snapshot: unknown,
	rejections: ArtifactRejection[],
	expectedDigest?: string,
	verificationContext?: ArtifactTrustContext,
): ArtifactVerification {
	if (!verifyTopLevelShape(snapshot, rejections))
		return { evidenceStatus: "FAIL", rejections };
	const artifact = snapshot as unknown as Record<string, unknown>;
	verifyTrustContext(verificationContext, artifact, rejections);
	verifyIdentity(artifact, rejections);
	verifySource(field(artifact, "source"), rejections);
	verifyTopology(field(artifact, "topology"), rejections);
	verifySmoke(field(artifact, "smoke"), rejections);
	const scenarioCell = verifyScenario(
		field(artifact, "scenario"),
		field(artifact, "transport"),
		rejections,
	);
	verifyTls(field(artifact, "tls"), rejections);
	verifyImpairment(field(artifact, "impairment"), rejections, scenarioCell);
	verifyCapacity(field(artifact, "capacity"), rejections);
	verifyCapacityProof(
		field(artifact, "capacityProof"),
		rejections,
		scenarioCell,
	);
	verifyMetrics(
		field(artifact, "metrics"),
		rejections,
		scenarioCell?.scenarioId,
		field(artifact, "artifactKind"),
	);
	verifyMetricContract(artifact, scenarioCell, rejections);
	verifyRuntime(field(artifact, "runtime"), rejections);
	verifyProcessProof(field(artifact, "processProof"), scenarioCell, rejections);
	verifyLedger(
		field(artifact, "ledger"),
		field(record(field(artifact, "metrics")), "unit"),
		rejections,
	);
	verifyTelemetry(field(artifact, "telemetry"), rejections);
	verifyRawSidecars(artifact, rejections);
	verifyStatus(artifact, rejections);
	const actualDigest = field(artifact, "artifactByteSha256");
	if (isSha256(actualDigest)) {
		if (expectedDigest !== undefined && actualDigest !== expectedDigest)
			addRejection(
				rejections,
				"ARTIFACT_BYTE_DIGEST_MISMATCH",
				"artifactByteSha256 does not bind the exact supplied bytes",
				"$.artifactByteSha256",
			);
		if (expectedDigest === undefined) {
			const masked = { ...artifact, artifactByteSha256: "0".repeat(64) };
			if (sha256Canonical(masked) !== actualDigest)
				addRejection(
					rejections,
					"ARTIFACT_BYTE_DIGEST_MISMATCH",
					"artifactByteSha256 does not bind canonical direct-object bytes",
					"$.artifactByteSha256",
				);
		}
	}
	const status = field(artifact, "evidenceStatus");
	const evidenceStatus =
		rejections.length > 0
			? "FAIL"
			: status === "PASS"
				? "PASS"
				: status === "BLOCKED"
					? "BLOCKED"
					: "FAIL";
	return {
		evidenceStatus,
		rejections,
		// Only an explicitly PASS arm is eligible for comparison.  A valid
		// BLOCKED/FAIL declaration remains a typed status, never an implicit
		// measurement that the comparator could accidentally rank.
		artifact:
			rejections.length === 0 &&
			status === "PASS" &&
			field(artifact, "artifactKind") === "measured"
				? (snapshot as RunArtifact)
				: undefined,
		artifactByteSha256: isSha256(actualDigest) ? actualDigest : undefined,
		artifactKind:
			field(artifact, "artifactKind") === "measured" ||
			field(artifact, "artifactKind") === "test-fixture"
				? (field(artifact, "artifactKind") as "measured" | "test-fixture")
				: undefined,
	};
}

export function verifyRunArtifact(
	input: ArtifactBytes,
	verificationContext?: ArtifactTrustContext,
): ArtifactVerification {
	let bytes: Uint8Array;
	try {
		bytes = artifactInputBytes(input);
		if (bytes.byteLength > MAX_ARTIFACT_BYTES)
			throw new RangeError("artifact bytes are too large");
	} catch (error) {
		const tooLarge =
			error instanceof RangeError && /too large/i.test(error.message);
		const code: ArtifactRejectionCode = tooLarge
			? "ARTIFACT_BYTES_TOO_LARGE"
			: "ARTIFACT_BYTES_INVALID";
		return {
			evidenceStatus: "FAIL",
			rejections: [
				{
					code,
					reason:
						error instanceof Error
							? error.message
							: "artifact input is invalid",
				},
			],
		};
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch {
		return {
			evidenceStatus: "FAIL",
			rejections: [
				{
					code: "ARTIFACT_BYTES_INVALID",
					reason: "artifact bytes are not valid UTF-8 JSON",
				},
			],
		};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			evidenceStatus: "FAIL",
			rejections: [
				{
					code: "ARTIFACT_BYTES_INVALID",
					reason: "artifact bytes are not valid JSON",
				},
			],
		};
	}
	const duplicateKey = findDuplicateJsonKey(text);
	// Let the byte-digest parser report its more specific stable rejection for
	// duplicate artifactByteSha256 keys.
	if (duplicateKey !== undefined && duplicateKey !== "artifactByteSha256") {
		return {
			evidenceStatus: "FAIL",
			rejections: [
				{
					code: "SCHEMA_INVALID_FIELD",
					reason: `duplicate JSON object key ${duplicateKey}`,
				},
			],
		};
	}
	let snapshot: unknown;
	try {
		snapshot = snapshotEvidenceValue(parsed);
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "artifact schema cannot be snapshotted";
		const code: ArtifactRejectionCode = /\.scenario\.payload\.data/.test(
			message,
		)
			? "SCENARIO_PAYLOAD_INVALID"
			: /\.metrics\.clock/.test(message)
				? "CLOCK_PROVENANCE_INVALID"
				: /resource|too long|budget|node|edge/i.test(message)
					? "SCHEMA_RESOURCE_LIMIT"
					: "SCHEMA_INVALID_FIELD";
		return {
			evidenceStatus: "FAIL",
			rejections: [
				{
					code,
					reason: message,
				},
			],
		};
	}
	const rejections: ArtifactRejection[] = [];
	let digest: string | undefined;
	try {
		digest = artifactByteSha256(bytes);
	} catch (error) {
		addRejection(
			rejections,
			"ARTIFACT_BYTE_DIGEST_INVALID",
			error instanceof Error
				? error.message
				: "artifact byte digest is invalid",
			"$.artifactByteSha256",
		);
	}
	const result = verifySnapshot(
		snapshot,
		rejections,
		digest,
		verificationContext,
	);
	if (result.rejections.length === 0 && digest !== result.artifactByteSha256) {
		return {
			...result,
			evidenceStatus: "FAIL",
			rejections: [
				{
					code: "ARTIFACT_BYTE_DIGEST_MISMATCH",
					reason: "artifactByteSha256 does not bind the exact supplied bytes",
					path: "$.artifactByteSha256",
				},
			],
		};
	}
	return result;
}

export function verifyRunArtifactObject(
	input: unknown,
	verificationContext?: ArtifactTrustContext,
): ArtifactVerification {
	let snapshot: unknown;
	try {
		snapshot = snapshotEvidenceValue(input);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "artifact object is invalid";
		const code: ArtifactRejectionCode = /\.metrics\.samples\[\d+\]/.test(
			message,
		)
			? "METRICS_SAMPLE_INVALID"
			: /\.metrics\.samples/.test(message)
				? /sparse/i.test(message)
					? "METRICS_SAMPLES_SPARSE"
					: "METRICS_SAMPLE_INVALID"
				: /\.scenario\.payload\.data/.test(message)
					? "SCENARIO_PAYLOAD_INVALID"
					: /\.metrics\.clock/.test(message)
						? "CLOCK_PROVENANCE_INVALID"
						: /\.metrics\.percentiles/.test(message)
							? "METRICS_PERCENTILES_INVALID"
							: /resource|cycle|shared|cannot be snapshotted|too long|budget/i.test(
										message,
									)
								? "SCHEMA_RESOURCE_LIMIT"
								: "SCHEMA_RESOURCE_LIMIT";
		return { evidenceStatus: "FAIL", rejections: [{ code, reason: message }] };
	}
	return verifySnapshot(snapshot, [], undefined, verificationContext);
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
		toolchain: artifact.source.toolchain,
		rawSidecarDigests: artifact.rawSidecarDigests,
	};
}

export { artifactByteSha256 };

export {
	classifyVerdictTuple,
	parseRecoveryMode,
	validateFixtureOnlyEntrypoint,
	validateOfficialEntrypointContract,
};

/**
 * Syntax-only parse of the verifier CLI. The trailing positional names the
 * campaign evidence root the operator wants verified; it is carried as an
 * opaque string and never resolved or opened here.
 */
export function parseVerifyArgs(argv: readonly string[]): StagedTrustArgs {
	return parseStagedTrustArgv("verify", argv);
}

/**
 * The evidence directory to read, refusing typed when there is nothing there.
 *
 * The root used to print `Directory '<resolved official path>' does not exist`
 * straight to stderr, which put an absolute official path into CI logs on a
 * plain operator typo — the one thing every other refusal on these roots is
 * careful not to do. The existence check is injected so the refusal is
 * reachable from a test: the root itself fails closed on the quarantined trust
 * boundary long before it gets here.
 */
export function requireExistingEvidenceDir(
	dir: string,
	exists: (path: string) => boolean,
): string {
	if (!exists(dir)) {
		throw new ComparisonCliError("verify", "VERIFY_EVIDENCE_DIR_MISSING");
	}
	return dir;
}

// Entrypoint when invoked directly via CLI
if (import.meta.main) {
	// The package script runs this root with --fixture-only. That flag used to be
	// consumed as the evidence directory, so `bun run compare:verify` resolved an
	// official directory literally named "--fixture-only"; it is now parsed, and
	// a fixture invocation reads no official evidence at all.
	let parsedArgs: StagedTrustArgs;
	try {
		parsedArgs = parseVerifyArgs(process.argv.slice(2));
	} catch (error: unknown) {
		console.error(`[verify] Error: ${comparisonErrorCode(error)}`);
		process.exit(1);
	}
	if (parsedArgs.fixtureOnly) {
		console.log(
			"[verify] fixture-only: no official evidence is read. Run the supervisor for an official verification.",
		);
		process.exit(0);
	}

	try {
		assertOfficialComparisonIoAvailable();
	} catch (error: unknown) {
		console.error(`[verify] Error: ${comparisonErrorCode(error)}`);
		process.exit(1);
	}
	const { readdirSync, existsSync } = await import("node:fs");
	const { join } = await import("node:path");

	const candidate = parsedArgs.candidateId;
	const campaignId = parsedArgs.campaignId;
	const dir = resolveOfficialComparisonOutputDir({
		candidate,
		campaignId,
		outputDir: parsedArgs.positionals[0],
	});
	try {
		requireExistingEvidenceDir(dir, existsSync);
	} catch (error: unknown) {
		console.error(`[verify] Error: ${comparisonErrorCode(error)}`);
		process.exit(1);
	}

	const files = readdirSync(dir).filter(
		(f) => f.endsWith(".json") && f !== "manifest.json",
	);

	if (files.length === 0) {
		console.log(`[verify] No evidence artifacts found in '${dir}'.`);
		process.exit(0);
	}

	console.log(
		`===============================================================`,
	);
	console.log(`VERIFYING ${files.length} EVIDENCE ARTIFACTS IN '${dir}'`);
	console.log(
		`===============================================================`,
	);

	let passed = 0;
	let failed = 0;

	for (const file of files) {
		const filePath = resolveOfficialComparisonOutputFile({
			candidate,
			campaignId,
			outputDir: dir,
			outputFile: join(dir, file),
		});
		const bytes = readOfficialComparisonFile(filePath);
		let parsed: RunArtifact;
		try {
			parsed = JSON.parse(new TextDecoder().decode(bytes)) as RunArtifact;
		} catch (err) {
			console.log(`[FAIL] ${file} -> Invalid JSON`);
			failed++;
			continue;
		}

		const trustCtx = trustContextForArtifact(parsed);
		const result = verifyRunArtifact(bytes, trustCtx);
		// No CLI flag binds an external trust boundary on this root, and an ambient
		// variable is not one either, so every artifact stays quarantined until the
		// supervisor states a bound.
		const quarantine = checkPromotionQuarantine({
			artifact: parsed,
			externalTrustBound: undefined,
			expectedComparisonId: campaignId,
		});

		if (result.evidenceStatus === "PASS" && quarantine.promotable) {
			console.log(`[PASS] ${file} (${bytes.byteLength} bytes)`);
			passed++;
		} else {
			console.log(
				`[${result.evidenceStatus === "PASS" ? "QUARANTINED" : "FAIL"}] ${file} -> ${[
					...result.rejections.map((r) => `${r.code}: ${r.reason}`),
					...quarantine.reasons.map((r) => `${r.code}: ${r.reason}`),
				].join("; ")}`,
			);
			failed++;
		}
	}

	console.log(
		`===============================================================`,
	);
	console.log(
		`VERIFICATION SUMMARY: ${passed}/${files.length} passed, ${failed} failed.`,
	);
	console.log(
		`===============================================================`,
	);

	if (failed > 0) {
		process.exit(1);
	}
}
