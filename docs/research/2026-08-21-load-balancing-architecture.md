# Load-balancing architecture for webtransport-bun — cores, machines, and what the balancer should be

*2026-08-21. Investigation grounded in the bare-metal campaign's measured
envelopes and in the code as it exists at `rebind4-staging` (9c475df) and the
wtransport fork (`7dc1a03`). File:line citations are to those trees.*

## Executive summary

webtransport-bun scales horizontally by **running N instances and steering QUIC
connections to them by connection ID, not by 4-tuple** — on one box via
SO_REUSEPORT with an eBPF CID steer (the fork's `with_bind_socket` makes the
socket injectable today), across machines via the QUIC-LB pattern
(draft-ietf-quic-load-balancers), for which quinn's pluggable
`ConnectionIdGenerator` is already reachable through the fork's public
`quic_endpoint_config_mut()` — no new fork surgery required. The balancer
itself should **not** be a webtransport-bun instance: an L7 QUIC-terminating
proxy pays the product's own measured ceilings twice per byte (≈1,045 CPU-ms
per Gbit egress at the friendliest write size, and the ~63k writes/s
single-JS-thread originator wall the campaign has now hit in three independent
shapes), so a relay tier built from the product halves fleet capacity and
bottlenecks on exactly the thread the campaign keeps finding. Balancing is a
**deployment pattern plus two small product hooks** (socket injection, CID
server-ID encoding), not a product. On instance count per box: one instance per
hardware thread is refuted — a loaded instance is a multi-thread process (JS
thread + addon + endpoint driver), so 8 on an 8-thread box oversubscribes it.
What replaces that number is **an upper bound of unknown tightness**, not a
recommendation: the ~317%-of-a-core figure this document cites was measured on
a process that includes the harness *conductor*, whose share was never
separated out and remains **unmeasured**. Size by measuring your own workload.
See the capacity document's §1, "Sizing — an upper bound of unknown tightness",
which is the authority here and declines to publish a per-box instance count.

---

## 1. Why QUIC balancing is not TCP balancing

TCP balancing routes on the 4-tuple because a TCP connection *is* its 4-tuple.
A QUIC connection is **not**: it is identified by connection IDs, deliberately
decoupled from the address so the connection survives address changes
(RFC 9000 §5.1, §9). Three consequences:

- **NAT rebinding is normal, not exotic.** A home NAT silently expires a UDP
  mapping and the client's packets arrive from a new source port (or address).
  **Correction (2026-08-21, critic review):** an earlier revision of this
  paragraph claimed the project runs "rebind soaks" for this scenario. That
  was a false weld of a homonym — in this repo "rebind №4/№5" names
  *release-evidence rebinds* (re-pointing a candidate at regenerated
  evidence; `docs/RELEASE_1.0_STATUS.md`), and no NAT-rebind test exists
  anywhere in the tree (`soak-long.yml` contains none; the only mention is a
  doc comment in `crates/native/src/client.rs`). The 4-tuple argument
  therefore stands **as a deduction from RFC 9000 §5.1/§9 (connection IDs
  and migration), not from a measurement this project owns**: we have not
  measured a 4-tuple balancer dropping sessions, and we run no NAT-rebind
  gate. The deduction itself is standard and load-bearing: any balancer that
  hashes the 4-tuple re-routes the flow at the moment of rebind, and the new
  backend holds no state for those CIDs — the connection stalls until
  idle-timeout teardown (the server applies `max_idle_timeout` from limits,
  `crates/native/src/lib.rs:745`). 4-tuple steering therefore converts a
  survivable rebind into a session that **stalls until the idle timeout expires
  (60 s by default)** — not an immediate drop, and the difference is the whole
  observable behaviour: the client sees a hang, not a close. The verified
  mechanism is in the capacity document, §3.
- **Migration and multipath** are the same failure amplified: the client
  *intends* to change path; only CID-aware routing follows it.
