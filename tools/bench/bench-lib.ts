#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "../..");
export const DEFAULT_BASELINE_PATH = resolve(
	import.meta.dir,
	"./approved-baselines.json",
);
export const DEFAULT_ARTIFACT_PATH = resolve(
	ROOT,
	".release-evidence/bench/bench-regress-artifact.json",
);
const COMMAND_TIMEOUT_MS = Number(
	process.env.BENCH_COMMAND_TIMEOUT_MS ?? "30000",
);
const COMMAND_TERMINATE_GRACE_MS = Number(
	process.env.BENCH_COMMAND_TERMINATE_GRACE_MS ?? "2000",
);
const COMMAND_DRAIN_TIMEOUT_MS = Number(
	process.env.BENCH_COMMAND_DRAIN_TIMEOUT_MS ?? "2000",
);

export type MetricSummary = {
	samples: number[];
	mean: number;
	min: number;
	max: number;
	stddev: number;
	ci95Low: number;
	ci95High: number;
};

export type BenchmarkRun = {
	name: string;
	unit: string;
	samples: number[];
	summary: MetricSummary;
	rawOutputs: string[];
};

export type BenchmarkMetricThreshold = {
	direction: "lower-is-better" | "higher-is-better";
	approved: MetricSummary;
	unit: string;
};

export type ApprovedBaselines = {
	status: "approved" | "blocked";
	approvedAt: string | null;
	commit: string | null;
	candidateRelationship: "exact" | null;
	machine: string | null;
	bunVersion: string | null;
	rustcVersion: string | null;
	notes: string[];
	thresholds: Record<string, BenchmarkMetricThreshold>;
	lastAttempt?: {
		at: string;
		command: string;
		exitCode: number;
		reason: string;
	};
};

export type RegressionArtifact = {
	createdAt: string;
	commit: string | null;
	machine: string;
	bunVersion: string;
	rustcVersion: string | null;
	warmups: number;
	rounds: number;
	baselineStatus: ApprovedBaselines["status"];
	runs: BenchmarkRun[];
	failures: string[];
};

type HandshakeBenchmarkOutput = {
	p50_ms: number;
	p95_ms: number;
	p99_ms: number;
	close_latency_p99_ms: number;
};

type StreamBenchmarkOutput = {
	throughput_mbps: number;
};

type DatagramBenchmarkOutput = {
	throughput_dgrams_per_sec: number;
	loss_ratio: number;
	event_loop_delay_p99_ms: number;
	cpu_user_ms: number;
	peak_rss_mib: number;
};

type ScenarioDefinition<TMetrics extends Record<string, number>> = {
	command: string[];
	parse: (output: string) => TMetrics;
	metrics: Array<{
		name: string;
		unit: string;
		pick: (metrics: TMetrics) => number;
	}>;
};

export type BenchmarkContext = {
	commit: string | null;
	machine: string;
	bunVersion: string;
	rustcVersion: string | null;
};

export type BenchmarkBindingState = BenchmarkContext & {
	dirtyWorkingTree: boolean;
	explicitMachineBinding: boolean;
	ciBoundRun: boolean;
};

type MetricRule = {
	unit: string;
	direction: BenchmarkMetricThreshold["direction"];
	minimum: number;
	maximum?: number;
	minimumInclusive: boolean;
};

