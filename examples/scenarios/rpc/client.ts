// Load generator for the RPC / tunnel server.
//
// exchange: every session issues calls at a fixed rate, each on a fresh
// bidirectional stream (write the request, end, read the response to its
// end), and times them on its own clock. Sessions start at random phases of
// the period so the fleet does not open its streams in step.
//
// tunnel: every session opens one long-lived bidirectional stream and both
// ends write timestamped frames at the requested bitrate while reading the
// other direction. One-way latency compares the sender's wall clock with the
// receiver's, so it only means something when both run on one host.

import type { Duplex } from "node:stream";
import {
	type ClientSession,
	connect,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags, percentile, round } from "../shared/stats.js";
import {
	errorCode,
	exchangeRequest,
	Frame,
	FrameReader,
	LatencyHistogram,
	readDataStamp,
	TunnelSender,
	type TunnelSummary,
	tunnelHello,
	wallNowMs,
} from "./protocol.js";

type Fleet = { sessions: ClientSession[]; connectFailures: number };

async function connectFleet(
	url: string,
	caPem: string,
	count: number,
	concurrency: number,
): Promise<Fleet> {
	const sessions: ClientSession[] = [];
	let connectFailures = 0;
	const queue = Array.from({ length: count }, (_, i) => i);
	await Promise.all(
		Array.from({ length: concurrency }, async () => {
			while (queue.shift() !== undefined) {
				try {
					sessions.push(await connect(url, { tls: { caPem } }));
				} catch {
					connectFailures++;
				}
			}
		}),
	);
	return { sessions, connectFailures };
}

/** Close every session and give the closes a moment to reach the server. */
async function closeFleet(sessions: ClientSession[]) {
	for (const session of sessions) session.close();
	await Promise.race([
		Promise.allSettled(sessions.map((s) => s.closed)),
		Bun.sleep(2000),
	]);
}

function tally(errors: Record<string, number>, err: unknown) {
	const code = errorCode(err);
	errors[code] = (errors[code] ?? 0) + 1;
}

class ExampleError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

export type ExchangeClientOptions = {
	url: string;
	caPem: string;
	sessions: number;
	/** Calls per second per session. */
	ratePerSession: number;
	durationMs: number;
	requestBytes?: number;
	responseBytes?: number;
	/** A call not answered within this is counted as `timeout`. */
	callTimeoutMs?: number;
	connectConcurrency?: number;
};

export type ExchangeReport = {
	mode: "exchange";
	sessions: number;
	connectFailures: number;
	attempted: number;
	completed: number;
	completedPerSec: number;
	rttP50Ms: number;
	rttP99Ms: number;
	errors: Record<string, number>;
};

/** One call: a fresh stream, the request, FIN, the response to its FIN. */
async function exchangeOnce(
	session: ClientSession,
	request: Uint8Array,
	responseBytes: number,
	timeoutMs: number,
): Promise<void> {
	// At maxStreamsPerSessionBidi a plain open rejects with E_LIMIT_EXCEEDED;
	// waitUntilAvailable waits for a slot instead, for at most
	// backpressureTimeoutMs, then rejects with E_BACKPRESSURE_TIMEOUT.
	const stream: Duplex = await session.createBidirectionalStream({
		waitUntilAvailable: true,
	});
	await new Promise<void>((resolve, reject) => {
		const head = new Uint8Array(4);
		let received = 0;
		const timer = setTimeout(() => {
			stream.destroy();
			reject(new ExampleError("timeout"));
		}, timeoutMs);
		stream.on("data", (chunk: Uint8Array) => {
			if (received < head.byteLength)
				head.set(chunk.subarray(0, head.byteLength - received), received);
			received += chunk.byteLength;
		});
		stream.on("end", () => {
			clearTimeout(timer);
			const echoed = new DataView(head.buffer).getUint32(0, true);
			if (received !== responseBytes || echoed !== request.byteLength)
				reject(new ExampleError("bad_response"));
			else resolve();
		});
		stream.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		stream.end(request);
	});
}

