import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maximumLifecycleCost } from "./g6-c32-budget.ts";
import {
	buildCreateRequest,
	buildDeleteArgs,
	type DigitalOceanOperationRequest,
	type DigitalOceanOperationResult,
	type DigitalOceanProvider,
	destroyDigitalOceanRig,
	ensureDigitalOceanRig,
	inventoryDigitalOcean,
	isExactDropletAbsence,
	loadRigStateFromJournal,
	normalizeAccount,
	normalizeDropletInventory,
	normalizeImage,
	normalizeProject,
	normalizeProjectResourceIds,
	normalizeRegion,
	normalizeSize,
	normalizeSshKey,
	normalizeVpc,
} from "./g6-c32-digitalocean.ts";
import type { JournalClock } from "./g6-c32-rig-journal.ts";
import {
	appendRigJournalEvent,
	initializeRigJournal,
	readRigCreateIntentRecord,
	readRigJournal,
} from "./g6-c32-rig-journal.ts";
import type { DesiredRig } from "./g6-c32-rig-model.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const digest = (digit: string) => digit.repeat(64);

describe("exact droplet absence", () => {
	test("accepts doctl's JSON 404 response from stdout", () => {
		expect(
			isExactDropletAbsence(596557910, {
				stdout: JSON.stringify({
					errors: [
						{
							detail:
								'GET https://api.digitalocean.com/v2/droplets/596557910: 404 (request "request-id") The resource you were accessing could not be found.',
						},
					],
				}),
				stderr: "",
				status: { outcome: "FAILED", exitCode: 1, signal: null },
				startedAt: "2026-08-31T10:09:00.000Z",
				finishedAt: "2026-08-31T10:09:01.000Z",
				providerObservationAt: null,
				receiptPath: null,
			}),
		).toBe(true);
	});

	test("rejects another droplet id and unrelated failures", () => {
		const result: DigitalOceanOperationResult = {
			stdout: JSON.stringify({
				errors: [
					{
						detail:
							"GET https://api.digitalocean.com/v2/droplets/999: 404 The resource you were accessing could not be found.",
					},
				],
			}),
			stderr: "",
			status: { outcome: "FAILED", exitCode: 1, signal: null },
			startedAt: "2026-08-31T10:09:00.000Z",
			finishedAt: "2026-08-31T10:09:01.000Z",
			providerObservationAt: null,
			receiptPath: null,
		};
		expect(isExactDropletAbsence(596557910, result)).toBe(false);
		expect(
			isExactDropletAbsence(596557910, {
				...result,
				stdout: "",
				stderr: "authentication failed: 404 not found",
			}),
		).toBe(false);
	});
});

const desired: DesiredRig = {
	recordedAt: "2026-08-30T12:00:00.000Z",
	requestedAt: "2026-08-30T12:00:00.000Z",
	deadline: "2026-08-30T16:00:00.000Z",
	runId: "g6-c32-do-test",
	managementTag: "g6-c32-managed",
	runTag: "g6-c32-do-test",
	roles: {
		serverName: "g6-c32-do-test-server",
		generatorName: "g6-c32-do-test-generator",
	},
	profile: {
		region: "ams3",
		size: "c-32-intel",
		image: "ubuntu-24-04-x64",
		vpcUuid: "6e8547b7-b698-4e28-b4d1-8c755217106c",
		projectMode: "assign",
		projectId: "project-123",
		sshKeyId: 34466793,
		expectedVcpus: 32,
		expectedMemoryMiB: 65_536,
	},
	semantic: {
		freezeAuthoritySha256: digest("1"),
		freezeArtifactSha256: digest("2"),
		approvalAuthoritySha256: digest("3"),
		approvalArtifactSha256: digest("4"),
	},
	budget: {
		campaignId: "g6-c32-rca-fix-01",
		lifecycle: "rca-only",
		policyPath: "campaign/budget-policy.json",
		policySha256: digest("5"),
		totalBudgetMicrousd: 10_000_000,
		spentBeforeMicrousd: 0,
		priorLedgerArtifactSha256: null,
		maximumLifecycleCostMicrousd: 4_552_100,
		maximumLifecycleSeconds: 5_700,
		teardownReserveSeconds: 600,
		rolePriceCeilingMicrousd: { server: 1_300_600, generator: 1_300_600 },
	},
};

const accountFixture = JSON.stringify({
	email: "operator@example.test",
	uuid: "account-123",
	email_verified: true,
	status: "active",
	status_message: "",
	droplet_limit: 25,
	floating_ip_limit: 3,
});

const regionFixture = JSON.stringify([
	{
		slug: "ams3",
		name: "Amsterdam 3",
		available: true,
		features: ["private_networking", "backups"],
		sizes: ["c-32-intel"],
	},
]);

const sizeFixture = JSON.stringify([
	{
		slug: "c-32-intel",
		memory: 65_536,
		vcpus: 32,
		disk: 400,
		regions: ["ams3"],
		available: true,
		price_hourly: "1.3006",
	},
]);

const imageFixture = JSON.stringify([
	{
		id: 232566559,
		name: "Ubuntu 24.04 (LTS) x64",
		type: "base",
		distribution: "Ubuntu",
		slug: "ubuntu-24-04-x64",
		public: true,
		regions: ["ams3"],
		created_at: "2026-06-12T15:07:53Z",
		status: "available",
	},
]);

