/**
 * G11-T fixes B and A: the direct byte-stream readable every native-backed
 * incoming stream uses (native-readable.ts), and the opt-in cross-stream
 * read group that feeds many of them through one crossing (read-group.ts,
 * crates/native/src/read_group.rs).
 *
 * The readable and the pump are driven against fake handles and a fake group
 * so the lifecycle assertions do not depend on network timing; the real
 * transfers then run each delivery shape in its own process (the knobs are
 * resolved once per process).
 */

import { describe, expect, it } from "bun:test";
import { __TESTING__ } from "../src/internal.js";
import { parseReadGroupEnabled } from "../src/read-group.js";
import { childResult, runChild } from "./helpers/child.js";
import { nextPort } from "./helpers/network.js";

type Value = Uint8Array | string | null;
type Owner = Parameters<typeof __TESTING__.createNativeByteReadableForTests>[0];

/** A handle whose reads resolve only when the test says so. */
function scriptedHandle() {
	const pending: Array<(v: Value | Error) => void> = [];
	let reads = 0;
	const handle = {
		read: () => {
			reads++;
			return new Promise<Value>((resolve, reject) => {
				pending.push((v) => (v instanceof Error ? reject(v) : resolve(v)));
			});
		},
	};
	return {
		handle,
		get reads() {
			return reads;
		},
		get inFlight() {
			return pending.length;
		},
		settle(v: Value | Error) {
			const next = pending.shift();
			if (!next) throw new Error("no read in flight");
			next(v);
		},
	};
}

function ownerFor(handle: { read(): Promise<Value> }) {
	const events: string[] = [];
	let current: typeof handle | null = handle;
	const owner: Owner = {
		current: () => current,
		onBytes: (n) => events.push(`bytes:${n}`),
		onEnd: () => events.push("end"),
		onError: (err) => {
			events.push(`error:${(err as Error).message}`);
			current = null;
			return new Error(`mapped:${(err as Error).message}`);
		},
		onCancel: (reason) => events.push(`cancel:${String(reason)}`),
	};
	return {
		owner,
		events,
		release: () => {
			current = null;
			owner.released?.();
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Every stream wait carries its own labelled deadline: a lost wake fails the
 * operation that lost it, by name, not the test at its coarse timeout. */
function within<T>(p: Promise<T>, label: string, ms = 2000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		p.finally(() => clearTimeout(timer)),
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`timed out after ${ms} ms: ${label}`)),
				ms,
			);
		}),
	]);
}

describe("direct native readable (fix B)", () => {
	it("delivers each crossing as one chunk, in order, then closes on EOF", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const reader = __TESTING__
			.createNativeByteReadableForTests(o.owner)
			.getReader();
		const first = reader.read();
		await tick();
		h.settle(new Uint8Array([1, 2, 3]));
		expect(Array.from((await within(first, "first")).value ?? [])).toEqual([
			1, 2, 3,
		]);
		const second = reader.read();
		await tick();
		h.settle(new Uint8Array([4]));
		expect(Array.from((await within(second, "second")).value ?? [])).toEqual([
			4,
		]);
		const last = reader.read();
		await tick();
		h.settle(null);
		expect((await within(last, "last")).done).toBe(true);
		expect(o.events).toEqual(["bytes:3", "bytes:1", "end"]);
		expect(h.reads).toBe(3);
	});

	it("reads the addon only while a reader waits (backpressure)", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const reader = __TESTING__
			.createNativeByteReadableForTests(o.owner)
			.getReader();
		await tick();
		await tick();
		// highWaterMark 0: no read is issued before anyone asks.
		expect(h.reads).toBe(0);
		const pending = reader.read();
		await tick();
		expect(h.inFlight).toBe(1);
		h.settle(new Uint8Array(8));
		await within(pending, "pending");
		await tick();
		await tick();
		// The chunk satisfied the only waiting read; nothing is read ahead.
		expect(h.reads).toBe(1);
		expect(h.inFlight).toBe(0);
		reader.releaseLock();
	});

	it("re-reads past an empty crossing instead of stalling the reader", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const reader = __TESTING__
			.createNativeByteReadableForTests(o.owner)
			.getReader();
		const pending = reader.read();
		await tick();
		h.settle(new Uint8Array(0));
		await tick();
		expect(h.inFlight).toBe(1);
		h.settle(new Uint8Array([9]));
		expect(Array.from((await within(pending, "pending")).value ?? [])).toEqual([
			9,
		]);
	});

	it("errors the stream with the owner's mapping for an error-code result", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const reader = __TESTING__
			.createNativeByteReadableForTests(o.owner)
			.getReader();
		const pending = reader.read();
		await tick();
		h.settle("E_STREAM_RESET");
		await expect(within(pending, "pending")).rejects.toThrow(
			"mapped:E_STREAM_RESET",
		);
		expect(o.events).toEqual(["error:E_STREAM_RESET"]);
	});

	it("errors the stream for a rejected read too", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const reader = __TESTING__
			.createNativeByteReadableForTests(o.owner)
			.getReader();
		const pending = reader.read();
		await tick();
		h.settle(new Error("boom"));
		await expect(within(pending, "pending")).rejects.toThrow("mapped:boom");
	});

	it("settles a waiting read with a close when the owner releases mid-read", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const reader = __TESTING__
			.createNativeByteReadableForTests(o.owner)
			.getReader();
		const pending = reader.read();
		await tick();
		o.release();
		h.settle(new Uint8Array([1]));
		// What the next pull would have done: the reader is answered, with
		// no bytes from the released handle and no owner event.
		expect((await within(pending, "pending")).done).toBe(true);
		expect(o.events).toEqual([]);
	});

	it("drops a read that completes after a cancel", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const reader = __TESTING__
			.createNativeByteReadableForTests(o.owner)
			.getReader();
		const pending = reader.read();
		await tick();
		await within(reader.cancel("bye"), "reader.cancel('bye')");
		expect((await within(pending, "pending")).done).toBe(true);
		h.settle(new Uint8Array([1]));
		await tick();
		await tick();
		expect(o.events).toEqual(["cancel:bye"]);
	});

	it("closes at once when the owner has no handle", async () => {
		const o = ownerFor({ read: async () => null });
		o.release();
		const reader = __TESTING__
			.createNativeByteReadableForTests(o.owner)
			.getReader();
		expect((await within(reader.read(), "reader.read()")).done).toBe(true);
	});

	it("passes cancel to the owner with its reason", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const readable = __TESTING__.createNativeByteReadableForTests(o.owner);
		await within(readable.cancel("bye"), "readable.cancel('bye')");
		expect(o.events).toEqual(["cancel:bye"]);
		expect(h.reads).toBe(0);
	});

	it("serves a BYOB reader, splitting a crossing across small views", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const readable = __TESTING__.createNativeByteReadableForTests(o.owner);
		const reader = (
			readable as unknown as {
				getReader(o: { mode: "byob" }): {
					read(v: Uint8Array): Promise<{ value?: Uint8Array; done: boolean }>;
				};
			}
		).getReader({ mode: "byob" });
		const first = reader.read(new Uint8Array(2));
		await tick();
		h.settle(new Uint8Array([1, 2, 3]));
		expect(Array.from((await within(first, "first")).value ?? [])).toEqual([
			1, 2,
		]);
		const rest = await within(reader.read(new Uint8Array(8)), "byob read rest");
		expect(Array.from(rest.value ?? [])).toEqual([3]);
		expect(h.reads).toBe(1);
		// EOF must settle a BYOB read that is already waiting.
		const end = reader.read(new Uint8Array(4));
		await tick();
		h.settle(null);
		expect((await within(end, "end")).done).toBe(true);
	});
});

