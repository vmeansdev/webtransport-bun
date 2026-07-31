import { describe, expect, test } from "bun:test";
import {
	EXAMPLE_MAX_STREAM_BODY_BYTES,
	readLimitedChunks,
} from "./stream-limit.js";

function sourceFrom(chunks: Uint8Array[]) {
	let index = 0;
	let returned = false;
	const source = {
		[Symbol.asyncIterator]() {
			return {
				next: async () => {
					const value = chunks[index++];
					return value
						? { done: false as const, value }
						: { done: true as const, value: undefined };
				},
				return: async () => {
					returned = true;
					return { done: true as const, value: undefined };
				},
			};
		},
		wasReturned: () => returned,
	};
	return source;
}

describe("example stream body limits", () => {
	for (const label of ["bidi", "uni"]) {
		test(`${label} accepts exactly the configured cap`, async () => {
			const source = sourceFrom([
				new Uint8Array(EXAMPLE_MAX_STREAM_BODY_BYTES - 1),
				new Uint8Array(1),
			]);
			const chunks = await readLimitedChunks(source);
			expect(chunks).toHaveLength(2);
			expect(chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(
				EXAMPLE_MAX_STREAM_BODY_BYTES,
			);
			expect(source.wasReturned()).toBe(false);
		});

		test(`${label} cancels one byte over the configured cap`, async () => {
			const source = sourceFrom([
				new Uint8Array(EXAMPLE_MAX_STREAM_BODY_BYTES),
				new Uint8Array(1),
			]);
			await expect(readLimitedChunks(source)).rejects.toThrow(/exceeds/);
			expect(source.wasReturned()).toBe(true);
		});
	}
});
