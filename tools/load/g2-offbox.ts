/**
 * How G2's harness reaches the generator, now that the generator is the Mac.
 *
 * The retired path scp'd a Linux `load-client` to a sibling VM and ran it under
 * `ssh dest timeout N /tmp/load-client …`. Three of that path's assumptions are
 * false on this topology, and each one fails silently rather than loudly:
 *
 *   * a Linux runner cannot build a macOS/arm64 binary, so nothing may be
 *     copied — the Mac builds its own from the candidate SHA;
 *   * `timeout(1)` does not exist on macOS, so the deadline has to be the entry
 *     script's own watchdog;
 *   * `/tmp/load-client` is a *path assumption*. A stale binary left there by an
 *     earlier run answers happily and produces a fine-looking number from a tree
 *     no SHA describes. This module never names a remote binary path at all: it
 *     names a `--bin` from the entry script's closed set and a `--candidate`,
 *     and the build happens on the far side.
 *
 * The interface is `tools/offbox/mac-generator-entry.sh`. It *refuses* rather
 * than warns, so every refusal it makes is mirrored here as a check performed
 * before anything is spawned — a mistake surfaces as a sentence about the
 * candidate SHA rather than as exit status 3 six frames down an ssh channel.
 *
 * | refusal | exit | mirrored by |
 * |---|---|---|
 * | unknown argument | 3 | `macgenInvocation` emits only flags the script parses |
 * | `--candidate` missing / not 40 lowercase hex | 3 | `assertCandidate` |
 * | `--bin` outside the closed set | 3 | `assertMacgenBin` |
 * | no clone, dirty clone, unreachable candidate, failed build | 3 | remote-only |
 * | watchdog fired | 4 | `macgenDeadlineSeconds` sizes the deadline |
 */

/** The entry script's closed set, restated so a typo refuses locally. */
export const MACGEN_BINS = ["load-client", "broadcast-client"] as const;
export type MacgenBin = (typeof MACGEN_BINS)[number];

/** G2's generator binary. Passed explicitly; never left to the script's default. */
export const G2_MACGEN_BIN: MacgenBin = "load-client";

/** Where the entry script lives on the Mac, relative to the ssh login's cwd. */
export const MACGEN_ENTRY = "tools/offbox/mac-generator-entry.sh";

/**
 * The script's own rule, restated: a full 40-character lowercase object name,
 * never a ref and never an abbreviation. Candidate SHAs come from `git
 * rev-parse`; accepting a branch name here would let the generator drift from
 * the tree the gate is stamped against.
 */
export function assertCandidate(candidate: string): string {
	if (candidate === "") {
		throw new Error(
			"g2-offbox: an off-box cell requires a candidate SHA — " +
				"mac-generator-entry.sh refuses without --candidate (exit 3)",
		);
	}
	if (!/^[0-9a-f]{40}$/.test(candidate)) {
		throw new Error(
			`g2-offbox: candidate '${candidate}' is not a full 40-character ` +
				"lowercase sha; mac-generator-entry.sh refuses it (exit 3)",
		);
	}
	return candidate;
}

export function assertMacgenBin(bin: string): MacgenBin {
	if (!(MACGEN_BINS as readonly string[]).includes(bin)) {
		throw new Error(
			`g2-offbox: --bin must be one of ${MACGEN_BINS.join("|")}, got '${bin}'; ` +
				"mac-generator-entry.sh refuses it (exit 3)",
		);
	}
	return bin as MacgenBin;
}

/**
 * The watchdog deadline, in seconds.
 *
 * It has to cover the drive window, the connect ramp for the registered session
 * count and the client's own exit, with margin: a watchdog that fires mid-window
 * destroys the cell and surfaces as exit 4, which the rerun policy reads as an
 * infra fault rather than as a result. The 1.5× is the same multiplier G10's
 * conductor uses, so the two off-box gates size their deadline the same way.
 */
export function macgenDeadlineSeconds(
	driveSeconds: number,
	connectRampSeconds: number,
	exitGraceSeconds = 10,
): number {
	return Math.ceil(
		(driveSeconds + connectRampSeconds + exitGraceSeconds) * 1.5,
	);
}

export type MacgenInvocation = { cmd: string; args: string[] };

/**
 * The ssh invocation for one off-box cell, or the local binary when `ssh` is
 * empty — the on-box control arm, which runs the same client argv against
 * loopback and is never an off-box result.
 */
export function macgenInvocation(options: {
	ssh: string;
	candidate: string;
	deadlineSeconds: number;
	localBin: string;
	clientArgs: string[];
	bin?: string;
	entry?: string;
}): MacgenInvocation {
	if (options.ssh === "")
		return { cmd: options.localBin, args: [...options.clientArgs] };
	return {
		cmd: "ssh",
		args: [
			"-o",
			"BatchMode=yes",
			options.ssh,
			options.entry ?? MACGEN_ENTRY,
			"--bin",
			assertMacgenBin(options.bin ?? G2_MACGEN_BIN),
			"--candidate",
			assertCandidate(options.candidate),
			"--deadline",
			String(options.deadlineSeconds),
			"--",
			...options.clientArgs,
		],
	};
}

/**
 * The provenance lines the entry script prints before the run. Folded into the
 * fragment so a cell says which tree its generator came from — the whole reason
 * the script exists, since the Mac builds its own binary and "which tree" stops
 * being obvious the moment it does.
 */
export function parseMacgenLine(line: string): Record<string, string> | null {
	const match = line.match(/^macgen: (.*)$/);
	if (!match?.[1]) return null;
	const fields: Record<string, string> = {};
	for (const token of match[1].split(/\s+/)) {
		const eq = token.indexOf("=");
		if (eq > 0) fields[token.slice(0, eq)] = token.slice(eq + 1);
	}
	return Object.keys(fields).length > 0 ? fields : null;
}

/**
 * The cable is the data path, and it is the only data path.
 *
 * `preflight-lib`'s rejection of `192.168.2.0/24` exists because a run that
 * silently measures the family Wi-Fi LAN instead of the cable looks exactly like
 * a run that measured the cable. The retired VM harness *required*
 * `192.168.2.x` — that address family is now precisely the failure it used to be
 * the marker of, so it is named in the refusal rather than folded into a
 * catch-all.
 */
export const CABLE_HOST_RE = /^10\.99\.0\.\d{1,3}$/;

export function assertCableHost(host: string, envName: string): string {
	if (host === "")
		throw new Error(`${envName} is required for an off-box cell`);
	if (/^192\.168\.2\./.test(host)) {
		throw new Error(
			`${envName}=${host} is the family LAN, not the cable — the retired ` +
				"loadgen VM's address family. The bare-metal data path is 10.99.0.0/24",
		);
	}
	if (!CABLE_HOST_RE.test(host)) {
		throw new Error(
			`${envName}=${host} is not a 10.99.0.0/24 cable address — the data ` +
				"path is never Tailscale, never Wi-Fi, and never a hostname",
		);
	}
	return host;
}
