import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	connectWasm,
	connectWasmUnified,
	createWasmServer,
} from "../src/backend.js";
import type { WasmModule } from "../src/backend-wasm.js";
import { BunUdpTransport } from "../src/bun-udp.js";
import type { WebTransportLike } from "../src/shared.js";
import type { nativeToWebTransportLike } from "../src/webtransport-like-native.js";
import type { wasmToWebTransportLike } from "../src/webtransport-like-wasm.js";

const pkgPath = fileURLToPath(
	new URL("../../../crates/wasm/pkg/webtransport_wasm.js", import.meta.url),
);
const wasmAvailable = existsSync(pkgPath);
const wasm = wasmAvailable
	? ((await import(pkgPath)) as unknown as WasmModule)
	: (null as unknown as WasmModule);

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Drain the first chunk emitted by a WtBidiStream's readable. */
async function readFirst(
	readable: ReadableStream<Uint8Array>,
	timeoutMs = 5000,
): Promise<Uint8Array | null> {
	const reader = readable.getReader();
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) return null;
			if (value && value.length > 0) return value;
		}
		return null;
	} finally {
		reader.releaseLock();
	}
}

describe("unified WebTransportLike contract (wasm backend)", () => {
	test.skipIf(!wasmAvailable)(
		"connect + datagram echo + bidi echo through WebTransportLike only",
		async () => {
			const PORT = 47840;
			const serverUdp = await BunUdpTransport.bind("127.0.0.1", PORT);
			const server = createWasmServer(
				wasm,
				serverUdp,
				(session) => {
					session.onDatagram((d) => session.sendDatagram(d));
					session.onIncomingStream((stream) => {
						stream.onData((data) => {
							if (data.length > 0) stream.write(data);
						});
					});
				},
				`127.0.0.1:${PORT}`,
				"127.0.0.1:0",
			);

			const clientUdp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const { transport, manager } = await connectWasmUnified(
				wasm,
				clientUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
			);

			// Everything below uses ONLY the WebTransportLike surface.
			const client: WebTransportLike = transport;
			await client.ready;

			// Datagram echo.
			const dgrams = client.incomingDatagrams()[Symbol.asyncIterator]();
			await client.sendDatagram(enc.encode("udp-dg"));
			const dgResult = await dgrams.next();
			expect(dgResult.done).toBe(false);
			expect(dec.decode(dgResult.value)).toBe("udp-dg");

			// Bidi echo.
			const bidi = await client.createBidirectionalStream();
			const writer = bidi.writable.getWriter();
			await writer.write(enc.encode("udp-stream"));
			const echoed = await readFirst(bidi.readable);
			expect(echoed).not.toBeNull();
			expect(dec.decode(echoed as Uint8Array)).toBe("udp-stream");

			client.close();
			manager.close();
			server.close();
			clientUdp.close();
			serverUdp.close();
		},
	);

	// Regression: writes larger than the QUIC flow-control window must not be
	// silently truncated — the writable retries until every byte is accepted,
	// and the reader's backpressure (pause/resume) must not deadlock delivery.
	test.skipIf(!wasmAvailable)(
		"large bidi payload round-trips fully (write loop + flow control)",
		async () => {
			const PORT = 47841;
			const serverUdp = await BunUdpTransport.bind("127.0.0.1", PORT);
			const server = createWasmServer(
				wasm,
				serverUdp,
				(session) => {
					session.onIncomingStream((stream) => {
						// Serialize echo writes: writeAll waits out closed flow-control
						// windows, so chunks must queue rather than interleave.
						let queue = Promise.resolve();
						stream.onData((data, fin) => {
							queue = queue.then(async () => {
								if (data.length > 0) await stream.writeAll(data);
								if (fin) stream.finish();
							});
						});
					});
				},
				`127.0.0.1:${PORT}`,
				"127.0.0.1:0",
			);

			const clientUdp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const { transport, manager } = await connectWasmUnified(
				wasm,
				clientUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
			);
			await transport.ready;

			// 2 MiB of a repeating pattern — far beyond a single datagram and
			// large enough to exercise stream flow-control windows.
			const SIZE = 2 * 1024 * 1024;
			const payload = new Uint8Array(SIZE);
			for (let i = 0; i < SIZE; i++) payload[i] = i % 251;

			const bidi = await transport.createBidirectionalStream();
			const writer = bidi.writable.getWriter();
			const writeDone = (async () => {
				await writer.write(payload);
				await writer.close();
			})();

			const received: Uint8Array[] = [];
			let total = 0;
			const reader = bidi.readable.getReader();
			const deadline = Date.now() + 30_000;
			while (total < SIZE && Date.now() < deadline) {
				const { value, done } = await reader.read();
				if (done) break;
				if (value) {
					received.push(value);
					total += value.length;
				}
			}
			await writeDone;

			expect(total).toBe(SIZE);
			const flat = new Uint8Array(total);
			let off = 0;
			for (const c of received) {
				flat.set(c, off);
				off += c.length;
			}
			expect(flat).toEqual(payload);

			transport.close();
			manager.close();
			server.close();
			clientUdp.close();
			serverUdp.close();
		},
		40_000,
	);

	// Regression: a bidi echo server that FINs its send half when the client
	// FINs lets the client read the echo to completion (done:true) instead of
	// hanging on the final read.
	test.skipIf(!wasmAvailable)(
		"bidi stream readable closes when the echo server FINs",
		async () => {
			const PORT = 47843;
			const serverUdp = await BunUdpTransport.bind("127.0.0.1", PORT);
			const server = createWasmServer(
				wasm,
				serverUdp,
				(session) => {
					session.onIncomingStream((stream) => {
						let queue = Promise.resolve();
						stream.onData((data, fin) => {
							queue = queue
								.then(async () => {
									if (data.length > 0) await stream.writeAll(data);
									if (fin) stream.finish();
								})
								.catch(() => {});
						});
					});
				},
				`127.0.0.1:${PORT}`,
				"127.0.0.1:0",
			);

			const clientUdp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const { transport, manager } = await connectWasmUnified(
				wasm,
				clientUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
			);
			await transport.ready;

			const bidi = await transport.createBidirectionalStream();
			const writer = bidi.writable.getWriter();
			await writer.write(enc.encode("ping"));
			await writer.close(); // FIN our send half

			const reader = bidi.readable.getReader();
			const chunks: Uint8Array[] = [];
			let closed = false;
			const deadline = Date.now() + 15_000;
			while (Date.now() < deadline) {
				const { value, done } = await reader.read();
				if (done) {
					closed = true;
					break;
				}
				if (value) chunks.push(value);
			}
			expect(closed).toBe(true); // readable actually closed, no hang
			const flat = chunks.map((c) => dec.decode(c)).join("");
			expect(flat).toBe("ping");

			transport.close();
			manager.close();
			server.close();
			clientUdp.close();
			serverUdp.close();
		},
		20_000,
	);

	// Regression: cancelling an incoming stream's readable must not throw
	// repeatedly nor leak — it STOP_SENDINGs and releases cleanly.
	test.skipIf(!wasmAvailable)(
		"cancelling a bidi readable is clean (STOP_SENDING, no throw loop)",
		async () => {
			const PORT = 47844;
			const serverUdp = await BunUdpTransport.bind("127.0.0.1", PORT);
			let errorSeen = false;
			const server = createWasmServer(
				wasm,
				serverUdp,
				(session) => {
					session.onIncomingStream((stream) => {
						// Keep sending after the client cancels.
						let n = 0;
						const iv = setInterval(() => {
							if (n++ > 20) return clearInterval(iv);
							try {
								stream.writeAll(enc.encode(`chunk-${n}`)).catch(() => {});
							} catch {
								clearInterval(iv);
							}
						}, 5);
					});
				},
				`127.0.0.1:${PORT}`,
				"127.0.0.1:0",
			);

			const clientUdp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const { session, manager } = await connectWasm(
				wasm,
				clientUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
			);
			manager.onCallbackError = () => {
				errorSeen = true;
			};
			await session.ready;

			const stream = session.createBidirectionalStream();
			stream.write(enc.encode("hi"));
			// Wire a readable and cancel it immediately.
			const readable = new ReadableStream<Uint8Array>({
				start(controller) {
					stream.onData((d: Uint8Array) => {
						try {
							controller.enqueue(d);
						} catch {}
					});
				},
				cancel() {
					stream.stop(0);
				},
			});
			const reader = readable.getReader();
			await reader.cancel();

			// Let the server keep sending; a clean cancel must not spew errors.
			await new Promise((r) => setTimeout(r, 300));
			expect(errorSeen).toBe(false);

			manager.close();
			server.close();
			clientUdp.close();
			serverUdp.close();
		},
		20_000,
	);

	// Regression: a pending reader.read() on an open stream must settle (error
	// or done), not hang forever, when the underlying connection goes away.
	test.skipIf(!wasmAvailable)(
		"stream readers settle when the connection closes",
		async () => {
			const PORT = 47842;
			const serverUdp = await BunUdpTransport.bind("127.0.0.1", PORT);
			let serverSession: { close: () => void } | null = null;
			const server = createWasmServer(
				wasm,
				serverUdp,
				(session) => {
					serverSession = session;
					session.onIncomingStream(() => {
						// Accept the stream but never reply — the client reader waits.
					});
				},
				`127.0.0.1:${PORT}`,
				"127.0.0.1:0",
			);

			const clientUdp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const { transport, manager } = await connectWasmUnified(
				wasm,
				clientUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
			);
			await transport.ready;

			const bidi = await transport.createBidirectionalStream();
			const writer = bidi.writable.getWriter();
			await writer.write(enc.encode("hello?"));

			const reader = bidi.readable.getReader();
			const pendingRead = reader.read().then(
				(r) => ({ settled: true as const, done: r.done, errored: false }),
				() => ({ settled: true as const, done: true, errored: true }),
			);

			// Give the stream a moment to reach the server, then drop the server
			// endpoint entirely — the client sees the connection die (idle/close).
			await new Promise((r) => setTimeout(r, 300));
			expect(serverSession).not.toBeNull();
			server.close();
			serverUdp.close();

			const outcome = await Promise.race([
				pendingRead,
				new Promise<{ settled: false }>((r) =>
					setTimeout(() => r({ settled: false }), 20_000),
				),
			]);
			expect(outcome.settled).toBe(true);

			transport.close();
			manager.close();
			clientUdp.close();
		},
		30_000,
	);
});

describe("WebTransportLike type-level assignability", () => {
	test("wasm impl and native adapter satisfy WebTransportLike", () => {
		// Compile-time checks: these typecheck under `tsc --noEmit` (the real proof).
		type WasmAssignable =
			ReturnType<typeof wasmToWebTransportLike> extends WebTransportLike
				? true
				: never;
		type NativeAssignable =
			ReturnType<typeof nativeToWebTransportLike> extends WebTransportLike
				? true
				: never;
		const _wasmCheck: WasmAssignable = true;
		const _nativeCheck: NativeAssignable = true;
		expect(_wasmCheck && _nativeCheck).toBe(true);
	});
});
