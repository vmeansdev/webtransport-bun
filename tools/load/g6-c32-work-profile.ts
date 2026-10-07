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
	/** wtransport driver datagram read path for both roles (r5 and later).
	 * Absent only in historical policies sealed before the knob existed; it is
	 * never defaulted, so their artifact digests are unchanged. */
	datagramPump?: "pump" | "legacy";
	/** Generator processes on the one generator host (1..16). Absent in every
	 * policy sealed before the knob existed and never defaulted, so their
	 * artifact digests are unchanged; the launcher runs absent as 1. */
	clientProcesses?: number;
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
	exact(p, [
		...KEYS,
		...(["datagramPump", "clientProcesses"] as const).filter((key) =>
			Object.hasOwn(p, key),
		),
	]);
	if (
		Object.hasOwn(p, "clientProcesses") &&
		(!Number.isSafeInteger(p.clientProcesses) ||
			(p.clientProcesses as number) < 1 ||
			(p.clientProcesses as number) > 16)
	)
		fail("clientProcesses must be an integer from 1 to 16");
	if (
		Object.hasOwn(p, "datagramPump") &&
		p.datagramPump !== "pump" &&
		p.datagramPump !== "legacy"
	)
		fail("datagramPump must be pump or legacy");
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

/** r5 A' arms on one common base: Xon/Xoff = pump with probe on/off (probe
 * calibration), A0 = legacy inline read (receive-path control), XB = pump with
 * batch64 and no peer hint (send-path comparison). Native counters identical. */
export function makeCandidateAttributionWorkProfiles(
	common: WorkProfile,
): WorkProfiles {
	const p = profile({ ...common, datagramPump: "pump" });
	const stock = {
		...p,
		udpSendBatch: 0 as const,
		reflectRingBypass: "off" as const,
	};
	return {
		Xon: { ...stock, detailedProbe: true, datagramPump: "pump" },
		Xoff: { ...stock, detailedProbe: false, datagramPump: "pump" },
		A0: { ...stock, detailedProbe: false, datagramPump: "legacy" },
		XB: {
			...stock,
			udpSendBatch: 64,
			detailedProbe: false,
			datagramPump: "pump",
		},
	};
}

/** Every r5 B ladder profile variant is source-encoded here; the A' decision
 * record selects one through policy, so B's source equals A''s source. */
export function makeCandidateLadderWorkProfiles(
	common: WorkProfile,
	choice: {
		sendPath: "stock" | "batch64";
		probe: boolean;
		/** Generator processes for every B cell; only the choice sets it. */
		clientProcesses?: number;
	},
): WorkProfiles {
	const { clientProcesses: _inherited, ...p } = profile({
		...common,
		datagramPump: "pump",
	});
	const candidate = profile({
		...p,
		datagramPump: "pump",
		reflectRingBypass: "off",
		udpSendBatch: choice.sendPath === "batch64" ? 64 : 0,
		detailedProbe: choice.probe,
		...(choice.clientProcesses === undefined
			? {}
			: { clientProcesses: choice.clientProcesses }),
	});
	return { candidate };
}

/** Post-closure 50k send-buffer A/B: `D` is the r5 probe-off ladder
 * candidate exactly (the closed B arm); `S` differs only in a 4 MiB server
 * UDP send buffer. Source-encoded so policy can bind nothing else. */
export const SNDBUF_AB_PLAN_IDS = [
	"g6-sndbuf-50k-ab-ds",
	"g6-sndbuf-50k-ab-sd",
	"g6-sndbuf-50k-ab-ds-probe",
	"g6-sndbuf-50k-ab-sd-probe",
] as const;
export const SNDBUF_AB_BYTES = 4_194_304;
/** `probe` turns the detailed Linux probe on in both arms (the grader can
 * then attest the effective send buffer); nothing else changes. */
export function makeSendBufferWorkProfiles(
	candidate: WorkProfile,
	probe = false,
): WorkProfiles {
	const base = profile(candidate);
	if (
		base.datagramPump !== "pump" ||
		base.reflectRingBypass !== "off" ||
		base.udpSendBatch !== 0 ||
		base.detailedProbe !== false ||
		base.serverUdpSendBufferBytes !== 0 ||
		base.clientProcesses === undefined
	)
		fail("send-buffer A/B base must be the r5 probe-off ladder candidate");
	const D = probe ? profile({ ...base, detailedProbe: true }) : base;
	return { D, S: profile({ ...D, serverUdpSendBufferBytes: SNDBUF_AB_BYTES }) };
}

/** Sharded arms (g6-sharded-arms/1): every cell runs the closed 40k
 * deployment exactly — the r5 probe-off ladder candidate (pump, stock send
 * path, probe off, default send buffer) with 24 shards and 4 generator
 * processes. Source-encoded so policy can bind nothing else. */
