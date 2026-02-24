/**
 * Parity baseline tests (Phase 0).
 * Freezes current WebTransport facade surface and key behaviors.
 * These tests must pass before any parity work; they catch regressions.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { WebTransport, createServer } from "../src/index.js";

describe("parity baseline (Phase 0)", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = 15510;
		server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		await Bun.sleep(2000);
	});

	afterAll(async () => {
		await server.close();
	});

	test("WebTransport facade has required members", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;

		// Lifecycle
		expect("ready" in wt).toBe(true);
		expect("closed" in wt).toBe(true);
		expect("draining" in wt).toBe(true);

		// Datagrams (WebTransportDatagramDuplexStream)
		expect("datagrams" in wt).toBe(true);
		expect(wt.datagrams).toBeDefined();
		expect("readable" in wt.datagrams).toBe(true);
		expect("writable" in wt.datagrams).toBe(true);
		expect(typeof wt.datagrams.createWritable).toBe("function");
		expect(typeof wt.datagrams.maxDatagramSize).toBe("number");

		// Streams
		expect("incomingBidirectionalStreams" in wt).toBe(true);
		expect("incomingUnidirectionalStreams" in wt).toBe(true);
		expect(typeof wt.createBidirectionalStream).toBe("function");
		expect(typeof wt.createUnidirectionalStream).toBe("function");
		expect(typeof wt.close).toBe("function");

		wt.close();
	});

	test("WebTransport.getStats returns connection stats shape", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;

		expect(typeof wt.getStats).toBe("function");
		const stats = await wt.getStats();
		expect(stats).toBeDefined();
		expect(stats.datagrams).toBeDefined();
		expect(typeof stats.datagrams.droppedIncoming).toBe("number");
		expect(typeof stats.datagrams.expiredIncoming).toBe("number");
		expect(typeof stats.datagrams.expiredOutgoing).toBe("number");
		expect(typeof stats.datagrams.lostOutgoing).toBe("number");

		wt.close();
	});

	test("unsupported constructor options throw", () => {
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, { allowPooling: true }),
		).toThrow(/unsupported option 'allowPooling'/);
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					requireUnreliable: true,
				}),
		).toThrow(/unsupported option 'requireUnreliable'/);
	});

	test("datagrams.readable and datagrams.writable are Web Streams", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;

		expect(wt.datagrams.readable).toBeInstanceOf(ReadableStream);
		expect(wt.datagrams.writable).toBeInstanceOf(WritableStream);

		wt.close();
	});
});
