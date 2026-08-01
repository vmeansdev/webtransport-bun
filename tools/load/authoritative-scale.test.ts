import { describe, expect, test } from "bun:test";

import {
	buildProcessIsolationEvidence,
	evaluateRepeatedCycle,
} from "./authoritative-scale.ts";

function summary(
	label: string,
	postCloseRssMb: number,
	failures: string[] = [],
) {
	return {
		label,
		failures,
		diagnosticFailures: [
			"RSS did not recover near baseline: allocator residency",
		],
		memoryTelemetry: {
			postCloseRecovery: { rssMb: postCloseRssMb },
		},
	};
}

describe("authoritative scale policy", () => {
	test("keeps in-process RSS diagnostics out of repeated-cycle authority", () => {
		const evidence = evaluateRepeatedCycle([
			summary("cycle-1", 500),
			summary("cycle-2", 520),
		]);

		expect(evidence.status).toBe("pass");
		expect(evidence.comparison).toBe("process-isolated");
		expect(evidence.observedPostCloseGrowthMb).toBeNull();
		expect(evidence.failures).toEqual([]);
	});

	test("fails repeated-cycle authority on logical failures", () => {
		const evidence = evaluateRepeatedCycle([
			summary("cycle-1", 500),
			summary("cycle-2", 900, ["final gauges did not recover"]),
		]);

		expect(evidence.status).toBe("fail");
		expect(evidence.failures).toContain(
			"cycle 2 (cycle-2): final gauges did not recover",
		);
		expect(evidence.failures).not.toContain(
			"repeated-cycle post-close RSS growth",
		);
	});

	test("requires the child process to exit without timeout or pipe-drain residue", () => {
		expect(
			buildProcessIsolationEvidence({
				exitCode: 0,
				exitSignal: null,
				timedOut: false,
				forceKilled: false,
				stdoutDrainTimedOut: false,
				stderrDrainTimedOut: false,
			}),
		).toMatchObject({ status: "pass", childGone: true });

		const failed = buildProcessIsolationEvidence({
			exitCode: -1,
			exitSignal: "SIGKILL",
			timedOut: true,
			forceKilled: true,
			stdoutDrainTimedOut: true,
			stderrDrainTimedOut: false,
		});
		expect(failed.status).toBe("fail");
		expect(failed.childGone).toBe(false);
		expect(failed.failures[0]).toContain("did not exit cleanly");
	});
});
