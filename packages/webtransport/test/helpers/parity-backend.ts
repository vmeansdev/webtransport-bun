/**
 * Parity suite backend selector.
 *
 * Both backends are driven through the portable `createServer`, so the suites
 * run one server codebase against the native addon and against wasm over an
 * in-memory UDP relay.
 *
 * Default: native. Set WEBTRANSPORT_PARITY_BACKEND=wasm for the wasm path
 * (requires the wasm pkg; soft-skips when unavailable unless
 * WEBTRANSPORT_REQUIRE_WASM=1).
 */

import {
	connectWasm,
	type WasmConnectOptions,
	type WasmSession,
	wasmClientPoolMetricsSnapshot,
	WasmWebTransport,
} from "../../src/backend.js";
import {
	clientPoolMetricsSnapshot,
	WebTransport,
	type WebTransportClientOptions,
} from "../../src/index.js";
import {
	createServer as createPortableServer,
	type PortableServer,
	type PortableServerSession,
} from "../../src/portable.js";
import type { WebTransportCloseInfo } from "../../src/types.js";
import { InMemoryRelay } from "../../src/wasm-relay.js";
import type { WasmWebTransportOptions } from "../../src/wasm-webtransport.js";
import { WebTransportError } from "../../src/errors.js";
import { nextPort, openWTWithRetry } from "./network.js";
import { loadWasmModule, wasmAvailable } from "./wasm-availability.js";

export type ParityBackend = "native" | "wasm";

export const PARITY_BACKEND: ParityBackend =
	process.env.WEBTRANSPORT_PARITY_BACKEND === "wasm" ? "wasm" : "native";

export function isWasmParityBackend(): boolean {
	return PARITY_BACKEND === "wasm";
}

export function wasmParityReady(): boolean {
	return isWasmParityBackend() && wasmAvailable;
}

/** Soft-skip when the wasm selector is requested but the pkg is missing. */
export const skipWasmParityIfUnavailable =
	isWasmParityBackend() && !wasmAvailable;

export type ParityTransport = WebTransport | WasmWebTransport;

export type ParityOpenOptions = WebTransportClientOptions &
	WasmWebTransportOptions & {
		tls?: { insecureSkipVerify?: boolean };
	};

/** The server-side session handed to suite `onSession` handlers. */
export type ParityServerSession = PortableServerSession;

type ServerLimits = {
	maxStreamsPerSessionBidi?: number;
	maxStreamsGlobal?: number;
	backpressureTimeoutMs?: number;
};

type HarnessOptions = {
	onSession?: (session: ParityServerSession) => void | Promise<void>;
	serverLimits?: ServerLimits;
};

/**
 * Client endpoint-pool counters. `hits`/`misses` mean the same on both
 * backends. Eviction accounting does not: native splits idle from broken,
 * wasm keeps one combined counter, so those fields are backend-specific.
 */
export type ParityPoolMetrics = {
	hits: number;
	misses: number;
	evictIdle?: number;
	evictBroken?: number;
	evictions?: number;
};

type ParityHarness = {
	backend: ParityBackend;
	url: string;
	open: (opts?: ParityOpenOptions) => Promise<ParityTransport>;
	/** Validate constructor options without awaiting ready (baseline/compat). */
	construct: (opts?: ParityOpenOptions) => ParityTransport;
	/** Open, await ready, then close — the pooling suites' round-trip probe. */
	openAndClose: (opts?: ParityOpenOptions) => Promise<void>;
	poolMetrics: () => ParityPoolMetrics;
	close: () => Promise<void>;
	/** Native-only server port when backend is native; 0 for wasm. */
	port: number;
};

export type { ParityHarness };

/**
 * Build a public WASM facade around a deterministic session-shaped stimulus.
 * This keeps parity tests independent of host-specific UDP timeout behavior
 * while still exercising the exported WasmWebTransport error surface.
 */
export function createWasmErrorProbe(
	options: {
		strictW3CErrors?: boolean;
		readyError?: WebTransportError;
		sendDatagramError?: WebTransportError;
	} = {},
): WasmWebTransport {
	const never = new Promise<never>(() => {});
	const session = {
		ready: options.readyError
			? Promise.reject(options.readyError)
			: Promise.resolve(),
		closed: never,
		draining: never,
		onDatagram() {},
		onIncomingStream() {},
		maxDatagramSize: 1200,
		backpressureTimeoutMs: 10,
		isClosingOrClosed: false,
		connectionStats() {
			return {
				bytesSent: 0,
				bytesReceived: 0,
				packetsSent: 0,
				packetsReceived: 0,
				datagrams: {
					droppedIncoming: 0,
					expiredIncoming: 0,
					expiredOutgoing: 0,
					lostOutgoing: 0,
				},
			};
		},
		sendDatagram: async () => {
			if (options.sendDatagramError) throw options.sendDatagramError;
		},
		close() {},
	};
	return new WasmWebTransport(session as unknown as WasmSession, {
		strictW3CErrors: options.strictW3CErrors,
	});
}

let wasmModulePromise: Promise<
	Awaited<ReturnType<typeof loadWasmModule>>
> | null = null;

