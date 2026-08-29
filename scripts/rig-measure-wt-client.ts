/**
 * WebTransport round-trip measurement client. Mirrors
 * `rig-measure-client.ts` (the WS client) so the resulting RTT samples
 * are apples-to-apples across transports. The harness on the Mac
 * (loopback) is what the WS↔WT comparison numbers come from; the rig
 * path is gated on the Linux native prebuild (not built in this
 * iteration).
 *
 * Usage:
 *   bun scripts/rig-measure-wt-client.ts \
 *     --server-url=https://10.99.0.2:4447 \
 *     --scenario=ticker-fanout --reps=3 \
 *     --out=.release-evidence/.../wt-ticker-baseline.json \
 *     --deadline-ms=60000 \
 *     --ca=/tmp/ws-wt-server.crt \
 *     --server-name=gravvene-dev-home
 */
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ClientSession, connect } from "@webtransport-bun/webtransport";

interface ClientArgs {
	readonly serverUrl: string;
	readonly scenario: string;
	readonly reps: number;
	readonly out: string;
	readonly deadlineMs: number;
	readonly caPath: string;
	readonly serverName: string;
}

function parseArgs(argv: readonly string[]): ClientArgs {
	let serverUrl = "https://127.0.0.1:4447";
	let scenario = "ticker-fanout";
	let reps = 3;
	let out = "/tmp/wt-measurement.json";
	let deadlineMs = 30_000;
	let caPath = "/tmp/ws-wt-server.crt";
	let serverName = "gravvene-dev-home";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i] as string;
		if (a.startsWith("--server-url=")) {
			serverUrl = a.slice("--server-url=".length);
		} else if (a.startsWith("--scenario=")) {
			scenario = a.slice("--scenario=".length);
		} else if (a.startsWith("--reps=")) {
			reps = Number(a.slice("--reps=".length));
		} else if (a.startsWith("--out=")) {
			out = a.slice("--out=".length);
		} else if (a.startsWith("--deadline-ms=")) {
			deadlineMs = Number(a.slice("--deadline-ms=".length));
		} else if (a.startsWith("--ca=")) {
			caPath = a.slice("--ca=".length);
		} else if (a.startsWith("--server-name=")) {
			serverName = a.slice("--server-name=".length);
		}
	}
	return { serverUrl, scenario, reps, out, deadlineMs, caPath, serverName };
}

function median(values: readonly number[]): number {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0) return 0;
	const sorted = [...finite].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
	}
	return sorted[mid] as number;
}

function percentile(values: readonly number[], p: number): number {
	const finite = values.filter((v) => Number.isFinite(v));
	if (finite.length === 0) return 0;
	const sorted = [...finite].sort((a, b) => a - b);
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[idx] as number;
}

async function connectOnce(
	url: string,
	caPath: string,
	serverName: string,
	deadlineMs: number,
): Promise<ClientSession> {
	const ca = await Bun.file(caPath).text();
	return await connect(url, {
		tls: { caPem: ca, serverName, insecureSkipVerify: false },
		limits: { handshakeTimeoutMs: deadlineMs },
	});
}

