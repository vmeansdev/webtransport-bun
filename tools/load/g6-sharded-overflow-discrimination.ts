import { readFileSync, writeFileSync } from "node:fs";
import {
	deltaHostUdpCounters,
	type HostUdpCounters,
} from "./g6-sharded-diagnostic.ts";

const PHASES = ["connect", "steady", "drain", "idle"] as const;
const SHARD_PHASES = [...PHASES, "stop"] as const;
const HOST_COUNTER_FIELDS = [
	"InDatagrams",
	"NoPorts",
	"InErrors",
	"OutDatagrams",
	"RcvbufErrors",
	"SndbufErrors",
] as const;

export type OverflowClassification =
	| "GENERATOR_UDP_RECEIVE_OVERFLOW"
	| "SERVER_UDP_RECEIVE_OVERFLOW"
	| "BIDIRECTIONAL_UDP_RECEIVE_OVERFLOW"
	| "SERVER_SOCKET_OR_STEERING_PRESSURE"
	| "INCONCLUSIVE";

type PhaseName = (typeof PHASES)[number];
type PhaseSamples = Record<PhaseName, HostUdpCounters>;
type HostUdpDeltas = {
	connectToSteady: HostUdpCounters;
	steadyToDrain: HostUdpCounters;
	drainToIdle: HostUdpCounters;
	total: HostUdpCounters;
};

type SocketDropEvidence = {
	rung: number;
	serverId: number;
	t0: number;
	t1: number;
	t2: number;
};

type SocketDropDelta = {
	t0ToT1: number;
	t1ToT2: number;
	t0ToT2: number;
};

export type OverflowDiscriminationVerdict = {
	schema: "g6-sharded-overflow-discrimination/1";
	classification: OverflowClassification;
	reasons: string[];
	evidence: {
		serverHostUdp: unknown;
		generatorHostUdp: unknown;
		bpfPreArm: unknown;
		perShardSocketDrops: SocketDropEvidence[];
	};
	deltas: {
		serverHostUdp: HostUdpDeltas | null;
		generatorHostUdp: HostUdpDeltas | null;
		perShardSocketDrops: Record<number, SocketDropDelta>;
	};
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as JsonRecord)
		: null;
}

function isCounter(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}

function exactSequence(value: unknown, expected: readonly string[]): boolean {
	return (
		record(value) !== null &&
		Object.keys(value as JsonRecord).length === expected.length &&
		Object.keys(value as JsonRecord).every(
			(key, index) => key === expected[index],
		)
	);
}

function hostCounters(value: unknown): HostUdpCounters | null {
	const source = record(value);
	if (!source) return null;
	const counters = {} as HostUdpCounters;
	for (const field of HOST_COUNTER_FIELDS) {
		if (!isCounter(source[field])) return null;
		counters[field] = source[field] as number;
	}
	return counters;
}

function phaseSamples(
	value: unknown,
	label: string,
	reasons: string[],
): PhaseSamples | null {
	if (!exactSequence(value, PHASES)) {
		reasons.push(`${label} must contain exactly ${PHASES.join(",")}`);
		return null;
	}
	const source = value as JsonRecord;
	const samples = {} as PhaseSamples;
	for (const phase of PHASES) {
		const sample = hostCounters(source[phase]);
		if (!sample) {
			reasons.push(
				`${label}.${phase} is not a complete nonnegative UDP sample`,
			);
			return null;
		}
		samples[phase] = sample;
	}
	return samples;
}

function hostDeltas(
	samples: PhaseSamples | null,
	label: string,
	reasons: string[],
): HostUdpDeltas | null {
	if (!samples) return null;
	const connectToSteady = deltaHostUdpCounters(samples.connect, samples.steady);
	const steadyToDrain = deltaHostUdpCounters(samples.steady, samples.drain);
	const drainToIdle = deltaHostUdpCounters(samples.drain, samples.idle);
	const total = deltaHostUdpCounters(samples.connect, samples.idle);
	if (!connectToSteady || !steadyToDrain || !drainToIdle || !total) {
		reasons.push(`${label} has a missing, invalid, or decreasing counter`);
		return null;
	}
	return { connectToSteady, steadyToDrain, drainToIdle, total };
}

