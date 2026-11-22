// Request/response and tunnel server (runbook: docs/scenarios/rpc-and-tunnels.md).
//
// Every stream a client opens says what it is in its first byte:
// - exchange: one request per stream. The server reads the request to its
//   FIN, writes the response and ends the stream. Opening a stream per call
//   keeps calls independent: a slow response never blocks the next one.
// - tunnel: one long-lived stream per session. Both sides write timestamped
//   frames at the bitrate the client asked for and read concurrently. When
//   the client ends its side, the server stops sending, reports what it saw
//   in a summary frame and ends its side.

import {
	createServer,
	type LimitsOptions,
	type RateLimitOptions,
	type WebTransportBidirectionalStream,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags } from "../shared/stats.js";
import {
	DATA_HEADER_BYTES,
	EXCHANGE_HEADER_BYTES,
	encodeFrame,
	errorCode,
	exchangeResponse,
	Frame,
	FrameReader,
	LatencyHistogram,
	Mode,
	readDataStamp,
	TunnelSender,
	type TunnelSummary,
	wallNowMs,
} from "./protocol.js";

// A request is read whole before it is answered; bigger ones are refused.
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_TUNNEL_BITS_PER_SEC = 1_000_000_000;

// Just what the handlers use, so Node's and the DOM's stream typings both fit.
type Reader = {
	read(): Promise<
		{ done: false; value: Uint8Array } | { done: true; value?: Uint8Array }
	>;
};
type Writer = ReturnType<
	WebTransportBidirectionalStream["writable"]["getWriter"]
>;

export type RpcServerOptions = {
	port: number;
	host?: string;
	tls: { certPem: string; keyPem: string };
	limits?: Partial<LimitsOptions>;
	rateLimits?: Partial<RateLimitOptions>;
};

