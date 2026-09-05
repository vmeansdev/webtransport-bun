import { requireDefined } from "./g6-c32-freeze-model.ts";
import { validateWorkPlan, type WorkPlan } from "./g6-c32-work-plan.ts";

/** The policy hashes these values; no current/legacy ladder-profile fallback. */
export type WorkProfile = {
	shards: number;
	endpoints: number;
	connectConcurrency: number;
	connectRatePerSec: number;
	fixedSourcePortBase: number;
	receiveBufferBytes: number;
	gradeMode: "historical" | "rca-only";
	ackReflector: "native";
	serverWorkers: number;
	serverGro: "on" | "off";
	serverRecvRuntime: "shared" | "dedicated";
	ackCadence: "default" | "relaxed";
	pacerPps: number;
	udpSendBatch: 0 | 64;
	serverUdpSendBufferBytes: number;
	serverUdpSendEagainMode: "wait";
	reflectRingBypass: "on" | "off";
	detailedProbe: boolean;
	nativeDiagnostics: true;
};
export type WorkProfiles = Record<string, WorkProfile>;
const KEYS = [
	"shards",
	"endpoints",
	"connectConcurrency",
	"connectRatePerSec",
	"fixedSourcePortBase",
	"receiveBufferBytes",
	"gradeMode",
	"ackReflector",
	"serverWorkers",
	"serverGro",
	"serverRecvRuntime",
	"ackCadence",
	"pacerPps",
	"udpSendBatch",
	"serverUdpSendBufferBytes",
	"serverUdpSendEagainMode",
	"reflectRingBypass",
	"detailedProbe",
	"nativeDiagnostics",
];
function fail(message: string): never {
	throw Error(`g6-c32-work-profile: ${message}`);
}
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		fail("profile bindings must be objects");
	return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[]) {
	if (
		Object.keys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		fail("missing or unknown profile bindings/knobs");
}
function profile(value: unknown): WorkProfile {
	const p = object(value);
	exact(p, KEYS);
	for (const key of [
		"shards",
		"endpoints",
		"connectConcurrency",
		"connectRatePerSec",
		"fixedSourcePortBase",
		"receiveBufferBytes",
		"serverWorkers",
		"pacerPps",
		"serverUdpSendBufferBytes",
	])
		if (
			!Number.isSafeInteger(p[key]) ||
			(p[key] as number) <
				(["pacerPps", "serverUdpSendBufferBytes"].includes(key) ? 0 : 1)
		)
			fail(`invalid ${key}`);
	if (
		(p.fixedSourcePortBase as number) + (p.endpoints as number) - 1 > 65535 ||
		(p.shards as number) > 64 ||
		(p.serverWorkers as number) > 64
	)
		fail("profile capacity out of bounds");
	if (
		!["historical", "rca-only"].includes(p.gradeMode as string) ||
		p.ackReflector !== "native" ||
		!["on", "off"].includes(p.serverGro as string) ||
		!["shared", "dedicated"].includes(p.serverRecvRuntime as string) ||
		!["default", "relaxed"].includes(p.ackCadence as string)
	)
		fail("unsupported profile mode");
	if (
		p.serverUdpSendEagainMode !== "wait" ||
		![0, 64].includes(p.udpSendBatch as number)
	)
		fail("selected profiles require batch0/64 and wait semantics");
	if (
		!["on", "off"].includes(p.reflectRingBypass as string) ||
		(p.reflectRingBypass === "on" && p.udpSendBatch !== 64)
	)
		fail("peer hint requires experimental batch64");
	if (typeof p.detailedProbe !== "boolean" || p.nativeDiagnostics !== true)
		fail("native diagnostics must be identically on");
	if (
		p.receiveBufferBytes !== 26_214_400 ||
		(p.serverUdpSendBufferBytes !== 0 &&
			((p.serverUdpSendBufferBytes as number) < 65536 ||
				(p.serverUdpSendBufferBytes as number) > 67108864))
	)
		fail("unsupported socket buffer bound");
	return { ...p } as WorkProfile;
}

export function makeAttributionWorkProfiles(common: WorkProfile): WorkProfiles {
	const p = profile(common);
	return {
		"stock-probe-off": {
			...p,
			udpSendBatch: 0,
			reflectRingBypass: "off",
			detailedProbe: false,
		},
		"stock-probe-on": {
			...p,
			udpSendBatch: 0,
			reflectRingBypass: "off",
			detailedProbe: true,
		},
		"batch-no-hint": {
			...p,
			udpSendBatch: 64,
			reflectRingBypass: "off",
			detailedProbe: true,
		},
		"batch-hint": {
			...p,
			udpSendBatch: 64,
			reflectRingBypass: "on",
			detailedProbe: true,
		},
	};
}

export function validateWorkProfiles(
	planValue: WorkPlan,
	value: unknown,
): WorkProfiles {
	const plan = validateWorkPlan(planValue),
		entries = object(value);
	exact(entries, plan.profiles);
	const result = Object.fromEntries(
		plan.profiles.map((name) => [name, profile(entries[name])]),
	);
	if (plan.nodes.some((node) => node.kind === "attribution")) {
		const base =
			result["stock-probe-on"] ??
			fail("attribution lacks common stock profile");
		const expected = makeAttributionWorkProfiles(base);
		exact(result, Object.keys(expected));
		for (const name of Object.keys(expected))
			if (
				KEYS.some(
					(key) =>
						requireDefined(result[name])[key as keyof WorkProfile] !==
						requireDefined(expected[name])[key as keyof WorkProfile],
				)
			)
				fail("attribution common knobs or experiment bindings differ");
	} else if (Object.values(result).some((p) => !p.detailedProbe))
		fail("ladder detailed probe must be on");
	return result;
}
