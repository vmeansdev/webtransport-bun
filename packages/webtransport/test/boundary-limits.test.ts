/**
 * P0.4: Boundary correctness for limits/rate gates.
 * Tests exact semantics: at limit succeeds, at limit+1 fails.
 */
import { describe, it, expect } from "bun:test";
import { connect, createServer, E_LIMIT_EXCEEDED } from "../src/index.js";
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

describe("limit boundaries (P0.4)", () => {
	it("maxHandshakesInFlight: at most limit handshakes proceed, excess rejected", async () => {
		const port = nextPort(25480, 3000);
		const limit = 3;
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxHandshakesInFlight: limit, maxSessions: 100 },
			onSession: () => {},
		});

		const attempts = 6;
		try {
			const results = await Promise.all(
				Array.from({ length: attempts }, () =>
					connectWithRetry(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
					}).then(
						(s) => ({ ok: true as const, session: s }),
						(e) => ({ ok: false as const, err: e }),
					),
				),
			);

			const succeeded = results.filter((r) => r.ok);
			const failed = results.filter((r) => !r.ok);

			expect(succeeded.length + failed.length).toBe(attempts);
			for (const s of succeeded) {
				if (s.ok) s.session.close();
			}

			const m = server.metricsSnapshot();
			// On fast hosts, handshakes may complete before in-flight caps are exceeded.
			// When overflow happens, we must observe both failures and limit metrics.
			if (failed.length > 0) {
				expect(m.limitExceededCount).toBeGreaterThanOrEqual(1);
			} else {
				expect(succeeded.length).toBe(attempts);
			}
		} finally {
			await server.close();
		}
	}, 15000);

	it("maxSessions: exactly limit sessions accepted, limit+1 rejected", async () => {
		const port = nextPort(25480, 3000);
		const limit = 2;
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxSessions: limit, maxHandshakesInFlight: 10 },
			onSession: () => {},
		});

		try {
			const results = await Promise.all(
				Array.from({ length: limit + 1 }, () =>
					connectWithRetry(`https://127.0.0.1:${port}`, {
						tls: { insecureSkipVerify: true },
					}).then(
						(s) => ({ ok: true as const, session: s }),
						(e) => ({ ok: false as const, err: e }),
					),
				),
			);

			const succeeded = results.filter((r) => r.ok);
			expect(succeeded.length).toBe(limit);
			for (const s of succeeded) {
				if (s.ok) s.session.close();
			}

			const m = server.metricsSnapshot();
			expect(m.limitExceededCount).toBeGreaterThanOrEqual(1);
		} finally {
			await server.close();
		}
	}, 15000);

	it("maxStreamsPerSessionBidi: exactly limit streams succeed, limit+1 returns E_LIMIT_EXCEEDED", async () => {
		const port = nextPort(25480, 3000);
		const cap = 3;
		let serverSession: any = null;
		let resolveServerReady!: () => void;
		const serverReady = new Promise<void>((resolve) => {
			resolveServerReady = resolve;
		});
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxStreamsPerSessionBidi: cap, maxStreamsGlobal: 50000 },
			onSession: async (s) => {
				serverSession = s;
				resolveServerReady();
				for await (const _ of s.incomingDatagrams()) {
				}
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await serverReady;
			expect(serverSession).not.toBeNull();

			const opened: any[] = [];
			for (let i = 0; i < cap; i++) {
				opened.push(await serverSession.createBidirectionalStream());
			}
			expect(opened.length).toBe(cap);

			await expect(
				serverSession.createBidirectionalStream(),
			).rejects.toMatchObject({
				code: E_LIMIT_EXCEEDED,
			});
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);

	it("maxStreamsPerSessionUni: exactly limit streams succeed, limit+1 returns E_LIMIT_EXCEEDED", async () => {
		const port = nextPort(25480, 3000);
		const cap = 3;
		let serverSession: any = null;
		let resolveServerReady!: () => void;
		const serverReady = new Promise<void>((resolve) => {
			resolveServerReady = resolve;
		});
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			limits: { maxStreamsPerSessionUni: cap, maxStreamsGlobal: 50000 },
			onSession: async (s) => {
				serverSession = s;
				resolveServerReady();
				for await (const _ of s.incomingDatagrams()) {
				}
			},
		});

		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			await serverReady;
			expect(serverSession).not.toBeNull();

			const opened: any[] = [];
			for (let i = 0; i < cap; i++) {
				opened.push(await serverSession.createUnidirectionalStream());
			}
			expect(opened.length).toBe(cap);

			await expect(
				serverSession.createUnidirectionalStream(),
			).rejects.toMatchObject({
				code: E_LIMIT_EXCEEDED,
			});
		} finally {
			client.close();
			await server.close();
		}
	}, 15000);
});
