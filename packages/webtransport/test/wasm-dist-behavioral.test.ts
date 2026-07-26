import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	normalizeWasmEndpointOptions,
	WasmTransportManager,
} from "../src/backend.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule } from "../src/wasm.js";
import { wasmDistAvailable } from "./helpers/wasm-dist-availability.js";

/**
 * Behavioral gate on the *shipped* wasm-dist artifact (not crates/wasm/pkg).
 * Structural provenance stays in scripts/test-package-artifact.ts
 * (assertProductionWasm). This suite proves the dist module actually runs.
 *
 * Production dist builds omit AcceptAny, so the client must pin
 * `serverCertificateHashes` (certHashBase64) — the same trust model browsers use.
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
			const normalized = normalizeWasmEndpointOptions({});
			const notBeforeUnix = Math.floor(Date.now() / 1000) - 3600;

			const created = JSON.parse(
				wasm.wt_new_server_with_options(
					JSON.stringify({
						addr: "127.0.0.1:4433",
						peerAddr: "127.0.0.1:5544",
						commonName: "localhost",
						validityDays: 14,
						notBeforeUnix,
						...normalized,
					}),
				),
			) as { eid?: number; hashBase64?: string; error?: string };
			if (created.error || created.eid == null || created.hashBase64 == null) {
				throw new Error(`wt_new_server failed: ${created.error ?? "unknown"}`);
			}

			const server = WasmTransportManager.adopt(
				wasm,
				relay.endpoint(serverAddr),
				created.eid,
				(session) => {
					session.onDatagram((d) => session.sendDatagram(d));
				},
				normalized,
			);

			const { session: client, manager: clientMgr } = await connectWasm(
				wasm,
				relay.endpoint(clientAddr),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				{ certHashBase64: created.hashBase64 },
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
