# napi rejection-leak mitigation + stream-teardown defects — plan (2026-08-13)

## Proven root cause (supersedes the read-retention plan's mechanism)

**Async napi methods that REJECT leak a strong self-reference on their
handle.** Evidence ladder (scratchpad/async-return-leak-check.ts, Bun
1.3.14):

- v4: 215 streams open+write+FIN (all calls resolve) → **0 protected**.
- v5: +one `read()` per stream, both payload-delivery modes → **0 protected**.
- v6: server aborts mid-stream so `read()`+`finish` reject → **400 protected
  = exactly 2 per stream = the two rejecting calls**.

Every `E_STOP_SENDING`/`E_STREAM_RESET`/`E_SESSION_CLOSED` rejection under
churn permanently pins a `ClientBidiStreamHandle` (+~1.2KB native state) →
the CI committed-memory ratchet (~50–100MB/h), the 115–128k protected
handles in stream-heavy soaks, drift predating arraybuffer delivery
(error-rate-proportional), and the passing datagram-heavy arm (few
rejections). Suspect layer: Bun `napi_reject_deferred` reference handling
(napi-rs codegen would break Node users loudly).

The earlier bounded-receive-wait fix + await_probe instrumentation + SPEC
read-side bound REMAIN (hardening + diagnostics; the probe is how this was
excluded-in and named).

## D1 — Leak mitigation (branch on the runtime A/B)

**A/B RESOLVED (2026-08-13): Bun 1.4.0-canary.1 leaks IDENTICALLY** —
200 aborted streams → 400 protected / 194-195 `bidiHandlesLive` on BOTH
1.3.14 and 1.4.0-canary. Node arm dropped (TS `.js`-specifier imports need
a loader; refines upstream attribution only). **Branch selected:
STILL-LEAKS-IN-1.4 → bindings no-reject envelope.** Upstream note: since
canary still leaks, filing before the 1.4 release is the only window where
a fix could ship in 1.4 — user to decide (previous call was wait-for-1.4).

