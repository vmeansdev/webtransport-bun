/**
 * Release evidence lifecycle (scripts/release-evidence.ts and
 * scripts/promote-release-status.ts), fully offline: every run uses a
 * throwaway git repository and a fake `gh` (helpers/release-evidence-fake-gh.ts)
 * whose releases and run artifacts are local directories.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
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
import {
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
		claims: [
			{
				id: "native-local-gates",
				surface: "native",
				status: "pending",
				evidenceIds: [],
				gaRequired: true,
			},
			{
				id: "iwa-direct-sockets",
				surface: "wasm",
				status: "pending",
				evidenceIds: [],
				gaRequired: true,
			},
			{
				id: "scale-10k-multisource",
				surface: "release",
				status: "pending",
				evidenceIds: [],
				gaRequired: false,
			},
		],
	};
}

type Fixture = {
	root: string;
	commit: string;
	statePath: string;
	store: string;
	env: Record<string, string>;
};

function makeFixture(): Fixture {
	const root = temp("wt-evidence-repo-");
	mkdirSync(join(root, "docs"), { recursive: true });
	mkdirSync(join(root, "packages", "webtransport"), { recursive: true });
	writeFileSync(
		join(root, "packages", "webtransport", "package.json"),
		JSON.stringify({ version: "1.0.0-rc.2" }),
	);
	writeFileSync(
		join(root, "docs", "release-status.json"),
		`${JSON.stringify(statusFixture(), null, "\t")}\n`,
	);
	writeFileSync(
		join(root, "docs", "release-evidence-manifest.json"),
		`${JSON.stringify({ schemaVersion: 1, repository: REPO, packageVersion: null, candidate: { commit: null, tag: null }, entries: [] }, null, "\t")}\n`,
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
	delete env.GITHUB_REPOSITORY;
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

function readState(fixture: Fixture) {
	return JSON.parse(readFileSync(fixture.statePath, "utf8")) as {
		tags: Record<string, string>;
		releases: Record<
			string,
			{ dir: string; isPrerelease: boolean; assets: { name: string }[] }
		>;
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
		entries: {
			id: string;
			asset: string;
			claimIds: string[];
			sha256: string;
			files: { name: string }[];
		}[];
	};
}

function writeInput(fixture: Fixture, name: string, body: unknown): string {
	const dir = join(fixture.root, ".release-evidence", "inputs");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, name);
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
	return path;
}

function passClaims(fixture: Fixture, bindings: Record<string, string>) {
	const path = join(fixture.root, "docs", "release-status.json");
	const status = JSON.parse(readFileSync(path, "utf8")) as StatusFixture;
	for (const claim of status.claims) {
		const id = bindings[claim.id];
		if (id) {
			claim.status = "passed";
			claim.evidenceIds = [id];
		}
	}
	writeFileSync(path, `${JSON.stringify(status, null, "\t")}\n`);
}

/** Bind, package two claims' evidence, publish the pre-release, pass claims. */
function readyCandidate(fixture: Fixture) {
	expect(
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG).status,
	).toBe(0);
	const native = writeInput(fixture, "native-gates.json", {
		commit: fixture.commit,
		exitCode: 0,
		status: "passed",
	});
	let result = cli(
		fixture,
		"package",
		"--claim",
		"native-local-gates",
		"--id",
		"native-local-gates-local-1",
		"--input",
		native,
		"--local",
		"fixture operator run",
	);
	expect(result.status, result.stderr).toBe(0);
	const iwaDir = join(fixture.root, ".release-evidence", "iwa");
	mkdirSync(iwaDir, { recursive: true });
	writeFileSync(
		join(iwaDir, "evidence.json"),
		JSON.stringify({ commit: fixture.commit, status: "passed" }),
	);
	writeFileSync(join(iwaDir, "origin.txt"), "isolated-app://fixture-origin\n");
	result = cli(
		fixture,
		"package",
		"--claim",
		"iwa-direct-sockets",
		"--id",
		"iwa-direct-sockets-local-1",
		"--input",
		iwaDir,
		"--local",
		"fixture IWA proof",
	);
	expect(result.status, result.stderr).toBe(0);
	result = cli(fixture, "upload", "--create-prerelease", "--execute");
	expect(result.status, result.stderr).toBe(0);
	passClaims(fixture, {
		"native-local-gates": "native-local-gates-local-1",
		"iwa-direct-sockets": "iwa-direct-sockets-local-1",
	});
}

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

	it("refuses credentials, env dumps, host paths and forbidden logins without echoing them", () => {
		const cases: [string, unknown][] = [
			["token.json", { note: `token ${FAKE_TOKEN}` }],
			["env.json", { env: { HOME: "/srv/x", GITHUB_TOKEN: "x" } }],
			["path.json", { cwd: "/Users/someone/project" }],
			["log.txt", `ok\nexport LOKALISE_API_TOKEN=abc\n`],
			["log2.txt", `PATH=/usr/bin\n`],
			["log3.txt", `wrote /var/folders/ab/T/out.json\n`],
			["who.txt", `run by octocat-login on a laptop\n`],
		];
		for (const [name, body] of cases) {
			const result = scrubFile(name, encode(body), options);
			expect(result.ok, name).toBe(false);
			if (!result.ok) {
				const text = result.problems.join("\n");
				expect(text).not.toContain(FAKE_TOKEN);
				expect(text).not.toContain("someone");
				expect(text).not.toContain("octocat-login");
			}
		}
	});

	it("redacts foreign host paths on request but still refuses credentials", () => {
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
		const text = scrubFile(
			"a.log",
			encode("compiled /home/runner/.cargo/bin/x in 3s\n"),
			redact,
		);
		expect(text.ok).toBe(true);
		if (text.ok) {
			const out = new TextDecoder().decode(text.data);
			expect(out).toContain("compiled");
			expect(out).not.toContain("/home/runner");
		}
		expect(scrubFile("b.log", encode(`x ${FAKE_TOKEN}\n`), redact).ok).toBe(
			false,
		);
	});

	it("refuses binary files it cannot scan", () => {
		expect(scrubFile("corpus.bin", new Uint8Array([1, 0, 2]), options).ok).toBe(
			false,
		);
	});
});