const vpcFixture = JSON.stringify([
	{
		id: "6e8547b7-b698-4e28-b4d1-8c755217106c",
		urn: "do:vpc:6e8547b7-b698-4e28-b4d1-8c755217106c",
		name: "default-ams3",
		ip_range: "10.110.0.0/20",
		region: "ams3",
		created_at: "2025-02-23T20:36:56Z",
		default: true,
	},
]);

const sshKeyFixture = JSON.stringify([
	{
		id: 34466793,
		name: "campaign-key",
		fingerprint: "90:f3:67:7e:4f:af:9a:79:36:a4:9a:ac:6a:60:ce:17",
		public_key: "ssh-ed25519 AAAATEST operator@example.test",
	},
]);

const projectFixture = JSON.stringify({
	id: "project-123",
	owner_uuid: "account-123",
	owner_id: 42,
	name: "G6 campaign",
	description: "temporary G6 rigs",
	purpose: "Operational / Developer tooling",
	environment: "Development",
	is_default: false,
	created_at: "2026-08-01T10:00:00Z",
	updated_at: "2026-08-29T10:00:00Z",
});

const projectResourcesFixture = JSON.stringify([
	{
		urn: "do:droplet:101",
		assigned_at: "2026-08-30T12:01:05Z",
		status: "ok",
	},
	{
		urn: "do:droplet:102",
		assigned_at: "2026-08-30T12:01:05Z",
		status: "ok",
	},
]);

function rawDroplet(
	role: "server" | "generator",
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: role === "server" ? 101 : 102,
		name:
			role === "server"
				? desired.roles.serverName
				: desired.roles.generatorName,
		memory: 65_536,
		vcpus: 32,
		disk: 400,
		region: { slug: "ams3", name: "Amsterdam 3" },
		image: { id: 232566559, slug: "ubuntu-24-04-x64" },
		size_slug: "c-32-intel",
		status: "active",
		networks: {
			v4: [
				{
					ip_address: role === "server" ? "203.0.113.10" : "203.0.113.11",
					type: "public",
				},
				{
					ip_address: role === "server" ? "10.110.0.10" : "10.110.0.11",
					type: "private",
				},
			],
		},
		tags: [desired.managementTag, desired.runTag],
		vpc_uuid: desired.profile.vpcUuid,
		created_at: "2026-08-30T12:01:00Z",
		...overrides,
	};
}

