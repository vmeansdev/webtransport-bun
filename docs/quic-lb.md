# QUIC-LB: routing by connection ID

How the two deployment hooks compose into something a balancer can steer.

This is the operator's note. The option reference lives in
[`OPERATIONS.md`](OPERATIONS.md) — "Multi-process binds (`reusePort`)" and
"QUIC-LB connection IDs (`quicLb`)" — the capacity and sizing argument lives in
[the bare-metal capacity document](research/2026-08-21-bare-metal-capacity.md),
and the reference eBPF program lives in
[`examples/quic-lb/`](../examples/quic-lb/README.md).

Everything here is pinned to **draft-ietf-quic-load-balancers-21**, the same
revision as `crates/native/src/quic_lb.rs` and
`packages/webtransport/src/quic-lb.ts`.

## The problem in one paragraph

A TCP connection *is* its 4-tuple. A QUIC connection deliberately is not: it is
named by its connection IDs precisely so it can survive an address change (RFC
9000 §5.1, §9). Anything that steers by hashing the UDP 4-tuple — plain kernel
`SO_REUSEPORT`, plain ECMP, a stock L4 balancer — has bound the connection to
the one property QUIC was designed to let go of. When the client's address
changes, the hash changes, and the packets arrive at a backend that has never
heard of that connection. QUIC-LB's answer is to put a routing key inside the
connection ID, where it travels with the connection.

**This is a deduction, not a measurement.** No test, gate, or soak in this
project exercises a client address change; "rebind" in this repository's history
means a *release-evidence* rebind, an unrelated thing. The argument is standard
and it is load-bearing, but nobody here has watched a 4-tuple balancer drop a
session, and this document will not imply otherwise. See the capacity document's
Deployment §3 and disclosure (d).

## One box: `reusePort` + `quicLb` + the eBPF example

One port, N processes, steered by connection ID.

```ts
// instance 1 of 3 — same port, distinct server ID
createServer({
  port: 4433,
  reusePort: true,
  quicLb: { serverId: new Uint8Array([0x00, 0x07]), nonceLen: 8 },
  tls, onSession,
});
```

Three pieces, and each is inert without the others:

1. **`reusePort: true`** puts every instance's socket in one `SO_REUSEPORT`
   group on port 4433. Alone, this gives you the kernel's 4-tuple hash — the
   unsupported thing above. The flag exists *for* this pattern and for bench
   rigs, and its documentation says so at the option.
2. **`quicLb`** makes each instance write its own server ID into every
   connection ID it issues, in the clear. Alone, this changes nothing about
   delivery: it only gives a steering layer something stable to read.
3. **An `SK_REUSEPORT` eBPF program** attached to the group reads the server-ID
   bytes and selects the matching socket, instead of hashing.
   [`examples/quic-lb/steer_by_cid.bpf.c`](../examples/quic-lb/steer_by_cid.bpf.c)
   is a reference for writing one — not compiled, not tested, not shipped.

The result is rebind-safe **after the first flight**: once the client adopts a
server-issued connection ID, its packets carry the server ID wherever the client
moves, and the kernel delivers them to the same process.

### What one box still owes you

- **The first flight is never CID-routable.** A client's Initial carries a
  destination connection ID the *client* chose at random; the server has issued
  nothing yet. Every CID-based scheme falls back to 4-tuple hashing for that
  window, and a rebind inside it still breaks the connection. Short, not zero.
- **Sockarray maintenance is the hard part.** A socket leaves
  `BPF_MAP_TYPE_REUSEPORT_SOCKARRAY` when its process dies, and only the process
  owning a socket can insert one. A restarted instance must re-register at the
  same slot under the same server ID; until it does, its flows take the fallback
  (4-tuple hashing). What the CID steer buys is *confinement*: on a plain
  reuseport group, changing membership rehashes the whole group and one restart
  re-steers the siblings' surviving flows too. The example's README covers this.
- **The attach step is not wired up here.** `SO_ATTACH_REUSEPORT_EBPF` and the
  sockarray insert both need the socket's file descriptor, which lives inside
  the native addon. Closing that gap needs a supervisor that owns the sockets or
  an addon that attaches for you; neither exists in this repository.
- **Sizing first.** Instances-per-box comes from the capacity document, whose
  sizing chapter is an upper bound of unknown tightness — read it before
  choosing N.

## Across machines: `quicLb` + a QUIC-LB-aware L4 balancer

Above one box, the balancer is somebody else's software. What this project
provides is the CID format it needs.

