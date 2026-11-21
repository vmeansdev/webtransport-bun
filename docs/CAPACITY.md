# Capacity and latency: what was measured

This is the operator's summary of the 2026 bare-metal and cloud measurement
campaign: one row per scenario gate (G1–G11), the hardware each figure belongs
to, and what each result does and does not license. The
[scenario guides](scenarios/README.md) turn each row into a working setup.

**Release ruling (2026-10-28): G1–G11 are passed for 1.0**, each with the
figure and placement stated in its row below. G10 carries a remark: its
original shape has no verdict and is superseded by the paced-broadcast gate.

## How to read these numbers

- **Every figure belongs to its hardware.** Two rigs recur:
  - the **home rig**, a 4-core / 8-thread bare-metal Linux box with ~12 GB of
    RAM. Unless a row says otherwise, the load generator, the sink and the
    server ran on that one box over loopback;
  - **DigitalOcean** droplet pairs in one VPC, with the server and the
    generator on separate droplets (sizes named per row).
- **Per-process figures are upper bounds of unknown tightness.** Where the
  generator shared the box, part of the measured cost is the generator's, and
  that share was never measured. A production process with no generator next
  to it costs less, by an unknown amount.
- **A pass is a statement about the stated shape**, not about neighbouring
  shapes. Where a gate was narrowed, the narrowing is part of the result.
