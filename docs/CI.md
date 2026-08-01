# CI.md

## CI goals
- Build + test on macOS, Linux, and Windows
- Produce prebuilt binaries for napi-rs addon
- Run Bun unit/integration tests on all supported OSes
- Run Chromium interop tests on all supported OSes
- Soak test for leak detection

Canonical release truth: `docs/release-status.json`. CI evidence feeds that manifest; it does not by itself mark a surface stable or GA.

## Supported targets (shipped prebuilds)
| Target           | Runner         | Architecture |
|------------------|----------------|--------------|
| `darwin-arm64`   | `macos-latest` | aarch64      |
| `darwin-x64`     | `macos-latest` | x86_64       |
| `linux-x64`      | `ubuntu-latest`| x86_64       |
| `win32-x64-msvc` | `windows-latest` | x86_64    |

## Workflows

### test.yml (push, pull_request, workflow_dispatch)

**test** job — matrix: `{ubuntu-latest, macos-latest, windows-latest}` × `{1.3.9, 1.3.14}`

1. Rust quality gates: `cargo fmt --check`, `cargo audit`, `cargo clippy -- -D clippy::all`, `cargo test --workspace`
2. Build native addon + install deps
3. Typecheck (`bun run typecheck`)
4. Unit tests (`bun test packages/`)
5. Build reference + load-client
6. Load-addon test (`bun run test:load-addon`)
7. Load-scale-addon authoritative child-process repeated-cycle gate (two 200-session, 30s cycles)
8. Benchmark — handshake latency (`bun run bench:handshake`); fails if p95 > `BENCH_P95_MAX_MS`
9. Overload-addon test (`bun run test:overload-addon`)
10. Load profiles (`bun run test:load-profiles-addon`)

Test log hygiene:
- Set `WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN=1` in CI test jobs to suppress repeated dev-only TLS warning logs when tests intentionally use `tls.insecureSkipVerify: true`.
11. Interop — Playwright Chromium (`cd tools/interop && bun run playwright test`)
12. Smoke test — `bun add` from built package

**package-consumers** job — matrix: `{ubuntu-latest, macos-latest, windows-latest}`

1. Builds the exact npm tarball with the current-platform native addon and the production WASM export.
2. Verifies a reproducible logical package manifest and SHA-256-covered prebuilds.
3. Installs the tarball with lifecycle scripts disabled.
4. Runs the same native addon load, datagram, unidirectional-stream, bidirectional-stream, and deterministic-close smoke under exact Bun, Node, and Deno versions.

**parity** job — `ubuntu-latest`

1. Build native addon + install deps
2. Run W3C facade parity suite (`bun run test:parity`)

**soak** job — `ubuntu-latest`, 2-minute soak (`SOAK_DURATION=120`). **soak-long** workflow (1h/24h/72h) — trigger via workflow_dispatch; each run retains `soak-artifacts-seg-*.json`/CSV plus logs, and the final segment emits the validated `.release-evidence/soak-aggregate-<duration>h.json` campaign record.

### release.yml (tag push `v*`, workflow_dispatch)

**P3.2**: Security gates block release. Jobs run before build:

1. **security** — cargo audit, Trivy filesystem scan, Trivy library vulnerability scan (CRITICAL/HIGH blocking)
2. **codeql** — CodeQL analysis (JS/TS + Rust)

3. **parity** — W3C facade parity tests; produces `parity-evidence.json`
4. **interop** — Chromium WebTransport interop (P3.3); runs reconnect storms, mixed concurrency, close/reset semantics; uploads `interop-evidence.json`
5. **build** — matrix: `{linux-x64, darwin-arm64, darwin-x64, win32-x64-msvc}` — builds native addon, generates prebuilds + SHA256 checksums, uploads artifacts
6. **package-consumers** — needs [build]; builds the exact tarball from the downloaded release prebuilds and runs the native addon, datagram, unidirectional-stream, bidirectional-stream, and deterministic-close smoke under Bun, Deno, and the supported Node engine floor/current versions across Linux, macOS, and Windows.
7. **release** — needs [build, interop, parity, fuzz, package-consumers]; verifies required evidence and all four target prebuilds, regenerates and checks SHA256SUMS, builds and smokes the exact package under Bun/Node/Deno, then uploads the tarball plus a run/attempt/commit/tag/digest-bound `candidate-identity.json` as the immutable, attempt-qualified `npm-publish-input-<run_attempt>` Actions artifact before creating the GitHub release.

The blocking **fuzz** job runs `bun run fuzz:release-smoke`, which now covers cargo-fuzz targets, stable Rust parser/property tests, and the Bun-side `WASM event decoder property harness` from `packages/webtransport/test/wasm-limits.test.ts`. Its canonical artifact path is `.release-evidence/fuzz/release-smoke.json`.

### publish.yml (successful release workflow_run, workflow_dispatch)

