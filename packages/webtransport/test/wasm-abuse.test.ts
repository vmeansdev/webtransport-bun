import { describe, expect, test } from "bun:test";
import { normalizeWasmEndpointOptions } from "../src/backend.js";
import { WasmEndpoint, type WasmModule } from "../src/backend-wasm.js";
import { E_RATE_LIMITED } from "../src/errors.js";
import {
	InMemoryRelay,
	type UdpAddr,
	type UdpTransport,
} from "../src/wasm-relay.js";
import { waitFor } from "./helpers/harness.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

// Soft-skip when pkg is absent (local `bun test packages/`). With
// WEBTRANSPORT_REQUIRE_WASM=1 the helper throws at import time instead.
const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

function addr(address: string, port: number): UdpAddr {
	return { address, port };
}

function parseSnapshot(endpoint: WasmEndpoint) {
	return JSON.parse(endpoint.governorSnapshot()) as {
		rateLimitBucketCount?: number;
		rateLimitedHandshakeCount?: number;
		rateLimitedStreamOpenCount?: number;
		rateLimitedDatagramIngressCount?: number;
	};
}

describe.skipIf(!wasmAvailable)("real wasm abuse controls", () => {
	test("handshake rate limits normalize source ports while preserving another peer", async () => {
		const relay = new InMemoryRelay();
		const options = normalizeWasmEndpointOptions({
			rateLimits: {
				handshakesPerSec: 1,
				handshakesBurst: 1,
				streamOpensPerSec: 8,
				streamOpensBurst: 8,
				datagramsIngressPerSec: 8,
				datagramsIngressBurst: 8,
			},
		});
		const serverAddr = addr("127.0.0.1", 4433);
		const aAddr = addr("127.0.0.1", 5544);
		const sameIpOtherPort = addr("127.0.0.1", 5545);
		const bAddr = addr("127.0.0.2", 5544);

		const serverEstablished: number[] = [];
		const clientEstablished = { a: false, a2: false, b: false };
		const server = WasmEndpoint.create(
			wasm,
			relay.endpoint(serverAddr),
			true,
			"127.0.0.1:4433",
			"127.0.0.1:5544",
			options,
			{
				onEstablished: (conn) => serverEstablished.push(conn),
			},
		);
		const clientA = WasmEndpoint.create(
			wasm,
			relay.endpoint(aAddr),
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			options,
			{ onEstablished: () => (clientEstablished.a = true) },
		);
		const clientA2 = WasmEndpoint.create(
			wasm,
			relay.endpoint(sameIpOtherPort),
			false,
			"127.0.0.1:5545",
			"127.0.0.1:4433",
			options,
			{ onEstablished: () => (clientEstablished.a2 = true) },
		);
		const clientB = WasmEndpoint.create(
			wasm,
			relay.endpoint(bAddr),
			false,
			"127.0.0.2:5544",
			"127.0.0.1:4433",
			options,
			{ onEstablished: () => (clientEstablished.b = true) },
		);

		try {
			clientA.connect("localhost");
			clientA2.connect("localhost");
			clientB.connect("localhost");

			await waitFor(
				() => ({
					serverEstablished: serverEstablished.length,
					clientA: clientEstablished.a,
					clientB: clientEstablished.b,
				}),
				(state) =>
					state.serverEstablished === 2 && state.clientA && state.clientB,
				3_000,
				5,
				"two peers establish while same-ip different-port peer is rejected",
			);

			expect(clientEstablished.a2).toBe(false);
			const serverError = server.takeLastError();
			expect(serverError).toContain(E_RATE_LIMITED);
			expect(serverError).not.toContain("127.0.0.1");
			expect(serverError).not.toContain("5545");

			expect(parseSnapshot(server)).toMatchObject({
				rateLimitBucketCount: 2,
				rateLimitedHandshakeCount: 1,
			});
		} finally {
			clientA.close();
			clientA2.close();
			clientB.close();
			server.close();
		}
	});

	test("stream-open rate limits are peer-local and metrics omit addresses", async () => {
		const relay = new InMemoryRelay();
		const options = normalizeWasmEndpointOptions({
			rateLimits: {
				handshakesPerSec: 8,
				handshakesBurst: 8,
				streamOpensPerSec: 1,
				streamOpensBurst: 1,
				datagramsIngressPerSec: 8,
				datagramsIngressBurst: 8,
			},
		});
		const serverAddr = addr("127.0.0.1", 4433);
		const aAddr = addr("127.0.0.1", 5544);
		const bAddr = addr("127.0.0.2", 5544);

		const serverEstablished: number[] = [];
		const serverOpened: Array<{ conn: number; stream: number }> = [];
		const clientConns: number[] = [];
		const server = WasmEndpoint.create(
			wasm,
			relay.endpoint(serverAddr),
			true,
			"127.0.0.1:4433",
			"127.0.0.1:5544",
			options,
			{
				onEstablished: (conn) => serverEstablished.push(conn),
				onStreamOpened: (conn, stream) => serverOpened.push({ conn, stream }),
			},
		);
		const clientA = WasmEndpoint.create(
			wasm,
			relay.endpoint(aAddr),
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			options,
			{ onConnected: (conn) => (clientConns[0] = conn) },
		);
		const clientB = WasmEndpoint.create(
			wasm,
			relay.endpoint(bAddr),
			false,
			"127.0.0.2:5544",
			"127.0.0.1:4433",
			options,
			{ onConnected: (conn) => (clientConns[1] = conn) },
		);

		try {
			const connA = clientA.connect("localhost");
			const connB = clientB.connect("localhost");
			expect(connA).toBeGreaterThan(0);
			expect(connB).toBeGreaterThan(0);
			await waitFor(
				() => serverEstablished.length,
				(established) => established === 2,
				3_000,
				5,
				"both peers establish",
			);

			const aStream1 = clientA.openStream(connA, 0n, true);
			expect(aStream1).toBeGreaterThan(0);
			clientA.streamWrite(aStream1, Uint8Array.of(0x41));
			await waitFor(
				() => serverOpened.length,
				(opened) => opened === 1,
				3_000,
				5,
				"first peer-opened stream",
			);
			const aStream2 = clientA.openStream(connA, 0n, true);
			expect(aStream2).toBeGreaterThan(0);
			clientA.streamWrite(aStream2, Uint8Array.of(0x42));
			const streamLimitError = await waitFor(
				() => server.takeLastError(),
				(error) => error.includes(E_RATE_LIMITED),
				3_000,
				5,
				"same peer second stream is rate limited",
			);
			expect(streamLimitError).not.toContain("127.0.0.");
			expect(streamLimitError).not.toContain("5544");
			const bStream = clientB.openStream(connB, 0n, true);
			expect(bStream).toBeGreaterThan(0);
			clientB.streamWrite(bStream, Uint8Array.of(0x43));
			await waitFor(
				() => serverOpened.length,
				(opened) => opened === 2,
				3_000,
				5,
				"other peer can still open a stream",
			);

			const snapshot = parseSnapshot(server);
			expect(snapshot).toMatchObject({
				rateLimitBucketCount: 2,
				rateLimitedStreamOpenCount: 1,
			});
			expect(JSON.stringify(snapshot)).not.toContain("127.0.0.");
		} finally {
			clientA.close();
			clientB.close();
			server.close();
		}
	});

	test("datagram ingress rate limits close only the abusive peer and redact addresses", async () => {
		const relay = new InMemoryRelay();
		const options = normalizeWasmEndpointOptions({
			rateLimits: {
				handshakesPerSec: 8,
				handshakesBurst: 8,
				streamOpensPerSec: 8,
				streamOpensBurst: 8,
				datagramsIngressPerSec: 1,
				datagramsIngressBurst: 1,
			},
		});
		const serverAddr = addr("127.0.0.1", 4433);
		const aAddr = addr("127.0.0.1", 5544);
		const bAddr = addr("127.0.0.2", 5544);

		const serverEstablished: number[] = [];
		const serverDatagrams: Array<{ conn: number; payload: Uint8Array }> = [];
		const clientClosed = { a: false, b: false };
		const server = WasmEndpoint.create(
			wasm,
			relay.endpoint(serverAddr),
			true,
			"127.0.0.1:4433",
			"127.0.0.1:5544",
			options,
			{
				onEstablished: (conn) => serverEstablished.push(conn),
				onDatagram: (conn, sessionId, data) =>
					serverDatagrams.push({ conn, payload: data.slice() }),
			},
		);
		const clientA = WasmEndpoint.create(
			wasm,
			relay.endpoint(aAddr),
			false,
			"127.0.0.1:5544",
			"127.0.0.1:4433",
			options,
			{ onClosed: () => (clientClosed.a = true) },
		);
		const clientB = WasmEndpoint.create(
			wasm,
			relay.endpoint(bAddr),
			false,
			"127.0.0.2:5544",
			"127.0.0.1:4433",
			options,
			{ onClosed: () => (clientClosed.b = true) },
		);

		try {
			const connA = clientA.connect("localhost");
			const connB = clientB.connect("localhost");
			expect(connA).toBeGreaterThan(0);
			expect(connB).toBeGreaterThan(0);
			await waitFor(
				() => serverEstablished.length,
				(established) => established === 2,
				3_000,
				5,
				"both peers establish for datagram abuse",
			);

			expect(clientA.sendDatagram(connA, sessionId, Uint8Array.of(0x01))).toBe(
				true,
			);
			await waitFor(
				() => serverDatagrams.length,
				(count) => count === 1,
				3_000,
				5,
				"first abusive-peer datagram arrives",
			);
			expect(clientA.sendDatagram(connA, sessionId, Uint8Array.of(0x02))).toBe(
				true,
			);
			const datagramLimitError = await waitFor(
				() => server.takeLastError(),
				(error) => error.includes(E_RATE_LIMITED),
				3_000,
				5,
				"second abusive-peer datagram is rate limited",
			);
			expect(datagramLimitError).not.toContain("127.0.0.");
			expect(datagramLimitError).not.toContain("5544");

			expect(clientB.sendDatagram(connB, sessionId, Uint8Array.of(0x03))).toBe(
				true,
			);
			await waitFor(
				() => ({
					datagrams: serverDatagrams.length,
					aClosed: clientClosed.a,
					bClosed: clientClosed.b,
				}),
				(state) => state.datagrams === 2 && state.aClosed && !state.bClosed,
				3_000,
				5,
				"non-abusive peer stays alive and delivers its datagram",
			);

			const snapshot = parseSnapshot(server);
			expect(snapshot).toMatchObject({
				rateLimitBucketCount: 2,
				rateLimitedDatagramIngressCount: 1,
			});
			expect(JSON.stringify(snapshot)).not.toContain("127.0.0.");
		} finally {
			clientA.close();
			clientB.close();
			server.close();
		}
	});

	test("invalid source metadata is rejected without peer fallback", () => {
		let receive: ((data: Uint8Array, source: UdpAddr) => void) | undefined;
		const transport: UdpTransport = {
			send() {},
			onPacket(callback) {
				receive = callback;
			},
		};
		const options = normalizeWasmEndpointOptions();
		const server = WasmEndpoint.create(
			wasm,
			transport,
			true,
			"127.0.0.1:4433",
			"127.0.0.1:5544",
			options,
		);

		try {
			expect(receive).toBeDefined();
			receive?.(Uint8Array.of(0x01, 0x02), {
				address: "",
				port: Number.NaN,
			});

			const error = server.takeLastError();
			expect(error).toBe("E_INTERNAL: invalid source address");
			expect(error).not.toContain("127.0.0.1");
			expect(error).not.toContain("5544");
			expect(parseSnapshot(server)).toMatchObject({
				rateLimitBucketCount: 0,
				rateLimitedHandshakeCount: 0,
				rateLimitedStreamOpenCount: 0,
				rateLimitedDatagramIngressCount: 0,
			});
		} finally {
			server.close();
		}
	});
});
