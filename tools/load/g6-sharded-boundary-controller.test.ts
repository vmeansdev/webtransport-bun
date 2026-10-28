import { describe, expect, test } from "bun:test";
import { createShardBoundaryController } from "./g6-sharded-boundary-controller.ts";

describe("G6 sharded boundary controller", () => {
	test("rejects all pending boundaries and suppresses artifact output after failure", async () => {
		const controller = createShardBoundaryController<number>();
		const first = controller.wait();
		const second = controller.wait();
		const markers = Promise.all([first, second]);
		let writes = 0;

		controller.fail(new Error("shard 4 fatal: mirror contract broken"));

		await expect(markers).rejects.toThrow("shard 4 fatal");
		await expect(
			controller.finalize([markers], () => (writes += 1)),
		).rejects.toThrow("shard 4 fatal");
		expect(writes).toBe(0);
	});

	test("writes only after all resolved marker work completes", async () => {
		const controller = createShardBoundaryController<number>();
		const marker = controller.wait();
		controller.resolve(7);
		let writes = 0;

		await controller.finalize([marker], () => (writes += 1));
		expect(await marker).toBe(7);
		expect(writes).toBe(1);
	});
});
