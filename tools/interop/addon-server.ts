#!/usr/bin/env bun
/**
 * Addon WebTransport server for Playwright interop.
 * Echoes datagrams and streams. Starts HTTP health on 4434 for readiness probing.
 */

import { createServer } from "../../packages/webtransport/src/index.ts";
import { createServer as createHttpServer } from "node:http";

const QUIC_PORT = 4433;
const HEALTH_PORT = 4434;

const wtServer = createServer({
    port: QUIC_PORT,
    tls: { certPem: "", keyPem: "" },
    onSession: async (session) => {
        for await (const d of session.incomingDatagrams()) {
            await session.sendDatagram(d);
        }
    },
});

const healthServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Length": 0, Connection: "close" });
    res.end();
});

healthServer.listen(HEALTH_PORT, "127.0.0.1", () => {
    console.log(`addon-server: Health on http://127.0.0.1:${HEALTH_PORT}`);
});

console.log(`addon-server: WebTransport on https://127.0.0.1:${QUIC_PORT}`);

process.on("SIGINT", async () => {
    healthServer.close();
    await wtServer.close();
    process.exit(0);
});
