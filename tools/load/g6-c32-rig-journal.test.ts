import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalArtifactSha256 } from "./g6-c32-freeze-model.ts";
import {
	appendRigJournalEvent,
	initializeRigJournal,
	type JournalClock,
	type JournalPublishBoundary,
	readRigCreateIntentRecord,
	readRigJournal,
	replayRigJournal,
	writeRigCreateIntentRecord,
} from "./g6-c32-rig-journal.ts";

const temporaryRoots: string[] = [];

class FakeJournalClock implements JournalClock {
	readonly #values: string[];

	constructor(values: string[]) {
		this.#values = [...values];
	}

	wallNow(): string {
		const value = this.#values.shift();
		if (!value) throw new Error("fake journal clock exhausted");
		return value;
	}
}

function makePath(): { root: string; path: string } {
	const root = mkdtempSync(join(tmpdir(), "g6-c32-journal-"));
	temporaryRoots.push(root);
	return { root, path: join(root, "rig-state.json") };
}

const desiredRigAuthority = {
	managementTag: "g6-managed",
	runTag: "g6-c32-run-test",
	roles: ["server", "generator"],
	profile: {
		region: "ams3",
		size: "c-32",
		image: "ubuntu-24-04-x64",
	},
};

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("G6 c32 durable rig journal", () => {
	test("records exact provider mutation intent and observation events", () => {
		const { path } = makePath();
		initializeRigJournal(
			{ path, runId: "g6-c32-intent-events", desiredRigAuthority },
			{
				clock: new FakeJournalClock(["2026-08-30T12:00:00.000Z"]),
				randomId: () => "init",
			},
		);
		const events = [
			["CREATE_INTENT", "create-server", { role: "server", providerId: null }],
			[
				"CREATE_OBSERVED",
				"observe-server",
				{ role: "server", providerId: 101 },
			],
			["DESTROY_INTENT", "destroy-server", { role: "server", providerId: 101 }],
			[
				"DESTROY_CONFIRMED",
				"confirm-server-destroyed",
				{ role: "server", providerId: 101 },
			],
		] as const;
		for (const [index, [kind, operationId, details]] of events.entries()) {
			const spendLedgerHeadArtifactSha256 = `${index + 1}`.repeat(64);
			const snapshot = appendRigJournalEvent(
				path,
				{
					state: "CREATING",
					kind,
					operationId,
					details,
					spendLedgerHeadArtifactSha256,
				},
				{
					clock: new FakeJournalClock([`2026-08-30T12:00:0${index + 1}.000Z`]),
					randomId: () => `event-${index}`,
				},
			);
			const latest = snapshot.events.at(-1);
			expect(latest?.kind).toBe(kind);
			expect(latest?.envelope.operationId).toBe(operationId);
			expect(latest?.spendLedgerHeadArtifactSha256).toBe(
				spendLedgerHeadArtifactSha256,
			);
			expect(canonicalArtifactSha256(latest)).toBe(
				snapshot.lastEventArtifactSha256,
			);
		}
	});

	test("durably chains timestamped OPEN, CONSUMED, and CLOSED create intent records", () => {
		const { root } = makePath();
		const path = join(root, "create-intent.json");
		const clock = new FakeJournalClock([
			"2026-08-30T12:00:00.000Z",
			"2026-08-30T12:01:00.000Z",
			"2026-08-30T12:02:00.000Z",
		]);
		const openIntent = {
			state: "OPEN",
			mutationNonce: "nonce-123",
			notBefore: "2026-08-30T12:00:00.000Z",
			requestSha256: "5".repeat(64),
		};
		const open = writeRigCreateIntentRecord(
			{
				path,
				runId: "g6-c32-intent-test",
				phase: "CREATING",
				operationId: "create-pair-intent",
				desiredRigAuthority,
				intent: openIntent,
			},
			{ clock, randomId: () => "open" },
		);
		expect(open.envelope.recordedAt).toBe("2026-08-30T12:00:00.000Z");
		expect(open.envelope.sequence).toBe(1);
		expect(open.previousRecordArtifactSha256).toBeNull();

		const consumed = writeRigCreateIntentRecord(
			{
				path,
				runId: "g6-c32-intent-test",
				phase: "PROVISIONED",
				operationId: "consume-create-intent",
				desiredRigAuthority,
				intent: { ...openIntent, state: "CONSUMED" },
			},
			{ clock, randomId: () => "consumed" },
		);
		expect(consumed.envelope.sequence).toBe(2);
		expect(consumed.previousRecordArtifactSha256).toBe(
			canonicalArtifactSha256(open),
		);

		const closed = writeRigCreateIntentRecord(
			{
				path,
				runId: "g6-c32-intent-test",
				phase: "DESTROYED",
				operationId: "close-create-intent",
				desiredRigAuthority,
				intent: { ...openIntent, state: "CLOSED" },
			},
			{ clock, randomId: () => "closed" },
		);
		expect(closed.envelope.sequence).toBe(3);
		expect(closed.previousRecordArtifactSha256).toBe(
			canonicalArtifactSha256(consumed),
		);
		expect(readRigCreateIntentRecord(path)).toEqual(closed);
		expect(() =>
			writeRigCreateIntentRecord(
				{
					path,
					runId: "g6-c32-intent-test",
					phase: "CREATING",
					operationId: "reopen-create-intent",
					desiredRigAuthority,
					intent: openIntent,
				},
				{
					clock: new FakeJournalClock(["2026-08-30T12:03:00.000Z"]),
					randomId: () => "reopen",
				},
			),
		).toThrow(/transition|CLOSED/i);
	});

	test("starts ABSENT and appends a timestamped digest-linked sequence", () => {
		const { path } = makePath();
		const clock = new FakeJournalClock([
			"2026-08-30T12:00:00.000Z",
			"2026-08-30T12:00:01.000Z",
			"2026-08-30T12:00:02.000Z",
		]);
		const initial = initializeRigJournal(
			{
				path,
				runId: "g6-c32-journal-test",
				desiredRigAuthority,
			},
			{ clock, randomId: () => "initial" },
		);
		expect(initial.events).toHaveLength(1);
		expect(initial.events[0]?.state).toBe("ABSENT");
		expect(initial.events[0]?.envelope.sequence).toBe(1);
		expect(initial.events[0]?.envelope.recordedAt).toBe(
			"2026-08-30T12:00:00.000Z",
		);
		expect(initial.events[0]?.previousEventArtifactSha256).toBeNull();

		const creating = appendRigJournalEvent(
			path,
			{
				state: "CREATING",
				kind: "INTENT",
				operationId: "create-pair-intent",
				details: { roles: ["server", "generator"], attempt: 1 },
			},
			{ clock, randomId: () => "creating" },
		);
		const provisioned = appendRigJournalEvent(
			path,
			{
				state: "PROVISIONED",
				kind: "RESULT",
				operationId: "create-pair-result",
				details: { dropletIds: [101, 102] },
			},
			{ clock, randomId: () => "provisioned" },
		);

		expect(creating.events[1]?.previousEventArtifactSha256).toBe(
			canonicalArtifactSha256(initial.events[0]),
		);
		expect(provisioned.events[2]?.previousEventArtifactSha256).toBe(
			canonicalArtifactSha256(creating.events[1]),
		);
		expect(provisioned.lastEventArtifactSha256).toBe(
			canonicalArtifactSha256(provisioned.events[2]),
		);
		expect(provisioned.events.map((event) => event.envelope.sequence)).toEqual([
			1, 2, 3,
		]);
		expect(
			provisioned.events.map((event) => event.envelope.recordedAt),
		).toEqual([
			"2026-08-30T12:00:00.000Z",
			"2026-08-30T12:00:01.000Z",
			"2026-08-30T12:00:02.000Z",
		]);
		expect(readRigJournal(path)).toEqual(provisioned);
	});

	test("replay rejects missing, reordered, duplicated, truncated, and tampered events", () => {
		const { path } = makePath();
		const clock = new FakeJournalClock([
			"2026-08-30T12:00:00.000Z",
			"2026-08-30T12:00:01.000Z",
			"2026-08-30T12:00:02.000Z",
		]);
		initializeRigJournal(
			{
				path,
				runId: "g6-c32-journal-replay-test",
				desiredRigAuthority,
			},
			{ clock, randomId: () => "initial" },
		);
		appendRigJournalEvent(
			path,
			{
				state: "CREATING",
				kind: "INTENT",
				operationId: "create-intent",
				details: { attempt: 1 },
			},
			{ clock, randomId: () => "creating" },
		);
		const valid = appendRigJournalEvent(
			path,
			{
				state: "PROVISIONED",
				kind: "RESULT",
				operationId: "create-result",
				details: { dropletIds: [101, 102] },
			},
			{ clock, randomId: () => "provisioned" },
		);

		const mutations: unknown[] = [
			{ ...valid, events: [] },
			{ ...valid, events: [valid.events[1], valid.events[0], valid.events[2]] },
			{ ...valid, events: [valid.events[0], valid.events[1], valid.events[1]] },
			{ ...valid, events: valid.events.slice(0, -1) },
			{
				...valid,
				events: valid.events.map((event, index) =>
					index === 2
						? { ...event, details: { dropletIds: [101, 999] } }
						: event,
				),
			},
			{
				...valid,
				events: valid.events.map((event, index) => {
					if (index !== 1) return event;
					const { previousEventArtifactSha256: _, ...missingLink } = event;
					return missingLink;
				}),
			},
		];
		for (const mutation of mutations) {
			expect(() => replayRigJournal(mutation)).toThrow();
		}

		writeFileSync(path, '{"schema":"g6-c32-rig-state/1","events":[', "utf8");
		expect(() => readRigJournal(path)).toThrow(/parse|JSON|truncated/i);
	});

	test("crash boundaries expose only the prior or complete new snapshot", () => {
		const boundaries: JournalPublishBoundary[] = [
			"before-temp-fsync",
			"after-temp-fsync",
			"after-rename",
			"before-directory-fsync",
		];
		for (const boundary of boundaries) {
			const { root, path } = makePath();
			const clock = new FakeJournalClock([
				"2026-08-30T12:00:00.000Z",
				"2026-08-30T12:00:01.000Z",
			]);
			const prior = initializeRigJournal(
				{
					path,
					runId: `g6-c32-crash-${boundary}`,
					desiredRigAuthority,
				},
				{ clock, randomId: () => `initial-${boundary}` },
			);
			expect(() =>
				appendRigJournalEvent(
					path,
					{
						state: "CREATING",
						kind: "INTENT",
						operationId: "create-intent",
						details: { boundary },
					},
					{
						clock,
						randomId: () => `append-${boundary}`,
						onPublishBoundary: (seen) => {
							if (seen === boundary) throw new Error(`crash at ${seen}`);
						},
					},
				),
			).toThrow(`crash at ${boundary}`);

			const visible = readRigJournal(path);
			if (boundary === "before-temp-fsync" || boundary === "after-temp-fsync") {
				expect(visible).toEqual(prior);
				const staged = readdirSync(root).filter((name) =>
					name.includes(".staged-2-append-"),
				);
				expect(staged).toHaveLength(1);
				const stagedSnapshot = JSON.parse(
					readFileSync(join(root, staged[0] as string), "utf8"),
				) as unknown;
				expect(replayRigJournal(stagedSnapshot).events).toHaveLength(2);
			} else {
				expect(visible.events).toHaveLength(2);
				expect(visible.events[1]?.state).toBe("CREATING");
				expect(
					readdirSync(root).filter((name) => name.includes(".staged-")),
				).toHaveLength(0);
			}
		}
	});
});
