import { expect, test } from "bun:test";
import {
	makeAttributionWorkPlan,
	makeCandidateAttributionWorkPlan,
	makeCapacityLadderWorkPlan,
} from "./g6-c32-capacity-work.ts";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import { workProfileFixture } from "./g6-c32-work-fixture.test-helper.ts";
import {
	makeAttributionWorkProfiles,
	makeCandidateAttributionWorkProfiles,
	makeCandidateLadderWorkProfiles,
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

test("clientProcesses is an optional exact integer knob from 1 to 16", () => {
	const plan = makeCapacityLadderWorkPlan();
	for (const clientProcesses of [1, 4, 16])
		expect(
			validateWorkProfiles(plan, {
				candidate: { ...workProfileFixture, clientProcesses },
			}).candidate?.clientProcesses,
		).toBe(clientProcesses);
	expect(
		validateWorkProfiles(plan, { candidate: workProfileFixture }).candidate,
	).not.toHaveProperty("clientProcesses");
	for (const clientProcesses of [0, 17, 1.5, "4", null, -1, Number.NaN])
		expect(() =>
			validateWorkProfiles(plan, {
				candidate: { ...workProfileFixture, clientProcesses },
			}),
		).toThrow("clientProcesses must be an integer from 1 to 16");
});

test("r5 B profiles carry clientProcesses only when chosen; A' arms never do", () => {
	const common = { ...workProfileFixture, datagramPump: "pump" as const };
	const plain = makeCandidateLadderWorkProfiles(common, {
		sendPath: "stock",
		probe: true,
	});
	expect(plain.candidate).not.toHaveProperty("clientProcesses");
	const fanned = makeCandidateLadderWorkProfiles(common, {
		sendPath: "stock",
		probe: true,
		clientProcesses: 4,
	});
	expect(fanned.candidate).toEqual({
		...requireDefined(plain.candidate),
		clientProcesses: 4,
	});
	expect(
		validateWorkProfiles(
			makeCapacityLadderWorkPlan("g6-capacity-ladder-b-r5"),
			fanned,
		),
	).toEqual(fanned);
	// The choice, not an inherited common value, sets the B process count.
	expect(
		makeCandidateLadderWorkProfiles(
			{ ...common, clientProcesses: 8 },
			{ sendPath: "stock", probe: true },
		).candidate,
	).not.toHaveProperty("clientProcesses");
	expect(() =>
		makeCandidateLadderWorkProfiles(common, {
			sendPath: "stock",
			probe: true,
			clientProcesses: 17,
		}),
	).toThrow("clientProcesses");
	const attribution = makeCandidateAttributionWorkProfiles(common);
	for (const arm of Object.values(attribution))
		expect(arm).not.toHaveProperty("clientProcesses");
	expect(() =>
		validateWorkProfiles(makeCandidateAttributionWorkPlan(), {
			...attribution,
			XB: { ...attribution.XB, clientProcesses: 4 },
		}),
	).toThrow("attribution-r4 profiles never carry clientProcesses");
});
