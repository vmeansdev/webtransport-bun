/**
 * Offline stand-in for the GitHub CLI used by internal-release-evidence.test.ts.
 * It implements just the `gh` calls scripts/release-evidence*.ts make, against
 * a JSON state file named by FAKE_GH_STATE; release assets and run artifacts
 * are plain directories. Every invocation is appended to `calls`.
 */
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

type Asset = { name: string; size: number; digest: string };
type Release = {
	isPrerelease: boolean;
	isDraft: boolean;
	isImmutable: boolean;
	assets: Asset[];
	/** Model a release API response without asset digests. */
	omitDigests?: boolean;
	dir: string;
};
type Run = {
	databaseId: number;
	headSha: string;
	status: string;
	conclusion: string;
	url: string;
	workflowName: string;
	/** Workflow file path, as `GET /repos/{repo}/actions/runs/{id}` reports it. */
	path: string;
	attempt: number;
	artifacts: Record<string, string>;
	artifactListing?: {
		id: number;
		name: string;
		digest: string | null;
		expired: boolean;
	}[];
};
type State = {
	repo: string;
	tags: Record<string, string>;
	releases: Record<string, Release>;
	runs: Record<string, Run>;
	storeDir: string;
	calls: string[][];
	/** Overwrite this local file the first time `release view` runs: models
	 * a file replaced between upload's validation and its `gh` call. */
	mutateOnView?: { path: string; content: string } | null;
	/** Store different bytes than the file given to `release upload`, as a
	 * corrupted or swapped upload would. */
	corruptUpload?: boolean;
	/** Applied to the release right after an upload: models the release
	 * being promoted, frozen or retagged while evidence was uploading. */
	afterUpload?: {
		isPrerelease?: boolean;
		isImmutable?: boolean;
		isDraft?: boolean;
		tagCommit?: string;
	} | null;
	/** `release upload` attaches only this many files, then fails. */
	uploadFailAfter?: number | null;
	/** The next N `release view` calls after an upload fail with HTTP 502. */
	viewFailuresAfterUpload?: number;
	/** Pending `release view` failures (set from viewFailuresAfterUpload). */
	viewFailures?: number;
	/** Every `release delete-asset` fails with HTTP 500. */
	deleteFails?: boolean;
	/** Base64 of the exact bytes of every file `release upload` was given,
	 * read when it was invoked. */
	uploadedBytes?: Record<string, string>;
};

const statePath = process.env.FAKE_GH_STATE;
if (!statePath) {
	console.error("FAKE_GH_STATE is not set");
	process.exit(2);
}
const state = JSON.parse(readFileSync(statePath, "utf8")) as State;
const args = process.argv.slice(2);
state.calls.push(args);
const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

function flag(name: string): string | undefined {
	const index = args.indexOf(name);
	return index === -1 ? undefined : args[index + 1];
}

function fail(message: string, code = 1): never {
	save();
	console.error(message);
	process.exit(code);
}

