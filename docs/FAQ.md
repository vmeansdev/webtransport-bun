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
`examples/webtransport-wasm-iwa/README.md`. Inside an IWA you can use
`await createServer({ port, tls, onSession })` from
`@webtransport-bun/webtransport/wasm` (also exported as `createIwaServer`).
That is not the root package's native sync `createServer`. Note this gates
only *hosting* a server; connecting to one works from any standard
WebTransport client.

## Clients suddenly fail to connect to my wasm server after ~2 weeks

The pinned certificate expired. `serverCertificateHashes` caps validity at
14 days (and requires ECDSA P-256) — `generateCert` clamps to that window.
Generate a new cert and distribute the new hash to clients; pinning means a
new cert always implies a client-side update.

## Do I need to provide sockets/timers to the wasm backend?

Sockets, yes; timers, no. The core is sans-IO by design, so something has to
move UDP packets in and out: `DirectSocketsUdpTransport` inside a Chromium IWA,
`InMemoryRelay` in tests, or a `UdpTransport` you write (the package ships no
Bun adapter; `docs/GETTING_STARTED.md` has a 20-line `Bun.udpSocket` one).
Timers are driven for you by the wasm transport manager that `serveOverUdp`,
`connectWasm` and `/wasm` `createServer` create, so a custom transport only
has to deliver packets to `onPacket` and send what it is given.

## Does the wasm API return BigInt?

For session ids, yes. Connection and stream handles are `u32` numbers and sizes
are `f64`, but WebTransport session ids are `u64`, surfaced as `bigint`
(`WasmSession.sessionId`, the `session_id` of wasm events, and the
session-scoped manager APIs). `JSON.stringify` throws on a `bigint`, so convert
it (`String(id)`) before serializing.

## Is this production-ready?

Not yet. On npm, `latest` is still the pre-1.0 `0.3.0` (root entrypoint
only); the 1.0 surface is installable only as
`@webtransport-bun/webtransport@canary` or `@nightly`. No 1.0 release
candidate is on npm (the `v1.0.0-rc.N` releases are git tags and GitHub
pre-releases only), no 1.0 date is set, and both the native and WASM surfaces
remain candidates. Local implementation gates have useful
coverage, but the immutable multi-platform/runtime matrix, release coverage and
fuzz evidence, >=10k diverse-source scale proof, 24-hour and 72-hour soaks, and
the zero-P0-P4 independent-review/no-change confirmation are still required.
`docs/release-status.json` is the machine-readable authority; see
`docs/RELEASE_1.0_STATUS.md` for the human summary.

Review `docs/TESTPLAN.md`, `docs/CI.md`, and `docs/OPERATIONS.md` before any
production rollout.
