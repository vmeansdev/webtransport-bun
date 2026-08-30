import { createHash, randomUUID } from "node:crypto";
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
import {
	canonicalJson,
	type RecordEnvelope,
	validateEnvelope,
	validateRfc3339Millis,
} from "./g6-c32-freeze-model.ts";
import {
	type RecordOperationDependencies,
	recordOperation,
} from "./g6-c32-operation.ts";
import type { JournalClock, RigLifecycleState } from "./g6-c32-rig-journal.ts";
import {
	type DropletIdentity,
	validateDropletIdentity,
} from "./g6-c32-rig-model.ts";

export type HostOperationRequest = {
	operationId: string;
	phase: string;
	attempt: number;
	command: string;
	args: readonly string[];
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	timeoutMs?: number;
};

export type HostOperationResult = {
	stdout: string;
	stderr: string;
	status: {
		outcome: "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "CANCELLED";
		exitCode: number | null;
		signal: string | null;
	};
	startedAt: string;
	finishedAt: string;
	receiptPath: string | null;
};

export interface HostOperationRunner {
	execute(request: HostOperationRequest): Promise<HostOperationResult>;
}

export type RecordedHostOperationRunnerOptions = {
	runId: string;
	artifactDirectory: string;
	artifactPathPrefix: string;
	cwd?: string;
	env?: Readonly<Record<string, string>>;
	timeoutMs?: number;
	startingSequence?: number;
	operationDependencies?: Partial<RecordOperationDependencies>;
};

export class RecordedHostOperationRunner implements HostOperationRunner {
	readonly #options: RecordedHostOperationRunnerOptions;
	#sequence: number;

	constructor(options: RecordedHostOperationRunnerOptions) {
		this.#options = options;
		this.#sequence = options.startingSequence ?? 1;
	}

	async execute(request: HostOperationRequest): Promise<HostOperationResult> {
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
					command: request.command,
					args: [...request.args],
					cwd: request.cwd ?? this.#options.cwd ?? ".",
					env: request.env ?? this.#options.env ?? {},
					timeoutMs: request.timeoutMs ?? this.#options.timeoutMs ?? 120_000,
					stdin: "ignore",
				},
			},
			this.#options.operationDependencies,
		);
		this.#sequence += 1;
		return {
			stdout: readFileSync(recorded.stdoutPath, "utf8"),
			stderr: readFileSync(recorded.stderrPath, "utf8"),
			status: recorded.receipt.status,
			startedAt: recorded.receipt.startedAt,
			finishedAt: recorded.receipt.finishedAt,
			receiptPath: recorded.receiptPath,
		};
	}
}

export type KnownHostEntry = {
	role: "server" | "generator";
	dropletId: number;
	publicIpv4: string;
	keyType: "ssh-ed25519";
	keySha256: string;
	capturedAt: string;
};

export type KnownHostsReceipt = {
	schema: "g6-c32-known-hosts/1";
	envelope: RecordEnvelope;
	knownHostsPath: string;
	knownHostsSha256: string;
	entries: KnownHostEntry[];
};

type CaptureKnownHostsOptions = {
	runId: string;
	hosts: readonly DropletIdentity[];
	knownHostsPath: string;
	receiptPath: string;
	runner: HostOperationRunner;
	clock: JournalClock;
	randomId?: () => string;
};

type WaitForSshReadinessOptions = {
	runId: string;
	hosts: readonly DropletIdentity[];
	knownHostsPath: string;
	runner: HostOperationRunner;
	maxAttempts: number;
	waitBetweenAttempts?: () => Promise<void>;
};

export type HostPreparationAuthority = {
	packages: {
		common: string[];
		server: string[];
		generator: string[];
	};
	bun: {
		version: string;
		binaryPath: string;
		archiveUrl: string;
		archiveSha256: string;
	};
	rust: {
		toolchain: string;
		rustcVersion: string;
		cargoVersion: string;
		installerUrl: string;
		installerSha256: string;
	};
	source: {
		commit: string;
		tree: string;
		bundlePath: string;
		bundleSha256: string;
		remoteBundlePath: string;
		remoteCheckoutPath: string;
		transferRef: string;
	};
	artifacts: {
		nativeRemotePath: string;
		generatorRemotePath: string;
		nativeRetainedPath: string;
		generatorRetainedPath: string;
	};
	linuxSmoke: {
		remoteScriptPath: string;
		remoteEvidenceRoot: string;
		retainedEvidenceRoot: string;
		unameBinaryPath: string;
		timeoutBinaryPath: string;
		server: {
			boundedProbePath: string;
			steeringProbePath: string;
			bpfProbePath: string;
		};
		generator: {
			fixedPortProbePath: string;
			boundedProbePath: string;
		};
	};
};

type PrepareHostsOptions = {
	runId: string;
	hosts: readonly DropletIdentity[];
	knownHostsPath: string;
	authority: HostPreparationAuthority;
	runner: HostOperationRunner;
	clock: JournalClock;
	receiptPath: string;
	randomId?: () => string;
};

export type HostPreparationReceipt = {
	schema: "g6-c32-host-preparation/1";
	envelope: RecordEnvelope;
	hostIds: { server: number; generator: number };
	binaryHashes: {
		nativeAddonSha256: string;
		generatorSha256: string;
	};
	operationReceipts: string[];
};

export function validateHostPreparationReceipt(
	value: unknown,
): HostPreparationReceipt {
	if (!isRecord(value)) fail("host preparation receipt must be an object");
	requireExactKeys(
		value,
		["schema", "envelope", "hostIds", "binaryHashes", "operationReceipts"],
		"host preparation receipt",
	);
	if (value.schema !== "g6-c32-host-preparation/1") {
		fail("host preparation receipt schema is invalid");
	}
	const envelope = validateEnvelope(value.envelope);
	if (
		envelope.phase !== "PREPARED" ||
		envelope.operationId !== "prepare-hosts" ||
		envelope.clockSource !== "offrunner"
	) {
		fail("host preparation envelope is invalid");
	}
	if (!isRecord(value.hostIds)) fail("hostIds must be an object");
	requireExactKeys(value.hostIds, ["server", "generator"], "hostIds");
	const server = value.hostIds.server;
	const generator = value.hostIds.generator;
	if (
		!Number.isSafeInteger(server) ||
		Number(server) < 1 ||
		!Number.isSafeInteger(generator) ||
		Number(generator) < 1 ||
		server === generator
	) {
		fail("hostIds must contain two distinct positive integers");
	}
	if (!isRecord(value.binaryHashes)) fail("binaryHashes must be an object");
	requireExactKeys(
		value.binaryHashes,
		["nativeAddonSha256", "generatorSha256"],
		"binaryHashes",
	);
	if (
		!Array.isArray(value.operationReceipts) ||
		value.operationReceipts.length === 0
	) {
		fail("operationReceipts must be a nonempty array");
	}
	const operationReceipts = value.operationReceipts.map((path, index) =>
		requireString(path, `operationReceipts[${index}]`),
	);
	if (new Set(operationReceipts).size !== operationReceipts.length) {
		fail("operationReceipts must be unique");
	}
	if (envelope.sequence !== operationReceipts.length + 1) {
		fail("host preparation sequence must follow all operation receipts");
	}
	return {
		schema: "g6-c32-host-preparation/1",
		envelope,
		hostIds: { server: Number(server), generator: Number(generator) },
		binaryHashes: {
			nativeAddonSha256: requireHash(
				value.binaryHashes.nativeAddonSha256,
				"binaryHashes.nativeAddonSha256",
			),
			generatorSha256: requireHash(
				value.binaryHashes.generatorSha256,
				"binaryHashes.generatorSha256",
			),
		},
		operationReceipts,
	};
}