/** A group whose `next()` resolves when the test pushes entries. */
function fakeGroup() {
	const grants: Array<[number, number]> = [];
	const prepares: Array<[number, number]> = [];
	const cancels: number[] = [];
	let failPrepare = false;
	let wakes = 0;
	let waiter: ((v: Array<number | Value> | null) => void) | null = null;
	let backlog: Array<number | Value> = [];
	const cancelled = new Set<number>();
	let max = 4096;
	const order: string[] = [];
	let closed = false;
	const flush = () => {
		if (!waiter) return;
		if (closed) {
			const w = waiter;
			waiter = null;
			w(null);
			return;
		}
		if (backlog.length === 0) return;
		const w = waiter;
		waiter = null;
		// Like native `next(maxEntries)`: at most `max` entries per crossing.
		const out = backlog.slice(0, max * 2);
		backlog = backlog.slice(max * 2);
		w(out);
	};
	const group = {
		id: 7,
		next: (maxEntries: number) =>
			new Promise<Array<number | Value> | null>((resolve) => {
				max = maxEntries;
				waiter = resolve;
				flush();
			}),
		get queued() {
			return backlog.length >> 1;
		},
		prepare: (key: number, credit: number) => {
			if (failPrepare) throw new Error("E_INVALID_ARGUMENT: key already live");
			prepares.push([key, credit]);
		},
		grant: (key: number, bytes: number) => grants.push([key, bytes]),
		// Models read_group.rs: a cancel drops the key's queued entries, and
		// entries its feeder produces afterwards never land.
		cancel: (key: number) => {
			cancels.push(key);
			order.push(`cancel:${key}`);
			cancelled.add(key);
			const kept: Array<number | Value> = [];
			for (let i = 0; i + 1 < backlog.length; i += 2)
				if (backlog[i] !== key)
					kept.push(backlog[i] as number, backlog[i + 1] as Value);
			backlog = kept;
		},
		wake: () => {
			wakes++;
			order.push("wake");
			if (waiter) {
				const w = waiter;
				waiter = null;
				w([]);
			}
		},
		close: () => {
			closed = true;
			flush();
		},
	};
	return {
		group,
		grants,
		prepares,
		cancels,
		failPrepare() {
			failPrepare = true;
		},
		get wakes() {
			return wakes;
		},
		get parked() {
			return waiter !== null;
		},
		order,
		/** Entries queued and not yet taken by `next()`. */
		get queued() {
			return backlog.length >> 1;
		},
		/** Queue entries without resolving a pending `next()` (they were
		 * queued while the pump was between crossings). */
		enqueue(...entries: Array<number | Value>) {
			for (let i = 0; i + 1 < entries.length; i += 2)
				backlog.push(entries[i] as number, entries[i + 1] as Value);
		},
		push(...entries: Array<number | Value>) {
			for (let i = 0; i + 1 < entries.length; i += 2)
				if (!cancelled.has(entries[i] as number))
					backlog.push(entries[i] as number, entries[i + 1] as Value);
			flush();
		},
	};
}

function feedable() {
	const feeds: Array<[number, number, number]> = [];
	let finish: (code: string | null) => void = () => {};
	return {
		feeds,
		handle: {
			feedReadGroup: (g: number, key: number, max: number) => {
				feeds.push([g, key, max]);
				return new Promise<string | null>((r) => {
					finish = r;
				});
			},
		},
		finish: (code: string | null) => finish(code),
	};
}

