#!/usr/bin/env bun

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
	createServer,
	DEFAULT_LIMITS,
	type MetricsSnapshot,
	type ServerSession,
} from "../../packages/webtransport/src/index.ts";
import { generateLocalhostCert } from "../../packages/webtransport/test/helpers/certs.ts";

const ROOT = process.cwd();
const CLIENT_BIN_RELEASE = `${ROOT}/target/release/load-client`;
const CLIENT_BIN_DEBUG = `${ROOT}/target/debug/load-client`;
const DEFAULT_ARTIFACT_PATH = resolve(
	ROOT,
	".release-evidence/load/distributed-scale-artifact.json",
);
const DEFAULT_CLIENT_TARGET_HOST = "127.0.0.1";
const CHILD_EXIT_TIMEOUT_MS = 30_000;
const CHILD_TERMINATE_GRACE_MS = 2_000;
const CHILD_DRAIN_TIMEOUT_MS = 2_000;
const SERVER_CLOSE_TIMEOUT_MS = 10_000;

export type ScaleWorkloadMode = "probe" | "drain-all" | "single-reader";

export type ClientLaunchConfig = {
	label: string;
	commandPrefix: string[];
	urlHost?: string;
};

export type ScaleCampaignConfig = {
	label: string;
	sessions: number;
	durationSec: number;
	serverCount: number;
	clientCount: number;
	basePort: number;
	datagramsPerSec: number;
	streamsPerSec: number;
	workloadMode: ScaleWorkloadMode;
	minDeliveryRatio: number;
	minSuccessRate: number;
	maxRssMb: number;
	maxRecoveryRssRatio: number;
	maxFairnessGap: number;
	p99HandshakeMs: number;
	p99DatagramEnqueueMs: number;
	p99StreamOpenMs: number;
	minLiveSessions: number;
	minLiveSetHoldMs: number;
	minSourceIdentityCount: number;
	overloadSessionsPerServer: number;
	overloadRecoveryTimeoutMs: number;
	artifactPath: string;
	clientTargetHost?: string;
	clientLaunches?: ClientLaunchConfig[];
};

export type ClientSummary = {
	clientIndex: number;
	serverPort: number;
	requestedSessions: number;
	okSessions: number;
	sessionErrors: number;
	datagramsSent: number;
	datagramErrors: number;
	streamsOpened: number;
	loadStreamsOpened?: number;
	streamErrors: number;
	successRate: number;
	exitCode: number;
	exitSignal: string | null;
	timedOut: boolean;
	forceKilled: boolean;
	stdoutDrainTimedOut: boolean;
	stderrDrainTimedOut: boolean;
	durationMs: number;
	stderr: string;
};

export type BoundedCommandResult = {
	stdout: string;
	stderr: string;
	exitCode: number;
	exitSignal: string | null;
	timedOut: boolean;
	forceKilled: boolean;
	stdoutDrainTimedOut: boolean;
	stderrDrainTimedOut: boolean;
	durationMs: number;
};

function normalizedClientLaunches(
	config: Pick<ScaleCampaignConfig, "clientLaunches" | "clientTargetHost">,
): ClientLaunchConfig[] {
	const fallbackHost =
		config.clientTargetHost?.trim() || DEFAULT_CLIENT_TARGET_HOST;
	const launches = config.clientLaunches ?? [
		{ label: "local", commandPrefix: [] },
	];
	return launches.map((launch, index) => ({
		label: launch.label?.trim() || `launch-${index}`,
		commandPrefix: Array.isArray(launch.commandPrefix)
			? launch.commandPrefix
			: [],
		urlHost: launch.urlHost?.trim() || fallbackHost,
	}));
}

export type FinalGauges = {
	sessionsActive: number;
	sessionTasksActive: number;
	streamTasksActive: number;
	handshakesInFlight: number;
	streamsActive: number;
	queuedBytesGlobal: number;
	rateLimitedCount: number;
	limitExceededCount: number;
};

export type SourceIdentityProof = {
	kind: "server-observed-peer-ip";
	environment: "none-observed" | "loopback-only" | "external-observed";
	identities: string[];
	prefixes: string[];
	sourceIdentityCount: number;
	sourcePrefixCount: number;
};

export type OverloadEvidence = {
	attemptedSessions: number;
	acceptedSessions: number;
	rejectedSessions: number;
	limitExceededDelta: number;
	rateLimitedDelta: number;
	admissionShedCount: number;
	steadyStateBeforeOverload: FinalGauges;
	postOverloadGauges: FinalGauges;
	recoveryDurationMs: number;
};

type RunSummary = {
	label: string;
	sessions: number;
	durationSec: number;
	serverCount: number;
	clientCount: number;
	totalRequestedSessions: number;
	totalOkSessions: number;
	globalSuccessRate: number;
	fairnessGap: number;
	peakLiveSessions: number;
	peakStreams: number;
	peakQueuedBytesGlobal: number;
	peakRssMb: number;
	finalRssMb: number;
	serverDatagramSends: number;
	serverDatagramsReceived: number;
	serverDatagramsReceivedByPort: Record<string, number>;
	serverBidiStreamsOpened: number;
	serverUniStreamsOpened: number;
	serverStreamsAccepted: number;
	serverStreamsAcceptedByPort: Record<string, number>;
	serverDatagramErrors: number;
	serverStreamErrors: number;
	sourceIdentityCount: number;
	sourcePrefixCount: number;
	sourceIdentityProof: SourceIdentityProof;
	liveSetHeldMs: number;
	admissionShedCount: number;
	overloadEvidence: OverloadEvidence;
	overloadClientSummaries: ClientSummary[];
	closeDurationMs: number;
	finalGauges: FinalGauges;
	p99HandshakeMs: number | null;
	p99DatagramEnqueueMs: number | null;
	p99StreamOpenMs: number | null;
	clientSummaries: ClientSummary[];
	failures: string[];
};

type BoundedCommandOptions = {
	cwd?: string;
	env?: Record<string, string>;
	outerTimeoutMs?: number;
	terminateGraceMs?: number;
	drainTimeoutMs?: number;
};

type StreamCaptureController = {
	promise: Promise<{ text: string; ended: boolean }>;
	abort: () => void;
};

async function endWritableProbe(
	writable: Pick<NodeJS.WritableStream, "end" | "once">,
	chunk: Uint8Array,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		writable.once("finish", () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		});
		writable.once("error", (error: Error) => {
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
		writable.end(Buffer.from(chunk));
	});
}

async function exerciseServerStreamProbe(
	session: ServerSession,
	payload: Uint8Array,
	onBidiOpened: () => void,
	onUniOpened: () => void,
): Promise<void> {
	const bidi = await session.createBidirectionalStream();
	onBidiOpened();
	await awaitWithTimeout(
		"server bidi probe",
		endWritableProbe(bidi, payload),
		5000,
	);

	const uni = await session.createUnidirectionalStream();
	onUniOpened();
	await awaitWithTimeout(
		"server uni probe",
		endWritableProbe(uni, payload),
		5000,
	);
}

function normalizeObservedPeerIp(peerIp: string): string {
	const normalized = peerIp
		.trim()
		.replace(/^\[|\]$/g, "")
		.toLowerCase();
	if (normalized.startsWith("::ffff:")) return normalized.slice(7);
	return normalized;
}

function expandIpv6(ip: string): number[] | null {
	const [leftText, rightText] = ip.split("::", 2);
	if (ip.includes("::") && ip.indexOf("::") !== ip.lastIndexOf("::")) {
		return null;
	}
	const left = leftText ? leftText.split(":") : [];
	const right = rightText ? rightText.split(":") : [];
	const missing = 8 - left.length - right.length;
	if (missing < 0 || (!ip.includes("::") && missing !== 0)) return null;
	const groups = [
		...left,
		...Array.from({ length: missing }, () => "0"),
		...right,
	].map((group) => Number.parseInt(group, 16));
	return groups.length === 8 && groups.every((group) => Number.isFinite(group))
		? groups
		: null;
}

