/**
 * A single stream write larger than `maxQueuedBytesPerStream` is queued in
 * budget-sized pieces. It used to park on a reservation that could never
 * succeed and fail with E_BACKPRESSURE_TIMEOUT after `backpressureTimeoutMs`.
 *
 * The server only reads: a bidi stream's byte budget is shared by its two
 * directions, so an echo of a write larger than the budget is a different
 * question from the one tested here.
 */

import { describe, expect, it } from "bun:test";
import { connect, createServer, type ServerSession } from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const LIMITS = {
	maxQueuedBytesPerStream: 64 * 1024,
	backpressureTimeoutMs: 2000,
};
const PAYLOAD = new Uint8Array(256 * 1024).map((_, i) => i % 251);

async function drain(
	readable: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	for await (const part of readable) parts.push(part);
	return new Uint8Array(Buffer.concat(parts));
}

function sinkServer(port: number, kind: "bidi" | "uni") {
	let resolveReceived!: (bytes: Uint8Array) => void;
	const received = new Promise<Uint8Array>((r) => {
		resolveReceived = r;
	});
	const server = createServer({
		port,
		host: "127.0.0.1",
		tls: { certPem: "", keyPem: "" },
		limits: LIMITS,
		onSession: async (session: ServerSession) => {
			if (kind === "bidi") {
				for await (const { readable } of session.incomingBidirectionalStreams) {
					resolveReceived(await drain(readable));
				}
			} else {
				for await (const readable of session.incomingUnidirectionalStreams) {
					resolveReceived(await drain(readable));
				}
			}
		},
	});
	return { server, received };
}

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([
		p,
		Bun.sleep(ms).then(() => {
			throw new Error(`timeout: ${what}`);
		}),
	]);
}

describe("oversized stream writes", () => {
	for (const kind of ["bidi", "uni"] as const) {
		it(`${kind}: one write four times the per-stream budget arrives whole and in order`, async () => {
			const port = nextPort(27820, 1000);
			const { server, received } = sinkServer(port, kind);
			const client = await connect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true, serverName: "oversized.test" },
				limits: LIMITS,
			});
			try {
				const stream =
					kind === "bidi"
						? await client.createBidirectionalStream()
						: await client.createUnidirectionalStream();
				await within(
					new Promise<void>((resolve, reject) =>
						stream.write(PAYLOAD, (err) => (err ? reject(err) : resolve())),
					),
					6000,
					"oversized write accepted",
				);
				stream.end();
				const got = await within(received, 6000, "server received the payload");
				expect(got.length).toBe(PAYLOAD.length);
				expect(Buffer.from(got).equals(Buffer.from(PAYLOAD))).toBe(true);
			} finally {
				client.close();
				await server.close();
			}
		}, 20000);
	}
});
