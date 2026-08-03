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
	normalizeWasmEndpointOptions,
	type WasmConnectOptions,
	type WasmSession,
	WasmTransportManager,
	wasmClientPoolMetricsSnapshot,
	WasmWebTransport,
} from "../../src/backend.js";
import type { WasmModule } from "../../src/backend-wasm.js";
import {
	clientPoolMetricsSnapshot,
	WebTransport,
	type WebTransportClientOptions,
} from "../../src/index.js";
import { __TESTING__ } from "../../src/internal.js";
import {
	createServer as createPortableServer,
	type PortableServer,
	type PortableServerSession,
} from "../../src/portable.js";
import type { WebTransportCloseInfo } from "../../src/types.js";
import { InMemoryRelay } from "../../src/wasm-relay.js";
import type { WasmWebTransportOptions } from "../../src/wasm-webtransport.js";
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
	/**
	 * Drive this backend's client into a bounded handshake timeout and return
	 * the rejection. Never awaits an unbounded network wait: native uses its
	 * own 150ms deadline against TEST-NET, wasm dials an unbound relay address.
	 */
	handshakeTimeoutError: (opts: ParityOpenOptions) => Promise<unknown>;
	/**
	 * Send one datagram through the real client facade over a transport whose
	 * send fails with E_QUEUE_FULL. Returns the rejecting send promise.
	 */
	queueFullDatagramError: (opts: ParityOpenOptions) => Promise<void>;
};

export type { ParityHarness };

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
		async handshakeTimeoutError(clientOpts) {
			// 192.0.2.1 (TEST-NET) is unroutable; our own 150ms deadline bounds
			// the wait, and a refused connect can win with E_INTERNAL.
			const wt = new WebTransport("https://192.0.2.1:443", {
				tls: { insecureSkipVerify: true },
				limits: { handshakeTimeoutMs: 150 },
				...clientOpts,
			});
			return wt.ready.then(
				() => {
					throw new Error("expected ready to reject");
				},
				(error: unknown) => error,
			);
		},
		async queueFullDatagramError(clientOpts) {
			const session = __TESTING__.createNativeClientSessionForTests(
				{
					id: "strict-client",
					peerIp: "127.0.0.1",
					peerPort: 1,
					sendDatagram: async () => {
						throw new Error("E_QUEUE_FULL: synthetic queue pressure");
					},
					close: () => {},
				},
				clientOpts.strictW3CErrors === true,
			);
			await session.sendDatagram(new Uint8Array([1]));
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
		async handshakeTimeoutError(clientOpts) {
			// Nothing is bound at this relay address, so the relay drops every
			// packet and the connect can only end at the handshake deadline.
			const deadPort = nextPort(26400, 500);
			const clientPort = nextPort(26900, 500);
			return connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: clientPort }),
				"localhost",
				`127.0.0.1:${clientPort}`,
				`127.0.0.1:${deadPort}`,
				{
					certHashBase64,
					strictW3CErrors: clientOpts.strictW3CErrors,
					limits: { handshakeTimeoutMs: 150 },
				},
			).then(
				() => {
					throw new Error("expected connect to reject");
				},
				(error: unknown) => error,
			);
		},
		async queueFullDatagramError(clientOpts) {
			// Real manager and real facade over a wasm ABI whose datagram send
			// fails, mirroring the native synthetic transport.
			const manager = WasmTransportManager.create(
				queueFullWasmModule(),
				relay.endpoint({
					address: "127.0.0.1",
					port: nextPort(27400, 500),
				}),
				false,
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				null,
				normalizeWasmEndpointOptions(),
			);
			const facade = new WasmWebTransport(manager.connectClient("localhost"), {
				strictW3CErrors: clientOpts.strictW3CErrors,
			});
			try {
				await facade.datagrams.writable.getWriter().write(new Uint8Array([1]));
			} finally {
				manager.close();
			}
		},
	};
}

/** A wasm ABI whose datagram send always reports a full queue. */
function queueFullWasmModule(): WasmModule {
	const base = {
		wt_new_endpoint_with_options: () => JSON.stringify({ eid: 1 }),
		wt_connect: () => 1,
		wt_send_datagram: () => false,
		wt_max_datagram_size: () => 1200,
		wt_take_last_error: () => "E_QUEUE_FULL: datagram send queue blocked",
		wt_poll_transmits: () => new Uint8Array(),
		wt_poll_event: () => undefined,
		wt_next_timeout_ms: () => -1,
		wt_governor_snapshot: () => "{}",
		wt_close_all() {},
		wt_close_endpoint() {},
	} satisfies Partial<WasmModule>;
	return new Proxy(base as unknown as WasmModule, {
		get(target, key) {
			return Reflect.get(target, key) ?? (() => 0);
		},
	});
}
