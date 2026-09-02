#!/usr/bin/env bun

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { canonicalGeneratorIdentity } from "../offbox/host-identity.ts";
import {
	G6_ACK_REFLECTOR_REGISTRATION_ID,
	createG6EvidenceDirectory,
	G6_BUNDLE_METADATA,
	G6_BUNDLE_SUMS,
	G6_SUCCESSOR_PREREGISTRATION_ID,
	G6_SUCCESSOR_PREREGISTRATION_PATH,
	G6_SUCCESSOR_REGISTRATION_ID,
	G6_SUCCESSOR_REGISTRATION_PATH,
	type G6BundleFileInput,
	type G6BundleKind,
	type G6BundleStatus,
	type G6SourceIdentity,
	writeG6Manifest,
} from "./g6-manifest.ts";

const HASH_RE = /^[0-9a-f]{64}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export type G6BundleAuthorityOptions = {
	candidateSha: string;
	treeSha: string;
	preRegistrationPath: string;
	preRegistrationSha256: string;
	registrationPath: string;
	registrationSha256: string;
	runnerHost: string;
	generatorHost: string;
};

export type G6ExternalInput = {
	path: string;
	sha256: string;
};

export type G6FullExternalInputs = {
	preflightDown: G6ExternalInput;
	preflightUp: G6ExternalInput;
	floor: G6ExternalInput;
	sink: G6ExternalInput;
};

export type PrepareG6EvidenceBundleOptions = {
	bundleDir: string;
	kind: G6BundleKind;
	authority: G6BundleAuthorityOptions;
	externalInputs?: G6FullExternalInputs;
};

export type FinalizeG6EvidenceBundleOptions = {
	bundleDir: string;
	kind: G6BundleKind;
	authority: G6BundleAuthorityOptions;
	reason?: string;
};

export type FinalizedG6EvidenceBundle = {
	kind: G6BundleKind;
	status: G6BundleStatus;
	stampable: boolean;
	reason: string | null;
	fileCount: number;
};

type JsonObject = Record<string, unknown>;

const BASE_FILES: Array<[string, G6BundleFileInput["role"]]> = [
	["preregistration.md", "preregistration-copy"],
	["registration.md", "registration-copy"],
	["host-identity.json", "host-identity"],
	["source-identity.json", "source-identity"],
];

const FULL_FILES: Array<[string, G6BundleFileInput["role"]]> = [
	["bench-g6.json", "g6-json"],
	["bench-g6.csv", "g6-csv"],
	["raw/realm-report.json", "realm-report"],
	["raw/realm.log", "realm-log"],
	["raw/subscriber-report.json", "subscriber-report"],
	["raw/subscriber.log", "subscriber-log"],
	["raw/publisher-report.json", "publisher-report"],
	["raw/publisher.log", "publisher-log"],
	["inputs/preflight-down.json", "preflight-down"],
	["inputs/preflight-up.json", "preflight-up"],
	["inputs/floor.log", "floor"],
	["inputs/sink.json", "sink"],
	["classified.json", "classified"],
	["profiles.json", "profiles"],
	["comparison.md", "comparison"],
];

const ATTRIBUTION_FILES: Array<[string, G6BundleFileInput["role"]]> = [
	["aggregate.json", "attribution-aggregate"],
	["profiles.json", "profiles"],
	["comparison.md", "comparison"],
];

const ACK_REFLECTOR_GATE_FILES: Array<[string, G6BundleFileInput["role"]]> = [
	["ack-gate-js.json", "g6-json"],
	["ack-gate-native.json", "g6-json"],
	["ack-reflector-gate.json", "classified"],
];

function kindFiles(
	kind: G6BundleKind,
): Array<[string, G6BundleFileInput["role"]]> {
	if (kind === "full-g6") return FULL_FILES;
	if (kind === "ack-reflector-gate") return ACK_REFLECTOR_GATE_FILES;
	return ATTRIBUTION_FILES;
}

const EXTERNAL_DESTINATIONS: Array<[keyof G6FullExternalInputs, string]> = [
	["preflightDown", "inputs/preflight-down.json"],
	["preflightUp", "inputs/preflight-up.json"],
	["floor", "inputs/floor.log"],
	["sink", "inputs/sink.json"],
];

function sha256Bytes(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function sha256File(path: string): string {
	return sha256Bytes(readFileSync(path));
}

function requireRegularFile(path: string, label: string): void {
	if (!existsSync(path))
		throw new Error(`g6-bundle: missing ${label}: ${path}`);
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`g6-bundle: ${label} must be a regular file`);
	}
}

