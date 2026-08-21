/**
 * Native `reusePort` option tests.
 *
 * Scope, stated honestly: what is portable is that the flag lets a second
 * server join a port that a first server already holds, and that a server
 * WITHOUT the flag still cannot. What the kernel then does with arriving
 * packets is platform-owned — Linux hashes the 4-tuple across the group,
 * BSD/macOS delivers to the last binder — so nothing here asserts anything
 * about distribution, and the traffic check below runs on Linux only.
 *
 * The socket-level behavior (SO_REUSEPORT set before bind, IPV6_V6ONLY left at
 * the OS default so the injected socket matches the fork's own bind path) is
 * covered by the Rust unit tests in crates/native/src/server_spawn.rs.
 */

import { describe, expect, it } from "bun:test";
import { connect, createServer, type ServerSession } from "../src/index.js";
import { forEachWithTimeout, nextWithTimeout } from "./helpers/harness.js";
import { nextPort } from "./helpers/network.js";

const DATAGRAM_TIMEOUT_MS = 5000;
const isLinux = process.platform === "linux";

function echoServer(port: number, extra: Record<string, unknown> = {}) {
	const sessions: ServerSession[] = [];
	const server = createServer({
		port,
		tls: { certPem: "", keyPem: "" },
		...extra,
		onSession: (session) => {
			sessions.push(session);
			void forEachWithTimeout(
				session.incomingDatagrams(),
				DATAGRAM_TIMEOUT_MS,
				"reusePort echo server incoming datagram",
				async (dgram) => {
					await session.sendDatagram(dgram);
				},
			).catch(() => {});
		},
	});
	return { server, sessions };
}

describe("native reusePort option", () => {
	it("lets a second server bind a port the first one already holds", async () => {
		const port = nextPort(24810, 2000);
		const first = createServer({
			port,
			reusePort: true,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			expect(first.address.port).toBe(port);
			const second = createServer({
				port,
				reusePort: true,
				tls: { certPem: "", keyPem: "" },
				onSession: () => {},
			});
			try {
				expect(second.address.port).toBe(port);
			} finally {
				await second.close();
			}
		} finally {
			await first.close();
		}
	});

	it("still rejects a second bind without the flag", async () => {
		const port = nextPort(24815, 2000);
		const first = createServer({
			port,
			reusePort: true,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			expect(() =>
				createServer({
					port,
					tls: { certPem: "", keyPem: "" },
					onSession: () => {},
				}),
			).toThrow(/address already in use|AddrInUse|failed to create endpoint/i);
		} finally {
			await first.close();
		}
	});

	// Linux hashes arriving 4-tuples across the reuseport group, so whichever
	// member the kernel picks must be able to serve the session. On BSD/macOS
	// only the last binder receives, which is a different (and untested here)
	// contract.
	it.skipIf(!isLinux)(
		"a session lands on some member of the group and round-trips",
		async () => {
			const port = nextPort(24820, 2000);
			const a = echoServer(port, { reusePort: true });
			const b = echoServer(port, { reusePort: true });
			try {
				const client = await connect(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true, serverName: "reuseport.test" },
				});
				const payload = new Uint8Array([9, 8, 7, 6]);
				const incoming = client.incomingDatagrams()[Symbol.asyncIterator]();
				let echoed: Uint8Array | undefined;
				void (async () => {
					try {
						const first = await nextWithTimeout(
							incoming,
							DATAGRAM_TIMEOUT_MS,
							"reusePort client echoed datagram",
						);
						if (!first.done) echoed = first.value;
					} finally {
						await incoming.return?.();
					}
				})().catch(() => {});
				for (let i = 0; i < 40 && echoed === undefined; i++) {
					await client.sendDatagram(payload);
					await Bun.sleep(50);
				}
				expect(echoed).toBeDefined();
				expect(Buffer.from(echoed!)).toEqual(Buffer.from(payload));
				expect(a.sessions.length + b.sessions.length).toBe(1);
				client.close();
				await client.closed;
			} finally {
				await a.server.close();
				await b.server.close();
			}
		},
	);

	it("rejects reusePort with port 0", () => {
		expect(() =>
			createServer({
				port: 0,
				reusePort: true,
				tls: { certPem: "", keyPem: "" },
				onSession: () => {},
			}),
		).toThrow(/E_INVALID_ARGUMENT: reusePort requires an explicit port/);
	});

	it("rejects a non-boolean reusePort", () => {
		expect(() =>
			createServer({
				port: nextPort(24825, 2000),
				// @ts-expect-error non-boolean on purpose
				reusePort: "yes",
				tls: { certPem: "", keyPem: "" },
				onSession: () => {},
			}),
		).toThrow(/E_INVALID_ARGUMENT: reusePort must be a boolean/);
	});

	it("defaults to off: port 0 stays legal without the flag", async () => {
		const server = createServer({
			port: 0,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		try {
			expect(server.address.port).toBeGreaterThan(0);
		} finally {
			await server.close();
		}
	});
});
