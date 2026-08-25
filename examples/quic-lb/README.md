# QUIC-LB CID steering — reference `SK_REUSEPORT` program

**This is an example, not a shipped component.** Nothing in this directory is
built by the repository, tested, loaded, or published. It is not part of the
npm package and no CI job touches it. It exists so an operator building
CID-aware steering has a correct starting point instead of a blank file.

Exactly one claim is backed by a run: on 2026-08-21, on the campaign's
bare-metal box (Linux 7.0.0-30-generic, libbpf-dev installed),
`clang -target bpf -O2 -g -c steer_by_cid.bpf.c` compiled clean — zero
diagnostics, a 15,984-byte object. That establishes that it parses and
type-checks against that kernel's headers, and nothing else.

**Update, same day: the post-review source compiles too.** The current text (tip `f7c9058`, after the review fixes) was recompiled on the same box with the same command — clean, zero diagnostics. The pre-review note below is kept for provenance; it was run against the revision
before the review fixes now in the file (the short-header fixed-bit test
removed, Initial/0-RTT routed by DCID, `steer_stats` moved to a per-CPU array).
The re-compile on the box is owed and has not been run; until it is, treat the
clean-compile result as belonging to the earlier revision.

**The program has never been submitted to a verifier, never attached to a
socket, and never carried a packet.** Verifier acceptance and runtime behavior
are yours to establish on the kernel you target. The loader below has never
been run at all.

- [`steer_by_cid.bpf.c`](steer_by_cid.bpf.c) — the BPF program; compiles, never loaded.
- [`attach.sh.example`](attach.sh.example) — a loader sketch, never executed.

For how this composes with the server options, read
[`docs/quic-lb.md`](../../docs/quic-lb.md).

## What it does

`createServer({ reusePort: true })` lets several server processes share one UDP
port. By default the kernel picks one by hashing the packet's 4-tuple, which is
the wrong key for QUIC: a connection is named by its connection IDs so that it
can survive an address change, and hashing the 4-tuple binds it to exactly the
thing QUIC lets go of. After a NAT rebind the packets land on a sibling process
that has never heard of the connection.

`createServer({ quicLb: { serverId, nonceLen } })` writes this instance's
server ID into every connection ID it issues, in the clear. This program reads
those bytes out of the packet header and calls `bpf_sk_select_reuseport` to
hand the packet to the socket that owns them — so the steering follows the
connection, not the address.

Per packet:

1. Read the QUIC header out of the UDP payload. Long header (RFC 9000 §17.2):
   skip the version and the DCID-length octet to reach the destination
   connection ID. Short header (§17.3): the connection ID starts at byte 1 and
   **its length is not on the wire**.
2. Check the first octet's config-rotation codepoint (draft §3.1).
3. Read `SERVER_ID_LEN` octets at the configured offset, look the server ID up
   in a hash map to get a sockarray slot, and select that socket.
4. Anything unparseable, unroutable, or unknown falls back (see below).

Two header checks are deliberately *absent*, and both matter:

- **The fixed bit is never tested.** RFC 9000 §17.3 requires bit `0x40` set on a
  short header, but RFC 9287 (Greasing the QUIC Bit) lets an endpoint clear it
  at random once its peer has offered the `grease_quic_bit` transport
  parameter — and quinn turns that on by default (`grease_quic_bit: true`,
  quinn-proto 0.11.16 `config/mod.rs:63`), which this repository does not
  override. A program that demands the bit sends roughly half of a greasing
  client's 1-RTT packets to the 4-tuple hash. What rejects foreign traffic
  instead is the config-rotation codepoint plus the map lookup.
- **Long-header packet type is not used to reject Initial or 0-RTT.** Only the
  packet type `Retry` is dropped out (server-to-client). Everything else is
  routed by its DCID, because most Initials carry a server-issued one — see the
  fallback section.

## The configuration must match the server

The single most important fact about the QUIC-LB wire format:

> The first octet's five low bits are **random**. They are not a length. A BPF
> program cannot read any length from the wire — not the server-ID length, not
> the nonce length, not the total connection-ID length.

All three come from the program's own `#define`s and must equal the server's
`quicLb` option exactly:

| Program constant | Server option |
|---|---|
| `SERVER_ID_LEN` | `quicLb.serverId.length` |
| `NONCE_LEN` | `quicLb.nonceLen` |
| `CONFIG_ROTATION` | `quicLb.configRotation` (default `0`) |
| `CID_LEN` | derived: `1 + serverId.length + nonceLen` |

A mismatch is undetectable from the wire. The program decodes nonce bytes as a
server ID, misses in the map, and falls back to 4-tuple hashing on every
packet — which presents as a flaky network rather than as a misconfiguration.
The `steer_stats` counters exist for exactly this: a fallback count that keeps
climbing after handshakes settle means the layouts disagree or a slot is empty.

`steer_stats` is a **per-CPU** array, so the increment on the packet path costs
no atomic and no shared cache line — but the reader pays for that: `bpftool map
dump` prints one value per CPU for each key and **the counter is their sum**.
Whatever scrapes it must add the CPUs up; reading the first element reports one
core's share and will look like the fallback rate is a fraction of what it is.

