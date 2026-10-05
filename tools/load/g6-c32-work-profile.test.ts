import { expect, test } from "bun:test";
import {
	makeAttributionWorkPlan,
	makeCandidateAttributionWorkPlan,
	makeCapacityLadderWorkPlan,
	makeSendBufferAbWorkPlan,
} from "./g6-c32-capacity-work.ts";
import { requireDefined } from "./g6-c32-freeze-model.ts";
import { workProfileFixture } from "./g6-c32-work-fixture.test-helper.ts";
import {
	makeAttributionWorkProfiles,
	makeCandidateAttributionWorkProfiles,
	makeCandidateLadderWorkProfiles,
	makeSendBufferWorkProfiles,
	SNDBUF_AB_BYTES,
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

test("send-buffer A/B binds the closed B arm and differs only in a 4 MiB server send buffer", () => {
	const common = { ...workProfileFixture, datagramPump: "pump" as const };
	const candidate = requireDefined(
		makeCandidateLadderWorkProfiles(common, {
			sendPath: "stock",
			probe: false,
			clientProcesses: 4,
		}).candidate,
	);
	const ab = makeSendBufferWorkProfiles(candidate);
	expect(ab.D).toEqual(candidate);
	expect(ab.S).toEqual({
		...candidate,
		serverUdpSendBufferBytes: SNDBUF_AB_BYTES,
	});
	for (const order of ["ds", "sd"] as const) {
		const plan = makeSendBufferAbWorkPlan(order);
		expect(plan.nodes.map(({ id }) => id)).toEqual(
			order === "ds" ? ["D50k", "S50k"] : ["S50k", "D50k"],
		);
		expect(
			plan.nodes.every(
				(node) =>
					node.kind === "attribution-r4" &&
					node.requestedSessions === 50000 &&
					node.activeWorkloadSessions === 50000 &&
					node.profile === node.id.slice(0, 1),
			),
		).toBe(true);
		expect(validateWorkProfiles(plan, ab)).toEqual(ab);
		for (const bad of [
			{ ...ab, S: { ...requireDefined(ab.S), connectConcurrency: 60 } },
			{ ...ab, S: { ...requireDefined(ab.S), serverUdpSendBufferBytes: 0 } },
			{
				...ab,
				D: {
					...requireDefined(ab.D),
					serverUdpSendBufferBytes: SNDBUF_AB_BYTES,
				},
			},
			{ D: ab.D },
		])
			expect(() => validateWorkProfiles(plan, bad)).toThrow();
	}
	// Only the closed probe-off fan-out arm may be the base.
	expect(() =>
		makeSendBufferWorkProfiles({ ...candidate, detailedProbe: true }),
	).toThrow(/r5 probe-off ladder candidate/);
	const { clientProcesses: _drop, ...single } = candidate;
	expect(() => makeSendBufferWorkProfiles(single)).toThrow();
	// Other plans still refuse these arm names.
	expect(() =>
		validateWorkProfiles(makeCandidateAttributionWorkPlan(), ab),
	).toThrow();
});
