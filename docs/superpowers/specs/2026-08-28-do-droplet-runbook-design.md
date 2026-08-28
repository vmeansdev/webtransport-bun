# Design: DigitalOcean Droplet Runbook for G6 Diagnostics

**Date:** 2026-08-28
**Status:** Approved for implementation
**Scope:** Operator documentation only; no DigitalOcean resources are created or modified by this change.

## Context

The G6 preregistration defines a two-droplet DigitalOcean rig: a server and a
Linux generator in the same AMS3 private network, with the private path used
for measurement and the public addresses used only for administration. The
repository currently documents the test shape, qualification gates, BPF setup,
and evidence rules, but it does not provide one checked-in lifecycle document
for provisioning, bootstrapping, dispatch, evidence collection, and teardown.

The operator has an authenticated `doctl` installation on the local machine.
The runbook must use that default authenticated context without copying or
printing an access token. It must remain source-bound: a runbook invocation is
not an approval to dispatch a campaign, and a candidate, registration digest,
rig identity, and same-day qualification evidence must be recorded before a
licensed run.

## Alternatives considered

1. **G6-focused checked-in runbook with `doctl` lifecycle commands** —
   recommended. It makes the current operational contract concrete while
   keeping candidate-specific values as explicit inputs. It is reviewable,
   reproducible, and does not add a new automation program.
2. **Generic DigitalOcean lifecycle runbook with a separate G6 appendix** —
   more broadly reusable, but it would abstract away the topology and gates
   that make the G6 rig safe to operate and would create another layer that can
   drift from the preregistration.
3. **Fully automated `doctl` plus cloud-init bootstrap** — reduces manual
   setup, but adds privileged mutable automation, makes source-bound review
   harder, and is unnecessary for the immediate diagnostic campaign.

## Chosen design

Create `docs/research/DO_DROPLET_RUNBOOK.md` as the canonical operator guide
for temporary G6 diagnostic/scale rigs, and add a link to it from
`docs/index.md`.

The runbook will have these sections:

1. **Purpose and safety boundary** — temporary benchmark infrastructure, not
   production deployment; no broad deletion commands; no secrets in files or
   logs; dispatch remains gated by a fresh registration and approval.
2. **Preflight** — verify `doctl account get`, the installed version, region,
   image, size, SSH key, VPC, local bundled Bun path, repository state, and the
   single-run lock policy. Discovery commands are read-only.
3. **Provisioning** — create exactly two uniquely tagged droplets with
   `--wait`, requested size/image/region, SSH key, and private networking;
   capture droplet IDs and both public/private addresses immediately; verify
   same-region and same-VPC placement before continuing.
4. **Host bootstrap** — install the required build, BPF, kernel-header, Rust,
   and Bun prerequisites; clone or fetch the exact candidate; verify detached
   `HEAD`, clean content, binary/source hashes, and tool versions.
5. **G6 host configuration** — apply and record the registered socket,
   UDP-memory, file-descriptor, and ephemeral-port settings; distinguish
   persistent sysctl values from per-process `ulimit` values.
6. **Server and generator setup** — run the 16-instance BPF setup on the
   server, configure the Linux generator entrypoint, use private IPs for the
   benchmark path, and record the exact command/environment. Known harness
   gaps will be called out as hard stops rather than presented as effective
   settings without source-bound proof.
7. **Qualification and dispatch** — run the same-day network, sink, loaded-leg,
   and steering calibration checks; re-pin maps; hold `/tmp/bench.lock`; run
   the registered ladder in order; stop at the first registered failure.
8. **Evidence and teardown** — copy raw artifacts before teardown, generate
   and verify `SHA256SUMS`, preserve the registration/stamp metadata, delete
   only the captured droplet IDs, and verify that those IDs and the unique run
   tag no longer exist.
9. **Failure handling** — stop on authentication, placement, SSH, candidate,
   qualification, or validity failures; preserve artifacts; recover partial
   provisioning by resolving the unique run tag and deleting only confirmed
   resources; never lower thresholds or retry a licensed rung silently.

## Source-bound constraints

The runbook will point operators back to the tracked G6 preregistration and
the checked-in scripts rather than duplicating grading logic. It will preserve
the following invariants:

- private VPC traffic is the measured path;
- the server has 16 sharded instances and fresh BPF maps immediately before
  licensed dispatch;
- calibration residue never feeds the licensed steering floor;
- evidence is copied verbatim and independently recomputed;
- infrastructure/validity refusal is distinct from a registered rung MISS;
- the candidate SHA and registration digest are bound before execution; and
- one orchestrator owns `/tmp/bench.lock`, so no concurrent load generation is
  permitted.

The runbook will include a pre-dispatch checklist requiring a fresh binding of
the current candidate and registration. It will not assume that an environment
variable or historical scratch registration is sufficient evidence that a
setting reaches the native client.

## Verification of the resulting documentation

After implementation, verification will be documentation-focused:

- every command is checked against the locally installed `doctl` help surface;
- all destructive examples require explicit, previously captured droplet IDs;
- no token, historical public IP, or unbounded resource selector is included;
- links and referenced repository paths resolve in the target worktree;
- the runbook's command order matches the preregistration's qualification,
  dispatch, evidence, and teardown rules; and
- only the runbook and its index link are included in the follow-up commit,
  with `DISPATCH_HANDOFF.md` and unrelated worktree state preserved.

## Out of scope

- creating or deleting live DigitalOcean droplets during documentation work;
- changing G6 thresholds, grading code, source scripts, or registrations;
- storing credentials, provisioning a persistent production environment, or
  replacing the campaign's approval and evidence gates; and
- adding a new provisioning executable or CI workflow.
