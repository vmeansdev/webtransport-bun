// Bulk / VOD content server (runbook: docs/scenarios/bulk-and-streaming.md).
//
// A client asks for N transfers on a bidirectional control stream. Each
// transfer goes out on its own server-opened unidirectional stream in
// fixed-size writes that respect Node stream backpressure: when write()
// returns false the transfer waits for 'drain' instead of queueing more. Once
// every transfer has finished (the client acknowledged all of its bytes), the
// server answers on the control stream with a summary.

import type { Writable } from "node:stream";
import { finished } from "node:stream/promises";
import {
	createServer,
	DEFAULT_LIMITS,
	type LimitsOptions,
	type RateLimitOptions,
	type ServerSession,
	type WebTransportBidirectionalStream,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags } from "../shared/stats.js";
import {
	type BulkRequest,
	type BulkSummary,
	countError,
	decodeJson,
	encodeJson,
	HEADER_BYTES,
	MAX_CHUNK_BYTES,
	MAX_REQUEST_BYTES,
	patternChunk,
	validateRequest,
} from "./protocol.js";

export type BulkServerOptions = {
	port: number;
	host?: string;
	tls: { certPem: string; keyPem: string };
	limits?: Partial<LimitsOptions>;
	rateLimits?: Partial<RateLimitOptions>;
	congestionControl?: "default" | "throughput" | "low-latency";
};

export function startBulkServer(opts: BulkServerOptions) {
	const limits = { ...DEFAULT_LIMITS, ...opts.limits };
	// A single write larger than the per-stream budget is refused rather than
	// split by older releases, so the server never asks for one.
	const maxChunkBytes = Math.min(
		MAX_CHUNK_BYTES,
		limits.maxQueuedBytesPerStream,
	);
	const counters = {
		transfers: 0,
		streamsOpened: 0,
		bytesSent: 0,
		drainWaits: 0,
		streamErrors: {} as Record<string, number>,
	};

	const sendOne = async (
		session: ServerSession,
		index: number,
		req: BulkRequest,
	): Promise<number> => {
		const stream = await session.createUnidirectionalStream();
		counters.streamsOpened++;
		// One listener for the whole transfer: write() and drained() report
		// the failure, and without a listener the library also logs it.
		stream.on("error", () => {});
		const header = new Uint8Array(HEADER_BYTES);
		new DataView(header.buffer).setUint32(0, index, true);
		stream.write(header);

		const chunk = patternChunk(index, req.chunkBytes);
		let sent = 0;
		while (sent < req.bytesPerStream) {
			const n = Math.min(req.chunkBytes, req.bytesPerStream - sent);
			// The chunk is never mutated, so the same buffer can sit in the
			// stream's queue many times over.
			const ok = stream.write(
				n === chunk.length ? chunk : chunk.subarray(0, n),
			);
			sent += n;
			counters.bytesSent += n;
			if (!ok) {
				counters.drainWaits++;
				await drained(stream);
			}
		}
		// end() resolves through 'finish' only when the client has acknowledged
		// every byte, FIN included, so a finished stream is a delivered one.
		stream.end();
		await finished(stream);
		return sent;
	};

	const serve = async (
		session: ServerSession,
		control: WebTransportBidirectionalStream,
	) => {
		const started = performance.now();
		const writer = control.writable.getWriter();
		const reply = async (summary: BulkSummary) => {
			await writer.write(encodeJson(summary));
			// close() waits for the client to acknowledge the FIN. The client
			// closes its session as soon as it has read the summary, which can
			// beat that acknowledgement and surface here as a reset: the summary
			// was delivered either way.
			await writer.close().catch(() => {});
		};

		let req: BulkRequest | string;
		try {
			req = validateRequest(decodeJson(await readRequest(control.readable)), {
				maxStreams: limits.maxStreamsPerSessionUni,
				maxChunkBytes,
			});
		} catch (err) {
			req = err instanceof Error ? err.message : String(err);
		}
		if (typeof req === "string") {
			await reply({
				error: req,
				streams: 0,
				bytesSent: 0,
				streamErrors: {},
				serverMs: 0,
			});
			return;
		}

		counters.transfers++;
		const request = req;
		const results = await Promise.allSettled(
			Array.from({ length: request.streams }, (_, i) =>
				sendOne(session, i, request),
			),
		);
		let bytesSent = 0;
		const streamErrors: Record<string, number> = {};
		for (const result of results) {
			if (result.status === "fulfilled") bytesSent += result.value;
			else {
				countError(streamErrors, result.reason);
				countError(counters.streamErrors, result.reason);
			}
		}
		await reply({
			streams: request.streams,
			bytesSent,
			streamErrors,
			serverMs: performance.now() - started,
		});
	};

	const server = createServer({
		port: opts.port,
		host: opts.host,
		tls: { certPem: opts.tls.certPem, keyPem: opts.tls.keyPem },
		limits: opts.limits,
		rateLimits: opts.rateLimits,
		congestionControl: opts.congestionControl,
		onSession: async (session) => {
			// Each control stream is one request; a session may send several.
			for await (const control of session.incomingBidirectionalStreams) {
				serve(session, control).catch(() => {
					// The session went away mid-transfer; its streams are already
					// counted as errors and there is no one left to tell.
				});
			}
		},
	});

	return {
		server,
		get port() {
			return server.address.port;
		},
		get transfers() {
			return counters.transfers;
		},
		get streamsOpened() {
			return counters.streamsOpened;
		},
		get bytesSent() {
			return counters.bytesSent;
		},
		get drainWaits() {
			return counters.drainWaits;
		},
		get streamErrors() {
			return counters.streamErrors;
		},
		close: () => server.close(),
	};
}

