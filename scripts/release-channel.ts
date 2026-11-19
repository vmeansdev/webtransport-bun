#!/usr/bin/env bun
/**
 * Versions for the canary and nightly channels (docs/BRANCHING.md).
 *
 * A channel build stamps a pre-release of the committed base version:
 *
 *   canary   1.0.0-canary.<commit count>.g<sha7>   (npm dist-tag `canary`)
 *   nightly  1.0.0-nightly.<YYYYMMDD>.g<sha7>      (npm dist-tag `nightly`)
 *
 * The commit count orders canaries along development's history, so a later
 * canary always sorts above an earlier one; the sha keeps two builds of one
 * count (or one day) distinct. The `g` prefix keeps the sha
 * an alphanumeric identifier: a bare sha such as `0123abc` is fine, but an
 * all-digit one with a leading zero is not valid semver.
 *
 * Usage:
 *   bun scripts/release-channel.ts version <canary|nightly> <commit>
 *   bun scripts/release-channel.ts stamp <canary|nightly> <commit>
 * Both print the version; `stamp` also writes it into package.json.
 */
import {
	committedVersion,
	writePackageVersion,
} from "./stamp-version-from-tag.ts";

export const CHANNELS = ["canary", "nightly"] as const;
export type Channel = (typeof CHANNELS)[number];

const BASE_VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;

export function isChannel(value: string): value is Channel {
	return (CHANNELS as readonly string[]).includes(value);
}

export function channelVersion(input: {
	base: string;
	channel: Channel;
	commit: string;
	commitCount: number;
	date: Date;
}): string {
	const { base, channel, commit, commitCount, date } = input;
	if (!BASE_VERSION.test(base))
		throw new Error(
			`committed package version ${base} must be a base version X.Y.Z`,
		);
	if (!isChannel(channel)) throw new Error(`unknown channel ${channel}`);
	if (!SHA.test(commit))
		throw new Error(`commit ${commit} is not a full 40-character sha`);
	if (!Number.isSafeInteger(commitCount) || commitCount < 1)
		throw new Error(`commit count ${commitCount} must be a positive integer`);
	if (Number.isNaN(date.getTime())) throw new Error("invalid build date");
	const order =
		channel === "canary"
			? String(commitCount)
			: date.toISOString().slice(0, 10).replaceAll("-", "");
	return `${base}-${channel}.${order}.g${commit.slice(0, 7)}`;
}

/** The channel a version was stamped for, or undefined for any other version. */
export function channelOf(version: string): Channel | undefined {
	const match = /^\d+\.\d+\.\d+-(canary|nightly)\.\d+\.g[0-9a-f]{7}$/.exec(
		version,
	);
	return match ? (match[1] as Channel) : undefined;
}

function commitCount(commit: string): number {
	const result = Bun.spawnSync(["git", "rev-list", "--count", commit], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0)
		throw new Error(`git rev-list --count ${commit} failed`);
	return Number.parseInt(result.stdout.toString().trim(), 10);
}

if (import.meta.main) {
	const [mode, channel, commit] = Bun.argv.slice(2);
	if (
		(mode !== "version" && mode !== "stamp") ||
		!channel ||
		!isChannel(channel) ||
		!commit
	) {
		console.error(
			"usage: bun scripts/release-channel.ts <version|stamp> <canary|nightly> <commit>",
		);
		process.exit(2);
	}
	let version: string;
	try {
		version = channelVersion({
			base: committedVersion(),
			channel,
			commit,
			commitCount: commitCount(commit),
			date: new Date(),
		});
	} catch (error) {
		console.error(
			`release-channel: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	}
	if (mode === "stamp") writePackageVersion(version);
	console.log(version);
}
