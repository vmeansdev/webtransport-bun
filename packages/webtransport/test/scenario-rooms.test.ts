import { describe, expect, it } from "bun:test";
import { runRoomsClients } from "../../../examples/scenarios/rooms/client.js";
import { startRoomsServer } from "../../../examples/scenarios/rooms/server.js";
import { generateDevTls } from "../../../examples/scenarios/shared/dev-tls.js";
import { connect } from "../src/index.js";

// Keeps docs/scenarios/live-media-rooms.md's example runnable. It checks that
// the example works end to end at a small scale, not how fast it is: the
// runbook's numbers come from dedicated hardware, not from this test.
describe("scenario example: live media rooms", () => {
	it("joins rooms and forwards every publisher's frames to its room only", async () => {
		const tls = generateDevTls();
		const rooms = startRoomsServer({
			port: 0,
			host: "127.0.0.1",
			tls,
			rateLimits: {
				handshakesPerSec: 1000,
				handshakesBurst: 1000,
				datagramsPerSec: 100_000,
				datagramsBurst: 100_000,
			},
		});
		try {
			const report = await runRoomsClients({
				url: `https://127.0.0.1:${rooms.port}`,
				caPem: tls.caPem,
				rooms: 3,
				publishersPerRoom: 2,
				subscribersPerRoom: 4,
				// A light stream keeps the test about correctness on a busy CI box.
				kbps: 500,
				durationMs: 2000,
			});
			expect(report.connectFailures).toBe(0);
			expect(report.joinFailures).toBe(0);
			expect(report.publishers).toBe(6);
			expect(report.subscribers).toBe(12);
			expect(report.datagramsPerFrame).toBe(2);
			expect(report.datagramsSent).toBeGreaterThan(0);
			expect(report.sendErrors).toBe(0);
			// Delivery is counted against each room's own publishers, so a
			// forward that leaked into another room, or an echo back to the
			// sender, would push it past 1.
			expect(report.delivery).toBeGreaterThan(0.5);
			expect(report.delivery).toBeLessThanOrEqual(1);
			expect(rooms.joinFailures).toBe(0);
			expect(rooms.queueFull).toBe(0);
			// Subscribers plus the other publisher in each room.
			const perPacketTargets = 4 + 1;
			expect(rooms.forwarded).toBeGreaterThanOrEqual(report.receivedDatagrams);
			expect(rooms.forwarded).toBeLessThanOrEqual(
				report.datagramsSent * perPacketTargets,
			);
			const m = rooms.server.metricsSnapshot();
			expect(m.datagramMirrorCalls ?? 0).toBeGreaterThan(0);
		} finally {
			await rooms.close();
		}
	}, 30_000);

	it("refuses a session that never joins", async () => {
		const tls = generateDevTls();
		const rooms = startRoomsServer({ port: 0, host: "127.0.0.1", tls });
		try {
			const session = await connect(`https://127.0.0.1:${rooms.port}`, {
				tls: { caPem: tls.caPem },
			});
			const stream = await session.createBidirectionalStream();
			stream.end(Buffer.from("not json"));
			const chunks: Buffer[] = [];
			const read = (async () => {
				for await (const chunk of stream) chunks.push(chunk as Buffer);
			})();
			await Promise.race([read, Bun.sleep(5000)]);
			expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual({
				error: "bad join",
			});
			const closed = await Promise.race([session.closed, Bun.sleep(5000)]);
			expect(closed).toMatchObject({ code: 4000 });
			expect(rooms.joinFailures).toBe(1);
		} finally {
			await rooms.close();
		}
	}, 30_000);
});