describe("read group pump (fix A)", () => {
	it("starts no feeder and reads nothing ahead until the first read", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const r = pump
			.attach(f.handle, ownerFor({ read: async () => null }).owner)
			.getReader();
		await tick();
		await tick();
		expect(f.feeds).toEqual([]);
		expect(g.parked).toBe(false);
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		expect(f.feeds).toEqual([[7, key, 0]]);
		// One read's credit, prepared before the feeder starts.
		expect(g.prepares).toEqual([[key, 1]]);
		expect(g.parked).toBe(true);
		g.push(key, null);
		expect((await within(pending, "pending")).done).toBe(true);
	});

	it("demultiplexes one crossing's entries into each stream, in order", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const a = feedable();
		const b = feedable();
		const oa = ownerFor({ read: async () => null });
		const ob = ownerFor({ read: async () => null });
		const ra = pump.attach(a.handle, oa.owner).getReader();
		const rb = pump.attach(b.handle, ob.owner).getReader();
		const pa = ra.read();
		await tick();
		const pb = rb.read();
		await tick();
		expect(a.feeds[0]?.[0]).toBe(7);
		const ka = a.feeds[0]?.[1] as number;
		const kb = b.feeds[0]?.[1] as number;
		expect(ka).not.toBe(kb);
		g.push(
			ka,
			new Uint8Array([1]),
			kb,
			new Uint8Array([2, 2]),
			ka,
			new Uint8Array([3]),
		);
		expect(Array.from((await within(pa, "pa")).value ?? [])).toEqual([1]);
		expect(Array.from((await within(pb, "pb")).value ?? [])).toEqual([2, 2]);
		// The second chunk for a is queued in its stream, not lost.
		expect(
			Array.from((await within(ra.read(), "ra.read()")).value ?? []),
		).toEqual([3]);
		g.push(ka, null, kb, null);
		expect((await within(ra.read(), "ra.read()")).done).toBe(true);
		expect((await within(rb.read(), "rb.read()")).done).toBe(true);
		expect(oa.events).toEqual(["bytes:1", "bytes:1", "end"]);
		expect(ob.events).toEqual(["bytes:2", "end"]);
		await tick();
		expect(pump.size).toBe(0);
	});

	it("counts crossings, entries and bytes on its instrument", async () => {
		__TESTING__.resetReadGroupDiagnosticsForTests();
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const a = feedable();
		const b = feedable();
		const ra = pump
			.attach(a.handle, ownerFor({ read: async () => null }).owner)
			.getReader();
		const rb = pump
			.attach(b.handle, ownerFor({ read: async () => null }).owner)
			.getReader();
		const pa = ra.read();
		await tick();
		const pb = rb.read();
		await tick();
		const ka = a.feeds[0]?.[1] as number;
		const kb = b.feeds[0]?.[1] as number;
		g.push(ka, new Uint8Array(3), kb, new Uint8Array(5), ka, null);
		await within(pa, "pa");
		await within(pb, "pb");
		g.push(kb, null);
		await within(ra.read(), "ra.read()");
		await within(rb.read(), "rb.read()");
		expect(__TESTING__.readGroupDiagnosticsSnapshotForTests()).toEqual({
			crossings: 2,
			entries: 4,
			dataEntries: 2,
			terminalEntries: 2,
			bytes: 8,
			batchedEntries: 0,
			nativeDataEntries: 0,
			maxEntryBytes: 5,
			maxEntriesPerCrossing: 3,
			meanEntriesPerCrossing: 2,
		});
	});

	it("grants one read per outstanding pull and nothing ahead (backpressure)", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const first = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		expect(g.prepares).toEqual([[key, 1]]);
		// The read is answered; with no further read outstanding the consumer
		// is stalled and the feeder gets no more credit, however long it waits.
		g.push(key, new Uint8Array(400));
		expect((await within(first, "first")).value?.byteLength).toBe(400);
		await tick();
		await tick();
		expect(g.grants).toEqual([]);
		expect(pump.heldBytes()).toBe(0);
		// The next read is the next grant: back up to one read's credit
		// (1 - 400 + 400).
		const second = r.read();
		await tick();
		expect(g.grants).toEqual([[key, 400]]);
		g.push(key, new Uint8Array(100));
		await within(second, "second");
		const third = r.read();
		await tick();
		expect(g.grants).toEqual([
			[key, 400],
			[key, 100],
		]);
		g.push(key, null);
		expect((await within(third, "third")).done).toBe(true);
	});

	it("detaches an attached-but-never-read stream when its owner releases it (C-B1)", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const readable = pump.attach(f.handle, o.owner);
		expect(pump.size).toBe(1);
		o.release();
		expect(pump.size).toBe(0);
		expect(f.feeds).toEqual([]);
		expect(g.prepares).toEqual([]);
		expect(g.cancels).toEqual([]);
		// The readable is settled, not left hanging.
		expect(
			(await within(readable.getReader().read(), "readable.getReader().read()"))
				.done,
		).toBe(true);
	});

	it("never reuses a key that is still attached or still feeding (A-N1)", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const a = feedable();
		const ra = pump
			.attach(a.handle, ownerFor({ read: async () => null }).owner)
			.getReader();
		const pa = ra.read();
		await tick();
		expect(a.feeds[0]?.[1]).toBe(1);
		// A cancel detaches the sink, but its native feeder has not resolved.
		await within(ra.cancel("stop"), "ra.cancel('stop')");
		await within(pa, "pa");
		const b = feedable();
		pump.setNextKeyForTests(0xffff_ffff);
		void pump
			.attach(b.handle, ownerFor({ read: async () => null }).owner)
			.getReader()
			.read();
		const c = feedable();
		const rc = pump
			.attach(c.handle, ownerFor({ read: async () => null }).owner)
			.getReader();
		void rc.read();
		await tick();
		expect(b.feeds[0]?.[1]).toBe(0xffff_ffff);
		// Wrapped past 0, and past key 1 whose feeder is still running.
		expect(c.feeds[0]?.[1]).toBe(2);
		// Once key 1's feeder resolves, the key is free again.
		a.finish(null);
		await tick();
		pump.setNextKeyForTests(1);
		const d = feedable();
		void pump
			.attach(d.handle, ownerFor({ read: async () => null }).owner)
			.getReader()
			.read();
		await tick();
		expect(d.feeds[0]?.[1]).toBe(1);
	});

	it("errors the stream when its key cannot be prepared", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		g.failPrepare();
		const f = feedable();
		const r = pump
			.attach(f.handle, ownerFor({ read: async () => null }).owner)
			.getReader();
		await expect(within(r.read(), "r.read()")).rejects.toThrow(
			"mapped:E_INVALID_ARGUMENT",
		);
		expect(f.feeds).toEqual([]);
		expect(pump.size).toBe(0);
	});

	it("errors only the stream whose entry carries an error code", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const a = feedable();
		const b = feedable();
		const oa = ownerFor({ read: async () => null });
		const ob = ownerFor({ read: async () => null });
		const ra = pump.attach(a.handle, oa.owner).getReader();
		const rb = pump.attach(b.handle, ob.owner).getReader();
		const pa = ra.read();
		await tick();
		const pb = rb.read();
		await tick();
		const ka = a.feeds[0]?.[1] as number;
		const kb = b.feeds[0]?.[1] as number;
		g.push(ka, "E_STREAM_RESET", kb, new Uint8Array([5]));
		await expect(within(pa, "pa")).rejects.toThrow("mapped:E_STREAM_RESET");
		expect(Array.from((await within(pb, "pb")).value ?? [])).toEqual([5]);
		expect(oa.events).toEqual(["error:E_STREAM_RESET"]);
	});

	it("contains a delivery that throws to its own stream", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const a = feedable();
		const b = feedable();
		const oa = ownerFor({ read: async () => null });
		oa.owner.onBytes = () => {
			throw new Error("app hook threw");
		};
		const ob = ownerFor({ read: async () => null });
		const ra = pump.attach(a.handle, oa.owner).getReader();
		const rb = pump.attach(b.handle, ob.owner).getReader();
		const pa = ra.read();
		await tick();
		const pb = rb.read();
		await tick();
		const ka = a.feeds[0]?.[1] as number;
		const kb = b.feeds[0]?.[1] as number;
		g.push(ka, new Uint8Array([1]), kb, new Uint8Array([2]));
		await expect(within(pa, "pa")).rejects.toThrow("mapped:app hook threw");
		// The rest of the batch still landed on the other stream.
		expect(Array.from((await within(pb, "pb")).value ?? [])).toEqual([2]);
		// The failed stream's still-running feeder is told to stop (r2 N7b).
		expect(g.cancels).toEqual([ka]);
	});

	it("cancels a started feeder and drops its late entries", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		await within(r.cancel("stop"), "r.cancel('stop')");
		expect((await within(pending, "pending")).done).toBe(true);
		expect(g.cancels).toEqual([key]);
		expect(o.events).toEqual(["cancel:stop"]);
		g.push(key, new Uint8Array([1]));
		await tick();
		expect(o.events).toEqual(["cancel:stop"]);
	});

	it("cancels an unread stream without ever starting a feeder", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		await within(
			pump.attach(f.handle, o.owner).cancel("stop"),
			"pump.attach(f.handle, o.owner).cancel('stop')",
		);
		expect(f.feeds).toEqual([]);
		expect(g.cancels).toEqual([]);
		expect(o.events).toEqual(["cancel:stop"]);
		expect(pump.size).toBe(0);
	});

	it("settles a waiting read when the owner is released mid-read (data arrives)", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		o.release();
		g.push(key, new Uint8Array([1]));
		expect((await within(pending, "pending")).done).toBe(true);
		// The feeder was still running, so it is told to stop.
		expect(g.cancels).toEqual([key]);
		expect(o.events).toEqual([]);
		expect(pump.size).toBe(0);
		// The late entry never lands in a queue the stopped pump leaves.
		expect(g.queued).toBe(0);
	});

	it("drains a backlog past the per-crossing cap before it stops (r3 A-B1)", async () => {
		__TESTING__.setReadGroupMaxEntriesForTests(2);
		try {
			const g = fakeGroup();
			const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
			const streams = Array.from({ length: 5 }, () => {
				const f = feedable();
				const o = ownerFor({ read: async () => null });
				const r = pump.attach(f.handle, o.owner).getReader();
				return { f, o, pending: r.read() };
			});
			await tick();
			// Every feeder has ended natively (so a release sends no cancel)...
			for (const s of streams) s.f.finish(null);
			await tick();
			expect(pump.feeding).toBe(0);
			// ...its last entries were queued while the loop was busy, and the
			// session then closed: every stream is released in one go.
			for (const s of streams) s.o.release();
			g.enqueue(
				...streams.flatMap((s) => [
					s.f.feeds[0]?.[1] as number,
					new Uint8Array(3),
				]),
				...streams.flatMap((s) => [s.f.feeds[0]?.[1] as number, null]),
			);
			expect(g.queued).toBe(10);
			for (const s of streams)
				expect((await within(s.pending, "released read")).done).toBe(true);
			// Five crossings of two, not one: the tail is drained, then the
			// pump stops.
			for (let i = 0; i < 10 && (g.queued > 0 || g.parked); i++) await tick();
			expect(g.queued).toBe(0);
			expect(g.parked).toBe(false);
			expect(pump.size).toBe(0);
		} finally {
			__TESTING__.setReadGroupMaxEntriesForTests(4096);
		}
	});

	it("cancels the last stream's feeder before the pump stops (r2 A-B1)", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		for (const how of ["release", "cancel"] as const) {
			const f = feedable();
			const o = ownerFor({ read: async () => null });
			const r = pump.attach(f.handle, o.owner).getReader();
			const pending = r.read();
			await tick();
			const key = f.feeds[0]?.[1] as number;
			g.order.length = 0;
			if (how === "release") o.release();
			else await within(r.cancel("stop"), "cancel the last stream");
			expect((await within(pending, `pending (${how})`)).done).toBe(true);
			// Cancel first, then the wake that lets the pump stop.
			expect(g.order).toEqual([`cancel:${key}`, "wake"]);
			await tick();
			expect(g.parked).toBe(false);
			// The in-flight read wins the race with the abort: dropped.
			g.push(key, new Uint8Array(1400));
			expect(g.queued).toBe(0);
			f.finish(null);
			await tick();
			expect(pump.feeding).toBe(0);
		}
	});

	it("does not cancel a released stream whose feeder already resolved", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		// The native feeder ended (its terminal entry still in flight).
		f.finish(null);
		await tick();
		o.release();
		expect((await within(pending, "pending")).done).toBe(true);
		// Only running feeders are cancelled: the key may be reused.
		expect(g.cancels).toEqual([]);
		expect(pump.size).toBe(0);
	});

	it("settles a waiting read when the owner is released mid-read (the read aborts)", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		o.release();
		// The release settles the reader and stops the running feeder at
		// once; disposal then aborts its native read (the feeder's last
		// entry), which is dropped.
		g.push(key, "E_STREAM_RESET");
		expect((await within(pending, "pending")).done).toBe(true);
		expect(g.cancels).toEqual([key]);
		expect(o.events).toEqual([]);
		expect(pump.size).toBe(0);
	});

	it("closes at the first read when the owner was released before it", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		o.release();
		expect((await within(r.read(), "r.read()")).done).toBe(true);
		expect(f.feeds).toEqual([]);
	});

	it("surfaces a feeder that could not start as a stream error", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		f.finish("E_INVALID_ARGUMENT: unknown read group");
		await expect(within(pending, "pending")).rejects.toThrow(
			"mapped:E_INVALID_ARGUMENT",
		);
	});

	it("stops pumping (wakes the pending next) when its last feeder ends", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		expect(g.parked).toBe(true);
		g.push(key, null);
		expect((await within(pending, "pending")).done).toBe(true);
		await tick();
		await tick();
		expect(g.wakes).toBe(1);
		expect(g.parked).toBe(false);
	});

	it("falls back to the direct readable for a handle that cannot feed", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group);
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const r = pump.attach(h.handle as never, o.owner).getReader();
		const pending = r.read();
		await tick();
		h.settle(new Uint8Array([4]));
		expect(Array.from((await within(pending, "pending")).value ?? [])).toEqual([
			4,
		]);
		expect(pump.size).toBe(0);
	});
});

