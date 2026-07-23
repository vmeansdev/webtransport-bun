import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, test } from "bun:test";
import { connectWasm } from "../src/backend.js";
import type { WasmModule } from "../src/backend-wasm.js";
import { BunUdpTransport } from "../src/bun-udp.js";
import { generateCert, type WasmCertModule } from "../src/wasm-cert.js";
import { forEachWithTimeout } from "./helpers/harness.js";

// Cross-stack interop: our wasm WebTransport CLIENT against the native Rust
// (wtransport) SERVER over real localhost UDP. Exercises whether our hand-rolled
// minimal H3/WebTransport layer interoperates with a full H3 server.
//
// Skipped unless both the wasm bundle is built AND the native addon loads
// (run `bun run build:native` first). Live browser interop (wasm server <->
// Chrome native client) is documented in tools/interop/WASM_INTEROP.md.

const pkgPath = fileURLToPath(
	new URL("../../../crates/wasm/pkg/webtransport_wasm.js", import.meta.url),
);
const wasmAvailable = existsSync(pkgPath);

let wasm: WasmModule & WasmCertModule;
let createServer: typeof import("../src/index.js").createServer | null = null;

beforeAll(async () => {
	if (!wasmAvailable) return;
	wasm = (await import(pkgPath)) as unknown as WasmModule & WasmCertModule;
	try {
		const native = await import("../src/index.js");
		// Probe that the native addon actually loads in this environment.
		createServer = native.createServer;
	} catch {
		createServer = null;
	}
});

describe("wasm client <-> native server interop (P5)", () => {
	test.skipIf(!wasmAvailable)(
		"wasm client establishes a session and echoes a datagram against the native server",
		async () => {
			if (!createServer) {
				// Native addon unavailable: nothing to interop against here.
				return;
			}
			const PORT = 47844;
			const cert = generateCert(wasm, "localhost", 14);

			const server = createServer({
				host: "127.0.0.1",
				port: PORT,
				tls: { certPem: cert.certPem, keyPem: cert.keyPem },
				onSession: async (session) => {
					await forEachWithTimeout(
						session.incomingDatagrams(),
						5000,
						"wasm native interop server incoming datagram",
						async (d) => {
							await session.sendDatagram(d);
						},
					);
				},
			});

			try {
				const udp = await BunUdpTransport.connect("127.0.0.1", PORT);
				const { session, manager } = await connectWasm(
					wasm,
					udp,
					"localhost",
					"127.0.0.1:0",
					`127.0.0.1:${PORT}`,
				);

				let dgram: Uint8Array | null = null;
				session.onDatagram((d) => {
					dgram = d.slice();
				});
				session.sendDatagram(new TextEncoder().encode("interop"));

				const dl = Date.now() + 5000;
				while (dgram === null && Date.now() < dl) await Bun.sleep(10);

				expect(dgram).not.toBeNull();
				expect(new TextDecoder().decode(dgram as unknown as Uint8Array)).toBe(
					"interop",
				);

				manager.close();
				udp.close();
			} finally {
				await server.close?.();
			}
		},
	);
});
