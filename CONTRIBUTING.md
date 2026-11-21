# CONTRIBUTING.md

## Development setup
1) Install Bun >= 1.3.14
2) Install Rust stable (rustup)
3) Install dependencies:
- `bun install`
- `cargo fetch`
4) Install git hooks (required for pre-commit formatting):
- `bun run setup:hooks`
  - Hook runs `cargo fmt` + `cargo clippy --workspace -- -D clippy::all` on staged Rust files and Biome format on staged TS/JS files.

## Local build
- Build native addon: `bun run build:native` (uses napi-rs CLI; produces `webtransport-native.${platform}-${arch}.node`)
- Build the WASM engine: `bun run build:wasm:dist` (needs `wasm-bindgen-cli` at the version in `.github/release-toolchain.json` and an LLVM `clang` + `llvm-ar` that target wasm32; on macOS `brew install llvm` or any `llvm@NN` is found automatically, elsewhere set `CC_wasm32_unknown_unknown` / `AR_wasm32_unknown_unknown`). The build fails if ring's C code did not link.
- Run Bun tests:
  - `bun run test`
- Run Chromium interop tests (requires Playwright browsers):
  - `cd tools/interop && bun run install:browsers` (one-time)
  - `bun run test:interop`

## Code quality
- TypeScript:
  - `bunx --bun biome format --write .` (the root `biome.json` limits this to project sources: build output, `node_modules`, scratch/evidence directories and tool-written JSON data are excluded)
  - `bunx --bun biome check <changed files>`
  - `bun run typecheck`
- Rust:
  - `cargo fmt`
  - `cargo clippy --all-targets -- -D warnings`

## Branches
- Branch off `development` (`feature/*`, `fix/*`, `chore/*`) and open a pull request back into `development`; it is the default branch. Direct pushes to `development` and `main` are rejected, and a pull request merges once the required checks are green.
- `main` only receives release merges; `canary` and `nightly` are moved by CI. See docs/BRANCHING.md.

## Adding features
- Update docs/SPEC.md first (API/semantics)
- Add tests in `packages/webtransport/test`
- Implement in Rust + JS wrapper
- Ensure limits/budgets/rate limits remain enforced

## Reporting security issues
- If you discover a vulnerability, do not open a public issue.
- Contact maintainers privately and provide reproduction steps.
