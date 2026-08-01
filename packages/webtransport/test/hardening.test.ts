/**
 * Hardening tests: byte-budget enforcement, error-code mapping, close-path settlement.
 */

import { describe, it, expect, afterEach } from "bun:test";
import {
	createHarness,
	forEachWithTimeout,
	readWithTimeout,
	waitFor,
	withTimeout,
} from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";
import {
	connect,
	createServer,
	WebTransportError,
	E_SESSION_CLOSED,
	E_QUEUE_FULL,
	E_BACKPRESSURE_TIMEOUT,
	E_HANDSHAKE_TIMEOUT,
	E_INTERNAL,
	E_LIMIT_EXCEEDED,
} from "../src/index.js";

const BASE_PORT = 18500;

const harness = createHarness();

afterEach(async () => {
	await harness.cleanup();
});

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function trackedCreateServer(...args: Parameters<typeof createServer>) {
	return harness.track(createServer(...args));
}

async function trackedConnect(...args: Parameters<typeof connect>) {
	return harness.track(await connectWithRetry(args[0], args[1]));
}

describe("error-code mapping", () => {
	it("client send_datagram after close returns E_SESSION_CLOSED", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"hardening closed send incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await client.close();
		await Bun.sleep(500);
		try {
			await client.sendDatagram(new Uint8Array([1, 2, 3]));
			expect(true).toBe(false);
		} catch (e: any) {
			expect(e).toBeInstanceOf(WebTransportError);
			expect(e.code).toBe(E_SESSION_CLOSED);
		}
		await server.close();
	}, 10000);

	it("client oversized datagram returns E_QUEUE_FULL", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"hardening oversized datagram incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await client.sendDatagram(new Uint8Array(1500));
			expect(true).toBe(false);
		} catch (e: any) {
			expect(e).toBeInstanceOf(WebTransportError);
			expect(e.code).toBe(E_QUEUE_FULL);
		}
		await server.close();
	}, 10000);

	it("connect to unreachable host returns WebTransportError", async () => {
		try {
			await trackedConnect("https://127.0.0.1:19999", {
				limits: { handshakeTimeoutMs: 2000 },
			});
			expect(true).toBe(false);
		} catch (e: any) {
			expect(e).toBeInstanceOf(WebTransportError);
		}
	}, 10000);

	it("all E_* codes are exported strings", () => {
		expect(typeof E_SESSION_CLOSED).toBe("string");
		expect(typeof E_QUEUE_FULL).toBe("string");
		expect(typeof E_BACKPRESSURE_TIMEOUT).toBe("string");
		expect(typeof E_HANDSHAKE_TIMEOUT).toBe("string");
		expect(typeof E_INTERNAL).toBe("string");
	});
});

describe("close-path promise settlement", () => {
	it("server close settles all session closed promises", async () => {
		const port = nextPort(BASE_PORT, 1000);
		let serverSession: any = null;
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				serverSession = s;
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"hardening server close settles incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

		const closedPromise = client.closed;
		await server.close();

		const info = await Promise.race([
			closedPromise,
			Bun.sleep(5000).then(() => "timeout"),
		]);

		expect(info).not.toBe("timeout");
	}, 15000);

	it("client close resolves closed promise", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"hardening client close settles incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

		const closedPromise = client.closed;
		await client.close();

		const info = await Promise.race([
			closedPromise,
			Bun.sleep(5000).then(() => "timeout"),
		]);

		expect(info).not.toBe("timeout");
		await server.close();
	}, 15000);

	it("server close waits for an in-flight onSession promise to drain", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const sessionAccepted = deferred<void>();
		const releaseHandler = deferred<void>();
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async () => {
				sessionAccepted.resolve();
				await releaseHandler.promise;
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await withTimeout(
			sessionAccepted.promise,
			5_000,
			"hardening wait for session acceptance",
		);

		const closePromise = server.close();
		const closeState = await Promise.race([
			closePromise.then(() => "resolved"),
			Bun.sleep(100).then(() => "pending"),
		]);
		expect(closeState).toBe("pending");

		releaseHandler.resolve();
		await expect(
			withTimeout(
				closePromise,
				5_000,
				"hardening wait for server close handler drain",
			),
		).resolves.toBeUndefined();
		await expect(
			withTimeout(client.closed, 5_000, "hardening wait for client.closed"),
		).resolves.toBeTruthy();
	}, 15000);
});

