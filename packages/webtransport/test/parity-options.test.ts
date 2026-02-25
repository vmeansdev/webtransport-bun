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
		expect(wt.congestionControl).toBe("default");
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
		await writer.write(new Uint8Array([1, 2, 3]));
		writer.releaseLock();
		const buf = new Uint8Array(128);
		const { value, done } = await reader.read(buf);
		reader.releaseLock();
		expect(done).toBe(false);
		expect(value).toBeDefined();
		expect(
			new Uint8Array(value!.buffer, value!.byteOffset, value!.byteLength),
		).toEqual(new Uint8Array([1, 2, 3]));
		wt.close();
	});

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
});
