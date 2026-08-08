#!/usr/bin/env bun

/**
 * Addon WebTransport server for Playwright interop.
 * Echoes datagrams and streams. Uses tools/interop/certs/ when present (ECDSA for Chromium).
 */

import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import {
	createServer,
	type Resettable,
	WT_RESET,
} from "../../packages/webtransport/src/index.ts";
import {
	nextWithTimeout,
	readWithTimeout,
	resolveInteropHealthPort,
	resolveInteropHealthUrl,
	resolveInteropOrigin,
	resolveInteropQuicPort,
} from "./browser-helpers.js";
import { getInteropCertPath, getInteropKeyPath } from "./cert-hash.js";
import { ensureInteropCerts } from "./prepare-certs.ts";

const QUIC_PORT = resolveInteropQuicPort();
const HEALTH_PORT = resolveInteropHealthPort();
const IDLE_TIMEOUT_MS = Number(process.env.WT_IDLE_TIMEOUT_MS ?? "60000");
const WAIT_IDLE_TIMEOUT_MS = IDLE_TIMEOUT_MS + 5_000;
const CLOSE_SIGNAL = "__WT_CLOSE_4001__";
/** `__WT_RESET_<code>__` — open a uni stream to the client and reset it with `code`. */
const RESET_SIGNAL = /^__WT_RESET_(\d+)__$/;
const MAX_CLOSE_EVENTS = 200;

type CloseEvent = {
	timestampMs: number;
	code: number;
	reason: string;
};
const closeEvents: CloseEvent[] = [];

type SessionActivity = {
	lastActivityMs: number;
};

function touchActivity(activity: SessionActivity): void {
	activity.lastActivityMs = performance.now();
}

function idleDeadline(activity: SessionActivity): () => number {
	return () => activity.lastActivityMs + WAIT_IDLE_TIMEOUT_MS;
}

function closeIterator(iter: AsyncIterator<unknown>): void {
	try {
		void Promise.resolve(iter.return?.()).catch(() => {});
	} catch {
		// Best-effort iterator cleanup only.
	}
}

async function consumeIterable<T>(
	source: AsyncIterable<T>,
	activity: SessionActivity,
	label: string,
	visit: (value: T) => void | Promise<void>,
): Promise<void> {
	const iter = source[Symbol.asyncIterator]();
	try {
		while (true) {
			const next = await nextWithTimeout(
				iter,
				WAIT_IDLE_TIMEOUT_MS,
				label,
				idleDeadline(activity),
			);
			if (next.done) return;
			touchActivity(activity);
			await visit(next.value);
		}
	} finally {
		closeIterator(iter);
	}
}

async function consumeReadable<T>(
	stream: ReadableStream<T>,
	activity: SessionActivity,
	label: string,
	visit: (value: T) => void | Promise<void>,
): Promise<void> {
	const reader = stream.getReader();
	try {
		while (true) {
			const next = await readWithTimeout(
				reader,
				WAIT_IDLE_TIMEOUT_MS,
				label,
				idleDeadline(activity),
			);
			if (next.done) return;
			touchActivity(activity);
			await visit(next.value);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Cancellation may still be settling after an idle timeout.
		}
	}
}

async function collectReadable(
	stream: ReadableStream<Uint8Array>,
	activity: SessionActivity,
	label: string,
): Promise<Uint8Array[]> {
	const chunks: Uint8Array[] = [];
	await consumeReadable(stream, activity, label, (chunk) => {
		chunks.push(chunk);
	});
	return chunks;
}

let certPath = getInteropCertPath();
let keyPath = getInteropKeyPath();
if (!existsSync(certPath) || !existsSync(keyPath)) {
	await ensureInteropCerts();
	certPath = getInteropCertPath();
	keyPath = getInteropKeyPath();
}
const certPem = existsSync(certPath) ? readFileSync(certPath, "utf-8") : "";
const keyPem = existsSync(keyPath) ? readFileSync(keyPath, "utf-8") : "";
if (!certPem || !keyPem) {
	console.warn(
		"addon-server: no ECDSA certs at",
		certPath,
		"; run 'bun run prepare:interop' for Chromium interop",
	);
}

// Optional dynamic-QPACK advertisement for the QPACK interop project. Off
// unless WT_QPACK_MAX_TABLE_CAPACITY is set, so the default interop run keeps
// static-only wire behavior.
const qpackMaxTableCapacityEnv = process.env.WT_QPACK_MAX_TABLE_CAPACITY;
const qpackMaxTableCapacity =
	qpackMaxTableCapacityEnv === undefined
		? undefined
		: Number(qpackMaxTableCapacityEnv);
if (qpackMaxTableCapacity !== undefined) {
	console.log(
		`addon-server: advertising qpackMaxTableCapacity=${qpackMaxTableCapacity}`,
	);
}

