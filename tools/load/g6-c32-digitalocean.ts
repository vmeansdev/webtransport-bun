import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { OperationReceipt } from "./g6-c32-freeze-model.ts";
import {
	canonicalArtifactSha256,
	canonicalAuthoritySha256,
	canonicalJson,
	type RecordEnvelope,
	validateEnvelope,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import {
	type RecordOperationDependencies,
	recordOperation,
} from "./g6-c32-operation.ts";
import {
	appendRigJournalEvent,
	type JournalClock,
	readRigCreateIntentRecord,
	readRigJournal,
	writeRigCreateIntentRecord,
} from "./g6-c32-rig-journal.ts";
import type {
	CreateIntent,
	DesiredRig,
	DropletIdentity,
	OwnedResource,
	RigState,
} from "./g6-c32-rig-model.ts";
import {
	assertBeforeDeadline,
	mayDestroy,
	nextCreateAttempt,
	reconcileInventory,
	validateDesiredRig,
	validateDropletIdentity,
	validateRigState,
} from "./g6-c32-rig-model.ts";

type RigProfile = DesiredRig["profile"];

export type DigitalOceanAccount = {
	uuid: string;
	status: "active";
	dropletLimit: number;
};

export type DigitalOceanRegion = {
	slug: string;
	available: true;
};

export type DigitalOceanSize = {
	slug: string;
	memoryMiB: number;
	vcpus: number;
	available: true;
};

export type DigitalOceanImage = {
	slug: string;
	status: "available";
};

export type DigitalOceanVpc = {
	uuid: string;
	region: string;
	isDefault: boolean;
};

export type DigitalOceanSshKey = {
	id: number;
	fingerprint: string;
};

export type DigitalOceanProject = {
	id: string;
	ownerUuid: string;
};

export type NormalizeDropletContext = {
	desired: DesiredRig;
	projectResourceIds: readonly number[];
	provenSshKeyId: number;
	scope: "management" | "current-run";
	requireExactProfile?: boolean;
};

export type DigitalOceanCreateRequest = {
	schema: "g6-c32-do-create-request/1";
	names: readonly [string, string];
	dropletArgs: string[];
	project:
		| { mode: "none"; projectId: null; resourceUrnPrefix: null }
		| {
				mode: "assign";
				projectId: string;
				resourceUrnPrefix: "do:droplet:";
		  };
};

export type DigitalOceanOperationRequest = {
	operationId: string;
	phase: string;
	attempt: number;
	args: readonly string[];
};

export type DigitalOceanOperationResult = {
	stdout: string;
	stderr: string;
	status: OperationReceipt["status"];
	startedAt: string;
	finishedAt: string;
	providerObservationAt: string | null;
	receiptPath: string | null;
};

export interface DigitalOceanProvider {
	execute(
		request: DigitalOceanOperationRequest,
	): Promise<DigitalOceanOperationResult>;
}

export type RecordedDigitalOceanProviderOptions = {
	runId: string;
	artifactDirectory: string;
	artifactPathPrefix: string;
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	timeoutMs?: number;
	signal?: AbortSignal;
	startingSequence?: number;
	operationDependencies?: Partial<RecordOperationDependencies>;
};

export type DigitalOceanInventory = {
	observedAt: string;
	account: DigitalOceanAccount;
	region: DigitalOceanRegion;
	size: DigitalOceanSize;
	image: DigitalOceanImage;
	vpc: DigitalOceanVpc;
	sshKey: DigitalOceanSshKey;
	project: DigitalOceanProject | null;
	projectResourceIds: number[];
	managementInventory: DropletIdentity[];
	currentRunInventory: DropletIdentity[];
	exactInventory: DropletIdentity[];
	operations: DigitalOceanOperationResult[];
};

export type InventoryDigitalOceanInput = {
	desired: DesiredRig;
	provider: DigitalOceanProvider;
	attempt: number;
	exactIds?: readonly number[];
	allowMissingExact?: boolean;
};

export type DigitalOceanLifecycleInput = {
	journalPath: string;
	intentPath: string;
	provider: DigitalOceanProvider;
	clock: JournalClock;
	randomNonce?: () => string;
	randomId?: () => string;
	maxAbsencePolls?: number;
	waitBetweenPolls?: () => Promise<void>;
	cleanupOnly?: boolean;
	forceRecreate?: boolean;
};

export type EnsureDigitalOceanRigResult = {
	kind: "PROVISIONED" | "REUSED" | "INVENTORY_AMBIGUOUS" | "FAILED";
	state: RigState;
	reasons?: readonly string[];
};

export type DestroyDigitalOceanRigInput = DigitalOceanLifecycleInput & {
	destructionReceiptPath: string;
};

export type G6DestructionReceipt = {
	schema: "g6-c32-destruction-receipt/1";
	envelope: RecordEnvelope;
	desiredRigAuthoritySha256: string;
	finalJournalArtifactSha256: string;
	deletedIds: [] | [number, number];
	verifiedAbsentAt: string;
	runTagInventoryEmpty: true;
};

function fail(message: string): never {
	throw new Error(`g6-c32-digitalocean: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(raw: string, label: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (error) {
		fail(
			`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function providerObservation(raw: string): string | null {
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	const observations: number[] = [];
	const visit = (entry: unknown): void => {
		if (Array.isArray(entry)) {
			for (const child of entry) visit(child);
			return;
		}
		if (!isRecord(entry)) return;
		for (const [key, child] of Object.entries(entry)) {
			if (
				(key === "created_at" ||
					key === "updated_at" ||
					key === "assigned_at") &&
				typeof child === "string"
			) {
				const parsed = Date.parse(child);
				if (Number.isFinite(parsed)) observations.push(parsed);
			} else {
				visit(child);
			}
		}
	};
	visit(value);
	if (observations.length === 0) return null;
	return new Date(Math.max(...observations)).toISOString();
}

export class RecordedDigitalOceanProvider implements DigitalOceanProvider {
	readonly #options: Required<
		Pick<
			RecordedDigitalOceanProviderOptions,
			"runId" | "artifactDirectory" | "artifactPathPrefix"
		>
	> &
		Omit<
			RecordedDigitalOceanProviderOptions,
			"runId" | "artifactDirectory" | "artifactPathPrefix"
		>;
	#sequence: number;

	constructor(options: RecordedDigitalOceanProviderOptions) {
		this.#options = options;
		this.#sequence = options.startingSequence ?? 1;
	}

	async execute(
		request: DigitalOceanOperationRequest,
	): Promise<DigitalOceanOperationResult> {
		const recorded = await recordOperation(
			{
				runId: this.#options.runId,
				sequence: this.#sequence,
				attempt: request.attempt,
				artifactDirectory: this.#options.artifactDirectory,
				artifactPathPrefix: this.#options.artifactPathPrefix,
				spec: {
					operationId: request.operationId,
					phase: request.phase,
					command: "doctl",
					args: [...request.args],
					cwd: this.#options.cwd ?? ".",
					env: this.#options.env ?? {},
					timeoutMs: this.#options.timeoutMs ?? 120_000,
					stdin: "ignore",
				},
				signal: this.#options.signal,
				remoteObservationAt: (execution) =>
					providerObservation(
						typeof execution.stdout === "string"
							? execution.stdout
							: new TextDecoder().decode(execution.stdout),
					),
			},
			this.#options.operationDependencies,
		);
		this.#sequence += 1;
		const stdout = readFileSync(recorded.stdoutPath, "utf8");
		return {
			stdout,
			stderr: readFileSync(recorded.stderrPath, "utf8"),
			status: recorded.receipt.status,
			startedAt: recorded.receipt.startedAt,
			finishedAt: recorded.receipt.finishedAt,
			providerObservationAt:
				recorded.receipt.remoteTiming?.observationAt ?? null,
			receiptPath: recorded.receiptPath,
		};
	}
}

function asArray(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) fail(`${label} must be a JSON array`);
	return value;
}

function singleton(value: unknown, label: string): Record<string, unknown> {
	const candidate = Array.isArray(value)
		? value.length === 1
			? value[0]
			: fail(`${label} must contain exactly one record`)
		: value;
	if (!isRecord(candidate)) fail(`${label} must be a JSON object`);
	return candidate;
}

function stringField(
	record: Record<string, unknown>,
	key: string,
	label: string,
): string {
	const value = record[key];
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		value.includes("\n") ||
		value.includes("\r")
	) {
		fail(`${label}.${key} must be a nonempty single-line string`);
	}
	return value;
}

function positiveIntegerField(
	record: Record<string, unknown>,
	key: string,
	label: string,
): number {
	const value = record[key];
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		fail(`${label}.${key} must be a positive safe integer`);
	}
	return value as number;
}

