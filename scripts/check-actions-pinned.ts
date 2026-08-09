#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const ROOT = resolve(
	process.env.CHECK_ACTIONS_PINNED_ROOT ?? resolve(import.meta.dir, ".."),
);
const WORKFLOW_DIR = resolve(ROOT, ".github", "workflows");
const TOOLCHAIN_PATH = resolve(ROOT, ".github", "release-toolchain.json");
const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/i;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RELEASE_ATTEMPT_ARTIFACT =
	"npm-publish-input-$" + "{{ steps.release-run.outputs.run_attempt }}";
const RELEASE_RUN_ID_EXPRESSION = "$" + "{{ env.RELEASE_RUN_ID }}";
const GITHUB_TOKEN_EXPRESSION = "$" + "{{ github.token }}";
const VERIFIED_TARBALL_EXPRESSION =
	"$" + "{{ steps.candidate.outputs.tarball }}";
const VERIFIED_DIGEST_EXPRESSION = "$" + "{{ steps.candidate.outputs.digest }}";
const RELEASE_RUN_ID_SOURCE =
	"$" + "{{ github.event.workflow_run.id || inputs.release_run_id }}";
const EXPECTED_COMMIT_SOURCE =
	"$" + "{{ steps.release-run.outputs.candidate_commit }}";
const EXPECTED_TAG_SOURCE = "$" + "{{ steps.release-run.outputs.release_tag }}";
const EXPECTED_ATTEMPT_SOURCE =
	"$" + "{{ steps.release-run.outputs.run_attempt }}";
const VERIFICATION_ONLY_PUBLISH_CONDITION =
	"$" + "{{ github.event_name != 'workflow_dispatch' }}";
const CAPTURE_BASELINE_CONDITION =
	"$" + "{{ inputs.capture_baseline == true }}";
const BENCHMARK_APPROVER_INPUT = "$" + "{{ inputs.benchmark_approver }}";
const EXACT_RELEASE_RUN_JQ_COMMAND = [
	"jq -e",
	'--argjson runId "$RELEASE_RUN_ID"',
	'--arg repository "$EXPECTED_REPOSITORY"',
	'--arg workflow "$EXPECTED_RELEASE_WORKFLOW"',
	`'.id == $runId and .event == "push" and .status == "completed" and .conclusion == "success" and .head_repository.full_name == $repository and ((.path == $workflow) or (.path | startswith($workflow + "@"))) and (.head_branch | test("^v[0-9]+\\\\.[0-9]+\\\\.[0-9]+([-.][0-9A-Za-z.-]+)?$")) and (.head_sha | test("^[0-9a-f]{40}$")) and (.run_attempt >= 1)'`,
	'"$RUN_JSON" >/dev/null || exit 1',
].join(" ");
const EXACT_CANDIDATE_JQ_COMMAND = [
	"jq -e",
	'--arg repository "$EXPECTED_REPOSITORY"',
	'--arg workflow "$EXPECTED_RELEASE_WORKFLOW"',
	'--argjson runId "$RELEASE_RUN_ID"',
	'--argjson attempt "$EXPECTED_ATTEMPT"',
	'--arg commit "$EXPECTED_COMMIT"',
	'--arg tag "$EXPECTED_TAG"',
	'--arg tarball "$TARBALL_NAME"',
	`'.schemaVersion == 1 and .repository == $repository and .workflowPath == $workflow and .releaseRunId == $runId and .releaseRunAttempt == $attempt and .candidateCommit == $commit and .tag == $tag and .tarball == $tarball and (.tarballSha256 | test("^[0-9a-f]{64}$"))'`,
	'"$IDENTITY" >/dev/null || exit 1',
].join(" ");
const EXACT_RELEASE_RUN_COMMANDS = [
	"set -euo pipefail",
	'if [ "$GITHUB_REPOSITORY" != "$EXPECTED_REPOSITORY" ]; then',
	'echo "::error::Refusing to publish from unexpected repository $GITHUB_REPOSITORY"',
	"exit 1",
	"fi",
	'case "$GITHUB_WORKFLOW_REF" in',
	'"$EXPECTED_REPOSITORY/$EXPECTED_PUBLISH_WORKFLOW"@*) ;;',
	"*)",
	'echo "::error::Unexpected publish workflow identity $GITHUB_WORKFLOW_REF"',
	"exit 1",
	";;",
	"esac",
	'if [[ ! "$RELEASE_RUN_ID" =~ ^[0-9]+$ ]]; then',
	'echo "::error::release_run_id must be numeric"',
	"exit 1",
	"fi",
	'RUN_JSON="$RUNNER_TEMP/release-run.json"',
	'gh api "repos/$GITHUB_REPOSITORY/actions/runs/$RELEASE_RUN_ID" > "$RUN_JSON"',
	EXACT_RELEASE_RUN_JQ_COMMAND,
	'echo "candidate_commit=$(jq -er \'.head_sha\' "$RUN_JSON")" >> "$GITHUB_OUTPUT"',
	'echo "release_tag=$(jq -er \'.head_branch\' "$RUN_JSON")" >> "$GITHUB_OUTPUT"',
	'echo "run_attempt=$(jq -er \'.run_attempt\' "$RUN_JSON")" >> "$GITHUB_OUTPUT"',
];
const EXACT_CANDIDATE_COMMANDS = [
	"set -euo pipefail",
	'INPUT_DIR="$RUNNER_TEMP/npm-publish-input"',
	'IDENTITY="$INPUT_DIR/candidate-identity.json"',
	'test -f "$IDENTITY"',
	"mapfile -t TARBALLS < <(find \"$INPUT_DIR\" -maxdepth 1 -name '*.tgz' -type f -print)",
	`if [ "\${#TARBALLS[@]}" -ne 1 ]; then`,
	`echo "::error::Expected exactly one downloaded tarball, found \${#TARBALLS[@]}"`,
	"exit 1",
	"fi",
	`TARBALL="\${TARBALLS[0]}"`,
	'TARBALL_NAME="$(basename "$TARBALL")"',
	'FILE_COUNT="$(find "$INPUT_DIR" -maxdepth 1 -type f | wc -l | tr -d \' \')"',
	'if [ "$FILE_COUNT" -ne 2 ]; then',
	'echo "::error::npm-publish-input must contain only candidate identity and one tarball"',
	"exit 1",
	"fi",
	EXACT_CANDIDATE_JQ_COMMAND,
	'EXPECTED_DIGEST="$(jq -er \'.tarballSha256\' "$IDENTITY")"',
	'ACTUAL_DIGEST="$(shasum -a 256 "$TARBALL" | cut -d\' \' -f1)"',
	'if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then',
	'echo "::error::Downloaded tarball digest does not match candidate identity"',
	"exit 1",
	"fi",
	'echo "commit=$EXPECTED_COMMIT" >> "$GITHUB_OUTPUT"',
	'echo "tag=$EXPECTED_TAG" >> "$GITHUB_OUTPUT"',
	'echo "tarball=$TARBALL" >> "$GITHUB_OUTPUT"',
	'echo "digest=$EXPECTED_DIGEST" >> "$GITHUB_OUTPUT"',
];
const EXACT_PUBLISH_JOB_ENV = [
	["RELEASE_RUN_ID", RELEASE_RUN_ID_SOURCE],
	["EXPECTED_REPOSITORY", "vmeansdev/webtransport-bun"],
	["EXPECTED_PUBLISH_WORKFLOW", ".github/workflows/publish.yml"],
	["EXPECTED_RELEASE_WORKFLOW", ".github/workflows/release.yml"],
] as const;
const EXACT_RELEASE_RUN_ENV = [["GH_TOKEN", GITHUB_TOKEN_EXPRESSION]] as const;
const EXACT_CANDIDATE_ENV = [
	["EXPECTED_COMMIT", EXPECTED_COMMIT_SOURCE],
	["EXPECTED_TAG", EXPECTED_TAG_SOURCE],
	["EXPECTED_ATTEMPT", EXPECTED_ATTEMPT_SOURCE],
] as const;

