/**
 * Release evidence lifecycle (scripts/release-evidence.ts and
 * scripts/promote-release-status.ts), fully offline: every run uses a
 * throwaway git repository and a fake `gh` (helpers/release-evidence-fake-gh.ts)
 * whose releases and run artifacts are local directories. Evidence payloads
 * follow the real producers' formats.
 */
import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	producerPolicyProblems,
	type RegisteredClaim,
	validateClaimProof,
	validateRegistry,
} from "../../../scripts/release-claims.ts";
import {
	contentProblems,
	opaqueRunReason,
} from "../../../scripts/release-evidence-content.ts";
import {
	createTar,
	createTarGz,
	readTarGz,
	scrubFile,
	validateManifest,
} from "../../../scripts/release-evidence-lib.ts";
import {
	distTagFor,
	stampedVersion,
} from "../../../scripts/stamp-version-from-tag.ts";
import {
	pruneReportMetadata,
	unsafeStringReason,
	unsafeTextLineReason,
} from "../../../tools/interop/evidence-privacy.ts";
import { RELEASE_FAULT_PROFILES } from "../../../tools/interop/udp-fault-proxy.ts";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(PROJECT_ROOT, "scripts", "release-evidence.ts");
const PROMOTE = join(PROJECT_ROOT, "scripts", "promote-release-status.ts");
const FAKE_GH = join(import.meta.dir, "helpers", "release-evidence-fake-gh.ts");
const REPO = "example/webtransport-bun";
const TAG = "v1.0.0-rc.2";
// Assembled at runtime so the literal never sits in the source as a token.
const FAKE_TOKEN = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123"].join("");

// Lifecycle tests spawn the CLI, git and the fake gh many times; Windows
// runners need far more than the 5 s default.
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

function git(root: string, ...args: string[]): string {
	const result = spawnSync(
		"git",
		[
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"-c",
			"commit.gpgsign=false",
			...args,
		],
		{ cwd: root, encoding: "utf8" },
	);
	if (result.status !== 0)
		throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

/** Workflow files committed in every fixture candidate: the registered
 * producers below name them by path and pin their sha256. */
const FIXTURE_WORKFLOWS: Record<string, string> = {
	".github/workflows/test.yml": `name: test
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: release-evidence-native-gates-\${{ matrix.os }}
`,
	".github/workflows/iwa.yml": `name: IWA
on: workflow_dispatch
jobs:
  iwa-interop:
    name: IWA Browser Server (Direct Sockets)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: iwa-proof-\${{ github.sha }}
`,
	".github/workflows/fuzz.yml": `name: fuzz
on: workflow_dispatch
jobs:
  fuzz:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: fuzz-evidence
`,
	".github/workflows/release.yml": `name: release
on: push
jobs:
  interop:
    name: Interop (Chromium)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: interop-evidence
  fuzz:
    name: Fuzz smoke (blocking)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: fuzz-evidence
`,
	".github/workflows/scratch.yml": `name: scratch
on: workflow_dispatch
jobs:
  anything:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@v4
        with:
          name: fuzz-evidence
`,
};

function producer(workflow: string, jobs: string[], artifact: string) {
	const path = `.github/workflows/${workflow}`;
	return {
		workflow: path,
		workflowSha256: createHash("sha256")
			.update(FIXTURE_WORKFLOWS[path] as string)
			.digest("hex"),
		jobs,
		artifact,
	};
}

/** Each workflow's run as the fake Actions API reports it. */
const FIXTURE_RUNS: Record<
	string,
	{ path: string; jobs: { name: string; status: string; conclusion: string }[] }
> = {
	test: {
		path: ".github/workflows/test.yml",
		jobs: [
			{
				name: "test (ubuntu-latest, 1.3.14)",
				status: "completed",
				conclusion: "success",
			},
		],
	},
	IWA: {
		path: ".github/workflows/iwa.yml",
		jobs: [
			{
				name: "IWA Browser Server (Direct Sockets)",
				status: "completed",
				conclusion: "success",
			},
		],
	},
	fuzz: {
		path: ".github/workflows/fuzz.yml",
		jobs: [{ name: "fuzz", status: "completed", conclusion: "success" }],
	},
	release: {
		path: ".github/workflows/release.yml",
		jobs: [
			{
				name: "Interop (Chromium)",
				status: "completed",
				conclusion: "success",
			},
			{
				name: "Fuzz smoke (blocking)",
				status: "completed",
				conclusion: "success",
			},
		],
	},
	scratch: {
		path: ".github/workflows/scratch.yml",
		jobs: [{ name: "anything", status: "completed", conclusion: "success" }],
	},
};

const REGISTRY: { schemaVersion: 1; claims: RegisteredClaim[] } = {
	schemaVersion: 1,
	claims: [
		{
			id: "native-local-gates",
			surface: "native",
			gaRequired: true,
			proof: {
				kind: "command-records",
				commandPatterns: ["cargo test", "bun test"],
				files: [
					{ match: "commands/*.json", schema: "command-record" },
					{ match: "summary.json", schema: "command-summary" },
				],
			},
			producers: [
				producer("test.yml", ["test"], "release-evidence-native-gates*"),
			],
		},
		{
			id: "iwa-direct-sockets",
			surface: "wasm",
			gaRequired: true,
			proof: {
				kind: "iwa-proof",
				files: [{ match: "evidence*.json", schema: "iwa-evidence" }],
			},
			producers: [producer("iwa.yml", ["iwa-interop"], "iwa-proof-*")],
		},
		{
			id: "fuzz-gates",
			surface: "release",
			gaRequired: false,
			proof: {
				kind: "fuzz-release-smoke",
				files: [{ match: "release-smoke.json", schema: "fuzz-release-smoke" }],
			},
			producers: [
				producer("fuzz.yml", ["fuzz"], "fuzz-evidence"),
				producer("release.yml", ["fuzz"], "fuzz-evidence"),
			],
		},
		{
			id: "chromium-native-interop",
			surface: "native",
			gaRequired: false,
			proof: {
				kind: "playwright-report",
				minExpected: 1,
				files: [{ match: "*.json", schema: "playwright-report" }],
			},
			producers: [producer("release.yml", ["interop"], "interop-evidence")],
		},
	],
};

function registered(id: string): RegisteredClaim {
	const found = REGISTRY.claims.find((claim) => claim.id === id);
	if (!found) throw new Error(`fixture claim ${id} is missing`);
	return found;
}

type StatusFixture = {
	schemaVersion: number;
	candidate: { commit: string | null; readiness: string };
	claims: {
		id: string;
		surface: string;
		status: string;
		evidenceIds: string[];
		gaRequired: boolean;
	}[];
};

function statusFixture(): StatusFixture {
	return {
		schemaVersion: 2,
		candidate: { commit: null, readiness: "pending" },
		claims: REGISTRY.claims.map((claim) => ({
			id: claim.id,
			surface: claim.surface,
			status: "pending",
			evidenceIds: [],
			gaRequired: claim.gaRequired,
		})),
	};
}

type Fixture = {
	root: string;
	commit: string;
	statePath: string;
	store: string;
	env: Record<string, string>;
};

function makeFixture(version = "1.0.0"): Fixture {
	const root = temp("wt-evidence-repo-");
	mkdirSync(join(root, "docs"), { recursive: true });
	mkdirSync(join(root, "packages", "webtransport"), { recursive: true });
	writeFileSync(
		join(root, "packages", "webtransport", "package.json"),
		JSON.stringify({ version }),
	);
	writeFileSync(
		join(root, "docs", "release-claims.json"),
		`${JSON.stringify(REGISTRY, null, "\t")}\n`,
	);
	writeFileSync(
		join(root, "docs", "release-status.json"),
		`${JSON.stringify(statusFixture(), null, "\t")}\n`,
	);
	writeFileSync(
		join(root, "docs", "release-evidence-manifest.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				repository: REPO,
				packageVersion: null,
				candidate: { commit: null, tag: null },
				claimRegistrySha256: null,
				promotion: null,
				entries: [],
			},
			null,
			"\t",
		)}\n`,
	);
	writeFileSync(join(root, ".gitignore"), ".release-evidence/\n");
	writeTree(root, FIXTURE_WORKFLOWS);
	git(root, "init", "-q");
	git(root, "add", ".");
	git(root, "commit", "-q", "-m", "candidate");
	const commit = git(root, "rev-parse", "HEAD");
	const store = temp("wt-evidence-gh-");
	const statePath = join(store, "state.json");
	writeFileSync(
		statePath,
		JSON.stringify({
			repo: REPO,
			tags: { [TAG]: commit },
			releases: {},
			runs: {},
			storeDir: store,
			calls: [],
		}),
	);
	const env: Record<string, string> = {
		...(process.env as Record<string, string>),
		RELEASE_EVIDENCE_GH: JSON.stringify([process.execPath, FAKE_GH]),
		FAKE_GH_STATE: statePath,
	};
	for (const key of ["GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_SHA"])
		delete env[key];
	return { root, commit, statePath, store, env };
}

function run(fixture: Fixture, script: string, ...args: string[]) {
	return spawnSync(process.execPath, [script, ...args], {
		cwd: fixture.root,
		env: fixture.env,
		encoding: "utf8",
	});
}

function cli(fixture: Fixture, ...args: string[]) {
	return run(
		fixture,
		CLI,
		args[0] as string,
		...args.slice(1),
		"--root",
		fixture.root,
	);
}

type FakeRelease = {
	dir: string;
	isPrerelease: boolean;
	omitDigests?: boolean;
	assets: { name: string; size: number; digest: string }[];
};

function readState(fixture: Fixture) {
	return JSON.parse(readFileSync(fixture.statePath, "utf8")) as {
		tags: Record<string, string>;
		releases: Record<string, FakeRelease>;
		runs: Record<string, unknown>;
		calls: string[][];
	};
}

function writeState(
	fixture: Fixture,
	mutate: (state: ReturnType<typeof readState>) => void,
) {
	const state = readState(fixture);
	mutate(state);
	writeFileSync(fixture.statePath, JSON.stringify(state));
}

function manifest(fixture: Fixture) {
	return JSON.parse(
		readFileSync(
			join(fixture.root, "docs", "release-evidence-manifest.json"),
			"utf8",
		),
	) as {
		candidate: { commit: string | null; tag: string | null };
		packageVersion: string | null;
		claimRegistrySha256: string | null;
		promotion: { assets: { name: string }[] } | null;
		entries: {
			id: string;
			asset: string;
			claimIds: string[];
			sha256: string;
			files: { name: string }[];
			producer: Record<string, unknown>;
		}[];
	};
}

function writeTree(base: string, files: Record<string, unknown>): string {
	for (const [name, body] of Object.entries(files)) {
		const path = join(base, name);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(
			path,
			typeof body === "string" ? body : JSON.stringify(body, null, 2),
		);
	}
	return base;
}

function inputDir(fixture: Fixture, name: string): string {
	const dir = join(fixture.root, ".release-evidence", "inputs", name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

// ---- realistic producer payloads ------------------------------------------

function commandRecord(commit: string, name: string, command: string[]) {
	return {
		schemaVersion: 1,
		kind: "command",
		name,
		commit,
		platform: { os: "darwin", arch: "arm64", runtime: "bun" },
		toolchain: { name: "bun", version: "1.3.14" },
		command,
		exitCode: 0,
		startedAt: "2026-10-29T10:00:00.000Z",
		finishedAt: "2026-10-29T10:05:00.000Z",
		artifactSha256: createHash("sha256").update(name).digest("hex"),
	};
}

function nativeGates(commit: string) {
	return {
		"commands/cargo-test.json": commandRecord(commit, "cargo-test", [
			"cargo",
			"test",
			"-p",
			"native",
		]),
		"commands/bun-test.json": commandRecord(commit, "bun-test", [
			"bun",
			"test",
			"packages/",
		]),
		"summary.json": {
			schemaVersion: 1,
			kind: "summary",
			commit,
			generatedAt: "2026-10-29T10:06:00.000Z",
			recordCount: 2,
			records: [],
		},
	};
}

function iwaEvidence(commit: string) {
	return {
		schemaVersion: 1,
		status: "passed",
		executionIdentity: "browser-iwa-direct-sockets",
		protocol: "isolated-app:",
		crossOriginIsolated: true,
		directSockets: true,
		functional: {
			datagram: "iwa-datagram",
			bidi: "iwa-bidi",
			uni: "iwa-uni",
			resetCode: 37,
			stopSendingCode: 41,
			peerClose: { code: 4100 },
		},
		reconnects: Array.from({ length: 8 }, (_, i) => ({
			attempt: i + 1,
			payload: `iwa-reconnect-${i + 1}`,
		})),
		certificateRotation: {
			oldPinRejected: true,
			oldHash: "p3Lq8Wc0zZ1Hn5uR2o7yJx4tKbV9mA6sGdEfIhUjNkM=",
			newHash: "Qw9Er7Ty5Ui3Op1As2Df4Gh6Jk8Lz0Xc+Vb/Nm1Qa2W=",
			payload: "iwa-rotated-cert",
		},
		sourceCommit: commit,
		signedBundleSha256: createHash("sha256").update("bundle").digest("hex"),
		browserVersion: "142.0.7444.0",
		browserChannel: "chrome-beta",
		localNetworkPermission: "pregranted-for-automated-proof",
		playwrightVersion: "1.58.2",
	};
}

function fuzzSmoke() {
	return {
		createdAt: "2026-10-29T10:00:00.000Z",
		fixedDurationSecs: 60,
		toolchain: {
			rust: "1.95.0",
			cargo: "cargo 1.95.0 (a1b2c3d4e 2026-07-01)",
			cargoFuzz: "cargo-fuzz 0.13.1",
			llvmSymbolizer: "[redacted-host-path]",
		},
		corpora: [
			{
				target: "h3_frame",
				files: [{ path: "tools/fuzz/corpora/h3/a", bytes: 12 }],
			},
		],
		commandResults: [
			{
				command: ["cargo", "fuzz", "run", "h3_frame"],
				exitCode: 0,
				timedOut: false,
			},
		],
		crashRoot: ".release-evidence/fuzz/crashes",
		failures: [],
	};
}

/** Shape of a real Playwright 1.58 JSON report (sanitized). */
function playwrightReport() {
	const location = { file: "interop.pw.ts", line: 12, column: 3 };
	return {
		config: {
			configFile: "<repo>/tools/interop/playwright.config.ts",
			rootDir: "<repo>/tools/interop/tests",
			forbidOnly: false,
			fullyParallel: false,
			globalSetup: null,
			globalTeardown: null,
			globalTimeout: 0,
			grep: {},
			grepInvert: null,
			maxFailures: 0,
			metadata: { actualWorkers: 1 },
			preserveOutput: "always",
			projects: [
				{
					outputDir: "<repo>/tools/interop/test-results",
					repeatEach: 1,
					retries: 0,
					metadata: { actualWorkers: 1 },
					id: "",
					name: "",
					testDir: "<repo>/tools/interop/tests",
					testIgnore: [],
					testMatch: ["**/*.@(spec|test).?(c|m)[jt]s?(x)"],
					timeout: 30000,
				},
			],
			quiet: false,
			reporter: [
				["json", { outputFile: "interop-evidence.json" }],
				[
					"<repo>/tools/interop/evidence-sanitizer.ts",
					{ outputFile: "interop-evidence.json" },
				],
			],
			reportSlowTests: { max: 5, threshold: 300000 },
			runAgents: "none",
			shard: null,
			tags: [],
			updateSnapshots: "missing",
			updateSourceMethod: "patch",
			version: "1.58.2",
			workers: 1,
			webServer: {
				command: "bun run addon-server.ts",
				cwd: "<repo>/tools/interop",
				url: "http://127.0.0.1:4434",
				env: {
					WEBTRANSPORT_INTEROP_HOST: "127.0.0.1",
					WT_IDLE_TIMEOUT_MS: "60000",
				},
				reuseExistingServer: false,
				timeout: 30000,
			},
		},
		suites: [
			{
				title: "interop.pw.ts",
				file: "interop.pw.ts",
				column: 0,
				line: 0,
				specs: [],
				suites: [
					{
						title: "Chromium native interop",
						file: "interop.pw.ts",
						line: 5,
						column: 6,
						specs: [
							{
								title: "close … propagates to client",
								ok: true,
								tags: [],
								tests: [
									{
										timeout: 30000,
										annotations: [],
										expectedStatus: "passed",
										projectId: "",
										projectName: "",
										results: [
											{
												workerIndex: 0,
												parallelIndex: 0,
												status: "passed",
												duration: 412,
												errors: [],
												stdout: [{ text: "datagram echo ok (64 bytes)\n" }],
												stderr: [],
												retry: 0,
												startTime: "2026-10-30T10:54:50.679Z",
												annotations: [],
												attachments: [],
											},
										],
										status: "expected",
									},
								],
								id: "4bb17c2992a2b9ccc470-b943d8b34dac2aaa2236",
								file: "interop.pw.ts",
								line: location.line,
								column: location.column,
							},
						],
					},
				],
			},
		],
		errors: [],
		stats: {
			startTime: "2026-10-30T10:54:49.978Z",
			duration: 727.4,
			expected: 1,
			skipped: 0,
			unexpected: 0,
			flaky: 0,
		},
	};
}

function packageLocal(
	fixture: Fixture,
	claim: string,
	id: string,
	dir: string,
) {
	return cli(
		fixture,
		"package",
		"--claim",
		claim,
		"--id",
		id,
		"--input",
		dir,
		"--local",
		"fixture operator run",
	);
}

function passClaims(fixture: Fixture, bindings: Record<string, string>) {
	editStatus(fixture, (status) => {
		for (const claim of status.claims) {
			const id = bindings[claim.id];
			if (id) {
				claim.status = "passed";
				claim.evidenceIds = [id];
			}
		}
	});
}

function editStatus(fixture: Fixture, mutate: (status: StatusFixture) => void) {
	const path = join(fixture.root, "docs", "release-status.json");
	const status = JSON.parse(readFileSync(path, "utf8")) as StatusFixture;
	mutate(status);
	writeFileSync(path, `${JSON.stringify(status, null, "\t")}\n`);
}

/** Bind, package both GA claims' evidence, publish the pre-release, pass
 * the claims. */
function readyCandidate(fixture: Fixture, tag = TAG) {
	const bound = cli(fixture, "bind", "--commit", fixture.commit, "--tag", tag);
	expect(bound.status, bound.stderr).toBe(0);
	// Tool output comes from the Actions run that produced it.
	const artifact = writeTree(
		temp("wt-evidence-native-"),
		nativeGates(fixture.commit),
	);
	writeState(fixture, (state) => {
		state.runs["41"] = runView(
			fixture,
			41,
			{ workflowName: "test" },
			artifact,
			"release-evidence-native-gates",
		);
	});
	let result = cli(
		fixture,
		"fetch",
		"--run",
		"41",
		"--artifact",
		"release-evidence-native-gates",
		"--claim",
		"native-local-gates",
		"--id",
		"native-local-gates-test-41-1",
	);
	expect(result.status, result.stderr).toBe(0);
	// IWA evidence is machine-produced too: iwa.yml's artifact, never --local.
	result = fetchIwa(fixture);
	expect(result.status, result.stderr).toBe(0);
	result = cli(fixture, "upload", "--create-prerelease", "--execute");
	expect(result.status, result.stderr).toBe(0);
	passClaims(fixture, {
		"native-local-gates": "native-local-gates-test-41-1",
		"iwa-direct-sockets": "iwa-direct-sockets-iwa-42-1",
	});
}

/** Publish an extra asset on the candidate pre-release, as anyone with write
 * access could. */
function attach(fixture: Fixture, name: string, body: unknown) {
	const data =
		typeof body === "string" ? body : `${JSON.stringify(body, null, 2)}\n`;
	writeFileSync(join(releaseDir(fixture), name), data);
	writeState(fixture, (state) => {
		state.releases[TAG]?.assets.push({
			name,
			size: Buffer.byteLength(data),
			digest: `sha256:${createHash("sha256").update(data).digest("hex")}`,
		});
	});
}

function releaseDir(fixture: Fixture): string {
	return readState(fixture).releases[TAG]?.dir as string;
}

function runView(
	fixture: Fixture,
	id: number,
	overrides: Record<string, unknown> = {},
	artifact?: string,
	artifactName = "fuzz-evidence",
) {
	const workflowName = String(overrides.workflowName ?? "fuzz");
	const workflow = FIXTURE_RUNS[workflowName];
	if (!workflow) throw new Error(`no fixture workflow ${workflowName}`);
	return {
		databaseId: id,
		headSha: fixture.commit,
		status: "completed",
		conclusion: "success",
		url: `https://github.com/${REPO}/actions/runs/${id}`,
		workflowName,
		path: workflow.path,
		attempt: 1,
		jobs: workflow.jobs,
		artifacts: artifact ? { [artifactName]: artifact } : {},
		...overrides,
	};
}