export async function runExchanges(
	opts: ExchangeClientOptions,
): Promise<ExchangeReport> {
	const requestBytes = opts.requestBytes ?? 256;
	const responseBytes = opts.responseBytes ?? 1024;
	const timeoutMs = opts.callTimeoutMs ?? 10_000;
	const { sessions, connectFailures } = await connectFleet(
		opts.url,
		opts.caPem,
		opts.sessions,
		opts.connectConcurrency ?? 50,
	);

	const request = exchangeRequest(requestBytes, responseBytes);
	const rtts: number[] = [];
	const errors: Record<string, number> = {};
	const inFlight = new Set<Promise<void>>();
	const timers: ReturnType<typeof setTimeout>[] = [];
	let attempted = 0;
	const periodMs = 1000 / opts.ratePerSession;

	const call = (session: ClientSession) => {
		attempted++;
		const started = performance.now();
		const done = exchangeOnce(session, request, responseBytes, timeoutMs).then(
			() => {
				rtts.push(performance.now() - started);
			},
			(err) => tally(errors, err),
		);
		inFlight.add(done);
		void done.finally(() => inFlight.delete(done));
	};

	const startedAt = performance.now();
	for (const session of sessions) {
		timers.push(
			setTimeout(() => {
				call(session);
				timers.push(setInterval(() => call(session), periodMs));
			}, Math.random() * periodMs),
		);
	}
	await Bun.sleep(opts.durationMs);
	for (const timer of timers) clearInterval(timer);
	const elapsedS = (performance.now() - startedAt) / 1000;
	await Promise.race([Promise.allSettled([...inFlight]), Bun.sleep(timeoutMs)]);
	await closeFleet(sessions);

	return {
		mode: "exchange",
		sessions: sessions.length,
		connectFailures,
		attempted,
		completed: rtts.length,
		completedPerSec: round(rtts.length / elapsedS, 1),
		rttP50Ms: round(percentile(rtts, 50)),
		rttP99Ms: round(percentile(rtts, 99)),
		errors,
	};
}

export type TunnelClientOptions = {
	url: string;
	caPem: string;
	sessions: number;
	/** Target bitrate of each tunnel, client to server. */
	upMbps: number;
	/** Target bitrate of each tunnel, server to client. */
	downMbps: number;
	/** Data frame size, length prefix included. */
	frameBytes?: number;
	durationMs: number;
	connectConcurrency?: number;
};

export type DirectionReport = {
	offeredMbps: number;
	sentMbps: number;
	deliveredMbps: number;
	/** (max - min) / mean of per-tunnel delivered Mbps. */
	perTunnelSpreadPct: number;
	latencyP50Ms: number;
	latencyP99Ms: number;
	bytesSent: number;
	bytesReceived: number;
	/** Every tunnel's receiver read exactly the bytes its sender wrote. */
	exact: boolean;
};

export type TunnelReport = {
	mode: "tunnel";
	sessions: number;
	connectFailures: number;
	tunnelsCompleted: number;
	errors: Record<string, number>;
	latencyClock: string;
	up: DirectionReport;
	down: DirectionReport;
};

type TunnelResult = {
	up: { offered: number; sent: number; received: number; elapsedMs: number };
	down: { offered: number; sent: number; received: number; elapsedMs: number };
	upLatency: LatencyHistogram;
	downLatency: LatencyHistogram;
};

function openTunnel(
	session: ClientSession,
	upBitsPerSec: number,
	downBitsPerSec: number,
	frameBytes: number,
) {
	const frames = new FrameReader();
	const downLatency = new LatencyHistogram();
	let downBytes = 0;
	let summary: TunnelSummary | undefined;
	let stream: Duplex | undefined;
	let sender: TunnelSender | undefined;

	const opened = (async () => {
		stream = await session.createBidirectionalStream();
		const s = stream;
		const ended = new Promise<void>((resolve, reject) => {
			s.on("data", (chunk: Uint8Array) => {
				for (const frame of frames.push(chunk)) {
					if (frame.type === Frame.Data) {
						downBytes += frame.bytes;
						downLatency.record(wallNowMs() - readDataStamp(frame.body).sentMs);
					} else if (frame.type === Frame.Summary) {
						summary = JSON.parse(new TextDecoder().decode(frame.body));
					}
				}
			});
			s.on("end", resolve);
			s.on("error", reject);
		});
		ended.catch(() => {}); // raced in finish(); this only marks it handled
		const write = (buf: Uint8Array) =>
			new Promise<void>((resolve, reject) =>
				s.write(buf, (err) => (err ? reject(err) : resolve())),
			);
		await write(tunnelHello(downBitsPerSec, frameBytes));
		sender = new TunnelSender(upBitsPerSec, frameBytes, write);
		sender.start();
		// Wrapped: an async function returning a promise would adopt it, and
		// `opened` would not settle until the tunnel ended.
		return { ended };
	})();
	opened.catch(() => {}); // awaited in finish(); this only marks it handled

	return {
		/** Stops sending, ends our side and waits for the server's summary. */
		async finish(timeoutMs: number): Promise<TunnelResult> {
			const { ended } = await opened;
			if (!sender || !stream) throw new ExampleError("not_open");
			await sender.stop();
			if (sender.error !== undefined) throw sender.error;
			stream.end();
			const timedOut = Symbol();
			const outcome = await Promise.race([
				ended,
				Bun.sleep(timeoutMs).then(() => timedOut),
			]);
			if (outcome === timedOut) {
				stream.destroy();
				throw new ExampleError("timeout");
			}
			if (!summary) throw new ExampleError("no_summary");
			return {
				up: {
					offered: sender.bytesOffered,
					sent: sender.bytesSent,
					received: summary.upBytesReceived,
					elapsedMs: sender.elapsedMs,
				},
				down: {
					offered: summary.downBytesOffered,
					sent: summary.downBytesSent,
					received: downBytes,
					elapsedMs: summary.downElapsedMs,
				},
				upLatency: LatencyHistogram.from(summary.upLatency),
				downLatency,
			};
		},
	};
}

