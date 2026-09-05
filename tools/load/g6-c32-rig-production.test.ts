import { afterEach, expect, spyOn, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendSpendLedgerEntry,
	budgetPolicyArtifactSha256,
	validateBudgetPolicy,
	validateSpendLedger,
} from "./g6-c32-budget.ts";
import { makeAttributionWorkPlan } from "./g6-c32-capacity-work.ts";
import {
	destructionReceiptFromFinalJournal,
	loadRigStateFromJournal,
	normalizeDropletInventory,
	validateG6DestructionReceipt,
} from "./g6-c32-digitalocean.ts";
import * as freezeModule from "./g6-c32-freeze.ts";
import {
	canonicalArtifactSha256,
	canonicalJson,
} from "./g6-c32-freeze-model.ts";
import {
	BunCommandAdapter,
	type CommandAdapter,
	type CommandSpec,
	startOwnedCommand,
} from "./g6-c32-operation.ts";
import {
	appendRigJournalEvent,
	initializeRigJournal,
	readRigJournal,
} from "./g6-c32-rig-journal.ts";
import { validateDesiredRig, validateRigState } from "./g6-c32-rig-model.ts";
import {
	controllerSignalTarget,
	ProductionRigBackend,
} from "./g6-c32-rig-production.ts";
import { verifyTerminalEvidence } from "./g6-c32-terminal-evidence.ts";
import { makeAttributionWorkProfiles } from "./g6-c32-work-profile.ts";
import { contextFromBound } from "./g6-capacity-host-review.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const epoch = Date.parse("2100-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const supervisorToken = "a1111111-1111-4111-8111-111111111111";
const replacementToken = "b2222222-2222-4222-8222-222222222222";

test("controller recovery group signals only its exact recorded supervisor", () => {
	const launch = {
		pid: 12345,
		processGroupId: 12345,
		supervisorToken,
		command: "bash",
		args: [
			"/repo/controller.sh",
			"run",
			"--bound-root",
			"/repo/run-unique/bound",
		],
	};
	const command = `bun -e const supervisorToken="${supervisorToken}";inline-supervisor -- bash /repo/controller.sh run --bound-root /repo/run-unique/bound`;
	expect(controllerSignalTarget(launch, `12345 12345 ${command}`)).toBe(-12345);
	expect(() =>
		controllerSignalTarget(launch, `12345 12346 ${command}`),
	).toThrow(/group/);
	expect(() =>
		controllerSignalTarget(launch, `12346 12346 ${command}`),
	).toThrow(/identity/);
	expect(() =>
		controllerSignalTarget(launch, `12345 12345 ${command} extra`),
	).toThrow(/command/);
	expect(() =>
		controllerSignalTarget(
			{ ...launch, processGroupId: 99999 },
			`12345 12345 ${command}`,
		),
	).toThrow(/group/);
	const { processGroupId: _group, supervisorToken: _token, ...legacy } = launch;
	expect(
		controllerSignalTarget(
			legacy,
			`12345 56789 bash /repo/controller.sh run --bound-root /repo/run-unique/bound`,
		),
	).toBe(12345);
});

test("controller recovery refuses a reused PID/group with a different supervisor incarnation", () => {
	const launch = {
		pid: 42424,
		processGroupId: 42424,
		supervisorToken,
		command: "bash",
		args: ["/repo/controller.sh", "run"],
	};
	for (const script of [
		`const supervisorToken="${replacementToken}";`,
		`const supervisorToken="${replacementToken}";const decoy="${supervisorToken}";`,
		`const other="${supervisorToken}";`,
		`const decoy=1;const supervisorToken="${supervisorToken}";`,
		`const supervisorToken='${supervisorToken}';`,
	]) {
		expect(() =>
			controllerSignalTarget(
				launch,
				`42424 42424 /opt/bin/bun -e ${script}supervisor -- bash /repo/controller.sh run`,
			),
		).toThrow(/supervisor.*incarnation|supervisor.*nonce/);
	}
	for (const token of [
		undefined,
		"",
		supervisorToken.toUpperCase(),
		"not-a-uuid",
		"11111111-1111-1111-8111-111111111111",
	]) {
		expect(() =>
			controllerSignalTarget(
				{ ...launch, supervisorToken: token },
				`42424 42424 /opt/bin/bun -e const supervisorToken="${String(token)}";supervisor -- bash /repo/controller.sh run`,
			),
		).toThrow(/supervisor.*token/);
	}
});