/** IWA evidence the way iwa.yml uploads it, fetched from that run. */
function fetchIwa(
	fixture: Fixture,
	runId = 42,
	evidence: unknown = iwaEvidence(fixture.commit),
) {
	const artifact = writeTree(temp("wt-evidence-iwa-"), {
		".release-evidence/iwa/evidence.json": evidence,
		".release-evidence/iwa/origin.txt": "isolated-app://fixture\n",
	});
	const name = `iwa-proof-${fixture.commit}`;
	writeState(fixture, (state) => {
		state.runs[String(runId)] = runView(
			fixture,
			runId,
			{ workflowName: "IWA" },
			artifact,
			name,
		);
	});
	return cli(
		fixture,
		"fetch",
		"--run",
		String(runId),
		"--artifact",
		name,
		"--select",
		".release-evidence/iwa/evidence.json",
		"--claim",
		"iwa-direct-sockets",
		"--id",
		`iwa-direct-sockets-iwa-${runId}-1`,
	);
}

// ---- privacy ---------------------------------------------------------------

describe("release evidence privacy scrubbing", () => {
	it("finds absolute paths after any non-path boundary, never in URLs", () => {
		const leaks = [
			// The reviewer's values.
			"cache:C:\\Users\\alice\\secrets\\dump.json",
			"cache:/opt/actions-runner/_work/repo/file.json",
			"x=/opt/actions-runner/_work/repo/file.json",
			"(/home/runner/work/repo/file.json)",
			// Drive, UNC and POSIX paths behind other boundaries.
			"saved to D:/a/webtransport-bun/out.json",
			"log[C:\\actions\\_work\\x]",
			"share \\\\build-host\\drop\\x.json",
			"see:\\\\build-host\\drop",
			"key=c:\\ProgramData\\x",
			"'/srv/runner/work/x'",
			"→/builds/group/project/x",
			"|/workspace/build/out.log",
			"file:///etc/ssl/private/key.pem",
			"FILE://host/share/x",
		];
		for (const value of leaks) {
			expect(unsafeStringReason(value), value).toBeDefined();
			expect(unsafeTextLineReason(value), value).toBeDefined();
			expect(
				scrubFile(
					"review.json",
					new TextEncoder().encode(JSON.stringify({ notes: value })),
					{ repoRoots: [], redactHostPaths: false, forbiddenLiterals: [] },
				).ok,
				value,
			).toBe(false);
		}
		const clean = [
			"https://github.com/example/webtransport-bun/actions/runs/1",
			"http://127.0.0.1:4433/cert-hash/x",
			"wss://example.test/a/b",
			"git+ssh://example.test/a/b",
			"<repo>/tools/interop/tests/fault-matrix.spec.ts:78:31",
			"and/or exec/s: 21845 corp: 40/3Kb",
			"ratio 1:2/3 at 10:30/day",
			"/cert-hash",
			"target/x86_64-unknown-linux-gnu/release/h3_frame",
		];
		for (const value of clean)
			expect(unsafeStringReason(value), value).toBeUndefined();
	});

	const options = {
		repoRoots: ["/work/checkout"],
		redactHostPaths: false,
		forbiddenLiterals: ["octocat-login"],
	};
	const encode = (value: unknown) =>
		new TextEncoder().encode(
			typeof value === "string" ? value : JSON.stringify(value),
		);
	const b64 = (text: string | Uint8Array) =>
		Buffer.from(text).toString("base64");

	it("reroots the checkout and accepts otherwise clean evidence", () => {
		const result = scrubFile(
			"a.json",
			encode({ log: "/work/checkout/target/x.json", ok: true }),
			options,
		);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(new TextDecoder().decode(result.data)).toContain(
				"<repo>/target/x.json",
			);
	});

	const refused: [string, string, unknown][] = [
		["a literal token", "token.json", { note: `token ${FAKE_TOKEN}` }],
		[
			"a credential env dump",
			"env.json",
			{ env: { HOME: "/srv/x", GITHUB_TOKEN: "x" } },
		],
		["a home path", "path.json", { cwd: "/Users/someone/project" }],
		["an exported token", "log.txt", "ok\nexport LOKALISE_API_TOKEN=abc\n"],
		["a PATH assignment", "log2.txt", "PATH=/usr/bin\n"],
		["a temp path", "log3.txt", "wrote /var/folders/ab/T/out.json\n"],
		["the operator login", "who.txt", "run by octocat-login on a laptop\n"],
		[
			"a runner name in JSON",
			"runner.json",
			{ env: { RUNNER_NAME: "internal-host-17" } },
		],
		["HOSTNAME in a log", "host.log", "HOSTNAME=build-box-3\n"],
		["USER and LOGNAME", "user.json", { USER: "x", LOGNAME: "y" }],
		[
			"an environment dump by structure",
			"dump.json",
			{ vars: { FOO_BAR: "1", BAZ_QUX: "2", ABC_DEF: "3" } },
		],
		[
			"an env dump by structure in text",
			"dump.log",
			"FOO_BAR=1\nBAZ_QUX=2\nABC_DEF=3\n",
		],
		[
			"a base64 token",
			"b64.json",
			{ log_b64: b64(`LOKALISE_API_TOKEN=${FAKE_TOKEN}`) },
		],
		[
			"a base64 env dump",
			"b64env.json",
			{ blob: b64("HOME=/home/runner\nUSER=runner\n") },
		],
		[
			"a base64url host path",
			"b64url.log",
			`data ${b64("C:\\Users\\someone\\x").replaceAll("+", "-").replaceAll("/", "_")}\n`,
		],
		[
			"a gzip+base64 env dump",
			"gz.json",
			{ gz: b64(gzipSync("GITHUB_TOKEN=abc\nRUNNER_NAME=host-9\n")) },
		],
		[
			"a hex-encoded path",
			"hex.json",
			{ hex: Buffer.from("/Users/someone/secret/file").toString("hex") },
		],
		[
			"a percent-encoded path",
			"pct.log",
			"url=%2FUsers%2Fsomeone%2Fprivate%2Ffile\n",
		],
		[
			"a base64 login",
			"b64who.json",
			{ who: b64("octocat-login@laptop.local") },
		],
		["a property name that is a token", "key.json", { [FAKE_TOKEN]: 1 }],
		[
			"newline-wrapped base64 of a token",
			"wrapped.log",
			`${(b64(`LOKALISE_API_TOKEN=${FAKE_TOKEN}`).match(/.{1,12}/g) ?? []).join("\n")}\n`,
		],
		[
			"space-chunked base64 (the reviewer's payload)",
			"chunked.json",
			{ note: "TE9LQUxJ U0VfQVBJ X1RPS0VO PXNlY3Jl dA==" },
		],
		[
			"base64 chunks split across array elements",
			"split.json",
			{ parts: b64(`GITHUB_TOKEN=${FAKE_TOKEN}`).match(/.{1,8}/g) ?? [] },
		],
		[
			"base64 behind unrelated words",
			"prefixed.log",
			`see attachment xyz ${b64("HOME=/home/runner")} end\n`,
		],
		[
			"a base64 tar.gz carrying an env line",
			"tgz.json",
			{
				bundle: b64(
					createTarGz([
						{
							name: "x/env.txt",
							data: new TextEncoder().encode(
								`LOKALISE_API_TOKEN=${FAKE_TOKEN}\n`,
							),
						},
					]),
				),
			},
		],
		[
			"a base64 zip",
			"zip.json",
			{
				blob: b64(
					Buffer.concat([
						Buffer.from([0x50, 0x4b, 0x03, 0x04]),
						Buffer.alloc(40, 7),
					]),
				),
			},
		],
		[
			"a token under five layers of base64",
			"deep.json",
			{
				x: [1, 2, 3, 4, 5].reduce(
					(acc) => b64(acc),
					`GITHUB_TOKEN=${FAKE_TOKEN}`,
				),
			},
		],
		[
			"benign text under six layers of base64 (fail closed)",
			"deeper.json",
			{
				x: [1, 2, 3, 4, 5, 6].reduce(
					(acc) => b64(acc),
					"just an ordinary sentence of text",
				),
			},
		],
		[
			"an escaped-newline-wrapped token",
			"escaped.log",
			`${(b64(`GITHUB_TOKEN=${FAKE_TOKEN}`).match(/.{1,10}/g) ?? []).join("\\n")}\n`,
		],
	];
	for (const [label, name, body] of refused) {
		it(`refuses ${label} without echoing it`, () => {
			const result = scrubFile(name, encode(body), options);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				const text = result.problems.join("\n");
				expect(text).not.toContain(FAKE_TOKEN);
				expect(text).not.toContain("someone");
				expect(text).not.toContain("octocat-login");
				expect(text).not.toContain("internal-host-17");
			}
		});
	}

	it("still refuses encoded credentials when host paths are redacted", () => {
		const redact = { ...options, redactHostPaths: true };
		expect(
			scrubFile("a.json", encode({ b: b64(`x ${FAKE_TOKEN}`) }), redact).ok,
		).toBe(false);
	});

	it("accepts hashes, commits, runtime knobs and opaque base64", () => {
		const result = scrubFile(
			"ok.json",
			encode({
				sha: createHash("sha256").update("x").digest("hex"),
				commit: "0123456789abcdef0123456789abcdef01234567",
				pin: "p3Lq8Wc0zZ1Hn5uR2o7yJx4tKbV9mA6sGdEfIhUjNkM=",
				identity: "browser-iwa-direct-sockets",
				env: {
					WEBTRANSPORT_INTEROP_HOST: "127.0.0.1",
					WT_IDLE_TIMEOUT_MS: "1000",
					WEBTRANSPORT_DATAGRAM_BATCH: "4",
				},
			}),
			options,
		);
		expect(result.ok, result.ok ? "" : result.problems.join("; ")).toBe(true);
	});

	it("redacts foreign host paths on request", () => {
		const redact = { ...options, redactHostPaths: true };
		const json = scrubFile(
			"a.json",
			encode({ cwd: "/opt/hostedtoolcache/bun/bin" }),
			redact,
		);
		expect(json.ok).toBe(true);
		if (json.ok)
			expect(new TextDecoder().decode(json.data)).not.toContain(
				"hostedtoolcache",
			);
	});

	it("refuses binary files it cannot scan", () => {
		expect(scrubFile("corpus.bin", new Uint8Array([1, 0, 2]), options).ok).toBe(
			false,
		);
	});
});