export type HostIdentityPacket = {
	schema: "g6-c32-host-identity/1";
	envelope: RecordEnvelope;
	provider: DropletIdentity;
	bootId: string;
	source: {
		commit: string;
		tree: string;
		statusPorcelain: "";
	};
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
	clock: {
		requestStartedAt: string;
		responseFinishedAt: string;
		remoteWallAt: string;
		measuredSkewMilliseconds: number;
	};
};

export type RemoteHostIdentity = {
	schema: "g6-c32-remote-host-identity/1";
	observedAt: string;
	bootId: string;
	source: HostIdentityPacket["source"];
	runtime: HostIdentityPacket["runtime"];
	binary: HostIdentityPacket["binary"];
};

type CollectHostIdentityOptions = {
	runId: string;
	sequence: number;
	host: DropletIdentity;
	knownHostsPath: string;
	runner: HostOperationRunner;
	remoteIdentityCommand: readonly string[];
	maxClockSkewMilliseconds: number;
};

export type CollectedHostIdentity = {
	packet: HostIdentityPacket;
	operationReceiptPath: string;
};

type ValidateHostIdentityPairOptions = {
	runId: string;
	packets: readonly HostIdentityPacket[];
	expectedHosts: readonly DropletIdentity[];
	expectedSource: { commit: string; tree: string };
	expectedRuntime: {
		os: "Linux";
		bunVersion: string;
		rustcVersion: string;
		cargoVersion: string;
	};
	retainedBinaries: { server: string; generator: string };
	expectedBinaryPaths: { server: string; generator: string };
	maxClockSkewMilliseconds: number;
};

const HASH_RE = /^[0-9a-f]{64}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const GIT_OBJECT_RE = /^[0-9a-f]{40}$/;
const BOOT_ID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PACKAGE_RE = /^[a-z0-9][a-z0-9+.-]*$/;
const ABSOLUTE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

function fail(message: string): never {
	throw new Error(`g6-c32-host: ${message}`);
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

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function requireTimestamp(value: unknown, label: string): string {
	return validateRfc3339Millis(value, label);
}

function requireString(value: unknown, label: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.includes("\0") ||
		value.includes("\n") ||
		value.includes("\r")
	) {
		fail(`${label} must be a nonempty single-line string`);
	}
	return value;
}