describe("client metricsSnapshot", () => {
	it("reflects datagram activity", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"hardening metrics incoming datagram",
					async (dgram) => {
						await s.sendDatagram(dgram);
					},
				);
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

		await client.sendDatagram(new Uint8Array([1, 2, 3]));
		await waitFor(
			() => {
				const snap = client.metricsSnapshot();
				return snap.datagramsOut >= 1 && snap.datagramsIn >= 1;
			},
			Boolean,
			1500,
			25,
			"client datagram activity metrics",
		);

		const snap = client.metricsSnapshot();
		expect(snap.datagramsOut).toBeGreaterThanOrEqual(1);
		expect(snap.datagramsIn).toBeGreaterThanOrEqual(1);

		client.close();
		await server.close();
	}, 10000);

	it("tracks streamsActive and queuedBytes", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingBidirectionalStreams,
					5000,
					"hardening streamsActive incoming bidi",
					async (bidi) => {
						const reader = bidi.readable.getReader();
						const first = await readWithTimeout(
							reader,
							5000,
							"hardening server first bidi chunk",
						);
						reader.releaseLock();
						if (!first.done) {
							const writer = bidi.writable.getWriter();
							await writer.write(first.value);
							await writer.close();
						}
					},
				);
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

		const stream = await client.createBidirectionalStream();
		await waitFor(
			() => {
				const snap = client.metricsSnapshot();
				return snap.streamsActive >= 1;
			},
			Boolean,
			1500,
			25,
			"client active stream metric",
		);

		const replyPromise = new Promise<Buffer>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("timed out waiting for bidi echo")),
				4000,
			);
			stream.once("data", (chunk) => {
				clearTimeout(timer);
				resolve(chunk);
			});
			stream.once("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});

		await new Promise<void>((resolve, reject) => {
			stream.write(new Uint8Array([10, 20, 30]), (err?: Error | null) => {
				if (err) reject(err);
				else resolve();
			});
		});

		const reply = await replyPromise;
		expect(reply).not.toBeNull();
		expect(reply.length).toBe(3);
		stream.end();

		await Bun.sleep(500);
		const snapAfter = client.metricsSnapshot();
		expect(typeof snapAfter.queuedBytes).toBe("number");

		await server.close();
	}, 10000);
});

describe("metrics consistency after stress burst", () => {
	it("queuedBytesGlobal, sessionTasksActive, streamTasksActive drain after close", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const NUM_CLIENTS = 3;
		const DATAGRAMS_PER_CLIENT = 5;
		let sessionsReceived = 0;
		const sessionClosed: Promise<unknown>[] = [];
		const sessionTasks: Promise<unknown>[] = [];
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessionsReceived++;
				sessionClosed.push(s.closed.catch((error) => error));
				const sessionTask = (async () => {
					await forEachWithTimeout(
						s.incomingDatagrams(),
						1500,
						"hardening stress burst incoming datagram",
						async (dgram) => {
							await s.sendDatagram(dgram);
						},
					);
				})().catch((error) => error);
				sessionTasks.push(sessionTask);
			},
		});

		const clients = [];
		for (let i = 0; i < NUM_CLIENTS; i++) {
			clients.push(
				await trackedConnect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);
		}
		await Bun.sleep(500);

		for (const client of clients) {
			for (let i = 0; i < DATAGRAMS_PER_CLIENT; i++) {
				await client.sendDatagram(new Uint8Array([i, i + 1]));
			}
		}
		await Bun.sleep(1000);

		const mDuring = server.metricsSnapshot();
		expect(mDuring.datagramsIn).toBeGreaterThan(0);

		await waitFor(
			() => sessionsReceived === NUM_CLIENTS,
			Boolean,
			5000,
			25,
			"stress burst session accepts",
		);

		const clientClosed = clients.map((client) =>
			client.closed.catch((error) => error),
		);
		for (const client of clients) {
			client.close();
		}

		await Promise.allSettled(clientClosed);
		await Promise.allSettled(sessionClosed);
		await withTimeout(
			Promise.allSettled(sessionTasks),
			7000,
			"stress burst session tasks settle",
		);
		await waitFor(
			() => server.metricsSnapshot().sessionsActive === 0,
			Boolean,
			7000,
			25,
			"server sessions drain after stress burst",
		);
		await waitFor(
			() => {
				const m = server.metricsSnapshot();
				return (
					m.sessionsActive === 0 &&
					m.queuedBytesGlobal <= 1024 &&
					// The listening server retains its top-level accept loop until
					// server.close() tears it down.
					m.sessionTasksActive <= 1 &&
					m.streamTasksActive === 0
				);
			},
			Boolean,
			7000,
			25,
			"server metrics drain after stress burst",
		);

		await server.close();
		const postClose = server.metricsSnapshot();
		expect(postClose.sessionsActive).toBe(0);
		expect(postClose.sessionTasksActive).toBe(0);
		expect(postClose.streamTasksActive).toBe(0);
	}, 20000);
});

