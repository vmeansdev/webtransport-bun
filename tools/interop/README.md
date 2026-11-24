# @webtransport-bun/interop

Chromium WebTransport interop harness. Runs Playwright tests against the addon server
to validate the interop gate: "Chromium WebTransport client can connect and exchange
datagrams + streams reliably".

## Setup

```bash
bun run build:native                # from the repo root: the server is the addon
cd tools/interop
bun install
bun run install:browsers            # one-time: Playwright's Chromium
bun run prepare:interop             # writes the ECDSA test certs to certs/
```

Run `prepare:interop` before Playwright: `playwright.config.ts` reads the cert
when it loads, to pin its SPKI hash in Chromium's flags, so the cert must exist
before the run starts. CI runs the same four steps.

## Run

From the repo root:

```bash
bun run test:interop        # cold loop: the suite 10 times, each with fresh ports and certs
bun run test:interop:once   # the suite once
```

`WEBTRANSPORT_COLD_LOOP_COUNT=<n>` changes the loop count. From this directory,
`bun run test` (an alias of `test:once`) runs the suite once.

Other configurations in this directory:

| Command (from `tools/interop`) | Config | Suite |
|---|---|---|
| `bunx playwright test -c playwright.wasm.config.ts` (also `bun run test:interop:wasm-server` from the root) | `playwright.wasm.config.ts` | `tests-wasm/wasm-server.spec.ts`: Chromium's native client against the wasm server |
| `bun run test:qpack` | `playwright.qpack.config.ts` | `tests-qpack/qpack.pw.ts`: dynamic QPACK against Chromium |
| `bunx playwright test -c playwright.fault.config.ts` | `playwright.fault.config.ts` | `tests/fault-matrix.spec.ts`: the seeded UDP fault matrix (CI `fault-matrix` job) |
| `bunx playwright test -c playwright.security.config.ts` | `playwright.security.config.ts` | `tests/compose-dashboard-security.pw.ts` |

## Tests

The default config runs every `tests/*.pw.ts`:

- `echo.pw.ts` — bidi stream, datagram and uni stream echo
- `interop-expanded.pw.ts` (P3.3) — reconnect storms, mixed stream/datagram concurrency, close code propagation, stream reset (`writable.abort`)
- `edge-cases.pw.ts` — close code/reason propagation in every direction, large bidi payloads, idle timeout
- `chromium-client.pw.ts` — connect/`ready`, binary datagram round trips, multi-chunk bidi streams
- `cert-hash.pw.ts` — `serverCertificateHashes` pinning
- `h7-datagram-batch.pw.ts` — batched datagram delivery (H7 evidence; `docs/TESTPLAN.md`)
- `compose-dashboard-security.pw.ts` — the compose demo dashboard renders peer-controlled data as inert text

`tests/*.test.ts` (`security-evidence`, `udp-fault-proxy`,
`compose-dashboard-security`) are Bun tests for the evidence tooling and the
fault proxy: `bun test tools/interop/tests/<file>` from the repo root.

## Server

The Playwright webServer starts the addon server (`addon-server.ts`) automatically.
It listens on QUIC port 4433 and exposes an HTTP health endpoint on 127.0.0.1:4434
for readiness probing (`WEBTRANSPORT_INTEROP_QUIC_PORT` /
`WEBTRANSPORT_INTEROP_HEALTH_PORT` override them; the cold loop sets both).

## Per-release evidence

Set `INTEROP_EVIDENCE=1` to emit `interop-evidence.json` (Playwright JSON reporter). CI release workflow runs this and attaches the file to the GitHub release.

Interop web-server processes receive an explicit allowlist of non-sensitive
runtime settings only: idle timeout, QPACK capacity, and localhost host/port
overrides. The harness invokes the current Bun executable directly and resolves
OpenSSL from deterministic locations, so `PATH` and the developer shell
environment are never serialized into release evidence. Release evidence is
validated before upload; validation rejects inherited environment keys,
credential-shaped values, and absolute host paths in the web-server environment.

## Local vs CI

Interop tests may fail locally with "Opening handshake failed" in some environments (e.g. Cursor
sandbox, macOS firewall, or QUIC being blocked). The **acceptance criterion is CI on Linux**.
Run `bun run test` in this directory; CI runs the same suite in the `test`
job on `ubuntu-24.04`, `macos-latest` and `windows-latest`.
