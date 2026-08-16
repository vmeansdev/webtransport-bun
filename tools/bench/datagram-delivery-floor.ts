#!/usr/bin/env bun

/**
 * H7 JavaScript-floor microbenchmark — the stop/go gate before the load runs.
 *
 * Batching moves the per-datagram N-API crossing off the hot path, but it
 * cannot make the JavaScript side of delivery any faster than the JavaScript
 * side can go. This measures that ceiling directly: the shipped generator,
 * driven over pre-filled batches with no addon, no socket and no kernel in the
 * way, so the only thing left in the loop is the await, the array walk and the
 * yield. If that number is below what H7 needs, no amount of native work will
 * reach the target and the expensive load ladders should not be run.
 *
 * The generator under test is imported, never re-implemented — this module
 * holds no copy of the yield loop. `PRODUCTION_ITERATOR` is asserted in the
 * unit tests to be the very binding both native session classes call, which is
 * the only thing that makes the number mean anything.
 *
 * Numbers are a rate ceiling, not a prediction: a pre-resolved promise is the
 * cheapest await that exists, and production's promise is settled from a
 * worker thread. A pass says the floor is not the constraint; it does not say
 * the shipped path will hit the same rate.
 *
 * Usage:
 *   env -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS bun run bench:h7-floor
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";

import { __TESTING__ } from "../../packages/webtransport/src/index.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const ARTIFACT_PATH = join(
	ROOT,
	".release-evidence",
	"h7",
	"datagram-delivery-floor.json",
);
const COMMAND = "bun run bench:h7-floor";

/** The exact generator both native session classes run. Not a copy. */
export const PRODUCTION_ITERATOR =
	__TESTING__.createIncomingDatagramIteratorForTests;

export const DIAGNOSTICS_ENV = "WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS";
export const SAMPLE_COUNT = 7;
export const SAMPLE_DURATION_MS = 2_000;
export const WARMUP_MS = 1_000;
export const ARM_BATCH_SIZES = [1, 16, 64, 256] as const;
/** The batch size H7 intends to ship, and the only one that is gated. */
export const GATE_BATCH_SIZE = 64;
/** The comparison arm: same loop, same awaits, one item per crossing. */
export const BASELINE_BATCH_SIZE = 1;
export const CALLBACK_ARM_NAME = "direct-callback-batch-64";
/**
 * 2x headroom over the >=25,000 items/s receive target that the observed
 * ~12,500/s ceiling implies. Measured as the WORST sample, not the median: a
 * floor that only holds on a good sample is not a floor.
 */
export const MIN_GENERATOR_RATE = 50_000;
/** Median rate at batch 64 relative to batch 1. */
export const MIN_MEDIAN_SPEEDUP = 2.0;

const DATAGRAM_BYTES = 1_200;
/**
 * Distinct pre-filled batches cycled per read. One reused array would let the
 * JIT specialise on a single object identity; a fresh array per read would
 * measure the allocator. A small ring measures neither.
 */
const BATCH_POOL_SIZE = 8;
/**
 * Consumers check the clock once per this many items so the deadline test is
 * not itself a measurable share of the per-item cost. Every arm pays it at the
 * same point in its loop.
 */
const CLOCK_CHECK_INTERVAL = 1_024;

/** Read in the hot loops so nothing under measurement can be eliminated. */
let sink = 0;

export type ArmSummary = {
	name: string;
	batchSize: number;
	samples: number[];
	median: number;
	min: number;
};

export type GateCondition = {
	id: string;
	description: string;
	measured: number | null;
	threshold: number;
	pass: boolean;
};

export type RoundRecord = { round: number; order: string[] };

export type Identity = {
	head: string;
	candidate: string;
	candidateBinding: "external" | "self-reference";
	dirty: boolean;
	bunVersion: string;
	platform: string;
	machine: string;
	command: string;
};

export type DiagnosticsState = { requested: boolean; resolved: boolean };

export function generatorArmName(batchSize: number): string {
	return `generator-batch-${batchSize}`;
}

export function parseDiagnosticsRequest(raw: string | undefined): boolean {
	return raw === "1";
}

