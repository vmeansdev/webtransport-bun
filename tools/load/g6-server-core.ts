import {
	emitterSliceBounds,
	nextEmitterWindowState,
	type EmitterPhase,
	type EmitterWindowState,
} from "./g6-artifact.ts";
import {
	EMITTER_SLICE_HZ,
	SNAPSHOT_HZ,
	SNAPSHOT_PAYLOAD_BYTES,
	snapshotDatagrams,
} from "./g6-plan.ts";
import { LatencyHistogram } from "./latency-histogram.ts";
import {
	CLASS_ACK,
	CLASS_ACTION,
	CLASS_RAID,
	CLASS_RAID_JOIN,
	CLASS_SNAPSHOT,
	STAMP_BYTES_V3,
	decodeStamp,
	encodeStamp,
	writeReflection,
} from "./latency-stamp.ts";

export type SessionKind = "player" | "publisher" | "raid";

export type Player = {
	send: (datagrams: readonly Uint8Array[]) => Promise<{
		sent: number;
		error?: unknown;
	}>;
	sendOne: (d: Uint8Array) => unknown;
	acceptedAtMs: number;
	kind: SessionKind;
	alive: boolean;
};

export type EmitterCounters = {
	snapshotIssued: number;
	snapshotDue: number;
	ackIssued: number;
	ackDue: number;
	raidForwarded: number;
	sendErrors: number;
	sendEventsSkipped: number;
	batchPartialCompletions: number;
};

export type ServerState = {
	rxByClass: Map<number, number>;
	rxTotal: number;
	rxUnstamped: number;
	rxSurvivors: number;
	acceptSeries: number[];
	emitter: EmitterCounters;
	ingestToForward: LatencyHistogram;
	ingestToForwardSteadyDrain: LatencyHistogram;
	publisherGaps: number[];
	publisherGapsSteadyDrain: number[];
	publisherStamped: number;
	publisherStampedSteadyDrain: number;
	publisherArrivals: number;
	publisherArrivalsSteadyDrain: number;
	emitterLag: LatencyHistogram;
	emitterLagSteady: LatencyHistogram;
	emitterLagStorm: LatencyHistogram;
	hold: LatencyHistogram;
	holdSteadyDrain: LatencyHistogram;
	holdStorm: LatencyHistogram;
};

export function freshG6ServerState(): ServerState {
	return {
		rxByClass: new Map(),
		rxTotal: 0,
		rxUnstamped: 0,
		rxSurvivors: 0,
		acceptSeries: [],
		emitter: {
			snapshotIssued: 0,
			snapshotDue: 0,
			ackIssued: 0,
			ackDue: 0,
			raidForwarded: 0,
			sendErrors: 0,
			sendEventsSkipped: 0,
			batchPartialCompletions: 0,
		},
		ingestToForward: new LatencyHistogram(),
		ingestToForwardSteadyDrain: new LatencyHistogram(),
		publisherGaps: [],
		publisherGapsSteadyDrain: [],
		publisherStamped: 0,
		publisherStampedSteadyDrain: 0,
		publisherArrivals: 0,
		publisherArrivalsSteadyDrain: 0,
		emitterLag: new LatencyHistogram(),
		emitterLagSteady: new LatencyHistogram(),
		emitterLagStorm: new LatencyHistogram(),
		hold: new LatencyHistogram(),
		holdSteadyDrain: new LatencyHistogram(),
		holdStorm: new LatencyHistogram(),
	};
}

export type G6ServerCorePlan = Readonly<{
	snapshotPayloadBytes: number;
	snapshotDatagrams: number;
	snapshotHz: number;
	emitterSliceHz: number;
	sliceMs: number;
	slicesPerTick: number;
	snapshotFillByte: number;
}>;

export const REGISTERED_G6_SERVER_CORE_PLAN: G6ServerCorePlan = Object.freeze({
	snapshotPayloadBytes: SNAPSHOT_PAYLOAD_BYTES,
	snapshotDatagrams: snapshotDatagrams(),
	snapshotHz: SNAPSHOT_HZ,
	emitterSliceHz: EMITTER_SLICE_HZ,
	sliceMs: 1000 / EMITTER_SLICE_HZ,
	slicesPerTick: Math.max(1, Math.round(EMITTER_SLICE_HZ / SNAPSHOT_HZ)),
	snapshotFillByte: 0x77,
});

