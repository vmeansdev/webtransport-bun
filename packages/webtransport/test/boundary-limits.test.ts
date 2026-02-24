/**
 * P0.4: Boundary correctness for limits/rate gates.
 * Tests exact semantics: at limit succeeds, at limit+1 fails.
 */
import { describe, it, expect } from "bun:test";
import { connect, createServer, E_LIMIT_EXCEEDED } from "../src/index.js";

describe("limit boundaries (P0.4)", () => {
	it("maxHandshakesInFlight: at most limit handshakes proceed, excess rejected", async () => {
		const limit = 3;
		const server = createServer({
			port: 14500,
			tls: { certPem: "", keyPem: "" },
			limits: { maxHandshakesInFlight: limit, maxSessions: 100 },
			onSession: () => {},
		});
		await Bun.sleep(2000);

		const attempts = 6;
		const results = await Promise.all(
			Array.from({ length: attempts }, () =>
				connect("https://127.0.0.1:14500", {
					tls: { insecureSkipVerify: true },
				}).then(
					(s) => ({ ok: true as const, session: s }),
					(e) => ({ ok: false as const, err: e }),
				),
			),
		);

		const succeeded = results.filter((r) => r.ok);
		const failed = results.filter((r) => !r.ok);

		expect(succeeded.length).toBeLessThanOrEqual(limit);
		expect(succeeded.length + failed.length).toBe(attempts);
		for (const s of succeeded) {
			if (s.ok) s.session.close();
		}

		const m = server.metricsSnapshot();
		expect(m.limitExceededCount).toBeGreaterThanOrEqual(1);

		await server.close();
	}, 15000);

	it("maxSessions: exactly limit sessions accepted, limit+1 rejected", async () => {
		const limit = 2;
		const server = createServer({
			port: 14501,
			tls: { certPem: "", keyPem: "" },
			limits: { maxSessions: limit, maxHandshakesInFlight: 10 },
			onSession: () => {},
		});
		await Bun.sleep(2000);

		const results = await Promise.all(
			Array.from({ length: limit + 1 }, () =>
				connect("https://127.0.0.1:14501", {
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

		await server.close();
	}, 15000);

	it("maxStreamsPerSessionBidi: exactly limit streams succeed, limit+1 returns E_LIMIT_EXCEEDED", async () => {
		const cap = 3;
		let serverSession: any = null;
		const serverReady = new Promise<void>((resolve) => {
			createServer({
				port: 14502,
				tls: { certPem: "", keyPem: "" },
				limits: { maxStreamsPerSessionBidi: cap, maxStreamsGlobal: 50000 },
				onSession: async (s) => {
					serverSession = s;
					resolve();
					for await (const _ of s.incomingDatagrams()) {
					}
				},
			});
		});
		await Bun.sleep(2000);

		const client = await connect("https://127.0.0.1:14502", {
			tls: { insecureSkipVerify: true },
		});
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

		client.close();
	}, 15000);

	it("maxStreamsPerSessionUni: exactly limit streams succeed, limit+1 returns E_LIMIT_EXCEEDED", async () => {
		const cap = 3;
		let serverSession: any = null;
		const serverReady = new Promise<void>((resolve) => {
			createServer({
				port: 14503,
				tls: { certPem: "", keyPem: "" },
				limits: { maxStreamsPerSessionUni: cap, maxStreamsGlobal: 50000 },
				onSession: async (s) => {
					serverSession = s;
					resolve();
					for await (const _ of s.incomingDatagrams()) {
					}
				},
			});
		});
		await Bun.sleep(2000);

		const client = await connect("https://127.0.0.1:14503", {
			tls: { insecureSkipVerify: true },
		});
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

		client.close();
	}, 15000);
});
