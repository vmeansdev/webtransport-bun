// Connection-churn server (runbook: docs/scenarios/connection-churn.md).
//
// Every session gets a datagram echo and nothing else: the work under test is
// the session lifecycle (handshake, admission, teardown), not the payload.
// The CLI prints the admission counters and the native leak gauges every two
// seconds so an operator can watch them settle back to idle after a run.

import {
	createServer,
	type LimitsOptions,
	type MetricsSnapshot,
	type RateLimitOptions,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags } from "../shared/stats.js";

export type ChurnServerOptions = {
	port: number;
	host?: string;
	tls: { certPem: string; keyPem: string };
	limits?: Partial<LimitsOptions>;
	rateLimits?: Partial<RateLimitOptions>;
};

export function startChurnServer(opts: ChurnServerOptions) {
	let accepted = 0;
	let open = 0;
	let echoed = 0;

	const server = createServer({
		port: opts.port,
		host: opts.host,
		tls: { certPem: opts.tls.certPem, keyPem: opts.tls.keyPem },
		limits: opts.limits,
		rateLimits: opts.rateLimits,
		onSession: async (session) => {
			accepted++;
			open++;
			void session.closed.finally(() => open--);
			for await (const datagram of session.incomingDatagrams()) {
				echoed++;
				session.sendDatagram(datagram).catch(() => {}); // peer already gone
			}
		},
	});

	return {
		server,
		get port() {
			return server.address.port;
		},
		/** Sessions handed to onSession since start. */
		get accepted() {
			return accepted;
		},
		/** Sessions whose `closed` has not resolved yet, as JavaScript sees them. */
		get open() {
			return open;
		},
		get echoed() {
			return echoed;
		},
		close: () => server.close(),
	};
}

/**
 * The fields that tell an operator whether churn is leaving anything behind.
 * After the load stops, sessionsActive and the native registries should fall
 * back to the surviving population (0 once every client has gone).
 */
export function leakGauges(m: MetricsSnapshot) {
	return {
		sessionsActive: m.sessionsActive,
		handshakesInFlight: m.handshakesInFlight,
		sessionTasksActive: m.sessionTasksActive,
		nativeSessionRegistryEntries: m.nativeSessionRegistryEntries,
		nativeTrackedTasks: m.nativeTrackedTasks,
		nativeRateLimitEntries: m.nativeRateLimitEntries,
		nativeBidiHandlesLive: m.nativeBidiHandlesLive,
		nativeUniSendHandlesLive: m.nativeUniSendHandlesLive,
		nativeUniRecvHandlesLive: m.nativeUniRecvHandlesLive,
	};
}

if (import.meta.main) {
	const args = flags({
		port: 4433,
		host: "0.0.0.0",
		maxSessions: 2000,
		maxHandshakesInFlight: 200,
	});
	const churn = startChurnServer({
		port: args.port,
		host: args.host,
		tls: scenarioTls(),
		// The per-IP handshake bucket defaults to 20/s burst 40, and the burst
		// is also a cap on concurrent sessions per IP (100 per /24 prefix). A
		// load-test host is one IP carrying every client, so open them up; in
		// production size them for the most users behind one NAT.
		rateLimits: {
			handshakesPerSec: 10_000,
			handshakesBurst: 100_000,
			handshakesBurstPerPrefix: 100_000,
			datagramsPerSec: 1_000_000,
			datagramsBurst: 1_000_000,
		},
		limits: {
			maxSessions: args.maxSessions,
			maxHandshakesInFlight: args.maxHandshakesInFlight,
		},
	});
	console.log(`churn server on ${args.host}:${churn.port}`);

	let lastAccepted = 0;
	setInterval(() => {
		const m = churn.server.metricsSnapshot();
		console.log(
			JSON.stringify({
				acceptedPerSec: (churn.accepted - lastAccepted) / 2,
				accepted: churn.accepted,
				open: churn.open,
				limitExceededCount: m.limitExceededCount,
				rateLimitedCount: m.rateLimitedCount,
				sessionsClosedByIdle: m.sessionsClosedByIdle,
				sessionsClosedOther: m.sessionsClosedOther,
				...leakGauges(m),
			}),
		);
		lastAccepted = churn.accepted;
	}, 2000);
	process.on("SIGINT", () => void churn.close().then(() => process.exit(0)));
}
