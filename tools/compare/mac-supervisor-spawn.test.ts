/**
 * S8b — the Mac supervisor as a *process*, across the uid boundary.
 *
 * Design: `docs/superpowers/plans/deviations/2026-09-02-cohort-runtime-integration-design.md`
 * §2.9(4) (the spawn form), (4a) rows 10 and 13-15, (4d) the three-stage
 * shutdown, (4e) the process group and the liveness probe.
 *
 * **Tier.** `.scratch/b35r3-notes/S0-host-probe.md` measured this host as
 * **tier A**: `sudo -n -u _wtcompare true` exits 0, so every boundary test
 * below runs the real uid crossing. The tier is re-measured here at module
 * load rather than assumed, and on a tier-B host the boundary tests skip with
 * a named reason string printed once — never silently pass.
 *
 * **What is stubbed and what is not.** The binary these tests exec is a bash
 * stub, not `comparison-supervisor`, because the Mac cohort dispatch arms and
 * the `--cohort-mac-signing-key-fd` / `--cohort-staged-rig-public-key-fd`
 * options are S5-MAC-RS's and do not exist in the binary at this HEAD
 * (`crates/native/src/bin/comparison-supervisor.rs:926` registers exactly the
 * two *rig* cohort descriptors, and nothing else). Everything this slice owns
 * is real: real `sudo`, a real `_wtcompare` process, real inherited
 * descriptors, real pipes, a real process group and a real `kill(2)`.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertDisjointProcessGroup,
	buildMacSupervisorSpawnPlan,
	buildRigSupervisorWrapperScript,
	type ControlCommandResult,
	controllerProcessGroupId,
	MAC_SUPERVISOR_DEFAULT_USER,
	processGroupIdOf,
	readGroupLivenessProbe,
	type SupervisorHandle,
	type SupervisorSubprocess,
	spawnMacSupervisor,
	stopSupervisor,
} from "./remote-supervisor.ts";

// ---------------------------------------------------------------------------
// Tier
// ---------------------------------------------------------------------------

const TARGET_USER = MAC_SUPERVISOR_DEFAULT_USER;

function measureTier(): { readonly tier: "a" | "b"; readonly reason: string } {
	const probe = spawnSync("/usr/bin/sudo", ["-n", "-u", TARGET_USER, "true"], {
		encoding: "utf8",
	});
	if (probe.status === 0) {
		return { tier: "a", reason: `sudo -n -u ${TARGET_USER} true exited 0` };
	}
	return {
		tier: "b",
		reason:
			`TIER B — the uid boundary is NOT exercised on this host: ` +
			`sudo -n -u ${TARGET_USER} true exited ${String(probe.status)} ` +
			`(${(probe.stderr ?? "").trim()}). The boundary tests are skipped, ` +
			`not passed.`,
	};
}

const TIER = measureTier();
const tierA = TIER.tier === "a";
if (!tierA) console.warn(`mac-supervisor-spawn.test.ts: ${TIER.reason}`);

/** Every fixture root this file made, removed at the end. */
const MADE: string[] = [];

afterAll(() => {
	for (const dir of MADE) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// throwaway fixtures; a leftover is not a test failure
		}
	}
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The key *bytes* the argv test proves never cross. Distinctive enough that a
 * substring search over the whole argv is a real assertion.
 */
const FAKE_KEY_BYTES = "S8B-FAKE-KEY-MATERIAL-3f9a2c17-not-a-real-pkcs8";

interface Fixture {
	readonly root: string;
	readonly authorityFile: string;
	readonly authorityDigestFile: string;
	readonly campaignRootDir: string;
	readonly stagingRootDir: string;
	readonly macSigningKeyPath: string;
	readonly stagedRigPublicKeyPath: string;
	readonly binaryPath: string;
}

