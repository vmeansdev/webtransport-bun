/**
 * The batched datagram send: prefix envelope, copy-before-await, stop-at-first,
 * TypeScript chunking, and the one shared cap.
 *
 * The deadline-sharing and per-element-reservation properties are pinned in
 * Rust (`session::tests::
 * loopback_datagram_batch_shares_one_deadline_and_reserves_per_element`), where
 * a session's limits can be starved deterministically. What lives here is the
 * contract a caller can see.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	DATAGRAM_BATCH_MAX,
	sendDatagramBatchChunked,
} from "../src/datagram-batch.js";
import {
	E_QUEUE_FULL,
	E_SESSION_CLOSED,
	createServer,
	WebTransportError,
} from "../src/index.js";
import type { ClientSession, ServerSession } from "../src/index.js";
import { nextWithTimeout } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 24_900;
const PORT_SPREAD = 400;

/** A live server session and the client attached to it. */
type Pair = {
	server: ServerSession;
	client: ClientSession;
	toServer: AsyncIterator<Uint8Array>;
	toClient: AsyncIterator<Uint8Array>;
};

async function withPair(body: (pair: Pair) => Promise<void>): Promise<void> {
	const port = nextPort(BASE_PORT, PORT_SPREAD);
	const seen = Promise.withResolvers<ServerSession>();
	const server = createServer({
		port,
		tls: { certPem: "", keyPem: "" },
		onSession: (s) => seen.resolve(s),
	});
	const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
		tls: { insecureSkipVerify: true },
	});
	const serverSession = await seen.promise;
	const toServer = serverSession.incomingDatagrams()[Symbol.asyncIterator]();
	const toClient = client.incomingDatagrams()[Symbol.asyncIterator]();
	try {
		await body({ server: serverSession, client, toServer, toClient });
	} finally {
		await toServer.return?.();
		await toClient.return?.();
		client.close();
		await server.close();
	}
}

/** Read `count` datagrams, failing the test rather than hanging on a short read. */
async function receive(
	iter: AsyncIterator<Uint8Array>,
	count: number,
	label: string,
): Promise<Uint8Array[]> {
	const out: Uint8Array[] = [];
	while (out.length < count) {
		const next = await nextWithTimeout(iter, 5000, label);
		if (next.done || next.value === undefined) break;
		out.push(next.value);
	}
	return out;
}

function payload(marker: number, size = 64): Uint8Array {
	return new Uint8Array(size).fill(marker);
}

describe("batched datagram send", () => {
	it("a batch of one puts the same bytes on the wire as sendDatagram, both directions", async () => {
		await withPair(async ({ server, client, toServer, toClient }) => {
			const one = payload(0x11);

			await client.sendDatagram(one);
			const viaSingle = await receive(toServer, 1, "client single");
			const batched = await client.sendDatagramBatch([one]);
			expect(batched).toEqual({ sent: 1 });
			const viaBatch = await receive(toServer, 1, "client batch-of-1");
			expect(viaBatch[0]).toEqual(viaSingle[0] as Uint8Array);
			expect(viaBatch[0]).toEqual(one);

			const before = server.metricsSnapshot().datagramsOut;
			await server.sendDatagram(one);
			const midway = server.metricsSnapshot().datagramsOut;
			const serverBatched = await server.sendDatagramBatch([one]);
			expect(serverBatched).toEqual({ sent: 1 });
			expect(server.metricsSnapshot().datagramsOut - midway).toBe(
				midway - before,
			);

			const received = await receive(toClient, 2, "server batch-of-1");
			expect(received[0]).toEqual(one);
			expect(received[1]).toEqual(one);
		});
	}, 20_000);

	it("resolves a partial send rather than rejecting, and names the failing element", async () => {
		await withPair(async ({ client, toServer }) => {
			const good = [payload(0xa0), payload(0xa1)];
			const oversize = payload(0xff, 4096);
			const after = payload(0xa3);

			const result = await client.sendDatagramBatch([...good, oversize, after]);
			expect(result.sent).toBe(2);
			expect(result.error).toBeInstanceOf(WebTransportError);
			expect(result.error?.code).toBe(E_QUEUE_FULL);

			const received = await receive(toServer, 2, "prefix send");
			expect(received).toEqual(good);

			// The element after the failure was never attempted: a datagram sent
			// afterwards is the next thing the peer sees.
			const sentinel = payload(0x5e);
			await client.sendDatagram(sentinel);
			const next = await receive(toServer, 1, "post-failure sentinel");
			expect(next[0]).toEqual(sentinel);
			expect(next[0]).not.toEqual(after);

			// The single-datagram path reports the same condition by throwing;
			// the batch may not invent a different code for it.
			await expect(client.sendDatagram(oversize)).rejects.toMatchObject({
				code: E_QUEUE_FULL,
			});
		});
	}, 20_000);

	it("copies every payload before returning, so the caller may reuse its arrays", async () => {
		await withPair(async ({ client, toServer }) => {
			const originals = [payload(1), payload(2), payload(3), payload(4)];
			const arrays = originals.map((p) => Uint8Array.from(p));

			const pending = client.sendDatagramBatch(arrays);
			// Synchronously, before the promise settles and before anything has
			// touched the wire: scribble over every buffer the caller handed in.
			for (const array of arrays) array.fill(0xee);

			expect(await pending).toEqual({ sent: originals.length });
			const received = await receive(
				toServer,
				originals.length,
				"mutate after call",
			);
			expect(received).toEqual(originals);
		});
	}, 20_000);

	it("throws for a closed session and for arguments that are not datagrams", async () => {
		await withPair(async ({ client }) => {
			expect(() =>
				client.sendDatagramBatch("nope" as unknown as Uint8Array[]),
			).toThrow(TypeError);
			expect(() =>
				client.sendDatagramBatch([payload(1), "nope" as unknown as Uint8Array]),
			).toThrow(TypeError);

			client.close();
			expect(() => client.sendDatagramBatch([payload(1)])).toThrow(
				WebTransportError,
			);
			try {
				client.sendDatagramBatch([payload(1)]);
			} catch (err) {
				expect((err as WebTransportError).code).toBe(E_SESSION_CLOSED);
			}
		});
	}, 20_000);

	it("delivers a batch far larger than the native cap", async () => {
		await withPair(async ({ client, toServer }) => {
			const count = DATAGRAM_BATCH_MAX * 2 + 7;
			const batch = Array.from({ length: count }, (_, i) =>
				payload(i % 251, 32),
			);
			const result = await client.sendDatagramBatch(batch);
			expect(result).toEqual({ sent: count });

			// Datagrams are unreliable; what is pinned here is that the caller
			// never met the cap, not that loopback dropped nothing.
			const received = await receive(toServer, count, "over-cap batch");
			expect(received.length).toBeGreaterThan(DATAGRAM_BATCH_MAX);
			expect(received[0]).toEqual(batch[0] as Uint8Array);
		});
	}, 30_000);
});

