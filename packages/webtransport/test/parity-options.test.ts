/**
 * Parity tests: Option surface and capability flags (Phase 5).
 *
 * Backend selector: set WEBTRANSPORT_PARITY_BACKEND=wasm to run against the
 * wasm W3C facade (InMemoryRelay). Default remains native.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { WebTransport } from "../src/index.js";
import { WasmWebTransport } from "../src/wasm-webtransport.js";
import { forEachWithTimeout, readWithTimeout } from "./helpers/harness.js";
import {
	createParityHarness,
	isWasmParityBackend,
	PARITY_BACKEND,
	skipWasmParityIfUnavailable,
	type ParityHarness,
	type ParityTransport,
} from "./helpers/parity-backend.js";

describe.skipIf(skipWasmParityIfUnavailable)(
	`parity options (Phase 5) [${PARITY_BACKEND}]`,
	() => {
		let harness: ParityHarness;

		beforeAll(async () => {
			harness = await createParityHarness({
				onSession: async (s) => {
					await forEachWithTimeout(
						s.incomingDatagrams(),
						5000,
						"parity options incoming datagram",
						async (d) => {
							await s.sendDatagram(d);
						},
					);
				},
			});
		});

		afterAll(async () => {
			await harness.close();
		});

		test("WebTransport.supportsReliableOnly is false", () => {
			if (isWasmParityBackend()) {
				expect(WasmWebTransport.supportsReliableOnly).toBe(false);
			} else {
				expect(WebTransport.supportsReliableOnly).toBe(false);
			}
		});

		test("congestionControl option accepted with effective mode exposed", async () => {
			const wt = await harness.open({
				congestionControl: "low-latency",
			});
			expect(wt.congestionControl).toBe("low-latency");
			wt.close();
		});

		test("congestionControl supports throughput mapping as a distinct effective mode", async () => {
			const wt = await harness.open({
				congestionControl: "throughput",
			});
			expect(wt.congestionControl).toBe("throughput");
			wt.close();
		});

		test("datagramsReadableType 'default' uses normal ReadableStream", async () => {
			const wt = await harness.open({});
			expect(wt.datagrams.readable).toBeInstanceOf(ReadableStream);
			wt.close();
		});

		test("datagramsReadableType 'bytes' creates ReadableByteStream and receives datagrams", async () => {
			const wt = await harness.open({
				datagramsReadableType: "bytes",
			});
			const reader = wt.datagrams.readable.getReader({ mode: "byob" });
			const writer = wt.datagrams.writable.getWriter();
			await Promise.race([
				writer.write(new Uint8Array([1, 2, 3])),
				Bun.sleep(4000).then(() => {
					throw new Error("timeout: datagram BYOB write");
				}),
			]);
			writer.releaseLock();
			const buf = new Uint8Array(128);
			const { value, done } = await readWithTimeout(
				reader,
				4000,
				"parity options BYOB datagram read",
				buf,
			);
			reader.releaseLock();
			expect(done).toBe(false);
			expect(value).toBeDefined();
			if (!value) {
				throw new Error("parity options BYOB read returned no value");
			}
			expect(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			).toEqual(new Uint8Array([1, 2, 3]));
			wt.close();
		}, 15000);

		test("datagramsReadableType 'bytes' BYOB buffer too small throws RangeError", async () => {
			const wt = await harness.open({
				datagramsReadableType: "bytes",
			});
			const writer = wt.datagrams.writable.getWriter();
			await writer.write(new Uint8Array([1, 2, 3, 4, 5]));
			writer.releaseLock();
			const reader = wt.datagrams.readable.getReader({ mode: "byob" });
			const tinyBuf = new Uint8Array(2);
			await expect(
				readWithTimeout(reader, 4000, "parity options tiny BYOB read", tinyBuf),
			).rejects.toThrow(RangeError);
			reader.releaseLock();
			wt.close();
		});

		test("invalid congestionControl throws", () => {
			expect(() =>
				harness.construct({
					congestionControl: "invalid" as "default",
				}),
			).toThrow(/congestionControl must be/);
		});

		test("invalid datagramsReadableType throws", () => {
			expect(() =>
				harness.construct({
					datagramsReadableType: "invalid" as "bytes",
				}),
			).toThrow(/datagramsReadableType must be/);
		});

		test("allowPooling and requireUnreliable options are accepted", () => {
			expect(() => {
				const wt = harness.construct({ allowPooling: true });
				wt.close();
			}).not.toThrow();
			expect(() => {
				const wt = harness.construct({ requireUnreliable: true });
				wt.close();
			}).not.toThrow();
		});

		test("allowPooling + serverCertificateHashes throws NotSupportedError", () => {
			expect(() =>
				harness.construct({
					allowPooling: true,
					serverCertificateHashes: [
						{ algorithm: "sha-256", value: new Uint8Array(32) },
					],
				}),
			).toThrow(/cannot be used with allowPooling=true/);
		});

		test("waitUntilAvailable option waits for stream capacity on createBidirectionalStream", async () => {
			// Both backends enforce maxStreamsPerSessionBidi, so this runs
			// behaviorally on either one through a limit-configured harness.
			const limitedServer = await createParityHarness({
				serverLimits: {
					maxStreamsPerSessionBidi: 1,
					maxStreamsGlobal: 50000,
					backpressureTimeoutMs: 1500,
				},
				onSession: async (s) => {
					await forEachWithTimeout(
						s.incomingDatagrams(),
						5000,
						"parity options waitUntilAvailable incoming datagram",
						async () => undefined,
					);
				},
			});
			const wt: ParityTransport = await limitedServer.open({
				limits: { backpressureTimeoutMs: 1500 },
			});
			try {
				const first = await wt.createBidirectionalStream();
				const secondPromise = wt.createBidirectionalStream({
					waitUntilAvailable: true,
				});
				await Bun.sleep(100);
				const writer = first.writable.getWriter();
				await writer.close().catch(() => undefined);
				writer.releaseLock();
				const reader = first.readable.getReader();
				await reader.cancel().catch(() => undefined);
				reader.releaseLock();
				const second = await Promise.race([
					secondPromise,
					Bun.sleep(2000).then(() => {
						throw new Error("timeout waiting for waitUntilAvailable stream");
					}),
				]);
				expect(second).toBeDefined();
			} finally {
				wt.close();
				await limitedServer.close();
			}
		}, 15000);
	},
);