This is the same layout the two pinned implementations carry in full, both
against **draft-ietf-quic-load-balancers-21**:
`crates/native/src/quic_lb.rs` and `packages/webtransport/src/quic-lb.ts`.

## Fallback policy: pass, never drop

Every early return is `SK_PASS` **without** selecting a socket, which leaves the
kernel to apply its own 4-tuple hash. That covers:

- **the opening flight, and only that** — the client's *first* Initial carries a
  destination CID the *client* invented (RFC 9000 §7.2); the server has issued
  nothing yet, so no CID-based scheme can route it, and the random CID fails
  the length, rotation, or map check and lands here. **The window closes as
  soon as the client sees the server's Initial or Retry**: from that point
  §7.2 requires it to use the server's Source Connection ID as the destination
  "for subsequent packets, including any 0-RTT packets", so retransmitted
  Initials, the Initial that acknowledges the server's flight, and post-Initial
  0-RTT all carry our server ID and are steered normally. The unsteerable
  window is therefore one client flight, not the whole handshake — short, and
  not zero: a rebind inside it still breaks the connection.

  One residual risk comes with routing Initials rather than excluding them: a
  client-chosen random CID that is exactly `CID_LEN` octets, whose top three
  bits happen to equal `CONFIG_ROTATION`, and whose next `SERVER_ID_LEN` octets
  happen to hit in the map, gets steered. It is bounded — an opening Initial
  belongs to no instance yet, so any member may answer it; the worst case is a
  first flight split across two instances, which the client retransmits out of.
- **Version Negotiation and Retry** — server-to-client packets that should
  never arrive on an ingress port, and carry nothing of ours to steer by.
- **non-v1 versions** — a header shape this parser was not told how to read.
- **too-short datagrams** — anything that cannot hold the header being parsed.
- **unroutable or foreign connection IDs** — a config-rotation codepoint that
  is not ours (including `0b111`, reserved for unroutable, draft §3.2), a
  server ID that misses in the map, or a slot whose socket is gone.

Passing rather than dropping is deliberate. Most of what reaches the fallback is
legitimate traffic that simply cannot be routed by connection ID *yet*, and a
program that drops what it does not understand black-holes new connections and
any stray probe on the port. The cost of passing is that those packets get
4-tuple steering, which is not rebind-stable — for the first flight that is
unavoidable, and for a foreign CID it is harmless.

## Restarts, rehashing, and the actually hard part

Keeping `BPF_MAP_TYPE_REUSEPORT_SOCKARRAY` correct across instance restarts is
the operator's problem and is the hard part of this pattern.

A socket leaves the sockarray when its process dies, and **only the process that
owns a socket can insert it** — the map update takes a live file descriptor.
When an instance restarts, its replacement must re-register at the same slot,
under the same server ID. Until it does, that instance's connections miss in the
map and take the fallback: 4-tuple hashing, the behaviour this program exists to
avoid, for as long as the gap lasts.

Note what this pattern buys even so. On a *plain* (unsteered) reuseport group,
changing group membership rehashes the whole group — one instance restarting
re-steers its siblings' surviving flows too, turning a rolling restart into a
box-wide session event. A CID steer confines the damage to the restarting
instance's own flows, and only until its slot is repopulated. That is the whole
argument for doing this, and it holds only if the re-registration is reliable.

None of this has been measured on any kernel by this project.

## Requirements

- Linux **5.2 or newer**, with `SK_REUSEPORT` and
  `BPF_MAP_TYPE_REUSEPORT_SOCKARRAY`. Those two features landed in 4.19, but
  this program declares its maps in libbpf's BTF style (`__uint`/`__type`),
  which needs the BTF-defined map support added in 5.2 — on 4.19 the object
  will not load without rewriting the map definitions in the old
  `struct bpf_map_def` form. **Written against 7.0.0-30-generic** as the
  reference target and verified against no kernel at all.
- clang/LLVM 18+ for the BPF target, `bpftool`, and `libbpf` headers.
- `CAP_BPF` + `CAP_NET_ADMIN` (or root) to load and attach.

**This is not a CO-RE build.** The program includes the kernel uapi headers
directly — there is no generated `vmlinux.h`, no `BPF_CORE_READ`, and the
`clang -target bpf -O2 -g -c` line in `attach.sh.example` has no BTF-relocation
step. The object is bound to the ABI of the headers it was built against, so
build it on (or against the headers of) the kernel that will load it. Porting
it to CO-RE — `vmlinux.h`, `bpf_core_read.h`, and field reads through
`BPF_CORE_READ` — is a reasonable upgrade path and has not been done here.

## The gap between this and a working deployment

Attaching the program (`SO_ATTACH_REUSEPORT_EBPF`) and inserting each socket
into the sockarray both need the socket's file descriptor, so both must happen
inside a process that owns the socket. `reusePort: true` builds and owns that
socket inside the native addon and does not expose its fd to JS. Closing that
gap needs either a supervisor that creates the sockets and passes them in, or an
addon that performs the attach itself. Neither exists in this repository, and
neither is planned here.
