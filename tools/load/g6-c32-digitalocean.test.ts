import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
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
	PendingDropletNetworksError,
	type ProviderMutationRecord,
	RecordedDigitalOceanProvider,
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
	}, 15_000);

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
	}, 15_000);
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
		region: "ric1",
		size: "c-32-intel",
		image: "ubuntu-24-04-x64",
		vpcUuid: "02276475-d3ca-451f-9ea2-30db481509e1",
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
		slug: "ric1",
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
		regions: ["ric1"],
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
		regions: ["ric1"],
		created_at: "2026-06-12T15:07:53Z",
		status: "available",
	},
]);

const vpcFixture = JSON.stringify([
	{
		id: "02276475-d3ca-451f-9ea2-30db481509e1",
		urn: "do:vpc:02276475-d3ca-451f-9ea2-30db481509e1",
		name: "default-ric1",
		ip_range: "10.110.0.0/20",
		region: "ric1",
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
		region: { slug: "ric1", name: "Amsterdam 3" },
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
			slug: "ric1",
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
			region: "ric1",
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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);
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
				"ric1",
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
	}, 15_000);

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
	}, 15_000);
});

type CreatePlan =
	| "full"
	| "partial"
	| "pending"
	| "networks-pending"
	| "networks-pending-forever"
	| "crash-full"
	| "crash-drift"
	| "drift";

class IncrementingClock implements JournalClock {
	#milliseconds = Date.parse("2026-08-30T12:00:00.000Z");

