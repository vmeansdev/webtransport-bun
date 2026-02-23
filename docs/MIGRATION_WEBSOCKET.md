# Migration from WebSocket

This guide maps common WebSocket patterns to `webtransport-bun` primitives.

## Mapping

| WebSocket pattern | WebTransport channel |
|---|---|
| Presence, cursor, typing, telemetry | Datagram |
| Chat, commands, reliable app events | Bidirectional stream |
| Server push snapshot/state sync | Unidirectional stream |

## Step-by-step migration

1. Classify your current message types by delivery semantics.
2. Move loss-tolerant traffic to datagrams first.
3. Keep critical ordered traffic on bidi streams.
4. Add periodic server snapshots via uni streams.
5. Enforce limits/backpressure from `limits` options early.

## Common pitfalls

- Treating datagrams as reliable: they are intentionally lossy.
- Using one stream for all event classes: split by semantics.
- Skipping queue limits: enforce caps before load tests.

## Validation checklist

- Datagram paths tested under packet loss.
- Stream paths tested for backpressure/timeout behavior.
- Interop with browser clients verified in your CI.