function booleanField(
	record: Record<string, unknown>,
	key: string,
	label: string,
): boolean {
	const value = record[key];
	if (typeof value !== "boolean") fail(`${label}.${key} must be Boolean`);
	return value;
}

function recordsMatching(
	raw: string,
	label: string,
	predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
	return asArray(parseJson(raw, label), label)
		.map((value, index) => {
			if (!isRecord(value)) fail(`${label}[${index}] must be an object`);
			return value;
		})
		.filter(predicate);
}

function exactlyOne(
	values: Record<string, unknown>[],
	label: string,
): Record<string, unknown> {
	if (values.length !== 1) {
		fail(
			`${label} must resolve to exactly one provider record; got ${values.length}`,
		);
	}
	return values[0] as Record<string, unknown>;
}

export function normalizeAccount(raw: string): DigitalOceanAccount {
	const record = singleton(
		parseJson(raw, "account response"),
		"account response",
	);
	const status = stringField(record, "status", "account");
	if (status !== "active") fail(`account status must be active; got ${status}`);
	return {
		uuid: stringField(record, "uuid", "account"),
		status: "active",
		dropletLimit: positiveIntegerField(record, "droplet_limit", "account"),
	};
}

export function normalizeRegion(
	raw: string,
	expectedSlug: string,
): DigitalOceanRegion {
	const record = exactlyOne(
		recordsMatching(
			raw,
			"region response",
			(entry) => entry.slug === expectedSlug,
		),
		`region ${expectedSlug}`,
	);
	if (!booleanField(record, "available", "region")) {
		fail(`region ${expectedSlug} is not available`);
	}
	return { slug: stringField(record, "slug", "region"), available: true };
}

export function normalizeSize(
	raw: string,
	profile: RigProfile,
): DigitalOceanSize {
	const record = exactlyOne(
		recordsMatching(
			raw,
			"size response",
			(entry) => entry.slug === profile.size,
		),
		`size ${profile.size}`,
	);
	if (!booleanField(record, "available", "size")) {
		fail(`size ${profile.size} is not available`);
	}
	if (
		!Array.isArray(record.regions) ||
		!record.regions.includes(profile.region)
	) {
		fail(`size ${profile.size} is not available in ${profile.region}`);
	}
	const vcpus = positiveIntegerField(record, "vcpus", "size");
	const memoryMiB = positiveIntegerField(record, "memory", "size");
	if (
		vcpus !== profile.expectedVcpus ||
		memoryMiB !== profile.expectedMemoryMiB
	) {
		fail(`size ${profile.size} does not match expected CPU and memory`);
	}
	return { slug: profile.size, memoryMiB, vcpus, available: true };
}

export function normalizeImage(
	raw: string,
	profile: RigProfile,
): DigitalOceanImage {
	const record = exactlyOne(
		recordsMatching(
			raw,
			"image response",
			(entry) => entry.slug === profile.image,
		),
		`image ${profile.image}`,
	);
	const status = stringField(record, "status", "image");
	if (status !== "available") {
		fail(`image ${profile.image} status must be available; got ${status}`);
	}
	if (
		!Array.isArray(record.regions) ||
		!record.regions.includes(profile.region)
	) {
		fail(`image ${profile.image} is not available in ${profile.region}`);
	}
	return { slug: profile.image, status: "available" };
}

export function normalizeVpc(
	raw: string,
	profile: RigProfile,
): DigitalOceanVpc {
	const record = exactlyOne(
		recordsMatching(
			raw,
			"VPC response",
			(entry) => entry.id === profile.vpcUuid,
		),
		`VPC ${profile.vpcUuid}`,
	);
	const region = stringField(record, "region", "VPC");
	if (region !== profile.region) {
		fail(`VPC ${profile.vpcUuid} is in ${region}, not ${profile.region}`);
	}
	return {
		uuid: stringField(record, "id", "VPC"),
		region,
		isDefault: booleanField(record, "default", "VPC"),
	};
}

export function normalizeSshKey(
	raw: string,
	expectedId: number,
): DigitalOceanSshKey {
	const record = exactlyOne(
		recordsMatching(
			raw,
			"SSH-key response",
			(entry) => entry.id === expectedId,
		),
		`SSH key ${expectedId}`,
	);
	return {
		id: positiveIntegerField(record, "id", "SSH key"),
		fingerprint: stringField(record, "fingerprint", "SSH key"),
	};
}

export function normalizeProject(
	raw: string,
	profile: RigProfile,
): DigitalOceanProject | null {
	if (profile.projectMode === "none") return null;
	const record = singleton(
		parseJson(raw, "project response"),
		"project response",
	);
	const id = stringField(record, "id", "project");
	if (id !== profile.projectId) {
		fail(`project response is ${id}, not ${profile.projectId}`);
	}
	return {
		id,
		ownerUuid: stringField(record, "owner_uuid", "project"),
	};
}

export function normalizeProjectResourceIds(raw: string): number[] {
	const ids = asArray(
		parseJson(raw, "project-resource response"),
		"project-resource response",
	).map((entry, index) => {
		if (!isRecord(entry)) {
			fail(`project-resource response[${index}] must be an object`);
		}
		const status = stringField(entry, "status", `project resource[${index}]`);
		if (status !== "ok") {
			fail(`project resource[${index}] status must be ok`);
		}
		const urn = stringField(entry, "urn", `project resource[${index}]`);
		const match = /^do:droplet:([1-9]\d*)$/.exec(urn);
		if (!match) fail(`project resource[${index}] is not a Droplet URN`);
		const id = Number(match[1]);
		if (!Number.isSafeInteger(id)) {
			fail(`project resource[${index}] Droplet ID is unsafe`);
		}
		return id;
	});
	if (new Set(ids).size !== ids.length) {
		fail("project-resource response contains duplicate Droplet IDs");
	}
	return ids.sort((left, right) => left - right);
}

function nestedString(
	record: Record<string, unknown>,
	key: string,
	nestedKey: string,
	label: string,
): string {
	const value = record[key];
	if (!isRecord(value)) fail(`${label}.${key} must be an object`);
	return stringField(value, nestedKey, `${label}.${key}`);
}

