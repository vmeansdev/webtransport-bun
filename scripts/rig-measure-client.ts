/**
 * One-off rig-measurement client for Phase 3.4 of the WS-WT real-number
 * campaign.
 *
 * The campaign-framework path (compare-run.ts → run-campaign.ts) is
 * quarantined at R0 until the supervisor is run on the rig, so this
 * client does a focused, raw WebSocket round-trip measurement: connect,
 * send N messages, measure RTT, write JSON. The full framework
 * integration (with the supervisor trust boundary) is a follow-up.
 *
 * Usage:
 *   bun tools/compare/bin/rig-measure-client.ts \
 *       --server-url=ws://10.99.0.2:4433 --scenario=ticker --reps=3 \
 *       --out=.release-evidence/transport-comparison/.../measurement.json
 *       --deadline-ms=30000
 */

import { writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
	let serverUrl = "ws://127.0.0.1:4433";
	let scenario = "ticker-fanout";
	let reps = 3;
	let out = "/tmp/measurement.json";
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
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 0) {
		return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
	}
	return sorted[mid] as number;
}

function percentile(values: readonly number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
	);
	return sorted[idx] as number;
}

async function oneRoundTrip(
	ws: WebSocket,
	payload: string,
	timeoutMs: number,
): Promise<number> {
	const start = performance.now();
	const sendPromise = new Promise<void>((resolve, reject) => {
		const onMessage = (event: MessageEvent): void => {
			if (typeof event.data === "string" && event.data === payload) {
				ws.removeEventListener("message", onMessage);
				resolve();
			}
		};
		ws.addEventListener("message", onMessage);
		ws.addEventListener(
			"error",
			(e) => {
				ws.removeEventListener("message", onMessage);
				reject(new Error(`ws error: ${String(e)}`));
			},
			{ once: true },
		);
		ws.send(payload);
	});
	const timeoutPromise = new Promise<never>((_, reject) => {
		setTimeout(
			() => reject(new Error(`rtt deadline exceeded: ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	await Promise.race([sendPromise, timeoutPromise]);
	return performance.now() - start;
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const path = args.serverUrl.endsWith("/")
		? args.serverUrl + args.scenario
		: `${args.serverUrl}/${args.scenario}`;
	const ca = await Bun.file(args.caPath).text();
	const isTls = args.serverUrl.startsWith("wss://");
	const wsOptions: {
		tls?: { ca: string; serverName: string; rejectUnauthorized: boolean };
	} = isTls
		? { tls: { ca, serverName: args.serverName, rejectUnauthorized: true } }
		: {};
	const allRtts: number[] = [];
	const perRep: {
		rep: number;
		rttMs: number[];
		median: number;
		p99: number;
	}[] = [];
	const overallStart = Date.now();
	const perRepTimeoutMs = Math.max(
		1000,
		Math.floor(args.deadlineMs / args.reps),
	);
	for (let rep = 0; rep < args.reps; rep++) {
		const ws = isTls ? new WebSocket(path, wsOptions) : new WebSocket(path);
		await new Promise<void>((resolve, reject) => {
			const onOpen = (): void => {
				ws.removeEventListener("open", onOpen);
				resolve();
			};
			const onError = (e: Event): void => {
				ws.removeEventListener("open", onOpen);
				reject(new Error(`ws connect failed: ${String(e)}`));
			};
			ws.addEventListener("open", onOpen);
			ws.addEventListener("error", onError, { once: true });
		});
		const rttMs: number[] = [];
		const samplesPerRep = 20;
		for (let i = 0; i < samplesPerRep; i++) {
			const payload = `r${rep}-s${i}-${Date.now()}`;
			const rtt = await oneRoundTrip(ws, payload, perRepTimeoutMs);
			rttMs.push(rtt);
			allRtts.push(rtt);
		}
		perRep.push({
			rep,
			rttMs,
			median: median(rttMs),
			p99: percentile(rttMs, 99),
		});
		ws.close();
	}
	const overallEnd = Date.now();
	const result = {
		schema: "ws-rig-measurement/v1",
		scenario: args.scenario,
		serverUrl: args.serverUrl,
		reps: args.reps,
		samplesPerRep: 20,
		startedAtMs: overallStart,
		durationMs: overallEnd - overallStart,
		aggregate: {
			count: allRtts.length,
			median: median(allRtts),
			p50: median(allRtts),
			p95: percentile(allRtts, 95),
			p99: percentile(allRtts, 99),
			min: Math.min(...allRtts),
			max: Math.max(...allRtts),
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
		`rig-measure-client: wrote ${args.out} (${allRtts.length} samples, median=${result.aggregate.median.toFixed(2)}ms p99=${result.aggregate.p99.toFixed(2)}ms)\n`,
	);
	return 0;
}

process.exit(await main());
