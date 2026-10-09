import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { canonicalGeneratorIdentity } from "../offbox/host-identity.ts";
import { G6_CLOSEOUT_SPEC_ID, G6_CLOSEOUT_SPEC_PATH } from "./g6-plan.ts";

export const G6_BUNDLE_SCHEMA = "g6-evidence-bundle/1" as const;
export const G6_BUNDLE_METADATA = "bundle-manifest.json" as const;
export const G6_BUNDLE_SUMS = "SHA256SUMS" as const;

export const G6_SUCCESSOR_PREREGISTRATION_ID = G6_CLOSEOUT_SPEC_ID;
export const G6_SUCCESSOR_PREREGISTRATION_PATH = G6_CLOSEOUT_SPEC_PATH;
export const G6_SUCCESSOR_REGISTRATION_ID = "g6-mmo-04-closeout/1" as const;
export const G6_SUCCESSOR_REGISTRATION_PATH =
	"bare-metal-campaign/registrations/g6-mmo-04-closeout.md" as const;

// The ack reflector kill gate binds its evidence to the c-32 RCA closure
// registration rather than the MMO-04 closeout one.
export const G6_ACK_REFLECTOR_REGISTRATION_ID =
	"g6-c32-rca-closure-01/1" as const;

export type G6BundleKind = "full-g6" | "attribution" | "ack-reflector-gate";
export type G6BundleStatus = "COMPLETE" | "INVALID" | "ABORTED";
export type G6BundleFileRole =
	| "bundle-metadata"
	| "sha256sums"
	| "preregistration-copy"
	| "registration-copy"
	| "host-identity"
	| "source-identity"
	| "g6-json"
	| "g6-csv"
	| "realm-report"
	| "realm-log"
	| "subscriber-report"
	| "subscriber-log"
	| "publisher-report"
	| "publisher-log"
	| "preflight-down"
	| "preflight-up"
	| "floor"
	| "sink"
	| "classified"
	| "profiles"
	| "profile"
	| "comparison"
	| "attribution-aggregate"
	| "attribution-leg"
	| "attribution-raw-client"
	| "attribution-raw-server"
	| "partial-json"
	| "partial-log"
	| "mechanism-ticket";

export type G6SourceIdentity = {
	id: string;
	path: string;
	sha256: string;
};

export type G6BundleFileInput = {
	path: string;
	role: G6BundleFileRole;
	leg?: number;
};

export type G6BundleFile = G6BundleFileInput & {
	sha256: string | null;
};

export type G6BundleMetadata = {
	schema: typeof G6_BUNDLE_SCHEMA;
	kind: G6BundleKind;
	status: G6BundleStatus;
	stampable: boolean;
	identity: {
		candidateSha: string;
		preRegistration: G6SourceIdentity;
		registration: G6SourceIdentity;
	};
	files: G6BundleFile[];
};

export type G6ManifestWriteOptions = {
	bundleDir: string;
	kind: G6BundleKind;
	status: G6BundleStatus;
	candidateSha: string;
	preRegistration: G6SourceIdentity;
	registration: G6SourceIdentity;
	files: G6BundleFileInput[];
};

export type G6ManifestExpectations = {
	candidateSha: string;
	preRegistrationSha256: string;
	registrationSha256: string;
};

export type G6ManifestVerification = {
	kind: G6BundleKind;
	status: G6BundleStatus;
	stampable: boolean;
	fileCount: number;
};

type JsonObject = Record<string, unknown>;

const HASH_RE = /^[0-9a-f]{64}$/;
const CANDIDATE_RE = /^[0-9a-f]{40}$/;
const ALLOWED_ROLES = new Set<G6BundleFileRole>([
	"bundle-metadata",
	"sha256sums",
	"preregistration-copy",
	"registration-copy",
	"host-identity",
	"source-identity",
	"g6-json",
	"g6-csv",
	"realm-report",
	"realm-log",
	"subscriber-report",
	"subscriber-log",
	"publisher-report",
	"publisher-log",
	"preflight-down",
	"preflight-up",
	"floor",
	"sink",
	"classified",
	"profiles",
	"profile",
	"comparison",
	"attribution-aggregate",
	"attribution-leg",
	"attribution-raw-client",
	"attribution-raw-server",
	"partial-json",
	"partial-log",
	"mechanism-ticket",
]);
const BASE_REQUIRED_ROLES: G6BundleFileRole[] = [
	"preregistration-copy",
	"registration-copy",
	"host-identity",
	"source-identity",
];
const FULL_G6_REQUIRED_ROLES: G6BundleFileRole[] = [
	"g6-json",
	"g6-csv",
	"realm-report",
	"realm-log",
	"subscriber-report",
	"subscriber-log",
	"publisher-report",
	"publisher-log",
	"preflight-down",
	"preflight-up",
	"floor",
	"sink",
	"classified",
	"profiles",
	"comparison",
];
const ATTRIBUTION_REQUIRED_ROLES: G6BundleFileRole[] = [
	"attribution-aggregate",
	"comparison",
	"profiles",
];
const FULL_G6_EXTERNAL_ROLES: G6BundleFileRole[] = [
	"preflight-down",
	"preflight-up",
	"floor",
	"sink",
];
const CLASSIFIED_INPUT_ROLES = [
	["artifactJson", "g6-json"],
	["artifactCsv", "g6-csv"],
	["preflightDown", "preflight-down"],
	["preflightUp", "preflight-up"],
	["floor", "floor"],
	["sink", "sink"],
] as const satisfies ReadonlyArray<readonly [string, G6BundleFileRole]>;

