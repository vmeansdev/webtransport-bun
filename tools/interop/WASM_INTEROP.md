# WASM backend interop

Interop status for the browser/WASM WebTransport backend (`crates/wasm` +
`@webtransport-bun/webtransport/wasm`). The wasm stack is sans-IO QUIC
(quinn-proto) + a hand-rolled minimal HTTP/3 + WebTransport layer, driven over a
`UdpTransport` (in-memory relay, Bun UDP, or Direct Sockets).

## Verified in CI (`bun run test:wasm` + interop tests)

| Scenario | Transport | Test |
|---|---|---|
| wasm client ↔ wasm server | in-memory relay | `wasm-datagram-echo`, `wasm-stream-echo`, `wasm-facade` |
| wasm client ↔ wasm server | real localhost UDP (Bun) | `wasm-bun-udp` |
| 2 wasm clients ↔ 1 wasm server (routing isolation) | in-memory relay + real UDP | `wasm-datagram-echo`, `wasm-bun-udp` |
| **wasm client ↔ native Rust server** (wtransport) | real localhost UDP (Bun) | `wasm-native-interop` |
| **Chromium native client ↔ wasm server** | real localhost UDP (Bun) + Playwright | `tools/interop/tests-wasm/wasm-server.spec.ts` |

Two meaningful cross-stack checks:

- **wasm client ↔ native server:** our minimal H3/WebTransport client interoperates
  with the production `wtransport` server, including QPACK decoding of the
  server's `:status: 200` (static name reference + HPACK-Huffman value) and
  WebTransport datagram framing.
- **Chromium native client ↔ wasm server** (`bun run test:interop:wasm-server`, or
  the `wasm` CI job): a real browser's native `WebTransport` client completes a
  full session against the wasm server hosted under Bun on localhost UDP, with
  `serverCertificateHashes` pinning the wasm-generated P-256 cert. This required
  the server's QPACK decoder to handle Chromium's Extended CONNECT request — the
  full RFC 9204 static table plus Huffman-coded literal field-line names. It runs
  WITHOUT an Isolated Web App: only the in-browser Direct Sockets *server* needs
  an IWA; protocol interop against a real client does not.

Run them (requires a wasm-capable LLVM and, for the native interop, the built
addon):

```bash
bun run build:wasm
bun run build:native           # only for wasm-native-interop
bun test packages/webtransport/test/wasm-native-interop.test.ts
```

## Browser-gated (not runnable in CI)

Only the **in-browser wasm server** path is gated now — i.e. running the wasm
server *inside* a Chromium tab over Direct Sockets. The wasm server's protocol
correctness against a real Chromium client is already covered automatically by
the `wasm-server.spec.ts` interop above (server hosted under Bun).

| Scenario | Why gated |
|---|---|
| wasm server running **inside the browser** (Direct Sockets) ↔ Chrome native client | Direct Sockets `UDPSocket` requires a Chromium Isolated Web App with the `direct-sockets` permission, behind flags |

### Manual harness: in-browser (IWA) wasm server ← Chrome native client

1. Build + package the reference IWA (see
   `examples/webtransport-wasm-iwa/README.md`) and launch it in Chromium with:
   - `chrome://flags/#enable-isolated-web-apps`
   - `chrome://flags/#enable-isolated-web-app-dev-mode`
2. In the IWA, click **Start server**; copy the printed
   `serverCertificateHashes` value (base64 SHA-256 of the cert DER).
3. From a normal Chrome tab (or another IWA), connect with the native API:

   ```js
   const wt = new WebTransport("https://127.0.0.1:4433/", {
     serverCertificateHashes: [
       { algorithm: "sha-256", value: Uint8Array.from(atob(HASH), c => c.charCodeAt(0)) },
     ],
   });
   await wt.ready;
   const w = wt.datagrams.writable.getWriter();
   await w.write(new TextEncoder().encode("hello"));
   ```

   The wasm server echoes the datagram back. Note the cert must be ECDSA P-256
   with ≤14-day validity (the wasm `wt_generate_cert` enforces this).

### Multi-client routing (resolved)

The wasm endpoint now routes by real per-packet source/destination addresses:
`WtEndpoint::recv` takes the packet source, `poll_transmits` emits each packet
with its destination, and connection state is keyed by quinn-proto
`ConnectionHandle`. One bound server handles multiple simultaneous clients with
no cross-talk (see the routing-isolation tests above).