function fixture(deadlineSeconds = 6000, profileShards = 24) {
	const repositoryPath = realpathSync(
		mkdtempSync(join(tmpdir(), "g6-production-clock-")),
	);
	roots.push(repositoryPath);
	const campaignRoot = join(repositoryPath, "campaign");
	const root = join(campaignRoot, "provisioning", "g6-production-clock");
	mkdirSync(root, { recursive: true });
	const runId = "g6-production-clock";
	const policy = validateBudgetPolicy({
		schema: "g6-c32-budget-policy/2",
		campaignId: "g6-capacity",
		runId,
		currency: "USD",
		lifecycle: "attribution-only",
		totalBudgetMicrousd: 103544166,
		spentBeforeMicrousd: 91350910,
		maximumRoleHourlyMicrousd: { server: 1949400, generator: 1949400 },
		maximumLifecycleSeconds: 4260,
		teardownReserveSeconds: 600,
		maximumLifecycleCostMicrousd: 5263380,
		cellMaximumSeconds: { attribution: 420 },
		allowedStages: ["attribution"],
		priorLedger: {
			path: "prior.json",
			sha256: "b".repeat(64),
			sealedSpentMicrousd: 91350910,
		},
		workPlan: makeAttributionWorkPlan(),
		workProfiles: makeAttributionWorkProfiles({
			shards: profileShards,
			endpoints: 128,
			connectConcurrency: 50,
			connectRatePerSec: 250,
			fixedSourcePortBase: 20000,
			receiveBufferBytes: 26214400,
			gradeMode: "rca-only",
			ackReflector: "native",
			serverWorkers: 3,
			serverGro: "off",
			serverRecvRuntime: "shared",
			ackCadence: "default",
			pacerPps: 0,
			udpSendBatch: 0,
			serverUdpSendBufferBytes: 0,
			serverUdpSendEagainMode: "wait",
			reflectRingBypass: "off",
			detailedProbe: true,
			nativeDiagnostics: true,
		}),
	});
	writeFileSync(join(repositoryPath, "policy.json"), canonicalJson(policy));
	const desired = validateDesiredRig({
		recordedAt: at(0),
		requestedAt: at(0),
		deadline: at(deadlineSeconds),
		runId,
		managementTag: "g6-managed",
		runTag: runId,
		roles: {
			serverName: `${runId}-server`,
			generatorName: `${runId}-generator`,
		},
		profile: {
			region: "ams3",
			size: "c-48-intel",
			image: "ubuntu-24-04-x64",
			vpcUuid: "test-vpc",
			projectMode: "assign",
			projectId: "test-project",
			sshKeyId: 77,
			expectedVcpus: 48,
			expectedMemoryMiB: 98304,
		},
		semantic: {
			freezeAuthoritySha256: "1".repeat(64),
			freezeArtifactSha256: "2".repeat(64),
			approvalAuthoritySha256: "3".repeat(64),
			approvalArtifactSha256: "4".repeat(64),
		},
		budget: {
			campaignId: policy.campaignId,
			lifecycle: "attribution-only",
			policyPath: "policy.json",
			policySha256: budgetPolicyArtifactSha256(policy),
			totalBudgetMicrousd: policy.totalBudgetMicrousd,
			spentBeforeMicrousd: policy.spentBeforeMicrousd,
			priorLedgerArtifactSha256: "b".repeat(64),
			maximumLifecycleCostMicrousd: policy.maximumLifecycleCostMicrousd,
			maximumLifecycleSeconds: policy.maximumLifecycleSeconds,
			teardownReserveSeconds: 600,
			rolePriceCeilingMicrousd: policy.maximumRoleHourlyMicrousd,
		},
	});
	const context = { runId, root, deadline: desired.deadline };
	writeFileSync(
		join(root, "run-authority.json"),
		canonicalJson({
			schema: "g6-c32-rig-run-authority/1",
			envelope: { recordedAt: at(0), runId, phase: "ABSENT" },
			repositoryPath,
			campaignRoot,
			context,
			desired,
			semantic: {
				...desired.semantic,
				freezePath: "freeze.json",
				approvalPath: "approval.json",
				architectReceiptPath: "architect.json",
				criticReceiptPath: "critic.json",
			},
		}),
	);
	let seconds = 0,
		tickOnRead = 0;
	const clock = {
		wallNow: () => {
			const now = at(seconds);
			seconds += tickOnRead;
			return now;
		},
		monotonicNowNs: () => BigInt(Math.round(seconds * 1000000000)),
	};
	const journalPath = join(root, "rig-state.json");
	initializeRigJournal(
		{ path: journalPath, runId, desiredRigAuthority: desired },
		{ clock, randomId: () => "initial" },
	);
	const paid = (setupComplete = false) => {
		const rigState = validateRigState({
			desired,
			preCreateBudgetAuthority: null,
			lifecycle: setupComplete ? "RUNNING" : "CREATING",
			ownedResources: [],
			createIntent: null,
			creationAttempt: 1,
			evidence: {
				offrunnerEvidenceSealed: false,
				controllerExited: !setupComplete,
				cleanupDisposition: null,
				inventoryAmbiguous: false,
			},
		});
		appendRigJournalEvent(
			journalPath,
			{
				kind: "CREATE_INTENT",
				state: "CREATING",
				operationId: "paid-intent",
				spendLedgerHeadArtifactSha256: "a".repeat(64),
				details: { rigState },
			},
			{ clock, randomId: () => "intent" },
		);
		if (setupComplete)
			appendRigJournalEvent(
				journalPath,
				{
					kind: "TRANSITION",
					state: "RUNNING",
					operationId: "controller-dispatch-authorized",
					details: { rigState },
				},
				{ clock, randomId: () => "running" },
			);
	};
	return {
		context,
		clock,
		journalPath,
		paid,
		policy,
		repositoryPath,
		setTime: (value: number) => {
			seconds = value;
		},
		setTickOnRead: (value: number) => {
			tickOnRead = value;
		},
		backend: (commandAdapter: CommandAdapter) =>
			new ProductionRigBackend({
				repositoryPath,
				campaignRoot,
				clock,
				commandAdapter,
				environment: {},
			}),
	};
}

function hostReviewDispatchFixture() {
	const f = fixture();
	f.paid();
	const rigState = validateRigState({
		...loadRigStateFromJournal(f.journalPath),
		lifecycle: "BOUND",
	});
	appendRigJournalEvent(
		f.journalPath,
		{
			kind: "TRANSITION",
			state: "BOUND",
			operationId: "fixture-bound",
			details: { rigState },
		},
		{ clock: f.clock, randomId: () => "bound" },
	);
	// Only BOUND verification is stubbed. This exercises the real /2 paid clock,
	// review-file validation, cancellation, journal and pre-spawn dispatch path.
	const verified = {
		runId: f.context.runId,
		semanticFreeze: {
			authoritySha256: "1".repeat(64),
			authority: {
				controller: { path: "controller.sh" },
				budgetPolicy: { path: "policy.json" },
			},
		},
		hostBinding: { envelope: { recordedAt: at(800) } },
		dispatchFreeze: { envelope: { recordedAt: at(801) } },
	} as ReturnType<typeof freezeModule.verifyBoundFreeze>;
	const bound = spyOn(freezeModule, "verifyBoundFreeze").mockReturnValue(
		verified,
	);
	const reviewRoot = join(f.context.root, "host-reviews");
	let calls = 0;
	const backend = f.backend({
		execute: async () => {
			calls++;
			throw Error("unexpected command before host review");
		},
	});
	const assertNeverLaunched = () => {
		expect(calls).toBe(0);
		expect(existsSync(join(f.context.root, "controller-launch.json"))).toBe(
			false,
		);
		expect(
			readRigJournal(f.journalPath).events.some(
				(event) => event.envelope.operationId === "launch-locked-controller",
			),
		).toBe(false);
		expect(loadRigStateFromJournal(f.journalPath).lifecycle).toBe("FAILED");
		expect(
			loadRigStateFromJournal(f.journalPath).evidence.controllerExited,
		).toBe(true);
	};
	return { ...f, verified, bound, reviewRoot, backend, assertNeverLaunched };
}

test("host reviews share the original paid setup cutoff and never launch when missing", async () => {
	const f = hostReviewDispatchFixture();
	f.setTime(830);
	const timer = setTimeout(() => f.setTime(841), 30);
	try {
		await expect(
			f.backend.execute({
				context: f.context,
				action: "DISPATCH",
				cleanupOnly: false,
			}),
		).rejects.toThrow(/setup cutoff|host review.*cancel/);
		f.assertNeverLaunched();
		const request = JSON.parse(
			readFileSync(join(f.context.root, "host-review-request.json"), "utf8"),
		);
		expect(request.cutoffAt).toBe(at(840));
		expect(request.context).toEqual(contextFromBound(f.verified));
	} finally {
		clearTimeout(timer);
		f.bound.mockRestore();
	}
}, 3000);

