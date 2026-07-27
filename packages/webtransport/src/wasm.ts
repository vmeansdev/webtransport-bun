// Browser / Isolated Web App entrypoint: `@webtransport-bun/webtransport/wasm`.
//
// Lazily used only in a Chromium IWA with Direct Sockets. The wasm-bindgen glue
// (the `.wasm` + JS) is loaded by the consumer and passed in as `WasmModule`, so
// importing this subpath pulls no wasm bytes on its own.
//
// CANDIDATE (coupled 1.0): `/wasm` is not yet under the package's stable 1.0.0
// semver commitment. It joins GA only when docs/release-status.json marks
// readiness=ready after wasm protocol bar (dynamic QPACK, multi-session, 0-RTT)
// and wasm-facade-parity claims pass. Until then the facade may still change;
// the frozen root entrypoint remains the native API. See docs/WASM_1.0_PLAN.md.

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
 * `bun run build:wasm:dist`. Browser/IWA consumers should instead load the
 * `web`-target glue (`wasm-dist/web`) and pass it in as {@link WasmModule}.
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