const METRIC_RULES = {
	"handshake-p50-ms": {
		unit: "ms",
		direction: "lower-is-better",
		minimum: 0,
		minimumInclusive: true,
	},
	"handshake-p95-ms": {
		unit: "ms",
		direction: "lower-is-better",
		minimum: 0,
		minimumInclusive: true,
	},
	"handshake-p99-ms": {
		unit: "ms",
		direction: "lower-is-better",
		minimum: 0,
		minimumInclusive: true,
	},
	"close-latency-p99-ms": {
		unit: "ms",
		direction: "lower-is-better",
		minimum: 0,
		minimumInclusive: true,
	},
	"stream-throughput-mbps": {
		unit: "MiB/s",
		direction: "higher-is-better",
		minimum: 0,
		minimumInclusive: false,
	},
	"datagram-throughput-dgrams-per-sec": {
		unit: "dgram/s",
		direction: "higher-is-better",
		minimum: 0,
		minimumInclusive: false,
	},
	"datagram-loss-ratio": {
		unit: "ratio",
		direction: "lower-is-better",
		minimum: 0,
		maximum: 1,
		minimumInclusive: true,
	},
	"event-loop-delay-p99-ms": {
		unit: "ms",
		direction: "lower-is-better",
		minimum: 0,
		minimumInclusive: true,
	},
	"cpu-user-ms": {
		unit: "ms",
		direction: "lower-is-better",
		minimum: 0,
		minimumInclusive: false,
	},
	"peak-rss-mib": {
		unit: "MiB",
		direction: "lower-is-better",
		minimum: 0,
		minimumInclusive: false,
	},
} as const satisfies Record<string, MetricRule>;

type StreamCaptureController = {
	promise: Promise<{ text: string; ended: boolean }>;
	abort: () => void;
};

type CommandRunOptions = {
	outerTimeoutMs?: number;
	terminateGraceMs?: number;
	drainTimeoutMs?: number;
};

export const REQUIRED_BENCHMARK_METRICS = Object.keys(METRIC_RULES);

const STUDENT_T_95_TWO_SIDED = [
	NaN,
	12.706,
	4.303,
	3.182,
	2.776,
	2.571,
	2.447,
	2.365,
	2.306,
	2.262,
	2.228,
	2.201,
	2.179,
	2.16,
	2.145,
	2.131,
	2.12,
	2.11,
	2.101,
	2.093,
	2.086,
	2.08,
	2.074,
	2.069,
	2.064,
	2.06,
	2.056,
	2.052,
	2.048,
	2.045,
	2.042,
] as const;

function parseJsonLine<T>(output: string): T {
	const line = output
		.trim()
		.split(/\r?\n/)
		.reverse()
		.find((candidate) => candidate.trim().startsWith("{"));
	if (!line) {
		throw new Error(`expected JSON output, got:\n${output}`);
	}
	return JSON.parse(line) as T;
}

function parseHandshakeOutput(output: string): HandshakeBenchmarkOutput {
	try {
		return parseJsonLine<HandshakeBenchmarkOutput>(output);
	} catch {
		const match = output.match(
			/p50=(?<p50>[0-9.]+)ms p95=(?<p95>[0-9.]+)ms p99=(?<p99>[0-9.]+)ms/,
		);
		if (!match?.groups) {
			throw new Error(`unable to parse handshake benchmark output:\n${output}`);
		}
		return {
			p50_ms: Number(match.groups.p50),
			p95_ms: Number(match.groups.p95),
			p99_ms: Number(match.groups.p99),
			close_latency_p99_ms: Number.NaN,
		};
	}
}

function parseDatagramOutput(output: string): DatagramBenchmarkOutput {
	try {
		return parseJsonLine<DatagramBenchmarkOutput>(output);
	} catch {
		const match = output.match(
			/throughput=\s*(?<throughput>[0-9.]+)\s*dgram\/s/,
		);
		if (!match?.groups) {
			throw new Error(`unable to parse datagram benchmark output:\n${output}`);
		}
		return {
			throughput_dgrams_per_sec: Number(match.groups.throughput),
			loss_ratio: Number.NaN,
			event_loop_delay_p99_ms: Number.NaN,
			cpu_user_ms: Number.NaN,
			peak_rss_mib: Number.NaN,
		};
	}
}

function logGamma(value: number): number {
	const coefficients = [
		676.5203681218851, -1259.1392167224028, 771.3234287776531,
		-176.6150291621406, 12.507343278686905, -0.13857109526572012,
		9.984369578019572e-6, 1.5056327351493116e-7,
	];
	if (value < 0.5) {
		return (
			Math.log(Math.PI) -
			Math.log(Math.sin(Math.PI * value)) -
			logGamma(1 - value)
		);
	}
	let x = 0.9999999999998099;
	const shifted = value - 1;
	for (const [index, coefficient] of coefficients.entries()) {
		x += coefficient / (shifted + index + 1);
	}
	const t = shifted + coefficients.length - 0.5;
	return 0.9189385332046727 + (shifted + 0.5) * Math.log(t) - t + Math.log(x);
}