describe("G6 c32 DigitalOcean normalization", () => {
	test("normalizes actual doctl account/profile JSON shapes", () => {
		expect(normalizeAccount(accountFixture)).toEqual({
			uuid: "account-123",
			status: "active",
			dropletLimit: 25,
		});
		expect(normalizeRegion(regionFixture, desired.profile.region)).toEqual({
			slug: "ams3",
			available: true,
		});
		expect(normalizeSize(sizeFixture, desired.profile)).toEqual({
			slug: "c-32-intel",
			memoryMiB: 65_536,
			vcpus: 32,
			available: true,
			priceHourlyMicrousd: 1_300_600,
		});
		expect(normalizeImage(imageFixture, desired.profile)).toEqual({
			slug: "ubuntu-24-04-x64",
			status: "available",
		});
		expect(normalizeVpc(vpcFixture, desired.profile)).toEqual({
			uuid: desired.profile.vpcUuid,
			region: "ams3",
			isDefault: true,
		});
		expect(normalizeSshKey(sshKeyFixture, desired.profile.sshKeyId)).toEqual({
			id: 34466793,
			fingerprint: "90:f3:67:7e:4f:af:9a:79:36:a4:9a:ac:6a:60:ce:17",
		});
		expect(normalizeProject(projectFixture, desired.profile)).toEqual({
			id: "project-123",
			ownerUuid: "account-123",
		});
		expect(normalizeProjectResourceIds(projectResourcesFixture)).toEqual([
			101, 102,
		]);
	});

	test("requires an exact decimal hourly price", () => {
		const withPrice = (priceHourly: unknown) =>
			JSON.stringify([
				{
					...JSON.parse(sizeFixture)[0],
					price_hourly: priceHourly,
				},
			]);
		expect(normalizeSize(withPrice("1.3006"), desired.profile)).toMatchObject({
			priceHourlyMicrousd: 1_300_600,
		});
		expect(normalizeSize(withPrice(1.3006), desired.profile)).toMatchObject({
			priceHourlyMicrousd: 1_300_600,
		});
		for (const invalid of [
			1.1234567,
			-1.3006,
			"1e0",
			"-1.0",
			"1.1234567",
			undefined,
			"9007199254740992",
		]) {
			expect(() => normalizeSize(withPrice(invalid), desired.profile)).toThrow(
				/price/i,
			);
		}
	});

	test("joins networks, project membership, and request-bound SSH identity", () => {
		const inventory = normalizeDropletInventory(
			JSON.stringify([rawDroplet("generator"), rawDroplet("server")]),
			{
				desired,
				projectResourceIds: [101, 102],
				provenSshKeyId: desired.profile.sshKeyId,
				scope: "current-run",
			},
		);
		expect(inventory.map(({ role, id }) => [role, id])).toEqual([
			["server", 101],
			["generator", 102],
		]);
		expect(inventory[0]).toMatchObject({
			projectId: "project-123",
			sshKeyIds: [34466793],
			publicIpv4: "203.0.113.10",
			privateIpv4: "10.110.0.10",
			createdAt: "2026-08-30T12:01:00.000Z",
		});
	});

	test("rejects malformed, inactive, ambiguous, or incorrectly assigned resources", () => {
		const context = {
			desired,
			projectResourceIds: [101, 102],
			provenSshKeyId: desired.profile.sshKeyId,
			scope: "current-run" as const,
		};
		for (const raw of [
			rawDroplet("server", { id: undefined }),
			rawDroplet("server", { status: "off" }),
			rawDroplet("server", { tags: [desired.managementTag] }),
			rawDroplet("server", { vpc_uuid: "wrong-vpc" }),
			rawDroplet("server", {
				networks: { v4: [{ ip_address: "203.0.113.10", type: "public" }] },
			}),
		]) {
			expect(() =>
				normalizeDropletInventory(JSON.stringify([raw]), context),
			).toThrow();
		}
		expect(() =>
			normalizeDropletInventory(
				JSON.stringify([
					rawDroplet("server"),
					rawDroplet("server", { id: 103 }),
				]),
				{ ...context, projectResourceIds: [101, 103] },
			),
		).toThrow(/duplicate server/i);
		expect(() =>
			normalizeDropletInventory(JSON.stringify([rawDroplet("server")]), {
				...context,
				projectResourceIds: [102],
			}),
		).toThrow(/project/i);
		expect(() =>
			normalizeVpc(
				JSON.stringify([...JSON.parse(vpcFixture), ...JSON.parse(vpcFixture)]),
				desired.profile,
			),
		).toThrow(/exactly one|ambiguous/i);
	});

	test("performs complete read-only inventory with argv-only doctl requests", async () => {
		class FixtureProvider implements DigitalOceanProvider {
			readonly calls: DigitalOceanOperationRequest[] = [];

			async execute(
				request: DigitalOceanOperationRequest,
			): Promise<DigitalOceanOperationResult> {
				this.calls.push(request);
				const args = request.args.join(" ");
				let stdout: string;
				if (args.startsWith("account get ")) stdout = accountFixture;
				else if (args.startsWith("compute region list "))
					stdout = regionFixture;
				else if (args.startsWith("compute size list ")) stdout = sizeFixture;
				else if (args.startsWith("compute image list-distribution ")) {
					stdout = imageFixture;
				} else if (args.startsWith("vpcs list ")) stdout = vpcFixture;
				else if (args.startsWith("compute ssh-key get ")) {
					stdout = sshKeyFixture;
				} else if (args.startsWith("projects get ")) stdout = projectFixture;
				else if (args.startsWith("projects resources list ")) {
					stdout = projectResourcesFixture;
				} else if (args.includes(`--tag-name ${desired.managementTag}`)) {
					stdout = JSON.stringify([
						rawDroplet("server"),
						rawDroplet("generator"),
					]);
				} else if (args.includes(`--tag-name ${desired.runTag}`)) {
					stdout = JSON.stringify([
						rawDroplet("server"),
						rawDroplet("generator"),
					]);
				} else if (args.startsWith("compute droplet get 101 ")) {
					stdout = JSON.stringify([rawDroplet("server")]);
				} else if (args.startsWith("compute droplet get 102 ")) {
					stdout = JSON.stringify([rawDroplet("generator")]);
				} else throw new Error(`unexpected fixture request: ${args}`);
				return {
					stdout,
					stderr: "",
					status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
					startedAt: "2026-08-30T12:02:00.000Z",
					finishedAt: "2026-08-30T12:02:00.100Z",
					providerObservationAt: null,
					receiptPath: null,
				};
			}
		}

		const provider = new FixtureProvider();
		const inventory = await inventoryDigitalOcean({
			desired,
			provider,
			attempt: 1,
			exactIds: [101, 102],
		});
		expect(inventory.managementInventory.map(({ id }) => id)).toEqual([
			101, 102,
		]);
		expect(inventory.currentRunInventory.map(({ id }) => id)).toEqual([
			101, 102,
		]);
		expect(inventory.exactInventory.map(({ id }) => id)).toEqual([101, 102]);
		expect(provider.calls).toHaveLength(12);
		expect(provider.calls.map(({ args }) => args)).toContainEqual([
			"compute",
			"droplet",
			"list",
			"--tag-name",
			desired.managementTag,
			"--output",
			"json",
		]);
		expect(
			provider.calls.every(
				({ args }) =>
					Array.isArray(args) &&
					args.every((argument) => typeof argument === "string"),
			),
		).toBeTrue();
	});
});

describe("G6 c32 exact DigitalOcean mutations", () => {
	test("binds the two names and complete desired profile into one create request", () => {
		const request = buildCreateRequest(desired);
		expect(request).toEqual({
			schema: "g6-c32-do-create-request/1",
			names: [desired.roles.serverName, desired.roles.generatorName],
			dropletArgs: [
				"compute",
				"droplet",
				"create",
				desired.roles.serverName,
				desired.roles.generatorName,
				"--region",
				"ams3",
				"--size",
				"c-32-intel",
				"--image",
				"ubuntu-24-04-x64",
				"--ssh-keys",
				"34466793",
				"--tag-names",
				`${desired.managementTag},${desired.runTag}`,
				"--vpc-uuid",
				desired.profile.vpcUuid,
				"--project-id",
				"project-123",
				"--wait",
				"--output",
				"json",
			],
			project: {
				mode: "assign",
				projectId: "project-123",
				resourceUrnPrefix: "do:droplet:",
			},
		});
	});

	test("builds deletion argv from literal positive IDs only", () => {
		expect(buildDeleteArgs([101, 102])).toEqual([
			"compute",
			"droplet",
			"delete",
			"101",
			"102",
			"--force",
		]);
		expect(buildDeleteArgs([101])).toEqual([
			"compute",
			"droplet",
			"delete",
			"101",
			"--force",
		]);
		for (const ids of [[], [0], [-1], [101, 101], [101, 102, 103]]) {
			expect(() => buildDeleteArgs(ids)).toThrow();
		}
	});
});

