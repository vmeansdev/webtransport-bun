# Echo Playground (Browser + Bun)

This example runs:
- A WebTransport echo server (datagrams, bidi, uni) using the repo's local package source (`packages/webtransport/src`)
- A `Bun.serve` HTTP server for a local HTML playground UI

Both run in the same Bun process by default.

## Quickstart

From repo root:

```bash
bun install
bun run build:native
bun run example:echo:cert
bun run example:echo
```

Open:
- `http://127.0.0.1:3000` (UI)

WebTransport endpoint used by the page:
- `https://127.0.0.1:4433`

## Chrome notes for local self-signed cert

The playground fetches `serverCertificateHashes` from `/config` and uses certificate pinning for WebTransport.
If your browser still rejects local certs in your environment, use this fallback Chrome launch command:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir=/tmp/wt-dev-profile \
  --origin-to-force-quic-on=127.0.0.1:4433 \
  --ignore-certificate-errors \
  --allow-insecure-localhost \
  --webtransport-developer-mode
```

## What is demonstrated

- Datagram echo: browser `transport.datagrams.writable` -> server `incomingDatagrams()` -> server `sendDatagram()`
- Bidirectional stream echo: browser `createBidirectionalStream()` -> server `incomingBidirectionalStreams()`
- Unidirectional stream echo: browser `createUnidirectionalStream()` -> server `incomingUnidirectionalStreams()` -> server `createUnidirectionalStream()` back to client

## WebTransport alongside `Bun.serve`

Yes, it should run alongside `Bun.serve` in one process for many apps. This example does exactly that:
- `Bun.serve` handles HTTP/Web UI
- `createServer(...)` handles WebTransport/QUIC on UDP

Use separate isolation only when needed:
- Worker thread: if you want fault isolation while still one deployment unit
- Separate process/service: if you need strict resource isolation, independent scaling, or blast-radius reduction

A practical default:
1. Start single-process (simpler ops, fewer moving parts).
2. Split once you observe CPU/memory contention or need separate autoscaling.

## Docker

One command (from repo root):

```bash
bun run example:echo:docker
```

Build from repo root:

```bash
docker buildx build --load -f examples/echo-playground/Dockerfile -t wt-echo-playground .
```

Run:

```bash
docker run --rm \
  -p 3000:3000/tcp \
  -p 4433:4433/udp \
  wt-echo-playground
```

Then open `http://127.0.0.1:3000`.