function run(argv: readonly string[]): {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
} {
	const [command, ...rest] = argv;
	const out = spawnSync(command as string, rest, { encoding: "utf8" });
	return {
		status: out.status ?? -1,
		stdout: out.stdout ?? "",
		stderr: (out.stderr ?? "").trim(),
	};
}

/**
 * A throwaway tree the *target* uid can traverse, at the §2.9(4a) target
 * modes: campaign-root `2770` group `staff` (set with `/bin/chmod`, because
 * Bun's `chmodSync` silently drops the setgid bit — S0 finding B), the rest
 * `0755`/`0644`.
 *
 * `/tmp` rather than `tmpdir()`: the per-user `tmpdir()` is `drwx------`, which
 * is exactly the NEW-1 finding §2.9(4) form (iv) exists to answer.
 */
function makeFixture(stub: (campaignRootDir: string) => string): Fixture {
	const root = mkdtempSync("/tmp/s8b-mac-supervisor-");
	MADE.push(root);
	const campaignRootDir = join(root, "campaign-root");
	const stagingRootDir = join(root, "staging-root");
	mkdirSync(campaignRootDir);
	mkdirSync(stagingRootDir);
	const authorityFile = join(root, "authority.json");
	const authorityDigestFile = join(root, "authority-digest.bin");
	const macSigningKeyPath = join(root, "campaign.mac.pk8");
	const stagedRigPublicKeyPath = join(
		stagingRootDir,
		"rig-supervisor-ed25519.pub",
	);
	const binaryPath = join(root, "supervisor-stub");
	writeFileSync(authorityFile, '{"schema":"fixture"}\n');
	writeFileSync(authorityDigestFile, "digest\n");
	writeFileSync(macSigningKeyPath, `${FAKE_KEY_BYTES}\n`);
	writeFileSync(stagedRigPublicKeyPath, "public-half\n");
	writeFileSync(binaryPath, stub(campaignRootDir));
	run(["/usr/bin/chgrp", "staff", root, campaignRootDir, stagingRootDir]);
	chmodSync(root, 0o755);
	chmodSync(stagingRootDir, 0o755);
	chmodSync(authorityFile, 0o644);
	chmodSync(authorityDigestFile, 0o644);
	chmodSync(macSigningKeyPath, 0o644);
	chmodSync(stagedRigPublicKeyPath, 0o644);
	chmodSync(binaryPath, 0o755);
	run(["/bin/chmod", "2770", campaignRootDir]);
	return {
		root,
		authorityFile,
		authorityDigestFile,
		campaignRootDir,
		stagingRootDir,
		macSigningKeyPath,
		stagedRigPublicKeyPath,
		binaryPath,
	};
}

/**
 * A stub that behaves the way the serve loop does at
 * `comparison-supervisor.rs:604-606`: it answers on fd 1, then reads its
 * control channel to EOF and writes a final summary frame on the way out.
 * `$$` is the process itself, because the wrapper `exec`s it.
 */
function cooperativeStub(campaignRootDir: string): string {
	const state = JSON.stringify(join(campaignRootDir, "supervisor-state.json"));
	return `#!/bin/bash
echo "{\\"kind\\":\\"stub-ready/v1\\",\\"pid\\":$$,\\"bun\\":\\"\${COMPARISON_SUPERVISOR_BUN_PATH:-<unset>}\\",\\"cwd\\":\\"$(pwd)\\",\\"umask\\":\\"$(umask)\\",\\"key\\":\\"$(/bin/cat <&7)\\"}"
: > ${state}
/bin/cat >/dev/null
echo '{"kind":"stub-teardown-summary/v1","reaped":true}'
exit 0
`;
}

/** A stub that ignores its control channel closing — the stage-2 failure case. */
function stubbornStub(): string {
	return `#!/bin/bash
echo '{"kind":"stub-ready/v1"}'
/bin/cat >/dev/null
while :; do /bin/sleep 1; done
`;
}

