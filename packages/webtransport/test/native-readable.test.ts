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
		},
	};
}

const tick = () => new Promise((r) => setTimeout(r, 0));

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
		expect(Array.from((await first).value ?? [])).toEqual([1, 2, 3]);
		const second = reader.read();
		await tick();
		h.settle(new Uint8Array([4]));
		expect(Array.from((await second).value ?? [])).toEqual([4]);
		const last = reader.read();
		await tick();
		h.settle(null);
		expect((await last).done).toBe(true);
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
		await pending;
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
		expect(Array.from((await pending).value ?? [])).toEqual([9]);
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
		await expect(pending).rejects.toThrow("mapped:E_STREAM_RESET");
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
		await expect(pending).rejects.toThrow("mapped:boom");
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
		expect((await pending).done).toBe(true);
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
		await reader.cancel("bye");
		expect((await pending).done).toBe(true);
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
		expect((await reader.read()).done).toBe(true);
	});

	it("passes cancel to the owner with its reason", async () => {
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const readable = __TESTING__.createNativeByteReadableForTests(o.owner);
		await readable.cancel("bye");
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
		expect(Array.from((await first).value ?? [])).toEqual([1, 2]);
		const rest = await reader.read(new Uint8Array(8));
		expect(Array.from(rest.value ?? [])).toEqual([3]);
		expect(h.reads).toBe(1);
		// EOF must settle a BYOB read that is already waiting.
		const end = reader.read(new Uint8Array(4));
		await tick();
		h.settle(null);
		expect((await end).done).toBe(true);
	});
});

/** A group whose `next()` resolves when the test pushes entries. */
function fakeGroup() {
	const grants: Array<[number, number]> = [];
	const cancels: number[] = [];
	let wakes = 0;
	let waiter: ((v: Array<number | Value> | null) => void) | null = null;
	let backlog: Array<number | Value> = [];
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
		const out = backlog;
		backlog = [];
		w(out);
	};
	const group = {
		id: 7,
		next: (_max: number) =>
			new Promise<Array<number | Value> | null>((resolve) => {
				waiter = resolve;
				flush();
			}),
		grant: (key: number, bytes: number) => grants.push([key, bytes]),
		cancel: (key: number) => cancels.push(key),
		wake: () => {
			wakes++;
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
		cancels,
		get wakes() {
			return wakes;
		},
		get parked() {
			return waiter !== null;
		},
		push(...entries: Array<number | Value>) {
			backlog.push(...entries);
			flush();
		},
	};
}

function feedable() {
	const feeds: Array<[number, number, number, number]> = [];
	let finish: (code: string | null) => void = () => {};
	return {
		feeds,
		handle: {
			feedReadGroup: (g: number, key: number, max: number, win: number) => {
				feeds.push([g, key, max, win]);
				return new Promise<string | null>((r) => {
					finish = r;
				});
			},
		},
		finish: (code: string | null) => finish(code),
	};
}

