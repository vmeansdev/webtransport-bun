import { createHash } from "node:crypto";

export type ClockSource = "offrunner" | "server" | "generator" | "provider";

export type RecordEnvelope = {
	recordedAt: string;
	sequence: number;
	runId: string;
	phase: string;
	operationId: string;
	clockSource: ClockSource;
};

export type AuthorityRecord<S extends string, A> = {
	schema: S;
	envelope: RecordEnvelope;
	authoritySha256: string;
	authority: A;
};

export type ArtifactIdentity = {
	path: string;
	sha256: string;
};

export type SemanticFreezeAuthority = {
	candidate: { commit: string; tree: string };
	plan: ArtifactIdentity;
	controller: ArtifactIdentity;
	budgetPolicy: ArtifactIdentity;
	freezeGenerator: ArtifactIdentity & { schemaVersion: string };
	templates: {
		registration: ArtifactIdentity;
		runbook: ArtifactIdentity;
	};
	campaignInputs: ArtifactIdentity[];
	gateCatalog: ArtifactIdentity;
};

export type ReviewReceiptAuthority = {
	semanticFreezeAuthoritySha256: string;
	role: "architect" | "critic";
	verdict: "APPROVE";
	unconditional: true;
	afterArchitectReceiptArtifactSha256: string | null;
};

export type SemanticApprovalAuthority = {
	semanticFreezeAuthoritySha256: string;
	architect: {
		verdict: "APPROVE";
		unconditional: true;
		receiptPath: string;
		receiptArtifactSha256: string;
	};
	critic: {
		verdict: "APPROVE";
		unconditional: true;
		receiptPath: string;
		receiptArtifactSha256: string;
		afterArchitectReceiptArtifactSha256: string;
	};
};

export type AuthorityArtifactIdentity = {
	path: string;
	authoritySha256: string;
	artifactSha256: string;
};

