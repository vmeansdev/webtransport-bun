/**
 * Parity tests: WebTransport streams facade (Phase P3).
 * Verifies createBidirectionalStream, createUnidirectionalStream,
 * incomingBidirectionalStreams, incomingUnidirectionalStreams.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { WebTransport, createServer } from "../src/index.js";
import { nextPort as allocatePort } from "./helpers/network.js";

const BASE_PORT = 15530;

async function openWTWithRetry(
	url: string,
	opts: ConstructorParameters<typeof WebTransport>[1],
	timeoutMs = 10000,
): Promise<WebTransport> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		const wt = new WebTransport(url, opts);
		try {
			await wt.ready;
			return wt;
		} catch (err) {
			lastErr = err;
			wt.close();
			await Bun.sleep(100);
		}
	}
	throw lastErr ?? new Error("openWTWithRetry: timed out");
}

describe("parity streams (P3)", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = allocatePort(BASE_PORT, 2000);
		server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for await (const duplex of s.incomingBidirectionalStreams) {
					void (async () => {
						const reader = duplex.readable.getReader();
						const chunks: Uint8Array[] = [];
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							chunks.push(value);
						}
						if (chunks.length > 0) {
							const writer = duplex.writable.getWriter();
							await writer.write(
								Buffer.concat(chunks.map((c) => Buffer.from(c))),
							);
							await writer.close();
						}
					})().catch(() => {});
				}
				for await (const readable of s.incomingUnidirectionalStreams) {
					void (async () => {
						const chunks: Uint8Array[] = [];
						for await (const c of readable) chunks.push(c);
						// Echo back on a new uni stream
						const w = await s.createUnidirectionalStream();
						w.write(Buffer.concat(chunks.map((c) => Buffer.from(c))));
						w.end();
					})().catch(() => {});
				}
			},
		});
	});

	afterAll(async () => {
		await server.close();
	});

	test("createBidirectionalStream returns Web Streams bidi", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const { readable, writable } = await wt.createBidirectionalStream();
		expect(readable).toBeInstanceOf(ReadableStream);
		expect(writable).toBeInstanceOf(WritableStream);
		const writer = writable.getWriter();
		await writer.write(new Uint8Array([1, 2, 3]));
		await writer.close();
		const reader = readable.getReader();
		const { value } = await reader.read();
		expect(value).toBeDefined();
		expect(new Uint8Array(value!)).toEqual(new Uint8Array([1, 2, 3]));
		reader.releaseLock();
		wt.close();
	});

	test("createUnidirectionalStream returns WritableStream", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const writable = await wt.createUnidirectionalStream();
		expect(writable).toBeInstanceOf(WritableStream);
		const writer = writable.getWriter();
		await writer.write(new Uint8Array([4, 5, 6]));
		await writer.close();
		wt.close();
	});

	test("incomingBidirectionalStreams is ReadableStream of bidi streams", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		expect(wt.incomingBidirectionalStreams).toBeInstanceOf(ReadableStream);
		expect(wt.incomingUnidirectionalStreams).toBeInstanceOf(ReadableStream);
		wt.close();
	});

	test("writable.abort(reason) maps to reset (browser-style stream control)", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const { readable, writable } = await wt.createBidirectionalStream();
		const writer = writable.getWriter();
		await writer.write(new Uint8Array([1]));
		await writer.abort(42);
		await expect(writer.closed).rejects.toBeDefined();
		wt.close();
	});

	test("readable.cancel(reason) maps to stopSending (browser-style stream control)", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const { readable } = await wt.createBidirectionalStream();
		const reader = readable.getReader();
		reader.cancel(99);
		await reader.closed.catch(() => {});
		wt.close();
	});
});