type Violation = { file: string; line: number; message: string };
type ReleaseToolchain = {
	schemaVersion: 1;
	bun: string[];
	rust: string[];
	rustNightly: string[];
	node: string[];
	deno: string[];
	python: string[];
	npm: string[];
	wasmBindgen: string[];
	cargoAudit: string[];
	cargoFuzz: string[];
	cargoLlvmCov: string[];
	napiRsCli: string[];
	playwright: string[];
	wbn: string[];
	wbnSign: string[];
};

function loadToolchain(): ReleaseToolchain {
	if (!existsSync(TOOLCHAIN_PATH)) {
		throw new Error(`missing release toolchain policy: ${TOOLCHAIN_PATH}`);
	}
	const parsed = JSON.parse(
		readFileSync(TOOLCHAIN_PATH, "utf8"),
	) as ReleaseToolchain;
	if (parsed.schemaVersion !== 1) {
		throw new Error(
			`unsupported release toolchain schema: ${parsed.schemaVersion}`,
		);
	}
	for (const [tool, versions] of Object.entries(parsed)) {
		if (tool === "schemaVersion") continue;
		const exactVersion =
			tool === "rustNightly" ? /^nightly-\d{4}-\d{2}-\d{2}$/ : EXACT_SEMVER;
		if (
			!Array.isArray(versions) ||
			versions.length === 0 ||
			!versions.every((version) => exactVersion.test(String(version)))
		) {
			throw new Error(`${tool} must list one or more exact versions`);
		}
	}
	return parsed;
}

const TOOLCHAIN = loadToolchain();

function approvedVersions(key: string): string[] {
	if (key === "toolchain") {
		return [...TOOLCHAIN.rust, ...TOOLCHAIN.rustNightly];
	}
	const mapping: Record<string, keyof ReleaseToolchain> = {
		"bun-version": "bun",
		"node-version": "node",
		"deno-version": "deno",
		"python-version": "python",
		toolchain: "rust",
	};
	const tool = mapping[key];
	return tool ? (TOOLCHAIN[tool] as string[]) : [];
}