function observedPeerPrefix(peerIp: string): string {
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(peerIp)) {
		const octets = peerIp.split(".");
		return `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
	}
	if (peerIp === "::1") return "::1/128";
	const groups = expandIpv6(peerIp);
	if (!groups) return `${peerIp}/unknown`;
	return `${groups
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(":")}::/64`;
}

function isLoopbackPeer(peerIp: string): boolean {
	return peerIp === "::1" || peerIp.startsWith("127.");
}

export function buildSourceIdentityProof(
	serverObservedPeerIps: Iterable<string>,
): SourceIdentityProof {
	const identities = [
		...new Set(
			[...serverObservedPeerIps].map(normalizeObservedPeerIp).filter(Boolean),
		),
	].sort();
	const prefixes = [...new Set(identities.map(observedPeerPrefix))].sort();
	const environment =
		identities.length === 0
			? "none-observed"
			: identities.every(isLoopbackPeer)
				? "loopback-only"
				: "external-observed";
	return {
		kind: "server-observed-peer-ip",
		environment,
		identities,
		prefixes,
		sourceIdentityCount: identities.length,
		sourcePrefixCount: prefixes.length,
	};
}

export function evaluateSourceIdentityProof(
	proof: SourceIdentityProof,
	minimumIdentityCount: number,
): string[] {
	const failures: string[] = [];
	if (proof.sourceIdentityCount < minimumIdentityCount) {
		failures.push(
			`server-observed sourceIdentityCount ${proof.sourceIdentityCount} below required ${minimumIdentityCount}`,
		);
	}
	if (minimumIdentityCount > 1 && proof.environment === "loopback-only") {
		failures.push(
			`server observed ${proof.sourceIdentityCount} loopback-only peer identities; external source addresses are required to prove source diversity`,
		);
	}
	return failures;
}

function recoveredToSteadyBaseline(
	baseline: FinalGauges,
	current: FinalGauges,
): boolean {
	return (
		current.sessionsActive === baseline.sessionsActive &&
		current.sessionTasksActive === baseline.sessionTasksActive &&
		current.streamTasksActive === baseline.streamTasksActive &&
		current.handshakesInFlight === baseline.handshakesInFlight &&
		current.streamsActive === baseline.streamsActive &&
		current.queuedBytesGlobal === baseline.queuedBytesGlobal
	);
}

export async function awaitWithTimeout<T>(
	label: string,
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(`${label} timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

async function nextBeforeDeadline<T>(
	promise: Promise<T>,
	deadlineMs: number,
): Promise<T | null> {
	const remainingMs = deadlineMs - Date.now();
	if (remainingMs <= 0) return null;
	return Promise.race([promise, Bun.sleep(remainingMs).then(() => null)]);
}

async function drainReadableBeforeDeadline(
	readable: ReadableStream<Uint8Array>,
	deadlineMs: number,
): Promise<void> {
	const reader = readable.getReader();
	try {
		while (Date.now() < deadlineMs) {
			const result = await nextBeforeDeadline(reader.read(), deadlineMs);
			if (!result || result.done) break;
		}
	} finally {
		await Promise.race([reader.cancel(), Bun.sleep(100)]).catch(
			() => undefined,
		);
		try {
			reader.releaseLock();
		} catch {
			// A cancelled reader may already have released its lock.
		}
	}
}

async function drainSessionDatagramsBeforeDeadline(
	session: ServerSession,
	deadlineMs: number,
	onDatagram: () => void,
): Promise<void> {
	const iterator = session.incomingDatagrams()[Symbol.asyncIterator]();
	try {
		while (Date.now() < deadlineMs) {
			const result = await nextBeforeDeadline(iterator.next(), deadlineMs);
			if (!result || result.done) break;
			onDatagram();
		}
	} finally {
		await iterator.return?.();
	}
}

async function drainSessionStreamsBeforeDeadline(
	session: ServerSession,
	deadlineMs: number,
	onStream: () => void,
): Promise<void> {
	const drainIncoming = async (
		streams: ReadableStream<
			| {
					readable: ReadableStream<Uint8Array>;
					writable: WritableStream<Uint8Array>;
			  }
			| ReadableStream<Uint8Array>
		>,
	): Promise<void> => {
		const reader = streams.getReader();
		try {
			while (Date.now() < deadlineMs) {
				const result = await nextBeforeDeadline(reader.read(), deadlineMs);
				if (!result || result.done) break;
				onStream();
				const stream = result.value;
				const readable = "readable" in stream ? stream.readable : stream;
				await drainReadableBeforeDeadline(readable, deadlineMs);
			}
		} finally {
			await Promise.race([reader.cancel(), Bun.sleep(100)]).catch(
				() => undefined,
			);
			try {
				reader.releaseLock();
			} catch {
				// A cancelled reader may already have released its lock.
			}
		}
	};

	await Promise.all([
		drainIncoming(session.incomingBidirectionalStreams),
		drainIncoming(session.incomingUnidirectionalStreams),
	]);
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
	if (process.platform === "win32") {
		const args =
			signal === "SIGTERM"
				? ["/pid", String(pid), "/t"]
				: ["/pid", String(pid), "/t", "/f"];
		const result = spawnSync("taskkill", args, {
			cwd: ROOT,
			stdio: "ignore",
		});
		return result.status === 0;
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
	let forceKilled = false;
	signalProcessGroup(pid, "SIGTERM");
	const exitedAfterTerm =
		(await Promise.race([
			exitPromise.then(() => true),
			Bun.sleep(terminateGraceMs).then(() => false),
		])) === true;
	if (exitedAfterTerm) return false;
	signalProcessGroup(pid, "SIGKILL");
	forceKilled = true;
	await Promise.race([exitPromise, Bun.sleep(terminateGraceMs)]);
	return forceKilled;
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

export async function runCommandWithBoundedOutput(
	command: string[],
	options: BoundedCommandOptions = {},
): Promise<BoundedCommandResult> {
	const startedAt = performance.now();
	const child = spawn(command[0] ?? "", command.slice(1), {
		cwd: options.cwd ?? ROOT,
		env: { ...process.env, ...options.env },
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	const stdoutCapture = captureReadable(child.stdout);
	const stderrCapture = captureReadable(child.stderr);
	const exitPromise = new Promise<{
		code: number | null;
		signal: string | null;
	}>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			resolve({ code, signal });
		});
	});

	const outerTimeoutMs = options.outerTimeoutMs ?? CHILD_EXIT_TIMEOUT_MS;
	const terminateGraceMs = options.terminateGraceMs ?? CHILD_TERMINATE_GRACE_MS;
	const drainTimeoutMs = options.drainTimeoutMs ?? CHILD_DRAIN_TIMEOUT_MS;
	let timedOut = false;
	let forceKilled = false;
	let exit = await Promise.race([
		exitPromise.then((value) => ({ kind: "exit" as const, value })),
		Bun.sleep(outerTimeoutMs).then(() => ({ kind: "timeout" as const })),
	]);
	if (exit.kind === "timeout") {
		timedOut = true;
		forceKilled = await terminateProcessTree(
			child.pid ?? 0,
			exitPromise,
			terminateGraceMs,
		);
		// Bounded exit contract: awaitWithTimeout("child.exited", ...) — a child
		// that survives SIGKILL must not hang the campaign; report it as killed.
		exit = {
			kind: "exit",
			value: await awaitWithTimeout(
				"child.exited",
				exitPromise,
				Math.max(terminateGraceMs, 1),
			).catch(() => ({ code: -1, signal: "SIGKILL" })),
		};
	}

	let stdoutResult = await awaitCaptureWithinTimeout(
		stdoutCapture,
		drainTimeoutMs,
	);
	let stderrResult = await awaitCaptureWithinTimeout(
		stderrCapture,
		drainTimeoutMs,
	);
	if (stdoutResult.timedOut || stderrResult.timedOut) {
		timedOut = true;
		forceKilled =
			(await reapPipeHolders(child.pid ?? 0, terminateGraceMs)) || forceKilled;
		// Re-drain whatever the reaped holders released, but PRESERVE the
		// drain-timeout flag — the settled controller resolves instantly with
		// timedOut:false on the second await, which must not mask the first.
		stdoutResult = stdoutResult.timedOut
			? {
					...(await awaitCaptureWithinTimeout(stdoutCapture, 0)),
					timedOut: true,
				}
			: stdoutResult;
		stderrResult = stderrResult.timedOut
			? {
					...(await awaitCaptureWithinTimeout(stderrCapture, 0)),
					timedOut: true,
				}
			: stderrResult;
	}

	return {
		stdout: stdoutResult.text,
		stderr: stderrResult.text,
		exitCode: exit.value.code ?? -1,
		exitSignal: exit.value.signal,
		timedOut,
		forceKilled,
		stdoutDrainTimedOut: stdoutResult.timedOut,
		stderrDrainTimedOut: stderrResult.timedOut,
		durationMs: Number((performance.now() - startedAt).toFixed(3)),
	};
}

export function validateScaleCampaignConfig(
	config: ScaleCampaignConfig,
): string[] {
	const failures: string[] = [];
	const integerFields = [
		["sessions", config.sessions],
		["durationSec", config.durationSec],
		["serverCount", config.serverCount],
		["clientCount", config.clientCount],
		["basePort", config.basePort],
		["minLiveSessions", config.minLiveSessions],
		["minLiveSetHoldMs", config.minLiveSetHoldMs],
		["minSourceIdentityCount", config.minSourceIdentityCount],
		["overloadSessionsPerServer", config.overloadSessionsPerServer],
		["overloadRecoveryTimeoutMs", config.overloadRecoveryTimeoutMs],
	] as const;
	for (const [name, value] of integerFields) {
		if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
			failures.push(`${name} must be a finite integer greater than 0`);
		}
	}
	for (const [name, value] of [
		["datagramsPerSec", config.datagramsPerSec],
		["streamsPerSec", config.streamsPerSec],
	] as const) {
		if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
			failures.push(
				`${name} must be a finite integer greater than or equal to 0`,
			);
		}
	}
	if (config.datagramsPerSec === 0 && config.streamsPerSec === 0) {
		failures.push("datagramsPerSec or streamsPerSec must be greater than 0");
	}
	if (
		!(
			"probe" === config.workloadMode ||
			"drain-all" === config.workloadMode ||
			"single-reader" === config.workloadMode
		)
	) {
		failures.push("workloadMode must be probe, drain-all, or single-reader");
	}
	const numberFields = [
		["minSuccessRate", config.minSuccessRate],
		["maxRssMb", config.maxRssMb],
		["maxRecoveryRssRatio", config.maxRecoveryRssRatio],
		["maxFairnessGap", config.maxFairnessGap],
		["p99HandshakeMs", config.p99HandshakeMs],
		["p99DatagramEnqueueMs", config.p99DatagramEnqueueMs],
		["p99StreamOpenMs", config.p99StreamOpenMs],
	] as const;
	for (const [name, value] of numberFields) {
		if (!Number.isFinite(value) || value <= 0) {
			failures.push(`${name} must be a finite number greater than 0`);
		}
	}
	if (
		!Number.isFinite(config.minDeliveryRatio) ||
		config.minDeliveryRatio <= 0 ||
		config.minDeliveryRatio > 1
	) {
		failures.push(
			"minDeliveryRatio must be a finite number greater than 0 and at most 1",
		);
	}
	const clientTargetHost =
		config.clientTargetHost?.trim() ?? DEFAULT_CLIENT_TARGET_HOST;
	if (!clientTargetHost) {
		failures.push("clientTargetHost must be a non-empty host name or IP");
	}
	const launches = normalizedClientLaunches(config);
	if (launches.length === 0) {
		failures.push("clientLaunches must contain at least one launch definition");
	}
	for (const launch of launches) {
		if (!launch.label.trim()) {
			failures.push("clientLaunches entries must have a non-empty label");
		}
		if (!Array.isArray(launch.commandPrefix)) {
			failures.push(
				`client launch ${launch.label} commandPrefix must be an array`,
			);
		}
	}
	return failures;
}

