# Design: DigitalOcean Droplet Runbook for Dynamic G6 Sharded Diagnostics

**Date:** 2026-08-28
**Status:** Approved for implementation
**Scope:** Operator documentation only; no DigitalOcean resources are created or modified by this change.

## Context

The frozen protocol authority is
`docs/research/preregistrations/gate-g6-sharded.md`. The candidate-specific
authority is the campaign registration
`.scratch/bare-metal-campaign/registrations/g6-sharded-diagnostic-01.md`, which
must be supplied from the campaign checkout before dispatch. The common
process authority is `.scratch/bare-metal-campaign/registration-common.md`,
also supplied as a campaign artifact. These scratch files are external
prerequisites in this worktree, not tracked documentation links. The g6-mmo
and g6-mmo-closeout preregistrations are background component/shape references
only; they do not override the sharded preregistration. An optional
`DISPATCH_HANDOFF.md` is coordination material, not an authority for thresholds
or validity.

Those authorities define the current two-droplet DigitalOcean rig for
`g6-sharded-diagnostic-01`: a server and a Linux generator in the same AMS3
private network, with the private path used for measurement and the public
addresses used only for administration. That frozen registration is a
16-shard, `c-32-intel`/64 GB profile; it is not a universal hardware rule. The
repository currently documents the test shape, qualification gates, BPF setup,
and evidence rules, but it does not provide one checked-in lifecycle document
for provisioning, bootstrapping, dispatch, evidence collection, and teardown
across registered rig profiles.

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
for the temporary two-droplet DigitalOcean rig used by
`g6-sharded-diagnostic-01` and its explicitly registered scale successors, and
add a link to it from `docs/index.md`. The runbook will select a complete
`RIG_PROFILE` supplied by the current registration rather than hard-coding one
Droplet size or shard count. A different G6 shape or campaign still requires a
new registration and review.

The runbook will have these sections:

1. **Purpose, authority, and safety boundary** — temporary benchmark
   infrastructure for `g6-sharded-diagnostic-01`, not production deployment;
   the three authority documents and their precedence; no broad deletion
   commands; no secrets in files or logs; dispatch remains gated by a fresh
   registration and approval.
2. **Preflight** — verify `doctl account get`, the installed version, region,
   image, size, SSH key, VPC, local bundled Bun path, repository state, and the
   single-run lock policy. The registration supplies a complete profile:
   Droplet size and RAM, approved rung list/ceiling, shard count, BPF compile
   count, server-ID range, endpoint count, buffer/sysctl profile, RSS limit,
   and timeout settings. The image slug, SSH key, VPC UUID/default-VPC choice,
   project, run tag, candidate SHA, and registration digest are explicit inputs
   captured at run start; discovery commands are read-only.
3. **Provisioning** — create exactly two uniquely tagged droplets with
   `--wait`, requested size/image/region, SSH key, and private networking;
   capture droplet IDs and both public/private addresses immediately; verify
   same-region and same-VPC placement before continuing.
4. **Host bootstrap** — install the required build, BPF, kernel-header, Rust,
   and Bun prerequisites; clone or fetch the exact candidate; verify detached
   `HEAD`, clean content, binary/source hashes, and tool versions.
5. **G6 host configuration** — apply and record the profile's socket,
   UDP-memory, file-descriptor, and ephemeral-port settings; distinguish
   persistent sysctl values from per-process `ulimit` values. The same profile
   supplies `SHARD_COUNT`, `BPF_MAX_INSTANCES`, and the per-rung resource
   limits, so a larger Droplet is not silently operated with the smaller rig's
   shard or memory configuration.
6. **Server and generator setup** — run the BPF setup with the registered
   `SHARD_COUNT`, start exactly that many server instances with the registered
   server-ID range, configure the Linux generator entrypoint, use private IPs
   for the benchmark path, and record the exact command/environment. The
   current candidate's 16-shard limit is a compatibility check, not a default:
   a profile above 16 hard-stops until the candidate's producer, server wrapper,
   grader, and registration all support that count. Known harness gaps will be
   called out as hard stops rather than presented as effective settings without
   source-bound proof.