export function diagnosticsFailures(state: DiagnosticsState): string[] {
	const failures: string[] = [];
	if (state.requested) {
		failures.push(
			`${DIAGNOSTICS_ENV}=1 selects the instrumented twin, which is not the ` +
				"loop this benchmark exists to measure",
		);
	}
	if (state.resolved) {
		failures.push(
			"the library resolved the instrumented generator, so the measured " +
				"loop is not the production one",
		);
	}
	return failures;
}

export function identityFailures(state: {
	head: string;
	candidate: string;
	dirty: boolean;
}): string[] {
	const failures: string[] = [];
	if (!state.head) failures.push("HEAD could not be read");
	else if (state.head !== state.candidate) {
		failures.push(
			`HEAD ${state.head} does not match candidate ${state.candidate}`,
		);
	}
	if (state.dirty) failures.push("working tree is dirty");
	return failures;
}

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	if (sorted.length % 2 === 1) return sorted[mid] as number;
	return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function minimum(values: number[]): number {
	return values.reduce(
		(low, value) => (value < low ? value : low),
		values[0] ?? Number.NaN,
	);
}

export function summarizeArm(
	name: string,
	batchSize: number,
	samples: number[],
): ArmSummary {
	return {
		name,
		batchSize,
		samples: [...samples],
		median: median(samples),
		min: minimum(samples),
	};
}

export function armFailures(arm: ArmSummary): string[] {
	const failures: string[] = [];
	if (arm.samples.length !== SAMPLE_COUNT) {
		failures.push(
			`${arm.name}: expected ${SAMPLE_COUNT} samples, got ${arm.samples.length}`,
		);
	}
	const bad = arm.samples.filter(
		(value) => !Number.isFinite(value) || value <= 0,
	);
	if (bad.length > 0) {
		failures.push(
			`${arm.name}: ${bad.length} non-finite or non-positive sample(s)`,
		);
	}
	return failures;
}

export function evaluateGate(arms: ArmSummary[]): {
	conditions: GateCondition[];
	failures: string[];
} {
	const gateArm = arms.find(
		(a) => a.name === generatorArmName(GATE_BATCH_SIZE),
	);
	const baselineArm = arms.find(
		(a) => a.name === generatorArmName(BASELINE_BATCH_SIZE),
	);
	const ratio =
		gateArm && baselineArm && baselineArm.median > 0
			? gateArm.median / baselineArm.median
			: null;
	const conditions: GateCondition[] = [
		{
			id: "minimum-generator-rate",
			description: `worst of ${SAMPLE_COUNT} samples at batch ${GATE_BATCH_SIZE} >= ${MIN_GENERATOR_RATE} items/s`,
			measured: gateArm ? gateArm.min : null,
			threshold: MIN_GENERATOR_RATE,
			pass: gateArm !== undefined && gateArm.min >= MIN_GENERATOR_RATE,
		},
		{
			id: "median-speedup-over-batch-1",
			description: `median rate at batch ${GATE_BATCH_SIZE} >= ${MIN_MEDIAN_SPEEDUP}x the batch ${BASELINE_BATCH_SIZE} generator`,
			measured: ratio,
			threshold: MIN_MEDIAN_SPEEDUP,
			pass: ratio !== null && ratio >= MIN_MEDIAN_SPEEDUP,
		},
	];
	const failures = conditions
		.filter((condition) => !condition.pass)
		.map(
			(condition) =>
				`gate ${condition.id}: measured ${condition.measured ?? "nothing"}, requires ${condition.threshold}`,
		);
	return { conditions, failures };
}

