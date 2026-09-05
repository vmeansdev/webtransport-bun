import { describe, expect, it } from "bun:test";
import {
	isStableNativeError,
	runBoundedOverloadProof,
} from "./g6-capacity-overload.ts";

describe("g6 capacity bounded overload proof", () => {
	it("does not mistake its own failure text for a native timeout", () => {
		expect(
			isStableNativeError(
				new Error("server did not hit E_BACKPRESSURE_TIMEOUT"),
				"E_BACKPRESSURE_TIMEOUT",
			),
		).toBe(false);
		expect(
			isStableNativeError(
				new Error("missing E_BACKPRESSURE_TIMEOUT"),
				"E_BACKPRESSURE_TIMEOUT",
			),
		).toBe(false);
		expect(
			isStableNativeError(
				new Error("E_BACKPRESSURE_TIMEOUT"),
				"E_BACKPRESSURE_TIMEOUT",
			),
		).toBe(true);
		expect(
			isStableNativeError(
				Object.assign(new Error("native timed out"), {
					code: "E_BACKPRESSURE_TIMEOUT",
				}),
				"E_BACKPRESSURE_TIMEOUT",
			),
		).toBe(true);
	});
	it("exercises owned ephemeral capacity, limit shedding, backpressure timeout, and teardown gauges", async () => {
		const report = await runBoundedOverloadProof();

		expect(report.source.defaults.maxQueuedBytesPerSession).toBe(
			2 * 1024 * 1024,
		);
		expect(report.source.defaults.maxQueuedBytesGlobal).toBe(512 * 1024 * 1024);
		expect(report.source.diagnostics.mode).toBe("runtime-default-off");
		expect(report.source.diagnostics.enabled).toBe(false);

		expect(report.runtime.port).toBeGreaterThan(0);
		expect(report.runtime.sessionLimit).toBe(1);
		expect(report.runtime.limitExceededError).toContain("E_LIMIT_EXCEEDED");
		expect(report.runtime.backpressureSendError).toContain(
			"E_BACKPRESSURE_TIMEOUT",
		);
		expect(report.runtime.limitExceededCount).toBeGreaterThanOrEqual(1);
		expect(report.runtime.backpressureWaitCount).toBeGreaterThanOrEqual(1);
		expect(report.runtime.backpressureTimeoutCount).toBeGreaterThanOrEqual(1);
		expect(report.runtime.queuedBytesGlobalPeak).toBeGreaterThan(0);
		expect(report.runtime.queuedBytesGlobalPeak).toBeLessThanOrEqual(
			report.runtime.queuedBytesGlobalLimit,
		);
		expect(report.runtime.queuedBytesGlobalAfterClose).toBe(0);
		expect(report.runtime.sessionsActiveAfterClose).toBe(0);
		expect(report.runtime.sessionTasksActiveAfterClose).toBe(0);
		expect(report.runtime.streamTasksActiveAfterClose).toBe(0);
		expect(report.runtime.holdClientExitCode).toBe(0);
		expect(report.runtime.heldSessionKind).toBe("child-handle");
	}, 30_000);
});
