import {
	createServer,
	type ServerSession,
} from "../../packages/webtransport/src/index.js";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WT_HOST = process.env.WT_HOST ?? "0.0.0.0";
const WT_PORT = Number(process.env.WT_PORT ?? 4433);
const HTTP_HOST = process.env.HTTP_HOST ?? "0.0.0.0";
const HTTP_PORT = Number(process.env.HTTP_PORT ?? 8080);

const certPemPath = resolve(import.meta.dir, "./certs/cert.pem");
const keyPemPath = resolve(import.meta.dir, "./certs/key.pem");

const certPem = readFileSync(certPemPath, "utf8");
const keyPem = readFileSync(keyPemPath, "utf8");
const certHashBase64 = createHash("sha256")
	.update(new X509Certificate(certPem).raw)
	.digest("base64");

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const sessions = new Map<string, ServerSession>();
const RECENT_EVENTS_MAX = Number(process.env.RECENT_EVENTS_MAX ?? 200);
const recentEvents: Array<{
	at: string;
	type: string;
	detail: Record<string, unknown>;
}> = [];
const counters = {
	datagramIn: 0,
	bidiIn: 0,
	uniIn: 0,
	fanoutDatagramOut: 0,
	fanoutBidiOut: 0,
	fanoutUniOut: 0,
};

function nowIso(): string {
	return new Date().toISOString();
}

function pushEvent(type: string, detail: Record<string, unknown>) {
	recentEvents.push({ at: nowIso(), type, detail });
	if (recentEvents.length > RECENT_EVENTS_MAX) {
		recentEvents.splice(0, recentEvents.length - RECENT_EVENTS_MAX);
	}
}

function asJsonBytes(data: unknown): Uint8Array {
	return encoder.encode(JSON.stringify(data));
}

function decodeChunks(chunks: Uint8Array[]): string {
	const total = chunks.reduce((n, c) => n + c.length, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return decoder.decode(merged);
}

async function sendDatagramToAll(payload: unknown): Promise<void> {
	const msg = asJsonBytes(payload);
	counters.fanoutDatagramOut += sessions.size;
	await Promise.allSettled(
		[...sessions.values()].map((session) => session.sendDatagram(msg)),
	);
}

async function sendBidiToAll(payload: unknown): Promise<void> {
	const msg = asJsonBytes(payload);
	counters.fanoutBidiOut += sessions.size;
	await Promise.allSettled(
		[...sessions.values()].map(async (session) => {
			const stream = await session.createBidirectionalStream();
			stream.write(Buffer.from(msg));
			stream.end();
		}),
	);
}

async function sendUniToAll(payload: unknown): Promise<void> {
	const msg = asJsonBytes(payload);
	counters.fanoutUniOut += sessions.size;
	await Promise.allSettled(
		[...sessions.values()].map(async (session) => {
			const stream = await session.createUnidirectionalStream();
			stream.write(Buffer.from(msg));
			stream.end();
		}),
	);
}

function roomSnapshot() {
	return {
		type: "snapshot",
		at: nowIso(),
		sessions: [...sessions.values()].map((s) => ({
			id: s.id,
			peer: `${s.peer.ip}:${s.peer.port}`,
		})),
	};
}

const wtServer = createServer({
	host: WT_HOST,
	port: WT_PORT,
	tls: { certPem, keyPem },
	onSession: async (session) => {
		sessions.set(session.id, session);
		console.log(
			`[server] session joined id=${session.id} peer=${session.peer.ip}:${session.peer.port}`,
		);
		pushEvent("session.join", {
			sessionId: session.id,
			peer: `${session.peer.ip}:${session.peer.port}`,
			activeSessions: sessions.size,
		});

		await sendDatagramToAll({
			type: "presence",
			action: "join",
			sessionId: session.id,
			at: nowIso(),
		});

		await sendUniToAll(roomSnapshot());

		void (async () => {
			try {
				for await (const datagram of session.incomingDatagrams()) {
					counters.datagramIn++;
					const body = decoder.decode(datagram);
					pushEvent("datagram.in", { fromSessionId: session.id, body });
					await sendDatagramToAll({
						type: "presence",
						channel: "datagram",
						fromSessionId: session.id,
						body,
						at: nowIso(),
					});
				}
			} catch (err) {
				console.warn("[server] datagram loop error:", err);
			}
		})();

		void (async () => {
			try {
				for await (const duplex of session.incomingBidirectionalStreams) {
					void (async () => {
						const chunks: Uint8Array[] = [];
						for await (const chunk of duplex.readable) chunks.push(chunk);
						counters.bidiIn++;
						const body = decodeChunks(chunks);
						pushEvent("bidi.in", { fromSessionId: session.id, body });
						await sendBidiToAll({
							type: "chat",
							channel: "bidi",
							fromSessionId: session.id,
							body,
							at: nowIso(),
						});
					})().catch((err) => console.warn("[server] bidi worker error:", err));
				}
			} catch (err) {
				console.warn("[server] incoming bidi loop error:", err);
			}
		})();

		void (async () => {
			try {
				for await (const readable of session.incomingUnidirectionalStreams) {
					void (async () => {
						const chunks: Uint8Array[] = [];
						for await (const chunk of readable) chunks.push(chunk);
						counters.uniIn++;
						const body = decodeChunks(chunks);
						pushEvent("uni.in", { fromSessionId: session.id, body });
						await sendUniToAll({
							type: "update",
							channel: "uni",
							fromSessionId: session.id,
							body,
							at: nowIso(),
						});
					})().catch((err) => console.warn("[server] uni worker error:", err));
				}
			} catch (err) {
				console.warn("[server] incoming uni loop error:", err);
			}
		})();

		void session.closed.then(async () => {
			sessions.delete(session.id);
			console.log(`[server] session left id=${session.id}`);
			pushEvent("session.leave", {
				sessionId: session.id,
				activeSessions: sessions.size,
			});
			await sendDatagramToAll({
				type: "presence",
				action: "leave",
				sessionId: session.id,
				at: nowIso(),
			});
			await sendUniToAll(roomSnapshot());
		});
	},
});

const httpServer = Bun.serve({
	hostname: HTTP_HOST,
	port: HTTP_PORT,
	fetch(req) {
		const url = new URL(req.url);
		if (url.pathname === "/") {
			return new Response(
				Bun.file(resolve(import.meta.dir, "./public/index.html")),
				{
					headers: { "content-type": "text/html; charset=utf-8" },
				},
			);
		}
		if (url.pathname === "/state") {
			return Response.json({
				now: nowIso(),
				activeSessions: sessions.size,
				sessions: [...sessions.values()].map((s) => ({
					id: s.id,
					peer: `${s.peer.ip}:${s.peer.port}`,
				})),
				counters,
				recentEvents,
			});
		}
		if (url.pathname === "/healthz") {
			return Response.json({
				ok: true,
				sessions: sessions.size,
				wtPort: WT_PORT,
				certHashBase64,
			});
		}
		return new Response("ok\n", {
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	},
});

console.log(`[server] health: http://${HTTP_HOST}:${HTTP_PORT}/healthz`);
console.log(`[server] dashboard: http://${HTTP_HOST}:${HTTP_PORT}/`);
console.log(`[server] WebTransport: https://0.0.0.0:${WT_PORT}`);

const snapshotTicker = setInterval(() => {
	void sendUniToAll(roomSnapshot());
}, 10_000);

async function shutdown() {
	clearInterval(snapshotTicker);
	httpServer.stop(true);
	await wtServer.close();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
