/**
 * Native `quicLb` option tests: the TS surface, its validation bounds, and the
 * exported decoders.
 *
 * What is covered here is the JS half — every bound rejected before the addon
 * is touched, the decoders against a connection ID assembled by hand per
 * draft-ietf-quic-load-balancers-21 §5.2, and a live server built with the
 * option that a client can still connect to. What the generator actually writes
 * into a connection ID is covered by the Rust unit tests in
 * `crates/native/src/quic_lb.rs`; a JS test cannot see a connection ID, because
 * nothing on this API surface exposes one.
 */

import { describe, expect, it } from "bun:test";
import {
	connect,
	createServer,
	decodeQuicLbConfigRotation,
	decodeQuicLbServerId,
	quicLbCidLength,
} from "../src/index.js";
import { nextPort } from "./helpers/network.js";

const TLS = { certPem: "", keyPem: "" };

/** A connection ID exactly as §5.2 lays one out, for the decoders to read. */
function buildCid(
	configRotation: number,
	serverId: readonly number[],
	nonce: readonly number[],
): Uint8Array {
	// First octet: rotation in the top three bits, five arbitrary low bits that
	// the decoders must ignore.
	return Uint8Array.from([
		(configRotation << 5) | 0b1_0110,
		...serverId,
		...nonce,
	]);
}

describe("native quicLb option", () => {
	it("accepts a valid configuration and still serves a session", async () => {
		const port = nextPort(24840, 2000);
		const seen = Promise.withResolvers<void>();
		const server = createServer({
			port,
			quicLb: { serverId: new Uint8Array([0x00, 0x07]), nonceLen: 8 },
			tls: TLS,
			onSession: () => seen.resolve(),
		});
		try {
			expect(server.address.port).toBe(port);
			const client = await connect(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true, serverName: "quiclb.test" },
			});
			await seen.promise;
			client.close();
			await client.closed;
		} finally {
			await server.close();
		}
	});

	it("accepts a plain number array as the server ID", async () => {
		const port = nextPort(24845, 2000);
		const server = createServer({
			port,
			quicLb: { serverId: [1], nonceLen: 4, configRotation: 6 },
			tls: TLS,
			onSession: () => {},
		});
		try {
			expect(server.address.port).toBe(port);
		} finally {
			await server.close();
		}
	});

	it("leaves connection IDs alone when the option is absent", async () => {
		const server = createServer({
			port: 0,
			tls: TLS,
			onSession: () => {},
		});
		try {
			expect(server.address.port).toBeGreaterThan(0);
		} finally {
			await server.close();
		}
	});

	describe("validation, before the addon is touched", () => {
		const reject = (
			quicLb: unknown,
			pattern: RegExp,
			port = nextPort(24850, 2000),
		) =>
			expect(() =>
				createServer({
					port,
					// @ts-expect-error invalid on purpose
					quicLb,
					tls: TLS,
					onSession: () => {},
				}),
			).toThrow(pattern);

		it("rejects an empty server ID", () => {
			reject(
				{ serverId: new Uint8Array(), nonceLen: 8 },
				/E_INVALID_ARGUMENT: quicLb\.serverId must be at least 1 octet/,
			);
		});

		it("rejects a missing server ID", () => {
			reject(
				{ nonceLen: 8 },
				/E_INVALID_ARGUMENT: quicLb\.serverId must be a Uint8Array or an array of octets/,
			);
		});

		it("rejects a server-ID octet out of range", () => {
			reject(
				{ serverId: [1, 256], nonceLen: 8 },
				/E_INVALID_ARGUMENT: quicLb\.serverId\[1\] must be an integer in 0-255/,
			);
		});

		it("rejects a missing nonce length rather than defaulting one", () => {
			reject(
				{ serverId: [1] },
				/E_INVALID_ARGUMENT: quicLb\.nonceLen is required/,
			);
		});

		it("rejects a nonce length below four octets", () => {
			reject(
				{ serverId: [1], nonceLen: 3 },
				/E_INVALID_ARGUMENT: quicLb\.nonceLen must be at least 4 octets, got 3/,
			);
		});

		it("rejects a server ID and nonce summing past nineteen octets", () => {
			reject(
				{ serverId: new Uint8Array(16), nonceLen: 4 },
				/E_INVALID_ARGUMENT: quicLb\.serverId length \+ nonceLen must be at most 19 octets, got 20/,
			);
		});

		it("accepts the boundary sum of exactly nineteen octets", async () => {
			const port = nextPort(24855, 2000);
			const server = createServer({
				port,
				quicLb: { serverId: new Uint8Array(15), nonceLen: 4 },
				tls: TLS,
				onSession: () => {},
			});
			try {
				expect(server.address.port).toBe(port);
			} finally {
				await server.close();
			}
		});

		it("rejects the reserved config rotation", () => {
			reject(
				{ serverId: [1], nonceLen: 4, configRotation: 7 },
				/E_INVALID_ARGUMENT: quicLb\.configRotation must not be 0b111/,
			);
		});

		it("rejects a config rotation wider than three bits", () => {
			reject(
				{ serverId: [1], nonceLen: 4, configRotation: 8 },
				/E_INVALID_ARGUMENT: quicLb\.configRotation must fit in 3 bits \(0-6\), got 8/,
			);
		});

		it("rejects a non-object quicLb", () => {
			reject("yes", /E_INVALID_ARGUMENT: quicLb must be an object/);
		});
	});
});

