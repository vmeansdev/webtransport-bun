import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
	type RecordEnvelope,
	validateEnvelope,
	validateRecordSequence,
} from "./g6-c32-freeze-model.ts";

export type RigLifecycleState =
	| "ABSENT"
	| "CREATING"
	| "PROVISIONED"
	| "PREPARING"
	| "PREPARED"
	| "BINDING"
	| "BOUND"
	| "QUALIFYING"
	| "RUNNING"
	| "TERMINAL"
	| "DESTROYING"
	| "DESTROYED"
	| "FAILED";

export type RigJournalEventKind =
	| "INTENT"
	| "RESULT"
	| "TRANSITION"
	| "RECOVERY";

export type RigJournalEvent = {
	schema: "g6-c32-rig-event/1";
	envelope: RecordEnvelope;
	previousEventArtifactSha256: string | null;
	state: RigLifecycleState;
	kind: RigJournalEventKind;
	details: unknown;
};

export type RigJournalSnapshot = {
	schema: "g6-c32-rig-state/1";
	envelope: RecordEnvelope;
	desiredRigAuthoritySha256: string;
	desiredRigAuthority: unknown;
	lastEventArtifactSha256: string;
	events: RigJournalEvent[];
};

export type RigCreateIntentState = "OPEN" | "CONSUMED" | "CLOSED";

export type RigCreateIntentRecord = {
	schema: "g6-c32-create-intent-record/1";
	envelope: RecordEnvelope;
	desiredRigAuthoritySha256: string;
	previousRecordArtifactSha256: string | null;
	intent: Record<string, unknown> & { state: RigCreateIntentState };
};

export interface JournalClock {
	wallNow(): string;
}

export type JournalPublishBoundary =
	| "before-temp-fsync"
	| "after-temp-fsync"
	| "after-rename"
	| "before-directory-fsync";

export type JournalDependencies = {
	clock: JournalClock;
	randomId: () => string;
	onPublishBoundary: (boundary: JournalPublishBoundary) => void;
};

export type InitializeRigJournalInput = {
	path: string;
	runId: string;
	desiredRigAuthority: unknown;
};

export type AppendRigJournalEventInput = {
	state: RigLifecycleState;
	kind: RigJournalEventKind;
	operationId: string;
	details: unknown;
};

export type WriteRigCreateIntentRecordInput = {
	path: string;
	runId: string;
	phase: string;
	operationId: string;
	desiredRigAuthority: unknown;
	intent: unknown;
};

const LIFECYCLE_STATES = new Set<RigLifecycleState>([
	"ABSENT",
	"CREATING",
	"PROVISIONED",
	"PREPARING",
	"PREPARED",
	"BINDING",
	"BOUND",
	"QUALIFYING",
	"RUNNING",
	"TERMINAL",
	"DESTROYING",
	"DESTROYED",
	"FAILED",
]);

const EVENT_KINDS = new Set<RigJournalEventKind>([
	"INTENT",
	"RESULT",
	"TRANSITION",
	"RECOVERY",
]);

