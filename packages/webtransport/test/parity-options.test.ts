/**
 * Parity tests: Option surface and capability flags (Phase 5).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { WebTransport, createServer } from "../src/index.js";
import { nextPort, openWTWithRetry } from "./helpers/network.js";

describe("parity options (Phase 5)", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = nextPort(15550, 1000);
		server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const d of s.incomingDatagrams()) {
					await s.sendDatagram(d);
				}
			},
		});
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		wt.close();
	});

	afterAll(async () => {
		await server.close();
	});

	test("WebTransport.supportsReliableOnly is false", () => {
		expect(WebTransport.supportsReliableOnly).toBe(false);
	});

	test("congestionControl option accepted with effective mode exposed", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			congestionControl: "low-latency",
		});
		expect(wt.congestionControl).toBe("low-latency");
		wt.close();
	});

	test("congestionControl supports throughput mapping as a distinct effective mode", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			congestionControl: "throughput",
		});
		expect(wt.congestionControl).toBe("throughput");
		wt.close();
	});

	test("datagramsReadableType 'default' uses normal ReadableStream", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		expect(wt.datagrams.readable).toBeInstanceOf(ReadableStream);
		wt.close();
	});

	test("datagramsReadableType 'bytes' creates ReadableByteStream and receives datagrams", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
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
		const { value, done } = await Promise.race([
			reader.read(buf),
			Bun.sleep(4000).then(() => {
				throw new Error("timeout: datagram BYOB read");
			}),
		]);
		reader.releaseLock();
		expect(done).toBe(false);
		expect(value).toBeDefined();
		expect(
			new Uint8Array(value!.buffer, value!.byteOffset, value!.byteLength),
		).toEqual(new Uint8Array([1, 2, 3]));
		wt.close();
	}, 15000);

	test("datagramsReadableType 'bytes' BYOB buffer too small throws RangeError", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			datagramsReadableType: "bytes",
		});
		const writer = wt.datagrams.writable.getWriter();
		await writer.write(new Uint8Array([1, 2, 3, 4, 5]));
		writer.releaseLock();
		const reader = wt.datagrams.readable.getReader({ mode: "byob" });
		const tinyBuf = new Uint8Array(2);
		await expect(reader.read(tinyBuf)).rejects.toThrow(RangeError);
		reader.releaseLock();
		wt.close();
	});

	test("invalid congestionControl throws", () => {
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					congestionControl: "invalid" as "default",
				}),
		).toThrow(/congestionControl must be/);
	});

	test("invalid datagramsReadableType throws", () => {
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					datagramsReadableType: "invalid" as "bytes",
				}),
		).toThrow(/datagramsReadableType must be/);
	});

	test("waitUntilAvailable option waits for stream capacity on createBidirectionalStream", async () => {
		const limitedPort = nextPort(16550, 1000);
		const limitedServer = createServer({
			port: limitedPort,
			tls: { certPem: "", keyPem: "" },
			limits: {
				maxStreamsPerSessionBidi: 1,
				maxStreamsGlobal: 50000,
				backpressureTimeoutMs: 1500,
			},
			onSession: async (s) => {
				for await (const _ of s.incomingDatagrams()) {
				}
			},
		});
		const wt = await openWTWithRetry(`https://127.0.0.1:${limitedPort}`, {
			tls: { insecureSkipVerify: true },
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
});
