# CI.md

## CI goals
- Build + test on macOS and Linux
- Produce prebuilt binaries for napi-rs addon
- Run Bun integration tests on both
- Run Chromium interop tests at least on Linux

## Supported targets (shipped prebuilds)
| Target           | Runner         | Architecture |
|------------------|----------------|--------------|
| `darwin-arm64`   | `macos-latest` | aarch64      |
| `linux-x64`     | `ubuntu-latest`| x86_64       |

## Recommended GitHub Actions jobs
1) lint
- bun lint/tsc
- cargo fmt
- cargo clippy (deny warnings)

2) test-linux
- build native addon
- bun test
- interop tests (Playwright Chromium)
- upload artifacts

3) test-macos
- build native addon
- bun test
- (interop optional on macOS if too heavy)

4) prebuild
- build release binaries for each target in the matrix above (`darwin-arm64`, `linux-x64`)
- attach to release or upload to artifact store
- verify checksums for each artifact

## Release flow
- Tag `vX.Y.Z`
- CI builds prebuilds
- Publish npm package with prebuilds
- Publish changelog entry

## Canary strategy
- Publish `vX.Y.Z-rc.N` for release candidates
- Run extended soak (e.g. 24h) on rc before tagging stable
- Prefer `bun add @scope/webtransport@rc` for canary testing
