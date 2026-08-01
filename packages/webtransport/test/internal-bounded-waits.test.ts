import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	nextWithTimeout,
	readWithTimeout,
	waitFor,
	withTimeout,
} from "./helpers/harness.js";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const SCANNER_TEST_TIMEOUT_MS = 15_000;
const tempRoots: string[] = [];

type InteropWaitHelpers = {
	createMonotonicDeadline: (timeoutMs: number) => {
		remainingMs: () => number;
		expired: () => boolean;
	};
	nextWithTimeout: <T>(
		iter: AsyncIterator<T>,
		timeoutMs: number,
		label: string,
		idleDeadline?: () => number,
	) => Promise<IteratorResult<T>>;
	fetchWithTimeout: (
		input: Parameters<typeof fetch>[0],
		init: Parameters<typeof fetch>[1],
		timeoutMs: number,
		label: string,
		idleDeadline?: { remainingMs: () => number; expired: () => boolean },
	) => Promise<Response>;
	readWithTimeout: (
		reader: {
			read: () => Promise<unknown>;
			cancel: (reason?: unknown) => PromiseLike<void>;
		},
		timeoutMs: number,
		label: string,
		idleDeadline?: () => number,
	) => Promise<unknown>;
	promiseWithTimeout: <T>(
		promise: PromiseLike<T>,
		timeoutMs: number,
		label: string,
		idleDeadline?: () => number,
	) => Promise<T>;
};

afterEach(() => {
	for (const root of tempRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function makeTempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "wt-bounded-waits-"));
	tempRoots.push(root);
	return root;
}

function writeFixture(
	root: string,
	relativePath: string,
	contents: string,
): void {
	const fullPath = join(root, relativePath);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, contents, "utf8");
}

function runScanner(root: string) {
	return spawnSync(process.execPath, ["scripts/check-bounded-waits.ts"], {
		cwd: PROJECT_ROOT,
		env: {
			...process.env,
			CHECK_BOUNDED_WAITS_ROOT: root,
			CHECK_BOUNDED_WAITS_TARGETS: [
				"packages/webtransport/test",
				"tools/interop/tests",
				"tools/interop/tests-wasm",
				"tools/interop/browser-helpers.ts",
				"tools/interop/run-iwa.mjs",
				"examples/webtransport-wasm-iwa/app.js",
			].join(":"),
		},
		encoding: "utf8",
	});
}

function runDefaultScanner(root: string) {
	return spawnSync(process.execPath, ["scripts/check-bounded-waits.ts"], {
		cwd: PROJECT_ROOT,
		env: {
			...process.env,
			CHECK_BOUNDED_WAITS_ROOT: root,
			CHECK_BOUNDED_WAITS_TARGETS: undefined,
		},
		encoding: "utf8",
	});
}

async function interopWaitHelpers(): Promise<InteropWaitHelpers> {
	return (await import(
		"../../../tools/interop/browser-helpers.ts"
	)) as unknown as InteropWaitHelpers;
}

function iteratorSettledByReturn(): AsyncIterator<Uint8Array> {
	let resolveNext: (result: IteratorResult<Uint8Array>) => void = () => {};
	const pendingNext = new Promise<IteratorResult<Uint8Array>>((resolve) => {
		resolveNext = resolve;
	});
	return {
		next: () => pendingNext,
		return: async () => {
			resolveNext({ done: true, value: undefined });
			return { done: true, value: undefined };
		},
	};
}