type CreatePlan = "full" | "partial" | "crash-full" | "crash-drift" | "drift";

class IncrementingClock implements JournalClock {
	#milliseconds = Date.parse("2026-08-30T12:00:00.000Z");

	wallNow(): string {
		const value = new Date(this.#milliseconds).toISOString();
		this.#milliseconds += 100;
		return value;
	}
}

class FakeCloudProvider implements DigitalOceanProvider {
	readonly calls: DigitalOceanOperationRequest[] = [];
	readonly resources = new Map<number, Record<string, unknown>>();
	readonly projectExcludedIds = new Set<number>();
	readonly #plans: CreatePlan[];
	readonly #clock: JournalClock;
	readonly #intentPath: string;
	readonly #truncateCreatedAtToSecond: boolean;
	#createBase = 100;
	createSawOpenIntent = false;
	intentPrecededEveryCreation = true;
	crashAfterNextDelete = false;
	ignoreDeleteCount = 0;

	constructor(options: {
		plans: CreatePlan[];
		clock: JournalClock;
		intentPath: string;
		truncateCreatedAtToSecond?: boolean;
	}) {
		this.#plans = [...options.plans];
		this.#clock = options.clock;
		this.#intentPath = options.intentPath;
		this.#truncateCreatedAtToSecond =
			options.truncateCreatedAtToSecond ?? false;
	}

	#success(
		stdout: string,
		startedAt: string,
		finishedAt: string,
	): DigitalOceanOperationResult {
		return {
			stdout,
			stderr: "",
			status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
			startedAt,
			finishedAt,
			providerObservationAt: null,
			receiptPath: null,
		};
	}