test("host review waiting responds to cancellation before any controller intent", async () => {
	const f = hostReviewDispatchFixture();
	f.setTime(830);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30);
	try {
		await expect(
			f.backend.execute({
				context: f.context,
				action: "DISPATCH",
				cleanupOnly: false,
				signal: controller.signal,
			}),
		).rejects.toThrow(/host review.*cancel/);
		f.assertNeverLaunched();
	} finally {
		clearTimeout(timer);
		f.bound.mockRestore();
	}
}, 3000);

test("an architect refusal stops host review waiting without waiting for a critic", async () => {
	const f = hostReviewDispatchFixture();
	f.setTime(830);
	mkdirSync(f.reviewRoot, { recursive: true });
	writeFileSync(
		join(f.reviewRoot, "architect.json"),
		canonicalJson({ verdict: "REJECT" }),
	);
	try {
		await expect(
			f.backend.execute({
				context: f.context,
				action: "DISPATCH",
				cleanupOnly: false,
			}),
		).rejects.toThrow(/architect.*unconditional.*APPROVE/);
		f.assertNeverLaunched();
	} finally {
		f.bound.mockRestore();
	}
}, 3000);

function writeHostReviewPair(f: ReturnType<typeof hostReviewDispatchFixture>) {
	const context = contextFromBound(f.verified);
	const note = "Unconditional APPROVE of the exact bound host fixture.\n";
	const architect = {
		schema: "g6-capacity-host-review/1",
		context,
		role: "architect",
		verdict: "APPROVE",
		unconditional: true,
		reviewedAt: at(810),
		afterArchitectArtifactSha256: null,
		reviewNoteSha256: new Bun.CryptoHasher("sha256").update(note).digest("hex"),
	};
	const critic = {
		...architect,
		role: "critic",
		reviewedAt: at(820),
		afterArchitectArtifactSha256: canonicalArtifactSha256(architect),
	};
	mkdirSync(f.reviewRoot, { recursive: true });
	for (const [name, record] of [
		["architect", architect],
		["critic", critic],
	] as const) {
		writeFileSync(join(f.reviewRoot, `${name}.json`), canonicalJson(record));
		writeFileSync(join(f.reviewRoot, `${name}.md`), note);
	}
}

test("approved exact host reviews are followed by fresh BOUND verification before launch intent", async () => {
	const f = hostReviewDispatchFixture();
	f.setTime(830);
	writeHostReviewPair(f);
	f.bound.mockReturnValueOnce(f.verified).mockImplementation(() => {
		throw Error("fixture BOUND changed after review");
	});
	try {
		await expect(
			f.backend.execute({
				context: f.context,
				action: "DISPATCH",
				cleanupOnly: false,
			}),
		).rejects.toThrow("fixture BOUND changed after review");
		expect(f.bound).toHaveBeenCalledTimes(2);
		f.assertNeverLaunched();
	} finally {
		f.bound.mockRestore();
	}
}, 3000);

test.skipIf(process.platform === "win32")(
	"controller launch persists the actual immutable supervisor incarnation",
	async () => {
		const f = hostReviewDispatchFixture();
		f.setTime(830);
		writeHostReviewPair(f);
		const identityPath = join(f.repositoryPath, "fixture-key");
		writeFileSync(identityPath, "local fixture only\n");
		writeFileSync(`${identityPath}.pub`, "local fixture only\n");
		const witnessPath = join(f.repositoryPath, "supervisor-identity");
		// This harmless controller fixture only witnesses its supervisor and exits;
		// it never invokes the real controller, SSH or a provider.
		writeFileSync(
			join(f.repositoryPath, "controller.sh"),
			`/bin/ps -ww -p "$PPID" -o pid=,pgid=,command= > '${witnessPath}'\nexit 37\n`,
		);
		const backend = new ProductionRigBackend({
			repositoryPath: f.repositoryPath,
			campaignRoot: join(f.repositoryPath, "campaign"),
			clock: f.clock,
			environment: { G6_C32_SSH_IDENTITY_PATH: identityPath },
			commandAdapter: {
				execute: async () => {
					throw Error("unexpected external operation");
				},
			},
		});
		try {
			await expect(
				within(
					backend.execute({
						context: f.context,
						action: "DISPATCH",
						cleanupOnly: false,
					}),
					3000,
				),
			).rejects.toThrow(/locked controller gate did not complete/);
			const launch = JSON.parse(
				readFileSync(join(f.context.root, "controller-launch.json"), "utf8"),
			);
			expect(launch.schema).toBe("g6-c32-controller-launch/2");
			expect(launch.supervisorToken).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(
				controllerSignalTarget(launch, readFileSync(witnessPath, "utf8")),
			).toBe(-launch.pid);
			expect(() => process.kill(-launch.pid, 0)).toThrow();
			expect(
				loadRigStateFromJournal(f.journalPath).evidence.controllerExited,
			).toBe(true);
		} finally {
			f.bound.mockRestore();
		}
	},
	5000,
);

test("production refuses insufficient whole-plan time before any provider call", async () => {
	const f = fixture(4859);
	let calls = 0;
	const backend = f.backend({
		execute: async () => {
			calls++;
			return {
				stdout: "",
				stderr: "unexpected provider call",
				status: { outcome: "FAILED", exitCode: 1, signal: null },
			};
		},
	});
	await expect(
		backend.execute({
			context: f.context,
			action: "ENSURE",
			cleanupOnly: false,
		}),
	).rejects.toThrow(/whole remaining work/);
	expect(calls).toBe(0);
});

test("production refuses profile shards inconsistent with the desired host before any provider call", async () => {
	const f = fixture(6000, 16);
	let calls = 0;
	const backend = f.backend({
		execute: async () => {
			calls++;
			return {
				stdout: "",
				stderr: "unexpected provider call",
				status: { outcome: "FAILED", exitCode: 1, signal: null },
			};
		},
	});
	await expect(
		backend.execute({
			context: f.context,
			action: "ENSURE",
			cleanupOnly: false,
		}),
	).rejects.toThrow(/work profile shards/);
	expect(calls).toBe(0);
});

test.each([
	false,
	true,
])("production watchdog aborts a provider wait at the durable %s setup/active cutoff", async (setupComplete) => {
	const f = fixture();
	f.paid(setupComplete);
	const cutoff = setupComplete ? 4260 : 840;
	f.setTime(cutoff - 1);
	let wasAborted = false;
	const backend = f.backend({
		execute: async (_spec, signal) => {
			if (!signal) throw Error("production provider lacks cancellation signal");
			f.setTime(cutoff);
			await Promise.race([
				new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else
						signal.addEventListener("abort", () => resolve(), { once: true });
				}),
				Bun.sleep(350),
			]);
			wasAborted = signal.aborted;
			return {
				stdout: "",
				stderr: "bounded test provider stopped",
				status: {
					outcome: wasAborted ? "CANCELLED" : "FAILED",
					exitCode: null,
					signal: null,
				},
			};
		},
	});
	await expect(
		backend.execute({
			context: f.context,
			action: "INVENTORY",
			cleanupOnly: false,
		}),
	).rejects.toThrow();
	expect(wasAborted).toBe(true);
}, 2000);

