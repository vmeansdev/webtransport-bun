# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.4](https://github.com/vmeansdev/webtransport-bun/compare/v0.2.3...v0.2.4) - 2026-03-05

### Fixed

- `waitUntilAvailable` server-side stream opens now use native capacity signaling (`waitBidiCapacity`/`waitUniCapacity`) instead of JS-only polling, reducing wake latency and avoiding unnecessary retry loops under stream-pressure.
- Native server session limits are now scoped per session/server instance, fixing cross-server limit leakage where the first server's limits could affect subsequent servers in the same process.

### Added

- Regression coverage for native `waitUntilAvailable` signaling paths on server sessions.
- Multi-server regression coverage that verifies per-server datagram limits remain isolated.

### Changed

- Documentation consistency refresh for `0.2.4` status and CI gate descriptions.

## [0.2.3](https://github.com/vmeansdev/webtransport-bun/compare/v0.2.2...v0.2.3) - 2026-03-03

### Fixed

- Eliminated a server-side close propagation race that could surface client-initiated closes as `code: 0, reason: ""` instead of the client-provided close info.
- Hardened native session and stream paths to return explicit, stable `E_*` diagnostics across additional error branches.
- Improved TypeScript-side propagation of non-close errors vs session-close EOF semantics for incoming iterators and stream wrappers.

### Added

- Chromium interop regression coverage that asserts browser-initiated close `code`/`reason` is observable on the server side.
- Additional regression coverage for reset/stopSending-related error mapping and CA PEM TLS validation edge cases.
- Internal tests for native addon loader diagnostics and connect-time race handling.
- Echo playground close-code/reason demo controls and server-side close logging showcase.

### Changed

- NPM/package docs and metadata now consistently describe runtime support as Bun + Node + Deno.
- Release/publish guidance updated with cross-runtime install/import smoke checks and updated `0.2.3` examples.

## [0.2.2](https://github.com/vmeansdev/webtransport-bun/compare/v0.2.1...v0.2.2) - 2026-03-02

### Fixed

- `session.closed` now consistently propagates close `code` and `reason` from client-initiated close events to both client and server session surfaces.
- Close info mapping now normalizes unset values to deterministic defaults (`code: 0`, `reason: ""`) for stable consumer behavior.

### Added

- Regression coverage for client-initiated close propagation to `serverSession.closed` with bounded-time assertions.

## [0.2.1](https://github.com/vmeansdev/webtransport-bun/compare/v0.2.0...v0.2.1) - 2026-03-01

### Changed

- Release and publish workflows now build package `dist/` explicitly before tarball verification and npm publish, preventing missing runtime artifacts when scripts are ignored during publish.
- GitHub release artifacts now include a packaged npm `.tgz` in addition to native prebuilds and evidence files.
- README install guidance now documents npm package contents (`dist/`, `prebuilds/`) and clarifies that GitHub source archives are not equivalent to published package outputs.

### Documentation

- CI and release docs now include branch protection policy details and checked-in ruleset payload guidance for protecting `main` from direct pushes.

## [0.2.0](https://github.com/vmeansdev/webtransport-bun/compare/v0.1.0...v0.2.0) - 2026-02-25

### Added

- Browser-shaped `WebTransport` facade parity coverage and option support, including `congestionControl`, `datagramsReadableType`, `supportsReliableOnly`, and `getStats()` mapping.
- Datagram facade enhancements: duplex shape (`readable`/`writable`), `createWritable(...)`, `maxDatagramSize`, and BYOB-readable support for `datagramsReadableType: "bytes"`.
- Stream option acceptance and deterministic scheduling for `sendOrder`/`sendGroup` on datagram and stream write paths.
- Endpoint pooling behavior for compatible client connects (`allowPooling`) with explicit compatibility-key semantics.
- Runtime error-path coverage for `E_RATE_LIMITED`, `E_SESSION_IDLE_TIMEOUT`, and `E_STOP_SENDING`.
- Observability additions: latency histograms, Prometheus SLO alert surfaces, and backpressure-timeout counters.
- CI and release hardening workflows, including dedicated parity CI, rollback drill safeguards, and expanded interop evidence collection.

### Changed

- W3C parity lifecycle semantics to align closure and termination behavior for facade streams and iterators.
- Server incoming stream surface for tighter W3C alignment.
- TLS handling for deterministic client handshake behavior (SNI normalization and CA PEM validation).
- Test strategy to enforce bounded waits and reduce nondeterministic hangs in CI.

### Fixed

- TypeScript facade stream typings and DOM-specific typecheck issues in CI.
- Interop script execution for Playwright-based runs.
- Metrics timing and race-related CI flakes in parity/backpressure/fairness/drain/adversarial suites.
- Client connect path clippy issues and assorted CI regressions.
- Server startup now fails fast during `createServer(...)` when endpoint initialization/bind fails, returning `E_INTERNAL` immediately instead of surfacing as downstream timeout behavior.
- `maxSessions` overflow handling now rejects excess connects with stable `E_LIMIT_EXCEEDED` signaling, making limit-boundary behavior deterministic for clients and CI.
- Test harness port allocation is now collision-resistant per process/range to reduce nondeterministic bind flakes in parallel CI runs.

### Documentation

- Refreshed and expanded `README.md`, `docs/SPEC.md`, `docs/PARITY_MATRIX.md`, `docs/TESTPLAN.md`, `docs/CI.md`, and related operational docs to reflect parity and hardening status.

## [0.1.0](https://github.com/vmeansdev/webtransport-bun/releases/tag/v0.1.0) - 2026-02-04

### Added

- Initial public beta release of `@webtransport-bun/webtransport`.
- Bun in-process WebTransport server/client powered by Rust `wtransport` via `napi-rs`.
- Datagram and stream APIs with production-focused limits, abuse controls, and CI coverage.
