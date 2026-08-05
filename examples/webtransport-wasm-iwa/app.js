// Release IWA proof harness. This module deliberately validates that it is
// executing in an installed Isolated Web App before opening Direct Sockets;
// loading the page or finding a UDPSocket-shaped mock is not release evidence.
//
// Both peers drive the W3C surface only: ReadableStream/WritableStream for
// streams, `datagrams.readable`/`datagrams.writable` for datagrams. The
// deprecated onDatagram/onIncomingStream callbacks are mutually exclusive with
// that surface on a single session, so mixing them is a hard error.

import initWasm, * as wasm from "./vendor/webtransport_wasm.js";
import {
	connectWasm,
	createServer,
	DirectSocketsUdpTransport,
	serverCertificateHashes,
	WasmWebTransport,
} from "./vendor/webtransport-wasm.js";

const EXECUTION_IDENTITY = "browser-iwa-direct-sockets";
const PRIMARY_PORT = 4433;
const ROTATED_PORT = 4434;
const RESET_CODE = 37;
const STOP_SENDING_CODE = 41;
const PEER_CLOSE_CODE = 4100;
const STEP_TIMEOUT_MS = 10_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const logEl = document.getElementById("log");
const hashEl = document.getElementById("hash");

function log(...args) {
	logEl.textContent += `${args.join(" ")}\n`;
}

function monotonicNowMs() {
	return performance.now();
}

function createMonotonicDeadline(timeoutMs, now = monotonicNowMs) {
	const deadlineMs = now() + timeoutMs;
	return {
		remainingMs: () => Math.max(0, deadlineMs - now()),
		expired: () => deadlineMs <= now(),
	};
}

function remainingDeadlineMs(deadline) {
	return deadline
		? Math.max(0, deadline.remainingMs())
		: Number.POSITIVE_INFINITY;
}

function withDeadline(
	promise,
	label,
	timeoutMs = STEP_TIMEOUT_MS,
	deadline = undefined,
) {
	let timer;
	const operationDeadline = createMonotonicDeadline(timeoutMs);
	const effectiveDelayMs = Math.min(
		operationDeadline.remainingMs(),
		remainingDeadlineMs(deadline),
	);
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
				effectiveDelayMs,
			);
		}),
	]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function concat(chunks) {
	const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const payload = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		payload.set(chunk, offset);
		offset += chunk.length;
	}
	return payload;
}

/** Drain a readable to completion and return the concatenated bytes. */
async function readAll(readable) {
	const reader = readable.getReader();
	const chunks = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value && value.length > 0) chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return concat(chunks);
}

async function writeAndClose(writable, payload) {
	const writer = writable.getWriter();
	try {
		await writer.write(payload);
		await writer.close();
	} finally {
		writer.releaseLock();
	}
}

function validateExecutionIdentity() {
	assert(
		location.protocol === "isolated-app:",
		`expected isolated-app: execution, got ${location.protocol}`,
	);
	assert(
		typeof globalThis.UDPSocket === "function",
		"Direct Sockets UDPSocket is unavailable in the installed IWA",
	);
	assert(
		globalThis.crossOriginIsolated === true,
		"IWA is not cross-origin isolated",
	);
	return {
		executionIdentity: EXECUTION_IDENTITY,
		origin: location.origin,
		protocol: location.protocol,
		crossOriginIsolated: globalThis.crossOriginIsolated,
		directSockets: true,
	};
}

async function serveDatagrams(session) {
	for await (const data of session.incomingDatagrams()) {
		if (decoder.decode(data) === "__IWA_PEER_CLOSE__") {
			session.close({ code: PEER_CLOSE_CODE, reason: "iwa-peer-close" });
			return;
		}
		await session.sendDatagram(data);
	}
}

