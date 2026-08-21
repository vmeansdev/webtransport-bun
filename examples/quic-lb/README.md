# QUIC-LB CID steering — reference `SK_REUSEPORT` program

**This is an example, not a shipped component.** Nothing in this directory is
compiled, tested, loaded, or published. It is not part of the npm package, no
CI job touches it, and no kernel in this project has ever run it. It exists so
an operator building CID-aware steering has a correct starting point instead of
a blank file.

- [`steer_by_cid.bpf.c`](steer_by_cid.bpf.c) — the BPF program.
- [`attach.sh.example`](attach.sh.example) — a loader sketch, equally untested.

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

This is the same layout the two pinned implementations carry in full, both
against **draft-ietf-quic-load-balancers-21**:
`crates/native/src/quic_lb.rs` and `packages/webtransport/src/quic-lb.ts`.

## Fallback policy: pass, never drop

Every early return is `SK_PASS` **without** selecting a socket, which leaves the
kernel to apply its own 4-tuple hash. That covers:

- **the first flight** — a client's Initial carries a destination CID the
  *client* chose at random (RFC 9000 §7.2); the server has issued nothing yet,
  so no CID-based scheme can route it. This window lasts until the client
  adopts a server-issued connection ID. It is short, and it is not zero: a
  rebind inside it still breaks the connection.
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

- Linux with `SK_REUSEPORT` and `BPF_MAP_TYPE_REUSEPORT_SOCKARRAY` (4.19+ in
  principle; **written against 7.0.0-30-generic** as the reference target and
  verified against no kernel at all).
- clang/LLVM 18+ for the BPF target, `bpftool`, and `libbpf` headers.
- `CAP_BPF` + `CAP_NET_ADMIN` (or root) to load and attach.
- Kernel BTF (`/sys/kernel/btf/vmlinux`) for a CO-RE build.

## The gap between this and a working deployment

Attaching the program (`SO_ATTACH_REUSEPORT_EBPF`) and inserting each socket
into the sockarray both need the socket's file descriptor, so both must happen
inside a process that owns the socket. `reusePort: true` builds and owns that
socket inside the native addon and does not expose its fd to JS. Closing that
gap needs either a supervisor that creates the sockets and passes them in, or an
addon that performs the attach itself. Neither exists in this repository, and
neither is planned here.
