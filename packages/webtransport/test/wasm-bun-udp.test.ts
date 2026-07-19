import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { connectWasm, createWasmServer } from "../src/backend.js";
import type { WasmModule } from "../src/backend-wasm.js";
import { BunUdpTransport } from "../src/bun-udp.js";

const pkgPath = fileURLToPath(
	new URL("../../../crates/wasm/pkg/webtransport_wasm.js", import.meta.url),
);
const wasmAvailable = existsSync(pkgPath);
const wasm = wasmAvailable
	? ((await import(pkgPath)) as unknown as WasmModule)
	: (null as unknown as WasmModule);

describe("wasm backend over real Bun UDP (P5)", () => {
	test.skipIf(!wasmAvailable)(
		"wasm server <-> wasm client over localhost UDP: datagram + bidi echo",
		async () => {
			const PORT = 47833;
			const serverUdp = await BunUdpTransport.bind("127.0.0.1", PORT);
			const server = createWasmServer(
				wasm,
				serverUdp,
				(session) => {
					session.onDatagram((d) => session.sendDatagram(d));
					session.onIncomingStream((stream) => {
						stream.onData((data) => {
							if (data.length > 0) stream.write(data);
						});
					});
				},
				`127.0.0.1:${PORT}`,
				"127.0.0.1:0",
			);

			const clientUdp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const { session, manager } = await connectWasm(
				wasm,
				clientUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
			);

			let dgram: Uint8Array | null = null;
			session.onDatagram((d) => {
				dgram = d.slice();
			});
			session.sendDatagram(new TextEncoder().encode("udp-dg"));

			let dl = Date.now() + 5000;
			while (dgram === null && Date.now() < dl) await Bun.sleep(10);
			expect(dgram).not.toBeNull();
			expect(new TextDecoder().decode(dgram as unknown as Uint8Array)).toBe(
				"udp-dg",
			);

			const stream = session.createBidirectionalStream();
			let echo: Uint8Array | null = null;
			stream.onData((data) => {
				if (data.length > 0) echo = data.slice();
			});
			stream.write(new TextEncoder().encode("udp-stream"));

			dl = Date.now() + 5000;
			while (echo === null && Date.now() < dl) await Bun.sleep(10);
			expect(echo).not.toBeNull();
			expect(new TextDecoder().decode(echo as unknown as Uint8Array)).toBe(
				"udp-stream",
			);

			manager.close();
			server.close();
			clientUdp.close();
			serverUdp.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"two clients <-> one server over localhost UDP: datagram isolation",
		async () => {
			const PORT = 47834;
			const serverUdp = await BunUdpTransport.bind("127.0.0.1", PORT);
			const server = createWasmServer(
				wasm,
				serverUdp,
				(session) => {
					session.onDatagram((d) => session.sendDatagram(d)); // echo to origin
				},
				`127.0.0.1:${PORT}`,
				"127.0.0.1:0",
			);

			const clientAUdp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const clientBUdp = await BunUdpTransport.connect("127.0.0.1", PORT);
			const { session: a, manager: aMgr } = await connectWasm(
				wasm,
				clientAUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
			);
			const { session: b, manager: bMgr } = await connectWasm(
				wasm,
				clientBUdp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${PORT}`,
			);

			let aEcho: Uint8Array | null = null;
			let bEcho: Uint8Array | null = null;
			a.onDatagram((d) => {
				aEcho = d.slice();
			});
			b.onDatagram((d) => {
				bEcho = d.slice();
			});
			a.sendDatagram(new TextEncoder().encode("alpha-payload"));
			b.sendDatagram(new TextEncoder().encode("bravo-payload"));

			const dl = Date.now() + 5000;
			while ((aEcho === null || bEcho === null) && Date.now() < dl)
				await Bun.sleep(10);

			const dec = new TextDecoder();
			expect(aEcho).not.toBeNull();
			expect(bEcho).not.toBeNull();
			expect(dec.decode(aEcho as unknown as Uint8Array)).toBe("alpha-payload");
			expect(dec.decode(bEcho as unknown as Uint8Array)).toBe("bravo-payload");
			// Isolation: each client only ever saw its own payload.
			expect(dec.decode(aEcho as unknown as Uint8Array)).not.toBe(
				"bravo-payload",
			);
			expect(dec.decode(bEcho as unknown as Uint8Array)).not.toBe(
				"alpha-payload",
			);

			aMgr.close();
			bMgr.close();
			server.close();
			clientAUdp.close();
			clientBUdp.close();
			serverUdp.close();
		},
	);
});
