// Browser / Isolated Web App entrypoint: `@webtransport-bun/webtransport/wasm`.
//
// Lazily used only in a Chromium IWA with Direct Sockets. The wasm-bindgen glue
// (the `.wasm` + JS) is loaded by the consumer and passed in as `WasmModule`, so
// importing this subpath pulls no wasm bytes on its own.
//
// EXPERIMENTAL (0.x): the `/wasm` subpath is NOT covered by the package's 1.0.0
// semver stability commitment. Its facade (callback-style WasmSession/WasmStream,
// plain-Error close semantics) intentionally diverges from the native surface and
// may change in any minor release until it converges. Depend on it only if you
// accept breaking changes; the frozen 1.0 API is the native (root) entrypoint.

export {
	type BackendKind,
	type NativeClientArgs,
	type WasmClientArgs,
	type WasmConnectOptions,
	type WasmSession,
	type WasmStream,
	WasmTransportManager,
	WasmWebTransport,
	connectWasm,
	connectWasmUnified,
	createUnifiedClient,
	createWasmServer,
	isWasmRuntime,
	selectBackend,
	serveOverUdp,
} from "./backend.js";
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
