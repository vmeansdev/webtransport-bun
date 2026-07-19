# FAQ / Troubleshooting

## Browser connect fails with certificate errors

For local development, self-signed certs can fail browser validation.
Use certificate pinning (`serverCertificateHashes`) or Chromium flags in examples.

## Why does `https://127.0.0.1:4433` fail in browser navigation?

That endpoint is WebTransport over QUIC (UDP), not a regular HTTP page.
Open the example HTTP UI (`http://127.0.0.1:3000`) instead.

## Native addon not loaded

Ensure prebuild/native binary exists for your platform:

```bash
bun run build:native
```

If running from source, verify expected `.node` files in `crates/native/` or `packages/webtransport/prebuilds/`.

## Docker compose pulls missing image

Use compose setup that includes local `build` sections for all services and `pull_policy: never`.

## Session closed logs appear as errors

Close events can terminate loops normally. Treat expected close paths as info/noise, not hard errors.

## The wasm server doesn't start in my browser

Direct Sockets `UDPSocket` only exists inside a Chromium **Isolated Web App**
with the `direct-sockets` permission — not on normal pages, not in Firefox or
Safari. Enable `chrome://flags/#enable-isolated-web-apps` and
`#enable-isolated-web-app-dev-mode`, then install the bundle via
`chrome://web-app-internals`. Full walkthrough:
`examples/webtransport-wasm-iwa/README.md`. Note this gates only *hosting* a
server; connecting to one works from any standard WebTransport client.

## Clients suddenly fail to connect to my wasm server after ~2 weeks

The pinned certificate expired. `serverCertificateHashes` caps validity at
14 days (and requires ECDSA P-256) — `generateCert` clamps to that window.
Generate a new cert and distribute the new hash to clients; pinning means a
new cert always implies a client-side update.

## Do I need to provide sockets/timers to the wasm backend?

Yes if you write your own transport — the core is sans-IO by design. The
shipped adapters (`DirectSocketsUdpTransport`, Bun UDP, `InMemoryRelay`)
handle packet pumping and timeout driving; a custom `UdpTransport` must do
both, or connections will stall on retransmits and idle timeouts.

## Does the wasm API return BigInt?

No. The wasm boundary uses `u32` handles and `f64` numbers only, so there are
no BigInt interop or JSON-serialization surprises.

## Is this production-ready?

Project is at `1.0.0-rc.1`: a release candidate for the native surface with zero known P0/P1/P2 defects (multi-pass adversarial review), while the full production-scale evidence (remote CI, multi-day soak, scale load) is gathered before a stable `1.0.0` tag. See `docs/RELEASE_1.0_STATUS.md`.
Review `docs/TESTPLAN.md`, `docs/CI.md`, and `docs/OPERATIONS.md` before production rollout.
