import { describe, expect, test } from "bun:test";
import { parseSourceBound } from "./g6-source-bound.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);
const SHA_E = "e".repeat(64);

const REGISTRATION = {
	registrationPath: "/home/runner/inputs/registration.md",
	registrationSha256: SHA_A,
	expectedRunnerHost: "gravvene-dev-home",
	expectedGeneratorHost: "Nikitas-MacBook-Pro",
};

const QUARTET = {
	preflightDownPath: "/home/runner/inputs/preflight-down.json",
	preflightDownSha256: SHA_B,
	preflightUpPath: "/home/runner/inputs/preflight-up.json",
	preflightUpSha256: SHA_C,
	floorPath: "/home/runner/inputs/floor.log",
	floorSha256: SHA_D,
	sinkPath: "/home/runner/inputs/sink.json",
	sinkSha256: SHA_E,
};

describe("g6-source-bound", () => {
	test("emits one env line per field for a full g6-mmo blob, in rule order", () => {
		const { lines } = parseSourceBound(
			JSON.stringify({ ...REGISTRATION, ...QUARTET }),
			"g6-mmo",
		);
		expect(lines).toEqual([
			`G6_REGISTRATION_PATH=${REGISTRATION.registrationPath}`,
			`G6_REGISTRATION_SHA256=${SHA_A}`,
			`G6_EXPECTED_RUNNER_HOST=${REGISTRATION.expectedRunnerHost}`,
			`G6_EXPECTED_GENERATOR_HOST=${REGISTRATION.expectedGeneratorHost}`,
			`G6_PREFLIGHT_DOWN_PATH=${QUARTET.preflightDownPath}`,
			`G6_PREFLIGHT_DOWN_SHA256=${SHA_B}`,
			`G6_PREFLIGHT_UP_PATH=${QUARTET.preflightUpPath}`,
			`G6_PREFLIGHT_UP_SHA256=${SHA_C}`,
			`G6_FLOOR_PATH=${QUARTET.floorPath}`,
			`G6_FLOOR_SHA256=${SHA_D}`,
			`G6_SINK_PATH=${QUARTET.sinkPath}`,
			`G6_SINK_SHA256=${SHA_E}`,
		]);
	});

	test("attribution requires only registration identity and emits no quartet lines", () => {
		const { lines } = parseSourceBound(
			JSON.stringify(REGISTRATION),
			"g6-attribution",
		);
		expect(lines).toHaveLength(4);
		expect(lines.join("\n")).not.toContain("PREFLIGHT");
	});

	test("ack-reflector-gate binds registration identity only, like attribution", () => {
		const { lines } = parseSourceBound(
			JSON.stringify(REGISTRATION),
			"ack-reflector-gate",
		);
		expect(lines).toHaveLength(4);
		expect(lines.join("\n")).not.toContain("PREFLIGHT");
		expect(() =>
			parseSourceBound(
				JSON.stringify({ ...REGISTRATION, floorPath: QUARTET.floorPath }),
				"ack-reflector-gate",
			),
		).toThrow("unexpected field 'floorPath'");
	});

	test("attribution refuses quartet fields outright", () => {
		expect(() =>
			parseSourceBound(
				JSON.stringify({ ...REGISTRATION, floorPath: QUARTET.floorPath }),
				"g6-attribution",
			),
		).toThrow("unexpected field 'floorPath'");
	});

	test("g6-mmo refuses when any quartet field is missing", () => {
		const { sinkSha256: _dropped, ...partial } = {
			...REGISTRATION,
			...QUARTET,
		};
		expect(() => parseSourceBound(JSON.stringify(partial), "g6-mmo")).toThrow(
			"'sinkSha256' is required",
		);
	});

	test("refuses unknown fields, malformed hashes, and relative paths", () => {
		expect(() =>
			parseSourceBound(
				JSON.stringify({ ...REGISTRATION, extra: "x" }),
				"g6-attribution",
			),
		).toThrow("unexpected field 'extra'");
		expect(() =>
			parseSourceBound(
				JSON.stringify({ ...REGISTRATION, registrationSha256: "ABC" }),
				"g6-attribution",
			),
		).toThrow("lowercase 64-hex");
		expect(() =>
			parseSourceBound(
				JSON.stringify({ ...REGISTRATION, registrationPath: "inputs/reg.md" }),
				"g6-attribution",
			),
		).toThrow("absolute path");
	});

	// The workflow captures this tool's stdout and appends it to GITHUB_ENV.
	// A value carrying a shell metacharacter or whitespace must be refused
	// before any line is emitted — otherwise a crafted host/path could inject
	// shell state or forge an env stamp. (Regression for the eval-sink defect.)
	test("refuses shell metacharacters and whitespace in hosts and paths", () => {
		const hostAttacks = [
			"host;touch /tmp/x",
			"host`id`",
			"host$(id)",
			"host|cat",
			"host&whoami",
			"host with space",
			"host\ttab",
			"host>redirect",
			'host"quote',
		];
		for (const expectedGeneratorHost of hostAttacks) {
			expect(() =>
				parseSourceBound(
					JSON.stringify({ ...REGISTRATION, expectedGeneratorHost }),
					"g6-attribution",
				),
			).toThrow("no shell metacharacters");
		}
		const pathAttacks = [
			"/home/runner;rm -rf x",
			"/home/runner/$(id)",
			"/home/run ner/reg.md",
			"/home/runner/`id`",
		];
		for (const registrationPath of pathAttacks) {
			expect(() =>
				parseSourceBound(
					JSON.stringify({ ...REGISTRATION, registrationPath }),
					"g6-attribution",
				),
			).toThrow("no shell metacharacters");
		}
	});

	test("refuses non-JSON, non-object JSON, and unsupported modes", () => {
		expect(() => parseSourceBound("not json", "g6-mmo")).toThrow(
			"not valid JSON",
		);
		expect(() => parseSourceBound("[]", "g6-mmo")).toThrow(
			"must be a JSON object",
		);
		expect(() =>
			parseSourceBound(JSON.stringify(REGISTRATION), "bandwidth"),
		).toThrow("unsupported mode");
	});
});