	advance(milliseconds: number): void {
		this.#milliseconds += milliseconds;
	}

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
			const store = (resource: Record<string, unknown>) =>
				plan === "networks-pending-forever"
					? { ...resource, networks: {} }
					: resource;
			this.resources.set(serverId, store(server));
			if (plan !== "partial") this.resources.set(generatorId, store(generator));
			if (plan === "crash-full" || plan === "crash-drift") {
				throw new Error("simulated response loss after provider mutation");
			}
			const respond = (resource: Record<string, unknown>) => {
				if (plan === "pending") {
					return { ...resource, status: "new", networks: {} };
				}
				if (
					plan === "networks-pending" ||
					plan === "networks-pending-forever"
				) {
					return { ...resource, status: "active", networks: {} };
				}
				return resource;
			};
			const responseServer = respond(server);
			const responseGenerator = respond(generator);
			stdout = JSON.stringify(
				plan === "partial"
					? [responseServer]
					: [responseServer, responseGenerator],
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

describe("capacity creation authority", () => {
	for (const lifecycle of ["attribution-only", "ladder-only"] as const) {
		const authority: DesiredRig = {
			...desired,
			budget: {
				...desired.budget,
				lifecycle,
				spentBeforeMicrousd: 1,
				priorLedgerArtifactSha256: digest("6"),
			},
		};
		for (const scenario of [
			"partial",
			"drift",
			"force",
			"missing",
			"uncertain-empty",
		] as const) {
			test(`${lifecycle} never recreates after ${scenario}`, async () => {
				const initial: CreatePlan =
					scenario === "partial" || scenario === "drift"
						? scenario
						: scenario === "uncertain-empty"
							? "crash-full"
							: "full";
				const fixture = makeLifecycleFixture([initial, "full"], authority);
				const mutations: ProviderMutationRecord[] = [];
				const input = {
					...lifecycleInput(fixture),
					recordProviderMutation: async (event: ProviderMutationRecord) => {
						mutations.push(event);
					},
				};
				let result: Awaited<ReturnType<typeof ensureDigitalOceanRig>>;
				if (scenario === "uncertain-empty") {
					await expect(ensureDigitalOceanRig(input)).rejects.toThrow(
						/response loss/,
					);
					fixture.provider.resources.clear();
					result = await ensureDigitalOceanRig(input);
				} else {
					result = await ensureDigitalOceanRig(input);
					if (scenario === "force" || scenario === "missing") {
						if (scenario === "missing") fixture.provider.resources.delete(101);
						result = await ensureDigitalOceanRig({
							...input,
							forceRecreate: scenario === "force",
							cleanupOnly: false,
						});
					}
				}
				if (scenario === "missing") {
					expect(result.kind).toBe("FAILED");
					expect(result.state.evidence.inventoryAmbiguous).toBe(false);
					expect(result.state.ownedResources.map(({ id }) => id)).toEqual([
						101, 102,
					]);
					expect(
						fixture.provider.calls.filter(({ args }) =>
							args.join(" ").startsWith("compute droplet create "),
						),
					).toHaveLength(1);
					expect(
						mutations.filter(({ kind }) => kind === "CREATE_INTENT"),
					).toHaveLength(2);
					appendRigJournalEvent(
						fixture.journalPath,
						{
							state: "FAILED",
							kind: "RECOVERY",
							operationId: "missing-pair-sealed",
							details: {
								rigState: {
									...result.state,
									evidence: {
										...result.state.evidence,
										offrunnerEvidenceSealed: true,
										controllerExited: true,
										cleanupDisposition: "NEVER_DISPATCHED",
									},
								},
							},
						},
						{ clock: fixture.clock, randomId: () => "missing-pair-sealed" },
					);
					const terminal = await destroyDigitalOceanRig({
						...input,
						destructionReceiptPath: fixture.destructionReceiptPath,
						teardownCutoffAt: authority.requestedAt,
						maxEmergencyPolls: 1,
						emergencyWaitBetweenPolls: async () => undefined,
					});
					expect(terminal.receipt.deletedIds).toEqual([101, 102]);
					expect(fixture.provider.resources.size).toBe(0);
					expect(
						fixture.provider.calls
							.filter(({ args }) => args[2] === "delete")
							.map(({ args }) => args),
					).toEqual([["compute", "droplet", "delete", "102", "--force"]]);
					return;
				}
				expect(result.kind).toBe("FAILED");
				expect(result.state.creationAttempt).toBe(1);
				expect(result.state.ownedResources).toEqual([]);
				expect(fixture.provider.resources.size).toBe(0);
				expect(
					fixture.provider.calls.filter(({ args }) =>
						args.join(" ").startsWith("compute droplet create "),
					),
				).toHaveLength(1);
				expect(
					mutations.filter(({ kind }) => kind === "CREATE_INTENT"),
				).toHaveLength(2);
				expect(
					readRigJournal(fixture.journalPath).events.some(({ envelope }) =>
						/create-pair-(?:intent|before-provider)-2/.test(
							envelope.operationId,
						),
					),
				).toBeFalse();
			}, 15_000);
		}
		for (const fault of [
			"previous-ambiguity",
			"changed-survivor",
			"unknown-survivor",
			"conflicting-project",
			"successful-empty",
		] as const) {
			test(`${lifecycle} missing ENSURE preserves ${fault} refusal`, async () => {
				const fixture = makeLifecycleFixture(["full"], authority);
				const first = await ensureDigitalOceanRig(lifecycleInput(fixture));
				fixture.provider.resources.delete(101);
				if (fault === "previous-ambiguity")
					appendRigJournalEvent(
						fixture.journalPath,
						{
							state: "FAILED",
							kind: "RECOVERY",
							operationId: "prior-real-ambiguity",
							details: {
								rigState: {
									...first.state,
									lifecycle: "FAILED",
									evidence: {
										...first.state.evidence,
										inventoryAmbiguous: true,
									},
								},
							},
						},
						{ clock: fixture.clock, randomId: () => "prior-real-ambiguity" },
					);
				if (fault === "changed-survivor") {
					const survivor = fixture.provider.resources.get(102);
					if (!survivor) throw Error("missing fixture survivor");
					survivor.created_at = "2026-08-30T12:02:00.000Z";
				}
				if (fault === "unknown-survivor")
					fixture.provider.resources.set(
						999,
						rawDroplet("server", { id: 999 }),
					);
				const original = fixture.provider.execute.bind(fixture.provider);
				fixture.provider.execute = async (request) => {
					const result = await original(request);
					if (
						fault === "conflicting-project" &&
						request.args[0] === "projects" &&
						request.args[1] === "resources"
					)
						result.stdout = projectResourcesFixture;
					if (
						fault === "successful-empty" &&
						request.args[2] === "get" &&
						request.args[3] === "101"
					) {
						result.stdout = "[]";
						result.stderr = "";
						result.status = { outcome: "SUCCEEDED", exitCode: 0, signal: null };
					}
					return result;
				};
				const before = fixture.provider.calls.length;
				const result = await ensureDigitalOceanRig(lifecycleInput(fixture));
				expect(result.kind).toBe("INVENTORY_AMBIGUOUS");
				expect(result.state.evidence.inventoryAmbiguous).toBe(true);
				expect(result.state.ownedResources.map(({ id }) => id)).toEqual([
					101, 102,
				]);
				expect(
					fixture.provider.calls
						.slice(before)
						.some(({ args }) => args[2] === "create" || args[2] === "delete"),
				).toBe(false);
			});
		}
		test(`${lifecycle} recovers the exact first pair without creating`, async () => {
			const fixture = makeLifecycleFixture(["crash-full"], authority);
			await expect(
				ensureDigitalOceanRig(lifecycleInput(fixture)),
			).rejects.toThrow(/response loss/);
			const result = await ensureDigitalOceanRig(lifecycleInput(fixture));
			expect(result.kind).toBe("PROVISIONED");
			expect(result.state.creationAttempt).toBe(1);
			expect(
				fixture.provider.calls.filter(({ args }) =>
					args.join(" ").startsWith("compute droplet create "),
				),
			).toHaveLength(1);
		}, 15_000);
		test(`${lifecycle} reads historical attempt2 without granting new creation`, async () => {
			const fixture = makeLifecycleFixture(["full"], authority);
			const first = await ensureDigitalOceanRig(lifecycleInput(fixture));
			// Model a retained pre-policy snapshot, not a new authorized create.
			const historical = {
				...first.state,
				creationAttempt: 2,
				createIntent: null,
				ownedResources: first.state.ownedResources.map((owned) => ({
					...owned,
					creationAttempt: 2,
				})),
			};
			appendRigJournalEvent(
				fixture.journalPath,
				{
					state: "PROVISIONED",
					kind: "RECOVERY",
					operationId: "historical-attempt2-fixture",
					details: { rigState: historical },
				},
				{ clock: fixture.clock, randomId: () => "historical-attempt2" },
			);
			const replay = await ensureDigitalOceanRig(lifecycleInput(fixture));
			expect(replay.kind).toBe("REUSED");
			expect(replay.state.creationAttempt).toBe(2);
			expect(
				fixture.provider.calls.filter(({ args }) =>
					args.join(" ").startsWith("compute droplet create "),
				),
			).toHaveLength(1);
		}, 15_000);
	}
	for (const lifecycle of ["rca-only", "post-fix-only"] as const) {
		test(`${lifecycle} retains replacement and all paid mutation events`, async () => {
			const fixture = makeLifecycleFixture(["full", "full"], {
				...desired,
				budget: {
					...desired.budget,
					lifecycle,
					spentBeforeMicrousd: 1,
					priorLedgerArtifactSha256: digest("6"),
				},
			});
			await ensureDigitalOceanRig(lifecycleInput(fixture));
			const events: ProviderMutationRecord[] = [];
			const result = await ensureDigitalOceanRig({
				...lifecycleInput(fixture),
				forceRecreate: true,
				recordProviderMutation: (event) => {
					events.push(event);
				},
			});
			expect(result.kind).toBe("PROVISIONED");
			expect(result.state.creationAttempt).toBe(2);
			expect(events.map(({ kind }) => kind)).toEqual([
				"DESTROY_INTENT",
				"DESTROY_INTENT",
				"DESTROY_CONFIRMED",
				"DESTROY_CONFIRMED",
				"CREATE_INTENT",
				"CREATE_INTENT",
				"CREATE_OBSERVED",
				"CREATE_OBSERVED",
			]);
			// Attempt2 remains valid readable history, including exact pair reuse.
			const replay = await ensureDigitalOceanRig(lifecycleInput(fixture));
			expect(replay.kind).toBe("REUSED");
			expect(replay.state.creationAttempt).toBe(2);
			expect(
				fixture.provider.calls.filter(({ args }) =>
					args.join(" ").startsWith("compute droplet create "),
				),
			).toHaveLength(2);
		}, 15_000);
	}
});

async function fundedDestroyFixture(desiredAuthority: DesiredRig = desired) {
	const fixture = makeLifecycleFixture(["full"], desiredAuthority);
	const provisioned = await ensureDigitalOceanRig(lifecycleInput(fixture));
	appendRigJournalEvent(
		fixture.journalPath,
		{
			state: "TERMINAL",
			kind: "TRANSITION",
			operationId: "funded-test-terminal",
			details: {
				rigState: {
					...provisioned.state,
					lifecycle: "TERMINAL",
					evidence: {
						...provisioned.state.evidence,
						offrunnerEvidenceSealed: true,
						controllerExited: true,
						cleanupDisposition: "NEVER_DISPATCHED",
					},
				},
			},
		},
		{ clock: fixture.clock, randomId: () => "funded-terminal" },
	);
	return fixture;
}

async function failedControllerCleanupFixture() {
	const fixture = await fundedDestroyFixture();
	const state = loadRigStateFromJournal(fixture.journalPath);
	appendRigJournalEvent(
		fixture.journalPath,
		{
			state: "FAILED",
			kind: "RECOVERY",
			operationId: "funded-test-failed-controller-cleanup",
			details: {
				rigState: {
					...state,
					lifecycle: "FAILED",
					evidence: {
						...state.evidence,
						offrunnerEvidenceSealed: true,
						controllerExited: false,
						cleanupDisposition: "RECOVERY_UNREACHABLE",
					},
				},
				cloud: { terminal: "INCOMPLETE" },
			},
		},
		{ clock: fixture.clock, randomId: () => "funded-failed-cleanup" },
	);
	return fixture;
}

describe("absolute funded DigitalOcean teardown", () => {
	test.each([
		false,
		true,
	])("initial funded cleanup proves the whole pair absent with both missing=%s", async (bothMissing) => {
		const fixture = await failedControllerCleanupFixture();
		fixture.provider.resources.delete(101);
		if (bothMissing) fixture.provider.resources.delete(102);
		const start = fixture.provider.calls.length;
		const mutations: ProviderMutationRecord[] = [];
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: desired.requestedAt,
			maxEmergencyPolls: 1,
			emergencyWaitBetweenPolls: async () => undefined,
			recordProviderMutation: (mutation) => {
				mutations.push(mutation);
			},
		});
		const calls = fixture.provider.calls.slice(start);
		expect(
			calls.filter(({ args }) => args[2] === "delete").map(({ args }) => args),
		).toEqual(
			bothMissing ? [] : [["compute", "droplet", "delete", "102", "--force"]],
		);
		for (const id of [101, 102]) {
			expect(
				calls.filter(({ args }) => args[2] === "get" && args[3] === String(id))
					.length,
			).toBeGreaterThanOrEqual(2);
		}
		expect(
			mutations.map(({ kind, providerId }) => ({ kind, providerId })),
		).toEqual(
			bothMissing
				? []
				: [
						{ kind: "DESTROY_INTENT", providerId: 102 },
						{ kind: "DESTROY_CONFIRMED", providerId: 102 },
					],
		);
		expect(result.receipt.deletedIds).toEqual([101, 102]);
		expect(result.state.lifecycle).toBe("DESTROYED");
		const receiptBytes = readFileSync(fixture.destructionReceiptPath, "utf8");
		const replayStart = fixture.provider.calls.length;
		await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
		});
		expect(readFileSync(fixture.destructionReceiptPath, "utf8")).toBe(
			receiptBytes,
		);
		expect(fixture.provider.calls.length).toBe(replayStart);
	});

	test.each([
		"seal",
		"controller",
		"cleanup",
		"ambiguous",
		"unknown",
		"changed",
		"tag-conflict",
		"project-conflict",
		"empty-get",
		"wrong-404",
		"transient",
	] as const)("initial missing-host cleanup rejects %s without deletion", async (fault) => {
		const fixture = await failedControllerCleanupFixture();
		fixture.provider.resources.delete(101);
		const state = loadRigStateFromJournal(fixture.journalPath);
		const evidence = { ...state.evidence };
		if (fault === "seal") evidence.offrunnerEvidenceSealed = false;
		if (fault === "controller")
			evidence.cleanupDisposition = "NEVER_DISPATCHED";
		if (fault === "cleanup") evidence.cleanupDisposition = null;
		if (fault === "ambiguous") evidence.inventoryAmbiguous = true;
		appendRigJournalEvent(
			fixture.journalPath,
			{
				state: "FAILED",
				kind: "RECOVERY",
				operationId: `missing-negative-${fault}`,
				details: { rigState: { ...state, evidence } },
			},
			{ clock: fixture.clock, randomId: () => `negative-${fault}` },
		);
		if (fault === "unknown")
			fixture.provider.resources.set(999, rawDroplet("server", { id: 999 }));
		if (fault === "changed") {
			const survivor = fixture.provider.resources.get(102);
			if (!survivor) throw Error("missing survivor");
			survivor.created_at = "2026-08-30T12:02:00.000Z";
		}
		const original = fixture.provider.execute.bind(fixture.provider);
		fixture.provider.execute = async (request) => {
			const result = await original(request);
			if (
				fault === "tag-conflict" &&
				request.args[2] === "list" &&
				request.args[0] === "compute"
			)
				result.stdout = JSON.stringify([
					rawDroplet("server"),
					rawDroplet("generator"),
				]);
			if (
				fault === "project-conflict" &&
				request.args[0] === "projects" &&
				request.args[1] === "resources"
			)
				result.stdout = projectResourcesFixture;
			if (request.args[2] === "get" && request.args[3] === "101") {
				if (fault === "empty-get") {
					result.status = { outcome: "SUCCEEDED", exitCode: 0, signal: null };
					result.stdout = "[]";
					result.stderr = "";
				}
				if (fault === "wrong-404")
					result.stderr = "Error: GET /v2/droplets/999: 404 not found";
				if (fault === "transient") result.stderr = "temporary API failure";
			}
			return result;
		};
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
				teardownCutoffAt: desired.requestedAt,
				maxEmergencyPolls: 1,
				emergencyWaitBetweenPolls: async () => undefined,
			}),
		).rejects.toThrow();
		expect(
			fixture.provider.calls.some(({ args }) => args[2] === "delete"),
		).toBe(false);
		expect(existsSync(fixture.destructionReceiptPath)).toBe(false);
	});

	test.each([
		false,
		true,
	])("funded failed cleanup deletes only the owned pair without claiming controller exit, cutoff expired=%s", async (cutoffExpired) => {
		const fixture = await failedControllerCleanupFixture();
		const failedPreseal = readRigJournal(fixture.journalPath).events.at(-1);
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: cutoffExpired ? desired.requestedAt : desired.deadline,
			maxEmergencyPolls: 1,
			emergencyWaitBetweenPolls: async () => undefined,
		});
		expect(result.receipt.deletedIds).toEqual([101, 102]);
		expect(fixture.provider.resources.size).toBe(0);
		expect(
			fixture.provider.calls
				.filter(({ args }) => args[2] === "delete")
				.map(({ args }) => args),
		).toEqual([["compute", "droplet", "delete", "101", "102", "--force"]]);
		expect(result.state).toMatchObject({
			lifecycle: "DESTROYED",
			evidence: {
				controllerExited: false,
				cleanupDisposition: "CLEANUP_COMPLETE",
			},
		});
		expect(loadRigStateFromJournal(fixture.journalPath)).toEqual(result.state);
		const journal = readRigJournal(fixture.journalPath);
		expect(
			journal.events.find(
				({ envelope }) =>
					envelope.operationId === "funded-test-failed-controller-cleanup",
			),
		).toEqual(failedPreseal);
		expect(failedPreseal?.details).toMatchObject({
			cloud: { terminal: "INCOMPLETE" },
			rigState: { lifecycle: "FAILED", evidence: { controllerExited: false } },
		});
		expect(
			journal.events.some(
				({ envelope }) =>
					envelope.operationId === "emergency-provider-delete-unresolved",
			),
		).toBe(cutoffExpired);
		const callCount = fixture.provider.calls.length;
		const replay = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
		});
		expect(replay.state.evidence.controllerExited).toBe(false);
		expect(replay.receipt).toEqual(result.receipt);
		expect(fixture.provider.calls).toHaveLength(callCount);
	}, 15_000);

	test("legacy failed cleanup still refuses deletion without controller exit", async () => {
		const fixture = await failedControllerCleanupFixture();
		fixture.clock.advance(4 * 60 * 60 * 1_000);
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
			}),
		).rejects.toThrow(/controller or benchmark lock is still active/);
		expect(
			fixture.provider.calls.some(({ args }) => args[2] === "delete"),
		).toBe(false);
		expect(fixture.provider.resources.size).toBe(2);
	}, 15_000);

	test.each([
		"unknown-id",
		"account",
		"project",
		"membership",
		"management-tag",
		"run-tag",
	] as const)("funded failed cleanup rejects %s ownership drift before deletion", async (drift) => {
		const fixture = await failedControllerCleanupFixture();
		const original = fixture.provider.execute.bind(fixture.provider);
		if (drift === "unknown-id") {
			fixture.provider.resources.set(
				999,
				rawDroplet("server", {
					id: 999,
					tags: [desired.managementTag, desired.runTag],
				}),
			);
		}
		if (drift === "membership") fixture.provider.projectExcludedIds.add(101);
		if (drift === "management-tag" || drift === "run-tag") {
			const server = fixture.provider.resources.get(101);
			if (!server) throw Error("fixture lacks the owned server");
			server.tags = [
				drift === "management-tag" ? desired.runTag : desired.managementTag,
			];
		}
		fixture.provider.execute = async (request) => {
			const result = await original(request);
			if (drift === "account" && request.args[0] === "account") {
				result.stdout = JSON.stringify({
					...JSON.parse(result.stdout),
					uuid: "different-account",
				});
			}
			if (
				drift === "project" &&
				request.args[0] === "projects" &&
				request.args[1] === "get"
			) {
				result.stdout = JSON.stringify({
					...JSON.parse(result.stdout),
					id: "different-project",
				});
			}
			return result;
		};
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
				teardownCutoffAt: desired.requestedAt,
				maxEmergencyPolls: 1,
				emergencyWaitBetweenPolls: async () => undefined,
			}),
		).rejects.toThrow();
		expect(
			fixture.provider.calls.some(({ args }) => args[2] === "delete"),
		).toBe(false);
		expect(fixture.provider.resources.size).toBe(
			drift === "unknown-id" ? 3 : 2,
		);
		expect(
			loadRigStateFromJournal(fixture.journalPath).evidence.controllerExited,
		).toBe(false);
	}, 15_000);

	test.each([
		true,
		false,
	])("funded=%s teardown keeps provisioning catalogs out of the funded delete path only", async (funded) => {
		const fixture = await fundedDestroyFixture();
		const original = fixture.provider.execute.bind(fixture.provider);
		const requests: DigitalOceanOperationRequest[] = [];
		const isCatalog = (request: DigitalOceanOperationRequest) =>
			/^(?:compute (?:region list|size list|image list-distribution|ssh-key get)|vpcs list) /.test(
				request.args.join(" "),
			);
		fixture.provider.execute = async (request) => {
			requests.push(request);
			if (isCatalog(request))
				throw Error("persistent provisioning catalog outage");
			return original(request);
		};
		const cleanup = destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			...(funded ? { teardownCutoffAt: desired.requestedAt } : {}),
			maxEmergencyPolls: 1,
			emergencyWaitBetweenPolls: async () => undefined,
		});
		if (!funded) {
			await expect(cleanup).rejects.toThrow(/provisioning catalog outage/);
			expect(requests.some(isCatalog)).toBe(true);
			expect(requests.some(({ args }) => args[2] === "delete")).toBe(false);
			return;
		}
		const result = await cleanup;
		expect(result.receipt.deletedIds).toEqual([101, 102]);
		expect(fixture.provider.resources.size).toBe(0);
		expect(requests.some(isCatalog)).toBe(false);
		expect(
			requests
				.filter(({ args }) => args[2] === "delete")
				.map(({ args }) => args),
		).toEqual([["compute", "droplet", "delete", "101", "102", "--force"]]);
		for (const required of [
			"account get",
			"projects get",
			"projects resources list",
			"compute droplet get 101",
			"compute droplet get 102",
		]) {
			expect(
				requests.some(({ args }) => args.join(" ").startsWith(required)),
			).toBe(true);
		}
	}, 15_000);

	test.each([
		"account",
		"project",
		"membership",
		"run-tag",
	] as const)("funded teardown still refuses %s ownership drift before deletion", async (drift) => {
		const fixture = await fundedDestroyFixture();
		const original = fixture.provider.execute.bind(fixture.provider);
		if (drift === "membership") fixture.provider.projectExcludedIds.add(101);
		if (drift === "run-tag") {
			const server = fixture.provider.resources.get(101);
			if (!server) throw Error("fixture lacks the owned server");
			server.tags = [desired.managementTag];
		}
		fixture.provider.execute = async (request) => {
			const result = await original(request);
			if (drift === "account" && request.args[0] === "account") {
				result.stdout = JSON.stringify({
					...JSON.parse(result.stdout),
					uuid: "different-account",
				});
			}
			if (
				drift === "project" &&
				request.args[0] === "projects" &&
				request.args[1] === "get"
			) {
				result.stdout = JSON.stringify({
					...JSON.parse(result.stdout),
					owner_uuid: "different-account",
				});
			}
			return result;
		};
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
				teardownCutoffAt: desired.requestedAt,
				maxEmergencyPolls: 1,
				emergencyWaitBetweenPolls: async () => undefined,
			}),
		).rejects.toThrow();
		expect(
			fixture.provider.calls.some(({ args }) => args[2] === "delete"),
		).toBe(false);
		expect(fixture.provider.resources.size).toBe(2);
	}, 15_000);

	test.each([
		"partial",
		"empty",
	] as const)("funded %s cleanup does not consult provisioning catalogs", async (kind) => {
		const fixture = makeLifecycleFixture(["networks-pending-forever"]);
		if (kind === "partial") {
			await ensureDigitalOceanRig({
				...lifecycleInput(fixture),
				waitBetweenPolls: async () => undefined,
			});
			fixture.provider.resources.delete(102);
		} else {
			const state = loadRigStateFromJournal(fixture.journalPath);
			appendRigJournalEvent(
				fixture.journalPath,
				{
					kind: "TRANSITION",
					state: "FAILED",
					operationId: "funded-empty-test-sealed",
					details: {
						rigState: {
							...state,
							lifecycle: "FAILED",
							evidence: { ...state.evidence, offrunnerEvidenceSealed: true },
						},
					},
				},
				{ clock: fixture.clock, randomId: () => "empty-sealed" },
			);
		}
		const original = fixture.provider.execute.bind(fixture.provider);
		const calls: string[] = [];
		fixture.provider.execute = async (request) => {
			const args = request.args.join(" ");
			calls.push(args);
			if (
				!/^(?:account get|projects (?:get|resources list)|compute droplet (?:get|list|delete)) /.test(
					args,
				)
			)
				throw Error("persistent provisioning catalog outage");
			return original(request);
		};
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: desired.requestedAt,
			maxEmergencyPolls: 1,
			emergencyWaitBetweenPolls: async () => undefined,
		});
		expect(result.receipt.deletedIds).toEqual(kind === "partial" ? [101] : []);
		expect(fixture.provider.resources.size).toBe(0);
		expect(
			calls.filter((args) => args.startsWith("compute droplet delete")),
		).toEqual(kind === "partial" ? ["compute droplet delete 101 --force"] : []);
	}, 15_000);

	test("recorded provider applies a per-request timeout without extending its own cap", async () => {
		const root = mkdtempSync(join(tmpdir(), "g6-c32-do-timeout-"));
		temporaryRoots.push(root);
		const seen: number[] = [];
		const provider = new RecordedDigitalOceanProvider({
			runId: desired.runId,
			artifactDirectory: root,
			artifactPathPrefix: "provider",
			timeoutMs: 1_000,
			operationDependencies: {
				adapter: {
					async execute(spec) {
						seen.push(spec.timeoutMs);
						return {
							stdout: "[]",
							stderr: "",
							status: { outcome: "SUCCEEDED", exitCode: 0, signal: null },
						};
					},
				},
			},
		});
		for (const timeoutMs of [250, 2_000, undefined]) {
			await provider.execute({
				operationId: `timeout-${seen.length}`,
				phase: "DESTROYING",
				attempt: 1,
				args: ["account", "get"],
				timeoutMs,
			});
		}
		expect(seen).toEqual([250, 1_000, 1_000]);
	}, 15_000);

	test("slow pre-delete inventory consumes the same cutoff and marks emergency before further calls", async () => {
		const fixture = await fundedDestroyFixture();
		const cutoff = new Date(
			Date.parse(fixture.clock.wallNow()) + 10_000,
		).toISOString();
		const original = fixture.provider.execute.bind(fixture.provider);
		const calls: DigitalOceanOperationRequest[] = [];
		let emergency = false;
		fixture.provider.execute = async (request) => {
			calls.push(request);
			if (calls.length === 1) fixture.clock.advance(20_000);
			else expect(emergency).toBe(true);
			return original(request);
		};
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: cutoff,
			recordEmergencyReconciliation: () => {
				emergency = true;
			},
		});
		expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
		expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
		expect(result.receipt.deletedIds).toEqual([101, 102]);
		expect(emergency).toBe(true);
	}, 15_000);

	test("an already-expired cutoff records emergency before the first cleanup API call", async () => {
		const fixture = await fundedDestroyFixture();
		const original = fixture.provider.execute.bind(fixture.provider);
		let emergency = false;
		fixture.provider.execute = async (request) => {
			expect(emergency).toBe(true);
			expect(request.timeoutMs).toBeGreaterThan(0);
			return original(request);
		};
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: desired.requestedAt,
			recordEmergencyReconciliation: () => {
				emergency = true;
			},
		});
		expect(result.state.lifecycle).toBe("DESTROYED");
		expect(fixture.provider.resources.size).toBe(0);
	}, 15_000);

	test("caps funded waits by remaining time and ignores the old poll-count reserve", async () => {
		const fixture = await fundedDestroyFixture();
		const cutoff = new Date(
			Date.parse(fixture.clock.wallNow()) + 20_000,
		).toISOString();
		fixture.provider.ignoreDeleteCount = 1;
		const waits: number[] = [];
		let emergency = false;
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: cutoff,
			maxAbsencePolls: 1,
			waitBetweenPolls: async (maximumWaitMs) => {
				if (maximumWaitMs === undefined)
					throw Error("funded wait requires a shared cutoff cap");
				expect(maximumWaitMs).toBeGreaterThan(0);
				expect(maximumWaitMs).toBeLessThanOrEqual(15_000);
				waits.push(maximumWaitMs);
				fixture.clock.advance(maximumWaitMs);
			},
			emergencyWaitBetweenPolls: async () => undefined,
			recordEmergencyReconciliation: () => {
				emergency = true;
			},
		});
		expect(waits.length).toBeGreaterThan(0);
		expect(waits[0]).toBeLessThan(15_000);
		expect(emergency).toBe(true);
		expect(result.state.lifecycle).toBe("DESTROYED");
	}, 15_000);

	test("retries provider errors before the old absence loop and keeps request IDs unique", async () => {
		const fixture = await fundedDestroyFixture();
		const cutoff = new Date(
			Date.parse(fixture.clock.wallNow()) + 10_000,
		).toISOString();
		const original = fixture.provider.execute.bind(fixture.provider);
		const requests: DigitalOceanOperationRequest[] = [];
		let failures = 4;
		let emergency = false;
		fixture.provider.execute = async (request) => {
			requests.push(request);
			if (failures-- > 0) {
				fixture.clock.advance(4_000);
				throw new Error("temporary provider failure before deletion");
			}
			return original(request);
		};
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: cutoff,
			waitBetweenPolls: async (maximumWaitMs) => {
				if (maximumWaitMs === undefined)
					throw Error("funded wait requires a shared cutoff cap");
				fixture.clock.advance(maximumWaitMs);
			},
			emergencyWaitBetweenPolls: async () => undefined,
			recordEmergencyReconciliation: () => {
				emergency = true;
			},
			maxEmergencyPolls: 6,
		});
		expect(emergency).toBe(true);
		expect(result.state.lifecycle).toBe("DESTROYED");
		expect(new Set(requests.map(({ operationId }) => operationId)).size).toBe(
			requests.length,
		);
		expect(requests.some(({ args }) => args.includes("create"))).toBe(false);
	}, 15_000);

	test.each([
		"later",
		"omitted",
	] as const)("a %s cutoff cannot renew a replayed teardown reserve", async (replay) => {
		const fixture = await fundedDestroyFixture();
		const cutoff = desired.requestedAt;
		const original = fixture.provider.execute.bind(fixture.provider);
		fixture.provider.execute = async () => {
			throw new Error("provider unavailable");
		};
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
				teardownCutoffAt: cutoff,
				maxEmergencyPolls: 1,
				emergencyWaitBetweenPolls: async () => undefined,
			}),
		).rejects.toThrow(/EMERGENCY_PROVIDER_DELETE_UNRESOLVED/);
		let emergency = false;
		fixture.provider.execute = async (request) => {
			expect(emergency).toBe(true);
			return original(request);
		};
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			...(replay === "later" ? { teardownCutoffAt: desired.deadline } : {}),
			recordEmergencyReconciliation: () => {
				emergency = true;
			},
		});
		expect(result.receipt.deletedIds).toEqual([101, 102]);
	}, 15_000);

	test("late exact absence is published only after the emergency transition", async () => {
		const fixture = await fundedDestroyFixture();
		const cutoff = new Date(
			Date.parse(fixture.clock.wallNow()) + 60_000,
		).toISOString();
		const original = fixture.provider.execute.bind(fixture.provider);
		fixture.provider.execute = async (request) => {
			const result = await original(request);
			if (
				request.operationId.startsWith("do-delete-poll-") &&
				request.args[0] === "projects"
			) {
				fixture.clock.advance(70_000);
				result.finishedAt = fixture.clock.wallNow();
			}
			return result;
		};
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: cutoff,
		});
		const events = readRigJournal(fixture.journalPath).events;
		const emergency = events.findIndex(
			({ envelope }) =>
				envelope.operationId === "emergency-provider-delete-unresolved",
		);
		expect(emergency).toBeGreaterThanOrEqual(0);
		expect(emergency).toBeLessThan(events.length - 1);
		expect(Date.parse(result.receipt.verifiedAbsentAt)).toBeGreaterThan(
			Date.parse(cutoff),
		);
	}, 15_000);

	test("expired cleanup never deletes an unknown tagged resource", async () => {
		const fixture = await fundedDestroyFixture();
		fixture.provider.resources.set(999, {
			...fixture.provider.resources.get(101),
			id: 999,
			name: "unknown-managed",
		});
		let emergency = false;
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
				teardownCutoffAt: desired.requestedAt,
				recordEmergencyReconciliation: () => {
					emergency = true;
				},
			}),
		).rejects.toThrow();
		expect(emergency).toBe(true);
		expect(
			fixture.provider.calls.some(({ args }) => args[2] === "delete"),
		).toBe(false);
		expect(fixture.provider.resources.has(999)).toBe(true);
	}, 15_000);

	test("recovers a lost delete response using exact JSON 404 absence without another delete", async () => {
		const fixture = await fundedDestroyFixture();
		fixture.provider.crashAfterNextDelete = true;
		const original = fixture.provider.execute.bind(fixture.provider);
		fixture.provider.execute = async (request) => {
			const result = await original(request);
			if (result.status.outcome === "FAILED" && request.args[2] === "get") {
				result.stdout = JSON.stringify({
					errors: [
						{
							detail: `GET https://api.digitalocean.com/v2/droplets/${request.args[3]}: 404 (request "test") The resource you were accessing could not be found.`,
						},
					],
				});
				result.stderr = "";
			}
			return result;
		};
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: desired.requestedAt,
			emergencyWaitBetweenPolls: async () => undefined,
			maxEmergencyPolls: 3,
		});
		expect(result.receipt.deletedIds).toEqual([101, 102]);
		expect(
			fixture.provider.calls.filter(({ args }) => args[2] === "delete"),
		).toHaveLength(1);
	}, 15_000);

	test("records exhaustion while the current API call is still in flight", async () => {
		const fixture = await fundedDestroyFixture();
		const base = Date.parse(fixture.clock.wallNow());
		const started = performance.now();
		const clock = {
			wallNow: () =>
				new Date(base + Math.floor(performance.now() - started)).toISOString(),
		};
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = false;
		let emergencyDuringCall = false;
		const original = fixture.provider.execute.bind(fixture.provider);
		fixture.provider.execute = async (request) => {
			if (!entered) {
				entered = true;
				await blocked;
			}
			return original(request);
		};
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			clock,
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: new Date(base + 100).toISOString(),
			recordEmergencyReconciliation: () => {
				emergencyDuringCall = entered;
				release();
			},
		});
		expect(emergencyDuringCall).toBe(true);
		expect(result.state.lifecycle).toBe("DESTROYED");
	}, 2_000);

	test("the campaign deadline limits even a later supplied cleanup cutoff", async () => {
		const authority = { ...desired, deadline: "2026-08-30T12:02:00.000Z" };
		const fixture = await fundedDestroyFixture(authority);
		fixture.clock.advance(120_000);
		let emergency = false;
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: desired.deadline,
			recordEmergencyReconciliation: () => {
				emergency = true;
			},
		});
		const binding = readRigJournal(fixture.journalPath).events.find(
			({ envelope }) => envelope.operationId === "teardown-funded-cutoff-bound",
		);
		expect(binding?.details).toMatchObject({
			cloud: { teardownCutoffAt: authority.deadline },
		});
		expect(emergency).toBe(true);
		expect(result.state.lifecycle).toBe("DESTROYED");
	}, 15_000);

	test("failed provider status is retried without mistaking it for exact absence", async () => {
		const fixture = await fundedDestroyFixture();
		const original = fixture.provider.execute.bind(fixture.provider);
		let failures = 2;
		fixture.provider.execute = async (request) => {
			if (failures-- > 0)
				return {
					stdout: "",
					stderr: "provider unavailable",
					status: { outcome: "TIMED_OUT", exitCode: null, signal: "SIGTERM" },
					startedAt: fixture.clock.wallNow(),
					finishedAt: fixture.clock.wallNow(),
					providerObservationAt: null,
					receiptPath: null,
				};
			return original(request);
		};
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			teardownCutoffAt: desired.requestedAt,
			emergencyWaitBetweenPolls: async () => undefined,
			maxEmergencyPolls: 3,
		});
		expect(result.receipt.deletedIds).toEqual([101, 102]);
		expect(fixture.provider.resources.size).toBe(0);
	}, 15_000);

	test("malformed absolute cutoffs are refused before provider work", async () => {
		const fixture = await fundedDestroyFixture();
		const calls = fixture.provider.calls.length;
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
				teardownCutoffAt: "tomorrow",
			}),
		).rejects.toThrow(/teardownCutoffAt/);
		expect(fixture.provider.calls).toHaveLength(calls);
	}, 15_000);
});