Configure each machine's instances with server IDs from one plan, configure the
balancer with **the same `serverIdLen`, `nonceLen`, and config rotation**, and
it can route by reading the connection ID out of the packet header, statelessly,
without per-flow state and without terminating anything.

The two layers compose recursively on one connection ID: **outer bits of the
server ID pick the machine, inner bits pick the process on it** — draft-21 §7.2,
Server Process Demultiplexing. With `serverId: [machine, process]` and a 2-octet
ID, an external balancer routes on the first octet and the box's eBPF program
routes on both. Nothing coordinates the two layers except the shared numbering
plan, which is why that plan should be written down before the first instance
starts.

The package exports pure decoders so the same numbering plan can be checked from
tests or tooling without loading the addon or opening a socket:

```ts
import {
  decodeQuicLbServerId,
  decodeQuicLbConfigRotation,
} from "@webtransport-bun/webtransport";
```

`serverIdLen` is yours to supply from configuration; **it is never on the wire.**

### The fact that governs every layout decision

The first octet of a QUIC-LB connection ID is three config-rotation bits and
**five random bits**. It does not describe the connection ID's length, the
server-ID length, or the nonce length — draft §3.3 reserves those bits for
hardware crypto offload and, where that is unused, requires them to be
uncorrelated with previous connection IDs. A balancer, an eBPF program, or any
other reader gets all three lengths from **its own configuration**, which must
match the server's `quicLb` option byte for byte. A mismatch is undetectable
from the wire: the reader decodes nonce bytes as a server ID, routes at random,
and the symptom looks like a flaky network.

## Overhead

A QUIC-LB connection ID is `1 + serverId.length + nonceLen` octets — **11** for
the example above, **6** at minimum, up to 20 — against quinn's **8**-octet
default. Once the client adopts a server-issued connection ID, the difference is
paid on the destination-CID field of **every short-header packet in both
directions**, for the life of the connection.

Against this rig's measured egress that is small but not free: G7's stream cell
moved **1.2498 Gbps** at ≤79% host CPU, and at the ~1,400-byte datagrams that
path carries, three extra header octets is roughly **0.2%** of the wire bytes;
G3's egress cell ran with GSO and GRO active at 64 segments, so the extra bytes
ride the same syscalls rather than costing new ones. **It has not been
measured** — no gate has run with `quicLb` enabled. If your fleet is small and
the bytes matter, a minimal `nonceLen` (4) and a short `serverId` shrink it, at
the cost of the unlinkability budget §5.4 asks you to keep.

## What is deferred

**Keyed (encrypted) QUIC-LB configuration.** What ships is the *keyless*
configuration of §5.3: the 16-octet key is optional, and without it the server
writes its server ID into the connection ID in cleartext. The draft states the
cost in its own words (§5.3): "failure to define a key means that observers can
determine the assigned server of any connection, significantly increasing the
linkability of QUIC address migration." Any on-path observer can read which
backend serves a connection, count your fleet, and link a connection across a
migration QUIC would otherwise make unlinkable. The keyed configuration is the
same wire format with the plaintext block encrypted — a later option, not a
different scheme. It is not implemented.

**Shared fleet-wide reset keys.** Reset keys are random **per process**, which
decides what a mis-steered flow actually does, and the intuitive guess is wrong
in the expensive direction. Traced through quinn-proto 0.11.16 (capacity
document, Deployment §3): the wrong backend may try a stateless reset, but the
token is HMAC'd with *its* key while the client only recognises a token derived
from the original backend's — so the client discards it, and most stranded flows
are rate-limited into getting no reset at all. **A mis-steered connection does
not die promptly; it stalls to idle timeout** — 60 s by default server-side,
with keep-alive pings off, and potentially unbounded for a client configured
with `idleTimeoutMs = 0`. A shared reset key is the thing that would convert
that stall into a prompt failure. It is out of scope here, conditional on fleet
failover UX ever demanding it.

The same per-process randomness is why a `SO_REUSEPORT` group's cross-process
stateless resets are invalid: sibling processes on one port cannot reset each
other's connections either.

## Not verified here

- No NAT-rebind measurement exists in this project; the rebind argument is a
  reading of RFC 9000 and of quinn-proto's source.
- Reuseport rehash-on-restart has not been measured on any target kernel.
- The eBPF example has never been compiled, loaded, or verifier-checked.
- No gate has run with `quicLb` enabled, so its byte overhead is arithmetic, not
  a measurement.