export function createG6EvidenceDirectory(path: string): void {
	if (existsSync(path)) {
		throw new Error(`g6-manifest: evidence directory already exists: ${path}`);
	}
	mkdirSync(path);
}

function sha256Bytes(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
	return sha256Bytes(readFileSync(path));
}

function requirePortablePath(path: string): void {
	if (
		path.length === 0 ||
		isAbsolute(path) ||
		path.includes("\\") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	) {
		throw new Error(`g6-manifest: non-portable path '${path}'`);
	}
}

function comparePath(a: { path: string }, b: { path: string }): number {
	return a.path.localeCompare(b.path, "en");
}

function listBundleFiles(bundleDir: string): string[] {
	const files: string[] = [];
	const visit = (relativeDir: string): void => {
		const absoluteDir = relativeDir ? join(bundleDir, relativeDir) : bundleDir;
		for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name, "en"),
		)) {
			const relativePath = relativeDir
				? `${relativeDir}/${entry.name}`
				: entry.name;
			const absolutePath = join(bundleDir, relativePath);
			const stat = lstatSync(absolutePath);
			if (stat.isSymbolicLink()) {
				throw new Error(`g6-manifest: symlink is forbidden: ${relativePath}`);
			}
			if (stat.isDirectory()) {
				visit(relativePath);
				continue;
			}
			if (!stat.isFile()) {
				throw new Error(
					`g6-manifest: non-regular evidence file is forbidden: ${relativePath}`,
				);
			}
			files.push(relativePath);
		}
	};
	visit("");
	return files.sort((a, b) => a.localeCompare(b, "en"));
}

function requireObject(value: unknown, label: string): JsonObject {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`g6-manifest: ${label} must be an object`);
	}
	return value as JsonObject;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`g6-manifest: ${label} must be a non-empty string`);
	}
	return value;
}

function parseJsonFile(bundleDir: string, entry: G6BundleFile): JsonObject {
	try {
		return requireObject(
			JSON.parse(readFileSync(join(bundleDir, entry.path), "utf8")),
			entry.path,
		);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("g6-manifest:")) {
			throw error;
		}
		throw new Error(`g6-manifest: invalid JSON in ${entry.path}`);
	}
}

function entriesForRole(
	files: G6BundleFile[],
	role: G6BundleFileRole,
): G6BundleFile[] {
	return files.filter((entry) => entry.role === role);
}

function requireExactlyOneRole(
	files: G6BundleFile[],
	role: G6BundleFileRole,
): G6BundleFile {
	const entries = entriesForRole(files, role);
	if (entries.length !== 1) {
		throw new Error(
			`g6-manifest: required role ${role} must appear exactly once (found ${entries.length})`,
		);
	}
	const entry = entries[0];
	if (!entry) throw new Error(`g6-manifest: required role ${role} is missing`);
	return entry;
}

function validateIdentityShape(metadata: G6BundleMetadata): void {
	if (!CANDIDATE_RE.test(metadata.identity.candidateSha)) {
		throw new Error("g6-manifest: candidate must be a full lowercase SHA");
	}
	const { preRegistration, registration } = metadata.identity;
	if (
		preRegistration.id !== G6_SUCCESSOR_PREREGISTRATION_ID ||
		preRegistration.path !== G6_SUCCESSOR_PREREGISTRATION_PATH ||
		!HASH_RE.test(preRegistration.sha256)
	) {
		throw new Error("g6-manifest: invalid successor preregistration identity");
	}
	if (
		registration.id !== G6_SUCCESSOR_REGISTRATION_ID ||
		registration.path !== G6_SUCCESSOR_REGISTRATION_PATH ||
		!HASH_RE.test(registration.sha256)
	) {
		throw new Error("g6-manifest: invalid successor registration identity");
	}
}

function validateFileEntries(files: G6BundleFile[]): void {
	const seen = new Set<string>();
	for (const entry of files) {
		requirePortablePath(entry.path);
		if (seen.has(entry.path)) {
			throw new Error(`g6-manifest: duplicate evidence path ${entry.path}`);
		}
		seen.add(entry.path);
		if (!ALLOWED_ROLES.has(entry.role)) {
			throw new Error(`g6-manifest: unknown evidence role ${entry.role}`);
		}
		if (entry.role === "mechanism-ticket") {
			throw new Error(
				"g6-manifest: successor mechanism ticket is outside bundle validity",
			);
		}
		if (entry.leg !== undefined) {
			if (!Number.isInteger(entry.leg) || entry.leg < 0 || entry.leg > 8) {
				throw new Error(`g6-manifest: invalid attribution leg ${entry.leg}`);
			}
		}
		if (entry.sha256 !== null && !HASH_RE.test(entry.sha256)) {
			throw new Error(`g6-manifest: invalid sha256 for ${entry.path}`);
		}
	}
}

