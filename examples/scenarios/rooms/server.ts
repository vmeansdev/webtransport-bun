// Room-based selective forwarding server (runbook: docs/scenarios/live-media-rooms.md).
//
// Clients join a room as a publisher or a subscriber over their first
// bidirectional stream. Every media datagram a publisher sends is forwarded
// to every other member of its room with one sendDatagramMirror call: the
// payload crosses into native once and is shared by every target. The server
// never decodes media; it only stamps the publisher id it assigned.

import {
	createServer,
	E_SESSION_CLOSED,
	type LimitsOptions,
	type RateLimitOptions,
	type ServerSession,
	type WebTransportServer,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags } from "../shared/stats.js";
import {
	HEADER_BYTES,
	JOIN_TIMEOUT_MS,
	type JoinReply,
	type JoinRequest,
	Kind,
	MAX_JOIN_BYTES,
	setPublisher,
	withTimeout,
} from "./protocol.js";

// sendDatagramMirror takes at most 10,000 targets per call. Capping a room
// below that keeps every forward to one call; a bigger audience belongs on
// several shards, not one JS thread.
const MAX_ROOM_MEMBERS = 10_000;

export type RoomsServerOptions = {
	port: number;
	host?: string;
	tls: { certPem: string; keyPem: string };
	limits?: Partial<LimitsOptions>;
	rateLimits?: Partial<RateLimitOptions>;
};

type Member = {
	session: ServerSession;
	room: Room;
	publisherId: number; // 0 for subscribers
	// Everyone in the room but this member, rebuilt lazily when the room changes.
	targets: string[];
	targetsVersion: number;
};

type Room = {
	name: string;
	members: Map<string, Member>;
	version: number;
	nextPublisherId: number;
};

