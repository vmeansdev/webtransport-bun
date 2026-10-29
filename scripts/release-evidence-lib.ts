/**
 * Release evidence lives outside the repository: every evidence file is a
 * GitHub Release asset of the candidate pre-release, and the only evidence-like
 * thing committed is `docs/release-evidence-manifest.json`, a checksum manifest
 * that binds each asset (name, size, sha256, producer) to the candidate commit
 * and to the `docs/release-status.json` claims it supports.
 *
 * This module holds everything the CLI (`scripts/release-evidence.ts`), the
 * promotion gate (`scripts/promote-release-status.ts`) and the documentation
 * truth check share: the manifest contract, privacy scrubbing, the
 * deterministic bundle format, and the asset verifier. Network access only
 * happens through the `gh` runner, which tests replace with a fake.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
	containsForbiddenLiteral,
	findEnvironmentDumpViolations,
	findPrivacyViolations,
	findTextPrivacyViolations,
	REDACTED_VALUE,
	REPO_ROOT_PLACEHOLDER,
	unsafeStringReason,
	unsafeTextLineReason,
} from "../tools/interop/evidence-privacy.ts";

export const DEFAULT_ROOT = resolve(import.meta.dir, "..");
export const MANIFEST_RELATIVE_PATH = "docs/release-evidence-manifest.json";
export const STATUS_RELATIVE_PATH = "docs/release-status.json";
export const STATUS_SCHEMA_VERSION = 2;
export const MANIFEST_SCHEMA_VERSION = 1;
export const FRAGMENT_KIND = "release-evidence-fragment";
/** Only these files may differ between the candidate commit and the commit
 * that records its evidence and promotion. */
export const EVIDENCE_RECORD_PATHS = [
	MANIFEST_RELATIVE_PATH,
	STATUS_RELATIVE_PATH,
] as const;

export const SHA40 = /^[0-9a-f]{40}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const ENTRY_ID = /^[a-z0-9][a-z0-9.-]{2,119}$/;
export const ASSET_NAME =
	/^evidence-[a-z0-9][a-z0-9.-]{2,119}\.(?:json|tar\.gz)$/;
export const FRAGMENT_ASSET_NAME =
	/^release-evidence-fragment-[A-Za-z0-9.-]{1,100}\.json$/;
export const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const CLAIM_ID = /^[a-z0-9][a-z0-9-]*$/;

export type EvidenceStatus = "passed" | "failed";

export type GithubActionsProducer = {
	kind: "github-actions";
	repository: string;
	workflow: string;
	runId: number;
	runAttempt: number;
	url: string;
	headSha: string;
};

export type LocalProducer = {
	kind: "local";
	description: string;
};

export type Producer = GithubActionsProducer | LocalProducer;

export type BundleFile = { name: string; size: number; sha256: string };

export type ManifestEntry = {
	id: string;
	claimIds: string[];
	asset: string;
	size: number;
	sha256: string;
	commit: string;
	status: EvidenceStatus;
	producer: Producer;
	createdAt: string;
	files: BundleFile[];
};

export type Manifest = {
	schemaVersion: 1;
	repository: string;
	packageVersion: string | null;
	candidate: { commit: string | null; tag: string | null };
	entries: ManifestEntry[];
};

export type Fragment = {
	schemaVersion: 1;
	kind: typeof FRAGMENT_KIND;
	repository: string;
	commit: string;
	tag: string | null;
	entries: ManifestEntry[];
};

export type Claim = {
	id: string;
	surface?: string;
	status: string;
	evidenceIds: string[];
	gaRequired?: boolean;
};

export type ReleaseStatus = {
	schemaVersion: number;
	candidate: { commit: string | null; readiness: "pending" | "ready" };
	claims: Claim[];
	evidence?: unknown;
	[key: string]: unknown;
};

// ---------------------------------------------------------------------------
// Manifest contract (kept in step with docs/release-evidence-manifest.schema.json)

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	location: string,
	errors: string[],
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key))
			errors.push(`${location}: unknown property ${key}`);
	}
	for (const key of allowed) {
		if (!(key in value)) errors.push(`${location}: missing property ${key}`);
	}
}

function validateProducer(value: unknown, location: string, errors: string[]) {
	if (!isObject(value)) {
		errors.push(`${location}: must be an object`);
		return;
	}
	if (value.kind === "github-actions") {
		exactKeys(
			value,
			[
				"kind",
				"repository",
				"workflow",
				"runId",
				"runAttempt",
				"url",
				"headSha",
			],
			location,
			errors,
		);
		if (
			typeof value.repository !== "string" ||
			!REPOSITORY.test(value.repository)
		)
			errors.push(`${location}.repository: must be owner/name`);
		if (typeof value.workflow !== "string" || value.workflow.length === 0)
			errors.push(`${location}.workflow: must be a non-empty string`);
		if (!Number.isSafeInteger(value.runId) || (value.runId as number) <= 0)
			errors.push(`${location}.runId: must be a positive integer`);
		if (
			!Number.isSafeInteger(value.runAttempt) ||
			(value.runAttempt as number) <= 0
		)
			errors.push(`${location}.runAttempt: must be a positive integer`);
		const expectedUrl = `https://github.com/${value.repository}/actions/runs/${value.runId}`;
		if (
			value.url !== expectedUrl &&
			value.url !== `${expectedUrl}/attempts/${value.runAttempt}`
		)
			errors.push(`${location}.url: must be the run URL ${expectedUrl}`);
		if (typeof value.headSha !== "string" || !SHA40.test(value.headSha))
			errors.push(`${location}.headSha: must be a 40-character commit`);
		return;
	}
	if (value.kind === "local") {
		exactKeys(value, ["kind", "description"], location, errors);
		if (
			typeof value.description !== "string" ||
			value.description.trim().length === 0 ||
			value.description.length > 300
		)
			errors.push(`${location}.description: must be 1..300 characters`);
		else if (unsafeStringReason(value.description))
			errors.push(
				`${location}.description: ${unsafeStringReason(value.description)}`,
			);
		return;
	}
	errors.push(`${location}.kind: must be github-actions or local`);
}