	async execute(
		request: DigitalOceanOperationRequest,
	): Promise<DigitalOceanOperationResult> {
		this.calls.push(request);
		const startedAt = this.#clock.wallNow();
		const args = request.args;
		const joined = args.join(" ");
		let stdout: string;
		if (joined.startsWith("account get ")) stdout = accountFixture;
		else if (joined.startsWith("compute region list ")) stdout = regionFixture;
		else if (joined.startsWith("compute size list ")) stdout = sizeFixture;
		else if (joined.startsWith("compute image list-distribution ")) {
			stdout = imageFixture;
		} else if (joined.startsWith("vpcs list ")) stdout = vpcFixture;
		else if (joined.startsWith("compute ssh-key get ")) stdout = sshKeyFixture;
		else if (joined.startsWith("projects get ")) stdout = projectFixture;
		else if (joined.startsWith("projects resources list ")) {
			stdout = JSON.stringify(
				[...this.resources.keys()]
					.filter((id) => !this.projectExcludedIds.has(id))
					.map((id) => ({
						urn: `do:droplet:${id}`,
						assigned_at: "2026-08-30T12:00:00Z",
						status: "ok",
					})),
			);
		} else if (joined.startsWith("compute droplet list ")) {
			const tagIndex = args.indexOf("--tag-name");
			const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
			stdout = JSON.stringify(
				[...this.resources.values()].filter(
					(resource) =>
						Array.isArray(resource.tags) && resource.tags.includes(tag),
				),
			);
		} else if (joined.startsWith("compute droplet get ")) {
			const id = Number(args[3]);
			const resource = this.resources.get(id);
			const finishedAt = this.#clock.wallNow();
			if (!resource) {
				return {
					stdout: "",
					stderr: `Error: GET /v2/droplets/${id}: 404 not found`,
					status: { outcome: "FAILED", exitCode: 1, signal: null },
					startedAt,
					finishedAt,
					providerObservationAt: null,
					receiptPath: null,
				};
			}
			return this.#success(JSON.stringify([resource]), startedAt, finishedAt);
		} else if (joined.startsWith("compute droplet create ")) {
			const intent = readRigCreateIntentRecord(this.#intentPath);
			this.createSawOpenIntent = intent.intent.state === "OPEN";
			if (!this.createSawOpenIntent) {
				throw new Error("create executed without a durable OPEN intent");
			}
			const plan = this.#plans.shift() ?? "full";
			this.#createBase += 1;
			const serverId = this.#createBase;
			this.#createBase += 1;
			const generatorId = this.#createBase;
			const tags = [desired.managementTag, desired.runTag];
			const observedAt = this.#clock.wallNow();
			const createdAt = this.#truncateCreatedAtToSecond
				? new Date(
						Math.floor(Date.parse(observedAt) / 1_000) * 1_000,
					).toISOString()
				: observedAt;
			this.intentPrecededEveryCreation &&=
				Date.parse(intent.envelope.recordedAt) <= Date.parse(observedAt) &&
				Date.parse(String(intent.intent.notBefore)) <= Date.parse(observedAt);
			const server = rawDroplet("server", {
				id: serverId,
				tags,
				created_at: createdAt,
				...(plan === "drift" || plan === "crash-drift"
					? { size_slug: "c-16" }
					: {}),
			});
			const generator = rawDroplet("generator", {
				id: generatorId,
				tags,
				created_at: createdAt,
			});
			this.resources.set(serverId, server);
			if (plan !== "partial") this.resources.set(generatorId, generator);
			if (plan === "crash-full" || plan === "crash-drift") {
				throw new Error("simulated response loss after provider mutation");
			}
			stdout = JSON.stringify(
				plan === "partial" ? [server] : [server, generator],
			);
		} else if (joined.startsWith("compute droplet delete ")) {
			const forceIndex = args.indexOf("--force");
			if (this.ignoreDeleteCount > 0) {
				this.ignoreDeleteCount -= 1;
			} else {
				for (const value of args.slice(3, forceIndex)) {
					this.resources.delete(Number(value));
				}
			}
			if (this.crashAfterNextDelete) {
				this.crashAfterNextDelete = false;
				throw new Error("simulated response loss after provider deletion");
			}
			stdout = "";
		} else {
			throw new Error(`unexpected fake DigitalOcean call: ${joined}`);
		}
		return this.#success(stdout, startedAt, this.#clock.wallNow());
	}
}

function makeLifecycleFixture(
	plans: CreatePlan[],
	desiredAuthority: DesiredRig = desired,
	options: { truncateCreatedAtToSecond?: boolean } = {},
): {
	root: string;
	journalPath: string;
	intentPath: string;
	destructionReceiptPath: string;
	clock: IncrementingClock;
	provider: FakeCloudProvider;
} {
	const root = mkdtempSync(join(tmpdir(), "g6-c32-do-lifecycle-"));
	temporaryRoots.push(root);
	const journalPath = join(root, "rig-state.json");
	const intentPath = join(root, "create-intent.json");
	const destructionReceiptPath = join(root, "destruction-receipt.json");
	const clock = new IncrementingClock();
	initializeRigJournal(
		{
			path: journalPath,
			runId: desiredAuthority.runId,
			desiredRigAuthority: desiredAuthority,
		},
		{ clock, randomId: () => "initial-journal" },
	);
	return {
		root,
		journalPath,
		intentPath,
		destructionReceiptPath,
		clock,
		provider: new FakeCloudProvider({
			plans,
			clock,
			intentPath,
			truncateCreatedAtToSecond: options.truncateCreatedAtToSecond,
		}),
	};
}

function lifecycleInput(fixture: ReturnType<typeof makeLifecycleFixture>): {
	journalPath: string;
	intentPath: string;
	provider: DigitalOceanProvider;
	clock: JournalClock;
	randomNonce: () => string;
	randomId: () => string;
	maxAbsencePolls: number;
} {
	let serial = 0;
	return {
		journalPath: fixture.journalPath,
		intentPath: fixture.intentPath,
		provider: fixture.provider,
		clock: fixture.clock,
		randomNonce: () => `nonce-${++serial}`,
		randomId: () => `publish-${++serial}`,
		maxAbsencePolls: 3,
	};
}

describe("G6 c32 DigitalOcean lifecycle", () => {
	test("refuses an over-ceiling provider price before create", async () => {
		const restricted = structuredClone(desired);
		restricted.budget.rolePriceCeilingMicrousd.server = 1_000_000;
		const fixture = makeLifecycleFixture(["full"], restricted);
		await expect(
			ensureDigitalOceanRig(lifecycleInput(fixture)),
		).rejects.toThrow(/price.*ceiling/i);
		expect(
			fixture.provider.calls.some(({ args }) =>
				args.join(" ").startsWith("compute droplet create "),
			),
		).toBeFalse();
	});

	test("inventories after deadline but never creates in cleanup-only mode", async () => {
		const fixture = makeLifecycleFixture(["full"]);
		const expiredClock: JournalClock = {
			wallNow: () => "2026-08-30T16:00:00.000Z",
		};
		const result = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			clock: expiredClock,
			cleanupOnly: true,
		});
		expect(result.kind).toBe("FAILED");
		expect(result.state.lifecycle).toBe("FAILED");
		expect(fixture.provider.calls.length).toBeGreaterThan(0);
		expect(
			fixture.provider.calls.some(({ args }) =>
				args.join(" ").startsWith("compute droplet create "),
			),
		).toBeFalse();
	});

