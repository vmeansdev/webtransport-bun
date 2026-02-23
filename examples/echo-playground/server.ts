import { createServer } from "../../packages/webtransport/src/index.js";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HTTP_HOST = process.env.HTTP_HOST ?? "127.0.0.1";
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 3000);
const WT_HOST = "0.0.0.0";
const WT_PORT = Number(process.env.WT_PORT ?? 4433);

const certPemPath = resolve(import.meta.dir, "./certs/cert.pem");
const keyPemPath = resolve(import.meta.dir, "./certs/key.pem");

let certPem = "";
let keyPem = "";
let certHashBase64 = "";

try {
  certPem = readFileSync(certPemPath, "utf8");
  keyPem = readFileSync(keyPemPath, "utf8");
  const cert = new X509Certificate(certPem);
  certHashBase64 = createHash("sha256").update(cert.raw).digest("base64");
} catch {
  console.error("Missing certs for WebTransport example.");
  console.error("Run: bun run example:echo:cert");
  process.exit(1);
}

function toBuffer(chunks: Uint8Array[]): Buffer {
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

const wtServer = createServer({
  host: WT_HOST,
  port: WT_PORT,
  tls: { certPem, keyPem },
  onSession: async (session) => {
    console.log(`[wt] session accepted id=${session.id} peer=${session.peer.ip}:${session.peer.port}`);

    void (async () => {
      try {
        for await (const dgram of session.incomingDatagrams()) {
          await session.sendDatagram(dgram);
        }
      } catch (err) {
        console.warn("[wt] datagram loop ended:", err);
      }
    })();

    void (async () => {
      try {
        for await (const duplex of session.incomingBidirectionalStreams()) {
          void (async () => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of duplex) chunks.push(chunk);
            if (chunks.length > 0) {
              duplex.write(toBuffer(chunks));
            }
            duplex.end();
          })().catch((err) => console.warn("[wt] bidi stream failed:", err));
        }
      } catch (err) {
        console.warn("[wt] incoming bidi loop ended:", err);
      }
    })();

    void (async () => {
      try {
        for await (const readable of session.incomingUnidirectionalStreams()) {
          void (async () => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of readable) chunks.push(chunk);
            const out = await session.createUnidirectionalStream();
            if (chunks.length > 0) {
              out.write(toBuffer(chunks));
            }
            out.end();
          })().catch((err) => console.warn("[wt] uni stream failed:", err));
        }
      } catch (err) {
        console.warn("[wt] incoming uni loop ended:", err);
      }
    })();
  },
});

const httpServer = Bun.serve({
  hostname: HTTP_HOST,
  port: HTTP_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(Bun.file(resolve(import.meta.dir, "./public/index.html")), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, httpPort: HTTP_PORT, wtPort: WT_PORT });
    }
    if (url.pathname === "/config") {
      return Response.json({
        wtUrl: `https://127.0.0.1:${WT_PORT}`,
        serverCertificateHashBase64: certHashBase64,
      });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`HTTP UI: http://${HTTP_HOST}:${HTTP_PORT}`);
console.log(`WebTransport endpoint: https://127.0.0.1:${WT_PORT}`);
console.log("Press Ctrl+C to stop.");

const shutdown = async () => {
  console.log("Shutting down...");
  httpServer.stop(true);
  await wtServer.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
