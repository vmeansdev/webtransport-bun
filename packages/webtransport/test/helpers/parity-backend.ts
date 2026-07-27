/**
 * Parity suite backend selector.
 *
 * Default: native (createServer + WebTransport from index).
 * Set WEBTRANSPORT_PARITY_BACKEND=wasm to exercise the wasm W3C facade over
 * an in-memory UDP relay (requires wasm pkg; soft-skips when unavailable
 * unless WEBTRANSPORT_REQUIRE_WASM=1).
 */

import {
	connectWasm,
	createWasmServer,
	type WasmConnectOptions,
	type WasmSession,
	WasmWebTransport,
} from "../../src/backend.js";
import {
	validateWasmWebTransportOptions,
	type WasmWebTransportOptions,
} from "../../src/wasm-webtransport.js";
import {
	WebTransport,
	createServer,
	type WebTransportClientOptions,
} from "../../src/index.js";
import { InMemoryRelay } from "../../src/wasm-relay.js";
import type { WebTransportCloseInfo } from "../../src/types.js";
import { loadWasmModule, wasmAvailable } from "./wasm-availability.js";
import { nextPort, openWTWithRetry } from "./network.js";

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

type ParityHarness = {
	backend: ParityBackend;
	url: string;
	open: (opts?: ParityOpenOptions) => Promise<ParityTransport>;
	/** Validate constructor options without awaiting ready (baseline/compat). */
	construct: (opts?: ParityOpenOptions) => ParityTransport | { close(): void };
	close: () => Promise<void>;
	/** Native-only server port when backend is native; 0 for wasm. */
	port: number;
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

/**
 * Start a parity harness for the selected backend.
 * `onSession` receives a thin datagram-echo adapter used by option suites.
 */
export async function createParityHarness(opts?: {
	onSession?: (session: {
		incomingDatagrams: () => AsyncIterable<Uint8Array>;
		sendDatagram: (d: Uint8Array) => Promise<void>;
	}) => void | Promise<void>;
	serverLimits?: {
		maxStreamsPerSessionBidi?: number;
		maxStreamsGlobal?: number;
		backpressureTimeoutMs?: number;
	};
}): Promise<ParityHarness> {
	if (isWasmParityBackend()) {
		const wasm = await getWasm();
		const relay = new InMemoryRelay();
		const serverAddr = { address: "127.0.0.1", port: nextPort(24400, 1000) };
		const clientAddr = {
			address: "127.0.0.1",
			port: nextPort(25400, 1000),
		};
		const server = createWasmServer(
			wasm,
			relay.endpoint(serverAddr),
			(session: WasmSession) => {
				const adapter = {
					incomingDatagrams(): AsyncIterable<Uint8Array> {
						return {
							[Symbol.asyncIterator]() {
								const queue: Uint8Array[] = [];
								let wake: (() => void) | null = null;
								let closed = false;
								session.onDatagram((d: Uint8Array) => {
									queue.push(d.slice());
									wake?.();
								});
								session.closed.then(
									() => {
										closed = true;
										wake?.();
									},
									() => {
										closed = true;
										wake?.();
									},
								);
								return {
									async next() {
										for (;;) {
											if (queue.length > 0) {
												return { value: queue.shift()!, done: false };
											}
											if (closed) return { value: undefined, done: true };
											await new Promise<void>((r) => {
												wake = r;
											});
											wake = null;
										}
									},
								};
							},
						};
					},
					sendDatagram(d: Uint8Array) {
						return session.sendDatagram(d);
					},
				};
				void opts?.onSession?.(adapter);
			},
			`${serverAddr.address}:${serverAddr.port}`,
			`${clientAddr.address}:${clientAddr.port}`,
			{
				limits: opts?.serverLimits,
			},
		);

		const open = async (clientOpts: ParityOpenOptions = {}) => {
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
			};
			const { session, manager } = await connectWasm(
				wasm,
				relay.endpoint(ephemeralClient),
				"localhost",
				`${ephemeralClient.address}:${ephemeralClient.port}`,
				`${serverAddr.address}:${serverAddr.port}`,
				connectOpts,
			);
			const wt = new WasmWebTransport(session, connectOpts);
			const originalClose = wt.close.bind(wt);
			wt.close = (info?: WebTransportCloseInfo) => {
				originalClose(info);
				manager.close();
			};
			return wt;
		};

		return {
			backend: "wasm",
			url: `https://${serverAddr.address}:${serverAddr.port}`,
			port: 0,
			open,
			construct(clientOpts = {}) {
				validateWasmWebTransportOptions(clientOpts);
				return {
					close() {},
					congestionControl: clientOpts.congestionControl ?? "default",
				} as unknown as ParityTransport;
			},
			async close() {
				server.close();
			},
		};
	}

	const port = nextPort(15550, 1000);
	const server = createServer({
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
		async close() {
			await server.close();
		},
	};
}
