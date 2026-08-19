/**
 * The three originator arms gate G3 compares, and the shadow sink each one is
 * held to.
 *
 * Everything else about the egress axis — the schedule, the sessions, the
 * payload, the stamp — is identical across the arms. The only thing that varies
 * is what the originator does with the datagrams a session owes at one grid
 * event, which is the whole point: G3's subject is origination, not transport.
 *
 * Arms, gates and per-arm honesty conditions are pre-registered in
 * `docs/research/preregistrations/gate-g3.md`. This file implements that
 * document and does not get to reinterpret it.
 */

import { sendDatagramBatchChunked } from "../../packages/webtransport/src/datagram-batch.ts";

export type EgressEmitter = "serial" | "pipelined" | "batch";

export const EGRESS_EMITTERS: readonly EgressEmitter[] = [
	"serial",
	"pipelined",
	"batch",
];

export function isEgressEmitter(value: string): value is EgressEmitter {
	return (EGRESS_EMITTERS as readonly string[]).includes(value);
}

/** The batch envelope as the shipped API resolves it: prefix semantics, no throw. */
export type BatchEnvelope = { sent: number; error?: unknown };

/**
 * The part of a session the arms use. Deliberately narrower than the real
 * session type so the arms can be driven by a fake in a test, and so the
 * headroom arm's sink is the same shape as the real thing.
 */
export type SessionSender = {
	sendDatagram(bytes: Uint8Array): Promise<unknown>;
	sendDatagramBatch(datagrams: readonly Uint8Array[]): Promise<BatchEnvelope>;
};

/** One payload buffer with the 28-byte stamp writable in place. */
export type StampedSlot = {
	readonly bytes: Uint8Array;
	stamp(intendedNs: number, actualNs: number, sequence: number): void;
};

export type EventOutcome = {
	sent: number;
	errors: number;
	/** Clock read before the first element left the scheduler's hands. */
	firstActualNs: number;
	/** Clock read before the last one did. */
	lastActualNs: number;
};

/**
 * Issue one grid event's worth of datagrams through one arm.
 *
 * `pool` must hold at least `amplitude` distinct buffers: the batched send
 * copies its elements at the *call*, after every element has been stamped, so a
 * shared buffer would put the last stamp on every datagram in the batch. The
 * pool is used by all three arms so no arm is measured against a different
 * allocation shape than another (pre-registration §3.1).
 *
 * `actual` is read immediately before the element leaves the scheduler's hands
 * — the send call in `serial`/`pipelined`, the array push in `batch`. For
 * `batch` that puts the rest of the event's stamping and the whole crossing
 * *inside* the measured interval, which is the conservative direction and is
 * registered as such (§3.2).
 */
export async function emitEvent(
	emitter: EgressEmitter,
	sender: SessionSender,
	pool: readonly StampedSlot[],
	amplitude: number,
	intendedNs: number,
	sequenceBase: number,
	now: () => number,
): Promise<EventOutcome> {
	if (amplitude <= 0) {
		return { sent: 0, errors: 0, firstActualNs: 0, lastActualNs: 0 };
	}
	if (pool.length < amplitude) {
		throw new Error(
			`egress-emitter: pool of ${pool.length} cannot carry an amplitude of ${amplitude}`,
		);
	}

	let firstActualNs = 0;
	let lastActualNs = 0;

	if (emitter === "serial") {
		let sent = 0;
		let errors = 0;
		for (let k = 0; k < amplitude; k += 1) {
			const slot = pool[k] as StampedSlot;
			const actualNs = now();
			if (k === 0) firstActualNs = actualNs;
			lastActualNs = actualNs;
			slot.stamp(intendedNs, actualNs, sequenceBase + k + 1);
			try {
				await sender.sendDatagram(slot.bytes);
				sent += 1;
			} catch {
				errors += 1;
			}
		}
		return { sent, errors, firstActualNs, lastActualNs };
	}

	if (emitter === "pipelined") {
		const pending: Array<Promise<unknown>> = [];
		for (let k = 0; k < amplitude; k += 1) {
			const slot = pool[k] as StampedSlot;
			const actualNs = now();
			if (k === 0) firstActualNs = actualNs;
			lastActualNs = actualNs;
			slot.stamp(intendedNs, actualNs, sequenceBase + k + 1);
			// No await: every send is issued before any of them is settled. That is
			// the arm — the same API, the same number of crossings, without the
			// per-datagram serialization.
			pending.push(sender.sendDatagram(slot.bytes));
		}
		const results = await Promise.allSettled(pending);
		let sent = 0;
		let errors = 0;
		for (const r of results) {
			if (r.status === "fulfilled") sent += 1;
			else errors += 1;
		}
		return { sent, errors, firstActualNs, lastActualNs };
	}

	const batch: Uint8Array[] = new Array<Uint8Array>(amplitude);
	for (let k = 0; k < amplitude; k += 1) {
		const slot = pool[k] as StampedSlot;
		const actualNs = now();
		if (k === 0) firstActualNs = actualNs;
		lastActualNs = actualNs;
		slot.stamp(intendedNs, actualNs, sequenceBase + k + 1);
		batch[k] = slot.bytes;
	}
	// Prefix semantics, read as they ship: `sent = k` means `0..k` went out and
	// `k..N` were not attempted. Unsent elements are counted the same way a
	// failed single send is, so the three arms account for loss identically.
	const result = await sender.sendDatagramBatch(batch);
	const sent = Math.max(0, Math.min(amplitude, result.sent));
	return { sent, errors: amplitude - sent, firstActualNs, lastActualNs };
}

/**
 * The shadow sink the loaded-server headroom arm drives beside the real
 * sessions: everything that arm's JS path does, except the native call.
 *
 * Per arm, because the arms do different JS work and holding them all to one
 * sink would measure the wrong ceiling for two of them:
 *
 * - `serial` / `pipelined` — the `Buffer.from` copy `sendDatagram` makes before
 *   crossing.
 * - `batch` — the real `sendDatagramBatchChunked` path (element validation, the
 *   256-element chunk slice) with a fake native call doing one `Buffer.from`
 *   per element, standing in for `prepare_batch`'s copy. Disclosed in the
 *   pre-registration: the real copy is a native memcpy and this is JS's nearest
 *   equivalent; if it is the cheaper of the two, the batch arm's ceiling is
 *   overstated, and that direction is on the record rather than assumed away.
 */
export function createSinkSender(
	emitter: EgressEmitter,
	onEmitted: (count: number) => void,
): SessionSender {
	if (emitter === "batch") {
		return {
			sendDatagram: async (bytes) => {
				Buffer.from(bytes);
				onEmitted(1);
			},
			sendDatagramBatch: (datagrams) =>
				sendDatagramBatchChunked((chunk) => {
					for (const item of chunk) Buffer.from(item);
					onEmitted(chunk.length);
					return Promise.resolve({ sent: chunk.length });
				}, datagrams),
		};
	}
	return {
		sendDatagram: async (bytes) => {
			Buffer.from(bytes);
			onEmitted(1);
		},
		sendDatagramBatch: async (datagrams) => {
			for (const item of datagrams) Buffer.from(item);
			onEmitted(datagrams.length);
			return { sent: datagrams.length };
		},
	};
}
