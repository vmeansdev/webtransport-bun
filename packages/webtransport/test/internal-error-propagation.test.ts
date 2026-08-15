import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import {
	E_BACKPRESSURE_TIMEOUT,
	E_HANDSHAKE_TIMEOUT,
	E_INTERNAL,
	E_INVALID_ARGUMENT,
	E_LIMIT_EXCEEDED,
	E_QUEUE_FULL,
	E_RATE_LIMITED,
	E_SESSION_CLOSED,
	E_SESSION_IDLE_TIMEOUT,
	E_STOP_SENDING,
	E_STREAM_RESET,
	E_TLS,
	E_UNSUPPORTED_ARGUMENT,
	WebTransport,
	WebTransportError,
} from "../src/index.js";
import { __TESTING__ } from "../src/internal.js";
import { nextWithTimeout, readWithTimeout } from "./helpers/harness.js";

describe("internal TS error propagation", () => {
	it("native error parser only recognizes enumerated stable codes", async () => {
		expect(__TESTING__.nativeErrorCodes).toEqual([
			E_TLS,
			E_HANDSHAKE_TIMEOUT,
			E_SESSION_CLOSED,
			E_SESSION_IDLE_TIMEOUT,
			E_STREAM_RESET,
			E_STOP_SENDING,
			E_QUEUE_FULL,
			E_BACKPRESSURE_TIMEOUT,
			E_LIMIT_EXCEEDED,
			E_RATE_LIMITED,
			E_INVALID_ARGUMENT,
			E_UNSUPPORTED_ARGUMENT,
			E_INTERNAL,
		]);

		const session = __TESTING__.createNativeClientSessionForTests({
			sendDatagram: async () => {
				throw new Error("E_HANDSHAKE_TIMEOUTX: not a real code");
			},
			close: () => {},
		});
		await expect(
			session.sendDatagram(new Uint8Array([1])),
		).rejects.toMatchObject({
			code: E_INTERNAL,
		});
	});

	it("native error parser prefers explicit err.code when present", async () => {
		const wrapped = new Error("not a real code message") as Error & {
			code: string;
		};
		wrapped.code = "E_HANDSHAKE_TIMEOUT";
		const session = __TESTING__.createNativeClientSessionForTests({
			sendDatagram: async () => {
				throw wrapped;
			},
			close: () => {},
		});
		await expect(
			session.sendDatagram(new Uint8Array([1])),
		).rejects.toMatchObject({
			code: E_HANDSHAKE_TIMEOUT,
			message: "not a real code message",
		});
	});

	it("native error parser strips Bun GenericFailure prefix and prefers causal codes", () => {
		expect(
			__TESTING__.extractMessageErrorCodeForTests(
				"GenericFailure, E_RATE_LIMITED: E_RATE_LIMITED: server rejected",
			),
		).toBe(E_RATE_LIMITED);
		expect(
			__TESTING__.extractMessageErrorCodeForTests(
				"GenericFailure, E_SESSION_CLOSED: connection closed by peer: E_LIMIT_EXCEEDED (code 3992)",
			),
		).toBe(E_LIMIT_EXCEEDED);
		expect(
			__TESTING__.extractMessageErrorCodeForTests(
				"E_BACKPRESSURE_TIMEOUT: waitUntilAvailable timed out",
			),
		).toBe(E_BACKPRESSURE_TIMEOUT);
	});

	it("NativeClientSession.incomingDatagrams propagates non-close errors", async () => {
		const session = __TESTING__.createNativeClientSessionForTests({
			readDatagram: async () => {
				throw new Error("E_INTERNAL: synthetic datagram failure");
			},
			readDatagramBatch: async () => {
				throw new Error("E_INTERNAL: synthetic datagram failure");
			},
			close: () => {},
		});
		const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
		let err: unknown;
		try {
			await nextWithTimeout(iter, 2000, "datagram error propagation read");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WebTransportError);
		expect((err as WebTransportError).code).toBe(E_INTERNAL);
	});

	it("NativeClientSession.incomingDatagrams treats session-close errors as EOF", async () => {
		const session = __TESTING__.createNativeClientSessionForTests({
			readDatagram: async () => {
				throw new Error(`${E_SESSION_CLOSED}: closed`);
			},
			readDatagramBatch: async () => {
				throw new Error(`${E_SESSION_CLOSED}: closed`);
			},
			close: () => {},
		});
		const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
		const first = await nextWithTimeout(
			iter,
			2000,
			"session-close datagram EOF read",
		);
		expect(first.done).toBe(true);
	});

	// The batched native read is reject-free by construction: closure arrives as
	// a resolved `null`, not as a thrown session-closed error. The two tests
	// above keep the rejection path covered for the synthetic/legacy case;
	// these pin the shape the real addon actually produces.
	for (const make of [
		[
			"NativeClientSession",
			__TESTING__.createNativeClientSessionForTests,
		] as const,
		[
			"NativeServerSession",
			__TESTING__.createNativeServerSessionForTests,
		] as const,
	]) {
		const [label, create] = make;
		it(`${label}.incomingDatagrams ends on a resolved null batch without rejecting`, async () => {
			let batchCalls = 0;
			const session = create({
				readDatagram: async () => {
					throw new Error("legacy readDatagram must not be called");
				},
				readDatagramBatch: async () => {
					batchCalls++;
					return batchCalls === 1 ? [new Uint8Array([7])] : null;
				},
				close: () => {},
			});
			const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
			const first = await nextWithTimeout(iter, 2000, `${label} batch item`);
			expect(first.done).toBe(false);
			expect(Array.from(first.value as Uint8Array)).toEqual([7]);
			const end = await nextWithTimeout(iter, 2000, `${label} batch EOF`);
			expect(end.done).toBe(true);
			expect(batchCalls).toBe(2);
		});

		it(`${label}.incomingDatagrams reports a missing batch method instead of falling back`, async () => {
			let legacyCalls = 0;
			const session = create({
				readDatagram: async () => {
					legacyCalls++;
					return new Uint8Array([1]);
				},
				close: () => {},
			});
			const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
			let err: unknown;
			try {
				await nextWithTimeout(iter, 2000, `${label} mismatch read`);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(WebTransportError);
			expect((err as WebTransportError).code).toBe(E_INTERNAL);
			expect((err as WebTransportError).message).toBe(
				"E_INTERNAL: native addon/JavaScript version mismatch; rebuild the matching prebuild",
			);
			expect(legacyCalls).toBe(0);
		});
	}

	it("legacy knob keeps the readDatagram rejection assertions intact", async () => {
		// WEBTRANSPORT_DATAGRAM_BATCH is resolved once at module initialization,
		// so the legacy path can only be asserted in a fresh process.
		const dir = mkdtempSync(join(tmpdir(), "wt-h7-legacy-"));
		const script = join(dir, "child.ts");
		const internalModule = new URL("../src/internal.ts", import.meta.url)
			.pathname;
		await Bun.write(
			script,
			`
			const { __TESTING__ } = await import(${JSON.stringify(internalModule)});
			const cfg = __TESTING__.datagramBatchConfigForTests();
			if (cfg.batchSize !== 0) throw new Error("child did not resolve the legacy knob");

			const results: Record<string, unknown> = {};
			let batchCalls = 0;
			// A legacy-knob session must never touch the batch entrypoint, even
			// when the handle offers one.
			const failing = __TESTING__.createNativeClientSessionForTests({
				readDatagram: async () => { throw new Error("E_INTERNAL: synthetic datagram failure"); },
				readDatagramBatch: async () => { batchCalls++; return null; },
				close: () => {},
			});
			try {
				await failing.incomingDatagrams()[Symbol.asyncIterator]().next();
				results.propagated = "no-throw";
			} catch (e: any) {
				results.propagated = e?.code ?? String(e);
			}

			const closing = __TESTING__.createNativeClientSessionForTests({
				readDatagram: async () => { throw new Error("E_SESSION_CLOSED: closed"); },
				readDatagramBatch: async () => { batchCalls++; return null; },
				close: () => {},
			});
			const end = await closing.incomingDatagrams()[Symbol.asyncIterator]().next();
			results.closeIsEof = end.done;
			results.batchCalls = batchCalls;
			console.log("__RESULT__" + JSON.stringify(results));
			`,
		);
		try {
			const proc = Bun.spawn([process.execPath, script], {
				env: { ...process.env, WEBTRANSPORT_DATAGRAM_BATCH: "0" },
				stdout: "pipe",
				stderr: "pipe",
			});
			const exited = await Promise.race([
				proc.exited,
				Bun.sleep(60_000).then(() => "timeout" as const),
			]);
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			if (exited === "timeout") {
				proc.kill();
				throw new Error(`legacy-knob child did not exit\n${stdout}\n${stderr}`);
			}
			expect(exited).toBe(0);
			const line = stdout
				.split("\n")
				.find((l) => l.startsWith("__RESULT__"))
				?.slice("__RESULT__".length);
			if (!line) throw new Error(`no result line\n${stdout}\n${stderr}`);
			expect(JSON.parse(line)).toEqual({
				propagated: E_INTERNAL,
				closeIsEof: true,
				batchCalls: 0,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 90_000);

	it("NativeClientSession.incomingBidirectionalStreams propagates non-close errors", async () => {
		const session = __TESTING__.createNativeClientSessionForTests({
			acceptBidiStream: async () => {
				throw new Error("E_INTERNAL: synthetic bidi accept failure");
			},
			close: () => {},
		});
		const iter = session.incomingBidirectionalStreams()[Symbol.asyncIterator]();
		let err: unknown;
		try {
			await nextWithTimeout(iter, 2000, "bidi accept error propagation read");
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(WebTransportError);
		expect((err as WebTransportError).code).toBe(E_INTERNAL);
	});

	it("NativeClientSession.incomingUnidirectionalStreams treats idle-timeout close as EOF", async () => {
		const session = __TESTING__.createNativeClientSessionForTests({
			acceptUniStream: async () => {
				throw new Error(`${E_SESSION_IDLE_TIMEOUT}: idle timeout`);
			},
			close: () => {},
		});
		const iter = session
			.incomingUnidirectionalStreams()
			[Symbol.asyncIterator]();
		const first = await nextWithTimeout(
			iter,
			2000,
			"idle-timeout uni EOF read",
		);
		expect(first.done).toBe(true);
	});

	it("server incoming bidi stream wrapper errors controller on non-close failures", async () => {
		const readable = __TESTING__.createServerIncomingBidiStreamsForTests(
			{
				acceptBidiStream: async () => {
					throw new Error("E_INTERNAL: synthetic server bidi accept failure");
				},
			},
			() => false,
		);
		const reader = readable.getReader();
		await expect(
			readWithTimeout(
				reader,
				2000,
				"server incoming bidi error propagation read",
			),
		).rejects.toMatchObject({ code: E_INTERNAL });
	});

	it("server incoming uni stream wrapper closes on session-closed failure", async () => {
		const readable = __TESTING__.createServerIncomingUniStreamsForTests(
			{
				acceptUniStream: async () => {
					throw new Error(`${E_SESSION_CLOSED}: closed`);
				},
			},
			() => false,
		);
		const reader = readable.getReader();
		const result = await readWithTimeout(
			reader,
			2000,
			"server incoming uni EOF read",
		);
		expect(result.done).toBe(true);
	});

	it("server incoming bidi wrappers release native handles when the session closes", async () => {
		let resolveClosed!: () => void;
		const closed = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});
		let accepted = true;
		const readable = __TESTING__.createServerIncomingBidiStreamsForTests(
			{
				acceptBidiStream: async () => {
					if (!accepted) return null;
					accepted = false;
					return {
						id: 1,
						read: async () => null,
						write: async () => {},
						finish: () => {},
					};
				},
			},
			() => false,
			closed,
		);
		const reader = readable.getReader();
		const result = await readWithTimeout(
			reader,
			2000,
			"server incoming bidi wrapper read",
		);
		expect(result.done).toBe(false);
		if (result.done || !result.value) throw new Error("missing bidi stream");
		const writer = result.value.writable.getWriter();
		resolveClosed();
		await Bun.sleep(0);
		await expect(writer.write(new Uint8Array([1]))).rejects.toBeInstanceOf(
			WebTransportError,
		);
		writer.releaseLock();
		await reader.cancel();
	});

	it("canceling the incoming bidi reader leaves accepted streams usable", async () => {
		const calls: string[] = [];
		let accepted = true;
		const readable = __TESTING__.createServerIncomingBidiStreamsForTests(
			{
				acceptBidiStream: async () => {
					if (!accepted) return new Promise(() => {});
					accepted = false;
					return {
						id: 11,
						read: () => new Promise(() => {}),
						write: async () => {
							calls.push("write");
						},
						finish: () => {
							calls.push("finish");
						},
						reset: (code: number) => calls.push(`reset:${code}`),
						stopSending: (code: number) => calls.push(`stop:${code}`),
						dispose: () => calls.push("dispose"),
					};
				},
			},
			() => false,
		);
		const reader = readable.getReader();
		const result = await readWithTimeout(reader, 2000, "accept before cancel");
		if (result.done || !result.value) throw new Error("missing bidi stream");
		const stream = result.value;
		await reader.cancel();
		await Bun.sleep(0);
		expect(calls).toEqual([]);
		const writer = stream.writable.getWriter();
		await writer.write(new Uint8Array([1]));
		await writer.close();
		expect(calls).toContain("write");
		expect(calls).toContain("finish");
		expect(calls.filter((c) => c.startsWith("reset"))).toEqual([]);
	});

	it("canceling the incoming uni reader leaves accepted streams readable", async () => {
		const calls: string[] = [];
		const chunks: (Buffer | null)[] = [Buffer.from([9]), null];
		let accepted = true;
		const readable = __TESTING__.createServerIncomingUniStreamsForTests(
			{
				acceptUniStream: async () => {
					if (!accepted) return new Promise(() => {});
					accepted = false;
					return {
						id: 12,
						read: async () => chunks.shift() ?? null,
						stopSending: (code: number) => calls.push(`stop:${code}`),
						dispose: () => calls.push("dispose"),
					};
				},
			},
			() => false,
		);
		const reader = readable.getReader();
		const result = await readWithTimeout(
			reader,
			2000,
			"accept uni before cancel",
		);
		if (result.done || !result.value) throw new Error("missing uni stream");
		const accepted0 = result.value;
		await reader.cancel();
		await Bun.sleep(0);
		expect(calls).toEqual([]);
		const streamReader = accepted0.getReader();
		const first = await readWithTimeout(
			streamReader,
			2000,
			"post-cancel uni read",
		);
		expect(first.done).toBe(false);
		expect(Array.from(first.value ?? [])).toEqual([9]);
	});

	it("readable.cancel keeps the writable half usable (W3C half-close)", async () => {
		const calls: string[] = [];
		let accepted = true;
		const readable = __TESTING__.createServerIncomingBidiStreamsForTests(
			{
				acceptBidiStream: async () => {
					if (!accepted) return null;
					accepted = false;
					return {
						id: 2,
						read: () => new Promise(() => {}),
						write: async () => {
							calls.push("write");
						},
						finish: () => {
							calls.push("finish");
						},
						reset: (code: number) => calls.push(`reset:${code}`),
						stopSending: (code: number) => calls.push(`stop:${code}`),
					};
				},
			},
			() => false,
		);
		const reader = readable.getReader();
		const result = await readWithTimeout(reader, 2000, "half-close accept");
		if (result.done || !result.value) throw new Error("missing bidi stream");
		const stream = result.value;
		await stream.readable.cancel();
		const writer = stream.writable.getWriter();
		await writer.write(new Uint8Array([1]));
		await writer.close();
		expect(calls).toContain("stop:0");
		expect(calls).toContain("write");
		expect(calls).toContain("finish");
		expect(calls.filter((c) => c.startsWith("reset"))).toEqual([]);
	});

	it("writable.abort keeps the readable half delivering (W3C half-close)", async () => {
		const calls: string[] = [];
		const chunks: (Buffer | null)[] = [Buffer.from([7]), null];
		let accepted = true;
		const readable = __TESTING__.createServerIncomingBidiStreamsForTests(
			{
				acceptBidiStream: async () => {
					if (!accepted) return null;
					accepted = false;
					return {
						id: 3,
						read: async () => chunks.shift() ?? null,
						write: async () => {},
						finish: () => {},
						reset: (code: number) => calls.push(`reset:${code}`),
						stopSending: (code: number) => calls.push(`stop:${code}`),
					};
				},
			},
			() => false,
		);
		const reader = readable.getReader();
		const result = await readWithTimeout(reader, 2000, "half-close accept 2");
		if (result.done || !result.value) throw new Error("missing bidi stream");
		const stream = result.value;
		const writer = stream.writable.getWriter();
		await writer.abort();
		const streamReader = stream.readable.getReader();
		const first = await readWithTimeout(streamReader, 2000, "post-abort read");
		expect(first.done).toBe(false);
		expect(Array.from(first.value ?? [])).toEqual([7]);
		const second = await readWithTimeout(streamReader, 2000, "post-abort EOF");
		expect(second.done).toBe(true);
		expect(calls).toContain("reset:0");
		expect(calls.filter((c) => c.startsWith("stop"))).toEqual([]);
	});

	it("Web Streams adapters apply strictW3CErrors to stream write failures", async () => {
		const duplex = new Duplex({
			read() {},
			write(_chunk, _encoding, callback) {
				callback(new Error(`${E_STOP_SENDING}: peer stopped`));
			},
		});
		const closed = new Promise<{ code?: number; reason?: string }>(() => {});
		const session = {
			id: "wrapped",
			peer: { ip: "127.0.0.1", port: 4433 },
			has0Rtt: false,
			accepted0Rtt: false,
			handshakeConfirmed: true,
			ready: Promise.resolve(),
			closed,
			draining: new Promise<void>(() => {}),
			close() {},
			drain() {},
			sendDatagram: async () => {},
			async *incomingDatagrams() {},
			createBidirectionalStream: async () => duplex,
			async *incomingBidirectionalStreams() {},
			createUnidirectionalStream: async () => duplex,
			async *incomingUnidirectionalStreams() {},
			metricsSnapshot: () => ({
				datagramsIn: 0,
				datagramsOut: 0,
				streamsActive: 0,
				queuedBytes: 0,
			}),
		};
		const wt = new WebTransport(session, { strictW3CErrors: true });
		const bidi = await wt.createBidirectionalStream();
		const writer = bidi.writable.getWriter();
		await expect(writer.write(new Uint8Array([1]))).rejects.toMatchObject({
			code: E_STOP_SENDING,
			name: "AbortError",
		});
	});
});
