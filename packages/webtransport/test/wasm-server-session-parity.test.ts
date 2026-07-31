import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	createWasmServer,
	type WasmSession,
} from "../src/backend.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { toWasmServerSession } from "../src/wasm-server-session.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";
import { nextWithTimeout, withTimeout } from "./helpers/harness.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

let portCursor = 0;
function pair() {
	portCursor += 1;
	return {
		serverAddr: { address: "127.0.0.1", port: 4600 + portCursor },
		clientAddr: { address: "127.0.0.1", port: 5600 + portCursor },
	};
}

async function connectedPair() {
	const { serverAddr, clientAddr } = pair();
	const relay = new InMemoryRelay();
	let accepted: WasmSession | null = null;
	const server = createWasmServer(
		wasm,
		relay.endpoint(serverAddr),
		(s: WasmSession) => {
			accepted = s;
		},
		`${serverAddr.address}:${serverAddr.port}`,
		`${clientAddr.address}:${clientAddr.port}`,
	);
	const { session, manager } = await connectWasm(
		wasm,
		relay.endpoint(clientAddr),
		"localhost",
		`${clientAddr.address}:${clientAddr.port}`,
		`${serverAddr.address}:${serverAddr.port}`,
	);
	await session.ready;
	await withTimeout(
		(async () => {
			while (accepted === null) await Bun.sleep(5);
		})(),
		5000,
		"wasm server accepted a session",
	);
	return {
		serverSession: accepted as unknown as WasmSession,
		clientSession: session,
		cleanup: () => {
			manager.close();
			server.close();
		},
	};
}

describe("WasmServerSession native-shaped surface", () => {
	test("exposes id and peer like native ServerSession", () => {
		const fake = {
			sessionId: 7n,
			peer: { ip: "127.0.0.1", port: 4433 },
		} as unknown as WasmSession;
		const ss = toWasmServerSession(fake);
		expect(ss.id).toBe("7");
		expect(ss.peer).toEqual({ ip: "127.0.0.1", port: 4433 });
	});

	test.skipIf(!wasmAvailable)(
		"incomingDatagrams yields datagrams sent by the client",
		async () => {
			const { serverSession, clientSession, cleanup } = await connectedPair();
			try {
				const facade = toWasmServerSession(serverSession);
				const received: Uint8Array[] = [];
				const pump = (async () => {
					const iter = facade.incomingDatagrams()[Symbol.asyncIterator]();
					try {
						while (received.length < 2) {
							const next = await nextWithTimeout(
								iter,
								5000,
								"wasm server session incoming datagram",
							);
							if (next.done || next.value === undefined) {
								return;
							}
							received.push(next.value.slice());
						}
					} finally {
						await iter.return?.();
					}
				})();

				await clientSession.sendDatagram(Uint8Array.of(1, 2, 3));
				await clientSession.sendDatagram(Uint8Array.of(4, 5));
				await withTimeout(pump, 5000, "server drained two datagrams");

				expect(received[0]).toEqual(Uint8Array.of(1, 2, 3));
				expect(received[1]).toEqual(Uint8Array.of(4, 5));
			} finally {
				cleanup();
			}
		},
	);

	test.skipIf(!wasmAvailable)(
		"createBidirectionalStream returns a W3C readable/writable pair, not a Node duplex",
		async () => {
			const { serverSession, cleanup } = await connectedPair();
			try {
				const facade = toWasmServerSession(serverSession);
				const stream = await facade.createBidirectionalStream();
				// The native Duplex exposes booleans here; the portable contract
				// requires real Web Streams on both halves.
				expect(stream.readable).toBeInstanceOf(ReadableStream);
				expect(stream.writable).toBeInstanceOf(WritableStream);
			} finally {
				cleanup();
			}
		},
	);

	test.skipIf(!wasmAvailable)(
		"getStats reports real counters after traffic",
		async () => {
			const { serverSession, clientSession, cleanup } = await connectedPair();
			try {
				const facade = toWasmServerSession(serverSession);
				await clientSession.sendDatagram(new Uint8Array(64));
				const stats = await facade.getStats();
				expect(stats.bytesReceived).toBeGreaterThan(0);
				expect(stats.bytesSent).toBeGreaterThan(0);
			} finally {
				cleanup();
			}
		},
	);

	test.skipIf(!wasmAvailable)(
		"mixing the deprecated callbacks with the W3C surface fails loudly",
		async () => {
			const { serverSession, cleanup } = await connectedPair();
			try {
				const viaCallback = toWasmServerSession(serverSession);
				viaCallback.onDatagram(() => {});
				expect(() => viaCallback.incomingDatagrams()).toThrow(
					/mutually exclusive/,
				);

				const viaWeb = toWasmServerSession(serverSession);
				viaWeb.incomingDatagrams();
				expect(() => viaWeb.onDatagram(() => {})).toThrow(/already in use/);
			} finally {
				cleanup();
			}
		},
	);
});
