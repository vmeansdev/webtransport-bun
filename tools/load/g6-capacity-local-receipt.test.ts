import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateExecutionReceipt } from "./g6-capacity-goal-evaluate.ts";
import { produceLocalReceipt } from "./g6-capacity-local-receipt.ts";
import { capacityLocalProofArgv } from "./g6-capacity-proof-catalog.ts";

const SHA = "c".repeat(40);
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fakeRun(dirty = false, failing = -1) {
	const calls: string[][] = [];
	const run = ((command: string, args: string[]) => {
		calls.push([command, ...args]);
		const out = (stdout: string, status = 0) => ({
			status,
			signal: null,
			stdout: Buffer.from(stdout),
			stderr: Buffer.from(""),
		});
		if (command === "git" && args[0] === "diff") return out("", dirty ? 1 : 0);
		if (command === "git" && args[0] === "rev-parse") return out(`${SHA}\n`);
		if (command === "uname") return out("Darwin\n");
		return out("ok\n", calls.length - 3 === failing ? 1 : 0);
	}) as never;
	return { run, calls };
}

describe("local execution receipt producer", () => {
	test("runs exactly the catalog argv and writes an evaluator-valid, hash-bound receipt", () => {
		const root = mkdtempSync(join(tmpdir(), "g6-receipt-"));
		roots.push(root);
		const { run, calls } = fakeRun();
		const result = produceLocalReceipt({
			kind: "bounded-overload",
			outDir: "ev/overload",
			repoRoot: root,
			run,
		});
		expect(result.exitCodes).toEqual([0, 0, 0]);
		const receipt = validateExecutionReceipt(
			JSON.parse(readFileSync(join(root, result.receiptPath), "utf8")),
		);
		expect(receipt.kind).toBe("bounded-overload");
		expect(receipt.sourceSha).toBe(SHA);
		expect(receipt.liveEvidence).toBe(false);
		expect(receipt.commands.map((c) => c.argv)).toEqual(
			capacityLocalProofArgv("bounded-overload").map((a) => [...a]),
		);
		expect(calls.slice(2, 5)).toEqual(
			capacityLocalProofArgv("bounded-overload").map((a) => [...a]),
		);
		const first = receipt.commands[0];
		expect(readFileSync(join(root, first?.stdoutPath as string), "utf8")).toBe(
			"ok\n",
		);
	});

	test("refuses a dirty tree, Linux-only kinds, unsafe paths and overwriting a receipt", () => {
		const root = mkdtempSync(join(tmpdir(), "g6-receipt-"));
		roots.push(root);
		expect(() =>
			produceLocalReceipt({
				kind: "bounded-overload",
				outDir: "ev/x",
				repoRoot: root,
				run: fakeRun(true).run,
			}),
		).toThrow("uncommitted");
		expect(() =>
			produceLocalReceipt({
				kind: "candidate-local-linux",
				outDir: "ev/x",
				repoRoot: root,
				run: fakeRun().run,
			}),
		).toThrow("unsupported");
		expect(() =>
			produceLocalReceipt({
				kind: "bounded-overload",
				outDir: "../x",
				repoRoot: root,
				run: fakeRun().run,
			}),
		).toThrow("repo-relative");
		produceLocalReceipt({
			kind: "bounded-overload",
			outDir: "ev/y",
			repoRoot: root,
			run: fakeRun().run,
		});
		expect(() =>
			produceLocalReceipt({
				kind: "bounded-overload",
				outDir: "ev/y",
				repoRoot: root,
				run: fakeRun().run,
			}),
		).toThrow("immutable");
	});

	test("records a failing suite exit instead of hiding it", () => {
		const root = mkdtempSync(join(tmpdir(), "g6-receipt-"));
		roots.push(root);
		const result = produceLocalReceipt({
			kind: "harness-lifecycle",
			outDir: "ev/h",
			repoRoot: root,
			run: fakeRun(false, 0).run,
		});
		expect(result.exitCodes[0]).toBe(1);
	});
});
