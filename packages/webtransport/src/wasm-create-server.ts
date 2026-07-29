// Plug-and-play wasm server for Chromium Isolated Web Apps + Direct Sockets.
// Distinct from the root native `createServer` (sync, napi addon).

import {
	type WasmEndpointOptions,
	type WasmSession,
	type WasmTransportManager,
	serveOverUdp,
} from "./backend.js";
import type { WasmModule } from "./backend-wasm.js";
import { DirectSocketsUdpTransport } from "./direct-sockets.js";
import {
	E_INVALID_ARGUMENT,
	E_TLS,
	E_UNSUPPORTED_ARGUMENT,
	type ErrorCode,
	WebTransportError,
} from "./errors.js";
import type { UdpTransport } from "./wasm-relay.js";
import {
	type WasmServerSession,
	toWasmServerSession,
} from "./wasm-server-session.js";

/** One SNI mapping: a server name and the PEM pair to serve for it. */
export type WasmSniEntry = {
	serverName: string;
	certPem: string | Uint8Array;
	keyPem: string | Uint8Array;
};

export type WasmCreateServerTls = {
	/** PEM certificate. Required unless `allowSelfSigned` is true. */
	certPem?: string | Uint8Array;
	/** PEM private key. Required unless `allowSelfSigned` is true. */
	keyPem?: string | Uint8Array;
	/** When true, empty PEM is allowed and a fresh P-256 cert is generated. */
	allowSelfSigned?: boolean;
	/** Common name for generated certs (default "localhost"). */
	commonName?: string;
	/** Validity days for generated certs (default 14, clamped by wasm). */
	validityDays?: number;
	sni?: WasmSniEntry[];
	unknownSniPolicy?: "reject" | "default";
};

export type WasmCreateServerOptions = {
	/** Bind host. Default "127.0.0.1" (IWA loopback-friendly). */
	host?: string;
	/**
	 * UDP port. Pass 0 for an OS-assigned ephemeral port; the real port is on
	 * the returned server's `address.port`.
	 */
	port: number;
	tls: WasmCreateServerTls;
	/** Called for each accepted session (wasm session facade, not native ServerSession). */
	onSession: (session: WasmServerSession) => void | Promise<void>;
	log?: (event: { type: string; [key: string]: unknown }) => void;
	debug?: boolean;
	/** Pre-initialized wasm module. When omitted, loads `wasm-dist/web`. */
	wasm?: WasmModule;
	/**
	 * Injectable UDP bind (tests). Default: DirectSocketsUdpTransport.bind.
	 * When omitted and UDPSocket is unavailable, fails closed.
	 */
	bind?: (localAddress: string, localPort: number) => Promise<UdpTransport>;
} & WasmEndpointOptions;

/** Wasm/IWA server handle. Not a drop-in for native {@link WebTransportServer}. */
export interface WasmWebTransportServer {
	readonly address: { host: string; port: number };
	/**
	 * Live SHA-256(DER) pin for the current default cert. Updates after
	 * successful TLS mutations.
	 */
	readonly certHashBase64: string;
	updateCert(tls: {
		certPem: string | Uint8Array;
		keyPem: string | Uint8Array;
	}): Promise<void>;
	updateTls(tls: {
		certPem?: string | Uint8Array;
		keyPem?: string | Uint8Array;
		/** Whole-map replacement. Applied before `sniRemove`/`sniUpsert`. */
		sni?: WasmSniEntry[];
		/** Insert-or-replace individual entries, leaving the rest of the map. */
		sniUpsert?: WasmSniEntry[];
		/** Remove individual entries by name (case-insensitive). */
		sniRemove?: string[];
		unknownSniPolicy?: "reject" | "default";
	}): Promise<void>;
	/** Replace the whole SNI map. Prefer the incremental ops for rotation. */
	replaceSniCerts(sni: WasmSniEntry[]): Promise<void>;
	/** Insert or replace one SNI entry without disturbing the others. */
	upsertSniCert(entry: WasmSniEntry): Promise<void>;
	/** Drop one SNI entry. Removing an absent name is a no-op. */
	removeSniCert(serverName: string): Promise<void>;
	setUnknownSniPolicy(policy: "reject" | "default"): Promise<void>;
	tlsSnapshot(): {
		unknownSniPolicy: "reject" | "default";
		defaultCertPresent: boolean;
		sniNames: string[];
		defaultCertHashBase64?: string;
	};
	close(): Promise<void>;
	metricsSnapshot(): ReturnType<WasmTransportManager["metricsSnapshot"]>;
	/** Underlying manager for advanced use. */
	unwrap(): WasmTransportManager;
}

