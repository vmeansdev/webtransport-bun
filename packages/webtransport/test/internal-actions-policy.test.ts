import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = join(import.meta.dir, "..", "..", "..");
const PUBLISH_WORKFLOW = readFileSync(
	join(PROJECT_ROOT, ".github", "workflows", "publish.yml"),
	"utf8",
);
const RELEASE_WORKFLOW = readFileSync(
	join(PROJECT_ROOT, ".github", "workflows", "release.yml"),
	"utf8",
);
const TEST_WORKFLOW = readFileSync(
	join(PROJECT_ROOT, ".github", "workflows", "test.yml"),
	"utf8",
);
const SOAK_WORKFLOW = readFileSync(
	join(PROJECT_ROOT, ".github", "workflows", "soak-long.yml"),
	"utf8",
);
const LOCAL_CI_SCRIPT = readFileSync(
	join(PROJECT_ROOT, "scripts", "test_ci_local.sh"),
	"utf8",
);
const NATIVE_BUILD_SCRIPT = readFileSync(
	join(PROJECT_ROOT, "scripts", "build-native.ts"),
	"utf8",
);
const RELEASE_TOOLCHAIN = JSON.parse(
	readFileSync(join(PROJECT_ROOT, ".github", "release-toolchain.json"), "utf8"),
) as {
	node: string[];
	rust: string[];
	wasmBindgen: string[];
	cargoAudit: string[];
	cargoFuzz: string[];
	napiRsCli: string[];
};
const ROOT_PACKAGE_JSON = JSON.parse(
	readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"),
) as {
	scripts?: Record<string, string>;
	devDependencies?: Record<string, string>;
};
const WEBTRANSPORT_PACKAGE_JSON = JSON.parse(
	readFileSync(
		join(PROJECT_ROOT, "packages", "webtransport", "package.json"),
		"utf8",
	),
) as {
	engines?: Record<string, string>;
};
const roots: string[] = [];
const PIN = "0123456789abcdef0123456789abcdef01234567";

setDefaultTimeout(30_000);

afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

function runPolicy(workflow: string, filename = "test.yml") {
	const root = mkdtempSync(join(tmpdir(), "wt-actions-policy-"));
	roots.push(root);
	const directory = join(root, ".github", "workflows");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(root, ".github", "release-toolchain.json"),
		JSON.stringify({
			schemaVersion: 1,
			bun: ["1.3.9", "1.3.14"],
			rust: ["1.95.0"],
			node: ["18.20.4", "20.19.0", "22.23.1"],
			deno: ["2.9.3"],
			python: ["3.12.10"],
			npm: ["11.18.0"],
			wasmBindgen: ["0.2.121"],
			cargoAudit: ["0.22.2"],
			cargoFuzz: ["0.13.1"],
			cargoLlvmCov: ["0.8.7"],
			napiRsCli: ["3.3.0"],
			playwright: ["1.58.2"],
			wbn: ["0.0.9"],
			wbnSign: ["0.3.1"],
		}),
		"utf8",
	);
	writeFileSync(join(directory, filename), workflow, "utf8");
	return spawnSync(process.execPath, ["scripts/check-actions-pinned.ts"], {
		cwd: PROJECT_ROOT,
		env: { ...process.env, CHECK_ACTIONS_PINNED_ROOT: root },
		encoding: "utf8",
	});
}

function mutatePublishWorkflow(search: string, replacement: string): string {
	if (!PUBLISH_WORKFLOW.includes(search)) {
		throw new Error(`expected publish workflow to contain ${search}`);
	}
	return PUBLISH_WORKFLOW.replace(search, replacement);
}

function mutatePublishWorkflowOccurrence(
	search: string,
	replacement: string,
	occurrence: number,
): string {
	let index = -1;
	for (let current = 0; current < occurrence; current += 1) {
		index = PUBLISH_WORKFLOW.indexOf(search, index + 1);
	}
	if (index < 0) {
		throw new Error(
			`expected publish workflow to contain occurrence ${occurrence} of ${search}`,
		);
	}
	return `${PUBLISH_WORKFLOW.slice(0, index)}${replacement}${PUBLISH_WORKFLOW.slice(index + search.length)}`;
}

/** A GitHub Actions expression. Built rather than written literally so the
 * `${` sigil never appears inside a plain string. */
const gh = (body: string): string => `${"$"}{{ ${body} }}`;

const H7_CANDIDATE_SHA = "0123456789abcdef0123456789abcdef01234567";
const H7_CANDIDATE_REF = `refs/tags/h7-batch-delivery-${H7_CANDIDATE_SHA}`;

function runSoakInputValidation(
	overrides: Record<string, string | undefined> = {},
) {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	Object.assign(env, {
		CANDIDATE_COMMIT: "0123456789abcdef0123456789abcdef01234567",
		CANDIDATE_REF: "refs/tags/v1.0.0",
		CAMPAIGN_SEED: "seed-01",
		CONTINUITY_TOKEN: "continuity-01",
		DURATION_HOURS: "1",
		RUNNER_TYPE: "github-hosted",
		RUNNER_MODE: "shared",
		SEGMENT_INDEX: "1",
		SEGMENT_COUNT: "1",
		DATAGRAM_BATCH: "64",
		RSS_CEILING_MB: "1750",
		COMMITTED_ABORT_MB: "1500",
		WORKFLOW_REF: "refs/heads/main",
		WORKFLOW_SHA: "89abcdef0123456789abcdef0123456789abcdef",
	});
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return spawnSync("bash", ["scripts/validate-soak-inputs.sh"], {
		cwd: PROJECT_ROOT,
		env,
		encoding: "utf8",
	});
}

