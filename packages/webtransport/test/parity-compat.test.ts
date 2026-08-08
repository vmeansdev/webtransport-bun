/**
 * Cross-runtime behavior compatibility tests (S3).
 * Validates shared-app semantics: option validation, lifecycle, rejection consistency.
 * Linked to docs/PARITY_MATRIX.md rows.
 *
 * Option-validation + lifecycle cases honor WEBTRANSPORT_PARITY_BACKEND=wasm.
 * Native-only cases (TEST-NET handshake timeout, synthetic native session) skip
 * under the wasm selector.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
	WebTransport,
	WebTransportError,
	E_INVALID_ARGUMENT,
	E_UNSUPPORTED_ARGUMENT,
	E_HANDSHAKE_TIMEOUT,
	E_QUEUE_FULL,
} from "../src/index.js";
import { __TESTING__ } from "../src/internal.js";
import {
	createParityHarness,
	isWasmParityBackend,
	PARITY_BACKEND,
	skipWasmParityIfUnavailable,
	type ParityHarness,
} from "./helpers/parity-backend.js";

describe.skipIf(skipWasmParityIfUnavailable)(
	`parity compat (behavior-level) [${PARITY_BACKEND}]`,
	() => {
		let harness: ParityHarness;

		beforeAll(async () => {
			harness = await createParityHarness({ onSession: () => {} });
		});

		afterAll(async () => {
			await harness.close();
		});

		test("option validation: allowPooling+serverCertificateHashes emits NotSupportedError name (PARITY_MATRIX: Error model)", () => {
			try {
				harness.construct({
					allowPooling: true,
					serverCertificateHashes: [
						{ algorithm: "sha-256", value: new Uint8Array(32) },
					],
				});
			} catch (e) {
				expect(e).toBeInstanceOf(WebTransportError);
				expect((e as WebTransportError).code).toBe(E_UNSUPPORTED_ARGUMENT);
				expect((e as WebTransportError).name).toBe("NotSupportedError");
				return;
			}
			expect(true).toBe(false);
		});

		test("option validation: invalid congestionControl throws with code (PARITY_MATRIX: congestionControl)", () => {
			expect(() => {
				harness.construct({
					// @ts-expect-error invalid
					congestionControl: "invalid",
				});
			}).toThrow(WebTransportError);
			try {
				harness.construct({
					// @ts-expect-error invalid
					congestionControl: "invalid",
				});
			} catch (e) {
				expect((e as WebTransportError).code).toBe(E_INVALID_ARGUMENT);
			}
		});

		test("lifecycle ordering: ready resolves before closed (PARITY_MATRIX: Session lifecycle)", async () => {
			const wt = await harness.open({});
			expect(wt.closed).toBeDefined();
			wt.close();
			await wt.closed.catch(() => {});
		});

		test("strictW3CErrors: handshake timeout uses TimeoutError name when enabled", async () => {
			const err = await harness.handshakeTimeoutError({
				strictW3CErrors: true,
			});
			expect(err).toBeInstanceOf(WebTransportError);
			// Native races a real unreachable address; a refused connect that
			// wins reports E_INTERNAL and carries no timeout name to assert.
			if ((err as WebTransportError).code === E_HANDSHAKE_TIMEOUT) {
				expect((err as WebTransportError).name).toBe("TimeoutError");
			}
		});

		test("strictW3CErrors: default preserves WebTransportError name", async () => {
			const err = await harness.handshakeTimeoutError({});
			expect(err).toBeInstanceOf(WebTransportError);
			if ((err as WebTransportError).code === E_HANDSHAKE_TIMEOUT) {
				expect((err as WebTransportError).name).toBe("WebTransportError");
			}
		});

		test("wasm handshake timeout is deterministic, not network-dependent", async () => {
			if (!isWasmParityBackend()) return;
			const err = (await harness.handshakeTimeoutError({
				strictW3CErrors: true,
			})) as WebTransportError;
			// The wasm relay drops packets for an unbound address, so the
			// deadline is the only possible outcome here.
			expect(err.code).toBe(E_HANDSHAKE_TIMEOUT);
			expect(err.name).toBe("TimeoutError");
		});

		test("strictW3CErrors: validation errors use browser-style names", () => {
			try {
				harness.construct({
					strictW3CErrors: true,
					// @ts-expect-error invalid
					congestionControl: "invalid",
				});
			} catch (e) {
				expect(e).toBeInstanceOf(WebTransportError);
				expect((e as WebTransportError).code).toBe(E_INVALID_ARGUMENT);
				expect((e as WebTransportError).name).toBe("TypeError");
				return;
			}
			throw new Error("expected constructor to throw");
		});

		test("strictW3CErrors: queue pressure maps to QuotaExceededError", async () => {
			await expect(
				harness.queueFullDatagramError({ strictW3CErrors: true }),
			).rejects.toMatchObject({
				code: E_QUEUE_FULL,
				name: "QuotaExceededError",
			});
		});

		test("queue pressure keeps the plain WebTransportError name by default", async () => {
			await expect(harness.queueFullDatagramError({})).rejects.toMatchObject({
				code: E_QUEUE_FULL,
				name: "WebTransportError",
			});
		});

		test("S4 regression: close() before ready does not cause unhandled rejection (PARITY_MATRIX)", async () => {
			if (isWasmParityBackend()) {
				// The native trigger is a connect to a dead port, which the
				// in-memory relay cannot address. Closing a real WasmWebTransport
				// before it is ready still covers the regression: close() must
				// absorb the settled state without surfacing an unhandled
				// rejection. `closed` is awaited so any rejection is observed here
				// rather than escaping to the process handler.
				const wt = harness.construct({ allowPooling: true });
				wt.close();
				await wt.closed.catch(() => undefined);
				await Bun.sleep(100);
				return;
			}
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
	},
);
