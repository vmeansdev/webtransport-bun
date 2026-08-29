/**
 * Tests for the Phase 3.6.1 spawn contract.
 *
 * Pure-helper tests cover argv construction, FD distinctness, the rig-side
 * wrapper script, and SSH argv construction. The live `Bun.spawn` paths in
 * `spawnMacSupervisor` are exercised in the controller's e2e tests
 * (Phase 3.6.5); they are not unit-testable in this module without a real
 * supervisor binary.
 */

import { describe, expect, it } from "bun:test";
import {
	assertDistinctFds,
	buildMacSupervisorArgv,
	buildRigSshArgv,
	buildRigSupervisorWrapperScript,
	type SupervisorSpawnOptions,
	type TrustBootstrap,
} from "./remote-supervisor.ts";

const BOOTSTRAP: TrustBootstrap = {
	authority: { fd: 3, label: "authority" },
	authorityDigest: { fd: 4, label: "authority-digest" },
	campaignRoot: { fd: 5, label: "campaign-root" },
	stagingRoot: { fd: 6, label: "staging-root" },
};

const SAMPLE_OPTIONS: SupervisorSpawnOptions = {
	// Use a binary that is guaranteed to exist on every test host so the
	// argv-builder's existence check does not fail before the test's own
	// assertion runs. The actual comparison-supervisor binary is only on
	// the Mac and the rig, not in CI.
	binaryPath: "/bin/sh",
	bootstrap: BOOTSTRAP,
	bunExecutablePath: "/Users/vmeansdev/.bun/bin/bun",
};