const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(message: string): never {
	throw new Error(`g6-c32-rig-journal: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		fail(`${label} has an invalid shape`);
	}
}

function canonicalClone(value: unknown, label: string): unknown {
	try {
		return JSON.parse(canonicalJson(value)) as unknown;
	} catch (error) {
		fail(
			`${label} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function requireSha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_RE.test(value)) {
		fail(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

function requireState(value: unknown, label: string): RigLifecycleState {
	if (!LIFECYCLE_STATES.has(value as RigLifecycleState)) {
		fail(`${label} is not a recognized lifecycle state`);
	}
	return value as RigLifecycleState;
}

function requireKind(value: unknown, label: string): RigJournalEventKind {
	if (!EVENT_KINDS.has(value as RigJournalEventKind)) {
		fail(`${label} is not a recognized journal event kind`);
	}
	return value as RigJournalEventKind;
}

function validateEvent(value: unknown, index: number): RigJournalEvent {
	if (!isRecord(value)) fail(`events[${index}] must be an object`);
	requireExactKeys(
		value,
		[
			"schema",
			"envelope",
			"previousEventArtifactSha256",
			"state",
			"kind",
			"details",
		],
		`events[${index}]`,
	);
	if (value.schema !== "g6-c32-rig-event/1") {
		fail(`events[${index}].schema is not supported`);
	}
	const envelope = validateEnvelope(value.envelope);
	const state = requireState(value.state, `events[${index}].state`);
	if (envelope.phase !== state) {
		fail(`events[${index}] phase must equal its lifecycle state`);
	}
	if (!SAFE_ID_RE.test(envelope.operationId)) {
		fail(`events[${index}].operationId is not safe`);
	}
	return {
		schema: "g6-c32-rig-event/1",
		envelope,
		previousEventArtifactSha256:
			value.previousEventArtifactSha256 === null
				? null
				: requireSha256(
						value.previousEventArtifactSha256,
						`events[${index}].previousEventArtifactSha256`,
					),
		state,
		kind: requireKind(value.kind, `events[${index}].kind`),
		details: canonicalClone(value.details, `events[${index}].details`),
	};
}

export function replayRigJournal(value: unknown): RigJournalSnapshot {
	if (!isRecord(value)) fail("snapshot must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"envelope",
			"desiredRigAuthoritySha256",
			"desiredRigAuthority",
			"lastEventArtifactSha256",
			"events",
		],
		"snapshot",
	);
	if (value.schema !== "g6-c32-rig-state/1") {
		fail("snapshot schema is not supported");
	}
	if (!Array.isArray(value.events) || value.events.length === 0) {
		fail("snapshot must contain at least the ABSENT event");
	}
	const desiredRigAuthority = canonicalClone(
		value.desiredRigAuthority,
		"desiredRigAuthority",
	);
	const desiredRigAuthoritySha256 = requireSha256(
		value.desiredRigAuthoritySha256,
		"desiredRigAuthoritySha256",
	);
	if (
		desiredRigAuthoritySha256 !== canonicalAuthoritySha256(desiredRigAuthority)
	) {
		fail("desired rig authority digest mismatch");
	}
	const events = value.events.map((event, index) =>
		validateEvent(event, index),
	);
	validateRecordSequence(events.map((event) => event.envelope));
	const first = events[0];
	if (
		!first ||
		first.state !== "ABSENT" ||
		first.envelope.sequence !== 1 ||
		first.previousEventArtifactSha256 !== null
	) {
		fail("journal must start with sequence-1 ABSENT and no previous digest");
	}
	for (let index = 1; index < events.length; index += 1) {
		const previous = events[index - 1];
		const current = events[index];
		if (!previous || !current) fail(`events[${index}] is missing`);
		if (current.envelope.sequence !== previous.envelope.sequence + 1) {
			fail(`events[${index}] sequence must increment by exactly one`);
		}
		if (
			current.previousEventArtifactSha256 !== canonicalArtifactSha256(previous)
		) {
			fail(`events[${index}] previous event digest mismatch`);
		}
	}
	const latest = events.at(-1);
	if (!latest) fail("journal has no latest event");
	const lastEventArtifactSha256 = requireSha256(
		value.lastEventArtifactSha256,
		"lastEventArtifactSha256",
	);
	if (lastEventArtifactSha256 !== canonicalArtifactSha256(latest)) {
		fail("last event artifact digest mismatch");
	}
	const envelope = validateEnvelope(value.envelope);
	if (
		envelope.runId !== latest.envelope.runId ||
		envelope.sequence !== latest.envelope.sequence ||
		envelope.recordedAt !== latest.envelope.recordedAt ||
		envelope.phase !== latest.state ||
		envelope.operationId !== "rig-state-snapshot" ||
		envelope.clockSource !== "offrunner"
	) {
		fail("snapshot envelope does not identify the latest complete event");
	}
	return {
		schema: "g6-c32-rig-state/1",
		envelope,
		desiredRigAuthoritySha256,
		desiredRigAuthority,
		lastEventArtifactSha256,
		events,
	};
}

class SystemJournalClock implements JournalClock {
	wallNow(): string {
		return new Date().toISOString();
	}
}

function dependencies(
	overrides: Partial<JournalDependencies>,
): JournalDependencies {
	return {
		clock: overrides.clock ?? new SystemJournalClock(),
		randomId: overrides.randomId ?? randomUUID,
		onPublishBoundary: overrides.onPublishBoundary ?? (() => {}),
	};
}

function safeRandomId(value: string): string {
	if (!SAFE_ID_RE.test(value)) fail("journal staging ID is not filename-safe");
	return value;
}

function publishCanonicalRecord(
	path: string,
	value: unknown,
	sequence: number,
	deps: JournalDependencies,
): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true });
	const stagingPath = join(
		parent,
		`${basename(path)}.staged-${sequence}-${safeRandomId(deps.randomId())}`,
	);
	const fd = openSync(stagingPath, "wx", 0o600);
	try {
		writeFileSync(fd, canonicalJson(value), "utf8");
		deps.onPublishBoundary("before-temp-fsync");
		fsyncSync(fd);
		deps.onPublishBoundary("after-temp-fsync");
	} finally {
		closeSync(fd);
	}
	renameSync(stagingPath, path);
	deps.onPublishBoundary("after-rename");
	deps.onPublishBoundary("before-directory-fsync");
	const parentFd = openSync(parent, "r");
	try {
		fsyncSync(parentFd);
	} finally {
		closeSync(parentFd);
	}
}

