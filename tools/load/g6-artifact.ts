import { G6_CLOSEOUT_SPEC_ID, G6_CLOSEOUT_SPEC_PATH } from "./g6-plan.ts";

export type PhaseMarker =
	| { kind: "steady" }
	| { kind: "drain" }
	| { kind: "storm"; cohort: number | null }
	| { kind: "post-storm" }
	| { kind: "idle" }
	| { kind: "stop" };

export type RxByClassSnapshot = {
	snapshot: number;
	ack: number;
	raid: number;
	raidJoin: number;
	unstamped: number;
};

export type EmitterSnapshot = {
	snapshotDue: number;
	snapshotIssued: number;
	ackDue: number;
	ackIssued: number;
	raidForwarded: number;
	sendErrors: number;
	sendEventsSkipped: number;
	batchPartialCompletions: number;
};

export type MetricsSnapshotLike = {
	nowMs?: number;
	sessionsActive?: number;
	handshakesInFlight?: number;
	datagramsIn?: number;
	datagramsDropped?: number;
	datagramsSkippedQueueFull?: number;
	limitExceededCount?: number;
	rateLimitedCount?: number;
	sessionsClosedByIdle?: number;
	sessionsClosedOther?: number;
	[key: string]: unknown;
};

export type BoundarySnapshot = {
	rxTotal: number;
	/** Upstream received from sessions outside the registered severed cohort. */
	rxSurvivors: number;
	rxByClass: RxByClassSnapshot;
	emitter: EmitterSnapshot;
	cpuMs: number;
	wallMs: number;
	kernel: Record<string, number> | null;
	metrics: MetricsSnapshotLike;
};

export type ClientMeasurementWindow = {
	sent: number;
	sendErr: number;
	scheduleTicksDue: number;
	scheduleTicksFired: number;
	scheduleTicksSkipped: number;
	scheduleTicksReconciled: boolean;
	rxSnapshot: number;
	rxAck: number;
	rxRaid: number;
	rxOther: number;
	rxUnstamped: number;
	ackUnreflected: number;
	sessionsLost: number;
	scheduleLag: unknown;
	rtt: unknown;
	oneWay: unknown;
	serverHold: unknown;
};

export type EmitterPhase =
	| "connect"
	| "steady"
	| "drain"
	| "storm"
	| "post-storm"
	| "idle"
	| "stop";

export type EmitterSendWindowKind = "steady" | "storm" | "post-storm";

export type EmitterWindowState = {
	kind: EmitterSendWindowKind;
	startedNs: number;
	sliceIndex: number;
};

export type BoundaryMarks = {
	start: BoundarySnapshot;
	steadyStart: BoundarySnapshot;
	drainStart: BoundarySnapshot;
	drainEnd: BoundarySnapshot;
	idleStart: BoundarySnapshot;
	stormStart?: BoundarySnapshot | null;
	stormEnd?: BoundarySnapshot | null;
};

export type ClientReportV2 = {
	schema: "mmo-client/2";
	role: string;
	startedAt: string;
	preRegistration: {
		id: string;
		path: string;
		sha256: string;
	};
	windows?: Record<string, unknown>;
	lifetime?: unknown;
	quicDrive?: Record<string, unknown>;
	[key: string]: unknown;
};

export type ClientProcessEvidence = {
	report: Record<string, unknown> | null;
	provenanceLines: string[];
	stdoutLines?: string[];
	stderrLines: string[];
	exitCode: number;
	outputTruncated?: boolean;
};

/**
 * Bind side-process evidence to the role the conductor launched, never to a
 * role read from the process's optional JSON report. A process that dies before
 * JSON still has authoritative exit and stderr evidence.
 */
export function indexClientBundlesByLaunchRole<R extends string>(
	roles: readonly R[],
	bundles: readonly ClientProcessEvidence[],
): Map<R, ClientProcessEvidence> {
	if (roles.length !== bundles.length) {
		throw new Error(
			`bench-g6: launched ${roles.length} side role(s) but collected ${bundles.length} bundle(s)`,
		);
	}
	return new Map(
		roles.map((role, index) => {
			const bundle = bundles[index];
			if (!bundle) {
				throw new Error(`bench-g6: missing collected bundle for ${role}`);
			}
			return [role, bundle];
		}),
	);
}

