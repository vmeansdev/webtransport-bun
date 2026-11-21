import { describe, expect, it } from "bun:test";
import {
	type ClientSession,
	connect,
	createServer,
	E_LIMIT_EXCEEDED,
	WebTransportError,
} from "../src/index.js";
import { generateCertForNames } from "./helpers/certs.js";

const OPEN_RATE_LIMITS = {
	handshakesPerSec: 10_000,
	handshakesBurst: 10_000,
	handshakesBurstPerPrefix: 10_000,
};

function codeOf(err: unknown): string | undefined {
	return err instanceof WebTransportError ? err.code : undefined;
}

// Both admission limits are transient "not right now" signals that clients
// retry with backoff, so both must reach the client as E_LIMIT_EXCEEDED
// rather than as an internal error a client cannot tell apart.
describe("admission refusals reach the client as E_LIMIT_EXCEEDED", () => {
	it("maxHandshakesInFlight refusals", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		if (!cert) return;
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			limits: { maxHandshakesInFlight: 1 },
			rateLimits: OPEN_RATE_LIMITS,
			onSession: () => {},
		});
		const sessions: ClientSession[] = [];
		const failures: unknown[] = [];
		try {
			const url = `https://127.0.0.1:${server.address.port}/`;
			await Promise.race([
				Promise.all(
					Array.from({ length: 40 }, () =>
						connect(url, { tls: { insecureSkipVerify: true } }).then(
							(s) => sessions.push(s),
							(e) => failures.push(e),
						),
					),
				),
				Bun.sleep(15_000),
			]);
			// A wave of 40 simultaneous dials against a cap of 1 always
			// overflows; every overflowing dial must carry the admission code.
			expect(failures.length).toBeGreaterThan(0);
			expect(failures.map(codeOf)).toEqual(
				failures.map(() => E_LIMIT_EXCEEDED),
			);
			expect(server.metricsSnapshot().limitExceededCount).toBeGreaterThan(0);
		} finally {
			for (const s of sessions) s.close();
			await server.close();
			cert.cleanup();
		}
	}, 30_000);

	it("maxSessions closes", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		if (!cert) return;
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			limits: { maxSessions: 2 },
			rateLimits: OPEN_RATE_LIMITS,
			onSession: () => {},
		});
		const sessions: ClientSession[] = [];
		try {
			const url = `https://127.0.0.1:${server.address.port}/`;
			for (let i = 0; i < 2; i++) {
				sessions.push(
					await connect(url, { tls: { insecureSkipVerify: true } }),
				);
			}
			let err: unknown;
			try {
				sessions.push(
					await connect(url, { tls: { insecureSkipVerify: true } }),
				);
			} catch (e) {
				err = e;
			}
			// The server completes the handshake and then closes with 3992, so
			// the third session either fails to connect or closes straight away.
			if (err === undefined) {
				const third = sessions[2] as ClientSession;
				const info = await Promise.race([third.closed, Bun.sleep(5000)]);
				expect(info).toMatchObject({ code: 3992 });
			} else {
				expect(codeOf(err)).toBe(E_LIMIT_EXCEEDED);
			}
		} finally {
			for (const s of sessions) s.close();
			await server.close();
			cert.cleanup();
		}
	}, 30_000);
});
