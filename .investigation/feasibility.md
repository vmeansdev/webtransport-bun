# QUIC server-side parallelism: feasibility

Investigated read-only against `/Users/vmeansdev/Developer/Codex/Apps/webtransport-bun`
at `db9e7c6` (branch `rebind4-staging`). Vendored deps: quinn `0.11.11`,
quinn-proto `0.11.16`, quinn-udp `0.5.14` (Cargo.lock:871/891/913), wtransport
`0.7.1-zerortt-qpack.1` from the fork `vmeansdev/wtransport` rev `7dc1a03`
(Cargo.lock:1722-1724), sources under
`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/` and
`~/.cargo/git/checkouts/wtransport-f273d650b3956a68/7dc1a03`.

---

## 0. Verdict up front

`worker_threads(1)` is **not load-bearing**. The documented rationale is
correct about what it says and silent about what it is used to justify. It
argues that `Builder::new_current_thread()` would be wrong; it contains no
argument for capping the multi-thread runtime at one worker. Your reading is
confirmed.

However, raising the worker count alone will **not** lift the ceiling as far as
the numbers suggest, because the single hottest serialisation point is
per-*endpoint*, not per-*runtime*, and lives in quinn, not in us.

---

## 1. Is the documented rationale sound?

`docs/ARCHITECTURE.md:11-20` says:

> `new_multi_thread` with exactly one worker is intentional. Synchronous N-API
> entry points call `Runtime::spawn` without a permanently driven `block_on`;
> replacing these runtimes with `Builder::new_current_thread()` would leave
> spawned work without a continuously driven executor.

That claim is true and important. A `current_thread` runtime only makes
progress inside `block_on`/`Handle::block_on`; our napi entry points
(`crates/native/src/server_napi.rs`, `session_napi.rs`) return immediately
after `RUNTIME.spawn(...)`, so the tasks would never be polled. Keeping
`new_multi_thread` is correct.

The paragraph then slides from "must be multi_thread" to "preserving
single-worker execution within each runtime" without giving a reason for the
`1`. There is no such reason anywhere in the source, the tests, or the doc.
`scripts/check-doc-truth.ts:80` and `:431` and
`packages/webtransport/test/internal-doc-truth.test.ts:101,135-143,218,230,237`
pin the literal string `Builder::new_multi_thread().worker_threads(1)`. That is
a **drift guard, not a correctness invariant** — it exists to stop the doc and
the code disagreeing, not to stop the number changing. Changing the worker
count means editing those four places deliberately; it does not mean breaking a
safety property.

---

## 2. What would break at `worker_threads(N>1)`?

**Compile-time: nothing.** This is the strongest single result here.
`tokio::runtime::Runtime::spawn` requires `F: Future + Send + 'static`
*regardless of worker count*. Every task we create already goes through one of:

- `spawn_tracked::spawn_tracked` — bound `F: Future<Output = ()> + Send + 'static`
  (`crates/native/src/spawn_tracked.rs:41`), spawning via `tokio::task::spawn`
  at `:78`;
- `panic_guard::spawn_quic_task_scoped` — same bound
  (`crates/native/src/panic_guard.rs:65`), `tokio::task::spawn` at `:67`.

So `worker_threads(1)` buys us **zero** relaxation of `Send`/`Sync`. Any
`!Send`-across-await pattern would already fail to compile today. There is no
`LocalSet`, no `spawn_local`, no `thread_local!`, no `Rc`, no `RefCell`, and no
`unsafe impl Send/Sync` anywhere in `crates/native/src/` (grepped all 23
files). Every `current_thread` hit in the crate is a `#[tokio::test(flavor =
"current_thread")]` attribute — those build their own runtimes and are
completely unaffected by `RUNTIME`'s worker count. The one non-test hit,
`server_spawn.rs:178`, is inside a `#[cfg(test)]` module.

**Runtime semantics: no new hazards, but wider windows on existing ones.**
Tasks on a one-worker multi-thread runtime already interleave freely at every
`.await`; concurrency is already assumed correct. What changes at N>1 is that
two tasks can be *simultaneously* inside the same critical section rather than
merely interleaved, which turns latent races from "practically never" into
"occasionally". The two places I would watch:

