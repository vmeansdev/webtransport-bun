# @webtransport-bun/interop

Chromium WebTransport interop harness. Runs Playwright tests against the addon server
to validate the interop gate: "Chromium WebTransport client can connect and exchange
datagrams + streams reliably".

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

## Server

The Playwright webServer starts the addon server (`addon-server.ts`) automatically.
It listens on QUIC port 4433 and exposes an HTTP health endpoint on 127.0.0.1:4434 for readiness probing.

## Local vs CI

Interop tests may fail locally with "Opening handshake failed" in some environments (e.g. Cursor
sandbox, macOS firewall, or QUIC being blocked). The **acceptance criterion is CI on Linux**.
Run `bun run test` in this directory; CI runs the same suite on `ubuntu-latest` and `macos-latest`.
