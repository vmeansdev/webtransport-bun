// Regression tests for the deep-review fixes: cert pinning, ready rejection,
// per-session close semantics, close-code propagation, and IPv6 addressing.

import { describe, expect, test } from "bun:test";
import { connectWasm, serveOverUdp, type WasmSession } from "../src/backend.js";
import { formatAddr, type WasmModule } from "../src/backend-wasm.js";
import { BunUdpTransport } from "../src/bun-udp.js";
import { E_TLS } from "../src/errors.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

// Soft-skip when pkg is absent (local `bun test packages/`). With
// WEBTRANSPORT_REQUIRE_WASM=1 the helper throws at import time instead.
const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

const enc = new TextEncoder();
const dec = new TextDecoder();

async function startEchoServer(port: number) {
	const udp = await BunUdpTransport.bind("127.0.0.1", port);
	const actualPort = udp.localPort ?? port;
	const sessions: WasmSession[] = [];
	const { manager, certHashBase64 } = await serveOverUdp(
		wasm,
		() => Promise.resolve(udp),
		{
			localAddress: "127.0.0.1",
			localPort: actualPort,
			onSession: (session) => {
				sessions.push(session);
				session.onDatagram((d) => session.sendDatagram(d));
			},
		},
	);
	return { udp, manager, certHashBase64, sessions, port: actualPort };
}

describe("formatAddr (IPv6 vs IPv4)", () => {
	test("brackets IPv6 hosts, leaves IPv4 bare", () => {
		expect(formatAddr({ address: "127.0.0.1", port: 443 })).toBe(
			"127.0.0.1:443",
		);
		expect(formatAddr({ address: "::1", port: 443 })).toBe("[::1]:443");
		expect(formatAddr({ address: "2001:db8::1", port: 5000 })).toBe(
			"[2001:db8::1]:5000",
		);
	});
});

describe("cert pinning (serverCertificateHashes model)", () => {
	test.skipIf(!wasmAvailable)(
		"correct hash connects; wrong hash rejects",
		async () => {
			const srv = await startEchoServer(0);
			let udpOk: BunUdpTransport | undefined;
			let ok: Awaited<ReturnType<typeof connectWasm>> | undefined;
			try {
				// Correct pin: session establishes and echoes.
				udpOk = await BunUdpTransport.connect("127.0.0.1", srv.port);
				ok = await connectWasm(
					wasm,
					udpOk,
					"localhost",
					"127.0.0.1:0",
					`127.0.0.1:${srv.port}`,
					{ certHashBase64: srv.certHashBase64 },
				);
				const got = new Promise<string>((res) =>
					ok?.session.onDatagram((d) => res(dec.decode(d))),
				);
				ok.session.sendDatagram(enc.encode("pinned-ok"));
				expect(await got).toBe("pinned-ok");
			} finally {
				ok?.manager.close();
				udpOk?.close();
				srv.manager.close();
				srv.udp.close();
			}

			// Use a fresh server endpoint for the negative handshake. Reusing the
			// just-closed connected UDP socket can surface a stale ECONNREFUSED on
			// hosted runners before the wrong-pin TLS path is exercised.
			const wrongSrv = await startEchoServer(0);
			let udpBad: BunUdpTransport | undefined;
			try {
				const wrongHash = btoa(String.fromCharCode(...new Uint8Array(32)));
				udpBad = await BunUdpTransport.connect("127.0.0.1", wrongSrv.port);
				const rejected = await connectWasm(
					wasm,
					udpBad,
					"localhost",
					"127.0.0.1:0",
					`127.0.0.1:${wrongSrv.port}`,
					{ certHashBase64: wrongHash },
				).then(
					() => null,
					(error: unknown) => error,
				);
				expect((rejected as { code?: string }).code).toBe(E_TLS);
				expect(String(rejected)).toContain(
					"E_TLS: handshake failed with TLS alert",
				);
			} finally {
				udpBad?.close();
				wrongSrv.manager.close();
				wrongSrv.udp.close();
			}
		},
		30_000,
	);
});

