import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outputRoot = path.join(root, ".release-evidence");
const schemaPath = path.join(root, "docs", "release-evidence.schema.json");
const headCommit = (await Bun.$`git rev-parse HEAD`.text()).trim();
const requiredRecordFields = [
	"commit",
	"platform",
	"toolchain",
	"command",
	"exitCode",
	"startedAt",
	"finishedAt",
	"artifactSha256",
] as const;

type Platform = {
	os: string;
	arch: string;
	runtime: string;
};

type Toolchain = {
	name: string;
	version: string;
};

type CommandRecord = {
	schemaVersion: 1;
	kind: "command";
	name: string;
	commit: string;
	platform: Platform;
	toolchain: Toolchain;
	command: string[];
	exitCode: number;
	startedAt: string;
	finishedAt: string;
	artifactSha256: string;
};

type SummaryRecord = {
	schemaVersion: 1;
	kind: "summary";
	commit: string;
	generatedAt: string;
	recordCount: number;
	records: Array<{
		name: string;
		path: string;
		artifactSha256: string;
	}>;
};

function fail(message: string): never {
	throw new Error(message);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string") {
		return false;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSha256(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertString(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || value.length === 0) {
		fail(`Expected ${field} to be a non-empty string`);
	}
}

function validatePlatform(value: unknown): Platform {
	if (!isObject(value)) {
		fail("Expected platform to be an object");
	}
	assertString(value.os, "platform.os");
	assertString(value.arch, "platform.arch");
	assertString(value.runtime, "platform.runtime");
	return {
		os: value.os,
		arch: value.arch,
		runtime: value.runtime,
	};
}

function validateToolchain(value: unknown): Toolchain {
	if (!isObject(value)) {
		fail("Expected toolchain to be an object");
	}
	assertString(value.name, "toolchain.name");
	assertString(value.version, "toolchain.version");
	return {
		name: value.name,
		version: value.version,
	};
}

function validateCommand(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		fail("Expected command to be a non-empty string array");
	}
	for (const [index, part] of value.entries()) {
		assertString(part, `command[${index}]`);
	}
	return [...value];
}

function validateCommandRecord(value: unknown): CommandRecord {
	if (!isObject(value)) {
		fail("Expected command record to be an object");
	}
	for (const field of requiredRecordFields) {
		if (!(field in value)) {
			fail(`Missing required field: ${field}`);
		}
	}
	if (value.schemaVersion !== 1) {
		fail("Expected schemaVersion to equal 1");
	}
	if (value.kind !== "command") {
		fail('Expected kind to equal "command"');
	}
	assertString(value.name, "name");
	assertString(value.commit, "commit");
	if (value.commit !== headCommit) {
		fail(`Commit ${value.commit} does not match HEAD ${headCommit}`);
	}
	const platform = validatePlatform(value.platform);
	const toolchain = validateToolchain(value.toolchain);
	const command = validateCommand(value.command);
	if (!Number.isInteger(value.exitCode)) {
		fail("Expected exitCode to be an integer");
	}
	if (!isIsoTimestamp(value.startedAt)) {
		fail("Expected startedAt to be an ISO-8601 timestamp");
	}
	if (!isIsoTimestamp(value.finishedAt)) {
		fail("Expected finishedAt to be an ISO-8601 timestamp");
	}
	if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
		fail("Expected finishedAt to be greater than or equal to startedAt");
	}
	if (!isSha256(value.artifactSha256)) {
		fail("Expected artifactSha256 to be a lowercase hex sha256");
	}
	return {
		schemaVersion: 1,
		kind: "command",
		name: value.name,
		commit: value.commit,
		platform,
		toolchain,
		command,
		exitCode: value.exitCode,
		startedAt: value.startedAt,
		finishedAt: value.finishedAt,
		artifactSha256: value.artifactSha256,
	};
}

