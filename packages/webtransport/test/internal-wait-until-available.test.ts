import { describe, expect, it } from "bun:test";
import { __TESTING__ } from "../src/index.js";

describe("internal waitUntilAvailable native signaling", () => {
	it("NativeServerSession.createBidirectionalStream uses native waitBidiCapacity when available", async () => {
		let openAttempts = 0;
		const waits: number[] = [];
		const session = __TESTING__.createNativeServerSessionForTests({
			createBidiStream: async () => {
				openAttempts++;
				if (openAttempts === 1) {
					throw new Error("E_LIMIT_EXCEEDED");
				}
				return {
					id: 42,
					read: async () => null,
					write: async () => {},
					closeWrite: async () => {},
					stopSending: async () => {},
					reset: async () => {},
				};
			},
			waitBidiCapacity: async (remainingMs: number) => {
				waits.push(remainingMs);
			},
			close: () => {},
		});

		const stream = await session.createBidirectionalStream({
			waitUntilAvailable: true,
		});
		expect(stream).toBeDefined();
		expect(openAttempts).toBe(2);
		expect(waits.length).toBe(1);
		expect(waits[0]).toBeGreaterThan(0);
	});

	it("NativeServerSession.createUnidirectionalStream uses native waitUniCapacity when available", async () => {
		let openAttempts = 0;
		const waits: number[] = [];
		const session = __TESTING__.createNativeServerSessionForTests({
			createUniStream: async () => {
				openAttempts++;
				if (openAttempts === 1) {
					throw new Error("E_LIMIT_EXCEEDED");
				}
				return {
					id: 7,
					write: async () => {},
					close: async () => {},
					reset: async () => {},
				};
			},
			waitUniCapacity: async (remainingMs: number) => {
				waits.push(remainingMs);
			},
			close: () => {},
		});

		const stream = await session.createUnidirectionalStream({
			waitUntilAvailable: true,
		});
		expect(stream).toBeDefined();
		expect(openAttempts).toBe(2);
		expect(waits.length).toBe(1);
		expect(waits[0]).toBeGreaterThan(0);
	});
});
