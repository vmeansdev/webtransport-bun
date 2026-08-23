import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { canonicalJson, sha256Canonical } from "./canonical.ts";
import {
	type ArtifactBytes,
	type ArtifactRejection,
	type ArtifactRejectionCode,
	type ArtifactVerification,
	addRejection,
	artifactByteSha256,
	artifactInputBytes,
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
	type RunArtifact,
	snapshotEvidenceValue,
} from "./evidence.ts";
import {
	CANONICAL_CAPACITY_PROFILE,
	CANONICAL_CONNECTION_SETUP,
	CANONICAL_SCENARIO_REGISTRY,
	getScenarioCell,
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
	"comparisonId",
	"runId",
	"transport",
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
	if (field(artifact, "armKind") !== "primary")
		addRejection(
			rejections,
			"SCHEMA_INVALID_FIELD",
			"armKind must be primary",
			"$.armKind",
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
	if (
		!Array.isArray(armOrder) ||
		armOrder.length !== 4 ||
		!armOrder.every((arm) => arm === "ws" || arm === "wt") ||
		(armOrder.join(",") !== "ws,wt,wt,ws" &&
			armOrder.join(",") !== "wt,ws,ws,wt")
	)
		addRejection(
			rejections,
			"SCENARIO_ARM_ORDER_INVALID",
			"arm order must be a seeded balanced WS/WT block order",
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

function expectedRequestedImpairment(
	cell: ReturnType<typeof getScenarioCell> | undefined,
): { qdisc: "fq" | "netem"; delayMs: number; lossPercent: number } {
	const parameters = cell?.parameters as Record<string, unknown> | undefined;
	if (cell?.scenarioId === "game-tick-loss") {
		return {
			qdisc: "netem",
			delayMs: parameters?.delayMs as number,
			lossPercent: parameters?.lossPercent as number,
		};
	}
	if (parameters?.path === "delay40")
		return { qdisc: "netem", delayMs: 40, lossPercent: 0 };
	if (parameters?.path === "delay40-loss1")
		return { qdisc: "netem", delayMs: 40, lossPercent: 1 };
	return INITIAL_IMPAIRMENT;
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
			accepted + rejected > attempted
		)
			addRejection(
				rejections,
				"CAPACITY_ADMISSION_COUNTER_INVALID",
				`${section}.accepted plus rejected cannot exceed attempted`,
				`$.capacity.admissionCounters.${section}`,
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
	const parameters = cell?.parameters as Record<string, unknown> | undefined;
	const liveConnections =
		cell?.scenarioId === "connection-memory"
			? parameters?.liveConnections
			: cell?.scenarioId === "handshake-matrix" ||
					cell?.scenarioId === "reconnect-storm"
				? (parameters?.clientCount ?? parameters?.concurrency)
				: undefined;
	const isConnectionScale =
		typeof liveConnections === "number" && liveConnections > 0;
	const expectedFreePorts = isConnectionScale
		? Math.ceil(liveConnections * 1.25)
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
			required !== expectedFreePorts
		)
			addRejection(
				rejections,
				"CAPACITY_EPHEMERAL_PORT_PROOF_INVALID",
				`requiredFreePorts must equal ceil(liveConnections * 1.25) = ${expectedFreePorts}`,
				"$.capacityProof.mac.ephemeralPorts.requiredFreePorts",
			);
	}
}

function verifyMetrics(value: unknown, rejections: ArtifactRejection[]): void {
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
	if (!Array.isArray(samples)) {
		addRejection(
			rejections,
			"METRICS_SAMPLE_INVALID",
			"metrics.samples must be an array",
			"$.metrics.samples",
		);
	} else if (samples.length === 0) {
		addRejection(
			rejections,
			"METRICS_SAMPLES_EMPTY",
			"metrics.samples must not be empty",
			"$.metrics.samples",
		);
	} else if (samples.length > MAX_ARTIFACT_SAMPLES) {
		addRejection(
			rejections,
			"METRICS_SAMPLE_INVALID",
			"metrics.samples exceeds the cap",
			"$.metrics.samples",
		);
	} else {
		for (let index = 0; index < samples.length; index += 1) {
			if (!Object.hasOwn(samples, index)) {
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
			)
				addRejection(
					rejections,
					"METRICS_SAMPLE_INVALID",
					"metrics.samples must contain finite non-negative numbers",
					`$.metrics.samples[${index}]`,
				);
		}
	}
	const percentiles = record(field(metrics, "percentiles"));
	requireKeys(
		percentiles,
		["p50", "p95", "p99"],
		"$.metrics.percentiles",
		rejections,
	);
	if (
		!percentiles ||
		!Array.isArray(samples) ||
		samples.length === 0 ||
		samples.some(
			(sample) =>
				typeof sample !== "number" || !Number.isFinite(sample) || sample < 0,
		)
	)
		return;
	if (
		!percentiles ||
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
		field(percentiles, "p50"),
		field(percentiles, "p95"),
		field(percentiles, "p99"),
	];
	const expected = [summary.p50, summary.p95, summary.p99];
	if (
		actual.some(
			(value, index) =>
				typeof value !== "number" ||
				Math.abs(value - (expected[index] as number)) > 1e-9,
		) ||
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
	} else if (sidecars && binding !== sha256Canonical(sidecars)) {
		addRejection(
			rejections,
			"RAW_SIDECAR_DIGEST_MISMATCH",
			"raw sidecar digests do not match their binding",
			"$.rawSidecarBindingSha256",
		);
	}
}

function verifyStatus(
	artifact: Record<string, unknown>,
	rejections: ArtifactRejection[],
): void {
	const status = field(artifact, "evidenceStatus");
	const verdict = field(artifact, "scenarioVerdict");
	const promotable = field(artifact, "promotable");
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
	if (status === "PASS" && verdict === "PASS" && promotable !== true)
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
): ArtifactVerification {
	if (!verifyTopLevelShape(snapshot, rejections))
		return { evidenceStatus: "FAIL", rejections };
	const artifact = snapshot as unknown as Record<string, unknown>;
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
	verifyMetrics(field(artifact, "metrics"), rejections);
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
			rejections.length === 0 && status === "PASS"
				? (snapshot as RunArtifact)
				: undefined,
		artifactByteSha256: isSha256(actualDigest) ? actualDigest : undefined,
	};
}

export function verifyRunArtifact(input: ArtifactBytes): ArtifactVerification {
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
	const result = verifySnapshot(snapshot, rejections, digest);
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

export function verifyRunArtifactObject(input: unknown): ArtifactVerification {
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
							: typeof input === "object" &&
									input !== null &&
									!Object.hasOwn(input, "source")
								? "SCHEMA_OWN_FIELD_REQUIRED"
								: "SCHEMA_ROOT_INVALID";
		return { evidenceStatus: "FAIL", rejections: [{ code, reason: message }] };
	}
	return verifySnapshot(snapshot, []);
}

export { artifactByteSha256 };
