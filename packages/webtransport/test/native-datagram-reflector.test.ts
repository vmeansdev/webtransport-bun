/**
 * The per-server datagram reflector: a matched datagram is answered in
 * native and never reaches JavaScript; everything else takes the ordinary
 * path untouched. Pinned from the outside: the reply bytes, the metrics,
 * the non-delivery, and the clear.
 */

import { describe, expect, it } from "bun:test";
import { createServer } from "../src/index.js";
import type {
	ClientSession,
	ServerSession,
	WebTransportServer,
} from "../src/index.js";
import { nextWithTimeout } from "./helpers/harness.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const BASE_PORT = 25_900;
const PORT_SPREAD = 200;

const G6_RULE = {
	minLength: 48,
	replyLength: 48,
	match: [
		{ offset: 0, bytes: new Uint8Array([0x54, 0x4c]) },
		{ offset: 2, bytes: new Uint8Array([3, 0]) },
		{ offset: 44, bytes: new Uint8Array([1]) },
	],
	rewrite: [
		{ op: "copy", from: 12, to: 28, length: 8 },
		{ op: "zero", at: 4, length: 8 },
		{ op: "nowNs", at: 12 },
		{ op: "holdNs", at: 36 },
		{ op: "set", at: 44, value: 2 },
	],
} as const;

function readU64(bytes: Uint8Array, offset: number): bigint {
	return new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getBigUint64(offset, true);
}

function readU16(bytes: Uint8Array, offset: number): number {
	return new DataView(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength,
	).getUint16(offset, true);
}

function actionStamp(actual: bigint, sequence: bigint): Uint8Array {
	const bytes = new Uint8Array(64);
	const view = new DataView(bytes.buffer);
	view.setUint16(0, 0x4c54, true);
	view.setUint16(2, 3, true);
	view.setBigUint64(4, 7n, true);
	view.setBigUint64(12, actual, true);
	view.setBigUint64(20, sequence, true);
	bytes[44] = 1;
	return bytes;
}

type Fixture = {
	server: WebTransportServer;
	session: ServerSession;
	client: ClientSession;
	fromClient: AsyncIterator<Uint8Array>;
	toClient: AsyncIterator<Uint8Array>;
};

async function next(
	iter: AsyncIterator<Uint8Array>,
	label: string,
): Promise<Uint8Array> {
	const result = await nextWithTimeout(iter, 2_000, label);
	if (result.done || result.value === undefined) {
		throw new Error(`${label}: stream ended before a datagram arrived`);
	}
	return result.value;
}

async function withSession(body: (f: Fixture) => Promise<void>): Promise<void> {
	const port = nextPort(BASE_PORT, PORT_SPREAD);
	const accepted = Promise.withResolvers<ServerSession>();
	const server = createServer({
		port,
		tls: { certPem: "", keyPem: "" },
		onSession: (s) => accepted.resolve(s),
	});
	let client: ClientSession | undefined;
	let fromClient: AsyncIterator<Uint8Array> | undefined;
	let toClient: AsyncIterator<Uint8Array> | undefined;
	try {
		client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const session = await accepted.promise;
		fromClient = session.incomingDatagrams()[Symbol.asyncIterator]();
		toClient = client.incomingDatagrams()[Symbol.asyncIterator]();
		await body({ server, session, client, fromClient, toClient });
	} finally {
		await fromClient?.return?.();
		await toClient?.return?.();
		client?.close();
		await server.close();
	}
}

describe("native datagram reflector", () => {
	it("answers a matched datagram in native and never delivers it to JS", async () => {
		await withSession(async ({ server, client, fromClient, toClient }) => {
			server.setDatagramReflector(G6_RULE);
			await client.sendDatagram(actionStamp(123_456n, 9n));
			const reply = await next(toClient, "reflected ack");
			expect(reply.byteLength).toBe(48);
			expect(readU16(reply, 0)).toBe(0x4c54);
			expect(readU16(reply, 2)).toBe(3);
			expect(readU64(reply, 4)).toBe(0n); // intended zeroed
			expect(readU64(reply, 12)).toBeGreaterThan(0n); // server send instant
			expect(readU64(reply, 20)).toBe(9n); // sequence kept
			expect(readU64(reply, 28)).toBe(123_456n); // client actual echoed
			expect(readU64(reply, 36)).toBeGreaterThanOrEqual(0n); // hold
			expect(reply[44]).toBe(2); // CLASS_ACK

			// A non-matching datagram still reaches JS.
			await client.sendDatagram(new Uint8Array([9, 9, 9]));
			const delivered = await next(fromClient, "unmatched passthrough");
			expect(Array.from(delivered)).toEqual([9, 9, 9]);

			const m = server.metricsSnapshot();
			expect(m.datagramReflectHits).toBe(1);
			expect(m.datagramReflectSent).toBe(1);
			expect(m.datagramReflectSendErrors).toBe(0);
			expect(m.datagramReflectQueueFull).toBe(0);
			expect(m.datagramReflectHold?.count).toBe(1);
			expect(m.datagramsIn).toBe(2);
		});
	});

	it("delivers the same datagram to JS once the rule is cleared", async () => {
		await withSession(async ({ server, client, fromClient }) => {
			server.setDatagramReflector(G6_RULE);
			server.setDatagramReflector(null);
			await client.sendDatagram(actionStamp(1n, 2n));
			const delivered = await next(fromClient, "cleared passthrough");
			expect(delivered.byteLength).toBe(64);
			expect(delivered[44]).toBe(1);
			expect(server.metricsSnapshot().datagramReflectHits).toBe(0);
		});
	});

	it("re-validates the rule in native: an out-of-range op is a RangeError before any state changes", async () => {
		await withSession(async ({ server, client, toClient }) => {
			server.setDatagramReflector(G6_RULE);
			const bad = { ...G6_RULE, rewrite: [{ op: "nowNs", at: 41 }] };
			// Bypass the TypeScript validator on purpose to reach the native one.
			const raw = server as unknown as {
				setDatagramReflector: (r: unknown) => void;
			};
			expect(() => raw.setDatagramReflector(bad)).toThrow(RangeError);

			// The refused rule left the installed one in place: a match is still
			// reflected. A set-then-validate regression would fail here, not above.
			await client.sendDatagram(actionStamp(77n, 5n));
			const reply = await next(toClient, "reflected after refusal");
			expect(reply.byteLength).toBe(48);
			expect(reply[44]).toBe(2);
			expect(readU64(reply, 28)).toBe(77n);
			expect(readU64(reply, 20)).toBe(5n);
			expect(server.metricsSnapshot().datagramReflectHits).toBe(1);
		});
	});
});