function timestamp(value: unknown, label: string): string {
	if (typeof value !== "string") fail(`${label} must be a timestamp string`);
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) fail(`${label} is not a valid timestamp`);
	return new Date(milliseconds).toISOString();
}

function addresses(
	record: Record<string, unknown>,
	label: string,
): {
	publicIpv4: string;
	privateIpv4: string;
} {
	const networks = record.networks;
	if (!isRecord(networks) || !Array.isArray(networks.v4)) {
		fail(`${label}.networks.v4 must be an array`);
	}
	const ipv4 = networks.v4;
	const byType = (type: "public" | "private"): string => {
		const matches = ipv4.filter(
			(entry) => isRecord(entry) && entry.type === type,
		);
		if (matches.length !== 1) {
			fail(`${label} must have exactly one ${type} IPv4 network`);
		}
		return stringField(
			matches[0] as Record<string, unknown>,
			"ip_address",
			`${label}.${type} network`,
		);
	};
	return { publicIpv4: byType("public"), privateIpv4: byType("private") };
}

function roleForName(
	name: string,
	desired: DesiredRig,
): DropletIdentity["role"] {
	if (name === desired.roles.serverName) return "server";
	if (name === desired.roles.generatorName) return "generator";
	return null;
}

function normalizeTags(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		fail(`${label}.tags must be a nonempty array`);
	}
	const tags = value.map((tag, index) => {
		if (typeof tag !== "string" || tag.length === 0) {
			fail(`${label}.tags[${index}] must be a nonempty string`);
		}
		return tag;
	});
	if (new Set(tags).size !== tags.length) fail(`${label}.tags are duplicated`);
	return tags.sort();
}

function requireExactProfile(
	identity: DropletIdentity,
	desired: DesiredRig,
): void {
	const expected = desired.profile;
	if (
		identity.region !== expected.region ||
		identity.size !== expected.size ||
		identity.image !== expected.image ||
		identity.vpcUuid !== expected.vpcUuid ||
		identity.projectId !== expected.projectId ||
		identity.vcpus !== expected.expectedVcpus ||
		identity.memoryMiB !== expected.expectedMemoryMiB ||
		identity.sshKeyIds.length !== 1 ||
		identity.sshKeyIds[0] !== expected.sshKeyId
	) {
		fail(`Droplet ${identity.id} does not match the exact desired profile`);
	}
}

export function normalizeDropletInventory(
	raw: string,
	context: NormalizeDropletContext,
): DropletIdentity[] {
	const strictProfile =
		context.requireExactProfile ?? context.scope === "current-run";
	if (context.provenSshKeyId !== context.desired.profile.sshKeyId) {
		fail("proven SSH-key ID does not match desired rig authority");
	}
	const projectIds = new Set(context.projectResourceIds);
	if (projectIds.size !== context.projectResourceIds.length) {
		fail("project-resource IDs must be unique");
	}
	const parsed = asArray(
		parseJson(raw, "Droplet response"),
		"Droplet response",
	);
	const identities = parsed.map((entry, index) => {
		if (!isRecord(entry)) fail(`Droplet response[${index}] must be an object`);
		const label = `Droplet response[${index}]`;
		const id = positiveIntegerField(entry, "id", label);
		const name = stringField(entry, "name", label);
		const role = roleForName(name, context.desired);
		const tags = normalizeTags(entry.tags, label);
		if (!tags.includes(context.desired.managementTag)) {
			fail(`Droplet ${id} is missing the campaign management tag`);
		}
		if (
			context.scope === "current-run" &&
			!tags.includes(context.desired.runTag)
		) {
			fail(`Droplet ${id} is missing the current run tag`);
		}
		if (context.scope === "current-run" && role === null) {
			fail(`Droplet ${id} does not have an exact role name`);
		}
		const status = stringField(entry, "status", label);
		if (status !== "active") fail(`Droplet ${id} status must be active`);
		const isProjectMember = projectIds.has(id);
		if (
			strictProfile &&
			context.desired.profile.projectMode === "assign" &&
			!isProjectMember
		) {
			fail(`Droplet ${id} is not assigned to the desired project`);
		}
		if (
			strictProfile &&
			context.desired.profile.projectMode === "none" &&
			isProjectMember
		) {
			fail(`Droplet ${id} unexpectedly has explicit project assignment`);
		}
		const identity = validateDropletIdentity(
			{
				id,
				role,
				name,
				tags,
				region: nestedString(entry, "region", "slug", label),
				size: stringField(entry, "size_slug", label),
				image: nestedString(entry, "image", "slug", label),
				vpcUuid: stringField(entry, "vpc_uuid", label),
				projectId: isProjectMember ? context.desired.profile.projectId : null,
				sshKeyIds: [context.provenSshKeyId],
				vcpus: positiveIntegerField(entry, "vcpus", label),
				memoryMiB: positiveIntegerField(entry, "memory", label),
				status,
				createdAt: timestamp(entry.created_at, `${label}.created_at`),
				...addresses(entry, label),
			},
			label,
		);
		if (strictProfile) {
			requireExactProfile(identity, context.desired);
		}
		return identity;
	});
	if (new Set(identities.map(({ id }) => id)).size !== identities.length) {
		fail("Droplet response contains duplicate provider IDs");
	}
	for (const role of ["server", "generator"] as const) {
		if (identities.filter((identity) => identity.role === role).length > 1) {
			fail(`Droplet response contains duplicate ${role} role names`);
		}
	}
	return identities.sort((left, right) => {
		const rank = (role: DropletIdentity["role"]): number =>
			role === "server" ? 0 : role === "generator" ? 1 : 2;
		return rank(left.role) - rank(right.role) || left.id - right.id;
	});
}

export function buildCreateRequest(
	desiredValue: DesiredRig,
): DigitalOceanCreateRequest {
	const desired = validateDesiredRig(desiredValue);
	const project: DigitalOceanCreateRequest["project"] =
		desired.profile.projectMode === "assign"
			? {
					mode: "assign",
					projectId: desired.profile.projectId as string,
					resourceUrnPrefix: "do:droplet:",
				}
			: { mode: "none", projectId: null, resourceUrnPrefix: null };
	const projectArgs =
		desired.profile.projectMode === "assign"
			? ["--project-id", desired.profile.projectId as string]
			: [];
	return {
		schema: "g6-c32-do-create-request/1",
		names: [desired.roles.serverName, desired.roles.generatorName],
		dropletArgs: [
			"compute",
			"droplet",
			"create",
			desired.roles.serverName,
			desired.roles.generatorName,
			"--region",
			desired.profile.region,
			"--size",
			desired.profile.size,
			"--image",
			desired.profile.image,
			"--ssh-keys",
			String(desired.profile.sshKeyId),
			"--tag-names",
			`${desired.managementTag},${desired.runTag}`,
			"--vpc-uuid",
			desired.profile.vpcUuid,
			...projectArgs,
			"--wait",
			"--output",
			"json",
		],
		project,
	};
}

export function buildDeleteArgs(idsValue: readonly number[]): string[] {
	if (idsValue.length < 1 || idsValue.length > 2) {
		fail("delete requires one or two journal-owned Droplet IDs");
	}
	if (
		idsValue.some((id) => !Number.isSafeInteger(id) || id < 1) ||
		new Set(idsValue).size !== idsValue.length
	) {
		fail("delete IDs must be distinct positive safe integers");
	}
	return ["compute", "droplet", "delete", ...idsValue.map(String), "--force"];
}

