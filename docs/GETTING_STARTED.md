# Getting started

## Minimal server example

Generate a development certificate first (any PEM pair works; this one is
valid for `localhost`, `127.0.0.1` and `::1` for 14 days):

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 14 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
  -keyout key.pem -out cert.pem
```

An echo server for datagrams and bidirectional streams, which the client
examples below talk to:

```ts
import { createServer } from "@webtransport-bun/webtransport";
import * as fs from "node:fs";

const certPem = fs.readFileSync("cert.pem", "utf-8");
const keyPem = fs.readFileSync("key.pem", "utf-8");

const server = createServer({
  port: 4433, // binds 0.0.0.0; pass host: "::" to accept IPv6 clients too
  tls: { certPem, keyPem },
  onSession: async (session) => {
    console.log("Session connected:", session.id, session.peer);
    void (async () => {
      for await (const { readable, writable } of session.incomingBidirectionalStreams) {
        void readable.pipeTo(writable).catch(() => {}); // echo each bidi stream back
      }
    })();
    for await (const d of session.incomingDatagrams()) {
      await session.sendDatagram(d);
    }
  },
});

console.log("Server listening on port", server.address.port);
// server.close() when shutting down
```

## Runtime certificate rotation

```ts
await server.updateCert({
  certPem: fs.readFileSync("next-cert.pem", "utf-8"),
  keyPem: fs.readFileSync("next-key.pem", "utf-8"),
});
```

`updateCert()` hot-swaps only the TLS leaf certificate/key material. Existing sessions remain connected, and new handshakes use the new certificate immediately. Changes to bind address or transport configuration still require rebuilding or restarting the server.

## Multi-host TLS with SNI

```ts
await server.updateTls({
  certPem: fs.readFileSync("default-cert.pem", "utf-8"),
  keyPem: fs.readFileSync("default-key.pem", "utf-8"),
  sni: [
    {
      serverName: "api.example.test",
      certPem: fs.readFileSync("api-cert.pem", "utf-8"),
      keyPem: fs.readFileSync("api-key.pem", "utf-8"),
    },
  ],
  unknownSniPolicy: "reject",
});
```

`updateTls()` atomically replaces the default cert/key, the full SNI cert map, and the unknown-SNI policy without dropping existing sessions. By default, unknown SNI names are rejected when SNI certs are configured; clients that send no SNI still receive the default certificate. Changes to bind address or transport configuration still require rebuilding or restarting the server.

## Incremental SNI management

```ts
await server.upsertSniCert({
  serverName: "api.example.test",
  certPem: fs.readFileSync("api-cert.pem", "utf-8"),
  keyPem: fs.readFileSync("api-key.pem", "utf-8"),
});

await server.setUnknownSniPolicy("default");
await server.removeSniCert("api.example.test");

console.log(server.tlsSnapshot());
```

Use `replaceSniCerts()` when you want to swap the full hostname map while preserving the default certificate and current unknown-SNI policy.

`tlsSnapshot()` returns canonical ASCII hostnames. If you configure Unicode SNI names, review them for homograph/confusable risk before deployment.

## Requirements

- Bun >= 1.3.14, or Node, or Deno
- TLS certificate and key (PEM format)
- UDP port open (default 4433)

## Client

```ts
import { connect } from "@webtransport-bun/webtransport";
import { once } from "node:events";

// Dial 127.0.0.1 rather than localhost: localhost may resolve to ::1 first,
// which a server bound to the default 0.0.0.0 does not listen on.
const session = await connect("https://127.0.0.1:4433", {
  tls: { insecureSkipVerify: true }, // dev only — use valid certs in production
});

// Send a datagram
await session.sendDatagram(new Uint8Array([1, 2, 3]));

// Open a bidi stream and wait for the echo before closing
const stream = await session.createBidirectionalStream();
stream.write(Buffer.from("hello"));
const [chunk] = await once(stream, "data");
console.log("received:", chunk.toString());

session.close();
```

## WASM backend (server in the browser, or native-free hosts)

The `/wasm` subpath runs the whole stack as WebAssembly — no `.node` addon.
Read `docs/COMPATIBILITY.md` § "WASM backend" first: the in-browser *server*
only works in a Chromium Isolated Web App (Direct Sockets), and pinned certs
live at most 14 days.

```ts
import {
  loadWasmModule,
  serveOverUdp,
  DirectSocketsUdpTransport,
} from "@webtransport-bun/webtransport/wasm";

const wasm = await loadWasmModule(); // prebuilt wasm shipped in the package

// DirectSocketsUdpTransport.bind works inside a Chromium IWA;
// elsewhere pass your own bind factory (Bun example below).
const { manager, certHashBase64 } = await serveOverUdp(
  wasm,
  DirectSocketsUdpTransport.bind,
  {
    localPort: 4433,
    onSession: (session) => session.onDatagram((d) => session.sendDatagram(d)),
  },
);

// Give certHashBase64 to clients — they pin it:
// new WebTransport("https://host:4433", { serverCertificateHashes: [
//   { algorithm: "sha-256", value: base64ToArrayBuffer(certHashBase64) },
// ]})
```

Outside an IWA, give `serveOverUdp` a factory that returns a `UdpTransport`.
Under Bun:

```ts
import type { UdpTransport } from "@webtransport-bun/webtransport/wasm";

async function bunUdpBind(localAddress: string, localPort: number): Promise<UdpTransport> {
  let onPacket: ((data: Uint8Array, src: { address: string; port: number }) => void) | undefined;
  const socket = await Bun.udpSocket({
    hostname: localAddress || "0.0.0.0",
    port: localPort,
    socket: {
      data(_s, buf, port, address) {
        onPacket?.(new Uint8Array(buf), { address, port });
      },
    },
  });
  return {
    localPort: socket.port,
    send: (data, dest) => void socket.send(data, dest.port, dest.address),
    onPacket: (fn) => { onPacket = fn; },
    close: () => socket.close(),
  };
}

// serveOverUdp(wasm, bunUdpBind, { localAddress: "127.0.0.1", localPort: 4433, onSession })
```

What you must handle yourself:

- **Packet pumping and timers** — the core is sans-IO. The shipped adapters
  (`DirectSocketsUdpTransport`, Bun UDP, `InMemoryRelay`) do this for you; a
  custom transport must implement `UdpTransport` and honor the timeout hints.
- **Cert rotation** — regenerate before the ≤ 14-day window closes and get the
  new hash to your clients. Unlike the native server's `updateCert()`,
  re-pinning is a client-side change: plan the distribution channel.
- **IWA install** — flags, signing, and dev-mode install are documented in
  `examples/webtransport-wasm-iwa/README.md`.

## Client (W3C-like facade)

```ts
import { WebTransport } from "@webtransport-bun/webtransport";

const wt = new WebTransport("https://127.0.0.1:4433", {
  tls: { insecureSkipVerify: true }, // dev only — use valid certs in production
});

await wt.ready;

const writer = wt.datagrams.writable.getWriter();
await writer.write(new Uint8Array([1, 2, 3]));
writer.releaseLock();

const reader = wt.datagrams.readable.getReader();
const { value } = await reader.read();
console.log("received datagram:", value);
reader.releaseLock();

wt.close({ closeCode: 1000, reason: "done" });
await wt.closed;
```
