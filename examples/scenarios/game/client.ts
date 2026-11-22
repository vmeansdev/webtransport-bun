// Player fleet for the game server: N sessions, each sending inputs at 4 Hz
// with every 8th an action, and timing the server's ack on its own clock.
// Each player starts at a random phase of the input period so the fleet does
// not send in lockstep (a synchronized fleet is a packet impulse that
// overflows the server's UDP receive buffer long before the server is busy).

import {
	type ClientSession,
	connect,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags, percentile, round } from "../shared/stats.js";
import {
	ACTION_EVERY,
	INPUT_BYTES,
	INPUT_HZ,
	Kind,
	readStamp,
	SNAPSHOT_HZ,
	SNAPSHOT_PARTS,
	writeInput,
} from "./protocol.js";

export type GameClientOptions = {
	url: string;
	caPem: string;
	players: number;
	durationMs: number;
	/** Connects in flight at once while the fleet joins. */
	connectConcurrency?: number;
};

export type GameClientReport = {
	players: number;
	connectFailures: number;
	actionsSent: number;
	acksReceived: number;
	ackRttP50Ms: number;
	ackRttP99Ms: number;
	snapshotDatagrams: number;
	/** Snapshot datagrams received over those a perfect 5 Hz x 3 tick would send. */
	snapshotDelivery: number;
};

export async function runGameClients(
	opts: GameClientOptions,
): Promise<GameClientReport> {
	const sessions: ClientSession[] = [];
	let connectFailures = 0;
	const queue = Array.from({ length: opts.players }, (_, i) => i);
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

	const rtts: number[] = [];
	let actionsSent = 0;
	let snapshotDatagrams = 0;
	const timers: ReturnType<typeof setInterval>[] = [];
	const readers: Promise<void>[] = [];
	const periodMs = 1000 / INPUT_HZ;
	let measuring = true;
	const startedAt = performance.now();

	for (const session of sessions) {
		readers.push(
			(async () => {
				for await (const datagram of session.incomingDatagrams()) {
					const { kind, sentMs } = readStamp(datagram);
					if (kind === Kind.Ack) rtts.push(performance.now() - sentMs);
					else if (kind === Kind.Snapshot && measuring) snapshotDatagrams++;
				}
			})(),
		);
		let seq = 0;
		const send = () => {
			seq++;
			const kind = seq % ACTION_EVERY === 0 ? Kind.Action : Kind.Input;
			const input = new Uint8Array(INPUT_BYTES);
			writeInput(input, kind, seq, performance.now());
			if (kind === Kind.Action) actionsSent++;
			session.sendDatagram(input).catch(() => {});
		};
		setTimeout(
			() => timers.push(setInterval(send, periodMs)),
			Math.random() * periodMs,
		);
	}

	await Bun.sleep(opts.durationMs);
	for (const timer of timers) clearInterval(timer);
	measuring = false;
	const elapsedS = (performance.now() - startedAt) / 1000;
	await Bun.sleep(250); // let in-flight acks land
	for (const session of sessions) session.close();
	await Promise.race([Promise.allSettled(readers), Bun.sleep(2000)]);

	const expected = sessions.length * SNAPSHOT_HZ * SNAPSHOT_PARTS * elapsedS;
	return {
		players: sessions.length,
		connectFailures,
		actionsSent,
		acksReceived: rtts.length,
		ackRttP50Ms: round(percentile(rtts, 50)),
		ackRttP99Ms: round(percentile(rtts, 99)),
		snapshotDatagrams,
		snapshotDelivery: expected > 0 ? round(snapshotDatagrams / expected, 3) : 0,
	};
}

if (import.meta.main) {
	const args = flags({
		url: "https://127.0.0.1:4433",
		players: 100,
		seconds: 30,
	});
	const report = await runGameClients({
		url: args.url,
		caPem: scenarioTls().caPem,
		players: args.players,
		durationMs: args.seconds * 1000,
	});
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