// Echo a peer-opened bidi stream, honouring the two control messages. The
// control codes travel as the cancel/abort reason: `writable.abort(code)` is
// RESET_STREAM, `readable.cancel(code)` is STOP_SENDING.
async function serveBidiStream({ readable, writable }) {
	const reader = readable.getReader();
	const writer = writable.getWriter();
	let control = null;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value || value.length === 0) continue;
			const text = decoder.decode(value);
			if (text === "__IWA_RESET__") {
				control = "reset";
				break;
			}
			if (text === "__IWA_STOP_SENDING__") {
				control = "stop";
				break;
			}
			await writer.write(value);
		}
		if (control === null) await writer.close();
	} finally {
		reader.releaseLock();
		writer.releaseLock();
		if (control === "reset") {
			await writable.abort(RESET_CODE).catch(() => {});
		} else if (control === "stop") {
			await readable.cancel(STOP_SENDING_CODE).catch(() => {});
		}
	}
}

async function serveBidiStreams(session) {
	const reader = session.incomingBidirectionalStreams.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		if (!value) continue;
		serveBidiStream(value).catch((error) =>
			log("server bidi error:", String(error)),
		);
	}
}

// Uni is one-way in each direction: collect the peer's stream, then echo the
// payload back on a fresh outgoing uni stream.
async function serveUniStreams(session) {
	const reader = session.incomingUnidirectionalStreams.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		if (!value) continue;
		readAll(value)
			.then(async (payload) => {
				const outgoing = await session.createUnidirectionalStream();
				await writeAndClose(outgoing, payload);
			})
			.catch((error) => log("server uni error:", String(error)));
	}
}

function installServerSession(session) {
	// Session teardown makes every pump reject; that is the normal exit path.
	const ignoreAfterClose = (error) => {
		void error;
	};
	void serveDatagrams(session).catch(ignoreAfterClose);
	void serveBidiStreams(session).catch(ignoreAfterClose);
	void serveUniStreams(session).catch(ignoreAfterClose);
}

const servers = new Map();

async function startServer(port) {
	const existing = servers.get(port);
	if (existing) return existing;
	const server = await withDeadline(
		createServer({
			host: "127.0.0.1",
			port,
			tls: {
				allowSelfSigned: true,
				commonName: "localhost",
				validityDays: 14,
			},
			wasm,
			onSession: installServerSession,
		}),
		`start IWA server on UDP ${port}`,
	);
	servers.set(port, server);
	return server;
}

/**
 * A client view over one session. The incoming-uni pump starts at construction
 * so the wasm facade subscribes before the server can echo: the incoming
 * ReadableStream only wires itself up on its first pull.
 */
function createClient(session) {
	const transport = new WasmWebTransport(session);
	const uniQueue = [];
	const uniWaiters = [];
	let datagramReader = null;
	let datagramWriter = null;

	void (async () => {
		const reader = transport.incomingUnidirectionalStreams.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (!value) continue;
			const waiter = uniWaiters.shift();
			if (waiter) waiter(value);
			else uniQueue.push(value);
		}
	})().catch(() => {
		// The session closed; a pending nextIncomingUni() call fails on its own
		// step deadline rather than hanging.
	});

	return {
		transport,
		datagrams() {
			datagramReader ??= transport.datagrams.readable.getReader();
			datagramWriter ??= transport.datagrams.writable.getWriter();
			return { reader: datagramReader, writer: datagramWriter };
		},
		nextIncomingUni() {
			const queued = uniQueue.shift();
			if (queued) return Promise.resolve(queued);
			return new Promise((resolve) => uniWaiters.push(resolve));
		},
	};
}

async function openClient(port, certHashBase64) {
	const udp = await withDeadline(
		DirectSocketsUdpTransport.connect("127.0.0.1", port),
		`open Direct Sockets client for ${port}`,
	);
	try {
		const connected = await withDeadline(
			connectWasm(wasm, udp, "localhost", "127.0.0.1:0", `127.0.0.1:${port}`, {
				certHashBase64,
			}),
			`connect WASM WebTransport client to ${port}`,
		);
		const client = createClient(connected.session);
		return {
			...client,
			async close() {
				connected.manager.close();
				await udp.close();
			},
		};
	} catch (error) {
		await udp.close();
		throw error;
	}
}

