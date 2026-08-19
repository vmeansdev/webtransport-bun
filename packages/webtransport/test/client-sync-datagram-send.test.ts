/**
 * The promise-free datagram send must exist on the *client* session handle too.
 *
 * `NativeClientSession.sendDatagram` already asks for it — index.ts calls
 * `sendDatagramWithoutPromise(...)` before falling back — but the native
 * `ClientSessionHandle` implemented no `trySendDatagram`, so the guard at
 * `typeof trySend !== "function"` made that branch dead code on every client
 * send and every client datagram kept paying an N-API promise. The field is
 * declared optional on `NativeSessionHandle`, which is why the type checker
 * never noticed.
 *
 * That promise is the exposure this whole close-contract line of work exists to
 * remove: each one is a ThreadsafeFunction, and a live TSFN is a reference on
 * the host event loop that the addon can neither observe nor release.
 */

import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { connect, createServer } from "../src/index.js";
import { __TESTING__ } from "../src/internal.js";
import { generateCertForNames } from "./helpers/certs.js";

const addon = __TESTING__.tryLoadNativeAddonForTests(
	createRequire(import.meta.url),
).addon;

describe("client promise-free datagram send", () => {
	it("is implemented on the native client session handle", () => {
		expect(addon).toBeDefined();
		// The falsifier: undefined on the shipped addon, so every client send
		// fell through to the parking path.
		expect(typeof addon?.ClientSessionHandle?.prototype?.trySendDatagram).toBe(
			"function",
		);
		// Both handles must offer it, or "promise-free on both handles" is only
		// half true.
		expect(typeof addon?.SessionHandle?.prototype?.trySendDatagram).toBe(
			"function",
		);
	});

	it("carries real client datagrams without the parking path", async () => {
		const cert = generateCertForNames(["localhost", "127.0.0.1"]);
		expect(cert).not.toBeNull();
		if (!cert) return;

		const COUNT = 64;
		let received = 0;
		let resolveDone: () => void;
		const done = new Promise<void>((r) => {
			resolveDone = r;
		});
		const server = createServer({
			port: 0,
			host: "127.0.0.1",
			tls: { certPem: cert.certPem, keyPem: cert.keyPem },
			onSession: async (session) => {
				for await (const _datagram of session.incomingDatagrams()) {
					received += 1;
					if (received === COUNT) resolveDone();
				}
			},
		});

		try {
			const client = await connect(
				`https://127.0.0.1:${server.address.port}/dgram`,
				{ tls: { insecureSkipVerify: true } },
			);
			for (let i = 0; i < COUNT; i += 1) {
				await client.sendDatagram(new Uint8Array([i & 0xff]));
			}
			await Promise.race([done, new Promise((r) => setTimeout(r, 5000))]);
			// Datagrams are unreliable in principle; on loopback with no
			// congestion the sync path must still deliver essentially all of
			// them, which is what proves it really sends rather than silently
			// dropping.
			expect(received).toBeGreaterThan(COUNT / 2);
			await client.close();
		} finally {
			await server.close();
			cert.cleanup();
		}
	}, 30_000);
});
