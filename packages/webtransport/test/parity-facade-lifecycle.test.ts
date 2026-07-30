/**
 * Parity tests: WebTransport facade lifecycle (Phase P1).
 * Verifies ready, closed, draining behavior.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { toWebTransport } from "../src/index.js";
import { collectWithTimeout, withTimeout } from "./helpers/harness.js";
import { connectWithRetry } from "./helpers/network.js";
import {
	createParityHarness,
	isWasmParityBackend,
	type ParityHarness,
	type ParityServerSession,
	skipWasmParityIfUnavailable,
	wasmParityReady,
} from "./helpers/parity-backend.js";

describe.skipIf(skipWasmParityIfUnavailable)(
	"parity facade lifecycle (P1)",
	() => {
		let harness: ParityHarness;
		let onServerSession: (session: ParityServerSession) => void = () => {};

		beforeAll(async () => {
			harness = await createParityHarness({
				onSession: (session) => onServerSession(session),
			});
		});

		afterAll(async () => {
			await harness.close();
		});

		test("WebTransport constructor + ready resolves when connected", async () => {
			const wt = await harness.open();
			expect(wt.ready).toBeDefined();
			wt.close();
		});

		test("WebTransport closed resolves with WebTransportCloseInfo when session closes", async () => {
			const wt = await harness.open();
			wt.close({ closeCode: 0, reason: "test done" });
			const info = await wt.closed;
			expect(info).toBeDefined();
			expect(typeof info).toBe("object");
		});

		test("WebTransport draining resolves when close() is called (before closed)", async () => {
			const wt = await harness.open();
			const drainStart = Date.now();
			wt.close();
			await wt.draining;
			const drainElapsed = Date.now() - drainStart;
			expect(drainElapsed).toBeLessThan(500); // draining should resolve promptly when close() is called
			await wt.closed;
		});

		test("draining resolves on a peer drain, and the session stays usable", async () => {
			// The local-close test above cannot tell a wire-driven `draining` from
			// one the facade resolved itself. Here nothing closes: the server sends
			// a WT_DRAIN_SESSION capsule and the session must keep working, which
			// only the real signal can produce.
			// `open()` retries, so more than one server session can exist; a
			// token round-trip identifies the one actually backing this client.
			const token = `drain-${Math.random().toString(36).slice(2)}`;
			let server: ParityServerSession | undefined;
			onServerSession = (session) => {
				void (async () => {
					const decoder = new TextDecoder();
					for await (const d of session.incomingDatagrams()) {
						if (decoder.decode(d) === token) {
							server = session;
							return;
						}
					}
				})().catch(() => {});
			};
			try {
				const wt = await harness.open();
				await wt.ready;
				const writer = wt.datagrams.writable.getWriter();
				const deadline = Date.now() + 5000;
				// Datagrams are unreliable; resend until the server has one.
				while (!server && Date.now() < deadline) {
					await writer.write(new TextEncoder().encode(token));
					await new Promise((r) => setTimeout(r, 25));
				}
				writer.releaseLock();
				expect(server).toBeDefined();

				let closedEarly = false;
				void wt.closed.then(
					() => {
						closedEarly = true;
					},
					() => {
						closedEarly = true;
					},
				);

				server?.drain();
				await withTimeout(wt.draining, 5000, "parity peer drain");

				// A drain is a warning, not an ending: the session must still be
				// open and still able to carry a new stream.
				expect(closedEarly).toBe(false);
				const stream = await wt.createBidirectionalStream();
				const streamWriter = stream.writable.getWriter();
				await streamWriter.write(new Uint8Array([1, 2, 3]));
				streamWriter.releaseLock();

				wt.close();
				await wt.closed;
			} finally {
				onServerSession = () => {};
			}
		});

		test("createBidirectionalStream rejects with E_SESSION_CLOSED after close()", async () => {
			const wt = await harness.open();
			wt.close();
			await expect(wt.createBidirectionalStream()).rejects.toMatchObject({
				code: "E_SESSION_CLOSED",
			});
		});

		test("lifecycle ordering: ready resolves first, draining and closed resolve after close()", async () => {
			const wt = await harness.open();
			wt.close({ closeCode: 1000, reason: "ordering test" });
			const [drainResult, closeInfo] = await Promise.all([
				wt.draining,
				wt.closed,
			]);
			expect(drainResult).toBeUndefined();
			expect(closeInfo).toBeDefined();
			expect(typeof closeInfo).toBe("object");
			expect("closeCode" in closeInfo || "reason" in closeInfo).toBe(true);
		});

		test("toWebTransport wraps ClientSession with same lifecycle shape", async () => {
			// toWebTransport wraps a native ClientSession; no wasm equivalent exists.
			if (isWasmParityBackend()) {
				expect(wasmParityReady()).toBe(true);
				return;
			}
			const session = await connectWithRetry(harness.url, {
				tls: { insecureSkipVerify: true },
			});
			const wt = toWebTransport(session);
			await wt.ready;
			expect(wt.closed).toBeDefined();
			expect(wt.draining).toBeDefined();
			session.close();
			const info = await wt.closed;
			expect(info).toBeDefined();
		});

		test("WebTransport.datagrams exists (readable + writable)", async () => {
			const wt = await harness.open();
			expect(wt.datagrams).toBeDefined();
			expect(wt.datagrams.readable).toBeInstanceOf(ReadableStream);
			expect(wt.datagrams.writable).toBeInstanceOf(WritableStream);
			wt.close();
		});

		test("WebTransport.incomingBidirectionalStreams and incomingUnidirectionalStreams exist", async () => {
			const wt = await harness.open();
			expect(wt.incomingBidirectionalStreams).toBeInstanceOf(ReadableStream);
			expect(wt.incomingUnidirectionalStreams).toBeInstanceOf(ReadableStream);
			wt.close();
		});

		test("incomingDatagrams iterator terminates when session closes", async () => {
			// connectWithRetry yields a native ClientSession; no wasm equivalent.
			if (isWasmParityBackend()) {
				expect(wasmParityReady()).toBe(true);
				return;
			}
			const session = await connectWithRetry(harness.url, {
				tls: { insecureSkipVerify: true },
			});
			session.close({ code: 1000, reason: "termination test" });
			const count = (
				await collectWithTimeout(
					session.incomingDatagrams(),
					5000,
					"parity facade lifecycle incoming datagrams termination",
				)
			).length;
			expect(count).toBe(0);
		});

		test("incomingBidirectionalStreams iterator terminates when session closes", async () => {
			// connectWithRetry yields a native ClientSession; no wasm equivalent.
			if (isWasmParityBackend()) {
				expect(wasmParityReady()).toBe(true);
				return;
			}
			const session = await connectWithRetry(harness.url, {
				tls: { insecureSkipVerify: true },
			});
			session.close({ code: 1000, reason: "bidi termination test" });
			const count = (
				await collectWithTimeout(
					session.incomingBidirectionalStreams(),
					5000,
					"parity facade lifecycle incoming bidi termination",
				)
			).length;
			expect(count).toBe(0);
		});

		test("incomingUnidirectionalStreams iterator terminates when session closes", async () => {
			// connectWithRetry yields a native ClientSession; no wasm equivalent.
			if (isWasmParityBackend()) {
				expect(wasmParityReady()).toBe(true);
				return;
			}
			const session = await connectWithRetry(harness.url, {
				tls: { insecureSkipVerify: true },
			});
			session.close({ code: 1000, reason: "uni termination test" });
			const count = (
				await collectWithTimeout(
					session.incomingUnidirectionalStreams(),
					5000,
					"parity facade lifecycle incoming uni termination",
				)
			).length;
			expect(count).toBe(0);
		});
	},
);
