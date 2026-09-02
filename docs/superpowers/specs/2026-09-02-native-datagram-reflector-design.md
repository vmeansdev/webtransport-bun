# Native Datagram Reflector (Ack Fast Path) Design

**Status:** Approved in chat 2026-09-02 (surface, registration, approach A1,
sections 1–6); written spec pending maintainer review.

**Goal:** Remove the per-action JavaScript round trip from the G6 ack path by
reflecting stamped datagrams inside the native crate, so ack latency no longer
depends on the shard's JS loop, while keeping every registered quantity of the
c-32/c-48 campaign reconcilable from sealed evidence.

## Evidence this answers

Run r83 (c-48-intel, 24 shards, 25 MiB receive buffer on both hosts) showed that
the 30,000-session rung fails only on S4, the client-measured ack round trip
(p99 83.5 ms against a 25 ms bound), while:

- the server's own in-handler hold, carried inside every ack, is p99 0.02 ms at
  every rung, so the handler is not where the time goes;
- ack RTT p50 rises 0.44 → 0.53 → 2.21 → 11.58 ms across 5k/10k/20k/30k, so the
  delay is systematic queueing before the handler runs or after it hands the
  ack back;
- per-interface counters on both hosts prove zero loss on the path and the
  UDP-counter gaps are GRO/GSO accounting; real client→server datagram loss is
  0.34% and sits inside the server;
- per-shard CPU fits 0.32 + 0.88 cores per 1,000 sessions, one JS thread plus
  two Tokio workers per shard, with the generator idle and the box at 72%.

Each action datagram today crosses native→JS, is decoded and stamped in JS, and
its ack crosses JS→native through a per-datagram call: about 5,000 round trips
per second per shard at 30k, serialized behind the 15 Hz snapshot tick and GC.
Snapshot fan-out is already native (one mirror call covers ~125 sessions), so
the action path is the remaining serial JS work.

## Decisions taken

1. **Surface: a generic, protocol-agnostic reflector** as a product API of
   webtransport-bun, not a G6-specific hook. Native learns nothing about the
   G6 stamp; the G6 harness expresses its v3 stamp as one rule.
2. **Reflected datagrams are consumed, not delivered.** A matched datagram
   never reaches `incomingDatagrams()`. "Reflect and still deliver" was
   rejected because it keeps the per-action JS crossing and only moves the ack
   send.
3. **Registration: amend S4 to the native path.** From the next run the ack is
   reflected natively; reflected actions count toward S1 through native
   counters; rungs graded after the amendment are not comparable with r75–r83
   on S4.
4. **Approach A1: reflect inline on the connection's forward task.** The task
   that already receives, counts, rate-limits and size-checks each datagram
   reflects a match and skips the queue. Rejected: a per-server reflector task
   fed by a channel (an extra hop and queue for no benefit) and reflecting
   inside the native side of the JS batch reader (stays coupled to the JS loop
   cadence, which defeats the purpose).

## Section 1: the rule

One rule per server, set from JS:

```ts
type DatagramReflectorRule = {
  minLength: number;            // datagrams shorter than this never match
  replyLength: number;          // the reply is the first replyLength bytes, then ops
  match: { offset: number; bytes: Uint8Array }[];   // all ranges must equal
  rewrite: ReflectorOp[];       // applied in order to the reply buffer
};
type ReflectorOp =
  | { op: "copy"; from: number; to: number; length: number }
  | { op: "nowNs"; at: number }    // u64 LE, server monotonic clock at reflection
  | { op: "holdNs"; at: number }   // u64 LE, receive-to-reflection duration
  | { op: "zero"; at: number; length: number }
  | { op: "set"; at: number; value: number };  // one byte, 0..255
```

Validation runs once at set time, in TypeScript and again in native, so a
raw-addon caller cannot bypass it:

- `1 ≤ replyLength ≤ minLength ≤ 1200`;
- every match range lies inside `[0, minLength)`; every op range inside
  `[0, replyLength)`; `nowNs` and `holdNs` need 8 bytes; `copy` needs
  `length ≥ 1` and both ranges in bounds (overlap allowed; semantics are
  `memmove`);
- `1 ≤ match.length ≤ 8`, `0 ≤ rewrite.length ≤ 16`;
- byte order is little-endian and not configurable.

