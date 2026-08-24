import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { cpus, hostname, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createServer } from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";
import {
	clientWindow,
	readPhaseMarker,
	requireClientReportIdentity,
	type ClientReportV2,
	type EmitterPhase,
} from "./g6-artifact.ts";
import {
	G6_ATTRIBUTION_SCHEMA,
	buildLaneContract,
	buildBalancedLaneOrder,
	buildSharedAttributionPlan,
	buildSharedAttributionServerSettings,
	evaluateAttributionOutcome,
	defaultPreRegistration,
	validateAttributionIdentity,
	type AttributionServerSettings,
	type AttributionRequiredMeasurements,
	type AttributionIdentityLeg,
	type AttributionLane,
	type LaneContract,
	type SharedAttributionPlan,
} from "./g6-attribution.ts";
import {
	REGISTERED_G6_SERVER_CORE_PLAN,
	createG6ServerCore,
	freshG6ServerState,
	type G6ServerCoreInstrumentationSwitches,
	type G6ServerCoreSession,
	type ServerState,
} from "./g6-server-core.ts";
import { G6_CLOSEOUT_SPEC_PATH } from "./g6-plan.ts";
import { createMonotonicClock } from "./latency-clock.ts";

type InternalSession = G6ServerCoreSession & {
	_connectionStats?: () => {
		datagramFramesSent?: number | null;
		datagramFramesReceived?: number | null;
		udpDatagramsSent?: number | null;
		udpDatagramsReceived?: number | null;
	} | null;
};

type CpuSnapshot = {
	busy: number;
	total: number;
};

type ProcessSnapshot = {
	cpuMs: number;
	rssMb: number;
	connectionStats: {
		datagramFramesSent: number | null;
		datagramFramesReceived: number | null;
		udpDatagramsSent: number | null;
		udpDatagramsReceived: number | null;
	};
};

export type AttributionTlsBundle = {
	certPem: string;
	keyPem: string;
	certPath: string;
	keyPath: string;
	certSha256: string;
};

export type ClientRunResult = {
	report: ClientReportV2;
	phaseMarkers: string[];
	stdoutLines: string[];
	stderrLines: string[];
	exitCode: number;
	jsonPath: string;
};

export type AttributionLegManifest = {
	schema: "g6-attribution-leg/1";
	lane: AttributionLane;
	orderIndex: number;
	preRegistration: ReturnType<typeof defaultPreRegistration>;
	contract: LaneContract;
	plan: SharedAttributionPlan;
	hostIdentity: string;
	candidateSha: string;
	clientBinarySha256: string;
	serverBinarySha256: string | null;
	tlsCertSha256: string;
	serverSettings: AttributionServerSettings;
	clientReport: ClientReportV2;
	phaseMarkers: string[];
	stdoutLines: string[];
	stderrLines: string[];
	rawServer: Record<string, unknown>;
	identityLeg: AttributionIdentityLeg;
};

export type LegExecutionOptions = {
	lane: AttributionLane;
	orderIndex: number;
	port: number;
	sessions: number;
	durationSec: number;
	idleSec: number;
	drainMs: number;
	outDir: string;
	candidateSha: string;
	clientBinary: string;
	clientBinarySha256: string;
	rustServerBinary: string;
	rustServerBinarySha256: string;
	tls: AttributionTlsBundle;
	preRegistrationSha256: string;
};

export type AggregateResult = {
	schema: "g6-attribution/1";
	invokedAt: string;
	preRegistration: ReturnType<typeof defaultPreRegistration>;
	plan: SharedAttributionPlan;
	candidateSha: string;
	clientBinarySha256: string;
	rustServerBinarySha256: string;
	legOrder: AttributionLane[];
	legs: string[];
	provenance: {
		cleanTree: true;
		buildCommand: string;
		freshTargetDir: true;
	};
	settlement: {
		baselineSamples: number[];
		idleBand: IdleBand;
		sampleWindowMs: number;
		sampleIntervalMs: number;
		deadlineMs: number;
		afterLegs: Array<{
			leg: string;
			samples: number[];
		}>;
	};
	identity: ReturnType<typeof validateAttributionIdentity>;
	outcome: ReturnType<typeof evaluateAttributionOutcome>;
	profiles: { available: false; reason: string };
};

export type IdleBand = {
	baselineSamples: number[];
	upperBoundPct: number;
	rule: string;
	requiredConsecutiveSamples: number;
};

export type MatrixBuildProvenance = {
	command: string;
	clientBinary: string;
	rustServerBinary: string;
};

export type MatrixProvenance = {
	candidateSha: string;
	clientBinarySha256: string;
	rustServerBinarySha256: string;
	build: MatrixBuildProvenance;
};

type MatrixProvenanceDeps = {
	candidateSha: () => string;
	assertCleanTree: () => void;
	buildReferenceBinaries: () => void | MatrixBuildProvenance;
	fileExists: (path: string) => boolean;
	hashFile: (path: string) => string;
};

export async function withAttributionRunContext<T>(
	options: { outDir: string },
	run: (context: {
		outDir: string;
		tls: AttributionTlsBundle;
	}) => Promise<T> | T,
): Promise<T> {
	ensureDir(options.outDir);
	const tlsDir = mkdtempSync(join(tmpdir(), "g6-attribution-tls-"));
	try {
		return await run({
			outDir: options.outDir,
			tls: buildTlsBundle(tlsDir),
		});
	} finally {
		rmSync(tlsDir, { recursive: true, force: true });
	}
}

export async function withFreshBuildDirectory<T>(
	run: (buildDir: string) => Promise<T> | T,
): Promise<T> {
	const buildDir = mkdtempSync(join(tmpdir(), "g6-attribution-build-"));
	try {
		return await run(buildDir);
	} finally {
		rmSync(buildDir, { recursive: true, force: true });
	}
}

export function portableEvidenceName(outDir: string, filePath: string): string {
	const relativePath = relative(outDir, filePath);
	if (
		relativePath.length === 0 ||
		relativePath.startsWith("..") ||
		isAbsolute(relativePath)
	) {
		throw new Error(
			"g6-attribution: evidence path escaped the output directory",
		);
	}
	return relativePath.replaceAll("\\", "/");
}

const CONTROLLED_REFERENCE_BUILD_COMMAND = [
	"cargo",
	"build",
	"--locked",
	"--release",
	"-p",
	"reference",
	"--bin",
	"mmo-client",
	"--bin",
	"g6-server",
] as const;

