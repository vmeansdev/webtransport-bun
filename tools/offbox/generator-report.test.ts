import { describe, expect, test } from "bun:test";
import { LatencyHistogram } from "../load/latency-histogram.ts";
import { G6_CLOSEOUT_SPEC_ID, G6_CLOSEOUT_SPEC_PATH } from "../load/g6-plan.ts";
import {
	floorReportIsUsable,
	parseGeneratorReport,
} from "./generator-report.ts";

const SHA = "b4af780ad39012345678901234567890abcdef01";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
const HASH = "a".repeat(64);

function provenance(overrides: Partial<Record<string, string>> = {}): string[] {
	return [
		overrides.host ?? "macgen: host=mac-studio arch=arm64 os=Darwin/25.4.0",
		overrides.clone ??
			`macgen: clone=/Users/x/wt-macgen candidate=${SHA} deadline=120s`,
		overrides.head ?? `macgen: head=${SHA} dirty=no build=ok buildSec=41`,
		overrides.binary ??
			`macgen: binary=/Users/x/wt-macgen/target/release/load-client sha256=${HASH}`,
		overrides.rustc ?? "macgen: rustc=1.95.0 argv=--url https://10.99.0.2:4433",
	];
}

function clientRun(): string[] {
	return [
		"load-client: arrival=uniform tick_hz=64 latency_stamp=true",
		"load-client: sessions ok=100 err=0",
		"load-client: datagrams sent=299104 err=0",
		"load-client: datagrams received=298940 bytes tx=1 rx=1",
		`load-client: latency-json ${JSON.stringify({
			arrival: "uniform",
			effectiveDatagramsPerSecPerSession: 150,
			rtt: { version: 2, count: 298940 },
			scheduleLag: { version: 2, count: 299104 },
			driveWindowSec: 20.01,
			sessionsDriving: 100,
		})}`,
		"load-client: PASS",
	];
}

type MmoOverrides = {
	schema?: "mmo-client/1" | "mmo-client/2";
	role?: string;
	startedAt?: string;
	preRegistration?: Partial<{
		id: string;
		path: string;
		sha256: string;
	}>;
	sessionsRequested?: number;
	sessionsOk?: number;
	sessionsErr?: number;
	window?: Partial<{
		sent: number;
		sendErr: number;
		rxSnapshot: number;
		rxAck: number;
		rxRaid: number;
		rxOther: number;
		rxUnstamped: number;
	}>;
	scheduleLagCount?: number;
	scheduleLagReconciled?: boolean;
	scheduleLagJson?: unknown;
	config?: Partial<{ steadySec: number }>;
};

function scheduleLagJson(count: number) {
	const histogram = new LatencyHistogram();
	for (let i = 0; i < count; i += 1) {
		histogram.record(1_000_000 + (i % 5) * 100_000);
	}
	return histogram.toJson();
}

function mmoRun(overrides: MmoOverrides = {}): string[] {
	const schema = overrides.schema ?? "mmo-client/1";
	const sent = overrides.window?.sent ?? 1440;
	const sendErr = overrides.window?.sendErr ?? 3;
	const rxSnapshot = overrides.window?.rxSnapshot ?? 1400;
	const rxAck = overrides.window?.rxAck ?? 20;
	const rxRaid = overrides.window?.rxRaid ?? 15;
	const rxOther = overrides.window?.rxOther ?? 5;
	const rxUnstamped = overrides.window?.rxUnstamped ?? 1;
	const scheduleLag =
		overrides.scheduleLagJson ??
		scheduleLagJson(overrides.scheduleLagCount ?? sent);

	if (schema === "mmo-client/2") {
		return [
			`mmo-client: json ${JSON.stringify({
				schema,
				role: overrides.role ?? "realm",
				startedAt: overrides.startedAt ?? "2026-08-24T08:00:00Z",
				preRegistration: {
					id: overrides.preRegistration?.id ?? G6_CLOSEOUT_SPEC_ID,
					path: overrides.preRegistration?.path ?? G6_CLOSEOUT_SPEC_PATH,
					sha256: overrides.preRegistration?.sha256 ?? HASH,
				},
				sessionsRequested: overrides.sessionsRequested ?? 20,
				sessionsOk: overrides.sessionsOk ?? 18,
				sessionsErr: overrides.sessionsErr ?? 2,
				windows: {
					steady: {
						sent,
						sendErr,
						scheduleTicksDue: sent + sendErr,
						scheduleTicksFired: sent,
						scheduleTicksSkipped: sendErr,
						scheduleTicksUnpresented: 0,
						scheduleTicksReconciled: overrides.scheduleLagReconciled ?? true,
						scheduleLag,
					},
					steadyDrain: {
						rxSnapshot,
						rxAck,
						rxRaid,
						rxOther,
						rxUnstamped,
					},
				},
				config: {
					steadySec: overrides.config?.steadySec ?? 12,
				},
			})}`,
			"mmo-client: PASS",
		];
	}

	return [
		`mmo-client: json ${JSON.stringify({
			schema,
			role: overrides.role ?? "realm",
			sessionsRequested: overrides.sessionsRequested ?? 20,
			sessionsOk: overrides.sessionsOk ?? 18,
			sessionsErr: overrides.sessionsErr ?? 2,
			realm: {
				sent,
				sendErr,
				rxSnapshot,
				rxAck,
				rxRaid,
				rxOther,
				rxUnstamped,
			},
			scheduleLag,
			config: {
				steadySec: overrides.config?.steadySec ?? 12,
			},
		})}`,
		"mmo-client: PASS",
	];
}