describe("read group pump (fix A)", () => {
	const WINDOW = 1000;

	it("starts no feeder and reads nothing ahead until the first read", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
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
		expect(f.feeds).toEqual([[7, f.feeds[0]?.[1] as number, 0, WINDOW]]);
		expect(g.parked).toBe(true);
		g.push(f.feeds[0]?.[1] as number, null);
		expect((await pending).done).toBe(true);
	});

	it("demultiplexes one crossing's entries into each stream, in order", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
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
		expect(a.feeds[0]?.[3]).toBe(WINDOW);
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
		expect(Array.from((await pa).value ?? [])).toEqual([1]);
		expect(Array.from((await pb).value ?? [])).toEqual([2, 2]);
		// The second chunk for a is queued in its stream, not lost.
		expect(Array.from((await ra.read()).value ?? [])).toEqual([3]);
		g.push(ka, null, kb, null);
		expect((await ra.read()).done).toBe(true);
		expect((await rb.read()).done).toBe(true);
		expect(oa.events).toEqual(["bytes:1", "bytes:1", "end"]);
		expect(ob.events).toEqual(["bytes:2", "end"]);
		await tick();
		expect(pump.size).toBe(0);
	});

	it("counts crossings, entries and bytes on its instrument", async () => {
		__TESTING__.resetReadGroupDiagnosticsForTests();
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
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
		await pa;
		await pb;
		g.push(kb, null);
		await ra.read();
		await rb.read();
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

	it("re-grants the window only as the consumer drains it (backpressure)", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const first = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		// The first pull starts the feeder with its window; delivered but
		// unread bytes never trigger a grant.
		g.push(key, new Uint8Array(400), key, new Uint8Array(400));
		await first;
		await tick();
		expect(g.grants).toEqual([]);
		// Reading drains the stream; the pull on the empty queue tops the
		// feeder back up to a full window (800 spent -> grant 800).
		await r.read();
		const waiting = r.read();
		await tick();
		expect(g.grants).toEqual([[key, 800]]);
		// Under half spent: the next pull grants nothing.
		g.push(key, new Uint8Array(100));
		await waiting;
		const again = r.read();
		await tick();
		expect(g.grants).toEqual([[key, 800]]);
		g.push(key, null);
		expect((await again).done).toBe(true);
	});

	it("errors only the stream whose entry carries an error code", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
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
		await expect(pa).rejects.toThrow("mapped:E_STREAM_RESET");
		expect(Array.from((await pb).value ?? [])).toEqual([5]);
		expect(oa.events).toEqual(["error:E_STREAM_RESET"]);
	});

	it("contains a delivery that throws to its own stream", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
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
		await expect(pa).rejects.toThrow("mapped:app hook threw");
		// The rest of the batch still landed on the other stream.
		expect(Array.from((await pb).value ?? [])).toEqual([2]);
		// The failed stream's still-running feeder is told to stop (r2 N7b).
		expect(g.cancels).toEqual([ka]);
	});

	it("cancels a started feeder and drops its late entries", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		await r.cancel("stop");
		expect((await pending).done).toBe(true);
		expect(g.cancels).toEqual([key]);
		expect(o.events).toEqual(["cancel:stop"]);
		g.push(key, new Uint8Array([1]));
		await tick();
		expect(o.events).toEqual(["cancel:stop"]);
	});

	it("cancels an unread stream without ever starting a feeder", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		await pump.attach(f.handle, o.owner).cancel("stop");
		expect(f.feeds).toEqual([]);
		expect(g.cancels).toEqual([]);
		expect(o.events).toEqual(["cancel:stop"]);
		expect(pump.size).toBe(0);
	});

	it("settles a waiting read when the owner is released mid-read (data arrives)", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		o.release();
		g.push(key, new Uint8Array([1]));
		expect((await pending).done).toBe(true);
		// The feeder was still running, so it is told to stop.
		expect(g.cancels).toEqual([key]);
		expect(o.events).toEqual([]);
		expect(pump.size).toBe(0);
	});

	it("does not cancel a released feeder whose terminal entry rides the same batch", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		o.release();
		g.push(key, new Uint8Array([1]), key, null);
		expect((await pending).done).toBe(true);
		await tick();
		// The feeder already ended and unregistered: a cancel would only park
		// a key natively (r2 N7a).
		expect(g.cancels).toEqual([]);
	});

	it("settles a waiting read when the owner is released mid-read (the read aborts)", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		o.release();
		// Disposal aborts the native read: the feeder's last entry.
		g.push(key, "E_STREAM_RESET");
		expect((await pending).done).toBe(true);
		expect(g.cancels).toEqual([]);
		expect(pump.size).toBe(0);
	});

	it("closes at the first read when the owner was released before it", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		o.release();
		expect((await r.read()).done).toBe(true);
		expect(f.feeds).toEqual([]);
	});

	it("surfaces a feeder that could not start as a stream error", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		f.finish("E_INVALID_ARGUMENT: unknown read group");
		await expect(pending).rejects.toThrow("mapped:E_INVALID_ARGUMENT");
	});

	it("stops pumping (wakes the pending next) when its last feeder ends", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const f = feedable();
		const o = ownerFor({ read: async () => null });
		const r = pump.attach(f.handle, o.owner).getReader();
		const pending = r.read();
		await tick();
		const key = f.feeds[0]?.[1] as number;
		expect(g.parked).toBe(true);
		g.push(key, null);
		expect((await pending).done).toBe(true);
		await tick();
		await tick();
		expect(g.wakes).toBe(1);
		expect(g.parked).toBe(false);
	});

	it("falls back to the direct readable for a handle that cannot feed", async () => {
		const g = fakeGroup();
		const pump = new __TESTING__.ReadGroupPumpForTests(g.group, WINDOW);
		const h = scriptedHandle();
		const o = ownerFor(h.handle);
		const r = pump.attach(h.handle as never, o.owner).getReader();
		const pending = r.read();
		await tick();
		h.settle(new Uint8Array([4]));
		expect(Array.from((await pending).value ?? [])).toEqual([4]);
		expect(pump.size).toBe(0);
	});
});

