// Portable WebTransport server entrypoint: `@webtransport-bun/webtransport/portable`.
//
// One async `createServer` that runs the same server code on the native addon
// (Bun/Node/Deno) and on wasm (Chromium Isolated Web App + Direct Sockets).
//
// WEB-SAFETY: this module must stay loadable inside an IWA, so it must never
// statically import `node:*`. The native branch — and only the native branch —
// pulls in `./portable-native.js` through a dynamic import.

import { type BackendKind, selectBackend } from "./backend.js";
import type { WasmModule } from "./backend-wasm.js";
import type { UdpTransport } from "./wasm-relay.js";
import type {
	WasmWebTransportOptions,
	WebTransportBidirectionalStream,
} from "./wasm-webtransport.js";

export type { BackendKind };

/**
 * Stream-open options honoured by both backends. Wasm additionally supports
 * `sendOrder`/`sendGroup`; those are reachable through the wasm-specific API
 * rather than promised here, since the native server has no equivalent.
 */
export type PortableStreamOpenOptions = { waitUntilAvailable?: boolean };

/**
 * The server session surface both backends implement.
 *
 * Note the stream constructors return W3C `{ readable, writable }` pairs on
 * both backends. The native `ServerSession` hands back a Node `Duplex`, whose
 * `.readable`/`.writable` are *booleans*, so it does not satisfy this type
 * structurally — `createServer` adapts it explicitly.
 */
export interface PortableServerSession {
	readonly id: string;
	readonly peer: { ip: string; port: number };

	readonly ready: Promise<void>;
	readonly closed: Promise<{ code?: number; reason?: string }>;

	close(info?: { code?: number; reason?: string }): void;

	/**
	 * Tell the peer this session is going away soon, without ending it. Sends a
	 * `WT_DRAIN_SESSION` capsule; streams already open keep working and new ones
	 * can still be opened.
	 */
	drain(): void;

	sendDatagram(data: Uint8Array): Promise<void>;
	incomingDatagrams(): AsyncIterable<Uint8Array>;

	readonly incomingBidirectionalStreams: ReadableStream<WebTransportBidirectionalStream>;
	readonly incomingUnidirectionalStreams: ReadableStream<
		ReadableStream<Uint8Array>
	>;

	createBidirectionalStream(
		options?: PortableStreamOpenOptions,
	): Promise<WebTransportBidirectionalStream>;
	createUnidirectionalStream(
		options?: PortableStreamOpenOptions,
	): Promise<WritableStream<Uint8Array>>;

	metricsSnapshot(): {
		datagramsIn: number;
		datagramsOut: number;
		streamsActive: number;
		queuedBytes: number;
	};
}

/** TLS inputs both backends accept. */
export type PortableTlsOptions = {
	certPem?: string | Uint8Array;
	keyPem?: string | Uint8Array;
	/**
	 * Generate a short-lived self-signed cert when no PEM is supplied.
	 * Wasm-only; the native backend rejects this rather than silently
	 * serving a certificate the caller did not choose.
	 */
	allowSelfSigned?: boolean;
};

export type PortableLimits = {
	maxStreamsPerSessionBidi?: number;
	maxStreamsGlobal?: number;
	backpressureTimeoutMs?: number;
};

export type PortableCreateServerOptions = {
	/** Defaults to the current runtime: wasm under Direct Sockets, else native. */
	backend?: BackendKind;
	host?: string;
	/** Pass 0 for an OS-assigned ephemeral port; read it back from `address.port`. */
	port: number;
	tls: PortableTlsOptions;
	limits?: PortableLimits;
	onSession: (session: PortableServerSession) => void | Promise<void>;
	log?: (event: { type: string; [key: string]: unknown }) => void;
	debug?: boolean;
	/** Wasm-only knobs forwarded to the W3C facade. */
	wasmOptions?: WasmWebTransportOptions;
	/**
	 * Wasm-only: pre-initialized wasm module. Defaults to loading
	 * `wasm-dist/web`. Ignored on the native backend.
	 */
	wasmModule?: WasmModule;
	/**
	 * Wasm-only: UDP bind seam. Defaults to Direct Sockets. Supply this to run
	 * the wasm backend over another transport (Bun UDP, an in-memory relay).
	 * Ignored on the native backend.
	 */
	wasmBind?: (localAddress: string, localPort: number) => Promise<UdpTransport>;
};

export interface PortableServer {
	readonly backend: BackendKind;
	readonly address: { host: string; port: number };
	/**
	 * SHA-256(DER) pin for the current default certificate. Present on wasm,
	 * where clients pin rather than chain-validate; undefined on native.
	 */
	readonly certHashBase64?: string;
	close(): Promise<void>;
}

/**
 * Start a WebTransport server on whichever backend the runtime provides.
 *
 * @example
 * ```ts
 * import { createServer } from "@webtransport-bun/webtransport/portable";
 * const server = await createServer({
 *   port: 4433,
 *   tls: { allowSelfSigned: true },
 *   onSession: async (session) => {
 *     for await (const d of session.incomingDatagrams()) {
 *       await session.sendDatagram(d);
 *     }
 *   },
 * });
 * ```
 */
export async function createServer(
	opts: PortableCreateServerOptions,
): Promise<PortableServer> {
	const backend = opts.backend ?? selectBackend();
	if (backend === "wasm") {
		return createWasmPortableServer(opts);
	}
	// Dynamic so the native adapter's `node:stream` import never reaches an IWA.
	const { createNativePortableServer } = await import("./portable-native.js");
	return createNativePortableServer(opts);
}

async function createWasmPortableServer(
	opts: PortableCreateServerOptions,
): Promise<PortableServer> {
	const { createServer: createWasmServer } = await import(
		"./wasm-create-server.js"
	);
	const host = opts.host ?? "127.0.0.1";
	const server = await createWasmServer({
		host,
		port: opts.port,
		tls: {
			certPem: opts.tls.certPem,
			keyPem: opts.tls.keyPem,
			allowSelfSigned: opts.tls.allowSelfSigned,
		},
		limits: opts.limits,
		log: opts.log,
		debug: opts.debug,
		...(opts.wasmOptions ? { sessionOptions: opts.wasmOptions } : {}),
		...(opts.wasmModule ? { wasm: opts.wasmModule } : {}),
		...(opts.wasmBind ? { bind: opts.wasmBind } : {}),
		// WasmServerSession already implements the portable surface.
		onSession: (session) => opts.onSession(session),
	});

	return {
		backend: "wasm",
		address: server.address,
		certHashBase64: server.certHashBase64,
		close: () => server.close(),
	};
}
