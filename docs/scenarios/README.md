# Scenario guides

Each guide takes one family of workloads from nothing to a running setup: the
workload shape that was measured, the result and the hardware it belongs to, a
runnable example, the server configuration, host tuning, how to scale out,
what to monitor, and the traps. Every example lives in
[`examples/scenarios/`](../../examples/scenarios/) and is exercised by the test
suite at a small scale, so the code in the guides runs.

| If you are building… | Read | Gates |
|---|---|---|
| An action game, an MMO realm, a GPS or IoT fleet | [Realtime games and telemetry](realtime-games.md) | G1, G2, G6 |
| Video calls, an SFU, voice or video rooms, camera uplinks | [Live media and rooms](live-media-rooms.md) | G3, G4, G8 |
| File delivery, VOD, large downloads, token streaming | [Bulk transfer and streaming](bulk-and-streaming.md) | G5, G7 |
| Live data to many subscribers: tickers, scoreboards, dashboards | [Broadcast](broadcast.md) | G10, paced broadcast |
| Apps with short visits, page reloads, reconnect storms | [Connection churn](connection-churn.md) | G9 |
| RPC over WebTransport, long-lived tunnels | [RPC and tunnels](rpc-and-tunnels.md) | G11 |
| More than one server process | [Deployment and scale-out](deployment.md) | G6 (sharded) |

The gate numbers refer to the measurement campaign summarized in
[CAPACITY.md](../CAPACITY.md):

| Gate | Workload | Guide |
|---|---|---|
| G1 | Session scale (GPS / telemetry) | [realtime-games](realtime-games.md) |
| G2 | Action-game tail latency | [realtime-games](realtime-games.md) |
| G3 | Camera / bursty egress | [live-media-rooms](live-media-rooms.md) |
| G4 | SFU fan-out | [live-media-rooms](live-media-rooms.md) |
| G5 | Bulk / VOD | [bulk-and-streaming](bulk-and-streaming.md) |
| G6 | MMO realm | [realtime-games](realtime-games.md), [deployment](deployment.md) |
| G7 | Stream egress | [bulk-and-streaming](bulk-and-streaming.md) |
| G8 | Many rooms | [live-media-rooms](live-media-rooms.md) |
| G9 | Connection churn | [connection-churn](connection-churn.md) |
| G10 | Broadcast | [broadcast](broadcast.md) |
| G11 | Request/response and tunnels | [rpc-and-tunnels](rpc-and-tunnels.md) |

## Before any of them

- Get one server and client running first: [GETTING_STARTED.md](../GETTING_STARTED.md).
- Every example needs the native addon (`bun run build:native` in a checkout)
  and `openssl` on the path for its throwaway certificates.
- The numbers in these guides belong to specific hardware. The examples show
  the setup working; they are not benchmarks. Re-measure on the hardware you
  will run, with the generator on a separate machine.
