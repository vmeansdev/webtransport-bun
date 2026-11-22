// Download client for the bulk content server: each session asks for N
// transfers, reads every unidirectional stream the server opens for them
// concurrently, checks each stream's length and content, and reports
// throughput and per-stream completion times.
//
// The session is closed only after the server's summary arrives. The server
// sends it once every transfer stream has finished, and a stream finishes
// when this side has acknowledged its last byte; closing straight after
// reading EOF instead can beat that acknowledgement and turn a fully
// delivered stream into a reset on the server.

import type { Duplex, Readable } from "node:stream";
import {
	type ClientSession,
	connect,
	type LimitsOptions,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags, percentile, round } from "../shared/stats.js";
import {
	type BulkRequest,
	type BulkSummary,
	countError,
	decodeJson,
	encodeJson,
	HEADER_BYTES,
	payloadByte,
} from "./protocol.js";

// Checking every byte in JavaScript would cost more than receiving it. A
// sample every 509 bytes (prime, so it walks across the pattern) plus the
// last byte of each chunk catches a lost, repeated or misordered chunk; QUIC's
// AEAD already rules out corruption on the wire.
const SAMPLE_STRIDE = 509;

export type BulkClientOptions = {
	url: string;
	caPem: string;
	/** Concurrent sessions, each running one transfer of `streams` streams. */
	sessions?: number;
	streams: number;
	bytesPerStream: number;
	chunkBytes: number;
	/** Upper bound on the whole run; sessions still open then are closed. */
	timeoutMs?: number;
	limits?: Partial<LimitsOptions>;
	connectConcurrency?: number;
};

export type BulkClientReport = {
	sessions: number;
	connectFailures: number;
	streamsRequested: number;
	/** Streams whose length and sampled content were exactly right. */
	streamsCompleted: number;
	bytesExpected: number;
	bytesReceived: number;
	patternMismatches: number;
	/** Failures by error code or message, e.g. { E_STREAM_RESET: 2 }. */
	errors: Record<string, number>;
	elapsedMs: number;
	gbps: number;
	/** Request sent to the stream's EOF, per stream. */
	perStreamMsP50: number;
	perStreamMsP99: number;
	perStreamMsMax: number;
	/** From the server's summaries. */
	serverBytesSent: number;
	serverStreamErrors: Record<string, number>;
};

type StreamResult = {
	index: number;
	bytes: number;
	mismatches: number;
	ms: number;
};

export async function runBulkClient(
	opts: BulkClientOptions,
): Promise<BulkClientReport> {
	const request: BulkRequest = {
		streams: opts.streams,
		bytesPerStream: opts.bytesPerStream,
		chunkBytes: opts.chunkBytes,
	};
	const wanted = opts.sessions ?? 1;
	const errors: Record<string, number> = {};
	const fail = (err: unknown) => countError(errors, err);

	const sessions: ClientSession[] = [];
	let connectFailures = 0;
	const queue = Array.from({ length: wanted }, (_, i) => i);
	await Promise.all(
		Array.from({ length: opts.connectConcurrency ?? 50 }, async () => {
			while (queue.shift() !== undefined) {
				try {
					sessions.push(
						await connect(opts.url, {
							tls: { caPem: opts.caPem },
							limits: opts.limits,
						}),
					);
				} catch (err) {
					connectFailures++;
					fail(err);
				}
			}
		}),
	);

	const streams: StreamResult[] = [];
	const summaries: BulkSummary[] = [];
	const startedAt = performance.now();
	const runs = Promise.allSettled(
		sessions.map((session) =>
			transfer(session, request, fail).then(({ results, summary }) => {
				streams.push(...results);
				summaries.push(summary);
			}, fail),
		),
	);
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const timedOut = await Promise.race([
		runs.then(() => false),
		Bun.sleep(timeoutMs).then(() => true),
	]);
	const elapsedMs = performance.now() - startedAt;
	if (timedOut) fail(new Error(`timeout after ${timeoutMs} ms`));

	// Closing ends every iterator and stream the sessions still hold, so the
	// transfers that timed out settle too. Waiting for `closed` matters for a
	// CLI that exits next: exit before the close goes out and the server holds
	// the session until its idle timeout. The sleep bounds both waits.
	for (const session of sessions) session.close();
	await Promise.race([
		Promise.allSettled([runs, ...sessions.map((s) => s.closed)]),
		Bun.sleep(2000),
	]);

	let bytesReceived = 0;
	let patternMismatches = 0;
	let streamsCompleted = 0;
	for (const s of streams) {
		bytesReceived += s.bytes;
		patternMismatches += s.mismatches;
		if (s.bytes === request.bytesPerStream && s.mismatches === 0)
			streamsCompleted++;
		else if (s.bytes !== request.bytesPerStream)
			fail(new Error("short stream"));
	}
	const times = streams.map((s) => s.ms);
	for (const summary of summaries) if (summary.error) fail(summary.error);
	return {
		sessions: sessions.length,
		connectFailures,
		streamsRequested: sessions.length * request.streams,
		streamsCompleted,
		bytesExpected: sessions.length * request.streams * request.bytesPerStream,
		bytesReceived,
		patternMismatches,
		errors,
		elapsedMs: round(elapsedMs),
		gbps: elapsedMs > 0 ? round((bytesReceived * 8) / elapsedMs / 1e6, 4) : 0,
		perStreamMsP50: round(percentile(times, 50)),
		perStreamMsP99: round(percentile(times, 99)),
		perStreamMsMax: round(times.length ? Math.max(...times) : Number.NaN),
		serverBytesSent: summaries.reduce((a, s) => a + s.bytesSent, 0),
		serverStreamErrors: mergeCounts(summaries.map((s) => s.streamErrors)),
	};
}

