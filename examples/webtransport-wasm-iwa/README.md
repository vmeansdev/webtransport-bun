# WebTransport WASM IWA demo

Runs a WebTransport **server and client inside the browser**, using the wasm
backend (`@webtransport-bun/webtransport/wasm`) over the Direct Sockets
`UDPSocket` API. The QUIC/TLS1.3/HTTP3/WebTransport stack is Rust compiled to
`wasm32-unknown-unknown`.

> **Cannot run outside Chromium.** Direct Sockets requires a Chromium
> **Isolated Web App (IWA)** with the `direct-sockets` permission, behind a flag.
> This demo is therefore not exercised by CI; it is a faithful reference.

## What it shows

- `serveOverUdp(...)` — a WebTransport server bound to a UDP port, echoing
  datagrams and bidi streams, returning the `serverCertificateHashes` value.
- `connectWasm(...)` — a WebTransport client over a connected `UDPSocket`.
- `generateCert` / `serverCertificateHashes` — short-lived P-256 cert + the hash
  a native browser client would pin.

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

3. Package the directory as a Signed Web Bundle (`.swbn`) for an IWA, using
   Chromium's `wbn` + `wbn-sign` npm tooling:

   ```bash
   # One-time: generate an Ed25519 signing key (KEEP IT PRIVATE — it defines
   # the app's identity/origin).
   openssl genpkey -algorithm Ed25519 -out iwa-signing.key.pem

   # Bundle + sign this directory into an installable .swbn.
   npm i -D wbn wbn-sign
   npx wbn --dir . --output webtransport-wasm-iwa.wbn --formatVersion b2
   node -e '
     const { NodeCryptoSigningStrategy, IntegrityBlockSigner, WebBundleId } = require("wbn-sign");
     const crypto = require("node:crypto"), fs = require("node:fs");
     const key = crypto.createPrivateKey(fs.readFileSync("iwa-signing.key.pem"));
     console.log("origin:", new WebBundleId(key).serializeWithIsolatedWebAppOrigin());
     new IntegrityBlockSigner(fs.readFileSync("webtransport-wasm-iwa.wbn"),
       new WebBundleId(key).serialize(),
       [new NodeCryptoSigningStrategy(key)]
     ).sign().then(({ signedWebBundle }) =>
       fs.writeFileSync("webtransport-wasm-iwa.swbn", signedWebBundle));
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
3. Launch the app, click **Start server**, then **Connect client + echo**.

## Files

- `manifest.webmanifest` — IWA manifest declaring the `direct-sockets` permission.
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
- The IWA install/signing flow itself is manual (Chromium flags + dev-mode
  install) and not exercised by CI.