function validateSummaryRecord(value: unknown): SummaryRecord {
	if (!isObject(value)) {
		fail("Expected summary record to be an object");
	}
	if (value.schemaVersion !== 1) {
		fail("Expected summary schemaVersion to equal 1");
	}
	if (value.kind !== "summary") {
		fail('Expected summary kind to equal "summary"');
	}
	assertString(value.commit, "commit");
	if (value.commit !== headCommit) {
		fail(`Summary commit ${value.commit} does not match HEAD ${headCommit}`);
	}
	if (!isIsoTimestamp(value.generatedAt)) {
		fail("Expected generatedAt to be an ISO-8601 timestamp");
	}
	if (!Number.isInteger(value.recordCount) || value.recordCount < 0) {
		fail("Expected recordCount to be a non-negative integer");
	}
	if (!Array.isArray(value.records)) {
		fail("Expected records to be an array");
	}
	const records = value.records.map((record, index) => {
		if (!isObject(record)) {
			fail(`Expected records[${index}] to be an object`);
		}
		assertString(record.name, `records[${index}].name`);
		assertString(record.path, `records[${index}].path`);
		if (!/^(commands\/)?[A-Za-z0-9._-]+\.json$/u.test(record.path)) {
			fail(`Expected records[${index}].path to stay under commands/`);
		}
		if (!isSha256(record.artifactSha256)) {
			fail(`Expected records[${index}].artifactSha256 to be sha256`);
		}
		return {
			name: record.name,
			path: record.path,
			artifactSha256: record.artifactSha256,
		};
	});
	if (records.length !== value.recordCount) {
		fail("Expected recordCount to match records.length");
	}
	return {
		schemaVersion: 1,
		kind: "summary",
		commit: value.commit,
		generatedAt: value.generatedAt,
		recordCount: value.recordCount,
		records,
	};
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function assertInsideOutput(targetPath: string): void {
	const resolvedRoot = path.resolve(outputRoot);
	const resolvedTarget = path.resolve(targetPath);
	if (
		resolvedTarget !== resolvedRoot &&
		!resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
	) {
		fail(`Refusing to access a path outside ${resolvedRoot}`);
	}
}

function resolveInsideOutput(
	relativePath: string,
	baseOutputRoot = outputRoot,
): string {
	assertInsideOutput(baseOutputRoot);
	const resolved = path.resolve(baseOutputRoot, relativePath);
	if (
		resolved !== baseOutputRoot &&
		!resolved.startsWith(`${baseOutputRoot}${path.sep}`)
	) {
		fail(`Refusing to write outside ${baseOutputRoot}`);
	}
	return resolved;
}

async function assertRegularDirectory(directoryPath: string): Promise<void> {
	const stat = await lstat(directoryPath);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		fail(
			`Expected a non-symlink directory inside ${outputRoot}: ${directoryPath}`,
		);
	}
}

async function ensureSafeDirectory(directoryPath: string): Promise<void> {
	const resolvedRoot = path.resolve(outputRoot);
	const resolvedDirectory = path.resolve(directoryPath);
	assertInsideOutput(resolvedDirectory);

	try {
		await mkdir(resolvedRoot);
	} catch (error) {
		if (!isNodeError(error) || error.code !== "EEXIST") {
			throw error;
		}
	}
	await assertRegularDirectory(resolvedRoot);
	if ((await realpath(resolvedRoot)) !== resolvedRoot) {
		fail(`Evidence root must not resolve outside itself: ${resolvedRoot}`);
	}

	let current = resolvedRoot;
	const relative = path.relative(resolvedRoot, resolvedDirectory);
	for (const component of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		try {
			await mkdir(current);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "EEXIST") {
				throw error;
			}
		}
		await assertRegularDirectory(current);
		const resolvedCurrent = await realpath(current);
		if (
			resolvedCurrent !== resolvedRoot &&
			!resolvedCurrent.startsWith(`${resolvedRoot}${path.sep}`)
		) {
			fail(`Directory resolves outside ${resolvedRoot}: ${current}`);
		}
	}
}

