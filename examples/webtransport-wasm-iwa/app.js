// Reference IWA demo wiring. Requires a web-target wasm-bindgen build and the
// package's wasm subpath bundled into ./vendor/ (see README.md). This file is a
// faithful illustration of the browser API; it runs only inside a Chromium
// Isolated Web App with the direct-sockets permission.

import initWasm, * as wasm from "./vendor/webtransport_wasm.js";
import {
	connectWasm,
	DirectSocketsUdpTransport,
	serveOverUdp,
	serverCertificateHashes,
} from "./vendor/webtransport-wasm.js";

const logEl = document.getElementById("log");
const hashEl = document.getElementById("hash");
function log(...args) {
	logEl.textContent += `${args.join(" ")}\n`;
}

let serverCertHash = null;
const SERVER_PORT = 4433;

await initWasm();
log("wasm initialised");

document.getElementById("start-server").addEventListener("click", async () => {
	try {
		const { certHashBase64 } = await serveOverUdp(
			wasm,
			DirectSocketsUdpTransport.bind,
			{
				localAddress: "127.0.0.1",
				localPort: SERVER_PORT,
				commonName: "localhost",
				validityDays: 14,
				onSession: (session) => {
					log("server: session established");
					session.onDatagram((d) => {
						log(`server: echo datagram (${d.length}b)`);
						session.sendDatagram(d);
					});
					session.onIncomingStream((stream) => {
						if (stream.bidi) {
							// Bidi: echo received bytes back on the same stream.
							// writeAll resolves only when every byte is accepted;
							// serialize chunks and FIN when the peer FINs.
							let queue = Promise.resolve();
							stream.onData((data, fin) => {
								queue = queue
									.then(async () => {
										if (data.length > 0) await stream.writeAll(data);
										if (fin) stream.finish();
									})
									.catch((e) => log("server: bidi echo error", String(e)));
							});
						} else {
							// Uni is RECV-ONLY — cannot write back on it. Echo onto
							// a fresh uni stream once the input completes.
							const chunks = [];
							stream.onData((data, fin) => {
								if (data.length > 0) chunks.push(data.slice());
								if (fin) {
									const total = chunks.reduce((n, c) => n + c.length, 0);
									const buf = new Uint8Array(total);
									let off = 0;
									for (const c of chunks) {
										buf.set(c, off);
										off += c.length;
									}
									const out = session.createUnidirectionalStream();
									(total > 0 ? out.writeAll(buf) : Promise.resolve())
										.then(() => out.finish())
										.catch((e) => log("server: uni echo error", String(e)));
								}
							});
						}
					});
				},
			},
		);
		serverCertHash = certHashBase64;
		hashEl.textContent = certHashBase64;
		log("server: listening on udp", SERVER_PORT);
	} catch (e) {
		log("server error:", String(e));
	}
});

document
	.getElementById("connect-client")
	.addEventListener("click", async () => {
		if (!serverCertHash) {
			log("start the server first");
			return;
		}
		try {
			const udp = await DirectSocketsUdpTransport.connect(
				"127.0.0.1",
				SERVER_PORT,
			);
			// Pin the server's cert hash — the client fails against any other cert.
			// peerAddr MUST match where the server listens (SERVER_PORT), or the
			// wasm client targets :443 while packets arrive from :SERVER_PORT.
			const { session } = await connectWasm(
				wasm,
				udp,
				"localhost",
				"127.0.0.1:0",
				`127.0.0.1:${SERVER_PORT}`,
				{ certHashBase64: serverCertHash },
			);
			log("client: session established (cert pinned)");

			// Datagram round-trip.
			session.onDatagram((d) =>
				log("client: got datagram", new TextDecoder().decode(d)),
			);
			session.sendDatagram(new TextEncoder().encode("hello-datagram"));

			// Bidi stream round-trip.
			const stream = session.createBidirectionalStream();
			stream.onData((data) =>
				log("client: stream echo", new TextDecoder().decode(data)),
			);
			stream.write(new TextEncoder().encode("hello-stream"));

			// `serverCertificateHashes` a native browser client would use to connect:
			log(
				"serverCertificateHashes:",
				JSON.stringify(
					serverCertificateHashes({ hashBase64: serverCertHash }).map((h) => ({
						algorithm: h.algorithm,
						value: `<${h.value.length} bytes>`,
					})),
				),
			);
		} catch (e) {
			log("client error:", String(e));
		}
	});
