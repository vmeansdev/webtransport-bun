import { describe, expect, it } from "bun:test";
import { runChurnClients } from "../../../examples/scenarios/churn/client.js";
import { startChurnServer } from "../../../examples/scenarios/churn/server.js";
import { generateDevTls } from "../../../examples/scenarios/shared/dev-tls.js";

// Keeps docs/scenarios/connection-churn.md's example runnable. It checks that
// the example works end to end at a small scale, not how fast it is: the
// runbook's numbers come from dedicated hardware, not from this test.

const openRateLimits = {
	handshakesPerSec: 1000,
	handshakesBurst: 1000,
	handshakesBurstPerPrefix: 1000,
};

async function waitFor(check: () => boolean, deadlineMs: number) {
	const until = performance.now() + deadlineMs;
	while (!check() && performance.now() < until) await Bun.sleep(25);
	return check();
}

describe("scenario example: connection churn", () => {
	it("churns sessions past a stable base and leaves nothing behind", async () => {
		const tls = generateDevTls();
		const churn = startChurnServer({
			port: 0,
			host: "127.0.0.1",
			tls,
			rateLimits: openRateLimits,
		});
		const base = 10;
		let activeAfterChurn = -1;
		try {
			const report = await runChurnClients({
				url: `https://127.0.0.1:${churn.port}/`,
				caPem: tls.caPem,
				baseSessions: base,
				churnPerSec: 20,
				durationMs: 2500,
				afterChurn: async () => {
					// Every churner closed its session: only the base should remain.
					await waitFor(
						() => churn.server.metricsSnapshot().sessionsActive === base,
						5000,
					);
					activeAfterChurn = churn.server.metricsSnapshot().sessionsActive;
				},
			});
			expect(report.baseConnected).toBe(base);
			expect(report.baseLost).toBe(0);
			expect(report.churnLaunched).toBeGreaterThanOrEqual(40);
			expect(report.churnEstablished).toBe(report.churnLaunched);
			expect(report.churnGaveUp).toBe(0);
			expect(report.achievedPerSec).toBeGreaterThan(10);
			expect(report.basePingsSent).toBeGreaterThan(0);
			expect(report.baseDelivery).toBeGreaterThan(0.9);
			expect(Number.isFinite(report.baseRttP99Ms)).toBe(true);
			expect(activeAfterChurn).toBe(base);
			expect(churn.accepted).toBe(base + report.churnEstablished);

			// The base closed at the end of the run. The native registry empties
			// first; the server's JS `closed` callbacks land a moment later.
			const idle = await waitFor(() => {
				const m = churn.server.metricsSnapshot();
				return (
					m.sessionsActive === 0 &&
					m.nativeSessionRegistryEntries === 0 &&
					churn.open === 0
				);
			}, 5000);
			expect(idle).toBe(true);
		} finally {
			await churn.close();
		}
	}, 30_000);

	it("retries admission refusals instead of failing the session", async () => {
		const tls = generateDevTls();
		const churn = startChurnServer({
			port: 0,
			host: "127.0.0.1",
			tls,
			rateLimits: openRateLimits,
			// One handshake at a time: any overlap is refused with QUIC
			// CONNECTION_REFUSED and has to come back through the backoff.
			limits: { maxHandshakesInFlight: 1 },
		});
		try {
			const report = await runChurnClients({
				url: `https://127.0.0.1:${churn.port}/`,
				caPem: tls.caPem,
				baseSessions: 20,
				churnPerSec: 30,
				durationMs: 2000,
				retry: { attempts: 8, baseMs: 50, maxMs: 1000 },
			});
			const failures = Object.values(report.connectFailures).reduce(
				(a, b) => a + b,
				0,
			);
			expect(report.baseConnected).toBe(20);
			expect(report.churnGaveUp).toBe(0);
			expect(report.churnEstablished).toBe(report.churnLaunched);
			// Every failed dial was retried (none gave up), and each one the
			// client saw was a refusal the server counted.
			expect(report.connectRetries).toBe(failures);
			expect(churn.server.metricsSnapshot().limitExceededCount).toBe(failures);
		} finally {
			await churn.close();
		}
	}, 30_000);
});