/** The complete fixed hosted-H7 lane tuple, valid as supplied. */
function runH7SoakInputValidation(
	overrides: Record<string, string | undefined> = {},
) {
	return runSoakInputValidation({
		CANDIDATE_COMMIT: H7_CANDIDATE_SHA,
		CANDIDATE_REF: H7_CANDIDATE_REF,
		WORKFLOW_REF: H7_CANDIDATE_REF,
		WORKFLOW_SHA: H7_CANDIDATE_SHA,
		ACTUAL_HEAD: H7_CANDIDATE_SHA,
		DURATION_HOURS: "2",
		RUNNER_TYPE: "self-hosted",
		RUNNER_MODE: "dedicated",
		SEGMENT_INDEX: "1",
		SEGMENT_COUNT: "1",
		DATAGRAM_BATCH: "64",
		RSS_CEILING_MB: "1750",
		COMMITTED_ABORT_MB: "2200",
		...overrides,
	});
}

function parseWorkflow(document: string): {
	jobs?: Record<
		string,
		{
			needs?: string[] | string;
			steps?: Array<Record<string, unknown>>;
			strategy?: { matrix?: { include?: Array<Record<string, unknown>> } };
		}
	>;
} {
	return Bun.YAML.parse(document) as ReturnType<typeof parseWorkflow>;
}

