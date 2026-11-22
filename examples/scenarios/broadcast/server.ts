// Ticker / live-data broadcast server (runbook: docs/scenarios/broadcast.md).
//
// At `hz` ticks a second the server builds one payload and sends it to every
// subscriber. By default it hands the fan-out to the native egress pacer with
// sendDatagramMirrorPaced, which spreads the packets at `pps` instead of
// emitting one packet per subscriber in the same instant. `mode: "mirror"`
// uses the unpaced, synchronous sendDatagramMirror instead, which is fine for
// small fleets and is the control the paced gate was measured against.

import {
	createServer,
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
	type EgressPacerOptions,
	type LimitsOptions,
	type RateLimitOptions,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags, percentile, round } from "../shared/stats.js";
import {
	DEFAULT_TICK_BYTES,
	DEFAULT_TICK_HZ,
	HEADER_BYTES,
	wallMs,
	writeTick,
} from "./protocol.js";

// Both mirror calls throw RangeError past 10,000 targets, so larger fleets go
// out in several calls per tick.
const MAX_TARGETS_PER_CALL = 10_000;
const SEND_MS_WINDOW = 1024;

export type BroadcastMode = "paced" | "mirror";

export type BroadcastServerOptions = {
	port: number;
	host?: string;
	tls: { certPem: string; keyPem: string };
	mode?: BroadcastMode;
	hz?: number;
	/** Datagram size including the 12-byte header; keep it under maxDatagramSize. */
	bytes?: number;
	/** Required for "paced". Process-wide: the first configuration in a process wins. */
	egressPacer?: EgressPacerOptions;
	limits?: Partial<LimitsOptions>;
	rateLimits?: Partial<RateLimitOptions>;
};

export function startBroadcastServer(opts: BroadcastServerOptions) {
	const mode = opts.mode ?? "paced";
	const hz = opts.hz ?? DEFAULT_TICK_HZ;
	const bytes = opts.bytes ?? DEFAULT_TICK_BYTES;
	if (bytes < HEADER_BYTES) {
		throw new RangeError(`bytes must be at least ${HEADER_BYTES}`);
	}
	if (mode === "paced" && !opts.egressPacer) {
		throw new Error('mode "paced" needs egressPacer: { pps, clump, queueMs }');
	}

	// Insertion-ordered set of session ids: the one subscriber list.
	const subscribers = new Set<string>();
	const counters = {
		ticks: 0,
		offered: 0,
		// Paced: targets the schedule took. Mirror: targets quinn took.
		accepted: 0,
		// Paced only: the schedule's queue was full, so the tail of the list was
		// not taken this tick.
		refused: 0,
		// The subscriber was gone by the time its turn came.
		reaped: 0,
		// The subscriber had no queued-byte budget when its turn came.
		queueFull: 0,
	};
	// How long each of the last SEND_MS_WINDOW ticks held the JS thread.
	const sendMs: number[] = [];
	// Where the next tick's target list starts. Paced admission is a prefix, so
	// without rotating the list the same trailing subscribers would be refused
	// tick after tick under saturation.
	let cursor = 0;

	const server = createServer({
		port: opts.port,
		host: opts.host,
		tls: { certPem: opts.tls.certPem, keyPem: opts.tls.keyPem },
		limits: opts.limits,
		rateLimits: opts.rateLimits,
		...(mode === "paced" ? { egressPacer: opts.egressPacer } : {}),
		onSession: (session) => {
			subscribers.add(session.id);
			void session.closed.finally(() => subscribers.delete(session.id));
		},
	});

	const onFailure = (target: string, code: string) => {
		if (code === E_SESSION_CLOSED) {
			subscribers.delete(target);
			counters.reaped++;
		} else if (code === E_QUEUE_FULL) {
			// A ticker's next value supersedes this one, so it is counted, not
			// retried. Data that must arrive goes through session.sendDatagram()
			// (the only path that waits for budget) or a stream.
			counters.queueFull++;
		}
	};

	// sendDatagramMirror and sendDatagramMirrorPaced copy the payload before
	// they return, so one buffer serves every tick.
	const payload = new Uint8Array(bytes);
	const timer = setInterval(() => {
		// Failures of earlier paced ticks arrive here, out of band.
		for (const report of server.readMirrorReports()) {
			onFailure(report.target, report.error.code);
		}
		const ids = [...subscribers];
		if (ids.length === 0) return;
		const start = cursor % ids.length;
		const targets =
			start === 0 ? ids : ids.slice(start).concat(ids.slice(0, start));

		counters.ticks++;
		writeTick(payload, counters.ticks, wallMs());
		const before = performance.now();
		let accepted = 0;
		for (let i = 0; i < targets.length; i += MAX_TARGETS_PER_CALL) {
			const chunk = targets.slice(i, i + MAX_TARGETS_PER_CALL);
			if (mode === "paced") {
				const { admitted, refused } = server.sendDatagramMirrorPaced(
					chunk,
					payload,
				);
				accepted += admitted;
				counters.refused += refused.length;
			} else {
				const { sent, failures } = server.sendDatagramMirror(chunk, payload);
				accepted += sent;
				for (const failure of failures) {
					onFailure(failure.target, failure.error.code);
				}
			}
		}
		sendMs[(counters.ticks - 1) % SEND_MS_WINDOW] = performance.now() - before;
		counters.offered += targets.length;
		counters.accepted += accepted;
		// Start the next tick at the first subscriber this one did not reach.
		cursor = start + accepted;
	}, 1000 / hz);

	return {
		server,
		mode,
		get port() {
			return server.address.port;
		},
		get subscribers() {
			return subscribers.size;
		},
		/** Counters so far, plus the JS-thread time per tick over the last 1,024 ticks. */
		stats() {
			return {
				mode,
				subscribers: subscribers.size,
				...counters,
				sendMsP50: round(percentile(sendMs, 50), 3),
				sendMsMax: round(sendMs.length ? Math.max(...sendMs) : Number.NaN, 3),
			};
		},
		async close() {
			clearInterval(timer);
			await server.close();
		},
	};
}