test("cleanup provider waits share a durable collection cutoff and cannot renew it on replay", async () => {
	const f = fixture();
	f.paid(true);
	f.setTime(4260);
	let calls = 0;
	let aborted = false;
	const backend = f.backend({
		execute: async (_spec, signal) => {
			calls++;
			if (!signal) throw Error("cleanup must carry the shared cutoff signal");
			f.setTime(4560);
			await Promise.race([
				new Promise<void>((resolve) => {
					if (signal.aborted) resolve();
					else
						signal.addEventListener("abort", () => resolve(), { once: true });
				}),
				Bun.sleep(350),
			]);
			aborted = signal.aborted;
			return {
				stdout: "",
				stderr: "fixture shared cutoff",
				status: { outcome: "CANCELLED", exitCode: null, signal: null },
			};
		},
	});
	await expect(
		backend.execute({
			context: f.context,
			action: "INVENTORY",
			cleanupOnly: true,
		}),
	).rejects.toThrow();
	expect(aborted).toBe(true);
	const firstCalls = calls;
	f.setTime(4580);
	await expect(
		backend.execute({
			context: f.context,
			action: "INVENTORY",
			cleanupOnly: true,
		}),
	).rejects.toThrow();
	expect(calls).toBe(firstCalls);
	const starts = readRigJournal(f.journalPath).events.filter(
		(event) => event.envelope.operationId === "begin-funded-teardown",
	);
	expect(starts).toHaveLength(1);
	expect(starts[0]?.envelope.recordedAt).toBe(at(4260));
}, 2000);

test("early teardown with an advancing clock can replay without blocking cleanup calls", async () => {
	const f = fixture();
	f.paid();
	f.setTime(10);
	f.setTickOnRead(0.001);
	let calls = 0;
	const backend = f.backend({
		execute: async () => {
			calls++;
			return {
				stdout: "",
				stderr: "synthetic provider failure",
				status: { outcome: "FAILED", exitCode: 1, signal: null },
			};
		},
	});
	for (let attempt = 0; attempt < 2; attempt++) {
		await expect(
			backend.execute({
				context: f.context,
				action: "INVENTORY",
				cleanupOnly: true,
			}),
		).rejects.toThrow();
	}
	expect(calls).toBe(2);
	expect(
		readRigJournal(f.journalPath).events.filter(
			(event) => event.envelope.operationId === "begin-funded-teardown",
		),
	).toHaveLength(1);
}, 2000);

test("expired cleanup seals a minimal INCOMPLETE receipt without hashing optional evidence", async () => {
	const f = fixture();
	f.paid();
	f.setTime(1441);
	const raw = join(f.context.root, "optional-large-raw.json");
	writeFileSync(raw, "raw-fixture\n");
	let calls = 0;
	const backend = f.backend({
		execute: async () => {
			calls++;
			throw Error("no gate or provider call expected");
		},
	});
	await backend.execute({
		context: f.context,
		action: "SEAL",
		cleanupOnly: true,
	});
	expect(calls).toBe(0);
	expect(readFileSync(join(f.context.root, "RUN_STATUS"), "utf8")).toBe(
		"INCOMPLETE\n",
	);
	const event = readRigJournal(f.journalPath).events.findLast(
		(event) => event.envelope.operationId === "offrunner-evidence-sealed",
	);
	const sealRoot = (event?.details as { result: { sealRoot: string } }).result
		.sealRoot;
	const receipt = JSON.parse(
		readFileSync(join(sealRoot, "seal-receipt.json"), "utf8"),
	);
	expect(receipt.evidenceCollectionComplete).toBe(false);
	const manifest = JSON.parse(
		readFileSync(join(sealRoot, "artifact-manifest.json"), "utf8"),
	);
	expect(
		manifest.entries.some((entry: { path: string }) =>
			entry.path.includes("optional-large-raw"),
		),
	).toBe(false);
});

function emptyInventoryAdapter(calls: CommandSpec[]): CommandAdapter {
	return {
		execute: async (spec) => {
			calls.push(spec);
			const response =
				spec.args.join(" ") === "account get --output json"
					? { uuid: "test-account", status: "active", droplet_limit: 25 }
					: spec.args.join(" ") === "projects get test-project --output json"
						? { id: "test-project", owner_uuid: "test-account" }
						: [];
			// Unexpected calls fail the assertions or parsing, not an unbounded
			// emergency retry caused by a synthetic transport error.
			return {
				stdout: JSON.stringify(response),
				stderr: "",
				status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
			};
		},
	};
}

