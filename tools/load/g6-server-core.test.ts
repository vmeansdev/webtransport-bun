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
	type G6ServerCoreDueAccounting,
	type G6ServerCorePacedMirror,
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
		dueAccounting: G6ServerCoreDueAccounting;
		pacedMirror: G6ServerCorePacedMirror | null;
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
		dueAccounting: over.dueAccounting,
		pacedMirror: () => over.pacedMirror ?? null,
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

	test("routes snapshot fan-out through the paced mirror when one is injected", async () => {
		const calls: Array<{ targets: readonly string[]; bytes: number }> = [];
		let failuresToReport: Array<{ target: string; error: unknown }> = [];
		const paced: G6ServerCorePacedMirror = {
			send: (targets, payload) => {
				calls.push({ targets: [...targets], bytes: payload.byteLength });
				return { admitted: targets.length };
			},
			readReports: () => {
				const out = failuresToReport;
				failuresToReport = [];
				return out;
			},
		};
		const { core, stateRef } = makeCore({ pacedMirror: paced });
		const sessions = [queueSession(), queueSession(), queueSession()];
		for (const [index, harness] of sessions.entries()) {
			core.onSession({ ...harness.session, id: `session-${index}` });
		}
		await flushAsyncWork();

		const scheduled: Array<{ delay: number; tick: () => void }> = [];
		const stop = core.startEmitter(() => "steady", {
			setInterval: (tick, delay) => {
				scheduled.push({ delay, tick });
				return scheduled.length;
			},
			clearInterval: () => {},
		});

		scheduled[0]?.tick();
		await flushAsyncWork();
		failuresToReport = [{ target: "session-1", error: "E_SESSION_CLOSED" }];
		scheduled[0]?.tick();
		await flushAsyncWork();
		scheduled[0]?.tick();
		await flushAsyncWork();
		stop();

		// Three paced admissions per slice (one per snapshot datagram); the
		// per-player batch path must stay untouched.
		expect(calls).toHaveLength(9);
		for (const call of calls) {
			expect(call.targets).toHaveLength(1);
			expect(call.bytes).toBe(1150);
		}
		for (const harness of sessions) {
			expect(harness.sentBatches).toHaveLength(0);
		}
		expect(stateRef.value.emitter.snapshotDue).toBe(9);
		// 9 admitted minus the one deferred failure drained on the second slice.
		expect(stateRef.value.emitter.snapshotIssued).toBe(8);
		expect(stateRef.value.emitter.sendErrors).toBe(1);
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

	test("operationally gates only the four declared diagnostic switches", async () => {
		const runLane = async (switches: {
			recordClauseLatencyHistograms: boolean;
			retainPerDatagramDiagnosticSamples: boolean;
			emitVerboseProgressLogs: boolean;
			materializeHumanReadableRows: boolean;
		}) => {
			const phaseState = { current: "steady" as EmitterPhase };
			const stateRef = { value: freshG6ServerState() };
			// The tick's window-start and handoff stamps stay within one slice of
			// each other: a synthetic jump here would (correctly) trigger the
			// emitter's timer catch-up and double the lag recordings this test pins.
			const nowNs = [400, 450, 500, 550, 600, 625, 1_000, 1_000, 1_000, 1_000];
			const nowMs = [1, 2, 3, 4];
			const verboseLogs: string[] = [];
			const humanReadableRows: string[] = [];
			const core = createG6ServerCore({
				plan: REGISTERED_G6_SERVER_CORE_PLAN,
				clock: {
					now: () => nowNs.shift() ?? 0,
				},
				nowMs: () => nowMs.shift() ?? 0,
				phaseState,
				state: () => stateRef.value,
				severAtMs: () => null,
				instrumentation: {
					switches,
					emitVerboseProgress: (message) => {
						verboseLogs.push(message);
					},
					materializeHumanReadableRow: (row) => {
						humanReadableRows.push(row);
					},
				},
			});

			const player = queueSession();
			const raid = queueSession([
				stampedDatagram(CLASS_RAID_JOIN, { sequence: 1 }),
			]);
			const publisher = queueSession([
				stampedDatagram(CLASS_RAID, { actualNs: 470, sequence: 2 }),
				stampedDatagram(CLASS_RAID, { actualNs: 520, sequence: 3 }),
			]);
			const action = queueSession([
				stampedDatagram(CLASS_ACTION, {
					intendedNs: 40,
					actualNs: 590,
					sequence: 7,
				}),
			]);

			core.onSession(player.session);
			core.onSession(raid.session);
			core.onSession(publisher.session);
			core.onSession(action.session);
			await flushAsyncWork();

			const scheduled: Array<() => void> = [];
			core.startEmitter(() => "steady", {
				setInterval: (tick) => {
					scheduled.push(tick);
					return scheduled.length;
				},
				clearInterval: () => {},
			});
			scheduled[0]?.();
			await flushAsyncWork();

			return {
				state: stateRef.value,
				player,
				raid,
				action,
				verboseLogs,
				humanReadableRows,
			};
		};

		const full = await runLane({
			recordClauseLatencyHistograms: true,
			retainPerDatagramDiagnosticSamples: true,
			emitVerboseProgressLogs: true,
			materializeHumanReadableRows: true,
		});
		const minimal = await runLane({
			recordClauseLatencyHistograms: false,
			retainPerDatagramDiagnosticSamples: false,
			emitVerboseProgressLogs: false,
			materializeHumanReadableRows: false,
		});

		expect(full.state.emitter).toEqual(minimal.state.emitter);
		expect(full.state.rxTotal).toBe(minimal.state.rxTotal);
		expect([...full.state.rxByClass.entries()]).toEqual([
			...minimal.state.rxByClass.entries(),
		]);
		expect(full.player.sentBatches.map((batch) => batch.length)).toEqual(
			minimal.player.sentBatches.map((batch) => batch.length),
		);
		expect(full.raid.sentOne).toHaveLength(minimal.raid.sentOne.length);
		expect(full.action.sentOne).toHaveLength(minimal.action.sentOne.length);

		expect(full.state.hold.summary().count).toBe(1);
		expect(full.state.holdSteadyDrain.summary().count).toBe(1);
		expect(full.state.ingestToForward.summary().count).toBe(2);
		expect(full.state.ingestToForwardSteadyDrain.summary().count).toBe(2);
		expect(full.state.emitterLag.summary().count).toBe(1);
		expect(full.state.emitterLagSteady.summary().count).toBe(1);
		expect(full.state.publisherGaps).toHaveLength(1);
		expect(full.state.publisherGapsSteadyDrain).toHaveLength(1);
		expect(full.verboseLogs.length).toBeGreaterThan(0);
		expect(full.humanReadableRows.length).toBeGreaterThan(0);

		expect(minimal.state.hold.summary().count).toBe(0);
		expect(minimal.state.holdSteadyDrain.summary().count).toBe(0);
		expect(minimal.state.ingestToForward.summary().count).toBe(0);
		expect(minimal.state.ingestToForwardSteadyDrain.summary().count).toBe(0);
		expect(minimal.state.emitterLag.summary().count).toBe(0);
		expect(minimal.state.emitterLagSteady.summary().count).toBe(0);
		expect(minimal.state.publisherGaps).toHaveLength(0);
		expect(minimal.state.publisherGapsSteadyDrain).toHaveLength(0);
		expect(minimal.verboseLogs).toHaveLength(0);
		expect(minimal.humanReadableRows).toHaveLength(0);
	});

	test("counts all immutable steady slices as due even when callback lag skips 14 timer firings", async () => {
		const nowNs: number[] = [];
		for (let index = 0; index < 236; index += 1) {
			const observedNs = Math.round(index * 21_280_000);
			nowNs.push(observedNs, observedNs);
		}
		const { core, stateRef } = makeCore({
			nowNs,
			nowMs: Array.from({ length: 20 }, (_, index) => index + 1),
			dueAccounting: {
				plannedSessions: 20,
				steadyWindowSec: 5,
			},
		});
		const sessions = Array.from({ length: 20 }, () => queueSession());
		for (const harness of sessions) {
			core.onSession(harness.session);
		}
		await flushAsyncWork();

		const scheduled: Array<() => void> = [];
		core.startEmitter(() => "steady", {
			setInterval: (tick) => {
				scheduled.push(tick);
				return scheduled.length;
			},
			clearInterval: () => {},
		});

		for (let index = 0; index < 236; index += 1) {
			scheduled[0]?.();
		}
		await flushAsyncWork();

		expect(stateRef.value.emitter.snapshotDue).toBe(1500);
		// Before timer catch-up this read 1416: the 14 skipped firings were lost
		// demand (gate g6-sharded-01's S3 MISS, duty 0.949-0.988). Late slices
		// are now emitted in bounded catch-up passes, so issued meets due.
		expect(stateRef.value.emitter.snapshotIssued).toBe(1500);
	});

	test("a plannedSessions getter books the population it reads at booking time", async () => {
		const nowNs: number[] = [];
		for (let index = 0; index < 300; index += 1) {
			const observedNs = Math.round(index * 21_280_000);
			nowNs.push(observedNs, observedNs);
		}
		// One shared core serving arms of different sizes: the booking must
		// follow the getter's current value, not a construction-time snapshot.
		let planned = 0;
		const { core, stateRef } = makeCore({
			nowNs,
			nowMs: Array.from({ length: 20 }, (_, index) => index + 1),
			dueAccounting: {
				plannedSessions: () => planned,
				steadyWindowSec: 5,
			},
		});
		planned = 20;
		const sessions = Array.from({ length: 20 }, () => queueSession());
		for (const harness of sessions) {
			core.onSession(harness.session);
		}
		await flushAsyncWork();

		const scheduled: Array<() => void> = [];
		core.startEmitter(() => "steady", {
			setInterval: (tick) => {
				scheduled.push(tick);
				return scheduled.length;
			},
			clearInterval: () => {},
		});

		for (let index = 0; index < 236; index += 1) {
			scheduled[0]?.();
		}
		await flushAsyncWork();

		expect(stateRef.value.emitter.snapshotDue).toBe(1500);
	});
});
