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
| `linux-x64`     | `ubuntu-latest`| x86_64       |

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
10. Interop — Playwright Chromium (`bun run playwright test`)
11. Smoke test — `bun add` from built package

**soak** job — `ubuntu-latest`, 2-minute soak (`SOAK_DURATION=120`)

### release.yml (tag push `v*`, workflow_dispatch)

1. **build** — matrix: `{linux-x64, darwin-arm64}` — builds native addon, generates prebuilds + SHA256 checksums, uploads artifacts
2. **release** — downloads artifacts, creates GitHub release with release notes
3. **publish** — downloads artifacts, publishes to npm

## Release flow
- Tag `vX.Y.Z`
- CI builds prebuilds for all targets
- Publish npm package with prebuilds
- GitHub release created with checksums

## Canary strategy
- Publish `vX.Y.Z-rc.N` for release candidates
- Run extended soak (e.g. 24h) on rc before tagging stable
- Prefer `bun add @scope/webtransport@rc` for canary testing
