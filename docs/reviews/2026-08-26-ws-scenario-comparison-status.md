# WS↔WT scenario comparison: status review (2026-08-26)

Reviewed at `codex/ws-scenario-comparison` after rebasing onto
`claude/optimistic-antonelli-baa8c9` (the stream-sink-complete line). Sources: the three
planning documents, the full `tools/compare/` tree (~29.4k lines, 47 commits), the untracked
R1 work-in-progress, and live execution attempts of every CLI.

## Where we are, in one paragraph

The comparison framework's **pure core is built and green** — registry, evidence chain,
fail-closed verifier, comparator, renderer, both transport adapters, and all ten scenario
ledgers, covered by 297 passing tests with zero failures. But **no real measurement can run
today, by design and by gap alike**: every official CLI hard-throws
`OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` at entry (the deliberate R0 quarantine awaiting the R1
secure-filesystem boundary), and independently of that gate, the execution pipeline was never
wired — `run-campaign.ts` computes its numbers from a closed-form arithmetic model, and **no
non-test file imports the adapters or the scenarios**. The project is a well-specified,
well-tested skeleton standing exactly at the plan's T10/T11 boundary, with the physical
campaign (T12–T16) and the R1 trust work both ahead of it.

## Rebase record

- Base was `d15658d3` (the same staging tip the sink branch grew from); 47 commits, almost
  purely additive (`tools/compare/` + docs; `package.json` +6, `TESTPLAN.md` +13).
- `git rebase claude/optimistic-antonelli-baa8c9`: clean, 47/47, zero conflicts. The branch
  now contains every WT measurement/optimization from the sink campaign: the read-ownership
  deferral, the SAB ring + `openReadSink`/`SinkReader` surface, `bench-sink`/`soak-sink`,
  the ported OPERATIONS.md sizing section, and the Linux gate record (saturated sink p99
  0.97 ms vs facade 10.30 ms).
- Validation on the new base: tracked `tools/compare/` suite **297 pass / 0 fail** — no
  regressions. The additional 25 failures + 1 parse error in a full `bun test tools/compare/`
  come exclusively from the **untracked `r1-*-red.test.ts` family**, which is deliberately
  red (TDD contract awaiting R1 implementation). Branch is local-only; nothing to push.

## What exists and works (by layer)

| Layer | State |
|---|---|
| Scenario registry + canonical hashing | Real. 35 cells / 82 arms (35 WS + 35 WT + 12 `ws-lossy-overlay` game arms) as a frozen parameter grid; JCS canonicalization + SHA-256. |
| Evidence chain | Real and strong: `evidence.ts` (1235 L), `verify-artifact.ts` (2783 L) fail-closed verification, `artifact-builder.ts`, typed `evidenceStatus` vs `scenarioVerdict` separation, "no comparison delta exists unless both artifacts pass compatibility checks." |
| Wire/pacing/queueing/stats | Real pure logic: `wire.ts`, `pacer.ts`, `bounded-queue.ts`, `stats.ts`. |
| WS adapter (`adapters/ws.ts`, 2714 L) | Real Bun WS implementation (`Bun.serve` factory). **Unused by any executor.** |
| WT adapter (`adapters/wt.ts`, 1264 L) | Real: lazily imports the package, uses `createServer`/`connect`, bidi/uni streams, datagrams. **Unused by any executor. Does not use `openReadSink`.** |
| Scenarios (10) | All implemented as **pure ledgers** (`run*Pure`) with fabricated timings for test purposes; none reference a transport adapter. |
| Topology/netem/TLS/sidecar | Pure parsers/validators only; the single real subprocess module (`remote.ts`, bounded `ssh`) is never called and is slated for deletion under R1. |
| CLIs | `compare:run`/`compare:verify`/`compare:report` fail closed at entry (R0 quarantine); `compare:server`/`compare:client` parse args and exit — no socket ever binds. |
| Docs | Methodology, fairness/authority contract, capacity profile all written. TRANSPORT_COMPARISON.md states plainly: "Real comparison measurements remain absent until a fresh campaign has run." **Zero measured numbers exist.** |

