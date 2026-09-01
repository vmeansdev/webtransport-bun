import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertNoPackageInstallationAfterPrepared,
	captureKnownHosts,
	collectHostIdentityPacket,
	type HostIdentityPacket,
	type HostOperationRequest,
	type HostOperationResult,
	type HostOperationRunner,
	type HostPreparationAuthority,
	prepareHosts,
	RecordedHostOperationRunner,
	strictScpArgs,
	strictSshArgs,
	validateHostIdentityPair,
	validateHostPreparationReceipt,
	waitForSshReadiness,
} from "./g6-c32-host.ts";
import type { JournalClock } from "./g6-c32-rig-journal.ts";
import {
	type DropletIdentity,
	validateDropletIdentity,
} from "./g6-c32-rig-model.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

class IncrementingClock implements JournalClock {
	#milliseconds = Date.parse("2026-08-30T12:00:00.000Z");

	wallNow(): string {
		const value = new Date(this.#milliseconds).toISOString();
		this.#milliseconds += 100;
		return value;
	}
}

function droplet(role: "server" | "generator"): DropletIdentity {
	return {
		id: role === "server" ? 101 : 102,
		role,
		name: `g6-c32-host-test-${role}`,
		tags: ["g6-c32-managed", "g6-c32-host-test"],
		region: "ams3",
		size: "c-32-intel",
		image: "ubuntu-24-04-x64",
		vpcUuid: "vpc-123",
		projectId: "project-123",
		sshKeyIds: [77],
		vcpus: 32,
		memoryMiB: 65_536,
		status: "active",
		createdAt: "2026-08-30T11:59:00.000Z",
		publicIpv4: role === "server" ? "203.0.113.10" : "203.0.113.11",
		privateIpv4: role === "server" ? "10.0.0.10" : "10.0.0.11",
	};
}

class FakeHostRunner implements HostOperationRunner {
	readonly calls: HostOperationRequest[] = [];
	readonly #clock: JournalClock;
	readonly #keyByIp: Map<string, string>;
	readonly #readinessFailures: Map<string, number>;

	constructor(options: {
		clock: JournalClock;
		keyByIp: ReadonlyMap<string, string>;
		readinessFailures?: ReadonlyMap<string, number>;
	}) {
		this.#clock = options.clock;
		this.#keyByIp = new Map(options.keyByIp);
		this.#readinessFailures = new Map(options.readinessFailures ?? []);
	}

	async execute(request: HostOperationRequest): Promise<HostOperationResult> {
		this.calls.push(request);
		const startedAt = this.#clock.wallNow();
		let stdout = "";
		let stderr = "";
		let status: HostOperationResult["status"] = {
			outcome: "SUCCEEDED",
			exitCode: 0,
			signal: null,
		};
		if (request.command === "ssh-keyscan") {
			const ip = request.args.at(-1) as string;
			stdout = this.#keyByIp.get(ip) ?? "";
			if (!stdout) {
				status = { outcome: "FAILED", exitCode: 1, signal: null };
				stderr = `no key for ${ip}`;
			}
		} else if (request.command === "ssh") {
			const target = request.args.find((arg) => arg.startsWith("root@"));
			if (!target) throw new Error("fake SSH call has no target");
			const remaining = this.#readinessFailures.get(target) ?? 0;
			if (remaining > 0) {
				this.#readinessFailures.set(target, remaining - 1);
				status = { outcome: "FAILED", exitCode: 255, signal: null };
				stderr = "connection refused";
			} else {
				stdout = "ready\n";
			}
		} else {
			throw new Error(`unexpected host command ${request.command}`);
		}
		return {
			stdout,
			stderr,
			status,
			startedAt,
			finishedAt: this.#clock.wallNow(),
			receiptPath: `/receipts/${request.operationId}.json`,
		};
	}
}

function makePaths(): {
	root: string;
	knownHostsPath: string;
	receiptPath: string;
} {
	const root = mkdtempSync(join(tmpdir(), "g6-c32-host-"));
	temporaryRoots.push(root);
	return {
		root,
		knownHostsPath: join(root, "known_hosts"),
		receiptPath: join(root, "known-hosts-receipt.json"),
	};
}

const serverKey =
	"203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIServerKeyMaterialForTests";
const generatorKey =
	"203.0.113.11 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGeneratorKeyMaterialTests";

const bundleSha256 = createHash("sha256").update("bundle bytes").digest("hex");
const nativeSha256 = "b".repeat(64);
const generatorSha256 = "c".repeat(64);

function preparationAuthority(root: string): HostPreparationAuthority {
	return {
		packages: {
			common: ["ca-certificates", "curl", "git", "unzip"],
			server: ["clang", "linux-tools-common"],
			generator: [],
		},
		bun: {
			version: "1.3.14",
			binaryPath: "/opt/g6/bin/bun",
			archiveUrl:
				"https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip",
			archiveSha256: "d".repeat(64),
		},
		rust: {
			toolchain: "1.95.0",
			rustcVersion: "rustc 1.95.0 (test 2026-08-01)",
			cargoVersion: "cargo 1.95.0 (test 2026-08-01)",
			installerUrl: "https://sh.rustup.rs",
			installerSha256: "e".repeat(64),
		},
		source: {
			commit: "1".repeat(40),
			tree: "2".repeat(40),
			bundlePath: join(root, "candidate.bundle"),
			bundleSha256,
			remoteBundlePath: "/opt/g6/run/candidate.bundle",
			remoteCheckoutPath: "/opt/g6/run/source",
			transferRef: "refs/heads/g6-c32-candidate",
		},
		artifacts: {
			nativeRemotePath:
				"/opt/g6/run/source/crates/native/webtransport-native.linux-x64-gnu.node",
			generatorRemotePath: "/opt/g6/run/source/target/release/mmo-client",
			nativeRetainedPath: join(root, "retained", "native.node"),
			generatorRetainedPath: join(root, "retained", "mmo-client"),
		},
		linuxSmoke: {
			remoteScriptPath: "/opt/g6/run/source/tools/load/g6-c32-linux-smoke.sh",
			remoteEvidenceRoot: "/opt/g6/run/linux-smoke",
			retainedEvidenceRoot: join(root, "retained", "linux-smoke"),
			unameBinaryPath: "/usr/bin/uname",
			timeoutBinaryPath: "/usr/bin/timeout",
			shards: 16,
			server: {
				boundedProbePath: "/opt/g6/run/source/target/probes/server-bounded",
				steeringProbePath: "/opt/g6/run/source/target/probes/server-steering",
				bpfProbePath: "/opt/g6/run/source/target/probes/server-bpf",
			},
			generator: {
				fixedPortProbePath:
					"/opt/g6/run/source/target/probes/generator-fixed-port",
				boundedProbePath: "/opt/g6/run/source/target/probes/generator-bounded",
			},
		},
	};
}

class SuccessfulPreparationRunner implements HostOperationRunner {
	readonly calls: HostOperationRequest[] = [];
	readonly #clock: JournalClock;

