import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { trackChildClose, waitForChildClose } from "./g6-child-lifecycle.ts";

describe("G6 child lifecycle", () => {
	test("waits for close even when exit was emitted first", async () => {
		const child = new EventEmitter();
		trackChildClose(child);

		let settled = false;
		const closed = waitForChildClose(child).then(() => {
			settled = true;
		});
		child.emit("exit", 127, null);
		await Promise.resolve();
		expect(settled).toBe(false);

		child.emit("close", 127, null);
		await closed;
		expect(settled).toBe(true);
	});
});