function spawnOptionsFor(fixture: Fixture) {
	return {
		binaryPath: fixture.binaryPath,
		bunExecutablePath: process.execPath,
		bootstrap: {
			authority: { fd: 3, label: "authority" },
			authorityDigest: { fd: 4, label: "authority-digest" },
			campaignRoot: { fd: 5, label: "campaign-root" },
			stagingRoot: { fd: 6, label: "staging-root" },
		},
		control: {
			controlIn: { fd: 0, label: "control-in" },
			controlOut: { fd: 1, label: "control-out" },
		},
		cohort: {
			macSigningKey: {
				fd: 7,
				label: "cohort-mac-signing-key",
				path: fixture.macSigningKeyPath,
			},
			stagedRigPublicKey: {
				fd: 8,
				label: "cohort-staged-rig-public-key",
				path: fixture.stagedRigPublicKeyPath,
			},
		},
		localPaths: {
			authorityFile: fixture.authorityFile,
			authorityDigestFile: fixture.authorityDigestFile,
			campaignRootDir: fixture.campaignRootDir,
			stagingRootDir: fixture.stagingRootDir,
		},
	} as const;
}

async function bootStub(fixture: Fixture): Promise<SupervisorHandle> {
	const spawned = await spawnMacSupervisor(spawnOptionsFor(fixture));
	if (!spawned.ok) {
		throw new Error(
			`spawnMacSupervisor refused ${spawned.code}: ${spawned.message}`,
		);
	}
	return spawned.handle;
}

/** Read what the supervisor writes, without closing anything. */
function tap(handle: SupervisorHandle): { readonly text: () => string } {
	const chunks: Buffer[] = [];
	handle.supervisorToController?.on("data", (chunk: Buffer) => {
		chunks.push(Buffer.from(chunk));
	});
	return { text: () => Buffer.concat(chunks).toString("utf8") };
}

async function until(
	predicate: () => boolean,
	deadlineMs: number,
): Promise<boolean> {
	const until = Date.now() + deadlineMs;
	while (Date.now() < until) {
		if (predicate()) return true;
		await Bun.sleep(20);
	}
	return predicate();
}

/** Records every control command the shutdown would have run. */
function recordingRunner(result: ControlCommandResult) {
	const calls: (readonly string[])[] = [];
	return {
		calls,
		run: (argv: readonly string[]): ControlCommandResult => {
			calls.push(argv);
			return result;
		},
	};
}

// ---------------------------------------------------------------------------
// The spawn form — §2.9(4) form (iv)
// ---------------------------------------------------------------------------