	constructor(clock: JournalClock) {
		this.#clock = clock;
	}

	async execute(request: HostOperationRequest): Promise<HostOperationResult> {
		this.calls.push(request);
		const startedAt = this.#clock.wallNow();
		let stdout = "ok\n";
		if (request.operationId.includes("hash-native")) {
			stdout = `${nativeSha256}  native.node\n`;
		} else if (request.operationId.includes("hash-generator")) {
			stdout = `${generatorSha256}  mmo-client\n`;
		}
		return {
			stdout,
			stderr: "",
			status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
			startedAt,
			finishedAt: this.#clock.wallNow(),
			receiptPath: `/receipts/${request.operationId}.json`,
		};
	}
}

describe("G6 c32 strict SSH host binding", () => {
	test("captures both exact public-IP keys and forces all later strict options", async () => {
		const paths = makePaths();
		const clock = new IncrementingClock();
		const runner = new FakeHostRunner({
			clock,
			keyByIp: new Map([
				[droplet("server").publicIpv4, `${serverKey}\n`],
				[droplet("generator").publicIpv4, `${generatorKey}\n`],
			]),
		});
		const captured = await captureKnownHosts({
			runId: "g6-c32-host-test",
			hosts: [droplet("server"), droplet("generator")],
			knownHostsPath: paths.knownHostsPath,
			receiptPath: paths.receiptPath,
			runner,
			clock,
			randomId: () => "known-hosts",
		});
		expect(readFileSync(paths.knownHostsPath, "utf8")).toBe(
			`${serverKey}\n${generatorKey}\n`,
		);
		expect(
			captured.entries.map(({ dropletId, publicIpv4 }) => [
				dropletId,
				publicIpv4,
			]),
		).toEqual([
			[101, "203.0.113.10"],
			[102, "203.0.113.11"],
		]);
		expect(captured.envelope.recordedAt).toMatch(/\.\d{3}Z$/);
		expect(existsSync(paths.receiptPath)).toBeTrue();

		const ssh = strictSshArgs(paths.knownHostsPath, "203.0.113.10", ["true"]);
		expect(ssh).toContain("-n");
		expect(ssh).toContain("BatchMode=yes");
		expect(ssh).toContain("StrictHostKeyChecking=yes");
		expect(ssh).toContain(`UserKnownHostsFile=${paths.knownHostsPath}`);
		const scp = strictScpArgs(paths.knownHostsPath, [
			"candidate.bundle",
			"root@203.0.113.10:/opt/g6/candidate.bundle",
		]);
		expect(scp).toContain("BatchMode=yes");
		expect(scp).toContain("StrictHostKeyChecking=yes");
		expect(scp).toContain(`UserKnownHostsFile=${paths.knownHostsPath}`);
	});

	test("bounds readiness retries and uses strict stdin-detached SSH every time", async () => {
		const paths = makePaths();
		writeFileSync(paths.knownHostsPath, `${serverKey}\n${generatorKey}\n`);
		const clock = new IncrementingClock();
		const runner = new FakeHostRunner({
			clock,
			keyByIp: new Map(),
			readinessFailures: new Map([
				["root@203.0.113.10", 2],
				["root@203.0.113.11", 0],
			]),
		});
		const readiness = await waitForSshReadiness({
			runId: "g6-c32-host-test",
			hosts: [droplet("server"), droplet("generator")],
			knownHostsPath: paths.knownHostsPath,
			runner,
			maxAttempts: 3,
			waitBetweenAttempts: async () => {},
		});
		expect(readiness.map(({ role, attempts }) => [role, attempts])).toEqual([
			["server", 3],
			["generator", 1],
		]);
		const sshCalls = runner.calls.filter(({ command }) => command === "ssh");
		expect(sshCalls).toHaveLength(4);
		expect(
			sshCalls.every(
				({ args }) =>
					args.includes("-n") &&
					args.includes("BatchMode=yes") &&
					args.includes("StrictHostKeyChecking=yes") &&
					args.includes(`UserKnownHostsFile=${paths.knownHostsPath}`),
			),
		).toBeTrue();

		const exhausted = new FakeHostRunner({
			clock,
			keyByIp: new Map(),
			readinessFailures: new Map([["root@203.0.113.10", 10]]),
		});
		await expect(
			waitForSshReadiness({
				runId: "g6-c32-host-test",
				hosts: [droplet("server")],
				knownHostsPath: paths.knownHostsPath,
				runner: exhausted,
				maxAttempts: 2,
				waitBetweenAttempts: async () => {},
			}),
		).rejects.toThrow(/2 attempts|readiness/i);
		expect(exhausted.calls).toHaveLength(2);
	});

	test("refuses duplicate keys and any change to an already-bound file", async () => {
		const duplicatePaths = makePaths();
		const clock = new IncrementingClock();
		const duplicate = new FakeHostRunner({
			clock,
			keyByIp: new Map([
				["203.0.113.10", `${serverKey}\n`],
				[
					"203.0.113.11",
					`${serverKey.replace("203.0.113.10", "203.0.113.11")}\n`,
				],
			]),
		});
		await expect(
			captureKnownHosts({
				runId: "g6-c32-host-test",
				hosts: [droplet("server"), droplet("generator")],
				knownHostsPath: duplicatePaths.knownHostsPath,
				receiptPath: duplicatePaths.receiptPath,
				runner: duplicate,
				clock,
				randomId: () => "duplicate",
			}),
		).rejects.toThrow(/duplicate/i);
		expect(existsSync(duplicatePaths.knownHostsPath)).toBeFalse();

		const changedPaths = makePaths();
		writeFileSync(
			changedPaths.knownHostsPath,
			`${serverKey}\n${generatorKey}\n`,
		);
		writeFileSync(changedPaths.receiptPath, "existing-bound-receipt\n");
		const changed = new FakeHostRunner({
			clock,
			keyByIp: new Map([
				["203.0.113.10", `${serverKey.replace("Server", "Changed")}\n`],
				["203.0.113.11", `${generatorKey}\n`],
			]),
		});
		await expect(
			captureKnownHosts({
				runId: "g6-c32-host-test",
				hosts: [droplet("server"), droplet("generator")],
				knownHostsPath: changedPaths.knownHostsPath,
				receiptPath: changedPaths.receiptPath,
				runner: changed,
				clock,
				randomId: () => "changed",
			}),
		).rejects.toThrow(/changed|refus/i);
		expect(readFileSync(changedPaths.knownHostsPath, "utf8")).toBe(
			`${serverKey}\n${generatorKey}\n`,
		);
	});
});

describe("G6 c32 scripted host preparation", () => {
	test("executes the registered preparation anchors in exact order and compares retained hashes", async () => {
		const paths = makePaths();
		writeFileSync(join(paths.root, "candidate.bundle"), "bundle bytes");
		writeFileSync(paths.knownHostsPath, `${serverKey}\n${generatorKey}\n`);
		const clock = new IncrementingClock();
		const runner = new SuccessfulPreparationRunner(clock);
		const result = await prepareHosts({
			runId: "g6-c32-host-test",
			hosts: [droplet("generator"), droplet("server")],
			knownHostsPath: paths.knownHostsPath,
			authority: preparationAuthority(paths.root),
			runner,
			clock,
			receiptPath: join(paths.root, "preparation-receipt.json"),
			randomId: () => "preparation",
		});
		expect(runner.calls.map(({ operationId }) => operationId)).toEqual([
			"bootstrap-server",
			"bootstrap-generator",
			"verify-toolchain-server",
			"verify-toolchain-generator",
			"transfer-bundle-server",
			"transfer-bundle-generator",
			"verify-bundle-server",
			"verify-bundle-generator",
			"checkout-source-server",
			"checkout-source-generator",
			"install-source-dependencies-server",
			"install-source-dependencies-generator",
			"build-native-addon",
			"build-mmo-client",
			"retain-native-addon",
			"retain-mmo-client",
			"hash-native-remote",
			"hash-native-local",
			"hash-generator-remote",
			"hash-generator-local",
			"linux-smoke-server",
			"linux-smoke-generator",
			"retain-linux-smoke-server",
			"retain-linux-smoke-generator",
		]);
		const bootstrapServer = runner.calls.find(
			({ operationId }) => operationId === "bootstrap-server",
		);
		const bootstrapCommand = [
			bootstrapServer?.command,
			...(bootstrapServer?.args ?? []),
		]
			.join(" ")
			.replaceAll("'\"'\"'", "'");
		expect(bootstrapCommand).toContain("cloud-init status --wait");
		expect(bootstrapCommand.indexOf("cloud-init status --wait")).toBeLessThan(
			bootstrapCommand.indexOf("apt-get update"),
		);
		expect(bootstrapCommand).toContain("chmod 755 '/tmp/rustup-init'");
		expect(bootstrapCommand).toContain(
			"'/tmp/rustup-init' -y --profile minimal",
		);
		expect(bootstrapCommand).not.toContain("g6-rustup-init");
		expect(bootstrapCommand).toContain(
			"/opt/g6/bin/g6-c32-socket-rcvbuf-check",
		);
		expect(bootstrapCommand).toContain("getsockopt(fd,SOL_SOCKET,SO_RCVBUF");
		expect(result.binaryHashes).toEqual({
			nativeAddonSha256: nativeSha256,
			generatorSha256,
		});
		expect(result.envelope.recordedAt).toMatch(/\.\d{3}Z$/);
		expect(result.operationReceipts).toHaveLength(runner.calls.length);
		expect(existsSync(join(paths.root, "preparation-receipt.json"))).toBeTrue();
		expect(
			validateHostPreparationReceipt(
				JSON.parse(
					readFileSync(join(paths.root, "preparation-receipt.json"), "utf8"),
				),
			).binaryHashes,
		).toEqual(result.binaryHashes);
		expect(
			runner.calls
				.filter(({ command }) => command === "ssh")
				.every(({ args }) => args.includes("-n")),
		).toBeTrue();
		expect(
			runner.calls
				.find(({ operationId }) => operationId === "verify-toolchain-server")
				?.args.join(" "),
		).toContain("bpftool version");
		const serverSmoke = runner.calls.find(
			({ operationId }) => operationId === "linux-smoke-server",
		);
		expect(serverSmoke?.args.join(" ")).toContain("G6_C32_BOUNDED_PROBE");
		expect(serverSmoke?.args.join(" ")).toContain("G6_C32_STEERING_PROBE");
		for (const role of ["server", "generator"] as const) {
			const command =
				runner.calls
					.find(({ operationId }) => operationId === `linux-smoke-${role}`)
					?.args.join(" ")
					.replaceAll(/['"]/g, "") ?? "";
			expect(command).toMatch(
				new RegExp(`g6-c32-linux-smoke\\.sh ${role} \\S+/${role} 16$`),
			);
			expect(command).not.toContain("G6_C32_SHARDS=");
		}
	});

	test("refuses a preparation authority whose linuxSmoke shard count is missing or unusable", async () => {
		const paths = makePaths();
		writeFileSync(join(paths.root, "candidate.bundle"), "bundle bytes");
		writeFileSync(paths.knownHostsPath, `${serverKey}\n${generatorKey}\n`);
		const clock = new IncrementingClock();
		const withShards = (shards: unknown): HostPreparationAuthority => {
			const base = preparationAuthority(paths.root);
			const linuxSmoke: Record<string, unknown> = { ...base.linuxSmoke };
			if (shards === undefined) delete linuxSmoke.shards;
			else linuxSmoke.shards = shards;
			return {
				...base,
				linuxSmoke,
			} as unknown as HostPreparationAuthority;
		};
		for (const [index, shards] of [undefined, 0, -16, 16.5, "16"].entries()) {
			await expect(
				prepareHosts({
					runId: "g6-c32-host-test",
					hosts: [droplet("server"), droplet("generator")],
					knownHostsPath: paths.knownHostsPath,
					authority: withShards(shards),
					runner: new SuccessfulPreparationRunner(clock),
					clock,
					receiptPath: join(paths.root, `shards-${index}-receipt.json`),
					randomId: () => `shards-${index}`,
				}),
			).rejects.toThrow(/linuxSmoke/i);
		}
	});

	test("stops at the first failed operation and forbids package installation after PREPARED", async () => {
		const paths = makePaths();
		writeFileSync(join(paths.root, "candidate.bundle"), "bundle bytes");
		writeFileSync(paths.knownHostsPath, `${serverKey}\n${generatorKey}\n`);
		const clock = new IncrementingClock();
		const base = new SuccessfulPreparationRunner(clock);
		const failing: HostOperationRunner = {
			execute: async (request) => {
				const result = await base.execute(request);
				if (request.operationId === "verify-bundle-generator") {
					return {
						...result,
						status: { outcome: "FAILED", exitCode: 9, signal: null },
						stderr: "bundle mismatch",
					};
				}
				return result;
			},
		};
		await expect(
			prepareHosts({
				runId: "g6-c32-host-test",
				hosts: [droplet("server"), droplet("generator")],
				knownHostsPath: paths.knownHostsPath,
				authority: preparationAuthority(paths.root),
				runner: failing,
				clock,
				receiptPath: join(paths.root, "failed-preparation-receipt.json"),
				randomId: () => "failed-preparation",
			}),
		).rejects.toThrow(/verify-bundle-generator|failed/i);
		expect(base.calls.at(-1)?.operationId).toBe("verify-bundle-generator");

		expect(() =>
			assertNoPackageInstallationAfterPrepared("PREPARED", {
				operationId: "late-apt",
				phase: "PREPARED",
				attempt: 1,
				command: "ssh",
				args: ["root@host", "apt-get install -y git"],
			}),
		).toThrow(/package installation.*PREPARED/i);
		expect(() =>
			assertNoPackageInstallationAfterPrepared("PREPARING", {
				operationId: "allowed-apt",
				phase: "PREPARING",
				attempt: 1,
				command: "apt-get",
				args: ["install", "-y", "git"],
			}),
		).not.toThrow();
	});
});

function retainedHash(bytes: string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function identityPacket(
	role: "server" | "generator",
	retainedBytes: string,
): HostIdentityPacket {
	return {
		schema: "g6-c32-host-identity/1",
		envelope: {
			recordedAt: "2026-08-30T12:00:00.120Z",
			sequence: role === "server" ? 1 : 2,
			runId: "g6-c32-host-test",
			phase: "BINDING",
			operationId: `collect-identity-${role}`,
			clockSource: role,
		},
		provider: droplet(role),
		bootId:
			role === "server"
				? "11111111-1111-4111-8111-111111111111"
				: "22222222-2222-4222-8222-222222222222",
		source: {
			commit: "1".repeat(40),
			tree: "2".repeat(40),
			statusPorcelain: "",
		},
		runtime: {
			os: "Linux",
			osRelease: "Ubuntu 24.04.3 LTS",
			kernel: "6.8.0-79-generic",
			bunVersion: "1.3.14",
			rustcVersion: "rustc 1.95.0 (test 2026-08-01)",
			cargoVersion: "cargo 1.95.0 (test 2026-08-01)",
		},
		binary: {
			kind: role === "server" ? "native-addon" : "mmo-client",
			path:
				role === "server"
					? "/opt/g6/run/source/crates/native/webtransport-native.linux-x64-gnu.node"
					: "/opt/g6/run/source/target/release/mmo-client",
			sha256: retainedHash(retainedBytes),
		},
		clock: {
			requestStartedAt: "2026-08-30T12:00:00.000Z",
			responseFinishedAt: "2026-08-30T12:00:00.200Z",
			remoteWallAt: "2026-08-30T12:00:00.120Z",
			measuredSkewMilliseconds: 20,
		},
	};
}

describe("G6 c32 exact prepared-host identity", () => {
	test("collects strict remote identity JSON with timestamp bounds and a retained operation receipt", async () => {
		const paths = makePaths();
		writeFileSync(paths.knownHostsPath, `${serverKey}\n${generatorKey}\n`);
		const calls: HostOperationRequest[] = [];
		const remote = {
			schema: "g6-c32-remote-host-identity/1",
			observedAt: "2026-08-30T12:00:00.120Z",
			bootId: "11111111-1111-4111-8111-111111111111",
			source: {
				commit: "1".repeat(40),
				tree: "2".repeat(40),
				statusPorcelain: "",
			},
			runtime: {
				os: "Linux",
				osRelease: "Ubuntu 24.04.3 LTS",
				kernel: "6.8.0-79-generic",
				bunVersion: "1.3.14",
				rustcVersion: "rustc 1.95.0 (test 2026-08-01)",
				cargoVersion: "cargo 1.95.0 (test 2026-08-01)",
			},
			binary: {
				kind: "native-addon",
				path: "/opt/g6/run/source/crates/native/webtransport-native.linux-x64-gnu.node",
				sha256: nativeSha256,
			},
		};
		const runner: HostOperationRunner = {
			execute: async (request) => {
				calls.push(request);
				return {
					stdout: JSON.stringify(remote),
					stderr: "",
					status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
					startedAt: "2026-08-30T12:00:00.000Z",
					finishedAt: "2026-08-30T12:00:00.200Z",
					receiptPath: "/receipts/collect-identity-server.json",
				};
			},
		};
		const collected = await collectHostIdentityPacket({
			runId: "g6-c32-host-test",
			sequence: 7,
			host: droplet("server"),
			knownHostsPath: paths.knownHostsPath,
			runner,
			remoteIdentityCommand: ["/opt/g6/bin/bun", "identity.js"],
			maxClockSkewMilliseconds: 250,
		});
		expect(collected.operationReceiptPath).toBe(
			"/receipts/collect-identity-server.json",
		);
		expect(collected.packet.clock).toEqual({
			requestStartedAt: "2026-08-30T12:00:00.000Z",
			responseFinishedAt: "2026-08-30T12:00:00.200Z",
			remoteWallAt: "2026-08-30T12:00:00.120Z",
			measuredSkewMilliseconds: 20,
		});
		expect(calls[0]?.args).toContain("-n");
		expect(calls[0]?.args).toContain("StrictHostKeyChecking=yes");

		const malformedRunner: HostOperationRunner = {
			execute: async () => ({
				stdout: JSON.stringify({ ...remote, unexpected: true }),
				stderr: "",
				status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
				startedAt: "2026-08-30T12:00:00.000Z",
				finishedAt: "2026-08-30T12:00:00.200Z",
				receiptPath: "/receipts/malformed.json",
			}),
		};
		await expect(
			collectHostIdentityPacket({
				runId: "g6-c32-host-test",
				sequence: 8,
				host: droplet("server"),
				knownHostsPath: paths.knownHostsPath,
				runner: malformedRunner,
				remoteIdentityCommand: ["identity"],
				maxClockSkewMilliseconds: 250,
			}),
		).rejects.toThrow(/remote identity.*shape|unexpected/i);
	});

	test("binds every provider, boot, source, runtime, clock, and retained-binary value", () => {
		const paths = makePaths();
		const nativePath = join(paths.root, "native.node");
		const generatorPath = join(paths.root, "mmo-client");
		writeFileSync(nativePath, "fresh native bytes");
		writeFileSync(generatorPath, "fresh generator bytes");
		const result = validateHostIdentityPair({
			runId: "g6-c32-host-test",
			packets: [
				identityPacket("generator", "fresh generator bytes"),
				identityPacket("server", "fresh native bytes"),
			],
			expectedHosts: [droplet("server"), droplet("generator")],
			expectedSource: { commit: "1".repeat(40), tree: "2".repeat(40) },
			expectedRuntime: {
				os: "Linux",
				bunVersion: "1.3.14",
				rustcVersion: "rustc 1.95.0 (test 2026-08-01)",
				cargoVersion: "cargo 1.95.0 (test 2026-08-01)",
			},
			retainedBinaries: {
				server: nativePath,
				generator: generatorPath,
			},
			expectedBinaryPaths: {
				server:
					"/opt/g6/run/source/crates/native/webtransport-native.linux-x64-gnu.node",
				generator: "/opt/g6/run/source/target/release/mmo-client",
			},
			maxClockSkewMilliseconds: 250,
		});
		expect(result.map(({ provider }) => provider.role)).toEqual([
			"server",
			"generator",
		]);
		expect(result[0]?.provider).toEqual(
			validateDropletIdentity(droplet("server")),
		);
		expect(result[1]?.bootId).toBe("22222222-2222-4222-8222-222222222222");
	});

	test("refuses provider drift, clock drift, and missing historical generator bytes", () => {
		const paths = makePaths();
		const nativePath = join(paths.root, "native.node");
		writeFileSync(nativePath, "fresh native bytes");
		const server = identityPacket("server", "fresh native bytes");
		const generator = identityPacket("generator", "old generator bytes");
		const input = {
			runId: "g6-c32-host-test",
			packets: [server, generator],
			expectedHosts: [droplet("server"), droplet("generator")],
			expectedSource: { commit: "1".repeat(40), tree: "2".repeat(40) },
			expectedRuntime: {
				os: "Linux" as const,
				bunVersion: "1.3.14",
				rustcVersion: "rustc 1.95.0 (test 2026-08-01)",
				cargoVersion: "cargo 1.95.0 (test 2026-08-01)",
			},
			retainedBinaries: {
				server: nativePath,
				generator: join(paths.root, "historical-mmo-client-not-present"),
			},
			expectedBinaryPaths: {
				server:
					"/opt/g6/run/source/crates/native/webtransport-native.linux-x64-gnu.node",
				generator: "/opt/g6/run/source/target/release/mmo-client",
			},
			maxClockSkewMilliseconds: 250,
		};
		expect(() => validateHostIdentityPair(input)).toThrow(
			/missing.*generator|retained.*generator/i,
		);

		const generatorPath = join(paths.root, "mmo-client");
		writeFileSync(generatorPath, "old generator bytes");
		const drifted = structuredClone(server);
		drifted.provider.vpcUuid = "vpc-drifted";
		expect(() =>
			validateHostIdentityPair({
				...input,
				packets: [drifted, generator],
				retainedBinaries: {
					server: nativePath,
					generator: generatorPath,
				},
			}),
		).toThrow(/provider.*mismatch|vpc/i);

		const skewed = structuredClone(server);
		skewed.clock.remoteWallAt = "2026-08-30T12:00:02.100Z";
		skewed.clock.measuredSkewMilliseconds = 2_000;
		skewed.envelope.recordedAt = skewed.clock.remoteWallAt;
		expect(() =>
			validateHostIdentityPair({
				...input,
				packets: [skewed, generator],
				retainedBinaries: {
					server: nativePath,
					generator: generatorPath,
				},
			}),
		).toThrow(/clock.*skew/i);
	});
});

describe("G6 c32 recorded host operation adapter", () => {
	test("routes command output and strict SSH argv through timestamped operation receipts", async () => {
		const paths = makePaths();
		const wallTimes = ["2026-08-30T12:00:00.000Z", "2026-08-30T12:00:00.100Z"];
		const monotonicTimes = [0n, 100_000_000n];
		let seenArgs: readonly string[] = [];
		const runner = new RecordedHostOperationRunner({
			runId: "g6-c32-host-test",
			artifactDirectory: join(paths.root, "operations"),
			artifactPathPrefix: "operations",
			env: {
				G6_C32_SSH_IDENTITY_PATH: "/private/tmp/g6-c32-test-key",
			},
			operationDependencies: {
				executionRoot: paths.root,
				clock: {
					wallNow: () => wallTimes.shift() as string,
					monotonicNowNs: () => monotonicTimes.shift() as bigint,
				},
				adapter: {
					execute: async (spec) => {
						seenArgs = spec.args;
						return {
							stdout: "ready\n",
							stderr: "",
							status: {
								outcome: "SUCCEEDED" as const,
								exitCode: 0,
								signal: null,
							},
						};
					},
				},
			},
		});
		const result = await runner.execute({
			operationId: "recorded-readiness",
			phase: "SSH_READY",
			attempt: 1,
			command: "ssh",
			args: ["root@203.0.113.10", "true"],
		});
		expect(seenArgs).toContain("-n");
		expect(seenArgs).toContain("/private/tmp/g6-c32-test-key");
		expect(seenArgs).toContain("IdentitiesOnly=yes");
		expect(result.stdout).toBe("ready\n");
		expect(result.finishedAt).toBe("2026-08-30T12:00:00.100Z");
		expect(result.receiptPath).not.toBeNull();
		const receipt = JSON.parse(
			readFileSync(result.receiptPath as string, "utf8"),
		) as { envelope: { recordedAt: string }; action: { args: string[] } };
		expect(receipt.envelope.recordedAt).toBe(result.finishedAt);
		expect(receipt.action.args).toContain("-n");
	});

	test("propagates the lifecycle cancellation signal into every host operation", async () => {
		const paths = makePaths();
		const cancellation = new AbortController();
		let observed: AbortSignal | undefined;
		const runner = new RecordedHostOperationRunner({
			runId: "g6-c32-host-signal",
			artifactDirectory: join(paths.root, "operations"),
			artifactPathPrefix: "operations",
			signal: cancellation.signal,
			operationDependencies: {
				executionRoot: paths.root,
				clock: {
					wallNow: (() => {
						const times = [
							"2026-08-30T12:00:00.000Z",
							"2026-08-30T12:00:00.100Z",
						];
						return () => times.shift() as string;
					})(),
					monotonicNowNs: (() => {
						const times = [0n, 100n];
						return () => times.shift() as bigint;
					})(),
				},
				adapter: {
					execute: async (_spec, signal) => {
						observed = signal;
						return {
							stdout: "",
							stderr: "",
							status: {
								outcome: "SUCCEEDED" as const,
								exitCode: 0,
								signal: null,
							},
						};
					},
				},
			},
		});
		await runner.execute({
			operationId: "signal-probe",
			phase: "PREPARING",
			attempt: 1,
			command: "true",
			args: [],
		});
		expect(observed).toBe(cancellation.signal);
	});
});

function executable(root: string, name: string, body: string): string {
	const path = join(root, name);
	writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

function runShellScript(
	script: string,
	args: string[],
	environment: Record<string, string>,
): ReturnType<typeof Bun.spawnSync> {
	return Bun.spawnSync(["bash", script, ...args], {
		env: { ...process.env, ...environment },
		stdout: "pipe",
		stderr: "pipe",
	});
}

describe("G6 c32 Linux smoke script", () => {
	test("fixture mode exercises every role branch and verifies a timestamped manifest", () => {
		const paths = makePaths();
		const bin = join(paths.root, "bin");
		mkdirSync(bin);
		const uname = executable(bin, "uname", 'printf "Linux\\n"');
		const timeout = executable(bin, "timeout", 'shift; exec "$@"');
		const monotonic = executable(bin, "monotonic", 'printf "100\\n"');
		const fixed = executable(
			bin,
			"fixed-port",
			'printf \'%s\\n\' \'{"schema":"g6-fixed-source-port-smoke/1","recordedAt":"2026-08-30T12:00:00.000Z","base":45000,"count":512,"distinct":512,"withinRange":true,"passed":true}\'',
		);
		const bounded = executable(
			bin,
			"bounded",
			'printf \'%s\\n\' \'{"schema":"g6-bounded-linux-probe/1","recordedAt":"2026-08-30T12:00:00.100Z","bounded":true,"exitCode":0,"passed":true}\'',
		);
		const steering = executable(
			bin,
			"steering",
			'printf \'%s\\n\' \'{"schema":"g6-steering-smoke/1","recordedAt":"2026-08-30T12:00:00.200Z","phase":"post-run","selected":true,"steered":8,"fallback":0}\'',
		);
		const bpf = executable(
			bin,
			"bpf",
			'printf \'%s\\n\' \'{"schema":"g6-bpf-smoke/1","recordedAt":"2026-08-30T12:00:00.300Z","instances":16,"socksEntries":16,"fallback":0,"passed":true}\'',
		);
		const script = join(import.meta.dir, "g6-c32-linux-smoke.sh");
		const common = {
			G6_C32_SMOKE_MODE: "fixture",
			G6_C32_SMOKE_ALLOW_FIXTURE: "1",
			G6_C32_BUN_BIN: process.execPath,
			G6_C32_UNAME_BIN: uname,
			G6_C32_TIMEOUT_BIN: timeout,
			G6_C32_MONOTONIC_BIN: monotonic,
			G6_C32_FIXED_PORT_PROBE: fixed,
			G6_C32_BOUNDED_PROBE: bounded,
			G6_C32_STEERING_PROBE: steering,
			G6_C32_BPF_PROBE: bpf,
		};
		for (const role of ["server", "generator"] as const) {
			const evidence = join(paths.root, `smoke-${role}`);
			const result = runShellScript(script, [role, evidence, "16"], common);
			expect({
				exitCode: result.exitCode,
				stderr: result.stderr?.toString() ?? "",
			}).toEqual({ exitCode: 0, stderr: "" });
			const receipt = JSON.parse(
				readFileSync(join(evidence, "linux-smoke-receipt.json"), "utf8"),
			) as { role: string; recordedAt: string; checks: string[] };
			expect(receipt.role).toBe(role);
			expect(receipt.recordedAt).toMatch(/\.\d{3}Z$/);
			expect(receipt.checks).toContain("linux");
			expect(receipt.checks).toContain("bounded-probe");
			if (role === "server") {
				expect(receipt.checks).toContain("post-run-steering");
				expect(receipt.checks).toContain("bpf-shards-zero-fallback");
			} else {
				expect(receipt.checks).toContain("fixed-source-port");
			}
			expect(readFileSync(join(evidence, "SHA256SUMS"), "utf8")).toContain(
				"operations.jsonl",
			);
			for (const line of readFileSync(
				join(evidence, "operations.jsonl"),
				"utf8",
			)
				.trim()
				.split("\n")) {
				const operation = JSON.parse(line) as {
					recordedAt: string;
					startedAt: string;
					finishedAt: string;
					durationMonotonicNs: string;
				};
				expect(operation.recordedAt).toMatch(/\.\d{3}Z$/);
				expect(operation.startedAt).toMatch(/\.\d{3}Z$/);
				expect(operation.finishedAt).toMatch(/\.\d{3}Z$/);
				expect(operation.durationMonotonicNs).toMatch(/^\d+$/);
			}
		}
	});

	test("takes the shard count only as an explicit argument, never from the environment", () => {
		const paths = makePaths();
		const bin = join(paths.root, "bin");
		mkdirSync(bin);
		const uname = executable(bin, "uname", 'printf "Linux\\n"');
		const timeout = executable(bin, "timeout", 'shift; exec "$@"');
		const monotonic = executable(bin, "monotonic", 'printf "100\\n"');
		const bounded = executable(
			bin,
			"bounded",
			'printf \'%s\\n\' \'{"schema":"g6-bounded-linux-probe/1","recordedAt":"2026-08-30T12:00:00.100Z","bounded":true,"exitCode":0,"passed":true}\'',
		);
		const steering = executable(
			bin,
			"steering",
			'printf \'%s\\n\' \'{"schema":"g6-steering-smoke/1","recordedAt":"2026-08-30T12:00:00.200Z","phase":"post-run","selected":true,"steered":8,"fallback":0}\'',
		);
		const sixteenShardBpf = executable(
			bin,
			"bpf",
			'printf \'%s\\n\' \'{"schema":"g6-bpf-smoke/1","recordedAt":"2026-08-30T12:00:00.300Z","instances":16,"socksEntries":16,"fallback":0,"passed":true}\'',
		);
		const script = join(import.meta.dir, "g6-c32-linux-smoke.sh");
		const environment = {
			G6_C32_SMOKE_MODE: "fixture",
			G6_C32_SMOKE_ALLOW_FIXTURE: "1",
			G6_C32_BUN_BIN: process.execPath,
			G6_C32_UNAME_BIN: uname,
			G6_C32_TIMEOUT_BIN: timeout,
			G6_C32_MONOTONIC_BIN: monotonic,
			G6_C32_BOUNDED_PROBE: bounded,
			G6_C32_STEERING_PROBE: steering,
			G6_C32_BPF_PROBE: sixteenShardBpf,
			G6_C32_SHARDS: "16",
		};
		const cases: [string, string[], RegExp][] = [
			["absent", ["server", join(paths.root, "absent")], /usage:.*<shards>/],
			[
				"zero",
				["server", join(paths.root, "zero"), "0"],
				/shards must be a positive integer/,
			],
			[
				"fractional",
				["server", join(paths.root, "fractional"), "16.5"],
				/shards must be a positive integer/,
			],
			[
				"word",
				["server", join(paths.root, "word"), "sixteen"],
				/shards must be a positive integer/,
			],
			[
				"mismatch",
				["server", join(paths.root, "mismatch"), "24"],
				/24-instance zero-fallback proof failed/,
			],
		];
		for (const [name, args, expected] of cases) {
			const result = runShellScript(script, args, environment);
			expect({ name, exitCode: result.exitCode }).toEqual({
				name,
				exitCode: 1,
			});
			expect({ name, stderr: result.stderr?.toString() ?? "" }).toEqual({
				name,
				stderr: expect.stringMatching(expected),
			});
		}
		const evidence = join(paths.root, "exported");
		const exported = executable(
			bin,
			"exported-bpf",
			'printf \'%s\\n\' "{\\"schema\\":\\"g6-bpf-smoke/1\\",\\"recordedAt\\":\\"2026-08-30T12:00:00.300Z\\",\\"instances\\":$G6_C32_SHARDS,\\"socksEntries\\":$G6_C32_SHARDS,\\"fallback\\":0,\\"passed\\":true}"',
		);
		const result = runShellScript(script, ["server", evidence, "24"], {
			...environment,
			G6_C32_BPF_PROBE: exported,
		});
		expect({
			exitCode: result.exitCode,
			stderr: result.stderr?.toString() ?? "",
		}).toEqual({ exitCode: 0, stderr: "" });
		expect(
			JSON.parse(readFileSync(join(evidence, "bpf.json"), "utf8")),
		).toMatchObject({ instances: 24, socksEntries: 24 });
	});

	test("refuses malformed post-run steering evidence instead of skipping it", () => {
		const paths = makePaths();
		const bin = join(paths.root, "bin");
		mkdirSync(bin);
		const uname = executable(bin, "uname", 'printf "Linux\\n"');
		const timeout = executable(bin, "timeout", 'shift; exec "$@"');
		const monotonic = executable(bin, "monotonic", 'printf "100\\n"');
		const bounded = executable(
			bin,
			"bounded",
			'printf \'%s\\n\' \'{"schema":"g6-bounded-linux-probe/1","recordedAt":"2026-08-30T12:00:00.100Z","bounded":true,"exitCode":0,"passed":true}\'',
		);
		const malformedSteering = executable(
			bin,
			"steering",
			'printf \'%s\\n\' \'{"schema":"g6-steering-smoke/1","recordedAt":"2026-08-30T12:00:00.200Z","phase":"post-run","selected":true,"steered":8}\'',
		);
		const bpf = executable(
			bin,
			"bpf",
			'printf \'%s\\n\' \'{"schema":"g6-bpf-smoke/1","recordedAt":"2026-08-30T12:00:00.300Z","instances":16,"socksEntries":16,"fallback":0,"passed":true}\'',
		);
		const evidence = join(paths.root, "malformed-smoke");
		const result = runShellScript(
			join(import.meta.dir, "g6-c32-linux-smoke.sh"),
			["server", evidence, "16"],
			{
				G6_C32_SMOKE_MODE: "fixture",
				G6_C32_SMOKE_ALLOW_FIXTURE: "1",
				G6_C32_BUN_BIN: process.execPath,
				G6_C32_UNAME_BIN: uname,
				G6_C32_TIMEOUT_BIN: timeout,
				G6_C32_MONOTONIC_BIN: monotonic,
				G6_C32_BOUNDED_PROBE: bounded,
				G6_C32_STEERING_PROBE: malformedSteering,
				G6_C32_BPF_PROBE: bpf,
			},
		);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr?.toString() ?? "").toMatch(
			/steering.*invalid|malformed/i,
		);
		expect(existsSync(join(evidence, "linux-smoke-receipt.json"))).toBeFalse();
		const partialOperations = readFileSync(
			join(evidence, "operations.jsonl"),
			"utf8",
		);
		const retry = runShellScript(
			join(import.meta.dir, "g6-c32-linux-smoke.sh"),
			["server", evidence, "16"],
			{
				G6_C32_SMOKE_MODE: "fixture",
				G6_C32_SMOKE_ALLOW_FIXTURE: "1",
				G6_C32_BUN_BIN: process.execPath,
				G6_C32_UNAME_BIN: uname,
				G6_C32_TIMEOUT_BIN: timeout,
				G6_C32_MONOTONIC_BIN: monotonic,
				G6_C32_BOUNDED_PROBE: bounded,
				G6_C32_STEERING_PROBE: malformedSteering,
				G6_C32_BPF_PROBE: bpf,
			},
		);
		expect(retry.exitCode).not.toBe(0);
		expect(readFileSync(join(evidence, "operations.jsonl"), "utf8")).toBe(
			partialOperations,
		);
	});
});

describe("G6 c32 receive-buffer rollback script", () => {
	function rollbackFixture(
		root: string,
		failKey?: string,
	): {
		environment: Record<string, string>;
		stateRoot: string;
		restartLog: string;
	} {
		const bin = join(root, "bin");
		const stateRoot = join(root, "sysctl-state");
		const shellDollar = "$";
		mkdirSync(bin);
		mkdirSync(stateRoot);
		for (const [key, value] of [
			["net.core.rmem_max", "212992"],
			["net.core.rmem_default", "212992"],
			["net.ipv4.udp_rmem_min", "4096"],
		] as const) {
			writeFileSync(join(stateRoot, key.replaceAll(".", "_")), `${value}\n`);
		}
		const sysctl = executable(
			bin,
			"sysctl",
			[
				`STATE=${shellDollar}{G6_FAKE_SYSCTL_STATE:?}`,
				`if [[ "$1" == "-n" ]]; then file=${shellDollar}{2//./_}; cat "$STATE/$file"; exit 0; fi`,
				'if [[ "$1" != "-w" ]]; then exit 64; fi',
				`assignment=$2; key=${shellDollar}{assignment%%=*}; value=${shellDollar}{assignment#*=}; file=${shellDollar}{key//./_}`,
				`if [[ -n "${shellDollar}{G6_FAKE_FAIL_APPLY_KEY:-}" && "$key" == "$G6_FAKE_FAIL_APPLY_KEY" && "$value" == "26214400" ]]; then exit 71; fi`,
				'printf "%s\\n" "$value" > "$STATE/$file"',
				'printf "%s = %s\\n" "$key" "$value"',
			].join("\n"),
		);
		const restartLog = join(root, "restart.log");
		const restart = executable(
			bin,
			"restart",
			`printf "%s\\n" "$(date +%s)-restart" >> "${shellDollar}{G6_FAKE_RESTART_LOG:?}"`,
		);
		const socketCheck = executable(bin, "socket-check", 'printf "52428800\\n"');
		return {
			stateRoot,
			restartLog,
			environment: {
				G6_C32_BUN_BIN: process.execPath,
				G6_C32_SYSCTL_BIN: sysctl,
				G6_C32_SOCKET_RESTART_BIN: restart,
				G6_C32_SOCKET_RCVBUF_CHECK_BIN: socketCheck,
				G6_FAKE_SYSCTL_STATE: stateRoot,
				G6_FAKE_RESTART_LOG: restartLog,
				...(failKey ? { G6_FAKE_FAIL_APPLY_KEY: failKey } : {}),
			},
		};
	}

	test("applies 25 MiB, verifies the socket, restores all values, restarts, and byte-compares", () => {
		const paths = makePaths();
		const fixture = rollbackFixture(paths.root);
		const evidence = join(paths.root, "rollback-success");
		const result = runShellScript(
			join(import.meta.dir, "g6-c32-rollback.sh"),
			[evidence],
			fixture.environment,
		);
		expect(result.exitCode).toBe(0);
		expect(readFileSync(join(evidence, "sysctl-before.txt"), "utf8")).toBe(
			readFileSync(join(evidence, "sysctl-restored.txt"), "utf8"),
		);
		expect(
			readFileSync(fixture.restartLog, "utf8").trim().split("\n").length,
		).toBeGreaterThanOrEqual(2);
		const receipt = JSON.parse(
			readFileSync(join(evidence, "rollback-receipt.json"), "utf8"),
		) as { recordedAt: string; restored: boolean; appliedBytes: number };
		expect(receipt).toMatchObject({ restored: true, appliedBytes: 26_214_400 });
		expect(receipt.recordedAt).toMatch(/\.\d{3}Z$/);
	});

	test("does not require a restart command when checking a fresh socket", () => {
		const paths = makePaths();
		const fixture = rollbackFixture(paths.root);
		delete fixture.environment.G6_C32_SOCKET_RESTART_BIN;
		const result = runShellScript(
			join(import.meta.dir, "g6-c32-rollback.sh"),
			[join(paths.root, "rollback-without-managed-socket")],
			fixture.environment,
		);
		expect(result.exitCode).toBe(0);
	});

	test("restore trap runs after an intermediate sysctl failure", () => {
		const paths = makePaths();
		const fixture = rollbackFixture(paths.root, "net.core.rmem_default");
		const evidence = join(paths.root, "rollback-failure");
		const result = runShellScript(
			join(import.meta.dir, "g6-c32-rollback.sh"),
			[evidence],
			fixture.environment,
		);
		expect(result.exitCode).not.toBe(0);
		for (const [key, expected] of [
			["net.core.rmem_max", "212992"],
			["net.core.rmem_default", "212992"],
			["net.ipv4.udp_rmem_min", "4096"],
		] as const) {
			expect(
				readFileSync(
					join(fixture.stateRoot, key.replaceAll(".", "_")),
					"utf8",
				).trim(),
			).toBe(expected);
		}
		const operations = readFileSync(join(evidence, "operations.jsonl"), "utf8");
		expect(operations).toContain("restore-net.core.rmem_max");
		expect(operations).toMatch(/recordedAt/);
		const retry = runShellScript(
			join(import.meta.dir, "g6-c32-rollback.sh"),
			[evidence],
			fixture.environment,
		);
		expect(retry.exitCode).not.toBe(0);
		expect(readFileSync(join(evidence, "operations.jsonl"), "utf8")).toBe(
			operations,
		);
	});
});
