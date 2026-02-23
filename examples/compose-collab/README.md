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
