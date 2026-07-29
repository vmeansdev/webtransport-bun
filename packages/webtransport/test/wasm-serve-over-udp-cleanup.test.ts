import { describe, expect, test } from "bun:test";
import { serveOverUdp } from "../src/backend.js";
import type { WasmModule } from "../src/backend-wasm.js";
import type { UdpTransport } from "../src/wasm-relay.js";

// serveOverUdp creates a wasm-side endpoint, then adopts it into a manager.
// Between those two steps the endpoint is owned by nobody, so a failure there
// must free it explicitly or the eid leaks for the process lifetime.
describe("serveOverUdp endpoint cleanup", () => {
	function fakeWasm(closed: number[]): WasmModule {
		return {
			wt_new_server_with_options: () =>
				JSON.stringify({ eid: 77, hashBase64: "aGFzaA==" }),
			wt_close_endpoint: (eid: number) => {
				closed.push(eid);
			},
		} as unknown as WasmModule;
	}

	function transportFailingToWire(): UdpTransport {
		return {
			localPort: 4433,
			send() {},
			onPacket() {
				// WasmEndpoint wires its receive callback here, so this is the
				// first thing to run after the endpoint exists wasm-side.
				throw new Error("transport wiring failed");
			},
			close() {
				closedTransport = true;
			},
		};
	}
	let closedTransport = false;

	test("frees the wasm endpoint when adoption fails", async () => {
		closedTransport = false;
		const closed: number[] = [];
		await expect(
			serveOverUdp(fakeWasm(closed), async () => transportFailingToWire(), {
				localAddress: "127.0.0.1",
				localPort: 4433,
				onSession: () => {},
			}),
		).rejects.toThrow("transport wiring failed");

		// The endpoint that wt_new_server_with_options handed back must be freed.
		expect(closed).toEqual([77]);
		expect(closedTransport).toBe(true);
	});

	test("does not free the endpoint when startup succeeds", async () => {
		const closed: number[] = [];
		const transport: UdpTransport = {
			localPort: 4433,
			send() {},
			onPacket() {},
			close() {},
		};
		const started = await serveOverUdp(
			fakeWasm(closed),
			async () => transport,
			{
				localAddress: "127.0.0.1",
				localPort: 4433,
				onSession: () => {},
			},
		);
		// Ownership transferred to the manager; serveOverUdp must not free it.
		expect(closed).toEqual([]);
		expect(started.localPort).toBe(4433);
	});
});
