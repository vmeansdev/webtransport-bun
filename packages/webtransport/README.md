# @webtransport-bun/webtransport

Production-focused candidate WebTransport for Bun, Node, and Deno: datagrams +
streams, in-process server/client, backed by Rust `wtransport` via `napi-rs`.

Canonical release truth: `../../docs/release-status.json`. This README describes
the current candidate surface, not a stable/GA promise.

## Install

```bash
bun add @webtransport-bun/webtransport
npm i @webtransport-bun/webtransport
pnpm add @webtransport-bun/webtransport
yarn add @webtransport-bun/webtransport
```

## Requirements

- **Configured runtime targets**: Bun >= 1.3.9, Node (Node-API compatible
  runtime), Deno (npm + Node-API addon support)
- **Configured platform targets**: macOS (arm64, x64), Linux (x64), Windows
  (x64)

These are candidate targets, not current support claims. Support is claimed only
after the corresponding commit-bound tuples pass in
`../../docs/release-status.json`.

## Quick Start

```ts
import { createServer, connect } from "@webtransport-bun/webtransport";

const server = createServer({
  port: 4433,
  tls: { certPem: "...", keyPem: "..." },
  onSession: async (session) => {
    for await (const d of session.incomingDatagrams()) {
      await session.sendDatagram(d);
    }
  },
});

// Hot-swap TLS leaf cert/key material without dropping existing sessions.
// New handshakes immediately use the new certificate.
// Transport config and bind-address changes still require rebuilding the server.
await server.updateCert({ certPem: "...next cert...", keyPem: "...next key..." });

// Or atomically replace the full TLS configuration, including hostname-specific SNI certs.
await server.updateTls({
  certPem: "...default cert...",
  keyPem: "...default key...",
  sni: [
    {
      serverName: "api.example.test",
      certPem: "...api cert...",
      keyPem: "...api key...",
    },
  ],
  unknownSniPolicy: "reject",
});

// Or manage the hostname map incrementally.
await server.upsertSniCert({
  serverName: "admin.example.test",
  certPem: "...admin cert...",
  keyPem: "...admin key...",
});
await server.setUnknownSniPolicy("default");
console.log(server.tlsSnapshot());

const session = await connect("https://127.0.0.1:4433", {
  tls: { insecureSkipVerify: true }, // dev only
});
await session.sendDatagram(new Uint8Array([1, 2, 3]));
session.close();
```

## WASM / browser-direct-sockets limits

The `/wasm` entrypoint accepts the same normalized resource-governor inputs on
both client and server helpers. Validation runs before endpoint allocation or
UDP bind, so invalid budgets fail fast.

Canonical release truth: `../../docs/release-status.json`. Treat `/wasm` as a
candidate surface until the manifest flips to ready.

```ts
import {
  connectWasm,
  createWasmServer,
  DEFAULT_WASM_LIMITS,
} from "@webtransport-bun/webtransport/wasm";

const server = createWasmServer(wasm, udp, onSession, "0.0.0.0:4433", "127.0.0.1:0", {
  limits: {
    maxDatagramSize: 1024,
    maxQueuedBytesPerSession: 512 * 1024,
  },
  rateLimits: {
    handshakesPerSec: 10,
    handshakesBurst: 20,
  },
});

const { session } = await connectWasm(
  wasm,
  udp,
  "localhost",
  "127.0.0.1:0",
  "127.0.0.1:4433",
  {
    certHashBase64: "<server hash>",
    limits: { maxDatagramSize: DEFAULT_WASM_LIMITS.maxDatagramSize },
  },
);
```

## Troubleshooting

## TLS hot-swap and SNI

- `updateCert()` changes only the default server certificate/key.
- `updateTls()` atomically replaces the default certificate/key, full SNI certificate map, and unknown-SNI policy.
- `replaceSniCerts()` swaps the full SNI certificate map while preserving the default certificate/key and current unknown-SNI policy.
- `upsertSniCert()` and `removeSniCert()` manage individual hostname mappings in place.
- `setUnknownSniPolicy()` changes only unknown-SNI handling in place.
- `tlsSnapshot()` returns sorted active SNI hostnames in canonical ASCII form plus the current unknown-SNI policy.
- Wildcards are supported only as left-most single-label entries such as `*.example.com`; exact hostnames win over wildcards.
- SNI hostnames are IDNA-normalized to canonical ASCII, so Unicode names are stored and matched by their punycode form.
- Review configured Unicode hostnames for homograph/confusable risk; IDNA normalization makes names protocol-correct, not human-safe.
- When `tls.sni` is configured, `unknownSniPolicy` defaults to `"reject"` for unknown hostnames.
- Clients that do not send SNI still receive the default certificate.
- `tls.sni` and `unknownSniPolicy` require a non-empty default server certificate/key.
- Bind-address or transport-config changes still require rebuilding/restarting the server.

### "Native addon not loaded"

Published npm packages and GitHub release artifacts include prebuilt binaries for darwin-arm64, darwin-x64, linux-x64, and win32-x64-msvc. A source checkout may only have whatever prebuilds were generated locally. If you see this error:

- Ensure you are on a supported platform (macOS/Linux/Windows on supported arch).
- Reinstall dependencies and rebuild native artifacts (`npm i` / `pnpm i` / `yarn` / `bun install`).
- For development from source, run `bun run build:native` from the repo root.

### Runtime compatibility mismatch

This package supports Bun, Node, and Deno on supported OS/arch targets. If import fails:

- Confirm your runtime supports Node-API addon loading.
- Confirm your platform matches published prebuilds (macOS arm64/x64, Linux x64, Windows x64).
- If needed, build native locally from source (`bun run build:native` in this repo).

## Docs

Full documentation: [github.com/vmeansdev/webtransport-bun](https://github.com/vmeansdev/webtransport-bun)