describe("remote-supervisor: assertDistinctFds", () => {
	it("accepts a clean bootstrap with all distinct FDs", () => {
		const result = assertDistinctFds(SAMPLE_OPTIONS);
		expect(result.ok).toBe(true);
	});

	it("accepts bootstrap + control with all six FDs distinct", () => {
		const result = assertDistinctFds({
			...SAMPLE_OPTIONS,
			control: {
				controlIn: { fd: 7, label: "control-in" },
				controlOut: { fd: 8, label: "control-out" },
			},
		});
		expect(result.ok).toBe(true);
	});

	it("refuses a duplicate FD between bootstrap entries", () => {
		const result = assertDistinctFds({
			...SAMPLE_OPTIONS,
			bootstrap: {
				...BOOTSTRAP,
				authorityDigest: { fd: 3, label: "authority-digest-collision" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_FD_DUPLICATE");
	});

	it("refuses a duplicate FD between bootstrap and control", () => {
		const result = assertDistinctFds({
			...SAMPLE_OPTIONS,
			control: {
				controlIn: { fd: 5, label: "control-in-collision" },
				controlOut: { fd: 8, label: "control-out" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_FD_DUPLICATE");
	});

	it("refuses a negative FD", () => {
		const result = assertDistinctFds({
			...SAMPLE_OPTIONS,
			bootstrap: {
				...BOOTSTRAP,
				authority: { fd: -1, label: "authority-negative" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_BOOTSTRAP_FD_MISSING");
	});
});

describe("remote-supervisor: buildMacSupervisorArgv", () => {
	it("builds an argv with the four bootstrap FD options", () => {
		const result = buildMacSupervisorArgv(SAMPLE_OPTIONS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.argv[0]).toBe(SAMPLE_OPTIONS.binaryPath);
		expect(result.argv).toContain("--authority-fd");
		expect(result.argv).toContain("3");
		expect(result.argv).toContain("--authority-digest-fd");
		expect(result.argv).toContain("4");
		expect(result.argv).toContain("--campaign-root-fd");
		expect(result.argv).toContain("5");
		expect(result.argv).toContain("--staging-root-fd");
		expect(result.argv).toContain("6");
	});

	it("omits --control-in-fd / --control-out-fd when control is absent", () => {
		const result = buildMacSupervisorArgv(SAMPLE_OPTIONS);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.argv).not.toContain("--control-in-fd");
		expect(result.argv).not.toContain("--control-out-fd");
	});

	it("includes --control-in-fd and --control-out-fd when control is present", () => {
		const result = buildMacSupervisorArgv({
			...SAMPLE_OPTIONS,
			control: {
				controlIn: { fd: 7, label: "control-in" },
				controlOut: { fd: 8, label: "control-out" },
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.argv).toContain("--control-in-fd");
		expect(result.argv).toContain("7");
		expect(result.argv).toContain("--control-out-fd");
		expect(result.argv).toContain("8");
	});

	it("refuses duplicate FDs before checking the binary exists", () => {
		const result = buildMacSupervisorArgv({
			...SAMPLE_OPTIONS,
			bootstrap: {
				...BOOTSTRAP,
				authority: { fd: 4, label: "dup" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_FD_DUPLICATE");
	});

	it("refuses when the supervisor binary does not exist", () => {
		const result = buildMacSupervisorArgv({
			...SAMPLE_OPTIONS,
			binaryPath: "/does/not/exist/comparison-supervisor",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_BINARY_MISSING");
	});
});

describe("remote-supervisor: buildRigSupervisorWrapperScript", () => {
	it("emits a self-contained sh script that opens the four files and execs the supervisor", () => {
		const result = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			binaryPath: "/usr/local/bin/comparison-supervisor",
			rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
			rigPaths: {
				authorityFile: "/var/staged/<campaign>/authority.json",
				authorityDigestFile: "/var/staged/<campaign>/authority-digest.bin",
				campaignRootDir: "/var/campaign/<campaign>",
				stagingRootDir: "/var/staged/<campaign>",
			},
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The script must exec the rig-side binary with the FD-number argv.
		expect(result.script).toContain(
			"/opt/webtransport/target/release/comparison-supervisor",
		);
		// The control FDs are 0 and 1 (SSH session's stdin/stdout).
		expect(result.script).toContain("--control-in-fd 0");
		expect(result.script).toContain("--control-out-fd 1");
		// Bootstrap FDs are 3, 4, 5, 6 (post 0/1/2 reservation).
		expect(result.script).toContain("--authority-fd");
		expect(result.script).toContain("--authority-digest-fd");
		expect(result.script).toContain("--campaign-root-fd");
		expect(result.script).toContain("--staging-root-fd");
		// `set -eu` so a missing file aborts rather than silently succeeding.
		expect(result.script).toContain("set -eu");
	});

	it("refuses duplicate FDs in the rig-side options", () => {
		const result = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
			rigPaths: {
				authorityFile: "/var/staged/<campaign>/authority.json",
				authorityDigestFile: "/var/staged/<campaign>/authority-digest.bin",
				campaignRootDir: "/var/campaign/<campaign>",
				stagingRootDir: "/var/staged/<campaign>",
			},
			control: {
				controlIn: { fd: 3, label: "control-in-collision" },
				controlOut: { fd: 4, label: "control-out" },
			},
			bootstrap: {
				...BOOTSTRAP,
				authority: { fd: 3, label: "authority-collision" },
			},
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("SPAWN_FD_DUPLICATE");
	});
});

describe("remote-supervisor: buildRigSshArgv", () => {
	it("emits an ssh argv that pipes the wrapper script via stdin (sh -s)", () => {
		const result = buildRigSshArgv({
			...SAMPLE_OPTIONS,
			rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
			rigPaths: {
				authorityFile: "/var/staged/<campaign>/authority.json",
				authorityDigestFile: "/var/staged/<campaign>/authority-digest.bin",
				campaignRootDir: "/var/campaign/<campaign>",
				stagingRootDir: "/var/staged/<campaign>",
			},
			sshTarget: "hermes-admin@10.99.0.2",
			sshIdentity: "~/.ssh/ubuntu-vm-hermes",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.sshArgv[0]).toBe("ssh");
		expect(result.sshArgv).toContain("-i");
		expect(result.sshArgv).toContain("~/.ssh/ubuntu-vm-hermes");
		expect(result.sshArgv).toContain("hermes-admin@10.99.0.2");
		// `-T` disables pty allocation: stdin/stdout ARE the supervisor's
		// control FDs.
		expect(result.sshArgv).toContain("-T");
		// The script body is non-empty so the caller can pipe it.
		expect(result.wrapperScript.length).toBeGreaterThan(0);
	});
});
