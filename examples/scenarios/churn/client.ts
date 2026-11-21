// Churn load for the churn server, in two populations:
//
//   base      B long-lived sessions pinging every ~200 ms, at random phases,
//             timing the echo on their own clock (the users who stay)
//   churners  new sessions opened at R per second, spread evenly over each
//             second; each does one ping exchange and closes (page reloads,
//             short mobile visits)
//
// A refused or failed dial is retried with jittered exponential backoff, as
// docs/OPERATIONS.md ("Admission control") asks of every client: a refusal at
// maxSessions or maxHandshakesInFlight means "not right now". A base session
// that drops is counted as lost and redialled the same way.

import {
	type ClientSession,
	connect,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags, percentile, round } from "../shared/stats.js";

// client send time f64 (ms, client clock), zero padding
const PING_BYTES = 32;
const FIRST_PING_TRIES = 3;
const FIRST_PING_RETRY_MS = 300;
const SCHEDULE_TICK_MS = 10;
const BASE_STAGGER_MS = 5;

export type RetryPolicy = {
	/** Dials per session before giving up, the first one included. */
	attempts: number;
	baseMs: number;
	maxMs: number;
};

export const DEFAULT_RETRY: RetryPolicy = {
	attempts: 6,
	baseMs: 200,
	maxMs: 5000,
};

/**
 * Delay before retry `n` (0 for the first retry): exponential, capped, with
 * ±50% jitter. The jitter is the part that matters: a fleet retrying on a
 * fixed timer comes back as the same synchronized wave it was refused for.
 */
export function backoffMs(n: number, policy: RetryPolicy): number {
	const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** n);
	return ceiling * (0.5 + Math.random());
}

/**
 * The `E_*` code of a failed connect, or "unknown". What each admission
 * refusal looks like to a client:
 *
 *   per-IP / per-prefix rate limit   E_RATE_LIMITED (HTTP 429 on the CONNECT)
 *   maxSessions                      E_LIMIT_EXCEEDED (closed with 3992)
 *   maxHandshakesInFlight            E_INTERNAL, message "the server refused
 *                                    to accept a new connection" (QUIC
 *                                    CONNECTION_REFUSED has no stable code
 *                                    yet, so it is told apart by message)
 */
export function failureCode(err: unknown): string {
	const { code, message } = (err ?? {}) as {
		code?: unknown;
		message?: unknown;
	};
	if (typeof code !== "string") return "unknown";
	if (
		code === "E_INTERNAL" &&
		String(message).includes("refused to accept a new connection")
	) {
		return "E_INTERNAL (CONNECTION_REFUSED)";
	}
	return code;
}

export type ChurnClientOptions = {
	url: string;
	caPem: string;
	baseSessions: number;
	/** New churn sessions per second. */
	churnPerSec: number;
	durationMs: number;
	pingIntervalMs?: number;
	retry?: RetryPolicy;
	/** Churners allowed in flight at once; past it a launch is skipped and counted. */
	maxChurnersInFlight?: number;
	/** Runs once the churners have drained, while the base population is still connected. */
	afterChurn?: () => Promise<void> | void;
};

export type ChurnClientReport = {
	targetPerSec: number;
	/** Churn sessions established (first echo or open after the ping tries) per second of the window. */
	achievedPerSec: number;
	churnLaunched: number;
	churnEstablished: number;
	churnGaveUp: number;
	churnSkipped: number;
	churnUnfinished: number;
	connectRetries: number;
	/** Failed dials by error code; a refusal that closed right after connect is "close <code> <reason>". */
	connectFailures: Record<string, number>;
	connectP50Ms: number;
	connectP99Ms: number;
	firstPingTimeouts: number;
	baseSessions: number;
	baseConnected: number;
	baseLost: number;
	baseGaveUp: number;
	basePingsSent: number;
	baseDelivery: number;
	baseRttP50Ms: number;
	baseRttP99Ms: number;
};

type Live = {
	session: ClientSession;
	reader: Promise<void>;
	onEcho: (sentMs: number) => void;
};