function requireHash(value: unknown, label: string): string {
	if (typeof value !== "string" || !HASH_RE.test(value)) {
		fail(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

function orderedPair(
	hosts: readonly DropletIdentity[],
): [DropletIdentity, DropletIdentity] {
	if (hosts.length !== 2) fail("host-key capture requires exactly two hosts");
	const checked = hosts.map((host, index) =>
		validateDropletIdentity(host, `hosts[${index}]`),
	);
	const server = checked.filter(({ role }) => role === "server");
	const generator = checked.filter(({ role }) => role === "generator");
	if (server.length !== 1 || generator.length !== 1) {
		fail("host-key capture requires exactly one server and one generator");
	}
	if (server[0]?.publicIpv4 === generator[0]?.publicIpv4) {
		fail("server and generator public IPs must be distinct");
	}
	return [server[0] as DropletIdentity, generator[0] as DropletIdentity];
}

function parseEd25519Keyscan(
	stdout: string,
	expectedIp: string,
): { line: string; key: string } {
	const lines = stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
	if (lines.length !== 1) {
		fail(`expected exactly one ssh-ed25519 key for ${expectedIp}`);
	}
	const parts = (lines[0] as string).split(/\s+/);
	if (
		parts.length !== 3 ||
		parts[0] !== expectedIp ||
		parts[1] !== "ssh-ed25519" ||
		!KEY_RE.test(parts[2] as string)
	) {
		fail(`ssh-keyscan returned an invalid key for ${expectedIp}`);
	}
	return {
		line: `${expectedIp} ssh-ed25519 ${parts[2] as string}`,
		key: parts[2] as string,
	};
}

function successful(result: HostOperationResult): boolean {
	return result.status.outcome === "SUCCEEDED" && result.status.exitCode === 0;
}

function validateOperationTimes(
	result: HostOperationResult,
	operationId: string,
): void {
	const startedAt = requireTimestamp(
		result.startedAt,
		`${operationId}.startedAt`,
	);
	const finishedAt = requireTimestamp(
		result.finishedAt,
		`${operationId}.finishedAt`,
	);
	if (Date.parse(finishedAt) < Date.parse(startedAt)) {
		fail(`${operationId} finished before it started`);
	}
}

function safeRandomId(randomId: () => string): string {
	const value = randomId();
	if (!SAFE_ID_RE.test(value)) fail("staging ID is not filename-safe");
	return value;
}

function publishBytes(
	path: string,
	bytes: string,
	randomId: () => string,
): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true });
	const stagingPath = join(
		parent,
		`${basename(path)}.staged-${safeRandomId(randomId)}`,
	);
	const fd = openSync(stagingPath, "wx", 0o600);
	try {
		writeFileSync(fd, bytes, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(stagingPath, path);
	const parentFd = openSync(parent, "r");
	try {
		fsyncSync(parentFd);
	} finally {
		closeSync(parentFd);
	}
}

function validateKnownHostEntry(value: unknown, index: number): KnownHostEntry {
	if (!isRecord(value)) fail(`entries[${index}] must be an object`);
	requireExactKeys(
		value,
		["role", "dropletId", "publicIpv4", "keyType", "keySha256", "capturedAt"],
		`entries[${index}]`,
	);
	if (value.role !== "server" && value.role !== "generator") {
		fail(`entries[${index}].role is invalid`);
	}
	if (!Number.isSafeInteger(value.dropletId) || Number(value.dropletId) < 1) {
		fail(`entries[${index}].dropletId must be a positive integer`);
	}
	if (value.keyType !== "ssh-ed25519") {
		fail(`entries[${index}].keyType must be ssh-ed25519`);
	}
	return {
		role: value.role,
		dropletId: Number(value.dropletId),
		publicIpv4: requireString(value.publicIpv4, `entries[${index}].publicIpv4`),
		keyType: "ssh-ed25519",
		keySha256: requireHash(value.keySha256, `entries[${index}].keySha256`),
		capturedAt: requireTimestamp(
			value.capturedAt,
			`entries[${index}].capturedAt`,
		),
	};
}

export function validateKnownHostsReceipt(value: unknown): KnownHostsReceipt {
	if (!isRecord(value)) fail("known-hosts receipt must be an object");
	requireExactKeys(
		value,
		["schema", "envelope", "knownHostsPath", "knownHostsSha256", "entries"],
		"known-hosts receipt",
	);
	if (value.schema !== "g6-c32-known-hosts/1") {
		fail("known-hosts receipt schema is invalid");
	}
	if (!Array.isArray(value.entries) || value.entries.length !== 2) {
		fail("known-hosts receipt requires exactly two entries");
	}
	const entries = value.entries.map(validateKnownHostEntry);
	if (entries[0]?.role !== "server" || entries[1]?.role !== "generator") {
		fail("known-hosts entries must be ordered server then generator");
	}
	if (
		entries[0].dropletId === entries[1].dropletId ||
		entries[0].publicIpv4 === entries[1].publicIpv4 ||
		entries[0].keySha256 === entries[1].keySha256
	) {
		fail("known-hosts entries must bind distinct hosts and keys");
	}
	const envelope = validateEnvelope(value.envelope);
	if (
		envelope.sequence !== 1 ||
		envelope.phase !== "BINDING" ||
		envelope.operationId !== "capture-known-hosts" ||
		envelope.clockSource !== "offrunner"
	) {
		fail("known-hosts receipt envelope is invalid");
	}
	return {
		schema: "g6-c32-known-hosts/1",
		envelope,
		knownHostsPath: requireString(value.knownHostsPath, "knownHostsPath"),
		knownHostsSha256: requireHash(value.knownHostsSha256, "knownHostsSha256"),
		entries,
	};
}

function sameBinding(
	left: KnownHostsReceipt,
	right: KnownHostsReceipt,
): boolean {
	return (
		left.envelope.runId === right.envelope.runId &&
		left.knownHostsPath === right.knownHostsPath &&
		left.knownHostsSha256 === right.knownHostsSha256 &&
		left.entries.length === right.entries.length &&
		left.entries.every((entry, index) => {
			const other = right.entries[index];
			return (
				other !== undefined &&
				entry.role === other.role &&
				entry.dropletId === other.dropletId &&
				entry.publicIpv4 === other.publicIpv4 &&
				entry.keyType === other.keyType &&
				entry.keySha256 === other.keySha256
			);
		})
	);
}

export function strictSshArgs(
	knownHostsPath: string,
	publicIpv4: string,
	remoteArgs: readonly string[],
): string[] {
	return [
		"-n",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		`UserKnownHostsFile=${knownHostsPath}`,
		`root@${publicIpv4}`,
		...remoteArgs,
	];
}

export function strictScpArgs(
	knownHostsPath: string,
	copyArgs: readonly string[],
): string[] {
	return [
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		`UserKnownHostsFile=${knownHostsPath}`,
		...copyArgs,
	];
}

export async function captureKnownHosts(
	options: CaptureKnownHostsOptions,
): Promise<KnownHostsReceipt> {
	const hosts = orderedPair(options.hosts);
	const randomId = options.randomId ?? randomUUID;
	const lines: string[] = [];
	const keys = new Set<string>();
	const entries: KnownHostEntry[] = [];

	for (const host of hosts) {
		const operationId = `capture-host-key-${host.role}`;
		const result = await options.runner.execute({
			operationId,
			phase: "BINDING",
			attempt: 1,
			command: "ssh-keyscan",
			args: ["-T", "10", "-t", "ed25519", host.publicIpv4],
		});
		validateOperationTimes(result, operationId);
		if (result.receiptPath === null) {
			fail(`${operationId} did not retain an operation receipt`);
		}
		if (!successful(result)) {
			fail(`ssh-keyscan failed for ${host.role} ${host.publicIpv4}`);
		}
		const parsed = parseEd25519Keyscan(result.stdout, host.publicIpv4);
		if (keys.has(parsed.key)) fail("duplicate SSH host key across both hosts");
		keys.add(parsed.key);
		lines.push(parsed.line);
		entries.push({
			role: host.role as "server" | "generator",
			dropletId: host.id,
			publicIpv4: host.publicIpv4,
			keyType: "ssh-ed25519",
			keySha256: sha256(parsed.key),
			capturedAt: result.finishedAt,
		});
	}

	const knownHostsBytes = `${lines.join("\n")}\n`;
	const receipt: KnownHostsReceipt = {
		schema: "g6-c32-known-hosts/1",
		envelope: {
			recordedAt: requireTimestamp(options.clock.wallNow(), "recordedAt"),
			sequence: 1,
			runId: requireString(options.runId, "runId"),
			phase: "BINDING",
			operationId: "capture-known-hosts",
			clockSource: "offrunner",
		},
		knownHostsPath: options.knownHostsPath,
		knownHostsSha256: sha256(knownHostsBytes),
		entries,
	};

	if (existsSync(options.knownHostsPath)) {
		const existing = readFileSync(options.knownHostsPath, "utf8");
		if (existing !== knownHostsBytes) {
			fail("captured SSH host key changed; refusing to replace bound bytes");
		}
		if (!existsSync(options.receiptPath)) {
			publishBytes(options.receiptPath, canonicalJson(receipt), randomId);
			return receipt;
		}
		let prior: KnownHostsReceipt;
		try {
			prior = validateKnownHostsReceipt(
				JSON.parse(readFileSync(options.receiptPath, "utf8")),
			);
		} catch (error) {
			fail(`existing bound receipt is invalid: ${String(error)}`);
		}
		if (!sameBinding(prior, receipt)) {
			fail("existing known-hosts receipt changed; refusing replacement");
		}
		return prior;
	}

	if (existsSync(options.receiptPath)) {
		let prior: KnownHostsReceipt;
		try {
			prior = validateKnownHostsReceipt(
				JSON.parse(readFileSync(options.receiptPath, "utf8")),
			);
		} catch (error) {
			fail(`orphaned known-hosts receipt is invalid: ${String(error)}`);
		}
		if (!sameBinding(prior, receipt)) {
			fail("orphaned known-hosts receipt does not match fresh capture");
		}
		publishBytes(options.knownHostsPath, knownHostsBytes, randomId);
		return prior;
	}

	// Publishing the receipt first makes either crash boundary recoverable: an
	// orphan receipt can recreate only identical known_hosts bytes, while an
	// orphan known_hosts file can receive only its matching receipt.
	publishBytes(options.receiptPath, canonicalJson(receipt), randomId);
	publishBytes(options.knownHostsPath, knownHostsBytes, randomId);
	return receipt;
}

export async function waitForSshReadiness(
	options: WaitForSshReadinessOptions,
): Promise<
	Array<{ role: "server" | "generator"; attempts: number; readyAt: string }>
> {
	if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) {
		fail("maxAttempts must be a positive safe integer");
	}
	if (!existsSync(options.knownHostsPath)) {
		fail("known_hosts must exist before SSH readiness checks");
	}
	const wait = options.waitBetweenAttempts ?? (() => Bun.sleep(5_000));
	const readiness: Array<{
		role: "server" | "generator";
		attempts: number;
		readyAt: string;
	}> = [];

	for (const [hostIndex, rawHost] of options.hosts.entries()) {
		const host = validateDropletIdentity(rawHost, `hosts[${hostIndex}]`);
		if (host.role !== "server" && host.role !== "generator") {
			fail(`hosts[${hostIndex}] must have a concrete role`);
		}
		let ready = false;
		for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
			const operationId = `ssh-readiness-${host.role}-${attempt}`;
			const result = await options.runner.execute({
				operationId,
				phase: "SSH_READY",
				attempt,
				command: "ssh",
				args: strictSshArgs(options.knownHostsPath, host.publicIpv4, ["true"]),
			});
			validateOperationTimes(result, operationId);
			if (result.receiptPath === null) {
				fail(`${operationId} did not retain an operation receipt`);
			}
			if (successful(result)) {
				readiness.push({
					role: host.role,
					attempts: attempt,
					readyAt: result.finishedAt,
				});
				ready = true;
				break;
			}
			if (attempt < options.maxAttempts) await wait();
		}
		if (!ready) {
			fail(
				`SSH readiness failed for ${host.role} after ${options.maxAttempts} attempts`,
			);
		}
	}
	return readiness;
}

