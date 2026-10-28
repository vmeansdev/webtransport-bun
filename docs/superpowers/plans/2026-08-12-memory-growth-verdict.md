# Memory-growth investigation: verdict matrix + recommendation (2026-08-12)

Question: why does per-datagram delivery grow memory unboundedly under Bun,
and what fixes it at the library level?

Harness: lc-matrix (real Rust load-client, 20 sessions × 50 dgrams/s
≈ 1000/s) in the wt-linux container, Bun 1.3.14, worktree @ d2c1f58 +
uncommitted `payload_buffer.rs` arraybuffer gate. Logs: `/tmp/run-*.log`
in the container.

## Verdict matrix

| Hypothesis | Verdict | Evidence |
|---|---|---|
| H1 photograph garbage via heap snapshot | DEAD | snapshot forces a full GC first; leftovers unreachable ("no parents") |
| H2 `napi_create_arraybuffer` delivery gives organic GC pressure | **CONFIRMED** | quick run: organic full GC @t≈150s (Object 135k→4.8k, heap 49.7→3.1MB); 20-min run: sustained sawtooth, RSS flat 70–78MB over 1.166M datagrams, FINAL delta 10,497, totalGcPause 0 |
| H3 `bun --smol` | CONFIRMED (workaround) | Object flat 2.3k–7.3k, RSS 41–66MB, zero code change |
| H4 periodic `edenGC()` | REFUTED | growth identical to baseline; objects survive eden by promotion/rooting |
| H5 newer Bun fixes it | DEAD | no release past 1.3.14 (2026-08-12); no matching upstream issue |
| H6 default mode self-bounds once first organic full GC lands | **REFUTED for default mode** | 10+ min buffer-copy run: NO organic full GC, Object→179k monotone, heap 44MB, RSS ~99MB climbing ~100MB/h (the soak slope) |
| H7 per-datagram napi machinery (TSFN/promise per `spawn_future` call) is the churn source | CONFIRMED by source + counts | promise ~0.6/dgram, fn ~0.2/dgram retained until full GC; design written: 2026-08-12-datagram-batch-delivery-design.md |
| H8 what does the collector actually run? | **ANSWERED** | 8-min logGC: baseline = 8,030 eden / **3 full (startup only)**; arraybuffer = 27,787 eden / **27 full, recurring**, full sweeps 0.08–2.4ms, RSS flat 67MB |

## Mechanism (one paragraph)

Every delivered datagram creates JS wrappers (promise, TSFN function, u8,
object) whose true cost lives in native memory that Bun reports through
`napi_adjust_external_memory` → `deprecatedReportExtraMemory()` — an
accounting-only path that never calls `collectIfNecessaryOrDefer`. JSC
therefore sees a tiny heap, runs thousands of eden collections that the
rooted/promoted wrappers survive, and never escalates to the full
collection that would reclaim them. Delivering payloads as real
`JSC::JSArrayBuffer`s routes the same bytes through the NON-deprecated
`reportExtraMemoryAllocated`, which does drive the collector: full
collections then recur organically (~every 15–20s under load) and memory
is a bounded sawtooth with sub-3ms sweeps and no throughput loss
(468k vs 465k datagrams in matched 8-min runs).

## Recommendation

1. **Promote arraybuffer delivery from env-gated experiment to the default
   payload path on Bun** (`payload_buffer.rs`). It is the organic-pressure
   fix: engine-visible allocation → self-bounding memory, zero API change,
   no forced-GC valve needed. Cost: one extra memcpy + AB wrapper per
   datagram and ~3× more (cheap) eden GCs — measured flat RSS and equal
   throughput. **DONE 2026-08-12**: default flipped, escape hatch
   `WEBTRANSPORT_PAYLOAD_DELIVERY=buffer-copy`, TypeName → `Uint8Array`,
   internal handle typings updated; typecheck + clippy + 533-test suite
   green (one non-reproducing load flake on first run).
2. **Demote the `Bun.gc(true)` pressure valve** to belt-and-suspenders or
   drop it; the A/B/C decision (valve vs document-only vs block-on-upstream)
   is superseded.
3. **H7 batch delivery** stays a worthwhile follow-up optimization
   (cuts napi machinery up to 64×), not a prerequisite for the soak.
4. **Upstream Bun report** (novel): `napi_adjust_external_memory` uses the
   deprecated accounting path and ignores negative deltas;
   `NapiHandleScopeImpl::close()` never clears `m_storage`.
5. Then: 20-min matrix re-check on the promoted default → 2h verification
   soak → rebind №5 → 24h soak (dedicated runner).
