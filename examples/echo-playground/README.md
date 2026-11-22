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

Notes:
- `0.0.0.0` is a server bind address, not a browser URL. Always open `127.0.0.1` (or your host IP).
- The playground requires a browser with `window.WebTransport` support (use recent Chrome/Chromium).

WebTransport endpoint used by the page:
- `https://127.0.0.1:4433`

Environment variables (all optional):

| Variable | Default | Effect |
|---|---|---|
| `HTTP_HOST` | `127.0.0.1` | bind address of the HTTP UI (`0.0.0.0` in the Docker image) |
| `HTTP_PORT` | `3000` | HTTP UI port |
| `WT_PORT` | `4433` | WebTransport UDP port; the server always binds it on `0.0.0.0` |

The page always dials `https://127.0.0.1:<WT_PORT>`: the server hands it that
URL from `/config`, and the dev certificate covers only `localhost` and
`127.0.0.1`. So the playground works only from a browser on the same machine
(or on a host whose port 4433 is forwarded there, as with the Docker run below).
Opening the UI from another machine loads the page but its WebTransport
connect goes to that machine's own loopback and fails.

The example retains at most 256 KiB from any complete bidi or uni stream. An
over-limit stream is cancelled instead of being buffered until EOF.

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
- Bidirectional stream echo: browser `createBidirectionalStream()` -> server `incomingBidirectionalStreams`
- Unidirectional stream echo: browser `createUnidirectionalStream()` -> server `incomingUnidirectionalStreams` -> server `createUnidirectionalStream()` back to client
- Close info propagation demo:
  - In UI, use `Close Demo (Client -> Server)` with `closeCode`/`closeReason` (defaults `4999` / `Done streaming.`).
  - Browser log shows: `closed: code=... reason=...`.
  - Server terminal shows: `[wt] session closed id=... code=... reason="..."`.

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
