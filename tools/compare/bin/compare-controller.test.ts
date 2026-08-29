/**
 * Tests for the two-host controller.
 *
 * These pin the rig-config defaults that the live rig actually uses
 * (Mac `en13`, Linux `hermes-admin` user, `ubuntu-vm-hermes` SSH
 * key) so the controller cannot silently drift back to the plan's
 * stale values (`en8`, `bench`, `id_ed25519`). See
 * `docs/superpowers/plans/deviations/phase-3.5-rig-config-correction.md`.
 */

import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import {
	buildDryRunReport,
	buildNetemCommands,
	buildSshArgv,
	DEFAULT_SSH_IDENTITY,
	defaultRigEndpoints,
	parseLinuxRoute,
	parseMacRoute,
	validateDeadline,
	validateEndpoints,
} from "./compare-controller.ts";

describe("two-host controller: rig-config defaults", () => {
	it("defaultRigEndpoints returns en13 (not en8) and hermes-admin (not bench)", () => {
		const e = defaultRigEndpoints();
		expect(e.mac.interface).toBe("en13");
		expect(e.mac.address).toBe("10.99.0.1");
		expect(e.linux.interface).toBe("eno1");
		expect(e.linux.address).toBe("10.99.0.2");
		expect(e.linux.user).toBe("hermes-admin");
	});

	it("DEFAULT_SSH_IDENTITY is the ubuntu-vm-hermes key, not id_ed25519", () => {
		expect(DEFAULT_SSH_IDENTITY).toBe("~/.ssh/ubuntu-vm-hermes");
		expect(DEFAULT_SSH_IDENTITY).not.toContain("id_ed25519");
	});

	it("buildSshArgv uses the default identity and the user from the endpoint", () => {
		const argv = buildSshArgv(
			{ interface: "eno1", address: "10.99.0.2", user: "hermes-admin" },
			"echo ready",
		);
		const idx = argv.indexOf("-i");
		expect(idx).toBeGreaterThanOrEqual(0);
		expect(argv[idx + 1]).toBe(DEFAULT_SSH_IDENTITY);
		expect(argv).toContain("hermes-admin@10.99.0.2");
		expect(argv).toContain("echo ready");
		// No id_ed25519 should appear in the SSH argv.
		expect(argv.some((a) => a.includes("id_ed25519"))).toBe(false);
	});

	it("buildSshArgv uses the user from the endpoint, not a hardcoded value", () => {
		const argv = buildSshArgv(
			{ interface: "eno1", address: "10.99.0.2", user: "alice" },
			"uptime",
		);
		expect(argv).toContain("alice@10.99.0.2");
	});
});