// ---- bundles ---------------------------------------------------------------

describe("release evidence bundles", () => {
	const members = [
		{ name: "b/second.txt", data: new TextEncoder().encode("two\n") },
		{ name: "a/first.json", data: new TextEncoder().encode("{}\n") },
	];

	it("writes deterministic bundles that read back exactly", () => {
		const first = createTarGz(members);
		const second = createTarGz([...members].reverse());
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
		const read = readTarGz(first);
		expect(read.map((m) => m.name)).toEqual(["a/first.json", "b/second.txt"]);
		expect(() =>
			createTarGz([{ name: "../escape", data: new Uint8Array() }]),
		).toThrow();
	});

	const hidden = new TextEncoder().encode(`GITHUB_TOKEN=${FAKE_TOKEN}\n`);
	const crafted: [string, () => Uint8Array][] = [
		[
			"bytes after the gzip stream",
			() => Buffer.concat([createTarGz(members), hidden]),
		],
		[
			"a second gzip member",
			() => Buffer.concat([createTarGz(members), gzipSync(hidden)]),
		],
		[
			"data after the end-of-archive marker",
			() => gzipSync(Buffer.concat([createTar(members), hidden])),
		],
		[
			"an extra member after the end-of-archive marker",
			() =>
				gzipSync(
					Buffer.concat([
						createTar(members),
						createTar([{ name: "z/leak.txt", data: hidden }]),
					]),
				),
		],
		[
			"a missing end-of-archive marker",
			() => {
				const tar = createTar(members);
				return gzipSync(tar.subarray(0, tar.length - 1024));
			},
		],
		[
			"data hidden in member padding",
			() => {
				const tar = Buffer.from(createTar(members));
				tar.write("LEAK", 512 + 8); // inside the first member's padding
				return gzipSync(tar);
			},
		],
		[
			"a gzip header carrying a file name",
			() => {
				const gz = Buffer.from(createTarGz(members));
				const named = Buffer.concat([
					gz.subarray(0, 10),
					Buffer.from("leak\0"),
					gz.subarray(10),
				]);
				named[3] = 0x08; // FNAME
				return named;
			},
		],
	];
	for (const [label, build] of crafted) {
		it(`rejects a bundle with ${label}`, () => {
			expect(() => readTarGz(build())).toThrow();
		});
	}
});

// ---- manifest + registry contract -----------------------------------------