function requireHash(path: string, expected: string, label: string): void {
	if (!HASH_RE.test(expected)) {
		throw new Error(`g6-bundle: ${label} sha256 must be lowercase 64-hex`);
	}
	requireRegularFile(path, label);
	const actual = sha256File(path);
	if (actual !== expected) {
		throw new Error(
			`g6-bundle: ${label} sha256 mismatch: expected ${expected}, got ${actual}`,
		);
	}
}

function requireCanonicalHost(value: string, label: string): void {
	if (value.length === 0 || canonicalGeneratorIdentity(value) !== value) {
		throw new Error(`g6-bundle: ${label} must be a canonical short hostname`);
	}
}

function validateAuthority(
	authority: G6BundleAuthorityOptions,
	kind: G6BundleKind,
): void {
	if (!SHA_RE.test(authority.candidateSha)) {
		throw new Error("g6-bundle: candidate sha must be lowercase 40-hex");
	}
	if (!SHA_RE.test(authority.treeSha)) {
		throw new Error("g6-bundle: tree sha must be lowercase 40-hex");
	}
	requireCanonicalHost(authority.runnerHost, "runner host");
	requireCanonicalHost(authority.generatorHost, "generator host");
	requireHash(
		authority.preRegistrationPath,
		authority.preRegistrationSha256,
		"preregistration",
	);
	requireHash(
		authority.registrationPath,
		authority.registrationSha256,
		"registration",
	);
	const preregistration = readFileSync(authority.preRegistrationPath, "utf8");
	for (const value of [
		G6_SUCCESSOR_PREREGISTRATION_ID,
		G6_SUCCESSOR_PREREGISTRATION_PATH,
	]) {
		if (!preregistration.includes(value)) {
			throw new Error(`g6-bundle: preregistration omitted ${value}`);
		}
	}
	const registration = readFileSync(authority.registrationPath, "utf8");
	const hostIdentity = `runner=${authority.runnerHost};generator=${authority.generatorHost}`;
	const registrationIdentity =
		kind === "ack-reflector-gate"
			? [G6_ACK_REFLECTOR_REGISTRATION_ID]
			: [G6_SUCCESSOR_REGISTRATION_ID, G6_SUCCESSOR_REGISTRATION_PATH];
	for (const value of [
		...registrationIdentity,
		authority.candidateSha,
		authority.treeSha,
		G6_SUCCESSOR_PREREGISTRATION_ID,
		G6_SUCCESSOR_PREREGISTRATION_PATH,
		authority.preRegistrationSha256,
		authority.runnerHost,
		authority.generatorHost,
		hostIdentity,
	]) {
		if (!registration.includes(value)) {
			throw new Error(`g6-bundle: registration omitted ${value}`);
		}
	}
}

function sourceIdentities(authority: G6BundleAuthorityOptions): {
	preRegistration: G6SourceIdentity;
	registration: G6SourceIdentity;
} {
	return {
		preRegistration: {
			id: G6_SUCCESSOR_PREREGISTRATION_ID,
			path: G6_SUCCESSOR_PREREGISTRATION_PATH,
			sha256: authority.preRegistrationSha256,
		},
		registration: {
			id: G6_SUCCESSOR_REGISTRATION_ID,
			path: G6_SUCCESSOR_REGISTRATION_PATH,
			sha256: authority.registrationSha256,
		},
	};
}

function validateExternalInputs(inputs: G6FullExternalInputs): void {
	for (const [name] of EXTERNAL_DESTINATIONS) {
		const input = inputs[name];
		requireHash(input.path, input.sha256, name);
	}
}

