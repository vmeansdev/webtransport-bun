# CI.md

## CI goals
- Build + test on macOS and Linux
- Produce prebuilt binaries for napi-rs addon
- Run Bun unit/integration tests on both
- Run Chromium interop tests on both
- Soak test for leak detection

## Supported targets (shipped prebuilds)
| Target           | Runner         | Architecture |
|------------------|----------------|--------------|
| `darwin-arm64`   | `macos-latest` | aarch64      |
| `darwin-x64`     | `macos-latest` | x86_64       |
| `linux-x64`      | `ubuntu-latest`| x86_64       |

## Workflows

### test.yml (push, pull_request, workflow_dispatch)

**test** job — matrix: `{ubuntu-latest, macos-latest}` × `{1.3.9, latest}`

1. Rust quality gates: `cargo fmt --check`, `cargo audit`, `cargo clippy -- -D clippy::all`, `cargo test --workspace`
2. Build native addon + install deps
3. Typecheck (`bun run typecheck`)
4. Unit tests (`bun test packages/`)
5. Build reference + load-client
6. Load-addon test (`bun run test:load-addon`)
7. Load-scale-addon (200 sessions, 30s)
8. Benchmark — handshake latency (`bun run bench:handshake`); fails if p95 > `BENCH_P95_MAX_MS`
9. Overload-addon test (`bun run test:overload-addon`)
10. Load profiles (`bun run test:load-profiles-addon`)

Test log hygiene:
- Set `WEBTRANSPORT_SUPPRESS_INSECURE_SKIP_VERIFY_WARN=1` in CI test jobs to suppress repeated dev-only TLS warning logs when tests intentionally use `tls.insecureSkipVerify: true`.
11. Interop — Playwright Chromium (`cd tools/interop && bun run playwright test`)
12. Smoke test — `bun add` from built package

**parity** job — `ubuntu-latest`

1. Build native addon + install deps
2. Run W3C facade parity suite (`bun run test:parity`)

**soak** job — `ubuntu-latest`, 2-minute soak (`SOAK_DURATION=120`). **soak-long** workflow (1h/24h/72h) — trigger via workflow_dispatch; writes soak-artifacts.json

### release.yml (tag push `v*`, workflow_dispatch)

**P3.2**: Security gates block release. Jobs run before build:

1. **security** — cargo audit, Trivy filesystem scan, Trivy library vulnerability scan (CRITICAL/HIGH blocking)
2. **codeql** — CodeQL analysis (JS/TS + Rust)

3. **parity** — W3C facade parity tests; produces `parity-evidence.json`
4. **interop** — Chromium WebTransport interop (P3.3); runs reconnect storms, mixed concurrency, close/reset semantics; uploads `interop-evidence.json`
5. **build** — matrix: `{linux-x64, darwin-arm64, darwin-x64}` — builds native addon, generates prebuilds + SHA256 checksums, uploads artifacts
6. **release** — needs [build, interop, parity]; verifies required evidence, downloads prebuilds + evidence, regenerates SHA256SUMS, creates GitHub release with release notes and evidence artifacts
7. **publish** — downloads artifacts, publishes to npm via npm Trusted Publishing (OIDC, no npm token)
   - Runs on tag pushes only when repo variable `NPM_TRUSTED_PUBLISHING` is set to `true`
   - Can also be run manually from `workflow_dispatch` with `publish_to_npm=true`

### rollback.yml (workflow_dispatch)

**RELEASE-OPS-A**: Rollback drill for known-good release restore.

- **rollback-drill** — workflow_dispatch with input `rollback_target` (e.g. `v0.1.0`)
  1. Downloads release assets from GitHub
  2. Verifies SHA256 checksums against SHA256SUMS
  3. Outputs operator runbook with pin command
- Run via **Actions → rollback → Run workflow**. See docs/OPERATIONS.md § Runbook: Rollback to known-good release.

## CI-EVIDENCE-A: Sustained evidence closure

- **Release pipeline** requires parity + interop + security gates; fails on missing evidence.
- **Evidence retention**: `parity-evidence.json` and `interop-evidence.json` attached to every release (linkable, auditable).
- **N-consecutive green**: Release checklist (docs/RELEASE_CHECKLIST.md) documents policy; recommend 1–3 green test runs before RC, 14-day sustained green before stable.
- See docs/RELEASE_CHECKLIST.md for full gates and soak requirements.

## Release flow
- Tag `vX.Y.Z`
- CI runs security, parity, interop, build; verifies required evidence
- GitHub release created with prebuilds, checksums, parity-evidence, interop-evidence
- Publish npm package with prebuilds (when NPM_TRUSTED_PUBLISHING enabled)

## Branch protection policy
- `main` must reject direct pushes and force pushes.
- `development` currently allows both regular pushes and force pushes.
- Repository ruleset payload is checked in at `.github/rulesets/main-no-push.json`.
- Apply with GitHub CLI (repo admin):
  - `gh api --method POST repos/<owner>/<repo>/rulesets --input .github/rulesets/main-no-push.json`

## npm publishing rollout (recommended)
1. First release: publish manually from local machine (`npm run release:npm`) to create package on npm.
2. Configure npm Trusted Publisher for this GitHub repository/workflow.
3. Set repository variable `NPM_TRUSTED_PUBLISHING=true`.
4. Future tags (`v*`) publish automatically from GitHub Actions with `npm publish --provenance`.

## Canary strategy
- Publish `vX.Y.Z-rc.N` for release candidates
- Run extended soak (e.g. 24h) on rc before tagging stable
- Prefer `bun add @scope/webtransport@rc` for canary testing