describe("read group knob", () => {
	it("is off unless set to 1, with a 256 KiB default window", async () => {
		const off = childResult(
			await runChild(
				`const { __TESTING__ } = await import(INTERNAL_MODULE);
				 report(__TESTING__.readGroupConfigForTests());`,
				{ WEBTRANSPORT_STREAM_READ_GROUP: undefined },
			),
		);
		expect(off).toEqual({ enabled: false, window: 256 * 1024 });
		const on = childResult(
			await runChild(
				`const { __TESTING__ } = await import(INTERNAL_MODULE);
				 report(__TESTING__.readGroupConfigForTests());`,
				{
					WEBTRANSPORT_STREAM_READ_GROUP: "1",
					WEBTRANSPORT_STREAM_READ_GROUP_WINDOW: "65536",
				},
			),
		);
		expect(on).toEqual({ enabled: true, window: 65536 });
	});
});

// Real transfers over the W3C surface on both ends: server-accepted bidi and
// uni readables (direct or group-fed), and the client's created-bidi readable
// (direct, fix B), with a BYOB read on the client.
const transferBody = `
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
			const { done, value } = await r.read();
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
				const { value: stream } = await bidi.read();
				work.push((async () => {
					const got = await drain(stream.readable);
					const w = stream.writable.getWriter();
					for (let sent = 0; sent < TOTAL; sent += CHUNK) {
						await w.write(new Uint8Array(CHUNK).fill(pattern(5, sent / CHUNK)));
					}
					await w.close();
					return got;
				})());
			}
			const { value: recv } = await uni.read();
			const uniGot = await drain(recv);
			resolveServer({ bidi: await Promise.all(work), uni: uniGot });
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
	await wt.ready;
	const echoes = [];
	for (let s = 0; s < STREAMS; s++) {
		const { readable, writable } = await wt.createBidirectionalStream();
		const w = writable.getWriter();
		(async () => {
			for (let sent = 0; sent < TOTAL; sent += CHUNK) {
				const v = new Uint8Array(CHUNK);
				for (let i = 0; i < CHUNK; i++) v[i] = pattern(s, sent + i);
				await w.write(v);
			}
			await w.close();
		})();
		if (s === 0) {
			// BYOB on the client's direct readable.
			const r = readable.getReader({ mode: "byob" });
			echoes.push((async () => {
				let n = 0;
				for (;;) {
					const { done, value } = await r.read(new Uint8Array(777));
					if (done) break;
					n += value.byteLength;
				}
				return { n };
			})());
		} else {
			echoes.push(drain(readable).then((x) => ({ n: x.n })));
		}
	}
	const uw = (await wt.createUnidirectionalStream()).getWriter();
	for (let sent = 0; sent < TOTAL; sent += CHUNK) {
		const v = new Uint8Array(CHUNK);
		for (let i = 0; i < CHUNK; i++) v[i] = pattern(99, sent + i);
		await uw.write(v);
	}
	await uw.close();
	const got = await serverDone;
	const echo = await Promise.all(echoes);
	report({
		cfg: __TESTING__.readGroupConfigForTests(),
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
			name: "direct",
			env: {
				WEBTRANSPORT_STREAM_READ_GROUP: undefined,
				WEBTRANSPORT_STREAM_BATCH_BYTES: undefined,
			},
		},
		{
			name: "read group",
			env: {
				WEBTRANSPORT_STREAM_READ_GROUP: "1",
				WEBTRANSPORT_STREAM_READ_GROUP_WINDOW: "16384",
				WEBTRANSPORT_STREAM_BATCH_BYTES: undefined,
			},
		},
		{
			name: "read group, batch knob on",
			env: {
				WEBTRANSPORT_STREAM_READ_GROUP: "1",
				WEBTRANSPORT_STREAM_READ_GROUP_WINDOW: "16384",
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
				cfg: { enabled: boolean };
				bidiOk: boolean[];
				uniOk: boolean;
				echo: number[];
			};
			expect(res.cfg.enabled).toBe(arm.name.startsWith("read group"));
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
const halfCloseBody = `
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
			const { value: stream } = await r.read();
			const w = stream.writable.getWriter();
			await w.write(new Uint8Array([1]));
			const rd = stream.readable.getReader();
			let n = 0, error = null;
			try {
				for (;;) { const x = await rd.read(); if (x.done) break; n += x.value.byteLength; }
			} catch (e) { error = String(e); }
			resolveGot({ n, error });
		},
	});
	const wt = new WebTransport("https://127.0.0.1:" + port, { tls: { insecureSkipVerify: true } });
	await wt.ready;
	const { readable, writable } = await wt.createBidirectionalStream();
	const w = writable.getWriter();
	await w.write(new Uint8Array(10));
	const rr = readable.getReader();
	await rr.read();
	await rr.cancel("done reading");
	await Bun.sleep(100);
	let writeError = null;
	try { await w.write(new Uint8Array(20)); await w.close(); } catch (e) { writeError = String(e); }
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
