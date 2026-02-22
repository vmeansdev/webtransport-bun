#!/usr/bin/env bun
/**
 * Addon server with ONLY bidi echo (no datagrams, no uni) for debugging.
 */
import { createServer } from "../packages/webtransport/src/index.ts";
import { createServer as createHttpServer } from "node:http";

const server = createServer({
    port: 4433,
    tls: { certPem: "", keyPem: "" },
    onSession: async (s) => {
        (async () => {
            for await (const duplex of s.incomingBidirectionalStreams()) {
                (async () => {
                    const chunks: Buffer[] = [];
                    for await (const c of duplex) chunks.push(c);
                    const buf = Buffer.concat(chunks);
                    if (buf.length > 0) {
                        duplex.write(buf);
                        duplex.end();
                        console.log("[server] echoed", buf.length, "bytes");
                    }
                })().catch((e) => console.error("[server] bidi err", e));
            }
        })().catch(() => {});
    },
});

createHttpServer((_req, res) => {
    res.writeHead(200, { "Content-Length": 0, Connection: "close" });
    res.end();
}).listen(4434, "127.0.0.1");

console.log("addon-server-bidi-only: port 4433");
await new Promise(() => {});