describe("E_BACKPRESSURE_TIMEOUT error coding", () => {
	it("E_BACKPRESSURE_TIMEOUT is a stable exported error code", () => {
		expect(E_BACKPRESSURE_TIMEOUT).toBe("E_BACKPRESSURE_TIMEOUT");
		const err = new WebTransportError(E_BACKPRESSURE_TIMEOUT as any, "test");
		expect(err).toBeInstanceOf(WebTransportError);
		expect(err.code).toBe(E_BACKPRESSURE_TIMEOUT);
		expect(err.message).toContain("test");
	});

	it("backpressureTimeoutMs deterministically yields E_BACKPRESSURE_TIMEOUT when stream capacity never frees", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const timeoutMs = 200;
		let serverSession: any = null;
		let resolveServerReady!: () => void;
		const serverReady = new Promise<void>((resolve) => {
			resolveServerReady = resolve;
		});
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			// One bidi stream per session, and a short capacity-wait budget: once the
			// single slot is taken, any waitUntilAvailable open must time out.
			limits: {
				maxStreamsPerSessionBidi: 1,
				maxStreamsGlobal: 50000,
				backpressureTimeoutMs: timeoutMs,
			},
			onSession: async (s) => {
				serverSession = s;
				resolveServerReady();
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"hardening bidi cap incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await serverReady;
		expect(serverSession).not.toBeNull();

		// Occupy the only bidi slot and hold it open for the whole test.
		const held = await serverSession.createBidirectionalStream();
		expect(held).toBeDefined();

		// A second open that waits for capacity can never succeed while the slot
		// stays held, so it must reject with E_BACKPRESSURE_TIMEOUT after the
		// configured budget elapses — no dependence on host speed.
		const start = Date.now();
		let caught: unknown;
		try {
			await serverSession.createBidirectionalStream({
				waitUntilAvailable: true,
			});
			expect(true).toBe(false);
		} catch (e) {
			caught = e;
		}
		const elapsed = Date.now() - start;

		expect(caught).toBeInstanceOf(WebTransportError);
		expect((caught as WebTransportError).code).toBe(E_BACKPRESSURE_TIMEOUT);
		// The wait honored the configured budget rather than returning immediately.
		expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);

		held.destroy();
		await client.close();
		await server.close();
	}, 15000);
});

describe("server-created stream cap enforcement", () => {
	it("createBidirectionalStream fails after maxStreamsPerSessionBidi", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const cap = 2;
		let serverSession: any = null;
		let resolveServerReady!: () => void;
		const serverReady = new Promise<void>((resolve) => {
			resolveServerReady = resolve;
		});
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxStreamsPerSessionBidi: cap, maxStreamsGlobal: 50000 },
			onSession: async (s) => {
				serverSession = s;
				resolveServerReady();
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"hardening uni cap incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await serverReady;
		expect(serverSession).not.toBeNull();

		const opened: any[] = [];
		for (let i = 0; i < cap; i++) {
			opened.push(await serverSession.createBidirectionalStream());
		}
		expect(opened.length).toBe(cap);

		try {
			await serverSession.createBidirectionalStream();
			expect(true).toBe(false);
		} catch (e: any) {
			expect(e).toBeInstanceOf(WebTransportError);
			expect(e.code).toBe(E_LIMIT_EXCEEDED);
		}

		await client.close();
		await server.close();
	}, 15000);

	it("createUnidirectionalStream fails after maxStreamsPerSessionUni", async () => {
		const port = nextPort(BASE_PORT, 1000);
		const cap = 2;
		let serverSession: any = null;
		let resolveServerReady!: () => void;
		const serverReady = new Promise<void>((resolve) => {
			resolveServerReady = resolve;
		});
		const server = trackedCreateServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxStreamsPerSessionUni: cap, maxStreamsGlobal: 50000 },
			onSession: async (s) => {
				serverSession = s;
				resolveServerReady();
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"hardening limit exceeded incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await trackedConnect(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await serverReady;
		expect(serverSession).not.toBeNull();

		const opened: any[] = [];
		for (let i = 0; i < cap; i++) {
			opened.push(await serverSession.createUnidirectionalStream());
		}
		expect(opened.length).toBe(cap);

		try {
			await serverSession.createUnidirectionalStream();
			expect(true).toBe(false);
		} catch (e: any) {
			expect(e).toBeInstanceOf(WebTransportError);
			expect(e.code).toBe(E_LIMIT_EXCEEDED);
		}

		await client.close();
		await server.close();
	}, 15000);
});