export const SHARDED_ARMS_PLAN_IDS = [
	"g6-sharded-arms",
	"g6-sharded-arms-storm",
] as const;
export const SHARDED_ARMS_SHARDS = 24;
export const SHARDED_ARMS_CLIENT_PROCESSES = 4;
export function makeShardedArmsWorkProfiles(
	candidate: WorkProfile,
): WorkProfiles {
	const base = profile(candidate);
	if (
		base.datagramPump !== "pump" ||
		base.reflectRingBypass !== "off" ||
		base.udpSendBatch !== 0 ||
		base.detailedProbe !== false ||
		base.serverUdpSendBufferBytes !== 0 ||
		base.pacerPps !== 0 ||
		base.shards !== SHARDED_ARMS_SHARDS ||
		base.clientProcesses !== SHARDED_ARMS_CLIENT_PROCESSES
	)
		fail(
			"sharded arms run the closed 40k deployment: r5 probe-off ladder candidate, 24 shards, 4 generator processes",
		);
	return { candidate: base };
}

const R5_KEYS = [...KEYS, "datagramPump"];
const R5_LADDER_IDS = new Set([
	"g6-capacity-ladder-b-r5",
	"g6-capacity-ladder-b-r5-probe-off",
]);

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
	const armsKinds = plan.nodes.filter(
		(node) => node.kind === "hotspot" || node.kind === "storm",
	);
	if ((SHARDED_ARMS_PLAN_IDS as readonly string[]).includes(plan.id)) {
		if (armsKinds.length !== plan.nodes.length)
			fail("sharded-arms plans contain only hotspot and storm cells");
		exact(result, ["candidate"]);
		const expected = makeShardedArmsWorkProfiles(
			requireDefined(result.candidate),
		);
		if (
			[...R5_KEYS, "clientProcesses"].some(
				(key) =>
					requireDefined(result.candidate)[key as keyof WorkProfile] !==
					requireDefined(expected.candidate)[key as keyof WorkProfile],
			)
		)
			fail("sharded-arms profile differs from the closed 40k deployment");
		return result;
	}
	if (armsKinds.length > 0)
		fail("hotspot and storm cells run only in a sharded-arms plan");
	if ((SNDBUF_AB_PLAN_IDS as readonly string[]).includes(plan.id)) {
		if (plan.nodes.some((node) => node.kind !== "attribution-r4"))
			fail("send-buffer A/B plans contain only attribution-r4 cells");
		exact(result, ["D", "S"]);
		const probe = plan.id.endsWith("-probe");
		const D = requireDefined(result.D);
		if (D.detailedProbe !== probe)
			fail("send-buffer A/B probe setting differs from the plan");
		const expected = makeSendBufferWorkProfiles(
			profile({ ...D, detailedProbe: false }),
			probe,
		);
		for (const name of ["D", "S"])
			if (
				[...R5_KEYS, "clientProcesses"].some(
					(key) =>
						requireDefined(result[name])[key as keyof WorkProfile] !==
						requireDefined(expected[name])[key as keyof WorkProfile],
				)
			)
				fail("send-buffer A/B arms differ beyond the send buffer");
		return result;
	}
	if (plan.nodes.some((node) => node.kind === "attribution-r4")) {
		if (plan.nodes.some((node) => node.kind !== "attribution-r4"))
			fail("attribution-r4 plans contain only attribution-r4 cells");
		const base = result.Xoff ?? fail("attribution-r4 lacks the Xoff profile");
		// A' attribution arms always ran one generator process.
		if (Object.values(result).some((p) => p.clientProcesses !== undefined))
			fail("attribution-r4 profiles never carry clientProcesses");
		const expected = makeCandidateAttributionWorkProfiles(base);
		exact(result, Object.keys(expected));
		for (const name of Object.keys(expected))
			if (
				R5_KEYS.some(
					(key) =>
						requireDefined(result[name])[key as keyof WorkProfile] !==
						requireDefined(expected[name])[key as keyof WorkProfile],
				)
			)
				fail("attribution-r4 common knobs or arm bindings differ");
		return result;
	}
	if (R5_LADDER_IDS.has(plan.id)) {
		const candidate =
			result.candidate ?? fail("r5 ladder lacks the candidate profile");
		exact(result, ["candidate"]);
		const probeOff = plan.id.endsWith("-probe-off");
		if (
			candidate.datagramPump !== "pump" ||
			candidate.reflectRingBypass !== "off" ||
			candidate.detailedProbe === probeOff
		)
			fail("r5 ladder profile differs from a source-encoded variant");
		return result;
	}
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