function shellQuote(value: string): string {
	if (value.includes("\0")) fail("cannot shell-quote a NUL byte");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function remoteBash(script: string): string[] {
	return ["bash", "-lc", shellQuote(script)];
}

function requireAbsolutePath(value: unknown, label: string): string {
	const path = requireString(value, label);
	if (
		!ABSOLUTE_PATH_RE.test(path) ||
		path.split("/").some((part) => part === "..")
	) {
		fail(`${label} must be a normalized absolute path`);
	}
	return path;
}

function requireDescendantPath(
	root: string,
	value: unknown,
	label: string,
): string {
	const path = requireAbsolutePath(value, label);
	if (!path.startsWith(`${root}/`)) {
		fail(`${label} must be below the exact remote checkout`);
	}
	return path;
}

function requireGitObject(value: unknown, label: string): string {
	if (typeof value !== "string" || !GIT_OBJECT_RE.test(value)) {
		fail(`${label} must be a full lowercase Git object ID`);
	}
	return value;
}

function requireHttpsUrl(value: unknown, label: string): string {
	const url = requireString(value, label);
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		fail(`${label} must be a valid HTTPS URL`);
	}
	if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
		fail(`${label} must be an unauthenticated HTTPS URL`);
	}
	return url;
}

function requirePackages(values: readonly string[], label: string): string[] {
	if (!Array.isArray(values)) fail(`${label} must be an array`);
	const checked = values.map((value, index) => {
		if (typeof value !== "string" || !PACKAGE_RE.test(value)) {
			fail(`${label}[${index}] is not a safe package name`);
		}
		return value;
	});
	if (new Set(checked).size !== checked.length) {
		fail(`${label} must not contain duplicates`);
	}
	return checked;
}

function validatePreparationAuthority(
	value: HostPreparationAuthority,
): HostPreparationAuthority {
	if (!isRecord(value)) fail("preparation authority must be an object");
	requireExactKeys(
		value,
		["packages", "bun", "rust", "source", "artifacts", "linuxSmoke"],
		"preparation authority",
	);
	if (!isRecord(value.packages)) fail("packages must be an object");
	requireExactKeys(
		value.packages,
		["common", "server", "generator"],
		"packages",
	);
	if (!isRecord(value.bun)) fail("bun authority must be an object");
	requireExactKeys(
		value.bun,
		["version", "binaryPath", "archiveUrl", "archiveSha256"],
		"bun authority",
	);
	if (!isRecord(value.rust)) fail("rust authority must be an object");
	requireExactKeys(
		value.rust,
		[
			"toolchain",
			"rustcVersion",
			"cargoVersion",
			"installerUrl",
			"installerSha256",
		],
		"rust authority",
	);
	if (!isRecord(value.source)) fail("source authority must be an object");
	requireExactKeys(
		value.source,
		[
			"commit",
			"tree",
			"bundlePath",
			"bundleSha256",
			"remoteBundlePath",
			"remoteCheckoutPath",
			"transferRef",
		],
		"source authority",
	);
	if (!isRecord(value.artifacts)) fail("artifacts must be an object");
	requireExactKeys(
		value.artifacts,
		[
			"nativeRemotePath",
			"generatorRemotePath",
			"nativeRetainedPath",
			"generatorRetainedPath",
		],
		"artifacts",
	);
	if (!isRecord(value.linuxSmoke)) fail("linuxSmoke must be an object");
	requireExactKeys(
		value.linuxSmoke,
		[
			"remoteScriptPath",
			"remoteEvidenceRoot",
			"retainedEvidenceRoot",
			"unameBinaryPath",
			"timeoutBinaryPath",
			"server",
			"generator",
		],
		"linuxSmoke",
	);
	if (!isRecord(value.linuxSmoke.server)) {
		fail("linuxSmoke.server must be an object");
	}
	requireExactKeys(
		value.linuxSmoke.server,
		["boundedProbePath", "steeringProbePath", "bpfProbePath"],
		"linuxSmoke.server",
	);
	if (!isRecord(value.linuxSmoke.generator)) {
		fail("linuxSmoke.generator must be an object");
	}
	requireExactKeys(
		value.linuxSmoke.generator,
		["fixedPortProbePath", "boundedProbePath"],
		"linuxSmoke.generator",
	);

	const bundlePath = requireString(
		value.source.bundlePath,
		"source.bundlePath",
	);
	if (!existsSync(bundlePath)) fail("candidate bundle bytes are missing");
	const bundleSha256 = requireHash(
		value.source.bundleSha256,
		"source.bundleSha256",
	);
	if (sha256(readFileSync(bundlePath)) !== bundleSha256) {
		fail("candidate bundle bytes do not match the semantic authority");
	}
	const transferRef = requireString(
		value.source.transferRef,
		"source.transferRef",
	);
	if (!/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(transferRef)) {
		fail("source.transferRef must be a safe heads ref");
	}
	const remoteCheckoutPath = requireAbsolutePath(
		value.source.remoteCheckoutPath,
		"source.remoteCheckoutPath",
	);
	return {
		packages: {
			common: requirePackages(value.packages.common, "packages.common"),
			server: requirePackages(value.packages.server, "packages.server"),
			generator: requirePackages(
				value.packages.generator,
				"packages.generator",
			),
		},
		bun: {
			version: requireString(value.bun.version, "bun.version"),
			binaryPath: requireAbsolutePath(value.bun.binaryPath, "bun.binaryPath"),
			archiveUrl: requireHttpsUrl(value.bun.archiveUrl, "bun.archiveUrl"),
			archiveSha256: requireHash(value.bun.archiveSha256, "bun.archiveSha256"),
		},
		rust: {
			toolchain: requireString(value.rust.toolchain, "rust.toolchain"),
			rustcVersion: requireString(value.rust.rustcVersion, "rust.rustcVersion"),
			cargoVersion: requireString(value.rust.cargoVersion, "rust.cargoVersion"),
			installerUrl: requireHttpsUrl(
				value.rust.installerUrl,
				"rust.installerUrl",
			),
			installerSha256: requireHash(
				value.rust.installerSha256,
				"rust.installerSha256",
			),
		},
		source: {
			commit: requireGitObject(value.source.commit, "source.commit"),
			tree: requireGitObject(value.source.tree, "source.tree"),
			bundlePath,
			bundleSha256,
			remoteBundlePath: requireAbsolutePath(
				value.source.remoteBundlePath,
				"source.remoteBundlePath",
			),
			remoteCheckoutPath,
			transferRef,
		},
		artifacts: {
			nativeRemotePath: requireAbsolutePath(
				value.artifacts.nativeRemotePath,
				"artifacts.nativeRemotePath",
			),
			generatorRemotePath: requireAbsolutePath(
				value.artifacts.generatorRemotePath,
				"artifacts.generatorRemotePath",
			),
			nativeRetainedPath: requireString(
				value.artifacts.nativeRetainedPath,
				"artifacts.nativeRetainedPath",
			),
			generatorRetainedPath: requireString(
				value.artifacts.generatorRetainedPath,
				"artifacts.generatorRetainedPath",
			),
		},
		linuxSmoke: {
			remoteScriptPath: requireDescendantPath(
				remoteCheckoutPath,
				value.linuxSmoke.remoteScriptPath,
				"linuxSmoke.remoteScriptPath",
			),
			remoteEvidenceRoot: requireAbsolutePath(
				value.linuxSmoke.remoteEvidenceRoot,
				"linuxSmoke.remoteEvidenceRoot",
			),
			retainedEvidenceRoot: requireString(
				value.linuxSmoke.retainedEvidenceRoot,
				"linuxSmoke.retainedEvidenceRoot",
			),
			unameBinaryPath: requireAbsolutePath(
				value.linuxSmoke.unameBinaryPath,
				"linuxSmoke.unameBinaryPath",
			),
			timeoutBinaryPath: requireAbsolutePath(
				value.linuxSmoke.timeoutBinaryPath,
				"linuxSmoke.timeoutBinaryPath",
			),
			server: {
				boundedProbePath: requireDescendantPath(
					remoteCheckoutPath,
					value.linuxSmoke.server.boundedProbePath,
					"linuxSmoke.server.boundedProbePath",
				),
				steeringProbePath: requireDescendantPath(
					remoteCheckoutPath,
					value.linuxSmoke.server.steeringProbePath,
					"linuxSmoke.server.steeringProbePath",
				),
				bpfProbePath: requireDescendantPath(
					remoteCheckoutPath,
					value.linuxSmoke.server.bpfProbePath,
					"linuxSmoke.server.bpfProbePath",
				),
			},
			generator: {
				fixedPortProbePath: requireDescendantPath(
					remoteCheckoutPath,
					value.linuxSmoke.generator.fixedPortProbePath,
					"linuxSmoke.generator.fixedPortProbePath",
				),
				boundedProbePath: requireDescendantPath(
					remoteCheckoutPath,
					value.linuxSmoke.generator.boundedProbePath,
					"linuxSmoke.generator.boundedProbePath",
				),
			},
		},
	};
}