function hashFile(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readHostCpuSnapshot(): CpuSnapshot | null {
	const cores = cpus();
	if (cores.length === 0) return null;
	let busy = 0;
	let total = 0;
	for (const core of cores) {
		const coreBusy =
			core.times.user + core.times.nice + core.times.sys + core.times.irq;
		busy += coreBusy;
		total += coreBusy + core.times.idle;
	}
	return { busy, total };
}

function hostCpuPct(
	start: CpuSnapshot | null,
	end: CpuSnapshot | null,
): number | null {
	if (!start || !end || end.total <= start.total) return null;
	return ((end.busy - start.busy) / (end.total - start.total)) * 100;
}

async function readHostCpuSample(windowMs: number): Promise<number> {
	const start = readHostCpuSnapshot();
	await Bun.sleep(windowMs);
	const end = readHostCpuSnapshot();
	const value = hostCpuPct(start, end);
	if (value === null) {
		throw new Error("g6-attribution: failed to sample host cpu");
	}
	return value;
}

async function captureHostCpuSamples(options: {
	count: number;
	sampleWindowMs: number;
	sampleIntervalMs: number;
}): Promise<number[]> {
	const samples: number[] = [];
	for (let index = 0; index < options.count; index += 1) {
		samples.push(await readHostCpuSample(options.sampleWindowMs));
		if (index + 1 < options.count) {
			await Bun.sleep(options.sampleIntervalMs);
		}
	}
	return samples;
}

function processCpuMs(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

function processRssMb(): number {
	return process.memoryUsage().rss / 1024 / 1024;
}

function percentMismatch(values: number[]): number {
	const finite = values.filter((value) => Number.isFinite(value));
	if (finite.length < 2) return 0;
	const max = Math.max(...finite);
	const min = Math.min(...finite);
	if (max <= 0) return 0;
	return (max - min) / max;
}

function hasServerTraffic(state: Record<string, unknown> | undefined): boolean {
	if (!state) return false;
	const emitter = (state.emitter as Record<string, unknown> | undefined) ?? {};
	return (
		Number(state.rxTotal ?? 0) > 0 ||
		Number(emitter.snapshotIssued ?? 0) > 0 ||
		Number(emitter.ackIssued ?? 0) > 0
	);
}

function normalizedConnectionStats(
	stats: Array<Record<string, number> | null>,
	state: Record<string, unknown> | undefined,
): {
	datagramFramesSent: number | null;
	datagramFramesReceived: number | null;
	udpDatagramsSent: number | null;
	udpDatagramsReceived: number | null;
} {
	const totals = {
		datagramFramesSent: stats.reduce(
			(sum, entry) => sum + (entry?.datagramFramesSent ?? 0),
			0,
		),
		datagramFramesReceived: stats.reduce(
			(sum, entry) => sum + (entry?.datagramFramesReceived ?? 0),
			0,
		),
		udpDatagramsSent: stats.reduce(
			(sum, entry) => sum + (entry?.udpDatagramsSent ?? 0),
			0,
		),
		udpDatagramsReceived: stats.reduce(
			(sum, entry) => sum + (entry?.udpDatagramsReceived ?? 0),
			0,
		),
	};
	const allZero = Object.values(totals).every((value) => value === 0);
	if (allZero && hasServerTraffic(state)) {
		return {
			datagramFramesSent: null,
			datagramFramesReceived: null,
			udpDatagramsSent: null,
			udpDatagramsReceived: null,
		};
	}
	return totals;
}

function unavailableRawConnectionStage(
	connectionStats: Record<string, unknown>,
	state: Record<string, unknown> | undefined,
): boolean {
	if (!hasServerTraffic(state)) return false;
	return (
		Number(connectionStats.datagramFramesSent ?? 0) === 0 &&
		Number(connectionStats.datagramFramesReceived ?? 0) === 0 &&
		Number(connectionStats.udpDatagramsSent ?? 0) === 0 &&
		Number(connectionStats.udpDatagramsReceived ?? 0) === 0
	);
}

function numberOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractMeasurements(input: {
	plan: SharedAttributionPlan;
	clientReport: ClientReportV2;
	rawServer: {
		measurements?: Partial<AttributionRequiredMeasurements> | undefined;
		summary?: Record<string, unknown>;
		connectionStats?: Record<string, unknown>;
		state?: ServerState;
	};
}): AttributionRequiredMeasurements {
	const summaryMeasurements =
		(input.rawServer.summary?.measurements as
			| Partial<AttributionRequiredMeasurements>
			| undefined) ?? {};
	const directMeasurements = input.rawServer.measurements ?? {};
	const merged = {
		...summaryMeasurements,
		...directMeasurements,
	};
	const clientBlock =
		(input.clientReport.client as Record<string, unknown> | undefined) ?? {};
	const serverBlock =
		(input.rawServer.summary?.server as Record<string, unknown> | undefined) ??
		{};
	const fallbackConnectionStats =
		(serverBlock.rawConnectionStats as Record<string, unknown> | undefined) ??
		{};
	const measuredRawStages =
		(summaryMeasurements.rawStages as Record<string, unknown> | undefined) ??
		{};
	const connectionStats =
		input.rawServer.connectionStats ?? fallbackConnectionStats ?? {};
	return {
		window: {
			kind: "steady",
			startPhase: "steady",
			endPhase: "drain",
			wallMs:
				numberOrNull(merged.window?.wallMs) ?? input.plan.durationSec * 1000,
			synchronized: merged.window?.synchronized ?? true,
		},
		serverProcessCpu: {
			unit: "cpu-ms",
			value: numberOrNull(merged.serverProcessCpu?.value),
		},
		clientProcessCpu: {
			unit: "cpu-ms",
			value:
				numberOrNull(merged.clientProcessCpu?.value) ??
				numberOrNull(clientBlock.cpuMsSteady) ??
				numberOrNull(clientBlock.cpuMsDrive),
		},
		hostCpu: {
			unit: "host-cpu-pct",
			value: numberOrNull(merged.hostCpu?.value),
		},
		serverRss: {
			unit: "rss-mib",
			value: numberOrNull(merged.serverRss?.value),
		},
		clientRss: {
			unit: "rss-mib",
			value:
				numberOrNull(merged.clientRss?.value) ??
				numberOrNull(clientBlock.rssMbSteady) ??
				numberOrNull(clientBlock.rssMbDrive),
		},
		rawStages: {
			datagramFrameUnit: "quic-datagram-frames",
			udpDatagramUnit: "udp-datagrams",
			datagramFramesSent:
				numberOrNull(connectionStats.datagramFramesSent) ??
				numberOrNull(measuredRawStages.datagramFramesSent),
			datagramFramesReceived:
				numberOrNull(connectionStats.datagramFramesReceived) ??
				numberOrNull(measuredRawStages.datagramFramesReceived),
			udpDatagramsSent:
				numberOrNull(connectionStats.udpDatagramsSent) ??
				numberOrNull(measuredRawStages.udpDatagramsSent),
			udpDatagramsReceived:
				numberOrNull(connectionStats.udpDatagramsReceived) ??
				numberOrNull(measuredRawStages.udpDatagramsReceived),
			capturedBeforeTeardown:
				merged.rawStages?.capturedBeforeTeardown ??
				(typeof measuredRawStages.capturedBeforeTeardown === "boolean"
					? measuredRawStages.capturedBeforeTeardown
					: true),
		},
	};
}

function extractServerSettings(input: {
	plan: SharedAttributionPlan;
	rawServer: {
		settings?: AttributionServerSettings;
		summary?: Record<string, unknown>;
	};
}): AttributionServerSettings {
	const summaryConfig =
		(input.rawServer.summary?.config as Record<string, unknown> | undefined) ??
		{};
	const limits =
		(summaryConfig.limits as Record<string, unknown> | undefined) ?? {};
	const rateLimits =
		(summaryConfig.rateLimits as Record<string, unknown> | undefined) ?? {};
	const fromSummary =
		typeof limits.maxSessions === "number" &&
		typeof limits.maxHandshakesInFlight === "number" &&
		typeof limits.maxStreamsPerSessionBidi === "number" &&
		typeof limits.maxStreamsPerSessionUni === "number" &&
		typeof limits.maxStreamsGlobal === "number" &&
		typeof limits.maxDatagramSize === "number" &&
		typeof limits.maxQueuedBytesPerSession === "number" &&
		typeof limits.maxQueuedBytesPerStream === "number" &&
		typeof limits.idleTimeoutMs === "number" &&
		typeof rateLimits.handshakesPerSec === "number" &&
		typeof rateLimits.handshakesBurst === "number" &&
		typeof rateLimits.handshakesBurstPerPrefix === "number" &&
		typeof rateLimits.streamsPerSec === "number" &&
		typeof rateLimits.streamsBurst === "number" &&
		typeof rateLimits.datagramsPerSec === "number" &&
		typeof rateLimits.datagramsBurst === "number"
			? {
					limits: {
						maxSessions: limits.maxSessions,
						maxHandshakesInFlight: limits.maxHandshakesInFlight,
						maxStreamsPerSessionBidi: limits.maxStreamsPerSessionBidi,
						maxStreamsPerSessionUni: limits.maxStreamsPerSessionUni,
						maxStreamsGlobal: limits.maxStreamsGlobal,
						maxDatagramSize: limits.maxDatagramSize,
						maxQueuedBytesPerSession: limits.maxQueuedBytesPerSession,
						maxQueuedBytesPerStream: limits.maxQueuedBytesPerStream,
						idleTimeoutMs: limits.idleTimeoutMs,
					},
					rateLimits: {
						handshakesPerSec: rateLimits.handshakesPerSec,
						handshakesBurst: rateLimits.handshakesBurst,
						handshakesBurstPerPrefix: rateLimits.handshakesBurstPerPrefix,
						streamsPerSec: rateLimits.streamsPerSec,
						streamsBurst: rateLimits.streamsBurst,
						datagramsPerSec: rateLimits.datagramsPerSec,
						datagramsBurst: rateLimits.datagramsBurst,
					},
				}
			: null;
	return (
		fromSummary ??
		input.rawServer.settings ??
		buildSharedAttributionServerSettings(input.plan.sessions)
	);
}

function parseJsonLine(line: string): Record<string, unknown> | null {
	const match = line.match(/^mmo-client: json (\{.*\})$/);
	if (!match?.[1]) return null;
	return JSON.parse(match[1]) as Record<string, unknown>;
}

export function preregistrationSha256(): string {
	return createHash("sha256")
		.update(readFileSync(G6_CLOSEOUT_SPEC_PATH))
		.digest("hex");
}

export function ensureDir(path: string): void {
	mkdirSync(path, { recursive: true });
}

export async function runClientLeg(options: {
	port: number;
	sessions: number;
	durationSec: number;
	idleSec: number;
	drainMs: number;
	clientBinary: string;
	jsonPath: string;
	startedAt: string;
	preRegistrationSha256: string;
	onPhaseMarker: (phase: string) => void;
}): Promise<ClientRunResult> {
	const args = [
		"--role",
		"realm",
		"--url",
		`https://127.0.0.1:${options.port}`,
		"--sessions",
		String(options.sessions),
		"--send-interval-ms",
		"250",
		"--action-every",
		"8",
		"--payload-bytes",
		"64",
		"--steady-secs",
		String(options.durationSec),
		"--drain-ms",
		String(options.drainMs),
		"--idle-secs",
		String(options.idleSec),
		"--connect-timeout-secs",
		"60",
		"--preregistration-sha256",
		options.preRegistrationSha256,
		"--started-at",
		options.startedAt,
		"--json-out",
		options.jsonPath,
	];
	const child = spawn(options.clientBinary, args, {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const stdoutLines: string[] = [];
	const stderrLines: string[] = [];
	const phaseMarkers: string[] = [];
	let reportFromStdout: Record<string, unknown> | null = null;
	const stdoutDecoder = new TextDecoder();
	const stderrDecoder = new TextDecoder();
	let stdoutBuffered = "";
	let stderrBuffered = "";
	const readStdout = (async () => {
		for await (const chunk of child.stdout ?? []) {
			stdoutBuffered += stdoutDecoder.decode(chunk as Uint8Array, {
				stream: true,
			});
			const lines = stdoutBuffered.split("\n");
			stdoutBuffered = lines.pop() ?? "";
			for (const line of lines) {
				stdoutLines.push(line);
				const marker = readPhaseMarker(line);
				if (marker) {
					phaseMarkers.push(marker.kind);
					options.onPhaseMarker(marker.kind);
				}
				reportFromStdout = parseJsonLine(line) ?? reportFromStdout;
			}
		}
		if (stdoutBuffered.length > 0) {
			stdoutLines.push(stdoutBuffered);
			const marker = readPhaseMarker(stdoutBuffered);
			if (marker) {
				phaseMarkers.push(marker.kind);
				options.onPhaseMarker(marker.kind);
			}
			reportFromStdout = parseJsonLine(stdoutBuffered) ?? reportFromStdout;
		}
	})();
	const readStderr = (async () => {
		for await (const chunk of child.stderr ?? []) {
			stderrBuffered += stderrDecoder.decode(chunk as Uint8Array, {
				stream: true,
			});
			const lines = stderrBuffered.split("\n");
			stderrBuffered = lines.pop() ?? "";
			for (const line of lines) stderrLines.push(line);
		}
		if (stderrBuffered.length > 0) stderrLines.push(stderrBuffered);
	})();
	const exitCode = await new Promise<number>((resolve) => {
		child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : -1)));
		child.on("error", () => resolve(-1));
	});
	await Promise.all([readStdout, readStderr]);
	const reportJson =
		existsSync(options.jsonPath) &&
		readFileSync(options.jsonPath, "utf8").trim().length > 0
			? (JSON.parse(readFileSync(options.jsonPath, "utf8")) as Record<
					string,
					unknown
				>)
			: reportFromStdout;
	const report = requireClientReportIdentity(reportJson, {
		role: "realm",
		startedAt: options.startedAt,
		preregistrationSha256: options.preRegistrationSha256,
	});
	return {
		report,
		phaseMarkers,
		stdoutLines,
		stderrLines,
		exitCode,
		jsonPath: options.jsonPath,
	};
}

export async function startJsLaneServer(options: {
	lane: "full-js" | "minimal-js-addon";
	port: number;
	tls: AttributionTlsBundle;
	sessions: number;
	durationSec: number;
	serverSettings: AttributionServerSettings;
}) {
	const clock = await createMonotonicClock();
	let state = freshG6ServerState();
	const phaseState = { current: "connect" as EmitterPhase };
	const sessions: InternalSession[] = [];
	const verboseProgressLogs: string[] = [];
	const humanReadableRows: string[] = [];
	let rssMaxMb: number | null = null;
	let steadyStart: ProcessSnapshot | null = null;
	let drainStart: ProcessSnapshot | null = null;
	const contract = buildLaneContract(options.lane);
	const switches = {
		...(contract.switches ?? {}),
	} as G6ServerCoreInstrumentationSwitches;
	const core = createG6ServerCore({
		plan: REGISTERED_G6_SERVER_CORE_PLAN,
		clock,
		nowMs: () => Date.now(),
		phaseState,
		state: () => state,
		severAtMs: () => null,
		dueAccounting: {
			plannedSessions: options.sessions,
			steadyWindowSec: options.durationSec,
		},
		instrumentation: {
			switches,
			emitVerboseProgress: (message) => {
				verboseProgressLogs.push(message);
			},
			materializeHumanReadableRow: (row) => {
				humanReadableRows.push(row);
			},
		},
	});
	const server = createServer({
		port: options.port,
		tls: {
			certPem: options.tls.certPem,
			keyPem: options.tls.keyPem,
		},
		limits: { ...options.serverSettings.limits },
		rateLimits: { ...options.serverSettings.rateLimits },
		onSession: (session) => {
			sessions.push(session as InternalSession);
			core.onSession(session as InternalSession);
		},
	});
	const stopEmitter = core.startEmitter(() => phaseState.current);
	const sampleSnapshot = (): ProcessSnapshot => ({
		cpuMs: processCpuMs(),
		rssMb: processRssMb(),
		connectionStats: normalizedConnectionStats(
			sessions
				.map((session) => session._connectionStats?.() ?? null)
				.filter(Boolean) as Array<Record<string, number> | null>,
			state as Record<string, unknown>,
		),
	});
	const rssSampler = setInterval(() => {
		if (phaseState.current !== "steady") return;
		const rss = processRssMb();
		rssMaxMb = rssMaxMb === null ? rss : Math.max(rssMaxMb, rss);
	}, 200);
	rssSampler.unref?.();
	return {
		contract,
		setPhase: (phase: string) => {
			if (
				phase === "steady" ||
				phase === "drain" ||
				phase === "idle" ||
				phase === "stop"
			) {
				phaseState.current = phase;
				if (phase === "steady" && !steadyStart) {
					steadyStart = sampleSnapshot();
					rssMaxMb = steadyStart.rssMb;
				}
				if (phase === "drain" && !drainStart) {
					drainStart = sampleSnapshot();
					rssMaxMb =
						rssMaxMb === null
							? drainStart.rssMb
							: Math.max(rssMaxMb, drainStart.rssMb);
				}
			}
		},
		collectRawServer: (hostCpuValue: number | null) => {
			const snapshot = sampleSnapshot();
			return {
				state,
				metrics: server.metricsSnapshot(),
				switches,
				verboseProgressLogs: [...verboseProgressLogs],
				humanReadableRows: [...humanReadableRows],
				settings: options.serverSettings,
				connectionStats:
					drainStart?.connectionStats ?? snapshot.connectionStats,
				measurements: {
					window: {
						kind: "steady" as const,
						startPhase: "steady" as const,
						endPhase: "drain" as const,
						wallMs: options.durationSec * 1000,
						synchronized: steadyStart !== null && drainStart !== null,
					},
					serverProcessCpu: {
						unit: "cpu-ms" as const,
						value:
							steadyStart && drainStart
								? drainStart.cpuMs - steadyStart.cpuMs
								: null,
					},
					hostCpu: {
						unit: "host-cpu-pct" as const,
						value: hostCpuValue,
					},
					serverRss: {
						unit: "rss-mib" as const,
						value: rssMaxMb,
					},
					rawStages: {
						datagramFrameUnit: "quic-datagram-frames" as const,
						udpDatagramUnit: "udp-datagrams" as const,
						...(drainStart?.connectionStats ?? snapshot.connectionStats),
						capturedBeforeTeardown: drainStart !== null,
					},
				},
			};
		},
		close: async () => {
			stopEmitter();
			clearInterval(rssSampler);
			await server.close();
		},
		reset: () => {
			state = freshG6ServerState();
		},
	};
}

export async function waitForRustServerExit(
	child: Pick<ChildProcess, "exitCode" | "signalCode" | "on">,
): Promise<number> {
	if (typeof child.exitCode === "number") return child.exitCode;
	if (child.signalCode !== null) return 128;
	return await new Promise<number>((resolve) => {
		child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : -1)));
		child.on("error", () => resolve(-1));
	});
}

