// Realtime game / MMO realm server (runbook: docs/scenarios/realtime-games.md).
//
// Players send small input datagrams; every 8th is an action the server
// acknowledges on receipt. A world tick sends each player an interest-managed
// snapshot split into three datagrams. The tick is spread over ten slices so
// the server never emits one packet per player in the same instant.

import {
	createServer,
	type LimitsOptions,
	type RateLimitOptions,
	type ServerSession,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags } from "../shared/stats.js";
import {
	ACK_BYTES,
	Kind,
	SNAPSHOT_HZ,
	SNAPSHOT_PART_BYTES,
	SNAPSHOT_PARTS,
} from "./protocol.js";

const SLICES = 10;

export type GameServerOptions = {
	port: number;
	host?: string;
	tls: { certPem: string; keyPem: string };
	limits?: Partial<LimitsOptions>;
	rateLimits?: Partial<RateLimitOptions>;
};

type Player = {
	session: ServerSession;
	slice: number;
	snapshot: Uint8Array[];
};

export function startGameServer(opts: GameServerOptions) {
	const players = new Map<string, Player>();
	let nextSlice = 0;
	let tick = 0;
	let snapshotErrors = 0;

	const server = createServer({
		port: opts.port,
		host: opts.host,
		tls: { certPem: opts.tls.certPem, keyPem: opts.tls.keyPem },
		limits: opts.limits,
		rateLimits: opts.rateLimits,
		onSession: async (session) => {
			// Snapshot buffers are allocated once per player and only their
			// header is rewritten per tick: sendDatagramBatch copies the bytes
			// before it returns, so reusing them is safe and keeps the tick
			// allocation-free.
			const player: Player = {
				session,
				slice: nextSlice++ % SLICES,
				snapshot: Array.from(
					{ length: SNAPSHOT_PARTS },
					() => new Uint8Array(SNAPSHOT_PART_BYTES),
				),
			};
			players.set(session.id, player);
			void session.closed.finally(() => players.delete(session.id));

			for await (const datagram of session.incomingDatagrams()) {
				if (datagram[0] !== Kind.Action) continue; // inputs feed the simulation; nothing to send back
				const ack = new Uint8Array(ACK_BYTES);
				ack.set(datagram.subarray(0, 13)); // echo seq + client send time
				ack[0] = Kind.Ack;
				session.sendDatagram(ack).catch(() => {}); // session closing: nothing to acknowledge
			}
		},
	});

	const sliceMs = 1000 / SNAPSHOT_HZ / SLICES;
	let slice = 0;
	const timer = setInterval(() => {
		if (slice === 0) tick++;
		const now = performance.now();
		for (const player of players.values()) {
			if (player.slice !== slice) continue;
			player.snapshot.forEach((part, index) => {
				const view = new DataView(part.buffer);
				view.setUint8(0, Kind.Snapshot);
				view.setUint32(1, tick, true);
				view.setFloat64(5, now, true);
				view.setUint8(13, index);
			});
			player.session.sendDatagramBatch(player.snapshot).then(
				(result) => {
					if (result.error) snapshotErrors++;
				},
				() => snapshotErrors++,
			);
		}
		slice = (slice + 1) % SLICES;
	}, sliceMs);

	return {
		server,
		get port() {
			return server.address.port;
		},
		get players() {
			return players.size;
		},
		get snapshotErrors() {
			return snapshotErrors;
		},
		async close() {
			clearInterval(timer);
			await server.close();
		},
	};
}

if (import.meta.main) {
	const args = flags({ port: 4433, host: "0.0.0.0" });
	const game = startGameServer({
		port: args.port,
		host: args.host,
		tls: scenarioTls(),
		// The per-IP buckets default to 20 handshakes/s and 2,000 datagrams/s.
		// A load-test host is one IP carrying every player, so open them up;
		// in production size them for the most players behind one NAT.
		rateLimits: {
			handshakesPerSec: 10_000,
			handshakesBurst: 10_000,
			handshakesBurstPerPrefix: 10_000,
			datagramsPerSec: 1_000_000,
			datagramsBurst: 1_000_000,
		},
		limits: { maxSessions: 20_000 },
	});
	console.log(`game server on ${args.host}:${game.port}`);
	setInterval(() => {
		const m = game.server.metricsSnapshot();
		console.log(
			JSON.stringify({
				players: game.players,
				datagramsIn: m.datagramsIn,
				datagramsOut: m.datagramsOut,
				datagramsDropped: m.datagramsDropped,
				snapshotErrors: game.snapshotErrors,
			}),
		);
	}, 5000);
	process.on("SIGINT", () => void game.close().then(() => process.exit(0)));
}
