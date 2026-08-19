import { describe, expect, test } from "bun:test";
import {
	createSinkSender,
	EGRESS_EMITTERS,
	type EgressEmitter,
	emitEvent,
	isEgressEmitter,
	type SessionSender,
	type StampedSlot,
} from "./egress-emitter.ts";

/** A pool slot that records what was stamped into it, in order. */
function pool(size: number): StampedSlot[] {
	return Array.from({ length: size }, (_, i) => {
		const bytes = new Uint8Array(8);
		bytes[0] = i;
		const stamps: Array<{ intended: number; actual: number; seq: number }> = [];
		return Object.assign(
			{
				bytes,
				stamp(intended: number, actual: number, seq: number) {
					stamps.push({ intended, actual, seq });
				},
			},
			{ stamps },
		);
	}) as unknown as StampedSlot[];
}

function stampsOf(slot: StampedSlot) {
	return (slot as unknown as { stamps: Array<{ seq: number }> }).stamps;
}

type Recorder = SessionSender & {
	singles: Uint8Array[];
	batches: Uint8Array[][];
	/** Sends issued but not yet settled, sampled at the moment of each issue. */
	maxInFlight: number;
};

function recorder(opts: { deferred?: boolean; batchSent?: number } = {}) {
	const singles: Uint8Array[] = [];
	const batches: Uint8Array[][] = [];
	const resolvers: Array<() => void> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const rec: Recorder = {
		singles,
		batches,
		get maxInFlight() {
			return maxInFlight;
		},
		sendDatagram(bytes) {
			singles.push(bytes.slice());
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			if (!opts.deferred) {
				inFlight -= 1;
				return Promise.resolve();
			}
			return new Promise<void>((resolve) => {
				resolvers.push(() => {
					inFlight -= 1;
					resolve();
				});
			});
		},
		async sendDatagramBatch(datagrams) {
			batches.push(datagrams.map((d) => d.slice()));
			return { sent: opts.batchSent ?? datagrams.length };
		},
	};
	return {
		rec,
		flush: () => {
			for (const r of resolvers.splice(0)) r();
		},
	};
}

let clock = 0;
const now = () => (clock += 1000);

describe("arm selection", () => {
	test("only the three registered arms exist", () => {
		expect([...EGRESS_EMITTERS]).toEqual(["serial", "pipelined", "batch"]);
		expect(isEgressEmitter("batch")).toBe(true);
		expect(isEgressEmitter("fire-and-forget")).toBe(false);
	});
});

describe("every arm drives the same schedule", () => {
	for (const emitter of EGRESS_EMITTERS) {
		test(`${emitter}: stamps every element once, with its own sequence`, async () => {
			clock = 0;
			const slots = pool(8);
			const { rec, flush } = recorder();
			const done = emitEvent(emitter, rec, slots, 5, 42, 100, now);
			flush();
			const out = await done;

			expect(out.sent).toBe(5);
			expect(out.errors).toBe(0);
			for (let k = 0; k < 5; k += 1) {
				const stamps = stampsOf(slots[k] as StampedSlot);
				expect(stamps).toHaveLength(1);
				expect(stamps[0]?.seq).toBe(100 + k + 1);
			}
			// Slots past the amplitude are untouched.
			expect(stampsOf(slots[5] as StampedSlot)).toHaveLength(0);
			expect(out.firstActualNs).toBeGreaterThan(0);
			expect(out.lastActualNs).toBeGreaterThanOrEqual(out.firstActualNs);
		});

		test(`${emitter}: a zero amplitude issues nothing`, async () => {
			const { rec } = recorder();
			const out = await emitEvent(emitter, rec, pool(4), 0, 1, 0, now);
			expect(out).toEqual({
				sent: 0,
				errors: 0,
				firstActualNs: 0,
				lastActualNs: 0,
			});
			expect(rec.singles).toHaveLength(0);
			expect(rec.batches).toHaveLength(0);
		});

		test(`${emitter}: a pool too small for the amplitude is a harness fault`, () => {
			const { rec } = recorder();
			expect(() => emitEvent(emitter, rec, pool(2), 5, 1, 0, now)).toThrow(
				/pool of 2/,
			);
		});
	}
});