export type HostProviderIdentity = {
	id: number;
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

export type HostBindingHost = {
	role: "server" | "generator";
	provider: HostProviderIdentity;
	bootId: string;
	source: { commit: string; tree: string };
	runtime: {
		os: string;
		osRelease: string;
		kernel: string;
		bunVersion: string;
		rustcVersion: string;
		cargoVersion: string;
	};
	binary: {
		kind: "native-addon" | "mmo-client";
		path: string;
		sha256: string;
	};
	identityPacket: ArtifactIdentity;
	identityOperationReceipt: ArtifactIdentity;
};

export type HostBindingGateReference = {
	id: string;
	phase: "LOCAL" | "PREPARED_HOST";
	receipt: ArtifactIdentity;
	operationReceipt: ArtifactIdentity;
};

export type HostBindingAuthority = {
	semantic: {
		freeze: AuthorityArtifactIdentity;
		approval: AuthorityArtifactIdentity;
		architectReceipt: ArtifactIdentity;
		criticReceipt: ArtifactIdentity;
	};
	rigJournal: ArtifactIdentity;
	knownHosts: {
		file: ArtifactIdentity;
		receipt: ArtifactIdentity;
	};
	preparationReceipt: ArtifactIdentity;
	bundle: ArtifactIdentity;
	retainedBinaries: {
		nativeAddon: ArtifactIdentity;
		generator: ArtifactIdentity;
	};
	hosts: {
		server: HostBindingHost;
		generator: HostBindingHost;
	};
	gates: {
		catalogAuthoritySha256: string;
		receipts: HostBindingGateReference[];
	};
};

export type DispatchFreezeAuthority = {
	semanticFreeze: AuthorityArtifactIdentity;
	semanticApproval: AuthorityArtifactIdentity;
	hostBinding: AuthorityArtifactIdentity;
	views: {
		registration: ArtifactIdentity;
		runbook: ArtifactIdentity;
		exactIdentity: ArtifactIdentity;
	};
};

export type ArtifactManifestEntry = {
	path: string;
	sha256: string;
	bytes: number;
	recordedAt: string;
};

export type ArtifactManifestRecord = {
	schema: "g6-c32-artifact-manifest/1";
	envelope: RecordEnvelope;
	entries: ArtifactManifestEntry[];
};

export type GeneratedViewContext = {
	recordedAt: string;
	runId: string;
	controllerPath: string;
	semanticFreezeArtifactSha256: string;
	semanticApprovalArtifactSha256: string;
	hostBindingArtifactSha256: string;
	hostBinding: HostBindingRecord;
};

export type SemanticFreezeRecord = AuthorityRecord<
	"g6-c32-semantic-freeze/1",
	SemanticFreezeAuthority
>;
export type ReviewReceiptRecord = AuthorityRecord<
	"g6-c32-review-receipt/1",
	ReviewReceiptAuthority
>;
export type SemanticApprovalRecord = AuthorityRecord<
	"g6-c32-semantic-approval/1",
	SemanticApprovalAuthority
>;
export type HostBindingRecord = AuthorityRecord<
	"g6-c32-host-binding/1",
	HostBindingAuthority
>;
export type DispatchFreezeRecord = AuthorityRecord<
	"g6-c32-dispatch-freeze/1",
	DispatchFreezeAuthority
>;

export type OperationReceipt = {
	schema: "g6-c32-operation-receipt/1";
	envelope: RecordEnvelope;
	startedAt: string;
	finishedAt: string;
	durationMonotonicNs: string;
	attempt: number;
	action: {
		command: string;
		args: string[];
		cwd: string;
		environmentKeys: string[];
	};
	status: {
		outcome: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
		exitCode: number | null;
		signal: string | null;
	};
	stdoutPath: string;
	stderrPath: string;
	remoteTiming: null | {
		requestStartedAt: string;
		responseFinishedAt: string;
		observationAt: string | null;
	};
};

const CLOCK_SOURCES = new Set<ClockSource>([
	"offrunner",
	"server",
	"generator",
	"provider",
]);
const HASH_RE = /^[0-9a-f]{64}$/;
const RFC3339_MILLIS_RE =
	/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

type JsonScalar = null | boolean | number | string;
type CanonicalValue =
	| JsonScalar
	| CanonicalValue[]
	| { [key: string]: CanonicalValue };

function fail(path: string, message: string): never {
	throw new Error(`g6-c32-freeze: ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalize(
	value: unknown,
	path: string,
	ancestors: WeakSet<object>,
): CanonicalValue {
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "string"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail(path, "number must be finite");
		return value;
	}
	if (typeof value !== "object") {
		fail(path, `unsupported ${typeof value} value`);
	}
	if (ancestors.has(value)) fail(path, "cyclic value");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const ownKeys = Reflect.ownKeys(value).filter((key) => key !== "length");
			if (
				ownKeys.length !== value.length ||
				ownKeys.some(
					(key, index) => typeof key !== "string" || key !== String(index),
				)
			) {
				fail(path, "arrays must be dense and have no extra properties");
			}
			return value.map((entry, index) =>
				canonicalize(entry, `${path}[${index}]`, ancestors),
			);
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			fail(path, "objects must have a plain prototype");
		}
		if (Object.getOwnPropertySymbols(value).length > 0) {
			fail(path, "symbol keys are not supported");
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const output: Record<string, CanonicalValue> = {};
		for (const key of Object.keys(descriptors).sort()) {
			const descriptor = descriptors[key];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
				fail(`${path}.${key}`, "properties must be enumerable data values");
			}
			output[key] = canonicalize(descriptor.value, `${path}.${key}`, ancestors);
		}
		return output;
	} finally {
		ancestors.delete(value);
	}
}

export function canonicalJson(value: unknown): string {
	return `${JSON.stringify(canonicalize(value, "$", new WeakSet()), null, 2)}\n`;
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function canonicalAuthoritySha256(authority: unknown): string {
	return sha256(canonicalJson(authority));
}

export function canonicalArtifactSha256(record: unknown): string {
	return sha256(canonicalJson(record));
}

function requireExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
	path: string,
): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (
		actual.length !== wanted.length ||
		actual.some((key, i) => key !== wanted[i])
	) {
		fail(path, `expected keys ${wanted.join(",")}; got ${actual.join(",")}`);
	}
}

function requireNonemptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		fail(path, "must be a nonempty string");
	}
	if (
		value.includes("\0") ||
		value.includes("\n") ||
		value.includes("\r") ||
		value.includes("\t")
	) {
		fail(path, "must be a single-line value without NUL or tabs");
	}
	return value;
}

function requireSha256(value: unknown, path: string): string {
	if (typeof value !== "string" || !HASH_RE.test(value)) {
		fail(path, "must be 64 lowercase hexadecimal characters");
	}
	return value;
}

function requireGitSha1(value: unknown, path: string): string {
	if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
		fail(path, "must be a 40-character lowercase Git object ID");
	}
	return value;
}

function requirePortablePath(value: unknown, path: string): string {
	const checked = requireNonemptyString(value, path);
	if (
		checked.startsWith("/") ||
		checked.includes("\\") ||
		checked.includes("\n") ||
		checked.includes("\r") ||
		checked.includes("\t") ||
		checked
			.split("/")
			.some((part) => part === "" || part === "." || part === "..")
	) {
		fail(path, "must be a single-line portable repository-relative path");
	}
	return checked;
}

function requireCommandValue(value: unknown, path: string): string {
	const checked = requireNonemptyString(value, path);
	if (checked.includes("\n") || checked.includes("\r")) {
		fail(path, "must be a single-line value");
	}
	return checked;
}

function requireStringArray(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) fail(path, "must be an array");
	return value.map((entry, index) => {
		if (typeof entry !== "string" || entry.includes("\0")) {
			fail(`${path}[${index}]`, "must be a NUL-free string");
		}
		return entry;
	});
}

function validateArtifactIdentity(
	value: unknown,
	path: string,
): ArtifactIdentity {
	if (!isRecord(value)) fail(path, "must be an object");
	requireExactKeys(value, ["path", "sha256"], path);
	return {
		path: requirePortablePath(value.path, `${path}.path`),
		sha256: requireSha256(value.sha256, `${path}.sha256`),
	};
}

function validateAuthorityRecord<S extends string, A>(
	value: unknown,
	schema: S,
	validateAuthority: (authority: unknown) => A,
): AuthorityRecord<S, A> {
	if (!isRecord(value)) fail(schema, "record must be an object");
	requireExactKeys(
		value,
		["schema", "envelope", "authoritySha256", "authority"],
		schema,
	);
	if (value.schema !== schema) fail("schema", `must equal ${schema}`);
	const envelope = validateEnvelope(value.envelope);
	const authority = validateAuthority(value.authority);
	const authoritySha256 = requireSha256(
		value.authoritySha256,
		"authoritySha256",
	);
	const computed = canonicalAuthoritySha256(authority);
	if (authoritySha256 !== computed) {
		fail("authoritySha256", `digest mismatch; computed ${computed}`);
	}
	return { schema, envelope, authoritySha256, authority };
}

function validateSemanticFreezeAuthority(
	value: unknown,
): SemanticFreezeAuthority {
	if (!isRecord(value)) fail("authority", "must be an object");
	requireExactKeys(
		value,
		[
			"candidate",
			"plan",
			"controller",
			"budgetPolicy",
			"freezeGenerator",
			"templates",
			"campaignInputs",
			"gateCatalog",
		],
		"authority",
	);
	if (!isRecord(value.candidate))
		fail("authority.candidate", "must be an object");
	requireExactKeys(value.candidate, ["commit", "tree"], "authority.candidate");
	if (!isRecord(value.freezeGenerator)) {
		fail("authority.freezeGenerator", "must be an object");
	}
	requireExactKeys(
		value.freezeGenerator,
		["path", "sha256", "schemaVersion"],
		"authority.freezeGenerator",
	);
	if (!isRecord(value.templates))
		fail("authority.templates", "must be an object");
	requireExactKeys(
		value.templates,
		["registration", "runbook"],
		"authority.templates",
	);
	if (
		!Array.isArray(value.campaignInputs) ||
		value.campaignInputs.length === 0
	) {
		fail("authority.campaignInputs", "must be a nonempty array");
	}
	const campaignInputs = value.campaignInputs.map((entry, index) =>
		validateArtifactIdentity(entry, `authority.campaignInputs[${index}]`),
	);
	const paths = new Set(campaignInputs.map((entry) => entry.path));
	if (paths.size !== campaignInputs.length) {
		fail("authority.campaignInputs", "paths must be unique");
	}
	return {
		candidate: {
			commit: requireGitSha1(
				value.candidate.commit,
				"authority.candidate.commit",
			),
			tree: requireGitSha1(value.candidate.tree, "authority.candidate.tree"),
		},
		plan: validateArtifactIdentity(value.plan, "authority.plan"),
		controller: validateArtifactIdentity(
			value.controller,
			"authority.controller",
		),
		budgetPolicy: validateArtifactIdentity(
			value.budgetPolicy,
			"authority.budgetPolicy",
		),
		freezeGenerator: {
			path: requirePortablePath(
				value.freezeGenerator.path,
				"authority.freezeGenerator.path",
			),
			sha256: requireSha256(
				value.freezeGenerator.sha256,
				"authority.freezeGenerator.sha256",
			),
			schemaVersion: requireNonemptyString(
				value.freezeGenerator.schemaVersion,
				"authority.freezeGenerator.schemaVersion",
			),
		},
		templates: {
			registration: validateArtifactIdentity(
				value.templates.registration,
				"authority.templates.registration",
			),
			runbook: validateArtifactIdentity(
				value.templates.runbook,
				"authority.templates.runbook",
			),
		},
		campaignInputs,
		gateCatalog: validateArtifactIdentity(
			value.gateCatalog,
			"authority.gateCatalog",
		),
	};
}

function validateReviewAuthority(value: unknown): ReviewReceiptAuthority {
	if (!isRecord(value)) fail("authority", "must be an object");
	requireExactKeys(
		value,
		[
			"semanticFreezeAuthoritySha256",
			"role",
			"verdict",
			"unconditional",
			"afterArchitectReceiptArtifactSha256",
		],
		"authority",
	);
	if (value.role !== "architect" && value.role !== "critic") {
		fail("authority.role", "must be architect or critic");
	}
	if (value.verdict !== "APPROVE") {
		fail("authority.verdict", "must be APPROVE");
	}
	if (value.unconditional !== true) {
		fail("authority.unconditional", "must be true");
	}
	let afterArchitectReceiptArtifactSha256: string | null;
	if (value.role === "architect") {
		if (value.afterArchitectReceiptArtifactSha256 !== null) {
			fail(
				"authority.afterArchitectReceiptArtifactSha256",
				"must be null for Architect",
			);
		}
		afterArchitectReceiptArtifactSha256 = null;
	} else {
		afterArchitectReceiptArtifactSha256 = requireSha256(
			value.afterArchitectReceiptArtifactSha256,
			"authority.afterArchitectReceiptArtifactSha256",
		);
	}
	return {
		semanticFreezeAuthoritySha256: requireSha256(
			value.semanticFreezeAuthoritySha256,
			"authority.semanticFreezeAuthoritySha256",
		),
		role: value.role,
		verdict: "APPROVE",
		unconditional: true,
		afterArchitectReceiptArtifactSha256,
	};
}

function validateApprovalParty(
	value: unknown,
	path: string,
	critic: boolean,
):
	| SemanticApprovalAuthority["architect"]
	| SemanticApprovalAuthority["critic"] {
	if (!isRecord(value)) fail(path, "must be an object");
	const keys = [
		"verdict",
		"unconditional",
		"receiptPath",
		"receiptArtifactSha256",
	];
	if (critic) keys.push("afterArchitectReceiptArtifactSha256");
	requireExactKeys(value, keys, path);
	if (value.verdict !== "APPROVE") fail(`${path}.verdict`, "must be APPROVE");
	if (value.unconditional !== true)
		fail(`${path}.unconditional`, "must be true");
	const base = {
		verdict: "APPROVE" as const,
		unconditional: true as const,
		receiptPath: requirePortablePath(value.receiptPath, `${path}.receiptPath`),
		receiptArtifactSha256: requireSha256(
			value.receiptArtifactSha256,
			`${path}.receiptArtifactSha256`,
		),
	};
	if (!critic) return base;
	return {
		...base,
		afterArchitectReceiptArtifactSha256: requireSha256(
			value.afterArchitectReceiptArtifactSha256,
			`${path}.afterArchitectReceiptArtifactSha256`,
		),
	};
}

function validateSemanticApprovalAuthority(
	value: unknown,
): SemanticApprovalAuthority {
	if (!isRecord(value)) fail("authority", "must be an object");
	requireExactKeys(
		value,
		["semanticFreezeAuthoritySha256", "architect", "critic"],
		"authority",
	);
	return {
		semanticFreezeAuthoritySha256: requireSha256(
			value.semanticFreezeAuthoritySha256,
			"authority.semanticFreezeAuthoritySha256",
		),
		architect: validateApprovalParty(
			value.architect,
			"authority.architect",
			false,
		) as SemanticApprovalAuthority["architect"],
		critic: validateApprovalParty(
			value.critic,
			"authority.critic",
			true,
		) as SemanticApprovalAuthority["critic"],
	};
}

function validateAuthorityArtifactIdentity(
	value: unknown,
	path: string,
): AuthorityArtifactIdentity {
	if (!isRecord(value)) fail(path, "must be an object");
	requireExactKeys(value, ["path", "authoritySha256", "artifactSha256"], path);
	return {
		path: requirePortablePath(value.path, `${path}.path`),
		authoritySha256: requireSha256(
			value.authoritySha256,
			`${path}.authoritySha256`,
		),
		artifactSha256: requireSha256(
			value.artifactSha256,
			`${path}.artifactSha256`,
		),
	};
}

function requirePositiveInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 1) {
		fail(path, "must be a positive safe integer");
	}
	return Number(value);
}

function requireNonnegativeInteger(value: unknown, path: string): number {
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		fail(path, "must be a nonnegative safe integer");
	}
	return Number(value);
}

function requireIpv4(value: unknown, path: string): string {
	const checked = requireNonemptyString(value, path);
	const parts = checked.split(".");
	if (
		parts.length !== 4 ||
		parts.some(
			(part) => !/^(?:0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255,
		)
	) {
		fail(path, "must be a canonical IPv4 address");
	}
	return checked;
}

function requireAbsolutePath(value: unknown, path: string): string {
	const checked = requireNonemptyString(value, path);
	if (
		!checked.startsWith("/") ||
		checked.includes("\\") ||
		checked.includes("//") ||
		checked
			.split("/")
			.slice(1)
			.some((part) => part === "" || part === "." || part === "..")
	) {
		fail(path, "must be a normalized absolute POSIX path");
	}
	return checked;
}

function validateHostProviderIdentity(
	value: unknown,
	path: string,
): HostProviderIdentity {
	if (!isRecord(value)) fail(path, "must be an object");
	requireExactKeys(
		value,
		[
			"id",
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
		path,
	);
	if (!Array.isArray(value.tags) || value.tags.length < 2) {
		fail(`${path}.tags`, "must contain management and run tags");
	}
	const tags = value.tags.map((entry, index) =>
		requireNonemptyString(entry, `${path}.tags[${index}]`),
	);
	if (new Set(tags).size !== tags.length) {
		fail(`${path}.tags`, "must be unique");
	}
	if (!Array.isArray(value.sshKeyIds) || value.sshKeyIds.length === 0) {
		fail(`${path}.sshKeyIds`, "must be a nonempty array");
	}
	const sshKeyIds = value.sshKeyIds.map((entry, index) =>
		requirePositiveInteger(entry, `${path}.sshKeyIds[${index}]`),
	);
	if (new Set(sshKeyIds).size !== sshKeyIds.length) {
		fail(`${path}.sshKeyIds`, "must be unique");
	}
	return {
		id: requirePositiveInteger(value.id, `${path}.id`),
		name: requireNonemptyString(value.name, `${path}.name`),
		tags,
		region: requireNonemptyString(value.region, `${path}.region`),
		size: requireNonemptyString(value.size, `${path}.size`),
		image: requireNonemptyString(value.image, `${path}.image`),
		vpcUuid: requireNonemptyString(value.vpcUuid, `${path}.vpcUuid`),
		projectId:
			value.projectId === null
				? null
				: requireNonemptyString(value.projectId, `${path}.projectId`),
		sshKeyIds,
		vcpus: requirePositiveInteger(value.vcpus, `${path}.vcpus`),
		memoryMiB: requirePositiveInteger(value.memoryMiB, `${path}.memoryMiB`),
		status: requireNonemptyString(value.status, `${path}.status`),
		createdAt: validateRfc3339Millis(value.createdAt, `${path}.createdAt`),
		publicIpv4: requireIpv4(value.publicIpv4, `${path}.publicIpv4`),
		privateIpv4: requireIpv4(value.privateIpv4, `${path}.privateIpv4`),
	};
}

function validateHostBindingHost(
	value: unknown,
	path: string,
	expectedRole: "server" | "generator",
): HostBindingHost {
	if (!isRecord(value)) fail(path, "must be an object");
	requireExactKeys(
		value,
		[
			"role",
			"provider",
			"bootId",
			"source",
			"runtime",
			"binary",
			"identityPacket",
			"identityOperationReceipt",
		],
		path,
	);
	if (value.role !== expectedRole) {
		fail(`${path}.role`, `must be ${expectedRole}`);
	}
	if (
		typeof value.bootId !== "string" ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
			value.bootId,
		)
	) {
		fail(`${path}.bootId`, "must be a lowercase UUID");
	}
	if (!isRecord(value.source)) fail(`${path}.source`, "must be an object");
	requireExactKeys(value.source, ["commit", "tree"], `${path}.source`);
	if (!isRecord(value.runtime)) fail(`${path}.runtime`, "must be an object");
	requireExactKeys(
		value.runtime,
		["os", "osRelease", "kernel", "bunVersion", "rustcVersion", "cargoVersion"],
		`${path}.runtime`,
	);
	if (!isRecord(value.binary)) fail(`${path}.binary`, "must be an object");
	requireExactKeys(value.binary, ["kind", "path", "sha256"], `${path}.binary`);
	const expectedKind =
		expectedRole === "server" ? "native-addon" : "mmo-client";
	if (value.binary.kind !== expectedKind) {
		fail(`${path}.binary.kind`, `must be ${expectedKind}`);
	}
	return {
		role: expectedRole,
		provider: validateHostProviderIdentity(value.provider, `${path}.provider`),
		bootId: value.bootId,
		source: {
			commit: requireGitSha1(value.source.commit, `${path}.source.commit`),
			tree: requireGitSha1(value.source.tree, `${path}.source.tree`),
		},
		runtime: {
			os: requireNonemptyString(value.runtime.os, `${path}.runtime.os`),
			osRelease: requireNonemptyString(
				value.runtime.osRelease,
				`${path}.runtime.osRelease`,
			),
			kernel: requireNonemptyString(
				value.runtime.kernel,
				`${path}.runtime.kernel`,
			),
			bunVersion: requireNonemptyString(
				value.runtime.bunVersion,
				`${path}.runtime.bunVersion`,
			),
			rustcVersion: requireNonemptyString(
				value.runtime.rustcVersion,
				`${path}.runtime.rustcVersion`,
			),
			cargoVersion: requireNonemptyString(
				value.runtime.cargoVersion,
				`${path}.runtime.cargoVersion`,
			),
		},
		binary: {
			kind: expectedKind,
			path: requireAbsolutePath(value.binary.path, `${path}.binary.path`),
			sha256: requireSha256(value.binary.sha256, `${path}.binary.sha256`),
		},
		identityPacket: validateArtifactIdentity(
			value.identityPacket,
			`${path}.identityPacket`,
		),
		identityOperationReceipt: validateArtifactIdentity(
			value.identityOperationReceipt,
			`${path}.identityOperationReceipt`,
		),
	};
}

function validateHostBindingGateReference(
	value: unknown,
	index: number,
): HostBindingGateReference {
	const path = `authority.gates.receipts[${index}]`;
	if (!isRecord(value)) fail(path, "must be an object");
	requireExactKeys(value, ["id", "phase", "receipt", "operationReceipt"], path);
	if (value.phase !== "LOCAL" && value.phase !== "PREPARED_HOST") {
		fail(`${path}.phase`, "must be LOCAL or PREPARED_HOST");
	}
	return {
		id: requireNonemptyString(value.id, `${path}.id`),
		phase: value.phase,
		receipt: validateArtifactIdentity(value.receipt, `${path}.receipt`),
		operationReceipt: validateArtifactIdentity(
			value.operationReceipt,
			`${path}.operationReceipt`,
		),
	};
}

function validateHostBindingAuthority(value: unknown): HostBindingAuthority {
	if (!isRecord(value)) fail("authority", "must be an object");
	requireExactKeys(
		value,
		[
			"semantic",
			"rigJournal",
			"knownHosts",
			"preparationReceipt",
			"bundle",
			"retainedBinaries",
			"hosts",
			"gates",
		],
		"authority",
	);
	if (!isRecord(value.semantic))
		fail("authority.semantic", "must be an object");
	requireExactKeys(
		value.semantic,
		["freeze", "approval", "architectReceipt", "criticReceipt"],
		"authority.semantic",
	);
	if (!isRecord(value.knownHosts)) {
		fail("authority.knownHosts", "must be an object");
	}
	requireExactKeys(
		value.knownHosts,
		["file", "receipt"],
		"authority.knownHosts",
	);
	if (!isRecord(value.retainedBinaries)) {
		fail("authority.retainedBinaries", "must be an object");
	}
	requireExactKeys(
		value.retainedBinaries,
		["nativeAddon", "generator"],
		"authority.retainedBinaries",
	);
	if (!isRecord(value.hosts)) fail("authority.hosts", "must be an object");
	requireExactKeys(value.hosts, ["server", "generator"], "authority.hosts");
	if (!isRecord(value.gates)) fail("authority.gates", "must be an object");
	requireExactKeys(
		value.gates,
		["catalogAuthoritySha256", "receipts"],
		"authority.gates",
	);
	if (
		!Array.isArray(value.gates.receipts) ||
		value.gates.receipts.length === 0
	) {
		fail("authority.gates.receipts", "must be a nonempty array");
	}
	const gates = value.gates.receipts.map(validateHostBindingGateReference);
	if (new Set(gates.map(({ id }) => id)).size !== gates.length) {
		fail("authority.gates.receipts", "gate IDs must be unique");
	}
	const server = validateHostBindingHost(
		value.hosts.server,
		"authority.hosts.server",
		"server",
	);
	const generator = validateHostBindingHost(
		value.hosts.generator,
		"authority.hosts.generator",
		"generator",
	);
	if (
		server.provider.id === generator.provider.id ||
		server.provider.publicIpv4 === generator.provider.publicIpv4 ||
		server.provider.privateIpv4 === generator.provider.privateIpv4 ||
		server.bootId === generator.bootId
	) {
		fail("authority.hosts", "exact host identities must be distinct");
	}
	if (
		server.source.commit !== generator.source.commit ||
		server.source.tree !== generator.source.tree
	) {
		fail("authority.hosts", "source commit/tree must match across the pair");
	}
	return {
		semantic: {
			freeze: validateAuthorityArtifactIdentity(
				value.semantic.freeze,
				"authority.semantic.freeze",
			),
			approval: validateAuthorityArtifactIdentity(
				value.semantic.approval,
				"authority.semantic.approval",
			),
			architectReceipt: validateArtifactIdentity(
				value.semantic.architectReceipt,
				"authority.semantic.architectReceipt",
			),
			criticReceipt: validateArtifactIdentity(
				value.semantic.criticReceipt,
				"authority.semantic.criticReceipt",
			),
		},
		rigJournal: validateArtifactIdentity(
			value.rigJournal,
			"authority.rigJournal",
		),
		knownHosts: {
			file: validateArtifactIdentity(
				value.knownHosts.file,
				"authority.knownHosts.file",
			),
			receipt: validateArtifactIdentity(
				value.knownHosts.receipt,
				"authority.knownHosts.receipt",
			),
		},
		preparationReceipt: validateArtifactIdentity(
			value.preparationReceipt,
			"authority.preparationReceipt",
		),
		bundle: validateArtifactIdentity(value.bundle, "authority.bundle"),
		retainedBinaries: {
			nativeAddon: validateArtifactIdentity(
				value.retainedBinaries.nativeAddon,
				"authority.retainedBinaries.nativeAddon",
			),
			generator: validateArtifactIdentity(
				value.retainedBinaries.generator,
				"authority.retainedBinaries.generator",
			),
		},
		hosts: { server, generator },
		gates: {
			catalogAuthoritySha256: requireSha256(
				value.gates.catalogAuthoritySha256,
				"authority.gates.catalogAuthoritySha256",
			),
			receipts: gates,
		},
	};
}

function validateDispatchFreezeAuthority(
	value: unknown,
): DispatchFreezeAuthority {
	if (!isRecord(value)) fail("authority", "must be an object");
	requireExactKeys(
		value,
		["semanticFreeze", "semanticApproval", "hostBinding", "views"],
		"authority",
	);
	if (!isRecord(value.views)) fail("authority.views", "must be an object");
	requireExactKeys(
		value.views,
		["registration", "runbook", "exactIdentity"],
		"authority.views",
	);
	return {
		semanticFreeze: validateAuthorityArtifactIdentity(
			value.semanticFreeze,
			"authority.semanticFreeze",
		),
		semanticApproval: validateAuthorityArtifactIdentity(
			value.semanticApproval,
			"authority.semanticApproval",
		),
		hostBinding: validateAuthorityArtifactIdentity(
			value.hostBinding,
			"authority.hostBinding",
		),
		views: {
			registration: validateArtifactIdentity(
				value.views.registration,
				"authority.views.registration",
			),
			runbook: validateArtifactIdentity(
				value.views.runbook,
				"authority.views.runbook",
			),
			exactIdentity: validateArtifactIdentity(
				value.views.exactIdentity,
				"authority.views.exactIdentity",
			),
		},
	};
}

function validateOperationAction(value: unknown): OperationReceipt["action"] {
	if (!isRecord(value)) fail("action", "must be an object");
	requireExactKeys(
		value,
		["command", "args", "cwd", "environmentKeys"],
		"action",
	);
	const cwd = requireCommandValue(value.cwd, "action.cwd");
	if (
		cwd !== "." &&
		(cwd.startsWith("/") ||
			cwd.includes("\\") ||
			cwd
				.split("/")
				.some((part) => part === "" || part === "." || part === ".."))
	) {
		fail("action.cwd", "must be '.' or a portable repository-relative path");
	}
	const environmentKeys = requireStringArray(
		value.environmentKeys,
		"action.environmentKeys",
	);
	if (
		new Set(environmentKeys).size !== environmentKeys.length ||
		environmentKeys.some((key) => !/^[A-Z_][A-Z0-9_]*$/.test(key))
	) {
		fail("action.environmentKeys", "must be unique environment names");
	}
	return {
		command: requireCommandValue(value.command, "action.command"),
		args: requireStringArray(value.args, "action.args"),
		cwd,
		environmentKeys,
	};
}

function validateOperationStatus(value: unknown): OperationReceipt["status"] {
	if (!isRecord(value)) fail("status", "must be an object");
	requireExactKeys(value, ["outcome", "exitCode", "signal"], "status");
	if (
		value.outcome !== "SUCCEEDED" &&
		value.outcome !== "FAILED" &&
		value.outcome !== "TIMED_OUT" &&
		value.outcome !== "CANCELLED"
	) {
		fail("status.outcome", "is not recognized");
	}
	if (
		value.exitCode !== null &&
		(!Number.isSafeInteger(value.exitCode) || (value.exitCode as number) < 0)
	) {
		fail("status.exitCode", "must be null or a nonnegative safe integer");
	}
	if (value.signal !== null && typeof value.signal !== "string") {
		fail("status.signal", "must be null or a string");
	}
	if (value.outcome === "SUCCEEDED" && value.exitCode !== 0) {
		fail("status.exitCode", "must be zero for SUCCEEDED");
	}
	if (value.outcome !== "SUCCEEDED" && value.exitCode === 0) {
		fail("status.exitCode", "must not be zero for a non-success outcome");
	}
	return {
		outcome: value.outcome,
		exitCode: value.exitCode as number | null,
		signal: value.signal as string | null,
	};
}

function validateRemoteTiming(
	value: unknown,
): OperationReceipt["remoteTiming"] {
	if (value === null) return null;
	if (!isRecord(value)) fail("remoteTiming", "must be null or an object");
	requireExactKeys(
		value,
		["requestStartedAt", "responseFinishedAt", "observationAt"],
		"remoteTiming",
	);
	const requestStartedAt = validateRfc3339Millis(
		value.requestStartedAt,
		"remoteTiming.requestStartedAt",
	);
	const responseFinishedAt = validateRfc3339Millis(
		value.responseFinishedAt,
		"remoteTiming.responseFinishedAt",
	);
	if (Date.parse(responseFinishedAt) < Date.parse(requestStartedAt)) {
		fail("remoteTiming", "response must not precede request");
	}
	return {
		requestStartedAt,
		responseFinishedAt,
		observationAt:
			value.observationAt === null
				? null
				: validateRfc3339Millis(
						value.observationAt,
						"remoteTiming.observationAt",
					),
	};
}

export function validateRfc3339Millis(value: unknown, path: string): string {
	if (typeof value !== "string" || !RFC3339_MILLIS_RE.test(value)) {
		fail(path, "must be RFC 3339 UTC with millisecond precision");
	}
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
		fail(path, "must be a real UTC instant");
	}
	return value;
}

export function validateEnvelope(value: unknown): RecordEnvelope {
	if (!isRecord(value)) fail("envelope", "must be an object");
	requireExactKeys(
		value,
		["recordedAt", "sequence", "runId", "phase", "operationId", "clockSource"],
		"envelope",
	);
	const sequence = value.sequence;
	if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
		fail("envelope.sequence", "must be a positive safe integer");
	}
	if (!CLOCK_SOURCES.has(value.clockSource as ClockSource)) {
		fail("envelope.clockSource", "is not recognized");
	}
	return {
		recordedAt: validateRfc3339Millis(value.recordedAt, "envelope.recordedAt"),
		sequence: sequence as number,
		runId: requireNonemptyString(value.runId, "envelope.runId"),
		phase: requireNonemptyString(value.phase, "envelope.phase"),
		operationId: requireNonemptyString(
			value.operationId,
			"envelope.operationId",
		),
		clockSource: value.clockSource as ClockSource,
	};
}

export function makeAuthorityRecord<S extends string, A>(
	schema: S,
	envelope: RecordEnvelope,
	authority: A,
): AuthorityRecord<S, A> {
	requireNonemptyString(schema, "schema");
	const checkedEnvelope = validateEnvelope(envelope);
	const authoritySha256 = canonicalAuthoritySha256(authority);
	if (!HASH_RE.test(authoritySha256)) fail("authoritySha256", "is malformed");
	return {
		schema,
		envelope: checkedEnvelope,
		authoritySha256,
		authority,
	};
}

export function validateSemanticFreezeRecord(
	value: unknown,
): SemanticFreezeRecord {
	return validateAuthorityRecord(
		value,
		"g6-c32-semantic-freeze/1",
		validateSemanticFreezeAuthority,
	);
}

export function validateReviewReceipt(value: unknown): ReviewReceiptRecord {
	return validateAuthorityRecord(
		value,
		"g6-c32-review-receipt/1",
		validateReviewAuthority,
	);
}

export function validateSemanticApprovalRecord(
	value: unknown,
): SemanticApprovalRecord {
	return validateAuthorityRecord(
		value,
		"g6-c32-semantic-approval/1",
		validateSemanticApprovalAuthority,
	);
}

export function makeHostBindingRecord(
	envelope: RecordEnvelope,
	authority: HostBindingAuthority,
): HostBindingRecord {
	return validateHostBindingRecord(
		makeAuthorityRecord("g6-c32-host-binding/1", envelope, authority),
	);
}

export function validateHostBindingRecord(value: unknown): HostBindingRecord {
	return validateAuthorityRecord(
		value,
		"g6-c32-host-binding/1",
		validateHostBindingAuthority,
	);
}

export function makeDispatchFreezeRecord(
	envelope: RecordEnvelope,
	authority: DispatchFreezeAuthority,
): DispatchFreezeRecord {
	return validateDispatchFreezeRecord(
		makeAuthorityRecord("g6-c32-dispatch-freeze/1", envelope, authority),
	);
}

export function validateDispatchFreezeRecord(
	value: unknown,
): DispatchFreezeRecord {
	return validateAuthorityRecord(
		value,
		"g6-c32-dispatch-freeze/1",
		validateDispatchFreezeAuthority,
	);
}

export function validateOperationReceipt(value: unknown): OperationReceipt {
	if (!isRecord(value)) fail("operationReceipt", "must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"envelope",
			"startedAt",
			"finishedAt",
			"durationMonotonicNs",
			"attempt",
			"action",
			"status",
			"stdoutPath",
			"stderrPath",
			"remoteTiming",
		],
		"operationReceipt",
	);
	if (value.schema !== "g6-c32-operation-receipt/1") {
		fail("schema", "must equal g6-c32-operation-receipt/1");
	}
	const startedAt = validateRfc3339Millis(value.startedAt, "startedAt");
	const finishedAt = validateRfc3339Millis(value.finishedAt, "finishedAt");
	if (Date.parse(finishedAt) < Date.parse(startedAt)) {
		fail("finishedAt", "must not precede startedAt");
	}
	if (
		typeof value.durationMonotonicNs !== "string" ||
		!/^(?:0|[1-9]\d*)$/.test(value.durationMonotonicNs)
	) {
		fail("durationMonotonicNs", "must be a nonnegative decimal integer string");
	}
	if (!Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1) {
		fail("attempt", "must be a positive safe integer");
	}
	return {
		schema: "g6-c32-operation-receipt/1",
		envelope: validateEnvelope(value.envelope),
		startedAt,
		finishedAt,
		durationMonotonicNs: value.durationMonotonicNs,
		attempt: value.attempt as number,
		action: validateOperationAction(value.action),
		status: validateOperationStatus(value.status),
		stdoutPath: requirePortablePath(value.stdoutPath, "stdoutPath"),
		stderrPath: requirePortablePath(value.stderrPath, "stderrPath"),
		remoteTiming: validateRemoteTiming(value.remoteTiming),
	};
}

export function validateRecordSequence(
	values: readonly unknown[],
): RecordEnvelope[] {
	const envelopes = values.map((value) => validateEnvelope(value));
	for (let index = 1; index < envelopes.length; index += 1) {
		const previous = envelopes[index - 1];
		const current = envelopes[index];
		if (!previous || !current || current.sequence <= previous.sequence) {
			fail(`envelopes[${index}].sequence`, "must strictly increase");
		}
		if (current.runId !== previous.runId) {
			fail(`envelopes[${index}].runId`, "must remain constant within a stream");
		}
	}
	return envelopes;
}

export function validateDeadline(
	requestedAt: unknown,
	deadline: unknown,
): string {
	const requested = validateRfc3339Millis(requestedAt, "requestedAt");
	const checkedDeadline = validateRfc3339Millis(deadline, "deadline");
	if (Date.parse(checkedDeadline) <= Date.parse(requested)) {
		fail("deadline", "must be later than requestedAt");
	}
	return checkedDeadline;
}

export function shellQuote(value: string): string {
	if (typeof value !== "string" || value.includes("\0")) {
		fail("shellValue", "must be a NUL-free string");
	}
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function makeArtifactManifestRecord(
	envelope: RecordEnvelope,
	entries: readonly ArtifactManifestEntry[],
): ArtifactManifestRecord {
	return validateArtifactManifestRecord({
		schema: "g6-c32-artifact-manifest/1",
		envelope,
		entries: [...entries],
	});
}

export function validateArtifactManifestRecord(
	value: unknown,
): ArtifactManifestRecord {
	if (!isRecord(value)) fail("artifactManifest", "must be an object");
	requireExactKeys(
		value,
		["schema", "envelope", "entries"],
		"artifactManifest",
	);
	if (value.schema !== "g6-c32-artifact-manifest/1") {
		fail("artifactManifest.schema", "must equal g6-c32-artifact-manifest/1");
	}
	const envelope = validateEnvelope(value.envelope);
	const identifiesBindingManifest =
		envelope.phase === "BINDING" &&
		envelope.operationId === "artifact-manifest";
	const identifiesFinalSealManifest =
		envelope.phase === "FINAL" &&
		envelope.operationId === "offrunner-artifact-manifest";
	if (
		envelope.clockSource !== "offrunner" ||
		(!identifiesBindingManifest && !identifiesFinalSealManifest)
	) {
		fail("artifactManifest.envelope", "does not identify an allowed manifest");
	}
	if (!Array.isArray(value.entries) || value.entries.length === 0) {
		fail("artifactManifest.entries", "must be a nonempty array");
	}
	const forbidden = new Set([
		"SHA256SUMS",
		"RUN_STATUS",
		"artifact-manifest.json",
	]);
	const entries = value.entries.map((entry, index): ArtifactManifestEntry => {
		const path = `artifactManifest.entries[${index}]`;
		if (!isRecord(entry)) fail(path, "must be an object");
		requireExactKeys(entry, ["path", "sha256", "bytes", "recordedAt"], path);
		const artifactPath = requirePortablePath(entry.path, `${path}.path`);
		if (forbidden.has(artifactPath)) {
			fail(`${path}.path`, "manifest control files must be excluded");
		}
		return {
			path: artifactPath,
			sha256: requireSha256(entry.sha256, `${path}.sha256`),
			bytes: requireNonnegativeInteger(entry.bytes, `${path}.bytes`),
			recordedAt: validateRfc3339Millis(entry.recordedAt, `${path}.recordedAt`),
		};
	});
	if (new Set(entries.map(({ path }) => path)).size !== entries.length) {
		fail("artifactManifest.entries", "paths must be unique");
	}
	const paths = entries.map(({ path }) => path);
	if (
		paths.some((path, index) => index > 0 && path <= (paths[index - 1] ?? ""))
	) {
		fail("artifactManifest.entries", "paths must be strictly sorted");
	}
	return {
		schema: "g6-c32-artifact-manifest/1",
		envelope,
		entries,
	};
}

function validateGeneratedViewContext(
	value: GeneratedViewContext,
): GeneratedViewContext {
	const recordedAt = validateRfc3339Millis(value.recordedAt, "view.recordedAt");
	const runId = requireNonemptyString(value.runId, "view.runId");
	const controllerPath = requirePortablePath(
		value.controllerPath,
		"view.controllerPath",
	);
	const hostBinding = validateHostBindingRecord(value.hostBinding);
	const semanticFreezeArtifactSha256 = requireSha256(
		value.semanticFreezeArtifactSha256,
		"view.semanticFreezeArtifactSha256",
	);
	const semanticApprovalArtifactSha256 = requireSha256(
		value.semanticApprovalArtifactSha256,
		"view.semanticApprovalArtifactSha256",
	);
	const hostBindingArtifactSha256 = requireSha256(
		value.hostBindingArtifactSha256,
		"view.hostBindingArtifactSha256",
	);
	if (
		semanticFreezeArtifactSha256 !==
			hostBinding.authority.semantic.freeze.artifactSha256 ||
		semanticApprovalArtifactSha256 !==
			hostBinding.authority.semantic.approval.artifactSha256 ||
		hostBindingArtifactSha256 !== canonicalArtifactSha256(hostBinding) ||
		hostBinding.envelope.runId !== runId
	) {
		fail("view", "input digest graph does not match the host binding");
	}
	return {
		recordedAt,
		runId,
		controllerPath,
		semanticFreezeArtifactSha256,
		semanticApprovalArtifactSha256,
		hostBindingArtifactSha256,
		hostBinding,
	};
}

function viewDigestLines(context: GeneratedViewContext): string[] {
	return [
		`- Semantic freeze artifact SHA-256: \`${context.semanticFreezeArtifactSha256}\``,
		`- Semantic approval artifact SHA-256: \`${context.semanticApprovalArtifactSha256}\``,
		`- Host binding artifact SHA-256: \`${context.hostBindingArtifactSha256}\``,
	];
}

function hostTable(context: GeneratedViewContext): string[] {
	const { server, generator } = context.hostBinding.authority.hosts;
	return [
		"| Role | Droplet ID | Name | Public IPv4 | Private IPv4 | Boot ID | Binary SHA-256 |",
		"| --- | ---: | --- | --- | --- | --- | --- |",
		`| server | ${server.provider.id} | ${server.provider.name} | ${server.provider.publicIpv4} | ${server.provider.privateIpv4} | ${server.bootId} | ${server.binary.sha256} |`,
		`| generator | ${generator.provider.id} | ${generator.provider.name} | ${generator.provider.publicIpv4} | ${generator.provider.privateIpv4} | ${generator.bootId} | ${generator.binary.sha256} |`,
	];
}

function lifecyclePolicyLines(): string[] {
	return [
		"Semantic changes receive sequential, unconditional Architect then Critic approval before provisioning. Only semantic-authority drift restarts that review sequence.",
		"A host-only rebind, including a host, boot, address, or rebuilt-binary change from the approved source, does not restart Architect or Critic review; the new identity is rebound and requalified automatically.",
		"Exact-zero and exact-two reconciliation is deterministic. Partial journal-owned creation is cleaned and retried once. Create-response crash recovery uses durable intent recorded before create. Unknown resources stop the lifecycle without mutation.",
		"Deadline, cancellation, and terminal paths seal available evidence and tear down only exact-owned IDs. Every operation and every persisted record is timestamped.",
	];
}

export function renderRegistration(input: GeneratedViewContext): string {
	const context = validateGeneratedViewContext(input);
	return [
		"# G6 c-32 campaign registration",
		"",
		`Recorded at: ${context.recordedAt}`,
		`Run ID: \`${context.runId}\``,
		"",
		"## Bound inputs",
		"",
		...viewDigestLines(context),
		"",
		"## Exact prepared pair",
		"",
		...hostTable(context),
		"",
		"## Lifecycle policy",
		"",
		...lifecyclePolicyLines(),
		"",
		"This registration is a generated view. Machine authority remains in the bound JSON records and their complete manifest.",
		"",
	].join("\n");
}

export function renderRunbook(input: GeneratedViewContext): string {
	const context = validateGeneratedViewContext(input);
	return [
		"# G6 c-32 automated operator runbook",
		"",
		`Recorded at: ${context.recordedAt}`,
		`Run ID: \`${context.runId}\``,
		"",
		"## Bound inputs",
		"",
		...viewDigestLines(context),
		"",
		"## One-command lifecycle",
		"",
		"```bash",
		"bun run g6:c32:campaign -- run \\",
		"  --semantic-freeze <path> \\",
		"  --semantic-approval <path> \\",
		"  --deadline <RFC3339-UTC>",
		"```",
		"",
		`The checked-in controller is \`${context.controllerPath}\`. Markdown is documentation only and is never executed.`,
		"",
		"## Lifecycle policy",
		"",
		...lifecyclePolicyLines(),
		"",
	].join("\n");
}

export function renderExactIdentitySheet(input: GeneratedViewContext): string {
	const context = validateGeneratedViewContext(input);
	const authority = context.hostBinding.authority;
	const gateLines = authority.gates.receipts.map(
		(reference) =>
			`- ${reference.id} (${reference.phase}): \`${reference.receipt.sha256}\``,
	);
	return [
		"# G6 c-32 exact identity sheet",
		"",
		`Recorded at: ${context.recordedAt}`,
		`Run ID: \`${context.runId}\``,
		"",
		"## Bound input digests",
		"",
		...viewDigestLines(context),
		`- Known hosts SHA-256: \`${authority.knownHosts.file.sha256}\``,
		`- Candidate bundle SHA-256: \`${authority.bundle.sha256}\``,
		`- Native addon SHA-256: \`${authority.retainedBinaries.nativeAddon.sha256}\``,
		`- Generator SHA-256: \`${authority.retainedBinaries.generator.sha256}\``,
		"",
		"## Exact prepared pair",
		"",
		...hostTable(context),
		"",
		"## Gate receipt digests",
		"",
		...gateLines,
		"",
	].join("\n");
}