function packageInstallOperation(request: HostOperationRequest): boolean {
	const text = [request.command, ...request.args].join(" ");
	return (
		/\b(?:apt-get|apt|dnf|yum|apk)\s+(?:[^\n]*\s)?install\b/.test(text) ||
		/\bbun\s+install\b/.test(text) ||
		/\brustup\s+(?:toolchain\s+)?install\b/.test(text)
	);
}

export function assertNoPackageInstallationAfterPrepared(
	state: RigLifecycleState,
	request: HostOperationRequest,
): void {
	const preparedOrLater = new Set<RigLifecycleState>([
		"PREPARED",
		"BINDING",
		"BOUND",
		"QUALIFYING",
		"RUNNING",
		"TERMINAL",
		"FAILED",
		"DESTROYING",
		"DESTROYED",
	]);
	if (preparedOrLater.has(state) && packageInstallOperation(request)) {
		fail(
			`package installation is prohibited after PREPARED (${request.operationId})`,
		);
	}
}

function bootstrapScript(
	authority: HostPreparationAuthority,
	role: "server" | "generator",
): string {
	const packages = [...authority.packages.common, ...authority.packages[role]];
	const bunArchive = "/tmp/g6-bun-linux-x64.zip";
	const rustInstaller = "/tmp/g6-rustup-init.sh";
	const bunDirectory = authority.bun.binaryPath.slice(
		0,
		authority.bun.binaryPath.lastIndexOf("/"),
	);
	const runDirectory = authority.source.remoteBundlePath.slice(
		0,
		authority.source.remoteBundlePath.lastIndexOf("/"),
	);
	return [
		"set -euo pipefail",
		"export DEBIAN_FRONTEND=noninteractive",
		"apt-get update",
		`apt-get install --yes --no-install-recommends ${packages.map(shellQuote).join(" ")}`,
		`install -d -m 755 ${shellQuote(bunDirectory)} ${shellQuote(runDirectory)}`,
		`curl --fail --location --silent --show-error --output ${shellQuote(bunArchive)} ${shellQuote(authority.bun.archiveUrl)}`,
		`printf '%s  %s\\n' ${shellQuote(authority.bun.archiveSha256)} ${shellQuote(bunArchive)} | sha256sum -c -`,
		`unzip -p ${shellQuote(bunArchive)} bun-linux-x64/bun > ${shellQuote(authority.bun.binaryPath)}`,
		`chmod 755 ${shellQuote(authority.bun.binaryPath)}`,
		`curl --fail --location --silent --show-error --output ${shellQuote(rustInstaller)} ${shellQuote(authority.rust.installerUrl)}`,
		`printf '%s  %s\\n' ${shellQuote(authority.rust.installerSha256)} ${shellQuote(rustInstaller)} | sha256sum -c -`,
		`sh ${shellQuote(rustInstaller)} -y --profile minimal --default-toolchain ${shellQuote(authority.rust.toolchain)}`,
	].join("; ");
}

function toolchainVerificationScript(
	authority: HostPreparationAuthority,
): string {
	return [
		"set -euo pipefail",
		`test "$(${shellQuote(authority.bun.binaryPath)} --version)" = ${shellQuote(authority.bun.version)}`,
		`test "$(/root/.cargo/bin/rustc --version)" = ${shellQuote(authority.rust.rustcVersion)}`,
		`test "$(/root/.cargo/bin/cargo --version)" = ${shellQuote(authority.rust.cargoVersion)}`,
		'test "$(uname -s)" = Linux',
		"uname -srvmo",
	].join("; ");
}

function hashFromOutput(stdout: string, operationId: string): string {
	const lines = stdout.trim().split(/\r?\n/);
	if (lines.length !== 1) fail(`${operationId} returned malformed hash output`);
	const match = lines[0]?.match(/^([0-9a-f]{64})(?:\s+|$)/);
	if (!match?.[1]) fail(`${operationId} returned malformed hash output`);
	return match[1];
}

