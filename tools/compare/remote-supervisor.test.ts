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
	closeSync,
	mkdtempSync,
	readFileSync,
	readSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	R1_CAMPAIGN_AUTHORITY_BYTES,
	R1_CAMPAIGN_AUTHORITY_SHA256,
	R1_CAMPAIGN_LOCK_BYTES,
	R1_CAMPAIGN_MANIFEST_V1_BYTES,
	R1_STAGED_CAPABILITY_V1_BYTES,
} from "./r1-fixtures.ts";
import {
	assertDistinctFds,
	buildMacSupervisorArgv,
	buildRigSshArgv,
	buildRigSupervisorWrapperScript,
	createCloexecPipe,
	createControlPipePair,
	resolveSupervisorBinaryPath,
	resolveSupervisorBunPath,
	stageTrustBootstrap,
	type SupervisorSpawnOptions,
	type TrustBootstrap,
	verifyStagedTrustBootstrap,
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
	it("emits a self-contained bash script that pipes authority and execs the supervisor", () => {
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
		// The script body is non-empty so the caller can upload it; spawn
		// uses a two-step upload+exec so stdin stays free for control.
		expect(result.wrapperScript.length).toBeGreaterThan(0);
		expect(result.wrapperScript).toContain("#!/usr/bin/env bash");
		expect(result.wrapperScript).toContain("<(cat --");
		expect(result.sshArgv).toContain("bash");
	});
});

describe("remote-supervisor: createCloexecPipe / createControlPipePair", () => {
	it("round-trips bytes on a write-parent pipe", () => {
		const result = createCloexecPipe({ parentKeeps: "write" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const payload = Buffer.from("control-frame");
		writeSync(result.pipe.parentFd, payload);
		const buf = Buffer.alloc(32);
		const n = readSync(result.pipe.childFd, buf);
		expect(buf.subarray(0, n).toString()).toBe("control-frame");
		closeSync(result.pipe.parentFd);
		closeSync(result.pipe.childFd);
	});

	it("returns controller write / supervisor read streams for the control pair", () => {
		const result = createControlPipePair();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.controllerToSupervisor.writable).toBe(true);
		expect(result.supervisorToController.readable).toBe(true);
		expect(result.controlIn.parentFd).not.toBe(result.controlIn.childFd);
		expect(result.controlOut.parentFd).not.toBe(result.controlOut.childFd);
		closeSync(result.controlIn.parentFd);
		closeSync(result.controlIn.childFd);
		closeSync(result.controlOut.parentFd);
		closeSync(result.controlOut.childFd);
	});
});

describe("remote-supervisor: stageTrustBootstrap / verifyStagedTrustBootstrap", () => {
	it("stages R1 fixture material and verifies against the pinned authority digest", () => {
		const stagedDir = mkdtempSync(join(tmpdir(), "ws-wt-stage-"));
		try {
			const staged = stageTrustBootstrap(stagedDir, {
				authorityBytes: R1_CAMPAIGN_AUTHORITY_BYTES,
				authoritySha256Hex: R1_CAMPAIGN_AUTHORITY_SHA256,
				campaignLockBytes: R1_CAMPAIGN_LOCK_BYTES,
				stagedCapabilityBytes: R1_STAGED_CAPABILITY_V1_BYTES,
				manifestBytes: R1_CAMPAIGN_MANIFEST_V1_BYTES,
			});
			expect(staged.ok).toBe(true);
			if (!staged.ok) return;
			expect(staged.paths.digests.authority).toBe(R1_CAMPAIGN_AUTHORITY_SHA256);
			const digestFile = readFileSync(staged.paths.authorityDigestFile);
			expect(digestFile.byteLength).toBe(32);

			const verified = verifyStagedTrustBootstrap(
				stagedDir,
				R1_CAMPAIGN_AUTHORITY_SHA256,
			);
			expect(verified.ok).toBe(true);
			if (!verified.ok) return;
			expect(verified.paths.campaignRootDir).toBe(staged.paths.campaignRootDir);
			expect(verified.paths.stagingRootDir).toBe(staged.paths.stagingRootDir);
		} finally {
			rmSync(stagedDir, { recursive: true, force: true });
		}
	});

	it("refuses a staged dir whose authority digest does not match the pin", () => {
		const stagedDir = mkdtempSync(join(tmpdir(), "ws-wt-stage-bad-"));
		try {
			const staged = stageTrustBootstrap(stagedDir, {
				authorityBytes: R1_CAMPAIGN_AUTHORITY_BYTES,
				authoritySha256Hex: R1_CAMPAIGN_AUTHORITY_SHA256,
				campaignLockBytes: R1_CAMPAIGN_LOCK_BYTES,
				stagedCapabilityBytes: R1_STAGED_CAPABILITY_V1_BYTES,
				manifestBytes: R1_CAMPAIGN_MANIFEST_V1_BYTES,
			});
			expect(staged.ok).toBe(true);
			const verified = verifyStagedTrustBootstrap(stagedDir, "a".repeat(64));
			expect(verified.ok).toBe(false);
			if (verified.ok) return;
			expect(verified.code).toBe("STAGE_DIGEST_MISMATCH");
		} finally {
			rmSync(stagedDir, { recursive: true, force: true });
		}
	});
});

describe("remote-supervisor: resolveSupervisorBinaryPath / Bun path", () => {
	it("prefers COMPARISON_SUPERVISOR_BINARY when set to an existing path", () => {
		const stagedDir = mkdtempSync(join(tmpdir(), "ws-wt-bin-"));
		const binary = join(stagedDir, "comparison-supervisor");
		try {
			writeFileSync(binary, "#!/bin/true\n", { mode: 0o755 });
			const resolved = resolveSupervisorBinaryPath(
				{ COMPARISON_SUPERVISOR_BINARY: binary },
				stagedDir,
			);
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;
			expect(resolved.path).toBe(binary);
		} finally {
			rmSync(stagedDir, { recursive: true, force: true });
		}
	});

	it("refuses when neither env nor default binary exists", () => {
		const resolved = resolveSupervisorBinaryPath(
			{},
			join(tmpdir(), "ws-wt-missing-cwd-does-not-exist"),
		);
		expect(resolved.ok).toBe(false);
	});

	it("resolves Bun from COMPARISON_SUPERVISOR_BUN_PATH", () => {
		const resolved = resolveSupervisorBunPath({
			COMPARISON_SUPERVISOR_BUN_PATH: "/custom/bun",
		});
		expect(resolved.ok).toBe(true);
		if (!resolved.ok) return;
		expect(resolved.path).toBe("/custom/bun");
	});
});