- **Ownership of Retry, stateless reset, and 0-RTT.** Stateless resets are
  HMAC'd with an endpoint key (`quinn_proto::EndpointConfig::reset_key`,
  quinn-proto **0.11.16** `src/config/mod.rs:87` — settable, default random
  per process, `src/config/mod.rs:186-189`): after failover, a different
  instance cannot emit valid resets for a dead instance's CIDs unless the key
  is shared fleet-wide. This is not merely a cosmetic loss — see the verified
  mis-steer mechanism in the capacity document
  (`2026-08-21-bare-metal-capacity.md`, Deployment → "What actually happens
  on a mis-steer"): a wrong-backend reset carries a token the client cannot
  match, so it is discarded as unroutable and the connection stalls to idle
  timeout rather than dying promptly. 0-RTT resumption
  in the fork is a **stateful per-process store**
  (`crates/native/src/zero_rtt.rs:25-27`, `:222` — `Resumption::store` on the
  shared config): a client landing on a different instance falls back to a
  full handshake. Correct, just slower — affinity is a performance feature,
  not a correctness requirement.

**When naive L3/L4 hashing is nonetheless acceptable:** short-lived
connections, clients on stable networks (datacenter-internal east-west), or
fleets where a rebind-priced reconnect is tolerable. It is the wrong default
for the product's own headline scenarios (long-lived GPS/game/camera
sessions — the exact populations G1/G2/G8 measure).

## 2. One node, 8 cores

