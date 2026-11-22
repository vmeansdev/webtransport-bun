// Member fleet for the rooms server: M rooms, each with P publishers and S
// subscribers. A publisher sends one frame per 1/fps as a burst of datagrams
// with a single sendDatagramBatch call; every member times every packet it
// receives against the publisher's stamp. With --subscribers=0 and several
// publishers that is the "everyone publishes to everyone" shape. The whole
// fleet lives in this one process, so the stamp and the receive time come
// from the same clock.
//
// Each publisher starts at a random phase of the frame period: a fleet that
// sends in lockstep is a packet impulse that overflows the server's UDP
// receive buffer before the server is busy.

import {
	type ClientSession,
	connect,
} from "../../../packages/webtransport/src/index.js";
import { scenarioTls } from "../shared/dev-tls.js";
import { flags, percentile, round } from "../shared/stats.js";
import {
	DEFAULT_FPS,
	DEFAULT_KBPS,
	DEFAULT_PACKET_BYTES,
	HEADER_BYTES,
	JOIN_TIMEOUT_MS,
	type JoinReply,
	Kind,
	packetsPerFrame,
	type Role,
	readMediaHeader,
	withTimeout,
	writeMediaHeader,
} from "./protocol.js";

export type RoomsClientOptions = {
	url: string;
	caPem: string;
	rooms: number;
	publishersPerRoom: number;
	subscribersPerRoom: number;
	durationMs: number;
	fps?: number;
	kbps?: number;
	packetBytes?: number;
	/** Prefix for room names, so two fleets can share one server. */
	roomPrefix?: string;
	/** Connects in flight at once while the fleet joins. */
	connectConcurrency?: number;
};

export type RoomsClientReport = {
	rooms: number;
	publishers: number;
	subscribers: number;
	connectFailures: number;
	joinFailures: number;
	datagramsPerFrame: number;
	offeredKbpsPerPublisher: number;
	framesSent: number;
	datagramsSent: number;
	sendErrors: number;
	receivedDatagrams: number;
	/** Received datagrams per second over the sending window. */
	receivedPerSec: number;
	/** Received over sent x (room members - 1): every other member gets each packet. */
	delivery: number;
	latencyP50Ms: number;
	latencyP99Ms: number;
};

type Member = {
	session: ClientSession;
	room: number;
	role: Role;
	publisherId: number;
};