async function runSamples(
	session: ClientSession,
	samples: number,
	perRepTimeoutMs: number,
): Promise<number[]> {
	// The `incomingDatagrams()` accessor returns a cached AsyncIterable,
	// so a single consumer must drain the iterator and dispatch echoes
	// back to the in-flight sample. The client sends N datagrams with
	// monotonically-increasing sequence numbers and waits for the
	// matching sequence number to come back. The per-sample RTT is
	// the time between the send and the matching echo. Datagrams are
	// unreliable, so a sample that does not see its echo within the
	// deadline is recorded as NaN and excluded from aggregates.
	const nextSeq = (() => {
		let n = 0;
		return () => {
			n += 1;
			return n;
		};
	})();
	const sentAt = new Map<number, number>();
	const receivedAt = new Map<number, number>();
	const inflight = new Map<
		number,
		{ resolve: (rtt: number) => void; reject: (e: Error) => void }
	>();
	const encoder = new TextEncoder();
	const allInflightDone = new Promise<void>((_resolve, reject) => {
		const datagrams = session.incomingDatagrams();
		(async () => {
			try {
				for await (const datagram of datagrams) {
					if (datagram.byteLength < 4) continue;
					const b0 = datagram[0] ?? 0;
					const b1 = datagram[1] ?? 0;
					const b2 = datagram[2] ?? 0;
					const b3 = datagram[3] ?? 0;
					const seq = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0;
					const sent = sentAt.get(seq);
					if (sent === undefined) continue;
					receivedAt.set(seq, performance.now());
					const pending = inflight.get(seq);
					if (pending) {
						inflight.delete(seq);
						pending.resolve(performance.now() - sent);
					}
				}
				reject(new Error("echo stream ended with inflight samples"));
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		})();
	});
	const rtts: number[] = [];
	for (let i = 0; i < samples; i++) {
		const seq = nextSeq();
		const payload = new Uint8Array(8);
		payload[0] = (seq >>> 24) & 0xff;
		payload[1] = (seq >>> 16) & 0xff;
		payload[2] = (seq >>> 8) & 0xff;
		payload[3] = seq & 0xff;
		encoder.encodeInto("wt", payload.subarray(4));
		const start = performance.now();
		sentAt.set(seq, start);
		const samplePromise = new Promise<number>((resolve, reject) => {
			inflight.set(seq, { resolve, reject });
			setTimeout(() => {
				if (inflight.has(seq)) {
					inflight.delete(seq);
					reject(new Error(`rtt deadline exceeded: ${perRepTimeoutMs}ms`));
				}
			}, perRepTimeoutMs);
		});
		const sendP = session.sendDatagram(payload).catch(() => {});
		try {
			const rtt = await samplePromise;
			rtts.push(rtt);
		} catch {
			// Loss or timeout; record as null in the rtts array.
			rtts.push(NaN);
		}
		void sendP;
	}
	// Drain any in-flight callbacks.
	await new Promise((r) => setTimeout(r, 50));
	// The inflight map should be empty by now. Force completion.
	allInflightDone.catch(() => {});
	return rtts;
}

function _encodePayload(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const path = args.serverUrl.endsWith("/")
		? args.serverUrl + args.scenario
		: `${args.serverUrl}/${args.scenario}`;
	const samplesPerRep = Number(process.env.SAMPLES_PER_REP ?? 50);
	const perRepTimeoutMs = Math.max(
		2000,
		Math.floor(args.deadlineMs / args.reps),
	);
	const allRtts: number[] = [];
	const perRep: {
		rep: number;
		rttMs: number[];
		median: number;
		p99: number;
	}[] = [];
	const overallStart = Date.now();
	for (let rep = 0; rep < args.reps; rep++) {
		const session = await connectOnce(
			path,
			args.caPath,
			args.serverName,
			perRepTimeoutMs,
		);
		const rttMs = await runSamples(session, samplesPerRep, perRepTimeoutMs);
		perRep.push({
			rep,
			rttMs,
			median: median(rttMs),
			p99: percentile(rttMs, 99),
		});
		for (const r of rttMs) allRtts.push(r);
		session.close({ code: 0, reason: "done" });
	}
	const overallEnd = Date.now();
	const finiteAll = allRtts.filter((v) => Number.isFinite(v));
	const result = {
		schema: "wt-rig-measurement/v1",
		scenario: args.scenario,
		serverUrl: args.serverUrl,
		reps: args.reps,
		samplesPerRep,
		startedAtMs: overallStart,
		durationMs: overallEnd - overallStart,
		aggregate: {
			sent: allRtts.length,
			received: finiteAll.length,
			loss:
				allRtts.length === 0
					? 0
					: (allRtts.length - finiteAll.length) / allRtts.length,
			median: median(allRtts),
			p50: median(allRtts),
			p95: percentile(allRtts, 95),
			p99: percentile(allRtts, 99),
			min: finiteAll.length === 0 ? 0 : Math.min(...finiteAll),
			max: finiteAll.length === 0 ? 0 : Math.max(...finiteAll),
		},
		perRep,
	};
	try {
		await Bun.$`mkdir -p ${dirname(args.out)}`.quiet();
	} catch {
		// ignore
	}
	writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
	process.stdout.write(
		`rig-measure-wt-client: wrote ${args.out} (${finiteAll.length}/${allRtts.length} samples, median=${result.aggregate.median.toFixed(2)}ms p99=${result.aggregate.p99.toFixed(2)}ms loss=${(result.aggregate.loss * 100).toFixed(1)}%)\n`,
	);
	return 0;
}

process.exit(await main());
