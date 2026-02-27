# Compatibility and support policy

## Runtime support

- **Bun**: >= 1.3.9 (primary target in CI)
- **Node**: supported (Node-API compatible runtime)
- **Deno**: supported (npm + Node-API addon support)

## Platform matrix (shipped prebuilds)

| OS      | Arch  | Target         | Status    |
|---------|-------|----------------|-----------|
| macOS   | arm64 | darwin-arm64   | supported |
| macOS   | x64   | darwin-x64     | supported |
| Linux   | x64   | linux-x64      | supported |

## Node-API

- Addon is built with napi-rs (Node-API). Avoid unstable N-API features.
- Runtime portability is provided through Node-API loading in Bun, Node, and Deno.
