# Phase 3.6 production-framework follow-ups — Architect review

**Reviewer:** Architect (senior systems, Rust ↔ TypeScript)
**Date:** 2026-08-29
**Branch:** `codex/ws-scenario-comparison`
**Plan under review:** `docs/superpowers/plans/deviations/phase-3.6-production-framework-followups.md`

---

## 1. Architectural verdict: **APPROVE-WITH-CHANGES**

The plan's diagnosis is correct: the rig↔Mac evidence under
`.release-evidence/transport-comparison/ws-wt-r0/campaign-r0/rig-mac-2026-08-29/`
came from `scripts/rig-min-echo-server.js` and `scripts/rig-measure-wt-client.ts`
(line-level minimal harnesses), not from the production framework. The
production `tools/compare/server.ts` requires the custom `FRAME_MAGIC = 0x5753`
binary handshake (`tools/compare/adapters/ws.ts:162-167`); `rig-measure-client.ts`
only does raw `ws.send(payload)`, so `acceptSession` blocks on the 60 s deadline.
That diagnosis holds and is the right starting point.

The five follow-ups are the right shape: spawn the supervisor
(`host-sidecar.ts`), wire the controller's real-run path through it, release the
quarantine that exists precisely because the supervisor wasn't there, render the
sealed artifact, and exercise it on the heavy runner. The plan also respects
the project rules: one scoped commit per follow-up, no raising the 2 MiB/session
or 512 MiB/global memory budgets, no measurement flags shipped to production.

What the plan is missing is the **two-resident** shape of the campaign, the
**typed preconditions** for the trust-boundary gate, and a clean answer for
which authority bytes the rig will be reading. These are not minor gaps — they
are the difference between wiring a real supervisor and wiring a real
supervisor that proves nothing.

---

## 2. Integration risks (highest-impact first)

### Risk 1 — Plan describes one supervisor; the design has two

`crates/native/src/secure_fs.rs:7789-7796` is explicit:

> *"The Mac resident supervisor owns the campaign root and the Mac staging
> root; the Linux staging root is reached over SSH, never by a local
> descriptor."*

And `crates/native/src/secure_fs.rs:9768-9840` (`bootstrap_supervisor`) takes
`BootstrapDescriptors<'_>` whose `campaign_root_fd` and `staging_root_fd` are
file descriptors owned by **the calling process** — there is no way to use a
remote FD through SSH. The supervisor is resident on the host that owns the
staged artifacts, and the campaign has two residents:

- **Mac-resident supervisor** — owns the Mac-side campaign + staging roots, the
  authority bytes staged under `~/.release-evidence/transport-comparison/...`,
  and the local control pipe.
- **Linux-resident supervisor** — owns the Linux-side campaign + staging roots,
  the same authority bytes staged under the same path on the rig, and a
  separate control pipe.

The plan's Follow-up #1 talks about *one* `spawnSupervisor(opts)` that returns
`SupervisorHandle { pid, controlInWriter, controlOutReader }`. The Linux side
is hand-waved as *"spawn supervisor via host-sidecar over SSH on the rig"* — but
`host-sidecar.ts` is a Mac-side module (`controllerOnlyTs`) and it cannot spawn
a process on the rig. The Linux-side spawn must be either:

  (a) an SSH command that runs a *different* (rig-side) controller-mode script
      on the rig — which duplicates the sidecar surface and breaks the
      `controllerOnlyTs` allowlist invariant (the rig-side module is not in
      that list), or
  (b) a `bash` one-liner inside the SSH command that re-implements the FD
      dance inline — fragile, untestable, and outside any frozen boundary.

The Mac supervisor cannot stand in for the Linux supervisor even if the rig
staging root were exposed as a 9P/SMB/NFS mount, because the supervisor owns
its FDs (`own_root_descriptor` at `secure_fs.rs:9794`) and that ownership is
per-process. The plan needs to acknowledge two residents and decide who spawns
the second one.

### Risk 2 — `assertOfficialComparisonIoAvailable()` weakening is undefined

`tools/compare/output-policy.ts:264-271`:

