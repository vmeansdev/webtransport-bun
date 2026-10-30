/**
 * Release evidence lifecycle (scripts/release-evidence.ts and
 * scripts/promote-release-status.ts), fully offline: every run uses a
 * throwaway git repository and a fake `gh` (helpers/release-evidence-fake-gh.ts)
 * whose releases and run artifacts are local directories. Evidence payloads
 * follow the real producers' formats.
 */
import { afterEach, describe, expect, it } from "bun:test";
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
	type RegisteredClaim,
	validateClaimProof,
} from "../../../scripts/release-claims.ts";
import {
	createTar,
	createTarGz,
	readTarGz,
	scrubFile,
	validateManifest,
} from "../../../scripts/release-evidence-lib.ts";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const CLI = join(PROJECT_ROOT, "scripts", "release-evidence.ts");
const PROMOTE = join(PROJECT_ROOT, "scripts", "promote-release-status.ts");
const FAKE_GH = join(import.meta.dir, "helpers", "release-evidence-fake-gh.ts");
const REPO = "example/webtransport-bun";
const TAG = "v1.0.0-rc.2";
// Assembled at runtime so the literal never sits in the source as a token.
const FAKE_TOKEN = ["ghp", "_", "abcdefghijklmnopqrstuvwxyz0123"].join("");

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
			},
		},
		{
			id: "iwa-direct-sockets",
			surface: "wasm",
			gaRequired: true,
			proof: { kind: "iwa-proof" },
		},
		{
			id: "fuzz-gates",
			surface: "release",
			gaRequired: false,
			proof: { kind: "fuzz-release-smoke" },
		},
		{
			id: "chromium-native-interop",
			surface: "native",
			gaRequired: false,
			proof: { kind: "playwright-report", minExpected: 1 },
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

function makeFixture(version = "1.0.0-rc.2"): Fixture {
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
		toolchain: { rust: "1.95.0", cargo: "cargo 1.95.0", cargoFuzz: "0.13.1" },
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

function playwrightReport() {
	return {
		config: {
			webServer: { env: { WEBTRANSPORT_INTEROP_HOST: "127.0.0.1" } },
		},
		suites: [
			{
				title: "interop.pw.ts",
				specs: [{ title: "datagram echo", ok: true, tests: [] }],
				suites: [],
			},
		],
		errors: [],
		stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
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
	let result = packageLocal(
		fixture,
		"native-local-gates",
		"native-local-gates-local-1",
		writeTree(inputDir(fixture, "native"), nativeGates(fixture.commit)),
	);
	expect(result.status, result.stderr).toBe(0);
	result = packageLocal(
		fixture,
		"iwa-direct-sockets",
		"iwa-direct-sockets-local-1",
		writeTree(inputDir(fixture, "iwa"), {
			"evidence.json": iwaEvidence(fixture.commit),
		}),
	);
	expect(result.status, result.stderr).toBe(0);
	result = cli(fixture, "upload", "--create-prerelease", "--execute");
	expect(result.status, result.stderr).toBe(0);
	passClaims(fixture, {
		"native-local-gates": "native-local-gates-local-1",
		"iwa-direct-sockets": "iwa-direct-sockets-local-1",
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
) {
	return {
		databaseId: id,
		headSha: fixture.commit,
		status: "completed",
		conclusion: "success",
		url: `https://github.com/${REPO}/actions/runs/${id}`,
		workflowName: "fuzz",
		attempt: 1,
		jobs: [],
		artifacts: artifact ? { "fuzz-evidence": artifact } : {},
		...overrides,
	};
}

// ---- privacy ---------------------------------------------------------------

describe("release evidence privacy scrubbing", () => {
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
				ctx([json("e.json", { commit, status: "passed" })]),
			).length,
		).toBeGreaterThan(0);
		// Real-format proof, but from the wrong commit.
		expect(
			validateClaimProof(
				iwa,
				ctx([json("e.json", iwaEvidence("f".repeat(40)))]),
			).join("\n"),
		).toContain("sourceCommit");
		expect(
			validateClaimProof(iwa, ctx([json("e.json", iwaEvidence(commit))])),
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
			json("c.json", nativeGates(commit)["commands/cargo-test.json"]),
		];
		expect(validateClaimProof(native, ctx(partial)).join("\n")).toContain(
			"bun test",
		);
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
		expect(bound.packageVersion).toBe("1.0.0-rc.2");
		expect(bound.claimRegistrySha256).toBe(
			createHash("sha256")
				.update(readFileSync(join(fixture.root, "docs", "release-claims.json")))
				.digest("hex"),
		);
		const status = JSON.parse(
			readFileSync(join(fixture.root, "docs", "release-status.json"), "utf8"),
		);
		expect(status.candidate.commit).toBe(fixture.commit);
		expect(
			cli(fixture, "bind", "--commit", fixture.commit, "--tag", "v1.0.0-rc.3")
				.status,
		).toBe(1);
	});

	it("packages, uploads, verifies and promotes, then locks the release", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		expect(
			manifest(fixture)
				.entries.map((e) => e.asset)
				.sort(),
		).toEqual([
			"evidence-iwa-direct-sockets-local-1.json",
			"evidence-native-local-gates-local-1.tar.gz",
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
			"evidence-iwa-direct-sockets-local-1.json",
			"evidence-native-local-gates-local-1.tar.gz",
		]);
		const locked = cli(fixture, "verify", "--require-ready");
		expect(locked.status, locked.stderr).toBe(0);
		// A second promotion of the same record is refused.
		expect(
			run(fixture, PROMOTE, "--root", fixture.root, "--dry-run").status,
		).toBe(1);
	});

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
		const name = "evidence-iwa-direct-sockets-local-1.json";
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
		passClaims(fixture, { "native-local-gates": "iwa-direct-sockets-local-1" });
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
		expect(
			packageLocal(
				fixture,
				"native-local-gates",
				"native-local-gates-local-1",
				writeTree(inputDir(fixture, "n"), nativeGates(fixture.commit)),
			).status,
		).toBe(0);
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
			"native-local-gates-local-1",
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
			"native-local-gates-local-1",
			empty,
		);
		expect(refusedEmpty.status).toBe(1);
		expect(refusedEmpty.stderr).toContain("native-local-gates proof");
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
		expect(entry?.producer).toEqual({
			kind: "github-actions",
			repository: REPO,
			workflow: "fuzz",
			runId: 11,
			runAttempt: 1,
			url: `https://github.com/${REPO}/actions/runs/11`,
			headSha: fixture.commit,
		});
	});

	it("package --run-id reads the run back instead of trusting the caller", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const dir = writeTree(inputDir(fixture, "fuzz"), {
			"release-smoke.json": fuzzSmoke(),
		});
		writeState(fixture, (state) => {
			state.runs["21"] = runView(fixture, 21, {
				status: "in_progress",
				conclusion: "",
			});
			state.runs["22"] = runView(fixture, 22, { workflowName: "test" });
			state.runs["23"] = runView(fixture, 23);
			state.runs["24"] = runView(fixture, 24, { conclusion: "failure" });
		});
		const pack = (runId: string, env: Record<string, string> = {}) =>
			spawnSync(
				process.execPath,
				[
					CLI,
					"package",
					"--claim",
					"fuzz-gates",
					"--id",
					`fuzz-gates-run-${runId}-${Object.keys(env).length}`,
					"--input",
					dir,
					"--run-id",
					runId,
					"--workflow",
					"fuzz",
					"--root",
					fixture.root,
				],
				{
					cwd: fixture.root,
					env: { ...fixture.env, ...env },
					encoding: "utf8",
				},
			);
		expect(pack("99").status).toBe(1);
		expect(pack("21").stderr).toContain("only a completed run");
		expect(pack("22").stderr).toContain("is workflow test");
		expect(pack("24").stderr).toContain("concluded failure");
		// The in-progress run may package its own evidence from inside itself.
		const self = pack("21", {
			GITHUB_RUN_ID: "21",
			GITHUB_SHA: fixture.commit,
			GITHUB_REPOSITORY: REPO,
		});
		expect(self.status, self.stderr).toBe(0);
		const done = pack("23");
		expect(done.status, done.stderr).toBe(0);
	});

	it("imports a CI fragment attached to the pre-release into the manifest", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		writeState(fixture, (state) => {
			state.runs["77"] = runView(fixture, 77, { workflowName: "release" });
		});
		const outDir = join(fixture.root, ".release-evidence", "ci");
		const fragment = join(
			outDir,
			"release-evidence-fragment-release-77-1.json",
		);
		const dir = writeTree(inputDir(fixture, "interop"), {
			"interop-evidence.json": playwrightReport(),
		});
		const packaged = cli(
			fixture,
			"package",
			"--claim",
			"chromium-native-interop",
			"--input",
			dir,
			"--run-id",
			"77",
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
