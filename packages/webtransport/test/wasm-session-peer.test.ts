import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	createWasmServer,
	type WasmSession,
} from "../src/backend.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";
import { withTimeout } from "./helpers/harness.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

describe("wasm session peer", () => {
	test.skipIf(!wasmAvailable)(
		"each side reports the other's address, matching native ServerSession.peer",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4471 };
			const clientAddr = { address: "127.0.0.1", port: 5571 };

			let accepted: WasmSession | null = null;
			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				(session: WasmSession) => {
					accepted = session;
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

			// The client's view is the server's bind address, and vice versa.
			expect(session.peer).toEqual({
				ip: serverAddr.address,
				port: serverAddr.port,
			});
			expect((accepted as unknown as WasmSession).peer).toEqual({
				ip: clientAddr.address,
				port: clientAddr.port,
			});

			manager.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"peer falls back to 0.0.0.0:0 once the connection is gone",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4472 };
			const clientAddr = { address: "127.0.0.1", port: 5572 };

			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				() => {},
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
			expect(session.peer.port).toBe(serverAddr.port);

			manager.close();
			expect(session.peer).toEqual({ ip: "0.0.0.0", port: 0 });

			server.close();
		},
	);
});
