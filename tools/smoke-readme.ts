/**
 * Smoke test: run README/GETTING_STARTED snippets to verify API surface.
 * Uses empty TLS certs (dev-only, matches test suite).
 */
import { createServer, connect, WebTransport } from "../packages/webtransport/src/index.ts";

const PORT = 19555;

async function main() {
  // 1) Server (README step 2 - use empty certs for dev smoke)
  const server = createServer({
    host: "0.0.0.0",
    port: PORT,
    tls: { certPem: "", keyPem: "" },
    onSession: async (session) => {
      for await (const d of session.incomingDatagrams()) {
        await session.sendDatagram(d);
      }
    },
  });
  console.log("Server listening:", server.address);

  await new Promise((r) => setTimeout(r, 500));

  // 2) Node client (README step 3)
  const session = await connect(`https://127.0.0.1:${PORT}`, {
    tls: { insecureSkipVerify: true },
  });
  await session.sendDatagram(new Uint8Array([1, 2, 3]));
  const iter = session.incomingDatagrams()[Symbol.asyncIterator]();
  const { value } = await iter.next();
  console.log("Node client echo:", value);
  session.close();

  await new Promise((r) => setTimeout(r, 200));

  // 3) W3C-like client (README step 4)
  const wt = new WebTransport(`https://127.0.0.1:${PORT}`, {
    tls: { insecureSkipVerify: true },
  });
  await wt.ready;
  const writer = wt.datagrams.writable.getWriter();
  await writer.write(new Uint8Array([4, 5, 6]));
  writer.releaseLock();
  const reader = wt.datagrams.readable.getReader();
  const { value: v2 } = await reader.read();
  console.log("W3C facade echo:", v2);
  reader.releaseLock();
  wt.close({ closeCode: 1000, reason: "done" });
  await wt.closed;

  await server.close();
  console.log("Smoke OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
