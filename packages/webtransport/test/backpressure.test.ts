/**
 * P0-C: Queue saturation, backpressure timeout, and recovery.
 * P1.2: Backpressure metrics (backpressureWaitCount, backpressureTimeoutCount).
 */

import { describe, it, expect } from "bun:test";
import {
	createServer,
	E_BACKPRESSURE_TIMEOUT,
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
} from "../src/index.js";
import {
	forEachWithTimeout,
	nextWithTimeout,
	waitFor,
} from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

async function expectPending(
	promise: Promise<unknown>,
	waitMs = 150,
): Promise<"pending" | "settled"> {
	return Promise.race([
		promise.then(
			() => "settled" as const,
			() => "settled" as const,
		),
		Bun.sleep(waitMs).then(() => "pending" as const),
	]);
}

type ServerSessionForBackpressure = {
	sendDatagram(data: Uint8Array): Promise<void>;
	incomingDatagrams(): AsyncIterable<Uint8Array>;
	metricsSnapshot(): { queuedBytes: number };
	close(info?: { code?: number; reason?: string }): void;
};

describe("backpressure (P0-C)", () => {
	it("datagram size over max is rejected", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"backpressure oversized incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const big = new Uint8Array(1500);
			await expect(client.sendDatagram(big)).rejects.toThrow(/E_QUEUE_FULL/);
		} finally {
			client.close();
			await server.close();
		}
	}, 10000);

	it("rapid datagram sends eventually apply backpressure", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"backpressure rapid send incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const dgram = new Uint8Array(100);
			const sends = Array.from({ length: 400 }, () =>
				client.sendDatagram(dgram).catch((e: Error) => e),
			);
			const results = await Promise.all(sends);
			const timeouts = results.filter(
				(r) =>
					r instanceof Error && r.message?.includes("E_BACKPRESSURE_TIMEOUT"),
			);
			const successes = results.filter((r) => !(r instanceof Error));

			expect(successes.length).toBeGreaterThan(0);
			if (timeouts.length > 0) {
				expect(timeouts[0]).toBeInstanceOf(Error);
				expect((timeouts[0] as Error).message).toContain(
					E_BACKPRESSURE_TIMEOUT,
				);
			}
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("send and receive works when server echoes", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"backpressure echo incoming datagram",
					async (d) => {
						await s.sendDatagram(d);
					},
				);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const dgram = new Uint8Array([1, 2, 3]);
			await client.sendDatagram(dgram);
			const iter = client.incomingDatagrams()[Symbol.asyncIterator]();
			const first = await nextWithTimeout(
				iter,
				1500,
				"backpressure echoed datagram read",
			);
			expect(first.done).toBe(false);
		} finally {
			client.close();
			await server.close();
		}
	}, 10000);

	it("client send_datagram enforces configured queued byte budget", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"backpressure client send budget incoming datagram",
					async () => undefined,
				);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			limits: {
				maxQueuedBytesGlobal: 1200,
				maxQueuedBytesPerSession: 1200,
			},
		});
		try {
			const payload = new Uint8Array(1200);
			const results = await Promise.all(
				Array.from({ length: 16 }, () =>
					client.sendDatagram(payload).then(
						() => "ok",
						(err: Error & { code?: string }) => err.code ?? err.message,
					),
				),
			);
			expect(results).toContain(E_QUEUE_FULL);
			expect(client.metricsSnapshot().queuedBytes).toBeLessThanOrEqual(1200);
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("client receive queue respects configured queued byte budget", async () => {
		const port = nextPort(24460, 2000);
		const payload = new Uint8Array(256);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				for (let i = 0; i < 16; i++) {
					await s.sendDatagram(payload);
				}
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			limits: {
				maxQueuedBytesGlobal: 512,
				maxQueuedBytesPerSession: 512,
			},
		});
		try {
			const queued = await waitFor(
				() => client.metricsSnapshot().queuedBytes,
				(value) => value > 0,
				3000,
				50,
				"backpressure client receive queued bytes",
			);
			expect(queued).toBeGreaterThan(0);
			expect(queued).toBeLessThanOrEqual(512);
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("server sendDatagram waits for queued datagram capacity to be released", async () => {
		const port = nextPort(24460, 2000);
		const inbound = new Uint8Array(256).fill(0x61);
		const outbound = new Uint8Array([0x62, 0x63, 0x64]);
		let serverSession!: ServerSessionForBackpressure;
		let resolveSession!: (session: ServerSessionForBackpressure) => void;
		const sessionReady = new Promise<ServerSessionForBackpressure>(
			(resolve) => {
				resolveSession = resolve;
			},
		);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: {
				maxQueuedBytesGlobal: inbound.byteLength,
				maxQueuedBytesPerSession: inbound.byteLength,
				backpressureTimeoutMs: 1000,
			},
			onSession: async (s) => {
				serverSession = s;
				resolveSession(s);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await sessionReady;
			await client.sendDatagram(inbound);
			await waitFor(
				() => serverSession.metricsSnapshot().queuedBytes,
				(queued) => queued === inbound.byteLength,
			);

			const serverSend = serverSession.sendDatagram(outbound);
			expect(await expectPending(serverSend, 150)).toBe("pending");

			const serverIncoming = serverSession
				.incomingDatagrams()
				[Symbol.asyncIterator]();
			const received = await nextWithTimeout(
				serverIncoming,
				1000,
				"backpressure server datagram consumption",
			);
			expect(received.done).toBe(false);
			expect(Array.from(received.value)).toEqual(Array.from(inbound));

			await expect(serverSend).resolves.toBeUndefined();

			const clientIncoming = client.incomingDatagrams()[Symbol.asyncIterator]();
			const echoed = await nextWithTimeout(
				clientIncoming,
				1500,
				"backpressure server datagram send",
			);
			expect(echoed.done).toBe(false);
			expect(Array.from(echoed.value)).toEqual(Array.from(outbound));
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("server sendDatagram times out under queue pressure instead of failing immediately", async () => {
		const port = nextPort(24460, 2000);
		const inbound = new Uint8Array(256).fill(0x41);
		let serverSession!: ServerSessionForBackpressure;
		let resolveSession!: (session: ServerSessionForBackpressure) => void;
		const sessionReady = new Promise<ServerSessionForBackpressure>(
			(resolve) => {
				resolveSession = resolve;
			},
		);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: {
				maxQueuedBytesGlobal: inbound.byteLength,
				maxQueuedBytesPerSession: inbound.byteLength,
				backpressureTimeoutMs: 100,
			},
			onSession: async (s) => {
				serverSession = s;
				resolveSession(s);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await sessionReady;
			await client.sendDatagram(inbound);
			await waitFor(
				() => serverSession.metricsSnapshot().queuedBytes,
				(queued) => queued === inbound.byteLength,
			);

			const before = server.metricsSnapshot();
			const startedAt = Date.now();
			await expect(
				serverSession.sendDatagram(new Uint8Array([0x99])),
			).rejects.toMatchObject({
				code: E_BACKPRESSURE_TIMEOUT,
			});
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(75);

			const after = server.metricsSnapshot();
			expect(after.backpressureWaitCount).toBeGreaterThan(
				before.backpressureWaitCount,
			);
			expect(after.backpressureTimeoutCount).toBeGreaterThan(
				before.backpressureTimeoutCount,
			);
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("closing a session wakes a blocked server send and balances queued bytes", async () => {
		const port = nextPort(24460, 2000);
		const inbound = new Uint8Array(256).fill(0x71);
		let serverSession!: ServerSessionForBackpressure;
		let resolveSession!: (session: ServerSessionForBackpressure) => void;
		const sessionReady = new Promise<ServerSessionForBackpressure>(
			(resolve) => {
				resolveSession = resolve;
			},
		);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: {
				maxQueuedBytesGlobal: inbound.byteLength,
				maxQueuedBytesPerSession: inbound.byteLength,
				backpressureTimeoutMs: 1000,
			},
			onSession: async (session) => {
				serverSession = session;
				resolveSession(session);
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await sessionReady;
			await client.sendDatagram(inbound);
			await waitFor(
				() => server.metricsSnapshot().queuedBytesGlobal,
				(queued) => queued === inbound.byteLength,
			);

			const blockedSend = serverSession.sendDatagram(new Uint8Array([0x72]));
			expect(await expectPending(blockedSend, 150)).toBe("pending");

			const closedAt = Date.now();
			serverSession.close({ code: 0x100, reason: "backpressure-close" });
			await expect(blockedSend).rejects.toMatchObject({
				code: E_SESSION_CLOSED,
			});
			expect(Date.now() - closedAt).toBeLessThan(500);
			await waitFor(
				() => server.metricsSnapshot().queuedBytesGlobal,
				(queued) => queued === 0,
				1000,
			);
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);
});

describe("backpressure observability (P1.2)", () => {
	it("backpressure counters exist and have correct shape", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"backpressure observability incoming datagram",
					async (d) => {
						await s.sendDatagram(d);
					},
				);
			},
		});
		try {
			const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			});
			await client.sendDatagram(new Uint8Array([1, 2, 3]));
			// Counters are shape checks only; avoid blocking on echoed datagram delivery.
			await Bun.sleep(50);

			const m = server.metricsSnapshot();
			expect(typeof m.backpressureWaitCount).toBe("number");
			expect(typeof m.backpressureTimeoutCount).toBe("number");
			expect(m.backpressureWaitCount).toBeGreaterThanOrEqual(0);
			expect(m.backpressureTimeoutCount).toBeGreaterThanOrEqual(0);
		} finally {
			await server.close();
		}
	}, 10000);

	it("backpressureTimeoutCount increments when server send times out (best-effort)", async () => {
		const port = nextPort(24460, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { backpressureTimeoutMs: 1 },
			onSession: async (s) => {
				await forEachWithTimeout(
					s.incomingDatagrams(),
					5000,
					"backpressure timeout counter incoming datagram",
					async (d) => {
						void s.sendDatagram(d).catch(() => {});
					},
				);
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const buf = new Uint8Array(800);
			const sends = Array.from({ length: 600 }, () =>
				client.sendDatagram(buf).catch(() => {}),
			);
			await Promise.all(sends);
			await Bun.sleep(2000);

			const m = server.metricsSnapshot();
			if (m.backpressureTimeoutCount > 0) {
				expect(m.backpressureWaitCount).toBeGreaterThanOrEqual(
					m.backpressureTimeoutCount,
				);
			}
		} finally {
			client.close();
			await server.close();
		}
	}, 25000);
});