function directionReport(
	results: TunnelResult[],
	side: "up" | "down",
	latency: LatencyHistogram,
): DirectionReport {
	const mbps = (bytes: number, ms: number) =>
		ms > 0 ? (bytes * 8) / (ms * 1000) : 0;
	const sum = (pick: (r: TunnelResult) => number) =>
		results.reduce((total, r) => total + pick(r), 0);
	const perTunnel = results.map((r) =>
		mbps(r[side].received, r[side].elapsedMs),
	);
	const mean = perTunnel.reduce((a, b) => a + b, 0) / perTunnel.length;
	return {
		offeredMbps: round(sum((r) => mbps(r[side].offered, r[side].elapsedMs))),
		sentMbps: round(sum((r) => mbps(r[side].sent, r[side].elapsedMs))),
		deliveredMbps: round(sum((r) => mbps(r[side].received, r[side].elapsedMs))),
		perTunnelSpreadPct:
			mean > 0
				? round(
						((Math.max(...perTunnel) - Math.min(...perTunnel)) / mean) * 100,
					)
				: 0,
		latencyP50Ms: round(latency.percentile(50)),
		latencyP99Ms: round(latency.percentile(99)),
		bytesSent: sum((r) => r[side].sent),
		bytesReceived: sum((r) => r[side].received),
		exact:
			results.length > 0 &&
			results.every((r) => r[side].sent === r[side].received),
	};
}

export async function runTunnels(
	opts: TunnelClientOptions,
): Promise<TunnelReport> {
	const frameBytes = opts.frameBytes ?? 1024;
	const bits = (mbps: number) => Math.round(mbps * 1_000_000);
	const { sessions, connectFailures } = await connectFleet(
		opts.url,
		opts.caPem,
		opts.sessions,
		opts.connectConcurrency ?? 50,
	);
	const tunnels = sessions.map((s) =>
		openTunnel(s, bits(opts.upMbps), bits(opts.downMbps), frameBytes),
	);
	await Bun.sleep(opts.durationMs);

	const errors: Record<string, number> = {};
	const results: TunnelResult[] = [];
	await Promise.all(
		tunnels.map((t) =>
			t.finish(10_000).then(
				(r) => results.push(r),
				(err) => tally(errors, err),
			),
		),
	);
	await closeFleet(sessions);

	const up = new LatencyHistogram();
	const down = new LatencyHistogram();
	for (const r of results) {
		up.merge(r.upLatency);
		down.merge(r.downLatency);
	}
	return {
		mode: "tunnel",
		sessions: sessions.length,
		connectFailures,
		tunnelsCompleted: results.length,
		errors,
		latencyClock:
			"one-way, sender wall clock to receiver wall clock: valid on one host only; 2% buckets",
		up: directionReport(results, "up", up),
		down: directionReport(results, "down", down),
	};
}

if (import.meta.main) {
	const args = flags({
		url: "https://127.0.0.1:4433",
		mode: "exchange",
		sessions: 100,
		seconds: 30,
		// exchange
		rate: 1,
		requestBytes: 256,
		responseBytes: 1024,
		// tunnel
		upMbps: 3,
		downMbps: 3,
		frameBytes: 1024,
	});
	const caPem = scenarioTls().caPem;
	const report =
		args.mode === "tunnel"
			? await runTunnels({
					url: args.url,
					caPem,
					sessions: args.sessions,
					upMbps: args.upMbps,
					downMbps: args.downMbps,
					frameBytes: args.frameBytes,
					durationMs: args.seconds * 1000,
				})
			: await runExchanges({
					url: args.url,
					caPem,
					sessions: args.sessions,
					ratePerSession: args.rate,
					durationMs: args.seconds * 1000,
					requestBytes: args.requestBytes,
					responseBytes: args.responseBytes,
				});
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
