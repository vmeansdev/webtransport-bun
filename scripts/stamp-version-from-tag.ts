#!/usr/bin/env bun
/**
 * The published package version comes from the pushed tag, not from the
 * commit. The committed packages/webtransport/package.json carries the base
 * version (`1.0.0`); a release build stamps the version from its tag:
 *
 *   v1.0.0-rc.2 -> 1.0.0-rc.2  (npm dist-tag `next`)
 *   v1.0.0      -> 1.0.0       (npm dist-tag `latest`)
 *
 * so the release candidate and GA can be tagged on the same commit. Any tag
 * that is not `v<base>` or `v<base>-<pre-release>` is refused.
 *
 * Usage:
 *   bun scripts/stamp-version-from-tag.ts <tag>          # rewrite package.json
 *   bun scripts/stamp-version-from-tag.ts <tag> --check  # validate only
 * Prints the stamped version.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_JSON = resolve(
	import.meta.dir,
	"..",
	"packages",
	"webtransport",
	"package.json",
);

const BASE_VERSION = /^\d+\.\d+\.\d+$/;
const PRE_RELEASE = /^[0-9A-Za-z][0-9A-Za-z.-]*$/;

/** The version `tag` stamps onto a package whose committed version is
 * `committed`; throws when the tag does not belong to that base version. */
export function stampedVersion(tag: string, committed: string): string {
	if (!BASE_VERSION.test(committed))
		throw new Error(
			`committed package version ${committed} must be a base version X.Y.Z; pre-release versions come from tags`,
		);
	if (tag === `v${committed}`) return committed;
	const prefix = `v${committed}-`;
	if (tag.startsWith(prefix) && PRE_RELEASE.test(tag.slice(prefix.length)))
		return tag.slice(1);
	throw new Error(
		`tag ${tag} is neither v${committed} nor a pre-release v${committed}-<pre> of the committed version`,
	);
}

export function distTagFor(version: string): "next" | "latest" {
	return version.includes("-") ? "next" : "latest";
}

if (import.meta.main) {
	const [tag, flag] = Bun.argv.slice(2);
	if (!tag || (flag !== undefined && flag !== "--check")) {
		console.error(
			"usage: bun scripts/stamp-version-from-tag.ts <tag> [--check]",
		);
		process.exit(2);
	}
	const text = readFileSync(PACKAGE_JSON, "utf8");
	const pkg = JSON.parse(text) as { version: string };
	let version: string;
	try {
		version = stampedVersion(tag, pkg.version);
	} catch (error) {
		console.error(
			`stamp-version-from-tag: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
	if (flag !== "--check" && version !== pkg.version) {
		// Replace only the version field, keeping the file's formatting.
		const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
		if (JSON.parse(next).version !== version)
			throw new Error("could not rewrite the package version");
		writeFileSync(PACKAGE_JSON, next);
	}
	console.log(version);
}