if (import.meta.main) {
	const args = flags({
		port: 4433,
		host: "0.0.0.0",
		mode: "paced",
		hz: DEFAULT_TICK_HZ,
		bytes: DEFAULT_TICK_BYTES,
		// pps must cover subscribers x hz with headroom: the paced gate ran
		// 5,000 x 5 Hz = 25,000/s on pps 30,000.
		pps: 30_000,
		clump: 32,
		queueMs: 250,
	});
	if (args.mode !== "paced" && args.mode !== "mirror") {
		throw new Error(`--mode must be paced or mirror, got ${args.mode}`);
	}
	const ticker = startBroadcastServer({
		port: args.port,
		host: args.host,
		tls: scenarioTls(),
		mode: args.mode,
		hz: args.hz,
		bytes: args.bytes,
		egressPacer: { pps: args.pps, clump: args.clump, queueMs: args.queueMs },
		// The per-IP buckets default to 20 handshakes/s (burst 40). A load-test
		// host is one IP carrying every subscriber, so open them up; in
		// production size them for the most subscribers behind one NAT.
		rateLimits: {
			handshakesPerSec: 10_000,
			handshakesBurst: 10_000,
			handshakesBurstPerPrefix: 10_000,
		},
		limits: { maxSessions: 20_000 },
	});
	console.log(
		`broadcast server on ${args.host}:${ticker.port} (${ticker.mode}, ${args.hz} Hz, ${args.bytes} B)`,
	);
	const report = () => {
		const m = ticker.server.metricsSnapshot();
		console.log(
			JSON.stringify({
				...ticker.stats(),
				datagramsOut: m.datagramsOut,
				datagramMirrorCalls: m.datagramMirrorCalls,
				datagramMirrorPacedCalls: m.datagramMirrorPacedCalls,
				datagramMirrorPacedTargets: m.datagramMirrorPacedTargets,
				mirrorReportsDropped: m.mirrorReportsDropped,
			}),
		);
	};
	setInterval(report, 5000);
	process.on("SIGINT", () => {
		report();
		void ticker.close().then(() => process.exit(0));
	});
}