7. **Qualification and dispatch** — run the same-day network, sink, loaded-leg,
   and steering calibration checks at the registered frontier shape; re-pin
   maps with the registered shard count; hold `/tmp/bench.lock`; run every
   registered rung in order. A PASS or MISS is terminal for that rung only; an
   infrastructure or validity refusal follows the candidate registration's
   retry/stop rule and is never silently converted into a MISS.
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
the checked-in scripts rather than duplicating grading logic. The external
campaign registration and common-process files are required inputs, but their
absence from this checkout is itself a pre-dispatch stop rather than a reason
to guess or link to an untracked path. It will preserve
the following invariants:

- private VPC traffic is the measured path;
- the server has exactly the registered number of sharded instances and fresh
  BPF maps immediately before licensed dispatch;
- calibration residue never feeds the licensed steering floor;
- evidence is copied verbatim and independently recomputed;
- infrastructure/validity refusal is distinct from a registered rung MISS;
- the candidate SHA and registration digest are bound before execution; and
- one orchestrator owns `/tmp/bench.lock`, so no concurrent load generation is
  permitted.

Provisioning values are deliberately separated into two classes. The tracked
protocol supplies the two-role topology and the current profile's fixed values;
the current frozen profile is `ams3`, `c-32-intel`, 64 GB, private networking,
two droplets, and 16 shards. The operator must resolve and record the
account/project, image slug, SSH key ID, VPC UUID or default-VPC choice, unique
run tag, candidate SHA, registration digest, Droplet size/RAM, rung list, shard
count, BPF maximum, and tuning profile from the current campaign artifacts.
Historical droplet IDs, IPs, and SSH key IDs are examples of past evidence,
never defaults.

The runbook will describe the scale profile boundary explicitly:

| Planning profile | DigitalOcean size | RAM | Intended session band | Shard count |
| --- | --- | ---: | --- | --- |
| Current/frozen G6 profile | `c-32-intel` | 64 GB | Registered 5k–20k shape | 16 on the current candidate |
| c-32 scale planning profile | `c-32-intel` | 64 GB | Up to 1m planning ceiling | `S_32`, registration-bound; current source-bound profile is 16 |
| Larger scale planning profile | `c-60-intel` | 120 GB | 1.5m–2m planning band | `S_60 > S_32`, registration-bound; never inferred from a core-count formula |
| Other sizes such as `c-40-intel` | Registration-bound | Registration-bound | Registration-bound | Registration-bound |

The 1m and 1.5m–2m entries are planning boundaries, not historical PASS
claims. Each profile must carry its own registration and same-day qualification
evidence. A larger Droplet is expected to use more shards, but the exact count
is a profile input that must be supported by the candidate and grader.

The current source has an explicit compatibility boundary: the producer
rejects `SCAN_SHARDS > 16`, `g6-shard-server.ts` rejects server IDs above 16,
and `g6-sharded-grade.ts` requires 16 shard entries. The BPF setup's numeric
argument alone does not lift those limits. The runbook will therefore execute
the current 16-shard profile only and will refuse a `>16` profile until a
source-bound successor candidate and registration expand and verify the whole
path.

The local bundled runtime is an environment prerequisite, not a provisioning
constant. The runbook will require an explicit `BUN_BIN`/runtime check supplied
by the operator and will prohibit the known mise Node path; it will not invent a
machine-specific path in the committed document.

The runbook will include a pre-dispatch checklist requiring a fresh binding of
the current candidate and registration. It will not assume that an environment
variable or historical scratch registration is sufficient evidence that a
setting reaches the native client. Execution details will anchor to the tracked
`tools/load/g6-shard-bpf-setup.sh`,
`tools/offbox/linux-generator-entry-g6.sh`,
`tools/load/g6-sink-precheck.ts`, and
`docs/research/preregistrations/gate-g6-sharded.md` files.

## Verification of the resulting documentation

After implementation, verification will be documentation-focused:

- DigitalOcean lifecycle commands are checked against the locally installed
  `doctl 1.167.0-release` help surface;
- host commands are checked against the tracked scripts and repository docs
  that define them, with explicit `--version`/`--help` or postcondition checks
  where the runbook asks an operator to invoke an external tool; the runbook
  will not claim that `doctl` help validates `ssh`, package management,
  `sysctl`, `bpftool`, Bun, Cargo, or `rsync` syntax;
- all destructive examples require explicit, previously captured droplet IDs;
- no token, historical public IP, or unbounded resource selector is included;
- tracked repository links and paths resolve in the target worktree; external
  campaign artifacts are clearly labeled as required inputs and are not
  treated as tracked links;
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