describe("G6 c32 DigitalOcean lifecycle", () => {
	test.each([
		"full",
		"partial",
		"survivor",
		"empty",
	] as const)("recovers the final journal-to-receipt crash for %s without new provider work", async (mode) => {
		const fixture = makeLifecycleFixture(
			mode === "empty"
				? []
				: [mode === "full" ? "full" : "networks-pending-forever"],
		);
		const result = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			cleanupOnly: mode === "empty",
			waitBetweenPolls: async () => undefined,
		});
		if (mode === "full") {
			appendRigJournalEvent(
				fixture.journalPath,
				{
					state: "TERMINAL",
					kind: "TRANSITION",
					operationId: "test-ready-for-destroy",
					details: {
						rigState: {
							...result.state,
							lifecycle: "TERMINAL",
							evidence: {
								...result.state.evidence,
								offrunnerEvidenceSealed: true,
								controllerExited: true,
								cleanupDisposition: "NEVER_DISPATCHED",
							},
						},
					},
				},
				{ clock: fixture.clock, randomId: () => "terminal" },
			);
		}
		if (mode === "survivor") fixture.provider.resources.delete(101);
		// The final journal commits successfully; only receipt publication fails.
		mkdirSync(fixture.destructionReceiptPath);
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
			}),
		).rejects.toThrow();
		expect(loadRigStateFromJournal(fixture.journalPath).lifecycle).toBe(
			"DESTROYED",
		);
		const journal = readFileSync(fixture.journalPath);
		const calls = fixture.provider.calls.length;
		rmSync(fixture.destructionReceiptPath, { recursive: true });
		const replay = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
		});
		expect(replay.receipt.deletedIds).toEqual(
			mode === "empty" ? [] : mode === "survivor" ? [102] : [101, 102],
		);
		expect(fixture.provider.calls.length).toBe(calls);
		expect(readFileSync(fixture.journalPath)).toEqual(journal);
		const repeated = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
		});
		expect(repeated.receipt).toEqual(replay.receipt);
		expect(fixture.provider.calls.length).toBe(calls);
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

	test("waits for a newly created pair to become active", async () => {
		const fixture = makeLifecycleFixture(["pending"]);
		const result = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			waitBetweenPolls: async () => undefined,
		});
		expect(result.kind).toBe("PROVISIONED");
		expect(result.state.ownedResources).toHaveLength(2);
		expect(result.state.evidence.inventoryAmbiguous).toBeFalse();
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);

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
	}, 15_000);
});