export async function prepareHosts(
	options: PrepareHostsOptions,
): Promise<HostPreparationReceipt> {
	const [server, generator] = orderedPair(options.hosts);
	if (existsSync(options.receiptPath)) {
		fail("host preparation receipt already exists; refusing to overwrite it");
	}
	if (!existsSync(options.knownHostsPath)) {
		fail("known_hosts must exist before host preparation");
	}
	const authority = validatePreparationAuthority(options.authority);
	const operationReceipts: string[] = [];
	const results = new Map<string, HostOperationResult>();
	const run = async (request: HostOperationRequest): Promise<void> => {
		assertNoPackageInstallationAfterPrepared("PREPARING", request);
		const result = await options.runner.execute(request);
		validateOperationTimes(result, request.operationId);
		if (result.receiptPath === null) {
			fail(`${request.operationId} did not retain an operation receipt`);
		}
		operationReceipts.push(result.receiptPath);
		results.set(request.operationId, result);
		if (!successful(result)) {
			fail(`${request.operationId} failed with ${result.status.outcome}`);
		}
	};
	const ssh = async (
		host: DropletIdentity,
		operationId: string,
		script: string,
	): Promise<void> =>
		run({
			operationId,
			phase: "PREPARING",
			attempt: 1,
			command: "ssh",
			args: strictSshArgs(
				options.knownHostsPath,
				host.publicIpv4,
				remoteBash(script),
			),
		});

	await ssh(server, "bootstrap-server", bootstrapScript(authority, "server"));
	await ssh(
		generator,
		"bootstrap-generator",
		bootstrapScript(authority, "generator"),
	);
	await ssh(
		server,
		"verify-toolchain-server",
		toolchainVerificationScript(authority),
	);
	await ssh(
		generator,
		"verify-toolchain-generator",
		toolchainVerificationScript(authority),
	);

	for (const host of [server, generator]) {
		await run({
			operationId: `transfer-bundle-${host.role}`,
			phase: "PREPARING",
			attempt: 1,
			command: "scp",
			args: strictScpArgs(options.knownHostsPath, [
				authority.source.bundlePath,
				`root@${host.publicIpv4}:${authority.source.remoteBundlePath}`,
			]),
		});
	}

	const branch = authority.source.transferRef.slice("refs/heads/".length);
	const verifyBundle = [
		"set -euo pipefail",
		`test "$(sha256sum ${shellQuote(authority.source.remoteBundlePath)} | awk '{print $1}')" = ${shellQuote(authority.source.bundleSha256)}`,
		"verify_repo=$(mktemp -d /tmp/g6-bundle-verify.XXXXXX)",
		"trap 'rm -rf \"$verify_repo\"' EXIT",
		'git init --bare "$verify_repo" >/dev/null',
		`git -C "$verify_repo" bundle verify ${shellQuote(authority.source.remoteBundlePath)}`,
		`test "$(git bundle list-heads ${shellQuote(authority.source.remoteBundlePath)} ${shellQuote(authority.source.transferRef)} | awk '{print $1}')" = ${shellQuote(authority.source.commit)}`,
	].join("; ");
	await ssh(server, "verify-bundle-server", verifyBundle);
	await ssh(generator, "verify-bundle-generator", verifyBundle);

	const checkout = [
		"set -euo pipefail",
		`test ! -e ${shellQuote(authority.source.remoteCheckoutPath)}`,
		`git clone --branch ${shellQuote(branch)} ${shellQuote(authority.source.remoteBundlePath)} ${shellQuote(authority.source.remoteCheckoutPath)}`,
		`git -C ${shellQuote(authority.source.remoteCheckoutPath)} checkout --detach ${shellQuote(authority.source.commit)}`,
		`test "$(git -C ${shellQuote(authority.source.remoteCheckoutPath)} rev-parse HEAD)" = ${shellQuote(authority.source.commit)}`,
		`test "$(git -C ${shellQuote(authority.source.remoteCheckoutPath)} rev-parse HEAD^{tree})" = ${shellQuote(authority.source.tree)}`,
		`git -C ${shellQuote(authority.source.remoteCheckoutPath)} diff --quiet HEAD`,
		`test -z "$(git -C ${shellQuote(authority.source.remoteCheckoutPath)} status --porcelain --untracked-files=all)"`,
	].join("; ");
	await ssh(server, "checkout-source-server", checkout);
	await ssh(generator, "checkout-source-generator", checkout);

	const dependencyInstall = [
		"set -euo pipefail",
		`cd ${shellQuote(authority.source.remoteCheckoutPath)}`,
		`${shellQuote(authority.bun.binaryPath)} install --frozen-lockfile`,
	].join("; ");
	await ssh(server, "install-source-dependencies-server", dependencyInstall);
	await ssh(
		generator,
		"install-source-dependencies-generator",
		dependencyInstall,
	);

	await ssh(
		server,
		"build-native-addon",
		[
			"set -euo pipefail",
			`cd ${shellQuote(authority.source.remoteCheckoutPath)}`,
			"export PATH=/root/.cargo/bin:/opt/g6/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			`${shellQuote(authority.bun.binaryPath)} run build:native`,
			`test -f ${shellQuote(authority.artifacts.nativeRemotePath)}`,
		].join("; "),
	);
	await ssh(
		generator,
		"build-mmo-client",
		[
			"set -euo pipefail",
			`cd ${shellQuote(authority.source.remoteCheckoutPath)}`,
			"export PATH=/root/.cargo/bin:/opt/g6/bin:/usr/sbin:/usr/bin:/sbin:/bin",
			`rustup run ${shellQuote(authority.rust.toolchain)} cargo build -p reference --bin mmo-client --release --locked`,
			`test -x ${shellQuote(authority.artifacts.generatorRemotePath)}`,
		].join("; "),
	);

	mkdirSync(dirname(authority.artifacts.nativeRetainedPath), {
		recursive: true,
	});
	mkdirSync(dirname(authority.artifacts.generatorRetainedPath), {
		recursive: true,
	});
	await run({
		operationId: "retain-native-addon",
		phase: "PREPARING",
		attempt: 1,
		command: "scp",
		args: strictScpArgs(options.knownHostsPath, [
			`root@${server.publicIpv4}:${authority.artifacts.nativeRemotePath}`,
			authority.artifacts.nativeRetainedPath,
		]),
	});
	await run({
		operationId: "retain-mmo-client",
		phase: "PREPARING",
		attempt: 1,
		command: "scp",
		args: strictScpArgs(options.knownHostsPath, [
			`root@${generator.publicIpv4}:${authority.artifacts.generatorRemotePath}`,
			authority.artifacts.generatorRetainedPath,
		]),
	});

	await ssh(
		server,
		"hash-native-remote",
		`sha256sum ${shellQuote(authority.artifacts.nativeRemotePath)}`,
	);
	await run({
		operationId: "hash-native-local",
		phase: "PREPARING",
		attempt: 1,
		command: process.execPath,
		args: [
			"-e",
			'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; const path = process.argv.at(-1); process.stdout.write(createHash("sha256").update(readFileSync(path)).digest("hex") + "  " + path + "\\n");',
			authority.artifacts.nativeRetainedPath,
		],
	});
	await ssh(
		generator,
		"hash-generator-remote",
		`sha256sum ${shellQuote(authority.artifacts.generatorRemotePath)}`,
	);
	await run({
		operationId: "hash-generator-local",
		phase: "PREPARING",
		attempt: 1,
		command: process.execPath,
		args: [
			"-e",
			'import { createHash } from "node:crypto"; import { readFileSync } from "node:fs"; const path = process.argv.at(-1); process.stdout.write(createHash("sha256").update(readFileSync(path)).digest("hex") + "  " + path + "\\n");',
			authority.artifacts.generatorRetainedPath,
		],
	});

	const nativeRemoteHash = hashFromOutput(
		results.get("hash-native-remote")?.stdout ?? "",
		"hash-native-remote",
	);
	const nativeLocalHash = hashFromOutput(
		results.get("hash-native-local")?.stdout ?? "",
		"hash-native-local",
	);
	if (nativeRemoteHash !== nativeLocalHash) {
		fail("retained native-addon bytes do not match the remote binary");
	}
	const generatorRemoteHash = hashFromOutput(
		results.get("hash-generator-remote")?.stdout ?? "",
		"hash-generator-remote",
	);
	const generatorLocalHash = hashFromOutput(
		results.get("hash-generator-local")?.stdout ?? "",
		"hash-generator-local",
	);
	if (generatorRemoteHash !== generatorLocalHash) {
		fail("retained generator bytes do not match the remote binary");
	}

	const smokeCommand = (role: "server" | "generator"): string => {
		const commonEnvironment = [
			"G6_C32_SMOKE_MODE=production",
			`G6_C32_BUN_BIN=${authority.bun.binaryPath}`,
			`G6_C32_UNAME_BIN=${authority.linuxSmoke.unameBinaryPath}`,
			`G6_C32_TIMEOUT_BIN=${authority.linuxSmoke.timeoutBinaryPath}`,
		];
		const roleEnvironment =
			role === "server"
				? [
						`G6_C32_BOUNDED_PROBE=${authority.linuxSmoke.server.boundedProbePath}`,
						`G6_C32_STEERING_PROBE=${authority.linuxSmoke.server.steeringProbePath}`,
						`G6_C32_BPF_PROBE=${authority.linuxSmoke.server.bpfProbePath}`,
					]
				: [
						`G6_C32_FIXED_PORT_PROBE=${authority.linuxSmoke.generator.fixedPortProbePath}`,
						`G6_C32_BOUNDED_PROBE=${authority.linuxSmoke.generator.boundedProbePath}`,
					];
		return [
			"env",
			...[...commonEnvironment, ...roleEnvironment].map(shellQuote),
			shellQuote(authority.linuxSmoke.remoteScriptPath),
			role,
			shellQuote(`${authority.linuxSmoke.remoteEvidenceRoot}/${role}`),
		].join(" ");
	};
	await ssh(server, "linux-smoke-server", smokeCommand("server"));
	await ssh(generator, "linux-smoke-generator", smokeCommand("generator"));

	const retainedSmokeServer = join(
		authority.linuxSmoke.retainedEvidenceRoot,
		"server",
	);
	const retainedSmokeGenerator = join(
		authority.linuxSmoke.retainedEvidenceRoot,
		"generator",
	);
	if (existsSync(retainedSmokeServer) || existsSync(retainedSmokeGenerator)) {
		fail("retained Linux smoke evidence already exists; refusing replacement");
	}
	mkdirSync(authority.linuxSmoke.retainedEvidenceRoot, { recursive: true });
	await run({
		operationId: "retain-linux-smoke-server",
		phase: "PREPARING",
		attempt: 1,
		command: "scp",
		args: strictScpArgs(options.knownHostsPath, [
			"-r",
			`root@${server.publicIpv4}:${authority.linuxSmoke.remoteEvidenceRoot}/server`,
			retainedSmokeServer,
		]),
	});
	await run({
		operationId: "retain-linux-smoke-generator",
		phase: "PREPARING",
		attempt: 1,
		command: "scp",
		args: strictScpArgs(options.knownHostsPath, [
			"-r",
			`root@${generator.publicIpv4}:${authority.linuxSmoke.remoteEvidenceRoot}/generator`,
			retainedSmokeGenerator,
		]),
	});

	const receipt: HostPreparationReceipt = {
		schema: "g6-c32-host-preparation/1",
		envelope: {
			recordedAt: requireTimestamp(
				options.clock.wallNow(),
				"prepared.recordedAt",
			),
			sequence: operationReceipts.length + 1,
			runId: requireString(options.runId, "runId"),
			phase: "PREPARED",
			operationId: "prepare-hosts",
			clockSource: "offrunner",
		},
		hostIds: { server: server.id, generator: generator.id },
		binaryHashes: {
			nativeAddonSha256: nativeLocalHash,
			generatorSha256: generatorLocalHash,
		},
		operationReceipts,
	};
	publishBytes(
		options.receiptPath,
		canonicalJson(receipt),
		options.randomId ?? randomUUID,
	);
	return receipt;
}

