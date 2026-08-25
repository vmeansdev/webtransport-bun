/**
 * The refusals that stand between "G2 ran" and "G2 ran against the candidate".
 *
 * Every one of these mirrors a refusal in `mac-generator-entry.sh`, and the
 * point of mirroring them is that a mistake becomes a sentence about the
 * candidate SHA on the runner rather than exit status 3 inside an ssh channel
 * twenty-two cells into a dispatch.
 */

import { describe, expect, test } from "bun:test";
import {
	assertCableHost,
	assertCandidate,
	assertMacgenBin,
	G2_MACGEN_BIN,
	MACGEN_ENTRY,
	macgenDeadlineSeconds,
	macgenInvocation,
	parseMacgenLine,
} from "./g2-offbox.ts";

const SHA = "0fbe9cb0000000000000000000000000000000ab";

describe("assertCandidate", () => {
	test("refuses an empty candidate", () => {
		expect(() => assertCandidate("")).toThrow("requires a candidate SHA");
	});

	test("refuses a branch name where a SHA belongs", () => {
		expect(() => assertCandidate("rebind4-staging")).toThrow("40-character");
	});

	test("refuses an abbreviated SHA", () => {
		expect(() => assertCandidate("0fbe9cb")).toThrow("40-character");
	});

	test("refuses uppercase hex, which the script's case test also refuses", () => {
		expect(() => assertCandidate(SHA.toUpperCase())).toThrow("40-character");
	});

	test("accepts a full lowercase object name", () => {
		expect(assertCandidate(SHA)).toBe(SHA);
	});
});

describe("assertCableHost", () => {
	test("names the family LAN specifically — it is the VM era's address family", () => {
		expect(() => assertCableHost("192.168.2.36", "URL_HOST")).toThrow(
			"family LAN",
		);
	});

	test("refuses a Tailscale address", () => {
		expect(() => assertCableHost("100.64.1.5", "URL_HOST")).toThrow(
			"10.99.0.0/24",
		);
	});

	test("refuses a hostname, which would resolve over whatever route exists", () => {
		expect(() => assertCableHost("home-ubuntu", "URL_HOST")).toThrow(
			"never a hostname",
		);
	});

	test("refuses loopback: an off-box cell that dials 127.0.0.1 is on-box", () => {
		expect(() => assertCableHost("127.0.0.1", "URL_HOST")).toThrow(
			"10.99.0.0/24",
		);
	});

	test("accepts the box's cable address", () => {
		expect(assertCableHost("10.99.0.2", "URL_HOST")).toBe("10.99.0.2");
	});
});

describe("assertMacgenBin", () => {
	test("refuses a binary outside the entry script's closed set", () => {
		expect(() => assertMacgenBin("latency-probe")).toThrow("--bin must be one");
	});

	test("G2's generator is load-client", () => {
		expect(assertMacgenBin(G2_MACGEN_BIN)).toBe("load-client");
	});
});

describe("macgenDeadlineSeconds", () => {
	test("covers drive, connect ramp and exit grace with margin", () => {
		// 20 s drive + 45 s ramp + 10 s grace = 75 s, ×1.5 = 113 s.
		expect(macgenDeadlineSeconds(20, 45)).toBe(113);
	});

	test("grows with the drive window rather than being a constant", () => {
		expect(macgenDeadlineSeconds(40, 45)).toBeGreaterThan(
			macgenDeadlineSeconds(20, 45),
		);
	});
});

describe("macgenInvocation", () => {
	const clientArgs = ["--url", "https://10.99.0.2:4500", "--sessions", "100"];

	test("names no remote binary path — the Mac builds at the candidate", () => {
		const { args } = macgenInvocation({
			ssh: "vmeansdev@10.99.0.1",
			candidate: SHA,
			deadlineSeconds: 113,
			localBin: "/repo/target/release/load-client",
			clientArgs,
		});
		// The retired VM path passed `/tmp/load-client`, and a stale binary there
		// answers happily from a tree no SHA describes.
		expect(args.join(" ")).not.toContain("/tmp/");
		expect(args.join(" ")).not.toContain("/repo/target/release");
		expect(args).toContain("--candidate");
		expect(args).toContain(SHA);
	});

	test("passes --bin and --candidate explicitly, in that order, before --", () => {
		const { cmd, args } = macgenInvocation({
			ssh: "vmeansdev@10.99.0.1",
			candidate: SHA,
			deadlineSeconds: 113,
			localBin: "",
			clientArgs,
		});
		expect(cmd).toBe("ssh");
		const sep = args.indexOf("--");
		expect(args.indexOf("--bin")).toBeLessThan(sep);
		expect(args.indexOf("--candidate")).toBeLessThan(sep);
		expect(args.indexOf(MACGEN_ENTRY)).toBeLessThan(args.indexOf("--bin"));
		expect(args.slice(sep + 1)).toEqual(clientArgs);
	});

	test("carries a deadline, because macOS has no timeout(1)", () => {
		const { args } = macgenInvocation({
			ssh: "vmeansdev@10.99.0.1",
			candidate: SHA,
			deadlineSeconds: 113,
			localBin: "",
			clientArgs,
		});
		expect(args).not.toContain("timeout");
		expect(args[args.indexOf("--deadline") + 1]).toBe("113");
	});

	test("an empty ssh destination is the on-box control arm, run locally", () => {
		const { cmd, args } = macgenInvocation({
			ssh: "",
			candidate: "",
			deadlineSeconds: 0,
			localBin: "/repo/target/release/load-client",
			clientArgs,
		});
		expect(cmd).toBe("/repo/target/release/load-client");
		expect(args).toEqual(clientArgs);
	});

	test("refuses to build an off-box invocation around a bad candidate", () => {
		expect(() =>
			macgenInvocation({
				ssh: "vmeansdev@10.99.0.1",
				candidate: "probe/g2-macgen-01",
				deadlineSeconds: 113,
				localBin: "",
				clientArgs,
			}),
		).toThrow("40-character");
	});
});

describe("parseMacgenLine", () => {
	test("reads the provenance header into fields", () => {
		expect(
			parseMacgenLine(`macgen: head=${SHA} dirty=no build=ok buildSec=41`),
		).toEqual({ head: SHA, dirty: "no", build: "ok", buildSec: "41" });
	});

	test("ignores load-client's own stdout", () => {
		expect(parseMacgenLine("load-client: sessions ok=100 err=0")).toBeNull();
	});
});

describe("data-subnet declaration", () => {
	test("default prefix is the home cable; declared VPC prefixes admit their hosts", async () => {
		const { assertCableHost, dataSubnetPrefix } = await import(
			"./g2-offbox.ts"
		);
		expect(dataSubnetPrefix({})).toBe("10.99.0");
		expect(dataSubnetPrefix({ LATENCY_RTT_DATA_SUBNET: "10.110.0" })).toBe(
			"10.110.0",
		);
		expect(() =>
			dataSubnetPrefix({ LATENCY_RTT_DATA_SUBNET: "not-a-prefix" }),
		).toThrow(/dotted 10\.x\.y/);
		process.env.LATENCY_RTT_DATA_SUBNET = "10.110.0";
		try {
			expect(assertCableHost("10.110.0.4", "T")).toBe("10.110.0.4");
			expect(() => assertCableHost("10.99.0.2", "T")).toThrow(
				/10\.110\.0\.0\/24/,
			);
			expect(() => assertCableHost("192.168.2.9", "T")).toThrow(/family LAN/);
		} finally {
			delete process.env.LATENCY_RTT_DATA_SUBNET;
		}
	});
});