function sendPing(session: ClientSession) {
	const ping = new Uint8Array(PING_BYTES);
	new DataView(ping.buffer).setFloat64(0, performance.now(), true);
	session.sendDatagram(ping).catch(() => {}); // datagrams are best effort
}

function closeInfoCode(info: { code?: number; reason?: string }): string {
	return `close ${info.code ?? "-"}${info.reason ? ` ${info.reason}` : ""}`;
}

export async function runChurnClients(
	opts: ChurnClientOptions,
): Promise<ChurnClientReport> {
	const policy = opts.retry ?? DEFAULT_RETRY;
	const pingIntervalMs = opts.pingIntervalMs ?? 200;
	const maxInFlight = opts.maxChurnersInFlight ?? 5000;

	const connectFailures: Record<string, number> = {};
	const connectMs: number[] = [];
	let connectRetries = 0;
	let firstPingTimeouts = 0;
	const fail = (code: string) => {
		connectFailures[code] = (connectFailures[code] ?? 0) + 1;
	};

	// One dial, retried until the session answers a ping or the policy runs
	// out. A session that closes before its first echo was refused after the
	// handshake (maxSessions closes with 3992 / E_LIMIT_EXCEEDED), so that is
	// retried too; one that stays open without echoing just lost datagrams.
	async function dial(): Promise<Live | null> {
		for (let attempt = 0; attempt < policy.attempts; attempt++) {
			if (attempt > 0) {
				connectRetries++;
				await Bun.sleep(backoffMs(attempt - 1, policy));
			}
			const started = performance.now();
			let session: ClientSession;
			try {
				session = await connect(opts.url, { tls: { caPem: opts.caPem } });
			} catch (err) {
				const code = failureCode(err);
				fail(code);
				if (code === "E_TLS") break; // a certificate problem does not heal on retry
				continue;
			}
			const live: Live = {
				session,
				reader: Promise.resolve(),
				onEcho: () => {},
			};
			live.reader = (async () => {
				for await (const datagram of session.incomingDatagrams()) {
					const view = new DataView(
						datagram.buffer,
						datagram.byteOffset,
						datagram.byteLength,
					);
					live.onEcho(view.getFloat64(0, true));
				}
			})().catch(() => {});

			let timer: ReturnType<typeof setTimeout> | undefined;
			const outcome = await new Promise<"echo" | "closed" | "timeout">(
				(resolve) => {
					live.onEcho = () => resolve("echo");
					void session.closed.then(() => resolve("closed"));
					let sends = 0;
					const ping = () => {
						if (sends++ === FIRST_PING_TRIES) return resolve("timeout");
						sendPing(session);
						timer = setTimeout(ping, FIRST_PING_RETRY_MS);
					};
					ping();
				},
			);
			clearTimeout(timer);
			live.onEcho = () => {};
			if (outcome === "closed") {
				fail(closeInfoCode(await session.closed));
				continue;
			}
			if (outcome === "timeout") firstPingTimeouts++;
			connectMs.push(performance.now() - started);
			return live;
		}
		return null;
	}

	let stopping = false;
	let stop!: () => void;
	const stopped = new Promise<void>((resolve) => {
		stop = resolve;
	});

	// Base population: dial, ping on a timer, redial if the session drops.
	let measuring = false;
	let measureStart = Number.POSITIVE_INFINITY;
	let measureEnd = Number.POSITIVE_INFINITY;
	const rtts: number[] = [];
	let basePingsSent = 0;
	let baseEchoes = 0;
	let baseConnected = 0;
	let baseLost = 0;
	let baseGaveUp = 0;
	let baseSettled = 0;
	let baseReady!: () => void;
	const baseAllSettled = new Promise<void>((resolve) => {
		baseReady = resolve;
	});
	const settleBase = () => {
		if (++baseSettled === opts.baseSessions) baseReady();
	};
	if (opts.baseSessions === 0) baseReady();

	async function baseMember(index: number) {
		await Bun.sleep(index * BASE_STAGGER_MS);
		let first = true;
		while (!stopping) {
			const live = await dial();
			if (!live) {
				baseGaveUp++;
				if (first) settleBase();
				return;
			}
			if (first) {
				baseConnected++;
				settleBase();
				first = false;
			}
			live.onEcho = (sentMs) => {
				if (sentMs < measureStart || sentMs > measureEnd) return;
				baseEchoes++;
				rtts.push(performance.now() - sentMs);
			};
			let interval: ReturnType<typeof setInterval> | undefined;
			const phase = setTimeout(() => {
				interval = setInterval(() => {
					sendPing(live.session);
					if (measuring) basePingsSent++;
				}, pingIntervalMs);
			}, Math.random() * pingIntervalMs);
			await Promise.race([live.session.closed, stopped]);
			clearTimeout(phase);
			clearInterval(interval);
			if (stopping) {
				live.session.close();
				await Promise.race([live.session.closed, Bun.sleep(2000)]);
				return;
			}
			baseLost++;
		}
	}

	const base = Array.from({ length: opts.baseSessions }, (_, i) =>
		baseMember(i),
	);
	await Promise.race([
		baseAllSettled,
		Bun.sleep(opts.baseSessions * BASE_STAGGER_MS + 30_000),
	]);

	// Churners: launch on an absolute schedule so the rate is spread evenly
	// across each second (at SCHEDULE_TICK_MS resolution) instead of bursting.
	let churnLaunched = 0;
	let churnEstablished = 0;
	let establishedInWindow = 0;
	let churnGaveUp = 0;
	let churnSkipped = 0;
	const inFlight = new Set<Promise<void>>();

	async function churnOnce() {
		const live = await dial();
		if (!live) {
			churnGaveUp++;
			return;
		}
		churnEstablished++;
		if (measuring) establishedInWindow++;
		live.session.close();
		await Promise.race([live.session.closed, Bun.sleep(2000)]);
	}

	measureStart = performance.now();
	measuring = true;
	while (performance.now() - measureStart < opts.durationMs) {
		const due = Math.floor(
			((performance.now() - measureStart) / 1000) * opts.churnPerSec,
		);
		while (churnLaunched < due) {
			churnLaunched++;
			if (inFlight.size >= maxInFlight) {
				churnSkipped++;
				continue;
			}
			const task: Promise<void> = churnOnce().finally(() =>
				inFlight.delete(task),
			);
			inFlight.add(task);
		}
		await Bun.sleep(SCHEDULE_TICK_MS);
	}
	measuring = false;
	measureEnd = performance.now();
	const elapsedS = (measureEnd - measureStart) / 1000;

	await Promise.race([Promise.allSettled([...inFlight]), Bun.sleep(15_000)]);
	await Bun.sleep(250); // let the last base echoes land
	await opts.afterChurn?.();
	stopping = true;
	stop();
	await Promise.race([Promise.allSettled(base), Bun.sleep(5000)]);

	return {
		targetPerSec: opts.churnPerSec,
		achievedPerSec: round(establishedInWindow / elapsedS),
		churnLaunched,
		churnEstablished,
		churnGaveUp,
		churnSkipped,
		churnUnfinished: inFlight.size,
		connectRetries,
		connectFailures,
		connectP50Ms: round(percentile(connectMs, 50)),
		connectP99Ms: round(percentile(connectMs, 99)),
		firstPingTimeouts,
		baseSessions: opts.baseSessions,
		baseConnected,
		baseLost,
		baseGaveUp,
		basePingsSent,
		baseDelivery: basePingsSent > 0 ? round(baseEchoes / basePingsSent, 5) : 0,
		baseRttP50Ms: round(percentile(rtts, 50)),
		baseRttP99Ms: round(percentile(rtts, 99)),
	};
}

if (import.meta.main) {
	const args = flags({
		url: "https://127.0.0.1:4433",
		base: 50,
		rate: 50,
		seconds: 10,
		pingMs: 200,
	});
	const report = await runChurnClients({
		url: args.url,
		caPem: scenarioTls().caPem,
		baseSessions: args.base,
		churnPerSec: args.rate,
		durationMs: args.seconds * 1000,
		pingIntervalMs: args.pingMs,
	});
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