const wtServer = createServer({
	port: QUIC_PORT,
	tls: { certPem, keyPem },
	...(qpackMaxTableCapacity === undefined ? {} : { qpackMaxTableCapacity }),
	// Keep QUIC idle as a backstop above the application idle closer so the
	// harness can emit ApplicationClosed(3990) before an abrupt transport drop.
	limits: { idleTimeoutMs: IDLE_TIMEOUT_MS + 10_000 },
	onSession: async (session) => {
		const activity: SessionActivity = { lastActivityMs: performance.now() };
		void session.closed
			.then((info) => {
				closeEvents.push({
					timestampMs: Date.now(),
					code: Number(info?.code ?? 0),
					reason: String(info?.reason ?? ""),
				});
				if (closeEvents.length > MAX_CLOSE_EVENTS) closeEvents.shift();
			})
			.catch(() => {});

		// A stable application close, so server-side close events observe 3990.
		// (Chromium used to surface every server close as a bare "Connection lost"
		// because the close reached it as a QUIC CONNECTION_CLOSE; it now arrives
		// as a CLOSE_WEBTRANSPORT_SESSION capsule and carries the code and reason.)
		const idleWatch = setInterval(() => {
			if (performance.now() - activity.lastActivityMs < IDLE_TIMEOUT_MS) {
				return;
			}
			clearInterval(idleWatch);
			try {
				session.close({
					code: 3990,
					reason: "E_SESSION_IDLE_TIMEOUT",
				});
			} catch {
				// Session may already be closed by peer or transport.
			}
		}, 100);
		void Promise.resolve(session.closed).finally(() =>
			clearInterval(idleWatch),
		);

		// Datagram echo
		(async () => {
			const decoder = new TextDecoder();
			await consumeIterable(
				session.incomingDatagrams(),
				activity,
				"interop datagram receive",
				async (d) => {
					const text = decoder.decode(d);
					if (text === CLOSE_SIGNAL) {
						session.close({ code: 4001, reason: "interop-close" });
						return;
					}
					const reset = RESET_SIGNAL.exec(text);
					if (reset) {
						const code = Number(reset[1]);
						const uni = await session.createUnidirectionalStream();
						uni.write(new Uint8Array([0x01]));
						(uni as unknown as Resettable)[WT_RESET](code);
						return;
					}
					await session.sendDatagram(d);
				},
			);
		})().catch((err) => {
			console.warn("[interop-addon-server] datagram loop failed:", err);
		});
		// Bidi stream echo
		(async () => {
			await consumeReadable(
				session.incomingBidirectionalStreams,
				activity,
				"interop incoming bidi stream",
				(duplex) => {
					(async () => {
						const chunks = await collectReadable(
							duplex.readable,
							activity,
							"interop bidi stream read",
						);
						const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
						const writer = duplex.writable.getWriter();
						if (buf.length > 0) await writer.write(buf);
						await writer.close();
					})().catch((err) => {
						console.warn("[interop-addon-server] bidi stream failed:", err);
					});
				},
			);
		})().catch((err) => {
			console.warn("[interop-addon-server] incoming bidi loop failed:", err);
		});
		// Uni stream echo: read incoming, write back on new uni stream
		(async () => {
			await consumeReadable(
				session.incomingUnidirectionalStreams,
				activity,
				"interop incoming uni stream",
				(readable) => {
					(async () => {
						const chunks = await collectReadable(
							readable,
							activity,
							"interop uni stream read",
						);
						const buf = Buffer.concat(chunks);
						if (buf.length > 0) {
							const writable = await session.createUnidirectionalStream();
							writable.write(buf);
							writable.end();
						}
					})().catch((err) => {
						console.warn("[interop-addon-server] uni stream failed:", err);
					});
				},
			);
		})().catch((err) => {
			console.warn("[interop-addon-server] incoming uni loop failed:", err);
		});
	},
});

const healthServer = createHttpServer((_req, res) => {
	const req = _req;
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	if (url.pathname === "/execution-identity") {
		const body = JSON.stringify({ executionIdentity: "native-addon" });
		res.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Length": Buffer.byteLength(body),
			Connection: "close",
			"Cache-Control": "no-store",
		});
		res.end(body);
		return;
	}
	if (url.pathname === "/close-events") {
		res.writeHead(200, {
			"Content-Type": "application/json; charset=utf-8",
			Connection: "close",
			"Cache-Control": "no-store",
		});
		res.end(JSON.stringify({ closeEvents }));
		return;
	}
	res.writeHead(200, { "Content-Length": 0, Connection: "close" });
	res.end();
});

healthServer.listen(HEALTH_PORT, "127.0.0.1", () => {
	console.log(`addon-server: Health on ${resolveInteropHealthUrl()}`);
});

console.log(
	`addon-server: WebTransport on ${resolveInteropOrigin()} (idleTimeoutMs=${IDLE_TIMEOUT_MS})`,
);

process.on("SIGINT", async () => {
	healthServer.close();
	await wtServer.close();
	process.exit(0);
});