export function evaluateWorkloadEvidence(input: {
	datagramsPerSec: number;
	streamsPerSec: number;
	workloadMode?: ScaleWorkloadMode;
	minDeliveryRatio?: number;
	clientSummaries: ClientSummary[];
	serverDatagramSends: number;
	serverDatagramsReceived?: number;
	serverDatagramsReceivedByPort?: Record<string, number>;
	serverBidiStreamsOpened: number;
	serverUniStreamsOpened: number;
	serverStreamsAccepted?: number;
	serverStreamsAcceptedByPort?: Record<string, number>;
	serverDatagramErrors: number;
	serverStreamErrors: number;
	p99HandshakeMs: number | null;
	p99DatagramEnqueueMs: number | null;
	p99StreamOpenMs: number | null;
}): string[] {
	const failures: string[] = [];
	const workloadMode = input.workloadMode ?? "probe";
	const minDeliveryRatio = input.minDeliveryRatio ?? 0.95;
	const totalDatagrams = input.clientSummaries.reduce(
		(sum, summary) => sum + summary.datagramsSent,
		0,
	);
	const totalStreams = input.clientSummaries.reduce(
		(sum, summary) =>
			sum + (summary.loadStreamsOpened ?? summary.streamsOpened),
		0,
	);
	if (input.p99HandshakeMs == null) {
		failures.push("missing handshake p99 evidence");
	}
	if (input.datagramsPerSec > 0 && totalDatagrams <= 0) {
		failures.push(
			"workload did not send any datagrams despite a positive datagram rate target",
		);
	}
	if (input.datagramsPerSec > 0 && input.serverDatagramSends <= 0) {
		failures.push(
			"server workload did not send any datagrams despite a positive datagram rate target",
		);
	}
	if (workloadMode === "drain-all" && input.datagramsPerSec > 0) {
		const received = input.serverDatagramsReceived ?? 0;
		const ratio = received / Math.max(totalDatagrams, 1);
		if (ratio < minDeliveryRatio) {
			failures.push(
				`server datagram delivery ratio ${ratio.toFixed(4)} fell below ${minDeliveryRatio.toFixed(4)}`,
			);
		}
		const expectedByPort = input.clientSummaries.reduce<Record<string, number>>(
			(counts, summary) => {
				const port = String(summary.serverPort);
				counts[port] = (counts[port] ?? 0) + summary.datagramsSent;
				return counts;
			},
			{},
		);
		for (const [port, expected] of Object.entries(expectedByPort)) {
			if (expected <= 0) continue;
			const actual = input.serverDatagramsReceivedByPort?.[port] ?? 0;
			const perServerRatio = actual / expected;
			if (perServerRatio < minDeliveryRatio) {
				failures.push(
					`server datagram delivery ratio for port ${port} ${perServerRatio.toFixed(4)} fell below ${minDeliveryRatio.toFixed(4)}`,
				);
			}
		}
	}
	if (input.streamsPerSec > 0 && totalStreams <= 0) {
		failures.push(
			"workload did not open any streams despite a positive stream rate target",
		);
	}
	if (input.streamsPerSec > 0 && input.serverBidiStreamsOpened <= 0) {
		failures.push(
			"server workload did not open any bidirectional streams despite a positive stream rate target",
		);
	}
	if (input.streamsPerSec > 0 && input.serverUniStreamsOpened <= 0) {
		failures.push(
			"server workload did not open any unidirectional streams despite a positive stream rate target",
		);
	}
	if (workloadMode === "drain-all" && input.streamsPerSec > 0) {
		const accepted = input.serverStreamsAccepted ?? 0;
		const ratio = accepted / Math.max(totalStreams, 1);
		if (ratio < minDeliveryRatio) {
			failures.push(
				`server stream delivery ratio ${ratio.toFixed(4)} fell below ${minDeliveryRatio.toFixed(4)}`,
			);
		}
		const expectedByPort = input.clientSummaries.reduce<Record<string, number>>(
			(counts, summary) => {
				const port = String(summary.serverPort);
				counts[port] =
					(counts[port] ?? 0) +
					(summary.loadStreamsOpened ?? summary.streamsOpened);
				return counts;
			},
			{},
		);
		for (const [port, expected] of Object.entries(expectedByPort)) {
			if (expected <= 0) continue;
			const actual = input.serverStreamsAcceptedByPort?.[port] ?? 0;
			const perServerRatio = actual / expected;
			if (perServerRatio < minDeliveryRatio) {
				failures.push(
					`server stream delivery ratio for port ${port} ${perServerRatio.toFixed(4)} fell below ${minDeliveryRatio.toFixed(4)}`,
				);
			}
		}
	}
	if (input.serverDatagramErrors > 0) {
		failures.push(
			`server workload observed ${input.serverDatagramErrors} datagram exercise errors`,
		);
	}
	if (input.serverStreamErrors > 0) {
		failures.push(
			`server workload observed ${input.serverStreamErrors} stream exercise errors`,
		);
	}
	return failures;
}