```ts
function throwOfficialComparisonIoUnavailable(): never {
    throw new ComparisonOutputPolicyError(
        "OUTPUT_TRUST_BOUNDARY_UNAVAILABLE",
        "official comparison filesystem I/O is unavailable until R1 supplies a validated staged trust boundary",
    );
}

export function assertOfficialComparisonIoAvailable(): void {
    throwOfficialComparisonIoUnavailable();
}
```

The comment at `output-policy.ts:255-260` ties this refusal to "R1 supplies a
validated staged trust boundary." Follow-up #3 proposes:

> *"Add a gate: when the 4 `COMPARISON_SUPERVISOR_*` env vars are set AND a
> verification digest is present, allow; otherwise still throw."*

Two unresolved questions:

  1. **The 4 env vars are not what the supervisor reads.** Searching the tree,
     `COMPARISON_SUPERVISOR_TOOLCHAIN/CAPABILITY/LOCK/MANIFEST` appear in:
     - `tools/compare/bin/compare-run.ts:45-49` (as constants in `SUPERVISOR_ENV_VARS`)
     - `tools/compare/bin/compare-run.ts:124-130` (as `hasSupervisorReservations`,
       a string-non-empty check)
     - The plan's deviation document.

     There is no production code that **reads the values** of these env vars
     anywhere in the supervisor binary, the secure-fs boundary, or the
     artifact builder. The only use of the env vars is a `process.env`
     non-empty-string check. Promoting them to a gate that unlocks
     `assertOfficialComparisonIoAvailable()` is a structural commitment to
     "four non-empty strings ⇒ authority exists" — the same defect R1 exists to
     remove elsewhere (the empty-toolchain digest, the constant-character
     `isImplausibleDigest` cases).

  2. **"A verification digest is present" is undefined.** A digest of what?
     Stated by whom? Validated against which anchor? The campaign's own anchor
     set is `R1_CAMPAIGN_AUTHORITY_ANCHOR_SET` at `run-campaign.ts:1239-1255`,
     which is a single `minting` entry whose `sha256` is the campaign's pinned
     trust root. If Follow-up #3 means "a digest equal to that anchor," then
     the gate is well-defined and is in fact a re-expression of
     `isPinnedCampaignAuthority` (`run-campaign.ts:1267-1270`). If it means
     "any non-empty digest", the gate is the structural weakening above. If
     it means something in between, the plan must say which checks the digest
     against what.

The plan also claims that *"assertOfficialComparisonIoAvailable() is touched
by ~600 tests; gate must remain test-stable."* That is correct, and it makes
the weakening more dangerous: a change here moves ~600 tests' green/red
boundary at once. The follow-up must be wired with a feature flag or a new
function name so the existing quarantine tests stay green while the new path
is exercised in isolation.

### Risk 3 — Control-pipe ownership and frame direction are not pinned

`crates/native/src/bin/comparison-supervisor.rs:567-573` defines
`control_descriptors(args) -> Option<(i32, i32)>` returning `(read_fd,
write_fd)`. The supervisor instantiates `ControlChannel { fd: control_in_fd }`
for the **reader** and `ControlChannel { fd: control_out_fd }` for the
**writer** (`comparison-supervisor.rs:669-674`). Reading the wire layout from
`supervisor-protocol.ts:140-145` and `supervisor-client.ts`:

> *4-byte BE canonical-header length (max 64 KiB) / canonical header / 8-byte
> BE payload length / payload bytes / 32-byte SHA-256 of the payload*

The supervisor reads `run-command` frames on the controller's write side and
writes `artifact-payload` / `admission-receipt` frames back on the controller's
read side. The plan's proposed handle shape:

> `SupervisorHandle { pid, controlInWriter, controlOutReader }`