export function validateEntry(
	value: unknown,
	location: string,
	errors: string[],
): void {
	if (!isObject(value)) {
		errors.push(`${location}: must be an object`);
		return;
	}
	exactKeys(
		value,
		[
			"id",
			"claimIds",
			"asset",
			"size",
			"sha256",
			"commit",
			"status",
			"producer",
			"createdAt",
			"files",
		],
		location,
		errors,
	);
	if (typeof value.id !== "string" || !ENTRY_ID.test(value.id))
		errors.push(`${location}.id: must match ${ENTRY_ID}`);
	if (
		!Array.isArray(value.claimIds) ||
		value.claimIds.length === 0 ||
		!value.claimIds.every(
			(id) => typeof id === "string" && CLAIM_ID.test(id),
		) ||
		new Set(value.claimIds).size !== value.claimIds.length
	)
		errors.push(
			`${location}.claimIds: must be a non-empty list of unique claim ids`,
		);
	if (typeof value.asset !== "string" || !ASSET_NAME.test(value.asset))
		errors.push(`${location}.asset: must match ${ASSET_NAME}`);
	else if (
		typeof value.id === "string" &&
		value.asset !== `evidence-${value.id}.json` &&
		value.asset !== `evidence-${value.id}.tar.gz`
	)
		errors.push(
			`${location}.asset: must be evidence-<id>.json or evidence-<id>.tar.gz`,
		);
	if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0)
		errors.push(`${location}.size: must be a positive integer`);
	if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256))
		errors.push(`${location}.sha256: must be lowercase hex sha256`);
	if (typeof value.commit !== "string" || !SHA40.test(value.commit))
		errors.push(`${location}.commit: must be a 40-character commit`);
	if (value.status !== "passed" && value.status !== "failed")
		errors.push(`${location}.status: must be passed or failed`);
	validateProducer(value.producer, `${location}.producer`, errors);
	if (
		isObject(value.producer) &&
		value.producer.kind === "github-actions" &&
		value.producer.headSha !== value.commit
	)
		errors.push(`${location}.producer.headSha: must equal the entry commit`);
	if (!isIsoTimestamp(value.createdAt))
		errors.push(`${location}.createdAt: must be an ISO-8601 UTC timestamp`);
	if (!Array.isArray(value.files) || value.files.length === 0) {
		errors.push(`${location}.files: must list at least one file`);
	} else {
		const names = new Set<string>();
		value.files.forEach((file, index) => {
			const fileLocation = `${location}.files[${index}]`;
			if (!isObject(file)) {
				errors.push(`${fileLocation}: must be an object`);
				return;
			}
			exactKeys(file, ["name", "size", "sha256"], fileLocation, errors);
			if (typeof file.name !== "string" || !isSafeMemberName(file.name))
				errors.push(`${fileLocation}.name: must be a safe relative name`);
			else if (names.has(file.name))
				errors.push(`${fileLocation}.name: duplicate`);
			else names.add(file.name);
			if (!Number.isSafeInteger(file.size) || (file.size as number) < 0)
				errors.push(`${fileLocation}.size: must be a non-negative integer`);
			if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256))
				errors.push(`${fileLocation}.sha256: must be lowercase hex sha256`);
		});
		if (
			typeof value.asset === "string" &&
			value.asset.endsWith(".json") &&
			value.files.length !== 1
		)
			errors.push(
				`${location}.files: a single-file asset lists exactly one file`,
			);
	}
}

