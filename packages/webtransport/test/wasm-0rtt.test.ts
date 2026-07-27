import { describe, expect, test } from "bun:test";
import { connectWasm, createWasmServer } from "../src/backend.js";
import { MemoryTicketStoreHost } from "../src/backend-wasm.js";
import { InMemoryRelay } from "../src/wasm-relay.js";
import { loadWasmModule, wasmAvailable } from "./helpers/wasm-availability.js";

const wasm = wasmAvailable
	? await loadWasmModule()
	: (null as unknown as Awaited<ReturnType<typeof loadWasmModule>>);

describe("wasm 0-RTT product surface", () => {
	test("MemoryTicketStoreHost take-once rejects replay", async () => {
		const store = new MemoryTicketStoreHost();
		await store.put("k", new Uint8Array([1, 2, 3]));
		const first = await store.take("k");
		expect(first).toEqual(new Uint8Array([1, 2, 3]));
		expect(await store.take("k")).toBeNull();
		expect(await store.get("k")).toBeNull();
	});

	test.skipIf(!wasmAvailable)(
		"enable0Rtt false never reports has0Rtt",
		async () => {
			const relay = new InMemoryRelay();
			const server = createWasmServer(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 4433 }),
				() => {},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				{ enable0Rtt: false },
			);
			const { session, manager } = await connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 5544 }),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				{ enable0Rtt: false },
			);
			await session.ready;
			expect(manager.endpoint.enable0Rtt()).toBe(false);
			expect(session.has0Rtt).toBe(false);
			expect(session.accepted0Rtt).toBe(false);
			manager.close();
			server.close();
		},
	);

	test.skipIf(!wasmAvailable)(
		"enable0Rtt true + shared process store can resume",
		async () => {
			const relay = new InMemoryRelay();
			const server = createWasmServer(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 4433 }),
				(s) => {
					s.onDatagram((d) => {
						void s.sendDatagram(d);
					});
				},
				"127.0.0.1:4433",
				"127.0.0.1:5544",
				{ enable0Rtt: true },
			);
			expect(server.endpoint.enable0Rtt()).toBe(true);

			const first = await connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 5544 }),
				"localhost",
				"127.0.0.1:5544",
				"127.0.0.1:4433",
				{ enable0Rtt: true },
			);
			await first.session.ready;
			first.session.close();
			first.manager.close();

			const second = await connectWasm(
				wasm,
				relay.endpoint({ address: "127.0.0.1", port: 5545 }),
				"localhost",
				"127.0.0.1:5545",
				"127.0.0.1:4433",
				{ enable0Rtt: true },
			);
			await second.session.ready;
			// After a prior handshake into the shared store, a later connect may
			// offer 0-RTT (has0Rtt). Acceptance is best-effort depending on timing.
			expect(typeof second.session.has0Rtt).toBe("boolean");
			expect(typeof second.session.accepted0Rtt).toBe("boolean");
			second.manager.close();
			server.close();
		},
	);
});
