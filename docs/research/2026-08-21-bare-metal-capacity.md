# webtransport-bun on bare metal — capacity, latency, and deployment

**Status: COMPLETE (2026-08-22).** This is the bare-metal campaign's terminal
document (campaign ticket 09). Every gate has a terminally accounted disposition;
that disposition may be a run verdict or an explicitly closed no-run state.
Nothing here is a forecast. Every number carries the stamp it was recomputed
in, and where a number does not exist, this document says so rather than
estimating one.

G9 is a final **PASS at 600 sessions/s**. The remaining terminal exceptions are
G2's **hardware-scoped INCOMPLETE, FINAL**, G6's
**registered-never-dispatched / NO-VERDICT, FINAL** disposition, and G11-T's
dual reading **C6-app MISS (final) · C6-wire PASS**. These are reported with
the same weight as the passes: the campaign's bar was *"every gate reaches a
terminally accounted disposition"*, not *"every gate passes."*

## The rig every number below belongs to

`gravvene-dev-home`: a 4-core / 8-thread bare-metal Linux box, 12,687,056 kB
MemTotal (~12 GB), `performance` governor throughout, with the box's resident
`docker` and `tailscaled` duties up during every run. Unless a chapter says
otherwise, generator, sink and server were **co-resident on this one box over
loopback**. Co-residence is not a detail: several campaign walls turned out to
be the instrument, not the product, and the chapters say which.

Numbers measured on the earlier 4-vCPU VM rig are **not** carried forward into
this document. Where a gate has both, the bare-metal figure is stated as a
topology change, never as a delta.

---

## The verdict ledger

Every row is final. Campaign stamp paths are relative to
`.scratch/bare-metal-campaign/` (gitignored campaign scratch on
`rebind4-staging`); each stamp recomputes its clause values off-runner from raw
artifact fields and records the shipped classifier's output only as
corroboration.