describe("S8b: the spawn form", () => {
	it("the_spawn_argv_carries_paths_and_no_key_material", () => {
		const fixture = makeFixture(cooperativeStub);
		const plan = buildMacSupervisorSpawnPlan(spawnOptionsFor(fixture));
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;

		// The key bytes are really on disk, so their absence below is an
		// assertion and not a tautology.
		expect(readFileSync(fixture.macSigningKeyPath, "utf8")).toContain(
			FAKE_KEY_BYTES,
		);

		expect(plan.plan.command).toBe("/usr/bin/sudo");
		expect(plan.plan.argv.slice(0, 5)).toEqual([
			"-n",
			"-u",
			TARGET_USER,
			"/bin/bash",
			"-c",
		]);
		expect(plan.plan.argv).toHaveLength(6);
		expect(plan.plan.argv[5]).toBe(plan.plan.script);
		expect(plan.plan.tier).toBe("a");

		const wholeArgv = [plan.plan.command, ...plan.plan.argv].join("\0");
		// Paths cross...
		expect(wholeArgv).toContain(fixture.macSigningKeyPath);
		expect(wholeArgv).toContain(fixture.stagedRigPublicKeyPath);
		expect(wholeArgv).toContain(fixture.authorityFile);
		expect(wholeArgv).toContain(process.execPath);
		// ...bytes do not.
		expect(wholeArgv).not.toContain(FAKE_KEY_BYTES);
	});

	it("the script carries rows 10 and 13-15 and the two cohort descriptors", () => {
		const fixture = makeFixture(cooperativeStub);
		const plan = buildMacSupervisorSpawnPlan(spawnOptionsFor(fixture));
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		const lines = plan.plan.script.split("\n");
		expect(lines).toContain("cd /");
		expect(lines).toContain("umask 007");
		// Row 10: exactly one export, and it is the bun path.
		const exports = lines.filter((line) => line.startsWith("export "));
		expect(exports).toHaveLength(1);
		expect(exports[0]).toBe(
			`export COMPARISON_SUPERVISOR_BUN_PATH='${process.execPath}'`,
		);
		// Row 14: the one PATH lookup is spelled absolutely.
		expect(plan.plan.script).toContain("exec 3< <(/bin/cat -- ");
		expect(plan.plan.script).not.toContain("<(cat -- ");
		// The two campaign-scoped cohort descriptors, opened by the target uid.
		expect(plan.plan.script).toContain(`exec 7<'${fixture.macSigningKeyPath}'`);
		expect(plan.plan.script).toContain(
			`exec 8<'${fixture.stagedRigPublicKeyPath}'`,
		);
		expect(plan.plan.script).toContain("--cohort-mac-signing-key-fd 7");
		expect(plan.plan.script).toContain("--cohort-staged-rig-public-key-fd 8");
	});

	it("refuses a cohort descriptor that collides with a bootstrap fd", () => {
		const fixture = makeFixture(cooperativeStub);
		const base = spawnOptionsFor(fixture);
		const plan = buildMacSupervisorSpawnPlan({
			...base,
			cohort: {
				...base.cohort,
				macSigningKey: { ...base.cohort.macSigningKey, fd: 4 },
			},
		});
		expect(plan.ok).toBe(false);
		if (plan.ok) return;
		expect(plan.code).toBe("SPAWN_FD_DUPLICATE");
	});

	it("the_wrapper_never_becomes_a_filesystem_object", async () => {
		const fixture = makeFixture(cooperativeStub);
		const before = new Set(readdirSync(tmpdir()));
		if (!tierA) {
			// Tier B: the pure half still holds — the script is argv, and no
			// helper in the module writes it anywhere.
			const plan = buildMacSupervisorSpawnPlan(spawnOptionsFor(fixture));
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.plan.argv.at(-1)).toBe(plan.plan.script);
			return;
		}
		const handle = await bootStub(fixture);
		const added = readdirSync(tmpdir()).filter((name) => !before.has(name));
		expect(added.filter((name) => name.includes("mac-supervisor"))).toEqual([]);
		expect(added.filter((name) => name.startsWith("wtb-"))).toEqual([]);
		await stopSupervisor(handle, 3_000);
	});

	it("the rig wrapper script is byte-identical without a uid crossing", () => {
		const built = buildRigSupervisorWrapperScript({
			binaryPath: "/opt/webtransport/target/release/comparison-supervisor",
			bunExecutablePath: "/usr/bin/bun",
			bootstrap: {
				authority: { fd: 3, label: "authority" },
				authorityDigest: { fd: 4, label: "authority-digest" },
				campaignRoot: { fd: 5, label: "campaign-root" },
				stagingRoot: { fd: 6, label: "staging-root" },
			},
			control: {
				controlIn: { fd: 0, label: "control-in" },
				controlOut: { fd: 1, label: "control-out" },
			},
			rigBinaryPath: "/opt/webtransport/target/release/comparison-supervisor",
			rigPaths: {
				authorityFile: "/var/staged/c/authority.json",
				authorityDigestFile: "/var/staged/c/authority-digest.bin",
				campaignRootDir: "/var/campaign/c",
				stagingRootDir: "/var/staged/c",
			},
		});
		expect(built.ok).toBe(true);
		if (!built.ok) return;
		// The rig path crosses no uid boundary: no `cd /`, no `umask`, no
		// `export`, and `cat` keeps the spelling the rig has always used.
		expect(built.script).toBe(`#!/usr/bin/env bash
set -eu
authority_fd=3
authority_digest_fd=4
campaign_root_fd=5
staging_root_fd=6
exec 3< <(cat -- '/var/staged/c/authority.json')
exec 4<'/var/staged/c/authority-digest.bin'
exec 5<'/var/campaign/c'
exec 6<'/var/staged/c'
exec '/opt/webtransport/target/release/comparison-supervisor' \\
  --authority-fd "\${authority_fd}" \\
  --authority-digest-fd "\${authority_digest_fd}" \\
  --campaign-root-fd "\${campaign_root_fd}" \\
  --staging-root-fd "\${staging_root_fd}" \\
  --control-in-fd 0 \\
  --control-out-fd 1
`);
	});
});