export function clientProcessFailureReasons(
	role: string,
	bundle: ClientProcessEvidence | null | undefined,
	requireOffboxProvenance: boolean,
): string[] {
	const reasons: string[] = [];
	if (!bundle?.report) reasons.push(`${role} client produced no JSON report`);
	if (bundle && bundle.exitCode !== 0) {
		const stderr =
			bundle.stderrLines.length > 0
				? `; stderr=${bundle.stderrLines.join(" | ")}`
				: "";
		reasons.push(`${role} client exited ${bundle.exitCode}${stderr}`);
	}
	if (requireOffboxProvenance && (bundle?.provenanceLines.length ?? 0) === 0) {
		reasons.push(`${role} client produced no off-box provenance lines`);
	}
	if (bundle?.outputTruncated) {
		reasons.push(`${role} client output exceeded the retained evidence bound`);
	}
	return reasons;
}

export type PhaseBarrierEvidence = {
	id: string;
	parties: number;
	role: string;
	readyUnixMs: number;
	readyMonotonicNs: number;
	releaseUnixMs: number;
	releaseMonotonicNs: number;
	steadyEnterUnixMs: number;
	steadyEnterMonotonicNs: number;
};

export const HOTSPOT_PHASE_BARRIER_PARTIES = 3;
export const HOTSPOT_PHASE_BARRIER_ROLES = [
	"publisher",
	"raid-subscriber",
	"realm",
] as const;
export const HOTSPOT_PHASE_BARRIER_STEADY_SKEW_MS = 100;

export type WindowComparisonStatus =
	| "exact"
	| "under"
	| "over"
	| "unreflected"
	| "unparseable";

function deltaRecord(
	from: Record<string, unknown> | null,
	to: Record<string, unknown> | null,
): Record<string, number> | null {
	if (!from || !to) return null;
	const out: Record<string, number> = {};
	for (const key of Object.keys(to)) {
		const before = from[key];
		const after = to[key];
		if (typeof before === "number" && typeof after === "number") {
			out[key] = after - before;
		}
	}
	return out;
}

export function deltaBoundarySnapshot(
	from: BoundarySnapshot,
	to: BoundarySnapshot,
): BoundarySnapshot {
	return {
		rxTotal: to.rxTotal - from.rxTotal,
		rxSurvivors: to.rxSurvivors - from.rxSurvivors,
		rxByClass: {
			snapshot: to.rxByClass.snapshot - from.rxByClass.snapshot,
			ack: to.rxByClass.ack - from.rxByClass.ack,
			raid: to.rxByClass.raid - from.rxByClass.raid,
			raidJoin: to.rxByClass.raidJoin - from.rxByClass.raidJoin,
			unstamped: to.rxByClass.unstamped - from.rxByClass.unstamped,
		},
		emitter: {
			snapshotDue: to.emitter.snapshotDue - from.emitter.snapshotDue,
			snapshotIssued: to.emitter.snapshotIssued - from.emitter.snapshotIssued,
			ackDue: to.emitter.ackDue - from.emitter.ackDue,
			ackIssued: to.emitter.ackIssued - from.emitter.ackIssued,
			raidForwarded: to.emitter.raidForwarded - from.emitter.raidForwarded,
			sendErrors: to.emitter.sendErrors - from.emitter.sendErrors,
			sendEventsSkipped:
				to.emitter.sendEventsSkipped - from.emitter.sendEventsSkipped,
			batchPartialCompletions:
				to.emitter.batchPartialCompletions -
				from.emitter.batchPartialCompletions,
		},
		cpuMs: to.cpuMs - from.cpuMs,
		wallMs: to.wallMs - from.wallMs,
		kernel: deltaRecord(from.kernel, to.kernel),
		metrics: deltaRecord(from.metrics, to.metrics) ?? {},
	};
}