export async function runRoomsClients(
	opts: RoomsClientOptions,
): Promise<RoomsClientReport> {
	const fps = opts.fps ?? DEFAULT_FPS;
	const kbps = opts.kbps ?? DEFAULT_KBPS;
	const packetBytes = Math.max(
		HEADER_BYTES,
		opts.packetBytes ?? DEFAULT_PACKET_BYTES,
	);
	const perFrame = packetsPerFrame(kbps, fps, packetBytes);
	const prefix = opts.roomPrefix ?? "room";

	// The whole fleet joins before any publisher sends, so every member is
	// counted for every packet.
	const queue: { room: number; role: Role }[] = [];
	for (let room = 0; room < opts.rooms; room++) {
		for (let i = 0; i < opts.subscribersPerRoom; i++)
			queue.push({ room, role: "sub" });
		for (let i = 0; i < opts.publishersPerRoom; i++)
			queue.push({ room, role: "pub" });
	}

	const members: Member[] = [];
	let connectFailures = 0;
	let joinFailures = 0;
	await Promise.all(
		Array.from({ length: opts.connectConcurrency ?? 50 }, async () => {
			for (let next = queue.shift(); next; next = queue.shift()) {
				let session: ClientSession;
				try {
					session = await connect(opts.url, { tls: { caPem: opts.caPem } });
				} catch {
					connectFailures++;
					continue;
				}
				const reply = await joinRoom(
					session,
					`${prefix}-${next.room}`,
					next.role,
				);
				if (!reply || "error" in reply) {
					joinFailures++;
					session.close();
					continue;
				}
				members.push({ session, ...next, publisherId: reply.publisherId });
			}
		}),
	);

	const latencies: number[] = [];
	const sentByRoom = new Array<number>(opts.rooms).fill(0);
	const membersByRoom = new Array<number>(opts.rooms).fill(0);
	let receivedDatagrams = 0;
	let measuring = true;
	const readers: Promise<void>[] = [];

	for (const member of members) {
		readers.push(
			(async () => {
				for await (const datagram of member.session.incomingDatagrams()) {
					if (!measuring) continue;
					const { kind, sentMs } = readMediaHeader(datagram);
					if (kind !== Kind.Media) continue;
					receivedDatagrams++;
					latencies.push(performance.now() - sentMs);
				}
			})(),
		);
		membersByRoom[member.room] = (membersByRoom[member.room] ?? 0) + 1;
	}

	const periodMs = 1000 / fps;
	const timers: ReturnType<typeof setTimeout>[] = [];
	let framesSent = 0;
	let sendErrors = 0;
	let sending = true;
	const startedAt = performance.now();

	for (const member of members) {
		if (member.role !== "pub") continue;
		// Allocated once: sendDatagramBatch copies the bytes before it returns,
		// so each frame only rewrites the headers.
		const frame = Array.from(
			{ length: perFrame },
			() => new Uint8Array(packetBytes),
		);
		let seq = 0;
		const sendFrame = () => {
			if (!sending) return;
			const now = performance.now();
			for (const packet of frame) {
				writeMediaHeader(packet, member.publisherId, seq++, now);
			}
			framesSent++;
			member.session.sendDatagramBatch(frame).then(
				(result) => {
					sentByRoom[member.room] =
						(sentByRoom[member.room] ?? 0) + result.sent;
					if (result.error) sendErrors++;
				},
				() => sendErrors++,
			);
		};
		timers.push(
			setTimeout(
				() => timers.push(setInterval(sendFrame, periodMs)),
				Math.random() * periodMs,
			),
		);
	}

	await Bun.sleep(opts.durationMs);
	sending = false;
	for (const timer of timers) clearInterval(timer);
	const elapsedS = (performance.now() - startedAt) / 1000;
	await Bun.sleep(300); // let in-flight forwards land
	measuring = false;
	for (const member of members) member.session.close();
	await Promise.race([Promise.allSettled(readers), Bun.sleep(2000)]);

	let expected = 0;
	for (let room = 0; room < opts.rooms; room++) {
		expected +=
			(sentByRoom[room] ?? 0) * Math.max(0, (membersByRoom[room] ?? 0) - 1);
	}
	const datagramsSent = sentByRoom.reduce((a, b) => a + b, 0);
	return {
		rooms: opts.rooms,
		publishers: members.filter((m) => m.role === "pub").length,
		subscribers: members.filter((m) => m.role === "sub").length,
		connectFailures,
		joinFailures,
		datagramsPerFrame: perFrame,
		offeredKbpsPerPublisher: round((perFrame * packetBytes * 8 * fps) / 1000),
		framesSent,
		datagramsSent,
		sendErrors,
		receivedDatagrams,
		receivedPerSec: Math.round(receivedDatagrams / elapsedS),
		delivery: expected > 0 ? round(receivedDatagrams / expected, 4) : 0,
		latencyP50Ms: round(percentile(latencies, 50), 3),
		latencyP99Ms: round(percentile(latencies, 99), 3),
	};
}

async function joinRoom(
	session: ClientSession,
	room: string,
	role: Role,
): Promise<JoinReply | null> {
	try {
		const stream = await session.createBidirectionalStream();
		stream.end(Buffer.from(JSON.stringify({ room, role })));
		const body = await withTimeout(
			(async () => {
				const chunks: Buffer[] = [];
				for await (const chunk of stream) chunks.push(chunk as Buffer);
				return Buffer.concat(chunks).toString("utf8");
			})(),
			JOIN_TIMEOUT_MS,
		);
		return body ? (JSON.parse(body) as JoinReply) : null;
	} catch {
		return null;
	}
}

if (import.meta.main) {
	const args = flags({
		url: "https://127.0.0.1:4433",
		rooms: 10,
		publishers: 1,
		subscribers: 10,
		fps: DEFAULT_FPS,
		kbps: DEFAULT_KBPS,
		packetBytes: DEFAULT_PACKET_BYTES,
		roomPrefix: "room",
		seconds: 10,
	});
	const report = await runRoomsClients({
		url: args.url,
		caPem: scenarioTls().caPem,
		rooms: args.rooms,
		publishersPerRoom: args.publishers,
		subscribersPerRoom: args.subscribers,
		fps: args.fps,
		kbps: args.kbps,
		packetBytes: args.packetBytes,
		roomPrefix: args.roomPrefix,
		durationMs: args.seconds * 1000,
	});
	console.log(JSON.stringify(report, null, 2));
	process.exit(0);
}
