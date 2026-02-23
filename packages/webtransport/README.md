# @webtransport-bun/webtransport

Production-focused WebTransport for Bun: datagrams + streams, in-process server/client, backed by Rust `wtransport` via `napi-rs`.

## Install

```bash
bun add @webtransport-bun/webtransport
```

## Requirements

- **Runtime**: Bun >= 1.3.9 (required; this package does not run on Node.js)
- **Platforms**: macOS (arm64, x64), Linux (x64)

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

const session = await connect("https://127.0.0.1:4433", {
  tls: { insecureSkipVerify: true }, // dev only
});
await session.sendDatagram(new Uint8Array([1, 2, 3]));
session.close();
```

## Troubleshooting

### "Native addon not loaded"

Prebuilt binaries are included for darwin-arm64, darwin-x64, and linux-x64. If you see this error:

- Ensure you are on a supported platform (macOS or Linux, arm64 or x64).
- Reinstall: `rm -rf node_modules && bun install`
- For development from source, run `bun run build:native` from the repo root.

### "requires Bun"

This package runs only on Bun. Use `bun add` and run your app with `bun run`.

## Docs

Full documentation: [github.com/vmeansdev/webtransport-bun](https://github.com/vmeansdev/webtransport-bun)