…has the field names inverted. `control_in_fd` is the **read end of the pipe
the supervisor owns** — the supervisor reads from it, the controller **writes
to it**. `control_out_fd` is the **write end of the supervisor's pipe** — the
supervisor writes to it, the controller **reads from it**. So from the
controller's perspective, `control_in_fd` corresponds to a `Writable`
(`controlInWriter` in the plan) and `control_out_fd` corresponds to a
`Readable` (`controlOutReader` in the plan). The names happen to line up by
chance, but the **fields** must be:

  - `controllerToSupervisor: Writable` (the controller's writer over
    `control_in_fd`)
  - `supervisorToController: Readable` (the controller's reader over
    `control_out_fd`)

…and `host-sidecar.spawnSupervisor` must create the pipe pair, dup the
controller-side end to the descriptor number passed via `--control-in-fd` /
`--control-out-fd`, and `CLOEXEC` the supervisor-side ends (so the supervisor
inherits only the controller-side handles it was told about). The plan does
not mention `CLOEXEC`, `O_NONBLOCK`, or pipe sizing — all of which matter for
the bounded frame channel the resident loop runs over.

### Risk 4 — The rig has no staged trust boundary today

The plan assumes that `spawnSupervisor` can be called "with the 4 trust-bootstrap
FDs." But the rig has nothing in `~/.release-evidence/transport-comparison/...`
today. The existing rig-side artifacts under
`.release-evidence/transport-comparison/ws-wt-r0/campaign-r0/rig-2026-08-29/`
and `rig-mac-2026-08-29/` are JSON measurement files (`ticker-baseline.json`,
`SUMMARY.md`, etc.) — none of them are authority records, campaign locks,
staged capabilities, or manifests. The campaign authority anchor
`R1_CAMPAIGN_AUTHORITY_SHA256` (`run-campaign.ts:1259-1261`) is the *anchor*;
the bytes the rig needs are the authority record this anchor points at, and
that record does not exist yet for any real candidate.

The plan needs to add a staging step **before** any supervisor spawn: copy or
generate the authority bytes to both hosts, compute and verify the digest,
stage the lock / capability / manifest alongside, and only then open FDs and
spawn. The plan currently reads as if the staged records exist and only the
spawn side is missing.

### Risk 5 — Step #5 (workflow trigger) is misaligned with #1–#4

`.github/workflows/ws-wt-real.yml` invokes `bash tools/compare/load/ws-wt-real.sh`
(line 79), which sets up two `ip netns` with a veth pair and runs a raw echo
server + raw client — exactly the harness pattern the plan's "What was missing"
section says is being replaced. Triggering this workflow as the deliverable of
the production framework path contradicts itself: it runs the harness the plan
says is wrong.

If the intent is to keep the harness workflow as the "today's evidence" path
*in parallel* with the framework path, that should be stated explicitly and
labeled as such. If the intent is to retire the harness workflow once #1–#4
land, the plan should add a follow-up to delete it. As written, the plan ends
on step #5 as if it produced the framework's evidence, when it actually
produces the harness's evidence.

---

## 3. Missing scope

In addition to the risks above, the plan omits:

1. **A defined scope for `host-sidecar.spawnSupervisor`'s caller.** The plan
   lists what it returns but not what its `opts` parameter must contain
   (authority path? lock path? capability path? manifest path? campaign-root
   path? staging-root path? bun-path? candidate? campaignId? stage-nonce?).
   `secure_fs.rs:7789-7796` implies four of these are per-host. The signature
   is the architectural contract.

2. **A test plan for the new code.** The existing `controllerOnlyTs` set has
   one test file (`tools/compare/bin/compare-controller.test.ts`, 191 lines)
   covering pure helpers. `host-sidecar.test.ts` is not in the allowlist
   (`controllerTestTs` only contains `bin/compare-controller.test.ts`). The
   plan must add a `controllerTestTs` entry and the test file, or document
   why pure helpers do not need one.

3. **A staging step that produces the bytes the supervisor reads.** Without
   this, "the 4 trust-bootstrap FDs" are a hand-wave. The plan should call
   out: which script generates the authority, lock, capability, manifest;
   what their on-disk paths are on each host; and how the digests are pinned
   against `R1_CAMPAIGN_AUTHORITY_SHA256`.

