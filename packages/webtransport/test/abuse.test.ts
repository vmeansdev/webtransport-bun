/**
 * P0-D: Adversarial / abuse-resistance tests.
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";
import { withHarness } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 18000;

describe("abuse resistance (P0-D)", () => {
	it("handshake burst limit is enforced", async () => {
		await withHarness(async (h) => {
			const burst = 5;
			const port = nextPort(BASE_PORT, 800);
			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					rateLimits: { handshakesBurst: burst },
					onSession: () => {},
				}),
			);
			const warmup = h.track(
				await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);
			warmup.close();
			// Refill handshake tokens after warmup probe; this is semantic bucket timing, not readiness.
			await Bun.sleep(300);

			const attempts = 15;
			const connects = Array.from({ length: attempts }, () =>
				connect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				})
					.then((c) => h.track(c))
					.catch(() => null),
			);
			const results = await Promise.all(connects);
			const succeeded = results.filter((r) => r != null);
			const failed = results.filter((r) => r == null);

			expect(succeeded.length).toBeLessThanOrEqual(burst);
			expect(failed.length).toBeGreaterThan(0);

			const m = server.metricsSnapshot();
			expect(m.rateLimitedCount).toBeGreaterThan(0);
		});
	}, 20000);
});