async function executeRead(
	provider: DigitalOceanProvider,
	operations: DigitalOceanOperationResult[],
	request: DigitalOceanOperationRequest,
): Promise<DigitalOceanOperationResult> {
	const result = await provider.execute(request);
	validateRfc3339Millis(result.startedAt, `${request.operationId}.startedAt`);
	validateRfc3339Millis(result.finishedAt, `${request.operationId}.finishedAt`);
	if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
		fail(`${request.operationId} finished before it started`);
	}
	if (result.providerObservationAt !== null) {
		validateRfc3339Millis(
			result.providerObservationAt,
			`${request.operationId}.providerObservationAt`,
		);
	}
	operations.push(result);
	if (result.status.outcome !== "SUCCEEDED" || result.status.exitCode !== 0) {
		fail(
			`${request.operationId} failed: ${result.status.outcome} (${result.status.exitCode ?? "no exit code"})`,
		);
	}
	return result;
}

function operation(
	operationId: string,
	attempt: number,
	args: readonly string[],
): DigitalOceanOperationRequest {
	return { operationId, phase: "INVENTORY", attempt, args };
}

function mergeConsistentInventories(
	inventories: readonly DropletIdentity[][],
): DropletIdentity[] {
	const byId = new Map<number, DropletIdentity>();
	for (const inventory of inventories) {
		for (const identity of inventory) {
			const prior = byId.get(identity.id);
			if (prior && canonicalJson(prior) !== canonicalJson(identity)) {
				fail(
					`provider returned inconsistent identity for Droplet ${identity.id}`,
				);
			}
			byId.set(identity.id, identity);
		}
	}
	return [...byId.values()].sort((left, right) => left.id - right.id);
}

function validateExactIds(ids: readonly number[]): number[] {
	if (
		ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
		new Set(ids).size !== ids.length ||
		ids.length > 2
	) {
		fail("exact inventory IDs must be at most two distinct positive integers");
	}
	return [...ids];
}

export async function inventoryDigitalOcean(
	input: InventoryDigitalOceanInput,
): Promise<DigitalOceanInventory> {
	const desired = validateDesiredRig(input.desired);
	if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) {
		fail("inventory attempt must be a positive safe integer");
	}
	const operations: DigitalOceanOperationResult[] = [];
	const run = (operationId: string, args: readonly string[]) =>
		executeRead(
			input.provider,
			operations,
			operation(operationId, input.attempt, args),
		);
	const accountResult = await run("do-account-get", [
		"account",
		"get",
		"--output",
		"json",
	]);
	const regionResult = await run("do-region-list", [
		"compute",
		"region",
		"list",
		"--output",
		"json",
	]);
	const sizeResult = await run("do-size-list", [
		"compute",
		"size",
		"list",
		"--output",
		"json",
	]);
	const imageResult = await run("do-image-list", [
		"compute",
		"image",
		"list-distribution",
		"Ubuntu",
		"--public",
		"--output",
		"json",
	]);
	const vpcResult = await run("do-vpc-list", [
		"vpcs",
		"list",
		"--output",
		"json",
	]);
	const sshKeyResult = await run("do-ssh-key-get", [
		"compute",
		"ssh-key",
		"get",
		String(desired.profile.sshKeyId),
		"--output",
		"json",
	]);
	let project: DigitalOceanProject | null = null;
	let projectResourceIds: number[] = [];
	if (desired.profile.projectMode === "assign") {
		const projectId = desired.profile.projectId as string;
		const projectResult = await run("do-project-get", [
			"projects",
			"get",
			projectId,
			"--output",
			"json",
		]);
		const resourcesResult = await run("do-project-resources-list", [
			"projects",
			"resources",
			"list",
			projectId,
			"--output",
			"json",
		]);
		project = normalizeProject(projectResult.stdout, desired.profile);
		projectResourceIds = normalizeProjectResourceIds(resourcesResult.stdout);
	}
	const managementResult = await run("do-management-tag-list", [
		"compute",
		"droplet",
		"list",
		"--tag-name",
		desired.managementTag,
		"--output",
		"json",
	]);
	const currentRunResult = await run("do-current-run-tag-list", [
		"compute",
		"droplet",
		"list",
		"--tag-name",
		desired.runTag,
		"--output",
		"json",
	]);
	const context = {
		desired,
		projectResourceIds,
		provenSshKeyId: desired.profile.sshKeyId,
	} as const;
	const managementInventory = normalizeDropletInventory(
		managementResult.stdout,
		{
			...context,
			scope: "management",
			requireExactProfile: false,
		},
	);
	const currentRunInventory = normalizeDropletInventory(
		currentRunResult.stdout,
		{
			...context,
			scope: "current-run",
			requireExactProfile: false,
		},
	);
	const exactInventories: DropletIdentity[][] = [];
	for (const id of validateExactIds(input.exactIds ?? [])) {
		const request = operation(`do-droplet-get-${id}`, input.attempt, [
			"compute",
			"droplet",
			"get",
			String(id),
			"--output",
			"json",
		]);
		const exactResult = await input.provider.execute(request);
		validateOperationResult(request, exactResult);
		operations.push(exactResult);
		if (
			exactResult.status.outcome !== "SUCCEEDED" ||
			exactResult.status.exitCode !== 0
		) {
			if (
				input.allowMissingExact &&
				/404|not found/i.test(exactResult.stderr)
			) {
				continue;
			}
			fail(
				`${request.operationId} failed: ${exactResult.status.outcome} (${exactResult.status.exitCode ?? "no exit code"})`,
			);
		}
		exactInventories.push(
			normalizeDropletInventory(exactResult.stdout, {
				...context,
				scope: "current-run",
				requireExactProfile: false,
			}),
		);
	}
	const exactInventory = mergeConsistentInventories(exactInventories);
	mergeConsistentInventories([
		managementInventory,
		currentRunInventory,
		exactInventory,
	]);
	const managementIds = new Set(managementInventory.map(({ id }) => id));
	if (currentRunInventory.some(({ id }) => !managementIds.has(id))) {
		fail("current-run tag inventory is not a subset of management inventory");
	}
	const exactIds = new Set(exactInventory.map(({ id }) => id));
	if (
		(!input.allowMissingExact &&
			(input.exactIds ?? []).some((id) => !exactIds.has(id))) ||
		exactInventory.some(({ id }) => !managementIds.has(id))
	) {
		fail("exact-ID inventory does not match tagged management inventory");
	}
	const lastOperation = operations.at(-1);
	if (!lastOperation) fail("inventory did not execute any provider operation");
	const account = normalizeAccount(accountResult.stdout);
	if (project && project.ownerUuid !== account.uuid) {
		fail("desired project is owned by a different DigitalOcean account");
	}
	return {
		observedAt: lastOperation.finishedAt,
		account,
		region: normalizeRegion(regionResult.stdout, desired.profile.region),
		size: normalizeSize(sizeResult.stdout, desired.profile),
		image: normalizeImage(imageResult.stdout, desired.profile),
		vpc: normalizeVpc(vpcResult.stdout, desired.profile),
		sshKey: normalizeSshKey(sshKeyResult.stdout, desired.profile.sshKeyId),
		project,
		projectResourceIds,
		managementInventory,
		currentRunInventory,
		exactInventory,
		operations,
	};
}

