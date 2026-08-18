# Attributing the 10,000-session datagram loss (T02)

**Question.** Run 32174398131 rung 4 of the session-scale axis reported delivery
0.694 at 10,000 sessions and a nominal 2,000 datagrams/s, while `rateLimited`,
`limitExceeded` and `datagramsDropped` all read zero and nothing was CPU-bound.
71,681 datagrams vanished with no counter observing them.

**Answer.** They were dropped in the kernel receive path between the client's
QUIC transmit and the server's QUIC receive. The server's application pipeline —
quinn → native queue → JS delivery — lost nothing at all. The binder is not
session count and not mean packet rate: it is **burst size**. Every session in
the load generator is released by one phase signal and then ticks on the same
period, so 10,000 sessions at one send per 5 s offer a single 10,000-packet
impulse every 5 s, not 2,000 packets per second. Spreading those same sends
across the interval, at the same session count and the same mean rate, delivers
100.0%.

Pre-registration: `docs/research/preregistrations/loss-attribution.md`
(committed before the first arm). Probe branch: `probe/loss-attribution-01`.

---

## What was missing, and why every counter read zero

`deliveryRatio = serverRx / clientSent` is one subtraction across five stages, so
it can only ever say *that* datagrams went missing. The session-scale harness
sampled `datagramsDropped` and nothing else on the server, and had no wire-level
tap at all. Three separate blind spots made "all drop counters zero" both true
and uninformative:

1. **`datagramsIn` was never sampled** — the counter incremented immediately
   after `receive_datagram()` returns, which is the only tap that separates
   "quinn never got it" from "the server dropped it".
2. **`datagramsSkippedQueueFull` is not part of `datagramsDropped`** — the
   backpressure park path calls `record_datagram_skip_queue_full`, a different
   counter, so a run can park heavily and still report zero drops.
3. **Neither endpoint can see a kernel drop.** A datagram discarded because the
   receiving socket's buffer was full is a successful send to the sender and a
   packet that never existed to the receiver's QUIC stack. Only the host's UDP
   counters and the sender's *congestion controller* see it.

`crates/reference/src/loss_client.rs` and `tools/load/bench-loss-attribution.ts`
add all five taps plus a per-session sequence ledger.

## The ledger, arm by arm

Local macOS (10 cores, 64 GB), server and generator co-resident, 100-byte
payloads, 120 s steady, 64 client endpoints, one server process.
**These are attribution numbers. They are not capacity results and are not
comparable to the 4 vCPU runner.**

| arm | sessions | interval | mean rate | burst | enqueued | wire tx | quinn rx | JS | delivery |
|---|---|---|---|---|---|---|---|---|---|
| A reproduction | 10,000 | 5,000 ms | 2,000/s | 10,000 | 234,053 | 234,053 | 176,297 | 176,297 | **0.753** |
| B rate matched | 5,000 | 2,500 ms | 2,000/s | 5,000 | 236,868 | 236,868 | 236,867 | 236,867 | **1.000** |
| C rate halved | 10,000 | 10,000 ms | 1,000/s | 10,000 | 113,891 | 113,891 | 72,282 | 72,282 | **0.635** |
| D burst removed | 10,000 | 5,000 ms | 2,000/s | spread | 230,009 | 230,009 | 230,009 | 230,009 | **1.000** |

Four facts follow directly, and each of them refutes a candidate:

- **`enqueued == wire tx` in every arm.** quinn's silent send-buffer eviction —
  the live hypothesis carried over from the ingest-ceiling work, where
  client-side quinn drops dominated a comparable case — contributed **zero**
  here. Per-connection DATAGRAM-frame counts in arm A ranged 23–24 across all
  10,000 connections, with no silent connection.
- **`quinn rx == JS delivered` in every arm** (arm B differs by one datagram in
  flight at the window edge). The native queue, the backpressure governor, the
  N-API boundary and the JS iterator delivered **100%** of what quinn handed
  them. `datagramsDropped*` and `datagramsSkippedQueueFull` were zero *because
  nothing was dropped there*, not because the counters were blind.
- **The whole gap sits between wire tx and quinn rx**, and the client's own
  congestion controller saw it: arm A recorded **58,479 lost packets and 57,913
  congestion events** against a 57,756-datagram gap and 368,708 packets sent.
  One lost packet ≈ one lost datagram. DATAGRAM frames are unreliable, so
  nothing was retransmitted and no application counter could observe it.
