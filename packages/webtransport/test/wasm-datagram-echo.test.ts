import { describe, expect, test } from "bun:test";
import { WasmEndpoint } from "../src/backend-wasm.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

// Soft-skip when pkg is absent (local `bun test packages/`). With
// WEBTRANSPORT_REQUIRE_WASM=1 the helper throws at import time instead.
const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

describe("wasm WebTransport backend (P1)", () => {
	test.skipIf(!wasmAvailable)(
		"establishes a session and echoes a datagram",
		async () => {
			const relay = new InMemoryRelay();

			let serverEstablished = false;
			const server = WasmEndpoint.create(
				wasm,
				relay.a,
				true,
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				{
					onEstablished: () => {
						serverEstablished = true;
					},
					onDatagram: (conn, data) => {
						server.sendDatagram(conn, data); // echo
					},
				},
			);

			let received: Uint8Array | null = null;
			let clientEstablished = false;
			const client = WasmEndpoint.create(
				wasm,
				relay.b,
				false,
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				{
					onEstablished: () => {
						clientEstablished = true;
					},
					onDatagram: (_conn, data) => {
						received = data.slice();
					},
				},
			);

			const conn = client.connect("localhost");

			const deadline = Date.now() + 3000;
			while (
				!(serverEstablished && clientEstablished) &&
				Date.now() < deadline
			) {
				await Bun.sleep(5);
			}
			expect(serverEstablished).toBe(true);
			expect(clientEstablished).toBe(true);

			client.sendDatagram(conn, new TextEncoder().encode("ping"));

			const echoDeadline = Date.now() + 3000;
			while (received === null && Date.now() < echoDeadline) {
				await Bun.sleep(5);
			}
			expect(received).not.toBeNull();
			expect(new TextDecoder().decode(received as unknown as Uint8Array)).toBe(
				"ping",
			);

			client.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"routes two clients through one server with datagram isolation",
		async () => {
			const relay = new InMemoryRelay();
			const sAddr = { address: "127.0.0.1", port: 443 };
			const aAddr = { address: "127.0.0.1", port: 1001 };
			const bAddr = { address: "127.0.0.1", port: 1002 };

			const server = WasmEndpoint.create(
				wasm,
				relay.endpoint(sAddr),
				true,
				"127.0.0.1:443",
				"127.0.0.1:1001",
				{
					onDatagram: (conn, data) => {
						server.sendDatagram(conn, data); // echo back to origin conn
					},
				},
			);

			let aEcho: Uint8Array | null = null;
			let bEcho: Uint8Array | null = null;
			let aEst = false;
			let bEst = false;
			const clientA = WasmEndpoint.create(
				wasm,
				relay.endpoint(aAddr),
				false,
				"127.0.0.1:1001",
				"127.0.0.1:443",
				{
					onEstablished: () => {
						aEst = true;
					},
					onDatagram: (_c, d) => {
						aEcho = d.slice();
					},
				},
			);
			const clientB = WasmEndpoint.create(
				wasm,
				relay.endpoint(bAddr),
				false,
				"127.0.0.1:1002",
				"127.0.0.1:443",
				{
					onEstablished: () => {
						bEst = true;
					},
					onDatagram: (_c, d) => {
						bEcho = d.slice();
					},
				},
			);

			const connA = clientA.connect("localhost");
			const connB = clientB.connect("localhost");

			let dl = Date.now() + 3000;
			while (!(aEst && bEst) && Date.now() < dl) await Bun.sleep(5);
			expect(aEst).toBe(true);
			expect(bEst).toBe(true);

			clientA.sendDatagram(connA, new TextEncoder().encode("alpha-payload"));
			clientB.sendDatagram(connB, new TextEncoder().encode("bravo-payload"));

			dl = Date.now() + 3000;
			while ((aEcho === null || bEcho === null) && Date.now() < dl)
				await Bun.sleep(5);

			const dec = new TextDecoder();
			expect(aEcho).not.toBeNull();
			expect(bEcho).not.toBeNull();
			expect(dec.decode(aEcho as unknown as Uint8Array)).toBe("alpha-payload");
			expect(dec.decode(bEcho as unknown as Uint8Array)).toBe("bravo-payload");
			// Isolation: neither client ever saw the other's payload.
			expect(dec.decode(aEcho as unknown as Uint8Array)).not.toBe(
				"bravo-payload",
			);
			expect(dec.decode(bEcho as unknown as Uint8Array)).not.toBe(
				"alpha-payload",
			);

			clientA.close();
			clientB.close();
			server.close();
		},
	);
});
