import { describe, expect, it } from "bun:test";
import type { Duplex } from "node:stream";
import { connect, createServer } from "../src/index.js";
import { generateCertForNames } from "./helpers/certs.js";

const TOTAL = 1024 * 1024;
const CHUNK = 16 * 1024;

// One byte budget used to serve both directions of a bidi stream: writes
// queued faster than the peer drained them filled it, the receive side could
// not reserve, nothing was read, and an echo of 1 MiB in 16 KiB writes stalled
// at ~55 KB with E_BACKPRESSURE_TIMEOUT at default limits. With many busy
// streams the shared session budget deadlocked the same way.
async function echoThrough(stream: Duplex): Promise<number> {
	let received = 0;
	const done = new Promise<void>((resolve, reject) => {
		stream.on("data", (chunk: Uint8Array) => {
			received += chunk.byteLength;
			if (received >= TOTAL) resolve();
		});
		stream.on("error", reject);
	});
	const chunk = new Uint8Array(CHUNK).fill(7);
	for (let sent = 0; sent < TOTAL; sent += CHUNK) {
		if (!stream.write(chunk)) {
			await new Promise<void>((resolve, reject) => {
				stream.once("drain", resolve);
				stream.once("error", reject);
			});
		}
	}
	await Promise.race([done, Bun.sleep(20_000)]);
	return received;
}

describe("bidi streams with both directions busy do not stall", () => {
	for (const streams of [1, 16]) {
		it(`echoes 1 MiB in 16 KiB writes on ${streams} concurrent stream(s)`, async () => {
			const cert = generateCertForNames(["localhost", "127.0.0.1"]);
			if (!cert) return;
			const server = createServer({
				port: 0,
				host: "127.0.0.1",
				tls: { certPem: cert.certPem, keyPem: cert.keyPem },
				onSession: async (session) => {
					for await (const {
						readable,
						writable,
					} of session.incomingBidirectionalStreams) {
						void readable.pipeTo(writable).catch(() => {});
					}
				},
			});
			try {
				const client = await connect(
					`https://127.0.0.1:${server.address.port}/`,
					{ tls: { insecureSkipVerify: true } },
				);
				const opened = await Promise.all(
					Array.from({ length: streams }, () =>
						client.createBidirectionalStream(),
					),
				);
				const received = await Promise.all(opened.map(echoThrough));
				expect(received).toEqual(opened.map(() => TOTAL));
				client.close();
			} finally {
				await server.close();
				cert.cleanup();
			}
		}, 60_000);
	}
});
