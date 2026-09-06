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
	type ChildProcessWithoutNullStreams,
	spawn as nodeSpawn,
	spawnSync,
} from "node:child_process";
import {
	chmodSync,
	closeSync,
	createReadStream,
	fstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
	type MacWire,
	type ScriptedMacBinaryOptions,
	ScriptedMacCohortBinary,
	scriptedRigExecutionAcceptedAck,
	serveScriptedMac,
} from "./cohort-fixture-signing.ts";
import {
	bytesOfCanonical,
	CohortEvidenceBudget,
	decodeRegisteredRemotePayload,
	encodeRegisteredRemotePayload,
	generateEd25519KeyPair,
	type MacCohortOpenedAckV1,
	signRigReceipt,
} from "./cross-supervisor-protocol.ts";
import {
	R1_CAMPAIGN_AUTHORITY_BYTES,
	R1_CAMPAIGN_AUTHORITY_SHA256,
	R1_CAMPAIGN_LOCK_BYTES,
	R1_CAMPAIGN_MANIFEST_V1_BYTES,
	R1_STAGED_CAPABILITY_V1_BYTES,
} from "./r1-fixtures.ts";
import {
	assertDistinctFds,
	attachSupervisorChildDiagnostics,
	bindBarrierClockId,
	buildMacSupervisorArgv,
	buildRigSshArgv,
	buildRigSshRunArgv,
	buildRigSupervisorWrapperScript,
	CohortRigChannel,
	controlPipeShapeRefusal,
	createCloexecPipe,
	createControlPipePair,
	describeSupervisorChildDeath,
	MAC_RECEIPT_VALIDITY_ENV,
	MacCohortChannel,
	mapRigRefusalCodeToIndexCode,
	type RigChildSpawner,
	readControlFrame,
	resolveSupervisorBinaryPath,
	resolveSupervisorBunPath,
	SUPERVISOR_BUN_PATH_ENV,
	SUPERVISOR_STDERR_TAIL_MAX_BYTES,
	type SupervisorChildDiagnostics,
	type SupervisorHandle,
	type SupervisorSpawnOptions,
	type SupervisorSubprocess,
	spawnRigSshChild,
	spawnRigSupervisor,
	stageTrustBootstrap,
	stopSupervisor,
	type TrustBootstrap,
	verifyStagedTrustBootstrap,
	withWriteDeadline,
} from "./remote-supervisor.ts";
import { buildFanoutCohortFixture } from "./scenarios/fanout-relay.ts";
import { sha256HexOfBytes } from "./secure-fs.ts";
import { encodeSupervisorFrame } from "./supervisor-client.ts";

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

	it("exports the receipt validity window beside the cohort descriptors, and only then", () => {
		const rig = {
			rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
			rigPaths: {
				authorityFile: "/var/staged/<campaign>/authority.json",
				authorityDigestFile: "/var/staged/<campaign>/authority-digest.bin",
				campaignRootDir: "/var/campaign/<campaign>",
				stagingRootDir: "/var/staged/<campaign>",
			},
		};
		const cohort = {
			macSigningKey: { fd: 7, label: "mac-signing-key", path: "/keys/mac.pk8" },
			stagedRigPublicKey: {
				fd: 8,
				label: "staged-rig-public-key",
				path: "/var/staged/<campaign>/staging-root/rig-supervisor-ed25519.pub",
			},
			receiptValidityMs: 600_000,
		};
		// The binary reads the window from its environment and a uid crossing's
		// env_reset drops the controller's, so the wrapper exports it itself
		// before the exec, on both tiers.
		for (const uidCrossing of [undefined, { targetUser: "_wtcompare" }]) {
			const result = buildRigSupervisorWrapperScript({
				...SAMPLE_OPTIONS,
				...rig,
				cohort,
				...(uidCrossing === undefined ? {} : { uidCrossing }),
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const exportAt = result.script.indexOf(
				`export ${MAC_RECEIPT_VALIDITY_ENV}=600000\n`,
			);
			expect(exportAt).toBeGreaterThan(-1);
			expect(exportAt).toBeLessThan(result.script.indexOf("exec 7<"));
			expect(result.script).toContain("--cohort-mac-signing-key-fd 7");
		}
		// A spawn without a signer states no window: nothing to sign with it.
		const phaseA = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			...rig,
		});
		expect(phaseA.ok).toBe(true);
		if (!phaseA.ok) return;
		expect(phaseA.script).not.toContain(MAC_RECEIPT_VALIDITY_ENV);
		// A window that is not a positive integer is a programming error, not a
		// value the binary should be handed to parse.
		for (const receiptValidityMs of [0, -1, 1.5, Number.NaN]) {
			expect(() =>
				buildRigSupervisorWrapperScript({
					...SAMPLE_OPTIONS,
					...rig,
					cohort: { ...cohort, receiptValidityMs },
				}),
			).toThrow(RangeError);
		}
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

describe("remote-supervisor: buildRigSupervisorWrapperScript rig cohort descriptors (G3a)", () => {
	const rig = {
		rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
		rigPaths: {
			authorityFile: "/var/staged/<campaign>/authority.json",
			authorityDigestFile: "/var/staged/<campaign>/authority-digest.bin",
			campaignRootDir: "/var/campaign/<campaign>",
			stagingRootDir: "/var/staged/<campaign>",
		},
	};
	const rigCohort = {
		signingKey: {
			fd: 7,
			label: "cohort-signing-key",
			path: "/var/lib/webtransport-bun/comparison/keys/c/x.rig.pk8",
		},
		roleRoot: {
			fd: 10,
			label: "cohort-role-root",
			path: "/var/staged/<campaign>/roles",
		},
	};
	const macCohort = {
		macSigningKey: { fd: 7, label: "mac-signing-key", path: "/keys/mac.pk8" },
		stagedRigPublicKey: {
			fd: 8,
			label: "staged-rig-public-key",
			path: "/var/staged/<campaign>/staging-root/rig-supervisor-ed25519.pub",
		},
		receiptValidityMs: 600_000,
	};

	it("opens the rig key and the role root after the bootstrap roots and names them the way the binary reads them, on both tiers", () => {
		for (const uidCrossing of [undefined, { targetUser: "_wtcompare" }]) {
			const result = buildRigSupervisorWrapperScript({
				...SAMPLE_OPTIONS,
				...rig,
				rigCohort,
				...(uidCrossing === undefined ? {} : { uidCrossing }),
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const lines = result.script.split("\n");
			// Exactly the redirections, in order: 3..6 first, then the rig pair.
			const opens = lines.filter((line) => /^exec \d+</.test(line));
			expect(opens).toEqual([
				`exec 3< <(${uidCrossing === undefined ? "cat" : "/bin/cat"} -- '/var/staged/<campaign>/authority.json')`,
				"exec 4<'/var/staged/<campaign>/authority-digest.bin'",
				"exec 5<'/var/campaign/<campaign>'",
				"exec 6<'/var/staged/<campaign>'",
				"exec 7<'/var/lib/webtransport-bun/comparison/keys/c/x.rig.pk8'",
				"exec 10<'/var/staged/<campaign>/roles'",
			]);
			// Row 10: the Bun path is the one export; a rig states no validity
			// window because it signs no Mac receipt.
			expect(lines.filter((line) => line.startsWith("export "))).toEqual([
				`export ${SUPERVISOR_BUN_PATH_ENV}='${SAMPLE_OPTIONS.bunExecutablePath}'`,
			]);
			expect(result.script).not.toContain(MAC_RECEIPT_VALIDITY_ENV);
			// The flags, spelled as `cohort_install_descriptors` scans them.
			expect(result.script).toContain("--cohort-signing-key-fd 7");
			expect(result.script).toContain("--cohort-role-root-fd 10");
			expect(result.script).not.toContain("--cohort-mac-signing-key-fd");
			expect(result.script).not.toContain("--cohort-staged-rig-public-key-fd");
			// The opens precede the exec of the binary.
			const execAt = result.script.indexOf(`exec '${rig.rigBinaryPath}'`);
			expect(result.script.indexOf("exec 7<")).toBeLessThan(execAt);
			expect(result.script.indexOf("exec 10<")).toBeLessThan(execAt);
		}
	});

	it("a Mac spawn keeps its own pair and no rig flag; a spawn naming both roles is refused", () => {
		const mac = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			...rig,
			cohort: macCohort,
		});
		expect(mac.ok).toBe(true);
		if (!mac.ok) return;
		expect(mac.script).not.toContain("--cohort-signing-key-fd");
		expect(mac.script).not.toContain("--cohort-role-root-fd");
		const both = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			...rig,
			cohort: macCohort,
			rigCohort: {
				...rigCohort,
				signingKey: { ...rigCohort.signingKey, fd: 9 },
			},
		});
		expect(both.ok).toBe(false);
		if (both.ok) return;
		expect(both.code).toBe("SPAWN_COHORT_ROLE_AMBIGUOUS");
	});

	it("refuses a missing descriptor: an empty slot, a colliding number, a non-integer number, a relative path", () => {
		const missingRoleRoot = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			...rig,
			rigCohort: { signingKey: rigCohort.signingKey } as typeof rigCohort,
		});
		expect(missingRoleRoot.ok).toBe(false);
		if (missingRoleRoot.ok) return;
		expect(missingRoleRoot.code).toBe("SPAWN_BOOTSTRAP_FD_MISSING");
		expect(missingRoleRoot.message).toContain("rigCohort.roleRoot");

		const missingKey = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			...rig,
			rigCohort: { roleRoot: rigCohort.roleRoot } as typeof rigCohort,
		});
		expect(missingKey.ok).toBe(false);
		if (missingKey.ok) return;
		expect(missingKey.code).toBe("SPAWN_BOOTSTRAP_FD_MISSING");
		expect(missingKey.message).toContain("rigCohort.signingKey");

		const colliding = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			...rig,
			rigCohort: {
				...rigCohort,
				roleRoot: { ...rigCohort.roleRoot, fd: 6 },
			},
		});
		expect(colliding.ok).toBe(false);
		if (colliding.ok) return;
		expect(colliding.code).toBe("SPAWN_FD_DUPLICATE");

		const fractional = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			...rig,
			rigCohort: {
				...rigCohort,
				signingKey: { ...rigCohort.signingKey, fd: 7.5 },
			},
		});
		expect(fractional.ok).toBe(false);
		if (fractional.ok) return;
		expect(fractional.code).toBe("SPAWN_BOOTSTRAP_FD_MISSING");

		expect(() =>
			buildRigSupervisorWrapperScript({
				...SAMPLE_OPTIONS,
				...rig,
				rigCohort: {
					...rigCohort,
					roleRoot: { ...rigCohort.roleRoot, path: "roles" },
				},
			}),
		).toThrow(RangeError);
	});

	/**
	 * The wrapper, executed: a stub in the binary's place reports the argv it
	 * received, the two row-10 names, the bytes on the key descriptor and the
	 * identity of the directory on the role-root descriptor.
	 */
	function executeWrapper(args: {
		readonly keyPath: string;
		readonly roleRootPath: string;
	}): {
		readonly status: number;
		readonly stdout: string;
		readonly stderr: string;
	} {
		const root = mkdtempSync(join(tmpdir(), "rig-wrapper-exec-"));
		const stub = join(root, "supervisor-stub.ts");
		writeFileSync(
			stub,
			`#!${process.execPath}
import { fstatSync, readFileSync } from "node:fs";
const roleRoot = fstatSync(10);
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  bun: process.env.${SUPERVISOR_BUN_PATH_ENV} ?? null,
  validity: process.env.${MAC_RECEIPT_VALIDITY_ENV} ?? null,
  authority: readFileSync(3, "utf8"),
  key: readFileSync(7, "utf8"),
  roleRootIsDirectory: roleRoot.isDirectory(),
  roleRootDev: roleRoot.dev,
  roleRootIno: roleRoot.ino,
}));
`,
		);
		chmodSync(stub, 0o755);
		const authorityFile = join(root, "authority.json");
		const digestFile = join(root, "authority-digest.bin");
		const campaignRoot = join(root, "campaign-root");
		const stagingRoot = join(root, "staging-root");
		writeFileSync(authorityFile, '{"schema":"fixture"}\n');
		writeFileSync(digestFile, "digest\n");
		mkdirSync(campaignRoot);
		mkdirSync(stagingRoot);
		const built = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			bunExecutablePath: "/opt/rig/bun",
			rigBinaryPath: stub,
			rigPaths: {
				authorityFile,
				authorityDigestFile: digestFile,
				campaignRootDir: campaignRoot,
				stagingRootDir: stagingRoot,
			},
			rigCohort: {
				signingKey: { fd: 7, label: "cohort-signing-key", path: args.keyPath },
				roleRoot: {
					fd: 10,
					label: "cohort-role-root",
					path: args.roleRootPath,
				},
			},
		});
		if (!built.ok) throw new Error(built.code);
		const run = spawnSync("/bin/bash", ["-c", built.script], {
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin" },
		});
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// throwaway
		}
		return {
			status: run.status ?? -1,
			stdout: run.stdout ?? "",
			stderr: (run.stderr ?? "").trim(),
		};
	}

	it("executed: the binary receives exactly the flags, the Bun path, the key bytes on 7 and the role root directory on 10", () => {
		const root = mkdtempSync(join(tmpdir(), "rig-wrapper-inputs-"));
		const keyPath = join(root, "campaign.rig.pk8");
		const roleRootPath = join(root, "roles");
		writeFileSync(keyPath, "RIG-KEY-BYTES-not-a-real-pkcs8\n");
		mkdirSync(roleRootPath);
		writeFileSync(join(roleRootPath, "server.ts"), "");
		const expected = statSync(roleRootPath);
		const ran = executeWrapper({ keyPath, roleRootPath });
		rmSync(root, { recursive: true, force: true });
		expect(ran.stderr).toBe("");
		expect(ran.status).toBe(0);
		const seen = JSON.parse(ran.stdout) as {
			argv: string[];
			bun: string | null;
			validity: string | null;
			authority: string;
			key: string;
			roleRootIsDirectory: boolean;
			roleRootDev: number;
			roleRootIno: number;
		};
		expect(seen.argv).toEqual([
			"--authority-fd",
			"3",
			"--authority-digest-fd",
			"4",
			"--campaign-root-fd",
			"5",
			"--staging-root-fd",
			"6",
			"--control-in-fd",
			"0",
			"--control-out-fd",
			"1",
			"--cohort-signing-key-fd",
			"7",
			"--cohort-role-root-fd",
			"10",
		]);
		// Row 10 arrived by the export line: the spawn's own environment held
		// no such name.
		expect(seen.bun).toBe("/opt/rig/bun");
		expect(seen.validity).toBeNull();
		expect(seen.authority).toBe('{"schema":"fixture"}\n');
		expect(seen.key).toBe("RIG-KEY-BYTES-not-a-real-pkcs8\n");
		expect(seen.roleRootIsDirectory).toBe(true);
		expect(seen.roleRootDev).toBe(expected.dev);
		expect(seen.roleRootIno).toBe(expected.ino);
	});

	it("executed: a key or role root that is not there stops the wrapper before the binary runs", () => {
		const root = mkdtempSync(join(tmpdir(), "rig-wrapper-missing-"));
		const keyPath = join(root, "campaign.rig.pk8");
		const roleRootPath = join(root, "roles");
		writeFileSync(keyPath, "key\n");
		mkdirSync(roleRootPath);
		const noKey = executeWrapper({
			keyPath: join(root, "absent.pk8"),
			roleRootPath,
		});
		expect(noKey.status).not.toBe(0);
		expect(noKey.stdout).toBe("");
		expect(noKey.stderr).toContain("absent.pk8");
		const noRoot = executeWrapper({
			keyPath,
			roleRootPath: join(root, "absent-roles"),
		});
		expect(noRoot.status).not.toBe(0);
		expect(noRoot.stdout).toBe("");
		expect(noRoot.stderr).toContain("absent-roles");
		rmSync(root, { recursive: true, force: true });
	});
});

