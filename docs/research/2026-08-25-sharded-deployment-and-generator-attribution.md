# Sharded deployment, generator attribution, and the emitter cost structure

**Date:** 2026-08-25 · **Status:** measured characterization (artifacts
retained); the registered companion is gate `g6-sharded/1`
(`docs/research/preregistrations/gate-g6-sharded.md`). Branch
`probe/g6-pace-drain-01`.

This document is the authority for three findings produced in the day
following the terminal stamp of gate `g6-mmo-closeout/1` (valid MISS at the
registered MMO shape on the home rig). None of them reopen the stamp; one of
them corrects its mechanism ticket's attribution (see the amendment beside
the ticket).

## 1. The home rig's 5000-session collapse was environment, not software

Wire-boundary packet accounting around a sharded 2×5000 steady arm (hardware
NIC counters on both ends of the cable, differenced across the run):

| layer | packets (120 s steady) |
|---|---|
| client QUIC ledger, sent | 5,600,537 |
| generator NIC → wire | 3,350,603 |
| wire → server NIC | 3,350,572 (Δ 0.001 %) |
| client QUIC ledger, lost | 2,333,563 |

The generator Mac's NIC path dropped **~40 % of the client's egress below its
own UDP socket** (after `sendmsg` success, invisible to the client's ledger)
and **~14 % of the downstream on receive** under full-duplex load. The cable
was clean to 31 packets in 3.35 M. The preflights had certified each
direction *alone*; the cleanliness did not transfer to the loaded regime —
hence the now-mandatory bidirectionally-loaded preflight leg.

Confirmation by substitution: the identical workload against the same server
code on a Linux-generator rig (2× DO `c-32-intel`) measured **ingest 1.0000
exact** at 5000 sessions — single-instance included — with every stamped
clause passing by wide margins.

## 2. The intended deployment shape works, and its envelope on a rentable rig

All product hooks (`reusePort`, `reusePortSteering`, `quicLb`, the
`steer_by_cid` eBPF example) compose into a working 16-shard single-port
deployment: the example compiles and passes the verifier (two build fixes:
multiarch include path, bpftool byte-token quoting), fresh handshakes
distribute via the kernel fallback hash, short-header packets steer by
connection-ID server-id (proven by `steer_stats`, which is the only counter
that can see a silent fallback).

Envelope on 2× `c-32-intel` (AMS3 VPC, registered MMO shape, before the
emitter fix of §3):

| sessions (shards) | ingest | emitter duty | ack RTT p99 | server cores/32 |
|---|---|---|---|---|
| 5000 (1) | 1.0000 | 100 % | 8.13 ms | 2.7 |
| 5000 (4) | 1.0000 | 100 % | 2.52 ms | 4.5 |
| 10000 (4) | 1.0000 | 100 % | 6.45 ms | 7.5 |
| 15000 (8) | 1.0000 | 100 % | — | 13.3 |
| 20000 (8) | 0.9998 | 98.5 % | — | 16.8 |
| 25000 (16) | 0.9993 | 93.8 % | — | 24.1 |
| 50000 (16) | 0.959 | 42 % | — | 28.6 |
| 100000 (8) | 0.569 | ~16 % | — | 28.3 |

Sharding's measured wins: **tail latency** (8.13 → 2.52 ms p99 at 5000 across
1→4 shards) and **ingest resilience** (+4.5 pp at 50k with 16 shards vs 8).
Overload degradation is graceful: at 100,000 sessions (99,994 connected) the
box shed throughput, not sessions — 23 lost of 100k, no crash.

## 3. The emitter cost structure: allocation churn was the wall

The snapshot emitter's per-tick cost was dominated not by Node-API crossings
but by **buffer construction**: three fresh 1150 B allocations plus full-body
copies per player per tick. Reusing per-player buffers (body filled once,
40 B stamp rewritten per tick — licensed by both native send paths copying
synchronously inside the call) moved the same box to:

| sessions (16 shards) | duty before | duty after | ingest after |
|---|---|---|---|
| 25000 | 93.8 % | **96.8 %** | 1.0000 exact |
| 30000 | 84.2 % | **95.2 %** | 1.0000 exact |
| 50000 | 42 % | **76.5 %** | 0.970 |

with ~6 cores freed at 25k and packet losses down three orders of magnitude
at the lower rungs.

The paced-mirror lane (dedicated native send thread) was measured against
the same rungs and is **not** the throughput lever at this scale: duty
parity, higher CPU, and at 50k its 32-datagram clumps overran the send path
(delivery 0.894 of issued). Its real wins remain tail latency and JS-thread
relief on low-core hosts. Consequently the "move generation fully native"
step was **not built**: in paced mode JS generation is already O(1) per
slice, and the residual constraint at 750k pps is native transmission and
the kernel, not generation.

## 4. Product notes

- The send paths' synchronous-copy semantics (`prepare_batch`, the mirror's
  one-copy-for-the-fan-out) are what license zero-allocation callers; this
  deserves an explicit note in the public docs.
- `mmo-client`'s per-endpoint `127.0.x.1` source-alias trick is
  co-resident-only: macOS fails those binds (accidental fallback made off-box
  runs work); Linux binds them successfully and routes nothing. Off-box
  Linux generators need `--bind-default`.
- `reusePortSteering` is shipped and load-proven but undocumented;
  `docs/OPERATIONS.md` and `docs/quic-lb.md` still describe the socket-fd
  gap as unclosed. (Recorded follow-up.)

## Artifacts

`.scratch/do-rig-2026-08-25/` (28 files: preflights, sink, ladder, max-hunt,
16-shard head-to-heads, emitter matrix) in the main worktree; scan tooling
`tools/load/g6-shard*.ts`, `g6-sharded-scan.ts`, `g6-sharded-grade.ts`.
