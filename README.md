<div align="center">
  <h1>webtransport-bun</h1>
  <p><em>WebTransport for Bun, Node, and Deno with production guardrails: datagrams + streams, in-process server/client, and Chromium interop backed by Rust `wtransport` via `napi-rs`.</em></p>
</div>

<p align="center">
  <a href="https://www.npmjs.com/package/@webtransport-bun/webtransport">
    <img src="https://img.shields.io/npm/v/%40webtransport-bun%2Fwebtransport.svg" alt="npm version" />
  </a>
  <a href="https://www.npmjs.com/package/@webtransport-bun/webtransport">
    <img src="https://img.shields.io/npm/dm/%40webtransport-bun%2Fwebtransport.svg" alt="npm downloads" />
  </a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/test.yml">
    <img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/test.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/release.yml">
    <img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/release.yml/badge.svg" alt="Release" />
  </a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/codeql.yml">
    <img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" />
  </a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/trivy.yml">
    <img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/trivy.yml/badge.svg" alt="Trivy" />
  </a>
</p>

## Why Try This

`webtransport-bun` is for teams that need realtime transport beyond WebSockets without giving up JS runtime ergonomics.

- Mix unreliable low-latency traffic and reliable ordered traffic in one session.
- Run WebTransport server and client in-process in Bun, Node, or Deno.
- Keep ops predictable with queue/memory/rate limits and backpressure timeouts.
- Use browser clients (Chromium interop tested in CI).

## Who This Is For

- Teams building collaboration/presence workloads with high update rates.
- Multiplayer or telemetry-heavy backends where packet loss tolerance matters.
- Services moving from WebSockets to QUIC/WebTransport while staying in JS runtimes.
- Systems needing streams for commands/state sync and datagrams for fast signals.

## Who This Is Not For

- Teams needing full browser WebTransport spec parity.
- Cases where plain WebSockets are fully sufficient and simpler to operate.

## Use Cases

- Collaboration and presence: cursors/typing over datagrams, edits/events over streams.
- Multiplayer and game telemetry: frequent state deltas + reliable control channels.
- IoT / high-frequency ingest: lossy telemetry + reliable config/ack flows.
- Realtime AI/control channels: low-latency control messages + reliable command streams.

## Feature Matrix

| Capability | `webtransport-bun` | WebSocket stacks | Raw QUIC libs (`wtransport`/`quinn`) |
|---|---|---|---|
| In-process server (Bun/Node/Deno) | Yes | Yes | No (requires custom bindings/service) |
| In-process client (Bun/Node/Deno) | Yes | Yes | No (requires custom bindings/service) |
| Datagram + stream model | Yes | No (single reliable channel) | Yes |
| Browser WebTransport interop | Yes (Chromium-tested) | No | Indirect/custom |
| Operational defaults (limits, abuse controls) | Yes | Varies by app | You build it |
| JS-first API surface | Yes | Yes | No |

## Benchmarks

Benchmark baselines and methodology:
- `docs/BENCHMARK_BASELINES.md`

Reproducible commands:

```bash
bun run bench:datagram
bun run bench:handshake
bun run bench:stream
bun run bench:baseline
```

## Migration From WebSocket (Quick Guide)

| Existing WebSocket pattern | WebTransport channel in `webtransport-bun` |
|---|---|
| Presence pings / cursors / telemetry | Datagrams |
| Chat / reliable app events | Bidirectional stream |
| Server snapshots / state dumps | Unidirectional stream from server |
| Single-message envelope for all traffic | Split by semantics: datagram vs stream |

Detailed migration playbook:
- `docs/MIGRATION_WEBSOCKET.md`

## Demo

- Local interactive demo: `examples/echo-playground`
- Multi-node compose demo: `examples/compose-collab`
- Recommended short walkthrough to record/share: run compose demo + open `http://localhost:8080/` dashboard.

## Documentation

- Docs portal: `docs/START_HERE.md`
- Canonical release truth: `docs/release-status.json`
- Pooling semantics (`allowPooling`): `docs/SPEC.md` — Pooling Semantics section
- GitHub Pages docs site: `https://vmeansdev.github.io/webtransport-bun/`
- FAQ / troubleshooting: `docs/FAQ.md`
- Migration guide: `docs/MIGRATION_WEBSOCKET.md`
- AI-agent entrypoint: `llms.txt`

## Status
- Native surface is a release candidate: `1.0.0-rc.1`.
- Version: `1.0.0-rc.1`. The canonical release status lives in
  `docs/release-status.json`; the native root entrypoint and `/wasm` are
  candidate surfaces, not stable/GA.