describe("batched datagram send — chunking", () => {
	const sender = (results: Array<{ sent: number; code?: string }>) => {
		const chunks: number[] = [];
		let call = 0;
		return {
			chunks,
			send: async (chunk: Uint8Array[]) => {
				chunks.push(chunk.length);
				return results[call++] ?? { sent: chunk.length };
			},
		};
	};

	it("splits a long array into cap-sized native calls and reports the total", async () => {
		const { chunks, send } = sender([]);
		const datagrams = Array.from({ length: 1000 }, () => payload(1, 8));
		expect(await sendDatagramBatchChunked(send, datagrams)).toEqual({
			sent: 1000,
		});
		expect(chunks).toEqual([256, 256, 256, 232]);
	});

	it("stops at the first failing chunk and reports the absolute index", async () => {
		const { chunks, send } = sender([
			{ sent: 256 },
			{ sent: 40, code: E_QUEUE_FULL },
		]);
		const datagrams = Array.from({ length: 1000 }, () => payload(1, 8));
		expect(await sendDatagramBatchChunked(send, datagrams)).toEqual({
			sent: 296,
			code: E_QUEUE_FULL,
		});
		expect(chunks).toEqual([256, 256]);
		// 296 is the absolute index of the failing element in the caller's
		// array, not an offset into chunk 2.
		expect(datagrams[296]).toBeDefined();
	});

	it("an empty array is a resolved zero, with no crossing at all", async () => {
		const { chunks, send } = sender([]);
		expect(await sendDatagramBatchChunked(send, [])).toEqual({ sent: 0 });
		expect(chunks).toEqual([]);
	});
});

describe("the datagram batch cap", () => {
	it("has exactly one definition, and TypeScript agrees with it", () => {
		const rustSource = readFileSync(
			fileURLToPath(
				new URL(
					"../../../crates/native/src/datagram_batch.rs",
					import.meta.url,
				),
			),
			"utf8",
		);
		const declared = [
			...rustSource.matchAll(/DATAGRAM_BATCH_MAX:\s*u32\s*=\s*(\d+)/g),
		];
		expect(declared.length).toBe(1);
		expect(Number(declared[0]?.[1])).toBe(DATAGRAM_BATCH_MAX);

		// No second native definition anywhere: the server read path, the client
		// read path and both send paths must all point at the one above.
		for (const file of [
			"session.rs",
			"client.rs",
			"session_napi.rs",
			"session_registry.rs",
		]) {
			const source = readFileSync(
				fileURLToPath(
					new URL(`../../../crates/native/src/${file}`, import.meta.url),
				),
				"utf8",
			);
			expect([...source.matchAll(/BATCH_MAX:\s*u32\s*=/g)].length).toBe(0);
		}
	});
});