describe("two-host controller: dry-run report with the live rig defaults", () => {
	it("buildDryRunReport produces a valid report for the live rig", () => {
		const result = buildDryRunReport({
			cell: "ticker",
			repetitions: 1,
			arms: ["ws", "wt"],
			candidate: "ws-wt-r0",
			campaignId: "campaign-r0",
			endpoints: defaultRigEndpoints(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Mac route: en13, valid
		expect(result.report.routes.mac.valid).toBe(true);
		expect(result.report.routes.mac.interface).toBe("en13");
		// Linux route: eno1, valid
		expect(result.report.routes.linux.valid).toBe(true);
		expect(result.report.routes.linux.interface).toBe("eno1");
		// SSH argv includes the correct identity
		expect(result.report.sshArgv).toContain(DEFAULT_SSH_IDENTITY);
		expect(result.report.sshArgv).toContain("hermes-admin@10.99.0.2");
		// Netem targets eno1
		expect(result.report.netemApply).toContain("eno1");
		// All seven deadlines are valid
		expect(result.report.deadlines.length).toBe(7);
		for (const d of result.report.deadlines) {
			expect(d.ok).toBe(true);
		}
		// Evidence path is under the policy root
		expect(result.report.evidencePath).toContain(".release-evidence");
	});
});

describe("two-host controller: pure-helper invariants", () => {
	it("parseMacRoute accepts the live direct-cable format", () => {
		const r = parseMacRoute(
			"destination: 10.99.0.2  interface: en13",
			"10.99.0.2",
		);
		expect(r.valid).toBe(true);
		expect(r.interface).toBe("en13");
	});

	it("parseMacRoute rejects a via route", () => {
		const r = parseMacRoute(
			"destination: 10.99.0.2  interface: en13  via: 192.168.1.1",
			"10.99.0.2",
		);
		expect(r.valid).toBe(false);
	});

	it("parseLinuxRoute accepts a direct-cable dev route", () => {
		// Live `ip route get 10.99.0.1` on the Linux bench returns
		// "10.99.0.1 dev eno1 src 10.99.0.2 uid 0 cache" — no "via".
		const r = parseLinuxRoute(
			"10.99.0.1 dev eno1 src 10.99.0.2 uid 0 cache",
			"10.99.0.1",
		);
		expect(r.valid).toBe(true);
		expect(r.interface).toBe("eno1");
	});

	it("parseLinuxRoute rejects a via-suffixed route (routed, not direct cable)", () => {
		// Routed: gateway via some other interface. The rig must
		// never be on a routed path.
		const r = parseLinuxRoute(
			"10.99.0.1 via 192.168.1.1 dev eth0",
			"10.99.0.1",
		);
		expect(r.valid).toBe(false);
	});

	it("parseLinuxRoute rejects a dev route to a different destination", () => {
		const r = parseLinuxRoute(
			"192.168.1.5 dev eno1 src 10.99.0.2",
			"10.99.0.1",
		);
		expect(r.valid).toBe(false);
	});

	it("buildNetemCommands targets the requested interface", () => {
		const cmds = buildNetemCommands("eno1", 50, 10);
		expect(cmds.apply).toContain("eno1");
		expect(cmds.apply).toContain("netem");
		expect(cmds.apply).toContain("50ms");
		expect(cmds.apply).toContain("10ms");
		expect(cmds.restore).toContain("del");
		expect(cmds.restore).toContain("eno1");
	});

	it("validateDeadline rejects windows over 5 minutes", () => {
		const v = validateDeadline({ label: "x", windowMs: 6 * 60 * 1000 });
		expect(v.ok).toBe(false);
	});

	it("validateDeadline rejects non-positive windows", () => {
		const v = validateDeadline({ label: "x", windowMs: 0 });
		expect(v.ok).toBe(false);
	});

	it("validateEndpoints rejects same-interface config", () => {
		const v = validateEndpoints({
			mac: { interface: "en13", address: "10.99.0.1" },
			linux: { interface: "en13", address: "10.99.0.2", user: "x" },
		});
		expect(v.ok).toBe(false);
	});

	it("validateEndpoints rejects missing linux user", () => {
		const v = validateEndpoints({
			mac: { interface: "en13", address: "10.99.0.1" },
			linux: { interface: "eno1", address: "10.99.0.2", user: "" },
		});
		expect(v.ok).toBe(false);
	});
});

describe("two-host controller: SSH identity path on the live host", () => {
	it("the default identity is a tilde-relative path under .ssh/", () => {
		// We do not assert the file's existence (the file is
		// host-specific) — we assert the controller's baked-in path
		// is the one the rig actually uses.
		expect(DEFAULT_SSH_IDENTITY.startsWith("~/")).toBe(true);
		expect(DEFAULT_SSH_IDENTITY.endsWith("/ubuntu-vm-hermes")).toBe(true);
		// Homedir-expanded form is what `ssh -i` would receive.
		const expanded = `${homedir()}${DEFAULT_SSH_IDENTITY.slice(1)}`;
		expect(expanded).toBe(`${homedir()}/.ssh/ubuntu-vm-hermes`);
	});
});