describe("remote-supervisor: buildRigSupervisorWrapperScript single Linux root (G3b)", () => {
	// The 2026-08-24 amendment gives the Linux supervisor one retained root
	// (lock + capability "through its retained Linux staging-root handle");
	// the authority declares exactly one Linux root, `linux-staging`. A rig
	// staged on Linux is therefore handed that directory alone, on 6, and no
	// `--campaign-root-fd`; the darwin local-acceptance rig keeps the Mac's
	// pair. The shape of `rigPaths` is the whole selection: no env flag.
	const single = {
		rigBinaryPath:
			"/home/hermes-admin/ws-wt-stage/c/camp/bin/comparison-supervisor",
		rigPaths: {
			authorityFile: "/home/hermes-admin/ws-wt-stage/c/camp/authority.json",
			authorityDigestFile:
				"/home/hermes-admin/ws-wt-stage/c/camp/authority-digest.bin",
			stagingRootDir: "/home/hermes-admin/ws-wt-stage/c/camp",
		},
	};
	const two = {
		rigBinaryPath: single.rigBinaryPath,
		rigPaths: {
			...single.rigPaths,
			campaignRootDir: "/var/campaign/<campaign>",
		},
	};
	const rigCohort = {
		signingKey: {
			fd: 7,
			label: "cohort-signing-key",
			path: "/var/lib/webtransport-bun/comparison/keys/c/camp.rig.pk8",
		},
		roleRoot: {
			fd: 10,
			label: "cohort-role-root",
			path: "/tmp/ws-wt-linux-build.x/tools/compare",
		},
	};

	it("opens the one root on 6 and names no campaign root to the binary; the two-root sibling still opens 5", () => {
		for (const uidCrossing of [undefined, { targetUser: "_wtcompare" }]) {
			const result = buildRigSupervisorWrapperScript({
				...SAMPLE_OPTIONS,
				...single,
				rigCohort,
				...(uidCrossing === undefined ? {} : { uidCrossing }),
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const lines = result.script.split("\n");
			expect(lines.filter((line) => /^exec \d+</.test(line))).toEqual([
				`exec 3< <(${uidCrossing === undefined ? "cat" : "/bin/cat"} -- '/home/hermes-admin/ws-wt-stage/c/camp/authority.json')`,
				"exec 4<'/home/hermes-admin/ws-wt-stage/c/camp/authority-digest.bin'",
				"exec 6<'/home/hermes-admin/ws-wt-stage/c/camp'",
				"exec 7<'/var/lib/webtransport-bun/comparison/keys/c/camp.rig.pk8'",
				"exec 10<'/tmp/ws-wt-linux-build.x/tools/compare'",
			]);
			expect(lines).not.toContain("campaign_root_fd=5");
			expect(lines).toContain("staging_root_fd=6");
			expect(result.script).not.toContain("--campaign-root-fd");
			expect(result.script).not.toContain("campaign-root");
			expect(result.script).toContain('--staging-root-fd "${staging_root_fd}"');
			expect(result.script).toContain("--cohort-signing-key-fd 7");
			expect(result.script).toContain("--cohort-role-root-fd 10");
		}
		const sibling = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			...two,
			rigCohort,
		});
		expect(sibling.ok).toBe(true);
		if (!sibling.ok) return;
		expect(sibling.script).toContain("exec 5<'/var/campaign/<campaign>'");
		expect(sibling.script).toContain(
			'--campaign-root-fd "${campaign_root_fd}"',
		);
	});

	it("refuses a bootstrap path that is not absolute, in either shape", () => {
		for (const [shape, key] of [
			[single, "stagingRootDir"],
			[single, "authorityFile"],
			[two, "campaignRootDir"],
		] as const) {
			expect(() =>
				buildRigSupervisorWrapperScript({
					...SAMPLE_OPTIONS,
					...shape,
					rigPaths: { ...shape.rigPaths, [key]: "ws-wt-stage/c/camp" },
				}),
			).toThrow(RangeError);
			expect(() =>
				buildRigSupervisorWrapperScript({
					...SAMPLE_OPTIONS,
					...shape,
					rigPaths: { ...shape.rigPaths, [key]: "" },
				}),
			).toThrow(RangeError);
		}
	});

	/**
	 * Executed: a stub in the binary's place reports its argv, whether fd 6
	 * is the very directory the wrapper was told to open, and that fd 5 was
	 * never opened -- the rig's Linux arm has no campaign handle to inherit.
	 */
	function executeSingleRoot(
		root: string,
		extra: { readonly twoRoots?: boolean },
	) {
		const stub = join(root, "supervisor-stub.ts");
		writeFileSync(
			stub,
			`#!${process.execPath}
import { fstatSync } from "node:fs";
let fd5 = { open: false, isDirectory: false, ino: -1 };
try { const five = fstatSync(5); fd5 = { open: true, isDirectory: five.isDirectory(), ino: five.ino }; } catch {}
const six = fstatSync(6);
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2),
  fd5,
  sixIsDirectory: six.isDirectory(),
  sixDev: six.dev,
  sixIno: six.ino,
}));
`,
		);
		chmodSync(stub, 0o755);
		const staged = join(root, "stage");
		mkdirSync(staged);
		writeFileSync(join(staged, "authority.json"), '{"schema":"fixture"}\n');
		writeFileSync(join(staged, "authority-digest.bin"), "digest\n");
		const campaign = join(root, "campaign-root");
		mkdirSync(campaign);
		const built = buildRigSupervisorWrapperScript({
			...SAMPLE_OPTIONS,
			bunExecutablePath: "/opt/rig/bun",
			rigBinaryPath: stub,
			rigPaths: {
				authorityFile: join(staged, "authority.json"),
				authorityDigestFile: join(staged, "authority-digest.bin"),
				stagingRootDir: staged,
				...(extra.twoRoots === true ? { campaignRootDir: campaign } : {}),
			},
		});
		if (!built.ok) throw new Error(built.code);
		const run = spawnSync("/bin/bash", ["-c", built.script], {
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin" },
		});
		return {
			status: run.status ?? -1,
			stderr: (run.stderr ?? "").trim(),
			seen: JSON.parse(run.stdout || "{}") as {
				argv: string[];
				fd5: { open: boolean; isDirectory: boolean; ino: number };
				sixIsDirectory: boolean;
				sixDev: number;
				sixIno: number;
			},
			expected: statSync(staged),
			campaign: statSync(campaign),
		};
	}

	it("executed: the binary receives the three-root-less flags, the staged directory on 6 and nothing on 5", () => {
		const root = mkdtempSync(join(tmpdir(), "rig-wrapper-single-root-"));
		const ran = executeSingleRoot(root, {});
		const twoRoots = executeSingleRoot(
			mkdtempSync(join(tmpdir(), "rig-wrapper-two-roots-")),
			{ twoRoots: true },
		);
		rmSync(root, { recursive: true, force: true });
		expect(ran.stderr).toBe("");
		expect(ran.status).toBe(0);
		expect(ran.seen.argv).toEqual([
			"--authority-fd",
			"3",
			"--authority-digest-fd",
			"4",
			"--staging-root-fd",
			"6",
			"--control-in-fd",
			"0",
			"--control-out-fd",
			"1",
		]);
		// Whatever the test runner leaves on 5, the wrapper opened no campaign
		// directory there: the rig's Linux arm has no such handle to inherit.
		expect(
			ran.seen.fd5.isDirectory && ran.seen.fd5.ino === ran.campaign.ino,
		).toBe(false);
		expect(ran.seen.sixIsDirectory).toBe(true);
		expect(ran.seen.sixDev).toBe(ran.expected.dev);
		expect(ran.seen.sixIno).toBe(ran.expected.ino);
		// The darwin arm's sibling, executed the same way: 5 is open and named.
		expect(twoRoots.status).toBe(0);
		expect(twoRoots.seen.fd5).toEqual({
			open: true,
			isDirectory: true,
			ino: twoRoots.campaign.ino,
		});
		expect(twoRoots.seen.argv.slice(4, 8)).toEqual([
			"--campaign-root-fd",
			"5",
			"--staging-root-fd",
			"6",
		]);
	});
});

describe("remote-supervisor: buildRigSshRunArgv (the rig's uid crossing over ssh)", () => {
	const rig = {
		rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
		rigPaths: {
			authorityFile: "/var/staged/<campaign>/authority.json",
			authorityDigestFile: "/var/staged/<campaign>/authority-digest.bin",
			campaignRootDir: "/var/campaign/<campaign>",
			stagingRootDir: "/var/staged/<campaign>",
		},
		sshTarget: "hermes-admin@10.99.0.2",
		sshIdentity: "/Users/x/.ssh/do_id_rsa",
		rigCohort: {
			signingKey: {
				fd: 7,
				label: "cohort-signing-key",
				path: "/var/lib/webtransport-bun/comparison/keys/c/x.rig.pk8",
			},
			roleRoot: {
				fd: 10,
				label: "cohort-role-root",
				path: "/var/staged/<campaign>/roles",
			},
		},
	};
	const prefix = [
		"ssh",
		"-i",
		"/Users/x/.ssh/do_id_rsa",
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		"ConnectTimeout=10",
		"-T",
		"hermes-admin@10.99.0.2",
		"--",
	];

	it("without a crossing the uploaded wrapper runs as the ssh user", () => {
		const built = buildRigSshRunArgv(
			{ ...SAMPLE_OPTIONS, ...rig },
			"/tmp/ws-wt-rig-supervisor-wrapper.1",
		);
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect([...built.runArgv]).toEqual([
			...prefix,
			"bash",
			"/tmp/ws-wt-rig-supervisor-wrapper.1",
		]);
		expect(built.wrapperScript).not.toContain("cd /");
	});

	it("with a crossing the script is the argv of sudo … /bin/bash -c, quoted for the remote login shell, and nothing is uploaded", () => {
		const built = buildRigSshRunArgv(
			{
				...SAMPLE_OPTIONS,
				...rig,
				uidCrossing: { targetUser: "_wtcompare" },
			},
			"/tmp/never-uploaded",
		);
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		expect(built.runArgv.slice(0, prefix.length)).toEqual(prefix);
		expect(built.runArgv.slice(prefix.length, -1)).toEqual([
			"sudo",
			"-n",
			"-u",
			"_wtcompare",
			"/bin/bash",
			"-c",
		]);
		expect(built.runArgv).not.toContain("/tmp/never-uploaded");
		const quoted = built.runArgv.at(-1) as string;
		expect(quoted.startsWith("'")).toBe(true);
		expect(quoted.endsWith("'")).toBe(true);
		// The wrapper inside carries the crossing's own rows and the rig pair.
		expect(built.wrapperScript).toContain("cd /\numask 007\n");
		expect(built.wrapperScript).toContain("exec 3< <(/bin/cat -- ");
		expect(built.wrapperScript).toContain("--cohort-signing-key-fd 7");
		expect(built.wrapperScript).toContain("--cohort-role-root-fd 10");
	});

	it("executed: the remote login shell's parse of the joined command runs the same script byte for byte", () => {
		// ssh joins the remote argv with spaces and hands the string to the
		// login shell; `/bin/bash -c <that string>` is that parse. A stub in the
		// binary's slot echoes what reached it; the direct run is the oracle.
		const root = mkdtempSync(join(tmpdir(), "rig-ssh-run-"));
		const stub = join(root, "stub.sh");
		writeFileSync(
			stub,
			`#!/bin/bash
printf '%s\\n' "$PWD" "$(umask)" "$COMPARISON_SUPERVISOR_BUN_PATH" "$*" "$(/bin/cat <&7)"
`,
		);
		chmodSync(stub, 0o755);
		const keyPath = join(root, "it's the rig key.pk8");
		writeFileSync(keyPath, "rig key bytes\n");
		const roles = join(root, "roles");
		mkdirSync(roles);
		writeFileSync(join(root, "authority.json"), "{}\n");
		writeFileSync(join(root, "digest.bin"), "d\n");
		const built = buildRigSshRunArgv(
			{
				...SAMPLE_OPTIONS,
				bunExecutablePath: "/opt/rig/bun",
				rigBinaryPath: stub,
				rigPaths: {
					authorityFile: join(root, "authority.json"),
					authorityDigestFile: join(root, "digest.bin"),
					campaignRootDir: root,
					stagingRootDir: root,
				},
				sshTarget: rig.sshTarget,
				sshIdentity: rig.sshIdentity,
				rigCohort: {
					signingKey: { fd: 7, label: "cohort-signing-key", path: keyPath },
					roleRoot: { fd: 10, label: "cohort-role-root", path: roles },
				},
				uidCrossing: { targetUser: "_wtcompare" },
			},
			"/tmp/never-uploaded",
		);
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const sudoAt = built.runArgv.indexOf("sudo");
		// Everything after `sudo -n -u <user>` is what the target uid's shell
		// runs; this host has no `_wtcompare`, so the parse is exercised without
		// the account switch.
		const remoteCommand = built.runArgv.slice(sudoAt + 4).join(" ");
		const viaLoginShell = spawnSync("/bin/bash", ["-c", remoteCommand], {
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin" },
		});
		const direct = spawnSync("/bin/bash", ["-c", built.wrapperScript], {
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin" },
		});
		rmSync(root, { recursive: true, force: true });
		expect(viaLoginShell.status).toBe(0);
		expect(direct.status).toBe(0);
		expect(viaLoginShell.stdout).toBe(direct.stdout);
		const [cwd, umask, bun, flags, key] = viaLoginShell.stdout.split("\n");
		expect(cwd).toBe("/");
		expect(umask).toBe("0007");
		expect(bun).toBe("/opt/rig/bun");
		expect(flags).toBe(
			"--authority-fd 3 --authority-digest-fd 4 --campaign-root-fd 5 --staging-root-fd 6 --control-in-fd 0 --control-out-fd 1 --cohort-signing-key-fd 7 --cohort-role-root-fd 10",
		);
		expect(key).toBe("rig key bytes");
	});
});

describe("remote-supervisor: buildRigSshRunArgv with the rig's single Linux root (G3b)", () => {
	it("executed through the sudo form: the flags name one root and the staged directory is on 6", () => {
		const root = mkdtempSync(join(tmpdir(), "rig-ssh-single-root-"));
		const stub = join(root, "stub.sh");
		writeFileSync(
			stub,
			`#!/bin/bash
printf '%s\\n' "$*" "$(/bin/cat <&7)"
/bin/ls -di /dev/fd/6 >/dev/null 2>&1 && printf 'six-open\\n'
`,
		);
		chmodSync(stub, 0o755);
		const keyPath = join(root, "camp.rig.pk8");
		writeFileSync(keyPath, "rig key bytes\n");
		const roles = join(root, "roles");
		mkdirSync(roles);
		const staged = join(root, "stage");
		mkdirSync(staged);
		writeFileSync(join(staged, "authority.json"), "{}\n");
		writeFileSync(join(staged, "authority-digest.bin"), "d\n");
		const built = buildRigSshRunArgv(
			{
				...SAMPLE_OPTIONS,
				bunExecutablePath: "/opt/rig/bun",
				rigBinaryPath: stub,
				rigPaths: {
					authorityFile: join(staged, "authority.json"),
					authorityDigestFile: join(staged, "authority-digest.bin"),
					stagingRootDir: staged,
				},
				sshTarget: "hermes-admin@10.99.0.2",
				sshIdentity: "/Users/x/.ssh/do_id_rsa",
				rigCohort: {
					signingKey: { fd: 7, label: "cohort-signing-key", path: keyPath },
					roleRoot: { fd: 10, label: "cohort-role-root", path: roles },
				},
				uidCrossing: { targetUser: "_wtcompare" },
			},
			"/tmp/never-uploaded",
		);
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		const sudoAt = built.runArgv.indexOf("sudo");
		const remoteCommand = built.runArgv.slice(sudoAt + 4).join(" ");
		const ran = spawnSync("/bin/bash", ["-c", remoteCommand], {
			encoding: "utf8",
			env: { PATH: "/usr/bin:/bin" },
		});
		rmSync(root, { recursive: true, force: true });
		expect(ran.status).toBe(0);
		const [flags, key, six] = ran.stdout.split("\n");
		expect(flags).toBe(
			"--authority-fd 3 --authority-digest-fd 4 --staging-root-fd 6 --control-in-fd 0 --control-out-fd 1 --cohort-signing-key-fd 7 --cohort-role-root-fd 10",
		);
		expect(key).toBe("rig key bytes");
		expect(six).toBe("six-open");
		expect(built.wrapperScript).not.toContain("campaign");
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

// ---------------------------------------------------------------------------
// B3.5: the controller ↔ rig cohort channel
//
// Every test below drives the real codec against a scripted rig peer that
// speaks B1's exact bytes: nothing is stubbed at the parse boundary, so a
// refusal here is a refusal the wire would actually produce.
// ---------------------------------------------------------------------------

const RIG_EXECUTION_SHA256 = "1".repeat(64);
const RIG_HEX = (c: string) => c.repeat(64);

/** The byte length of the frame starting at offset 0, or null if incomplete. */
function framedLength(buffer: Uint8Array): number | null {
	if (buffer.byteLength < 4) return null;
	const view = new DataView(
		buffer.buffer,
		buffer.byteOffset,
		buffer.byteLength,
	);
	const headerLength = view.getUint32(0, false);
	if (buffer.byteLength < 4 + headerLength + 8) return null;
	const payloadLength = Number(view.getBigUint64(4 + headerLength, false));
	const total = 4 + headerLength + 8 + payloadLength + 32;
	return buffer.byteLength < total ? null : total;
}

type RigReply = Record<string, unknown> | "silence";

interface RigWire {
	readonly controllerToRig: PassThrough;
	readonly rigToController: PassThrough;
	readonly seen: Record<string, unknown>[];
}

/**
 * Attach a scripted rig to a pipe pair. `respond` sees the exact decoded
 * request payload and returns the exact payload the rig writes back.
 */
function serveScriptedRig(
	respond: (request: Record<string, unknown>) => RigReply,
): RigWire {
	const controllerToRig = new PassThrough();
	const rigToController = new PassThrough();
	const seen: Record<string, unknown>[] = [];
	let pending = new Uint8Array(0);
	controllerToRig.on("data", (chunk: Buffer) => {
		const merged = new Uint8Array(pending.byteLength + chunk.byteLength);
		merged.set(pending, 0);
		merged.set(new Uint8Array(chunk), pending.byteLength);
		pending = merged;
		for (;;) {
			const length = framedLength(pending);
			if (length === null) return;
			const frame = pending.slice(0, length);
			pending = pending.slice(length);
			const decoded = decodeRegisteredRemotePayload(frame);
			if (!decoded.ok) throw new Error(`scripted rig: ${decoded.code}`);
			seen.push(decoded.value.payload);
			const reply = respond(decoded.value.payload);
			if (reply === "silence") {
				rigToController.end();
				return;
			}
			const encoded = encodeRegisteredRemotePayload(
				reply as Record<string, unknown> & { schema: string },
			);
			if (!encoded.ok) throw new Error(`scripted rig encode: ${encoded.code}`);
			rigToController.write(Buffer.from(encoded.value));
		}
	});
	return { controllerToRig, rigToController, seen };
}

/** The Mac-side inputs the channel carries but never mints. */
const MAC_COHORT_GRANT_BYTES = bytesOfCanonical({
	schema: "cohort-grant/v1",
	executionSha256: RIG_EXECUTION_SHA256,
});
const MAC_COHORT_GRANT_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "cohort-grant/v1",
});
/** The Phase-A trio the channel carries on RIG_EXECUTION_ACCEPTED, never mints. */
const MAC_MEASUREMENT_GRANT_BYTES = bytesOfCanonical({
	schema: "measurement-grant/v1",
	runId: "rig-channel-run",
});
const MAC_EXECUTION_RECEIPT_BYTES = bytesOfCanonical({
	schema: "mac-execution-grant-receipt/v1",
	executionSha256: RIG_EXECUTION_SHA256,
	approvedPlanSha256: RIG_HEX("b"),
	approvalRecordSha256: RIG_HEX("c"),
	notAfterMs: 900_000,
});
const MAC_EXECUTION_RECEIPT_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "mac-execution-grant-receipt/v1",
});
const MAC_WARMUP_EPOCH_BYTES = bytesOfCanonical({
	schema: "cohort-warmup-epoch/v1",
	executionSha256: RIG_EXECUTION_SHA256,
});
const MAC_WARMUP_EPOCH_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "cohort-warmup-epoch/v1",
});
const MAC_MANIFEST_BYTES = bytesOfCanonical({
	schema: "role-warmup-completion-manifest/v1",
	executionSha256: RIG_EXECUTION_SHA256,
});
const MAC_MANIFEST_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "role-warmup-completion-manifest/v1",
});
const MAC_BARRIER_BYTES = bytesOfCanonical({
	schema: "cohort-start-barrier/v1",
	executionSha256: RIG_EXECUTION_SHA256,
});
const MAC_BARRIER_SIGNATURE_BYTES = bytesOfCanonical({
	schema: "mac-receipt-signature/v1",
	signedSchema: "cohort-start-barrier/v1",
});
/**
 * A real 14-key launch record under one stage profile: the channel copies
 * the record's own endpoint fields onto the spawn request, so a placeholder
 * record no longer reaches the wire.
 */
