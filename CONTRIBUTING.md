# CONTRIBUTING.md

## Development setup
1) Install Bun >= 1.3.9
2) Install Rust stable (rustup)
3) Install dependencies:
- `bun install`
- `cargo fetch`

## Local build
- Build native addon:
  - `cargo build -p native`
- Run Bun tests:
  - `bun test`

## Code quality
- TypeScript:
  - `bun run lint`
  - `bun run typecheck`
- Rust:
  - `cargo fmt`
  - `cargo clippy --all-targets -- -D warnings`

## Adding features
- Update SPEC.md first (API/semantics)
- Add tests in `packages/webtransport/test`
- Implement in Rust + JS wrapper
- Ensure limits/budgets/rate limits remain enforced

## Reporting security issues
- If you discover a vulnerability, do not open a public issue.
- Contact maintainers privately and provide reproduction steps.