export type G6ServerCoreSession = {
	sendDatagramBatch: (datagrams: readonly Uint8Array[]) => Promise<{
		sent: number;
		error?: unknown;
	}>;
	sendDatagram: (datagram: Uint8Array) => unknown;
	incomingDatagrams: () => AsyncIterable<Uint8Array>;
	closed: Promise<unknown>;
};

export type G6ServerCoreIntervalScheduler = {
	setInterval: (tick: () => void, delayMs: number) => unknown;
	clearInterval: (handle: unknown) => void;
};

export function createG6ServerCore(options: {
	plan?: G6ServerCorePlan;
	clock: { now: () => number };
	nowMs: () => number;
	phaseState: { current: EmitterPhase };
	state: () => ServerState;
	severAtMs: () => number | null;
}): {
	plan: G6ServerCorePlan;
	players: Player[];
	raidMembers: Player[];
	onSession: (session: G6ServerCoreSession) => void;
	startEmitter: (
		phase: () => EmitterPhase,
		scheduler?: G6ServerCoreIntervalScheduler,
	) => () => void;
} {
	const plan = options.plan ?? REGISTERED_G6_SERVER_CORE_PLAN;
	const players: Player[] = [];
	const raidMembers: Player[] = [];

	const onSession = (session: G6ServerCoreSession): void => {
		const acceptedAtMs = options.nowMs();
		options.state().acceptSeries.push(acceptedAtMs);
		const player: Player = {
			send: (datagrams) => session.sendDatagramBatch(datagrams),
			sendOne: (datagram) => session.sendDatagram(datagram),
			acceptedAtMs,
			kind: "player",
			alive: true,
		};
		players.push(player);
		session.closed.then(
			() => {
				player.alive = false;
			},
			() => {
				player.alive = false;
			},
		);
		void (async () => {
			let lastPublisherArrivalNs: number | null = null;
			for await (const datagram of session.incomingDatagrams()) {
				const entryNs = options.clock.now();
				const state = options.state();
				state.rxTotal += 1;
				const stamp = decodeStamp(datagram);
				if (stamp === null) {
					state.rxUnstamped += 1;
					continue;
				}
				state.rxByClass.set(
					stamp.klass,
					(state.rxByClass.get(stamp.klass) ?? 0) + 1,
				);
				const severAtMs = options.severAtMs();
				if (severAtMs !== null && player.acceptedAtMs < severAtMs) {
					state.rxSurvivors += 1;
				}

				if (stamp.klass === CLASS_RAID_JOIN) {
					player.kind = "raid";
					if (!raidMembers.includes(player)) raidMembers.push(player);
					continue;
				}

				if (stamp.klass === CLASS_RAID) {
					player.kind = "publisher";
					state.publisherArrivals += 1;
					state.publisherStamped += 1;
					if (
						options.phaseState.current === "steady" ||
						options.phaseState.current === "drain"
					) {
						state.publisherArrivalsSteadyDrain += 1;
						state.publisherStampedSteadyDrain += 1;
					}
					if (lastPublisherArrivalNs !== null) {
						const gapNs = entryNs - lastPublisherArrivalNs;
						state.publisherGaps.push(gapNs);
						if (
							options.phaseState.current === "steady" ||
							options.phaseState.current === "drain"
						) {
							state.publisherGapsSteadyDrain.push(gapNs);
						}
					}
					lastPublisherArrivalNs = entryNs;
					forwardToRaid(
						datagram,
						entryNs,
						state,
						raidMembers,
						options.clock,
						options.phaseState,
					);
					continue;
				}

				if (stamp.klass === CLASS_ACTION) {
					state.emitter.ackDue += 1;
					const ack = new Uint8Array(STAMP_BYTES_V3);
					ack.set(datagram.subarray(0, STAMP_BYTES_V3));
					const sendNs = options.clock.now();
					const ok = writeReflection(ack, {
						echoActualNs: stamp.actualNs,
						serverSendNs: sendNs,
						holdNs: sendNs - entryNs,
						klass: CLASS_ACK,
						sequence: stamp.sequence,
					});
					if (!ok) {
						state.emitter.sendEventsSkipped += 1;
						continue;
					}
					state.hold.record(sendNs - entryNs);
					if (
						options.phaseState.current === "steady" ||
						options.phaseState.current === "drain"
					) {
						state.holdSteadyDrain.record(sendNs - entryNs);
					} else if (options.phaseState.current === "storm") {
						state.holdStorm.record(sendNs - entryNs);
					}
					try {
						player.sendOne(ack);
						state.emitter.ackIssued += 1;
					} catch {
						state.emitter.sendErrors += 1;
					}
				}
			}
		})().catch(() => {});
	};

	const startEmitter = (
		phase: () => EmitterPhase,
		scheduler: G6ServerCoreIntervalScheduler = {
			setInterval: (tick, delayMs) => setInterval(tick, delayMs),
			clearInterval: (handle) =>
				clearInterval(handle as ReturnType<typeof setInterval>),
		},
	): (() => void) => {
		const body = new Uint8Array(plan.snapshotPayloadBytes);
		body.fill(plan.snapshotFillByte);
		let sequence = 0;
		let stopped = false;
		let window: EmitterWindowState | null = null;
		const sliceNs = plan.sliceMs * 1e6;
		const timer = scheduler.setInterval(() => {
			if (stopped) return;
			const planned = nextEmitterWindowState(
				window,
				phase(),
				options.clock.now(),
				sliceNs,
			);
			window = planned.window;
			if (!planned.emit) return;
			const { deadlineNs, sliceIndex } = planned.emit;
			const handoffNs = options.clock.now();
			const state = options.state();
			const lagNs = Math.max(0, handoffNs - deadlineNs);
			state.emitterLag.record(lagNs);
			if (planned.emit.kind === "steady") {
				state.emitterLagSteady.record(lagNs);
			} else if (planned.emit.kind === "storm") {
				state.emitterLagStorm.record(lagNs);
			}
			const target = players.filter(
				(player) => player.alive && player.kind === "player",
			);
			const { from, to } = emitterSliceBounds(
				target.length,
				plan.slicesPerTick,
				sliceIndex,
			);
			const chunk = target.slice(from, to);
			for (const player of chunk) {
				sequence += 1;
				const batch: Uint8Array[] = [];
				for (let index = 0; index < plan.snapshotDatagrams; index += 1) {
					const datagram = new Uint8Array(plan.snapshotPayloadBytes);
					datagram.set(body);
					encodeStamp(datagram, {
						version: 3,
						intendedNs: deadlineNs,
						actualNs: handoffNs,
						sequence: sequence * plan.snapshotDatagrams + index,
						klass: CLASS_SNAPSHOT,
					});
					batch.push(datagram);
				}
				state.emitter.snapshotDue += plan.snapshotDatagrams;
				player
					.send(batch)
					.then((result) => {
						state.emitter.snapshotIssued += result.sent;
						if (result.sent < batch.length) {
							state.emitter.batchPartialCompletions += 1;
						}
					})
					.catch(() => {
						state.emitter.sendErrors += 1;
					});
			}
		}, plan.sliceMs);
		(timer as { unref?: () => void }).unref?.();
		return () => {
			stopped = true;
			scheduler.clearInterval(timer);
		};
	};

	return {
		plan,
		players,
		raidMembers,
		onSession,
		startEmitter,
	};
}

function forwardToRaid(
	datagram: Uint8Array,
	entryNs: number,
	state: ServerState,
	raidMembers: Player[],
	clock: { now: () => number },
	phaseState: { current: EmitterPhase },
): void {
	let first = true;
	for (const member of raidMembers) {
		if (!member.alive) continue;
		const out = new Uint8Array(datagram.byteLength);
		out.set(datagram);
		try {
			member.sendOne(out);
			state.emitter.raidForwarded += 1;
			if (first) {
				const dwellNs = clock.now() - entryNs;
				state.ingestToForward.record(dwellNs);
				if (phaseState.current === "steady" || phaseState.current === "drain") {
					state.ingestToForwardSteadyDrain.record(dwellNs);
				}
				first = false;
			}
		} catch {
			state.emitter.sendErrors += 1;
		}
	}
}