- **Halving the mean rate (C) did not help — it got worse; halving the burst (B)
  fixed it; removing the burst entirely (D) fixed it at the original rate and
  the original session count.** Mean rate is not the binder. Session count is
  not the binder except through burst size, with which it is numerically
  identical in this generator.

## The burst curve

Holding the mean rate at 2,000 datagrams/s and varying only the burst (sessions
and interval scaled together) puts a number on it:

| burst | sessions | interval | delivery | gap (wire tx → quinn rx) |
|---|---|---|---|---|
| 5,000 | 5,000 | 2,500 ms | 1.000 | 1 |
| 6,000 | 6,000 | 3,000 ms | 0.955 | 10,651 |
| 8,000 | 8,000 | 4,000 ms | 0.766 | 55,077 |
| 10,000 | 10,000 | 5,000 ms | 0.753 | 57,756 |
| spread | 10,000 | 5,000 ms | 1.000 | 0 |

Onset is between 5,000 and 6,000 packets per impulse. This box's
`net.inet.udp.recvspace` is 786,896 bytes and each packet is roughly 150 bytes
on the wire, so the knee lands where a full receive socket buffer predicts it —
which is the direct reading of the mechanism, and a **pre-registered prediction
for the runner**: Linux defaults `net.core.rmem_default` an order of magnitude
lower than macOS, so the knee there should sit *well below* 5,000, and the 5,000
rung that stamped 0.998 on the runner should show a measurable
`RcvbufErrors` delta even though its delivery passed.

The arrival process confirms the shape: sampling `datagramsIn` every 2 s in arm
A gives 30 zero-samples out of 59 interleaved with samples of 3,000–4,300 — an
impulse train, not a 2,000/s stream.

The per-session ledger rules out the remaining alternatives: no session was
silent (0 of 10,000), the loss is neither a prefix (7,641) nor a suffix (7,327)
effect but predominantly interior (48,735) — i.e. scattered through the window,
which is what per-burst overflow looks like and what a startup race or a
mid-window collapse does not.

## What this means for the session-scale axis and G1

The session-scale claim *"above 10,000, an unattributed datagram-loss mechanism
appears at trivial packet rate"* does not survive. The packet rate was not
trivial: it was a 10,000-packet instantaneous burst, and the rung's "2,000
datagrams/s" label describes a mean that the offered process never realized.
The rung is a **generator-shape artifact** in the sense the spec's G1 branch
pre-registered — per-stage taps account for 100% of the gap, and the server
observed and delivered 100% of what the kernel gave it — so G1 re-registers as
the server-side statement already written in the spec, with the client-side
loss excluded and disclosed.

That is not the same as saying nothing was learned about the product. The
mechanism is real and is worth a name: **a synchronized fleet-wide report burst
larger than the receive path can absorb loses datagrams before QUIC ever sees
them, and no server-side metric can tell you it happened.** Wall-clock-aligned
telemetry — the GPS scenario G1 exists for — produces exactly this shape. The
honest engineering statements are:

1. The server-side ingest path is clean at 10,000 sessions. Nothing in the
   native queue, the governor or the N-API boundary lost a datagram in any arm.
2. Burst tolerance is a distinct axis from mean rate and is currently
   unmeasured. It is bounded by the UDP receive socket buffer, which this
   library never sets.
3. A deployment whose clients report on aligned wall-clock boundaries should
   either jitter its clients or size the server's receive buffer for the
   impulse. Neither is in the product today.

## Follow-ups this produced

1. **Runner confirmation, one dispatch.** Arms A–D on the 4 vCPU heavy runner,
   where `/proc/net/snmp` `RcvbufErrors` and the per-socket `drops` column are
   live. Locally, macOS has no `/proc`, so stage 3 is attributed by elimination
   plus the client's congestion-controller evidence rather than by a direct
   kernel counter. This is the only thing separating the attribution from a
   stamped result.
2. **`SO_RCVBUF` is not settable through the public API.** If burst tolerance
   becomes a supported property, the socket buffer is the knob, and it should be
   measured before it is exposed.
3. **`datagramsSkippedQueueFull` should be surfaced next to `datagramsDropped`
   in any harness that claims "no drops"** — it is a separate counter and the
   session-scale run's zero-drop claim was made without it.
4. The load generators in `tools/load/` all release sessions from a single phase
   signal. Any future axis that reports a mean rate at high session count is
   reporting an impulse train unless it staggers, and should say which.