function defaultRigState(desired: DesiredRig): RigState {
	return validateRigState({
		desired,
		lifecycle: "ABSENT",
		ownedResources: [],
		createIntent: null,
		creationAttempt: 0,
		evidence: {
			offrunnerEvidenceSealed: false,
			controllerExited: true,
			cleanupDisposition: "NEVER_DISPATCHED",
			inventoryAmbiguous: false,
		},
	});
}

export function loadRigStateFromJournal(path: string): RigState {
	const snapshot = readRigJournal(path);
	for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
		const details = snapshot.events[index]?.details;
		if (isRecord(details) && "rigState" in details) {
			return validateRigState(details.rigState);
		}
	}
	return defaultRigState(validateDesiredRig(snapshot.desiredRigAuthority));
}

function lifecycleDependencies(input: DigitalOceanLifecycleInput): {
	randomNonce: () => string;
	randomId: () => string;
	maxAbsencePolls: number;
	waitBetweenPolls: () => Promise<void>;
} {
	const maxAbsencePolls = input.maxAbsencePolls ?? 30;
	if (!Number.isSafeInteger(maxAbsencePolls) || maxAbsencePolls < 1) {
		fail("maxAbsencePolls must be a positive safe integer");
	}
	return {
		randomNonce: input.randomNonce ?? randomUUID,
		randomId: input.randomId ?? randomUUID,
		maxAbsencePolls,
		waitBetweenPolls:
			input.waitBetweenPolls ?? (() => Bun.sleep(2_000).then(() => undefined)),
	};
}

function operationSummary(result: DigitalOceanOperationResult): unknown {
	return {
		startedAt: result.startedAt,
		finishedAt: result.finishedAt,
		providerObservationAt: result.providerObservationAt,
		status: result.status,
		receiptPath: result.receiptPath,
	};
}

function appendState(
	input: DigitalOceanLifecycleInput,
	stateValue: RigState,
	kind: "INTENT" | "RESULT" | "TRANSITION" | "RECOVERY",
	operationId: string,
	cloud: unknown,
	randomId: () => string,
): RigState {
	const state = validateRigState(stateValue);
	appendRigJournalEvent(
		input.journalPath,
		{
			state: state.lifecycle,
			kind,
			operationId,
			details: { rigState: state, cloud },
		},
		{ clock: input.clock, randomId },
	);
	return state;
}

function validateOperationResult(
	request: DigitalOceanOperationRequest,
	result: DigitalOceanOperationResult,
): void {
	validateRfc3339Millis(result.startedAt, `${request.operationId}.startedAt`);
	validateRfc3339Millis(result.finishedAt, `${request.operationId}.finishedAt`);
	if (Date.parse(result.finishedAt) < Date.parse(result.startedAt)) {
		fail(`${request.operationId} finished before it started`);
	}
	if (result.providerObservationAt !== null) {
		validateRfc3339Millis(
			result.providerObservationAt,
			`${request.operationId}.providerObservationAt`,
		);
	}
}

async function executeMutation(
	provider: DigitalOceanProvider,
	request: DigitalOceanOperationRequest,
): Promise<DigitalOceanOperationResult> {
	const result = await provider.execute(request);
	validateOperationResult(request, result);
	if (result.status.outcome !== "SUCCEEDED" || result.status.exitCode !== 0) {
		fail(
			`${request.operationId} failed: ${result.status.outcome} (${result.status.exitCode ?? "no exit code"})`,
		);
	}
	return result;
}

function ownedResources(
	identities: readonly DropletIdentity[],
	source: OwnedResource["source"],
	attempt: 1 | 2,
	recordedAt: string,
): OwnedResource[] {
	return identities.map((identity) => {
		if (identity.role !== "server" && identity.role !== "generator") {
			fail(`Droplet ${identity.id} cannot be owned without an exact role`);
		}
		return {
			id: identity.id,
			role: identity.role,
			source,
			creationAttempt: attempt,
			recordedAt,
			recordedIdentity: identity,
		};
	});
}

function createIntent(
	state: RigState,
	attempt: 1 | 2,
	notBefore: string,
	mutationNonce: string,
	requestSha256: string,
): CreateIntent {
	return {
		state: "OPEN",
		mutationNonce,
		runId: state.desired.runId,
		managementTag: state.desired.managementTag,
		runTag: state.desired.runTag,
		roles: state.desired.roles,
		profile: state.desired.profile,
		semantic: state.desired.semantic,
		attempt,
		notBefore,
		requestSha256,
	};
}

function writeIntentState(
	input: DigitalOceanLifecycleInput,
	state: RigState,
	intent: CreateIntent,
	phase: string,
	operationId: string,
	recordedAt: string,
	randomId: () => string,
): void {
	writeRigCreateIntentRecord(
		{
			path: input.intentPath,
			runId: state.desired.runId,
			phase,
			operationId,
			desiredRigAuthority: state.desired,
			intent,
		},
		{ clock: { wallNow: () => recordedAt }, randomId },
	);
}

function idsFromRawDropletArray(raw: string, label: string): number[] {
	const values = asArray(parseJson(raw, label), label);
	const ids = values.map((value, index) => {
		if (!isRecord(value)) fail(`${label}[${index}] must be an object`);
		return positiveIntegerField(value, "id", `${label}[${index}]`);
	});
	if (new Set(ids).size !== ids.length) fail(`${label} contains duplicate IDs`);
	return ids;
}

async function verifyDeletedIdsAbsent(
	input: DigitalOceanLifecycleInput,
	state: RigState,
	ids: readonly number[],
	attempt: number,
	deps: ReturnType<typeof lifecycleDependencies>,
): Promise<string> {
	for (let poll = 1; poll <= deps.maxAbsencePolls; poll += 1) {
		let allExactAbsent = true;
		let latestFinishedAt = input.clock.wallNow();
		for (const id of ids) {
			const request: DigitalOceanOperationRequest = {
				operationId: `do-delete-poll-${poll}-get-${id}`,
				phase: "DESTROYING",
				attempt,
				args: ["compute", "droplet", "get", String(id), "--output", "json"],
			};
			const result = await input.provider.execute(request);
			validateOperationResult(request, result);
			latestFinishedAt = result.finishedAt;
			if (result.status.outcome === "SUCCEEDED") {
				allExactAbsent = false;
			} else if (!/404|not found/i.test(result.stderr)) {
				fail(`could not distinguish absence for Droplet ${id}`);
			}
		}
		const runListRequest: DigitalOceanOperationRequest = {
			operationId: `do-delete-poll-${poll}-run-tag-list`,
			phase: "DESTROYING",
			attempt,
			args: [
				"compute",
				"droplet",
				"list",
				"--tag-name",
				state.desired.runTag,
				"--output",
				"json",
			],
		};
		const runList = await executeMutation(input.provider, runListRequest);
		latestFinishedAt = runList.finishedAt;
		const runIds = idsFromRawDropletArray(
			runList.stdout,
			"run-tag absence list",
		);
		const managementRequest: DigitalOceanOperationRequest = {
			operationId: `do-delete-poll-${poll}-management-tag-list`,
			phase: "DESTROYING",
			attempt,
			args: [
				"compute",
				"droplet",
				"list",
				"--tag-name",
				state.desired.managementTag,
				"--output",
				"json",
			],
		};
		const managementList = await executeMutation(
			input.provider,
			managementRequest,
		);
		latestFinishedAt = managementList.finishedAt;
		const managementIds = new Set(
			idsFromRawDropletArray(
				managementList.stdout,
				"management-tag absence list",
			),
		);
		let projectAbsent = true;
		if (state.desired.profile.projectMode === "assign") {
			const projectId = state.desired.profile.projectId as string;
			const projectRequest: DigitalOceanOperationRequest = {
				operationId: `do-delete-poll-${poll}-project-resources`,
				phase: "DESTROYING",
				attempt,
				args: ["projects", "resources", "list", projectId, "--output", "json"],
			};
			const projectResult = await executeMutation(
				input.provider,
				projectRequest,
			);
			latestFinishedAt = projectResult.finishedAt;
			const projectIds = new Set(
				normalizeProjectResourceIds(projectResult.stdout),
			);
			projectAbsent = ids.every((id) => !projectIds.has(id));
		}
		if (
			allExactAbsent &&
			runIds.length === 0 &&
			ids.every((id) => !managementIds.has(id)) &&
			projectAbsent
		) {
			return latestFinishedAt;
		}
		if (poll < deps.maxAbsencePolls) await deps.waitBetweenPolls();
	}
	fail(`Droplet deletion was not verified after ${deps.maxAbsencePolls} polls`);
}