// ---------------------------------------------------------------------------
// The tier-B seam — §2.9(4b)
// ---------------------------------------------------------------------------

describe("S8b: the two-condition tier-B seam", () => {
	const withSeamEnv = <T>(value: string | undefined, body: () => T): T => {
		const previous = process.env.COMPARISON_MAC_SUPERVISOR_UID_SEAM;
		if (value === undefined)
			delete process.env.COMPARISON_MAC_SUPERVISOR_UID_SEAM;
		else process.env.COMPARISON_MAC_SUPERVISOR_UID_SEAM = value;
		try {
			return body();
		} finally {
			if (previous === undefined)
				delete process.env.COMPARISON_MAC_SUPERVISOR_UID_SEAM;
			else process.env.COMPARISON_MAC_SUPERVISOR_UID_SEAM = previous;
		}
	};

	it("refuses the controller uid when only the scratch-root condition holds", () => {
		const fixture = makeFixture(cooperativeStub);
		withSeamEnv(undefined, () => {
			const plan = buildMacSupervisorSpawnPlan({
				...spawnOptionsFor(fixture),
				controllerUidSeam: { campaignScratchRoot: fixture.root },
			});
			expect(plan.ok).toBe(false);
			if (plan.ok) return;
			expect(plan.code).toBe("SPAWN_UID_SEAM_REFUSED");
			expect(plan.message).toContain("COMPARISON_MAC_SUPERVISOR_UID_SEAM");
		});
	});

	it("refuses the controller uid when only the environment condition holds", () => {
		const fixture = makeFixture(cooperativeStub);
		withSeamEnv("1", () => {
			const plan = buildMacSupervisorSpawnPlan({
				...spawnOptionsFor(fixture),
				controllerUidSeam: { campaignScratchRoot: "/var/db/webtransport-bun" },
			});
			expect(plan.ok).toBe(false);
			if (plan.ok) return;
			expect(plan.code).toBe("SPAWN_UID_SEAM_REFUSED");
			expect(plan.message).toContain("outside the campaign scratch root");
		});
	});

	it("takes the controller uid only when both conditions hold", () => {
		const fixture = makeFixture(cooperativeStub);
		withSeamEnv("1", () => {
			const plan = buildMacSupervisorSpawnPlan({
				...spawnOptionsFor(fixture),
				controllerUidSeam: { campaignScratchRoot: fixture.root },
			});
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(plan.plan.tier).toBe("b");
			expect(plan.plan.command).toBe("/bin/bash");
			expect(plan.plan.argv[0]).toBe("-c");
		});
	});

	it("a spawn with no cohort descriptors stays on the controller uid", () => {
		const fixture = makeFixture(cooperativeStub);
		const { cohort: _cohort, ...withoutCohort } = spawnOptionsFor(fixture);
		const plan = buildMacSupervisorSpawnPlan(withoutCohort);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		// No private key is on any descriptor, so nothing crosses and there is
		// nothing for the boundary to protect (§2.9(4b), "Phase A is unaffected").
		expect(plan.plan.tier).toBe("phase-a");
		expect(plan.plan.command).toBe("/bin/bash");
		expect(plan.plan.script).not.toContain("exec 7<");
		expect(plan.plan.script).not.toContain("umask 007");
	});
});