test.each([
	false,
	true,
])("failed local controller proof does not strand the exact priced /2 pair after cutoff (wrong incarnation: %s)", async (wrongIncarnation) => {
	const f = fixture();
	f.paid(true);
	const previous = loadRigStateFromJournal(f.journalPath);
	const { desired } = previous;
	const rawDroplets = (["server", "generator"] as const).map((role, index) => ({
		id: 101 + index,
		name: desired.roles[`${role}Name`],
		memory: desired.profile.expectedMemoryMiB,
		vcpus: desired.profile.expectedVcpus,
		disk: 400,
		region: { slug: desired.profile.region, name: "Amsterdam 3" },
		image: { id: 232566559, slug: desired.profile.image },
		size_slug: desired.profile.size,
		status: "active",
		networks: {
			v4: [
				{ ip_address: `203.0.113.${10 + index}`, type: "public" },
				{ ip_address: `10.110.0.${10 + index}`, type: "private" },
			],
		},
		tags: [desired.managementTag, desired.runTag],
		vpc_uuid: desired.profile.vpcUuid,
		created_at: at(0),
	}));
	const identities = normalizeDropletInventory(JSON.stringify(rawDroplets), {
		desired,
		scope: "current-run",
		projectResourceIds: [101, 102],
		provenSshKeyId: desired.profile.sshKeyId,
	});
	const priceReceipt = {
		recordedAt: at(0),
		clockSource: "provider",
		runId: desired.runId,
		serverHourlyMicrousd: 1949400,
		generatorHourlyMicrousd: 1949400,
		artifactSha256: canonicalArtifactSha256({
			slug: desired.profile.size,
			price_hourly: "1.9494",
		}),
	};
	const paidIntent = readRigJournal(f.journalPath).events.find(
		(event) => event.kind === "CREATE_INTENT",
	);
	if (!paidIntent) throw Error("fixture lacks paid origin");
	const totalAuthorizedMicrousd =
		f.policy.spentBeforeMicrousd + f.policy.maximumLifecycleCostMicrousd;
	writeFileSync(
		join(f.context.root, "spend-ledger.json"),
		canonicalJson([
			appendSpendLedgerEntry(null, {
				recordedAt: at(0),
				campaignId: f.policy.campaignId,
				runId: desired.runId,
				budgetPolicySha256: budgetPolicyArtifactSha256(f.policy),
				event: "CREATE_INTENT",
				rigJournalEventArtifactSha256: canonicalArtifactSha256(paidIntent),
				accruedLifecycleMicrousd: 0,
				prospectiveCellMicrousd: 0,
				teardownReserveMicrousd: 649800,
				totalAuthorizedMicrousd,
				remainingBudgetMicrousd:
					f.policy.totalBudgetMicrousd - totalAuthorizedMicrousd,
				decision: null,
			}),
		]),
	);
	f.setTime(6001);
	// Keep exact paid provider authority independent of local process ownership.
	// The second case obtains controllerExited:false from real nonce refusal.
	appendRigJournalEvent(
		f.journalPath,
		{
			kind: "RECOVERY",
			state: wrongIncarnation ? "RUNNING" : "FAILED",
			operationId: "local-controller-proof-failed",
			details: {
				rigState: validateRigState({
					...previous,
					lifecycle: wrongIncarnation ? "RUNNING" : "FAILED",
					preCreateBudgetAuthority: {
						priceReceipt,
						absenceProof: {
							recordedAt: at(0),
							clockSource: "provider",
							runId: desired.runId,
							campaignTag: desired.managementTag,
							liveProviderIds: [],
							artifactSha256: canonicalArtifactSha256([]),
						},
					},
					ownedResources: identities.map((recordedIdentity) => ({
						id: recordedIdentity.id,
						role: recordedIdentity.role,
						source: "CREATED",
						creationAttempt: 1,
						recordedAt: at(0),
						recordedIdentity,
					})),
					evidence: {
						...previous.evidence,
						controllerExited: false,
						cleanupDisposition: null,
					},
				}),
				result: { error: "local controller process-group absence unverified" },
			},
		},
		{ clock: f.clock, randomId: () => "failed-local-controller" },
	);
	const calls: CommandSpec[] = [];
	const empty = emptyInventoryAdapter(calls);
	const live = new Map(rawDroplets.map((droplet) => [droplet.id, droplet]));
	const local = new BunCommandAdapter(f.repositoryPath);
	const backend = f.backend({
		execute: async (spec) => {
			if (spec.command === "/bin/ps") {
				calls.push(spec);
				return local.execute(spec);
			}
			const args = spec.args.join(" ");
			let response: unknown;
			if (args === "compute droplet delete 101 102 --force") {
				live.delete(101);
				live.delete(102);
				response = [];
			} else if (
				args === "projects resources list test-project --output json"
			) {
				response = [...live.keys()].map((id) => ({
					urn: `do:droplet:${id}`,
					status: "ok",
				}));
			} else if (
				args ===
					`compute droplet list --tag-name ${desired.managementTag} --output json` ||
				args ===
					`compute droplet list --tag-name ${desired.runTag} --output json`
			) {
				response = [...live.values()];
			} else if (/^compute droplet get (101|102) --output json$/.test(args)) {
				const id = Number(spec.args[3]);
				const droplet = live.get(id);
				if (!droplet) {
					calls.push(spec);
					return {
						stdout: "",
						stderr: `Error: GET /v2/droplets/${id}: 404 not found`,
						status: { outcome: "FAILED", exitCode: 1, signal: null },
					};
				}
				response = [droplet];
			} else return empty.execute(spec);
			calls.push(spec);
			return {
				stdout: JSON.stringify(response),
				stderr: "",
				status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
			};
		},
	});
	let handle: ReturnType<typeof startOwnedCommand> | undefined;
	let bound: ReturnType<typeof recoveryLaunchFixture> | undefined;
	try {
		if (wrongIncarnation) {
			writeFileSync(
				join(f.repositoryPath, "controller.sh"),
				"trap '' TERM\nsleep 10\n",
			);
			handle = startOwnedCommand(
				{
					operationId: "local-emergency-nonce-fixture",
					phase: "RECOVERY",
					command: "bash",
					args: recoveryControllerArgs(f),
					cwd: ".",
					env: {},
					timeoutMs: 5000,
					stdin: "ignore",
				},
				f.repositoryPath,
			);
			if (handle.pid === null) throw Error("fixture has no supervisor PID");
			const pid = handle.pid;
			bound = recoveryLaunchFixture(f, pid, replacementToken, false);
			await expect(
				within(
					backend.execute({
						context: f.context,
						action: "RECOVER_LIVE",
						cleanupOnly: true,
					}),
					1500,
				),
			).rejects.toThrow(/supervisor.*incarnation|supervisor.*nonce/);
			expect(calls.map(({ command }) => command)).toEqual(["/bin/ps"]);
			expect(() => process.kill(-pid, 0)).not.toThrow();
			expect(
				loadRigStateFromJournal(f.journalPath).evidence.controllerExited,
			).toBe(false);
		}
		const recoveryCalls = calls.length;
		await backend.execute({
			context: f.context,
			action: "SEAL",
			cleanupOnly: true,
		});
		expect(calls).toHaveLength(recoveryCalls);
		expect(readFileSync(join(f.context.root, "RUN_STATUS"), "utf8")).toBe(
			"INCOMPLETE\n",
		);
		expect(loadRigStateFromJournal(f.journalPath).evidence).toMatchObject({
			offrunnerEvidenceSealed: true,
			controllerExited: false,
		});
		const preSealEvent = readRigJournal(f.journalPath).events.findLast(
			(event) => event.envelope.operationId === "offrunner-evidence-sealed",
		);
		const sealRoot = (preSealEvent?.details as { result: { sealRoot: string } })
			.result.sealRoot;
		expect(
			JSON.parse(readFileSync(join(sealRoot, "seal-receipt.json"), "utf8")),
		).toMatchObject({
			status: "INCOMPLETE",
			finalGatesComplete: false,
			evidenceCollectionComplete: false,
		});
		await backend.execute({
			context: f.context,
			action: "DESTROY",
			cleanupOnly: true,
		});
		expect(await backend.readState(f.context)).toBe("DESTROYED");
		expect(live.size).toBe(0);
		expect(
			calls
				.filter(({ args }) => args[2] === "delete")
				.map(({ command, args }) => [command, ...args]),
		).toEqual([
			["doctl", "compute", "droplet", "delete", "101", "102", "--force"],
		]);
		expect(
			calls.slice(recoveryCalls).every(({ command }) => command === "doctl"),
		).toBe(true);
		const journal = readRigJournal(f.journalPath);
		expect(
			loadRigStateFromJournal(f.journalPath).evidence.controllerExited,
		).toBe(false);
		const destruction = validateG6DestructionReceipt(
			JSON.parse(
				readFileSync(join(f.context.root, "destruction-receipt.json"), "utf8"),
			),
		);
		expect(destruction).toEqual(destructionReceiptFromFinalJournal(journal));
		expect(destruction).toMatchObject({
			deletedIds: [101, 102],
			verifiedAbsentAt: at(6001),
			runTagInventoryEmpty: true,
		});
		const ledger = validateSpendLedger(
			JSON.parse(
				readFileSync(join(f.context.root, "spend-ledger.json"), "utf8"),
			),
			{ policy: f.policy, requireSeal: true },
		);
		const seal = ledger.entries.at(-1);
		if (seal?.schema !== "g6-c32-spend-ledger-entry/2")
			throw Error("missing /2 terminal settlement");
		// 101 billed minutes, two roles at 32,490 micro-USD per minute. Actual paid
		// liability may exceed the frozen allocation without authorizing more work.
		expect(seal.totalAuthorizedMicrousd).toBe(totalAuthorizedMicrousd);
		expect(seal.settlement).toMatchObject({
			verifiedAbsentAt: at(6001),
			hourlyMicrousdByRole: { server: 1949400, generator: 1949400 },
			paidLifecycleMicrousd: 6562980,
			paidTotalMicrousd: 97913890,
			overrunMicrousd: 0,
		});
		expect(seal.remainingBudgetMicrousd).toBe(5630276);
		// This attests exact provider absence and sealed liability, not successful
		// local process cleanup; controllerExited:false above remains authoritative.
		expect(verifyTerminalEvidence(f.context.root)).toMatchObject({
			status: "TEARDOWN_VERIFIED",
			deletedIds: [101, 102],
			sealedTotalMicrousd: 97913890,
		});
		if (handle) {
			const pid = handle.pid;
			if (pid === null) throw Error("fixture lost its supervisor PID");
			expect(() => process.kill(-pid, 0)).not.toThrow();
		}
	} finally {
		bound?.mockRestore();
		if (handle) {
			handle.cancel();
			expect(
				(await within(handle.result, 1200)).ownership.cleanupComplete,
			).toBe(true);
		}
	}
}, 5000);

