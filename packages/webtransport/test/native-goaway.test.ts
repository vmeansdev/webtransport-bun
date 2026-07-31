/**
 * Native GOAWAY send path.
 *
 * A native server sends an H3 `GOAWAY` (connection-scoped: "don't open new
 * sessions on this connection") and the native client peer observes it — its
 * `draining` settles, since the fork folds a received GOAWAY into the same
 * signal as `WT_DRAIN_SESSION`. The session stays usable afterwards: GOAWAY is a
 * warning, not an ending.
 *
 * Scope note: native is single-session-per-connection, so the "refuse a second
 * session" enforcement is not reachable through the public API. What is testable
 * — and all this proves — is the send capability plus the peer observably
 * receiving it. The negative control shows that without the send, nothing on the
 * wire settles the peer's `draining`.
 */

import { describe, expect, it } from "bun:test";
import { createServer, type ServerSession } from "../src/index.js";
import {
	nextWithTimeout,
	withHarness,
	withTimeout,
} from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 15600;

// `connectWithRetry` may open more than one session; a token datagram
// round-trip identifies the server session actually backing this client.
async function captureServerSession(
	client: { sendDatagram(d: Uint8Array): Promise<void> },
	getSession: () => ServerSession | undefined,
	token: string,
): Promise<ServerSession> {
	const deadline = Date.now() + 5000;
	while (!getSession() && Date.now() < deadline) {
		await client.sendDatagram(new TextEncoder().encode(token));
		await Bun.sleep(25);
	}
	const session = getSession();
	if (!session) throw new Error("server never saw the token datagram");
	return session;
}

describe("native GOAWAY send path", () => {
	it("server goAway() settles the client's draining, and the session stays usable", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT, 400);
			const token = `goaway-${Math.random().toString(36).slice(2)}`;
			let serverSession: ServerSession | undefined;

			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: (s) => {
						void (async () => {
							const decoder = new TextDecoder();
							const iter = s.incomingDatagrams()[Symbol.asyncIterator]();
							try {
								while (true) {
									const next = await nextWithTimeout(
										iter,
										5000,
										"native goaway positive token datagram",
									);
									if (next.done || next.value === undefined) {
										return;
									}
									if (decoder.decode(next.value) === token) {
										serverSession = s;
										return;
									}
								}
							} finally {
								await iter.return?.();
							}
						})().catch(() => {});
					},
				}),
			);

			const client = h.track(
				await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);

			const session = await captureServerSession(
				client,
				() => serverSession,
				token,
			);

			let closedEarly = false;
			void client.closed.then(
				() => {
					closedEarly = true;
				},
				() => {
					closedEarly = true;
				},
			);

			// The send under test. Nothing closes; only a real wire GOAWAY can
			// settle `draining` while the session keeps working.
			session.goAway();
			await withTimeout(client.draining, 5000, "native goaway peer observe");

			// A GOAWAY is a warning, not an ending: the session must still be open
			// and still able to carry a fresh stream.
			expect(closedEarly).toBe(false);
			const stream = await client.createBidirectionalStream();
			stream.write(Buffer.from([1, 2, 3]), () => {});
			stream.end();
			await Bun.sleep(50);

			client.close();
			await server.close();
		});
	}, 20000);

	it("negative control: without goAway(), draining does not settle from the wire", async () => {
		await withHarness(async (h) => {
			const port = nextPort(BASE_PORT + 1000, 400);
			const token = `nogoaway-${Math.random().toString(36).slice(2)}`;
			let serverSession: ServerSession | undefined;

			const server = h.track(
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: (s) => {
						void (async () => {
							const decoder = new TextDecoder();
							const iter = s.incomingDatagrams()[Symbol.asyncIterator]();
							try {
								while (true) {
									const next = await nextWithTimeout(
										iter,
										5000,
										"native goaway negative token datagram",
									);
									if (next.done || next.value === undefined) {
										return;
									}
									if (decoder.decode(next.value) === token) {
										serverSession = s;
										return;
									}
								}
							} finally {
								await iter.return?.();
							}
						})().catch(() => {});
					},
				}),
			);

			const client = h.track(
				await connectWithRetry(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
				}),
			);

			await captureServerSession(client, () => serverSession, token);

			// No goAway() and no close(): the session stays open, so `draining`
			// (which also races `closed`) must stay pending. A resolved draining
			// here would mean the positive test proved nothing.
			const sentinel = Symbol("pending");
			const raced = await Promise.race([
				client.draining.then(() => "settled" as const),
				Bun.sleep(1500).then(() => sentinel),
			]);
			expect(raced).toBe(sentinel);

			client.close();
			await server.close();
		});
	}, 20000);
});