describe("bounded wait helpers", () => {
	it("package nextWithTimeout rejects when return settles the pending next", async () => {
		await expect(
			nextWithTimeout(
				iteratorSettledByReturn(),
				40,
				"package iterator cleanup race",
			),
		).rejects.toThrow("timeout after 40ms: package iterator cleanup race");
	});

	it("package readWithTimeout rejects when cancel settles a real stream read", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			cancel: () => {
				cancelled = true;
			},
		});
		const reader = stream.getReader();

		await expect(
			readWithTimeout(reader, 40, "package stream cleanup race"),
		).rejects.toThrow("timeout after 40ms: package stream cleanup race");
		expect(cancelled).toBe(true);
	});

	it("interop nextWithTimeout rejects when return settles the pending next", async () => {
		const helpers = await interopWaitHelpers();
		await expect(
			helpers.nextWithTimeout(
				iteratorSettledByReturn(),
				40,
				"interop iterator cleanup race",
			),
		).rejects.toThrow("timeout after 40ms: interop iterator cleanup race");
	});

	it("interop readWithTimeout rejects when cancel settles a real stream read", async () => {
		const helpers = await interopWaitHelpers();
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			cancel: () => {
				cancelled = true;
			},
		});
		const reader = stream.getReader();

		await expect(
			helpers.readWithTimeout(reader, 40, "interop stream cleanup race"),
		).rejects.toThrow("timeout after 40ms: interop stream cleanup race");
		expect(cancelled).toBe(true);
	});

	it("interop promiseWithTimeout rejects a stalled browser lifecycle promise", async () => {
		const helpers = await interopWaitHelpers();
		await expect(
			helpers.promiseWithTimeout(
				new Promise<never>(() => {}),
				40,
				"interop lifecycle",
			),
		).rejects.toThrow("timeout after 40ms: interop lifecycle");
	});

	it("interop fetchWithTimeout aborts a stalled health fetch at the shared deadline", async () => {
		const helpers = await interopWaitHelpers();
		const originalFetch = globalThis.fetch;
		let seenSignal: AbortSignal | undefined;
		const startedAt = performance.now();

		globalThis.fetch = (async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			seenSignal = init?.signal ?? undefined;
			return await new Promise<Response>((_resolve, reject) => {
				seenSignal?.addEventListener(
					"abort",
					() => reject(seenSignal?.reason ?? new Error("aborted")),
					{ once: true },
				);
			});
		}) as typeof fetch;

		try {
			await expect(
				helpers.fetchWithTimeout(
					"http://127.0.0.1:4434/health",
					{ cache: "no-store" } as Parameters<typeof fetch>[1],
					500,
					"interop stalled fetch",
					helpers.createMonotonicDeadline(40),
				),
			).rejects.toThrow("timeout after 500ms: interop stalled fetch");
			expect(seenSignal?.aborted).toBe(true);
			expect(performance.now() - startedAt).toBeLessThan(180);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("interop nextWithTimeout cancels a stalled iterator", async () => {
		const helpers = await interopWaitHelpers();

		let returnCalls = 0;
		const iter: AsyncIterator<Uint8Array> = {
			next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
			return: async () => {
				returnCalls += 1;
				return { done: true, value: undefined };
			},
		};

		await expect(
			helpers.nextWithTimeout(iter, 40, "interop iterator"),
		).rejects.toThrow("timeout after 40ms: interop iterator");
		expect(returnCalls).toBe(1);
	});

	it("interop nextWithTimeout honors an earlier shared idle deadline", async () => {
		const helpers = await interopWaitHelpers();

		const iter: AsyncIterator<Uint8Array> = {
			next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
			return: async () => ({ done: true, value: undefined }),
		};
		const startedAt = performance.now();

		await expect(
			helpers.nextWithTimeout(
				iter,
				500,
				"shared idle deadline",
				() => startedAt + 40,
			),
		).rejects.toThrow("timeout after 500ms: shared idle deadline");
		expect(performance.now() - startedAt).toBeLessThan(180);
	});

	it("rejects at the timeout even when timeout cleanup never settles", async () => {
		const start = performance.now();
		await expect(
			withTimeout(new Promise<never>(() => {}), 40, "hung promise", {
				onTimeout: () => new Promise<void>(() => {}),
			}),
		).rejects.toThrow("timeout after 40ms: hung promise");
		expect(performance.now() - start).toBeLessThan(180);
	});

	it("nextWithTimeout still rejects when iterator return hangs", async () => {
		const iter: AsyncIterator<Uint8Array> = {
			next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
			return: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
		};
		const start = performance.now();
		await expect(nextWithTimeout(iter, 40, "iterator next")).rejects.toThrow(
			"timeout after 40ms: iterator next",
		);
		expect(performance.now() - start).toBeLessThan(180);
	});

	it("readWithTimeout releases the reader even when cancel hangs", async () => {
		let released = false;
		const reader = {
			read: () => new Promise<{ done: boolean; value?: Uint8Array }>(() => {}),
			cancel: () => new Promise<void>(() => {}),
			releaseLock: () => {
				released = true;
			},
		};

		const start = performance.now();
		await expect(readWithTimeout(reader, 40, "reader read")).rejects.toThrow(
			"timeout after 40ms: reader read",
		);
		expect(released).toBe(true);
		expect(performance.now() - start).toBeLessThan(180);
	});

	it("waitFor uses a monotonic clock even if Date.now jumps forward", async () => {
		const originalDateNow = Date.now;
		let dateNowCalls = 0;
		let reads = 0;

		Date.now = () => {
			dateNowCalls += 1;
			return dateNowCalls === 1 ? 0 : 1_000_000;
		};

		try {
			const result = await waitFor(
				() => {
					reads += 1;
					return reads;
				},
				(value) => value >= 3,
				80,
				5,
				"monotonic waitFor",
			);
			expect(result).toBe(3);
		} finally {
			Date.now = originalDateNow;
		}
	});
});