function validateIdentityCopy(
	bundleDir: string,
	entry: G6BundleFile,
	expected: G6SourceIdentity,
	label: "preregistration" | "registration",
	metadata: G6BundleMetadata,
): void {
	const contents = readFileSync(join(bundleDir, entry.path), "utf8");
	const actualHash = sha256Bytes(contents);
	if (actualHash !== expected.sha256) {
		throw new Error(`g6-manifest: ${label} copy hash mismatch`);
	}
	for (const required of [expected.id, expected.path]) {
		if (!contents.includes(required)) {
			throw new Error(`g6-manifest: ${label} copy omitted ${required}`);
		}
	}
	if (label === "registration") {
		for (const required of [
			metadata.identity.candidateSha,
			metadata.identity.preRegistration.id,
			metadata.identity.preRegistration.path,
			metadata.identity.preRegistration.sha256,
		]) {
			if (!contents.includes(required)) {
				throw new Error(
					`g6-manifest: registration copy does not bind candidate/preregistration value ${required}`,
				);
			}
		}
	}
}

function validateHostIdentity(
	bundleDir: string,
	metadata: G6BundleMetadata,
): { runnerHost: string; generatorHost: string; identity: string } {
	const entry = requireExactlyOneRole(metadata.files, "host-identity");
	const host = parseJsonFile(bundleDir, entry);
	if (host.schema !== "g6-host-identity/1") {
		throw new Error("g6-manifest: unsupported host identity schema");
	}
	const runnerHost = requireString(host.runnerHost, `${entry.path}.runnerHost`);
	const generatorHost = requireString(
		host.generatorHost,
		`${entry.path}.generatorHost`,
	);
	const identity = requireString(host.identity, `${entry.path}.identity`);
	for (const [label, value] of [
		["runner", runnerHost],
		["generator", generatorHost],
	] as const) {
		try {
			if (canonicalGeneratorIdentity(value) !== value) {
				throw new Error("not canonical");
			}
		} catch {
			throw new Error(`g6-manifest: ${label} host identity is not canonical`);
		}
	}
	const expectedIdentity = `runner=${runnerHost};generator=${generatorHost}`;
	if (identity !== expectedIdentity) {
		throw new Error("g6-manifest: host pair identity is not canonical");
	}
	const registration = readFileSync(
		join(
			bundleDir,
			requireExactlyOneRole(metadata.files, "registration-copy").path,
		),
		"utf8",
	);
	for (const value of [runnerHost, generatorHost, identity]) {
		if (!registration.includes(value)) {
			throw new Error(
				`g6-manifest: registration copy does not bind host value ${value}`,
			);
		}
	}
	return { runnerHost, generatorHost, identity };
}

function validatePreRegistrationObject(
	value: unknown,
	metadata: G6BundleMetadata,
	label: string,
): void {
	const identity = requireObject(value, `${label}.preRegistration`);
	for (const [key, expected] of Object.entries(
		metadata.identity.preRegistration,
	)) {
		if (identity[key] !== expected) {
			throw new Error(`g6-manifest: ${label} preregistration ${key} mismatch`);
		}
	}
}

function validateCandidateValue(
	value: unknown,
	metadata: G6BundleMetadata,
	label: string,
): void {
	if (value !== metadata.identity.candidateSha) {
		throw new Error(`g6-manifest: ${label} candidate mismatch`);
	}
}

function validateSourceExternalInputs(
	bundleDir: string,
	metadata: G6BundleMetadata,
	source: JsonObject,
	label: string,
): void {
	const declared = requireObject(
		source.externalInputs,
		`${label}.externalInputs`,
	);
	const retained =
		metadata.kind === "full-g6"
			? FULL_G6_EXTERNAL_ROLES.map((role) =>
					requireExactlyOneRole(metadata.files, role),
				)
			: [];
	const retainedPaths = retained
		.map((entry) => entry.path)
		.sort((a, b) => a.localeCompare(b, "en"));
	const declaredPaths = Object.keys(declared).sort((a, b) =>
		a.localeCompare(b, "en"),
	);
	if (JSON.stringify(declaredPaths) !== JSON.stringify(retainedPaths)) {
		throw new Error(
			"g6-manifest: source identity external input membership mismatch",
		);
	}
	for (const entry of retained) {
		const expected = requireString(
			declared[entry.path],
			`${label}.externalInputs.${entry.path}`,
		);
		if (
			!HASH_RE.test(expected) ||
			sha256File(join(bundleDir, entry.path)) !== expected
		) {
			throw new Error(
				`g6-manifest: external input hash mismatch for ${entry.path}`,
			);
		}
	}
}

function validateClassifiedInputBinding(
	bundleDir: string,
	metadata: G6BundleMetadata,
	classified: JsonObject,
	entry: G6BundleFile,
	hostIdentity: { generatorHost: string },
): void {
	const source = requireObject(classified.source, `${entry.path}.source`);
	if (source.graderSha !== metadata.identity.candidateSha) {
		throw new Error(
			"g6-manifest: classified grader SHA does not match candidate",
		);
	}
	if (source.generatorHost !== hostIdentity.generatorHost) {
		throw new Error("g6-manifest: classified generator host mismatch");
	}
	const declared = requireObject(
		classified.inputSha256,
		`${entry.path}.inputSha256`,
	);
	const expectedKeys = CLASSIFIED_INPUT_ROLES.map(([key]) => key).sort((a, b) =>
		a.localeCompare(b, "en"),
	);
	const declaredKeys = Object.keys(declared).sort((a, b) =>
		a.localeCompare(b, "en"),
	);
	if (JSON.stringify(declaredKeys) !== JSON.stringify(expectedKeys)) {
		throw new Error(
			"g6-manifest: classified grading input membership mismatch",
		);
	}
	for (const [key, role] of CLASSIFIED_INPUT_ROLES) {
		const expected = requireString(
			declared[key],
			`${entry.path}.inputSha256.${key}`,
		);
		const retained = requireExactlyOneRole(metadata.files, role);
		if (
			!HASH_RE.test(expected) ||
			sha256File(join(bundleDir, retained.path)) !== expected
		) {
			throw new Error(`g6-manifest: classified input hash mismatch for ${key}`);
		}
	}
}

