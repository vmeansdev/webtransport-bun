/**
 * Wasm W3C facade option surface (Phase 5) — always runs when wasm pkg exists.
 * Complements parity-options.test.ts (which also supports WEBTRANSPORT_PARITY_BACKEND=wasm).
 */

import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	createWasmServer,
	normalizeWasmEndpointOptions,
	WasmWebTransport,
} from "../src/backend.js";
import {
	E_INVALID_ARGUMENT,
	E_UNSUPPORTED_ARGUMENT,
	WebTransportError,
} from "../src/errors.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { validateWasmWebTransportOptions } from "../src/wasm-webtransport.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

describe.skipIf(!wasmAvailable)("wasm facade options (Phase 5)", () => {
	test("validateWasmWebTransportOptions rejects invalid congestionControl", () => {
		expect(() =>
			validateWasmWebTransportOptions({
				congestionControl: "invalid" as "default",
			}),
		).toThrow(WebTransportError);
		try {
			validateWasmWebTransportOptions({
				congestionControl: "invalid" as "default",
			});
		} catch (e) {
			expect(e).toBeInstanceOf(WebTransportError);
			expect((e as WebTransportError).code).toBe(E_INVALID_ARGUMENT);
		}
	});

	test("allowPooling + serverCertificateHashes throws NotSupportedError", () => {
		try {
			validateWasmWebTransportOptions({
				allowPooling: true,
				serverCertificateHashes: [
					{ algorithm: "sha-256", value: new Uint8Array(32) },
				],
			});
			expect(true).toBe(false);
		} catch (e) {
			expect(e).toBeInstanceOf(WebTransportError);
			expect((e as WebTransportError).code).toBe(E_UNSUPPORTED_ARGUMENT);
			expect((e as WebTransportError).name).toBe("NotSupportedError");
		}
	});

	test("allowPooling / requireUnreliable / congestionControl accepted on live session", async () => {
		const relay = new InMemoryRelay();
		const serverAddr = { address: "127.0.0.1", port: 4433 };
		const clientAddr = { address: "127.0.0.1", port: 5544 };
		const server = createWasmServer(
			wasm,
			relay.endpoint(serverAddr),
			() => {},
			"127.0.0.1:4433",
			"127.0.0.1:5544",
			normalizeWasmEndpointOptions({ wtMaxSessions: 2 }),
		);
		try {
			const { session, manager } = await connectWasm(
				wasm,
				relay.endpoint(clientAddr),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				{
					wtMaxSessions: 2,
					allowPooling: true,
					requireUnreliable: true,
					congestionControl: "low-latency",
				},
			);
			const wt = new WasmWebTransport(session, {
				allowPooling: true,
				requireUnreliable: true,
				congestionControl: "low-latency",
			});
			expect(WasmWebTransport.supportsReliableOnly).toBe(false);
			expect(wt.congestionControl).toBe("low-latency");
			expect(typeof wt.createSendGroup).toBe("function");
			const stats = await wt.getStats();
			expect(stats.datagrams.droppedIncoming).toBe(0);
			wt.close();
			manager.close();
		} finally {
			server.close();
		}
	});

	test("strictW3CErrors maps invalid option to TypeError name", () => {
		try {
			validateWasmWebTransportOptions({
				strictW3CErrors: true,
				congestionControl: "invalid" as "default",
			});
			expect(true).toBe(false);
		} catch (e) {
			expect((e as WebTransportError).name).toBe("TypeError");
			expect((e as WebTransportError).code).toBe(E_INVALID_ARGUMENT);
		}
	});
});
