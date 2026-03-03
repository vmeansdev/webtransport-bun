/**
 * P0.2: Tests that stable error codes E_RATE_LIMITED, E_SESSION_IDLE_TIMEOUT,
 * and E_STOP_SENDING are emitted by runtime paths.
 */

import { describe, it, expect } from "bun:test";
import {
	connect,
	createServer,
	E_RATE_LIMITED,
	E_SESSION_IDLE_TIMEOUT,
	E_STREAM_RESET,
	E_STOP_SENDING,
	WebTransportError,
	WT_RESET,
	WT_STOP_SENDING,
} from "../src/index.js";
import { withHarness } from "./helpers/harness.js";
import { nextPort } from "./helpers/network.js";

const BASE_PORT = 14700;

async function waitUntil(
	condition: () => boolean,
	timeoutMs: number,
	intervalMs = 25,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await Bun.sleep(intervalMs);
	}
	return condition();
}

async function connectWithRateLimitRetry(
	url: string,
	timeoutMs: number,
): Promise<Awaited<ReturnType<typeof connect>>> {
	const deadline = Date.now() + timeoutMs;
	let lastErr: unknown = null;
	while (Date.now() < deadline) {
		try {
			return await connect(url, {
				tls: { insecureSkipVerify: true },
			});
		} catch (e) {
			lastErr = e;
			if (!(e instanceof WebTransportError) || e.code !== E_RATE_LIMITED) {
				throw e;
			}
			await Bun.sleep(150);
		}
	}
	throw lastErr ?? new Error("timed out waiting for connect");
}

describe("P0.2 stable error codes", () => {
	it("E_SESSION_IDLE_TIMEOUT: session closed due to idle has E_SESSION_IDLE_TIMEOUT in close info", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			let serverSession: any = null;
			h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					limits: { idleTimeoutMs: 500 },
					onSession: (s) => {
						serverSession = s;
					},
				}),
			);
			await Bun.sleep(1500);

			const client = h.track(
				await connectWithRateLimitRetry(`https://127.0.0.1:${port}`, 4000),
			);
			const accepted = await waitUntil(() => serverSession != null, 4000);
			if (!accepted) throw new Error("onSession never fired");
			const info = await serverSession.closed;
			client.close();

			expect(String(info?.reason ?? "")).toContain(E_SESSION_IDLE_TIMEOUT);
		});
	}, 15000);

	it("E_RATE_LIMITED: handshake rate limit rejects with E_RATE_LIMITED", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					rateLimits: {
						handshakesPerSec: 2,
						handshakesBurst: 1,
						handshakesBurstPerPrefix: 1,
					},
					onSession: () => {},
				}),
			);
			await Bun.sleep(1500);

			const c1 = h.track(
				await connectWithRateLimitRetry(`https://127.0.0.1:${port}`, 4000),
			);
			await Bun.sleep(10);
			let err: unknown = null;
			for (let i = 0; i < 4; i++) {
				try {
					const c = h.track(
						await connect(`https://127.0.0.1:${port}`, {
							tls: { insecureSkipVerify: true },
						}),
					);
					c.close();
				} catch (e) {
					if (e instanceof WebTransportError && e.code === E_RATE_LIMITED) {
						err = e;
						break;
					}
					err = e;
				}
				await Bun.sleep(20);
			}
			c1.close();

			expect(err).toBeDefined();
			expect((err as WebTransportError).code).toBe(E_RATE_LIMITED);
		});
	}, 15000);

	it("E_STOP_SENDING: write after peer stopSending throws E_STOP_SENDING", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			let stopSendingCalled = false;
			h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: async (s) => {
						for await (const duplex of s.incomingBidirectionalStreams) {
							const reader = duplex.readable.getReader();
							const first = await reader.read();
							if (!first.done) {
								(duplex as any)[WT_STOP_SENDING](0);
								stopSendingCalled = true;
							}
							reader.releaseLock();
							break;
						}
					},
				}),
			);
			await Bun.sleep(1500);

			const client = h.track(
				await connect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);
			const stream = await client.createBidirectionalStream();
			let err: unknown;
			const errPromise = new Promise<void>((r) => {
				stream.on("error", (e: any) => {
					err = e;
					r();
				});
			});
			stream.write(Buffer.from("hello"));
			while (!stopSendingCalled) await Bun.sleep(50);
			await Bun.sleep(300);

			const writeWithCallback = (): Promise<void> =>
				new Promise((resolve, reject) => {
					stream.write(Buffer.from("x"), (e: any) => {
						if (e) {
							err = e;
							reject(e);
						} else resolve();
					});
				});
			for (let i = 0; i < 20; i++) {
				try {
					await writeWithCallback();
				} catch {
					break;
				}
				await Bun.sleep(50);
			}
			if (!err) await Promise.race([errPromise, Bun.sleep(500)]);
			expect(err).toBeDefined();
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).toContain(E_STOP_SENDING);
		});
	}, 15000);

	it("E_STREAM_RESET: read errors when peer resets stream", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: async (s) => {
						for await (const duplex of s.incomingBidirectionalStreams) {
							(duplex as any)[WT_RESET](42);
							break;
						}
					},
				}),
			);
			await Bun.sleep(300);

			const client = h.track(
				await connect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);
			const stream = await client.createBidirectionalStream();
			await new Promise<void>((resolve, reject) => {
				stream.write(Buffer.from("trigger"), (e?: Error | null) =>
					e ? reject(e) : resolve(),
				);
			});

			let err: unknown = null;
			const errPromise = new Promise<void>((resolve) => {
				stream.once("error", (e) => {
					err = e;
					resolve();
				});
			});
			stream.resume();
			await Promise.race([errPromise, Bun.sleep(3000)]);

			expect(err).toBeDefined();
			expect(String((err as Error).message ?? err)).toContain(E_STREAM_RESET);
		});
	}, 15000);
});
