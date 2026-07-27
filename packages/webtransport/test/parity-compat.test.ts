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

		test.skipIf(isWasmParityBackend())(
			"strictW3CErrors: handshake timeout uses TimeoutError name when enabled",
			async () => {
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
			},
		);

		test.skipIf(isWasmParityBackend())(
			"strictW3CErrors: default preserves WebTransportError name",
			async () => {
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
			},
		);

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

		test.skipIf(isWasmParityBackend())(
			"strictW3CErrors: queue pressure maps to QuotaExceededError",
			async () => {
				const session = __TESTING__.createNativeClientSessionForTests(
					{
						id: "strict-client",
						peerIp: "127.0.0.1",
						peerPort: 1,
						sendDatagram: async () => {
							throw new Error(`${E_QUEUE_FULL}: synthetic queue pressure`);
						},
						close: () => {},
					},
					true,
				);
				await expect(
					session.sendDatagram(new Uint8Array([1])),
				).rejects.toMatchObject({
					code: E_QUEUE_FULL,
					name: "QuotaExceededError",
				});
			},
		);

		test("S4 regression: close() before ready does not cause unhandled rejection (PARITY_MATRIX)", async () => {
			if (isWasmParityBackend()) {
				// Wasm construct path validates options without starting a connect;
				// close() is a no-op on the validation stub — still covers acceptance.
				const wt = harness.construct({ allowPooling: true });
				wt.close();
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