The per-datagram path therefore performs no bounds checks. Ops are applied in
the listed order; a `copy` that must read a field before it is overwritten is
listed before the overwriting op, as the G6 rule below does.

**The G6 v3 stamp as a rule** (offsets from `tools/load/latency-stamp.ts`:
magic 0x4c54 at 0, version at 2, intended at 4, actual at 12, sequence at 20,
echoActual at 28, hold at 36, class at 44; 48 bytes; action class 1, ack class
2):

```ts
{
  minLength: 48, replyLength: 48,
  match: [
    { offset: 0, bytes: [0x54, 0x4c] },  // magic, LE
    { offset: 2, bytes: [3, 0] },        // version 3
    { offset: 44, bytes: [1] },          // CLASS_ACTION
  ],
  rewrite: [
    { op: "copy", from: 12, to: 28, length: 8 },  // client actual → echoActual
    { op: "zero", at: 4, length: 8 },             // intended := 0
    { op: "nowNs", at: 12 },                      // actual := server send instant
    { op: "holdNs", at: 36 },                     // hold := receive → reflection
    { op: "set", at: 44, value: 2 },              // CLASS_ACK
  ],
}
```

Sequence at 20 is untouched. This is byte-for-byte what `writeReflection`
produces today; the Rust client's `encode_reflected_ack` in
`crates/reference/src/g6_protocol.rs` is the test oracle.

## Section 2: the native hook and metrics

**Placement.** In the per-connection forward task in `crates/native/src/lib.rs`
(the `tokio::select!` arm on `conn_dgram.receive_datagram()`), after
`datagrams_in` is counted, after the ingress rate limit and the size check, and
before `try_reserve_queued_bytes_with_session`. `datagrams_in` therefore keeps
counting every datagram the session received, reflected or not.

**Rule store.** A per-server slot keyed by owner server id holding
`Option<Arc<CompiledRule>>` behind a `RwLock`; the forward task takes one
uncontended read lock per datagram. `setDatagramReflector(null)` clears the
slot; replacing the rule takes effect on the next datagram. The slot is removed
when the server closes.

**Reflection.** `recv = Instant::now()` is taken when the datagram is received.
On a match: copy the first `replyLength` bytes into a reply buffer, apply the
ops (`nowNs` writes monotonic nanoseconds since the process's clock origin;
`holdNs` writes `now − recv`), then hand the send to the process-wide reflect
sender thread through a bounded queue (capacity 65_536) and `continue`. The read
task no longer calls `send_datagram` itself: a slow send used to lengthen it
until quinn's per-connection receive buffer overflowed and dropped the oldest
inbound datagrams. Nothing is reserved, nothing is byte-queued, and the JS side
never observes the datagram.

**Outcomes.** The sender thread performs the send, so a metrics snapshot taken
immediately after a hit may show `datagramReflectSent` lagging
`datagramReflectHits` by the jobs still in flight. `Ok` increments `datagrams_out` on both the server and session
metrics, exactly as the existing send sites do, plus `datagram_reflect_sent`.
`Err(NotConnected | UnsupportedByPeer | TooLarge)` increments a per-reason
counter and drops the reply: the receive task never awaits, retries, or parks
on a send. A reply the queue refuses (full, or the unreachable disconnected
case) increments `datagram_reflect_queue_full` and is dropped, never retried; a
panicking job is caught so the sender thread keeps draining.
`datagram_reflect_hits` counts every match regardless of outcome,
and `datagram_reflect_hold` observes `now − recv` for every match into the
crate's existing `LatencyHistogram`.

**Snapshot.** `metricsSnapshot()` gains `datagramReflectHits`,
`datagramReflectSent`, `datagramReflectSendErrors` (total, with the per-reason
split as `datagramReflectSendErrorsByReason`), and `datagramReflectHold` as the
existing `HistogramSnapshot` type. All are native-only.

**What is unchanged.** A datagram that does not match, or arrives on a server
with no rule, takes the existing path byte for byte. Rate limiting and the
size check still apply before the hook, so a reflector cannot be used to
bypass either.

## Section 3: N-API and TypeScript surface

- Native: `#[napi(js_name = "setDatagramReflector")] fn set_datagram_reflector(&self, rule: Option<DatagramReflectorRuleInput>) -> Result<()>`
  on the server handle, with `#[napi(object)]` input structs for the rule and
  ops. Shape errors throw `TypeError`, bound errors `RangeError`, both before
  any state changes; nothing about a transport condition is thrown.