function regularizedIncompleteBeta(a: number, b: number, x: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const continuedFraction = (aa: number, bb: number, xx: number) => {
		const qab = aa + bb;
		const qap = aa + 1;
		const qam = aa - 1;
		let c = 1;
		let d = 1 - (qab * xx) / qap;
		if (Math.abs(d) < 1e-30) d = 1e-30;
		d = 1 / d;
		let h = d;
		for (let m = 1; m <= 200; m++) {
			const m2 = 2 * m;
			let numerator = (m * (bb - m) * xx) / ((qam + m2) * (aa + m2));
			d = 1 + numerator * d;
			if (Math.abs(d) < 1e-30) d = 1e-30;
			c = 1 + numerator / c;
			if (Math.abs(c) < 1e-30) c = 1e-30;
			d = 1 / d;
			h *= d * c;

			numerator = -((aa + m) * (qab + m) * xx) / ((aa + m2) * (qap + m2));
			d = 1 + numerator * d;
			if (Math.abs(d) < 1e-30) d = 1e-30;
			c = 1 + numerator / c;
			if (Math.abs(c) < 1e-30) c = 1e-30;
			d = 1 / d;
			const delta = d * c;
			h *= delta;
			if (Math.abs(delta - 1) < 1e-12) break;
		}
		return h;
	};

	const logFront =
		a * Math.log(x) +
		b * Math.log(1 - x) -
		Math.log(a) -
		(logGamma(a) + logGamma(b) - logGamma(a + b));
	const front = Math.exp(logFront);
	if (x < (a + 1) / (a + b + 2)) {
		return front * continuedFraction(a, b, x);
	}
	return 1 - front * continuedFraction(b, a, 1 - x);
}

function studentsTCdf(value: number, degreesOfFreedom: number): number {
	if (!Number.isFinite(value)) {
		return value < 0 ? 0 : 1;
	}
	if (value === 0) return 0.5;
	const x = degreesOfFreedom / (degreesOfFreedom + value * value);
	const tail = 0.5 * regularizedIncompleteBeta(degreesOfFreedom / 2, 0.5, x);
	return value > 0 ? 1 - tail : tail;
}

export function studentTCritical95(sampleCount: number): number {
	if (sampleCount <= 1) return 0;
	const degreesOfFreedom = sampleCount - 1;
	if (degreesOfFreedom < STUDENT_T_95_TWO_SIDED.length) {
		return STUDENT_T_95_TWO_SIDED[degreesOfFreedom] ?? 0;
	}
	const target = 0.975;
	let low = 0;
	let high = 2;
	while (studentsTCdf(high, degreesOfFreedom) < target) {
		high *= 2;
	}
	for (let index = 0; index < 80; index++) {
		const mid = (low + high) / 2;
		if (studentsTCdf(mid, degreesOfFreedom) >= target) {
			high = mid;
		} else {
			low = mid;
		}
	}
	return Number(high.toFixed(6));
}

export function sampleSummary(samples: number[]): MetricSummary {
	if (samples.length === 0) {
		throw new Error("cannot summarize empty sample set");
	}
	if (samples.some((sample) => !Number.isFinite(sample))) {
		throw new Error("cannot summarize samples unless every value is finite");
	}
	const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
	const variance =
		samples.length > 1
			? samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
				(samples.length - 1)
			: 0;
	const stddev = Math.sqrt(variance);
	const margin =
		samples.length > 1
			? studentTCritical95(samples.length) *
				(stddev / Math.sqrt(samples.length))
			: 0;
	return {
		samples: [...samples],
		mean: Number(mean.toFixed(3)),
		min: Number(Math.min(...samples).toFixed(3)),
		max: Number(Math.max(...samples).toFixed(3)),
		stddev: Number(stddev.toFixed(3)),
		ci95Low: Number((mean - margin).toFixed(3)),
		ci95High: Number((mean + margin).toFixed(3)),
	};
}