async function datagramRoundTrip(client, payload) {
	const { reader, writer } = client.datagrams();
	await writer.write(encoder.encode(payload));
	const { value } = await withDeadline(reader.read(), "IWA datagram echo");
	const echoed = decoder.decode(value);
	assert(echoed === payload, `datagram mismatch: ${echoed}`);
	return echoed;
}

async function bidiRoundTrip(client, payload) {
	const stream = await client.transport.createBidirectionalStream();
	await writeAndClose(stream.writable, encoder.encode(payload));
	const echoed = decoder.decode(
		await withDeadline(readAll(stream.readable), "IWA bidi echo"),
	);
	assert(echoed === payload, `bidi mismatch: ${echoed}`);
	return echoed;
}

async function uniRoundTrip(client, payload) {
	const outgoing = await client.transport.createUnidirectionalStream();
	await writeAndClose(outgoing, encoder.encode(payload));
	const incoming = await withDeadline(
		client.nextIncomingUni(),
		"IWA incoming uni stream",
	);
	const echoed = decoder.decode(
		await withDeadline(readAll(incoming), "IWA uni echo"),
	);
	assert(echoed === payload, `uni mismatch: ${echoed}`);
	return echoed;
}

function streamErrorCodeOf(error) {
	const code = error?.streamErrorCode;
	return typeof code === "number" ? code : null;
}

// The peer's RESET_STREAM surfaces as an error on our readable half, carrying
// the application code in `streamErrorCode`.
async function resetRoundTrip(client) {
	const stream = await client.transport.createBidirectionalStream();
	const writer = stream.writable.getWriter();
	await writer.write(encoder.encode("__IWA_RESET__"));
	writer.releaseLock();
	const error = await withDeadline(
		readAll(stream.readable).then(
			() => new Error("readable completed instead of being reset"),
			(err) => err,
		),
		"IWA RESET_STREAM propagation",
	);
	const code = streamErrorCodeOf(error);
	assert(code === RESET_CODE, `reset code mismatch: ${code} (${error})`);
	return code;
}

// STOP_SENDING has no W3C event: it surfaces as a rejected write on the half
// the peer asked us to stop, so keep writing until the send half fails.
async function stopSendingRoundTrip(client) {
	const stream = await client.transport.createBidirectionalStream();
	const writer = stream.writable.getWriter();
	await writer.write(encoder.encode("__IWA_STOP_SENDING__"));
	const deadline = createMonotonicDeadline(STEP_TIMEOUT_MS);
	let code = null;
	while (code === null && !deadline.expired()) {
		try {
			await writer.write(encoder.encode("."));
			await sleep(25);
		} catch (error) {
			code = streamErrorCodeOf(error);
			assert(
				code !== null,
				`send half failed without a STOP_SENDING code: ${error}`,
			);
		}
	}
	assert(code !== null, "STOP_SENDING was not observed on the send half");
	assert(code === STOP_SENDING_CODE, `STOP_SENDING code mismatch: ${code}`);
	return code;
}

async function peerCloseRoundTrip(client) {
	const { writer } = client.datagrams();
	await writer.write(encoder.encode("__IWA_PEER_CLOSE__"));
	const info = await withDeadline(
		client.transport.closed,
		"IWA peer connection close",
	);
	assert(
		info.closeCode === PEER_CLOSE_CODE,
		`peer close code mismatch: ${info.closeCode}`,
	);
	return { code: info.closeCode, reason: info.reason };
}

