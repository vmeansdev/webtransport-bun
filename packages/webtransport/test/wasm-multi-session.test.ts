import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	createWasmServer,
	type WasmSession,
} from "../src/backend.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

describe("wasm multi-session product surface", () => {
	test.skipIf(!wasmAvailable)(
		"two CONNECTs yield two WasmSessions with datagram isolation",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4433 };
			const clientAddr = { address: "127.0.0.1", port: 5544 };
			const serverSessions: WasmSession[] = [];

			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				(session) => {
					serverSessions.push(session);
					session.onDatagram((d) => {
						void session.sendDatagram(d);
					});
				},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				{ wtMaxSessions: 2 },
			);

			const { session: primary, manager: clientMgr } = await connectWasm(
				wasm,
				relay.endpoint(clientAddr),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
			);
			await primary.ready;

			const secondary = await clientMgr.openSession(primary.conn);
			await secondary.ready;

			expect(primary.sessionId).not.toBe(secondary.sessionId);
			expect(serverSessions.length).toBe(2);

			let primaryEcho: Uint8Array | null = null;
			let secondaryEcho: Uint8Array | null = null;
			primary.onDatagram((d) => {
				primaryEcho = d.slice();
			});
			secondary.onDatagram((d) => {
				secondaryEcho = d.slice();
			});

			await primary.sendDatagram(new TextEncoder().encode("from-primary"));
			await secondary.sendDatagram(new TextEncoder().encode("from-secondary"));

			const deadline = Date.now() + 3000;
			while (
				(primaryEcho === null || secondaryEcho === null) &&
				Date.now() < deadline
			) {
				await Bun.sleep(5);
			}
			expect(new TextDecoder().decode(primaryEcho!)).toBe("from-primary");
			expect(new TextDecoder().decode(secondaryEcho!)).toBe("from-secondary");

			secondary.close();
			await secondary.closed;
			// Primary must still be usable after secondary SessionClosed.
			await primary.sendDatagram(new TextEncoder().encode("still-alive"));

			primary.close();
			clientMgr.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"openSession fails with E_LIMIT_EXCEEDED when peer max is 1",
		async () => {
			const relay = new InMemoryRelay();
			const server = createWasmServer(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 4433 }),
				() => {},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				{ wtMaxSessions: 1 },
			);
			const { session: primary, manager: clientMgr } = await connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 5544 }),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
			);
			await primary.ready;
			await expect(clientMgr.openSession(primary.conn)).rejects.toThrow(
				/E_LIMIT_EXCEEDED/,
			);
			clientMgr.close();
			server.close();
		},
	);
});
