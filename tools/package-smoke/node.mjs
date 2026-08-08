import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import dgram from "node:dgram";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
	connect,
	createServer,
	E_INTERNAL,
	WebTransport,
	WebTransportError,
} from "@webtransport-bun/webtransport";
import * as wasm from "@webtransport-bun/webtransport/wasm";

const TIMEOUT_MS = 8_000;

function timeout(promise, label, milliseconds = TIMEOUT_MS) {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
				milliseconds,
			);
		}),
	]).finally(() => clearTimeout(timer));
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availableUdpPort() {
	const socket = dgram.createSocket("udp4");
	try {
		await timeout(
			new Promise((resolve, reject) => {
				socket.once("error", reject);
				socket.bind(0, "127.0.0.1", resolve);
			}),
			"ephemeral UDP port reservation",
		);
		const address = socket.address();
		assert.notEqual(typeof address, "string");
		return address.port;
	} finally {
		await timeout(
			new Promise((resolve) => socket.close(resolve)),
			"ephemeral UDP port release",
		);
	}
}

async function connectWithRetry(url) {
	let lastError;
	for (let attempt = 0; attempt < 20; attempt++) {
		try {
			return await timeout(
				connect(url, { tls: { insecureSkipVerify: true } }),
				"native client connect",
			);
		} catch (error) {
			lastError = error;
			await delay(25);
		}
	}
	throw lastError;
}

async function echoDatagrams(session) {
	const iterator = session.incomingDatagrams()[Symbol.asyncIterator]();
	while (true) {
		const result = await timeout(iterator.next(), "server datagram receive");
		if (result.done) return;
		await timeout(session.sendDatagram(result.value), "server datagram echo");
	}
}

async function echoBidirectionalStreams(session) {
	const iterator = session.incomingBidirectionalStreams[Symbol.asyncIterator]();
	while (true) {
		const incoming = await timeout(iterator.next(), "server bidi accept");
		if (incoming.done) return;
		const duplex = incoming.value;
		// A session close may race the stream's terminal native callback after the
		// echo completed. Treat that expected teardown signal as observed.
		duplex.on?.("error", () => {});
		const reader = duplex.readable.getReader();
		const chunks = [];
		while (true) {
			const result = await timeout(reader.read(), "server bidi read");
			if (result.done) break;
			chunks.push(Buffer.from(result.value));
		}
		const writer = duplex.writable.getWriter();
		await timeout(writer.write(Buffer.concat(chunks)), "server bidi write");
		await timeout(writer.close(), "server bidi close");
	}
}

async function writeNodeStream(stream, payload, label) {
	await timeout(
		new Promise((resolve, reject) => {
			stream.end(payload, (error) => (error ? reject(error) : resolve()));
		}),
		label,
	);
}

async function collectNodeStream(stream, label) {
	return timeout(
		new Promise((resolve, reject) => {
			const chunks = [];
			stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			stream.once("end", () => resolve(Buffer.concat(chunks)));
			stream.once("error", reject);
		}),
		label,
	);
}

async function echoUnidirectionalStreams(session) {
	const outer = session.incomingUnidirectionalStreams.getReader();
	while (true) {
		const incoming = await timeout(outer.read(), "server uni accept");
		if (incoming.done) return;
		const reader = incoming.value.getReader();
		const chunks = [];
		while (true) {
			const result = await timeout(reader.read(), "server uni read");
			if (result.done) break;
			chunks.push(Buffer.from(result.value));
		}
		const outgoing = await timeout(
			session.createUnidirectionalStream(),
			"server uni open",
		);
		await writeNodeStream(
			outgoing,
			Buffer.concat(chunks),
			"server uni echo write",
		);
	}
}

async function bidiRoundTrip(client, payload) {
	const bidi = await timeout(
		client.createBidirectionalStream(),
		"client bidi open",
	);
	const response = timeout(
		new Promise((resolve, reject) => {
			const chunks = [];
			bidi.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
			bidi.once("end", () => resolve(Buffer.concat(chunks)));
			bidi.once("error", reject);
		}),
		"client bidi response",
	);
	await timeout(
		new Promise((resolve, reject) => {
			bidi.end(payload, (error) => (error ? reject(error) : resolve()));
		}),
		"client bidi write",
	);
	return response;
}

async function uniRoundTrip(client, payload) {
	const incoming = client
		.incomingUnidirectionalStreams()
		[Symbol.asyncIterator]();
	const response = timeout(incoming.next(), "client uni accept");
	const outgoing = await timeout(
		client.createUnidirectionalStream(),
		"client uni open",
	);
	await writeNodeStream(outgoing, payload, "client uni write");
	const accepted = await response;
	assert.equal(accepted.done, false);
	return collectNodeStream(accepted.value, "client uni response");
}

export async function main(runtime = "node") {
	assert.equal(typeof createServer, "function");
	assert.equal(typeof connect, "function");
	assert.equal(typeof WebTransport, "function");
	assert.equal(typeof WebTransportError, "function");
	assert.equal(E_INTERNAL, "E_INTERNAL");
	assert.equal(typeof wasm.loadWasmModule, "function");
	assert.equal(typeof wasm.createWasmServer, "function");
	const wasmModule = await timeout(
		wasm.loadWasmModule(),
		"production WASM import",
	);
	assert.ok(
		Object.keys(wasmModule).length > 0,
		"production WASM module is empty",
	);
	assert.equal(typeof wasmModule.wt_new_endpoint, "function");
	assert.equal(
		wasmModule.wt_new_endpoint(false, "127.0.0.1:0", "127.0.0.1:4433"),
		0,
		"production WASM must compile out the unpinned dev-insecure client",
	);
	assert.equal(
		typeof wasmModule.wt_generate_ca_signed_cert_for_test,
		"undefined",
		"production WASM must not export the test-only CA chain generator",
	);

	let client;
	const serverErrors = [];
	const port = await availableUdpPort();
	const server = createServer({
		host: "127.0.0.1",
		port,
		tls: { certPem: "", keyPem: "" },
		onSession(session) {
			void echoDatagrams(session).catch((error) => serverErrors.push(error));
			void echoBidirectionalStreams(session).catch((error) =>
				serverErrors.push(error),
			);
			void echoUnidirectionalStreams(session).catch((error) =>
				serverErrors.push(error),
			);
		},
	});
	try {
		assert.equal(server.address.port, port);
		client = await connectWithRetry(`https://127.0.0.1:${server.address.port}`);

		const datagram = new Uint8Array([0, 1, 2, 253, 254, 255]);
		await timeout(client.sendDatagram(datagram), "datagram send");
		const iterator = client.incomingDatagrams()[Symbol.asyncIterator]();
		const echoed = await timeout(iterator.next(), "datagram echo");
		assert.equal(echoed.done, false);
		assert.deepEqual(new Uint8Array(echoed.value), datagram);

		const bidiPayload = Buffer.from("exact-tarball-bidi-echo");
		assert.deepEqual(await bidiRoundTrip(client, bidiPayload), bidiPayload);

		const uniPayload = Buffer.from("exact-tarball-uni-echo");
		assert.deepEqual(await uniRoundTrip(client, uniPayload), uniPayload);
		assert.deepEqual(serverErrors, []);
	} finally {
		client?.close();
		await timeout(server.close(), "server shutdown");
	}
	console.log(
		`${runtime} exact-package import + datagram + uni + bidi smoke OK`,
	);
}

if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	await main("node");
}