- **Session lifecycle event ordering.** `Accepted` is sent on the session event
  channel from the accept loop; `Closed` is sent from the per-session datagram
  pump (`crates/native/src/lib.rs:1334-1345` and `:1387-1398`) — a *different*
  task, therefore a different mpsc sender, therefore already unordered with
  respect to `Accepted`. Ordering is currently protected only by the fact that
  the pump is spawned strictly after the accept event is enqueued and cannot
  run before the accept loop yields. At N>1 the pump can start on another
  worker before the accept-loop task next yields. I could not find an explicit
  guard for this; **flag it as the highest-value thing to re-check before
  shipping any worker increase.**
- **Test flakes, not test breakage.** Nothing in the Rust unit tests depends on
  `RUNTIME`'s worker count (they all use their own runtimes). The JS-level
  churn/recovery guards are already documented as load-sensitive; more workers
  changes timing and would need a re-baseline, not a redesign.

**Doc-truth: guaranteed hard failure.** `scripts/check-doc-truth.ts:431` will
fail the moment the constructor string changes, and
`internal-doc-truth.test.ts` will fail on the doc text. Expected and
intentional; update all four sites together.

---

## 3. Where does the work actually serialise?

### 3a. Inside quinn — the real constraint

quinn spawns **exactly one endpoint driver task per `Endpoint`**:
`EndpointDriver(EndpointRef)` (`quinn-0.11.11/src/endpoint.rs:364`, `impl
Future` at `:366`), spawned once in `Endpoint::new_with_abstract_socket`
(`endpoint.rs:152-160`). Its `poll` takes `self.0.state.lock()` at `:370` and
**holds that mutex across both `drive_recv` (`:377`) and `handle_events`
(`:378`)**. One task, one mutex, per UDP port.

What runs *inside* that mutex, i.e. what is unconditionally serialised no
matter how many tokio workers exist:

- the `recvmmsg`/`recvmsg` syscall itself (`endpoint.rs:775` `RecvState::poll_socket`);
- per-datagram partial header decode and connection-ID routing
  (`quinn-proto-0.11.16/src/endpoint.rs:155-167`, `:210-235`);
- Initial-packet header/AEAD decrypt and handshake acceptance
  (`quinn-proto/src/endpoint.rs:422`, `:478`);
- Retry/version-negotiation.

What is handed off and therefore **parallelisable across workers**:

- For an established connection the endpoint driver only forwards the raw
  datagram into a per-connection unbounded mpsc
  (`quinn-0.11.11/src/endpoint.rs:813-820`). It does **not** take the
  connection mutex.
- Each `Connection` has its own spawned `ConnectionDriver`
  (`quinn-0.11.11/src/connection.rs:65-73`) with its own
  `state: Mutex<State>` (`:877`, `:956`), taken only by that connection's own
  driver (`:240-251`).
- 1-RTT payload decryption happens on the connection task
  (`quinn-proto/src/connection/mod.rs:2244` → `:2274` → `:3485/:3490`
  `packet_crypto::decrypt_packet_body`).
- Stream/datagram reassembly, ACK generation, loss detection, congestion
  control, pacing timers — all per-connection.
- **Transmit is also per-connection, not endpoint-serialised**: the connection
  driver sends on its own cloned socket handle,
  `self.socket.try_send(&udp_transmit(...))` at
  `quinn-0.11.11/src/connection.rs:1040`. This matters for the echo bench,
  where the reply path is roughly half the work.

Batching in the recv loop: `BATCH_SIZE` comes from quinn-udp
(`endpoint.rs:36`, arrays at `:781-791`). On Linux that is 32 with GRO; on
macOS `quinn-udp-0.5.14/src/unix.rs:790-795` sets it to **1** unless the
`fast-apple-datapath` feature is on, and it is not enabled in this workspace —
so on macOS the endpoint driver does one `recvmsg` syscall per datagram. The
recv loop's budget is time-based, `RECV_TIME_BOUND = 50µs`
(`quinn-0.11.11/src/lib.rs:136`, used at `endpoint.rs:499/511/861`);
`IO_LOOP_BOUND = 160` (`lib.rs:128`) bounds `handle_events` only.