describe("read group knob", () => {
	it("parses: off only for 0", () => {
		expect(parseReadGroupEnabled(undefined)).toBe(true);
		expect(parseReadGroupEnabled("")).toBe(true);
		expect(parseReadGroupEnabled("1")).toBe(true);
		expect(parseReadGroupEnabled("0")).toBe(false);
		expect(parseReadGroupEnabled(" 0 ")).toBe(false);
	});

	const config = async (env: Record<string, string | undefined>) =>
		childResult(
			await runChild(
				`const { __TESTING__ } = await import(INTERNAL_MODULE);
				 report(__TESTING__.readGroupConfigForTests());`,
				env,
			),
		);

	it("is on by default", async () => {
		// `active`: the loaded addon really has the group, so default-on is
		// not silently the direct pull.
		expect(await config({ WEBTRANSPORT_STREAM_READ_GROUP: undefined })).toEqual(
			{ enabled: true, active: true },
		);
	});

	it("is turned off by WEBTRANSPORT_STREAM_READ_GROUP=0", async () => {
		expect(await config({ WEBTRANSPORT_STREAM_READ_GROUP: "0" })).toEqual({
			enabled: false,
			active: false,
		});
	});

	it("stays on for 1", async () => {
		expect(await config({ WEBTRANSPORT_STREAM_READ_GROUP: "1" })).toEqual({
			enabled: true,
			active: true,
		});
	});
});