function decodePem(value: string | Uint8Array | undefined): string {
	if (value == null) return "";
	return typeof value === "string" ? value : new TextDecoder().decode(value);
}

function decodeSniEntry(entry: WasmSniEntry): {
	serverName: string;
	certPem: string;
	keyPem: string;
} {
	return {
		serverName: entry.serverName,
		certPem: decodePem(entry.certPem),
		keyPem: decodePem(entry.keyPem),
	};
}

let webWasmLoad: Promise<WasmModule> | null = null;

/**
 * Load and initialize the browser/IWA wasm-bindgen glue from `wasm-dist/web`.
 * Memoized. Injected modules must already be initialized.
 */
export async function loadWasmWebModule(): Promise<WasmModule> {
	if (!webWasmLoad) {
		webWasmLoad = (async () => {
			const spec = "../wasm-dist/web/webtransport_wasm.js";
			try {
				const mod = (await import(spec)) as {
					default?: (input?: unknown) => Promise<unknown>;
				} & WasmModule;
				if (typeof mod.default === "function") {
					await mod.default();
				}
				return mod as WasmModule;
			} catch (cause) {
				throw new Error(
					"prebuilt web wasm module not found: run `bun run build:wasm:dist` in a source checkout, or reinstall the published package (wasm-dist/web)",
					{ cause },
				);
			}
		})();
	}
	return webWasmLoad;
}

/** @internal Reset memoized loader (tests). */
export function resetWasmWebModuleLoaderForTests(): void {
	webWasmLoad = null;
}

class WasmWebTransportServerImpl implements WasmWebTransportServer {
	#manager: WasmTransportManager;
	#host: string;
	#port: number;
	#closed = false;

	constructor(manager: WasmTransportManager, host: string, port: number) {
		this.#manager = manager;
		this.#host = host;
		this.#port = port;
	}

	get address(): { host: string; port: number } {
		return { host: this.#host, port: this.#port };
	}

	get certHashBase64(): string {
		const snap = this.#manager.tlsSnapshot();
		const hash = snap.defaultCertHashBase64;
		if (!hash) {
			throw new WebTransportError(
				E_TLS as ErrorCode,
				"E_TLS: default cert hash unavailable",
			);
		}
		return hash;
	}

	async updateCert(tls: {
		certPem: string | Uint8Array;
		keyPem: string | Uint8Array;
	}): Promise<void> {
		await this.#manager.updateTls({
			certPem: decodePem(tls.certPem),
			keyPem: decodePem(tls.keyPem),
		});
	}

	async updateTls(tls: {
		certPem?: string | Uint8Array;
		keyPem?: string | Uint8Array;
		sni?: WasmSniEntry[];
		sniUpsert?: WasmSniEntry[];
		sniRemove?: string[];
		unknownSniPolicy?: "reject" | "default";
	}): Promise<void> {
		await this.#manager.updateTls({
			certPem: tls.certPem != null ? decodePem(tls.certPem) : undefined,
			keyPem: tls.keyPem != null ? decodePem(tls.keyPem) : undefined,
			sni: tls.sni?.map(decodeSniEntry),
			sniUpsert: tls.sniUpsert?.map(decodeSniEntry),
			sniRemove: tls.sniRemove,
			unknownSniPolicy: tls.unknownSniPolicy,
		});
	}

	async replaceSniCerts(sni: WasmSniEntry[]): Promise<void> {
		const snap = this.tlsSnapshot();
		await this.updateTls({
			sni,
			unknownSniPolicy: snap.unknownSniPolicy,
		});
	}

	async upsertSniCert(entry: WasmSniEntry): Promise<void> {
		await this.#manager.updateTls({ sniUpsert: [decodeSniEntry(entry)] });
	}

	async removeSniCert(serverName: string): Promise<void> {
		await this.#manager.updateTls({ sniRemove: [serverName] });
	}

	async setUnknownSniPolicy(policy: "reject" | "default"): Promise<void> {
		await this.#manager.updateTls({ unknownSniPolicy: policy });
	}

	tlsSnapshot() {
		return this.#manager.tlsSnapshot();
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#manager.close();
	}

	metricsSnapshot() {
		return this.#manager.metricsSnapshot();
	}

	unwrap(): WasmTransportManager {
		return this.#manager;
	}
}

