import { describe, expect, test } from "bun:test";
import type { EmitterPhase } from "./g6-artifact.ts";
import {
	CLASS_ACK,
	CLASS_ACTION,
	CLASS_RAID,
	CLASS_RAID_JOIN,
	CLASS_SNAPSHOT,
	STAMP_BYTES_V3,
	decodeStamp,
	encodeStamp,
} from "./latency-stamp.ts";
import {
	REGISTERED_G6_SERVER_CORE_PLAN,
	createG6ServerCore,
	freshG6ServerState,
} from "./g6-server-core.ts";

type FakeSession = {
	sendDatagramBatch: (datagrams: readonly Uint8Array[]) => Promise<{
		sent: number;
		error?: unknown;
	}>;
	sendDatagram: (datagram: Uint8Array) => unknown;
	incomingDatagrams: () => AsyncIterable<Uint8Array>;
	closed: Promise<void>;
};

function stampedDatagram(
	klass: number,
	over: Partial<{
		intendedNs: number;
		actualNs: number;
		sequence: number;
	}> = {},
): Uint8Array {
	const datagram = new Uint8Array(STAMP_BYTES_V3);
	encodeStamp(datagram, {
		version: 3,
		intendedNs: over.intendedNs ?? 40,
		actualNs: over.actualNs ?? 90,
		sequence: over.sequence ?? 7,
		klass,
	});
	return datagram;
}

function queueSession(datagrams: Uint8Array[] = []): {
	session: FakeSession;
	sentOne: Uint8Array[];
	sentBatches: Uint8Array[][];
} {
	const sentOne: Uint8Array[] = [];
	const sentBatches: Uint8Array[][] = [];
	const session: FakeSession = {
		sendDatagramBatch: async (batch) => {
			sentBatches.push(batch.map((datagram) => datagram));
			return { sent: batch.length };
		},
		sendDatagram: (datagram) => {
			sentOne.push(datagram);
		},
		incomingDatagrams: async function* () {
			for (const datagram of datagrams) {
				yield datagram;
			}
		},
		closed: new Promise(() => {}),
	};
	return { session, sentOne, sentBatches };
}

function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushAsyncWork(): Promise<void> {
	await Promise.resolve();
	await Bun.sleep(0);
}

function makeCore(
	over: Partial<{
		nowNs: number[];
		nowMs: number[];
		phase: EmitterPhase;
		severAtMs: number | null;
	}> = {},
) {
	const phaseState = { current: over.phase ?? ("steady" as EmitterPhase) };
	const stateRef = { value: freshG6ServerState() };
	const severRef = { value: over.severAtMs ?? null };
	const nowNs = [...(over.nowNs ?? [100, 125, 150, 175, 200, 225, 250, 275])];
	const nowMs = [...(over.nowMs ?? [5, 10, 15, 20, 25, 30])];
	const core = createG6ServerCore({
		plan: REGISTERED_G6_SERVER_CORE_PLAN,
		clock: {
			now: () => nowNs.shift() ?? 0,
		},
		nowMs: () => nowMs.shift() ?? 0,
		phaseState,
		state: () => stateRef.value,
		severAtMs: () => severRef.value,
	});
	return { core, phaseState, stateRef, severRef };
}

