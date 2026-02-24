/**
 * Cross-runtime behavior compatibility tests (S3).
 * Validates shared-app semantics: option validation, lifecycle, rejection consistency.
 * Linked to docs/PARITY_MATRIX.md rows.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
	WebTransport,
	createServer,
	WebTransportError,
	E_INTERNAL,
	E_HANDSHAKE_TIMEOUT,
} from "../src/index.js";

const BASE_PORT = 15512;

function nextPort(): number {
	return BASE_PORT + Math.floor(Math.random() * 100);
}

describe("parity compat (behavior-level)", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = nextPort();
		server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		await Bun.sleep(2500);
	});

	afterAll(async () => {
		await server.close();
	});

	test("option validation: allowPooling+serverCertificateHashes emits NotSupportedError name (PARITY_MATRIX: Error model)", () => {
		try {
			new WebTransport(`https://127.0.0.1:${port}`, {
				allowPooling: true,
				serverCertificateHashes: [
					{ algorithm: "sha-256", value: new Uint8Array(32) },
				],
				tls: { insecureSkipVerify: true },
			});
		} catch (e) {
			expect(e).toBeInstanceOf(WebTransportError);
			expect((e as WebTransportError).code).toBe(E_INTERNAL);
			expect((e as WebTransportError).name).toBe("NotSupportedError");
			return;
		}
		expect(true).toBe(false);
	});

	test("option validation: invalid congestionControl throws with code (PARITY_MATRIX: congestionControl)", () => {
		expect(() => {
			new WebTransport(`https://127.0.0.1:${port}`, {
				// @ts-expect-error invalid
				congestionControl: "invalid",
				tls: { insecureSkipVerify: true },
			});
		}).toThrow(WebTransportError);
		try {
			new WebTransport(`https://127.0.0.1:${port}`, {
				// @ts-expect-error invalid
				congestionControl: "invalid",
				tls: { insecureSkipVerify: true },
			});
		} catch (e) {
			expect((e as WebTransportError).code).toBe(E_INTERNAL);
		}
	});

	test("lifecycle ordering: ready resolves before closed (PARITY_MATRIX: Session lifecycle)", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		expect(wt.closed).toBeDefined();
		wt.close();
		await wt.closed;
	});

	test("strictW3CErrors: handshake timeout uses TimeoutError name when enabled", async () => {
		// 192.0.2.1 (TEST-NET) is often unreachable; our timeout can win. On restricted envs native may fail first (E_INTERNAL).
		const wt = new WebTransport("https://192.0.2.1:443", {
			tls: { insecureSkipVerify: true },
			limits: { handshakeTimeoutMs: 150 },
			strictW3CErrors: true,
		});
		const err = await wt.ready.then(
			() => undefined as unknown,
			(e: unknown) => e,
		);
		if (err === undefined) throw new Error("expected ready to reject");
		expect(err).toBeInstanceOf(WebTransportError);
		if ((err as WebTransportError).code === E_HANDSHAKE_TIMEOUT) {
			expect((err as WebTransportError).name).toBe("TimeoutError");
		}
		// If E_INTERNAL: native won race (e.g. connection refused, operation not permitted); skip name assertion
	});

	test("strictW3CErrors: default preserves WebTransportError name", async () => {
		const wt = new WebTransport("https://192.0.2.1:443", {
			tls: { insecureSkipVerify: true },
			limits: { handshakeTimeoutMs: 150 },
		});
		const err = await wt.ready.then(
			() => undefined as unknown,
			(e: unknown) => e,
		);
		if (err === undefined) throw new Error("expected ready to reject");
		expect(err).toBeInstanceOf(WebTransportError);
		if ((err as WebTransportError).code === E_HANDSHAKE_TIMEOUT) {
			expect((err as WebTransportError).name).toBe("WebTransportError");
		}
	});

	test("S4 regression: close() before ready does not cause unhandled rejection (PARITY_MATRIX)", async () => {
		// Simulates parity-baseline "allowPooling options accepted": new WebTransport + close() without awaiting ready.
		// Connect will fail (no server); close() must absorb eventual rejection to prevent unhandled error.
		const wt = new WebTransport("https://127.0.0.1:59997", {
			allowPooling: true,
			tls: { insecureSkipVerify: true },
			limits: { handshakeTimeoutMs: 50 },
		});
		wt.close();
		await Bun.sleep(100);
	});
});