export function startRoomsServer(opts: RoomsServerOptions) {
	const rooms = new Map<string, Room>();
	const counters = {
		forwarded: 0,
		// Targets with no queued-byte budget at that instant. A late media
		// packet is worse than a lost one, so these are dropped, not retried.
		queueFull: 0,
		reaped: 0,
		joinFailures: 0,
	};

	function leave(member: Member) {
		const room = member.room;
		if (room.members.get(member.session.id) !== member) return;
		room.members.delete(member.session.id);
		room.version++;
		if (room.members.size === 0) rooms.delete(room.name);
	}

	function forward(member: Member, datagram: Uint8Array) {
		const room = member.room;
		if (member.targetsVersion !== room.version) {
			member.targets = [];
			for (const id of room.members.keys()) {
				if (id !== member.session.id) member.targets.push(id);
			}
			member.targetsVersion = room.version;
		}
		if (member.targets.length === 0) return;
		const { sent, failures } = server.sendDatagramMirror(
			member.targets,
			datagram,
		);
		counters.forwarded += sent;
		for (const failure of failures) {
			if (failure.error.code === E_SESSION_CLOSED) {
				// Gone before its closed promise settled here: the failure list is
				// the reap list.
				const gone = room.members.get(failure.target);
				if (gone) {
					counters.reaped++;
					leave(gone);
				}
			} else {
				counters.queueFull++;
			}
		}
	}

	async function join(session: ServerSession): Promise<Member | null> {
		const streams = session.incomingBidirectionalStreams.getReader();
		const first = await withTimeout(streams.read(), JOIN_TIMEOUT_MS);
		streams.releaseLock();
		if (!first || first.done) return null;
		const bidi = first.value;

		const body = await withTimeout(
			readSmall(bidi.readable, MAX_JOIN_BYTES),
			JOIN_TIMEOUT_MS,
		);
		let request: JoinRequest | null = null;
		try {
			request = body ? (JSON.parse(body) as JoinRequest) : null;
		} catch {}

		let reply: JoinReply;
		let member: Member | null = null;
		if (
			!request ||
			typeof request.room !== "string" ||
			request.room.length === 0 ||
			(request.role !== "pub" && request.role !== "sub")
		) {
			reply = { error: "bad join" };
		} else {
			let room = rooms.get(request.room);
			if (!room) {
				room = {
					name: request.room,
					members: new Map(),
					version: 0,
					nextPublisherId: 1,
				};
				rooms.set(room.name, room);
			}
			if (room.members.size >= MAX_ROOM_MEMBERS) {
				reply = { error: "room full" };
			} else {
				member = {
					session,
					room,
					publisherId: request.role === "pub" ? room.nextPublisherId++ : 0,
					targets: [],
					targetsVersion: -1,
				};
				room.members.set(session.id, member);
				room.version++;
				reply = { publisherId: member.publisherId };
			}
		}

		const writer = bidi.writable.getWriter();
		try {
			await writer.write(new TextEncoder().encode(JSON.stringify(reply)));
			await writer.close();
		} catch {
			if (member) leave(member);
			return null;
		}
		return member;
	}

	const server: WebTransportServer = createServer({
		port: opts.port,
		host: opts.host,
		tls: { certPem: opts.tls.certPem, keyPem: opts.tls.keyPem },
		limits: opts.limits,
		rateLimits: opts.rateLimits,
		onSession: async (session) => {
			const member = await join(session);
			if (!member) {
				counters.joinFailures++;
				session.close({ code: 4000, reason: "join failed" });
				return;
			}
			void session.closed.finally(() => leave(member));

			for await (const datagram of session.incomingDatagrams()) {
				// Subscribers have nothing to forward, and a short or foreign
				// datagram is not media.
				if (member.publisherId === 0) continue;
				if (datagram.length < HEADER_BYTES || datagram[0] !== Kind.Media)
					continue;
				setPublisher(datagram, member.publisherId);
				forward(member, datagram);
			}
		},
	});

	return {
		server,
		get port() {
			return server.address.port;
		},
		get rooms() {
			return rooms.size;
		},
		get members() {
			let n = 0;
			for (const room of rooms.values()) n += room.members.size;
			return n;
		},
		get forwarded() {
			return counters.forwarded;
		},
		get queueFull() {
			return counters.queueFull;
		},
		get reaped() {
			return counters.reaped;
		},
		get joinFailures() {
			return counters.joinFailures;
		},
		async close() {
			await server.close();
		},
	};
}

async function readSmall(
	readable: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<string | null> {
	const reader = readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > maxBytes) return null;
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.main) {
	const args = flags({ port: 4433, host: "0.0.0.0" });
	const rooms = startRoomsServer({
		port: args.port,
		host: args.host,
		tls: scenarioTls(),
		// The per-IP buckets default to 20 handshakes/s and 2,000 datagrams/s.
		// A load-test host is one IP carrying every publisher, so open them up;
		// in production size them for the most members behind one NAT.
		rateLimits: {
			handshakesPerSec: 10_000,
			handshakesBurst: 10_000,
			handshakesBurstPerPrefix: 10_000,
			datagramsPerSec: 1_000_000,
			datagramsBurst: 1_000_000,
		},
		limits: { maxSessions: 20_000 },
	});
	console.log(`rooms server on ${args.host}:${rooms.port}`);
	setInterval(() => {
		const m = rooms.server.metricsSnapshot();
		console.log(
			JSON.stringify({
				rooms: rooms.rooms,
				members: rooms.members,
				datagramsIn: m.datagramsIn,
				datagramsOut: m.datagramsOut,
				datagramsDropped: m.datagramsDropped,
				datagramMirrorCalls: m.datagramMirrorCalls,
				datagramMirrorTargets: m.datagramMirrorTargets,
				forwarded: rooms.forwarded,
				queueFull: rooms.queueFull,
				reaped: rooms.reaped,
				joinFailures: rooms.joinFailures,
			}),
		);
	}, 5000);
	process.on("SIGINT", () => void rooms.close().then(() => process.exit(0)));
}