| Gate | Verdict, in one line | Stamp |
|---|---|---|
| **G1 — GPS session scale** | **PASS**, all five clauses: 10,000 sessions, ingest p99 **2.576 ms**, delivery **1.000000**, memory **~126.5 KB/session** linear | `stamps/g1.md` §9.6 |
| **G2 — FPS/MOBA tail latency** | **hardware-scoped INCOMPLETE, FINAL** after the two licensed valid attempts: F-off raw RTT p99 medians **12.632064 ms** (attempt 1) and **9.289728 ms** (attempt 2), each above the fixed 4.0 ms `path-not-quiet` bar. No gate PASS/MISS statistic exists because the gate had no evaluable cells; no third attempt or lower bar is authorized | `stamps/g2.md` §9.10.3, §9.10.6 |
| **G3 — camera / bursty egress** | **PASS, with C3 = `CEILING-MOVED`**: egress one-way p99 **1.491 ms** (median of 5 blocks) against a 33.3 ms bar; GSO **and** GRO active at 64 segments, `sndbufErrors` 0 on all 30 steps. C3 states no lever value in milliseconds — for the third time across three registrations | `stamps/g3.md` §9.6, C2/C4 |
| **G4 — SFU fan-out** | **PASS**: **16,509/s** forward egress inside a 30 Hz frame gate, p99 **10.879 ms**, delivery **1.0000**. Stated as a *rate* bound — "the 50 is incidental to that number, not causal" | `stamps/g4.md` §9.6 |
| **G5 — bulk / VOD** | **PASS**, all six clauses, graded on the knob-**on** `P-batch` cell: **1.2505 Gbps** delivered against a 1.000 Gbps bar, sourcing 100.037% of its registered 1.25 Gbps offer. Separately — disclosed, not gating — the knob-**off** `P-control` cell delivered **1.1473 Gbps**, falsifying the registered prediction that knob-off would fall short of 1.000 Gbps. The unpaced `A6` window probe is **force-stripped** and licenses nothing | `stamps/g5.md` §9.6 clause 2, §6 P5 |
| **G7 — stream egress** | **PASS, unnarrowed** (the C4-closure redispatch upgraded G7-01's "PASS — narrowed by C4 NOT-EVALUATED"): **1.2498 Gbps** at 16 streams × 64 KiB, byte- and stream-ledgers exact, and client receive-socket drops a *measured* **0** in all 14 cell-repeats | `stamps/g7-02.md`; run-1 record at `stamps/g7.md` |
| **G8 — many-rooms fan-out** | **PASS, narrowed to one cell of nine**: **2** concurrent 10-subscriber video rooms at 330/s per publisher, p99 **3.740 ms**, forward delivery **0.99995**. Eight of nine cells INVALID; the voice and mutual arms produced no room count at all | `stamps/g8.md` §9.6 |
| **G9 — sustained churn** | **PASS at 600 sessions/s, FINAL** (`licensedRung(600)`): L-600 achieved **595.75 / 596.01 sessions/s** against the **594/s** bar, base RTT p99 **7.09 / 12.60 ms** against 40 ms, delivery **0.99952**, zero leaked sessions/handles, and LIM PASS | `stamps/g9-02.md` §2, §4, §7 |
| **G11 arm X — exchange** | **PASS**: **60,000/60,000** exchanges at 1,000 sessions, RTT p99 **27.25 ms** raw against 50 ms, server-side accepts equal to attempted opens, host CPU median **25.6%** | `stamps/g11.md` §2 |
| **G11 arm D — coupling** | **COUPLING-ABSENT** — a verdict-free reading: the registered choke did not appear, so the arm reports rather than grades | `stamps/g11.md` |
| **G11 arm T — bidirectional throughput** | **C6-app MISS (final) · C6-wire PASS**: native-wire p99 **17.25 / 12.25 ms** against 25 ms; the successor's native transport/read path holds the interaction budget, while the parent's JS application surface does not. The parent 348 / 328 ms app-level reading is attributed to deframe-loop/read-side scheduling, not transport; the successor drain sits only ~3–4 ms above wire | `stamps/g11-t2.md` §2, §6 |
| **Paced broadcast (the G10 successor)** | **PASS — narrowed by C2 NO-VERDICT (V-SP)**: 5,000 sessions × 5 Hz, delivery **0.997859 / 0.997617 / 0.998633** with margin, RTT p50 **0.834 / 0.792 / 0.763 ms**, stall lever **−44.71 ms** median. The spread clause renders no verdict because its measuring instrument lost its licence that day | `stamps/paced-broadcast.md` |
| **Deployment** | Not a gate — the operator-facing architecture chapter, written and reviewed | this document, below, + `2026-08-21-load-balancing-architecture.md` |

**G6 terminal disposition (no run):** the canonical registration page
(`registrations/g6-mmo-02-redispatch.md`) is closed as
**`registered-never-dispatched / NO-VERDICT, FINAL`**. V-C was clear at RTT p99
**4.745 ms**. V-S genuinely fired at **116,249.37496815059 < 116,250** (the
delivery ratio was `1`, and `precheckOriginatorSaturated` was `false`). V-F was
unusable because the registered candidate's parser rejected the actual
`mmo-client/1` envelope. There is no dispatch, run identity, or G6 stamp;
cleanup/lock/process proof is unretained and unproven. Parser repair
`883059bb9940db9d22b3fa58ca199697ea1f68e1` was reviewed/pushed but is
**UNCONSUMED**, not a G6 candidate or rerun authority. No rerun or dispatch is
authorized without new explicit maintainer authority.

G9's stamped F-1 finding concerns admission refusals under concurrent ramps;
see [OPERATIONS.md §Admission control: refusal is load-shaping, not rejection](../OPERATIONS.md#admission-control-refusal-is-load-shaping-not-rejection)
for the existing refusal/retry policy. This document does not duplicate that
policy.

**G6-sharded diagnostic (evidence, not a verdict):** the
`g6-sharded-02` 20k refused-final (3 connect errors, 11,767
`kernelMarks.connect.NoPorts`) was re-investigated on a fresh DO
`c-32-intel` rig with the producer/grader **byte-identical** to
`c9586585` and a non-graded conductor diagnostic surface
(`g6-sharded-diagnostic/1`, branch `probe/g6-sharded-diagnostic-01` @
`ff9e25be`). Three rungs (5k/15k/20k) on a same-VPC, Linux-generator,
16-instance BPF rig: 0 connect errors at every rung, 0 shard exits in
the connect-phase window, `steer_stats` fallback = 0, but
`kernelMarks.connect.{InErrors,RcvbufErrors}` step **0 → 3,117 →
12,920** and `SndbufErrors` steps **0 → 10 → 2,329** with rung size.
**D1 (per-shard transient shutdown) and D2 (BPF CID-race) are ruled
out**; the most consistent reading is **D3 — kernel UDP socket
buffer pressure**. The parent's 11,767 `NoPorts` did not reproduce
on this topology; that failure mode was likely macOS-specific.
A `g6-sharded-03` registration is licensed to tune
`net.core.{r,w}mem_{max,default}` and `net.ipv4.udp_{rmem_min,wmem_min,mem}`,
and to set `SO_RCVBUFFORCE / SO_SNDBUFFORCE` on the server's QUIC
socket, before the next 20k dispatch. Stamp:
`.scratch/bare-metal-campaign/stamps/g6-sharded-diagnostic-01.md` (on
`probe/g6-sharded-20k-01`).

**G6-sharded-03 (the D3 fix, evidence only — no S1–S5 re-stamp):**
`g6-sharded-02` was re-dispatched at 20k on a fresh DO `c-32-intel`
rig with the same candidate and producer/grader, and the only change
being kernel UDP socket buffer tuning on both droplets
(`net.core.{r,w}mem_{max,default}=26214400`,
`net.ipv4.udp_{rmem_min,wmem_min,mem}="26214400 26214400 26214400"`).
**PASS-by-D3-fix, all five registration criteria met at 20k**:
sessionsAtSteady **20,000 / 20,000 (100.00%)**, `connectErrorsSample`
**null** (0 errors), `connectWallSec` **3.00s** (was 300.76s in the
diagnostic), `kernelMarks.connect.NoPorts` **5** (was 16 / 11,767 in
the parent), `InErrors` **0** (was 12,920 in the diagnostic),
`RcvbufErrors` **0** (was 12,920), `SndbufErrors` **0** (was 2,329),
`InDatagrams` **448** (was 22,410,076 — the diagnostic was retransmitting
~50,000× per datagram). 0 of 16 shard exits in the connect window.
**D3 is the right reading of g6-sharded-diagnostic-01**. The fix is
**kernel-side only** — no server code change, no `SO_RCVBUFFORCE`
required (the 25 MiB sysctl ceiling is high enough for `SO_RCVBUF` to
reach it without FORCE). A separate **g6-sharded-04** registration is
licensed to re-stamp the S1–S5 clauses on the same rig to issue a
terminal verdict on g6-sharded-3. Stamp:
`.scratch/bare-metal-campaign/stamps/g6-sharded-03.md` (on
`probe/g6-sharded-20k-01`).

**G6-sharded-04 (50k headroom, evidence only — no S1–S5 re-stamp):**
the kernel-tuning fix was re-tested at **50,000 sessions** on a fresh
DO `c-32-intel` rig, with the same candidate and producer/grader.
**PASS-by-D3-headroom, all five registration criteria met at 50k**:
sessionsAtSteady **49,999 / 50,000 (99.998%)**, `connectErrorsSample`
**null** (0 errors), `connectWallSec` **7.08s** (2.36× the 20k value,
~100× < the 300s cap, scaling linearly with the 2.5× session count
under the connect-concurrency=500 cap), `kernelMarks.connect.NoPorts`
**2**, `InErrors` **0**, `RcvbufErrors` **0**, `SndbufErrors` **0**,
`InDatagrams` **432** (clean, every datagram landed first time). 0 of
16 shard exits in the connect window. **The 25 MiB UDP buffer ceiling
× 16 shards = 400 MiB aggregate gives 50k the same clean kernel profile
20k had.** The D3 fix is **headroom-licensing at 50k**, not just at
20k. A separate **g6-sharded-05** is licensed to re-stamp the S1–S5
clauses on the same rig at 50k to issue a terminal verdict on
g6-sharded-3's clauses. Stamp:
`.scratch/bare-metal-campaign/stamps/g6-sharded-04.md` (on
`probe/g6-sharded-20k-01`).
`probe/g6-sharded-20k-01`).

**G10 itself is not in this table.** Its VM-era MISS was ruled final for that
rig, and the paced-broadcast gate supersedes its scenario on this one — the
chapter below explains why that is a supersession rather than a re-run.

---

# Deployment

This chapter answers one question: *how do you run more than one of these?*
The short answer is that you run **N independent instances** and give each one
its own name — a port, an address, or (later) a connection-ID prefix — and you
do **not** put a 4-tuple-hashing balancer in front of them.

The architecture reasoning behind this chapter, with the code-level hook
inventory, is `docs/research/2026-08-21-load-balancing-architecture.md`. This
chapter is the operator-facing part of it.

## 1. Sizing — an upper bound of unknown tightness

**Read this before the numbers.** Every per-instance envelope below was
measured with the generator, the sink, and in the G11 case the *conductor*
co-resident on the same box as the server. The conductor's share of the box was
sampled per-thread only once (ticket 10) and has never been separated from the
server's share in a controlled way. Consequently:

> **The per-instance figures below are upper bounds on what one instance costs,
> of unknown tightness. The share attributable to the harness is UNMEASURED.**
> A production instance, with no harness in the process and no generator on the
> box, will cost *less* than these figures by an amount this campaign has not
> quantified. Size from host-level envelopes where one exists, and treat the
> instance count as something you verify on your own hardware.

There is no defensible "instances per core" constant in this campaign's data,
and this document does not publish one. What the data does support:

**An instance is not a thread.** Under G11's bidirectional load the measured
process — server **plus** the co-resident conductor — sat at **~317% of one
core**, of which the single Bun JS thread was **93–95%** (ticket 10's
per-thread sampler, `evidence/g11/g11-inv-t100.threads.tsv`; the ticket's
companion figures, addon threads ~61% and tokio workers ~9%, are *per thread*
and not a partition of the total — see the instrument chapter). The conductor's
JS thread is known to be the *dominant* single consumer in that sample and it
is harness code. The honest reading is therefore: **a loaded instance is a
multi-thread process costing well over one core and probably under three**, and
the campaign cannot currently say where in that range. Planning one instance
per hardware thread is refuted by the shape of that measurement even though its
magnitude is contested; planning a small number of instances per box and
measuring is not.

**Host-level envelopes, per instance, as stamped.** These are what one instance
on this rig actually delivered, each with the whole box behind it:

| Envelope | Measured | Host cost at that point | Stamp |
|---|---|---|---|
| Stream egress, 16 streams @ 64 KiB writes | **1.2498 Gbps**, byte- and stream-ledgers exact | not recorded per cell; the run's maximum `hostCpuPctMedian` was **79.1%**, on cell **B-1k**, not on this one | `g7.md` C2 for the rate, `g7.md` C1 for the CPU maximum; reproduced 1.2498 in `g7-02.md` |
| One-way p99 across **1,000** token sessions | **5.112 ms** raw (uncorrected) | same run | `g7.md` C7 (`g7-02.md`: 4.16 ms) |
| Client receive-socket drops at that load | **0**, measured, all 14 cell-repeats | — | `g7-02.md` C4 |
| Request/response exchange, **1,000 sessions** | **60,000/60,000** exchanges, RTT p99 **27.25 ms** | **25.6%** of the box | `g11.md` §2 (arm X) |
| GPS-shaped session scale | **10,000 sessions**, ingest p99 **2.576 ms**, delivery 1.000000 | rung classified `ok` | `g1.md` C1/C2 |
| Per-session memory, 1k → 10k sessions | **~126.5 KB/session**, linear (5k→10k slope within 0.48% of 1k→5k) | — | `g1.md` C3 |
| Forward fan-out egress | **16,509/s** inside a 30 Hz frame gate, p99 **10.879 ms**, delivery 1.0000 | — | `g4.md` (stated as a **rate** bound, not a fan-out bound) |
| Bursty / frame-shaped egress | egress one-way p99 **1.491 ms** median of 5 blocks, bar 33.3 ms | GSO **and** GRO active, 64 segments; `sndbufErrors` 0 on all 30 steps | `g3.md` C2/C4 |
| Bulk / VOD paced throughput, batching knob **on** — the graded cell | **1.2505 Gbps** delivered against the 1.000 Gbps bar, at **100.037%** of the registered 1.25 Gbps offer; 42,599 B per crossing | host CPU median **34.31 / 34.37%** | `g5.md` clause 2 (throughput), clause 4 (crossing size), clause 1 (CPU) |
| The same shape with the knob **off** (`P-control`) — **disclosed, not gating** | **1.1473 Gbps** (median of 1149.6238 / 1144.9751 Mbps), sourcing only **91.6–92.0%** of the offer — `paced-shortfall` fired on both repeats | host CPU median 73.79 / 73.49% | `g5.md` §6 P5 — and note this *falsified* the registered prediction that the knob-off default would fall short of 1.000 Gbps, which the stamp calls the headline finding of the run |
| Window-binding probe, **unpaced** — **INCOMPLETE, not a licensed result** | `A6-shipped` **1.1362 Gbps**, `A6-raised` **1.2049 Gbps**, ratio **1.0604** — read as `WINDOWS-NOT-BINDING`, **but the stamp force-strips it** | `A6-raised` is the only cell in the run with non-zero **server** receive-socket drops: **1,564** and **1,797** on its two repeats (`A6-shipped` was `[0, 0]`, as was every other cell), corroborated exactly by kernel `udp.rcvbufErrors` | `g5.md` §"A6 at the chosen default — force stripped by §4.2" (both `A6-raised` repeats carry the sustained-throttle flag), drops from `g5.md` clause 6 |
| Many-rooms fan-out | **2 concurrent 10-subscriber video rooms** at 330/s per publisher, p99 **3.740 ms**, forward delivery 0.99995 | co-resident generator + sink + VPN + Docker | `g8.md` — and note this licenses *two rooms*, nothing more; eight of nine cells were INVALID |

**The bulk rows are different cells and their numbers do not divide into each
other.** 1.2505 Gbps is the knob-on `P-batch` cell the gate is graded on;
1.1473 Gbps is the knob-off `P-control` cell, which the stamp's clause 1 marks
*"disclosed, not gating"*; the 1.0604 ratio is the *unpaced* `A6` pair. An
earlier revision of this table put 1.1473 and 1.2049 on one row under one
ratio, which is a comparison between two different offer regimes — and the
quotient of those two published numbers is 1.050, not the 1.06 the row claimed.
The ratio that means anything is `A6-raised / A6-shipped` = 1.2049 / 1.1362 =
1.0604, and it is force-stripped, so nothing may be concluded from it.

**The bulk throughput figure this document licenses as a graded result is the
1.2505 Gbps knob-on one.** The 1.1473 Gbps knob-off figure is licensed only as
what the stamp makes it: a disclosure, and the falsification of P5. Neither
number may be read as the other, and the knob-off cell did not source its full
offer where the knob-on cell did.

**Memory scales with sessions, not with instances.** At ~126.5 KB/session
linear to 10,000 sessions, the instance count barely moves a memory budget.
Sessions do.

**The one wall that is a product property, not an instrument property.** G7's
B-1k cell is originator-bound in both repeats: the single-threaded JS write
originator sources ~**63.3k writes/s** at 1 KiB and cannot reach the offered
152,588 writes/s. The same family of finding appears in G11's T arm and in the
four-axes egress result. If your workload is many small writes from JS, that
thread — not the transport — is your ceiling, and the fix is more instances,
not a bigger one.

## 2. The supported pattern: rung 1 — DNS and ports

**N instances, N ports (or N addresses). No balancer process.** Assignment is
client-side, by DNS (multiple SVCB/HTTPS records, weighted or Geo records, or
per-tenant hostnames), or by your application's own rendezvous — the token
server, the room server, the lobby — handing the client the exact endpoint URL.

This is the pattern this project supports today, and it is supported because it
is the only one whose failure modes are entirely in your hands:

- **Rebind-safe by construction.** The port *is* the instance identity. A NAT
  rebind changes the client's source address; the destination does not move, so
  the connection lands on the same instance and QUIC's own migration handling
  takes it from there.
- **Nothing new in the packet path.** No extra hop, no extra copy, no steering
  program to get wrong.
- **Draining is already a product feature** — capsule-driven close, wire-driven
  draining, `WT_SESSION_GONE` teardown (`crates/native/src/session.rs`). Stop
  handing new clients a draining instance's URL and it empties.

The cost is coarseness: client-side distribution has no load feedback unless
your assigner is load-aware, and browsers must be given the exact URL. For the
deployment shapes this product is actually measured against — rooms, tenants,
fleets, GPS populations, all of which already have an application-level
rendezvous — that is usually sufficient, and it is the honest first rung.

## 3. Unsupported: 4-tuple-hash balancers in front of long-lived sessions

> **Plain `SO_REUSEPORT` kernel steering, plain ECMP, and any L4 balancer that
> hashes the UDP 4-tuple are UNSUPPORTED for long-lived-session deployments of
> webtransport-bun.**

The reason is structural. A TCP connection *is* its 4-tuple; a QUIC connection
deliberately is not — it is named by its connection IDs precisely so it can
survive an address change (RFC 9000 §5.1, §9). Hash the 4-tuple and you have
bound the connection to exactly the property QUIC was designed to let go of.
When the client's address changes — an ordinary NAT mapping expiry, a Wi-Fi to
cellular handover, a deliberate migration — the hash changes, the packets are
delivered to a **different backend**, and that backend has never heard of those
connection IDs.

**Provenance of this claim, stated plainly: it is a deduction, not a
measurement.** This project owns no NAT-rebind test. The word "rebind" in this
repository's history means a *release-evidence* rebind — re-pointing a
candidate at regenerated evidence — and an earlier revision of the analysis
document mistakenly welded the two together. That error is corrected. The
deduction is standard and load-bearing, but nobody here has watched a 4-tuple
balancer drop a session, and this document will not pretend otherwise.

### What actually happens on a mis-steer — verified in quinn-proto 0.11.16

The mechanism matters, because the intuitive guess ("the client gets reset and
reconnects quickly") is **wrong**, and wrong in the expensive direction. Traced
against the source this tree locks (`Cargo.lock:894-895` → quinn-proto
**0.11.16**):

1. **The wrong backend does try to reset.** A short-header packet whose
   destination CID matches no local connection falls through
   `Endpoint::handle` to `stateless_reset(...)`
   (`quinn-proto-0.11.16/src/endpoint.rs:260-262`). Two filters can swallow it
   first: a custom `ConnectionIdGenerator::validate` (`endpoint.rs:249-253`;
   the trait's default returns `Ok(())`, `cid_generator.rs:22-25`), and a rate
   limit — one reset per `min_reset_interval` per endpoint
   (`endpoint.rs:274-280`). Under a fleet-wide mis-steer, that rate limit alone
   means most stranded flows get **no** reset at all.
2. **The reset it sends is unusable by the client.** The token is
   `ResetToken::new(&*self.config.reset_key, dst_cid)` — HMAC'd with **this
   process's** reset key (`endpoint.rs:315`), and reset keys are random **per
   process** (`config/mod.rs:186-189`). The original backend advertised a token
   derived from *its* key (`endpoint.rs:618`, `:629`, `:400`).
3. **The client therefore discards it.** A client identifies a stateless reset
   solely by matching the datagram's trailing 16 bytes against the token it was
   given: routing looks it up in `connection_reset_tokens` keyed by
   `(remote, token)` (`endpoint.rs:1101-1108`), and even if it reached the
   connection, recognition is the byte comparison at
   `connection/packet_crypto.rs:41-42`. A foreign key produces a foreign token,
   both checks fail, and the datagram is dropped as unroutable. The
   `ConnectionError::Reset` path (`connection/mod.rs:2278-2280`) is never
   entered.

**The verified mechanism, then: a 4-tuple mis-steer does NOT kill the
connection quickly. It STALLS it.** The client keeps sending into a backend
that will never answer; the connection dies only at idle timeout. On the server
that is **60 s by default** (`crates/native/src/limits.rs:47`, always applied
at `crates/native/src/lib.rs:761-763`, floored at 1000 ms by the parser at
`limits.rs:101`, and negotiated down by whatever the peer advertises), with
keep-alive pings **disabled by default** (`limits.rs:48`, `limits.rs:317-318`)
— so nothing probes the dead path early. Server-side the stall is therefore
bounded, at roughly a minute of silence per stranded session. The *client*
configuration in this tree does support `idleTimeoutMs = 0` as unbounded,
"matching quinn's raw default" (`crates/native/src/client.rs:775-786`); a peer
configured that way and steered into the wrong backend hangs until something
else tears it down. Either way, a minute of a silently dead session is worse
operator UX than a prompt failure, and worse for the user than the reconnect
they would otherwise have had.

The architect's prior expectation was the opposite — immediate death by
stateless reset. That expectation is only correct **if every instance shares
one reset key**, which is exactly why a shared reset key is the conditional
future feature it is (out of scope here) and not a default. Per-process random
reset keys are also precisely why a `SO_REUSEPORT` group's cross-process resets
are invalid: sibling processes on the same port cannot reset each other's
connections either.

**When 4-tuple hashing is nonetheless fine:** short-lived connections, clients
on stable networks (datacenter-internal east-west), or fleets where a
rebind-priced reconnect is genuinely tolerable. It is the wrong default for
this product's headline scenarios, which are all long-lived.

## 4. Four disclosures you must read before deploying any steered pattern

These are not caveats appended for form. Each one is a way a working
deployment breaks.

**(a) Changing a reuseport group's membership REHASHES it.** The kernel's
reuseport steering distributes over the *current* set of sockets in the group.
Add or remove one — which is what a rolling restart, a crash, or a scale-up
does — and surviving flows are re-steered **fleet-wide across the box**, not
just the ones belonging to the departing instance. On a plain (unsteered)
reuseport group this converts one instance restart into a box-wide session
event. An eBPF `SK_REUSEPORT` steer avoids the rehash only if the operator
maintains the `BPF_MAP_TYPE_REUSEPORT_SOCKARRAY` index across restarts, which
is the hard part of that pattern and is entirely the operator's problem. This
project has not measured rehash behaviour on any target kernel.

**(b) The first flight is unroutable by CID, always.** A client's Initial
packet carries a destination CID the **client** chose at random; the server has
not issued anything yet. No CID-based steer — eBPF, QUIC-LB, or otherwise — can
route that packet by server ID, so every such scheme falls back to 4-tuple
hashing (or to a consistent hash of the client-chosen CID) until the client
adopts a server-issued CID. A rebind occurring inside that window still breaks
the connection. The window is short, and it is not zero.

**(c) Keyless QUIC-LB CIDs publish your fleet topology in cleartext.** The
keyless (key-optional) configuration of **draft-ietf-quic-load-balancers-21**
— the revision both implementations are pinned to — puts the server ID into the
connection ID unencrypted, where any on-path observer reads it. The draft warns
about this in its own words, §5.3, quoted verbatim:

> failure to define a key means that observers can determine the assigned
> server of any connection, significantly increasing the linkability of QUIC
> address migration.

(The same sentence is quoted at `crates/native/src/quic_lb.rs:43-45`.) The
routing bits are additionally constant across every CID the connection ever
uses, which is a linkability signal the QUIC CID design otherwise denies
observers. A keyed
configuration is the remedy, is the same wire format, and is not implemented
here. Deploying keyless is a deliberate topology disclosure.

**(d) There is no NAT-rebind measurement in this project.** No gate, no soak,
no test exercises a client address change. Chapter 3's argument is a reading of
RFC 9000 and of quinn-proto's source. It is sound; it is not evidence this
project owns.

## 5. The roadmap, and what the two hooks buy

Two small product hooks are being added. Neither is a balancer; each is a
primitive that lets a *standard* balancer do its job.

**Hook 1 — `reusePort` socket injection.** A server option that builds the UDP
socket with `SO_REUSEPORT` before handing it to the transport, using the fork's
existing `with_bind_socket` entry point. On its own this gives you plain
kernel 4-tuple steering, which chapter 3 just declared unsupported for
long-lived sessions — so the flag exists **for eBPF-steered topologies and for
bench harnesses**, and its documentation says so at the option. Disclosure (a)
applies to every use of it.

**Hook 2 — CID server-ID generation.** A `ConnectionIdGenerator` that embeds a
configured server ID in the CIDs the instance issues, installed through the
fork's `quic_endpoint_config_mut()`. This is the one primitive that unlocks
both higher rungs, because it makes the connection's own stable name carry the
routing key.

With those two, the ladder becomes:

| Rung | What routes | Rebind-safe? | Status |
|---|---|---|---|
| **1. DNS / ports** | the client, or your rendezvous | **yes** — the port is the identity | **supported today** |
| 2. Anycast + ECMP alone | routers, 4-tuple hash | **no** | unsupported for long-lived sessions |
| 3. `reusePort` + `SK_REUSEPORT` eBPF CID steer | the kernel, by server-ID bytes in the CID | yes, after the first flight | needs hooks 1 + 2; eBPF program shipped as a **reference example, not a component** |
| 4. QUIC-LB L4 balancer across machines | a stateless external balancer, by CID | yes, after the first flight | needs hook 2; balancer is third-party |

Rungs 3 and 4 compose recursively on one CID format: outer bits pick the
machine, inner bits pick the instance on that machine
(draft-ietf-quic-load-balancers §7.2, server process demultiplexing).

**Explicitly not being built:** an L7 balancer product, a JS/Bun UDP forwarder,
or in-process multi-core scheduling. Each is refuted by a number this campaign
has already paid for — an L7 relay built from this product pays its own
measured ceilings twice per byte and bottlenecks on the very JS thread the
campaign keeps finding, and a JS forwarder recreates that thread in front of
the fleet it exists to scale. The analysis document prices all three.

**Also not in scope:** a shared fleet-wide reset key (see chapter 3 — it is the
thing that would convert the stall into a prompt failure, and it is conditional
on fleet-failover UX ever demanding it), and encrypted QUIC-LB CIDs.

## 6. Not verified here — the maintainer's disclosure list

Carried into this document as required, and extended by the review that
produced it:

- **rustls ticket-key sharing depth in the fork.** 0-RTT resumption is a
  per-process store (`crates/native/src/zero_rtt.rs:222`); a client landing on
  a different instance falls back to a full handshake, which is correct and
  merely slower. Fleet-shared ticket keys would need rustls ticketer plumbing
  that is **not exposed today**. The depth of that work is unexamined.
- **eBPF verifier constraints on the target kernels.** Unknown. The reference
  steering program ships marked as not compiled and not tested.
- **QUIC-LB draft version currency.** Cited as draft-ietf-quic-load-balancers;
  the revision is pinned by the CID hook's author when that hook is designed,
  and the pinned revision is recorded in the code and in the docs. Nothing in
  this chapter should be read as tracking a specific revision except where §5.3
  and §7.2 are cited above.
- **Bun-level `SO_REUSEPORT` interactions if the JS side ever owns the
  socket.** Today it never does — the addon owns it. If that changes, this is
  unexamined territory.
- **No NAT-rebind test exists in this tree** (disclosure (d) above).
- **Reuseport rehash-on-restart is not measured** on any target kernel
  (disclosure (a) above).
- **GSO/GRO survival on a socket2-built injected socket** is established by
  reading quinn-udp's code (`UdpSocketState::new` performs the setup downstream
  of injection), **not by measurement**. G3 confirms GSO and GRO active with 64
  segments on the *current* bind path (`g3.md` C4); nobody has yet measured the
  injected path.
- **macOS `SO_REUSEPORT` semantics** are asserted from man pages, not measured.
  BSD-family last-binder-wins behaviour differs from Linux's load distribution,
  and any distribution claim in this document is **Linux-only**.
- **The conductor's share of the ~317% per-process CPU figure** is unmeasured
  (chapter 1). This is the single largest source of looseness in the sizing
  guidance.

---

# Paced broadcast — one payload to five thousand sessions

**Verdict: PASS — narrowed by C2 NO-VERDICT (V-SP).**
Stamp: `stamps/paced-broadcast.md`. Registration:
`registrations/paced-broadcast.md`.

This is the campaign's largest single-server claim, and the one whose narrowing
matters most, so the narrowing is stated first and beside the number, not
below it.

## 1. What was measured

A fleet of **5,000 sessions** over the cable, taking a **5 Hz** broadcast
through the shipped `sendDatagramMirrorPaced` surface, at the pre-registered
`c32 @ 30k` pacer configuration with round-robin ordering. Three **paired**
blocks — control then paced, adjacent, by construction of the runner — run
box-side under `/tmp/bench.lock` on 2026-08-21, ≈16:05–16:34Z, composition
`val/pacer-03` @ `d779ad2f` (`stamps/paced-broadcast.md` §1).

The surface under test is the merged mirror path
(`crates/native/src/datagram_mirror.rs`), whose design is capped by a 1 ms
JS-stall budget it measures against. That cap is a **design statement**; what
follows is the gate result.

## 2. The stamped numbers

| clause | measured | verdict |
|---|---|---|
| **C1** delivery ≥ 0.995 | **0.997859 / 0.997617 / 0.998633**; 5,000/5,000 sessions, 0 failed, 0 lost, every cell | **PASS with margin** — min − 0.995 = 0.002617 exceeds the across-block range 0.001016, which is the §4.3 margin rule |
| **C2** spread p99 ≤ 200.669 ms | 441.97 / 389.55 / 169.08 ms measured — **but unlicensed** | **NO-VERDICT (V-SP)** |
| **C3′** paced RTT p50 ≤ 2.187 ms | **0.834 / 0.792 / 0.763 ms** — 2.6× under the bound, stable to 9% across blocks while the p99 tail swung 4.7× | **PASS** |
| **C4** stall lever | paired δ **−44.71 / −45.83 / −43.22 ms** (paced 1.686–1.800 ms against control 45.02–47.51 ms); **median −44.71 ms**, ≈26× stall reduction | **READING CONFIRMED** |
| **C5** control arm produced paired values | yes, all three blocks | **MET** |

Sub-millisecond medians at 5,000 sessions and 5 Hz, through a merged product
API, are the strongest latency figures this campaign produced at scale.

**The control arm is the lever's justification, disclosed rather than graded.**
The same offer, unpaced, delivered **0.9489 / 0.9434 / 0.9625** — the blast
sheds **4–6%** of what the paced path delivers whole
(`stamps/paced-broadcast.md` §2, C5).

**−44.71 ms is the lever's third independent confirmation.** The paced sweep
that preceded the gate measured −44.14 ms under a pairing that had drifted
(deviation D-a); the corrected, F3-honoring pairing reproduces it.

## 3. The narrowing: why the spread clause renders no verdict

C2's bound was ratified at **J = 0** — "overlap itself the failure", the
strictest form available (`registrations/paced-broadcast.md` §10, "Ratifications
of 2026-08-21"). Grading it requires a sink that can certify sub-ceiling
spreads, and on gate day the sink could not: the **V-SP** validity falsifier
fired in **all six cells** — worst burst drain 88.49 ms ÷ completeness 0.714 =
**123.94 ms** against a **106.76 ms** ceiling. That ceiling is computed per-run
by the harness as 1.2 × the run's own 88.96 ms net emission maximum; what the
registration derived is the V-SP *rule*, not this number. INVALID dominates
both PASS and MISS, so no
verdict is rendered in either direction. The measured 441.97 / 389.55 /
169.08 ms figures above are recorded, and they license nothing.

The failure was **the Mac sink's**, and it was independently attributed the
same day. On sweep day the same falsifier's input was 38.69 ms of drain; on
gate day it was 88.49 ms, with burst `completenessMin` 0.357. That degradation
is the same event the A-attribution verdict names
(`registrations/a-attribution.md`, VERDICT 2026-08-21). Which instruments
survived it is the useful part:

> The delivery, median-RTT and stall instruments are box-side or
> median-robust, and were **not** casualties. The spread instrument, which
> reads the Mac's arrival timing, was.

The same cross-reference disposes of the disclosure-only p99 row. Paced RTT p99
read 389.5 / 286.8 / 83.0 ms and control 120.7 / 115.0 / 78.2 ms in cells whose
medians are 0.76–0.83 ms. Per the A-attribution verdict, **cross-day absolute
RTT-p99 numbers from this instrument are weather, not measurements** — a p50 of
0.85 ms beside a p99 400× larger, with the box provably idle and cool, is
measuring-process scheduling stall. No claim in this document rests on an
off-box RTT p99.

## 4. Falsifiers and integrity

None of the gate's product-side falsifiers fired. Pacer integrity was clean:
`lateClumps` **15 / 19 / 10** of ~46,944 clumps — **0.021–0.040%** against the
ratified `f_LATE` of **5%** — with `refusedTargets`, `threadStartFailures` and
`deferredFailures` all **0** in all three paced cells (F1). The broadcast
identity closed exactly: 1,500,000 + 0 = 5,000 × 300, and 1,495,000 = 5,000 ×
299 in the third block (F2). Thermal F5, at resolution 1, saw **zero** samples
above the 125-sample quiet baseline's temperature maximum and a sub-2.1 GHz
fraction of 2.7% against a 25% threshold.

`scheduleResets` at 299/300 — roughly one per broadcast — is the benign
identity the registration named in advance, and is disclosed as such.

## 5. Ratification lineage

Every judgement this gate needed from the maintainer was ratified before
dispatch and is recorded on the registration: **J = 0**, **C3′/A_med = 0**
(Amendment A-1, which re-derived C3 as a median clause on the ruling
"re-derive"), **f_LATE = 5%**, **F5 resolution 1**, and precondition 6 closed
on evidence. A-1 exists *because* of the A-attribution run: the maintainer
refused to ratify an allowance `A` until the sweep's 4.9× paced-RTT repeat
spread had an attributable cause, that measurement returned **H-mac**
(measuring-end tail noise), and the clause was rebuilt around the median the
verdict showed to be robust rather than around the tail it showed to be noise.

## 6. Relation to G10

**This gate supersedes G10's scenario; it is not a G10 re-run.** The
G10-final ruling states it directly, and the registration quotes it verbatim
(`registrations/paced-broadcast.md`, preamble lines 25-26 — the page's numbered
sections run §1–§12 and this quote sits above them):

> *"A registration certifying a specific smaller shape would be a NEW gate if
> ever needed, not a G10 re-run."*

G10's own verdict — a MISS at 10,000 sessions on the VM rig — stands as final
for that rig and is not reopened here (see the appendix). What this gate
establishes is a **different, smaller, certified shape on new hardware**:
5,000 sessions at 5 Hz, paced, at delivery ≥ 0.9976. G10's clauses are not
graded by it and its 10,000-session fleet is not claimed.

## 7. A recorded instrument defect

The gate's §7 preflight **refused**, and the refusal was wrong: `preflight.ts`
reported `10.99.0.1 routes over (unknown) — not the cable` while `ip route get
10.99.0.1` on the box read `dev eno1 src 10.99.0.2` — the cable, exactly. The
gate ran on the cable address and the Mac fleet connected 5,000/5,000. The
consequence is disclosed rather than papered over: **no preflight artifact
exists for this run and the §7 idle-RTT/loss table is undischarged.** The route
detection defect in the preflight tool is recorded in the instrument chapter
below.

---

# Bidirectional streams, arm T — the first graded T-100

**Terminal row: C6-app MISS (final) · C6-wire PASS (17.25 / 12.25 ms against
25 ms).** The parent application-level reading remains final; the successor
stamp adds the native-wire clause without collapsing the two readings. Parent
registration: `registrations/g11-t-redispatch.md`; terminal successor
registration: `registrations/g11-t2.md`. Terminal successor stamp
`stamps/g11-t2.md` is bound to that successor registration. Parent stamp:
`stamps/g11-t.md`. Investigation: campaign ticket 10.

## 1. Why this arm has a history

Every prior attempt at T-100 died **INVALID on supply** — the V-P falsifier,
which asks whether the harness actually offered the shape it registered. A gate
that cannot be supplied grades nothing about the product. This run is the first
time the arm was *gradable*, and the maintainer's pre-dispatch ruling was
"dispatch, grade honestly", with the C6 outcome pre-registered as the likely
one.

## 2. The gate rung, graded

T-100 — 100 sessions × 3 Mbps in **both** directions simultaneously, 60 s,
two repeats, run **32480145202** on candidate `4a373765` (`stamps/g11-t.md`,
"The gate rung, graded"):

| clause | repeat 1 | repeat 2 |
|---|---|---|
| C1 up offered | **1.00003** PASS | **1.00003** PASS |
| C2 down offered | **1.00003** PASS | **1.00003** PASS |
| C3 byte ledgers | exact — 2,250,069,800 = 2,250,069,800 up, down exact | exact |
| C4 drain | 0 errors / 0 resets / 0 backpressure timeouts / 100 of 100 closed | same |
| C5 fairness | spread 1.0000 up, 1.0001 down, 100/100 | same |
| **C6 up one-way p99 ≤ 25 ms** | **348 ms — MISS** | **328 ms — MISS** |
| C7 down one-way p99 | **4.25 ms** PASS | **4.25 ms** PASS |
| C8 memory governors | shipped values, worst case stated | PASS |

**Down one-way p99 of 4.25 ms at T-100 — the server egressing 300 Mbps across
100 sessions while ingesting the same — is the strongest downstream latency
figure the T family has produced.**

**The MISS's attribution, as pre-registered:** the 25 ms budget is exceeded by
the **conductor's napi-bound read-side scheduling** at full-duplex saturation
(host ~87.7%), not by the wire. Three facts locate it there — the identical
machinery delivers 4.25 ms down in the same cells, T-25 and T-50 hold up-p99 at
1.44 and 2.50 ms, and the X arm holds 27.25 ms RTT at 1,000 sessions. The MISS
is final at this shape, on this rig, **with this harness as the application**. A
leaner application may do better; the stamp claims only what was measured.

## 3. The clean envelope, from the ladder

The non-gate rungs grade nothing and are disclosed as ladder evidence
(`stamps/g11-t.md`, "The ladder, disclosed"):

| cell | up / down offered | up / down p99 (ms) | host CPU |
|---|---|---|---|
| T-25 | 1.000 / 1.000 | **1.44 / 0.57** | 26.5% |
| T-50 | 1.000 / 1.000 | **2.50 / 0.97** | 51.5% |
| T-100 (gate) | 1.000 / 1.000 | 348 / **4.25** | 87.8% |
| T-200 | 0.62 / 1.000 | 1024 / 162 | 92.0% |

> **The working bidirectional envelope on this rig: clean through 50 sessions ×
> 3 Mbps in both directions with one-way p99 under 3 ms.** At 100 the box holds
> throughput exactly but the conductor's up-read latency breaks the interaction
> budget; at 200 the box itself saturates.

## 4. The attribution correction, in three layers

This arm's number was misattributed twice before it was attributed correctly.
The history is recorded because each correction changed what the campaign
believed the product could do.

**Layer 1 — the VM-era claim: "the rig's CPU cannot offer 100 × 3 Mbps
downstream."** Recorded in the VM ledger (`2026-08-19-production-grade-
scenarios.md`, G11 T-cells INVALID under V-P). Wrong in its premise: the
*client* never originates downstream at all.

**Layer 2 — "the wall is inside the server's egress path."** This was campaign
ticket 10's opening premise, and it rested on an artifact misreading: the
`maxQueuedBytesPerSession` (2,097,152) and global (512 MiB) values in the
artifact are **`DEFAULT_LIMITS` constants echoed verbatim**
(`bench-g11.ts:1261-1262`), not measured queue depths. The actual measured
queue peak, `peakSessionQueuedBytes`, was **1,402 bytes** across the entire 60 s
T-100 investigation drive, and delivered equalled offered byte-for-byte
(808,560,038 = 808,560,038). **Nothing queued; nothing was drain-bound.** The
product server is exonerated: the native path drained everything JS handed it.

**Layer 3 — the correct attribution: the conductor's single JS thread.**
Confirmed by the per-thread sampler (`evidence/g11/g11-inv-t100.threads.tsv`):
the Bun JS thread sat at **93–95% of one core** for the whole drive, addon
threads ~61%, tokio workers ~9%. One thread was running 100 upstream deframers
(~26.8k frames/s, which stayed exact) alongside 100 downstream pacers needing
~26.4k awaited writes/s; the pacers got the residual, ≈0.40 — a ratio
**invariant to generator topology** (single-process 0.411/0.405, sharded 2×50
0.402) precisely because it is internal to one thread. H3 (drain cap) was
refuted by that same empty-queue, exact-delivery data; H4 (a structural
constant) fell to a different comparison — T-50 sustains 150 Mbps down against
T-100's ~108–121, and no cap computes to 120 Mbps. The cliff is sharp —
1.00 at 50 sessions, 0.36–0.40 at 100, **0.0068 at 200**.

**The fix that failed, and what its failure proved.** T-PC2 moved deframing to
worker threads (`probe/g11-bidi-04` @ `f1ec0c7`): shards 2, workers running and
visibly spinning at 344% server CPU, up 1.00003 — and down **0.36649**, inside
the baseline band. **No effect.** Removing ~26.8k frames/s of read-side work
freed nothing the pacers could use, which locates the saturation in the **write
half itself**: 100 per-stream pacers issuing ~26.4k awaited, env-bound napi
`write()`s per second.

**What closed the wall** was the third fix direction: a **native paced
emitter** (`runPacedEmitter`, driving the product's own `write_bytes` path,
with `downOriginator: "native-paced"` stamped in every cell and 0 emitter
failures). Supply went from 0.40 to **1.00003**, and the arm became gradable
for the first time.

## 5. The verdict this arm actually delivers

**The T arm's history is a harness finding, not a product finding.** Two of its
three attribution layers blamed something other than the harness — once the
rig's CPU, once the server's egress path, and only the second of those was a
charge against the product — and both were wrong. What the graded run shows is a
server that offers its registered shape exactly in both directions, keeps its
byte ledgers to the byte, drains without a single error or reset, and egresses
at 4.25 ms p99 while ingesting the same load. The clause it misses is an
application-level latency budget measured through a harness whose read side is
the thing that misses it.

## 6. A recorded harness defect: V-K's stale constant

The shipped classifier declared the run INVALID on **V-K**, and off-runner
recomputation **un-fired** it, mechanically. V-K's `maxBatchBytes ≤ FRAME_BYTES`
bound uses `FRAME_BYTES = 1400 + 2 = 1402` (`g11-plan.ts:24`), but the
harness's actual tunnel frame is **1,420 B** — 1,400 payload plus a 20-byte
header, the layout the emitter reproduces byte-exactly and the deframers parse.
A single-frame crossing is therefore 1,420 B and the rule fires on **every
knob-off T cell by construction**; it fired on G11-01 too, invisibly behind V-P
at the time. The knob label does not lie: `batchedCrossings = 0` in every
knob-off cell, and the knob-on cell shows `batchedCrossings ≈ dataCrossings` at
max 65,536 B. Repeat 2's 1,422 B is read-side coalescing — one frame plus the
next frame's 2-byte length prefix — not write batching.

Per the campaign's §9.6 rule the classifier is not the verdict; its firing is
recorded as **corroboration that disagrees**, with the cause disclosed. **Any
future G11 branch should fix the constant**, and decide whether read-side
coalescing belongs under a knob-off write-batching bound at all.

---

# The instrument — what this rig can witness, and what it cannot

Nothing in this campaign was measured by a neutral observer. Every number above
was produced by an instrument with its own ceilings, and several of the
campaign's apparent product walls turned out to be those ceilings. This chapter
states them, so that a reader can tell which of this document's silences are
product limits and which are measurement limits.

Sources: `registrations/instrument.md` (the F1 burst matrix, ticket 01 —
**bound-free**: it carries properties, never thresholds), the A-attribution
verdict (`registrations/a-attribution.md`), campaign ticket 10, and the gate
stamps' own deviation sections.

## 1. The sink wall — the Mac's RTL8153 ingress

The campaign's off-box sink is a Mac receiving over a **USB RTL8153** Ethernet
adapter, and it is the single most load-bearing instrument property in the
campaign.

**Smooth arrival** (`instrument.md` §6 P-5): **74,992 pps at 0.244% loss**, and
**115,835 pps delivered at 2.652% loss**. Three independent routes — smooth
iperf3, the matrix's own blast drain rate, and a second blast drain from
earlier the same day — land between **112k and 117k pps**, which the
registration calls the strongest agreement in that document.

**Burst-shaped arrival is a different wall entirely** (`instrument.md` §6 P-6,
the registration's own "load-bearing property"). Holding the cable, the qdisc,
the payload, and the *mean* rate fixed and varying only emission shape:

| mean offered pps | smooth (iperf3) | burst-shaped (`burst-probe`) | ratio |
|---|---|---|---|
| ~75,000 | **0.244%** loss | **8.37%** loss | **34×** |
| ~119,000 / ~124,000 | **2.652%** loss | **29.81%** loss | **11×** |

The 75k row is the one that matters: that mean is **35% below** the sink's own
smooth-arrival capability, its pacer was near-perfect (74,906–75,004 pps, a
0.13% spread), and it still lost 8.37% uniformly across all fifteen bursts. A
sink losing packets at 65% of its measured capability, evenly, is not
rate-saturated — it is being handed packets faster than its instantaneous
arrival window absorbs. The wall is placed **below the socket**, consistent
with a ring-and-USB-turnaround limit — but note that the 6 MB recvspace test
behind that placement is **inherited from the founding day-1/day-2 work and was
not reproduced here**: the F1 matrix varied recvspace in no cell, and
`instrument.md` §9 lists that sensitivity under what the matrix cannot
derive.

**`fq` on the box's egress does not rescue burst-shaped traffic.** Post-`fq`
blast lost 39.06% where pre-`fq` blast lost 42.62% under the same shape — a
3.6-point difference is not a rescue. `fq` protects the sink only for traffic
the qdisc can actually smooth; a userspace burst handing the kernel 10,000
packets at once still arrives at the Mac as a burst.

**This is the mechanism behind V-SP**, the falsifier that took the paced
broadcast gate's spread verdict. A campaign whose sink sheds as a function of
instantaneous arrival cannot certify arrival-spread bounds on a day when the
sink is degraded — and it correctly declined to.

**The founding day-1/day-2 sink figures need qualification**, and
`instrument.md` §8.8 supplies it. Of the three inherited numbers — "~100k pps
clean, ~22% loss at 140k offered, buffer-insensitive at 6 MB recvspace" — **no
artifact in the campaign's evidence carries any of them**. The one the matrix
can speak to is "~100k pps clean", and it holds for *neither* shape as stated:
smooth arrival is clean at ~75k and already at 2.1% by 118k; burst-shaped
arrival is not clean at **any** rate the matrix tried, 75k included. The
22%-at-140k figure is neither reproduced nor contradicted here.

## 2. The Mac as a measuring end — H-mac

Off-box RTT in this campaign is measured by a prober on the Mac, and the
A-attribution run (five repeats of the paced sweep's S1 cell, five instruments
added that the sweep had lacked) established what that vantage can and cannot
report:

| repeat | RTT p50 | RTT p90 | RTT p99 |
|---|---|---|---|
| r1 | 0.86 ms | 52.3 | **423.1** |
| r2 | 0.86 ms | 21.0 | 373.8 |
| r3 | 0.83 ms | 21.0 | 371.7 |
| r4 | 0.84 ms | 26.4 | 334.0 |
| r5 | 0.83 ms | 33.8 | **309.9** |

**The median is sub-millisecond and stable in every repeat; only the tail
moves.** The box was provably clean throughout — Tctl ≤ 61.8 °C, loadavg1 ≤
2.08, `performance` governor, pacer stall p99 1.76–1.89 ms — which killed the
thermal and co-tenant hypotheses outright. The verdict:

> **the sweep's 4.9× S1 RTT-p99 repeat spread (13.7–67.5 ms) is measuring-end
> tail noise — the same mechanism at lower amplitude. Today the same instrument
> produced 310–423 ms with the box clean: a ~30× cross-day swing that no
> box-side variable explains.**
>
> […] Cross-day absolute RTT-p99 numbers from this instrument are weather, not
> measurements, and no stamped claim should quote one without this verdict.

Prober CPU medians (261–283%) matched sweep day, so the effect is **wakeup
latency under host load**, not CPU starvation; the monotone decay across
repeats tracks the Mac's independently-reported degraded state settling.

**Two rules follow, and this document obeys both.** Off-box **medians** are
robust and quotable. Off-box **RTT p99** is quotable only as a same-day,
same-run *relative* comparison between paired arms — which is exactly the form
the paced-broadcast C3′ clause was rebuilt into (Amendment A-1).

**G2's final INCOMPLETE is the same instrument seen from the other side.** The
historical first run's off-box floor arms measured an idle p99 of **8.101888
ms**; the two licensed final attempts independently measured F-off medians of
**12.632064 ms** and **9.289728 ms**, all above the fixed 4.0 ms bar. The
registration predicted this outcome in advance and called it a legitimate
campaign result. The final stamp records a hardware-scoped INCOMPLETE with no
gate statistic, because the path was not quiet and no gate cells were
evaluable. **The Mac vantage cannot witness a single-digit-millisecond
tail-latency claim**, and no such claim appears in this document.

## 3. The cable and its preflight

Cable: `box eno1 10.99.0.2 ↔ Mac en8 10.99.0.1`, MTU 1500, `fq` armed on
`eno1`, Docker and Tailscale subnets verified non-colliding with `10.99.0.0/24`.

The founding preflight (2026-08-20, `preflight-baremetal-2026-08-20.json`) came
back **GREEN**: 600 ICMP samples at 0% loss, TCP **881,040,056 bit/s** with **0
retransmits** over 10.006 s, and a clean UDP ladder to 74,997 pps at 0% loss.
(The jitter range of 0.005 ms to 0.050 ms under UDP load in both directions is
from the SI-1/SI-2 iperf3 ladders, not from the preflight artifact, whose own
ladder jitters run 0.0050–0.0165 ms.)

**RTT depends on which end you ask, and the registration insists you say so.**
Peer-toward-generator vantage: p50 **0.535 ms**, p99 **0.735 ms**, max 1.12 ms.
Generator-side vantage: p50 0.672 ms, p99 **4.097 ms**, max 5.531 ms. Those two
tails differ by 5.6×. *"A gate quoting 'the idle RTT' without naming its vantage
has quoted nothing."*

**Preflight route-parser defect, found 2026-08-21.** `preflight.ts` refused the
paced-broadcast gate's preflight with `10.99.0.1 routes over (unknown) — not the
cable`, while `ip route get 10.99.0.1` on the box read `dev eno1 src 10.99.0.2`
— the cable. The tool's route detection fails to parse this kernel's output. The
cost was real: that gate ran without a preflight artifact and its idle-RTT/loss
table is undischarged. **Fix the parser before the next off-box gate.**

## 4. The conductor's JS thread — the campaign's most expensive instrument
property

The benchmark conductor runs **in the same Bun process as the server under
test**, and its work lands on the same single JS thread. Ticket 10's per-thread
sampler measured the split during a T-100 drive
(`evidence/g11/g11-inv-t100.threads.tsv`, 1 Hz over `/proc/<pid>/task/*/stat`
deltas):

| thread class | share of one core |
|---|---|
| **Bun JS thread** (1 thread) | **93–95%** |
| addon `wt-server` threads (2) | ~61% **each** |
| tokio workers (8) | ~9% **each** |
| **process total** | **~317%** |

**The first three rows are per-thread readings and do not sum to the fourth** —
ticket 10 states them as the ticket does, and the arithmetic only closes once
each class is multiplied by its thread count (and the JIT and heap-helper
threads, a few percent between them, are added). Recomputing the whole sampler
window from the raw `.tsv` gives ~301% averaged across the drive, against the
~317% the ticket reports at steady state.

**The dominant single consumer in that sample is harness code**, and the
campaign never separated the conductor's share from the server's in a
controlled way. That is the looseness the Deployment chapter's sizing section
discloses, and it is the reason this document publishes no
instances-per-core constant.

## 5. Generator ceilings — what the harness can offer

Three separate ceilings, all harness properties, each of which capped a gate:

- **Bidirectional streams: ~50 sessions per conductor process.** Above that the
  JS thread's write half saturates and offered supply collapses to ≈0.40
  (§4 above, and the T-arm chapter). Closed for the T arm by the native paced
  emitter; still true of any JS-side generator.
- **JS write originator: ~63.3k writes/s at 1 KiB.** G7's B-1k cell is
  originator-bound in both repeats and cannot reach its offered 152,588
  writes/s. This one is a **product-relevant** finding as well as an instrument
  one — it is the same JS thread an application's own write loop would use, and
  the Deployment chapter treats it as the campaign's one genuine product wall.
- **Box egress depends on which sender you ask.** iperf3's single-threaded UDP
  client tops out at **118,992 pps / 190.39 Mbit/s** with a core pinned at
  99.90%; the Bun `burst-probe` sender on the same box, same payload, same
  qdisc, emits a p50 of **148,370 pps** and peaks at **196,010 pps** with zero
  send-blocking — **1.6× more**, unexplained by the artifacts (plausibly
  syscall batching, untested). Any statement about "what the box can send" must
  name the sender.

And one pacer fidelity property that bites whoever labels a cell by its knob:
`burst-probe --pace-pps` is exact at 75k (−0.005%), **undershoots by 9.47% at
100k**, and lands within 0.69% at 125k — non-monotone. *A cell labelled with a
`--pace-pps` value is not thereby a cell at that rate*; read the achieved rate
from the send artifact.

## 6. Methods this campaign used, and would use again

- **Off-runner recomputation as the verdict.** Every stamp recomputes its
  clause values from raw artifact fields in a sandboxed process with no repo
  code loaded, and treats the shipped classifier's output as *corroboration*.
  It paid for itself twice: G11-T's V-K firing was un-fired on a stale
  constant, and G7's classifier verdict (`INCOMPLETE`, 12 `V1-sink` firings)
  disagreed with a run that was in fact valid.
- **The 1 Hz host sidecar** (loadavg1, cpu0 frequency, Tctl, governor, docker
  and tailscaled state — the F5-res-1 field set), started from a ≥120 s quiet
  baseline before the first cell and running through the last. It is what let
  the A-attribution run exonerate the box in one reading, and what lets the
  gate stamps state "no throttle" as a measurement rather than an assumption.
- **The per-thread CPU sampler** (`/proc/<pid>/task/*/stat` deltas at 1 Hz).
  A whole-process CPU figure would have kept the T-arm wall misattributed
  indefinitely; the per-thread split resolved it in one drive.
- **Paired, adjacent arms.** Control-then-paced, adjacent by construction, is
  what makes a claim survive an instrument having a bad day: both arms sample
  the same weather.

## 7. Instrument limits this campaign did not overcome

- **Loss locus is inferred, not measured.** No kernel counters — no
  `tc -s qdisc`, no NIC `rx_dropped`, no `netstat -su` — were captured at
  either end of the burst matrix. The loss figures are real (those packets did
  not reach the receiving application); the attribution to the Mac's RTL8153
  ingress is a well-supported **inference**.
- **One repetition per cell in the F1 matrix**, so there is **no dispersion
  estimate** for any instrument property. The gates that needed variance
  budgeted their own repeats.
- **`burst-probe --role recv` on Linux is an open harness defect.** Both
  Mac→box cells captured 1 of 15 and 4 of 15 bursts and are marked **advisory**;
  they measure a role no gate uses. Box ingress truth comes from iperf3
  instead: **114,989 pps at 0.355%**, and 74,994 pps at **exactly zero** loss
  (0 of 600,003 packets).
- **The `registration-common.md` §3 thermal-capture convention is not
  genuinely implemented anywhere.** The F1 matrix captured to a side file, did
  not record the governor or resident services, averaged frequency across 8
  threads rather than per core, sampled only at cell endpoints, and skipped the
  iperf3 ladders entirely — including the two cells that pinned a core at
  99.90%. Later gates' sidecars fixed most of this; `run-matrix.sh`'s `therm()`
  still needs the three missing fields, per-core frequencies, mid-cell
  sampling, and a call from `iperf_ladder()`.
- **GitHub caps a workflow at 25 inputs.** The G11-T redispatch hit it and had
  to consolidate its knobs into a single `g11_generator` string
  (`originator=native,deframe=0`). A dispatch surface that runs out of room is
  a real constraint on how finely a gate can be parameterized, and it cost this
  campaign one failed dispatch attempt (HTTP 422, no run id).

---

# HFT-adjacent positioning — what this product is and is not

The campaign was asked, repeatedly, whether these envelopes qualify
webtransport-bun for latency-sensitive financial workloads. The honest answer
has two halves and they point in opposite directions.

## Distribution: yes, at the stamped envelopes

For **fan-out of the same or similar payloads to many long-lived subscribers**
— market-data distribution to end-user clients, dashboards, mobile and browser
consumers — this campaign measured real capability on a 4-core box:

- **5,000 sessions at 5 Hz, paced broadcast: delivery 0.997859 / 0.997617 /
  0.998633, RTT p50 0.834 / 0.792 / 0.763 ms** — narrowed by C2 rendering no
  verdict on arrival spread (`stamps/paced-broadcast.md`, C1/C3′). Sub-
  millisecond **medians** at that scale, through a shipped API.
- **1.2498 Gbps of stream egress** at 16 streams × 64 KiB with exact byte and
  stream ledgers and a *measured* zero receive-socket drops across 14
  cell-repeats (`stamps/g7-02.md`, C2/C4).
- **1,000 concurrent request/response sessions at RTT p99 27.25 ms**, 60,000 of
  60,000 exchanges, at 25.6% of the box (`stamps/g11.md` §2).
- **10,000 sessions** held with ingest p99 2.576 ms and delivery 1.000000, at
  ~126.5 KB/session, linear (`stamps/g1.md` C1/C2/C3).
- **Bursty, frame-shaped egress at one-way p99 1.491 ms** against a 33.3 ms
  bar, with GSO and GRO active at 64 segments (`stamps/g3.md` C2/C4).

Those are enough to build a distribution tier on, and the Deployment chapter
says how to run more than one of them.

## Hot path: no

**webtransport-bun is not a tick-to-trade transport, and nothing in this
campaign suggests it could become one.** The reasons are structural, and each
is a number this campaign paid for:

**1. There is one JS thread, and it is the measured ceiling.** The write
originator sources ~**63.3k writes/s at 1 KiB** and cannot reach an offered
152,588 (`stamps/g7.md`, B-1k). The same thread, running 100 stream pacers,
saturates at 93–95% of one core and shed 60% of its offered downstream until
the pacing was moved off it (ticket 10; the T arm's supply wall is now closed
by a native emitter, so this is a property of JS-side pacing, not a standing
transport ceiling). Every application callback, every payload construction, every
`await` on a send shares that thread with the transport's own JS-side work. A
hot path cannot be scheduled behind an event loop that also runs the
application.

**2. The runtime is garbage-collected, and the tails show it.** This document's
tail figures live in the milliseconds and tens of milliseconds, not the
microseconds: 27.25 ms exchange p99 at 1,000 sessions, 10.879 ms fan-out p99,
4.25 ms one-way down p99 under full-duplex load. Those are good numbers for a
distribution tier and they are three to four orders of magnitude away from what
a hot path budgets.

**3. This campaign's instrument cannot even witness a hot-path claim.** G2 —
the one gate that set out to bound a single-digit-millisecond tail — returned
INCOMPLETE because the measuring vantage's own idle p99 was 8.1 ms. Off-box
RTT p99 from this rig is weather (the H-mac verdict). **Anyone claiming
microsecond behaviour for this product would need an instrument this campaign
does not own**, and this document declines to make a claim it could not have
measured.

**4. The measured latencies are application-level and harness-shaped.** The
T-arm MISS is the clearest case: 348 ms up-p99 that belongs to the conductor's
read-side scheduling, in the same cells where the down direction reads 4.25 ms.
When latency is dominated by whichever JS thread is doing the reading, the
transport's own contribution is not the number you are looking at.

**The honest framing, then:** use it to *distribute* at the envelopes above,
with N independent instances behind client-side assignment (Deployment,
chapter 2). Do not put it between a signal and an order.

---

# Appendix — the VM-era ledger, and what bare metal corrected

The campaign that preceded this one ran on a **4-vCPU Ubuntu VM on Hyper-V**
(`hv_netvsc`, no hardware USO) hosted on an 8-logical-core Windows machine.
Its documents are the historical record and were read for this appendix:

- `docs/research/2026-08-19-production-grade-scenarios.md` — the gate ledger
- `docs/research/2026-08-18-four-axes-measurement.md` — the four-axes campaign
- `docs/research/2026-08-18-bandwidth-ceiling-attribution.md` — the ceiling

**Where those three live, stated plainly:** they are **uncommitted** in the
`rebind4-staging` working tree and are therefore *not* present in this branch's
worktree. The links above will not resolve from a checkout of this branch until
those documents are committed. They are cited as the sources this appendix was
written from, with the same disclosure the campaign applies to its own
gitignored scratch.

**The standing rule of this document, restated: no VM-era number is carried
forward as a bare-metal claim.** Where a gate has both, the bare-metal figure
above is stated as a topology change, never as a delta, and the VM figure lives
only here.

## A.1 The VM ledger as it stood

| gate | VM-era verdict | note carried from that document |
|---|---|---|
| G1 GPS/telemetry | **PASS, coverage-narrowed** | 10k sessions, delivery 1.000, ingest p99 2.9 ms, ~128 KB/session. The pass covers **staggered** arrival only; synchronized fleets read 0.699 with kernel rcvbuf loss, disclosed and not covered. The re-registration's authorization was disputed on the record |
| G2 FPS/MOBA | **INCOMPLETE-ON-THAT-RIG** | evidence chain weakened on review; its licensed 10k observation describes a tree that stopped being the shipped default two hours later |
| G3 camera egress | **INCOMPLETE** | on re-read the "rig can't source 1.5×" conclusion was **refuted** by the run's own batch fragment, and the broader interpretation "the JS originator is the binding constraint under all arms" was **struck** — `originationLag` is recorded across `await send` and absorbs product send latency |
| G4 video-call SFU | **PASS on its registered clauses** | N=50 p99 10.35 ms, delivery 1.000 — but the run-level "headroom 1.80" context was **struck**: the ceiling counted shadow-sink stubs that skip the native send |
| G5 bulk/VOD | **NO-VERDICT** | with omitted disclosures restored: every cell except the control dropped on the server socket |
| G10 broadcast | **MISS — final for that rig** | see A.3 |
| G11 | X PASS · D coupling-absent · **T INVALID (V-P)** | see A.2 |

The G1–G5 rows come from the gate ledger named above. **The G10 and G11 rows do
not** — that document's own verdict table stops at G5, and those two gates were
carried in the VM campaign's ticket scratch
(`.scratch/production-grade-scenarios/issues/35-gate-g10-broadcast.md` and
`36-gate-g11-bidi-proxy.md`), with the same gitignored-scratch disclosure this
document applies to its own.

Two findings in that document outranked its own gates, and both stand: the
`WEBTRANSPORT_DATAGRAM_SEND_SYNC` default-ON landing was **not** a neutral
change (G5 measured the shipped-default control moving +12.7% across it), and
pre-registration hygiene had broken down at the edges — amendments asserting
"no data existed" when runs had completed, dispatches missing from logs
claiming exhaustiveness, and binding bars living in gitignored scratch with no
version history. The bare-metal campaign's stamp discipline — off-runner
recomputation, sidecars bracketing every dispatch, falsifiers registered before
data — is the direct answer to that second finding.

## A.2 Correction 1 — G11's T arm, re-attributed twice

The VM ledger recorded T as INVALID with the attribution that the rig's CPU
could not generate 100 × 3 Mbps of paced downstream, and that receive batching
did not touch the write-side bottleneck. Bare metal corrected it in
two further steps — first wrongly, to "the server's egress path", then
correctly, to **the conductor's own JS thread** — and then closed it with a
native paced emitter that took supply from 0.40 to 1.00003. The full three-layer
history is in the T-arm chapter above. The point worth carrying: **two of the
three attributions looked outside the harness — at the rig, then at the server
— and both were wrong.**

## A.3 Correction 2 — the 160k ceiling, and G10's finality

The VM-era bandwidth work chased a 160k datagrams/s offered shape and closed at
a different number: **~103k/s delivered on-box with Cubic is that hardware's
honest ceiling, and it is not a server-side limit**
(`2026-08-18-bandwidth-ceiling-attribution.md`). It decomposed into three
independently measured caps — sender co-residence capping the *offered* rate
(~101k on-box against 151k from a sibling VM), client Cubic on loopback capping
framing at ~105k/s, and the Hyper-V virtual switch's bursty invisible loss
capping everything off-box (off-box Cubic framed 64k and delivered 62k; off-box
**BBR framed 87.5k and delivered 42k** — BBR floods a dropping path that Cubic
backs off from, which also reinterpreted the on-box BBR ingest collapse as
overdriving rather than a GRO artifact).

**Every remaining lever there was physical, not software in this repo** — which
is precisely why this campaign moved to bare metal and a real cable.

G10's VM-era MISS was then ruled **final for that rig** under the standing
maintainer ruling that a hardware-scoped miss counts as a closed gate. The
paced-broadcast chapter above supersedes its *scenario* at a smaller, certified
shape on the new topology; it does not reopen or re-grade G10, and the
G10-final ruling's own words govern: *"A registration certifying a specific
smaller shape would be a NEW gate if ever needed, not a G10 re-run."*

## A.4 Correction 3 — the "rebind" homonym

An earlier revision of the load-balancing analysis claimed this project runs
"rebind soaks" covering NAT rebinding. **That was a false weld of a homonym.**
In this repository "rebind №4 / №5" names a *release-evidence* rebind —
re-pointing a release candidate at regenerated evidence
(`docs/RELEASE_1.0_STATUS.md`) — and has nothing to do with NAT. **No
NAT-rebind test exists anywhere in the tree**: `soak-long.yml` contains none,
and the only mention is a doc comment in `crates/native/src/client.rs`. The
correction is carried in
`docs/research/2026-08-21-load-balancing-architecture.md` §1 and is the reason
this document's Deployment chapter states its 4-tuple argument as a **deduction
from RFC 9000 §5.1/§9 and from quinn-proto's source**, not as a measurement
this project owns.

## A.5 What the VM era contributed that survives

Not everything there was corrected. The H7 batched-delivery lever (1.96×) and
the hop-removal work shipped and are in the tree the bare-metal gates measured;
the zombie-session / no-idle-timeout product observation stands, and is the
reason the Deployment chapter knows to bound the stall at all — though the 60 s
figure itself is read from the shipped default in `crates/native/src/limits.rs`,
not from that campaign; and the
four-axes finding that the JS originator is the binding constraint on bursty
egress was **reproduced independently on bare metal**, in G7's B-1k cell and in
G11's T arm. That is the one VM-era conclusion this campaign confirmed rather
than corrected — and, not coincidentally, it is the one product wall this
document publishes.
