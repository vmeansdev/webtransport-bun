/**
 * Parity tests: Error and close-info mapping (Phase P4).
 * Verifies WebTransportCloseInfo shape, closeCode/reason normalization.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
	WebTransport,
	createServer,
	WebTransportError,
	E_HANDSHAKE_TIMEOUT,
} from "../src/index.js";

describe("parity error and close mapping (P4)", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = 15540;
		server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		await Bun.sleep(2000);
	});

	afterAll(async () => {
		await server.close();
	});

	test("closed resolves with WebTransportCloseInfo (closeCode, reason)", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		wt.close({ closeCode: 1000, reason: "normal closure" });
		const info = await wt.closed;
		expect(info).toBeDefined();
		expect(typeof info).toBe("object");
		expect(info.closeCode).toBe(1000);
		expect(info.reason).toBe("normal closure");
	});

	test("WebTransportError has code and message (stable shape)", () => {
		const err = new WebTransportError(E_HANDSHAKE_TIMEOUT, "connect timed out");
		expect(err).toBeInstanceOf(WebTransportError);
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe(E_HANDSHAKE_TIMEOUT);
		expect(err.code).toMatch(/^E_/);
		expect(typeof err.message).toBe("string");
	});

	test("constructor rejects unsupported options (allowPooling, requireUnreliable)", () => {
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, { allowPooling: true }),
		).toThrow(/unsupported option 'allowPooling'/);
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					requireUnreliable: true,
				}),
		).toThrow(/unsupported option 'requireUnreliable'/);
	});

	test("serverCertificateHashes: valid format throws not-supported, invalid format throws validation error", () => {
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					serverCertificateHashes: [
						{ algorithm: "sha-256", value: new Uint8Array(32) },
					],
				}),
		).toThrow(/serverCertificateHashes is not supported in this runtime/);
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					serverCertificateHashes: [
						{ algorithm: "sha-384" as "sha-256", value: new Uint8Array(32) },
					],
				}),
		).toThrow(/only supports algorithm "sha-256"/);
	});

	test("createBidirectionalStream rejects sendOrder and sendGroup", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		await expect(
			wt.createBidirectionalStream({ sendOrder: 1 }),
		).rejects.toMatchObject({
			message: expect.stringMatching(/unsupported option 'sendOrder'/),
		});
		await expect(
			wt.createBidirectionalStream({ sendGroup: 1 }),
		).rejects.toMatchObject({
			message: expect.stringMatching(/unsupported option 'sendGroup'/),
		});
		wt.close();
	});

	test("createUnidirectionalStream rejects sendOrder and sendGroup", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		await wt.ready;
		await expect(
			wt.createUnidirectionalStream({ sendOrder: 1 }),
		).rejects.toMatchObject({
			message: expect.stringMatching(/unsupported option 'sendOrder'/),
		});
		await expect(
			wt.createUnidirectionalStream({ sendGroup: 1 }),
		).rejects.toMatchObject({
			message: expect.stringMatching(/unsupported option 'sendGroup'/),
		});
		wt.close();
	});
});
