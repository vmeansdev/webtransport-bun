<p>
  <img src="docs/brand/logo-wordmark-a-single-light.svg" alt="webtransport-bun logo" />
</p>

WebTransport for Bun with production guardrails: datagrams + streams, in-process server/client, and Chromium interop backed by Rust `wtransport` via `napi-rs`.

<p>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/test.yml"><img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/release.yml"><img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/release.yml/badge.svg" alt="Release" /></a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/codeql.yml"><img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/codeql.yml/badge.svg" alt="CodeQL" /></a>
  <a href="https://github.com/vmeansdev/webtransport-bun/actions/workflows/trivy.yml"><img src="https://github.com/vmeansdev/webtransport-bun/actions/workflows/trivy.yml/badge.svg" alt="Trivy" /></a>
</p>

## Why Try This

`webtransport-bun` is for Bun teams that need realtime transport beyond WebSockets without giving up JS/Bun ergonomics.

- Mix unreliable low-latency traffic and reliable ordered traffic in one session.
- Run WebTransport server and client in-process in Bun.
- Keep ops predictable with queue/memory/rate limits and backpressure timeouts.
- Use browser clients (Chromium interop tested in CI).

## Who This Is For

- Teams building collaboration/presence workloads with high update rates.
- Multiplayer or telemetry-heavy backends where packet loss tolerance matters.
- Services moving from WebSockets to QUIC/WebTransport while staying in Bun.
- Systems needing streams for commands/state sync and datagrams for fast signals.

## Who This Is Not For

- Projects requiring Windows support.
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
| Bun in-process server | Yes | Yes | No (requires custom bindings/service) |
| Bun in-process client | Yes | Yes | No (requires custom bindings/service) |
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
- GitHub Pages docs site: `https://vmeansdev.github.io/webtransport-bun/`
- FAQ / troubleshooting: `docs/FAQ.md`
- Migration guide: `docs/MIGRATION_WEBSOCKET.md`
- AI-agent entrypoint: `llms.txt`

## Status
- In active hardening.
- Version: `0.1.0` (beta).
- Primary target runtime: Bun (`>= 1.3.9`).
- Server and client APIs are available from `@webtransport-bun/webtransport`.
- Known limits: Chromium-focused browser interop target, macOS/Linux only, API still stabilizing within `0.1.x`.

## Support Matrix

### Runtime
- Bun `>= 1.3.9`

### OS / Arch
- macOS arm64 (`darwin-arm64`), macOS x64 (`darwin-x64`)
- Linux x64 (`linux-x64`)

See `docs/COMPATIBILITY.md` for policy details.

## Install

### From package
```bash
bun add @webtransport-bun/webtransport
```

### From local workspace (development)
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

### 1) Install package
```bash
bun add @webtransport-bun/webtransport
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

## Used By

Using this in production? Let me know and I will list your company/project.

- Adopters list: `ADOPTERS.md`
- Add yourself via issue: `.github/ISSUE_TEMPLATE/add-adopter.md`

## License

MIT. See `LICENSE`.

## Contributing
See `CONTRIBUTING.md`.