First, correct the premise "8 cores → 8 instances." An instance is not one
thread. The addon runs its endpoint on a dedicated runtime
(`server_spawn.rs:178`, `new_current_thread`) *plus* the Bun JS thread *plus*
rustls/quinn work; under G11's bidirectional load the single conductor+server
process measured **~317% of one core** (JS 93–95%, addon threads ~61%, tokio
~9% — ticket 10's per-thread sampler). G7's egress run held host CPU at a
run-wide median maximum of 79.1% of 8 threads (cell B-1k) with one server +
sink + harness. **What that licenses is an upper bound of unknown tightness,
not a per-box instance count**: the ~317% figure was measured on a process that
also runs the harness conductor, and **the conductor's share of it was never
separated out** — it is unmeasured, and the JS thread it dominates is harness
code. So the honest statement is that one instance under bidirectional load
costs well over one core and probably under three, that one instance per
hardware thread is refuted by the shape of that measurement, and that any
number between those is yours to measure. The capacity document's §1, "Sizing —
an upper bound of unknown tightness", is the authority and deliberately
publishes no instance count. Per-session memory is linear at **126.4832
KB/session** measured from 1k to 10k sessions on this bare-metal rig (`g1.md`
C3; the 5k→10k slope is within 0.48% of the 1k→5k slope), so instance count
barely moves the memory budget — sessions do.

The options for N instances on one box:

**(a) SO_REUSEPORT, kernel steering — the right skeleton, wrong default hash.**
Today the server builds its own socket via
`ServerConfig::builder().with_bind_address(...)`
(`crates/native/src/lib.rs:741-743`); no reuseport flag exists anywhere in the
tree. But the fork already accepts a **pre-built socket**:
`ServerConfigBuilder::with_bind_socket(socket: UdpSocket)` (fork
`wtransport/src/config.rs:386-390`). A socket2-built socket with
`SO_REUSEPORT` set, handed through a new native-crate option, is a small,
fork-untouched change. The caveat is the kernel's default reuseport steering:
it hashes the **4-tuple**, so a NAT rebind moves the flow to a different
process in the group — the §1 failure, now *intra-box*. **This project has no
NAT-rebind measurement** (see §1's correction); the claim is the RFC 9000
deduction, not a soak result. On that deduction, a reuseport fleet without CID
steering silently re-prices every rebind as a session drop. A second, purely
operational hazard is measured by nobody but is a documented kernel property:
changing the membership of a reuseport group **rehashes it**, so restarting
one instance re-steers surviving flows across the whole group.
The fix is standard: an **`SK_REUSEPORT` eBPF program** that parses the QUIC
header's server CID and steers by an instance index embedded in it — which
requires the instance to *choose* CIDs with that index (see §4; the hook
exists). With that pair, one port, N processes, rebind-safe.

**(b) A front L4 UDP forwarder process.** Every packet costs an extra
recv+send and a copy. The campaign's numbers say a single-threaded forwarder
is the new wall almost immediately: the on-box datagram ceiling was ~103k pps
(Cubic, loopback pipe ~105k), the bare-metal cable preflight moved ~81.5k pps,
and single-JS-thread packet work tops out in the tens-of-k ops/s (63k
writes/s at B-1k; ~53k mixed ops/s saturated the G11 conductor thread). A
forwarder in JS/Bun recreates exactly the single-thread wall this campaign
keeps finding, in front of the fleet it exists to scale. A forwarder in
multithreaded Rust with GSO/GRO can work — but at that point you are
reimplementing what the kernel (eBPF) or an existing CID-aware L4 balancer
(e.g. katran-class) does better, with one fewer copy.

**(c) N ports, no entry point.** Run instances on `:4433…:4440` and distribute
via DNS (multiple SVCB/HTTPS records or per-tenant hostnames) or an
application-level "connect to this endpoint" handshake (the token/room server
hands out the port). Zero new moving parts, zero steering risk — rebinds stay
on the same instance because the *port* identifies it. Downsides: client-side
distribution is coarse (no load feedback unless the assigner is load-aware),
and browsers must be given the exact URL. For the project's real deployments
(rooms, fleets, GPS populations with an app-level rendezvous anyway) this is
often *sufficient* and is the honest first rung.

**(d) In-process multi-core.** Not near-term. The addon's `worker_threads(1)`
posture is doc-truth-gated and chosen for correctness, and the
parallelism-analysis conclusion stands: lever order was **H7 batching → the
worker-thread knob → SO_REUSEPORT sharding**. H7 shipped (1.96×); the
worker-thread knob remains unproven; and the G11 ticket-10 verdict is a fresh
demonstration that the JS thread, not the native side, is where single-process
scaling dies. Process sharding is the sanctioned direction.

## 3. Should the balancer be a webtransport-bun instance? No — with three narrow exceptions

A webtransport-bun balancer is an **L7 proxy**: it terminates QUIC + TLS +
HTTP/3 + WebTransport, then re-originates a second QUIC connection fleetward.
Priced with the campaign's own numbers, per byte relayed it pays:

- **Crypto twice** (decrypt client-side, re-encrypt fleet-side).
- **The egress cost twice-ish**: G7 measured ~1,045 CPU-ms/Gbit at the
  friendliest write size (64 KiB) rising 2.5× by 4 KiB — and a relay pays an
  ingest path *and* an egress path per byte.
- **The JS-originator wall on every forwarded unit**: ~63k writes/s at 1 KiB
  (G7 B-1k, V2b both runs), ~26k awaited writes/s while deframing 27k/s
  killed the G11 conductor thread at 40% offer. A proxy's forwarding loop IS
  that thread. The four-axes SFU 1→N attempt was retracted for measuring
  exactly this.

Rule of thumb from those numbers: **one webtransport-bun relay consumes
roughly the capacity of one origin instance to move half an origin's
traffic** — the tier halves fleet capacity and adds a latency hop. As the
*default* balancing layer, refuted.

The narrow cases where an L7 webtransport-bun tier is right:

1. **Application-key affinity / protocol logic** — routing by room, tenant, or
   auth claim that only exists after the WebTransport handshake. That is an
   application gateway, and it should be sized as an origin-class component,
   not as "just a balancer."
2. **Fan-out distribution trees** — one ingest, N downstream sessions is what
   `sendDatagramMirror` was built and measured for (one payload to many
   sessions, synchronous, capped by the 1 ms JS-stall budget;
   `crates/native/src/datagram_mirror.rs`). A mirror relay is a *product
   pattern*, and the paced-broadcast gate is certifying its envelope — but
   note its wall is again the JS thread, so a mirror tier scales by adding
   mirror instances, not by growing one.
3. **Protocol edges** — translating to something else (WS bridge, recording,
   transcoding) where termination is inherent.

Everything else wants a **dumb, CID-aware L4 layer** that never decrypts.

The minimal honest product position: **"webtransport-bun is the origin fleet;
balancing is a documented deployment pattern (DNS/ports → reuseport+eBPF →
QUIC-LB) plus two small hooks the product exposes (socket injection, CID
server-ID). A balancer product is explicitly out of scope."** Nothing in this
investigation refuted that position; the measured numbers argue it.

## 4. Multi-machine / enterprise

The standard ladder, each rung usable with this codebase:

1. **DNS (RR / weighted / GeoDNS / SVCB-HTTPS records)** — distribution
   without any packet-path infrastructure. Same properties as §2(c). Works
   today, nothing to build.
2. **Anycast + ECMP** at the routers — 4-tuple hashed, so path/NAT changes
   re-steer mid-connection with the §1 failure across *machines*. Acceptable
   for short flows; wrong for this product's long-lived sessions unless rung 3
   fixes the routing key.
3. **QUIC-LB — draft-ietf-quic-load-balancers**: the server encodes a
   **server ID** into the CIDs it issues, under a configuration shared with
   stateless L4 balancers, which then route *by CID*. Rebind, migration, and
   ECMP re-steer all survive, because the routing key is the connection's own
   stable name. This is the enterprise answer, and the per-machine second
   level is the same answer recursively: outer bits pick the machine (edge
   balancer), inner bits pick the instance (the SK_REUSEPORT program of §2a) —
   one CID format serves both tiers.

**Codebase readiness for QUIC-LB — better than expected, verified:**

- quinn's CID machinery is pluggable: `trait ConnectionIdGenerator`
  (quinn-proto **0.11.16** `src/cid_generator.rs:10`) installed via
  `EndpointConfig::cid_generator(...)` (`src/config/mod.rs:77` — a
  `Fn() -> Box<dyn ConnectionIdGenerator>` **factory**, not an instance).
  Both cited lines were re-verified against the locked 0.11.16 source and
  hold unchanged; `Cargo.lock:892-893` is the lock this tree builds.
- The fork **exposes the endpoint config mutably**:
  `ServerConfig::quic_endpoint_config_mut()` (fork
  `wtransport/src/config.rs:274`; endpoint consumed at
  `wtransport/src/endpoint.rs:144`). So the native crate can install a
  server-ID-encoding generator **today, with zero further fork changes** —
  the missing piece is ~a hundred lines in `crates/native` plus a config
  field (`serverId` / env) on the JS surface.
- The default today is quinn's `HashedConnectionIdGenerator` via
  `EndpointConfig::default()` (fork `config.rs:423`), which encodes nothing.

**Fleet state, by kind:**

- **Draining and health**: already product features — capsule-driven close,
  wire-driven draining, `WT_SESSION_GONE` teardown (Track 1, merged `ef07c7a`;
  `crates/native/src/session.rs`, `session_napi.rs`). An instance can be
  drained behind any balancer rung; idle timeout reaps what a dead instance
  strands (`lib.rs:745`).
- **Stateless reset keys**: settable (`reset_key`, quinn-proto 0.11.16
  `config/mod.rs:87`) but not plumbed; per-process random today
  (`config/mod.rs:186-189`). Share it fleet-wide only as a
  deliberate feature (with the draft's caveats about reset linkability).
- **0-RTT / resumption tickets**: per-process store
  (`zero_rtt.rs:222`); cross-instance landing = full handshake. Fleet-shared
  ticket keys would need rustls ticketer plumbing — **not exposed today**, and
  fine to defer: the fallback is safe.

## 5. Recommendation — staged, priced, and bounded

**Now (documentation only, no code):** publish the deployment pattern in the
ticket-09 capacity document: sizing guidance stated as **an upper bound of
unknown tightness** rather than an instance count — one instance per hardware
thread is refuted, the per-instance cost is above one core and probably under
three, and the conductor's share of the measurement that says so is
**unmeasured** — plus the measured per-instance envelopes, rung 1 = DNS/ports
(§2c) as the supported pattern, and the explicit statement that 4-tuple-hash
balancers (plain reuseport, plain ECMP) stall a session at every NAT rebind
until its idle timeout expires and are therefore unsupported for
long-lived-session deployments. The capacity document's §1 is where that sizing
language lives; it publishes no per-box number and this document must not
either.

**Next (two small product hooks, in lever order):**
1. **Socket injection / `reusePort: true`** — native-crate option built on the
   fork's existing `with_bind_socket` (`config.rs:390`). Cheap, enables all
   kernel-steered patterns, useful for bench harnesses too.
2. **CID server-ID hook** — a `ConnectionIdGenerator` embedding a configured
   instance/server ID, installed through `quic_endpoint_config_mut()`. This is
   the one primitive that unlocks both the eBPF intra-box steer and QUIC-LB
   across machines. Design it against draft-ietf-quic-load-balancers' plain
   CID algorithm first (encrypted CIDs later, if ever).

**Later, as examples not products:** a reference `SK_REUSEPORT` eBPF steering
program + a QUIC-LB config note in `docs/` (the same place linux-tuning.md
lives); shared reset-key option if fleet failover UX ever demands it.

**Do not build:** an L7 balancer product, a JS/Bun UDP forwarder, or in-process
multi-core scheduling ahead of the worker-thread-knob evidence. Each is
refuted by a number this campaign already paid for.

**Not verified here, disclosed:** rustls ticket-key sharing depth in the fork
(0-RTT across instances); the exact eBPF program verifier constraints on the
target kernels; QUIC-LB draft version currency (cited as
draft-ietf-quic-load-balancers; pin the revision when the CID hook is
designed); and Bun-level `SO_REUSEPORT` interactions if the JS side ever owns
the socket (today it never does — the addon owns it).