- Configured release targets: Bun (`>= 1.3.9`), Node, and Deno. Candidate support remains unclaimed until the matching entries in
  `docs/release-status.json` have passing evidence.
- Server and client APIs are available from `@webtransport-bun/webtransport`.
- Known limits: Chromium-focused browser interop target. Readiness remains pending in `docs/release-status.json` until the external evidence gates close.

## Configured Target Matrix

### Runtime
- Bun `>= 1.3.9`
- Node (Node-API compatible runtime)
- Deno (npm + Node-API addon support)

### OS / Arch
- macOS arm64 (`darwin-arm64`), macOS x64 (`darwin-x64`)
- Linux x64 (`linux-x64`)
- Windows x64 (`win32-x64-msvc`)

See `docs/COMPATIBILITY.md` for policy details.

## Install

### From package
```bash
bun add @webtransport-bun/webtransport
npm i @webtransport-bun/webtransport
pnpm add @webtransport-bun/webtransport
yarn add @webtransport-bun/webtransport
```

The candidate 1.0 npm artifact is configured to contain:
- `dist/` compiled JS + TypeScript declarations (`index`, `errors`, `streams`)
- `prebuilds/` native addon binaries (`.node`) for the configured target matrix
- `README.md` and `LICENSE`

Note: GitHub source zip/tar downloads are source snapshots and may not include generated `dist/`. Use npm install (or the release `.tgz` package asset) for a ready-to-run package.

### From local workspace (development)
```bash
bun add file:./packages/webtransport
npm i file:./packages/webtransport
pnpm add file:./packages/webtransport
yarn add file:./packages/webtransport
```

## Examples

- Browser + runtime echo playground (datagrams, bidi, uni):
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

## WASM Backend: WebTransport Server in the Browser

Beyond the native napi-rs addon, the package ships a **sans-IO wasm backend**
(`@webtransport-bun/webtransport/wasm`) that runs the full
QUIC/TLS1.3/HTTP3/WebTransport stack compiled to `wasm32-unknown-unknown` —
including a **server running inside the browser** (issue #12: bring your own
UDP socket).

The current release status is pending in `docs/release-status.json`; treat the
`/wasm` surface as a candidate, not stable/GA.

- **Bring your own socket**: the core never touches the network. Any transport
  implementing `UdpTransport` (`send(data, dest)` + `onPacket(data, source)`)
  feeds it raw UDP payloads — Direct Sockets `UDPSocket` in a Chromium
  Isolated Web App, `Bun.udpSocket` in Bun, or an in-memory relay in tests.
- **Server + client**: `serveOverUdp(...)` accepts sessions (multi-client,
  routed per source address) and returns the `serverCertificateHashes` value;
  `connectWasm(...)` / `createUnifiedClient(...)` connect as a client.
- **Backend-agnostic contract**: `WebTransportLike` (exported from both the
  root and `/wasm` subpaths) lets application code run unchanged against the
  native or wasm backend.
- **One server, either backend**: `webtransport-bun/portable` exports an async
  `createServer` that dispatches on the runtime, handing your `onSession` the
  same session shape on both. See below.
- **Certs**: `generateCert` produces browser-pinnable ECDSA P-256 certs
  (validity clamped to the 14-day `serverCertificateHashes` limit).

```ts
import { loadWasmModule, serveOverUdp } from "@webtransport-bun/webtransport/wasm";

const wasm = await loadWasmModule(); // prebuilt artifact shipped in the package
const { manager, certHashBase64 } = await serveOverUdp(wasm, bindUdp, {
  localPort: 4433,
  onSession: (session) => session.onDatagram((d) => session.sendDatagram(d)),
});
```

The same echo server, written once and run on whichever backend the runtime
provides:

```ts
import { createServer } from "@webtransport-bun/webtransport/portable";

const server = await createServer({
  port: 4433,
  tls: { allowSelfSigned: true }, // wasm-only; pass certPem/keyPem on native
  onSession: async (session) => {
    for await (const d of session.incomingDatagrams()) {
      await session.sendDatagram(d);
    }
  },
});
// wasm clients pin server.certHashBase64
await server.close();
```

### Know before you ship