async function deleteOwnedAndVerify(
	input: DigitalOceanLifecycleInput,
	state: RigState,
	ids: readonly number[],
	attempt: number,
	deps: ReturnType<typeof lifecycleDependencies>,
): Promise<{ result: DigitalOceanOperationResult; verifiedAbsentAt: string }> {
	const args = buildDeleteArgs(ids);
	const result = await executeMutation(input.provider, {
		operationId: `do-delete-owned-attempt-${attempt}`,
		phase: "DESTROYING",
		attempt,
		args,
	});
	return {
		result,
		verifiedAbsentAt: await verifyDeletedIdsAbsent(
			input,
			state,
			ids,
			attempt,
			deps,
		),
	};
}

function markInventoryAmbiguous(
	input: DigitalOceanLifecycleInput,
	state: RigState,
	reasons: readonly string[],
	randomId: () => string,
): EnsureDigitalOceanRigResult {
	const failed = validateRigState({
		...state,
		lifecycle: "FAILED",
		evidence: { ...state.evidence, inventoryAmbiguous: true },
	});
	appendState(
		input,
		failed,
		"RESULT",
		"inventory-ambiguous",
		{ reasons: [...reasons] },
		randomId,
	);
	return { kind: "INVENTORY_AMBIGUOUS", state: failed, reasons };
}

function consumeIntent(
	input: DigitalOceanLifecycleInput,
	state: RigState,
	randomId: () => string,
): void {
	if (!state.createIntent) fail("cannot consume a missing create intent");
	const current = readRigCreateIntentRecord(input.intentPath);
	if (current.intent.state === "CONSUMED") return;
	const recordedAt = input.clock.wallNow();
	writeIntentState(
		input,
		state,
		{ ...state.createIntent, state: "CONSUMED" },
		"PROVISIONED",
		"consume-create-intent",
		recordedAt,
		randomId,
	);
}

function closeIntent(
	input: DigitalOceanLifecycleInput,
	state: RigState,
	randomId: () => string,
): void {
	if (!state.createIntent) return;
	if (!existsSync(input.intentPath)) {
		fail("journaled create intent record is missing during close");
	}
	const current = readRigCreateIntentRecord(input.intentPath);
	if (current.intent.state === "CLOSED") return;
	const recordedAt = input.clock.wallNow();
	writeIntentState(
		input,
		state,
		{ ...state.createIntent, state: "CLOSED" },
		"DESTROYING",
		"close-create-intent",
		recordedAt,
		randomId,
	);
}

function provisionedState(
	state: RigState,
	owned: readonly OwnedResource[],
): RigState {
	if (!state.createIntent) fail("provisioning requires a create intent");
	return validateRigState({
		...state,
		lifecycle: "PROVISIONED",
		ownedResources: [...owned],
		createIntent: { ...state.createIntent, state: "CONSUMED" },
		evidence: {
			...state.evidence,
			offrunnerEvidenceSealed: true,
			inventoryAmbiguous: false,
		},
	});
}

