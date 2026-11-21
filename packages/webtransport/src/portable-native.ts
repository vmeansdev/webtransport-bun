// Native half of the portable server entrypoint.
//
// Loaded only through a dynamic import from `./portable.js` on the native
// branch, because it imports `node:stream` — which must never be pulled into a
// Chromium Isolated Web App bundle.

import { Duplex, Writable } from "node:stream";
import { E_TLS, E_UNSUPPORTED_ARGUMENT, WebTransportError } from "./errors.js";
import {
	createServer as createNativeServer,
	type ServerSession,
} from "./index.js";
import type {
	PortableCreateServerOptions,
	PortableServer,
	PortableServerSession,
} from "./portable.js";
import type { WebTransportBidirectionalStream } from "./wasm-webtransport.js";

/**
 * Adapt a native `ServerSession` to {@link PortableServerSession}.
 *
 * Only the two stream constructors actually differ: they resolve to Node
 * `Duplex`/`Writable`, whose `.readable`/`.writable` are booleans rather than
 * Web Streams. Everything else (including `incomingBidirectionalStreams`, which
 * already yields W3C pairs) passes through untouched.
 */
function toPortableSession(session: ServerSession): PortableServerSession {
	return {
		get id() {
			return session.id;
		},
		get peer() {
			return session.peer;
		},
		get ready() {
			return session.ready;
		},
		get closed() {
			return session.closed;
		},
		get incomingBidirectionalStreams() {
			return session.incomingBidirectionalStreams;
		},
		get incomingUnidirectionalStreams() {
			return session.incomingUnidirectionalStreams as ReadableStream<
				ReadableStream<Uint8Array>
			>;
		},
		close: (info) => session.close(info),
		drain: () => session.drain(),
		sendDatagram: (data) => session.sendDatagram(data),
		incomingDatagrams: () => session.incomingDatagrams(),
		metricsSnapshot: () => session.metricsSnapshot(),
		async createBidirectionalStream(options) {
			const duplex = await session.createBidirectionalStream(options);
			return duplexToWeb(duplex);
		},
		async createUnidirectionalStream(options) {
			const writable = await session.createUnidirectionalStream(options);
			return Writable.toWeb(writable) as WritableStream<Uint8Array>;
		},
	};
}

function duplexToWeb(duplex: Duplex): WebTransportBidirectionalStream {
	const { readable, writable } = Duplex.toWeb(duplex);
	return {
		readable: readable as unknown as ReadableStream<Uint8Array>,
		writable: writable as unknown as WritableStream<Uint8Array>,
	};
}

export async function createNativePortableServer(
	opts: PortableCreateServerOptions,
): Promise<PortableServer> {
	const certPem = decodePem(opts.tls.certPem);
	const keyPem = decodePem(opts.tls.keyPem);
	const hasPem = certPem.trim().length > 0 && keyPem.trim().length > 0;
	if (opts.tls.allowSelfSigned && !hasPem) {
		throw new WebTransportError(
			E_UNSUPPORTED_ARGUMENT,
			"E_UNSUPPORTED_ARGUMENT: portable createServer: tls.allowSelfSigned is wasm-only — supply tls.certPem/keyPem on the native backend",
		);
	}
	// The root createServer serves a generated development certificate for
	// empty PEM; the portable contract never does, on either backend.
	if (!hasPem) {
		throw new WebTransportError(
			E_TLS,
			"E_TLS: portable createServer: tls.certPem and tls.keyPem are required on the native backend",
		);
	}

	const server = createNativeServer({
		...(opts.host != null ? { host: opts.host } : {}),
		port: opts.port,
		tls: { certPem, keyPem },
		limits: opts.limits,
		log: opts.log as Parameters<typeof createNativeServer>[0]["log"],
		debug: opts.debug,
		onSession: (session) => opts.onSession(toPortableSession(session)),
	});

	return {
		backend: "native",
		address: server.address,
		close: () => server.close(),
	};
}

function decodePem(value: string | Uint8Array | undefined): string {
	if (value == null) return "";
	return typeof value === "string" ? value : new TextDecoder().decode(value);
}