// ---------------------------------------------------------------------------
// The process group — §2.9(4e)
// ---------------------------------------------------------------------------

describe("S8b: the process group", () => {
	it("the_liveness_probe_reads_eperm_as_gone", () => {
		// The three outcomes, with the exact stderr macOS produces (measured:
		// `/bin/kill -0 -- -99999` and `sudo -n -u _wtcompare /bin/kill -0 $$`).
		expect(readGroupLivenessProbe({ exitCode: 0, stderr: "" })).toBe("alive");
		expect(
			readGroupLivenessProbe({
				exitCode: 1,
				stderr: "kill: -99999: No such process",
			}),
		).toBe("gone");
		expect(
			readGroupLivenessProbe({
				exitCode: 1,
				stderr: "kill: 91702: Operation not permitted",
			}),
		).toBe("gone");
	});

	it("dropping_detached_is_refused_at_spawn", () => {
		// A real non-detached child, so the numbers the assertion refuses are
		// the numbers `nodeSpawn` without `detached` actually produces.
		const plain = nodeSpawn("/bin/sleep", ["5"], { stdio: "ignore" });
		try {
			const pid = plain.pid ?? -1;
			expect(pid).toBeGreaterThan(0);
			const pgid = processGroupIdOf(pid);
			expect(pgid).toBe(controllerProcessGroupId());
			const refusal = assertDisjointProcessGroup({ pid, pgid });
			expect(refusal.ok).toBe(false);
			if (refusal.ok) return;
			expect(refusal.code).toBe("SPAWN_PROCESS_GROUP_NOT_DISJOINT");
		} finally {
			plain.kill("SIGTERM");
		}
	});

	it.skipIf(!tierA)(
		"the_mac_supervisor_group_is_disjoint_from_the_controllers",
		async () => {
			const fixture = makeFixture(cooperativeStub);
			const handle = await bootStub(fixture);
			try {
				expect(handle.pgid).toBe(handle.pid);
				expect(handle.pgid).not.toBe(controllerProcessGroupId());
				// Read from the kernel, not from the spawn option.
				expect(processGroupIdOf(handle.pid)).toBe(handle.pgid);
				expect(assertDisjointProcessGroup(handle).ok).toBe(true);
			} finally {
				await stopSupervisor(handle, 3_000);
			}
		},
	);
});

// ---------------------------------------------------------------------------
// Shutdown and reap — §2.9(4d)
// ---------------------------------------------------------------------------

