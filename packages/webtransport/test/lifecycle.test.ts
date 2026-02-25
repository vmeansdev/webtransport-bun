/**
 * Lifecycle smoke tests:
 * - session closed promises settle on server close
 * - server close does not hang
 * - metrics snapshot shape remains stable
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

describe("lifecycle", () => {
	it("server close => session closed promises settle", async () => {
		const port = nextPort(21430, 2000);
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

			const closedPromises = sessions.map((s) => s.closed);
			await server.close();

			const results = await Promise.race([
				Promise.all(
					closedPromises.map((p: Promise<any>) =>
						p.then((v: any) => ({ ok: true, v })),
					),
				),
				Bun.sleep(5000).then(() => null),
			]);
			expect(results).not.toBeNull();
			expect((results as any[]).every((r) => r?.ok)).toBe(true);
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("server close resolves without hanging", async () => {
		const port = nextPort(21430, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		const closePromise = server.close();
		await expect(closePromise).resolves.toBeUndefined();
	});

	it("metricsSnapshot after close returns consistent shape", () => {
		const port = nextPort(21430, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		const m = server.metricsSnapshot();
		expect(typeof m.sessionsActive).toBe("number");
		expect(typeof m.streamsActive).toBe("number");
		expect(typeof m.queuedBytesGlobal).toBe("number");
		expect(typeof m.limitExceededCount).toBe("number");
		server.close();
	});
});
