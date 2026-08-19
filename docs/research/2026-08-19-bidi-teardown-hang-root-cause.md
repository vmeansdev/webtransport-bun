# The G11 Arm-D teardown hang: a write after a write error never calls back

Issue: `.scratch/high-load-excellence/issues/02-bidi-teardown-hang.md`
Branch: `fix/bidi-teardown-01` (off `rebind4-staging@9c475df`)

## The mechanism

`BidiStream` is a Node `Duplex` constructed with `autoDestroy: false`
(`packages/webtransport/src/streams.ts`). That flag is deliberate and load-bearing
— the constructor comment says so — because auto-destroy would tear down both
halves when only one completes, and the class exposes separate Web
Readable/Writable lifetimes over the same handle.

The cost was not noticed. When a `_write` callback returns an error, Node marks
the writable `errored` but, with `autoDestroy` off, does **not** destroy it. A
Writable in that state buffers every subsequent chunk without ever calling
`_write` — and therefore without ever calling that write's per-chunk callback.
The write does not fail. It does not succeed. It never settles.

This is Node/Bun `Writable` semantics, not something the native layer does. It
reproduces in nine lines with no transport involved:

```
autoDestroy=true   write#2 err(Cannot call write after a stream was destroyed)
autoDestroy=false  write#2 NEVER-SETTLED
```

`SendStream` and `RecvStream` both pass `autoDestroy: true`, so `BidiStream` is
the only affected class.

### Why this wedges a whole process

A driver that keeps writing after a write error — which is a reasonable thing to
do, and exactly what the G11 pacer does, counting `result.errors` and continuing
— parks forever on the next `await write(...)`. Its stream loop never reaches
`duplex.end()`, its session driver never returns, `Promise.all(drivers)` never
resolves, `main()` never returns, and the process never exits.

Nothing is pending in native while this happens. That is the signature: the JS
await is outstanding but no native future is, so every tokio worker parks and the
Bun main thread sits in the event loop. Sampling the wedged process reproduces
the reported stacks exactly — main thread in `kevent64` (macOS's `ep_poll`), all
ten `tokio-runtime-worker` threads in `park_condvar`/`__psynch_cvwait` (macOS's
`futex_do_wait`), ~0% CPU, counters frozen.

### What starts it

Anything that fails one write. In the G11 D cells the trigger is
`E_BACKPRESSURE_TIMEOUT`: a slow reader on either end holds the peer's
flow-control window down, the write bridge parks in `send_stream.write_all()`,
queued chunks fill the shared per-stream budget, and the next
`reserve_or_wait()` gives up at `backpressureTimeoutMs`. That first rejection is
correct and bounded — every native await in the write path has a deadline. It is
the write *after* it that never returns.

This also explains the raciness the ticket records (hangs at backlog fractions
0.25/0.75 but not 0.95 on one end, 0.95 on the other): what varies between cells
is only whether the pacer happens to hit a write error inside its window. The
defect itself is deterministic once one does.

## Evidence

- `tools/repro/probe-write-after-error.ts` — deterministic, 100% reproduction.
  Drives a stream against a server that accepts and never reads; write #372
  rejects with `E_BACKPRESSURE_TIMEOUT` after the deadline, then:
  ```
  after first error: destroyed=false writableEnded=false writableFinished=false errored=true
  second: SECOND-WRITE-CALLBACK-NEVER-FIRED
  ```
  With the fix: `write#373 rejected(E_BACKPRESSURE_TIMEOUT) in 1ms`.

- `tools/repro/bidi-teardown-hang.ts` — the G11 cell shape (50 concurrent
  tunnels, both directions paced at 3 Mbps, oscillating or stalled slow reader,
  every teardown await named and bounded). 24 cells across both slow-reader
  placements and backlog fractions 0.25/0.75/0.95, plus bounded stalls spanning
  the whole teardown: **zero wedges**. This is a real negative result and it is
  what narrowed the search — that harness stops writing on the first error, so it
  never enters the trap. The product's close paths (`end()` with unread inbound,
  EOF after a stall, `session.close()` over an outstanding read) are all sound.

- `packages/webtransport/test/bidi-teardown-slow-reader.test.ts` — four tests;
  the first three pin the close paths that were suspected and pass before and
  after, `a write issued after a write error still calls back` is the regression
  (fails on `9c475df`, passes with the fix).

## The fix

`BidiStream.write()` is overridden to answer writes issued after the writable has
already errored with that error, the way an auto-destroying stream would —
without destroying the readable half, since a failure to send says nothing about
the peer's ability to keep sending, and half-open lifetimes are the reason
`autoDestroy` is off in the first place.

Returning `false` from that path matches what Node itself returns for a `write()`
on a destroyed stream, so a caller's backpressure handling sees nothing new.

## Blast radius

- One file, +29 lines, TypeScript only. No native change, so no crate was
  touched and no clippy run applies.
- `BidiStream` only. `SendStream`/`RecvStream` already auto-destroy.
- Behaviour changes only on a stream whose writable has already errored — a state
  in which every write previously hung forever. Nothing that used to settle
  settles differently.
- `duplex.errored` on a Duplex is the *writable's* error (verified: a `_write`
  failure sets it while `destroyed` stays false), so the guard cannot be tripped
  by a read-side failure alone.
- Verified: full `bun test packages/` = 627 pass / 81 skip / 1 fail, where the
  single failure is `adversarial-protocol` failing to cold-build the `adversary`
  binary inside the 5 s `beforeAll` in a fresh worktree; it passes on rerun once
  `cargo build -p adversary` has been run. `bun run typecheck` clean. Biome
  reports 11 warnings on `streams.ts` both before and after — no new diagnostics.

## What this does not settle

The G11 D cells still need a rerun to produce their numbers; this only removes
the wedge. And the harness has its own unbounded awaits (`await reader` after a
bounded grace, `duplex.end()` with no deadline, `Promise.all` over 50 drivers
with no per-cell deadline) which would turn any future single-stream stall into
the same whole-process hang. Per-cell deadlines in the harness remain worth
adding independently of this fix.