export function validateManifest(value: unknown): string[] {
	const errors: string[] = [];
	if (!isObject(value)) return ["manifest: must be an object"];
	exactKeys(
		value,
		["schemaVersion", "repository", "packageVersion", "candidate", "entries"],
		"manifest",
		errors,
	);
	if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION)
		errors.push(
			`manifest.schemaVersion: must equal ${MANIFEST_SCHEMA_VERSION}`,
		);
	if (
		typeof value.repository !== "string" ||
		!REPOSITORY.test(value.repository)
	)
		errors.push("manifest.repository: must be owner/name");
	if (
		value.packageVersion !== null &&
		(typeof value.packageVersion !== "string" ||
			!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.packageVersion))
	)
		errors.push("manifest.packageVersion: must be null or a semantic version");
	const candidate = value.candidate;
	if (!isObject(candidate)) {
		errors.push("manifest.candidate: must be an object");
	} else {
		exactKeys(candidate, ["commit", "tag"], "manifest.candidate", errors);
		if (
			candidate.commit !== null &&
			(typeof candidate.commit !== "string" || !SHA40.test(candidate.commit))
		)
			errors.push(
				"manifest.candidate.commit: must be null or a 40-character commit",
			);
		if (
			candidate.tag !== null &&
			(typeof candidate.tag !== "string" || !RELEASE_TAG.test(candidate.tag))
		)
			errors.push("manifest.candidate.tag: must be null or a vX.Y.Z[-pre] tag");
		if ((candidate.commit === null) !== (candidate.tag === null))
			errors.push("manifest.candidate: commit and tag are bound together");
		if (candidate.commit !== null && value.packageVersion === null)
			errors.push(
				"manifest.packageVersion: required once a candidate is bound",
			);
	}
	if (!Array.isArray(value.entries)) {
		errors.push("manifest.entries: must be an array");
		return errors;
	}
	const ids = new Set<string>();
	value.entries.forEach((entry, index) => {
		const location = `manifest.entries[${index}]`;
		validateEntry(entry, location, errors);
		if (!isObject(entry)) return;
		if (typeof entry.id === "string") {
			if (ids.has(entry.id))
				errors.push(`${location}.id: duplicate ${entry.id}`);
			ids.add(entry.id);
		}
		if (isObject(candidate)) {
			if (candidate.commit === null)
				errors.push(`${location}: entries require a bound candidate`);
			else if (entry.commit !== candidate.commit)
				errors.push(
					`${location}.commit: differs from manifest.candidate.commit`,
				);
		}
	});
	return errors;
}

export function validateFragment(value: unknown): string[] {
	const errors: string[] = [];
	if (!isObject(value)) return ["fragment: must be an object"];
	exactKeys(
		value,
		["schemaVersion", "kind", "repository", "commit", "tag", "entries"],
		"fragment",
		errors,
	);
	if (value.schemaVersion !== MANIFEST_SCHEMA_VERSION)
		errors.push(
			`fragment.schemaVersion: must equal ${MANIFEST_SCHEMA_VERSION}`,
		);
	if (value.kind !== FRAGMENT_KIND)
		errors.push(`fragment.kind: must be ${FRAGMENT_KIND}`);
	if (
		typeof value.repository !== "string" ||
		!REPOSITORY.test(value.repository)
	)
		errors.push("fragment.repository: must be owner/name");
	if (typeof value.commit !== "string" || !SHA40.test(value.commit))
		errors.push("fragment.commit: must be a 40-character commit");
	if (
		value.tag !== null &&
		(typeof value.tag !== "string" || !RELEASE_TAG.test(value.tag))
	)
		errors.push("fragment.tag: must be null or a vX.Y.Z[-pre] tag");
	if (!Array.isArray(value.entries)) {
		errors.push("fragment.entries: must be an array");
		return errors;
	}
	value.entries.forEach((entry, index) => {
		validateEntry(entry, `fragment.entries[${index}]`, errors);
		if (isObject(entry) && entry.commit !== value.commit)
			errors.push(
				`fragment.entries[${index}].commit: differs from fragment.commit`,
			);
	});
	return errors;
}

export function emptyManifest(repository: string): Manifest {
	return {
		schemaVersion: 1,
		repository,
		packageVersion: null,
		candidate: { commit: null, tag: null },
		entries: [],
	};
}

export function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

export function loadManifest(path: string): Manifest {
	if (!existsSync(path))
		throw new Error(`evidence manifest is missing: ${MANIFEST_RELATIVE_PATH}`);
	const value = readJsonFile(path);
	const errors = validateManifest(value);
	if (errors.length > 0)
		throw new Error(`invalid evidence manifest:\n - ${errors.join("\n - ")}`);
	return value as Manifest;
}

export function serializeManifest(manifest: Manifest): string {
	const sorted: Manifest = {
		...manifest,
		entries: [...manifest.entries].sort((a, b) => a.id.localeCompare(b.id)),
	};
	return `${JSON.stringify(sorted, null, "\t")}\n`;
}

export function writeManifest(path: string, manifest: Manifest): void {
	const errors = validateManifest(manifest);
	if (errors.length > 0)
		throw new Error(
			`refusing to write an invalid manifest:\n - ${errors.join("\n - ")}`,
		);
	writeFileSync(path, serializeManifest(manifest));
}

/** Add entries; an identical re-add is a no-op, a conflicting one is refused. */
export function mergeEntries(
	manifest: Manifest,
	entries: ManifestEntry[],
): number {
	let added = 0;
	for (const entry of entries) {
		if (manifest.candidate.commit !== entry.commit)
			throw new Error(
				`entry ${entry.id} is bound to ${entry.commit}, not the manifest candidate ${manifest.candidate.commit ?? "<unbound>"}`,
			);
		const existing = manifest.entries.find((e) => e.id === entry.id);
		if (existing) {
			if (JSON.stringify(existing) === JSON.stringify(entry)) continue;
			throw new Error(
				`manifest already has a different entry ${entry.id}; evidence entries are immutable`,
			);
		}
		if (manifest.entries.some((e) => e.asset === entry.asset))
			throw new Error(`manifest already records asset ${entry.asset}`);
		manifest.entries.push(entry);
		added += 1;
	}
	return added;
}

