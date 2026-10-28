/**
 * The batch and mirror sends take bytes: `Uint8Array` (and its `Buffer`
 * subclass), not any ArrayBuffer view. A Uint16Array or a DataView must be a
 * synchronous TypeError before anything crosses, not a silent send of the
 * view's underlying bytes.
 */

import { describe, expect, it } from "bun:test";
import { sendDatagramBatchChunked } from "../src/datagram-batch.js";
import {
	sendDatagramMirrorChecked,
	sendDatagramMirrorPacedChecked,
} from "../src/datagram-mirror.js";
import { createServer, type ServerSession } from "../src/index.js";
import { connectWithRetry, nextPort } from "./helpers/network.js";

const NOT_BYTES: [string, unknown][] = [
	["Uint16Array", new Uint16Array([1, 2])],
	["DataView", new DataView(new ArrayBuffer(4))],
	["Int8Array", new Int8Array([1])],
];

const neverSend = () => {
	throw new Error("must not cross");
};

describe("payload type at the checked entry points", () => {
	for (const [label, value] of NOT_BYTES) {
		it(`sendDatagramBatch rejects a ${label} element synchronously`, () => {
			expect(() =>
				sendDatagramBatchChunked(neverSend, [
					new Uint8Array([1]),
					value as Uint8Array,
				]),
			).toThrow(TypeError);
		});
		it(`sendDatagramMirror rejects a ${label} payload synchronously`, () => {
			expect(() =>
				sendDatagramMirrorChecked(neverSend, ["a"], value as Uint8Array),
			).toThrow(TypeError);
		});
		it(`sendDatagramMirrorPaced rejects a ${label} payload synchronously`, () => {
			expect(() =>
				sendDatagramMirrorPacedChecked(neverSend, ["a"], value as Uint8Array),
			).toThrow(TypeError);
		});
	}

	it("still accepts Buffer, the Uint8Array subclass", () => {
		const sent: number[] = [];
		expect(() =>
			sendDatagramMirrorChecked(
				(targets) => {
					sent.push(targets.length);
					return {
						sent: 1,
						failed: new Uint32Array(0),
						codes: new Uint8Array(0),
					};
				},
				["a"],
				Buffer.from([1, 2]),
			),
		).not.toThrow();
		expect(sent).toEqual([1]);
	});
});

describe("payload type on a live server and session", () => {
	it("rejects non-byte views on all three methods before anything crosses", async () => {
		const port = nextPort(27_900, 60);
		const accepted = Promise.withResolvers<ServerSession>();
		const server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: (s) => accepted.resolve(s),
		});
		const client = await connectWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		try {
			const session = await accepted.promise;
			for (const [, value] of NOT_BYTES) {
				expect(() => session.sendDatagramBatch([value as Uint8Array])).toThrow(
					TypeError,
				);
				expect(() => client.sendDatagramBatch([value as Uint8Array])).toThrow(
					TypeError,
				);
				expect(() =>
					server.sendDatagramMirror([session.id], value as Uint8Array),
				).toThrow(TypeError);
				// TypeError precedes the pacer check, so this holds with or
				// without a pacer configured.
				expect(() =>
					server.sendDatagramMirrorPaced([session.id], value as Uint8Array),
				).toThrow(TypeError);
			}
			expect(server.metricsSnapshot().datagramMirrorCalls ?? 0).toBe(0);
			expect(session.metricsSnapshot().datagramsOut).toBe(0);
		} finally {
			client.close();
			await server.close();
		}
	});
});
