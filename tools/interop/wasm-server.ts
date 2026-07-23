#!/usr/bin/env bun
/**
 * WASM WebTransport server for Playwright interop against a real Chromium client.
 * Drives the Rust quinn-proto wasm endpoint over real localhost UDP via Bun.
 * Echoes datagrams and streams; exposes the dynamic cert hash over a health server.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveOverUdp } from "../../packages/webtransport/src/backend.ts";
import type { WasmModule } from "../../packages/webtransport/src/backend-wasm.ts";
import { BunUdpTransport } from "../../packages/webtransport/src/bun-udp.ts";

const QUIC_PORT = 4435;
const HEALTH_PORT = 4436;

const pkgPath = fileURLToPath(
	new URL("../../crates/wasm/pkg/webtransport_wasm.js", import.meta.url),
);
if (!existsSync(pkgPath)) {
	console.error(
		`wasm-server: wasm pkg missing at ${pkgPath}; run 'bun run build:wasm' from repo root`,
	);
	process.exit(1);
}
const wasm = (await import(pkgPath)) as unknown as WasmModule;

const { manager, certHashBase64 } = await serveOverUdp(
	wasm,
	BunUdpTransport.bind,
	{
		localAddress: "127.0.0.1",
		localPort: QUIC_PORT,
		commonName: "localhost",
		validityDays: 14,
		onSession: (session) => {
			// Datagram echo
			session.onDatagram((d) => session.sendDatagram(d));
			// Stream echo
			session.onIncomingStream((stream) => {
				if (stream.bidi) {
					// Echo received data back on the same bidi stream. writeAll
					// waits out closed flow-control windows (bare write() may
					// accept only part of a chunk); serialize so chunks don't
					// interleave. FIN the echo when the peer FINs, or a client
					// reading to completion hangs forever.
					let queue = Promise.resolve();
					stream.onData((data, fin) => {
						queue = queue
							.then(async () => {
								if (data.length > 0) await stream.writeAll(data);
								if (fin) stream.finish();
							})
							.catch(() => {});
					});
				} else {
					// Uni: collect inbound, then echo back on a NEW uni stream.
					const chunks: Uint8Array[] = [];
					stream.onData((data, fin) => {
						if (data.length > 0) chunks.push(data.slice());
						if (fin) {
							const total = chunks.reduce((n, c) => n + c.length, 0);
							const buf = new Uint8Array(total);
							let off = 0;
							for (const c of chunks) {
								buf.set(c, off);
								off += c.length;
							}
							const out = session.createUnidirectionalStream();
							(buf.length > 0 ? out.writeAll(buf) : Promise.resolve())
								.then(() => out.finish())
								.catch(() => {});
						}
					});
				}
			});
		},
	},
);

const healthServer = Bun.serve({
	hostname: "127.0.0.1",
	port: HEALTH_PORT,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/execution-identity") {
			return Response.json(
				{ executionIdentity: "wasm-under-bun" },
				{ headers: { "Cache-Control": "no-store" } },
			);
		}
		if (url.pathname === "/cert-hash") {
			return new Response(
				JSON.stringify({
					hashBase64: certHashBase64,
					executionIdentity: "wasm-under-bun",
				}),
				{
					headers: {
						"Content-Type": "application/json; charset=utf-8",
						"Cache-Control": "no-store",
					},
				},
			);
		}
		return new Response(null, { status: 200 });
	},
});
console.log(`wasm-server: Health on http://127.0.0.1:${HEALTH_PORT}`);

console.log(`wasm-server: WebTransport on https://127.0.0.1:${QUIC_PORT}`);
console.log(`wasm-server: certHashBase64=${certHashBase64}`);

process.on("SIGINT", () => {
	healthServer.stop();
	manager.close();
	process.exit(0);
});
