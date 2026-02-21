# @webtransport-bun/interop

Chromium WebTransport interop harness. Runs Playwright tests against the reference
wtransport server (or the Bun addon server) to validate the interop gate:
"Chromium WebTransport client can connect and exchange datagrams + streams reliably".

## Setup

```bash
bun install
bunx playwright install chromium   # One-time: download Chromium for WebTransport tests
```

## Run

From repo root:

```bash
bun run test:interop
```

Or from this directory:

```bash
bun run playwright test
```

## Tests

- `bidi stream echo via WebTransport` — bidirectional stream send/recv
- `datagram echo via WebTransport` — datagram send/recv
- `unidirectional stream echo via WebTransport` — uni stream send, receive echo on incoming uni

## Reference server

The Playwright webServer starts `crates/reference` (wtransport reference server) automatically.
It listens on QUIC port 4433 and exposes an HTTP health endpoint on 127.0.0.1:4434 for readiness probing.
