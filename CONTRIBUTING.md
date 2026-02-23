# CONTRIBUTING.md

## Development setup
1) Install Bun >= 1.3.9
2) Install Rust stable (rustup)
3) Install dependencies:
- `bun install`
- `cargo fetch`
4) Install git hooks (required for pre-commit formatting):
- `bun run setup:hooks`

## Local build
- Build native addon: `bun run build:native` (uses napi-rs CLI; produces `webtransport-native.${platform}-${arch}.node`)
- Run Bun tests:
  - `bun test`
- Run Chromium interop tests (requires Playwright browsers):
  - `cd tools/interop && bun run install:browsers` (one-time)
  - `bun run test:interop`

## Code quality
- TypeScript:
  - `bunx biome format --write .`
  - `bun run typecheck`
- Rust:
  - `cargo fmt`
  - `cargo clippy --all-targets -- -D warnings`

## Adding features
- Update docs/SPEC.md first (API/semantics)
- Add tests in `packages/webtransport/test`
- Implement in Rust + JS wrapper
- Ensure limits/budgets/rate limits remain enforced

## Reporting security issues
- If you discover a vulnerability, do not open a public issue.
- Contact maintainers privately and provide reproduction steps.