- TypeScript: `packages/webtransport/src/datagram-reflector.ts` exports the
  rule types and `datagramReflectorRuleChecked(rule)` (the TypeScript half of
  the double validation), and `WebTransportServer.setDatagramReflector(rule |
  null): void` is added to the native root server interface, following
  `sendDatagramMirror`. It is absent from `PortableServer` at compile time and
  from the live portable server of both backends at runtime.
- Docs: a `docs/PARITY_MATRIX.md` row in section 3 next to the mirror rows:
  native-only because the API's entire content is removing the Node-API
  crossing, which wasm does not have, and the wasm backend has no
  per-connection native task to host it.
- Feature detection is method presence, as for the pacer.

## Section 4: G6 wiring and evidence reconciliation

- Conductor (`tools/load/g6-sharded-scan.ts`): new `SCAN_ACK_REFLECTOR`
  (`js` default, `native`), recorded in the rated output's `config` as
  `ackReflector`, and passed to every shard server. The evaluator
  (`g6-c32-rca-evaluate.ts`) and the successor grader
  (`g6-c32-successor-grade.ts`) take an expected value from the registered
  profile and fail closed on mismatch, so a run cannot grade under the other
  path unnoticed.
- Shard server (`g6-shard-server.ts` / `g6-server-core.ts`): in `native` mode
  the G6 v3 rule is installed at startup. The JS ack branch remains and simply
  never fires; it is the fail-safe if the reflector were ever absent.
- Boundary reconciliation in the server core: at each boundary snapshot,
  `rxTotal += Δ datagramReflectHits`, `emitter.ackDue += Δ hits`,
  `emitter.ackIssued += Δ datagramReflectSent`,
  `emitter.sendErrors += Δ datagramReflectSendErrors`, where Δ is the change
  since the previous boundary. S1 ingest and the ack reconciliation keep their
  meaning with zero per-action JS work; the JS hold histogram stays empty in
  native mode and the client's `serverHold` histogram, fed by the ack's hold
  field, now reports the native hold.
- Contract test: at every boundary `rxTotal == jsRx + reflectHits`.

## Section 5: registration amendment

A dated amendment under the ladder section of
`.scratch/bare-metal-campaign/registrations/g6-c32-rca-closure-01.md`: from the
next run the ack is reflected natively; S4 measures the native reflection
path; reflected actions count toward S1 through native counters; the profile
records `ackReflector: native`; rungs graded after the amendment are not
comparable with r75–r83 on S4. The conductor, diagnostic, evaluator and graders
change, so the "Frozen producer identities" table is refreshed in the same
change; the freeze now refuses a stale table.

## Section 6: tests and the kill gate

- Rust unit: exhaustive rule validation (each out-of-range offset, op count,
  length ordering, bad byte values); the G6 rule's rewrite byte-exact against
  `encode_reflected_ack`; `nowNs` and `holdNs` monotonic and non-negative;
  each `SendDatagramError` variant mapped to its counter.
- JS integration (`packages/webtransport/test/native-datagram-reflector.test.ts`):
  a native server with the G6 rule and a client sending a stamped action; the
  reply arrives with class 2, echo equal to the client's actual, hold ≥ 0, the
  action never surfaces on `incomingDatagrams()`, metrics hits and sent at 1; a
  non-matching datagram is still delivered; after `setDatagramReflector(null)`
  the action is delivered again; the public-surface contract test covers the
  portable exclusion.
- G6: boundary reconciliation with a fake metrics snapshot; conductor source
  contract for the config plumb and the rated `ackReflector` field; grader
  profile field; the `rxTotal == jsRx + reflectHits` identity.
- **Kill gate before any paid run:** on the Linux runner, one shard at 1,250
  sessions, the same client, ack p99 with the reflector in `js` versus
  `native`. The premise stands only if native is at or below one quarter of
  JS; otherwise the tail is not where the evidence says and the work stops
  before any rig is provisioned.

## Non-goals

- No consumer-side datagram sink (rings, overflow policy, loss disclosure);
  that is a separate open design.
- No per-session rules, no regex or general predicates, no big-endian ops, no
  reply larger than the matched datagram's first `replyLength` bytes.
- No change to the client, to the stamp layout, or to any registered bound.
- No paid campaign run is part of this work; the remaining budget (~$1.48)
  does not fund a c-48 lifecycle.