## What's missing (ordered by dependency)

1. **R1: the secure-filesystem trust boundary** — the explicit blocker for every official
   read, write, report, and delta. The 2380-line amendment specifies it: a reviewed Rust
   `crates/native/src/secure_fs.rs` (Rust-public only, no napi) plus a
   `comparison-supervisor` binary with descriptor-launched roots, and six TS modules that do
   not exist yet (`secure-fs.ts`, `staged-capability.ts`, `campaign-lock.ts`,
   `manifest-lock.ts`, `supervisor-protocol.ts`, `supervisor-client.ts`). Tasks A–E, none
   checked off. State of the red contract (untracked): five `r1-*-red.test.ts` files
   (24 failing tests specifying capability/lock/attestation binding and the frozen
   588-execution / 3,599-descriptor manifest arithmetic), a 9,203-line
   `crates/native/tests/secure_fs.rs` scripted-syscall contract that cannot even link yet
   (the crate is cdylib-only), and `check-official-io.ts` **with a syntax error at line 784**
   — Task A ("approve and hash the red bundle") has not happened.
2. **Real execution wiring** — independent of R1 and at least as much work: nothing connects
   scenarios → adapters → campaign. `run-campaign.ts`'s `measureCellArm` is a synthetic
   model (literally `transport === "wt" ? 1.0 : 0.98`); `server.ts`/`client.ts` are stubs.
   The islands are built; the bridges are not.
3. **Plan formality is unclosed** — the plan header still reads "APPROVAL CANDIDATE —
   IMPLEMENTATION FORBIDDEN" and all 13 completion gates are unchecked, yet T1–T10 landed as
   47 commits. Either the approvals happened off-record or the process record needs
   reconciling before campaign evidence can claim authority (the branch's own late commits —
   "campaign evidence cannot self-authorize" — make this non-cosmetic).
4. **T11–T16 never started**: local verification pass, two-host staging/preflight (Mac
   `10.99.0.1/en8` ↔ Linux `10.99.0.2/eno1`, Linux always server, netem on `eno1` egress
   only, no loopback fallback exists by design), the interleaved 82-arm physical campaign
   (98 warmup + 490 measured runs), compatibility/negative controls, report render, handoff.
5. **The parent recovery plan (R2–R8) does not exist** — the amendment references phases
   beyond R1 that live in a document absent from `docs/superpowers/plans/`.
6. **WT-side methodology debt, new since the sink landed**: the WT adapter reads through the
   facade path only. After the sink campaign we know facade tail latency is a queueing
   function of receiver-loop utilization (Linux gate: facade p99 10.30 ms vs sink p99
   0.97 ms at 90 % duty) — a WS↔WT comparison whose WT arm reads on the main loop will
   understate WT's achievable tails in exactly the latency-critical scenarios (game, ticker,
   tail, ai-token). The comparison should either (a) add a sink-read WT arm variant, or
   (b) record loop-utilization alongside every cell so the deltas are interpretable. Neither
   exists in `tools/compare/` today; no loop-saturation methodology note exists anywhere in
   the tree.

## Suggested order of attack

1. Fix `check-official-io.ts:784`, finish and freeze the R1 red bundle, run the Task A
   approval (architect + critic per the amendment's own rule).
2. Implement R1 B→E (native `secure_fs` + supervisor, TS modules, entrypoint integration,
   docs/verification). This unlocks every quarantined CLI.
3. In parallel (not R1-gated): wire the execution path — replace the synthetic
   `measureCellArm` with adapter-driven scenario execution, make `server.ts`/`client.ts`
   real, and decide the WT sink-arm / loop-utilization methodology question while the
   harness is open.
4. Reconcile the plan's approval record; author or explicitly retire the R2–R8 parent plan.
5. T12–T16: stage the two hosts and run the campaign.