/** Wait for 'drain', failing if the stream errors or closes first. */
function drained(stream: Writable): Promise<void> {
	// A write to a destroyed stream returns false too, and its 'close' has
	// already fired: waiting for it would hang.
	if (stream.destroyed)
		return Promise.reject(stream.errored ?? new Error("stream destroyed"));
	return new Promise((resolve, reject) => {
		const settle = (err?: Error) => {
			stream.off("drain", onDrain);
			stream.off("error", onError);
			stream.off("close", onClose);
			if (err) reject(err);
			else resolve();
		};
		const onDrain = () => settle();
		const onError = (err: Error) => settle(err);
		const onClose = () => settle(new Error("stream closed before drain"));
		stream.on("drain", onDrain);
		stream.on("error", onError);
		stream.on("close", onClose);
	});
}

async function readRequest(
	readable: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const reader = readable.getReader();
	const parts: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		length += value.byteLength;
		if (length > MAX_REQUEST_BYTES) {
			await reader.cancel().catch(() => {});
			throw new Error(`request longer than ${MAX_REQUEST_BYTES} bytes`);
		}
		parts.push(value);
	}
	const out = new Uint8Array(length);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

if (import.meta.main) {
	const args = flags({
		port: 4433,
		host: "0.0.0.0",
		congestionControl: "default",
		// 0 keeps the library default (256 KiB per stream, 2 MiB per session).
		maxQueuedBytesPerStream: 0,
		maxQueuedBytesPerSession: 0,
	});
	const limits: Partial<LimitsOptions> = { maxSessions: 5_000 };
	if (args.maxQueuedBytesPerStream > 0)
		limits.maxQueuedBytesPerStream = args.maxQueuedBytesPerStream;
	if (args.maxQueuedBytesPerSession > 0)
		limits.maxQueuedBytesPerSession = args.maxQueuedBytesPerSession;
	const bulk = startBulkServer({
		port: args.port,
		host: args.host,
		tls: scenarioTls(),
		limits,
		congestionControl:
			args.congestionControl as BulkServerOptions["congestionControl"],
		// The per-IP buckets default to 20 handshakes/s and 200 stream opens/s
		// (only client-opened streams count, so here one control stream per
		// request). A load-test host is one IP carrying every client, so open
		// them up; in production size them for the most clients behind one NAT.
		rateLimits: {
			handshakesPerSec: 10_000,
			handshakesBurst: 10_000,
			handshakesBurstPerPrefix: 10_000,
			streamsPerSec: 10_000,
			streamsBurst: 10_000,
		},
	});
	console.log(
		`bulk server on ${args.host}:${bulk.port} (congestionControl ${bulk.server.congestionControl})`,
	);
	setInterval(() => {
		const m = bulk.server.metricsSnapshot();
		console.log(
			JSON.stringify({
				sessions: m.sessionsActive,
				streamsActive: m.streamsActive,
				queuedBytesGlobal: m.queuedBytesGlobal,
				transfers: bulk.transfers,
				bytesSent: bulk.bytesSent,
				drainWaits: bulk.drainWaits,
				streamErrors: bulk.streamErrors,
				backpressureTimeouts: m.backpressureTimeoutCount,
			}),
		);
	}, 5000);
	process.on("SIGINT", () => void bulk.close().then(() => process.exit(0)));
}