function publishSnapshot(
	path: string,
	snapshot: RigJournalSnapshot,
	deps: JournalDependencies,
): void {
	publishCanonicalRecord(path, snapshot, snapshot.envelope.sequence, deps);
}

function requireCreateIntentState(
	value: unknown,
	label: string,
): RigCreateIntentState {
	if (value !== "OPEN" && value !== "CONSUMED" && value !== "CLOSED") {
		fail(`${label} must be OPEN, CONSUMED, or CLOSED`);
	}
	return value;
}

function validateCreateIntentPayload(
	value: unknown,
): RigCreateIntentRecord["intent"] {
	if (!isRecord(value)) fail("create intent payload must be an object");
	const cloned = canonicalClone(value, "create intent payload");
	if (!isRecord(cloned)) fail("create intent payload must remain an object");
	return {
		...cloned,
		state: requireCreateIntentState(cloned.state, "create intent state"),
	};
}

function intentAuthorityWithoutState(
	intent: RigCreateIntentRecord["intent"],
): unknown {
	const { state: _, ...authority } = intent;
	return authority;
}

export function validateRigCreateIntentRecord(
	value: unknown,
): RigCreateIntentRecord {
	if (!isRecord(value)) fail("create intent record must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"envelope",
			"desiredRigAuthoritySha256",
			"previousRecordArtifactSha256",
			"intent",
		],
		"create intent record",
	);
	if (value.schema !== "g6-c32-create-intent-record/1") {
		fail("create intent record schema is not supported");
	}
	const envelope = validateEnvelope(value.envelope);
	if (!SAFE_ID_RE.test(envelope.operationId)) {
		fail("create intent operationId is not safe");
	}
	const intent = validateCreateIntentPayload(value.intent);
	if (envelope.sequence === 1 && value.previousRecordArtifactSha256 !== null) {
		fail("initial create intent record must not name a previous digest");
	}
	if (envelope.sequence > 1 && value.previousRecordArtifactSha256 === null) {
		fail("updated create intent record must name its previous digest");
	}
	return {
		schema: "g6-c32-create-intent-record/1",
		envelope,
		desiredRigAuthoritySha256: requireSha256(
			value.desiredRigAuthoritySha256,
			"create intent desiredRigAuthoritySha256",
		),
		previousRecordArtifactSha256:
			value.previousRecordArtifactSha256 === null
				? null
				: requireSha256(
						value.previousRecordArtifactSha256,
						"create intent previousRecordArtifactSha256",
					),
		intent,
	};
}

