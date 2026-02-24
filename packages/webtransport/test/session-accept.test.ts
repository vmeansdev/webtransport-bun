/**
 * P0-A: session accept callback is invoked and session.closed settles
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";

async function waitUntil(
	condition: () => boolean,
	timeoutMs: number,
	intervalMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await Bun.sleep(intervalMs);
	}
	return condition();
}

describe("session accept (P0-A)", () => {
	it("onSession called when client connects", async () => {
		const sessions: any[] = [];
		const server = createServer({
			port: 14440,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const client = await connect("https://127.0.0.1:14440", {
			tls: { insecureSkipVerify: true },
		});
		const seen = await waitUntil(() => sessions.length >= 1, 8000);
		client.close();
		await server.close();

		expect(seen).toBe(true);
		expect(sessions[0]).toBeDefined();
		expect(sessions[0].id).toBeDefined();
		expect(typeof sessions[0].id).toBe("string");
	}, 30000);

	it("closed promise settles when session ends", async () => {
		const sessions: any[] = [];
		const server = createServer({
			port: 14441,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const client = await connect("https://127.0.0.1:14441", {
			tls: { insecureSkipVerify: true },
		});
		const accepted = await waitUntil(() => sessions.length >= 1, 8000);
		expect(accepted).toBe(true);

		const closedPromise = sessions[0].closed.then((info: any) => ({
			ok: true,
			info,
		}));
		client.close();
		const closedResult = await Promise.race([
			closedPromise,
			Bun.sleep(5000).then(() => ({ ok: false })),
		]);
		expect(closedResult.ok).toBe(true);
		expect((closedResult as any).info).toBeDefined();

		await server.close();
	}, 20000);
});