function validateBpfPreArm(
	value: unknown,
	launchedShardCount: number | null,
	reasons: string[],
): void {
	const preArm = record(value);
	if (!preArm) {
		reasons.push("server bpfPreArm is required");
		return;
	}
	if (preArm.fresh !== true)
		reasons.push("server bpfPreArm.fresh must be true");
	const receiptValidation = record(preArm.receiptValidation);
	if (
		!receiptValidation ||
		receiptValidation.valid !== true ||
		!isCounter(receiptValidation.instances) ||
		(launchedShardCount !== null &&
			receiptValidation.instances !== launchedShardCount)
	) {
		reasons.push(
			"server bpfPreArm.receiptValidation must attest to the launched shard count",
		);
	}
	if (!isCounter(preArm.socksEntries)) {
		reasons.push("server bpfPreArm.socksEntries must be a nonnegative integer");
	} else if (
		launchedShardCount !== null &&
		preArm.socksEntries !== launchedShardCount
	) {
		reasons.push(
			"server bpfPreArm.socksEntries must equal the launched shard count",
		);
	}
	const steerStats = record(preArm.steerStats);
	if (
		!steerStats ||
		!isCounter(steerStats.steered) ||
		!isCounter(steerStats.fallback)
	) {
		reasons.push(
			"server bpfPreArm.steerStats must contain nonnegative steered and fallback counters",
		);
	} else if (steerStats.steered !== 0 || steerStats.fallback !== 0) {
		reasons.push("server bpfPreArm.steerStats must start at zero");
	}
}

function validateShardPhaseOrder(
	value: unknown,
	reasons: string[],
): number | null {
	if (!Array.isArray(value) || value.length === 0) {
		reasons.push("server perShardLifecycle must contain at least one shard");
		return null;
	}
	let valid = true;
	for (const shard of value) {
		const shardRecord = record(shard);
		const serverId = shardRecord?.serverId;
		const phases = Array.isArray(shardRecord?.boundaries)
			? shardRecord.boundaries.map((boundary) => record(boundary)?.phase)
			: null;
		if (
			!Number.isSafeInteger(serverId) ||
			!Array.isArray(phases) ||
			phases.length !== SHARD_PHASES.length ||
			phases.some((phase, index) => phase !== SHARD_PHASES[index])
		) {
			valid = false;
			reasons.push(
				`server shard ${String(serverId ?? "unknown")} phase sequence must be ${SHARD_PHASES.join(",")}`,
			);
		}
	}
	return valid ? value.length : null;
}

function readSocketDrops(
	ladder: unknown,
	reasons: string[],
): { evidence: SocketDropEvidence[]; deltas: Record<number, SocketDropDelta> } {
	const evidence: SocketDropEvidence[] = [];
	const deltas: Record<number, SocketDropDelta> = {};
	if (!Array.isArray(ladder) || ladder.length === 0) {
		reasons.push("server ladder must contain at least one T0/T1/T2 block");
		return { evidence, deltas };
	}
	for (const [rungIndex, rung] of ladder.entries()) {
		const rungRecord = record(rung);
		const rungNumber = rungRecord?.rung;
		if (!isCounter(rungNumber) || rungNumber === 0) {
			reasons.push(
				`server ladder entry ${rungIndex} must have a positive integer rung`,
			);
			continue;
		}
		const t0 = record(record(rungRecord?.T0)?.perShardUdp);
		const t1 = record(record(rungRecord?.T1)?.perShardUdp);
		const t2 = record(record(rungRecord?.T2)?.perShardUdp);
		if (!t0 || !t1 || !t2) {
			reasons.push(
				`server ladder rung ${rungIndex} must contain T0/T1/T2 perShardUdp samples`,
			);
			continue;
		}
		const shardIds = Object.keys(t0);
		if (
			shardIds.length === 0 ||
			Object.keys(t1).length !== shardIds.length ||
			Object.keys(t2).length !== shardIds.length ||
			shardIds.some((id) => !(id in t1) || !(id in t2) || !/^\d+$/.test(id))
		) {
			reasons.push(
				`server ladder rung ${rungIndex} has inconsistent per-shard UDP samples`,
			);
			continue;
		}
		for (const id of shardIds) {
			const serverId = Number(id);
			const t0Drops = record(t0[id])?.drops;
			const t1Drops = record(t1[id])?.drops;
			const t2Drops = record(t2[id])?.drops;
			if (!isCounter(t0Drops) || !isCounter(t1Drops) || !isCounter(t2Drops)) {
				reasons.push(
					`server ladder rung ${rungIndex} shard ${serverId} has invalid UDP drops`,
				);
				continue;
			}
			if (t1Drops < t0Drops || t2Drops < t1Drops) {
				reasons.push(
					`server ladder rung ${rungIndex} shard ${serverId} has decreasing UDP drops`,
				);
				continue;
			}
			evidence.push({
				rung: rungNumber,
				serverId,
				t0: t0Drops,
				t1: t1Drops,
				t2: t2Drops,
			});
			const current = deltas[serverId] ?? { t0ToT1: 0, t1ToT2: 0, t0ToT2: 0 };
			current.t0ToT1 += t1Drops - t0Drops;
			current.t1ToT2 += t2Drops - t1Drops;
			current.t0ToT2 += t2Drops - t0Drops;
			deltas[serverId] = current;
		}
	}
	return { evidence, deltas };
}