function scalar(value: string): string {
	return value
		.trim()
		.replace(/\s+#.*$/, "")
		.replace(/^['"]|['"]$/g, "");
}

function workflowFiles(): string[] {
	if (!existsSync(WORKFLOW_DIR)) return [];
	return readdirSync(WORKFLOW_DIR)
		.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
		.sort()
		.map((name) => resolve(WORKFLOW_DIR, name));
}

function actionPinViolation(request: string): string | undefined {
	if (request.startsWith("./")) return undefined;
	if (request.startsWith("docker://")) {
		const digest = request.split("@").at(-1) ?? "";
		return SHA256.test(digest)
			? undefined
			: "container actions must use an immutable sha256 digest";
	}
	const separator = request.lastIndexOf("@");
	if (separator <= 0 || !SHA40.test(request.slice(separator + 1))) {
		return "third-party actions must be pinned to a 40-character commit SHA";
	}
	return undefined;
}

function exactVersionViolation(
	key: string,
	value: string,
	lines: string[],
): string | undefined {
	const normalized = scalar(value);
	const exactVersion =
		key === "toolchain"
			? /^(?:\d+\.\d+\.\d+|nightly-\d{4}-\d{2}-\d{2})$/
			: EXACT_SEMVER;
	const matrixReference = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(
		normalized,
	)?.[1];
	if (matrixReference) {
		const escaped = matrixReference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const matrixValues = lines
			.map(
				(line) =>
					new RegExp(`^\\s+${escaped}:\\s*\\[(.+)\\]\\s*(?:#.*)?$`).exec(
						line,
					)?.[1],
			)
			.find(Boolean);
		if (matrixValues) {
			const values = matrixValues.split(",").map(scalar);
			const approved = approvedVersions(key);
			if (
				values.length > 0 &&
				values.every(
					(candidate) =>
						exactVersion.test(candidate) && approved.includes(candidate),
				)
			) {
				return undefined;
			}
		}
		const includeValues = lines
			.map(
				(line) =>
					new RegExp(`^\\s+${escaped}:\\s*(.+?)\\s*(?:#.*)?$`).exec(line)?.[1],
			)
			.map((candidate) => (candidate ? scalar(candidate) : undefined))
			.filter(
				(candidate): candidate is string =>
					typeof candidate === "string" && exactVersion.test(candidate),
			);
		const approved = approvedVersions(key);
		if (
			includeValues.length > 0 &&
			includeValues.every((candidate) => approved.includes(candidate))
		) {
			return undefined;
		}
		return `${key} matrix ${matrixReference} must contain only exact three-part versions`;
	}
	if (!exactVersion.test(normalized)) {
		return key === "toolchain"
			? `${key} must be an exact approved version, not ${JSON.stringify(normalized)}`
			: `${key} must be an exact three-part version, not ${JSON.stringify(normalized)}`;
	}
	const approved = approvedVersions(key);
	if (!approved.includes(normalized)) {
		return `${key} ${normalized} is not listed in ${TOOLCHAIN_PATH}`;
	}
	return undefined;
}

function commandVersionViolation(line: string): string | undefined {
	const cargoInstall =
		/\bcargo install (cargo-audit|wasm-bindgen-cli|cargo-llvm-cov|cargo-fuzz)\b[^\n]*--version\s+(\d+\.\d+\.\d+)\b/.exec(
			line,
		);
	if (cargoInstall?.[1] && cargoInstall[2]) {
		const approved = {
			"cargo-audit": TOOLCHAIN.cargoAudit,
			"wasm-bindgen-cli": TOOLCHAIN.wasmBindgen,
			"cargo-llvm-cov": TOOLCHAIN.cargoLlvmCov,
			"cargo-fuzz": TOOLCHAIN.cargoFuzz,
		}[cargoInstall[1]];
		if (!approved) return `unsupported release tool ${cargoInstall[1]}`;
		if (!approved.includes(cargoInstall[2])) {
			return `${cargoInstall[1]} ${cargoInstall[2]} is not listed in ${TOOLCHAIN_PATH}`;
		}
	}
	const npmInstall =
		/\bnpm\s+install\s+(?:--global|-g)\s+npm@(\d+\.\d+\.\d+)\b/.exec(line)?.[1];
	if (npmInstall && !TOOLCHAIN.npm.includes(npmInstall)) {
		return `npm ${npmInstall} is not listed in ${TOOLCHAIN_PATH}`;
	}
	const playwright = /\b(?:bunx|npx)\s+playwright@(\d+\.\d+\.\d+)\b/.exec(
		line,
	)?.[1];
	if (playwright && !TOOLCHAIN.playwright.includes(playwright)) {
		return `Playwright ${playwright} is not listed in ${TOOLCHAIN_PATH}`;
	}
	const napiRsCli = /@napi-rs\/cli@(\d+\.\d+\.\d+)\b/.exec(line)?.[1];
	if (napiRsCli && !TOOLCHAIN.napiRsCli.includes(napiRsCli)) {
		return `@napi-rs/cli ${napiRsCli} is not listed in ${TOOLCHAIN_PATH}`;
	}
	return undefined;
}

function iwaPackagingToolsViolation(line: string): string | undefined {
	const install = /\bnpm\s+(?:i|install)\s+(.+)$/.exec(line);
	if (!install?.[1]) return undefined;
	const requested = install[1].trim().split(/\s+/);
	const required: Array<[string, string[]]> = [
		["wbn", TOOLCHAIN.wbn],
		["wbn-sign", TOOLCHAIN.wbnSign],
		["playwright", TOOLCHAIN.playwright],
	];
	const relevant = required.filter(([name]) =>
		requested.some((value) => value === name || value.startsWith(`${name}@`)),
	);
	if (relevant.length === 0) return undefined;
	for (const [name, approved] of relevant) {
		const token = requested.find(
			(value) => value === name || value.startsWith(`${name}@`),
		);
		const version = token?.slice(name.length + 1);
		if (
			!version ||
			!EXACT_SEMVER.test(version) ||
			!approved.includes(version)
		) {
			return "IWA packaging tools must use exact allowlisted versions";
		}
	}
	return undefined;
}

function jobBlocks(
	lines: string[],
): Array<{ name: string; start: number; end: number }> {
	const jobsLine = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
	if (jobsLine < 0) return [];
	const starts: Array<{ name: string; start: number }> = [];
	for (let index = jobsLine + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (/^\S/.test(line) && line.trim() && !line.trimStart().startsWith("#"))
			break;
		const match = /^ {2}([A-Za-z0-9_-]+):\s*(?:#.*)?$/.exec(line);
		if (match?.[1]) starts.push({ name: match[1], start: index });
	}
	return starts.map((entry, index) => ({
		...entry,
		end: (starts[index + 1]?.start ?? lines.length) - 1,
	}));
}

type JobBlock = ReturnType<typeof jobBlocks>[number];
type StepBlock = { start: number; end: number; lines: string[] };

function stepBlocks(lines: string[], job: JobBlock): StepBlock[] {
	const starts: number[] = [];
	for (let index = job.start; index <= job.end; index += 1) {
		if (/^ {6}-\s+/.test(lines[index] ?? "")) starts.push(index);
	}
	return starts.map((start, index) => {
		const end = (starts[index + 1] ?? job.end + 1) - 1;
		return { start, end, lines: lines.slice(start, end + 1) };
	});
}

function stepScalar(step: StepBlock, key: string): string | undefined {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (let offset = 0; offset < step.lines.length; offset += 1) {
		const prefix = offset === 0 ? "^ {6}-\\s+" : "^ {8}";
		const value = new RegExp(`${prefix}${escaped}:\\s*(.*?)\\s*$`).exec(
			step.lines[offset] ?? "",
		)?.[1];
		if (value !== undefined) return scalar(value);
	}
	return undefined;
}

function stepSection(step: StepBlock, section: string): Map<string, string> {
	const values = new Map<string, string>();
	const sectionLine = step.lines.findIndex((line) =>
		new RegExp(`^ {8}${section}:\\s*(?:#.*)?$`).test(line),
	);
	if (sectionLine < 0) return values;
	for (let offset = sectionLine + 1; offset < step.lines.length; offset += 1) {
		const line = step.lines[offset] ?? "";
		if (line.trim() && !/^ {10}/.test(line)) break;
		if (line.trimStart().startsWith("#")) continue;
		const entry = /^ {10}([^:\s][^:]*):\s*(.*?)\s*$/.exec(line);
		if (entry?.[1] && entry[2] !== undefined) {
			values.set(scalar(entry[1]), scalar(entry[2]));
		}
	}
	return values;
}

function jobSection(
	lines: string[],
	job: JobBlock,
	section: string,
): Map<string, string> {
	const values = new Map<string, string>();
	let sectionLine = -1;
	for (let index = job.start; index <= job.end; index += 1) {
		if (new RegExp(`^ {4}${section}:\\s*(?:#.*)?$`).test(lines[index] ?? "")) {
			sectionLine = index;
			break;
		}
	}
	if (sectionLine < 0) return values;
	for (let index = sectionLine + 1; index <= job.end; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() && !/^ {6}/.test(line)) break;
		if (line.trimStart().startsWith("#")) continue;
		const entry = /^ {6}([^:\s][^:]*):\s*(.*?)\s*$/.exec(line);
		if (entry?.[1] && entry[2] !== undefined) {
			values.set(scalar(entry[1]), scalar(entry[2]));
		}
	}
	return values;
}

function stepRun(step: StepBlock): string {
	for (let offset = 0; offset < step.lines.length; offset += 1) {
		const line = step.lines[offset] ?? "";
		const match = (
			offset === 0 ? /^ {6}-\s+run:\s*(.*?)\s*$/ : /^ {8}run:\s*(.*?)\s*$/
		).exec(line);
		if (!match) continue;
		const value = match[1] ?? "";
		if (value !== "|" && value !== ">" && value !== "|-" && value !== ">-") {
			return scalar(value);
		}
		const body: string[] = [];
		for (
			let bodyOffset = offset + 1;
			bodyOffset < step.lines.length;
			bodyOffset += 1
		) {
			const bodyLine = step.lines[bodyOffset] ?? "";
			if (bodyLine.trim() && !/^ {10}/.test(bodyLine)) break;
			body.push(bodyLine.startsWith("          ") ? bodyLine.slice(10) : "");
		}
		return body.join("\n");
	}
	return "";
}

function commandLines(step: StepBlock): string[] {
	return stepRun(step)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function logicalCommands(step: StepBlock): string[] {
	const commands: string[] = [];
	let continued = "";
	for (const line of commandLines(step)) {
		const fragment = line.endsWith("\\") ? line.slice(0, -1).trimEnd() : line;
		continued = continued ? `${continued} ${fragment}` : fragment;
		if (!line.endsWith("\\")) {
			commands.push(continued);
			continued = "";
		}
	}
	if (continued) commands.push(continued);
	return commands;
}

function usesCanonicalMappingKeys(lines: string[]): boolean {
	return !lines.some((line) => {
		const quotedKey =
			/^\s*(?:-\s*)?(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:/.test(line);
		const explicitKey = /^\s*\?\s+/.test(line);
		const mergeKey = /^\s*<<\s*:/.test(line);
		const decoratedKey = /^\s*(?:-\s*)?(?:(?:!\S+|&\S+)\s+)+.+\s*:/.test(line);
		const aliasedKey = /^\s*(?:-\s*)?\*\S+\s*:/.test(line);
		return quotedKey || explicitKey || mergeKey || decoratedKey || aliasedKey;
	});
}

function hasExactCommands(
	actual: string[],
	expected: readonly string[],
): boolean {
	return (
		actual.length === expected.length &&
		expected.every((command, index) => actual[index] === command)
	);
}

function hasExactEntries(
	actual: Map<string, string>,
	expected: ReadonlyArray<readonly [string, string]>,
): boolean {
	return (
		actual.size === expected.length &&
		expected.every(([key, value]) => actual.get(key) === value)
	);
}

function immediatelyRechecksDigest(
	step: StepBlock,
	publishCommand: string,
): boolean {
	const commands = commandLines(step);
	const publishIndex = commands.indexOf(publishCommand);
	if (publishIndex < 7) return false;
	const fiIndex = publishIndex - 1;
	const ifIndex = commands.findLastIndex(
		(command, index) =>
			index < fiIndex &&
			/^if\s+\[\s*"\$EXPECTED_DIGEST"\s*!=\s*"\$BOUND_DIGEST"\s*\]\s*\|\|\s*\[\s*"\$ACTUAL_DIGEST"\s*!=\s*"\$BOUND_DIGEST"\s*\]\s*;\s*then$/.test(
				command,
			),
	);
	if (ifIndex < 3 || commands[fiIndex] !== "fi") return false;
	const identityIndex = ifIndex - 3;
	const expectedIndex = ifIndex - 2;
	const actualIndex = ifIndex - 1;
	if (
		!/^IDENTITY=["']\$RUNNER_TEMP\/npm-publish-input\/candidate-identity\.json["']$/.test(
			commands[identityIndex] ?? "",
		) ||
		!/^EXPECTED_DIGEST=.*\bjq\s+-er\b.*\.tarballSha256.*["']\$IDENTITY["'].*$/.test(
			commands[expectedIndex] ?? "",
		) ||
		!/^ACTUAL_DIGEST=.*\b(?:shasum\s+-a\s+256|sha256sum)\b.*["']\$TARBALL["'].*$/.test(
			commands[actualIndex] ?? "",
		)
	) {
		return false;
	}
	const guarded = commands.slice(ifIndex + 1, fiIndex);
	return (
		guarded.length >= 1 &&
		guarded.at(-1) === "exit 1" &&
		guarded.slice(0, -1).every((command) => /^echo\s+/.test(command))
	);
}

function jobScalar(lines: string[], job: JobBlock, key: string): string {
	const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	for (let index = job.start; index <= job.end; index += 1) {
		const value = new RegExp(`^ {4}${escaped}:\\s*(.*?)\\s*$`).exec(
			lines[index] ?? "",
		)?.[1];
		if (value === undefined) continue;
		if (value !== "|" && value !== ">" && value !== "|-" && value !== ">-") {
			return scalar(value);
		}
		const body: string[] = [];
		for (let offset = index + 1; offset <= job.end; offset += 1) {
			const line = lines[offset] ?? "";
			if (line.trim() && !/^ {6}/.test(line)) break;
			if (line.trimStart().startsWith("#")) continue;
			body.push(line.startsWith("      ") ? line.slice(6) : "");
		}
		return body.join("\n");
	}
	return "";
}

function workflowTriggerBlock(lines: string[], trigger: string): string[] {
	const start = lines.findIndex((line) =>
		new RegExp(`^ {2}${trigger}:\\s*(?:#.*)?$`).test(line),
	);
	if (start < 0) return [];
	let end = lines.length;
	for (let index = start + 1; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (line.trim() && !/^ {4}/.test(line)) {
			end = index;
			break;
		}
	}
	return lines.slice(start, end);
}

function validatePublishHandoff(
	lines: string[],
	jobs: JobBlock[],
	add: (line: number, message: string) => void,
): void {
	const workflowRunBlock = workflowTriggerBlock(lines, "workflow_run");
	const workflowDispatchBlock = workflowTriggerBlock(
		lines,
		"workflow_dispatch",
	);
	const workflowRun =
		workflowRunBlock.some((line) =>
			/^ {4}workflows:\s*\[release\]\s*$/.test(line),
		) &&
		workflowRunBlock.some((line) =>
			/^ {4}types:\s*\[completed\]\s*$/.test(line),
		);
	const workflowDispatch = workflowDispatchBlock.length > 0;
	const releaseRunInput = workflowDispatchBlock.some((line) =>
		/^ {6}release_run_id:\s*$/.test(line),
	);
	const publishJobs = jobs.filter((job) =>
		stepBlocks(lines, job).some((step) =>
			commandLines(step).some((line) => /\b(?:npm|bun)\s+publish\b/.test(line)),
		),
	);
	const job = publishJobs.length === 1 ? publishJobs[0] : undefined;
	const block = job ? lines.slice(job.start, job.end + 1) : [];
	const jobCondition = job ? jobScalar(lines, job, "if") : "";
	const manualMainOnly =
		/github\.event_name\s*==\s*['"]workflow_dispatch['"]/.test(jobCondition) &&
		/github\.ref\s*==\s*['"]refs\/heads\/main['"]/.test(jobCondition);
	let structured =
		workflowRun &&
		workflowDispatch &&
		releaseRunInput &&
		publishJobs.length === 1 &&
		Boolean(job) &&
		manualMainOnly &&
		hasPermission(block, "actions", "read");

	if (!job) {
		add(0, "publish must consume an exact release workflow-run artifact");
		add(0, "publish must use a structured immutable publish handoff");
		return;
	}

	const steps = stepBlocks(lines, job);
	const downloads = steps.filter((step) =>
		/^actions\/download-artifact@[0-9a-f]{40}$/i.test(
			stepScalar(step, "uses") ?? "",
		),
	);
	const download = downloads.length === 1 ? downloads[0] : undefined;
	const downloadInputs = download ? stepSection(download, "with") : new Map();
	const exactDownload =
		Boolean(download) &&
		stepScalar(download as StepBlock, "if") === undefined &&
		downloadInputs.get("name") === RELEASE_ATTEMPT_ARTIFACT &&
		downloadInputs.get("run-id") === RELEASE_RUN_ID_EXPRESSION &&
		downloadInputs.get("github-token") === GITHUB_TOKEN_EXPRESSION;
	structured &&= exactDownload;

	if (!structured) {
		add(
			job.start,
			"publish must consume an exact release workflow-run artifact",
		);
		add(job.start, "publish must use a structured immutable publish handoff");
	}

	const candidateSteps = steps.filter(
		(step) => stepScalar(step, "id") === "candidate",
	);
	const candidate = candidateSteps.length === 1 ? candidateSteps[0] : undefined;
	const releaseRunSteps = steps.filter(
		(step) => stepScalar(step, "id") === "release-run",
	);
	const releaseRun =
		releaseRunSteps.length === 1 ? releaseRunSteps[0] : undefined;
	const releaseRunCommands = releaseRun ? logicalCommands(releaseRun) : [];
	const candidateCommands = candidate ? logicalCommands(candidate) : [];
	const publishJobEnvironment = jobSection(lines, job, "env");
	const releaseRunEnvironment = releaseRun
		? stepSection(releaseRun, "env")
		: new Map<string, string>();
	const candidateEnvironment = candidate
		? stepSection(candidate, "env")
		: new Map<string, string>();
	const canonicalMappingKeys = usesCanonicalMappingKeys(lines);
	const noWorkflowEnvironment = !lines.some((line) => /^env:\s*/.test(line));
	const noRunDefaults =
		!lines.some((line) => /^defaults:\s*/.test(line)) &&
		!block.some((line) => /^ {4}defaults:\s*/.test(line));
	const liveReleaseRunDataflow =
		canonicalMappingKeys &&
		noWorkflowEnvironment &&
		noRunDefaults &&
		hasExactEntries(publishJobEnvironment, EXACT_PUBLISH_JOB_ENV) &&
		Boolean(releaseRun) &&
		stepScalar(releaseRun as StepBlock, "if") === undefined &&
		stepScalar(releaseRun as StepBlock, "shell") === undefined &&
		stepScalar(releaseRun as StepBlock, "continue-on-error") === undefined &&
		stepScalar(releaseRun as StepBlock, "working-directory") === undefined &&
		Boolean(download) &&
		(releaseRun as StepBlock).start < (download as StepBlock).start &&
		Boolean(candidate) &&
		(releaseRun as StepBlock).start < (candidate as StepBlock).start &&
		hasExactEntries(releaseRunEnvironment, EXACT_RELEASE_RUN_ENV) &&
		hasExactCommands(releaseRunCommands, EXACT_RELEASE_RUN_COMMANDS) &&
		hasExactEntries(candidateEnvironment, EXACT_CANDIDATE_ENV);
	if (!liveReleaseRunDataflow) {
		add(job.start, "publish must use live release-run metadata dataflow");
	}
	const candidateVerified =
		Boolean(candidate) &&
		stepScalar(candidate as StepBlock, "if") === undefined &&
		stepScalar(candidate as StepBlock, "shell") === undefined &&
		stepScalar(candidate as StepBlock, "continue-on-error") === undefined &&
		stepScalar(candidate as StepBlock, "working-directory") === undefined &&
		Boolean(download) &&
		(candidate as StepBlock).start > (download as StepBlock).start &&
		hasExactEntries(candidateEnvironment, EXACT_CANDIDATE_ENV) &&
		hasExactCommands(candidateCommands, EXACT_CANDIDATE_COMMANDS);
	if (!candidateVerified) {
		add(
			job.start,
			"publish must perform candidate identity and digest verification",
		);
	}

	const allCommands = steps.flatMap((step) =>
		commandLines(step).map((command) => ({ command, step })),
	);
	const alternateAcquisition = allCommands.some(({ command }) => {
		if (/\b(?:curl|wget)\b/.test(command)) return true;
		if (/\bgh\s+release\s+download\b/.test(command)) return true;
		if (/\bapi\.github\.com\/.*releases\b/.test(command)) return true;
		if (/\bgh\s+api\b/.test(command) && !/\/actions\/runs\//.test(command)) {
			return true;
		}
		return false;
	});
	const allowedActions = [
		"actions/download-artifact",
		"actions/checkout",
		"oven-sh/setup-bun",
		"actions/setup-node",
		"denoland/setup-deno",
	];
	const alternateAction = steps.some((step) => {
		const uses = stepScalar(step, "uses");
		if (!uses) return false;
		if (uses.startsWith("./") || uses.startsWith("docker://")) return true;
		const action = uses.slice(0, uses.lastIndexOf("@"));
		return !allowedActions.includes(action);
	});
	if (alternateAcquisition || alternateAction) {
		add(job.start, "publish job uses forbidden alternate package acquisition");
	}

	const rebuilds = allCommands.some(({ command }) =>
		/(?:test-package-artifact\.ts\s+build\b|\bartifact:build\b|\b(?:npm|bun)\s+(?:run\s+)?build\b|\bnpm\s+pack\b)/.test(
			command,
		),
	);
	const publishCommands = allCommands.filter(({ command }) =>
		/\b(?:npm|bun)\s+publish\b/.test(command),
	);
	const canonicalPublishes = publishCommands.filter(({ command }) =>
		/^(?:npm|bun)\s+publish\b/.test(command),
	);
	const finalPublishes = canonicalPublishes.filter(
		({ command }) => !/\s--dry-run(?:\s|$)/.test(command),
	);
	const publishUsesVerifiedTarball = canonicalPublishes.every(
		({ command, step }) =>
			stepScalar(step, "if") === undefined &&
			stepSection(step, "env").get("TARBALL") === VERIFIED_TARBALL_EXPRESSION &&
			stepSection(step, "env").get("BOUND_DIGEST") ===
				VERIFIED_DIGEST_EXPRESSION &&
			/^(?:npm|bun)\s+publish\s+(?:"\$TARBALL"|'\$TARBALL'|\$TARBALL|"\$\{TARBALL\}"|'\$\{TARBALL\}'|\$\{TARBALL\})(?:\s|$)/.test(
				command,
			),
	);
	const publishImmediatelyRechecksDigest = canonicalPublishes.every(
		({ command, step }) => immediatelyRechecksDigest(step, command),
	);
	if (!publishImmediatelyRechecksDigest) {
		add(
			job.start,
			"publish steps must immediately re-verify candidate digest before npm publish",
		);
	}
	const finalPublish = finalPublishes[0];
	const finalPublishValid =
		publishCommands.length === canonicalPublishes.length &&
		finalPublishes.length === 1 &&
		publishUsesVerifiedTarball &&
		publishImmediatelyRechecksDigest &&
		canonicalPublishes.every(
			({ step }) => step.start > (candidate?.start ?? Number.MAX_SAFE_INTEGER),
		) &&
		Boolean(candidate) &&
		(finalPublish?.step.start ?? -1) >
			(candidate?.start ?? Number.MAX_SAFE_INTEGER) &&
		/\s--provenance(?:\s|$)/.test(finalPublish?.command ?? "");
	if (rebuilds || !finalPublishValid) {
		add(
			job.start,
			"publish job must not rebuild or replace the verified tarball",
		);
	}
}

function validateBenchmarkCaptureWorkflow(
	lines: string[],
	jobs: JobBlock[],
	add: (line: number, message: string) => void,
): void {
	const dispatch = workflowTriggerBlock(lines, "workflow_dispatch").join("\n");
	const workflowCall = workflowTriggerBlock(lines, "workflow_call").join("\n");
	const capture = jobs.find((job) => job.name === "capture");
	const block = capture ? lines.slice(capture.start, capture.end + 1) : [];
	const text = block.join("\n");
	const validInput =
		/^ {6}approver:\s*$/m.test(dispatch) &&
		/^ {8}required:\s*true\s*$/m.test(dispatch) &&
		/^ {8}type:\s*string\s*$/m.test(dispatch) &&
		/^ {6}approver:\s*$/m.test(workflowCall) &&
		/^ {8}required:\s*true\s*$/m.test(workflowCall) &&
		/^ {8}type:\s*string\s*$/m.test(workflowCall);
	const authenticatedApprover =
		/BENCH_BASELINE_APPROVER:\s*\$\{\{ github\.actor \}\}/.test(text) &&
		/INPUT_APPROVER:\s*\$\{\{ inputs\.approver \}\}/.test(text) &&
		/AUTHENTICATED_ACTOR:\s*\$\{\{ github\.actor \}\}/.test(text) &&
		/test "\$INPUT_APPROVER" = "\$AUTHENTICATED_ACTOR"/.test(text);
	const stableRunner =
		/BENCH_MACHINE_IDENTITY:\s*github-actions-ubuntu-latest-x64/.test(text);
	const fullCheckout = /fetch-depth:\s*0/.test(text);
	const captureOnly =
		/bun run bench:capture/.test(text) &&
		/tools\/bench\/baselines\/\*\.json/.test(text) &&
		/tools\/bench\/approved-baselines\.json/.test(text) &&
		!/(?:\bgit\s+(?:commit|push)\b|softprops\/action-gh-release|\bgh\s+release\b)/.test(
			text,
		);
	if (
		!capture ||
		!validInput ||
		!authenticatedApprover ||
		!stableRunner ||
		!fullCheckout ||
		!captureOnly
	) {
		add(
			capture?.start ?? 0,
			"benchmark capture must authenticate github.actor and upload only full-history governed evidence",
		);
	}
}

function validateVerificationOnlyRelease(
	lines: string[],
	jobs: JobBlock[],
	add: (line: number, message: string) => void,
): void {
	const dispatch = workflowTriggerBlock(lines, "workflow_dispatch").join("\n");
	const policy = jobs.find((job) => job.name === "dispatch-policy");
	const bench = jobs.find((job) => job.name === "bench-regress");
	const release = jobs.find((job) => job.name === "release");
	const policyText = policy
		? lines.slice(policy.start, policy.end + 1).join("\n")
		: "";
	const benchText = bench
		? lines.slice(bench.start, bench.end + 1).join("\n")
		: "";
	const verificationInput =
		/^ {6}verification_only:\s*$/m.test(dispatch) &&
		/^ {8}required:\s*true\s*$/m.test(dispatch) &&
		/^ {8}type:\s*boolean\s*$/m.test(dispatch);
	const captureInputs =
		/^ {6}capture_baseline:\s*$[\s\S]*?^ {8}default:\s*false\s*$[\s\S]*?^ {8}type:\s*boolean\s*$/m.test(
			dispatch,
		) &&
		/^ {6}benchmark_approver:\s*$[\s\S]*?^ {8}default:\s*["']{2}\s*$[\s\S]*?^ {8}type:\s*string\s*$/m.test(
			dispatch,
		);
	const failClosedPolicy =
		/EVENT_NAME:\s*\$\{\{ github\.event_name \}\}/.test(policyText) &&
		/VERIFICATION_ONLY:\s*\$\{\{ inputs\.verification_only \}\}/.test(
			policyText,
		) &&
		/"\$EVENT_NAME" = "workflow_dispatch"/.test(policyText) &&
		/"\$VERIFICATION_ONLY" != "true"/.test(policyText);
	const captureDispatchPolicy =
		/CAPTURE_BASELINE:\s*\$\{\{ inputs\.capture_baseline \}\}/.test(
			policyText,
		) &&
		/BENCHMARK_APPROVER:\s*\$\{\{ inputs\.benchmark_approver \}\}/.test(
			policyText,
		) &&
		/AUTHENTICATED_ACTOR:\s*\$\{\{ github\.actor \}\}/.test(policyText) &&
		/"\$CAPTURE_BASELINE" = "true"/.test(policyText) &&
		/test "\$BENCHMARK_APPROVER" = "\$AUTHENTICATED_ACTOR"/.test(policyText) &&
		/elif \[ -n "\$BENCHMARK_APPROVER" \]/.test(policyText);
	const rootJobsDependOnPolicy = ["security", "codeql"].every((name) => {
		const job = jobs.find((candidate) => candidate.name === name);
		return Boolean(
			job &&
				/needs:\s*\[dispatch-policy\]/.test(
					lines.slice(job.start, job.end + 1).join("\n"),
				),
		);
	});
	const governedComparator =
		/bench:regress/.test(benchText) &&
		/fetch-depth:\s*0/.test(benchText) &&
		/BENCH_MACHINE_IDENTITY:\s*github-actions-ubuntu-latest-x64/.test(
			benchText,
		);
	const releaseSteps = release ? stepBlocks(lines, release) : [];
	const bootstrap = jobs.find(
		(job) => job.name === "capture-baseline-bootstrap",
	);
	const bootstrapText = bootstrap
		? lines.slice(bootstrap.start, bootstrap.end + 1).join("\n")
		: "";
	const bootstrapWith = bootstrap
		? jobSection(lines, bootstrap, "with")
		: new Map<string, string>();
	const governedBootstrap =
		Boolean(bootstrap) &&
		/needs:\s*\[dispatch-policy\]/.test(bootstrapText) &&
		jobScalar(lines, bootstrap as JobBlock, "if") ===
			CAPTURE_BASELINE_CONDITION &&
		jobScalar(lines, bootstrap as JobBlock, "uses") ===
			"./.github/workflows/bench-baseline-capture.yml" &&
		bootstrapWith.get("approver") === BENCHMARK_APPROVER_INPUT &&
		hasPermission(bootstrapText.split("\n"), "contents", "read") &&
		!/(?:\bbench:capture\b|\bgit\s+(?:commit|push)\b|\bgh\s+release\b)/.test(
			bootstrapText,
		) &&
		!lines
			.slice(release?.start ?? 0, (release?.end ?? -1) + 1)
			.join("\n")
			.includes("capture-baseline-bootstrap");
	const nonPublishingDispatch = [
		"Bind npm publish input to this immutable release run",
		"Upload immutable npm publish input",
		"Create release",
	].every((name) => {
		const step = releaseSteps.find(
			(candidate) => stepScalar(candidate, "name") === name,
		);
		if (!step) return false;
		return stepScalar(step, "if") === VERIFICATION_ONLY_PUBLISH_CONDITION;
	});
	if (
		!verificationInput ||
		!policy ||
		!failClosedPolicy ||
		!rootJobsDependOnPolicy ||
		!governedComparator ||
		!release ||
		!nonPublishingDispatch
	) {
		add(
			policy?.start ?? 0,
			"release workflow_dispatch must be fail-closed verification-only with governed benchmarks and no publish side effects",
		);
	}
	if (!captureInputs || !captureDispatchPolicy || !governedBootstrap) {
		add(
			bootstrap?.start ?? 0,
			"release benchmark bootstrap must reuse authenticated governed capture",
		);
	}
}

function validateReleaseExecutionPrerequisites(
	lines: string[],
	jobs: JobBlock[],
	add: (line: number, message: string) => void,
) {
	for (const job of jobs) {
		let dependenciesInstalled = false;
		for (const step of stepBlocks(lines, job)) {
			const command = stepRun(step);
			if (/\bbun install --frozen-lockfile\b/.test(command)) {
				dependenciesInstalled = true;
			}
			if (
				/(?:\bbun run build:native\b|\bbunx @napi-rs\/cli@\d+\.\d+\.\d+ build\b)/.test(
					command,
				) &&
				!dependenciesInstalled
			) {
				add(
					step.start,
					"native builds require a preceding frozen dependency install",
				);
			}
		}
	}

	const coverage = jobs.find((job) => job.name === "coverage");
	if (
		!coverage ||
		jobScalar(lines, coverage, "uses") !== "./.github/workflows/coverage.yml"
	) {
		add(
			coverage?.start ?? 0,
			"release coverage must reuse the canonical full coverage gate",
		);
	}
	for (const job of jobs) {
		if (job.name === "coverage") continue;
		const text = lines.slice(job.start, job.end + 1).join("\n");
		if (TOOLCHAIN.rustNightly.some((version) => text.includes(version))) {
			add(
				job.start,
				"the governed nightly toolchain is restricted to coverage",
			);
		}
	}

	validateFuzzExecutionPrerequisites(lines, jobs, add);
}

function validateFuzzExecutionPrerequisites(
	lines: string[],
	jobs: JobBlock[],
	add: (line: number, message: string) => void,
) {
	for (const job of jobs) {
		let symbolizerBound = false;
		for (const step of stepBlocks(lines, job)) {
			const command = stepRun(step);
			if (
				command.includes("command -v llvm-symbolizer-18") &&
				command.includes("LLVM_SYMBOLIZER_PATH=$LLVM_SYMBOLIZER_PATH")
			) {
				symbolizerBound = true;
			}
			if (!command.includes("bun run fuzz:release-smoke")) continue;
			if (symbolizerBound) continue;
			add(
				step.start,
				"fuzz release smoke requires deterministic symbolizer setup",
			);
		}
	}
}

function validateCoverageExecutionPrerequisites(
	lines: string[],
	jobs: JobBlock[],
	add: (line: number, message: string) => void,
) {
	const nightly = TOOLCHAIN.rustNightly[0] ?? "";
	const stable = TOOLCHAIN.rust[0] ?? "";
	for (const job of jobs) {
		const text = lines.slice(job.start, job.end + 1).join("\n");
		if (!text.includes("cargo llvm-cov") || !text.includes("--branch"))
			continue;
		const stableToolchain = `toolchain: ${stable}`;
		const nightlyToolchain = `toolchain: ${nightly}`;
		if (
			!stable ||
			!text.includes(stableToolchain) ||
			text.indexOf(stableToolchain) > text.indexOf(nightlyToolchain)
		) {
			add(
				job.start,
				"native coverage prerequisites require the governed stable Rust toolchain",
			);
		}
		if (!nightly || !text.includes(`toolchain: ${nightly}`)) {
			add(job.start, "branch coverage requires the governed nightly toolchain");
		}
		if (text.includes("RUSTC_BOOTSTRAP")) {
			add(job.start, "branch coverage must not use RUSTC_BOOTSTRAP");
		}
		for (const required of [
			"coverage/native-coverage.json",
			"coverage/wasm-coverage.json",
			"--coverage-reporter=lcov",
			"coverage/bun/path-proof.txt",
			"Enforce risk-module coverage floors",
		]) {
			if (!text.includes(required)) {
				add(
					job.start,
					"coverage workflow must enforce native, WASM, and Bun floors",
				);
				break;
			}
		}
	}
}

function hasPermission(
	block: string[],
	scope: string,
	access: string,
): boolean {
	return block.some((line) =>
		new RegExp(`^\\s{4,}${scope}:\\s*["']?${access}["']?(?:\\s+#.*)?$`).test(
			line,
		),
	);
}

function scanWorkflow(path: string): Violation[] {
	const file = basename(path);
	const lines = readFileSync(path, "utf8").split(/\r?\n/);
	const violations: Violation[] = [];
	const add = (line: number, message: string) =>
		violations.push({ file, line: line + 1, message });

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const uses = /^\s*(?:-\s*)?uses:\s*(.+?)\s*$/.exec(line)?.[1];
		if (uses) {
			const request = scalar(uses);
			const message = actionPinViolation(request);
			if (message) add(index, `${message}: ${request}`);
		}

		const version =
			/^\s*(bun-version|node-version|deno-version|python-version|toolchain):\s*(.+?)\s*$/.exec(
				line,
			);
		if (version?.[1] && version[2]) {
			const message = exactVersionViolation(version[1], version[2], lines);
			if (message) add(index, message);
		}

		if (/^\s*permissions:\s*(?:write-all|write)\s*(?:#.*)?$/i.test(line)) {
			add(index, "permissions must be an explicit least-privilege mapping");
		}
		if (
			/^ {2}(?:contents|packages|actions|security-events|pages|deployments|id-token):\s*write\s*(?:#.*)?$/.test(
				line,
			)
		) {
			add(index, "write permission must be scoped to the one job that uses it");
		}
		if (
			/^\s*(?:NPM_TOKEN|NODE_AUTH_TOKEN):|secrets\.(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPMJS_TOKEN)/.test(
				line,
			)
		) {
			add(
				index,
				"npm publishing must use trusted publishing, not a long-lived token",
			);
		}
		if (
			/\bcargo install (?:cargo-audit|wasm-bindgen-cli|cargo-llvm-cov|cargo-fuzz)\b/.test(
				line,
			) &&
			!/--version\s+\d+\.\d+\.\d+/.test(line)
		) {
			const tool =
				/\bcargo install (cargo-audit|wasm-bindgen-cli|cargo-llvm-cov|cargo-fuzz)\b/.exec(
					line,
				)?.[1] ?? "release tooling";
			add(index, `${tool} installs must include an exact --version`);
		}
		if (
			/@napi-rs\/cli\b/.test(line) &&
			/\b(?:bunx|npx|bun\s+(?:x|add)|npm\s+(?:i|install)|yarn\s+add|pnpm\s+add)\b/.test(
				line,
			) &&
			!/@napi-rs\/cli@\d+\.\d+\.\d+\b/.test(line)
		) {
			add(index, "@napi-rs/cli invocations must use an exact pinned version");
		}
		if (
			/\b(?:bunx|npx)\s+playwright\b/.test(line) &&
			!/playwright@\d+\.\d+\.\d+/.test(line)
		) {
			add(
				index,
				"Playwright invoked outside a frozen install must use an exact version",
			);
		}
		const commandVersionMessage = commandVersionViolation(line);
		if (commandVersionMessage) add(index, commandVersionMessage);
		const iwaToolsMessage = iwaPackagingToolsViolation(line);
		if (iwaToolsMessage) add(index, iwaToolsMessage);
	}

	const jobs = jobBlocks(lines);
	if (file === "publish.yml" || file === "publish.yaml") {
		validatePublishHandoff(lines, jobs, add);
	}
	if (
		file === "bench-baseline-capture.yml" ||
		file === "bench-baseline-capture.yaml"
	) {
		validateBenchmarkCaptureWorkflow(lines, jobs, add);
	}
	if (file === "release.yml" || file === "release.yaml") {
		validateVerificationOnlyRelease(lines, jobs, add);
		validateReleaseExecutionPrerequisites(lines, jobs, add);
	}
	if (file === "coverage.yml" || file === "coverage.yaml") {
		validateCoverageExecutionPrerequisites(lines, jobs, add);
	}
	if (file === "fuzz.yml" || file === "fuzz.yaml") {
		validateFuzzExecutionPrerequisites(lines, jobs, add);
	}

	for (const job of jobs) {
		const block = lines.slice(job.start, job.end + 1);
		const text = block.join("\n");
		for (const step of stepBlocks(lines, job)) {
			const command = stepRun(step);
			if (!/\$\{\{\s*github\.event\.inputs\.[A-Za-z0-9_-]+/.test(command)) {
				continue;
			}
			const relativeLine = step.lines.findIndex((line) =>
				/\$\{\{\s*github\.event\.inputs\.[A-Za-z0-9_-]+/.test(line),
			);
			add(
				step.start + Math.max(relativeLine, 0),
				"workflow_dispatch inputs must pass through step env, not shell run source",
			);
		}
		if (
			/uses:\s*['"]?actions\/checkout@/.test(text) &&
			!hasPermission(block, "contents", "read") &&
			!hasPermission(block, "contents", "write")
		) {
			add(
				job.start,
				`job ${job.name} checks out source and must explicitly grant contents: read`,
			);
		}
		const publishesNpm =
			/^\s*(?:-\s*)?run:\s*(?:npm|bun)\s+publish\b/m.test(text) ||
			/^\s+(?:npm|bun)\s+publish\b/m.test(text);
		if (publishesNpm) {
			if (!hasPermission(block, "id-token", "write")) {
				add(job.start, `publish job ${job.name} must grant id-token: write`);
			}
			if (!hasPermission(block, "contents", "read")) {
				add(
					job.start,
					`publish job ${job.name} must explicitly grant contents: read`,
				);
			}
			if (!/\b(?:npm|bun)\s+publish\b[^\n]*--provenance\b/.test(text)) {
				add(
					job.start,
					`publish job ${job.name} must publish with --provenance`,
				);
			}
			if (
				!/\bnpm\s+install\s+(?:--global|-g)\s+npm@\d+\.\d+\.\d+\b/.test(text)
			) {
				add(
					job.start,
					`publish job ${job.name} must install an exact npm CLI version`,
				);
			}
		}

		for (let offset = 0; offset < block.length; offset += 1) {
			const line = block[offset] ?? "";
			const writeScope =
				/^\s{4,}(contents|packages|actions|security-events|pages|deployments):\s*write\s*(?:#.*)?$/.exec(
					line,
				)?.[1];
			if (!writeScope) continue;
			const allowed =
				(writeScope === "contents" &&
					/(?:softprops\/action-gh-release|\bgh\s+release\b)/.test(text)) ||
				(writeScope === "packages" &&
					/(?:docker\/build-push-action|\bdocker\s+push\b)/.test(text)) ||
				(writeScope === "security-events" &&
					/github\/codeql-action/.test(text)) ||
				(writeScope === "pages" && /actions\/deploy-pages/.test(text)) ||
				(writeScope === "deployments" && /\bdeployment\b/i.test(text));
			if (!allowed)
				add(
					job.start + offset,
					`${writeScope}: write is not justified by this job`,
				);
		}
	}

	return violations;
}

const files = workflowFiles();
if (files.length === 0) {
	console.error(`No workflow files found under ${WORKFLOW_DIR}`);
	process.exit(1);
}

const violations = files.flatMap(scanWorkflow);
if (violations.length > 0) {
	console.error("GitHub Actions release-policy violations found:");
	for (const violation of violations) {
		console.error(
			`- .github/workflows/${violation.file}:${violation.line} ${violation.message}`,
		);
	}
	process.exit(1);
}

console.log(
	`Actions pin and least-privilege policy passed across ${files.length} workflows.`,
);