// Every wait in the child scripts below carries its own deadline, so a lost
// event fails the operation that lost it, by name, instead of the whole
// test at its coarse timeout.
const guardSrc = `
	const guard = (p, ms, label) => {
		let t;
		return Promise.race([
			Promise.resolve(p).finally(() => clearTimeout(t)),
			new Promise((_, reject) => {
				t = setTimeout(() => reject(new Error("timed out after " + ms + " ms: " + label)), ms);
			}),
		]);
	};
`;

// Real transfers over the W3C surface on both ends: server-accepted bidi and
// uni readables (direct or group-fed), and the client's created-bidi readable
// (direct, fix B), with a BYOB read on the client.
const transferBody = `${guardSrc}
	const { createServer, WebTransport } = await import(PUBLIC_MODULE);
	const { __TESTING__ } = await import(INTERNAL_MODULE);
	const port = Number(process.env.WT_TEST_PORT);
	const STREAMS = 8;
	const TOTAL = 132_000;
	const CHUNK = 1000;
	const pattern = (s, i) => (s * 31 + i) % 251;

	async function drain(readable) {
		const r = readable.getReader();
		let n = 0, sum = 0, chunks = 0;
		for (;;) {
			const { done, value } = await guard(r.read(), 10_000, "drain read");
			if (done) break;
			chunks++;
			n += value.byteLength;
			for (let i = 0; i < value.length; i++) sum = (sum + value[i] * ((n - value.length + i) % 7 + 1)) % 65521;
		}
		return { n, sum, chunks };
	}

	const serverSeen = [];
	let resolveServer;
	const serverDone = new Promise((r) => { resolveServer = r; });
	const server = createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		onSession: async (session) => {
			const bidi = session.incomingBidirectionalStreams.getReader();
			const uni = session.incomingUnidirectionalStreams.getReader();
			const work = [];
			for (let s = 0; s < STREAMS; s++) {
				const { value: stream } = await guard(bidi.read(), 10_000, "server accept bidi " + s);
				work.push((async () => {
					const got = await drain(stream.readable);
					const w = stream.writable.getWriter();
					for (let sent = 0; sent < TOTAL; sent += CHUNK) {
						await guard(w.write(new Uint8Array(CHUNK).fill(pattern(5, sent / CHUNK))), 10_000, "server echo write");
					}
					await guard(w.close(), 10_000, "server echo close");
					return got;
				})());
			}
			const { value: recv } = await guard(uni.read(), 10_000, "server accept uni");
			const uniGot = await drain(recv);
			resolveServer({ bidi: await guard(Promise.all(work), 30_000, "server bidi drains"), uni: uniGot });
		},
	});

	function expected(seed) {
		let n = 0, sum = 0;
		for (let sent = 0; sent < TOTAL; sent += CHUNK) {
			const v = new Uint8Array(CHUNK);
			for (let i = 0; i < CHUNK; i++) v[i] = pattern(seed, sent + i);
			n += v.length;
			for (let i = 0; i < v.length; i++) sum = (sum + v[i] * ((n - v.length + i) % 7 + 1)) % 65521;
		}
		return { n, sum };
	}

	const wt = new WebTransport("https://127.0.0.1:" + port, {
		tls: { insecureSkipVerify: true },
	});
	await guard(wt.ready, 10_000, "client ready");
	const echoes = [];
	for (let s = 0; s < STREAMS; s++) {
		const { readable, writable } = await guard(wt.createBidirectionalStream(), 10_000, "client open bidi " + s);
		const w = writable.getWriter();
		(async () => {
			for (let sent = 0; sent < TOTAL; sent += CHUNK) {
				const v = new Uint8Array(CHUNK);
				for (let i = 0; i < CHUNK; i++) v[i] = pattern(s, sent + i);
				await guard(w.write(v), 10_000, "client write " + s);
			}
			await guard(w.close(), 10_000, "client close " + s);
		})();
		if (s === 0) {
			// BYOB on the client's direct readable.
			const r = readable.getReader({ mode: "byob" });
			echoes.push((async () => {
				let n = 0;
				for (;;) {
					const { done, value } = await guard(r.read(new Uint8Array(777)), 10_000, "client byob read");
					if (done) break;
					n += value.byteLength;
				}
				return { n };
			})());
		} else {
			echoes.push(drain(readable).then((x) => ({ n: x.n })));
		}
	}
	const uw = (await guard(wt.createUnidirectionalStream(), 10_000, "client open uni")).getWriter();
	for (let sent = 0; sent < TOTAL; sent += CHUNK) {
		const v = new Uint8Array(CHUNK);
		for (let i = 0; i < CHUNK; i++) v[i] = pattern(99, sent + i);
		await guard(uw.write(v), 10_000, "client uni write");
	}
	await guard(uw.close(), 10_000, "client uni close");
	const got = await guard(serverDone, 30_000, "server done");
	const echo = await guard(Promise.all(echoes), 30_000, "client echoes");
	report({
		cfg: __TESTING__.readGroupConfigForTests(),
		group: __TESTING__.readGroupDiagnosticsSnapshotForTests(),
		state: __TESTING__.readGroupStateSnapshotForTests(),
		bidiOk: got.bidi.map((g, s) => g.n === expected(s).n && g.sum === expected(s).sum),
		uniOk: got.uni.n === expected(99).n && got.uni.sum === expected(99).sum,
		echo: echo.map((e) => e.n),
		handles: __TESTING__.nativeStreamHandlesSnapshotForTests(),
	});
	wt.close();
	server.close();
	process.exit(0);
`;

