# WebTransport WASM IWA demo

Runs a WebTransport **server and client inside the browser**, using the wasm
backend (`@webtransport-bun/webtransport/wasm`) over the Direct Sockets
`UDPSocket` API. The QUIC/TLS1.3/HTTP3/WebTransport stack is Rust compiled to
`wasm32-unknown-unknown`.

> **Cannot run outside Chromium.** Direct Sockets requires a Chromium
> **Isolated Web App (IWA)** with both the `direct-sockets` and
> `cross-origin-isolated` permissions. The compatibility manifest retains
> `direct-sockets-private` for Chromium through 150 and also declares Chrome
> 151's replacement `local-network` and `loopback-network` policies. The
> scheduled/dispatch `iwa.yml` job proves the same signed bundle with both the
> pinned Playwright Chromium and the current Chrome Beta channel.
> packages and installs this exact app; a normal page load is not accepted as
> release evidence.

## What it shows

- `createServer(...)` (wasm/IWA plug-and-play) — a WebTransport server bound to
  UDP via Direct Sockets, exercising datagrams, uni/bidi streams, RESET_STREAM,
  STOP_SENDING, peer close, and eight reconnects.
- `connectWasm(...)` — a WebTransport client over a connected `UDPSocket`.
- Certificate rotation — a stale pin must fail and the new P-256 certificate
  must complete a payload exchange.

## Build

1. Build a **web-target** wasm bundle into this example's `vendor/` (the
   default `build:wasm` script targets nodejs for tests; the browser needs
   `--target web`). The script picks a working rustc/LLVM automatically; set
   `CC_wasm32_unknown_unknown` / `AR_wasm32_unknown_unknown` to override:

   ```bash
   bun run build:wasm:web
   ```

2. Bundle the package's wasm subpath to `vendor/webtransport-wasm.js`:

   ```bash
   cd packages/webtransport && bun build src/wasm.ts \
     --outfile ../../examples/webtransport-wasm-iwa/vendor/webtransport-wasm.js \
     --target browser --format esm
   ```

3. Package the directory as an unsigned developer Web Bundle (`.wbn`) and a
   Signed Web Bundle (`.swbn`) release artifact, using
   Chromium's `wbn` + `wbn-sign` npm tooling:

   ```bash
   # Generate the Ed25519 signing key OUTSIDE the app directory. It defines
   # the app's identity/origin and must never be included in the web bundle.
   mkdir -p ../../.release-evidence/iwa
   openssl genpkey -algorithm Ed25519 -out /tmp/wt-iwa-signing.key.pem

   # Bundle this directory, then sign the identical bytes for Chromium's
   # automated developer-mode install and the auditable release artifact.
   npm i --no-save --ignore-scripts wbn@0.0.9 wbn-sign@0.3.1
   npx wbn@0.0.9 --dir . --output /tmp/webtransport-wasm-iwa.wbn --formatVersion b2
   node -e '
     const { NodeCryptoSigningStrategy, IntegrityBlockSigner, WebBundleId } = require("wbn-sign");
     const crypto = require("node:crypto"), fs = require("node:fs");
     const key = crypto.createPrivateKey(fs.readFileSync("/tmp/wt-iwa-signing.key.pem"));
     console.log("origin:", new WebBundleId(key).serializeWithIsolatedWebAppOrigin());
     new IntegrityBlockSigner(fs.readFileSync("/tmp/webtransport-wasm-iwa.wbn"),
       new WebBundleId(key).serialize(),
       [new NodeCryptoSigningStrategy(key)]
     ).sign().then(({ signedWebBundle }) =>
       fs.writeFileSync("../../.release-evidence/iwa/webtransport-wasm-iwa.swbn", signedWebBundle));
   '
   ```

   The `wbn-sign` API moves; if the snippet drifts, the authoritative flow is
   <https://chromeos.dev/en/web/isolated-web-apps> and the `wbn-sign` README.

## Run (Chromium)

1. Enable the flags in `chrome://flags`:
   - `#enable-isolated-web-apps`
   - `#enable-isolated-web-app-dev-mode`
   - `#restricted-api-origins` may be needed for Direct Sockets.
2. Install the dev IWA: `chrome://web-app-internals` → "Install from bundle".
3. Launch the app, click **Start server**, then **Run release proof**. The proof
   is successful only after all functional operations, reconnects, and
   certificate rotation pass.

## Files

- `.well-known/manifest.webmanifest` — canonical IWA manifest granting Direct
  Sockets only to its cross-origin-isolated self.
- `index.html` — demo UI.
- `app.js` — wiring against the wasm browser API.
- `vendor/` — generated wasm glue + bundled package (created by the Build steps;
  git-ignored).

## Limitations

- Multi-client: the endpoint routes per-packet by source address, so one bound
  server socket serves many concurrent clients (isolation covered by
  `crates/wasm` tests and `tools/interop/tests-wasm`).
- Cross-origin browser clients connecting to this server with
  `serverCertificateHashes` is validated separately (see `tools/interop`).
- CI uses a fresh ephemeral signing key, installs the signed `.swbn` through
  Chromium's developer-mode file switch, and binds the proof to both that
  signed artifact and its unsigned source bundle. Both bundles, the origin,
  and proof JSON are uploaded; the signing key is never bundled or uploaded.