function stagedLaunchRecordBytes(
	profile: "phase-b" | "local-acceptance",
): Uint8Array {
	const host = profile === "phase-b" ? "10.99.0.2" : "127.0.0.1";
	return bytesOfCanonical({
		schema: "staged-server-launch-record/v1",
		stageReceiptSha256: RIG_HEX("1"),
		serverEntrypointSha256: RIG_HEX("4"),
		bunSha256: RIG_HEX("5"),
		addonSha256: RIG_HEX("6"),
		bindAddress: host,
		bindPort: 4433,
		advertisedHost: host,
		tlsServerName: "wt-compare.local",
		tlsCertificateSha256: RIG_HEX("2"),
		tlsPrivateKeySha256: RIG_HEX("3"),
		transport: "wt",
		argv: [
			"server.ts",
			"--transport=wt",
			"--mode=fanout-cohort",
			`--stage-profile=${profile}`,
			`--bind=${host}`,
		],
		allowedEnvironment: [{ name: "PATH", value: "/usr/bin" }],
	});
}
const STAGED_LAUNCH_RECORD_BYTES = stagedLaunchRecordBytes("phase-b");

const GRANT_SHA256 = sha256HexOfBytes(MAC_COHORT_GRANT_BYTES);
const GRANT_SIGNATURE_SHA256 = sha256HexOfBytes(
	MAC_COHORT_GRANT_SIGNATURE_BYTES,
);
const BARRIER_SHA256 = sha256HexOfBytes(MAC_BARRIER_BYTES);
const BARRIER_SIGNATURE_SHA256 = sha256HexOfBytes(MAC_BARRIER_SIGNATURE_BYTES);

const b64 = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64");

/**
 * An honest rig: it answers every request of the lifecycle with the records a
 * real rig supervisor would sign, using `keys` as its signing identity.
 */
function honestRig(keys: ReturnType<typeof generateEd25519KeyPair>) {
	let responseSeq = 0;
	const nonce = RIG_HEX("7");
	const drainedFrame = bytesOfCanonical({
		schema: "server-warmup-drained/v1",
		executionSha256: RIG_EXECUTION_SHA256,
	});
	const barrierAcceptedFrame = bytesOfCanonical({
		schema: "server-start-barrier-accepted/v1",
		executionSha256: RIG_EXECUTION_SHA256,
	});
	const snapshotFrame = bytesOfCanonical({
		schema: "server-snapshot/v1",
		executionSha256: RIG_EXECUTION_SHA256,
	});
	const observation = bytesOfCanonical({
		schema: "linux-relay-observation/v1",
		executionSha256: RIG_EXECUTION_SHA256,
	});
	let measureStartAckBytes: Uint8Array = bytesOfCanonical({});

	const sign = (
		signedSchema: Parameters<typeof signRigReceipt>[0]["signedSchema"],
		signedBytes: Uint8Array,
	) =>
		b64(
			bytesOfCanonical(
				signRigReceipt({
					privatePkcs8Der: keys.privatePkcs8Der,
					publicRaw32: keys.publicRaw32,
					signedSchema,
					signedBytes,
				}),
			),
		);

	return (request: Record<string, unknown>): RigReply => {
		const ackRequestSeq = request.requestSeq as number;
		const seq = responseSeq;
		responseSeq += 1;
		switch (request.schema) {
			case "rig-accept-execution-request/v1":
				return scriptedRigExecutionAcceptedAck({
					rigKeys: keys,
					request,
					executionSha256: RIG_EXECUTION_SHA256 as never,
					responseSeq: seq,
					nowMs: 1_000,
					instanceNonceSha256: nonce as never,
				});
			case "rig-accept-cohort-request/v1": {
				const acceptance = {
					schema: "rig-cohort-acceptance/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					cohortGrantSignatureSha256: GRANT_SIGNATURE_SHA256,
					roleTokenCommitmentRootSha256: RIG_HEX("a"),
					approvedPlanSha256: RIG_HEX("b"),
					approvalRecordSha256: RIG_HEX("c"),
					rigExecutionIndex: 0,
					rigSupervisorInstanceNonce: nonce,
					signingPublicKeySha256: keys.publicKeySha256,
					receiptSequence: 0,
					acceptedAtMs: 1_000,
					issuedAtMs: 1_000,
					notAfterMs: 900_000,
				};
				const bytes = bytesOfCanonical(acceptance);
				return {
					schema: "rig-cohort-accepted-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					rigCohortAcceptanceBase64: b64(bytes),
					rigCohortAcceptanceSignatureBase64: sign(
						"rig-cohort-acceptance/v1",
						bytes,
					),
				};
			}
			case "rig-spawn-server-request/v1":
				return {
					schema: "rig-server-ready-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					childPid: 9_001,
					childPgid: 9_001,
					childInstanceNonce: RIG_HEX("d"),
					serverReadyFrameSha256: RIG_HEX("e"),
				};
			case "rig-begin-warmup-request/v1":
				return {
					schema: "rig-warmup-ready-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					serverWarmupReadySha256: RIG_HEX("f"),
				};
			case "rig-finish-warmup-request/v1": {
				const receipt = {
					schema: "rig-warmup-drained-receipt/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					cohortWarmupEpochSha256: sha256HexOfBytes(MAC_WARMUP_EPOCH_BYTES),
					cohortWarmupEpochSignatureSha256: sha256HexOfBytes(
						MAC_WARMUP_EPOCH_SIGNATURE_BYTES,
					),
					roleWarmupCompletionManifestSha256:
						sha256HexOfBytes(MAC_MANIFEST_BYTES),
					roleWarmupCompletionManifestSignatureSha256: sha256HexOfBytes(
						MAC_MANIFEST_SIGNATURE_BYTES,
					),
					serverWarmupDrainedSha256: sha256HexOfBytes(drainedFrame),
					rigSupervisorInstanceNonce: nonce,
					signingPublicKeySha256: keys.publicKeySha256,
					receiptSequence: 1,
					receivedAtRigNs: "1700000000000000000",
					linuxClockId: RIG_HEX("2"),
					issuedAtMs: 2_000,
					notAfterMs: 900_000,
				};
				const bytes = bytesOfCanonical(receipt);
				return {
					schema: "rig-warmup-drained-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					serverWarmupDrainedBase64: b64(drainedFrame),
					serverWarmupDrainedSha256: sha256HexOfBytes(drainedFrame),
					serverWarmupDrainedSize: drainedFrame.byteLength,
					rigWarmupDrainedReceiptBase64: b64(bytes),
					rigWarmupDrainedReceiptSignatureBase64: sign(
						"rig-warmup-drained-receipt/v1",
						bytes,
					),
				};
			}
			case "rig-measure-start-request/v1": {
				const ack = {
					schema: "rig-measure-start-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					childResponseSequence: 0,
					baselineBusyMs: 0,
					baselineAtLinuxNs: "1700000000000000001",
					linuxClockId: RIG_HEX("2"),
					warmupCompletionAuthoritySha256: null,
					rigWarmupDrainedReceiptSha256:
						request.rigWarmupDrainedReceiptSha256 as string,
					signingPublicKeySha256: keys.publicKeySha256,
					rigSupervisorInstanceNonce: nonce,
					receiptSequence: 2,
					issuedAtMs: 3_000,
					notAfterMs: 900_000,
				};
				measureStartAckBytes = bytesOfCanonical(ack);
				return {
					schema: "rig-measure-started-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					rigMeasureStartAckBase64: b64(measureStartAckBytes),
					rigMeasureStartAckSignatureBase64: sign(
						"rig-measure-start-ack/v1",
						measureStartAckBytes,
					),
				};
			}
			case "rig-present-start-barrier-request/v1": {
				const acceptance = {
					schema: "rig-barrier-acceptance/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					cohortStartBarrierSha256: BARRIER_SHA256,
					cohortStartBarrierSignatureSha256: BARRIER_SIGNATURE_SHA256,
					rigMeasureStartAckSha256: sha256HexOfBytes(measureStartAckBytes),
					serverStartBarrierAcceptedSha256:
						sha256HexOfBytes(barrierAcceptedFrame),
					rigSupervisorInstanceNonce: nonce,
					signingPublicKeySha256: keys.publicKeySha256,
					receiptSequence: 3,
					acceptedAtLinuxNs: "1700000000000000002",
					linuxClockId: RIG_HEX("2"),
					issuedAtMs: 4_000,
					notAfterMs: 900_000,
				};
				const bytes = bytesOfCanonical(acceptance);
				return {
					schema: "rig-barrier-accepted-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					serverStartBarrierAcceptedBase64: b64(barrierAcceptedFrame),
					serverStartBarrierAcceptedSha256:
						sha256HexOfBytes(barrierAcceptedFrame),
					serverStartBarrierAcceptedSize: barrierAcceptedFrame.byteLength,
					rigBarrierAcceptanceBase64: b64(bytes),
					rigBarrierAcceptanceSignatureBase64: sign(
						"rig-barrier-acceptance/v1",
						bytes,
					),
				};
			}
			case "rig-stop-and-capture-request/v1": {
				const snapshotReceipt = {
					schema: "rig-server-snapshot-receipt/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					snapshotFrameSha256: sha256HexOfBytes(snapshotFrame),
				};
				const snapshotReceiptBytes = bytesOfCanonical(snapshotReceipt);
				// An ordinary A5 arm names no barrier and has no relay, so the
				// real rig answers its capture with the whole relay triple null
				// (`secure_fs.rs stop_and_capture`: the observation is
				// `Value::Null` when the child carried none). The scripted rig
				// answers the same way, so the ordinary path is not tested
				// against a cohort-shaped ack it could never receive.
				if (request.cohortStartBarrierSha256 === null) {
					return {
						schema: "rig-capture-complete-ack/v1",
						responseSeq: seq,
						ackRequestSeq,
						executionSha256: RIG_EXECUTION_SHA256,
						snapshotFrameBase64: b64(snapshotFrame),
						rigServerSnapshotReceiptBase64: b64(snapshotReceiptBytes),
						rigServerSnapshotReceiptSignatureBase64: sign(
							"rig-server-snapshot-receipt/v1",
							snapshotReceiptBytes,
						),
						linuxRelayObservationBase64: null,
						rigRelayObservationReceiptBase64: null,
						rigRelayObservationReceiptSignatureBase64: null,
					};
				}
				const relayReceipt = {
					schema: "rig-relay-observation-receipt/v1",
					executionSha256: RIG_EXECUTION_SHA256,
					cohortGrantSha256: GRANT_SHA256,
					cohortStartBarrierSha256: BARRIER_SHA256,
					linuxRelayObservationSha256: sha256HexOfBytes(observation),
					rigExecutionAcceptanceSha256: RIG_HEX("3"),
					rigSupervisorInstanceNonce: nonce,
					signingPublicKeySha256: keys.publicKeySha256,
					receiptSequence: 4,
					receivedAtRigNs: "1700000000000000003",
					issuedAtMs: 5_000,
					notAfterMs: 900_000,
				};
				const relayReceiptBytes = bytesOfCanonical(relayReceipt);
				return {
					schema: "rig-capture-complete-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					snapshotFrameBase64: b64(snapshotFrame),
					rigServerSnapshotReceiptBase64: b64(snapshotReceiptBytes),
					rigServerSnapshotReceiptSignatureBase64: sign(
						"rig-server-snapshot-receipt/v1",
						snapshotReceiptBytes,
					),
					linuxRelayObservationBase64: b64(observation),
					rigRelayObservationReceiptBase64: b64(relayReceiptBytes),
					rigRelayObservationReceiptSignatureBase64: sign(
						"rig-relay-observation-receipt/v1",
						relayReceiptBytes,
					),
				};
			}
			case "rig-teardown-server-request/v1":
				return {
					schema: "rig-server-stopped-ack/v1",
					responseSeq: seq,
					ackRequestSeq,
					executionSha256: RIG_EXECUTION_SHA256,
					exitCode: 0,
					signal: null,
					reaped: true,
				};
			default:
				throw new Error(`scripted rig got ${String(request.schema)}`);
		}
	};
}

const RIG_DEADLINES = {
	frameMs: 5_000,
	serverReadyMs: 15_000,
	warmupDrainMs: 6_000,
	captureMs: 15_000,
	teardownMs: 10_000,
};

function channelFor(
	wire: RigWire,
	stagedRigPublicRaw32: Uint8Array,
): CohortRigChannel {
	return new CohortRigChannel({
		controllerToRig: wire.controllerToRig,
		rigToController: wire.rigToController,
		childDiagnostics: undefined,
		executionSha256: RIG_EXECUTION_SHA256,
		stagedRigPublicRaw32,
		deadlines: RIG_DEADLINES,
	});
}

const SPAWN_REQUEST = {
	cohortGrantSha256: GRANT_SHA256,
	serverEntrypointSha256: RIG_HEX("4"),
	bunSha256: RIG_HEX("5"),
	addonSha256: RIG_HEX("6"),
	stagedServerLaunchRecordBytes: STAGED_LAUNCH_RECORD_BYTES,
	bindPort: 4433,
	transport: "wt",
	serverArgv: ["server.ts", "--transport=wt", "--mode=fanout-cohort"],
} as const;

/** Walk the whole lifecycle; every step must be ok or the test says which. */
async function acceptExecutionOn(channel: CohortRigChannel) {
	return channel.acceptExecution({
		measurementGrantBytes: MAC_MEASUREMENT_GRANT_BYTES,
		receiptBytes: MAC_EXECUTION_RECEIPT_BYTES,
		receiptSignatureBytes: MAC_EXECUTION_RECEIPT_SIGNATURE_BYTES,
	});
}

async function runLifecycle(channel: CohortRigChannel) {
	const executionAccepted = await acceptExecutionOn(channel);
	if (!executionAccepted.ok)
		return { at: "acceptExecution", result: executionAccepted } as const;
	const accepted = await channel.acceptCohort({
		cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
		cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
	});
	if (!accepted.ok) return { at: "acceptCohort", result: accepted } as const;
	const spawned = await channel.spawnServer(SPAWN_REQUEST);
	if (!spawned.ok) return { at: "spawnServer", result: spawned } as const;
	const begun = await channel.beginWarmup({
		cohortWarmupEpochBytes: MAC_WARMUP_EPOCH_BYTES,
		cohortWarmupEpochSignatureBytes: MAC_WARMUP_EPOCH_SIGNATURE_BYTES,
	});
	if (!begun.ok) return { at: "beginWarmup", result: begun } as const;
	const drained = await channel.finishWarmup({
		cohortWarmupEpochBytes: MAC_WARMUP_EPOCH_BYTES,
		cohortWarmupEpochSignatureBytes: MAC_WARMUP_EPOCH_SIGNATURE_BYTES,
		roleWarmupCompletionManifestBytes: MAC_MANIFEST_BYTES,
		roleWarmupCompletionManifestSignatureBytes: MAC_MANIFEST_SIGNATURE_BYTES,
	});
	if (!drained.ok) return { at: "finishWarmup", result: drained } as const;
	const baseline = await channel.measureStart({
		warmupCompleteSha256: null,
		rigWarmupDrainedReceiptSha256: sha256HexOfBytes(drained.value.receiptBytes),
	});
	if (!baseline.ok) return { at: "measureStart", result: baseline } as const;
	const barrier = await channel.presentStartBarrier({
		cohortStartBarrierBytes: MAC_BARRIER_BYTES,
		cohortStartBarrierSignatureBytes: MAC_BARRIER_SIGNATURE_BYTES,
	});
	if (!barrier.ok) {
		return { at: "presentStartBarrier", result: barrier } as const;
	}
	const captured = await channel.stopAndCapture({
		macStopIssuedAtNs: "1700000000000000009",
		drainDeadlineMs: 10_000,
	});
	if (!captured.ok) return { at: "stopAndCapture", result: captured } as const;
	return {
		at: "complete",
		result: { ok: true as const },
		accepted,
		drained,
		baseline,
		barrier,
		captured,
	} as const;
}

/** Re-sign a barrier acceptance after patching it, as a real rig would. */
function resignBarrierAcceptance(
	keys: ReturnType<typeof generateEd25519KeyPair>,
	reply: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const record = JSON.parse(
		Buffer.from(reply.rigBarrierAcceptanceBase64 as string, "base64").toString(
			"utf8",
		),
	);
	Object.assign(record, patch);
	const bytes = bytesOfCanonical(record);
	return {
		rigBarrierAcceptanceBase64: b64(bytes),
		rigBarrierAcceptanceSignatureBase64: b64(
			bytesOfCanonical(
				signRigReceipt({
					privatePkcs8Der: keys.privatePkcs8Der,
					publicRaw32: keys.publicRaw32,
					signedSchema: "rig-barrier-acceptance/v1",
					signedBytes: bytes,
				}),
			),
		),
	};
}

