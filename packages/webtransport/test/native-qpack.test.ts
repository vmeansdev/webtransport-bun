/**
 * Native dynamic-QPACK option tests (fork feat/qpack-dynamic).
 *
 * Scope, stated honestly: the round-trip tests are a NO-REGRESSION guard, not a
 * proof that the option reaches the wire. They establish a session and echo a
 * datagram with a non-zero SETTINGS_QPACK_MAX_TABLE_CAPACITY asked for on one
 * or both peers, and would catch a QPACK_DECOMPRESSION_FAILED /
 * QPACK_ENCODER_STREAM_ERROR teardown introduced by advertising a table. They
 * would NOT catch the option being dropped somewhere between here and the
 * builder: nothing observable from this process differs between a session that
 * advertised 4096 and one that advertised nothing.
 *
 * What covers the rest:
 *  - the resolver's own behaviour (number-over-boolean precedence, explicit 0,
 *    clamping, malformed values) — the Rust unit tests around
 *    `parse_qpack_max_table_capacity` in crates/native/src/client.rs;
 *  - the option actually reaching the wire — the Chromium interop gate in
 *    tools/interop, which waits on the server's advertised-capacity line and
 *    drives a real browser QPACK encoder against it;
 *  - the decode machinery — RFC 9204 Appendix B vectors and the fork's suite.
 *
 * The validation tests at the bottom are the ones that fail if the option stops
 * being read here at all.
 *
 * A native<->native handshake also cannot exercise a dynamic table REFERENCE:
 * at blocked_streams=0 (always, per the fork's tractability decision) neither
 * peer may reference an entry on the single CONNECT exchange, so what runs is
 * the insert/ack path, not a reference.
 */

import { describe, expect, it } from "bun:test";
import { connect, createServer, type ServerSession } from "../src/index.js";
import { forEachWithTimeout, nextWithTimeout } from "./helpers/harness.js";
import { nextPort } from "./helpers/network.js";

const DATAGRAM_TIMEOUT_MS = 5000;

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
			void forEachWithTimeout(
				session.incomingDatagrams(),
				DATAGRAM_TIMEOUT_MS,
				"qpack echo server incoming datagram",
				async (dgram) => {
					await session.sendDatagram(dgram);
				},
			).catch(() => {});
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
	const incoming = client.incomingDatagrams()[Symbol.asyncIterator]();
	void (async () => {
		try {
			const first = await nextWithTimeout(
				incoming,
				DATAGRAM_TIMEOUT_MS,
				"qpack client echoed datagram",
			);
			if (!first.done) {
				echoed = first.value;
			}
		} finally {
			await incoming.return?.();
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

	// A bad option is the caller's mistake, not an internal failure, and the two
	// codes are handled differently by anyone catching them.
	it("reports a bad capacity as an argument error, not an internal one", async () => {
		const port = nextPort(24650, 2000);
		expect(() =>
			createServer({
				port,
				tls: { certPem: "", keyPem: "" },
				qpackMaxTableCapacity: 70000,
				onSession: () => {},
			}),
		).toThrow(/E_INVALID_ARGUMENT: qpackMaxTableCapacity/);

		await expect(
			connect("https://127.0.0.1:1", {
				tls: { insecureSkipVerify: true },
				qpackMaxTableCapacity: -1,
			}),
		).rejects.toThrow(/E_INVALID_ARGUMENT: qpackMaxTableCapacity/);
	});

	// Silently ignoring it would leave the caller believing they had a dynamic
	// table: the Rust side reads this with `as_bool()` and drops anything else.
	it("rejects a non-boolean enableDynamicQpack on both surfaces", async () => {
		const port = nextPort(24660, 2000);
		expect(() =>
			createServer({
				port,
				tls: { certPem: "", keyPem: "" },
				// @ts-expect-error non-boolean on purpose
				enableDynamicQpack: "yes",
				onSession: () => {},
			}),
		).toThrow(/E_INVALID_ARGUMENT: enableDynamicQpack must be a boolean/);

		await expect(
			connect("https://127.0.0.1:1", {
				tls: { insecureSkipVerify: true },
				// @ts-expect-error non-boolean on purpose
				enableDynamicQpack: 1,
			}),
		).rejects.toThrow(
			/E_INVALID_ARGUMENT: enableDynamicQpack must be a boolean/,
		);
	});

	// Strict mode turns facade errors into DOMExceptions; a bad QPACK value was
	// the one that stayed a plain WebTransportError.
	it("maps a bad capacity to a DOMException under strictW3CErrors", async () => {
		await expect(
			connect("https://127.0.0.1:1", {
				tls: { insecureSkipVerify: true },
				strictW3CErrors: true,
				qpackMaxTableCapacity: 70000,
			}),
		).rejects.toMatchObject({ name: "TypeError" });
	});
});