export async function closeWithin<T>(
	label: string,
	run: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			run(),
			new Promise<T>((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(
						new Error(
							`g6-attribution: ${label} timed out after ${timeoutMs}ms`,
						),
					);
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== null) clearTimeout(timeoutId);
	}
}

export async function terminateChildWithin(
	child: Pick<ChildProcess, "exitCode" | "signalCode" | "kill" | "on">,
	options: {
		termTimeoutMs: number;
		killTimeoutMs: number;
	},
): Promise<number> {
	if (typeof child.exitCode === "number" || child.signalCode !== null) {
		return waitForRustServerExit(child);
	}
	child.kill("SIGTERM");
	try {
		return await closeWithin(
			"child SIGTERM reap",
			() => waitForRustServerExit(child),
			options.termTimeoutMs,
		);
	} catch {
		child.kill("SIGKILL");
		return await closeWithin(
			"child SIGKILL reap",
			() => waitForRustServerExit(child),
			options.killTimeoutMs,
		);
	}
}

export function deriveIdleBand(
	samples: number[],
	options?: {
		minSlackPct?: number;
		requiredConsecutiveSamples?: number;
	},
): IdleBand {
	if (samples.length === 0) {
		throw new Error("g6-attribution: idle band requires at least one sample");
	}
	const maxSample = Math.max(...samples);
	const slack = Math.max(options?.minSlackPct ?? 2, maxSample * 0.25);
	return {
		baselineSamples: [...samples],
		upperBoundPct: maxSample + slack,
		rule: "upperBound = max(baselineSamples) + max(minSlackPct, max(baselineSamples) * 0.25)",
		requiredConsecutiveSamples: options?.requiredConsecutiveSamples ?? 3,
	};
}