4. **Shutdown / cleanup protocol.** `remote-supervisor.ts` already models
   `SupervisorState` and `SupervisorCleanupResult` (lease expiry, PGID kill,
   qdisc restore, lock release, artifact write). The plan does not say how
   `host-sidecar.spawnSupervisor` integrates with that state machine, what
   the controller does when the supervisor exits non-zero, or how the
   control pipe is drained on graceful shutdown. The supervisor's `serve`
   loop returns either `Ok(_summary)` or `Err(_)` (`comparison-supervisor.rs:720-735`)
   and writes a `trust_boundary_unavailable_stderr` on error — the controller
   must read both.

5. **A documented invariant on the `COMPARISON_SUPERVISOR_*` env vars.** If
   Follow-up #3 keeps them as gate preconditions, the plan must say: what
   string values are valid; how they are set; who sets them; and what
   happens if the supervisor is restarted with different values. Without
   this, the gate is a string-equality check on a constant.

6. **Documentation update.** The plan adds new code paths but does not
   propose changes to `docs/TRANSPORT_COMPARISON.md` (the campaign overview),
   `docs/OPERATIONS.md` (operations), or `docs/PARITY_MATRIX.md` (the R1
   parity status). The quarantine release is itself a parity-matrix item that
   should flip from BLOCKED → PASS, and the controller's real-run path going
   through the supervisor is a phase-4 closure that should be recorded.

---

## 4. Sequencing concerns

The plan's order is mostly right, with three exceptions.

### Move step #3 to *after* #1 and #2 are validated end-to-end

The R0 quarantine exists precisely because the supervisor is not wired
(`output-policy.ts:255-260`). Releasing it before #1 and #2 land and are
exercised end-to-end means a green test on the gate can be achieved without
any real measurement path behind it — which is exactly the failure mode the
quarantine was put in to prevent. Concretely:

  - Land #1 first (`host-sidecar.spawnSupervisor` + a test that fakes a
    supervisor via a stub binary and verifies the FD + control-pipe wiring).
  - Land #2 second (controller real-run calls `spawnSupervisor` and reads
    back a sealed artifact via the control pipe).
  - Land #3 third (quarantine release), gated on a feature flag, with the
    red test asserting that *without* the flag the gate still throws, and
    *with* the flag plus a valid digest, `runCampaign` reaches the artifact
    builder. This is the order that lets the red test catch a gate change
    that unlocks too much.

### Re-scope or relocate step #5

Either (a) drop step #5 from this plan, or (b) move it after #1–#4 are
proven end-to-end and label it as the harness-workflow retrigger (not the
framework deliverable). What it cannot be is the last step that closes the
plan: the harness workflow does not run the framework.

### Steps #1 and #2 each need their own staging commit

The plan bundles "spawn supervisor" with "controller calls spawn
supervisor" in spirit (Follow-ups #1 and #2). They should be two commits,
because the controller-call step depends on staging bytes that do not exist
yet (Risk 4). If #1 lands and there are no staged bytes to point at, #2
cannot exercise the spawn. Commit #1 should ship `spawnSupervisor` and a
test that uses a fixture authority/lock/capability/manifest fixture set;
commit #2 wires the controller to call it through `realRun` and integrate
with the existing `Bun.spawn`/SSH infrastructure.

---

## 5. Concrete changes requested

### 5.1 Rewrite Follow-up #1 to acknowledge two residents