describe("manifest and claim registry contract", () => {
	it("keeps the JSON schema and the validator in step", () => {
		const schema = JSON.parse(
			readFileSync(
				join(PROJECT_ROOT, "docs", "release-evidence-manifest.schema.json"),
				"utf8",
			),
		);
		expect(schema.required).toEqual([
			"schemaVersion",
			"repository",
			"packageVersion",
			"candidate",
			"claimRegistrySha256",
			"promotion",
			"entries",
		]);
		expect(schema.$defs.entry.required).toEqual([
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
		]);
		// The schema expresses the bound/unbound coupling.
		expect(JSON.stringify(schema.allOf)).toContain("claimRegistrySha256");
		const committed = JSON.parse(
			readFileSync(
				join(PROJECT_ROOT, "docs", "release-evidence-manifest.json"),
				"utf8",
			),
		);
		expect(validateManifest(committed)).toEqual([]);
		expect(
			validateManifest({ ...committed, entries: [{ id: "x" }] }).length,
		).toBeGreaterThan(0);
		expect(
			validateManifest({
				...committed,
				candidate: { commit: "a".repeat(40), tag: TAG },
			}).join("\n"),
		).toContain("packageVersion");
	});

	it("stamps the published version from the tag", () => {
		expect(stampedVersion("v1.0.0-rc.2", "1.0.0")).toBe("1.0.0-rc.2");
		expect(stampedVersion("v1.0.0", "1.0.0")).toBe("1.0.0");
		expect(distTagFor("1.0.0-rc.2")).toBe("next");
		expect(distTagFor("1.0.0")).toBe("latest");
		for (const [tag, committed] of [
			["v1.0.1", "1.0.0"],
			["v1.0.0-", "1.0.0"],
			["v1.0.0rc1", "1.0.0"],
			["1.0.0", "1.0.0"],
			["v1.0.0-rc.2", "1.0.0-rc.1"],
		] as const)
			expect(() => stampedVersion(tag, committed)).toThrow();
	});

	it("binds the published identity to the stamped version", () => {
		const commit = "0123456789abcdef0123456789abcdef01234567";
		const identity = (tag: string, packageVersion: string) => ({
			name: "candidate-identity.json",
			data: new TextEncoder().encode(
				JSON.stringify({
					schemaVersion: 1,
					repository: REPO,
					workflowPath: ".github/workflows/release.yml",
					releaseRunId: 5,
					releaseRunAttempt: 1,
					candidateCommit: commit,
					tag,
					packageVersion,
					tarball: "webtransport-1.0.0-rc.2.tgz",
					tarballSha256: "a".repeat(64),
				}),
			),
		});
		const claim: RegisteredClaim = {
			id: "package-artifact",
			surface: "release",
			gaRequired: true,
			proof: {
				kind: "npm-publish-identity",
				files: [
					{ match: "candidate-identity.json", schema: "npm-publish-identity" },
				],
			},
		};
		const ctx = (member: { name: string; data: Uint8Array }) => ({
			commit,
			producerKind: "github-actions" as const,
			members: [member],
			root: PROJECT_ROOT,
		});
		expect(
			validateClaimProof(claim, ctx(identity("v1.0.0-rc.2", "1.0.0-rc.2"))),
		).toEqual([]);
		expect(
			validateClaimProof(claim, ctx(identity("v1.0.0-rc.2", "1.0.0"))).join(
				"\n",
			),
		).toContain("stamped from its tag");
	});

	it("pins every release-status claim in the committed registry", () => {
		const registry = JSON.parse(
			readFileSync(join(PROJECT_ROOT, "docs", "release-claims.json"), "utf8"),
		) as { claims: { id: string; gaRequired: boolean }[] };
		const status = JSON.parse(
			readFileSync(join(PROJECT_ROOT, "docs", "release-status.json"), "utf8"),
		) as { claims: { id: string; gaRequired: boolean }[] };
		expect(status.claims.map((c) => [c.id, c.gaRequired])).toEqual(
			registry.claims.map((c) => [c.id, c.gaRequired]),
		);
	});

	it("refuses passed evidence without positive proof", () => {
		const commit = "0123456789abcdef0123456789abcdef01234567";
		const ctx = (
			members: { name: string; data: Uint8Array }[],
			producerKind: "local" | "github-actions" = "local",
		) => ({ commit, producerKind, members, root: PROJECT_ROOT });
		const json = (name: string, value: unknown) => ({
			name,
			data: new TextEncoder().encode(JSON.stringify(value)),
		});
		const native = registered("native-local-gates");
		const iwa = registered("iwa-direct-sockets");
		const interop = registered("chromium-native-interop");
		expect(
			validateClaimProof(native, ctx([json("x.json", {})])).length,
		).toBeGreaterThan(0);
		expect(
			validateClaimProof(
				native,
				ctx([
					{ name: "log.txt", data: new TextEncoder().encode("all good\n") },
				]),
			).length,
		).toBeGreaterThan(0);
		expect(
			validateClaimProof(
				iwa,
				ctx([json("evidence.json", { commit, status: "passed" })]),
			).length,
		).toBeGreaterThan(0);
		// Real-format proof, but from the wrong commit.
		expect(
			validateClaimProof(
				iwa,
				ctx(
					[json("evidence.json", iwaEvidence("f".repeat(40)))],
					"github-actions",
				),
			).join("\n"),
		).toContain("sourceCommit");
		// IWA proof is tool output: only a fetched iwa.yml artifact counts.
		expect(
			validateClaimProof(
				iwa,
				ctx([json("evidence.json", iwaEvidence(commit))]),
			).join("\n"),
		).toContain("GitHub Actions run");
		expect(
			validateClaimProof(
				iwa,
				ctx([json("evidence.json", iwaEvidence(commit))], "github-actions"),
			),
		).toEqual([]);
		// A Playwright report carries no commit: only an Actions run binds it.
		expect(
			validateClaimProof(
				interop,
				ctx([json("r.json", playwrightReport())]),
			).join("\n"),
		).toContain("GitHub Actions run");
		expect(
			validateClaimProof(
				interop,
				ctx([json("r.json", playwrightReport())], "github-actions"),
			),
		).toEqual([]);
		const zero = {
			...playwrightReport(),
			stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 3 },
		};
		expect(
			validateClaimProof(interop, ctx([json("r.json", zero)], "github-actions"))
				.length,
		).toBeGreaterThan(0);
		// Command records must actually run the gate's commands.
		const partial = [
			json(
				"commands/cargo-test.json",
				nativeGates(commit)["commands/cargo-test.json"],
			),
		];
		expect(
			validateClaimProof(native, ctx(partial, "github-actions")).join("\n"),
		).toContain("bun test");
		// ...and command records are tool output: never accepted from --local.
		expect(validateClaimProof(native, ctx(partial)).join("\n")).toContain(
			"GitHub Actions run",
		);
	});
});

/** A claim as the committed docs/release-claims.json registers it. */
function committedClaim(id: string): RegisteredClaim {
	const registry = JSON.parse(
		readFileSync(join(PROJECT_ROOT, "docs", "release-claims.json"), "utf8"),
	) as { claims: RegisteredClaim[] };
	const found = registry.claims.find((claim) => claim.id === id);
	if (!found) throw new Error(`registered claim ${id} is missing`);
	return found;
}

// ---- fault matrix ----------------------------------------------------------

/** The shape tools/interop/tests/fault-matrix.spec.ts writes. */
function faultMatrixEvidence(commit: string) {
	return {
		schemaVersion: 1,
		status: "passed",
		sourceCommit: commit,
		startedAt: "2026-10-30T10:00:00.000Z",
		finishedAt: "2026-10-30T10:01:00.000Z",
		scenarios: RELEASE_FAULT_PROFILES.map((profile) => ({
			profile,
			stats: {
				seen: 120,
				forwarded: 110,
				dropped: profile.lossRate ? 9 : 0,
				duplicated: profile.duplicateRate ? 7 : 0,
				delayed: profile.delayMs || profile.jitterMs ? 110 : 0,
				reordered: profile.reorderRate ? 8 : 0,
				blackHoled: profile.blackHole ? 14 : 0,
				burstDropped: profile.burstLoss ? 3 : 0,
			},
			payload: `fault-matrix-${profile.name}`,
			durationMs: 2345.5,
		})),
	};
}

describe("fault-matrix proof", () => {
	const commit = "0123456789abcdef0123456789abcdef01234567";
	const claim = committedClaim("fault-matrix");
	const encode = (value: unknown) =>
		new TextEncoder().encode(JSON.stringify(value, null, 2));
	const members = (evidence: unknown, report: unknown = playwrightReport()) => [
		{ name: "fault-matrix.json", data: encode(evidence) },
		{ name: "fault-matrix-report.json", data: encode(report) },
	];
	const check = (
		evidence: unknown,
		producerKind: "local" | "github-actions" = "github-actions",
		report?: unknown,
	) =>
		validateClaimProof(claim, {
			commit,
			producerKind,
			members: members(evidence, report),
			root: PROJECT_ROOT,
		}).join("\n");

	it("registers exactly the profiles the matrix runs", () => {
		expect(claim.proof.kind).toBe("fault-matrix");
		expect((claim.proof as { profiles: string[] }).profiles).toEqual(
			RELEASE_FAULT_PROFILES.map((p) => p.name),
		);
	});

	it("passes the matrix's own output plus its report from an Actions run", () => {
		expect(
			contentProblems(members(faultMatrixEvidence(commit)), claim.proof.files),
		).toEqual([]);
		expect(check(faultMatrixEvidence(commit))).toBe("");
	});

	it("is tool output: refused from --local", () => {
		expect(check(faultMatrixEvidence(commit), "local")).toContain(
			"GitHub Actions run",
		);
	});

	it("refuses a failed, unbound or incomplete matrix", () => {
		expect(
			check({ ...faultMatrixEvidence(commit), status: "failed" }),
		).toContain("status is not passed");
		expect(check(faultMatrixEvidence("f".repeat(40)))).toContain(
			"sourceCommit is not the candidate",
		);
		const local = {
			...faultMatrixEvidence(commit),
			sourceCommit: "local-unbound",
		};
		expect(check(local)).toContain("sourceCommit is not the candidate");
		const missing = faultMatrixEvidence(commit);
		missing.scenarios.pop();
		expect(check(missing)).toContain("scenarios are not exactly");
	});

	it("refuses a profile whose fault was not injected or payload not echoed", () => {
		const noLoss = faultMatrixEvidence(commit);
		(noLoss.scenarios[0] as { stats: { dropped: number } }).stats.dropped = 0;
		expect(check(noLoss)).toContain("seeded-loss: no loss injected");
		const noHole = faultMatrixEvidence(commit);
		(
			noHole.scenarios[6] as { stats: { blackHoled: number } }
		).stats.blackHoled = 0;
		expect(check(noHole)).toContain(
			"black-hole-recovery: no black hole injected",
		);
		const wrongPayload = faultMatrixEvidence(commit);
		(wrongPayload.scenarios[3] as { payload: string }).payload = "other";
		expect(check(wrongPayload)).toContain(
			"fixed-delay: payload did not round-trip",
		);
	});

	it("refuses a failing report and unknown fields", () => {
		const report = {
			...playwrightReport(),
			stats: { ...playwrightReport().stats, expected: 0, unexpected: 1 },
		};
		expect(
			check(faultMatrixEvidence(commit), "github-actions", report),
		).toContain("report:");
		const extra = { ...faultMatrixEvidence(commit), env: { HOME: "/x" } };
		expect(check(extra)).not.toBe("");
	});
});

describe("supply-chain-provenance proof", () => {
	const commit = "0123456789abcdef0123456789abcdef01234567";
	const claim = committedClaim("supply-chain-provenance");
	const install = commandRecord(commit, "npm-install-published", [
		"npm",
		"install",
		"--ignore-scripts",
		"--save-exact",
		"@webtransport-bun/webtransport@1.0.0-rc.1",
	]);
	const audit = commandRecord(commit, "npm-audit-signatures", [
		"npm",
		"audit",
		"signatures",
	]);
	const summary = (count: number) => ({
		schemaVersion: 1,
		kind: "summary",
		commit,
		generatedAt: "2026-10-30T10:06:00.000Z",
		recordCount: count,
		records: [],
	});
	const encode = (value: unknown) =>
		new TextEncoder().encode(JSON.stringify(value, null, 2));
	const check = (
		files: Record<string, unknown>,
		producerKind: "local" | "github-actions" = "github-actions",
	) => {
		const members = Object.entries(files).map(([name, value]) => ({
			name,
			data: encode(value),
		}));
		return [
			...contentProblems(members, claim.proof.files),
			...validateClaimProof(claim, {
				commit,
				producerKind,
				members,
				root: PROJECT_ROOT,
			}),
		].join("\n");
	};

	it("passes the recorded install of the published version plus the audit", () => {
		expect(
			check({
				"commands/npm-install-published.json": install,
				"commands/npm-audit-signatures.json": audit,
				"summary.json": summary(2),
			}),
		).toBe("");
	});

	it("refuses an audit without the install of the published package", () => {
		expect(
			check({
				"commands/npm-audit-signatures.json": audit,
				"summary.json": summary(1),
			}),
		).toContain("@webtransport-bun/webtransport@");
	});

	it("refuses a failed audit and a local record", () => {
		expect(
			check({
				"commands/npm-install-published.json": install,
				"commands/npm-audit-signatures.json": { ...audit, exitCode: 1 },
				"summary.json": summary(2),
			}),
		).toContain("exitCode 1");
		expect(
			check(
				{
					"commands/npm-install-published.json": install,
					"commands/npm-audit-signatures.json": audit,
					"summary.json": summary(2),
				},
				"local",
			),
		).toContain("GitHub Actions run");
	});
});