export async function settleToIdleBand(options: {
	idleBand: IdleBand;
	deadlineMs: number;
	sampleIntervalMs: number;
	readHostCpu: () => number | null | Promise<number | null>;
}): Promise<number[]> {
	const samples: number[] = [];
	let consecutive = 0;
	const deadlineAt = Date.now() + options.deadlineMs;
	while (Date.now() < deadlineAt) {
		const sample = await options.readHostCpu();
		if (sample !== null && Number.isFinite(sample)) {
			samples.push(sample);
			if (sample <= options.idleBand.upperBoundPct) {
				consecutive += 1;
				if (consecutive >= options.idleBand.requiredConsecutiveSamples) {
					return samples;
				}
			} else {
				consecutive = 0;
			}
		}
		await Bun.sleep(options.sampleIntervalMs);
	}
	throw new Error("g6-attribution: host cpu did not return to the idle band");
}

export function buildIdentityLeg(input: {
	lane: AttributionLane;
	orderIndex: number;
	plan: SharedAttributionPlan;
	preRegistrationSha256: string;
	candidateSha: string;
	clientBinarySha256: string;
	tlsCertSha256: string;
	hostIdentity: string;
	clientReport: ClientReportV2;
	phaseMarkers: string[];
	rawServer: {
		state?: ServerState;
		metrics?: Record<string, unknown>;
		connectionStats?: Record<string, unknown>;
		summary?: Record<string, unknown>;
		measurements?: Partial<AttributionRequiredMeasurements>;
		settings?: AttributionServerSettings;
	};
}): AttributionIdentityLeg {
	const plan = input.plan;
	const steady = clientWindow(input.clientReport, "steady");
	const state =
		input.rawServer.state ??
		(input.rawServer.summary?.server as Record<string, unknown> | undefined) ??
		{};
	const connectionStats =
		input.rawServer.connectionStats ??
		((state as Record<string, unknown>).rawConnectionStats as
			| Record<string, unknown>
			| undefined) ??
		((input.rawServer.summary?.server as Record<string, unknown> | undefined)
			?.rawConnectionStats as Record<string, unknown> | undefined) ??
		{};
	const metrics =
		input.rawServer.metrics ??
		(input.rawServer.summary?.server as Record<string, unknown> | undefined) ??
		{};
	const rxTotal =
		(state as ServerState).rxTotal ??
		((state as Record<string, unknown>).rxTotal as number | undefined) ??
		0;
	const emitter =
		(state as ServerState).emitter ??
		((state as Record<string, unknown>).emitter as
			| Record<string, unknown>
			| undefined) ??
		{};
	const clientSent = steady?.sent ?? 0;
	const measurements = extractMeasurements({
		plan,
		clientReport: input.clientReport,
		rawServer: input.rawServer,
	});
	const serverSettings = extractServerSettings({
		plan,
		rawServer: input.rawServer,
	});
	const rawReceived =
		!unavailableRawConnectionStage(
			connectionStats,
			state as Record<string, unknown>,
		) && typeof measurements.rawStages.datagramFramesReceived === "number"
			? measurements.rawStages.datagramFramesReceived
			: null;
	const comparableStageMismatchPct = percentMismatch(
		rawReceived === null
			? [clientSent, rxTotal]
			: [clientSent, rawReceived, rxTotal],
	);
	return {
		lane: input.lane,
		orderIndex: input.orderIndex,
		preRegistration: defaultPreRegistration(input.preRegistrationSha256),
		candidateSha: input.candidateSha,
		clientBinarySha256: input.clientBinarySha256,
		hostIdentity: input.hostIdentity,
		tlsCertSha256: input.tlsCertSha256,
		sessions: plan.sessions,
		durationSec: plan.durationSec,
		upstreamPayloadBytes: plan.upstreamPayloadBytes,
		movePps: plan.movePps,
		actionPps: plan.actionPps,
		actionEveryNthTick: plan.actionEveryNthTick,
		snapshotDatagrams: plan.snapshotDatagrams,
		snapshotPayloadBytes: plan.snapshotPayloadBytes,
		snapshotHz: plan.snapshotHz,
		emitterSliceHz: plan.emitterSliceHz,
		expectedMoveDue: plan.expectedMoveDue,
		expectedSnapshotDue: plan.expectedSnapshotDue,
		expectedAckDue: plan.expectedAckDue,
		clientOfferedRatio:
			plan.expectedMoveDue === 0 ? 0 : clientSent / plan.expectedMoveDue,
		clientScheduleLagNegative:
			(steady?.scheduleLag as { negative?: number } | undefined)?.negative ?? 0,
		serverEmitterLagNegative: 0,
		phaseMarkers: input.phaseMarkers,
		sendErrors: Number((emitter as Record<string, unknown>).sendErrors ?? 0),
		unclassifiedDatagrams: Number(
			(state as ServerState).rxUnstamped ??
				(state as Record<string, unknown>).rxUnstamped ??
				0,
		),
		rateLimitedDelta: Number(
			(metrics as Record<string, unknown>).rateLimitedCount ?? 0,
		),
		limitExceededDelta: Number(
			(metrics as Record<string, unknown>).limitExceededCount ?? 0,
		),
		clientScheduleTicksDue: steady?.scheduleTicksDue ?? 0,
		serverSnapshotDue: Number(
			(emitter as Record<string, unknown>).snapshotDue ?? 0,
		),
		serverAckDue: Number((emitter as Record<string, unknown>).ackDue ?? 0),
		comparableStageMismatchPct,
		issuedRatio:
			Number((emitter as Record<string, unknown>).snapshotDue ?? 0) === 0
				? 0
				: Number((emitter as Record<string, unknown>).snapshotIssued ?? 0) /
					Number((emitter as Record<string, unknown>).snapshotDue ?? 1),
		measurements,
		serverSettings,
	};
}

