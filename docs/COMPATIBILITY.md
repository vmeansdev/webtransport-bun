# Compatibility and support policy

## Bun version

- **Policy**: Bun >= 1.3.9
- Test against at least 2–3 Bun versions in CI (e.g. 1.3.9, 1.4.x, latest).

## Platform matrix

| OS      | Arch  | Status   |
|---------|-------|----------|
| macOS   | arm64 | supported |
| macOS   | x64   | supported |
| Linux   | x64   | supported |
| Linux   | arm64 | supported |

## Node-API

- Addon is built with napi-rs for Bun. Avoid unstable N-API features.
- **Bun-specific**: Primary target; tested on Bun.
- **Node**: Addon may load on Node if Node-API ABI matches; not tested or guaranteed.