async function assertReplaceableRegularFile(targetPath: string): Promise<void> {
	try {
		const stat = await lstat(targetPath);
		if (stat.isSymbolicLink() || !stat.isFile()) {
			fail(`Refusing to replace a non-regular evidence file: ${targetPath}`);
		}
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
}

function normalizeSlug(slug: string): string {
	if (!/^[A-Za-z0-9._-]+$/u.test(slug)) {
		fail("Slug must match [A-Za-z0-9._-]+");
	}
	return slug;
}

function getCommandsDir(baseOutputRoot = outputRoot): string {
	return path.join(baseOutputRoot, "commands");
}

function getSummaryPath(baseOutputRoot = outputRoot): string {
	return path.join(baseOutputRoot, "summary.json");
}

async function ensureOutputDirs(baseOutputRoot = outputRoot): Promise<void> {
	await ensureSafeDirectory(getCommandsDir(baseOutputRoot));
}

async function writeJsonNew(
	targetPath: string,
	payload: unknown,
): Promise<void> {
	const resolvedTarget = path.resolve(targetPath);
	assertInsideOutput(resolvedTarget);
	await ensureSafeDirectory(path.dirname(resolvedTarget));
	let created = false;
	try {
		const handle = await open(
			resolvedTarget,
			fsConstants.O_WRONLY |
				fsConstants.O_CREAT |
				fsConstants.O_EXCL |
				fsConstants.O_NOFOLLOW,
			0o600,
		);
		created = true;
		try {
			await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (created) {
			await rm(resolvedTarget, { force: true });
		}
		throw error;
	}
}

async function writeJsonReplacingRegularFile(
	targetPath: string,
	payload: unknown,
): Promise<void> {
	const resolvedTarget = path.resolve(targetPath);
	assertInsideOutput(resolvedTarget);
	const parent = path.dirname(resolvedTarget);
	await ensureSafeDirectory(parent);
	await assertReplaceableRegularFile(resolvedTarget);

	const temporaryPath = path.join(
		parent,
		`.${path.basename(resolvedTarget)}.${randomUUID()}.tmp`,
	);
	try {
		await writeJsonNew(temporaryPath, payload);
		await ensureSafeDirectory(parent);
		await assertReplaceableRegularFile(resolvedTarget);
		await rename(temporaryPath, resolvedTarget);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

async function readJson(filePath: string): Promise<unknown> {
	return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeRecordFromFile(
	slug: string,
	inputPath: string,
	baseOutputRoot = outputRoot,
): Promise<string> {
	await ensureOutputDirs(baseOutputRoot);
	const input = await readJson(path.resolve(root, inputPath));
	const record = validateCommandRecord(input);
	const outputPath = resolveInsideOutput(
		path.join("commands", `${normalizeSlug(slug)}.json`),
		baseOutputRoot,
	);
	await writeJsonNew(outputPath, record);
	return outputPath;
}

async function writeSummary(baseOutputRoot = outputRoot): Promise<string> {
	await ensureOutputDirs(baseOutputRoot);
	const commandsDir = getCommandsDir(baseOutputRoot);
	const entries = (await readdir(commandsDir, { withFileTypes: true }))
		.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
		.map((entry) => entry.name)
		.sort();
	const records = [];
	for (const entry of entries) {
		const record = validateCommandRecord(
			await readJson(path.join(commandsDir, entry)),
		);
		records.push({
			name: record.name,
			path: `commands/${entry}`,
			artifactSha256: record.artifactSha256,
		});
	}
	const summary = validateSummaryRecord({
		schemaVersion: 1,
		kind: "summary",
		commit: headCommit,
		generatedAt: new Date().toISOString(),
		recordCount: records.length,
		records,
	});
	const summaryPath = getSummaryPath(baseOutputRoot);
	await writeJsonReplacingRegularFile(summaryPath, summary);
	return summaryPath;
}

async function runSelfTest(): Promise<void> {
	await readJson(schemaPath);
	const selfTestRoot = path.join(outputRoot, "self-test");
	const externalTestRoot = await mkdtemp(
		path.join(os.tmpdir(), "webtransport-release-evidence-"),
	);
	await rm(selfTestRoot, { recursive: true, force: true });
	try {
		await ensureOutputDirs(selfTestRoot);

		const validRecord: CommandRecord = {
			schemaVersion: 1,
			kind: "command",
			name: "self-test",
			commit: headCommit,
			platform: {
				os: os.platform(),
				arch: os.arch(),
				runtime: "bun",
			},
			toolchain: {
				name: "bun",
				version: Bun.version,
			},
			command: ["bun", "scripts/generate-release-evidence.ts", "--self-test"],
			exitCode: 0,
			startedAt: "2026-07-21T00:00:00.000Z",
			finishedAt: "2026-07-21T00:00:01.000Z",
			artifactSha256: createHash("sha256")
				.update("self-test-artifact")
				.digest("hex"),
		};

		validateCommandRecord(validRecord);

		for (const field of requiredRecordFields) {
			const invalid = { ...validRecord } as Record<string, unknown>;
			delete invalid[field];
			try {
				validateCommandRecord(invalid);
				fail(`Expected missing ${field} to fail validation`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes(field)) {
					fail(`Missing ${field} produced the wrong error: ${message}`);
				}
			}
		}

		try {
			validateCommandRecord({
				...validRecord,
				commit: "0000000000000000000000000000000000000000",
			});
			fail("Expected mismatched commit to fail validation");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("does not match HEAD")) {
				fail(`Mismatched commit produced the wrong error: ${message}`);
			}
		}

		const tempInputPath = path.join(selfTestRoot, "self-test-input.json");
		await writeJsonNew(tempInputPath, validRecord);
		const recordPath = await writeRecordFromFile(
			"self-test",
			tempInputPath,
			selfTestRoot,
		);
		const selfTestCommandsDir = getCommandsDir(selfTestRoot);
		if (!recordPath.startsWith(`${selfTestCommandsDir}${path.sep}`)) {
			fail(`Record path escaped commands dir: ${recordPath}`);
		}

		const writtenRecord = validateCommandRecord(await readJson(recordPath));
		if (writtenRecord.commit !== headCommit) {
			fail("Written record commit drifted");
		}

		try {
			resolveInsideOutput("../escape.json", selfTestRoot);
			fail("Expected path escape to be rejected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("outside")) {
				fail(`Escape rejection produced the wrong error: ${message}`);
			}
		}

		const externalTarget = path.join(externalTestRoot, "outside.json");
		await Bun.write(externalTarget, "outside remains unchanged\n");
		const destinationSymlink = path.join(
			selfTestCommandsDir,
			"symlink-destination.json",
		);
		await symlink(externalTarget, destinationSymlink);
		try {
			await writeRecordFromFile(
				"symlink-destination",
				tempInputPath,
				selfTestRoot,
			);
			fail("Expected a symlinked destination to be rejected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("EEXIST") && !message.includes("symlink")) {
				fail(`Symlink destination produced the wrong error: ${message}`);
			}
		}
		if (
			(await readFile(externalTarget, "utf8")) !== "outside remains unchanged\n"
		) {
			fail("Symlinked destination modified a file outside the evidence root");
		}

		const parentSymlink = path.join(selfTestRoot, "symlink-parent");
		await symlink(externalTestRoot, parentSymlink);
		try {
			await writeJsonNew(path.join(parentSymlink, "escaped.json"), validRecord);
			fail("Expected a symlinked parent to be rejected");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!message.includes("symlink")) {
				fail(`Symlink parent produced the wrong error: ${message}`);
			}
		}

		const writtenSummaryPath = await writeSummary(selfTestRoot);
		const writtenSummary = validateSummaryRecord(
			await readJson(writtenSummaryPath),
		);
		if (writtenSummary.recordCount !== 1) {
			fail(
				`Expected one self-test record, received ${writtenSummary.recordCount}`,
			);
		}
	} finally {
		await rm(selfTestRoot, { recursive: true, force: true });
		await rm(externalTestRoot, { recursive: true, force: true });
	}

	console.log("self-test: PASS");
}

function readFlag(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	if (index === -1) {
		return undefined;
	}
	return process.argv[index + 1];
}

async function main(): Promise<void> {
	if (process.argv.includes("--self-test")) {
		await runSelfTest();
		return;
	}

	const command = process.argv[2];
	if (command === "record") {
		const slug = readFlag("--slug");
		const input = readFlag("--input");
		if (!slug || !input) {
			fail(
				"Usage: bun scripts/generate-release-evidence.ts record --slug <slug> --input <json>",
			);
		}
		const outputPath = await writeRecordFromFile(slug, input);
		console.log(outputPath);
		return;
	}

	if (command === "summary") {
		const outputPath = await writeSummary();
		console.log(outputPath);
		return;
	}

	fail(
		[
			"Usage:",
			"  bun scripts/generate-release-evidence.ts --self-test",
			"  bun scripts/generate-release-evidence.ts record --slug <slug> --input <json>",
			"  bun scripts/generate-release-evidence.ts summary",
		].join("\n"),
	);
}

await main();