function validateJsonIdentities(
	bundleDir: string,
	metadata: G6BundleMetadata,
	hostIdentity: { generatorHost: string },
): void {
	for (const entry of metadata.files) {
		if (
			![
				"host-identity",
				"source-identity",
				"g6-json",
				"realm-report",
				"subscriber-report",
				"publisher-report",
				"classified",
				"attribution-aggregate",
				"attribution-leg",
				"attribution-raw-client",
				"attribution-raw-server",
			].includes(entry.role)
		) {
			continue;
		}
		const value = parseJsonFile(bundleDir, entry);
		if (entry.role === "host-identity") {
			if (
				typeof value.hostname !== "string" &&
				typeof value.identity !== "string"
			) {
				throw new Error(`g6-manifest: ${entry.path} lacks a host identity`);
			}
			continue;
		}
		if (entry.role === "source-identity") {
			if (value.schema !== "g6-source-identity/1") {
				throw new Error("g6-manifest: unsupported source identity schema");
			}
			validateCandidateValue(value.candidateSha, metadata, entry.path);
			const treeSha = requireString(value.treeSha, `${entry.path}.treeSha`);
			if (!CANDIDATE_RE.test(treeSha) || value.dirty !== false) {
				throw new Error("g6-manifest: source identity must bind a clean tree");
			}
			const registration = readFileSync(
				join(
					bundleDir,
					requireExactlyOneRole(metadata.files, "registration-copy").path,
				),
				"utf8",
			);
			if (!registration.includes(treeSha)) {
				throw new Error(
					"g6-manifest: source tree is not bound by registration",
				);
			}
			validateSourceExternalInputs(bundleDir, metadata, value, entry.path);
			continue;
		}
		if (
			entry.role === "g6-json" ||
			entry.role === "classified" ||
			entry.role === "attribution-aggregate" ||
			entry.role === "attribution-leg" ||
			entry.role === "attribution-raw-client" ||
			entry.role === "attribution-raw-server" ||
			entry.role === "realm-report" ||
			entry.role === "subscriber-report" ||
			entry.role === "publisher-report"
		) {
			validatePreRegistrationObject(
				value.preRegistration,
				metadata,
				entry.path,
			);
		}
		if (entry.role === "g6-json" || entry.role === "classified") {
			const source = requireObject(value.source, `${entry.path}.source`);
			validateCandidateValue(source.candidateSha, metadata, entry.path);
		}
		if (entry.role === "classified") {
			validateClassifiedInputBinding(
				bundleDir,
				metadata,
				value,
				entry,
				hostIdentity,
			);
		}
		if (
			entry.role === "attribution-aggregate" ||
			entry.role === "attribution-leg"
		) {
			validateCandidateValue(value.candidateSha, metadata, entry.path);
		}
		if (
			entry.role === "attribution-raw-client" ||
			entry.role === "attribution-raw-server"
		) {
			if (value.candidateSha !== undefined) {
				validateCandidateValue(value.candidateSha, metadata, entry.path);
			}
		}
		if (entry.role === "attribution-leg") {
			const identityLeg = requireObject(
				value.identityLeg,
				`${entry.path}.identityLeg`,
			);
			validateCandidateValue(
				identityLeg.candidateSha,
				metadata,
				`${entry.path}.identityLeg`,
			);
		}
	}
}

function validateFloorIdentity(
	bundleDir: string,
	metadata: G6BundleMetadata,
): void {
	const entries = entriesForRole(metadata.files, "floor");
	for (const entry of entries) {
		const transcript = readFileSync(join(bundleDir, entry.path), "utf8");
		const line = transcript.match(/^mmo-client: json (\{.*\})\s*$/m)?.[1];
		let parsed: unknown;
		try {
			parsed = JSON.parse(line ?? transcript);
		} catch {
			throw new Error(`g6-manifest: invalid floor transcript ${entry.path}`);
		}
		const report = requireObject(parsed, `${entry.path}.mmo-client`);
		if (report.schema !== "mmo-client/2") {
			throw new Error(`g6-manifest: ${entry.path} floor is not mmo-client/2`);
		}
		validatePreRegistrationObject(report.preRegistration, metadata, entry.path);
	}
}

function validateProfiles(bundleDir: string, files: G6BundleFile[]): void {
	const profilesEntry = requireExactlyOneRole(files, "profiles");
	const profiles = parseJsonFile(bundleDir, profilesEntry);
	const declared = profiles.files;
	if (
		!Array.isArray(declared) ||
		!declared.every((path) => typeof path === "string")
	) {
		throw new Error("g6-manifest: profiles.json files must be a string array");
	}
	const declaredPaths = [...declared].sort((a, b) => a.localeCompare(b, "en"));
	const retainedPaths = entriesForRole(files, "profile")
		.map((entry) => entry.path)
		.sort((a, b) => a.localeCompare(b, "en"));
	if (JSON.stringify(declaredPaths) !== JSON.stringify(retainedPaths)) {
		const missing = declaredPaths.find((path) => !retainedPaths.includes(path));
		throw new Error(
			`g6-manifest: declared profile ${missing ?? retainedPaths[0] ?? "set"} is not retained exactly`,
		);
	}
	if (profiles.available === true && declaredPaths.length === 0) {
		throw new Error("g6-manifest: available profiles declaration has no files");
	}
}

