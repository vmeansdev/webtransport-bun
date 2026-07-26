# Compatibility and support policy

The matrices below are the configured 1.0 release targets. They are not current
support claims while `docs/release-status.json` has no passing `support.tested`
tuples. A target becomes supported only when that manifest records its
commit-bound passing evidence.

## Runtime targets

- **Bun**: >= 1.3.9 (primary target in CI; evidence pending)
- **Node**: Node-API compatible runtime (evidence pending)
- **Deno**: npm + Node-API addon support target (evidence pending)

## Platform matrix (shipped prebuilds)

| OS      | Arch  | Target         | Status    |
|---------|-------|----------------|-----------|
| macOS   | arm64 | darwin-arm64   | candidate; evidence pending |
| macOS   | x64   | darwin-x64     | candidate; evidence pending |
| Linux   | x64   | linux-x64      | candidate; evidence pending |
| Windows | x64   | win32-x64-msvc | candidate; evidence pending |

## Node-API

- Addon is built with napi-rs (Node-API). Avoid unstable N-API features.
- Runtime portability is provided through Node-API loading in Bun, Node, and Deno.

## WASM backend (`@webtransport-bun/webtransport/wasm`)

The wasm backend (quinn-proto + rustls compiled to `wasm32-unknown-unknown`)
has its own environment matrix, orthogonal to the prebuild table above.

**CI scope:** the wasm Bun suite (`wasm-*.test.ts`, `webtransport-like.test.ts`)
is exercised on the ubuntu `wasm` workflow job only. The multi-OS/bun matrix
excludes those files by design so missing `crates/wasm/pkg` cannot skip-green.
See `docs/release-status.json` → `support.scopeLimits`.

| Scenario | Environment | Status |
|----------|-------------|--------|
| Server inside the browser | Chromium Isolated Web App with `direct-sockets` and `cross-origin-isolated` permissions | supported only when the scheduled/dispatch `iwa.yml` gate produces passing commit-bound evidence |
| Server inside the browser | Normal web page, Firefox, Safari | **not possible** — Direct Sockets is IWA/Chromium-only |
| Server in Bun (wasm instead of native addon) | `Bun.udpSocket` transport | implemented and locally tested; release evidence pending |
| Client (wasm) → native server | Bun/Node host, real UDP | implemented and locally tested; release evidence pending |
| Chrome's native `WebTransport` client → wasm server | configured Chromium lanes | automated locally and in `iwa.yml` / `playwright.wasm.config.ts`; release evidence pending |
| Custom transport | anything implementing `UdpTransport` | implemented — the core is sans-IO; consumer-specific support is not claimed |

Constraints that apply regardless of environment:

- **Certificates**: browser clients pin via `serverCertificateHashes`, which
  requires ECDSA P-256 and validity ≤ 14 days. `generateCert` enforces both.
  Certificate rotation (and hash redistribution to clients) is the consumer's
  responsibility. You can use the `WasmCertRotator` helper class to automatically 
  generate new certificates ahead of expiry so your server can update its endpoints
  without downtime.
- **Host glue**: the consumer supplies packet I/O and timer driving; shipped
  adapters cover Direct Sockets, Bun UDP, and in-memory testing.
- **API surface**: no `u64`/`BigInt` crosses the wasm boundary (handles are
  `u32`, sizes are `f64`), so no BigInt polyfill or serialization caveats.
- **Unsupported options fail loudly**: `allowPooling` and other
  native-/browser-only options are rejected, never silently ignored
  (see `docs/PARITY_MATRIX.md`).
- **IWA packaging**: the canonical `/.well-known/manifest.webmanifest`,
  signed Web Bundle installation via Chromium's developer-mode
  `--install-isolated-web-app-from-file` switch, unsigned source bundle, and
  Direct Sockets execution are exercised by `.github/workflows/iwa.yml`. The
  job fails unless the page proves the exact `browser-iwa-direct-sockets`
  identity and writes evidence bound to the candidate commit plus both the
  signed and unsigned bundle digests. Manual installation remains available
  for development; see `examples/webtransport-wasm-iwa/README.md`.