describe("real transfers (fixes A and B)", () => {
	for (const arm of [
		{
			name: "direct (read group off)",
			env: {
				WEBTRANSPORT_STREAM_READ_GROUP: "0",
				WEBTRANSPORT_STREAM_BATCH_BYTES: undefined,
			},
		},
		{
			name: "read group (default, knob unset)",
			env: {
				WEBTRANSPORT_STREAM_READ_GROUP: undefined,
				WEBTRANSPORT_STREAM_BATCH_BYTES: undefined,
			},
		},
		{
			name: "read group",
			env: {
				WEBTRANSPORT_STREAM_READ_GROUP: "1",
				WEBTRANSPORT_STREAM_BATCH_BYTES: undefined,
			},
		},
		{
			name: "read group, batch knob on",
			env: {
				WEBTRANSPORT_STREAM_READ_GROUP: "1",
				WEBTRANSPORT_STREAM_BATCH_BYTES: "65536",
			},
		},
	]) {
		it(`delivers every stream's bytes intact (${arm.name})`, async () => {
			const res = childResult(
				await runChild(transferBody, {
					...arm.env,
					WT_TEST_PORT: String(nextPort(28600, 200)),
				}),
			) as {
				cfg: { enabled: boolean; active: boolean };
				group: {
					crossings: number;
					entries: number;
					dataEntries: number;
					maxEntriesPerCrossing: number;
				};
				state: { directFallbacks: number };
				bidiOk: boolean[];
				uniOk: boolean;
				echo: number[];
			};
			const grouped = !arm.name.startsWith("direct");
			expect(res.cfg).toEqual({ enabled: grouped, active: grouped });
			if (grouped) {
				// The bytes really rode the group: crossings carried entries and
				// no readable fell back to the direct pull. (That one crossing
				// carries several streams is pinned deterministically by the
				// "one crossing for many streams" test below.)
				expect(res.group.crossings).toBeGreaterThan(0);
				expect(res.group.entries).toBeGreaterThan(0);
				expect(res.group.dataEntries).toBeGreaterThan(0);
				expect(res.state.directFallbacks).toBe(0);
			} else {
				expect(res.group.crossings).toBe(0);
			}
			expect(res.bidiOk).toEqual(new Array(8).fill(true));
			expect(res.uniOk).toBe(true);
			expect(res.echo).toEqual(new Array(8).fill(132_000));
		}, 120_000);
	}
});

// B4 (g11t-do r1): cancelling a client bidi stream's readable is a W3C
// half-close — STOP_SENDING for the peer's half, the writable keeps working.
// The Node adapter fix B replaced intended this (`destroyOnReadableCancel =
// false`) but its async iterator's `return()` destroyed the duplex anyway.
const halfCloseBody = `${guardSrc}
	const { createServer, WebTransport } = await import(PUBLIC_MODULE);
	const port = Number(process.env.WT_TEST_PORT);
	let resolveGot;
	const got = new Promise((r) => { resolveGot = r; });
	const server = createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		onSession: async (session) => {
			const r = session.incomingBidirectionalStreams.getReader();
			const { value: stream } = await guard(r.read(), 10_000, "server accept");
			const w = stream.writable.getWriter();
			await guard(w.write(new Uint8Array([1])), 10_000, "server write");
			const rd = stream.readable.getReader();
			let n = 0, error = null;
			try {
				for (;;) { const x = await guard(rd.read(), 10_000, "server read"); if (x.done) break; n += x.value.byteLength; }
			} catch (e) { error = String(e); }
			resolveGot({ n, error });
		},
	});
	const wt = new WebTransport("https://127.0.0.1:" + port, { tls: { insecureSkipVerify: true } });
	await guard(wt.ready, 10_000, "client ready");
	const { readable, writable } = await guard(wt.createBidirectionalStream(), 10_000, "client open");
	const w = writable.getWriter();
	await guard(w.write(new Uint8Array(10)), 10_000, "client write 10");
	const rr = readable.getReader();
	await guard(rr.read(), 10_000, "client read");
	await guard(rr.cancel("done reading"), 10_000, "client cancel");
	await Bun.sleep(100);
	let writeError = null;
	try {
		await guard(w.write(new Uint8Array(20)), 10_000, "client write 20");
		await guard(w.close(), 10_000, "client close");
	} catch (e) { writeError = String(e); }
	const server_ = await Promise.race([got, Bun.sleep(5000).then(() => ({ n: -1, error: "timeout" }))]);
	report({ writeError, server: server_ });
	wt.close();
	server.close();
	process.exit(0);
`;

describe("client bidi readable cancel (fix B, B4)", () => {
	it("stops only the receive half: the writable still delivers and FINs", async () => {
		const res = childResult(
			await runChild(halfCloseBody, {
				WT_TEST_PORT: String(nextPort(28800, 100)),
			}),
		) as {
			writeError: string | null;
			server: { n: number; error: string | null };
		};
		expect(res.writeError).toBeNull();
		expect(res.server).toEqual({ n: 30, error: null });
	}, 60_000);
});