function requireLegSet(
	files: G6BundleFile[],
	role: "attribution-leg" | "attribution-raw-client" | "attribution-raw-server",
): void {
	const entries = entriesForRole(files, role);
	const byLeg = new Map<number, number>();
	for (const entry of entries) {
		if (entry.leg === undefined) {
			throw new Error(`g6-manifest: ${role} is missing its leg index`);
		}
		byLeg.set(entry.leg, (byLeg.get(entry.leg) ?? 0) + 1);
	}
	for (let leg = 0; leg < 9; leg += 1) {
		if (byLeg.get(leg) !== 1) {
			throw new Error(
				`g6-manifest: ${role} must appear exactly once for leg ${leg}`,
			);
		}
	}
	if (entries.length !== 9) {
		throw new Error(`g6-manifest: ${role} must contain exactly nine legs`);
	}
}

function requireLegEntry(
	files: G6BundleFile[],
	role: "attribution-leg" | "attribution-raw-client" | "attribution-raw-server",
	leg: number,
): G6BundleFile {
	const entry = entriesForRole(files, role).find(
		(candidate) => candidate.leg === leg,
	);
	if (!entry) {
		throw new Error(`g6-manifest: ${role} is missing leg ${leg}`);
	}
	return entry;
}

function validateCompleteResult(
	bundleDir: string,
	metadata: G6BundleMetadata,
): void {
	const hostIdentity = validateHostIdentity(bundleDir, metadata);
	if (metadata.kind === "full-g6") {
		const artifact = parseJsonFile(
			bundleDir,
			requireExactlyOneRole(metadata.files, "g6-json"),
		);
		if (artifact.schema !== "bench-g6/2" || artifact.complete !== true) {
			throw new Error(
				"g6-manifest: complete full-G6 bundle needs complete bench-g6/2",
			);
		}
		const artifactHost = requireObject(artifact.host, "bench-g6.host");
		if (artifactHost.identity !== hostIdentity.runnerHost) {
			throw new Error("g6-manifest: full-G6 runner host identity mismatch");
		}
		const classified = parseJsonFile(
			bundleDir,
			requireExactlyOneRole(metadata.files, "classified"),
		);
		const final = requireObject(classified.final, "classified.final");
		if (
			classified.schema !== "g6-classified/2" ||
			final.valid !== true ||
			(final.gate !== "PASS" && final.gate !== "MISS")
		) {
			throw new Error(
				"g6-manifest: complete full-G6 bundle needs a valid PASS or MISS classification",
			);
		}
		const classifiedSource = requireObject(
			classified.source,
			"classified.source",
		);
		if (classifiedSource.generatorHost !== hostIdentity.generatorHost) {
			throw new Error("g6-manifest: classified generator host mismatch");
		}
		return;
	}
	const aggregate = parseJsonFile(
		bundleDir,
		requireExactlyOneRole(metadata.files, "attribution-aggregate"),
	);
	const identity = requireObject(aggregate.identity, "attribution.identity");
	const outcome = requireObject(aggregate.outcome, "attribution.outcome");
	if (
		aggregate.schema !== "g6-attribution/1" ||
		identity.valid !== true ||
		outcome.valid !== true
	) {
		throw new Error(
			"g6-manifest: complete attribution bundle needs valid identity and outcome",
		);
	}
	const legs = aggregate.legs;
	if (!Array.isArray(legs) || legs.length !== 9) {
		throw new Error(
			"g6-manifest: attribution aggregate must reference nine legs",
		);
	}
	const retainedLegs = entriesForRole(metadata.files, "attribution-leg")
		.map((entry) => entry.path)
		.sort((a, b) => a.localeCompare(b, "en"));
	const aggregateLegs = [...legs]
		.map((value) => requireString(value, "attribution leg reference"))
		.sort((a, b) => a.localeCompare(b, "en"));
	if (JSON.stringify(retainedLegs) !== JSON.stringify(aggregateLegs)) {
		throw new Error(
			"g6-manifest: attribution aggregate leg references do not match retained legs",
		);
	}
	for (let leg = 0; leg < 9; leg += 1) {
		const legEntry = requireLegEntry(metadata.files, "attribution-leg", leg);
		const clientEntry = requireLegEntry(
			metadata.files,
			"attribution-raw-client",
			leg,
		);
		const serverEntry = requireLegEntry(
			metadata.files,
			"attribution-raw-server",
			leg,
		);
		const legArtifact = parseJsonFile(bundleDir, legEntry);
		if (legArtifact.hostIdentity !== hostIdentity.identity) {
			throw new Error(
				`g6-manifest: attribution leg ${leg} host identity mismatch`,
			);
		}
		const rawProcessReports = requireObject(
			legArtifact.rawProcessReports,
			`${legEntry.path}.rawProcessReports`,
		);
		if (
			rawProcessReports.client !== clientEntry.path ||
			rawProcessReports.server !== serverEntry.path
		) {
			throw new Error(
				`g6-manifest: attribution leg ${leg} raw process references do not match retained reports`,
			);
		}
		for (const rawEntry of [clientEntry, serverEntry]) {
			const raw = parseJsonFile(bundleDir, rawEntry);
			if (raw.hostIdentity !== hostIdentity.identity) {
				throw new Error(
					`g6-manifest: attribution leg ${leg} raw host identity mismatch`,
				);
			}
		}
	}
}