describe("remote-supervisor: CohortRigChannel RIG_EXECUTION_ACCEPTED", () => {
	it("accepts_the_execution_first_and_refuses_a_cohort_before_it", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const early = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(early.ok).toBe(false);
		if (early.ok) throw new Error("unreachable");
		expect(early.code).toBe("COHORT_NOT_READY");
		expect(wire.seen).toEqual([]);

		const accepted = await acceptExecutionOn(channel);
		if (!accepted.ok) throw new Error(`${accepted.code}: ${accepted.message}`);
		expect(channel.stage).toBe("execution-accepted");
		expect(accepted.value.acceptance.executionSha256).toBe(
			RIG_EXECUTION_SHA256,
		);
		expect(accepted.value.acceptance.measurementGrantSha256).toBe(
			sha256HexOfBytes(MAC_MEASUREMENT_GRANT_BYTES),
		);
		expect(accepted.value.acceptance.macExecutionGrantReceiptSha256).toBe(
			sha256HexOfBytes(MAC_EXECUTION_RECEIPT_BYTES),
		);
		expect(accepted.value.acceptance.macReceiptSignatureSha256).toBe(
			sha256HexOfBytes(MAC_EXECUTION_RECEIPT_SIGNATURE_BYTES),
		);
		expect(accepted.value.signature.signedSchema).toBe(
			"rig-execution-acceptance/v1",
		);
		// Once, per execution.
		const again = await acceptExecutionOn(channel);
		expect(again.ok).toBe(false);
	});

	it("refuses_an_acceptance_signed_by_a_key_that_is_not_the_staged_rig_key", async () => {
		const keys = generateEd25519KeyPair();
		const other = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(other));
		const channel = channelFor(wire, keys.publicRaw32);
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		if (accepted.ok) throw new Error("unreachable");
		expect(accepted.code).toBe("RIG_SIGNING_KEY_MISMATCH");
		expect(channel.stage).toBe("opened");
		expect(channel.executionAcceptance).toBeNull();
	});

	it("refuses_an_acceptance_that_names_another_grant_receipt_or_execution", async () => {
		for (const [field, value] of [
			["measurementGrantSha256", RIG_HEX("9")],
			["macExecutionGrantReceiptSha256", RIG_HEX("9")],
			["macReceiptSignatureSha256", RIG_HEX("9")],
			["executionSha256", RIG_HEX("2")],
		] as const) {
			const keys = generateEd25519KeyPair();
			const wire = serveScriptedRig((request) =>
				scriptedRigExecutionAcceptedAck({
					rigKeys: keys,
					request,
					executionSha256: RIG_EXECUTION_SHA256 as never,
					responseSeq: 0,
					nowMs: 1_000,
					mutate: (acceptance) => {
						acceptance[field] = value;
					},
				}),
			);
			const channel = channelFor(wire, keys.publicRaw32);
			const accepted = await acceptExecutionOn(channel);
			expect(accepted.ok).toBe(false);
			if (accepted.ok) throw new Error("unreachable");
			expect(accepted.code).toBe("CROSS_SUPERVISOR_MISMATCH");
			expect(channel.executionAcceptance).toBeNull();
		}
	});

	it("refuses_an_acceptance_whose_bytes_were_tampered_after_signing", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-execution-accepted-ack/v1"
			) {
				const bytes = Buffer.from(
					reply.rigExecutionAcceptanceBase64 as string,
					"base64",
				);
				const record = JSON.parse(bytes.toString("utf8"));
				record.rigExecutionIndex = 9;
				return {
					...reply,
					rigExecutionAcceptanceBase64: b64(bytesOfCanonical(record)),
				};
			}
			return reply;
		});
		const channel = channelFor(wire, keys.publicRaw32);
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		if (accepted.ok) throw new Error("unreachable");
		expect(accepted.code).toBe("RIG_RECEIPT_SIGNATURE_INVALID");
	});
});

describe("remote-supervisor: CohortRigChannel", () => {
	it("round_trips_every_cohort_frame_against_a_scripted_rig", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const walked = await runLifecycle(channel);
		if (walked.at !== "complete") {
			throw new Error(
				`${walked.at}: ${(walked.result as { code?: string; message?: string }).code} ${(walked.result as { message?: string }).message}`,
			);
		}
		expect(channel.stage).toBe("captured");
		expect(channel.cohortGrantSha256).toBe(GRANT_SHA256);
		expect(wire.seen.map((frame) => frame.schema)).toEqual([
			"rig-accept-execution-request/v1",
			"rig-accept-cohort-request/v1",
			"rig-spawn-server-request/v1",
			"rig-begin-warmup-request/v1",
			"rig-finish-warmup-request/v1",
			"rig-measure-start-request/v1",
			"rig-present-start-barrier-request/v1",
			"rig-stop-and-capture-request/v1",
		]);
		// The grant travels as the exact Mac bytes, not a controller rebuild.
		expect(wire.seen[1]?.cohortGrantBase64).toBe(b64(MAC_COHORT_GRANT_BYTES));
		// And the cohort accept carries exactly the acceptance the rig answered
		// RIG_EXECUTION_ACCEPTED with -- the channel's retained bytes, not a
		// record the caller supplied.
		const retained = channel.executionAcceptance;
		expect(retained).not.toBeNull();
		expect(wire.seen[1]?.rigExecutionAcceptanceBase64).toBe(
			b64(retained?.acceptanceBytes ?? new Uint8Array()),
		);
		expect(wire.seen[1]?.rigExecutionAcceptanceSignatureBase64).toBe(
			b64(retained?.signatureBytes ?? new Uint8Array()),
		);
		// The Phase-A trio went out as the exact bytes handed in.
		expect(wire.seen[0]?.measurementGrantBase64).toBe(
			b64(MAC_MEASUREMENT_GRANT_BYTES),
		);
		expect(wire.seen[0]?.macExecutionGrantReceiptBase64).toBe(
			b64(MAC_EXECUTION_RECEIPT_BYTES),
		);
		expect(walked.captured.value.relayObservationReceipt).not.toBeNull();
	});

	it("refuses_a_receipt_whose_bytes_were_tampered_after_signing", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-cohort-accepted-ack/v1"
			) {
				const bytes = Buffer.from(
					reply.rigCohortAcceptanceBase64 as string,
					"base64",
				);
				const record = JSON.parse(bytes.toString("utf8"));
				record.rigExecutionIndex = 9;
				return {
					...reply,
					rigCohortAcceptanceBase64: b64(bytesOfCanonical(record)),
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("acceptCohort");
		expect((walked.result as { code: string }).code).toBe(
			"RIG_RECEIPT_SIGNATURE_INVALID",
		);
	});

	it("refuses_an_unsigned_receipt", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply !== "silence" && reply.schema === "rig-warmup-drained-ack/v1") {
				return {
					...reply,
					rigWarmupDrainedReceiptSignatureBase64: b64(
						bytesOfCanonical({ schema: "not-a-signature/v1" }),
					),
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("finishWarmup");
		expect((walked.result as { code: string }).code).toBe("TRUST_PROTOCOL");
	});

	it("refuses_a_receipt_signed_by_a_key_the_campaign_did_not_stage", async () => {
		const keys = generateEd25519KeyPair();
		const staged = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const walked = await runLifecycle(channelFor(wire, staged.publicRaw32));
		// The first signed record on the channel is the execution acceptance.
		expect(walked.at).toBe("acceptExecution");
		expect((walked.result as { code: string }).code).toBe(
			"RIG_SIGNING_KEY_MISMATCH",
		);
	});

	it("refuses_a_genuine_signature_replayed_over_another_record_slot", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		let firstAcceptanceSignature: string | null = null;
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply === "silence") return reply;
			if (reply.schema === "rig-cohort-accepted-ack/v1") {
				firstAcceptanceSignature =
					reply.rigCohortAcceptanceSignatureBase64 as string;
			}
			if (
				reply.schema === "rig-warmup-drained-ack/v1" &&
				firstAcceptanceSignature !== null
			) {
				// A real, verifiable rig signature -- over the wrong record.
				return {
					...reply,
					rigWarmupDrainedReceiptSignatureBase64: firstAcceptanceSignature,
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("finishWarmup");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_the_same_signed_record_presented_twice_on_one_channel", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		let firstAcceptance: Record<string, unknown> | null = null;
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply === "silence") return reply;
			if (reply.schema === "rig-cohort-accepted-ack/v1") {
				if (firstAcceptance === null) firstAcceptance = reply;
			}
			return reply;
		});
		const channel = channelFor(wire, keys.publicRaw32);
		const executionAccepted = await acceptExecutionOn(channel);
		expect(executionAccepted.ok).toBe(true);
		const first = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(first.ok).toBe(true);
		const second = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(second.ok).toBe(false);
		if (second.ok) return;
		// The stage guard fires before the wire does: a second accept is not a
		// replay to be detected downstream, it is not a legal request at all.
		expect(second.code).toBe("COHORT_NOT_READY");
	});

	it("refuses_an_ack_whose_response_sequence_does_not_echo_the_request", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply === "silence") return reply;
			if (reply.schema === "rig-warmup-ready-ack/v1") {
				return { ...reply, ackRequestSeq: 0, responseSeq: 0 };
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("beginWarmup");
		expect((walked.result as { code: string }).code).toBe("TRUST_PROTOCOL");
	});

	it("refuses_an_ack_of_the_wrong_kind", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			if (request.schema === "rig-begin-warmup-request/v1") {
				return {
					schema: "rig-server-ready-ack/v1",
					responseSeq: 2,
					ackRequestSeq: request.requestSeq as number,
					executionSha256: RIG_EXECUTION_SHA256,
					childPid: 1,
					childPgid: 1,
					childInstanceNonce: RIG_HEX("d"),
					serverReadyFrameSha256: RIG_HEX("e"),
				};
			}
			return honest(request);
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("beginWarmup");
		expect((walked.result as { message: string }).message).toContain(
			"expected rig-warmup-ready-ack/v1",
		);
	});

	it("refuses_an_ack_that_names_another_execution", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (reply === "silence") return reply;
			if (reply.schema === "rig-server-ready-ack/v1") {
				return { ...reply, executionSha256: RIG_HEX("9") };
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("spawnServer");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_an_acceptance_bound_to_a_grant_this_channel_did_not_send", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-cohort-accepted-ack/v1"
			) {
				return { ...reply, cohortGrantSha256: RIG_HEX("8") };
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("acceptCohort");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_an_acceptance_joined_to_another_grant_or_grant_signature", async () => {
		for (const field of [
			"executionSha256",
			"cohortGrantSha256",
			"cohortGrantSignatureSha256",
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-cohort-accepted-ack/v1"
				) {
					return reply;
				}
				// A genuinely rig-signed acceptance -- of a different grant. Only
				// the join to the bytes this channel sent catches it.
				const record = JSON.parse(
					Buffer.from(
						reply.rigCohortAcceptanceBase64 as string,
						"base64",
					).toString("utf8"),
				);
				record[field] = RIG_HEX("0");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					rigCohortAcceptanceBase64: b64(bytes),
					rigCohortAcceptanceSignatureBase64: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: "rig-cohort-acceptance/v1",
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("acceptCohort");
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_a_warmup_receipt_joined_to_records_this_channel_did_not_send", async () => {
		for (const field of [
			"cohortGrantSha256",
			"serverWarmupDrainedSha256",
			"cohortWarmupEpochSha256",
			"cohortWarmupEpochSignatureSha256",
			"roleWarmupCompletionManifestSha256",
			"roleWarmupCompletionManifestSignatureSha256",
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-warmup-drained-ack/v1"
				) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(
						reply.rigWarmupDrainedReceiptBase64 as string,
						"base64",
					).toString("utf8"),
				);
				record[field] = RIG_HEX("0");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					rigWarmupDrainedReceiptBase64: b64(bytes),
					rigWarmupDrainedReceiptSignatureBase64: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: "rig-warmup-drained-receipt/v1",
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("finishWarmup");
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_an_ack_whose_declared_digest_or_size_is_not_the_frame_it_carried", async () => {
		for (const patch of [
			{ serverWarmupDrainedSha256: RIG_HEX("0") },
			{ serverWarmupDrainedSize: 9_999 },
		]) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-warmup-drained-ack/v1"
				) {
					return reply;
				}
				return { ...reply, ...patch };
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("finishWarmup");
			expect((walked.result as { message: string }).message).toContain(
				"is not the frame it carried",
			);
		}
	});

	it("refuses_a_measure_start_ack_naming_another_drained_receipt", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			if (request.schema === "rig-measure-start-request/v1") {
				return honest({
					...request,
					rigWarmupDrainedReceiptSha256: RIG_HEX("0"),
				});
			}
			return honest(request);
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("measureStart");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_a_barrier_acceptance_naming_another_measure_start_ack", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-barrier-accepted-ack/v1"
			) {
				const record = JSON.parse(
					Buffer.from(
						reply.rigBarrierAcceptanceBase64 as string,
						"base64",
					).toString("utf8"),
				);
				record.rigMeasureStartAckSha256 = RIG_HEX("0");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					rigBarrierAcceptanceBase64: b64(bytes),
					rigBarrierAcceptanceSignatureBase64: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: "rig-barrier-acceptance/v1",
								signedBytes: bytes,
							}),
						),
					),
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("presentStartBarrier");
		expect((walked.result as { code: string }).code).toBe(
			"CROSS_SUPERVISOR_MISMATCH",
		);
	});

	it("refuses_a_barrier_ack_whose_declared_digest_or_size_is_not_its_frame", async () => {
		for (const patch of [
			{ serverStartBarrierAcceptedSha256: RIG_HEX("0") },
			{ serverStartBarrierAcceptedSize: 9_999 },
		]) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-barrier-accepted-ack/v1"
				) {
					return reply;
				}
				return { ...reply, ...patch };
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("presentStartBarrier");
			expect((walked.result as { message: string }).message).toContain(
				"is not the frame it carried",
			);
		}
	});

	it("refuses_a_barrier_acceptance_joined_to_records_this_channel_did_not_send", async () => {
		for (const field of [
			"serverStartBarrierAcceptedSha256",
			"cohortStartBarrierSha256",
			"cohortStartBarrierSignatureSha256",
			"cohortGrantSha256",
		]) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-barrier-accepted-ack/v1"
				) {
					return reply;
				}
				return {
					...reply,
					...resignBarrierAcceptance(keys, reply, { [field]: RIG_HEX("0") }),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("presentStartBarrier");
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_a_relay_receipt_joined_to_another_execution_cohort_or_barrier", async () => {
		for (const field of [
			"executionSha256",
			"cohortGrantSha256",
			"cohortStartBarrierSha256",
		]) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					reply === "silence" ||
					reply.schema !== "rig-capture-complete-ack/v1"
				) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(
						reply.rigRelayObservationReceiptBase64 as string,
						"base64",
					).toString("utf8"),
				);
				record[field] = RIG_HEX("0");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					rigRelayObservationReceiptBase64: b64(bytes),
					rigRelayObservationReceiptSignatureBase64: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: "rig-relay-observation-receipt/v1",
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe("stopAndCapture");
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_an_oversize_measure_start_ack_or_relay_observation", async () => {
		for (const slot of [
			{
				ackSchema: "rig-measure-started-ack/v1",
				field: "rigMeasureStartAckBase64",
				at: "measureStart",
				pad: 40_000,
				expected: "rig measure-start ack exceeds its cap",
			},
			{
				ackSchema: "rig-capture-complete-ack/v1",
				field: "linuxRelayObservationBase64",
				at: "stopAndCapture",
				pad: 200_000,
				expected: "linux relay observation exceeds its cap",
			},
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (reply === "silence" || reply.schema !== slot.ackSchema) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(reply[slot.field] as string, "base64").toString("utf8"),
				);
				record.padding = "p".repeat(slot.pad);
				return { ...reply, [slot.field]: b64(bytesOfCanonical(record)) };
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe(slot.at);
			expect((walked.result as { message: string }).message).toContain(
				slot.expected,
			);
		}
	});

	it("refuses_a_carried_record_that_is_not_the_schema_its_slot_expects", async () => {
		for (const slot of [
			{
				ackSchema: "rig-measure-started-ack/v1",
				field: "rigMeasureStartAckBase64",
				signedSchema: "rig-measure-start-ack/v1",
				at: "measureStart",
			},
			{
				ackSchema: "rig-capture-complete-ack/v1",
				field: "rigServerSnapshotReceiptBase64",
				signedSchema: "rig-server-snapshot-receipt/v1",
				at: "stopAndCapture",
			},
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (reply === "silence" || reply.schema !== slot.ackSchema) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(reply[slot.field] as string, "base64").toString("utf8"),
				);
				record.schema = "some-other-record/v1";
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					[slot.field]: b64(bytes),
					[`${slot.field.slice(0, -6)}SignatureBase64`]: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: slot.signedSchema,
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe(slot.at);
			expect((walked.result as { message: string }).message).toContain(
				"carried record is not",
			);
		}
	});

	it("refuses_a_carried_record_that_names_another_execution", async () => {
		for (const slot of [
			{
				ackSchema: "rig-measure-started-ack/v1",
				field: "rigMeasureStartAckBase64",
				signatureField: "rigMeasureStartAckSignatureBase64",
				signedSchema: "rig-measure-start-ack/v1",
				at: "measureStart",
			},
			{
				ackSchema: "rig-capture-complete-ack/v1",
				field: "rigServerSnapshotReceiptBase64",
				signatureField: "rigServerSnapshotReceiptSignatureBase64",
				signedSchema: "rig-server-snapshot-receipt/v1",
				at: "stopAndCapture",
			},
		] as const) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (reply === "silence" || reply.schema !== slot.ackSchema) {
					return reply;
				}
				const record = JSON.parse(
					Buffer.from(reply[slot.field] as string, "base64").toString("utf8"),
				);
				record.executionSha256 = RIG_HEX("9");
				const bytes = bytesOfCanonical(record);
				return {
					...reply,
					[slot.field]: b64(bytes),
					[slot.signatureField]: b64(
						bytesOfCanonical(
							signRigReceipt({
								privatePkcs8Der: keys.privatePkcs8Der,
								publicRaw32: keys.publicRaw32,
								signedSchema: slot.signedSchema,
								signedBytes: bytes,
							}),
						),
					),
				};
			});
			const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
			expect(walked.at).toBe(slot.at);
			expect((walked.result as { code: string }).code).toBe(
				"CROSS_SUPERVISOR_MISMATCH",
			);
		}
	});

	it("refuses_a_relay_receipt_that_does_not_cover_the_observation_it_came_with", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply === "silence" ||
				reply.schema !== "rig-capture-complete-ack/v1"
			) {
				return reply;
			}
			const record = JSON.parse(
				Buffer.from(
					reply.rigRelayObservationReceiptBase64 as string,
					"base64",
				).toString("utf8"),
			);
			record.linuxRelayObservationSha256 = RIG_HEX("0");
			const bytes = bytesOfCanonical(record);
			return {
				...reply,
				rigRelayObservationReceiptBase64: b64(bytes),
				rigRelayObservationReceiptSignatureBase64: b64(
					bytesOfCanonical(
						signRigReceipt({
							privatePkcs8Der: keys.privatePkcs8Der,
							publicRaw32: keys.publicRaw32,
							signedSchema: "rig-relay-observation-receipt/v1",
							signedBytes: bytes,
						}),
					),
				),
			};
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("stopAndCapture");
		expect((walked.result as { message: string }).message).toContain(
			"does not cover the observation",
		);
	});

	it("refuses_a_half_present_relay_observation_triple", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-capture-complete-ack/v1"
			) {
				return { ...reply, rigRelayObservationReceiptSignatureBase64: null };
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("stopAndCapture");
		expect((walked.result as { message: string }).message).toContain(
			"wholly present nor wholly absent",
		);
	});

	it("refuses_a_lifecycle_step_taken_out_of_order", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const early = await channel.spawnServer(SPAWN_REQUEST);
		expect(early.ok).toBe(false);
		if (early.ok) return;
		expect(early.code).toBe("COHORT_NOT_READY");
		expect(wire.seen).toHaveLength(0);
	});

	it("refuses_a_spawn_naming_a_grant_this_channel_did_not_deliver", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const executionAccepted = await acceptExecutionOn(channel);
		expect(executionAccepted.ok).toBe(true);
		const accepted = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(accepted.ok).toBe(true);
		const spawned = await channel.spawnServer({
			...SPAWN_REQUEST,
			cohortGrantSha256: RIG_HEX("7"),
		});
		expect(spawned.ok).toBe(false);
		if (spawned.ok) return;
		expect(spawned.code).toBe("CROSS_SUPERVISOR_MISMATCH");
		expect(wire.seen).toHaveLength(2);
	});

	it("the_spawn_request_states_the_carried_records_own_endpoint", async () => {
		// Design §3.1: the local-acceptance profile runs on loopback, the
		// physical profiles on 10.99.0.2. The request restates whichever the
		// carried record froze -- never a literal of its own.
		for (const [profile, host] of [
			["local-acceptance", "127.0.0.1"],
			["phase-b", "10.99.0.2"],
		] as const) {
			const keys = generateEd25519KeyPair();
			const wire = serveScriptedRig(honestRig(keys));
			const channel = channelFor(wire, keys.publicRaw32);
			expect((await acceptExecutionOn(channel)).ok).toBe(true);
			const accepted = await channel.acceptCohort({
				cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
				cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
			});
			expect(accepted.ok).toBe(true);
			const spawned = await channel.spawnServer({
				...SPAWN_REQUEST,
				stagedServerLaunchRecordBytes: stagedLaunchRecordBytes(profile),
			});
			expect(spawned.ok).toBe(true);
			const frame = wire.seen[2] as Record<string, unknown>;
			expect(frame.schema).toBe("rig-spawn-server-request/v1");
			expect(frame.bindAddress).toBe(host);
			expect(frame.advertisedHost).toBe(host);
			expect(frame.tlsServerName).toBe("wt-compare.local");
		}

		// A record that is not the closed 14-key shape never reaches the wire.
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		expect((await acceptExecutionOn(channel)).ok).toBe(true);
		const accepted = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(accepted.ok).toBe(true);
		const placeholder = await channel.spawnServer({
			...SPAWN_REQUEST,
			stagedServerLaunchRecordBytes: bytesOfCanonical({
				schema: "staged-server-launch-record/v1",
				bindPort: 4433,
			}),
		});
		expect(placeholder.ok).toBe(false);
		if (placeholder.ok) return;
		expect(placeholder.code).toBe("COHORT_PROTOCOL");
		expect(placeholder.message).toContain("staged launch record");
		expect(wire.seen).toHaveLength(2);
	});

	it("surfaces_a_typed_remote_refusal_instead_of_a_frame_error", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig((request) => ({
			schema: "remote-supervisor-refusal/v1",
			responseSeq: 0,
			ackRequestSeq: request.requestSeq as number,
			executionSha256: RIG_EXECUTION_SHA256,
			code: "TRUST_PROTOCOL",
			detail: null,
			campaignStatus: "FAIL",
			terminal: true,
		}));
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("acceptExecution");
		expect((walked.result as { code: string }).code).toBe("TRUST_PROTOCOL");
		expect((walked.result as { message: string }).message).toContain(
			"rig refused rig-accept-execution-request/v1",
		);
	});

	// B3.5 residual 2. The rig speaks two refusal vocabularies, and only one of
	// them was understood. A refused *transition* answers in the frozen
	// `remote-supervisor-refusal/v1` shape (the test above); a protocol
	// violation goes out through the binary's `terminate`, which writes the
	// Phase-A `admission-refusal` frame carrying `measurement-refusal/v1`. That
	// kind is not a registered remote kind, so the channel handed it to
	// `decodeRegisteredRemotePayload` and reported "unregistered remote kind"
	// over the top of whatever the rig was trying to say.
	function serveRawRefusal(code: string): RigWire {
		const controllerToRig = new PassThrough();
		const rigToController = new PassThrough();
		const seen: Record<string, unknown>[] = [];
		controllerToRig.on("data", () => {
			const framed = encodeSupervisorFrame(
				new TextEncoder().encode(
					`${JSON.stringify({
						kind: "admission-refusal",
						schema: "comparison-supervisor-frame/v1",
					})}\n`,
				),
				new TextEncoder().encode(
					`{"code":"${code}","schema":"measurement-refusal/v1"}\n`,
				),
				65_536,
			);
			if (!framed.ok) throw new Error("the refusal frame did not encode");
			rigToController.write(Buffer.from(framed.value));
		});
		return { controllerToRig, rigToController, seen };
	}

	it("reports_the_rigs_own_code_out_of_the_phase_a_refusal_shape", async () => {
		const keys = generateEd25519KeyPair();
		const channel = channelFor(
			serveRawRefusal("COHORT_NOT_READY"),
			keys.publicRaw32,
		);
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		if (accepted.ok) return;
		expect(accepted.code).toBe("COHORT_NOT_READY");
		expect(accepted.message).toContain(
			"rig refused rig-accept-execution-request/v1 with COHORT_NOT_READY",
		);
		// The failure this replaces: a decode complaint about the frame kind.
		expect(accepted.message).not.toContain("unregistered remote kind");
	});

	it("maps_the_supervisors_own_trust_record_codes_onto_the_section_7_set", async () => {
		// The `TRUST_RECORD_*` / `TRUST_CHILD_*` family is the supervisor's own
		// and §7 does not publish it. §7's row for "malformed, unknown-key,
		// oversize, sequence, EOF, digest, cross-run/transport/cohort protocol"
		// is `FAIL/TRUST_PROTOCOL`, so that is where they land -- with the rig's
		// exact literal kept in the message, which is the part an operator needs.
		const keys = generateEd25519KeyPair();
		const channel = channelFor(
			serveRawRefusal("TRUST_CHILD_FRAME_INVALID"),
			keys.publicRaw32,
		);
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		if (accepted.ok) return;
		expect(accepted.code).toBe("TRUST_PROTOCOL");
		expect(accepted.message).toContain("TRUST_CHILD_FRAME_INVALID");
	});

	it("every_code_the_rig_can_emit_maps_into_the_closed_section_7_set", () => {
		for (const code of [
			"TRUST_RECORD_MALFORMED",
			"TRUST_RECORD_DUPLICATE_FIELD",
			"TRUST_RECORD_UNKNOWN_FIELD",
			"TRUST_RECORD_MISSING_FIELD",
			"TRUST_RECORD_SCHEMA_INVALID",
			"TRUST_RECORD_BINDING_MISMATCH",
			"TRUST_CHILD_FRAME_INVALID",
			"FRAME_SESSION_LIMIT",
		]) {
			expect(mapRigRefusalCodeToIndexCode(code)).toBe("TRUST_PROTOCOL");
		}
		// The codes `CohortRefusal::code` already publishes as §7 literals pass
		// through unchanged rather than being flattened onto TRUST_PROTOCOL.
		for (const code of [
			"COHORT_NOT_READY",
			"COHORT_PROTOCOL",
			"WARMUP_PROTOCOL",
			"MEASUREMENT_WINDOW",
			"RELAY_DELIVERY",
			"CHILD_LIFECYCLE",
			"MAC_GRANT_SIGNATURE_INVALID",
			"MAC_SIGNING_KEY_MISMATCH",
		] as const) {
			expect(mapRigRefusalCodeToIndexCode(code)).toBe(code);
		}
	});

	it("refuses_eof_before_the_ack_rather_than_waiting_out_the_deadline", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(() => "silence");
		const channel = channelFor(wire, keys.publicRaw32);
		const started = Date.now();
		const accepted = await acceptExecutionOn(channel);
		expect(accepted.ok).toBe(false);
		expect(Date.now() - started).toBeLessThan(RIG_DEADLINES.frameMs);
		if (accepted.ok) return;
		expect(accepted.code).toBe("COHORT_PROTOCOL");
	});

	it("rejects_a_staged_launch_record_over_the_64KiB_spawn_cap", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const executionAccepted = await acceptExecutionOn(channel);
		expect(executionAccepted.ok).toBe(true);
		const accepted = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		expect(accepted.ok).toBe(true);
		const spawned = await channel.spawnServer({
			...SPAWN_REQUEST,
			stagedServerLaunchRecordBytes: new Uint8Array(65_537),
		});
		expect(spawned.ok).toBe(false);
		if (spawned.ok) return;
		expect(spawned.message).toContain("64 KiB spawn cap");
	});

	it("refuses_a_non_canonically_encoded_carried_record", async () => {
		const keys = generateEd25519KeyPair();
		const honest = honestRig(keys);
		const wire = serveScriptedRig((request) => {
			const reply = honest(request);
			if (
				reply !== "silence" &&
				reply.schema === "rig-cohort-accepted-ack/v1"
			) {
				const record = JSON.parse(
					Buffer.from(
						reply.rigCohortAcceptanceBase64 as string,
						"base64",
					).toString("utf8"),
				);
				// Same record, keys out of canonical order: the digest the Mac would
				// sign is not the digest of any canonical encoding of it.
				const reordered = Object.fromEntries(Object.entries(record).reverse());
				return {
					...reply,
					rigCohortAcceptanceBase64: b64(
						new TextEncoder().encode(JSON.stringify(reordered)),
					),
				};
			}
			return reply;
		});
		const walked = await runLifecycle(channelFor(wire, keys.publicRaw32));
		expect(walked.at).toBe("acceptCohort");
		expect((walked.result as { message: string }).message).toContain(
			"canonically encoded",
		);
	});
});

