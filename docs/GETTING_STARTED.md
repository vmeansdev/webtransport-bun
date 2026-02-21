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

## Client (planned)

`connect(url, opts)` is not yet implemented. Use the reference load-client or Chromium for testing.
