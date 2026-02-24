#!/usr/bin/env bun
/**
 * Addon WebTransport server for Playwright interop.
 * Echoes datagrams and streams. Uses tools/interop/certs/ when present (ECDSA for Chromium).
 */

import { createServer } from "../../packages/webtransport/src/index.ts";
import { createServer as createHttpServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const QUIC_PORT = 4433;
const HEALTH_PORT = 4434;
const IDLE_TIMEOUT_MS = Number(process.env.WT_IDLE_TIMEOUT_MS ?? "60000");
const CLOSE_SIGNAL = "__WT_CLOSE_4001__";

const certPath = join(import.meta.dir, "certs", "cert.pem");
const keyPath = join(import.meta.dir, "certs", "key.pem");
const certPem = existsSync(certPath) ? readFileSync(certPath, "utf-8") : "";
const keyPem = existsSync(keyPath) ? readFileSync(keyPath, "utf-8") : "";
if (!certPem || !keyPem) {
	console.warn(
		"addon-server: no ECDSA certs at",
		certPath,
		"; run 'bun run prepare:interop' for Chromium interop",
	);
}

const wtServer = createServer({
	port: QUIC_PORT,
	tls: { certPem, keyPem },
	limits: { idleTimeoutMs: IDLE_TIMEOUT_MS },
	onSession: async (session) => {
		// Datagram echo
		(async () => {
			const decoder = new TextDecoder();
			for await (const d of session.incomingDatagrams()) {
				const text = decoder.decode(d);
				if (text === CLOSE_SIGNAL) {
					session.close({ code: 4001, reason: "interop-close" });
					continue;
				}
				await session.sendDatagram(d);
			}
		})().catch(() => {});
		// Bidi stream echo
		(async () => {
			for await (const duplex of session.incomingBidirectionalStreams) {
				(async () => {
					const chunks: Uint8Array[] = [];
					for await (const c of duplex.readable) chunks.push(c);
					const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
					const writer = duplex.writable.getWriter();
					if (buf.length > 0) await writer.write(buf);
					await writer.close();
				})().catch(() => {});
			}
		})().catch(() => {});
		// Uni stream echo: read incoming, write back on new uni stream
		(async () => {
			for await (const readable of session.incomingUnidirectionalStreams) {
				(async () => {
					const chunks: Buffer[] = [];
					for await (const c of readable) chunks.push(c);
					const buf = Buffer.concat(chunks);
					if (buf.length > 0) {
						const writable = await session.createUnidirectionalStream();
						writable.write(buf);
						writable.end();
					}
				})().catch(() => {});
			}
		})().catch(() => {});
	},
});

const healthServer = createHttpServer((_req, res) => {
	res.writeHead(200, { "Content-Length": 0, Connection: "close" });
	res.end();
});

healthServer.listen(HEALTH_PORT, "127.0.0.1", () => {
	console.log(`addon-server: Health on http://127.0.0.1:${HEALTH_PORT}`);
});

console.log(
	`addon-server: WebTransport on https://127.0.0.1:${QUIC_PORT} (idleTimeoutMs=${IDLE_TIMEOUT_MS})`,
);

process.on("SIGINT", async () => {
	healthServer.close();
	await wtServer.close();
	process.exit(0);
});