describe("bounded wait policy scanner", () => {
	it("scans the addon interop server by default", () => {
		const root = makeTempRoot();
		writeFixture(
			root,
			"tools/interop/addon-server.ts",
			`
export async function consume(stream: AsyncIterable<Uint8Array>) {
	for await (const chunk of stream) {
		return chunk;
	}
}
`,
		);

		const result = runDefaultScanner(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("tools/interop/addon-server.ts");
		expect(result.stderr).toContain("for await loop without deadline guard");
	}, SCANNER_TEST_TIMEOUT_MS);

	it("scans .mjs and .js targets for the same bounded-wait violations", () => {
		const root = makeTempRoot();
		writeFixture(
			root,
			"tools/interop/run-iwa.mjs",
			`
export async function consume(stream) {
	for await (const chunk of stream) {
		return chunk;
	}
}
`,
		);
		writeFixture(
			root,
			"examples/webtransport-wasm-iwa/app.js",
			`
export async function read(reader) {
	return await reader.read();
}
`,
		);

		const result = runDefaultScanner(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("tools/interop/run-iwa.mjs");
		expect(result.stderr).toContain("examples/webtransport-wasm-iwa/app.js");
		expect(result.stderr).toContain("for await loop without deadline guard");
		expect(result.stderr).toContain("read() outside canonical bounded helper");
	}, SCANNER_TEST_TIMEOUT_MS);

	it("allows only the exact canonical helper files", () => {
		const root = makeTempRoot();
		writeFixture(
			root,
			"packages/webtransport/test/helpers/harness.ts",
			`
export async function nextWithTimeout(iter: AsyncIterator<Uint8Array>) {
	return await Promise.resolve(iter.next());
}

export async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>) {
	return await Promise.resolve(reader.read());
}
`,
		);
		writeFixture(
			root,
			"tools/interop/browser-helpers.ts",
			`
export async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>) {
	return await reader.read();
}

export const BROWSER_READ_WITH_TIMEOUT_SOURCE = readWithTimeout.toString();
`,
		);

		const result = runScanner(root);
		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
	}, SCANNER_TEST_TIMEOUT_MS);

	it("rejects fake helper names outside the canonical helper path", () => {
		const root = makeTempRoot();
		writeFixture(
			root,
			"packages/webtransport/test/helpers/harness.ts",
			`
export async function nextWithTimeout(iter: AsyncIterator<Uint8Array>) {
	return await iter.next();
}
`,
		);
		writeFixture(
			root,
			"packages/webtransport/test/fake-helper.test.ts",
			`
async function nextWithTimeout(iter: AsyncIterator<Uint8Array>) {
	return await iter.next();
}
`,
		);

		const result = runScanner(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("outside canonical bounded helper");
		expect(result.stderr).toContain("fake-helper.test.ts");
	}, SCANNER_TEST_TIMEOUT_MS);

	it("rejects extracted promises, then-chains, bind aliases, and destructured aliases", () => {
		const root = makeTempRoot();
		writeFixture(
			root,
			"packages/webtransport/test/helpers/harness.ts",
			`
export async function nextWithTimeout(iter: AsyncIterator<Uint8Array>) {
	return await iter.next();
}

export async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>) {
	return await reader.read();
}
`,
		);
		writeFixture(
			root,
			"packages/webtransport/test/extracted-promise.test.ts",
			`
export async function consume(reader: ReadableStreamDefaultReader<Uint8Array>) {
	const pending = reader.read();
	return await pending;
}
`,
		);
		writeFixture(
			root,
			"packages/webtransport/test/then-chain.test.ts",
			`
export async function consume(reader: ReadableStreamDefaultReader<Uint8Array>) {
	return reader.read().then((value) => value);
}
`,
		);
		writeFixture(
			root,
			"packages/webtransport/test/bind-alias.test.ts",
			`
export async function consume(reader: ReadableStreamDefaultReader<Uint8Array>) {
	const readLater = reader.read.bind(reader);
	return await readLater();
}
`,
		);
		writeFixture(
			root,
			"packages/webtransport/test/destructured-alias.test.ts",
			`
export async function consume(iter: AsyncIterator<Uint8Array>) {
	const { next: advance } = iter;
	return await advance();
}
`,
		);

		const result = runScanner(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("extracted-promise.test.ts");
		expect(result.stderr).toContain("then-chain.test.ts");
		expect(result.stderr).toContain("bind-alias.test.ts");
		expect(result.stderr).toContain("destructured-alias.test.ts");
	}, SCANNER_TEST_TIMEOUT_MS);

	it("rejects open-ended for await loops", () => {
		const root = makeTempRoot();
		writeFixture(
			root,
			"packages/webtransport/test/helpers/harness.ts",
			`
export async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>) {
	return await reader.read();
}
`,
		);
		writeFixture(
			root,
			"packages/webtransport/test/for-await.test.ts",
			`
export async function consume(stream: AsyncIterable<Uint8Array>) {
	for await (const chunk of stream) {
		return chunk;
	}
}
`,
		);

		const result = runScanner(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("for await loop without deadline guard");
		expect(result.stderr).toContain("for-await.test.ts");
	}, SCANNER_TEST_TIMEOUT_MS);
});
