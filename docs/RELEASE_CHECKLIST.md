# Release Checklist

Required gates and process for cutting a release (RC or stable).

Canonical release truth: `docs/release-status.json`. This checklist provides the evidence inputs that can move the manifest from pending to ready.

## Required gates (automated)

The release workflow enforces these; the pipeline fails if any are missing:

| Gate | Job | Evidence artifact |
|------|-----|-------------------|
| Security | security | cargo audit, Trivy (no CRITICAL/HIGH) |
| Code quality | codeql | CodeQL analysis |
| Parity | parity | parity-evidence.json |
| Interop | interop | interop-evidence.json |
| Fuzz/property testing | fuzz | `.release-evidence/fuzz/release-smoke.json` Actions artifact |
| Build | build | prebuilds + SHA256SUMS |
| Exact package consumers | package-consumers | successful exact-tarball Bun/Node/Deno smoke across the supported OS/runtime matrix |

GitHub release assets include the prebuilds, npm tarball, `parity-evidence.json`, and `interop-evidence.json`. Fuzz evidence and the immutable npm publish input are retained as attempt-qualified Actions artifacts on the release workflow run; the exact-package consumer matrix is proven by its required successful job results.

## N-consecutive green policy

Before tagging an RC or stable release:

1. **Require** the `test` workflow to have succeeded on the default branch (or release branch) for the commits you are releasing.
2. **Recommended**: Ensure at least 1–3 consecutive green `test` runs before tagging. For stable cuts, prefer a 14-day window of sustained green (no flaky reds, no force-push reverts).
3. **Verify**: Check Actions → test workflow for recent runs on your branch.

No automated enforcement of the 14-day window; this is a release checklist discipline.

## Soak evidence (RC / stable)

GitHub-hosted Actions jobs are capped at ~6 hours. A single 24h/72h soak cannot run as one GitHub-hosted job.

| Stage | Soak requirement | Artifact |
|-------|------------------|----------|
| RC | 1h soak recommended | `soak-aggregate-1h-<commit>` from `soak-long` |
| Stable | 24h soak mandatory (P2.2-A); 72h recommended | complete segmented campaign aggregate, plus chained segment artifacts such as `soak-segment-24h-<commit>-seg01of05` and final `soak-aggregate-24h-<commit>` |

Do not start the 24h or 72h campaign until the exact release candidate commit is frozen. Any code, config, dependency, toolchain, or workflow change after segment 1 invalidates the campaign and requires a full restart from segment 1.

Campaign requirements:

1. Use `workflow_dispatch` on `soak-long` with the exact `candidate_commit`, `campaign_seed`, and `continuity_token` for every segment.
2. On GitHub-hosted runners, use `segment_count=5` for 24h and `segment_count=15` for 72h, dispatching indices in order. Each 4.8h workload leaves setup, cleanup, and artifact-upload headroom under GitHub's hard 6h job limit. On self-hosted runners use `segment_count=1` for both 24h and 72h, matching the executable workflow's single long-lived runner policy. The workflow resolves each predecessor artifact and `finalStateHash` itself; a missing or invalid predecessor stops the next segment.
3. Keep the same Bun, Rust, resolved CC/CXX paths and versions, and checkout commit for the whole chain. The harness records them and aggregation rejects drift.
4. The final segment automatically downloads all prior artifacts for that candidate and performs mandatory aggregation. No manual side-loaded directory is accepted by the release workflow. For forensic local re-verification only, run `bun tools/load/soak-addon.ts aggregate /path/to/segment-artifacts`.
5. Aggregation is release-blocking. It rejects:
   - missing segments
   - non-contiguous indices
   - failed segments
   - gaps or overlap between segment time bounds
   - commit drift
   - toolchain drift
   - seed/token drift
   - broken `previousFinalHash -> finalStateHash` chaining

Self-hosted runner requirements:

1. Linux x64 runner tagged `soak` with stable `clang` or `gcc-10+`, exact release-policy Bun and Rust versions, `openssl`, GitHub CLI (`gh`), `jq`, and `unzip`, plus enough headroom for the configured session/datagram/stream profile.
2. The workflow uses one 24h or 72h segment (`segment_count=1`) on self-hosted runners. That segment must produce the same tamper-evident hash-chained JSON/CSV artifact set, and the final aggregate is mandatory.

Workflow artifact naming contract:

- Segment artifacts uploaded by `soak-long` use `soak-segment-<duration>h-<commit>-segNNofNN`, for example `soak-segment-24h-<commit>-seg01of05`.
- Final aggregate artifacts uploaded by `soak-long` use `soak-aggregate-<duration>h-<commit>`, for example `soak-aggregate-24h-<commit>`.

What the long-run harness now proves per segment:

- steady-state leak/trend guard, not just an RSS ceiling; the short-load gate
  treats in-process RSS residency as diagnostic and uses repeated fresh child
  cycles plus clean process exit as the authoritative cleanup proof
- forced overload burst with explicit session/datagram/stream SLO checks
- idle-peer hold period
- reconnect churn burst
- certificate rotation followed by fresh reconnect traffic
- final close/drain cleanup back to queue/task baseline

Retain the segment JSON, CSV, stderr/stdout logs, and aggregate JSON in the release evidence bundle or release-blocking issue.

Retain soak artifacts and link them in release notes (or a release-blocking issue) for audit.

## Evidence links (auditable)

Per release:

- **parity-evidence.json** — parity suite passed at release time
- **interop-evidence.json** — Chromium interop passed at release time
- **SHA256SUMS** — prebuild integrity
- **Soak artifacts** (if run) — leak/trend evidence from soak-long

These are linkable from the GitHub release Assets page.