The fork does not change any of this: it just calls `quinn::Endpoint::new(...,
Arc::new(TokioRuntime))` for server (`wtransport/src/endpoint.rs:142-144`) and
client (`:208-210`) — no custom driver, no extra endpoint, no socket options.
`SO_REUSEPORT`/`SO_REUSEADDR` appear nowhere in quinn 0.11.11 or quinn-udp
0.5.14, but wtransport does let you hand in a pre-bound socket
(`wtransport/src/config.rs:390`, `:959`), which is the hook sharding would use.

### 3b. Inside our own code

The per-session datagram pump is `crates/native/src/lib.rs:1303-1420`. Per
received datagram it does, in order:

1. `m_dgram.datagrams_in.fetch_add` on the **process-wide** `ServerMetrics`
   (`lib.rs:1349`) plus a per-session counter (`:1350`). Shared cache line
   across all sessions — true sharing at N>1, but at ~51k/s the cost is
   negligible.
2. **`rate_limit::try_acquire_datagram_ingress` (`lib.rs:1351`) — the one I
   would actually worry about.** It calls `try_acquire_token`
   (`rate_limit.rs:246-273`), which allocates a `String` for the key
   (`:253`), does `DashMap::entry(...)` — a **shard write-lock even for an
   existing key** (`:254`) — then takes an inner `std::sync::Mutex`
   (`:261`) and reads `Instant::now()` (`:263`). The key is
   `(server_id, peer_ip)`. In the bandwidth bench **all 150 sessions come from
   a single client IP**, so every session hits the *same* shard and the *same*
   mutex on *every* datagram. Under one worker this is uncontended (just a
   wasted allocation); at N>1 it becomes a genuine cross-core contention point
   sitting on the single hottest path in the server. Note the bench raises the
   limits so the limiter never rejects
   (`tools/load/bench-bandwidth.ts:190-199`) but the work still executes.
3. `try_reserve_queued_bytes_with_session` (`server_metrics.rs:71-92`) — a CAS
   loop on the process-wide queued-bytes counter, then a `fetch_update` on the
   per-session counter. Contended CAS at N>1; again small at 51k/s.
4. `dgram_tx.send(slot).await` into a per-session bounded mpsc
   (`session_registry.rs:429`), drained by a per-session `Arc<Mutex<Receiver>>`
   (`session_registry.rs:363`, taken at `session.rs:179/193/225`). Per-session,
   so no cross-session contention.

The session registry itself is a `DashMap` (`session_registry.rs:396`), touched
on lifecycle events rather than per datagram — not a hot-path concern.
`OWNER_ABORTS` (`spawn_tracked.rs:14`) is likewise per-task-lifetime.

So: **our own per-datagram serialisation is one shared token bucket, and it is
avoidable** (fast-path the "limit effectively disabled" case, or key the bucket
per session, or use a lock-free bucket). Nothing else in our code needs a
global lock per datagram.

---

## 4. Is the 2-core plateau explained?

Yes, and cleanly.

Thread inventory for a server-only process:
- **1** tokio worker, `wt-server` (`lib.rs:53-66`). `worker_threads(1)` means
  literally one worker thread; the mio poll and all timers run on it.
- **0** `wt-client` threads in a server-only bench: `CLIENT_RUNTIME` is a
  `Lazy` (`lib.rs:70`) and is never forced unless client APIs are called.
- **0** blocking-pool threads doing work: `grep` finds no `spawn_blocking` and
  no `max_blocking_threads` anywhere in `crates/native/src/`. Tokio's blocking
  pool is lazily spawned and idle here; UDP I/O does not use it.
- **0** watchdog threads. `panic_guard` (`panic_guard.rs:65-93`) and
  `spawn_tracked_watcher` (`spawn_tracked.rs:83-118`) spawn *tasks* on the same
  runtime, not threads.
- **1** Bun JS thread doing TSFN callbacks and the echo loop.

One saturated tokio worker + one saturated JS thread ≈ 2.0 cores. The measured
2.05-2.16 is exactly that plus a sliver of tokio/mio/GC overhead. The code fully
supports the interpretation. Note this also means the *entire* QUIC stack —
endpoint recv/demux, 150 connection drivers, 150 datagram pumps, all timers, all
transmits — is currently competing for **one** core.