// A-B1 / C-B2: group delivery must not read ahead of a stalled consumer.
// Many streams each answer one read and then stall while the peer keeps
// sending far more than the configured session and global caps. Bytes the
// consumers have not asked for must stay in the transport, under the native
// budgets — never in JavaScript queues no budget sees. C-B1: streams that
// were attached and never read are released from the pump when the session
// closes, and every native feeder ends.
const stalledBody = `${guardSrc}
	const { createServer, WebTransport } = await import(PUBLIC_MODULE);
	const { __TESTING__ } = await import(INTERNAL_MODULE);
	// One entry per crossing: every teardown crosses the drain boundary.
	if (process.env.WT_MAX_ENTRIES) __TESTING__.setReadGroupMaxEntriesForTests(Number(process.env.WT_MAX_ENTRIES));
	const port = Number(process.env.WT_TEST_PORT);
	const STREAMS = 16;
	const UNREAD = 4;
	const PER_STREAM = 256 * 1024;
	const PER_SESSION_CAP = 64 * 1024;
	const GLOBAL_CAP = 128 * 1024;
	const limits = {
		maxQueuedBytesGlobal: GLOBAL_CAP,
		maxQueuedBytesPerSession: PER_SESSION_CAP,
		maxQueuedBytesPerStream: 16 * 1024,
	};
	const consumed = [];
	let session;
	let resolveReady;
	const ready = new Promise((r) => { resolveReady = r; });
	__TESTING__.resetReadGroupDiagnosticsForTests();
	const server = createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		limits,
		onSession: async (s) => {
			session = s;
			const uni = s.incomingUnidirectionalStreams.getReader();
			for (let i = 0; i < STREAMS + UNREAD; i++) {
				const { value: readable } = await guard(uni.read(), 10_000, "server accept " + i);
				// The last UNREAD streams are accepted and never read.
				if (i >= STREAMS) continue;
				const r = readable.getReader();
				const { value } = await guard(r.read(), 10_000, "server first read " + i);
				consumed.push(value.byteLength);
				// ...and then this consumer stalls.
			}
			resolveReady();
		},
	});
	const wt = new WebTransport("https://127.0.0.1:" + port, {
		tls: { insecureSkipVerify: true },
	});
	await guard(wt.ready, 10_000, "client ready");
	// Open every stream with a small first write (well inside the connection
	// window, which the stalled streams fill later), then flood them once the
	// server has read each one once.
	const writers = [];
	for (let i = 0; i < STREAMS + UNREAD; i++) {
		const w = (await guard(wt.createUnidirectionalStream(), 10_000, "client open " + i)).getWriter();
		await guard(w.write(new Uint8Array(100).fill(i)), 10_000, "client first write " + i);
		writers.push(w);
	}
	await guard(ready, 20_000, "server read each stream once");
	writers.forEach((w, i) => {
		// These park on flow control once the windows fill: never awaited,
		// and their failure at close is expected.
		void (async () => {
			try {
				for (let sent = 0; sent < PER_STREAM; sent += 4096) await w.write(new Uint8Array(4096).fill(i));
			} catch {}
		})();
	});
	// Give the transport every chance to push more than the caps.
	await Bun.sleep(750);
	const diag = __TESTING__.readGroupDiagnosticsSnapshotForTests();
	const stalled = {
		state: __TESTING__.readGroupStateSnapshotForTests(),
		groupBytes: diag.bytes,
		consumedBytes: consumed.reduce((a, b) => a + b, 0),
		queuedGlobal: server.metricsSnapshot().queuedBytesGlobal,
		queuedSession: session.metricsSnapshot?.().queuedBytes ?? 0,
	};
	// The server ends the session: its streams are disposed, read or not.
	session.close();
	await guard(session.closed.catch(() => undefined), 10_000, "server session closed");
	let after = __TESTING__.readGroupStateSnapshotForTests();
	for (let i = 0; i < 100 && (after.attached > 0 || after.feeding > 0); i++) {
		await Bun.sleep(20);
		after = __TESTING__.readGroupStateSnapshotForTests();
	}
	report({ stalled, after, caps: { PER_SESSION_CAP, GLOBAL_CAP }, sent: (STREAMS + UNREAD) * PER_STREAM });
	wt.close();
	server.close();
	process.exit(0);
`;

describe("read group under stalled consumers (A-B1, C-B1)", () => {
	it("holds nothing beyond what each consumer asked for, within the caps, and releases every stream at session close", async () => {
		const res = childResult(
			await runChild(stalledBody, {
				WEBTRANSPORT_STREAM_READ_GROUP: undefined,
				WEBTRANSPORT_STREAM_BATCH_BYTES: undefined,
				WT_MAX_ENTRIES: "1",
				WT_TEST_PORT: String(nextPort(28900, 100)),
			}),
		) as {
			stalled: {
				state: { attached: number; feeding: number; heldBytes: number };
				groupBytes: number;
				consumedBytes: number;
				queuedGlobal: number;
				queuedSession: number;
			};
			after: Record<string, number>;
			caps: { PER_SESSION_CAP: number; GLOBAL_CAP: number };
		};
		const { stalled, after, caps } = res;
		// Every stream is attached (read or not); the read ones are feeding.
		expect(stalled.state.attached).toBe(20);
		// Exactly the bytes the consumers took crossed into JavaScript: no
		// read-ahead, nothing parked in a byte-stream queue.
		expect(stalled.groupBytes).toBe(stalled.consumedBytes);
		expect(stalled.state.heldBytes).toBe(0);
		// The native budgets stay authoritative for everything else.
		expect(stalled.queuedSession).toBeLessThanOrEqual(caps.PER_SESSION_CAP);
		expect(stalled.queuedGlobal).toBeLessThanOrEqual(caps.GLOBAL_CAP);
		// Session close releases every attached stream, read or never read,
		// and every native feeder ends.
		expect(after).toEqual({
			attached: 0,
			feeding: 0,
			heldBytes: 0,
			nativeQueued: 0,
			nativeQueuedBytes: 0,
			nativeLiveKeys: 0,
			directFallbacks: 0,
		});
	}, 60_000);
});

