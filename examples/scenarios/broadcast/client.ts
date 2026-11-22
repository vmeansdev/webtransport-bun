// Subscriber fleet for the broadcast server: N sessions that only listen.
// Each session tracks the ticker's sequence numbers on its own, so a gap is a
// datagram that subscriber never got: delivery = received / expected, where
// expected spans the first to the last sequence that session saw while
// measuring (a loss at the very edge of the window is not counted).
//
// Age is receive time minus the server's send time stamped in the tick. The
// two clocks agree only on one host, so off-host this number is meaningless.
// It also includes the pacer's spread: the last subscriber of a paced tick is
// reached about N / pps seconds after the first.

import {
	type ClientSession,
	connect,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags, percentile, round } from "../shared/stats.js";
import { readTick, wallMs } from "./protocol.js";

export type BroadcastClientOptions = {
	url: string;
	caPem: string;
	subscribers: number;
	durationMs: number;
	/** Connects in flight at once while the fleet joins. */
	connectConcurrency?: number;
};

export type BroadcastClientReport = {
	subscribers: number;
	connectFailures: number;
	received: number;
	expected: number;
	delivery: number;
	/** Subscribers that missed at least one tick. */
	sessionsWithGaps: number;
	/** Subscribers that received nothing at all while measuring. */
	silentSessions: number;
	/** Same-host clock only. */
	sameHostAgeP50Ms: number;
	sameHostAgeP99Ms: number;
};

type Track = { first: number; last: number; received: number };

export async function runBroadcastClients(
	opts: BroadcastClientOptions,
): Promise<BroadcastClientReport> {
	const sessions: ClientSession[] = [];
	let connectFailures = 0;
	const queue = Array.from({ length: opts.subscribers }, (_, i) => i);
	await Promise.all(
		Array.from({ length: opts.connectConcurrency ?? 50 }, async () => {
			while (queue.shift() !== undefined) {
				try {
					sessions.push(
						await connect(opts.url, { tls: { caPem: opts.caPem } }),
					);
				} catch {
					connectFailures++;
				}
			}
		}),
	);

	// The fleet is joined; only ticks that arrive from here on are counted.
	let measuring = true;
	const ages: number[] = [];
	const tracks = sessions.map(
		(): Track => ({ first: -1, last: -1, received: 0 }),
	);
	const readers = sessions.map(async (session, i) => {
		const track = tracks[i] as Track;
		for await (const datagram of session.incomingDatagrams()) {
			if (!measuring) continue;
			const { seq, sentMs } = readTick(datagram);
			ages.push(wallMs() - sentMs);
			if (track.first < 0) track.first = seq;
			track.last = Math.max(track.last, seq);
			track.received++;
		}
	});

	await Bun.sleep(opts.durationMs);
	measuring = false;
	for (const session of sessions) session.close();
	await Promise.race([Promise.allSettled(readers), Bun.sleep(2000)]);

	let received = 0;
	let expected = 0;
	let sessionsWithGaps = 0;
	let silentSessions = 0;
	for (const track of tracks) {
		if (track.first < 0) {
			silentSessions++;
			continue;
		}
		const span = track.last - track.first + 1;
		received += track.received;
		expected += span;
		if (track.received < span) sessionsWithGaps++;
	}
	return {
		subscribers: sessions.length,
		connectFailures,
		received,
		expected,
		delivery: expected > 0 ? round(received / expected, 6) : 0,
		sessionsWithGaps,
		silentSessions,
		sameHostAgeP50Ms: round(percentile(ages, 50), 3),
		sameHostAgeP99Ms: round(percentile(ages, 99), 3),
	};
}

if (import.meta.main) {
	const args = flags({
		url: "https://127.0.0.1:4433",
		subscribers: 100,
		seconds: 30,
	});
	const report = await runBroadcastClients({
		url: args.url,
		caPem: scenarioTls().caPem,
		subscribers: args.subscribers,
		durationMs: args.seconds * 1000,
	});
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
