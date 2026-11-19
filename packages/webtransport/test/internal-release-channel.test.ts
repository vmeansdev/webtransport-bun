/**
 * Canary and nightly channel versions (scripts/release-channel.ts).
 */
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { channelOf, channelVersion } from "../../../scripts/release-channel.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const DATE = new Date("2026-11-20T02:30:00Z");
const SCRIPT = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"scripts",
	"release-channel.ts",
);

const valid = {
	base: "1.0.0",
	channel: "canary",
	commit: SHA,
	commitCount: 1412,
	date: DATE,
} as const;

describe("channelVersion", () => {
	it("orders canaries by commit count and nightlies by UTC date", () => {
		expect(channelVersion(valid)).toBe("1.0.0-canary.1412.g0123456");
		expect(channelVersion({ ...valid, channel: "nightly" })).toBe(
			"1.0.0-nightly.20261120.g0123456",
		);
	});

	it("sorts a later canary above an earlier one under semver", () => {
		const earlier = channelVersion({ ...valid, commitCount: 999 });
		const later = channelVersion({ ...valid, commitCount: 1000 });
		expect(Bun.semver.order(earlier, later)).toBe(-1);
		expect(Bun.semver.order(later, "1.0.0")).toBe(-1);
	});

	it("keeps an all-digit sha prefix a valid identifier", () => {
		const version = channelVersion({
			...valid,
			commit: "0123456000000000000000000000000000000000",
		});
		expect(version).toBe("1.0.0-canary.1412.g0123456");
		expect(Bun.semver.satisfies(version, version)).toBe(true);
	});

	it("refuses a pre-release base, a short sha and a bad count", () => {
		expect(() => channelVersion({ ...valid, base: "1.0.0-rc.1" })).toThrow(
			/base version/,
		);
		expect(() => channelVersion({ ...valid, commit: "0123456" })).toThrow(
			/40-character/,
		);
		expect(() => channelVersion({ ...valid, commitCount: 0 })).toThrow(
			/positive integer/,
		);
		expect(() =>
			channelVersion({ ...valid, channel: "latest" as never }),
		).toThrow(/unknown channel/);
	});
});

describe("channelOf", () => {
	it("recognizes only channel-stamped versions", () => {
		expect(channelOf("1.0.0-canary.1412.g0123456")).toBe("canary");
		expect(channelOf("1.0.0-nightly.20261120.g0123456")).toBe("nightly");
		expect(channelOf("1.0.0")).toBeUndefined();
		expect(channelOf("1.0.0-rc.6")).toBeUndefined();
		expect(channelOf("1.0.0-canary.1412")).toBeUndefined();
	});
});

describe("release-channel CLI", () => {
	it("prints a version for HEAD without touching package.json", () => {
		const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
			stdout: "pipe",
		})
			.stdout.toString()
			.trim();
		const result = Bun.spawnSync(["bun", SCRIPT, "version", "canary", head], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(channelOf(result.stdout.toString().trim())).toBe("canary");
	});

	it("refuses an unknown channel with a usage error", () => {
		const result = Bun.spawnSync(["bun", SCRIPT, "version", "latest", SHA], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("usage:");
	});
});
