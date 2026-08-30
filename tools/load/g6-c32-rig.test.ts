import { describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	makeDesiredRig,
	type RigBackend,
	type RigCommandOperationRecord,
	type RigRunContext,
	resolveCampaignInputPath,
	runRigCommand,
	validateRigCommandOperationRecord,
} from "./g6-c32-rig.ts";
import type { RigLifecycleState } from "./g6-c32-rig-journal.ts";

const ROOT = "/campaign/provisioning/g6-c32-rig-test";
const FREEZE = "/campaign/authority/semantic-freeze.json";
const APPROVAL = "/campaign/authority/semantic-approval.json";
const DEADLINE = "2026-08-30T16:00:00.000Z";

class DeterministicClock {
	#wallMilliseconds = Date.parse("2026-08-30T12:00:00.000Z");
	#monotonic = 1_000_000n;

	wallNow(): string {
		const result = new Date(this.#wallMilliseconds).toISOString();
		this.#wallMilliseconds += 1;
		return result;
	}

	monotonicNowNs(): bigint {
		const result = this.#monotonic;
		this.#monotonic += 100n;
		return result;
	}
}

class MemoryBackend implements RigBackend {
	readonly calls: Array<{ action: string; cleanupOnly: boolean }> = [];
	readonly records: RigCommandOperationRecord[] = [];
	readonly context: RigRunContext = {
		runId: "g6-c32-rig-test",
		root: ROOT,
		deadline: DEADLINE,
	};
	state: RigLifecycleState;
	#sequence = 0;
	interruptAfter: string | null = null;

	constructor(state: RigLifecycleState = "ABSENT") {
		this.state = state;
	}

	async prepareRun(): Promise<RigRunContext> {
		return this.context;
	}

	async openRoot(root: string): Promise<RigRunContext> {
		expect(root).toBe(ROOT);
		return this.context;
	}

	async readState(): Promise<RigLifecycleState> {
		return this.state;
	}

	async nextOperationSequence(): Promise<number> {
		this.#sequence += 1;
		return this.#sequence;
	}

	async persistOperation(record: RigCommandOperationRecord): Promise<void> {
		this.records.push(record);
	}