export function gitCommit(): string | null {
	const result = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: ROOT,
		encoding: "utf8",
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

function gitStatusPorcelain(): string {
	const result = spawnSync("git", ["status", "--short"], {
		cwd: ROOT,
		encoding: "utf8",
	});
	return result.status === 0 ? result.stdout.trim() : "";
}

export function gitWorkingTreeDirty(): boolean {
	return gitStatusPorcelain().length > 0;
}

export function rustcVersion(): string | null {
	const result = spawnSync("rustc", ["-V"], { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : null;
}

export function machineIdentity(): string {
	const configuredIdentity = process.env.BENCH_MACHINE_IDENTITY?.trim();
	if (configuredIdentity) return configuredIdentity;
	const parts = [
		process.platform,
		process.arch,
		process.env.GITHUB_RUN_ID ? "github-actions" : "local",
		hostname(),
	];
	return parts.join("/");
}

export function benchmarkBindingFailures(
	state: BenchmarkBindingState,
): string[] {
	const failures: string[] = [];
	if (state.dirtyWorkingTree) {
		failures.push(
			"benchmark evidence is unbound because the git worktree is dirty",
		);
	}
	if (!state.ciBoundRun && !state.explicitMachineBinding) {
		failures.push(
			"benchmark evidence is unbound because BENCH_MACHINE_IDENTITY is required outside CI",
		);
	}
	return failures;
}

function captureReadable(
	stream: NodeJS.ReadableStream & {
		on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
		on(event: "end", listener: () => void): unknown;
		on(event: "error", listener: (error: Error) => void): unknown;
		removeListener(
			event: string,
			listener: (...args: unknown[]) => void,
		): unknown;
		destroy?: (error?: Error) => void;
	},
): StreamCaptureController {
	let text = "";
	let settled = false;
	let resolvePromise!: (value: { text: string; ended: boolean }) => void;
	const promise = new Promise<{ text: string; ended: boolean }>((resolve) => {
		resolvePromise = resolve;
	});
	const settle = (ended: boolean) => {
		if (settled) return;
		settled = true;
		stream.removeListener("data", onData);
		stream.removeListener("end", onEnd);
		stream.removeListener("error", onError);
		resolvePromise({ text, ended });
	};
	const onData = (chunk: string | Buffer) => {
		text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
	};
	const onEnd = () => settle(true);
	const onError = () => settle(true);
	stream.on("data", onData);
	stream.on("end", onEnd);
	stream.on("error", onError);
	return {
		promise,
		abort: () => {
			try {
				stream.destroy?.();
			} catch {}
			settle(false);
		},
	};
}

function signalProcessGroup(
	pid: number,
	signal: "SIGTERM" | "SIGKILL",
): boolean {
	if (pid <= 0) return false;
	if (process.platform === "win32") {
		const args =
			signal === "SIGTERM"
				? ["/pid", String(pid), "/t"]
				: ["/pid", String(pid), "/t", "/f"];
		return (
			spawnSync("taskkill", args, {
				cwd: ROOT,
				stdio: "ignore",
			}).status === 0
		);
	}
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		return false;
	}
}

async function terminateProcessTree(
	pid: number,
	exitPromise: Promise<unknown>,
	terminateGraceMs: number,
): Promise<boolean> {
	if (pid <= 0) return false;
	signalProcessGroup(pid, "SIGTERM");
	const exitedAfterTerm =
		(await Promise.race([
			exitPromise.then(() => true),
			Bun.sleep(terminateGraceMs).then(() => false),
		])) === true;
	if (exitedAfterTerm) return false;
	signalProcessGroup(pid, "SIGKILL");
	await Promise.race([exitPromise, Bun.sleep(terminateGraceMs)]);
	return true;
}

async function reapPipeHolders(
	pid: number,
	terminateGraceMs: number,
): Promise<boolean> {
	if (pid <= 0) return false;
	signalProcessGroup(pid, "SIGTERM");
	await Bun.sleep(terminateGraceMs);
	signalProcessGroup(pid, "SIGKILL");
	return true;
}

async function awaitCaptureWithinTimeout(
	controller: StreamCaptureController,
	drainTimeoutMs: number,
): Promise<{ text: string; ended: boolean; timedOut: boolean }> {
	const outcome = await Promise.race([
		controller.promise.then((result) => ({
			...result,
			timedOut: false,
		})),
		Bun.sleep(drainTimeoutMs).then(() => null),
	]);
	if (outcome) return outcome;
	controller.abort();
	const aborted = await controller.promise;
	return {
		...aborted,
		timedOut: true,
	};
}

export async function runCommand(
	args: string[],
	env: Record<string, string> = {},
	options: CommandRunOptions = {},
): Promise<string> {
	const proc = spawn(args[0] ?? "", args.slice(1), {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		env: { ...process.env, ...env },
	});
	const stdoutCapture = captureReadable(proc.stdout);
	const stderrCapture = captureReadable(proc.stderr);
	const exitPromise = new Promise<{
		code: number | null;
		signal: string | null;
	}>((resolve, reject) => {
		proc.once("error", reject);
		proc.once("exit", (code, signal) => {
			resolve({ code, signal });
		});
	});
	const outerTimeoutMs = options.outerTimeoutMs ?? COMMAND_TIMEOUT_MS;
	const terminateGraceMs =
		options.terminateGraceMs ?? COMMAND_TERMINATE_GRACE_MS;
	const drainTimeoutMs = options.drainTimeoutMs ?? COMMAND_DRAIN_TIMEOUT_MS;
	let timedOut = false;
	let forceKilled = false;
	let exit = await Promise.race([
		exitPromise.then((value) => ({ kind: "exit" as const, value })),
		Bun.sleep(outerTimeoutMs).then(() => ({ kind: "timeout" as const })),
	]);
	if (exit.kind === "timeout") {
		timedOut = true;
		forceKilled = await terminateProcessTree(
			proc.pid ?? 0,
			exitPromise,
			terminateGraceMs,
		);
		exit = { kind: "exit", value: await exitPromise };
	}

	let stdout = await awaitCaptureWithinTimeout(stdoutCapture, drainTimeoutMs);
	let stderr = await awaitCaptureWithinTimeout(stderrCapture, drainTimeoutMs);
	if (stdout.timedOut || stderr.timedOut) {
		timedOut = true;
		forceKilled =
			(await reapPipeHolders(proc.pid ?? 0, terminateGraceMs)) || forceKilled;
		stdout = stdout.timedOut
			? await awaitCaptureWithinTimeout(stdoutCapture, 0)
			: stdout;
		stderr = stderr.timedOut
			? await awaitCaptureWithinTimeout(stderrCapture, 0)
			: stderr;
	}

	if (exit.value.code !== 0 || timedOut || forceKilled) {
		const suffix = [
			timedOut ? "timed out" : null,
			forceKilled ? "force-killed" : null,
			stdout.timedOut ? "stdout-drain-timeout" : null,
			stderr.timedOut ? "stderr-drain-timeout" : null,
			exit.value.signal ? `signal=${exit.value.signal}` : null,
		]
			.filter(Boolean)
			.join(", ");
		throw new Error(
			`${args.join(" ")} exited ${exit.value.code ?? -1}${suffix ? ` (${suffix})` : ""}\nstdout:\n${stdout.text}\nstderr:\n${stderr.text}`,
		);
	}
	return `${stdout.text}${stderr.text}`.trim();
}

export async function collectBenchmarkRuns(options: {
	warmups: number;
	rounds: number;
}): Promise<BenchmarkRun[]> {
	const { warmups, rounds } = options;
	const handshakeDefinition: ScenarioDefinition<HandshakeBenchmarkOutput> = {
		command: ["bun", "tools/bench/handshake-latency.ts"],
		parse: parseHandshakeOutput,
		metrics: [
			{
				name: "handshake-p50-ms",
				unit: "ms",
				pick: (output: HandshakeBenchmarkOutput) => output.p50_ms,
			},
			{
				name: "handshake-p95-ms",
				unit: "ms",
				pick: (output: HandshakeBenchmarkOutput) => output.p95_ms,
			},
			{
				name: "handshake-p99-ms",
				unit: "ms",
				pick: (output: HandshakeBenchmarkOutput) => output.p99_ms,
			},
			{
				name: "close-latency-p99-ms",
				unit: "ms",
				pick: (output: HandshakeBenchmarkOutput) => output.close_latency_p99_ms,
			},
		],
	};
	const streamDefinition: ScenarioDefinition<StreamBenchmarkOutput> = {
		command: ["bun", "tools/bench/stream-throughput.ts"],
		parse: (output: string) => parseJsonLine<StreamBenchmarkOutput>(output),
		metrics: [
			{
				name: "stream-throughput-mbps",
				unit: "MiB/s",
				pick: (output: StreamBenchmarkOutput) => output.throughput_mbps,
			},
		],
	};
	const datagramDefinition: ScenarioDefinition<DatagramBenchmarkOutput> = {
		command: ["bun", "tools/bench/datagram-throughput.ts"],
		parse: parseDatagramOutput,
		metrics: [
			{
				name: "datagram-throughput-dgrams-per-sec",
				unit: "dgram/s",
				pick: (output: DatagramBenchmarkOutput) =>
					output.throughput_dgrams_per_sec,
			},
			{
				name: "datagram-loss-ratio",
				unit: "ratio",
				pick: (output: DatagramBenchmarkOutput) => output.loss_ratio,
			},
			{
				name: "event-loop-delay-p99-ms",
				unit: "ms",
				pick: (output: DatagramBenchmarkOutput) =>
					output.event_loop_delay_p99_ms,
			},
			{
				name: "cpu-user-ms",
				unit: "ms",
				pick: (output: DatagramBenchmarkOutput) => output.cpu_user_ms,
			},
			{
				name: "peak-rss-mib",
				unit: "MiB",
				pick: (output: DatagramBenchmarkOutput) => output.peak_rss_mib,
			},
		],
	};

	const runs = [
		...(await collectScenarioRuns(handshakeDefinition, warmups, rounds)),
		...(await collectScenarioRuns(streamDefinition, warmups, rounds)),
		...(await collectScenarioRuns(datagramDefinition, warmups, rounds)),
	];
	const failures = validateBenchmarkRuns(runs);
	if (failures.length > 0) {
		throw new Error(`invalid benchmark evidence:\n${failures.join("\n")}`);
	}
	return runs;
}

async function collectScenarioRuns<TMetrics extends Record<string, number>>(
	definition: ScenarioDefinition<TMetrics>,
	warmups: number,
	rounds: number,
): Promise<BenchmarkRun[]> {
	const rawOutputs: string[] = [];
	const samples = new Map<string, number[]>();
	for (const metric of definition.metrics) {
		samples.set(metric.name, []);
	}
	for (let i = 0; i < warmups + rounds; i++) {
		const output = await runCommand(definition.command);
		const parsed = definition.parse(output);
		if (i >= warmups) {
			rawOutputs.push(output);
			for (const metric of definition.metrics) {
				const values = samples.get(metric.name);
				if (!values) {
					throw new Error(`missing sample bucket for ${metric.name}`);
				}
				const value = metric.pick(parsed);
				const error = validateMetricValue(metric.name, value);
				if (error) throw new Error(error);
				values.push(value);
			}
		}
	}

	return definition.metrics.map((metric) => {
		const metricSamples = samples.get(metric.name);
		if (!metricSamples) {
			throw new Error(`missing metric samples for ${metric.name}`);
		}
		return {
			name: metric.name,
			unit: metric.unit,
			samples: metricSamples,
			summary: sampleSummary(metricSamples),
			rawOutputs,
		};
	});
}

function validateMetricValue(name: string, value: number): string | null {
	if (!Number.isFinite(value)) {
		return `${name}: required sample is missing or non-finite`;
	}
	const rule = METRIC_RULES[name as keyof typeof METRIC_RULES];
	if (!rule) return `${name}: unexpected benchmark metric`;
	if ("maximum" in rule && value > rule.maximum) {
		return `${name}: sample ${value} must be between ${rule.minimum} and ${rule.maximum}`;
	}
	if (
		value < rule.minimum ||
		(!rule.minimumInclusive && value === rule.minimum)
	) {
		return rule.minimumInclusive
			? `${name}: sample ${value} must be at least ${rule.minimum}`
			: `${name}: sample ${value} must be greater than ${rule.minimum}`;
	}
	return null;
}

function validateSummary(name: string, summary: MetricSummary): string[] {
	const failures: string[] = [];
	for (const field of [
		"mean",
		"min",
		"max",
		"stddev",
		"ci95Low",
		"ci95High",
	] as const) {
		if (!Number.isFinite(summary[field])) {
			failures.push(`${name}: summary ${field} is missing or non-finite`);
		}
	}
	return failures;
}

function validateBenchmarkRun(run: BenchmarkRun): string[] {
	const failures: string[] = [];
	const rule = METRIC_RULES[run.name as keyof typeof METRIC_RULES];
	if (!rule) return [`${run.name}: unexpected benchmark metric`];
	if (run.unit !== rule.unit) {
		failures.push(
			`${run.name}: unit ${run.unit} does not match required ${rule.unit}`,
		);
	}
	if (run.samples.length === 0) {
		failures.push(`${run.name}: required sample set is empty`);
	}
	for (const value of run.samples) {
		const error = validateMetricValue(run.name, value);
		if (error && !failures.includes(error)) failures.push(error);
	}
	failures.push(...validateSummary(run.name, run.summary));
	return failures;
}

export function validateBenchmarkRuns(runs: BenchmarkRun[]): string[] {
	const failures: string[] = [];
	const byName = new Map<string, BenchmarkRun>();
	for (const run of runs) {
		if (byName.has(run.name)) {
			failures.push(`${run.name}: duplicate benchmark metric`);
		} else {
			byName.set(run.name, run);
		}
		failures.push(...validateBenchmarkRun(run));
	}

	for (const name of REQUIRED_BENCHMARK_METRICS) {
		if (!byName.has(name)) {
			failures.push(`missing required benchmark metric ${name}`);
		}
	}

	const sampleCounts = new Set(runs.map((run) => run.samples.length));
	if (sampleCounts.size > 1) {
		failures.push("required benchmark metrics do not have equal sample counts");
	}

	const p50Run = byName.get("handshake-p50-ms");
	const p95Run = byName.get("handshake-p95-ms");
	const p99Run = byName.get("handshake-p99-ms");
	if (p50Run && p95Run && p99Run) {
		for (let index = 0; index < p50Run.samples.length; index++) {
			const p50 = p50Run.samples[index];
			const p95 = p95Run.samples[index];
			const p99 = p99Run.samples[index];
			if (
				p50 != null &&
				p95 != null &&
				p99 != null &&
				(p50 > p95 || p95 > p99)
			) {
				failures.push(
					`handshake percentiles are not ordered for sample ${index}`,
				);
			}
		}
	}
	return failures;
}

export function loadApprovedBaselines(
	baselinePath = DEFAULT_BASELINE_PATH,
): ApprovedBaselines {
	const baseline = JSON.parse(
		readFileSync(baselinePath, "utf8"),
	) as ApprovedBaselines;
	return {
		...baseline,
		thresholds: Object.fromEntries(
			Object.entries(baseline.thresholds).map(([name, threshold]) => [
				name,
				{
					...threshold,
					approved: sampleSummary(threshold.approved.samples),
				},
			]),
		),
	};
}

export function compareAgainstBaseline(
	run: BenchmarkRun,
	baseline: ApprovedBaselines,
): string | null {
	const runFailure = validateBenchmarkRun(run)[0];
	if (runFailure) return runFailure;
	const threshold = baseline.thresholds[run.name];
	if (!threshold) {
		return `${run.name}: missing approved baseline threshold`;
	}
	const rule = METRIC_RULES[run.name as keyof typeof METRIC_RULES];
	if (threshold.unit !== rule.unit) {
		return `${run.name}: approved baseline unit ${threshold.unit} does not match required ${rule.unit}`;
	}
	if (threshold.direction !== rule.direction) {
		return `${run.name}: approved baseline direction ${threshold.direction} does not match required ${rule.direction}`;
	}
	const approvedSummary = sampleSummary(threshold.approved.samples);
	const approvedFailures = [
		...threshold.approved.samples
			.map((value) => validateMetricValue(run.name, value))
			.filter((failure): failure is string => failure != null),
		...validateSummary(run.name, approvedSummary),
	];
	if (approvedFailures.length > 0) {
		return `invalid approved baseline: ${approvedFailures[0]}`;
	}
	if (threshold.direction === "lower-is-better") {
		if (run.summary.ci95Low > approvedSummary.ci95High) {
			return (
				`${run.name}: regression detected; current ci95Low=${run.summary.ci95Low}${run.unit}` +
				` exceeds approved ci95High=${approvedSummary.ci95High}${run.unit}`
			);
		}
		return null;
	}
	if (run.summary.ci95High < approvedSummary.ci95Low) {
		return (
			`${run.name}: regression detected; current ci95High=${run.summary.ci95High}${run.unit}` +
			` is below approved ci95Low=${approvedSummary.ci95Low}${run.unit}`
		);
	}
	return null;
}

export function validateApprovedBaselineContext(
	baseline: ApprovedBaselines,
	current: BenchmarkContext,
): string[] {
	if (baseline.status !== "approved") return [];
	const failures: string[] = [];
	if (
		!baseline.approvedAt ||
		!Number.isFinite(Date.parse(baseline.approvedAt))
	) {
		failures.push("approved baseline timestamp is missing or invalid");
	}
	if (!baseline.commit || !/^[0-9a-f]{40}$/i.test(baseline.commit)) {
		failures.push("approved baseline commit is not a full Git SHA");
	}
	if (!current.commit || !/^[0-9a-f]{40}$/i.test(current.commit)) {
		failures.push("candidate commit is not a full Git SHA");
	}
	if (baseline.candidateRelationship !== "exact") {
		failures.push(
			"approved baseline must declare an exact candidate relationship",
		);
	} else if (baseline.commit !== current.commit) {
		failures.push(
			"approved baseline commit does not exactly match candidate commit",
		);
	}
	if (!baseline.machine || baseline.machine !== current.machine) {
		failures.push("approved baseline machine does not match candidate machine");
	}
	if (!baseline.bunVersion || baseline.bunVersion !== current.bunVersion) {
		failures.push(
			"approved baseline Bun runtime does not match candidate runtime",
		);
	}
	if (
		!baseline.rustcVersion ||
		baseline.rustcVersion !== current.rustcVersion
	) {
		failures.push(
			"approved baseline Rust runtime does not match candidate runtime",
		);
	}
	return failures;
}

export function writeArtifact(
	artifact: RegressionArtifact,
	artifactPath = DEFAULT_ARTIFACT_PATH,
) {
	mkdirSync(dirname(artifactPath), { recursive: true });
	writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
}

export function baselineArtifactStatusMessage(
	baseline: ApprovedBaselines,
	baselinePath = DEFAULT_BASELINE_PATH,
) {
	if (baseline.status === "approved") {
		return null;
	}
	const reason =
		baseline.lastAttempt?.reason ?? "baseline status is not approved";
	return `approved benchmark baseline missing at ${baselinePath}: ${reason}`;
}

export function fileExists(path: string) {
	return existsSync(path);
}