function validateIdentityPacket(value: unknown): HostIdentityPacket {
	if (!isRecord(value)) fail("host identity packet must be an object");
	requireExactKeys(
		value,
		[
			"schema",
			"envelope",
			"provider",
			"bootId",
			"source",
			"runtime",
			"binary",
			"clock",
		],
		"host identity packet",
	);
	if (value.schema !== "g6-c32-host-identity/1") {
		fail("host identity packet schema is invalid");
	}
	const envelope = validateEnvelope(value.envelope);
	const provider = validateDropletIdentity(value.provider, "identity.provider");
	if (provider.role !== "server" && provider.role !== "generator") {
		fail("identity.provider.role must be concrete");
	}
	if (!isRecord(value.source)) fail("identity.source must be an object");
	requireExactKeys(
		value.source,
		["commit", "tree", "statusPorcelain"],
		"identity.source",
	);
	if (value.source.statusPorcelain !== "") {
		fail("identity source checkout is dirty");
	}
	if (!isRecord(value.runtime)) fail("identity.runtime must be an object");
	requireExactKeys(
		value.runtime,
		["os", "osRelease", "kernel", "bunVersion", "rustcVersion", "cargoVersion"],
		"identity.runtime",
	);
	if (!isRecord(value.binary)) fail("identity.binary must be an object");
	requireExactKeys(value.binary, ["kind", "path", "sha256"], "identity.binary");
	if (
		value.binary.kind !== "native-addon" &&
		value.binary.kind !== "mmo-client"
	) {
		fail("identity.binary.kind is invalid");
	}
	if (!isRecord(value.clock)) fail("identity.clock must be an object");
	requireExactKeys(
		value.clock,
		[
			"requestStartedAt",
			"responseFinishedAt",
			"remoteWallAt",
			"measuredSkewMilliseconds",
		],
		"identity.clock",
	);
	const requestStartedAt = requireTimestamp(
		value.clock.requestStartedAt,
		"identity.clock.requestStartedAt",
	);
	const responseFinishedAt = requireTimestamp(
		value.clock.responseFinishedAt,
		"identity.clock.responseFinishedAt",
	);
	const remoteWallAt = requireTimestamp(
		value.clock.remoteWallAt,
		"identity.clock.remoteWallAt",
	);
	if (Date.parse(responseFinishedAt) < Date.parse(requestStartedAt)) {
		fail("identity clock response precedes request");
	}
	if (
		typeof value.clock.measuredSkewMilliseconds !== "number" ||
		!Number.isSafeInteger(value.clock.measuredSkewMilliseconds)
	) {
		fail("identity clock skew must be a safe integer");
	}
	const midpoint =
		(Date.parse(requestStartedAt) + Date.parse(responseFinishedAt)) / 2;
	const measuredSkewMilliseconds = Math.round(
		Date.parse(remoteWallAt) - midpoint,
	);
	if (measuredSkewMilliseconds !== value.clock.measuredSkewMilliseconds) {
		fail("identity clock skew does not match its request/response bounds");
	}
	if (envelope.recordedAt !== remoteWallAt) {
		fail("identity timestamp must equal the measured remote wall time");
	}
	if (envelope.clockSource !== provider.role) {
		fail("identity clock source must match the host role");
	}
	if (typeof value.bootId !== "string" || !BOOT_ID_RE.test(value.bootId)) {
		fail("identity.bootId must be a lowercase UUID");
	}
	return {
		schema: "g6-c32-host-identity/1",
		envelope,
		provider,
		bootId: value.bootId,
		source: {
			commit: requireGitObject(value.source.commit, "identity.source.commit"),
			tree: requireGitObject(value.source.tree, "identity.source.tree"),
			statusPorcelain: "",
		},
		runtime: {
			os: requireString(value.runtime.os, "identity.runtime.os"),
			osRelease: requireString(
				value.runtime.osRelease,
				"identity.runtime.osRelease",
			),
			kernel: requireString(value.runtime.kernel, "identity.runtime.kernel"),
			bunVersion: requireString(
				value.runtime.bunVersion,
				"identity.runtime.bunVersion",
			),
			rustcVersion: requireString(
				value.runtime.rustcVersion,
				"identity.runtime.rustcVersion",
			),
			cargoVersion: requireString(
				value.runtime.cargoVersion,
				"identity.runtime.cargoVersion",
			),
		},
		binary: {
			kind: value.binary.kind,
			path: requireAbsolutePath(value.binary.path, "identity.binary.path"),
			sha256: requireHash(value.binary.sha256, "identity.binary.sha256"),
		},
		clock: {
			requestStartedAt,
			responseFinishedAt,
			remoteWallAt,
			measuredSkewMilliseconds,
		},
	};
}