async function getWasm() {
	if (!wasmAvailable) {
		throw new Error("wasm pkg unavailable for parity backend=wasm");
	}
	wasmModulePromise ??= loadWasmModule();
	return wasmModulePromise;
}

/** Start a parity harness for the selected backend. */
export async function createParityHarness(
	opts?: HarnessOptions,
): Promise<ParityHarness> {
	return isWasmParityBackend()
		? createWasmHarness(opts)
		: createNativeHarness(opts);
}

async function createNativeHarness(
	opts?: HarnessOptions,
): Promise<ParityHarness> {
	const port = nextPort(15550, 1000);
	const server: PortableServer = await createPortableServer({
		backend: "native",
		host: "127.0.0.1",
		port,
		tls: { certPem: "", keyPem: "" },
		limits: opts?.serverLimits,
		onSession: async (s) => {
			await opts?.onSession?.(s);
		},
	});
	const url = `https://127.0.0.1:${port}`;
	// Warm the listener.
	const warm = await openWTWithRetry(url, {
		tls: { insecureSkipVerify: true },
	});
	warm.close();

	return {
		backend: "native",
		url,
		port,
		open: (clientOpts = {}) =>
			openWTWithRetry(url, {
				tls: { insecureSkipVerify: true },
				...clientOpts,
			}),
		construct(clientOpts = {}) {
			return new WebTransport(url, {
				tls: { insecureSkipVerify: true },
				...clientOpts,
			});
		},
		async openAndClose(clientOpts = {}) {
			const wt = await openWTWithRetry(url, {
				tls: { insecureSkipVerify: true },
				...clientOpts,
			});
			wt.close();
			await wt.closed.catch(() => {});
		},
		poolMetrics: () => clientPoolMetricsSnapshot(),
		async close() {
			await server.close();
		},
	};
}

async function createWasmHarness(
	opts?: HarnessOptions,
): Promise<ParityHarness> {
	const wasm = await getWasm();
	const relay = new InMemoryRelay();
	const serverAddr = { address: "127.0.0.1", port: nextPort(24400, 1000) };

	const server = await createPortableServer({
		backend: "wasm",
		host: serverAddr.address,
		port: serverAddr.port,
		tls: { allowSelfSigned: true },
		limits: opts?.serverLimits,
		wasmModule: wasm,
		wasmBind: async () => relay.endpoint(serverAddr),
		onSession: async (s) => {
			await opts?.onSession?.(s);
		},
	});
	const certHashBase64 = server.certHashBase64;

	const connect = async (clientOpts: ParityOpenOptions = {}) => {
		const ephemeralClient = {
			address: "127.0.0.1",
			port: nextPort(25400, 2000),
		};
		const connectOpts: WasmConnectOptions = {
			limits: clientOpts.limits as WasmConnectOptions["limits"],
			allowPooling: clientOpts.allowPooling,
			requireUnreliable: clientOpts.requireUnreliable,
			congestionControl: clientOpts.congestionControl,
			strictW3CErrors: clientOpts.strictW3CErrors,
			datagramsReadableType: clientOpts.datagramsReadableType,
			// Wasm clients verify this self-signed server by pinning its live
			// hash. Pooling forbids pinning and wasm has no insecureSkipVerify,
			// so pooled connects here cannot establish — the pooled-reuse tests
			// are guarded on wasm and covered by wasm-parity-helpers instead.
			...(clientOpts.allowPooling ? {} : { certHashBase64 }),
		};
		const { session, manager } = await connectWasm(
			wasm,
			relay.endpoint(ephemeralClient),
			"localhost",
			`${ephemeralClient.address}:${ephemeralClient.port}`,
			`${serverAddr.address}:${serverAddr.port}`,
			connectOpts,
		);
		return { session, manager, connectOpts };
	};

	const open = async (clientOpts: ParityOpenOptions = {}) => {
		const { session, manager, connectOpts } = await connect(clientOpts);
		const wt = new WasmWebTransport(session, connectOpts);
		const originalClose = wt.close.bind(wt);
		wt.close = (info?: WebTransportCloseInfo) => {
			originalClose(info);
			manager.close();
		};
		return wt;
	};

	// `construct` hands back a real WasmWebTransport — never a stub — but the
	// suites call it synchronously to assert option validation, and connecting
	// is async. Keep one live session in reserve for it. The constructor
	// validates its options before it touches the session, so every option
	// assertion exercises the real path. Callers that then `close()` really do
	// close this session; a later `construct()` still validates correctly
	// because `WasmSession.close()` is idempotent and validation runs first.
	const spare = await connect();

	return {
		backend: "wasm",
		url: `https://${serverAddr.address}:${serverAddr.port}`,
		port: 0,
		open,
		construct(clientOpts: ParityOpenOptions = {}) {
			return new WasmWebTransport(spare.session as WasmSession, clientOpts);
		},
		async openAndClose(clientOpts = {}) {
			const wt = await open(clientOpts);
			wt.close();
			await wt.closed.catch(() => {});
		},
		poolMetrics: () => wasmClientPoolMetricsSnapshot(),
		async close() {
			spare.manager.close();
			await server.close();
		},
	};
}