export function emitterSendWindowKind(
	phase: EmitterPhase,
): EmitterSendWindowKind | null {
	if (phase === "steady") return "steady";
	if (phase === "storm") return "storm";
	if (phase === "post-storm") return "post-storm";
	return null;
}

export function nextEmitterWindowState(
	window: EmitterWindowState | null,
	phase: EmitterPhase,
	nowNs: number,
	sliceNs: number,
): {
	window: EmitterWindowState | null;
	emit: {
		kind: EmitterSendWindowKind;
		deadlineNs: number;
		sliceIndex: number;
	} | null;
} {
	const kind = emitterSendWindowKind(phase);
	if (kind === null) {
		return { window: null, emit: null };
	}
	const active =
		window && window.kind === kind
			? window
			: {
					kind,
					startedNs: nowNs,
					sliceIndex: 0,
				};
	return {
		window: {
			...active,
			sliceIndex: active.sliceIndex + 1,
		},
		emit: {
			kind,
			deadlineNs: active.startedNs + active.sliceIndex * sliceNs,
			sliceIndex: active.sliceIndex,
		},
	};
}

export function emitterSliceBounds(
	targetCount: number,
	slicesPerTick: number,
	sliceIndex: number,
): { from: number; to: number } {
	const perSlice = Math.ceil(targetCount / Math.max(1, slicesPerTick));
	const slot = sliceIndex % Math.max(1, slicesPerTick);
	return {
		from: slot * perSlice,
		to: slot * perSlice + perSlice,
	};
}

export function deriveBoundaryWindows(marks: BoundaryMarks): {
	steady: BoundarySnapshot;
	steadyDrain: BoundarySnapshot;
	lifetime: BoundarySnapshot;
	storm: BoundarySnapshot | null;
} {
	return {
		steady: deltaBoundarySnapshot(marks.steadyStart, marks.drainStart),
		steadyDrain: deltaBoundarySnapshot(marks.steadyStart, marks.drainEnd),
		lifetime: deltaBoundarySnapshot(marks.start, marks.idleStart),
		storm:
			marks.stormStart && marks.stormEnd
				? deltaBoundarySnapshot(marks.stormStart, marks.stormEnd)
				: null,
	};
}

export function validateSourceBinding(input: {
	checkedOutSha: string;
	expectedCandidateSha?: string | null;
	statusPorcelain: string;
}): { candidateSha: string; dirty: false } {
	const { checkedOutSha, expectedCandidateSha, statusPorcelain } = input;
	if (!/^[0-9a-f]{40}$/.test(checkedOutSha)) {
		throw new Error(
			`bench-g6: invalid checked-out candidate sha '${checkedOutSha}'`,
		);
	}
	if (expectedCandidateSha) {
		if (!/^[0-9a-f]{40}$/.test(expectedCandidateSha)) {
			throw new Error(
				`bench-g6: G6_CANDIDATE_SHA must be exact lowercase 40-hex, got '${expectedCandidateSha}'`,
			);
		}
		if (checkedOutSha !== expectedCandidateSha) {
			throw new Error(
				`bench-g6: checked-out candidate ${checkedOutSha} does not match G6_CANDIDATE_SHA ${expectedCandidateSha}`,
			);
		}
	}
	const dirty = statusPorcelain.trim();
	if (dirty) {
		throw new Error(
			`bench-g6: checked-out candidate ${checkedOutSha} is dirty: ${dirty.split("\n")[0]}`,
		);
	}
	return { candidateSha: checkedOutSha, dirty: false };
}

function asObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function requireClientReportIdentity(
	report: unknown,
	expected: {
		role: string;
		startedAt: string;
		preregistrationSha256: string;
	},
): ClientReportV2 {
	const root = asObject(report);
	if (!root) {
		throw new Error(
			`bench-g6: ${expected.role} client report was not a JSON object`,
		);
	}
	if (root.schema === "mmo-client/1") {
		throw new Error(
			`bench-g6: ${expected.role} client report is historical mmo-client/1 and cannot satisfy successor validity`,
		);
	}
	if (root.schema !== "mmo-client/2") {
		throw new Error(
			`bench-g6: ${expected.role} client report schema must be mmo-client/2`,
		);
	}
	if (root.role !== expected.role) {
		throw new Error(
			`bench-g6: ${expected.role} client report role mismatch: got '${String(root.role)}'`,
		);
	}
	if (root.startedAt !== expected.startedAt) {
		throw new Error(
			`bench-g6: ${expected.role} client report startedAt mismatch: expected ${expected.startedAt}, got ${String(root.startedAt)}`,
		);
	}
	const preRegistration = asObject(root.preRegistration);
	if (preRegistration?.id !== G6_CLOSEOUT_SPEC_ID) {
		throw new Error(
			`bench-g6: ${expected.role} client report preregistration id must be ${G6_CLOSEOUT_SPEC_ID}`,
		);
	}
	if (preRegistration?.path !== G6_CLOSEOUT_SPEC_PATH) {
		throw new Error(
			`bench-g6: ${expected.role} client report preregistration path must be ${G6_CLOSEOUT_SPEC_PATH}`,
		);
	}
	if (preRegistration?.sha256 !== expected.preregistrationSha256) {
		throw new Error(
			`bench-g6: ${expected.role} client report preregistration sha256 mismatch: expected ${expected.preregistrationSha256}, got ${String(preRegistration?.sha256)}`,
		);
	}
	return root as ClientReportV2;
}

export function phaseBarrierEvidence(
	report: ClientReportV2 | null,
): PhaseBarrierEvidence | null {
	const root = asObject(report);
	const barrier = asObject(root?.phaseBarrier);
	if (!barrier) return null;
	const id = barrier.id;
	const parties = barrier.parties;
	const role = barrier.role;
	const readyUnixMs = barrier.readyUnixMs;
	const readyMonotonicNs = barrier.readyMonotonicNs;
	const releaseUnixMs = barrier.releaseUnixMs;
	const releaseMonotonicNs = barrier.releaseMonotonicNs;
	const steadyEnterUnixMs = barrier.steadyEnterUnixMs;
	const steadyEnterMonotonicNs = barrier.steadyEnterMonotonicNs;
	if (
		typeof id !== "string" ||
		typeof parties !== "number" ||
		typeof role !== "string" ||
		typeof readyUnixMs !== "number" ||
		typeof readyMonotonicNs !== "number" ||
		typeof releaseUnixMs !== "number" ||
		typeof releaseMonotonicNs !== "number" ||
		typeof steadyEnterUnixMs !== "number" ||
		typeof steadyEnterMonotonicNs !== "number"
	) {
		return null;
	}
	return {
		id,
		parties,
		role,
		readyUnixMs,
		readyMonotonicNs,
		releaseUnixMs,
		releaseMonotonicNs,
		steadyEnterUnixMs,
		steadyEnterMonotonicNs,
	};
}

