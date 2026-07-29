import { describe, expect, test } from "bun:test";
import {
	connectWasm,
	createWasmServer,
	normalizeWasmEndpointOptions,
	type WasmSession,
} from "../src/backend.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

describe("wasm dynamic QPACK options", () => {
	test("defaults omit QPACK fields (Chromium-safe capacity 0)", () => {
		const n = normalizeWasmEndpointOptions({});
		expect(n.qpackMaxTableCapacity).toBeUndefined();
		expect(n.qpackBlockedStreams).toBeUndefined();
		expect(n.enableDynamicQpack).toBeUndefined();
	});

	test("enableDynamicQpack aliases 4096/16", () => {
		const n = normalizeWasmEndpointOptions({ enableDynamicQpack: true });
		expect(n.enableDynamicQpack).toBe(true);
		expect(n.qpackMaxTableCapacity).toBe(4096);
		expect(n.qpackBlockedStreams).toBe(16);
	});

	test("explicit capacity>0 defaults blocked streams to 16", () => {
		const n = normalizeWasmEndpointOptions({ qpackMaxTableCapacity: 2048 });
		expect(n.qpackMaxTableCapacity).toBe(2048);
		expect(n.qpackBlockedStreams).toBe(16);
	});

	test.skipIf(!wasmAvailable)(
		"wasm↔wasm session establishes with enableDynamicQpack",
		async () => {
			const relay = new InMemoryRelay();
			const serverAddr = { address: "127.0.0.1", port: 4433 };
			const clientAddr = { address: "127.0.0.1", port: 5544 };
			const serverSessions: WasmSession[] = [];
			const qpackOpts = { enableDynamicQpack: true as const };

			const server = createWasmServer(
				wasm,
				relay.endpoint(serverAddr),
				(session) => {
					serverSessions.push(session);
				},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				qpackOpts,
			);

			// connectWasm awaits session.ready before resolving.
			const { session: primary, manager: clientMgr } = await connectWasm(
				wasm,
				relay.endpoint(clientAddr),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				qpackOpts,
			);
			expect(serverSessions.length).toBe(1);

			primary.close();
			clientMgr.close();
			server.close();
		},
	);
});