export async function runAttributionLeg(
	options: LegExecutionOptions & { startedAt: string },
): Promise<AttributionLegManifest> {
	ensureDir(options.outDir);
	const plan = buildSharedAttributionPlan(
		options.sessions,
		options.durationSec,
	);
	const serverSettings = buildSharedAttributionServerSettings(options.sessions);
	const clientJson = join(
		options.outDir,
		`${String(options.orderIndex).padStart(2, "0")}-${options.lane}-client.json`,
	);
	const phaseFile = join(
		options.outDir,
		`${String(options.orderIndex).padStart(2, "0")}-${options.lane}.phase`,
	);
	writeFileSync(phaseFile, "connect\n");
	let hostSteadyStart: CpuSnapshot | null = null;
	let hostDrainStart: CpuSnapshot | null = null;
	const setPhase = (phase: string) => {
		writeFileSync(phaseFile, `${phase}\n`);
		if (phase === "steady" && hostSteadyStart === null) {
			hostSteadyStart = readHostCpuSnapshot();
		}
		if (phase === "drain" && hostDrainStart === null) {
			hostDrainStart = readHostCpuSnapshot();
		}
	};
	const hostCpuValue = () => hostCpuPct(hostSteadyStart, hostDrainStart);
	if (options.lane === "direct-rust") {
		const summaryJson = join(
			options.outDir,
			`${String(options.orderIndex).padStart(2, "0")}-${options.lane}-server.json`,
		);
		const child = spawn(options.rustServerBinary, [
			"--port",
			String(options.port),
			"--sessions",
			String(options.sessions),
			"--cert-pem",
			options.tls.certPath,
			"--key-pem",
			options.tls.keyPath,
			"--duration-secs",
			String(options.durationSec),
			"--idle-secs",
			String(options.idleSec),
			"--drain-ms",
			String(options.drainMs),
			"--max-sessions",
			String(serverSettings.limits.maxSessions),
			"--max-handshakes-in-flight",
			String(serverSettings.limits.maxHandshakesInFlight),
			"--max-streams-per-session-bidi",
			String(serverSettings.limits.maxStreamsPerSessionBidi),
			"--max-streams-per-session-uni",
			String(serverSettings.limits.maxStreamsPerSessionUni),
			"--max-streams-global",
			String(serverSettings.limits.maxStreamsGlobal),
			"--max-datagram-size",
			String(serverSettings.limits.maxDatagramSize),
			"--max-queued-bytes-per-session",
			String(serverSettings.limits.maxQueuedBytesPerSession),
			"--max-queued-bytes-per-stream",
			String(serverSettings.limits.maxQueuedBytesPerStream),
			"--idle-timeout-ms",
			String(serverSettings.limits.idleTimeoutMs),
			"--handshakes-per-sec",
			String(serverSettings.rateLimits.handshakesPerSec),
			"--handshakes-burst",
			String(serverSettings.rateLimits.handshakesBurst),
			"--handshakes-burst-per-prefix",
			String(serverSettings.rateLimits.handshakesBurstPerPrefix),
			"--streams-per-sec",
			String(serverSettings.rateLimits.streamsPerSec),
			"--streams-burst",
			String(serverSettings.rateLimits.streamsBurst),
			"--datagrams-per-sec",
			String(serverSettings.rateLimits.datagramsPerSec),
			"--datagrams-burst",
			String(serverSettings.rateLimits.datagramsBurst),
			"--phase-path",
			phaseFile,
			"--summary-json",
			summaryJson,
		]);
		let client: ClientRunResult | null = null;
		let serverExitCode: number | null = null;
		try {
			client = await runClientLeg({
				port: options.port,
				sessions: options.sessions,
				durationSec: options.durationSec,
				idleSec: options.idleSec,
				drainMs: options.drainMs,
				clientBinary: options.clientBinary,
				jsonPath: clientJson,
				startedAt: options.startedAt,
				preRegistrationSha256: options.preRegistrationSha256,
				onPhaseMarker: setPhase,
			});
			setPhase("stop");
			serverExitCode = await closeWithin(
				"direct-rust server exit",
				() => waitForRustServerExit(child),
				10_000,
			);
			const summary = JSON.parse(readFileSync(summaryJson, "utf8")) as Record<
				string,
				unknown
			>;
			const identityLeg = buildIdentityLeg({
				lane: options.lane,
				orderIndex: options.orderIndex,
				plan,
				preRegistrationSha256: options.preRegistrationSha256,
				candidateSha: options.candidateSha,
				clientBinarySha256: options.clientBinarySha256,
				tlsCertSha256: options.tls.certSha256,
				hostIdentity: hostname(),
				clientReport: client.report,
				phaseMarkers: client.phaseMarkers,
				rawServer: {
					summary,
					settings: serverSettings,
					measurements: {
						hostCpu: {
							unit: "host-cpu-pct",
							value: hostCpuValue(),
						},
					},
				},
			});
			return {
				schema: "g6-attribution-leg/1",
				lane: options.lane,
				orderIndex: options.orderIndex,
				preRegistration: defaultPreRegistration(options.preRegistrationSha256),
				contract: buildLaneContract(options.lane),
				plan,
				hostIdentity: hostname(),
				candidateSha: options.candidateSha,
				clientBinarySha256: options.clientBinarySha256,
				serverBinarySha256: options.rustServerBinarySha256,
				tlsCertSha256: options.tls.certSha256,
				serverSettings,
				clientReport: client.report,
				phaseMarkers: client.phaseMarkers,
				stdoutLines: client.stdoutLines,
				stderrLines: [
					`g6-server exit=${serverExitCode}`,
					...client.stderrLines,
				],
				rawServer: summary,
				identityLeg,
			};
		} finally {
			setPhase("stop");
			if (serverExitCode === null) {
				await terminateChildWithin(child, {
					termTimeoutMs: 5_000,
					killTimeoutMs: 5_000,
				});
			}
		}
	}

	const jsServer = await startJsLaneServer({
		lane: options.lane,
		port: options.port,
		tls: options.tls,
		sessions: options.sessions,
		durationSec: options.durationSec,
		serverSettings,
	});
	try {
		const client = await runClientLeg({
			port: options.port,
			sessions: options.sessions,
			durationSec: options.durationSec,
			idleSec: options.idleSec,
			drainMs: options.drainMs,
			clientBinary: options.clientBinary,
			jsonPath: clientJson,
			startedAt: options.startedAt,
			preRegistrationSha256: options.preRegistrationSha256,
			onPhaseMarker: (phase) => {
				jsServer.setPhase(phase);
				setPhase(phase);
			},
		});
		await Bun.sleep(options.idleSec * 1000);
		const rawServer = jsServer.collectRawServer(hostCpuValue());
		const identityLeg = buildIdentityLeg({
			lane: options.lane,
			orderIndex: options.orderIndex,
			plan,
			preRegistrationSha256: options.preRegistrationSha256,
			candidateSha: options.candidateSha,
			clientBinarySha256: options.clientBinarySha256,
			tlsCertSha256: options.tls.certSha256,
			hostIdentity: hostname(),
			clientReport: client.report,
			phaseMarkers: client.phaseMarkers,
			rawServer,
		});
		return {
			schema: "g6-attribution-leg/1",
			lane: options.lane,
			orderIndex: options.orderIndex,
			preRegistration: defaultPreRegistration(options.preRegistrationSha256),
			contract: jsServer.contract,
			plan,
			hostIdentity: hostname(),
			candidateSha: options.candidateSha,
			clientBinarySha256: options.clientBinarySha256,
			serverBinarySha256: null,
			tlsCertSha256: options.tls.certSha256,
			serverSettings,
			clientReport: client.report,
			phaseMarkers: client.phaseMarkers,
			stdoutLines: client.stdoutLines,
			stderrLines: client.stderrLines,
			rawServer,
			identityLeg,
		};
	} finally {
		await closeWithin("js-server close", () => jsServer.close(), 5_000);
	}
}