describe("connection lifecycle", () => {
	test.skipIf(!wasmAvailable)(
		"ready rejects when the server is unreachable",
		async () => {
			// Keep a real UDP socket bound but deliberately do not speak QUIC.
			// Connecting to an unbound port lets some hosts surface ICMP
			// ECONNREFUSED directly from recv(), which bypasses the endpoint's
			// handshake deadline and makes this test platform-dependent.
			const sink = await BunUdpTransport.bind("127.0.0.1", 0);
			sink.onPacket(() => {});
			const port = sink.localPort;
			if (port == null || port === 0) {
				sink.close();
				throw new Error("UDP sink did not report an ephemeral port");
			}
			const udp = await BunUdpTransport.connect("127.0.0.1", port);
			const t0 = Date.now();
			await expect(
				connectWasm(
					wasm,
					udp,
					"localhost",
					"127.0.0.1:0",
					`127.0.0.1:${port}`,
					{
						limits: { handshakeTimeoutMs: 50, idleTimeoutMs: 100 },
					},
				),
			).rejects.toThrow(/E_HANDSHAKE_TIMEOUT/);
			// The configured handshake deadline bounds an unreachable peer.
			expect(Date.now() - t0).toBeLessThan(1_000);
			udp.close();
			sink.close();
		},
		30_000,
	);

	test.skipIf(!wasmAvailable)(
		"closing one server session leaves the other client connected",
		async () => {
			const PORT = 47851;
			const srv = await startEchoServer(PORT);

			const udpA = await BunUdpTransport.connect("127.0.0.1", PORT);
			const a = await connectWasm(
				wasm,
				udpA,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
				{ certHashBase64: srv.certHashBase64 },
			);
			const udpB = await BunUdpTransport.connect("127.0.0.1", PORT);
			const b = await connectWasm(
				wasm,
				udpB,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
				{ certHashBase64: srv.certHashBase64 },
			);
			expect(srv.sessions.length).toBe(2);

			// Server closes A's session with an application code; the
			// WT_CLOSE_SESSION capsule carries both code and reason to A
			// promptly (not after a 10s idle timeout).
			const t0 = Date.now();
			srv.sessions[0]?.close({ code: 42, reason: "kick" });
			const aClosed = await a.session.closed;
			expect(aClosed.code).toBe(42);
			expect(aClosed.reason).toBe("kick");
			expect(Date.now() - t0).toBeLessThan(5_000);

			// B keeps working on the same endpoint.
			const echoed = new Promise<string>((res) =>
				b.session.onDatagram((d) => res(dec.decode(d))),
			);
			b.session.sendDatagram(enc.encode("b-alive"));
			expect(await echoed).toBe("b-alive");

			a.manager.close();
			b.manager.close();
			udpA.close();
			udpB.close();
			srv.manager.close();
			srv.udp.close();
		},
		30_000,
	);

	test.skipIf(!wasmAvailable)(
		"a server drain resolves the client's draining without closing it",
		async () => {
			const PORT = 47852;
			const srv = await startEchoServer(PORT);
			const udp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const c = await connectWasm(
				wasm,
				udp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
				{ certHashBase64: srv.certHashBase64 },
			);

			expect(srv.sessions[0]?.drain()).toBe(true);
			await c.session.draining;

			// Draining is advisory: the session still works afterwards.
			const echoed = new Promise<string>((res) =>
				c.session.onDatagram((d) => res(dec.decode(d))),
			);
			c.session.sendDatagram(enc.encode("still-here"));
			expect(await echoed).toBe("still-here");

			c.manager.close();
			udp.close();
			srv.manager.close();
			srv.udp.close();
		},
		30_000,
	);

	test.skipIf(!wasmAvailable)(
		"draining still resolves on a local close when the peer never drains",
		async () => {
			const PORT = 47853;
			const srv = await startEchoServer(PORT);
			const udp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const c = await connectWasm(
				wasm,
				udp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
				{ certHashBase64: srv.certHashBase64 },
			);

			c.session.close({ code: 7, reason: "local" });
			await c.session.draining;

			c.manager.close();
			udp.close();
			srv.manager.close();
			srv.udp.close();
		},
		30_000,
	);
});