export async function ensureDigitalOceanRig(
	input: DigitalOceanLifecycleInput,
): Promise<EnsureDigitalOceanRigResult> {
	const deps = lifecycleDependencies(input);
	let state = loadRigStateFromJournal(input.journalPath);
	let forceRecreate = input.forceRecreate === true;
	for (;;) {
		// Read-only reconciliation and exact-owned cleanup must remain available
		// after the campaign deadline. The create mutation is deadline-gated below.
		let inventory: DigitalOceanInventory;
		try {
			inventory = await inventoryDigitalOcean({
				desired: state.desired,
				provider: input.provider,
				attempt: Math.max(1, state.creationAttempt),
				exactIds: state.ownedResources.map(({ id }) => id),
			});
		} catch (error) {
			return markInventoryAmbiguous(
				input,
				state,
				[error instanceof Error ? error.message : String(error)],
				deps.randomId,
			);
		}
		let decision = reconcileInventory(state, inventory.managementInventory);
		if (forceRecreate && decision.kind === "REUSE_PAIR") {
			decision = { kind: "DELETE_OWNED_AND_RETRY", ids: decision.ids };
			forceRecreate = false;
		}
		if (decision.kind === "INVENTORY_AMBIGUOUS") {
			return markInventoryAmbiguous(
				input,
				state,
				decision.reasons,
				deps.randomId,
			);
		}
		if (decision.kind === "REUSE_PAIR") {
			if (state.lifecycle === "PROVISIONED") {
				if (state.createIntent?.state === "CONSUMED") {
					consumeIntent(input, state, deps.randomId);
				}
				return { kind: "REUSED", state };
			}
			const promoted = provisionedState(state, state.ownedResources);
			appendState(
				input,
				promoted,
				"RECOVERY",
				"recover-provisioned-pair",
				{ ids: decision.ids, inventoryObservedAt: inventory.observedAt },
				deps.randomId,
			);
			consumeIntent(input, promoted, deps.randomId);
			return { kind: "PROVISIONED", state: promoted };
		}
		if (decision.kind === "RECOVER_INTENT") {
			if (!state.createIntent) fail("intent recovery requires an OPEN intent");
			const recovered = ownedResources(
				decision.resources,
				"RECOVERED",
				state.createIntent.attempt,
				input.clock.wallNow(),
			);
			state = validateRigState({
				...state,
				lifecycle: "CREATING",
				ownedResources: recovered,
				evidence: {
					...state.evidence,
					offrunnerEvidenceSealed: true,
				},
			});
			appendState(
				input,
				state,
				"RECOVERY",
				"recover-create-intent-resources",
				{
					ids: recovered.map(({ id }) => id),
					inventoryObservedAt: inventory.observedAt,
				},
				deps.randomId,
			);
			if (recovered.length === 2) {
				const promoted = provisionedState(state, recovered);
				appendState(
					input,
					promoted,
					"RECOVERY",
					"recover-complete-pair",
					{ ids: recovered.map(({ id }) => id) },
					deps.randomId,
				);
				consumeIntent(input, promoted, deps.randomId);
				return { kind: "PROVISIONED", state: promoted };
			}
			continue;
		}
		if (decision.kind === "DELETE_OWNED_AND_RETRY") {
			appendState(
				input,
				state,
				"INTENT",
				"delete-owned-before-retry",
				{ ids: [...decision.ids], inventoryObservedAt: inventory.observedAt },
				deps.randomId,
			);
			const deletion = await deleteOwnedAndVerify(
				input,
				state,
				decision.ids,
				Math.max(1, state.creationAttempt),
				deps,
			);
			closeIntent(input, state, deps.randomId);
			const exhausted =
				state.creationAttempt >= 2 || input.cleanupOnly === true;
			state = validateRigState({
				...state,
				lifecycle: exhausted ? "FAILED" : "CREATING",
				ownedResources: [],
				createIntent: null,
				evidence: {
					...state.evidence,
					offrunnerEvidenceSealed: true,
					cleanupDisposition: input.cleanupOnly
						? "RECOVERY_CLEAN"
						: "CLEANUP_COMPLETE",
				},
			});
			appendState(
				input,
				state,
				"RESULT",
				exhausted ? "creation-retry-exhausted" : "creation-retry-clean",
				{
					deletedIds: [...decision.ids],
					delete: operationSummary(deletion.result),
					verifiedAbsentAt: deletion.verifiedAbsentAt,
				},
				deps.randomId,
			);
			if (exhausted) return { kind: "FAILED", state };
			continue;
		}
		if (decision.kind === "DESTROY_TERMINAL") {
			return markInventoryAmbiguous(
				input,
				state,
				["ensure cannot reuse a terminal pair; invoke destroy"],
				deps.randomId,
			);
		}
		if (input.cleanupOnly) {
			closeIntent(input, state, deps.randomId);
			state = validateRigState({
				...state,
				lifecycle: "FAILED",
				createIntent: null,
				evidence: {
					...state.evidence,
					offrunnerEvidenceSealed: true,
					controllerExited: true,
					cleanupDisposition: "RECOVERY_CLEAN",
					inventoryAmbiguous: false,
				},
			});
			appendState(
				input,
				state,
				"RECOVERY",
				"cleanup-only-empty-inventory",
				{ inventoryObservedAt: inventory.observedAt },
				deps.randomId,
			);
			return { kind: "FAILED", state };
		}
		const attempt = nextCreateAttempt(state.creationAttempt);
		const request = buildCreateRequest(state.desired);
		const notBefore = assertBeforeDeadline(
			state.desired,
			input.clock.wallNow(),
			`create-attempt-${attempt}`,
		);
		const intent = createIntent(
			state,
			attempt,
			notBefore,
			deps.randomNonce(),
			canonicalAuthoritySha256(request),
		);
		writeIntentState(
			input,
			state,
			intent,
			"CREATING",
			`create-pair-intent-${attempt}`,
			notBefore,
			deps.randomId,
		);
		state = validateRigState({
			...state,
			lifecycle: "CREATING",
			creationAttempt: attempt,
			createIntent: intent,
			evidence: {
				...state.evidence,
				offrunnerEvidenceSealed: true,
				cleanupDisposition: "NEVER_DISPATCHED",
			},
		});
		appendState(
			input,
			state,
			"INTENT",
			`create-pair-before-provider-${attempt}`,
			{ requestSha256: intent.requestSha256 },
			deps.randomId,
		);
		const createResult = await executeMutation(input.provider, {
			operationId: `do-create-pair-${attempt}`,
			phase: "CREATING",
			attempt,
			args: request.dropletArgs,
		});
		const returnedIds = idsFromRawDropletArray(
			createResult.stdout,
			"create response",
		);
		if (returnedIds.length < 1 || returnedIds.length > 2) {
			fail("create response must identify one or two created resources");
		}
		const returnedIdentities = normalizeDropletInventory(createResult.stdout, {
			desired: state.desired,
			projectResourceIds:
				state.desired.profile.projectMode === "assign" ? returnedIds : [],
			provenSshKeyId: state.desired.profile.sshKeyId,
			scope: "current-run",
			requireExactProfile: false,
		});
		if (
			returnedIdentities.some(
				(identity) =>
					Date.parse(identity.createdAt) < Date.parse(intent.notBefore),
			)
		) {
			fail("create response contains a resource older than its durable intent");
		}
		state = validateRigState({
			...state,
			ownedResources: ownedResources(
				returnedIdentities,
				"CREATED",
				attempt,
				input.clock.wallNow(),
			),
		});
		appendState(
			input,
			state,
			"RESULT",
			`record-create-response-${attempt}`,
			{
				ids: returnedIds,
				create: operationSummary(createResult),
			},
			deps.randomId,
		);
	}
}

function writeDurableDestructionReceipt(
	path: string,
	receipt: G6DestructionReceipt,
	randomId: () => string,
): void {
	if (existsSync(path)) fail("refusing to replace a destruction receipt");
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true });
	const staging = join(parent, `.${basename(path)}.staging-${randomId()}`);
	const fd = openSync(staging, "wx", 0o600);
	try {
		writeFileSync(fd, canonicalJson(receipt), "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(staging, path);
	const parentFd = openSync(parent, "r");
	try {
		fsyncSync(parentFd);
	} finally {
		closeSync(parentFd);
	}
}

export function validateG6DestructionReceipt(
	value: unknown,
): G6DestructionReceipt {
	if (!isRecord(value)) fail("destruction receipt must be an object");
	const keys = Object.keys(value).sort();
	const expected = [
		"schema",
		"envelope",
		"desiredRigAuthoritySha256",
		"finalJournalArtifactSha256",
		"deletedIds",
		"verifiedAbsentAt",
		"runTagInventoryEmpty",
	].sort();
	if (
		keys.length !== expected.length ||
		keys.some((key, index) => key !== expected[index])
	) {
		fail("destruction receipt has an invalid shape");
	}
	if (value.schema !== "g6-c32-destruction-receipt/1") {
		fail("destruction receipt schema is not supported");
	}
	const envelope = validateEnvelope(value.envelope);
	if (envelope.phase !== "DESTROYED") {
		fail("destruction receipt phase must be DESTROYED");
	}
	if (
		!Array.isArray(value.deletedIds) ||
		(value.deletedIds.length !== 0 && value.deletedIds.length !== 2)
	) {
		fail("destruction receipt must contain zero or exactly two deleted IDs");
	}
	const deletedIds = value.deletedIds.map((id, index) => {
		if (!Number.isSafeInteger(id) || (id as number) < 1) {
			fail(`destruction receipt deletedIds[${index}] is invalid`);
		}
		return id as number;
	});
	if (deletedIds.length === 2 && new Set(deletedIds).size !== 2) {
		fail("destruction receipt IDs must be distinct");
	}
	const requireDigest = (digest: unknown, label: string): string => {
		if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
			fail(`${label} must be a lowercase SHA-256 digest`);
		}
		return digest;
	};
	if (value.runTagInventoryEmpty !== true) {
		fail("destruction receipt must prove empty run-tag inventory");
	}
	return {
		schema: "g6-c32-destruction-receipt/1",
		envelope,
		desiredRigAuthoritySha256: requireDigest(
			value.desiredRigAuthoritySha256,
			"desiredRigAuthoritySha256",
		),
		finalJournalArtifactSha256: requireDigest(
			value.finalJournalArtifactSha256,
			"finalJournalArtifactSha256",
		),
		deletedIds: deletedIds as [] | [number, number],
		verifiedAbsentAt: validateRfc3339Millis(
			value.verifiedAbsentAt,
			"verifiedAbsentAt",
		),
		runTagInventoryEmpty: true,
	};
}