- **Branch FIXED-IN-1.4**: adopt a Bun >= 1.4 floor exactly like the
  1.3.14 WritableStream-leak precedent (8bfd8f5): engines, CI pins,
  soak-addon runtime guard, docs disclosure for <=1.3.x ("rejected async
  napi calls leak handle refs under churn; upgrade"). No binding-contract
  changes. Release drive resumes once 1.4 ships stable; local validation
  may run on canary meanwhile. Upstream: per user, WAIT for 1.4 release
  before deciding whether an issue is still warranted.
- **Branch STILL-LEAKS-IN-1.4**: bindings no-reject envelope on hot
  methods — `read`/`write`/`finish`(+wait)/datagram receive resolve a
  status envelope (`{ value } | { errorCode }`) instead of rejecting; the
  TS wrapper converts error codes to thrown `WebTransportError`s so the
  public API is unchanged. Cold paths (open/accept/connect) may keep
  rejections (rare, bounded count). Falsifier: v6 shape asserts 0 protected
  + `bidiHandlesLive` ≈ 0 post-GC.
- **Node signal** refines the upstream target only (napi-rs vs Bun); it
  does not change our mitigation.

## Architect corrections (2026-08-13, folded)

1. **Scope corrected**: client `read_datagram` (client.rs:546-557) already
   resolves `None` — no conversion. Server session methods
   (session_napi.rs:156-338) use `env.spawn_future` capturing only an id,
   not `&self` — structurally immune; add a one-line falsifier check, not a
   conversion. `discard_incoming` (client_stream.rs:722, 1428) rejects
   per-stream and IS the soak evidence drain — MUST convert.
   `send_datagram` (client.rs:510, 4 rejection sites) MUST convert — a
   rejection pins the whole session handle. Convert
   `create_bidi/uni_stream` (client.rs:607, 622) too or justify residual.
2. **The bounded-wait fix ENLARGED the leak** (its E_BACKPRESSURE_TIMEOUT
   rejections at client_stream.rs:799, 1066, 1273, 1503 are new leak
   sites) — all its timeout rejections are conversion targets. Full hot
   inventory ≈ 28 sites across 8 methods.
3. **Envelope = JS-type-discriminated sentinels via custom ToNapiValue**
   (pattern exists in payload_buffer.rs): `read()` resolves
   `PayloadBuffer | null | string` (data / EOF / error-code) — zero added
   allocation on success; `write`/`finish_wait`/`send_datagram` resolve
   `string | null`. Extend the existing `read_error_slot` /
   `deferred_read_error_slot` consultation point (client_stream.rs:
   1013-1027) — do NOT invent a parallel mechanism.
4. **D3 open-deadline native-side**: wrap `resp_rx.await` (client.rs:615)
   in `tokio::time::timeout`; new limit `streamOpenTimeoutMs`, distinct
   code `E_STREAM_CREDIT_TIMEOUT`, envelope-resolved. `_destroy` reset
   wiring (streams.ts:188-205) is present; the wedge is plausibly
   downstream of D1 (pinned peer halves never release MAX_STREAMS credit)
   — predict partial self-resolution, verify.
5. **D2 sharpened**: streams.ts:151-175 maps `finishWait` rejection →
   `callback(err)` → 'error', so `end()`'s finish-attached cb never fires;
   likely `E_STOP_SENDING` from `finish_send_stream`
   (client_stream.rs:1725) after peer drain+teardown. Failing test must
   distinguish "never settles" vs "errors instead of finishing";
   post-envelope parity must preserve `callback(err)`.
6. **Falsifier integrity**: post-conversion v6 must ALSO assert errors
   still surface through TS (`rejectedReads ≈ N`) — silent swallowing must
   not pass the leak gate.

## Critic corrections (2026-08-13, folded — both reviews complete)

1. **Convert per-METHOD, not per-site**: one outer wrapper per hot method
   mapping every `Err` → sentinel (8 wrappers: bidi read/write/finish_wait,
   uni-send write/finish_wait, uni-recv read, send_datagram,
   create_bidi/uni_stream). Slot-level conversion is INSUFFICIENT — bidi
   read alone has ~10 direct Err paths (760-808, 993-1007; uni mirrors
   ~1458-1512), incl. all four bounded-wait E_BACKPRESSURE_TIMEOUT sites.
   Hot Err-site count ≈ 40; moot under wrappers.
2. **TS: any string = error, no allowlist.** Exactly these raw-handle
   consumption sites convert: streams.ts:128,146,163;
   index.ts:1402,1522,1555,1957,1989,2029,3367,3399,3418,3551(+uni pull
   region). A missed site corrupts payloads (string→utf8 Buffer) — the
   falsifier must also assert errors still surface (no silent swallow).
   tools/* consume the facade only — safe.
3. **Session-method immunity NOT proven**: spawn_future rejections could
   leak the deferred itself (invisible to bidiHandlesLive). Falsifier
   asserts TOTAL protected count, not just handle classes. Same for
   wait_draining (client.rs:584).
4. **discard_incoming de-scoped** (architect error): Rust-internal fns
   (client_stream.rs:722/1428), not napi — no JS wrapper to pin.
5. **D3 cancel semantics**: open loop must `tokio::select!` on
   `resp_tx.closed()`; explicit dispose on send-failure (client.rs:835 —
   current Drop only releases the live counter); add a
   credit-returns-after-timeout test.
6. **Blast radius**: ~38 reject assertions (mostly facade — unchanged);
   `__TESTING__` raw-native-session tests break and must be updated;
   regenerate .d.ts; `NativeSessionHandle` typing (index.ts:1102) is
   unexported — public API unaffected.
7. Accepted risks: E_INTERNAL/poisoned-lock also become sentinels;
   dropped-handle implicit teardown via bridge-channel closure unproven
   under load (covered by the dump-soak gate).

## D2 — `end()` callback never fires on cleanly-FIN'd Duplex

Harness archaeology: every cleanly completed client stream paid the 500ms
fallback because `stream.end(payload, cb)`'s callback never fired despite
the server draining to EOF and the FIN being delivered (v4/v5 pace ≈
1.4 streams/s). First step is a failing test: `end()` callback must fire
within a bounded time on a loopback echo where the peer drains. Then trace
the Duplex `_final` → native `finish`/`finishWait` wiring in index.ts for
the dropped completion.

## D3 — Torn-down-unfinished streams exhaust QUIC stream credit

Reproduced repeatedly: streams destroyed (or abandoned) without clean
FIN/reset never return stream credit; sequential `createBidirectionalStream`
wedges FOREVER at the concurrency cap (~200 observed with defaults on
loopback). Two parts:

1. **Teardown correctness**: client Duplex `destroy()`/facade drop must
   reset the native stream (RESET_STREAM + STOP_SENDING) so quinn releases
   the stream ID and credit returns. Verify the wiring; fix where the
   reset is dropped.
2. **Open must not wedge unboundedly**: `createBidirectionalStream` should
   respect a deadline (reuse `handshakeTimeoutMs`-style limit or a new
   `streamOpenTimeoutMs` with a generous default) and reject with a
   distinct code (`E_STREAM_CREDIT_TIMEOUT` or reuse
   `E_BACKPRESSURE_TIMEOUT`) instead of hanging forever.
   Falsifier: exhaust credit deliberately, assert bounded rejection.

## D4 — carried over (critic F3, still open)

Response-channel drops that strand a JS deferred: audit confirmed benign
at current sites, but D1's no-reject branch (if taken) must not introduce
new strand paths — every envelope resolve must be delivery-guaranteed.

## Ordering

1. A/B verdict (in flight) → pick D1 branch.
2. Architect + critic review THIS plan (single pass covers D1–D4).
3. Implement D1 branch; D2 + D3 fixes with failing-test-first.
4. Verify: full suites + v6 falsifier + 10-min stream-heavy
   SOAK_PROTECTED_DUMP soak (expect protected ≈ 0 for real this time) —
   on the runtime the D1 branch selects.
5. Then the release pipeline resumes: 2h CI soak → rebind №5 → 24h.

## Out of scope

- Upstream Bun issue filing: deferred until 1.4 ships (user decision).
- Guard recalibrations (fd-slope deadband, session-recovery tolerance):
  expected moot once the ratchet is gone; revisit only if the clean-runtime
  2h soak still trips them.