	test("creates exactly one pair after durably publishing its timestamped intent", async () => {
		const fixture = makeLifecycleFixture(["full"], desired, {
			truncateCreatedAtToSecond: true,
		});
		const mutationEvents: Array<{
			kind: string;
			createCalls: number;
			recordedAt: string;
		}> = [];
		const result = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			recordProviderMutation: (event) => {
				mutationEvents.push({
					kind: event.kind,
					recordedAt: event.recordedAt,
					createCalls: fixture.provider.calls.filter(({ args }) =>
						args.join(" ").startsWith("compute droplet create "),
					).length,
				});
			},
		});
		expect(result.kind).toBe("PROVISIONED");
		expect(result.state.ownedResources).toHaveLength(2);
		expect(result.state.createIntent?.state).toBe("CONSUMED");
		expect(result.state.preCreateBudgetAuthority).toMatchObject({
			priceReceipt: {
				clockSource: "provider",
				serverHourlyMicrousd: 1_300_600,
				generatorHourlyMicrousd: 1_300_600,
			},
			absenceProof: { liveProviderIds: [] },
		});
		expect(fixture.provider.createSawOpenIntent).toBeTrue();
		expect(fixture.provider.intentPrecededEveryCreation).toBeTrue();
		const creates = fixture.provider.calls.filter(({ args }) =>
			args.join(" ").startsWith("compute droplet create "),
		);
		expect(creates).toHaveLength(1);
		expect(creates[0]?.args).toEqual(buildCreateRequest(desired).dropletArgs);
		expect(
			mutationEvents.map(({ kind, createCalls }) => ({ kind, createCalls })),
		).toEqual([
			{ kind: "CREATE_INTENT", createCalls: 0 },
			{ kind: "CREATE_INTENT", createCalls: 0 },
			{ kind: "CREATE_OBSERVED", createCalls: 1 },
			{ kind: "CREATE_OBSERVED", createCalls: 1 },
		]);
		expect(
			mutationEvents.every(
				(event, index) =>
					index === 0 ||
					Date.parse(event.recordedAt) >=
						Date.parse(mutationEvents[index - 1]?.recordedAt ?? ""),
			),
		).toBeTrue();
		expect(loadRigStateFromJournal(fixture.journalPath)).toEqual(result.state);
	});

	test("recovers an exact intent-era pair after losing the create response", async () => {
		const fixture = makeLifecycleFixture(["crash-full"]);
		await expect(
			ensureDigitalOceanRig(lifecycleInput(fixture)),
		).rejects.toThrow(/response loss/i);
		const interrupted = loadRigStateFromJournal(fixture.journalPath);
		expect(interrupted.lifecycle).toBe("CREATING");
		expect(interrupted.createIntent?.state).toBe("OPEN");

		const resumed = await ensureDigitalOceanRig(lifecycleInput(fixture));
		expect(resumed.kind).toBe("PROVISIONED");
		expect(resumed.state.ownedResources.map(({ source }) => source)).toEqual([
			"RECOVERED",
			"RECOVERED",
		]);
		expect(
			fixture.provider.calls.filter(({ args }) =>
				args.join(" ").startsWith("compute droplet create "),
			),
		).toHaveLength(1);
	});

	test("stops without another mutation when intent-era inventory drifts", async () => {
		const fixture = makeLifecycleFixture(["crash-drift"]);
		await expect(
			ensureDigitalOceanRig(lifecycleInput(fixture)),
		).rejects.toThrow(/response loss/i);
		const mutationCount = fixture.provider.calls.filter(({ args }) =>
			/compute droplet (?:create|delete)/.test(args.join(" ")),
		).length;
		const resumed = await ensureDigitalOceanRig(lifecycleInput(fixture));
		expect(resumed.kind).toBe("INVENTORY_AMBIGUOUS");
		expect(resumed.state.evidence.inventoryAmbiguous).toBeTrue();
		expect(
			fixture.provider.calls.filter(({ args }) =>
				/compute droplet (?:create|delete)/.test(args.join(" ")),
			).length,
		).toBe(mutationCount);
	});

	test("rejects every intent-recovery identity boundary without cloud mutation", async () => {
		const cases = [
			"time",
			"tag",
			"name",
			"project",
			"region",
			"size",
			"image",
			"vpc",
			"role",
		] as const;
		for (const drift of cases) {
			const fixture = makeLifecycleFixture(["crash-full"]);
			await expect(
				ensureDigitalOceanRig(lifecycleInput(fixture)),
			).rejects.toThrow(/response loss/i);
			const resources = [...fixture.provider.resources.entries()].sort(
				([left], [right]) => left - right,
			);
			const server = resources[0];
			const generator = resources[1];
			if (!server || !generator) throw new Error("fake pair was not created");
			switch (drift) {
				case "time":
					server[1].created_at = "2026-08-30T11:59:00Z";
					break;
				case "tag":
					server[1].tags = [desired.managementTag];
					break;
				case "name":
					server[1].name = "unexpected-current-run-resource";
					break;
				case "project":
					fixture.provider.projectExcludedIds.add(server[0]);
					break;
				case "region":
					server[1].region = { slug: "fra1" };
					break;
				case "size":
					server[1].size_slug = "c-16";
					break;
				case "image":
					server[1].image = { slug: "ubuntu-22-04-x64" };
					break;
				case "vpc":
					server[1].vpc_uuid = "wrong-vpc";
					break;
				case "role":
					generator[1].name = desired.roles.serverName;
					break;
			}
			const before = fixture.provider.calls.filter(({ args }) =>
				/compute droplet (?:create|delete)/.test(args.join(" ")),
			).length;
			const result = await ensureDigitalOceanRig(lifecycleInput(fixture));
			expect(result.kind, drift).toBe("INVENTORY_AMBIGUOUS");
			expect(
				fixture.provider.calls.filter(({ args }) =>
					/compute droplet (?:create|delete)/.test(args.join(" ")),
				).length,
				drift,
			).toBe(before);
		}
	});

	test("deletes a journal-owned partial ID literally and performs one retry", async () => {
		const fixture = makeLifecycleFixture(["partial", "full"]);
		const result = await ensureDigitalOceanRig(lifecycleInput(fixture));
		expect(result.kind).toBe("PROVISIONED");
		expect(result.state.creationAttempt).toBe(2);
		const deletes = fixture.provider.calls.filter(({ args }) =>
			args.join(" ").startsWith("compute droplet delete "),
		);
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.args).toEqual([
			"compute",
			"droplet",
			"delete",
			"101",
			"--force",
		]);
	});

	test("deletes a journal-owned drifted pair by exact IDs before retrying", async () => {
		const fixture = makeLifecycleFixture(["drift", "full"]);
		const result = await ensureDigitalOceanRig(lifecycleInput(fixture));
		expect(result.kind).toBe("PROVISIONED");
		expect(result.state.creationAttempt).toBe(2);
		const deletes = fixture.provider.calls.filter(({ args }) =>
			args.join(" ").startsWith("compute droplet delete "),
		);
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.args).toEqual([
			"compute",
			"droplet",
			"delete",
			"101",
			"102",
			"--force",
		]);
	});

	test("replaces an exact prepared pair once after a scripted preparation failure", async () => {
		const fixture = makeLifecycleFixture(["full", "full"]);
		const first = await ensureDigitalOceanRig(lifecycleInput(fixture));
		expect(first.state.creationAttempt).toBe(1);
		const firstIds = first.state.ownedResources.map(({ id }) => id);

		const replacement = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			forceRecreate: true,
		});
		expect(replacement.kind).toBe("PROVISIONED");
		expect(replacement.state.creationAttempt).toBe(2);
		expect(replacement.state.ownedResources.map(({ id }) => id)).not.toEqual(
			firstIds,
		);
		const deletes = fixture.provider.calls.filter(({ args }) =>
			args.join(" ").startsWith("compute droplet delete "),
		);
		expect(deletes).toHaveLength(1);
		expect(deletes[0]?.args).toEqual([
			"compute",
			"droplet",
			"delete",
			...firstIds.map(String),
			"--force",
		]);
	});

	test("tears down a second partial creation and stops retrying", async () => {
		const fixture = makeLifecycleFixture(["partial", "partial"]);
		const result = await ensureDigitalOceanRig(lifecycleInput(fixture));
		expect(result.kind).toBe("FAILED");
		expect(result.state.lifecycle).toBe("FAILED");
		expect(result.state.creationAttempt).toBe(2);
		expect(result.state.ownedResources).toEqual([]);
		expect(fixture.provider.resources.size).toBe(0);
		const mutationArgs = fixture.provider.calls
			.filter(({ args }) =>
				/compute droplet (?:create|delete)/.test(args.join(" ")),
			)
			.map(({ args }) => args);
		expect(mutationArgs).toHaveLength(4);
		expect(mutationArgs[1]).toEqual([
			"compute",
			"droplet",
			"delete",
			"101",
			"--force",
		]);
		expect(mutationArgs[3]).toEqual([
			"compute",
			"droplet",
			"delete",
			"103",
			"--force",
		]);
	});

	test("verifies exact-ID teardown and seals a timestamped destruction receipt", async () => {
		const fixture = makeLifecycleFixture(["full"]);
		const provisioned = await ensureDigitalOceanRig(lifecycleInput(fixture));
		const terminalState = {
			...provisioned.state,
			lifecycle: "TERMINAL" as const,
			evidence: {
				...provisioned.state.evidence,
				offrunnerEvidenceSealed: true,
				controllerExited: true,
				cleanupDisposition: "NEVER_DISPATCHED" as const,
			},
		};
		appendRigJournalEvent(
			fixture.journalPath,
			{
				state: "TERMINAL",
				kind: "TRANSITION",
				operationId: "test-terminal",
				details: { rigState: terminalState },
			},
			{ clock: fixture.clock, randomId: () => "terminal" },
		);
		const mutationEvents: Array<{ kind: string; deleteCalls: number }> = [];
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			recordProviderMutation: (event) => {
				mutationEvents.push({
					kind: event.kind,
					deleteCalls: fixture.provider.calls.filter(({ args }) =>
						args.join(" ").startsWith("compute droplet delete "),
					).length,
				});
			},
		});
		expect(result.state.lifecycle).toBe("DESTROYED");
		expect(fixture.provider.resources.size).toBe(0);
		const deletedIds = terminalState.ownedResources.map(({ id }) => String(id));
		const deleteCall = fixture.provider.calls.find(({ args }) =>
			args.join(" ").startsWith("compute droplet delete "),
		);
		expect(deleteCall?.args).toEqual([
			"compute",
			"droplet",
			"delete",
			...deletedIds,
			"--force",
		]);
		expect(existsSync(fixture.destructionReceiptPath)).toBeTrue();
		const receipt = JSON.parse(
			readFileSync(fixture.destructionReceiptPath, "utf8"),
		) as Record<string, unknown>;
		expect(receipt.schema).toBe("g6-c32-destruction-receipt/1");
		expect(receipt.envelope).toMatchObject({
			runId: desired.runId,
			phase: "DESTROYED",
			clockSource: "offrunner",
		});
		expect(receipt.deletedIds).toEqual(
			terminalState.ownedResources.map(({ id }) => id),
		);
		expect(mutationEvents).toEqual([
			{ kind: "DESTROY_INTENT", deleteCalls: 0 },
			{ kind: "DESTROY_INTENT", deleteCalls: 0 },
			{ kind: "DESTROY_CONFIRMED", deleteCalls: 1 },
			{ kind: "DESTROY_CONFIRMED", deleteCalls: 1 },
		]);
	});

	test("seals a verified zero-to-zero lifecycle without a delete mutation", async () => {
		const fixture = makeLifecycleFixture([]);
		const stopped = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			cleanupOnly: true,
		});
		expect(stopped.state.lifecycle).toBe("FAILED");
		const destroyed = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
		});
		expect(destroyed.state.lifecycle).toBe("DESTROYED");
		expect(destroyed.receipt.deletedIds).toEqual([]);
		expect(
			fixture.provider.calls.some(({ args }) =>
				args.join(" ").startsWith("compute droplet delete "),
			),
		).toBeFalse();
	});

	test("resumes after deletion response loss without deleting any unknown ID", async () => {
		const fixture = makeLifecycleFixture(["full"]);
		const provisioned = await ensureDigitalOceanRig(lifecycleInput(fixture));
		const terminalState = {
			...provisioned.state,
			lifecycle: "TERMINAL" as const,
			evidence: {
				...provisioned.state.evidence,
				offrunnerEvidenceSealed: true,
				controllerExited: true,
				cleanupDisposition: "NEVER_DISPATCHED" as const,
			},
		};
		appendRigJournalEvent(
			fixture.journalPath,
			{
				state: "TERMINAL",
				kind: "TRANSITION",
				operationId: "test-terminal-response-loss",
				details: { rigState: terminalState },
			},
			{ clock: fixture.clock, randomId: () => "terminal-loss" },
		);
		fixture.provider.crashAfterNextDelete = true;
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
			}),
		).rejects.toThrow(/response loss/i);
		expect(loadRigStateFromJournal(fixture.journalPath).lifecycle).toBe(
			"DESTROYING",
		);
		expect(fixture.provider.resources.size).toBe(0);
		const deletesBeforeResume = fixture.provider.calls.filter(({ args }) =>
			args.join(" ").startsWith("compute droplet delete "),
		).length;
		const resumed = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
		});
		expect(resumed.state.lifecycle).toBe("DESTROYED");
		expect(
			fixture.provider.calls.filter(({ args }) =>
				args.join(" ").startsWith("compute droplet delete "),
			).length,
		).toBe(deletesBeforeResume);
	});

	test("continues emergency deletion reconciliation after the teardown reserve", async () => {
		const fixture = makeLifecycleFixture(["full"]);
		const provisioned = await ensureDigitalOceanRig(lifecycleInput(fixture));
		const terminalState = {
			...provisioned.state,
			lifecycle: "TERMINAL" as const,
			evidence: {
				...provisioned.state.evidence,
				offrunnerEvidenceSealed: true,
				controllerExited: true,
				cleanupDisposition: "NEVER_DISPATCHED" as const,
			},
		};
		appendRigJournalEvent(
			fixture.journalPath,
			{
				state: "TERMINAL",
				kind: "TRANSITION",
				operationId: "test-terminal-emergency-delete",
				details: { rigState: terminalState },
			},
			{ clock: fixture.clock, randomId: () => "terminal-emergency" },
		);
		fixture.provider.ignoreDeleteCount = 2;
		let normalWaits = 0;
		let emergencyWaits = 0;
		const emergencyAccruals: number[] = [];
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			maxAbsencePolls: 2,
			waitBetweenPolls: async () => {
				normalWaits += 1;
			},
			emergencyWaitBetweenPolls: async () => {
				emergencyWaits += 1;
			},
			recordEmergencyReconciliation: (recordedAt) => {
				emergencyAccruals.push(
					maximumLifecycleCost({
						hourlyMicrousdByRole: { server: 1_300_600, generator: 1_300_600 },
						executionSeconds: Date.parse(recordedAt) > 0 ? 660 : 0,
						teardownReserveSeconds: 0,
					}),
				);
			},
			maxEmergencyPolls: 3,
		});
		expect(result.state.lifecycle).toBe("DESTROYED");
		expect(fixture.provider.resources.size).toBe(0);
		expect(normalWaits).toBe(2);
		expect(emergencyWaits).toBe(2);
		expect(emergencyAccruals).toHaveLength(2);
		expect(emergencyAccruals).toEqual([476_888, 476_888]);
		expect(
			fixture.provider.calls.filter(({ args }) =>
				args.join(" ").startsWith("compute droplet delete "),
			).length,
		).toBe(3);
		const emergencyEvent = readRigJournal(fixture.journalPath).events.find(
			({ envelope }) =>
				envelope.operationId === "emergency-provider-delete-unresolved",
		);
		expect(emergencyEvent?.details).toMatchObject({
			cloud: {
				status: "EMERGENCY_PROVIDER_DELETE_UNRESOLVED",
				reservedPollsExhausted: 2,
			},
		});
	});

	test("retains emergency deletion state when a bounded diagnostic cannot reconcile", async () => {
		const fixture = makeLifecycleFixture(["full"]);
		const provisioned = await ensureDigitalOceanRig(lifecycleInput(fixture));
		const terminalState = {
			...provisioned.state,
			lifecycle: "TERMINAL" as const,
			evidence: {
				...provisioned.state.evidence,
				offrunnerEvidenceSealed: true,
				controllerExited: true,
				cleanupDisposition: "NEVER_DISPATCHED" as const,
			},
		};
		appendRigJournalEvent(
			fixture.journalPath,
			{
				state: "TERMINAL",
				kind: "TRANSITION",
				operationId: "test-terminal-unresolved-delete",
				details: { rigState: terminalState },
			},
			{ clock: fixture.clock, randomId: () => "terminal-unresolved" },
		);
		fixture.provider.ignoreDeleteCount = 99;
		let reserveIntervals = 0;
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
				maxAbsencePolls: 40,
				waitBetweenPolls: async () => {
					reserveIntervals += 1;
				},
				emergencyWaitBetweenPolls: async () => undefined,
				maxEmergencyPolls: 2,
			}),
		).rejects.toThrow(/EMERGENCY_PROVIDER_DELETE_UNRESOLVED/);
		expect(loadRigStateFromJournal(fixture.journalPath).lifecycle).toBe(
			"DESTROYING",
		);
		expect(fixture.provider.resources.size).toBe(2);
		expect(reserveIntervals).toBe(40);
		expect(
			readRigJournal(fixture.journalPath).events.some(
				({ envelope }) =>
					envelope.operationId === "emergency-provider-delete-unresolved",
			),
		).toBeTrue();
	});
});
