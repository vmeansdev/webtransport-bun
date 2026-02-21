# wtransport upstream alignment

Track known wtransport issues that impact correctness during termination and load.

## Relevant issues

1. **`finish` sometimes hangs forever** — [wtransport#285](https://github.com/BiagioFesta/wtransport/issues/285)  
   Mitigation: add strict timeouts around stream finish; hard-close on timeout.

2. **Reset send side on session termination** — [wtransport#242](https://github.com/BiagioFesta/wtransport/issues/242)  
   Affects orderly shutdown semantics.

3. **close-cast race condition** — Addressed in wtransport 0.7.x.  
   If load-client panics with "QUIC connection is still alive on close-cast", verify pinned version and consider minimal repro for upstream.

## Mitigations in this repo

- Panic containment: all addon entrypoints wrapped in `catch_unwind` (see `crates/native/src/panic_guard.rs`).
- Load client: run in separate process with `RUST_BACKTRACE=1`; stderr captured for CI artifacts.
- Planned: session shutdown state machine with timeouts; hard-close fallbacks.