> Replace Follow-up #1 with:
>
> **`host-sidecar.ts` spawn logic for the Mac-resident supervisor.**
> Implement `spawnMacSupervisor(opts)` that:
> 1. Opens the 4 trust-bootstrap FDs locally (`--authority-fd`,
>    `--authority-digest-fd`, `--campaign-root-fd`, `--staging-root-fd`).
> 2. Creates a Unix-domain socket pair (or `pipe(2)`), dups the
>    controller-side end to `--control-in-fd` (write end from controller's
>    view) and `--control-out-fd` (read end from controller's view), and
>    sets `O_CLOEXEC` on the supervisor-side handles.
> 3. Forks `target/release/comparison-supervisor` via `Bun.spawn` with the
>    6 `--*-fd` argv args and `COMPARISON_SUPERVISOR_BUN_PATH` set to
>    `~/.bun/bin/bun`.
> 4. Returns `SupervisorHandle { pid, controllerToSupervisor: Writable,
>    supervisorToController: Readable, fds: { authorityFd, ... } }` so
>    the caller can close the bootstrap FDs once the supervisor has
>    taken ownership.
>
> **Separate follow-up:** `spawnRigSupervisor(opts)` on the **rig**,
> invoked via SSH from `compare-controller.realRun`. The Mac-side
> `host-sidecar.ts` is **not** the right module to spawn the rig-resident
> supervisor; the rig-side module must live under the rig's
> `tools/compare/` (or be inlined into the SSH command) and is *not*
> subject to the Mac-side `controllerOnlyTs` allowlist. This is a second
> commit and a second architectural surface.

### 5.2 Define the trust-boundary gate in concrete terms

> Replace the "verification digest is present" clause in Follow-up #3 with:
>
> The gate accepts the run if and only if **all** of:
> (a) `COMPARISON_SUPERVISOR_TOOLCHAIN` is a 64-char lowercase hex,
> (b) `COMPARISON_SUPERVISOR_CAPABILITY` is a 64-char lowercase hex,
> (c) `COMPARISON_SUPERVISOR_LOCK` is a 64-char lowercase hex,
> (d) `COMPARISON_SUPERVISOR_MANIFEST` is a 64-char lowercase hex,
> (e) the four digests together are equal to
>     `R1_CAMPAIGN_AUTHORITY_SHA256`-derived roots (i.e., the campaign
>     lock's `capabilityDigestSha256` / `lockDigestSha256` /
>     `archiveDigestSha256` fields in the parsed authority record),
> (f) `isImplausibleDigest` returns `false` for all four
>     (`secure-fs.ts`, the same check that rejects the empty-input
>     digest and constant-character digests).
>
> Otherwise the gate continues to throw
> `OUTPUT_TRUST_BOUNDARY_UNAVAILABLE`. The check is a new exported function
> `hasVerifiedReservation(env)` parallel to the existing
> `hasSupervisorReservations(env)`; both names stay exported so the red
> test that asserts the unverified path still throws is unchanged.

### 5.3 Pin control-pipe ownership in the type

> Add to `host-sidecar.ts`:
>
> ```ts
> export interface SupervisorHandle {
>     readonly pid: number;
>     /** What the controller writes; the supervisor reads. */
>     readonly controllerToSupervisor: Writable;
>     /** What the supervisor writes; the controller reads. */
>     readonly supervisorToController: Readable;
>     /** Bootstrap FDs that the supervisor now owns; close after spawn. */
>     readonly bootstrapFds: readonly number[];
> }
> ```
>
> The spawn helper must call `fcntl(fd, F_SETFD, FD_CLOEXEC)` on every
> bootstrap FD it does not pass through `--*-fd` so a failed supervisor
> cannot leak the parent's authority FD into a grandchild.

### 5.4 Add a staging step before any spawn lands

> Insert before Follow-up #1:
>
> **Phase 3.6.0 — Stage the trust bootstrap on both hosts.**
> - Generate the campaign authority record (or use the R1 fixture) and
>   copy it to `~/.release-evidence/transport-comparison/<candidate>/<campaignId>/authority.bin`
>   on both the Mac and the rig.
> - Stage the lock, capability, and manifest next to it; compute their
>   digests; verify they equal `R1_CAMPAIGN_AUTHORITY_SHA256`-derived
>   roots.
> - Pin the rig-side paths in `compare-controller.ts`'s `realRun`
>   alongside the existing `tarLocalPath`.
> - Add a `--staged-dir=<path>` CLI flag to `realRun` so an operator can
>   point at the staged directory; reject any path that does not contain
>   all four files with the correct digests.

### 5.5 Re-scope Follow-up #5

> Either delete Follow-up #5 or rewrite it as:
>
> **Phase 3.6.5 — Re-trigger the harness workflow.**
> After Follow-ups #1–#4 land and the campaign evidence in
> `.release-evidence/transport-comparison/ws-wt-r0/campaign-r0/framework-r0/`
> passes `bun test`, run `gh workflow run ws-wt-real.yml
> -f candidate_commit=<sha>` to re-stamp the harness numbers. This is
> **not** the framework deliverable; the framework deliverable is the
> artifact set inside `framework-r0/`.

---

## 6. File-and-line index of the architectural claims above

| Claim | File:line |
| --- | --- |
| Plan correctly diagnoses the harness bypass | `docs/superpowers/plans/deviations/phase-3.6-production-framework-followups.md:21-29` |
| Production server requires `FRAME_MAGIC = 0x5753` | `tools/compare/adapters/ws.ts:162-167` |
| R0 quarantine tied to staged trust boundary | `tools/compare/output-policy.ts:255-260` |
| `assertOfficialComparisonIoAvailable()` is unconditionally throwing | `tools/compare/output-policy.ts:269-271` |
| 4 env vars are non-empty-string-checked constants | `tools/compare/bin/compare-run.ts:45-49, 124-130` |
| Two-resident architecture (Mac + Linux) | `crates/native/src/secure_fs.rs:7789-7796` |
| `bootstrap_supervisor` takes per-process FDs | `crates/native/src/secure_fs.rs:9768-9840` |
| Supervisor expects `--control-in-fd` (read) / `--control-out-fd` (write) | `crates/native/src/bin/comparison-supervisor.rs:567-573, 669-674` |
| Supervisor requires `COMPARISON_SUPERVISOR_BUN_PATH` env var | `crates/native/src/bin/comparison-supervisor.rs:693-718` |
| Frame wire layout (4B hdr-len / hdr / 8B payload-len / payload / 32B SHA-256) | `tools/compare/supervisor-client.ts:140-145`, `tools/compare/supervisor-protocol.ts` |
| `host-sidecar.ts` is in `controllerOnlyTs` allowlist (Bun.spawn OK) | `tools/compare/official-io-allowlist.json:47-53` |
| Controller already uses `Bun.spawn` for SSH/SCP/tar/client | `tools/compare/bin/compare-controller.ts:288, 333, 482, 599` |
| `host-sidecar.ts` has no spawn code yet (only FD/port validators) | `tools/compare/host-sidecar.ts:1-30` |
| `controllerTestTs` has only `bin/compare-controller.test.ts` | `tools/compare/official-io-allowlist.json:54-56` |
| Quarantine-release touches ~600 tests (`expectTrustBoundaryUnavailable`) | `tools/compare/output-policy.test.ts:112-122, 355, 372, 391, 413` |
| `R1_CAMPAIGN_AUTHORITY_ANCHOR_SET` (single minting anchor) | `tools/compare/run-campaign.ts:1239-1261` |
| `isPinnedCampaignAuthority` is the anchor check | `tools/compare/run-campaign.ts:1267-1270` |
| `isImplausibleDigest` rejects empty + constant-character digests | `tools/compare/secure-fs.ts` (imported in `output-policy.ts:18`) |
| Workflow runs the harness `ws-wt-real.sh`, not the framework | `.github/workflows/ws-wt-real.yml:79-82`, `tools/compare/load/ws-wt-real.sh` |
| Existing rig artifacts are raw JSON measurements, not staged trust records | `.release-evidence/transport-comparison/ws-wt-r0/campaign-r0/rig-2026-08-29/` |
| `remote-supervisor.ts` already models PGID kill / qdisc restore / lock release | `tools/compare/remote-supervisor.ts:30-46, 71-95` |

---

## 7. Closing note

The plan is on the right path. The fixes above are not scope creep — they
spell out what the plan implicitly assumes but does not say. With the
two-resident shape, the typed gate, the pinned control-pipe direction, the
staging step, and the harness-vs-framework clarification, the plan is a
sound end-to-end execution sequence for Phase 3.6.

Without them, the plan is wiring a real supervisor against an undefined
authority boundary, which is the kind of "looks green, proves nothing"
finish that the project rules are written to prevent.
