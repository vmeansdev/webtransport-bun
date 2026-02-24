/**
 * Parity tests: Option surface and capability flags (Phase 5).
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { WebTransport, createServer } from "../src/index.js";

describe("parity options (Phase 5)", () => {
	let server: ReturnType<typeof createServer>;
	let port: number;

	beforeAll(async () => {
		port = 15550;
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

	test("WebTransport.supportsReliableOnly is false", () => {
		expect(WebTransport.supportsReliableOnly).toBe(false);
	});

	test("congestionControl option accepted (no-op)", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			congestionControl: "low-latency",
		});
		await wt.ready;
		wt.close();
	});

	test("datagramsReadableType option accepted (no-op)", async () => {
		const wt = new WebTransport(`https://127.0.0.1:${port}`, {
			tls: { insecureSkipVerify: true },
			datagramsReadableType: "bytes",
		});
		await wt.ready;
		wt.close();
	});

	test("invalid congestionControl throws", () => {
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					congestionControl: "invalid" as "default",
				}),
		).toThrow(/congestionControl must be/);
	});

	test("invalid datagramsReadableType throws", () => {
		expect(
			() =>
				new WebTransport(`https://127.0.0.1:${port}`, {
					datagramsReadableType: "invalid" as "bytes",
				}),
		).toThrow(/datagramsReadableType must be/);
	});
});