// ---------------------------------------------------------------------------
// Hashing and deterministic bundles

export function sha256Hex(data: Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function isSafeMemberName(name: string): boolean {
	if (name.length === 0 || name.length > 255) return false;
	if (name.startsWith("/") || name.includes("\\") || name.includes("\0"))
		return false;
	return name
		.split("/")
		.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export type BundleMember = { name: string; data: Uint8Array };

function writeOctal(
	header: Uint8Array,
	offset: number,
	length: number,
	value: number,
) {
	const text = value.toString(8).padStart(length - 1, "0");
	header.set(new TextEncoder().encode(text), offset);
	header[offset + length - 1] = 0;
}

function writeText(
	header: Uint8Array,
	offset: number,
	length: number,
	text: string,
) {
	const bytes = new TextEncoder().encode(text);
	if (bytes.length > length)
		throw new Error(`tar header field too long: ${text}`);
	header.set(bytes, offset);
}

/** Minimal deterministic ustar writer: sorted members, fixed mode/owner/mtime. */
export function createTarGz(members: BundleMember[]): Uint8Array {
	const sorted = [...members].sort((a, b) =>
		a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
	);
	const blocks: Uint8Array[] = [];
	for (const member of sorted) {
		if (!isSafeMemberName(member.name))
			throw new Error(`unsafe bundle member name: ${member.name}`);
		const header = new Uint8Array(512);
		let name = member.name;
		let prefix = "";
		if (new TextEncoder().encode(name).length > 100) {
			const split = name.lastIndexOf("/", name.length - 1);
			const candidatePrefix = split > 0 ? name.slice(0, split) : "";
			const candidateName = split > 0 ? name.slice(split + 1) : name;
			if (
				candidatePrefix.length > 155 ||
				candidateName.length > 100 ||
				split <= 0
			)
				throw new Error(`bundle member name too long: ${member.name}`);
			prefix = candidatePrefix;
			name = candidateName;
		}
		writeText(header, 0, 100, name);
		writeOctal(header, 100, 8, 0o644);
		writeOctal(header, 108, 8, 0);
		writeOctal(header, 116, 8, 0);
		writeOctal(header, 124, 12, member.data.length);
		writeOctal(header, 136, 12, 0);
		header.fill(0x20, 148, 156);
		header[156] = 0x30; // '0' regular file
		writeText(header, 257, 6, "ustar");
		writeText(header, 263, 2, "00");
		writeText(header, 345, 155, prefix);
		let checksum = 0;
		for (const byte of header) checksum += byte;
		const checksumText = `${checksum.toString(8).padStart(6, "0")}\0 `;
		writeText(header, 148, 8, checksumText);
		blocks.push(header);
		blocks.push(member.data);
		const padding = (512 - (member.data.length % 512)) % 512;
		if (padding > 0) blocks.push(new Uint8Array(padding));
	}
	blocks.push(new Uint8Array(1024));
	const total = blocks.reduce((sum, block) => sum + block.length, 0);
	const tar = new Uint8Array(total);
	let offset = 0;
	for (const block of blocks) {
		tar.set(block, offset);
		offset += block.length;
	}
	return new Uint8Array(gzipSync(tar, { level: 9 }));
}

function readCString(
	bytes: Uint8Array,
	offset: number,
	length: number,
): string {
	const slice = bytes.subarray(offset, offset + length);
	const end = slice.indexOf(0);
	return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

/** Reads only what `createTarGz` writes: regular files with safe names. */
export function readTarGz(data: Uint8Array): BundleMember[] {
	const tar = new Uint8Array(gunzipSync(data));
	const members: BundleMember[] = [];
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const name = readCString(header, 0, 100);
		const prefix = readCString(header, 345, 155);
		const fullName = prefix ? `${prefix}/${name}` : name;
		const type = header[156];
		if (type !== 0x30 && type !== 0)
			throw new Error(`bundle member ${fullName} is not a regular file`);
		if (!isSafeMemberName(fullName))
			throw new Error("bundle contains an unsafe member name");
		const size = Number.parseInt(readCString(header, 124, 12).trim() || "0", 8);
		if (!Number.isSafeInteger(size) || size < 0)
			throw new Error(`bundle member ${fullName} has an invalid size`);
		const start = offset + 512;
		if (start + size > tar.length)
			throw new Error(`bundle member ${fullName} is truncated`);
		members.push({ name: fullName, data: tar.slice(start, start + size) });
		offset = start + Math.ceil(size / 512) * 512;
	}
	return members;
}

// ---------------------------------------------------------------------------
// Privacy scrubbing

export type ScrubOptions = {
	/** Absolute checkout paths rewritten to `<repo>` before any check. */
	repoRoots: string[];
	/** Replace remaining host paths with a fixed marker instead of refusing. */
	redactHostPaths: boolean;
	/** Literals (operator login, hostname) that must not appear at all. */
	forbiddenLiterals: string[];
};

export type ScrubResult =
	| { ok: true; data: Uint8Array }
	| { ok: false; problems: string[] };

const REFUSE_ALWAYS = new Set([
	"credential-shaped value",
	"credential-shaped property name",
	"environment dump",
]);

function isRefuseAlways(reason: string): boolean {
	return (
		REFUSE_ALWAYS.has(reason) ||
		reason.startsWith("property name is a credential")
	);
}

function rerootString(value: string, roots: string[]): string {
	let out = value;
	for (const root of roots) {
		if (root.length === 0) continue;
		out = out.replaceAll(root, REPO_ROOT_PLACEHOLDER);
		const forward = root.replaceAll("\\", "/");
		if (forward !== root) out = out.replaceAll(forward, REPO_ROOT_PLACEHOLDER);
	}
	return out;
}

function mapStrings(node: unknown, fn: (value: string) => string): unknown {
	if (typeof node === "string") return fn(node);
	if (Array.isArray(node)) return node.map((entry) => mapStrings(entry, fn));
	if (node === null || typeof node !== "object") return node;
	const result: Record<string, unknown> = Object.create(null);
	for (const [key, entry] of Object.entries(node))
		result[fn(key)] = mapStrings(entry, fn);
	return result;
}

function looksBinary(data: Uint8Array): boolean {
	const window = data.subarray(0, 8192);
	return window.includes(0);
}

function redactTextLine(line: string): string {
	if (unsafeTextLineReason(line) === undefined) return line;
	const redacted = line
		.split(/(\s+)/)
		.map((token) =>
			/^\s+$/.test(token) ||
			(unsafeTextLineReason(token) === undefined &&
				unsafeStringReason(token) === undefined)
				? token
				: REDACTED_VALUE,
		)
		.join("");
	return unsafeTextLineReason(redacted) === undefined
		? redacted
		: REDACTED_VALUE;
}

/**
 * Scrub one evidence file. Repository paths become `<repo>`; credentials,
 * credential-shaped keys, environment dumps and forbidden literals are always
 * refused; any other host path is refused unless `redactHostPaths` is set, in
 * which case it is replaced by a fixed marker. Diagnostics never echo values.
 */
export function scrubFile(
	name: string,
	data: Uint8Array,
	options: ScrubOptions,
): ScrubResult {
	const problems: string[] = [];
	if (looksBinary(data))
		return {
			ok: false,
			problems: [`${name}: binary file cannot be privacy-scanned`],
		};
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		return { ok: false, problems: [`${name}: not valid UTF-8`] };
	}
	if (containsForbiddenLiteral(text, options.forbiddenLiterals))
		problems.push(
			`${name}: contains a forbidden identifier (operator login or hostname)`,
		);

	if (name.endsWith(".json")) {
		let document: unknown;
		try {
			document = JSON.parse(text);
		} catch {
			return { ok: false, problems: [...problems, `${name}: invalid JSON`] };
		}
		let scrubbed = mapStrings(document, (value) =>
			rerootString(value, options.repoRoots),
		);
		const firstPass = [
			...findPrivacyViolations(scrubbed),
			...findEnvironmentDumpViolations(scrubbed),
		];
		for (const violation of firstPass) {
			if (isRefuseAlways(violation.reason) || !options.redactHostPaths)
				problems.push(`${name}${violation.pointer}: ${violation.reason}`);
		}
		if (problems.length > 0) return { ok: false, problems };
		if (options.redactHostPaths)
			scrubbed = mapStrings(scrubbed, (value) =>
				unsafeStringReason(value) ? REDACTED_VALUE : value,
			);
		const remaining = [
			...findPrivacyViolations(scrubbed),
			...findEnvironmentDumpViolations(scrubbed),
		];
		if (remaining.length > 0)
			return {
				ok: false,
				problems: remaining.map(
					(v) => `${name}${v.pointer}: ${v.reason} survived redaction`,
				),
			};
		return {
			ok: true,
			data: new TextEncoder().encode(`${JSON.stringify(scrubbed, null, 2)}\n`),
		};
	}

	const rerooted = rerootString(text, options.repoRoots);
	for (const violation of findTextPrivacyViolations(rerooted)) {
		if (isRefuseAlways(violation.reason) || !options.redactHostPaths)
			problems.push(`${name}:${violation.line}: ${violation.reason}`);
	}
	if (problems.length > 0) return { ok: false, problems };
	const output = options.redactHostPaths
		? rerooted.split("\n").map(redactTextLine).join("\n")
		: rerooted;
	const remaining = findTextPrivacyViolations(output);
	if (remaining.length > 0)
		return {
			ok: false,
			problems: remaining.map(
				(v) => `${name}:${v.line}: ${v.reason} survived redaction`,
			),
		};
	return { ok: true, data: new TextEncoder().encode(output) };
}

/** Collect input files; directories are walked, symlinks and specials refused. */
export function collectInputs(inputs: string[]): BundleMember[] {
	const members: BundleMember[] = [];
	const seen = new Set<string>();
	const add = (name: string, path: string) => {
		if (seen.has(name))
			throw new Error(`two inputs map to the same bundle name ${name}`);
		seen.add(name);
		members.push({ name, data: new Uint8Array(readFileSync(path)) });
	};
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir).sort()) {
			const path = join(dir, entry);
			const stat = lstatSync(path);
			const name = `${prefix}/${entry}`;
			if (stat.isSymbolicLink())
				throw new Error(`refusing symlink in evidence input: ${name}`);
			if (stat.isDirectory()) walk(path, name);
			else if (stat.isFile()) add(name, path);
			else
				throw new Error(`refusing non-regular file in evidence input: ${name}`);
		}
	};
	for (const input of inputs) {
		if (!existsSync(input))
			throw new Error(`evidence input does not exist: ${basename(input)}`);
		const stat = lstatSync(input);
		if (stat.isSymbolicLink())
			throw new Error(`refusing symlinked evidence input: ${basename(input)}`);
		const base = basename(resolve(input)).replace(/^\.+/, "") || "input";
		if (stat.isDirectory()) walk(input, base);
		else if (stat.isFile()) add(base, input);
		else
			throw new Error(
				`refusing non-regular evidence input: ${basename(input)}`,
			);
	}
	if (members.length === 0) throw new Error("evidence inputs contain no files");
	return members;
}

