# Pre-registration — T02 loss attribution (probe/loss-attribution-01)

Registered before the first runner dispatch. Local macOS arms are attribution
evidence and are named as such; **no local number is a capacity result**, and no
local number is used to pass or fail anything here.

## Question

Run 32174398131 rung 4 (session-scale axis) reported delivery 0.694 at 10,000
sessions and a nominal 2,000 datagrams/s, with `rateLimitedTotal`,
`limitExceededTotal` and `datagramsDroppedTotal` all zero and nothing CPU-bound.
Which pipeline stage lost 71,681 datagrams?

## Taps (all five stages, one ledger)

| stage | tap | where |
|---|---|---|
| 1 client enqueue | `send_datagram` returned Ok | loss-client `steady.sent` |
| 2 client QUIC tx | `frame_tx.datagram` summed over connections, steady window | loss-client `steadyQuic.frameTxDatagram` |
| 3 kernel | `/proc/net/snmp` Udp (`InDatagrams`, `RcvbufErrors`, `InErrors`) + `/proc/net/udp` per-socket `drops` for the bench port | harness `kernelUdpSteady` (Linux only) |
| 4 quinn → native | `datagramsIn`, incremented immediately after `receive_datagram()` returns | harness `stages.quinnToNative` |
| 5 native → JS | datagrams the `incomingDatagrams()` iterator yielded | harness `stages.jsDelivered` |

Supporting taps: every `datagramsDropped*` reason, `datagramsSkippedQueueFull`
(the park counter, which is **not** part of `datagramsDropped` — the reason a run
can park heavily and still report "all drop counters zero"), `path.lost_packets`
and `path.congestion_events` from the client, per-connection DATAGRAM-frame tx
(to find wholly silent connections), and a per-session sequence ledger splitting
loss into prefix / suffix / interior / silent-session.

## Pre-registered classifier (fixed before any run)

Let `gap(stage_i → stage_j)` be the counted difference over the steady window.
The stage holding ≥ 80% of the total gap is the attributed stage. If no stage
holds ≥ 80%, the verdict is `mixed` and every stage's share is reported.

- gap(1 → 2) dominant → **client-side quinn send-buffer eviction** (the prior
  hypothesis from the ingest-ceiling work).
- gap(2 → 4) dominant **and** kernel `RcvbufErrors` accounts for ≥ 80% of it →
  **kernel receive-buffer overflow at the server socket**.
- gap(2 → 4) dominant **and** kernel counters flat → **quinn receive-side stale
  datagram eviction** (quinn-proto discards the oldest queued incoming datagrams
  with no counter when its per-connection receive buffer overflows).
- gap(4 → 5) dominant → **native queue / JS delivery**, and the reason counters
  name which.

## Pre-registered discriminator arms (mean rate vs burst shape)

The session-scale client releases every session from one phase signal and then
ticks each on the same period, so N sessions at one send per interval offer a
single **N-packet impulse per interval**, not N/interval packets per second.
Mean rate and burst size are therefore confounded in the original run. Three
arms separate them, all at 10,000 or 5,000 sessions on one server:

| arm | sessions | interval | mean rate | burst | prediction if burst-bound | if rate-bound |
|---|---|---|---|---|---|---|
| A (reproduction) | 10,000 | 5,000 ms | 2,000/s | 10,000 | loss | loss |
| B (rate matched) | 5,000 | 2,500 ms | 2,000/s | 5,000 | clean | loss |
| C (rate halved) | 10,000 | 10,000 ms | 1,000/s | 10,000 | loss | clean |
| D (burst removed) | 10,000 | 5,000 ms | 2,000/s | spread | clean | loss |

Arm D uses `--stagger-sends`, which changes only the phase of each session's
ticker. B clean + C lossy + D clean ⟹ the binder is burst size, and the
"2,000 datagrams/s" label on rung 4 does not describe the offered process.

## STOP conditions

- The client's own `ticksLate` > 1% of expected sends: the generator lagged its
  schedule and the arm is `incomplete`, not a loss measurement.
- `connectedRatio` < 0.99, or `sessionsLost` > 0: arm invalid.
- Any rate limiter fires (`rateLimitedCount` > 0): the arm measures
  configuration, and is invalid.

## Runner dispatch budget

≤ 3 dispatches, per spec §Run budget. Dispatch 1 is the confirmation ladder
(arms A–D on the 4 vCPU runner, kernel counters live). Dispatches 2 and 3 are
held for a named follow-up, and are spent only if dispatch 1 returns `mixed` or
contradicts the local attribution.
