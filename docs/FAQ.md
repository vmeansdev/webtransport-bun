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

## Is this production-ready?

Project is in `0.1.x` beta hardening: usable, but API/stability still being tightened.
Review `docs/TESTPLAN.md` and `docs/OPERATIONS.md` before production rollout.
