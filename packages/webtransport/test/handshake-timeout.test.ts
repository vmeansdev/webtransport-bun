import { describe, expect, it } from "bun:test";
import { connect, createServer } from "../src/index.js";
import { generateCertForNames } from "./helpers/certs.js";

const OPEN_RATE_LIMITS = {
	handshakesPerSec: 10_000,
	handshakesBurst: 10_000,
	handshakesBurstPerPrefix: 10_000,
};

// A real client's first datagram: its Initial, carrying the ClientHello.
// Caught on a socket that never answers, so the client gets nothing back.
async function captureClientInitial(): Promise<Uint8Array> {
	let initial: Uint8Array | undefined;
	const trap = await Bun.udpSocket({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			data(_socket, buf) {
				initial ??= new Uint8Array(buf);
			},
		},
	});
	const dial = connect(`https://127.0.0.1:${trap.port}/`, {
		tls: { insecureSkipVerify: true },
		limits: { handshakeTimeoutMs: 1000 },
	}).then(
		(s) => s.close(),
		() => undefined,
	);
	const deadline = Date.now() + 5000;
	while (!initial && Date.now() < deadline) await Bun.sleep(10);
	await Promise.race([dial, Bun.sleep(5000)]);
	trap.close();
	if (!initial) throw new Error("client sent no Initial within 5 s");
	return initial;
}

describe("handshakeTimeoutMs bounds the whole server-side handshake", () => {
	// One replayed Initial starts a handshake the sender never finishes. Before
	// the fix that handshake held its maxHandshakesInFlight slot until the QUIC
	// idle timeout, so a few hundred such packets locked new clients out.
	it("releases the slot of a handshake that never completes", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		if (!cert) return;
		const initial = await captureClientInitial();
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			limits: {
				handshakeTimeoutMs: 300,
				idleTimeoutMs: 30_000,
				maxHandshakesInFlight: 1,
			},
			rateLimits: OPEN_RATE_LIMITS,
			onSession: () => {},
		});
		const rogue = await Bun.udpSocket({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {} },
		});
		try {
			rogue.send(initial, server.address.port, "127.0.0.1");

			let deadline = Date.now() + 2000;
			while (
				server.metricsSnapshot().handshakesInFlight === 0 &&
				Date.now() < deadline
			) {
				await Bun.sleep(10);
			}
			expect(server.metricsSnapshot().handshakesInFlight).toBe(1);

			// 300 ms budget; 3 s leaves room for a loaded machine and is still
			// a tenth of the idle timeout that used to release the slot.
			deadline = Date.now() + 3000;
			while (
				server.metricsSnapshot().handshakesInFlight !== 0 &&
				Date.now() < deadline
			) {
				await Bun.sleep(25);
			}
			const after = server.metricsSnapshot();
			expect(after.handshakesInFlight).toBe(0);
			expect(after.limitExceededCount).toBe(1);

			const session = await Promise.race([
				connect(`https://127.0.0.1:${server.address.port}/`, {
					tls: { insecureSkipVerify: true },
				}),
				Bun.sleep(5000).then(() => {
					throw new Error("connect after the stalled handshake hung");
				}),
			]);
			session.close();
		} finally {
			rogue.close();
			await server.close();
			cert.cleanup();
		}
	}, 30_000);
});

describe("handshakeLatency", () => {
	// The histogram used to time only the CONNECT response write (~10 µs).
	// It now spans Initial arrival to CONNECT accepted, which sits inside the
	// client's own connect() span and includes at least a TLS handshake.
	it("measures the handshake, not just the CONNECT response", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		if (!cert) return;
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			rateLimits: OPEN_RATE_LIMITS,
			onSession: () => {},
		});
		try {
			const started = performance.now();
			const session = await Promise.race([
				connect(`https://127.0.0.1:${server.address.port}/`, {
					tls: { insecureSkipVerify: true },
				}),
				Bun.sleep(5000).then(() => {
					throw new Error("connect hung");
				}),
			]);
			const clientMs = performance.now() - started;
			session.close();

			const h = server.metricsSnapshot().handshakeLatency;
			expect(h?.count).toBe(1);
			const serverMs = (h?.sumSecs ?? 0) * 1000;
			expect(serverMs).toBeGreaterThan(0.1);
			expect(serverMs).toBeLessThanOrEqual(clientMs);
		} finally {
			await server.close();
			cert.cleanup();
		}
	}, 15_000);
});