// ---------------------------------------------------------------------------
// C4: the controller <-> Mac cohort channel
//
// The Mac supervisor is a process that alone holds the Mac key. These tests
// drive `MacCohortChannel` against a scripted Mac peer that speaks the
// registered frames byte-for-byte and signs with a test key, so every refusal
// below is one the wire would actually produce, and every acceptance is of
// bytes the channel verified under the staged key it was given.
// ---------------------------------------------------------------------------

const MAC_STAGED_RIG = generateEd25519KeyPair();
const MAC_WORKLOAD_BYTES = bytesOfCanonical({ plan: "channel-test" });

function macDraftBytes(): Uint8Array {
	return bytesOfCanonical({
		schema: "cross-supervisor-execution-draft/v1",
		authoritySha256: RIG_HEX("a"),
		campaignLockSha256: RIG_HEX("b"),
		stagedCapabilitySha256: RIG_HEX("c"),
		sourceArchiveSha256: RIG_HEX("d"),
		approvedPlanSha256: RIG_HEX("e"),
		approvalRecordSha256: RIG_HEX("f"),
		candidate: "cand",
		campaignId: "camp",
		runId: "camp/ticker-fanout/ws/measured-1",
		executionPurpose: "focused",
		cellId: "ticker-fanout/rate-10000",
		scenarioHash: RIG_HEX("5"),
		rolePlanHash: RIG_HEX("6"),
		workloadRolePlanInputSha256: sha256HexOfBytes(MAC_WORKLOAD_BYTES),
		stagedServerLaunchRecordSha256: RIG_HEX("7"),
		armKind: "primary",
		transport: "ws",
		repetitionKind: "measured",
		repetitionIndex: 1,
		repetitionTotal: 1,
		grantDeclaration: "fanout-expanded-deliveries",
		declaredMessageCount: 10_000_000,
		declaredMessageBytes: 100,
		requestedNotAfterMs: 17_000_000_000_000,
	});
}

function scriptedMac(options: Partial<ScriptedMacBinaryOptions> = {}): {
	binary: ScriptedMacCohortBinary;
	keys: ReturnType<typeof generateEd25519KeyPair>;
} {
	const keys = options.keys ?? generateEd25519KeyPair();
	const binary = new ScriptedMacCohortBinary({
		keys,
		stagedRigPublicRaw32: MAC_STAGED_RIG.publicRaw32,
		clock: { nowMs: () => 1_000, nowNs: () => "1000000000" },
		receiptValidityMs: 60_000,
		macClockId: "mac-clock-test",
		instanceNonce: RIG_HEX("7"),
		executableSha256: RIG_HEX("b"),
		grant: {
			transport: "ws",
			readinessDeadlineMs: 30_000,
			measuredDurationMs: 10_000,
			messageBytes: 100,
			expectedOfferedIngress: 10,
		},
		...options,
	});
	return { binary, keys };
}

function macChannelFor(
	wire: MacWire,
	stagedMacPublicRaw32: Uint8Array,
	budget?: CohortEvidenceBudget,
): MacCohortChannel {
	return new MacCohortChannel({
		controllerToMac: wire.controllerToMac,
		macToController: wire.macToController,
		childDiagnostics: undefined,
		stagedMacPublicRaw32,
		deadlineMs: 2_000,
		budget,
	});
}

/** The C1 open-cohort request for a tiny ticker cohort, from the real builder. */
function macOpenCohortRequest(
	executionSha256: string,
	cohortId = "cohort-channel-test",
) {
	const tokens = buildFanoutCohortFixture({
		cohortId,
		publisherCount: 1,
		subscriberCount: 8,
	});
	const leafManifest = bytesOfCanonical({
		schema: "token-commitment-leaf-manifest/v1",
		executionSha256,
		cohortId,
		leafCount: tokens.leaves.length,
		leaves: [...tokens.leaves],
		roleTokenCommitmentRootSha256: tokens.roleTokenCommitmentRootSha256,
	});
	const workload = MAC_WORKLOAD_BYTES;
	return {
		schema: "mac-open-cohort-request/v1",
		executionSha256,
		scenarioHash: RIG_HEX("5"),
		rolePlanHash: RIG_HEX("6"),
		workloadRolePlanInputBase64: b64(workload),
		workloadRolePlanInputSha256: sha256HexOfBytes(workload),
		workloadRolePlanInputSize: workload.byteLength,
		tokenCommitmentLeafManifestBase64: b64(leafManifest),
		tokenCommitmentLeafManifestSha256: sha256HexOfBytes(leafManifest),
		publishersBase64: b64(bytesOfCanonical(tokens.publishers)),
		subscriberShardsBase64: b64(bytesOfCanonical(tokens.subscriberShards)),
	};
}

/**
 * A `rig-cohort-acceptance/v1` and its signature under the staged rig key the
 * scripted Mac binary was built with -- the record `MAC_JOIN`'s row 2 carries.
 */
function macRigCohortAcceptance(
	executionSha256: string,
	cohortGrantSha256: string,
): { readonly bytes: Uint8Array; readonly signatureBytes: Uint8Array } {
	const bytes = bytesOfCanonical({
		schema: "rig-cohort-acceptance/v1",
		executionSha256,
		cohortGrantSha256,
		cohortGrantSignatureSha256: RIG_HEX("2"),
		roleTokenCommitmentRootSha256: RIG_HEX("3"),
		approvedPlanSha256: RIG_HEX("e"),
		approvalRecordSha256: RIG_HEX("f"),
		rigExecutionIndex: 0,
		rigSupervisorInstanceNonce: RIG_HEX("4"),
		signingPublicKeySha256: MAC_STAGED_RIG.publicKeySha256,
		receiptSequence: 1,
		acceptedAtMs: 1_000,
		issuedAtMs: 1_000,
		notAfterMs: 900_000,
	});
	return {
		bytes,
		signatureBytes: bytesOfCanonical(
			signRigReceipt({
				privatePkcs8Der: MAC_STAGED_RIG.privatePkcs8Der,
				publicRaw32: MAC_STAGED_RIG.publicRaw32,
				signedSchema: "rig-cohort-acceptance/v1",
				signedBytes: bytes,
			}),
		),
	};
}