export function evaluateOverloadEvidence(evidence: OverloadEvidence): string[] {
	const failures: string[] = [];
	if (evidence.rejectedSessions <= 0) {
		failures.push("overload phase did not reject any admission");
	}
	if (evidence.acceptedSessions > 0) {
		failures.push("overload phase admitted sessions beyond the configured cap");
	}
	if (
		evidence.admissionShedCount <= 0 ||
		evidence.limitExceededDelta + evidence.rateLimitedDelta <= 0
	) {
		failures.push(
			"overload phase produced no limit/rate admission-shed evidence",
		);
	}
	if (
		!recoveredToSteadyBaseline(
			evidence.steadyStateBeforeOverload,
			evidence.postOverloadGauges,
		)
	) {
		failures.push(
			"overload phase did not recover to its steady-state gauge baseline",
		);
	}
	return failures;
}

function rustcVersion() {
	const result = spawnSync("rustc", ["-V"], { cwd: ROOT, encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : null;
}

function sourceMetadata() {
	const gitValue = (args: string[]) => {
		const result = spawnSync("git", args, {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return result.status === 0 ? result.stdout.trim() : null;
	};
	return {
		sha: gitValue(["rev-parse", "HEAD"]),
		branch: gitValue(["branch", "--show-current"]),
		commandLine: process.argv.join(" "),
	};
}

function getRssMb() {
	return process.memoryUsage().rss / (1024 * 1024);
}

function percentileFromHistogram(
	snapshot: MetricsSnapshot[keyof Pick<
		MetricsSnapshot,
		"handshakeLatency" | "datagramEnqueueLatency" | "streamOpenLatency"
	>],
	percentile: number,
) {
	if (!snapshot || snapshot.count <= 0) return null;
	const target = snapshot.count * percentile;
	for (let i = 0; i < snapshot.cumulativeCount.length; i++) {
		const cumulative = snapshot.cumulativeCount[i];
		const upperSecs = snapshot.le[i];
		if (cumulative == null || upperSecs == null) {
			continue;
		}
		if (cumulative >= target) {
			return Number((upperSecs * 1000).toFixed(3));
		}
	}
	return null;
}

function aggregateGauges(snapshots: MetricsSnapshot[]): FinalGauges {
	return snapshots.reduce<FinalGauges>(
		(sum, snapshot) => ({
			sessionsActive: sum.sessionsActive + snapshot.sessionsActive,
			sessionTasksActive: sum.sessionTasksActive + snapshot.sessionTasksActive,
			streamTasksActive: sum.streamTasksActive + snapshot.streamTasksActive,
			handshakesInFlight: sum.handshakesInFlight + snapshot.handshakesInFlight,
			streamsActive: sum.streamsActive + snapshot.streamsActive,
			queuedBytesGlobal: sum.queuedBytesGlobal + snapshot.queuedBytesGlobal,
			rateLimitedCount: sum.rateLimitedCount + snapshot.rateLimitedCount,
			limitExceededCount: sum.limitExceededCount + snapshot.limitExceededCount,
		}),
		{
			sessionsActive: 0,
			sessionTasksActive: 0,
			streamTasksActive: 0,
			handshakesInFlight: 0,
			streamsActive: 0,
			queuedBytesGlobal: 0,
			rateLimitedCount: 0,
			limitExceededCount: 0,
		},
	);
}

function parseLoadClientOutput(
	result: BoundedCommandResult,
	clientIndex: number,
	serverPort: number,
	requestedSessions: number,
): ClientSummary {
	const stdout = result.stdout;
	const stderr = result.stderr;
	const sessions = stdout.match(/sessions ok=(\d+) err=(\d+)/);
	const datagrams = stdout.match(/datagrams sent=(\d+) err=(\d+)/);
	const streams = stdout.match(/streams opened=(\d+) err=(\d+)/);
	const okSessions = sessions ? Number(sessions[1]) : 0;
	const sessionErrors = sessions ? Number(sessions[2]) : requestedSessions;
	const datagramsSent = datagrams ? Number(datagrams[1]) : 0;
	const datagramErrors = datagrams ? Number(datagrams[2]) : 0;
	const streamsOpened = streams ? Number(streams[1]) : 0;
	const loadStreams = stdout.match(/load streams opened=(\d+)/);
	const streamErrors = streams ? Number(streams[2]) : 0;
	return {
		clientIndex,
		serverPort,
		requestedSessions,
		okSessions,
		sessionErrors,
		datagramsSent,
		datagramErrors,
		streamsOpened,
		loadStreamsOpened: loadStreams ? Number(loadStreams[1]) : undefined,
		streamErrors,
		successRate: requestedSessions === 0 ? 0 : okSessions / requestedSessions,
		exitCode: result.exitCode,
		exitSignal: result.exitSignal,
		timedOut: result.timedOut,
		forceKilled: result.forceKilled,
		stdoutDrainTimedOut: result.stdoutDrainTimedOut,
		stderrDrainTimedOut: result.stderrDrainTimedOut,
		durationMs: result.durationMs,
		stderr,
	};
}

async function ensureClientBinary() {
	let clientBin = CLIENT_BIN_RELEASE;
	if (!existsSync(clientBin) && existsSync(CLIENT_BIN_DEBUG)) {
		clientBin = CLIENT_BIN_DEBUG;
	}
	if (existsSync(clientBin)) {
		return clientBin;
	}
	const proc = Bun.spawn(
		["cargo", "build", "-p", "reference", "--bin", "load-client"],
		{
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, CARGO_TARGET_DIR: `${ROOT}/target` },
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(
			`cargo build -p reference --bin load-client exited ${exitCode}\n${stdout}\n${stderr}`,
		);
	}
	if (!existsSync(CLIENT_BIN_DEBUG)) {
		throw new Error(
			"load-client build reported success but target/debug/load-client is missing",
		);
	}
	return CLIENT_BIN_DEBUG;
}

type ClientPlan = {
	clientIndex: number;
	serverIndex: number;
	serverPort: number;
	requestedSessions: number;
	launch: ClientLaunchConfig;
};

function buildMainClientPlans(config: ScaleCampaignConfig): ClientPlan[] {
	const launches = normalizedClientLaunches(config);
	const baseSessions = Math.floor(config.sessions / config.clientCount);
	const remainder = config.sessions % config.clientCount;
	return Array.from({ length: config.clientCount }, (_, clientIndex) => ({
		clientIndex,
		serverIndex: clientIndex % config.serverCount,
		serverPort: config.basePort + (clientIndex % config.serverCount),
		requestedSessions: baseSessions + (clientIndex < remainder ? 1 : 0),
		launch: launches[clientIndex % launches.length] ?? {
			label: `client-${clientIndex}`,
			commandPrefix: [],
		},
	})).filter((plan) => plan.requestedSessions > 0);
}

async function runLoadClient(
	clientBin: string,
	plan: ClientPlan,
	options: {
		durationSec: number;
		datagramsPerSec: number;
		streamsPerSec: number;
		maxSessionErrors: number;
		skipProbes?: boolean;
	},
): Promise<ClientSummary> {
	const targetHost = plan.launch.urlHost?.trim() || DEFAULT_CLIENT_TARGET_HOST;
	const command = [
		...plan.launch.commandPrefix,
		clientBin,
		"--url",
		`https://${targetHost}:${plan.serverPort}`,
		"--sessions",
		String(plan.requestedSessions),
		"--duration",
		String(options.durationSec),
		"--datagrams-per-sec",
		String(options.datagramsPerSec),
		"--streams-per-sec",
		String(options.streamsPerSec),
		"--max-session-errors",
		String(options.maxSessionErrors),
		"--max-datagram-errors",
		"0",
		"--max-stream-errors",
		"0",
		...(options.skipProbes ? ["--skip-probes"] : []),
	];
	const result = await runCommandWithBoundedOutput(command, {
		cwd: ROOT,
		env: { RUST_BACKTRACE: "1" },
		outerTimeoutMs: CHILD_EXIT_TIMEOUT_MS,
		terminateGraceMs: CHILD_TERMINATE_GRACE_MS,
		drainTimeoutMs: CHILD_DRAIN_TIMEOUT_MS,
	});
	return parseLoadClientOutput(
		result,
		plan.clientIndex,
		plan.serverPort,
		plan.requestedSessions,
	);
}

function currentGauges(
	servers: Array<ReturnType<typeof createServer>>,
): FinalGauges {
	return aggregateGauges(servers.map((server) => server.metricsSnapshot()));
}

async function waitForGauges(
	servers: Array<ReturnType<typeof createServer>>,
	timeoutMs: number,
	predicate: (gauges: FinalGauges) => boolean,
): Promise<FinalGauges> {
	const deadline = Date.now() + timeoutMs;
	let gauges = currentGauges(servers);
	while (!predicate(gauges) && Date.now() < deadline) {
		await Bun.sleep(100);
		gauges = currentGauges(servers);
	}
	return gauges;
}

function emptyOverloadEvidence(gauges: FinalGauges): OverloadEvidence {
	return {
		attemptedSessions: 0,
		acceptedSessions: 0,
		rejectedSessions: 0,
		limitExceededDelta: 0,
		rateLimitedDelta: 0,
		admissionShedCount: 0,
		steadyStateBeforeOverload: gauges,
		postOverloadGauges: gauges,
		recoveryDurationMs: 0,
	};
}

async function runOverloadPhase(
	config: ScaleCampaignConfig,
	clientBin: string,
	servers: Array<ReturnType<typeof createServer>>,
	serverSessionCaps: number[],
): Promise<{
	evidence: OverloadEvidence;
	clientSummaries: ClientSummary[];
	failures: string[];
}> {
	const overloadLaunches = normalizedClientLaunches(config);
	const steadyState = await waitForGauges(
		servers,
		Math.max(10_000, config.durationSec * 1_000),
		(gauges) => gauges.sessionsActive >= config.sessions,
	);
	if (steadyState.sessionsActive < config.sessions) {
		return {
			evidence: emptyOverloadEvidence(steadyState),
			clientSummaries: [],
			failures: [
				`overload phase could not start because steady sessions ${steadyState.sessionsActive} never reached configured capacity ${config.sessions}`,
			],
		};
	}

	const plans = serverSessionCaps
		.map((sessionCap, serverIndex) => ({
			clientIndex: config.clientCount + serverIndex,
			serverIndex,
			serverPort: config.basePort + serverIndex,
			requestedSessions: sessionCap > 0 ? config.overloadSessionsPerServer : 0,
			launch: overloadLaunches[serverIndex % overloadLaunches.length] ?? {
				label: `overload-${serverIndex}`,
				commandPrefix: [],
			},
		}))
		.filter((plan) => plan.requestedSessions > 0);
	const overloadDurationSec = Math.max(
		1,
		Math.min(5, Math.floor(config.durationSec / 4)),
	);
	const clientSummaries = await Promise.all(
		plans.map((plan) =>
			runLoadClient(clientBin, plan, {
				durationSec: overloadDurationSec,
				datagramsPerSec: 0,
				streamsPerSec: 0,
				maxSessionErrors: plan.requestedSessions,
				skipProbes: true,
			}),
		),
	);
	const afterAttempts = currentGauges(servers);
	const limitExceededDelta = Math.max(
		0,
		afterAttempts.limitExceededCount - steadyState.limitExceededCount,
	);
	const rateLimitedDelta = Math.max(
		0,
		afterAttempts.rateLimitedCount - steadyState.rateLimitedCount,
	);
	const recoveryStartedAt = performance.now();
	const postOverloadGauges = await waitForGauges(
		servers,
		config.overloadRecoveryTimeoutMs,
		(gauges) => recoveredToSteadyBaseline(steadyState, gauges),
	);
	const acceptedSessions = clientSummaries.reduce(
		(sum, summary) => sum + summary.okSessions,
		0,
	);
	const rejectedSessions = clientSummaries.reduce(
		(sum, summary) => sum + summary.sessionErrors,
		0,
	);
	const attemptedSessions = plans.reduce(
		(sum, plan) => sum + plan.requestedSessions,
		0,
	);
	return {
		evidence: {
			attemptedSessions,
			acceptedSessions,
			rejectedSessions,
			limitExceededDelta,
			rateLimitedDelta,
			admissionShedCount: limitExceededDelta + rateLimitedDelta,
			steadyStateBeforeOverload: steadyState,
			postOverloadGauges,
			recoveryDurationMs: Number(
				(performance.now() - recoveryStartedAt).toFixed(3),
			),
		},
		clientSummaries,
		failures: [],
	};
}

async function runOneCampaign(
	config: ScaleCampaignConfig,
): Promise<RunSummary> {
	const clientBin = await ensureClientBinary();
	const cert = generateLocalhostCert();
	if (!cert) {
		throw new Error("distributed-scale: failed to generate localhost TLS cert");
	}
	const configFailures = validateScaleCampaignConfig(config);
	if (configFailures.length > 0) {
		throw new Error(configFailures.join("\n"));
	}

	const failures: string[] = [];
	const mainClientPlans = buildMainClientPlans(config);
	const serverSessionCaps = Array.from(
		{ length: config.serverCount },
		(_, serverIndex) =>
			mainClientPlans
				.filter((plan) => plan.serverIndex === serverIndex)
				.reduce((sum, plan) => sum + plan.requestedSessions, 0),
	);
	const servers: ReturnType<typeof createServer>[] = [];
	const serverObservedPeerIps = new Set<string>();
	const initialRssMb = getRssMb();
	let peakRssMb = initialRssMb;
	let peakLiveSessions = 0;
	let peakStreams = 0;
	let peakQueuedBytesGlobal = 0;
	let serverDatagramSends = 0;
	let serverDatagramsReceived = 0;
	const serverDatagramsReceivedByPort: Record<string, number> = {};
	let serverBidiStreamsOpened = 0;
	let serverUniStreamsOpened = 0;
	let serverStreamsAccepted = 0;
	const serverStreamsAcceptedByPort: Record<string, number> = {};
	let serverDatagramErrors = 0;
	let serverStreamErrors = 0;
	let liveSetHeldMs = 0;
	let liveSetStartedAt: number | null = null;
	let finalGauges: FinalGauges = aggregateGauges([]);
	let serversClosed = false;
	const drainTasks: Promise<void>[] = [];

	try {
		for (let i = 0; i < config.serverCount; i++) {
			const port = config.basePort + i;
			const sessionCap = serverSessionCaps[i] ?? 0;
			let serverDatagramProbeDone = false;
			let serverStreamProbeDone = false;
			servers.push(
				createServer({
					port,
					tls: { certPem: cert.certPem, keyPem: cert.keyPem },
					limits: {
						maxSessions: Math.max(sessionCap, 1),
						maxHandshakesInFlight: Math.max(
							sessionCap + config.overloadSessionsPerServer,
							256,
						),
					},
					rateLimits: {
						handshakesPerSec: Math.max(sessionCap * 2, 500),
						handshakesBurst: Math.max(sessionCap * 4, 1_000),
						handshakesBurstPerPrefix: Math.max(sessionCap * 4, 1_000),
						streamsPerSec: Math.max(sessionCap * 4, 1_000),
						streamsBurst: Math.max(sessionCap * 8, 2_000),
						datagramsPerSec: Math.max(sessionCap * 20, 10_000),
						datagramsBurst: Math.max(sessionCap * 40, 20_000),
					},
					onSession: (session) => {
						serverObservedPeerIps.add(session.peer.ip);
						const portKey = String(port);
						const countDatagram = () => {
							serverDatagramsReceived += 1;
							serverDatagramsReceivedByPort[portKey] =
								(serverDatagramsReceivedByPort[portKey] ?? 0) + 1;
						};
						const countStream = () => {
							serverStreamsAccepted += 1;
							serverStreamsAcceptedByPort[portKey] =
								(serverStreamsAcceptedByPort[portKey] ?? 0) + 1;
						};
						const drainDeadline =
							Date.now() + Math.max(5_000, config.durationSec * 1_000 + 5_000);
						let sessionDatagramProbeSent = false;
						if (
							config.datagramsPerSec > 0 &&
							(config.workloadMode === "drain-all" ||
								(config.workloadMode === "single-reader" &&
									!serverDatagramProbeDone))
						) {
							serverDatagramProbeDone = true;
							const task = (async () => {
								const iterator = session
									.incomingDatagrams()
									[Symbol.asyncIterator]();
								try {
									while (Date.now() < drainDeadline) {
										const result = await nextBeforeDeadline(
											iterator.next(),
											drainDeadline,
										);
										if (!result || result.done) break;
										countDatagram();
										if (!sessionDatagramProbeSent) {
											const data = result.value;
											await session.sendDatagram(data);
											serverDatagramSends += 1;
											sessionDatagramProbeSent = true;
										}
									}
								} finally {
									await iterator.return?.();
								}
							})();
							drainTasks.push(task);
							task.catch((error) => {
								serverDatagramErrors += 1;
								failures.push(
									`server datagram exercise failed on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
								);
							});
						}
						if (
							config.workloadMode === "drain-all" &&
							config.streamsPerSec > 0
						) {
							const task = drainSessionStreamsBeforeDeadline(
								session,
								drainDeadline,
								countStream,
							);
							drainTasks.push(task);
							task.catch((error) => {
								serverStreamErrors += 1;
								failures.push(
									`server stream drain failed on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
								);
							});
						}
						if (config.workloadMode === "probe" && config.datagramsPerSec > 0) {
							const task = (async () => {
								const iterator = session
									.incomingDatagrams()
									[Symbol.asyncIterator]();
								try {
									const result = await nextBeforeDeadline(
										iterator.next(),
										drainDeadline,
									);
									if (!result || result.done) return;
									countDatagram();
									const data = result.value;
									await session.sendDatagram(data);
									serverDatagramSends += 1;
								} finally {
									await iterator.return?.();
								}
							})();
							drainTasks.push(task);
							task.catch((error) => {
								serverDatagramErrors += 1;
								failures.push(
									`server datagram exercise failed on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
								);
							});
						}
						const shouldRunStreamProbe =
							config.streamsPerSec > 0 &&
							(config.workloadMode === "probe" || !serverStreamProbeDone);
						if (shouldRunStreamProbe) {
							if (config.workloadMode !== "probe") {
								serverStreamProbeDone = true;
							}
							const task = exerciseServerStreamProbe(
								session,
								new TextEncoder().encode(`server-probe:${port}`),
								() => {
									serverBidiStreamsOpened += 1;
								},
								() => {
									serverUniStreamsOpened += 1;
								},
							);
							drainTasks.push(task);
							task.catch((error) => {
								serverStreamErrors += 1;
								failures.push(
									`server stream exercise failed on port ${port}: ${error instanceof Error ? error.message : String(error)}`,
								);
							});
						}
					},
				}),
			);
		}

		await Bun.sleep(1_500);

		let polling = true;
		const poller = (async () => {
			while (polling) {
				const snapshots = servers.map((server) => server.metricsSnapshot());
				const gauges = aggregateGauges(snapshots);
				finalGauges = gauges;
				peakLiveSessions = Math.max(peakLiveSessions, gauges.sessionsActive);
				peakStreams = Math.max(peakStreams, gauges.streamsActive);
				peakQueuedBytesGlobal = Math.max(
					peakQueuedBytesGlobal,
					gauges.queuedBytesGlobal,
				);
				peakRssMb = Math.max(peakRssMb, getRssMb());
				if (gauges.sessionsActive >= config.minLiveSessions) {
					if (liveSetStartedAt == null) {
						liveSetStartedAt = Date.now();
					}
					liveSetHeldMs = Math.max(
						liveSetHeldMs,
						Date.now() - liveSetStartedAt,
					);
				} else {
					liveSetStartedAt = null;
				}

				for (const server of servers) {
					const snapshot = server.metricsSnapshot();
					if (
						snapshot.queuedBytesGlobal > DEFAULT_LIMITS.maxQueuedBytesGlobal
					) {
						failures.push(
							`queuedBytesGlobal exceeded authoritative default limit on port ${server.address.port}: ${snapshot.queuedBytesGlobal}`,
						);
					}
					if (
						[
							snapshot.sessionsActive,
							snapshot.sessionTasksActive,
							snapshot.streamTasksActive,
							snapshot.streamsActive,
							snapshot.queuedBytesGlobal,
							snapshot.rateLimitedCount,
							snapshot.limitExceededCount,
						].some((value) => !Number.isFinite(value) || value < 0)
					) {
						failures.push(
							`non-finite or negative counter observed on port ${server.address.port}`,
						);
					}
				}
				await Bun.sleep(1_000);
			}
		})();

		const clientPromise = Promise.all(
			mainClientPlans.map((plan) =>
				runLoadClient(clientBin, plan, {
					durationSec: config.durationSec,
					datagramsPerSec: config.datagramsPerSec,
					streamsPerSec: config.streamsPerSec,
					maxSessionErrors: 0,
					skipProbes: config.workloadMode !== "probe",
				}),
			),
		);
		const overloadPromise = runOverloadPhase(
			config,
			clientBin,
			servers,
			serverSessionCaps,
		);
		const [clientSummaries, overloadResult] = await Promise.all([
			clientPromise,
			overloadPromise,
		]);
		polling = false;
		await poller;
		failures.push(...overloadResult.failures);
		failures.push(...evaluateOverloadEvidence(overloadResult.evidence));

		const totalRequestedSessions = clientSummaries.reduce(
			(sum, summary) => sum + summary.requestedSessions,
			0,
		);
		const totalOkSessions = clientSummaries.reduce(
			(sum, summary) => sum + summary.okSessions,
			0,
		);
		const globalSuccessRate =
			totalRequestedSessions === 0
				? 0
				: totalOkSessions / totalRequestedSessions;
		const rates = clientSummaries.map((summary) => summary.successRate);
		const fairnessGap =
			rates.length === 0 ? 0 : Math.max(...rates) - Math.min(...rates);
		const sourceIdentityProof = buildSourceIdentityProof(serverObservedPeerIps);
		const { sourceIdentityCount, sourcePrefixCount } = sourceIdentityProof;
		const { admissionShedCount } = overloadResult.evidence;

		for (const summary of clientSummaries) {
			if (summary.exitCode !== 0) {
				failures.push(
					`load-client ${summary.clientIndex} against ${summary.serverPort} exited ${summary.exitCode}: ${summary.stderr || "no stderr"}`,
				);
			}
			if (summary.okSessions === 0) {
				failures.push(
					`load-client ${summary.clientIndex} on ${summary.serverPort} established zero sessions`,
				);
			}
			if (summary.datagramErrors > 0 || summary.streamErrors > 0) {
				failures.push(
					`load-client ${summary.clientIndex} on ${summary.serverPort} reported datagramErrors=${summary.datagramErrors} streamErrors=${summary.streamErrors}`,
				);
			}
		}

		if (globalSuccessRate < config.minSuccessRate) {
			failures.push(
				`global success rate ${globalSuccessRate.toFixed(4)} below required ${config.minSuccessRate.toFixed(4)}`,
			);
		}
		if (fairnessGap > config.maxFairnessGap) {
			failures.push(
				`fairness gap ${fairnessGap.toFixed(4)} exceeded ${config.maxFairnessGap.toFixed(4)}`,
			);
		}
		failures.push(
			...evaluateSourceIdentityProof(
				sourceIdentityProof,
				config.minSourceIdentityCount,
			),
		);
		if (peakLiveSessions < config.minLiveSessions) {
			failures.push(
				`peakLiveSessions ${peakLiveSessions} below required ${config.minLiveSessions}`,
			);
		}
		if (liveSetHeldMs < config.minLiveSetHoldMs) {
			failures.push(
				`liveSetHeldMs ${liveSetHeldMs} below required ${config.minLiveSetHoldMs}`,
			);
		}
		if (peakRssMb > config.maxRssMb) {
			failures.push(
				`peak RSS ${peakRssMb.toFixed(2)}MB exceeded cap ${config.maxRssMb.toFixed(2)}MB`,
			);
		}

		const preCloseSnapshots = servers.map((server) => server.metricsSnapshot());
		const p99HandshakeMs = preCloseSnapshots
			.map((snapshot) =>
				percentileFromHistogram(snapshot.handshakeLatency, 0.99),
			)
			.filter((value): value is number => value != null);
		const p99DatagramEnqueueMs = preCloseSnapshots
			.map((snapshot) =>
				percentileFromHistogram(snapshot.datagramEnqueueLatency, 0.99),
			)
			.filter((value): value is number => value != null);
		const p99StreamOpenMs = preCloseSnapshots
			.map((snapshot) =>
				percentileFromHistogram(snapshot.streamOpenLatency, 0.99),
			)
			.filter((value): value is number => value != null);

		const p99Handshake =
			p99HandshakeMs.length > 0 ? Math.max(...p99HandshakeMs) : null;
		const p99Datagram =
			p99DatagramEnqueueMs.length > 0
				? Math.max(...p99DatagramEnqueueMs)
				: null;
		const p99Stream =
			p99StreamOpenMs.length > 0 ? Math.max(...p99StreamOpenMs) : null;

		const drainSettledBeforeEvidence = await Promise.race([
			Promise.allSettled(drainTasks),
			Bun.sleep(5_000).then(() => null),
		]);
		if (drainSettledBeforeEvidence === null && drainTasks.length > 0) {
			failures.push("server workload drains did not settle within 5000ms");
		}

		failures.push(
			...evaluateWorkloadEvidence({
				datagramsPerSec: config.datagramsPerSec,
				streamsPerSec: config.streamsPerSec,
				workloadMode: config.workloadMode,
				minDeliveryRatio: config.minDeliveryRatio,
				clientSummaries,
				serverDatagramSends,
				serverDatagramsReceived,
				serverDatagramsReceivedByPort,
				serverBidiStreamsOpened,
				serverUniStreamsOpened,
				serverStreamsAccepted,
				serverStreamsAcceptedByPort,
				serverDatagramErrors,
				serverStreamErrors,
				p99HandshakeMs: p99Handshake,
				p99DatagramEnqueueMs: p99Datagram,
				p99StreamOpenMs: p99Stream,
			}),
		);
		if (p99Handshake != null && p99Handshake > config.p99HandshakeMs) {
			failures.push(
				`handshake p99 ${p99Handshake.toFixed(3)}ms exceeded ${config.p99HandshakeMs.toFixed(3)}ms`,
			);
		}
		if (config.datagramsPerSec > 0 && p99Datagram == null) {
			failures.push("missing datagram enqueue p99 evidence");
		} else if (
			p99Datagram != null &&
			p99Datagram > config.p99DatagramEnqueueMs
		) {
			failures.push(
				`datagram enqueue p99 ${p99Datagram.toFixed(3)}ms exceeded ${config.p99DatagramEnqueueMs.toFixed(3)}ms`,
			);
		}
		if (config.streamsPerSec > 0 && p99Stream == null) {
			failures.push("missing stream open p99 evidence");
		} else if (p99Stream != null && p99Stream > config.p99StreamOpenMs) {
			failures.push(
				`stream open p99 ${p99Stream.toFixed(3)}ms exceeded ${config.p99StreamOpenMs.toFixed(3)}ms`,
			);
		}

		// Keep awaitWithTimeout("server.close", ...) visible as the shutdown contract.
		const closeStartedAt = performance.now();
		await Promise.all(
			servers.map((server) =>
				awaitWithTimeout(
					"server.close",
					server.close(),
					SERVER_CLOSE_TIMEOUT_MS,
				),
			),
		);
		serversClosed = true;
		const closeDurationMs = Number(
			(performance.now() - closeStartedAt).toFixed(3),
		);

		await Bun.sleep(2_000);
		const postCloseSnapshots = servers.map((server) =>
			server.metricsSnapshot(),
		);
		finalGauges = aggregateGauges(postCloseSnapshots);
		const finalRssMb = getRssMb();

		if (
			finalGauges.sessionsActive !== 0 ||
			finalGauges.sessionTasksActive !== 0 ||
			finalGauges.streamTasksActive !== 0 ||
			finalGauges.handshakesInFlight !== 0 ||
			finalGauges.streamsActive !== 0 ||
			finalGauges.queuedBytesGlobal !== 0
		) {
			failures.push(
				`final gauges did not recover to baseline: ${JSON.stringify(finalGauges)}`,
			);
		}
		if (finalRssMb > initialRssMb * config.maxRecoveryRssRatio) {
			failures.push(
				`RSS did not recover near baseline: initial=${initialRssMb.toFixed(2)}MB final=${finalRssMb.toFixed(2)}MB ratio=${(finalRssMb / initialRssMb).toFixed(3)}`,
			);
		}

		return {
			label: config.label,
			sessions: config.sessions,
			durationSec: config.durationSec,
			serverCount: config.serverCount,
			clientCount: config.clientCount,
			totalRequestedSessions,
			totalOkSessions,
			globalSuccessRate: Number(globalSuccessRate.toFixed(4)),
			fairnessGap: Number(fairnessGap.toFixed(4)),
			peakLiveSessions,
			peakStreams,
			peakQueuedBytesGlobal,
			peakRssMb: Number(peakRssMb.toFixed(3)),
			finalRssMb: Number(finalRssMb.toFixed(3)),
			serverDatagramSends,
			serverDatagramsReceived,
			serverDatagramsReceivedByPort,
			serverBidiStreamsOpened,
			serverUniStreamsOpened,
			serverStreamsAccepted,
			serverStreamsAcceptedByPort,
			serverDatagramErrors,
			serverStreamErrors,
			sourceIdentityCount,
			sourcePrefixCount,
			sourceIdentityProof,
			liveSetHeldMs,
			admissionShedCount,
			overloadEvidence: overloadResult.evidence,
			overloadClientSummaries: overloadResult.clientSummaries,
			closeDurationMs,
			finalGauges,
			p99HandshakeMs: p99Handshake,
			p99DatagramEnqueueMs: p99Datagram,
			p99StreamOpenMs: p99Stream,
			clientSummaries,
			failures,
		};
	} finally {
		if (!serversClosed) {
			await Promise.allSettled(
				servers.map((server) =>
					awaitWithTimeout(
						"server.close",
						server.close(),
						SERVER_CLOSE_TIMEOUT_MS,
					),
				),
			);
		}
		cert.cleanup();
	}
}

export async function runScaleCampaign(config: ScaleCampaignConfig) {
	let summary: RunSummary;
	try {
		summary = await runOneCampaign(config);
	} catch (error) {
		const emptyGauges = aggregateGauges([]);
		const sourceIdentityProof = buildSourceIdentityProof([]);
		summary = {
			label: config.label,
			sessions: config.sessions,
			durationSec: config.durationSec,
			serverCount: config.serverCount,
			clientCount: config.clientCount,
			totalRequestedSessions: config.sessions,
			totalOkSessions: 0,
			globalSuccessRate: 0,
			fairnessGap: 1,
			peakLiveSessions: 0,
			peakStreams: 0,
			peakQueuedBytesGlobal: 0,
			peakRssMb: Number(getRssMb().toFixed(3)),
			finalRssMb: Number(getRssMb().toFixed(3)),
			serverDatagramSends: 0,
			serverDatagramsReceived: 0,
			serverDatagramsReceivedByPort: {},
			serverBidiStreamsOpened: 0,
			serverUniStreamsOpened: 0,
			serverStreamsAccepted: 0,
			serverStreamsAcceptedByPort: {},
			serverDatagramErrors: 0,
			serverStreamErrors: 0,
			sourceIdentityCount: 0,
			sourcePrefixCount: 0,
			sourceIdentityProof,
			liveSetHeldMs: 0,
			admissionShedCount: 0,
			overloadEvidence: emptyOverloadEvidence(emptyGauges),
			overloadClientSummaries: [],
			closeDurationMs: 0,
			finalGauges: emptyGauges,
			p99HandshakeMs: null,
			p99DatagramEnqueueMs: null,
			p99StreamOpenMs: null,
			clientSummaries: [],
			failures: [error instanceof Error ? error.message : String(error)],
		};
	}
	mkdirSync(dirname(config.artifactPath), { recursive: true });
	writeFileSync(
		config.artifactPath,
		JSON.stringify(
			{
				createdAt: new Date().toISOString(),
				bunVersion: Bun.version,
				rustcVersion: rustcVersion(),
				source: sourceMetadata(),
				config,
				summary,
			},
			null,
			2,
		),
	);
	return summary;
}

function configFromEnv(): ScaleCampaignConfig {
	const launches: ClientLaunchConfig[] = (() => {
		const raw = process.env.LOAD_SCALE_CLIENT_LAUNCHES_JSON?.trim();
		if (!raw) {
			return [{ label: "local", commandPrefix: [] }];
		}
		const parsed = JSON.parse(raw) as Array<{
			label?: string;
			commandPrefix?: string[];
			urlHost?: string;
		}>;
		return parsed.map((launch, index) => ({
			label: launch.label ?? `launch-${index}`,
			commandPrefix: Array.isArray(launch.commandPrefix)
				? launch.commandPrefix
				: [],
			urlHost: launch.urlHost,
		}));
	})();
	const sessions = Number(process.env.LOAD_SCALE_SESSIONS ?? "10000");
	const clientCount = Number(
		process.env.LOAD_SCALE_CLIENT_COUNT ?? String(launches.length || 1),
	);
	return {
		label: process.env.LOAD_SCALE_LABEL ?? "distributed-scale",
		sessions,
		durationSec: Number(process.env.LOAD_SCALE_DURATION ?? "60"),
		serverCount: Number(process.env.LOAD_SCALE_SERVER_COUNT ?? "2"),
		clientCount,
		basePort: Number(process.env.LOAD_SCALE_BASE_PORT ?? "4433"),
		datagramsPerSec: Number(process.env.LOAD_SCALE_DATAGRAMS_PER_SEC ?? "200"),
		streamsPerSec: Number(process.env.LOAD_SCALE_STREAMS_PER_SEC ?? "2"),
		workloadMode: (process.env.LOAD_SCALE_WORKLOAD_MODE ??
			"probe") as ScaleWorkloadMode,
		minDeliveryRatio: Number(
			process.env.LOAD_SCALE_MIN_DELIVERY_RATIO ?? "0.95",
		),
		minSuccessRate: Number(process.env.LOAD_SCALE_MIN_SUCCESS_RATE ?? "1"),
		maxRssMb: Number(process.env.LOAD_SCALE_MAX_RSS_MB ?? "1024"),
		maxRecoveryRssRatio: Number(
			process.env.LOAD_SCALE_MAX_RECOVERY_RSS_RATIO ?? "1.25",
		),
		maxFairnessGap: Number(process.env.LOAD_SCALE_MAX_FAIRNESS_GAP ?? "0.05"),
		p99HandshakeMs: Number(process.env.LOAD_SCALE_P99_HANDSHAKE_MS ?? "300"),
		p99DatagramEnqueueMs: Number(
			process.env.LOAD_SCALE_P99_DATAGRAM_MS ?? "10",
		),
		p99StreamOpenMs: Number(process.env.LOAD_SCALE_P99_STREAM_OPEN_MS ?? "20"),
		minLiveSessions: Number(
			process.env.LOAD_SCALE_MIN_LIVE_SESSIONS ??
				Math.max(1, Math.floor(sessions * 0.9)).toString(),
		),
		minLiveSetHoldMs: Number(
			process.env.LOAD_SCALE_MIN_LIVE_SET_HOLD_MS ?? "1000",
		),
		minSourceIdentityCount: Number(
			process.env.LOAD_SCALE_MIN_SOURCE_IDENTITIES ?? String(clientCount),
		),
		overloadSessionsPerServer: Number(
			process.env.LOAD_SCALE_OVERLOAD_SESSIONS_PER_SERVER ?? "32",
		),
		overloadRecoveryTimeoutMs: Number(
			process.env.LOAD_SCALE_OVERLOAD_RECOVERY_TIMEOUT_MS ?? "15000",
		),
		artifactPath: process.env.LOAD_SCALE_ARTIFACT_OUT ?? DEFAULT_ARTIFACT_PATH,
		clientTargetHost:
			process.env.LOAD_SCALE_CLIENT_TARGET_HOST ?? DEFAULT_CLIENT_TARGET_HOST,
		clientLaunches: launches.map((launch) => ({
			...launch,
			urlHost:
				launch.urlHost ??
				process.env.LOAD_SCALE_CLIENT_TARGET_HOST ??
				DEFAULT_CLIENT_TARGET_HOST,
		})),
	};
}

if (import.meta.main) {
	const config = configFromEnv();
	runScaleCampaign(config)
		.then((summary) => {
			console.log(JSON.stringify(summary, null, 2));
			if (summary.failures.length > 0) {
				process.exit(1);
			}
		})
		.catch((error) => {
			console.error(error);
			process.exit(1);
		});
}
