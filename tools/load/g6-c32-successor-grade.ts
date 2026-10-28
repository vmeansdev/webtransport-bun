/** Successor-only full-rate G6 grader for the c-32 RCA campaign. */
import { readFileSync, writeFileSync } from "node:fs";
import {
	type AckReflectorMode,
	resolveAckReflectorMode,
} from "./g6-ack-reflector-rule.ts";
import { resolveServerGroMode, type ServerGroMode } from "./g6-server-gro.ts";
import {
	applySteeringValidity,
	G6_SHARDED_CLAUSES,
	G6_SHARDED_VALIDITY,
	gradeRungForProfile,
	type RungScan,
} from "./g6-sharded-grade.ts";

type Profile = {
	shards: number;
	endpoints: number;
	connectConcurrency: number;
	connectRatePerSec: number;
	fixedSourcePortBase: number | null;
	ackReflector: AckReflectorMode;
	serverWorkers: number;
	serverGro: ServerGroMode;
	serverRecvRuntime: string;
	ackCadence: string;
	serverUdpSendBufferBytes?: number;
	serverUdpSendEagainMode?: string;
	reflectRingBypass?: string;
	/** Egress pacer datagrams/s per shard; 0 (and absent) = unpaced. */
	pacerPps?: number;
	/** Cross-connection UDP send batch size; 0 (and absent) = off. */
	udpSendBatch?: number;
};

export type SuccessorGradeRequest = {
	rung: number;
	scan: RungScan;
	postRunSteeringText: string;
	expectCandidate: string;
	registrationSha256: string;
	profile: Profile;
};

