/**
 * P0-A: session accept callback is invoked and session.closed settles
 */

import { describe, it, expect } from "bun:test";
import { connect, createServer } from "../src/index.js";
import { nextPort } from "./helpers/network.js";

async function connectWithRetry(
	url: string,
	opts: Parameters<typeof connect>[1],
	timeoutMs = 6000,
): Promise<Awaited<ReturnType<typeof connect>>> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown;
	while (Date.now() < deadline) {
		try {
			return await connect(url, opts);
		} catch (err) {
			lastErr = err;
			await Bun.sleep(100);
		}
	}
	throw lastErr ?? new Error("connectWithRetry: timed out");
}

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
		const port = nextPort(23440, 2000);
		const sessions: any[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const seen = await waitUntil(() => sessions.length >= 1, 8000);
			expect(seen).toBe(true);
			expect(sessions[0]).toBeDefined();
			expect(sessions[0].id).toBeDefined();
			expect(typeof sessions[0].id).toBe("string");
		} finally {
			client.close();
			await server.close();
		}
	}, 30000);

	it("closed promise settles when session ends", async () => {
		const port = nextPort(23440, 2000);
		const sessions: any[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
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
		} finally {
			client.close();
			await server.close();
		}
	}, 20000);

	it("client-initiated close propagates code and reason to server session.closed", async () => {
		const port = nextPort(23440, 2000);
		const sessions: any[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const accepted = await waitUntil(() => sessions.length >= 1, 8000);
			expect(accepted).toBe(true);
			const closedInfoPromise = sessions[0].closed;
			client.close({ code: 4999, reason: "Done streaming." });
			const closeInfo = await Promise.race([
				closedInfoPromise,
				Bun.sleep(5000).then(() => ({ code: -1, reason: "timeout" })),
			]);
			expect((closeInfo as any).code).toBe(4999);
			expect((closeInfo as any).reason).toBe("Done streaming.");
		} finally {
			client.close();
			await server.close();
		}
	}, 20000);

	it("client-initiated close code/reason propagate reliably across repeated sessions", async () => {
		const port = nextPort(23440, 2000);
		const sessions: any[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => {
				sessions.push(s);
			},
		});
		const runs = 20;
		try {
			for (let i = 0; i < runs; i++) {
				const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				});
				const accepted = await waitUntil(() => sessions.length > i, 8000);
				expect(accepted).toBe(true);
				const session = sessions[i];
				const closedInfoPromise = session.closed;
				client.close({ code: 4999, reason: "Done streaming." });
				const closeInfo = await Promise.race([
					closedInfoPromise,
					Bun.sleep(5000).then(() => ({ code: -1, reason: "timeout" })),
				]);
				expect((closeInfo as any).code).toBe(4999);
				expect((closeInfo as any).reason).toBe("Done streaming.");
			}
		} finally {
			await server.close();
		}
	}, 120000);
});