function validateRefusalResult(
	bundleDir: string,
	metadata: G6BundleMetadata,
): void {
	const entry = requireExactlyOneRole(metadata.files, "partial-json");
	const refusal = parseJsonFile(bundleDir, entry);
	if (refusal.schema !== "g6-refusal/1") {
		throw new Error("g6-manifest: refusal schema must be g6-refusal/1");
	}
	if (refusal.kind !== metadata.kind) {
		throw new Error("g6-manifest: refusal kind mismatch");
	}
	if (refusal.status !== metadata.status) {
		throw new Error("g6-manifest: refusal status mismatch");
	}
	validateCandidateValue(refusal.candidateSha, metadata, entry.path);
	validatePreRegistrationObject(refusal.preRegistration, metadata, entry.path);
	requireString(refusal.reason, `${entry.path}.reason`);
}

function validateBundleContract(
	bundleDir: string,
	metadata: G6BundleMetadata,
): void {
	validateIdentityShape(metadata);
	validateFileEntries(metadata.files);
	for (const role of BASE_REQUIRED_ROLES) {
		requireExactlyOneRole(metadata.files, role);
	}
	validateIdentityCopy(
		bundleDir,
		requireExactlyOneRole(metadata.files, "preregistration-copy"),
		metadata.identity.preRegistration,
		"preregistration",
		metadata,
	);
	const hostIdentity = validateHostIdentity(bundleDir, metadata);
	validateIdentityCopy(
		bundleDir,
		requireExactlyOneRole(metadata.files, "registration-copy"),
		metadata.identity.registration,
		"registration",
		metadata,
	);
	validateJsonIdentities(bundleDir, metadata, hostIdentity);
	validateFloorIdentity(bundleDir, metadata);
	requireExactlyOneRole(metadata.files, "profiles");
	requireExactlyOneRole(metadata.files, "comparison");
	validateProfiles(bundleDir, metadata.files);
	if (metadata.status !== "COMPLETE") {
		if (metadata.stampable) {
			throw new Error(
				"g6-manifest: partial/refusal bundle cannot be stampable",
			);
		}
		validateRefusalResult(bundleDir, metadata);
		return;
	}
	if (!metadata.stampable) {
		throw new Error("g6-manifest: complete bundle must be stampable");
	}
	if (entriesForRole(metadata.files, "partial-json").length > 0) {
		throw new Error(
			"g6-manifest: complete bundle cannot retain a refusal artifact",
		);
	}
	const required =
		metadata.kind === "full-g6"
			? FULL_G6_REQUIRED_ROLES
			: ATTRIBUTION_REQUIRED_ROLES;
	for (const role of required) requireExactlyOneRole(metadata.files, role);
	if (metadata.kind === "attribution") {
		requireLegSet(metadata.files, "attribution-leg");
		requireLegSet(metadata.files, "attribution-raw-client");
		requireLegSet(metadata.files, "attribution-raw-server");
	}
	validateCompleteResult(bundleDir, metadata);
}

function metadataBytes(metadata: G6BundleMetadata): string {
	return `${JSON.stringify(metadata, null, 2)}\n`;
}

function checksumBytes(
	entries: Array<{ path: string; sha256: string }>,
): string {
	return `${entries
		.sort(comparePath)
		.map((entry) => `${entry.sha256}  ${entry.path}`)
		.join("\n")}\n`;
}

function metadataFromOptions(
	options: G6ManifestWriteOptions,
): G6BundleMetadata {
	if (options.kind !== "full-g6" && options.kind !== "attribution") {
		throw new Error(`g6-manifest: invalid bundle kind ${options.kind}`);
	}
	if (
		options.status !== "COMPLETE" &&
		options.status !== "INVALID" &&
		options.status !== "ABORTED"
	) {
		throw new Error(`g6-manifest: invalid bundle status ${options.status}`);
	}
	const payloadFiles: G6BundleFile[] = options.files.map((entry) => ({
		...entry,
		sha256: null,
	}));
	validateFileEntries(payloadFiles);
	for (const entry of payloadFiles) {
		if (entry.path === G6_BUNDLE_METADATA || entry.path === G6_BUNDLE_SUMS) {
			throw new Error(`g6-manifest: reserved evidence path ${entry.path}`);
		}
		const absolutePath = join(options.bundleDir, entry.path);
		if (!existsSync(absolutePath)) {
			throw new Error(`g6-manifest: missing evidence file ${entry.path}`);
		}
		const stat = lstatSync(absolutePath);
		if (stat.isSymbolicLink()) {
			throw new Error(`g6-manifest: symlink is forbidden: ${entry.path}`);
		}
		if (!stat.isFile()) {
			throw new Error(
				`g6-manifest: evidence is not a regular file: ${entry.path}`,
			);
		}
		entry.sha256 = sha256File(absolutePath);
	}
	const files: G6BundleFile[] = [
		...payloadFiles,
		{
			path: G6_BUNDLE_METADATA,
			role: "bundle-metadata",
			sha256: null,
		},
		{ path: G6_BUNDLE_SUMS, role: "sha256sums", sha256: null },
	];
	return {
		schema: G6_BUNDLE_SCHEMA,
		kind: options.kind,
		status: options.status,
		stampable: options.status === "COMPLETE",
		identity: {
			candidateSha: options.candidateSha,
			preRegistration: { ...options.preRegistration },
			registration: { ...options.registration },
		},
		files: files.sort(comparePath),
	};
}

