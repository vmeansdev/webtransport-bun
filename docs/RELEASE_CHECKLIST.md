# Release Checklist

Required gates and process for cutting a release (RC or stable).

Canonical release truth: `docs/release-status.json`. This checklist provides the evidence inputs that can move the manifest from pending to ready.

## Where release evidence lives

Evidence files are **GitHub Release assets of the candidate pre-release** (the
`vX.Y.Z-rc.N` tag of the frozen candidate commit). The repository carries only
the checksum manifest `docs/release-evidence-manifest.json` (schema
`docs/release-evidence-manifest.schema.json`; individual command records follow
`docs/release-evidence.schema.json`). Nothing else evidence-like is committed:
`scripts/check-tracked-hygiene.sh` refuses `.release-evidence/`,
`.bench-evidence/`, `.scratch/`, `docs/superpowers/` and stray `*.jsonl`.
Pre-releases are public, and so is their evidence.

Each manifest entry records the claim id(s) it supports, the asset name
(`evidence-<id>.json` or `evidence-<id>.tar.gz`), its size and sha256, the
sha256 of every scrubbed file inside it, the commit it was produced at, its
producer (GitHub Actions repository/workflow/run id/attempt/URL/head SHA, or
`local` with a description) and its creation time. `docs/release-status.json`
claims cite manifest entry ids in `evidenceIds`; they never cite repository
paths.

### The gate set is pinned

`docs/release-claims.json` is the claim registry: which claims exist, their
surface, whether each is `gaRequired`, and the positive proof a `passed` entry
must carry. `release-status.json` only records progress against it:
`scripts/check-doc-truth.ts` refuses a status file whose claim set, surfaces or
`gaRequired` flags differ from the registry. Verification reads the registry
from the candidate commit itself (its sha256 is bound into the manifest), so
changing a gate is a code change that invalidates the candidate.

Positive proof is checked in each producer's own output format
(`scripts/release-claims.ts`); an unknown document, `{}`, or a text-only bundle
is refused:

| Proof | Claims | Requires |
|---|---|---|
| command records (`scripts/generate-release-evidence.ts`) | local gates, wasm protocol gates, runtime consumers, cross-platform matrix, supply-chain provenance | every record exit 0 at the candidate commit; the claim's commands (e.g. `cargo test` and `bun test`) or platforms present |
| Playwright JSON report | Chromium native/wasm interop, fault matrix | `expected > 0`, no unexpected/flaky/errors, every spec ok; from a GitHub Actions run |
| `release-smoke.json` | fuzz gates | no failures, every command exit 0 in time, non-empty corpora; from a GitHub Actions run |
| llvm-cov + Bun LCOV reports | coverage gates | `scripts/check-llvm-cov-floors.py` re-run over the bundled reports passes; from a GitHub Actions run |
| soak aggregate | soak 24h / 72h | `status: pass`, candidate commit, every segment passed, the full duration |
| `run-iwa.mjs` evidence | IWA Direct Sockets | every functional check of `validateEvidence`, `sourceCommit` = candidate |
| `candidate-identity.json` | package artifact | bound to the candidate and the release workflow run |
| distributed-scale artifact | scale 10k (not GA-blocking) | promotable, `source.sha` = candidate, ≥ 10 000 sessions |
| review record `{kind: "review", commit, reviewer, scope, verdict: "pass", findings: {P0..P4: 0}}` | auto-review | all counts zero |
| `{kind: "no-change-confirmation", commit, frozenAt, verdict: "pass", changedFilesSinceFreeze: []}` | final no-change | nothing changed |

### Flow

All through `bun scripts/release-evidence.ts`:

1. **Freeze and tag.** The committed `packages/webtransport/package.json`
   carries the base version (`X.Y.Z`); the published version is stamped from
   the tag at build time (`scripts/stamp-version-from-tag.ts`). Push the
   `vX.Y.Z-rc.N` tag on the candidate commit. The tag-triggered `release`
   workflow builds `X.Y.Z-rc.N`, publishes the pre-release (`prerelease` is set
   for any hyphenated tag), and `publish.yml` puts it on npm under the `next`
   dist-tag, never `latest`. Its `evidence-assets` job fetches the run's own
   interop, fuzz, distributed-scale and package-identity artifacts, scrubs and
   attaches them plus a
   `release-evidence-fragment-release-<run>-<attempt>.json` manifest fragment. The job is `continue-on-error`: a refused bundle never
   blocks the release or the rc publish, but the failure stays on the run.
2. **Bind.** `bind --commit <candidate-sha> --tag vX.Y.Z-rc.N` records the
   candidate, the package version at that commit and the registry's sha256 in
   the manifest and the candidate in `release-status.json`. Binding a different
   candidate drops every entry and resets every claim to pending.
3. **Collect.** `import --from-release` records the CI fragments. Evidence
   from other workflow runs (`soak-long`, `iwa`, `fuzz`, `coverage`,
   `bench-bandwidth`) comes in with
   `fetch --run <run-id> --artifact <name> --claim <claim-id>`. Local runs
   (interactive IWA proof, bare-metal soaks, review records) come in with
   `package --claim <claim-id> --input <file-or-dir> --local "<what ran where>"`.
   Provenance is never self-attested: CI evidence enters only through `fetch`,
   which reads the run back from the Actions API (refusing a run in another
   repository or workflow, one that did not build the candidate, or one that
   did not succeed; the only in-progress run accepted is the release run
   fetching its own artifacts from inside itself), downloads the named
   artifact itself, and records the artifact's id, name and digest; verify
   re-checks them against the run's artifact listing. `package` accepts local
   producers only.
4. **Scrub.** `package` and `fetch` rewrite the checkout path to `<repo>`, then
   run the evidence-privacy scanner over every file. It refuses, without
   echoing the value: credential-shaped values or keys; environment dumps, by
   name (`HOME`, `PATH`, `USER`, `LOGNAME`, `HOSTNAME`, `RUNNER_*`,
   `GITHUB_*`, `*_TOKEN`, …) and by structure (three or more
   environment-shaped names that are not documented `WT_*`/`WEBTRANSPORT_*`
   knobs); the local login and hostname; host paths; and any of these hidden
   behind base64/base64url, hex, percent-encoding or gzip. Encodings are
   rejoined across whitespace, line wraps and split JSON strings, decoded at
   every alignment, inflated when compressed (a tar.gz inside is read), and
   rescanned; anything still decodable after four layers, and any zip/xz/
   zstd/7z/bzip2 payload, is refused rather than accepted. Remaining plain host paths may be replaced
   by a marker only with `--redact-host-paths`; everything else is always
   refused. Binary files are refused because they cannot be scanned. Bundles
   are canonical: a single gzip member without header extras or trailing
   bytes, a tar archive byte-identical to the canonical archive of its listed
   members and its end-of-archive marker, so nothing can ride along unscanned.
5. **Upload.** `upload` attaches the assets with `gh release upload`. It is a
   dry run unless `--execute`, creates the pre-release only with
   `--create-prerelease` (the tag must already exist; nothing creates tags),
   refuses a release that is not a pre-release or is immutable, and refuses to
   replace an attached asset with different content (downloading and hashing
   it when the API gives no digest).
6. **Record.** Mark claims `passed` with the manifest entry ids and commit the
   manifest and `release-status.json` (only those two files) on top of the
   candidate.