async function runIwaInteropProof() {
	const startedAt = new Date().toISOString();
	const identity = validateExecutionIdentity();
	const primary = await startServer(PRIMARY_PORT);
	hashEl.textContent = primary.certHashBase64;
	log("execution identity:", identity.executionIdentity);
	log("server: listening on udp", PRIMARY_PORT);

	const functionalClient = await openClient(
		PRIMARY_PORT,
		primary.certHashBase64,
	);
	let functional;
	try {
		functional = {
			datagram: await datagramRoundTrip(functionalClient, "iwa-datagram"),
			bidi: await bidiRoundTrip(functionalClient, "iwa-bidi"),
			uni: await uniRoundTrip(functionalClient, "iwa-uni"),
			resetCode: await resetRoundTrip(functionalClient),
			stopSendingCode: await stopSendingRoundTrip(functionalClient),
			peerClose: await peerCloseRoundTrip(functionalClient),
		};
	} finally {
		await functionalClient.close();
	}

	const reconnects = [];
	for (let attempt = 1; attempt <= 8; attempt += 1) {
		const client = await openClient(PRIMARY_PORT, primary.certHashBase64);
		try {
			const payload = `iwa-reconnect-${attempt}`;
			reconnects.push({
				attempt,
				payload: await datagramRoundTrip(client, payload),
			});
			client.transport.close({
				closeCode: 4200 + attempt,
				reason: "iwa-reconnect",
			});
			await withDeadline(
				client.transport.closed,
				`IWA reconnect close ${attempt}`,
			);
		} finally {
			await client.close();
		}
	}

	const rotated = await startServer(ROTATED_PORT);
	assert(
		rotated.certHashBase64 !== primary.certHashBase64,
		"certificate rotation produced the same certificate hash",
	);
	let oldPinRejected = false;
	try {
		const stale = await openClient(ROTATED_PORT, primary.certHashBase64);
		await stale.close();
	} catch {
		oldPinRejected = true;
	}
	assert(oldPinRejected, "rotated server accepted the stale certificate pin");
	const rotatedClient = await openClient(ROTATED_PORT, rotated.certHashBase64);
	let rotatedPayload;
	try {
		rotatedPayload = await datagramRoundTrip(rotatedClient, "iwa-rotated-cert");
	} finally {
		await rotatedClient.close();
	}

	const evidence = {
		schemaVersion: 1,
		status: "passed",
		startedAt,
		finishedAt: new Date().toISOString(),
		...identity,
		functional,
		reconnects,
		certificateRotation: {
			oldPinRejected,
			oldHash: primary.certHashBase64,
			newHash: rotated.certHashBase64,
			payload: rotatedPayload,
		},
		browser: navigator.userAgent,
	};
	globalThis.__WT_IWA_EVIDENCE__ = evidence;
	log("IWA RELEASE PROOF PASSED", JSON.stringify(evidence));
	return evidence;
}

globalThis.runIwaInteropProof = runIwaInteropProof;
globalThis.__WT_IWA_READY__ = false;

await initWasm();
globalThis.__WT_IWA_READY__ = true;
log("wasm initialised");

document.getElementById("start-server").addEventListener("click", async () => {
	try {
		validateExecutionIdentity();
		const server = await startServer(PRIMARY_PORT);
		hashEl.textContent = server.certHashBase64;
		log("server: listening on udp", PRIMARY_PORT);
	} catch (error) {
		log("server error:", String(error));
	}
});

document
	.getElementById("connect-client")
	.addEventListener("click", async () => {
		try {
			await runIwaInteropProof();
		} catch (error) {
			globalThis.__WT_IWA_EVIDENCE__ = {
				schemaVersion: 1,
				status: "failed",
				error: String(error),
				finishedAt: new Date().toISOString(),
			};
			log("IWA RELEASE PROOF FAILED", String(error));
		}
	});

// Used by the release runner to validate the exact browser-facing pin shape.
globalThis.__WT_IWA_CERT_HASHES__ = (hashBase64) =>
	serverCertificateHashes({ hashBase64 });
