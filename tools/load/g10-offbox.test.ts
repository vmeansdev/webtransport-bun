import { describe, expect, test } from "bun:test";
import {
	assertCandidate,
	offboxDeadlineSeconds,
	offboxInvocation,
	parseMacgenLine,
	subscriberArgs,
} from "./g10-offbox.ts";

const SUBSCRIBER = {
	url: "https://10.99.0.2:4433",
	sessions: 10_000,
	probeCohort: 100,
	probeHz: 2,
	payloadBytes: 200,
	rate: 5,
	seconds: 120,
};

const SHA = "6cfb5cafb0dc37d0966bc8ec9aae13f9ec33fb42";

describe("the subscriber role's own flags", () => {
	test("are exactly the ones broadcast_client.rs parses", () => {
		expect(subscriberArgs(SUBSCRIBER)).toEqual([
			"--url",
			"https://10.99.0.2:4433",
			"--sessions",
			"10000",
			"--probe-cohort",
			"100",
			"--probe-hz",
			"2",
			"--payload-bytes",
			"200",
			"--rate",
			"5",
			"--seconds",
			"120",
		]);
	});
});

describe("the entry script's refusals, mirrored before the spawn", () => {
	test("a missing candidate is refused here, not over ssh", () => {
		expect(() => assertCandidate("")).toThrow(/G10_CANDIDATE is required/);
	});

	test("a branch name is refused: SHAs come from git rev-parse", () => {
		expect(() => assertCandidate("probe/g10-broadcast-01")).toThrow(
			/40-character lowercase sha/,
		);
	});

	test("an abbreviation is refused, and so is upper case", () => {
		expect(() => assertCandidate(SHA.slice(0, 12))).toThrow(/40-character/);
		expect(() => assertCandidate(SHA.toUpperCase())).toThrow(/40-character/);
	});

	test("a full lowercase sha passes through unchanged", () => {
		expect(assertCandidate(SHA)).toBe(SHA);
	});
});

describe("the ssh invocation", () => {
	test("carries every flag the contract requires, in a shape it parses", () => {
		const { cmd, args } = offboxInvocation({
			ssh: "vmeansdev@10.99.0.1",
			candidate: SHA,
			deadlineSeconds: 645,
			localBin: "/tmp/broadcast-client",
			subscriber: SUBSCRIBER,
		});
		expect(cmd).toBe("ssh");
		expect(args.slice(0, 3)).toEqual([
			"-o",
			"BatchMode=yes",
			"vmeansdev@10.99.0.1",
		]);
		expect(args[3]).toBe("tools/offbox/mac-generator-entry.sh");
		// The script requires `--candidate` and refuses without it (exit 3), and
		// `--deadline` is the watchdog macOS has no `timeout(1)` for.
		expect(args).toContain("--candidate");
		expect(args[args.indexOf("--candidate") + 1]).toBe(SHA);
		expect(args).toContain("--deadline");
		expect(args[args.indexOf("--deadline") + 1]).toBe("645");
		// Everything after `--` is the client's own argv, verbatim.
		const dash = args.indexOf("--");
		expect(dash).toBeGreaterThan(0);
		expect(args.slice(dash + 1)).toEqual(subscriberArgs(SUBSCRIBER));
	});

	/**
	 * G10's far end is `broadcast-client`, not the datagram source, and the
	 * entry script now takes `--bin` as a closed set. The end-to-end check that
	 * the script's parser accepts this exact argv lives in
	 * `tools/offbox/mac-generator-entry.test.ts`.
	 */
	test("names the binary it needs, before the -- so the entry script owns it", () => {
		const { args } = offboxInvocation({
			ssh: "mac",
			candidate: SHA,
			deadlineSeconds: 100,
			localBin: "bin",
			subscriber: SUBSCRIBER,
		});
		expect(args).toContain("--bin");
		expect(args[args.indexOf("--bin") + 1]).toBe("broadcast-client");
		// Before the `--`: it is the entry script's flag, not the client's.
		expect(args.indexOf("--bin")).toBeLessThan(args.indexOf("--"));
	});

	test("an empty ssh destination runs the local binary — a wiring check", () => {
		const { cmd, args } = offboxInvocation({
			ssh: "",
			candidate: "",
			deadlineSeconds: 100,
			localBin: "/tmp/broadcast-client",
			subscriber: SUBSCRIBER,
		});
		expect(cmd).toBe("/tmp/broadcast-client");
		expect(args).toEqual(subscriberArgs(SUBSCRIBER));
	});
});

describe("the watchdog deadline", () => {
	test("covers the establish ramp, the window and the drain with margin", () => {
		const deadline = offboxDeadlineSeconds(120, 300, 10);
		expect(deadline).toBeGreaterThan(120 + 300 + 10);
		expect(deadline).toBe(645);
	});

	/**
	 * A watchdog that fires mid-window destroys the rung and surfaces as exit 4,
	 * which the rerun policy reads as an infra fault rather than a result.
	 */
	test("is never shorter than the work it is supposed to bound", () => {
		for (const window of [8, 60, 120, 300]) {
			expect(offboxDeadlineSeconds(window, 300)).toBeGreaterThan(window + 300);
		}
	});
});

describe("provenance", () => {
	test("macgen lines fold into fields the artifact can carry", () => {
		expect(
			parseMacgenLine("macgen: head=abc dirty=no build=ok buildSec=41"),
		).toEqual({ head: "abc", dirty: "no", build: "ok", buildSec: "41" });
		expect(
			parseMacgenLine("broadcast-client: established 1000/10000"),
		).toBeNull();
		expect(parseMacgenLine("macgen: plan cargo build")).toBeNull();
	});
});