export function writeG6Manifest(
	options: G6ManifestWriteOptions,
): G6BundleMetadata {
	if (
		!existsSync(options.bundleDir) ||
		!lstatSync(options.bundleDir).isDirectory()
	) {
		throw new Error(
			`g6-manifest: bundle directory is missing: ${options.bundleDir}`,
		);
	}
	for (const reserved of [G6_BUNDLE_METADATA, G6_BUNDLE_SUMS]) {
		if (existsSync(join(options.bundleDir, reserved))) {
			throw new Error(`g6-manifest: ${reserved} already exists`);
		}
	}
	validateFileEntries(
		options.files.map((entry) => ({ ...entry, sha256: null })),
	);
	const actualBefore = listBundleFiles(options.bundleDir);
	const declaredBefore = options.files
		.map((entry) => entry.path)
		.sort((a, b) => a.localeCompare(b, "en"));
	if (JSON.stringify(actualBefore) !== JSON.stringify(declaredBefore)) {
		const extra = actualBefore.find((path) => !declaredBefore.includes(path));
		const missing = declaredBefore.find((path) => !actualBefore.includes(path));
		throw new Error(
			`g6-manifest: bundle file set mismatch: ${extra ?? missing ?? "duplicate declaration"}`,
		);
	}
	const metadata = metadataFromOptions(options);
	validateBundleContract(options.bundleDir, metadata);
	const metadataPath = join(options.bundleDir, G6_BUNDLE_METADATA);
	writeFileSync(metadataPath, metadataBytes(metadata), { flag: "wx" });
	const sums = metadata.files
		.filter((entry) => entry.path !== G6_BUNDLE_SUMS)
		.map((entry) => ({
			path: entry.path,
			sha256:
				entry.path === G6_BUNDLE_METADATA
					? sha256File(metadataPath)
					: (entry.sha256 as string),
		}));
	writeFileSync(join(options.bundleDir, G6_BUNDLE_SUMS), checksumBytes(sums), {
		flag: "wx",
	});
	return metadata;
}

function parseMetadata(bundleDir: string): G6BundleMetadata {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			readFileSync(join(bundleDir, G6_BUNDLE_METADATA), "utf8"),
		);
	} catch {
		throw new Error("g6-manifest: missing or malformed bundle metadata");
	}
	const value = requireObject(parsed, "bundle metadata");
	if (value.schema !== G6_BUNDLE_SCHEMA) {
		throw new Error("g6-manifest: unsupported bundle schema");
	}
	if (value.kind !== "full-g6" && value.kind !== "attribution") {
		throw new Error("g6-manifest: invalid bundle kind");
	}
	if (
		value.status !== "COMPLETE" &&
		value.status !== "INVALID" &&
		value.status !== "ABORTED"
	) {
		throw new Error("g6-manifest: invalid bundle status");
	}
	if (typeof value.stampable !== "boolean" || !Array.isArray(value.files)) {
		throw new Error("g6-manifest: malformed bundle metadata fields");
	}
	const identity = requireObject(value.identity, "bundle identity");
	const preRegistration = requireObject(
		identity.preRegistration,
		"bundle preregistration identity",
	);
	const registration = requireObject(
		identity.registration,
		"bundle registration identity",
	);
	const files = value.files.map((raw, index) => {
		const entry = requireObject(raw, `bundle file ${index}`);
		return {
			path: requireString(entry.path, `bundle file ${index}.path`),
			role: requireString(
				entry.role,
				`bundle file ${index}.role`,
			) as G6BundleFileRole,
			sha256:
				entry.sha256 === null
					? null
					: requireString(entry.sha256, `bundle file ${index}.sha256`),
			...(entry.leg === undefined ? {} : { leg: entry.leg as number }),
		};
	});
	return {
		schema: G6_BUNDLE_SCHEMA,
		kind: value.kind,
		status: value.status,
		stampable: value.stampable,
		identity: {
			candidateSha: requireString(identity.candidateSha, "candidateSha"),
			preRegistration: {
				id: requireString(preRegistration.id, "preRegistration.id"),
				path: requireString(preRegistration.path, "preRegistration.path"),
				sha256: requireString(preRegistration.sha256, "preRegistration.sha256"),
			},
			registration: {
				id: requireString(registration.id, "registration.id"),
				path: requireString(registration.path, "registration.path"),
				sha256: requireString(registration.sha256, "registration.sha256"),
			},
		},
		files,
	};
}

function parseChecksums(bundleDir: string): Map<string, string> {
	const contents = readFileSync(join(bundleDir, G6_BUNDLE_SUMS), "utf8");
	const result = new Map<string, string>();
	for (const line of contents.split("\n")) {
		if (line.length === 0) continue;
		const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
		if (!match) throw new Error("g6-manifest: malformed SHA256SUMS line");
		const hash = match[1];
		const path = match[2];
		if (!hash || !path) {
			throw new Error("g6-manifest: malformed SHA256SUMS capture");
		}
		requirePortablePath(path);
		if (result.has(path)) {
			throw new Error(`g6-manifest: duplicate SHA256SUMS path ${path}`);
		}
		result.set(path, hash);
	}
	return result;
}

