import { describe, expect, test } from "bun:test";
import {
	cellDeadlineMs,
	type DeadlineChild,
	DEADLINE_MARGIN_MS,
	valueOrAfter,
	waitForChildWithDeadline,
} from "./bench-child-deadline.ts";

/**
 * A child that never exits on its own — the wedge this whole module exists for.
 * It records every signal, and only reaps when the test says a signal kills it.
 */
function fakeChild(
	options: { diesOn?: NodeJS.Signals; exitCode?: number } = {},
) {
	const signals: (number | NodeJS.Signals | undefined)[] = [];
	let resolve!: (code: number) => void;
	const exited = new Promise<number>((res) => {
		resolve = res;
	});
	const child: DeadlineChild = {
		exited,
		kill(signal) {
			signals.push(signal);
			if (options.diesOn && signal === options.diesOn)
				resolve(options.exitCode ?? 143);
		},
	};
	return { child, signals, exit: (code: number) => resolve(code) };
}

describe("the pre-registered deadline formula", () => {
	test("is drive + stagger + settle + margin, and nothing else", () => {
		expect(
			cellDeadlineMs({
				driveMs: 60_000,
				connectStaggerMs: 2_000,
				settleMaxMs: 30_000,
			}),
		).toBe(60_000 + 2_000 + 30_000 + DEADLINE_MARGIN_MS);
	});

	test("the G11 gate cell's deadline is 152 s", () => {
		expect(
			cellDeadlineMs({
				driveMs: 60_000,
				connectStaggerMs: 2_000,
				settleMaxMs: 30_000,
			}),
		).toBe(152_000);
	});

	test("a negative or non-finite input is a mistake, not a deadline", () => {
		expect(() =>
			cellDeadlineMs({
				driveMs: Number.NaN,
				connectStaggerMs: 0,
				settleMaxMs: 0,
			}),
		).toThrow(/driveMs/);
		expect(() =>
			cellDeadlineMs({ driveMs: 1, connectStaggerMs: -1, settleMaxMs: 0 }),
		).toThrow(/connectStaggerMs/);
	});
});

describe("waiting for a child under a deadline", () => {
	test("a child that exits in time is untouched and unflagged", async () => {
		const { child, signals, exit } = fakeChild();
		setTimeout(() => exit(0), 20);
		const result = await waitForChildWithDeadline(child, {
			deadlineMs: 5_000,
			sampleIntervalMs: 5,
		});
		expect(result.deadlineBreached).toBe(false);
		expect(result.exitCode).toBe(0);
		expect(signals).toEqual([]);
	});

	test("sampling keeps running for the whole wait", async () => {
		const { child, exit } = fakeChild();
		setTimeout(() => exit(0), 60);
		let samples = 0;
		await waitForChildWithDeadline(child, {
			deadlineMs: 5_000,
			sampleIntervalMs: 5,
			onSample: () => {
				samples += 1;
			},
		});
		expect(samples).toBeGreaterThan(3);
	});

	test("a never-exiting child is SIGTERMed at the deadline and flagged", async () => {
		const { child, signals } = fakeChild({ diesOn: "SIGTERM", exitCode: 143 });
		const phases: string[] = [];
		const result = await waitForChildWithDeadline(child, {
			deadlineMs: 30,
			sampleIntervalMs: 5,
			killGraceMs: 200,
			reapGraceMs: 200,
			onBreach: (phase) => phases.push(phase),
		});
		expect(result.deadlineBreached).toBe(true);
		expect(result.exitCode).toBe(143);
		expect(signals).toEqual(["SIGTERM"]);
		expect(phases).toEqual(["sigterm"]);
	});

	test("a child that ignores SIGTERM gets SIGKILL", async () => {
		const { child, signals } = fakeChild({ diesOn: "SIGKILL", exitCode: 137 });
		const phases: string[] = [];
		const result = await waitForChildWithDeadline(child, {
			deadlineMs: 20,
			sampleIntervalMs: 5,
			killGraceMs: 20,
			reapGraceMs: 200,
			onBreach: (phase) => phases.push(phase),
		});
		expect(result.deadlineBreached).toBe(true);
		expect(result.exitCode).toBe(137);
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(phases).toEqual(["sigterm", "sigkill"]);
	});

	test("a child that survives SIGKILL still returns, with no exit code", async () => {
		// The whole point: the conductor comes back either way. An unreaped child
		// must not be able to hold the run the way it held G7's.
		const { child, signals } = fakeChild();
		const phases: string[] = [];
		const result = await waitForChildWithDeadline(child, {
			deadlineMs: 20,
			sampleIntervalMs: 5,
			killGraceMs: 20,
			reapGraceMs: 20,
			onBreach: (phase) => phases.push(phase),
		});
		expect(result.deadlineBreached).toBe(true);
		expect(result.exitCode).toBeNull();
		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(phases).toEqual(["sigterm", "sigkill", "unreaped"]);
	});

	test("a child whose exit promise rejects does not take the conductor down", async () => {
		const child: DeadlineChild = {
			exited: Promise.reject(new Error("spawn failed")),
			kill() {},
		};
		const result = await waitForChildWithDeadline(child, {
			deadlineMs: 200,
			sampleIntervalMs: 5,
		});
		expect(result.deadlineBreached).toBe(false);
		expect(result.exitCode).toBeNull();
	});

	test("the breach is detected inside one sample interval of the deadline", async () => {
		const { child } = fakeChild({ diesOn: "SIGTERM" });
		const startedAt = Date.now();
		const result = await waitForChildWithDeadline(child, {
			deadlineMs: 40,
			sampleIntervalMs: 5,
			killGraceMs: 50,
			reapGraceMs: 50,
		});
		expect(result.deadlineBreached).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(40 + 5 + 500);
	});
});

describe("bounded reads of a killed child's pipes", () => {
	test("the value when it arrives in time", async () => {
		expect(await valueOrAfter(Promise.resolve("out"), 500, "")).toBe("out");
	});

	test("the fallback when the pipe never closes", async () => {
		expect(await valueOrAfter(new Promise<string>(() => {}), 10, "")).toBe("");
	});

	test("the fallback when the read fails", async () => {
		expect(await valueOrAfter(Promise.reject(new Error("gone")), 500, "")).toBe(
			"",
		);
	});
});