describe("QUIC-LB connection-ID decoders", () => {
	it("roundtrips a connection ID assembled per the layout", () => {
		const cid = buildCid(3, [0xab, 0xcd], [1, 2, 3, 4, 5, 6, 7, 8]);
		expect(cid.length).toBe(11);
		expect(decodeQuicLbConfigRotation(cid)).toBe(3);
		expect(Array.from(decodeQuicLbServerId(cid, 2) as Uint8Array)).toEqual([
			0xab, 0xcd,
		]);
	});

	it("reads every routable rotation codepoint, and the reserved one too", () => {
		for (let rotation = 0; rotation <= 7; rotation++) {
			const cid = buildCid(rotation, [9], [0, 0, 0, 0]);
			expect(decodeQuicLbConfigRotation(cid)).toBe(rotation);
		}
	});

	it("ignores the five random low bits of the first octet", () => {
		const a = Uint8Array.from([0b011_00000, 7, 0, 0, 0, 0]);
		const b = Uint8Array.from([0b011_11111, 7, 0, 0, 0, 0]);
		expect(decodeQuicLbConfigRotation(a)).toBe(
			decodeQuicLbConfigRotation(b) as number,
		);
		expect(decodeQuicLbServerId(a, 1)).toEqual(
			decodeQuicLbServerId(b, 1) as Uint8Array,
		);
	});

	it("refuses input too short to hold the server ID", () => {
		expect(decodeQuicLbServerId(Uint8Array.from([0x40, 9, 8]), 3)).toBeNull();
		expect(decodeQuicLbServerId(new Uint8Array(), 1)).toBeNull();
		expect(decodeQuicLbConfigRotation(new Uint8Array())).toBeNull();
	});

	it("refuses a server-ID length the draft does not allow", () => {
		const cid = buildCid(0, [1, 2], [0, 0, 0, 0]);
		expect(decodeQuicLbServerId(cid, 0)).toBeNull();
		expect(decodeQuicLbServerId(cid, -1)).toBeNull();
		expect(decodeQuicLbServerId(cid, 1.5)).toBeNull();
	});

	it("copies rather than viewing the source connection ID", () => {
		const cid = buildCid(0, [1, 2], [0, 0, 0, 0]);
		const id = decodeQuicLbServerId(cid, 2) as Uint8Array;
		id[0] = 0xff;
		expect(cid[1]).toBe(1);
	});

	it("agrees with the length of a connection ID built from the same layout", () => {
		expect(quicLbCidLength(2, 8)).toBe(
			buildCid(3, [0xab, 0xcd], [1, 2, 3, 4, 5, 6, 7, 8]).length,
		);
		expect(quicLbCidLength(1, 4)).toBe(6); // draft-21 §5.3 minimum
		expect(quicLbCidLength(15, 4)).toBe(20); // and its maximum
	});
});