describe("G6 c32 DigitalOcean networks-pending droplets", () => {
	const pendingContext = {
		desired,
		projectResourceIds: [597326265, 597326266],
		provenSshKeyId: desired.profile.sshKeyId,
		scope: "current-run" as const,
		requireExactProfile: false,
	};

	function r94Fragment(
		role: "server" | "generator",
		networks: unknown,
	): Record<string, unknown> {
		return rawDroplet(role, {
			id: role === "server" ? 597326266 : 597326265,
			name:
				role === "server"
					? desired.roles.serverName
					: desired.roles.generatorName,
			status: "active",
			networks,
		});
	}

	test("reports the r94 empty-networks response as pending, not malformed", () => {
		for (const networks of [
			{},
			{ v4: [] },
			{ v4: [{ ip_address: "10.110.0.4", type: "private" }] },
		]) {
			expect(() =>
				normalizeDropletInventory(
					JSON.stringify([r94Fragment("generator", networks)]),
					pendingContext,
				),
			).toThrow(PendingDropletNetworksError);
			expect(() =>
				normalizeDropletInventory(
					JSON.stringify([r94Fragment("generator", networks)]),
					pendingContext,
				),
			).toThrow(/networks pending/);
		}
	}, 15_000);

	test("keeps failing closed on genuinely malformed network shapes", () => {
		for (const networks of [
			"nope",
			{ v4: "nope" },
			{
				v4: [
					{ ip_address: "209.38.101.88", type: "public" },
					{ ip_address: "209.38.101.89", type: "public" },
					{ ip_address: "10.110.0.4", type: "private" },
				],
			},
			{
				v4: [{ type: "public" }, { ip_address: "10.110.0.4", type: "private" }],
			},
		]) {
			const parse = () =>
				normalizeDropletInventory(
					JSON.stringify([r94Fragment("generator", networks)]),
					pendingContext,
				);
			expect(parse).toThrow();
			expect(parse).not.toThrow(PendingDropletNetworksError);
		}
	}, 15_000);

	test("accepts the healthy r94 networks payload", () => {
		const [identity] = normalizeDropletInventory(
			JSON.stringify([
				r94Fragment("generator", {
					v4: [
						{
							ip_address: "209.38.101.88",
							netmask: "255.255.240.0",
							gateway: "209.38.96.1",
							type: "public",
						},
						{
							ip_address: "10.110.0.4",
							netmask: "255.255.240.0",
							gateway: "10.110.0.1",
							type: "private",
						},
					],
				}),
			]),
			pendingContext,
		);
		expect(identity).toMatchObject({
			id: 597326265,
			publicIpv4: "209.38.101.88",
			privateIpv4: "10.110.0.4",
		});
	}, 15_000);

	test("polls through a networks-pending create response inside the existing budget", async () => {
		const fixture = makeLifecycleFixture(["networks-pending"]);
		let waits = 0;
		const mutations: ProviderMutationRecord[] = [];
		const result = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			waitBetweenPolls: async () => {
				waits += 1;
			},
			recordProviderMutation: (event) => {
				mutations.push(event);
			},
		});
		expect(result.kind).toBe("PROVISIONED");
		expect(waits).toBeGreaterThan(0);
		expect(waits).toBeLessThanOrEqual(3);
		expect(result.state.ownedResources).toHaveLength(2);
		expect(
			mutations
				.filter(({ kind }) => kind === "CREATE_OBSERVED")
				.map(({ role, providerId }) => ({ role, providerId })),
		).toEqual([
			{ role: "server", providerId: 101 },
			{ role: "generator", providerId: 102 },
		]);
	}, 15_000);

	test("fails closed with the pending reason once the poll budget expires", async () => {
		const fixture = makeLifecycleFixture(["networks-pending-forever"]);
		let waits = 0;
		const result = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			waitBetweenPolls: async () => {
				waits += 1;
			},
		});
		expect(result.kind).toBe("INVENTORY_AMBIGUOUS");
		expect(result.state.evidence.inventoryAmbiguous).toBeTrue();
		expect(result.reasons?.join(" ")).toMatch(
			/networks\.v4 must be an array \(networks pending\)/,
		);
		expect(waits).toBe(3);
	}, 15_000);

	test("destroys droplets created before the pending poll budget expired", async () => {
		const fixture = makeLifecycleFixture(["networks-pending-forever"]);
		const created: ProviderMutationRecord[] = [];
		const ensured = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			waitBetweenPolls: async () => undefined,
			recordProviderMutation: (event) => {
				created.push(event);
			},
		});
		expect(ensured.kind).toBe("INVENTORY_AMBIGUOUS");
		expect(ensured.state.ownedResources).toHaveLength(0);
		expect(
			created
				.filter(({ kind }) => kind === "CREATE_OBSERVED")
				.map(({ role, providerId }) => ({ role, providerId })),
		).toEqual([
			{ role: "server", providerId: 101 },
			{ role: "generator", providerId: 102 },
		]);
		expect(fixture.provider.resources.size).toBe(2);

		const destroyed: ProviderMutationRecord[] = [];
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			waitBetweenPolls: async () => undefined,
			recordProviderMutation: (event) => {
				destroyed.push(event);
			},
		});
		expect(result.state.lifecycle).toBe("DESTROYED");
		expect(fixture.provider.resources.size).toBe(0);
		expect(result.receipt.deletedIds).toEqual([101, 102]);
		expect(
			destroyed.map(({ kind, role, providerId }) => ({
				kind,
				role,
				providerId,
			})),
		).toEqual([
			{ kind: "DESTROY_INTENT", role: "server", providerId: 101 },
			{ kind: "DESTROY_INTENT", role: "generator", providerId: 102 },
			{ kind: "DESTROY_CONFIRMED", role: "server", providerId: 101 },
			{ kind: "DESTROY_CONFIRMED", role: "generator", providerId: 102 },
		]);
		expect(existsSync(fixture.destructionReceiptPath)).toBeTrue();
	}, 15_000);

	test("deletes only the surviving droplet when its sibling is already gone", async () => {
		const fixture = makeLifecycleFixture(["networks-pending-forever"]);
		await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			waitBetweenPolls: async () => undefined,
		});
		fixture.provider.resources.delete(101);
		const destroyed: ProviderMutationRecord[] = [];
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			waitBetweenPolls: async () => undefined,
			recordProviderMutation: (event) => {
				destroyed.push(event);
			},
		});
		expect(result.state.lifecycle).toBe("DESTROYED");
		expect(fixture.provider.resources.size).toBe(0);
		expect(result.receipt.deletedIds).toEqual([102]);
		expect(
			fixture.provider.calls
				.map(({ args }) => args)
				.filter((args) => args[2] === "delete"),
		).toEqual([["compute", "droplet", "delete", "102", "--force"]]);
		expect(
			destroyed.map(({ kind, role, providerId }) => ({
				kind,
				role,
				providerId,
			})),
		).toEqual([
			{ kind: "DESTROY_INTENT", role: "generator", providerId: 102 },
			{ kind: "DESTROY_CONFIRMED", role: "generator", providerId: 102 },
		]);
	}, 15_000);

	test("destroys a live droplet from a single-ID journal record", async () => {
		const fixture = makeLifecycleFixture(["networks-pending-forever"]);
		const ensured = await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			waitBetweenPolls: async () => undefined,
		});
		fixture.provider.resources.delete(102);
		appendRigJournalEvent(
			fixture.journalPath,
			{
				state: ensured.state.lifecycle,
				kind: "RESULT",
				operationId: "test-single-created-record",
				details: {
					rigState: ensured.state,
					cloud: { createdResources: [{ id: 101, role: "server" }] },
				},
			},
			{ clock: fixture.clock, randomId: () => "single-created" },
		);
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
			waitBetweenPolls: async () => undefined,
		});
		expect(result.state.lifecycle).toBe("DESTROYED");
		expect(result.receipt.deletedIds).toEqual([101]);
		expect(fixture.provider.resources.size).toBe(0);
	}, 15_000);

	test("falls through to the sealed-terminal path when no created droplet survives", async () => {
		const fixture = makeLifecycleFixture(["networks-pending-forever"]);
		await ensureDigitalOceanRig({
			...lifecycleInput(fixture),
			waitBetweenPolls: async () => undefined,
		});
		fixture.provider.resources.clear();
		await expect(
			destroyDigitalOceanRig({
				...lifecycleInput(fixture),
				destructionReceiptPath: fixture.destructionReceiptPath,
				waitBetweenPolls: async () => undefined,
			}),
		).rejects.toThrow(/zero-resource destroy requires unambiguous sealed/);
		expect(existsSync(fixture.destructionReceiptPath)).toBeFalse();
	}, 15_000);

	test("destroys journal-owned droplets whose networks never populate", async () => {
		const fixture = makeLifecycleFixture(["full"]);
		const provisioned = await ensureDigitalOceanRig(lifecycleInput(fixture));
		for (const [id, resource] of fixture.provider.resources) {
			fixture.provider.resources.set(id, { ...resource, networks: {} });
		}
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
		const result = await destroyDigitalOceanRig({
			...lifecycleInput(fixture),
			destructionReceiptPath: fixture.destructionReceiptPath,
		});
		expect(result.state.lifecycle).toBe("DESTROYED");
		expect(fixture.provider.resources.size).toBe(0);
		expect(result.receipt.deletedIds).toEqual(
			terminalState.ownedResources.map(({ id }) => id) as [number, number],
		);
	}, 15_000);
});