export function analyzeOverflowDiscrimination(
	serverArtifact: unknown,
	generatorReport: unknown,
): OverflowDiscriminationVerdict {
	const reasons: string[] = [];
	const server = record(serverArtifact);
	const generator = record(generatorReport);
	if (server?.schema !== "g6-sharded-diagnostic/2") {
		reasons.push("server schema must be g6-sharded-diagnostic/2");
	}
	if (generator?.schema !== "mmo-client/2") {
		reasons.push("generator schema must be mmo-client/2");
	}

	const serverSamples = phaseSamples(
		server?.serverHostUdp,
		"serverHostUdp",
		reasons,
	);
	const generatorSamples = phaseSamples(
		generator?.hostUdp,
		"generator hostUdp",
		reasons,
	);
	const serverHostUdp = hostDeltas(serverSamples, "serverHostUdp", reasons);
	const generatorHostUdp = hostDeltas(
		generatorSamples,
		"generator hostUdp",
		reasons,
	);
	const launchedShardCount = validateShardPhaseOrder(
		server?.perShardLifecycle,
		reasons,
	);
	validateBpfPreArm(server?.bpfPreArm, launchedShardCount, reasons);
	const socketDrops = readSocketDrops(server?.ladder, reasons);

	const verdict: OverflowDiscriminationVerdict = {
		schema: "g6-sharded-overflow-discrimination/1",
		classification: "INCONCLUSIVE",
		reasons,
		evidence: {
			serverHostUdp: server?.serverHostUdp ?? null,
			generatorHostUdp: generator?.hostUdp ?? null,
			bpfPreArm: server?.bpfPreArm ?? null,
			perShardSocketDrops: socketDrops.evidence,
		},
		deltas: {
			serverHostUdp,
			generatorHostUdp,
			perShardSocketDrops: socketDrops.deltas,
		},
	};
	if (reasons.length > 0 || !serverHostUdp || !generatorHostUdp) return verdict;

	const serverOverflow = serverHostUdp.total.RcvbufErrors > 0;
	const generatorOverflow = generatorHostUdp.total.RcvbufErrors > 0;
	const socketDropsGrow = Object.values(socketDrops.deltas).some(
		(delta) => delta.t0ToT2 > 0,
	);
	if (serverOverflow && generatorOverflow) {
		verdict.classification = "BIDIRECTIONAL_UDP_RECEIVE_OVERFLOW";
	} else if (serverOverflow) {
		verdict.classification = "SERVER_UDP_RECEIVE_OVERFLOW";
	} else if (generatorOverflow) {
		verdict.classification = "GENERATOR_UDP_RECEIVE_OVERFLOW";
	} else if (socketDropsGrow) {
		verdict.classification = "SERVER_SOCKET_OR_STEERING_PRESSURE";
	} else {
		verdict.reasons.push(
			"no host receive overflow or per-shard socket-drop growth was observed",
		);
	}
	return verdict;
}

function main(argv: string[]): void {
	if (argv.length < 2 || argv.length > 3) {
		throw new Error(
			"usage: bun tools/load/g6-sharded-overflow-discrimination.ts <server-diagnostic.json> <generator-report.json> [output.json]",
		);
	}
	const [serverPath, generatorPath, outputPath] = argv;
	const verdict = analyzeOverflowDiscrimination(
		JSON.parse(readFileSync(serverPath!, "utf8")) as unknown,
		JSON.parse(readFileSync(generatorPath!, "utf8")) as unknown,
	);
	const output = `${JSON.stringify(verdict, null, 2)}\n`;
	if (outputPath) writeFileSync(outputPath, output);
	else process.stdout.write(output);
}

if (import.meta.main) main(process.argv.slice(2));