describe("g6 server core", () => {
	test("decodes ACTION stamps and reflects one unbatched ACK", async () => {
		const { core, stateRef, severRef } = makeCore({
			nowNs: [100, 125],
			nowMs: [5],
		});
		const datagram = stampedDatagram(CLASS_ACTION, {
			intendedNs: 40,
			actualNs: 90,
			sequence: 7,
		});
		const harness = queueSession([datagram]);

		core.onSession(harness.session);
		severRef.value = 10;
		await flushAsyncWork();

		expect(harness.sentOne).toHaveLength(1);
		const ackBytes = harness.sentOne[0];
		expect(ackBytes).toBeDefined();
		const ack = decodeStamp(ackBytes as Uint8Array);
		expect(ack).toMatchObject({
			version: 3,
			intendedNs: 0,
			actualNs: 125,
			echoActualNs: 90,
			holdNs: 25,
			klass: CLASS_ACK,
			sequence: 7,
		});
		expect(stateRef.value.rxTotal).toBe(1);
		expect(stateRef.value.rxSurvivors).toBe(1);
		expect(stateRef.value.rxByClass.get(CLASS_ACTION)).toBe(1);
		expect(stateRef.value.emitter.ackDue).toBe(1);
		expect(stateRef.value.emitter.ackIssued).toBe(1);
		expect(stateRef.value.hold.summary().count).toBe(1);
		expect(stateRef.value.holdSteadyDrain.summary().count).toBe(1);
		expect(stateRef.value.holdStorm.summary().count).toBe(0);
	});

	test("emits three fresh 1150-byte snapshot datagrams through one batch per slice", async () => {
		const { core, stateRef } = makeCore({
			nowNs: [
				1_000, 1_000, 1_020_000_000, 1_020_000_000, 1_040_000_000,
				1_040_000_000,
			],
			nowMs: [1, 2, 3],
		});
		const sessions = [queueSession(), queueSession(), queueSession()];
		for (const harness of sessions) {
			core.onSession(harness.session);
		}
		await flushAsyncWork();

		const scheduled: Array<{ delay: number; tick: () => void }> = [];
		const cleared: unknown[] = [];
		const stop = core.startEmitter(() => "steady", {
			setInterval: (tick, delay) => {
				scheduled.push({ delay, tick });
				return scheduled.length;
			},
			clearInterval: (handle) => {
				cleared.push(handle);
			},
		});

		expect(Object.isFrozen(REGISTERED_G6_SERVER_CORE_PLAN)).toBe(true);
		expect(REGISTERED_G6_SERVER_CORE_PLAN.snapshotPayloadBytes).toBe(1150);
		expect(REGISTERED_G6_SERVER_CORE_PLAN.snapshotDatagrams).toBe(3);
		expect(REGISTERED_G6_SERVER_CORE_PLAN.sliceMs).toBe(20);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.delay).toBe(20);

		scheduled[0]?.tick();
		await flushAsyncWork();
		scheduled[0]?.tick();
		await flushAsyncWork();
		scheduled[0]?.tick();
		await flushAsyncWork();
		stop();

		expect(cleared).toEqual([1]);
		expect(stateRef.value.emitter.snapshotDue).toBe(9);
		expect(stateRef.value.emitter.snapshotIssued).toBe(9);
		for (const [index, harness] of sessions.entries()) {
			expect(harness.sentBatches).toHaveLength(1);
			const batch = harness.sentBatches[0] ?? [];
			expect(batch).toHaveLength(3);
			expect(batch[0]).not.toBe(batch[1]);
			expect(batch[1]).not.toBe(batch[2]);
			for (const [offset, datagram] of batch.entries()) {
				expect(datagram.byteLength).toBe(1150);
				const stamp = decodeStamp(datagram);
				expect(stamp).toMatchObject({
					version: 3,
					klass: CLASS_SNAPSHOT,
					intendedNs: 1_000 + index * 20_000_000,
					actualNs: [1_000, 1_020_000_000, 1_040_000_000][index],
					sequence: index * 3 + offset + 3,
				});
			}
		}
	});

	test("discovers raid roles from session traffic and forwards publisher datagrams to raid members", async () => {
		const { core, stateRef } = makeCore({
			nowNs: [400, 450, 475, 500, 525, 550, 575],
			nowMs: [1, 2],
		});
		const raid = queueSession([
			stampedDatagram(CLASS_RAID_JOIN, { sequence: 1 }),
		]);
		const publisherFrame = stampedDatagram(CLASS_RAID, {
			actualNs: 470,
			sequence: 2,
		});
		const publisher = queueSession([publisherFrame]);

		core.onSession(raid.session);
		core.onSession(publisher.session);
		await flushAsyncWork();

		expect(core.players).toHaveLength(2);
		expect(core.players[0]?.kind).toBe("raid");
		expect(core.players[1]?.kind).toBe("publisher");
		expect(core.raidMembers).toHaveLength(1);
		expect(core.raidMembers[0]).toBe(core.players[0]);
		expect(raid.sentOne).toHaveLength(1);
		expect(raid.sentOne[0]).not.toBe(publisherFrame);
		expect(Array.from(raid.sentOne[0] ?? [])).toEqual(
			Array.from(publisherFrame),
		);
		expect(stateRef.value.rxByClass.get(CLASS_RAID_JOIN)).toBe(1);
		expect(stateRef.value.rxByClass.get(CLASS_RAID)).toBe(1);
		expect(stateRef.value.publisherArrivals).toBe(1);
		expect(stateRef.value.publisherStamped).toBe(1);
		expect(stateRef.value.publisherArrivalsSteadyDrain).toBe(1);
		expect(stateRef.value.publisherStampedSteadyDrain).toBe(1);
		expect(stateRef.value.ingestToForward.summary().count).toBe(1);
		expect(stateRef.value.ingestToForwardSteadyDrain.summary().count).toBe(1);
		expect(stateRef.value.emitter.raidForwarded).toBe(1);
	});

	test("counts unstamped receives separately and only records steady or drain hold windows", async () => {
		const { core, phaseState, stateRef } = makeCore({
			nowNs: [800, 825, 850],
			nowMs: [1],
			phase: "storm",
		});
		const harness = queueSession([
			new Uint8Array(10),
			stampedDatagram(CLASS_ACTION),
		]);

		core.onSession(harness.session);
		await flushAsyncWork();

		expect(stateRef.value.rxTotal).toBe(2);
		expect(stateRef.value.rxUnstamped).toBe(1);
		expect(stateRef.value.rxByClass.get(CLASS_ACTION)).toBe(1);
		expect(stateRef.value.hold.summary().count).toBe(1);
		expect(stateRef.value.holdSteadyDrain.summary().count).toBe(0);
		expect(stateRef.value.holdStorm.summary().count).toBe(1);

		phaseState.current = "drain";
		expect(phaseState.current).toBe("drain");
	});

	test("charges deferred partial batch completions to the originating state", async () => {
		const { core, stateRef } = makeCore({
			nowNs: [2_000, 2_000],
			nowMs: [1],
		});
		const pending = deferred<{ sent: number; error?: unknown }>();
		const session: FakeSession = {
			sendDatagramBatch: () => pending.promise,
			sendDatagram: () => {},
			incomingDatagrams: async function* () {},
			closed: new Promise(() => {}),
		};

		core.onSession(session);
		await flushAsyncWork();

		const scheduled: Array<() => void> = [];
		core.startEmitter(() => "steady", {
			setInterval: (tick) => {
				scheduled.push(tick);
				return scheduled.length;
			},
			clearInterval: () => {},
		});

		const oldState = stateRef.value;
		scheduled[0]?.();
		expect(oldState.emitter.snapshotDue).toBe(3);
		const newState = freshG6ServerState();
		stateRef.value = newState;

		pending.resolve({ sent: 2 });
		await flushAsyncWork();

		expect(oldState.emitter.snapshotIssued).toBe(2);
		expect(oldState.emitter.batchPartialCompletions).toBe(1);
		expect(newState.emitter.snapshotIssued).toBe(0);
		expect(newState.emitter.batchPartialCompletions).toBe(0);
	});

	test("charges deferred batch send failures to the originating state", async () => {
		const { core, stateRef } = makeCore({
			nowNs: [3_000, 3_000],
			nowMs: [1],
		});
		const pending = deferred<{ sent: number; error?: unknown }>();
		const session: FakeSession = {
			sendDatagramBatch: () => pending.promise,
			sendDatagram: () => {},
			incomingDatagrams: async function* () {},
			closed: new Promise(() => {}),
		};

		core.onSession(session);
		await flushAsyncWork();

		const scheduled: Array<() => void> = [];
		core.startEmitter(() => "steady", {
			setInterval: (tick) => {
				scheduled.push(tick);
				return scheduled.length;
			},
			clearInterval: () => {},
		});

		const oldState = stateRef.value;
		scheduled[0]?.();
		const newState = freshG6ServerState();
		stateRef.value = newState;

		pending.reject(new Error("send failed"));
		await flushAsyncWork();

		expect(oldState.emitter.sendErrors).toBe(1);
		expect(newState.emitter.sendErrors).toBe(0);
	});
});
