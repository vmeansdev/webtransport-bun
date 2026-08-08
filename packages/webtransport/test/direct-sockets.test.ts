import { describe, expect, test } from "bun:test";
import {
	DIRECT_SOCKETS_MAX_PENDING_WRITE_BYTES,
	DIRECT_SOCKETS_MAX_PENDING_WRITES,
	DirectSocketsUdpTransport,
} from "../src/direct-sockets.js";

type Deferred = {
	resolve: () => void;
	reject: (error: Error) => void;
};

type FakeSocketState = {
	deferred: Deferred[];
	writes: Array<{ data: Uint8Array }>;
	closed: boolean;
};

function installFakeSocket(state: FakeSocketState): unknown {
	const prior = (globalThis as { UDPSocket?: unknown }).UDPSocket;
	(globalThis as { UDPSocket?: unknown }).UDPSocket = class {
		opened = Promise.resolve({
			readable: new ReadableStream<never>(),
			writable: {
				getWriter: () => ({
					desiredSize: 1,
					ready: Promise.resolve(),
					write: (message: { data: Uint8Array }) => {
						state.writes.push(message);
						return new Promise<void>((resolve, reject) => {
							state.deferred.push({
								resolve,
								reject,
							});
						});
					},
					abort: async (reason?: unknown) => {
						for (const pending of state.deferred.splice(0)) {
							pending.reject(
								reason instanceof Error
									? reason
									: new Error("fake socket aborted"),
							);
						}
					},
					releaseLock: () => {},
				}),
			} as unknown as WritableStream<unknown>,
		});

		async close(): Promise<void> {
			state.closed = true;
			for (const pending of state.deferred.splice(0)) {
				pending.reject(new Error("fake socket closed"));
			}
		}
	};
	return prior;
}

async function waitFor(
	predicate: () => boolean,
	label: string,
	timeoutMs = 1000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`timed out: ${label}`);
		await Bun.sleep(1);
	}
}

describe("Direct Sockets UDP backpressure", () => {
	test("bounds pending count/bytes and drains without fire-and-forget writes", async () => {
		const state: FakeSocketState = { deferred: [], writes: [], closed: false };
		const prior = installFakeSocket(state);
		try {
			const transport = await DirectSocketsUdpTransport.connect(
				"127.0.0.1",
				4433,
			);
			let writableNotifications = 0;
			transport.onWritable(() => {
				writableNotifications += 1;
			});

			const payload = Uint8Array.of(7);
			for (let i = 0; i < DIRECT_SOCKETS_MAX_PENDING_WRITES; i += 1) {
				transport.send(payload, { address: "127.0.0.1", port: 4433 });
			}
			transport.send(new Uint8Array(DIRECT_SOCKETS_MAX_PENDING_WRITE_BYTES), {
				address: "127.0.0.1",
				port: 4433,
			});
			payload[0] = 99;

			await waitFor(() => state.writes.length === 1, "first UDP write");
			expect(transport.pendingWriteCount).toBe(
				DIRECT_SOCKETS_MAX_PENDING_WRITES,
			);
			expect(transport.pendingWriteBytes).toBe(
				DIRECT_SOCKETS_MAX_PENDING_WRITES,
			);
			expect(transport.droppedWriteCount).toBe(1);
			expect(state.writes[0]?.data).toEqual(Uint8Array.of(7));

			while (transport.pendingWriteCount > 0) {
				await waitFor(() => state.deferred.length > 0, "pending UDP writer");
				state.deferred.shift()?.resolve();
				await Bun.sleep(0);
			}
			expect(transport.pendingWriteBytes).toBe(0);
			expect(writableNotifications).toBeGreaterThan(0);

			await transport.close();
			expect(state.closed).toBe(true);
		} finally {
			if (prior === undefined) {
				(globalThis as { UDPSocket?: unknown }).UDPSocket = undefined;
			} else {
				(globalThis as { UDPSocket?: unknown }).UDPSocket = prior;
			}
		}
	});

	test("settled writer failures release the pending budget", async () => {
		const state: FakeSocketState = { deferred: [], writes: [], closed: false };
		const prior = installFakeSocket(state);
		try {
			const transport = await DirectSocketsUdpTransport.connect(
				"127.0.0.1",
				4433,
			);
			transport.send(Uint8Array.of(1, 2), {
				address: "127.0.0.1",
				port: 4433,
			});
			await waitFor(() => state.deferred.length === 1, "failed UDP write");
			state.deferred.shift()?.reject(new Error("transient writer failure"));
			await waitFor(() => transport.pendingWriteCount === 0, "released budget");
			expect(transport.pendingWriteBytes).toBe(0);
			expect(transport.droppedWriteCount).toBe(1);

			transport.send(Uint8Array.of(3), {
				address: "127.0.0.1",
				port: 4433,
			});
			await waitFor(() => state.deferred.length === 1, "recovered UDP write");
			state.deferred.shift()?.resolve();
			await waitFor(
				() => transport.pendingWriteCount === 0,
				"drained recovery",
			);
			await transport.close();
		} finally {
			if (prior === undefined) {
				(globalThis as { UDPSocket?: unknown }).UDPSocket = undefined;
			} else {
				(globalThis as { UDPSocket?: unknown }).UDPSocket = prior;
			}
		}
	});

	test("close clears pending writes without corrupting byte accounting", async () => {
		const state: FakeSocketState = { deferred: [], writes: [], closed: false };
		const prior = installFakeSocket(state);
		try {
			const transport = await DirectSocketsUdpTransport.connect(
				"127.0.0.1",
				4433,
			);
			transport.send(Uint8Array.of(1, 2, 3), {
				address: "127.0.0.1",
				port: 4433,
			});
			await waitFor(() => state.deferred.length === 1, "closing UDP write");
			await transport.close();
			expect(transport.pendingWriteCount).toBe(0);
			expect(transport.pendingWriteBytes).toBe(0);
			expect(state.closed).toBe(true);
		} finally {
			if (prior === undefined) {
				(globalThis as { UDPSocket?: unknown }).UDPSocket = undefined;
			} else {
				(globalThis as { UDPSocket?: unknown }).UDPSocket = prior;
			}
		}
	});
});