That is also why 4 sessions beat 150. At 4 sessions the per-connection fixed
cost (150 `ConnectionDriver` tasks, each with its own ACK/pacing/loss timers
firing independently of datagram rate) is nearly absent, so almost the whole
core goes to actual packet work: 59,907/s on 1.58 cores. At 150 sessions that
O(sessions) overhead is co-resident on the same single core as the endpoint
driver and squeezes it down to ~51,000/s. **The per-connection half of that
cost is exactly what extra workers would move off the endpoint driver's
thread.**

---

## 5. The honest ceiling, and which lever

**Raising `worker_threads`** would offload, onto other cores: all 150
`ConnectionDriver` polls, all 1-RTT payload decryption, ACK/loss/congestion
work, all timers, all transmits (`connection.rs:1040` sends per-connection),
and our per-session datagram pumps. It would *not* offload the endpoint
driver's recv syscall, header decode, CID routing, or handshake crypto — those
stay one thread per port behind `endpoint.rs:370`'s mutex.

Since the 150-session regression looks like per-connection overhead crowding
out the endpoint driver (that is what "fewer sessions, more throughput, less
CPU" means), giving the endpoint driver a core of its own should recover most
of the gap between 51k/s and the ~60k/s the 4-session case achieves, and then
some, because the connection work no longer has to interleave with it. **My
estimate is that a single lightly-loaded endpoint driver on a dedicated core
tops out somewhere in the 60-120k datagrams/s range on this 4-vCPU host**, and
I want to be explicit that this range is an inference from the shape of the
existing measurements, not something I measured or derived from a quinn
benchmark. Beyond that the endpoint driver saturates and further workers do
nothing.

**SO_REUSEPORT endpoint sharding** — N sockets each with `SO_REUSEPORT`, N
quinn `Endpoint`s, kernel-hashed by 4-tuple, fed to wtransport via
`with_bind_socket` (`wtransport/src/config.rs:390`) — is the only way past
that, because it creates N endpoint drivers. It is also substantially harder:
you get N independent connection-ID spaces, so QUIC connection migration and
any NAT rebinding can land a packet on the wrong shard (the kernel hashes the
4-tuple, QUIC routes by CID), which needs either a CID-encoded shard id or
cross-shard forwarding. On a 4-vCPU host with one JS thread already burning a
core, you have at most ~2 spare cores anyway.

**Recommendation: raise `worker_threads` first; do not shard yet.** The
evidence points at per-connection cost, which is precisely what workers fix,
and the change is a one-line constructor edit plus four doc-truth sites. Pair
it with removing the shared token-bucket lock from the per-datagram path
(`lib.rs:1351` → `rate_limit.rs:246-273`), because that is the one place in our
own code where N workers would fight each other, and it is on the hottest path.
Sharding is only warranted if, after that, a profile shows the endpoint driver
thread itself pinned at 100%.

---

## 6. Confidence, and what I could not verify

**Confidence: high** on §1, §2, §3, §4 — every claim there is read from source
with a file and line, in this repo or in the exact vendored crate versions.

**Confidence: moderate** on §5's magnitude. I did not run anything. Nobody has
profiled *which thread* is saturated: we know the process uses ~2.05-2.16 cores
and we know from the code that only two threads can be doing work, but we have
no per-thread breakdown proving the tokio worker is the pinned one rather than
the JS thread. That is the single biggest gap, and it is cheap to close — a
per-thread CPU sample (`top -H`, or `perf`/Instruments) during the 150-session
run would either confirm the whole premise or refute it in one measurement.
**Take that sample before writing any code.** The batching plan failed for
exactly this reason: a plausible mechanism that nobody measured first.

Two smaller unverified items: the macOS `BATCH_SIZE == 1` conclusion is derived
from cfg/feature resolution rather than from a built artifact (and is moot if
the bench ran on the Linux VM — I did not establish which host produced the
150-session numbers, and it changes the recv-syscall cost by ~32x); and I did
not confirm whether anything guards `Accepted`-before-`Closed` ordering at the
JS layer, which is the one semantic risk I would want closed before raising the
worker count.
