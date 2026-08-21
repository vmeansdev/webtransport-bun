import { describe, expect, test } from "bun:test";
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

/** A trimmed but structurally real load-client run, as it arrives over ssh. */
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
		// The client half still parses: a local run is readable by the same code.
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
});

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
});