Automatic publishing accepts only a successful same-repository `release.yml` run caused by a semantic-version tag push. Manual retry is accepted only when dispatching `publish.yml` from `main` and requires the exact numeric `release_run_id`; a tag is not an acceptable retry identity. The job verifies the release run through the GitHub Actions API, downloads only the attempt-qualified `npm-publish-input-<run_attempt>` artifact from that exact run ID, validates candidate repository/workflow/run/attempt/commit/tag/tarball identity and SHA-256, checks out the bound commit, then smokes, dry-runs, and publishes that exact downloaded tarball. Both the dry-run and real publish step reload the candidate-bound digest and re-hash the exact tarball immediately before invoking npm, closing the post-verification replacement window. GitHub release bodies and assets are never trusted as npm input and the package is not rebuilt in the publish job. The repository policy checker parses the publish job and required steps structurally, requires live dataflow from the queried release-run JSON through exact step outputs and candidate environment mappings, and rejects hardcoded metadata, conditional/dead handoff steps, alternate acquisition paths, rebuilds, digest omissions, a different tarball, a second publish path, or a missing immediate digest recheck.

The job uses npm Trusted Publishing only: job-scoped `id-token: write`, the protected `npm-publish` GitHub environment, exact npm `11.18.0`, and no npm authentication secret. The npm package must have a trusted publisher configured for repository `vmeansdev/webtransport-bun`, workflow `publish.yml`, and environment `npm-publish`; that registry-side configuration is an external release prerequisite and must be verified before the stable tag.

### rollback.yml (workflow_dispatch)

**RELEASE-OPS-A**: Rollback drill for known-good release restore.

- **rollback-drill** — workflow_dispatch with input `rollback_target` (e.g. `v0.1.0`)
  1. Downloads release assets from GitHub
  2. Verifies SHA256 checksums against SHA256SUMS
  3. Outputs operator runbook with pin command
- Run via **Actions → rollback → Run workflow**. See docs/OPERATIONS.md § Runbook: Rollback to known-good release.

## CI-EVIDENCE-A: Sustained evidence closure

- **Release pipeline** requires security, CodeQL, fuzz, build, exact-package consumers, parity, and interop gates; fails on any missing blocker or required release evidence.
- **Evidence retention**: prebuilds, the npm tarball, `parity-evidence.json`, and `interop-evidence.json` are attached to every GitHub release. Fuzz evidence and the immutable npm publish input remain attempt-qualified Actions artifacts under the release workflow's retention policy.
- **Release status**: `docs/release-status.json` stays the canonical readiness record for native and wasm candidate surfaces.
- **N-consecutive green**: Release checklist (docs/RELEASE_CHECKLIST.md) documents policy; recommend 1–3 green test runs before RC, 14-day sustained green before stable.
- See docs/RELEASE_CHECKLIST.md for full gates and soak requirements.

## Release flow
- Tag `vX.Y.Z`
- CI runs security, CodeQL, fuzz, parity, interop, build, and exact-package consumer gates; verifies required evidence
- GitHub release created with prebuilds, checksums, parity-evidence, interop-evidence
- Successful completion of the tag-triggered release workflow triggers `publish.yml`; manual dispatch from `main` is reserved for retrying an exact successful release workflow run ID.

## Branch protection policy
- `main` must reject direct pushes and force pushes.
- `development` currently allows both regular pushes and force pushes.
- Repository ruleset payload is checked in at `.github/rulesets/main-no-push.json`.
- Apply with GitHub CLI (repo admin):
  - `gh api --method POST repos/<owner>/<repo>/rulesets --input .github/rulesets/main-no-push.json`

## Immutable workflow and toolchain policy

- Every third-party action is pinned to a full 40-character commit SHA with a human-readable release comment.
- Exact Bun, Rust, Node, Deno, Python, npm, wasm-bindgen, cargo-audit, cargo-llvm-cov, Playwright, and IWA packaging versions are allowlisted in `.github/release-toolchain.json`.
- `bun scripts/check-actions-pinned.ts` rejects mutable action refs, floating or unapproved tool versions, workflow-wide write access, unjustified write scopes, token-based npm publishing, publish jobs without OIDC/provenance, and any publish workflow that does not consume an exact release workflow-run artifact.
- Release-critical jobs declare explicit permissions, timeouts, concurrency behavior, artifact retention, and checksum validation.

## npm trusted-publishing rollout

1. Confirm the npm package already exists and the release actor has package-administration authority.
2. In npm package settings, configure the GitHub Actions trusted publisher for repository `vmeansdev/webtransport-bun`, workflow `publish.yml`, and environment `npm-publish`.
3. Protect the GitHub `npm-publish` environment according to the release-approver policy.
4. Verify the registry configuration with a release-candidate workflow run before creating the stable tag. The workflow intentionally has no fallback npm token path.

## Canary strategy
- Publish `vX.Y.Z-rc.N` for release candidates
- Run extended soak (e.g. 24h) on rc before tagging stable
- Prefer `bun add @scope/webtransport@rc` for canary testing
