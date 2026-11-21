# Running more than one server process

Every scenario guide eventually reaches the point where one process is not
enough. This guide covers how to size processes, the deployment pattern this
project supports, the one-port sharded pattern the G6 MMO campaign ran at
40,000 sessions (in a campaign build), and the patterns that look attractive
and break long-lived sessions. The measured figures behind it are in [CAPACITY.md](../CAPACITY.md).

## Sizing: start small and measure

- **An instance is not a thread.** A loaded server process is a multi-thread
  process: one JavaScript thread plus the addon's Tokio workers and I/O. Under
  a bidirectional stream load the campaign measured a process at about 317%
  of one core, with the JavaScript thread at 93–95%. That process held the
  server and the benchmark conductor together, and the JavaScript thread's
  dominant consumer was the harness code, so a server alone costs less by an
  unmeasured amount. Plan a few processes per box and measure, not one per
  hardware thread.
- **The JavaScript thread is the usual ceiling.** Many small writes, per-packet
  callbacks and payload construction all share it. When it saturates, tail
  latency grows sharply while throughput holds (see OPERATIONS.md,
  [Sizing the JS read side](../OPERATIONS.md#sizing-the-js-read-side-stream-tail-latency)).
  More processes fix that; a bigger machine running one process does not.
- **Memory scales with sessions, not processes.** About 126.5 KB per session,
  linear from 1,000 to 10,000 sessions, plus whatever your application keeps.
- **The published per-process figures are upper bounds of unknown tightness.**
  Most were measured with the load generator on the same machine, and some
  with harness code in the same process, so part of the cost belongs to the
  generator, by an amount nobody measured. Verify the
  process count on your own hardware.

## The supported pattern: one port (or address) per process

Run N independent processes, each on its own port or address, and tell each
client exactly which one to use. There is no balancer process.

```
                       ┌─▶ https://game.example.com:4433  (process 1)
lobby / matchmaker ────┼─▶ https://game.example.com:4434  (process 2)
hands out the URL      └─▶ https://game.example.com:4435  (process 3)
```

Assignment is client-side: your rendezvous service (lobby, room server, token
server, matchmaker) returns the URL, or DNS does (several HTTPS/SVCB records,
weighted or geo records, per-tenant hostnames). Rooms, tenants, realms and
device fleets usually have such a rendezvous already.

Why this is the default:

- **It survives client address changes.** The port is the process identity.
  When a client's NAT mapping changes or it moves from Wi-Fi to cellular, its
  packets still arrive at the same port, and QUIC's connection migration takes
  over from there.
- **Nothing is added to the packet path.** No extra hop, no copy, no steering
  program.
- **Draining is built in.** To retire a process, stop handing out its URL and
  ask its sessions to move: `session.drain()` sends WT_DRAIN_SESSION and
  `session.goAway()` sends GOAWAY, and clients observe both through
  `session.draining`. `server.close()` ends whatever remains with close code
  3993 (`E_SERVER_CLOSING`).

The cost is coarseness: unless your assigner knows each process's load, there
is no feedback, and browsers must be given the exact URL.

```ts
// One process per port, started N times with PORT=4433, 4434, ...
const server = createServer({
  port: Number(process.env.PORT),
  host: "0.0.0.0",
  tls: { certPem, keyPem },
  onSession,
});
```

## One port, many processes (Linux, experimental)

When clients must all use one port, the processes can share it through a
Linux `SO_REUSEPORT` group, **provided** an eBPF program steers packets by
connection ID. This is the layout that passed the G6 MMO realm at 40,000
sessions on 24 processes, in a campaign build that also ran pieces outside
the supported library (an internal ack reflector and 3 server workers per
process; details in [realtime-games.md](realtime-games.md#not-proven)). The
steering layout is the public part; the 40,000 figure is not a
shipped-library result. All three options involved are experimental (they
may change in a 1.x minor; [SPEC.md](../SPEC.md), "Experimental surfaces").

How it works: each process writes its own server ID into every connection ID
it issues (`quicLb`); the eBPF program attached to the socket group reads that
server ID from each incoming packet and hands the packet to the owning
process's socket. The connection ID travels with the connection when the
client's address changes, so steering survives a rebind, unlike a hash of the
addresses. [quic-lb.md](../quic-lb.md) explains the wire format and its costs.

### 1. Build, load and populate the steering program

Requirements: Linux 5.2 or newer, clang/LLVM with the BPF target, `bpftool`,
libbpf headers, and root (or `CAP_BPF` + `CAP_NET_ADMIN`). Work from
[`examples/quic-lb/`](../../examples/quic-lb/), whose
[`attach.sh.example`](../../examples/quic-lb/attach.sh.example) holds the
steps the campaign ran:

```bash
cd examples/quic-lb
cp attach.sh.example attach.sh && chmod +x attach.sh
# Edit SERVER_ID_SLOTS in attach.sh: one row per process, e.g. ["00 01"]=0 ... ["00 18"]=23
sudo MAX_INSTANCES=24 ./attach.sh build      # sockarray slots; default 8
sudo ./attach.sh load                        # pins program + maps under /sys/fs/bpf/quic-lb
sudo ./attach.sh populate                    # server ID -> slot table
```

The program's compile-time layout (`SERVER_ID_LEN` 2, `NONCE_LEN` 8,
`CONFIG_ROTATION` 0) must equal every process's `quicLb` option. Nothing on the
wire can detect a mismatch: packets silently fall back to the kernel's 4-tuple
hash.

### 2. Start one process per slot

```ts
const shard = Number(process.env.SHARD); // 1..N
const server = createServer({
  port: 4433,                                  // the same port in every process
  tls: { certPem, keyPem },
  reusePort: true,
  quicLb: { serverId: [0, shard], nonceLen: 8 }, // row ["00 <shard>"] of the table
  reusePortSteering: {
    sockArrayPinPath: "/sys/fs/bpf/quic-lb/socks",
    key: shard - 1,                            // that row's slot
    // One process attaches the program to the group; attaching once is enough.
    ...(shard === 1 ? { attachProgPinPath: "/sys/fs/bpf/quic-lb/steer_by_cid" } : {}),
  },
  onSession,
});
```

Each process inserts its own socket into the sockarray at startup. A missing
pin, a wrong path or a missing capability makes `createServer` throw instead of
quietly running on the kernel hash.

### 3. Verify the steering

```bash
sudo ./attach.sh stats
```

`steer_stats` index 0 counts steered packets and index 1 counts fallbacks. It
is a per-CPU map: each counter is the **sum** over CPUs. Fallbacks are
expected for each connection's first client flight (the client invents that
connection ID). A fallback count that keeps climbing after handshakes settle
means the layout disagrees with a server's `quicLb` option, or a slot is
empty.

### 4. Tune the host

Raise the UDP buffers as in the scenario guides
(`net.core.rmem_max`/`wmem_max`/`rmem_default`/`wmem_default` and
`net.ipv4.udp_rmem_min`/`udp_wmem_min`, 26214400 on the campaign rigs), and
`fs.file-max` / `ulimit -n` for large fleets. If many connections share one
source address and port, as they do from load generators, turn the server
NIC's GRO off (`ethtool -K <iface> gro off`): GRO can merge datagrams from
different connections into one super-packet, which the program steers by its
first segment only. In the campaign that silently lost 12.4% of packets at
30,000 sessions until GRO was turned off.

### 5. Restarts

A socket leaves the sockarray when its process exits, and only the process
that owns a socket can insert it. A restarted process re-inserts itself at its
slot on startup through `reusePortSteering`; until it is back, its clients'
packets take the 4-tuple fallback. Restart one process at a time, under the
same server ID and slot. Restart behaviour under load has not been measured.

## Across machines: QUIC-LB aware balancers

The same `quicLb` connection-ID format lets a stateless, QUIC-LB-aware L4
balancer route by connection ID across machines (outer bits pick the machine,
inner bits the process). The balancer is third-party; this project ships the
server side only and has not run one. See [quic-lb.md](../quic-lb.md).

## What not to do: hash the 4-tuple

Plain `SO_REUSEPORT` without the eBPF program, ECMP, and any L4 balancer that
hashes the UDP source and destination addresses and ports are **unsupported
for long-lived sessions**.

A QUIC connection is deliberately not its 4-tuple: it is named by connection
IDs so it can survive an address change. A 4-tuple hash binds it to exactly
the thing QUIC lets go of. When a client's address changes, its packets hash
to a different process, which has never heard of the connection. That process
does not reset it usefully either: its stateless reset is signed with its own
per-process key, so the client discards it. The connection does not fail; it
**stalls** until the idle timeout (60 s by default). A user sees a minute of
silence instead of a reconnect.

Two more effects of a plain reuseport group: adding or removing a member
(any restart or crash) rehashes **every** flow on the box, not just the
departing process's; and the kernel's distribution is Linux behaviour (macOS
and BSD deliver to the last socket bound).

4-tuple hashing is acceptable for short-lived connections or clients on
stable networks (datacenter-internal traffic). It is the wrong default for
every scenario in these guides, which are all long-lived.

## Not verified by this project

- No test changes a client's address (NAT rebind, network handover); the
  rebind argument comes from RFC 9000 and quinn-proto's source.
- Reuseport rehashing on restart has not been measured on any kernel.
- The eBPF program has run on the campaign's DigitalOcean Linux droplets only.
- 0-RTT tickets are per process: a client resuming against another process
  falls back to a full handshake (correct, slower). Sharing ticket keys across
  processes is not exposed.
- Keyless QUIC-LB connection IDs carry the server ID in cleartext: an on-path
  observer can tell which process serves a connection. Encrypted QUIC-LB
  connection IDs are not implemented.