test("never-created /2 cleanup after deadline seals zero paid liability and replays exact empty absence", async () => {
	const f = fixture();
	f.setTime(6001);
	const calls: CommandSpec[] = [];
	const adapter = emptyInventoryAdapter(calls);
	const backend = f.backend(adapter);
	await backend.execute({
		context: f.context,
		action: "SEAL",
		cleanupOnly: true,
	});
	expect(calls).toHaveLength(0);
	expect(readFileSync(join(f.context.root, "RUN_STATUS"), "utf8")).toBe(
		"INCOMPLETE\n",
	);
	await backend.execute({
		context: f.context,
		action: "DESTROY",
		cleanupOnly: true,
	});
	expect(await backend.readState(f.context)).toBe("DESTROYED");
	expect(readFileSync(join(f.context.root, "RUN_STATUS"), "utf8")).toBe(
		"DESTROYED\n",
	);
	expect(
		calls.map(({ command, args }) => [command, ...args].join(" ")),
	).toEqual([
		"doctl account get --output json",
		"doctl projects get test-project --output json",
		"doctl projects resources list test-project --output json",
		"doctl compute droplet list --tag-name g6-managed --output json",
		"doctl compute droplet list --tag-name g6-production-clock --output json",
	]);
	const journal = readRigJournal(f.journalPath);
	expect(
		journal.events.filter(
			(event) =>
				event.kind === "CREATE_INTENT" || event.kind === "CREATE_OBSERVED",
		),
	).toHaveLength(0);
	expect(loadRigStateFromJournal(f.journalPath)).toMatchObject({
		preCreateBudgetAuthority: null,
		ownedResources: [],
		createIntent: null,
		creationAttempt: 0,
	});
	const ledger = validateSpendLedger(
		JSON.parse(readFileSync(join(f.context.root, "spend-ledger.json"), "utf8")),
		{ policy: f.policy, requireSeal: true },
	);
	expect(ledger.entries.map(({ event }) => event)).toEqual(["ABORT", "SEAL"]);
	const seal = ledger.entries.at(-1);
	expect(seal?.schema).toBe("g6-c32-spend-ledger-entry/2");
	if (seal?.schema !== "g6-c32-spend-ledger-entry/2")
		throw Error("missing /2 terminal settlement");
	expect(seal.accruedLifecycleMicrousd).toBe(0);
	expect(seal.totalAuthorizedMicrousd).toBe(f.policy.spentBeforeMicrousd);
	expect(seal.remainingBudgetMicrousd).toBe(
		f.policy.totalBudgetMicrousd - f.policy.spentBeforeMicrousd,
	);
	expect(seal.settlement).toMatchObject({
		verifiedAbsentAt: at(6001),
		hourlyMicrousdByRole: null,
		paidLifecycleMicrousd: 0,
		paidTotalMicrousd: f.policy.spentBeforeMicrousd,
		overrunMicrousd: 0,
	});
	const destruction = validateG6DestructionReceipt(
		JSON.parse(
			readFileSync(join(f.context.root, "destruction-receipt.json"), "utf8"),
		),
	);
	expect(destruction).toEqual(destructionReceiptFromFinalJournal(journal));
	expect(destruction).toMatchObject({
		deletedIds: [],
		verifiedAbsentAt: at(6001),
		runTagInventoryEmpty: true,
	});
	expect(journal.events.at(-1)?.envelope.operationId).toBe(
		"destroy-empty-inventory-verified",
	);
	const terminal = verifyTerminalEvidence(f.context.root);
	expect(terminal).toMatchObject({
		status: "TEARDOWN_VERIFIED",
		deletedIds: [],
		sealedTotalMicrousd: f.policy.spentBeforeMicrousd,
	});
	const immutablePaths = [
		"rig-state.json",
		"spend-ledger.json",
		"destruction-receipt.json",
		"terminal/artifact-manifest.json",
		"terminal/terminal-receipt.json",
		"terminal/final-spend-ledger.json",
		"terminal/spend-seal-receipt.json",
		`${terminal.preSealRoot}/artifact-manifest.json`,
		`${terminal.preSealRoot}/seal-receipt.json`,
	];
	const beforeReplay = immutablePaths.map((path) =>
		readFileSync(join(f.context.root, path)),
	);
	f.setTime(6601);
	const replay = f.backend(adapter);
	await replay.execute({
		context: f.context,
		action: "DESTROY",
		cleanupOnly: true,
	});
	expect(await replay.readState(f.context)).toBe("DESTROYED");
	expect(calls).toHaveLength(5);
	expect(
		immutablePaths.map((path) => readFileSync(join(f.context.root, path))),
	).toEqual(beforeReplay);
	expect(verifyTerminalEvidence(f.context.root)).toEqual(terminal);
}, 5000);

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(Error("local fixture timed out")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function localRecoveryGroup() {
	const leader = spawn("/bin/sh", ["-c", "sleep 8 & echo $!; wait"], {
		detached: true,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const exited = new Promise<void>((resolve, reject) => {
		leader.once("exit", () => resolve());
		leader.once("error", reject);
	});
	const pid = leader.pid;
	if (!pid) {
		await within(exited, 1000);
		throw Error("local fixture has no owned leader PID");
	}
	const stop = async () => {
		try {
			// This is only the isolated group just created by this fixture.
			process.kill(-pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
		}
		await within(exited, 1000);
	};
	try {
		let output = "";
		await within(
			new Promise<void>((resolve, reject) => {
				leader.stdout.on("data", (chunk: Buffer) => {
					output += chunk.toString("utf8");
					if (output.includes("\n")) resolve();
				});
				leader.once("error", reject);
			}),
			1000,
		);
		const descendantPid = Number(output.trim());
		expect(Number.isSafeInteger(descendantPid) && descendantPid > 1).toBe(true);
		const identity = spawnSync(
			"/bin/ps",
			["-p", String(descendantPid), "-o", "pgid="],
			{
				encoding: "utf8",
				timeout: 1000,
			},
		);
		expect(identity.status).toBe(0);
		expect(Number(identity.stdout.trim())).toBe(pid);
		return { pid, leader, exited, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}

function recoveryControllerArgs(f: ReturnType<typeof fixture>) {
	return [
		join(f.repositoryPath, "controller.sh"),
		"run",
		"--bound-root",
		join(f.context.root, "bound"),
		"--repository",
		f.repositoryPath,
		"--budget-policy",
		join(f.repositoryPath, "policy.json"),
		"--spend-ledger",
		join(f.context.root, "spend-ledger.json"),
		"--deadline",
		f.context.deadline,
	];
}

function recoveryLaunchFixture(
	f: ReturnType<typeof fixture>,
	pid: number,
	token = supervisorToken,
	initializePaidState = true,
) {
	if (initializePaidState) f.paid(true);
	f.setTime(6001);
	writeFileSync(
		join(f.context.root, "controller-launch.json"),
		canonicalJson({
			schema: "g6-c32-controller-launch/2",
			envelope: {
				recordedAt: at(0),
				sequence: 1,
				runId: f.context.runId,
				phase: "QUALIFYING",
				operationId: "controller-launch",
				clockSource: "offrunner",
			},
			pid,
			processGroupId: pid,
			supervisorToken: token,
			command: "bash",
			args: recoveryControllerArgs(f),
			cwd: f.repositoryPath,
			deadline: f.context.deadline,
			startedAt: at(0),
			startedMonotonicNs: "0",
			operationSequence: 1,
			evidenceRoot: join(f.context.root, `campaign-${f.context.runId}`),
		}),
	);
	// These tests cover recovery only, not semantic freeze verification. The
	// approved bound-path authority is the sole stub; PID/PGID and journal are real.
	return spyOn(freezeModule, "verifyBoundFreeze").mockReturnValue({
		semanticFreeze: {
			authority: {
				controller: { path: "controller.sh" },
				budgetPolicy: { path: "policy.json" },
			},
		},
	} as ReturnType<typeof freezeModule.verifyBoundFreeze>);
}

test.each([
	undefined,
	"",
	"not-a-uuid",
	supervisorToken.toUpperCase(),
])("recovery refuses a persisted /2 launch with invalid supervisor token %s before lookup", async (token) => {
	const f = fixture();
	const bound = recoveryLaunchFixture(f, 42424);
	const path = join(f.context.root, "controller-launch.json");
	const launch = JSON.parse(readFileSync(path, "utf8"));
	if (token === undefined) delete launch.supervisorToken;
	else launch.supervisorToken = token;
	writeFileSync(path, canonicalJson(launch));
	const calls: CommandSpec[] = [];
	try {
		await expect(
			f
				.backend({
					execute: async (spec) => {
						calls.push(spec);
						throw Error("unexpected process or provider lookup");
					},
				})
				.execute({
					context: f.context,
					action: "RECOVER_LIVE",
					cleanupOnly: true,
				}),
		).rejects.toThrow(/supervisor.*token/);
		expect(calls).toHaveLength(0);
		expect(
			loadRigStateFromJournal(f.journalPath).evidence.controllerExited,
		).toBe(false);
	} finally {
		bound.mockRestore();
	}
});

for (const matching of [false, true])
	test.skipIf(process.platform === "win32")(
		`real recovery ${matching ? "cleans the matching owned supervisor and proves group absence" : "refuses a different supervisor incarnation without signalling it"}`,
		async () => {
			const f = fixture();
			const ready = join(f.repositoryPath, "controller-ready");
			writeFileSync(
				join(f.repositoryPath, "controller.sh"),
				`trap '' TERM\nsleep 10 &\nprintf '%s\\n' "$!" > '${ready}'\nwait\n`,
			);
			const handle = startOwnedCommand(
				{
					operationId: "local-recovery-fixture",
					phase: "RECOVERY",
					command: "bash",
					args: recoveryControllerArgs(f),
					cwd: ".",
					env: {},
					timeoutMs: 5000,
					stdin: "ignore",
				},
				f.repositoryPath,
			);
			let bound: ReturnType<typeof recoveryLaunchFixture> | undefined;
			try {
				const until = performance.now() + 1000;
				while (!existsSync(ready) && performance.now() < until)
					await Bun.sleep(10);
				expect(existsSync(ready)).toBe(true);
				const pid = handle.pid;
				if (pid === null) throw Error("fixture has no supervisor PID");
				bound = recoveryLaunchFixture(
					f,
					pid,
					matching ? (handle.supervisorToken ?? undefined) : replacementToken,
				);
				const local = new BunCommandAdapter(f.repositoryPath);
				const calls: CommandSpec[] = [];
				const backend = f.backend({
					execute: async (spec) => {
						calls.push(spec);
						if (spec.command === "/bin/ps" || spec.command === "/bin/kill")
							return local.execute(spec);
						return {
							stdout: "",
							stderr: "fixture has no remote provider",
							status: { outcome: "FAILED", exitCode: 1, signal: null },
						};
					},
				});
				const recovered = backend.execute({
					context: f.context,
					action: "RECOVER_LIVE",
					cleanupOnly: true,
				});
				if (matching) {
					await within(recovered, 3000);
					const result = await within(handle.result, 1000);
					expect(result.ownership.cleanupComplete).toBe(true);
					expect(result.ownership.groupAbsent).toBe(true);
					expect(() => process.kill(-pid, 0)).toThrow();
					expect(
						calls
							.filter(({ command }) => command === "/bin/kill")
							.map(({ args }) => args),
					).toEqual([
						["-TERM", "--", String(-pid)],
						["-KILL", "--", String(-pid)],
					]);
					expect(
						loadRigStateFromJournal(f.journalPath).evidence.controllerExited,
					).toBe(true);
				} else {
					await expect(within(recovered, 3000)).rejects.toThrow(
						/supervisor.*incarnation|supervisor.*nonce/,
					);
					expect(calls.map(({ command }) => command)).toEqual(["/bin/ps"]);
					expect(() => process.kill(-pid, 0)).not.toThrow();
					expect(
						loadRigStateFromJournal(f.journalPath).evidence.controllerExited,
					).toBe(false);
				}
			} finally {
				bound?.mockRestore();
				handle.cancel();
				const result = await within(handle.result, 1200);
				expect(result.ownership.cleanupComplete).toBe(true);
			}
		},
		6500,
	);

test.skipIf(process.platform === "win32")(
	"recovery does not attest controller exit after a live PID lookup timeout",
	async () => {
		const f = fixture();
		const group = await localRecoveryGroup();
		let bound: ReturnType<typeof recoveryLaunchFixture> | undefined;
		try {
			bound = recoveryLaunchFixture(f, group.pid);
			const calls: CommandSpec[] = [];
			const backend = f.backend({
				execute: async (spec) => {
					calls.push(spec);
					return {
						stdout: "",
						stderr: "fixture ps timeout",
						status: {
							outcome: "TIMED_OUT",
							exitCode: null,
							signal: "SIGKILL",
						},
					};
				},
			});
			const failure = await backend
				.execute({
					context: f.context,
					action: "RECOVER_LIVE",
					cleanupOnly: true,
				})
				.then(
					() => null,
					(error: unknown) => error,
				);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.command).toBe("/bin/ps");
			expect(() => process.kill(group.pid, 0)).not.toThrow();
			expect(
				loadRigStateFromJournal(f.journalPath).evidence.controllerExited,
			).toBe(false);
			expect(failure).toBeInstanceOf(Error);
		} finally {
			bound?.mockRestore();
			await group.stop();
		}
	},
	5000,
);

test.skipIf(process.platform === "win32")(
	"recovery does not equate an absent supervisor with an absent owned process group",
	async () => {
		const f = fixture();
		const group = await localRecoveryGroup();
		let bound: ReturnType<typeof recoveryLaunchFixture> | undefined;
		try {
			bound = recoveryLaunchFixture(f, group.pid);
			group.leader.kill("SIGKILL");
			await within(group.exited, 1000);
			expect(() => process.kill(group.pid, 0)).toThrow();
			expect(() => process.kill(-group.pid, 0)).not.toThrow();
			const calls: CommandSpec[] = [];
			const backend = f.backend({
				execute: async (spec) => {
					calls.push(spec);
					return {
						stdout: "",
						stderr: "",
						status: {
							outcome: "FAILED",
							exitCode: 1,
							signal: null,
						},
					};
				},
			});
			const failure = await backend
				.execute({
					context: f.context,
					action: "RECOVER_LIVE",
					cleanupOnly: true,
				})
				.then(
					() => null,
					(error: unknown) => error,
				);
			expect(calls.every(({ command }) => command === "/bin/ps")).toBe(true);
			expect(() => process.kill(-group.pid, 0)).not.toThrow();
			expect(
				loadRigStateFromJournal(f.journalPath).evidence.controllerExited,
			).toBe(false);
			expect(failure).toBeInstanceOf(Error);
		} finally {
			bound?.mockRestore();
			await group.stop();
		}
	},
	5000,
);

test.each([
	"paid journal intent",
	"uncertain open intent",
])("expired /2 cleanup without prices rejects %s before any provider deletion", async (kind) => {
	const f = fixture();
	if (kind === "paid journal intent") f.paid();
	else {
		const state = loadRigStateFromJournal(f.journalPath);
		const { desired } = state;
		appendRigJournalEvent(
			f.journalPath,
			{
				kind: "RECOVERY",
				state: "CREATING",
				operationId: "recover-uncertain-open-intent",
				details: {
					rigState: validateRigState({
						...state,
						lifecycle: "CREATING",
						creationAttempt: 1,
						createIntent: {
							state: "OPEN",
							mutationNonce: "uncertain-create",
							runId: desired.runId,
							managementTag: desired.managementTag,
							runTag: desired.runTag,
							roles: desired.roles,
							profile: desired.profile,
							semantic: desired.semantic,
							attempt: 1,
							notBefore: at(0),
							requestSha256: "c".repeat(64),
						},
					}),
				},
			},
			{ clock: f.clock, randomId: () => "uncertain-intent" },
		);
	}
	f.setTime(6001);
	const calls: CommandSpec[] = [];
	const backend = f.backend(emptyInventoryAdapter(calls));
	await backend.execute({
		context: f.context,
		action: "SEAL",
		cleanupOnly: true,
	});
	await expect(
		backend.execute({
			context: f.context,
			action: "DESTROY",
			cleanupOnly: true,
		}),
	).rejects.toThrow(
		/emergency reconciliation lacks exact paid lifecycle authority/,
	);
	expect(calls).toHaveLength(0);
	expect(await backend.readState(f.context)).toBe("FAILED");
	expect(
		loadRigStateFromJournal(f.journalPath).preCreateBudgetAuthority,
	).toBeNull();
	const ledger = validateSpendLedger(
		JSON.parse(readFileSync(join(f.context.root, "spend-ledger.json"), "utf8")),
		{ policy: f.policy, requireSeal: false },
	);
	expect(ledger.entries.map(({ event }) => event)).toEqual(["ABORT"]);
	expect(existsSync(join(f.context.root, "destruction-receipt.json"))).toBe(
		false,
	);
	expect(
		existsSync(join(f.context.root, "terminal/artifact-manifest.json")),
	).toBe(false);
}, 5000);
