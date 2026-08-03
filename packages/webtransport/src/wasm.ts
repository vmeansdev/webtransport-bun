// Browser / Isolated Web App entrypoint: `@webtransport-bun/webtransport/wasm`.
//
// Plug-and-play: `await createServer({ port, tls, onSession })` auto-loads
// `wasm-dist/web`, binds Direct Sockets, and returns a WasmWebTransportServer.
// Lower-level APIs still accept an injected {@link WasmModule} for tests/custom hosts.
//
// SEMVER (coupled 1.0). Two separate things, which earlier wording conflated:
//
//   Export list — FROZEN. Every name below is pinned by
//   `packages/webtransport/test/public-surface-contract.test.ts`; removing or
//   renaming one is a breaking change needing a major bump, exactly as on the
//   root entrypoint. Additive names still need the frozen list updated.
//
//   Stability label — still `candidate`. docs/release-status.json marks *both*
//   `native` and `wasm` as `candidate`; `/wasm` becomes `stable` only once its
//   required claims (chromium-wasm-interop, iwa-direct-sockets,
//   wasm-dynamic-qpack, wasm-multi-session, wasm-0rtt, wasm-facade-parity)
//   pass. Until then behavior under those gates may still change.
//
// The cross-backend subset that is contract-tested on native *and* wasm is
// `/portable`, not this module. See docs/WASM_1.0_PLAN.md.

export {
	type BackendKind,
	connectWasm,
	connectWasmUnified,
	createUnifiedClient,
	createWasmServer,
	DEFAULT_WASM_LIMITS,
	DEFAULT_WASM_RATE_LIMITS,
	isWasmRuntime,
	MemoryTicketStoreHost,
	FileTicketStoreHost,
	IndexedDBTicketStoreHost,
	type NativeClientArgs,
	normalizeWasmEndpointOptions,
	selectBackend,
	serveOverUdp,
	type TicketStoreHost,
	type WasmClientArgs,
	type WasmConnectOptions,
	type WasmEndpointOptions,
	type WasmLimitsOptions,
	type WasmNormalizedEndpointOptions,
	type WasmNormalizedLimits,
	type WasmNormalizedRateLimits,
	type WasmRateLimitOptions,
	type WasmSession,
	type WasmStream,
	WasmTransportManager,
	WasmWebTransport,
	wasmClientPoolMetricsSnapshot,
	toWasmServerSession,
	WasmServerSession,
} from "./backend.js";
export {
	createServer,
	createIwaServer,
	loadWasmWebModule,
	type WasmCreateServerOptions,
	type WasmCreateServerTls,
	type WasmSniEntry,
	type WasmWebTransportServer,
} from "./wasm-create-server.js";
export {
	validateWasmWebTransportOptions,
	type WasmWebTransportOptions,
	WasmWebTransportSendGroup,
} from "./wasm-webtransport.js";
export {
	createW3CMappedError,
	normalizeW3CBrowserName,
	validateW3CClientOptions,
	type W3CClientOptionSurface,
	type W3CCongestionControl,
	type W3CDatagramsReadableType,
} from "./w3c-client-options.js";
export type { WasmModule, WasmSessionEvents } from "./backend-wasm.js";
export type {
	WebTransportLike,
	WtBidiStream,
	WtCloseInfo,
} from "./shared.js";

import type { WasmModule } from "./backend-wasm.js";

/**
 * Load the prebuilt Node/Bun wasm-bindgen module shipped with the npm package
 * (`wasm-dist/node`). In a source checkout, produce it first with
 * `bun run build:wasm:dist`. Browser/IWA consumers should prefer
 * {@link createServer} / {@link loadWasmWebModule} (`wasm-dist/web`).
 */
export async function loadWasmModule(): Promise<WasmModule> {
	// Computed specifier: the artifact is created at build/publish time, so the
	// type-checker must not try to resolve it statically.
	const spec = "../wasm-dist/node/webtransport_wasm.js";
	try {
		return (await import(spec)) as unknown as WasmModule;
	} catch (cause) {
		throw new Error(
			"prebuilt wasm module not found: run `bun run build:wasm:dist` in a source checkout, or reinstall the published package",
			{ cause },
		);
	}
}
export { DirectSocketsUdpTransport } from "./direct-sockets.js";
export {
	type GeneratedCert,
	generateCert,
	serverCertificateHashes,
	type WasmCertModule,
	WasmCertRotator,
} from "./wasm-cert.js";
export { InMemoryRelay, type UdpTransport } from "./wasm-relay.js";