export async function collectHostIdentityPacket(
	options: CollectHostIdentityOptions,
): Promise<CollectedHostIdentity> {
	if (!Number.isSafeInteger(options.sequence) || options.sequence < 1) {
		fail("identity sequence must be a positive safe integer");
	}
	if (
		!Number.isSafeInteger(options.maxClockSkewMilliseconds) ||
		options.maxClockSkewMilliseconds < 0
	) {
		fail("maxClockSkewMilliseconds must be a nonnegative safe integer");
	}
	if (
		options.remoteIdentityCommand.length === 0 ||
		options.remoteIdentityCommand.some(
			(value) => typeof value !== "string" || value.includes("\0"),
		)
	) {
		fail("remote identity command must contain NUL-free arguments");
	}
	const host = validateDropletIdentity(options.host, "identity host");
	if (host.role !== "server" && host.role !== "generator") {
		fail("identity host role must be concrete");
	}
	if (!existsSync(options.knownHostsPath)) {
		fail("known_hosts must exist before identity collection");
	}
	const operationId = `collect-identity-${host.role}`;
	const result = await options.runner.execute({
		operationId,
		phase: "BINDING",
		attempt: 1,
		command: "ssh",
		args: strictSshArgs(
			options.knownHostsPath,
			host.publicIpv4,
			options.remoteIdentityCommand,
		),
	});
	validateOperationTimes(result, operationId);
	if (!successful(result)) fail(`${operationId} failed`);
	if (result.receiptPath === null) {
		fail(`${operationId} did not retain an operation receipt`);
	}
	let remote: unknown;
	try {
		remote = JSON.parse(result.stdout) as unknown;
	} catch {
		fail(`${operationId} returned malformed JSON`);
	}
	if (!isRecord(remote)) fail("remote identity must be an object");
	requireExactKeys(
		remote,
		["schema", "observedAt", "bootId", "source", "runtime", "binary"],
		"remote identity",
	);
	if (remote.schema !== "g6-c32-remote-host-identity/1") {
		fail("remote identity schema is invalid");
	}
	const observedAt = requireTimestamp(
		remote.observedAt,
		"remote identity observedAt",
	);
	const midpoint =
		(Date.parse(result.startedAt) + Date.parse(result.finishedAt)) / 2;
	const measuredSkewMilliseconds = Math.round(
		Date.parse(observedAt) - midpoint,
	);
	if (Math.abs(measuredSkewMilliseconds) > options.maxClockSkewMilliseconds) {
		fail(`${host.role} clock skew exceeds the approved bound`);
	}
	const packet = validateIdentityPacket({
		schema: "g6-c32-host-identity/1",
		envelope: {
			recordedAt: observedAt,
			sequence: options.sequence,
			runId: requireString(options.runId, "runId"),
			phase: "BINDING",
			operationId,
			clockSource: host.role,
		},
		provider: host,
		bootId: remote.bootId,
		source: remote.source,
		runtime: remote.runtime,
		binary: remote.binary,
		clock: {
			requestStartedAt: result.startedAt,
			responseFinishedAt: result.finishedAt,
			remoteWallAt: observedAt,
			measuredSkewMilliseconds,
		},
	});
	return { packet, operationReceiptPath: result.receiptPath };
}

export function validateHostIdentityPair(
	options: ValidateHostIdentityPairOptions,
): HostIdentityPacket[] {
	if (
		!Number.isSafeInteger(options.maxClockSkewMilliseconds) ||
		options.maxClockSkewMilliseconds < 0
	) {
		fail("maxClockSkewMilliseconds must be a nonnegative safe integer");
	}
	const expectedHosts = orderedPair(options.expectedHosts);
	if (options.packets.length !== 2) {
		fail("identity binding requires exactly two packets");
	}
	const checked = options.packets.map(validateIdentityPacket);
	const byRole = new Map(
		checked.map((packet) => [packet.provider.role, packet]),
	);
	const ordered = expectedHosts.map((expected) => {
		const role = expected.role as "server" | "generator";
		const packet = byRole.get(role);
		if (!packet) fail(`identity packet for ${role} is missing`);
		if (canonicalJson(packet.provider) !== canonicalJson(expected)) {
			fail(`${role} provider identity mismatch`);
		}
		if (
			packet.envelope.runId !== options.runId ||
			packet.envelope.phase !== "BINDING" ||
			packet.envelope.operationId !== `collect-identity-${role}`
		) {
			fail(`${role} identity envelope mismatch`);
		}
		if (
			packet.source.commit !== options.expectedSource.commit ||
			packet.source.tree !== options.expectedSource.tree
		) {
			fail(`${role} source commit/tree mismatch`);
		}
		if (
			packet.runtime.os !== options.expectedRuntime.os ||
			packet.runtime.bunVersion !== options.expectedRuntime.bunVersion ||
			packet.runtime.rustcVersion !== options.expectedRuntime.rustcVersion ||
			packet.runtime.cargoVersion !== options.expectedRuntime.cargoVersion
		) {
			fail(`${role} runtime identity mismatch`);
		}
		if (
			Math.abs(packet.clock.measuredSkewMilliseconds) >
			options.maxClockSkewMilliseconds
		) {
			fail(`${role} clock skew exceeds the approved bound`);
		}
		const expectedKind = role === "server" ? "native-addon" : "mmo-client";
		if (packet.binary.kind !== expectedKind) {
			fail(`${role} binary kind mismatch`);
		}
		if (packet.binary.path !== options.expectedBinaryPaths[role]) {
			fail(`${role} binary path mismatch`);
		}
		const retainedPath = options.retainedBinaries[role];
		if (!existsSync(retainedPath)) {
			fail(`missing retained ${role} binary bytes`);
		}
		if (sha256(readFileSync(retainedPath)) !== packet.binary.sha256) {
			fail(`retained ${role} binary hash mismatch`);
		}
		return packet;
	});
	if (ordered[0]?.bootId === ordered[1]?.bootId) {
		fail("server and generator boot IDs must be distinct");
	}
	return ordered;
}