async function transfer(
	session: ClientSession,
	request: BulkRequest,
	fail: (err: unknown) => void,
): Promise<{ results: StreamResult[]; summary: BulkSummary }> {
	const control = await session.createBidirectionalStream();
	control.on("error", () => {}); // surfaced through readAll() below
	const startedAt = performance.now();
	control.end(encodeJson(request));
	const summary = readAll(control).then((b) => decodeJson(b) as BulkSummary);
	// The summary normally arrives after every stream. Arriving with an error
	// (or failing) means no streams are coming, so stop waiting for them.
	const refused = summary.then(
		(s) => (s.error ? null : new Promise<never>(() => {})),
		() => null,
	);

	const readers: Promise<StreamResult | null>[] = [];
	const seen = new Set<number>();
	const incoming = session
		.incomingUnidirectionalStreams()
		[Symbol.asyncIterator]();
	while (readers.length < request.streams) {
		const next = await Promise.race([incoming.next(), refused]);
		if (next === null || next.done) break;
		readers.push(
			readStream(next.value, request, startedAt).then(
				(result) => {
					if (seen.has(result.index) || result.index >= request.streams) {
						fail(new Error(`unexpected stream index ${result.index}`));
						return null;
					}
					seen.add(result.index);
					return result;
				},
				(err) => {
					fail(err);
					return null;
				},
			),
		);
	}
	const results = (await Promise.all(readers)).filter(
		(r): r is StreamResult => r !== null,
	);
	return { results, summary: await summary };
}

async function readStream(
	readable: Readable,
	request: BulkRequest,
	startedAt: number,
): Promise<StreamResult> {
	const header = new Uint8Array(HEADER_BYTES);
	let headerBytes = 0;
	let index = -1;
	let offset = 0;
	let mismatches = 0;
	for await (const chunk of readable as AsyncIterable<Uint8Array>) {
		let data = chunk;
		if (headerBytes < HEADER_BYTES) {
			const take = Math.min(HEADER_BYTES - headerBytes, data.length);
			header.set(data.subarray(0, take), headerBytes);
			headerBytes += take;
			data = data.subarray(take);
			if (headerBytes === HEADER_BYTES)
				index = new DataView(header.buffer).getUint32(0, true);
		}
		if (data.length === 0) continue;
		for (let i = 0; i < data.length; i += SAMPLE_STRIDE) {
			if (data[i] !== payloadByte(index, offset + i, request.chunkBytes))
				mismatches++;
		}
		const last = data.length - 1;
		if (data[last] !== payloadByte(index, offset + last, request.chunkBytes))
			mismatches++;
		offset += data.length;
	}
	if (headerBytes < HEADER_BYTES) throw new Error("stream ended before header");
	return {
		index,
		bytes: offset,
		mismatches,
		ms: performance.now() - startedAt,
	};
}

function mergeCounts(all: Record<string, number>[]): Record<string, number> {
	const out: Record<string, number> = {};
	for (const counts of all)
		for (const [key, n] of Object.entries(counts))
			out[key] = (out[key] ?? 0) + n;
	return out;
}

async function readAll(stream: Duplex): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const chunk of stream as AsyncIterable<Uint8Array>)
		parts.push(chunk);
	return Buffer.concat(parts);
}

if (import.meta.main) {
	const args = flags({
		url: "https://127.0.0.1:4433",
		sessions: 1,
		streams: 16,
		bytesPerStream: 64 * 1024 * 1024,
		chunkBytes: 65_536,
		seconds: 120,
		// 0 keeps the library default (256 KiB per stream, 2 MiB per session).
		maxQueuedBytesPerStream: 0,
		maxQueuedBytesPerSession: 0,
	});
	const limits: Partial<LimitsOptions> = {};
	if (args.maxQueuedBytesPerStream > 0)
		limits.maxQueuedBytesPerStream = args.maxQueuedBytesPerStream;
	if (args.maxQueuedBytesPerSession > 0)
		limits.maxQueuedBytesPerSession = args.maxQueuedBytesPerSession;
	const report = await runBulkClient({
		url: args.url,
		caPem: scenarioTls().caPem,
		sessions: args.sessions,
		streams: args.streams,
		bytesPerStream: args.bytesPerStream,
		chunkBytes: args.chunkBytes,
		timeoutMs: args.seconds * 1000,
		limits,
	});
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