export async function destroyDigitalOceanRig(
	input: DestroyDigitalOceanRigInput,
): Promise<{ state: RigState; receipt: G6DestructionReceipt }> {
	const deps = lifecycleDependencies(input);
	let state = loadRigStateFromJournal(input.journalPath);
	if (
		state.lifecycle === "DESTROYED" &&
		existsSync(input.destructionReceiptPath)
	) {
		const finalSnapshot = readRigJournal(input.journalPath);
		const receipt = validateG6DestructionReceipt(
			JSON.parse(readFileSync(input.destructionReceiptPath, "utf8")) as unknown,
		);
		if (
			receipt.envelope.runId !== state.desired.runId ||
			receipt.desiredRigAuthoritySha256 !==
				canonicalAuthoritySha256(state.desired) ||
			receipt.finalJournalArtifactSha256 !==
				canonicalArtifactSha256(finalSnapshot)
		) {
			fail("existing destruction receipt does not bind the final rig journal");
		}
		return {
			state,
			receipt,
		};
	}
	const ids = state.ownedResources
		.slice()
		.sort((left, right) =>
			left.role === right.role
				? left.id - right.id
				: left.role === "server"
					? -1
					: 1,
		)
		.map(({ id }) => id);
	if (ids.length === 0) {
		if (
			(state.lifecycle !== "FAILED" && state.lifecycle !== "TERMINAL") ||
			!state.evidence.offrunnerEvidenceSealed ||
			!state.evidence.controllerExited ||
			state.evidence.inventoryAmbiguous
		) {
			fail("zero-resource destroy requires unambiguous sealed terminal state");
		}
		const inventory = await inventoryDigitalOcean({
			desired: state.desired,
			provider: input.provider,
			attempt: Math.max(1, state.creationAttempt),
		});
		if (
			inventory.managementInventory.length !== 0 ||
			inventory.currentRunInventory.length !== 0
		) {
			fail("zero-resource destroy found managed or current-run resources");
		}
		state = validateRigState({
			...state,
			lifecycle: "DESTROYED",
			evidence: {
				...state.evidence,
				cleanupDisposition: "CLEANUP_COMPLETE",
			},
		});
		const finalSnapshot = appendRigJournalEvent(
			input.journalPath,
			{
				state: "DESTROYED",
				kind: "RESULT",
				operationId: "destroy-empty-inventory-verified",
				details: {
					rigState: state,
					cloud: {
						deletedIds: [],
						verifiedAbsentAt: inventory.observedAt,
					},
				},
			},
			{ clock: input.clock, randomId: deps.randomId },
		);
		const receipt = validateG6DestructionReceipt({
			schema: "g6-c32-destruction-receipt/1",
			envelope: {
				recordedAt: input.clock.wallNow(),
				sequence: finalSnapshot.envelope.sequence + 1,
				runId: state.desired.runId,
				phase: "DESTROYED",
				operationId: "destruction-receipt",
				clockSource: "offrunner",
			},
			desiredRigAuthoritySha256: canonicalAuthoritySha256(state.desired),
			finalJournalArtifactSha256: canonicalArtifactSha256(finalSnapshot),
			deletedIds: [],
			verifiedAbsentAt: inventory.observedAt,
			runTagInventoryEmpty: true,
		});
		writeDurableDestructionReceipt(
			input.destructionReceiptPath,
			receipt,
			deps.randomId,
		);
		return { state, receipt };
	}
	if (ids.length !== 2) fail("destroy requires exactly two journal-owned IDs");
	const exactIds = ids as [number, number];
	const resumingDestroy = state.lifecycle === "DESTROYING";
	const inventory = await inventoryDigitalOcean({
		desired: state.desired,
		provider: input.provider,
		attempt: Math.max(1, state.creationAttempt),
		exactIds,
		allowMissingExact: resumingDestroy,
	});
	let idsStillPresent: number[] = [...exactIds];
	if (resumingDestroy) {
		const ownedById = new Map(
			state.ownedResources.map((owned) => [owned.id, owned]),
		);
		if (
			inventory.managementInventory.some(({ id }) => !ownedById.has(id)) ||
			inventory.currentRunInventory.some(({ id }) => !ownedById.has(id))
		) {
			fail("destroy recovery found an unknown managed or current-run resource");
		}
		for (const identity of inventory.exactInventory) {
			const owned = ownedById.get(identity.id);
			if (
				!owned ||
				canonicalJson(owned.recordedIdentity) !== canonicalJson(identity)
			) {
				fail(`destroy recovery identity mismatch for Droplet ${identity.id}`);
			}
		}
		idsStillPresent = inventory.exactInventory.map(({ id }) => id);
		appendState(
			input,
			state,
			"RECOVERY",
			"resume-destroy-exact-pair",
			{
				ownedIds: exactIds,
				idsStillPresent,
				inventoryObservedAt: inventory.observedAt,
			},
			deps.randomId,
		);
	} else {
		const authorization = mayDestroy(
			state,
			inventory.managementInventory,
			input.clock.wallNow(),
		);
		if (authorization.kind !== "DESTROY") {
			fail(`destroy refused: ${authorization.reasons.join("; ")}`);
		}
		state = validateRigState({ ...state, lifecycle: "DESTROYING" });
		appendState(
			input,
			state,
			"INTENT",
			"destroy-exact-pair-before-provider",
			{ ids: authorization.ids, inventoryObservedAt: inventory.observedAt },
			deps.randomId,
		);
	}
	let deleteSummary: unknown = null;
	let verifiedAbsentAt: string;
	if (idsStillPresent.length > 0) {
		const deletion = await deleteOwnedAndVerify(
			input,
			state,
			idsStillPresent,
			Math.max(1, state.creationAttempt),
			deps,
		);
		deleteSummary = operationSummary(deletion.result);
		verifiedAbsentAt = deletion.verifiedAbsentAt;
	} else {
		verifiedAbsentAt = await verifyDeletedIdsAbsent(
			input,
			state,
			exactIds,
			Math.max(1, state.creationAttempt),
			deps,
		);
	}
	closeIntent(input, state, deps.randomId);
	state = validateRigState({
		...state,
		lifecycle: "DESTROYED",
		createIntent: state.createIntent
			? { ...state.createIntent, state: "CLOSED" }
			: null,
		evidence: {
			...state.evidence,
			cleanupDisposition: "CLEANUP_COMPLETE",
		},
	});
	const finalSnapshot = appendRigJournalEvent(
		input.journalPath,
		{
			state: "DESTROYED",
			kind: "RESULT",
			operationId: "destroy-exact-pair-verified",
			details: {
				rigState: state,
				cloud: {
					deletedIds: exactIds,
					delete: deleteSummary,
					verifiedAbsentAt,
				},
			},
		},
		{ clock: input.clock, randomId: deps.randomId },
	);
	const receipt = validateG6DestructionReceipt({
		schema: "g6-c32-destruction-receipt/1",
		envelope: {
			recordedAt: input.clock.wallNow(),
			sequence: finalSnapshot.envelope.sequence + 1,
			runId: state.desired.runId,
			phase: "DESTROYED",
			operationId: "destruction-receipt",
			clockSource: "offrunner",
		},
		desiredRigAuthoritySha256: canonicalAuthoritySha256(state.desired),
		finalJournalArtifactSha256: canonicalArtifactSha256(finalSnapshot),
		deletedIds: [...exactIds],
		verifiedAbsentAt,
		runTagInventoryEmpty: true,
	});
	writeDurableDestructionReceipt(
		input.destructionReceiptPath,
		receipt,
		deps.randomId,
	);
	return { state, receipt };
}