export function summarizePhaseBarrier(
	reports: ClientReportV2[],
	expectedParties: number,
): {
	id: string;
	parties: number;
	roles: string[];
	readySkewMs: number;
	releaseSkewMs: number;
	steadyEnterSkewMs: number;
} {
	const evidence = reports.map((report) => phaseBarrierEvidence(report));
	if (evidence.some((item) => item === null)) {
		throw new Error(
			"bench-g6: hotspot reports did not all disclose phaseBarrier evidence",
		);
	}
	const barriers = evidence as PhaseBarrierEvidence[];
	const [first] = barriers;
	if (!first) {
		throw new Error("bench-g6: hotspot barrier summary requires reports");
	}
	if (first.parties !== expectedParties) {
		throw new Error(
			`bench-g6: hotspot barrier parties mismatch: expected ${expectedParties}, got ${first.parties}`,
		);
	}
	for (const item of barriers) {
		if (item.id !== first.id) {
			throw new Error(
				`bench-g6: hotspot barrier id mismatch: expected ${first.id}, got ${item.id}`,
			);
		}
		if (item.parties !== first.parties) {
			throw new Error(
				`bench-g6: hotspot barrier parties disagree: expected ${first.parties}, got ${item.parties}`,
			);
		}
		if (item.releaseUnixMs !== first.releaseUnixMs) {
			throw new Error(
				`bench-g6: hotspot barrier release mismatch: expected ${first.releaseUnixMs}, got ${item.releaseUnixMs}`,
			);
		}
		if (item.releaseMonotonicNs !== first.releaseMonotonicNs) {
			throw new Error(
				`bench-g6: hotspot barrier release monotonic mismatch: expected ${first.releaseMonotonicNs}, got ${item.releaseMonotonicNs}`,
			);
		}
	}
	const roles = barriers.map((item) => item.role).sort();
	const expectedRoles = [...HOTSPOT_PHASE_BARRIER_ROLES];
	if (roles.join(",") !== expectedRoles.join(",")) {
		throw new Error(
			`bench-g6: hotspot barrier roles mismatch: expected ${expectedRoles.join(",")}, got ${roles.join(",")}`,
		);
	}
	const values = (pick: (item: PhaseBarrierEvidence) => number) =>
		barriers.map(pick);
	const skew = (nums: number[]) => Math.max(...nums) - Math.min(...nums);
	const skewMs = (nums: number[]) => skew(nums) / 1e6;
	return {
		id: first.id,
		parties: first.parties,
		roles,
		readySkewMs: skewMs(values((item) => item.readyMonotonicNs)),
		releaseSkewMs: skewMs(values((item) => item.releaseMonotonicNs)),
		steadyEnterSkewMs: skewMs(values((item) => item.steadyEnterMonotonicNs)),
	};
}

export function windowReceiveTotal(
	window: Pick<
		ClientMeasurementWindow,
		"rxSnapshot" | "rxAck" | "rxRaid" | "rxOther" | "rxUnstamped"
	>,
): number {
	return (
		window.rxSnapshot +
		window.rxAck +
		window.rxRaid +
		window.rxOther +
		window.rxUnstamped
	);
}

export function compareWindowDelivery(
	serverIssued: number,
	window: Pick<
		ClientMeasurementWindow,
		| "rxSnapshot"
		| "rxAck"
		| "rxRaid"
		| "rxOther"
		| "rxUnstamped"
		| "ackUnreflected"
	>,
): {
	status: WindowComparisonStatus;
	clientReceived: number;
	serverIssued: number;
} {
	const clientReceived = windowReceiveTotal(window);
	if (window.rxUnstamped > 0) {
		return { status: "unparseable", clientReceived, serverIssued };
	}
	if (window.ackUnreflected > 0) {
		return { status: "unreflected", clientReceived, serverIssued };
	}
	if (clientReceived === serverIssued) {
		return { status: "exact", clientReceived, serverIssued };
	}
	if (clientReceived < serverIssued) {
		return { status: "under", clientReceived, serverIssued };
	}
	return { status: "over", clientReceived, serverIssued };
}

export function clientWindow(
	report: ClientReportV2 | null,
	name: "steady" | "steadyDrain" | "stormSurvivors",
): ClientMeasurementWindow | null {
	const window = asObject(report?.windows)?.[name];
	return asObject(window) as ClientMeasurementWindow | null;
}

export function readPhaseMarker(line: string): PhaseMarker | null {
	if (line.includes("phase steady")) return { kind: "steady" };
	if (line.includes("phase drain")) return { kind: "drain" };
	if (line.includes("phase post-storm")) return { kind: "post-storm" };
	if (line.includes("phase idle")) return { kind: "idle" };
	if (line.includes("phase stop")) return { kind: "stop" };
	if (line.includes("phase storm")) {
		const match = line.match(/cohort=(\d+)/);
		return { kind: "storm", cohort: match ? Number(match[1]) : null };
	}
	return null;
}

