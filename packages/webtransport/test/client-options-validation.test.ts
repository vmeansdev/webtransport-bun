/**
 * connect() and new WebTransport() validate the shared client options the same
 * way, before anything is dialed. The URL points at a closed port, so a
 * validation gap would surface as a connect failure rather than the code.
 */

import { describe, expect, it } from "bun:test";
import {
	type ClientOptions,
	connect,
	E_INVALID_ARGUMENT,
	E_UNSUPPORTED_ARGUMENT,
	type ErrorCode,
	WebTransport,
	type WebTransportClientOptions,
	WebTransportError,
} from "../src/index.js";

const URL = "https://127.0.0.1:1";
const hash = { algorithm: "sha-256" as const, value: new Uint8Array(32) };

async function connectError(opts: ClientOptions): Promise<unknown> {
	return Promise.race([
		connect(URL, opts).then(
			(s) => {
				s.close();
				return new Error("connect unexpectedly succeeded");
			},
			(err: unknown) => err,
		),
		Bun.sleep(3000).then(() => new Error("connect did not settle")),
	]);
}

function facadeError(opts: WebTransportClientOptions): unknown {
	try {
		const wt = new WebTransport(URL, opts);
		wt.close();
	} catch (err) {
		return err;
	}
	return new Error("new WebTransport did not throw");
}

function expectCode(err: unknown, code: ErrorCode, name?: string): void {
	expect(err).toBeInstanceOf(WebTransportError);
	expect((err as WebTransportError).code).toBe(code);
	if (name) expect((err as WebTransportError).name).toBe(name);
}

const shared: Array<[string, WebTransportClientOptions, ErrorCode, string?]> = [
	[
		"an unknown congestionControl",
		{ congestionControl: "bogus" as "default" },
		E_INVALID_ARGUMENT,
	],
	[
		"a non-boolean allowPooling",
		{ allowPooling: "yes" as unknown as boolean },
		E_INVALID_ARGUMENT,
	],
	[
		"a non-boolean requireUnreliable",
		{ requireUnreliable: 1 as unknown as boolean },
		E_INVALID_ARGUMENT,
	],
	[
		"serverCertificateHashes that is not an array",
		{ serverCertificateHashes: {} as unknown as [] },
		E_INVALID_ARGUMENT,
	],
	[
		"allowPooling with serverCertificateHashes",
		{ allowPooling: true, serverCertificateHashes: [hash] },
		E_UNSUPPORTED_ARGUMENT,
		"NotSupportedError",
	],
];

describe("client option validation is one contract on both APIs", () => {
	for (const [label, opts, code, name] of shared) {
		it(`connect() rejects ${label}`, async () => {
			expectCode(await connectError(opts as ClientOptions), code, name);
		});
		it(`new WebTransport() rejects ${label}`, () => {
			expectCode(facadeError(opts), code, name);
		});
	}

	it("strict mode gives browser names on connect() too", async () => {
		expectCode(
			await connectError({
				congestionControl: "bogus" as "default",
				strictW3CErrors: true,
			}),
			E_INVALID_ARGUMENT,
			"TypeError",
		);
	});

	it("connect() rejects enable0Rtt with allowPooling", async () => {
		expectCode(
			await connectError({ enable0Rtt: true, allowPooling: true }),
			E_UNSUPPORTED_ARGUMENT,
		);
	});

	it("connect() rejects a non-boolean enable0Rtt", async () => {
		expectCode(
			await connectError({ enable0Rtt: "on" as unknown as boolean }),
			E_INVALID_ARGUMENT,
		);
	});
});