// ---- content allowlist -----------------------------------------------------

describe("evidence content allowlist", () => {
	const commit = "0123456789abcdef0123456789abcdef01234567";
	const realRegistry = JSON.parse(
		readFileSync(join(PROJECT_ROOT, "docs", "release-claims.json"), "utf8"),
	) as { claims: RegisteredClaim[] };
	const filesFor = (claimId: string) => {
		const claim = realRegistry.claims.find((c) => c.id === claimId);
		if (!claim) throw new Error(claimId);
		return claim.proof.files;
	};
	const member = (name: string, value: unknown) => ({
		name,
		data: new TextEncoder().encode(
			typeof value === "string" ? value : JSON.stringify(value, null, 2),
		),
	});
	const secret = Buffer.from("LOKALISE_API_TOKEN=supersecretvalue").toString(
		"base64",
	);
	const chunked = (separator: string) =>
		(secret.match(/.{1,4}/g) ?? []).join(separator);

	// Single, doubled, mixed and long separators, line breaks and natural
	// word gaps: a permissive decoder skips them all.
	for (const separator of [
		"!",
		".",
		",",
		":",
		" ",
		"!!",
		"!.,:",
		".,!:;",
		"!@#$%^&*()",
		"          ",
		"\n",
		", ",
		"! ",
	]) {
		it(`refuses base64 split by ${JSON.stringify(separator)} in a free-text field`, () => {
			const gates = nativeGates(commit);
			const record = {
				...gates["commands/cargo-test.json"],
				command: ["cargo", "test", chunked(separator)],
			};
			const problems = contentProblems(
				[member("ci/commands/cargo-test.json", record)],
				filesFor("native-local-gates"),
			);
			// (a line break in a one-line field is refused outright)
			expect(problems.join("\n")).toMatch(/opaque run|encoded|non-printable/);
			expect(problems.join("\n")).not.toContain(secret.slice(0, 8));
		});
		it(`the scanner also rejoins base64 split by ${JSON.stringify(separator)}`, () => {
			const result = scrubFile(
				"proof.json",
				new TextEncoder().encode(JSON.stringify({ note: chunked(separator) })),
				{ repoRoots: [], redactHostPaths: false, forbiddenLiterals: [] },
			);
			expect(result.ok).toBe(false);
		});
	}

	it("refuses the review-note payload from round 4 and its variants", () => {
		const review = (notes: string) =>
			contentProblems(
				[
					member("review.json", {
						schemaVersion: 1,
						kind: "review",
						commit,
						reviewer: "release reviewer",
						scope: "full candidate",
						verdict: "pass",
						findings: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
						notes,
					}),
				],
				filesFor("auto-review-zero-p0-p4"),
			).join("\n");
		// Separators of every width between chunks of every width.
		for (const width of [1, 2, 3, 4, 6, 8])
			for (const separator of ["!!", "!.,:", " ~ ", "\n\n", "  ", "!", ", "]) {
				const chunks = secret.match(new RegExp(`.{1,${width}}`, "g")) ?? [];
				expect(
					review(chunks.join(separator)),
					`${width} ${JSON.stringify(separator)}`,
				).toMatch(/opaque run|encoded|non-printable/);
			}
		// Raw (non-printable) key material, split up: refused by churn.
		const raw = Buffer.from(
			Array.from({ length: 33 }, (_, i) => (i * 97 + 13) % 256),
		).toString("base64");
		for (const separator of ["!!", "!.,:", "\n"])
			expect(review((raw.match(/.{1,4}/g) ?? []).join(separator))).toMatch(
				/opaque run|encoded|non-printable/,
			);
		// A multi-line log split one chunk per line is one run to a decoder.
		for (const separator of ["\n", "\n\n", "\r\n!!\r\n"])
			expect(
				opaqueRunReason((secret.match(/.{1,4}/g) ?? []).join(separator)),
			).toBeDefined();
		// Natural notes stay accepted.
		expect(
			review(
				"Reviewed the full candidate: no findings. Checked P0..P4 queues, the 0-RTT path, x86_64 and arm64 builds, and the 2026-10-30 CI runs.",
			),
		).toBe("");
	});

	it("keeps accepting natural log lines with counters, units and addresses", () => {
		for (const line of [
			"INFO: Loaded 1 modules   (12345 inline 8-bit counters): 12345 [0x55d5c8a0b2c0, 0x55d5c8a0e2f1),",
			"#65536\tpulse  cov: 1301 ft: 2511 corp: 40/3Kb lim: 4096 exec/s: 21845 rss: 64Mb",
			"test result: ok. 442 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.35s",
			"(pass) native 0-RTT > a plain (non-resumed) connect never offers early data even with enable0Rtt [55.02ms]",
			"     Running `target/x86_64-unknown-linux-gnu/release/h3_frame -max_total_time=60 -timeout=10`",
			"seen 205 forwarded 189 dropped 16 duplicated 0 delayed 0 reordered 0",
		])
			expect(opaqueRunReason(line), line).toBeUndefined();
	});

	it("refuses CI git metadata in a Playwright report until the sanitizer prunes it", () => {
		const report = playwrightReport();
		const withGit = {
			...report,
			config: {
				...report.config,
				metadata: {
					actualWorkers: 1,
					ci: {
						commitHash: commit,
						buildHref: "https://github.com/x/y/actions/runs/1",
					},
					gitCommit: {
						author: {
							name: "Someone",
							email: "someone@example.invalid",
							time: 1,
						},
					},
				},
			},
		};
		expect(
			contentProblems(
				[member("r/interop.json", withGit)],
				filesFor("chromium-native-interop"),
			).join("\n"),
		).toContain("unknown field");
		expect(
			contentProblems(
				[
					member(
						"r/interop.json",
						pruneReportMetadata(structuredClone(withGit)),
					),
				],
				filesFor("chromium-native-interop"),
			),
		).toEqual([]);
	});

	it("refuses an unknown extra field, recursively", () => {
		const evidence = { ...iwaEvidence(commit), extra: "harmless" };
		expect(
			contentProblems(
				[member("iwa/evidence.json", evidence)],
				filesFor("iwa-direct-sockets"),
			).join("\n"),
		).toContain("unknown field");
		const nested = iwaEvidence(commit);
		(nested.functional as Record<string, unknown>).note = "x";
		expect(
			contentProblems(
				[member("iwa/evidence.json", nested)],
				filesFor("iwa-direct-sockets"),
			).join("\n"),
		).toContain("unknown field");
	});

	it("refuses files a proof kind does not declare, and logs outside their grammar", () => {
		expect(
			contentProblems(
				[
					member("iwa/evidence.json", iwaEvidence(commit)),
					member("iwa/origin.txt", "isolated-app://x\n"),
				],
				filesFor("iwa-direct-sockets"),
			).join("\n"),
		).toContain("not a file this proof kind may contain");
		expect(
			contentProblems(
				[
					member(
						"coverage/bun/lcov.info",
						`SF:src/a.ts\nDA:1,1\nNOTE:${chunked("")}\nend_of_record\n`,
					),
				],
				[{ match: "lcov.info", schema: "lcov" }],
			).join("\n"),
		).toContain("outside the lcov grammar");
	});

	it("refuses a digest-shaped value outside a declared digest field", () => {
		const review = {
			schemaVersion: 1,
			kind: "review",
			commit,
			reviewer: "codex",
			scope: `release ${"a1b2c3d4".repeat(4)}`,
			verdict: "pass",
			findings: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
		};
		expect(
			contentProblems(
				[member("review.json", review)],
				filesFor("auto-review-zero-p0-p4"),
			).join("\n"),
		).toContain("opaque run");
	});

	it("accepts real output of every proof kind", () => {
		const cases: [string, { name: string; data: Uint8Array }[]][] = [
			[
				"native-local-gates",
				Object.entries(nativeGates(commit)).map(([name, value]) =>
					member(`release-evidence-native-gates/${name}`, value),
				),
			],
			[
				"chromium-native-interop",
				[member("interop-evidence/interop-evidence.json", playwrightReport())],
			],
			[
				"fuzz-gates",
				[
					member("fuzz/release-smoke.json", {
						...fuzzSmoke(),
						commandResults: [
							{
								command: [
									"rustup",
									"run",
									"1.95.0",
									"cargo",
									"fuzz",
									"run",
									"h3_frame",
									"--fuzz-dir",
									".",
								],
								exitCode: 0,
								stdout: "",
								stderr: [
									"   Compiling ring v0.17.8",
									"    Finished `release` profile [optimized + debuginfo] target(s) in 1m 02s",
									"     Running `target/x86_64-unknown-linux-gnu/release/h3_frame -max_total_time=60 -timeout=10`",
									"INFO: Running with entropic power schedule (0xFF, 100).",
									"INFO: Seed: 3141592653",
									"INFO: Loaded 1 modules   (12345 inline 8-bit counters): 12345 [0x55d5c8a0b2c0, 0x55d5c8a0e2f1),",
									"#2\tINITED cov: 1234 ft: 2345 corp: 12/1024b exec/s: 0 rss: 31Mb",
									"#65536\tpulse  cov: 1301 ft: 2511 corp: 40/3Kb lim: 4096 exec/s: 21845 rss: 64Mb",
									"Done 1310720 runs in 61 second(s)",
								].join("\n"),
								stdoutBytes: 0,
								stderrBytes: 600,
								durationMs: 61234.5,
								timeoutMs: 90000,
								timedOut: false,
								timeoutSignal: null,
								drainTimeoutMs: 5000,
								drainDurationMs: 1.2,
								drainTimedOut: false,
							},
						],
					}),
				],
			],
			[
				"coverage-gates",
				[
					member("coverage-artifacts/native-coverage.json", {
						data: [
							{
								files: [
									{
										filename: "<repo>/crates/native/src/limits.rs",
										segments: [[1, 1, 5, true, true, false]],
										branches: [[3, 5, 3, 20, 1, 0, 0, 0, 4]],
										expansions: [],
										summary: {
											lines: { count: 10, covered: 9, percent: 90 },
											functions: { count: 2, covered: 2, percent: 100 },
											regions: {
												count: 4,
												covered: 4,
												notcovered: 0,
												percent: 100,
											},
											branches: {
												count: 2,
												covered: 2,
												notcovered: 0,
												percent: 100,
											},
										},
									},
								],
								functions: [
									{
										name: "_RNvMs0_NtCsiQbL8HVQ6bn_6native6limitsNtB5_6Limits3new",
										count: 5,
										regions: [[1, 1, 3, 2, 5, 0, 0, 0]],
										branches: [],
										filenames: ["<repo>/crates/native/src/limits.rs"],
									},
								],
								totals: {
									lines: { count: 10, covered: 9, percent: 90 },
									functions: { count: 2, covered: 2, percent: 100 },
								},
							},
						],
						type: "llvm.coverage.json.export",
						version: "2.0.1",
					}),
					member(
						"coverage-artifacts/bun/lcov.info",
						"TN:\nSF:packages/webtransport/src/backend.ts\nFN:12,createBackend\nFNDA:3,createBackend\nFNF:1\nFNH:1\nDA:12,3\nDA:13,3\nLF:2\nLH:2\nend_of_record\n",
					),
				],
			],
			[
				"package-artifact",
				[
					member("npm-publish-input-1/candidate-identity.json", {
						schemaVersion: 1,
						repository: REPO,
						workflowPath: ".github/workflows/release.yml",
						releaseRunId: 5,
						releaseRunAttempt: 1,
						candidateCommit: commit,
						tag: "v1.0.0-rc.2",
						packageVersion: "1.0.0-rc.2",
						tarball: "webtransport-bun-webtransport-1.0.0-rc.2.tgz",
						tarballSha256: "a".repeat(64),
					}),
				],
			],
			[
				"soak-24h",
				[
					member("soak/soak-aggregate-0123456789ab-5x.json", {
						mode: "aggregate",
						status: "pass",
						segmentCount: 1,
						expectedSegmentCount: 1,
						candidateCommit: commit,
						seed: "campaign-2026-10-30",
						continuityTokenDigest: "b".repeat(64),
						source: { head: commit, dirty: false },
						workflowSource: { ref: "refs/tags/v1.0.0-rc.2", sha: commit },
						runnerType: "self-hosted",
						runnerMode: "dedicated",
						runnerProfile: "large",
						rates: { sessions: 500, datagramsPerSec: 500, streamsPerSec: 5 },
						thresholds: {
							maxSessionErrors: 0,
							maxDatagramErrors: 0,
							maxStreamErrors: 0,
							rssTrendMaxRel: 0.1,
							rssTrendMinAbsMb: 32,
							rssCeilMb: 1750,
							maxGapMs: 60000,
						},
						debugKnobs: {
							heapDebug: false,
							heapDebugIntervalMs: 0,
							committedAbortMb: 2200,
						},
						h7Delivery: {
							datagramBatchRequested: 64,
							datagramBatchResolved: 64,
							payloadDeliveryRequested: "default",
							payloadDeliveryResolved: "default",
							diagnosticsEnabled: false,
						},
						datagramsSent: 1000,
						datagramsReceived: 1000,
						deliveryRatio: 1,
						toolchain: {
							bun: "1.3.14",
							rustc: "rustc 1.95.0 (a1b2c3d4e 2026-07-01)",
							cc: { path: "/usr/bin/cc", version: "cc (Ubuntu 13.2.0) 13.2.0" },
							cxx: {
								path: "/usr/bin/c++",
								version: "c++ (Ubuntu 13.2.0) 13.2.0",
							},
						},
						segments: [
							{
								index: 1,
								file: "soak-segment-01-of-01.json",
								finalStateHash: "c".repeat(64),
								startedAtMs: 1,
								endedAtMs: 86400001,
								status: "pass",
							},
						],
						totalDurationSeconds: 86400,
						aggregateHash: "d".repeat(64),
					}),
				],
			],
			[
				"iwa-direct-sockets",
				[member("iwa/evidence.json", iwaEvidence(commit))],
			],
			[
				"auto-review-zero-p0-p4",
				[
					member("review/review.json", {
						schemaVersion: 1,
						kind: "review",
						commit,
						reviewer: "codex architect + critic",
						scope: "full repository at the candidate",
						verdict: "pass",
						findings: { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 },
					}),
				],
			],
			[
				"final-no-change-confirmation",
				[
					member("freeze/no-change.json", {
						schemaVersion: 1,
						kind: "no-change-confirmation",
						commit,
						frozenAt: "2026-10-30T00:00:00.000Z",
						verdict: "pass",
						changedFilesSinceFreeze: [],
					}),
				],
			],
		];
		for (const [claimId, members] of cases)
			expect(contentProblems(members, filesFor(claimId)), claimId).toEqual([]);
	});
});