describe("GitHub Actions release policy", () => {
	it("makes coverage, benchmark regression, and >=10k distributed scale release-blocking with downloaded evidence", () => {
		const workflow = parseWorkflow(RELEASE_WORKFLOW);
		const releaseJob = workflow.jobs?.release;
		expect(releaseJob).toBeDefined();

		const releaseNeeds = new Set(
			(Array.isArray(releaseJob?.needs)
				? releaseJob.needs
				: [releaseJob?.needs]
			).filter((job): job is string => typeof job === "string"),
		);
		expect(releaseNeeds).toEqual(
			new Set([
				"build",
				"interop",
				"parity",
				"coverage",
				"bench-regress",
				"distributed-scale",
				"fuzz",
				"package-consumers",
			]),
		);

		expect(RELEASE_WORKFLOW).toContain("name: coverage-artifacts");
		expect(RELEASE_WORKFLOW).toContain("path: coverage-artifacts");
		expect(RELEASE_WORKFLOW).toContain("name: bench-regress-evidence");
		expect(RELEASE_WORKFLOW).toContain("path: bench-regress-evidence");
		expect(RELEASE_WORKFLOW).toContain("name: distributed-scale-evidence");
		expect(RELEASE_WORKFLOW).toContain("path: distributed-scale-evidence");
		expect(RELEASE_WORKFLOW).toContain(
			'find coverage-artifacts -name "native-coverage.json" -type f | grep -q .',
		);
		expect(RELEASE_WORKFLOW).toContain(
			'find bench-regress-evidence -name "bench-regress-artifact.json" -type f | grep -q .',
		);
		expect(RELEASE_WORKFLOW).toContain(
			'find distributed-scale-evidence -name "distributed-scale-artifact.json" -type f | grep -q .',
		);
	});

	it("makes exact package consumers release-blocking for the release workflow across all supported operating systems", () => {
		const workflow = parseWorkflow(RELEASE_WORKFLOW);
		const packageConsumers = workflow.jobs?.["package-consumers"];
		const releaseJob = workflow.jobs?.release;
		expect(packageConsumers).toBeDefined();
		expect(releaseJob).toBeDefined();

		const releaseNeeds = Array.isArray(releaseJob?.needs)
			? releaseJob.needs
			: [releaseJob?.needs].filter(Boolean);
		expect(releaseNeeds).toContain("package-consumers");

		const lanes = packageConsumers?.strategy?.matrix?.include ?? [];
		expect(
			new Set(
				lanes.map(
					(lane) =>
						`${String(lane.os ?? "")}:${String(lane["node-version"] ?? "")}`,
				),
			),
		).toEqual(
			new Set([
				"ubuntu-latest:18.20.4",
				"ubuntu-latest:20.19.0",
				"ubuntu-latest:22.23.1",
				"macos-latest:18.20.4",
				"macos-latest:20.19.0",
				"macos-latest:22.23.1",
				"windows-latest:18.20.4",
				"windows-latest:20.19.0",
				"windows-latest:22.23.1",
			]),
		);
		for (const lane of lanes) {
			expect(RELEASE_TOOLCHAIN.node).toContain(String(lane["node-version"]));
		}
	});

	it("pins the release exact-package path to the Rust and wasm policy toolchain", () => {
		const workflow = parseWorkflow(RELEASE_WORKFLOW);
		const releaseJob = workflow.jobs?.release;
		const steps = releaseJob?.steps ?? [];
		const rustStep = steps.find(
			(step) =>
				step.uses ===
				"dtolnay/rust-toolchain@4cda84d5c5c54efe2404f9d843567869ab1699d4",
		);
		expect(rustStep).toBeDefined();
		expect(rustStep?.with).toEqual({
			toolchain: RELEASE_TOOLCHAIN.rust[0],
			targets: "wasm32-unknown-unknown",
		});

		expect(RELEASE_WORKFLOW).toContain(
			`cargo install wasm-bindgen-cli --version ${RELEASE_TOOLCHAIN.wasmBindgen[0]} --locked`,
		);
	});

	it("keeps exact-package consumers in CI aligned with the declared Node engine floor", () => {
		expect(WEBTRANSPORT_PACKAGE_JSON.engines?.node).toBe(">=18");

		const workflow = parseWorkflow(TEST_WORKFLOW);
		const packageConsumers = workflow.jobs?.["package-consumers"];
		expect(packageConsumers).toBeDefined();

		const lanes = packageConsumers?.strategy?.matrix?.include ?? [];
		expect(
			new Set(
				lanes.map(
					(lane) =>
						`${String(lane.os ?? "")}:${String(lane["node-version"] ?? "")}`,
				),
			),
		).toEqual(
			new Set([
				"ubuntu-latest:18.20.4",
				"ubuntu-latest:20.19.0",
				"ubuntu-latest:22.23.1",
				"macos-latest:18.20.4",
				"macos-latest:20.19.0",
				"macos-latest:22.23.1",
				"windows-latest:18.20.4",
				"windows-latest:20.19.0",
				"windows-latest:22.23.1",
			]),
		);
	});

	it("resolves local CI cargo commands through the release toolchain policy", () => {
		expect(LOCAL_CI_SCRIPT).toContain(".github/release-toolchain.json");
		expect(LOCAL_CI_SCRIPT).toContain("RUST_TOOLCHAIN");
		expect(LOCAL_CI_SCRIPT).toContain('cargo +"$RUST_TOOLCHAIN" fmt --check');
		expect(LOCAL_CI_SCRIPT).toContain(
			'rustup run "$RUST_TOOLCHAIN" bun run build:native',
		);
		expect(LOCAL_CI_SCRIPT).toContain(
			"cargo install cargo-audit --locked --version",
		);
		expect(LOCAL_CI_SCRIPT).toContain('cargo +"$RUST_TOOLCHAIN" audit');
		expect(LOCAL_CI_SCRIPT).toContain(
			'cargo +"$RUST_TOOLCHAIN" audit --file crates/wasm/Cargo.lock',
		);
	});

	it("makes the documented native build resolve the exact release Rust toolchain", () => {
		expect(ROOT_PACKAGE_JSON.scripts?.["build:native"]).toBe(
			"bun scripts/build-native.ts",
		);
		expect(ROOT_PACKAGE_JSON.devDependencies?.["@napi-rs/cli"]).toBe(
			RELEASE_TOOLCHAIN.napiRsCli[0],
		);
		expect(NATIVE_BUILD_SCRIPT).toContain(".github");
		expect(NATIVE_BUILD_SCRIPT).toContain("release-toolchain.json");
		expect(NATIVE_BUILD_SCRIPT).toContain(
			'"rustup",\n\t\t"run",\n\t\trustToolchain',
		);
		expect(NATIVE_BUILD_SCRIPT).toContain('"node_modules", "@napi-rs", "cli"');
		expect(NATIVE_BUILD_SCRIPT).not.toContain(
			'bun",\n\t\t"x",\n\t\t"@napi-rs/cli"',
		);
	});

	it("fails closed for direct root release:npm publishing", () => {
		const releaseNpm = ROOT_PACKAGE_JSON.scripts?.["release:npm"];
		expect(releaseNpm).toBeDefined();
		expect(releaseNpm).toContain("Direct npm publishing is disabled");
		expect(releaseNpm).not.toContain("npm publish -w");
	});

	it("rejects mutable action references and floating tool versions", () => {
		const result = runPolicy(`
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@${PIN}
        with:
          bun-version: latest
`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("40-character commit SHA");
		expect(result.stderr).toContain(
			"bun-version must be an exact three-part version",
		);
	});

	it("accepts exact tool versions sourced from matrix include lanes", () => {
		const result = runPolicy(`
jobs:
  package-consumers:
    permissions:
      contents: read
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            node-version: 18.20.4
          - os: ubuntu-latest
            node-version: 20.19.0
          - os: ubuntu-latest
            node-version: 22.23.1
    steps:
      - uses: actions/checkout@${PIN}
      - uses: actions/setup-node@${PIN}
        with:
          node-version: \${{ matrix.node-version }}
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("policy passed");
	});

	it("rejects workflow-wide write access and checkout without job-scoped read access", () => {
		const result = runPolicy(`
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${PIN}
`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("write permission must be scoped");
		expect(result.stderr).toContain("must explicitly grant contents: read");
	});

	it("rejects exact versions that are absent from the release toolchain policy", () => {
		const result = runPolicy(`
jobs:
  test:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${PIN}
      - uses: oven-sh/setup-bun@${PIN}
        with:
          bun-version: 1.3.8
`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("is not listed");
		expect(result.stderr).toContain("release-toolchain.json");
	});

	it("rejects unpinned cargo llvm coverage tooling", () => {
		const result = runPolicy(`
jobs:
  coverage:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${PIN}
      - run: cargo install cargo-llvm-cov --locked
`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"cargo-llvm-cov installs must include an exact --version",
		);
	});

	it("rejects unpinned cargo-fuzz installs", () => {
		const result = runPolicy(`
jobs:
  fuzz:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${PIN}
      - run: cargo install cargo-fuzz --locked
`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"cargo-fuzz installs must include an exact --version",
		);
	});

	it("rejects unapproved @napi-rs/cli installs", () => {
		const result = runPolicy(`
jobs:
  build:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${PIN}
      - run: bun add -d @napi-rs/cli@3.2.0
`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("@napi-rs/cli 3.2.0 is not listed");
		expect(result.stderr).toContain("release-toolchain.json");
	});

	it("rejects unpinned IWA packaging tools", () => {
		const result = runPolicy(`
jobs:
  iwa:
    runs-on: ubuntu-latest
    steps:
      - run: npm install --global wbn wbn-sign playwright
`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"IWA packaging tools must use exact allowlisted versions",
		);
	});

	it("rejects npm publishing without OIDC and provenance", () => {
		const result = runPolicy(`
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${PIN}
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: \${{ secrets.NPM_TOKEN }}
`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("id-token: write");
		expect(result.stderr).toContain("--provenance");
		expect(result.stderr).toContain("long-lived token");
		expect(result.stderr).toContain("exact npm CLI version");
	});

	it("rejects publishing from mutable GitHub release assets", () => {
		const result = runPolicy(
			`
on:
  release:
    types: [published]
jobs:
  publish:
    permissions:
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${PIN}
      - run: npm install --global npm@11.18.0
      - run: gh release download v1.0.0
      - run: npm publish package.tgz --provenance
`,
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"publish must consume an exact release workflow-run artifact",
		);
	});

	it("rejects comments and no-op strings posing as an immutable handoff", () => {
		const result = runPolicy(
			`
on:
  workflow_run:
    workflows: [release]
    types: [completed]
  workflow_dispatch:
    inputs:
      release_run_id:
        required: true
jobs:
  publish:
    permissions:
      actions: read
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      # name: npm-publish-input
      # run-id: \${{ env.RELEASE_RUN_ID }}
      # github-token: \${{ github.token }}
      - run: echo "candidate-identity.json .repository .workflowPath .releaseRunId .releaseRunAttempt .candidateCommit .tag .tarball .tarballSha256"
      - run: npm install --global npm@11.18.0
      - run: npm publish package.tgz --provenance
`,
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("structured immutable publish handoff");
	});

	it("rejects an artifact download that skips identity and digest verification", () => {
		const result = runPolicy(
			`
on:
  workflow_run:
    workflows: [release]
    types: [completed]
  workflow_dispatch:
    inputs:
      release_run_id:
        required: true
jobs:
  publish:
    permissions:
      actions: read
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${PIN}
        with:
          name: npm-publish-input-\${{ steps.release-run.outputs.run_attempt }}
          run-id: \${{ env.RELEASE_RUN_ID }}
          github-token: \${{ github.token }}
      - run: npm install --global npm@11.18.0
      - run: npm publish package.tgz --provenance
`,
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"candidate identity and digest verification",
		);
	});

	it("rejects rebuilding or publishing a tarball other than the verified output", () => {
		const result = runPolicy(
			`
on:
  workflow_run:
    workflows: [release]
    types: [completed]
  workflow_dispatch:
    inputs:
      release_run_id:
        required: true
jobs:
  publish:
    permissions:
      actions: read
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${PIN}
        with:
          name: npm-publish-input-\${{ steps.release-run.outputs.run_attempt }}
          run-id: \${{ env.RELEASE_RUN_ID }}
          github-token: \${{ github.token }}
      - id: candidate
        run: |
          jq -e '.repository and .workflowPath and .releaseRunId and .releaseRunAttempt and .candidateCommit and .tag and .tarball and .tarballSha256' candidate-identity.json
          EXPECTED_DIGEST="$(jq -r .tarballSha256 candidate-identity.json)"
          ACTUAL_DIGEST="$(shasum -a 256 downloaded.tgz | cut -d' ' -f1)"
          if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then exit 1; fi
          echo "tarball=downloaded.tgz" >> "$GITHUB_OUTPUT"
      - run: bun scripts/test-package-artifact.ts build
      - run: npm install --global npm@11.18.0
      - run: npm publish rebuilt.tgz --provenance
`,
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("must not rebuild or replace");
	});

	it("rejects alternate network acquisition in the publishing job", () => {
		const result = runPolicy(
			`
on:
  workflow_run:
    workflows: [release]
    types: [completed]
  workflow_dispatch:
    inputs:
      release_run_id:
        required: true
jobs:
  publish:
    permissions:
      actions: read
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${PIN}
        with:
          name: npm-publish-input-\${{ steps.release-run.outputs.run_attempt }}
          run-id: \${{ env.RELEASE_RUN_ID }}
          github-token: \${{ github.token }}
      - run: curl -fsSLo alternate.tgz https://example.invalid/package.tgz
      - run: npm install --global npm@11.18.0
      - run: npm publish alternate.tgz --provenance
`,
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("alternate package acquisition");
	});

	it("rejects an earlier-only digest check followed by tarball replacement", () => {
		const result = runPolicy(
			`
on:
  workflow_run:
    workflows: [release]
    types: [completed]
  workflow_dispatch:
    inputs:
      release_run_id:
        required: true
jobs:
  publish:
    if: >-
      (github.event_name == 'workflow_dispatch' &&
       github.ref == 'refs/heads/main') ||
      github.event.workflow_run.conclusion == 'success'
    permissions:
      actions: read
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@${PIN}
        with:
          name: npm-publish-input-\${{ steps.release-run.outputs.run_attempt }}
          run-id: \${{ env.RELEASE_RUN_ID }}
          github-token: \${{ github.token }}
      - id: candidate
        run: |
          INPUT_DIR="$RUNNER_TEMP/npm-publish-input"
          IDENTITY="$INPUT_DIR/candidate-identity.json"
          jq -e '.schemaVersion and .repository and .workflowPath and .releaseRunId and .releaseRunAttempt and .candidateCommit and .tag and .tarball and .tarballSha256' "$IDENTITY"
          EXPECTED_DIGEST="$(jq -er '.tarballSha256' "$IDENTITY")"
          ACTUAL_DIGEST="$(shasum -a 256 "$INPUT_DIR/downloaded.tgz" | cut -d' ' -f1)"
          if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then
            exit 1
          fi
          TARBALL="$INPUT_DIR/downloaded.tgz"
          echo "tarball=$TARBALL" >> "$GITHUB_OUTPUT"
      - run: npm install --global npm@11.18.0
      - name: Publish replaced input
        env:
          TARBALL: \${{ steps.candidate.outputs.tarball }}
        run: |
          cp replacement.tgz "$TARBALL"
          npm publish "$TARBALL" --provenance
`,
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("immediately re-verify candidate digest");
	});

	it("rejects hardcoded candidate metadata posing as release-run dataflow", () => {
		const result = runPolicy(
			`
on:
  workflow_run:
    workflows: [release]
    types: [completed]
  workflow_dispatch:
    inputs:
      release_run_id:
        required: true
jobs:
  publish:
    if: >-
      (github.event_name == 'workflow_dispatch' &&
       github.ref == 'refs/heads/main') ||
      github.event.workflow_run.conclusion == 'success'
    permissions:
      actions: read
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    env:
      RELEASE_RUN_ID: "123456"
    steps:
      - id: release-run
        run: |
          echo "candidate_commit=0123456789abcdef0123456789abcdef01234567" >> "$GITHUB_OUTPUT"
          echo "release_tag=v1.0.0" >> "$GITHUB_OUTPUT"
          echo "run_attempt=1" >> "$GITHUB_OUTPUT"
      - uses: actions/download-artifact@${PIN}
        with:
          name: npm-publish-input-\${{ steps.release-run.outputs.run_attempt }}
          run-id: \${{ env.RELEASE_RUN_ID }}
          github-token: \${{ github.token }}
      - id: candidate
        env:
          EXPECTED_COMMIT: 0123456789abcdef0123456789abcdef01234567
          EXPECTED_TAG: v1.0.0
          EXPECTED_ATTEMPT: "1"
        run: |
          INPUT_DIR="$RUNNER_TEMP/npm-publish-input"
          IDENTITY="$INPUT_DIR/candidate-identity.json"
          TARBALL="$INPUT_DIR/candidate.tgz"
          jq -e --arg repository "vmeansdev/webtransport-bun" --arg workflow ".github/workflows/release.yml" --argjson runId "123456" --argjson attempt "$EXPECTED_ATTEMPT" --arg commit "$EXPECTED_COMMIT" --arg tag "$EXPECTED_TAG" --arg tarball "candidate.tgz" '.schemaVersion == 1 and .repository == $repository and .workflowPath == $workflow and .releaseRunId == $runId and .releaseRunAttempt == $attempt and .candidateCommit == $commit and .tag == $tag and .tarball == $tarball and (.tarballSha256 | test("^[0-9a-f]{64}$"))' "$IDENTITY"
          EXPECTED_DIGEST="$(jq -er '.tarballSha256' "$IDENTITY")"
          ACTUAL_DIGEST="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
          if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then
            exit 1
          fi
          echo "tarball=$TARBALL" >> "$GITHUB_OUTPUT"
          echo "digest=$EXPECTED_DIGEST" >> "$GITHUB_OUTPUT"
      - run: npm install --global npm@11.18.0
      - name: Publish hardcoded candidate
        env:
          TARBALL: \${{ steps.candidate.outputs.tarball }}
          BOUND_DIGEST: \${{ steps.candidate.outputs.digest }}
        run: |
          IDENTITY="$RUNNER_TEMP/npm-publish-input/candidate-identity.json"
          EXPECTED_DIGEST="$(jq -er '.tarballSha256' "$IDENTITY")"
          ACTUAL_DIGEST="$(shasum -a 256 "$TARBALL" | cut -d' ' -f1)"
          if [ "$EXPECTED_DIGEST" != "$BOUND_DIGEST" ] || [ "$ACTUAL_DIGEST" != "$BOUND_DIGEST" ]; then
            echo "digest mismatch"
            exit 1
          fi
          npm publish "$TARBALL" --provenance
`,
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("live release-run metadata dataflow");
	});

	it("rejects release-run jq identity validation with a swallowed failure branch", () => {
		const result = runPolicy(
			mutatePublishWorkflow(
				'"$RUN_JSON" >/dev/null',
				'"$RUN_JSON" >/dev/null || :',
			),
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("live release-run metadata dataflow");
	});

	it("rejects candidate jq identity validation with a swallowed failure branch", () => {
		const result = runPolicy(
			mutatePublishWorkflow(
				'"$IDENTITY" >/dev/null',
				'"$IDENTITY" >/dev/null || :',
			),
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"candidate identity and digest verification",
		);
	});

	it("rejects disabled errexit in release-run identity validation", () => {
		const result = runPolicy(
			mutatePublishWorkflowOccurrence("set -euo pipefail", "set +e", 1),
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("live release-run metadata dataflow");
	});

	it("rejects disabled errexit in candidate identity validation", () => {
		const result = runPolicy(
			mutatePublishWorkflowOccurrence("set -euo pipefail", "set +e", 2),
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"candidate identity and digest verification",
		);
	});

	it("rejects release-run shell state and executable shadowing", () => {
		const preambleMutations = [
			"jq() { return 0; }",
			"function exit() { return 0; }",
			"trap 'exit 0' EXIT",
			'PATH="$RUNNER_TEMP/bin:$PATH"',
			"shopt -s expand_aliases\n          alias jq=true",
		];
		for (const preamble of preambleMutations) {
			const result = runPolicy(
				mutatePublishWorkflow(
					'          set -euo pipefail\n          if [ "$GITHUB_REPOSITORY" != "$EXPECTED_REPOSITORY" ]; then',
					`          set -euo pipefail\n          ${preamble}\n          if [ "$GITHUB_REPOSITORY" != "$EXPECTED_REPOSITORY" ]; then`,
				),
				"publish.yml",
			);
			expect(result.status, preamble).toBe(1);
			expect(result.stderr, preamble).toContain(
				"live release-run metadata dataflow",
			);
		}
	});

	it("rejects a command prefix on release-run identity validation", () => {
		const result = runPolicy(
			mutatePublishWorkflow("          jq -e \\", "          command jq -e \\"),
			"publish.yml",
		);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("live release-run metadata dataflow");
	});

	it("rejects injected publish environment used for shell shadowing", () => {
		const mutations = [
			[
				"permissions: {}\n\nconcurrency:",
				"permissions: {}\n\nenv:\n  BASH_ENV: /tmp/shadow-jq\n\nconcurrency:",
			],
			[
				"      EXPECTED_RELEASE_WORKFLOW: .github/workflows/release.yml",
				"      EXPECTED_RELEASE_WORKFLOW: .github/workflows/release.yml\n      PATH: /tmp/shadow-bin",
			],
			[
				"          GH_TOKEN: $" + "{{ github.token }}",
				"          GH_TOKEN: $" +
					"{{ github.token }}\n          BASH_ENV: /tmp/shadow-jq",
			],
			[
				"          GH_TOKEN: $" + "{{ github.token }}",
				"          GH_TOKEN: $" +
					'{{ github.token }}\n          "BASH_FUNC_jq%%": "() { return 0; }"',
			],
		];
		for (const [search, replacement] of mutations) {
			const result = runPolicy(
				mutatePublishWorkflow(search ?? "", replacement ?? ""),
				"publish.yml",
			);
			expect(result.status, replacement).toBe(1);
			expect(result.stderr, replacement).toContain(
				"live release-run metadata dataflow",
			);
		}
	});

	it("rejects candidate preamble and environment shadowing", () => {
		const mutations = [
			[
				'          set -euo pipefail\n          INPUT_DIR="$RUNNER_TEMP/npm-publish-input"',
				'          set -euo pipefail\n          jq() { return 0; }\n          INPUT_DIR="$RUNNER_TEMP/npm-publish-input"',
			],
			[
				"          EXPECTED_ATTEMPT: $" +
					"{{ steps.release-run.outputs.run_attempt }}",
				"          EXPECTED_ATTEMPT: $" +
					"{{ steps.release-run.outputs.run_attempt }}\n          BASH_ENV: /tmp/shadow-jq",
			],
		];
		for (const [search, replacement] of mutations) {
			const result = runPolicy(
				mutatePublishWorkflow(search ?? "", replacement ?? ""),
				"publish.yml",
			);
			expect(result.status, replacement).toBe(1);
			expect(result.stderr, replacement).toContain(
				"candidate identity and digest verification",
			);
		}
	});

	it("rejects noncanonical workflow environment keys", () => {
		const environmentKeys = ['"env"', '!!str "env"', "&environment env"];
		const accepted: string[] = [];
		for (const environmentKey of environmentKeys) {
			const result = runPolicy(
				mutatePublishWorkflow(
					"permissions: {}\n\nconcurrency:",
					`permissions: {}\n\n${environmentKey}:\n  BASH_ENV: /tmp/shadow-jq\n\nconcurrency:`,
				),
				"publish.yml",
			);
			if (result.status === 0) accepted.push(environmentKey);
		}
		expect(accepted).toEqual([]);
	});

	it("rejects workflow and publish-job run defaults", () => {
		const mutations = [
			[
				"workflow shell",
				"permissions: {}\n\nconcurrency:",
				"permissions: {}\n\ndefaults:\n  run:\n    shell: bash --noprofile --norc --init-file /tmp/attacker {0}\n\nconcurrency:",
			],
			[
				"quoted workflow shell",
				"permissions: {}\n\nconcurrency:",
				'permissions: {}\n\n"defaults":\n  "run":\n    "shell": bash --noprofile --norc --init-file /tmp/attacker {0}\n\nconcurrency:',
			],
			[
				"job working directory",
				"    runs-on: ubuntu-latest\n    timeout-minutes: 25",
				"    runs-on: ubuntu-latest\n    defaults:\n      run:\n        working-directory: /tmp\n    timeout-minutes: 25",
			],
			[
				"quoted job shell",
				"    runs-on: ubuntu-latest\n    timeout-minutes: 25",
				'    runs-on: ubuntu-latest\n    "defaults":\n      "run":\n        "shell": bash --noprofile --norc --init-file /tmp/attacker {0}\n    timeout-minutes: 25',
			],
		] as const;
		const accepted: string[] = [];
		for (const [name, search, replacement] of mutations) {
			const result = runPolicy(
				mutatePublishWorkflow(search, replacement),
				"publish.yml",
			);
			if (result.status === 0) accepted.push(name);
		}
		expect(accepted).toEqual([]);
	});

	it("fails closed for quoted publish workflow structural keys", () => {
		const mutations = [
			["jobs", "jobs:", '"jobs":'],
			["publish", "  publish:", '  "publish":'],
			["steps", "    steps:", '    "steps":'],
			["run", "        run: |", '        "run": |'],
			[
				"shell",
				"        run: |\n          set -euo pipefail",
				'        "shell": bash --noprofile --norc --init-file /tmp/attacker {0}\n        run: |\n          set -euo pipefail',
			],
		] as const;
		const accepted: string[] = [];
		for (const [name, search, replacement] of mutations) {
			const result = runPolicy(
				mutatePublishWorkflow(search, replacement),
				"publish.yml",
			);
			if (result.status === 0) accepted.push(name);
		}
		expect(accepted).toEqual([]);
	});

	it("accepts immutable actions and trusted publishing with exact toolchains", () => {
		const result = runPolicy(`
jobs:
  publish:
    permissions:
      contents: read
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${PIN}
      - uses: oven-sh/setup-bun@${PIN}
        with:
          bun-version: 1.3.9
      - uses: actions/setup-node@${PIN}
        with:
          node-version: 22.23.1
      - run: npm install --global npm@11.18.0
      - run: npm publish --provenance
`);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("policy passed");
	});

	it("rejects workflow inputs interpolated into shell run source", () => {
		const campaignSeedExpression =
			"$" + "{{ github.event.inputs.campaign_seed }}";
		const result = runPolicy(`
jobs:
  soak:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "${campaignSeedExpression}"
`);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("must pass through step env");

		const accepted = runPolicy(`
jobs:
  soak:
    permissions:
      contents: read
    runs-on: ubuntu-latest
    steps:
      - env:
          CAMPAIGN_SEED: ${campaignSeedExpression}
        run: |
          echo "$CAMPAIGN_SEED"
`);
		expect(accepted.status).toBe(0);
	});

	it("validates soak inputs against shell metacharacters and bounded lengths", () => {
		expect(runSoakInputValidation().status).toBe(0);
		for (const [key, value] of [
			["CANDIDATE_REF", "refs/tags/v1;touch /tmp/pwned"],
			["CAMPAIGN_SEED", "seed$(id)"],
			["CONTINUITY_TOKEN", "token && echo pwned"],
		] as const) {
			const result = runSoakInputValidation({ [key]: value });
			expect(result.status, key).toBe(1);
		}
		expect(SOAK_WORKFLOW).toContain("validate-soak-inputs.sh");
		expect(SOAK_WORKFLOW).toContain(
			"INPUT_CANDIDATE_COMMIT: " +
				"${{ github.event.inputs.candidate_commit }}",
		);
	});

	it("bounds the datagram batch and RSS ceiling soak inputs", () => {
		for (const [key, value] of [
			["DATAGRAM_BATCH", ""],
			["DATAGRAM_BATCH", "-1"],
			["DATAGRAM_BATCH", "257"],
			["DATAGRAM_BATCH", "1.5"],
			["DATAGRAM_BATCH", undefined],
			["RSS_CEILING_MB", ""],
			["RSS_CEILING_MB", "0"],
			["RSS_CEILING_MB", "-1"],
			["RSS_CEILING_MB", "1.5"],
			["RSS_CEILING_MB", undefined],
		] as const) {
			const result = runSoakInputValidation({ [key]: value });
			expect(result.status, `${key}=${String(value)}`).toBe(1);
		}
		expect(runSoakInputValidation({ DATAGRAM_BATCH: "0" }).status).toBe(0);
		expect(runSoakInputValidation({ DATAGRAM_BATCH: "256" }).status).toBe(0);
		expect(runSoakInputValidation({ RSS_CEILING_MB: "1" }).status).toBe(0);
	});

	it("declares the new soak inputs and threads them into the validator and run", () => {
		const workflow = parseWorkflow(SOAK_WORKFLOW);
		const inputs = (
			Bun.YAML.parse(SOAK_WORKFLOW) as {
				on?: {
					workflow_dispatch?: {
						inputs?: Record<string, { default?: unknown; required?: boolean }>;
					};
				};
			}
		).on?.workflow_dispatch?.inputs;
		expect(inputs?.datagram_batch?.default).toBe("64");
		expect(inputs?.datagram_batch?.required).toBe(true);
		expect(inputs?.rss_ceiling_mb?.default).toBe("1750");
		expect(inputs?.rss_ceiling_mb?.required).toBe(true);
		// Existing lanes keep their current defaults, so a routine 1h/24h/72h
		// dispatch behaves exactly as before.
		expect(inputs?.committed_abort_mb?.default).toBe("1500");
		expect(inputs?.duration_hours?.default).toBe("1");
		expect(inputs?.runner_mode?.default).toBe("shared");

		const steps = workflow.jobs?.soak?.steps ?? [];
		const validateIndex = steps.findIndex(
			(step) => step.name === "Validate campaign inputs",
		);
		const checkoutIndex = steps.findIndex((step) =>
			String(step.uses ?? "").startsWith("actions/checkout@"),
		);
		expect(checkoutIndex).toBe(0);
		expect(validateIndex).toBe(1);
		const validateEnv = (steps[validateIndex]?.env ?? {}) as Record<
			string,
			string
		>;
		expect(validateEnv.DATAGRAM_BATCH).toBe(
			gh("github.event.inputs.datagram_batch"),
		);
		expect(validateEnv.RSS_CEILING_MB).toBe(
			gh("github.event.inputs.rss_ceiling_mb"),
		);
		expect(validateEnv.COMMITTED_ABORT_MB).toBe(
			gh("github.event.inputs.committed_abort_mb"),
		);
		expect(validateEnv.WORKFLOW_REF).toBe(gh("github.ref"));
		expect(validateEnv.WORKFLOW_SHA).toBe(gh("github.sha"));
		expect(validateEnv).not.toHaveProperty("ACTUAL_HEAD");

		const capacityEnv = (steps.find(
			(step) => step.name === "Profile runner capacity",
		)?.env ?? {}) as Record<string, string>;
		expect(capacityEnv.WORKFLOW_REF).toBe(gh("github.ref"));
		expect(capacityEnv.CANDIDATE_REF).toBe(
			gh("github.event.inputs.candidate_ref"),
		);

		expect(SOAK_WORKFLOW).toContain(
			`run-name: soak-long-${gh("inputs.campaign_seed")}`,
		);
		expect(SOAK_WORKFLOW).toContain(
			`WEBTRANSPORT_DATAGRAM_BATCH: ${gh("github.event.inputs.datagram_batch")}`,
		);
		expect(SOAK_WORKFLOW).toContain(
			`SOAK_RSS_CEIL_MB: ${gh("github.event.inputs.rss_ceiling_mb")}`,
		);
		expect(SOAK_WORKFLOW).toContain(
			"env -u WEBTRANSPORT_PAYLOAD_DELIVERY -u WEBTRANSPORT_DATAGRAM_BATCH_DIAGNOSTICS \\",
		);
	});

	it("pins the hosted H7 tag identity and its fixed capacity profile", () => {
		expect(runH7SoakInputValidation().status).toBe(0);
		for (const [key, value] of [
			["WORKFLOW_REF", "refs/heads/main"],
			["WORKFLOW_SHA", "89abcdef0123456789abcdef0123456789abcdef"],
			["ACTUAL_HEAD", "fedcba9876543210fedcba9876543210fedcba98"],
			[
				"CANDIDATE_REF",
				"refs/tags/h7-batch-delivery-fedcba9876543210fedcba9876543210fedcba98",
			],
			["DURATION_HOURS", "1"],
			["RUNNER_TYPE", "github-hosted"],
			["RUNNER_MODE", "shared"],
			["SEGMENT_COUNT", "5"],
			["DATAGRAM_BATCH", "32"],
			["RSS_CEILING_MB", "1024"],
			["COMMITTED_ABORT_MB", "1500"],
		] as const) {
			expect(runH7SoakInputValidation({ [key]: value }).status, key).toBe(1);
		}
		// Non-H7 lanes keep the previous candidate-ref policy.
		expect(
			runSoakInputValidation({ CANDIDATE_REF: "refs/tags/v1.0.0" }).status,
		).toBe(0);
		expect(runSoakInputValidation({ CANDIDATE_REF: "" }).status).toBe(0);

		// A qualifying H7 runner must never take the shared halving or the
		// small-profile downscale branches.
		const capacityRun = String(
			(parseWorkflow(SOAK_WORKFLOW).jobs?.soak?.steps ?? []).find(
				(step) => step.name === "Profile runner capacity",
			)?.run ?? "",
		);
		expect(capacityRun).toContain('PROFILE="h7-fixed-large"');
		expect(capacityRun).toContain("SOAK_SESSIONS=500");
		expect(capacityRun).toContain("H7 hosted lane requires >= 5 CPUs");
		expect(capacityRun).toContain("H7_FIXED=1");
		expect(capacityRun).toMatch(/if \[ "\$H7_FIXED" != "1" \]/);
	});
});