	async execute(request: Parameters<RigBackend["execute"]>[0]): Promise<void> {
		this.calls.push({
			action: request.action,
			cleanupOnly: request.cleanupOnly,
		});
		const transitions: Partial<
			Record<typeof request.action, RigLifecycleState>
		> = {
			ENSURE: request.cleanupOnly ? "FAILED" : "PROVISIONED",
			PREPARE: "PREPARED",
			BIND: "BOUND",
			DISPATCH: "TERMINAL",
			RECOVER_LIVE: "TERMINAL",
			DESTROY: "DESTROYED",
		};
		this.state = transitions[request.action] ?? this.state;
		if (this.interruptAfter === request.action) {
			throw new Error(`interrupted after ${request.action}`);
		}
	}
}

function dependencies(backend: MemoryBackend, signal?: AbortSignal) {
	return {
		backend,
		clock: new DeterministicClock(),
		signal,
		writeStdout: () => {},
	};
}

describe("G6 c32 rig command", () => {
	test("binds the exact timestamped two-Droplet specification", () => {
		const desired = makeDesiredRig({
			runId: "g6-c32-rig-test",
			recordedAt: "2026-08-30T12:00:00.000Z",
			deadline: DEADLINE,
			freezeAuthoritySha256: "1".repeat(64),
			freezeArtifactSha256: "2".repeat(64),
			approvalAuthoritySha256: "3".repeat(64),
			approvalArtifactSha256: "4".repeat(64),
		});
		expect(desired).toMatchObject({
			recordedAt: "2026-08-30T12:00:00.000Z",
			requestedAt: "2026-08-30T12:00:00.000Z",
			deadline: DEADLINE,
			runId: "g6-c32-rig-test",
			managementTag: "g6-c32-managed",
			runTag: "g6-c32-rig-test",
			roles: {
				serverName: "g6-c32-rig-test-server",
				generatorName: "g6-c32-rig-test-generator",
			},
			profile: {
				region: "ams3",
				size: "c-32-intel",
				image: "ubuntu-24-04-x64",
				vpcUuid: "6e8547b7-b698-4e28-b4d1-8c755217106c",
				projectMode: "none",
				projectId: null,
				sshKeyId: 34466793,
				expectedVcpus: 32,
				expectedMemoryMiB: 65_536,
			},
		});
		expect(() =>
			makeDesiredRig({
				runId: "g6-c32-rig-test",
				recordedAt: DEADLINE,
				deadline: DEADLINE,
				freezeAuthoritySha256: "1".repeat(64),
				freezeArtifactSha256: "2".repeat(64),
				approvalAuthoritySha256: "3".repeat(64),
				approvalArtifactSha256: "4".repeat(64),
			}),
		).toThrow(/deadline/i);
	});

	test("accepts only timestamped internally ordered command records", () => {
		const record: RigCommandOperationRecord = {
			schema: "g6-c32-rig-command-operation/1",
			envelope: {
				recordedAt: "2026-08-30T12:00:00.100Z",
				sequence: 1,
				runId: "g6-c32-rig-test",
				phase: "ABSENT",
				operationId: "orchestrator-inventory",
				clockSource: "offrunner",
			},
			startedAt: "2026-08-30T12:00:00.000Z",
			finishedAt: "2026-08-30T12:00:00.100Z",
			durationMonotonicNs: "100",
			action: "INVENTORY",
			fromState: "ABSENT",
			toState: "ABSENT",
			outcome: "SUCCEEDED",
			error: null,
		};
		expect(validateRigCommandOperationRecord(record)).toEqual(record);
		for (const invalid of [
			{ ...record, startedAt: "not-a-timestamp" },
			{
				...record,
				startedAt: "2026-08-30T12:00:01.000Z",
			},
			{ ...record, durationMonotonicNs: "-1" },
			{ ...record, envelope: { ...record.envelope, recordedAt: undefined } },
		]) {
			expect(() => validateRigCommandOperationRecord(invalid)).toThrow();
		}
	});

	test("resolves authority inputs only as regular non-symlink campaign files", () => {
		const repository = mkdtempSync(join(tmpdir(), "g6-c32-rig-paths-"));
		try {
			const campaignRoot = join(repository, ".scratch", "bare-metal-campaign");
			mkdirSync(join(campaignRoot, "authority"), { recursive: true });
			const freeze = join(campaignRoot, "authority", "freeze.json");
			writeFileSync(freeze, "{}\n");
			expect(
				resolveCampaignInputPath({
					repositoryPath: repository,
					campaignRoot,
					inputPath: freeze,
					label: "semantic freeze",
				}),
			).toBe(realpathSync(freeze));

			const outside = join(repository, "outside.json");
			writeFileSync(outside, "{}\n");
			expect(() =>
				resolveCampaignInputPath({
					repositoryPath: repository,
					campaignRoot,
					inputPath: outside,
					label: "semantic freeze",
				}),
			).toThrow(/campaign root/i);

			const linked = join(campaignRoot, "authority", "linked.json");
			symlinkSync(freeze, linked);
			expect(() =>
				resolveCampaignInputPath({
					repositoryPath: repository,
					campaignRoot,
					inputPath: linked,
					label: "semantic freeze",
				}),
			).toThrow(/symlink/i);
		} finally {
			rmSync(repository, { recursive: true, force: true });
		}
	});

	test("runs the approved semantic authority from zero inventory back to zero", async () => {
		const backend = new MemoryBackend();
		const result = await runRigCommand(
			[
				"run",
				"--semantic-freeze",
				FREEZE,
				"--semantic-approval",
				APPROVAL,
				"--deadline",
				DEADLINE,
			],
			dependencies(backend),
		);

		expect(result.state).toBe("DESTROYED");
		expect(backend.calls.map(({ action }) => action)).toEqual([
			"VERIFY_SEMANTIC",
			"LOCAL_GATES",
			"INVENTORY",
			"ENSURE",
			"PREPARE",
			"BIND",
			"DISPATCH",
			"SEAL",
			"DESTROY",
		]);
		expect(backend.records).toHaveLength(backend.calls.length);
		for (const [index, record] of backend.records.entries()) {
			expect(record.schema).toBe("g6-c32-rig-command-operation/1");
			expect(record.envelope).toMatchObject({
				runId: backend.context.runId,
				sequence: index + 1,
				clockSource: "offrunner",
			});
			expect(record.startedAt).toMatch(/\.\d{3}Z$/);
			expect(record.finishedAt).toMatch(/\.\d{3}Z$/);
			expect(BigInt(record.durationMonotonicNs)).toBeGreaterThanOrEqual(0n);
			expect(record.outcome).toBe("SUCCEEDED");
		}
	});

	test.each([
		["inventory", "ABSENT"],
		["ensure", "CREATING"],
		["prepare", "PROVISIONED"],
		["bind", "PREPARED"],
		["dispatch", "BOUND"],
		["destroy", "TERMINAL"],
	] as const)("executes %s only from its valid lifecycle state", async (command, state) => {
		const backend = new MemoryBackend(state);
		await runRigCommand([command, "--root", ROOT], dependencies(backend));
		expect(backend.calls).toHaveLength(1);

		const invalid = new MemoryBackend("RUNNING");
		if (command !== "destroy") {
			await expect(
				runRigCommand([command, "--root", ROOT], dependencies(invalid)),
			).rejects.toThrow(/not valid from RUNNING/i);
			expect(invalid.calls).toHaveLength(0);
		}
	});

	test("resumes a live controller without starting a second controller", async () => {
		for (const state of ["QUALIFYING", "RUNNING"] as const) {
			const backend = new MemoryBackend(state);
			await runRigCommand(["resume", "--root", ROOT], dependencies(backend));
			expect(backend.calls.map(({ action }) => action)).toEqual([
				"RECOVER_LIVE",
				"SEAL",
				"DESTROY",
			]);
			expect(
				backend.calls.some(({ action }) => action === "DISPATCH"),
			).toBeFalse();
		}
	});

	test.each([
		["ABSENT", "VERIFY_SEMANTIC"],
		["CREATING", "ENSURE"],
		["PROVISIONED", "PREPARE"],
		["PREPARING", "PREPARE"],
		["PREPARED", "BIND"],
		["BINDING", "BIND"],
		["BOUND", "DISPATCH"],
		["QUALIFYING", "RECOVER_LIVE"],
		["RUNNING", "RECOVER_LIVE"],
		["TERMINAL", "SEAL"],
		["FAILED", "SEAL"],
		["DESTROYING", "DESTROY"],
	] as const)("resume chooses one deterministic next action from %s", async (state, action) => {
		const backend = new MemoryBackend(state);
		await runRigCommand(["resume", "--root", ROOT], dependencies(backend));
		expect(backend.calls[0]?.action).toBe(action);
	});

	test("ordinary post-create failure seals evidence and tears down before returning it", async () => {
		const backend = new MemoryBackend();
		backend.interruptAfter = "BIND";
		await expect(
			runRigCommand(
				[
					"run",
					"--semantic-freeze",
					FREEZE,
					"--semantic-approval",
					APPROVAL,
					"--deadline",
					DEADLINE,
				],
				dependencies(backend),
			),
		).rejects.toThrow(/interrupted after BIND/i);
		expect(backend.calls.slice(-2).map(({ action }) => action)).toEqual([
			"SEAL",
			"DESTROY",
		]);
		expect(backend.state).toBe("DESTROYED");
	});

	test("a seal failure still attempts exact-owned teardown before returning it", async () => {
		const backend = new MemoryBackend();
		backend.interruptAfter = "SEAL";
		await expect(
			runRigCommand(
				[
					"run",
					"--semantic-freeze",
					FREEZE,
					"--semantic-approval",
					APPROVAL,
					"--deadline",
					DEADLINE,
				],
				dependencies(backend),
			),
		).rejects.toThrow(/interrupted after SEAL/i);
		expect(
			backend.calls.filter(({ action }) => action === "DESTROY"),
		).toHaveLength(1);
		expect(backend.state).toBe("DESTROYED");
	});

	test("cancellation before create records cleanup-only intent and never dispatches", async () => {
		const backend = new MemoryBackend("CREATING");
		const cancellation = new AbortController();
		cancellation.abort("SIGTERM");
		await runRigCommand(
			["resume", "--root", ROOT],
			dependencies(backend, cancellation.signal),
		);
		expect(backend.calls[0]).toEqual({ action: "ENSURE", cleanupOnly: true });
		expect(
			backend.calls.some(({ action }) => action === "DISPATCH"),
		).toBeFalse();
	});

	test("rejects unknown flags before opening a run", async () => {
		const backend = new MemoryBackend();
		await expect(
			runRigCommand(
				[
					"run",
					"--semantic-freeze",
					FREEZE,
					"--semantic-approval",
					APPROVAL,
					"--deadline",
					DEADLINE,
					"--architect-receipt",
					"forbidden.json",
				],
				dependencies(backend),
			),
		).rejects.toThrow(/unknown option --architect-receipt/i);
		expect(backend.calls).toHaveLength(0);
	});
});