export function readRigCreateIntentRecord(path: string): RigCreateIntentRecord {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		fail(
			`could not parse create intent JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return validateRigCreateIntentRecord(value);
}

function assertIntentTransition(
	from: RigCreateIntentRecord["intent"],
	to: RigCreateIntentRecord["intent"],
): void {
	if (
		(from.state === "OPEN" &&
			(to.state === "CONSUMED" || to.state === "CLOSED")) ||
		(from.state === "CONSUMED" && to.state === "CLOSED")
	) {
		return;
	}
	if (
		from.state === "CLOSED" &&
		to.state === "OPEN" &&
		from.attempt === 1 &&
		to.attempt === 2
	) {
		return;
	}
	fail(`create intent transition ${from.state} -> ${to.state} is not allowed`);
}

export function writeRigCreateIntentRecord(
	input: WriteRigCreateIntentRecordInput,
	overrides: Partial<JournalDependencies> = {},
): RigCreateIntentRecord {
	if (!SAFE_ID_RE.test(input.runId)) fail("create intent runId is not safe");
	if (!SAFE_ID_RE.test(input.operationId)) {
		fail("create intent operationId is not safe");
	}
	if (!SAFE_ID_RE.test(input.phase)) fail("create intent phase is not safe");
	const deps = dependencies(overrides);
	const intent = validateCreateIntentPayload(input.intent);
	const desiredRigAuthoritySha256 = canonicalAuthoritySha256(
		canonicalClone(input.desiredRigAuthority, "desiredRigAuthority"),
	);
	const prior = existsSync(input.path)
		? readRigCreateIntentRecord(input.path)
		: null;
	if (!prior && intent.state !== "OPEN") {
		fail("initial create intent record must be OPEN");
	}
	if (prior) {
		if (
			prior.envelope.runId !== input.runId ||
			prior.desiredRigAuthoritySha256 !== desiredRigAuthoritySha256
		) {
			fail("create intent update does not match prior authority");
		}
		assertIntentTransition(prior.intent, intent);
		if (prior.intent.state === "CLOSED" && intent.state === "OPEN") {
			const stripAttemptIdentity = (
				value: RigCreateIntentRecord["intent"],
			): unknown => {
				const {
					state: _,
					attempt: _attempt,
					mutationNonce: _mutationNonce,
					notBefore: _notBefore,
					...authority
				} = value;
				return authority;
			};
			if (
				canonicalJson(stripAttemptIdentity(prior.intent)) !==
				canonicalJson(stripAttemptIdentity(intent))
			) {
				fail("retry create intent changed immutable request authority");
			}
		} else if (
			canonicalJson(intentAuthorityWithoutState(prior.intent)) !==
			canonicalJson(intentAuthorityWithoutState(intent))
		) {
			fail("create intent update changed immutable request authority");
		}
	}
	const record = validateRigCreateIntentRecord({
		schema: "g6-c32-create-intent-record/1",
		envelope: {
			recordedAt: deps.clock.wallNow(),
			sequence: (prior?.envelope.sequence ?? 0) + 1,
			runId: input.runId,
			phase: input.phase,
			operationId: input.operationId,
			clockSource: "offrunner",
		},
		desiredRigAuthoritySha256,
		previousRecordArtifactSha256: prior ? canonicalArtifactSha256(prior) : null,
		intent,
	});
	publishCanonicalRecord(input.path, record, record.envelope.sequence, deps);
	return record;
}

function makeSnapshot(
	desiredRigAuthority: unknown,
	events: RigJournalEvent[],
): RigJournalSnapshot {
	const latest = events.at(-1);
	if (!latest) fail("cannot create a snapshot without an event");
	return replayRigJournal({
		schema: "g6-c32-rig-state/1",
		envelope: {
			...latest.envelope,
			operationId: "rig-state-snapshot",
		},
		desiredRigAuthoritySha256: canonicalAuthoritySha256(desiredRigAuthority),
		desiredRigAuthority,
		lastEventArtifactSha256: canonicalArtifactSha256(latest),
		events,
	});
}

export function initializeRigJournal(
	input: InitializeRigJournalInput,
	overrides: Partial<JournalDependencies> = {},
): RigJournalSnapshot {
	if (existsSync(input.path))
		fail("refusing to replace an existing rig journal");
	if (!SAFE_ID_RE.test(input.runId)) fail("runId is not safe");
	const deps = dependencies(overrides);
	const recordedAt = deps.clock.wallNow();
	const event: RigJournalEvent = {
		schema: "g6-c32-rig-event/1",
		envelope: {
			recordedAt,
			sequence: 1,
			runId: input.runId,
			phase: "ABSENT",
			operationId: "initialize-absent",
			clockSource: "offrunner",
		},
		previousEventArtifactSha256: null,
		state: "ABSENT",
		kind: "TRANSITION",
		details: { reason: "journal-initialized" },
	};
	const snapshot = makeSnapshot(
		canonicalClone(input.desiredRigAuthority, "desiredRigAuthority"),
		[event],
	);
	publishSnapshot(input.path, snapshot, deps);
	return snapshot;
}

export function readRigJournal(path: string): RigJournalSnapshot {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch (error) {
		fail(
			`could not parse rig journal JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return replayRigJournal(value);
}

export function appendRigJournalEvent(
	path: string,
	input: AppendRigJournalEventInput,
	overrides: Partial<JournalDependencies> = {},
): RigJournalSnapshot {
	const prior = readRigJournal(path);
	if (!SAFE_ID_RE.test(input.operationId)) fail("operationId is not safe");
	if (!LIFECYCLE_STATES.has(input.state)) fail("state is not recognized");
	if (!EVENT_KINDS.has(input.kind)) fail("event kind is not recognized");
	const deps = dependencies(overrides);
	const previous = prior.events.at(-1);
	if (!previous) fail("prior journal has no last event");
	const event: RigJournalEvent = {
		schema: "g6-c32-rig-event/1",
		envelope: {
			recordedAt: deps.clock.wallNow(),
			sequence: previous.envelope.sequence + 1,
			runId: previous.envelope.runId,
			phase: input.state,
			operationId: input.operationId,
			clockSource: "offrunner",
		},
		previousEventArtifactSha256: canonicalArtifactSha256(previous),
		state: input.state,
		kind: input.kind,
		details: canonicalClone(input.details, "event details"),
	};
	const snapshot = makeSnapshot(prior.desiredRigAuthority, [
		...prior.events,
		event,
	]);
	publishSnapshot(path, snapshot, deps);
	return snapshot;
}