export function buildArtifact(input: {
	identity: Identity;
	diagnostics: DiagnosticsState;
	arms: ArmSummary[];
	rounds: RoundRecord[];
	shuffleSeed: number;
}) {
	const gate = evaluateGate(input.arms);
	const failures = [
		...diagnosticsFailures(input.diagnostics),
		...identityFailures(input.identity),
		...input.arms.flatMap(armFailures),
		...gate.failures,
	];
	return {
		version: 1,
		mode: "datagram-delivery-floor",
		status: failures.length === 0 ? ("pass" as const) : ("fail" as const),
		generatedAtMs: Date.now(),
		head: input.identity.head,
		candidate: input.identity.candidate,
		candidateBinding: input.identity.candidateBinding,
		dirty: input.identity.dirty,
		bunVersion: input.identity.bunVersion,
		platform: input.identity.platform,
		machine: input.identity.machine,
		command: input.identity.command,
		diagnostics: input.diagnostics,
		design: {
			warmupMs: WARMUP_MS,
			sampleCount: SAMPLE_COUNT,
			sampleDurationMs: SAMPLE_DURATION_MS,
			datagramBytes: DATAGRAM_BYTES,
			batchPoolSize: BATCH_POOL_SIZE,
			clockCheckInterval: CLOCK_CHECK_INTERVAL,
			shuffleSeed: input.shuffleSeed,
		},
		gatedArm: generatorArmName(GATE_BATCH_SIZE),
		diagnosticArms: [
			generatorArmName(16),
			generatorArmName(256),
			CALLBACK_ARM_NAME,
		],
		gate: gate.conditions,
		arms: input.arms,
		rounds: input.rounds,
		failures,
	};
}

/** mulberry32 — small, seeded, and enough to order five arms. */
export function makeRng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function shuffled<T>(items: readonly T[], rng: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(rng() * (i + 1));
		[out[i], out[j]] = [out[j] as T, out[i] as T];
	}
	return out;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

type PrefilledSource = {
	readDatagram: () => Promise<Uint8Array | null>;
	readDatagramBatch: (max: number) => Promise<Uint8Array[] | null>;
};

function makePrefilledSource(batchSize: number): PrefilledSource {
	const pool: Uint8Array[][] = [];
	for (let p = 0; p < BATCH_POOL_SIZE; p += 1) {
		const batch: Uint8Array[] = [];
		for (let i = 0; i < batchSize; i += 1) {
			batch.push(new Uint8Array(DATAGRAM_BYTES));
		}
		pool.push(batch);
	}
	let cursor = 0;
	return {
		readDatagram: () => Promise.resolve(pool[0]?.[0] ?? null),
		readDatagramBatch: () => {
			const batch = pool[cursor % BATCH_POOL_SIZE] as Uint8Array[];
			cursor += 1;
			return Promise.resolve(batch);
		},
	};
}

const passthroughError = (err: unknown) => err;
const neverClosed = () => false;

async function measureGenerator(
	batchSize: number,
	durationMs: number,
): Promise<number> {
	const source = makePrefilledSource(batchSize);
	const iterator = PRODUCTION_ITERATOR(
		source,
		neverClosed,
		batchSize,
		passthroughError,
	);
	let items = 0;
	const start = performance.now();
	const deadline = start + durationMs;
	for await (const datagram of iterator) {
		sink += datagram.byteLength;
		items += 1;
		if (items % CLOCK_CHECK_INTERVAL === 0 && performance.now() >= deadline) {
			break;
		}
	}
	const elapsedMs = performance.now() - start;
	await iterator.return(undefined);
	return (items / elapsedMs) * 1000;
}

/**
 * The same work with the generator taken out: read a batch, hand each item
 * straight to a callback. Diagnostic only — it prices what the generator
 * protocol costs, and is not a way to pass the gate.
 */
async function measureCallback(durationMs: number): Promise<number> {
	const source = makePrefilledSource(GATE_BATCH_SIZE);
	const deliver = (datagram: Uint8Array) => {
		sink += datagram.byteLength;
	};
	let items = 0;
	let done = false;
	const start = performance.now();
	const deadline = start + durationMs;
	while (!done) {
		const batch = await source.readDatagramBatch(GATE_BATCH_SIZE);
		if (!batch || batch.length === 0) break;
		for (const datagram of batch) {
			deliver(datagram);
			items += 1;
			if (items % CLOCK_CHECK_INTERVAL === 0 && performance.now() >= deadline) {
				done = true;
				break;
			}
		}
	}
	const elapsedMs = performance.now() - start;
	return (items / elapsedMs) * 1000;
}

type ArmRunner = {
	name: string;
	batchSize: number;
	run: (ms: number) => Promise<number>;
};

function buildArms(): ArmRunner[] {
	const arms: ArmRunner[] = ARM_BATCH_SIZES.map((batchSize) => ({
		name: generatorArmName(batchSize),
		batchSize,
		run: (ms: number) => measureGenerator(batchSize, ms),
	}));
	arms.push({
		name: CALLBACK_ARM_NAME,
		batchSize: GATE_BATCH_SIZE,
		run: measureCallback,
	});
	return arms;
}