export function prepareG6EvidenceBundle(
	options: PrepareG6EvidenceBundleOptions,
): void {
	validateAuthority(options.authority, options.kind);
	if (options.kind === "full-g6") {
		if (!options.externalInputs) {
			throw new Error("g6-bundle: full-g6 requires all four external inputs");
		}
		validateExternalInputs(options.externalInputs);
	} else if (
		options.kind !== "attribution" &&
		options.kind !== "ack-reflector-gate"
	) {
		throw new Error(`g6-bundle: unsupported bundle kind ${options.kind}`);
	} else if (options.externalInputs) {
		throw new Error(
			`g6-bundle: ${options.kind} bundle cannot copy grading inputs`,
		);
	}

	createG6EvidenceDirectory(options.bundleDir);
	copyFileSync(
		options.authority.preRegistrationPath,
		join(options.bundleDir, "preregistration.md"),
	);
	copyFileSync(
		options.authority.registrationPath,
		join(options.bundleDir, "registration.md"),
	);
	requireHash(
		join(options.bundleDir, "preregistration.md"),
		options.authority.preRegistrationSha256,
		"copied preregistration",
	);
	requireHash(
		join(options.bundleDir, "registration.md"),
		options.authority.registrationSha256,
		"copied registration",
	);
	writeFileSync(
		join(options.bundleDir, "host-identity.json"),
		`${JSON.stringify(
			{
				schema: "g6-host-identity/1",
				runnerHost: options.authority.runnerHost,
				generatorHost: options.authority.generatorHost,
				identity: `runner=${options.authority.runnerHost};generator=${options.authority.generatorHost}`,
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(options.bundleDir, "source-identity.json"),
		`${JSON.stringify(
			{
				schema: "g6-source-identity/1",
				candidateSha: options.authority.candidateSha,
				treeSha: options.authority.treeSha,
				dirty: false,
				externalInputs: Object.fromEntries(
					EXTERNAL_DESTINATIONS.map(([name, destination]) => [
						destination,
						options.externalInputs?.[name].sha256,
					]).filter((entry): entry is [string, string] => Boolean(entry[1])),
				),
			},
			null,
			2,
		)}\n`,
	);
	if (options.externalInputs) {
		mkdirSync(join(options.bundleDir, "inputs"));
		for (const [name, destination] of EXTERNAL_DESTINATIONS) {
			const copiedPath = join(options.bundleDir, destination);
			copyFileSync(options.externalInputs[name].path, copiedPath);
			requireHash(
				copiedPath,
				options.externalInputs[name].sha256,
				`copied ${name}`,
			);
		}
	}
}

function parseJson(path: string): JsonObject | null {
	if (!existsSync(path)) return null;
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as JsonObject)
			: null;
	} catch {
		return null;
	}
}

function completePaths(kind: G6BundleKind): string[] {
	if (kind !== "attribution") return kindFiles(kind).map(([path]) => path);
	const paths = ATTRIBUTION_FILES.map(([path]) => path);
	for (let leg = 0; leg < 9; leg += 1) {
		const prefix = String(leg).padStart(2, "0");
		paths.push(`legs/${prefix}`);
		paths.push(`raw/${prefix}`);
	}
	return paths;
}

function hasCompletePath(bundleDir: string, path: string): boolean {
	if (!path.endsWith("/00") && !/\/(?:0[0-8])$/.test(path)) {
		return existsSync(join(bundleDir, path));
	}
	const [directory, prefix] = path.split("/");
	if (!directory || !prefix) return false;
	const absolute = join(bundleDir, directory);
	if (!existsSync(absolute)) return false;
	const matches = readdirSync(absolute).filter((name) =>
		name.startsWith(prefix),
	);
	return directory === "legs"
		? matches.length === 1
		: matches.some((name) => name.endsWith("-client.json")) &&
				matches.some((name) => name.endsWith("-server.json"));
}

function assessBundle(
	bundleDir: string,
	kind: G6BundleKind,
): { status: G6BundleStatus; reason: string | null } {
	if (kind === "full-g6") {
		const artifact = parseJson(join(bundleDir, "bench-g6.json"));
		if (!artifact) {
			return {
				status: "ABORTED",
				reason: "bench-g6 artifact is missing or malformed",
			};
		}
		if (artifact.schema !== "bench-g6/2" || artifact.complete !== true) {
			return {
				status: "ABORTED",
				reason:
					typeof artifact.aborted === "string"
						? artifact.aborted
						: "bench-g6 did not complete",
			};
		}
		const classified = parseJson(join(bundleDir, "classified.json"));
		if (!classified) {
			return {
				status: "ABORTED",
				reason: "tracked evaluator output is missing or malformed",
			};
		}
		const final =
			classified.final && typeof classified.final === "object"
				? (classified.final as JsonObject)
				: null;
		if (
			classified.schema !== "g6-classified/2" ||
			final?.valid !== true ||
			(final.gate !== "PASS" && final.gate !== "MISS")
		) {
			return {
				status: "INVALID",
				reason: "tracked evaluator rejected G6 validity",
			};
		}
		const missing = completePaths(kind).find(
			(path) => !hasCompletePath(bundleDir, path),
		);
		return missing
			? {
					status: "ABORTED",
					reason: `required evidence is missing: ${missing}`,
				}
			: { status: "COMPLETE", reason: null };
	}

	const aggregate = parseJson(join(bundleDir, "aggregate.json"));
	if (!aggregate || aggregate.schema !== "g6-attribution/1") {
		return {
			status: "ABORTED",
			reason: "attribution aggregate is missing or malformed",
		};
	}
	if (
		aggregate.terminalStatus === "ABORTED" ||
		aggregate.terminalStatus === "INVALID"
	) {
		const failure =
			aggregate.failure && typeof aggregate.failure === "object"
				? (aggregate.failure as JsonObject)
				: null;
		return {
			status: aggregate.terminalStatus,
			reason:
				typeof failure?.message === "string"
					? failure.message
					: "attribution matrix terminated before all legs completed",
		};
	}
	const identity =
		aggregate.identity && typeof aggregate.identity === "object"
			? (aggregate.identity as JsonObject)
			: null;
	const outcome =
		aggregate.outcome && typeof aggregate.outcome === "object"
			? (aggregate.outcome as JsonObject)
			: null;
	if (identity?.valid !== true || outcome?.valid !== true) {
		return {
			status: "INVALID",
			reason: "attribution identity or outcome was invalid",
		};
	}
	const missing = completePaths(kind).find(
		(path) => !hasCompletePath(bundleDir, path),
	);
	return missing
		? { status: "ABORTED", reason: `required evidence is missing: ${missing}` }
		: { status: "COMPLETE", reason: null };
}

function ensureGeneratedSummaries(bundleDir: string, kind: G6BundleKind): void {
	const profilesPath = join(bundleDir, "profiles.json");
	if (!existsSync(profilesPath)) {
		writeFileSync(
			profilesPath,
			`${JSON.stringify(
				{
					available: false,
					reason: "no authoritative profile replay was retained",
					files: [],
				},
				null,
				2,
			)}\n`,
			{ flag: "wx" },
		);
	}
	const comparisonPath = join(bundleDir, "comparison.md");
	if (!existsSync(comparisonPath)) {
		const classified = parseJson(join(bundleDir, "classified.json"));
		const aggregate = parseJson(join(bundleDir, "aggregate.json"));
		writeFileSync(
			comparisonPath,
			[
				kind === "full-g6" ? "# G6 closeout result" : "# G6 attribution matrix",
				"",
				`- Classified: ${classified ? JSON.stringify(classified.final ?? null) : "unavailable"}`,
				`- Attribution identity: ${aggregate ? JSON.stringify(aggregate.identity ?? null) : "unavailable"}`,
				"",
			].join("\n"),
			{ flag: "wx" },
		);
	}
}

function listFiles(root: string): string[] {
	const result: string[] = [];
	const visit = (relativeDir: string): void => {
		const absoluteDir = relativeDir ? join(root, relativeDir) : root;
		for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
			const path = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) visit(path);
			else result.push(path);
		}
	};
	visit("");
	return result.sort((a, b) => a.localeCompare(b, "en"));
}

function fileRole(path: string, kind: G6BundleKind): G6BundleFileInput | null {
	for (const [known, role] of BASE_FILES) {
		if (path === known) return { path, role };
	}
	for (const [known, role] of kindFiles(kind)) {
		if (path === known) return { path, role };
	}
	if (path === "refusal.json") return { path, role: "partial-json" };
	if (path === "bench-g6.json.partial") return { path, role: "partial-log" };
	if (path.startsWith("profiles/")) return { path, role: "profile" };
	if (kind === "attribution") {
		const leg = /^legs\/(0[0-8])-[a-z-]+\.json$/.exec(path);
		if (leg?.[1]) {
			return { path, role: "attribution-leg", leg: Number(leg[1]) };
		}
		const raw = /^raw\/(0[0-8])-[a-z-]+-(client|server)\.json$/.exec(path);
		if (raw?.[1] && raw[2]) {
			return {
				path,
				role:
					raw[2] === "client"
						? "attribution-raw-client"
						: "attribution-raw-server",
				leg: Number(raw[1]),
			};
		}
	}
	return null;
}

function collectFiles(
	bundleDir: string,
	kind: G6BundleKind,
): G6BundleFileInput[] {
	const result: G6BundleFileInput[] = [];
	for (const path of listFiles(bundleDir)) {
		if (path === G6_BUNDLE_METADATA || path === G6_BUNDLE_SUMS) {
			throw new Error(`g6-bundle: evidence is already finalized: ${path}`);
		}
		const entry = fileRole(path, kind);
		if (!entry)
			throw new Error(`g6-bundle: unrecognized evidence file ${path}`);
		result.push(entry);
	}
	return result;
}

export function finalizeG6EvidenceBundle(
	options: FinalizeG6EvidenceBundleOptions,
): FinalizedG6EvidenceBundle {
	validateAuthority(options.authority, options.kind);
	if (!existsSync(options.bundleDir)) {
		throw new Error(
			`g6-bundle: evidence directory is missing: ${options.bundleDir}`,
		);
	}
	for (const [path] of BASE_FILES) {
		if (!existsSync(join(options.bundleDir, path))) {
			throw new Error(`g6-bundle: prepared authority file is missing: ${path}`);
		}
	}
	if (
		sha256File(join(options.bundleDir, "preregistration.md")) !==
		options.authority.preRegistrationSha256
	) {
		throw new Error("g6-bundle: prepared preregistration copy drifted");
	}
	if (
		sha256File(join(options.bundleDir, "registration.md")) !==
		options.authority.registrationSha256
	) {
		throw new Error("g6-bundle: prepared registration copy drifted");
	}
	ensureGeneratedSummaries(options.bundleDir, options.kind);
	const assessment = assessBundle(options.bundleDir, options.kind);
	const reason =
		assessment.status === "COMPLETE"
			? null
			: [assessment.reason, options.reason]
					.filter((value): value is string => Boolean(value))
					.join("; ");
	if (assessment.status !== "COMPLETE") {
		writeFileSync(
			join(options.bundleDir, "refusal.json"),
			`${JSON.stringify(
				{
					schema: "g6-refusal/1",
					kind: options.kind,
					status: assessment.status,
					candidateSha: options.authority.candidateSha,
					preRegistration: sourceIdentities(options.authority).preRegistration,
					reason: reason ?? "run did not produce complete evidence",
				},
				null,
				2,
			)}\n`,
			{ flag: "wx" },
		);
	}
	const files = collectFiles(options.bundleDir, options.kind);
	const identities = sourceIdentities(options.authority);
	const metadata = writeG6Manifest({
		bundleDir: options.bundleDir,
		kind: options.kind,
		status: assessment.status,
		candidateSha: options.authority.candidateSha,
		preRegistration: identities.preRegistration,
		registration: identities.registration,
		files,
	});
	return {
		kind: options.kind,
		status: assessment.status,
		stampable: metadata.stampable,
		reason,
		fileCount: metadata.files.length,
	};
}

function cliValue(args: string[], name: string): string {
	const index = args.indexOf(name);
	if (index < 0 || index + 1 >= args.length) {
		throw new Error(`g6-bundle: missing ${name}`);
	}
	const value = args[index + 1];
	if (!value) throw new Error(`g6-bundle: empty ${name}`);
	return value;
}

function optionalCliValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value) throw new Error(`g6-bundle: empty ${name}`);
	return value;
}

function cliAuthority(args: string[]): G6BundleAuthorityOptions {
	return {
		candidateSha: cliValue(args, "--candidate"),
		treeSha: cliValue(args, "--tree-sha"),
		preRegistrationPath: cliValue(args, "--preregistration"),
		preRegistrationSha256: cliValue(args, "--expected-preregistration-sha256"),
		registrationPath: cliValue(args, "--registration"),
		registrationSha256: cliValue(args, "--expected-registration-sha256"),
		runnerHost: cliValue(args, "--expected-runner-host"),
		generatorHost: cliValue(args, "--expected-generator-host"),
	};
}

function cliKind(args: string[]): G6BundleKind {
	const kind = cliValue(args, "--kind");
	if (
		kind !== "full-g6" &&
		kind !== "attribution" &&
		kind !== "ack-reflector-gate"
	) {
		throw new Error(`g6-bundle: invalid --kind ${kind}`);
	}
	return kind;
}

function cliExternalInputs(args: string[]): G6FullExternalInputs {
	const input = (name: string): G6ExternalInput => ({
		path: cliValue(args, `--${name}`),
		sha256: cliValue(args, `--expected-${name}-sha256`),
	});
	return {
		preflightDown: input("preflight-down"),
		preflightUp: input("preflight-up"),
		floor: input("floor"),
		sink: input("sink"),
	};
}

async function main(): Promise<void> {
	const [command, ...args] = process.argv.slice(2);
	const kind = cliKind(args);
	const bundleDir = cliValue(args, "--dir");
	const authority = cliAuthority(args);
	if (command === "prepare") {
		prepareG6EvidenceBundle({
			bundleDir,
			kind,
			authority,
			...(kind === "full-g6"
				? { externalInputs: cliExternalInputs(args) }
				: {}),
		});
		return;
	}
	if (command === "finalize") {
		const result = finalizeG6EvidenceBundle({
			bundleDir,
			kind,
			authority,
			reason: optionalCliValue(args, "--reason"),
		});
		process.stdout.write(`${JSON.stringify(result)}\n`);
		return;
	}
	throw new Error("g6-bundle: expected prepare or finalize command");
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(3);
	});
}
