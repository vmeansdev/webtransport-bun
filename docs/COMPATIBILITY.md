# Compatibility and support policy

## Bun version

- **Policy**: Bun >= 1.3.9
- Test against at least 2–3 Bun versions in CI (e.g. 1.3.9, 1.4.x, latest).

## Platform matrix (shipped prebuilds)

| OS      | Arch  | Target         | Status    |
|---------|-------|----------------|-----------|
| macOS   | arm64 | darwin-arm64   | supported |
| Linux   | x64   | linux-x64      | supported |

## Node-API

- Addon is built with napi-rs for Bun. Avoid unstable N-API features.
- **Bun-specific**: Primary target; tested on Bun.
- **Node**: Addon may load on Node if Node-API ABI matches; not tested or guaranteed.