function gitOutput(args: string[]): string {
	const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

async function main(): Promise<void> {
	const requested = parseDiagnosticsRequest(process.env[DIAGNOSTICS_ENV]);
	const resolvedDiagnostics =
		__TESTING__.datagramBatchConfigForTests().diagnosticsEnabled;
	const diagnostics: DiagnosticsState = {
		requested,
		resolved: resolvedDiagnostics,
	};
	// Refuse before spending 75 seconds measuring the wrong loop.
	const earlyRefusals = diagnosticsFailures(diagnostics);
	if (earlyRefusals.length > 0) {
		console.error(
			`datagram-delivery-floor: REFUSED\n  ${earlyRefusals.join("\n  ")}`,
		);
		process.exit(1);
	}

	const head = gitOutput(["rev-parse", "HEAD"]);
	const dirty = gitOutput(["status", "--porcelain"]).length > 0;
	// Same disclosure the churn falsifier makes: without an external candidate
	// the HEAD check compares HEAD to itself and binds nothing.
	const externalCandidate = process.env.SOAK_CANDIDATE_COMMIT;
	const identity: Identity = {
		head,
		candidate: externalCandidate ?? head,
		candidateBinding: externalCandidate ? "external" : "self-reference",
		dirty,
		bunVersion: Bun.version,
		platform: `${process.platform}/${process.arch}`,
		machine: process.env.BENCH_MACHINE_IDENTITY?.trim() || hostname(),
		command: COMMAND,
	};

	const shuffleSeed = Number(process.env.H7_FLOOR_SEED ?? "20260815");
	const rng = makeRng(shuffleSeed);
	const runners = buildArms();

	for (const arm of shuffled(runners, rng)) {
		await arm.run(WARMUP_MS);
	}

	const samples = new Map<string, number[]>(
		runners.map((arm) => [arm.name, []]),
	);
	const rounds: RoundRecord[] = [];
	// One sample per arm per round, reshuffled each round, so a machine that
	// heats up or throttles part-way through spreads that across every arm
	// instead of penalising whichever one happened to run last.
	for (let round = 1; round <= SAMPLE_COUNT; round += 1) {
		const order = shuffled(runners, rng);
		rounds.push({ round, order: order.map((arm) => arm.name) });
		for (const arm of order) {
			samples.get(arm.name)?.push(await arm.run(SAMPLE_DURATION_MS));
		}
		console.log(`datagram-delivery-floor: round ${round}/${SAMPLE_COUNT} done`);
	}

	const arms = runners.map((arm) =>
		summarizeArm(arm.name, arm.batchSize, samples.get(arm.name) ?? []),
	);
	const artifact = buildArtifact({
		identity,
		diagnostics,
		arms,
		rounds,
		shuffleSeed,
	});
	mkdirSync(dirname(ARTIFACT_PATH), { recursive: true });
	writeFileSync(ARTIFACT_PATH, JSON.stringify(artifact, null, 2));

	if (identity.candidateBinding === "self-reference") {
		console.warn(
			"datagram-delivery-floor: SOAK_CANDIDATE_COMMIT is unset, so the " +
				"HEAD-equals-candidate check compared HEAD to itself.",
		);
	}
	for (const arm of arms) {
		console.log(
			`  ${arm.name}: median ${Math.round(arm.median)} items/s, ` +
				`min ${Math.round(arm.min)} items/s`,
		);
	}
	for (const condition of artifact.gate) {
		console.log(
			`  [${condition.pass ? "PASS" : "FAIL"}] ${condition.description} ` +
				`— measured ${condition.measured ?? "nothing"}`,
		);
	}
	console.log(
		artifact.status === "pass"
			? "datagram-delivery-floor: PASS"
			: "datagram-delivery-floor: FAIL",
		JSON.stringify(
			{ artifact: ARTIFACT_PATH, failures: artifact.failures, sink },
			null,
			2,
		),
	);
	process.exit(artifact.status === "pass" ? 0 : 1);
}

if (import.meta.main) {
	main().catch((err) => {
		console.error("datagram-delivery-floor: crashed", err);
		process.exit(1);
	});
}
