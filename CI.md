# CI.md

## CI goals
- Build + test on macOS and Linux
- Produce prebuilt binaries for napi-rs addon
- Run Bun integration tests on both
- Run Chromium interop tests at least on Linux

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
- build release binaries for supported targets
- attach to release or upload to artifact store

## Release flow
- Tag `vX.Y.Z`
- CI builds prebuilds
- Publish npm package with prebuilds
- Publish changelog entry
