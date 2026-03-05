# @webtransport-bun/webtransport

Production-focused WebTransport for Bun, Node, and Deno: datagrams + streams, in-process server/client, backed by Rust `wtransport` via `napi-rs`.

## Install

```bash
bun add @webtransport-bun/webtransport
npm i @webtransport-bun/webtransport
pnpm add @webtransport-bun/webtransport
yarn add @webtransport-bun/webtransport
```

## Requirements

- **Runtime**: Bun >= 1.3.9, Node (Node-API compatible runtime), Deno (npm + Node-API addon support)
- **Platforms**: macOS (arm64, x64), Linux (x64), Windows (x64)

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

const session = await connect("https://127.0.0.1:4433", {
  tls: { insecureSkipVerify: true }, // dev only
});
await session.sendDatagram(new Uint8Array([1, 2, 3]));
session.close();
```

## Troubleshooting

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
