import { describe, expect, it } from "bun:test";
import { runGameClients } from "../../../examples/scenarios/game/client.js";
import { startGameServer } from "../../../examples/scenarios/game/server.js";
import { generateDevTls } from "../../../examples/scenarios/shared/dev-tls.js";

// Keeps docs/scenarios/realtime-games.md's example runnable. It checks that
// the example works end to end at a small scale, not how fast it is: the
// runbook's numbers come from dedicated hardware, not from this test.
describe("scenario example: realtime game", () => {
	it("joins a fleet, acks every action and delivers snapshots", async () => {
		const tls = generateDevTls();
		const game = startGameServer({
			port: 0,
			host: "127.0.0.1",
			tls,
			rateLimits: { handshakesPerSec: 1000, handshakesBurst: 1000 },
		});
		try {
			const report = await runGameClients({
				url: `https://127.0.0.1:${game.port}/realm`,
				caPem: tls.caPem,
				players: 20,
				durationMs: 2500,
			});
			expect(report.connectFailures).toBe(0);
			expect(report.players).toBe(20);
			expect(report.actionsSent).toBeGreaterThan(0);
			// Loopback, a handful of players: an action without an ack means the
			// ack path is broken, not that a datagram was unlucky.
			expect(report.acksReceived).toBeGreaterThanOrEqual(
				report.actionsSent * 0.9,
			);
			expect(report.snapshotDelivery).toBeGreaterThan(0.5);
			expect(game.snapshotErrors).toBe(0);
		} finally {
			await game.close();
		}
	}, 30_000);
});
