import { connect } from "../../packages/webtransport/src/index.js";

const CLIENT_ID =
	process.env.CLIENT_ID ?? `client-${Math.floor(Math.random() * 1000)}`;
const WT_URL = process.env.WT_URL ?? "https://wt-server:4433";
const PRESENCE_MS = Number(process.env.PRESENCE_MS ?? 2_000);
const CHAT_MS = Number(process.env.CHAT_MS ?? 5_000);
const UNI_MS = Number(process.env.UNI_MS ?? 8_000);

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function nowIso(): string {
	return new Date().toISOString();
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

function log(msg: string): void {
	console.log(`[${CLIENT_ID}] ${msg}`);
}

const session = await connect(WT_URL, {
	tls: { insecureSkipVerify: true },
	limits: { handshakeTimeoutMs: 15_000 },
});

await session.ready;
log(`connected -> ${WT_URL}`);

void (async () => {
	try {
		for await (const d of session.incomingDatagrams()) {
			log(`datagram echo: ${decoder.decode(d)}`);
		}
	} catch (err) {
		log(`datagram loop ended: ${String(err)}`);
	}
})();

void (async () => {
	try {
		for await (const stream of session.incomingBidirectionalStreams()) {
			void (async () => {
				const chunks: Uint8Array[] = [];
				for await (const chunk of stream) chunks.push(chunk);
				log(`bidi echo: ${decodeChunks(chunks)}`);
			})().catch((err) => log(`bidi reader failed: ${String(err)}`));
		}
	} catch (err) {
		log(`incoming bidi loop ended: ${String(err)}`);
	}
})();

void (async () => {
	try {
		for await (const readable of session.incomingUnidirectionalStreams()) {
			void (async () => {
				const chunks: Uint8Array[] = [];
				for await (const chunk of readable) chunks.push(chunk);
				log(`uni echo: ${decodeChunks(chunks)}`);
			})().catch((err) => log(`uni reader failed: ${String(err)}`));
		}
	} catch (err) {
		log(`incoming uni loop ended: ${String(err)}`);
	}
})();

const presenceTicker = setInterval(() => {
	const payload = JSON.stringify({
		type: "presence-ping",
		from: CLIENT_ID,
		at: nowIso(),
	});
	void session.sendDatagram(encoder.encode(payload));
	log(`datagram sent: ${payload}`);
}, PRESENCE_MS);

const chatTicker = setInterval(async () => {
	const payload = JSON.stringify({
		type: "chat",
		from: CLIENT_ID,
		text: `hello at ${nowIso()}`,
	});
	const stream = await session.createBidirectionalStream();
	stream.write(Buffer.from(payload));
	stream.end();
	log(`bidi sent: ${payload}`);
}, CHAT_MS);

const uniTicker = setInterval(async () => {
	const payload = JSON.stringify({
		type: "state",
		from: CLIENT_ID,
		cursor: Math.floor(Math.random() * 1000),
		at: nowIso(),
	});
	const stream = await session.createUnidirectionalStream();
	stream.write(Buffer.from(payload));
	stream.end();
	log(`uni sent: ${payload}`);
}, UNI_MS);

async function shutdown() {
	clearInterval(presenceTicker);
	clearInterval(chatTicker);
	clearInterval(uniTicker);
	session.close({ code: 1000, reason: "shutdown" });
	await session.closed;
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
