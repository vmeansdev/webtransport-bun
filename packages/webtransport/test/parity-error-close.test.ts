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
	E_STREAM_RESET,
	E_STOP_SENDING,
} from "../src/index.js";
import { nextPort, openWTWithRetry } from "./helpers/network.js";

describe("parity error and close mapping (P4)", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = nextPort(15540, 1000);
		server = createServer({
			port,
			tls: { certPem: "", keyPem: "" },
			onSession: () => {},
		});
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		wt.close();
	});

	afterAll(async () => {
		await server.close();
	});

	test("closed resolves with WebTransportCloseInfo (closeCode, reason)", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		wt.close({ closeCode: 1000, reason: "normal closure" });
		const info = await wt.closed;
		expect(info).toBeDefined();
		expect(typeof info).toBe("object");
		expect(info.closeCode).toBe(1000);
		expect(info.reason).toBe("normal closure");
	});

	test("WebTransportError has code, message, source (spec-like shape)", () => {
		const err = new WebTransportError(E_HANDSHAKE_TIMEOUT, "connect timed out");
		expect(err).toBeInstanceOf(WebTransportError);
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe(E_HANDSHAKE_TIMEOUT);
		expect(err.code).toMatch(/^E_/);
		expect(typeof err.message).toBe("string");
		expect(err.source).toBe("session");
		expect(err.streamErrorCode).toBe(null);
	});

	test("WebTransportError source is stream for E_STREAM_RESET and E_STOP_SENDING", () => {
		const resetErr = new WebTransportError(E_STREAM_RESET, "reset");
		expect(resetErr.source).toBe("stream");
		const stopErr = new WebTransportError(E_STOP_SENDING, "stop");
		expect(stopErr.source).toBe("stream");
	});

	test("constructor accepts allowPooling and requireUnreliable booleans", () => {
		expect(() => {
			const pooled = new WebTransport(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
				allowPooling: true,
			});
			pooled.close();
		}).not.toThrow();
		expect(() => {
			const unreliable = new WebTransport(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
				requireUnreliable: true,
			});
			unreliable.close();
		}).not.toThrow();
	});

	test("serverCertificateHashes: valid format accepted, invalid format throws validation error", () => {
		expect(() => {
			const wt = new WebTransport(`https://127.0.0.1:${port}`, {
				tls: { insecureSkipVerify: true },
				serverCertificateHashes: [
					{ algorithm: "sha-256", value: new Uint8Array(32) },
				],
			});
			wt.close();
		}).not.toThrow();
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					serverCertificateHashes: [
						{ algorithm: "sha-384" as "sha-256", value: new Uint8Array(32) },
					],
				}),
		).toThrow(/only supports algorithm "sha-256"/);
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					allowPooling: true,
					serverCertificateHashes: [
						{ algorithm: "sha-256", value: new Uint8Array(32) },
					],
				}),
		).toThrow(/cannot be used with allowPooling=true/);
		// Empty and wrong-size hashes must be rejected (a SHA-256 digest is
		// exactly 32 bytes). Previously an empty value passed validation.
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
					serverCertificateHashes: [
						{ algorithm: "sha-256", value: new Uint8Array(0) },
					],
				}),
		).toThrow(/must be exactly 32 bytes/);
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
					serverCertificateHashes: [
						{ algorithm: "sha-256", value: new Uint8Array(16) },
					],
				}),
		).toThrow(/must be exactly 32 bytes/);
		// An empty array is a silent pinning downgrade — must be rejected.
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					tls: { insecureSkipVerify: true },
					serverCertificateHashes: [],
				}),
		).toThrow(/must be a non-empty array/);
	});

	test("closed rejects (not resolves) when the connection fails to establish", async () => {
		// Port 1 is unbindable/unreachable — connect must fail. Per W3C both
		// ready and closed reject with the same error, so a consumer can tell a
		// failed connect from a clean close.
		const wt = new WebTransport("https://127.0.0.1:1", {
			tls: { insecureSkipVerify: true },
			limits: { handshakeTimeoutMs: 1500 },
		});
		await expect(wt.ready).rejects.toBeInstanceOf(WebTransportError);
		await expect(wt.closed).rejects.toBeInstanceOf(WebTransportError);
	});

	test("draining resolves (does not hang) when the session closes without a local close()", async () => {
		// `draining` must resolve when the session enters its closing phase from
		// something other than a local close() — here a failed connect settles
		// `closed`, which resolves `draining`. Previously it only resolved via
		// local close() and would hang forever otherwise.
		const wt = new WebTransport("https://127.0.0.1:1", {
			tls: { insecureSkipVerify: true },
			limits: { handshakeTimeoutMs: 1500 },
		});
		wt.closed.catch(() => {});
		wt.ready.catch(() => {});
		await expect(
			Promise.race([
				wt.draining,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("draining hung")), 5000),
				),
			]),
		).resolves.toBeUndefined();
	});

	test("connect failure: observing only closed (never awaiting ready) does not leak an unhandled rejection", async () => {
		// Both #ready and #closed reject on connect failure; awaiting only one
		// must not leave the other as an unhandled rejection (process-aborting
		// under --unhandled-rejections=strict).
		const wt = new WebTransport("https://127.0.0.1:1", {
			tls: { insecureSkipVerify: true },
			limits: { handshakeTimeoutMs: 1500 },
		});
		await expect(wt.closed).rejects.toBeInstanceOf(WebTransportError);
		// Give any unhandled-rejection microtask a tick to fire before the test ends.
		await Bun.sleep(50);
	});

	test("createBidirectionalStream applies sendOrder and validates sendGroup ownership", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const group = wt.createSendGroup();
		const withSendOrder = await wt.createBidirectionalStream({ sendOrder: 1 });
		expect(withSendOrder.readable).toBeInstanceOf(ReadableStream);
		expect(withSendOrder.writable).toBeInstanceOf(WritableStream);
		const withSendGroup = await wt.createBidirectionalStream({
			sendGroup: group,
		});
		expect(withSendGroup.readable).toBeInstanceOf(ReadableStream);
		expect(withSendGroup.writable).toBeInstanceOf(WritableStream);
		await expect(
			wt.createBidirectionalStream({ sendGroup: {} as unknown as never }),
		).rejects.toThrow(/sendGroup belongs to another transport/);
		wt.close();
	});

	test("createUnidirectionalStream applies sendOrder and validates sendGroup ownership", async () => {
		const wt = await openWTWithRetry(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
		});
		const group = wt.createSendGroup();
		const withSendOrder = await wt.createUnidirectionalStream({ sendOrder: 1 });
		expect(withSendOrder).toBeInstanceOf(WritableStream);
		const withSendGroup = await wt.createUnidirectionalStream({
			sendGroup: group,
		});
		expect(withSendGroup).toBeInstanceOf(WritableStream);
		await expect(
			wt.createUnidirectionalStream({ sendGroup: {} as unknown as never }),
		).rejects.toThrow(/sendGroup belongs to another transport/);
		wt.close();
	});
});
