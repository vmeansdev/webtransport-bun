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
| Windows | x64   | win32-x64-msvc | supported |

## Node-API

- Addon is built with napi-rs (Node-API). Avoid unstable N-API features.
- Runtime portability is provided through Node-API loading in Bun, Node, and Deno.

## WASM backend (`@webtransport-bun/webtransport/wasm`)

The wasm backend (quinn-proto + rustls compiled to `wasm32-unknown-unknown`)
has its own environment matrix, orthogonal to the prebuild table above:

| Scenario | Environment | Status |
|----------|-------------|--------|
| Server inside the browser | Chromium Isolated Web App with `direct-sockets` permission (behind `chrome://flags/#enable-isolated-web-apps` + `#enable-isolated-web-app-dev-mode`, or enterprise policy) | supported (manual verification; not CI-runnable — see `tools/interop/WASM_INTEROP.md`) |
| Server inside the browser | Normal web page, Firefox, Safari | **not possible** — Direct Sockets is IWA/Chromium-only |
| Server in Bun (wasm instead of native addon) | `Bun.udpSocket` transport | supported (`wasm-bun-udp` test) |
| Client (wasm) → native server | Bun/Node host, real UDP | supported (`wasm-native-interop` test) |
| Chrome's native `WebTransport` client → wasm server | any Chromium | supported (manual harness) |
| Custom transport | anything implementing `UdpTransport` | supported — the core is sans-IO |

Constraints that apply regardless of environment:

- **Certificates**: browser clients pin via `serverCertificateHashes`, which
  requires ECDSA P-256 and validity ≤ 14 days. `generateCert` enforces both.
  Certificate rotation (and hash redistribution to clients) is the consumer's
  responsibility.
- **Host glue**: the consumer supplies packet I/O and timer driving; shipped
  adapters cover Direct Sockets, Bun UDP, and in-memory testing.
- **API surface**: no `u64`/`BigInt` crosses the wasm boundary (handles are
  `u32`, sizes are `f64`), so no BigInt polyfill or serialization caveats.
- **Unsupported options fail loudly**: `allowPooling` and other
  native-/browser-only options are rejected, never silently ignored
  (see `docs/PARITY_MATRIX.md`).
- **IWA packaging**: signed web bundles, dev-mode install via
  `chrome://web-app-internals` — see `examples/webtransport-wasm-iwa/README.md`.
  The IWA install/signing flow is manual and Chromium-version-sensitive;
  expect flag names and policies to move while IWAs remain behind flags.
