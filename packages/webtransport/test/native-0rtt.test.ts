/**
 * Native 0-RTT (fork-backed) tests.
 *
 * Isolation note: the native client ticket store is process-global and keyed
 * by rustls ServerName. Every test here connects to 127.0.0.1, so each test
 * uses a UNIQUE `serverName` (SNI) to key its tickets separately and avoid a
 * stale ticket from another test's (now-closed, different-keyed) server being
 * offered and rejected. insecureSkipVerify makes the name irrelevant to cert
 * validation.
 *
 * Determinism note: client-side signals are deterministic — has0Rtt (did we
 * offer a resumption ticket) and accepted0Rtt (did the same-process server
 * accept it). Server-side `is_0rtt` (was the CONNECT read before the
 * handshake completed) is a genuine race on ~0-RTT loopback and is therefore
 * NOT asserted as a fixed value. The replay-safety invariant that IS asserted
 * holds regardless of that race: under the default policy, a session reaches
 * onSession only once handshakeConfirmed is true.
 */

import { describe, it, expect } from "bun:test";
import {
	connect,
	createServer,
	exportTicketVault,
	importTicketVault,
	type ClientOptions,
	type ServerSession,
} from "../src/index.js";
import { nextPort } from "./helpers/network.js";

function clientOpts(serverName: string, enable0Rtt = false): ClientOptions {
	return {
		tls: { insecureSkipVerify: true, serverName },
		...(enable0Rtt ? { enable0Rtt: true } : {}),
	};
}

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

/**
 * Establish a session, hold it briefly so the NewSessionTickets land in the
 * client store, then close it. Leaves a resumable ticket for `serverName`.
 */
async function primeTicket(port: number, serverName: string): Promise<void> {
	const first = await connectWithRetry(
		`https://127.0.0.1:${port}`,
		clientOpts(serverName, true),
	);
	await Bun.sleep(200);
	first.close();
	await first.closed;
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
				clientOpts("no-0rtt.test"),
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
					...clientOpts("reject-pool.test", true),
					allowPooling: true,
				}),
			).rejects.toThrow(/E_INTERNAL.*enable0Rtt.*allowPooling/);
		} finally {
			await server.close();
		}
	});

	it("resumed reconnect rides 0-RTT: client offers early data and it is accepted", async () => {
		const port = nextPort(24330, 2000);
		const name = "resume.test";
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			enable0Rtt: true,
			allowEarlySession: true, // observe without the deferral for this test
			onSession: () => {},
		});
		try {
			await primeTicket(port, name);

			// Second connect must offer the ticket as early data and have it
			// accepted by the same-process server (deterministic client-side).
			const second = await connect(
				`https://127.0.0.1:${port}`,
				clientOpts(name, true),
			);
			expect(second.has0Rtt).toBe(true);
			expect(await waitUntil(() => second.handshakeConfirmed, 3000)).toBe(true);
			expect(second.accepted0Rtt).toBe(true);
			second.close();
			await second.closed;
		} finally {
			await server.close();
		}
	});

	it("a plain (non-resumed) connect never offers early data even with enable0Rtt", async () => {
		const port = nextPort(24335, 2000);
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			enable0Rtt: true,
			onSession: () => {},
		});
		try {
			const first = await connectWithRetry(
				`https://127.0.0.1:${port}`,
				clientOpts("fresh.test", true),
			);
			expect(first.has0Rtt).toBe(false);
			expect(first.handshakeConfirmed).toBe(true);
			first.close();
			await first.closed;
		} finally {
			await server.close();
		}
	});

	it("defers onSession until the handshake is confirmed (default replay-safety policy)", async () => {
		const port = nextPort(24350, 2000);
		const name = "deferred.test";
		const confirmedAtCallback: boolean[] = [];
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			enable0Rtt: true,
			// allowEarlySession omitted -> deferred default.
			onSession: (session) => {
				confirmedAtCallback.push(session.handshakeConfirmed);
			},
		});
		try {
			await primeTicket(port, name);

			const second = await connect(
				`https://127.0.0.1:${port}`,
				clientOpts(name, true),
			);
			expect(second.has0Rtt).toBe(true);
			expect(
				await waitUntil(() => confirmedAtCallback.length === 2, 3000),
			).toBe(true);
			// Invariant: under the default policy a session is never surfaced
			// to onSession before its handshake is confirmed, whether or not the
			// server happened to read the request as 0-RTT. This is the gate
			// that makes the replayable session request safe by default.
			expect(confirmedAtCallback.every((c) => c === true)).toBe(true);
			second.close();
			await second.closed;
		} finally {
			await server.close();
		}
	});

	it("allowEarlySession still establishes a working resumed session", async () => {
		const port = nextPort(24360, 2000);
		const name = "early.test";
		let sessionCount = 0;
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			enable0Rtt: true,
			allowEarlySession: true,
			onSession: () => {
				sessionCount++;
			},
		});
		try {
			await primeTicket(port, name);

			const second = await connect(
				`https://127.0.0.1:${port}`,
				clientOpts(name, true),
			);
			expect(second.has0Rtt).toBe(true);
			expect(await waitUntil(() => second.handshakeConfirmed, 3000)).toBe(true);
			expect(second.accepted0Rtt).toBe(true);
			expect(await waitUntil(() => sessionCount === 2, 3000)).toBe(true);
			second.close();
			await second.closed;
		} finally {
			await server.close();
		}
	});

	it("vault export/import is an opaque, consume-once, process-local round trip", async () => {
		const port = nextPort(24340, 2000);
		const name = "vault.test";
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			enable0Rtt: true,
			onSession: () => {},
		});
		try {
			await primeTicket(port, name);

			const identity = clientOpts(name, true);
			const token = exportTicketVault(identity, name);
			expect(token).toBeString();
			// Draining twice yields nothing.
			expect(exportTicketVault(identity, name)).toBeNull();
			// Import restores the tickets; the token is consumed.
			expect(importTicketVault(token!, identity)).toBe(true);
			expect(importTicketVault(token!, identity)).toBe(false);
			// Unknown tokens are refused.
			expect(importTicketVault("wt0rtt-vault-bogus", identity)).toBe(false);

			// The re-imported tickets still resume.
			const resumed = await connect(
				`https://127.0.0.1:${port}`,
				clientOpts(name, true),
			);
			expect(resumed.has0Rtt).toBe(true);
			resumed.close();
			await resumed.closed;
		} finally {
			await server.close();
		}
	});
});