describe("release evidence bundles and manifest contract", () => {
	it("writes deterministic bundles that read back exactly", () => {
		const members = [
			{ name: "b/second.txt", data: new TextEncoder().encode("two\n") },
			{ name: "a/first.json", data: new TextEncoder().encode("{}\n") },
		];
		const first = createTarGz(members);
		const second = createTarGz([...members].reverse());
		expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
		const read = readTarGz(first);
		expect(read.map((m) => m.name)).toEqual(["a/first.json", "b/second.txt"]);
		expect(new TextDecoder().decode(read[1]?.data)).toBe("two\n");
		expect(() =>
			createTarGz([{ name: "../escape", data: new Uint8Array() }]),
		).toThrow();
	});

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
	});
});

describe("release evidence lifecycle", () => {
	it("binds the candidate in both the manifest and release-status", () => {
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
		expect(manifest(fixture).candidate).toEqual({
			commit: fixture.commit,
			tag: TAG,
		});
		expect(manifest(fixture).packageVersion).toBe("1.0.0-rc.2");
		const status = JSON.parse(
			readFileSync(join(fixture.root, "docs", "release-status.json"), "utf8"),
		);
		expect(status.candidate.commit).toBe(fixture.commit);
		expect(
			cli(fixture, "bind", "--commit", fixture.commit, "--tag", "v1.0.0-rc.3")
				.status,
		).toBe(1);
	});

	it("packages, uploads, and verifies evidence end to end, then promotes", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		const recorded = manifest(fixture);
		expect(recorded.entries.map((e) => e.asset).sort()).toEqual([
			"evidence-iwa-direct-sockets-local-1.tar.gz",
			"evidence-native-local-gates-local-1.json",
		]);
		const state = readState(fixture);
		expect(state.releases[TAG]?.isPrerelease).toBe(true);
		expect(state.releases[TAG]?.assets.length).toBe(2);

		const verify = cli(fixture, "verify");
		expect(verify.status, verify.stderr).toBe(0);
		expect(verify.stdout).toContain("verify passed: 2 asset(s)");

		const promote = run(fixture, PROMOTE, "--root", fixture.root, "--dry-run");
		expect(promote.status, promote.stderr).toBe(0);
		expect(JSON.parse(promote.stdout).readiness).toBe("ready");
		const write = run(fixture, PROMOTE, "--root", fixture.root);
		expect(write.status, write.stderr).toBe(0);
		const status = JSON.parse(
			readFileSync(join(fixture.root, "docs", "release-status.json"), "utf8"),
		);
		expect(status.candidate).toEqual({
			commit: fixture.commit,
			readiness: "ready",
		});
	});

	it("upload is a dry run by default and never creates a release unasked", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const input = writeInput(fixture, "n.json", {
			commit: fixture.commit,
			status: "passed",
		});
		expect(
			cli(
				fixture,
				"package",
				"--claim",
				"native-local-gates",
				"--input",
				input,
				"--local",
				"fixture",
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

	it("refuses to overwrite an attached asset with different content", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		const asset = "evidence-native-local-gates-local-1.json";
		writeState(fixture, (state) => {
			const release = state.releases[TAG] as unknown as {
				assets: { name: string; digest: string }[];
			};
			const entry = release.assets.find((a) => a.name === asset);
			if (entry) entry.digest = `sha256:${"0".repeat(64)}`;
		});
		const result = cli(fixture, "upload", "--execute");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("assets are immutable");
	});

	it("verify and promote fail when an attached asset was replaced", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		const dir = readState(fixture).releases[TAG]?.dir as string;
		writeFileSync(
			join(dir, "evidence-native-local-gates-local-1.json"),
			JSON.stringify({ commit: fixture.commit }),
		);
		const verify = cli(fixture, "verify");
		expect(verify.status).toBe(1);
		expect(verify.stderr).toMatch(
			/evidence-native-local-gates-local-1\.json (is \d+ bytes|sha256)/,
		);
		const promote = run(fixture, PROMOTE, "--root", fixture.root, "--dry-run");
		expect(promote.status).toBe(1);
		expect(promote.stderr).toContain("refused");
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

	it("verify fails a GA claim whose evidence is missing, failed, or for another claim", () => {
		const fixture = makeFixture();
		readyCandidate(fixture);
		passClaims(fixture, { "native-local-gates": "iwa-direct-sockets-local-1" });
		const verify = cli(fixture, "verify");
		expect(verify.status).toBe(1);
		expect(verify.stderr).toContain(
			"is not recorded as evidence for claim native-local-gates",
		);
	});

	it("refuses evidence that fails the privacy scan and records nothing", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const input = writeInput(
			fixture,
			"leak.log",
			`starting\nLOKALISE_API_TOKEN=${FAKE_TOKEN}\n`,
		);
		const result = cli(
			fixture,
			"package",
			"--claim",
			"native-local-gates",
			"--input",
			input,
			"--local",
			"fixture",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("privacy scan");
		expect(result.stderr).not.toContain(FAKE_TOKEN);
		expect(manifest(fixture).entries).toEqual([]);
		expect(existsSync(join(fixture.root, ".release-evidence", "assets"))).toBe(
			false,
		);
	});

	it("refuses passed evidence whose content records a failure or another commit", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const failed = writeInput(fixture, "f.json", {
			commit: fixture.commit,
			exitCode: 3,
		});
		expect(
			cli(
				fixture,
				"package",
				"--claim",
				"native-local-gates",
				"--input",
				failed,
				"--local",
				"fixture",
			).stderr,
		).toContain("exitCode 3");
		const other = writeInput(fixture, "o.json", {
			commit: "a".repeat(40),
			status: "passed",
		});
		expect(
			cli(
				fixture,
				"package",
				"--claim",
				"native-local-gates",
				"--input",
				other,
				"--local",
				"fixture",
			).stderr,
		).toContain("records commit");
	});

	it("fetches a CI run artifact only when the run built the candidate and succeeded", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const artifact = temp("wt-evidence-artifact-");
		writeFileSync(
			join(artifact, "release-smoke.json"),
			JSON.stringify({ commit: fixture.commit, status: "passed" }),
		);
		const runView = (id: number, headSha: string, conclusion: string) => ({
			databaseId: id,
			headSha,
			status: "completed",
			conclusion,
			url: `https://github.com/${REPO}/actions/runs/${id}`,
			workflowName: "fuzz",
			attempt: 1,
			artifacts: { "fuzz-evidence": artifact },
		});
		writeState(fixture, (state) => {
			state.runs["11"] = runView(11, fixture.commit, "success");
			state.runs["12"] = runView(12, "b".repeat(40), "success");
			state.runs["13"] = runView(13, fixture.commit, "failure");
		});
		const wrongCommit = cli(
			fixture,
			"fetch",
			"--run",
			"12",
			"--artifact",
			"fuzz-evidence",
			"--claim",
			"fuzz-gates",
		);
		expect(wrongCommit.status).toBe(1);
		expect(wrongCommit.stderr).toContain("not the candidate");
		const failedRun = cli(
			fixture,
			"fetch",
			"--run",
			"13",
			"--artifact",
			"fuzz-evidence",
			"--claim",
			"fuzz-gates",
		);
		expect(failedRun.status).toBe(1);
		expect(failedRun.stderr).toContain("concluded failure");
		const ok = cli(
			fixture,
			"fetch",
			"--run",
			"11",
			"--artifact",
			"fuzz-evidence",
			"--claim",
			"fuzz-gates",
		);
		expect(ok.status, ok.stderr).toBe(0);
		const entry = manifest(fixture).entries[0] as unknown as {
			id: string;
			producer: Record<string, unknown>;
		};
		expect(entry.id).toBe("fuzz-gates-fuzz-evidence-11-1");
		expect(entry.producer).toEqual({
			kind: "github-actions",
			repository: REPO,
			workflow: "fuzz",
			runId: 11,
			runAttempt: 1,
			url: `https://github.com/${REPO}/actions/runs/11`,
			headSha: fixture.commit,
		});
	});

	it("imports a CI fragment attached to the pre-release into the manifest", () => {
		const fixture = makeFixture();
		cli(fixture, "bind", "--commit", fixture.commit, "--tag", TAG);
		const outDir = join(fixture.root, ".release-evidence", "ci");
		const fragment = join(
			outDir,
			"release-evidence-fragment-release-77-1.json",
		);
		const input = writeInput(fixture, "interop-evidence.json", {
			config: {},
			suites: [],
		});
		const packaged = cli(
			fixture,
			"package",
			"--claim",
			"chromium-native-interop",
			"--input",
			input,
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
		writeState(fixture, (state) => {
			state.releases[TAG] = {
				dir: join(fixture.store, "rel"),
				isPrerelease: true,
				assets: [],
			} as never;
		});
		mkdirSync(join(fixture.store, "rel"), { recursive: true });
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
