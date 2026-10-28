import { expect, test } from "bun:test";
import {
	makeAttributionWorkPlan,
	makeCapacityLadderWorkPlan,
} from "./g6-c32-capacity-work.ts";
import {
	executionCutoff,
	hostReviewCutoff,
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

test("host review preserves 420 seconds from the earliest intent and any earlier absolute cutoff", () => {
	const input = {
		plan,
		entries,
		deadline: at(8000),
		now: at(1679.999),
		setupComplete: false,
	};
	expect(hostReviewCutoff(input)).toMatchObject({
		paidStartAt: at(0),
		cutoffAt: at(1680),
		expired: false,
	});
	for (const now of [1680, 1800, 2100])
		expect(hostReviewCutoff({ ...input, now: at(now) }).expired).toBe(true);
	expect(
		hostReviewCutoff({ ...input, deadline: at(1500), now: at(480) }),
	).toMatchObject({ cutoffAt: at(480), expired: true });
	for (const invalid of [
		[],
		[{ event: "CREATE_INTENT", recordedAt: "2026-09-05" }],
		[{ event: "CREATE_INTENT", recordedAt: at(1800) }],
		[...entries, { event: "CREATE_INTENT", recordedAt: at(50) }],
	])
		expect(() => hostReviewCutoff({ ...input, entries: invalid })).toThrow();
});

test("paid setup and active cutoff use the earliest intent through retries", () => {
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(8000),
			now: at(100),
			setupComplete: false,
		}),
	).toEqual({
		paidStartAt: at(0),
		elapsedPaidSeconds: 100,
		cutoffAt: at(2100),
		phase: "setup",
		expired: false,
	});
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(8000),
			now: at(2100),
			setupComplete: false,
		}).expired,
	).toBe(true);
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(8000),
			now: at(2100),
			setupComplete: true,
		}),
	).toMatchObject({ cutoffAt: at(5520), phase: "active", expired: false });
	expect(
		executionCutoff({
			plan,
			entries,
			deadline: at(8000),
			now: at(5520),
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
		requirePreCreateWorkTime({ plan, now: at(0), deadline: at(6120) }),
	).not.toThrow();
	expect(() =>
		requirePreCreateWorkTime({ plan, now: at(0.001), deadline: at(6120) }),
	).toThrow(/whole remaining work/);
	expect(() =>
		requirePreCreateWorkTime({
			plan: makeCapacityLadderWorkPlan(),
			now: at(0),
			deadline: at(7620),
		}),
	).not.toThrow();
	expect(() =>
		requirePreCreateWorkTime({
			plan: makeCapacityLadderWorkPlan(),
			now: at(1),
			deadline: at(7620),
		}),
	).toThrow();
	expect(
		executionCutoff({
			plan,
			entries: [],
			deadline: at(6260),
			now: at(100),
			setupComplete: false,
		}),
	).toMatchObject({
		paidStartAt: null,
		elapsedPaidSeconds: 0,
		cutoffAt: at(5660),
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
				deadline: at(8000),
				now: at(100),
				setupComplete: false,
			}),
		).toThrow();
});

test("one teardown reserve bounds collection and deletion across retries and replay", () => {
	const input = {
		plan,
		entries,
		deadline: at(8000),
		now: at(5560),
		setupComplete: true,
		teardownStartedAt: at(5520),
	};
	expect(teardownCutoff(input)).toMatchObject({
		cutoffAt: at(6120),
		collectionCutoffAt: at(5820),
		remainingMilliseconds: 560000,
		collectionExpired: false,
		expired: false,
	});
	expect(teardownCutoff({ ...input, now: at(5820) })).toMatchObject({
		cutoffAt: at(6120),
		collectionExpired: true,
		expired: false,
	});
	expect(teardownCutoff({ ...input, now: at(6120) })).toMatchObject({
		remainingMilliseconds: 0,
		expired: true,
	});
	expect(
		teardownCutoff({ ...input, now: at(6260), teardownStartedAt: at(6259) })
			.cutoffAt,
	).toBe(at(6120));
	expect(teardownCutoff({ ...input, deadline: at(5860) }).cutoffAt).toBe(
		at(5860),
	);
});

test("an early abort gets at most 600 seconds, not the unused active allocation", () => {
	const input = {
		plan,
		entries,
		deadline: at(8000),
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
	).toBe(at(2099));
	expect(() =>
		teardownCutoff({ ...input, teardownStartedAt: at(721) }),
	).toThrow(/future/);
	expect(
		teardownCutoff({ ...input, entries: [], teardownStartedAt: at(600) })
			.cutoffAt,
	).toBe(at(1200));
});
