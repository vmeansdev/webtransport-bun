import {
	canonicalJson,
	validateDeadline,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import type { RigLifecycleState } from "./g6-c32-rig-journal.ts";

export type { RigLifecycleState } from "./g6-c32-rig-journal.ts";

export type DesiredRig = {
	recordedAt: string;
	requestedAt: string;
	deadline: string;
	runId: string;
	managementTag: string;
	runTag: string;
	roles: {
		serverName: string;
		generatorName: string;
	};
	profile: {
		region: string;
		size: string;
		image: string;
		vpcUuid: string;
		projectMode: "assign" | "none";
		projectId: string | null;
		sshKeyId: number;
		expectedVcpus: number;
		expectedMemoryMiB: number;
	};
	semantic: {
		freezeAuthoritySha256: string;
		freezeArtifactSha256: string;
		approvalAuthoritySha256: string;
		approvalArtifactSha256: string;
	};
};

export type DropletIdentity = {
	id: number;
	role: "server" | "generator" | null;
	name: string;
	tags: string[];
	region: string;
	size: string;
	image: string;
	vpcUuid: string;
	projectId: string | null;
	sshKeyIds: number[];
	vcpus: number;
	memoryMiB: number;
	status: string;
	createdAt: string;
	publicIpv4: string;
	privateIpv4: string;
};

export type OwnedResource = {
	id: number;
	role: "server" | "generator";
	source: "CREATED" | "RECOVERED";
	creationAttempt: 1 | 2;
	recordedAt: string;
	recordedIdentity: DropletIdentity;
};

export type CreateIntent = {
	state: "OPEN" | "CONSUMED" | "CLOSED";
	mutationNonce: string;
	runId: string;
	managementTag: string;
	runTag: string;
	roles: DesiredRig["roles"];
	profile: DesiredRig["profile"];
	semantic: DesiredRig["semantic"];
	attempt: 1 | 2;
	notBefore: string;
	requestSha256: string;
};

export type CleanupDisposition =
	| "NEVER_DISPATCHED"
	| "CLEANUP_COMPLETE"
	| "RECOVERY_CLEAN"
	| "RECOVERY_UNREACHABLE"
	| "RECOVERY_TIMED_OUT";

export type RecoveryOutcome = Extract<
	CleanupDisposition,
	"RECOVERY_CLEAN" | "RECOVERY_UNREACHABLE" | "RECOVERY_TIMED_OUT"
>;

export type RigState = {
	desired: DesiredRig;
	lifecycle: RigLifecycleState;
	ownedResources: OwnedResource[];
	createIntent: CreateIntent | null;
	creationAttempt: 0 | 1 | 2;
	evidence: {
		offrunnerEvidenceSealed: boolean;
		controllerExited: boolean;
		cleanupDisposition: CleanupDisposition | null;
		inventoryAmbiguous: boolean;
	};
};

export type ReconcileDecision =
	| { kind: "CREATE_PAIR" }
	| { kind: "REUSE_PAIR"; ids: readonly [number, number] }
	| { kind: "RECOVER_INTENT"; resources: readonly DropletIdentity[] }
	| { kind: "DELETE_OWNED_AND_RETRY"; ids: readonly number[] }
	| { kind: "DESTROY_TERMINAL"; ids: readonly [number, number] }
	| { kind: "INVENTORY_AMBIGUOUS"; reasons: readonly string[] };

export type DestroyDecision =
	| { kind: "DESTROY"; ids: readonly [number, number] }
	| { kind: "REFUSE_DESTROY"; reasons: readonly string[] };

const SHA256_RE = /^[0-9a-f]{64}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const IPV4_RE = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

const TERMINAL_FOR_DESTROY = new Set<RigLifecycleState>([
	"TERMINAL",
	"FAILED",
	"DESTROYING",
]);

const NORMAL_TRANSITIONS = new Map<RigLifecycleState, RigLifecycleState>([
	["ABSENT", "CREATING"],
	["CREATING", "PROVISIONED"],
	["PROVISIONED", "PREPARING"],
	["PREPARING", "PREPARED"],
	["PREPARED", "BINDING"],
	["BINDING", "BOUND"],
	["BOUND", "QUALIFYING"],
	["QUALIFYING", "RUNNING"],
	["RUNNING", "TERMINAL"],
	["TERMINAL", "DESTROYING"],
	["DESTROYING", "DESTROYED"],
]);

function fail(message: string): never {
	throw new Error(`g6-c32-rig-model: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	label: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, index) => key !== wanted[index])
	) {
		fail(`${label} has an invalid shape`);
	}
}

function requireString(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!SAFE_VALUE_RE.test(value) ||
		value.includes("\0") ||
		value.includes("\n") ||
		value.includes("\r")
	) {
		fail(`${label} must be a nonempty single-line identifier`);
	}
	return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 1) {
		fail(`${label} must be a positive safe integer`);
	}
	return value as number;
}

function requireSha256(value: unknown, label: string): string {
	if (typeof value !== "string" || !SHA256_RE.test(value)) {
		fail(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

function requireIpv4(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		!IPV4_RE.test(value) ||
		value.split(".").some((octet) => Number(octet) > 255)
	) {
		fail(`${label} must be an IPv4 address`);
	}
	return value;
}

function requireBoolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") fail(`${label} must be Boolean`);
	return value;
}

function validateRoles(value: unknown, label: string): DesiredRig["roles"] {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(value, ["serverName", "generatorName"], label);
	const roles = {
		serverName: requireString(value.serverName, `${label}.serverName`),
		generatorName: requireString(value.generatorName, `${label}.generatorName`),
	};
	if (roles.serverName === roles.generatorName) {
		fail(`${label} names must be distinct`);
	}
	return roles;
}

function validateProfile(value: unknown, label: string): DesiredRig["profile"] {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(
		value,
		[
			"region",
			"size",
			"image",
			"vpcUuid",
			"projectMode",
			"projectId",
			"sshKeyId",
			"expectedVcpus",
			"expectedMemoryMiB",
		],
		label,
	);
	if (value.projectMode !== "assign" && value.projectMode !== "none") {
		fail(`${label}.projectMode must be assign or none`);
	}
	const projectId =
		value.projectId === null
			? null
			: requireString(value.projectId, `${label}.projectId`);
	if (
		(value.projectMode === "assign" && projectId === null) ||
		(value.projectMode === "none" && projectId !== null)
	) {
		fail(`${label}.projectId does not match projectMode`);
	}
	return {
		region: requireString(value.region, `${label}.region`),
		size: requireString(value.size, `${label}.size`),
		image: requireString(value.image, `${label}.image`),
		vpcUuid: requireString(value.vpcUuid, `${label}.vpcUuid`),
		projectMode: value.projectMode,
		projectId,
		sshKeyId: requirePositiveInteger(value.sshKeyId, `${label}.sshKeyId`),
		expectedVcpus: requirePositiveInteger(
			value.expectedVcpus,
			`${label}.expectedVcpus`,
		),
		expectedMemoryMiB: requirePositiveInteger(
			value.expectedMemoryMiB,
			`${label}.expectedMemoryMiB`,
		),
	};
}

function validateSemantic(
	value: unknown,
	label: string,
): DesiredRig["semantic"] {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(
		value,
		[
			"freezeAuthoritySha256",
			"freezeArtifactSha256",
			"approvalAuthoritySha256",
			"approvalArtifactSha256",
		],
		label,
	);
	return {
		freezeAuthoritySha256: requireSha256(
			value.freezeAuthoritySha256,
			`${label}.freezeAuthoritySha256`,
		),
		freezeArtifactSha256: requireSha256(
			value.freezeArtifactSha256,
			`${label}.freezeArtifactSha256`,
		),
		approvalAuthoritySha256: requireSha256(
			value.approvalAuthoritySha256,
			`${label}.approvalAuthoritySha256`,
		),
		approvalArtifactSha256: requireSha256(
			value.approvalArtifactSha256,
			`${label}.approvalArtifactSha256`,
		),
	};
}

export function validateDesiredRig(
	value: unknown,
	createTime?: unknown,
): DesiredRig {
	if (!isRecord(value)) fail("desired rig must be an object");
	requireExactKeys(
		value,
		[
			"recordedAt",
			"requestedAt",
			"deadline",
			"runId",
			"managementTag",
			"runTag",
			"roles",
			"profile",
			"semantic",
		],
		"desired rig",
	);
	const recordedAt = validateRfc3339Millis(value.recordedAt, "recordedAt");
	const requestedAt = validateRfc3339Millis(value.requestedAt, "requestedAt");
	const deadline = validateDeadline(requestedAt, value.deadline);
	if (createTime !== undefined) {
		const checkedCreateTime = validateRfc3339Millis(createTime, "createTime");
		if (Date.parse(checkedCreateTime) >= Date.parse(deadline)) {
			fail("deadline must be in the future at create time");
		}
	}
	const runId = requireString(value.runId, "runId");
	const managementTag = requireString(value.managementTag, "managementTag");
	const runTag = requireString(value.runTag, "runTag");
	if (managementTag === runTag) {
		fail("managementTag and runTag must be distinct");
	}
	return {
		recordedAt,
		requestedAt,
		deadline,
		runId,
		managementTag,
		runTag,
		roles: validateRoles(value.roles, "roles"),
		profile: validateProfile(value.profile, "profile"),
		semantic: validateSemantic(value.semantic, "semantic"),
	};
}

export function validateDropletIdentity(
	value: unknown,
	label = "droplet",
): DropletIdentity {
	if (!isRecord(value)) fail(`${label} must be an object`);
	requireExactKeys(
		value,
		[
			"id",
			"role",
			"name",
			"tags",
			"region",
			"size",
			"image",
			"vpcUuid",
			"projectId",
			"sshKeyIds",
			"vcpus",
			"memoryMiB",
			"status",
			"createdAt",
			"publicIpv4",
			"privateIpv4",
		],
		label,
	);
	if (
		value.role !== "server" &&
		value.role !== "generator" &&
		value.role !== null
	) {
		fail(`${label}.role is invalid`);
	}
	if (!Array.isArray(value.tags) || value.tags.length === 0) {
		fail(`${label}.tags must be a nonempty array`);
	}
	const tags = value.tags.map((tag, index) =>
		requireString(tag, `${label}.tags[${index}]`),
	);
	if (new Set(tags).size !== tags.length) fail(`${label}.tags must be unique`);
	if (!Array.isArray(value.sshKeyIds) || value.sshKeyIds.length === 0) {
		fail(`${label}.sshKeyIds must be a nonempty array`);
	}
	const sshKeyIds = value.sshKeyIds.map((id, index) =>
		requirePositiveInteger(id, `${label}.sshKeyIds[${index}]`),
	);
	if (new Set(sshKeyIds).size !== sshKeyIds.length) {
		fail(`${label}.sshKeyIds must be unique`);
	}
	const publicIpv4 = requireIpv4(value.publicIpv4, `${label}.publicIpv4`);
	const privateIpv4 = requireIpv4(value.privateIpv4, `${label}.privateIpv4`);
	return {
		id: requirePositiveInteger(value.id, `${label}.id`),
		role: value.role,
		name: requireString(value.name, `${label}.name`),
		tags: tags.sort(),
		region: requireString(value.region, `${label}.region`),
		size: requireString(value.size, `${label}.size`),
		image: requireString(value.image, `${label}.image`),
		vpcUuid: requireString(value.vpcUuid, `${label}.vpcUuid`),
		projectId:
			value.projectId === null
				? null
				: requireString(value.projectId, `${label}.projectId`),
		sshKeyIds: sshKeyIds.sort((left, right) => left - right),
		vcpus: requirePositiveInteger(value.vcpus, `${label}.vcpus`),
		memoryMiB: requirePositiveInteger(value.memoryMiB, `${label}.memoryMiB`),
		status: requireString(value.status, `${label}.status`),
		createdAt: validateRfc3339Millis(value.createdAt, `${label}.createdAt`),
		publicIpv4,
		privateIpv4,
	};
}

function validateOwnedResource(value: unknown, index: number): OwnedResource {
	if (!isRecord(value)) fail(`ownedResources[${index}] must be an object`);
	requireExactKeys(
		value,
		[
			"id",
			"role",
			"source",
			"creationAttempt",
			"recordedAt",
			"recordedIdentity",
		],
		`ownedResources[${index}]`,
	);
	if (value.role !== "server" && value.role !== "generator") {
		fail(`ownedResources[${index}].role is invalid`);
	}
	if (value.source !== "CREATED" && value.source !== "RECOVERED") {
		fail(`ownedResources[${index}].source is invalid`);
	}
	if (value.creationAttempt !== 1 && value.creationAttempt !== 2) {
		fail(`ownedResources[${index}].creationAttempt is invalid`);
	}
	const recordedIdentity = validateDropletIdentity(
		value.recordedIdentity,
		`ownedResources[${index}].recordedIdentity`,
	);
	const id = requirePositiveInteger(value.id, `ownedResources[${index}].id`);
	if (recordedIdentity.id !== id || recordedIdentity.role !== value.role) {
		fail(`ownedResources[${index}] identity does not match ownership`);
	}
	return {
		id,
		role: value.role,
		source: value.source,
		creationAttempt: value.creationAttempt,
		recordedAt: validateRfc3339Millis(
			value.recordedAt,
			`ownedResources[${index}].recordedAt`,
		),
		recordedIdentity,
	};
}

function validateCreateIntent(
	value: unknown,
	desired: DesiredRig,
): CreateIntent {
	if (!isRecord(value)) fail("createIntent must be an object");
	requireExactKeys(
		value,
		[
			"state",
			"mutationNonce",
			"runId",
			"managementTag",
			"runTag",
			"roles",
			"profile",
			"semantic",
			"attempt",
			"notBefore",
			"requestSha256",
		],
		"createIntent",
	);
	if (
		value.state !== "OPEN" &&
		value.state !== "CONSUMED" &&
		value.state !== "CLOSED"
	) {
		fail("createIntent.state is invalid");
	}
	if (value.attempt !== 1 && value.attempt !== 2) {
		fail("createIntent.attempt is invalid");
	}
	const checked: CreateIntent = {
		state: value.state,
		mutationNonce: requireString(
			value.mutationNonce,
			"createIntent.mutationNonce",
		),
		runId: requireString(value.runId, "createIntent.runId"),
		managementTag: requireString(
			value.managementTag,
			"createIntent.managementTag",
		),
		runTag: requireString(value.runTag, "createIntent.runTag"),
		roles: validateRoles(value.roles, "createIntent.roles"),
		profile: validateProfile(value.profile, "createIntent.profile"),
		semantic: validateSemantic(value.semantic, "createIntent.semantic"),
		attempt: value.attempt,
		notBefore: validateRfc3339Millis(value.notBefore, "createIntent.notBefore"),
		requestSha256: requireSha256(
			value.requestSha256,
			"createIntent.requestSha256",
		),
	};
	if (
		checked.runId !== desired.runId ||
		checked.managementTag !== desired.managementTag ||
		checked.runTag !== desired.runTag ||
		canonicalJson(checked.roles) !== canonicalJson(desired.roles) ||
		canonicalJson(checked.profile) !== canonicalJson(desired.profile) ||
		canonicalJson(checked.semantic) !== canonicalJson(desired.semantic)
	) {
		fail("createIntent does not match desired rig authority");
	}
	if (
		Date.parse(checked.notBefore) < Date.parse(desired.requestedAt) ||
		Date.parse(checked.notBefore) >= Date.parse(desired.deadline)
	) {
		fail("createIntent.notBefore is outside the desired lifecycle window");
	}
	return checked;
}

export function validateRigState(value: unknown): RigState {
	if (!isRecord(value)) fail("rig state must be an object");
	requireExactKeys(
		value,
		[
			"desired",
			"lifecycle",
			"ownedResources",
			"createIntent",
			"creationAttempt",
			"evidence",
		],
		"rig state",
	);
	const desired = validateDesiredRig(value.desired);
	if (
		typeof value.lifecycle !== "string" ||
		!(
			NORMAL_TRANSITIONS.has(value.lifecycle as RigLifecycleState) ||
			value.lifecycle === "DESTROYED" ||
			value.lifecycle === "FAILED"
		)
	) {
		fail("rig lifecycle state is invalid");
	}
	if (!Array.isArray(value.ownedResources) || value.ownedResources.length > 2) {
		fail("ownedResources must contain at most two entries");
	}
	const ownedResources = value.ownedResources.map((entry, index) =>
		validateOwnedResource(entry, index),
	);
	if (
		new Set(ownedResources.map(({ id }) => id)).size !==
			ownedResources.length ||
		new Set(ownedResources.map(({ role }) => role)).size !==
			ownedResources.length
	) {
		fail("ownedResources IDs and roles must be unique");
	}
	if (
		value.creationAttempt !== 0 &&
		value.creationAttempt !== 1 &&
		value.creationAttempt !== 2
	) {
		fail("creationAttempt must be 0, 1, or 2");
	}
	const creationAttempt = value.creationAttempt as 0 | 1 | 2;
	const createIntent =
		value.createIntent === null
			? null
			: validateCreateIntent(value.createIntent, desired);
	if (
		(ownedResources.length > 0 && creationAttempt === 0) ||
		ownedResources.some(
			(resource) => resource.creationAttempt > creationAttempt,
		) ||
		(createIntent !== null && createIntent.attempt !== creationAttempt)
	) {
		fail("creationAttempt is inconsistent with ownership or createIntent");
	}
	if (!isRecord(value.evidence)) fail("evidence must be an object");
	requireExactKeys(
		value.evidence,
		[
			"offrunnerEvidenceSealed",
			"controllerExited",
			"cleanupDisposition",
			"inventoryAmbiguous",
		],
		"evidence",
	);
	const cleanupDisposition = value.evidence.cleanupDisposition;
	if (
		cleanupDisposition !== null &&
		cleanupDisposition !== "NEVER_DISPATCHED" &&
		cleanupDisposition !== "CLEANUP_COMPLETE" &&
		cleanupDisposition !== "RECOVERY_CLEAN" &&
		cleanupDisposition !== "RECOVERY_UNREACHABLE" &&
		cleanupDisposition !== "RECOVERY_TIMED_OUT"
	) {
		fail("evidence.cleanupDisposition is invalid");
	}
	return {
		desired,
		lifecycle: value.lifecycle as RigLifecycleState,
		ownedResources,
		createIntent,
		creationAttempt,
		evidence: {
			offrunnerEvidenceSealed: requireBoolean(
				value.evidence.offrunnerEvidenceSealed,
				"evidence.offrunnerEvidenceSealed",
			),
			controllerExited: requireBoolean(
				value.evidence.controllerExited,
				"evidence.controllerExited",
			),
			cleanupDisposition: cleanupDisposition as CleanupDisposition | null,
			inventoryAmbiguous: requireBoolean(
				value.evidence.inventoryAmbiguous,
				"evidence.inventoryAmbiguous",
			),
		},
	};
}

function expectedName(
	desired: DesiredRig,
	role: "server" | "generator",
): string {
	return role === "server"
		? desired.roles.serverName
		: desired.roles.generatorName;
}

function matchesDesired(
	identity: DropletIdentity,
	desired: DesiredRig,
): boolean {
	if (identity.role === null) return false;
	return (
		identity.name === expectedName(desired, identity.role) &&
		identity.tags.length === 2 &&
		identity.tags.includes(desired.managementTag) &&
		identity.tags.includes(desired.runTag) &&
		identity.region === desired.profile.region &&
		identity.size === desired.profile.size &&
		identity.image === desired.profile.image &&
		identity.vpcUuid === desired.profile.vpcUuid &&
		identity.projectId === desired.profile.projectId &&
		identity.sshKeyIds.length === 1 &&
		identity.sshKeyIds[0] === desired.profile.sshKeyId &&
		identity.vcpus === desired.profile.expectedVcpus &&
		identity.memoryMiB === desired.profile.expectedMemoryMiB &&
		identity.status === "active"
	);
}

function matchesOwned(
	identity: DropletIdentity,
	owned: OwnedResource,
): boolean {
	return canonicalJson(identity) === canonicalJson(owned.recordedIdentity);
}

function orderedOwnedIds(
	resources: readonly OwnedResource[],
): readonly number[] {
	return [...resources]
		.sort((left, right) => {
			if (left.role === right.role) return left.id - right.id;
			return left.role === "server" ? -1 : 1;
		})
		.map(({ id }) => id);
}

function exactPair(ids: readonly number[], label: string): [number, number] {
	const first = ids[0];
	const second = ids[1];
	if (ids.length !== 2 || first === undefined || second === undefined) {
		fail(`${label} requires exactly two IDs`);
	}
	return [first, second];
}

function orderedDroplets(
	resources: readonly DropletIdentity[],
): DropletIdentity[] {
	return [...resources].sort((left, right) => {
		if (left.role !== right.role) {
			if (left.role === "server") return -1;
			if (right.role === "server") return 1;
			if (left.role === "generator") return -1;
			if (right.role === "generator") return 1;
		}
		return left.id - right.id;
	});
}

function ambiguous(...reasons: string[]): ReconcileDecision {
	return {
		kind: "INVENTORY_AMBIGUOUS",
		reasons: [...new Set(reasons)].sort(),
	};
}

export function reconcileInventory(
	stateValue: RigState,
	inventoryValue: readonly DropletIdentity[],
): ReconcileDecision {
	const state = validateRigState(stateValue);
	if (state.evidence.inventoryAmbiguous) {
		return ambiguous("journal already marks inventory ambiguous");
	}
	const inventory = inventoryValue.map((entry, index) =>
		validateDropletIdentity(entry, `inventory[${index}]`),
	);
	if (new Set(inventory.map(({ id }) => id)).size !== inventory.length) {
		return ambiguous("duplicate provider resource ID");
	}
	const ownedById = new Map(
		state.ownedResources.map((resource) => [resource.id, resource]),
	);
	const relevant = orderedDroplets(
		inventory.filter(
			(resource) =>
				ownedById.has(resource.id) ||
				resource.tags.includes(state.desired.managementTag) ||
				resource.tags.includes(state.desired.runTag) ||
				resource.name === state.desired.roles.serverName ||
				resource.name === state.desired.roles.generatorName,
		),
	);
	if (relevant.length > 2) return ambiguous("more than two relevant resources");
	for (const role of ["server", "generator"] as const) {
		if (relevant.filter((resource) => resource.role === role).length > 1) {
			return ambiguous(`duplicate ${role} role`);
		}
	}
	const unowned = relevant.filter((resource) => !ownedById.has(resource.id));
	const recoverable: DropletIdentity[] = [];
	const unknownReasons: string[] = [];
	for (const resource of unowned) {
		const openIntent = state.createIntent?.state === "OPEN";
		if (
			openIntent &&
			state.createIntent &&
			matchesDesired(resource, state.desired) &&
			Date.parse(resource.createdAt) >= Date.parse(state.createIntent.notBefore)
		) {
			recoverable.push(resource);
		} else {
			unknownReasons.push(
				`resource ${resource.id} is not journal-owned or recoverable`,
			);
			if (
				openIntent &&
				state.createIntent &&
				Date.parse(resource.createdAt) <
					Date.parse(state.createIntent.notBefore)
			) {
				unknownReasons.push(
					`resource ${resource.id} predates the create intent`,
				);
			}
		}
	}
	if (unknownReasons.length > 0) return ambiguous(...unknownReasons);
	if (recoverable.length > 0) {
		return {
			kind: "RECOVER_INTENT",
			resources: orderedDroplets(recoverable),
		};
	}
	if (state.ownedResources.length === 0) {
		if (relevant.length !== 0) return ambiguous("unowned relevant resources");
		if (state.lifecycle !== "ABSENT" && state.lifecycle !== "CREATING") {
			return ambiguous("empty inventory is inconsistent with lifecycle state");
		}
		return { kind: "CREATE_PAIR" };
	}
	const ownedInventory = relevant.filter((resource) =>
		ownedById.has(resource.id),
	);
	const exactOwnedPair =
		state.ownedResources.length === 2 &&
		ownedInventory.length === 2 &&
		state.ownedResources.every((owned) => {
			const current = ownedInventory.find(({ id }) => id === owned.id);
			return (
				current !== undefined &&
				matchesDesired(current, state.desired) &&
				matchesOwned(current, owned)
			);
		});
	if (TERMINAL_FOR_DESTROY.has(state.lifecycle)) {
		if (!exactOwnedPair || !state.evidence.offrunnerEvidenceSealed) {
			return ambiguous("terminal owned pair is not exact and evidence-sealed");
		}
		const ids = orderedOwnedIds(state.ownedResources);
		return {
			kind: "DESTROY_TERMINAL",
			ids: exactPair(ids, "terminal destroy"),
		};
	}
	if (exactOwnedPair) {
		const ids = orderedOwnedIds(state.ownedResources);
		return { kind: "REUSE_PAIR", ids: exactPair(ids, "pair reuse") };
	}
	if (!state.evidence.offrunnerEvidenceSealed) {
		return ambiguous("owned-resource evidence must be sealed before deletion");
	}
	return {
		kind: "DELETE_OWNED_AND_RETRY",
		ids: orderedOwnedIds(state.ownedResources),
	};
}

export function assertLifecycleTransition(
	from: RigLifecycleState,
	to: RigLifecycleState,
): RigLifecycleState {
	if (NORMAL_TRANSITIONS.get(from) === to) return to;
	if (to === "FAILED" && from !== "FAILED" && from !== "DESTROYED") {
		return to;
	}
	if (from === "FAILED" && to === "DESTROYING") return to;
	fail(`transition ${from} -> ${to} is not allowed`);
}

export function nextCreateAttempt(currentAttempt: number): 1 | 2 {
	if (currentAttempt === 0) return 1;
	if (currentAttempt === 1) return 2;
	fail("creation retry is exhausted after attempt 2");
}

export function assertBeforeDeadline(
	desiredValue: DesiredRig,
	nowValue: unknown,
	boundary: string,
): string {
	const desired = validateDesiredRig(desiredValue);
	const now = validateRfc3339Millis(nowValue, "now");
	requireString(boundary, "deadline boundary");
	if (Date.parse(now) >= Date.parse(desired.deadline)) {
		fail(`deadline expired at ${boundary}`);
	}
	return now;
}

export function validateRecoveryOutcome(
	lifecycle: RigLifecycleState,
	outcome: RecoveryOutcome,
): RecoveryOutcome {
	if (lifecycle !== "QUALIFYING" && lifecycle !== "RUNNING") {
		fail("recovery outcomes apply only to QUALIFYING or RUNNING");
	}
	if (
		outcome !== "RECOVERY_CLEAN" &&
		outcome !== "RECOVERY_UNREACHABLE" &&
		outcome !== "RECOVERY_TIMED_OUT"
	) {
		fail("recovery outcome is invalid");
	}
	return outcome;
}

export function mayDestroy(
	stateValue: RigState,
	inventoryValue: readonly DropletIdentity[],
	nowValue: unknown,
): DestroyDecision {
	const state = validateRigState(stateValue);
	const inventory = inventoryValue.map((entry, index) =>
		validateDropletIdentity(entry, `inventory[${index}]`),
	);
	const now = validateRfc3339Millis(nowValue, "now");
	const reasons: string[] = [];
	const deadlineExpired = Date.parse(now) >= Date.parse(state.desired.deadline);
	if (!TERMINAL_FOR_DESTROY.has(state.lifecycle) && !deadlineExpired) {
		reasons.push("state is neither terminal nor past deadline");
	}
	if (!state.evidence.offrunnerEvidenceSealed) {
		reasons.push("off-runner evidence is not sealed");
	}
	if (!state.evidence.controllerExited) {
		reasons.push("controller or benchmark lock is still active");
	}
	if (state.evidence.cleanupDisposition === null) {
		reasons.push("cleanup or bounded recovery evidence is missing");
	}
	if (state.evidence.inventoryAmbiguous) {
		reasons.push("journal marks inventory ambiguous");
	}
	if (state.ownedResources.length !== 2) {
		reasons.push("journal does not own exactly two resources");
	}
	const ownedIds = new Set(state.ownedResources.map(({ id }) => id));
	const relevant = inventory.filter(
		(resource) =>
			ownedIds.has(resource.id) ||
			resource.tags.includes(state.desired.managementTag) ||
			resource.tags.includes(state.desired.runTag) ||
			resource.name === state.desired.roles.serverName ||
			resource.name === state.desired.roles.generatorName,
	);
	if (
		new Set(relevant.map(({ id }) => id)).size !== relevant.length ||
		relevant.length !== 2 ||
		relevant.some(({ id }) => !ownedIds.has(id))
	) {
		reasons.push(
			"fresh inventory is ambiguous or contains an unknown resource",
		);
	}
	for (const owned of state.ownedResources) {
		const current = relevant.find(({ id }) => id === owned.id);
		if (
			!current ||
			!matchesDesired(current, state.desired) ||
			!matchesOwned(current, owned)
		) {
			reasons.push(`owned resource ${owned.id} identity mismatch`);
		}
	}
	if (reasons.length > 0) {
		return { kind: "REFUSE_DESTROY", reasons: [...new Set(reasons)].sort() };
	}
	const ids = orderedOwnedIds(state.ownedResources);
	return { kind: "DESTROY", ids: exactPair(ids, "destroy authorization") };
}