function verifyChecksums(bundleDir: string, metadata: G6BundleMetadata): void {
	const sums = parseChecksums(bundleDir);
	if (sums.has(G6_BUNDLE_SUMS)) {
		throw new Error("g6-manifest: SHA256SUMS must exclude only itself");
	}
	const expectedPaths = metadata.files
		.filter((entry) => entry.path !== G6_BUNDLE_SUMS)
		.map((entry) => entry.path)
		.sort((a, b) => a.localeCompare(b, "en"));
	const actualPaths = [...sums.keys()].sort((a, b) => a.localeCompare(b, "en"));
	if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) {
		throw new Error("g6-manifest: SHA256SUMS membership mismatch");
	}
	const canonical: Array<{ path: string; sha256: string }> = [];
	for (const path of expectedPaths) {
		const actual = sha256File(join(bundleDir, path));
		if (sums.get(path) !== actual) {
			throw new Error(`g6-manifest: hash mismatch for ${path}`);
		}
		const entry = metadata.files.find((candidate) => candidate.path === path);
		if (!entry) throw new Error(`g6-manifest: metadata omitted ${path}`);
		if (path === G6_BUNDLE_METADATA) {
			if (entry.sha256 !== null) {
				throw new Error("g6-manifest: metadata self hash must be null");
			}
		} else if (entry.sha256 !== actual) {
			throw new Error(`g6-manifest: metadata hash mismatch for ${path}`);
		}
		canonical.push({ path, sha256: actual });
	}
	if (
		readFileSync(join(bundleDir, G6_BUNDLE_SUMS), "utf8") !==
		checksumBytes(canonical)
	) {
		throw new Error("g6-manifest: SHA256SUMS is not canonical");
	}
}

export function verifyG6Manifest(
	bundleDir: string,
	expected: G6ManifestExpectations,
): G6ManifestVerification {
	if (!existsSync(bundleDir) || !lstatSync(bundleDir).isDirectory()) {
		throw new Error(`g6-manifest: bundle directory is missing: ${bundleDir}`);
	}
	const metadata = parseMetadata(bundleDir);
	validateFileEntries(metadata.files);
	const selfEntries = entriesForRole(metadata.files, "bundle-metadata");
	const selfEntry = selfEntries[0];
	if (
		selfEntries.length !== 1 ||
		selfEntry?.path !== G6_BUNDLE_METADATA ||
		selfEntry?.sha256 !== null
	) {
		throw new Error("g6-manifest: metadata must list itself exactly once");
	}
	const sumEntries = entriesForRole(metadata.files, "sha256sums");
	const sumEntry = sumEntries[0];
	if (
		sumEntries.length !== 1 ||
		sumEntry?.path !== G6_BUNDLE_SUMS ||
		sumEntry?.sha256 !== null
	) {
		throw new Error("g6-manifest: metadata must list SHA256SUMS exactly once");
	}
	const actualFiles = listBundleFiles(bundleDir);
	const declaredFiles = metadata.files
		.map((entry) => entry.path)
		.sort((a, b) => a.localeCompare(b, "en"));
	if (JSON.stringify(actualFiles) !== JSON.stringify(declaredFiles)) {
		const extra = actualFiles.find((path) => !declaredFiles.includes(path));
		throw new Error(
			`g6-manifest: unlisted or missing evidence file ${extra ?? "in bundle"}`,
		);
	}
	verifyChecksums(bundleDir, metadata);
	if (metadata.identity.candidateSha !== expected.candidateSha) {
		throw new Error(
			"g6-manifest: candidate mismatch with external expectation",
		);
	}
	if (
		metadata.identity.preRegistration.sha256 !== expected.preRegistrationSha256
	) {
		throw new Error(
			"g6-manifest: preregistration mismatch with external expectation",
		);
	}
	if (metadata.identity.registration.sha256 !== expected.registrationSha256) {
		throw new Error(
			"g6-manifest: registration mismatch with external expectation",
		);
	}
	validateBundleContract(bundleDir, metadata);
	return {
		kind: metadata.kind,
		status: metadata.status,
		stampable: metadata.stampable,
		fileCount: metadata.files.length,
	};
}

function cliValue(args: string[], name: string): string {
	const index = args.indexOf(name);
	if (index < 0 || index + 1 >= args.length) {
		throw new Error(`g6-manifest: missing ${name}`);
	}
	const value = args[index + 1];
	if (!value) throw new Error(`g6-manifest: empty ${name}`);
	return value;
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	if (command === "write") {
		const descriptorPath = cliValue(args, "--descriptor");
		const descriptor = JSON.parse(
			readFileSync(descriptorPath, "utf8"),
		) as G6ManifestWriteOptions;
		writeG6Manifest(descriptor);
		return;
	}
	if (command === "verify") {
		const result = verifyG6Manifest(cliValue(args, "--dir"), {
			candidateSha: cliValue(args, "--expected-candidate"),
			preRegistrationSha256: cliValue(
				args,
				"--expected-preregistration-sha256",
			),
			registrationSha256: cliValue(args, "--expected-registration-sha256"),
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	throw new Error("g6-manifest: expected write or verify command");
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(3);
	});
}
