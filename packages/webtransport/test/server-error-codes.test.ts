/**
 * Every synchronous createServer failure and every server TLS method failure
 * surfaces as a WebTransportError carrying its stable code, never as a raw
 * Node-API error with the code buried in the message.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
	createServer,
	E_INTERNAL,
	E_INVALID_ARGUMENT,
	E_TLS,
	type ErrorCode,
	type ServerOptions,
	WebTransportError,
	type WebTransportServer,
} from "../src/index.js";
import { generateCertForNames } from "./helpers/certs.js";

const cert = generateCertForNames(["localhost", "127.0.0.1"]);
const ecCert = generateCertForNames(["localhost", "127.0.0.1"], 10, "ec");
if (!cert || !ecCert) throw new Error("failed to generate test certificates");
const tls = { certPem: cert.certPem, keyPem: cert.keyPem };

afterAll(() => {
	cert.cleanup();
	ecCert.cleanup();
});

function syncError(fn: () => unknown): unknown {
	try {
		fn();
	} catch (err) {
		return err;
	}
	throw new Error("expected a synchronous throw");
}

function expectCode(err: unknown, code: ErrorCode): void {
	expect(err).toBeInstanceOf(WebTransportError);
	expect((err as WebTransportError).code).toBe(code);
}

function server(opts: Partial<ServerOptions> = {}): WebTransportServer {
	return createServer({
		host: "127.0.0.1",
		port: 0,
		tls,
		onSession: () => {},
		...opts,
	} as ServerOptions);
}

describe("createServer synchronous failures carry their code", () => {
	const badPorts: Array<[string, unknown]> = [
		["missing", undefined],
		["null", null],
		["a string", "4433"],
		["negative", -1],
		["fractional", 1.5],
		["above 65535", 70_000],
		["NaN", Number.NaN],
	];
	for (const [label, port] of badPorts) {
		it(`port ${label} is E_INVALID_ARGUMENT`, () => {
			const err = syncError(() => server({ port: port as number }));
			expectCode(err, E_INVALID_ARGUMENT);
		});
	}

	it("a port already in use", async () => {
		const first = server();
		try {
			const err = syncError(() => server({ port: first.address.port }));
			expectCode(err, E_INTERNAL);
			expect((err as Error).message).toMatch(/server startup failed/);
		} finally {
			await first.close();
		}
	});

	it("junk certificate PEM is E_TLS", () => {
		const err = syncError(() =>
			server({ tls: { certPem: "junk", keyPem: "junk" } }),
		);
		expectCode(err, E_TLS);
	});

	it("a key that does not match the certificate is E_TLS", () => {
		const err = syncError(() =>
			server({ tls: { certPem: cert.certPem, keyPem: ecCert.keyPem } }),
		);
		expectCode(err, E_TLS);
	});

	it("server tls.caPem is E_TLS", () => {
		const err = syncError(() =>
			server({ tls: { ...tls, caPem: cert.certPem } }),
		);
		expectCode(err, E_TLS);
	});

	it("a conflicting process-wide egressPacer is E_INVALID_ARGUMENT", () => {
		// The pacer is process-wide and first-wins, so this runs in a child.
		const index = new URL("../src/index.ts", import.meta.url).href;
		const child = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`
const { createServer, WebTransportError } = await import(${JSON.stringify(index)});
const opts = { host: "127.0.0.1", port: 0, tls: { certPem: "", keyPem: "" }, onSession: () => {} };
const first = createServer({ ...opts, egressPacer: { pps: 1000 } });
try {
	createServer({ ...opts, egressPacer: { pps: 2000 } });
	console.log("result=accepted");
} catch (err) {
	console.log("result=" + (err instanceof WebTransportError) + ":" + err.code);
}
await first.close();
`,
			],
			{ stdout: "pipe", stderr: "pipe", timeout: 20_000 },
		);
		expect(child.stdout.toString()).toContain("result=true:E_INVALID_ARGUMENT");
	});
});

describe("server TLS methods reject with their code", () => {
	it("updateCert with junk PEM", async () => {
		const s = server();
		try {
			const err = await s
				.updateCert({ certPem: "junk", keyPem: "junk" })
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(WebTransportError);
			expect((err as WebTransportError).code).toBe(E_INTERNAL);
		} finally {
			await s.close();
		}
	});

	it("updateTls with junk PEM", async () => {
		const s = server();
		try {
			const err = await s
				.updateTls({ certPem: "junk", keyPem: "junk" })
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(WebTransportError);
			expect((err as WebTransportError).code).toBe(E_INTERNAL);
		} finally {
			await s.close();
		}
	});

	it("replaceSniCerts and upsertSniCert with junk PEM", async () => {
		const s = server();
		try {
			const entry = { serverName: "a.test", certPem: "x", keyPem: "y" };
			for (const op of [
				() => s.replaceSniCerts([entry]),
				() => s.upsertSniCert(entry),
			]) {
				const err = await op().catch((e: unknown) => e);
				expect(err).toBeInstanceOf(WebTransportError);
				expect((err as WebTransportError).code).toBe(E_INTERNAL);
			}
		} finally {
			await s.close();
		}
	});

	it("removeSniCert of an unknown name", async () => {
		const s = server();
		try {
			const err = await s.removeSniCert("nope.test").catch((e: unknown) => e);
			expect(err).toBeInstanceOf(WebTransportError);
			expect((err as WebTransportError).code).toBe(E_INTERNAL);
		} finally {
			await s.close();
		}
	});

	it("setUnknownSniPolicy with an unknown policy is E_INVALID_ARGUMENT", async () => {
		const s = server();
		try {
			const err = await s
				.setUnknownSniPolicy("bogus" as "reject")
				.catch((e: unknown) => e);
			expect(err).toBeInstanceOf(WebTransportError);
			expect((err as WebTransportError).code).toBe(E_INVALID_ARGUMENT);
			// The policy in force is untouched.
			expect(s.tlsSnapshot().unknownSniPolicy).toBe("reject");
		} finally {
			await s.close();
		}
	});

	it("TLS methods on a closed server", async () => {
		const s = server();
		await s.close();
		const err = await s.updateCert(tls).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(WebTransportError);
		expect((err as WebTransportError).code).toBe("E_SESSION_CLOSED");
	});
});
