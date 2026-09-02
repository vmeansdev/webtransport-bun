import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateOperationReceipt } from "./g6-c32-freeze-model.ts";
import {
	type CampaignClock,
	type CommandAdapter,
	type CommandExecutionResult,
	type CommandSpec,
	recordOperation,
	validateOperationStatusRecord,
} from "./g6-c32-operation.ts";

const temporaryRoots: string[] = [];

class FakeClock implements CampaignClock {
	readonly #wallTimes: string[];
	readonly #monotonicTimes: bigint[];

	constructor(wallTimes: string[], monotonicTimes: bigint[]) {
		this.#wallTimes = [...wallTimes];
		this.#monotonicTimes = [...monotonicTimes];
	}

	wallNow(): string {
		const value = this.#wallTimes.shift();
		if (!value) throw new Error("fake wall clock exhausted");
		return value;
	}

	monotonicNowNs(): bigint {
		const value = this.#monotonicTimes.shift();
		if (value === undefined) throw new Error("fake monotonic clock exhausted");
		return value;
	}
}

class FakeAdapter implements CommandAdapter {
	readonly seen: CommandSpec[] = [];
	readonly #results: CommandExecutionResult[];

	constructor(results: CommandExecutionResult[]) {
		this.#results = [...results];
	}

	async execute(spec: CommandSpec): Promise<CommandExecutionResult> {
		this.seen.push(spec);
		const result = this.#results.shift();
		if (!result) throw new Error("fake command results exhausted");
		return result;
	}
}

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "g6-c32-operation-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("G6 c32 recorded command boundary", () => {
	test("retains off-runner bounds and provider observation timestamps", async () => {
		const root = makeRoot();
		const result = await recordOperation(
			{
				runId: "g6-c32-provider-timing-test",
				sequence: 1,
				attempt: 1,
				artifactDirectory: join(root, "operations"),
				artifactPathPrefix: "operations",
				spec: {
					operationId: "provider-observation",
					phase: "INVENTORY",
					command: "doctl",
					args: ["compute", "droplet", "get", "101", "--output", "json"],
					cwd: ".",
					env: {},
					timeoutMs: 1_000,
					stdin: "ignore",
				},
				remoteObservationAt: () => "2026-08-30T12:00:00.050Z",
			},
			{
				clock: new FakeClock(
					["2026-08-30T12:00:00.000Z", "2026-08-30T12:00:00.100Z"],
					[0n, 100_000_000n],
				),
				adapter: new FakeAdapter([
					{
						stdout: '[{"id":101,"created_at":"2026-08-30T12:00:00Z"}]',
						stderr: "",
						status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
					},
				]),
				executionRoot: root,
			},
		);
		expect(result.receipt.remoteTiming).toEqual({
			requestStartedAt: "2026-08-30T12:00:00.000Z",
			responseFinishedAt: "2026-08-30T12:00:00.100Z",
			observationAt: "2026-08-30T12:00:00.050Z",
		});
		expect(
			validateOperationReceipt(
				JSON.parse(readFileSync(result.receiptPath, "utf8")),
			).remoteTiming,
		).toEqual(result.receipt.remoteTiming);
	}, 15_000);

	test("default adapter passes only explicitly allowed environment values", async () => {
		const root = makeRoot();
		const inheritedKey = "G6_C32_OPERATION_INHERITED_SECRET";
		const previous = process.env[inheritedKey];
		process.env[inheritedKey] = "must-not-reach-child";
		try {
			const result = await recordOperation(
				{
					runId: "g6-c32-environment-test",
					sequence: 1,
					attempt: 1,
					artifactDirectory: join(root, "operations"),
					artifactPathPrefix: "operations",
					spec: {
						operationId: "environment-allow-list",
						phase: "LOCAL_GATES",
						command: process.execPath,
						args: [
							"-e",
							`process.stdout.write(JSON.stringify({ allowed: process.env.G6_C32_ALLOWED, inherited: process.env.${inheritedKey} ?? null }))`,
						],
						cwd: ".",
						env: { G6_C32_ALLOWED: "visible" },
						timeoutMs: 5_000,
						stdin: "ignore",
					},
				},
				{
					clock: new FakeClock(
						["2026-08-30T12:00:00.000Z", "2026-08-30T12:00:00.100Z"],
						[0n, 100_000_000n],
					),
					executionRoot: root,
				},
			);
			const childEnvironment = JSON.parse(
				readFileSync(result.stdoutPath, "utf8"),
			) as unknown;
			expect(childEnvironment).toEqual({
				allowed: "visible",
				inherited: null,
			});
			expect(result.receipt.action.environmentKeys).toEqual(["G6_C32_ALLOWED"]);
			expect(readFileSync(result.receiptPath, "utf8")).not.toContain("visible");
		} finally {
			if (previous === undefined) delete process.env[inheritedKey];
			else process.env[inheritedKey] = previous;
		}
	}, 15_000);

	test("publishes timestamped stdout, stderr, status, and receipt for every outcome", async () => {
		const root = makeRoot();
		const clock = new FakeClock(
			[
				"2026-08-30T12:00:00.000Z",
				"2026-08-30T12:00:00.125Z",
				"2026-08-30T12:01:00.000Z",
				"2026-08-30T12:01:00.250Z",
				"2026-08-30T12:02:00.000Z",
				"2026-08-30T12:02:00.500Z",
				"2026-08-30T12:03:00.000Z",
				"2026-08-30T12:03:00.750Z",
			],
			[
				0n,
				125_000_000n,
				1_000_000_000n,
				1_250_000_000n,
				2_000_000_000n,
				2_500_000_000n,
				3_000_000_000n,
				3_750_000_000n,
			],
		);
		const outcomes: CommandExecutionResult[] = [
			{
				stdout: "success stdout\n",
				stderr: "",
				status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
			},
			{
				stdout: "",
				stderr: "failed stderr\n",
				status: { outcome: "FAILED", exitCode: 23, signal: null },
			},
			{
				stdout: "partial timeout\n",
				stderr: "timed out\n",
				status: { outcome: "TIMED_OUT", exitCode: null, signal: "SIGTERM" },
			},
			{
				stdout: "partial cancellation\n",
				stderr: "cancelled\n",
				status: { outcome: "CANCELLED", exitCode: null, signal: "SIGTERM" },
			},
		];
		const adapter = new FakeAdapter(outcomes);
		const specs: CommandSpec[] = [
			{
				operationId: "success",
				phase: "LOCAL_GATES",
				command: "bun",
				args: ["test", "fixture.test.ts"],
				cwd: ".",
				env: { PATH: "/usr/bin", DO_TOKEN: "never-persist-this" },
				timeoutMs: 1_000,
				stdin: "ignore",
			},
			{
				operationId: "nonzero",
				phase: "LOCAL_GATES",
				command: "false",
				args: [],
				cwd: ".",
				env: { PATH: "/usr/bin" },
				timeoutMs: 1_000,
				stdin: "ignore",
			},
			{
				operationId: "timeout",
				phase: "SSH_READY",
				command: "ssh",
				args: ["root@host", "true"],
				cwd: ".",
				env: { PATH: "/usr/bin" },
				timeoutMs: 10,
				stdin: "ignore",
			},
			{
				operationId: "cancelled",
				phase: "ARTIFACT_COPY",
				command: "scp",
				args: ["-o", "BatchMode=no", "source", "root@host:destination"],
				cwd: ".",
				env: { PATH: "/usr/bin" },
				timeoutMs: 1_000,
				stdin: "ignore",
			},
		];

		for (const [index, spec] of specs.entries()) {
			const expectedOutcome = outcomes[index];
			const expectedDuration = [
				"125000000",
				"250000000",
				"500000000",
				"750000000",
			][index];
			if (!expectedOutcome || !expectedDuration) {
				throw new Error(`missing expected fixture at index ${index}`);
			}
			const result = await recordOperation(
				{
					runId: "g6-c32-operation-test",
					sequence: index + 1,
					attempt: 1,
					artifactDirectory: join(root, "operations"),
					artifactPathPrefix: "operations",
					spec,
				},
				{ clock, adapter, executionRoot: root },
			);
			const names = readdirSync(result.directoryPath).sort();
			expect(names).toEqual([
				"operation.receipt.json",
				"operation.status",
				"operation.stderr",
				"operation.stdout",
			]);
			const receipt = validateOperationReceipt(
				JSON.parse(readFileSync(result.receiptPath, "utf8")),
			);
			const status = validateOperationStatusRecord(
				JSON.parse(readFileSync(result.statusPath, "utf8")),
			);
			expect(receipt.status).toEqual(expectedOutcome.status);
			expect(status.status).toEqual(receipt.status);
			expect(status.envelope).toEqual(receipt.envelope);
			expect(receipt.envelope.recordedAt).toBe(receipt.finishedAt);
			expect(receipt.durationMonotonicNs).toBe(expectedDuration);
			expect(receipt.stdoutPath.endsWith("/operation.stdout")).toBeTrue();
			expect(receipt.stderrPath.endsWith("/operation.stderr")).toBeTrue();
			const persistedMetadata = `${readFileSync(result.receiptPath, "utf8")}${readFileSync(result.statusPath, "utf8")}`;
			expect(persistedMetadata).not.toContain("never-persist-this");
		}

		expect(adapter.seen[0]?.args).toEqual(["test", "fixture.test.ts"]);
		expect(adapter.seen[2]?.args).toEqual(["-n", "root@host", "true"]);
		expect(adapter.seen[3]?.args).toEqual([
			"-o",
			"BatchMode=yes",
			"source",
			"root@host:destination",
		]);
		expect(adapter.seen.every((spec) => spec.stdin === "ignore")).toBeTrue();

		for (const directory of readdirSync(join(root, "operations"))) {
			const files = readdirSync(join(root, "operations", directory));
			for (const output of files.filter((name) =>
				/\.(?:stdout|stderr|status)$/.test(name),
			)) {
				expect(output).toBeString();
				expect(files).toContain("operation.receipt.json");
			}
		}
	}, 15_000);
});