- **The harnesses are not in this repository.** The campaign's conductors,
  registrations and raw evidence were moved to the maintainer's archive on
  2026-10-29. The [scenario examples](https://github.com/vmeansdev/webtransport-bun/tree/main/examples/scenarios) reproduce each
  workload's shape at a scale you can run, and the guides name the in-repo
  drivers that still exist.

## The ledger

| Gate | Scenario | Result | Hardware | Guide |
|---|---|---|---|---|
| G1 | Device telemetry / session scale | **10,000 sessions**, ingest p99 2.576 ms, delivery 1.000000, ~126.5 KB per session, linear 1k→10k | Home rig, loopback | [realtime-games](scenarios/realtime-games.md) |
| G2 | Action game tail latency | Echo RTT p99 **1.0168 ms** (100 sessions × 150/s × 1,150 B) against 10 ms; network floor 0.397 ms | DO `c-32-intel` pair (32 vCPU), ams3 | [realtime-games](scenarios/realtime-games.md) |
| G3 | Camera / bursty egress | Frame-shaped egress one-way p99 **1.491 ms** against 33.3 ms; GSO and GRO active, 64 segments; no send-buffer errors | Home rig | [live-media-rooms](scenarios/live-media-rooms.md) |
| G4 | SFU fan-out | **16,509 forwarded datagrams/s** inside a 30 Hz frame gate (1 publisher → 50 subscribers at 3 Mbps), p99 10.879 ms, delivery 1.0000. A rate bound, not a subscriber-count bound | Home rig | [live-media-rooms](scenarios/live-media-rooms.md) |
| G5 | Bulk / VOD | **1.2505 Gbps** delivered against 1.0 Gbps, with experimental stream-chunk batching on (host CPU 34%); 1.1473 Gbps with it off (74%), disclosed, not graded | Home rig, loopback | [bulk-and-streaming](scenarios/bulk-and-streaming.md) |
| G6 | MMO realm | **40,000 players** steady (ack p99 3.71 / 3.59 ms), 40-player raid hotspot and an 8,000-player reconnect storm passed; 50,000 missed. A campaign build with non-shipped pieces (see [realtime-games](scenarios/realtime-games.md)). Single process: valid MISS (steady clauses passed at 500, knee 2,500, generator-confounded) on the home rig | 24 processes on one port, DO 48-vCPU pair, ric1 | [realtime-games](scenarios/realtime-games.md), [deployment](scenarios/deployment.md) |
| G7 | Stream egress | **1.2498 Gbps** at 16 streams × 64 KiB writes, exact byte accounting, zero client socket drops; 1,000 small-write sessions at one-way p99 5.112 ms; highest host CPU median in the run 79.1%, on the 1 KiB-write cell | Home rig, loopback | [bulk-and-streaming](scenarios/bulk-and-streaming.md) |
| G8 | Many rooms | Per arm, no single configuration holds all three: **voice 100 rooms**, **video 100 rooms × 10 subscribers** (p99 ≤ 3.54 ms), **mutual 10 rooms** (p99 ≤ 1.53 ms, only with the JavaScriptCore large-heap size set to 8 MiB so garbage is collected between load steps); delivery 1.0 | 10 room-shard processes on a DO `c-32-intel`, publishers and sinks on a second, nyc3 | [live-media-rooms](scenarios/live-media-rooms.md) |
| G9 | Connection churn | **600 sessions/s** sustained (achieved 595.75 / 596.01), base population RTT p99 7.09 / 12.60 ms against 40 ms, delivery 0.99952, zero leaked sessions or handles | Home rig | [connection-churn](scenarios/connection-churn.md) |
| G10 | Broadcast, 10,000 × 20 Hz | **Passed with remark: no verdict for this shape.** Superseded by the paced-broadcast gate | — | [broadcast](scenarios/broadcast.md) |
| Paced broadcast | Broadcast, 5,000 × 5 Hz | Delivery **0.9976–0.9986**, RTT p50 0.76–0.83 ms, JS stall per broadcast ~26× lower than unpaced; arrival-spread clause has no verdict | Home rig server, 5,000 sinks on a separate machine over 1 GbE | [broadcast](scenarios/broadcast.md) |
| G11 X | Request/response | **60,000 / 60,000** exchanges at 1,000 sessions, RTT p99 27.25 ms against 50 ms, host CPU 25.6% | Home rig | [rpc-and-tunnels](scenarios/rpc-and-tunnels.md) |
| G11 T | Bidirectional tunnels | **100 tunnels × 3 Mbps each way** at shipped defaults: up p99 3.5 / 3.594 ms, down 0.94 / 1.00 ms, exact byte accounting. On the 4-core home rig the same shape missed (348 ms up p99), attributed to the in-process benchmark conductor's read-side scheduling at full-duplex saturation (host ~87.7%), with that harness as the application | DO `c-8` (8 vCPU), generator on the same droplet | [rpc-and-tunnels](scenarios/rpc-and-tunnels.md) |
| G11 D | Cross-direction coupling | No coupling observed; grades nothing | Home rig | [rpc-and-tunnels](scenarios/rpc-and-tunnels.md) |

## Sizing rules that came out of the campaign

- **Plan processes, not threads.** A loaded process costs well over one core
  and probably under three; the JavaScript thread is usually the part that
  saturates first. The one per-thread measurement (~317% of one core for the
  process) included the benchmark conductor running inside the server
  process, and the JavaScript thread's dominant consumer there was harness
  code.
- **Many small writes from JavaScript cap at that thread.** One JS thread
  sourced about 63,300 writes/s at 1 KiB and could not reach the 152,588/s it
  was offered. Write larger chunks, batch (`sendDatagramBatch`,
  `sendDatagramMirror`), or add processes.
- **Keep a reading event loop below ~80% of a core.** Tail latency on streams
  is a queueing function of that loop's utilization (OPERATIONS.md,
  [Sizing the JS read side](OPERATIONS.md#sizing-the-js-read-side-stream-tail-latency)).
- **Memory scales with sessions:** about 126.5 KB each, linear to 10,000.
- **Packet impulses are the first wall at scale.** A fleet that sends on one
  timer overflows the kernel's UDP receive buffer before the server is busy
  (delivery 0.699 at 10,000 synchronized sessions; 1.000 staggered). Spread
  sends, raise the UDP buffers, pace broadcasts.
- **Scale out with independent processes**, one port each or one shared port
  with CID steering ([deployment](scenarios/deployment.md)). Never behind a
  4-tuple hash.

## What this product is for, and what it is not

**Distribution: yes.** Fan-out to many long-lived subscribers (dashboards,
browser and mobile clients, game state, market data to end users) at the
envelopes above: sub-millisecond median RTT (the campaign instrument's round
trip, not the age of a tick) at 5,000 sessions,
1.25 Gbps of stream egress, 10,000 sessions per process at the G1 telemetry
shape.

**Hot path: no.** It is not a tick-to-trade transport. There is one JavaScript
thread shared by the application and the transport, the runtime is
garbage-collected, and measured tails are in milliseconds, three to four
orders of magnitude above what a hot path budgets. The campaign also could not
witness microsecond behaviour with the instruments it had, so no such claim is
made.

## Measurement limits worth knowing

- **Off-box tail latency measured from a desktop machine is mostly the
  desktop.** G2 could not be graded on the home rig: its measuring path
  failed the 4.0 ms quiet-path check (floor RTT p99 8.1–12.6 ms), caused by
  the generator host waking late under load, so no gate cell was evaluable.
  The gate bar itself is 10 ms. On quiet cloud hardware the floor was
  0.397 ms. Measure tails from a quiet Linux host.
- **Check the generator before blaming the server.** The single-process MMO
  collapse at 5,000 players was later traced to the generator machine's
  network path dropping about 40% of its own outgoing packets; with a Linux
  generator, the same server code on a DigitalOcean `c-32-intel` pair held
  5,000 players with ingest 1.0000 (a characterization, not graded).
- **Medians are robust where tails are not.** Several gates were graded on
  medians across repeats for that reason; the rows say which.
