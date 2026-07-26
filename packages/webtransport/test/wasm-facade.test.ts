import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	createWasmServer,
	isWasmRuntime,
	selectBackend,
	type WasmStream,
} from "../src/backend.js";
import type { WasmModule } from "../src/backend-wasm.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

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
});