function transcript(extra: string[] = [], overrides = {}): string {
	return [
		...provenance(overrides),
		...clientRun(),
		...extra,
		"macgen: exit=0",
	].join("\n");
}

describe("provenance", () => {
	test("a clean run reports the host, tree and binary it came from", () => {
		const report = parseGeneratorReport(transcript(), SHA);
		expect(report.problems).toEqual([]);
		expect(report.provenance.host).toBe("mac-studio");
		expect(report.provenance.arch).toBe("arm64");
		expect(report.provenance.head).toBe(SHA);
		expect(report.provenance.dirty).toBe(false);
		expect(report.provenance.binarySha256).toBe(HASH);
		expect(report.provenance.buildSeconds).toBe(41);
		expect(report.provenance.exitCode).toBe(0);
	});

	test("counters and the drive window come back intact", () => {
		const report = parseGeneratorReport(transcript(), SHA);
		expect(report.sessionsOk).toBe(100);
		expect(report.sessionsErr).toBe(0);
		expect(report.datagramsSent).toBe(299104);
		expect(report.datagramsErr).toBe(0);
		expect(report.datagramsReceived).toBe(298940);
		expect(report.driveWindowSec).toBe(20.01);
		expect(report.sessionsDriving).toBe(100);
	});

	test("the histogram blob is handed on untouched, never re-derived here", () => {
		const report = parseGeneratorReport(transcript(), SHA);
		const json = report.latencyJson as { scheduleLag: { count: number } };
		expect(json.scheduleLag.count).toBe(299104);
	});

	test("a generator on another tree cannot be stamped as the candidate", () => {
		const report = parseGeneratorReport(transcript(), OTHER);
		expect(report.problems.join(" ")).toContain(`generator ran ${SHA}`);
	});

	test("a dirty clone is called out — the binary matches no SHA", () => {
		const dirty = transcript([], {
			head: `macgen: head=${SHA} dirty=yes build=ok buildSec=41`,
		});
		const report = parseGeneratorReport(dirty, SHA);
		expect(report.provenance.dirty).toBe(true);
		expect(report.problems.join(" ")).toContain("dirty clone");
	});

	test("a watchdog kill is an incomplete run, not a result", () => {
		const killed = [
			...provenance(),
			...clientRun(),
			"macgen: exit=watchdog deadline=120s",
		].join("\n");
		const report = parseGeneratorReport(killed, SHA);
		expect(report.provenance.watchdogFired).toBe(true);
		expect(report.problems.join(" ")).toContain("watchdog");
	});

	test("a nonzero exit is surfaced with its code", () => {
		const failed = [...provenance(), ...clientRun(), "macgen: exit=101"].join(
			"\n",
		);
		expect(parseGeneratorReport(failed, SHA).problems.join(" ")).toContain(
			"exited 101",
		);
	});

	test("stdout with no macgen header means the entrypoint never ran", () => {
		const report = parseGeneratorReport(clientRun().join("\n"), SHA);
		expect(report.problems.join(" ")).toContain("did not run");
		expect(report.sessionsOk).toBe(100);
	});

	test("a run with no latency-json has no floor and says so", () => {
		const noJson = [
			...provenance(),
			"load-client: sessions ok=100 err=0",
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(noJson, SHA);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("no latency-json");
	});

	test("malformed latency-json is reported rather than swallowed", () => {
		const bad = [
			...provenance(),
			"load-client: latency-json {not json}",
			"macgen: exit=0",
		].join("\n");
		expect(parseGeneratorReport(bad, SHA).problems.join(" ")).toContain(
			"did not parse",
		);
	});

	test("an mmo-client/1 envelope stays readable but is marked historical-only", () => {
		const mmo = [...provenance(), ...mmoRun(), "macgen: exit=0"].join("\n");
		const report = parseGeneratorReport(mmo, SHA);
		const json = report.latencyJson as {
			scheduleLag: { count: number; buckets: [number, number][] };
		};
		expect(report.schema).toBe("mmo-client/1");
		expect(report.historicalOnly).toBe(true);
		expect(report.sessionsOk).toBe(18);
		expect(report.sessionsErr).toBe(2);
		expect(report.datagramsSent).toBe(1440);
		expect(report.datagramsErr).toBe(3);
		expect(report.datagramsReceived).toBe(1441);
		expect(report.driveWindowSec).toBe(12);
		expect(report.sessionsDriving).toBe(18);
		expect(json.scheduleLag.count).toBe(1440);
		expect(json.scheduleLag.buckets.length).toBeGreaterThan(0);
		const verdict = floorReportIsUsable(report, "mac-studio");
		expect(verdict.usable).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("historical");
	});

	test("an mmo-client/2 envelope is accepted with prereg identity and startedAt", () => {
		const startedAt = "2026-08-24T08:12:13Z";
		const mmo = [
			...provenance(),
			...mmoRun({
				schema: "mmo-client/2",
				startedAt,
			}),
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(mmo, SHA, HASH);
		const json = report.latencyJson as {
			windows: { steady: { scheduleLag: { count: number } } };
		};
		expect(report.problems).toEqual([]);
		expect(report.schema).toBe("mmo-client/2");
		expect(report.historicalOnly).toBe(false);
		expect(report.startedAt).toBe(startedAt);
		expect(report.preRegistration).toEqual({
			id: G6_CLOSEOUT_SPEC_ID,
			path: G6_CLOSEOUT_SPEC_PATH,
			sha256: HASH,
		});
		expect(report.datagramsSent).toBe(1440);
		expect(report.datagramsErr).toBe(3);
		expect(report.datagramsReceived).toBe(1441);
		expect(report.driveWindowSec).toBe(12);
		expect(report.sessionsDriving).toBe(18);
		expect(json.windows.steady.scheduleLag.count).toBe(1440);
		expect(floorReportIsUsable(report, "mac-studio", HASH)).toEqual({
			usable: true,
			reasons: [],
		});
	});

	test("an unrelated mmo-client json blob is rejected rather than treated as a floor", () => {
		const wrongSchema = [
			...provenance(),
			`mmo-client: json ${JSON.stringify({
				schema: "other-client/1",
				scheduleLag: { version: 2, count: 1 },
				sessionsRequested: 1,
				sessionsOk: 1,
				sessionsErr: 0,
				realm: {
					sent: 1,
					sendErr: 0,
					rxSnapshot: 0,
					rxAck: 0,
					rxRaid: 0,
					rxOther: 0,
					rxUnstamped: 0,
				},
				config: { steadySec: 1 },
			})}`,
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(wrongSchema, SHA);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("mmo-client/1");
	});

	test("an mmo-client floor report must come from the realm role", () => {
		const publisher = [
			...provenance(),
			...mmoRun({ schema: "mmo-client/2", role: "publisher" }),
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(publisher, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("role must be realm");
	});

	test("any other non-realm mmo-client role is refused as a floor source", () => {
		const subscriber = [
			...provenance(),
			...mmoRun({ schema: "mmo-client/2", role: "subscriber" }),
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(subscriber, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("role must be realm");
	});

	test("a transcript with both legacy and mmo floor blobs fails closed as ambiguous", () => {
		const mixed = [
			...provenance(),
			"load-client: latency-json {not json}",
			...mmoRun({ schema: "mmo-client/2" }),
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(mixed, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("ambiguous");
		expect(report.problems.join(" ")).toContain("did not parse");
	});

	test("a truncated mmo scheduleLag histogram is rejected before downstream decoding", () => {
		const truncated = [
			...provenance(),
			...mmoRun({
				schema: "mmo-client/2",
				scheduleLagJson: { version: 2, count: 1440 },
			}),
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(truncated, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("scheduleLag");
		const verdict = floorReportIsUsable(report, "mac-studio", HASH);
		expect(verdict.usable).toBe(false);
	});

	test("an mmo-client/2 preregistration sha mismatch is rejected", () => {
		const mismatch = [
			...provenance(),
			...mmoRun({
				schema: "mmo-client/2",
				preRegistration: { sha256: "b".repeat(64) },
			}),
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(mismatch, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("preregistration sha256");
		expect(report.problems.join(" ")).toContain(HASH);
	});

	test("an mmo-client/2 report with scheduleLag count not matching steady fired is rejected", () => {
		const mismatch = [
			...provenance(),
			...mmoRun({
				schema: "mmo-client/2",
				scheduleLagCount: 1439,
			}),
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(mismatch, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("scheduleLag count");
		expect(report.problems.join(" ")).toContain("scheduleTicksFired");
	});

	test("an mmo-client/2 report with unreconciled steady ticks is rejected", () => {
		const mismatch = [
			...provenance(),
			...mmoRun({
				schema: "mmo-client/2",
				scheduleLagReconciled: false,
			}),
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(mismatch, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("scheduleTicksReconciled");
	});

	test("a v2 ledger that does not balance is rejected even when the boolean claims reconciliation", () => {
		const tampered = tamperSteadyWindow(
			[
				...provenance(),
				...mmoRun({ schema: "mmo-client/2" }),
				"macgen: exit=0",
			],
			(steady) => {
				steady.scheduleTicksDue = (steady.scheduleTicksDue as number) + 1;
				steady.scheduleTicksReconciled = true;
			},
		);
		const report = parseGeneratorReport(tampered, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain(
			"schedule ledger did not reconcile from raw counters",
		);
	});

	test("an mmo-client/2 report without the unpresented counter is rejected", () => {
		const missing = tamperSteadyWindow(
			[
				...provenance(),
				...mmoRun({ schema: "mmo-client/2" }),
				"macgen: exit=0",
			],
			(steady) => {
				delete steady.scheduleTicksUnpresented;
			},
		);
		const report = parseGeneratorReport(missing, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("mmo-client/2 floor shape");
	});
});

function tamperSteadyWindow(
	lines: string[],
	mutate: (steady: Record<string, unknown>) => void,
): string {
	return lines
		.map((line) => {
			if (!line.startsWith("mmo-client: json ")) return line;
			const value = JSON.parse(line.slice("mmo-client: json ".length));
			mutate(value.windows.steady);
			return `mmo-client: json ${JSON.stringify(value)}`;
		})
		.join("\n");
}

describe("the off-box floor", () => {
	test("a floor from the generator host is usable", () => {
		const report = parseGeneratorReport(transcript(), SHA);
		expect(floorReportIsUsable(report, "mac-studio")).toEqual({
			usable: true,
			reasons: [],
		});
	});

	test("a floor measured on any other host is refused — that is the whole point", () => {
		const report = parseGeneratorReport(transcript(), SHA);
		const verdict = floorReportIsUsable(report, "runner-vm");
		expect(verdict.usable).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("floor came from mac-studio");
	});

	test("a floor over zero driving sessions is not a floor", () => {
		const idle = [
			...provenance(),
			`load-client: latency-json ${JSON.stringify({ sessionsDriving: 0, driveWindowSec: 0 })}`,
			"macgen: exit=0",
		].join("\n");
		const verdict = floorReportIsUsable(
			parseGeneratorReport(idle, SHA),
			"mac-studio",
		);
		expect(verdict.usable).toBe(false);
		expect(verdict.reasons.join(" ")).toContain("not a floor");
	});

	test("a v2 floor with zero scheduleLag samples but nonzero steady fired is rejected before floor use", () => {
		const idleMmo = [
			...provenance(),
			...mmoRun({
				schema: "mmo-client/2",
				sessionsRequested: 20,
				sessionsOk: 18,
				scheduleLagCount: 0,
			}),
			"macgen: exit=0",
		].join("\n");
		const report = parseGeneratorReport(idleMmo, SHA, HASH);
		expect(report.latencyJson).toBeNull();
		expect(report.problems.join(" ")).toContain("scheduleLag count");
	});
});