// r2 A-B1: cancel the sole active group-fed readable while its read is in
// flight and the peer keeps sending, over and over, then leave the server
// idle. The pump stops with every cancel (it was the last stream); whatever
// read won the race with the abort must not stay in the native group's queue
// or hold receive budget. Run with chunk batching off and on.
const raceBody = `${guardSrc}
	const { createServer, WebTransport } = await import(PUBLIC_MODULE);
	const { __TESTING__ } = await import(INTERNAL_MODULE);
	// One entry per crossing: every teardown crosses the drain boundary.
	if (process.env.WT_MAX_ENTRIES) __TESTING__.setReadGroupMaxEntriesForTests(Number(process.env.WT_MAX_ENTRIES));
	const port = Number(process.env.WT_TEST_PORT);
	const ROUNDS = 60;
	const leftovers = [];
	// The client opens round i's stream only when the server is ready for it,
	// so no stream waits unread long enough for its sender to time out.
	const starts = Array.from({ length: ROUNDS }, () => Promise.withResolvers());
	let resolveDone;
	const done = new Promise((r) => { resolveDone = r; });
	const server = createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		onSession: async (s) => {
			try {
			const uni = s.incomingUnidirectionalStreams.getReader();
			for (let i = 0; i < ROUNDS; i++) {
				starts[i].resolve();
				const { value: readable } = await guard(uni.read(), 10_000, "server accept " + i);
				const r = readable.getReader();
				await guard(r.read(), 10_000, "server first read " + i);
				// A read is in flight natively while data keeps arriving...
				const pending = r.read();
				await Bun.sleep(i % 3);
				// ...and the stream is cancelled under it.
				await guard(r.cancel("race"), 10_000, "server cancel " + i);
				await guard(pending, 10_000, "server pending read " + i);
				// The pump has stopped (this was its only stream): nothing of
				// this stream may be left in the native queue.
				await Bun.sleep(2);
				const q = __TESTING__.readGroupStateSnapshotForTests();
				if (q.nativeQueued > 0) leftovers.push({ round: i, ...q });
			}
			resolveDone(null);
			} catch (e) {
				resolveDone(String(e));
			}
		},
	});
	const wt = new WebTransport("https://127.0.0.1:" + port, {
		tls: { insecureSkipVerify: true },
	});
	await guard(wt.ready, 10_000, "client ready");
	for (let i = 0; i < ROUNDS; i++) {
		await guard(starts[i].promise, 10_000, "server ready for round " + i);
		const w = (await guard(wt.createUnidirectionalStream(), 10_000, "client open " + i)).getWriter();
		void (async () => {
			try {
				for (let n = 0; n < 512; n++) await w.write(new Uint8Array(1400).fill(i));
			} catch {}
		})();
	}
	const serverError = await guard(done, 30_000, "server rounds");
	const settled = () => {
		const s = __TESTING__.readGroupStateSnapshotForTests();
		return { ...s, queuedGlobal: server.metricsSnapshot().queuedBytesGlobal };
	};
	let state = settled();
	for (let i = 0; i < 100; i++) {
		if (state.nativeQueued === 0 && state.nativeLiveKeys === 0 && state.feeding === 0 && state.queuedGlobal === 0) break;
		await Bun.sleep(20);
		state = settled();
	}
	report({ serverError, state, leftovers });
	wt.close();
	server.close();
	process.exit(0);
`;

describe("read group teardown race (r2 A-B1)", () => {
	for (const arm of [
		{ name: "batching off", batch: undefined, maxEntries: undefined },
		{ name: "batching on", batch: "65536", maxEntries: undefined },
		{
			name: "batching on, one entry per crossing",
			batch: "65536",
			maxEntries: "1",
		},
	]) {
		it(`leaves no queued entry, live key or reserved byte behind (${arm.name})`, async () => {
			const res = childResult(
				await runChild(raceBody, {
					WEBTRANSPORT_STREAM_READ_GROUP: undefined,
					WEBTRANSPORT_STREAM_BATCH_BYTES: arm.batch,
					WT_MAX_ENTRIES: arm.maxEntries,
					WT_TEST_PORT: String(nextPort(29000, 100)),
				}),
			) as {
				serverError: string | null;
				state: Record<string, number>;
				leftovers: unknown[];
			};
			expect(res.serverError).toBeNull();
			expect(res.leftovers).toEqual([]);
			expect(res.state).toEqual({
				attached: 0,
				feeding: 0,
				heldBytes: 0,
				nativeQueued: 0,
				nativeQueuedBytes: 0,
				nativeLiveKeys: 0,
				directFallbacks: 0,
				queuedGlobal: 0,
			});
		}, 60_000);
	}
});

// N-1 (r4): the point of the group, pinned without relying on network
// timing. Every stream has a read waiting (its feeder parked in a native
// read); the peer's bytes for all of them are sent; then the JS thread is
// blocked synchronously, so every feeder completes and queues while the
// pump's next() cannot resolve. When the thread is released, one crossing
// carries every stream's entry.
const oneCrossingBody = `${guardSrc}
	const { createServer, WebTransport } = await import(PUBLIC_MODULE);
	const { __TESTING__ } = await import(INTERNAL_MODULE);
	const port = Number(process.env.WT_TEST_PORT);
	const STREAMS = 6;
	const accepted = Promise.withResolvers();
	const readers = [];
	const server = createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		onSession: async (s) => {
			const uni = s.incomingUnidirectionalStreams.getReader();
			for (let i = 0; i < STREAMS; i++) {
				const { value: readable } = await guard(uni.read(), 10_000, "server accept " + i);
				readers.push(readable.getReader());
			}
			accepted.resolve();
		},
	});
	const wt = new WebTransport("https://127.0.0.1:" + port, {
		tls: { insecureSkipVerify: true },
	});
	await guard(wt.ready, 10_000, "client ready");
	const writers = [];
	for (let i = 0; i < STREAMS; i++) {
		const w = (await guard(wt.createUnidirectionalStream(), 10_000, "client open " + i)).getWriter();
		// A one-byte header so the server can accept the stream.
		await guard(w.write(new Uint8Array([i])), 10_000, "client header " + i);
		writers.push(w);
	}
	await guard(accepted.promise, 10_000, "server accepted all");
	// Drain each header so every feeder is started and parked.
	for (const [i, r] of readers.entries()) await guard(r.read(), 10_000, "header read " + i);
	// Every stream now has a read waiting on an empty queue.
	const pending = readers.map((r, i) => guard(r.read(), 10_000, "payload read " + i));
	await Bun.sleep(20);
	__TESTING__.resetReadGroupDiagnosticsForTests();
	// Issue every payload write at once and let the microtasks hand them to
	// the addon — no macrotask (and so no pump resolution) runs in between.
	const writes = writers.map((w, i) => guard(w.write(new Uint8Array(1000).fill(i)), 10_000, "client payload " + i));
	for (let k = 0; k < 50; k++) await null;
	// Block the JS thread: the native side sends and receives, every feeder
	// reads and queues, and the pump's next() resolution waits for the thread.
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 750);
	await guard(Promise.all(writes), 10_000, "client payload writes");
	const values = await guard(Promise.all(pending), 10_000, "payload reads");
	report({
		lengths: values.map((v) => v.value?.byteLength ?? -1),
		group: __TESTING__.readGroupDiagnosticsSnapshotForTests(),
	});
	wt.close();
	server.close();
	process.exit(0);
`;

describe("one crossing for many streams (r4 N-1)", () => {
	it("delivers every stream completed while the thread was busy in a single crossing", async () => {
		const res = childResult(
			await runChild(oneCrossingBody, {
				WEBTRANSPORT_STREAM_READ_GROUP: undefined,
				WEBTRANSPORT_STREAM_BATCH_BYTES: undefined,
				WT_TEST_PORT: String(nextPort(29100, 100)),
			}),
		) as {
			lengths: number[];
			group: { crossings: number; maxEntriesPerCrossing: number };
		};
		expect(res.lengths).toEqual(new Array(6).fill(1000));
		expect(res.group.maxEntriesPerCrossing).toBe(6);
	}, 60_000);
});