/**
 * Async plug-and-play WebTransport server for Chromium IWA + Direct Sockets.
 *
 * Import from `@webtransport-bun/webtransport/wasm` only — not interchangeable
 * with the root native sync `createServer`.
 *
 * @example
 * ```ts
 * import { createServer } from "@webtransport-bun/webtransport/wasm";
 * const server = await createServer({
 *   port: 4433,
 *   tls: { allowSelfSigned: true },
 *   onSession: (session) => {
 *     session.onDatagram((d) => void session.sendDatagram(d));
 *   },
 * });
 * // pin clients to server.certHashBase64
 * await server.close();
 * ```
 */
export async function createServer(
	opts: WasmCreateServerOptions,
): Promise<WasmWebTransportServer> {
	if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) {
		throw new WebTransportError(
			E_INVALID_ARGUMENT as ErrorCode,
			"E_INVALID_ARGUMENT: port must be an integer in 0..65535 (0 selects an ephemeral port)",
		);
	}

	const certPem = decodePem(opts.tls.certPem);
	const keyPem = decodePem(opts.tls.keyPem);
	const hasPem = certPem.trim().length > 0 && keyPem.trim().length > 0;
	if (!hasPem && opts.tls.allowSelfSigned !== true) {
		throw new WebTransportError(
			E_TLS as ErrorCode,
			"E_TLS: certPem/keyPem required (or set tls.allowSelfSigned=true to generate)",
		);
	}
	if (certPem.trim().length > 0 !== keyPem.trim().length > 0) {
		throw new WebTransportError(
			E_TLS as ErrorCode,
			"E_TLS: certPem and keyPem must both be set or both omitted",
		);
	}

	const host = opts.host ?? "127.0.0.1";
	const bind =
		opts.bind ??
		((localAddress: string, localPort: number) =>
			DirectSocketsUdpTransport.bind(localAddress, localPort));

	if (
		!opts.bind &&
		typeof (globalThis as { UDPSocket?: unknown }).UDPSocket !== "function"
	) {
		throw new WebTransportError(
			E_UNSUPPORTED_ARGUMENT as ErrorCode,
			"E_UNSUPPORTED_ARGUMENT: UDPSocket unavailable — wasm createServer requires a Chromium Isolated Web App with Direct Sockets (or inject opts.bind for tests)",
		);
	}

	const wasm = opts.wasm ?? (await loadWasmWebModule());

	const {
		host: _h,
		port: _p,
		tls,
		onSession,
		wasm: _w,
		bind: _b,
		log,
		debug,
		...endpointOpts
	} = opts;

	let manager: WasmTransportManager | null = null;
	try {
		const started = await serveOverUdp(wasm, bind, {
			localAddress: host,
			localPort: opts.port,
			commonName: tls.commonName ?? "localhost",
			validityDays: tls.validityDays ?? 14,
			...(hasPem ? { certPem, keyPem } : {}),
			onSession: (session: WasmSession) => {
				void onSession(toWasmServerSession(session));
			},
			log,
			debug,
			...endpointOpts,
		});
		manager = started.manager;

		if (tls.sni?.length || tls.unknownSniPolicy) {
			await manager.updateTls({
				sni: tls.sni?.map((e) => ({
					serverName: e.serverName,
					certPem: decodePem(e.certPem),
					keyPem: decodePem(e.keyPem),
				})),
				unknownSniPolicy: tls.unknownSniPolicy,
			});
		}

		const hash =
			manager.tlsSnapshot().defaultCertHashBase64 ?? started.certHashBase64;
		if (!hash) {
			throw new WebTransportError(
				E_TLS as ErrorCode,
				"E_TLS: server started without a default cert hash",
			);
		}

		return new WasmWebTransportServerImpl(manager, host, started.localPort);
	} catch (err) {
		manager?.close();
		throw err;
	}
}

/** Alias that makes the IWA/async contract unmistakable next to native createServer. */
export const createIwaServer = createServer;
