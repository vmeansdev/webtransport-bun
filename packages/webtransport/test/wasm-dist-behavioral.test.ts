import { describe, expect, test } from "bun:test";
import { connectWasm, createWasmServer } from "../src/backend.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule } from "../src/wasm.js";
import { wasmDistAvailable } from "./helpers/wasm-dist-availability.js";

/**
 * Behavioral gate on the *shipped* wasm-dist artifact (not crates/wasm/pkg).
 * Structural provenance stays in scripts/test-package-artifact.ts
 * (assertProductionWasm). This suite proves the dist module actually runs.
 *
 * Soft-skip when dist is absent. WEBTRANSPORT_REQUIRE_WASM_DIST=1 fails at
 * import via wasm-dist-availability.ts.
 */
describe("wasm-dist behavioral (B3)", () => {
	test.skipIf(!wasmDistAvailable)(
		"production loadWasmModule() datagram echo over InMemoryRelay",
		async () => {
			const wasm = await loadWasmModule();
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4433 };
			const clientAddr = { address: "127.0.0.1", port: 5544 };

			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				(session) => {
					session.onDatagram((d) => session.sendDatagram(d));
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

			let dgram: Uint8Array | null = null;
			client.onDatagram((d) => {
				dgram = d.slice();
			});
			client.sendDatagram(new TextEncoder().encode("dist-ok"));

			const deadline = Date.now() + 3000;
			while (dgram === null && Date.now() < deadline) {
				await Bun.sleep(5);
			}
			expect(dgram).not.toBeNull();
			expect(new TextDecoder().decode(dgram as unknown as Uint8Array)).toBe(
				"dist-ok",
			);

			clientMgr.close();
			server.close();
		},
	);
});
