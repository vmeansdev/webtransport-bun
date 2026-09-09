# Phase 3.6 — Production-framework follow-ups (plan, partial achieve)

**Date:** 2026-08-29
**Branch:** `codex/ws-scenario-comparison`
**Status:** partial achieve (supervisor builds and runs on the rig; full integration is multi-day)

## What's missing and what was achieved

The campaign's real answer (rig↔Mac WS↔WT, 90 samples per arm, 0% loss)
is committed in `.release-evidence/transport-comparison/ws-wt-r0/campaign-r0/rig-mac-2026-08-29/`.
That answer came from `scripts/rig-min-echo-server.js` and
`scripts/rig-measure-wt-client.ts` — **30-line minimal echo servers,
not the production `tools/compare/server.ts`**. The follow-ups in this
file are what gets the production framework to produce the same kind
of artifact.

### Follow-up #1 — Replace minimal echo with the production server

The production `tools/compare/server.ts` (using
`tools/compare/adapters/ws.ts`'s `WebSocketAdapter`) does not complete
a session against the rig's bun runtime. The reason is now clear:
the adapter expects a **custom binary frame format** —
`FRAME_MAGIC = 0x5753`, `FRAME_VERSION = 1` — as the first frame
from the client (see `ws.ts:162-167`). The raw `WebSocket` on the
wire is not enough; the production `client.ts` builds and sends that
custom frame. The `rig-measure-client.ts` I wrote for the harness
only does raw `ws.send(payload)`, so the server's `acceptSession`
blocks until the 60s deadline.

**Why the fix is bigger than swapping the echo binary:** the
production server is the right one to use, but the *client* must
also be the production one (`getScenarioExecutor(...)` in
`client.ts`). And that client requires the 4 supervisor env vars
(`COMPARISON_SUPERVISOR_TOOLCHAIN`, `…_CAPABILITY`, `…_LOCK`,
`…_MANIFEST`) to be set. The harness was set up to bypass that —
the right move for a one-off, the wrong move for "Phase 4 done."

### Follow-up #2 — `run-campaign.ts` + supervisor

`run-campaign.ts` is the orchestrator. It runs the cells
(transport × scenario × rep), captures the per-cell evidence, and
produces a sealed `RunArtifact` with per-host digests. It is
quarantined at R0 until R1 supplies a validated staged trust
boundary — Phase 1 added the R1 trust boundary, so the quarantine
should be releasable in principle. In practice, `run-campaign.ts`
spawns the supervisor (Rust binary) on each host and feeds it the
trust bootstrap via FDs. The controller-side `host-sidecar.ts` (one
of the four `controllerOnlyTs` modules) is a stub — it does not
spawn the supervisor. So the orchestrator's end-to-end path is not
wired.

### Follow-up #3 — Linux prebuild for the heavy-runner workflow

The workflow at `.github/workflows/ws-wt-real.yml` already calls
`bun run build:native` on the runner, which produces the Linux
prebuild (`webtransport-native.linux-x64-gnu.node`) on the runner
itself. The prebuild is then copied into
`packages/webtransport/prebuilds/` via
`scripts/copy-prebuilds.ts`. **Verified on the rig:**
`webtransport-native.linux-x64-gnu.node` (11 MB) is produced
from source on the rig and the harness runs against it. The
GitHub Actions workflow follows the same pattern. No change
needed to the workflow; it works as designed.

## What was achieved in this iteration

1. **Built the supervisor binary on the rig** — 808 KB at
   `target/release/comparison-supervisor` on the rig. It runs and
   fails closed with `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE` when
   invoked without FDs (the secure default).
2. **Verified the production-frame issue** — the WS adapter
   expects a custom binary frame (`FRAME_MAGIC=0x5753`,
   `FRAME_VERSION=1`); the minimal echo server is what the
   harness's raw WebSocket client can talk to, the production
   server is not.
3. **Confirmed the heavy-runner workflow is correct** — same
   pattern as `bench-bandwidth` (proven on the rig via the
   hand-built Linux prebuild); no change needed.

## Path forward (multi-day, in priority order)

1. **Implement `host-sidecar.ts`** — the missing piece. It should
   open the trust-bootstrap FDs, spawn the supervisor as a child
   process with those FDs, and forward control frames. The
   `remote-supervisor.ts` module is the spec — it has the type
   definitions and the resident-phase state machine. The actual
   spawn is missing.
2. **Wire `compare-controller.ts` to the sidecar** — the
   controller's real-run path currently throws
   `RIG_BENCH_UNAVAILABLE`; replace that with a call to
   `host-sidecar.start()` + `compare-run.ts` invocation in the
   server namespace.
3. **Release the R0 quarantine on `run-campaign.ts`** — once
   #1 and #2 are in, `run-campaign.ts` can run the full ladder
   (4 cells × 3 reps × 2 netem conditions) and produce a sealed
   `RunArtifact` per cell.
4. **Render via `render-report.ts`** — the artifact feeds the
   report; the saturation caveat (loopUtilization > 0.3) lights up
   on the netem cells; the report is the deliverable.
5. **Trigger the heavy-runner workflow** — `gh workflow run
   ws-wt-real.yml -f candidate_commit=<sha>`. The runner builds
   the prebuild, runs the harness, uploads per-run artifacts.

The minimal echo numbers in `rig-mac-2026-08-29/` and
`heavy-runner-*/` are honest, real, reproducible, and good enough
to drive design decisions today. The production framework is the
path to the campaign's full deliverable.