describe("remote-supervisor: CohortRigChannel TEARDOWN", () => {
	it("tears_the_server_child_down_after_the_capture_and_takes_the_rigs_reaped_verdict", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const walked = await runLifecycle(channel);
		if (walked.at !== "complete") throw new Error(walked.at);
		expect(channel.serverChildLive).toBe(true);
		const stopped = await channel.teardownServer();
		expect(stopped).toEqual({
			ok: true,
			value: { exitCode: 0, signal: null },
		});
		expect(channel.stage).toBe("server-stopped");
		expect(channel.serverChildLive).toBe(false);
		expect(wire.seen.at(-1)?.schema).toBe("rig-teardown-server-request/v1");
		expect(wire.seen.at(-1)?.executionSha256).toBe(RIG_EXECUTION_SHA256);
		// One child per execution: a second teardown has nothing to stop.
		const again = await channel.teardownServer();
		expect(again.ok).toBe(false);
		expect(again.ok === false && again.code).toBe("COHORT_NOT_READY");
		expect(
			wire.seen.filter((f) => f.schema === "rig-teardown-server-request/v1"),
		).toHaveLength(1);
	});

	it("refuses_a_teardown_before_any_server_child_exists_without_a_frame", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const accepted = await acceptExecutionOn(channel);
		if (!accepted.ok) throw new Error(accepted.message);
		const early = await channel.teardownServer();
		expect(early.ok).toBe(false);
		expect(early.ok === false && early.code).toBe("COHORT_NOT_READY");
		expect(wire.seen.map((f) => f.schema)).toEqual([
			"rig-accept-execution-request/v1",
		]);
	});

	it("a_stopped_ack_that_cannot_say_reaped_or_names_another_execution_is_refused", async () => {
		for (const patch of [
			{ reaped: false },
			{ executionSha256: RIG_HEX("e") },
		]) {
			const keys = generateEd25519KeyPair();
			const honest = honestRig(keys);
			const wire = serveScriptedRig((request) => {
				const reply = honest(request);
				if (
					typeof reply !== "string" &&
					reply.schema === "rig-server-stopped-ack/v1"
				) {
					return { ...reply, ...patch };
				}
				return reply;
			});
			const channel = channelFor(wire, keys.publicRaw32);
			const walked = await runLifecycle(channel);
			if (walked.at !== "complete") throw new Error(walked.at);
			const stopped = await channel.teardownServer();
			expect(stopped.ok).toBe(false);
			expect(channel.stage).toBe("captured");
		}
	});
});

describe("remote-supervisor: MacCohortChannel", () => {
	it("opens_the_execution_and_the_cohort_against_a_scripted_mac_with_exact_bytes", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		expect(channel.openedExecution).toBeNull();

		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error(`${opened.code} ${opened.message}`);
		// The receipt the binary signed names the draft, the grant and the
		// execution this channel now speaks for; nothing here was restated.
		expect(opened.value.receipt.execution.draftSha256).toBe(
			sha256HexOfBytes(macDraftBytes()),
		);
		expect(opened.value.receipt.measurementGrantSha256).toBe(
			opened.value.measurementGrantSha256,
		);
		expect(channel.executionSha256).toBe(opened.value.executionSha256);
		expect(channel.budget.openExecutionSha256).toBe(
			opened.value.executionSha256,
		);
		// The ack payload bytes are the binary's own canonical bytes, retained.
		expect(sha256HexOfBytes(opened.value.ackPayloadBytes)).toBe(
			sha256HexOfBytes(bytesOfCanonical(opened.value.ack)),
		);

		const request = macOpenCohortRequest(opened.value.executionSha256);
		const answered = await channel.request<MacCohortOpenedAckV1>(
			request,
			"mac-cohort-opened-ack/v1",
		);
		expect(answered.ok).toBe(true);
		if (!answered.ok) throw new Error(`${answered.code} ${answered.message}`);
		const signed = channel.signedRecord(
			answered.value.ack.cohortGrantBase64,
			answered.value.ack.cohortGrantSignatureBase64,
			"cohort-grant/v1",
		);
		expect(signed.ok).toBe(true);
		if (!signed.ok) throw new Error(signed.code);
		expect(sha256HexOfBytes(signed.value.bytes)).toBe(
			answered.value.ack.cohortGrantSha256,
		);
		// The grant is the binary's mint over what was presented: the manifest
		// digest it commits to is the one this request carried.
		const grant = JSON.parse(
			Buffer.from(signed.value.bytes).toString("utf8"),
		) as { tokenCommitmentLeafManifestSha256: string; cohortAttempt: number };
		expect(grant.tokenCommitmentLeafManifestSha256).toBe(
			request.tokenCommitmentLeafManifestSha256,
		);
		expect(grant.cohortAttempt).toBe(1);
		// Sequence: two requests, two acks, both correlated.
		expect(wire.seen.map((seen) => seen.requestSeq)).toEqual([0, 1]);
		expect(answered.value.ack.ackRequestSeq).toBe(1);
		expect(answered.value.ack.responseSeq).toBe(1);
		// And the budget charged exactly the four bulk fields of the open.
		expect(channel.budget.chargedBytes).toBe(
			[
				request.workloadRolePlanInputBase64,
				request.tokenCommitmentLeafManifestBase64,
				request.publishersBase64,
				request.subscriberShardsBase64,
			].reduce(
				(total, field) => total + Buffer.from(field, "base64").byteLength,
				0,
			),
		);
		expect(channel.isTerminal).toBe(false);
	});

	it("one_scripted_binary_answers_two_execution_channels_each_from_sequence_zero", async () => {
		// Design "Channel sequence": `requestSeq` from 0 per controller→
		// supervisor direction, responses echo `ackRequestSeq`, an independent
		// `responseSeq` from 0 — per execution channel. One binary process
		// serves the campaign's four executions on four fresh channels, the way
		// the rig already does (`session.response_sequence = 1` after the
		// acceptance answered 0). The scripted binary models the same thing.
		const { binary, keys } = scriptedMac();
		const first = serveScriptedMac(binary.respond);
		const firstChannel = macChannelFor(first, keys.publicRaw32);
		const firstOpened = await firstChannel.openExecution(macDraftBytes());
		expect(firstOpened.ok).toBe(true);
		if (!firstOpened.ok) throw new Error(firstOpened.code);
		expect(firstOpened.value.ack.responseSeq).toBe(0);
		expect(firstOpened.value.ack.ackRequestSeq).toBe(0);
		const firstCohort = await firstChannel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(firstOpened.value.executionSha256),
			"mac-cohort-opened-ack/v1",
		);
		expect(firstCohort.ok).toBe(true);
		if (!firstCohort.ok) throw new Error(firstCohort.code);
		// The cohort session's answers continue the counter that answered the
		// execution open, not a counter of their own.
		expect(firstCohort.value.ack.responseSeq).toBe(1);
		expect(firstCohort.value.ack.ackRequestSeq).toBe(1);

		// A frame from a channel that restarted at 0 mid-execution is caught
		// on sequence alone, before any state is consulted.
		const stale = binary.respond({
			...(first.seen[1] as Record<string, unknown>),
			requestSeq: 0,
		}) as Record<string, unknown>;
		expect(stale.schema).toBe("remote-supervisor-refusal/v1");
		expect(stale.code).toBe("TRUST_PROTOCOL");

		// The next execution opens a fresh channel: both counters from 0 again.
		const second = serveScriptedMac(binary.respond);
		const secondChannel = macChannelFor(second, keys.publicRaw32);
		const secondOpened = await secondChannel.openExecution(macDraftBytes());
		expect(secondOpened.ok).toBe(true);
		if (!secondOpened.ok) throw new Error(secondOpened.code);
		expect(secondOpened.value.ack.responseSeq).toBe(0);
		expect(secondOpened.value.ack.ackRequestSeq).toBe(0);
		expect(secondOpened.value.executionSha256).not.toBe(
			firstOpened.value.executionSha256,
		);
		const secondCohort = await secondChannel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(secondOpened.value.executionSha256),
			"mac-cohort-opened-ack/v1",
		);
		expect(secondCohort.ok).toBe(true);
		if (!secondCohort.ok) throw new Error(secondCohort.code);
		expect(secondCohort.value.ack.responseSeq).toBe(1);
		expect(second.seen.map((seen) => seen.requestSeq)).toEqual([0, 1]);
	});

	it("refuses_a_grant_the_staged_key_does_not_verify_and_is_terminal_after", async () => {
		// Same binary, same honest bytes; the controller was staged with some
		// other key. The execution receipt already fails, before any cohort.
		const { binary } = scriptedMac();
		const foreign = generateEd25519KeyPair();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, foreign.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(false);
		if (opened.ok) throw new Error("unreachable");
		expect(opened.code).toBe("MAC_SIGNING_KEY_MISMATCH");
		expect(channel.isTerminal).toBe(true);
		expect(channel.openedExecution).toBeNull();
		const again = await channel.openExecution(macDraftBytes());
		expect(again.ok).toBe(false);
		expect(wire.seen.length).toBe(1);
	});

	it("refuses_an_ack_whose_sequence_is_not_the_answer_to_its_request", async () => {
		const { binary, keys } = scriptedMac({
			mutate: (schema, payload) =>
				schema === "mac-execution-opened-ack/v1"
					? { ...payload, ackRequestSeq: 7 }
					: payload,
		});
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(false);
		if (opened.ok) throw new Error("unreachable");
		expect(opened.code).toBe("TRUST_PROTOCOL");
		expect(channel.isTerminal).toBe(true);
	});

	it("carries_the_binarys_closed_refusal_code_and_stops", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("unreachable");
		// A cohort request naming an execution the binary never opened is
		// refused by the binary with its own code, and the channel carries it.
		const request = macOpenCohortRequest(opened.value.executionSha256);
		const foreignExecution = await channel.request<MacCohortOpenedAckV1>(
			{ ...request, executionSha256: RIG_HEX("9") },
			"mac-cohort-opened-ack/v1",
		);
		expect(foreignExecution.ok).toBe(false);
		if (foreignExecution.ok) throw new Error("unreachable");
		expect(foreignExecution.code).toBe("CROSS_SUPERVISOR_MISMATCH");
		expect(channel.isTerminal).toBe(true);
	});

	it("charges_the_execution_budget_before_encoding_and_refuses_at_cap_plus_one", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		// A budget far smaller than the open-cohort request's four bulk fields.
		const channel = macChannelFor(
			wire,
			keys.publicRaw32,
			new CohortEvidenceBudget(64),
		);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("unreachable");
		// The open-execution frame has no debit fields: nothing was charged.
		expect(channel.budget.chargedBytes).toBe(0);
		const request = macOpenCohortRequest(opened.value.executionSha256);
		const refused = await channel.request<MacCohortOpenedAckV1>(
			request,
			"mac-cohort-opened-ack/v1",
		);
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.code).toBe("RUNTIME_RESOURCE_EXHAUSTION");
		// Refused before the encode: the binary never saw the frame.
		expect(wire.seen.map((seen) => seen.schema)).toEqual([
			"mac-open-execution-request/v1",
		]);
		expect(channel.budget.chargedBytes).toBe(0);
	});

	// -- plan 2210's pre-readiness replacement, at the scripted binary ------
	//
	// One `mac-open-cohort-request/v1` per execution used to be all the release
	// binary allowed, and this fixture allowed unboundedly many: it incremented
	// `cohortAttempt` on every open and refused nothing. That is the
	// placeholder-evidence shape -- a stand-in more permissive than the producer
	// it stands in for -- and it is what let
	// `pre_ready_replacement_mints_new_grant_nonce_and_tokens` pass for years
	// over a path the binary refused outright. These five pin the fixture to the
	// binary's own rules (plan 2210, and the Rust slice's published semantics in
	// `.scratch/2026-09-05-cohort-completion/notes/rust-replacement.md` sections
	// 1-4 and 7); the cross-process guard that proves the two really agree is
	// `a_cohort_re_open_is_answered_identically_by_the_scripted_and_the_release_binary`
	// in `fanout-supervisor-integration.test.ts`.

	it("mints_attempt_two_for_a_pre_readiness_re_open_with_fresh_material", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		if (!opened.ok) throw new Error(opened.code);
		const execution = opened.value.executionSha256;

		const first = await channel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(execution, "cohort-attempt-1"),
			"mac-cohort-opened-ack/v1",
		);
		if (!first.ok) throw new Error(`${first.code} ${first.message}`);
		const second = await channel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(execution, "cohort-attempt-2"),
			"mac-cohort-opened-ack/v1",
		);
		if (!second.ok) throw new Error(`${second.code} ${second.message}`);

		const attemptOf = (ack: MacCohortOpenedAckV1) =>
			(
				JSON.parse(
					Buffer.from(ack.cohortGrantBase64, "base64").toString("utf8"),
				) as { cohortAttempt: number; cohortId: string }
			).cohortAttempt;
		expect(attemptOf(first.value.ack)).toBe(1);
		expect(attemptOf(second.value.ack)).toBe(2);
		// Section 5: the replacement continues the channel's answer counter.
		expect(first.value.ack.responseSeq).toBe(1);
		expect(second.value.ack.responseSeq).toBe(2);
	});

	it("refuses_a_second_pre_readiness_replacement_as_cohort_protocol", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		if (!opened.ok) throw new Error(opened.code);
		const execution = opened.value.executionSha256;
		for (const cohortId of ["cohort-attempt-1", "cohort-attempt-2"]) {
			const answered = await channel.request<MacCohortOpenedAckV1>(
				macOpenCohortRequest(execution, cohortId),
				"mac-cohort-opened-ack/v1",
			);
			if (!answered.ok) throw new Error(`${cohortId}: ${answered.code}`);
		}
		const third = await channel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(execution, "cohort-attempt-3"),
			"mac-cohort-opened-ack/v1",
		);
		expect(third.ok).toBe(false);
		expect(third.ok === false && third.code).toBe("COHORT_PROTOCOL");
	});

	it("refuses_a_replacement_that_reuses_the_retired_cohort_material", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		if (!opened.ok) throw new Error(opened.code);
		const execution = opened.value.executionSha256;
		const first = await channel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(execution, "cohort-attempt-1"),
			"mac-cohort-opened-ack/v1",
		);
		if (!first.ok) throw new Error(first.code);
		// The same cohort id is the same manifest digest, the same root and the
		// same leaf commitments: the retired tokens would still verify.
		const replayed = await channel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(execution, "cohort-attempt-1"),
			"mac-cohort-opened-ack/v1",
		);
		expect(replayed.ok).toBe(false);
		expect(replayed.ok === false && replayed.code).toBe("COHORT_PROTOCOL");
	});

	it("refuses_a_replacement_once_it_has_minted_a_warmup_epoch", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		if (!opened.ok) throw new Error(opened.code);
		const execution = opened.value.executionSha256;
		const first = await channel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(execution, "cohort-attempt-1"),
			"mac-cohort-opened-ack/v1",
		);
		if (!first.ok) throw new Error(first.code);
		const grantSha256 = first.value.ack.cohortGrantSha256;
		const acceptance = macRigCohortAcceptance(execution, grantSha256);
		const admitted = await channel.request(
			{
				schema: "mac-present-rig-cohort-acceptance-request/v1",
				executionSha256: execution,
				rigCohortAcceptanceBase64: b64(acceptance.bytes),
				rigCohortAcceptanceSignatureBase64: b64(acceptance.signatureBytes),
			},
			"mac-rig-cohort-acceptance-ack/v1",
		);
		if (!admitted.ok) throw new Error(`${admitted.code} ${admitted.message}`);
		const epoch = await channel.request(
			{
				schema: "mac-issue-warmup-epoch-request/v1",
				executionSha256: execution,
				cohortGrantSha256: grantSha256,
				rigCohortAcceptanceSha256: sha256HexOfBytes(acceptance.bytes),
			},
			"mac-warmup-epoch-issued-ack/v1",
		);
		if (!epoch.ok) throw new Error(`${epoch.code} ${epoch.message}`);

		const late = await channel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(execution, "cohort-attempt-2"),
			"mac-cohort-opened-ack/v1",
		);
		expect(late.ok).toBe(false);
		expect(late.ok === false && late.code).toBe("COHORT_PROTOCOL");
	});

	it("refuses_a_frame_that_names_the_retired_cohort_grant", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		if (!opened.ok) throw new Error(opened.code);
		const execution = opened.value.executionSha256;
		const first = await channel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(execution, "cohort-attempt-1"),
			"mac-cohort-opened-ack/v1",
		);
		if (!first.ok) throw new Error(first.code);
		const retiredGrantSha256 = first.value.ack.cohortGrantSha256;
		const second = await channel.request<MacCohortOpenedAckV1>(
			macOpenCohortRequest(execution, "cohort-attempt-2"),
			"mac-cohort-opened-ack/v1",
		);
		if (!second.ok) throw new Error(second.code);

		// An acceptance minted against attempt 1 and presented after attempt 2
		// opened names a grant this execution has retired -- COHORT_PROTOCOL,
		// not the CROSS_SUPERVISOR_MISMATCH an unknown digest would draw.
		const stale = macRigCohortAcceptance(execution, retiredGrantSha256);
		const presented = await channel.request(
			{
				schema: "mac-present-rig-cohort-acceptance-request/v1",
				executionSha256: execution,
				rigCohortAcceptanceBase64: b64(stale.bytes),
				rigCohortAcceptanceSignatureBase64: b64(stale.signatureBytes),
			},
			"mac-rig-cohort-acceptance-ack/v1",
		);
		expect(presented.ok).toBe(false);
		expect(presented.ok === false && presented.code).toBe("COHORT_PROTOCOL");
	});

	it("refuses_an_oversize_role_child_bundle_before_it_reaches_the_wire", async () => {
		const { binary, keys } = scriptedMac();
		const wire = serveScriptedMac(binary.respond);
		const channel = macChannelFor(wire, keys.publicRaw32);
		const opened = await channel.openExecution(macDraftBytes());
		expect(opened.ok).toBe(true);
		const oversize = await channel.exportCohortEvidence({
			cohortAdmissionReceiptSha256: RIG_HEX("1"),
			roleChildEvidenceBundleBytes: new Uint8Array(9 * 1024 * 1024 + 1),
		});
		expect(oversize.ok).toBe(false);
		if (oversize.ok) throw new Error("unreachable");
		expect(oversize.code).toBe("RUNTIME_RESOURCE_EXHAUSTION");
		expect(wire.seen.length).toBe(1);
		// Not terminal: nothing was written, the channel is still usable.
		expect(channel.isTerminal).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// C4: production never signs and never reaches a fixture signer
// ---------------------------------------------------------------------------

/** Every non-test TypeScript module under tools/compare, recursively. */
function productionModulesUnderCompare(): string[] {
	const root = join(import.meta.dir);
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules") continue;
				walk(path);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts"))
				continue;
			found.push(path);
		}
	};
	walk(root);
	return found.sort();
}

