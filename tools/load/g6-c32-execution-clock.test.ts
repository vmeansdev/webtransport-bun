import { expect, test } from "bun:test";
import {
	makeAttributionWorkPlan,
	makeCapacityLadderWorkPlan,
} from "./g6-c32-capacity-work.ts";
import {
	executionCutoff,
	requirePreCreateWorkTime,
	teardownCutoff,
} from "./g6-c32-execution-clock.ts";

const epoch = Date.parse("2026-09-05T00:00:00.000Z");
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const plan = makeAttributionWorkPlan();
const entries = [
	{ event: "CREATE_INTENT", recordedAt: at(0) },
	{ event: "CREATE_OBSERVED", recordedAt: at(30) },
	{ event: "CREATE_INTENT", recordedAt: at(90) },
];

test("paid setup and active cutoff use the earliest intent through retries", () => {
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(6000),
			now: at(100),
			setupComplete: false,
		}),
	).toEqual({
		paidStartAt: at(0),
		elapsedPaidSeconds: 100,
		cutoffAt: at(840),
		phase: "setup",
		expired: false,
	});
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(6000),
			now: at(840),
			setupComplete: false,
		}).expired,
	).toBe(true);
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(6000),
			now: at(840),
			setupComplete: true,
		}),
	).toMatchObject({ cutoffAt: at(4260), phase: "active", expired: false });
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(6000),
			now: at(4260),
			setupComplete: true,
		}).expired,
	).toBe(true);
});

test("absolute user deadline always preserves teardown, even during setup", () => {
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(1200),
			now: at(100),
			setupComplete: false,
		}),
	).toMatchObject({ cutoffAt: at(600), phase: "deadline" });
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(1000),
			now: at(500),
			setupComplete: true,
		}).expired,
	).toBe(true);
});

test("pre-create recheck refuses a whole-branch shortage before paid intent", () => {
	expect(() =>
		requirePreCreateWorkTime({ plan, now: at(0), deadline: at(4860) }),
	).not.toThrow();
	expect(() =>
		requirePreCreateWorkTime({ plan, now: at(0.001), deadline: at(4860) }),
	).toThrow(/whole remaining work/);
	expect(() =>
		requirePreCreateWorkTime({
			plan: makeCapacityLadderWorkPlan(),
			now: at(0),
			deadline: at(6360),
		}),
	).not.toThrow();
	expect(() =>
		requirePreCreateWorkTime({
			plan: makeCapacityLadderWorkPlan(),
			now: at(1),
			deadline: at(6360),
		}),
	).toThrow();
	expect(
		executionCutoff({
			plan,
			entries: [],
			deadline: at(5000),
			now: at(100),
			setupComplete: false,
		}),
	).toMatchObject({
		paidStartAt: null,
		elapsedPaidSeconds: 0,
		cutoffAt: at(4400),
	});
});

test("malformed, future, or orphaned paid-clock evidence fails closed", () => {
	for (const invalid of [
		[{ event: "CREATE_OBSERVED", recordedAt: at(30) }],
		[{ event: "CREATE_INTENT", recordedAt: "2026-09-05" }],
		[{ event: "CREATE_INTENT", recordedAt: at(101) }],
		[
			{ event: "CREATE_INTENT", recordedAt: at(50) },
			{ event: "CREATE_OBSERVED", recordedAt: at(49) },
		],
	])
		expect(() =>
			executionCutoff({
				plan,
				entries: invalid,
				deadline: at(6000),
				now: at(100),
				setupComplete: false,
			}),
		).toThrow();
});

test("one teardown reserve bounds collection and deletion across retries and replay", () => {
	const input = {
		plan,
		entries,
		deadline: at(6000),
		now: at(4300),
		setupComplete: true,
		teardownStartedAt: at(4260),
	};
	expect(teardownCutoff(input)).toMatchObject({
		cutoffAt: at(4860),
		collectionCutoffAt: at(4560),
		remainingMilliseconds: 560000,
		collectionExpired: false,
		expired: false,
	});
	expect(teardownCutoff({ ...input, now: at(4560) })).toMatchObject({
		cutoffAt: at(4860),
		collectionExpired: true,
		expired: false,
	});
	expect(teardownCutoff({ ...input, now: at(4860) })).toMatchObject({
		remainingMilliseconds: 0,
		expired: true,
	});
	expect(
		teardownCutoff({ ...input, now: at(5000), teardownStartedAt: at(4999) })
			.cutoffAt,
	).toBe(at(4860));
	expect(teardownCutoff({ ...input, deadline: at(4600) }).cutoffAt).toBe(
		at(4600),
	);
});

test("an early abort gets at most 600 seconds, not the unused active allocation", () => {
	const input = {
		plan,
		entries,
		deadline: at(6000),
		now: at(720),
		setupComplete: false,
		teardownStartedAt: at(600),
	};
	expect(teardownCutoff(input)).toMatchObject({
		cutoffAt: at(1200),
		collectionCutoffAt: at(900),
	});
	expect(
		teardownCutoff({ ...input, now: at(1500), teardownStartedAt: at(1499) })
			.cutoffAt,
	).toBe(at(1440));
	expect(() =>
		teardownCutoff({ ...input, teardownStartedAt: at(721) }),
	).toThrow(/future/);
	expect(
		teardownCutoff({ ...input, entries: [], teardownStartedAt: at(600) })
			.cutoffAt,
	).toBe(at(1200));
});
