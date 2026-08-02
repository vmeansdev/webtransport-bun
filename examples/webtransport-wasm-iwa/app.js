// Release IWA proof harness. This module deliberately validates that it is
// executing in an installed Isolated Web App before opening Direct Sockets;
// loading the page or finding a UDPSocket-shaped mock is not release evidence.

import initWasm, * as wasm from "./vendor/webtransport_wasm.js";
import {
	connectWasm,
	createServer,
	DirectSocketsUdpTransport,
	serverCertificateHashes,
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

function signal() {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
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

function installServerSession(session) {
	session.onDatagram((data) => {
		const text = decoder.decode(data);
		if (text === "__IWA_PEER_CLOSE__") {
			session.close({ code: PEER_CLOSE_CODE, reason: "iwa-peer-close" });
			return;
		}
		void session.sendDatagram(data);
	});

	session.onIncomingStream((stream) => {
		const chunks = [];
		let controlHandled = false;
		let queue = Promise.resolve();
		stream.onData((data, fin) => {
			const text = decoder.decode(data);
			if (!controlHandled && text === "__IWA_RESET__") {
				controlHandled = true;
				stream.reset(RESET_CODE);
				return;
			}
			if (!controlHandled && text === "__IWA_STOP_SENDING__") {
				controlHandled = true;
				stream.stop(STOP_SENDING_CODE);
				return;
			}
			if (controlHandled) return;

			if (stream.bidi) {
				queue = queue.then(async () => {
					if (data.length > 0) await stream.writeAll(data);
					if (fin) stream.finish();
				});
				queue.catch((error) => log("server bidi error:", String(error)));
				return;
			}

			if (data.length > 0) chunks.push(data.slice());
			if (!fin) return;
			const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
			const payload = new Uint8Array(total);
			let offset = 0;
			for (const chunk of chunks) {
				payload.set(chunk, offset);
				offset += chunk.length;
			}
			// The server facade reserves its W3C stream surface separately from
			// the legacy callbacks above. Open the echo stream on the underlying
			// callback session so this callback-only handler stays coherent.
			const output = session.unwrap().createUnidirectionalStream();
			void output
				.writeAll(payload)
				.then(() => output.finish())
				.catch((error) => log("server uni error:", String(error)));
		});
	});
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
		return {
			...connected,
			udp,
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

async function datagramRoundTrip(session, payload) {
	const received = signal();
	session.onDatagram((data) => received.resolve(decoder.decode(data)));
	await session.sendDatagram(encoder.encode(payload));
	const echoed = await withDeadline(received.promise, "IWA datagram echo");
	assert(echoed === payload, `datagram mismatch: ${echoed}`);
	return echoed;
}

async function bidiRoundTrip(session, payload) {
	const received = signal();
	const chunks = [];
	const stream = session.createBidirectionalStream();
	stream.onData((data, fin) => {
		if (data.length > 0) chunks.push(data.slice());
		if (fin) {
			received.resolve(
				decoder.decode(Uint8Array.from(chunks.flatMap((c) => [...c]))),
			);
		}
	});
	await stream.writeAll(encoder.encode(payload));
	stream.finish();
	const echoed = await withDeadline(received.promise, "IWA bidi echo");
	assert(echoed === payload, `bidi mismatch: ${echoed}`);
	return echoed;
}

async function uniRoundTrip(session, payload) {
	const incoming = signal();
	session.onIncomingStream((stream) => {
		if (!stream.bidi) incoming.resolve(stream);
	});
	const output = session.createUnidirectionalStream();
	await output.writeAll(encoder.encode(payload));
	output.finish();
	const input = await withDeadline(incoming.promise, "IWA incoming uni stream");
	const received = signal();
	const chunks = [];
	input.onData((data, fin) => {
		if (data.length > 0) chunks.push(data.slice());
		if (fin) {
			received.resolve(
				decoder.decode(Uint8Array.from(chunks.flatMap((c) => [...c]))),
			);
		}
	});
	const echoed = await withDeadline(received.promise, "IWA uni echo");
	assert(echoed === payload, `uni mismatch: ${echoed}`);
	return echoed;
}

async function resetRoundTrip(session) {
	const reset = signal();
	const stream = session.createBidirectionalStream();
	stream.onReset((code) => reset.resolve(code));
	await stream.writeAll(encoder.encode("__IWA_RESET__"));
	const code = await withDeadline(
		reset.promise,
		"IWA RESET_STREAM propagation",
	);
	assert(code === RESET_CODE, `reset code mismatch: ${code}`);
	return code;
}

async function stopSendingRoundTrip(session) {
	const stopped = signal();
	const stream = session.createBidirectionalStream();
	stream.onStopped((code) => stopped.resolve(code));
	await stream.writeAll(encoder.encode("__IWA_STOP_SENDING__"));
	const code = await withDeadline(
		stopped.promise,
		"IWA STOP_SENDING propagation",
	);
	assert(code === STOP_SENDING_CODE, `STOP_SENDING code mismatch: ${code}`);
	return code;
}

async function peerCloseRoundTrip(session) {
	await session.sendDatagram(encoder.encode("__IWA_PEER_CLOSE__"));
	const info = await withDeadline(session.closed, "IWA peer connection close");
	assert(
		info.code === PEER_CLOSE_CODE,
		`peer close code mismatch: ${info.code}`,
	);
	return { code: info.code, reason: info.reason };
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
			datagram: await datagramRoundTrip(
				functionalClient.session,
				"iwa-datagram",
			),
			bidi: await bidiRoundTrip(functionalClient.session, "iwa-bidi"),
			uni: await uniRoundTrip(functionalClient.session, "iwa-uni"),
			resetCode: await resetRoundTrip(functionalClient.session),
			stopSendingCode: await stopSendingRoundTrip(functionalClient.session),
			peerClose: await peerCloseRoundTrip(functionalClient.session),
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
				payload: await datagramRoundTrip(client.session, payload),
			});
			client.session.close({ code: 4200 + attempt, reason: "iwa-reconnect" });
			await withDeadline(
				client.session.closed,
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
		rotatedPayload = await datagramRoundTrip(
			rotatedClient.session,
			"iwa-rotated-cert",
		);
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
