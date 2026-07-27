import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	createUnifiedClient,
	createWasmServer,
	isWasmRuntime,
	selectBackend,
	type WasmStream,
	WasmWebTransport,
} from "../src/backend.js";
import type { WasmModule } from "../src/backend-wasm.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";
import { withTimeout } from "./helpers/harness.js";

// Soft-skip when pkg is absent (local `bun test packages/`). With
// WEBTRANSPORT_REQUIRE_WASM=1 the helper throws at import time instead.
const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

describe("wasm backend facade (P3)", () => {
	test("backend selection defaults to native without UDPSocket", () => {
		// Bun test env has no UDPSocket global.
		expect(isWasmRuntime()).toBe(false);
		expect(selectBackend()).toBe("native");
	});

	test.skipIf(!wasmAvailable)(
		"facade: session + datagram + bidi echo end-to-end",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4433 };
			const clientAddr = { address: "127.0.0.1", port: 5544 };

			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				(session) => {
					session.onDatagram((d) => session.sendDatagram(d)); // echo datagrams
					session.onIncomingStream((stream: WasmStream) => {
						stream.onData((data, _fin) => {
							if (data.length > 0) stream.write(data); // echo stream data
						});
					});
				},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
			);

			const { session: client, manager: clientMgr } = await connectWasm(
				wasm,
				relay.endpoint(clientAddr),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
			);

			// Datagram round-trip via the facade.
			let dgram: Uint8Array | null = null;
			client.onDatagram((d) => {
				dgram = d.slice();
			});
			client.sendDatagram(new TextEncoder().encode("dg"));

			let dl = Date.now() + 3000;
			while (dgram === null && Date.now() < dl) await Bun.sleep(5);
			expect(dgram).not.toBeNull();
			expect(new TextDecoder().decode(dgram as unknown as Uint8Array)).toBe(
				"dg",
			);

			// Bidi stream round-trip via the facade.
			const stream = client.createBidirectionalStream();
			let echo: Uint8Array | null = null;
			stream.onData((data) => {
				if (data.length > 0) echo = data.slice();
			});
			stream.write(new TextEncoder().encode("stream-hi"));

			dl = Date.now() + 3000;
			while (echo === null && Date.now() < dl) await Bun.sleep(5);
			expect(echo).not.toBeNull();
			expect(new TextDecoder().decode(echo as unknown as Uint8Array)).toBe(
				"stream-hi",
			);

			clientMgr.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"facade session-map: two WasmWebTransport sessions isolate datagrams; over-cap fails",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4433 };
			const clientAddr = { address: "127.0.0.1", port: 5544 };

			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				(session) => {
					session.onDatagram((d) => {
						void session.sendDatagram(d);
					});
				},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				{ wtMaxSessions: 2 },
			);

			const { session: primarySession, manager: clientMgr } = await connectWasm(
				wasm,
				relay.endpoint(clientAddr),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
			);
			await withTimeout(primarySession.ready, 5000, "primarySession.ready");

			const secondarySession = await clientMgr.openSession(primarySession.conn);
			await withTimeout(secondarySession.ready, 5000, "secondarySession.ready");
			expect(primarySession.sessionId).not.toBe(secondarySession.sessionId);

			let primaryEcho: Uint8Array | null = null;
			let secondaryEcho: Uint8Array | null = null;
			primarySession.onDatagram((d) => {
				primaryEcho = d.slice();
			});
			secondarySession.onDatagram((d) => {
				secondaryEcho = d.slice();
			});

			await primarySession.sendDatagram(
				new TextEncoder().encode("facade-primary"),
			);
			await secondarySession.sendDatagram(
				new TextEncoder().encode("facade-secondary"),
			);

			const deadline = Date.now() + 3000;
			while (
				(primaryEcho === null || secondaryEcho === null) &&
				Date.now() < deadline
			) {
				await Bun.sleep(5);
			}
			expect(new TextDecoder().decode(primaryEcho!)).toBe("facade-primary");
			expect(new TextDecoder().decode(secondaryEcho!)).toBe("facade-secondary");

			const primary = new WasmWebTransport(primarySession);
			const secondary = new WasmWebTransport(secondarySession);
			await withTimeout(
				Promise.all([primary.ready, secondary.ready]),
				5000,
				"facade.ready",
			);
			const stats = await primary.getStats();
			expect(stats.bytesSent).toBe(0);
			expect(stats.bytesReceived).toBe(0);

			await expect(clientMgr.openSession(primarySession.conn)).rejects.toThrow(
				/E_LIMIT_EXCEEDED/,
			);

			secondary.close();
			primary.close();
			clientMgr.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"createUnifiedClient passes 0-RTT/QPACK WasmClientArgs through",
		async () => {
			const relay = new InMemoryRelay();
			const server = createWasmServer(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 4433 }),
				() => {},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				{ enable0Rtt: true, enableDynamicQpack: true },
			);
			const { transport } = await createUnifiedClient({
				kind: "wasm",
				wasm,
				udp: relay.endpoint({ address: "127.0.0.1", port: 5544 }),
				authority: "localhost",
				addr: "127.0.0.1:5544",
				peerAddr: "127.0.0.1:4433",
				enable0Rtt: true,
				shareProcess0RttTicketStore: true,
				enableDynamicQpack: true,
			});
			await withTimeout(transport.ready, 5000, "unified.ready");
			transport.close();
			server.close();
		},
	);
});