7. **Verify and promote.** `verify` downloads every evidence and fragment
   asset with `gh release download` and hashes it (a remote digest is a
   cross-check, never a substitute), checks size, sha256 and file list against
   the manifest, re-runs the privacy and proof checks, re-reads every producing
   run, checks that the tag points to the candidate and the package version
   matches, and that every `gaRequired` claim (per the candidate's registry)
   has passing evidence bound to it. `verify --assets-dir <dir>` is an audit of
   assets already on disk and is never release verification.
   `bun scripts/promote-release-status.ts` runs the full verification against
   downloaded assets and refuses unless HEAD is the candidate or a descendant
   that changed only the evidence record; there is no override. It sets
   readiness `ready` and writes a **promotion lock** into the manifest: the tag
   commit and the sha256 of every evidence asset on the pre-release. Both
   records are replaced atomically, lock first; a promotion interrupted
   between them is completed by rerunning promote (which re-verifies the lock
   against the release), and rerunning a finished promotion changes nothing.
8. **Do not edit the pre-release after promotion.** The
   `release-evidence-verify` workflow re-verifies daily and on every change to
   the record (`verify --require-ready` once promoted, `verify
   --integrity-only` while evidence is still being collected) and fails if the
   tag moved or any evidence asset was added, removed or replaced.
9. **GA.** The GA tag `vX.Y.Z` points at the **candidate commit** itself, not
   at the evidence-record commit. The `release` workflow's "GA evidence gate"
   step runs `verify --ga-tag vX.Y.Z --require-ready` against the record on
   `main` before it creates the release, so the GA release (and therefore the
   npm `latest` publish) is refused unless the record is promoted, the GA tag
   is the candidate commit, and the pre-release still matches the lock.

Tags and versions: the candidate is bound with its pre-release tag
`v<base>-rc.N`, and the GA tag `v<base>` goes on the same commit. Both build
from the committed base version, stamped from the tag: the rc publishes
`<base>-rc.N` to `next`, GA publishes `<base>` to `latest`. The release build
and `publish.yml` refuse any other tag, and the published tarball's
`candidate-identity.json` records the tag, the commit and the stamped
`packageVersion`.

## Required gates (automated)

The release workflow enforces these; the pipeline fails if any are missing:

| Gate | Job | Evidence artifact |
|------|-----|-------------------|
| Security | security | cargo audit, Trivy (no CRITICAL/HIGH) |
| Code quality | codeql | CodeQL analysis |
| Parity | parity | parity-evidence.json |
| Interop | interop | interop-evidence.json |
| Fuzz/property testing | fuzz | `release-smoke.json` (Actions artifact; attached to a candidate pre-release as `evidence-fuzz-gates-release-<run>-<attempt>.tar.gz`) |
| Build | build | prebuilds + SHA256SUMS |
| Exact package consumers | package-consumers | successful exact-tarball Bun/Node/Deno smoke across the supported OS/runtime matrix |

GitHub release assets include the prebuilds, npm tarball, `parity-evidence.json`, and `interop-evidence.json`. On a pre-release tag the `evidence-assets` job additionally attaches the scrubbed `evidence-*` bundles and the run's `release-evidence-fragment-*.json` (see above); on a stable tag the GA evidence gate must pass before the release is created. The immutable npm publish input stays an attempt-qualified Actions artifact on the release workflow run and remains the only npm publish input; the exact-package consumer matrix is proven by its required successful job results.

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

Attach the segment JSON, CSV, stderr/stdout logs, and aggregate JSON to the candidate pre-release with `bun scripts/release-evidence.ts fetch --run <run-id> --artifact soak-aggregate-<duration>h-<commit> --claim soak-24h` (and likewise for each segment artifact and for `soak-72h`; the default entry id includes the artifact name, so a segment and its aggregate from one run do not collide), then `upload --execute`; the manifest entry is what `release-status.json` cites.

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
- **evidence-*.json / evidence-*.tar.gz** (candidate pre-release only) — the
  claim evidence recorded, with sha256, in `docs/release-evidence-manifest.json`

These are linkable from the GitHub release Assets page. To audit a candidate
from assets already on disk: `gh release download <tag> --pattern 'evidence-*'
--dir <dir>`, then `bun scripts/release-evidence.ts verify --assets-dir <dir>`
(an audit only: the tag-to-commit and pre-release checks still query GitHub,
and only a verification that downloads the assets itself counts).
