/**
 * P0-D: Adversarial / abuse-resistance tests.
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";

const BASE_PORT = 18000;

function nextPort(): number {
	return BASE_PORT + Math.floor(Math.random() * 800);
}

describe("abuse resistance (P0-D)", () => {
	it("handshake burst limit is enforced", async () => {
		const burst = 5;
		const port = nextPort();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			rateLimits: { handshakesBurst: burst },
			onSession: () => {},
		});
		await Bun.sleep(2000);

		const attempts = 15;
		const connects = Array.from({ length: attempts }, () =>
			connect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
			}).catch(() => null),
		);
		const results = await Promise.all(connects);
		const succeeded = results.filter((r) => r != null);
		const failed = results.filter((r) => r == null);

		expect(succeeded.length).toBeLessThanOrEqual(burst);
		expect(failed.length).toBeGreaterThan(0);

		const m = server.metricsSnapshot();
		expect(m.rateLimitedCount).toBeGreaterThan(0);

		await server.close();
	}, 20000);
});
