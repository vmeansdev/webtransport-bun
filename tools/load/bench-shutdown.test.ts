import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	CLOSE_BUDGET_MS,
	closeBounded,
	finishRun,
	writeArtifactDurable,
} from "./bench-shutdown.ts";

/** A sleep that resolves immediately but still orders after pending microtasks. */
const fastSleep = (_ms: number) => new Promise<void>((r) => setTimeout(r, 0));

describe("closeBounded", () => {
	test("a close that resolves is reported as closed", async () => {
		const outcome = await closeBounded(async () => {}, { sleepFn: fastSleep });
		expect(outcome.closeState).toBe("closed");
		expect(outcome.closeError).toBeNull();
	});

	test("a close that rejects is recorded, not thrown", async () => {
		const outcome = await closeBounded(
			async () => {
				throw new Error(
					"E_BACKPRESSURE_TIMEOUT: server close abort timed out asyncOpsPending=7",
				);
			},
			{ sleepFn: fastSleep },
		);
		expect(outcome.closeState).toBe("close-failed");
		expect(outcome.closeError).toContain("asyncOpsPending=7");
	});

	test("a close that throws synchronously is recorded, not thrown", async () => {
		const outcome = await closeBounded(
			() => {
				throw new Error("no server");
			},
			{ sleepFn: fastSleep },
		);
		expect(outcome.closeState).toBe("close-failed");
		expect(outcome.closeError).toBe("no server");
	});

	test("a close that never settles returns when the budget expires", async () => {
		const outcome = await closeBounded(() => new Promise<void>(() => {}), {
			budgetMs: 20,
		});
		expect(outcome.closeState).toBe("budget-expired");
		expect(outcome.closeError).toBeNull();
	});

	test("a rejection arriving after the budget does not go unhandled", async () => {
		let rejectLater: (err: Error) => void = () => {};
		const outcome = await closeBounded(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectLater = reject;
				}),
			{ budgetMs: 10 },
		);
		expect(outcome.closeState).toBe("budget-expired");
		// The conductor has already moved on; this must not surface as an
		// unhandled rejection and take the process down before it can exit.
		rejectLater(new Error("late drain failure"));
		await new Promise((r) => setTimeout(r, 20));
	});

	test("the budget is the pre-registered one by default", () => {
		expect(CLOSE_BUDGET_MS).toBe(30_000);
	});
});

describe("finishRun", () => {
	test("kills children before closing, then exits zero", async () => {
		const order: string[] = [];
		// A holder, not a `let`: the narrower reads a value only ever assigned
		// inside a callback back as its initial type.
		const exited = { code: null as number | null };
		await finishRun({
			closeServer: async () => {
				order.push("close");
			},
			killChildren: () => {
				order.push("kill");
			},
			sleepFn: fastSleep,
			exit: ((code: number) => {
					exited.code = code;
			}) as unknown as (code: number) => never,
		});
		expect(order).toEqual(["kill", "close"]);
		expect(exited.code).toBe(0);
	});

	test("exits even when close never settles", async () => {
		// A holder, not a `let`: the narrower reads a value only ever assigned
		// inside a callback back as its initial type.
		const exited = { code: null as number | null };
		const notes: string[] = [];
		await finishRun({
			closeServer: () => new Promise<void>(() => {}),
			budgetMs: 20,
			onNote: (n) => notes.push(n),
			exit: ((code: number) => {
					exited.code = code;
			}) as unknown as (code: number) => never,
		});
		expect(exited.code).toBe(0);
		expect(notes.join("\n")).toContain("did not settle");
	});

	test("exits even when close rejects, and names the lane", async () => {
		// A holder, not a `let`: the narrower reads a value only ever assigned
		// inside a callback back as its initial type.
		const exited = { code: null as number | null };
		const notes: string[] = [];
		await finishRun({
			closeServer: async () => {
				throw new Error("E_BACKPRESSURE_TIMEOUT: asyncOps=[sessionRead:12]");
			},
			sleepFn: fastSleep,
			onNote: (n) => notes.push(n),
			exit: ((code: number) => {
					exited.code = code;
			}) as unknown as (code: number) => never,
		});
		expect(exited.code).toBe(0);
		expect(notes.join("\n")).toContain("sessionRead:12");
	});

	test("a killChildren that throws does not stop the shutdown", async () => {
		// A holder, not a `let`: the narrower reads a value only ever assigned
		// inside a callback back as its initial type.
		const exited = { code: null as number | null };
		const notes: string[] = [];
		await finishRun({
			closeServer: async () => {},
			killChildren: () => {
				throw new Error("kill blew up");
			},
			sleepFn: fastSleep,
			onNote: (n) => notes.push(n),
			exit: ((code: number) => {
					exited.code = code;
			}) as unknown as (code: number) => never,
		});
		expect(exited.code).toBe(0);
		expect(notes.join("\n")).toContain("kill blew up");
	});

	test("a non-zero run outcome is carried through to the exit code", async () => {
		// A holder, not a `let`: the narrower reads a value only ever assigned
		// inside a callback back as its initial type.
		const exited = { code: null as number | null };
		await finishRun({
			closeServer: async () => {},
			exitCode: 3,
			sleepFn: fastSleep,
			exit: ((code: number) => {
					exited.code = code;
			}) as unknown as (code: number) => never,
		});
		expect(exited.code).toBe(3);
	});
});

describe("writeArtifactDurable", () => {
	test("the artifact is readable back after the fsync", () => {
		const dir = mkdtempSync(join(tmpdir(), "bench-shutdown-"));
		try {
			const path = join(dir, "bench.json");
			writeArtifactDurable(path, '{"ok":true}\n');
			expect(readFileSync(path, "utf8")).toBe('{"ok":true}\n');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a rewrite replaces rather than appends", () => {
		const dir = mkdtempSync(join(tmpdir(), "bench-shutdown-"));
		try {
			const path = join(dir, "bench.json");
			writeArtifactDurable(path, "aaaaaaaa");
			writeArtifactDurable(path, "bb");
			expect(readFileSync(path, "utf8")).toBe("bb");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
