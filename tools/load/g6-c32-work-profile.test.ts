import { expect, test } from "bun:test";
import {
	makeAttributionWorkPlan,
	makeCapacityLadderWorkPlan,
} from "./g6-c32-capacity-work.ts";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import { workProfileFixture } from "./g6-c32-work-fixture.test-helper.ts";
import {
	makeAttributionWorkProfiles,
	validateWorkProfiles,
} from "./g6-c32-work-profile.ts";

test("frozen A profiles bind every knob and isolate the probe and peer-hint experiments", () => {
	const profiles = makeAttributionWorkProfiles(workProfileFixture);
	expect(validateWorkProfiles(makeAttributionWorkPlan(), profiles)).toEqual(
		profiles,
	);
	expect(
		Object.values(profiles).map((p) => [
			p.udpSendBatch,
			p.reflectRingBypass,
			p.detailedProbe,
			p.nativeDiagnostics,
		]),
	).toEqual([
		[0, "off", false, true],
		[0, "off", true, true],
		[64, "off", true, true],
		[64, "on", true, true],
	]);
	requireDefined(profiles["batch-hint"]).connectConcurrency++;
	expect(() =>
		validateWorkProfiles(makeAttributionWorkPlan(), profiles),
	).toThrow("common");
});

test("profiles reject missing bindings, unknown knobs, disabled counters, and legacy drop mode", () => {
	const plan = makeCapacityLadderWorkPlan();
	for (const profiles of [
		{},
		{ candidate: { ...workProfileFixture, nativeDiagnostics: false } },
		{ candidate: { ...workProfileFixture, serverUdpSendEagainMode: "drop" } },
		{ candidate: { ...workProfileFixture, surprise: 1 } },
		{
			candidate: {
				...workProfileFixture,
				udpSendBatch: 0,
				reflectRingBypass: "on",
			},
		},
	])
		expect(() => validateWorkProfiles(plan, profiles)).toThrow();
});