// ---------------------------------------------------------------------------
// Evidence content semantics

export function artifactCommit(value: unknown): string | undefined {
	if (!isObject(value)) return undefined;
	for (const key of ["commit", "sourceCommit", "candidateCommit"]) {
		if (typeof value[key] === "string") return value[key] as string;
	}
	return undefined;
}

/**
 * Semantic checks on an evidence document's own body. Commit identity alone
 * proves binding, not outcome: a "passed" entry whose recorded run failed
 * (nonzero exit, failed status, failed coverage module) is a false-green.
 */
export function artifactSemanticFailures(value: unknown): string[] {
	if (!isObject(value)) return [];
	const failures: string[] = [];
	if (typeof value.exitCode === "number" && value.exitCode !== 0)
		failures.push(`artifact records exitCode ${value.exitCode}`);
	if (typeof value.status === "string" && value.status !== "passed")
		failures.push(`artifact records status ${JSON.stringify(value.status)}`);
	if (value.passed === false) failures.push("artifact records passed=false");
	for (const surface of ["native", "wasm"]) {
		const modules = value[surface];
		if (!Array.isArray(modules)) continue;
		for (const module of modules) {
			if (isObject(module) && module.pass === false)
				failures.push(
					`coverage module ${String(module.module ?? "<unnamed>")} recorded pass=false`,
				);
		}
	}
	if (Array.isArray(value.runs)) {
		value.runs.forEach((run, index) => {
			if (
				isObject(run) &&
				typeof run.exitCode === "number" &&
				run.exitCode !== 0
			)
				failures.push(`artifact run[${index}] records a nonzero exitCode`);
		});
	}
	return failures;
}

