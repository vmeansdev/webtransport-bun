/**
 * Parity tests: WebTransport facade lifecycle (Phase P1).
 * Verifies ready, closed, draining behavior.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
	WebTransport,
	createServer,
	connect,
	toWebTransport,
} from "../src/index.js";

describe("parity facade lifecycle (P1)", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = 15500;
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

	test("WebTransport constructor + ready resolves when connected", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		expect(wt.ready).toBeDefined();
	});

	test("WebTransport closed resolves with WebTransportCloseInfo when session closes", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		wt.close({ closeCode: 0, reason: "test done" });
		const info = await wt.closed;
		expect(info).toBeDefined();
		expect(typeof info).toBe("object");
	});

	test("WebTransport draining resolves when close() is called (before closed)", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		const drainStart = Date.now();
		wt.close();
		await wt.draining;
		const drainElapsed = Date.now() - drainStart;
		expect(drainElapsed).toBeLessThan(500); // draining should resolve promptly when close() is called
		await wt.closed;
	});

	test("createBidirectionalStream rejects with E_SESSION_CLOSED after close()", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		wt.close();
		await expect(wt.createBidirectionalStream()).rejects.toMatchObject({
			code: "E_SESSION_CLOSED",
		});
	});

	test("lifecycle ordering: ready resolves first, draining and closed resolve after close()", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
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
		const session = await connect(`https://127.0.0.1:${port}`, {
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
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		expect(wt.datagrams).toBeDefined();
		expect(wt.datagrams.readable).toBeInstanceOf(ReadableStream);
		expect(wt.datagrams.writable).toBeInstanceOf(WritableStream);
		wt.close();
	});

	test("WebTransport.incomingBidirectionalStreams and incomingUnidirectionalStreams exist", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		expect(wt.incomingBidirectionalStreams).toBeInstanceOf(ReadableStream);
		expect(wt.incomingUnidirectionalStreams).toBeInstanceOf(ReadableStream);
		wt.close();
	});

	test("incomingDatagrams iterator terminates when session closes", async () => {
		const session = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const done = (async () => {
			let count = 0;
			for await (const _ of session.incomingDatagrams()) {
				count++;
			}
			return count;
		})();
		session.close({ code: 1000, reason: "termination test" });
		const count = await Promise.race([
			done,
			new Promise<number>((_, rej) =>
				setTimeout(
					() => rej(new Error("incomingDatagrams did not terminate within 5s")),
					5000,
				),
			),
		]);
		expect(count).toBe(0);
	});

	test("incomingBidirectionalStreams iterator terminates when session closes", async () => {
		const session = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const done = (async () => {
			let count = 0;
			for await (const _ of session.incomingBidirectionalStreams()) {
				count++;
			}
			return count;
		})();
		session.close({ code: 1000, reason: "bidi termination test" });
		const count = await Promise.race([
			done,
			new Promise<number>((_, rej) =>
				setTimeout(
					() =>
						rej(
							new Error(
								"incomingBidirectionalStreams did not terminate within 5s",
							),
						),
					5000,
				),
			),
		]);
		expect(count).toBe(0);
	});

	test("incomingUnidirectionalStreams iterator terminates when session closes", async () => {
		const session = await connect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const done = (async () => {
			let count = 0;
			for await (const _ of session.incomingUnidirectionalStreams()) {
				count++;
			}
			return count;
		})();
		session.close({ code: 1000, reason: "uni termination test" });
		const count = await Promise.race([
			done,
			new Promise<number>((_, rej) =>
				setTimeout(
					() =>
						rej(
							new Error(
								"incomingUnidirectionalStreams did not terminate within 5s",
							),
						),
					5000,
				),
			),
		]);
		expect(count).toBe(0);
	});
});