// ---- lifecycle -------------------------------------------------------------

describe("release evidence lifecycle", () => {
	it("binds the candidate, its pinned registry, and release-status together", () => {
		const fixture = makeFixture();
		const result = cli(
			fixture,
			"bind",
			"--commit",
			fixture.commit,
			"--tag",
			TAG,
		);
		expect(result.status, result.stderr).toBe(0);
		const bound = manifest(fixture);
		expect(bound.candidate).toEqual({ commit: fixture.commit, tag: TAG });
		expect(bound.packageVersion).toBe("1.0.0");
		expect(bound.claimRegistrySha256).toBe(
			createHash("sha256")
				.update(readFileSync(join(fixture.root, "docs", "release-claims.json")))
				.digest("hex"),
		);
		const status = JSON.parse(
			readFileSync(join(fixture.root, "docs", "release-status.json"), "utf8"),
		);
		expect(status.candidate.commit).toBe(fixture.commit);
		// The tag must name the committed base version...
		expect(
			cli(fixture, "bind", "--commit", fixture.commit, "--tag", "v1.0.1-rc.1")
				.status,
		).toBe(1);
		// ...and be the candidate pre-release, not the GA tag.
		expect(
			cli(fixture, "bind", "--commit", fixture.commit, "--tag", "v1.0.0")
				.status,
		).toBe(2);
	});

	it("packages, uploads, verifies and promotes, then locks the release", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		expect(
			manifest(fixture)
				.entries.map((e) => e.asset)
				.sort(),
		).toEqual([
			"evidence-iwa-direct-sockets-iwa-42-1.json",
			"evidence-native-local-gates-test-41-1.tar.gz",
		]);
		expect(readState(fixture).releases[TAG]?.isPrerelease).toBe(true);
		const verify = cli(fixture, "verify");
		expect(verify.status, verify.stderr).toBe(0);
		expect(verify.stdout).toContain("verify passed: 2 asset(s)");

		const promote = run(fixture, PROMOTE, "--root", fixture.root);
		expect(promote.status, promote.stderr).toBe(0);
		const status = JSON.parse(
			readFileSync(join(fixture.root, "docs", "release-status.json"), "utf8"),
		);
		expect(status.candidate).toEqual({
			commit: fixture.commit,
			readiness: "ready",
		});
		expect(manifest(fixture).promotion?.assets.map((a) => a.name)).toEqual([
			"evidence-iwa-direct-sockets-iwa-42-1.json",
			"evidence-native-local-gates-test-41-1.tar.gz",
		]);
		const locked = cli(fixture, "verify", "--require-ready");
		expect(locked.status, locked.stderr).toBe(0);
		// Rerunning a completed promotion re-verifies and changes nothing.
		const again = run(fixture, PROMOTE, "--root", fixture.root);
		expect(again.status, again.stderr).toBe(0);
		expect(again.stdout).toContain("already promoted");
	});

	const statusPath = (fixture: Fixture) =>
		join(fixture.root, "docs", "release-status.json");

	it("completes a promotion interrupted after the lock was written", () => {
		const lockedOnly = makeFixture();
		readyCandidate(lockedOnly);
		expect(run(lockedOnly, PROMOTE, "--root", lockedOnly.root).status).toBe(0);
		editStatus(lockedOnly, (status) => {
			status.candidate.readiness = "pending";
		});
		const resumed = run(lockedOnly, PROMOTE, "--root", lockedOnly.root);
		expect(resumed.status, resumed.stderr).toBe(0);
		expect(
			JSON.parse(readFileSync(statusPath(lockedOnly), "utf8")).candidate
				.readiness,
		).toBe("ready");
		expect(cli(lockedOnly, "verify", "--require-ready").status).toBe(0);
	}, 60_000);

	it("completes a promotion whose status landed before the lock", () => {
		const readyOnly = makeFixture();
		readyCandidate(readyOnly);
		editStatus(readyOnly, (status) => {
			status.candidate.commit = readyOnly.commit;
			status.candidate.readiness = "ready";
		});
		const completed = run(readyOnly, PROMOTE, "--root", readyOnly.root);
		expect(completed.status, completed.stderr).toBe(0);
		expect(manifest(readyOnly).promotion).not.toBeNull();
		expect(cli(readyOnly, "verify", "--require-ready").status).toBe(0);
	}, 60_000);

	it("does not resume a promotion whose release changed in between", () => {
		const tampered = makeFixture();
		readyCandidate(tampered);
		expect(run(tampered, PROMOTE, "--root", tampered.root).status).toBe(0);
		editStatus(tampered, (status) => {
			status.candidate.readiness = "pending";
		});
		writeState(tampered, (state) => {
			state.tags[TAG] = "c".repeat(40);
		});
		expect(run(tampered, PROMOTE, "--root", tampered.root).status).toBe(1);
	}, 60_000);

	it("detects an evidence asset added after promotion", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		expect(run(fixture, PROMOTE, "--root", fixture.root).status).toBe(0);
		writeState(fixture, (state) => {
			const release = state.releases[TAG] as FakeRelease;
			writeFileSync(join(release.dir, "evidence-late-addition.json"), "{}\n");
			release.assets.push({
				name: "evidence-late-addition.json",
				size: 3,
				digest: `sha256:${createHash("sha256").update("{}\n").digest("hex")}`,
			});
		});
		const added = cli(fixture, "verify", "--require-ready");
		expect(added.status).toBe(1);
		expect(added.stderr).toContain("changed since promotion");
	});

	it("detects the candidate tag moving after promotion", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		expect(run(fixture, PROMOTE, "--root", fixture.root).status).toBe(0);
		writeState(fixture, (state) => {
			state.tags[TAG] = "e".repeat(40);
		});
		const moved = cli(fixture, "verify", "--require-ready");
		expect(moved.status).toBe(1);
		expect(moved.stderr).toContain("moved since promotion");
	});

	it("gates GA on a tag that points at the candidate commit", () => {
		const fixture = makeFixture("1.0.0");
		readyCandidate(fixture);
		expect(run(fixture, PROMOTE, "--root", fixture.root).status).toBe(0);
		writeState(fixture, (state) => {
			state.tags["v1.0.0"] = fixture.commit;
		});
		const ga = cli(fixture, "verify", "--ga-tag", "v1.0.0", "--require-ready");
		expect(ga.status, ga.stderr).toBe(0);
		writeState(fixture, (state) => {
			state.tags["v1.0.0"] = "d".repeat(40);
		});
		const elsewhere = cli(
			fixture,
			"verify",
			"--ga-tag",
			"v1.0.0",
			"--require-ready",
		);
		expect(elsewhere.status).toBe(1);
		expect(elsewhere.stderr).toContain("GA tag v1.0.0 points to");
	});

	it("always hashes downloaded assets, even when the API omits digests", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		const name = "evidence-iwa-direct-sockets-iwa-42-1.json";
		const path = join(releaseDir(fixture), name);
		const original = readFileSync(path, "utf8");
		// Same size, different bytes; the release API reports no digest.
		writeFileSync(path, original.replace("iwa-datagram", "iwa-datagrxm"));
		writeState(fixture, (state) => {
			(state.releases[TAG] as FakeRelease).omitDigests = true;
		});
		const verify = cli(fixture, "verify");
		expect(verify.status).toBe(1);
		expect(verify.stderr).toContain(
			`asset ${name} sha256 does not match the manifest`,
		);
		const upload = cli(fixture, "upload", "--execute");
		expect(upload.status).toBe(1);
		expect(upload.stderr).toContain("assets are immutable");
	});

	it("never promotes from local assets or a stale candidate", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		expect(
			run(
				fixture,
				PROMOTE,
				"--root",
				fixture.root,
				"--assets-dir",
				fixture.store,
			).status,
		).toBe(2);
		expect(
			run(fixture, PROMOTE, "--root", fixture.root, "--allow-stale-candidate")
				.status,
		).toBe(2);
		const audit = cli(
			fixture,
			"verify",
			"--assets-dir",
			join(fixture.root, ".release-evidence", "assets"),
		);
		expect(audit.status, audit.stderr).toBe(0);
		expect(audit.stdout).toContain("this is not release verification");
	});

	it("refuses a status file that downgrades a pinned gate", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		editStatus(fixture, (status) => {
			for (const claim of status.claims) {
				if (claim.id === "native-local-gates") {
					claim.gaRequired = false;
					claim.status = "pending";
					claim.evidenceIds = [];
				}
			}
		});
		const verify = cli(fixture, "verify");
		expect(verify.status).toBe(1);
		expect(verify.stderr).toContain("differs from the pinned registry");
		expect(verify.stderr).toContain("claim native-local-gates status=pending");
		expect(
			run(fixture, PROMOTE, "--root", fixture.root, "--dry-run").status,
		).toBe(1);
	});

	it("judges the candidate by the registry it pinned, not a later edit", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		const registryPath = join(fixture.root, "docs", "release-claims.json");
		const relaxed = JSON.parse(readFileSync(registryPath, "utf8"));
		relaxed.claims[0].gaRequired = false;
		writeFileSync(registryPath, `${JSON.stringify(relaxed, null, "\t")}\n`);
		const verify = cli(fixture, "verify");
		expect(verify.status).toBe(1);
		expect(verify.stderr).toContain("changed since the candidate");
		// Committing the edit makes HEAD differ beyond the evidence record.
		git(fixture.root, "add", "docs/release-claims.json");
		git(fixture.root, "commit", "-q", "-m", "relax a gate");
		const promote = run(fixture, PROMOTE, "--root", fixture.root, "--dry-run");
		expect(promote.status).toBe(1);
		expect(promote.stderr).toContain("beyond the evidence record");
	});

	it("upload resolves the tag and refuses another candidate's pre-release", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		expect(fetchIwa(fixture).status).toBe(0);
		writeState(fixture, (state) => {
			state.tags[TAG] = "9".repeat(40);
		});
		const moved = cli(fixture, "upload", "--create-prerelease", "--execute");
		expect(moved.status).toBe(1);
		expect(moved.stderr).toContain(`tag ${TAG} points to ${"9".repeat(40)}`);
		writeState(fixture, (state) => {
			state.tags["v1.0.0-rc.9"] = "8".repeat(40);
		});
		const other = cli(
			fixture,
			"upload",
			"--tag",
			"v1.0.0-rc.9",
			"--create-prerelease",
			"--execute",
		);
		expect(other.status).toBe(1);
		const calls = readState(fixture).calls.map((c) => `${c[0]} ${c[1]}`);
		expect(calls).not.toContain("release create");
		expect(calls).not.toContain("release upload");
	});

	it("verify fails closed on an evidence asset the manifest does not record", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		expect(cli(fixture, "verify").status).toBe(0);
		attach(fixture, "evidence-unrecorded-dump-1.json", { env: "anything" });
		const verify = cli(fixture, "verify", "--integrity-only");
		expect(verify.status).toBe(1);
		expect(verify.stderr).toContain(
			"release asset evidence-unrecorded-dump-1.json is not recorded in the manifest",
		);
		// A near-miss name is not a way around it.
		const other = makeFixture();
		readyCandidate(other);
		attach(other, "evidence-Dump.txt", "x");
		expect(cli(other, "verify", "--integrity-only").stderr).toContain(
			"has an evidence name but is neither",
		);
	});

	it("verify parses, binds and privacy-scans every fragment asset", () => {
		const fragment = (
			fixture: Fixture,
			extra: Record<string, unknown> = {},
		) => ({
			schemaVersion: 1,
			kind: "release-evidence-fragment",
			repository: REPO,
			commit: fixture.commit,
			tag: TAG,
			entries: [],
			...extra,
		});
		const verifyWith = (name: string, body: (f: Fixture) => unknown) => {
			const fixture = makeFixture();
			readyCandidate(fixture);
			attach(fixture, name, body(fixture));
			return cli(fixture, "verify", "--integrity-only");
		};
		const ok = verifyWith("release-evidence-fragment-release-1-1.json", (f) =>
			fragment(f),
		);
		expect(ok.status, ok.stderr).toBe(0);
		const credential = verifyWith(
			"release-evidence-fragment-release-2-1.json",
			(f) => ({ ...fragment(f), note: `token ${FAKE_TOKEN}` }),
		);
		expect(credential.status).toBe(1);
		expect(credential.stderr).toContain(
			"fragment release-evidence-fragment-release-2-1.json: privacy scan",
		);
		expect(credential.stderr).not.toContain(FAKE_TOKEN);
		const hostPath = verifyWith(
			"release-evidence-fragment-release-3-1.json",
			(f) => ({ ...fragment(f), tag: "cache:/opt/actions-runner/_work/x/y" }),
		);
		expect(hostPath.status).toBe(1);
		expect(hostPath.stderr).toContain("privacy scan");
		const unbound = verifyWith(
			"release-evidence-fragment-release-4-1.json",
			() => fragment({ commit: "e".repeat(40) } as Fixture),
		);
		expect(unbound.status).toBe(1);
		expect(unbound.stderr).toContain("not the candidate");
		const junk = verifyWith(
			"release-evidence-fragment-release-5-1.json",
			() => "{",
		);
		expect(junk.status).toBe(1);
		expect(junk.stderr).toContain("release-evidence-fragment-release-5-1.json");
		const extraEntry = verifyWith(
			"release-evidence-fragment-release-6-1.json",
			(f) => {
				const recorded = manifest(f).entries[0] as Record<string, unknown>;
				return fragment(f, {
					entries: [
						{
							...recorded,
							id: "native-local-gates-forged-1",
							asset: `evidence-native-local-gates-forged-1${String(recorded.asset).endsWith(".tar.gz") ? ".tar.gz" : ".json"}`,
						},
					],
				});
			},
		);
		expect(extraEntry.status).toBe(1);
		expect(extraEntry.stderr).toContain(
			"entry native-local-gates-forged-1 is not recorded in the manifest",
		);
	});

	it("verify fails when the tag does not point at the candidate", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		writeState(fixture, (state) => {
			state.tags[TAG] = "f".repeat(40);
		});
		const verify = cli(fixture, "verify");
		expect(verify.status).toBe(1);
		expect(verify.stderr).toContain(`tag ${TAG} points to ${"f".repeat(40)}`);
	});

	it("verify fails a GA claim whose evidence is for another claim", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		passClaims(fixture, {
			"native-local-gates": "iwa-direct-sockets-iwa-42-1",
		});
		const verify = cli(fixture, "verify");
		expect(verify.status).toBe(1);
		expect(verify.stderr).toContain(
			"is not recorded as evidence for claim native-local-gates",
		);
	});

	it("integrity mode accepts a candidate that is still collecting evidence", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		editStatus(fixture, (status) => {
			for (const claim of status.claims) {
				if (claim.id === "iwa-direct-sockets") {
					claim.status = "pending";
					claim.evidenceIds = [];
				}
			}
		});
		expect(cli(fixture, "verify").status).toBe(1);
		const integrity = cli(fixture, "verify", "--integrity-only");
		expect(integrity.status, integrity.stderr).toBe(0);
	});

	it("upload is a dry run by default and never creates a release unasked", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		expect(fetchIwa(fixture).status).toBe(0);
		const missing = cli(fixture, "upload", "--execute");
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain("--create-prerelease");
		const dry = cli(fixture, "upload", "--create-prerelease");
		expect(dry.status, dry.stderr).toBe(0);
		expect(dry.stdout).toContain("dry run");
		const calls = readState(fixture).calls.map((c) => `${c[0]} ${c[1]}`);
		expect(calls).not.toContain("release create");
		expect(calls).not.toContain("release upload");
	});

	it("refuses evidence that fails the privacy scan and records nothing", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const dir = writeTree(inputDir(fixture, "leak"), {
			...nativeGates(fixture.commit),
			"build.log": `starting\n${Buffer.from(`LOKALISE_API_TOKEN=${FAKE_TOKEN}`).toString("base64")}\n`,
		});
		const result = packageLocal(
			fixture,
			"native-local-gates",
			"native-local-gates-test-41-1",
			dir,
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("privacy scan");
		expect(result.stderr).not.toContain(FAKE_TOKEN);
		expect(manifest(fixture).entries).toEqual([]);
		expect(existsSync(join(fixture.root, ".release-evidence", "assets"))).toBe(
			false,
		);
	});

	it("refuses passed evidence without positive proof, or with a failure", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const empty = writeTree(inputDir(fixture, "empty"), { "x.json": {} });
		const refusedEmpty = packageLocal(
			fixture,
			"native-local-gates",
			"native-local-gates-test-41-1",
			empty,
		);
		expect(refusedEmpty.status).toBe(1);
		expect(refusedEmpty.stderr).toContain("native-local-gates content");
		const gates = nativeGates(fixture.commit);
		gates["commands/bun-test.json"].exitCode = 3;
		const failed = writeTree(inputDir(fixture, "failed"), gates);
		expect(
			packageLocal(
				fixture,
				"native-local-gates",
				"native-local-gates-local-2",
				failed,
			).stderr,
		).toContain("exitCode 3");
		const unknown = writeTree(
			inputDir(fixture, "unknown"),
			nativeGates(fixture.commit),
		);
		expect(
			packageLocal(fixture, "made-up-claim", "made-up-claim-local-1", unknown)
				.stderr,
		).toContain("not in docs/release-claims.json");
	});

	it("fetches a CI run artifact only when the run built the candidate and succeeded", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const artifact = writeTree(temp("wt-evidence-artifact-"), {
			"release-smoke.json": fuzzSmoke(),
		});
		writeState(fixture, (state) => {
			state.runs["11"] = runView(fixture, 11, {}, artifact);
			state.runs["12"] = runView(
				fixture,
				12,
				{ headSha: "b".repeat(40) },
				artifact,
			);
			state.runs["13"] = runView(
				fixture,
				13,
				{ conclusion: "failure" },
				artifact,
			);
		});
		const fetch = (id: string) =>
			cli(
				fixture,
				"fetch",
				"--run",
				id,
				"--artifact",
				"fuzz-evidence",
				"--claim",
				"fuzz-gates",
			);
		const wrongCommit = fetch("12");
		expect(wrongCommit.status).toBe(1);
		expect(wrongCommit.stderr).toContain("not the candidate");
		const failedRun = fetch("13");
		expect(failedRun.status).toBe(1);
		expect(failedRun.stderr).toContain("concluded failure");
		const ok = fetch("11");
		expect(ok.status, ok.stderr).toBe(0);
		const entry = manifest(fixture).entries[0];
		expect(entry?.id).toBe("fuzz-gates-fuzz-evidence-11-1");
		expect(entry?.producer).toMatchObject({
			kind: "github-actions",
			repository: REPO,
			workflow: "fuzz",
			runId: 11,
			runAttempt: 1,
			url: `https://github.com/${REPO}/actions/runs/11`,
			headSha: fixture.commit,
			artifact: { id: 1101, name: "fuzz-evidence" },
		});
	});

	it("takes CI evidence only from the run's own artifact", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const forged = writeTree(inputDir(fixture, "forged"), {
			"release-smoke.json": fuzzSmoke(),
		});
		const artifact = writeTree(temp("wt-evidence-artifact-"), {
			"release-smoke.json": fuzzSmoke(),
		});
		writeState(fixture, (state) => {
			state.runs["21"] = runView(
				fixture,
				21,
				{ status: "in_progress", conclusion: "" },
				artifact,
			);
			state.runs["22"] = runView(fixture, 22, {}, artifact);
			state.runs["23"] = runView(fixture, 23, {}, artifact);
		});
		// Local bytes can never be stamped with a run's provenance.
		const package_ = cli(
			fixture,
			"package",
			"--claim",
			"fuzz-gates",
			"--input",
			forged,
			"--run-id",
			"23",
			"--workflow",
			"fuzz",
		);
		expect(package_.status).toBe(2);
		expect(package_.stderr).toContain("fetch --run");
		const fetch = (
			runId: string,
			extra: string[] = [],
			env: Record<string, string> = {},
		) =>
			spawnSync(
				process.execPath,
				[
					CLI,
					"fetch",
					"--run",
					runId,
					"--artifact",
					"fuzz-evidence",
					"--claim",
					"fuzz-gates",
					...extra,
					"--root",
					fixture.root,
				],
				{
					cwd: fixture.root,
					env: { ...fixture.env, ...env },
					encoding: "utf8",
				},
			);
		expect(fetch("21").stderr).toContain("only a completed run");
		expect(fetch("22", ["--workflow", "release"]).stderr).toContain(
			"is workflow fuzz",
		);
		expect(fetch("22", ["--artifact", "missing-artifact"]).status).not.toBe(0);
		// The in-progress run may fetch its own artifacts from inside itself.
		const self = fetch("21", [], {
			GITHUB_RUN_ID: "21",
			GITHUB_SHA: fixture.commit,
			GITHUB_REPOSITORY: REPO,
		});
		expect(self.status, self.stderr).toBe(0);
		const done = fetch("23");
		expect(done.status, done.stderr).toBe(0);
		const entry = manifest(fixture).entries.find(
			(e) => e.id === "fuzz-gates-fuzz-evidence-23-1",
		);
		const recorded = entry?.producer.artifact as {
			id: number;
			name: string;
			digest: string;
		};
		expect(recorded.name).toBe("fuzz-evidence");
		expect(recorded.id).toBe(2301);
		expect(recorded.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		// Verify re-checks the artifact against the run's listing.
		expect(
			cli(fixture, "upload", "--create-prerelease", "--execute").status,
		).toBe(0);
		writeState(fixture, (state) => {
			(state.runs["21"] as Record<string, unknown>).status = "completed";
			(state.runs["21"] as Record<string, unknown>).conclusion = "success";
		});
		const intact = cli(fixture, "verify", "--integrity-only");
		expect(intact.status, intact.stderr).toBe(0);
		writeState(fixture, (state) => {
			(state.runs["23"] as Record<string, unknown>).artifactListing = [
				{
					id: 2301,
					name: "fuzz-evidence",
					digest: `sha256:${"0".repeat(64)}`,
					expired: false,
				},
			];
		});
		const swapped = cli(fixture, "verify", "--integrity-only");
		expect(swapped.status).toBe(1);
		expect(swapped.stderr).toContain("with the recorded digest");
	});

	it("accepts CI evidence only from the claim's registered workflow, job and artifact", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const smoke = { "release-smoke.json": fuzzSmoke() };
		const artifact = writeTree(temp("wt-evidence-artifact-"), smoke);
		writeState(fixture, (state) => {
			// Any successful workflow at the candidate SHA can upload
			// schema-valid bytes; only the registered producer is evidence.
			state.runs["51"] = runView(
				fixture,
				51,
				{ workflowName: "scratch" },
				artifact,
			);
			// The registered workflow, but the producing job never ran.
			state.runs["52"] = runView(fixture, 52, { jobs: [] }, artifact);
			// The registered workflow whose producing job failed.
			state.runs["53"] = runView(
				fixture,
				53,
				{
					jobs: [{ name: "fuzz", status: "completed", conclusion: "failure" }],
				},
				artifact,
			);
			// The registered workflow, an unregistered artifact.
			state.runs["54"] = runView(
				fixture,
				54,
				{},
				artifact,
				"fuzz-evidence-extra",
			);
			state.runs["55"] = runView(fixture, 55, {}, artifact);
		});
		const fetch = (runId: string, name = "fuzz-evidence") =>
			cli(
				fixture,
				"fetch",
				"--run",
				runId,
				"--artifact",
				name,
				"--claim",
				"fuzz-gates",
			);
		const scratch = fetch("51");
		expect(scratch.status).toBe(1);
		expect(scratch.stderr).toContain("is not a registered producer");
		expect(scratch.stderr).toContain(
			"run workflow is .github/workflows/scratch.yml, not .github/workflows/fuzz.yml",
		);
		expect(fetch("52").stderr).toContain("no fuzz job ran in the run");
		expect(fetch("53").stderr).toContain(
			"a fuzz job did not complete successfully",
		);
		expect(fetch("54", "fuzz-evidence-extra").stderr).toContain(
			"artifact fuzz-evidence-extra does not match fuzz-evidence",
		);
		expect(manifest(fixture).entries).toEqual([]);
		const ok = fetch("55");
		expect(ok.status, ok.stderr).toBe(0);
		expect(manifest(fixture).entries[0]?.producer).toMatchObject({
			workflow: "fuzz",
			workflowPath: ".github/workflows/fuzz.yml",
		});
		// verify re-reads the run's workflow file and re-applies the policy.
		expect(
			cli(fixture, "upload", "--create-prerelease", "--execute").status,
		).toBe(0);
		expect(cli(fixture, "verify", "--integrity-only").status).toBe(0);
		writeState(fixture, (state) => {
			(state.runs["55"] as Record<string, unknown>).path =
				".github/workflows/scratch.yml";
		});
		const moved = cli(fixture, "verify", "--integrity-only");
		expect(moved.status).toBe(1);
		expect(moved.stderr).toContain(
			"ran .github/workflows/scratch.yml, not .github/workflows/fuzz.yml",
		);
		expect(moved.stderr).toContain("does not accept this producer");
	});

	it("refuses a producer whose workflow at the candidate is not the reviewed one", () => {
		const claim = registered("fuzz-gates");
		const run = {
			path: ".github/workflows/fuzz.yml@refs/heads/main",
			artifact: "fuzz-evidence",
			jobs: [{ name: "fuzz", status: "completed", conclusion: "success" }],
		};
		const reviewed = (path: string) => FIXTURE_WORKFLOWS[path];
		expect(producerPolicyProblems(claim, run, reviewed)).toEqual([]);
		const edited = (path: string) =>
			`${FIXTURE_WORKFLOWS[path] ?? ""}      - run: echo forged\n`;
		expect(producerPolicyProblems(claim, run, edited).join("\n")).toContain(
			"is not the reviewed workflow",
		);
		expect(
			producerPolicyProblems(claim, run, () => undefined).join("\n"),
		).toContain("does not exist at the candidate");
		// Matrix and templated job names are matched by their workflow name.
		const matrix = registered("native-local-gates");
		expect(
			producerPolicyProblems(
				matrix,
				{
					path: ".github/workflows/test.yml",
					artifact: "release-evidence-native-gates-ubuntu-latest",
					jobs: [
						{
							name: "test (macos-latest, 1.3.14)",
							status: "completed",
							conclusion: "success",
						},
					],
				},
				reviewed,
			),
		).toEqual([]);
	});

	it("registry: machine claims name producers, human records have none", () => {
		const claims = (claim: Record<string, unknown>) => ({
			schemaVersion: 1,
			claims: [{ id: "x", surface: "release", gaRequired: true, ...claim }],
		});
		const commandProof = {
			kind: "command-records",
			files: [{ match: "commands/*.json", schema: "command-record" }],
		};
		expect(
			validateRegistry(claims({ proof: commandProof })).join("\n"),
		).toContain("must name its CI producer");
		expect(
			validateRegistry(
				claims({
					proof: commandProof,
					producers: [
						{ workflow: "test", workflowSha256: "x", jobs: [], artifact: "a" },
					],
				}),
			).join("\n"),
		).toContain(".workflow: must be a .github/workflows/<file> path");
		expect(
			validateRegistry(
				claims({
					proof: {
						kind: "review-record",
						files: [{ match: "review.json", schema: "review-record" }],
					},
					producers: [producer("test.yml", ["test"], "x")],
				}),
			).join("\n"),
		).toContain("is human work and has no CI producer");
		const committed = JSON.parse(
			readFileSync(join(PROJECT_ROOT, "docs", "release-claims.json"), "utf8"),
		) as { claims: RegisteredClaim[] };
		expect(validateRegistry(committed)).toEqual([]);
		expect(
			committed.claims
				.filter((claim) => !claim.producers)
				.map((claim) => claim.id)
				.sort(),
		).toEqual(["auto-review-zero-p0-p4", "final-no-change-confirmation"]);
		expect(
			committed.claims.find((claim) => claim.id === "iwa-direct-sockets")
				?.producers,
		).toMatchObject([
			{
				workflow: ".github/workflows/iwa.yml",
				jobs: ["iwa-interop"],
				artifact: "iwa-proof-*",
			},
		]);
	});

	it("never packages IWA evidence locally", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const local = packageLocal(
			fixture,
			"iwa-direct-sockets",
			"iwa-direct-sockets-local-1",
			writeTree(inputDir(fixture, "iwa"), {
				"evidence.json": iwaEvidence(fixture.commit),
			}),
		);
		expect(local.status).toBe(1);
		expect(local.stderr).toContain("GitHub Actions run");
		expect(manifest(fixture).entries).toEqual([]);
		const fetched = fetchIwa(fixture);
		expect(fetched.status, fetched.stderr).toBe(0);
		expect(manifest(fixture).entries[0]?.producer).toMatchObject({
			kind: "github-actions",
			workflowPath: ".github/workflows/iwa.yml",
			artifact: { name: `iwa-proof-${fixture.commit}` },
		});
	});

	it("imports a CI fragment attached to the pre-release into the manifest", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const interop = writeTree(temp("wt-evidence-artifact-"), {
			"interop-evidence.json": playwrightReport(),
		});
		writeState(fixture, (state) => {
			state.runs["77"] = runView(
				fixture,
				77,
				{ workflowName: "release" },
				interop,
				"interop-evidence",
			);
		});
		const outDir = join(fixture.root, ".release-evidence", "ci");
		const fragment = join(
			outDir,
			"release-evidence-fragment-release-77-1.json",
		);
		const packaged = cli(
			fixture,
			"fetch",
			"--claim",
			"chromium-native-interop",
			"--id",
			"chromium-native-interop-release-77-1",
			"--run",
			"77",
			"--artifact",
			"interop-evidence",
			"--workflow",
			"release",
			"--repo",
			REPO,
			"--fragment",
			fragment,
			"--commit",
			fixture.commit,
			"--tag",
			TAG,
			"--out-dir",
			outDir,
		);
		expect(packaged.status, packaged.stderr).toBe(0);
		expect(manifest(fixture).entries).toEqual([]);
		mkdirSync(join(fixture.store, "rel"), { recursive: true });
		writeState(fixture, (state) => {
			state.releases[TAG] = {
				dir: join(fixture.store, "rel"),
				isPrerelease: true,
				assets: [],
			};
		});
		const uploaded = cli(
			fixture,
			"upload",
			"--fragment",
			fragment,
			"--assets-dir",
			outDir,
			"--execute",
		);
		expect(uploaded.status, uploaded.stderr).toBe(0);
		expect(
			readState(fixture)
				.releases[TAG]?.assets.map((a) => a.name)
				.sort(),
		).toEqual([
			"evidence-chromium-native-interop-release-77-1.json",
			"release-evidence-fragment-release-77-1.json",
		]);
		const imported = cli(fixture, "import", "--from-release");
		expect(imported.status, imported.stderr).toBe(0);
		expect(manifest(fixture).entries.map((e) => e.id)).toEqual([
			"chromium-native-interop-release-77-1",
		]);
		expect(cli(fixture, "import", "--from-release").stdout).toContain(
			"imported 0 new entries",
		);
	});

	it("promote accepts an evidence-record-only descendant and refuses other drift", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		git(fixture.root, "add", "docs");
		git(fixture.root, "commit", "-q", "-m", "record evidence");
		const recordOnly = run(
			fixture,
			PROMOTE,
			"--root",
			fixture.root,
			"--dry-run",
		);
		expect(recordOnly.status, recordOnly.stderr).toBe(0);
		writeFileSync(
			join(fixture.root, "packages", "webtransport", "index.ts"),
			"export {};\n",
		);
		git(fixture.root, "add", "packages");
		git(fixture.root, "commit", "-q", "-m", "code change");
		const drift = run(fixture, PROMOTE, "--root", fixture.root, "--dry-run");
		expect(drift.status).toBe(1);
		expect(drift.stderr).toContain("beyond the evidence record");
	});
});