/** Unpack an asset into its members (a `.json` asset is its own single member). */
export function assetMembers(
	entry: Pick<ManifestEntry, "asset" | "files">,
	data: Uint8Array,
): BundleMember[] {
	if (entry.asset.endsWith(".tar.gz")) return readTarGz(data);
	return [{ name: entry.files[0]?.name ?? entry.asset, data }];
}

/** Content-level checks shared by package (before upload) and verify (after
 * download): privacy backstop, recorded outcome, and recorded commit. */
export function inspectMembers(
	members: BundleMember[],
	commit: string,
	status: EvidenceStatus,
): string[] {
	const problems: string[] = [];
	for (const member of members) {
		const recheck = scrubFile(member.name, member.data, {
			repoRoots: [],
			redactHostPaths: false,
			forbiddenLiterals: [],
		});
		if (!recheck.ok) problems.push(...recheck.problems);
		if (!member.name.endsWith(".json")) continue;
		let document: unknown;
		try {
			document = JSON.parse(new TextDecoder().decode(member.data));
		} catch {
			continue; // already reported by the privacy recheck
		}
		const recorded = artifactCommit(document);
		if (recorded !== undefined && recorded !== commit)
			problems.push(
				`${member.name}: records commit ${recorded}, not ${commit}`,
			);
		if (status === "passed")
			for (const failure of artifactSemanticFailures(document))
				problems.push(`${member.name}: ${failure}`);
	}
	return problems;
}

// ---------------------------------------------------------------------------
// External commands (gh, git). Tests swap gh for a fake through
// RELEASE_EVIDENCE_GH, a JSON array giving the argv prefix to run.

export type CommandResult = { status: number; stdout: string; stderr: string };

export function ghCommand(): string[] {
	const override = process.env.RELEASE_EVIDENCE_GH;
	if (!override) return ["gh"];
	const parsed = JSON.parse(override) as unknown;
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		!parsed.every((p) => typeof p === "string")
	)
		throw new Error("RELEASE_EVIDENCE_GH must be a JSON array of strings");
	return parsed as string[];
}