export function writeManifest(
	path: string,
	manifest: AttributionLegManifest,
): void {
	writeFileSync(path, renderManifestJson(manifest));
}

export function renderManifestJson(manifest: AttributionLegManifest): string {
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function detectBinarySha(path: string): string {
	return hashFile(path);
}

export async function resolveMatrixProvenance(options: {
	clientBinary: string;
	rustServerBinary: string;
	buildDir?: string;
	deps?: Partial<MatrixProvenanceDeps>;
}): Promise<MatrixProvenance> {
	const deps: MatrixProvenanceDeps = {
		candidateSha: currentCandidateSha,
		assertCleanTree,
		buildReferenceBinaries: () => {
			const targetDir = options.buildDir ?? join(process.cwd(), "target");
			execFileSync(
				CONTROLLED_REFERENCE_BUILD_COMMAND[0],
				[...CONTROLLED_REFERENCE_BUILD_COMMAND.slice(1)],
				{
					env: {
						...process.env,
						CARGO_TARGET_DIR: targetDir,
					},
					stdio: "pipe",
				},
			);
			return {
				command: CONTROLLED_REFERENCE_BUILD_COMMAND.join(" "),
				clientBinary: join(targetDir, "release/mmo-client"),
				rustServerBinary: join(targetDir, "release/g6-server"),
			};
		},
		fileExists: existsSync,
		hashFile,
		...options.deps,
	};
	const candidateSha = deps.candidateSha();
	deps.assertCleanTree();
	const build = deps.buildReferenceBinaries() ?? {
		command: CONTROLLED_REFERENCE_BUILD_COMMAND.join(" "),
		clientBinary: join(process.cwd(), "target/release/mmo-client"),
		rustServerBinary: join(process.cwd(), "target/release/g6-server"),
	};
	if (options.clientBinary !== build.clientBinary) {
		throw new Error(
			`g6-attribution: requested client binary ${options.clientBinary} did not match controlled build output ${build.clientBinary}`,
		);
	}
	if (options.rustServerBinary !== build.rustServerBinary) {
		throw new Error(
			`g6-attribution: requested rust server binary ${options.rustServerBinary} did not match controlled build output ${build.rustServerBinary}`,
		);
	}
	for (const path of [build.clientBinary, build.rustServerBinary]) {
		if (!deps.fileExists(path)) {
			throw new Error(
				`g6-attribution: controlled reference build did not produce ${path}`,
			);
		}
	}
	return {
		candidateSha,
		clientBinarySha256: deps.hashFile(build.clientBinary),
		rustServerBinarySha256: deps.hashFile(build.rustServerBinary),
		build,
	};
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function currentCandidateSha(): string {
	return execFileSync("git", ["rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();
}

function assertCleanTree(): void {
	const dirty = execFileSync(
		"git",
		["status", "--porcelain", "--untracked-files=all"],
		{
			encoding: "utf8",
		},
	).trim();
	if (dirty.length > 0) {
		throw new Error("g6-attribution: candidate tree is dirty");
	}
}

function sha256Text(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

function buildTlsBundle(baseDir: string): AttributionTlsBundle {
	const generated = generateLocalhostCert();
	if (!generated) {
		throw new Error(
			"g6-attribution: failed to generate localhost TLS material",
		);
	}
	const certPath = join(baseDir, "g6-attribution-cert.pem");
	const keyPath = join(baseDir, "g6-attribution-key.pem");
	writeFileSync(certPath, generated.certPem);
	writeFileSync(keyPath, generated.keyPem);
	return {
		certPem: generated.certPem,
		keyPem: generated.keyPem,
		certPath,
		keyPath,
		certSha256: sha256Text(generated.certPem),
	};
}

function markdownForAggregate(
	aggregate: AggregateResult,
	legs: Array<{
		lane: AttributionLane;
		orderIndex: number;
		identityLeg: AttributionIdentityLeg;
	}>,
): string {
	const lines = [
		"# G6 Attribution Matrix",
		"",
		`- Schema: \`${aggregate.schema}\``,
		`- Invoked at: \`${aggregate.invokedAt}\``,
		`- Candidate: \`${aggregate.candidateSha}\``,
		`- Client binary sha256: \`${aggregate.clientBinarySha256}\``,
		`- Rust server binary sha256: \`${aggregate.rustServerBinarySha256}\``,
		`- Workload: ${aggregate.plan.sessions} sessions for ${aggregate.plan.durationSec}s, ${aggregate.plan.upstreamAggregatePps} upstream pps, ${aggregate.plan.snapshotAggregatePps} snapshot pps, ${aggregate.plan.ackAggregatePps} ack pps`,
		`- Identity: ${aggregate.identity.valid ? "VALID" : "INVALID"}`,
		`- CPU attribution: ${aggregate.outcome.cpuAttributionAllowed ? "enabled" : "suppressed"}`,
		"",
		"| Order | Lane | Offered Ratio | Issued Ratio | Move Due | Snapshot Due | Ack Due | Raw Stage Mismatch |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const leg of legs) {
		lines.push(
			`| ${leg.orderIndex} | ${leg.lane} | ${leg.identityLeg.clientOfferedRatio.toFixed(3)} | ${leg.identityLeg.issuedRatio.toFixed(3)} | ${leg.identityLeg.clientScheduleTicksDue} | ${leg.identityLeg.serverSnapshotDue} | ${leg.identityLeg.serverAckDue} | ${(leg.identityLeg.comparableStageMismatchPct * 100).toFixed(3)}% |`,
		);
	}
	if (
		aggregate.identity.reasons.length > 0 ||
		aggregate.outcome.reasons.length > 0
	) {
		lines.push("", "## Notes", "");
		for (const reason of [
			...aggregate.identity.reasons,
			...aggregate.outcome.reasons,
		]) {
			lines.push(`- ${reason}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function renderAggregateArtifacts(
	aggregate: AggregateResult,
	legs: Array<{
		lane: AttributionLane;
		orderIndex: number;
		identityLeg: AttributionIdentityLeg;
	}>,
): {
	aggregateJson: string;
	comparisonMarkdown: string;
	profilesJson: string;
} {
	return {
		aggregateJson: `${JSON.stringify(aggregate, null, 2)}\n`,
		comparisonMarkdown: markdownForAggregate(aggregate, legs),
		profilesJson: `${JSON.stringify(aggregate.profiles, null, 2)}\n`,
	};
}

export async function runAttributionMatrixCli(): Promise<AggregateResult> {
	const invokedAt = new Date().toISOString();
	const sessions = parsePositiveInt(process.env.G6_ATTR_SESSIONS, 5000);
	const durationSec = parsePositiveInt(process.env.G6_ATTR_DURATION_SEC, 120);
	const idleSec = parsePositiveInt(process.env.G6_ATTR_IDLE_SEC, 30);
	const drainMs = parsePositiveInt(process.env.G6_ATTR_DRAIN_MS, 1000);
	const basePort = parsePositiveInt(process.env.G6_ATTR_PORT_BASE, 4433);
	const outDir =
		process.env.G6_ATTR_OUT_DIR ??
		mkdtempSync(join(tmpdir(), "g6-attribution-"));
	const clientBinary =
		process.env.G6_ATTR_CLIENT_BIN ??
		join(process.cwd(), "target/release/mmo-client");
	const rustServerBinary =
		process.env.G6_ATTR_RUST_SERVER_BIN ??
		join(process.cwd(), "target/release/g6-server");
	const preRegistrationSha256 = preregistrationSha256();
	const order = buildBalancedLaneOrder().flat();
	const sampleWindowMs = 100;
	const sampleIntervalMs = 100;
	const baselineSamples = await captureHostCpuSamples({
		count: 5,
		sampleWindowMs,
		sampleIntervalMs,
	});
	const idleBand = deriveIdleBand(baselineSamples);
	const settlementDeadlineMs = idleSec * 1000;
	return await withFreshBuildDirectory(async (buildDir) => {
		const clientBuildBinary = join(buildDir, "release/mmo-client");
		const rustBuildBinary = join(buildDir, "release/g6-server");
		const provenance = await resolveMatrixProvenance({
			clientBinary: clientBuildBinary,
			rustServerBinary: rustBuildBinary,
			buildDir,
		});
		return await withAttributionRunContext(
			{ outDir },
			async ({ outDir, tls }) => {
				const manifests: string[] = [];
				const settlements: AggregateResult["settlement"]["afterLegs"] = [];
				const executedLegs: Array<{
					lane: AttributionLane;
					orderIndex: number;
					identityLeg: AttributionIdentityLeg;
				}> = [];
				for (const [index, lane] of order.entries()) {
					const legOutDir = join(
						outDir,
						`leg-${String(index).padStart(2, "0")}-${lane}`,
					);
					ensureDir(legOutDir);
					const manifest = await runAttributionLeg({
						lane,
						orderIndex: index,
						port: basePort + index,
						sessions,
						durationSec,
						idleSec,
						drainMs,
						outDir: legOutDir,
						candidateSha: provenance.candidateSha,
						clientBinary: clientBuildBinary,
						clientBinarySha256: provenance.clientBinarySha256,
						rustServerBinary: rustBuildBinary,
						rustServerBinarySha256: provenance.rustServerBinarySha256,
						tls,
						startedAt: invokedAt,
						preRegistrationSha256,
					});
					const manifestPath = join(
						outDir,
						`${String(index).padStart(2, "0")}-${lane}.json`,
					);
					writeManifest(manifestPath, manifest);
					const evidenceName = portableEvidenceName(outDir, manifestPath);
					manifests.push(evidenceName);
					executedLegs.push({
						lane,
						orderIndex: index,
						identityLeg: manifest.identityLeg,
					});
					const settleSamples = await settleToIdleBand({
						idleBand,
						deadlineMs: settlementDeadlineMs,
						sampleIntervalMs,
						readHostCpu: () => readHostCpuSample(sampleWindowMs),
					});
					settlements.push({ leg: evidenceName, samples: settleSamples });
				}
				const plan = buildSharedAttributionPlan(sessions, durationSec);
				const identity = validateAttributionIdentity(
					executedLegs.map((leg) => leg.identityLeg),
				);
				const outcome = evaluateAttributionOutcome({
					identity,
					legs: executedLegs.map((leg) => leg.identityLeg),
					commonThroughputReplay: null,
				});
				const aggregate: AggregateResult = {
					schema: G6_ATTRIBUTION_SCHEMA,
					invokedAt,
					preRegistration: defaultPreRegistration(preRegistrationSha256),
					plan,
					candidateSha: provenance.candidateSha,
					clientBinarySha256: provenance.clientBinarySha256,
					rustServerBinarySha256: provenance.rustServerBinarySha256,
					legOrder: order,
					legs: manifests,
					provenance: {
						cleanTree: true,
						buildCommand: provenance.build.command,
						freshTargetDir: true,
					},
					settlement: {
						baselineSamples,
						idleBand,
						sampleWindowMs,
						sampleIntervalMs,
						deadlineMs: settlementDeadlineMs,
						afterLegs: settlements,
					},
					identity,
					outcome,
					profiles: {
						available: false,
						reason:
							"profiling was not collected by the same-workload attribution matrix",
					},
				};
				const rendered = renderAggregateArtifacts(aggregate, executedLegs);
				writeFileSync(join(outDir, "aggregate.json"), rendered.aggregateJson);
				writeFileSync(
					join(outDir, "comparison.md"),
					rendered.comparisonMarkdown,
				);
				writeFileSync(join(outDir, "profiles.json"), rendered.profilesJson);
				console.log(
					JSON.stringify({ outDir, aggregate: join(outDir, "aggregate.json") }),
				);
				return aggregate;
			},
		);
	});
}

if (import.meta.main) {
	await runAttributionMatrixCli();
}