describe("S8b: shutdown and reap", () => {
	it.skipIf(!tierA)(
		"closing_the_control_channel_stops_the_supervisor_without_a_signal",
		async () => {
			const fixture = makeFixture(cooperativeStub);
			const handle = await bootStub(fixture);
			const forced = recordingRunner({ exitCode: 0, stderr: "" });
			const stopped = await stopSupervisor(handle, 5_000, {
				runControlCommand: forced.run,
			});
			expect(stopped.ok).toBe(true);
			if (!stopped.ok) return;
			expect(stopped.stoppedBy).toBe("control-channel-eof");
			expect(stopped.reaped).toBe(true);
			expect(stopped.exitCode).toBe(0);
			// No signal was issued at all: the forced stage never ran.
			expect(forced.calls).toEqual([]);
			// The final frame was RECEIVED and its content checked — a stop that
			// tore down the output channel would pass on the broken-pipe path.
			const finalText = Buffer.from(stopped.finalBytes).toString("utf8");
			expect(finalText).toContain('"kind":"stub-teardown-summary/v1"');
			expect(finalText).toContain('"reaped":true');
		},
	);

	it.skipIf(!tierA)(
		"stop_supervisor_reports_not_reaped_when_the_process_survives",
		async () => {
			const fixture = makeFixture(() => stubbornStub());
			const handle = await bootStub(fixture);
			// A host whose sudoers did not permit stage 3: the forced stage runs
			// and changes nothing, and the group stays alive.
			const inert = recordingRunner({ exitCode: 0, stderr: "" });
			const stopped = await stopSupervisor(handle, 1_000, {
				runControlCommand: inert.run,
				forcedDeadlineMs: 500,
			});
			expect(stopped.ok).toBe(false);
			if (stopped.ok) return;
			expect(stopped.code).toBe("SUPERVISOR_NOT_REAPED");
			expect(stopped.stoppedBy).toBe("forced-group-stop");
			expect(inert.calls.length).toBeGreaterThan(0);

			// Now stop it for real, which also proves stage 3 works on this host.
			const forReal = await stopSupervisor(handle, 500);
			expect(forReal.ok).toBe(true);
			if (!forReal.ok) return;
			expect(forReal.stoppedBy).toBe("forced-group-stop");
			expect(forReal.reaped).toBe(true);
		},
	);

	it("no_sigkill_is_ever_sent_to_the_sudo_pid", async () => {
		// A synthetic handle whose process never exits, so every stage runs.
		const signals: (NodeJS.Signals | number | undefined)[] = [];
		const subprocess: SupervisorSubprocess = {
			pid: 424242,
			exitCode: null,
			kill(signal) {
				signals.push(signal);
				return true;
			},
			exited: new Promise<number>(() => {}),
		};
		const handle: SupervisorHandle = {
			pid: 424242,
			pgid: 424242,
			host: "mac",
			subprocess,
			bootstrapFds: [],
			controlParentFds: [],
			uidCrossing: { targetUser: TARGET_USER },
		};
		const runner = recordingRunner({ exitCode: 0, stderr: "" });
		const stopped = await stopSupervisor(handle, 200, {
			runControlCommand: runner.run,
			forcedDeadlineMs: 200,
		});
		expect(stopped.ok).toBe(false);
		// Nothing was signalled through the sudo pid, by any signal.
		expect(signals).toEqual([]);
		// Every forced-stage command addresses the GROUP, as the target uid.
		expect(runner.calls.length).toBeGreaterThan(0);
		for (const argv of runner.calls) {
			expect(argv.slice(0, 5)).toEqual([
				"/usr/bin/sudo",
				"-n",
				"-u",
				TARGET_USER,
				"/bin/kill",
			]);
			expect(argv.at(-1)).toBe("-424242");
			expect(argv).not.toContain("424242");
		}
		const sent = runner.calls.map((argv) => argv[5]);
		expect(sent).toContain("-TERM");
		expect(sent).toContain("-KILL");
	});

	it("refuses to signal a group it shares with the controller", async () => {
		const subprocess: SupervisorSubprocess = {
			pid: 1,
			exitCode: null,
			kill: () => true,
			exited: new Promise<number>(() => {}),
		};
		const handle: SupervisorHandle = {
			pid: 1,
			pgid: controllerProcessGroupId(),
			host: "mac",
			subprocess,
			bootstrapFds: [],
			controlParentFds: [],
			uidCrossing: { targetUser: TARGET_USER },
		};
		const runner = recordingRunner({ exitCode: 0, stderr: "" });
		const stopped = await stopSupervisor(handle, 100, {
			runControlCommand: runner.run,
			forcedDeadlineMs: 100,
		});
		expect(stopped.ok).toBe(false);
		if (stopped.ok) return;
		expect(stopped.code).toBe("SUPERVISOR_NOT_REAPED");
		// The campaign-wide self-kill never happens, even if the pgid is wrong.
		expect(runner.calls).toEqual([]);
		expect(stopped.message).toContain("process group");
	});

	it("a handle that crosses no uid boundary is signalled by pid, never by group", async () => {
		// The rig's local `ssh` client: this process owns it and it shares the
		// controller's group, so the group must not be signalled — but the
		// process may be, with SIGTERM and never SIGKILL.
		const signals: (NodeJS.Signals | number | undefined)[] = [];
		let exitCode: number | null = null;
		const subprocess: SupervisorSubprocess = {
			pid: 424243,
			get exitCode() {
				return exitCode;
			},
			kill(signal) {
				signals.push(signal);
				exitCode = 0;
				return true;
			},
			exited: new Promise<number>(() => {}),
		};
		const handle: SupervisorHandle = {
			pid: 424243,
			pgid: controllerProcessGroupId(),
			host: "rig",
			subprocess,
			bootstrapFds: [],
			controlParentFds: [],
		};
		const runner = recordingRunner({ exitCode: 0, stderr: "" });
		const stopped = await stopSupervisor(handle, 100, {
			runControlCommand: runner.run,
			forcedDeadlineMs: 200,
		});
		expect(stopped.ok).toBe(true);
		if (!stopped.ok) return;
		expect(stopped.stoppedBy).toBe("forced-group-stop");
		expect(signals).toEqual(["SIGTERM"]);
		expect(signals).not.toContain("SIGKILL");
		expect(runner.calls).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The environment and the reverse crossing — rows 10 and 13
// ---------------------------------------------------------------------------

describe("S8b: what crosses the boundary", () => {
	it.skipIf(!tierA)(
		"the_supervisor_starts_under_sudo_with_an_emptied_parent_environment",
		async () => {
			// First, re-measure that `env_reset` is active here, so the export
			// line below is the only thing that can carry the variable.
			const sentinel = "/nonexistent/bun-sentinel";
			const env = run([
				"/usr/bin/sudo",
				"-n",
				"-u",
				TARGET_USER,
				"/usr/bin/env",
			]);
			expect(env.status).toBe(0);
			const leaked = spawnSync(
				"/usr/bin/sudo",
				["-n", "-u", TARGET_USER, "/usr/bin/env"],
				{
					encoding: "utf8",
					env: { ...process.env, COMPARISON_SUPERVISOR_BUN_PATH: sentinel },
				},
			);
			expect(leaked.stdout ?? "").not.toContain(sentinel);

			const fixture = makeFixture(cooperativeStub);
			const handle = await bootStub(fixture);
			const seen = tap(handle);
			try {
				expect(
					await until(() => seen.text().includes("stub-ready"), 5_000),
				).toBe(true);
				const ready = JSON.parse(seen.text().split("\n")[0] as string) as {
					bun: string;
					cwd: string;
					umask: string;
					key: string;
				};
				// Row 10: the variable arrived, and it arrived by the export line.
				expect(ready.bun).toBe(process.execPath);
				// Rows 15 and 13.
				expect(ready.cwd).toBe("/");
				expect(ready.umask).toBe("0007");
				// Row 5: the key descriptor was opened by the target uid, and the
				// bytes reached the child through fd 7 and nothing else.
				expect(ready.key).toBe(FAKE_KEY_BYTES);
			} finally {
				await stopSupervisor(handle, 3_000);
			}
		},
	);

	it.skipIf(!tierA)("the_supervisor_creates_group_writable_files", async () => {
		const fixture = makeFixture(cooperativeStub);
		const handle = await bootStub(fixture);
		const statePath = join(fixture.campaignRootDir, "supervisor-state.json");
		try {
			expect(
				await until(() => {
					try {
						statSync(statePath);
						return true;
					} catch {
						return false;
					}
				}, 5_000),
			).toBe(true);
			const stat = statSync(statePath);
			// `umask 007` crossed: the controller can read back what the
			// supervisor wrote, which is what assembly depends on.
			expect(stat.mode & 0o777).toBe(0o660);
			expect(stat.gid).toBe(statSync(fixture.campaignRootDir).gid);
			expect(stat.uid).not.toBe(process.getuid?.());
			expect(readFileSync(statePath, "utf8")).toBe("");
		} finally {
			await stopSupervisor(handle, 3_000);
		}
	});
});