export function runGh(args: string[], cwd: string): CommandResult {
	const [command, ...prefix] = ghCommand();
	const result = spawnSync(command as string, [...prefix, ...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	if (result.error)
		throw new Error(`gh could not be started: ${result.error.message}`);
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export function runGit(args: string[], cwd: string): CommandResult {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

export function ghJson(args: string[], cwd: string): unknown {
	const result = runGh(args, cwd);
	if (result.status !== 0)
		throw new Error(
			`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim().split("\n")[0] ?? ""}`,
		);
	return JSON.parse(result.stdout);
}

export type ReleaseAsset = {
	name: string;
	size: number;
	digest?: string | null;
};
export type ReleaseView = {
	tagName: string;
	isPrerelease: boolean;
	isDraft?: boolean;
	isImmutable?: boolean;
	assets: ReleaseAsset[];
};

/** `undefined` when the release does not exist. */
export function viewRelease(
	repo: string,
	tag: string,
	cwd: string,
): ReleaseView | undefined {
	const result = runGh(
		[
			"release",
			"view",
			tag,
			"--repo",
			repo,
			"--json",
			"tagName,isPrerelease,isDraft,isImmutable,assets",
		],
		cwd,
	);
	if (result.status !== 0) {
		if (/not found|could not find|HTTP 404/i.test(result.stderr))
			return undefined;
		throw new Error(
			`gh release view failed: ${result.stderr.trim().split("\n")[0] ?? ""}`,
		);
	}
	return JSON.parse(result.stdout) as ReleaseView;
}

/** The commit a tag points to on the remote (annotated tags dereferenced). */
export function remoteTagCommit(
	repo: string,
	tag: string,
	cwd: string,
): string {
	const value = ghJson(
		["api", `repos/${repo}/commits/${encodeURIComponent(tag)}`],
		cwd,
	);
	const sha = isObject(value) ? value.sha : undefined;
	if (typeof sha !== "string" || !SHA40.test(sha))
		throw new Error(`could not resolve tag ${tag}`);
	return sha;
}

export function packageVersionAt(root: string, commit: string): string {
	const result = runGit(
		["show", `${commit}:packages/webtransport/package.json`],
		root,
	);
	if (result.status !== 0)
		throw new Error(
			`candidate commit ${commit} is not available locally (git fetch it first)`,
		);
	const version = (JSON.parse(result.stdout) as { version?: unknown }).version;
	if (typeof version !== "string")
		throw new Error("candidate package.json has no version");
	return version;
}

// ---------------------------------------------------------------------------
// Verification

export type VerifyOptions = {
	root: string;
	/** Pre-downloaded assets; when absent they are fetched with gh. */
	assetsDir?: string;
	/** Keep downloaded assets here instead of a temporary directory. */
	downloadDir?: string;
};

export type VerifyReport = {
	failures: string[];
	warnings: string[];
	commit: string | null;
	tag: string | null;
	verifiedEntries: number;
};

export function loadStatus(root: string): ReleaseStatus {
	return readJsonFile(join(root, STATUS_RELATIVE_PATH)) as ReleaseStatus;
}

/** Claim-to-evidence binding against the manifest, without touching assets. */
export function checkClaimBindings(
	status: ReleaseStatus,
	manifest: Manifest,
): string[] {
	const failures: string[] = [];
	const entries = new Map(manifest.entries.map((entry) => [entry.id, entry]));
	const commit = manifest.candidate.commit;
	if (status.schemaVersion !== STATUS_SCHEMA_VERSION)
		failures.push(
			`release-status schemaVersion must be ${STATUS_SCHEMA_VERSION}`,
		);
	if (status.evidence !== undefined)
		failures.push(
			"release-status.evidence is retired; evidence is recorded in the manifest",
		);
	if (status.candidate.commit !== null && status.candidate.commit !== commit)
		failures.push(
			`release-status candidate ${status.candidate.commit} differs from manifest candidate ${commit ?? "<unbound>"}`,
		);
	for (const claim of status.claims) {
		if (claim.gaRequired === false) continue;
		if (claim.status !== "passed") {
			failures.push(`claim ${claim.id} status=${claim.status}`);
			continue;
		}
		if (!claim.evidenceIds?.length) {
			failures.push(`claim ${claim.id} has no evidenceIds`);
			continue;
		}
		let bound = false;
		for (const id of claim.evidenceIds) {
			const entry = entries.get(id);
			if (!entry) {
				failures.push(
					`claim ${claim.id} references evidence ${id} missing from the manifest`,
				);
				continue;
			}
			if (!entry.claimIds.includes(claim.id))
				failures.push(
					`evidence ${id} is not recorded as evidence for claim ${claim.id}`,
				);
			else if (entry.status !== "passed")
				failures.push(`evidence ${id} status=${entry.status}`);
			else if (commit === null || entry.commit !== commit)
				failures.push(
					`evidence ${id} commit ${entry.commit} != candidate ${commit ?? "<unbound>"}`,
				);
			else bound = true;
		}
		if (!bound)
			failures.push(
				`claim ${claim.id} has no passing evidence bound to the candidate`,
			);
	}
	return failures;
}

/**
 * Full release verification: manifest contract, candidate identity (tag ->
 * commit, package version), every asset's size and sha256 as downloaded from
 * the release, content-level checks, and claim bindings.
 */
export function verifyRelease(options: VerifyOptions): VerifyReport {
	const failures: string[] = [];
	const warnings: string[] = [];
	const manifestPath = join(options.root, MANIFEST_RELATIVE_PATH);
	let manifest: Manifest;
	try {
		manifest = loadManifest(manifestPath);
	} catch (error) {
		return {
			failures: [error instanceof Error ? error.message : String(error)],
			warnings,
			commit: null,
			tag: null,
			verifiedEntries: 0,
		};
	}
	const { commit, tag } = manifest.candidate;
	const report = (): VerifyReport => ({
		failures,
		warnings,
		commit,
		tag,
		verifiedEntries: verified,
	});
	let verified = 0;
	if (commit === null || tag === null) {
		failures.push(
			"manifest has no bound candidate (run release-evidence.ts bind)",
		);
		return report();
	}
	const repo = manifest.repository;

	try {
		const version = packageVersionAt(options.root, commit);
		if (version !== manifest.packageVersion)
			failures.push(
				`manifest packageVersion ${manifest.packageVersion} != candidate package.json ${version}`,
			);
		if (`v${version}` !== tag)
			failures.push(
				`candidate tag ${tag} does not name the candidate package version ${version}`,
			);
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
	}

	let release: ReleaseView | undefined;
	try {
		const tagCommit = remoteTagCommit(repo, tag, options.root);
		if (tagCommit !== commit)
			failures.push(
				`tag ${tag} points to ${tagCommit}, not the candidate ${commit}`,
			);
		release = viewRelease(repo, tag, options.root);
		if (!release) failures.push(`release ${tag} does not exist`);
		else {
			if (tag.includes("-") && !release.isPrerelease)
				failures.push(`release ${tag} must be a pre-release`);
			if (release.isDraft) warnings.push(`release ${tag} is still a draft`);
		}
	} catch (error) {
		failures.push(error instanceof Error ? error.message : String(error));
	}

	let workDir = options.assetsDir;
	let cleanup: string | undefined;
	if (!workDir && release) {
		workDir =
			options.downloadDir ?? mkdtempSync(join(tmpdir(), "release-evidence-"));
		if (!options.downloadDir) cleanup = workDir;
	}
	try {
		for (const entry of manifest.entries) {
			if (release) {
				const remote = release.assets.find(
					(asset) => asset.name === entry.asset,
				);
				if (!remote) {
					failures.push(
						`asset ${entry.asset} (${entry.id}) is not attached to ${tag}`,
					);
					continue;
				}
				if (remote.size !== entry.size)
					failures.push(
						`asset ${entry.asset} size ${remote.size} != manifest ${entry.size}`,
					);
				if (remote.digest && remote.digest !== `sha256:${entry.sha256}`)
					failures.push(
						`asset ${entry.asset} digest differs from the manifest`,
					);
			}
			if (!workDir) continue;
			const local = join(workDir, entry.asset);
			if (!options.assetsDir) {
				const download = runGh(
					[
						"release",
						"download",
						tag,
						"--repo",
						repo,
						"--dir",
						workDir,
						"--pattern",
						entry.asset,
						"--clobber",
					],
					options.root,
				);
				if (download.status !== 0) {
					failures.push(`could not download ${entry.asset}`);
					continue;
				}
			}
			if (!existsSync(local)) {
				failures.push(`asset ${entry.asset} was not found locally`);
				continue;
			}
			const data = new Uint8Array(readFileSync(local));
			if (data.length !== entry.size) {
				failures.push(
					`asset ${entry.asset} is ${data.length} bytes, manifest says ${entry.size}`,
				);
				continue;
			}
			if (sha256Hex(data) !== entry.sha256) {
				failures.push(
					`asset ${entry.asset} sha256 does not match the manifest`,
				);
				continue;
			}
			let members: BundleMember[];
			try {
				members = assetMembers(entry, data);
			} catch (error) {
				failures.push(
					`asset ${entry.asset}: ${error instanceof Error ? error.message : String(error)}`,
				);
				continue;
			}
			const listed = new Map(entry.files.map((file) => [file.name, file]));
			if (members.length !== entry.files.length)
				failures.push(
					`asset ${entry.asset} has ${members.length} files, manifest lists ${entry.files.length}`,
				);
			for (const member of members) {
				const file = listed.get(member.name);
				if (
					!file ||
					file.size !== member.data.length ||
					file.sha256 !== sha256Hex(member.data)
				)
					failures.push(
						`asset ${entry.asset} member ${member.name} does not match the manifest file list`,
					);
			}
			for (const problem of inspectMembers(members, entry.commit, entry.status))
				failures.push(`asset ${entry.asset}: ${problem}`);
			verified += 1;
		}
		if (release) {
			const recorded = new Set(manifest.entries.map((entry) => entry.asset));
			for (const asset of release.assets) {
				if (ASSET_NAME.test(asset.name) && !recorded.has(asset.name))
					warnings.push(
						`release asset ${asset.name} is not recorded in the manifest`,
					);
			}
		}
	} finally {
		if (cleanup) rmSync(cleanup, { recursive: true, force: true });
	}

	try {
		failures.push(...checkClaimBindings(loadStatus(options.root), manifest));
	} catch (error) {
		failures.push(
			`release-status: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return report();
}
