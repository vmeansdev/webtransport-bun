# Compose Collaboration Demo

A realistic multi-node WebTransport setup that mirrors common WebSocket workloads.

- 1 server container (`wt-server`)
- 3 client containers (`client-a`, `client-b`, `client-c`)
- Channels used:
  - datagrams: presence pings
  - bidirectional streams: chat-like reliable messages
  - unidirectional streams: periodic state/snapshot updates

## Run

From repo root:

```bash
bun run example:compose:collab
```

This command builds the image and starts all nodes via Docker Compose.

The dashboard is local-only by default. Direct runs bind HTTP to loopback, and
Compose publishes the container dashboard on `127.0.0.1:8080`; the WebTransport
UDP port remains available on the configured host mapping for local clients.
Change the HTTP bind or port mapping only for an intentional, protected network
demo. The dashboard is an unauthenticated diagnostics surface and must not be
used as a production control plane.

Complete bidi and uni bodies are capped at 256 KiB. Inputs over that limit are
cancelled before the example retains or broadcasts the body.

### Without Docker

The compose image builds the addon and generates a dev certificate for you; a
direct run has to do both itself. From the repo root:

```bash
bun install
bun run build:native
mkdir -p examples/compose-collab/certs
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -days 10 -nodes \
  -keyout examples/compose-collab/certs/key.pem \
  -out examples/compose-collab/certs/cert.pem \
  -subj '/CN=localhost' -addext 'subjectAltName = DNS:localhost,IP:127.0.0.1'

bun run examples/compose-collab/server.ts                  # terminal 1
CLIENT_ID=client-a WT_URL=https://127.0.0.1:4433 \
  bun run examples/compose-collab/client.ts                # terminal 2 (and more)
```

The client defaults to `WT_URL=https://wt-server:4433`, the compose service
name, so a direct run must set `WT_URL`. The server reads `WT_HOST` /
`WT_PORT` (default `0.0.0.0:4433`) and `HTTP_HOST` / `HTTP_PORT` (default
`127.0.0.1:8080`); the client also takes `PRESENCE_MS`, `CHAT_MS` and `UNI_MS`.
The certificate lives 10 days (`certs/*.pem` is git-ignored): regenerate it when
it expires.

## What you should see

- Server logs showing sessions joining/leaving
- Each client logging sent + echoed messages for datagram, bidi, and uni channels
- Live dashboard at `http://localhost:8080/` with:
  - active sessions
  - ingress/fanout counters
  - session list
  - recent event stream

## Endpoints

- WebTransport server: `udp://localhost:4433` (WT URL is `https://localhost:4433`)
- Dashboard: `http://localhost:8080/`
- Health endpoint: `http://localhost:8080/healthz`

## Stop

Press `Ctrl+C`, then clean up:

```bash
docker compose -f examples/compose-collab/docker-compose.yml down
```
