import { describe, expect, test } from "bun:test";
import {
	createServer,
	type QuicConnectionStats,
	type ServerSession,
} from "../src/index.js";
import { __TESTING__ } from "../src/internal.js";
import { readWithTimeout, withTimeout } from "./helpers/harness.js";
import { nextPort, openWTWithRetry } from "./helpers/network.js";

type InternalStatsSession = ServerSession & {
	_connectionStats?: () => QuicConnectionStats | null;
};

describe("internal QUIC transport counters", () => {
	test("returns null when an older native handle has no stats hook", () => {
		for (const makeSession of [
			__TESTING__.createNativeServerSessionForTests,
			__TESTING__.createNativeClientSessionForTests,
		]) {
			const absent = makeSession({
				close: () => {},
			}) as unknown as InternalStatsSession;
			expect(absent._connectionStats?.()).toBeNull();

			const unavailable = makeSession({
				close: () => {},
				connectionStats: () => null,
			}) as unknown as InternalStatsSession;
			expect(unavailable._connectionStats?.()).toBeNull();
		}
	});

	test("reports raw DATAGRAM-frame and UDP-datagram stages without extending public getStats", async () => {
		const port = nextPort(24800, 400);
		let resolveSession!: (session: ServerSession) => void;
		const sessionReady = new Promise<ServerSession>((resolve) => {
			resolveSession = resolve;
		});
		let echo: Promise<void> | null = null;
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (session) => {
				resolveSession(session);
				echo = (async () => {
					const iterator = session.incomingDatagrams()[Symbol.asyncIterator]();
					const incoming = await withTimeout(
						iterator.next(),
						5_000,
						"internal QUIC stats server receive",
					);
					if (incoming.done) throw new Error("session closed before datagram");
					await session.sendDatagram(incoming.value);
				})();
			},
		});
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});

		try {
			const session = (await withTimeout(
				sessionReady,
				5_000,
				"internal QUIC stats server session",
			)) as InternalStatsSession;
			const writer = wt.datagrams.writable.getWriter();
			await writer.write(new Uint8Array([1, 2, 3, 4]));
			writer.releaseLock();

			const reader = wt.datagrams.readable.getReader();
			const reply = await readWithTimeout(
				reader,
				5_000,
				"internal QUIC stats echoed datagram",
			);
			reader.releaseLock();
			expect(reply.done).toBe(false);
			await withTimeout(
				echo ?? Promise.reject(new Error("echo task was not started")),
				5_000,
				"internal QUIC stats echo completion",
			);

			expect(typeof session._connectionStats).toBe("function");
			const raw = session._connectionStats?.();
			expect(raw).not.toBeNull();
			expect(raw?.datagramFramesSent ?? -1).toBeGreaterThanOrEqual(1);
			expect(raw?.datagramFramesReceived ?? -1).toBeGreaterThanOrEqual(1);
			expect(raw?.udpDatagramsSent ?? -1).toBeGreaterThanOrEqual(1);
			expect(raw?.udpDatagramsReceived ?? -1).toBeGreaterThanOrEqual(1);

			const publicStats = await wt.getStats();
			expect(publicStats).not.toHaveProperty("datagramFramesSent");
			expect(publicStats).not.toHaveProperty("datagramFramesReceived");
			expect(publicStats).not.toHaveProperty("udpDatagramsSent");
			expect(publicStats).not.toHaveProperty("udpDatagramsReceived");
		} finally {
			wt.close();
			await server.close();
		}
	}, 15_000);
});