export function startRpcServer(opts: RpcServerOptions) {
	let streamsAccepted = 0;
	let exchangesServed = 0;
	let tunnelsOpen = 0;
	let tunnelsDone = 0;
	const errors: Record<string, number> = {};
	const countError = (err: unknown) => {
		const code = errorCode(err);
		errors[code] = (errors[code] ?? 0) + 1;
	};

	async function serveExchange(
		reader: Reader,
		writer: Writer,
		first: Uint8Array,
	) {
		const chunks = [first];
		let requestBytes = first.byteLength;
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			requestBytes += value.byteLength;
			if (requestBytes > MAX_REQUEST_BYTES)
				throw new Error("request too large");
			chunks.push(value);
		}
		if (requestBytes < EXCHANGE_HEADER_BYTES) throw new Error("short request");
		const header = new Uint8Array(EXCHANGE_HEADER_BYTES);
		let at = 0;
		for (const chunk of chunks) {
			if (at === header.byteLength) break;
			const take = chunk.subarray(0, header.byteLength - at);
			header.set(take, at);
			at += take.byteLength;
		}
		const responseBytes = new DataView(header.buffer).getUint32(1, true);
		await writer.write(exchangeResponse(requestBytes, responseBytes));
		exchangesServed++;
		// close() settles when the client has acknowledged the FIN. A client
		// that got its answer may close its session first, which rejects
		// close() for a call that was delivered, so its outcome is not ours.
		writer.close().catch(() => {});
	}

	async function serveTunnel(
		reader: Reader,
		writer: Writer,
		first: Uint8Array,
	) {
		const frames = new FrameReader();
		const up = new LatencyHistogram();
		let upBytes = 0;
		let sender: TunnelSender | undefined;
		const onChunk = (chunk: Uint8Array) => {
			for (const frame of frames.push(chunk)) {
				if (frame.type === Frame.Data) {
					upBytes += frame.bytes;
					up.record(wallNowMs() - readDataStamp(frame.body).sentMs);
				} else if (frame.type === Frame.Hello && !sender) {
					const view = new DataView(frame.body.buffer, frame.body.byteOffset);
					const bitsPerSec = view.getUint32(0, true);
					const frameBytes = view.getUint32(4, true);
					if (
						frameBytes < DATA_HEADER_BYTES ||
						frameBytes > MAX_FRAME_BYTES ||
						bitsPerSec > MAX_TUNNEL_BITS_PER_SEC
					)
						throw new Error("bad tunnel hello");
					sender = new TunnelSender(bitsPerSec, frameBytes, (buf) =>
						writer.write(buf),
					);
					sender.start();
				} else {
					throw new Error(`unexpected frame type ${frame.type}`);
				}
			}
		};
		tunnelsOpen++;
		try {
			onChunk(first);
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				onChunk(value);
			}
			if (!sender) throw new Error("tunnel ended before its hello");
			await sender.stop();
			if (sender.error !== undefined) throw sender.error;
			const summary: TunnelSummary = {
				upBytesReceived: upBytes,
				upFramesReceived: up.total,
				upLatency: up.toJSON(),
				downBytesOffered: sender.bytesOffered,
				downBytesSent: sender.bytesSent,
				downElapsedMs: sender.elapsedMs,
			};
			await writer.write(
				encodeFrame(
					Frame.Summary,
					new TextEncoder().encode(JSON.stringify(summary)),
				),
			);
			tunnelsDone++;
			writer.close().catch(() => {}); // as for exchanges: the FIN-ack race
		} finally {
			await sender?.stop();
			tunnelsOpen--;
		}
	}

	async function serveStream(stream: WebTransportBidirectionalStream) {
		streamsAccepted++;
		const reader = stream.readable.getReader();
		const writer = stream.writable.getWriter();
		try {
			let first = await reader.read();
			while (!first.done && first.value.byteLength === 0)
				first = await reader.read();
			if (first.done) throw new Error("empty stream");
			const mode = first.value[0];
			if (mode === Mode.Exchange)
				await serveExchange(reader, writer, first.value);
			else if (mode === Mode.Tunnel)
				await serveTunnel(reader, writer, first.value.subarray(1));
			else throw new Error(`unknown mode ${mode}`);
		} catch (err) {
			countError(err);
			// Abort resets our side so the client sees E_STREAM_RESET instead
			// of waiting for a response that will not come.
			writer.abort(err).catch(() => {});
			reader.cancel(err).catch(() => {});
		}
	}

	const server = createServer({
		port: opts.port,
		host: opts.host,
		tls: { certPem: opts.tls.certPem, keyPem: opts.tls.keyPem },
		limits: opts.limits,
		rateLimits: opts.rateLimits,
		onSession: async (session) => {
			// Serve streams concurrently: awaiting one before accepting the
			// next would turn a session's calls into a queue.
			for await (const stream of session.incomingBidirectionalStreams) {
				void serveStream(stream);
			}
		},
	});

	return {
		server,
		get port() {
			return server.address.port;
		},
		get streamsAccepted() {
			return streamsAccepted;
		},
		get exchangesServed() {
			return exchangesServed;
		},
		get tunnelsOpen() {
			return tunnelsOpen;
		},
		get tunnelsDone() {
			return tunnelsDone;
		},
		get errors() {
			return { ...errors };
		},
		async close() {
			await server.close();
		},
	};
}

if (import.meta.main) {
	const args = flags({ port: 4433, host: "0.0.0.0" });
	const rpc = startRpcServer({
		port: args.port,
		host: args.host,
		tls: scenarioTls(),
		// The per-IP buckets default to 20 handshakes/s and 200 stream opens/s
		// (burst 400). A load-test host is one IP carrying every session and
		// every call, so open them up; in production size them for the most
		// clients behind one NAT.
		rateLimits: {
			handshakesPerSec: 10_000,
			handshakesBurst: 10_000,
			handshakesBurstPerPrefix: 10_000,
			streamsPerSec: 1_000_000,
			streamsBurst: 1_000_000,
		},
		limits: { maxSessions: 20_000 },
	});
	console.log(`rpc server on ${args.host}:${rpc.port}`);
	setInterval(() => {
		const m = rpc.server.metricsSnapshot();
		console.log(
			JSON.stringify({
				sessions: m.sessionsActive,
				streamsActive: m.streamsActive,
				streamsAccepted: rpc.streamsAccepted,
				exchangesServed: rpc.exchangesServed,
				tunnelsOpen: rpc.tunnelsOpen,
				tunnelsDone: rpc.tunnelsDone,
				errors: rpc.errors,
				queuedBytesGlobal: m.queuedBytesGlobal,
				backpressureTimeouts: m.backpressureTimeoutCount,
				rateLimited: m.rateLimitedCount,
				limitExceeded: m.limitExceededCount,
			}),
		);
	}, 5000);
	process.on("SIGINT", () => void rpc.close().then(() => process.exit(0)));
}
