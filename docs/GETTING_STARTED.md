# Getting started

## Minimal server example

```ts
import { createServer } from "@webtransport-bun/webtransport";
import * as fs from "node:fs";

const certPem = fs.readFileSync("cert.pem", "utf-8");
const keyPem = fs.readFileSync("key.pem", "utf-8");

const server = createServer({
  port: 4433,
  tls: { certPem, keyPem },
  onSession: (session) => {
    console.log("Session connected:", session.id, session.peer);
  },
});

console.log("Server listening on port", server.address.port);
// server.close() when shutting down
```

## Requirements

- Bun >= 1.3.9
- TLS certificate and key (PEM format)
- UDP port open (default 4433)

## Client

```ts
import { connect } from "@webtransport-bun/webtransport";

const session = await connect("https://localhost:4433", {
  tls: { insecureSkipVerify: true }, // dev only — use valid certs in production
});

// Send a datagram
await session.sendDatagram(new Uint8Array([1, 2, 3]));

// Open a bidi stream
const stream = await session.createBidirectionalStream();
stream.write(Buffer.from("hello"));
stream.on("data", (chunk: Buffer) => console.log("received:", chunk));

// Clean up
session.close();
```

## Client (W3C-like facade)

```ts
import { WebTransport } from "@webtransport-bun/webtransport";

const wt = new WebTransport("https://localhost:4433", {
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