- **`/wasm` is a candidate surface, not stable/GA — but its export list is
  frozen.** Those are two different promises. The names exported from `/wasm`
  are pinned by `packages/webtransport/test/public-surface-contract.test.ts`, so
  removing or renaming one is a breaking change needing a major bump. What is
  still `candidate` is the *stability label*: `docs/release-status.json` marks
  both `native` and `wasm` as `candidate`, and `/wasm` becomes `stable` only
  once its required claims pass. Behavior under those gates may still change.
  The wasm server session mirrors the native `ServerSession` shape —
  `incomingDatagrams()`, the incoming stream `ReadableStream`s, `id`/`peer`, and
  `getStats()` — so one server codebase runs on either backend through
  `webtransport-bun/portable`, which is the subset actually contract-tested on
  both. What remains divergent is the original callback-style API
  (`onDatagram`/`onIncomingStream`), kept for back-compat but deprecated; it
  cannot be combined with the W3C surface on the same session.
- **The in-browser server is Chromium-only, and only inside an Isolated Web
  App.** Direct Sockets `UDPSocket` does not exist on normal web pages, in
  Firefox, or in Safari. Installing an IWA today requires `chrome://flags`
  (`#enable-isolated-web-apps`, `#enable-isolated-web-app-dev-mode`) or
  enterprise policy. Chromium permission naming is compatibility-sensitive:
  accept `direct-sockets`, the legacy `direct-sockets-private`, and Chrome 151
  `local-network` / `loopback-network` labels where the browser exposes them.
  *Connecting* to a wasm server needs no flags - any standard WebTransport
  client works.
- **Certificates expire in ≤ 14 days by design.** `serverCertificateHashes`
  pinning (the only option without a CA-trusted cert) requires ECDSA P-256 and
  a validity window of at most two weeks — `generateCert` clamps to this.
  Plan for rotation: regenerate and redistribute the hash before expiry;
  clients pin the hash, so a new cert means a new hash.
- **You bring the I/O — unless you use IWA plug-and-play.** The wasm core is
  sans-IO: it never opens sockets, reads clocks, or schedules timers by itself.
  Shipped adapters (`DirectSocketsUdpTransport`, Bun UDP, `InMemoryRelay`) pump
  packets and drive timeouts. Inside a Chromium IWA with Direct Sockets,
  `await createServer(...)` from `@webtransport-bun/webtransport/wasm` (alias
  `createIwaServer`) owns bind + pumps for you. That is not the root package's
  native sync `createServer`, and it still cannot run on a normal webpage.
- **Client-side wasm works anywhere wasm runs** (Bun, Node, browsers) against
  any WebTransport server — the IWA constraint applies only to hosting a
  *server* in the browser.

Typical use cases: browser-to-browser P2P on a LAN without WebRTC signaling,
kiosk/enterprise IWAs accepting connections from local devices, offline or
air-gapped networks, and in-page loopback for protocol testing against
Chromium's own native client.

See `examples/webtransport-wasm-iwa/` for the in-browser (IWA) reference,
`tools/interop/WASM_INTEROP.md` for the cross-stack interop matrix, and
`docs/PARITY_MATRIX.md` for native-vs-wasm feature parity (pooling, stats, CC,
sendOrder, durable tickets, live TLS, metrics — IWA async `createServer` on
`/wasm` is available as a candidate; lower-level hosts may still supply
`UdpTransport`).

## Quickstart

### 1) Install package
```bash
bun add @webtransport-bun/webtransport
npm i @webtransport-bun/webtransport
pnpm add @webtransport-bun/webtransport
yarn add @webtransport-bun/webtransport
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

W3C-facade option semantics in this runtime:
- `allowPooling`: when `true`, endpoint-level pooling reuses compatible connects; when `false`, dedicated sessions.
- `requireUnreliable`: accepted; satisfied by QUIC/WebTransport transport capabilities.
- `serverCertificateHashes`: supported (SHA-256 leaf pinning, W3C semantics — the pin replaces CA/hostname validation so self-signed pinned certs are accepted, with a ≤14-day cert-validity guard) and rejected when combined with `allowPooling: true`.
- `datagramsReadableType`: `"bytes"` uses `ReadableByteStream` with BYOB; `"default"` uses normal `ReadableStream`.
- `congestionControl`: accepted and surfaced via effective-mode behavior.

## From Source (Local Development)

When running directly from this monorepo:

```bash
bun install
bun run build:native
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
bun run test:parity
bun run test:load-addon
bun run test:load-scale-addon
bun run test:overload-addon
bun run test:load-profiles-addon
BENCH_P95_MAX_MS=500 bun run bench:handshake
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

## Used By

Using this in production? Let me know and I will list your company/project.

- Adopters list: `ADOPTERS.md`
- Add yourself via issue: `.github/ISSUE_TEMPLATE/add-adopter.md`

## License

MIT. See `LICENSE`.

## Contributing
See `CONTRIBUTING.md`.
