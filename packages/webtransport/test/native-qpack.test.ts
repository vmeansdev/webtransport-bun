/**
 * Native dynamic-QPACK option tests (fork feat/qpack-dynamic).
 *
 * Scope: these prove the napi option threads through — that advertising a
 * non-zero SETTINGS_QPACK_MAX_TABLE_CAPACITY on one or both peers still
 * establishes a session (the CONNECT header section round-trips) and the data
 * plane works, with no QPACK_DECOMPRESSION_FAILED / QPACK_ENCODER_STREAM_ERROR.
 *
 * They do NOT prove the dynamic-reference decode path against a native peer:
 * at blocked_streams=0 (always, per the fork's tractability decision) neither
 * native peer ever emits a dynamic table reference on the single CONNECT
 * exchange, so a native<->native handshake exercises the option plumbing and
 * the encoder-stream insert/ack path, not a dynamic REFERENCE. The RFC 9204
 * Appendix B vectors and the fork's own unit suite carry the decode-machinery
 * proof; Chromium interop (see tools/interop) carries the cross-impl proof.
 */

import { describe, expect, it } from "bun:test";
import { connect, createServer, type ServerSession } from "../src/index.js";
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
	intervalMs = 25,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return true;
		await Bun.sleep(intervalMs);
	}
	return condition();
}

// Server that echoes every incoming datagram straight back. Datagrams are the
// facade-agnostic data-plane check here — CommonSession exposes sendDatagram /
// incomingDatagrams on both the server and client surfaces.
function echoServer(port: number, qpack: Record<string, unknown>) {
	const sessions: ServerSession[] = [];
	const server = createServer({
		port,
		tls: { certPem: "", keyPem: "" },
		...qpack,
		onSession: (session) => {
			sessions.push(session);
			void (async () => {
				for await (const dgram of session.incomingDatagrams()) {
					await session.sendDatagram(dgram);
				}
			})().catch(() => {});
		},
	});
	return { server, sessions };
}

async function roundTrip(url: string, clientOpts: Record<string, unknown>) {
	const client = await connectWithRetry(url, {
		tls: { insecureSkipVerify: true, serverName: "qpack.test" },
		...clientOpts,
	});
	const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
	let echoed: Uint8Array | undefined;
	void (async () => {
		for await (const dgram of client.incomingDatagrams()) {
			echoed = dgram;
			break;
		}
	})().catch(() => {});
	// Datagrams are unreliable; retransmit until the echo lands (or timeout).
	for (let i = 0; i < 40 && echoed === undefined; i++) {
		await client.sendDatagram(payload);
		await Bun.sleep(50);
	}
	return { client, echoed, payload };
}

describe("native dynamic QPACK options", () => {
	it("server advertising capacity>0 still establishes + round-trips (client static)", async () => {
		const port = nextPort(24610, 2000);
		const { server, sessions } = echoServer(port, {
			qpackMaxTableCapacity: 4096,
		});
		try {
			const { client, echoed, payload } = await roundTrip(
				`https://127.0.0.1:${port}`,
				{},
			);
			expect(client.handshakeConfirmed).toBe(true);
			expect(await waitUntil(() => sessions.length === 1, 3000)).toBe(true);
			expect(echoed).toBeDefined();
			expect(Buffer.from(echoed!)).toEqual(Buffer.from(payload));
			client.close();
			await client.closed;
		} finally {
			await server.close();
		}
	});

	it("both peers advertising capacity>0 establish + round-trip", async () => {
		const port = nextPort(24620, 2000);
		const { server, sessions } = echoServer(port, {
			qpackMaxTableCapacity: 4096,
		});
		try {
			const { client, echoed, payload } = await roundTrip(
				`https://127.0.0.1:${port}`,
				{ qpackMaxTableCapacity: 4096 },
			);
			expect(client.handshakeConfirmed).toBe(true);
			expect(await waitUntil(() => sessions.length === 1, 3000)).toBe(true);
			expect(echoed).toBeDefined();
			expect(Buffer.from(echoed!)).toEqual(Buffer.from(payload));
			client.close();
			await client.closed;
		} finally {
			await server.close();
		}
	});

	it("enableDynamicQpack preset works on both peers (asymmetric capacities)", async () => {
		const port = nextPort(24630, 2000);
		// Server preset = 4096; client explicit 65536 — asymmetric advertised
		// capacities must still interop.
		const { server, sessions } = echoServer(port, {
			enableDynamicQpack: true,
		});
		try {
			const { client, echoed, payload } = await roundTrip(
				`https://127.0.0.1:${port}`,
				{ qpackMaxTableCapacity: 65536 },
			);
			expect(client.handshakeConfirmed).toBe(true);
			expect(await waitUntil(() => sessions.length === 1, 3000)).toBe(true);
			expect(echoed).toBeDefined();
			expect(Buffer.from(echoed!)).toEqual(Buffer.from(payload));
			client.close();
			await client.closed;
		} finally {
			await server.close();
		}
	});

	it("rejects an out-of-range qpackMaxTableCapacity on the client", async () => {
		await expect(
			connect("https://127.0.0.1:1", {
				tls: { insecureSkipVerify: true },
				qpackMaxTableCapacity: 70000,
			}),
		).rejects.toThrow(/qpackMaxTableCapacity/);
	});

	it("rejects a non-integer qpackMaxTableCapacity on the server", async () => {
		const port = nextPort(24640, 2000);
		expect(() =>
			createServer({
				port,
				tls: { certPem: "", keyPem: "" },
				qpackMaxTableCapacity: 4096.5,
				onSession: () => {},
			}),
		).toThrow(/qpackMaxTableCapacity/);
	});
});