export type SuccessorGradeDecision = {
	schema: "g6-c32-successor-grade/1";
	profileLabel: "successor-g6";
	registrationSha256: string;
	expectCandidate: string;
	profile: Profile;
	valid: boolean;
	invalidReasons: string[];
	gate: "PASS" | "MISS" | null;
	clauses: ReturnType<typeof gradeRungForProfile>["clauses"];
	steeredTotal: number | string | null;
	udpSendBatchCongestionDropped: number | null;
	datagramReflectRingBypassed: number | null;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function clientEnvelope(scan: RungScan): JsonRecord | null {
	const marker = "mmo-client: json ";
	const line = scan.clientStdout
		.split(/\r?\n/)
		.find((entry) => entry.startsWith(marker));
	if (!line) return null;
	try {
		return record(JSON.parse(line.slice(marker.length)));
	} catch {
		return null;
	}
}

function shapeReasons(
	scan: RungScan,
	report: JsonRecord | null,
	request: SuccessorGradeRequest,
): string[] {
	const reasons: string[] = [];
	const { profile } = request;
	if (!/^[0-9a-f]{64}$/.test(request.registrationSha256))
		reasons.push("registration SHA-256 is malformed");
	if (scan.config.connectConcurrency !== profile.connectConcurrency)
		reasons.push("scan connectConcurrency differs from registered profile");
	if (scan.config.connectRatePerSec !== profile.connectRatePerSec)
		reasons.push("scan connectRatePerSec differs from registered profile");
	if (scan.config.fixedSourcePortBase !== profile.fixedSourcePortBase)
		reasons.push("scan fixedSourcePortBase differs from registered profile");
	if ((scan.config.ackReflector ?? "js") !== profile.ackReflector)
		reasons.push("scan ackReflector differs from registered profile");
	// A scan predating the knob ran the fixed default, so absence means 2 —
	// never "whatever the profile asked for".
	if ((scan.config.serverWorkers ?? 2) !== profile.serverWorkers)
		reasons.push("scan serverWorkers differs from registered profile");
	// A scan predating the knob ran the NIC default, so absence means "on" —
	// never "whatever the profile asked for".
	if ((scan.config.serverGro ?? "on") !== profile.serverGro)
		reasons.push("scan serverGro differs from registered profile");
	// A scan predating the knob ran the shared default, so absence means
	// "shared" — never "whatever the profile asked for".
	if ((scan.config.serverRecvRuntime ?? "shared") !== profile.serverRecvRuntime)
		reasons.push("scan serverRecvRuntime differs from registered profile");
	// A scan predating the knob ran quinn's stock cadence, so absence means
	// "default" — never "whatever the profile asked for".
	if ((scan.config.ackCadence ?? "default") !== profile.ackCadence)
		reasons.push("scan ackCadence differs from registered profile");
	// A scan predating the knob ran the default bind path, so absence means 0.
	if (
		Number(scan.config.serverUdpSendBufferBytes ?? 0) !==
		(profile.serverUdpSendBufferBytes ?? 0)
	)
		reasons.push(
			"scan serverUdpSendBufferBytes differs from registered profile",
		);
	if (
		(scan.config.serverUdpSendEagainMode ?? "wait") !==
		(profile.serverUdpSendEagainMode ?? "wait")
	)
		reasons.push(
			"scan serverUdpSendEagainMode differs from registered profile",
		);
	if (
		scan.schema !== "g6-sharded-scan/2" &&
		scan.schema !== "g6-sharded-scan/3"
	)
		reasons.push("scan schema is not a supported g6-sharded-scan schema");
	const observedReflectRingBypass =
		scan.schema === "g6-sharded-scan/3"
			? scan.config.reflectRingBypass
			: (scan.config.reflectRingBypass ?? "off");
	if (
		scan.schema === "g6-sharded-scan/3" &&
		scan.config.reflectRingBypass === undefined
	)
		reasons.push("scan /3 reflectRingBypass is missing");
	if (observedReflectRingBypass !== (profile.reflectRingBypass ?? "off"))
		reasons.push("scan reflectRingBypass differs from registered profile");
	// Same reasoning as the evaluator: the scan records the pacer rate as the
	// env string it was handed (null when unpaced) plus the paced flag.
	const expectedPacerPps = profile.pacerPps ?? 0;
	if (Number(scan.config.pacerPps ?? 0) !== expectedPacerPps)
		reasons.push("scan pacerPps differs from registered profile");
	if (Boolean(scan.config.paced) !== expectedPacerPps > 0)
		reasons.push("scan paced flag differs from registered profile");
	// A scan predating the knob ran unbatched, so absence means 0.
	if (Number(scan.config.udpSendBatch ?? 0) !== (profile.udpSendBatch ?? 0))
		reasons.push("scan udpSendBatch differs from registered profile");
	if (!report)
		return [...reasons, "mmo-client/2 report is missing or malformed"];
	if (report.schema !== "mmo-client/2")
		reasons.push("successor grading requires mmo-client/2");
	const preRegistration = record(report.preRegistration);
	if (preRegistration?.sha256 !== request.registrationSha256)
		reasons.push(
			"client registration digest differs from successor registration",
		);
	if (report.connectConcurrency !== profile.connectConcurrency)
		reasons.push("client connectConcurrency differs from registered profile");
	if (report.connectRatePerSec !== profile.connectRatePerSec)
		reasons.push("client connectRatePerSec differs from registered profile");
	const config = record(report.config);
	if (config?.fixedSourcePortBase !== profile.fixedSourcePortBase)
		reasons.push("client fixedSourcePortBase differs from registered profile");
	const starts = record(report.connectStarts);
	if (starts?.offered !== request.rung || starts.achieved !== request.rung)
		reasons.push("connect starts do not attest every requested session");
	const client = record(report.client);
	const addresses = client?.endpointSourceAddresses;
	if (
		!Array.isArray(addresses) ||
		addresses.length !== profile.endpoints ||
		addresses.some((address) => typeof address !== "string") ||
		new Set(addresses).size !== profile.endpoints
	)
		reasons.push("endpoint source addresses do not attest the registered pool");
	return reasons;
}

function udpSendBatchCongestionDropped(
	scan: RungScan,
	expectedShards: number,
): number | null {
	if (scan.shards.length !== expectedShards) return null;
	let total = 0;
	for (const shard of scan.shards) {
		const value =
			shard.windows?.lifetime?.metrics?.udpSendBatchCongestionDropped;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
			return null;
		total += value;
		if (!Number.isSafeInteger(total)) return null;
	}
	const aggregate =
		scan.aggregate.lifetime?.metrics?.udpSendBatchCongestionDropped;
	return typeof aggregate === "number" &&
		Number.isSafeInteger(aggregate) &&
		aggregate >= 0 &&
		aggregate === total
		? total
		: null;
}

const REFLECT_RING_COUNTERS = [
	"datagramReflectRingBypassMarked",
	"datagramReflectRingBypassRefreshed",
	"datagramReflectRingBypassRefused",
	"datagramReflectRingBypassExpired",
	"datagramReflectRingBypassed",
	"datagramReflectRingDirectBlocked",
	"datagramReflectRingDirectErrors",
	"datagramReflectRingGsoFallback",
] as const;

function reflectRingCounter(
	scan: RungScan,
	expectedShards: number,
	field: (typeof REFLECT_RING_COUNTERS)[number],
): number | null {
	if (scan.shards.length !== expectedShards) return null;
	let total = 0;
	for (const shard of scan.shards) {
		const value = shard.windows?.lifetime?.metrics?.[field];
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
			return null;
		total += value;
	}
	const aggregate = scan.aggregate.lifetime?.metrics?.[field];
	return typeof aggregate === "number" &&
		Number.isSafeInteger(aggregate) &&
		aggregate === total
		? total
		: null;
}

export function gradeSuccessorRung(
	request: SuccessorGradeRequest,
): SuccessorGradeDecision {
	const verdict = gradeRungForProfile(
		request.rung,
		request.scan,
		request.expectCandidate,
		{
			requiredEndpoints: request.profile.endpoints,
			requiredShards: request.profile.shards,
			pacedEmitter: (request.profile.pacerPps ?? 0) > 0,
		},
	);
	const shape = shapeReasons(
		request.scan,
		clientEnvelope(request.scan),
		request,
	);
	const congestionDropped = udpSendBatchCongestionDropped(
		request.scan,
		request.profile.shards,
	);
	if (congestionDropped === null)
		shape.push("UDP send batch congestion-drop evidence is incomplete");
	let reflectRingBypassed: number | null = 0;
	if (request.scan.schema === "g6-sharded-scan/3") {
		for (const field of REFLECT_RING_COUNTERS) {
			const value = reflectRingCounter(
				request.scan,
				request.profile.shards,
				field,
			);
			if (value === null) shape.push(`${field} evidence is incomplete`);
			if (field === "datagramReflectRingBypassed") reflectRingBypassed = value;
		}
	}
	if (
		(request.profile.reflectRingBypass ?? "off") === "on" &&
		reflectRingBypassed === 0
	)
		shape.push(
			"reflect ring bypass was enabled but no datagram bypassed the ring",
		);
	if (shape.length > 0) {
		verdict.valid = false;
		verdict.gate = null;
		verdict.invalidReasons.push(...shape);
	}
	const steering = applySteeringValidity(
		[verdict],
		[request.postRunSteeringText],
	);
	return {
		schema: "g6-c32-successor-grade/1",
		profileLabel: "successor-g6",
		registrationSha256: request.registrationSha256,
		expectCandidate: request.expectCandidate,
		profile: request.profile,
		valid: verdict.valid,
		invalidReasons: verdict.invalidReasons,
		gate: verdict.gate,
		clauses: verdict.clauses,
		steeredTotal: steering.steeredCumulative[0] ?? null,
		udpSendBatchCongestionDropped: congestionDropped,
		datagramReflectRingBypassed: reflectRingBypassed,
	};
}

function arg(name: string): string {
	const index = process.argv.indexOf(`--${name}`);
	const value = index === -1 ? undefined : process.argv[index + 1];
	if (value === undefined) throw new Error(`--${name} is required`);
	return value;
}

function optionalArg(name: string): string | null {
	const index = process.argv.indexOf(`--${name}`);
	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function integerArg(name: string, options: { zero?: boolean } = {}): number {
	const raw = arg(name);
	if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be an integer`);
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || (!options.zero && value === 0))
		throw new Error(`--${name} is out of range`);
	return value;
}

export function parseFixedSourcePortBase(
	raw: string,
	endpoints: number,
): number | null {
	if (raw === "none") return null;
	if (!/^\d+$/.test(raw))
		throw new Error(
			"--expected-fixed-source-port-base must be none or an integer",
		);
	const value = Number(raw);
	if (
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > 65_535 ||
		value + endpoints - 1 > 65_535
	)
		throw new Error("--expected-fixed-source-port-base range is invalid");
	return value;
}

if (import.meta.main) {
	const fixedRaw = arg("expected-fixed-source-port-base");
	const endpoints = integerArg("expected-endpoints");
	const fixedSourcePortBase = parseFixedSourcePortBase(fixedRaw, endpoints);
	const shards = integerArg("expected-shards");
	const request: SuccessorGradeRequest = {
		rung: integerArg("rung"),
		scan: JSON.parse(readFileSync(arg("scan"), "utf8")),
		postRunSteeringText: readFileSync(arg("post-run-steering"), "utf8"),
		expectCandidate: arg("expect-candidate"),
		registrationSha256: arg("registration-sha256"),
		profile: {
			shards,
			endpoints,
			connectConcurrency: integerArg("expected-connect-concurrency"),
			connectRatePerSec: integerArg("expected-connect-rate", { zero: true }),
			fixedSourcePortBase,
			ackReflector: resolveAckReflectorMode(
				optionalArg("expected-ack-reflector") ?? undefined,
			),
			serverWorkers: Number(optionalArg("expected-server-workers") ?? 2),
			serverGro: resolveServerGroMode(
				optionalArg("expected-server-gro") ?? undefined,
			),
			serverRecvRuntime:
				optionalArg("expected-server-recv-runtime") ?? "shared",
			ackCadence: optionalArg("expected-ack-cadence") ?? "default",
			serverUdpSendBufferBytes: Number(
				optionalArg("expected-server-udp-sndbuf-bytes") ?? 0,
			),
			serverUdpSendEagainMode:
				optionalArg("expected-server-udp-send-eagain-mode") ?? "wait",
			reflectRingBypass: optionalArg("expected-reflect-ring-bypass") ?? "off",
			pacerPps: Number(optionalArg("expected-pacer-pps") ?? 0),
			udpSendBatch: Number(optionalArg("expected-udp-send-batch") ?? 0),
		},
	};
	const decision = gradeSuccessorRung(request);
	writeFileSync(arg("out"), `${JSON.stringify(decision, null, 2)}\n`);
	console.log(JSON.stringify(decision));
	process.exitCode = decision.valid ? 0 : 2;
}

export { G6_SHARDED_CLAUSES, G6_SHARDED_VALIDITY };
