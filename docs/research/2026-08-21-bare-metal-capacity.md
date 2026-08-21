# webtransport-bun on bare metal — capacity, latency, and deployment

**Status: LIVING DRAFT (2026-08-21).** This is the bare-metal campaign's
terminal document (campaign ticket 09). It is published incomplete on purpose:
one chapter — **Deployment** — is finished and reviewed; the gate chapters are
stubs that point at the stamps until the campaign closes them. Nothing here is
a forecast. Every number carries the stamp it was recomputed in, and where a
number does not exist, this document says so rather than estimating one.

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

## Chapter status

| Chapter | State | Where the evidence lives |
|---|---|---|
| **Deployment** | **Written** (below) | this document + `2026-08-21-load-balancing-architecture.md` |
| Session scale (G1) | stub | `stamps/g1.md` — PASS |
| Tail latency (G2) | stub | `stamps/g2.md` — INCOMPLETE (`path-not-quiet`; instrument finding) |
| Bursty egress (G3) | stub | `stamps/g3.md` — PASS, C3 `CEILING-MOVED` |
| Fan-out (G4) | stub | `stamps/g4.md` — PASS |
| Bulk / VOD (G5) | stub | `stamps/g5.md` — PASS |
| Stream egress (G7) | stub | `stamps/g7.md` (PASS, narrowed) → `stamps/g7-02.md` (PASS, unnarrowed) |
| Many-rooms fan-out (G8) | stub | `stamps/g8.md` — PASS, narrowed to one cell of nine |
| Churn (G9) | stub | `stamps/g9.md` — NO-VERDICT (declared harness fault; one rerun licensed) |
| Bidirectional streams (G11) | stub | `stamps/g11.md` + its correction addendum — X PASS · D COUPLING-ABSENT · T INVALID |

### Placeholder — the broadcast pair

*Chapter pending.* The paced-broadcast gate is not stamped. Nothing about
broadcast envelopes should be quoted from this document until it is. The
`sendDatagramMirror` path it certifies is merged
(`crates/native/src/datagram_mirror.rs`) and is capped by a 1 ms JS-stall
budget it measures against; that cap is a design statement, not a gate result.

### Placeholder — the G11 T arm (bidirectional throughput)

*Chapter pending.* T is **INVALID**, not missing: the V-P supply falsifier
fired on both repeats. The correction addendum to `stamps/g11.md` and campaign
ticket 10 locate the binding constraint on the **benchmark conductor's own JS
thread** (93–95% of one core, running 100 downstream pacers and 100 upstream
deframers in the same Bun process as the server under test), not on the
product's egress path — the native queue peaked at 1,402 bytes and delivery was
byte-exact. Offloading deframing to workers (T-PC2) recovered nothing, which
locates the saturation in the write half. A compliant T arm re-registers at a
witnessable shape or against a native paced emitter. Until then this document
publishes **no bidirectional throughput envelope**.

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
core** (JS thread 93–95%, addon threads ~61%, tokio workers ~9%; ticket 10's
per-thread sampler, `evidence/g11/g11-inv-t100.threads.tsv`). The conductor's
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
| Stream egress, 16 streams @ 64 KiB writes | **1.2498 Gbps**, byte- and stream-ledgers exact | host CPU ≤ 79% of the box | `g7.md` C2; reproduced 1.2498 in `g7-02.md` |
| One-way p99 across **1,000** token sessions | **5.112 ms** raw (uncorrected) | same run | `g7.md` C7 (`g7-02.md`: 4.16 ms) |
| Client receive-socket drops at that load | **0**, measured, all 14 cell-repeats | — | `g7-02.md` C4 |
| Request/response exchange, **1,000 sessions** | **60,000/60,000** exchanges, RTT p99 **27.25 ms** | **25.6%** of the box | `g11.md` §2 (arm X) |
| GPS-shaped session scale | **10,000 sessions**, ingest p99 **2.576 ms**, delivery 1.000000 | rung classified `ok` | `g1.md` C1/C2 |
| Per-session memory, 1k → 10k sessions | **~126.5 KB/session**, linear (5k→10k slope within 0.48% of 1k→5k) | — | `g1.md` C3 |
| Forward fan-out egress | **16,509/s** inside a 30 Hz frame gate, p99 **10.879 ms**, delivery 1.0000 | — | `g4.md` (stated as a **rate** bound, not a fan-out bound) |
| Bursty / frame-shaped egress | egress one-way p99 **1.491 ms** median of 5 blocks, bar 33.3 ms | GSO **and** GRO active, 64 segments; `sndbufErrors` 0 on all 30 steps | `g3.md` C2/C4 |
| Bulk / VOD paced throughput | **1.1473 Gbps** with shipped windows; **1.2049 Gbps** raised (windows not binding, ratio 1.06) | — | `g5.md` |
| Many-rooms fan-out | **2 concurrent 10-subscriber video rooms** at 330/s per publisher, p99 **3.740 ms**, forward delivery 0.99995 | co-resident generator + sink + VPN + Docker | `g8.md` — and note this licenses *two rooms*, nothing more; eight of nine cells were INVALID |

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
against the source this tree locks (`Cargo.lock:892-893` → quinn-proto
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
at `crates/native/src/lib.rs:744-746`, floored at 1000 ms by the parser at
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
keyless (key-optional) configuration of draft-ietf-quic-load-balancers puts the
server ID into the connection ID unencrypted, where any on-path observer reads
it. The draft warns about this in its own words (§5.3, on the key-optional
configuration): without encryption the server mapping is exposed, and the
routing bits are constant across every CID the connection ever uses, which is a
linkability signal the QUIC CID design otherwise denies observers. A keyed
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
