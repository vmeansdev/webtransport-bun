<p>
  <img src="docs/brand/logo-wordmark-a-single-light.svg" alt="webtransport-bun logo" />
</p>

Production-ready WebTransport for Bun, delivered as a Node-API addon (`napi-rs`) backed by Rust `wtransport`.

<p>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/test.yml"><img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/release.yml"><img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/codeql.yml"><img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/trivy.yml"><img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/trivy.yml/badge.svg" alt="Trivy" /></a>
</p>

## Why try this project?
- Bun-first WebTransport with in-process server and client.
- Practical API for real backends: datagrams + uni/bidi streams.
- Rust transport core with JS ergonomics.
- Explicit production defaults for backpressure, limits, and abuse resistance.
- Clear docs for operations, CI, and test gates.

## Why this is good
- It is engineered around bounded memory, deterministic shutdown, and queue discipline.
- It treats backpressure as a first-class runtime behavior, not an afterthought.
- It supports both low-level session APIs and a W3C-like facade.
- It includes interop testing against Chromium clients, not only local mocks.
- It is aligned with Bun packaging and native prebuild distribution expectations.

## Alternatives

Pick this project when you need Bun-native, in-process server + client with strong operational defaults.

| Alternative | Good at | Tradeoff vs `webtransport-bun` |
|---|---|---|
| Browser-native WebTransport only | Direct browser usage | No Bun server runtime for your app process |
| Node QUIC/WebTransport ecosystem packages | Node-focused integration | Bun fit, packaging, and runtime semantics can differ |
| Building directly on Rust QUIC stacks (`wtransport`, `quinn`) | Maximum protocol control | You build/maintain JS bindings and API surface yourself |
| HTTP/2 + WebSocket stacks | Ubiquitous infra support | Different transport model and performance profile from WebTransport/QUIC |

## Status
- In active hardening.
- Primary target runtime: Bun (`>= 1.3.9`).
- Server and client APIs are available from `@webtransport-bun/webtransport`.

## Support Matrix

### Runtime
- Bun `>= 1.3.9`

### OS / Arch
- macOS arm64 (`darwin-arm64`), macOS x64 (`darwin-x64`)
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

## Examples

- Browser + Bun echo playground (datagrams, bidi, uni):
  `examples/echo-playground`
- Compose collaboration room (1 server + 3 clients):
  `examples/compose-collab`

Quick run:

```bash
bun run build:native
bun run example:echo:cert
bun run example:echo
```

Then open `http://127.0.0.1:3000`.

Dockerized example is available at `examples/echo-playground/Dockerfile`.

Run Docker example in one command:

```bash
bun run example:echo:docker
```

Run multi-node compose collaboration example:

```bash
bun run example:compose:collab
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

// Dev: use tools/interop/certs/ after `cd tools/interop && bun run prepare:interop`
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

### 4) Connect a client (W3C-like facade)
```ts
import { WebTransport } from "@webtransport-bun/webtransport";

const wt = new WebTransport("https://127.0.0.1:4433", {
  tls: { insecureSkipVerify: true }, // dev only
});

await wt.ready;

const writer = wt.datagrams.writable.getWriter();
await writer.write(new Uint8Array([1, 2, 3]));
writer.releaseLock();

const reader = wt.datagrams.readable.getReader();
const { value } = await reader.read();
console.log("echo:", value);
reader.releaseLock();

wt.close({ closeCode: 1000, reason: "done" });
await wt.closed;
```

## Stream Controls

The stream helpers are symbol-based to avoid collisions with Node stream APIs:
- `WT_RESET`
- `WT_STOP_SENDING`

```ts
import { WT_RESET } from "@webtransport-bun/webtransport";

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
bun tools/smoke-readme.ts
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
