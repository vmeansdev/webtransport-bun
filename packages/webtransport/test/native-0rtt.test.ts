/**
 * Native 0-RTT (fork-backed) tests:
 * - off by default: sessions report no 0-RTT involvement
 * - enable0Rtt is incompatible with allowPooling (loud rejection)
 * - resumed reconnect offers and gets early data accepted (has0Rtt/accepted0Rtt)
 * - server session reports has0Rtt for a 0-RTT CONNECT
 * - opaque vault export/import round trip (process-local only)
 */

import { describe, it, expect } from "bun:test";
import {
	connect,
	createServer,
	exportTicketVault,
	importTicketVault,
	type ServerSession,
} from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const CLIENT_TLS = { tls: { insecureSkipVerify: true } } as const;

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
	intervalMs = 25,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await Bun.sleep(intervalMs);
	}
	return condition();
}

describe("native 0-RTT", () => {
	it("sessions report no 0-RTT involvement when the feature is off", async () => {
		const port = nextPort(24310, 2000);
		const serverSessions: ServerSession[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (session) => {
				serverSessions.push(session);
			},
		});
		try {
			const client = await connectWithRetry(
				`https://127.0.0.1:${port}`,
				CLIENT_TLS,
			);
			expect(client.has0Rtt).toBe(false);
			expect(client.accepted0Rtt).toBe(false);
			expect(client.handshakeConfirmed).toBe(true);
			expect(await waitUntil(() => serverSessions.length === 1, 3000)).toBe(
				true,
			);
			expect(serverSessions[0]!.has0Rtt).toBe(false);
			expect(serverSessions[0]!.accepted0Rtt).toBe(false);
			expect(serverSessions[0]!.handshakeConfirmed).toBe(true);
			client.close();
		} finally {
			await server.close();
		}
	});

	it("rejects enable0Rtt combined with allowPooling", async () => {
		const port = nextPort(24320, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			await expect(
				connect(`https://127.0.0.1:${port}`, {
					...CLIENT_TLS,
					enable0Rtt: true,
					allowPooling: true,
				}),
			).rejects.toThrow(/E_INTERNAL.*enable0Rtt.*allowPooling/);
		} finally {
			await server.close();
		}
	});

	it("resumed reconnect rides 0-RTT: client reports has0Rtt/accepted0Rtt, server reports has0Rtt", async () => {
		const port = nextPort(24330, 2000);
		const serverSessions: ServerSession[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			enable0Rtt: true,
			onSession: (session) => {
				serverSessions.push(session);
			},
		});
		try {
			// First connect: nothing to resume — full handshake, mints tickets.
			const first = await connectWithRetry(`https://127.0.0.1:${port}`, {
				...CLIENT_TLS,
				enable0Rtt: true,
			});
			expect(first.has0Rtt).toBe(false);
			expect(first.handshakeConfirmed).toBe(true);
			// Keep the first session open briefly so NewSessionTickets land.
			await Bun.sleep(200);
			first.close();
			await first.closed;

			// Second connect: must offer the ticket as early data and have it
			// accepted by the same-process server.
			const second = await connect(`https://127.0.0.1:${port}`, {
				...CLIENT_TLS,
				enable0Rtt: true,
			});
			expect(second.has0Rtt).toBe(true);
			expect(await waitUntil(() => second.handshakeConfirmed, 3000)).toBe(true);
			expect(second.accepted0Rtt).toBe(true);

			expect(await waitUntil(() => serverSessions.length === 2, 3000)).toBe(
				true,
			);
			const resumed = serverSessions[1]!;
			expect(resumed.has0Rtt).toBe(true);
			expect(resumed.accepted0Rtt).toBe(true);
			expect(await waitUntil(() => resumed.handshakeConfirmed, 3000)).toBe(
				true,
			);
			// The non-resumed first server session stays 1-RTT.
			expect(serverSessions[0]!.has0Rtt).toBe(false);

			second.close();
			await second.closed;
		} finally {
			await server.close();
		}
	});

	it("vault export/import is an opaque, consume-once, process-local round trip", async () => {
		const port = nextPort(24340, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			enable0Rtt: true,
			onSession: () => {},
		});
		try {
			// Mint tickets for the insecure client identity.
			const session = await connectWithRetry(`https://127.0.0.1:${port}`, {
				...CLIENT_TLS,
				enable0Rtt: true,
			});
			await Bun.sleep(200);
			session.close();
			await session.closed;

			const token = exportTicketVault(CLIENT_TLS, "127.0.0.1");
			expect(token).toBeString();
			// Draining twice yields nothing.
			expect(exportTicketVault(CLIENT_TLS, "127.0.0.1")).toBeNull();
			// Import restores the tickets; the token is consumed.
			expect(importTicketVault(token!, CLIENT_TLS)).toBe(true);
			expect(importTicketVault(token!, CLIENT_TLS)).toBe(false);
			// Unknown tokens are refused.
			expect(importTicketVault("wt0rtt-vault-bogus", CLIENT_TLS)).toBe(false);

			// The re-imported tickets still resume.
			const resumed = await connect(`https://127.0.0.1:${port}`, {
				...CLIENT_TLS,
				enable0Rtt: true,
			});
			expect(resumed.has0Rtt).toBe(true);
			resumed.close();
			await resumed.closed;
		} finally {
			await server.close();
		}
	});
});
