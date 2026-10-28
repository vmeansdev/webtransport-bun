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
2. On GitHub-hosted runners, use `segment_count=5` for 24h and `segment_count=15` for 72h, dispatching indices in order. Each 4.8h workload leaves setup, cleanup, and artifact-upload headroom under GitHub's hard 6h job limit. Self-hosted 24h and 72h campaigns use segment_count=1: the workflow maps both durations to a single unsegmented run and refuses any other segment count. The workflow resolves each predecessor artifact and `finalStateHash` itself; a missing or invalid predecessor stops the next segment.
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
2. Self-hosted 24h and 72h campaigns run as one unsegmented job (`segment_count=1`) with the job timeout raised to match. The single segment must still produce the same tamper-evident hash-chained JSON/CSV artifact set, and its aggregate is mandatory.

Workflow artifact naming contract:

- Segment artifacts uploaded by `soak-long` use `soak-segment-<duration>h-<commit>-segNNofNN`, for example `soak-segment-24h-<commit>-seg01of05`.
- Final aggregate artifacts uploaded by `soak-long` use `soak-aggregate-<duration>h-<commit>`, for example `soak-aggregate-24h-<commit>`.

What the long-run harness now proves per segment:

- steady-state leak/trend guard, not just an RSS ceiling
- forced overload burst with explicit session/datagram/stream SLO checks
- idle-peer hold period
- reconnect churn burst
- certificate rotation followed by fresh reconnect traffic
- final close/drain cleanup back to queue/task baseline

Retain the segment JSON, CSV, stderr/stdout logs, and aggregate JSON in the release evidence bundle or release-blocking issue.

Retain soak artifacts and link them in release notes (or a release-blocking issue) for audit.

## H7 hosted closure lane

The 2-hour `soak-long` mode closes the H7 batched-datagram-delivery claim. It is
an addition to the table above, not a discount on it: H7 evidence supplements the
routine/RC/stable soak policy and does not replace the 24h/72h release soak. A
stable cut still needs its mandatory 24h campaign.

| Dispatch input | Required value |
|----------------|----------------|
| workflow ref | the immutable tag `refs/tags/h7-batch-delivery-<candidate-sha>` |
| `duration_hours` | duration_hours=2 |
| `runner_type` | runner_type=self-hosted |
| `runner_mode` | runner_mode=dedicated |
| `segment_index` / `segment_count` | 1 of segment_count=1 |
| `datagram_batch` | datagram_batch=64 |
| `rss_ceiling_mb` | rss_ceiling_mb=1750 |
| `committed_abort_mb` | 2200 |
| `heap_debug` | 0 |

1. Dispatch from the candidate tag itself, never from a branch. `scripts/validate-soak-inputs.sh` re-derives the tag suffix, the workflow SHA, and the checked-out HEAD, and rejects the run unless all three equal `candidate_commit` and the whole input tuple matches exactly.
2. The workload is preregistered and capacity-independent: runner_profile=h7-fixed-large, sessions=500, datagrams_per_sec=500, streams_per_sec=5. Shared-mode halving and the small/medium downscale ladder are both bypassed on this lane.
3. The runner must provide at least 5 CPUs and 8 GiB of memory. An under-capacity runner fails closed rather than downscaling the load — a smaller load is not acceptable H7 evidence, so the job must fail instead of silently producing evidence for a different workload.
4. The `rss_ceiling_mb` input may only tighten the harness default `max(1024, sessions * 3.5)`. At the fixed 500-session profile that default is exactly 1750, so the H7 ceiling resolves to 1750 while smaller lanes keep 1024.
5. Find the run by its unique display title `soak-long-<campaign_seed>` together with the candidate SHA, then download the segment and aggregate artifacts by that exact immutable run ID rather than by name alone.
6. Acceptance is fail-closed re-verification, not a green checkmark: run `bun tools/load/soak-addon.ts verify-h7-hosted <aggregate.json> <segment.json> --sha <candidate-sha> --batch 64 --rss-ceil-mb 1750 --duration-seconds 7200 --seed <campaign_seed> --continuity-token <token> --workflow-ref refs/tags/h7-batch-delivery-<candidate-sha>`. It re-derives the aggregate from its segment and pins runner type, runner mode, profile, rates, thresholds, debug knobs, and the resolved delivery knobs.

## Evidence links (auditable)

Per release:

- **parity-evidence.json** — parity suite passed at release time
- **interop-evidence.json** — Chromium interop passed at release time
- **SHA256SUMS** — prebuild integrity
- **Soak artifacts** (if run) — leak/trend evidence from soak-long

These are linkable from the GitHub release Assets page.