export function buildBenchArtifact<
	T extends {
		startedAt: string;
		writtenAt: string;
		preregistrationSha256: string;
		source: { candidateSha: string };
	},
>(input: T) {
	const { preregistrationSha256, ...rest } = input;
	return {
		version: 2,
		schema: "bench-g6/2",
		preRegistration: {
			id: G6_CLOSEOUT_SPEC_ID,
			path: G6_CLOSEOUT_SPEC_PATH,
			sha256: preregistrationSha256,
		},
		...rest,
	};
}

export type G6RetainedClientRole = "realm" | "subscriber" | "publisher";

const RETAINED_CLIENT_ROLE_KEYS = {
	realm: {
		report: "realm",
		provenance: "realmProvenance",
		stdout: "realmStdout",
		stderr: "realmStderr",
		exitCode: "realmExitCode",
		outputTruncated: "realmOutputTruncated",
	},
	subscriber: {
		report: "subscriber",
		provenance: "subscriberProvenance",
		stdout: "subscriberStdout",
		stderr: "subscriberStderr",
		exitCode: "subscriberExitCode",
		outputTruncated: "subscriberOutputTruncated",
	},
	publisher: {
		report: "publisher",
		provenance: "publisherProvenance",
		stdout: "publisherStdout",
		stderr: "publisherStderr",
		exitCode: "publisherExitCode",
		outputTruncated: "publisherOutputTruncated",
	},
} as const;

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function buildRetainedG6ClientRoleEvidence(
	artifact: unknown,
	role: G6RetainedClientRole,
): Record<string, unknown> {
	const root = asObject(artifact);
	if (!root) throw new Error("bench-g6: retained evidence needs an artifact");
	const preRegistration = asObject(root.preRegistration);
	if (!preRegistration) {
		throw new Error(
			"bench-g6: retained evidence needs preregistration identity",
		);
	}
	const keys = RETAINED_CLIENT_ROLE_KEYS[role];
	const arms = Array.isArray(root.arms) ? root.arms : [];
	return {
		schema: "g6-client-role-evidence/1",
		role,
		preRegistration,
		source: root.source ?? null,
		records: arms.map((value) => {
			const arm = asObject(value);
			const raw = asObject(arm?.rawReports);
			return {
				arm: typeof arm?.arm === "string" ? arm.arm : null,
				sessions: typeof arm?.sessions === "number" ? arm.sessions : null,
				report: raw?.[keys.report] ?? null,
				provenanceLines: stringArray(raw?.[keys.provenance]),
				stdoutLines: stringArray(raw?.[keys.stdout]),
				stderrLines: stringArray(raw?.[keys.stderr]),
				exitCode:
					typeof raw?.[keys.exitCode] === "number" ? raw[keys.exitCode] : null,
				outputTruncated: raw?.[keys.outputTruncated] === true,
			};
		}),
	};
}

export function renderRetainedG6ClientRoleLog(
	evidence: Record<string, unknown>,
): string {
	const records = Array.isArray(evidence.records) ? evidence.records : [];
	const lines: string[] = [];
	for (const value of records) {
		const record = asObject(value);
		if (!record) continue;
		lines.push(
			`=== arm=${String(record.arm)} sessions=${String(record.sessions)} exit=${String(record.exitCode)} truncated=${String(record.outputTruncated === true)} ===`,
		);
		for (const line of stringArray(record.stdoutLines)) {
			lines.push(`stdout: ${line}`);
		}
		for (const line of stringArray(record.stderrLines)) {
			lines.push(`stderr: ${line}`);
		}
	}
	return `${lines.join("\n")}\n`;
}

export function chooseClientProvenance(input: {
	provenanceLines: string[] | null | undefined;
	offbox: boolean;
	exitCode: number | null;
	localFallback: string[];
}): string[] {
	const lines = input.provenanceLines ?? [];
	if (lines.length > 0) return lines;
	if (input.offbox) return [];
	if (input.exitCode === null) return [];
	return input.localFallback;
}