describe("the arms differ in exactly one place", () => {
	test("serial issues one send at a time", async () => {
		const { rec, flush } = recorder({ deferred: true });
		const done = emitEvent("serial", rec, pool(4), 4, 1, 0, now);
		// Nothing else can be issued while the first is unsettled.
		await Promise.resolve();
		expect(rec.singles).toHaveLength(1);
		for (let i = 0; i < 8; i += 1) {
			flush();
			await Promise.resolve();
		}
		await done;
		expect(rec.maxInFlight).toBe(1);
		expect(rec.singles).toHaveLength(4);
		expect(rec.batches).toHaveLength(0);
	});

	test("pipelined issues every send before settling any", async () => {
		const { rec, flush } = recorder({ deferred: true });
		const done = emitEvent("pipelined", rec, pool(4), 4, 1, 0, now);
		await Promise.resolve();
		expect(rec.singles).toHaveLength(4);
		expect(rec.maxInFlight).toBe(4);
		flush();
		const out = await done;
		expect(out.sent).toBe(4);
		expect(rec.batches).toHaveLength(0);
	});

	test("batch makes exactly one call carrying every element, distinctly", async () => {
		const { rec } = recorder();
		const out = await emitEvent("batch", rec, pool(4), 4, 1, 0, now);
		expect(out.sent).toBe(4);
		expect(rec.singles).toHaveLength(0);
		expect(rec.batches).toHaveLength(1);
		expect(rec.batches[0]).toHaveLength(4);
		// Distinct buffers, not one buffer four times: a shared buffer would put
		// the last stamp on every datagram, because the batch copies at the call.
		expect(new Set(rec.batches[0]?.map((b) => b[0])).size).toBe(4);
	});
});

describe("failures are accounted the same way on every arm", () => {
	test("serial counts a throwing send as an error and keeps going", async () => {
		const sender: SessionSender = {
			sendDatagram: (bytes) =>
				bytes[0] === 1 ? Promise.reject(new Error("no")) : Promise.resolve(),
			sendDatagramBatch: async (d) => ({ sent: d.length }),
		};
		const out = await emitEvent("serial", sender, pool(4), 4, 1, 0, now);
		expect(out).toMatchObject({ sent: 3, errors: 1 });
	});

	test("pipelined counts a rejected send as an error", async () => {
		const sender: SessionSender = {
			sendDatagram: (bytes) =>
				bytes[0] === 2 ? Promise.reject(new Error("no")) : Promise.resolve(),
			sendDatagramBatch: async (d) => ({ sent: d.length }),
		};
		const out = await emitEvent("pipelined", sender, pool(4), 4, 1, 0, now);
		expect(out).toMatchObject({ sent: 3, errors: 1 });
	});

	test("batch reads the prefix envelope: elements past `sent` are errors", async () => {
		const { rec } = recorder({ batchSent: 2 });
		const out = await emitEvent("batch", rec, pool(5), 5, 1, 0, now);
		expect(out).toMatchObject({ sent: 2, errors: 3 });
	});

	test("batch never reports more sent than it handed over", async () => {
		const sender: SessionSender = {
			sendDatagram: async () => {},
			// A lying envelope is a harness fault, not a delivery number.
			sendDatagramBatch: async () => ({ sent: 99 }),
		};
		const out = await emitEvent("batch", sender, pool(3), 3, 1, 0, now);
		expect(out).toMatchObject({ sent: 3, errors: 0 });
	});
});

describe("the headroom sink mirrors its own arm", () => {
	for (const emitter of EGRESS_EMITTERS) {
		test(`${emitter}: counts every datagram the arm sources`, async () => {
			let emitted = 0;
			const sink = createSinkSender(emitter as EgressEmitter, (n) => {
				emitted += n;
			});
			await emitEvent(emitter, sink, pool(64), 40, 1, 0, now);
			expect(emitted).toBe(40);
		});
	}

	test("the batch sink goes through the real chunking path", async () => {
		let emitted = 0;
		const sink = createSinkSender("batch", (n) => {
			emitted += n;
		});
		// 300 > DATAGRAM_BATCH_MAX (256): the real path must split it in two.
		await emitEvent("batch", sink, pool(300), 300, 1, 0, now);
		expect(emitted).toBe(300);
	});

	test("the batch sink rejects a non-Uint8Array element, like the real path", () => {
		const sink = createSinkSender("batch", () => {});
		expect(() =>
			sink.sendDatagramBatch([new Uint8Array(1), 7 as unknown as Uint8Array]),
		).toThrow(TypeError);
	});
});
