# webtransport-bun

Production-focused WebTransport for Bun, implemented as a Node-API addon (`napi-rs`) backed by Rust `wtransport`.

## Status
- In active hardening.
- Primary target runtime: Bun.
- Server and client APIs are available from `@webtransport-bun/webtransport`.

## Support Matrix

### Runtime
- Bun `>= 1.3.9`

### OS / Arch
- macOS arm64 (`darwin-arm64`)
- Linux x64 (`linux-x64`)

See `docs/COMPATIBILITY.md` for policy details.

## Install

### From package (when published)
```bash
bun add @webtransport-bun/webtransport
```

### From local workspace
```bash
bun add file:./packages/webtransport
```

## Quickstart

### 1) Build native addon
```bash
bun run build:native
```

### 2) Start a server
```ts
import { createServer } from "@webtransport-bun/webtransport";
import { readFileSync } from "node:fs";

const certPem = readFileSync("./cert.pem", "utf-8");
const keyPem = readFileSync("./key.pem", "utf-8");

const server = createServer({
  host: "0.0.0.0",
  port: 4433,
  tls: { certPem, keyPem },
  onSession: async (session) => {
    for await (const d of session.incomingDatagrams()) {
      await session.sendDatagram(d);
    }
  },
});

console.log("listening:", server.address);
```

### 3) Connect a client
```ts
import { connect } from "@webtransport-bun/webtransport";

const session = await connect("https://127.0.0.1:4433", {
  tls: { insecureSkipVerify: true }, // dev only
});

await session.sendDatagram(new Uint8Array([1, 2, 3]));

for await (const d of session.incomingDatagrams()) {
  console.log("echo:", d);
  break;
}

session.close();
```

## Stream Controls

The stream helpers are symbol-based to avoid collisions with Node stream APIs:

- `WT_RESET`
- `WT_STOP_SENDING`

Example:
```ts
import { WT_RESET, WT_STOP_SENDING } from "@webtransport-bun/webtransport";

const bidi = await session.createBidirectionalStream();
bidi[WT_RESET](42);
```

## Default Limits

Important defaults (configurable via `limits`):
- `maxSessions`: `2000`
- `maxStreamsGlobal`: `50000`
- `maxDatagramSize`: `1200`
- `maxQueuedBytesGlobal`: `512 MiB`
- `backpressureTimeoutMs`: `5000`
- `handshakeTimeoutMs`: `10000`
- `idleTimeoutMs`: `60000`

## Verification Commands

From repository root:

```bash
cargo fmt --check
cargo clippy --workspace -- -D clippy::all
cargo test --workspace
bun run typecheck
bun test packages/
bun run test:load-addon
bun run test:overload-addon
SOAK_DURATION=120 bun run test:soak-addon
bun run test:interop
```

## Operational Caveats
- WebTransport requires UDP reachability for your configured port.
- Use valid TLS certs for browser/public deployments.
- `insecureSkipVerify` is for development only.
- If memory pressure rises, lower queue/session limits first, then scale out.

See `docs/OPERATIONS.md` for runbooks.

## Release Checklist
- API and behavior review: `docs/SPEC.md`
- Test gates: `docs/TESTPLAN.md`
- CI and release flow: `docs/CI.md`
- Operations runbooks: `docs/OPERATIONS.md`
- Compatibility policy: `docs/COMPATIBILITY.md`

## Contributing
See `CONTRIBUTING.md`.