function checkRepo(): void {
	if (flag("--repo") !== state.repo)
		fail(`HTTP 404: unknown repository ${flag("--repo")}`);
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function globToRegExp(pattern: string): RegExp {
	return new RegExp(
		`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
	);
}

const [group, command, subject] = args;

/** Artifact listing: ids and digests derived from the artifact directory,
 * so replacing an artifact's bytes changes its digest. A run can override
 * the listing with `artifactListing` to model tampering. */
function artifactListing(run: Run) {
	if (run.artifactListing) return run.artifactListing;
	return Object.entries(run.artifacts).map(([name, dir], index) => {
		const hash = createHash("sha256");
		const walk = (path: string) => {
			for (const entry of readdirSync(path, { withFileTypes: true }).sort(
				(a, b) => a.name.localeCompare(b.name),
			)) {
				const child = join(path, entry.name);
				if (entry.isDirectory()) walk(child);
				else hash.update(entry.name).update(readFileSync(child));
			}
		};
		if (existsSync(dir)) walk(dir);
		return {
			id: run.databaseId * 100 + index + 1,
			name,
			digest: `sha256:${hash.digest("hex")}`,
			expired: false,
		};
	});
}

if (group === "api") {
	const artifactsMatch =
		/^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/artifacts(?:\?.*)?$/.exec(
			command ?? "",
		);
	if (artifactsMatch) {
		if (artifactsMatch[1] !== state.repo) fail("HTTP 404: Not Found");
		const run = state.runs[artifactsMatch[2] as string];
		if (!run) fail("HTTP 404: Not Found");
		save();
		console.log(JSON.stringify({ artifacts: artifactListing(run) }));
		process.exit(0);
	}
	const runMatch = /^repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(
		command ?? "",
	);
	if (runMatch) {
		if (runMatch[1] !== state.repo) fail("HTTP 404: Not Found");
		const run = state.runs[runMatch[2] as string];
		if (!run) fail("HTTP 404: Not Found");
		save();
		console.log(
			JSON.stringify({
				id: run.databaseId,
				path: run.path,
				head_sha: run.headSha,
				status: run.status,
				conclusion: run.conclusion,
			}),
		);
		process.exit(0);
	}
	const match = /^repos\/([^/]+\/[^/]+)\/commits\/(.+)$/.exec(command ?? "");
	if (!match || match[1] !== state.repo) fail("HTTP 404: Not Found");
	const sha = state.tags[decodeURIComponent(match[2] as string)];
	if (!sha) fail("HTTP 422: No commit found for SHA");
	save();
	console.log(JSON.stringify({ sha }));
	process.exit(0);
}

if (group === "release") {
	checkRepo();
	const tag = subject as string;
	const release = state.releases[tag];
	if (command === "view") {
		if ((state.viewFailures ?? 0) > 0) {
			state.viewFailures = (state.viewFailures as number) - 1;
			fail("HTTP 502: Server Error");
		}
		if (state.mutateOnView) {
			writeFileSync(state.mutateOnView.path, state.mutateOnView.content);
			state.mutateOnView = null;
		}
		if (!release) fail("release not found");
		save();
		console.log(
			JSON.stringify({
				tagName: tag,
				isPrerelease: release.isPrerelease,
				isDraft: release.isDraft,
				isImmutable: release.isImmutable,
				assets: release.assets.map(({ name, size, digest }) =>
					release.omitDigests ? { name, size } : { name, size, digest },
				),
			}),
		);
		process.exit(0);
	}
	if (command === "create") {
		if (!state.tags[tag]) fail(`tag ${tag} does not exist`);
		if (release) fail("a release with the same tag name already exists");
		const dir = join(state.storeDir, `release-${tag}`);
		mkdirSync(dir, { recursive: true });
		state.releases[tag] = {
			isPrerelease: args.includes("--prerelease"),
			isDraft: false,
			isImmutable: false,
			assets: [],
			dir,
		};
		save();
		process.exit(0);
	}
	if (command === "upload") {
		if (!release) fail("release not found");
		const files = args
			.slice(3)
			.filter(
				(arg, index, all) => arg !== "--repo" && all[index - 1] !== "--repo",
			);
		let attachedCount = 0;
		for (const file of files) {
			if (
				state.uploadFailAfter !== undefined &&
				state.uploadFailAfter !== null &&
				attachedCount >= state.uploadFailAfter
			) {
				state.viewFailures = state.viewFailuresAfterUpload ?? 0;
				fail(`HTTP 502: upload of ${basename(file)} failed`);
			}
			attachedCount += 1;
			const name = basename(file);
			if (
				release.assets.some((asset) => asset.name === name) &&
				!args.includes("--clobber")
			)
				fail(`asset under the same name already exists: [${name}]`);
			state.uploadedBytes = {
				...(state.uploadedBytes ?? {}),
				[name]: readFileSync(file).toString("base64"),
			};
			const stored = join(release.dir, name);
			if (state.corruptUpload)
				writeFileSync(
					stored,
					Buffer.concat([readFileSync(file), Buffer.from("x")]),
				);
			// Store a copy of the bytes, not the file: a release keeps no modes.
			else writeFileSync(stored, readFileSync(file));
			release.assets = release.assets.filter((asset) => asset.name !== name);
			release.assets.push({
				name,
				size: readFileSync(stored).length,
				digest: `sha256:${sha256(stored)}`,
			});
		}
		if (state.afterUpload) {
			const { tagCommit, ...flags } = state.afterUpload;
			Object.assign(release, flags);
			if (tagCommit) state.tags[tag] = tagCommit;
			state.afterUpload = null;
		}
		state.viewFailures = state.viewFailuresAfterUpload ?? 0;
		save();
		process.exit(0);
	}
	if (command === "delete-asset") {
		if (!release) fail("release not found");
		if (state.deleteFails) fail("HTTP 500: Internal Server Error");
		const name = args[3] as string;
		if (!release.assets.some((asset) => asset.name === name))
			fail(`asset ${name} not found`);
		release.assets = release.assets.filter((asset) => asset.name !== name);
		rmSync(join(release.dir, name), { force: true });
		save();
		process.exit(0);
	}
	if (command === "download") {
		if (!release) fail("release not found");
		const dir = flag("--dir") as string;
		const pattern = globToRegExp(flag("--pattern") ?? "*");
		mkdirSync(dir, { recursive: true });
		const matches = release.assets.filter((asset) => pattern.test(asset.name));
		if (matches.length === 0) fail("no assets match the file pattern");
		for (const asset of matches) {
			// Downloads come from the release store, so a test can tamper with a
			// stored file to model an asset that was replaced after the fact.
			cpSync(join(release.dir, asset.name), join(dir, asset.name));
		}
		save();
		process.exit(0);
	}
}

if (group === "run") {
	checkRepo();
	const run = state.runs[subject as string];
	if (!run) fail("HTTP 404: run not found");
	if (command === "view") {
		const { artifacts: _artifacts, artifactListing: _listing, ...view } = run;
		save();
		console.log(JSON.stringify(view));
		process.exit(0);
	}
	if (command === "download") {
		const name = flag("--name") as string;
		const source = run.artifacts[name];
		if (!source || !existsSync(source)) fail(`no artifact matches ${name}`);
		const dir = flag("--dir") as string;
		mkdirSync(dir, { recursive: true });
		for (const entry of readdirSync(source))
			cpSync(join(source, entry), join(dir, entry), { recursive: true });
		save();
		process.exit(0);
	}
}

fail(`fake gh: unsupported invocation ${args.join(" ")}`, 2);