describe("remote-supervisor: the controller holds no Mac key", () => {
	it("no_production_module_imports_the_fixture_signing_module", () => {
		const offenders: string[] = [];
		for (const path of productionModulesUnderCompare()) {
			if (path.endsWith("/cohort-fixture-signing.ts")) continue;
			const source = readFileSync(path, "utf8");
			if (/from\s+["'][^"']*cohort-fixture-signing\.ts["']/u.test(source)) {
				offenders.push(relative(import.meta.dir, path));
			}
		}
		expect(offenders).toEqual([]);
	});

	it("no_typescript_production_path_constructs_a_cohort_grant", () => {
		// Design §2.9(2g), grep level. The one permitted occurrence class is a
		// parser's comparison; a constructed literal is the second encoder.
		const offenders: string[] = [];
		for (const path of productionModulesUnderCompare()) {
			if (path.endsWith("/cohort-fixture-signing.ts")) continue;
			const source = readFileSync(path, "utf8");
			for (const [index, line] of source.split("\n").entries()) {
				// A type declaration names the schema as a literal type, not a
				// constructed value; the parser compares against it. Neither is
				// an encoder. A constructed literal is `schema: "cohort-grant/v1"`
				// on a value, and that is what this refuses.
				if (
					/schema:\s*"cohort-grant\/v1"/u.test(line) &&
					!/readonly\s+schema:/u.test(line)
				) {
					offenders.push(`${relative(import.meta.dir, path)}:${index + 1}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("the_mac_supervisor_has_no_private_key_and_no_signing_call", () => {
		const source = readFileSync(
			join(import.meta.dir, "remote-supervisor.ts"),
			"utf8",
		);
		expect(source.includes("privatePkcs8Der")).toBe(false);
		expect(source.includes("signMacReceipt(")).toBe(false);
		expect(source.includes("macSign(")).toBe(false);
		expect(source.includes("macKeys")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// R8: the Mac clock every later record is checked against is the binary's own
// statement on its signed barrier, bound to the instance that opened the
// execution -- never a value the controller observed and passed in.
// ---------------------------------------------------------------------------

describe("remote-supervisor: bindBarrierClockId (R8)", () => {
	const macKeys = generateEd25519KeyPair();
	const stagedMacPublicKeySha256 = sha256HexOfBytes(macKeys.publicRaw32);
	const openedInstanceNonce = RIG_HEX("7");
	/** The clock field as the binary states it: a hex64 sysctl digest. */
	const binaryClockId = RIG_HEX("c");
	const barrier = {
		macClockId: binaryClockId,
		macSupervisorInstanceNonce: openedInstanceNonce,
		signingPublicKeySha256: stagedMacPublicKeySha256,
	} as const;

	it("the_binary_own_clock_binds_from_its_signed_barrier", () => {
		const bound = bindBarrierClockId({
			barrier,
			openedInstanceNonce,
			stagedMacPublicKeySha256,
		});
		expect(bound.ok).toBe(true);
		if (!bound.ok) return;
		expect(bound.value).toBe(binaryClockId);
	});

	it("a_matching_controller_cross_check_never_replaces_the_bound_value", () => {
		const bound = bindBarrierClockId({
			barrier,
			openedInstanceNonce,
			stagedMacPublicKeySha256,
			controllerClockId: binaryClockId,
		});
		expect(bound.ok).toBe(true);
		if (!bound.ok) return;
		expect(bound.value).toBe(barrier.macClockId);
	});

	it("a_controller_supplied_different_clock_id_is_refused", () => {
		const refused = bindBarrierClockId({
			barrier,
			openedInstanceNonce,
			stagedMacPublicKeySha256,
			controllerClockId: RIG_HEX("d"),
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.code).toBe("COHORT_PROTOCOL");
		expect(refused.message).toContain("controller's clock id");
	});

	it("a_barrier_from_another_mac_instance_than_the_opened_execution_is_refused", () => {
		const refused = bindBarrierClockId({
			barrier: { ...barrier, macSupervisorInstanceNonce: RIG_HEX("8") },
			openedInstanceNonce,
			stagedMacPublicKeySha256,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.code).toBe("CROSS_SUPERVISOR_MISMATCH");
		expect(refused.message).toContain("another Mac supervisor instance");
	});

	it("a_barrier_naming_another_signing_key_is_refused", () => {
		const other = generateEd25519KeyPair();
		const refused = bindBarrierClockId({
			barrier: {
				...barrier,
				signingPublicKeySha256: sha256HexOfBytes(other.publicRaw32),
			},
			openedInstanceNonce,
			stagedMacPublicKeySha256,
		});
		expect(refused.ok).toBe(false);
		if (refused.ok) return;
		expect(refused.code).toBe("MAC_SIGNING_KEY_MISMATCH");
	});

	it("the_supervisor_compares_no_mac_record_against_a_configured_clock", () => {
		// Amendment C2: "All later Mac mints read this state, never a
		// replacement controller value." The configured clock may reach exactly
		// one place -- the cross-check argument of the binder -- and the bound
		// clock is assigned from the binder's result alone.
		const source = readFileSync(
			join(import.meta.dir, "remote-supervisor.ts"),
			"utf8",
		);
		const configReads = source.match(/this\.config\.macClockId/gu) ?? [];
		expect(configReads).toHaveLength(1);
		expect(source).toContain("controllerClockId: this.config.macClockId,");
		const boundWrites = source.match(/this\.boundClockId = [^;]+;/gu) ?? [];
		expect(boundWrites).toEqual(["this.boundClockId = bound.value;"]);
		expect(source).toContain("partial.macClockId !== this.boundClockId");
	});
});

// ---------------------------------------------------------------------------
// R-J: the order of the reaped supervisor's descriptor release
// ---------------------------------------------------------------------------

describe("remote-supervisor: stopSupervisor closes only what the output stream did not own", () => {
	/** A supervisor that is already reaped, so only the descriptor release runs. */
	const reaped: SupervisorSubprocess = {
		pid: 424244,
		exitCode: 0,
		kill: () => true,
		exited: Promise.resolve(0),
	};

	function isOpen(fd: number): boolean {
		try {
			fstatSync(fd);
			return true;
		} catch {
			return false;
		}
	}

	it("destroys the stream before closing the parent copies, so the stream still holds its own descriptor when it closes it", async () => {
		// The stream reports what it finds at `_destroy`: under the old order
		// (`safeClose` first) its descriptor was already gone, and the close it
		// then issues can only land on whatever reused the number. A stream
		// that closes its own descriptor synchronously makes the order the
		// only thing under test.
		const pipe = createCloexecPipe({ parentKeeps: "read" });
		expect(pipe.ok).toBe(true);
		if (!pipe.ok) return;
		const owned = pipe.pipe.parentFd;
		closeSync(pipe.pipe.childFd);
		const notOwned = openSync("/dev/null", "r");
		const atDestroy: { foundOpen: boolean | null } = { foundOpen: null };
		class OwningStream extends Readable {
			readonly fd = owned;
			constructor() {
				// A Readable destroys itself at "end" by default, which would run
				// `_destroy` before the stop reaches its release; the production
				// ReadStream does not (probe: ended, not destroyed, fd open).
				super({ autoDestroy: false });
			}
			override _read(): void {
				this.push(null);
			}
			override _destroy(
				error: Error | null,
				callback: (error: Error | null) => void,
			): void {
				atDestroy.foundOpen = isOpen(this.fd);
				if (atDestroy.foundOpen) closeSync(this.fd);
				callback(error);
			}
		}
		const stream = new OwningStream();
		const handle: SupervisorHandle = {
			pid: reaped.pid,
			pgid: reaped.pid,
			host: "rig",
			subprocess: reaped,
			bootstrapFds: [notOwned],
			controlParentFds: [owned],
			supervisorToController: stream,
		};
		const stopped = await stopSupervisor(handle, 1_000);
		expect(stopped.ok).toBe(true);
		if (!stopped.ok) return;
		expect(stopped.stoppedBy).toBe("control-channel-eof");
		expect(stream.destroyed).toBe(true);
		// The stream was destroyed while its descriptor was still its own.
		expect(atDestroy.foundOpen).toBe(true);
		// Both descriptors are released exactly once: the stream's by the
		// stream, the other by the stop.
		expect(isOpen(owned)).toBe(false);
		expect(isOpen(notOwned)).toBe(false);
	});

	it("a real ReadStream over a parent control copy closes that descriptor itself and nothing that reuses the number", async () => {
		// Bun 1.3.14: `createReadStream("", { fd, autoClose: false }).destroy()`
		// closes the fd, and does so after `destroy()` returns. With the stream
		// destroyed first the number stays taken until that close lands, so a
		// descriptor opened after the stop cannot be the one it closes.
		const pipe = createCloexecPipe({ parentKeeps: "read" });
		expect(pipe.ok).toBe(true);
		if (!pipe.ok) return;
		const owned = pipe.pipe.parentFd;
		closeSync(pipe.pipe.childFd);
		const notOwned = openSync("/dev/null", "r");
		const stream = createReadStream("", { fd: owned, autoClose: false });
		stream.on("error", () => {});
		const handle: SupervisorHandle = {
			pid: reaped.pid,
			pgid: reaped.pid,
			host: "rig",
			subprocess: reaped,
			bootstrapFds: [notOwned],
			controlParentFds: [owned],
			supervisorToController: stream,
		};
		const stopped = await stopSupervisor(handle, 1_000);
		expect(stopped.ok).toBe(true);
		expect(stream.destroyed).toBe(true);
		expect(isOpen(notOwned)).toBe(false);
		const canary = openSync("/dev/null", "r");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(isOpen(owned) && owned !== canary).toBe(false);
		expect(isOpen(canary)).toBe(true);
		closeSync(canary);
	});
});

describe("remote-supervisor: the rig control channel is Node-shaped and bounded", () => {
	const rigInputs = {
		rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
		rigPaths: {
			authorityFile: "/var/staged/c/authority.json",
			authorityDigestFile: "/var/staged/c/authority-digest.bin",
			campaignRootDir: "/var/campaign/c",
			stagingRootDir: "/var/staged/c",
		},
		sshTarget: "hermes-admin@10.99.0.2",
		sshIdentity: "/Users/x/.ssh/do_id_rsa",
		uidCrossing: { targetUser: "_wtcompare" },
		rigCohort: {
			signingKey: {
				fd: 7,
				label: "cohort-signing-key",
				path: "/var/lib/webtransport-bun/comparison/keys/c/x.rig.pk8",
			},
			roleRoot: {
				fd: 10,
				label: "cohort-role-root",
				path: "/var/staged/c/roles",
			},
		},
	} as const;

	/**
	 * The shape `Bun.spawn` hands back for `stdin: "pipe"`: a `FileSink` whose
	 * `write` ignores the completion callback `writeAll` resolves from, and a
	 * `ReadableStream` with neither `read` nor `once`. Reproduced here rather
	 * than spawned so the assertion is about the shape, not about Bun.
	 */
	function bunShapedChild(): {
		stdin: unknown;
		stdout: unknown;
		stderr: unknown;
		pid: number;
		kill: () => boolean;
		once: () => void;
	} {
		return {
			stdin: { write: (_chunk: unknown) => 0, end: () => undefined },
			stdout: {},
			stderr: {},
			pid: 424242,
			kill: () => true,
			once: () => undefined,
		};
	}

	it("refuses a child whose control pipes cannot answer writeAll/readControlFrame", async () => {
		const spawned = await spawnRigSupervisor({
			...SAMPLE_OPTIONS,
			...rigInputs,
			spawnChild: () =>
				bunShapedChild() as unknown as ReturnType<RigChildSpawner>,
		});
		expect(spawned.ok).toBe(false);
		if (spawned.ok) return;
		expect(spawned.code).toBe("SPAWN_PIPE_FAILED");
		expect(spawned.message).toContain("controllerToSupervisor");
	});

	it("the production spawner's own pipes are the shape the framing drives", async () => {
		// The default `spawnRigSupervisor` uses when nothing is injected. A
		// harmless command, because what is under test is the pipe shape, not
		// ssh: `Bun.spawn` here would hand back a FileSink and a
		// ReadableStream, which is the defect that hung the r1 campaign.
		const child = spawnRigSshChild("cat", []);
		try {
			expect(controlPipeShapeRefusal(child.stdin, child.stdout)).toBeNull();
			const echoed = new Promise<void>((resolve, reject) => {
				child.stdin.write(Buffer.from("ping\n"), (error) =>
					error ? reject(error) : resolve(),
				);
				setTimeout(() => reject(new Error("write never completed")), 2_000);
			});
			await echoed;
		} finally {
			child.kill("SIGKILL");
		}
	});

	it("hands back streams a real framed write completes on", async () => {
		const spawned = await spawnRigSupervisor({
			...SAMPLE_OPTIONS,
			...rigInputs,
			// A real process with the production stdio, without the ssh hop:
			// the point is that the handle's pipes are the ones the framing
			// code drives, not that ssh runs in a unit test.
			spawnChild: () =>
				nodeSpawn("cat", [], {
					stdio: ["pipe", "pipe", "pipe"],
				}) as ChildProcessWithoutNullStreams,
		});
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) return;
		const handle = spawned.handle;
		try {
			const toRig = handle.controllerToSupervisor;
			const fromRig = handle.supervisorToController;
			expect(toRig).toBeDefined();
			expect(fromRig).toBeDefined();
			if (toRig === undefined || fromRig === undefined) return;
			const frame = encodeSupervisorFrame(
				new TextEncoder().encode('{"kind":"rig-echo/v1"}'),
				new TextEncoder().encode('{"schema":"rig-echo/v1"}'),
				4_096,
			);
			expect(frame.ok).toBe(true);
			if (!frame.ok) return;
			// `cat` echoes the frame, so a completed write is observable as a
			// frame read back: a write that never resolves fails this by
			// timing out, which is exactly the production hang.
			await new Promise<void>((resolve, reject) => {
				toRig.write(Buffer.from(frame.value), (error) =>
					error ? reject(error) : resolve(),
				);
			});
			const read = await readControlFrame(fromRig, 4_096, 2_000);
			expect(read.ok).toBe(true);
			if (!read.ok) return;
			expect(read.kind).toBe("rig-echo/v1");
		} finally {
			handle.subprocess.kill("SIGKILL");
		}
	});

	it("a control write that never completes becomes a typed deadline error", async () => {
		const pending = new Promise<void>(() => {
			// Never settles: exactly what `writeAll` returns when the pipe
			// object takes the completion callback and drops it.
		});
		const startedAt = Date.now();
		await expect(
			withWriteDeadline(pending, 120, "write rig-open/v1"),
		).rejects.toThrow("write rig-open/v1 did not complete in 120ms");
		expect(Date.now() - startedAt).toBeLessThan(3_000);
	});

	it("a control write that completes is not disturbed by its deadline", async () => {
		await expect(
			withWriteDeadline(Promise.resolve(), 5_000, "write rig-open/v1"),
		).resolves.toBeUndefined();
	});

	it("CohortRigChannel refuses, bounded, when the control write never completes", async () => {
		// Exactly the FileSink behaviour: the write is accepted and the
		// completion callback is never invoked.
		const neverCompletes = {
			write: (_chunk: unknown, _callback: (error?: Error) => void) => true,
		} as unknown as PassThrough;
		const channel = new CohortRigChannel({
			controllerToRig: neverCompletes,
			rigToController: new PassThrough(),
			childDiagnostics: undefined,
			executionSha256: RIG_EXECUTION_SHA256,
			stagedRigPublicRaw32: new Uint8Array(32),
			deadlines: { ...RIG_DEADLINES, frameMs: 300 },
		});
		const startedAt = Date.now();
		const accepted = await channel.acceptExecution({
			measurementGrantBytes: MAC_MEASUREMENT_GRANT_BYTES,
			receiptBytes: MAC_EXECUTION_RECEIPT_BYTES,
			receiptSignatureBytes: MAC_EXECUTION_RECEIPT_SIGNATURE_BYTES,
		});
		const elapsed = Date.now() - startedAt;
		expect(accepted.ok).toBe(false);
		if (accepted.ok) return;
		expect(accepted.message).toContain("write");
		expect(elapsed).toBeLessThan(3_000);
	});
});

describe("remote-supervisor: supervisor child post-mortem", () => {
	/** A child that says something on stderr and then dies with `code`. */
	function dyingChild(
		stderr: string,
		code: number,
	): ChildProcessWithoutNullStreams {
		return nodeSpawn(
			"/bin/sh",
			["-c", `printf %s ${JSON.stringify(stderr)} >&2; exit ${code}`],
			{ stdio: ["pipe", "pipe", "pipe"] },
		) as ChildProcessWithoutNullStreams;
	}

	async function settled(
		diagnostics: SupervisorChildDiagnostics,
	): Promise<void> {
		for (let i = 0; i < 200; i += 1) {
			if (diagnostics.exit() !== null) return;
			await Bun.sleep(10);
		}
		throw new Error("child never exited");
	}

	it("retains the child's exit status and its stderr", async () => {
		const child = dyingChild("supervisor toolchain observation failed", 69);
		const diagnostics = attachSupervisorChildDiagnostics(child);
		expect(diagnostics.exit()).toBeNull();
		await settled(diagnostics);
		expect(diagnostics.exit()).toEqual({ code: 69, signal: null });
		expect(diagnostics.stderrTail()).toBe(
			"supervisor toolchain observation failed",
		);
	});

	it("names the signal when the child was killed rather than exited", async () => {
		const child = nodeSpawn("/bin/sh", ["-c", "printf bye >&2; sleep 30"], {
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		const diagnostics = attachSupervisorChildDiagnostics(child);
		await Bun.sleep(100);
		child.kill("SIGKILL");
		await settled(diagnostics);
		expect(diagnostics.exit()?.signal).toBe("SIGKILL");
		expect(diagnostics.stderrTail()).toBe("bye");
	});

	it("bounds the retained stderr at the last 4 KiB", async () => {
		const child = nodeSpawn(
			"/bin/sh",
			[
				"-c",
				// 12 KiB of 'a' then the tail marker: only the tail survives.
				`awk 'BEGIN{for(i=0;i<12288;i++)printf "a"}' >&2; printf TAILMARK >&2; exit 3`,
			],
			{ stdio: ["pipe", "pipe", "pipe"] },
		) as ChildProcessWithoutNullStreams;
		const diagnostics = attachSupervisorChildDiagnostics(child);
		await settled(diagnostics);
		const tail = diagnostics.stderrTail();
		expect(Buffer.byteLength(tail, "utf8")).toBe(
			SUPERVISOR_STDERR_TAIL_MAX_BYTES,
		);
		expect(tail.endsWith("TAILMARK")).toBe(true);
	});

	it("describes a dead child by exit status and stderr tail", async () => {
		const child = dyingChild("boom on the rig", 69);
		const diagnostics = attachSupervisorChildDiagnostics(child);
		await settled(diagnostics);
		const described = describeSupervisorChildDeath(diagnostics);
		expect(described).toContain("exited code=69");
		expect(described).toContain("boom on the rig");
	});

	it("describes a live child as alive and says nothing without diagnostics", async () => {
		const child = nodeSpawn("cat", [], {
			stdio: ["pipe", "pipe", "pipe"],
		}) as ChildProcessWithoutNullStreams;
		const diagnostics = attachSupervisorChildDiagnostics(child);
		try {
			expect(describeSupervisorChildDeath(diagnostics)).toContain(
				"still running",
			);
			expect(describeSupervisorChildDeath(undefined)).toBe("");
		} finally {
			child.kill("SIGKILL");
		}
	});
});

describe("remote-supervisor: rig spawn readiness handshake", () => {
	const rigInputs = {
		rigPaths: {
			stagedDir: "/home/hermes-admin/ws-wt-stage/c",
			authorityFile: "/home/hermes-admin/ws-wt-stage/c/authority.json",
			authorityDigestFile:
				"/home/hermes-admin/ws-wt-stage/c/authority-digest.bin",
			stagingRootDir: "/home/hermes-admin/ws-wt-stage/c",
		},
		rigBinaryPath: "/home/hermes-admin/ws-wt-stage/c/bin/comparison-supervisor",
		sshTarget: "hermes-admin@10.99.0.2",
		sshIdentity: "/Users/vmeansdev/.ssh/do_id_rsa",
		uidCrossing: { targetUser: "_wtcompare" },
	} as const;

	it("refuses a rig child that died at startup, naming its status and stderr", async () => {
		const startedAt = Date.now();
		const spawned = await spawnRigSupervisor({
			...SAMPLE_OPTIONS,
			...rigInputs,
			readinessMs: 3_000,
			spawnChild: () =>
				nodeSpawn(
					"/bin/sh",
					[
						"-c",
						"printf 'supervisor toolchain observation failed: Bun version string not found' >&2; exit 69",
					],
					{ stdio: ["pipe", "pipe", "pipe"] },
				) as ChildProcessWithoutNullStreams,
		});
		const elapsed = Date.now() - startedAt;
		expect(spawned.ok).toBe(false);
		if (spawned.ok) return;
		expect(spawned.code).toBe("SPAWN_CHILD_EXITED");
		expect(spawned.message).toContain("exited code=69");
		expect(spawned.message).toContain(
			"supervisor toolchain observation failed",
		);
		// The refusal follows the child's death, not the readiness window.
		expect(elapsed).toBeLessThan(2_500);
	});

	it("hands back a handle only for a child alive past the readiness window", async () => {
		const spawned = await spawnRigSupervisor({
			...SAMPLE_OPTIONS,
			...rigInputs,
			readinessMs: 120,
			spawnChild: () =>
				nodeSpawn("cat", [], {
					stdio: ["pipe", "pipe", "pipe"],
				}) as ChildProcessWithoutNullStreams,
		});
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) return;
		try {
			expect(spawned.handle.diagnostics).toBeDefined();
			expect(spawned.handle.diagnostics?.exit()).toBeNull();
		} finally {
			spawned.handle.subprocess.kill("SIGKILL");
		}
	});
});

describe("remote-supervisor: control exchanges name the child's death", () => {
	function exitedDiagnostics(
		code: number,
		stderr: string,
	): SupervisorChildDiagnostics {
		return {
			exit: () => ({ code, signal: null }),
			stderrTail: () => stderr,
		};
	}

	it("readControlFrame refuses at once when the child has already exited", async () => {
		const startedAt = Date.now();
		const read = await readControlFrame(new PassThrough(), 4_096, 5_000, {
			childDiagnostics: exitedDiagnostics(69, "toolchain observation failed"),
		});
		const elapsed = Date.now() - startedAt;
		expect(read.ok).toBe(false);
		if (read.ok) return;
		expect(read.code).toBe("CONTROL_CHILD_EXITED");
		expect(read.message).toContain("exited code=69");
		expect(read.message).toContain("toolchain observation failed");
		// Not the 5s frame deadline: the death is already known.
		expect(elapsed).toBeLessThan(1_000);
	});

	it("CohortRigChannel carries the rig child's post-mortem into its refusal", async () => {
		const channel = new CohortRigChannel({
			controllerToRig: new PassThrough(),
			rigToController: new PassThrough(),
			executionSha256: RIG_EXECUTION_SHA256,
			stagedRigPublicRaw32: new Uint8Array(32),
			deadlines: { ...RIG_DEADLINES, frameMs: 5_000 },
			childDiagnostics: exitedDiagnostics(
				69,
				"supervisor toolchain observation failed: Bun version string not found",
			),
		});
		const startedAt = Date.now();
		const accepted = await channel.acceptExecution({
			measurementGrantBytes: MAC_MEASUREMENT_GRANT_BYTES,
			receiptBytes: MAC_EXECUTION_RECEIPT_BYTES,
			receiptSignatureBytes: MAC_EXECUTION_RECEIPT_SIGNATURE_BYTES,
		});
		const elapsed = Date.now() - startedAt;
		expect(accepted.ok).toBe(false);
		if (accepted.ok) return;
		expect(accepted.message).toContain("CONTROL_CHILD_EXITED");
		expect(accepted.message).toContain("exited code=69");
		expect(accepted.message).toContain("Bun version string not found");
		expect(elapsed).toBeLessThan(1_000);
	});

	it("a rig write deadline names the child's death too", async () => {
		const neverCompletes = {
			write: (_chunk: unknown, _callback: (error?: Error) => void) => true,
		} as unknown as PassThrough;
		const channel = new CohortRigChannel({
			controllerToRig: neverCompletes,
			rigToController: new PassThrough(),
			executionSha256: RIG_EXECUTION_SHA256,
			stagedRigPublicRaw32: new Uint8Array(32),
			deadlines: { ...RIG_DEADLINES, frameMs: 200 },
			childDiagnostics: exitedDiagnostics(69, "rig said this on the way out"),
		});
		const accepted = await channel.acceptExecution({
			measurementGrantBytes: MAC_MEASUREMENT_GRANT_BYTES,
			receiptBytes: MAC_EXECUTION_RECEIPT_BYTES,
			receiptSignatureBytes: MAC_EXECUTION_RECEIPT_SIGNATURE_BYTES,
		});
		expect(accepted.ok).toBe(false);
		if (accepted.ok) return;
		expect(accepted.message).toContain("exited code=69");
		expect(accepted.message).toContain("rig said this on the way out");
	});

	it("a Mac write deadline names the child's death too", async () => {
		const neverCompletes = {
			write: (_chunk: unknown, _callback: (error?: Error) => void) => true,
		} as unknown as PassThrough;
		const channel = new MacCohortChannel({
			controllerToMac: neverCompletes,
			macToController: new PassThrough(),
			stagedMacPublicRaw32: new Uint8Array(32),
			deadlineMs: 200,
			childDiagnostics: exitedDiagnostics(70, "mac said this on the way out"),
		});
		const opened = await channel.openExecution(
			new TextEncoder().encode('{"schema":"cross-supervisor-execution/v1"}'),
		);
		expect(opened.ok).toBe(false);
		if (opened.ok) return;
		expect(opened.message).toContain("exited code=70");
		expect(opened.message).toContain("mac said this on the way out");
	});

	it("MacCohortChannel carries the Mac child's post-mortem into its refusal", async () => {
		const channel = new MacCohortChannel({
			controllerToMac: new PassThrough(),
			macToController: new PassThrough(),
			stagedMacPublicRaw32: new Uint8Array(32),
			deadlineMs: 5_000,
			childDiagnostics: exitedDiagnostics(70, "mac supervisor said this"),
		});
		const startedAt = Date.now();
		const opened = await channel.openExecution(
			new TextEncoder().encode('{"schema":"cross-supervisor-execution/v1"}'),
		);
		const elapsed = Date.now() - startedAt;
		expect(opened.ok).toBe(false);
		if (opened.ok) return;
		expect(opened.message).toContain("exited code=70");
		expect(opened.message).toContain("mac supervisor said this");
		expect(elapsed).toBeLessThan(1_000);
	});
});

// ---------------------------------------------------------------------------
// Amendment C4 line 76: "Ordinary A5 traffic must also follow the base plan's
// signed server lifecycle."
//
// Before this slice `CohortRigChannel.spawnServer` was legal at exactly one
// stage, `cohort-accepted`, and an ordinary A5 arm never reaches it: it has no
// grant to accept. The fifth live A5 run failed every arm on
// `rig server spawn (COHORT_NOT_READY)` for that reason alone. The base plan's
// own frames already carry the nulls the ordinary arm needs -- plan 795 types
// `cohortGrantSha256: Sha256Hex | null` on the spawn, 858-860 type all three
// baseline joins nullable, and the capture's barrier is nullable -- so what was
// missing was a sender, not a contract.
// ---------------------------------------------------------------------------

const ORDINARY_SPAWN_REQUEST = {
	cohortGrantSha256: null,
	serverEntrypointSha256: RIG_HEX("4"),
	bunSha256: RIG_HEX("5"),
	addonSha256: RIG_HEX("6"),
	stagedServerLaunchRecordBytes: STAGED_LAUNCH_RECORD_BYTES,
	bindPort: 4433,
	transport: "wt",
	serverArgv: ["server.ts", "--transport=wt", "--mode=fanout-cohort"],
} as const;

describe("remote-supervisor: the ordinary A5 arm's server lifecycle", () => {
	it("spawns, takes a baseline, captures and tears down with no cohort anywhere", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);

		const accepted = await acceptExecutionOn(channel);
		if (!accepted.ok) throw new Error(`${accepted.code}: ${accepted.message}`);
		expect(channel.stage).toBe("execution-accepted");

		// SERVER_READY straight off the acceptance: no cohort accept between.
		const spawned = await channel.spawnServer(ORDINARY_SPAWN_REQUEST);
		if (!spawned.ok) throw new Error(`${spawned.code}: ${spawned.message}`);
		expect(channel.stage).toBe("server-ready");
		expect(spawned.value.childPid).toBe(9_001);
		expect(channel.cohortGrantSha256).toBeNull();

		// LINUX_BASELINE with all three joins null, which is what the rig
		// requires of an arm that drained no warmup.
		const baseline = await channel.measureStart({
			warmupCompleteSha256: null,
			rigWarmupDrainedReceiptSha256: null,
		});
		if (!baseline.ok) throw new Error(`${baseline.code}: ${baseline.message}`);
		expect(channel.stage).toBe("baseline-taken");

		// LINUX_CAPTURE follows the baseline directly: no barrier exists.
		const captured = await channel.stopAndCapture({
			macStopIssuedAtNs: "1700000000000000009",
			drainDeadlineMs: 10_000,
		});
		if (!captured.ok) throw new Error(`${captured.code}: ${captured.message}`);
		expect(channel.stage).toBe("captured");

		const stopped = await channel.teardownServer();
		if (!stopped.ok) throw new Error(`${stopped.code}: ${stopped.message}`);
		expect(channel.stage).toBe("server-stopped");

		// The four §5 frames the ordinary arm owes, and not one of the three
		// cohort ones.
		expect(wire.seen.map((frame) => frame.schema)).toEqual([
			"rig-accept-execution-request/v1",
			"rig-spawn-server-request/v1",
			"rig-measure-start-request/v1",
			"rig-stop-and-capture-request/v1",
			"rig-teardown-server-request/v1",
		]);
		const spawnFrame = wire.seen[1] as Record<string, unknown>;
		expect(spawnFrame.cohortGrantSha256).toBeNull();
		const baselineFrame = wire.seen[2] as Record<string, unknown>;
		expect(baselineFrame.cohortGrantSha256).toBeNull();
		expect(baselineFrame.warmupCompleteSha256).toBeNull();
		expect(baselineFrame.rigWarmupDrainedReceiptSha256).toBeNull();
		expect(
			(wire.seen[3] as Record<string, unknown>).cohortStartBarrierSha256,
		).toBeNull();
	});

	it("refuses the cohort steps once the spawn has fixed the arm as ordinary", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const accepted = await acceptExecutionOn(channel);
		if (!accepted.ok) throw new Error(`${accepted.code}: ${accepted.message}`);
		const spawned = await channel.spawnServer(ORDINARY_SPAWN_REQUEST);
		if (!spawned.ok) throw new Error(`${spawned.code}: ${spawned.message}`);

		// The warmup pair belongs to a cohort this arm never accepted.
		const begun = await channel.beginWarmup({
			cohortWarmupEpochBytes: MAC_WARMUP_EPOCH_BYTES,
			cohortWarmupEpochSignatureBytes: MAC_WARMUP_EPOCH_SIGNATURE_BYTES,
		});
		expect(begun.ok).toBe(false);
		// A baseline that names a drain this arm never took.
		const named = await channel.measureStart({
			warmupCompleteSha256: RIG_HEX("7"),
			rigWarmupDrainedReceiptSha256: RIG_HEX("8"),
		});
		expect(named.ok).toBe(false);
		if (named.ok) throw new Error("unreachable");
		expect(named.code).toBe("CROSS_SUPERVISOR_MISMATCH");
		// Only the spawn reached the wire; both refusals are before any frame.
		expect(wire.seen.map((frame) => frame.schema)).toEqual([
			"rig-accept-execution-request/v1",
			"rig-spawn-server-request/v1",
		]);
	});

	it("refuses an ordinary spawn on a cohort arm and a cohort spawn on an ordinary one", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const accepted = await acceptExecutionOn(channel);
		if (!accepted.ok) throw new Error(`${accepted.code}: ${accepted.message}`);

		// A spawn that names a grant this channel never delivered.
		const named = await channel.spawnServer(SPAWN_REQUEST);
		expect(named.ok).toBe(false);
		if (named.ok) throw new Error("unreachable");
		expect(named.code).toBe("COHORT_NOT_READY");

		const cohortAccepted = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		if (!cohortAccepted.ok) {
			throw new Error(`${cohortAccepted.code}: ${cohortAccepted.message}`);
		}
		// And the mirror: a null-grant spawn on an arm that did accept one.
		const bare = await channel.spawnServer(ORDINARY_SPAWN_REQUEST);
		expect(bare.ok).toBe(false);
		if (bare.ok) throw new Error("unreachable");
		expect(bare.code).toBe("COHORT_NOT_READY");
		expect(wire.seen.map((frame) => frame.schema)).toEqual([
			"rig-accept-execution-request/v1",
			"rig-accept-cohort-request/v1",
		]);
	});

	it("keeps the cohort arm's own baseline and capture stages unchanged", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const walked = await runLifecycle(channel);
		expect(walked.at).toBe("complete");
		expect(channel.stage).toBe("captured");
	});
});

describe("remote-supervisor: a refused spawn does not fix the arm", () => {
	// `spawnServer` decides which §5 order the channel walks. If it recorded
	// that decision before the spawn actually succeeded, a spawn refused after
	// the decision -- a malformed staged launch record, an oversize one, or a
	// refusal from the rig -- would leave the channel walking the ordinary
	// order at a stage where `acceptCohort` is still legal. `advance` throws on
	// a stage outside the arm's order, so the next honest cohort accept would
	// raise instead of returning a named refusal.
	it("leaves a cohort accept legal after an ordinary spawn was refused", async () => {
		const keys = generateEd25519KeyPair();
		const wire = serveScriptedRig(honestRig(keys));
		const channel = channelFor(wire, keys.publicRaw32);
		const accepted = await acceptExecutionOn(channel);
		if (!accepted.ok) throw new Error(`${accepted.code}: ${accepted.message}`);

		const refused = await channel.spawnServer({
			...ORDINARY_SPAWN_REQUEST,
			stagedServerLaunchRecordBytes: new TextEncoder().encode("{"),
		});
		expect(refused.ok).toBe(false);
		expect(channel.stage).toBe("execution-accepted");
		// Nothing reached the wire: the refusal is before the frame.
		expect(wire.seen.map((frame) => frame.schema)).toEqual([
			"rig-accept-execution-request/v1",
		]);

		const cohortAccepted = await channel.acceptCohort({
			cohortGrantBytes: MAC_COHORT_GRANT_BYTES,
			cohortGrantSignatureBytes: MAC_COHORT_GRANT_SIGNATURE_BYTES,
		});
		if (!cohortAccepted.ok) {
			throw new Error(`${cohortAccepted.code}: ${cohortAccepted.message}`);
		}
		expect(channel.stage).toBe("cohort-accepted");
	});
});
